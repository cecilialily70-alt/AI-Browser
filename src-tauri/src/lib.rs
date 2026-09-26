pub mod ai;
pub mod app_env;
pub mod browser_manager;
pub mod cache_cleanup;
pub mod clipboard;
pub mod cloak_binary;
pub mod commands;
pub mod cookie_ops;
pub mod data_api;
pub mod data_planner;
pub mod db;
pub mod db_write_queue;
pub mod error;
pub mod extension_paths;
pub mod fill_sidecar;
pub mod trajectory_files;
pub mod key_file;
pub mod local_ipc;
pub mod ip_geo;
pub mod kernel_policy;
pub mod logging;
pub mod models;
pub mod process_win;
pub mod profile_id;
pub mod proxy;
pub mod replay_job;
pub mod replay_plan;
pub mod rpa_session;
pub mod secret_store;
pub mod settings_probe;
pub mod sidecar;
pub mod sidecar_paths;
pub mod storage_paths;
pub mod temp_config;
pub mod webview;
pub mod win_taskbar;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{Manager, RunEvent};

use crate::ai::ai_chat;
use crate::data_planner::{mock_sandbox_fields, plan_batch_replay_data};
use crate::browser_manager::{
    focus_profile_browser, get_running_profile_ids, start_profile, stop_all_profiles,
    stop_profile, BrowserManager,
};
use crate::commands::{
    add_dynamic_api_proxy, add_proxy, batch_add_proxies, batch_create_profiles, batch_delete_profiles,
    batch_delete_proxies, batch_delete_agent_runs, clear_agent_control_memory, create_profile, delete_agent_run,
    delete_agent_trajectory, delete_profile, delete_secret_ref, delete_template,
    export_profile_cookies, export_text_to_download_dir, get_agent_run, get_otp_channel_binding,
    get_profiles, get_proxies, get_settings, get_templates_by_domain, import_profile_cookies,
    list_agent_control_memory, list_agent_runs, summarize_agent_run_board, list_agent_trajectories, open_external_url,
    open_path_in_os,
    pick_directory, prepare_console_exit, put_secret_ref, request_profile_interactive_extract,
    save_template, secret_ref_exists, set_profile_agent_panorama, set_profile_interactive_extract,
    set_profile_otp_channel, test_proxy_connection,
    toggle_template_auto_apply, update_profile, update_setting, purge_automation_cache,
};
use crate::db::init_database;
use crate::db_write_queue::DbWriteQueue;
use crate::local_ipc::LocalIpcServer;
use crate::error::AppError;
use crate::cloak_binary::{
    cleanup_cloak_binary, diagnose_cloak_binary, download_cloak_binary, get_cloak_binary_status,
    update_cloak_binary,
};
use crate::kernel_policy::list_local_kernels;
use crate::settings_probe::{
    test_ai_connection, test_cloak_path, test_otp_channel,
};
use crate::replay_plan::build_replay_run_plan;
use crate::rpa_session::{
    abort_autonomous_agent, bring_profile_to_front, cancel_agent_action, confirm_agent_action,
    continue_agent_handover, get_profile_page_url, pause_autonomous_agent, pause_rpa_fill,
    replay_agent_trajectory, reply_agent_ask, rescan_rpa_page, resume_rpa_fill, run_rpa_fill,
    start_autonomous_agent, RpaSessionManager,
};
use crate::key_file::{
    check_license_entitlement, clear_cloak_license_key, import_key_file, pick_key_file,
    set_cloak_license_key, test_key_file,
};
use crate::sidecar::{preview_ai_fill, run_direct_fill, run_smart_fill};

pub struct AppState {
    pub database: Arc<Mutex<Connection>>,
    /// 前端在退出确认框选择「否（保留浏览器）」时为 true，
    /// shutdown_all_runtimes 据此跳过清进程树，避免覆盖用户意图。
    pub keep_runtime_on_exit: Arc<AtomicBool>,
    /// Milestone 1：数据库单写队列（所有落库上报统一由此串行写入）
    pub db_queue: Arc<DbWriteQueue>,
    /// Milestone 1：本地 IPC 服务句柄（Node Sidecar 通过 HTTP /report 上报）
    pub local_ipc: LocalIpcServer,
}

