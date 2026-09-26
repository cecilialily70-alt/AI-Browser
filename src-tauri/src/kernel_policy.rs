//! Dual-kernel policy + local runtime kernel discovery.
//!
//! 内核约定（与 CloakBrowser 一致）：free=146 系列，pro=151 系列（目录名 `chromium-…-pro`）。
//! 本地运行目录（便携版 exe 旁 `Browse\`，开发目录 `Kernel\`）优先于 `~/.cloakbrowser` 缓存。

use std::path::PathBuf;

use serde::Serialize;

use crate::error::AppError;

pub const FREE_CHROMIUM_VERSION: &str = "146.0.7680.177.5";
/// 打包离线 Pro 内核系列（151）；具体小版本以本地 `chromium-151.*-pro` 目录为准，不再硬编码。
pub const BUNDLED_PRO_CHROMIUM_SERIES: &str = "151";

/// 解析 pin 的主版本号（如 "151.0.7922.108.6" → 151）。
fn major_version(pin: &str) -> Option<u32> {
    pin.trim()
        .split('.')
        .next()
        .and_then(|segment| segment.parse::<u32>().ok())
}

/// Pro 内核 = 151+ 系列（free 为 146 系列）。比精确版本更抗小版本升级。
pub fn is_pro_kernel_pin(browser_version: &str) -> bool {
    major_version(browser_version).map(|major| major >= 151).unwrap_or(false)
}

pub fn is_fingerprint_only_kernel_pin(browser_version: &str) -> bool {
    let v = browser_version.trim();
    !v.is_empty() && is_pro_kernel_pin(v)
}

pub fn ai_blocked_kernel_message(browser_version: &str) -> String {
    let pin = if browser_version.trim().is_empty() {
        BUNDLED_PRO_CHROMIUM_SERIES
    } else {
        browser_version.trim()
    };
    format!(
        "免费 License 下内核 {pin} 仅允许指纹浏览，不可进行 AI / Agent / 智能填表。请改为免费核（{FREE_CHROMIUM_VERSION}）或升级 Pro。打开浏览器数量不受限制。"
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalKernel {
    pub version: String,
    pub dir_name: String,
    pub chrome_path: String,
    /// "pro" | "free"
    pub tier: String,
    /// "bundled"（本地运行目录：exe 旁 Browse/ 或 开发目录 Kernel/）| "cache"（~/.cloakbrowser）
    pub source: String,
}

fn cloakbrowser_cache_root() -> Option<PathBuf> {
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(home) = std::env::var(key) {
            return Some(PathBuf::from(home).join(".cloakbrowser"));
        }
    }
    None
}

/// 收集本地内核扫描根目录：先「本地运行目录」（Browse/ Kernel/），后 `~/.cloakbrowser` 缓存。
fn collect_scan_roots() -> Vec<(PathBuf, &'static str)> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut push = |dir: PathBuf, source: &'static str| {
        let key = dir.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            roots.push((dir, source));
        }
    };

    // 本地运行目录：exe 旁 + cwd + cwd/..，分别尝试 Browse 与 Kernel
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bases.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd.clone());
        bases.push(cwd.join(".."));
    }
    for base in bases {
        push(base.join("Browse"), "bundled");
        push(base.join("Kernel"), "bundled");
    }

    if let Some(cache) = cloakbrowser_cache_root() {
        push(cache, "cache");
    }

    roots
}

/// 从目录名解析内核版本与档位；非 `chromium-*` 目录返回 None。
fn parse_kernel_dir_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("chromium-")?;
    let (version, tier) = match rest.strip_suffix("-pro") {
        Some(v) => (v, "pro"),
        None => (rest, "free"),
    };
    if version.is_empty() {
        return None;
    }
    Some((version.to_string(), tier.to_string()))
}

/// 扫描本地运行目录与缓存中的所有可用内核（bundled 优先，去重）。
pub fn scan_local_kernels() -> Vec<LocalKernel> {
    let mut out: Vec<LocalKernel> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (root, source) in collect_scan_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some((version, tier)) = parse_kernel_dir_name(&name) else {
                continue;
            };
            let chrome = entry.path().join("chrome.exe");
            if !chrome.is_file() {
                continue;
            }
            let key = format!("{version}\u{0}{tier}");
            if !seen.insert(key) {
                continue;
            }
            out.push(LocalKernel {
                version,
                dir_name: name,
                chrome_path: chrome.to_string_lossy().into_owned(),
                tier,
                source: source.to_string(),
            });
        }
    }

    // 本地运行目录（bundled）排前，其次缓存；同源按版本降序。
    out.sort_by(|a, b| {
        let a_bundled = a.source == "bundled";
        let b_bundled = b.source == "bundled";
        b_bundled
            .cmp(&a_bundled)
            .then_with(|| b.version.cmp(&a.version))
    });
    out
}

/// Resolve Browse/ 或 Kernel/ next to exe (portable) or cwd (dev)，且含任意内核目录（free 或 pro）。
pub fn resolve_bundled_browse_root() -> Option<PathBuf> {
    for (root, source) in collect_scan_roots() {
        if source != "bundled" {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if parse_kernel_dir_name(&name).is_some() && entry.path().join("chrome.exe").is_file() {
                return Some(root);
            }
        }
    }
    None
}

pub fn assert_ai_allowed_for_browser_version(
    is_pro_license: bool,
    browser_version: &str,
) -> Result<(), AppError> {
    if is_pro_license {
        return Ok(());
    }
    if is_fingerprint_only_kernel_pin(browser_version) {
        return Err(AppError::Validation(ai_blocked_kernel_message(
            browser_version,
        )));
    }
    Ok(())
}

/// 前端调用：列出本地运行目录与缓存中已检测到的全部内核（本地运行目录优先）。
#[tauri::command]
pub fn list_local_kernels() -> Vec<LocalKernel> {
    scan_local_kernels()
}
