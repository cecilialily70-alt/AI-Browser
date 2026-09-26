import { chromium, type Browser, type Page } from "playwright-core";

import { ENV_CDP_TARGET_ID, readAppEnv } from "./app_env.js";
import { humanizeConnectedBrowser } from "./cloakbrowser_extra.js";
import type { JsonLogger } from "./json-logger.js";

const DEFAULT_CDP_TIMEOUT_MS = 15_000;

/** 导航强制上限：仅等 DOM/commit，禁止无超时的 networkidle */
export const NAV_DOM_TIMEOUT_MS = 15_000;
/** networkidle 软等待：超时忽略，避免 SPA/长连接卡死 */
export const NAV_NETWORKIDLE_SOFT_MS = 5_000;
/** 代理场景下优先 commit（响应已到），再软等 DOM */
const NAV_COMMIT_TIMEOUT_MS = 12_000;

/**
 * Step 1: session-bound active page.
 * Do not pick "first non-blank" blindly (multi-tab crosstalk).
 */
let boundActivePage: Page | null = null;
let boundPageTargetId: string | null = null;

export function bindActivePage(page: Page | null): void {
  boundActivePage = page && !page.isClosed() ? page : null;
  boundPageTargetId = null;
  if (boundActivePage) {
    void refreshBoundTargetId(boundActivePage).catch(() => undefined);
  }
}

/**
 * 清掉活动页绑定。**每次新任务启动时调用**：
 * 上一次任务（或某条命令）switch/new_tab 到过的标签，不该成为下一次任务的默认作用域 ——
 * 用户口径是「没有明确要求时默认操作第一个标签」。sidecar 是**每环境一个进程**，
 * 所以这里清的是「本环境上一次的绑定」，不会影响别的环境。
 */
export function resetActivePageBinding(): void {
  boundActivePage = null;
  boundPageTargetId = null;
}
async function refreshBoundTargetId(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    const info = (await session.send("Target.getTargetInfo")) as {
      targetInfo?: { targetId?: string };
    };
    boundPageTargetId = String(info?.targetInfo?.targetId ?? "").trim() || null;
    await session.detach().catch(() => undefined);
  } catch {
    boundPageTargetId = null;
  }
}

function isUsableContentUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed || trimmed === "about:blank") {
    return false;
  }
  if (
    trimmed.startsWith("chrome://") ||
    trimmed.startsWith("chrome-error://") ||
    trimmed.startsWith("devtools://") ||
    trimmed.startsWith("edge://")
  ) {
    return false;
  }
  return true;
}

/**
 * 这个标签**能不能干活**（>0 = 是能承载内容的网页）。
 * 只做「可用 / 不可用」判定，**不**参与「选哪个标签」——选哪个由位置决定（见 resolveActivePageFromList）。
 */
function rankPage(page: Page): number {
  const url = page.url().trim().toLowerCase();
  if (!isUsableContentUrl(url)) {
    return -100;
  }
  // 内核自带的「指纹检测/自检」页不是用户要干活的地方：不要默认落在它上面。
  if (url.includes("browserscan.net")) {
    return -50;
  }
  let score = 10;
  if (url.startsWith("https://") || url.startsWith("http://")) {
    score += 20;
  }
  return score;
}

/** Interrupt a stuck prior navigation */
async function stopInFlightNavigation(page: Page): Promise<void> {
  try {
    const client = await page.context().newCDPSession(page);
    await client.send("Page.stopLoading").catch(() => undefined);
  } catch {
    // ignore
  }
  try {
    await page.evaluate(() => {
      try {
        window.stop();
      } catch {
        /* ignore */
      }
    });
  } catch {
    // ignore
  }
}

function urlLooksReached(current: string, target: string): boolean {
  const normalize = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace(/^https?:\/\//, "");
  const a = normalize(current);
  const b = normalize(target);
  if (!a || a === "about:blank" || a.startsWith("chrome-error")) {
    return false;
  }
  return (
    a === b ||
    a.startsWith(`${b}/`) ||
    a.startsWith(`${b}?`) ||
    a.startsWith(`${b}#`) ||
    b.startsWith(a)
  );
}

async function documentHasBody(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => Boolean(document.body && document.body.childElementCount >= 0));
  } catch {
    return false;
  }
}

/**
 * Robust navigation (CloakBrowser = Playwright API).
 * Stop stuck nav -> prefer commit -> soft DOM -> optional short networkidle.
 */
