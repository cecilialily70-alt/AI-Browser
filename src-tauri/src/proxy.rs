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

/// 从 API 链接读出已有的 `region` 参数（多数提取链接本身已带地区）。
pub fn extract_region_from_api_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let idx = lower.find("region=")?;
    // 要求前面是 ? 或 &，避免误匹配其它参数名
    if idx > 0 {
        let prev = trimmed.as_bytes().get(idx - 1).copied()?;
        if prev != b'?' && prev != b'&' {
            return None;
        }
    }
    let value_start = idx + "region=".len();
    let raw = &trimmed[value_start..];
    let value = raw.split_once('&').map(|(v, _)| v).unwrap_or(raw).trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

/// 把地区写进 API 链接。
/// 链接已含 `region=` 时原样保留（不覆盖），仅在没有地区参数时才追加所选地区。
pub fn apply_region_to_api_url(base_url: &str, region: &str) -> String {
    let trimmed = base_url.trim();
    if extract_region_from_api_url(trimmed).is_some() {
        return trimmed.to_owned();
    }

    let region = region.trim().to_ascii_lowercase();
    if region.is_empty() {
        return trimmed.to_owned();
    }

    if trimmed.contains('?') {
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
    // canonicalize 在 Windows 会加 `\\?\`；`--load-extension` 必须用普通路径
    Ok(crate::extension_paths::strip_windows_verbatim_prefix(canonical)
        .to_string_lossy()
        .into_owned())
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

/// 经代理隧道查询出口 IP 的探测站。ipify 单独失败很常见（HTTPS 隧道被拒、站点被拦），
/// 先走不加密的查询，再换 HTTPS。任一返回公网 IP 即成功。
const EGRESS_PROBES: &[(&str, EgressBodyKind)] = &[
    ("http://ip-api.com/json/?fields=status,query", EgressBodyKind::JsonQuery),
    ("http://checkip.amazonaws.com", EgressBodyKind::Plain),
    ("https://api.ipify.org?format=json", EgressBodyKind::JsonIp),
    ("https://icanhazip.com", EgressBodyKind::Plain),
];

#[derive(Clone, Copy)]
enum EgressBodyKind {
    /// `{"ip":"1.2.3.4"}`
    JsonIp,
    /// `{"status":"success","query":"1.2.3.4"}`
    JsonQuery,
    /// 纯文本一行 IP
    Plain,
}

fn reqwest_err_brief(error: &reqwest::Error) -> String {
    let mut parts = Vec::new();
    let mut current: Option<&dyn std::error::Error> = Some(error);
    while let Some(err) = current {
        let text = err.to_string();
        if !parts.iter().any(|item: &String| item == &text) {
            parts.push(text);
        }
        current = err.source();
        if parts.len() >= 3 {
            break;
        }
    }
    let joined = parts.join(" → ");
    if joined.chars().count() > 180 {
        joined.chars().take(180).collect()
    } else {
        joined
    }
}

/// 只接受公网 IP。内网、回环、空串和网页都不当出口。
fn accept_public_ip(raw: &str) -> Option<String> {
    let ip: std::net::IpAddr = raw.trim().parse().ok()?;
    let public = match ip {
        std::net::IpAddr::V4(v4) => {
            !v4.is_private()
                && !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_broadcast()
                && !v4.is_unspecified()
        }
        std::net::IpAddr::V6(v6) => !v6.is_loopback() && !v6.is_unspecified(),
    };
    if public { Some(ip.to_string()) } else { None }
}

fn parse_egress_ip(body: &str, kind: EgressBodyKind) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() || trimmed.len() > 4000 || trimmed.starts_with('<') {
        return None;
    }
    let raw = match kind {
        EgressBodyKind::Plain => trimmed.lines().next().unwrap_or("").trim().to_owned(),
        EgressBodyKind::JsonIp => {
            let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
            value.get("ip")?.as_str()?.trim().to_owned()
        }
        EgressBodyKind::JsonQuery => {
            let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
            if value.get("status").and_then(|item| item.as_str()) != Some("success") {
                return None;
            }
            value.get("query")?.as_str()?.trim().to_owned()
        }
    };
    accept_public_ip(&raw)
}

fn egress_failure_is_tunnel(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("sending request")
        || lower.contains("timed out")
        || lower.contains("connect")
        || lower.contains("tunnel")
        || lower.contains("407")
        || lower.contains("proxy")
}

pub async fn resolve_egress_ip(resolved: &ResolvedProxy) -> Result<String, AppError> {
    let client = reqwest::Client::builder()
        .proxy(build_reqwest_proxy(resolved)?)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| AppError::FraudCheck(error.to_string()))?;

    let mut failures: Vec<String> = Vec::new();
    for (url, kind) in EGRESS_PROBES {
        match client.get(*url).send().await {
            Ok(response) if response.status().is_success() => {
                match response.text().await {
                    Ok(body) => {
                        if let Some(ip) = parse_egress_ip(&body, *kind) {
                            if !failures.is_empty() {
                                log_warn!(
                                    "出口 IP 改用备用查询站成功 proxy={}:{} via={url}",
                                    resolved.host,
                                    resolved.port
                                );
                            }
                            return Ok(ip);
                        }
                        failures.push(format!("{url}: 响应里没有公网 IP"));
                    }
                    Err(error) => failures.push(format!("{url}: {}", reqwest_err_brief(&error))),
                }
            }
            Ok(response) => failures.push(format!("{url}: HTTP {}", response.status())),
            Err(error) => failures.push(format!("{url}: {}", reqwest_err_brief(&error))),
        }
    }

    let detail = failures
        .iter()
        .map(|item| item.as_str())
        .collect::<Vec<_>>()
        .join("；");
    let hint = if failures.iter().all(|item| egress_failure_is_tunnel(item)) {
        "。代理隧道没有连上查询站，请核对协议是 HTTP 还是 SOCKS5、白名单是否包含本机，以及账号密码"
    } else {
        ""
    };
    Err(AppError::FraudCheck(format!(
        "proxy egress lookup failed: {detail}{hint}"
    )))
}

