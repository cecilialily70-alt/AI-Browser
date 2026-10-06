/**
 * CloakBrowser ensureBinary 在「有效 License（含 Free Key）」时会走 ensureProBinary，
 * 并丢弃 free 档的 version pin，强制下「最新」（见 node_modules/cloakbrowser/dist/download.js）。
 * 用户显式 pin 免费核（如 146.x）时必须暂时卸掉 Key（env + license.key 文件），
 * 才能按 pin 从 GitHub 下免费包，避免误下 151-pro 浪费流量。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { binaryInfo, ensureBinary } from "cloakbrowser";

import { isValidBrowserVersionPin } from "./license_resolver.js";
import { findAutoLocalKernel, findLocalKernel, isFingerprintOnlyKernelPin } from "./kernel_seed.js";

/** 与 cloakbrowser CHROMIUM_VERSION / 产品「免费核」预设一致 */
export const FREE_CHROMIUM_PIN = "146.0.7680.177.5";

/** 校验路径是真实存在的文件；Windows 下额外要求 .exe 后缀。 */
function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    if (!fs.statSync(filePath).isFile()) return false;
    if (process.platform === "win32") {
      return /\.exe$/i.test(filePath);
    }
    return true;
  } catch {
    return false;
  }
}

const LICENSE_KEY_BAK_SUFFIX = ".ai-browser-free-pin-bak";

function cloakbrowserCacheDir(): string {
  const fromEnv = process.env.CLOAKBROWSER_CACHE_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".cloakbrowser");
}

function resolveDownloadDir(customDir?: string | null): string {
  if (customDir?.trim()) {
    return path.resolve(customDir.trim());
  }
  // Default to current working directory's Kernel folder
  const kernelDir = path.join(process.cwd(), "Kernel");
  return kernelDir;
}

/**
 * 明确要走「免费 GitHub 二进制 + pin」路径（禁止带 Key 的 Pro/最新路由）。
 */
export function wantsKeylessFreePinDownload(browserVersion?: string | null): boolean {
  const pin = String(browserVersion ?? "").trim();
  if (!pin || !isValidBrowserVersionPin(pin)) {
    return false;
  }
  if (isFingerprintOnlyKernelPin(pin)) {
    return false;
  }
  // 官方免费核为 146.x；带 Free/Pro Key 调用 ensureBinary 会忽略 pin 去拉最新
  return pin === FREE_CHROMIUM_PIN || pin.startsWith("146.");
}

/**
 * ensureBinary 的 resolveLicenseKey：param > env > ~/.cloakbrowser/license.key。
 * 免费 pin 必须临时隐藏 env 与 license.key，否则仍会走 ensureProBinary。
 */
async function ensureBinaryWithoutAnyLicenseKey(
  pin: string | undefined,
  releaseChannel?: string,
): Promise<string> {
  const prevEnv = process.env.CLOAKBROWSER_LICENSE_KEY;
  delete process.env.CLOAKBROWSER_LICENSE_KEY;

  const keyFile = path.join(cloakbrowserCacheDir(), "license.key");
  const backupFile = `${keyFile}${LICENSE_KEY_BAK_SUFFIX}`;
  let parkedKeyFile = false;

  try {
    if (fs.existsSync(keyFile)) {
      try {
        if (fs.existsSync(backupFile)) {
          fs.unlinkSync(backupFile);
        }
      } catch {
        // ignore stale bak cleanup
      }
      fs.renameSync(keyFile, backupFile);
      parkedKeyFile = true;
    }
    return await ensureBinary(undefined, pin, releaseChannel);
  } finally {
    if (parkedKeyFile) {
      try {
        if (fs.existsSync(backupFile)) {
          if (fs.existsSync(keyFile)) {
            fs.unlinkSync(keyFile);
          }
          fs.renameSync(backupFile, keyFile);
        }
      } catch {
        // 恢复失败时不吞掉 ensure 结果；下次启动仍可从设置页 Key 注入
      }
    }
    if (prevEnv !== undefined) {
      process.env.CLOAKBROWSER_LICENSE_KEY = prevEnv;
    } else {
      delete process.env.CLOAKBROWSER_LICENSE_KEY;
    }
  }
}

export interface EnsureBinaryResult {
  chromePath: string;
  usedKeylessFreePin: boolean;
  /** Pro 下载失败（404/瞬时）被迫降级免费核时的原始报错，仅兜底时存在。 */
  fallbackReason?: string;
  /** 兜底降级后实际运行的内核版本；未兜底时为 undefined（沿用所选 pin）。 */
  effectiveVersion?: string;
  /** 命中本地运行目录内核（Browse/ Kernel/），未走网络下载。 */
  localKernelUsed?: boolean;
  /** 命中用户在设置中显式配置的内核路径（版本映射或全局路径），未走网络下载。 */
  customPathUsed?: boolean;
}

/** CloakBrowser 在「有效 License 但 Pro 包下载失败」时抛出的兜底型错误。 */
function isProBinaryDownloadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Pro binary unavailable");
}

export type EnsureBinaryOptions = {
  /** 仅设置页「下载内核/检查更新」应开启；环境启动默认 false，禁止自动联网下载。 */
  allowNetworkDownload?: boolean;
};

/**
 * 按产品语义 ensure：免费 pin → 无 Key + 固定版本；否则原样传 Key（Pro/自动最新）。
 *
 * 内核路径解析优先级（高 → 低）：
 * 1. 用户为该 pin 显式配置的路径（kernelPaths）：命中即用、跳过下载；文件缺失则直接报错。
 * 2. pin 为空（自动版本）时的全局浏览器路径（globalBrowserPath/cloak_path）。
 * 3. 本地运行目录内核（Browse/ Kernel/，findLocalKernel）；pin 为空（自动版本）且禁止联网时，
 *    回退本地最新免费系内核（findAutoLocalKernel），避免本机已有内核却报「未找到内核」。
 * 4. 仅当 allowNetworkDownload=true（手动下载/更新）时联网 ensure；启动路径禁止自动下载。
 */