export async function safeGoto(
  page: Page,
  url: string,
  options?: { softNetworkIdle?: boolean; retries?: number },
): Promise<void> {
  const maxAttempts = Math.max(1, (options?.retries ?? 2) + 1);
  const softNetworkIdle = options?.softNetworkIdle === true;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await stopInFlightNavigation(page);
    try {
      try {
        await page.goto(url, {
          waitUntil: "commit",
          timeout: NAV_COMMIT_TIMEOUT_MS,
        });
      } catch (commitError) {
        const current = page.url().trim();
        if (urlLooksReached(current, url) && (await documentHasBody(page))) {
          bindActivePage(page);
          return;
        }
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_DOM_TIMEOUT_MS,
        });
        void commitError;
      }
      await page
        .waitForLoadState("domcontentloaded", { timeout: 5_000 })
        .catch(() => undefined);
      if (softNetworkIdle) {
        await page
          .waitForLoadState("networkidle", { timeout: NAV_NETWORKIDLE_SOFT_MS })
          .catch(() => undefined);
      }
      bindActivePage(page);
      return;
    } catch (error) {
      lastError = error;
      const current = page.url().trim();
      if (urlLooksReached(current, url) && (await documentHasBody(page))) {
        bindActivePage(page);
        return;
      }
      if (attempt >= maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`safeGoto failed for ${url}: ${String(lastError)}`);
}

export async function softSettleAfterNavigation(
  page: Page,
  options?: { softNetworkIdle?: boolean; domTimeoutMs?: number },
): Promise<void> {
  const domTimeout = options?.domTimeoutMs ?? 3_000;
  await page.waitForLoadState("domcontentloaded", { timeout: domTimeout }).catch(() => undefined);
  if (options?.softNetworkIdle) {
    await page
      .waitForLoadState("networkidle", { timeout: NAV_NETWORKIDLE_SOFT_MS })
      .catch(() => undefined);
  }
}

/**
 * Resolve active page.
 *
 * 顺序（用户口径：**默认操作第一个标签**）：
 *  1. 本次运行**已显式绑定**的页（switch / navigate(new_tab=true) 之后）—— 唯一能压过「第一个标签」的信号；
 *  2. **最早的、能承载内容的**标签（`about:blank` / `chrome://` 之类不算）；
 *  3. 若所有标签都是空白/浏览器内页 → 第一个标签（保持旧兜底，由上层决定是否新建页）。
 *
 * 为什么不再「按 URL 质量排序挑一个」：那会**静默选错标签**。只要第二个标签的 URL
 * 比第一个「更像内容页」（+20 的 https 分 vs 第一个的 +10），Agent 就会在第二个上操作，
 * 而提示词里没有任何一条能解释为什么 —— 用户看到的就是「默认不在第一个标签」。
 * 现在只按**位置**取最早的那个，URL 只用来判断「这个标签能不能干活」。
 */
export function resolveActivePageFromList(pages: Page[]): Page | null {
  const open = pages.filter((page) => !page.isClosed());
  if (open.length === 0) {
    return null;
  }

  if (boundActivePage && !boundActivePage.isClosed() && open.includes(boundActivePage)) {
    return boundActivePage;
  }

  const preferredTarget = readAppEnv(ENV_CDP_TARGET_ID) ?? "";
  if (preferredTarget && preferredTarget === boundPageTargetId && boundActivePage) {
    if (!boundActivePage.isClosed() && open.includes(boundActivePage)) {
      return boundActivePage;
    }
  }

  // 最早的可操作内容页；没有则退回第一个标签（空白页也照给，避免「没有 page」）
  const firstUsable = open.find((page) => rankPage(page) > 0);
  return firstUsable ?? open[0]!;
}

export function resolveActivePageFromBrowser(browser: Browser): Page {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = resolveActivePageFromList(pages);
  if (!page) {
    throw new Error("no active page connected over CDP");
  }
  bindActivePage(page);
  return page;
}

export async function withActivePageViaCdp<T>(
  cdpPort: number,
  logger: JsonLogger,
  statusMessage: string,
  action: (page: Page) => Promise<T>,
): Promise<T> {
  logger.chatStatus(statusMessage, { cdpPort });

  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
      timeout: DEFAULT_CDP_TIMEOUT_MS,
    });
    // 同上：另开 CDP 连接必须显式补 humanize，否则该连接上的鼠标动作为瞬移。
    if (!(await humanizeConnectedBrowser(browser))) {
      logger.debug("cdp_humanize_failed", { cdpPort });
    }

    const contexts = browser.contexts();
    const pages = contexts.flatMap((context) => context.pages());
    let page = resolveActivePageFromList(pages);
    if (!page) {
      const context = contexts[0];
      if (!context) {
        throw new Error("browser has no available context/tab");
      }
      page = await context.newPage();
    }
    bindActivePage(page);
    return await action(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.chatStatus(`nav/page action failed: ${message}`, { cdpPort, error: message });
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
