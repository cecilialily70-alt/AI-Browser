use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::db;
use crate::error::AppError;
use crate::profile_id::parse_profile_id;
use crate::proxy::ProxyAuthPayload;
use crate::process_win::hide_console_window;
use crate::sidecar::emit_sidecar_line;
use crate::sidecar::parse_raw_fill_profile;
use crate::sidecar_paths::resolve_sidecar_dist;
use crate::AppState;

pub struct FillRuntimeBundle {
    pub profile_payload: Map<String, Value>,
    pub raw_input: String,
    pub ai_settings: Value,
    pub proxy_auth: Option<ProxyAuthPayload>,
    pub sidecar_entry: PathBuf,
    pub cdp_url: String,
    pub user_data_dir: Option<String>,
}

pub struct RpaCdpBundle {
    pub sidecar_entry: PathBuf,
    pub cdp_url: String,
    pub proxy_auth: Option<ProxyAuthPayload>,
    pub ai_settings: Option<Value>,
    pub profile_payload: Map<String, Value>,
    pub raw_input: String,
    pub user_data_dir: Option<String>,
}

pub fn resolve_profile_user_data_dir(app: &AppHandle, profile_id: &str) -> Result<PathBuf, AppError> {
    let profiles_root = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Filesystem(error.to_string()))?
        .join("browser-profiles");
    Ok(profiles_root.join(format!("profile-{profile_id}")))
}

async fn load_profile_cdp_context(
    db_state: &AppState,
    profile_id: &str,
) -> Result<(u16, Option<ProxyAuthPayload>, Option<Value>), AppError> {
    let numeric_id = parse_profile_id(profile_id)?;
    let (cdp_port, ai_settings, proxy_input) = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        if profile.status != "running" {
            return Err(AppError::Validation(
                "profile must be running before automation; start the browser first".to_owned(),
            ));
        }
        let cdp_port = profile
            .cdp_port
            .ok_or_else(|| AppError::Validation("profile has no assigned cdp_port".to_owned()))?;

        let proxy_input =
            crate::proxy::proxy_resolution_input_from_profile(&connection, &profile)?;

        let base_url = db::get_setting(&connection, "deepseek_base_url")
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "https://api.deepseek.com".to_owned());
        let chat_model = resolve_stored_ai_text_model(&connection, &base_url)?;
        let agent_model = resolve_stored_ai_agent_model(&connection, &base_url)?;
        let vision_model = resolve_stored_ai_vision_model_setting(&connection, &base_url)?;
        let api_key = resolve_stored_ai_api_key(&connection, &base_url)?;
        let agent_thinking_disabled =
            model_disables_thinking_for_forced_tools(&connection, &agent_model);
        let ai_settings = api_key.map(|api_key| {
            json!({
                "apiKey": api_key,
                "apiBaseUrl": base_url,
                "chatModel": chat_model,
                "agentModel": agent_model,
                "textModel": agent_model,
                "visionModel": vision_model,
                "agentModelDisableThinking": agent_thinking_disabled,
            })
        });
        (cdp_port as u16, ai_settings, proxy_input)
    };

    let proxy_auth = match proxy_input {
        Some(input) => crate::proxy::resolve_profile_proxy_input(input)
            .await?
            .auth_payload(),
        None => None,
    };

    Ok((cdp_port, proxy_auth, ai_settings))
}

fn non_empty_setting(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_owned();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

/// 模型库里该模型是否被用户标注为「强制工具调用时禁用 thinking」。
///
/// 刻意不按模型名去猜（§0.5.3 脆弱字符串匹配）：模型 ID 迭代太快，猜不中就是一次 400。
/// 未标注时返回 false，侧车再用名称正则兜底（旧库平滑）。
pub fn model_disables_thinking_for_forced_tools(
    connection: &rusqlite::Connection,
    model: &str,
) -> bool {
    let target = model.trim().to_ascii_lowercase();
    if target.is_empty() {
        return false;
    }
    let Some(raw) = db::get_setting(connection, "ai_extra_models")
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
    else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(entries) = parsed.as_array() else {
        return false;
    };
    entries.iter().any(|entry| {
        entry
            .get("value")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_ascii_lowercase() == target)
            .unwrap_or(false)
            && entry
                .get("disableThinkingForForcedTools")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
    })
}

