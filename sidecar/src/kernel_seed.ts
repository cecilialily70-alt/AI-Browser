/**
 * 本地内核发现：本地运行目录（Browse/ 或 Kernel/）优先于 ~/.cloakbrowser 缓存。
 * 免费核/Pro 核通用，不再绑定单一 Pro 版本。
 */
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";

import { ENV_BROWSE_ROOT, readAppEnv } from "./app_env.js";

/** Pro 内核系列主版本（151+）；free 为 146 系列。 */
export const PRO_KERNEL_MAJOR = 151;

/** Resolve 本地运行目录根：launch config override → env → cwd/兄弟路径（Browse 与 Kernel 都认）。 */
export function resolveBrowseRootCandidates(explicit?: string | null): string[] {
  const out: string[] = [];
  const push = (p: string | null | undefined) => {
    const t = String(p ?? "").trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(explicit);
  push(readAppEnv(ENV_BROWSE_ROOT));
  const scriptDir = path.dirname(process.argv[1] || "");
  for (const base of [process.cwd(), path.dirname(scriptDir)]) {
    for (const name of ["Browse", "Kernel"]) {
      push(path.join(base, name));
      push(path.resolve(base, "..", name));
    }
  }
  // portable: sidecar/dist → ../../Browse|Kernel 或 ../Browse|Kernel
  push(path.resolve(scriptDir, "..", "..", "Browse"));
  push(path.resolve(scriptDir, "..", "..", "Kernel"));
  push(path.resolve(scriptDir, "..", "Browse"));
  push(path.resolve(scriptDir, "..", "Kernel"));
  push(path.resolve(scriptDir, "..", "..", "..", "Browse"));
  push(path.resolve(scriptDir, "..", "..", "..", "Kernel"));
  return out;
}

function majorVersion(pin: string): number {
  const first = pin.trim().split(".")[0];
  const parsed = Number.parseInt(first ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Pro 内核 = 151+ 系列（抗小版本升级）。 */
export function isFingerprintOnlyKernelPin(browserVersion?: string | null): boolean {
  const v = String(browserVersion ?? "").trim();
  return Boolean(v) && majorVersion(v) >= PRO_KERNEL_MAJOR;
}

export interface LocalKernelHit {
  version: string;
  dirName: string;
  chromePath: string;
  isPro: boolean;
  sourceDir: string;
}

/** 内核目录名：`chromium-<version>` 或 `chromium-<version>-pro`。 */
const KERNEL_DIR_RE = /^chromium-(\d+(?:\.\d+){3,4})(-pro)?$/;

interface ScannedKernel {
  version: string;
  dirName: string;
  chromePath: string;
  isPro: boolean;
}

/** 列出某个运行目录根下全部可用内核（目录名合法且含 chrome.exe）。 */
function listKernelsIn(root: string): ScannedKernel[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: ScannedKernel[] = [];
  for (const name of entries) {
    const match = KERNEL_DIR_RE.exec(name);
    if (!match) {
      continue;
    }
    const chromePath = path.join(root, name, "chrome.exe");
    if (!existsSync(chromePath)) {
      continue;
    }
    out.push({
      version: match[1]!,
      dirName: name,
      chromePath,
      isPro: Boolean(match[2]),
    });
  }
  return out;
}

/** 逐段数值比较版本号（用于挑选「最新」的本地内核）。 */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** 扫描本地运行目录中匹配 pin 的内核（`chromium-<pin>` 或 `chromium-<pin>-pro`）。 */
export function findLocalKernel(
  browserVersion: string | null | undefined,
  bundledBrowseRoot?: string | null,
): LocalKernelHit | null {
  const pin = String(browserVersion ?? "").trim();
  if (!pin) return null;
  for (const root of resolveBrowseRootCandidates(bundledBrowseRoot)) {
    const matches = listKernelsIn(root).filter((kernel) => kernel.version === pin);
    // 同名目录同时存在 `chromium-<pin>` 与 `chromium-<pin>-pro` 时优先免费目录
    const hit = matches.find((kernel) => !kernel.isPro) ?? matches[0];
    if (hit) {
      return { ...hit, sourceDir: root };
    }
  }
  return null;
}

/**
 * 「自动版本」（pin 为空）时的本地内核回退：取本地最新的**免费系**内核。
 *
 * 为什么只认免费系：环境能否使用 AI / Agent 由存下来的 `browser_version` 判定
 * （Rust `assert_ai_allowed_for_browser_version`、前端 `isAiBlockedForKernel`），
 * 而「自动版本」下这个字段是空的。若此处命中本地 Pro 内核，空 pin 会让策略层
 * 判定为「非 Pro 内核」，从而放过免费档本应被拦截的 AI 调用。
 * 免费系命中不改变档位语义，因此安全。
 */
export function findAutoLocalKernel(bundledBrowseRoot?: string | null): LocalKernelHit | null {
  let best: LocalKernelHit | null = null;
  for (const root of resolveBrowseRootCandidates(bundledBrowseRoot)) {
    for (const kernel of listKernelsIn(root)) {
      if (kernel.isPro) {
        continue;
      }
      if (!best || compareVersions(kernel.version, best.version) > 0) {
        best = { ...kernel, sourceDir: root };
      }
    }
  }
  return best;
}

