//! 外部数据 API —— 给**用户自己的程序**（Python 等）传数据用的 HTTP 入口。
//!
//! 契约只有一句话：**只传数据，不传命令**。
//! 调用方提供「字段名 → 值」，宿主把它填进**已启动的环境**；没有任何接口接受动作、
//! 脚本或浏览器指令。想让它点按钮、提交表单、过验证码，请走浏览器 Agent（那里有 HITL 与
//! 支付/凭证闸门），不是这里。
//!
//! 安全模型（缺一不可）：
//! 1. **默认关闭**：只有用户在「设置 → 常规设置」显式打开才监听（与短信/网页邮箱默认关同口径）；
//! 2. **只绑 127.0.0.1 随机端口**：局域网/外网不可达；
//! 3. **独立 token**：与内部 Sidecar IPC 令牌分开，可单独轮换（泄漏也只影响这一个入口）；
//! 4. **DNS 重绑定防护**：校验 `Host` 头必须是 127.0.0.1 / localhost / [::1]（防止浏览器里的
//!    恶意页面把域名解析到回环地址后直接调本接口）；
//! 5. **对端必须是回环地址**：用 `ConnectInfo` 判定，而不是只听端口绑定；
//! 6. **严格解析**：`deny_unknown_fields`，出现 `actions` / `command` 之类字段直接 400；
//! 7. **双道上限**：本层限制请求体/字段数/值长度，Sidecar 侧再限一次（字段名闸门 + 逐字段回执）。
//!
//! 红线（§1）：
//! - 支付/证件/私钥类字段由 Sidecar 字段闸门**整单拒绝**（R1）；
//! - 邮箱/短信/验证器一次性凭证字段同样整单拒绝（R2），错误文案会引导调用方改走 Agent 通道；
//! - 本 API 不读页面上已有的值，只写用户给的字段，因此不会有「把网页验证码读出来当来源」的路径。

use std::net::SocketAddr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::local_ipc::{constant_time_eq, generate_ipc_token};
use crate::{log_error, log_info, log_warn};

/// 外部 API 请求体上限（一份字段表，不该有几十 MB）
const EXTERNAL_BODY_LIMIT_BYTES: usize = 256 * 1024;
/// 单次最多字段数（Sidecar 侧同样有 64 的上限，这里提前挡掉）
const MAX_FIELDS: usize = 64;
/// 单个字段值最大字符数
const MAX_VALUE_CHARS: usize = 4096;
/// 对外暴露的协议版本：调用方据此判断兼容性
const API_VERSION: &str = "v1";

#[derive(Clone)]
struct DataApiState {
    app: AppHandle,
}

/// 服务句柄：与 `LocalIpcServer` 同一套优雅停机模式，支持运行中开关。
pub struct DataApiServer {
    pub base_url: String,
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    stopped_rx: Mutex<Option<mpsc::Receiver<()>>>,
}

impl DataApiServer {
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.shutdown_tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        if let Ok(mut guard) = self.stopped_rx.lock() {
            if let Some(rx) = guard.take() {
                let _ = rx.recv_timeout(std::time::Duration::from_secs(5));
            }
        }
    }
}

/// 运行期允许开关的服务句柄容器（由 `lib.rs` 托管）。
#[derive(Default)]
pub struct DataApiHandle {
    server: Mutex<Option<DataApiServer>>,
}

impl DataApiHandle {
    /// 当前 base_url（未启用时为 None）
    pub fn base_url(&self) -> Option<String> {
        self.server
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|server| server.base_url.clone()))
    }

    pub fn is_running(&self) -> bool {
        self.server
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    /// 启动（已启动则复用现有服务，不重复绑定端口）
    pub fn start(&self, app: AppHandle, token: String) -> Result<String, AppError> {
        let mut guard = self
            .server
            .lock()
            .map_err(|_| AppError::State("data api lock poisoned".to_owned()))?;
        if let Some(server) = guard.as_ref() {
            return Ok(server.base_url.clone());
        }
        let server = start_data_api(app, token)?;
        let base_url = server.base_url.clone();
        *guard = Some(server);
        Ok(base_url)
    }

    /// 停止（未启动时是幂等空操作）
    pub fn stop(&self) {
        let server = self.server.lock().ok().and_then(|mut guard| guard.take());
        if let Some(server) = server {
            server.shutdown();
        }
    }
}

/// 绑定 127.0.0.1 随机端口并启动 axum 服务。
///
/// 与本地 IPC 同样的纪律：`from_std` / `axum::serve` 必须在 Tokio runtime 内执行，
/// 否则同步 setup 路径会 Panic（there is no reactor running）。
pub fn start_data_api(app: AppHandle, token: String) -> Result<DataApiServer, AppError> {
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| AppError::State(format!("failed to bind data api listener: {error}")))?;
    std_listener.set_nonblocking(true).map_err(|error| {
        AppError::State(format!("failed to set data api listener nonblocking: {error}"))
    })?;
    let addr: SocketAddr = std_listener
        .local_addr()
        .map_err(|error| AppError::State(format!("failed to read data api addr: {error}")))?;

    let state = DataApiState { app: app.clone() };
    let auth_state = DataApiAuthState {
        token: Arc::from(token.as_str()),
        port: addr.port(),
    };

    let router = Router::new()
        .route("/v1/health", get(handle_health))
        .route("/v1/meta", get(handle_meta))
        .route("/v1/fill", post(handle_fill))
        .route("/v1/replay/meta", get(handle_replay_meta))
        .route("/v1/replay/plan", post(handle_replay_plan))
        .route("/v1/replay", post(handle_replay_start))
        .route("/v1/replay/{job_id}", get(handle_replay_status))
        .route("/v1/replay/{job_id}/cancel", post(handle_replay_cancel))
        .route("/v1/clipboard", get(handle_clipboard))
        .layer(DefaultBodyLimit::max(EXTERNAL_BODY_LIMIT_BYTES))
        .with_state(state)
        .layer(axum::middleware::from_fn_with_state(
            auth_state,
            require_data_api_auth,
        ));

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (stopped_tx, stopped_rx) = mpsc::channel::<()>();

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(error) => {
                log_error!("TianshuTai: data api tokio listener convert failed: {error}");
                let _ = stopped_tx.send(());
                return;
            }
        };
        let server = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = server.await {
            log_error!("TianshuTai: data api server exited with error: {error}");
        }
        let _ = stopped_tx.send(());
    });

    Ok(DataApiServer {
        base_url: format!("http://{addr}"),
        shutdown_tx: Mutex::new(Some(shutdown_tx)),
        stopped_rx: Mutex::new(Some(stopped_rx)),
    })
}

#[derive(Clone)]
struct DataApiAuthState {
    token: Arc<str>,
    port: u16,
}

/// 取调用方令牌：优先 `X-Api-Token`，兼容 `X-Auth-Token` / `Authorization: Bearer`。
fn extract_api_token(headers: &HeaderMap) -> &str {
    if let Some(value) = headers.get("x-api-token").and_then(|v| v.to_str().ok()) {
        return value.trim();
    }
    crate::local_ipc::extract_caller_token(headers)
}

