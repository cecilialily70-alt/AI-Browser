use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::db;
use crate::db_write_queue::DbWriteCommand;
use crate::error::AppError;
use crate::{log_error, log_info, log_warn};
use crate::fill_sidecar::{load_rpa_runtime_bundle, resolve_profile_user_data_dir};
use crate::process_win::{
    kill_process_tree, prepare_sidecar_command, register_child_for_lifecycle,
    wait_child_with_deadline,
};
use crate::profile_id::parse_profile_id;
use crate::sidecar::emit_sidecar_line;
use crate::sidecar_paths::resolve_sidecar_dist;
use crate::AppState;

pub const RPA_STATE_EVENT: &str = "rpa-state";
pub const AGENT_CONFIRM_EVENT: &str = "agent-confirm-required";
pub const AGENT_ASK_EVENT: &str = "agent-ask-user";
pub const AGENT_HANDOVER_EVENT: &str = "agent-handover-required";
pub const AGENT_TASK_BLOCKED_EVENT: &str = "agent-task-blocked";
pub const AGENT_TASK_RESUMED_EVENT: &str = "agent-task-resumed";
pub const AGENT_STATE_EVENT: &str = "agent-state";
/// P4.4：Agent 运行中 Open Tabs 只读快照
pub const AGENT_OPEN_TABS_EVENT: &str = "agent-open-tabs";
pub const AGENT_TRAJECTORY_EVENT: &str = "agent-trajectory-saved";
pub const AGENT_RUN_SAVED_EVENT: &str = "agent-run-saved";
pub const SCRAPER_DATA_EVENT: &str = "scraper-data-collected";
/// Sidecar 终态等待上限，防止 UI 永久假死
const SIDECAR_RECV_TIMEOUT: Duration = Duration::from_secs(60);
/// Agent 循环可能较长（含人工确认），单独放宽
const AGENT_RECV_TIMEOUT: Duration = Duration::from_secs(600);
/// kill 之后收尸的宽限期：正常会立即返回，仅防 kill 失败时把调用方挂死
const SIDECAR_EXIT_GRACE: Duration = Duration::from_secs(5);

static WAIT_ID_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_wait_id() -> String {
    let seq = WAIT_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("w-{}-{seq}", std::process::id())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpaStatePayload {
    pub state: String,
    pub step: u32,
    pub msg: String,
    pub actions: Option<Value>,
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpaRunResult {
    pub state: String,
    pub step: u32,
    pub msg: String,
    pub actions: Option<Value>,
    /// 与 send_and_wait 注入的 waitId 对齐；缺省时仅 FIFO 唤醒一个 waiter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_id: Option<String>,
}

struct WaiterEntry {
    wait_id: String,
    tx: mpsc::Sender<RpaRunResult>,
}

struct RpaSessionInner {
    child: Mutex<Child>,
    stdin: Mutex<std::process::ChildStdin>,
    waiters: Mutex<Vec<WaiterEntry>>,
    url_waiters: Mutex<Vec<mpsc::Sender<String>>>,
    /// Milestone 4：Node Pause HTTP 端口（127.0.0.1），供 Resume 直连
    pause_http_port: Mutex<Option<u16>>,
}

pub struct RpaSessionManager {
    sessions: Arc<DashMap<String, Arc<RpaSessionInner>>>,
    /// 按 profile 互斥 ensure_session，防止并发双 spawn 孤儿进程
    ensure_locks: DashMap<String, Arc<AsyncMutex<()>>>,
}

impl Default for RpaSessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            ensure_locks: DashMap::new(),
        }
    }
}

fn parse_rpa_state_line(line: &str) -> Option<RpaRunResult> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("rpa_state") {
        return None;
    }

    let state = value
        .get("state")
        .and_then(|entry| entry.as_str())
        .unwrap_or("paused")
        .to_owned();
    let step = value
        .get("step")
        .and_then(|entry| entry.as_u64())
        .unwrap_or(0) as u32;
    let msg = value
        .get("msg")
        .and_then(|entry| entry.as_str())
        .unwrap_or("")
        .to_owned();
    let actions = value.get("actions").cloned();

    Some(RpaRunResult {
        state,
        step,
        msg,
        actions,
        wait_id: value
            .get("waitId")
            .or_else(|| value.get("wait_id"))
            .and_then(|entry| entry.as_str())
            .map(str::to_owned)
            .filter(|id| !id.is_empty()),
    })
}

fn parse_page_url_line(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("page_url") {
        return None;
    }
    value
        .get("url")
        .and_then(|entry| entry.as_str())
        .map(str::to_owned)
}

fn emit_rpa_state(app: &AppHandle, profile_id: &str, result: &RpaRunResult) {
    let payload = RpaStatePayload {
        state: result.state.clone(),
        step: result.step,
        msg: result.msg.clone(),
        actions: result.actions.clone(),
        profile_id: profile_id.to_owned(),
    };
    let _ = app.emit(RPA_STATE_EVENT, payload);
}

fn map_recv_timeout_error(error: RecvTimeoutError, context: &str) -> AppError {
    match error {
        RecvTimeoutError::Timeout => AppError::Sidecar(format!(
            "{context} timed out after {}s (no terminal state from sidecar)",
            SIDECAR_RECV_TIMEOUT.as_secs()
        )),
        RecvTimeoutError::Disconnected => {
            AppError::Sidecar(format!("{context} channel closed before terminal state"))
        }
    }
}

/// 按 waitId 精确唤醒；无 waitId 时 FIFO 只唤醒最老的一个（禁止扇出假完成）
fn notify_waiters(session: &RpaSessionInner, result: RpaRunResult) {
    let mut waiters = session
        .waiters
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if waiters.is_empty() {
        return;
    }

    if let Some(wait_id) = result
        .wait_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(index) = waiters.iter().position(|entry| entry.wait_id == wait_id) {
            let entry = waiters.remove(index);
            let _ = entry.tx.send(result);
            return;
        }
        log_warn!(
            "[rpa_session] waitId={wait_id} 无匹配 waiter（可能已超时移除），忽略终态"
        );
        return;
    }

    // 兼容旧 sidecar：无 waitId 时绝不 drain 全部，只唤醒队首
    let entry = waiters.remove(0);
    let _ = entry.tx.send(result);
}

/// 进程崩溃等：必须叫醒所有挂起方，避免 UI 永久挂死
fn notify_all_waiters(session: &RpaSessionInner, result: RpaRunResult) {
    let mut waiters = session
        .waiters
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for entry in waiters.drain(..) {
        let _ = entry.tx.send(result.clone());
    }
}

fn notify_url_waiters(session: &RpaSessionInner, url: String) {
    let mut waiters = session
        .url_waiters
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for waiter in waiters.drain(..) {
        let _ = waiter.send(url.clone());
    }
}

/// waiter 注册后即生效，Drop 时无条件摘除。
///
/// 正常终态由 `notify_waiters` 负责出队，此时本 guard 的摘除是幂等空操作；
/// 真正的价值在早退路径——写入失败、`spawn_blocking` JoinError 等——没有它，
/// waiter 会永久滞留，把该环境锁死为「引擎忙」。
struct WaiterGuard<'a> {
    manager: &'a RpaSessionManager,
    profile_id: &'a str,
    wait_id: &'a str,
}

impl Drop for WaiterGuard<'_> {
    fn drop(&mut self) {
        self.manager.drop_waiter(self.profile_id, self.wait_id);
    }
}

