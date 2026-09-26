//! N13 · 回放预检单（RunPlan）—— **干跑**，不碰浏览器、不写库（§4.6.6 / §4.6.7）。
//!
//! 为什么单独一个模块：预检单是「UI 与对外 API 共用同一份产物」的东西，
//! 它的输入是纯数据（轨迹步 + 环境 + 数据集 + 参数），输出是 `RunPlan` + `planHash`。
//! 执行阶段（`rpa_session::replay_agent_trajectory`）只认这里发出的 `planHash`。
//!
//! 风险判定（critical 步骤 / 凭证列名）**不在 Rust 里另写一套**：Host 跑不了 TS，
//! 所以经 Sidecar 一次性 CLI（`data_planner_cli.ts` 的 `replay_plan` 模式）调用
//! `core/hitl_policy.ts` 与 `core/dataset_parse.ts` 的同一条判定（§4.6.6 明文要求）。

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::error::AppError;
use crate::profile_id::parse_profile_id;
use crate::replay_job::{
    build_run_plan, PlanAllocationInput, PlanDatasetInput, PlanEdit, PlanEnvState, PlanInputs,
    PlanWarning, RiskReport, RunPlan,
};
use crate::{AppState, RpaSessionManager};

fn default_true() -> bool {
    true
}

fn default_repeat_count() -> u32 {
    1
}

/// 预检请求：与执行请求同构（§7.3.1），因此同一份前端状态既能出预检单也能执行。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPlanRequest {
    pub trajectory_id: Option<i64>,
    #[serde(default)]
    pub trajectory_title: String,
    /// 轨迹步。前端已解析好直接传；缺省时按 `trajectoryId` 从库读。
    #[serde(default)]
    pub actions: Option<Vec<Value>>,
    /// 轨迹目标（critical 判定只为日志可追溯：critical 不因目标豁免）
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub profile_ids: Vec<String>,
    #[serde(default = "default_repeat_count")]
    pub repeat_count: u32,
    #[serde(default)]
    pub dataset: PlanDatasetInput,
    /// 轨迹字段 key → 数据集列名
    #[serde(default)]
    pub field_map: BTreeMap<String, String>,
    #[serde(default)]
    pub allocation: PlanAllocationInput,
    #[serde(default = "default_true")]
    pub open_in_new_tab: bool,
    #[serde(default)]
    pub close_after: bool,
    #[serde(default)]
    pub stop_on_first_failure: bool,
    #[serde(default)]
    pub run_timeout_ms: Option<i64>,
    #[serde(default)]
    pub max_concurrency: Option<u32>,
    #[serde(default)]
    pub stagger_ms: Option<i64>,
    #[serde(default)]
    pub edits: Vec<PlanEdit>,
    #[serde(default)]
    pub job_title: Option<String>,
    #[serde(default)]
    pub run_seed: Option<i64>,
}

/// 列名：优先用请求里声明的，否则按数据行出现顺序推导（去重）
fn resolve_columns(dataset: &PlanDatasetInput) -> Vec<String> {
    if !dataset.columns.is_empty() {
        return dataset.columns.clone();
    }
    let mut columns: Vec<String> = Vec::new();
    for row in &dataset.rows {
        for key in row.keys() {
            if !columns.iter().any(|item| item == key) {
                columns.push(key.clone());
            }
        }
    }
    columns
}