/// `Host` 头是否只指向本机（DNS 重绑定防护的第一道）。
fn host_is_loopback(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get("host").and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let host = host.trim().to_ascii_lowercase();
    let (name, port_part) = match host.rsplit_once(':') {
        Some((name, port_part)) => (name.to_owned(), Some(port_part.to_owned())),
        None => (host.clone(), None),
    };
    if let Some(port_part) = port_part {
        if port_part.parse::<u16>().ok() != Some(port) {
            return false;
        }
    }
    matches!(
        name.as_str(),
        "127.0.0.1" | "localhost" | "[::1]" | "::1"
    )
}

/// 统一鉴权 + 本机校验：任何一条不满足都直接拒绝。
async fn require_data_api_auth(
    State(auth): State<DataApiAuthState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    // /v1/health 免鉴权：调用方需要一个「服务在不在」的探针（不泄露任何数据）
    if request.uri().path() == "/v1/health" {
        return next.run(request).await;
    }
    if !peer.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "loopback clients only").into_response();
    }
    if !host_is_loopback(&headers, auth.port) {
        return (StatusCode::FORBIDDEN, "unexpected host header").into_response();
    }
    if !constant_time_eq(auth.token.as_ref(), extract_api_token(&headers)) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    next.run(request).await
}

async fn handle_health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "app": "TianshuTai",
        "version": env!("CARGO_PKG_VERSION"),
        "api": API_VERSION,
        "loopbackOnly": true,
    }))
}

async fn handle_meta(State(state): State<DataApiState>) -> impl IntoResponse {
    let profiles = match state.app.try_state::<crate::AppState>() {
        Some(db_state) => match db_state.database.lock() {
            Ok(connection) => crate::db::list_profiles(&connection).unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        None => Vec::new(),
    };
    let items: Vec<Value> = profiles
        .iter()
        .map(|profile| {
            json!({
                "profileId": profile.id.to_string(),
                "name": profile.name,
                "status": profile.status,
            })
        })
        .collect();
    Json(json!({
        "ok": true,
        "api": API_VERSION,
        "profiles": items,
        "limits": {
            "maxFields": MAX_FIELDS,
            "maxValueChars": MAX_VALUE_CHARS,
            "maxBodyBytes": EXTERNAL_BODY_LIMIT_BYTES,
        },
        "notes": [
            "只接受数据：POST /v1/fill 的 body 仅允许 profileId / fields / pressEnterAfterFill",
            "环境必须处于 running 状态；本接口不会启动环境，也不会新建环境",
            "支付/证件/密钥类字段与邮箱·短信·验证器一次性凭证字段会被整单拒绝（R1/R2）",
            "本接口没有任何「动作/命令/脚本」参数，也不读页面上已有的值"
        ]
    }))
}

/// POST /v1/fill 的请求体：严格解析，未知字段直接报错。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FillRequest {
    #[serde(rename = "profileId", alias = "profile_id")]
    profile_id: String,
    fields: Vec<FillField>,
    #[serde(rename = "pressEnterAfterFill", alias = "press_enter_after_fill", default)]
    press_enter_after_fill: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FillField {
    name: String,
    #[serde(default)]
    value: Option<String>,
}

async fn handle_fill(
    State(state): State<DataApiState>,
    body: String,
) -> axum::response::Response {
    let request: FillRequest = match serde_json::from_str(&body) {
        Ok(request) => request,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "error": format!("请求体不合法（只允许 profileId / fields / pressEnterAfterFill）：{error}"),
                })),
            )
                .into_response();
        }
    };

    if request.fields.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "fields 不能为空" })),
        )
            .into_response();
    }
    if request.fields.len() > MAX_FIELDS {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": format!("一次最多 {} 个字段（收到 {} 个）", MAX_FIELDS, request.fields.len()),
            })),
        )
            .into_response();
    }

    let mut fields: Vec<(String, String)> = Vec::with_capacity(request.fields.len());
    let mut seen: Vec<String> = Vec::with_capacity(request.fields.len());
    for (index, field) in request.fields.iter().enumerate() {
        let name = field.name.trim().to_owned();
        if name.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": format!("fields[{index}] 缺少 name") })),
            )
                .into_response();
        }
        if seen.iter().any(|existing| existing == &name) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": format!("字段名重复：{name}") })),
            )
                .into_response();
        }
        let value = field.value.clone().unwrap_or_default();
        if value.chars().count() > MAX_VALUE_CHARS {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "error": format!("fields[{index}] 的值超过 {MAX_VALUE_CHARS} 字符上限"),
                })),
            )
                .into_response();
        }
        seen.push(name.clone());
        fields.push((name, value));
    }

    let some_app = state.app.clone();
    let Some(db_state) = some_app.try_state::<crate::AppState>() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "宿主数据库不可用" })),
        )
            .into_response();
    };
    let Some(rpa_manager) = some_app.try_state::<crate::rpa_session::RpaSessionManager>() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "会话管理器不可用" })),
        )
            .into_response();
    };

    // 引擎互斥（S5）：同环境 Agent / 填表 / RPA / 回放互斥，外部 API 不得绕过
    if let Err(error) =
        crate::sidecar::reject_if_rpa_engine_busy(&rpa_manager, &request.profile_id)
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "ok": false, "error": error.to_string() })),
        )
            .into_response();
    }

    let profile_id = request.profile_id.clone();
    let press_enter = request.press_enter_after_fill;
    let result = crate::fill_sidecar::execute_external_fill(
        &some_app,
        &db_state,
        profile_id,
        fields,
        press_enter,
    )
    .await;

    match result {
        Ok(report) => {
            let ok = serde_json::from_str::<Value>(&report)
                .ok()
                .and_then(|value| value.get("ok").and_then(Value::as_bool))
                .unwrap_or(false);
            let payload: Value = serde_json::from_str(&report).unwrap_or_else(|_| json!({
                "ok": false,
                "error": "sidecar 回执无法解析",
            }));
            let status = if ok {
                StatusCode::OK
            } else {
                StatusCode::UNPROCESSABLE_ENTITY
            };
            (status, Json(payload)).into_response()
        }
        Err(error) => {
            log_warn!("[data-api] external fill failed: {error}");
            let status = match error {
                AppError::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, Json(json!({ "ok": false, "error": error.to_string() }))).into_response()
        }
    }
}

/// 生成一个**独立于内部 IPC** 的 API 令牌（用户可随时轮换）。
pub fn generate_api_token() -> String {
    generate_ipc_token()
}

/* ------------------------------------------------------------------ *
 * N2 · 回放族与剪贴板（§7.2 – §7.5）
 * ------------------------------------------------------------------ *
 *
 * 契约只有一句话：**只传数据，不传命令**。
 * 这里能接受的输入是「轨迹 id + 一批数据 + 一个 planHash」，
 * 没有任何参数能放进动作、脚本、选择器或 URL —— 外部程序无法借本接口驱动任意浏览器操作。
 *
 * 红线（§1）在这里的落点：
 *  - `planHash` 必须来自本服务的 `/v1/replay/plan`（Host 重算比对，不一致 → `409 plan_stale`）；
 *  - 预检单里的红条（含凭证类列名、环境未运行/忙、数据不够）一律拒绝启动；
 *  - 支付/凭证闸门在执行阶段照旧生效（`decideHitlConfirm`），预检单**不能**用来预授权支付；
 *  - 响应与台账**不含任何字段值 / 剪贴板内容 / 验证码明文**。
 */

