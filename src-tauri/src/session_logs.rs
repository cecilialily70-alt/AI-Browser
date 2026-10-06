//! Ai Chat 会话、Agent 瘦事件、值守过程日志：SQLite 单写（Host 权威）。

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppError;
use crate::models::{AgentRunEvent, AiChatMessage, AiChatThread, ChatPatrolLog};
use crate::{log_warn};

const AI_CHAT_COMPACT_AFTER: i64 = 24;
const AI_CHAT_HOT_KEEP: i64 = 24;
const AI_CHAT_SUMMARY_MAX: usize = 1400;
const AI_CHAT_GEN_CAP: i64 = 60;
const AGENT_EVENT_KEEP: i64 = 800;
const PATROL_LOG_KEEP: i64 = 300;

pub fn ensure_session_log_tables(connection: &Connection) -> Result<(), AppError> {
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_chat_threads (
            profile_id TEXT PRIMARY KEY,
            summary TEXT NOT NULL DEFAULT '',
            covered_up_to_id TEXT,
            generations INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT NOT NULL,
            msg_id TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tone TEXT NOT NULL DEFAULT 'info',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_profile
            ON ai_chat_messages(profile_id, id);
        CREATE TABLE IF NOT EXISTS agent_run_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            profile_id TEXT NOT NULL DEFAULT '',
            ts TEXT NOT NULL DEFAULT '',
            event_kind TEXT NOT NULL DEFAULT '',
            phase TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL DEFAULT '',
            step INTEGER,
            msg TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_agent_run_events_run
            ON agent_run_events(run_id, id);
        CREATE TABLE IF NOT EXISTS chat_patrol_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT NOT NULL,
            at_text TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            tone TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_chat_patrol_logs_profile
            ON chat_patrol_logs(profile_id, id);
        "#,
    )?;
    ensure_agent_runs_fts(connection)?;
    abort_stale_running_agent_runs(connection)?;
    Ok(())
}

fn ensure_agent_runs_fts(connection: &Connection) -> Result<(), AppError> {
    let exists: bool = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs_fts'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        return Ok(());
    }
    let result = connection.execute_batch(
        r#"
        CREATE VIRTUAL TABLE agent_runs_fts USING fts5(
            goal, summary, domain, failure_class, profile_id, run_id,
            content='agent_runs', content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS agent_runs_fts_ai AFTER INSERT ON agent_runs BEGIN
            INSERT INTO agent_runs_fts(rowid, goal, summary, domain, failure_class, profile_id, run_id)
            VALUES (new.id, new.goal, new.summary, new.domain, new.failure_class, new.profile_id, new.run_id);
        END;
        CREATE TRIGGER IF NOT EXISTS agent_runs_fts_ad AFTER DELETE ON agent_runs BEGIN
            INSERT INTO agent_runs_fts(agent_runs_fts, rowid, goal, summary, domain, failure_class, profile_id, run_id)
            VALUES ('delete', old.id, old.goal, old.summary, old.domain, old.failure_class, old.profile_id, old.run_id);
        END;
        CREATE TRIGGER IF NOT EXISTS agent_runs_fts_au AFTER UPDATE ON agent_runs BEGIN
            INSERT INTO agent_runs_fts(agent_runs_fts, rowid, goal, summary, domain, failure_class, profile_id, run_id)
            VALUES ('delete', old.id, old.goal, old.summary, old.domain, old.failure_class, old.profile_id, old.run_id);
            INSERT INTO agent_runs_fts(rowid, goal, summary, domain, failure_class, profile_id, run_id)
            VALUES (new.id, new.goal, new.summary, new.domain, new.failure_class, new.profile_id, new.run_id);
        END;
        INSERT INTO agent_runs_fts(agent_runs_fts) VALUES('rebuild');
        "#,
    );
    if let Err(error) = result {
        log_warn!("TianshuTai: agent_runs_fts skipped: {error}");
    }
    Ok(())
}

pub fn fts_available(connection: &Connection) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs_fts'",
            [],
            |_| Ok(true),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or(false)
}

pub fn abort_stale_running_agent_runs(connection: &Connection) -> Result<usize, AppError> {
    let n = connection.execute(
        "UPDATE agent_runs SET
            status = 'aborted',
            success = 0,
            ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
            failure_class = CASE
              WHEN failure_class IS NULL OR failure_class = '' OR failure_class = 'none'
              THEN 'aborted' ELSE failure_class END,
            summary = CASE
              WHEN summary IS NULL OR trim(summary) = ''
              THEN '启动后未正常收尾（软件关闭或进程中断）'
              ELSE summary END
         WHERE status = 'running'",
        [],
    )?;
    Ok(n)
}

fn fts_phrase(query: &str) -> Option<String> {
    let cleaned = query
        .chars()
        .map(|ch| match ch {
            '"' | '*' | '(' | ')' | ':' | '^' | '{' | '}' | '[' | ']' => ' ',
            other => other,
        })
        .collect::<String>();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return None;
    }
    let escaped = trimmed.replace('\'', "''");
    Some(format!("\"{escaped}\""))
}

