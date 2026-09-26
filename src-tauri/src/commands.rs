use std::collections::HashMap;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};

use crate::browser_manager::BrowserManager;
use crate::db;
use crate::error::AppError;
use crate::log_warn;
use crate::models::{
    AddProxyInput, AgentControlMemory, AgentRun, AgentRunBoard, AgentTrajectory, BatchCreateProfilesInput,
    BatchDeleteResult, CreateProfileInput, DynamicApiProxyInput, FormTemplate, Profile, Proxy,
    ProxyTestResult, TrajectoryListResult, UpdateProfileInput,
};
use crate::proxy::{self, parse_proxy_string};
use crate::AppState;

const DEFAULT_THEME_COLOR: &str = "#6366f1";

fn parse_profile_id(profile_id: &str) -> Result<i64, AppError> {
    let trimmed = profile_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("profile id cannot be empty".to_owned()));
    }
    trimmed
        .parse::<i64>()
        .map_err(|_| AppError::Validation(format!("invalid profile id: {profile_id}")))
}

fn normalize_theme_color(theme_color: Option<String>) -> String {
    theme_color
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_THEME_COLOR.to_owned())
}

/// 环境删除后一并清空其 user-data 目录。
/// ID 复用（补回被删除的位置）后必须从零开始，避免新环境继承旧环境的 Cookie/指纹/存储。
fn purge_profile_data_dir(app: &tauri::AppHandle, profile_id: &str) {
    let Ok(dir) = crate::fill_sidecar::resolve_profile_user_data_dir(app, profile_id) else {
        return;
    };
    if !dir.exists() {
        return;
    }
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        log_warn!(
            "[delete_profile] purge data dir failed profile={profile_id} path={} err={error}",
            dir.display()
        );
    }
}

/// 前端在退出确认框做出「否（保留浏览器）」决策后，通过此命令告知 Rust 跳过退出清场。
#[tauri::command]
pub fn prepare_console_exit(
    state: State<'_, AppState>,
    keep_browsers: bool,
) -> Result<(), AppError> {
    state
        .keep_runtime_on_exit
        .store(keep_browsers, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn get_profiles(
    state: State<'_, AppState>,
    manager: State<'_, BrowserManager>,
) -> Result<Vec<Profile>, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::seed_demo_profiles(&connection)?;

    let mut profiles = db::list_profiles(&connection)?;
    for profile in &mut profiles {
        let id = profile.id.to_string();
        if profile.status == "running" && !manager.is_running(&id) {
            if let Ok(updated) = db::set_profile_stopped(&connection, profile.id) {
                *profile = updated;
            }
        }
    }
    Ok(profiles)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::list_settings(&connection)
}

#[tauri::command]
pub fn update_setting(
    app: AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, crate::browser_manager::BrowserManager>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::set_setting(&connection, key.trim(), &value)?;
    // 下载目录是「运行中就要生效」的少数设置：老环境不重启也必须立刻改道，否则用户
    // 改完目录，手动下载还在往旧目录写（历史 Bug）。
    if matches!(
        key.trim(),
        crate::storage_paths::KEY_BROWSER_DOWNLOAD_DIR
            | crate::storage_paths::KEY_SCRAPER_DOWNLOAD_DIR
    ) {
        match crate::storage_paths::resolve_download_roots(&app, &connection) {
            Ok((browser, scraper)) => manager.push_download_dirs(
                &browser.to_string_lossy(),
                &scraper.to_string_lossy(),
            ),
            Err(error) => log_warn!("[commands] resolve download roots failed: {error}"),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pick_directory(title: Option<String>) -> Result<Option<String>, AppError> {
    let dialog_title = title
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "选择目录".to_owned());
    let picked = rfd::FileDialog::new()
        .set_title(dialog_title)
        .pick_folder();
    Ok(picked.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn open_path_in_os(path: String) -> Result<(), AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("path cannot be empty".to_owned()));
    }
    let target = std::path::PathBuf::from(trimmed);
    let open_target = if target.exists() {
        target
    } else if let Some(parent) = target.parent().filter(|p| p.exists()) {
        parent.to_path_buf()
    } else {
        return Err(AppError::Filesystem(format!("path not found: {trimmed}")));
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("explorer");
        if open_target.is_file() {
            cmd.arg("/select,").arg(&open_target);
        } else {
            cmd.arg(&open_target);
        }
        cmd.creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| AppError::Filesystem(format!("failed to open path: {error}")))?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        let mut cmd = std::process::Command::new("open");
        #[cfg(not(target_os = "macos"))]
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(&open_target)
            .spawn()
            .map_err(|error| AppError::Filesystem(format!("failed to open path: {error}")))?;
        Ok(())
    }
}

/// 用系统默认浏览器打开 http/https 外链。
///
/// Tauri 的 WebView 没有新窗口处理器，`<a target="_blank">` / `window.open` 点了
/// 一点反应都没有；外链必须交给宿主进程用系统默认程序打开。
/// 只放行 http/https，挡掉 `file:` / `javascript:` 这类能被页面诱导的协议。
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), AppError> {
    let trimmed = url.trim().to_owned();
    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Err(AppError::Validation(
            "only http/https urls can be opened externally".to_owned(),
        ));
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '\'' | '<' | '>' | '`' | '\\'))
    {
        return Err(AppError::Validation("url contains illegal characters".to_owned()));
    }

    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let file: Vec<u16> = trimmed.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: 两个字符串都以 NUL 结尾且在整个调用期间存活；其余参数按文档传空/默认值。
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(operation.as_ptr()),
                PCWSTR(file.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        // ShellExecuteW 返回值 <= 32 表示失败（不是 GetLastError 语义）
        if result.0 as isize <= 32 {
            return Err(AppError::Filesystem(
                "failed to open url with the system browser".to_owned(),
            ));
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        let mut cmd = std::process::Command::new("open");
        #[cfg(not(target_os = "macos"))]
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(&trimmed)
            .spawn()
            .map_err(|error| AppError::Filesystem(format!("failed to open url: {error}")))?;
        Ok(())
    }
}