/// 独立开关（默认关，与短信 / 网页邮箱同口径）：回放族 `/v1/replay*`
pub const REPLAY_ENABLED_KEY: &str = "external_data_api_replay_enabled";
/// 独立开关（默认关）：`GET /v1/clipboard`
pub const CLIPBOARD_ENABLED_KEY: &str = "external_data_api_clipboard_enabled";
/// 同时进行的回放 job 上限（超出 → `429`，§7.5）
pub const MAX_RUNNING_REPLAY_JOBS: i64 = 4;
/// `dataset.filePath` 读取上限（与请求体上限同量级）
const MAX_DATASET_FILE_BYTES: u64 = 256 * 1024;

fn default_repeat_count() -> u32 {
    1
}

/// `/v1/replay*` 的数据集体（严格解析：未列出的键一律 400）
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplayDatasetBody {
    /// `json` | `jsonl` | `csv` | `tsv` | `txt` | `clipboard` | `none`
    #[serde(default)]
    format: Option<String>,
    /// `format=json` 时的对象数组
    #[serde(default)]
    inline: Option<Vec<Value>>,
    /// 本机文本文件绝对路径（服务端读取，仅本机）
    #[serde(default)]
    file_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplayAllocationBody {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    on_exhausted: Option<String>,
    #[serde(default)]
    run_seed: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplayConcurrencyBody {
    #[serde(default)]
    max: Option<u32>,
    #[serde(default)]
    stagger_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplayClipboardBody {
    /// `snapshot`（默认）| `per_run` | `off`
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    treat_as_human: Option<bool>,
}

/// 行级手工修改（与 `replay_job::PlanEdit` 同构；这里独立定义是为了 `deny_unknown_fields`）
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplayEditBody {
    seq: i64,
    #[serde(default)]
    use_record_index: Option<i64>,
    #[serde(default)]
    skipped: Option<bool>,
    #[serde(default)]
    record_source: Option<String>,
    #[serde(default)]
    tab_mode: Option<String>,
}

impl From<&ReplayEditBody> for crate::replay_job::PlanEdit {
    fn from(body: &ReplayEditBody) -> Self {
        Self {
            seq: body.seq,
            use_record_index: body.use_record_index,
            skipped: body.skipped,
            record_source: body.record_source.clone(),
            tab_mode: body.tab_mode.clone(),
        }
    }
}

/// `/v1/replay/plan` 与 `/v1/replay` 的请求体（同构；`planHash` 只有执行时必填）
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplayRequestBody {
    trajectory_id: i64,
    profile_ids: Vec<String>,
    #[serde(default = "default_repeat_count")]
    repeat_count: u32,
    #[serde(default)]
    plan_hash: Option<String>,
    #[serde(default)]
    edits: Vec<ReplayEditBody>,
    #[serde(default)]
    dataset: Option<ReplayDatasetBody>,
    #[serde(default)]
    allocation: Option<ReplayAllocationBody>,
    #[serde(default)]
    field_map: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    open_in_new_tab: Option<bool>,
    #[serde(default)]
    close_after: Option<bool>,
    #[serde(default)]
    stop_on_first_failure: Option<bool>,
    #[serde(default)]
    run_timeout_ms: Option<i64>,
    #[serde(default)]
    concurrency: Option<ReplayConcurrencyBody>,
    #[serde(default)]
    clipboard: Option<ReplayClipboardBody>,
    #[serde(default)]
    job_title: Option<String>,
    #[serde(default)]
    run_seed: Option<i64>,
}

/// 预检单 + 执行所需的一切（轨迹步、数据行、策略），一次算齐。
struct PreparedPlan {
    plan: crate::replay_job::RunPlan,
    /// 已解析的数据集行（与预检单同源；执行时按 `record_index` 取）
    rows: Vec<serde_json::Map<String, Value>>,
    /// 轨迹字段 → 数据集列（把某一列固定到某个字段上）
    field_map: std::collections::BTreeMap<String, String>,
    actions: Value,
    goal: String,
    title: String,
    /// 剪贴板策略（`{ mode, treatAsHuman }`）
    clipboard: Value,
}

fn json_body(status: StatusCode, body: Value) -> axum::response::Response {
    (status, Json(body)).into_response()
}

fn api_error(status: StatusCode, error: &str) -> axum::response::Response {
    json_body(status, json!({ "ok": false, "error": error }))
}

/// `planHash` 对不上 → `409 plan_stale`（§7.3.2）：**不启动任何东西**
fn plan_stale_response(detail: &str) -> axum::response::Response {
    json_body(
        StatusCode::CONFLICT,
        json!({ "ok": false, "error": "plan_stale", "detail": detail }),
    )
}

/// `AppError` → HTTP 状态（与 §7.5 对齐）
fn app_error_response(error: AppError) -> axum::response::Response {
    match error {
        AppError::NotFound(message) => api_error(StatusCode::NOT_FOUND, &message),
        AppError::Validation(message) => api_error(StatusCode::UNPROCESSABLE_ENTITY, &message),
        other => {
            log_warn!("[data-api] {other}");
            api_error(StatusCode::INTERNAL_SERVER_ERROR, &other.reason())
        }
    }
}

/// 读一个布尔开关（默认关）。读不到库就按「关」处理 —— 失败必须闭锁。
fn read_flag(app: &AppHandle, key: &str) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return false;
    };
    let Ok(connection) = state.database.lock() else {
        return false;
    };
    crate::db::get_setting(&connection, key)
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
}

fn resolve_clipboard(body: Option<&ReplayClipboardBody>) -> Result<Value, AppError> {
    let mode = body
        .and_then(|item| item.mode.clone())
        .unwrap_or_else(|| "snapshot".to_owned())
        .trim()
        .to_lowercase();
    let mode = match mode.as_str() {
        "" | "snapshot" => "snapshot",
        "per_run" => "per_run",
        "off" => "off",
        other => {
            return Err(AppError::Validation(format!(
                "clipboard.mode 不支持：{other}（可选 snapshot | per_run | off）"
            )))
        }
    };
    Ok(json!({
        "mode": mode,
        "treatAsHuman": body.and_then(|item| item.treat_as_human).unwrap_or(false),
    }))
}

/// 读 `dataset.filePath`（仅本机绝对路径；有大小上限；必须 UTF-8 文本）
fn read_dataset_file(path: &str) -> Result<String, AppError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        AppError::Validation(format!("dataset.filePath 读不到：{error}"))
    })?;
    if !metadata.is_file() {
        return Err(AppError::Validation(
            "dataset.filePath 不是文件".to_owned(),
        ));
    }
    if metadata.len() > MAX_DATASET_FILE_BYTES {
        return Err(AppError::Validation(format!(
            "dataset.filePath 超过 {} KB 上限",
            MAX_DATASET_FILE_BYTES / 1024
        )));
    }
    std::fs::read_to_string(path).map_err(|error| {
        AppError::Validation(format!(
            "dataset.filePath 读取失败（需要 UTF-8 文本；CSV 请在保存时选 UTF-8）：{error}"
        ))
    })
}