fn spawn_stdout_pump(
    app: AppHandle,
    profile_id: String,
    session: Arc<RpaSessionInner>,
    stdout: impl std::io::Read + Send + 'static,
    stderr: impl std::io::Read + Send + 'static,
) {
    let app_stdout = app.clone();
    let profile_for_stdout = profile_id.clone();
    let session_for_stdout = session.clone();
    std::thread::spawn(move || {
        let stdout_reader = BufReader::new(stdout);
        for line in stdout_reader.lines() {
            let line = match line {
                Ok(value) => value,
                Err(_) => break,
            };

            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("type").and_then(|entry| entry.as_str()) == Some("page_url") {
                    let url = value
                        .get("url")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let _ = app_stdout.emit(
                        "page-url-changed",
                        json!({
                            "profileId": profile_for_stdout,
                            "url": url,
                        }),
                    );
                    if let Some(url) = parse_page_url_line(&line) {
                        notify_url_waiters(&session_for_stdout, url);
                    }
                    continue;
                }
                if value.get("type").and_then(|entry| entry.as_str()) == Some("interactive_extract") {
                    let mut payload = value.clone();
                    if let Some(object) = payload.as_object_mut() {
                        object.insert("profileId".to_owned(), json!(profile_for_stdout));
                    }
                    let _ = app_stdout.emit("interactive-extract-updated", payload);
                    continue;
                }
            }

            emit_sidecar_line(&app_stdout, &line);

            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                let event_type = value.get("type").and_then(|entry| entry.as_str());
                if event_type == Some("agent_confirm_required") {
                    let _ = app_stdout.emit(
                        AGENT_CONFIRM_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "requestId": value.get("requestId"),
                            "url": value.get("url"),
                            "reason": value.get("reason"),
                            "actions": value.get("actions"),
                            "ai_copy": value.get("ai_copy"),
                            // P4.2：事件已带截图则透传给介入收件箱缩略图
                            "screenshotBase64": value
                                .get("screenshotBase64")
                                .or_else(|| value.get("screenshot"))
                                .cloned()
                                .unwrap_or(Value::Null),
                        }),
                    );
                    continue;
                }
                if event_type == Some("agent_ask_user") {
                    let _ = app_stdout.emit(
                        AGENT_ASK_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "requestId": value.get("requestId"),
                            "question": value.get("question"),
                            "url": value.get("url"),
                            "ai_copy": value.get("ai_copy"),
                            "screenshotBase64": value
                                .get("screenshotBase64")
                                .or_else(|| value.get("screenshot"))
                                .cloned()
                                .unwrap_or(Value::Null),
                        }),
                    );
                    continue;
                }
                if event_type == Some("pause_server") {
                    // Milestone 4：记录 Node Resume HTTP 端口
                    let port = value
                        .get("port")
                        .and_then(|entry| entry.as_u64())
                        .unwrap_or(0);
                    if port > 0 && port <= u64::from(u16::MAX) {
                        if let Ok(mut guard) = session_for_stdout.pause_http_port.lock() {
                            *guard = Some(port as u16);
                        }
                    }
                    continue;
                }
                if event_type == Some("agent_handover_required") {
                    let blocked = json!({
                        "profileId": profile_for_stdout,
                        "requestId": value.get("requestId"),
                        "url": value.get("url"),
                        "reason": value.get("reason"),
                        "ai_copy": value.get("ai_copy"),
                        "pausedAt": value.get("pausedAt").cloned().unwrap_or(Value::Null),
                        "screenshotBase64": value
                            .get("screenshotBase64")
                            .or_else(|| value.get("screenshot"))
                            .cloned()
                            .unwrap_or(Value::Null),
                    });
                    let _ = app_stdout.emit(AGENT_HANDOVER_EVENT, blocked.clone());
                    let _ = app_stdout.emit(AGENT_TASK_BLOCKED_EVENT, blocked);
                    continue;
                }
                if event_type == Some("browser_restart_request") {
                    if let Some(manager) = app_stdout.try_state::<crate::browser_manager::BrowserManager>()
                    {
                        if let Err(error) = manager.request_browser_restart(&profile_for_stdout) {
                            log_warn!(
                                "[rpa] browser restart request failed profile={profile_for_stdout}: {error}"
                            );
                        }
                    }
                    continue;
                }
                if event_type == Some("agent_host_request") {
                    /*
                     * Agent 请求宿主做事（新建/删除环境）。
                     *
                     * 为什么走这条回环：环境是宿主的资产（DB + 进程生命周期），Sidecar 无权直接改。
                     * 于是 Sidecar 只发「意图 + requestId」，真正落库由宿主复用既有 db 逻辑完成，
                     * 再把结果写回 Sidecar 的 stdin —— 权限边界不因为 Agent 而破口。
                     *
                     * 删除这类不可逆操作在 Sidecar 侧已经强制 HITL，这里再拒一次「删自己」，
                     * 避免误删正在跑任务的环境把会话连根拔掉。
                     */
                    let request_id = value
                        .get("requestId")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_owned();
                    let kind = value
                        .get("kind")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let payload = value.get("payload").cloned().unwrap_or_else(|| json!({}));
                    if request_id.is_empty() {
                        log_warn!("[rpa] agent_host_request missing requestId kind={kind}");
                        continue;
                    }
                    let response = handle_agent_host_request(
                        &app_stdout,
                        &profile_for_stdout,
                        &kind,
                        &payload,
                        &request_id,
                    );
                    let line = format!("{response}\n");
                    if let Ok(mut stdin) = session_for_stdout.stdin.lock() {
                        if let Err(error) = stdin.write_all(line.as_bytes()).and_then(|()| stdin.flush())
                        {
                            log_warn!("[rpa] agent_host_request reply failed: {error}");
                        }
                    } else {
                        log_warn!("[rpa] agent_host_request reply skipped: stdin lock poisoned");
                    }
                    continue;
                }
                if event_type == Some("open_tabs") {
                    // P4.4：控制台 Tab 感知（只读列表；切标签由 Agent switch）
                    let _ = app_stdout.emit(
                        AGENT_OPEN_TABS_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "tabs": value.get("tabs").cloned().unwrap_or_else(|| json!([])),
                            "step": value.get("step"),
                            "phase": value.get("phase"),
                        }),
                    );
                    continue;
                }
                if event_type == Some("agent_state") {
                    let _ = app_stdout.emit(
                        AGENT_STATE_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "state": value.get("state"),
                            "step": value.get("step"),
                            "msg": value.get("msg"),
                            "engine": value.get("engine"),
                            // 终态小结（交付物正文）：信息型任务的结论就在这里，转发给 UI 展示
                            "summary": value.get("summary"),
                        }),
                    );
                    let state = value
                        .get("state")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("");
                    if state == "complete" || state == "failed" {
                        let wait_id = value
                            .get("waitId")
                            .or_else(|| value.get("wait_id"))
                            .and_then(|entry| entry.as_str())
                            .map(str::to_owned)
                            .filter(|id| !id.is_empty());
                        notify_waiters(
                            &session_for_stdout,
                            RpaRunResult {
                                state: state.to_owned(),
                                step: value
                                    .get("step")
                                    .and_then(|entry| entry.as_u64())
                                    .unwrap_or(0) as u32,
                                msg: value
                                    .get("msg")
                                    .and_then(|entry| entry.as_str())
                                    .unwrap_or("")
                                    .to_owned(),
                                actions: None,
                                wait_id,
                            },
                        );
                    }
                    continue;
                }
                if event_type == Some("agent_trajectory") {
                    let domain = value
                        .get("domain")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let title = value
                        .get("title")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("未命名轨迹")
                        .to_owned();
                    let goal = value
                        .get("goal")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let start_url = value
                        .get("startUrl")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let run_id = value
                        .get("runId")
                        .and_then(|entry| entry.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                    let actions = value
                        .get("actions")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    let actions_json = actions.to_string();
                    let mut saved_id: Option<i64> = None;
                    if let Some(state) = app_stdout.try_state::<AppState>() {
                        // —— Milestone 1：改走单写队列（保留前端可同步拿到落库 id）——
                        let (reply_tx, reply_rx) =
                            tokio::sync::oneshot::channel::<Result<i64, String>>();
                        let enqueued = state.db_queue.enqueue(DbWriteCommand::SaveAgentTrajectory {
                            domain: domain.clone(),
                            title: title.clone(),
                            goal: goal.clone(),
                            start_url: start_url.clone(),
                            actions: actions_json.clone(),
                            reply: Some(reply_tx),
                            run_id,
                        });
                        if enqueued.is_ok() {
                            match reply_rx.blocking_recv() {
                                Ok(Ok(id)) => saved_id = Some(id),
                                Ok(Err(error)) => {
                                    log_error!("save agent trajectory failed: {error}");
                                }
                                Err(_) => {
                                    log_warn!("save agent trajectory reply channel closed");
                                }
                            }
                        }
                    }
                    let _ = app_stdout.emit(
                        AGENT_TRAJECTORY_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "id": saved_id,
                            "domain": domain,
                            "title": title,
                            "goal": goal,
                            "startUrl": start_url,
                            "actions": actions,
                        }),
                    );
                    continue;
                }
                if event_type == Some("agent_run") {
                    let run_id = value
                        .get("runId")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    if run_id.trim().is_empty() {
                        log_warn!("agent_run missing runId");
                        continue;
                    }
                    let phase = value
                        .get("phase")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let goal = value
                        .get("goal")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let start_url = value
                        .get("startUrl")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let domain = value
                        .get("domain")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let status = value
                        .get("status")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("running")
                        .to_owned();
                    let mut saved_id: Option<i64> = None;
                    if let Some(state) = app_stdout.try_state::<AppState>() {
                        let (reply_tx, reply_rx) =
                            tokio::sync::oneshot::channel::<Result<i64, String>>();
                        let enqueued = if phase == "agent_run_finish"
                            || status == "complete"
                            || status == "failed"
                            || status == "aborted"
                        {
                            let success = value.get("success").and_then(|entry| entry.as_bool());
                            let summary = value
                                .get("summary")
                                .and_then(|entry| entry.as_str())
                                .unwrap_or("")
                                .to_owned();
                            let step_count = value
                                .get("stepCount")
                                .and_then(|entry| entry.as_i64())
                                .unwrap_or(0);
                            let hitl_occurred = value
                                .get("hitlOccurred")
                                .and_then(|entry| entry.as_bool())
                                .unwrap_or(false);
                            let trajectory_id =
                                value.get("trajectoryId").and_then(|entry| entry.as_i64());
                            let thought_summary = value
                                .get("thoughtSummary")
                                .cloned()
                                .unwrap_or(Value::Array(vec![]))
                                .to_string();
                            let stats = crate::models::AgentRunFinishStats::from_event(&value);
                            state.db_queue.enqueue(DbWriteCommand::FinishAgentRun {
                                run_id: run_id.clone(),
                                profile_id: profile_for_stdout.clone(),
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
                            state.db_queue.enqueue(DbWriteCommand::UpsertAgentRunStart {
                                run_id: run_id.clone(),
                                profile_id: profile_for_stdout.clone(),
                                goal: goal.clone(),
                                start_url: start_url.clone(),
                                domain: domain.clone(),
                                reply: Some(reply_tx),
                            })
                        };
                        if enqueued.is_ok() {
                            match reply_rx.blocking_recv() {
                                Ok(Ok(id)) => saved_id = Some(id),
                                Ok(Err(error)) => {
                                    log_error!("save agent run failed: {error}");
                                }
                                Err(_) => {
                                    log_warn!("save agent run reply channel closed");
                                }
                            }
                        }
                    }
                    let _ = app_stdout.emit(
                        AGENT_RUN_SAVED_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "id": saved_id,
                            "runId": run_id,
                            "status": status,
                            "goal": goal,
                            "domain": domain,
                            "phase": phase,
                        }),
                    );
                    continue;
                }
                if event_type == Some("agent_control_memory") {
                    let domain = value
                        .get("domain")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let intent = value
                        .get("intent")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let intent_key = value
                        .get("intentKey")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let kind = value
                        .get("kind")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("click")
                        .to_owned();
                    let selector = value
                        .get("selector")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let text_hint = value
                        .get("textHint")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let x_percent = value.get("xPercent").and_then(|entry| entry.as_f64());
                    let y_percent = value.get("yPercent").and_then(|entry| entry.as_f64());
                    let hit_count = value.get("hitCount").and_then(|entry| entry.as_i64());
                    if let Some(state) = app_stdout.try_state::<AppState>() {
                        // —— Milestone 1：改走单写队列（fire-and-forget）——
                        if let Err(error) = state.db_queue.enqueue(DbWriteCommand::UpsertAgentControlMemory {
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
                            log_error!("upsert agent control memory enqueue failed: {error}");
                        }
                    }
                    continue;
                }
                if event_type == Some("persona_data") {
                    // 环境人设已下线：用户人设改由「规则」窗口维护。
                    // 这里不再落库，避免旧进程把已废弃字段悄悄写回 profiles.persona_data。
                    log_warn!(
                        "TianshuTai: persona_data 上报已废弃，忽略（请改用「规则」窗口维护人设）"
                    );
                    continue;
                }
                if event_type == Some("scraper_data_collected") {
                    let data = value
                        .get("data")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    let _ = app_stdout.emit(
                        SCRAPER_DATA_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "data": data,
                            "mode": value.get("mode"),
                            "url": value.get("url"),
                            "count": value.get("count"),
                            "reason": value.get("reason"),
                            "append": value.get("append").and_then(|v| v.as_bool()).unwrap_or(false),
                            "localPath": value.get("localPath"),
                        }),
                    );
                    continue;
                }
                if event_type == Some("interactive_extract") {
                    let mut payload = value.clone();
                    if let Some(object) = payload.as_object_mut() {
                        object.insert("profileId".to_owned(), json!(profile_for_stdout));
                    }
                    let _ = app_stdout.emit("interactive-extract-updated", payload);
                    continue;
                }
            }

            if let Some(result) = parse_rpa_state_line(&line) {
                emit_rpa_state(&app_stdout, &profile_for_stdout, &result);
                if result.state == "paused" || result.state == "complete" {
                    notify_waiters(&session_for_stdout, result);
                }
            }

            if let Some(url) = parse_page_url_line(&line) {
                notify_url_waiters(&session_for_stdout, url);
            }
        }
    });

    let app_stderr = app;
    std::thread::spawn(move || {
        let stderr_reader = BufReader::new(stderr);
        for line in stderr_reader.lines().flatten() {
            emit_sidecar_line(
                &app_stderr,
                &serde_json::json!({
                    "kind": "error",
                    "level": "error",
                    "message": "sidecar_stderr",
                    "data": { "line": line }
                })
                .to_string(),
            );
        }
    });
}

