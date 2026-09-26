//! 静态凭据保护：把密码 / API 配置等敏感值以「信封」形式落库。
//!
//! 存储格式（单行可读文本，便于放进 TEXT 列）：
//! `enc:v1:<backend>:<base64url(payload)>`
//!
//! 密钥来源按平台选择，绝不复用 `key_file.rs` 的硬编码 pepper（那只是混淆强度）：
//! - Windows：DPAPI `CryptProtectData`，密钥由系统按「当前用户 + 本机」派生，
//!   进程无法导出，密文拷到其它机器/用户即不可解。
//! - 其它平台：`~/.ai-browser/secret.key` 权限 0600 的 32 字节随机密钥，
//!   配合 AES-256-GCM。
//!
//! 兼容旧数据：没有 `enc:` 前缀的值视为历史明文，`reveal` 原样返回，
//! 由 `protect_if_plaintext` 在读取路径上懒加密回写（无需一次性重写整表）。

use base64::Engine;

use crate::error::AppError;
use crate::log_error;

#[cfg(not(windows))]
use std::fs;
#[cfg(not(windows))]
use std::path::PathBuf;

#[cfg(not(windows))]
use aes_gcm::aead::{Aead, KeyInit};
#[cfg(not(windows))]
use aes_gcm::{Aes256Gcm, Nonce};
#[cfg(not(windows))]
use rand::RngCore;

#[cfg(not(windows))]
use crate::log_warn;

const ENVELOPE_PREFIX: &str = "enc:v1:";
#[cfg(windows)]
const BACKEND_DPAPI: &str = "dpapi";
#[cfg(not(windows))]
const BACKEND_KEYFILE: &str = "keyfile";
/// DPAPI 附加熵：与 App 标识绑定，其它程序即使拿到密文也无法直接解出。
const DPAPI_ENTROPY: &[u8] = b"TianshuTai-Proxy-Secret-v1";

fn b64() -> &'static base64::engine::general_purpose::GeneralPurpose {
    &base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// 是否为已加密的信封（用于懒迁移判断）。
pub fn is_protected(raw: &str) -> bool {
    raw.starts_with(ENVELOPE_PREFIX)
}

fn non_empty(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|value| !value.is_empty())
}

/// 加密单个敏感值；空值不加密（避免给「无密码」造出噪音信封）。
pub fn protect(plaintext: &str) -> Result<Option<String>, AppError> {
    let value = plaintext.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if is_protected(value) {
        return Ok(Some(value.to_owned()));
    }
    let (backend, payload) = match encrypt_value(value.as_bytes()) {
        Ok(result) => result,
        Err(error) => {
            // 加密后端不可用（极少数受限环境）：宁可明文落库也不要丢凭据，但必须留痕
            log_error!("[secret_store] encrypt unavailable, storing plaintext: {error}");
            return Ok(Some(value.to_owned()));
        }
    };
    Ok(Some(format!(
        "{ENVELOPE_PREFIX}{backend}:{}",
        b64().encode(payload)
    )))
}

/// 解密信封；明文（无前缀）原样返回。
///
/// 返回 `None` 表示「密文无法恢复」（换了机器/用户、密钥文件丢失或数据损坏）。
/// 调用方应视作「无凭据」并提示用户重填——绝不把密文当明文使用。
pub fn reveal(raw: &str) -> Option<String> {
    if !is_protected(raw) {
        return Some(raw.to_owned());
    }
    let body = &raw[ENVELOPE_PREFIX.len()..];
    let (backend, encoded) = body.split_once(':').unwrap_or(("", body));
    let payload = match b64().decode(encoded) {
        Ok(bytes) => bytes,
        Err(error) => {
            log_error!("[secret_store] malformed base64 envelope: {error}");
            return None;
        }
    };
    match decrypt_value(backend, &payload) {
        Ok(plain) => String::from_utf8(plain).ok(),
        Err(error) => {
            log_error!("[secret_store] decrypt failed (backend={backend}): {error}");
            None
        }
    }
}

/// 懒迁移：仅当值是非空的未加密明文**且确实加密成功**时返回新值，否则 `None`（无需回写）。
pub fn protect_if_plaintext(raw: Option<&str>) -> Option<String> {
    let value = non_empty(raw)?;
    if is_protected(value) {
        return None;
    }
    match protect(value) {
        // 加密后端不可用时 protect 会原样返回明文；此时不回写，避免每次读取都重复写同一条
        Ok(Some(sealed)) if is_protected(&sealed) => Some(sealed),
        _ => None,
    }
}

/// 加密失败时的确定性降级：返回原值，保证功能可用性优先于机密性。
fn encrypt_value(plain: &[u8]) -> Result<(&'static str, Vec<u8>), AppError> {
    #[cfg(windows)]
    {
        return dpapi_protect(plain).map(|bytes| (BACKEND_DPAPI, bytes));
    }
    #[cfg(not(windows))]
    {
        keyfile_encrypt(plain).map(|bytes| (BACKEND_KEYFILE, bytes))
    }
}

fn decrypt_value(backend: &str, payload: &[u8]) -> Result<Vec<u8>, AppError> {
    match backend {
        #[cfg(windows)]
        BACKEND_DPAPI => dpapi_unprotect(payload),
        #[cfg(not(windows))]
        BACKEND_KEYFILE => keyfile_decrypt(payload),
        other => Err(AppError::State(format!(
            "secret envelope backend unsupported on this platform: {other}"
        ))),
    }
}

