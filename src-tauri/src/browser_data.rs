//! 环境浏览器数据清理：Cookie / 站点存储 / 缓存的选择性清理。
//!
//! 与 `cache_cleanup` 的分工 ——
//! `cache_cleanup` 清的是**自动化产物**（下载的图片、验证码帧、已删环境残留的目录）；
//! 本模块清的是**仍在环境列表里的某个环境自己的浏览器身份数据**：站点登录态坏了
//! （典型症状：网页版反复自我登出、二维码一直出不来）、环境被站点风控记住、
//! 想给某个环境一份干净的 profile 时用它，**不必删掉整个环境、也不丢环境配置与代理绑定**。
//!
//! 纪律（与 §0.5.3 / §6 一致）：
//! - **运行中一律拒绝**（fail-closed）：浏览器正持有 IndexedDB / Cookies 的锁，
//!   在它活着时把目录从底下抽掉只会留下半截存储。单个环境由命令层拒绝；
//!   批量清理按 `running_ids` **逐个跳过并写明原因**，禁止静默丢弃。
//! - 只碰 [`TARGETS`] 里列出的固定相对路径，**绝不接受调用方传路径**（无路径注入面）。
//! - 删不掉就如实写进 `details`，不静默当成功。

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use tauri::AppHandle;

use crate::cache_cleanup::dir_size_approx;
use crate::db;
use crate::error::AppError;
use crate::fill_sidecar::resolve_profile_user_data_dir;

/// 清理范围：只清 Cookie（站点登录票据）。
pub const SCOPE_COOKIES: &str = "cookies";
/// 清理范围：站点存储（IndexedDB / WebStorage / Service Worker / blob 等）。
pub const SCOPE_STORAGE: &str = "storage";
/// 清理范围：磁盘与代码缓存（不影响登录态）。
pub const SCOPE_CACHE: &str = "cache";
/// 清理范围：以上全部。
pub const SCOPE_ALL: &str = "all";

/// 对外接受的 scope 取值；`all` 由前三者合成。
const SUPPORTED_SCOPES: [&str; 4] = [SCOPE_COOKIES, SCOPE_STORAGE, SCOPE_CACHE, SCOPE_ALL];

/// 清理目标表：`(相对 user-data-dir 的路径, 命中哪些 scope)`。
///
/// 全部是固定常量 —— 这样「清理」永远只可能删到本环境目录下这几处，
/// 不会因为上游传参而删到别处。
const TARGETS: &[(&str, &[&str])] = &[
    // —— Cookie：站点的登录票据（最容易把环境「毒」住的一处）——
    ("Default/Network/Cookies", &[SCOPE_COOKIES]),
    ("Default/Network/Cookies-journal", &[SCOPE_COOKIES]),
    // —— 站点存储：IndexedDB / WebStorage / Service Worker / blob ——
    ("Default/IndexedDB", &[SCOPE_STORAGE]),
    ("Default/Local Storage", &[SCOPE_STORAGE]),
    ("Default/Session Storage", &[SCOPE_STORAGE]),
    ("Default/WebStorage", &[SCOPE_STORAGE]),
    ("Default/Service Worker", &[SCOPE_STORAGE]),
    ("Default/Shared Dictionary", &[SCOPE_STORAGE]),
    ("Default/blob_storage", &[SCOPE_STORAGE]),
    ("Default/File System", &[SCOPE_STORAGE]),
    ("Default/databases", &[SCOPE_STORAGE]),
    // —— 缓存：删了只是重新下载，不影响登录态与站点数据 ——
    ("Default/Cache", &[SCOPE_CACHE]),
    ("Default/Code Cache", &[SCOPE_CACHE]),
    ("Default/GPUCache", &[SCOPE_CACHE]),
    ("Default/DawnGraphiteCache", &[SCOPE_CACHE]),
    ("Default/DawnWebGPUCache", &[SCOPE_CACHE]),
    ("Default/ShaderCache", &[SCOPE_CACHE]),
    ("Default/Media Cache", &[SCOPE_CACHE]),
    ("GrShaderCache", &[SCOPE_CACHE]),
    ("GPUPersistentCache", &[SCOPE_CACHE]),
];

