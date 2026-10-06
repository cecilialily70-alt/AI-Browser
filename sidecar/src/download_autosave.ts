import { createHash } from "node:crypto";
import { access, copyFile, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Browser, BrowserContext, CDPSession, Download, Page } from "playwright-core";

import type { JsonLogger } from "./json-logger.js";

/** 系统用户 Downloads 目录（Windows: C:\Users\<name>\Downloads） */
export function resolveUserDownloadsDir(): string {
  return path.join(os.homedir(), "Downloads");
}

function sanitizeFilename(name: string): string {
  const base = path
    .basename(String(name || "").trim())
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return base.length > 0 ? base.slice(0, 180) : `download-${Date.now()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveUniqueTargetPath(dir: string, filename: string): Promise<string> {
  const safe = sanitizeFilename(filename);
  let target = path.join(dir, safe);
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext) || "download";
  let index = 1;
  while (true) {
    try {
      await access(target);
      target = path.join(dir, `${stem} (${index})${ext}`);
      index += 1;
    } catch {
      return target;
    }
  }
}

/**
 * 目标目录：可以是固定字符串，也可以是「下载发生时才求值」的回调。
 * 回调形式让 profileId、用户设置的热更新无需重新挂载监听器即可生效。
 */
export type DownloadDirProvider = string | (() => string);

function resolveDownloadsDir(provider: DownloadDirProvider): string {
  const raw = typeof provider === "function" ? provider() : provider;
  const trimmed = String(raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : resolveUserDownloadsDir();
}

/** 同一个 Download 实例可能同时从 page 与 context 冒泡，只允许处理一次。 */
const handledDownloads = new WeakSet<Download>();
const hookedPages = new WeakSet<Page>();
const hookedContexts = new WeakSet<BrowserContext>();
/** 正在执行 Agent/RPA 点击下载的页面：该次下载由自动化调用方自行落盘。 */
const automationPages = new WeakSet<Page>();

/** 浏览器级 CDP 会话（复用，避免每次下发下载行为都新建会话）。 */
const browserSessions = new WeakMap<Browser, Promise<CDPSession>>();

/**
 * 已被我们改写成「Chrome 自己按真实文件名落盘」的浏览器 → 目标目录。
 * 用于判断某次下载事件该走「确认落盘」还是回退到 `saveAs`。
 */
const appliedDownloadDirs = new WeakMap<Browser, string>();

/** Chrome 下载未完成时的临时后缀；带此后缀的文件不算落盘完成。 */
const PARTIAL_DOWNLOAD_SUFFIX = ".crdownload";

function browserSession(browser: Browser): Promise<CDPSession> {
  const cached = browserSessions.get(browser);
  if (cached) {
    return cached;
  }
  const pending = browser.newBrowserCDPSession();
  browserSessions.set(browser, pending);
  return pending;
}

/**
 * 把「浏览器级下载落盘目录」指向用户配置的下载目录（Chrome `behavior=allow`）。
 *
 * 为什么必须改这里：Playwright（无论 `launchPersistentContext` 还是 `connectOverCDP`）
 * 都会下发 `Browser.setDownloadBehavior { behavior: "allowAndName", downloadPath: <自己的临时
 * artifacts 目录> }`。于是 Chrome 把每次下载都写成 GUID 临时文件：
 * 浏览器下载列表显示一串乱码 GUID，临时目录被回收后条目就成了死链——这正是
 * 「手动下载的文件找不到」的根因。改用 `allow` 后由 Chrome 自己按**真实文件名**写进目标
 * 目录，下载列表名称/路径与实际文件一致；`page.on('download')` 事件仍然照常触发。
 *
 * 幂等：重复调用或换目录都安全。任何另一个 CDP 客户端（cookies CLI、元素提取等）连上来
 * 都会重新抢回 allowAndName，因此需要 `guardBrowserDownloadDir` 周期性纠正。
 */
export async function applyBrowserDownloadDir(
  browser: Browser,
  provider: DownloadDirProvider,
  logger: JsonLogger,
  profileId: string,
  options: { silent?: boolean } = {},
): Promise<string | null> {
  const downloadsDir = resolveDownloadsDir(provider);
  try {
    await mkdir(downloadsDir, { recursive: true });
    const session = await browserSession(browser);
    await session.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadsDir,
      eventsEnabled: true,
    });
    if (!options.silent) {
      logger.progress("download_dir_applied", { profileId, downloadsDir });
    }
    appliedDownloadDirs.set(browser, downloadsDir);
    return downloadsDir;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.silent) {
      logger.warn("download_dir_apply_failed", { profileId, downloadsDir, error: message });
    }
    return null;
  }
}

/**
 * 下载目录守护：其它 CDP 客户端每次 `connectOverCDP` 都会重新下发 `allowAndName`，
 * 把落盘位置抢回它们自己的临时目录。这里周期性核对并纠正，保证手动下载始终落在
 * 用户配置的目录（只在目录值变化时打印日志，避免刷屏）。
 */
export function guardBrowserDownloadDir(
  browser: Browser,
  provider: DownloadDirProvider,
  logger: JsonLogger,
  profileId: string,
  intervalMs = 5_000,
): () => void {
  let stopped = false;
  // 同一个目录只上报一次（成功或失败），避免每 5s 刷屏；目录变化时重新上报。
  let lastAttemptedDir: string | null = null;
  const tick = async (): Promise<void> => {
    if (stopped || !browser.isConnected()) {
      return;
    }
    const desired = resolveDownloadsDir(provider);
    await applyBrowserDownloadDir(browser, () => desired, logger, profileId, {
      silent: desired === lastAttemptedDir,
    });
    lastAttemptedDir = desired;
  };
  void tick();
  const timer = setInterval(() => void tick(), Math.max(1_000, intervalMs));
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function listDirFiles(dir: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(PARTIAL_DOWNLOAD_SUFFIX)) {
        continue;
      }
      const info = await stat(path.join(dir, entry.name)).catch(() => null);
      if (info && info.size > 0) {
        found.set(entry.name, info.mtimeMs);
      }
    }
  } catch {
    // 目录尚未创建：视为空
  }
  return found;
}

/** `report.pdf` 命中 `report.pdf` / `report (1).pdf`（Chrome 同名自动加序号）。 */
export function matchesDownloadName(name: string, expected: string): boolean {
  if (name === expected) {
    return true;
  }
  const ext = path.extname(expected);
  const stem = path.basename(expected, ext);
  if (!stem || path.extname(name).toLowerCase() !== ext.toLowerCase()) {
    return false;
  }
  const candidateStem = path.basename(name, path.extname(name));
  return candidateStem.startsWith(stem) && /^ \(\d+\)$/.test(candidateStem.slice(stem.length));
}

/**
 * 等待「本次下载」的文件在目录里落盘完成。
 *
 * Chrome 在 `behavior=allow` 下先写 `<name>.crdownload`，完成后再改成正式文件名，
 * 所以「出现不带 .crdownload 后缀的非空、且文件名匹配」即代表落盘完成。
 * 严格按文件名匹配（含 Chrome 的 ` (n)` 去重后缀），避免把同目录里其它下载/旧文件
 * 误认成本次结果；函数开始时的目录快照则用于排除同名旧文件。
 */
export async function waitForNewDownload(
  dir: string,
  expectedName: string,
  notBefore: number,
  timeoutMs = 3_000,
): Promise<string | null> {
  const expected = sanitizeFilename(expectedName);
  const baseline = new Set((await listDirFiles(dir)).keys());
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const files = await listDirFiles(dir);
    for (const [name, mtimeMs] of files) {
      if (baseline.has(name) || mtimeMs < notBefore) {
        continue;
      }
      if (matchesDownloadName(name, expected)) {
        return path.join(dir, name);
      }
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await delay(120);
  }
}

/** 跨卷安全地移动文件（先 rename，失败退化为 copy + unlink）。 */
export async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch {
    await copyFile(source, target);
    await unlink(source).catch(() => undefined);
  }
}

/**
 * 暂停指定页面上的「手动下载接管」。
 *
 * Agent 的 `downloadTriggeredFile` 会把下载文件挪到爬虫目录；若不暂停，同一次下载会被
 * 全局接管再处理一次，造成重复文件/重复日志。
 * 返回的函数用于恢复（幂等）。
 */
export function suspendDownloadTakeover(page: Page): () => void {
  automationPages.add(page);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    automationPages.delete(page);
  };
}

/** 跨进程去重窗口：仅兜底 `saveAs` 路径需要（同一 URL+文件名只另存一次）。 */
const CROSS_PROCESS_CLAIM_WINDOW_MS = 10_000;

function claimsDir(): string {
  return path.join(os.tmpdir(), "ai-browser-download-claims");
}

/**
 * 跨进程去重（兜底路径专用）。
 *
 * 启动进程与 `connectOverCDP` 的 Agent 进程都可能收到同一个 `Browser.downloadWillBegin`。
 * 正常情况下 Chrome 已自行落盘、两侧都只读不写；只有回退到 `saveAs` 时才需要用系统
 * 临时目录里的原子创建文件（`wx`）抢占，避免同一次下载在两个目录里各落一份。
 */
async function claimDownload(download: Download): Promise<boolean> {
  const bucket = Math.floor(Date.now() / CROSS_PROCESS_CLAIM_WINDOW_MS);
  const key = createHash("sha1")
    .update(`${download.url()}|${download.suggestedFilename()}|${bucket}`)
    .digest("hex");
  const dir = claimsDir();
  try {
    await mkdir(dir, { recursive: true });
    const handle = await open(path.join(dir, key), "wx");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/** 兜底：浏览器仍处于 Playwright `allowAndName` 模式时，把临时 GUID 文件另存出来。 */
async function saveDownloadAs(
  download: Download,
  downloadsDir: string,
  logger: JsonLogger,
  profileId: string,
): Promise<void> {
  if (!(await claimDownload(download))) {
    return;
  }
  const suggested = download.suggestedFilename();
  const target = await resolveUniqueTargetPath(downloadsDir, suggested);
  await download.saveAs(target);
  logger.progress("download_saved", {
    profileId,
    suggested,
    path: target,
    url: download.url(),
    mode: "save-as",
  });
}

/** 下载落盘完成后写入目标目录所需的最长等待（含小文件写盘与 .crdownload 改名）。 */
const NATIVE_DOWNLOAD_WAIT_MS = 4_000;

async function persistDownload(
  download: Download,
  provider: DownloadDirProvider,
  logger: JsonLogger,
  profileId: string,
  browserManaged: boolean,
): Promise<void> {
  if (handledDownloads.has(download)) {
    return;
  }
  handledDownloads.add(download);

  const downloadsDir = resolveDownloadsDir(provider);
  const suggested = download.suggestedFilename();
  // 事件在下载「开始」时触发，Chrome 稍后才写盘；留 2s 时钟余量避免误判旧文件。
  const startedAt = Date.now() - 2_000;
  try {
    const placed = await waitForNewDownload(
      downloadsDir,
      suggested,
      startedAt,
      NATIVE_DOWNLOAD_WAIT_MS,
    );
    if (placed) {
      logger.progress("download_saved", {
        profileId,
        suggested,
        path: placed,
        url: download.url(),
        mode: "browser-native",
      });
      return;
    }
    if (browserManaged) {
      // Chrome 已经自己落盘，只是文件名与 suggestedFilename 对不上（内核做了重命名/拦截）。
      // 此时不能再用 saveAs 覆盖，只如实上报「未确认」，避免把成功报成失败。
      logger.warn("download_unconfirmed", {
        profileId,
        suggested,
        downloadsDir,
        url: download.url(),
      });
      return;
    }
    await saveDownloadAs(download, downloadsDir, logger, profileId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("download_save_failed", {
      profileId,
      error: message,
      suggested,
      url: download.url(),
      downloadsDir,
    });
  }
}

function attachPageDownloadHandler(
  page: Page,
  provider: DownloadDirProvider,
  logger: JsonLogger,
  profileId: string,
): void {
  if (hookedPages.has(page)) {
    return;
  }
  hookedPages.add(page);
  page.on("download", (download) => {
    if (automationPages.has(page)) {
      return;
    }
    const browser = page.context().browser();
    const browserManaged = browser ? appliedDownloadDirs.has(browser) : false;
    void persistDownload(download, provider, logger, profileId, browserManaged);
  });
}

/**
 * 在「每个 Page」上挂 `download` 监听，记录手动下载的落盘结果。
 *
 * 为什么必须逐页挂而不是只挂 context：
 * - `target="_blank"` 触发的下载在 headed 持久化 context 下可能只在具体页面冒泡；
 * - 逐页挂载会强制 Playwright 初始化该页面，避免 `_onDownloadWillBegin` 因页面未初始化而丢事件。
 *
 * 幂等：同一 context 重复调用不会叠加监听器。
 */
export function installDownloadAutoSave(
  context: BrowserContext,
  logger: JsonLogger,
  profileId: string,
  downloadsDir: DownloadDirProvider = resolveUserDownloadsDir(),
): void {
  if (hookedContexts.has(context)) {
    return;
  }
  hookedContexts.add(context);

  // 先挂 context 的 page 监听，避免「枚举已有页面」与「新页面创建」之间的竞态。
  context.on("page", (page) => attachPageDownloadHandler(page, downloadsDir, logger, profileId));
  for (const page of context.pages()) {
    attachPageDownloadHandler(page, downloadsDir, logger, profileId);
  }
}

/**
 * 通过 CDP 连接的 Sidecar 侧安装（含 `connectOverCDP` 拿到的所有 context）。
 *
 * `chromium.connectOverCDP()` 会再次下发 `Browser.setDownloadBehavior`（`allowAndName` +
 * 它自己的临时 artifactsDir），全局覆盖启动进程的下载行为——用户手动点的下载也被这侧接管。
 * 因此除了挂事件监听，还必须用 `applyBrowserDownloadDir` 把落盘目录纠正回来。
 */
export function installDownloadAutoSaveOnBrowser(
  browser: Browser,
  logger: JsonLogger,
  profileId: string,
  downloadsDir: DownloadDirProvider = resolveUserDownloadsDir(),
): void {
  for (const context of browser.contexts()) {
    installDownloadAutoSave(context, logger, profileId, downloadsDir);
  }
}
