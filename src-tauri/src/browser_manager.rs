use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db;
use crate::error::AppError;
use crate::{log_info, log_warn};
use crate::extension_paths::{collect_extension_paths, merge_extension_paths};
use crate::models::{Profile, StartProfileResult};
use crate::process_win::{
    kill_process_tree, prepare_sidecar_command, register_child_for_lifecycle,
};
use crate::profile_id::parse_profile_id;
use crate::proxy::{self, ResolvedProxy};
use crate::sidecar::emit_sidecar_line;
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};
use crate::win_taskbar;
use crate::AppState;

const PROFILE_IP_GEO_EVENT: &str = "profile-ip-geo-updated";

const INTERACTIVE_EXTRACT_CACHE_FILES: &[&str] = &[
    "ai-browser-interactive-elements.json",
    "ai-browser-agent-elements.json",
];

/// 关闭浏览器时清除元素提取调试/填表缓存（不删 profile 其它数据）。
fn purge_interactive_extract_cache(user_data_dir: &Path) {
    for name in INTERACTIVE_EXTRACT_CACHE_FILES {
        let path = user_data_dir.join(name);
        if path.is_file() {
            if let Err(error) = std::fs::remove_file(&path) {
                log_warn!(
                    "[browser_manager] purge extract cache failed path={} err={error}",
                    path.display()
                );
            }
        }
    }
}

fn profile_user_data_dir(app: &AppHandle, profile_id: &str) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Filesystem(error.to_string()))?
        .join("browser-profiles")
        .join(format!("profile-{profile_id}")))
}

#[derive(Default)]
pub struct BrowserManager {
    processes: Arc<DashMap<String, Child>>,
    /// 启动中的 profile_id（跨 await 互斥），防止同环境双开 / 并发抢 CDP。
    ///
    /// 该标记同时充当**取消信号**：`stop_profile` / `stop_all_profiles` 摘除标记即表示
    /// 「这批在途启动作废」，由 [`BrowserManager::start_profile`] 自行回收刚起的浏览器。
    launching: Arc<DashMap<String, ()>>,
}

/// `launching` 标记的 RAII 看管。
///
/// 手工 `insert` / `remove` 配对跨 `.await` 是不可靠的：future 一旦在 await 点被丢弃
/// （运行时关闭、外层 `timeout` / `select!` 取消），`remove` 永不执行，该环境会被**永久**
/// 判为「正在启动」——之后每次启动都返回 `AlreadyRunning`，停止也清不掉，UI 无法自愈。
struct LaunchingGuard<'a> {
    launching: &'a DashMap<String, ()>,
    profile_id: &'a str,
}

impl Drop for LaunchingGuard<'_> {
    fn drop(&mut self) {
        self.launching.remove(self.profile_id);
    }
}

impl BrowserManager {
    pub fn is_running(&self, profile_id: &str) -> bool {
        self.processes.contains_key(profile_id) || self.launching.contains_key(profile_id)
    }

    /// 向 launch sidecar stdin 发送 extract_now，触发当前页元素提取并推送测试窗。
    pub fn request_interactive_extract(&self, profile_id: &str) -> Result<(), AppError> {
        let mut entry = self.processes.get_mut(profile_id).ok_or_else(|| {
            AppError::Validation(format!(
                "profile {profile_id} is not running; start browser first"
            ))
        })?;
        let stdin = entry.stdin.as_mut().ok_or_else(|| {
            AppError::Launcher("launch sidecar stdin unavailable".to_owned())
        })?;
        stdin
            .write_all(b"{\"command\":\"extract_now\"}\n")
            .map_err(|error| {
                AppError::Launcher(format!("failed to request interactive extract: {error}"))
            })?;
        stdin.flush().map_err(|error| {
            AppError::Launcher(format!("failed to flush extract_now: {error}"))
        })?;
        Ok(())
    }

    /// 向已运行的 launch sidecar 下发 restart。不等待完成，重启结果由主进程下游事件自然反映。
    pub fn request_browser_restart(&self, profile_id: &str) -> Result<(), AppError> {
        self.write_launch_line(profile_id, "{\"command\":\"restart\"}")
    }

    fn write_launch_line(&self, profile_id: &str, json_line: &str) -> Result<(), AppError> {
        let mut entry = self.processes.get_mut(profile_id).ok_or_else(|| {
            AppError::Validation(format!(
                "profile {profile_id} is not running; start browser first"
            ))
        })?;
        let stdin = entry.stdin.as_mut().ok_or_else(|| {
            AppError::Launcher("launch sidecar stdin unavailable".to_owned())
        })?;
        let line = format!("{json_line}\n");
        stdin.write_all(line.as_bytes()).map_err(|error| {
            AppError::Launcher(format!("failed to write launch command: {error}"))
        })?;
        stdin.flush().map_err(|error| {
            AppError::Launcher(format!("failed to flush launch command: {error}"))
        })?;
        Ok(())
    }

