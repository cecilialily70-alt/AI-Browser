import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateLicense } from "cloakbrowser";

export type ReleaseChannel = "stable" | "preview";
export type LicenseKeySource = "param" | "env" | "file" | "none";
export type LicenseSourcePolicy = "app" | "cli";

/**
 * 应用内置的免费 Key（服务端 `plan=free`，无过期）。
 *
 * 唯一用途：**席位兜底**。当用户自己配置的 License Key 并发席位已用满时，
 * 改用此 Key 继续启动，而不是让环境直接启动失败（见 browser_launcher 的席位回退）。
 *
 * 注意两个已验证的事实，改动此处前必须一并考虑：
 * 1. 该 Key 的席位计数是**按 Key 全局共享**的（服务端返回 `active/limit`），
 *    不代表「本机已被占用」，因此不能用它做本机占用判定；
 * 2. `plan=free`，无法通过它下载/启用 Pro 内核（内核档位由版本 pin 决定）。
 */
export const BUILTIN_FREE_LICENSE_KEY = "cb_97c89825d8fb4289803185f1a17bbc1c";

export function isBuiltinFreeLicenseKey(key?: string | null): boolean {
  return (key?.trim() ?? "") === BUILTIN_FREE_LICENSE_KEY;
}

/** 席位计数（与 cloakbrowser `getSessionSeats` 的 `active`/`limit` 对齐）。 */
export interface SeatCounts {
  active: number | null;
  limit: number | null;
}

export type EffectiveKeyReason =
  /** 用用户自己配置的 Key（席位未满） */
  | "configured"
  /** 用户没配置 Key → 用内置免费 Key 兜底 */
  | "builtin-default"
  /** 用户 Key 席位已满 → 改用内置免费 Key 打开 */
  | "builtin-seat-fallback"
  /** 用户自己填的就是内置免费 Key */
  | "builtin-configured";

export interface EffectiveLicenseKey {
  key: string;
  reason: EffectiveKeyReason;
}

/** 席位是否已满；`limit` 缺失/为 0 一律视为「未知」而非「已满」。 */
function seatsExhausted(seats: SeatCounts | null | undefined): boolean {
  if (!seats) {
    return false;
  }
  const { active, limit } = seats;
  return typeof active === "number" && typeof limit === "number" && limit > 0 && active >= limit;
}

/**
 * 决定「本次启动实际注入浏览器的 License Key」。
 *
 * 规则：
 * 1. 用户没有配置 Key → 用内置免费 Key，开箱即用；
 * 2. 用户配置的 Key 并发席位已满 → 改用内置免费 Key 打开，而不是启动失败；
 * 3. 其余 → 用用户自己的 Key。
 *
 * `seats` 为 `null`（查询失败或不可达）时一律不兜底：宁可让用户用自己的 Key 去试，
 * 也不要因为一次查询失败就把 Pro 用户降级成免费 Key。
 */
export function decideEffectiveLicenseKey(
  configuredKey: string | null | undefined,
  seats?: SeatCounts | null,
): EffectiveLicenseKey {
  const configured = String(configuredKey ?? "").trim();
  if (!configured) {
    return { key: BUILTIN_FREE_LICENSE_KEY, reason: "builtin-default" };
  }
  if (isBuiltinFreeLicenseKey(configured)) {
    // 内置 Key 的席位计数全局共享，不代表「本机已占用」，因此不做兜底判定
    return { key: configured, reason: "builtin-configured" };
  }
  if (seatsExhausted(seats)) {
    return { key: BUILTIN_FREE_LICENSE_KEY, reason: "builtin-seat-fallback" };
  }
  return { key: configured, reason: "configured" };
}

/** 将进程环境里的 `CLOAKBROWSER_LICENSE_KEY` 同步为本次生效的 Key（内核子进程会继承）。 */
export function applyLicenseEnv(licenseKey?: string | null): void {
  const trimmed = licenseKey?.trim();
  if (trimmed) {
    process.env.CLOAKBROWSER_LICENSE_KEY = trimmed;
  } else {
    clearLicenseEnv();
  }
}

export interface PickedLicenseKey {
  key?: string;
  hadConfiguredKey: boolean;
  source: LicenseKeySource;
}

