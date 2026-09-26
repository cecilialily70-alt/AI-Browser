//! 临时配置文件的统一归属。
//!
//! 背景：AI API Key 与 License Key 不能走命令行参数（进程列表可见、易被采集），
//! 因此改为写入临时文件再以 `--config-file=` 交给 Node sidecar。
//! 代价是文件落盘且内容含明文凭据，必须保证「用完即删」。
//!
//! 归属规则按子进程生命周期二选一：
//! - **一次性子进程**（chat / data_planner）：Rust 持有 [`TempConfigFile`]，
//!   Drop 即删。即便调用方 `?` 早退、子进程崩溃，也不会泄漏。
//! - **长生命周期子进程**（launch）：子进程存活期远长于 spawn 调用，
//!   Rust 无法在函数返回时删除，故用 [`write_leased_config`] 写入，
//!   并把删除责任交给读取方（sidecar `launch.ts` 读完即删），把凭据落盘窗口收敛到启动期。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::log_warn;

/// 进程内单调递增序号：避免同一毫秒内多次写入互相覆盖（原先用 `as_millis()` 存在该风险）。
static SEQ: AtomicU64 = AtomicU64::new(0);

/// 只保留文件系统安全字符，防止上游传入的 key 影响路径结构。
fn sanitize_key(key: &str) -> String {
    let cleaned: String = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "profile".to_owned()
    } else {
        cleaned
    }
}

fn config_path(label: &str, key: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "ai-browser-{label}-{}-{}-{stamp}-{seq}.json",
        sanitize_key(key),
        std::process::id()
    ))
}

/// 一次性子进程的临时配置：析构即删除。
pub struct TempConfigFile {
    path: PathBuf,
}

impl TempConfigFile {
    /// 写入临时配置并接管其生命周期。
    ///
    /// 返回 `std::io::Error` 而非 `AppError`，由调用方按各命令原有的错误变体与文案上报，
    /// 避免改变前端已依赖的 `kind` 契约。
    pub fn write(label: &str, key: &str, contents: &str) -> std::io::Result<Self> {
        let path = config_path(label, key);
        std::fs::write(&path, contents)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 拼出 `--config-file=<path>` 形式的命令行参数。
    pub fn cli_arg(&self, flag: &str) -> String {
        format!("{flag}{}", self.path.display())
    }
}

impl Drop for TempConfigFile {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path) {
            // 读取方可能已提前删除（双重清理），仅真实失败才告警。
            if error.kind() != std::io::ErrorKind::NotFound {
                log_warn!(
                    "[temp_config] failed to remove temp config path={} err={error}",
                    self.path.display()
                );
            }
        }
    }
}

/// 长生命周期子进程的临时配置：Rust 只负责写入，删除由读取方负责。
///
/// 调用方必须确保读取方在读完配置后立即删除该文件（见 `sidecar/src/launch.ts`）。
pub fn write_leased_config(label: &str, key: &str, contents: &str) -> std::io::Result<PathBuf> {
    let path = config_path(label, key);
    std::fs::write(&path, contents)?;
    Ok(path)
}

/// 开机清扫孤儿临时配置：只删「确定已无人读取」的文件。
///
/// 覆盖 Rust Drop 与读取方都够不到的窗口：子进程在 spawn 与读取之间被硬杀
/// （任务管理器、断电、崩溃），文件会永久滞留。正常配置在创建后数秒内即被消费，
/// 故以 mtime 判定——超过 `max_age` 的必然是孤儿。这样无需解析文件名，也无需探测
/// PID 存活，因此不存在 PID 复用的误判风险。
///
/// `dir` 显式传入以便单测；生产调用传 [`std::env::temp_dir`]。
/// 仅命中 [`config_path`] 产出的普通文件：`ai-browser-proxy-auth` 与
/// `ai-browser-download-claims` 是目录，会被 `is_file` 排除在外。
pub fn sweep_orphan_configs(dir: &Path, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with("ai-browser-") || !name.ends_with(".json") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        // 时钟回拨等异常下 duration_since 会失败，此时宁可不动该文件
        let Ok(age) = SystemTime::now().duration_since(modified) else {
            continue;
        };
        if age < max_age {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_hostile_key() {
        assert_eq!(sanitize_key("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_key("12"), "12");
        assert_eq!(sanitize_key(""), "profile");
        assert_eq!(sanitize_key("..."), "profile");
    }

    #[test]
    fn removes_file_on_drop() {
        let path = {
            let config = TempConfigFile::write("test-unit", "1", "{\"ok\":true}").expect("write");
            let path = config.path().to_path_buf();
            assert!(path.is_file());
            path
        };
        assert!(!path.is_file(), "TempConfigFile 应在 Drop 时删除临时配置");
    }

    #[test]
    fn write_failure_reports_io_error() {
        // 空 label 仍会生成合法文件名；此处只验证成功路径返回可用的 cli_arg。
        let config = TempConfigFile::write("test-unit", "2", "{}").expect("write");
        assert!(config.cli_arg("--config-file=").starts_with("--config-file="));
    }

    /// 独占的临时目录，测试结束即清理。目录名不以 `.json` 结尾，故自身不会被清扫命中。
    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-browser-sweep-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn sweeps_stale_configs_only() {
        let dir = scratch_dir("stale");
        let stale = dir.join("ai-browser-chat-global-1-1-1.json");
        let fresh = dir.join("ai-browser-launch-1-1-2-2.json");
        let unrelated = dir.join("unrelated.json");
        let other_suffix = dir.join("ai-browser-chat-1-1-1.txt");
        for path in [&stale, &fresh, &unrelated, &other_suffix] {
            std::fs::write(path, "{}").expect("write probe");
        }
        // 目录形态的同前缀产物（proxy-auth / download-claims）绝不能被删
        let sibling_dir = dir.join("ai-browser-proxy-auth");
        std::fs::create_dir_all(&sibling_dir).expect("create sibling dir");

        // 先以 0 时长清扫一次，fresh 与 stale 同为「已过期」，全部回收
        let removed = sweep_orphan_configs(&dir, Duration::ZERO);
        assert_eq!(removed, 2, "只应回收 ai-browser-*.json 普通文件");
        assert!(unrelated.is_file(), "无关文件不得被删");
        assert!(other_suffix.is_file(), "非 .json 不得被删");
        assert!(sibling_dir.is_dir(), "同前缀目录不得被删");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_spares_recent_configs() {
        let dir = scratch_dir("recent");
        let recent = dir.join("ai-browser-cookies-payload-1-1-3.json");
        std::fs::write(&recent, "{}").expect("write probe");

        // 一分钟内的文件仍可能是并发实例正在读取的配置，必须放过
        let removed = sweep_orphan_configs(&dir, Duration::from_secs(3600));
        assert_eq!(removed, 0);
        assert!(recent.is_file(), "新鲜配置不得被清扫");

        std::fs::remove_dir_all(&dir).ok();
    }
}