/// Write UTF-8 text into the configured browser/scraper download track (`{root}/{profileId}/`).
#[tauri::command]
pub fn export_text_to_download_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track: String,
    profile_id: String,
    filename: String,
    content: String,
) -> Result<String, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    let path = crate::storage_paths::resolve_unique_download_file_path(
        &app,
        &connection,
        &track,
        &profile_id,
        &filename,
    )?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AppError::Filesystem(format!("create export dir failed: {error}"))
        })?;
    }
    std::fs::write(&path, content.as_bytes())
        .map_err(|error| AppError::Filesystem(format!("write export failed: {error}")))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_proxies(state: State<'_, AppState>) -> Result<Vec<Proxy>, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::list_proxies(&connection)
}

#[tauri::command]
pub fn add_proxy(state: State<'_, AppState>, proxy: AddProxyInput) -> Result<Proxy, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::insert_proxy(
        &connection,
        &proxy.proxy_type,
        &proxy.host,
        proxy.port,
        proxy.username.as_deref(),
        proxy.password.as_deref(),
        proxy.api_config.as_deref(),
    )
}

#[tauri::command]
pub fn batch_add_proxies(
    state: State<'_, AppState>,
    proxies: Vec<AddProxyInput>,
) -> Result<usize, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::batch_add_proxies(&connection, &proxies)
}

#[tauri::command]
pub fn batch_delete_proxies(state: State<'_, AppState>, proxy_ids: Vec<i64>) -> Result<usize, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::batch_delete_proxies(&connection, &proxy_ids)
}

#[tauri::command]
pub fn create_profile(
    state: State<'_, AppState>,
    input: CreateProfileInput,
) -> Result<Profile, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::create_profile(
        &connection,
        &input.name,
        &normalize_theme_color(input.theme_color),
        input.proxy_id,
        input.custom_proxy.as_deref(),
        input.use_geoip,
        input.humanize,
        input.fingerprint_seed.as_deref(),
        &input.stealth_preset,
        &input.webgl_mode,
        input.browser_version.as_deref(),
        input.startup_urls.as_deref(),
    )
}