pub fn list_agent_run_ids_fts(
    connection: &Connection,
    query: &str,
    limit: i64,
) -> Result<Vec<i64>, AppError> {
    if !fts_available(connection) {
        return Ok(vec![]);
    }
    let Some(phrase) = fts_phrase(query) else {
        return Ok(vec![]);
    };
    let mut statement = connection.prepare(
        "SELECT rowid FROM agent_runs_fts WHERE agent_runs_fts MATCH ?1 LIMIT ?2",
    )?;
    let rows = statement
        .query_map(params![phrase, limit], |row| row.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(rows)
}

pub fn append_agent_run_event(
    connection: &Connection,
    run_id: &str,
    profile_id: &str,
    ts: &str,
    event_kind: &str,
    phase: &str,
    state: &str,
    step: Option<i64>,
    msg: &str,
) -> Result<(), AppError> {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return Ok(());
    }
    connection.execute(
        "INSERT INTO agent_run_events (run_id, profile_id, ts, event_kind, phase, state, step, msg)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            run_id,
            profile_id.trim(),
            ts.trim(),
            event_kind.trim(),
            phase.trim(),
            state.trim(),
            step,
            msg.trim()
        ],
    )?;
    connection.execute(
        "DELETE FROM agent_run_events WHERE run_id = ?1 AND id NOT IN (
            SELECT id FROM agent_run_events WHERE run_id = ?1 ORDER BY id DESC LIMIT ?2
         )",
        params![run_id, AGENT_EVENT_KEEP],
    )?;
    Ok(())
}

pub fn list_agent_run_events(
    connection: &Connection,
    run_id: &str,
    limit: i64,
) -> Result<Vec<AgentRunEvent>, AppError> {
    let limit = limit.clamp(1, 800);
    let mut statement = connection.prepare(
        "SELECT id, run_id, profile_id, ts, event_kind, phase, state, step, msg, created_at
         FROM agent_run_events WHERE run_id = ?1 ORDER BY id ASC LIMIT ?2",
    )?;
    let rows = statement
        .query_map(params![run_id.trim(), limit], map_agent_run_event)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_agent_run_events_by_run_ids(
    connection: &Connection,
    run_ids: &[String],
) -> Result<(), AppError> {
    for run_id in run_ids {
        connection.execute(
            "DELETE FROM agent_run_events WHERE run_id = ?1",
            params![run_id],
        )?;
    }
    Ok(())
}

fn map_agent_run_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRunEvent> {
    Ok(AgentRunEvent {
        id: row.get(0)?,
        run_id: row.get(1)?,
        profile_id: row.get(2)?,
        ts: row.get(3)?,
        event_kind: row.get(4)?,
        phase: row.get(5)?,
        state: row.get(6)?,
        step: row.get(7)?,
        msg: row.get(8)?,
        created_at: row.get(9)?,
    })
}

pub fn append_chat_patrol_log(
    connection: &Connection,
    profile_id: &str,
    at_text: &str,
    text: &str,
    tone: &str,
    kind: &str,
) -> Result<(), AppError> {
    let profile_id = profile_id.trim();
    let text = text.trim();
    if profile_id.is_empty() || text.is_empty() {
        return Ok(());
    }
    connection.execute(
        "INSERT INTO chat_patrol_logs (profile_id, at_text, text, tone, kind)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![profile_id, at_text.trim(), text, tone.trim(), kind.trim()],
    )?;
    connection.execute(
        "DELETE FROM chat_patrol_logs WHERE profile_id = ?1 AND id NOT IN (
            SELECT id FROM chat_patrol_logs WHERE profile_id = ?1 ORDER BY id DESC LIMIT ?2
         )",
        params![profile_id, PATROL_LOG_KEEP],
    )?;
    Ok(())
}

