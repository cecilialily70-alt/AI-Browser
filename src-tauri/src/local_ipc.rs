//! 本地 IPC 服务（Milestone 1 + 4）
//!
//! 仅监听 127.0.0.1（随机端口），供 Node Sidecar 通过 HTTP 上报
//! 轨迹 / 同站控件记忆 / Pause 阻塞等数据，由 Rust 单写队列统一落库或推前端。
//!
//! 端点：
//! - `GET  /health`   健康检查
//! - `POST /report`   上报（body 为单行 JSON，含 `type` 字段）
//!
//! 鉴权：所有端点要求 `X-Auth-Token`（或 `Authorization: Bearer`）与会话启动时
//! 生成的一次性共享令牌一致，否则返回 401；令牌经 `TIANSHUTAI_IPC_TOKEN` 下发给 Sidecar。

use std::net::SocketAddr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::db_write_queue::{DbWriteCommand, DbWriteQueue};
use crate::error::AppError;
use crate::{log_error, log_warn};

/// 轨迹落库成功事件名（与 rpa_session.rs 的 AGENT_TRAJECTORY_EVENT 保持一致）
const AGENT_TRAJECTORY_EVENT: &str = "agent-trajectory-saved";
/// P4.3：Agent Run History 落库事件
const AGENT_RUN_SAVED_EVENT: &str = "agent-run-saved";
/// Milestone 4：全局任务接管中心
const AGENT_TASK_BLOCKED_EVENT: &str = "agent-task-blocked";
const AGENT_HANDOVER_EVENT: &str = "agent-handover-required";

/// `/report` 请求体上限。
///
/// axum 默认 `DefaultBodyLimit` 只有 2MB，而一条长任务的轨迹（actions 里带 DOM 上下文）
/// 轻易就能超过它。超限会被 axum 直接以 413 拒绝，Node 侧只能回退到 stdout 旧链路
/// ——数据不丢，但主链路失效、payload 被重复序列化与解析，且没有任何提示。
/// 这里显式放宽：端点仅监听回环地址且强制令牌鉴权，放宽内存上限是安全且必要的。
const REPORT_BODY_LIMIT_BYTES: usize = 32 * 1024 * 1024;

/// /report 处理器持有的状态。
#[derive(Clone)]
struct ReportState {
    app: AppHandle,
    queue: Arc<DbWriteQueue>,
}

/// 鉴权中间件持有的状态：本进程会话的共享令牌。
#[derive(Clone)]
struct AuthState {
    token: Arc<str>,
}

/// 生成本次会话的 IPC 共享令牌（32 字节 CSPRNG，Base64url 无填充）。
pub(crate) fn generate_ipc_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 从 `X-Auth-Token` 或 `Authorization: Bearer` 提取调用方令牌。
pub(crate) fn extract_caller_token(headers: &HeaderMap) -> &str {
    if let Some(value) = headers.get("x-auth-token").and_then(|v| v.to_str().ok()) {
        return value.trim();
    }
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let trimmed = value.trim();
            trimmed
                .strip_prefix("Bearer ")
                .or_else(|| trimmed.strip_prefix("bearer "))
        })
        .map(str::trim)
        .unwrap_or("")
}

