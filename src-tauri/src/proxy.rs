use std::time::Duration;

use reqwest::Proxy as ReqwestProxy;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::log_warn;
use crate::models::Proxy;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomProxyConfig {
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicApiConfig {
    pub api_url: String,
    pub protocol: String,
    pub region: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyAuthPayload {
    pub server: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedProxy {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ResolvedProxy {
    pub fn chromium_proxy_flag(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }

    pub fn to_custom_json(&self) -> Result<String, AppError> {
        let proxy_type = if self.scheme == "socks5" {
            "SOCKS5"
        } else {
            "HTTP"
        };
        let config = CustomProxyConfig {
            proxy_type: proxy_type.to_owned(),
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            password: self.password.clone(),
        };
        serde_json::to_string(&config).map_err(|error| AppError::Validation(error.to_string()))
    }

    pub fn auth_payload(&self) -> Option<ProxyAuthPayload> {
        if self
            .username
            .as_deref()
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return None;
        }
        Some(ProxyAuthPayload {
            server: self.chromium_proxy_flag(),
            username: self.username.clone(),
            password: self.password.clone(),
        })
    }
}

pub fn normalize_proxy_type(raw: &str) -> String {
    match raw.trim().to_ascii_uppercase().as_str() {
        "SOCKS5" | "SOCKS" => "SOCKS5".to_owned(),
        "DYNAMIC_API" => "DYNAMIC_API".to_owned(),
        _ => "HTTP".to_owned(),
    }
}

pub fn normalize_scheme(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "socks5" | "socks" => "socks5".to_owned(),
        _ => "http".to_owned(),
    }
}

pub fn apply_region_to_api_url(base_url: &str, region: &str) -> String {
    let trimmed = base_url.trim();
    let region = region.trim().to_ascii_lowercase();
    if region.is_empty() {
        return trimmed.to_owned();
    }

    if let Some(idx) = trimmed.find("region=") {
        let prefix = &trimmed[..idx];
        let remainder = &trimmed[idx + "region=".len()..];
        let suffix = remainder
            .split_once('&')
            .map(|(_, tail)| tail)
            .unwrap_or("");
        if suffix.is_empty() {
            format!("{prefix}region={region}")
        } else {
            format!("{prefix}region={region}&{suffix}")
        }
    } else if trimmed.contains('?') {
        format!("{trimmed}&region={region}")
    } else {
        format!("{trimmed}?region={region}")
    }
}

fn split_userinfo(userinfo: &str) -> (Option<String>, Option<String>) {
    if userinfo.is_empty() {
        return (None, None);
    }
    if let Some((user, pass)) = userinfo.split_once(':') {
        let user = user.trim();
        let pass = pass.trim();
        return (
            if user.is_empty() {
                None
            } else {
                Some(user.to_owned())
            },
            if pass.is_empty() {
                None
            } else {
                Some(pass.to_owned())
            },
        );
    }
    (Some(userinfo.trim().to_owned()), None)
}

fn parse_host_port(hostpart: &str) -> Result<(String, u16), AppError> {
    let trimmed = hostpart.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("proxy host is empty".to_owned()));
    }

    if let Some((host, port_raw)) = trimmed.rsplit_once(':') {
        if !host.is_empty() && !port_raw.contains(':') {
            let port = port_raw
                .trim()
                .parse::<u16>()
                .map_err(|_| AppError::Validation(format!("invalid proxy port: {port_raw}")))?;
            return Ok((host.trim().to_owned(), port));
        }
    }

    Err(AppError::Validation(format!(
        "invalid proxy host/port segment: {trimmed}"
    )))
}