// ---------------------------------------------------------------- Windows DPAPI

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
    };

    use crate::error::AppError;

    use super::DPAPI_ENTROPY;

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    /// 接管 DPAPI 分配的缓冲区，转成 Vec 后立即释放，避免泄漏。
    fn take_output(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let result = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe {
            let _ = LocalFree(HLOCAL(out.pbData as *mut _));
        }
        result
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, AppError> {
        let input = blob(plain);
        let entropy = blob(DPAPI_ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        }
        .map_err(|error| AppError::State(format!("CryptProtectData failed: {error}")))?;
        Ok(take_output(out))
    }

    pub fn unprotect(payload: &[u8]) -> Result<Vec<u8>, AppError> {
        let input = blob(payload);
        let entropy = blob(DPAPI_ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        }
        .map_err(|error| AppError::State(format!("CryptUnprotectData failed: {error}")))?;
        Ok(take_output(out))
    }
}

#[cfg(windows)]
use dpapi::{protect as dpapi_protect, unprotect as dpapi_unprotect};

// ------------------------------------------------------- 其它平台：密钥文件 + AES-GCM

#[cfg(not(windows))]
fn secret_key_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".ai-browser").join("secret.key")
}

/// 读取（或首次生成）本机密钥；权限收紧到 0600，避免同机其它用户读取。
#[cfg(not(windows))]
fn load_or_create_key() -> Result<[u8; 32], AppError> {
    let path = secret_key_path();
    if let Ok(bytes) = fs::read(&path) {
        if bytes.len() == 32 {
            return Ok(bytes.try_into().unwrap_or([0u8; 32]));
        }
        log_warn!("[secret_store] secret.key has unexpected length, regenerating");
    }
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, key)?;
    restrict_permissions(&path)?;
    Ok(key)
}

#[cfg(not(windows))]
fn restrict_permissions(path: &std::path::Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(windows))]
fn keyfile_encrypt(plain: &[u8]) -> Result<Vec<u8>, AppError> {
    let key = load_or_create_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| AppError::State(format!("invalid secret key: {error}")))?;
    let mut nonce_bytes = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain)
        .map_err(|error| AppError::State(format!("secret encrypt failed: {error}")))?;
    let mut out = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

#[cfg(not(windows))]
fn keyfile_decrypt(payload: &[u8]) -> Result<Vec<u8>, AppError> {
    if payload.len() <= 12 {
        return Err(AppError::State("secret payload too short".to_owned()));
    }
    let key = load_or_create_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| AppError::State(format!("invalid secret key: {error}")))?;
    let (nonce_bytes, ciphertext) = payload.split_at(12);
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|error| AppError::State(format!("secret decrypt failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_is_recognised_and_passes_through() {
        assert!(!is_protected("hunter2"));
        assert_eq!(reveal("hunter2").as_deref(), Some("hunter2"));
        assert!(protect_if_plaintext(Some("hunter2")).is_some());
    }

    #[test]
    fn empty_values_are_never_enveloped() {
        assert!(protect("").expect("protect").is_none());
        assert!(protect("   ").expect("protect").is_none());
        assert!(protect_if_plaintext(None).is_none());
        assert!(protect_if_plaintext(Some("  ")).is_none());
    }

    #[test]
    fn round_trip_recovers_original_secret() {
        let secret = "p@ss:word with 空格 & symbols";
        let sealed = protect(secret).expect("protect").expect("envelope");
        assert!(is_protected(&sealed), "envelope must carry prefix: {sealed}");
        assert_ne!(sealed, secret, "envelope must not embed plaintext");
        assert!(!sealed.contains("p@ss"), "plaintext leaked into envelope");
        assert_eq!(reveal(&sealed).as_deref(), Some(secret));
    }

    #[test]
    fn protect_is_idempotent() {
        let sealed = protect("abc12345").expect("protect").expect("envelope");
        let again = protect(&sealed).expect("protect").expect("envelope");
        assert_eq!(sealed, again, "re-protecting an envelope must be a no-op");
        assert!(protect_if_plaintext(Some(&sealed)).is_none());
    }

    #[test]
    fn malformed_envelope_returns_none_instead_of_garbage() {
        assert!(reveal("enc:v1:dpapi:!!!not-base64!!!").is_none());
        assert!(reveal("enc:v1:unknown:AAAA").is_none());
        // 合法 base64 但不是有效 DPAPI blob（模拟密文被拷到另一台机器 / 被截断）
        assert!(reveal("enc:v1:dpapi:AAAAAAA").is_none());
        assert!(reveal("enc:v1:dpapi:AAAAAAAAAAAAAAAAAAAAAA").is_none());
    }

    #[test]
    fn protect_if_plaintext_reports_success_truthfully() {
        // 成功加密：必须返回信封，且能被 reveal 还原
        let sealed = protect_if_plaintext(Some("need-encryption")).expect("should migrate");
        assert!(is_protected(&sealed));
        assert_eq!(reveal(&sealed).as_deref(), Some("need-encryption"));
        // 已加密：不需要再迁移
        assert!(protect_if_plaintext(Some(&sealed)).is_none());
    }
}
