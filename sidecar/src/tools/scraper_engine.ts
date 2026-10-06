/**
 * Hybrid Scraper Engine — DOM extract, network intercept, file/media download.
 * Supports iframe pierce, lazy-load auto-scroll, soft-fail fields.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { FrameLocator, Locator, Page, Response } from "playwright-core";

import {
  getResolvedDownloadPath,
  getUniqueResolvedDownloadPath,
  sanitizeDownloadFilename,
} from "../utils/file_manager.js";
import {
  moveFile,
  suspendDownloadTakeover,
  waitForNewDownload,
} from "../download_autosave.js";

/** One scraped row: field → text/attr value, or null when node/attr missing. */
export type ScraperRow = Record<string, string | null>;

export type ExtractDomDataOptions = {
  maxItems?: number;
  iframeSelector?: string;
  autoScroll?: boolean;
  autoScrollTimeoutMs?: number;
  /** Required when fields use @download — files land under scraper/{profileId}/ */
  profileId?: string;
};

export type InterceptNetworkDataOptions = {
  timeoutMs?: number;
  okOnly?: boolean;
};

export type NetworkInterceptResult<T = unknown> = {
  url: string;
  status: number;
  data: T;
};

export type FileDownloadResult =
  | { success: true; localPath: string; filename: string }
  | { success: false; error: string };

export type ScrapePageDataInput =
  | {
      mode: "dom";
      containerSelector?: string;
      fields?: Record<string, string>;
      /** Natural-language goal when selectors are omitted */
      targetDescription?: string;
      /** Required for auto-inference when selectors missing */
      aiSettings?: import("../engine.js").SidecarAiSettings;
      maxItems?: number;
      iframeSelector?: string;
      autoScroll?: boolean;
      autoScrollTimeoutMs?: number;
      append?: boolean;
      profileId?: string;
    }
  | {
      mode: "network";
      urlPattern: string;
      timeoutMs?: number;
      okOnly?: boolean;
      append?: boolean;
    }
  | {
      mode: "file_download";
      clickSelector: string;
      profileId: string;
      timeoutMs?: number;
      append?: boolean;
    }
  | {
      mode: "media_save";
      selector: string;
      attribute?: string;
      profileId: string;
      append?: boolean;
    };

/**
 * Field selector syntax:
 * - `.price` → trimmed innerText
 * - `a.buy@href` → getAttribute("href")
 * - `@href` → attribute on the container itself
 * - `img@download` → default attr src, then download to local path
 * - `img.avatar@src@download` / `img@data-src@download` → explicit attr + download
 */
function parseFieldSpec(spec: string): {
  selector: string;
  attr: string | null;
  download: boolean;
} {
  let trimmed = String(spec ?? "").trim();
  let download = false;
  if (/@download$/i.test(trimmed)) {
    download = true;
    trimmed = trimmed.replace(/@download$/i, "").trim();
  }

  if (!trimmed) {
    return { selector: "", attr: download ? "src" : null, download };
  }

  const at = trimmed.lastIndexOf("@");
  if (at < 0) {
    return { selector: trimmed, attr: download ? "src" : null, download };
  }

  const maybeAttr = trimmed.slice(at + 1).trim();
  if (/^[A-Za-z_][\w:-]*$/.test(maybeAttr)) {
    return {
      selector: trimmed.slice(0, at).trim(),
      attr: maybeAttr,
      download,
    };
  }
  return { selector: trimmed, attr: download ? "src" : null, download };
}

function resolveDomScope(page: Page, iframeSelector?: string): Page | FrameLocator {
  const sel = String(iframeSelector ?? "").trim();
  if (!sel) {
    return page;
  }
  return page.frameLocator(sel);
}

function containerLocator(scope: Page | FrameLocator, containerSelector: string): Locator {
  return scope.locator(containerSelector);
}

type FieldSpecArg = {
  key: string;
  selector: string;
  attr: string | null;
  download: boolean;
};

function buildEvaluateAllArg(fieldSpecs: FieldSpecArg[], maxItems?: number) {
  return { fieldSpecs, maxItems };
}

