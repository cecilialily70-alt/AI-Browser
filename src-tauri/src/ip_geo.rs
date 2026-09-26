use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::models::ProfileIpGeo;
use crate::proxy::{self, ResolvedProxy};

/// 代理环境同步缓存 TTL：24 小时
const PROXY_ENV_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// 代理出口 IP 环境同步包：注入 CloakBrowser timezone/locale/geolocation/WebRTC
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEnvSync {
    pub exit_ip: String,
    pub timezone: String,
    pub locale: String,
    pub latitude: f64,
    pub longitude: f64,
    pub country_code: String,
    pub country: String,
    /// 省/州/行政区（与出口 IP 同城绑定，供人设造境）
    #[serde(default)]
    pub region: String,
    /// 城市（与出口 IP 同城绑定，供人设造境）
    #[serde(default)]
    pub city: String,
}

#[derive(Debug, Clone)]
struct ProxyEnvCacheEntry {
    env: ProxyEnvSync,
    fetched_at: Instant,
}

#[derive(Debug, Deserialize)]
struct IpApiResponse {
    status: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(default, rename = "countryCode")]
    country_code: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    lat: Option<f64>,
    #[serde(default)]
    lon: Option<f64>,
    #[serde(default, rename = "regionName")]
    region_name: Option<String>,
    #[serde(default)]
    city: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpWhoisResponse {
    success: bool,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    ip: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(default, rename = "country_code")]
    country_code: Option<String>,
    #[serde(default)]
    timezone: Option<IpWhoisTimezone>,
    #[serde(default)]
    latitude: Option<f64>,
    #[serde(default)]
    longitude: Option<f64>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    city: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpWhoisTimezone {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Clone)]
struct GeoLookupResult {
    ip: String,
    country: String,
    country_code: String,
    timezone: String,
    latitude: f64,
    longitude: f64,
    region: String,
    city: String,
}

fn geo_http_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| AppError::Launcher(error.to_string()))
}
fn proxy_env_cache() -> &'static RwLock<HashMap<String, ProxyEnvCacheEntry>> {
    static CACHE: OnceLock<RwLock<HashMap<String, ProxyEnvCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// 按权重随机选取 locale（多语种国家指纹分布）
fn pick_weighted_locale(options: &[(&str, u32)]) -> String {
    let total: u32 = options.iter().map(|(_, weight)| *weight).sum();
    if total == 0 {
        return options
            .first()
            .map(|(locale, _)| (*locale).to_owned())
            .unwrap_or_else(|| "en-US".to_owned());
    }
    let mut roll = rand::rng().random_range(0..total);
    for (locale, weight) in options {
        if roll < *weight {
            return (*locale).to_owned();
        }
        roll -= *weight;
    }
    options[0].0.to_owned()
}

/// ISO 3166-1 alpha-2 → BCP 47 locale。
/// 多语种国家使用权重随机，避免所有环境都落到单一语种导致指纹同质化。
pub fn locale_from_country_code(country_code: &str) -> String {
    match country_code.trim().to_ascii_uppercase().as_str() {
        // 多语种：权重分配
        "US" => pick_weighted_locale(&[("en-US", 80), ("es-US", 20)]),
        "CA" => pick_weighted_locale(&[("en-CA", 75), ("fr-CA", 25)]),
        "CH" => pick_weighted_locale(&[("de-CH", 60), ("fr-CH", 20), ("it-CH", 10)]),
        "BE" => pick_weighted_locale(&[("nl-BE", 55), ("fr-BE", 40), ("de-BE", 5)]),
        // 单语种主语言
        "GB" | "UK" => "en-GB".to_owned(),
        "AU" => "en-AU".to_owned(),
        "NZ" => "en-NZ".to_owned(),
        "IE" => "en-IE".to_owned(),
        "CN" => "zh-CN".to_owned(),
        "HK" => "zh-HK".to_owned(),
        "TW" => "zh-TW".to_owned(),
        "JP" => "ja-JP".to_owned(),
        "KR" => "ko-KR".to_owned(),
        "DE" => "de-DE".to_owned(),
        "AT" => "de-AT".to_owned(),
        "FR" => "fr-FR".to_owned(),
        "ES" => "es-ES".to_owned(),
        "MX" => "es-MX".to_owned(),
        "IT" => "it-IT".to_owned(),
        "PT" => "pt-PT".to_owned(),
        "BR" => "pt-BR".to_owned(),
        "NL" => "nl-NL".to_owned(),
        "PL" => "pl-PL".to_owned(),
        "RU" => "ru-RU".to_owned(),
        "TR" => "tr-TR".to_owned(),
        "IN" => "en-IN".to_owned(),
        "SG" => "en-SG".to_owned(),
        "SE" => "sv-SE".to_owned(),
        "NO" => "nb-NO".to_owned(),
        "DK" => "da-DK".to_owned(),
        "FI" => "fi-FI".to_owned(),
        "TH" => "th-TH".to_owned(),
        "VN" => "vi-VN".to_owned(),
        "ID" => "id-ID".to_owned(),
        "PH" => "en-PH".to_owned(),
        "AE" => "ar-AE".to_owned(),
        "SA" => "ar-SA".to_owned(),
        other if other.len() == 2 => format!("en-{other}"),
        _ => "en-US".to_owned(),
    }
}

