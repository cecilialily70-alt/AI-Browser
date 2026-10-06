use std::path::Path;
use std::process::Command;

use tauri::State;

use crate::error::AppError;
use crate::process_win::{prepare_sidecar_command, run_child_with_deadline, timeout_message};
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};

fn normalize_base_url(base_url: &str) -> Result<String, AppError> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("API base URL cannot be empty".to_owned()));
    }
    Ok(trimmed.trim_end_matches('/').to_owned())
}

#[tauri::command]
pub async fn test_ai_connection(base_url: String, api_key: String) -> Result<(), AppError> {
    let base_url = normalize_base_url(&base_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Validation("API key cannot be empty".to_owned()));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| AppError::Llm(error.to_string()))?;

    let response = client
        .get(format!("{base_url}/models"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| AppError::Llm(format!("AI connection request failed: {error}")))?;

    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "unable to read response body".to_owned());
    Err(AppError::Llm(format!(
        "AI connection test failed ({status}): {body}"
    )))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtpChannelTestResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

const OTP_PROBE_CLI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// P1.3：设置页测试邮箱 OTP 通道（IMAP LOGIN 或临时邮结构校验）
#[tauri::command]
pub async fn test_otp_channel(
    state: State<'_, crate::AppState>,
    channel_json: String,
    draft_secret: Option<String>,
) -> Result<OtpChannelTestResult, AppError> {
    let normalized = crate::db::normalize_otp_channel_json(&channel_json)?;
    if normalized.is_empty() || normalized == r#"{"type":"none"}"# {
        return Ok(OtpChannelTestResult {
            ok: false,
            message: "尚未配置邮箱通道".to_owned(),
            reason: Some("not_configured".to_owned()),
        });
    }

    let channel: serde_json::Value = serde_json::from_str(&normalized)
        .map_err(|error| AppError::Validation(format!("otp_channel JSON: {error}")))?;

    let draft = draft_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    let mut secrets_by_ref = serde_json::Map::new();
    if draft.is_none() {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        if let Some(revealed) = crate::db::reveal_otp_channel_secrets(&connection, &channel) {
            if let Some(obj) = revealed.as_object() {
                for (key, value) in obj {
                    if let Some(plain) = value.as_str().map(str::trim).filter(|v| !v.is_empty()) {
                        secrets_by_ref.insert(key.clone(), serde_json::Value::String(plain.to_owned()));
                    }
                }
            }
        }
    }

    let config = serde_json::json!({
        "channel": channel,
        "draftSecret": draft,
        "secretsByRef": serde_json::Value::Object(secrets_by_ref),
    });

    let entry = resolve_sidecar_dist("otp_probe_cli.js")?;
    let sidecar_dir = sidecar_working_dir(&entry);
    let config_file = crate::temp_config::TempConfigFile::write(
        "otp-probe",
        "channel",
        &config.to_string(),
    )
    .map_err(|error| AppError::Sidecar(format!("failed to write otp probe config: {error}")))?;

    let mut command = Command::new("node");
    command
        .arg(&entry)
        .arg(config_file.cli_arg("--config-file="));
    prepare_sidecar_command(&mut command);
    if let Some(dir) = sidecar_dir {
        command.current_dir(dir);
    }

    let output = tauri::async_runtime::spawn_blocking(move || {
        // TempConfigFile 必须活到子进程读完；移入闭包延长生命周期
        let _keep = config_file;
        run_child_with_deadline(&mut command, OTP_PROBE_CLI_TIMEOUT)
    })
    .await
    .map_err(|error| AppError::Sidecar(error.to_string()))?
    .map_err(|error| AppError::Sidecar(format!("failed to spawn otp probe: {error}")))?;

    let stdout = output.stdout_text();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let type_name = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if type_name == "otp_probe_result" {
            let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or(if ok { "连接成功" } else { "连接失败" })
                .to_owned();
            let reason = value
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            return Ok(OtpChannelTestResult { ok, message, reason });
        }
        if type_name == "error" {
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("otp probe failed")
                .to_owned();
            return Ok(OtpChannelTestResult {
                ok: false,
                message,
                reason: Some("error".to_owned()),
            });
        }
    }

    if output.status.is_none() {
        return Ok(OtpChannelTestResult {
            ok: false,
            message: timeout_message("邮箱通道测试", OTP_PROBE_CLI_TIMEOUT),
            reason: Some("timeout".to_owned()),
        });
    }

    let stderr = output.stderr_text();
    Ok(OtpChannelTestResult {
        ok: false,
        message: if stderr.trim().is_empty() {
            "邮箱通道测试未返回结果".to_owned()
        } else {
            format!("邮箱通道测试失败: {}", stderr.trim())
        },
        reason: Some("error".to_owned()),
    })
}

#[tauri::command]
pub fn test_cloak_path(path: String) -> Result<(), AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("CloakBrowser path cannot be empty".to_owned()));
    }

    let file_path = Path::new(trimmed);
    if !file_path.exists() {
        return Err(AppError::Validation(format!(
            "path does not exist: {trimmed}"
        )));
    }
    if !file_path.is_file() {
        return Err(AppError::Validation(format!(
            "path is not a file: {trimmed}"
        )));
    }

    #[cfg(windows)]
    {
        let extension = file_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .eq_ignore_ascii_case("exe");
        if !extension {
            return Err(AppError::Validation(
                "Windows CloakBrowser path must point to a .exe file".to_owned(),
            ));
        }
    }

    Ok(())
}
