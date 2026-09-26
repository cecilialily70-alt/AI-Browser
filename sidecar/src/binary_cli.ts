import { mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  binaryInfo,
  checkForUpdate,
} from "cloakbrowser";

import { loadCloakExtras } from "./cloakbrowser_extra.js";
import { ensureBinaryHonoringVersionPin } from "./ensure_binary_pin.js";
import type { ResolvedLicense } from "./license_resolver.js";
import {
  resolveBrowserVersionPin,
  resolveEffectiveLicenseKey,
  resolveReleaseChannel,
} from "./license_resolver.js";

type Action = "status" | "download" | "update" | "cleanup" | "diagnose";

const REMOTE_QUERY_TIMEOUT_MS = 5_000;

function parseArgs(argv: string[]): { action: Action; licenseKey?: string; browserVersion?: string; downloadDir?: string } {
  let action: Action = "status";
  let licenseKey: string | undefined;
  let browserVersion: string | undefined;
  let downloadDir: string | undefined;

  for (const raw of argv) {
    if (raw.startsWith("--action=")) {
      const value = raw.slice("--action=".length).trim().toLowerCase();
      if (
        value === "status" ||
        value === "download" ||
        value === "update" ||
        value === "cleanup" ||
        value === "diagnose"
      ) {
        action = value;
      } else {
        throw new Error(`unsupported action: ${value}`);
      }
    } else if (raw.startsWith("--license=")) {
      const value = raw.slice("--license=".length).trim();
      if (value) {
        licenseKey = value;
      }
    } else if (raw.startsWith("--browser-version=")) {
      const value = raw.slice("--browser-version=".length).trim();
      if (value) {
        browserVersion = value;
      }
    } else if (raw.startsWith("--download-dir=")) {
      const value = raw.slice("--download-dir=".length).trim();
      if (value) {
        downloadDir = value;
      }
    }
  }

  return { action, licenseKey, browserVersion, downloadDir };
}