/**
 * Smooth scroll toward bottom to trigger lazy / waterfall loads.
 * Hard caps: wall-clock timeoutMs (2–15s) AND maxTicks (true infinite feeds cannot hang forever).
 */
export async function autoScrollForLazyLoad(
  page: Page,
  options: { iframeSelector?: string; timeoutMs?: number } = {},
): Promise<{ scrolled: boolean; ticks: number }> {
  const timeoutMs = Math.min(15_000, Math.max(2_000, options.timeoutMs ?? 8_000));
  /** Absolute tick ceiling (~280ms sleep → ~40 ticks ≈ 11s before timeout usually wins first). */
  const maxTicks = 40;
  const iframeSel = String(options.iframeSelector ?? "").trim();

  const scrollFn = async (
    _el: Element,
    arg: { timeout: number; maxTicks: number },
  ): Promise<number> => {
    const { timeout, maxTicks: tickCap } = arg;
    const doc = _el.ownerDocument || document;
    const started = Date.now();
    let ticks = 0;
    let stableRounds = 0;
    let lastHeight = 0;
    const root = doc.scrollingElement || doc.documentElement || doc.body;
    const win = doc.defaultView;
    if (!root || !win) {
      return 0;
    }
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    while (Date.now() - started < timeout && ticks < tickCap) {
      const step = Math.max(240, Math.floor(win.innerHeight * 0.7));
      win.scrollBy(0, step);
      ticks += 1;
      await sleep(280);
      const height = root.scrollHeight;
      const atBottom = win.scrollY + win.innerHeight >= height - 4;
      if (height <= lastHeight + 2) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        lastHeight = height;
      }
      if (stableRounds >= 3 && atBottom) {
        break;
      }
      if (stableRounds >= 2 && !atBottom) {
        win.scrollBy(0, step);
        await sleep(350);
      }
    }
    return ticks;
  };

  const scrollArg = { timeout: timeoutMs, maxTicks };

  try {
    if (iframeSel) {
      await assertIframeReady(page, iframeSel, 5_000);
      const ticks = await page
        .frameLocator(iframeSel)
        .locator("html")
        .first()
        .evaluate(scrollFn, scrollArg, { timeout: timeoutMs + 2_000 });
      return { scrolled: true, ticks: Number(ticks) || 0 };
    }
    const ticks = await page.evaluate(async (arg: { timeout: number; maxTicks: number }) => {
      const { timeout, maxTicks: tickCap } = arg;
      const started = Date.now();
      let ticksInner = 0;
      let stableRounds = 0;
      let lastHeight = 0;
      const root = document.scrollingElement || document.documentElement || document.body;
      if (!root) return 0;
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      while (Date.now() - started < timeout && ticksInner < tickCap) {
        const step = Math.max(240, Math.floor(window.innerHeight * 0.7));
        window.scrollBy(0, step);
        ticksInner += 1;
        await sleep(280);
        const height = root.scrollHeight;
        const atBottom = window.scrollY + window.innerHeight >= height - 4;
        if (height <= lastHeight + 2) {
          stableRounds += 1;
        } else {
          stableRounds = 0;
          lastHeight = height;
        }
        if (stableRounds >= 3 && atBottom) break;
        if (stableRounds >= 2 && !atBottom) {
          window.scrollBy(0, step);
          await sleep(350);
        }
      }
      return ticksInner;
    }, scrollArg);
    return { scrolled: true, ticks: Number(ticks) || 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/未找到目标 iframe/.test(msg)) {
      throw err;
    }
    return { scrolled: false, ticks: 0 };
  }
}

/** Fail-fast when iframeSelector is set but the frame never appears. */
async function assertIframeReady(
  page: Page,
  iframeSelector: string,
  timeoutMs = 5_000,
): Promise<void> {
  const sel = String(iframeSelector ?? "").trim();
  if (!sel) {
    return;
  }
  try {
    await page.locator(sel).first().waitFor({ state: "attached", timeout: timeoutMs });
    await page
      .frameLocator(sel)
      .locator("body")
      .first()
      .waitFor({ state: "attached", timeout: timeoutMs });
  } catch {
    throw new Error(`未找到目标 iframe: ${sel}`);
  }
}

/**
 * Structured DOM extract. Missing children / attrs → null.
 */