async fn fetch_ip_api_full(ip: &str) -> Result<IpApiResponse, AppError> {
    let client = geo_http_client()?;
    let url = format!(
        "http://ip-api.com/json/{ip}?fields=status,message,country,countryCode,query,timezone,lat,lon,regionName,city&lang=zh-CN"
    );
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::Launcher(format!("ip-api 请求失败: {error}")))?;

    if !response.status().is_success() {
        return Err(AppError::Launcher(format!(
            "ip-api 返回 {}",
            response.status()
        )));
    }

    let parsed: IpApiResponse = response
        .json()
        .await
        .map_err(|error| AppError::Launcher(format!("ip-api 解析失败: {error}")))?;

    if parsed.status != "success" {
        let message = parsed
            .message
            .unwrap_or_else(|| format!("ip-api status={}", parsed.status));
        return Err(AppError::Launcher(message));
    }

    Ok(parsed)
}

async fn fetch_ipwhois(ip: &str) -> Result<GeoLookupResult, AppError> {
    let client = geo_http_client()?;
    let url = if ip.trim().is_empty() {
        "https://ipwho.is/".to_owned()
    } else {
        format!("https://ipwho.is/{}", ip.trim())
    };
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::Launcher(format!("ipwho.is 请求失败: {error}")))?;

    if !response.status().is_success() {
        return Err(AppError::Launcher(format!(
            "ipwho.is 返回 {}",
            response.status()
        )));
    }

    let parsed: IpWhoisResponse = response
        .json()
        .await
        .map_err(|error| AppError::Launcher(format!("ipwho.is 解析失败: {error}")))?;

    if !parsed.success {
        let message = parsed.message.unwrap_or_else(|| "ipwho.is lookup failed".to_owned());
        return Err(AppError::Launcher(message));
    }

    let query_ip = parsed
        .ip
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ip.trim().to_owned());
    let country_code = parsed
        .country_code
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "--".to_owned());
    let country = parsed
        .country
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "未知".to_owned());
    let timezone = parsed
        .timezone
        .and_then(|entry| entry.id)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "UTC".to_owned());

    Ok(GeoLookupResult {
        ip: query_ip,
        country,
        country_code,
        timezone,
        latitude: parsed.latitude.unwrap_or(0.0),
        longitude: parsed.longitude.unwrap_or(0.0),
        region: parsed
            .region
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default(),
        city: parsed
            .city
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default(),
    })
}

fn geo_from_ip_api(parsed: IpApiResponse, fallback_ip: &str) -> GeoLookupResult {
    let country_code = parsed
        .country_code
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "--".to_owned());
    GeoLookupResult {
        ip: parsed
            .query
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| fallback_ip.to_owned()),
        country: parsed
            .country
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "未知".to_owned()),
        country_code: country_code.clone(),
        timezone: parsed
            .timezone
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "UTC".to_owned()),
        latitude: parsed.lat.unwrap_or(0.0),
        longitude: parsed.lon.unwrap_or(0.0),
        region: parsed
            .region_name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default(),
        city: parsed
            .city
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default(),
    }
}

/// 免费 API 链：ip-api（中文国家名）→ ipwho.is（HTTPS 备用）。时区与国家同源，供 CloakBrowser 注入。
async fn lookup_geo_for_ip(ip: &str) -> Result<GeoLookupResult, AppError> {
    let ip = ip.trim();
    if let Ok(parsed) = fetch_ip_api_full(ip).await {
        let has_timezone = parsed
            .timezone
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if has_timezone {
            return Ok(geo_from_ip_api(parsed, ip));
        }
    }
    fetch_ipwhois(ip).await
}