#[tauri::command]
pub fn batch_create_profiles(
    state: State<'_, AppState>,
    input: BatchCreateProfilesInput,
) -> Result<Vec<Profile>, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::batch_create_profiles(&connection, &input)
}

#[tauri::command]
pub fn update_profile(
    state: State<'_, AppState>,
    input: UpdateProfileInput,
) -> Result<Profile, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::update_profile(
        &connection,
        input.id,
        &input.name,
        &normalize_theme_color(input.theme_color),
        input.proxy_id,
        input.custom_proxy.as_deref(),
        input.use_geoip,
        input.humanize,
        input.fingerprint_seed.as_deref(),
        &input.stealth_preset,
        &input.webgl_mode,
        input.browser_version.as_deref(),
        input.startup_urls.as_deref(),
    )
}

#[tauri::command]
pub fn set_profile_interactive_extract(
    state: State<'_, AppState>,
    profile_id: String,
    enabled: bool,
) -> Result<Profile, AppError> {
    let numeric_id = parse_profile_id(&profile_id)?;
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::set_profile_interactive_extract(&connection, numeric_id, enabled)
}

#[tauri::command]
pub fn set_profile_agent_panorama(
    state: State<'_, AppState>,
    profile_id: String,
    enabled: bool,
) -> Result<Profile, AppError> {
    let numeric_id = parse_profile_id(&profile_id)?;
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::set_profile_agent_panorama(&connection, numeric_id, enabled)
}

/// 请求正在运行的环境立即提取交互元素并推送 interactive-extract-updated。
#[tauri::command]
pub fn request_profile_interactive_extract(
    manager: State<'_, crate::browser_manager::BrowserManager>,
    profile_id: String,
) -> Result<(), AppError> {
    let _ = parse_profile_id(&profile_id)?;
    manager.request_interactive_extract(&profile_id)
}

#[tauri::command]
pub fn delete_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, BrowserManager>,
    profile_id: String,
) -> Result<(), AppError> {
    if manager.is_running(&profile_id) {
        return Err(AppError::Validation(
            "cannot delete a running profile; stop it first".to_owned(),
        ));
    }
    let numeric_id = parse_profile_id(&profile_id)?;
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::delete_profile(&connection, numeric_id)?;
    drop(connection);
    purge_profile_data_dir(&app, &profile_id);
    Ok(())
}

#[tauri::command]
pub fn purge_automation_cache(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::cache_cleanup::CacheCleanupReport, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    crate::cache_cleanup::purge_automation_cache(&app, &connection)
}

#[tauri::command]
pub fn batch_delete_profiles(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, BrowserManager>,
    profile_ids: Vec<String>,
) -> Result<BatchDeleteResult, AppError> {
    if profile_ids.is_empty() {
        return Err(AppError::Validation(
            "batch delete requires at least one profile id".to_owned(),
        ));
    }

    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;

    let mut deleted_ids = Vec::new();
    let mut skipped_running_ids = Vec::new();

    for profile_id in profile_ids {
        let trimmed = profile_id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if manager.is_running(trimmed) {
            skipped_running_ids.push(trimmed.to_owned());
            continue;
        }

        let numeric_id = parse_profile_id(trimmed)?;
        match db::delete_profile(&connection, numeric_id) {
            Ok(()) => deleted_ids.push(trimmed.to_owned()),
            Err(AppError::Validation(message)) if message.contains("running") => {
                skipped_running_ids.push(trimmed.to_owned());
            }
            Err(error) => return Err(error),
        }
    }

    if deleted_ids.is_empty() {
        return Err(AppError::Validation(
            "no profiles deleted; stop running environments first".to_owned(),
        ));
    }

    drop(connection);
    for profile_id in &deleted_ids {
        purge_profile_data_dir(&app, profile_id);
    }

    Ok(BatchDeleteResult {
        deleted_ids,
        skipped_running_ids,
    })
}

#[tauri::command]
pub async fn test_proxy_connection(proxy: String) -> Result<ProxyTestResult, AppError> {
    let resolved = parse_proxy_string(&proxy)?;
    let message = proxy::test_resolved_proxy(&resolved).await?;
    Ok(ProxyTestResult {
        ok: true,
        message,
    })
}