    /// 用户改动「存储与下载」设置后，热推给运行中的浏览器 Sidecar，立即重定向下载目录。
    ///
    /// 不推的话，Sidecar 只在启动时读一次目录，用户改完设置必须重启环境才生效。
    pub fn push_download_dirs(&self, browser_dir: &str, scraper_dir: &str) {
        let line = format!(
            "{}\n",
            serde_json::json!({
                "command": "set_download_dirs",
                "browserDownloadDir": browser_dir,
                "scraperDownloadDir": scraper_dir,
            })
        );
        for mut entry in self.processes.iter_mut() {
            let Some(stdin) = entry.value_mut().stdin.as_mut() else {
                continue;
            };
            if let Err(error) = stdin.write_all(line.as_bytes()).and_then(|()| stdin.flush()) {
                log_warn!(
                    "[browser_manager] push download dirs failed profile={}: {error}",
                    entry.key()
                );
            }
        }
    }

    pub async fn start_profile(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: String,
    ) -> Result<StartProfileResult, AppError> {
        if self.is_running(&profile_id) {
            return Err(AppError::AlreadyRunning(profile_id));
        }
        if self
            .launching
            .insert(profile_id.clone(), ())
            .is_some()
        {
            return Err(AppError::AlreadyRunning(profile_id));
        }

        // 标记由 guard 看管：任何早退（含 future 被丢弃）都会摘除，不留「永久启动中」幽灵
        {
            let _guard = LaunchingGuard {
                launching: &self.launching,
                profile_id: &profile_id,
            };

            let result = self
                .start_profile_isolated(app, db_state, profile_id.clone())
                .await;

            // 标记在 await 期间消失 ⇒ 期间收到过 stop：浏览器可能已经起来了，必须回收。
            // 否则「先启动、后停止」会留下孤儿浏览器，且 DB 状态与实际不符。
            if self.launching.contains_key(&profile_id) {
                return result;
            }
            if result.is_ok() {
                match self.stop_profile(app, db_state, profile_id.clone()) {
                    // NotRunning = 停止指令已抢先完成回收，正是我们要的终态，不该报警
                    Ok(()) | Err(AppError::NotRunning(_)) => {}
                    Err(error) => log_warn!(
                        "[browser_manager] 取消启动后的回收失败 profile={profile_id}: {error}"
                    ),
                }
                return Err(AppError::Launcher(format!(
                    "环境 #{profile_id} 的启动已被停止指令取消，已回收刚启动的浏览器"
                )));
            }
            return result;
        }
    }

    /// 单次启动的独立作用域：DB 查询 / 代理解析 / Launch Payload 全部绑定本 `profile_id`。
    async fn start_profile_isolated(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: String,
    ) -> Result<StartProfileResult, AppError> {
        let numeric_id = parse_profile_id(&profile_id)?;

        let launch_outcome = self
            .start_profile_bound(app, db_state, profile_id, numeric_id)
            .await;

        if launch_outcome.is_err() {
            if let Ok(connection) = db_state.database.lock() {
                let _ = db::release_cdp_port_reservation(&connection, numeric_id);
            }
        }

        launch_outcome
    }