/// 提取接口直接返回的 `IP:端口`（白名单网关）本身就是出口地址。
/// 查询站被代理屏蔽（403 / 隧道失败）时，用这个 IP 继续对齐时区，不再拦启动。
/// 域名网关（如 us.novproxy.io）不能这么用，因为连上的机器不是出口。
pub fn proxy_host_as_egress(resolved: &ResolvedProxy) -> Option<String> {
    accept_public_ip(&resolved.host)
}

pub async fn test_resolved_proxy(resolved: &ResolvedProxy) -> Result<String, AppError> {
    let egress_ip = resolve_egress_ip(resolved).await?;
    Ok(format!(
        "proxy ok via {} (egress: {{\"ip\":\"{}\"}})",
        resolved.chromium_proxy_flag(),
        egress_ip
    ))
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
    fn preserves_existing_region_in_api_url() {
        let url = apply_region_to_api_url(
            "https://white.novproxy.com/white/api?region=IL&num=1&time=10&format=1&type=txt",
            "hk",
        );
        assert!(url.contains("region=IL"));
        assert!(!url.contains("region=hk"));
        assert_eq!(
            extract_region_from_api_url(&url).as_deref(),
            Some("IL")
        );
    }

    #[test]
    fn empty_region_leaves_url_unchanged() {
        let raw = "https://provider.example.com/get?key=abc";
        assert_eq!(apply_region_to_api_url(raw, ""), raw);
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
        assert!(
            !ext_path.starts_with(r"\\?\"),
            "proxy auth extension path must not keep Windows verbatim prefix: {ext_path}"
        );
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

    #[test]
    fn parses_egress_bodies_and_rejects_private_or_html() {
        assert_eq!(
            parse_egress_ip(r#"{"ip":"8.8.8.8"}"#, EgressBodyKind::JsonIp).as_deref(),
            Some("8.8.8.8")
        );
        assert_eq!(
            parse_egress_ip(
                r#"{"status":"success","query":"1.1.1.1"}"#,
                EgressBodyKind::JsonQuery
            )
            .as_deref(),
            Some("1.1.1.1")
        );
        assert_eq!(
            parse_egress_ip("203.0.113.9\n", EgressBodyKind::Plain).as_deref(),
            Some("203.0.113.9")
        );
        assert!(parse_egress_ip(r#"{"ip":"192.168.1.1"}"#, EgressBodyKind::JsonIp).is_none());
        assert!(parse_egress_ip(r#"{"status":"fail","query":"8.8.8.8"}"#, EgressBodyKind::JsonQuery).is_none());
        assert!(parse_egress_ip("<html>8.8.8.8</html>", EgressBodyKind::Plain).is_none());
        assert!(parse_egress_ip("", EgressBodyKind::Plain).is_none());
    }

    #[test]
    fn whitelist_proxy_ip_can_stand_in_as_egress() {
        let resolved = ResolvedProxy {
            scheme: "http".to_owned(),
            host: "198.44.167.198".to_owned(),
            port: 20451,
            username: None,
            password: None,
        };
        assert_eq!(
            proxy_host_as_egress(&resolved).as_deref(),
            Some("198.44.167.198")
        );
        let gateway = ResolvedProxy {
            host: "us.novproxy.io".to_owned(),
            ..resolved
        };
        assert!(proxy_host_as_egress(&gateway).is_none());
    }
}