export interface ResolvedLicense {
  licenseKey?: string;
  hadConfiguredKey: boolean;
  source: LicenseKeySource;
  fallbackReason?: string;
  plan?: string | null;
}

function readDefaultLicenseKeyFile(): string | undefined {
  try {
    const keyFile = path.join(os.homedir(), ".cloakbrowser", "license.key");
    const content = fs.readFileSync(keyFile, "utf8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

export function pickCandidateKey(
  explicitKey?: string | null,
  policy: LicenseSourcePolicy = "app",
): PickedLicenseKey {
  if (policy === "app") {
    if (explicitKey == null) {
      return { hadConfiguredKey: false, source: "none" };
    }
    const trimmed = explicitKey.trim();
    if (!trimmed) {
      return { hadConfiguredKey: true, source: "none" };
    }
    return { key: trimmed, hadConfiguredKey: true, source: "param" };
  }

  if (explicitKey != null) {
    const trimmed = explicitKey.trim();
    if (trimmed) {
      return { key: trimmed, hadConfiguredKey: true, source: "param" };
    }
    return { hadConfiguredKey: true, source: "none" };
  }

  const fromEnv = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
  if (fromEnv) {
    return { key: fromEnv, hadConfiguredKey: true, source: "env" };
  }

  const fromFile = readDefaultLicenseKeyFile();
  if (fromFile) {
    return { key: fromFile, hadConfiguredKey: true, source: "file" };
  }

  return { hadConfiguredKey: false, source: "none" };
}

export function clearLicenseEnv(): void {
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
}

function normalizeReleaseChannel(raw?: string | null): ReleaseChannel {
  const value = raw?.trim().toLowerCase();
  if (value === "preview") {
    return "preview";
  }
  return "stable";
}

export function resolveReleaseChannel(_licenseKey?: string | null): ReleaseChannel {
  const fromEnv = process.env.CLOAKBROWSER_RELEASE_CHANNEL?.trim();
  if (fromEnv) {
    return normalizeReleaseChannel(fromEnv);
  }
  return "stable";
}

/** CloakBrowser 要求完整版本号：4 或 5 段数字，如 146.0.7680.177.5 */
const BROWSER_VERSION_PIN_RE = /^[0-9]+(?:\.[0-9]+){3,4}$/;

export function isValidBrowserVersionPin(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && BROWSER_VERSION_PIN_RE.test(trimmed);
}

export function resolveBrowserVersionPin(explicit?: string | null): string | undefined {
  const fromParam = explicit?.trim();
  if (fromParam) {
    return isValidBrowserVersionPin(fromParam) ? fromParam : undefined;
  }
  const fromEnv = process.env.CLOAKBROWSER_VERSION?.trim();
  if (fromEnv && isValidBrowserVersionPin(fromEnv)) {
    return fromEnv;
  }
  return undefined;
}

export async function resolveEffectiveLicenseKey(
  explicitKey?: string | null,
  policy: LicenseSourcePolicy = "app",
): Promise<ResolvedLicense> {
  const picked = pickCandidateKey(explicitKey, policy);
  if (!picked.key) {
    clearLicenseEnv();
    return {
      hadConfiguredKey: picked.hadConfiguredKey,
      source: picked.source,
    };
  }

  const info = await validateLicense(picked.key);
  if (info?.valid) {
    process.env.CLOAKBROWSER_LICENSE_KEY = picked.key;
    return {
      licenseKey: picked.key,
      hadConfiguredKey: picked.hadConfiguredKey,
      source: picked.source,
      plan: info.plan ?? null,
    };
  }

  clearLicenseEnv();

  if (info && !info.valid) {
    return {
      hadConfiguredKey: picked.hadConfiguredKey,
      source: picked.source,
      plan: info.plan ?? null,
      fallbackReason: `License 无效或已过期 (plan=${info.plan})，已自动使用 Free 内核。请在设置中清空 License Key 或填写有效密钥。`,
    };
  }

  return {
    hadConfiguredKey: picked.hadConfiguredKey,
    source: picked.source,
    fallbackReason:
      "License 无法在线验证且无有效缓存，已自动使用 Free 内核。请检查网络或清空 License Key。",
  };
}