/// 单条明细上限：与 `cache_cleanup` 一致，避免报告把界面撑爆。
const MAX_DETAILS: usize = 80;

/// LevelDB 目录里「不算有效数据」的文件名（有它们但没有 CURRENT/MANIFEST/LOG 仍是空壳）。
const LEVELDB_NOISE_FILES: &[&str] = &["LOCK", "LOG", "LOG.old"];

/// 损坏站点存储的清扫报告（启动自愈用，不是用户主动清理）。
#[derive(Debug, Clone, Default)]
pub struct ScrubCorruptStorageReport {
    pub removed_dirs: usize,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDataEnvSummary {
    pub profile_id: String,
    pub profile_name: String,
    pub running: bool,
    pub cookies_bytes: u64,
    pub storage_bytes: u64,
    pub cache_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeBrowserDataReport {
    pub profile_id: String,
    /// 归一化后的实际生效范围（profile | site | contact 之外的新口径：cookies/storage/cache/all）
    pub scope: String,
    pub removed_dirs: usize,
    pub removed_files: usize,
    pub freed_bytes: u64,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeAllBrowserDataReport {
    pub scope: String,
    pub purged_profiles: usize,
    pub skipped_running: usize,
    pub removed_dirs: usize,
    pub removed_files: usize,
    pub freed_bytes: u64,
    pub details: Vec<String>,
}

/// 归一化 scope。未知取值**报错**而不是悄悄当成 `all`：
/// 「用户以为只清了缓存，实际把登录态也清了」是不可接受的静默降级。
pub fn normalize_scope(raw: &str) -> Result<&'static str, AppError> {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Ok(SCOPE_ALL);
    }
    SUPPORTED_SCOPES
        .into_iter()
        .find(|candidate| *candidate == normalized)
        .ok_or_else(|| {
            AppError::Validation(format!(
                "未知的清理范围「{raw}」，可用值：{}",
                SUPPORTED_SCOPES.join(" / ")
            ))
        })
}

fn scope_matches(target_scopes: &[&str], scope: &str) -> bool {
    scope == SCOPE_ALL || target_scopes.iter().any(|candidate| *candidate == scope)
}

fn profile_dir(app: &AppHandle, profile_id: &str) -> Result<PathBuf, AppError> {
    resolve_profile_user_data_dir(app, profile_id)
}

/// 某个 scope 在某个环境目录下的实际清理目标（过滤掉不存在的）。
fn targets_for(dir: &Path, scope: &str) -> Vec<PathBuf> {
    TARGETS
        .iter()
        .filter(|(_, scopes)| scope_matches(scopes, scope))
        .map(|(relative, _)| dir.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)))
        .filter(|path| path.exists())
        .collect()
}

fn path_size(path: &Path) -> u64 {
    if path.is_dir() {
        dir_size_approx(path)
    } else {
        fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
    }
}

fn measure(dir: &Path, scope: &str) -> u64 {
    targets_for(dir, scope).iter().map(|path| path_size(path)).sum()
}

/// 某个目录里是不是「几乎没有真实数据」——只有空目录，或只有 LevelDB 的 LOCK/LOG 噪声文件。
///
/// Chromium 被强杀时常见症状：`IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb`
/// 目录在，但里面 0 个有效文件（或只剩 LOCK）。下次启动站点读到这份空壳，
/// 会判定存储损坏 → 自我登出 / 二维码区一直转圈。
fn is_hollow_storage_dir(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(meta) = entry.metadata() else {
            return false;
        };
        if meta.is_dir() {
            // 子目录还在 → 不是空壳（例如 IndexedDB 根下有多个 origin）
            return false;
        }
        if !LEVELDB_NOISE_FILES
            .iter()
            .any(|noise| name.eq_ignore_ascii_case(noise))
        {
            // 看到 CURRENT / MANIFEST / *.ldb / *.log 等真实数据 → 不是空壳
            return false;
        }
    }
    // 完全空，或只剩 LOCK/LOG 噪声
    true
}

