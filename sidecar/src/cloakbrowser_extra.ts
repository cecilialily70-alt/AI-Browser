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
 * 鼠标拟人参数微调（在内核 careful 档基础上覆盖）。
 *
 * 动机：内核默认参数是为「移动 + 点击」调优的，轨迹采样偏稀疏、手部抖动偏小，
 * 对滑块拖拽这种长距离连续动作拟人度不足。此处只调 mouse_* 参数（不碰键盘/滚动），
 * 且调整方向一致为「更像人手」，无功能副作用。
 *
 * 参数含义见 cloakbrowser/dist/human/config.js 与 mouse.js：
 *   mouse_steps_divisor  每移动多少 px 生成一个采样点（越小采样越密）
 *   mouse_min/max_steps  单次移动的采样点上下限
 *   mouse_wobble_max     垂直手部抖动幅度（px）
 *   mouse_overshoot_*    终点微超冲 + 回正（真人松手前常见）
 */
export const HUMAN_MOUSE_CONFIG: {
  mouse_steps_divisor: number;
  mouse_min_steps: number;
  mouse_max_steps: number;
  mouse_wobble_max: number;
  mouse_overshoot_chance: number;
  mouse_overshoot_px: [number, number];
  mouse_burst_pause: [number, number];
} = {
  mouse_steps_divisor: 6,
  mouse_min_steps: 14,
  mouse_max_steps: 110,
  mouse_wobble_max: 2.5,
  mouse_overshoot_chance: 0.35,
  mouse_overshoot_px: [4, 9],
  mouse_burst_pause: [15, 32],
};

type HumanizeBrowserFn = (
  browser: unknown,
  options?: { humanize?: boolean; humanPreset?: string; humanConfig?: Record<string, unknown> },
) => Promise<void>;

let cachedHumanizeBrowser: HumanizeBrowserFn | null = null;

async function loadHumanizeBrowser(): Promise<HumanizeBrowserFn> {
  if (!cachedHumanizeBrowser) {
    const mod = (await import(moduleHref("playwright.js"))) as {
      humanizeBrowser: HumanizeBrowserFn;
    };
    cachedHumanizeBrowser = mod.humanizeBrowser;
  }
  return cachedHumanizeBrowser;
}

/**
 * 给「另开 CDP 连接」拿到的 Browser 打上内核拟人补丁。
 *
 * 关键事实（实测确认）：humanize 是内核在**启动进程内**对 Page 对象做的 JS 补丁，
 * 不随 CDP 协议传播。任何用 chromium.connectOverCDP() 另开连接的客户端（如 Agent）
 * 拿到的都是**未打补丁**的 page —— 此时 page.mouse.move() 退化为「瞬移」，
 * 滑块拖拽一帧内完成，既无仿生曲线也极易被风控识破（现象：滑块「没动就过」）。
 *
 * 实测对比：同一次拖拽，补丁前 2 个 mousemove 事件 / 242ms；补丁后 82 个 / 1692ms。
 *
 * 内核为此提供 humanizeBrowser()，可补丁已有的 context/page 并挂钩后续新建页面。
 * 补丁失败不抛出：退化为原生行为（可用性优先），由调用方记录告警留痕。
 */
export async function humanizeConnectedBrowser(browser: unknown): Promise<boolean> {
  try {
    const humanizeBrowser = await loadHumanizeBrowser();
    await humanizeBrowser(browser, {
      humanize: true,
      humanPreset: HUMAN_PRESET,
      humanConfig: { ...HUMAN_MOUSE_CONFIG },
    });
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