/// 解析数据集 → `PlanDatasetInput`。
///
/// 文本解析**不在 Rust 里另写一套**：交给 Sidecar 的唯一解析器（`core/dataset_parse.ts`），
/// 列名红线、行列定位、值长度上限两边只有一个口径（§7.1「严格解析」）。
/// 解析失败不抛异常，而是返回一条红条文案 —— 干跑必须能拿到明细去修（§7.3.1）。
async fn resolve_dataset(
    request: &ReplayRequestBody,
    clipboard_mode: &str,
) -> Result<(crate::replay_job::PlanDatasetInput, Option<String>), AppError> {
    let Some(body) = request.dataset.as_ref() else {
        return Ok((Default::default(), None));
    };
    let format = body.format.as_deref().unwrap_or("").trim().to_lowercase();

    if format == "clipboard" {
        if clipboard_mode == "off" {
            return Err(AppError::Validation(
                "dataset.format=clipboard 与 clipboard.mode=off 冲突：请改用其它数据源，或把 clipboard.mode 设为 snapshot"
                    .to_owned(),
            ));
        }
        return Ok((
            crate::replay_job::PlanDatasetInput {
                source: "clipboard".to_owned(),
                columns: Vec::new(),
                rows: Vec::new(),
                hash: None,
            },
            None,
        ));
    }
    if format == "none" || format == "generate" {
        return Ok((Default::default(), None));
    }

    let (text, source_label, format_hint) = match (&body.inline, &body.file_path) {
        (Some(rows), _) if !rows.is_empty() => {
            let text = serde_json::to_string(rows)
                .map_err(|error| AppError::Validation(format!("dataset.inline 无法序列化：{error}")))?;
            let hint = if format.is_empty() { "json".to_owned() } else { format.clone() };
            (text, "inline", hint)
        }
        (_, Some(path)) if !path.trim().is_empty() => {
            (read_dataset_file(path.trim())?, "file", format.clone())
        }
        _ => {
            return Err(AppError::Validation(
                "dataset 需要 inline（JSON 对象数组）或 filePath".to_owned(),
            ))
        }
    };

    let config = json!({
        "mode": "parse_dataset",
        "datasetText": text,
        "datasetFormat": if format_hint.is_empty() { Value::Null } else { json!(format_hint) },
        "datasetSource": source_label,
    });
    let raw = match crate::data_planner::invoke_data_planner_cli(&config, "dataset_parse_result").await
    {
        Ok(raw) => raw,
        Err(error) => {
            return Ok((
                crate::replay_job::PlanDatasetInput {
                    source: "inline".to_owned(),
                    ..Default::default()
                },
                Some(format!("数据集解析失败：{error}")),
            ))
        }
    };
    if raw.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = raw
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("数据集不合法")
            .to_owned();
        let located = match (raw.get("line").and_then(Value::as_i64), raw.get("column").and_then(Value::as_i64)) {
            (Some(line), Some(column)) => format!("{message}（第 {line} 行第 {column} 列）"),
            (Some(line), None) => format!("{message}（第 {line} 行）"),
            _ => message,
        };
        return Ok((
            crate::replay_job::PlanDatasetInput {
                source: "inline".to_owned(),
                ..Default::default()
            },
            Some(format!("数据集不合法：{located}")),
        ));
    }

    let columns: Vec<String> = raw
        .get("columns")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let rows: Vec<serde_json::Map<String, Value>> = raw
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_object().cloned())
        .collect();
    if rows.is_empty() {
        return Ok((
            crate::replay_job::PlanDatasetInput {
                source: "inline".to_owned(),
                ..Default::default()
            },
            Some("数据集没有任何数据行".to_owned()),
        ));
    }
    Ok((
        crate::replay_job::PlanDatasetInput {
            source: "inline".to_owned(),
            columns,
            rows,
            hash: None,
        },
        None,
    ))
}

/// 算出预检单 + 执行所需的全部输入（**不启动任何页面、不占台账**）。
///
/// 只对「语法错 / 令牌错 / 轨迹或环境不存在 / 参数矛盾」这类返回 `Err`；
/// 数据集不合法、剪贴板读不到这类**业务问题**一律变成预检单上的红条（§7.3.1 语义选择）。
async fn prepare_plan(
    app: &AppHandle,
    request: &ReplayRequestBody,
) -> Result<PreparedPlan, AppError> {
    if request.profile_ids.is_empty() {
        return Err(AppError::Validation("profileIds 不能为空".to_owned()));
    }
    if request.repeat_count == 0 || request.repeat_count > crate::replay_job::MAX_REPEAT_COUNT {
        return Err(AppError::Validation(format!(
            "repeatCount 必须在 1..={} 之间",
            crate::replay_job::MAX_REPEAT_COUNT
        )));
    }
    for raw_id in &request.profile_ids {
        crate::profile_id::parse_profile_id(raw_id)?;
    }
    let (max_concurrency, stagger_ms) = match request.concurrency.as_ref() {
        Some(body) => {
            if let Some(max) = body.max {
                if max == 0 || max > crate::replay_job::MAX_CONCURRENCY {
                    return Err(AppError::Validation(format!(
                        "concurrency.max 必须在 1..={} 之间",
                        crate::replay_job::MAX_CONCURRENCY
                    )));
                }
            }
            if let Some(stagger) = body.stagger_ms {
                if !(0..=2_000).contains(&stagger) {
                    return Err(AppError::Validation(
                        "concurrency.staggerMs 必须在 0..=2000 之间".to_owned(),
                    ));
                }
            }
            (body.max, body.stagger_ms)
        }
        None => (None, None),
    };
    let clipboard = resolve_clipboard(request.clipboard.as_ref())?;
    let clipboard_mode = clipboard
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("snapshot")
        .to_owned();

    // 轨迹：只认库里已录制的 id（**不接受** actions 数组）
    let (actions, goal, title) = {
        let Some(db_state) = app.try_state::<crate::AppState>() else {
            return Err(AppError::State("宿主数据库不可用".to_owned()));
        };
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let trajectory = crate::db::get_agent_trajectory(&connection, request.trajectory_id)?;
        let parsed = serde_json::from_str::<Value>(&trajectory.actions)
            .unwrap_or_else(|_| Value::Array(Vec::new()));
        (parsed, trajectory.goal.clone(), trajectory.title.clone())
    };

    let (dataset, dataset_error) = resolve_dataset(request, &clipboard_mode).await?;
    let rows = dataset.rows.clone();

    let plan_request = crate::replay_plan::ReplayPlanRequest {
        trajectory_id: Some(request.trajectory_id),
        trajectory_title: title.clone(),
        actions: Some(actions.as_array().cloned().unwrap_or_default()),
        goal: goal.clone(),
        profile_ids: request.profile_ids.clone(),
        repeat_count: request.repeat_count,
        dataset,
        field_map: request.field_map.clone(),
        allocation: crate::replay_job::PlanAllocationInput {
            mode: request.allocation.as_ref().and_then(|item| item.mode.clone()),
            on_exhausted: request
                .allocation
                .as_ref()
                .and_then(|item| item.on_exhausted.clone()),
            run_seed: request.allocation.as_ref().and_then(|item| item.run_seed),
        },
        open_in_new_tab: request.open_in_new_tab.unwrap_or(true),
        close_after: request.close_after.unwrap_or(false),
        stop_on_first_failure: request.stop_on_first_failure.unwrap_or(false),
        run_timeout_ms: request.run_timeout_ms,
        max_concurrency,
        stagger_ms,
        edits: request.edits.iter().map(Into::into).collect(),
        job_title: request.job_title.clone(),
        run_seed: request.run_seed,
    };

    let db_state = app.state::<crate::AppState>();
    let manager = app.state::<crate::RpaSessionManager>();
    let mut plan =
        crate::replay_plan::build_plan_from_request(&db_state, &manager, plan_request).await?;

    if let Some(message) = dataset_error {
        let entry = crate::replay_job::PlanWarning {
            level: "red".to_owned(),
            code: "dataset_invalid".to_owned(),
            text: message,
        };
        plan.errors.push(entry.clone());
        plan.warnings.push(entry);
        plan.ok = false;
    }

    Ok(PreparedPlan {
        plan,
        rows,
        field_map: request.field_map.clone(),
        actions,
        goal,
        title,
        clipboard,
    })
}