/// 调 Sidecar 一次性 CLI 做风险判定。
///
/// 失败**不静默**：返回一条红条，让「预检失败」变成用户看得见、可修的状态，
/// 而不是「没扫到 critical 就等于没有 critical」（那会让 R2 的列名红线形同虚设）。
async fn scan_risks(actions: &[Value], columns: &[String], goal: &str) -> (RiskReport, Option<String>) {
    let config = serde_json::json!({
        "mode": "replay_plan",
        "actions": actions,
        "columns": columns,
        "goal": goal,
    });
    match crate::data_planner::invoke_data_planner_cli(&config, "replay_plan_result").await {
        Ok(raw) => match serde_json::from_value::<RiskReport>(raw) {
            Ok(report) => (report, None),
            Err(error) => (
                RiskReport::default(),
                Some(format!("预检风险判定结果无法解析：{error}")),
            ),
        },
        Err(error) => (
            RiskReport::default(),
            Some(format!(
                "预检风险判定失败（{}）：为避免漏判支付/凭证红线，本次不允许启动",
                error
            )),
        ),
    }
}

/// 生成 RunPlan（干跑）。**不启动任何页面、不占台账、不改环境状态**。
#[tauri::command]
pub async fn build_replay_run_plan(
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    request: ReplayPlanRequest,
) -> Result<RunPlan, AppError> {
    build_plan_from_request(&db_state, &manager, request).await
}

