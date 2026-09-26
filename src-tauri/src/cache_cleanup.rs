//! 清理自动化缓存：爬虫/Agent 图片、已删环境的 profile 目录与 agent_fs。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db;
use crate::error::AppError;
use crate::storage_paths;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "avif",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheCleanupReport {
    pub removed_dirs: usize,
    pub removed_files: usize,
    pub freed_bytes: u64,
    pub details: Vec<String>,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Filesystem(e.to_string()))
}

fn ai_browser_home() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".ai-browser")
}

fn active_profile_ids(connection: &Connection) -> Result<HashSet<String>, AppError> {
    let profiles = db::list_profiles(connection)?;
    Ok(profiles.into_iter().map(|p| p.id.to_string()).collect())
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

fn is_captcha_frame(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase().starts_with("captcha_frame_"))
        .unwrap_or(false)
}

fn dir_size_approx(path: &Path) -> u64 {
    let mut total = 0u64;
    let walk = walkdir_shallow(path, 8);
    for p in walk {
        if let Ok(meta) = fs::metadata(&p) {
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

/// Bounded recursive file listing (depth-limited) without external crate.
fn walkdir_shallow(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn rec(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
        if depth > max_depth {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            out.push(path.clone());
            if path.is_dir() {
                rec(&path, depth + 1, max_depth, out);
            }
        }
    }
    if root.is_dir() {
        rec(root, 0, max_depth, &mut out);
    }
    out
}

fn remove_path(path: &Path, report: &mut CacheCleanupReport, is_dir: bool) {
    if !path.exists() {
        return;
    }
    let bytes = if is_dir {
        dir_size_approx(path)
    } else {
        fs::metadata(path).map(|m| m.len()).unwrap_or(0)
    };
    let result = if is_dir {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Ok(()) => {
            report.freed_bytes = report.freed_bytes.saturating_add(bytes);
            if is_dir {
                report.removed_dirs += 1;
            } else {
                report.removed_files += 1;
            }
            report.details.push(format!("{} {}", if is_dir { "dir" } else { "file" }, path.display()));
        }
        Err(err) => {
            report
                .details
                .push(format!("fail {} ({})", path.display(), err));
        }
    }
}

fn remove_dir_tracked(path: &Path, report: &mut CacheCleanupReport) {
    remove_path(path, report, true);
}

fn remove_file_tracked(path: &Path, report: &mut CacheCleanupReport) {
    remove_path(path, report, false);
}

fn parse_profile_dir_id(name: &str) -> Option<String> {
    let rest = name.strip_prefix("profile-")?;
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_string())
}

/// 清理：自动化下载图片、agent 验证码帧、已删环境的 profile / agent_fs / 下载子目录。
pub fn purge_automation_cache(
    app: &AppHandle,
    connection: &Connection,
) -> Result<CacheCleanupReport, AppError> {
    let mut report = CacheCleanupReport {
        removed_dirs: 0,
        removed_files: 0,
        freed_bytes: 0,
        details: Vec::new(),
    };

    let active = active_profile_ids(connection)?;
    let app_data = app_data_dir(app)?;
    let (browser_root, scraper_root) = storage_paths::resolve_download_roots(app, connection)?;
    let agent_fs_root = ai_browser_home().join("agent_fs");

    // 1) 已删环境：app_data/profile-{id}
    if let Ok(entries) = fs::read_dir(&app_data) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(id) = parse_profile_dir_id(&name) {
                if !active.contains(&id) {
                    remove_dir_tracked(&path, &mut report);
                }
            }
        }
    }

    // 2) agent_fs：孤儿目录整删；存活目录只清验证码帧与图片
    if agent_fs_root.is_dir() {
        if let Ok(entries) = fs::read_dir(&agent_fs_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let id = entry.file_name().to_string_lossy().to_string();
                if !active.contains(&id) {
                    remove_dir_tracked(&path, &mut report);
                    continue;
                }
                for file in walkdir_shallow(&path, 3) {
                    if file.is_file() && (is_captcha_frame(&file) || is_image_file(&file)) {
                        remove_file_tracked(&file, &mut report);
                    }
                }
            }
        }
    }

    // 3) 爬虫/自动化下载根：删全部图片；删孤儿 profile 子目录
    cleanup_download_tree(&scraper_root, &active, true, &mut report);

    // 4) 浏览器下载根：仅删孤儿环境子目录（不扫用户手动下载的散图）
    cleanup_download_tree(&browser_root, &active, false, &mut report);

    if report.details.len() > 80 {
        let omitted = report.details.len() - 80;
        report.details.truncate(80);
        report
            .details
            .push(format!("…另有 {omitted} 条明细已省略"));
    }

    Ok(report)
}

fn cleanup_download_tree(
    root: &Path,
    active: &HashSet<String>,
    purge_all_images: bool,
    report: &mut CacheCleanupReport,
) {
    if !root.is_dir() {
        return;
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                // 子目录名 = 环境 id 或 profile-{id}
                let id = parse_profile_dir_id(&name).unwrap_or_else(|| name.clone());
                if !active.contains(&id) && !active.contains(&name) {
                    remove_dir_tracked(&path, report);
                    continue;
                }
                if purge_all_images {
                    for file in walkdir_shallow(&path, 6) {
                        if file.is_file() && is_image_file(&file) {
                            remove_file_tracked(&file, report);
                        }
                    }
                }
            } else if purge_all_images && path.is_file() && is_image_file(&path) {
                remove_file_tracked(&path, report);
            }
        }
    }
}
