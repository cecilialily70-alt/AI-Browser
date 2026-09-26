/**
 * 观察 / 分析前的页面就绪屏障：禁止在未加载完时验收或交付。
 */
import type { Page } from "playwright-core";

const LOAD_HARD_MS = 15_000;
const NETWORK_SOFT_MS = 8_000;
const SERP_POLL_MS = 12_000;
const SERP_TICK_MS = 400;
const POST_READY_BUFFER_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function looksLikeSerpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname;
    if (host.includes("baidu.com") && (path.startsWith("/s") || u.searchParams.has("wd"))) {
      return true;
    }
    if (host.includes("google.") && (path.startsWith("/search") || u.searchParams.has("q"))) {
      return true;
    }
    if (host.includes("bing.com") && (path.startsWith("/search") || u.searchParams.has("q"))) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** 页面 document 是否已 load/complete */
export async function waitForDocumentLoad(page: Page, timeoutMs = LOAD_HARD_MS): Promise<boolean> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 12_000) });
  } catch {
    /* continue */
  }
  try {
    await page.waitForLoadState("load", { timeout: Math.min(timeoutMs, LOAD_HARD_MS) });
  } catch {
    /* soft */
  }
  try {
    const ready = await page.evaluate(() => document.readyState);
    return ready === "complete" || ready === "interactive";
  } catch {
    return false;
  }
}

/** 软等网络空闲（超时不失败） */
export async function softWaitNetworkIdle(page: Page, timeoutMs = NETWORK_SOFT_MS): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
}

/**
 * 等到 SERP 真正出现自然结果标题（h3），避免把首页导航/空卡当结果。
 */
export async function waitForSerpResultsReady(
  page: Page,
  timeoutMs = SERP_POLL_MS,
): Promise<{ ready: boolean; organicCount: number; url: string }> {
  const started = Date.now();
  let lastCount = 0;
  let lastUrl = page.url();
  while (Date.now() - started < timeoutMs) {
    try {
      lastUrl = page.url();
      if (!looksLikeSerpUrl(lastUrl)) {
        await sleep(SERP_TICK_MS);
        continue;
      }
      const count = await page.evaluate(() => {
        const nodes = document.querySelectorAll(
          [
            "#content_left .result h3",
            "#content_left .c-container h3",
            "#content_left h3.t",
            "#content_left h3 a",
            "#rso h3",
            "#search a h3",
            "#b_results .b_algo h2",
            "#b_results h2 a",
          ].join(", "),
        );
        let n = 0;
        for (const el of Array.from(nodes)) {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (t.length < 2) {
            continue;
          }
          if (/相关搜索|换一换|百度热搜|登录|设置|网页\s*图片|更多产品/.test(t)) {
            continue;
          }
          n += 1;
        }
        return n;
      });
      lastCount = count;
      if (count >= 1) {
        await sleep(POST_READY_BUFFER_MS);
        return { ready: true, organicCount: count, url: lastUrl };
      }
    } catch {
      /* retry */
    }
    await sleep(SERP_TICK_MS);
  }
  return { ready: false, organicCount: lastCount, url: lastUrl };
}

export interface PageReadyResult {
  documentReady: boolean;
  serpReady: boolean | null;
  organicCount: number;
  url: string;
  note: string;
}

/**
 * 每轮观察 / 分析前调用：
 * 1) document load
 * 2) 软 networkidle
 * 3) 若已是 SERP URL 或 expectSerp → 等到自然结果出现
 */
export async function waitUntilPageReadyForObserve(
  page: Page,
  opts?: { expectSerp?: boolean; goalHint?: string },
): Promise<PageReadyResult> {
  const expectSerp =
    Boolean(opts?.expectSerp) ||
    /搜索|查找|总结|第一条|google|百度|bing|谷歌|必应/i.test(String(opts?.goalHint ?? ""));

  const documentReady = await waitForDocumentLoad(page);
  await softWaitNetworkIdle(page);

  const url = page.url();
  const needSerp = expectSerp || looksLikeSerpUrl(url);
  if (!needSerp) {
    await sleep(POST_READY_BUFFER_MS);
    return {
      documentReady,
      serpReady: null,
      organicCount: 0,
      url,
      note: documentReady ? "页面已加载" : "页面加载未完全确认，已软等待",
    };
  }

  // 搜索场景：若还在首页，先等到跳进 SERP；再等到结果 DOM
  if (!looksLikeSerpUrl(url) && expectSerp) {
    const jumpStarted = Date.now();
    while (Date.now() - jumpStarted < SERP_POLL_MS) {
      if (looksLikeSerpUrl(page.url())) {
        break;
      }
      await sleep(SERP_TICK_MS);
    }
    await waitForDocumentLoad(page, 8_000);
    await softWaitNetworkIdle(page, 6_000);
  }

  const serp = await waitForSerpResultsReady(page);
  return {
    documentReady,
    serpReady: serp.ready,
    organicCount: serp.organicCount,
    url: serp.url,
    note: serp.ready
      ? `SERP 已就绪（自然结果≥${serp.organicCount}）`
      : `SERP 未就绪：url=${serp.url} · organic=${serp.organicCount}（禁止交付首页残影）`,
  };
}