/// Phase 1：Sidecar 退出守望 — 从 sessions 移除并推送终态，消除 UI 幽灵「运行中」。
/// 区分两种退出：退出码 0（用户手动关闭浏览器）属正常结束，推送 aborted 而非 failed，
/// 避免「意外退出」红字误导；非 0 / 状态未知才视为异常退出。
fn spawn_rpa_exit_watcher(
    sessions: Arc<DashMap<String, Arc<RpaSessionInner>>>,
    app: AppHandle,
    profile_id: String,
) {
    enum Poll {
        /// 已被 stop_session 主动移除
        SessionGone,
        /// 仍在运行
        Running,
        /// 已退出；Some(status) 为可确认的退出状态，None 表示退出但状态未知
        Exited(Option<std::process::ExitStatus>),
    }

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));

            let poll = if let Some(session) = sessions.get(&profile_id) {
                match session.child.lock() {
                    Ok(mut child) => match child.try_wait() {
                        Ok(Some(status)) => Poll::Exited(Some(status)),
                        Ok(None) => Poll::Running,
                        Err(_) => Poll::Exited(None),
                    },
                    Err(_) => Poll::Exited(None),
                }
            } else {
                Poll::SessionGone
            };

            match poll {
                Poll::SessionGone => break,
                Poll::Running => continue,
                Poll::Exited(status) => {
                    if let Some((_, session)) = sessions.remove(&profile_id) {
                        // 用户关闭浏览器时 sidecar 以退出码 0 正常收尾，属「浏览器关闭」而非异常。
                        let benign = status.map(|s| s.success()).unwrap_or(false);
                        let state = if benign { "aborted" } else { "failed" };
                        let msg = if benign {
                            "浏览器已关闭".to_owned()
                        } else {
                            "Sidecar 进程异常退出，会话已清理".to_owned()
                        };
                        let result = RpaRunResult {
                            state: state.to_owned(),
                            step: 0,
                            msg: msg.clone(),
                            actions: None,
                            wait_id: None,
                        };
                        notify_all_waiters(&session, result.clone());
                        emit_rpa_state(&app, &profile_id, &result);
                        let _ = app.emit(
                            AGENT_STATE_EVENT,
                            json!({
                                "profileId": profile_id,
                                "state": state,
                                "step": 0,
                                "msg": msg,
                            }),
                        );
                        log_info!(
                            "[rpa_session] exit watcher cleaned session profile={profile_id} benign={benign}"
                        );
                    }
                    break;
                }
            }
        }
    });
}

impl RpaSessionManager {
    pub fn has_session(&self, profile_id: &str) -> bool {
        self.sessions.contains_key(profile_id)
    }

    /// Host 级忙碌：存在挂起的 send_and_wait waiter（Agent/RPA/轨迹回放）
    pub fn is_engine_busy(&self, profile_id: &str) -> bool {
        let Some(session) = self.sessions.get(profile_id) else {
            return false;
        };
        session
            .waiters
            .lock()
            .map(|guard| !guard.is_empty())
            .unwrap_or(true)
    }

