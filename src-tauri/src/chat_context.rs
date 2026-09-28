//! 聊天模式上下文：索引表（`chat_threads`）+ 上下文统计与清理。
//!
//! **权威分层**（§4.2 / §5.7 / §10）：
//! - **文件**是该联系人上下文的**唯一权威**：`chat_context/{site}/{contact}/` 由 Sidecar
//!   写入（`thread.jsonl` / `visit.json` / `summary.json` / `angles.json` / `facts.json`）。
//! - **DB 表 `chat_threads`** 只是**索引/编排视图**：给 UI 列表与回访调度器（P8）用，
//!   由本模块从文件**同步**而来。Host 不自己发明联系人状态，只镜像 Sidecar 写下的结果。
//! - 这种「Sidecar 写文件 / Host 读文件」的分工避免了两套互相打架的状态机（§7.1）。
//!   **唯一例外**：清理某联系人/某站点的上下文时，Host 要把被清掉的联系人从 `state.json`
//!   里摘掉（`forget_snapshot_contacts`）—— 否则「清理了却还显示已接管」与承诺相反。
//!
//! 落点在 `userDataDir`（`browser-profiles/profile-{id}`）之内。环境删除时必须走
//! `forget_profile_chat_on_delete`（索引 + 目录 + `chat_mode.targetsByEnv`）再
//! `purge_profile_user_data_dir`（整棵 userData，含学来的描述符）—— 只删库行会留下
//! 磁盘记忆与设置幽灵键，ID 复用后新环境会继承旧聊天（§0.5.3 J）。
//!
//! 路径段清洗必须与 TS 侧 `context_store.ts::sanitizeSegment` **逐字一致**：
//! 两边不一致就会出现「Sidecar 写进 A 目录、Host 去 B 目录找」的静默空转（§0.5.3 F）。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::db;
use crate::error::AppError;
use crate::fill_sidecar::resolve_profile_user_data_dir;

pub const CHAT_CONTEXT_DIR: &str = "chat_context";
const SEGMENT_MAX_CHARS: usize = 96;

/* ————————————————————————— 路径 ————————————————————————— */

/// 与 TS `sanitizeSegment` 逐字一致的路径段清洗（**安全关键**：挡住 `../` 逃逸）。
pub fn sanitize_segment(raw: &str, fallback: &str) -> String {
    let base = raw.trim();
    let source = if base.is_empty() { fallback } else { base };

    let mut mapped = String::with_capacity(source.len());
    for ch in source.chars() {
        let bad = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || (ch as u32) < 0x20;
        mapped.push(if bad { '_' } else { ch });
    }

    // `\.\.+` → `_`：先把连续的 2 个以上点折叠成下划线
    let mut collapsed = String::with_capacity(mapped.len());
    let mut dot_run = 0usize;
    for ch in mapped.chars() {
        if ch == '.' {
            dot_run += 1;
            continue;
        }
        if dot_run >= 2 {
            collapsed.push('_');
        } else if dot_run == 1 {
            collapsed.push('.');
        }
        dot_run = 0;
        collapsed.push(ch);
    }
    if dot_run >= 2 {
        collapsed.push('_');
    } else if dot_run == 1 {
        collapsed.push('.');
    }

    let trimmed = collapsed
        .trim_start_matches(|c: char| c == '.' || c.is_whitespace())
        .trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    let clipped: String = trimmed.chars().take(SEGMENT_MAX_CHARS).collect();

    if clipped.is_empty() {
        fallback.to_owned()
    } else {
        clipped
    }
}

/// `browser-profiles/profile-{id}/chat_context`
pub fn chat_context_root(app: &AppHandle, profile_id: &str) -> Result<PathBuf, AppError> {
    Ok(resolve_profile_user_data_dir(app, profile_id)?.join(CHAT_CONTEXT_DIR))
}

/// `.../chat_context/{site}/{contact}`
pub fn contact_dir(profile_user_dir: &Path, site_key: &str, contact_key: &str) -> PathBuf {
    profile_user_dir
        .join(CHAT_CONTEXT_DIR)
        .join(sanitize_segment(site_key, "unknown-site"))
        .join(sanitize_segment(contact_key, "unknown-contact"))
}

/* ————————————————————————— 磁盘读取 ————————————————————————— */

#[derive(Debug, Clone, Default, Deserialize)]
struct VisitFile {
    #[serde(default)]
    label: String,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    follow_up_index: Option<i64>,
    #[serde(default)]
    next_due_at: Option<String>,
    #[serde(default)]
    last_contact_at: Option<String>,
    #[serde(default)]
    last_reply_at: Option<String>,
    #[serde(default)]
    stopped: Option<bool>,
    #[serde(default)]
    stop_reason: Option<String>,
}

fn read_visit(dir: &Path) -> VisitFile {
    let path = dir.join("visit.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return VisitFile::default();
    };
    // 损坏即视为「没有历史」：不猜、不崩（下次同步会重写）
    serde_json::from_str::<VisitFile>(&text).unwrap_or_default()
}