export async function ensureBinaryHonoringVersionPin(
  licenseKey: string | undefined,
  browserVersion: string | undefined,
  releaseChannel?: string,
  bundledBrowseRoot?: string | null,
  kernelPaths?: Record<string, string> | null,
  globalBrowserPath?: string | null,
  customDownloadDir?: string | null,
  options?: EnsureBinaryOptions,
): Promise<EnsureBinaryResult> {
  const pin = String(browserVersion ?? "").trim() || undefined;
  const allowNetworkDownload = options?.allowNetworkDownload === true;

  // ① 版本映射：用户显式为该 pin 指定 chrome.exe → 跳过扫描与下载。
  if (pin) {
    const customPath = String(kernelPaths?.[pin] ?? "").trim();
    if (customPath) {
      if (isExecutableFile(customPath)) {
        return {
          chromePath: customPath,
          usedKeylessFreePin: false,
          customPathUsed: true,
        };
      }
      throw new Error(
        `版本 ${pin} 配置的内核路径不存在或不是可执行文件：${customPath}。` +
          "请到「设置 → 浏览器路径」修正，或删除该版本的自定义路径后手动下载内核。",
      );
    }
  }

  // ② 全局路径（cloak_path）：仅在自动版本（无 pin）时兜底；文件失效不阻断启动。
  if (!pin) {
    const globalPath = String(globalBrowserPath ?? "").trim();
    if (globalPath && isExecutableFile(globalPath)) {
      return {
        chromePath: globalPath,
        usedKeylessFreePin: false,
        customPathUsed: true,
      };
    }
  }

  // ③ 本地运行目录内核：命中即跳过网络下载（离线/便携可用）。
  if (pin) {
    const local = findLocalKernel(pin, bundledBrowseRoot);
    if (local) {
      return {
        chromePath: local.chromePath,
        usedKeylessFreePin: false,
        localKernelUsed: true,
        effectiveVersion: local.version,
      };
    }
  } else if (!allowNetworkDownload) {
    // 「自动版本」+ 启动路径（禁止联网）：回退本地免费系内核，
    // 避免「本机已有内核却报『未找到内核』」。
    // 手动「下载内核/检查更新」不做此回退 —— 否则 Pro 档位用户点了按钮
    // 也拿不到按 License 应得的最新 Pro，等于按钮失效。
    const auto = findAutoLocalKernel(bundledBrowseRoot);
    if (auto) {
      return {
        chromePath: auto.chromePath,
        usedKeylessFreePin: false,
        localKernelUsed: true,
        effectiveVersion: auto.version,
      };
    }
  }

  if (!allowNetworkDownload) {
    const pinStr = pin || "自动版本";
    throw new Error(
      `未找到内核 ${pinStr}。请先将内核放入运行目录下的 Kernel 文件夹，或到设置页面手动下载内核。` +
        `当前禁止启动时自动下载内核。`,
    );
  }

  const downloadRoot = resolveDownloadDir(customDownloadDir);
  const prevCacheDir = process.env.CLOAKBROWSER_CACHE_DIR;
  process.env.CLOAKBROWSER_CACHE_DIR = downloadRoot;
  try {
    fs.mkdirSync(downloadRoot, { recursive: true });
  } catch {
    // ensureBinary 仍会尝试写入；目录创建失败时交由下游报错
  }

  try {
    const keyless = wantsKeylessFreePinDownload(pin);

    if (keyless) {
      const chromePath = await ensureBinaryWithoutAnyLicenseKey(pin, releaseChannel);
      return { chromePath, usedKeylessFreePin: true };
    }

    // 离线打包的 Pro 指纹内核 + 无 License：复用已 seed 的 bundled pro；不可用则降级免费核。
    if (!licenseKey && isFingerprintOnlyKernelPin(pin)) {
      const bundled = binaryInfo(pin, releaseChannel);
      if (bundled.installed && bundled.binaryPath) {
        return { chromePath: bundled.binaryPath, usedKeylessFreePin: false };
      }
      const chromePath = await ensureBinaryWithoutAnyLicenseKey(
        FREE_CHROMIUM_PIN,
        releaseChannel,
      );
      return {
        chromePath,
        usedKeylessFreePin: true,
        fallbackReason: "bundled Pro kernel unavailable; fell back to free",
        effectiveVersion: FREE_CHROMIUM_PIN,
      };
    }

    try {
      const chromePath = await ensureBinary(licenseKey, pin, releaseChannel);
      return { chromePath, usedKeylessFreePin: false };
    } catch (error) {
      if (!isProBinaryDownloadFailure(error)) {
        throw error;
      }
      const fallbackReason = error instanceof Error ? error.message : String(error);
      const chromePath = await ensureBinaryWithoutAnyLicenseKey(
        FREE_CHROMIUM_PIN,
        releaseChannel,
      );
      return {
        chromePath,
        usedKeylessFreePin: true,
        fallbackReason,
        effectiveVersion: FREE_CHROMIUM_PIN,
      };
    }
  } finally {
    if (prevCacheDir !== undefined) {
      process.env.CLOAKBROWSER_CACHE_DIR = prevCacheDir;
    } else {
      delete process.env.CLOAKBROWSER_CACHE_DIR;
    }
  }
}
