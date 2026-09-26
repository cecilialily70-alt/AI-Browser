import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { resolveGeoViaCloakBrowser } from "./geo_resolver.js";

import {
  binaryInfo,
  launchPersistentContext,
} from "cloakbrowser";
import type { BrowserContext } from "playwright-core";

import { HUMAN_MOUSE_CONFIG, HUMAN_PRESET, loadCloakExtras } from "./cloakbrowser_extra.js";
import { ensureBinaryHonoringVersionPin } from "./ensure_binary_pin.js";
import {
  applyBrowserDownloadDir,
  guardBrowserDownloadDir,
  installDownloadAutoSave,
} from "./download_autosave.js";
import { configureDownloadRoots, getResolvedDownloadPath } from "./utils/file_manager.js";

import type { GpuLaunchPlan, ProfileWebglMode } from "./gpu_fingerprint.js";
import {
  buildGpuLaunchPlan,
  isNativeAngleRenderer,
  rendererMatchesLocalGpu,
} from "./gpu_fingerprint.js";
import {
  applyLicenseEnv,
  decideEffectiveLicenseKey,
  isBuiltinFreeLicenseKey,
  resolveBrowserVersionPin,
  resolveEffectiveLicenseKey,
  resolveReleaseChannel,
  type EffectiveLicenseKey,
  type ReleaseChannel,
  type ResolvedLicense,
} from "./license_resolver.js";
import type { JsonLogger } from "./json-logger.js";
import { safeGoto } from "./cdp_session.js";
import {
  DEFAULT_HOMEPAGE_URL,
  sanitizeProfileExitState,
} from "./profile_exit_state.js";
import { applyProfileWindowMarker } from "./profile_window_marker.js";

const cloakExtrasPromise = loadCloakExtras().catch(() => null);

/**
 * 决定本次启动实际注入浏览器的 License Key。
 *
 * - 用户没配 Key → 内置免费 Key（不查席位，没有用户 Key 可查）；
 * - 用户配了 Key → 查席位，已满则改用内置免费 Key，否则用用户自己的。
 *
 * 只有「用户自己的 Key」才会触发网络查询，内置 Key 的全局共享席位计数不作为本机占用判据。
 *
 * @see https://github.com/CloakHQ/CloakBrowser/issues/477
 */
async function resolveEffectiveLaunchKey(input: {
  configuredKey?: string;
  profileId: string;
  logger: JsonLogger;
}): Promise<EffectiveLicenseKey> {
  const configured = input.configuredKey?.trim() ?? "";
  if (!configured || isBuiltinFreeLicenseKey(configured)) {
    return decideEffectiveLicenseKey(configured, null);
  }

  const extras = await cloakExtrasPromise;
  if (!extras?.getSessionSeats) {
    return { key: configured, reason: "configured" };
  }

  let seats: Awaited<ReturnType<typeof extras.getSessionSeats>>;
  try {
    seats = await extras.getSessionSeats(configured);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.logger.warn("session_seats_query_failed", {
      profileId: input.profileId,
      error: message,
    });
    return { key: configured, reason: "configured" };
  }

  if (seats.state === "unreachable") {
    input.logger.warn("session_seats_unreachable", {
      profileId: input.profileId,
      reason: seats.reason,
    });
    return { key: configured, reason: "configured" };
  }

  const decision = decideEffectiveLicenseKey(configured, {
    active: seats.active,
    limit: seats.limit,
  });

  if (decision.reason === "configured") {
    input.logger.progress("session_seats_ok", {
      profileId: input.profileId,
      active: seats.active,
      limit: seats.limit,
      state: seats.state,
    });
    return decision;
  }

  // 用户 Key 席位已满：改用内置免费 Key 打开，而不是让环境启动失败。
  // 同步进程环境，避免内核子进程仍继承到已满席位的旧 Key。
  input.logger.warn("license_seat_exhausted_fallback_free", {
    profileId: input.profileId,
    active: seats.active,
    limit: seats.limit,
    reason: seats.reason,
  });
  applyLicenseEnv(decision.key);
  return decision;
}

export type StealthPreset = "default" | "fpjs_bypass";

export const PENDING_COOKIES_FILENAME = "ai-browser-pending-cookies.json";

const FORBIDDEN_DESKTOP_LAUNCH_ARGS = new Set([
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
]);

const IGNORE_AUTOMATION_DEFAULT_ARGS = [
  "--enable-automation",
  "--enable-unsafe-swiftshader",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-component-extensions-with-background-pages",
  "--disable-features=Translate,OptimizationHints,MediaRouter",
];

const FORBIDDEN_BANNER_ARG_PATTERNS = [/AutomationControlled/i];

/**
 * CDP 调试 Origin 白名单（禁止 `*`）。
 * 绑定已在 `--remote-debugging-address=127.0.0.1`；此处再按端口收紧 Origin，
 * 防止本机其它页面/恶意扩展通过 WebSocket 劫持调试端口。
 */