fn resolve_ai_provider_id(connection: &rusqlite::Connection, base_url: &str) -> String {
    if let Ok(Some(raw)) = db::get_setting(connection, "ai_provider") {
        let id = raw.trim().to_ascii_lowercase();
        if matches!(id.as_str(), "deepseek" | "zhipu" | "custom") {
            return id;
        }
    }
    let url = base_url.trim().to_ascii_lowercase();
    if url.contains("bigmodel.cn") || url.contains("bigmodel") {
        return "zhipu".to_owned();
    }
    if url.contains("deepseek.com") || url.contains("deepseek") || url.is_empty() {
        return "deepseek".to_owned();
    }
    "custom".to_owned()
}

fn task_model_from_json(raw: &str, provider: &str, role: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let model = value
        .get(provider)?
        .get(role)?
        .as_str()?
        .trim()
        .to_owned();
    if model.is_empty() {
        None
    } else {
        Some(model)
    }
}

/// 按服务商 + 任务角色读取模型（chat / agent / vision）。
///
/// **不再有写死的兜底模型**：模型 ID 由用户在「设置 → AI 设置 → 模型库」自建，
/// 所以未配置时返回明确的配置错误，让用户去补，而不是拿一个过期 ID 发请求
/// （那只会得到一个看不懂的 404/400）。
pub fn resolve_stored_ai_model_for_role(
    connection: &rusqlite::Connection,
    base_url: &str,
    role: &str,
) -> Result<String, AppError> {
    let provider = resolve_ai_provider_id(connection, base_url);
    let mut chat_model: Option<String> = None;
    if let Some(raw) = non_empty_setting(db::get_setting(connection, "ai_task_models")?) {
        if let Some(model) = task_model_from_json(&raw, &provider, role) {
            return Ok(model);
        }
        // 同服务商的文本档：视觉档没单独配时沿用文本档（比猜「哪个名字像视觉模型」可靠）
        chat_model = task_model_from_json(&raw, &provider, "chat");
    }
    // 兼容旧字段
    let legacy_key = match provider.as_str() {
        "zhipu" => "zhipu_chat_model",
        "custom" => "custom_chat_model",
        _ => "deepseek_chat_model",
    };
    if let Some(model) = non_empty_setting(db::get_setting(connection, legacy_key)?) {
        return Ok(model);
    }
    if let Some(model) = chat_model {
        return Ok(model);
    }
    if provider != "deepseek" {
        if let Some(model) = non_empty_setting(db::get_setting(connection, "deepseek_chat_model")?) {
            return Ok(model);
        }
    }
    Err(AppError::Validation(
        "尚未配置模型：请到「设置 → AI 设置 → 模型库」添加模型，并在「按任务选用模型」里选中".to_owned(),
    ))
}

/// 对话 / 默认文本模型
pub fn resolve_stored_ai_text_model(
    connection: &rusqlite::Connection,
    base_url: &str,
) -> Result<String, AppError> {
    resolve_stored_ai_model_for_role(connection, base_url, "chat")
}

/// Agent 工具循环文本模型
pub fn resolve_stored_ai_agent_model(
    connection: &rusqlite::Connection,
    base_url: &str,
) -> Result<String, AppError> {
    resolve_stored_ai_model_for_role(connection, base_url, "agent")
}

/// 视觉开眼模型
pub fn resolve_stored_ai_vision_model_setting(
    connection: &rusqlite::Connection,
    base_url: &str,
) -> Result<String, AppError> {
    resolve_stored_ai_model_for_role(connection, base_url, "vision")
}

/// 按当前服务商 / Base URL 取对应 Key（DeepSeek / 智谱 / 自定义分存）
pub fn resolve_stored_ai_api_key(
    connection: &rusqlite::Connection,
    base_url: &str,
) -> Result<Option<String>, AppError> {
    let deepseek = non_empty_setting(db::get_setting(connection, "deepseek_api_key")?);
    let zhipu = non_empty_setting(db::get_setting(connection, "zhipu_api_key")?);
    let custom = non_empty_setting(db::get_setting(connection, "custom_api_key")?);
    let provider = resolve_ai_provider_id(connection, base_url);

    match provider.as_str() {
        "zhipu" => Ok(zhipu.or(deepseek)),
        "custom" => Ok(custom.or(deepseek)),
        _ => Ok(deepseek),
    }
}