fn parse_colon_segments(scheme: &str, rest: &str) -> Result<ResolvedProxy, AppError> {
    let parts: Vec<&str> = rest.split(':').map(str::trim).collect();
    match parts.len() {
        2 => {
            let port = parts[1]
                .parse::<u16>()
                .map_err(|_| AppError::Validation(format!("invalid proxy port: {}", parts[1])))?;
            Ok(ResolvedProxy {
                scheme: scheme.to_owned(),
                host: parts[0].to_owned(),
                port,
                username: None,
                password: None,
            })
        }
        3 => {
            let port = parts[1]
                .parse::<u16>()
                .map_err(|_| AppError::Validation(format!("invalid proxy port: {}", parts[1])))?;
            Ok(ResolvedProxy {
                scheme: scheme.to_owned(),
                host: parts[0].to_owned(),
                port,
                username: Some(parts[2].to_owned()),
                password: None,
            })
        }
        n if n >= 4 => {
            let port = parts[1]
                .parse::<u16>()
                .map_err(|_| AppError::Validation(format!("invalid proxy port: {}", parts[1])))?;
            let password = parts[n - 1].to_owned();
            let username = parts[2..n - 1].join(":");
            Ok(ResolvedProxy {
                scheme: scheme.to_owned(),
                host: parts[0].to_owned(),
                port,
                username: if username.is_empty() {
                    None
                } else {
                    Some(username)
                },
                password: if password.is_empty() {
                    None
                } else {
                    Some(password)
                },
            })
        }
        _ => Err(AppError::Validation(format!(
            "unsupported proxy format: {rest}"
        ))),
    }
}

pub fn parse_proxy_string(raw: &str) -> Result<ResolvedProxy, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("proxy string is empty".to_owned()));
    }

    let (scheme, rest) = if let Some(idx) = trimmed.find("://") {
        let scheme = normalize_scheme(&trimmed[..idx]);
        (scheme, trimmed[idx + 3..].trim())
    } else {
        ("http".to_owned(), trimmed)
    };

    if let Some(at) = rest.rfind('@') {
        let userinfo = &rest[..at];
        let hostpart = &rest[at + 1..];
        let (username, password) = split_userinfo(userinfo);
        let (host, port) = parse_host_port(hostpart)?;
        return Ok(ResolvedProxy {
            scheme,
            host,
            port,
            username,
            password,
        });
    }

    parse_colon_segments(&scheme, rest)
}

pub fn parse_custom_proxy_json(raw: &str) -> Result<ResolvedProxy, AppError> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') {
        let config: CustomProxyConfig = serde_json::from_str(trimmed).map_err(|error| {
            AppError::Validation(format!("invalid stored custom_proxy config: {error}"))
        })?;
        return Ok(ResolvedProxy {
            scheme: normalize_scheme(&config.proxy_type),
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
        });
    }
    parse_proxy_string(trimmed)
}

fn escape_js_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn sanitize_ext_profile_id(profile_id: &str) -> String {
    let raw = profile_id.trim();
    let base = if raw.is_empty() { "unknown" } else { raw };
    base.chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .take(64)
        .collect()
}

/// Temp root for Manifest V2 proxy-auth extensions (plaintext creds, burn-after-use).
pub fn proxy_auth_extension_root() -> std::path::PathBuf {
    std::env::temp_dir().join("ai-browser-proxy-auth")
}

pub fn proxy_auth_extension_dir(profile_id: &str) -> std::path::PathBuf {
    proxy_auth_extension_root().join(sanitize_ext_profile_id(profile_id))
}

pub fn purge_proxy_auth_extension(profile_id: &str) {
    let dir = proxy_auth_extension_dir(profile_id);
    if dir.exists() {
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            log_warn!("[proxy] purge extension {profile_id} failed: {error}");
        }
    }
}

/// Remove leftover `proxy_auth_ext` from older builds that wrote into the profile user-data dir.
pub fn purge_stale_profile_proxy_auth_ext(user_data_dir: &std::path::Path) {
    let stale = user_data_dir.join("proxy_auth_ext");
    if stale.exists() {
        if let Err(error) = std::fs::remove_dir_all(&stale) {
            log_warn!("[proxy] purge stale extension {:?} failed: {error}", stale);
        }
    }
}

pub fn purge_all_proxy_auth_extensions() {
    let root = proxy_auth_extension_root();
    if root.exists() {
        if let Err(error) = std::fs::remove_dir_all(root) {
            log_warn!("[proxy] purge all extensions failed: {error}");
        }
    }
}

