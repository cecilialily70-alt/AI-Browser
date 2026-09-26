export interface ParsedProxyLine {
  type: "HTTP" | "SOCKS5";
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export type ParsedProxy = ParsedProxyLine;

export function parseProxyString(raw: string): ParsedProxyLine | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let scheme: "HTTP" | "SOCKS5" = "HTTP";
  let rest = trimmed;

  const schemeSplit = trimmed.match(/^([a-zA-Z0-9]+):\/\/(.+)$/);
  if (schemeSplit) {
    scheme = schemeSplit[1].toUpperCase() === "SOCKS5" ? "SOCKS5" : "HTTP";
    rest = schemeSplit[2];
  }

  if (rest.includes("@")) {
    const at = rest.lastIndexOf("@");
    const userinfo = rest.slice(0, at);
    const hostpart = rest.slice(at + 1);
    const colon = userinfo.indexOf(":");
    const username = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    const password = colon >= 0 ? userinfo.slice(colon + 1) : null;
    const hostPort = parseHostPort(hostpart);
    if (!hostPort) {
      return null;
    }
    return {
      type: scheme,
      host: hostPort.host,
      port: hostPort.port,
      username: username || null,
      password,
    };
  }

  const parts = rest.split(":").map((part) => part.trim());
  if (parts.length === 2) {
    const port = Number(parts[1]);
    if (!parts[0] || !Number.isFinite(port)) {
      return null;
    }
    return { type: scheme, host: parts[0], port, username: null, password: null };
  }
  if (parts.length >= 4) {
    const port = Number(parts[1]);
    if (!parts[0] || !Number.isFinite(port)) {
      return null;
    }
    return {
      type: scheme,
      host: parts[0],
      port,
      username: parts[2] || null,
      password: parts.slice(3).join(":") || null,
    };
  }

  return null;
}

/** 从 SQLite 存的 JSON 或用户纯文本还原为结构化代理 */
export function parseStoredCustomProxy(stored: string): ParsedProxyLine | null {
  const trimmed = stored.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as {
        type?: string;
        host?: string;
        port?: number;
        username?: string | null;
        password?: string | null;
      };
      if (!json.host || !json.port) {
        return null;
      }
      return {
        type: json.type?.toUpperCase() === "SOCKS5" ? "SOCKS5" : "HTTP",
        host: json.host,
        port: json.port,
        username: json.username ?? null,
        password: json.password ?? null,
      };
    } catch {
      return null;
    }
  }
  return parseProxyString(trimmed);
}

/** 提交给后端的纯文本格式（非 JSON） */
export function formatProxyLine(parsed: ParsedProxyLine): string {
  if (parsed.username) {
    return `${parsed.host}:${parsed.port}:${parsed.username}:${parsed.password ?? ""}`;
  }
  return `${parsed.host}:${parsed.port}`;
}

/** 连通性测试用完整 URL */
export function formatProxyForTest(parsed: ParsedProxyLine): string {
  const scheme = parsed.type === "SOCKS5" ? "socks5" : "http";
  if (parsed.username) {
    return `${scheme}://${parsed.username}:${parsed.password ?? ""}@${parsed.host}:${parsed.port}`;
  }
  return `${scheme}://${parsed.host}:${parsed.port}`;
}

function parseHostPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) {
    return null;
  }
  const host = trimmed.slice(0, colon);
  const port = Number(trimmed.slice(colon + 1));
  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port };
}

export function parseBatchProxyLines(raw: string, proxyType: ParsedProxyLine["type"]): ParsedProxyLine[] {
  const proxies: ParsedProxyLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const parsed = parseProxyString(trimmed);
    if (!parsed) {
      continue;
    }
    proxies.push({
      ...parsed,
      type: trimmed.includes("://") ? parsed.type : proxyType,
    });
  }
  return proxies;
}

export function applyRegionToApiUrl(baseUrl: string, region: string): string {
  const trimmed = baseUrl.trim();
  const normalizedRegion = region.trim().toLowerCase();
  if (!normalizedRegion) {
    return trimmed;
  }
  if (trimmed.includes("region=")) {
    return trimmed.replace(/region=[^&]*/i, `region=${normalizedRegion}`);
  }
  return trimmed.includes("?")
    ? `${trimmed}&region=${normalizedRegion}`
    : `${trimmed}?region=${normalizedRegion}`;
}

export const PROXY_REGION_OPTIONS = [
  { value: "hk", label: "HK - 香港" },
  { value: "us", label: "US - 美国" },
  { value: "tw", label: "TW - 台湾" },
  { value: "jp", label: "JP - 日本" },
  { value: "sg", label: "SG - 新加坡" },
] as const;

export function profileHasProxy(profile: { proxy_id: number | null; custom_proxy?: string | null }): boolean {
  return profile.proxy_id != null || Boolean(profile.custom_proxy && profile.custom_proxy.trim().length > 0);
}