/// 数会话流水条数。JSONL 数非空行；裁尾后的 JSON 数组按长度算（与 TS 落盘形态一致）。
fn count_messages(dir: &Path) -> i64 {
    let path = dir.join("thread.jsonl");
    let Ok(text) = fs::read_to_string(&path) else {
        return 0;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    if trimmed.starts_with('[') {
        return serde_json::from_str::<Vec<Value>>(trimmed)
            .map(|rows| rows.len() as i64)
            .unwrap_or(0);
    }
    trimmed.lines().filter(|line| !line.trim().is_empty()).count() as i64
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            total = total.saturating_add(dir_size(&entry.path()));
        } else {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// 扫出该环境已登记上下文的全部联系人目录（只读目录名，不重建路径）。
fn scan_contact_dirs(root: &Path) -> Vec<(String, String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(site_entries) = fs::read_dir(root) else {
        return out;
    };
    for site_entry in site_entries.flatten() {
        if !site_entry.path().is_dir() {
            continue;
        }
        let site_key = site_entry.file_name().to_string_lossy().to_string();
        // `state.json` 与临时文件不是站点目录；chats 站点目录名必定是清洗过的段
        if site_key.ends_with(".json") || site_key.ends_with(".tmp") {
            continue;
        }
        let Ok(contact_entries) = fs::read_dir(site_entry.path()) else {
            continue;
        };
        for contact_entry in contact_entries.flatten() {
            if !contact_entry.path().is_dir() {
                continue;
            }
            out.push((
                site_key.clone(),
                contact_entry.file_name().to_string_lossy().to_string(),
                contact_entry.path(),
            ));
        }
    }
    out
}

/* ————————————————————————— 索引表 ————————————————————————— */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadRow {
    pub profile_id: i64,
    pub site_key: String,
    pub contact_key: String,
    pub contact_label: String,
    pub stage: String,
    pub follow_up_index: i64,
    pub message_count: i64,
    pub last_contact_at: Option<String>,
    pub last_reply_at: Option<String>,
    pub next_due_at: Option<String>,
    pub stopped: bool,
    pub stop_reason: Option<String>,
    /// 人工接管模式（`engine` | `human` | `paused`）；来源是引擎快照，不是索引表
    pub takeover: String,
    pub takeover_reason: Option<String>,
    /// 每联系人开关（§5.7）：对方来消息时引擎回不回；来源同样是引擎快照。**缺省＝开**
    pub auto_reply: bool,
    /// 每联系人开关：到点要不要主动找话（定时回访）。**缺省＝开**
    pub follow_up: bool,
}

// 注意：`ChatThreadRow` **只序列化**（Host → 前端），所以 `#[serde(default = ...)]` 在这里
// 不起作用 —— 「缺省＝开 / 缺省 engine」是在**构造这一行**时落实的：`read_contact_overlays`
// 里 `bool_at(..).unwrap_or(true)`，以及本文件 `takeover: default_takeover()`。
// 别再加回 inert 的 serde 默认值属性（会被编译器判为死代码，也让人误以为有兜底）。
fn default_takeover() -> String {
    "engine".to_owned()
}

/// 把某环境的磁盘上下文同步进 `chat_threads`（upsert + 删除已消失的线程）。
///
/// 幂等：可重复调用。返回同步后的线程数。
pub fn sync_chat_threads(
    app: &AppHandle,
    connection: &Connection,
    profile_id: &str,
) -> Result<usize, AppError> {
    let numeric_id: i64 = profile_id
        .trim()
        .parse()
        .map_err(|_| AppError::Validation(format!("invalid profile id: {profile_id}")))?;
    let root = chat_context_root(app, profile_id)?;

    let rows = scan_contact_dirs(&root);
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for (site_key, contact_key, dir) in &rows {
        let visit = read_visit(dir);
        let stage = visit.stage.unwrap_or_else(|| "cold".to_owned());
        let follow_up_index = visit.follow_up_index.unwrap_or(0).max(0);
        let stopped = visit.stopped.unwrap_or(false);
        let message_count = count_messages(dir);

        connection.execute(
            r#"INSERT INTO chat_threads (
                   profile_id, site_key, contact_key, contact_label, stage,
                   follow_up_index, message_count, last_contact_at, last_reply_at,
                   next_due_at, stopped, stop_reason, last_synced_at
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, CURRENT_TIMESTAMP)
               ON CONFLICT(profile_id, site_key, contact_key) DO UPDATE SET
                   contact_label = excluded.contact_label,
                   stage = excluded.stage,
                   follow_up_index = excluded.follow_up_index,
                   message_count = excluded.message_count,
                   last_contact_at = excluded.last_contact_at,
                   last_reply_at = excluded.last_reply_at,
                   next_due_at = excluded.next_due_at,
                   stopped = excluded.stopped,
                   stop_reason = excluded.stop_reason,
                   last_synced_at = CURRENT_TIMESTAMP"#,
            params![
                numeric_id,
                site_key,
                contact_key,
                visit.label,
                stage,
                follow_up_index,
                message_count,
                visit.last_contact_at,
                visit.last_reply_at,
                visit.next_due_at,
                if stopped { 1 } else { 0 },
                visit.stop_reason,
            ],
        )?;
        seen.insert((site_key.clone(), contact_key.clone()));
    }

    // 清掉磁盘上已经不存在的线程（用户清过上下文 / 手删了目录）
    let existing: Vec<(String, String)> = {
        let mut statement = connection
            .prepare("SELECT site_key, contact_key FROM chat_threads WHERE profile_id = ?1")?;
        let mapped = statement.query_map(params![numeric_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };
    for (site_key, contact_key) in existing {
        if !seen.contains(&(site_key.clone(), contact_key.clone())) {
            connection.execute(
                "DELETE FROM chat_threads WHERE profile_id = ?1 AND site_key = ?2 AND contact_key = ?3",
                params![numeric_id, site_key, contact_key],
            )?;
        }
    }

    Ok(seen.len())
}

/// 读取某环境的线程索引（先同步再查，保证 UI 看到的就是磁盘上的事实）。
pub fn list_chat_threads(
    app: &AppHandle,
    connection: &Connection,
    profile_id: &str,
) -> Result<Vec<ChatThreadRow>, AppError> {
    sync_chat_threads(app, connection, profile_id)?;
    let numeric_id: i64 = profile_id
        .trim()
        .parse()
        .map_err(|_| AppError::Validation(format!("invalid profile id: {profile_id}")))?;

    let mut statement = connection.prepare(
        r#"SELECT profile_id, site_key, contact_key, contact_label, stage,
                  follow_up_index, message_count, last_contact_at, last_reply_at,
                  next_due_at, stopped, stop_reason
             FROM chat_threads
            WHERE profile_id = ?1
            ORDER BY stopped ASC, message_count DESC, contact_label ASC"#,
    )?;
    let mapped = statement.query_map(params![numeric_id], |row| {
        Ok(ChatThreadRow {
            profile_id: row.get(0)?,
            site_key: row.get(1)?,
            contact_key: row.get(2)?,
            contact_label: row.get(3)?,
            stage: row.get(4)?,
            follow_up_index: row.get(5)?,
            message_count: row.get(6)?,
            last_contact_at: row.get(7)?,
            last_reply_at: row.get(8)?,
            next_due_at: row.get(9)?,
            stopped: row.get::<_, i64>(10)? != 0,
            stop_reason: row.get(11)?,
            takeover: default_takeover(),
            takeover_reason: None,
            auto_reply: true,
            follow_up: true,
        })
    })?;
    let mut rows = mapped.collect::<Result<Vec<_>, _>>()?;
    // 接管模式与每联系人开关都来自引擎快照（不是索引表；索引表只存磁盘上的回访事实）
    let overlays = read_chat_contact_overlays(app, profile_id)?;
    apply_contact_overlays(&mut rows, &overlays);
    Ok(rows)
}

/// 把快照里的覆盖层（接管模式 + 每联系人开关）贴到索引表行上（纯函数，好单测）。
///
/// 键必须与 `chat_threads` 的行身份**同一套**：站点目录名 + 联系人目录名，两边都过
/// `sanitize_segment`（见 [`thread_key_of`]）。以前这里直接拿快照的原始键（`unknown|Anne`）
/// 去撞目录名（`unknown_Anne`）→ **永远匹配不上** → 卡片显示默认值，与引擎实际行为相反
/// （§0.5.3 H「卡片与日志口径不一致」）。同一文件里的 `forget_snapshot_contacts`
/// 早就这么清洗了，这里属于漏改。
pub fn apply_contact_overlays(rows: &mut [ChatThreadRow], overlays: &[ChatContactOverlay]) {
    if overlays.is_empty() {
        return;
    }
    let by_key: HashMap<(&str, &str), &ChatContactOverlay> = overlays
        .iter()
        .map(|entry| ((entry.site_key.as_str(), entry.contact_key.as_str()), entry))
        .collect();
    for row in rows.iter_mut() {
        let key = (row.site_key.as_str(), row.contact_key.as_str());
        if let Some(overlay) = by_key.get(&key) {
            row.takeover = overlay.takeover.clone();
            row.takeover_reason = overlay.takeover_reason.clone();
            row.auto_reply = overlay.auto_reply;
            row.follow_up = overlay.follow_up;
        }
    }
}

/* ————————————————————————— 运行快照（引擎 phase / 下次回访） ————————————————————————— */

/// 引擎快照里的**运行态**（`chat_context/state.json`）。
///
/// 为什么 Host 读文件而不是问 Sidecar：`chat_status` 必须在**没有活会话**时也能答
/// （用户刚打开视图、聊天早已收工）。Sidecar 只在自己活着时才记得相位；文件是耐久事实，
/// 与 §10「文件是唯一权威」一致。Host 平时只读不写（**唯一例外**：清理上下文时把被清掉的
/// 联系人从快照里摘掉，见 `forget_snapshot_contacts`），不另起一套状态机（§7.1）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRuntimeStatus {
    pub phase: String,
    pub next_wake_at: Option<String>,
    pub progress_counter: i64,
    pub contact_count: i64,
    pub sent_today: i64,
    pub sent_total: i64,
    pub rejected_today: i64,
    pub llm_calls_today: i64,
}

/// 快照里一位联系人的**覆盖层**（接管模式 + 每联系人开关），Host 只读。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContactOverlay {
    /// 站点**目录段**（与 `chat_threads.site_key` 同一套清洗）
    pub site_key: String,
    /// 联系人**目录段**（与 `chat_threads.contact_key` 同一套清洗）
    pub contact_key: String,
    /// `engine` | `human` | `paused`（缺省 engine）
    pub takeover: String,
    pub takeover_reason: Option<String>,
    /// 每联系人开关（§5.7）。**缺省＝开**：老快照没有这两个字段时行为不变。
    pub auto_reply: bool,
    pub follow_up: bool,
}

/// 快照里的一位联系人 → `chat_threads` 的行身份（**站点目录段 + 联系人目录段**）。
///
/// 两次清洗都与 `sanitize_segment` / `forget_snapshot_contacts` 同一规则：
/// 快照存的是原始值（`key = "unknown|Anne"`），索引表存的是目录名（`unknown_Anne`），
/// 不清洗直接 join 就会**永远匹配不上**（§0.5.3 H「卡片与日志口径相反」）。
pub fn thread_key_of(snapshot_site: Option<&str>, snapshot_key: &str) -> (String, String) {
    (
        snapshot_site
            .map(|value| sanitize_segment(value, "unknown-site"))
            .unwrap_or_else(|| "unknown-site".to_owned()),
        sanitize_segment(snapshot_key, "unknown-contact"),
    )
}

/// 读引擎快照里每个联系人的覆盖层（**键统一清洗成目录段**，与 `chat_threads` 同源可对）。
///
/// 为什么接管模式与开关读快照而不是读 `visit.json`：快照是引擎的耐久状态（`state.ts` 是唯一
/// schema 权威），接管与「谁说哪种话」都是运行态，跟回访状态分开。文件不存在就返回空表
/// （= 都是 engine / 两个开关都开）。
pub fn read_chat_contact_overlays(
    app: &AppHandle,
    profile_id: &str,
) -> Result<Vec<ChatContactOverlay>, AppError> {
    let path = chat_context_root(app, profile_id)?.join("state.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let Some(rows) = value.get("contacts").and_then(Value::as_array) else {
        return Ok(out);
    };
    for row in rows {
        let Some(key) = str_at(row, "/key") else {
            continue;
        };
        let (site_key, contact_key) = thread_key_of(str_at(row, "/siteKey").as_deref(), &key);
        let mode = str_at(row, "/takeover").unwrap_or_else(|| "engine".to_owned());
        let mode = match mode.as_str() {
            "human" | "paused" => mode,
            _ => "engine".to_owned(),
        };
        out.push(ChatContactOverlay {
            site_key,
            contact_key,
            takeover: mode,
            takeover_reason: str_at(row, "/takeoverReason"),
            // **只有真正的布尔才表态**，其余一律按「缺省＝开」（与 `state.ts::autoReplyOf`
            // 同一口径：`undefined` / 坏值都表示「回」）。老快照没有这两个字段 → 开。
            auto_reply: bool_at(row, "/autoReply").unwrap_or(true),
            follow_up: bool_at(row, "/followUp").unwrap_or(true),
        });
    }
    Ok(out)
}

fn str_at(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn i64_at(value: &Value, pointer: &str) -> i64 {
    value.pointer(pointer).and_then(Value::as_i64).unwrap_or(0)
}

/// 只认真正的布尔；其余（字符串 `"false"`、数字、null）一律 `None`，交给调用方用缺省值。
/// 与 `chat_patrol::truthy` 同一条纪律：**拼错的值不许静默表达一个态度**（§0.5.3 C）。
fn bool_at(value: &Value, pointer: &str) -> Option<bool> {
    value.pointer(pointer).and_then(Value::as_bool)
}

/// 读引擎快照。**文件不存在或损坏一律返回 `None`**（= 从没跑过），不猜、不崩。
pub fn read_chat_runtime_status(
    app: &AppHandle,
    profile_id: &str,
) -> Result<Option<ChatRuntimeStatus>, AppError> {
    let path = chat_context_root(app, profile_id)?.join("state.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Ok(None);
    };

    Ok(Some(ChatRuntimeStatus {
        phase: str_at(&value, "/engine/phase").unwrap_or_else(|| "stopped".to_owned()),
        next_wake_at: str_at(&value, "/engine/nextWakeAt"),
        progress_counter: i64_at(&value, "/engine/progressCounter"),
        contact_count: value
            .get("contacts")
            .and_then(Value::as_array)
            .map(|rows| rows.len() as i64)
            .unwrap_or(0),
        sent_today: i64_at(&value, "/counters/sentToday"),
        sent_total: i64_at(&value, "/counters/sentTotal"),
        rejected_today: i64_at(&value, "/counters/rejectedToday"),
        llm_calls_today: i64_at(&value, "/counters/llmCallsToday"),
    }))
}

/* ————————————————————————— 会话流水读取（视图展开用） ————————————————————————— */

/// 一条已脱敏的会话流水（`thread.jsonl` 的一行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadMessage {
    pub id: String,
    pub direction: String,
    pub text: String,
    pub ts: Option<String>,
    pub at: Option<String>,
}

/// 读某联系人会话流水的**尾部** `limit` 条（时间正序，与 TS `readThreadMessages` 同源）。
///
/// `limit` 有硬顶（500）：视图是给人看的，不是导出通道；不该让一次展开把整个 JSONL 读进内存。
pub fn read_chat_thread_messages(
    app: &AppHandle,
    profile_id: &str,
    site_key: &str,
    contact_key: &str,
    limit: i64,
) -> Result<Vec<ChatThreadMessage>, AppError> {
    let root = chat_context_root(app, profile_id)?;
    Ok(read_thread_messages_from(&contact_dir(&root, site_key, contact_key), limit))
}

/// 纯读取（便于测试）：解析 JSONL、跳坏行、取尾部 `cap` 条。
fn read_thread_messages_from(dir: &Path, limit: i64) -> Vec<ChatThreadMessage> {
    let path = dir.join("thread.jsonl");
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };

    let mut out: Vec<ChatThreadMessage> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 损坏行单独跳过（与 TS 侧一致），不让一行坏数据毁掉整段会话
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        let text_body = value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if id.is_empty() && text_body.is_empty() {
            continue;
        }
        out.push(ChatThreadMessage {
            id,
            direction: value
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("in")
                .to_owned(),
            text: text_body,
            ts: str_at(&value, "/ts"),
            at: str_at(&value, "/at"),
        });
    }

    // 旧版裁尾可能留下 JSON 数组形态：这种情况下整段都在同一行，逐行解析会全军覆没
    if out.is_empty() {
        if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
            if let Some(rows) = value.as_array() {
                for row in rows {
                    let id = row
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_owned();
                    let text_body = row.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
                    if id.is_empty() && text_body.is_empty() {
                        continue;
                    }
                    out.push(ChatThreadMessage {
                        id,
                        direction: row
                            .get("direction")
                            .and_then(Value::as_str)
                            .unwrap_or("in")
                            .to_owned(),
                        text: text_body,
                        ts: str_at(row, "/ts"),
                        at: str_at(row, "/at"),
                    });
                }
            }
        }
    }

    let cap = limit.clamp(1, 500) as usize;
    if out.len() > cap {
        out.drain(..out.len() - cap);
    }
    out
}