    async fn start_profile_bound(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: String,
        numeric_id: i64,
    ) -> Result<StartProfileResult, AppError> {
        let (profile, cdp_port, proxy_input, profiles_root, license_key) = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            if profile.id != numeric_id {
                return Err(AppError::Validation(format!(
                    "profile id mismatch: requested={profile_id} db={}",
                    profile.id
                )));
            }
            // 立刻预留端口，避免并发启动撞 CDP → 连错浏览器/代理表现错位
            let cdp_port = db::allocate_and_reserve_cdp_port(&connection, numeric_id)?;
            let proxy_input = proxy::proxy_resolution_input_from_profile(&connection, &profile)?;
            let profiles_root = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Filesystem(error.to_string()))?
                .join("browser-profiles");
            let license_key = db::get_setting(&connection, "cloak_license_key")?
                .filter(|value| !value.trim().is_empty());
            (profile, cdp_port, proxy_input, profiles_root, license_key)
        };

        let resolved_proxy = match proxy_input {
            Some(input) => Some(proxy::resolve_profile_proxy_input(input).await?),
            None => None,
        };

        let user_data_dir = profiles_root.join(format!("profile-{profile_id}"));
        std::fs::create_dir_all(&user_data_dir)?;
        let user_data_dir = user_data_dir
            .canonicalize()
            .unwrap_or_else(|_| profiles_root.join(format!("profile-{profile_id}")));

        proxy::purge_stale_profile_proxy_auth_ext(&user_data_dir);
        let auth_extension_dir = if let Some(ref resolved) = resolved_proxy {
            if proxy::resolved_proxy_needs_auth_extension(resolved) {
                Some(proxy::generate_proxy_auth_extension(&profile_id, resolved)?)
            } else {
                proxy::purge_proxy_auth_extension(&profile_id);
                None
            }
        } else {
            proxy::purge_proxy_auth_extension(&profile_id);
            None
        };

        let (proxy_env, ip_geo) = match crate::ip_geo::resolve_profile_launch_env(
            resolved_proxy.as_ref(),
            profile.use_geoip,
        )
        .await
        {
            Ok(Some(env)) => {
                let geo = crate::ip_geo::profile_ip_geo_from_env(&profile_id, &env);
                let _ = app.emit(PROFILE_IP_GEO_EVENT, &geo);
                (Some(env), Some(geo))
            }
            Ok(None) => (None, None),
            Err(error) => {
                if resolved_proxy.is_some() {
                    return Err(error);
                }
                log_warn!("[browser_manager] direct geoip sync skipped: {error}");
                (None, None)
            }
        };

        let launch_config = build_launch_config(
            app,
            &profile_id,
            &user_data_dir,
            cdp_port,
            &profile,
            resolved_proxy.as_ref(),
            auth_extension_dir.as_deref(),
            license_key.as_deref(),
            proxy_env.as_ref(),
            true, // 宪法 §1.7：交互元素提取默认恒开
        )?;

        // Launch Payload 自检：profileId / userDataDir / proxyUrl 必须与本环境一致
        let payload_profile_id = launch_config
            .get("profileId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if payload_profile_id != profile_id {
            return Err(AppError::Launcher(format!(
                "launch payload profileId mismatch: payload={payload_profile_id} expected={profile_id}"
            )));
        }
        let child = spawn_cloakbrowser_sidecar(app, &profile_id, &launch_config).await?;

        if self.processes.contains_key(&profile_id) {
            let _ = stop_child(child);
            return Err(AppError::AlreadyRunning(profile_id));
        }

        self.processes.insert(profile_id.clone(), child);
        spawn_launch_exit_watcher(
            self.processes.clone(),
            app.clone(),
            db_state.database.clone(),
            profile_id.clone(),
        );

        {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            if let Err(error) = db::set_profile_running(&connection, numeric_id, cdp_port) {
                if let Some((_, running_child)) = self.processes.remove(&profile_id) {
                    let _ = stop_child(running_child);
                }
                return Err(error);
            }
        }

        let _ = app.emit(
            "browser-status",
            serde_json::json!({
                "profileId": profile_id,
                "status": "running",
                "cdpPort": cdp_port,
            }),
        );

        Ok(StartProfileResult {
            profile_id,
            cdp_port,
            ip_geo,
        })
    }

    pub fn stop_profile(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: String,
    ) -> Result<(), AppError> {
        let numeric_id = parse_profile_id(&profile_id)?;

        // 摘除启动标记 = 向在途 start_profile 发出取消信号（见 start_profile 的取消检查）。
        // 必须放在杀进程之前：先声明「这批启动作废」，再回收已起的进程，避免竞态窗口里
        // 启动流程刚好走到「已 spawn 但尚未登记」而漏杀。
        self.launching.remove(&profile_id);

        let (cdp_port, user_data_dir) = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            let profiles_root = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Filesystem(error.to_string()))?
                .join("browser-profiles");
            let user_data_dir = profiles_root
                .join(format!("profile-{profile_id}"))
                .to_string_lossy()
                .into_owned();
            (profile.cdp_port, user_data_dir)
        };

        if let Some((_, child)) = self.processes.remove(&profile_id) {
            stop_child(child)?;
        }

        match force_kill_profile_browser(app, cdp_port, &user_data_dir) {
            ProfileKillOutcome::Failed => log_warn!(
                "[browser_manager] 环境 #{profile_id} 的浏览器回收获部分失败（进程树可能残留）"
            ),
            // Killed / AlreadyGone 都是预期终态，不打告警
            ProfileKillOutcome::Killed | ProfileKillOutcome::AlreadyGone => {}
        }
        proxy::purge_proxy_auth_extension(&profile_id);
        proxy::purge_stale_profile_proxy_auth_ext(Path::new(&user_data_dir));
        purge_interactive_extract_cache(Path::new(&user_data_dir));

        {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            if profile.status != "running" {
                return Err(AppError::NotRunning(profile_id));
            }
            db::set_profile_stopped(&connection, numeric_id)?;
        }

        let _ = app.emit(
            "browser-status",
            serde_json::json!({
                "profileId": profile_id,
                "status": "stopped",
            }),
        );
        let _ = app.emit(
            "interactive-extract-cleared",
            serde_json::json!({ "profileId": profile_id }),
        );

        Ok(())
    }

    pub fn running_profile_ids(&self) -> Vec<String> {
        self.processes
            .iter()
            .map(|entry| entry.key().clone())
            .collect()
    }

    pub fn stop_all_profiles(
        &self,
        app: &AppHandle,
        db_state: &AppState,
    ) -> Result<usize, AppError> {
        let profiles_root = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::Filesystem(error.to_string()))?
            .join("browser-profiles");

        let targets = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let mut profile_ids: HashSet<String> =
                self.running_profile_ids().into_iter().collect();
            // 在途启动（launching）也必须纳入：否则「全部停止」之后这些环境仍会陆续
            // 启动出来，变成孤儿浏览器 + DB 状态与实际不符。
            for key in self.launching.iter().map(|entry| entry.key().clone()) {
                profile_ids.insert(key);
            }
            // 摘除全部启动标记 = 向所有在途 start_profile 发出取消信号；它们会在
            // 自身收尾时回收刚启动的浏览器（见 start_profile 的取消检查）。
            self.launching.clear();
            for profile in db::list_profiles(&connection)? {
                if profile.status == "running" {
                    profile_ids.insert(profile.id.to_string());
                }
            }

            let mut rows = Vec::new();
            for profile_id in profile_ids {
                if let Ok(numeric_id) = parse_profile_id(&profile_id) {
                    let profile = db::get_profile(&connection, numeric_id)?;
                    let user_data_dir = profiles_root
                        .join(format!("profile-{profile_id}"))
                        .to_string_lossy()
                        .into_owned();
                    rows.push((profile_id, profile.cdp_port, user_data_dir));
                }
            }
            rows
        };

        let mut stopped = 0usize;
        for (profile_id, cdp_port, user_data_dir) in targets {
            if let Some((_, child)) = self.processes.remove(&profile_id) {
                let _ = stop_child(child);
            }

            match force_kill_profile_browser(app, cdp_port, &user_data_dir) {
                // AlreadyGone：DB/内存登记为运行但实际已无进程 —— 状态即将纠正为 stopped，
                // 对用户而言就是「这个环境已经停了」，计入已停止数才不会出现「全部停止 0 个」
                ProfileKillOutcome::Killed | ProfileKillOutcome::AlreadyGone => stopped += 1,
                ProfileKillOutcome::Failed => log_warn!(
                    "[browser_manager] 全部停止：环境 #{profile_id} 的浏览器回收失败（进程树可能残留）"
                ),
            }
            proxy::purge_proxy_auth_extension(&profile_id);
            proxy::purge_stale_profile_proxy_auth_ext(Path::new(&user_data_dir));
            purge_interactive_extract_cache(Path::new(&user_data_dir));

            if let Ok(numeric_id) = parse_profile_id(&profile_id) {
                let connection = db_state
                    .database
                    .lock()
                    .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
                if db::get_profile(&connection, numeric_id)?.status == "running" {
                    db::set_profile_stopped(&connection, numeric_id)?;
                }
            }

            let _ = app.emit(
                "browser-status",
                serde_json::json!({
                    "profileId": profile_id,
                    "status": "stopped",
                }),
            );
            let _ = app.emit(
                "interactive-extract-cleared",
                serde_json::json!({ "profileId": profile_id }),
            );
        }

        // 扫尾：DB/内存未登记但仍占席位的孤儿 Chromium（仅限本应用 browser-profiles）
        #[cfg(windows)]
        {
            let orphan = crate::win_taskbar::kill_all_browsers_under_profiles_root(
                &profiles_root.to_string_lossy(),
            );
            if orphan > 0 {
                log_info!(
                    "[browser_manager] stop_all orphan kill under profiles_root={orphan} process tree(s)"
                );
                stopped = stopped.saturating_add(orphan);
            }
        }

        Ok(stopped)
    }
}

