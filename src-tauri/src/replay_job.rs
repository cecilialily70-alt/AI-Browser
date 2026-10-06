//! N12 · 回放台账与数据分配（执行计划 §5）。
//!
//! 三层结构：
//!  1. **静态序号**（确定性）：为每个 `(环境, 第几次)` 算出全局 `seq`，可预览、可复现、零协调；
//!  2. **台账租约**（韧性）：真实「领取」写入 Host SQLite，原子 + 租约 + fencing token，
//!     崩溃后可回收过期租约并按 `plan_json` 续跑；
//!  3. **生成种子**（无数据集时）：`seed = hash32(runSeed:envId:runIndex:fieldKey)`，值互不相同且可诊断。
//!
//! 纪律：
//!  - **唯一性只能由分配器保证，不能靠随机**（生日悖论，§5.8）——`unique_id` 由本模块按 `seq` 发号。
//!  - **执行阶段不再重新分配**：`replay_run` 的行直接来自冻结的 `plan_json`。
//!  - **重试复用同一 `record_index` / `unique_id`**（幂等）：`claim` 只递增 `attempt` 与 `lease_token`。
//!  - **两级指纹**：`dataset_hash`（只看数据）+ `plan_hash`（整张预检单）。执行只认 `plan_hash`。
//!
//! 写入方式：本模块只接受 `&Connection`，由调用方在 `AppState::database` 互斥锁内调用。
//! 不走 `db_write_queue`（那条队列满时会 Drop 命令，而领取/完成丢一条就等于台账撒谎）。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// 单环境回放标签硬上限（§4.1，与 sidecar `REPLAY_TAB_LIMIT` 同值）
pub const REPLAY_TAB_LIMIT: i64 = 20;
/// 单轮并发上限（§4.2）
pub const MAX_CONCURRENCY: u32 = 16;
/// 单环境轮次上限（§4.2）
pub const MAX_REPEAT_COUNT: u32 = 100;
/// 租约时长（秒）：领取后多久没心跳就算过期可回收
pub const LEASE_SECONDS: i64 = 120;
/// 数据行数上限（与 `sidecar/core/dataset_parse.ts` 同口径）
pub const DATASET_MAX_ROWS: usize = 2000;

/* ------------------------------------------------------------------ *
 * 分配模式
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllocMode {
    /// 默认：同一时刻在跑的浏览器拿相邻行（`seq = runIndex * E + envIndex`）
    SeqInterleave,
    /// 每个浏览器拿连续区块（`seq = envIndex * R + runIndex`）
    SeqBlock,
    /// 行由「先到先领」决定（序号仍按公式生成，用于台账/预览）
    Claim,
    /// 同 SeqInterleave，但允许 `N > M`（明确接受重复）
    Cycle,
    /// 无数据集：值由种子生成
    Generate,
}

impl AllocMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SeqInterleave => "seq_interleave",
            Self::SeqBlock => "seq_block",
            Self::Claim => "claim",
            Self::Cycle => "cycle",
            Self::Generate => "generate",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw.trim().to_lowercase().as_str() {
            "" | "seq_interleave" => Ok(Self::SeqInterleave),
            "seq_block" => Ok(Self::SeqBlock),
            "claim" => Ok(Self::Claim),
            "cycle" => Ok(Self::Cycle),
            "generate" => Ok(Self::Generate),
            other => Err(AppError::Validation(format!(
                "allocation.mode 不支持：{other}（可选 seq_interleave | seq_block | claim | cycle | generate）"
            ))),
        }
    }

    /// 是否按公式静态分配数据行（`claim` 由领取时刻决定）
    pub fn is_static_row(self) -> bool {
        !matches!(self, Self::Claim)
    }
}

/// 数据行不够时怎么办（**必须显式选择，不许静默**，§5.6）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnExhausted {
    /// 默认：不开跑，报错
    Error,
    /// 允许循环取用
    Cycle,
    /// 缺行的部分改成生成
    Generate,
}

impl OnExhausted {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Cycle => "cycle",
            Self::Generate => "generate",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw.trim().to_lowercase().as_str() {
            "" | "error" => Ok(Self::Error),
            "cycle" => Ok(Self::Cycle),
            "generate" => Ok(Self::Generate),
            other => Err(AppError::Validation(format!(
                "allocation.onExhausted 不支持：{other}（可选 error | cycle | generate）"
            ))),
        }
    }
}

/* ------------------------------------------------------------------ *
 * 第 1 层：静态分配（纯函数，便于穷举单测）
 * ------------------------------------------------------------------ */

/// 一轮的分配结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunAllocation {
    pub seq: i64,
    pub env_id: String,
    pub run_index: i64,
    /// 分配到的数据行号（`None` = 生成型）
    pub record_index: Option<i64>,
    /// 分配器发的唯一整数（= seq，job 内单调）
    pub unique_id: i64,
    /// 该行数据是否来自「循环复用」
    pub reused: bool,
}

/// 分配公式（§5.6）。`env_ids` 顺序即 `envIndex` 的取值顺序。
///
/// `dataset_size == 0` 或 `mode == Generate` → 全部走生成型（`record_index = None`）。
/// 调用方负责先做「行数够不够」的校验；本函数不做「该不该开跑」的判断（那是预检的事），
/// 但会如实标注 `reused`，让 UI 能把重复行亮出来。
pub fn build_allocations(
    env_ids: &[String],
    repeat_count: u32,
    dataset_size: usize,
    mode: AllocMode,
) -> Vec<RunAllocation> {
    let env_count = env_ids.len() as i64;
    let rounds = repeat_count as i64;
    let mut out = Vec::with_capacity((env_count * rounds).max(0) as usize);
    if env_count == 0 || rounds == 0 {
        return out;
    }

    for run_index in 0..rounds {
        for (env_index, env_id) in env_ids.iter().enumerate() {
            let env_index = env_index as i64;
            let seq = match mode {
                AllocMode::SeqBlock => env_index * rounds + run_index,
                // claim 的行归属由领取决定，但序号仍按交织公式生成（用于台账/预览）
                _ => run_index * env_count + env_index,
            };
            let record_index = if dataset_size == 0 || mode == AllocMode::Generate {
                None
            } else {
                Some(seq % dataset_size as i64)
            };
            let reused = match record_index {
                Some(_) => (seq as usize) >= dataset_size,
                None => false,
            };
            out.push(RunAllocation {
                seq,
                env_id: env_id.clone(),
                run_index,
                record_index,
                unique_id: seq,
                reused,
            });
        }
    }
    out.sort_by_key(|row| row.seq);
    out
}

/* ------------------------------------------------------------------ *
 * 预检单（Run Plan）
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanWarning {
    pub level: String,
    pub code: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanTab {
    /// new | reuse
    pub mode: String,
    pub close_after: bool,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanRecord {
    /// dataset | generate | clipboard
    pub source: String,
    pub index: Option<i64>,
    /// 插值后的关键字段（用户看到的就是将要填进去的值）
    pub preview: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    pub seq: i64,
    pub env_id: String,
    pub run_index: i64,
    pub unique_id: i64,
    pub skipped: bool,
    pub record: PlanRecord,
    pub tab: PlanTab,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanTotals {
    pub envs: i64,
    pub repeat_count: i64,
    pub total_runs: i64,
    pub planned_new_tabs: i64,
    pub max_concurrency: i64,
    pub stagger_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanDatasetInfo {
    pub source: String,
    pub size: i64,
    pub columns: Vec<String>,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanAllocation {
    pub mode: String,
    pub on_exhausted: String,
    pub run_seed: i64,
}

/// 预检单：既可渲染成表格，也是对外 API 契约（§4.6.3）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunPlan {
    pub ok: bool,
    pub plan_id: String,
    pub plan_hash: String,
    pub job_title: String,
    pub trajectory_id: Option<i64>,
    pub trajectory_title: String,
    pub totals: PlanTotals,
    pub dataset: PlanDatasetInfo,
    pub allocation: PlanAllocation,
    pub open_in_new_tab: bool,
    pub close_after: bool,
    pub stop_on_first_failure: bool,
    pub run_timeout_ms: i64,
    pub warnings: Vec<PlanWarning>,
    pub errors: Vec<PlanWarning>,
    pub rows: Vec<PlanRow>,
}

/// `plan_hash` 的规范化输入（§4.6.7）——**只覆盖会改变执行结果的东西**。
///
/// 注意：`plan_id` / `warnings` / `errors` / `job_title` **不进 hash**：
/// 它们不影响「跑什么」，改标题或补一条提醒不该让用户的确认失效。
fn canonical_plan_json(plan: &RunPlan) -> Value {
    let rows: Vec<Value> = plan
        .rows
        .iter()
        .map(|row| {
            json!({
                "seq": row.seq,
                "envId": row.env_id,
                "runIndex": row.run_index,
                "uniqueId": row.unique_id,
                "skipped": row.skipped,
                "recordSource": row.record.source,
                "recordIndex": row.record.index,
                "tabMode": row.tab.mode,
                "tabCloseAfter": row.tab.close_after,
            })
        })
        .collect();
    json!({
        "trajectoryId": plan.trajectory_id,
        "dataset": { "source": plan.dataset.source, "hash": plan.dataset.hash },
        "allocation": {
            "mode": plan.allocation.mode,
            "onExhausted": plan.allocation.on_exhausted,
            "runSeed": plan.allocation.run_seed,
        },
        "openInNewTab": plan.open_in_new_tab,
        "closeAfter": plan.close_after,
        "stopOnFirstFailure": plan.stop_on_first_failure,
        "runTimeoutMs": plan.run_timeout_ms,
        "maxConcurrency": plan.totals.max_concurrency,
        "staggerMs": plan.totals.stagger_ms,
        "rows": rows,
    })
}

/// 计算 `plan_hash`（sha256，带算法前缀）
pub fn compute_plan_hash(plan: &RunPlan) -> String {
    let canonical = canonical_plan_json(plan);
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string().as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

/// 重算并比对 `plan_hash`（§4.6.7 规则 2）。
///
/// 不一致 ⇒ 调用方必须返回 `409 plan_stale` 且**不启动任何东西**。
/// 空哈希同样视为不一致：没有预检单的执行请求一律拒绝。
pub fn verify_plan_hash(expected: &str, plan: &RunPlan) -> Result<(), AppError> {
    let expected = expected.trim();
    if expected.is_empty() {
        return Err(AppError::Validation(
            "缺少 planHash：必须先调用预检单（生成执行计划）并确认".to_owned(),
        ));
    }
    let actual = compute_plan_hash(plan);
    if !expected.eq_ignore_ascii_case(&actual) {
        return Err(AppError::Validation(format!(
            "预检单与当前数据/参数不一致（plan_stale）：期望 {expected}，实际 {actual}。请重新生成预检单并确认。"
        )));
    }
    Ok(())
}

/// 数据集内容指纹（`sha256:<hex>`）——与 `plan_hash` 是两层，不是重复（§5.4）
pub fn compute_dataset_hash(rows: &[Value]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(rows).unwrap_or_default().as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

/* ------------------------------------------------------------------ *
 * 预检单生成（build_run_plan）
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEnvState {
    pub env_id: String,
    #[serde(default)]
    pub name: String,
    /// 环境是否在运行（不运行 → 红条，禁止启动）
    #[serde(default)]
    pub running: bool,
    /// 环境是否正被其它引擎占用（S5 互斥 → 红条）
    #[serde(default)]
    pub busy: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanDatasetInput {
    /// `none` / `inline` / `clipboard`（`generate` 等价于 `none`）
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<serde_json::Map<String, Value>>,
    /// 前端不提供；由本模块计算（§4.6.7：不要自己拼 hash）
    #[serde(default)]
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanAllocationInput {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub on_exhausted: Option<String>,
    #[serde(default)]
    pub run_seed: Option<i64>,
}

/// 单元级手工修改（§4.6.5）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEdit {
    pub seq: i64,
    #[serde(default)]
    pub use_record_index: Option<i64>,
    #[serde(default)]
    pub skipped: Option<bool>,
    /// `dataset` / `generate` / `clipboard`
    #[serde(default)]
    pub record_source: Option<String>,
    /// `new` / `reuse` / `new_close`
    #[serde(default)]
    pub tab_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanInputs {
    #[serde(default)]
    pub trajectory_id: Option<i64>,
    #[serde(default)]
    pub trajectory_title: String,
    /// 步数（0 → 红条：轨迹没内容）
    #[serde(default)]
    pub trajectory_steps: usize,
    #[serde(default)]
    pub envs: Vec<PlanEnvState>,
    #[serde(default = "default_repeat_count")]
    pub repeat_count: u32,
    #[serde(default)]
    pub dataset: PlanDatasetInput,
    /// 轨迹字段 key → 数据集列名（空 → 不映射，仅生成型）
    #[serde(default)]
    pub field_map: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub allocation: PlanAllocationInput,
    #[serde(default = "default_true")]
    pub open_in_new_tab: bool,
    /// 跑完关上轮标签
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

fn default_true() -> bool {
    true
}

fn default_repeat_count() -> u32 {
    1
}

/// Sidecar 一次性 CLI（`replay_plan` 模式）返回的风险判定，原样反序列化。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiskReport {
    #[serde(default)]
    pub critical_steps: Vec<RiskStep>,
    #[serde(default)]
    pub column_refusals: Vec<RiskRefusal>,
    #[serde(default)]
    pub column_warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiskStep {
    #[serde(default)]
    pub index: i64,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub matched: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiskRefusal {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub reason: String,
}

/// 无外部随机源时给 `runSeed` 发一个值；**必须回传**给用户，否则整批不可复现诊断。
fn random_seed() -> i64 {
    use rand::Rng;
    rand::rng().random_range(100_000_000..=999_999_999)
}

pub fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buffer = vec![0_u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 数据集来源归一化：任何未知值都当 `none`（不是 `generate`，因为来源要写进台账）
fn normalize_dataset_source(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "inline" | "file" => "inline".to_owned(),
        "clipboard" => "clipboard".to_owned(),
        _ => "none".to_owned(),
    }
}

fn tab_label(mode: &str) -> &'static str {
    match mode {
        "reuse" => "复用当前标签",
        "new_close" => "新标签（跑完关）",
        _ => "新标签",
    }
}

/* ---------- 预览插值（`{{run.*}}` / `{{data.<列>}}`，单趟） ---------- */

