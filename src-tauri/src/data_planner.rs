//! AI 多环境数据规划师 / 沙盘字段造数 — 调用 sidecar/dist/data_planner_cli.js（无需浏览器）

use std::process::Command;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::db;
use crate::error::AppError;
use crate::process_win::{prepare_sidecar_command, run_child_with_deadline, timeout_message};
use crate::profile_id::parse_profile_id;
use crate::proxy;
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};
use crate::AppState;

/// 单次沙盘造数 CLI 的上限。批量生成多行会多次调用 LLM，故给足余量；
/// 存在的意义是「有界」——无上限时挂死的脚本会把 UI 永久锁在 Loading。
const DATA_PLANNER_CLI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxMockFieldInput {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub current_value: String,
}

fn extract_cli_result(stdout: &str, expect_type: &str) -> Result<Value, AppError> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        if value.get("type").and_then(|entry| entry.as_str()) == Some(expect_type) {
            return Ok(value);
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("error") {
            let message = value
                .get("message")
                .and_then(|entry| entry.as_str())
                .unwrap_or("data planner failed");
            return Err(AppError::Llm(message.to_owned()));
        }

        if value.get("message").and_then(|entry| entry.as_str()) == Some("data_planner_failed") {
            let message = value
                .get("data")
                .and_then(|entry| entry.get("error"))
                .and_then(|entry| entry.as_str())
                .unwrap_or("data planner failed");
            return Err(AppError::Llm(message.to_owned()));
        }
    }

    Err(AppError::Llm(
        "data planner sidecar finished without result".to_owned(),
    ))
}

/// 复用点：回放预检单的 critical / 凭证列名判定也走这条一次性 CLI（`data_planner_cli.ts`）。
pub(crate) async fn invoke_data_planner_cli(config: &Value, expect_type: &str) -> Result<Value, AppError> {
    let entry = resolve_sidecar_dist("data_planner_cli.js")?;
    let sidecar_dir = sidecar_working_dir(&entry);

    let config_file = crate::temp_config::TempConfigFile::write(
        "data-planner",
        "global",
        &config.to_string(),
    )
    .map_err(|error| AppError::Sidecar(format!("failed to write planner config: {error}")))?;

    let mut command = Command::new("node");
    command
        .arg(&entry)
        .arg(config_file.cli_arg("--config-file="));
    prepare_sidecar_command(&mut command);

    if let Some(dir) = sidecar_dir {
        command.current_dir(dir);
    }

    let output = tauri::async_runtime::spawn_blocking(move || {
        run_child_with_deadline(&mut command, DATA_PLANNER_CLI_TIMEOUT)
    })
    .await
    .map_err(|error| AppError::Sidecar(error.to_string()))?
    .map_err(|error| AppError::Sidecar(format!("failed to spawn data planner: {error}")))?;

    let stdout = output.stdout_text();
    if let Ok(result) = extract_cli_result(&stdout, expect_type) {
        return Ok(result);
    }

    // 超时必须显式上报：否则用户看到的是「造数卡住」而非「已超时终止」
    if output.status.is_none() {
        return Err(AppError::Llm(timeout_message(
            "AI 造数",
            DATA_PLANNER_CLI_TIMEOUT,
        )));
    }

    let stderr = output.stderr_text();
    if !stderr.trim().is_empty() {
        return Err(AppError::Llm(format!(
            "data planner stderr: {}",
            stderr.trim()
        )));
    }

    Err(AppError::Llm(format!(
        "data planner exited with status {}: {}",
        output
            .status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "unknown".to_owned()),
        stdout.trim()
    )))
}

fn load_ai_settings_json(connection: &rusqlite::Connection) -> Result<Value, AppError> {
    let base_url = db::get_setting(connection, "deepseek_base_url")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://api.deepseek.com".to_owned());
    let agent_model = crate::fill_sidecar::resolve_stored_ai_agent_model(connection, &base_url)?;
    let agent_thinking_disabled =
        crate::fill_sidecar::model_disables_thinking_for_forced_tools(connection, &agent_model);
    let chat_model = crate::fill_sidecar::resolve_stored_ai_text_model(connection, &base_url)?;
    let vision_model =
        crate::fill_sidecar::resolve_stored_ai_vision_model_setting(connection, &base_url)?;
    let api_key = crate::fill_sidecar::resolve_stored_ai_api_key(connection, &base_url)?
        .or_else(|| std::env::var("ZAI_API_KEY").ok())
        .or_else(|| std::env::var("DEEPSEEK_API_KEY").ok())
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation("AI API key is not configured in global settings".to_owned())
        })?;

    Ok(json!({
        "apiKey": api_key,
        "apiBaseUrl": base_url,
        "textModel": agent_model,
        "agentModel": agent_model,
        "chatModel": chat_model,
        "visionModel": vision_model,
        "agentModelDisableThinking": agent_thinking_disabled,
    }))
}