/// 在系统临时目录生成 Manifest V2 代理认证扩展，消除 Chromium 原生账密弹窗。
pub fn generate_proxy_auth_extension(
    profile_id: &str,
    resolved: &ResolvedProxy,
) -> Result<String, AppError> {
    let username = resolved
        .username
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Validation("proxy username is required for auth extension".to_owned())
        })?;
    let password = resolved.password.as_deref().unwrap_or("");

    let ext_dir = proxy_auth_extension_dir(profile_id);
    if ext_dir.exists() {
        std::fs::remove_dir_all(&ext_dir)?;
    }
    std::fs::create_dir_all(&ext_dir)?;

    let manifest = r#"{
  "version": "1.0.0",
  "manifest_version": 2,
  "name": "TianshuTai Proxy Auth",
  "permissions": ["proxy", "tabs", "unlimitedStorage", "storage", "<all_urls>", "webRequest", "webRequestBlocking"],
  "background": {"scripts": ["background.js"]}
}"#;
    std::fs::write(ext_dir.join("manifest.json"), manifest)?;

    let background_js = format!(
        r#"chrome.webRequest.onAuthRequired.addListener(
    function(details) {{
        return {{
            authCredentials: {{
                username: "{username}",
                password: "{password}"
            }}
        }};
    }},
    {{urls: ["<all_urls>"]}},
    ["blocking"]
);
"#,
        username = escape_js_string(username),
        password = escape_js_string(password),
    );
    std::fs::write(ext_dir.join("background.js"), background_js)?;

    let canonical = ext_dir
        .canonicalize()
        .map_err(|error| AppError::Filesystem(error.to_string()))?;
    Ok(canonical.to_string_lossy().into_owned())
}

pub fn resolved_proxy_needs_auth_extension(resolved: &ResolvedProxy) -> bool {
    resolved
        .username
        .as_deref()
        .filter(|value| !value.is_empty())
        .is_some()
}

pub fn parse_dynamic_api_config(raw: &str) -> Result<DynamicApiConfig, AppError> {
    serde_json::from_str(raw)
        .map_err(|error| AppError::Validation(format!("invalid dynamic API config: {error}")))
}

pub fn resolved_from_pool_proxy(proxy: &Proxy) -> Result<ResolvedProxy, AppError> {
    if proxy.proxy_type.to_ascii_uppercase() == "DYNAMIC_API" {
        return Err(AppError::Validation(
            "dynamic API proxy must be resolved at runtime".to_owned(),
        ));
    }
    Ok(ResolvedProxy {
        scheme: normalize_scheme(&proxy.proxy_type),
        host: proxy.host.clone(),
        port: proxy.port as u16,
        username: proxy.username.clone(),
        password: proxy.password.clone(),
    })
}

pub fn first_valid_line_from_txt(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return Some(trimmed.to_owned());
    }
    None
}

/// 解析 API `type=txt` 返回的首行代理文本。
/// 支持 `host:port`（2 段）与 `host:port:username:password`（4 段及以上，密码可含冒号）。
pub fn parse_api_txt_proxy_line(line: &str, scheme: &str) -> Result<ResolvedProxy, AppError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "API txt proxy line is empty".to_owned(),
        ));
    }

    if trimmed.contains("://") {
        return parse_proxy_string(trimmed);
    }

    let parts: Vec<&str> = trimmed.split(':').map(str::trim).collect();
    let scheme = normalize_scheme(scheme);

    match parts.len() {
        2 => {
            let host = parts[0].to_owned();
            let port = parts[1]
                .parse::<u16>()
                .map_err(|_| AppError::Validation(format!("invalid proxy port: {}", parts[1])))?;
            Ok(ResolvedProxy {
                scheme,
                host,
                port,
                username: None,
                password: None,
            })
        }
        4 => {
            let host = parts[0].to_owned();
            let port = parts[1]
                .parse::<u16>()
                .map_err(|_| AppError::Validation(format!("invalid proxy port: {}", parts[1])))?;
            let username = parts[2].to_owned();
            let password = parts[3].to_owned();
            Ok(ResolvedProxy {
                scheme,
                host,
                port,
                username: if username.is_empty() {
                    None
                } else {
                    Some(username)
                },
                password: if password.is_empty() {
                    None
                } else {
                    Some(password)
                },
            })
        }
        n if n > 4 => {
            let host = parts[0].to_owned();
            let port = parts[1]
                .parse::<u16>()
                .map_err(|_| AppError::Validation(format!("invalid proxy port: {}", parts[1])))?;
            let username = parts[2].to_owned();
            let password = parts[3..].join(":");
            Ok(ResolvedProxy {
                scheme,
                host,
                port,
                username: if username.is_empty() {
                    None
                } else {
                    Some(username)
                },
                password: if password.is_empty() {
                    None
                } else {
                    Some(password)
                },
            })
        }
        _ => Err(AppError::Validation(format!(
            "unsupported API txt proxy format (expected host:port or host:port:user:pass): {trimmed}"
        ))),
    }
}

