use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: i64,
    pub name: String,
    pub proxy_id: Option<i64>,
    pub custom_proxy: Option<String>,
    pub cdp_port: Option<i64>,
    pub status: String,
    pub fraud_score: i64,
    pub fraud_details: Option<String>,
    pub theme_color: String,
    pub created_at: String,
    #[serde(default = "default_true")]
    pub use_geoip: bool,
    #[serde(default = "default_true")]
    pub humanize: bool,
    #[serde(default)]
    pub fingerprint_seed: String,
    #[serde(default = "default_stealth_preset")]
    pub stealth_preset: String,
    #[serde(default)]
    pub interactive_element_extract_enabled: bool,
    /// Agent 观察是否附带多帧低质量视口截图（关=零截图）
    #[serde(default)]
    pub agent_panorama_enabled: bool,
    #[serde(default = "default_webgl_mode")]
    pub webgl_mode: String,
    #[serde(default)]
    pub browser_version: String,
    /// Milestone 3：环境核心人设 JSON（姓名/生日/性别等），由 Agent 首次生成后落盘复用
    #[serde(default)]
    pub persona_data: Option<String>,
    /// 启动时额外打开的网站 JSON 数组（首位永远由引擎强制 BrowserScan）
    #[serde(default)]
    pub startup_urls: String,
    /// P1.1：邮箱 OTP 通道绑定 JSON（仅 secretRef 句柄，不含密码明文）
    #[serde(default)]
    pub otp_channel: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_stealth_preset() -> String {
    "default".to_owned()
}

