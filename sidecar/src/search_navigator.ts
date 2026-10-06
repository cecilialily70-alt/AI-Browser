import type { Page } from "playwright-core";

import { NAV_DOM_TIMEOUT_MS, safeGoto, softSettleAfterNavigation } from "./cdp_session.js";
import { resolveGateway } from "./core/action_gateway.js";
import { engineHomepage, engineSpec, type SearchEngineSpec } from "./core/page_policy.js";
import type { JsonLogger } from "./json-logger.js";

export type SearchEngine = "google" | "bing" | "baidu";

export interface SearchNavigationResult {
  engine: SearchEngine;
  startUrl: string;
  finalUrl: string;
  googleSorry: boolean;
  usedFallback: boolean;
}

/** Google /sorry/ 或同类验证拦截页（引擎主机 + /sorry 形态，主机来源见政策数据） */
export function isGoogleSorryOrCaptchaUrl(url: string): boolean {
  const engine = engineSpec("google");
  let host = "google.com";
  try {
    host = new URL(engine.homepage).hostname.replace(/^www\./, "");
  } catch {
    /* keep default */
  }
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\.)${escaped}$`, "i").test(safeHostname(url)) && /\/sorry(\/|$)/i.test(url);
}

function safeHostname(url: string): string {
  try {
    return new URL(String(url ?? "")).hostname;
  } catch {
    return "";
  }
}

async function nativeSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readPageLocale(page: Page): Promise<string | null> {
  try {
    const locale = await page.evaluate(() => navigator.language || null);
    return typeof locale === "string" && locale.trim() ? locale.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 宪法搜索：**首页 → 在搜索框填表输入检索词 → 点击搜索按钮 / 回车**（禁止 goto 结果页 URL）。
 *
 * 引擎全部要素（首页地址、搜索框与提交控件选择器）来自 `config/search_engines.json`，
 * 代码层不再出现任何引擎域名或选择器字面量；换引擎/加引擎只改配置。
 *
 * CloakBrowser 建议先停留首页再输入；键入走拟人（humanLike），提交优先走页面上的按钮。
 */
export async function performEngineFormSearch(
  page: Page,
  query: string,
  engineId: string | null,
  logger: JsonLogger,
): Promise<SearchNavigationResult> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("搜索关键词不能为空");
  }

  const spec: SearchEngineSpec = engineSpec(engineId);
  const engine = (spec.id as SearchEngine) ?? "google";
  const locale = await readPageLocale(page);
  const home = engineHomepage(spec.id);

  try {
    await safeGoto(page, home);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`打开 ${spec.id} 首页失败（${NAV_DOM_TIMEOUT_MS}ms）: ${message}`);
  }
  await nativeSleep(1_500 + Math.floor(Math.random() * 1_000));

  const searchBox = await firstVisible(page, spec.searchBoxSelectors);
  if (!searchBox) {
    throw new Error(`${spec.id} 首页没有找到可用的搜索框（配置 searchBoxSelectors 需与站点一致）`);
  }

  const gw = resolveGateway(page);
  const noRecord = { record: false as const, skipSettle: true };
  await gw.click(searchBox, { ...noRecord, semanticLabel: `${spec.id} search box` });
  await nativeSleep(250 + Math.floor(Math.random() * 350));

  await gw.fill(searchBox, trimmedQuery, {
    ...noRecord,
    humanLike: true,
    semanticLabel: `${spec.id} search query`,
  });
  await nativeSleep(400 + Math.floor(Math.random() * 500));

  const submitButton = await firstVisible(page, spec.submitSelectors, 2_000);
  const usedFormSubmit = submitButton !== null;
  if (submitButton) {
    await gw.click(submitButton, { ...noRecord, semanticLabel: `${spec.id} search submit` });
  } else {
    await gw.executeKeyPress("Enter", noRecord);
  }

  await softSettleAfterNavigation(page);
  await nativeSleep(600);

  const finalUrl = page.url();
  const googleSorry = spec.id === "google" && isGoogleSorryOrCaptchaUrl(finalUrl);

  logger.progress(googleSorry ? "search_engine_sorry_detected" : "search_engine_form_ok", {
    query: trimmedQuery,
    engine: spec.id,
    finalUrl,
    locale,
    usedFormSubmit,
  });

  return {
    engine,
    startUrl: home,
    finalUrl,
    googleSorry,
    usedFallback: false,
  };
}

/** 按配置里的选择器顺序找第一个可见控件 */
async function firstVisible(
  page: Page,
  selectors: string[],
  timeoutMs: number = NAV_DOM_TIMEOUT_MS,
): Promise<ReturnType<Page["locator"]> | null> {
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    const visible = await candidate.isVisible({ timeout: timeoutMs }).catch(() => false);
    if (visible) return candidate;
  }
  return null;
}