pub fn parse_api_txt_proxy_body(body: &str, scheme: &str) -> Result<ResolvedProxy, AppError> {
    let line = first_valid_line_from_txt(body).ok_or_else(|| {
        AppError::FraudCheck("dynamic API returned no valid txt proxy line".to_owned())
    })?;
    parse_api_txt_proxy_line(&line, scheme)
}

pub async fn fetch_dynamic_proxy(api_url: &str, protocol: &str) -> Result<ResolvedProxy, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| AppError::FraudCheck(error.to_string()))?;

    let response = client
        .get(api_url.trim())
        .send()
        .await
        .map_err(|error| AppError::FraudCheck(format!("dynamic API request failed: {error}")))?;

    if !response.status().is_success() {
        return Err(AppError::FraudCheck(format!(
            "dynamic API returned status {}",
            response.status()
        )));
    }

    let body = response
        .text()
        .await
        .map_err(|error| AppError::FraudCheck(format!("failed to read dynamic API body: {error}")))?
        .trim()
        .to_owned();

    if body.is_empty() {
        return Err(AppError::FraudCheck(
            "dynamic API returned empty proxy payload".to_owned(),
        ));
    }

    parse_api_txt_proxy_body(&body, protocol)
}

pub fn build_reqwest_proxy(resolved: &ResolvedProxy) -> Result<ReqwestProxy, AppError> {
    let mut proxy = ReqwestProxy::all(resolved.chromium_proxy_flag())
        .map_err(|error| AppError::Validation(format!("invalid proxy URL: {error}")))?;

    if let (Some(user), Some(pass)) = (&resolved.username, &resolved.password) {
        proxy = proxy.basic_auth(user, pass);
    } else if let Some(user) = &resolved.username {
        proxy = proxy.basic_auth(user, "");
    }

    Ok(proxy)
}

pub async fn resolve_egress_ip(resolved: &ResolvedProxy) -> Result<String, AppError> {
    let client = reqwest::Client::builder()
        .proxy(build_reqwest_proxy(resolved)?)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| AppError::FraudCheck(error.to_string()))?;

    let response = client
        .get("https://api.ipify.org?format=json")
        .send()
        .await
        .map_err(|error| AppError::FraudCheck(format!("proxy egress lookup failed: {error}")))?;

    if !response.status().is_success() {
        return Err(AppError::FraudCheck(format!(
            "egress IP endpoint returned {}",
            response.status()
        )));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AppError::FraudCheck(format!("failed to parse egress IP response: {error}")))?;

    body.get("ip")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::FraudCheck("egress IP response missing ip field".to_owned()))
}

pub async fn test_resolved_proxy(resolved: &ResolvedProxy) -> Result<String, AppError> {
    let egress_ip = resolve_egress_ip(resolved).await?;
    Ok(format!(
        "proxy ok via {} (egress: {{\"ip\":\"{}\"}})",
        resolved.chromium_proxy_flag(),
        egress_ip
    ))
}

pub fn profile_has_proxy(profile: &crate::models::Profile) -> bool {
    profile
        .custom_proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
        || profile.proxy_id.is_some()
}

pub enum ProxyResolutionInput {
    Custom(String),
    Pool(Proxy),
}

pub async fn resolve_profile_proxy_input(
    input: ProxyResolutionInput,
) -> Result<ResolvedProxy, AppError> {
    match input {
        ProxyResolutionInput::Custom(raw) => parse_custom_proxy_json(&raw),
        ProxyResolutionInput::Pool(pool_proxy) => {
            if pool_proxy.proxy_type.to_ascii_uppercase() == "DYNAMIC_API" {
                let api_config = pool_proxy.api_config.as_deref().ok_or_else(|| {
                    AppError::Validation("dynamic API proxy missing api_config".to_owned())
                })?;
                let config = parse_dynamic_api_config(api_config)?;
                let url = apply_region_to_api_url(&config.api_url, &config.region);
                fetch_dynamic_proxy(&url, &config.protocol).await
            } else {
                resolved_from_pool_proxy(&pool_proxy)
            }
        }
    }
}

