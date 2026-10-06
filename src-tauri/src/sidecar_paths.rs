use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 在开发目录与打包后的 exe 相对路径中定位 `sidecar/dist/<relative>` 脚本。
/// 优先按「正在运行的 exe 目录」查找（GUI/快捷方式常把 cwd 指到别处）。
pub fn resolve_sidecar_dist(relative: &str) -> Result<PathBuf, AppError> {
    let relative = relative
        .trim()
        .trim_start_matches(['/', '\\'])
        .replace('\\', "/");
    let file_name = relative
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(relative.as_str());

    let mut roots: Vec<PathBuf> = Vec::new();
    let mut seen = HashSet::<String>::new();

    let mut push_root = |path: PathBuf| {
        let key = path.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            roots.push(path);
        }
    };

    // 1) exe 所在目录及其祖先（最多 5 层），兼容 release-dist/TianshuTai 嵌套
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent().map(Path::to_path_buf);
        for _ in 0..5 {
            let Some(dir) = cursor else {
                break;
            };
            push_root(dir.clone());
            push_root(dir.join("TianshuTai"));
            push_root(dir.join("release-dist"));
            push_root(dir.join("release-dist").join("TianshuTai"));
            cursor = dir.parent().map(Path::to_path_buf);
        }
    }

    // 2) 当前工作目录（开发模式 / bat 启动）
    if let Ok(cwd) = std::env::current_dir() {
        push_root(cwd.clone());
        push_root(cwd.join("TianshuTai"));
        push_root(cwd.join("release-dist"));
        push_root(cwd.join("release-dist").join("TianshuTai"));
        if let Some(parent) = cwd.parent() {
            push_root(parent.to_path_buf());
            push_root(parent.join("TianshuTai"));
        }
    }

    let mut tried: Vec<String> = Vec::new();
    for root in &roots {
        let candidate = root.join("sidecar").join("dist").join(&relative);
        tried.push(candidate.display().to_string());
        if candidate.is_file() {
            return Ok(candidate);
        }

        // 兼容仅按文件名查找（防止路径分隔符差异）
        let by_name = root.join("sidecar").join("dist").join(file_name);
        if by_name != candidate {
            tried.push(by_name.display().to_string());
            if by_name.is_file() {
                return Ok(by_name);
            }
        }
    }

    let exe_hint = std::env::current_exe()
        .ok()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "(unknown)".to_owned());
    let cwd_hint = std::env::current_dir()
        .ok()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "(unknown)".to_owned());
    let preview = tried.into_iter().take(8).collect::<Vec<_>>().join(" | ");

    Err(AppError::Sidecar(format!(
        "未找到 sidecar/dist/{relative}。请从解压后的 TianshuTai 目录启动（exe 与 sidecar 必须同级），不要只运行安装包或单独拷贝 exe。当前 exe={exe_hint}；cwd={cwd_hint}；已尝试: {preview}"
    )))
}

pub fn sidecar_working_dir(script_path: &Path) -> Option<PathBuf> {
    script_path.parent()?.parent().map(PathBuf::from)
}