fn remove_dir_best_effort(path: &Path, report: &mut ScrubCorruptStorageReport, label: &str) {
    if !path.exists() {
        return;
    }
    match fs::remove_dir_all(path) {
        Ok(()) => {
            report.removed_dirs += 1;
            report.details.push(format!("已清除损坏空壳：{label}"));
        }
        Err(error) => report
            .details
            .push(format!("清除空壳失败 {label}（{error}）")),
    }
}

/// 启动前自愈：清掉**空壳**站点存储，不动有真实数据的目录。
///
/// 这不是「清理用户数据」——有 CURRENT/MANIFEST/*.ldb 的 IndexedDB 一律保留；
/// 只拆掉强杀留下的空目录，让 WhatsApp / Telegram 等站点能重新建库、画出二维码。
pub fn scrub_corrupt_site_storage(user_data_dir: &Path) -> ScrubCorruptStorageReport {
    let mut report = ScrubCorruptStorageReport::default();
    let indexed_db = user_data_dir.join("Default").join("IndexedDB");
    if indexed_db.is_dir() {
        // 先扫每个 origin 子目录；全空再决定要不要拆根
        let mut origin_left = 0usize;
        if let Ok(entries) = fs::read_dir(&indexed_db) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    origin_left += 1;
                    continue;
                }
                if is_hollow_storage_dir(&path) {
                    let label = path
                        .strip_prefix(user_data_dir)
                        .map(|rest| rest.display().to_string())
                        .unwrap_or_else(|_| path.display().to_string());
                    remove_dir_best_effort(&path, &mut report, &label);
                } else {
                    origin_left += 1;
                }
            }
        }
        if origin_left == 0 && is_hollow_storage_dir(&indexed_db) {
            remove_dir_best_effort(&indexed_db, &mut report, "Default/IndexedDB");
        }
    }

    // Service Worker：Database 空 + ScriptCache 几乎空 = 半截 SW，站点会卡在「加载中」
    let sw_root = user_data_dir.join("Default").join("Service Worker");
    if sw_root.is_dir() {
        let db = sw_root.join("Database");
        let scripts = sw_root.join("ScriptCache");
        let db_hollow = !db.exists() || is_hollow_storage_dir(&db);
        let scripts_hollow = !scripts.exists() || is_hollow_storage_dir(&scripts);
        if db_hollow && scripts_hollow {
            remove_dir_best_effort(&sw_root, &mut report, "Default/Service Worker");
        }
    }

    report
}

/// 各范围当前占用（供设置页展示，不产生副作用）。
pub fn env_summary(
    app: &AppHandle,
    profile_id: &str,
    profile_name: &str,
    running: bool,
) -> Result<BrowserDataEnvSummary, AppError> {
    let dir = profile_dir(app, profile_id)?;
    let cookies_bytes = measure(&dir, SCOPE_COOKIES);
    let storage_bytes = measure(&dir, SCOPE_STORAGE);
    let cache_bytes = measure(&dir, SCOPE_CACHE);
    Ok(BrowserDataEnvSummary {
        profile_id: profile_id.to_owned(),
        profile_name: profile_name.to_owned(),
        running,
        cookies_bytes,
        storage_bytes,
        cache_bytes,
        total_bytes: cookies_bytes
            .saturating_add(storage_bytes)
            .saturating_add(cache_bytes),
    })
}

/// 全部环境的数据占用总览（按总量降序，便于先清最占地方的）。
pub fn list_overview(
    app: &AppHandle,
    connection: &Connection,
    running_ids: &std::collections::HashSet<String>,
) -> Result<Vec<BrowserDataEnvSummary>, AppError> {
    let mut out = Vec::new();
    for profile in db::list_profiles(connection)? {
        let profile_id = profile.id.to_string();
        // 目录都还没建过的环境不必展示（省一次全量遍历）
        if !profile_dir(app, &profile_id)?.exists() {
            continue;
        }
        out.push(env_summary(
            app,
            &profile_id,
            &profile.name,
            running_ids.contains(&profile_id),
        )?);
    }
    out.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));
    Ok(out)
}