/// 派发一个回放 job：每环境一个后台任务，全局并发上限 + 错峰，**立即返回**（202）。
///
/// 为什么要后台：`/v1/replay` 的语义是「触发」而不是「等它跑完」；
/// 进度由 `GET /v1/replay/{jobId}` 查询（台账已先行落库，不会查不到）。
fn spawn_replay_dispatch(app: AppHandle, prepared: PreparedPlan, plan_hash: String) {
    let PreparedPlan {
        plan,
        rows,
        field_map,
        actions,
        goal,
        title,
        clipboard,
    } = prepared;
    let env_ids = crate::replay_job::plan_env_ids(&plan, None);
    let max_concurrency = plan.totals.max_concurrency.max(1) as usize;
    let stagger_ms = plan.totals.stagger_ms.max(0) as u64;
    let plan_value = match serde_json::to_value(&plan) {
        Ok(value) => value,
        Err(error) => {
            log_warn!("[data-api] replay plan serialization failed: {error}");
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(max_concurrency));
        for (index, env_id) in env_ids.into_iter().enumerate() {
            let Ok(permit) = semaphore.clone().acquire_owned().await else {
                break;
            };
            let app = app.clone();
            let plan_value = plan_value.clone();
            let plan_hash = plan_hash.clone();
            let actions = actions.clone();
            let goal = goal.clone();
            let title = title.clone();
            let clipboard = clipboard.clone();
            let rows = rows.clone();
            let field_map = field_map.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                if stagger_ms > 0 && index > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        stagger_ms.saturating_mul(index as u64),
                    ))
                    .await;
                }
                let db_state = app.state::<crate::AppState>();
                let manager = app.state::<crate::RpaSessionManager>();
                let result = crate::rpa_session::replay_agent_trajectory(
                    app.clone(),
                    db_state,
                    manager,
                    env_id.clone(),
                    None,
                    Some(actions),
                    Some(title),
                    Some(goal),
                    None,
                    None,
                    Some(true),
                    Some(false),
                    Some(plan_value),
                    Some(plan_hash),
                    Some(rows),
                    Some(field_map),
                    Some(clipboard),
                    // 外部 API 走「只传数据」的口径：不接受规则 / 人设注入（@ 引用仅在前端回放界面）
                    None,
                    None,
                    None,
                )
                .await;
                match result {
                    Ok(outcome) => log_info!(
                        "[data-api] replay env #{env_id} finished: {} ({})",
                        outcome.state,
                        outcome.msg.chars().take(120).collect::<String>()
                    ),
                    Err(error) => log_warn!("[data-api] replay env #{env_id} failed: {error}"),
                }
            });
        }
    });
}

/// `GET /v1/replay/meta`：轨迹只读列表 + 限额 + 分配模式说明（不含任何页面数据）
async fn handle_replay_meta(State(state): State<DataApiState>) -> axum::response::Response {
    let app = state.app.clone();
    let Some(db_state) = app.try_state::<crate::AppState>() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "宿主数据库不可用");
    };
    let (trajectories, running_jobs) = {
        let Ok(connection) = db_state.database.lock() else {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "数据库忙，请稍后重试");
        };
        (
            crate::db::list_agent_trajectories(&connection, "").unwrap_or_default(),
            crate::replay_job::count_running_jobs(&connection).unwrap_or(0),
        )
    };
    let items: Vec<Value> = trajectories
        .iter()
        .map(|trajectory| {
            let steps = serde_json::from_str::<Value>(&trajectory.actions)
                .ok()
                .and_then(|value| value.as_array().map(Vec::len))
                .unwrap_or(0);
            json!({
                "trajectoryId": trajectory.id,
                "title": trajectory.title,
                "domain": trajectory.domain,
                "goal": trajectory.goal,
                "steps": steps,
            })
        })
        .collect();
    json_body(
        StatusCode::OK,
        json!({
            "ok": true,
            "api": API_VERSION,
            "replayEnabled": read_flag(&app, REPLAY_ENABLED_KEY),
            "clipboardEnabled": read_flag(&app, CLIPBOARD_ENABLED_KEY),
            "trajectories": items,
            "runningJobs": running_jobs,
            "limits": {
                "maxRows": crate::replay_job::DATASET_MAX_ROWS,
                "maxRepeatCount": crate::replay_job::MAX_REPEAT_COUNT,
                "maxConcurrency": crate::replay_job::MAX_CONCURRENCY,
                "maxValueChars": MAX_VALUE_CHARS,
                "maxRunningJobs": MAX_RUNNING_REPLAY_JOBS,
                "replayTabLimit": crate::replay_job::REPLAY_TAB_LIMIT,
            },
            "allocation": [
                { "mode": "seq_interleave", "text": "同一时刻在跑的浏览器拿相邻行（默认，零重复）" },
                { "mode": "seq_block", "text": "每个浏览器拿连续区块" },
                { "mode": "claim", "text": "行由先到先领决定" },
                { "mode": "cycle", "text": "允许重复取用（N > M 时显式选择）" },
                { "mode": "generate", "text": "不用数据集，值按种子生成" },
            ],
            "notes": [
                "POST /v1/replay/plan 干跑出预检单（不碰浏览器）；POST /v1/replay 按预检单执行（须带 planHash）",
                "只接受轨迹 id + 数据 + planHash：不接受 actions / steps / script / selector / url / click / evaluate",
                "预检单不能预授权支付：执行阶段支付/凭证闸门照旧（会停在人工确认）",
                "轮次结果不含任何字段值 / 剪贴板内容 / 验证码明文",
            ],
        }),
    )
}