    pub async fn ensure_session(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: &str,
    ) -> Result<(), AppError> {
        if self.sessions.contains_key(profile_id) {
            return Ok(());
        }

        let lock = self
            .ensure_locks
            .entry(profile_id.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _guard = lock.lock().await;

        // 双检：拿到锁后再看是否已被其它任务 spawn
        if self.sessions.contains_key(profile_id) {
            return Ok(());
        }

        let bundle = load_rpa_runtime_bundle(db_state, profile_id, "{}", false, None).await?;
        let sidecar_entry = resolve_sidecar_dist("index.js")?;

        let mut command = Command::new("node");
        command
            .arg(&sidecar_entry)
            .arg("--cdp-url")
            .arg(&bundle.cdp_url)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare_sidecar_command(&mut command);
        // —— Milestone 1：注入本地 IPC 地址，Sidecar 走 HTTP /report 上报 ——
        if let Some(state) = app.try_state::<AppState>() {
            crate::local_ipc::apply_ipc_env(
                &mut command,
                &state.local_ipc.base_url,
                profile_id,
                &state.local_ipc.auth_token,
            );
            // 下载根目录：Sidecar 通过 connectOverCDP 会接管整浏览器的下载行为，
            // 必须在进程启动时就拿到用户配置的目录，才能把手动下载保存到正确位置。
            if let Ok(connection) = state.database.lock() {
                if let Ok(roots) = crate::storage_paths::download_roots_json(app, &connection) {
                    if let Some(browser) = roots.get("browserDownloadDir").and_then(|v| v.as_str()) {
                        crate::app_env::set(
                            &mut command,
                            crate::app_env::BROWSER_DOWNLOAD_DIR,
                            browser,
                        );
                    }
                    if let Some(scraper) = roots.get("scraperDownloadDir").and_then(|v| v.as_str()) {
                        crate::app_env::set(
                            &mut command,
                            crate::app_env::SCRAPER_DOWNLOAD_DIR,
                            scraper,
                        );
                    }
                }
            }
        }
        let mut child = command
            .spawn()
            .map_err(|error| AppError::Sidecar(format!("failed to spawn rpa sidecar: {error}")))?;
        // Job Object / 进程组：Tauri 强杀时级联回收 Node Sidecar
        if let Err(error) = register_child_for_lifecycle(&child) {
            log_warn!("[rpa_session] register_child_for_lifecycle skipped: {error}");
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Sidecar("rpa sidecar stdout unavailable".to_owned()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Sidecar("rpa sidecar stderr unavailable".to_owned()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Sidecar("rpa sidecar stdin unavailable".to_owned()))?;

        let session = Arc::new(RpaSessionInner {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            waiters: Mutex::new(Vec::new()),
            url_waiters: Mutex::new(Vec::new()),
            pause_http_port: Mutex::new(None),
        });

        spawn_stdout_pump(
            app.clone(),
            profile_id.to_owned(),
            session.clone(),
            stdout,
            stderr,
        );

        self.sessions
            .insert(profile_id.to_owned(), session);

        spawn_rpa_exit_watcher(self.sessions.clone(), app.clone(), profile_id.to_owned());

        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok(())
    }

    fn write_command(&self, profile_id: &str, command: Value) -> Result<(), AppError> {
        let session = self
            .sessions
            .get(profile_id)
            .ok_or_else(|| AppError::Validation(format!("no rpa session for profile {profile_id}")))?;

        let line = format!("{command}\n");
        let mut stdin = session
            .stdin
            .lock()
            .map_err(|_| AppError::State("rpa stdin lock poisoned".to_owned()))?;
        stdin
            .write_all(line.as_bytes())
            .map_err(|error| AppError::Sidecar(format!("failed to write rpa command: {error}")))?;
        stdin
            .flush()
            .map_err(|error| AppError::Sidecar(format!("failed to flush rpa command: {error}")))?;
        Ok(())
    }

    pub async fn send_and_wait(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: &str,
        command: Value,
        wait_for_terminal: bool,
    ) -> Result<Option<RpaRunResult>, AppError> {
        self.send_and_wait_with_timeout(
            app,
            db_state,
            profile_id,
            command,
            wait_for_terminal,
            SIDECAR_RECV_TIMEOUT,
        )
        .await
    }

    pub async fn send_and_wait_with_timeout(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: &str,
        mut command: Value,
        wait_for_terminal: bool,
        timeout: Duration,
    ) -> Result<Option<RpaRunResult>, AppError> {
        self.ensure_session(app, db_state, profile_id).await?;

        let wait_id = next_wait_id();
        if let Some(object) = command.as_object_mut() {
            object.insert("waitId".to_owned(), json!(wait_id.clone()));
        }

        let (tx, rx) = mpsc::channel();
        let mut waiter_guard: Option<WaiterGuard<'_>> = None;
        if wait_for_terminal {
            let session = self
                .sessions
                .get(profile_id)
                .ok_or_else(|| {
                    AppError::Validation(format!("no rpa session for profile {profile_id}"))
                })?;
            session
                .waiters
                .lock()
                .map_err(|_| AppError::State("rpa waiters lock poisoned".to_owned()))?
                .push(WaiterEntry {
                    wait_id: wait_id.clone(),
                    tx,
                });
            // 注册即交给 guard 看管：此后任何早退（写入失败 / JoinError）都会摘除，
            // 不会留下把该环境永久判为「引擎忙」的幽灵 waiter
            waiter_guard = Some(WaiterGuard {
                manager: self,
                profile_id,
                wait_id: &wait_id,
            });
        }

        self.write_command(profile_id, command)?;

        if !wait_for_terminal {
            return Ok(None);
        }

        let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
            .await
            .map_err(|error| AppError::Sidecar(error.to_string()))?
            .map_err(|error| map_recv_timeout_error(error, "rpa/agent send_and_wait"))?;

        // 终态已到或已超时，waiter 使命结束：提前摘除以恢复「引擎空闲」判据
        drop(waiter_guard.take());

        Ok(Some(result))
    }

    pub fn write_session_command(&self, profile_id: &str, command: Value) -> Result<(), AppError> {
        self.write_command(profile_id, command)
    }

    /// 从 waiter 队列中摘除指定 waitId（幂等）。
    ///
    /// waiter 是「引擎忙」的唯一判据（见 [`Self::is_engine_busy`]），因此注册之后
    /// 任何早退路径都必须确保它被摘除，否则该环境会被**永久**判定为忙，
    /// 之后所有 Agent / RPA / 轨迹回放都会被拒，且 UI 无任何手段自行恢复。
    fn drop_waiter(&self, profile_id: &str, wait_id: &str) {
        let Some(session) = self.sessions.get(profile_id) else {
            return;
        };
        let mut waiters = session
            .waiters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        waiters.retain(|entry| entry.wait_id != wait_id);
    }

    pub fn set_pause_http_port(&self, profile_id: &str, port: u16) -> Result<(), AppError> {
        let session = self
            .sessions
            .get(profile_id)
            .ok_or_else(|| AppError::Validation(format!("no rpa session for profile {profile_id}")))?;
        let mut guard = session
            .pause_http_port
            .lock()
            .map_err(|_| AppError::State("rpa pause_http_port lock poisoned".to_owned()))?;
        *guard = if port > 0 { Some(port) } else { None };
        Ok(())
    }

    pub fn get_pause_http_port(&self, profile_id: &str) -> Option<u16> {
        let session = self.sessions.get(profile_id)?;
        session
            .pause_http_port
            .lock()
            .ok()
            .and_then(|guard| *guard)
    }

    pub fn stop_session(&self, profile_id: &str) -> Result<(), AppError> {
        if let Some((_, session)) = self.sessions.remove(profile_id) {
            // 先发 abort，再强制 kill，杜绝僵尸 Node 进程
            let _ = session.stdin.lock().map(|mut stdin| {
                let _ = stdin.write_all(b"{\"command\":\"agent_abort\"}\n");
                let _ = stdin.write_all(b"{\"command\":\"abort\"}\n");
                let _ = stdin.flush();
            });
            if let Ok(mut child) = session.child.lock() {
                let pid = child.id();
                let _ = child.kill();
                // 有上限收尸：kill 失败时无上限 wait 会把调用方永久挂住
                let _ = wait_child_with_deadline(&mut child, SIDECAR_EXIT_GRACE);
                // Windows：若子进程树残留，复用统一 kill 工具（含 CREATE_NO_WINDOW，杜绝黑框）
                #[cfg(windows)]
                if pid > 0 {
                    let _ = kill_process_tree(pid);
                }
                log_info!("[rpa_session] killed sidecar for profile={profile_id} pid={pid}");
            }
            // 必须在移除会话后唤醒所有挂起方：否则正在 send_and_wait 的 Agent/RPA/回放
            // 只能干等自身超时（Agent 长达 600s），UI 会长时间停在「执行中」；
            // 而此时 is_engine_busy 已因会话消失返回 false，用户甚至能再起一轮，
            // 两轮结果互相覆盖。这里主动结算，让在途命令立刻以 aborted 返回。
            notify_all_waiters(
                &session,
                RpaRunResult {
                    state: "aborted".to_owned(),
                    step: 0,
                    msg: "会话已停止".to_owned(),
                    actions: None,
                    wait_id: None,
                },
            );
        }
        Ok(())
    }

    pub fn stop_all_sessions(&self) {
        let keys: Vec<String> = self.sessions.iter().map(|entry| entry.key().clone()).collect();
        for profile_id in keys {
            let _ = self.stop_session(&profile_id);
        }
    }

    pub async fn fetch_page_url(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: &str,
    ) -> Result<String, AppError> {
        self.ensure_session(app, db_state, profile_id).await?;

        let (tx, rx) = mpsc::channel();
        {
            let session = self
                .sessions
                .get(profile_id)
                .ok_or_else(|| {
                    AppError::Validation(format!("no rpa session for profile {profile_id}"))
                })?;
            session
                .url_waiters
                .lock()
                .map_err(|_| AppError::State("rpa url waiters lock poisoned".to_owned()))?
                .push(tx);
        }

        self.write_command(
            profile_id,
            json!({
                "command": "get_url",
            }),
        )?;

        let url = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(SIDECAR_RECV_TIMEOUT)
        })
        .await
        .map_err(|error| AppError::Sidecar(error.to_string()))?
        .map_err(|error| map_recv_timeout_error(error, "fetch_page_url"))?;

        Ok(url)
    }
}

async fn build_rpa_start_command(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: &str,
    raw_input: &str,
    actions: Option<Value>,
    confirmed_profile: Option<String>,
    skip_hybrid: bool,
    press_enter_after_fill: bool,
    continuous: bool,
) -> Result<Value, AppError> {
    let has_actions = actions
        .as_ref()
        .and_then(|value| value.as_array())
        .is_some_and(|entries| !entries.is_empty());
    let require_ai = !skip_hybrid && !has_actions;
    let user_data_dir = resolve_profile_user_data_dir(app, profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let bundle = load_rpa_runtime_bundle(db_state, profile_id, raw_input, require_ai, user_data_dir).await?;

    let mut command = json!({
        "command": "rpa_start",
        "profile": bundle.profile_payload,
        "rawInput": bundle.raw_input,
        "skipHybrid": skip_hybrid,
        "pressEnterAfterFill": press_enter_after_fill,
        "continuous": continuous,
        "proxyAuth": bundle.proxy_auth,
    });

    if let Some(dir) = &bundle.user_data_dir {
        command["userDataDir"] = json!(dir);
    }

    if let Some(ai_settings) = bundle.ai_settings {
        command["ai"] = ai_settings;
    }

    if let Some(actions_value) = actions {
        command["actions"] = actions_value;
    }

    if let Some(confirmed) = confirmed_profile {
        let trimmed = confirmed.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation(
                "confirmed fill profile cannot be empty".to_owned(),
            ));
        }
        let parsed: Value = serde_json::from_str(trimmed).map_err(|error| {
            AppError::Validation(format!("confirmed profile is not valid JSON: {error}"))
        })?;
        if !parsed.is_object() {
            return Err(AppError::Validation(
                "confirmed profile JSON must be an object".to_owned(),
            ));
        }
        command["confirmedProfile"] = parsed;
    }

    Ok(command)
}

#[tauri::command]
pub async fn start_rpa_session(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager.ensure_session(&app, &db_state, &profile_id).await
}

#[tauri::command]
pub async fn stop_rpa_session(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager.stop_session(&profile_id)
}

#[tauri::command]
pub async fn run_rpa_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    raw_input: String,
    actions: Option<Value>,
    confirmed_profile: Option<String>,
    skip_hybrid: Option<bool>,
    press_enter_after_fill: Option<bool>,
    continuous: Option<bool>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let command = build_rpa_start_command(
        &app,
        &db_state,
        &profile_id,
        &raw_input,
        actions,
        confirmed_profile,
        skip_hybrid.unwrap_or(false),
        press_enter_after_fill.unwrap_or(false),
        continuous.unwrap_or(false),
    )
    .await?;

    let result = manager
        .send_and_wait(&app, &db_state, &profile_id, command, true)
        .await?
        .ok_or_else(|| AppError::Sidecar("rpa fill finished without state".to_owned()))?;

    Ok(result)
}

#[tauri::command]
pub async fn resume_rpa_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let result = manager
        .send_and_wait(
            &app,
            &db_state,
            &profile_id,
            json!({ "command": "rpa_resume" }),
            true,
        )
        .await?
        .ok_or_else(|| AppError::Sidecar("rpa resume finished without state".to_owned()))?;
    Ok(result)
}