fn preview_run_vars(row: &RunAllocation, job_id: &str) -> serde_json::Map<String, Value> {
    let mut vars = serde_json::Map::new();
    vars.insert("seq".to_owned(), json!(row.seq));
    vars.insert("index".to_owned(), json!(row.run_index));
    vars.insert("envId".to_owned(), json!(row.env_id));
    vars.insert("jobId".to_owned(), json!(job_id));
    vars.insert("uniqueId".to_owned(), json!(row.unique_id));
    vars.insert(
        "uniqueHex".to_owned(),
        json!(format!("{:08x}", row.unique_id)),
    );
    vars
}

fn lookup_var(
    path: &str,
    run: &serde_json::Map<String, Value>,
    data: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    let mut parts = path.splitn(2, '.');
    let root = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("");
    let value = match root {
        "run" => run.get(rest),
        "data" => data.and_then(|row| row.get(rest)),
        _ => None,
    }?;
    Some(match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

/// 单趟插值：与 Sidecar `interpolateTemplate` 一致 —— **替换出来的文本不再二次展开**。
///
/// 未知变量（`{{persona.*}}` / `{{geoip.*}}` / `{{clip.N}}`）在预览里**原样保留**：
/// 预览是「将要填进去的值」的近似，不该为了好看把不认识的东西抹成空串。
fn interpolate_preview(
    raw: &str,
    run: &serde_json::Map<String, Value>,
    data: Option<&serde_json::Map<String, Value>>,
) -> String {
    if !raw.contains("{{") {
        return raw.to_owned();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = after[..end].trim();
        match lookup_var(token, run, data) {
            Some(value) => out.push_str(&value),
            None => {
                out.push_str("{{");
                out.push_str(&after[..end]);
                out.push_str("}}");
            }
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// 逐轮插值「目标模板」：把 `{{run.*}}` / `{{data.<列>}}` 用**本轮**的行数据展开（§7.6）。
///
/// 为什么必须逐轮：数据集驱动的回放，每轮填的是不同的变量值；若目标文本还停在录制时的旧词，
/// AI 交付会按旧目标判定，出现「填了新值、却按旧目标判错」。展开规则与预检单预览同源
/// （同一套 `interpolate_preview`），保证「看到的 == 跑到的」。
///
/// 数据行为空（生成型轮次）时残留的 `{{data.*}}` 一律抹成空串 —— 目标文本会喂给交付判定，
/// 不能把模板语法原样留给模型。`{{persona.*}}` / `{{geoip.*}}` 保持原样，交给既有的 Sidecar 口径。
pub(crate) fn interpolate_plan_row_goal(
    template: &str,
    row: &PlanRow,
    job_id: &str,
    data_row: Option<&serde_json::Map<String, Value>>,
) -> String {
    if template.trim().is_empty() || !template.contains("{{") {
        return template.to_owned();
    }
    let mut run = serde_json::Map::new();
    run.insert("seq".to_owned(), json!(row.seq));
    run.insert("index".to_owned(), json!(row.run_index));
    run.insert("envId".to_owned(), json!(row.env_id));
    run.insert("jobId".to_owned(), json!(job_id));
    run.insert("uniqueId".to_owned(), json!(row.unique_id));
    run.insert(
        "uniqueHex".to_owned(),
        json!(format!("{:08x}", row.unique_id)),
    );
    strip_data_tokens(&interpolate_preview(template, &run, data_row))
}

/// 抹掉未展开的 `{{data.*}}`；其它未知变量原样保留（与预览口径一致）。
fn strip_data_tokens(text: &str) -> String {
    if !text.contains("{{") {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = after[..end].trim();
        if token != "data" && !token.starts_with("data.") {
            out.push_str("{{");
            out.push_str(&after[..end]);
            out.push_str("}}");
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// 红条：同时进 `errors`（启动闸门）与 `warnings`（用户可见清单）。
fn push_error(
    code: &str,
    text: String,
    errors: &mut Vec<PlanWarning>,
    warnings: &mut Vec<PlanWarning>,
) {
    let entry = PlanWarning {
        level: "red".to_owned(),
        code: code.to_owned(),
        text,
    };
    errors.push(entry.clone());
    warnings.push(entry);
}

/// 生成预检单（§4.6.3）。纯函数：不碰浏览器、不写库、不读时钟（`runSeed` 由调用方补齐）。
pub fn build_run_plan(inputs: &PlanInputs, risk: &RiskReport) -> Result<RunPlan, AppError> {
    let mode = AllocMode::parse(inputs.allocation.mode.as_deref().unwrap_or(""))?;
    let on_exhausted = OnExhausted::parse(inputs.allocation.on_exhausted.as_deref().unwrap_or(""))?;
    let run_seed = inputs
        .allocation
        .run_seed
        .or(inputs.run_seed)
        .unwrap_or_else(random_seed);
    let source = normalize_dataset_source(&inputs.dataset.source);
    // `clipboard` 是「开局读一次的**单行数据集**」（§4.4）：Host 已把它读成 `[{ text }]` 传进来，
    // 与 inline 同样参与分配与指纹；区别只在预览要打码、且"多轮共用同一行"是**设计如此**。
    let is_clipboard = source == "clipboard";
    let dataset_rows: &[serde_json::Map<String, Value>] =
        if source == "inline" || is_clipboard {
            &inputs.dataset.rows
        } else {
            &[]
        };
    let dataset_size = dataset_rows.len();
    let env_ids: Vec<String> = inputs.envs.iter().map(|env| env.env_id.clone()).collect();
    let repeat_count = inputs.repeat_count.clamp(1, MAX_REPEAT_COUNT);
    let max_concurrency = inputs
        .max_concurrency
        .unwrap_or(4)
        .clamp(1, MAX_CONCURRENCY) as i64;
    let stagger_ms = inputs.stagger_ms.unwrap_or(300).clamp(0, 60_000);
    let run_timeout_ms = inputs.run_timeout_ms.unwrap_or(600_000).clamp(1_000, 3_600_000);

    let plan_id = format!("plan-{}", random_hex(8));
    let job_id = plan_id.clone();

    // ① 静态分配（确定性；执行阶段不再重跑）
    let mut allocations = build_allocations(&env_ids, repeat_count, dataset_size, mode);

    // ② 「数据不够时怎么办」在这里落地（§5.6）：cycle=循环并标注；generate=缺行改生成
    //
    // 判据是**序号**而非行号：静态分配的行号是 `seq % M`，所以「行不够」等价于 `seq >= M`，
    // 也就是 `build_allocations` 已经标出的 `reused`。用行号判断会永远为假（行号必然 < M）。
    if mode != AllocMode::Generate {
        for row in allocations.iter_mut() {
            if !row.reused {
                continue;
            }
            // 剪贴板快照本来就是「一份值给所有轮次」：不算「数据不够」，也不触发补齐/循环改造
            if is_clipboard {
                row.reused = false;
                continue;
            }
            match on_exhausted {
                // 循环取用：保持 `seq % M`，`reused` 保留（黄条会列出被共用的行）
                OnExhausted::Cycle => {}
                // 生成补齐：缺的轮次改为生成型
                OnExhausted::Generate => {
                    row.record_index = None;
                    row.reused = false;
                }
                // 报错不开跑：红条已在下面产出，这里不改分配
                OnExhausted::Error => {}
            }
        }
    }

    // ③ 行级手工修改
    for edit in &inputs.edits {
        let Some(row) = allocations.iter_mut().find(|row| row.seq == edit.seq) else {
            continue;
        };
        if let Some(index) = edit.use_record_index {
            row.record_index = Some(index);
        }
        // 显式选行优先于「恢复成默认行」：前端选「第 N 行」时会同时带上 recordSource=dataset，
        // 若不设这道闸，`seq % M` 会把用户刚选的行号覆盖掉。
        if let Some(source) = edit.record_source.as_deref() {
            if edit.use_record_index.is_some() && source.trim().eq_ignore_ascii_case("dataset") {
                // 已按显式行号处理，跳过
            } else {
                match source.trim().to_lowercase().as_str() {
                    "generate" => row.record_index = None,
                    "clipboard" => row.record_index = None,
                    "dataset" => {
                        if dataset_size > 0 {
                            row.record_index = Some(row.seq % dataset_size as i64);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let mut errors: Vec<PlanWarning> = Vec::new();
    let mut warnings: Vec<PlanWarning> = Vec::new();

    // ④ 环境可用性（S5：不运行 / 正忙都禁止启动）
    if inputs.envs.is_empty() {
        push_error(
            "no_env",
            "未选择任何环境".to_owned(),
            &mut errors,
            &mut warnings,
        );
    }
    for env in &inputs.envs {
        let label = if env.name.trim().is_empty() {
            format!("#{}", env.env_id)
        } else {
            format!("#{} {}", env.env_id, env.name)
        };
        if !env.running {
            push_error(
                "env_not_running",
                format!("环境 {label} 未运行：请先启动浏览器"),
                &mut errors,
                &mut warnings,
            );
        } else if env.busy {
            push_error(
                "env_busy",
                format!("环境 {label} 正忙（Agent / 填表 / 其它回放）：请先停止或等待"),
                &mut errors,
                &mut warnings,
            );
        }
    }

    // ⑤ 轨迹
    if inputs.trajectory_steps == 0 {
        push_error(
            "empty_trajectory",
            "轨迹不存在或没有任何步骤".to_owned(),
            &mut errors,
            &mut warnings,
        );
    }

    // ⑥ 数据行够不够（显式策略，绝不静默）
    let required = allocations.len() as i64;
    if !is_clipboard && mode != AllocMode::Generate && dataset_size > 0 && required > dataset_size as i64 {
        match on_exhausted {
            OnExhausted::Error => push_error(
                "not_enough_rows",
                format!(
                    "需要 {required} 行数据，数据集只有 {dataset_size} 行，且「数据不足时」= 报错不开跑"
                ),
                &mut errors,
                &mut warnings,
            ),
            OnExhausted::Cycle => warnings.push(PlanWarning {
                level: "yellow".to_owned(),
                code: "rows_cycled".to_owned(),
                text: format!(
                    "数据行不够（需要 {required} / 只有 {dataset_size}）→ 已按「循环取用」处理，部分行会被多轮共用"
                ),
            }),
            OnExhausted::Generate => warnings.push(PlanWarning {
                level: "yellow".to_owned(),
                code: "rows_generated".to_owned(),
                text: format!(
                    "数据行不够（需要 {required} / 只有 {dataset_size}）→ 缺的 {} 轮改为生成型",
                    required - dataset_size as i64
                ),
            }),
        }
    }

    // ⑥-b 数据集有数据却没有任何「变量 → 字段」映射：用户以为换了值，实际一个字段都没替换。
    // 这是最容易「看着跑了、其实没生效」的情形，必须变成看得见的黄条（不静默）。
    if !is_clipboard
        && mode != AllocMode::Generate
        && dataset_size > 0
        && inputs.field_map.is_empty()
    {
        warnings.push(PlanWarning {
            level: "yellow".to_owned(),
            code: "dataset_unmapped".to_owned(),
            text: format!(
                "数据集已载入 {dataset_size} 行，但没有「变量 → 字段」映射：本轮不会替换任何字段\
（除非固定值里显式引用了行数据变量），请回沙盘选择「变量 → 字段」映射"
            ),
        });
    }

    // ⑦ 数据集列名红线（Sidecar 判定，R2 / §1.3）
    for refusal in &risk.column_refusals {
        push_error(
            "sensitive_column",
            format!(
                "数据集列名「{}」命中一次性凭证词表（{}）：请改列名或改人工确认（R2）",
                refusal.name, refusal.reason
            ),
            &mut errors,
            &mut warnings,
        );
    }
    for warning in &risk.column_warnings {
        warnings.push(PlanWarning {
            level: "yellow".to_owned(),
            code: "column_warning".to_owned(),
            text: warning.clone(),
        });
    }

    // ⑧ 轨迹含 critical 步骤：不拦，但必须明示会停在人工确认（R1）
    if let Some(first) = risk.critical_steps.first() {
        let detail = if risk.critical_steps.len() > 1 {
            format!(
                "等 {} 处，最早一处是第 {} 步：{}",
                risk.critical_steps.len(),
                first.index + 1,
                first.label
            )
        } else {
            format!("第 {} 步：{}", first.index + 1, first.label)
        };
        warnings.push(PlanWarning {
            level: "yellow".to_owned(),
            code: "critical_steps".to_owned(),
            text: format!(
                "轨迹含 critical 步骤（{detail}）→ 执行时会停在人工确认，不会无人支付（R1）"
            ),
        });
    }

    // ⑨ 行级修改越界
    for edit in &inputs.edits {
        if let Some(index) = edit.use_record_index {
            if dataset_size == 0 || index < 0 || index >= dataset_size as i64 {
                push_error(
                    "record_index_out_of_range",
                    format!(
                        "第 {} 轮指定的数据行 {index} 超出范围（数据集共 {dataset_size} 行）",
                        edit.seq + 1
                    ),
                    &mut errors,
                    &mut warnings,
                );
            }
        }
    }

    // ⑩ 行 → PlanRow（含预览与标签策略）
    let edits_by_seq: std::collections::HashMap<i64, &PlanEdit> =
        inputs.edits.iter().map(|edit| (edit.seq, edit)).collect();
    let mut rows: Vec<PlanRow> = Vec::with_capacity(allocations.len());
    for alloc in &allocations {
        let edit = edits_by_seq.get(&alloc.seq).copied();
        let skipped = edit.and_then(|edit| edit.skipped).unwrap_or(false);

        let (record_source, record_index) = if is_clipboard {
            // 剪贴板：来源标成 clipboard 让 UI 能显示「剪贴板快照」，
            // 行号仍取分配结果（= 0），执行阶段据此从单行数据集里取值
            ("clipboard".to_owned(), alloc.record_index)
        } else if alloc.record_index.is_some() {
            ("dataset".to_owned(), alloc.record_index)
        } else {
            ("generate".to_owned(), None)
        };
        let record_source = edit
            .and_then(|edit| edit.record_source.as_deref())
            .map(|raw| raw.trim().to_lowercase())
            .filter(|raw| !raw.is_empty())
            .unwrap_or(record_source);
        let record_index = if record_source == "dataset" || record_source == "clipboard" {
            record_index
        } else {
            None
        };

        let tab_mode = edit
            .and_then(|edit| edit.tab_mode.as_deref())
            .map(|raw| raw.trim().to_lowercase())
            .filter(|raw| !raw.is_empty())
            .unwrap_or_else(|| {
                if !inputs.open_in_new_tab {
                    "reuse".to_owned()
                } else if inputs.close_after {
                    "new_close".to_owned()
                } else {
                    "new".to_owned()
                }
            });

        let run_vars = preview_run_vars(alloc, &job_id);
        let data_row = record_index.and_then(|index| dataset_rows.get(index as usize));
        let mut preview = serde_json::Map::new();
        if record_source == "dataset" {
            let columns: Vec<&String> = if inputs.dataset.columns.is_empty() {
                data_row.map(|row| row.keys().collect()).unwrap_or_default()
            } else {
                inputs.dataset.columns.iter().collect()
            };
            for column in columns {
                let raw = data_row
                    .and_then(|row| row.get(column))
                    .map(|value| match value {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default();
                preview.insert(
                    column.clone(),
                    Value::String(interpolate_preview(&raw, &run_vars, data_row)),
                );
            }
        } else if record_source == "clipboard" {
            // §6.4：剪贴板内容**不入台账/日志/回执** —— 预览只给长度，值只在执行时使用。
            let length = data_row
                .and_then(|row| row.get("text"))
                .and_then(|value| value.as_str())
                .map(|text| text.chars().count())
                .unwrap_or(0);
            preview.insert(
                "text".to_owned(),
                Value::String(format!("剪贴板快照 · {length} 字符（值不入库）")),
            );
        } else {
            preview.insert(
                "seed".to_owned(),
                Value::String(format!("{run_seed} · 唯一序号 {}", alloc.unique_id)),
            );
        }

        rows.push(PlanRow {
            seq: alloc.seq,
            env_id: alloc.env_id.clone(),
            run_index: alloc.run_index,
            unique_id: alloc.unique_id,
            skipped,
            record: PlanRecord {
                source: record_source,
                index: record_index,
                preview,
            },
            tab: PlanTab {
                mode: tab_mode.clone(),
                close_after: tab_mode == "new_close",
                label: tab_label(&tab_mode).to_owned(),
            },
        });
    }

    // ⑪ 复用提醒：同一数据行被多轮使用 —— 允许，但必须看得见
    let mut used_by: std::collections::BTreeMap<i64, Vec<i64>> = std::collections::BTreeMap::new();
    for row in &rows {
        if row.skipped {
            continue;
        }
        // 剪贴板快照是单行共用，属设计如此；本来就会刷屏，不再重复提醒
        if row.record.source == "clipboard" {
            continue;
        }
        if let Some(index) = row.record.index {
            used_by.entry(index).or_default().push(row.seq);
        }
    }
    for (index, seqs) in used_by.iter() {
        if seqs.len() <= 1 {
            continue;
        }
        let label = seqs
            .iter()
            .map(|seq| format!("第 {} 轮", seq + 1))
            .collect::<Vec<_>>()
            .join("、");
        warnings.push(PlanWarning {
            level: "yellow".to_owned(),
            code: "record_reused".to_owned(),
            text: format!("数据行 {} 被 {label} 共用", index + 1),
        });
    }

    let total_runs = rows.iter().filter(|row| !row.skipped).count() as i64;
    let planned_new_tabs = rows
        .iter()
        .filter(|row| !row.skipped && row.tab.mode != "reuse")
        .count() as i64;

    // ⑫ 标签上限（不静默）：超出即提示会被截断
    if planned_new_tabs > REPLAY_TAB_LIMIT {
        warnings.push(PlanWarning {
            level: "yellow".to_owned(),
            code: "tab_limit".to_owned(),
            text: format!(
                "计划新建 {planned_new_tabs} 个标签，超过单环境上限 {REPLAY_TAB_LIMIT}：超出的轮次会复用/回收标签（不会静默）"
            ),
        });
    }
    if dataset_size > 0 && total_runs > 0 && dataset_size as i64 > total_runs * 2 {
        warnings.push(PlanWarning {
            level: "yellow".to_owned(),
            code: "dataset_sparse_use".to_owned(),
            text: format!("数据集有 {dataset_size} 行，本次只用 {total_runs} 行，其余不会被执行"),
        });
    }

    let dataset_hash = inputs.dataset.hash.clone().or_else(|| {
        if dataset_size == 0 {
            None
        } else {
            Some(compute_dataset_hash(
                &inputs
                    .dataset
                    .rows
                    .iter()
                    .map(|row| Value::Object(row.clone()))
                    .collect::<Vec<_>>(),
            ))
        }
    });

    let job_title = inputs.job_title.clone().unwrap_or_else(|| {
        format!(
            "{} · {} 环境 × {} 轮",
            if inputs.trajectory_title.trim().is_empty() {
                "轨迹回放"
            } else {
                inputs.trajectory_title.trim()
            },
            inputs.envs.len(),
            repeat_count
        )
    });

    let mut plan = RunPlan {
        ok: errors.is_empty(),
        plan_id,
        plan_hash: String::new(),
        job_title,
        trajectory_id: inputs.trajectory_id,
        trajectory_title: inputs.trajectory_title.clone(),
        totals: PlanTotals {
            envs: inputs.envs.len() as i64,
            repeat_count: repeat_count as i64,
            total_runs,
            planned_new_tabs,
            max_concurrency,
            stagger_ms,
        },
        dataset: PlanDatasetInfo {
            source,
            size: dataset_size as i64,
            columns: inputs.dataset.columns.clone(),
            hash: dataset_hash,
        },
        allocation: PlanAllocation {
            mode: mode.as_str().to_owned(),
            on_exhausted: on_exhausted.as_str().to_owned(),
            run_seed,
        },
        open_in_new_tab: inputs.open_in_new_tab,
        close_after: inputs.close_after,
        stop_on_first_failure: inputs.stop_on_first_failure,
        run_timeout_ms,
        warnings,
        errors,
        rows,
    };
    plan.plan_hash = compute_plan_hash(&plan);
    Ok(plan)
}

/// 从 `plan_json` 里取某一轮：执行阶段按表取行，**不再重跑分配器**（§4.6.7）。
pub fn find_plan_row(plan: &RunPlan, seq: i64) -> Option<&PlanRow> {
    plan.rows.iter().find(|row| row.seq == seq)
}

/// 预检单涉及的环境（按首次出现顺序）。
///
/// 台账的 `env_ids`、对外 API 的派发名单、`GET /v1/replay/{jobId}` 的环境分组都以它为准 ——
/// 三处必须完全一致，否则会出现「进度里少一个环境」这类对不上账的事。
pub fn plan_env_ids(plan: &RunPlan, extra_env_id: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for row in &plan.rows {
        if !ids.iter().any(|existing| existing == &row.env_id) {
            ids.push(row.env_id.clone());
        }
    }
    if let Some(extra) = extra_env_id {
        let extra = extra.trim();
        if !extra.is_empty() && !ids.iter().any(|existing| existing == extra) {
            ids.push(extra.to_owned());
        }
    }
    ids
}

/// 预检单里的执行选项（存 `replay_job.options_json`）——UI 与对外 API 共用同一份投影。
pub fn plan_options_json(plan: &RunPlan) -> String {    json!({
        "closeAfter": plan.close_after,
        "stopOnFirstFailure": plan.stop_on_first_failure,
        "runTimeoutMs": plan.run_timeout_ms,
        "maxConcurrency": plan.totals.max_concurrency,
        "staggerMs": plan.totals.stagger_ms,
    })
    .to_string()
}

/* ------------------------------------------------------------------ *
 * 台账：写入
 * ------------------------------------------------------------------ */

pub struct NewJobInput<'a> {
    pub job_id: &'a str,
    pub title: &'a str,
    pub trajectory_id: Option<i64>,
    pub env_ids: &'a [String],
    pub repeat_count: u32,
    pub total_runs: i64,
    pub dataset_source: &'a str,
    pub dataset_ref: Option<&'a str>,
    pub dataset_size: i64,
    pub dataset_hash: Option<&'a str>,
    pub alloc_mode: AllocMode,
    pub run_seed: i64,
    pub open_in_new_tab: bool,
    pub plan_id: &'a str,
    pub plan_hash: &'a str,
    pub plan_json: &'a str,
    pub options_json: &'a str,
}

/// 落一个 job + **整张** `plan_json` 的每一轮（执行阶段不再重新分配）。
///
/// `skipped` 的轮次按定义「不入台账、不开标签」，所以只写未跳过的行。
pub fn insert_job(
    connection: &Connection,
    input: &NewJobInput<'_>,
    plan: &RunPlan,
) -> Result<(), AppError> {
    let env_ids_json = serde_json::to_string(input.env_ids)
        .map_err(|error| AppError::State(format!("serialize env_ids failed: {error}")))?;
    connection.execute(
        "INSERT INTO replay_job (
            job_id, title, trajectory_id, env_ids, repeat_count, total_runs,
            dataset_source, dataset_ref, dataset_size, dataset_hash, alloc_mode, run_seed,
            open_in_new_tab, plan_id, plan_hash, plan_json, options_json, status, created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'running',datetime('now'))",
        params![
            input.job_id,
            input.title,
            input.trajectory_id,
            env_ids_json,
            input.repeat_count as i64,
            input.total_runs,
            input.dataset_source,
            input.dataset_ref,
            input.dataset_size,
            input.dataset_hash,
            input.alloc_mode.as_str(),
            input.run_seed,
            if input.open_in_new_tab { 1 } else { 0 },
            input.plan_id,
            input.plan_hash,
            input.plan_json,
            input.options_json,
        ],
    )?;

    let mut statement = connection.prepare(
        "INSERT INTO replay_run (
            job_id, seq, env_id, run_index, record_index, attempt, status,
            lease_token, unique_id, skipped, tab_mode, tab_close_after
         ) VALUES (?1,?2,?3,?4,?5,0,'pending',0,?6,0,?7,?8)",
    )?;
    for row in &plan.rows {
        if row.skipped {
            continue;
        }
        statement.execute(params![
            input.job_id,
            row.seq,
            row.env_id,
            row.run_index,
            row.record.index,
            row.unique_id,
            row.tab.mode,
            if row.tab.close_after { 1 } else { 0 },
        ])?;
    }
    Ok(())
}

/// 幂等落库（多个环境的命令会并发调用）：job 已存在则不动，行用 `INSERT OR IGNORE`。
///
/// 为什么不用事务包住：SQLite 单连接已在 `AppState::database` 互斥锁内串行，
/// 而「先 INSERT OR IGNORE 再逐行 INSERT OR IGNORE」天然可重入 —— 崩溃重启再调一次也不会重复。
pub fn insert_job_if_absent(
    connection: &Connection,
    input: &NewJobInput<'_>,
    plan: &RunPlan,
) -> Result<bool, AppError> {
    let created = connection.execute(
        "INSERT OR IGNORE INTO replay_job (
            job_id, title, trajectory_id, env_ids, repeat_count, total_runs,
            dataset_source, dataset_ref, dataset_size, dataset_hash, alloc_mode, run_seed,
            open_in_new_tab, plan_id, plan_hash, plan_json, options_json, status, created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'running',datetime('now'))",
        params![
            input.job_id,
            input.title,
            input.trajectory_id,
            serde_json::to_string(input.env_ids).unwrap_or_else(|_| "[]".to_owned()),
            input.repeat_count as i64,
            input.total_runs,
            input.dataset_source,
            input.dataset_ref,
            input.dataset_size,
            input.dataset_hash,
            input.alloc_mode.as_str(),
            input.run_seed,
            if input.open_in_new_tab { 1 } else { 0 },
            input.plan_id,
            input.plan_hash,
            input.plan_json,
            input.options_json,
        ],
    )?;

    let mut statement = connection.prepare(
        "INSERT OR IGNORE INTO replay_run (
            job_id, seq, env_id, run_index, record_index, attempt, status,
            lease_token, unique_id, skipped, tab_mode, tab_close_after
         ) VALUES (?1,?2,?3,?4,?5,0,'pending',0,?6,0,?7,?8)",
    )?;
    for row in &plan.rows {
        if row.skipped {
            continue;
        }
        statement.execute(params![
            input.job_id,
            row.seq,
            row.env_id,
            row.run_index,
            row.record.index,
            row.unique_id,
            row.tab.mode,
            if row.tab.close_after { 1 } else { 0 },
        ])?;
    }
    Ok(created > 0)
}

/// 执行前**幂等**落库（job + 整张表的行，跳过 `skipped`）。
///
/// 为什么要在执行前先落一次：对外 API 是「派发后台任务 → 立刻返回 202」，
/// 若等后台任务自己落库，紧接着的 `GET /v1/replay/{jobId}` 会 404。
/// 同一份 `plan_json` 重复落库是安全的（`INSERT OR IGNORE`），后台任务再调一次也不会重复。
pub fn ensure_job_row(
    connection: &Connection,
    plan: &RunPlan,
    plan_hash: &str,
    extra_env_id: Option<&str>,
) -> Result<bool, AppError> {
    let env_ids = plan_env_ids(plan, extra_env_id);
    let options_json = plan_options_json(plan);
    let alloc_mode = AllocMode::parse(&plan.allocation.mode)?;
    insert_job_if_absent(
        connection,
        &NewJobInput {
            job_id: &plan.plan_id,
            title: &plan.job_title,
            trajectory_id: plan.trajectory_id,
            env_ids: &env_ids,
            repeat_count: plan.totals.repeat_count.max(1) as u32,
            total_runs: plan.totals.total_runs,
            dataset_source: &plan.dataset.source,
            dataset_ref: None,
            dataset_size: plan.dataset.size,
            dataset_hash: plan.dataset.hash.as_deref(),
            alloc_mode,
            run_seed: plan.allocation.run_seed,
            open_in_new_tab: plan.open_in_new_tab,
            plan_id: &plan.plan_id,
            plan_hash,
            plan_json: &serde_json::to_string(plan)
                .map_err(|error| AppError::State(format!("序列化预检单失败：{error}")))?,
            options_json: &options_json,
        },
        plan,
    )
}

/// 某个 job 是否仍在跑（有 pending/claimed）
pub fn job_has_open_runs(connection: &Connection, job_id: &str) -> Result<bool, AppError> {    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM replay_run WHERE job_id = ?1 AND status IN ('pending','claimed')",
        params![job_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 全部 job 的过期租约回收（启动时调用；§5.9 崩溃恢复）
pub fn reap_all_expired_leases(connection: &Connection) -> Result<usize, AppError> {
    let updated = connection.execute(
        "UPDATE replay_run
            SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
          WHERE status = 'claimed'
            AND lease_expires_at IS NOT NULL AND lease_expires_at < datetime('now')",
        [],
    )?;
    Ok(updated)
}

/// 收尾：没有未完成轮次时把 job 标成终态（任一失败 → `failed`，否则 `done`）。
pub fn refresh_job_status(connection: &Connection, job_id: &str) -> Result<String, AppError> {
    if job_has_open_runs(connection, job_id)? {
        return Ok("running".to_owned());
    }
    let (failed, cancelled): (i64, i64) = connection.query_row(
        "SELECT
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)
           FROM replay_run WHERE job_id = ?1",
        params![job_id],
        |row| Ok((row.get::<_, Option<i64>>(0)?.unwrap_or(0), row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )?;
    let status = if failed > 0 {
        "failed"
    } else if cancelled > 0 {
        "cancelled"
    } else {
        "done"
    };
    connection.execute(
        "UPDATE replay_job SET status = ?2, finished_at = datetime('now') WHERE job_id = ?1",
        params![job_id, status],
    )?;
    Ok(status.to_owned())
}

/// 启动时恢复：回收过期租约；仍无未完成轮次却停在 `running` 的 job 直接收尾。
///
/// **不重新分配**：续跑只认 `plan_json` 里的行（§5.9）。
pub fn recover_after_restart(connection: &Connection) -> Result<usize, AppError> {
    let reaped = reap_all_expired_leases(connection)?;
    let mut statement = connection.prepare("SELECT job_id FROM replay_job WHERE status = 'running'")?;
    let jobs = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for job_id in jobs {
        if !job_has_open_runs(connection, &job_id)? {
            refresh_job_status(connection, &job_id)?;
        }
    }
    Ok(reaped)
}

/// 一个 `(job, seq)` 的领取结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedRun {    pub seq: i64,
    pub env_id: String,
    pub run_index: i64,
    pub record_index: Option<i64>,
    pub unique_id: Option<i64>,
    pub lease_token: i64,
    pub attempt: i64,
}

/// **原子领取**某环境的下一条 pending（§5.5）。
///
/// 单条 SQL 同时完成「选中 + 归属 + 递增 fencing token + 计算租约过期」。
/// 每环境最多 1 个（`env_id = ?` 过滤，S5 互斥）。
pub fn claim_next_run(
    connection: &Connection,
    job_id: &str,
    env_id: &str,
    owner: &str,
) -> Result<Option<ClaimedRun>, AppError> {
    // `NOT EXISTS` 把「每环境最多 1 个」写进 SQL 而不是靠调用方自觉（S5 互斥）：
    // 只要该环境还有一个**未过期**的在跑轮次，就一条都不发。
    // 过期的 claim 不挡路（否则崩溃残留会让该环境永久卡死）；它们由 `reap_expired_leases` 回收。
    let mut statement = connection.prepare(
        "UPDATE replay_run
            SET status = 'claimed',
                lease_owner = ?2,
                lease_token = lease_token + 1,
                lease_expires_at = datetime('now', ?3),
                attempt = attempt + 1,
                started_at = COALESCE(started_at, datetime('now'))
          WHERE (job_id, seq) = (
                  SELECT job_id, seq FROM replay_run
                   WHERE job_id = ?1 AND env_id = ?4 AND status = 'pending'
                     AND NOT EXISTS (
                           SELECT 1 FROM replay_run c
                            WHERE c.job_id = ?1 AND c.env_id = ?4 AND c.status = 'claimed'
                              AND (c.lease_expires_at IS NULL OR c.lease_expires_at >= datetime('now'))
                         )
                   ORDER BY seq LIMIT 1
                )
      RETURNING seq, env_id, run_index, record_index, unique_id, lease_token, attempt",
    )?;
    let lease = format!("+{LEASE_SECONDS} seconds");
    let claimed = statement
        .query_row(params![job_id, owner, lease, env_id], |row| {
            Ok(ClaimedRun {
                seq: row.get(0)?,
                env_id: row.get(1)?,
                run_index: row.get(2)?,
                record_index: row.get(3)?,
                unique_id: row.get(4)?,
                lease_token: row.get(5)?,
                attempt: row.get(6)?,
            })
        })
        .optional()?;
    Ok(claimed)
}

/// 心跳：续租约。token 不符 ⇒ 已被接管 ⇒ 返回 false（调用方必须放弃本轮，不许再改状态）。
pub fn heartbeat_run(
    connection: &Connection,
    job_id: &str,
    seq: i64,
    lease_token: i64,
) -> Result<bool, AppError> {
    let lease = format!("+{LEASE_SECONDS} seconds");
    let updated = connection.execute(
        "UPDATE replay_run SET lease_expires_at = datetime('now', ?4)
          WHERE job_id = ?1 AND seq = ?2 AND lease_token = ?3 AND status = 'claimed'",
        params![job_id, seq, lease_token, lease],
    )?;
    Ok(updated > 0)
}

/// 过期回收：`claimed` 且租约过期 → 回 `pending` 等重领（§5.9 崩溃恢复）。
pub fn reap_expired_leases(connection: &Connection, job_id: &str) -> Result<usize, AppError> {
    let updated = connection.execute(
        "UPDATE replay_run
            SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
          WHERE job_id = ?1 AND status = 'claimed'
            AND lease_expires_at IS NOT NULL AND lease_expires_at < datetime('now')",
        params![job_id],
    )?;
    Ok(updated)
}

/// 带 fencing 的完成（§5.5）：影响行数 0 ⇒ 已被接管，结果必须丢弃并如实上报。
pub fn finish_run(
    connection: &Connection,
    job_id: &str,
    seq: i64,
    lease_token: i64,
    status: &str,
    result_json: Option<&str>,
    error: Option<&str>,
) -> Result<bool, AppError> {
    let updated = connection.execute(
        "UPDATE replay_run
            SET status = ?4, finished_at = datetime('now'), result_json = ?5, error = ?6,
                lease_expires_at = NULL
          WHERE job_id = ?1 AND seq = ?2 AND lease_token = ?3",
        params![job_id, seq, lease_token, status, result_json, error],
    )?;
    Ok(updated > 0)
}

/// 把某个环境剩余未开始的轮次标为取消（环境被停止 / job 取消）
pub fn cancel_pending_runs(
    connection: &Connection,
    job_id: &str,
    env_id: Option<&str>,
) -> Result<usize, AppError> {
    let updated = match env_id {
        Some(env) => connection.execute(
            "UPDATE replay_run SET status = 'cancelled', finished_at = datetime('now')
              WHERE job_id = ?1 AND env_id = ?2 AND status = 'pending'",
            params![job_id, env],
        )?,
        None => connection.execute(
            "UPDATE replay_run SET status = 'cancelled', finished_at = datetime('now')
              WHERE job_id = ?1 AND status = 'pending'",
            params![job_id],
        )?,
    };
    Ok(updated)
}

/// 汇总：各状态计数（不含任何凭证/结果明文）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub total_runs: i64,
    pub pending: i64,
    pub claimed: i64,
    pub done: i64,
    pub failed: i64,
    pub cancelled: i64,
    /// 倾斜指标：每环境完成数极差（§5.10）
    pub skew: i64,
}

/// 单环境进度（`GET /v1/replay/{jobId}` 的 `envs[]`）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEnvProgress {
    pub env_id: String,
    pub done: i64,
    pub failed: i64,
    pub pending: i64,
    pub claimed: i64,
    pub cancelled: i64,
    /// `running`（还有未完成轮次）/ `done` / `failed` / `cancelled`
    pub status: String,
}

/// 单轮快照（**不含任何字段值**：只有序号、状态、错误摘要，§7.4）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRunSnapshot {
    pub seq: i64,
    pub env_id: String,
    pub run_index: i64,
    pub attempt: i64,
    pub record_index: Option<i64>,
    pub status: String,
    /// 错误摘要（已截断；侧车错误文案本身不含字段值）
    pub error: Option<String>,
}

/// 任务快照（对外 API 的 `GET /v1/replay/{jobId}` 唯一数据源）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub job_id: String,
    pub title: String,
    pub status: String,
    pub trajectory_id: Option<i64>,
    pub total_runs: i64,
    pub skipped_runs: i64,
    pub dataset_source: String,
    pub dataset_size: i64,
    pub alloc_mode: String,
    pub run_seed: i64,
    pub plan_hash: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub progress: JobProgress,
    pub envs: Vec<JobEnvProgress>,
    pub runs: Vec<JobRunSnapshot>,
}

/// 错误摘要上限：错误文案本身不含字段值，但仍截断，避免把整段页面文本放大回传
const MAX_ERROR_CHARS: usize = 240;

fn truncate_error(raw: Option<String>) -> Option<String> {
    let text = raw?.trim().to_owned();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= MAX_ERROR_CHARS {
        return Some(text);
    }
    Some(text.chars().take(MAX_ERROR_CHARS).collect::<String>() + "…")
}

/// 读一个 job 的完整快照（不存在 → `None`，由调用方转 404）。
pub fn job_snapshot(connection: &Connection, job_id: &str) -> Result<Option<JobSnapshot>, AppError> {
    let job = connection
        .query_row(
            "SELECT title, status, trajectory_id, total_runs, dataset_source, dataset_size,
                    alloc_mode, run_seed, plan_hash, created_at, finished_at, plan_json
               FROM replay_job WHERE job_id = ?1",
            params![job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                ))
            },
        )
        .optional()?;
    let Some((
        title,
        status,
        trajectory_id,
        total_runs,
        dataset_source,
        dataset_size,
        alloc_mode,
        run_seed,
        plan_hash,
        created_at,
        finished_at,
        plan_json,
    )) = job
    else {
        return Ok(None);
    };

    // 跳过的轮次不进 `replay_run`（§5.3），所以从冻结的预检单里数
    let skipped_runs = plan_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<RunPlan>(raw).ok())
        .map(|plan| plan.rows.iter().filter(|row| row.skipped).count() as i64)
        .unwrap_or(0);

    let progress = job_progress(connection, job_id)?;

    let mut runs_statement = connection.prepare(
        "SELECT seq, env_id, run_index, attempt, record_index, status, error
           FROM replay_run WHERE job_id = ?1 ORDER BY seq",
    )?;
    let runs = runs_statement
        .query_map(params![job_id], |row| {
            Ok(JobRunSnapshot {
                seq: row.get(0)?,
                env_id: row.get(1)?,
                run_index: row.get(2)?,
                attempt: row.get(3)?,
                record_index: row.get(4)?,
                status: row.get(5)?,
                error: truncate_error(row.get(6)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut env_statement = connection.prepare(
        "SELECT env_id,
                SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='claimed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END)
           FROM replay_run WHERE job_id = ?1 GROUP BY env_id ORDER BY MIN(seq)",
    )?;
    let envs = env_statement
        .query_map(params![job_id], |row| {
            let done = row.get::<_, Option<i64>>(1)?.unwrap_or(0);
            let failed = row.get::<_, Option<i64>>(2)?.unwrap_or(0);
            let pending = row.get::<_, Option<i64>>(3)?.unwrap_or(0);
            let claimed = row.get::<_, Option<i64>>(4)?.unwrap_or(0);
            let cancelled = row.get::<_, Option<i64>>(5)?.unwrap_or(0);
            let status = if pending + claimed > 0 {
                "running"
            } else if failed > 0 {
                "failed"
            } else if cancelled > 0 {
                "cancelled"
            } else {
                "done"
            };
            Ok(JobEnvProgress {
                env_id: row.get(0)?,
                done,
                failed,
                pending,
                claimed,
                cancelled,
                status: status.to_owned(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some(JobSnapshot {
        job_id: job_id.to_owned(),
        title,
        status,
        trajectory_id,
        total_runs,
        skipped_runs,
        dataset_source,
        dataset_size,
        alloc_mode,
        run_seed,
        plan_hash,
        created_at,
        finished_at,
        progress,
        envs,
        runs,
    }))
}

/// 取消一个 job：剩余未开始的轮次标 `cancelled`，job 收尾为 `cancelled`。
///
/// **只动台账**：正在跑的那一轮由调用方另发 `trajectory_abort`（不关浏览器、不杀会话）。
pub fn cancel_job(connection: &Connection, job_id: &str) -> Result<usize, AppError> {
    let cancelled = cancel_pending_runs(connection, job_id, None)?;
    connection.execute(
        "UPDATE replay_job SET status = 'cancelled', finished_at = COALESCE(finished_at, datetime('now'))
          WHERE job_id = ?1 AND status = 'running'",
        params![job_id],
    )?;
    Ok(cancelled)
}

/// 仍在跑的 job 数量（对外 API 的并发闸门 → 429）
pub fn count_running_jobs(connection: &Connection) -> Result<i64, AppError> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM replay_job WHERE status = 'running'",
        [],
        |row| row.get(0),
    )?;
    Ok(count)
}

pub fn job_progress(connection: &Connection, job_id: &str) -> Result<JobProgress, AppError> {
    let mut progress = JobProgress::default();
    let mut statement = connection
        .prepare("SELECT status, COUNT(*) FROM replay_run WHERE job_id = ?1 GROUP BY status")?;
    let counts = statement
        .query_map(params![job_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (status, count) in counts {
        progress.total_runs += count;
        match status.as_str() {
            "pending" => progress.pending = count,
            "claimed" => progress.claimed = count,
            "done" => progress.done = count,
            "failed" => progress.failed = count,
            "cancelled" => progress.cancelled = count,
            _ => {}
        }
    }
    let mut env_done_statement = connection.prepare(
        "SELECT COUNT(*) FROM replay_run
          WHERE job_id = ?1 AND env_id = ?2 AND status = 'done'",
    )?;
    let mut envs_statement = connection
        .prepare("SELECT DISTINCT env_id FROM replay_run WHERE job_id = ?1")?;
    let envs = envs_statement
        .query_map(params![job_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut per_env: Vec<i64> = Vec::with_capacity(envs.len());
    for env in envs {
        per_env.push(env_done_statement.query_row(params![job_id, env], |row| row.get(0))?);
    }
    progress.skew = match (per_env.iter().max(), per_env.iter().min()) {
        (Some(max), Some(min)) => max - min,
        _ => 0,
    };
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_ids(count: usize) -> Vec<String> {
        (0..count).map(|index| (index + 1).to_string()).collect()
    }

    fn ledger() -> Connection {
        let connection = Connection::open_in_memory().expect("open memory db");
        connection
            .execute_batch(
                "CREATE TABLE replay_job (
                    job_id TEXT PRIMARY KEY, title TEXT NOT NULL, trajectory_id INTEGER,
                    env_ids TEXT NOT NULL, repeat_count INTEGER NOT NULL, total_runs INTEGER NOT NULL,
                    dataset_source TEXT NOT NULL, dataset_ref TEXT, dataset_size INTEGER NOT NULL,
                    dataset_hash TEXT, alloc_mode TEXT NOT NULL, run_seed INTEGER NOT NULL,
                    open_in_new_tab INTEGER NOT NULL DEFAULT 1, plan_id TEXT, plan_hash TEXT,
                    plan_json TEXT, options_json TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, finished_at TEXT
                 );
                 CREATE TABLE replay_run (
                    job_id TEXT NOT NULL, seq INTEGER NOT NULL, env_id TEXT NOT NULL,
                    run_index INTEGER NOT NULL, record_index INTEGER, attempt INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL, lease_owner TEXT, lease_token INTEGER NOT NULL DEFAULT 0,
                    lease_expires_at TEXT, unique_id INTEGER, skipped INTEGER NOT NULL DEFAULT 0,
                    tab_mode TEXT, tab_close_after INTEGER, started_at TEXT, finished_at TEXT,
                    result_json TEXT, error TEXT, PRIMARY KEY (job_id, seq)
                 );",
            )
            .expect("create ledger tables");
        connection
    }

    fn sample_plan(rows: Vec<PlanRow>) -> RunPlan {
        let active = rows.iter().filter(|row| !row.skipped).count() as i64;
        RunPlan {
            ok: true,
            plan_id: "plan-1".to_owned(),
            plan_hash: String::new(),
            job_title: "轨迹X · 2 环境 × 2 轮".to_owned(),
            trajectory_id: Some(42),
            trajectory_title: "注册流程".to_owned(),
            totals: PlanTotals {
                envs: 2,
                repeat_count: 2,
                total_runs: active,
                planned_new_tabs: active,
                max_concurrency: 4,
                stagger_ms: 300,
            },
            dataset: PlanDatasetInfo {
                source: "inline".to_owned(),
                size: 4,
                columns: vec!["email".to_owned()],
                hash: Some("sha256:deadbeef".to_owned()),
            },
            allocation: PlanAllocation {
                mode: "seq_interleave".to_owned(),
                on_exhausted: "error".to_owned(),
                run_seed: 20260924,
            },
            open_in_new_tab: true,
            close_after: false,
            stop_on_first_failure: false,
            run_timeout_ms: 600_000,
            warnings: vec![],
            errors: vec![],
            rows,
        }
    }

    fn row(seq: i64, env: &str, run_index: i64, record: Option<i64>) -> PlanRow {
        PlanRow {
            seq,
            env_id: env.to_owned(),
            run_index,
            unique_id: seq,
            skipped: false,
            record: PlanRecord {
                source: if record.is_some() { "dataset" } else { "generate" }.to_owned(),
                index: record,
                preview: serde_json::Map::new(),
            },
            tab: PlanTab {
                mode: "new".to_owned(),
                close_after: false,
                label: "新标签".to_owned(),
            },
        }
    }

    /* ---------- 分配公式 ---------- */

    #[test]
    fn interleave_pairs_adjacent_rows_for_concurrent_browsers() {
        // 10 环境 × 10 轮：第 1 轮 0..9，第 2 轮 10..19 —— 同时跑的浏览器拿相邻行
        let rows = build_allocations(&env_ids(10), 10, 100, AllocMode::SeqInterleave);
        assert_eq!(rows.len(), 100);
        assert_eq!(rows[0].record_index, Some(0));
        assert_eq!(rows[9].record_index, Some(9));
        assert_eq!(rows[10].record_index, Some(10));
        assert_eq!(rows[99].record_index, Some(99));
        assert!(rows.iter().all(|row| !row.reused), "N <= M 时零重复");
    }

    #[test]
    fn block_mode_gives_each_env_a_contiguous_chunk() {
        let rows = build_allocations(&env_ids(3), 4, 12, AllocMode::SeqBlock);
        let env1: Vec<Option<i64>> = rows
            .iter()
            .filter(|row| row.env_id == "1")
            .map(|row| row.record_index)
            .collect();
        assert_eq!(env1, vec![Some(0), Some(1), Some(2), Some(3)]);
        let env3: Vec<Option<i64>> = rows
            .iter()
            .filter(|row| row.env_id == "3")
            .map(|row| row.record_index)
            .collect();
        assert_eq!(env3, vec![Some(8), Some(9), Some(10), Some(11)]);
    }

    #[test]
    fn cycle_mode_marks_reused_rows() {
        let rows = build_allocations(&env_ids(2), 4, 2, AllocMode::Cycle);
        assert_eq!(rows[0].record_index, Some(0));
        assert_eq!(rows[1].record_index, Some(1));
        assert_eq!(rows[2].record_index, Some(0));
        assert!(rows[2].reused, "第 3 次又用了第 1 行，必须标出来");
        assert_eq!(rows[3].record_index, Some(1));
        assert!(rows[3].reused);
    }

    #[test]
    fn generate_mode_has_no_record_index_but_keeps_unique_ids() {
        let rows = build_allocations(&env_ids(3), 2, 0, AllocMode::Generate);
        assert_eq!(rows.len(), 6);
        assert!(rows.iter().all(|row| row.record_index.is_none()));
        let ids: Vec<i64> = rows.iter().map(|row| row.unique_id).collect();
        assert_eq!(ids, vec![0, 1, 2, 3, 4, 5], "唯一序号由分配器发号，不靠随机");
    }

    #[test]
    fn empty_inputs_allocate_nothing() {
        assert!(build_allocations(&[], 5, 10, AllocMode::SeqInterleave).is_empty());
        assert!(build_allocations(&env_ids(2), 0, 10, AllocMode::SeqInterleave).is_empty());
    }

    #[test]
    fn seq_is_unique_across_every_mode() {
        for mode in [
            AllocMode::SeqInterleave,
            AllocMode::SeqBlock,
            AllocMode::Claim,
            AllocMode::Cycle,
        ] {
            let rows = build_allocations(&env_ids(4), 5, 20, mode);
            let mut seqs: Vec<i64> = rows.iter().map(|row| row.seq).collect();
            let count = seqs.len();
            seqs.sort_unstable();
            seqs.dedup();
            assert_eq!(seqs.len(), count, "序号必须唯一（mode={}）", mode.as_str());
            let mut keys: Vec<(String, i64)> = rows
                .iter()
                .map(|row| (row.env_id.clone(), row.run_index))
                .collect();
            let key_count = keys.len();
            keys.sort();
            keys.dedup();
            assert_eq!(keys.len(), key_count, "(环境, 轮次) 不得重复");
        }
    }

    /* ---------- 目标模板逐轮插值（数据集驱动的回放） ---------- */

    #[test]
    fn goal_template_expands_per_row_and_never_leaks_data_tokens() {
        let plan_row = row(3, "2", 1, Some(1));
        let mut data = serde_json::Map::new();
        data.insert("关键词".to_owned(), Value::String("张三".to_owned()));

        // 逐轮展开：本行填「张三」，目标也必须是「张三」
        assert_eq!(
            interpolate_plan_row_goal(
                "打开百度搜索{{data.关键词}}然后总结第一条结果",
                &plan_row,
                "plan-abc",
                Some(&data),
            ),
            "打开百度搜索张三然后总结第一条结果"
        );

        // 轮次身份同样可插值
        assert_eq!(
            interpolate_plan_row_goal(
                "第{{run.seq}}轮·环境{{run.envId}}·#{{run.uniqueId}}",
                &plan_row,
                "plan-abc",
                Some(&data),
            ),
            "第3轮·环境2·#3"
        );

        // 生成型轮次（无数据行）：残留的 {{data.*}} 必须抹掉，绝不把模板语法喂给模型
        assert_eq!(
            interpolate_plan_row_goal("搜索{{data.关键词}}并总结", &plan_row, "plan-abc", None),
            "搜索并总结"
        );

        // persona / geoip 是既有口径：保持原样，交给 Sidecar 侧处理
        assert_eq!(
            interpolate_plan_row_goal(
                "{{persona.name}}在{{geoip.city}}搜索{{data.关键词}}",
                &plan_row,
                "plan-abc",
                Some(&data),
            ),
            "{{persona.name}}在{{geoip.city}}搜索张三"
        );

        // 没有模板语法 → 原样返回（零成本、零改动）
        assert_eq!(
            interpolate_plan_row_goal("普通目标", &plan_row, "plan-abc", None),
            "普通目标"
        );
    }

    /* ---------- 数据集「有数据却没映射」黄条 ---------- */

    #[test]
    fn dataset_without_field_map_gets_a_visible_warning() {
        // 有数据、没映射 → 黄条（用户以为换了值、其实没生效）；只是提醒，不拦启动
        let plan = build_run_plan(&plan_inputs(1, 1, 3), &RiskReport::default()).unwrap();
        assert!(plan
            .warnings
            .iter()
            .any(|entry| entry.code == "dataset_unmapped"));
        assert!(plan.errors.is_empty(), "提醒不得升级成红条");

        // 映射上 → 黄条消失
        let mut mapped = plan_inputs(1, 1, 3);
        mapped
            .field_map
            .insert("#email".to_owned(), "email".to_owned());
        let plan = build_run_plan(&mapped, &RiskReport::default()).unwrap();
        assert!(!plan
            .warnings
            .iter()
            .any(|entry| entry.code == "dataset_unmapped"));

        // 无数据集（纯生成型）→ 不适用，不该出现
        let plan = build_run_plan(&plan_inputs(1, 1, 0), &RiskReport::default()).unwrap();
        assert!(!plan
            .warnings
            .iter()
            .any(|entry| entry.code == "dataset_unmapped"));
    }

    /* ---------- plan_hash ---------- */

    #[test]
    fn plan_hash_is_stable_and_covers_edits_and_params() {
        let plan = sample_plan(vec![
            row(0, "1", 0, Some(0)),
            row(1, "2", 0, Some(1)),
            row(2, "1", 1, Some(2)),
            row(3, "2", 1, Some(3)),
        ]);
        let base = compute_plan_hash(&plan);
        assert_eq!(base, compute_plan_hash(&plan.clone()), "同表同 hash");
        assert!(base.starts_with("sha256:"));

        let mut edited = plan.clone();
        edited.rows[0].record.index = Some(7);
        assert_ne!(base, compute_plan_hash(&edited), "换用第 N 行 → hash 必须变");

        let mut skipped = plan.clone();
        skipped.rows[1].skipped = true;
        assert_ne!(base, compute_plan_hash(&skipped), "跳过一轮 → hash 必须变");

        let mut tabbed = plan.clone();
        tabbed.rows[2].tab.close_after = true;
        assert_ne!(base, compute_plan_hash(&tabbed), "改标签策略 → hash 必须变");

        let mut concurrency = plan.clone();
        concurrency.totals.max_concurrency = 8;
        assert_ne!(base, compute_plan_hash(&concurrency), "改并发 → hash 必须变");

        let mut data = plan.clone();
        data.dataset.hash = Some("sha256:cafe".to_owned());
        assert_ne!(base, compute_plan_hash(&data), "数据内容变 → hash 必须变");

        // 标题 / 提醒不影响执行 → hash 不变（改标题不该让用户重新确认）
        let mut titled = plan.clone();
        titled.job_title = "改个名字".to_owned();
        titled.warnings.push(PlanWarning {
            level: "yellow".to_owned(),
            code: "x".to_owned(),
            text: "y".to_owned(),
        });
        assert_eq!(base, compute_plan_hash(&titled));
    }

    #[test]
    fn verify_plan_hash_rejects_missing_and_stale() {
        let plan = sample_plan(vec![row(0, "1", 0, Some(0))]);
        let hash = compute_plan_hash(&plan);
        assert!(verify_plan_hash("", &plan).is_err(), "缺 planHash 必须拒绝");
        assert!(verify_plan_hash(&hash, &plan).is_ok());
        assert!(
            verify_plan_hash("sha256:0000", &plan).is_err(),
            "hash 不一致必须拒绝"
        );
        assert!(verify_plan_hash(&hash.to_uppercase(), &plan).is_ok());
    }

    #[test]
    fn dataset_hash_tracks_content_only() {
        let a = vec![json!({ "email": "a@b.com" })];
        let b = vec![json!({ "email": "a@b.com" })];
        let c = vec![json!({ "email": "a@c.com" })];
        assert_eq!(compute_dataset_hash(&a), compute_dataset_hash(&b));
        assert_ne!(compute_dataset_hash(&a), compute_dataset_hash(&c));
    }

    /* ---------- 台账：领取 / fencing / 回收 ---------- */

    fn insert_two_env_job(connection: &Connection, plan: &RunPlan, envs: &[String]) {
        insert_job(
            connection,
            &NewJobInput {
                job_id: "job-1",
                title: "t",
                trajectory_id: Some(42),
                env_ids: envs,
                repeat_count: 2,
                total_runs: plan.rows.iter().filter(|row| !row.skipped).count() as i64,
                dataset_source: "inline",
                dataset_ref: None,
                dataset_size: 4,
                dataset_hash: Some("sha256:x"),
                alloc_mode: AllocMode::SeqInterleave,
                run_seed: 1,
                open_in_new_tab: true,
                plan_id: "plan-1",
                plan_hash: "sha256:y",
                plan_json: "{}",
                options_json: "{}",
            },
            plan,
        )
        .expect("insert job");
    }

    #[test]
    fn claim_is_per_env_serial_and_token_monotonic() {
        let connection = ledger();
        let plan = sample_plan(vec![
            row(0, "1", 0, Some(0)),
            row(1, "2", 0, Some(1)),
            row(2, "1", 1, Some(2)),
            row(3, "2", 1, Some(3)),
        ]);
        insert_two_env_job(&connection, &plan, &env_ids(2));

        let first = claim_next_run(&connection, "job-1", "1", "owner-a")
            .unwrap()
            .expect("first claim");
        assert_eq!(first.seq, 0);
        assert_eq!(first.lease_token, 1);
        assert_eq!(first.attempt, 1);
        assert_eq!(first.record_index, Some(0));

        assert!(
            claim_next_run(&connection, "job-1", "1", "owner-b")
                .unwrap()
                .is_none(),
            "同环境未完成前不得再领（S5：每环境最多 1 个）"
        );

        let other = claim_next_run(&connection, "job-1", "2", "owner-a")
            .unwrap()
            .expect("other env");
        assert_eq!(other.seq, 1);

        assert!(
            finish_run(&connection, "job-1", 0, first.lease_token, "done", Some("{}"), None).unwrap()
        );
        let second = claim_next_run(&connection, "job-1", "1", "owner-a")
            .unwrap()
            .expect("second claim");
        assert_eq!(second.seq, 2);
        assert_eq!(second.record_index, Some(2), "续跑按 plan 表取行，不重新分配");
        assert_eq!(
            second.lease_token, 1,
            "fencing token 是**每行**的：新行从 1 起（同一行被接管才递增，见 late_finish 用例）"
        );
    }

    #[test]
    fn late_finish_after_takeover_is_discarded() {
        let connection = ledger();
        let plan = sample_plan(vec![row(0, "1", 0, Some(0))]);
        insert_two_env_job(&connection, &plan, &env_ids(1));

        let claimed = claim_next_run(&connection, "job-1", "1", "owner-a")
            .unwrap()
            .expect("claim");
        connection
            .execute(
                "UPDATE replay_run SET lease_expires_at = datetime('now','-10 seconds')
                  WHERE job_id='job-1' AND seq=0",
                [],
            )
            .unwrap();
        assert_eq!(reap_expired_leases(&connection, "job-1").unwrap(), 1);
        let retaken = claim_next_run(&connection, "job-1", "1", "owner-b")
            .unwrap()
            .expect("retake");
        assert_eq!(retaken.lease_token, 2);

        let accepted = finish_run(
            &connection,
            "job-1",
            0,
            claimed.lease_token,
            "done",
            Some(r#"{"stale":true}"#),
            None,
        )
        .unwrap();
        assert!(!accepted, "迟到完成必须被丢弃");

        let (status, result): (String, Option<String>) = connection
            .query_row(
                "SELECT status, result_json FROM replay_run WHERE job_id='job-1' AND seq=0",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "claimed");
        assert_eq!(result, None, "旧 owner 不得污染台账");
    }

    #[test]
    fn heartbeat_requires_matching_token() {
        let connection = ledger();
        let plan = sample_plan(vec![row(0, "1", 0, Some(0))]);
        insert_two_env_job(&connection, &plan, &env_ids(1));
        let claimed = claim_next_run(&connection, "job-1", "1", "owner-a")
            .unwrap()
            .expect("claim");
        assert!(heartbeat_run(&connection, "job-1", claimed.seq, claimed.lease_token).unwrap());
        assert!(
            !heartbeat_run(&connection, "job-1", claimed.seq, claimed.lease_token + 1).unwrap(),
            "token 不符 = 已被接管，必须放弃"
        );
    }

    #[test]
    fn reap_only_touches_expired_claims() {
        let connection = ledger();
        let plan = sample_plan(vec![row(0, "1", 0, Some(0)), row(1, "2", 0, Some(1))]);
        insert_two_env_job(&connection, &plan, &env_ids(2));
        claim_next_run(&connection, "job-1", "1", "owner-a").unwrap();
        claim_next_run(&connection, "job-1", "2", "owner-a").unwrap();
        connection
            .execute(
                "UPDATE replay_run SET lease_expires_at = datetime('now','-1 seconds')
                  WHERE env_id='1'",
                [],
            )
            .unwrap();
        assert_eq!(reap_expired_leases(&connection, "job-1").unwrap(), 1);
        let progress = job_progress(&connection, "job-1").unwrap();
        assert_eq!(progress.pending, 1);
        assert_eq!(progress.claimed, 1);
    }

    #[test]
    fn skipped_rows_are_not_written_to_ledger() {
        let connection = ledger();
        let mut plan = sample_plan(vec![row(0, "1", 0, Some(0)), row(1, "2", 0, Some(1))]);
        plan.rows[1].skipped = true;
        insert_two_env_job(&connection, &plan, &env_ids(2));
        let total: i64 = connection
            .query_row("SELECT COUNT(*) FROM replay_run", [], |row| row.get(0))
            .unwrap();
        assert_eq!(total, 1, "被跳过的轮次不入台账、不开标签");
    }

    #[test]
    fn progress_reports_skew_and_cancel_only_touches_pending() {
        let connection = ledger();
        let plan = sample_plan(vec![
            row(0, "1", 0, Some(0)),
            row(1, "2", 0, Some(1)),
            row(2, "1", 1, Some(2)),
        ]);
        insert_two_env_job(&connection, &plan, &env_ids(2));
        let claim = claim_next_run(&connection, "job-1", "1", "owner-a")
            .unwrap()
            .expect("claim");
        finish_run(&connection, "job-1", claim.seq, claim.lease_token, "done", None, None).unwrap();
        let progress = job_progress(&connection, "job-1").unwrap();
        assert_eq!(progress.total_runs, 3);
        assert_eq!(progress.done, 1);
        assert_eq!(progress.pending, 2);
        assert_eq!(progress.skew, 1, "环境1完成1、环境2完成0 → 极差 1");

        assert!(
            claim_next_run(&connection, "job-1", "2", "owner-a")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            cancel_pending_runs(&connection, "job-1", Some("1")).unwrap(),
            1
        );
        let progress = job_progress(&connection, "job-1").unwrap();
        assert_eq!(progress.cancelled, 1);
        assert_eq!(progress.pending, 0);
        assert_eq!(progress.claimed, 1, "已在跑的轮次不被 cancel 改写");
    }

    #[test]
    fn mode_and_exhausted_parsing_is_strict() {        assert_eq!(
            AllocMode::parse("SEQ_INTERLEAVE").unwrap(),
            AllocMode::SeqInterleave
        );
        assert_eq!(AllocMode::parse("").unwrap(), AllocMode::SeqInterleave);
        assert!(AllocMode::parse("random").is_err(), "不许静默回落成随机");
        assert_eq!(OnExhausted::parse("Cycle").unwrap(), OnExhausted::Cycle);
        assert!(OnExhausted::parse("ignore").is_err());
    }

    /* ---------- 预检单生成 ---------- */

    fn plan_inputs(envs: usize, repeat: u32, rows: usize) -> PlanInputs {
        let dataset_rows: Vec<serde_json::Map<String, Value>> = (0..rows)
            .map(|index| {
                let mut row = serde_json::Map::new();
                row.insert(
                    "email".to_owned(),
                    Value::String(format!("user{{{{run.uniqueId}}}}-{index}@b.com")),
                );
                row.insert("name".to_owned(), Value::String(format!("测试{index}")));
                row
            })
            .collect();
        PlanInputs {
            trajectory_id: Some(42),
            trajectory_title: "注册流程".to_owned(),
            trajectory_steps: 12,
            envs: (1..=envs)
                .map(|index| PlanEnvState {
                    env_id: index.to_string(),
                    name: format!("环境{index}"),
                    running: true,
                    busy: false,
                })
                .collect(),
            repeat_count: repeat,
            dataset: PlanDatasetInput {
                source: if rows == 0 { "none".to_owned() } else { "inline".to_owned() },
                columns: if rows == 0 {
                    vec![]
                } else {
                    vec!["email".to_owned(), "name".to_owned()]
                },
                rows: dataset_rows,
                hash: None,
            },
            field_map: std::collections::BTreeMap::new(),
            allocation: PlanAllocationInput {
                mode: Some("seq_interleave".to_owned()),
                on_exhausted: Some("error".to_owned()),
                run_seed: Some(20260924),
            },
            open_in_new_tab: true,
            close_after: false,
            stop_on_first_failure: false,
            run_timeout_ms: None,
            max_concurrency: Some(4),
            stagger_ms: Some(300),
            edits: vec![],
            job_title: None,
            run_seed: None,
        }
    }

    /// N5 / N6：剪贴板作为**单行数据集**（列名 `text`）。
    ///
    /// 断言三件事：① 逐轮都指向那一行（供执行阶段取值）；
    /// ② 预览**打码**（内容不入台账/日志，§6.4）；③ 「多轮共用同一行」不误报成数据不足。
    #[test]
    fn clipboard_source_is_a_single_shared_row_with_masked_preview() {
        let mut inputs = plan_inputs(2, 3, 0);
        let mut row = serde_json::Map::new();
        row.insert("text".to_owned(), Value::String("482913".to_owned()));
        inputs.dataset = PlanDatasetInput {
            source: "clipboard".to_owned(),
            columns: vec!["text".to_owned()],
            rows: vec![row],
            hash: None,
        };

        let plan = build_run_plan(&inputs, &RiskReport::default()).unwrap();
        assert!(plan.ok, "剪贴板快照不该有红条：{:?}", plan.errors);
        assert_eq!(plan.dataset.source, "clipboard");
        assert_eq!(plan.dataset.size, 1, "剪贴板是单行数据集");
        assert!(
            plan.dataset.hash.is_some(),
            "快照内容参与 dataset_hash（两级指纹）"
        );
        assert_eq!(plan.rows.len(), 6, "2 环境 × 3 轮");
        for entry in &plan.rows {
            assert_eq!(entry.record.source, "clipboard");
            assert_eq!(entry.record.index, Some(0), "每轮都指向那一行快照");
            let preview = entry
                .record
                .preview
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            assert!(
                !preview.contains("482913"),
                "剪贴板内容不得进预检单/台账（只给长度）：{preview}"
            );
            assert!(preview.contains('6'), "预览给长度：{preview}");
        }
        assert!(
            !plan
                .warnings
                .iter()
                .any(|entry| entry.code == "record_reused"),
            "剪贴板快照本来就让所有轮次共用，不该报「数据行复用」"
        );
        assert!(
            !plan.errors.iter().any(|entry| entry.code == "not_enough_rows"),
            "单行快照不是「数据不够」"
        );
    }

    #[test]
    fn plan_preview_interpolates_run_and_data() {
        let plan = build_run_plan(&plan_inputs(2, 2, 4), &RiskReport::default()).unwrap();
        assert!(plan.ok, "干净输入不该有红条：{:?}", plan.errors);
        assert_eq!(plan.rows.len(), 4);
        let first = &plan.rows[0];
        assert_eq!(first.unique_id, 0);
        assert_eq!(
            first.record.preview.get("email").and_then(|v| v.as_str()),
            Some("user0-0@b.com"),
            "{{run.uniqueId}} 必须插值成分配器发的唯一序号"
        );
        assert_eq!(
            first.record.preview.get("name").and_then(|v| v.as_str()),
            Some("测试0")
        );
        // 第二环境第一轮：交织 → seq=1，序号 1
        let second_env = plan.rows.iter().find(|row| row.env_id == "2").unwrap();
        assert_eq!(second_env.unique_id, 1);
        assert_eq!(
            second_env.record.preview.get("email").and_then(|v| v.as_str()),
            Some("user1-1@b.com")
        );
    }

    #[test]
    fn plan_keeps_unknown_variables_verbatim() {
        let mut inputs = plan_inputs(1, 1, 1);
        inputs.dataset.rows[0].insert(
            "email".to_owned(),
            Value::String("{{persona.name}}@{{run.envId}}.test".to_owned()),
        );
        let plan = build_run_plan(&inputs, &RiskReport::default()).unwrap();
        assert_eq!(
            plan.rows[0].record.preview.get("email").and_then(|v| v.as_str()),
            Some("{{persona.name}}@1.test"),
            "预览不认识 persona，原样保留而不是抹成空串"
        );
    }

    #[test]
    fn plan_blocks_when_rows_are_not_enough() {
        // 2 环境 × 5 轮 = 10 轮，只有 4 行，且 onExhausted=error → 红条禁止启动
        let plan = build_run_plan(&plan_inputs(2, 5, 4), &RiskReport::default()).unwrap();
        assert!(!plan.ok);
        assert!(plan.errors.iter().any(|entry| entry.code == "not_enough_rows"));
        assert_eq!(plan.totals.total_runs, 10, "明细仍要完整返回，用户才知道改什么");
    }

    #[test]
    fn plan_cycle_and_generate_handle_shortfall_explicitly() {
        let mut cycle = plan_inputs(2, 5, 4);
        cycle.allocation.on_exhausted = Some("cycle".to_owned());
        let plan = build_run_plan(&cycle, &RiskReport::default()).unwrap();
        assert!(plan.ok, "循环取用是用户显式选择，不该红条");
        assert!(plan.warnings.iter().any(|entry| entry.code == "rows_cycled"));
        assert!(plan.warnings.iter().any(|entry| entry.code == "record_reused"));
        assert!(plan.rows.iter().all(|row| row.record.source == "dataset"));

        let mut generate = plan_inputs(2, 5, 4);
        generate.allocation.on_exhausted = Some("generate".to_owned());
        let plan = build_run_plan(&generate, &RiskReport::default()).unwrap();
        assert!(plan.ok);
        assert!(plan.warnings.iter().any(|entry| entry.code == "rows_generated"));
        // seq >= 4 的轮次改成生成型，且不再有 record.index
        let generated: Vec<&PlanRow> = plan
            .rows
            .iter()
            .filter(|row| row.record.source == "generate")
            .collect();
        assert_eq!(generated.len(), 6, "10 轮 - 4 行 = 6 轮生成");
        assert!(generated.iter().all(|row| row.record.index.is_none()));
    }

    #[test]
    fn plan_reports_env_and_trajectory_problems_as_red() {
        let mut inputs = plan_inputs(2, 1, 2);
        inputs.envs[0].running = false;
        inputs.envs[1].busy = true;
        inputs.trajectory_steps = 0;
        let plan = build_run_plan(&inputs, &RiskReport::default()).unwrap();
        assert!(!plan.ok);
        let codes: Vec<&str> = plan.errors.iter().map(|entry| entry.code.as_str()).collect();
        assert!(codes.contains(&"env_not_running"));
        assert!(codes.contains(&"env_busy"));
        assert!(codes.contains(&"empty_trajectory"));
    }

    #[test]
    fn plan_flags_critical_steps_and_sensitive_columns() {
        let risk = RiskReport {
            critical_steps: vec![RiskStep {
                index: 8,
                label: "点击 确认支付".to_owned(),
                matched: "确认支付".to_owned(),
                reason: "critical".to_owned(),
            }],
            column_refusals: vec![RiskRefusal {
                name: "otp".to_owned(),
                reason: "一次性凭证列".to_owned(),
            }],
            column_warnings: vec![],
        };
        let plan = build_run_plan(&plan_inputs(1, 1, 1), &risk).unwrap();
        assert!(!plan.ok, "凭证列名是红条（R2）");
        assert!(plan.errors.iter().any(|entry| entry.code == "sensitive_column"));
        let critical = plan
            .warnings
            .iter()
            .find(|entry| entry.code == "critical_steps")
            .expect("critical 条必须存在");
        assert_eq!(critical.level, "yellow", "critical 只提示，不拦（执行时走人工闸门）");
        assert!(critical.text.contains("不会无人支付"));
        assert!(!plan.errors.iter().any(|entry| entry.code == "critical_steps"));
    }

    #[test]
    fn plan_applies_edits_and_switches_hash() {
        let inputs = plan_inputs(2, 2, 4);
        let base = build_run_plan(&inputs, &RiskReport::default()).unwrap();
        assert_eq!(
            base.rows[0].record.index,
            Some(0),
            "默认按分配器公式取行"
        );

        let mut edited_inputs = plan_inputs(2, 2, 4);
        edited_inputs.edits = vec![
            PlanEdit {
                seq: 0,
                use_record_index: Some(3),
                ..Default::default()
            },
            PlanEdit {
                seq: 1,
                skipped: Some(true),
                ..Default::default()
            },
            PlanEdit {
                seq: 2,
                record_source: Some("generate".to_owned()),
                ..Default::default()
            },
            PlanEdit {
                seq: 3,
                tab_mode: Some("new_close".to_owned()),
                ..Default::default()
            },
        ];
        let edited = build_run_plan(&edited_inputs, &RiskReport::default()).unwrap();
        assert_eq!(edited.rows[0].record.index, Some(3), "换用第 4 行");
        assert!(edited.rows[1].skipped);
        assert_eq!(edited.rows[2].record.source, "generate");
        assert_eq!(edited.rows[3].tab.mode, "new_close");
        assert!(edited.rows[3].tab.close_after);
        assert_eq!(edited.totals.total_runs, 3, "跳过一轮 → 总轮次减一");
        assert_eq!(
            edited.totals.planned_new_tabs, 3,
            "未跳过的 3 轮都是「新标签」类（new / new_close 都算新建）"
        );
        assert_ne!(base.plan_hash, edited.plan_hash, "改过 → hash 必须变（N13-b）");
    }

    #[test]
    fn plan_rejects_out_of_range_record_index() {
        let mut inputs = plan_inputs(1, 1, 2);
        inputs.edits = vec![PlanEdit {
            seq: 0,
            use_record_index: Some(99),
            ..Default::default()
        }];
        let plan = build_run_plan(&inputs, &RiskReport::default()).unwrap();
        assert!(!plan.ok);
        assert!(plan
            .errors
            .iter()
            .any(|entry| entry.code == "record_index_out_of_range"));
    }

    #[test]
    fn plan_uses_manual_run_seed_and_reports_it() {
        let plan = build_run_plan(&plan_inputs(1, 1, 1), &RiskReport::default()).unwrap();
        assert_eq!(plan.allocation.run_seed, 20260924, "用户给的种子必须原样回报");

        let mut inputs = plan_inputs(1, 1, 1);
        inputs.allocation.run_seed = None;
        inputs.run_seed = None;
        let auto = build_run_plan(&inputs, &RiskReport::default()).unwrap();
        assert!(auto.allocation.run_seed > 0, "未给种子时必须生成并回报（可复现诊断）");
    }

    #[test]
    fn plan_runs_in_generate_mode_without_dataset() {
        let mut inputs = plan_inputs(2, 3, 0);
        inputs.allocation.mode = Some("generate".to_owned());
        inputs.dataset = PlanDatasetInput::default();
        let plan = build_run_plan(&inputs, &RiskReport::default()).unwrap();
        assert!(plan.ok, "生成型不该因缺数据红条");
        assert_eq!(plan.dataset.size, 0);
        assert!(plan.rows.iter().all(|row| row.record.source == "generate"));
        assert!(plan.rows.iter().all(|row| row.record.index.is_none()));
        let previews: Vec<&str> = plan
            .rows
            .iter()
            .map(|row| row.record.preview.get("seed").and_then(|v| v.as_str()).unwrap_or(""))
            .collect();
        assert!(
            previews.iter().all(|text| text.contains("唯一序号")),
            "生成型预览要明确写出种子与唯一序号"
        );
    }

    #[test]
    fn plan_warns_when_new_tabs_exceed_limit() {
        let plan = build_run_plan(&plan_inputs(3, 10, 0), &RiskReport::default()).unwrap();
        assert!(plan.totals.planned_new_tabs as i64 > REPLAY_TAB_LIMIT);
        assert!(plan.warnings.iter().any(|entry| entry.code == "tab_limit"));
        assert!(plan.ok, "标签超限是黄条：允许，但必须可见");
    }

    #[test]
    fn plan_hash_can_be_recomputed_from_serialized_plan() {
        let plan = build_run_plan(&plan_inputs(2, 2, 4), &RiskReport::default()).unwrap();
        let json = serde_json::to_string(&plan).unwrap();
        let parsed: RunPlan = serde_json::from_str(&json).unwrap();
        assert_eq!(plan.plan_hash, compute_plan_hash(&parsed));
        assert!(verify_plan_hash(&plan.plan_hash, &parsed).is_ok());
        // 任何行被篡改 → 重算即发现
        let mut tampered = parsed.clone();
        tampered.rows[0].record.index = Some(3);
        assert!(verify_plan_hash(&plan.plan_hash, &tampered).is_err());
    }
}