export async function extractDomData(
  page: Page,
  containerSelector: string,
  fields: Record<string, string>,
  options: ExtractDomDataOptions = {},
): Promise<ScraperRow[]> {
  const container = String(containerSelector ?? "").trim();
  if (!container) {
    throw new Error("extractDomData: containerSelector is required");
  }
  if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
    throw new Error("extractDomData: fields must be a non-empty object");
  }

  const fieldSpecs: FieldSpecArg[] = Object.entries(fields).map(([key, spec]) => {
    const parsed = parseFieldSpec(spec);
    return {
      key,
      selector: parsed.selector,
      attr: parsed.attr,
      download: parsed.download,
    };
  });

  const maxItems =
    typeof options.maxItems === "number" && options.maxItems > 0
      ? Math.floor(options.maxItems)
      : undefined;

  const iframeSelector = String(options.iframeSelector ?? "").trim() || undefined;
  const profileId = String(options.profileId ?? "").trim();
  const downloadKeys = fieldSpecs.filter((f) => f.download).map((f) => f.key);
  if (downloadKeys.length > 0 && !profileId) {
    throw new Error("fields 含 @download 时必须提供 profileId 以落盘到 scraper 目录");
  }

  if (iframeSelector) {
    await assertIframeReady(page, iframeSelector, 5_000);
  }

  if (options.autoScroll) {
    await autoScrollForLazyLoad(page, {
      iframeSelector,
      timeoutMs: options.autoScrollTimeoutMs,
    });
  }

  const scope = resolveDomScope(page, iframeSelector);
  const listLocator = containerLocator(scope, container);

  let rows: ScraperRow[];
  try {
    const count = await listLocator.count();
    if (count === 0) {
      try {
        await listLocator.first().waitFor({ state: "attached", timeout: 3_000 });
      } catch {
        return [];
      }
    }

    rows = (await listLocator.evaluateAll((elements, arg) => {
      const { fieldSpecs: specs, maxItems: limit } = arg as {
        fieldSpecs: FieldSpecArg[];
        maxItems?: number;
      };
      const read = (
        root: Element,
        selector: string,
        attr: string | null,
        asDownload: boolean,
      ): string | null => {
        try {
          const el = selector ? root.querySelector(selector) : root;
          if (!el) return null;
          // @download always reads a URL attribute (default src)
          const effectiveAttr = asDownload ? attr || "src" : attr;
          if (effectiveAttr) {
            let raw = el.getAttribute(effectiveAttr);
            if ((!raw || !raw.trim()) && effectiveAttr === "src") {
              raw =
                (el as HTMLImageElement).currentSrc ||
                el.getAttribute("data-src") ||
                el.getAttribute("data-original") ||
                "";
            }
            if (raw === null || raw === undefined) return null;
            const v = String(raw).trim();
            return v.length > 0 ? v : null;
          }
          const htmlEl = el as HTMLElement;
          const text = (htmlEl.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
          return text.length > 0 ? text : null;
        } catch {
          return null;
        }
      };
      const out: Array<Record<string, string | null>> = [];
      const list = typeof limit === "number" ? elements.slice(0, limit) : elements;
      for (const el of list) {
        const row: Record<string, string | null> = {};
        // Pass 1: plain text / attr fields (used later for smart @download filenames)
        for (const spec of specs) {
          if (spec.download) continue;
          row[spec.key] = read(el, spec.selector, spec.attr, false);
        }
        // Pass 2: @download URL attributes
        for (const spec of specs) {
          if (!spec.download) continue;
          row[spec.key] = read(el, spec.selector, spec.attr, true);
        }
        out.push(row);
      }
      return out;
    }, buildEvaluateAllArg(fieldSpecs, maxItems))) as ScraperRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/未找到目标 iframe/.test(msg)) {
      throw err;
    }
    if (/Timeout|waiting for/i.test(msg)) {
      return [];
    }
    throw err;
  }

  // Bridge @download → context.request download (proxy/cookies aligned with browser)
  if (downloadKeys.length > 0) {
    const baseUrl = page.url();
    const downloadKeySet = new Set(downloadKeys);
    type Job = { row: ScraperRow; key: string; url: string; preferredBaseName: string | null };
    const jobs: Job[] = [];
    for (const row of rows) {
      const preferredBaseName = pickAssociatedNameFromRow(row, downloadKeySet);
      for (const key of downloadKeys) {
        const rawUrl = row[key];
        if (!rawUrl) continue;
        try {
          jobs.push({
            row,
            key,
            url: new URL(rawUrl, baseUrl).toString(),
            preferredBaseName,
          });
        } catch {
          row[key] = null;
        }
      }
    }

    const CONCURRENCY = 6;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, jobs.length)) }, async () => {
      while (cursor < jobs.length) {
        const idx = cursor;
        cursor += 1;
        const job = jobs[idx];
        if (!job) continue;
        const result = await downloadMediaFromUrl(page, job.url, profileId, {
          preferredBaseName: job.preferredBaseName,
        });
        job.row[job.key] = result.success ? result.localPath : null;
      }
    });
    await Promise.all(workers);
  }

  return rows;
}

