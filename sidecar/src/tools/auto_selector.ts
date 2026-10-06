/**
 * Auto-selector inference: slim page HTML → LLM JSON → CSS selectors for extractDomData.
 */
import type { Page } from "playwright-core";

import { createModelRouter } from "../ai_model_router.js";
import { stripFencedJson } from "../json_extract.js";
import { extractAssistantContent } from "../ai_client.js";
import type { SidecarAiSettings } from "../engine.js";
import {
  AUTO_SELECTOR_HTML_DEFAULT,
  AUTO_SELECTOR_HTML_MAX,
  SELECTOR_INFER_MAX_TOKENS,
} from "../llm_budget.js";

export type InferredSelectors = {
  containerSelector: string;
  fields: Record<string, string>;
};

const DEFAULT_HTML_BUDGET = AUTO_SELECTOR_HTML_DEFAULT;
const SELECTOR_CACHE_MAX = 200;
const selectorInferCache = new Map<string, InferredSelectors>();

function cacheKey(pageUrl: string, goal: string): string {
  return `${pageUrl}::${goal.trim().toLowerCase()}`;
}

function cacheGet(key: string): InferredSelectors | undefined {
  const hit = selectorInferCache.get(key);
  if (!hit) {
    return undefined;
  }
  // LRU: re-insert
  selectorInferCache.delete(key);
  selectorInferCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: InferredSelectors): void {
  if (selectorInferCache.has(key)) {
    selectorInferCache.delete(key);
  }
  selectorInferCache.set(key, value);
  while (selectorInferCache.size > SELECTOR_CACHE_MAX) {
    const oldest = selectorInferCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    selectorInferCache.delete(oldest);
  }
}

/**
 * Capture a compact HTML skeleton of the page (or iframe) for LLM selector inference.
 * Strips script/style/svg/noscript and noisy attributes; caps length.
 */
export async function extractSlimDomHtml(
  page: Page,
  options: { iframeSelector?: string; maxChars?: number } = {},
): Promise<string> {
  const maxChars = Math.min(
    AUTO_SELECTOR_HTML_MAX,
    Math.max(4_000, options.maxChars ?? DEFAULT_HTML_BUDGET),
  );
  const iframeSel = String(options.iframeSelector ?? "").trim();

  const slimFn = (_rootEl: Element, budget: number): string => {
    const doc = _rootEl.ownerDocument || document;
    const stripNoise = (root: Element): void => {
      const kill = root.querySelectorAll("script, style, svg, noscript, link, meta, iframe, canvas");
      kill.forEach((node) => node.remove());
    };

    const cleanAttrs = (el: Element): void => {
      const keep = new Set([
        "id",
        "class",
        "name",
        "type",
        "href",
        "src",
        "alt",
        "title",
        "role",
        "value",
        "placeholder",
        "aria-label",
        "data-testid",
        "data-test",
        "itemprop",
      ]);
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "style") {
          el.removeAttribute(attr.name);
          continue;
        }
        if (!keep.has(name) && !name.startsWith("data-") && !name.startsWith("aria-")) {
          el.removeAttribute(attr.name);
        }
      }
      for (const child of Array.from(el.children)) {
        cleanAttrs(child);
      }
    };

    const body = doc.body || _rootEl;
    const clone = body.cloneNode(true) as HTMLElement;
    stripNoise(clone);
    cleanAttrs(clone);

    let html = clone.innerHTML.replace(/\s+/g, " ").trim();
    if (html.length > budget) {
      html = html.slice(0, budget) + "<!--truncated-->";
    }
    return html;
  };

  if (iframeSel) {
    try {
      return await page
        .frameLocator(iframeSel)
        .locator("body")
        .first()
        .evaluate(slimFn, maxChars, { timeout: 8_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`无法读取 iframe DOM（${iframeSel}）: ${msg}`);
    }
  }

  return page.evaluate((budget: number) => {
    const stripNoise = (root: Element): void => {
      root.querySelectorAll("script, style, svg, noscript, link, meta, iframe, canvas").forEach((n) => n.remove());
    };
    const cleanAttrs = (el: Element): void => {
      const keep = new Set([
        "id",
        "class",
        "name",
        "type",
        "href",
        "src",
        "alt",
        "title",
        "role",
        "value",
        "placeholder",
        "aria-label",
        "data-testid",
        "data-test",
        "itemprop",
      ]);
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "style") {
          el.removeAttribute(attr.name);
          continue;
        }
        if (!keep.has(name) && !name.startsWith("data-") && !name.startsWith("aria-")) {
          el.removeAttribute(attr.name);
        }
      }
      for (const child of Array.from(el.children)) {
        cleanAttrs(child);
      }
    };
    const body = document.body;
    if (!body) return "";
    const clone = body.cloneNode(true) as HTMLElement;
    stripNoise(clone);
    cleanAttrs(clone);
    let html = clone.innerHTML.replace(/\s+/g, " ").trim();
    if (html.length > budget) {
      html = html.slice(0, budget) + "<!--truncated-->";
    }
    return html;
  }, maxChars);
}

