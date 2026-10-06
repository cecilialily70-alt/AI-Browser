use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::fill_sidecar::{execute_direct_fill, execute_smart_fill, preview_hybrid_fill};
use crate::rpa_session::RpaSessionManager;
use crate::AppState;

pub const SIDECAR_LOG_EVENT: &str = "sidecar-log";

pub(crate) fn reject_if_rpa_engine_busy(
    manager: &RpaSessionManager,
    profile_id: &str,
) -> Result<(), AppError> {
    if manager.is_engine_busy(profile_id) {
        return Err(AppError::Validation(format!(
            "环境 #{profile_id} 正在运行 Agent/RPA/轨迹回放，请结束后再填表（Host 级 CDP 互斥）"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct SidecarLogPayload {
    pub line: String,
    pub parsed: Option<Value>,
}

pub fn parse_raw_fill_profile(raw: &str) -> Result<Map<String, Value>, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("fill profile input is empty".to_owned()));
    }

    if trimmed.starts_with('{') {
        let parsed = serde_json::from_str::<Value>(trimmed)?;
        if let Value::Object(map) = parsed {
            return Ok(map);
        }
        return Err(AppError::Validation("fill profile JSON must be an object".to_owned()));
    }

    let mut map = Map::new();
    for line in trimmed.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let (key, value) = if let Some((key, value)) = line.split_once(':') {
            (key.trim(), value.trim())
        } else if let Some((key, value)) = line.split_once('=') {
            (key.trim(), value.trim())
        } else if let Some((key, value)) = line.split_once('\t') {
            (key.trim(), value.trim())
        } else {
            continue;
        };

        if key.is_empty() || value.is_empty() {
            continue;
        }
        map.insert(key.to_owned(), Value::String(value.to_owned()));
    }

    if map.is_empty() {
        return Err(AppError::Validation(
            "could not parse fill profile; use JSON or key: value lines".to_owned(),
        ));
    }

    Ok(map)
}

pub fn emit_sidecar_line(app: &AppHandle, line: &str) {
    let parsed = serde_json::from_str::<Value>(line).ok();
    let payload = SidecarLogPayload {
        line: line.to_owned(),
        parsed,
    };
    let _ = app.emit(SIDECAR_LOG_EVENT, payload);
}

#[tauri::command]
pub async fn preview_ai_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    rpa_manager: State<'_, RpaSessionManager>,
    profile_id: String,
    raw_input: String,
) -> Result<String, AppError> {
    reject_if_rpa_engine_busy(&rpa_manager, &profile_id)?;
    preview_hybrid_fill(&app, &db_state, profile_id, raw_input).await
}

#[tauri::command]
pub async fn run_smart_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    rpa_manager: State<'_, RpaSessionManager>,
    profile_id: String,
    natural_language: String,
    seed_input: Option<String>,
    press_enter_after_fill: Option<bool>,
) -> Result<String, AppError> {
    reject_if_rpa_engine_busy(&rpa_manager, &profile_id)?;
    {
        let entitlement = crate::key_file::resolve_license_entitlement(&db_state).await?;
        let browser_version = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let numeric_id = crate::profile_id::parse_profile_id(&profile_id)?;
            crate::db::get_profile(&connection, numeric_id)?.browser_version
        };
        crate::kernel_policy::assert_ai_allowed_for_browser_version(
            entitlement.is_pro,
            &browser_version,
        )?;
    }
    execute_smart_fill(
        &app,
        &db_state,
        profile_id,
        natural_language,
        seed_input,
        press_enter_after_fill.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn run_direct_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    rpa_manager: State<'_, RpaSessionManager>,
    profile_id: String,
    raw_input: String,
    press_enter_after_fill: Option<bool>,
) -> Result<(), AppError> {
    reject_if_rpa_engine_busy(&rpa_manager, &profile_id)?;
    {
        let entitlement = crate::key_file::resolve_license_entitlement(&db_state).await?;
        let browser_version = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let numeric_id = crate::profile_id::parse_profile_id(&profile_id)?;
            crate::db::get_profile(&connection, numeric_id)?.browser_version
        };
        crate::kernel_policy::assert_ai_allowed_for_browser_version(
            entitlement.is_pro,
            &browser_version,
        )?;
    }
    execute_direct_fill(
        &app,
        &db_state,
        profile_id,
        raw_input,
        press_enter_after_fill.unwrap_or(false),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::parse_raw_fill_profile;

    #[test]
    fn parses_key_value_lines() {
        let map = parse_raw_fill_profile("email: a@b.com\nfullName: Alice").expect("parse");
        assert_eq!(map.get("email").and_then(|v| v.as_str()), Some("a@b.com"));
        assert_eq!(map.get("fullName").and_then(|v| v.as_str()), Some("Alice"));
    }
}