async fn resolve_env_geo_persona(
    state: &AppState,
    env_id: &str,
    geo_hint: Option<Value>,
) -> Result<(Value, Value), AppError> {
    let numeric_id = parse_profile_id(env_id)?;
    let (persona_raw, proxy_input) = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        // 人设来源＝「规则」窗口里本环境启用的人设（环境人设列已下线，不再读 profiles.persona_data）
        let persona = db::resolve_agent_persona_for_profile(&connection, env_id)
            .unwrap_or(None)
            .unwrap_or(Value::Null);
        let proxy_input = proxy::proxy_resolution_input_from_profile(&connection, &profile)?;
        (persona, proxy_input)
    };

    if let Some(hint) = geo_hint.filter(|value| value.is_object()) {
        return Ok((hint, persona_raw));
    }

    if let Some(input) = proxy_input {
        if let Ok(resolved) = proxy::resolve_profile_proxy_input(input).await {
            if let Ok(env) = crate::ip_geo::resolve_proxy_egress_env(&resolved).await {
                return Ok((
                    json!({
                        "exitIp": env.exit_ip,
                        "timezone": env.timezone,
                        "locale": env.locale,
                        "latitude": env.latitude,
                        "longitude": env.longitude,
                        "countryCode": env.country_code,
                        "country": env.country,
                        "region": env.region,
                        "city": env.city,
                    }),
                    persona_raw,
                ));
            }
        }
    }

    Ok((Value::Null, persona_raw))
}

/// 多环境轨迹数据分配规划（LLM）— 返回 { summary, planMatrix }
#[tauri::command]
pub async fn plan_batch_replay_data(
    state: State<'_, AppState>,
    selectors: Vec<String>,
    env_ids: Vec<String>,
    user_prompt: String,
    file_data: Option<String>,
) -> Result<Value, AppError> {
    if selectors.is_empty() {
        return Err(AppError::Validation(
            "selectors 为空：轨迹中没有可分配的填表字段".to_owned(),
        ));
    }
    if env_ids.is_empty() {
        return Err(AppError::Validation(
            "请至少选择一个环境".to_owned(),
        ));
    }
    for env_id in &env_ids {
        parse_profile_id(env_id)?;
    }

    let ai_settings = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        load_ai_settings_json(&connection)?
    };

    let file_trimmed = file_data
        .map(|value| value.chars().take(120_000).collect::<String>())
        .filter(|value| !value.trim().is_empty());

    let config = json!({
        "mode": "plan_batch",
        "selectors": selectors,
        "envIds": env_ids,
        "userPrompt": user_prompt,
        "fileData": file_trimmed,
        "aiSettings": ai_settings,
    });

    let raw = invoke_data_planner_cli(&config, "data_planner_result").await?;
    Ok(json!({
        "summary": raw.get("summary").cloned().unwrap_or_else(|| json!("")),
        "planMatrix": raw.get("planMatrix").cloned().unwrap_or_else(|| json!([])),
    }))
}

/// 沙盘字段级 AI 造数（单环境，可单字段或整表）— 强制 sidecar fast_text
#[tauri::command]
pub async fn mock_sandbox_fields(
    state: State<'_, AppState>,
    env_id: String,
    fields: Vec<SandboxMockFieldInput>,
    only_keys: Option<Vec<String>>,
    geo_hint: Option<Value>,
    // 沙盘目标里 `@人设名` 引用的整套字段（`{{persona.*}}` 同源）；缺省回落旧数据
    persona: Option<Value>,
) -> Result<Value, AppError> {
    parse_profile_id(&env_id)?;
    if fields.is_empty() {
        return Err(AppError::Validation("fields 为空".to_owned()));
    }

    let ai_settings = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        load_ai_settings_json(&connection)?
    };

    let (geo, fallback_persona) = resolve_env_geo_persona(&state, &env_id, geo_hint).await?;
    // `@人设` 优先：用户明确点名的人设就是本次造数的身份来源，不再回落旧数据
    let persona = persona.filter(|value| value.is_object()).unwrap_or(fallback_persona);

    let field_json: Vec<Value> = fields
        .into_iter()
        .map(|field| {
            json!({
                "key": field.key,
                "label": field.label,
                "currentValue": field.current_value,
            })
        })
        .collect();

    let config = json!({
        "mode": "mock_fields",
        "envId": env_id,
        "fields": field_json,
        "onlyKeys": only_keys,
        "geo": geo,
        "persona": persona,
        "aiSettings": ai_settings,
    });

    let raw = invoke_data_planner_cli(&config, "field_mock_result").await?;
    Ok(json!({
        "envId": raw.get("envId").cloned().unwrap_or_else(|| json!(env_id)),
        "valueOverrides": raw.get("valueOverrides").cloned().unwrap_or_else(|| json!({})),
        "summary": raw.get("summary").cloned().unwrap_or_else(|| json!("")),
    }))
}