#[tauri::command]
pub fn get_running_profile_ids(manager: State<'_, BrowserManager>) -> Vec<String> {
    manager.running_profile_ids()
}

/// Bring the running profile's Chromium window to the foreground (Windows).
#[tauri::command]
pub async fn focus_profile_browser(
    db_state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), AppError> {
    let numeric_id = parse_profile_id(&profile_id)?;
    let cdp_port = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        profile
            .cdp_port
            .filter(|port| *port > 0 && *port <= i64::from(u16::MAX))
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "环境 #{profile_id} 无有效 CDP 端口（请确认浏览器已启动）"
                ))
            })?
    };
    let port = cdp_port as u16;
    tauri::async_runtime::spawn_blocking(move || {
        crate::win_taskbar::focus_browser_by_cdp_port(port)
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
    .map_err(AppError::Launcher)
}

#[tauri::command]
pub fn stop_all_profiles(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    db_state: State<'_, AppState>,
    rpa_manager: State<'_, crate::rpa_session::RpaSessionManager>,
) -> Result<usize, AppError> {
    rpa_manager.stop_all_sessions();
    let stopped = manager.stop_all_profiles(&app, &db_state)?;
    crate::proxy::purge_all_proxy_auth_extensions();
    Ok(stopped)
}

#[tauri::command]
pub async fn start_profile(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    db_state: State<'_, AppState>,
    profile_id: String,
) -> Result<StartProfileResult, AppError> {
    manager.start_profile(&app, &db_state, profile_id).await
}

#[tauri::command]
pub fn stop_profile(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    db_state: State<'_, AppState>,
    rpa_manager: State<'_, crate::rpa_session::RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    // Kill Switch：先杀 Sidecar，再停浏览器，杜绝僵尸 Node
    let _ = rpa_manager.stop_session(&profile_id);
    manager.stop_profile(&app, &db_state, profile_id)
}

/// 解析环境额外启动网址（JSON 数组）；失败时返回空列表，不阻断启动。
fn parse_startup_urls_for_launch(raw: &str) -> Vec<String> {
    match serde_json::from_str::<Vec<String>>(raw.trim()) {
        Ok(items) => items
            .into_iter()
            .map(|item| item.trim().to_owned())
            .filter(|item| !item.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn build_launch_config(
    app: &AppHandle,
    profile_id: &str,
    user_data_dir: &Path,
    cdp_port: u16,
    profile: &Profile,
    resolved_proxy: Option<&ResolvedProxy>,
    auth_extension_dir: Option<&str>,
    license_key: Option<&str>,
    proxy_env: Option<&crate::ip_geo::ProxyEnvSync>,
    interactive_element_extract_enabled: bool,
) -> Result<serde_json::Value, AppError> {
    let proxy_url = resolved_proxy.map(ResolvedProxy::chromium_proxy_flag);
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Filesystem(error.to_string()))?;
    let extension_paths =
        merge_extension_paths(auth_extension_dir, collect_extension_paths(&app_data_dir));

    let mut config = json!({
        "profileId": profile_id,
        "userDataDir": user_data_dir.to_string_lossy(),
        "cdpPort": cdp_port,
        "proxyUrl": proxy_url,
        "useGeoip": profile.use_geoip,
        "humanize": profile.humanize,
        "fingerprintSeed": profile.fingerprint_seed,
        "stealthPreset": profile.stealth_preset,
        "webglMode": profile.webgl_mode,
        "extensionPaths": extension_paths,
        "licenseKey": license_key,
        "themeColor": profile.theme_color,
        "interactiveElementExtractEnabled": interactive_element_extract_enabled,
        "startupUrls": parse_startup_urls_for_launch(&profile.startup_urls),
    });

    let browser_version = profile.browser_version.trim();
    // 仅传入 CloakBrowser 认可的完整 pin；脏值（如「CloakBrowser」）会导致 launch 直接失败
    if db::is_valid_browser_version_pin(browser_version) {
        config["browserVersion"] = json!(browser_version);
    }

    if let Some(resolved) = resolved_proxy {
        if let Some(username) = resolved
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            config["proxyUsername"] = json!(username);
            config["proxyPassword"] = json!(resolved.password.clone().unwrap_or_default());
        }
    }

    if let Some(env) = proxy_env {
        config["proxyEnv"] = json!({
            "exitIp": env.exit_ip,
            "timezone": env.timezone,
            "locale": env.locale,
            "latitude": env.latitude,
            "longitude": env.longitude,
            "countryCode": env.country_code,
            "country": env.country,
        });
    }

    if let Some(browse_root) = crate::kernel_policy::resolve_bundled_browse_root() {
        config["bundledBrowseRoot"] = json!(browse_root.to_string_lossy());
    }

    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(connection) = state.database.lock() {
            if let Ok(roots) = crate::storage_paths::download_roots_json(app, &connection) {
                if let Some(browser) = roots.get("browserDownloadDir") {
                    config["browserDownloadDir"] = browser.clone();
                }
                if let Some(scraper) = roots.get("scraperDownloadDir") {
                    config["scraperDownloadDir"] = scraper.clone();
                }
            }

            // CloakBrowser Pro 官方指南兼容旗标（全局开关，默认 false）
            config["licenseThroughProxy"] =
                json!(db::get_bool_setting(&connection, "license_through_proxy")?);
            config["allowThirdPartyCookies"] =
                json!(db::get_bool_setting(&connection, "allow_third_party_cookies")?);
            config["fingerprintOff"] =
                json!(db::get_bool_setting(&connection, "fingerprint_off")?);

            // 用户自定义内核路径：① 按版本 pin 的映射（启动命中即跳过下载）；
            // ② 全局浏览器路径（cloak_path，修复此前配置不参与启动的死链）。
            let global_browser_path = db::get_setting(&connection, "cloak_path")?
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            if let Some(path) = global_browser_path {
                config["globalBrowserPath"] = json!(path);
            }
            let kernel_paths_raw = db::get_setting(&connection, "kernel_paths")?
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            if let Some(raw) = kernel_paths_raw {
                if let Ok(map) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if map.is_object() {
                        config["kernelPaths"] = map;
                    }
                }
            }
        }
    }

    Ok(config)
}

