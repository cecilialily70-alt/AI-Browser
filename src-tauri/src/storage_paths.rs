//! Dual-track download directory resolution (browser vs scraper).

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::db;
use crate::error::AppError;

pub const KEY_BROWSER_DOWNLOAD_DIR: &str = "browser_download_dir";
pub const KEY_SCRAPER_DOWNLOAD_DIR: &str = "scraper_download_dir";

pub const DEFAULT_BROWSER_REL: &str = "downloads/browser";
pub const DEFAULT_SCRAPER_REL: &str = "downloads/scraper";

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Filesystem(error.to_string()))
}

fn resolve_one(app_data: &Path, configured: Option<String>, default_rel: &str) -> PathBuf {
    let trimmed = configured
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    match trimmed {
        Some(path) => PathBuf::from(path),
        None => app_data.join(default_rel),
    }
}

/// Absolute roots for browser / scraper downloads (no profileId segment).
pub fn resolve_download_roots(
    app: &AppHandle,
    connection: &Connection,
) -> Result<(PathBuf, PathBuf), AppError> {
    let app_data = app_data_dir(app)?;
    let browser = resolve_one(
        &app_data,
        db::get_setting(connection, KEY_BROWSER_DOWNLOAD_DIR)?,
        DEFAULT_BROWSER_REL,
    );
    let scraper = resolve_one(
        &app_data,
        db::get_setting(connection, KEY_SCRAPER_DOWNLOAD_DIR)?,
        DEFAULT_SCRAPER_REL,
    );
    Ok((browser, scraper))
}

fn sanitize_profile_id(profile_id: &str) -> String {
    let raw = profile_id.trim();
    let base = if raw.is_empty() { "unknown" } else { raw };
    base.chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .take(64)
        .collect()
}

fn sanitize_filename(name: &str) -> String {
    let base = Path::new(name.trim())
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    let cleaned: String = base
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .chars()
        .take(180)
        .collect();
    if cleaned.is_empty() {
        format!(
            "file-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        )
    } else {
        cleaned
    }
}

/// `{root}/{profileId}/{filename}` — mirrors sidecar `getResolvedDownloadPath`.
pub fn resolve_download_file_path(
    app: &AppHandle,
    connection: &Connection,
    track: &str,
    profile_id: &str,
    filename: &str,
) -> Result<PathBuf, AppError> {
    let (browser_root, scraper_root) = resolve_download_roots(app, connection)?;
    let root = match track.trim().to_ascii_lowercase().as_str() {
        "browser" => browser_root,
        "scraper" => scraper_root,
        other => {
            return Err(AppError::Validation(format!(
                "invalid download track: {other} (use browser|scraper)"
            )));
        }
    };
    let dir = root.join(sanitize_profile_id(profile_id));
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::Filesystem(format!("create download dir failed: {error}")))?;
    Ok(dir.join(sanitize_filename(filename)))
}

/// Unique path: append ` (n)` before extension when file exists.
pub fn resolve_unique_download_file_path(
    app: &AppHandle,
    connection: &Connection,
    track: &str,
    profile_id: &str,
    filename: &str,
) -> Result<PathBuf, AppError> {
    let initial = resolve_download_file_path(app, connection, track, profile_id, filename)?;
    if !initial.exists() {
        return Ok(initial);
    }
    let dir = initial
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| initial.clone());
    let safe = sanitize_filename(filename);
    let stem = Path::new(&safe)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = Path::new(&safe)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let mut index = 1_u32;
    loop {
        let candidate = dir.join(sanitize_filename(&format!("{stem} ({index}){ext}")));
        if !candidate.exists() {
            return Ok(candidate);
        }
        index = index.saturating_add(1);
        if index > 10_000 {
            return Err(AppError::Filesystem(
                "too many filename collisions in download dir".to_owned(),
            ));
        }
    }
}

/// JSON payload for Sidecar launch / agent commands.
pub fn download_roots_json(
    app: &AppHandle,
    connection: &Connection,
) -> Result<serde_json::Value, AppError> {
    let (browser, scraper) = resolve_download_roots(app, connection)?;
    Ok(serde_json::json!({
        "browserDownloadDir": browser.to_string_lossy(),
        "scraperDownloadDir": scraper.to_string_lossy(),
    }))
}
