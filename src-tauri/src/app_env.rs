//! 应用自有环境变量的统一命名与读取。
//!
//! 品牌统一为 `TIANSHUTAI_*`；读取时兼容迁移期的旧前缀 `CLOAKFORGE_*`，
//! 避免用户既有脚本 / 快捷方式因改名失效（只保留「读」的兼容，「写」只写新名）。
//!
//! 注意：`CLOAKBROWSER_LICENSE_KEY` 等属于上游内核契约，不在此模块管辖范围。

use std::process::Command;

pub const PREFIX: &str = "TIANSHUTAI";
const LEGACY_PREFIX: &str = "CLOAKFORGE";

/// 本地 IPC 服务地址（Rust 注入 → Sidecar 读取）
pub const IPC_URL: &str = "IPC_URL";
/// 当前环境 ID（Rust 注入 → Sidecar 读取）
pub const PROFILE_ID: &str = "PROFILE_ID";
/// 本地 IPC 会话共享令牌（Rust 注入 → Sidecar 读取）
pub const IPC_TOKEN: &str = "IPC_TOKEN";
/// 日志级别开关
pub const LOG_LEVEL: &str = "LOG_LEVEL";
/// 常规浏览器下载根目录（Rust 注入 → Sidecar 读取）
pub const BROWSER_DOWNLOAD_DIR: &str = "BROWSER_DOWNLOAD_DIR";
/// 爬虫/媒体下载根目录（Rust 注入 → Sidecar 读取）
pub const SCRAPER_DOWNLOAD_DIR: &str = "SCRAPER_DOWNLOAD_DIR";

/// 规范变量名（如 `TIANSHUTAI_IPC_URL`）。
pub fn name(suffix: &str) -> String {
    format!("{PREFIX}_{suffix}")
}

fn legacy_name(suffix: &str) -> String {
    format!("{LEGACY_PREFIX}_{suffix}")
}

/// 读取变量：优先新名，回退旧名；两者皆空返回 `None`。
///
/// 返回空串的变量视同未设置（Windows 上「设为空」与「未设置」难以区分）。
pub fn get(suffix: &str) -> Option<String> {
    for candidate in [name(suffix), legacy_name(suffix)] {
        if let Ok(value) = std::env::var(&candidate) {
            let trimmed = value.trim().to_owned();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

/// 注入变量到子进程环境（仅写新名）。
pub fn set(cmd: &mut Command, suffix: &str, value: &str) {
    cmd.env(name(suffix), value);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_name_uses_new_prefix() {
        assert_eq!(name(IPC_URL), "TIANSHUTAI_IPC_URL");
        assert_eq!(name(LOG_LEVEL), "TIANSHUTAI_LOG_LEVEL");
    }

    #[test]
    fn get_prefers_new_name_and_falls_back_to_legacy() {
        let suffix = "TEST_PRIORITY_VAR";
        std::env::remove_var(name(suffix));
        std::env::remove_var(legacy_name(suffix));

        assert_eq!(get(suffix), None, "unset must yield None");

        std::env::set_var(legacy_name(suffix), "legacy-value");
        assert_eq!(get(suffix).as_deref(), Some("legacy-value"), "legacy fallback");

        std::env::set_var(name(suffix), "new-value");
        assert_eq!(get(suffix).as_deref(), Some("new-value"), "new name wins");

        // 空白值必须视同未设置，否则会拿到空串当有效配置
        std::env::set_var(name(suffix), "   ");
        assert_eq!(get(suffix).as_deref(), Some("legacy-value"), "blank falls back");

        std::env::remove_var(name(suffix));
        std::env::remove_var(legacy_name(suffix));
    }

    /// 直接守护 Rust → Sidecar 契约：注入的必须是新名，且不带旧名（否则等于没改名）。
    #[test]
    fn set_injects_canonical_name_only() {
        let mut cmd = Command::new("node");
        set(&mut cmd, IPC_URL, "http://127.0.0.1:1");
        set(&mut cmd, PROFILE_ID, "7");
        set(&mut cmd, IPC_TOKEN, "tok");

        let mut injected: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        injected.sort();

        assert_eq!(
            injected,
            vec![
                (name(IPC_TOKEN), "tok".to_owned()),
                (name(IPC_URL), "http://127.0.0.1:1".to_owned()),
                (name(PROFILE_ID), "7".to_owned()),
            ]
        );
        assert!(
            injected.iter().all(|(key, _)| !key.starts_with(LEGACY_PREFIX)),
            "must not inject legacy names: {injected:?}"
        );
    }
}
