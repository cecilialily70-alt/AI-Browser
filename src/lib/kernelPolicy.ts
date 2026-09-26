/**
 * Dual-kernel policy: free Chromium via ensureBinary; bundled 151-pro for fingerprint.
 * Free Key: AI only on free kernel, max 1 parallel. Pro Key: AI parallel ≤ seats.
 * Opening browsers is unlimited on both tiers.
 *
 * 内核约定（与 CloakBrowser 一致）：free=146 系列，pro=151 系列。
 * 本地运行目录（exe 旁 Browse\ / 开发目录 Kernel\）优先于 ~/.cloakbrowser 缓存。
 */
import type { LocalKernel } from "../types";

export const FREE_CHROMIUM_VERSION = "146.0.7680.177.5";
/** Pro 内核系列主版本（151+）；具体小版本以本地 chromium-151.*-pro 目录为准。 */
export const PRO_KERNEL_MAJOR = 151;
/** 打包 Pro 系列展示版本（仅作下拉标签；真实版本由本地检测决定）。 */
export const BUNDLED_PRO_CHROMIUM_VERSION = "151.0.7922.108.6";

export type KernelPresetId = "auto" | "custom";

export interface KernelPresetOption {
  id: KernelPresetId;
  /** Empty string = leave pin blank (CloakBrowser latest for current license). */
  browserVersion: string;
  label: string;
  hint: string;
}

/**
 * 预设只保留「自动」。具体内核不再作为固定条目列出。
 *
 * 原因：免费核 / 151-pro 一旦本机已有，就与「本地内核（优先使用）」组完全重复；
 * 本机没有时又只是「未下载的预告」，反而让人误以为必须先下载。
 * 真实可用的具体内核统一由「本地内核」组呈现，其余用「自定义 Pin」显式填写。
 */
export const KERNEL_PRESET_OPTIONS: KernelPresetOption[] = [
  {
    id: "auto",
    browserVersion: "",
    label: "自动（按 License 最新）",
    hint: "免费 Key → 官方免费核；Pro Key → 最新 Pro。本机已有可用内核时优先使用本地内核，不联网下载。",
  },
];

function majorVersion(pin: string): number {
  const first = pin.trim().split(".")[0];
  const parsed = Number.parseInt(first ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** True when this pin is the Pro fingerprint kernel (151+ series). */
export function isFingerprintOnlyKernelPin(browserVersion: string | null | undefined): boolean {
  const v = String(browserVersion ?? "").trim();
  if (!v) return false;
  return majorVersion(v) >= PRO_KERNEL_MAJOR;
}

/** Free Key + fingerprint-only pin → AI must be blocked. */
export function isAiBlockedForKernel(
  isProLicense: boolean,
  browserVersion: string | null | undefined,
): boolean {
  if (isProLicense) return false;
  return isFingerprintOnlyKernelPin(browserVersion);
}

export function aiBlockedKernelMessage(browserVersion: string | null | undefined): string {
  const pin = String(browserVersion ?? "").trim() || BUNDLED_PRO_CHROMIUM_VERSION;
  return (
    `免费 License 下内核 ${pin} 仅允许指纹浏览，不可进行 AI / Agent / 智能填表。` +
    `请将环境改为免费核（${FREE_CHROMIUM_VERSION}）或升级 Pro 后再试。打开浏览器数量不受限制。`
  );
}

export function presetIdFromBrowserVersion(browserVersion: string | null | undefined): KernelPresetId {
  return String(browserVersion ?? "").trim() ? "custom" : "auto";
}

/** 逐段数值比较内核版本号（`a>b` 返回正数）；用于挑选「最新」本地内核。 */
export function compareKernelVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 本地运行目录（bundled）优先于 ~/.cloakbrowser 缓存。 */
function kernelSourceRank(source: string): number {
  return source === "bundled" ? 1 : 0;
}

/** 免费档只能用免费系内核（Pro 核会被 AI 闸门 `isAiBlockedForKernel` 拦下）。 */
function isFreeTierKernel(kernel: LocalKernel): boolean {
  return kernel.tier !== "pro" && !isFingerprintOnlyKernelPin(kernel.version);
}

/**
 * 新建窗口时按 License 档位挑一个**本机已有**的内核作为推荐初值：
 * - Pro：本机最新内核（版本号最高；同版本本地运行目录优先于缓存）。
 * - 免费：本机最新的免费系内核（免费档用 Pro 核会被拦 AI）。
 *
 * 返回 `null` = 本机没有可用内核，保持「自动（按 License 最新）」，不强行 pin。
 */
export function pickRecommendedLocalKernel(
  isProLicense: boolean,
  localKernels: LocalKernel[],
): LocalKernel | null {
  const pool = isProLicense ? localKernels : localKernels.filter(isFreeTierKernel);
  let best: LocalKernel | null = null;
  for (const kernel of pool) {
    if (!best) {
      best = kernel;
      continue;
    }
    const byVersion = compareKernelVersions(kernel.version, best.version);
    if (
      byVersion > 0 ||
      (byVersion === 0 && kernelSourceRank(kernel.source) > kernelSourceRank(best.source))
    ) {
      best = kernel;
    }
  }
  return best;
}