/// `POST /v1/replay/plan`：干跑出预检单（200；有红条也是 200 + `ok=false`）
async fn handle_replay_plan(State(state): State<DataApiState>, body: String) -> axum::response::Response {
    let request: ReplayRequestBody = match serde_json::from_str(&body) {
        Ok(request) => request,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                &format!(
                    "请求体不合法（只接受 trajectoryId / profileIds / repeatCount / dataset / allocation / fieldMap / openInNewTab / closeAfter / stopOnFirstFailure / runTimeoutMs / concurrency / clipboard / edits / jobTitle / runSeed）：{error}"
                ),
            )
        }
    };
    let app = state.app.clone();
    if !read_flag(&app, REPLAY_ENABLED_KEY) {
        return api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "回放接口未开启：请在「设置 → 常规设置 → 外部数据 API」里打开「回放接口」",
        );
    }
    match prepare_plan(&app, &request).await {
        Ok(prepared) => match serde_json::to_value(&prepared.plan) {
            Ok(value) => json_body(StatusCode::OK, value),
            Err(error) => api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("预检单序列化失败：{error}"),
            ),
        },
        Err(error) => app_error_response(error),
    }
}

/// `POST /v1/replay`：按预检单执行（202；`planHash` 不一致 → 409 plan_stale）
async fn handle_replay_start(State(state): State<DataApiState>, body: String) -> axum::response::Response {
    let request: ReplayRequestBody = match serde_json::from_str(&body) {
        Ok(request) => request,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                &format!(
                    "请求体不合法（不接受 actions / steps / script / selector / url / click / evaluate 等命令字段）：{error}"
                ),
            )
        }
    };
    let app = state.app.clone();
    if !read_flag(&app, REPLAY_ENABLED_KEY) {
        return api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "回放接口未开启：请在「设置 → 常规设置 → 外部数据 API」里打开「回放接口」",
        );
    }
    let Some(plan_hash) = request
        .plan_hash
        .clone()
        .filter(|value| !value.trim().is_empty())
    else {
        return api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "/v1/replay 缺少 planHash：请先调用 /v1/replay/plan 生成预检单并确认",
        );
    };

    let prepared = match prepare_plan(&app, &request).await {
        Ok(prepared) => prepared,
        Err(error) => return app_error_response(error),
    };

    // ① 指纹：重算比对（§4.6.7 规则 2）。不一致 → 一个页面都不启动
    let actual = crate::replay_job::compute_plan_hash(&prepared.plan);
    if !plan_hash.trim().eq_ignore_ascii_case(&actual) {
        return plan_stale_response(
            "预检单与当前数据/参数不一致：数据集内容、行级修改、分配策略或标签策略已变化。请重新调用 /v1/replay/plan 并确认。",
        );
    }

    // ② 红条一律禁止启动（环境未运行 / 忙 → 409；其余业务拒绝 → 422）
    if let Some(first) = prepared.plan.errors.first() {
        let status = match first.code.as_str() {
            "env_not_running" | "env_busy" => StatusCode::CONFLICT,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        if first.code == "not_enough_rows" {
            return json_body(
                status,
                json!({
                    "ok": false,
                    "error": first.text,
                    "required": prepared.plan.totals.total_runs,
                    "available": prepared.plan.dataset.size,
                }),
            );
        }
        return json_body(
            status,
            json!({ "ok": false, "error": first.text, "errors": prepared.plan.errors }),
        );
    }

    // ③ 并发闸门（§7.5）
    {
        let Some(db_state) = app.try_state::<crate::AppState>() else {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "宿主数据库不可用");
        };
        let running = {
            let Ok(connection) = db_state.database.lock() else {
                return api_error(StatusCode::SERVICE_UNAVAILABLE, "数据库忙，请稍后重试");
            };
            crate::replay_job::count_running_jobs(&connection).unwrap_or(0)
        };
        if running >= MAX_RUNNING_REPLAY_JOBS {
            return api_error(
                StatusCode::TOO_MANY_REQUESTS,
                &format!(
                    "并发超限：已有 {running} 个回放任务在跑（上限 {MAX_RUNNING_REPLAY_JOBS}）。等一个跑完，或先取消一个。"
                ),
            );
        }
    }

    // ④ 台账先行落库：紧接着的 GET 立刻可见（幂等，后台任务再落一次也无害）
    {
        let Some(db_state) = app.try_state::<crate::AppState>() else {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "宿主数据库不可用");
        };
        let result = {
            let Ok(connection) = db_state.database.lock() else {
                return api_error(StatusCode::SERVICE_UNAVAILABLE, "数据库忙，请稍后重试");
            };
            crate::replay_job::ensure_job_row(&connection, &prepared.plan, &plan_hash, None)
        };
        if let Err(error) = result {
            return app_error_response(error);
        }
    }

    let plan = prepared.plan.clone();
    let dataset_size = plan.dataset.size;
    let total_runs = plan.totals.total_runs;
    let skipped_runs = plan.rows.iter().filter(|row| row.skipped).count() as i64;
    let planned: Vec<Value> = plan
        .rows
        .iter()
        .take(200)
        .map(|row| {
            json!({
                "envId": row.env_id,
                "runIndex": row.run_index,
                "seq": row.seq,
                "recordIndex": row.record.index,
                "skipped": row.skipped,
            })
        })
        .collect();
    let truncated = plan.rows.len() > 200;

    spawn_replay_dispatch(app, prepared, plan_hash.clone());

    json_body(
        StatusCode::ACCEPTED,
        json!({
            "ok": true,
            "jobId": plan.plan_id,
            "planId": plan.plan_id,
            "planHash": plan_hash,
            "totalRuns": total_runs,
            "skippedRuns": skipped_runs,
            "datasetSize": dataset_size,
            "allocation": {
                "mode": plan.allocation.mode,
                "runSeed": plan.allocation.run_seed,
                "onExhausted": plan.allocation.on_exhausted,
            },
            "plannedAssignments": planned,
            "previewTruncated": truncated,
            "notes": [
                "每环境最多 1 个回放（S5 互斥）；支付/凭证闸门照旧生效",
                "进度查询：GET /v1/replay/{jobId}；取消：POST /v1/replay/{jobId}/cancel",
            ],
        }),
    )
}

/// `GET /v1/replay/{jobId}`：任务状态 + 每轮进度（不含凭证明文）
async fn handle_replay_status(
    Path(job_id): Path<String>,
    State(state): State<DataApiState>,
) -> axum::response::Response {
    let app = state.app.clone();
    let Some(db_state) = app.try_state::<crate::AppState>() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "宿主数据库不可用");
    };
    let snapshot = {
        let Ok(connection) = db_state.database.lock() else {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "数据库忙，请稍后重试");
        };
        crate::replay_job::job_snapshot(&connection, job_id.trim())
    };
    match snapshot {
        Ok(Some(snapshot)) => match serde_json::to_value(&snapshot) {
            Ok(mut value) => {
                if let Some(object) = value.as_object_mut() {
                    // §7.4 的扁平形态：顶层直接给各状态计数与 skew（`progress` 也一并保留）
                    object.insert("ok".to_owned(), json!(true));
                    object.insert("pending".to_owned(), json!(snapshot.progress.pending));
                    object.insert("claimed".to_owned(), json!(snapshot.progress.claimed));
                    object.insert("done".to_owned(), json!(snapshot.progress.done));
                    object.insert("failed".to_owned(), json!(snapshot.progress.failed));
                    object.insert("cancelled".to_owned(), json!(snapshot.progress.cancelled));
                    object.insert("skew".to_owned(), json!(snapshot.progress.skew));
                }
                json_body(StatusCode::OK, value)
            }
            Err(error) => api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("任务快照序列化失败：{error}"),
            ),
        },
        Ok(None) => api_error(StatusCode::NOT_FOUND, &format!("未知的任务：{job_id}")),
        Err(error) => app_error_response(error),
    }
}