/** Keys that look like a human-readable title / name for smart filenames. */
const ASSOCIATED_NAME_KEY_RE = /名|标题|title|name/i;

/** Illegal filename chars per product rule + collapse whitespace to underscore. */
export function sanitizeSmartNamePart(value: string): string {
  return String(value ?? "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

/**
 * Prefer fields whose key contains 名/标题/title/name; else first non-empty text field.
 * Skips @download keys (URLs / paths).
 */
export function pickAssociatedNameFromRow(
  row: ScraperRow,
  excludeKeys: Iterable<string> = [],
): string | null {
  const excluded = new Set(Array.from(excludeKeys));
  const candidates: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(row)) {
    if (excluded.has(key)) continue;
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Skip values that look like URLs / absolute paths (not titles)
    if (/^https?:\/\//i.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
      continue;
    }
    candidates.push({ key, value: trimmed });
  }
  if (candidates.length === 0) {
    return null;
  }
  const preferred = candidates.find((c) => ASSOCIATED_NAME_KEY_RE.test(c.key));
  const picked = preferred ?? candidates[0]!;
  const cleaned = sanitizeSmartNamePart(picked.value);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * `{清洗名称}.ext` when a title exists; otherwise `{stem}-{hash}.ext`.
 */
export function buildSmartDownloadFilename(
  preferredBaseName: string | null | undefined,
  mediaUrl: string,
  fallbackExt = "",
): string {
  const fromUrl = guessFilenameFromUrl(mediaUrl, fallbackExt);
  let ext = path.extname(fromUrl);
  if (!ext && fallbackExt) {
    ext = fallbackExt.startsWith(".") ? fallbackExt : `.${fallbackExt}`;
  }
  if (!ext) {
    ext = ".bin";
  }
  const tag = createHash("sha1").update(String(mediaUrl)).digest("hex").slice(0, 8);
  const smart = preferredBaseName ? sanitizeSmartNamePart(preferredBaseName) : "";
  if (smart) {
    return sanitizeDownloadFilename(`${smart}${ext}`);
  }
  const stem = path.basename(fromUrl, path.extname(fromUrl)) || "media";
  return sanitizeDownloadFilename(`${stem}-${tag}${ext}`);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(escaped, "i");
}

function matchUrlPattern(url: string, urlPattern: string): boolean {
  const p = String(urlPattern ?? "").trim();
  if (!p) return false;
  if (p.startsWith("re:") || p.startsWith("regex:")) {
    const body = p.replace(/^re(?:gex)?:/i, "");
    return new RegExp(body, "i").test(url);
  }
  return globToRegExp(p).test(url);
}

export async function interceptNetworkData<T = unknown>(
  page: Page,
  urlPattern: string,
  timeoutMs = 30_000,
  options: InterceptNetworkDataOptions = {},
): Promise<NetworkInterceptResult<T>> {
  const pattern = String(urlPattern ?? "").trim();
  if (!pattern) {
    throw new Error("interceptNetworkData: urlPattern is required");
  }

  const timeout =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : timeoutMs > 0
        ? timeoutMs
        : 30_000;
  const okOnly = options.okOnly !== false;

  const predicate = (response: Response): boolean => {
    try {
      if (!matchUrlPattern(response.url(), pattern)) return false;
      if (okOnly && !response.ok()) return false;
      return true;
    } catch {
      return false;
    }
  };

  let response: Response;
  try {
    response = await page.waitForResponse(predicate, { timeout });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `interceptNetworkData: no response matched "${pattern}" within ${timeout}ms (${msg})`,
    );
  }

  const url = response.url();
  const status = response.status();
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`interceptNetworkData: failed to read body from ${url}: ${msg}`);
  }

  const trimmed = bodyText.trim();
  if (!trimmed) {
    throw new Error(`interceptNetworkData: empty body from ${url} (status ${status})`);
  }

  try {
    return { url, status, data: JSON.parse(trimmed) as T };
  } catch {
    throw new Error(
      `interceptNetworkData: response from ${url} is not valid JSON (status ${status})`,
    );
  }
}