#[tauri::command]
pub async fn rescan_rpa_page(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    raw_input: Option<String>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let input = raw_input.unwrap_or_else(|| "{}".to_owned());
    let user_data_dir = resolve_profile_user_data_dir(&app, &profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let bundle = load_rpa_runtime_bundle(&db_state, &profile_id, &input, false, user_data_dir).await?;
    let result = manager
        .send_and_wait(
            &app,
            &db_state,
            &profile_id,
            json!({
                "command": "rpa_rescan",
                "profile": bundle.profile_payload,
                "rawInput": bundle.raw_input,
                "userDataDir": bundle.user_data_dir,
            }),
            true,
        )
        .await?
        .ok_or_else(|| AppError::Sidecar("rpa rescan finished without state".to_owned()))?;
    Ok(result)
}

#[tauri::command]
pub async fn pause_rpa_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager
        .send_and_wait(
            &app,
            &db_state,
            &profile_id,
            json!({ "command": "rpa_pause" }),
            false,
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn get_profile_page_url(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<String, AppError> {
    parse_profile_id(&profile_id)?;
    manager
        .fetch_page_url(&app, &db_state, &profile_id)
        .await
}

/// `agent_start` 的下发口径：**只在非空数组时**写入字段。
///
/// 空数组等于「用户这次没有 `@引用` 任何规则 / 没有附件」—— 明文传空数组会让下游
/// 多出一层「有规则但都是空的」的歧义；干脆不下发，Sidecar 侧按「无规则」处理。
fn attach_non_empty_array(command: &mut Value, key: &str, value: Option<Value>) {
    if let Some(items) = value {
        if items.as_array().is_some_and(|entries| !entries.is_empty()) {
            command[key] = items;
        }
    }
}

#[tauri::command]
pub async fn start_autonomous_agent(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    goal: String,
    max_rounds: Option<u32>,
    sense_mode: Option<String>,
    enable_recording: Option<bool>,
    attachments: Option<Value>,
    task_rules: Option<Value>,
    task_persona: Option<Value>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let trimmed = goal.trim();
    let has_attachments = attachments
        .as_ref()
        .and_then(|value| value.as_array())
        .is_some_and(|entries| !entries.is_empty());
    if trimmed.is_empty() && !has_attachments {
        return Err(AppError::Validation("agent goal cannot be empty".to_owned()));
    }

    // Free Key + 151-pro pin: fingerprint only — block Agent
    {
        let entitlement = crate::key_file::resolve_license_entitlement(&db_state).await?;
        let browser_version = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let numeric_id = parse_profile_id(&profile_id)?;
            db::get_profile(&connection, numeric_id)?.browser_version
        };
        crate::kernel_policy::assert_ai_allowed_for_browser_version(
            entitlement.is_pro,
            &browser_version,
        )?;
    }

    // 默认关闭：录制须显式开启，避免一次性任务污染轨迹库
    let enable_recording = enable_recording.unwrap_or(false);

    let bundle = load_rpa_runtime_bundle(&db_state, &profile_id, "{}", true, None).await?;
    let ai = bundle.ai_settings.ok_or_else(|| {
        AppError::Validation("AI API key is not configured in global settings".to_owned())
    })?;

    // 感知模式固定均衡：兼容旧调用方仍传 sense_mode，运行时一律忽略
    let _ = sense_mode;
    let mode = "balanced";

    // 开局注入同站控件记忆（脱敏 selector + 意图），供 sidecar LRU hydrate。
    // 自动填表不读环境人设（每次现生成）；本环境启用的人设由「规则」窗口维护，
    // Agent / 回放统一经 db::resolve_agent_persona_for_profile 读取（profiles.persona_data 已下线）。
    let (control_memory, numeric_id, panorama_enabled) = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let numeric_id = parse_profile_id(&profile_id)?;
        let control_memory = db::list_agent_control_memory(&connection, "").unwrap_or_default();
        // 宪法 §1.7：Agent 全景截图默认恒开（环境列表已无开关）
        let panorama_enabled = true;
        (control_memory, numeric_id, panorama_enabled)
    };
    let control_memory_json: Vec<Value> = control_memory
        .into_iter()
        .map(|row| {
            json!({
                "domain": row.domain,
                "intent": row.intent,
                "intentKey": row.intent_key,
                "kind": row.kind,
                "selector": row.selector,
                "textHint": row.text_hint,
                "xPercent": row.x_percent,
                "yPercent": row.y_percent,
                "hitCount": row.hit_count,
                "updatedAt": row.updated_at,
            })
        })
        .collect();

    // Milestone 3：解析代理 GeoIP（Country/Region/City），强绑定造境上下文
    let geo_context = {
        let proxy_input = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            crate::proxy::proxy_resolution_input_from_profile(&connection, &profile)?
        };
        match proxy_input {
            Some(input) => {
                match crate::proxy::resolve_profile_proxy_input(input).await {
                    Ok(resolved) => match crate::ip_geo::resolve_proxy_egress_env(&resolved).await {
                        Ok(env) => Some(json!({
                            "exitIp": env.exit_ip,
                            "country": env.country,
                            "countryCode": env.country_code,
                            "region": env.region,
                            "city": env.city,
                            "timezone": env.timezone,
                            "locale": env.locale,
                            "latitude": env.latitude,
                            "longitude": env.longitude,
                        })),
                        Err(error) => {
                            log_warn!("TianshuTai: agent geo resolve failed: {error}");
                            None
                        }
                    },
                    Err(error) => {
                        log_warn!("TianshuTai: agent proxy resolve failed: {error}");
                        None
                    }
                }
            }
            None => match crate::ip_geo::lookup_direct_env_sync().await {
                Ok(env) => Some(json!({
                    "exitIp": env.exit_ip,
                    "country": env.country,
                    "countryCode": env.country_code,
                    "region": env.region,
                    "city": env.city,
                    "timezone": env.timezone,
                    "locale": env.locale,
                    "latitude": env.latitude,
                    "longitude": env.longitude,
                })),
                Err(error) => {
                    log_warn!("TianshuTai: agent direct geo skipped: {error}");
                    None
                }
            },
        }
    };

    let mut command = json!({
        "command": "agent_start",
        "goal": trimmed,
        "maxRounds": max_rounds.unwrap_or(200),
        "senseMode": mode,
        "ai": ai,
        "profileId": profile_id,
        "controlMemory": control_memory_json,
        "enableRecording": enable_recording,
        "panoramaEnabled": panorama_enabled,
    });
    if let Ok(dir) = crate::fill_sidecar::resolve_profile_user_data_dir(&app, &profile_id) {
        command["userDataDir"] = json!(dir.to_string_lossy());
    }
    if let Some(geo) = geo_context {
        command["geoContext"] = geo;
    }
    // 用户自定义规则 / 人设 / 附件：由前端「规则」窗口与 Agent 输入框提供
    attach_non_empty_array(&mut command, "taskRules", task_rules);
    if let Some(persona) = task_persona {
        if persona.is_object() {
            command["taskPersona"] = persona;
        }
    }
    attach_non_empty_array(&mut command, "attachments", attachments);
    if let Some(proxy) = bundle.proxy_auth {
        command["proxyAuth"] = serde_json::to_value(&proxy).map_err(|error| {
            AppError::Validation(format!("failed to serialize proxyAuth: {error}"))
        })?;
    }
    {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        if let Ok(roots) = crate::storage_paths::download_roots_json(&app, &connection) {
            command["storage"] = roots;
        }
        // P1.2：注入邮箱 OTP 通道绑定 + 会话内密钥明文（仅内存；Sidecar 不得落盘）
        if let Ok(channel_json) = crate::db::resolve_otp_channel_json(&connection, Some(numeric_id)) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&channel_json) {
                command["otpChannel"] = parsed.clone();
                if let Some(secrets) = crate::db::reveal_otp_channel_secrets(&connection, &parsed) {
                    let has_secrets = secrets
                        .as_object()
                        .map(|obj| !obj.is_empty())
                        .unwrap_or(false);
                    if has_secrets {
                        command["otpSecrets"] = secrets;
                    }
                }
            }
        }
        // P5.1：第三方 captcha_service + 会话密钥（同 OTP 模式；未启用则不注入）
        if let Ok(captcha_json) = crate::db::resolve_captcha_service_json(&connection) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&captcha_json) {
                command["captchaService"] = parsed.clone();
                if let Some(secrets) =
                    crate::db::reveal_captcha_service_secrets(&connection, &parsed)
                {
                    let has_secrets = secrets
                        .as_object()
                        .map(|obj| !obj.is_empty())
                        .unwrap_or(false);
                    if has_secrets {
                        command["captchaSecrets"] = secrets;
                    }
                }
            }
        }
        // P5.3：短信接码平台（默认关；仅 enabled=true 时注入密钥）
        if let Ok(sms_json) = crate::db::resolve_sms_otp_service_json(&connection) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&sms_json) {
                command["smsOtpService"] = parsed.clone();
                if let Some(secrets) =
                    crate::db::reveal_sms_otp_service_secrets(&connection, &parsed)
                {
                    let has_secrets = secrets
                        .as_object()
                        .map(|obj| !obj.is_empty())
                        .unwrap_or(false);
                    if has_secrets {
                        command["smsOtpSecrets"] = secrets;
                    }
                }
            }
        }
    }

    let result = manager
        .send_and_wait_with_timeout(
            &app,
            &db_state,
            &profile_id,
            command,
            true,
            AGENT_RECV_TIMEOUT,
        )
        .await?
        .ok_or_else(|| AppError::Sidecar("agent finished without terminal state".to_owned()))?;

    Ok(result)
}

/**
 * Agent 的宿主请求（Sidecar → 宿主回环）。
 *
 * 目前支持：
 * - `create_environment`：新建一个环境（复用 `db::create_profile`），返回新环境 id；
 * - `delete_environment`：删除一个环境（复用 `db::delete_profile`）；Sidecar 侧已强制人工确认。
 *
 * 一律返回 `{ command: "agent_host_response", requestId, ok, data|error }`，
 * 由调用方写回 Sidecar 的 stdin。**未知 kind 一律失败**，不做「尽力而为」的猜测。
 */
fn handle_agent_host_request(
    app: &AppHandle,
    current_profile_id: &str,
    kind: &str,
    payload: &Value,
    request_id: &str,
) -> Value {
    let fail = |message: String| {
        json!({
            "command": "agent_host_response",
            "requestId": request_id,
            "ok": false,
            "error": message,
        })
    };
    let Some(state) = app.try_state::<AppState>() else {
        return fail("宿主数据库不可用".to_owned());
    };
    let connection = match state.database.lock() {
        Ok(connection) => connection,
        Err(_) => return fail("数据库锁不可用".to_owned()),
    };

    match kind {
        "create_environment" => {
            let requested_name = payload
                .get("name")
                .and_then(|entry| entry.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            let proxy_id = payload.get("proxyId").and_then(|entry| entry.as_i64());
            let use_geoip = payload
                .get("useGeoip")
                .and_then(|entry| entry.as_bool())
                .unwrap_or(true);
            // 名字必须唯一可辨认：Agent 常只说「新环境」，重名会让用户在列表里分不清。
            let name = match requested_name {
                Some(name) => name,
                None => {
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|elapsed| elapsed.as_secs() % 100_000)
                        .unwrap_or(0);
                    format!("Agent-{stamp:05}")
                }
            };
            match crate::db::create_profile(
                &connection,
                &name,
                "#6366f1",
                proxy_id,
                None,
                use_geoip,
                true,
                None,
                // 与「新建环境」表单的默认值保持一致（default / local），不要在这里另起一套口径
                "default",
                "local",
                None,
                None,
            ) {
                Ok(profile) => json!({
                    "command": "agent_host_response",
                    "requestId": request_id,
                    "ok": true,
                    "data": {
                        "profileId": profile.id.to_string(),
                        "name": profile.name,
                    },
                }),
                Err(error) => fail(format!("新建环境失败：{error}")),
            }
        }
        "delete_environment" => {
            let raw_id = payload
                .get("profileId")
                .and_then(|entry| entry.as_str())
                .unwrap_or("")
                .trim()
                .to_owned();
            let Ok(target_id) = raw_id.parse::<i64>() else {
                return fail("缺少合法的 profileId".to_owned());
            };
            if raw_id == current_profile_id.trim() {
                return fail("不能删除当前正在运行任务的环境".to_owned());
            }
            // 只有「不在这台机器上跑着」的环境才允许删：删掉正在跑的会把浏览器进程
            // 连根拔掉，用户其它窗口里的任务会莫名其妙崩掉。
            if let Some(manager) = app.try_state::<crate::browser_manager::BrowserManager>() {
                if manager.is_running(&raw_id) {
                    return fail(format!(
                        "环境 #{raw_id} 的浏览器正在运行，请先停止它再删除"
                    ));
                }
            }
            match crate::db::delete_profile(&connection, target_id) {
                Ok(()) => json!({
                    "command": "agent_host_response",
                    "requestId": request_id,
                    "ok": true,
                    "data": { "profileId": raw_id },
                }),
                Err(error) => fail(format!("删除环境失败：{error}")),
            }
        }
        "clipboard_read" => {
            /*
             * §6.2：系统剪贴板**只能由宿主读**（Sidecar 不引入 Node 原生依赖，也不该有第二把锁）。
             * 内容原样回传供本次回放使用，但**不进日志、不进台账**（R2 / §6.4）：
             * 日志里只留长度（hub 内部已按此约定记录）。
             */
            match crate::clipboard::hub().read_text() {
                Ok(text) => json!({
                    "command": "agent_host_response",
                    "requestId": request_id,
                    "ok": true,
                    "data": {
                        "text": text,
                        "length": text.chars().count(),
                    },
                }),
                Err(error) => fail(error.reason()),
            }
        }
        other => fail(format!("不支持的宿主请求：{other}")),
    }
}