#[tauri::command]
pub fn add_dynamic_api_proxy(
    state: State<'_, AppState>,
    input: DynamicApiProxyInput,
) -> Result<Proxy, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::insert_dynamic_api_proxy(
        &connection,
        &input.api_url,
        &input.protocol,
        &input.region,
        input.label.as_deref(),
    )
}

#[tauri::command]
pub fn save_template(
    state: State<'_, AppState>,
    domain: String,
    template_name: String,
    actions: String,
    auto_apply: Option<bool>,
) -> Result<i64, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::save_form_template(
        &connection,
        &domain,
        &template_name,
        &actions,
        auto_apply.unwrap_or(false),
    )
}

#[tauri::command]
pub fn get_templates_by_domain(
    state: State<'_, AppState>,
    domain: String,
) -> Result<Vec<FormTemplate>, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    if domain.trim().is_empty() {
        db::list_all_form_templates(&connection)
    } else {
        db::get_form_templates_by_domain(&connection, &domain)
    }
}

#[tauri::command]
pub fn delete_template(state: State<'_, AppState>, template_id: i64) -> Result<(), AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::delete_form_template(&connection, template_id)
}

#[tauri::command]
pub fn toggle_template_auto_apply(
    state: State<'_, AppState>,
    template_id: i64,
    auto_apply: bool,
) -> Result<(), AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::toggle_form_template_auto_apply(&connection, template_id, auto_apply)
}

#[tauri::command]
pub fn list_agent_trajectories(
    state: State<'_, AppState>,
    domain: String,
) -> Result<TrajectoryListResult, AppError> {
    // 文件层读取失败不能吞成空列表：用户会以为录制凭空消失，且没有任何重试线索。
    // SQLite 是独立来源，仍照常合并返回，失败原因经 file_error 上报给 UI。
    let (mut file_rows, file_error) =
        match crate::trajectory_files::list_trajectory_files(&domain) {
            Ok(rows) => (rows, None),
            Err(error) => {
                crate::log_warn!("[trajectory] 轨迹文件目录读取失败，降级为仅 SQLite: {error}");
                (Vec::new(), Some(error.reason()))
            }
        };
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    let db_rows = db::list_agent_trajectories(&connection, &domain)?;

    // 文件优先；SQLite 作为补充。按 domain+title+goal 去重，避免同一次成功轨迹双显
    let mut seen = std::collections::HashSet::<String>::new();
    let dedupe_key = |row: &AgentTrajectory| {
        format!(
            "{}::{}::{}",
            row.domain.trim().to_ascii_lowercase(),
            row.title.trim(),
            row.goal.trim()
        )
    };
    for row in &file_rows {
        seen.insert(dedupe_key(row));
    }
    for row in db_rows {
        let key = dedupe_key(&row);
        if seen.insert(key) {
            file_rows.push(row);
        }
    }
    file_rows.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(TrajectoryListResult {
        rows: file_rows,
        file_error,
    })
}