/**
 * Click an element that triggers a native browser download; save under scraper track.
 */
export async function downloadTriggeredFile(
  page: Page,
  clickSelector: string,
  profileId: string,
  timeoutMs = 30_000,
): Promise<FileDownloadResult> {
  const selector = String(clickSelector ?? "").trim();
  if (!selector) {
    return { success: false, error: "缺少 clickSelector" };
  }
  const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 30_000;

  // 本次点击触发的下载由本函数自行落盘到爬虫目录；期间暂停全局「手动下载接管」，
  // 否则同一 Download 会被全局监听器再处理一次，造成重复文件/重复日志。
  const resumeTakeover = suspendDownloadTakeover(page);

  try {
    // 立即挂接 no-op catch：waitForEvent 的超时拒绝若等到 click 之后才 await，
    // 一旦 click 抛错 / 提前返回，这个 promise 会沦为 unhandledRejection，
    // 进而触发全局「致命错误」兜底日志（误导 + 刷屏）。catch 掉后返回 null，
    // 统一走下方 `if (!download)` 的超时分支。
    const downloadPromise = page.waitForEvent("download", { timeout }).catch(() => null);
    const startedAt = Date.now() - 2_000;
    await page.locator(selector).first().click({ timeout: Math.min(timeout, 15_000) });
    const download = await downloadPromise;
    if (!download) {
      return { success: false, error: "点击后未触发下载事件或下载超时" };
    }
    const filename = sanitizeDownloadFilename(download.suggestedFilename());
    const tag = createHash("sha1")
      .update(`${download.url()}|${filename}|${Date.now()}`)
      .digest("hex")
      .slice(0, 8);
    const extName = path.extname(filename);
    const stem = path.basename(filename, extName) || "download";
    const uniqueName = `${stem}-${tag}${extName}`;
    const destPath = getResolvedDownloadPath("scraper", profileId, uniqueName);
    // 浏览器级落盘目录已经是「常规浏览器下载目录」（behavior=allow，真实文件名已在盘上），
    // 因此这里把文件挪进爬虫目录即可；只有仍处于 Playwright allowAndName 模式时才 saveAs。
    const browserDir = getResolvedDownloadPath("browser", profileId);
    const landed = await waitForNewDownload(
      browserDir,
      download.suggestedFilename(),
      startedAt,
      Math.min(timeout, 15_000),
    );
    if (landed) {
      await moveFile(landed, destPath);
    } else {
      await download.saveAs(destPath);
    }
    return { success: true, localPath: destPath, filename: uniqueName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Timeout|timeout/i.test(msg)) {
      return { success: false, error: "点击后未触发下载事件或下载超时" };
    }
    return { success: false, error: `下载失败: ${msg}` };
  } finally {
    resumeTakeover();
  }
}

function guessFilenameFromUrl(url: string, fallbackExt = ""): string {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    if (base && base !== "/" && base.includes(".")) {
      return sanitizeDownloadFilename(base);
    }
  } catch {
    // ignore
  }
  const ext = fallbackExt.startsWith(".") ? fallbackExt : fallbackExt ? `.${fallbackExt}` : "";
  return sanitizeDownloadFilename(`media-${Date.now()}${ext}`);
}

/**
 * Core static media download — reused by downloadStaticMedia and @download fields.
 * Uses Playwright context.request so proxy / cookies follow the browser profile
 * (Node fetch would bypass CloakBrowser proxy and is unreliable here).
 */