pub fn proxy_resolution_input_from_profile(
    connection: &rusqlite::Connection,
    profile: &crate::models::Profile,
) -> Result<Option<ProxyResolutionInput>, AppError> {
    use crate::db;

    if let Some(raw) = profile
        .custom_proxy
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(Some(ProxyResolutionInput::Custom(raw.to_owned())));
    }

    if let Some(proxy_id) = profile.proxy_id {
        let pool_proxy = db::get_proxy(connection, proxy_id)?;
        return Ok(Some(ProxyResolutionInput::Pool(pool_proxy)));
    }

    Ok(None)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_port_user_pass_with_hyphenated_username() {
        let resolved = parse_proxy_string("us.novproxy.io:1000:xr-region-US-sid-xyz:password")
            .expect("parse");
        assert_eq!(resolved.host, "us.novproxy.io");
        assert_eq!(resolved.port, 1000);
        assert_eq!(
            resolved.username.as_deref(),
            Some("xr-region-US-sid-xyz")
        );
        assert_eq!(resolved.password.as_deref(), Some("password"));
    }

    #[test]
    fn parses_scheme_url_without_auth() {
        let resolved = parse_proxy_string("socks5://127.0.0.1:7890").expect("parse");
        assert_eq!(resolved.scheme, "socks5");
        assert_eq!(resolved.host, "127.0.0.1");
        assert_eq!(resolved.port, 7890);
    }

    #[test]
    fn parses_user_pass_at_host_port() {
        let resolved =
            parse_proxy_string("http://session-abc:token@1.2.3.4:8080").expect("parse");
        assert_eq!(resolved.username.as_deref(), Some("session-abc"));
        assert_eq!(resolved.password.as_deref(), Some("token"));
        assert_eq!(resolved.host, "1.2.3.4");
        assert_eq!(resolved.port, 8080);
    }

    #[test]
    fn applies_region_query_param() {
        let url = apply_region_to_api_url("https://api.example.com/proxy?key=abc", "hk");
        assert!(url.contains("region=hk"));
    }

    #[test]
    fn parses_api_txt_host_port() {
        let body = "1.2.3.4:8080\r\n";
        let resolved = parse_api_txt_proxy_body(body, "HTTP").expect("parse");
        assert_eq!(resolved.host, "1.2.3.4");
        assert_eq!(resolved.port, 8080);
        assert!(resolved.username.is_none());
    }

    #[test]
    fn parses_api_txt_host_port_auth() {
        let body = "us.novproxy.io:1000:xr-region-US-sid-xyz:password\n";
        let resolved = parse_api_txt_proxy_body(body, "HTTP").expect("parse");
        assert_eq!(resolved.host, "us.novproxy.io");
        assert_eq!(resolved.port, 1000);
        assert_eq!(resolved.username.as_deref(), Some("xr-region-US-sid-xyz"));
        assert_eq!(resolved.password.as_deref(), Some("password"));
    }

    #[test]
    fn parses_api_txt_first_valid_line_only() {
        let body = "\n# comment\n\r\n2.3.4.5:3128:user:pass\nignored-line:9:u:p\n";
        let resolved = parse_api_txt_proxy_body(body, "SOCKS5").expect("parse");
        assert_eq!(resolved.host, "2.3.4.5");
        assert_eq!(resolved.scheme, "socks5");
    }

    #[test]
    fn generates_proxy_auth_extension_files() {
        let resolved = ResolvedProxy {
            scheme: "http".to_owned(),
            host: "1.2.3.4".to_owned(),
            port: 8080,
            username: Some("user\"name".to_owned()),
            password: Some("p@ss:word".to_owned()),
        };
        let profile_id = format!(
            "proxy-ext-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or(0)
        );
        let ext_path = generate_proxy_auth_extension(&profile_id, &resolved).expect("generate");
        assert!(std::path::Path::new(&ext_path).join("manifest.json").is_file());
        let background = std::fs::read_to_string(std::path::Path::new(&ext_path).join("background.js"))
            .expect("read background");
        assert!(background.contains(r#"username: "user\"name""#));
        assert!(background.contains(r#"password: "p@ss:word""#));
        assert!(
            ext_path.contains("ai-browser-proxy-auth"),
            "extension must live under temp ai-browser-proxy-auth: {ext_path}"
        );

        purge_proxy_auth_extension(&profile_id);
    }
}