/// 预检单生成的**唯一实现**：Tauri 命令（UI）与外部 API（`/v1/replay/plan`）共用，
/// 保证「UI 与外部程序看到同一张表、同一个 `planHash`」（§4.6.6 / §7.3.1）。
pub async fn build_plan_from_request(
    db_state: &AppState,
    manager: &RpaSessionManager,
    request: ReplayPlanRequest,
) -> Result<RunPlan, AppError> {
    // ① 轨迹步：前端给就用前端的；只给了 id 就从库读（外部 API 走这条）
    let (actions, stored_title, stored_goal) = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let mut actions = request.actions.clone();
        let mut title = String::new();
        let mut goal = String::new();
        if let Some(id) = request.trajectory_id {
            let needs_load = actions.is_none();
            let trajectory = crate::db::get_agent_trajectory(&connection, id)?;
            title = trajectory.title.clone();
            goal = trajectory.goal.clone();
            if needs_load {
                actions = serde_json::from_str::<Value>(&trajectory.actions)
                    .ok()
                    .and_then(|value| value.as_array().cloned());
            }
        }
        (actions.unwrap_or_default(), title, goal)
    };

    // ② 环境状态：不运行 / 正忙都在预检阶段就变成红条（S5 互斥）
    let envs: Vec<PlanEnvState> = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let mut envs = Vec::with_capacity(request.profile_ids.len());
        for raw_id in &request.profile_ids {
            let id = parse_profile_id(raw_id)?;
            let profile = crate::db::get_profile(&connection, id)?;
            envs.push(PlanEnvState {
                env_id: profile.id.to_string(),
                name: profile.name.clone(),
                running: profile.status == "running",
                busy: manager.is_engine_busy(&profile.id.to_string()),
            });
        }
        envs
    };

    // ③ 剪贴板数据源（§4.4 / §6.1）：开局**读一次**系统剪贴板，冻结成单行数据集（列名 `text`）。
    //    内容只留在宿主内存快照里（§6.4：不入库、不入日志），预检单只带指纹与长度。
    let mut dataset = request.dataset.clone();
    let mut clipboard_text: Option<String> = None;
    let mut clipboard_error: Option<String> = None;
    if dataset.source.trim().eq_ignore_ascii_case("clipboard") {
        match crate::clipboard::hub().read_text() {
            Ok(text) => {
                let mut row = serde_json::Map::new();
                row.insert("text".to_owned(), Value::String(text.clone()));
                dataset.columns = vec!["text".to_owned()];
                dataset.rows = vec![row];
                clipboard_text = Some(text);
            }
            Err(error) => {
                // 读不到就如实报红条：**绝不**编造内容，也不静默退化成空数据集
                dataset.columns = vec!["text".to_owned()];
                dataset.rows.clear();
                clipboard_error = Some(error.reason());
            }
        }
    }

    // ④ 风险判定（Sidecar 同一条判定）
    let columns = resolve_columns(&dataset);
    let goal = if request.goal.trim().is_empty() {
        stored_goal
    } else {
        request.goal.clone()
    };
    let (risk, risk_error) = scan_risks(&actions, &columns, &goal).await;

    // ⑤ 组装输入 → 纯函数出表
    let inputs = PlanInputs {
        trajectory_id: request.trajectory_id,
        trajectory_title: if request.trajectory_title.trim().is_empty() {
            stored_title
        } else {
            request.trajectory_title.clone()
        },
        trajectory_steps: actions.len(),
        envs,
        repeat_count: request.repeat_count,
        dataset: PlanDatasetInput {
            source: dataset.source.clone(),
            columns,
            rows: dataset.rows.clone(),
            hash: None,
        },
        field_map: request.field_map.clone(),
        allocation: request.allocation.clone(),
        open_in_new_tab: request.open_in_new_tab,
        close_after: request.close_after,
        stop_on_first_failure: request.stop_on_first_failure,
        run_timeout_ms: request.run_timeout_ms,
        max_concurrency: request.max_concurrency,
        stagger_ms: request.stagger_ms,
        edits: request.edits.clone(),
        job_title: request.job_title.clone(),
        run_seed: request.run_seed,
    };

    let mut plan = build_run_plan(&inputs, &risk)?;
    // 快照按**预检单里的数据集指纹**索引：执行阶段凭它取回内容（两级指纹对齐）
    if let (Some(text), Some(hash)) = (clipboard_text.as_deref(), plan.dataset.hash.clone()) {
        crate::clipboard::hub().remember(&hash, text);
    }
    if let Some(message) = clipboard_error {
        let entry = PlanWarning {
            level: "red".to_owned(),
            code: "clipboard_unavailable".to_owned(),
            text: format!("剪贴板不可用：{message}"),
        };
        plan.errors.push(entry.clone());
        plan.warnings.push(entry);
        plan.ok = false;
    }
    if let Some(message) = risk_error {
        let entry = PlanWarning {
            level: "red".to_owned(),
            code: "risk_scan_failed".to_owned(),
            text: message,
        };
        plan.errors.push(entry.clone());
        plan.warnings.push(entry);
        plan.ok = false;
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn columns_fall_back_to_row_keys_in_order() {
        let dataset = PlanDatasetInput {
            source: "inline".to_owned(),
            columns: vec![],
            rows: vec![
                serde_json::from_value(json!({"email": "a", "name": "b"})).unwrap(),
                serde_json::from_value(json!({"name": "c", "phone": "d"})).unwrap(),
            ],
            hash: None,
        };
        assert_eq!(resolve_columns(&dataset), vec!["email", "name", "phone"]);
    }

    #[test]
    fn declared_columns_win_over_derived() {
        let dataset = PlanDatasetInput {
            source: "inline".to_owned(),
            columns: vec!["only".to_owned()],
            rows: vec![serde_json::from_value(json!({"email": "a"})).unwrap()],
            hash: None,
        };
        assert_eq!(resolve_columns(&dataset), vec!["only"]);
    }

    #[test]
    fn deserializes_frontend_payload() {
        let request: ReplayPlanRequest = serde_json::from_value(json!({
            "trajectoryId": 42,
            "trajectoryTitle": "注册流程",
            "profileIds": ["3", "5"],
            "repeatCount": 10,
            "dataset": { "source": "inline", "columns": ["email"], "rows": [{ "email": "a{{run.uniqueId}}@b.com" }] },
            "allocation": { "mode": "seq_interleave", "onExhausted": "error" },
            "edits": [{ "seq": 3, "useRecordIndex": 0 }],
            "closeAfter": false
        }))
        .expect("frontend payload must deserialize");
        assert_eq!(request.repeat_count, 10);
        assert!(request.open_in_new_tab, "默认每轮新标签（N4）");
        assert_eq!(request.edits.len(), 1);
        assert_eq!(request.dataset.rows.len(), 1);
    }
}