/* ————————————————————————— 统计与清理 ————————————————————————— */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContextContactStat {
    pub site_key: String,
    pub contact_key: String,
    pub label: String,
    pub stage: String,
    pub follow_up_index: i64,
    pub message_count: i64,
    pub next_due_at: Option<String>,
    pub stopped: bool,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContextStats {
    pub profile_id: String,
    pub contact_count: usize,
    pub scheduled_count: usize,
    pub stopped_count: usize,
    pub message_count: i64,
    pub bytes: u64,
    pub contacts: Vec<ChatContextContactStat>,
}

pub fn chat_context_stats(app: &AppHandle, profile_id: &str) -> Result<ChatContextStats, AppError> {
    let root = chat_context_root(app, profile_id)?;
    let rows = scan_contact_dirs(&root);

    let mut contacts = Vec::with_capacity(rows.len());
    let mut message_count = 0i64;
    let mut bytes = 0u64;
    let mut scheduled_count = 0usize;
    let mut stopped_count = 0usize;

    for (site_key, contact_key, dir) in rows {
        let visit = read_visit(&dir);
        let stage = visit.stage.clone().unwrap_or_else(|| "cold".to_owned());
        let stopped = visit.stopped.unwrap_or(false);
        let follow_up_index = visit.follow_up_index.unwrap_or(0).max(0);
        let messages = count_messages(&dir);
        let size = dir_size(&dir);

        message_count += messages;
        bytes = bytes.saturating_add(size);
        if stopped {
            stopped_count += 1;
        } else if visit.next_due_at.is_some() {
            scheduled_count += 1;
        }

        contacts.push(ChatContextContactStat {
            site_key,
            contact_key,
            label: visit.label,
            stage,
            follow_up_index,
            message_count: messages,
            next_due_at: visit.next_due_at.clone(),
            stopped,
            bytes: size,
        });
    }

    contacts.sort_by(|a, b| b.message_count.cmp(&a.message_count));
    Ok(ChatContextStats {
        profile_id: profile_id.to_owned(),
        contact_count: contacts.len(),
        scheduled_count,
        stopped_count,
        message_count,
        bytes,
        contacts,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeChatContextReport {
    pub profile_id: String,
    pub removed_dirs: usize,
    pub freed_bytes: u64,
    pub scope: String,
    pub details: Vec<String>,
}

/// 删除上下文（三种粒度：整环境 / 某站点 / 某联系人）。
///
/// 前提：调用方**必须**先确认该环境的聊天引擎没在跑（见命令层的 `chatRunning` 校验），
/// 否则会把正在写的文件从底下抽掉。
pub fn purge_chat_context(
    app: &AppHandle,
    connection: &Connection,
    profile_id: &str,
    site_key: Option<&str>,
    contact_key: Option<&str>,
) -> Result<PurgeChatContextReport, AppError> {
    let root = chat_context_root(app, profile_id)?;
    let mut report = PurgeChatContextReport {
        profile_id: profile_id.to_owned(),
        removed_dirs: 0,
        freed_bytes: 0,
        scope: "profile".to_owned(),
        details: Vec::new(),
    };

    if !root.exists() {
        report.details.push("该环境尚无聊天上下文".to_owned());
        return Ok(report);
    }

    let site = site_key
        .map(|value| sanitize_segment(value, "unknown-site"))
        .filter(|value| !value.is_empty());
    let contact = contact_key
        .map(|value| sanitize_segment(value, "unknown-contact"))
        .filter(|value| !value.is_empty());

    let target = match (&site, &contact) {
        (None, _) => Some(root.clone()),
        (Some(site_key), None) => Some(root.join(site_key)),
        (Some(site_key), Some(contact_key)) => Some(root.join(site_key).join(contact_key)),
    };

    let Some(target) = target else {
        return Ok(report);
    };

    report.scope = match (&site, &contact) {
        (None, _) => "profile".to_owned(),
        (Some(_), None) => "site".to_owned(),
        (Some(_), Some(_)) => "contact".to_owned(),
    };

    if !target.exists() {
        report.details.push("目标上下文不存在".to_owned());
        return Ok(report);
    }

    report.freed_bytes = if target.is_dir() {
        dir_size(&target)
    } else {
        fs::metadata(&target).map(|m| m.len()).unwrap_or(0)
    };

    let outcome = if target.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    match outcome {
        Ok(()) => {
            report.removed_dirs = 1;
            report.details.push(format!("已删除 {}", target.display()));
        }
        Err(error) => {
            report
                .details
                .push(format!("删除失败 {}（{error}）", target.display()));
        }
    }

    // 索引表与会话流水一起清，避免 UI 读到已删线程的幽灵记录
    let numeric_id: i64 = profile_id
        .trim()
        .parse()
        .map_err(|_| AppError::Validation(format!("invalid profile id: {profile_id}")))?;
    match (&site, &contact) {
        (None, _) => {
            connection.execute("DELETE FROM chat_threads WHERE profile_id = ?1", params![numeric_id])?;
        }
        (Some(site_key), None) => {
            connection.execute(
                "DELETE FROM chat_threads WHERE profile_id = ?1 AND site_key = ?2",
                params![numeric_id, site_key],
            )?;
        }
        (Some(site_key), Some(contact_key)) => {
            connection.execute(
                "DELETE FROM chat_threads WHERE profile_id = ?1 AND site_key = ?2 AND contact_key = ?3",
                params![numeric_id, site_key, contact_key],
            )?;
        }
    }

    // 引擎快照里的**自有状态**（stage / followUpIndex / takeover）也要跟着清：
    // 只删目录会让被清掉的联系人继续「已由用户接管、引擎不开口」，与「聊天将从零开始」相反。
    // 整环境（site 为 None）时 `state.json` 已随目录一起删掉，这里自然什么也摘不到。
    if report.removed_dirs > 0 && site.is_some() {
        let forgotten = forget_snapshot_contacts(&root, site.as_deref(), contact.as_deref());
        if forgotten > 0 {
            report.details.push(format!(
                "已重置 {forgotten} 位联系人的引擎状态（含人工接管标记）"
            ));
        }
    }

    Ok(report)
}

/// 从引擎快照（`state.json`）里摘掉被清理掉的联系人，返回摘掉的数量。
///
/// **为什么 Host 要写这个文件**：`state.json` 里的 `stage` / `followUpIndex` / `takeover`
/// 是引擎的自有状态；删了联系人上下文却留着 `takeover: "human"`，视图就会继续显示
/// 「已由用户接管、引擎不开口」——用户点的「清理该联系人记忆」承诺的是「从零开始」，
/// 结果没从零开始（§0.5.3 B：用户看到的与真正生效的必须是一回事）。
///
/// **时序安全**：调用方 `purge_chat_context` 已经拒绝「引擎正忙」（聊天值守 / Agent 等在写），
/// 因此此刻不存在正在写这个文件的引擎。写入沿用原子写（tmp + rename），与 Sidecar 一致。
/// 文件不存在 / 解析失败 / 写盘失败 → 返回 0（不猜、不崩，也不假装成功）。
fn forget_snapshot_contacts(root: &Path, site: Option<&str>, contact: Option<&str>) -> usize {
    let path = root.join("state.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return 0;
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        return 0;
    };
    let Some(rows) = value.get("contacts").and_then(Value::as_array).cloned() else {
        return 0;
    };
    let total = rows.len();
    let kept: Vec<Value> = rows
        .into_iter()
        .filter(|row| {
            // 段名一律用**清洗后的目录名**比对（快照里存的是未清洗的会话键）
            let row_site = str_at(row, "/siteKey").map(|value| sanitize_segment(&value, "unknown-site"));
            let row_contact = str_at(row, "/key").map(|value| sanitize_segment(&value, "unknown-contact"));
            let site_match = site.map(|want| row_site.as_deref() == Some(want)).unwrap_or(true);
            let contact_match = contact
                .map(|want| row_contact.as_deref() == Some(want))
                .unwrap_or(true);
            !(site_match && contact_match)
        })
        .collect();
    let removed = total.saturating_sub(kept.len());
    if removed == 0 {
        return 0;
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("contacts".to_owned(), Value::Array(kept));
    }
    let serialized = match serde_json::to_string_pretty(&value) {
        Ok(text) => text,
        Err(_) => return 0,
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, serialized).is_err() {
        let _ = fs::remove_file(&tmp);
        return 0;
    }
    if fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
        return 0;
    }
    removed
}

/* ————————————————————————— 全局总览 ————————————————————————— */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEnvSummary {
    pub profile_id: String,
    pub profile_name: String,
    pub contact_count: usize,
    pub message_count: i64,
    pub bytes: u64,
    /// 该环境浏览器是否在跑（仅作展示；是否允许清由命令层按「引擎是否正忙」判定）
    pub running: bool,
}

/// 列出所有**有聊天上下文**的环境（设置里的清理入口用）。
///
/// 只统计已有的，不为了整齐而把每个环境都塞进列表 —— 用户看到的就是「真的有记忆」的环境。
pub fn list_chat_context_overview(
    app: &AppHandle,
    connection: &Connection,
    running_profile_ids: &HashSet<String>,
) -> Result<Vec<ChatEnvSummary>, AppError> {
    let profiles = db::list_profiles(connection)?;
    let mut out = Vec::new();

    for profile in profiles {
        let profile_id = profile.id.to_string();
        let Ok(root) = chat_context_root(app, &profile_id) else {
            continue;
        };
        if !root.exists() {
            continue;
        }
        let stats = chat_context_stats(app, &profile_id)?;
        if stats.contact_count == 0 {
            continue;
        }
        out.push(ChatEnvSummary {
            running: running_profile_ids.contains(&profile_id),
            profile_id,
            profile_name: profile.name,
            contact_count: stats.contact_count,
            message_count: stats.message_count,
            bytes: stats.bytes,
        });
    }

    out.sort_by(|a, b| b.message_count.cmp(&a.message_count));
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeAllChatContextReport {
    pub purged_profiles: usize,
    pub skipped_running: usize,
    pub removed_dirs: usize,
    pub freed_bytes: u64,
    pub details: Vec<String>,
}

/// 全量清理：逐个环境清掉 `chat_context`（**跳过引擎正忙的环境**，不静默失败）。
///
/// `busy_profile_ids` = 聊天值守 / Agent / 回放 / 填表正占着的环境（Host 互斥 waiter），
/// **不是**「浏览器开着」——开着但空闲时必须能清（否则删联系人记忆变成鸡肋）。
///
/// 额外扫尾：已删环境留下的孤儿目录 / 索引 / `targetsByEnv` 幽灵键一并清掉
/// （否则「全部清理」名不副实，ID 复用会串号）。
pub fn purge_all_chat_contexts(
    app: &AppHandle,
    connection: &Connection,
    busy_profile_ids: &HashSet<String>,
) -> Result<PurgeAllChatContextReport, AppError> {
    let profiles = db::list_profiles(connection)?;
    let mut report = PurgeAllChatContextReport {
        purged_profiles: 0,
        skipped_running: 0,
        removed_dirs: 0,
        freed_bytes: 0,
        details: Vec::new(),
    };

    let mut active_ids: HashSet<String> = HashSet::new();
    for profile in &profiles {
        let profile_id = profile.id.to_string();
        active_ids.insert(profile_id.clone());
        // 正忙的环境**整段记录原因**，而不是悄悄跳过（§0.5.3 B：禁止静默丢弃）
        if busy_profile_ids.contains(&profile_id) {
            report.skipped_running += 1;
            report.details.push(format!("跳过（引擎正忙）：{}", profile.name));
            continue;
        }
        let result = purge_chat_context(app, connection, &profile_id, None, None)?;
        if result.removed_dirs > 0 {
            report.purged_profiles += 1;
            report.removed_dirs += result.removed_dirs;
            report.freed_bytes = report.freed_bytes.saturating_add(result.freed_bytes);
            report.details.push(format!("已清理：{}", profile.name));
        }
    }

    let orphan = purge_orphan_chat_artifacts(app, connection, &active_ids)?;
    report.removed_dirs += orphan.removed_dirs;
    report.freed_bytes = report.freed_bytes.saturating_add(orphan.freed_bytes);
    report.details.extend(orphan.details);

    Ok(report)
}

/// 环境删除时清聊天痕迹：磁盘 `chat_context` + 学来的 connectors + 设置里的目标名单。
///
/// `chat_threads` 有 `ON DELETE CASCADE`，删库行也会带走；这里仍显式删一次，
/// 以便「先清盘、后删库」或「删库失败但要先停污染」时不留幽灵索引。
///
/// 失败只记进返回明细，**不抛错挡删环境**（盘被占用时仍应能删库行，避免僵尸环境）。
pub fn forget_profile_chat_on_delete(
    app: &AppHandle,
    connection: &Connection,
    profile_id: &str,
) -> Vec<String> {
    let mut details = Vec::new();
    let trimmed = profile_id.trim();
    if trimmed.is_empty() {
        details.push("profile id 为空，跳过聊天清理".to_owned());
        return details;
    }

    if let Ok(numeric_id) = trimmed.parse::<i64>() {
        match connection.execute(
            "DELETE FROM chat_threads WHERE profile_id = ?1",
            params![numeric_id],
        ) {
            Ok(n) if n > 0 => details.push(format!("已删聊天索引 {n} 条")),
            Ok(_) => {}
            Err(error) => details.push(format!("聊天索引清理失败：{error}")),
        }
    }

    // chat_context（每联系人记忆）
    if let Ok(root) = chat_context_root(app, trimmed) {
        if root.exists() {
            let bytes = dir_size(&root);
            match fs::remove_dir_all(&root) {
                Ok(()) => details.push(format!(
                    "已删聊天上下文（约 {} 字节）",
                    bytes
                )),
                Err(error) => details.push(format!("聊天上下文删除失败：{error}")),
            }
        }
    }

    // 学来的站点描述符（随环境，不得带给新建环境）
    if let Ok(user_dir) = resolve_profile_user_data_dir(app, trimmed) {
        let connectors = user_dir.join("connectors");
        if connectors.exists() {
            match fs::remove_dir_all(&connectors) {
                Ok(()) => details.push("已删学来的站点描述符".to_owned()),
                Err(error) => details.push(format!("学来的描述符删除失败：{error}")),
            }
        }
    }

    match scrub_chat_mode_targets_for_profile(connection, trimmed) {
        Ok(true) => details.push("已从聊天设置摘除该环境的目标名单".to_owned()),
        Ok(false) => {}
        Err(error) => details.push(format!("聊天设置摘除失败：{error}")),
    }

    details
}

/// 从 `chat_mode.targetsByEnv` 摘掉指定环境（坏 JSON 不动，避免覆盖用户设置）。
pub fn scrub_chat_mode_targets_for_profile(
    connection: &Connection,
    profile_id: &str,
) -> Result<bool, AppError> {
    let Some(raw) = db::get_setting(connection, "chat_mode")? else {
        return Ok(false);
    };
    let mut value: Value = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(false),
    };
    let Some(root) = value.as_object_mut() else {
        return Ok(false);
    };
    let Some(targets) = root
        .get_mut("targetsByEnv")
        .and_then(|entry| entry.as_object_mut())
    else {
        return Ok(false);
    };
    if targets.remove(profile_id).is_none() {
        return Ok(false);
    }
    let serialized = serde_json::to_string(&value)
        .map_err(|error| AppError::State(format!("serialize chat_mode: {error}")))?;
    db::set_setting(connection, "chat_mode", &serialized)?;
    Ok(true)
}

/// 清掉「库里已无环境、盘上/设置里还在」的聊天残留。
fn scrub_chat_mode_orphan_targets(
    connection: &Connection,
    active_profile_ids: &HashSet<String>,
) -> Result<usize, AppError> {
    let Some(raw) = db::get_setting(connection, "chat_mode")? else {
        return Ok(0);
    };
    let mut value: Value = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(0),
    };
    let Some(root) = value.as_object_mut() else {
        return Ok(0);
    };
    let Some(targets) = root
        .get_mut("targetsByEnv")
        .and_then(|entry| entry.as_object_mut())
    else {
        return Ok(0);
    };
    let stale: Vec<String> = targets
        .keys()
        .filter(|key| !active_profile_ids.contains(key.as_str()))
        .cloned()
        .collect();
    if stale.is_empty() {
        return Ok(0);
    }
    for key in &stale {
        targets.remove(key);
    }
    let serialized = serde_json::to_string(&value)
        .map_err(|error| AppError::State(format!("serialize chat_mode: {error}")))?;
    db::set_setting(connection, "chat_mode", &serialized)?;
    Ok(stale.len())
}

struct OrphanChatPurge {
    removed_dirs: usize,
    freed_bytes: u64,
    details: Vec<String>,
}

fn purge_orphan_chat_artifacts(
    app: &AppHandle,
    connection: &Connection,
    active_profile_ids: &HashSet<String>,
) -> Result<OrphanChatPurge, AppError> {
    let mut report = OrphanChatPurge {
        removed_dirs: 0,
        freed_bytes: 0,
        details: Vec::new(),
    };

    // 索引幽灵行（历史库若无 FK / CASCADE 失效时）
    let active_numeric: HashSet<i64> = active_profile_ids
        .iter()
        .filter_map(|id| id.parse::<i64>().ok())
        .collect();
    if let Ok(mut statement) =
        connection.prepare("SELECT DISTINCT profile_id FROM chat_threads")
    {
        let ids = statement
            .query_map([], |row| row.get::<_, i64>(0))
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        for profile_id in ids {
            if active_numeric.contains(&profile_id) {
                continue;
            }
            match connection.execute(
                "DELETE FROM chat_threads WHERE profile_id = ?1",
                params![profile_id],
            ) {
                Ok(n) if n > 0 => {
                    report
                        .details
                        .push(format!("已清孤儿聊天索引（环境 {profile_id}，{n} 条）"));
                }
                _ => {}
            }
        }
    }

    // 盘上孤儿：browser-profiles/profile-{id}/chat_context 与 connectors
    let profiles_root = match resolve_profile_user_data_dir(app, "0") {
        Ok(path) => path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or(path),
        Err(_) => return Ok(report),
    };
    if profiles_root.is_dir() {
        if let Ok(entries) = fs::read_dir(&profiles_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(id) = name.strip_prefix("profile-") else {
                    continue;
                };
                if active_profile_ids.contains(id) {
                    continue;
                }
                for sub in ["chat_context", "connectors"] {
                    let target = path.join(sub);
                    if !target.exists() {
                        continue;
                    }
                    let bytes = if target.is_dir() {
                        dir_size(&target)
                    } else {
                        0
                    };
                    match fs::remove_dir_all(&target) {
                        Ok(()) => {
                            report.removed_dirs += 1;
                            report.freed_bytes = report.freed_bytes.saturating_add(bytes);
                            report.details.push(format!(
                                "已清已删环境的残留：profile-{id}/{sub}"
                            ));
                        }
                        Err(error) => report.details.push(format!(
                            "残留清理失败 profile-{id}/{sub}：{error}"
                        )),
                    }
                }
            }
        }
    }

    match scrub_chat_mode_orphan_targets(connection, active_profile_ids) {
        Ok(n) if n > 0 => report
            .details
            .push(format!("已从聊天设置摘除 {n} 个已删环境的目标名单")),
        Ok(_) => {}
        Err(error) => report
            .details
            .push(format!("聊天设置孤儿键清理失败：{error}")),
    }

    Ok(report)
}

/* ————————————————————————— 测试 ————————————————————————— */

#[cfg(test)]
mod tests {
    use super::{
        apply_contact_overlays, bool_at, default_takeover, forget_snapshot_contacts,
        read_thread_messages_from, sanitize_segment, thread_key_of, ChatContactOverlay,
        ChatThreadRow,
    };
    use std::fs;

    /// 与 TS `sanitizeSegment` 的镜像规则锁死（改一边必须同步另一边）。
    #[test]
    fn sanitize_segment_matches_sidecar_rules() {
        assert_eq!(sanitize_segment("", "unknown"), "unknown");
        assert_eq!(sanitize_segment("   ", "fallback"), "fallback");
        // 非法字符 → 下划线（含路径分隔符）
        assert_eq!(sanitize_segment("a/b\\c:d", "x"), "a_b_c_d");
        // 连续点先折叠成下划线，再参与首尾裁剪 —— 与 TS 的 replace 顺序一致
        assert_eq!(sanitize_segment("..", "x"), "_");
        assert_eq!(sanitize_segment("../etc/passwd", "x"), "__etc_passwd");
        assert_eq!(sanitize_segment(".hidden", "x"), "hidden");
        assert_eq!(sanitize_segment("Alice Smith", "x"), "Alice Smith");
        assert_eq!(sanitize_segment("张三", "x"), "张三");
        assert_eq!(sanitize_segment("a\0b", "x"), "a_b");
    }

    #[test]
    fn sanitize_segment_clips_to_96_chars() {
        let long = "x".repeat(200);
        assert_eq!(sanitize_segment(&long, "f").chars().count(), 96);
    }

    /// 清洗后变空必须回退：返回空串会让路径少一段，「清一个联系人」变成「清整个站点」。
    #[test]
    fn sanitize_segment_never_returns_empty() {
        assert_eq!(sanitize_segment("...", "unknown-contact"), "_");
        assert_eq!(sanitize_segment(" . ", "unknown-site"), "unknown-site");
        assert_eq!(sanitize_segment(" . ", "unknown-contact"), "unknown-contact");
    }

    /// 删除环境后必须从 chat_mode.targetsByEnv 摘掉该键，否则列表里还挂着幽灵目标。
    #[test]
    fn scrub_chat_mode_targets_removes_deleted_env_only() {
        use rusqlite::Connection;
        let connection = Connection::open_in_memory().expect("open memory db");
        connection
            .execute_batch(
                "CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            )
            .expect("create settings");
        crate::db::set_setting(
            &connection,
            "chat_mode",
            r#"{"enabled":true,"targetsByEnv":{"3":[{"label":"Anne"}],"7":[{"label":"Bob"}]}}"#,
        )
        .expect("seed chat_mode");

        assert!(super::scrub_chat_mode_targets_for_profile(&connection, "3").unwrap());
        let raw = crate::db::get_setting(&connection, "chat_mode")
            .unwrap()
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let targets = parsed["targetsByEnv"].as_object().unwrap();
        assert!(!targets.contains_key("3"), "已删环境必须从 targetsByEnv 摘掉");
        assert!(targets.contains_key("7"), "其它环境的目标不得误删");
        assert!(!super::scrub_chat_mode_targets_for_profile(&connection, "3").unwrap());
    }

    /// 接管 overlay 的行身份：快照的**原始键**必须清洗成**目录名**才可能撞上索引表的行。
    ///
    /// 现场 bug：快照存 `key = "unknown|Anne"`，索引表存 `contact_key = "unknown_Anne"`，
    /// 不清洗直接 join → 永远匹配不上 → 卡片显示默认值（`engine`），跟引擎实际行为相反
    /// （用户看到的「日志说已暂停、卡片显示我接管」）。
    #[test]
    fn thread_key_of_sanitizes_snapshot_keys_like_the_index() {
        assert_eq!(
            thread_key_of(Some("unknown"), "unknown|Anne"),
            ("unknown".to_owned(), "unknown_Anne".to_owned())
        );
        // 站点缺失也不返回空串（空站点段会让路径少一段）
        assert_eq!(
            thread_key_of(None, "unknown|Anne"),
            ("unknown-site".to_owned(), "unknown_Anne".to_owned())
        );
        // 快照里已经是目录名时是幂等的（老快照 / 手改过的快照）
        assert_eq!(
            thread_key_of(Some("wa"), "wa_Bob"),
            ("wa".to_owned(), "wa_Bob".to_owned())
        );
    }

    /// 会话流水读取：坏行跳过、取尾部、时间正序。
    ///
    /// 与 TS `readThreadMessages` 是镜像实现（一边坏行策略改了另一边必须同步），
    /// 这里锁住三条：① 单行损坏不影响其余；② 只取**尾部** N 条；③ 旧版 JSON 数组形态也能读。
    #[test]
    fn read_thread_messages_skips_broken_lines_and_keeps_tail() {
        let dir = std::env::temp_dir().join(format!(
            "tianshutai-chat-thread-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp chat dir");
        let file = dir.join("thread.jsonl");
        let mut body = String::new();
        for index in 0..5 {
            body.push_str(
                &serde_json::json!({
                    "id": format!("m{index}"),
                    "direction": if index % 2 == 0 { "in" } else { "out" },
                    "text": format!("消息 {index}"),
                    "ts": format!("2026-09-2{index}T10:00:00.000Z"),
                    "at": format!("2026-09-2{index}T10:00:01.000Z"),
                })
                .to_string(),
            );
            body.push('\n');
        }
        body.push_str("{ 这不是合法 JSON\n");
        body.push('\n');
        fs::write(&file, body).expect("write thread file");

        let tail = read_thread_messages_from(&dir, 2);
        assert_eq!(tail.len(), 2, "只取尾部 2 条");
        assert_eq!(tail[0].id, "m3");
        assert_eq!(tail[1].id, "m4");
        assert_eq!(tail[0].direction, "out");
        assert_eq!(tail[1].ts.as_deref(), Some("2026-09-24T10:00:00.000Z"));

        // 旧版裁尾形态（JSON 数组）也必须能读，否则用户升级后「会话突然全空」
        fs::write(
            &file,
            serde_json::json!([
                { "id": "a", "direction": "in", "text": "老格式", "at": "2026-09-01T00:00:00.000Z" }
            ])
            .to_string(),
        )
        .expect("write legacy array form");
        let legacy = read_thread_messages_from(&dir, 10);
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].text, "老格式");

        // 缺文件 = 没有历史，不报错也不编造
        assert!(read_thread_messages_from(&dir.join("nope"), 10).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 清理上下文时要把被清掉的联系人从引擎快照里摘掉（含 `takeover`）。
    ///
    /// 现场：清掉「Anne」的上下文之后，视图仍显示「已由用户接管、引擎不开口」——
    /// 因为 `takeover` 是引擎自有状态，留在 `state.json` 里。承诺「从零开始」就必须真的从零。
    #[test]
    fn forget_snapshot_contacts_drops_only_the_purged_contact() {
        let root = std::env::temp_dir().join(format!("tianshutai-chat-snapshot-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp chat_context dir");
        let path = root.join("state.json");
        fs::write(
            &path,
            serde_json::json!({
                "schemaVersion": 1,
                "envId": "2",
                "engine": { "phase": "waiting" },
                "contacts": [
                    { "key": "unknown|Anne", "siteKey": "unknown", "takeover": "human" },
                    { "key": "wa|Bob", "siteKey": "wa", "takeover": "paused" }
                ],
                "counters": { "sentTotal": 6 }
            })
            .to_string(),
        )
        .expect("write state.json");

        // 只清 Anne：另一位与全局计数都不能动
        assert_eq!(forget_snapshot_contacts(&root, Some("unknown"), Some("unknown_Anne")), 1);
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read back")).expect("parse back");
        let contacts = parsed.get("contacts").and_then(serde_json::Value::as_array).expect("contacts");
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].get("key").and_then(serde_json::Value::as_str), Some("wa|Bob"));
        assert_eq!(parsed.pointer("/counters/sentTotal").and_then(serde_json::Value::as_i64), Some(6));

        // 再清一次（已不存在）＝ 什么也不摘，不报错
        assert_eq!(forget_snapshot_contacts(&root, Some("unknown"), Some("unknown_Anne")), 0);
        // 按站点清：剩下的 wa 站点整段摘掉
        assert_eq!(forget_snapshot_contacts(&root, Some("wa"), None), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&path).expect("read"))
                .expect("parse")
                .get("contacts")
                .and_then(serde_json::Value::as_array)
                .map(|rows| rows.len()),
            Some(0)
        );

        // 文件不存在 / 内容损坏 → 0，且**不改动**原文件（不猜、不崩、也不假装成功）
        assert_eq!(forget_snapshot_contacts(&root.join("nope"), Some("unknown"), None), 0);
        fs::write(&path, "{ 这不是合法 JSON").expect("write broken");
        assert_eq!(forget_snapshot_contacts(&root, Some("unknown"), None), 0);
        assert_eq!(fs::read_to_string(&path).expect("still there"), "{ 这不是合法 JSON");
        let _ = fs::remove_dir_all(&root);
    }

    fn row(site: &str, contact: &str) -> ChatThreadRow {
        ChatThreadRow {
            profile_id: 1,
            site_key: site.to_owned(),
            contact_key: contact.to_owned(),
            contact_label: contact.to_owned(),
            stage: "cold".to_owned(),
            follow_up_index: 0,
            message_count: 0,
            last_contact_at: None,
            last_reply_at: None,
            next_due_at: None,
            stopped: false,
            stop_reason: None,
            takeover: default_takeover(),
            takeover_reason: None,
            auto_reply: true,
            follow_up: true,
        }
    }

    /// 覆盖层按**目录段键**贴到行上（接管 + 两个开关一起），键不匹配的行保持缺省。
    #[test]
    fn overlays_apply_by_directory_key_and_leave_others_at_default() {
        let mut rows = vec![row("wa", "wa_Anne"), row("unknown", "unknown_Bob")];
        let overlays = vec![ChatContactOverlay {
            site_key: "wa".to_owned(),
            contact_key: "wa_Anne".to_owned(),
            takeover: "human".to_owned(),
            takeover_reason: Some("用户在设置里为该联系人选择了「接管 / 暂停」".to_owned()),
            auto_reply: false,
            follow_up: false,
        }];
        apply_contact_overlays(&mut rows, &overlays);
        assert_eq!(rows[0].takeover, "human");
        assert!(!rows[0].auto_reply);
        assert!(!rows[0].follow_up);
        assert!(rows[0].takeover_reason.is_some());
        // 没被覆盖的行：engine + 两个开关都开（老快照 / 没设置）
        assert_eq!(rows[1].takeover, "engine");
        assert!(rows[1].auto_reply);
        assert!(rows[1].follow_up);
        // 空覆盖层 = 什么都不改（不该把默认值写成「关」）
        let mut untouched = vec![row("wa", "wa_Anne")];
        apply_contact_overlays(&mut untouched, &[]);
        assert!(untouched[0].auto_reply && untouched[0].follow_up);
    }

    /// 快照里只有真正的布尔才表态：`"false"` / `0` / `null` 一律按「缺省＝开」处理。
    /// 若把 `"false"` 读成「关」，用户会看到「设置里开着、引擎却不回」而无从排查（§0.5.3 C）。
    #[test]
    fn snapshot_booleans_need_a_real_boolean() {
        let row = serde_json::json!({
            "autoReply": false,
            "followUp": "false",
        });
        assert_eq!(bool_at(&row, "/autoReply"), Some(false));
        assert_eq!(bool_at(&row, "/followUp"), None);
        assert!(bool_at(&row, "/missing").unwrap_or(true));
        // 真正为 false 时才关
        assert!(!bool_at(&row, "/autoReply").unwrap_or(true));
    }
}