/// 纯文件系统实现：只在 `dir` 之下按 [`TARGETS`] 清理。
///
/// 抽出来是为了能被单元测试锁住「**只删固定目标、绝不误伤其它文件**」
/// 这一条安全属性 —— 清理功能一旦越界就是不可逆的用户数据事故。
fn purge_targets(dir: &Path, scope: &str) -> (usize, usize, u64, Vec<String>) {
    let mut removed_dirs = 0usize;
    let mut removed_files = 0usize;
    let mut freed_bytes = 0u64;
    let mut details = Vec::new();

    for path in targets_for(dir, scope) {
        let is_dir = path.is_dir();
        let bytes = path_size(&path);
        let outcome = if is_dir {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        // 相对路径写进明细：绝对路径太长，对用户没有额外信息量
        let label = path
            .strip_prefix(dir)
            .map(|rest| rest.display().to_string())
            .unwrap_or_else(|_| path.display().to_string());
        match outcome {
            Ok(()) => {
                freed_bytes = freed_bytes.saturating_add(bytes);
                if is_dir {
                    removed_dirs += 1;
                } else {
                    removed_files += 1;
                }
                details.push(format!("已删除 {label}"));
            }
            Err(error) => details.push(format!("删除失败 {label}（{error}）")),
        }
    }

    (removed_dirs, removed_files, freed_bytes, details)
}

/// 清理单个环境的数据。调用方（命令层）必须已确认该环境**没有在运行**。
pub fn purge_browser_data(
    app: &AppHandle,
    profile_id: &str,
    scope_raw: &str,
) -> Result<PurgeBrowserDataReport, AppError> {
    let scope = normalize_scope(scope_raw)?;
    let dir = profile_dir(app, profile_id)?;
    let mut report = PurgeBrowserDataReport {
        profile_id: profile_id.to_owned(),
        scope: scope.to_owned(),
        removed_dirs: 0,
        removed_files: 0,
        freed_bytes: 0,
        details: Vec::new(),
    };

    if !dir.exists() {
        report.details.push("该环境尚无浏览器数据目录".to_owned());
        return Ok(report);
    }
    if targets_for(&dir, scope).is_empty() {
        report.details.push("没有需要清理的数据".to_owned());
        return Ok(report);
    }

    let (dirs, files, bytes, mut details) = purge_targets(&dir, scope);
    report.removed_dirs = dirs;
    report.removed_files = files;
    report.freed_bytes = bytes;
    // 主动清理之后再扫一遍空壳，避免「IndexedDB 根还在但里面没文件」这种半残状态
    let scrub = scrub_corrupt_site_storage(&dir);
    report.removed_dirs += scrub.removed_dirs;
    details.extend(scrub.details);
    report.details = details;

    Ok(report)
}

/// 批量清理：逐环境清，**运行中的逐个写明原因跳过**（禁止静默丢弃）。
pub fn purge_all_browser_data(
    app: &AppHandle,
    connection: &Connection,
    running_ids: &std::collections::HashSet<String>,
    scope_raw: &str,
) -> Result<PurgeAllBrowserDataReport, AppError> {
    let scope = normalize_scope(scope_raw)?;
    let mut report = PurgeAllBrowserDataReport {
        scope: scope.to_owned(),
        purged_profiles: 0,
        skipped_running: 0,
        removed_dirs: 0,
        removed_files: 0,
        freed_bytes: 0,
        details: Vec::new(),
    };

    for profile in db::list_profiles(connection)? {
        let profile_id = profile.id.to_string();
        if running_ids.contains(&profile_id) {
            report.skipped_running += 1;
            report
                .details
                .push(format!("跳过（运行中，请先停止）：{}", profile.name));
            continue;
        }
        let result = purge_browser_data(app, &profile_id, scope)?;
        if result.removed_dirs > 0 || result.removed_files > 0 {
            report.purged_profiles += 1;
            report.removed_dirs += result.removed_dirs;
            report.removed_files += result.removed_files;
            report.freed_bytes = report.freed_bytes.saturating_add(result.freed_bytes);
            report.details.push(format!(
                "已清理：{}（{} 个目录 / {} 个文件）",
                profile.name, result.removed_dirs, result.removed_files
            ));
        }
    }

    if report.details.len() > MAX_DETAILS {
        let omitted = report.details.len() - MAX_DETAILS;
        report.details.truncate(MAX_DETAILS);
        report
            .details
            .push(format!("…另有 {omitted} 条明细已省略"));
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::{
        is_hollow_storage_dir, normalize_scope, purge_targets, scope_matches,
        scrub_corrupt_site_storage, SCOPE_ALL, SCOPE_CACHE, SCOPE_COOKIES, SCOPE_STORAGE,
    };
    use std::fs;
    use std::path::PathBuf;

    /// 未知 scope 必须报错：悄悄当成 all 会让「我只清缓存」变成「清掉登录态」。
    #[test]
    fn normalize_scope_rejects_unknown_values() {
        assert!(normalize_scope("everything").is_err());
        assert!(normalize_scope("Cookies ").is_ok());
    }

    /// 空串按「全部」处理（前端初次渲染不会传空串，但接口要稳）。
    #[test]
    fn normalize_scope_defaults_to_all_on_empty() {
        assert_eq!(normalize_scope("").unwrap(), SCOPE_ALL);
        assert_eq!(normalize_scope("  ").unwrap(), SCOPE_ALL);
    }

    #[test]
    fn normalize_scope_is_case_insensitive_and_trimmed() {
        assert_eq!(normalize_scope(" COOKIES ").unwrap(), SCOPE_COOKIES);
        assert_eq!(normalize_scope("Storage").unwrap(), SCOPE_STORAGE);
        assert_eq!(normalize_scope("CACHE").unwrap(), SCOPE_CACHE);
    }

    /// `all` 必须命中每一类；单类 scope 之间不得互相命中（否则「只清缓存」会误伤登录态）。
    #[test]
    fn scope_matching_partitions_targets_correctly() {
        assert!(scope_matches(&[SCOPE_COOKIES], SCOPE_ALL));
        assert!(scope_matches(&[SCOPE_CACHE], SCOPE_ALL));
        assert!(scope_matches(&[SCOPE_COOKIES], SCOPE_COOKIES));
        assert!(!scope_matches(&[SCOPE_COOKIES], SCOPE_CACHE));
        assert!(!scope_matches(&[SCOPE_STORAGE], SCOPE_COOKIES));
        assert!(!scope_matches(&[SCOPE_CACHE], SCOPE_STORAGE));
    }

    /// 造一份「麻雀虽小五脏俱全」的假 profile 目录。
    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ai-browser-data-cleanup-{}-{tag}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Default/Cache/Sub")).unwrap();
        fs::write(root.join("Default/Cache/data"), b"cache-bytes").unwrap();
        fs::create_dir_all(root.join("Default/Code Cache")).unwrap();
        fs::write(root.join("Default/Code Cache/c"), b"code").unwrap();
        fs::create_dir_all(root.join("Default/IndexedDB/https_example_0.indexeddb.leveldb")).unwrap();
        fs::write(
            root.join("Default/IndexedDB/https_example_0.indexeddb.leveldb/000003.log"),
            b"idb",
        )
        .unwrap();
        fs::create_dir_all(root.join("Default/Network")).unwrap();
        fs::write(root.join("Default/Network/Cookies"), b"cookie-db").unwrap();
        fs::write(root.join("Default/Network/Cookies-journal"), b"journal").unwrap();
        // 以下都**不在**清理目标里：任何 scope 都不得碰它们
        fs::write(root.join("Local State"), b"state").unwrap();
        fs::write(root.join("Default/Preferences"), b"prefs").unwrap();
        fs::write(root.join("Default/History"), b"history").unwrap();
        fs::write(root.join("Default/Bookmarks"), b"bookmarks").unwrap();
        root
    }

    /// 只清缓存：登录态与站点数据必须原封不动，用户数据（历史/书签/Local State）同样不许碰。
    #[test]
    fn cache_scope_keeps_cookies_storage_and_user_data() {
        let root = fixture("cache");
        let (dirs, _files, bytes, _details) = purge_targets(&root, SCOPE_CACHE);
        assert!(dirs >= 2, "Cache 与 Code Cache 都该被删掉，实际 dirs={dirs}");
        assert!(bytes > 0, "应统计到释放字节数");

        assert!(!root.join("Default/Cache").exists());
        assert!(!root.join("Default/Code Cache").exists());
        assert!(root.join("Default/Network/Cookies").exists());
        assert!(root.join("Default/IndexedDB").exists());
        assert!(root.join("Local State").exists());
        assert!(root.join("Default/History").exists());
        assert!(root.join("Default/Bookmarks").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// `all` 清掉 Cookie 与站点存储，但**仍然**不碰用户数据与环境配置。
    #[test]
    fn all_scope_clears_browser_data_but_never_user_data() {
        let root = fixture("all");
        purge_targets(&root, SCOPE_ALL);
        assert!(!root.join("Default/Network/Cookies").exists());
        assert!(!root.join("Default/Network/Cookies-journal").exists());
        assert!(!root.join("Default/IndexedDB").exists());
        assert!(!root.join("Default/Cache").exists());
        // 用户数据与环境配置必须留着 —— 清理不是「删环境」
        assert!(root.join("Local State").exists());
        assert!(root.join("Default/Preferences").exists());
        assert!(root.join("Default/History").exists());
        assert!(root.join("Default/Bookmarks").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// 只清 Cookie：站点存储与缓存都不动（登录票据坏了，但别把 IndexedDB 一起清掉）。
    #[test]
    fn cookies_scope_touches_nothing_else() {
        let root = fixture("cookies");
        purge_targets(&root, SCOPE_COOKIES);
        assert!(!root.join("Default/Network/Cookies").exists());
        assert!(root.join("Default/IndexedDB").exists());
        assert!(root.join("Default/Cache").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// 目标不存在时不得报错、也不得产生明细（重复清理是幂等的）。
    #[test]
    fn purge_is_idempotent_on_missing_targets() {
        let root = fixture("idem");
        let (dirs, files, bytes, details) = purge_targets(&root, SCOPE_CACHE);
        assert!(dirs + files > 0);
        assert!(bytes > 0);
        assert!(details.iter().all(|line| line.starts_with("已删除")));

        let (dirs2, files2, bytes2, details2) = purge_targets(&root, SCOPE_CACHE);
        assert_eq!((dirs2, files2, bytes2), (0, 0, 0));
        assert!(details2.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    /// 空壳判定：完全空、或只有 LOCK/LOG → 空壳；有 CURRENT/MANIFEST → 不是。
    #[test]
    fn hollow_storage_detects_empty_leveldb_shells() {
        let root = fixture("hollow");
        let empty = root.join("empty-idb");
        fs::create_dir_all(&empty).unwrap();
        assert!(is_hollow_storage_dir(&empty));

        let lock_only = root.join("lock-only");
        fs::create_dir_all(&lock_only).unwrap();
        fs::write(lock_only.join("LOCK"), b"").unwrap();
        fs::write(lock_only.join("LOG"), b"noise").unwrap();
        assert!(is_hollow_storage_dir(&lock_only));

        let real = root.join("real-idb");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
        fs::write(real.join("MANIFEST-000001"), b"x").unwrap();
        assert!(!is_hollow_storage_dir(&real));
        let _ = fs::remove_dir_all(&root);
    }

    /// 启动自愈：拆掉 WhatsApp 空壳 IndexedDB，但保留有数据的 origin。
    #[test]
    fn scrub_removes_hollow_whatsapp_idb_keeps_healthy() {
        let root = fixture("scrub");
        let idb = root.join("Default/IndexedDB");
        let hollow = idb.join("https_web.whatsapp.com_0.indexeddb.leveldb");
        let healthy = idb.join("https_web.telegram.org_0.indexeddb.leveldb");
        fs::create_dir_all(&hollow).unwrap();
        fs::write(hollow.join("LOCK"), b"").unwrap();
        fs::create_dir_all(&healthy).unwrap();
        fs::write(healthy.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
        fs::write(healthy.join("000003.log"), b"data").unwrap();

        let report = scrub_corrupt_site_storage(&root);
        assert!(report.removed_dirs >= 1);
        assert!(!hollow.exists(), "WhatsApp 空壳必须被拆掉");
        assert!(healthy.exists(), "有数据的 Telegram IDB 必须留下");
        let _ = fs::remove_dir_all(&root);
    }
}