#[tauri::command]
pub fn delete_agent_trajectory(
    state: State<'_, AppState>,
    trajectory_id: i64,
    file_path: Option<String>,
) -> Result<(), AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;

    let path = file_path
        .as_ref()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    let mut removed = false;

    // 有文件：先读身份 → 删文件 → 同步清 SQLite 影子行（否则刷新后又冒出来，表现为「删两次」）
    if let Some(ref file) = path {
        let identity = crate::trajectory_files::read_trajectory_identity(file).ok();
        match crate::trajectory_files::delete_trajectory_file(file) {
            Ok(()) => removed = true,
            Err(error) => {
                // 文件已不存在时仍继续清库
                let msg = error.to_string();
                if !msg.contains("不存在") && !msg.contains("NotFound") && !msg.contains("not found")
                {
                    return Err(error);
                }
            }
        }
        if let Some((domain, title, goal)) = identity {
            let _ = db::delete_agent_trajectories_matching(&connection, &domain, &title, &goal);
            removed = true;
        }
    }

    // 正 id：删 SQLite 行（文件源用负 hash id，跳过）
    if trajectory_id > 0 {
        match db::delete_agent_trajectory(&connection, trajectory_id) {
            Ok(()) => removed = true,
            Err(AppError::NotFound(_)) if removed => {}
            Err(error) => return Err(error),
        }
    }

    if !removed {
        return Err(AppError::Validation(
            "删除轨迹需要有效的 id 或 file_path".to_owned(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn list_agent_runs(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AgentRun>, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::list_agent_runs(
        &connection,
        query.as_deref().unwrap_or(""),
        limit.unwrap_or(100),
    )
}

/// P5.4：Token / 估算费用 / 失败分类合计（读 agent_runs，不另建表）
#[tauri::command]
pub fn summarize_agent_run_board(state: State<'_, AppState>) -> Result<AgentRunBoard, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::summarize_agent_run_board(&connection)
}

#[tauri::command]
pub fn get_agent_run(state: State<'_, AppState>, id: i64) -> Result<AgentRun, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::get_agent_run(&connection, id)
}

#[tauri::command]
pub fn delete_agent_run(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::delete_agent_run(&connection, id)
}

#[tauri::command]
pub fn batch_delete_agent_runs(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<usize, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::batch_delete_agent_runs(&connection, &ids)
}

#[tauri::command]
pub fn list_agent_control_memory(
    state: State<'_, AppState>,
    domain: Option<String>,
) -> Result<Vec<AgentControlMemory>, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::list_agent_control_memory(&connection, domain.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn clear_agent_control_memory(
    state: State<'_, AppState>,
    domain: Option<String>,
) -> Result<usize, AppError> {
    let domain_trim = domain.as_deref().unwrap_or("").to_owned();
    let affected = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        db::clear_agent_control_memory(&connection, domain_trim.as_str())?
    };
    // 同步清空 sidecar 磁盘备份，避免下次开局从 lru.json 复活
    if domain_trim.trim().is_empty() {
        let _ = crate::trajectory_files::wipe_control_memory_disk();
    }
    Ok(affected)
}

#[tauri::command]
pub async fn export_profile_cookies(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    format: Option<String>,
) -> Result<crate::cookie_ops::CookieExportResult, AppError> {
    crate::cookie_ops::export_profile_cookies(
        &app,
        &state,
        profile_id,
        format.unwrap_or_else(|| "json".to_owned()),
    )
    .await
}

#[tauri::command]
pub async fn import_profile_cookies(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    payload: String,
) -> Result<crate::cookie_ops::CookieImportResult, AppError> {
    crate::cookie_ops::import_profile_cookies(&app, &state, profile_id, payload).await
}

/// P1.1：写入命名密钥（DPAPI）；返回值不含明文
#[tauri::command]
pub fn put_secret_ref(
    state: State<'_, AppState>,
    ref_id: String,
    plaintext: String,
    kind: Option<String>,
) -> Result<(), AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::put_secret_ref(
        &connection,
        &ref_id,
        &plaintext,
        kind.as_deref().unwrap_or("otp"),
    )
}

#[tauri::command]
pub fn delete_secret_ref(state: State<'_, AppState>, ref_id: String) -> Result<bool, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::delete_secret_ref(&connection, &ref_id)
}

#[tauri::command]
pub fn secret_ref_exists(state: State<'_, AppState>, ref_id: String) -> Result<bool, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::secret_ref_exists(&connection, &ref_id)
}

/// P1.1：绑定环境级邮箱 OTP 通道（JSON，仅 secretRef；空字符串清除）
#[tauri::command]
pub fn set_profile_otp_channel(
    state: State<'_, AppState>,
    profile_id: String,
    channel_json: String,
) -> Result<Profile, AppError> {
    let id = parse_profile_id(&profile_id)?;
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    db::set_profile_otp_channel(&connection, id, &channel_json)
}

/// P1.1：读取生效通道绑定（环境优先，否则全局）；不含密钥明文
#[tauri::command]
pub fn get_otp_channel_binding(
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> Result<String, AppError> {
    let connection = state
        .database
        .lock()
        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
    let pid = match profile_id.as_deref() {
        Some(raw) if !raw.trim().is_empty() => Some(parse_profile_id(raw)?),
        _ => None,
    };
    db::resolve_otp_channel_json(&connection, pid)
}
