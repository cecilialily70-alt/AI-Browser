use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::db;
use crate::error::AppError;
use crate::process_win::{hide_console_window, wait_child_with_deadline};
use crate::log_warn;
use crate::profile_id::parse_profile_id;
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};
use crate::AppState;

pub const PENDING_COOKIES_FILENAME: &str = "ai-browser-pending-cookies.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieExportResult {
    pub format: String,
    pub count: u32,
    /// JSON 数组字符串或 Netscape 文本
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportResult {
    pub count: u32,
    pub applied_now: bool,
    pub pending_path: Option<String>,
}

fn profiles_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Filesystem(error.to_string()))?
        .join("browser-profiles"))
}

fn profile_user_data_dir(app: &AppHandle, profile_id: &str) -> Result<PathBuf, AppError> {
    Ok(profiles_root(app)?.join(format!("profile-{profile_id}")))
}

fn pending_cookies_path(app: &AppHandle, profile_id: &str) -> Result<PathBuf, AppError> {
    Ok(profile_user_data_dir(app, profile_id)?.join(PENDING_COOKIES_FILENAME))
}

/// cookies_cli 的等待上限。既是「自然退出的容忍时长」，也是载荷回收的兜底。
const COOKIE_CLI_TIMEOUT: Duration = Duration::from_secs(60);

fn run_cookies_cli(args: &[String]) -> Result<Value, AppError> {
    let entry = resolve_sidecar_dist("cookies_cli.js")?;
    let workdir = sidecar_working_dir(&entry);
    let mut command = Command::new("node");
    command.arg(&entry).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console_window(&mut command);
    if let Some(dir) = workdir {
        command.current_dir(dir);
    }

    let mut child = command.spawn().map_err(|error| {
        AppError::Sidecar(format!("failed to spawn cookies_cli: {error}"))
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Sidecar("cookies_cli missing stdout".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Sidecar("cookies_cli missing stderr".to_owned()))?;

    // stderr 必须被消费：管道写满而无人读取会让子进程永久阻塞在写操作上
    let stderr_handle = std::thread::spawn(move || {
        let mut captured = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            captured.push_str(line.trim());
            captured.push('\n');
        }
        captured
    });

    let (tx, rx) = std::sync::mpsc::channel::<Result<Value, AppError>>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut last_ok: Option<Value> = None;
        let mut last_error: Option<String> = None;
        for line in reader.lines() {
            let Ok(line) = line else {
                continue;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let type_name = value.get("type").and_then(Value::as_str).unwrap_or("");
            if type_name == "error" || value.get("kind").and_then(Value::as_str) == Some("error") {
                last_error = Some(
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("cookies_cli failed")
                        .to_owned(),
                );
                continue;
            }
            if matches!(type_name, "cookie_export" | "cookie_import" | "cookie_parse") {
                last_ok = Some(value);
            }
        }
        if let Some(error) = last_error {
            let _ = tx.send(Err(AppError::Sidecar(error)));
        } else if let Some(value) = last_ok {
            let _ = tx.send(Ok(value));
        } else {
            let _ = tx.send(Err(AppError::Sidecar(
                "cookies_cli produced no result".to_owned(),
            )));
        }
    });

    // 有上限地等待退出：原先无上限的 child.wait() 会让下面的超时守卫永远够不到
    let status = wait_child_with_deadline(&mut child, COOKIE_CLI_TIMEOUT)
        .map_err(|error| AppError::Sidecar(format!("cookies_cli wait failed: {error}")))?;

    let stderr_text = stderr_handle.join().unwrap_or_default();
    if !stderr_text.trim().is_empty() {
        log_warn!("[cookie_ops] cookies_cli stderr: {}", stderr_text.trim());
    }

    let result = rx
        .recv_timeout(COOKIE_CLI_TIMEOUT)
        .map_err(|_| AppError::Sidecar("cookies_cli timed out".to_owned()))?;

    let value = result?;

    // 超时被强杀时无 ExitStatus：子进程可能已产出有效载荷后卡在退出阶段，
    // 保持与原「exitCode 置 1 但载荷有效」一致的宽容策略，但记警告不留静默。
    let Some(status) = status else {
        log_warn!("[cookie_ops] cookies_cli killed after timeout; using emitted payload if any");
        return Ok(value);
    };

    if !status.success() && value.get("type").and_then(Value::as_str) != Some("cookie_export") {
        // exitCode 可能在 emit 之后置 1；若已有成功 payload 仍接受
        if value.get("ok").and_then(Value::as_bool) != Some(true)
            && value.get("type").and_then(Value::as_str) != Some("cookie_import")
            && value.get("type").and_then(Value::as_str) != Some("cookie_export")
            && value.get("type").and_then(Value::as_str) != Some("cookie_parse")
        {
            return Err(AppError::Sidecar(format!(
                "cookies_cli exited with status {status}"
            )));
        }
    }
    Ok(value)
}