#[tauri::command]
pub async fn confirm_agent_action(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    request_id: String,
    fill_overrides: Option<Value>,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err(AppError::Validation("request_id cannot be empty".to_owned()));
    }

    let mut command = json!({
        "command": "agent_confirm",
        "requestId": request_id,
    });
    if let Some(overrides) = fill_overrides {
        command["fillOverrides"] = overrides;
    }

    manager.write_session_command(&profile_id, command)
}

#[tauri::command]
pub async fn cancel_agent_action(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    request_id: Option<String>,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    let mut command = json!({ "command": "agent_cancel" });
    if let Some(id) = request_id.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
    {
        command["requestId"] = json!(id);
    }
    manager.write_session_command(&profile_id, command)
}

#[tauri::command]
pub async fn reply_agent_ask(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    request_id: String,
    answer: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err(AppError::Validation("request_id cannot be empty".to_owned()));
    }
    manager.write_session_command(
        &profile_id,
        json!({
            "command": "agent_user_reply",
            "requestId": request_id,
            "answer": answer,
        }),
    )
}

#[tauri::command]
pub async fn continue_agent_handover(
    app: AppHandle,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    request_id: Option<String>,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    let request_id_trim = request_id
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    // Milestone 4：优先 HTTP POST /resume 打破 Node 未决 Promise；stdin 作兜底
    if let Some(port) = manager.get_pause_http_port(&profile_id) {
        let url = format!("http://127.0.0.1:{port}/resume");
        // 无 requestId 即用户点「全部继续」：必须显式 all=true，禁止空 body 静默恢复全部
        let body = match &request_id_trim {
            Some(id) => json!({ "requestId": id }),
            None => json!({ "all": true }),
        };
        let mut request = reqwest::Client::new()
            .post(&url)
            .json(&body)
            .timeout(Duration::from_secs(3));
        if let Some(state) = app.try_state::<AppState>() {
            request = request.header("X-Auth-Token", state.local_ipc.auth_token.as_str());
        }
        match request.send().await {
            Ok(response) => {
                if !response.status().is_success() {
                    log_warn!(
                        "TianshuTai: pause resume http status={} profile={}",
                        response.status(),
                        profile_id
                    );
                }
            }
            Err(error) => {
                log_error!("TianshuTai: pause resume http failed: {error}");
            }
        }
    }

    let mut command = json!({ "command": "agent_handover_continue" });
    if let Some(id) = &request_id_trim {
        command["requestId"] = json!(id);
    }
    manager.write_session_command(&profile_id, command)?;

    let _ = app.emit(
        AGENT_TASK_RESUMED_EVENT,
        json!({
            "profileId": profile_id,
            "requestId": request_id_trim,
        }),
    );
    Ok(())
}

/// Milestone 4：将环境 Chromium 页面前台唤醒（CDP Page.bringToFront + Win 任务栏）
#[tauri::command]
pub async fn bring_profile_to_front(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    // 1) Sidecar：Playwright/CDP bringToFront（无 RPA 会话时失败属预期，只是补充手段）
    let sidecar_result = manager.write_session_command(
        &profile_id,
        json!({ "command": "agent_bring_to_front" }),
    );
    // 2) Windows：按 CDP 端口把窗口抬到前台（真正决定「是否可见地置顶」）
    let focus_result = focus_profile_browser_inner(&db_state, &profile_id).await;
    let _ = app;
    // 旧实现无条件 Ok(())：两条路径都失败时前端仍收到成功，
    // 「去处理」按钮变成静默空操作，其 catch 分支成了永不执行的死代码。
    match (focus_result, sidecar_result) {
        (Ok(()), _) => Ok(()),
        (Err(focus_error), Ok(())) => {
            // 任务栏置顶失败但 sidecar 已受理 bringToFront 指令，降级为告警
            crate::log_warn!(
                "[rpa] bring_to_front 任务栏置顶失败，已回退 sidecar 指令: {focus_error}"
            );
            Ok(())
        }
        (Err(focus_error), Err(sidecar_error)) => {
            crate::log_warn!(
                "[rpa] bring_to_front 两条路径均失败: focus={focus_error}; sidecar={sidecar_error}"
            );
            Err(focus_error)
        }
    }
}

async fn focus_profile_browser_inner(
    db_state: &AppState,
    profile_id: &str,
) -> Result<(), AppError> {
    let numeric_id = parse_profile_id(profile_id)?;
    let cdp_port = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        profile
            .cdp_port
            .filter(|port| *port > 0 && *port <= i64::from(u16::MAX))
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "环境 #{profile_id} 无有效 CDP 端口（请确认浏览器已启动）"
                ))
            })?
    };
    let port = cdp_port as u16;
    tauri::async_runtime::spawn_blocking(move || {
        crate::win_taskbar::focus_browser_by_cdp_port(port)
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
    .map_err(AppError::Launcher)
}

#[tauri::command]
pub async fn abort_autonomous_agent(
    app: AppHandle,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager.write_session_command(&profile_id, json!({ "command": "agent_abort" }))?;
    let _ = app.emit(
        AGENT_TASK_RESUMED_EVENT,
        json!({
            "profileId": profile_id,
            "requestId": Value::Null,
            "aborted": true,
        }),
    );
    Ok(())
}

/// P4.5：用户暂停 Agent（软闸）— Sidecar 在 multi_act 前 awaitPause；恢复走 continue_agent_handover
#[tauri::command]
pub async fn pause_autonomous_agent(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager.write_session_command(&profile_id, json!({ "command": "agent_pause" }))
}

/// 轨迹回放：机械步骤 + 目标需交付时混合 LLM 分析（对齐 Agent 效果）
/// N13 · 按预检单执行（台账驱动）。
///
/// 与旧路径的区别只有一点：**跑哪些轮、每轮用哪一行数据，完全来自 `plan_json`**，
/// 执行阶段不再跑分配器（§4.6.7）。领取 → 逐轮下发 → 带 fencing 完成。
#[allow(clippy::too_many_arguments)]
async fn run_planned_replay(
    app: &AppHandle,
    db_state: &AppState,
    manager: &RpaSessionManager,
    profile_id: &str,
    plan: &crate::replay_job::RunPlan,
    plan_hash: &str,
    base_command: &Value,
    dataset_rows: &[serde_json::Map<String, Value>],
    field_map: &std::collections::BTreeMap<String, String>,
) -> Result<RpaRunResult, AppError> {
    use crate::replay_job as rj;

    let job_id = plan.plan_id.clone();

    // 幂等落库（job + 整张表的行）：UI 与对外 API 共用同一条路径（`ensure_job_row`）
    {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        rj::ensure_job_row(&connection, plan, plan_hash, Some(profile_id))?;
    }

    let mut completed = 0_u32;
    let mut total_steps = 0_u32;
    let mut last_msg = String::new();
    let mut first_error: Option<(i64, String)> = None;
    let mut aborted_remaining = false;

    loop {
        let claimed = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            // 每轮领取前回收过期租约：崩溃残留不会让该环境永久卡死
            rj::reap_expired_leases(&connection, &job_id)?;
            rj::claim_next_run(&connection, &job_id, profile_id, profile_id)?
        };
        let Some(claimed) = claimed else { break };

        let Some(row) = rj::find_plan_row(plan, claimed.seq) else {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            rj::finish_run(
                &connection,
                &job_id,
                claimed.seq,
                claimed.lease_token,
                "failed",
                None,
                Some("plan 表里找不到该轮次"),
            )?;
            if first_error.is_none() {
                first_error = Some((claimed.seq, "plan 表里找不到该轮次".to_owned()));
            }
            continue;
        };

        // 数据行按台账发的 record_index 取（与预检单逐行一致）
        let data_row = row
            .record
            .index
            .and_then(|index| dataset_rows.get(index as usize))
            .cloned();

        // 目标模板逐轮插值：映射到数据集的字段在目标里写成 `{{data.<列>}}`，
        // 这里用**本轮**的行数据展开，保证「填了张三、目标也是张三」（§7.6）。
        let round_goal = base_command
            .get("goal")
            .and_then(Value::as_str)
            .map(|template| rj::interpolate_plan_row_goal(template, row, &job_id, data_row.as_ref()))
            .filter(|goal| !goal.trim().is_empty());

        let mut round_command = base_command.clone();
        if let Some(object) = round_command.as_object_mut() {
            if let Some(goal) = round_goal {
                object.insert("goal".to_owned(), json!(goal));
            }
            object.insert("round".to_owned(), json!(row.run_index));
            object.insert(
                "openInNewTab".to_owned(),
                json!(row.tab.mode != "reuse"),
            );
            object.insert("closePreviousTab".to_owned(), json!(row.tab.close_after));
            object.insert(
                "runContext".to_owned(),
                json!({
                    "run": {
                        "seq": row.seq,
                        "index": row.run_index,
                        "envId": row.env_id,
                        "jobId": job_id,
                        "uniqueId": row.unique_id,
                        "runSeed": plan.allocation.run_seed,
                    },
                    // 行数据同时挂在 runContext.data 与 dataRow：sidecar 两个入口都认（§7.6）
                    "data": data_row.clone().unwrap_or_default(),
                }),
            );
            if let Some(ref row_data) = data_row {
                object.insert("dataRow".to_owned(), Value::Object(row_data.clone()));
            }
            object.insert(
                "runSeed".to_owned(),
                json!(plan.allocation.run_seed),
            );
            if let Some(overrides) = merged_round_overrides(
                object.get("valueOverrides"),
                field_map,
                data_row.as_ref(),
            ) {
                object.insert("valueOverrides".to_owned(), overrides);
            }
        }

        let outcome = manager
            .send_and_wait_with_timeout(
                app,
                db_state,
                profile_id,
                round_command,
                true,
                AGENT_RECV_TIMEOUT,
            )
            .await;

        let (status, error, steps, message) = match outcome {
            Ok(Some(result)) => {
                if result.state == "complete" {
                    ("done", None, result.step, result.msg)
                } else {
                    ("failed", Some(result.msg.clone()), result.step, result.msg)
                }
            }
            Ok(None) => (
                "failed",
                Some("回放结束但没有终态".to_owned()),
                0,
                "回放结束但没有终态".to_owned(),
            ),
            Err(error) => {
                let message = error.to_string();
                ("failed", Some(message.clone()), 0, message)
            }
        };

        let accepted = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            rj::finish_run(
                &connection,
                &job_id,
                claimed.seq,
                claimed.lease_token,
                status,
                Some(&json!({ "steps": steps }).to_string()),
                error.as_deref(),
            )?
        };
        if !accepted {
            // 租约已被接管：本轮结果作废，不能计入完成数
            log_warn!(
                "TianshuTai: replay run {}/{} lease taken over; result discarded",
                job_id,
                claimed.seq
            );
            continue;
        }

        total_steps = total_steps.saturating_add(steps);
        if status == "done" {
            completed += 1;
            last_msg = message;
        } else {
            if first_error.is_none() {
                first_error = Some((claimed.seq, message.clone()));
            }
            if plan.stop_on_first_failure {
                let connection = db_state
                    .database
                    .lock()
                    .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
                rj::cancel_pending_runs(&connection, &job_id, Some(profile_id))?;
                aborted_remaining = true;
                break;
            }
        }
    }

    {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        rj::refresh_job_status(&connection, &job_id)?;
    }

    if let Some((seq, error)) = first_error {
        return Ok(RpaRunResult {
            state: "failed".to_owned(),
            step: total_steps,
            msg: format!(
                "回放第 {} 轮失败：{}",
                seq + 1,
                if error.trim().is_empty() {
                    "未知错误".to_owned()
                } else {
                    error
                }
            ),
            actions: None,
            wait_id: None,
        });
    }

    Ok(RpaRunResult {
        state: "complete".to_owned(),
        step: total_steps,
        msg: if completed > 1 {
            format!(
                "回放完成 · {completed} 轮 · 共 {total_steps} 步{}",
                if aborted_remaining { "（已按「失败即停」中止剩余轮次）" } else { "" }
            )
        } else {
            last_msg
        },
        actions: None,
        wait_id: None,
    })
}