pub async fn load_rpa_runtime_bundle(
    db_state: &AppState,
    profile_id: &str,
    raw_input: &str,
    require_ai: bool,
    user_data_dir: Option<String>,
) -> Result<RpaCdpBundle, AppError> {
    let trimmed_input = raw_input.trim();
    let profile_payload = if trimmed_input.is_empty() {
        Map::new()
    } else {
        parse_raw_fill_profile(trimmed_input)?
    };

    let (cdp_port, proxy_auth, ai_settings) = load_profile_cdp_context(db_state, profile_id).await?;
    if require_ai && ai_settings.is_none() {
        return Err(AppError::Validation(
            "AI API key is not configured in global settings".to_owned(),
        ));
    }

    Ok(RpaCdpBundle {
        sidecar_entry: resolve_sidecar_dist("index.js")?,
        cdp_url: format!("http://127.0.0.1:{cdp_port}"),
        proxy_auth,
        ai_settings,
        profile_payload,
        raw_input: trimmed_input.to_owned(),
        user_data_dir,
    })
}

pub async fn load_fill_runtime_bundle(
    db_state: &AppState,
    profile_id: &str,
    raw_input: &str,
    user_data_dir: Option<String>,
) -> Result<FillRuntimeBundle, AppError> {
    let trimmed_input = raw_input.trim();
    if trimmed_input.is_empty() {
        return Err(AppError::Validation("fill profile input is empty".to_owned()));
    }

    let bundle = load_rpa_runtime_bundle(db_state, profile_id, trimmed_input, true, user_data_dir).await?;
    let ai_settings = bundle.ai_settings.ok_or_else(|| {
        AppError::Validation("AI API key is not configured in global settings".to_owned())
    })?;

    Ok(FillRuntimeBundle {
        profile_payload: bundle.profile_payload,
        raw_input: bundle.raw_input,
        ai_settings,
        proxy_auth: bundle.proxy_auth,
        sidecar_entry: bundle.sidecar_entry,
        cdp_url: bundle.cdp_url,
        user_data_dir: bundle.user_data_dir,
    })
}

fn extract_hybrid_preview_line(line: &str) -> Result<String, AppError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(AppError::Sidecar("empty preview line".to_owned()));
    }
    let value = serde_json::from_str::<Value>(trimmed)
        .map_err(|error| AppError::Sidecar(format!("invalid preview json line: {error}")))?;
    if value.get("type").and_then(|entry| entry.as_str()) == Some("hybrid_preview") {
        if let Some(profile) = value.get("profile") {
            return Ok(profile.to_string());
        }
    }
    if value.get("message").and_then(|entry| entry.as_str()) == Some("preview_hybrid_failed") {
        let message = value
            .get("data")
            .and_then(|entry| entry.get("error"))
            .and_then(|entry| entry.as_str())
            .unwrap_or("preview hybrid failed");
        return Err(AppError::Sidecar(message.to_owned()));
    }
    Err(AppError::Sidecar("line is not hybrid preview".to_owned()))
}

fn line_indicates_fill_complete(line: &str, parsed: Option<&Value>) -> bool {
    if line.contains("fill_engine_complete") {
        return true;
    }
    if let Some(Value::Object(obj)) = parsed {
        if obj.get("kind").and_then(Value::as_str) == Some("result")
            && obj
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| message == "fill_engine_complete")
        {
            return true;
        }
    }
    false
}

fn extract_smart_fill_export(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("message").and_then(|entry| entry.as_str()) != Some("smart_fill_ready") {
        return None;
    }
    value
        .get("data")
        .and_then(|entry| entry.get("exportPayload"))
        .map(|payload| payload.to_string())
}

fn line_indicates_failure(line: &str, parsed: Option<&Value>) -> bool {
    if line.contains("sidecar_failed")
        || line.contains("fill_command_failed")
        || line.contains("smart_element_fill_failed")
        || line.contains("external_fill_failed")
    {
        return true;
    }
    if let Some(Value::Object(obj)) = parsed {
        if obj.get("kind").and_then(Value::as_str) == Some("error") {
            return true;
        }
    }
    false
}