/// 定长字节流常量时间比较：避免按字符短路比较泄漏令牌前缀。
pub(crate) fn constant_time_eq(expected: &str, provided: &str) -> bool {
    let expected = expected.as_bytes();
    let provided = provided.as_bytes();
    if expected.is_empty() || expected.len() != provided.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(provided.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// 本地 IPC 统一鉴权：缺失或错误令牌一律 401，不区分「未提供」与「不匹配」。
async fn require_ipc_auth(
    State(auth): State<AuthState>,
    headers: HeaderMap,
    request: Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if !constant_time_eq(auth.token.as_ref(), extract_caller_token(&headers)) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    next.run(request).await
}

/// 本地 IPC 服务句柄：持有 base_url 与优雅停机所需的信号。
pub struct LocalIpcServer {
    pub base_url: String,
    /// 会话共享令牌：仅经进程环境变量注入到本机 Sidecar，不写日志、不出网。
    pub auth_token: String,
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    stopped_rx: Mutex<Option<mpsc::Receiver<()>>>,
}

impl LocalIpcServer {
    /// 优雅停机：通知 HTTP 服务停止接受新请求，等待在途请求处理完毕（带 5s 兜底）。
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.shutdown_tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        if let Ok(mut guard) = self.stopped_rx.lock() {
            if let Some(rx) = guard.take() {
                let _ = rx.recv_timeout(Duration::from_secs(5));
            }
        }
    }
}

/// 将本地 IPC 地址、profile 标识与会话令牌注入 sidecar 进程环境，
/// 使 Node 侧 ipc_client 能带鉴权直连 Rust 的 /report 端点。
pub fn apply_ipc_env(
    cmd: &mut std::process::Command,
    ipc_url: &str,
    profile_id: &str,
    auth_token: &str,
) {
    crate::app_env::set(cmd, crate::app_env::IPC_URL, ipc_url);
    crate::app_env::set(cmd, crate::app_env::PROFILE_ID, profile_id);
    crate::app_env::set(cmd, crate::app_env::IPC_TOKEN, auth_token);
}

/// 启动本地 IPC 服务（在 Tauri 异步运行时上跑 axum）。
///
/// 同步阶段仅用 `std::net` 绑定端口并取得 `base_url`；
/// `tokio::net::TcpListener::from_std` / `axum::serve` 必须在
/// `tauri::async_runtime` 内执行，否则 setup 同步上下文会 Panic
/// （there is no reactor running）。
pub fn start_local_ipc(
    app: AppHandle,
    queue: Arc<DbWriteQueue>,
) -> Result<LocalIpcServer, AppError> {
    // 绑定 127.0.0.1 随机端口（仅本机可访问，避免多开环境暴露到局域网）
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        AppError::State(format!("failed to bind local ipc listener: {error}"))
    })?;
    std_listener.set_nonblocking(true).map_err(|error| {
        AppError::State(format!("failed to set listener nonblocking: {error}"))
    })?;
    let addr: SocketAddr = std_listener.local_addr().map_err(|error| {
        AppError::State(format!("failed to read local ipc addr: {error}"))
    })?;

    let state = ReportState {
        app: app.clone(),
        queue,
    };
    let auth_token = generate_ipc_token();
    let auth_state = AuthState {
        token: Arc::from(auth_token.as_str()),
    };

    let router = Router::new()
        .route("/health", get(handle_health))
        .route("/report", post(handle_report))
        .layer(DefaultBodyLimit::max(REPORT_BODY_LIMIT_BYTES))
        .with_state(state)
        .layer(axum::middleware::from_fn_with_state(
            auth_state,
            require_ipc_auth,
        ));

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (stopped_tx, stopped_rx) = mpsc::channel::<()>();

    // 关键：from_std / serve 必须在 Tokio 1.x runtime 内，禁止在 setup 同步路径直接调用
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(error) => {
                log_error!("TianshuTai: local ipc tokio listener convert failed: {error}");
                let _ = stopped_tx.send(());
                return;
            }
        };

        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        // 优雅停机：等待在途请求处理完毕后退出
        if let Err(error) = server.await {
            log_error!("TianshuTai: local ipc server exited with error: {error}");
        }
        let _ = stopped_tx.send(());
    });

    Ok(LocalIpcServer {
        base_url: format!("http://{addr}"),
        auth_token,
        shutdown_tx: Mutex::new(Some(shutdown_tx)),
        stopped_rx: Mutex::new(Some(stopped_rx)),
    })
}

async fn handle_health() -> StatusCode {
    StatusCode::OK
}

