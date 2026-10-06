use std::path::{Path, PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use rfd::FileDialog;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::cloak_binary;
use crate::db;
use crate::error::AppError;
use crate::AppState;

const KEY_PEPPER: &[u8] = b"TianshuTai-Commercial-KeyFile-v1";
const KEY_FILE_FORMAT: &str = "tianshu-keyfile";

#[derive(Debug, Deserialize)]
struct KeyFileEnvelope {
    format: String,
    version: u32,
    nonce: String,
    payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFilePayload {
    pub cloak_license_key: String,
    /// 旧 Key 文件可能仍带 Scamalytics 字段；已废弃，仅反序列化兼容。
    #[serde(default)]
    pub scamalytics_api_base_url: Option<String>,
    #[serde(default)]
    pub scamalytics_api_user: Option<String>,
    #[serde(default)]
    pub scamalytics_api_key: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFileActionResult {
    pub ok: bool,
    pub message: String,
    pub is_pro: bool,
    pub is_valid: bool,
    pub key_file_path: Option<String>,
    pub license_plan: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseEntitlement {
    pub is_pro: bool,
    pub is_valid: bool,
    pub license_plan: Option<String>,
    pub key_file_path: Option<String>,
}

fn derive_master_key() -> [u8; 32] {
    let digest = Sha256::digest(KEY_PEPPER);
    digest.into()
}

pub fn decrypt_key_file_bytes(bytes: &[u8]) -> Result<KeyFilePayload, AppError> {
    let envelope: KeyFileEnvelope = serde_json::from_slice(bytes).map_err(|error| {
        AppError::Validation(format!("Key 文件格式无效: {error}"))
    })?;

    if envelope.format != KEY_FILE_FORMAT {
        return Err(AppError::Validation(format!(
            "不支持的 Key 文件格式: {}",
            envelope.format
        )));
    }
    if envelope.version != 1 {
        return Err(AppError::Validation(format!(
            "不支持的 Key 文件版本: {}",
            envelope.version
        )));
    }

    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(envelope.nonce.trim())
        .map_err(|error| AppError::Validation(format!("Key 文件 nonce 无效: {error}")))?;
    if nonce_bytes.len() != 12 {
        return Err(AppError::Validation("Key 文件 nonce 长度无效".to_owned()));
    }

    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(envelope.payload.trim())
        .map_err(|error| AppError::Validation(format!("Key 文件密文无效: {error}")))?;

    let cipher = Aes256Gcm::new_from_slice(&derive_master_key())
        .map_err(|error| AppError::Validation(format!("Key 解密初始化失败: {error}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| AppError::Validation("Key 文件解密失败，文件可能已损坏或不是本程序签发".to_owned()))?;

    let payload: KeyFilePayload = serde_json::from_slice(&plaintext).map_err(|error| {
        AppError::Validation(format!("Key 文件内容无效: {error}"))
    })?;

    if payload.cloak_license_key.trim().is_empty() && !is_free_plan(payload.plan.as_deref()) {
        return Err(AppError::Validation("Key 文件缺少 CloakBrowser License".to_owned()));
    }

    Ok(payload)
}

fn is_free_plan(plan: Option<&str>) -> bool {
    plan.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.eq_ignore_ascii_case("free"))
        .unwrap_or(false)
}

pub fn decrypt_key_file_path(path: &str) -> Result<KeyFilePayload, AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("Key 文件路径不能为空".to_owned()));
    }
    let file_path = Path::new(trimmed);
    if !file_path.is_file() {
        return Err(AppError::Validation(format!("Key 文件不存在: {trimmed}")));
    }
    let bytes = std::fs::read(file_path)
        .map_err(|error| AppError::Filesystem(format!("无法读取 Key 文件: {error}")))?;
    decrypt_key_file_bytes(&bytes)
}

/// CloakBrowser 服务端语义：`plan` 只有 `free` 是免费档，其余
/// （pro / business / solo / team / scale / …）均为付费 Pro —— 与官方
/// `download.js` 的 `plan === "free"` 判定保持一致。
/// 以服务端 plan 为准；服务端缺失时才回退 Key 文件的 plan。
/// 之前的白名单（含 "pro"/"business"/…）会漏判 `solo` 等常见付费档，
/// 导致真实 Pro 用户被误判为 Free、AI/Agent 被 151-pro 内核拦截。
fn is_pro_plan(plan: Option<&str>, payload_plan: Option<&str>) -> bool {
    let effective = plan
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| payload_plan.map(str::trim).filter(|value| !value.is_empty()));
    matches!(effective, Some(value) if !value.eq_ignore_ascii_case("free"))
}

fn apply_key_payload(connection: &Connection, payload: &KeyFilePayload, key_file_path: &str) -> Result<(), AppError> {
    connection.execute(
        "INSERT INTO global_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params!["cloak_license_key", payload.cloak_license_key.trim()],
    )?;

    connection.execute(
        "INSERT INTO global_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params!["key_file_path", key_file_path.trim()],
    )?;

    Ok(())
}

async fn fetch_license_status(
    license_key: String,
) -> Result<cloak_binary::CloakBinaryStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        cloak_binary::fetch_cloak_binary_status(Some(license_key), None)
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
}

#[derive(Debug, Clone)]
struct KeyValidation {
    free_tier: bool,
    license_plan: Option<String>,
    is_pro: bool,
    is_valid: bool,
}

async fn validate_key_payload(payload: &KeyFilePayload) -> Result<KeyValidation, AppError> {
    let free_tier = is_free_plan(payload.plan.as_deref())
        && payload.cloak_license_key.trim().is_empty();
    let mut license_valid = free_tier;
    let mut license_plan = if free_tier {
        Some("free".to_owned())
    } else {
        None
    };

    if !free_tier {
        let binary_status = fetch_license_status(payload.cloak_license_key.clone()).await?;
        license_valid = binary_status.license_valid.unwrap_or(false);
        license_plan = binary_status.license_plan;
    }

    let is_valid = free_tier || license_valid;
    let is_pro =
        is_valid && is_pro_plan(license_plan.as_deref(), payload.plan.as_deref()) && !free_tier;

    Ok(KeyValidation {
        free_tier,
        license_plan,
        is_pro,
        is_valid,
    })
}

fn import_result_message(validation: &KeyValidation) -> String {
    if validation.free_tier {
        return "Key 文件已导入（Free）".to_owned();
    }
    if validation.is_valid {
        if validation.is_pro {
            return "Key 文件已导入，Pro 授权验证通过".to_owned();
        }
        return "Key 文件已导入，授权验证通过".to_owned();
    }
    "Key 文件已导入，但 Pro 授权未通过（密钥无效或授权服务不可达）".to_owned()
}

fn test_result_message(validation: &KeyValidation) -> String {
    if validation.free_tier {
        return "Key 文件测试通过（Free）".to_owned();
    }
    if validation.is_valid {
        if validation.is_pro {
            return "Key 文件测试通过（Pro）".to_owned();
        }
        return "Key 文件测试通过".to_owned();
    }
    "Key 文件解密成功，但 Pro 授权测试未通过".to_owned()
}

fn build_result(
    ok: bool,
    message: String,
    is_pro: bool,
    is_valid: bool,
    key_file_path: Option<String>,
    license_plan: Option<String>,
) -> KeyFileActionResult {
    KeyFileActionResult {
        ok,
        message,
        is_pro,
        is_valid,
        key_file_path,
        license_plan,
    }
}

fn pick_key_file_start_dir(connection: &Connection) -> Option<PathBuf> {
    if let Ok(Some(stored)) = db::get_setting(connection, "key_file_path") {
        let trimmed = stored.trim();
        if !trimmed.is_empty() {
            let parent = Path::new(trimmed).parent()?;
            if parent.is_dir() {
                return Some(parent.to_path_buf());
            }
        }
    }

    if let Ok(profile) = std::env::var("USERPROFILE") {
        let desktop = PathBuf::from(&profile).join("Desktop");
        if desktop.is_dir() {
            return Some(desktop);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if cwd.is_dir() {
            return Some(cwd);
        }
    }

    None
}

#[tauri::command]
pub fn pick_key_file(state: State<'_, AppState>) -> Result<Option<String>, AppError> {
    let start_dir = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        pick_key_file_start_dir(&connection)
    };

    let mut dialog = FileDialog::new()
        .set_title("选择 Key 文件")
        .add_filter("Key 文件", &["tsk"])
        .add_filter("All files", &["*"]);

    if let Some(dir) = start_dir {
        dialog = dialog.set_directory(dir);
    }

    let picked = dialog.pick_file();
    Ok(picked.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn import_key_file(path: String, state: State<'_, AppState>) -> Result<KeyFileActionResult, AppError> {
    let payload = decrypt_key_file_path(&path)?;
    {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        apply_key_payload(&connection, &payload, path.trim())?;
    }

    let validation = validate_key_payload(&payload).await?;

    Ok(build_result(
        true,
        import_result_message(&validation),
        validation.is_pro,
        validation.is_valid,
        Some(path.trim().to_owned()),
        validation.license_plan,
    ))
}

#[tauri::command]
pub async fn test_key_file(path: String, _state: State<'_, AppState>) -> Result<KeyFileActionResult, AppError> {
    let payload = decrypt_key_file_path(&path)?;
    let validation = validate_key_payload(&payload).await?;

    Ok(build_result(
        validation.is_valid,
        test_result_message(&validation),
        validation.is_pro,
        validation.is_valid,
        Some(path.trim().to_owned()),
        validation.license_plan,
    ))
}

#[tauri::command]
pub async fn check_license_entitlement(state: State<'_, AppState>) -> Result<LicenseEntitlement, AppError> {
    resolve_license_entitlement(&state).await
}

/// Shared entitlement resolve for AI kernel gates (Agent / fill).
pub async fn resolve_license_entitlement(state: &State<'_, AppState>) -> Result<LicenseEntitlement, AppError> {
    let (key_file_path, license_key) = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        (
            db::get_setting(&connection, "key_file_path")?
                .filter(|value| !value.trim().is_empty()),
            db::get_setting(&connection, "cloak_license_key")?
                .filter(|value| !value.trim().is_empty()),
        )
    };

    if license_key.is_none() {
        if let Some(path) = key_file_path.as_deref() {
            if let Ok(payload) = decrypt_key_file_path(path) {
                if is_free_plan(payload.plan.as_deref()) && payload.cloak_license_key.trim().is_empty()
                {
                    return Ok(LicenseEntitlement {
                        is_pro: false,
                        is_valid: true,
                        license_plan: Some("free".to_owned()),
                        key_file_path,
                    });
                }
            }
        }
        return Ok(LicenseEntitlement {
            is_pro: false,
            is_valid: false,
            license_plan: None,
            key_file_path,
        });
    }

    let Some(license_key) = license_key else {
        return Ok(LicenseEntitlement {
            is_pro: false,
            is_valid: false,
            license_plan: None,
            key_file_path,
        });
    };

    let binary_status = fetch_license_status(license_key.clone()).await?;
    let license_valid = binary_status.license_valid.unwrap_or(false);
    let license_plan = binary_status.license_plan.clone();

    let payload_plan = key_file_path
        .as_ref()
        .and_then(|stored| decrypt_key_file_path(stored).ok())
        .and_then(|payload| payload.plan);

    let is_pro = license_valid && is_pro_plan(license_plan.as_deref(), payload_plan.as_deref());

    Ok(LicenseEntitlement {
        is_pro,
        is_valid: license_valid,
        license_plan,
        key_file_path,
    })
}

/// Strip whitespace introduced by email copy/paste (e.g. `cb_ xxx yyy`).
fn normalize_license_key(raw: &str) -> String {
    raw.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn cloakbrowser_license_key_path() -> Result<PathBuf, AppError> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| AppError::Filesystem("无法解析用户主目录".to_owned()))?;
    Ok(PathBuf::from(home).join(".cloakbrowser").join("license.key"))
}

fn sync_cloakbrowser_license_key_file(key: &str) -> Result<(), AppError> {
    let path = cloakbrowser_license_key_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AppError::Filesystem(format!("创建 .cloakbrowser 目录失败: {error}"))
        })?;
    }
    if key.is_empty() {
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|error| {
                AppError::Filesystem(format!("删除 license.key 失败: {error}"))
            })?;
        }
        return Ok(());
    }
    std::fs::write(&path, format!("{key}\n")).map_err(|error| {
        AppError::Filesystem(format!("写入 license.key 失败: {error}"))
    })?;
    Ok(())
}