fn shutdown_all_runtimes(app: &tauri::AppHandle) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }

    // 用户选择「否（保留浏览器）」：跳过清进程树，保留浏览器/Agent/代理扩展。
    let keep_running = app
        .try_state::<AppState>()
        .map(|state| state.keep_runtime_on_exit.load(Ordering::SeqCst))
        .unwrap_or(false);
    if keep_running {
        log_info!("TianshuTai: console exiting while keeping runtimes alive (skip cleanup)");
        return;
    }

    log_info!("TianshuTai: shutting down sidecars and browser processes");

    if let Some(rpa) = app.try_state::<RpaSessionManager>() {
        rpa.stop_all_sessions();
    }

    if let Some(manager) = app.try_state::<BrowserManager>() {
        if let Some(db_state) = app.try_state::<AppState>() {
            if let Err(error) = manager.stop_all_profiles(app, db_state.inner()) {
                log_error!("TianshuTai: shutdown stop_all_profiles failed: {error}");
            }
        }
    }

    // —— Milestone 1：优雅退出 ——
    // 1) 先停本地 IPC（拒绝新上报，等待在途 HTTP 请求处理完毕）
    // 2) 再排空单写队列（FIFO 执行完存量命令后 join 写线程，不丢上报数据）
    // 外部数据 API：立刻停止接新请求（在途请求走完）
    if let Some(handle) = app.try_state::<crate::data_api::DataApiHandle>() {
        handle.stop();
    }

    if let Some(state) = app.try_state::<AppState>() {
        state.local_ipc.shutdown();
        state.db_queue.shutdown();
    }

    crate::proxy::purge_all_proxy_auth_extensions();
}

pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Filesystem(error.to_string()))?;
            let database_path = app_data_dir.join("ai-browser.sqlite3");
            let connection = init_database(&database_path)?;
            let reset_count = crate::db::reset_stale_running_profiles(&connection)?;
            if reset_count > 0 {
                log_warn!(
                    "AI Browser: reset {reset_count} stale running profile(s) after restart"
                );
            }

            // 断电 / 崩溃会留下未过期的回放租约与停在 running 的 job：
            // 回收过期租约（行回 pending）+ 给已无未完成轮次的 job 收尾。**不重新分配**（§5.9）。
            let reaped = crate::replay_job::recover_after_restart(&connection)?;
            if reaped > 0 {
                log_warn!("AI Browser: reaped {reaped} expired replay lease(s) after restart");
            }

            // 硬杀（任务管理器 / 断电 / 崩溃）会留下未被读取的临时配置，含凭据。
            // 正常配置在创建后数秒内即被消费，故 1 小时前的一律视为孤儿。
            // 放后台线程：清扫要遍历整个 %TEMP%，不应拖慢启动路径。
            std::thread::spawn(|| {
                let swept = crate::temp_config::sweep_orphan_configs(
                    &std::env::temp_dir(),
                    std::time::Duration::from_secs(3600),
                );
                if swept > 0 {
                    log_warn!(
                        "AI Browser: swept {swept} orphan temp config file(s) from previous run"
                    );
                }
            });

            // —— Milestone 1：数据库单写队列 + 本地 IPC 服务 ——
            let database = Arc::new(Mutex::new(connection));
            let db_queue = Arc::new(DbWriteQueue::new(database.clone())?);
            let local_ipc = crate::local_ipc::start_local_ipc(app.handle().clone(), db_queue.clone())?;
            log_info!("TianshuTai: local ipc server listening at {}", local_ipc.base_url);

            // —— 外部数据 API（给用户自己的 Python 等程序传数据用）——
            // 默认关闭；用户显式打开后才监听。令牌持久化在库设置里，可单独轮换。
            let data_api = crate::data_api::DataApiHandle::default();
            {
                let (enabled, token) = {
                    let connection = database
                        .lock()
                        .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
                    (
                        crate::db::get_setting(&connection, crate::data_api::ENABLED_KEY)?
                            .as_deref()
                            == Some("1"),
                        crate::db::get_setting(&connection, crate::data_api::TOKEN_KEY)?,
                    )
                };
                if enabled {
                    // 令牌缺失就补一个（老库升级上来时首次打开）
                    let token = match token.filter(|value| !value.trim().is_empty()) {
                        Some(token) => token,
                        None => {
                            let fresh = crate::data_api::generate_api_token();
                            if let Ok(connection) = database.lock() {
                                let _ = crate::db::set_setting(
                                    &connection,
                                    crate::data_api::TOKEN_KEY,
                                    &fresh,
                                );
                            }
                            fresh
                        }
                    };
                    match data_api.start(app.handle().clone(), token) {
                        Ok(base_url) => {
                            log_info!("TianshuTai: external data api listening at {base_url}")
                        }
                        Err(error) => {
                            log_warn!("TianshuTai: external data api start failed: {error}")
                        }
                    }
                }
            }

            app.manage(AppState {
                database,
                keep_runtime_on_exit: Arc::new(AtomicBool::new(false)),
                db_queue,
                local_ipc,
            });
            app.manage(BrowserManager::default());
            app.manage(RpaSessionManager::default());
            app.manage(data_api);

            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = webview::disable_default_browser_ui(&window) {
                    log_warn!("TianshuTai: webview hardening skipped: {error}");
                }
                // 运行时注入 256 RGBA，避免 exe 内嵌旧 ICO/BMP 在任务栏发糊
                const ICON_RGBA: &[u8] = include_bytes!("../icons/icon_256.rgba");
                const ICON_SIZE: u32 = 256;
                if ICON_RGBA.len() == (ICON_SIZE * ICON_SIZE * 4) as usize {
                    let icon = tauri::image::Image::new_owned(
                        ICON_RGBA.to_vec(),
                        ICON_SIZE,
                        ICON_SIZE,
                    );
                    if let Err(error) = window.set_icon(icon) {
                        log_warn!("TianshuTai: set window icon skipped: {error}");
                    }
                } else {
                    log_warn!(
                        "TianshuTai: icon_256.rgba size mismatch: {}",
                        ICON_RGBA.len()
                    );
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_profiles,
            get_settings,
            update_setting,
            crate::data_api::get_external_data_api_state,
            crate::data_api::set_external_data_api_enabled,
            crate::data_api::regenerate_external_data_api_token,
            crate::data_api::set_external_data_api_capability,
            get_proxies,
            add_proxy,
            batch_add_proxies,
            batch_delete_proxies,
            create_profile,
            batch_create_profiles,
            update_profile,
            set_profile_interactive_extract,
            set_profile_agent_panorama,
            request_profile_interactive_extract,
            delete_profile,
            batch_delete_profiles,
            purge_automation_cache,
            test_proxy_connection,
            add_dynamic_api_proxy,
            start_profile,
            stop_profile,
            stop_all_profiles,
            get_running_profile_ids,
            focus_profile_browser,
            preview_ai_fill,
            run_direct_fill,
            run_smart_fill,
            run_rpa_fill,
            resume_rpa_fill,
            rescan_rpa_page,
            pause_rpa_fill,
            get_profile_page_url,
            start_autonomous_agent,
            confirm_agent_action,
            cancel_agent_action,
            reply_agent_ask,
            continue_agent_handover,
            abort_autonomous_agent,
            pause_autonomous_agent,
            bring_profile_to_front,
            replay_agent_trajectory,
            build_replay_run_plan,
            plan_batch_replay_data,
            mock_sandbox_fields,
            save_template,
            get_templates_by_domain,
            delete_template,
            toggle_template_auto_apply,
            list_agent_trajectories,
            delete_agent_trajectory,
            list_agent_runs,
            summarize_agent_run_board,
            get_agent_run,
            delete_agent_run,
            batch_delete_agent_runs,
            list_agent_control_memory,
            clear_agent_control_memory,
            ai_chat,
            test_ai_connection,
            test_otp_channel,
            test_cloak_path,
            get_cloak_binary_status,
            download_cloak_binary,
            update_cloak_binary,
            cleanup_cloak_binary,
            diagnose_cloak_binary,
            list_local_kernels,
            export_profile_cookies,
            import_profile_cookies,
            put_secret_ref,
            delete_secret_ref,
            secret_ref_exists,
            set_profile_otp_channel,
            get_otp_channel_binding,
            pick_key_file,
            import_key_file,
            test_key_file,
            set_cloak_license_key,
            clear_cloak_license_key,
            check_license_entitlement,
            pick_directory,
            open_path_in_os,
            open_external_url,
            export_text_to_download_dir,
            prepare_console_exit
        ])
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            app.run(|app_handle, event| match event {
                // 最终兜底：进程真正退出前同步清进程树（不可取消）。
                // 注意：CloseRequested 由前端 useAppCloseGuard 弹「退出确认框」处理，
                // Rust 侧不得在此抢跑 exit，否则确认弹窗会被吞掉。
                RunEvent::ExitRequested { .. } => {
                    shutdown_all_runtimes(app_handle);
                }
                RunEvent::Exit => {
                    shutdown_all_runtimes(app_handle);
                }
                _ => {}
            });
        }
        Err(error) => {
            log_error!("TianshuTai failed to start: {error}");
        }
    }
}