export function buildRemoteAllowOriginsArg(cdpPort: number): string {
  const port = Number.isFinite(cdpPort) && cdpPort > 0 ? Math.floor(cdpPort) : 0;
  const origins = [
    port > 0 ? `http://127.0.0.1:${port}` : "http://127.0.0.1",
    port > 0 ? `http://localhost:${port}` : "http://localhost",
    // Playwright/CDP 客户端偶发 Origin: null
    "null",
    // Tauri WebView
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ];
  return `--remote-allow-origins=${origins.join(",")}`;
}

export interface ProxyEnvSync {
  exitIp: string;
  timezone: string;
  locale: string;
  latitude: number;
  longitude: number;
  countryCode?: string;
  country?: string;
}

export interface ProfileLaunchConfig {
  profileId: string;
  userDataDir: string;
  cdpPort: number;
  proxyUrl?: string | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
  useGeoip: boolean;
  humanize: boolean;
  fingerprintSeed: string;
  stealthPreset: StealthPreset;
  extensionPaths?: string[];
  licenseKey?: string | null;
  browserVersion?: string | null;
  proxyEnv?: ProxyEnvSync | null;
  interactiveElementExtractEnabled?: boolean;
  webglMode?: ProfileWebglMode | null;
  themeColor?: string | null;
  gpuLaunch?: GpuLaunchPlan;
  /** Absolute root for conventional browser downloads (profileId subdir added at runtime). */
  browserDownloadDir?: string | null;
  /** Absolute root for scraper / AI media downloads. */
  scraperDownloadDir?: string | null;
  /** Route the Pro license check through the browser proxy (--license-through-proxy). */
  licenseThroughProxy?: boolean;
  /** Allow third-party cookies for embedded login/payment/reCAPTCHA (--fingerprint-allow-3p-cookies). */
  allowThirdPartyCookies?: boolean;
  /** Windows-only debug: disable all spoofing and expose the real fingerprint (--fingerprint=off). */
  fingerprintOff?: boolean;
  /** 额外启动网址（首位永远强制 BrowserScan，由引擎拼接） */
  startupUrls?: string[] | null;
  /** Portable/dev: absolute Browse/ root containing chromium-151…-pro for offline seed */
  bundledBrowseRoot?: string | null;
  /** 用户按版本 pin 自定义的 chrome.exe 路径（命中即跳过下载；文件缺失直接报错）。 */
  kernelPaths?: Record<string, string> | null;
  /** 全局浏览器路径（cloak_path）；自动版本环境兜底使用。 */
  globalBrowserPath?: string | null;
}

function stripForbiddenLaunchArgs(args: string[]): string[] {
  return args.filter((arg) => {
    const key = arg.split("=")[0]?.trim();
    if (!key || FORBIDDEN_DESKTOP_LAUNCH_ARGS.has(key)) {
      return false;
    }
    if (FORBIDDEN_BANNER_ARG_PATTERNS.some((pattern) => pattern.test(arg))) {
      return false;
    }
    return true;
  });
}

function defaultFingerprintPlatform(): string {
  if (process.platform === "darwin") {
    return "macos";
  }
  return "windows";
}

export function deriveHardwareFromSeed(seed: string): { cores: number; memoryGb: number } {
  const parsed = Number.parseInt(String(seed).trim(), 10);
  const safe = Number.isFinite(parsed) ? Math.abs(parsed) : 42069;
  const coreChoices = [4, 6, 8, 8, 12, 16];
  const memChoices = [4, 8, 8, 8, 16, 16];
  return {
    cores: coreChoices[safe % coreChoices.length]!,
    memoryGb: memChoices[Math.floor(safe / 7) % memChoices.length]!,
  };
}

