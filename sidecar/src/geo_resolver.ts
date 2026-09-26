import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface GeoResolveInput {
  proxyUrl?: string | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
}

export interface GeoResolveResult {
  exitIp: string;
  timezone: string;
  locale: string;
}

/** 抢在 Rust 120s 硬杀之前失败，避免启动假死 */
export const GEO_RESOLVE_TIMEOUT_MS = 15_000;

function geoipModuleUrl(): string {
  return pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/cloakbrowser/dist/geoip.js"),
  ).href;
}

function proxyModuleUrl(): string {
  return pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/cloakbrowser/dist/proxy.js"),
  ).href;
}

export async function buildCloakProxyUrl(input: GeoResolveInput): Promise<string | null> {
  const server = input.proxyUrl?.trim();
  if (!server) {
    return null;
  }

  const username = input.proxyUsername?.trim();
  const { ensureProxyScheme, isSocksProxy, reconstructHttpUrl, reconstructSocksUrl } = await import(
    proxyModuleUrl()
  );

  if (username) {
    const proxy = {
      server,
      username,
      password: input.proxyPassword ?? "",
    };
    return isSocksProxy(proxy) ? reconstructSocksUrl(proxy) : reconstructHttpUrl(proxy);
  }

  return ensureProxyScheme(server);
}

export async function resolveGeoViaCloakBrowser(input: GeoResolveInput): Promise<GeoResolveResult> {
  const { resolveProxyGeo } = await import(geoipModuleUrl());
  const proxyUrl = await buildCloakProxyUrl(input);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const geo = await Promise.race([
      resolveProxyGeo(proxyUrl),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `代理 GeoIP 解析超时（${GEO_RESOLVE_TIMEOUT_MS / 1000}s）。请检查代理出口或网络后重试。`,
            ),
          );
        }, GEO_RESOLVE_TIMEOUT_MS);
      }),
    ]);

    const exitIp = geo.exitIp?.trim();
    const timezone = geo.timezone?.trim();
    const locale = geo.locale?.trim();

    if (!exitIp || !timezone || !locale) {
      throw new Error("CloakBrowser GeoIP 解析不完整（缺少 exitIp/timezone/locale）");
    }

    return { exitIp, timezone, locale };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