enum SidecarPumpMode {
    Preview,
    Fill,
    ExternalFill,
}

struct SidecarPumpResult {
    preview_json: Option<String>,
    fill_result: Option<Result<(), AppError>>,
    fill_export_json: Option<String>,
    /// 外部数据 API 的逐字段回执（`external_fill_result.data` 的原文 JSON）
    external_fill_json: Option<String>,
}

fn empty_pump_result() -> SidecarPumpResult {
    SidecarPumpResult {
        preview_json: None,
        fill_result: None,
        fill_export_json: None,
        external_fill_json: None,
    }
}

fn extract_external_fill_result(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("message").and_then(Value::as_str) != Some("external_fill_result") {
        return None;
    }
    value.get("data").map(|data| data.to_string())
}

fn spawn_sidecar_pump(
    app: AppHandle,
    stdout: impl std::io::Read + Send + 'static,
    stderr: impl std::io::Read + Send + 'static,
    mode: SidecarPumpMode,
) -> mpsc::Receiver<SidecarPumpResult> {
    let (done_tx, done_rx) = mpsc::channel();
    let app_stdout = app.clone();
    std::thread::spawn(move || {
        let stdout_reader = BufReader::new(stdout);
        let mut fill_export_json: Option<String> = None;
        for line in stdout_reader.lines() {
            let line = match line {
                Ok(value) => value,
                Err(error) => {
                    let _ = done_tx.send(SidecarPumpResult {
                        fill_result: Some(Err(AppError::Sidecar(error.to_string()))),
                        ..empty_pump_result()
                    });
                    return;
                }
            };
            let parsed = serde_json::from_str::<Value>(&line).ok();
            emit_sidecar_line(&app_stdout, &line);

            if matches!(mode, SidecarPumpMode::Preview) {
                if let Ok(preview) = extract_hybrid_preview_line(&line) {
                    let _ = done_tx.send(SidecarPumpResult {
                        preview_json: Some(preview),
                        ..empty_pump_result()
                    });
                    return;
                }
                if line_indicates_failure(&line, parsed.as_ref()) {
                    let _ = done_tx.send(SidecarPumpResult {
                        fill_result: Some(Err(AppError::Sidecar(format!(
                            "sidecar reported failure: {line}"
                        )))),
                        ..empty_pump_result()
                    });
                    return;
                }
                continue;
            }

            if matches!(mode, SidecarPumpMode::ExternalFill) {
                /*
                 * 外部数据 API 的终态是 `external_fill_result`，**不是** `fill_engine_complete`：
                 * 填表引擎内部先写 `fill_engine_complete`，那时字段名闸门与逐字段回执都还没生成，
                 * 若按它收尾就会拿到「没有回执的成功」。
                 */
                if let Some(report) = extract_external_fill_result(&line) {
                    let ok = serde_json::from_str::<Value>(&report)
                        .ok()
                        .and_then(|value| value.get("ok").and_then(Value::as_bool))
                        .unwrap_or(false);
                    let fill_result = if ok {
                        Ok(())
                    } else {
                        let message = serde_json::from_str::<Value>(&report)
                            .ok()
                            .and_then(|value| {
                                value.get("error").and_then(Value::as_str).map(str::to_owned)
                            })
                            .unwrap_or_else(|| "external fill rejected".to_owned());
                        Err(AppError::Validation(message))
                    };
                    let _ = done_tx.send(SidecarPumpResult {
                        fill_result: Some(fill_result),
                        external_fill_json: Some(report),
                        ..empty_pump_result()
                    });
                    return;
                }
                if line_indicates_failure(&line, parsed.as_ref()) {
                    let _ = done_tx.send(SidecarPumpResult {
                        fill_result: Some(Err(AppError::Sidecar(format!(
                            "sidecar reported failure: {line}"
                        )))),
                        ..empty_pump_result()
                    });
                    return;
                }
                continue;
            }

            if let Some(export_json) = extract_smart_fill_export(&line) {
                fill_export_json = Some(export_json);
            }

            if line_indicates_fill_complete(&line, parsed.as_ref()) {
                let _ = done_tx.send(SidecarPumpResult {
                    fill_result: Some(Ok(())),
                    fill_export_json,
                    ..empty_pump_result()
                });
                return;
            }
            if line_indicates_failure(&line, parsed.as_ref()) {
                let _ = done_tx.send(SidecarPumpResult {
                    fill_result: Some(Err(AppError::Sidecar(format!(
                        "sidecar reported failure: {line}"
                    )))),
                    ..empty_pump_result()
                });
                return;
            }
        }

        let _ = done_tx.send(SidecarPumpResult {
            fill_result: Some(Err(AppError::Sidecar(
                "sidecar stdout closed before command completed".to_owned(),
            ))),
            ..empty_pump_result()
        });
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

    done_rx
}

async fn invoke_sidecar_command(
    app: &AppHandle,
    profile_id: &str,
    bundle: &FillRuntimeBundle,
    command: Value,
    mode: SidecarPumpMode,
) -> Result<SidecarPumpResult, AppError> {
    let mut node_cmd = Command::new("node");
    node_cmd
        .arg(&bundle.sidecar_entry)
        .arg("--cdp-url")
        .arg(&bundle.cdp_url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut node_cmd);
    // —— Milestone 1：注入本地 IPC 地址，Sidecar 走 HTTP /report 上报 ——
    if let Some(state) = app.try_state::<AppState>() {
        crate::local_ipc::apply_ipc_env(
            &mut node_cmd,
            &state.local_ipc.base_url,
            profile_id,
            &state.local_ipc.auth_token,
        );
    }
    let mut child = node_cmd
        .spawn()
        .map_err(|error| AppError::Sidecar(format!("failed to spawn sidecar: {error}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Sidecar("sidecar stdout unavailable".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Sidecar("sidecar stderr unavailable".to_owned()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Sidecar("sidecar stdin unavailable".to_owned()))?;

    let done_rx = spawn_sidecar_pump(app.clone(), stdout, stderr, mode);
    std::thread::sleep(Duration::from_millis(1500));

    let command_line = format!("{command}\n");
    stdin
        .write_all(command_line.as_bytes())
        .map_err(|error| AppError::Sidecar(format!("failed to write sidecar command: {error}")))?;
    stdin
        .flush()
        .map_err(|error| AppError::Sidecar(format!("failed to flush sidecar command: {error}")))?;

    let pump_result = tauri::async_runtime::spawn_blocking(move || {
        done_rx.recv_timeout(Duration::from_secs(60))
    })
    .await
    .map_err(|error| AppError::Sidecar(error.to_string()))?
    .map_err(|error| match error {
        RecvTimeoutError::Timeout => AppError::Sidecar(
            "sidecar wait timed out after 60s (no completion from fill sidecar)".to_owned(),
        ),
        RecvTimeoutError::Disconnected => {
            AppError::Sidecar("sidecar completion channel closed".to_owned())
        }
    })?;

    let _ = stdin.write_all(b"{\"command\":\"abort\"}\n");
    let _ = stdin.flush();
    // 填表已成功且 pump_result 已就绪，不能让无上限的 wait 把命令卡死：
    // abort 后仍有上限地回收（abort 会走 shutdown → browser.close()，CDP 卡住即无限挂起）
    let _ = crate::process_win::wait_child_with_deadline(&mut child, Duration::from_secs(10));

    Ok(pump_result)
}

pub async fn preview_hybrid_fill(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: String,
    raw_input: String,
) -> Result<String, AppError> {
    let user_data_dir = resolve_profile_user_data_dir(app, &profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let bundle = load_fill_runtime_bundle(db_state, &profile_id, &raw_input, user_data_dir).await?;
    let mut command = json!({
        "command": "preview_hybrid",
        "profile": bundle.profile_payload,
        "rawInput": bundle.raw_input,
        "ai": bundle.ai_settings,
        "proxyAuth": bundle.proxy_auth,
    });
    if let Some(dir) = &bundle.user_data_dir {
        command["userDataDir"] = json!(dir);
    }

    let result = invoke_sidecar_command(app, &profile_id, &bundle, command, SidecarPumpMode::Preview).await?;
    result
        .preview_json
        .ok_or_else(|| AppError::Sidecar("hybrid preview missing profile payload".to_owned()))
}

pub async fn execute_direct_fill(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: String,
    raw_input: String,
    press_enter_after_fill: bool,
) -> Result<(), AppError> {
    let user_data_dir = resolve_profile_user_data_dir(app, &profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let bundle = load_rpa_runtime_bundle(db_state, &profile_id, &raw_input, false, user_data_dir).await?;

    let fill_bundle = FillRuntimeBundle {
        profile_payload: bundle.profile_payload,
        raw_input: bundle.raw_input,
        ai_settings: bundle.ai_settings.unwrap_or(json!({})),
        proxy_auth: bundle.proxy_auth,
        sidecar_entry: bundle.sidecar_entry,
        cdp_url: bundle.cdp_url,
        user_data_dir: bundle.user_data_dir,
    };

    let mut command = json!({
        "command": "fill",
        "profile": fill_bundle.profile_payload,
        "rawInput": fill_bundle.raw_input,
        "skipHybrid": true,
        "directFill": true,
        "pressEnterAfterFill": press_enter_after_fill,
        "proxyAuth": fill_bundle.proxy_auth,
    });
    if let Some(dir) = &fill_bundle.user_data_dir {
        command["userDataDir"] = json!(dir);
    }
    if fill_bundle.ai_settings.is_object()
        && fill_bundle
            .ai_settings
            .get("apiKey")
            .and_then(|value| value.as_str())
            .is_some_and(|key| !key.trim().is_empty())
    {
        command["ai"] = fill_bundle.ai_settings.clone();
    }

    let result = invoke_sidecar_command(app, &profile_id, &fill_bundle, command, SidecarPumpMode::Fill).await?;
    result.fill_result.unwrap_or(Err(AppError::Sidecar(
        "direct fill sidecar finished without result".to_owned(),
    )))
}

/**
 * 外部数据 API（Python/JSON）的填表入口。
 *
 * 与 `execute_direct_fill` 的差别只有三点，其余完全复用同一条链路（互斥、CDP、sidecar 启动）：
 * 1. 载荷是**结构化字段数组**，不走 `rawInput` 的自由文本解析 —— 从协议层就没有「命令」的位置；
 * 2. sidecar 侧命令是 `external_fill`，会先过字段名闸门（支付/证件/一次性凭证整单拒绝）；
 * 3. 返回值是**逐字段回执**，调用方能精确知道哪一项没落地。
 *
 * 注意：**不做 persona 填充**。外部程序给什么就填什么，未给字段不会由 AI 现生成 ——
 * 这是「只传数据」的应有之义，也避免外部调用悄悄产生新的身份数据。
 */
pub async fn execute_external_fill(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: String,
    fields: Vec<(String, String)>,
    press_enter_after_fill: bool,
) -> Result<String, AppError> {
    if fields.is_empty() {
        return Err(AppError::Validation("fields cannot be empty".to_owned()));
    }
    let numeric_id = parse_profile_id(&profile_id)?;
    {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        if profile.status != "running" {
            return Err(AppError::Validation(
                "环境必须处于运行中状态才能接收外部数据（请先在环境列表启动它）".to_owned(),
            ));
        }
    }

    let user_data_dir = resolve_profile_user_data_dir(app, &profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let bundle = load_rpa_runtime_bundle(db_state, &profile_id, "{}", false, user_data_dir).await?;
    let fill_bundle = FillRuntimeBundle {
        profile_payload: bundle.profile_payload,
        raw_input: bundle.raw_input,
        ai_settings: bundle.ai_settings.unwrap_or(json!({})),
        proxy_auth: bundle.proxy_auth,
        sidecar_entry: bundle.sidecar_entry,
        cdp_url: bundle.cdp_url,
        user_data_dir: bundle.user_data_dir,
    };

    let field_payload: Vec<Value> = fields
        .iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();
    let mut command = json!({
        "command": "external_fill",
        "fields": field_payload,
        "pressEnterAfterFill": press_enter_after_fill,
        "proxyAuth": fill_bundle.proxy_auth,
    });
    if let Some(dir) = &fill_bundle.user_data_dir {
        command["userDataDir"] = json!(dir);
    }

    let result = invoke_sidecar_command(
        app,
        &profile_id,
        &fill_bundle,
        command,
        SidecarPumpMode::ExternalFill,
    )
    .await?;
    let report = result
        .external_fill_json
        .ok_or_else(|| AppError::Sidecar("external fill sidecar finished without report".to_owned()))?;
    // 逐字段回执即使部分失败也要原样交给调用方（HTTP 层按 ok 决定状态码）
    Ok(report)
}

pub async fn execute_smart_fill(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: String,
    natural_language: String,
    seed_input: Option<String>,
    press_enter_after_fill: bool,
) -> Result<String, AppError> {
    let trimmed_language = natural_language.trim();
    if trimmed_language.is_empty() {
        return Err(AppError::Validation(
            "smart fill natural language cannot be empty".to_owned(),
        ));
    }

    let numeric_id = parse_profile_id(&profile_id)?;
    {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        if profile.status != "running" {
            return Err(AppError::Validation(
                "profile must be running before smart fill".to_owned(),
            ));
        }
        // 宪法 §1.7：元素提取默认恒开，不再以开关拦截智能填表
    }

    let user_data_dir = resolve_profile_user_data_dir(app, &profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let seed = seed_input.unwrap_or_default();
    let bundle = if seed.trim().is_empty() {
        load_rpa_runtime_bundle(db_state, &profile_id, "{}", false, user_data_dir.clone()).await?
    } else {
        load_rpa_runtime_bundle(db_state, &profile_id, &seed, false, user_data_dir.clone()).await?
    };

    let ai_settings = bundle.ai_settings.ok_or_else(|| {
        AppError::Validation("智能填表需要配置 DeepSeek API Key".to_owned())
    })?;

    let fill_bundle = FillRuntimeBundle {
        profile_payload: bundle.profile_payload,
        raw_input: bundle.raw_input,
        ai_settings,
        proxy_auth: bundle.proxy_auth,
        sidecar_entry: bundle.sidecar_entry,
        cdp_url: bundle.cdp_url,
        user_data_dir: bundle.user_data_dir,
    };

    let mut command = json!({
        "command": "smart_element_fill",
        "naturalLanguage": trimmed_language,
        "seedInput": seed,
        "requireInteractiveExtract": true,
        "pressEnterAfterFill": press_enter_after_fill,
        "ai": fill_bundle.ai_settings,
        "proxyAuth": fill_bundle.proxy_auth,
    });
    if let Some(dir) = &fill_bundle.user_data_dir {
        command["userDataDir"] = json!(dir);
    }

    let result = invoke_sidecar_command(app, &profile_id, &fill_bundle, command, SidecarPumpMode::Fill).await?;
    result.fill_result.unwrap_or(Err(AppError::Sidecar(
        "smart fill sidecar finished without result".to_owned(),
    )))?;
    result.fill_export_json.ok_or_else(|| {
        AppError::Sidecar("smart fill finished without export payload".to_owned())
    })
}

pub async fn execute_ai_fill(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: String,
    raw_input: String,
    confirmed_profile: Option<String>,
    skip_hybrid: bool,
    press_enter_after_fill: bool,
) -> Result<(), AppError> {
    let user_data_dir = resolve_profile_user_data_dir(app, &profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let bundle = load_fill_runtime_bundle(db_state, &profile_id, &raw_input, user_data_dir).await?;

    let mut command = json!({
        "command": "fill",
        "profile": bundle.profile_payload,
        "rawInput": bundle.raw_input,
        "skipHybrid": skip_hybrid,
        "pressEnterAfterFill": press_enter_after_fill,
        "ai": bundle.ai_settings,
        "proxyAuth": bundle.proxy_auth,
    });
    if let Some(dir) = &bundle.user_data_dir {
        command["userDataDir"] = json!(dir);
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

    let result = invoke_sidecar_command(app, &profile_id, &bundle, command, SidecarPumpMode::Fill).await?;
    result.fill_result.unwrap_or(Err(AppError::Sidecar(
        "fill sidecar finished without result".to_owned(),
    )))
}