export function buildStealthArgs(config: ProfileLaunchConfig): string[] {
  // Windows-only debug: --fingerprint=off disables all spoofing. Keep CDP
  // connectivity args but drop fingerprint/hardware/GPU spoofing flags so the
  // browser exposes the real machine fingerprint (per CloakBrowser Pro guide).
  if (config.fingerprintOff) {
    return [
      "--fingerprint=off",
      `--remote-debugging-port=${config.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      buildRemoteAllowOriginsArg(config.cdpPort),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
    ];
  }

  const hardware = deriveHardwareFromSeed(config.fingerprintSeed);
  const gpuArgs = config.gpuLaunch?.args ?? [];
  const args = [
    `--fingerprint=${config.fingerprintSeed}`,
    `--fingerprint-platform=${defaultFingerprintPlatform()}`,
    `--fingerprint-hardware-concurrency=${hardware.cores}`,
    `--fingerprint-device-memory=${hardware.memoryGb}`,
    ...gpuArgs,
    `--remote-debugging-port=${config.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    buildRemoteAllowOriginsArg(config.cdpPort),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--fingerprint-noise=false",
    "--fingerprint-storage-quota=10000",
  ];

  if (config.stealthPreset === "fpjs_bypass") {
    args.push("--fingerprint-windows-font-metrics");
  }

  return stripForbiddenLaunchArgs(args);
}

function proxyConfigured(
  proxy: ProfileLaunchConfig["proxyUrl"] | ReturnType<typeof resolveProxyOption>,
): boolean {
  if (!proxy) {
    return false;
  }
  if (typeof proxy === "string") {
    return proxy.trim().length > 0;
  }
  return Boolean(proxy.server?.trim());
}

async function resolveLaunchGeo(
  proxy: ProfileLaunchConfig["proxyUrl"] | ReturnType<typeof resolveProxyOption>,
  proxyEnv: ProxyEnvSync | null | undefined,
): Promise<{
  timezone: string;
  locale: string;
  exitIp: string;
  source: "free_api_prequery" | "geoip";
}> {
  const hasProxy = proxyConfigured(proxy);
  const fromEnv = proxyEnv?.timezone?.trim() && proxyEnv?.locale?.trim() && proxyEnv?.exitIp?.trim()
    ? {
        timezone: proxyEnv.timezone.trim(),
        locale: proxyEnv.locale.trim(),
        exitIp: proxyEnv.exitIp.trim(),
        source: "free_api_prequery" as const,
      }
    : null;

  if (fromEnv) {
    return fromEnv;
  }

  if (hasProxy) {
    throw new Error(
      "缺少 proxyEnv（出口 IP/时区/语言），已禁止回退 CloakBrowser 内置 geoip/mmdb。请先通过操作栏启动完成预查。",
    );
  }

  const geo = await resolveGeoViaCloakBrowser({});
  return {
    timezone: geo.timezone,
    locale: geo.locale,
    exitIp: geo.exitIp,
    source: "geoip",
  };
}

function assertFingerprintLaunchArgs(args: string[], timezone: string, hasProxy: boolean): void {
  const tzFlag = args.find((arg) => arg.startsWith("--fingerprint-timezone="));
  if (!tzFlag || tzFlag.slice("--fingerprint-timezone=".length) !== timezone) {
    throw new Error(`缺少或未生效 --fingerprint-timezone=${timezone}`);
  }
  if (hasProxy) {
    const webrtcFlag = args.find((arg) => arg.startsWith("--fingerprint-webrtc-ip="));
    if (webrtcFlag) {
      throw new Error(
        "有代理时不应手动注入 --fingerprint-webrtc-ip，须由 CloakBrowser geoip 经代理隧道解析（防 WebRTC 泄漏）",
      );
    }
  }
}

function isPrivateOrLocalIp(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  return false;
}

async function probeWebRtcCandidates(page: {
  evaluate: <T>(fn: () => Promise<T> | T) => Promise<T>;
}): Promise<string[]> {
  return page.evaluate(async () => {
    const found = new Set<string>();
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.createDataChannel("cf-probe");
        pc.onicecandidate = (event) => {
          if (!event.candidate) {
            pc.close();
            finish();
            return;
          }
          const match = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(event.candidate.candidate);
          if (match?.[1]) {
            found.add(match[1]);
          }
        };
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .catch(() => {
            pc.close();
            finish();
          });
        window.setTimeout(() => {
          pc.close();
          finish();
        }, 6000);
      } catch {
        finish();
      }
    });
    return [...found];
  });
}

function buildFinalChromiumArgs(
  config: ProfileLaunchConfig,
  extras: {
    timezone?: string;
    locale?: string;
    extensionPaths?: string[];
    exitIp?: string;
    hasProxy?: boolean;
  },
): string[] {
  const args = buildStealthArgs(config);

  // Debug (Windows): --fingerprint=off disables spoofing entirely — skip the
  // timezone/locale/webrtc spoofing extras so the browser exposes real values.
  if (!config.fingerprintOff) {
    if (extras.timezone) {
      args.push(`--fingerprint-timezone=${extras.timezone}`);
    }
    if (extras.locale) {
      args.push(`--lang=${extras.locale}`);
      args.push(`--fingerprint-locale=${extras.locale}`);
    }

    const exitIp = extras.exitIp?.trim() || config.proxyEnv?.exitIp?.trim();
    if (exitIp && !extras.hasProxy && !args.some((arg) => arg.startsWith("--fingerprint-webrtc-ip="))) {
      args.push(`--fingerprint-webrtc-ip=${exitIp}`);
    }
  }

  if (config.licenseThroughProxy) {
    args.push("--license-through-proxy");
  }
  if (config.allowThirdPartyCookies) {
    args.push("--fingerprint-allow-3p-cookies");
  }

  const extensions = extras.extensionPaths?.filter((entry) => entry.trim().length > 0) ?? [];
  if (extensions.length > 0) {
    const joined = extensions.map((entry) => path.resolve(entry)).join(",");
    args.push(`--load-extension=${joined}`);
    args.push(`--disable-extensions-except=${joined}`);
  }

  return stripForbiddenLaunchArgs(args);
}