async fn handle_report(State(state): State<ReportState>, body: String) -> impl IntoResponse {
    let value: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, format!("invalid json: {error}")).into_response();
        }
    };

    let report_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let profile_id = value
        .get("profileId")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();

    match report_type.as_str() {
        "agent_trajectory" => {
            let domain = field_str(&value, "domain").unwrap_or_default();
            let title = field_str(&value, "title").unwrap_or_else(|| "未命名轨迹".to_owned());
            let goal = field_str(&value, "goal").unwrap_or_default();
            let start_url = field_str(&value, "startUrl").unwrap_or_default();
            let run_id = field_str(&value, "runId").filter(|s| !s.is_empty());
            let actions = value
                .get("actions")
                .cloned()
                .unwrap_or(Value::Array(vec![]));
            let actions_json = actions.to_string();

            // 走单写队列，并同步等待落库 id（对齐旧 stdout 路径的行为）
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<Result<i64, String>>();
            let enqueue_result = state.queue.enqueue(DbWriteCommand::SaveAgentTrajectory {
                domain: domain.clone(),
                title: title.clone(),
                goal: goal.clone(),
                start_url: start_url.clone(),
                actions: actions_json,
                reply: Some(reply_tx),
                run_id,
            });

            let saved_id = match enqueue_result {
                Ok(()) => match reply_rx.await {
                    Ok(Ok(id)) => Some(id),
                    Ok(Err(error)) => {
                        log_error!("TianshuTai: ipc save agent trajectory failed: {error}");
                        None
                    }
                    Err(_) => None,
                },
                Err(error) => {
                    log_error!("TianshuTai: ipc enqueue trajectory failed: {error}");
                    None
                }
            };

            // 向前端推送轨迹已保存事件（对齐旧 stdout 路径行为）
            let _ = state.app.emit(
                AGENT_TRAJECTORY_EVENT,
                json!({
                    "profileId": profile_id,
                    "id": saved_id,
                    "domain": domain,
                    "title": title,
                    "goal": goal,
                    "startUrl": start_url,
                    "actions": actions,
                }),
            );

            StatusCode::OK.into_response()
        }
        "agent_run" => {
            let run_id = field_str(&value, "runId").unwrap_or_default();
            if run_id.trim().is_empty() {
                log_warn!("TianshuTai: ipc agent_run missing runId");
                return StatusCode::BAD_REQUEST.into_response();
            }
            let phase = field_str(&value, "phase").unwrap_or_default();
            let goal = field_str(&value, "goal").unwrap_or_default();
            let start_url = field_str(&value, "startUrl").unwrap_or_default();
            let domain = field_str(&value, "domain").unwrap_or_default();
            let status = field_str(&value, "status").unwrap_or_else(|| "running".to_owned());

            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<Result<i64, String>>();
            let enqueue_result = if phase == "agent_run_finish"
                || status == "complete"
                || status == "failed"
                || status == "aborted"
            {
                let success = value.get("success").and_then(Value::as_bool);
                let summary = field_str(&value, "summary").unwrap_or_default();
                let step_count = value
                    .get("stepCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let hitl_occurred = value
                    .get("hitlOccurred")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let trajectory_id = value.get("trajectoryId").and_then(Value::as_i64);
                let thought_summary = value
                    .get("thoughtSummary")
                    .cloned()
                    .unwrap_or(Value::Array(vec![]))
                    .to_string();
                let stats = crate::models::AgentRunFinishStats::from_event(&value);
                state.queue.enqueue(DbWriteCommand::FinishAgentRun {
                    run_id: run_id.clone(),
                    profile_id: profile_id.clone(),
                    goal: goal.clone(),
                    start_url: start_url.clone(),
                    domain: domain.clone(),
                    status: status.clone(),
                    success,
                    summary,
                    step_count,
                    hitl_occurred,
                    trajectory_id,
                    thought_summary,
                    stats,
                    reply: Some(reply_tx),
                })
            } else {
                state.queue.enqueue(DbWriteCommand::UpsertAgentRunStart {
                    run_id: run_id.clone(),
                    profile_id: profile_id.clone(),
                    goal: goal.clone(),
                    start_url: start_url.clone(),
                    domain: domain.clone(),
                    reply: Some(reply_tx),
                })
            };

            let saved_id = match enqueue_result {
                Ok(()) => match reply_rx.await {
                    Ok(Ok(id)) => Some(id),
                    Ok(Err(error)) => {
                        log_error!("TianshuTai: ipc save agent run failed: {error}");
                        None
                    }
                    Err(_) => None,
                },
                Err(error) => {
                    log_error!("TianshuTai: ipc enqueue agent run failed: {error}");
                    None
                }
            };

            let _ = state.app.emit(
                AGENT_RUN_SAVED_EVENT,
                json!({
                    "profileId": profile_id,
                    "id": saved_id,
                    "runId": run_id,
                    "status": status,
                    "goal": goal,
                    "domain": domain,
                    "phase": phase,
                }),
            );

            StatusCode::OK.into_response()
        }
        "agent_control_memory" => {
            let domain = field_str(&value, "domain").unwrap_or_default();
            let intent = field_str(&value, "intent").unwrap_or_default();
            let intent_key = field_str(&value, "intentKey").unwrap_or_default();
            let kind = field_str(&value, "kind").unwrap_or_else(|| "click".to_owned());
            let selector = field_str(&value, "selector").unwrap_or_default();
            let text_hint = field_str(&value, "textHint").unwrap_or_default();
            let x_percent = value.get("xPercent").and_then(Value::as_f64);
            let y_percent = value.get("yPercent").and_then(Value::as_f64);
            let hit_count = value.get("hitCount").and_then(Value::as_i64);

            if let Err(error) = state.queue.enqueue(DbWriteCommand::UpsertAgentControlMemory {
                domain,
                intent,
                intent_key,
                kind,
                selector,
                text_hint,
                x_percent,
                y_percent,
                hit_count,
            }) {
                log_error!("TianshuTai: ipc enqueue control memory failed: {error}");
            }
            StatusCode::OK.into_response()
        }
        "persona_data" => {
            // 环境人设已下线：用户人设改由「规则」窗口维护（Host global_settings）。
            // 这里显式拒绝写入，避免旧进程/外部上报把已废弃字段悄悄写回库。
            (
                StatusCode::GONE,
                "persona_data is retired; use the rules library instead".to_owned(),
            )
                .into_response()
        }
        "agent_task_blocked" => {
            // Milestone 4：Pause 上报 → 立即推前端 Intervention Center
            let request_id = field_str(&value, "requestId").unwrap_or_default();
            let url = field_str(&value, "url").unwrap_or_default();
            let reason = field_str(&value, "reason").unwrap_or_else(|| "需要人工接管".to_owned());
            let paused_at = field_str(&value, "pausedAt").unwrap_or_default();
            let payload = json!({
                "profileId": profile_id,
                "requestId": request_id,
                "url": url,
                "reason": reason,
                "pausedAt": paused_at,
                "ai_copy": value.get("ai_copy").cloned().unwrap_or(Value::Null),
                "screenshotBase64": value
                    .get("screenshotBase64")
                    .or_else(|| value.get("screenshot"))
                    .cloned()
                    .unwrap_or(Value::Null),
            });
            let _ = state.app.emit(AGENT_TASK_BLOCKED_EVENT, payload.clone());
            // 兼容：同步 handover 事件（P4.2 起仅 Intervention Center 消费 UI）
            let _ = state.app.emit(AGENT_HANDOVER_EVENT, payload);
            StatusCode::OK.into_response()
        }
        other => {
            log_warn!("TianshuTai: unknown ipc report type: {other}");
            (
                StatusCode::BAD_REQUEST,
                format!("unknown report type: {other}"),
            )
                .into_response()
        }
    }
}

fn field_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|entry| {
        entry
            .as_str()
            .map(str::to_owned)
            .or_else(|| entry.as_i64().map(|n| n.to_string()))
            .or_else(|| entry.as_u64().map(|n| n.to_string()))
    })
}
