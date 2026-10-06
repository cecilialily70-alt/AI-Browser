import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const distRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/cloakbrowser/dist",
);

function moduleHref(name: string): string {
  return pathToFileURL(path.join(distRoot, name)).href;
}

export interface ProReleaseInfo {
  version: string;
  requestedChannel: "stable" | "preview";
  resolvedChannel: "stable" | "preview";
  fallback: boolean;
}

export interface SessionSeats {
  active: number | null;
  limit: number | null;
  state: "ok" | "unreachable" | "denied" | "unknown";
  reason: string | null;
}

export interface CloakExtras {
  checkForProUpdate: (licenseKey: string, releaseChannel?: string) => Promise<string | null>;
  getProLatestRelease: (releaseChannel?: string) => Promise<ProReleaseInfo | null>;
  getSessionSeats: (licenseKey: string) => Promise<SessionSeats>;
  licenseErrorFrom: (err: unknown) => Error | null;
  WRAPPER_VERSION: string;
}

let cached: CloakExtras | null = null;

/**
 * 与启动器共用的拟人档位（单点定义，避免两处各写一份字面量而漂移）。
 * 见 browser_launcher.ts 的 launchPersistentContext 调用。
 */
export const HUMAN_PRESET = "careful";

/**
 * 启动与 CDP 二次连接共用的拟人覆盖（禁止两处各写一份）。
 * 只调 mouse_*：内核 careful 档对滑块长拖采样偏稀。不碰键盘/滚动，不把 mistype_chance 调高。
 */
export const HUMAN_CONFIG: Record<string, unknown> = {
  mouse_steps_divisor: 6,
  mouse_min_steps: 14,
  mouse_max_steps: 110,
  mouse_wobble_max: 2.5,
  mouse_overshoot_chance: 0.35,
  mouse_overshoot_px: [4, 9],
  mouse_burst_pause: [15, 32],
};

/** OTP / 验证码单次填写：禁止错字回改。 */
export const HUMAN_NO_MISTYPE = { mistype_chance: 0 } as const;

type PatchBrowserFn = (browser: unknown, cfg: unknown) => void;
type ResolveConfigFn = (preset?: string, overrides?: Record<string, unknown>) => unknown;

let cachedPatch: { patchBrowser: PatchBrowserFn; resolveConfig: ResolveConfigFn } | null = null;

async function loadOfficialHumanPatch(): Promise<{
  patchBrowser: PatchBrowserFn;
  resolveConfig: ResolveConfigFn;
}> {
  if (!cachedPatch) {
    const mod = (await import(moduleHref("human/index.js"))) as {
      patchBrowser: PatchBrowserFn;
      resolveConfig: ResolveConfigFn;
    };
    cachedPatch = {
      patchBrowser: mod.patchBrowser,
      resolveConfig: mod.resolveConfig,
    };
  }
  return cachedPatch;
}

/**
 * 给「另开 CDP 连接」拿到的 Browser 打上包装层拟人补丁。
 *
 * 官方（CloakBrowser #126）：行为层（贝塞尔 / 打字节奏 / 滚轮微步）是 wrapper
 * monkey-patch，不随 CDP 传播。connectOverCDP 必须再调 patchBrowser。
 *
 * 与 launchPersistentContext({ humanize, humanPreset, humanConfig }) 同一份档位。
 * 补丁失败不抛出：退化为原生 Playwright（可用性优先），由调用方记录告警留痕。
 */
export async function humanizeConnectedBrowser(browser: unknown): Promise<boolean> {
  try {
    const { patchBrowser, resolveConfig } = await loadOfficialHumanPatch();
    const cfg = resolveConfig(HUMAN_PRESET, HUMAN_CONFIG);
    patchBrowser(browser, cfg);
    return true;
  } catch {
    return false;
  }
}

export async function loadCloakExtras(): Promise<CloakExtras> {
  if (cached) {
    return cached;
  }

  const [download, license, config] = await Promise.all([
    import(moduleHref("download.js")),
    import(moduleHref("license.js")),
    import(moduleHref("config.js")),
  ]);

  cached = {
    checkForProUpdate: download.checkForProUpdate as CloakExtras["checkForProUpdate"],
    getProLatestRelease: license.getProLatestRelease as CloakExtras["getProLatestRelease"],
    getSessionSeats: license.getSessionSeats as CloakExtras["getSessionSeats"],
    licenseErrorFrom: license.licenseErrorFrom as CloakExtras["licenseErrorFrom"],
    WRAPPER_VERSION: config.WRAPPER_VERSION as string,
  };
  return cached;
}
