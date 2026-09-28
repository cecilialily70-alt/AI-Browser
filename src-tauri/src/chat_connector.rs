//! 站点描述符（connector）管理：**总览 / 删除 / 学习当前站点**。
//!
//! 分工（§0.4 / §7.4）：
//!   - **总览与删除**走一次性 CLI（`chat_connector_cli.js`，无浏览器、无 AI）：
//!     描述符的合法性与文件名约定只有一套权威实现（`descriptor/registry.ts` + `discovery/learn.ts`），
//!     宿主**不重写**（坑族 J「前后端两套解析器分叉」）。
//!   - **学习**走已存在的 Sidecar 会话（要有活浏览器与 AI Key），Host 只做闸门与转发：
//!     ① 引擎互斥 ② 浏览器在跑 ③ 必须有 userDataDir（学来的东西必须落在该环境自己的目录里）
//!     ④ AI Key。学习**不是**值守片，因此不要求「聊天模式总开关」打开 —— 它是一次显式的用户动作，
//!     不注册任何定时器、不自动发送、不碰任何用户既有的会话内容（只读结构 + 写一份描述符文件）。
//!
//! 学习的终态由 Sidecar 的 `chat_learn_done` 行（带 `waitId`）结算；进度行不带 waitId，
//! 由 `rpa_session` 的 stdout 泵原样转发给「聊天」视图（§5.7）。

use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::process_win::{prepare_sidecar_command, run_child_with_deadline};
use crate::profile_id::parse_profile_id;
use crate::rpa_session::{RpaRunResult, RpaSessionManager};
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};
use crate::AppState;

/// 纯文件系统 CLI 的上限（不含任何网络等待，30s 已是极宽余量）。
const CONNECTOR_CLI_TIMEOUT: Duration = Duration::from_secs(30);
/// 学习一片的上限：采集 + 多轮模型调用 + 逐条自检 +（可选）写入自测。有界即可。
const CHAT_LEARN_RECV_TIMEOUT: Duration = Duration::from_secs(900);

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
                .unwrap_or("chat connector cli failed");
            return Err(AppError::Sidecar(message.to_owned()));
        }
    }
    Err(AppError::Sidecar(
        "chat connector cli finished without result".to_owned(),
    ))
}

/// 跑一次描述符 CLI（无浏览器）：`mode` 为 `report` / `delete`。
///
/// 阻塞调用必须放进 `spawn_blocking`：Tauri 的同步命令跑在主线程上，直接 spawn 子进程会把
/// 整个界面冻住（30s 的「转圈」其实就是 UI 卡死）。
async fn run_connector_cli(config: Value, expect_type: &str) -> Result<Value, AppError> {
    let entry = resolve_sidecar_dist("chat_connector_cli.js")?;
    let sidecar_dir = sidecar_working_dir(&entry);

    let config_file =
        crate::temp_config::TempConfigFile::write("chat-connector", "global", &config.to_string())
            .map_err(|error| {
                AppError::Sidecar(format!("failed to write connector config: {error}"))
            })?;

    let mut command = Command::new("node");
    command
        .arg(&entry)
        .arg(config_file.cli_arg("--config-file="));
    prepare_sidecar_command(&mut command);
    if let Some(dir) = sidecar_dir {
        command.current_dir(dir);
    }

    // `config_file` 是本函数的局部变量：它活到 child 结束之后才被 drop（临时配置读后即焚）
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_child_with_deadline(&mut command, CONNECTOR_CLI_TIMEOUT)
    })
    .await
    .map_err(|error| AppError::Sidecar(error.to_string()))?
    .map_err(|error| AppError::Sidecar(format!("failed to spawn connector cli: {error}")))?;

    let stdout = output.stdout_text();
    if let Ok(result) = extract_cli_result(&stdout, expect_type) {
        return Ok(result);
    }
    let stderr = output.stderr_text();
    if !stderr.trim().is_empty() {
        return Err(AppError::Sidecar(format!(
            "chat connector cli stderr: {}",
            stderr.trim()
        )));
    }
    Err(AppError::Sidecar(format!(
        "chat connector cli produced no result: {}",
        stdout.trim()
    )))
}