/// 把 Cookie 载荷写入临时文件。走 [`TempConfigFile`] 以复用统一的命名（含 PID + 序号，
/// 避免同毫秒并发导入互相覆盖）与 Drop 即删语义。
fn write_temp_payload(payload: &str) -> Result<crate::temp_config::TempConfigFile, AppError> {
    crate::temp_config::TempConfigFile::write("cookies", "payload", payload)
        .map_err(|error| AppError::Filesystem(format!("write temp cookies failed: {error}")))
}

/// 将任意 Cookie 文本解析为 Playwright JSON 数组字符串
fn normalize_cookie_payload(payload: &str) -> Result<String, AppError> {
    let temp = write_temp_payload(payload)?;
    // temp 在此作用域结束（含 `?` 早退）时由 Drop 删除
    let value = run_cookies_cli(&[
        "--mode=parse".to_owned(),
        temp.cli_arg("--payload-file="),
    ])?;
    let cookies = value
        .get("cookies")
        .cloned()
        .ok_or_else(|| AppError::Validation("failed to parse cookies".to_owned()))?;
    let count = value.get("count").and_then(Value::as_u64).unwrap_or(0);
    if count == 0 {
        return Err(AppError::Validation("未解析到任何 Cookie".to_owned()));
    }
    serde_json::to_string(&cookies).map_err(|error| AppError::Serialization(error.to_string()))
}

pub async fn export_profile_cookies(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: String,
    format: String,
) -> Result<CookieExportResult, AppError> {
    let _ = app;
    let numeric_id = parse_profile_id(&profile_id)?;
    let format = if format.trim().eq_ignore_ascii_case("netscape") {
        "netscape"
    } else {
        "json"
    };

    let cdp_port = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        if profile.status != "running" {
            return Err(AppError::Validation(
                "请先启动环境后再导出 Cookie（需 CDP 连接）".to_owned(),
            ));
        }
        profile
            .cdp_port
            .ok_or_else(|| AppError::Validation("profile has no cdp_port".to_owned()))? as u16
    };

    let value = run_cookies_cli(&[
        format!("--cdp-url=http://127.0.0.1:{cdp_port}"),
        "--mode=export".to_owned(),
        format!("--format={format}"),
    ])?;

    let count = value.get("count").and_then(Value::as_u64).unwrap_or(0) as u32;
    let content = if format == "netscape" {
        value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    } else {
        let cookies = value
            .get("cookies")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        serde_json::to_string_pretty(&cookies)
            .map_err(|error| AppError::Serialization(error.to_string()))?
    };

    Ok(CookieExportResult {
        format: format.to_owned(),
        count,
        content,
    })
}

pub async fn import_profile_cookies(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: String,
    payload: String,
) -> Result<CookieImportResult, AppError> {
    let numeric_id = parse_profile_id(&profile_id)?;
    let normalized = normalize_cookie_payload(&payload)?;
    let count = serde_json::from_str::<Vec<Value>>(&normalized)
        .map(|list| list.len() as u32)
        .unwrap_or(0);

    let (status, cdp_port) = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        (profile.status.clone(), profile.cdp_port.map(|port| port as u16))
    };

    if status == "running" {
        let port = cdp_port.ok_or_else(|| {
            AppError::Validation("running profile missing cdp_port".to_owned())
        })?;
        let temp = write_temp_payload(&normalized)?;
        let import_result = run_cookies_cli(&[
            format!("--cdp-url=http://127.0.0.1:{port}"),
            "--mode=import".to_owned(),
            temp.cli_arg("--payload-file="),
        ]);
        let _ = import_result?;
        // 清除可能残留的 pending 文件
        let pending = pending_cookies_path(app, &profile_id)?;
        if pending.exists() {
            let _ = std::fs::remove_file(&pending);
        }
        return Ok(CookieImportResult {
            count,
            applied_now: true,
            pending_path: None,
        });
    }

    // 未运行：写入 pending，下次 launchPersistentContext 后自动注入
    let user_dir = profile_user_data_dir(app, &profile_id)?;
    std::fs::create_dir_all(&user_dir)?;
    let pending = user_dir.join(PENDING_COOKIES_FILENAME);
    std::fs::write(&pending, &normalized).map_err(|error| {
        AppError::Filesystem(format!("failed to write pending cookies: {error}"))
    })?;

    Ok(CookieImportResult {
        count,
        applied_now: false,
        pending_path: Some(pending.to_string_lossy().to_string()),
    })
}