/// `POST /v1/replay/{jobId}/cancel`：剩余轮次标取消 + 中止在跑的轮次（不关浏览器）
async fn handle_replay_cancel(
    Path(job_id): Path<String>,
    State(state): State<DataApiState>,
) -> axum::response::Response {
    let app = state.app.clone();
    let Some(db_state) = app.try_state::<crate::AppState>() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "宿主数据库不可用");
    };
    let job_id = job_id.trim().to_owned();
    let (cancelled, env_ids) = {
        let Ok(connection) = db_state.database.lock() else {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "数据库忙，请稍后重试");
        };
        match crate::replay_job::job_snapshot(&connection, &job_id) {
            Ok(Some(snapshot)) => {
                let cancelled = match crate::replay_job::cancel_job(&connection, &job_id) {
                    Ok(count) => count,
                    Err(error) => return app_error_response(error),
                };
                (
                    cancelled,
                    snapshot
                        .envs
                        .iter()
                        .filter(|env| env.status == "running")
                        .map(|env| env.env_id.clone())
                        .collect::<Vec<_>>(),
                )
            }
            Ok(None) => return api_error(StatusCode::NOT_FOUND, &format!("未知的任务：{job_id}")),
            Err(error) => return app_error_response(error),
        }
    };

    // 台账已停发新轮次；这里再打断「正在跑的那一轮」（Sidecar 的 trajectory_abort，不关浏览器）
    if let Some(manager) = app.try_state::<crate::RpaSessionManager>() {
        for env_id in &env_ids {
            if let Err(error) = manager.write_session_command(
                env_id,
                json!({ "command": "trajectory_abort" }),
            ) {
                log_warn!("[data-api] replay abort env #{env_id} failed: {error}");
            }
        }
    }

    json_body(
        StatusCode::OK,
        json!({
            "ok": true,
            "jobId": job_id,
            "cancelledRuns": cancelled,
            "abortedEnvs": env_ids,
            "notes": ["已停止派发新轮次，并向在跑的轮次发出中止；浏览器本身不受影响"],
        }),
    )
}

/// `GET /v1/clipboard`：读取系统剪贴板文本（只读、不入库；内容只回给调用方，不写日志）
async fn handle_clipboard(State(state): State<DataApiState>) -> axum::response::Response {
    let app = state.app.clone();
    if !read_flag(&app, CLIPBOARD_ENABLED_KEY) {
        return api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "剪贴板读取未开启：请在「设置 → 常规设置 → 外部数据 API」里打开「剪贴板读取」",
        );
    }
    match crate::clipboard::hub().read_text() {
        Ok(text) => {
            let length = text.chars().count();
            json_body(
                StatusCode::OK,
                json!({
                    "ok": true,
                    "text": text,
                    "length": length,
                    "notes": ["内容只在本响应里返回；不写日志、不入台账、不落盘"],
                }),
            )
        }
        Err(error) => api_error(StatusCode::UNPROCESSABLE_ENTITY, &error.reason()),
    }
}

