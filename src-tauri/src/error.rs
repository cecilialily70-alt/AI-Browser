use rusqlite::Error as SqliteError;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("database error: {0}")]
    Database(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("record not found: {0}")]
    NotFound(String),
    #[error("filesystem error: {0}")]
    Filesystem(String),
    #[error("serialization error: {0}")]
    Serialization(String),
    #[error("application state error: {0}")]
    State(String),
    #[error("profile {0} browser is already running")]
    AlreadyRunning(String),
    #[error("profile {0} browser is not running")]
    NotRunning(String),
    #[error("browser launcher error: {0}")]
    Launcher(String),
    #[error("no available cdp ports in range {start}-{end}")]
    CdpPortsExhausted { start: u16, end: u16 },
    #[error("fraud check error: {0}")]
    FraudCheck(String),
    #[error("sidecar error: {0}")]
    Sidecar(String),
    #[error("LLM error: {0}")]
    Llm(String),
}

impl From<SqliteError> for AppError {
    fn from(error: SqliteError) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::Filesystem(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialization(error.to_string())
    }
}

impl AppError {
    /// 面向用户的原因文本。
    ///
    /// `Display` 输出带 `xxx error:` 前缀（供日志辨识来源），不适合直接展示或回传给前端，
    /// 因此这里剥掉前缀，只保留原因本体；无更优形态的变体回退到 `Display`。
    pub fn reason(&self) -> String {
        match self {
            Self::Database(inner)
            | Self::Validation(inner)
            | Self::NotFound(inner)
            | Self::Filesystem(inner)
            | Self::Serialization(inner)
            | Self::State(inner)
            | Self::Launcher(inner)
            | Self::FraudCheck(inner)
            | Self::Sidecar(inner)
            | Self::Llm(inner) => inner.clone(),
            Self::AlreadyRunning(_) | Self::NotRunning(_) | Self::CdpPortsExhausted { .. } => {
                self.to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn reason_strips_display_kind_prefix() {
        // UI 直接展示 reason()，不能再带 "sidecar error:" 这类日志前缀
        let error = AppError::Sidecar("读取轨迹目录失败: access denied".to_owned());
        assert_eq!(error.reason(), "读取轨迹目录失败: access denied");
        assert!(error.to_string().starts_with("sidecar error:"));
    }

    #[test]
    fn reason_keeps_sentences_that_need_their_subject_for_variants() {
        // AlreadyRunning/NotRunning 的 Display 才含完整语义，剥前缀会只剩 profile id
        let error = AppError::NotRunning("12".to_owned());
        assert_eq!(error.reason(), error.to_string());
    }
}