function emit(ok: boolean, message: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      ok,
      message,
      data,
      ts: new Date().toISOString(),
    })}\n`,
  );
}

function cacheRoot(): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return path.join(home, ".cloakbrowser");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function listChromiumDirs(): Promise<string[]> {
  const root = cacheRoot();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function licenseMeta(licenseKey?: string, resolved?: ResolvedLicense) {
  const key = licenseKey?.trim();
  if (!key) {
    return {
      licenseValid: false,
      licensePlan: null as string | null,
      sessionSeatsActive: null as number | null,
      sessionSeatsLimit: null as number | null,
      sessionSeatsState: null as string | null,
    };
  }

  const extras = await loadCloakExtras();
  const { validateLicense } = await import("cloakbrowser");

  let licenseValid = false;
  let licensePlan = resolved?.plan ?? null;

  if (resolved?.licenseKey === key) {
    licenseValid = Boolean(resolved.licenseKey && !resolved.fallbackReason);
  } else {
    try {
      const info = await withTimeout(validateLicense(key), REMOTE_QUERY_TIMEOUT_MS, "validateLicense");
      licenseValid = Boolean(info?.valid);
      licensePlan = info?.plan ?? null;
    } catch {
      return {
        licenseValid: false,
        licensePlan: resolved?.plan ?? null,
        sessionSeatsActive: null,
        sessionSeatsLimit: null,
        sessionSeatsState: "unreachable",
      };
    }
  }

  let seats: Awaited<ReturnType<typeof extras.getSessionSeats>> | null = null;
  if (licenseValid) {
    try {
      seats = await withTimeout(extras.getSessionSeats(key), REMOTE_QUERY_TIMEOUT_MS, "getSessionSeats");
    } catch {
      seats = { active: null, limit: null, state: "unreachable", reason: "timeout" };
    }
  }

  return {
    licenseValid,
    licensePlan,
    sessionSeatsActive: seats?.active ?? null,
    sessionSeatsLimit: seats?.limit ?? null,
    sessionSeatsState: seats?.state ?? null,
  };
}

async function proReleaseMeta(releaseChannel: "stable" | "preview", licenseKey?: string) {
  if (!licenseKey?.trim()) {
    return {
      proLatestVersion: null as string | null,
      proResolvedChannel: null as string | null,
      proChannelFallback: null as boolean | null,
    };
  }

  const extras = await loadCloakExtras();
  try {
    const release = await withTimeout(
      extras.getProLatestRelease(releaseChannel),
      REMOTE_QUERY_TIMEOUT_MS,
      "getProLatestRelease",
    );
    return {
      proLatestVersion: release?.version ?? null,
      proResolvedChannel: release?.resolvedChannel ?? null,
      proChannelFallback: release?.fallback ?? null,
    };
  } catch {
    return {
      proLatestVersion: null,
      proResolvedChannel: null,
      proChannelFallback: null,
    };
  }
}

async function statusPayload(
  licenseKey?: string,
  browserVersion?: string,
  resolved?: ResolvedLicense,
) {
  const channel = resolveReleaseChannel(licenseKey);
  const versionPin = resolveBrowserVersionPin(browserVersion);
  const info = binaryInfo(versionPin, channel);
  const extras = await loadCloakExtras();
  const chromiumDirs = await listChromiumDirs();
  const keep = info.cacheDir ? path.resolve(info.cacheDir).toLowerCase() : "";
  const unusedCount = chromiumDirs.filter(
    (dir) => path.resolve(dir).toLowerCase() !== keep,
  ).length;

  const [license, proRelease] = await Promise.all([
    licenseMeta(licenseKey, resolved),
    proReleaseMeta(channel, licenseKey),
  ]);

  return {
    installed: Boolean(info.installed),
    version: info.version ?? null,
    bundledVersion: info.bundledVersion ?? null,
    tier: info.tier ?? null,
    platform: info.platform ?? null,
    binaryPath: info.binaryPath ?? null,
    cacheDir: info.cacheDir ?? null,
    cacheRoot: cacheRoot(),
    chromiumDirs,
    unusedCount,
    hasLicense: Boolean(licenseKey?.trim()),
    releaseChannel: channel,
    wrapperVersion: extras.WRAPPER_VERSION,
    browserVersionPin: versionPin ?? null,
    licenseKeySource: resolved?.source ?? null,
    ...license,
    ...proRelease,
  };
}

async function resolveForAction(rawKey?: string, browserVersion?: string) {
  const resolved = await resolveEffectiveLicenseKey(rawKey, "cli");
  const effectiveKey = resolved.licenseKey;
  const channel = resolveReleaseChannel(effectiveKey);
  const versionPin = resolveBrowserVersionPin(browserVersion);
  return { resolved, effectiveKey, channel, versionPin };
}

async function runDownload(licenseKey?: string, browserVersion?: string, downloadDir?: string) {
  const { resolved, effectiveKey, channel, versionPin } = await resolveForAction(licenseKey, browserVersion);
  const { chromePath, usedKeylessFreePin, fallbackReason, effectiveVersion } =
    await ensureBinaryHonoringVersionPin(
      effectiveKey,
      versionPin,
      channel,
      null,
      null,
      null,
      downloadDir,
      { allowNetworkDownload: true },
    );
  return {
    chromePath,
    ...(await statusPayload(effectiveKey, browserVersion, resolved)),
    installed: true,
    binaryPath: chromePath,
    licenseFallbackReason: resolved.fallbackReason ?? null,
    usedKeylessFreePin,
    message: fallbackReason
      ? `Pro 内核下载失败，已降级免费核 ${effectiveVersion ?? ""} 兜底（可稍后「检查更新」重试 Pro）`
      : usedKeylessFreePin
        ? `已按免费核固定版本下载（未走 License 最新 Pro 包）：${versionPin}`
        : versionPin
          ? `已按固定版本下载：${versionPin}`
          : undefined,
  };
}

async function runUpdate(licenseKey?: string, browserVersion?: string, downloadDir?: string) {
  const { resolved, effectiveKey, channel, versionPin } = await resolveForAction(licenseKey, browserVersion);
  let updatedTo: string | null = null;
  const before = binaryInfo(versionPin, channel);

  // 已指定完整 pin 时禁止「检查更新」跳到频道最新版，只 ensure 该 pin
  if (!versionPin) {
    if (effectiveKey) {
      const extras = await loadCloakExtras();
      updatedTo = (await extras.checkForProUpdate(effectiveKey, channel)) ?? null;
    } else {
      updatedTo = (await checkForUpdate()) ?? null;
    }
  }

  const { chromePath, usedKeylessFreePin, fallbackReason, effectiveVersion } =
    await ensureBinaryHonoringVersionPin(
      effectiveKey,
      versionPin,
      channel,
      null,
      null,
      null,
      downloadDir,
      { allowNetworkDownload: true },
    );
  const after = binaryInfo(versionPin, channel);
  if (!updatedTo && before.version && after.version && before.version !== after.version) {
    updatedTo = after.version ?? null;
  }

  return {
    updated: Boolean(updatedTo) || Boolean(before.version && after.version && before.version !== after.version),
    updatedTo: updatedTo ?? (before.version !== after.version ? after.version : null),
    chromePath,
    ...(await statusPayload(effectiveKey, browserVersion, resolved)),
    binaryPath: chromePath,
    licenseFallbackReason: resolved.fallbackReason ?? null,
    usedKeylessFreePin,
    message: fallbackReason
      ? `Pro 内核更新失败，已降级免费核 ${effectiveVersion ?? ""} 兜底（可稍后「检查更新」重试 Pro）`
      : usedKeylessFreePin
        ? `已按免费核固定版本 ensure（未跳到最新 Pro）：${versionPin}`
        : versionPin
          ? `已按固定版本 ensure：${versionPin}`
          : undefined,
  };
}

async function runCleanup(licenseKey?: string, browserVersion?: string) {
  const { resolved, effectiveKey, channel, versionPin } = await resolveForAction(licenseKey, browserVersion);
  const info = binaryInfo(versionPin, channel);
  const keepDir = info.installed && info.cacheDir ? path.resolve(info.cacheDir) : null;
  const dirs = await listChromiumDirs();
  const removed: string[] = [];

  for (const dir of dirs) {
    const resolvedDir = path.resolve(dir);
    if (keepDir && resolvedDir.toLowerCase() === keepDir.toLowerCase()) {
      continue;
    }
    await rm(resolvedDir, { recursive: true, force: true });
    removed.push(resolvedDir);
  }

  try {
    await mkdir(cacheRoot(), { recursive: true });
  } catch {
    // ignore
  }

  return {
    removed,
    removedCount: removed.length,
    ...(await statusPayload(effectiveKey, browserVersion, resolved)),
    licenseFallbackReason: resolved.fallbackReason ?? null,
  };
}

type DiagnosticCheck = {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
};

/** Equivalent to official `cloakbrowser info` — one-shot Pro/setup health report. */
async function runDiagnose(licenseKey?: string, browserVersion?: string) {
  const resolved = await resolveEffectiveLicenseKey(licenseKey, "cli");
  const status = await statusPayload(resolved.licenseKey, browserVersion, resolved);
  const checks: DiagnosticCheck[] = [];

  checks.push({
    id: "node",
    ok: true,
    title: "Node.js 运行时",
    detail: `${process.version} · ${process.platform}/${process.arch}`,
  });

  checks.push({
    id: "binary",
    ok: Boolean(status.installed && status.binaryPath),
    title: "内核二进制",
    detail: status.installed
      ? `${status.version ?? "?"} · ${status.tier ?? "?"} · ${status.binaryPath ?? ""}`
      : "未安装，请点「下载内核」或「检查更新」",
  });

  const cacheRootPath = String(status.cacheRoot ?? cacheRoot());
  let cacheWritable = false;
  try {
    await mkdir(cacheRootPath, { recursive: true });
    const probe = path.join(cacheRootPath, `.ai-browser-write-probe-${Date.now()}`);
    await writeFile(probe, "ok");
    await unlink(probe).catch(() => undefined);
    cacheWritable = true;
  } catch (error) {
    checks.push({
      id: "cache",
      ok: false,
      title: "缓存目录可写",
      detail: `${cacheRootPath} — ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (cacheWritable) {
    checks.push({
      id: "cache",
      ok: true,
      title: "缓存目录可写",
      detail: cacheRootPath,
    });
  }

  const hasKey = Boolean(resolved.licenseKey?.trim());
  checks.push({
    id: "license",
    ok: hasKey ? Boolean(status.licenseValid) : true,
    title: "License",
    detail: hasKey
      ? status.licenseValid
        ? `有效 · plan=${status.licensePlan ?? "?"} · source=${resolved.source}`
        : `未通过验证 · ${resolved.fallbackReason ?? "请检查密钥/网络"}（启动时会自动改用内置免费 Key）`
      : "未配置 cb_ License Key（启动环境时自动使用内置免费 Key）",
  });

  const active = status.sessionSeatsActive;
  const limit = status.sessionSeatsLimit;
  if (typeof active === "number" && typeof limit === "number" && limit > 0) {
    const full = active >= limit;
    checks.push({
      id: "seats",
      ok: !full,
      title: "会话席位",
      detail: full
        ? `已占满 ${active}/${limit}。请先停止其它环境，或等待强杀超时（约 15 分钟）释放。`
        : `${active}/${limit} · state=${status.sessionSeatsState ?? "ok"}`,
    });
  } else if (hasKey) {
    checks.push({
      id: "seats",
      ok: status.sessionSeatsState !== "unreachable",
      title: "会话席位",
      detail:
        status.sessionSeatsState === "unreachable"
          ? "席位查询失败（授权服务器不可达）。企业网可开启「授权检查走代理」。"
          : "暂无席位数据（可能为 Free 或查询跳过）",
    });
  }

  checks.push({
    id: "pro_channel",
    ok: status.tier === "pro" || Boolean(status.proLatestVersion),
    title: "Pro 通道",
    detail:
      status.tier === "pro"
        ? `当前 Pro 内核 ${status.version ?? "?"}${status.proLatestVersion ? ` · 服务端最新 ${status.proLatestVersion}` : ""}`
        : status.proLatestVersion
          ? `服务端最新 Pro ${status.proLatestVersion}；本地仍为 Free，请保存有效 License 后点「检查更新」`
          : "未能查询 Pro 最新版本（无 Key 或网络不可达）",
  });

  let geoipOk = false;
  let geoipDetail = "mmdb-lib 未安装";
  try {
    // mmdb-lib 是 optionalDependency，只做「能否解析」探测。
    // 用 createRequire().resolve 而非 import()：可选依赖缺失时不得让 tsc 编译报错。
    createRequire(import.meta.url).resolve("mmdb-lib");
    geoipOk = true;
    geoipDetail = "mmdb-lib 可用（geoip 解析依赖就绪）";
  } catch {
    geoipDetail = "mmdb-lib 不可用；天枢台有代理时走预查 Fail-Fast，不依赖内置 mmdb 回退";
    geoipOk = true; // not a hard fail for our product path
  }
  checks.push({
    id: "geoip",
    ok: geoipOk,
    title: "GeoIP 依赖",
    detail: geoipDetail,
  });

  checks.push({
    id: "fonts",
    ok: process.platform === "win32",
    title: "系统字体",
    detail:
      process.platform === "win32"
        ? "Windows 桌面端使用本机真实字体（无需 Docker 字体拷贝）"
        : "非 Windows：裸 Linux/Docker 需自行安装真实 Windows 字体（官方 tip 2）",
  });

  checks.push({
    id: "launch_policy",
    ok: true,
    title: "启动策略（天枢台）",
    detail:
      "launchPersistentContext · geoip=强制开 · humanize=careful · headless=false · stealthArgs=false · chromiumSandbox=true",
  });

  const failed = checks.filter((c) => !c.ok);
  const summary =
    failed.length === 0
      ? "诊断通过：Pro/运行环境检查未见阻断项"
      : `诊断发现 ${failed.length} 项需处理：${failed.map((c) => c.title).join("、")}`;

  return {
    ...status,
    licenseFallbackReason: resolved.fallbackReason ?? null,
    diagnosticOk: failed.length === 0,
    diagnosticSummary: summary,
    checks,
  };
}

async function main(): Promise<void> {
  try {
    const { action, licenseKey, browserVersion, downloadDir } = parseArgs(process.argv.slice(2));

    if (action === "status") {
      const resolved = await resolveEffectiveLicenseKey(licenseKey, "cli");
      emit(true, "binary_status", {
        ...(await statusPayload(resolved.licenseKey, browserVersion, resolved)),
        licenseFallbackReason: resolved.fallbackReason ?? null,
      });
      return;
    }
    if (action === "download") {
      emit(true, "binary_downloaded", await runDownload(licenseKey, browserVersion, downloadDir));
      return;
    }
    if (action === "update") {
      emit(true, "binary_updated", await runUpdate(licenseKey, browserVersion, downloadDir));
      return;
    }
    if (action === "cleanup") {
      emit(true, "binary_cleaned", await runCleanup(licenseKey, browserVersion));
      return;
    }
    if (action === "diagnose") {
      emit(true, "binary_diagnosed", await runDiagnose(licenseKey, browserVersion));
      return;
    }

    throw new Error(`unsupported action: ${action}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(false, "binary_cli_failed", { error: message });
    process.exitCode = 1;
  }
}

void main();