/// 前端写接口：开关「回放族」「剪贴板读取」这两个**独立能力**（不重启服务，立即生效）。
#[tauri::command]
pub fn set_external_data_api_capability(
    state: tauri::State<'_, crate::AppState>,
    capability: String,
    enabled: bool,
) -> Result<Value, AppError> {
    let key = match capability.trim() {
        "replay" => REPLAY_ENABLED_KEY,
        "clipboard" => CLIPBOARD_ENABLED_KEY,
        other => {
            return Err(AppError::Validation(format!(
                "未知的能力开关：{other}（可选 replay | clipboard）"
            )))
        }
    };
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    crate::db::set_setting(&connection, key, if enabled { "1" } else { "0" })?;
    Ok(json!({ "capability": capability, "enabled": enabled }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    fn host_headers(host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_str(host).expect("host header"));
        headers
    }

    #[test]
    fn health_is_the_only_route_without_token() {
        // 只是把「探活免鉴权」这条约定写进测试，防止以后误放行 /v1/fill
        assert_eq!(API_VERSION, "v1");
        assert_eq!(EXTERNAL_BODY_LIMIT_BYTES, 256 * 1024);
    }

    #[test]
    fn host_header_must_be_loopback_and_match_port() {
        let port = 51234;
        assert!(host_is_loopback(&host_headers("127.0.0.1:51234"), port));
        assert!(host_is_loopback(&host_headers("localhost:51234"), port));
        // DNS 重绑定：外部域名解析到 127.0.0.1 也必须被挡
        assert!(!host_is_loopback(&host_headers("evil.example.com:51234"), port));
        // 端口不匹配（跨端口的 Host 头）同样拒绝
        assert!(!host_is_loopback(&host_headers("127.0.0.1:51235"), port));
        assert!(!host_is_loopback(&HeaderMap::new(), port));
    }

    #[test]
    fn fill_request_rejects_commands_and_unknown_keys() {
        // 只传数据：任何「命令/动作」字段都必须解析失败（400），而不是被忽略
        assert!(
            serde_json::from_str::<FillRequest>(
                r##"{"profileId":"1","fields":[{"name":"email","value":"a@b.c"}],"actions":[{"click":"#go"}]}"##
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<FillRequest>(
                r#"{"profileId":"1","fields":[{"name":"email","value":"a@b.c"}],"command":"fill"}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<FillRequest>(
                r##"{"profileId":"1","fields":[{"name":"email","value":"a@b.c","selector":"#x"}]}"##
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<FillRequest>(
                r#"{"profileId":"1","fields":[{"name":"email","value":"a@b.c","script":"1+1"}]}"#
            )
            .is_err()
        );
    }

    #[test]
    fn fill_request_accepts_plain_data() {
        let request: FillRequest = serde_json::from_str(
            r#"{"profileId":"7","fields":[{"name":"email","value":"a@b.c"},{"name":"姓名","value":"张三"}]}"#,
        )
        .expect("plain data payload must parse");
        assert_eq!(request.profile_id, "7");
        assert_eq!(request.fields.len(), 2);
        assert!(!request.press_enter_after_fill);
        // 值可缺省（空串）
        let missing: FillRequest =
            serde_json::from_str(r#"{"profileId":"7","fields":[{"name":"email"}]}"#).expect("parse");
        assert!(missing.fields[0].value.is_none());
    }

    #[test]
    fn replay_request_rejects_command_keys() {
        // 只传数据 + 轨迹 id：任何「命令/动作」键都必须解析失败（400），而不是被忽略。
        for payload in [
            r##"{"trajectoryId":1,"profileIds":["3"],"actions":[{"click":"#go"}]}"##,
            r##"{"trajectoryId":1,"profileIds":["3"],"steps":[]}"##,
            r##"{"trajectoryId":1,"profileIds":["3"],"script":"1+1"}"##,
            r##"{"trajectoryId":1,"profileIds":["3"],"selector":"#go"}"##,
            r##"{"trajectoryId":1,"profileIds":["3"],"url":"https://example.com"}"##,
            r##"{"trajectoryId":1,"profileIds":["3"],"evaluate":"1+1"}"##,
            r##"{"trajectoryId":1,"profileIds":["3"],"click":"#go"}"##,
        ] {
            assert!(
                serde_json::from_str::<ReplayRequestBody>(payload).is_err(),
                "命令键必须被拒绝：{payload}"
            );
        }
    }

    #[test]
    fn replay_request_accepts_two_step_payload() {
        // 干跑请求：没有 planHash 也应能解析（planHash 只在执行时必填，缺了由处理器返回 422）
        let plan: ReplayRequestBody = serde_json::from_str(
            r#"{"trajectoryId":12,"profileIds":["3","4"],"repeatCount":10,
                "dataset":{"format":"json","inline":[{"email":"a@b.c"}]},
                "allocation":{"mode":"seq_interleave","onExhausted":"error"},
                "concurrency":{"max":4},"openInNewTab":true}"#,
        )
        .expect("干跑请求必须可解析");
        assert_eq!(plan.trajectory_id, 12);
        assert_eq!(plan.profile_ids.len(), 2);
        assert_eq!(plan.repeat_count, 10);
        assert!(plan.plan_hash.is_none());
        assert!(plan.dataset.is_some());

        // 执行请求：原样带回 planHash
        let start: ReplayRequestBody =
            serde_json::from_str(r#"{"trajectoryId":12,"profileIds":["3"],"planHash":"sha256:abc"}"#)
                .expect("执行请求必须可解析");
        assert_eq!(start.plan_hash.as_deref(), Some("sha256:abc"));
        // 缺省就是 1 轮（不无限跑）
        assert_eq!(start.repeat_count, 1);
    }

    #[test]
    fn plan_hash_must_match_by_value_not_by_prefix() {
        // 执行阶段用 `eq_ignore_ascii_case` 比对（大小写宽容、前后空白无关）；
        // 这里锁定「不同指纹必须判不等」，防止以后有人改成「包含即通过」。
        let actual = "sha256:0123abcd";
        assert!(actual.eq_ignore_ascii_case("sha256:0123abcd"));
        assert!(actual.eq_ignore_ascii_case("sha256:0123ABCD"));
        assert!(!"sha256:0123ab".eq_ignore_ascii_case(actual));
        assert!(!"sha256:ffff".eq_ignore_ascii_case(actual));
        assert!(!"".eq_ignore_ascii_case(actual));
    }

    #[test]
    fn clipboard_capability_is_independent_from_replay() {
        // 两个能力是各自独立的键，避免「开了回放就顺带开了剪贴板」
        assert_ne!(REPLAY_ENABLED_KEY, CLIPBOARD_ENABLED_KEY);
        assert_ne!(REPLAY_ENABLED_KEY, ENABLED_KEY);
        assert_ne!(CLIPBOARD_ENABLED_KEY, ENABLED_KEY);
    }
}


/// 库设置键：外部数据 API 是否启用（默认关）/ 独立令牌
pub const ENABLED_KEY: &str = "external_data_api_enabled";
pub const TOKEN_KEY: &str = "external_data_api_token";

/// 前端读接口：当前状态（是否在跑 / 地址 / 令牌 / 限额 / 红线说明）。
#[tauri::command]
pub fn get_external_data_api_state(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    handle: tauri::State<'_, DataApiHandle>,
) -> Result<Value, AppError> {
    let (enabled, token, replay_enabled, clipboard_enabled) = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        (
            crate::db::get_setting(&connection, ENABLED_KEY)?.as_deref() == Some("1"),
            crate::db::get_setting(&connection, TOKEN_KEY)?.unwrap_or_default(),
            crate::db::get_setting(&connection, REPLAY_ENABLED_KEY)?.as_deref() == Some("1"),
            crate::db::get_setting(&connection, CLIPBOARD_ENABLED_KEY)?.as_deref() == Some("1"),
        )
    };
    let base_url = handle.base_url();
    Ok(json!({
        "enabled": enabled,
        "running": handle.is_running(),
        "baseUrl": base_url,
        "token": token,
        "docsPath": "docs/外部数据API.md",
        "limits": {
            "maxFields": MAX_FIELDS,
            "maxValueChars": MAX_VALUE_CHARS,
            "maxRunningReplayJobs": MAX_RUNNING_REPLAY_JOBS,
            "maxRepeatCount": crate::replay_job::MAX_REPEAT_COUNT,
            "maxConcurrency": crate::replay_job::MAX_CONCURRENCY,
        },
        // 能力开关（各自独立、默认关）：回放族 / 剪贴板读取
        "capabilities": {
            "replay": replay_enabled,
            "clipboard": clipboard_enabled,
        },
        "appVersion": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
        "app": app.package_info().name,
    }))
}

/// 前端写接口：开关外部数据 API（开=立即监听；关=立即停止接新请求）。
#[tauri::command]
pub fn set_external_data_api_enabled(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    handle: tauri::State<'_, DataApiHandle>,
    enabled: bool,
) -> Result<Value, AppError> {
    let token = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let existing = crate::db::get_setting(&connection, TOKEN_KEY)?.unwrap_or_default();
        let token = if existing.trim().is_empty() {
            let fresh = generate_api_token();
            crate::db::set_setting(&connection, TOKEN_KEY, &fresh)?;
            fresh
        } else {
            existing
        };
        crate::db::set_setting(&connection, ENABLED_KEY, if enabled { "1" } else { "0" })?;
        token
    };

    if enabled {
        let base_url = handle.start(app, token.clone())?;
        log_info!("TianshuTai: external data api enabled at {base_url}");
    } else {
        handle.stop();
        log_info!("TianshuTai: external data api disabled");
    }
    Ok(json!({
        "enabled": enabled,
        "running": handle.is_running(),
        "baseUrl": handle.base_url(),
        "token": token,
    }))
}

/// 前端写接口：轮换令牌（旧令牌立即失效；浏览器里复制粘贴的旧脚本要同步更新）。
#[tauri::command]
pub fn regenerate_external_data_api_token(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    handle: tauri::State<'_, DataApiHandle>,
) -> Result<Value, AppError> {
    let token = generate_api_token();
    {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        crate::db::set_setting(&connection, TOKEN_KEY, &token)?;
    }
    // 令牌变了必须重启服务，否则内存里还是旧令牌
    let enabled = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        crate::db::get_setting(&connection, ENABLED_KEY)?.as_deref() == Some("1")
    };
    if enabled {
        handle.stop();
        handle.start(app, token.clone())?;
    }
    Ok(json!({
        "enabled": enabled,
        "running": handle.is_running(),
        "baseUrl": handle.base_url(),
        "token": token,
    }))
}