function parseInferredSelectors(raw: string): InferredSelectors {
  const trimmed = raw.trim();
  const candidate = stripFencedJson(trimmed);
  // Prefer outermost JSON object
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("LLM 未返回 JSON 对象");
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM JSON 格式无效");
  }
  const record = parsed as Record<string, unknown>;
  const containerSelector = String(
    record.containerSelector ?? record.container ?? record.itemSelector ?? "",
  ).trim();
  const fieldsRaw = record.fields ?? record.fieldMap ?? record.selectors;
  if (!containerSelector) {
    throw new Error("LLM 未给出 containerSelector");
  }
  if (!fieldsRaw || typeof fieldsRaw !== "object" || Array.isArray(fieldsRaw)) {
    throw new Error("LLM 未给出 fields 对象");
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(fieldsRaw as Record<string, unknown>)) {
    const sel = String(value ?? "").trim();
    if (key.trim() && sel) {
      fields[key.trim()] = sel;
    }
  }
  if (Object.keys(fields).length === 0) {
    throw new Error("LLM fields 为空");
  }
  return { containerSelector, fields };
}

/** Goal mentions images / save / cover → must use @download fields. */
export function wantsMediaDownload(goal: string): boolean {
  return /图片|封面|缩略图|插图|海报|下载|落盘|保存.*(图|媒体|pdf|文件)|image|cover|thumbnail|download|media.?save|抓.?图|存.?图/i.test(
    String(goal ?? ""),
  );
}

/**
 * If the user asked for images but the LLM omitted @download, upgrade img fields
 * or inject a default `封面: img@download`.
 */
export function ensureDownloadFields(
  plan: InferredSelectors,
  goal: string,
): InferredSelectors {
  if (!wantsMediaDownload(goal)) {
    return plan;
  }
  const hasDownload = Object.values(plan.fields).some((v) => /@download$/i.test(String(v)));
  if (hasDownload) {
    return plan;
  }
  const fields: Record<string, string> = { ...plan.fields };
  let upgraded = false;
  for (const [key, raw] of Object.entries(fields)) {
    const sel = String(raw).trim();
    if (!sel || /@download$/i.test(sel)) continue;
    const looksImg =
      /^img\b/i.test(sel) ||
      /\bimg\b/i.test(sel) ||
      /@(src|data-src|data-lazy|data-original)$/i.test(sel);
    if (!looksImg) continue;
    if (/@(src|data-src|data-lazy|data-original|href)$/i.test(sel)) {
      fields[key] = `${sel}@download`;
    } else if (!sel.includes("@")) {
      fields[key] = `${sel}@download`;
    } else {
      fields[key] = `${sel}@download`;
    }
    upgraded = true;
  }
  if (!upgraded) {
    fields["封面"] = "img@download";
  }
  return { containerSelector: plan.containerSelector, fields };
}

/**
 * Ask the text LLM to propose containerSelector + fields from slim HTML + user goal.
 */
export async function inferDomSelectors(params: {
  html: string;
  targetDescription: string;
  aiSettings: SidecarAiSettings;
  pageUrl?: string;
  /** When retrying after empty extract */
  previous?: InferredSelectors | null;
  previousEmpty?: boolean;
}): Promise<InferredSelectors> {
  const goal = String(params.targetDescription ?? "").trim();
  if (!goal) {
    throw new Error("targetDescription 不能为空");
  }
  if (!params.previousEmpty) {
    const hit = cacheGet(cacheKey(params.pageUrl ?? "", goal));
    if (hit) {
      return hit;
    }
  }
  const html = String(params.html ?? "").trim();
  if (!html) {
    throw new Error("页面 HTML 为空，无法自动推导选择器");
  }

  const { route, client } = createModelRouter(params.aiSettings).forIntent(
    "fast_text",
    "自动推导 CSS 选择器：极速文本模型",
  );
  const model = route.model;

  const retryHint = params.previousEmpty
    ? `\n【重试】上一轮选择器抓取结果为空，请换更稳健的选择器。上一轮失败方案：${JSON.stringify(params.previous)}\n`
    : "";

  const system = [
    "你是网页结构分析专家。根据精简 HTML 与用户抓取目标，输出可被 Playwright / querySelector 使用的 CSS 选择器。",
    "只输出一个 JSON 对象，不要 Markdown，不要解释。",
    '格式：{"containerSelector":"列表每一项的容器选择器","fields":{"字段名":"相对容器的子选择器或属性写法"}}',
    "fields 中取链接用 a@href 形式；取文本用类名/标签相对选择器；需要下载图片到本地时用 img@download 或 img@src@download。",
    "若用户目标含图片/封面/下载/保存图片，fields 中必须至少包含一个带 @download 的字段（例如 封面: img@download），不要只返回书名文本。",
    "优先选稳定、语义清晰的 class/id；避免过深的 nth-child 链。",
  ].join("\n");

  const user = [
    `页面 URL: ${params.pageUrl ?? "(unknown)"}`,
    `用户想提取: ${goal}`,
    retryHint,
    "HTML 骨架:",
    html,
  ].join("\n");

  const response = await client.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: SELECTOR_INFER_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const content = extractAssistantContent(response);
  const inferred = parseInferredSelectors(content);
  if (!params.previousEmpty) {
    cacheSet(cacheKey(params.pageUrl ?? "", goal), inferred);
  }
  return inferred;
}

/**
 * Full pipeline: slim DOM → infer → return selectors (with one optional retry hint prepared by caller).
 */
export async function inferSelectorsFromPage(
  page: Page,
  targetDescription: string,
  aiSettings: SidecarAiSettings,
  options: {
    iframeSelector?: string;
    previous?: InferredSelectors | null;
    previousEmpty?: boolean;
  } = {},
): Promise<InferredSelectors> {
  const html = await extractSlimDomHtml(page, {
    iframeSelector: options.iframeSelector,
  });
  const plan = await inferDomSelectors({
    html,
    targetDescription,
    aiSettings,
    pageUrl: page.url(),
    previous: options.previous,
    previousEmpty: options.previousEmpty,
  });
  return ensureDownloadFields(plan, targetDescription);
}