/// 站点支持总览：有哪些描述符（内置 / 学来的）、能力边界、为什么不可用、学到了什么。
///
/// **不需要浏览器**（纯文件系统 + 权威校验器），所以设置页在环境没启动时也能如实回答。
#[tauri::command]
pub async fn chat_connector_status(app: AppHandle, profile_id: String) -> Result<Value, AppError> {
    parse_profile_id(&profile_id)?;
    let user_data_dir = crate::fill_sidecar::resolve_profile_user_data_dir(&app, &profile_id)?;
    run_connector_cli(
        json!({
            "mode": "report",
            "userDataDir": user_data_dir.to_string_lossy(),
        }),
        "connector_report",
    )
    .await
}

/// 删除一个**学来的**描述符（内置的删不掉：升级会覆盖，删了也没意义）。
#[tauri::command]
pub async fn chat_connector_delete(
    app: AppHandle,
    profile_id: String,
    site_key: String,
) -> Result<Value, AppError> {
    parse_profile_id(&profile_id)?;
    let site_key = site_key.trim().to_owned();
    if site_key.is_empty() {
        return Err(AppError::Validation("缺少 site_key".to_owned()));
    }
    let user_data_dir = crate::fill_sidecar::resolve_profile_user_data_dir(&app, &profile_id)?;
    run_connector_cli(
        json!({
            "mode": "delete",
            "userDataDir": user_data_dir.to_string_lossy(),
            "siteKey": site_key,
        }),
        "connector_delete",
    )
    .await
}

/// 学习当前站点（长任务，一片完成）。
///
/// 闸门顺序固定，任何一条不过都**如实失败**，不放行半成品：
/// ① 互斥（S5：Agent / 回放 / 填表 / 值守在跑就不学）② 浏览器在跑（学习要看页面）
/// ③ userDataDir 存在（学来的描述符必须落在该环境自己的目录里，随环境删除一并清掉）
/// ④ AI Key 已配置（推断槽要花 token）。
#[tauri::command]
pub async fn chat_learn_site(
    app: AppHandle,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    url: Option<String>,
    site_label: Option<String>,
    self_test_contact: Option<Value>,
    slot: Option<String>,
    max_rounds: Option<u32>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let db_state = app.state::<AppState>();
    let browser_manager = app.state::<crate::browser_manager::BrowserManager>();

    if manager.is_engine_busy(&profile_id) {
        return Err(AppError::Validation(format!(
            "环境 #{profile_id} 正在运行 Agent / 轨迹回放 / 填表或聊天，请先让它结束（Host 级 CDP 互斥）"
        )));
    }
    if !browser_manager.is_running(&profile_id) {
        return Err(AppError::Validation(
            "站点学习需要该环境的浏览器正在运行：请先启动环境，并把要学习的会话页打开".to_owned(),
        ));
    }
    let user_data_dir = crate::fill_sidecar::resolve_profile_user_data_dir(&app, &profile_id)?;
    let bundle =
        crate::fill_sidecar::load_rpa_runtime_bundle(&db_state, &profile_id, "{}", true, None)
            .await?;
    let ai = bundle.ai_settings.ok_or_else(|| {
        AppError::Validation("AI API key is not configured in global settings".to_owned())
    })?;

    let mut command = json!({
        "command": "chat_learn_site",
        "profileId": profile_id,
        "ai": ai,
        "userDataDir": user_data_dir.to_string_lossy(),
    });
    if let Some(url) = url.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        command["url"] = json!(url);
    }
    if let Some(label) = site_label
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        command["siteLabel"] = json!(label);
    }
    if let Some(contact) = self_test_contact.as_ref().filter(|value| value.is_object()) {
        // 写入自测对象由用户显式给出（绝不猜「哪个人是自己」——猜错就是把测试消息发给真人）
        command["selfTestContact"] = contact.clone();
    }
    if slot.as_deref().map(str::trim) == Some("fast_text") {
        command["slot"] = json!("fast_text");
    }
    if let Some(rounds) = max_rounds {
        command["maxRounds"] = json!(rounds.clamp(1, 5));
    }

    manager
        .send_and_wait_with_timeout(
            &app,
            &db_state,
            &profile_id,
            command,
            true,
            CHAT_LEARN_RECV_TIMEOUT,
        )
        .await?
        .ok_or_else(|| AppError::Sidecar("site learn finished without terminal state".to_owned()))
}