async function probeFingerprintSignals(
  context: BrowserContext,
  logger: JsonLogger,
  profileId: string,
  gpuLaunch: GpuLaunchPlan | null,
  expectedTimezone: string,
  expectedExitIp?: string | null,
): Promise<void> {
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const info = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      let vendor: string | null = null;
      let renderer: string | null = null;
      if (gl && typeof WebGLRenderingContext !== "undefined") {
        const webgl = gl as WebGLRenderingContext;
        const ext = webgl.getExtension("WEBGL_debug_renderer_info");
        if (ext) {
          vendor = String(webgl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? "");
          renderer = String(webgl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
        }
      }

      let storageQuota: number | null = null;
      try {
        if (navigator.storage?.estimate) {
          const estimate = await navigator.storage.estimate();
          storageQuota = typeof estimate.quota === "number" ? estimate.quota : null;
        }
      } catch {
        storageQuota = null;
      }

      return {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        locale: navigator.language || null,
        vendor,
        renderer,
        storageQuota,
      };
    });
    logger.progress("fingerprint_probe", {
      profileId,
      gpuMode: gpuLaunch?.mode ?? null,
      nativeAngleRenderer: isNativeAngleRenderer(info.renderer),
      rendererMatchesLocal: rendererMatchesLocalGpu(info.renderer, gpuLaunch?.localGpu ?? null),
      localGpu: gpuLaunch?.localGpu
        ? {
            vendor: gpuLaunch.localGpu.vendor,
            renderer: gpuLaunch.localGpu.renderer,
            rawName: gpuLaunch.localGpu.rawName,
            source: gpuLaunch.localGpu.source,
          }
        : null,
      ...info,
    });

    if (gpuLaunch?.mode === "local_explicit" && !isNativeAngleRenderer(info.renderer)) {
      logger.warn("gpu_local_explicit_short_renderer", {
        profileId,
        hint: "已注入本机 gpu 旗标；若 BrowserScan 仍 WebGL −5%，Free 146 补丁较少，建议 Pro 151+ 或有效 License 后检查更新",
        renderer: info.renderer,
      });
    }
    const localGpu = gpuLaunch?.localGpu ?? null;
    if (
      gpuLaunch?.mode !== "pool_random" &&
      localGpu?.source !== "pool" &&
      localGpu &&
      info.renderer &&
      /geforce rtx 3060/i.test(info.renderer) &&
      !/3060/i.test(localGpu.rawName)
    ) {
      logger.warn("gpu_seed_leak_detected", {
        profileId,
        hint: "WebGL 仍显示 seed 派生 RTX 3060，请确认 sidecar 已更新并重启环境",
        expectedGpu: localGpu.rawName,
        renderer: info.renderer,
      });
    }

    const expectedTz = expectedTimezone.trim();
    if (expectedTz && info.timeZone && info.timeZone !== expectedTz) {
      logger.warn("timezone_mismatch_detected", {
        profileId,
        expectedTimezone: expectedTz,
        actualTimeZone: info.timeZone,
        expectedExitIp: expectedExitIp ?? null,
        hint: "Intl 时区与免费 API 不一致；请确认已重启 sidecar 且 launchOptions 未重复覆盖 args",
      });
    }

    if (expectedExitIp?.trim()) {
      try {
        const webrtcIps = await probeWebRtcCandidates(page);
        const expected = expectedExitIp.trim();
        const leaked = webrtcIps.filter(
          (ip) => ip !== expected && !isPrivateOrLocalIp(ip),
        );
        logger.progress("webrtc_probe", {
          profileId,
          expectedExitIp: expected,
          webrtcCandidates: webrtcIps,
          leakedCandidates: leaked,
        });
        if (leaked.length > 0) {
          logger.warn("webrtc_ip_leak_detected", {
            profileId,
            expectedExitIp: expected,
            leakedIps: leaked,
            hint: "BrowserScan 将报 IP addresses are different（−10%）；请确认 geoip:true 且未手动覆盖 webrtc 旗标",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("webrtc_probe_failed", { profileId, error: message });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("fingerprint_probe_failed", { profileId, error: message });
  }
}

function resolveProxyOption(config: ProfileLaunchConfig): string | {
  server: string;
  username?: string;
  password?: string;
} | undefined {
  const server = config.proxyUrl?.trim();
  if (!server) {
    return undefined;
  }
  const username = config.proxyUsername?.trim();
  if (username) {
    return {
      server,
      username,
      password: config.proxyPassword ?? "",
    };
  }
  return server;
}

async function applyGeolocation(
  context: BrowserContext,
  env: ProxyEnvSync,
  logger: JsonLogger,
  profileId: string,
): Promise<void> {
  const latitude = Number(env.latitude);
  const longitude = Number(env.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return;
  }

  try {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({
      latitude,
      longitude,
      accuracy: 10,
    });
    logger.progress("geolocation_applied", {
      profileId,
      latitude,
      longitude,
      timezone: env.timezone,
      locale: env.locale,
      exitIp: env.exitIp,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("geolocation_apply_failed", { profileId, error: message });
  }
}

async function applyPendingCookies(
  context: BrowserContext,
  userDataDir: string,
  logger: JsonLogger,
  profileId: string,
): Promise<void> {
  const pendingPath = path.join(userDataDir, PENDING_COOKIES_FILENAME);
  try {
    const raw = await readFile(pendingPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      await unlink(pendingPath).catch(() => undefined);
      return;
    }
    await context.addCookies(parsed as Parameters<BrowserContext["addCookies"]>[0]);
    await unlink(pendingPath).catch(() => undefined);
    logger.progress("pending_cookies_applied", {
      profileId,
      count: parsed.length,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("pending_cookies_apply_failed", { profileId, error: message });
  }
}

async function openHomepageIfBlank(
  context: BrowserContext,
  logger: JsonLogger,
  profileId: string,
  hasProxy: boolean,
): Promise<void> {
  try {
    const pages = context.pages();
    let page = pages[0];
    if (!page) {
      page = await context.newPage();
    }
    const current = page.url().trim();
    if (current && current !== "about:blank" && !current.startsWith("chrome://")) {
      return;
    }

    logger.progress("homepage_navigate_start", {
      profileId,
      url: DEFAULT_HOMEPAGE_URL,
      from: current || "about:blank",
    });

    await safeGoto(page, DEFAULT_HOMEPAGE_URL);

    logger.progress("homepage_navigate_done", {
      profileId,
      finalUrl: page.url(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("homepage_navigate_failed", {
      profileId,
      url: DEFAULT_HOMEPAGE_URL,
      hasProxy,
      error: message,
      hint: hasProxy
        ? "当前环境走代理出口；若系统 Chrome 能开站点而本环境不能，多半是代理节点无法访问目标站，请换节点或临时直连测试"
        : "直连仍无法打开首页，请检查本机网络/DNS/防火墙",
    });
  }
}

/** 规范化额外启动 URL：补 https、去空、去重（不含强制首位） */
function normalizeExtraStartupUrls(raw: unknown): string[] {
  const forcedKey = DEFAULT_HOMEPAGE_URL.replace(/\/$/, "").toLowerCase();
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>([forcedKey]);
  for (const item of list) {
    let text = String(item ?? "").trim();
    if (!text) {
      continue;
    }
    if (!/^https?:\/\//i.test(text)) {
      text = `https://${text.replace(/^\/+/, "")}`;
    }
    const key = text.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(text);
    if (out.length >= 20) {
      break;
    }
  }
  return out;
}

/**
 * 启动开页：第 1 个永远 BrowserScan；其余按环境设置顺序新开标签。
 */
async function openStartupPages(
  context: BrowserContext,
  logger: JsonLogger,
  profileId: string,
  hasProxy: boolean,
  extraUrls: string[],
): Promise<void> {
  await openHomepageIfBlank(context, logger, profileId, hasProxy);

  const extras = normalizeExtraStartupUrls(extraUrls);
  if (extras.length === 0) {
    return;
  }

  logger.progress("startup_extra_urls_begin", {
    profileId,
    count: extras.length,
    urls: extras,
  });

  for (const url of extras) {
    try {
      const page = await context.newPage();
      await safeGoto(page, url);
      logger.progress("startup_extra_url_done", {
        profileId,
        url,
        finalUrl: page.url(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("startup_extra_url_failed", {
        profileId,
        url,
        hasProxy,
        error: message,
      });
    }
  }
}

interface ProfileLaunchRuntime {
  profileId: string;
  config: ProfileLaunchConfig;
  userDataDir: string;
  licenseKey?: string;
  releaseChannel: ReleaseChannel;
  browserVersion?: string;
  /** 已解析/兜底好的 Chromium 可执行文件路径（避免 launch 内部二次 ensure 再 404）。 */
  chromePath: string;
  proxy: ReturnType<typeof resolveProxyOption>;
  extensionPaths?: string[];
  hardware: ReturnType<typeof deriveHardwareFromSeed>;
  gpuLaunch: GpuLaunchPlan;
  forceGeoip: true;
  forceHumanize: true;
  timezone: string;
  locale: string;
  resolvedExitIp: string;
  hasProxy: boolean;
  chromiumArgs: string[];
  hasGeoCoords: boolean;
  proxyEnv: ProxyEnvSync | null;
}

async function resolveProfileLaunchContext(
  config: ProfileLaunchConfig,
  resolvedLicense: ResolvedLicense,
  logger: JsonLogger,
): Promise<ProfileLaunchRuntime> {
  const profileId = config.profileId;
  /** 用户配置的 Key（可能为空）。内核档位/下载判定只看它。 */
  const configuredLicenseKey = resolvedLicense.licenseKey;
  const releaseChannel = resolveReleaseChannel(configuredLicenseKey);
  const rawVersion = config.browserVersion?.trim() || "";
  const browserVersion = resolveBrowserVersionPin(config.browserVersion);
  if (rawVersion && !browserVersion) {
    logger.warn("browser_version_pin_ignored", {
      profileId,
      raw: rawVersion,
      hint: "需完整 Chromium 版本（4~5 段），例如 146.0.7680.177.5；已回退最新版",
    });
  }
  const proxyEnv = config.proxyEnv ?? null;
  const userDataDir = String(config.userDataDir ?? "").trim();

  if (!userDataDir) {
    throw new Error("userDataDir is required for launchPersistentContext (incognito bypass)");
  }

  await mkdir(userDataDir, { recursive: true });

  // 本次启动实际注入浏览器的 Key：没配 Key 或用户 Key 席位已满时，自动改用内置免费 Key。
  const launchLicense = await resolveEffectiveLaunchKey({
    configuredKey: configuredLicenseKey,
    profileId,
    logger,
  });

  logger.progress("ensure_binary_start", { profileId, releaseChannel, browserVersion: browserVersion ?? null });
  // 内核档位/下载仍按「用户是否配置了 Key」判定（configuredLicenseKey，可能为空）：
  // 一旦这里换成内置免费 Key，离线打包 Pro 内核的「无 Key」复用路径与免费核固定版本下载
  // 都会被改变，可能把用户悄悄降级到免费核。授权 Key 只影响浏览器进程，不影响选哪个内核。
  const ensured = await ensureBinaryHonoringVersionPin(
    configuredLicenseKey,
    browserVersion,
    releaseChannel,
    config.bundledBrowseRoot,
    config.kernelPaths,
    config.globalBrowserPath,
    "Kernel", // Default download directory
  );
  if (ensured.customPathUsed) {
    logger.progress("custom_kernel_path_used", {
      profileId,
      browserVersion: browserVersion ?? null,
      chromePath: ensured.chromePath,
      hint: "使用设置中自定义的内核路径，跳过自动检测与网络下载",
    });
  }
  if (ensured.localKernelUsed) {
    logger.progress("local_kernel_used", {
      profileId,
      browserVersion: browserVersion ?? null,
      chromePath: ensured.chromePath,
      hint: "本地运行目录内核优先，跳过网络下载",
    });
  }
  const effectiveBrowserVersion = ensured.effectiveVersion ?? browserVersion;
  if (ensured.fallbackReason) {
    logger.warn("kernel_fallback_free", {
      profileId,
      requestedBrowserVersion: browserVersion ?? null,
      reason: ensured.fallbackReason,
      effectiveVersion: effectiveBrowserVersion ?? null,
      hint: "Pro 内核下载失败（404/瞬时），已降级为免费核兜底，避免启动失败。可在设置页「检查更新」重试 Pro。",
    });
  } else if (ensured.usedKeylessFreePin) {
    logger.progress("kernel_ensure_keyless_free_pin", {
      profileId,
      browserVersion: browserVersion ?? null,
      note: "free pin ignores license key so CloakBrowser does not fetch latest pro zip",
    });
  }
  logger.progress("ensure_binary_ready", { profileId, releaseChannel, browserVersion: effectiveBrowserVersion ?? null });

  const proxy = resolveProxyOption(config);
  const extensionPaths = config.extensionPaths?.filter((entry) => entry.trim().length > 0);
  const hardware = deriveHardwareFromSeed(config.fingerprintSeed);
  const binaryVersion = binaryInfo(effectiveBrowserVersion, releaseChannel).version ?? null;
  const gpuLaunch = config.gpuLaunch ?? (await buildGpuLaunchPlan({
    chromiumVersion: binaryVersion,
    profileWebglMode: config.webglMode ?? null,
    fingerprintSeed: config.fingerprintSeed,
  }));
  config.gpuLaunch = gpuLaunch;

  logger.progress("gpu_launch_plan", {
    profileId,
    webglMode: config.webglMode ?? null,
    chromiumVersion: binaryVersion,
    mode: gpuLaunch.mode,
    localGpu: gpuLaunch.localGpu
      ? {
          vendor: gpuLaunch.localGpu.vendor,
          renderer: gpuLaunch.localGpu.renderer,
          rawName: gpuLaunch.localGpu.rawName,
          adapter: gpuLaunch.localGpu.adapter,
          source: gpuLaunch.localGpu.source,
        }
      : null,
    gpuArgs: gpuLaunch.args,
  });

  const forceGeoip = true;
  const forceHumanize = true;
  const resolvedGeo = await resolveLaunchGeo(proxy, proxyEnv);
  const timezone = resolvedGeo.timezone;
  const locale = resolvedGeo.locale;
  const resolvedExitIp = resolvedGeo.exitIp;
  const hasProxy = Boolean(config.proxyUrl?.trim());

  logger.progress("geoip_resolved", {
    profileId,
    timezone,
    locale,
    exitIp: resolvedExitIp,
    geoSource: resolvedGeo.source,
    country: proxyEnv?.country ?? null,
    countryCode: proxyEnv?.countryCode ?? null,
  });

  const chromiumArgs = buildFinalChromiumArgs(config, {
    timezone,
    locale,
    extensionPaths,
    exitIp: resolvedExitIp,
    hasProxy,
  });

  if (hasProxy && !config.fingerprintOff) {
    assertFingerprintLaunchArgs(chromiumArgs, timezone, true);
  }

  logger.progress("launch_persistent_context_start", {
    profileId,
    cdpPort: config.cdpPort,
    userDataDir,
    useGeoip: forceGeoip,
    humanize: forceHumanize,
    profileUseGeoipFlag: config.useGeoip,
    profileHumanizeFlag: config.humanize,
    stealthPreset: config.stealthPreset,
    hasProxy,
    hasProxyEnv: Boolean(proxyEnv),
    timezone: timezone ?? null,
    locale: locale ?? null,
    exitIp: resolvedExitIp,
    webrtcInjection: hasProxy ? "cloakbrowser_geoip_tunnel" : "explicit_or_none",
    hardwareConcurrency: hardware.cores,
    deviceMemoryGb: hardware.memoryGb,
    gpuMode: gpuLaunch.mode,
    gpuArgs: gpuLaunch.args,
    stealthArgs: false,
    chromiumSandbox: true,
    chromiumArgs,
  });

  await sanitizeProfileExitState(userDataDir);

  const hasGeoCoords =
    proxyEnv !== null &&
    Number.isFinite(Number(proxyEnv.latitude)) &&
    Number.isFinite(Number(proxyEnv.longitude));

  return {
    profileId,
    config,
    userDataDir,
    // 注入浏览器进程的是「生效 Key」（含内置免费 Key 兜底），与上面判定内核档位用的
    // configuredLicenseKey 刻意区分开。
    licenseKey: launchLicense.key,
    releaseChannel,
    browserVersion: effectiveBrowserVersion,
    chromePath: ensured.chromePath,
    proxy,
    extensionPaths,
    hardware,
    gpuLaunch,
    forceGeoip,
    forceHumanize,
    timezone,
    locale,
    resolvedExitIp,
    hasProxy,
    chromiumArgs,
    hasGeoCoords,
    proxyEnv,
  };
}

async function launchBrowserContext(runtime: ProfileLaunchRuntime): Promise<BrowserContext> {
  const { config, userDataDir, licenseKey, browserVersion, releaseChannel, proxy, proxyEnv, hasGeoCoords } =
    runtime;

  configureDownloadRoots({
    browserDownloadDir: config.browserDownloadDir,
    scraperDownloadDir: config.scraperDownloadDir,
  });
  const downloadsPath = getResolvedDownloadPath("browser", config.profileId);
  await mkdir(downloadsPath, { recursive: true });

  const contextOptions: Record<string, unknown> = {
    acceptDownloads: true,
  };
  if (hasGeoCoords) {
    contextOptions.geolocation = {
      latitude: Number(proxyEnv!.latitude),
      longitude: Number(proxyEnv!.longitude),
      accuracy: 10,
    };
    contextOptions.permissions = ["geolocation"];
  }

  // 强制 launchPersistentContext 使用我们已解析/兜底好的二进制，跳过其内部
  // ensureBinary（否则会对「有效 License + 固定 pin」再次触发 Pro 下载 404）。
  const previousBinaryPath = process.env.CLOAKBROWSER_BINARY_PATH;
  process.env.CLOAKBROWSER_BINARY_PATH = runtime.chromePath;

  try {
    return await launchPersistentContext({
      userDataDir,
      headless: false,
      proxy,
      geoip: runtime.forceGeoip,
      humanize: runtime.forceHumanize,
      humanPreset: HUMAN_PRESET,
      humanConfig: { ...HUMAN_MOUSE_CONFIG },
      licenseKey,
      browserVersion,
      releaseChannel,
      stealthArgs: false,
      timezone: runtime.timezone,
      locale: runtime.locale,
      args: runtime.chromiumArgs,
      contextOptions,
      launchOptions: {
        chromiumSandbox: true,
        ignoreDefaultArgs: IGNORE_AUTOMATION_DEFAULT_ARGS,
        downloadsPath,
      },
    });
  } catch (err) {
    const extras = await cloakExtrasPromise;
    const mapped = extras?.licenseErrorFrom?.(err);
    if (mapped) {
      throw mapped;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (
      /session seat|concurrent session|seat (cap|limit)|席位/i.test(message) ||
      /Target page, context or browser has been closed/i.test(message)
    ) {
      throw new Error(
        `CloakBrowser 启动被内核拒绝或会话闪退：${message}。` +
          `官方免费档仅 1 个并发指纹窗，超限时第二个窗口会约 1 秒内自动关闭（CloakBrowser #477），非天枢台误杀。` +
          `天枢台已在启动前尝试席位兜底（用户 Key 席位满时自动改用内置免费 Key）；` +
          `若仍失败，说明内置免费 Key 的并发名额也已被占用，请停掉已开环境或升级 Pro 席位后再试。`,
      );
    }
    throw err;
  } finally {
    if (previousBinaryPath === undefined) {
      delete process.env.CLOAKBROWSER_BINARY_PATH;
    } else {
      process.env.CLOAKBROWSER_BINARY_PATH = previousBinaryPath;
    }
  }
}

async function runPostLaunchHooks(
  context: BrowserContext,
  runtime: ProfileLaunchRuntime,
  logger: JsonLogger,
): Promise<void> {
  const { profileId, config, userDataDir, proxyEnv, gpuLaunch, timezone, resolvedExitIp, hasProxy, hardware } =
    runtime;

  configureDownloadRoots({
    browserDownloadDir: config.browserDownloadDir,
    scraperDownloadDir: config.scraperDownloadDir,
  });
  const downloadsPath = getResolvedDownloadPath("browser", profileId);
  installDownloadAutoSave(context, logger, profileId, downloadsPath);
  // 落盘目录必须由 Chrome 自己写（behavior=allow），否则 Playwright 的 allowAndName 会把
  // 手动下载写成临时 GUID 文件；并在其它 CDP 客户端抢回 allowAndName 时周期性纠正。
  const browser = context.browser();
  if (browser) {
    await applyBrowserDownloadDir(browser, downloadsPath, logger, profileId);
    guardBrowserDownloadDir(browser, downloadsPath, logger, profileId);
  } else {
    logger.warn("download_dir_apply_skipped", { profileId, reason: "browser_unavailable" });
  }

  if (proxyEnv && runtime.hasGeoCoords) {
    await applyGeolocation(context, proxyEnv, logger, profileId);
  }

  await applyPendingCookies(context, userDataDir, logger, profileId);
  await probeFingerprintSignals(context, logger, profileId, gpuLaunch, timezone, resolvedExitIp);
  await openStartupPages(
    context,
    logger,
    profileId,
    hasProxy,
    Array.isArray(config.startupUrls) ? config.startupUrls : [],
  );

  try {
    await applyProfileWindowMarker(context, profileId, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("profile_window_marker_failed", { profileId, error: message });
  }

  logger.browserStatus(profileId, "running", config.cdpPort);
  logger.result("browser_launched", {
    profileId,
    cdpPort: config.cdpPort,
    themeColor: config.themeColor ?? null,
    userDataDir: config.userDataDir,
    downloadsPath,
    cdpUrl: `http://127.0.0.1:${config.cdpPort}`,
    useGeoip: runtime.forceGeoip,
    humanize: runtime.forceHumanize,
    fingerprintSeed: config.fingerprintSeed,
    stealthPreset: config.stealthPreset,
    proxyEnvApplied: Boolean(proxyEnv),
    timezone: timezone ?? null,
    locale: runtime.locale ?? null,
    exitIp: proxyEnv?.exitIp ?? null,
    hardwareConcurrency: hardware.cores,
    deviceMemoryGb: hardware.memoryGb,
    gpuMode: gpuLaunch.mode,
    localGpu: gpuLaunch.localGpu?.rawName ?? null,
    geolocation: runtime.hasGeoCoords
      ? { latitude: proxyEnv!.latitude, longitude: proxyEnv!.longitude }
      : null,
    launchMode: "launchPersistentContext",
    releaseChannel: runtime.releaseChannel,
    stealthArgs: false,
    chromiumSandbox: true,
    chromiumArgs: runtime.chromiumArgs,
  });
}

export async function launchProfileBrowser(
  config: ProfileLaunchConfig,
  logger: JsonLogger,
): Promise<BrowserContext> {
  const profileId = config.profileId;
  const proxyServer = config.proxyUrl?.trim() || null;
  const proxyUser = config.proxyUsername?.trim() || null;
  logger.progress("DEBUG_LAUNCH_SIDECAR", {
    profileId,
    userDataDir: config.userDataDir,
    cdpPort: config.cdpPort,
    proxyUrl: proxyServer,
    proxyUsername: proxyUser,
    hasProxyEnv: Boolean(config.proxyEnv?.exitIp),
    proxyEnvExitIp: config.proxyEnv?.exitIp ?? null,
  });
  if (!profileId?.trim()) {
    throw new Error("DEBUG_LAUNCH_SIDECAR: missing profileId in launch config");
  }
  {
    const expectedDirName = `profile-${profileId}`;
    const baseName = path.basename(String(config.userDataDir ?? "").replace(/[/\\]+$/, ""));
    if (baseName && baseName !== expectedDirName) {
      logger.warn("DEBUG_LAUNCH_SIDECAR_userDataDir_mismatch", {
        profileId,
        userDataDir: config.userDataDir,
        expectedDirName,
      });
    }
  }

  const resolvedLicense = await resolveEffectiveLicenseKey(config.licenseKey, "app");
  const licenseKey = resolvedLicense.licenseKey;
  const releaseChannel = resolveReleaseChannel(licenseKey);
  const browserVersion = resolveBrowserVersionPin(config.browserVersion);

  if (resolvedLicense.fallbackReason) {
    logger.warn("license_fallback_free", {
      profileId,
      reason: resolvedLicense.fallbackReason,
      hadConfiguredKey: resolvedLicense.hadConfiguredKey,
      licenseKeySource: resolvedLicense.source,
    });
  }

  try {
    const runtime = await resolveProfileLaunchContext(config, resolvedLicense, logger);
    if (runtime.profileId !== profileId) {
      throw new Error(
        `DEBUG_LAUNCH_SIDECAR: runtime profileId mismatch runtime=${runtime.profileId} config=${profileId}`,
      );
    }
    const context = await launchBrowserContext(runtime);
    await runPostLaunchHooks(context, runtime, logger);
    return context;
  } catch (error) {
    const extras = await cloakExtrasPromise;
    const licenseError = extras?.licenseErrorFrom(error) ?? null;
    const message = licenseError?.message ?? (error instanceof Error ? error.message : String(error));
    const tier = binaryInfo(browserVersion, releaseChannel).tier ?? null;
    logger.launchError("LAUNCH_FAILED", message, profileId);
    logger.error("launch_failed", { profileId, error: message, tier });
    throw licenseError ?? error;
  }
}
