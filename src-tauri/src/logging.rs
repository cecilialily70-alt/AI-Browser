//! 轻量分级日志（零外部依赖，避免改动 Cargo.toml / 系统配置）。
//!
//! 仅封装 `eprintln!`，为每条日志补 `[LEVEL]` 前缀并受环境变量
//! `TIANSHUTAI_LOG_LEVEL=trace|debug|info|warn|error|off` 门控（缺省 `warn`，
//! 即 error/warn 恒输出，info 及以下仅显式设置环境变量时开启；兼容旧名 `CLOAKFORGE_LOG_LEVEL`）。
//!
//! 用法：`crate::log_error!("...{}", value);` 等。文案与原 `eprintln!` 完全一致，
//! 仅新增级别前缀与门控，不影响任何业务逻辑 / 函数签名 / 数据结构。

use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warn = 3,
    Error = 4,
    Off = 5,
}

impl LogLevel {
    fn label(self) -> &'static str {
        match self {
            LogLevel::Trace => "TRACE",
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
            LogLevel::Off => "OFF",
        }
    }
}

/// 读取进程级日志级别门限（仅首次求值，之后缓存）。
pub fn min_level() -> LogLevel {
    static LEVEL: OnceLock<LogLevel> = OnceLock::new();
    *LEVEL.get_or_init(|| {
        let raw = crate::app_env::get(crate::app_env::LOG_LEVEL)
            .unwrap_or_default()
            .to_ascii_lowercase();
        match raw.as_str() {
            "trace" => LogLevel::Trace,
            "debug" => LogLevel::Debug,
            "info" => LogLevel::Info,
            "warn" => LogLevel::Warn,
            "error" => LogLevel::Error,
            "off" | "silent" => LogLevel::Off,
            _ => LogLevel::Warn,
        }
    })
}

/// 级别低于门限时静默；否则写 stderr（保持与 `eprintln!` 同一通道）。
pub fn emit(level: LogLevel, message: &str) {
    if level < min_level() {
        return;
    }
    eprintln!("[{}] {}", level.label(), message);
}

/// ERROR：拦截异常 / 失败路径（不可静默降级）。
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        $crate::logging::emit($crate::logging::LogLevel::Error, &format!($($arg)*))
    };
}

/// WARN：非致命降级 / 可恢复异常。
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {
        $crate::logging::emit($crate::logging::LogLevel::Warn, &format!($($arg)*))
    };
}

/// INFO：核心生命周期 / 关键调度节点。
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        $crate::logging::emit($crate::logging::LogLevel::Info, &format!($($arg)*))
    };
}

/// DEBUG：仅开发环境开启的诊断信息。
#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => {
        $crate::logging::emit($crate::logging::LogLevel::Debug, &format!($($arg)*))
    };
}

/// TRACE：最细粒度追踪（缺省静默）。
#[macro_export]
macro_rules! log_trace {
    ($($arg:tt)*) => {
        $crate::logging::emit($crate::logging::LogLevel::Trace, &format!($($arg)*))
    };
}