export async function downloadMediaFromUrl(
  page: Page,
  mediaUrl: string,
  profileId: string,
  options: { preferredBaseName?: string | null } = {},
): Promise<FileDownloadResult> {
  const raw = String(mediaUrl ?? "").trim();
  if (!raw) {
    return { success: false, error: "媒体 URL 为空" };
  }

  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(raw, page.url()).toString();
  } catch {
    return { success: false, error: `无效媒体 URL: ${raw}` };
  }

  if (/^blob:/i.test(absoluteUrl)) {
    return { success: false, error: "不支持 blob: URL，请改用可见的 http(s)/data 资源" };
  }

  const preferredBaseName = options.preferredBaseName ?? null;

  try {
    // data:image/...;base64,... → write locally without network
    if (/^data:/i.test(absoluteUrl)) {
      const match = absoluteUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
      if (!match) {
        return { success: false, error: "无效 data: URL" };
      }
      const mime = (match[1] || "application/octet-stream").toLowerCase();
      const isBase64 = Boolean(match[2]);
      const payload = match[3] || "";
      const buf = isBase64
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8");
      let ext = "";
      if (mime.includes("png")) ext = ".png";
      else if (mime.includes("jpeg") || mime.includes("jpg")) ext = ".jpg";
      else if (mime.includes("gif")) ext = ".gif";
      else if (mime.includes("webp")) ext = ".webp";
      else if (mime.includes("pdf")) ext = ".pdf";
      else if (mime.includes("svg")) ext = ".svg";
      const uniqueName = buildSmartDownloadFilename(
        preferredBaseName,
        absoluteUrl,
        ext || ".bin",
      );
      const destPath = getUniqueResolvedDownloadPath("scraper", profileId, uniqueName);
      writeFileSync(destPath, buf);
      return { success: true, localPath: destPath, filename: path.basename(destPath) };
    }

    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "");
    const response = await page.context().request.get(absoluteUrl, {
      timeout: 30_000,
      headers: {
        ...(userAgent ? { "User-Agent": userAgent } : {}),
        Referer: page.url(),
        Accept: "*/*",
      },
    });
    if (!response.ok()) {
      return { success: false, error: `资源请求失败 HTTP ${response.status()}` };
    }

    const contentType = (response.headers()["content-type"] || "").toLowerCase();
    let ext = "";
    if (contentType.includes("png")) ext = ".png";
    else if (contentType.includes("jpeg") || contentType.includes("jpg")) ext = ".jpg";
    else if (contentType.includes("gif")) ext = ".gif";
    else if (contentType.includes("webp")) ext = ".webp";
    else if (contentType.includes("pdf")) ext = ".pdf";
    else if (contentType.includes("svg")) ext = ".svg";

    const uniqueName = buildSmartDownloadFilename(preferredBaseName, absoluteUrl, ext);
    const destPath = getUniqueResolvedDownloadPath("scraper", profileId, uniqueName);

    const body = await response.body();
    writeFileSync(destPath, body);

    return { success: true, localPath: destPath, filename: path.basename(destPath) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `保存媒体失败: ${msg}` };
  }
}

/**
 * Save a static media URL (img src / href / data-src) with page cookies + UA.
 */
export async function downloadStaticMedia(
  page: Page,
  selector: string,
  attribute: string,
  profileId: string,
): Promise<FileDownloadResult> {
  const sel = String(selector ?? "").trim();
  const attr = String(attribute ?? "src").trim() || "src";
  if (!sel) {
    return { success: false, error: "缺少 selector" };
  }

  let mediaUrl: string | null = null;
  try {
    mediaUrl = await page.locator(sel).first().evaluate((el, attributeName) => {
      const node = el as Element;
      const raw =
        node.getAttribute(attributeName) ||
        (node as HTMLImageElement).currentSrc ||
        (node as HTMLAnchorElement).href ||
        "";
      return String(raw || "").trim() || null;
    }, attr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `无法读取媒体属性: ${msg}` };
  }

  if (!mediaUrl) {
    return { success: false, error: `元素未找到属性 ${attr}` };
  }

  return downloadMediaFromUrl(page, mediaUrl, profileId);
}