fn proxy_env_from_geo(geo: GeoLookupResult) -> ProxyEnvSync {
    ProxyEnvSync {
        exit_ip: geo.ip,
        timezone: geo.timezone,
        locale: locale_from_country_code(&geo.country_code),
        latitude: geo.latitude,
        longitude: geo.longitude,
        country_code: geo.country_code,
        country: geo.country,
        region: geo.region,
        city: geo.city,
    }
}
/// 根据出口 IP 组装浏览器环境同步参数（国家/时区均来自免费 API）。
/// `cache_key` 建议为代理 `host:port`，命中且未过期（24h）则跳过外部 HTTP。
pub async fn lookup_proxy_env_sync(cache_key: &str, exit_ip: &str) -> Result<ProxyEnvSync, AppError> {
    let exit_ip = exit_ip.trim();
    if exit_ip.is_empty() {
        return Err(AppError::Validation("exit IP cannot be empty".to_owned()));
    }

    let key = cache_key.trim().to_owned();
    if !key.is_empty() {
        if let Ok(guard) = proxy_env_cache().read() {
            if let Some(entry) = guard.get(&key) {
                if entry.fetched_at.elapsed() < PROXY_ENV_CACHE_TTL
                    && entry.env.exit_ip.trim() == exit_ip
                {
                    return Ok(entry.env.clone());
                }
            }
        }
    }

    let env = proxy_env_from_geo(lookup_geo_for_ip(exit_ip).await?);

    if !key.is_empty() {
        if let Ok(mut guard) = proxy_env_cache().write() {
            guard.insert(
                key,
                ProxyEnvCacheEntry {
                    env: env.clone(),
                    fetched_at: Instant::now(),
                },
            );
        }
    }

    Ok(env)
}

/// 缓存键必须区分同一 host:port 下的不同账密/会话（住宅代理 sticky session），
/// 否则多环境并发启动会把 timezone/locale/exitIp 元数据串到错误环境。
fn proxy_env_cache_key(resolved: &ResolvedProxy) -> String {
    let user = resolved
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    if user.is_empty() {
        format!("{}:{}", resolved.host, resolved.port)
    } else {
        format!("{}:{}|u={}", resolved.host, resolved.port, user)
    }
}

/// 启动前：代理隧道 ipify 出口 IP + 免费 API 国家/时区（写入 CloakBrowser proxyEnv）。
pub async fn resolve_proxy_egress_env(resolved: &ResolvedProxy) -> Result<ProxyEnvSync, AppError> {
    let cache_key = proxy_env_cache_key(resolved);
    let exit_ip = proxy::resolve_egress_ip(resolved).await.map_err(|error| {
        AppError::Launcher(format!("代理出口 IP 解析失败: {error}"))
    })?;
    lookup_proxy_env_sync(&cache_key, &exit_ip).await
}

pub fn profile_ip_geo_from_env(profile_id: &str, env: &ProxyEnvSync) -> ProfileIpGeo {
    ProfileIpGeo {
        profile_id: profile_id.to_owned(),
        ip: Some(env.exit_ip.clone()),
        country: Some(env.country.clone()),
        country_code: Some(env.country_code.clone()),
        region: Some(env.region.clone()).filter(|value| !value.trim().is_empty()),
        city: Some(env.city.clone()).filter(|value| !value.trim().is_empty()),
        status: "ok".to_owned(),
        message: None,
    }
}

/// 无代理时按本机公网出口 IP 同步时区/语言/经纬度。
pub async fn lookup_direct_env_sync() -> Result<ProxyEnvSync, AppError> {
    let geo = lookup_geo_for_ip("").await?;
    lookup_proxy_env_sync("direct-egress", &geo.ip).await
}

/// 操作栏「启动」统一入口：有代理走隧道 ipify，无代理走公网 IP；国家/时区均来自免费 API。
pub async fn resolve_profile_launch_env(
    resolved_proxy: Option<&ResolvedProxy>,
    use_geoip: bool,
) -> Result<Option<ProxyEnvSync>, AppError> {
    if let Some(resolved) = resolved_proxy {
        Ok(Some(resolve_proxy_egress_env(resolved).await?))
    } else if use_geoip {
        lookup_direct_env_sync().await.map(Some)
    } else {
        Ok(None)
    }
}
