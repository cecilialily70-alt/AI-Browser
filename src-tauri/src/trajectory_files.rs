//! 轨迹文件目录读写（agent_exports/trajectories）
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::AppError;
use crate::models::AgentTrajectory;
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};

pub fn resolve_trajectories_dir() -> Result<PathBuf, AppError> {
    let entry = resolve_sidecar_dist("index.js")?;
    let root = sidecar_working_dir(&entry).ok_or_else(|| {
        AppError::Sidecar("无法解析 sidecar 工作目录（trajectories）".to_owned())
    })?;
    Ok(root.join("agent_exports").join("trajectories"))
}

pub fn resolve_control_memory_file() -> Result<PathBuf, AppError> {
    let entry = resolve_sidecar_dist("index.js")?;
    let root = sidecar_working_dir(&entry).ok_or_else(|| {
        AppError::Sidecar("无法解析 sidecar 工作目录（control_memory）".to_owned())
    })?;
    Ok(root
        .join("agent_exports")
        .join("control_memory")
        .join("lru.json"))
}

/// 清空同站控件记忆磁盘备份（与 SQLite clear 同步，防幽灵复活）
pub fn wipe_control_memory_disk() -> Result<(), AppError> {
    let path = resolve_control_memory_file()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::Sidecar(format!("创建 control_memory 目录失败: {error}"))
        })?;
    }
    let body = serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "savedAt": chrono_like_now(),
        "entries": []
    }))
    .map_err(|error| AppError::Sidecar(format!("序列化 control_memory 失败: {error}")))?;
    fs::write(&path, format!("{body}\n")).map_err(|error| {
        AppError::Sidecar(format!("写入 control_memory 失败: {error}"))
    })?;
    Ok(())
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn stable_file_id(path: &str) -> i64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let value = hasher.finish() as i64;
    if value == 0 {
        -1
    } else if value > 0 {
        -value
    } else {
        value
    }
}

fn normalize_domain(domain: &str) -> String {
    domain
        .trim()
        .trim_start_matches("www.")
        .to_ascii_lowercase()
}

pub fn list_trajectory_files(domain_filter: &str) -> Result<Vec<AgentTrajectory>, AppError> {
    let dir = resolve_trajectories_dir()?;
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
        return Ok(Vec::new());
    }

    let filter = normalize_domain(domain_filter);
    let mut rows: Vec<AgentTrajectory> = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|error| {
        AppError::Sidecar(format!("读取轨迹目录失败: {error}"))
    })?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown.json")
            .to_owned();
        let raw = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let domain = parsed
            .get("domain")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_owned();
        if !filter.is_empty() && normalize_domain(&domain) != filter {
            continue;
        }

        let actions_value = parsed
            .get("actions")
            .cloned()
            .unwrap_or(Value::Array(vec![]));
        let step_count = actions_value.as_array().map(|items| items.len() as u32);
        let actions = actions_value.to_string();
        let title = parsed
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or(&file_name)
            .to_owned();
        let goal = parsed
            .get("goal")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_owned();
        let start_url = parsed
            .get("startUrl")
            .or_else(|| parsed.get("start_url"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_owned();
        let created_at = parsed
            .get("savedAt")
            .or_else(|| parsed.get("created_at"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_owned();
        let file_path = path.to_string_lossy().to_string();

        rows.push(AgentTrajectory {
            id: stable_file_id(&file_path),
            domain,
            title,
            goal,
            start_url,
            actions,
            created_at,
            file_path: Some(file_path),
            file_name: Some(file_name),
            step_count,
            source: Some("file".to_owned()),
        });
    }

    rows.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(rows)
}

pub fn delete_trajectory_file(file_path: &str) -> Result<(), AppError> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("file_path cannot be empty".to_owned()));
    }
    let path = PathBuf::from(trimmed);
    let root = resolve_trajectories_dir()?;
    let canonical_root = root.canonicalize().unwrap_or(root);
    let canonical_path = path.canonicalize().map_err(|error| {
        AppError::Validation(format!("轨迹文件不存在: {error}"))
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(AppError::Validation(
            "拒绝删除轨迹目录以外的文件".to_owned(),
        ));
    }
    fs::remove_file(&canonical_path).map_err(|error| {
        AppError::Sidecar(format!("删除轨迹文件失败: {error}"))
    })?;
    Ok(())
}

/// 删除前读取身份字段，便于同步清理 SQLite 影子行
pub fn read_trajectory_identity(
    file_path: &str,
) -> Result<(String, String, String), AppError> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("file_path cannot be empty".to_owned()));
    }
    let raw = fs::read_to_string(trimmed).map_err(|error| {
        AppError::Validation(format!("读取轨迹文件失败: {error}"))
    })?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|error| {
        AppError::Validation(format!("轨迹文件 JSON 无效: {error}"))
    })?;
    let domain = parsed
        .get("domain")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    let title = parsed
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    let goal = parsed
        .get("goal")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    Ok((domain, title, goal))
}

pub fn path_is_under_trajectories(file_path: &str) -> bool {
    let Ok(root) = resolve_trajectories_dir() else {
        return false;
    };
    let path = Path::new(file_path);
    path.starts_with(&root)
        || path
            .canonicalize()
            .ok()
            .zip(root.canonicalize().ok())
            .is_some_and(|(file, base)| file.starts_with(base))
}