async fn spawn_cloakbrowser_sidecar(
    app: &AppHandle,
    profile_id: &str,
    launch_config: &serde_json::Value,
) -> Result<Child, AppError> {
    let launch_entry = resolve_sidecar_dist("launch.js").map_err(|error| match error {
        AppError::Sidecar(message) => AppError::Launcher(message),
        other => other,
    })?;
    let sidecar_dir = sidecar_working_dir(&launch_entry);

    // launch sidecar 是长生命周期子进程，配置须存活到它读完为止，
    // 因此不适用 RAII：Rust 只负责写入，删除由读取方（sidecar launch.ts）读完即执行。
    let config_file = crate::temp_config::write_leased_config(
        "launch",
        launch_config
            .get("profileId")
            .and_then(|value| value.as_str())
            .unwrap_or("profile"),
        &launch_config.to_string(),
    )
    .map_err(|error| AppError::Launcher(format!("failed to write launch config: {error}")))?;

    let mut command = Command::new("node");
    command
        .arg(&launch_entry)
        .arg(format!("--config-file={}", config_file.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    prepare_sidecar_command(&mut command);

    if let Some(dir) = sidecar_dir {
        command.current_dir(dir);
    }

    if let Some(key) = launch_config
        .get("licenseKey")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        command.env("CLOAKBROWSER_LICENSE_KEY", key);
    }

    let mut child = command.spawn().map_err(|error| {
        // spawn 失败时没有读取方会接手删除，立即回收，避免带 License Key 的配置滞留磁盘
        let _ = std::fs::remove_file(&config_file);
        AppError::Launcher(format!("failed to spawn cloakbrowser sidecar: {error}"))
    })?;
    // Job Object / 进程组：Tauri 强杀时级联回收 Node + Chromium 树
    if let Err(error) = register_child_for_lifecycle(&child) {
        log_warn!("[browser_manager] register_child_for_lifecycle skipped: {error}");
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Launcher("launch sidecar stdout unavailable".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Launcher("launch sidecar stderr unavailable".to_owned()))?;

    let launch_rx = start_launch_sidecar_pump(app.clone(), profile_id.to_owned(), stdout, stderr);

    let launch_result = tauri::async_runtime::spawn_blocking(move || {
        launch_rx.recv_timeout(Duration::from_secs(120)).map_err(|_| {
            AppError::Launcher("cloakbrowser launch timed out after 120s".to_owned())
        })
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?;

    match launch_result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    }

    Ok(child)
}

fn emit_launch_sidecar_line(app: &AppHandle, profile_id: &str, line: &str) {
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        if value.get("type").and_then(|entry| entry.as_str()) == Some("page_url") {
            let url = value
                .get("url")
                .and_then(|entry| entry.as_str())
                .unwrap_or("")
                .to_owned();
            let event_profile_id = value
                .get("profile_id")
                .and_then(|entry| entry.as_str())
                .unwrap_or(profile_id)
                .to_owned();
            let _ = app.emit(
                "page-url-changed",
                json!({
                    "profileId": event_profile_id,
                    "url": url,
                }),
            );
            return;
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("interactive_extract") {
            let event_profile_id = value
                .get("profile_id")
                .and_then(|entry| entry.as_str())
                .unwrap_or(profile_id)
                .to_owned();
            let mut payload = value.clone();
            if let Some(object) = payload.as_object_mut() {
                object.insert("profileId".to_owned(), json!(event_profile_id));
            }
            let _ = app.emit("interactive-extract-updated", payload);
            return;
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("browser_status") {
            let status = value
                .get("status")
                .and_then(|entry| entry.as_str())
                .unwrap_or("unknown");
            let event_profile_id = value
                .get("profile_id")
                .and_then(|entry| entry.as_str())
                .unwrap_or(profile_id);
            if status == "stopped" {
                if let Ok(dir) = profile_user_data_dir(app, event_profile_id) {
                    purge_interactive_extract_cache(&dir);
                }
                let _ = app.emit(
                    "interactive-extract-cleared",
                    json!({ "profileId": event_profile_id }),
                );
            }
            let mut payload = json!({
                "profileId": event_profile_id,
                "status": status,
            });
            if let Some(cdp_port) = value.get("cdp_port").and_then(|entry| entry.as_u64()) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("cdpPort".to_owned(), json!(cdp_port));
                }
            }
            let _ = app.emit("browser-status", payload);
            return;
        }

        if value.get("kind").and_then(|entry| entry.as_str()) == Some("result")
            && value.get("message").and_then(|entry| entry.as_str()) == Some("browser_launched")
        {
            let data = value.get("data").and_then(|entry| entry.as_object());
            let event_profile_id = data
                .and_then(|entry| entry.get("profileId"))
                .and_then(|entry| entry.as_str())
                .unwrap_or(profile_id);
            let cdp_port = data
                .and_then(|entry| entry.get("cdpPort"))
                .and_then(|entry| entry.as_u64())
                .map(|entry| entry as u16)
                .unwrap_or(0);
            let theme_color = data
                .and_then(|entry| entry.get("themeColor"))
                .and_then(|entry| entry.as_str())
                .map(str::to_owned);
            let user_data_dir = data
                .and_then(|entry| entry.get("userDataDir"))
                .and_then(|entry| entry.as_str())
                .map(str::to_owned);
            if cdp_port > 0 {
                let profile_id_owned = event_profile_id.to_owned();
                std::thread::spawn(move || {
                    if let Err(error) = win_taskbar::apply_profile_taskbar_badge(
                        cdp_port,
                        &profile_id_owned,
                        theme_color.as_deref(),
                        user_data_dir.as_deref(),
                        12,
                    ) {
                        log_warn!("[taskbar_badge] profile={profile_id_owned} port={cdp_port}: {error}");
                    }
                });
            }
            return;
        }
    }

    emit_sidecar_line(app, line);
}

fn start_launch_sidecar_pump(
    app: AppHandle,
    profile_id: String,
    stdout: impl std::io::Read + Send + 'static,
    stderr: impl std::io::Read + Send + 'static,
) -> mpsc::Receiver<Result<(), AppError>> {
    let (launch_tx, launch_rx) = mpsc::sync_channel(1);
    let app_stdout = app.clone();
    let profile_stdout = profile_id.clone();

    std::thread::spawn(move || {
        let stdout_reader = BufReader::new(stdout);
        let mut launch_reported = false;

        for line in stdout_reader.lines() {
            let line = match line {
                Ok(value) => value,
                Err(_) => break,
            };

            emit_launch_sidecar_line(&app_stdout, &profile_stdout, &line);

            if launch_reported {
                continue;
            }

            match parse_launch_stdout_line(&line) {
                LaunchStdoutEvent::Launched => {
                    launch_reported = true;
                    let _ = launch_tx.send(Ok(()));
                }
                LaunchStdoutEvent::Failed(detail) => {
                    launch_reported = true;
                    let _ = launch_tx.send(Err(AppError::Launcher(format!(
                        "cloakbrowser launch failed: {detail}"
                    ))));
                }
                LaunchStdoutEvent::Ignore => {}
            }
        }

        if !launch_reported {
            let _ = launch_tx.send(Err(AppError::Launcher(
                "launch sidecar exited before browser_launched".to_owned(),
            )));
        }
    });

    let app_stderr = app;
    std::thread::spawn(move || {
        let stderr_reader = BufReader::new(stderr);
        for line in stderr_reader.lines().flatten() {
            emit_launch_sidecar_line(
                &app_stderr,
                &profile_id,
                &serde_json::json!({
                    "kind": "error",
                    "level": "error",
                    "message": "launch_sidecar_stderr",
                    "data": { "line": line }
                })
                .to_string(),
            );
        }
    });

    launch_rx
}

fn spawn_launch_exit_watcher(
    processes: Arc<DashMap<String, Child>>,
    app: AppHandle,
    database: Arc<std::sync::Mutex<Connection>>,
    profile_id: String,
) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));

            let exited = if let Some(mut entry) = processes.get_mut(&profile_id) {
                match entry.try_wait() {
                    Ok(Some(_status)) => true,
                    Ok(None) => false,
                    Err(_) => true,
                }
            } else {
                break;
            };

            if !exited {
                continue;
            }

            processes.remove(&profile_id);

            if let Ok(numeric_id) = parse_profile_id(&profile_id) {
                if let Ok(connection) = database.lock() {
                    if let Ok(profile) = db::get_profile(&connection, numeric_id) {
                        if profile.status == "running" {
                            let _ = db::set_profile_stopped(&connection, numeric_id);
                            let _ = app.emit(
                                "browser-status",
                                json!({
                                    "profileId": profile_id,
                                    "status": "stopped",
                                }),
                            );
                        }
                    }
                }
            }

            break;
        }
    });
}