/// 把「数据集列 → 轨迹字段」的映射合并进该环境自己的字段覆盖里（§7.6）。
///
/// 语义：映射命中的字段变成「固定值 = 该单元格模板」，由 Sidecar 用当前行的
/// `{{data.*}}` / `{{run.*}}` 在填表前插值。**不改变**未映射字段的模式（AI 盲盒照旧）。
fn merged_round_overrides(
    existing: Option<&Value>,
    field_map: &std::collections::BTreeMap<String, String>,
    data_row: Option<&serde_json::Map<String, Value>>,
) -> Option<Value> {
    if field_map.is_empty() {
        return None;
    }
    let mut object = existing
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut changed = false;
    for (field_key, column) in field_map {
        // 该行没有这一列就不动它：宁可保留用户原本的覆盖，也不要插空串把字段清掉
        let Some(cell) = data_row.and_then(|row| row.get(column)) else {
            continue;
        };
        let template = match cell {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        let mut spec = object
            .get(field_key)
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        spec.insert("mode".to_owned(), json!("fixed"));
        spec.insert("value".to_owned(), json!(template));
        object.insert(field_key.clone(), Value::Object(spec));
        changed = true;
    }
    if changed {
        Some(Value::Object(object))
    } else {
        None
    }
}

#[tauri::command]
pub async fn replay_agent_trajectory(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    file_path: Option<String>,
    actions: Option<Value>,
    title: Option<String>,
    goal: Option<String>,
    value_overrides: Option<Value>,
    repeat_count: Option<u32>,
    open_in_new_tab: Option<bool>,
    close_previous_tab: Option<bool>,
    // N13：预检单（`RunPlan`）+ 指纹。带上即走「按表执行」的台账路径。
    plan: Option<Value>,
    plan_hash: Option<String>,
    // 已解析的数据集行（与预检单同源；用于按 record_index 取行）
    dataset_rows: Option<Vec<serde_json::Map<String, Value>>>,
    // 轨迹字段 → 数据集列
    field_map: Option<std::collections::BTreeMap<String, String>>,
    // N5 / N6：剪贴板运行策略（`{ mode, treatAsHuman }`；缺省即默认快照 + 一次性凭证拒填）
    clipboard: Option<Value>,
    // 用户「规则」/「人设」：回放目标里 `@规则名` / `@人设名` 的引用（缺省即不改变原行为）
    // - task_rules：规则载荷 → 机械步跑完后由 Sidecar 硬校验（严格完成条件 / 必须点击 / 固定数据）
    // - task_persona：`{ label, fixed }` → 规则运行时的权威人设
    task_rules: Option<Value>,
    task_persona: Option<Value>,
    // `@人设` 展开的 `{{persona.*}}` 模板值（**整套字段**，与回放既有口径一致）；
    // 缺省时回落到「本环境曾指定的人设」（旧数据兼容，前端迁移后该回落基本为空）
    persona_data: Option<Value>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;

    let path = file_path
        .as_ref()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let has_actions = actions
        .as_ref()
        .and_then(|value| value.as_array())
        .is_some_and(|entries| !entries.is_empty());

    if path.is_none() && !has_actions {
        return Err(AppError::Validation(
            "replay 需要 file_path 或非空 actions".to_owned(),
        ));
    }

    if let Some(ref file) = path {
        if !crate::trajectory_files::path_is_under_trajectories(file) {
            return Err(AppError::Validation(
                "file_path 必须位于 agent_exports/trajectories/".to_owned(),
            ));
        }
    }

    let mut bundle = load_rpa_runtime_bundle(&db_state, &profile_id, "{}", false, None).await?;

    // 沙盘延迟造数需要 AI + GeoIP + 人设
    let needs_jit = value_overrides
        .as_ref()
        .and_then(|value| value.as_object())
        .is_some_and(|map| {
            map.values().any(|entry| {
                entry
                    .get("mode")
                    .and_then(|mode| mode.as_str())
                    .is_some_and(|mode| mode.eq_ignore_ascii_case("ai_prompt"))
            })
        });
    if needs_jit && bundle.ai_settings.is_none() {
        bundle = load_rpa_runtime_bundle(&db_state, &profile_id, "{}", true, None).await?;
    }

    let numeric_id = parse_profile_id(&profile_id)?;
    // 回放人设来源：优先「回放目标里 `@人设名`」展开的整套字段（`persona_data`）；
    // 没写 @ 时才回落到旧数据（`agent_persona_selection`，前端一次性迁移后基本已清空）。
    // 环境人设列（profiles.persona_data）已下线，此处不读。
    let persona_value: Option<Value> = match persona_data.filter(|value| value.is_object()) {
        Some(direct) => Some(direct),
        None => {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            match db::resolve_agent_persona_for_profile(&connection, &profile_id).unwrap_or(None) {
                Some(legacy) => match legacy {
                    Value::String(text) => serde_json::from_str::<Value>(&text).ok(),
                    other => Some(other),
                },
                None => None,
            }
        }
    };

    let geo_context = {
        let proxy_input = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            crate::proxy::proxy_resolution_input_from_profile(&connection, &profile)?
        };
        match proxy_input {
            Some(input) => match crate::proxy::resolve_profile_proxy_input(input).await {
                Ok(resolved) => crate::ip_geo::resolve_proxy_egress_env(&resolved)
                    .await
                    .ok()
                    .map(|env| {
                        json!({
                            "exitIp": env.exit_ip,
                            "country": env.country,
                            "countryCode": env.country_code,
                            "region": env.region,
                            "city": env.city,
                            "timezone": env.timezone,
                            "locale": env.locale,
                            "latitude": env.latitude,
                            "longitude": env.longitude,
                        })
                    }),
                Err(_) => None,
            },
            None => crate::ip_geo::lookup_direct_env_sync().await.ok().map(|env| {
                json!({
                    "exitIp": env.exit_ip,
                    "country": env.country,
                    "countryCode": env.country_code,
                    "region": env.region,
                    "city": env.city,
                    "timezone": env.timezone,
                    "locale": env.locale,
                    "latitude": env.latitude,
                    "longitude": env.longitude,
                })
            }),
        }
    };

    let mut command = json!({
        "command": "trajectory_replay",
        "title": title.unwrap_or_else(|| "轨迹回放".to_owned()),
        "goal": goal.unwrap_or_default(),
        "proxyAuth": bundle.proxy_auth,
    });
    // §6.1：剪贴板策略随命令下发（Sidecar 只据此判定「一次性凭证是否放行」，词表不在 Host 里再写一套）
    if let Some(clipboard) = clipboard {
        if clipboard.is_object() {
            command["clipboard"] = clipboard;
        }
    }
    if let Some(file) = path {
        command["filePath"] = json!(file);
    }
    if let Some(actions_value) = actions {
        command["actions"] = actions_value;
    }
    if let Some(overrides) = value_overrides {
        if overrides.is_object() {
            command["valueOverrides"] = overrides;
        }
    }
    if let Some(ai_settings) = bundle.ai_settings {
        command["ai"] = ai_settings;
    }
    if let Some(geo) = geo_context {
        command["geoContext"] = geo;
    }
    if let Some(persona) = persona_value {
        command["personaData"] = persona;
    }
    // 回放里的 `@规则` / `@人设`：原样下发，判定与渲染都在 Sidecar（Host 不复制一套口径）
    if let Some(rules) = task_rules.filter(|value| value.is_array()) {
        command["taskRules"] = rules;
    }
    if let Some(persona) = task_persona.filter(|value| value.is_object()) {
        command["taskPersona"] = persona;
    }

    // —— N13：预检单驱动（台账 + 按表执行）——
    // 与旧路径的唯一区别：跑哪些轮、每轮用哪一行数据完全来自预检单，执行阶段不再跑分配器。
    if let (Some(plan_value), Some(expected_hash)) = (plan.clone(), plan_hash.clone()) {
        let parsed: crate::replay_job::RunPlan = serde_json::from_value(plan_value)
            .map_err(|error| AppError::Validation(format!("预检单结构不合法：{error}")))?;
        // ① 指纹：执行前重算，不一致 → 不启动任何东西（§4.6.7 规则 2）
        crate::replay_job::verify_plan_hash(&expected_hash, &parsed)?;
        // ② 剪贴板数据源：内容只在宿主内存快照里（§6.4 内容不落库、不入台账），
        //    预检单里只有指纹 —— 这里按指纹取回，取不回就**如实报错**（禁止编造内容）。
        let mut resolved_rows = dataset_rows.clone().unwrap_or_default();
        if parsed.dataset.source == "clipboard" && resolved_rows.is_empty() {
            let hash = parsed.dataset.hash.clone().unwrap_or_default();
            let Some(snapshot) = crate::clipboard::hub().recall(&hash) else {
                return Err(AppError::Validation(
                    "剪贴板快照已失效（超过 30 分钟或应用重启过）：请重新生成预检单并确认".to_owned(),
                ));
            };
            resolved_rows = snapshot
                .into_rows()
                .into_iter()
                .filter_map(|value| value.as_object().cloned())
                .collect();
        }
        // ③ 数据内容指纹：防「看着 A 跑着 B」（§5.4 两级指纹）
        if let Some(expected) = parsed.dataset.hash.clone() {
            let rows_value: Vec<Value> = resolved_rows
                .clone()
                .into_iter()
                .map(Value::Object)
                .collect();
            let actual = crate::replay_job::compute_dataset_hash(&rows_value);
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err(AppError::Validation(
                    "预检单与当前数据集内容不一致（plan_stale）：请重新生成预检单并确认".to_owned(),
                ));
            }
        }
        // ④ 红条禁止启动（UI 已禁用按钮；服务端再拦一道）
        if let Some(first) = parsed.errors.first() {
            return Err(AppError::Validation(format!(
                "预检单含红条，禁止启动：{}",
                first.text
            )));
        }
        let rows = resolved_rows;
        let map = field_map.unwrap_or_default();
        return run_planned_replay(
            &app,
            &db_state,
            &manager,
            &profile_id,
            &parsed,
            &expected_hash,
            &command,
            &rows,
            &map,
        )
        .await;
    }

    // —— N7：每环境运行次数（每轮一个新标签；N4 默认新标签）——
    // 重复执行由 Host 编排：每轮单独发一条 trajectory_replay，轮次身份随命令带上。
    let repeat_count = repeat_count.unwrap_or(1).clamp(1, 100);
    let open_in_new_tab = open_in_new_tab.unwrap_or(true);
    let close_previous_tab = close_previous_tab.unwrap_or(false);

    let mut completed_rounds: u32 = 0;
    let mut total_steps: u32 = 0;
    let mut last_msg = String::new();
    let mut failed: Option<(u32, String)> = None;

    for round in 0..repeat_count {
        let mut round_command = command.clone();
        round_command["round"] = json!(round);
        round_command["repeatCount"] = json!(repeat_count);
        round_command["openInNewTab"] = json!(open_in_new_tab);
        round_command["closePreviousTab"] = json!(close_previous_tab);

        let outcome = manager
            .send_and_wait_with_timeout(
                &app,
                &db_state,
                &profile_id,
                round_command,
                true,
                AGENT_RECV_TIMEOUT,
            )
            .await?;
        let Some(result) = outcome else {
            failed = Some((round, "trajectory replay finished without state".to_owned()));
            break;
        };
        if result.state == "complete" {
            completed_rounds += 1;
            total_steps = total_steps.saturating_add(result.step);
            last_msg = result.msg;
        } else {
            failed = Some((round, result.msg));
            break;
        }
        if round + 1 < repeat_count {
            // 错峰：避免同一环境连续多轮瞬时抢资源（惊群）
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    if let Some((round, error)) = failed {
        return Ok(RpaRunResult {
            state: "failed".to_owned(),
            step: total_steps,
            msg: format!(
                "回放第 {}/{} 轮失败：{}",
                round + 1,
                repeat_count,
                if error.trim().is_empty() {
                    "未知错误".to_owned()
                } else {
                    error
                }
            ),
            actions: None,
            wait_id: None,
        });
    }

    Ok(RpaRunResult {
        state: "complete".to_owned(),
        step: total_steps,
        msg: if repeat_count > 1 {
            format!(
                "回放完成 · {}/{} 轮 · 共 {} 步",
                completed_rounds, repeat_count, total_steps
            )
        } else {
            last_msg
        },
        actions: None,
        wait_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 起一个立即退出的空进程：仅为构造 [`RpaSessionInner`] 提供合法的 Child/ChildStdin。
    fn dormant_child() -> Child {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "true"]);
            command
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn dormant child")
    }

    fn register_session(manager: &RpaSessionManager, profile_id: &str) {
        let mut child = dormant_child();
        let stdin = child.stdin.take().expect("child stdin");
        manager.sessions.insert(
            profile_id.to_owned(),
            Arc::new(RpaSessionInner {
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                waiters: Mutex::new(Vec::new()),
                url_waiters: Mutex::new(Vec::new()),
                pause_http_port: Mutex::new(None),
            }),
        );
    }

    fn push_waiter(manager: &RpaSessionManager, profile_id: &str, wait_id: &str) {
        let (tx, _rx) = mpsc::channel();
        let session = manager.sessions.get(profile_id).expect("session");
        session
            .waiters
            .lock()
            .expect("waiters lock")
            .push(WaiterEntry {
                wait_id: wait_id.to_owned(),
                tx,
            });
    }

    /// 注册 waiter 并保留接收端，供断言终态内容。
    fn push_waiter_with_receiver(
        manager: &RpaSessionManager,
        profile_id: &str,
        wait_id: &str,
    ) -> mpsc::Receiver<RpaRunResult> {
        let (tx, rx) = mpsc::channel();
        let session = manager.sessions.get(profile_id).expect("session");
        session
            .waiters
            .lock()
            .expect("waiters lock")
            .push(WaiterEntry {
                wait_id: wait_id.to_owned(),
                tx,
            });
        rx
    }

    /// stop_session 会移除会话并杀进程。若不同步唤醒挂起方，正在 send_and_wait 的
    /// Agent/RPA 只能干等到自身超时（Agent 长达 600s），UI 长时间停在「执行中」；
    /// 而 is_engine_busy 已因会话消失返回 false，用户还能再起一轮导致结果互相覆盖。
    #[test]
    fn stop_session_releases_pending_waiters() {
        let manager = RpaSessionManager::default();
        register_session(&manager, "9");
        let rx = push_waiter_with_receiver(&manager, "9", "w-stop");
        assert!(manager.is_engine_busy("9"), "停止前应判定为忙");

        manager.stop_session("9").expect("stop_session");

        let result = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("停止会话必须立刻结算在途 waiter，而不是等它自己超时");
        assert_eq!(result.state, "aborted");
        assert!(result.wait_id.is_none(), "扇出结算不应携带 waitId");
        assert!(!manager.is_engine_busy("9"));
    }

    /// 无挂起方时 stop_session 必须安静返回（应用退出时的 stop_all_sessions 会走这条路径）。
    #[test]
    fn stop_session_without_waiters_is_noop() {
        let manager = RpaSessionManager::default();
        register_session(&manager, "10");
        manager.stop_session("10").expect("stop_session");
        manager.stop_session("10").expect("重复停止应幂等");
        assert!(!manager.has_session("10"));
    }

    /// waiter 是「引擎忙」的唯一判据。注册后若因早退（写入失败 / JoinError）未摘除，
    /// 该环境会被**永久**判定为忙，之后所有 Agent/RPA/回放都被拒且无法自愈。
    #[test]
    fn waiter_guard_releases_engine_busy() {
        let manager = RpaSessionManager::default();
        register_session(&manager, "1");
        push_waiter(&manager, "1", "w-1");
        assert!(manager.is_engine_busy("1"), "注册 waiter 后应判定为忙");

        {
            let _guard = WaiterGuard {
                manager: &manager,
                profile_id: "1",
                wait_id: "w-1",
            };
        }

        assert!(
            !manager.is_engine_busy("1"),
            "guard Drop 后必须恢复空闲，否则该环境被永久锁死"
        );
    }

    /// 正常终态已由 notify_waiters 出队，guard 的摘除必须幂等、不得误伤其他 waiter。
    #[test]
    fn waiter_guard_is_idempotent_and_scoped() {
        let manager = RpaSessionManager::default();
        register_session(&manager, "2");
        push_waiter(&manager, "2", "kept");
        push_waiter(&manager, "2", "released");

        {
            let _guard = WaiterGuard {
                manager: &manager,
                profile_id: "2",
                wait_id: "released",
            };
        }
        // 再次摘除同一 waitId：幂等，不应 panic
        manager.drop_waiter("2", "released");

        let session = manager.sessions.get("2").expect("session");
        let remaining: Vec<String> = session
            .waiters
            .lock()
            .expect("waiters lock")
            .iter()
            .map(|entry| entry.wait_id.clone())
            .collect();
        assert_eq!(remaining, vec!["kept".to_owned()], "不得误伤其他 waiter");
    }

    /// 会话不存在时摘除必须安全返回（写入失败的早退路径可能发生在会话被回收之后）。
    #[test]
    fn drop_waiter_tolerates_missing_session() {
        let manager = RpaSessionManager::default();
        manager.drop_waiter("missing", "w-1");
        assert!(!manager.is_engine_busy("missing"));
    }

    /// `taskRules` / `attachments` 的下发口径：空数组或缺失都不下发，非空才下发。
    /// 前端在没有 `@引用` 时不会带 taskRules；即便带了空数组，也不能让 Sidecar 以为「有规则」。
    #[test]
    fn empty_task_rules_are_not_forwarded() {
        let mut command = json!({ "command": "agent_start" });

        attach_non_empty_array(&mut command, "taskRules", None);
        attach_non_empty_array(&mut command, "taskRules", Some(json!([])));
        assert!(
            command.get("taskRules").is_none(),
            "空规则不得下发（Sidecar 侧会误以为有规则）"
        );

        attach_non_empty_array(&mut command, "attachments", Some(json!([])));
        assert!(command.get("attachments").is_none());

        let rules = json!([{ "id": "r1", "title": "出现提交成功", "kind": "dom", "role": "complete" }]);
        attach_non_empty_array(&mut command, "taskRules", Some(rules.clone()));
        assert_eq!(command.get("taskRules"), Some(&rules));

        attach_non_empty_array(&mut command, "attachments", Some(json!([{ "kind": "text" }])));
        assert!(command.get("attachments").is_some());
    }
}