fn store_cloak_license_key(connection: &Connection, key: &str) -> Result<(), AppError> {
    connection.execute(
        "INSERT INTO global_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params!["cloak_license_key", key],
    )?;
    Ok(())
}

/// 直接粘贴 CloakBrowser 官方邮件中的 `cb_…` License Key（无需 .tsk）。
/// 会写入 SQLite，并同步到 `~/.cloakbrowser/license.key`（官方 CLI 约定）。
#[tauri::command]
pub async fn set_cloak_license_key(
    license_key: String,
    state: State<'_, AppState>,
) -> Result<KeyFileActionResult, AppError> {
    let normalized = normalize_license_key(&license_key);
    if normalized.is_empty() {
        return Err(AppError::Validation(
            "License Key 不能为空（可从 CloakBrowser 订阅邮件复制 cb_ 开头的密钥）".to_owned(),
        ));
    }
    if !normalized.to_ascii_lowercase().starts_with("cb_") {
        return Err(AppError::Validation(
            "License Key 格式无效：应以 cb_ 开头（请去掉邮件里误插入的空格后重试）".to_owned(),
        ));
    }

    {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        store_cloak_license_key(&connection, &normalized)?;
    }
    sync_cloakbrowser_license_key_file(&normalized)?;

    let binary_status = fetch_license_status(normalized.clone()).await?;
    let license_valid = binary_status.license_valid.unwrap_or(false);
    let license_plan = binary_status.license_plan.clone();
    let is_pro = license_valid && is_pro_plan(license_plan.as_deref(), None);

    let message = if license_valid && is_pro {
        format!(
            "Pro License 已保存并验证通过（plan={}）。请到「指纹浏览器内核」点「检查更新」下载 151。",
            license_plan.as_deref().unwrap_or("pro")
        )
    } else if license_valid {
        format!(
            "License 已保存（plan={}）。可点「检查更新」拉取对应内核。",
            license_plan.as_deref().unwrap_or("unknown")
        )
    } else if let Some(reason) = binary_status.license_fallback_reason.as_deref() {
        format!("License 已写入本地，但在线验证未通过：{reason}")
    } else {
        "License 已写入本地，但在线验证未通过（请检查网络，或开启「授权检查走代理」）".to_owned()
    };

    Ok(build_result(
        true,
        message,
        is_pro,
        license_valid,
        None,
        license_plan,
    ))
}

/// 清空本地 CloakBrowser License（SQLite + ~/.cloakbrowser/license.key）。
#[tauri::command]
pub async fn clear_cloak_license_key(
    state: State<'_, AppState>,
) -> Result<KeyFileActionResult, AppError> {
    {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        store_cloak_license_key(&connection, "")?;
    }
    sync_cloakbrowser_license_key_file("")?;

    Ok(build_result(
        true,
        "已清除 CloakBrowser License，将回退 Free 内核".to_owned(),
        false,
        false,
        None,
        None,
    ))
}