enum LaunchStdoutEvent {
    Launched,
    Failed(String),
    Ignore,
}

fn parse_launch_stdout_line(line: &str) -> LaunchStdoutEvent {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
        if value.get("type").and_then(|entry| entry.as_str()) == Some("error")
            && value.get("code").and_then(|entry| entry.as_str()) == Some("LAUNCH_FAILED")
        {
            let message = value
                .get("message")
                .and_then(|entry| entry.as_str())
                .unwrap_or("unknown launch error");
            return LaunchStdoutEvent::Failed(message.to_owned());
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("browser_status")
            && value.get("status").and_then(|entry| entry.as_str()) == Some("running")
        {
            return LaunchStdoutEvent::Launched;
        }

        if value.get("message").and_then(|entry| entry.as_str()) == Some("browser_launched") {
            return LaunchStdoutEvent::Launched;
        }

        if value.get("kind").and_then(|entry| entry.as_str()) == Some("error") {
            let message = value.get("message").and_then(|entry| entry.as_str()).unwrap_or("");
            if message == "launch_failed" || message == "unhandled_launch_error" {
                let detail = value
                    .get("data")
                    .and_then(|entry| entry.get("error"))
                    .and_then(|entry| entry.as_str())
                    .unwrap_or(message);
                return LaunchStdoutEvent::Failed(detail.to_owned());
            }
        }
    }

    if line.contains("browser_launched") || line.contains("\"type\":\"browser_status\"") {
        return LaunchStdoutEvent::Launched;
    }
    if line.contains("LAUNCH_FAILED") || line.contains("\"message\":\"launch_failed\"") {
        return LaunchStdoutEvent::Failed(line.to_owned());
    }

    LaunchStdoutEvent::Ignore
}