fn default_webgl_mode() -> String {
    "local".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartProfileResult {
    pub profile_id: String,
    pub cdp_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_geo: Option<ProfileIpGeo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proxy {
    pub id: i64,
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: i64,
    pub username: Option<String>,
    pub password: Option<String>,
    pub api_config: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddProxyInput {
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: i64,
    pub username: Option<String>,
    pub password: Option<String>,
    pub api_config: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicApiProxyInput {
    pub api_url: String,
    pub protocol: String,
    pub region: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProfileInput {
    pub name: String,
    pub theme_color: Option<String>,
    pub proxy_id: Option<i64>,
    pub custom_proxy: Option<String>,
    #[serde(default = "default_true")]
    pub use_geoip: bool,
    #[serde(default = "default_true")]
    pub humanize: bool,
    pub fingerprint_seed: Option<String>,
    #[serde(default = "default_stealth_preset")]
    pub stealth_preset: String,
    #[serde(default = "default_webgl_mode")]
    pub webgl_mode: String,
    #[serde(default)]
    pub browser_version: Option<String>,
    /// 额外启动网址 JSON 数组字符串，如 `["https://a.com","https://b.com"]`
    #[serde(default)]
    pub startup_urls: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchCreateProfilesInput {
    pub prefix: String,
    pub count: u32,
    pub theme_color: Option<String>,
    #[serde(default)]
    pub proxy_strategy: Option<String>,
    pub proxy_id: Option<i64>,
    pub sequential_host: Option<String>,
    pub sequential_start_port: Option<u32>,
    pub sequential_proxy_type: Option<String>,
    #[serde(default = "default_webgl_mode")]
    pub webgl_mode: String,
    #[serde(default = "default_stealth_preset")]
    pub stealth_preset: String,
    #[serde(default)]
    pub startup_urls: Option<String>,
    #[serde(default)]
    pub browser_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateProfileInput {
    pub id: i64,
    pub name: String,
    pub theme_color: Option<String>,
    pub proxy_id: Option<i64>,
    pub custom_proxy: Option<String>,
    #[serde(default = "default_true")]
    pub use_geoip: bool,
    #[serde(default = "default_true")]
    pub humanize: bool,
    pub fingerprint_seed: Option<String>,
    #[serde(default = "default_stealth_preset")]
    pub stealth_preset: String,
    #[serde(default = "default_webgl_mode")]
    pub webgl_mode: String,
    #[serde(default)]
    pub browser_version: Option<String>,
    #[serde(default)]
    pub startup_urls: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileIpGeo {
    pub profile_id: String,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub country_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchDeleteResult {
    pub deleted_ids: Vec<String>,
    pub skipped_running_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormTemplate {
    pub id: i64,
    pub domain: String,
    pub template_name: String,
    pub actions: String,
    pub auto_apply: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTrajectory {
    pub id: i64,
    pub domain: String,
    pub title: String,
    pub goal: String,
    pub start_url: String,
    pub actions: String,
    pub created_at: String,
    /// 文件落盘绝对路径（file 源）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_count: Option<u32>,
    /// "file" | "db"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// 轨迹列表结果。
///
/// 文件层（`agent_exports/trajectories`）是权威来源，SQLite 为独立补充。文件层不可读时
/// 不能降级成「空列表」——那会让用户以为录制丢失；但 SQLite 行仍应照常展示，
/// 因此把失败原因单独回传，由 UI 明确告知「已降级」。
#[derive(Debug, Clone, Serialize)]
pub struct TrajectoryListResult {
    pub rows: Vec<AgentTrajectory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_error: Option<String>,
}

/// 同站控件跨任务记忆（脱敏：仅 selector + 意图，无填表值）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentControlMemory {
    pub id: i64,
    pub domain: String,
    pub intent: String,
    pub intent_key: String,
    pub kind: String,
    pub selector: String,
    pub text_hint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_percent: Option<f64>,
    pub hit_count: i64,
    pub updated_at: String,
}

/// P4.3：持久 Agent Run History（摘要；不含 OTP/密钥明文）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRun {
    pub id: i64,
    pub run_id: String,
    pub profile_id: String,
    pub goal: String,
    pub start_url: String,
    pub domain: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    pub summary: String,
    pub step_count: i64,
    pub hitl_occurred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trajectory_id: Option<i64>,
    /// JSON 数组：[{ts,text}, ...] 已脱敏
    pub thought_summary: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub created_at: String,
    /// P5.4：供应商 usage 累计（不是按字符估算）
    #[serde(default)]
    pub prompt_tokens: i64,
    #[serde(default)]
    pub completion_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
    /// 估算费用，单位 micro-USD（1 USD = 1_000_000）。不是账单。
    #[serde(default)]
    pub estimated_cost_micro_usd: i64,
    #[serde(default)]
    pub llm_calls: i64,
    #[serde(default)]
    pub llm_model: String,
    #[serde(default)]
    pub cost_used_default_rate: bool,
    #[serde(default)]
    pub failure_class: String,
    /// JSON 对象：失败 kind → 次数。不含 OTP / 密钥。
    #[serde(default = "default_failure_counts")]
    pub failure_counts: String,
}

fn default_failure_counts() -> String {
    "{}".to_owned()
}

/// P5.4：结束摘要上的 token / 费用 / 失败分类（已脱敏）
#[derive(Debug, Clone)]
pub struct AgentRunFinishStats {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub estimated_cost_micro_usd: i64,
    pub llm_calls: i64,
    pub llm_model: String,
    pub cost_used_default_rate: bool,
    pub failure_class: String,
    pub failure_counts: String,
}

/// P5.4：运行历史看板合计（同一张 agent_runs，不是第二套表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRunBoard {
    pub run_count: i64,
    pub finished_count: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub estimated_cost_micro_usd: i64,
    pub cost_used_default_rate: bool,
    /// 未成功运行的主失败类 → 次数
    pub failure_classes: String,
    /// 动作失败 kind → 次数（含后来成功的运行）
    pub failure_events: String,
}

impl AgentRunFinishStats {
    pub fn from_event(value: &serde_json::Value) -> Self {
        let prompt_tokens = event_nonneg(value, "promptTokens");
        let completion_tokens = event_nonneg(value, "completionTokens");
        let mut total_tokens = event_nonneg(value, "totalTokens");
        if total_tokens == 0 && (prompt_tokens > 0 || completion_tokens > 0) {
            total_tokens = prompt_tokens.saturating_add(completion_tokens);
        }
        Self {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            estimated_cost_micro_usd: event_nonneg(value, "estimatedCostMicroUsd"),
            llm_calls: event_nonneg(value, "llmCalls"),
            llm_model: sanitize_llm_model(value.get("llmModel").and_then(|v| v.as_str()).unwrap_or("")),
            cost_used_default_rate: value
                .get("costUsedDefaultRate")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            failure_class: sanitize_failure_class(
                value.get("failureClass").and_then(|v| v.as_str()).unwrap_or(""),
            ),
            failure_counts: sanitize_failure_counts_value(value.get("failureCounts")),
        }
    }
}

fn event_nonneg(value: &serde_json::Value, key: &str) -> i64 {
    let Some(raw) = value.get(key) else {
        return 0;
    };
    let n = if let Some(i) = raw.as_i64() {
        i
    } else if let Some(u) = raw.as_u64() {
        i64::try_from(u).unwrap_or(i64::MAX)
    } else if let Some(f) = raw.as_f64() {
        if f.is_finite() {
            f.floor() as i64
        } else {
            0
        }
    } else {
        0
    };
    n.max(0)
}

fn is_board_label(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 40 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    if !bytes
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
    {
        return false;
    }
    let mut digit_run = 0u8;
    for c in bytes {
        if c.is_ascii_digit() {
            digit_run = digit_run.saturating_add(1);
            if digit_run >= 4 {
                return false;
            }
        } else {
            digit_run = 0;
        }
    }
    const BLOCKED: &[&str] = &["otp", "secret", "password", "apikey", "token", "cvv", "sk-"];
    !BLOCKED.iter().any(|word| value.contains(word))
}

fn sanitize_failure_class(raw: &str) -> String {
    let value = raw.trim();
    if is_board_label(value) {
        value.to_owned()
    } else {
        String::new()
    }
}

fn sanitize_llm_model(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() || value.len() > 80 || value.contains("***") {
        return String::new();
    }
    if value.to_ascii_lowercase().contains("sk-") {
        return String::new();
    }
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'))
    {
        value.to_owned()
    } else {
        String::new()
    }
}

fn sanitize_failure_counts_value(raw: Option<&serde_json::Value>) -> String {
    let Some(raw) = raw else {
        return "{}".to_owned();
    };
    let object = if let Some(map) = raw.as_object() {
        Some(map.clone())
    } else if let Some(text) = raw.as_str() {
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|v| v.as_object().cloned())
    } else {
        None
    };
    let Some(object) = object else {
        return "{}".to_owned();
    };
    let mut clean = serde_json::Map::new();
    for (key, value) in object {
        if clean.len() >= 24 || !is_board_label(&key) {
            continue;
        }
        let Some(n) = value.as_i64() else {
            continue;
        };
        if n <= 0 {
            continue;
        }
        clean.insert(key, serde_json::json!(n.min(100_000)));
    }
    serde_json::Value::Object(clean).to_string()
}