pub fn list_chat_patrol_logs(
    connection: &Connection,
    profile_id: &str,
    limit: i64,
) -> Result<Vec<ChatPatrolLog>, AppError> {
    let limit = limit.clamp(1, 300);
    let mut statement = connection.prepare(
        "SELECT id, profile_id, at_text, text, tone, kind, created_at
         FROM chat_patrol_logs WHERE profile_id = ?1 ORDER BY id ASC LIMIT ?2",
    )?;
    let rows = statement
        .query_map(params![profile_id.trim(), limit], |row| {
            Ok(ChatPatrolLog {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                at_text: row.get(2)?,
                text: row.get(3)?,
                tone: row.get(4)?,
                kind: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn clear_chat_patrol_logs(connection: &Connection, profile_id: &str) -> Result<(), AppError> {
    connection.execute(
        "DELETE FROM chat_patrol_logs WHERE profile_id = ?1",
        params![profile_id.trim()],
    )?;
    Ok(())
}

pub fn get_ai_chat_thread(
    connection: &Connection,
    profile_id: &str,
) -> Result<AiChatThread, AppError> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() {
        return Err(AppError::Validation("profile id cannot be empty".to_owned()));
    }
    let (summary, covered, generations): (String, Option<String>, i64) = connection
        .query_row(
            "SELECT summary, covered_up_to_id, generations FROM ai_chat_threads WHERE profile_id = ?1",
            params![profile_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .unwrap_or_else(|| (String::new(), None, 0));
    let mut statement = connection.prepare(
        "SELECT id, profile_id, msg_id, role, content, tone, created_at
         FROM ai_chat_messages WHERE profile_id = ?1 ORDER BY id ASC LIMIT 500",
    )?;
    let messages = statement
        .query_map(params![profile_id], map_ai_chat_message)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(AiChatThread {
        profile_id: profile_id.to_owned(),
        summary,
        covered_up_to_id: covered,
        generations,
        messages,
    })
}

pub fn append_ai_chat_message(
    connection: &Connection,
    profile_id: &str,
    role: &str,
    content: &str,
    tone: &str,
) -> Result<AiChatMessage, AppError> {
    let profile_id = profile_id.trim();
    let role = role.trim();
    let content = content.trim();
    if profile_id.is_empty() {
        return Err(AppError::Validation("profile id cannot be empty".to_owned()));
    }
    if content.is_empty() {
        return Err(AppError::Validation("chat message cannot be empty".to_owned()));
    }
    let role = match role {
        "user" | "assistant" | "system" => role,
        _ => "assistant",
    };
    connection.execute(
        "INSERT INTO ai_chat_threads (profile_id) VALUES (?1)
         ON CONFLICT(profile_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP",
        params![profile_id],
    )?;
    let msg_id = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        content.len()
    );
    connection.execute(
        "INSERT INTO ai_chat_messages (profile_id, msg_id, role, content, tone)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![profile_id, msg_id, role, content, tone.trim()],
    )?;
    let row = connection.query_row(
        "SELECT id, profile_id, msg_id, role, content, tone, created_at
         FROM ai_chat_messages WHERE msg_id = ?1",
        params![msg_id],
        map_ai_chat_message,
    )?;
    maybe_compact_ai_chat(connection, profile_id)?;
    Ok(row)
}

fn maybe_compact_ai_chat(connection: &Connection, profile_id: &str) -> Result<(), AppError> {
    let (summary, covered, generations): (String, Option<String>, i64) = connection.query_row(
        "SELECT summary, covered_up_to_id, generations FROM ai_chat_threads WHERE profile_id = ?1",
        params![profile_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if generations >= AI_CHAT_GEN_CAP {
        return Ok(());
    }
    let mut statement = connection.prepare(
        "SELECT msg_id, role, content FROM ai_chat_messages WHERE profile_id = ?1 ORDER BY id ASC",
    )?;
    let rows = statement
        .query_map(params![profile_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let covered_index = covered
        .as_ref()
        .and_then(|id| rows.iter().position(|(msg_id, _, _)| msg_id == id));
    let start = covered_index.map(|i| i + 1).unwrap_or(0);
    let uncovered = rows.len().saturating_sub(start) as i64;
    if uncovered < AI_CHAT_COMPACT_AFTER {
        return Ok(());
    }
    let keep_from = rows.len().saturating_sub(AI_CHAT_HOT_KEEP as usize);
    if keep_from <= start {
        return Ok(());
    }
    let mut chunk = String::new();
    let mut last_id: Option<String> = None;
    for (msg_id, role, content) in &rows[start..keep_from] {
        let line = format!("{}：{}", if role == "user" { "你" } else { "AI" }, content);
        if !chunk.is_empty() {
            chunk.push('\n');
        }
        chunk.push_str(&line);
        last_id = Some(msg_id.clone());
    }
    if chunk.is_empty() {
        return Ok(());
    }
    let mut next_summary = if summary.trim().is_empty() {
        chunk
    } else {
        format!("{}\n{chunk}", summary.trim())
    };
    if next_summary.chars().count() > AI_CHAT_SUMMARY_MAX {
        let collected = next_summary.chars().rev().take(AI_CHAT_SUMMARY_MAX).collect::<Vec<_>>();
        next_summary = collected.into_iter().rev().collect();
    }
    connection.execute(
        "UPDATE ai_chat_threads SET summary = ?2, covered_up_to_id = ?3, generations = generations + 1,
         updated_at = CURRENT_TIMESTAMP WHERE profile_id = ?1",
        params![profile_id, next_summary, last_id],
    )?;
    Ok(())
}

pub fn clear_ai_chat_thread(connection: &Connection, profile_id: &str) -> Result<(), AppError> {
    let profile_id = profile_id.trim();
    connection.execute(
        "DELETE FROM ai_chat_messages WHERE profile_id = ?1",
        params![profile_id],
    )?;
    connection.execute(
        "DELETE FROM ai_chat_threads WHERE profile_id = ?1",
        params![profile_id],
    )?;
    Ok(())
}

pub fn purge_profile_session_logs(connection: &Connection, profile_id: &str) -> Result<(), AppError> {
    clear_ai_chat_thread(connection, profile_id)?;
    clear_chat_patrol_logs(connection, profile_id)?;
    Ok(())
}

fn map_ai_chat_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiChatMessage> {
    Ok(AiChatMessage {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        msg_id: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        tone: row.get(5)?,
        created_at: row.get(6)?,
    })
}