fn stop_child(mut child: Child) -> Result<(), AppError> {
    let pid = child.id();

    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"{\"command\":\"shutdown\"}\n");
        let _ = stdin.flush();
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(AppError::Launcher(format!(
                    "failed while waiting for browser exit: {error}"
                )));
            }
        }
    }

    let _ = kill_process_tree(pid);

    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            child
                .kill()
                .map_err(|error| AppError::Launcher(format!("failed to kill browser process: {error}")))?;
            child.wait().map_err(|error| {
                AppError::Launcher(format!("failed to wait for browser exit: {error}"))
            })?;
            Ok(())
        }
        Err(error) => Err(AppError::Launcher(format!(
            "failed while waiting for browser exit: {error}"
        ))),
    }
}

/// 强制回收环境浏览器的三态结果。
///
/// 把「端口上没有进程」也算作失败是错的：启动被取消、浏览器已自行退出等场景下，
/// 端口本就没人监听，报「进程树可能残留」会让排查者去追一个不存在的幽灵，
/// 久了真实告警就被当成噪声忽略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileKillOutcome {
    /// 确实回收了进程
    Killed,
    /// 该环境本就没有活着的浏览器（已退出 / 尚未启动）
    AlreadyGone,
    /// 找到了进程但回收失败，才是需要告警的残留
    Failed,
}

/// 由「按 user-data-dir 批量回收」的结果判定环境回收终态。
///
/// 单独抽出以便锁定规则：**没匹配到进程不是失败**。启动被取消、浏览器已自行退出时
/// 端口与目录上本就没有进程，报「可能残留」会把排查者引向不存在的幽灵进程。
fn classify_user_data_dir_kill(
    outcome: crate::win_taskbar::KillBrowsersOutcome,
) -> ProfileKillOutcome {
    if outcome.killed > 0 {
        ProfileKillOutcome::Killed
    } else if outcome.matched > 0 {
        // 匹配到了却一个都没杀掉：这才是真残留
        ProfileKillOutcome::Failed
    } else {
        ProfileKillOutcome::AlreadyGone
    }
}