/** Unified entry: DOM / network / file_download / media_save. */
export async function scrapePageData(
  page: Page,
  input: ScrapePageDataInput,
): Promise<
  | {
      mode: "dom";
      items: ScraperRow[];
      inferred?: { containerSelector: string; fields: Record<string, string> };
    }
  | { mode: "network"; result: NetworkInterceptResult }
  | { mode: "file_download"; result: FileDownloadResult }
  | { mode: "media_save"; result: FileDownloadResult }
> {
  if (input.mode === "dom") {
    let containerSelector = String(input.containerSelector ?? "").trim();
    let fields =
      input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
        ? { ...input.fields }
        : ({} as Record<string, string>);
    let inferred: { containerSelector: string; fields: Record<string, string> } | undefined;

    const needInfer = !containerSelector || Object.keys(fields).length === 0;
    if (needInfer) {
      const goal = String(input.targetDescription ?? "").trim();
      if (!goal) {
        throw new Error(
          "mode=dom 缺少 containerSelector/fields 时必须提供 targetDescription（自然语言目标）",
        );
      }
      if (!input.aiSettings?.apiKey?.trim()) {
        throw new Error("自动推导选择器需要 AI 配置（apiKey），请在全局设置中配置 DeepSeek");
      }

      const { inferSelectorsFromPage } = await import("./auto_selector.js");
      let plan = await inferSelectorsFromPage(page, goal, input.aiSettings, {
        iframeSelector: input.iframeSelector,
      });
      containerSelector = plan.containerSelector;
      fields = plan.fields;
      inferred = { ...plan };

      let items = await extractDomData(page, containerSelector, fields, {
        maxItems: input.maxItems,
        iframeSelector: input.iframeSelector,
        autoScroll: input.autoScroll,
        autoScrollTimeoutMs: input.autoScrollTimeoutMs,
        profileId: input.profileId,
      });

      if (items.length === 0) {
        // One retry with failure feedback
        plan = await inferSelectorsFromPage(page, goal, input.aiSettings, {
          iframeSelector: input.iframeSelector,
          previous: plan,
          previousEmpty: true,
        });
        containerSelector = plan.containerSelector;
        fields = plan.fields;
        inferred = { ...plan };
        items = await extractDomData(page, containerSelector, fields, {
          maxItems: input.maxItems,
          iframeSelector: input.iframeSelector,
          autoScroll: input.autoScroll,
          autoScrollTimeoutMs: input.autoScrollTimeoutMs,
          profileId: input.profileId,
        });
      }

      if (items.length === 0) {
        throw new Error(
          `自动推导失败：选择器未匹配到数据。container=${containerSelector} fields=${JSON.stringify(fields)}`,
        );
      }
      return { mode: "dom", items, inferred };
    }

    // Manual selectors: still upgrade img → @download when goal asks for images
    const goal = String(input.targetDescription ?? "").trim();
    if (goal) {
      const { ensureDownloadFields } = await import("./auto_selector.js");
      const ensured = ensureDownloadFields(
        { containerSelector, fields },
        goal,
      );
      containerSelector = ensured.containerSelector;
      fields = ensured.fields;
    }

    const items = await extractDomData(page, containerSelector, fields, {
      maxItems: input.maxItems,
      iframeSelector: input.iframeSelector,
      autoScroll: input.autoScroll,
      autoScrollTimeoutMs: input.autoScrollTimeoutMs,
      profileId: input.profileId,
    });
    return { mode: "dom", items, inferred };
  }
  if (input.mode === "network") {
    const result = await interceptNetworkData(page, input.urlPattern, input.timeoutMs, {
      timeoutMs: input.timeoutMs,
      okOnly: input.okOnly,
    });
    return { mode: "network", result };
  }
  if (input.mode === "file_download") {
    const result = await downloadTriggeredFile(
      page,
      input.clickSelector,
      input.profileId,
      input.timeoutMs,
    );
    return { mode: "file_download", result };
  }
  const result = await downloadStaticMedia(
    page,
    input.selector,
    input.attribute ?? "src",
    input.profileId,
  );
  return { mode: "media_save", result };
}
