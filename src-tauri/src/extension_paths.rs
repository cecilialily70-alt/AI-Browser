use std::fs;
use std::path::{Path, PathBuf};

/// 收集可加载的解压扩展目录（目录内必须含 manifest.json）。
/// 扫描顺序：应用旁 `extensions/` → 用户数据 `extensions/`（可放置 TWP）。
pub fn collect_extension_paths(app_data_dir: &Path) -> Vec<String> {
    let mut roots = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("extensions"));
        roots.push(cwd.join("../extensions"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("extensions"));
            roots.push(parent.join("../extensions"));
            if let Some(grand) = parent.parent() {
                roots.push(grand.join("extensions"));
            }
        }
    }
    roots.push(app_data_dir.join("extensions"));

    let mut found: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if !path.join("manifest.json").is_file() {
                // 兼容 zip 解压多层：extensions/twp/xxx/manifest.json
                if let Ok(nested) = fs::read_dir(&path) {
                    for nested_entry in nested.flatten() {
                        let nested_path = nested_entry.path();
                        if nested_path.is_dir() && nested_path.join("manifest.json").is_file() {
                            push_unique_extension(&mut found, &mut seen, &nested_path);
                        }
                    }
                }
                continue;
            }
            push_unique_extension(&mut found, &mut seen, &path);
        }
    }

    found
        .into_iter()
        .filter_map(|path| {
            path.canonicalize()
                .ok()
                .map(|canonical| canonical.to_string_lossy().into_owned())
        })
        .collect()
}

fn push_unique_extension(
    found: &mut Vec<PathBuf>,
    seen: &mut std::collections::HashSet<String>,
    path: &Path,
) {
    let key = path.to_string_lossy().to_ascii_lowercase();
    if seen.insert(key) {
        found.push(path.to_path_buf());
    }
}

/// 合并代理鉴权扩展与翻译等业务扩展，代理扩展始终排在最前。
pub fn merge_extension_paths(
    auth_extension_dir: Option<&str>,
    bundled_or_user: Vec<String>,
) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    if let Some(auth) = auth_extension_dir.map(str::trim).filter(|value| !value.is_empty()) {
        let key = auth.to_ascii_lowercase();
        if seen.insert(key) {
            paths.push(auth.to_owned());
        }
    }

    for path in bundled_or_user {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            paths.push(trimmed.to_owned());
        }
    }

    paths
}