fn force_kill_profile_browser(
    app: &AppHandle,
    cdp_port: Option<i64>,
    user_data_dir: &str,
) -> ProfileKillOutcome {
    #[cfg(windows)]
    {
        if let Some(port) = cdp_port.filter(|value| *value > 0 && *value <= u16::MAX as i64) {
            let port = port as u16;
            if crate::win_taskbar::kill_browser_for_profile(port, Some(user_data_dir)).is_ok() {
                return ProfileKillOutcome::Killed;
            }
            // 端口上仍有监听者却杀不掉 —— 这一支才是真失败
            if let Some(pid) = crate::win_taskbar::find_pid_listening_on_port(port) {
                return match kill_process_tree(pid) {
                    Ok(()) => ProfileKillOutcome::Killed,
                    Err(_) => ProfileKillOutcome::Failed,
                };
            }
        }
        // 无有效 CDP / 端口已释放：仍按 user-data-dir 清幽灵进程，释放收费席位
        if !user_data_dir.trim().is_empty() {
            let outcome = crate::win_taskbar::kill_browsers_matching_user_data_dir(user_data_dir);
            return classify_user_data_dir_kill(outcome);
        }
        let _ = app;
        ProfileKillOutcome::AlreadyGone
    }

    #[cfg(not(windows))]
    {
        let Some(port) = cdp_port.filter(|value| *value > 0 && *value <= u16::MAX as i64) else {
            let _ = (app, user_data_dir);
            return ProfileKillOutcome::AlreadyGone;
        };
        if let Some(pid) = crate::win_taskbar::find_pid_listening_on_port(port as u16) {
            return match kill_process_tree(pid) {
                Ok(()) => ProfileKillOutcome::Killed,
                Err(_) => ProfileKillOutcome::Failed,
            };
        }
        let _ = app;
        ProfileKillOutcome::AlreadyGone
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 标记存在期间 `is_running` 必须为真（跨 await 互斥的依据）。
    #[test]
    fn launching_marker_makes_profile_considered_running() {
        let manager = BrowserManager::default();
        assert!(!manager.is_running("7"));
        manager.launching.insert("7".to_owned(), ());
        assert!(manager.is_running("7"));
    }

    /// 关键回归：启动 future 在 await 点被丢弃 / 任务 panic 时（运行时关闭、外层
    /// `timeout` / `select!` 取消），标记必须由 guard 摘除。若靠手工 `remove`，
    /// 该环境会被永久判为「启动中」——之后每次启动都 `AlreadyRunning`，且停止也清不掉。
    #[test]
    fn launching_guard_releases_marker_on_unwind() {
        let manager = BrowserManager::default();

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            manager.launching.insert("7".to_owned(), ());
            let _guard = LaunchingGuard {
                launching: &manager.launching,
                profile_id: "7",
            };
            assert!(manager.is_running("7"), "登记后应视为启动中");
            panic!("模拟启动中途 future 被丢弃");
        }));

        assert!(outcome.is_err(), "测试自身应触发 panic 展开");
        assert!(
            !manager.is_running("7"),
            "展开路径也必须摘除标记，否则该环境永久无法再启动"
        );
    }

    /// 正常收尾（guard 作用域结束）同样必须摘除，且对未登记的 id 幂等。
    #[test]
    fn launching_guard_releases_marker_normally_and_is_idempotent() {
        let manager = BrowserManager::default();
        manager.launching.insert("8".to_owned(), ());
        {
            let _guard = LaunchingGuard {
                launching: &manager.launching,
                profile_id: "8",
            };
        }
        assert!(!manager.is_running("8"));

        // 二次释放不应 panic（stop_profile 也会摘除同名标记）
        manager.launching.remove("8");
        assert!(!manager.is_running("8"));
    }

    /// 回归：`force_kill_profile_browser` 过去把「端口上没有进程」也报成失败，
    /// 于是日志里出现「进程树可能残留」的假告警（冒烟实测已命中）。三态判定必须
    /// 让「没匹配到」落到 AlreadyGone，只有「匹配到却杀不掉」才算 Failed。
    #[test]
    fn user_data_dir_kill_classification_separates_absent_from_failed() {
        use crate::win_taskbar::KillBrowsersOutcome;

        // 一个都没匹配到 → 浏览器本就不在（取消启动 / 已自行退出）
        assert_eq!(
            classify_user_data_dir_kill(KillBrowsersOutcome {
                matched: 0,
                killed: 0
            }),
            ProfileKillOutcome::AlreadyGone
        );

        // 匹配到 3 个全部回收 → 成功
        assert_eq!(
            classify_user_data_dir_kill(KillBrowsersOutcome {
                matched: 3,
                killed: 3
            }),
            ProfileKillOutcome::Killed
        );

        // 部分回收成功仍算成功（已无残留进程不可达，无法保证 100%，但不该报残留）
        assert_eq!(
            classify_user_data_dir_kill(KillBrowsersOutcome {
                matched: 3,
                killed: 1
            }),
            ProfileKillOutcome::Killed
        );

        // 匹配到却一个都没杀掉 → 真残留，必须告警
        assert_eq!(
            classify_user_data_dir_kill(KillBrowsersOutcome {
                matched: 2,
                killed: 0
            }),
            ProfileKillOutcome::Failed
        );
    }
}
