/**
 * 当前页总结 / 分析（Page Summary）
 *
 * 定位：服务「总结这个网站 / 分析当前页面 / 这个站点是干什么的」这类**信息型**目标。
 *
 * 为什么单列一个模块，而不是让执行环自由发挥：
 *   - 这类目标的阅读对象就是**当前打开的页面**，任务不需要、也不应该导航离开。历史上没有
 *     这条确定性路径，规划模型会给一句总结文案标上 `kind=navigation`，于是契约里多出一条
 *     永远核销不了的必交项，done 被反复驳回、任务原地打转（见 task_contract 的
 *     `isUnrequestedDeliverable`）。
 *   - 页面结构与站点的「功能/栏目」是**可确定性抽取**的（标题层级、同源浅层链接、表单与
 *     搜索框、语言标记），不必让执行环逐步猜；一次结构化抽取 + 一次模型归纳即可交付。
 *
 * 纪律：
 *   - 只读当前页：不滚动、不导航、不打开任何链接（`topLinks` 仅列出，供人判断）；
 *   - 零站点文案：所有判据都是通用 DOM 语义（nav / h1-h3 / input[type=search] / lang…），
 *     不含任何具体站点名称、选择器或域名；
 *   - 模型失败不阻断交付：退化为「结构 + 正文摘要」的确定性报告，并如实标注未能归纳。
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import type { Page } from "playwright-core";

import { beginAgentLlmWait, createLlmClient, extractAssistantContent } from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import { extractJsonObject } from "../bu_agent/prompts.js";
import { extractPageReading, type PageReadingResult } from "../page_read.js";

const MAX_HEADINGS = 30;
const MAX_TOP_LINKS = 40;
const MAX_CONTROLS = 60;
const MAX_MAIN_TEXT = 6000;
const MAX_ITEM_CHARS = 160;
const MAX_LIST_ITEMS = 8;

export interface PageSnapshot {
  url: string;
  host: string;
  title: string;
  /** 页面阅读脚本给出的类型（serp / article / generic） */
  kind: PageReadingResult["kind"];
  /** `<html lang>`；缺省空串 */
  lang: string;
  /** h1–h3 的可见文案，按文档顺序 */
  headings: string[];
  /** 同源浅层链接文案（站点主要栏目/功能入口的近似），去重保序 */
  topLinks: string[];
  /** 当前页可交互控件的可见文案（由运行时观察层提供，可选） */
  controlLabels: string[];
  /** 可见正文（已剔除 script/style/style 隐藏节点） */
  mainText: string;
  /** 存在搜索框（通用无障碍语义，不含站点假设） */
  hasSearchBox: boolean;
  /** 表单数量与可填控件数量（判断「这是不是个工具/表单页」的通用信号） */
  formCount: number;
  fillableCount: number;
}

export interface PageSummary {
  /** 站点/页面定位（一句话） */
  positioning: string;
  /** 主要功能与栏目 */
  functions: string[];
  /** 页面内容要点 */
  content: string[];
  /** 值得注意的信息（数据、时间、联系方式、警示…） */
  notable: string[];
  /** 不确定 / 需人工确认 */
  uncertain: string[];
  /** 结构化模型是否成功（false = 只交付了确定性结构，未做归纳） */
  modelUsed: boolean;
  /** 归纳失败/降级原因（modelUsed=false 时有值） */
  fallbackReason: string;
}

export interface PageSummaryInput {
  aiSettings: SidecarAiSettings;
  /** 用户目标原文；用于让归纳贴着用户的问题走 */
  goal?: string;
  signal?: AbortSignal;
  /** 运行时已观察到的控件文案（可选，零额外开销地补强「功能」判断） */
  controlLabels?: string[];
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, max = MAX_ITEM_CHARS): string {
  const t = clean(value);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function uniqueNonEmpty(values: unknown, max: number, maxChars = MAX_ITEM_CHARS): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const text = clip(clean(raw), maxChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 页面结构探针：全部为通用 DOM 语义，不含任何站点选择器。
 * 只读取当前文档，不触发滚动与导航。
 */
async function probeStructure(page: Page): Promise<{
  lang: string;
  headings: string[];
  topLinks: string[];
  hasSearchBox: boolean;
  formCount: number;
  fillableCount: number;
}> {
  return (await page.evaluate(
    (limits: { headings: number; links: number }) => {
      const cleanText = (value: unknown) =>
        String(value ?? "")
          .replace(/\s+/g, " ")
          .trim();

      const visible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) return false;
        try {
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (Number(style.opacity) === 0) return false;
        } catch {
          /* 取不到样式时不据此丢弃 */
        }
        return el.getAttribute("aria-hidden") !== "true";
      };

      const headings: string[] = [];
      const seenHeadings = new Set<string>();
      document.querySelectorAll("h1, h2, h3").forEach((el) => {
        if (headings.length >= limits.headings) return;
        if (!visible(el)) return;
        const text = cleanText(el.textContent);
        if (!text || text.length < 2) return;
        const key = text.toLowerCase();
        if (seenHeadings.has(key)) return;
        seenHeadings.add(key);
        headings.push(text.slice(0, 120));
      });

      /*
       * 站点栏目近似：同源、路径深度 ≤ 1 的链接文案。
       * 这是**通用**结构信号（顶层栏目），不针对任何站点；只收集文案，不访问链接。
       */
      const topLinks: string[] = [];
      const seenLinks = new Set<string>();
      const origin = location.origin;
      document.querySelectorAll("a[href]").forEach((node) => {
        if (topLinks.length >= limits.links) return;
        const anchor = node as HTMLAnchorElement;
        if (!visible(anchor)) return;
        let target: URL;
        try {
          target = new URL(anchor.href, location.href);
        } catch {
          return;
        }
        if (target.origin !== origin) return;
        if (target.protocol !== "http:" && target.protocol !== "https:") return;
        const segments = target.pathname.split("/").filter(Boolean);
        if (segments.length > 1) return;
        const text = cleanText(anchor.textContent);
        if (!text || text.length < 2 || text.length > 24) return;
        const key = text.toLowerCase();
        if (seenLinks.has(key)) return;
        seenLinks.add(key);
        topLinks.push(text);
      });

      /*
       * 「有搜索框」判定只依据**通用语义**（原生 type=search / 无障碍 role=searchbox /
       * placeholder·aria-label 等属性里的通用搜索词），不写任何站点专属 name 或选择器。
       */
      const searchHintWords = ["搜索", "搜一搜", "查询", "检索", "search", "look up"];
      const searchText = (el: Element) =>
        ["placeholder", "aria-label", "title", "name", "id"]
          .map((attr) => el.getAttribute(attr) ?? "")
          .join(" ")
          .toLowerCase();
      const hasSearchBox =
        [document.querySelector("input[type='search']"), document.querySelector("[role='searchbox']")].some(
          (el) => Boolean(el) && visible(el as Element),
        ) ||
        Array.from(
          document.querySelectorAll("input[type='text'], input:not([type]), textarea"),
        ).some((el) => visible(el) && searchHintWords.some((word) => searchText(el).includes(word)));

      const formCount = document.querySelectorAll("form").length;
      const fillableCount = document.querySelectorAll(
        "input:not([type='hidden']), textarea, select",
      ).length;

      return {
        lang: cleanText(document.documentElement?.getAttribute("lang")).slice(0, 24),
        headings,
        topLinks,
        hasSearchBox,
        formCount,
        fillableCount,
      };
    },
    { headings: MAX_HEADINGS, links: MAX_TOP_LINKS },
  )) as {
    lang: string;
    headings: string[];
    topLinks: string[];
    hasSearchBox: boolean;
    formCount: number;
    fillableCount: number;
  };
}

/** 采集当前页快照（只读：不滚动、不导航） */
export async function collectPageSnapshot(
  page: Page,
  options?: { controlLabels?: string[] },
): Promise<PageSnapshot> {
  const reading = await extractPageReading(page, { visibleTextMaxChars: MAX_MAIN_TEXT });
  const structure = await probeStructure(page);
  const url = page.url();
  const title = await page.title().catch(() => "");
  const mainText = clip(
    reading.visibleText ??
      reading.recommendedFirst?.summary ??
      (reading.organic.length > 0 ? reading.organic.map((item) => `${item.title} ${item.snippet}`).join(" ") : ""),
    MAX_MAIN_TEXT,
  );

  return {
    url,
    host: hostOf(url),
    title: clean(title),
    kind: reading.kind,
    lang: structure.lang,
    headings: structure.headings,
    topLinks: structure.topLinks,
    controlLabels: uniqueNonEmpty(options?.controlLabels ?? [], MAX_CONTROLS, 60),
    mainText,
    hasSearchBox: structure.hasSearchBox,
    formCount: structure.formCount,
    fillableCount: structure.fillableCount,
  };
}

/** 快照 → 给模型的紧凑事实块（纯客观，不含站点假设） */
export function formatSnapshotForLlm(snapshot: PageSnapshot): string {
  const lines: string[] = [
    `<page>`,
    `地址：${snapshot.url}`,
    `主机：${snapshot.host}`,
    `标题：${snapshot.title || "（无）"}`,
    `页面类型：${snapshot.kind}`,
  ];
  if (snapshot.lang) lines.push(`语言标记：${snapshot.lang}`);
  lines.push(
    `结构信号：搜索框=${snapshot.hasSearchBox ? "有" : "无"}；表单数=${snapshot.formCount}；可填控件数=${snapshot.fillableCount}`,
  );
  if (snapshot.headings.length) {
    lines.push(`标题层级：${snapshot.headings.join(" | ")}`);
  }
  if (snapshot.topLinks.length) {
    lines.push(`同源顶层链接（栏目/功能入口的近似，仅文案）：${snapshot.topLinks.join(" | ")}`);
  }
  if (snapshot.controlLabels.length) {
    lines.push(`可交互控件文案：${snapshot.controlLabels.join(" | ")}`);
  }
  lines.push("可见正文：", snapshot.mainText || "（无可见正文）");
  lines.push(`</page>`);
  return lines.join("\n");
}

/** 固定 Schema 的归纳结果 */
export interface PageSummarySections {
  positioning: string;
  functions: string[];
  content: string[];
  notable: string[];
  uncertain: string[];
}

/** 严格解析：字段缺失/类型不符一律降级为空，绝不因脏输出抛错 */
export function parseSummaryReply(content: string): PageSummarySections {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (extractJsonObject(content) ?? null) as Record<string, unknown> | null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return { positioning: "", functions: [], content: [], notable: [], uncertain: [] };
  }
  return {
    positioning: clip(clean(parsed.positioning ?? parsed.summary ?? parsed["定位"] ?? ""), 400),
    functions: uniqueNonEmpty(parsed.functions ?? parsed["功能"], MAX_LIST_ITEMS),
    content: uniqueNonEmpty(parsed.content ?? parsed["要点"] ?? parsed.key_points, MAX_LIST_ITEMS),
    notable: uniqueNonEmpty(parsed.notable ?? parsed["注意"] ?? parsed.highlights, MAX_LIST_ITEMS),
    uncertain: uniqueNonEmpty(parsed.uncertain ?? parsed["不确定"], MAX_LIST_ITEMS),
  };
}

const SUMMARY_SYSTEM_PROMPT = `你是网页内容分析师。用户已打开一个页面，要你**只根据给定的页面事实**总结、分析它。
只输出 JSON：
{"positioning":"这个页面/站点是做什么的（一句话）","functions":["主要功能与栏目"],"content":["页面内容要点"],"notable":["值得注意的信息"],"uncertain":["不确定或需人工确认的地方"]}

规则：
- **只依据给定事实**：不联网、不推测站点背景、不补写页面上没有的价格/姓名/数据；事实不足就少写，并把缺口写进 uncertain。
- positioning 必须落到具体：它是新闻站/工具站/商品页/表单页/搜索结果页/文档页…，以及服务什么主题；禁止写「这是一个网页」这类空话。
- functions 描述「这个站点能做什么、有哪些栏目」，取自顶层链接与可见控件；每条不超过 30 字，最多 8 条。
- content 描述「当前这一页在讲什么」，用自己的话概括，**禁止整段复制可见正文**；最多 8 条。
- notable 放具体事实：时间、数字、机构、联系方式、风险提示等；没有就留空数组。
- uncertain 写「页面上看不出/需要点进去才知道」的事，例如栏目下的具体内容、需要登录才能看到的信息。
- 全部使用简体中文；不要输出 Markdown 代码块以外的解释文字，只输出 JSON。`;

/**
 * 一次模型调用产出结构化总结。
 * 失败不抛错：返回空 sections，由调用方降级为确定性报告（任务不该因为一次归纳失败而失败）。
 */
async function summarizeWithModel(
  snapshot: PageSnapshot,
  input: PageSummaryInput,
): Promise<{ sections: PageSummarySections; used: boolean; reason: string }> {
  let wait: ReturnType<typeof beginAgentLlmWait> | null = null;
  try {
    const router = createModelRouter(input.aiSettings);
    const resolved = router.resolve("logic");
    const client = createLlmClient(input.aiSettings);
    wait = beginAgentLlmWait({ parentSignal: input.signal, timeoutMs: 45_000 });
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${formatSnapshotForLlm(snapshot)}\n${
          input.goal ? `<用户请求>${clip(input.goal, 300)}</用户请求>\n` : ""
        }请按 Schema 总结这个页面。`,
      },
    ];
    const completion = await client.chat.completions.create(
      {
        model: resolved.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      } as never,
      { signal: wait.signal },
    );
    const sections = parseSummaryReply(extractAssistantContent(completion));
    const used = Boolean(sections.positioning) || sections.content.length > 0 || sections.functions.length > 0;
    return { sections, used, reason: used ? "" : "模型返回的结构为空" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      sections: { positioning: "", functions: [], content: [], notable: [], uncertain: [] },
      used: false,
      reason: `归纳调用失败：${message}`,
    };
  } finally {
    wait?.stop();
  }
}

/** 降级：模型不可用时也要交付「结构 + 正文」的确定性事实 */
function deterministicSections(snapshot: PageSnapshot): PageSummarySections {
  const content: string[] = [];
  if (snapshot.headings.length) {
    content.push(`页面标题层级：${snapshot.headings.slice(0, 6).join(" / ")}`);
  }
  if (snapshot.mainText) {
    content.push(`可见正文摘要：${clip(snapshot.mainText, 400)}`);
  }
  return {
    positioning: snapshot.title ? `页面标题为「${snapshot.title}」（未做语义归纳）` : "",
    functions: snapshot.topLinks.slice(0, MAX_LIST_ITEMS),
    content,
    notable: [],
    uncertain: ["本次未完成语义归纳（模型调用失败），以上仅为页面结构事实"],
  };
}

/** 渲染成 Markdown 报告（同时用于 done 正文与落盘文件） */
export function renderSummaryMarkdown(snapshot: PageSnapshot, summary: PageSummary): string {
  const lines: string[] = [];
  const heading = snapshot.title || snapshot.host || snapshot.url;
  lines.push(`# ${heading}`);
  lines.push("");
  lines.push(`- 地址：${snapshot.url}`);
  if (snapshot.host) lines.push(`- 主机：${snapshot.host}`);
  if (snapshot.lang) lines.push(`- 语言标记：${snapshot.lang}`);
  lines.push(`- 页面类型：${snapshot.kind}`);
  lines.push("");
  if (summary.positioning) {
    lines.push("## 站点/页面定位", "", summary.positioning, "");
  }
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`## ${title}`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };
  section("主要功能与栏目", summary.functions);
  section("页面内容要点", summary.content);
  section("值得注意的信息", summary.notable);
  section("不确定 / 需人工确认", summary.uncertain);
  if (!summary.modelUsed) {
    lines.push(`> 说明：${summary.fallbackReason || "未完成语义归纳"}`, "");
  }
  return lines.join("\n").trim();
}

export interface PageSummaryResult {
  snapshot: PageSnapshot;
  summary: PageSummary;
  markdown: string;
  /** 给 Agent 一行提示用（避免把整篇 Markdown 塞进 done 之外的上下文） */
  headline: string;
}

/** 入口：采集当前页 → 一次结构化归纳 → Markdown。不滚动、不导航。 */
export async function summarizeCurrentPage(
  page: Page,
  input: PageSummaryInput,
): Promise<PageSummaryResult> {
  const snapshot = await collectPageSnapshot(page, { controlLabels: input.controlLabels });
  const { sections, used, reason } = await summarizeWithModel(snapshot, input);
  const effective = used ? sections : deterministicSections(snapshot);
  const summary: PageSummary = {
    ...effective,
    modelUsed: used,
    fallbackReason: used ? "" : reason,
  };
  const markdown = renderSummaryMarkdown(snapshot, summary);
  const headline = summary.positioning
    ? clip(summary.positioning, 120)
    : clip(`${snapshot.title || snapshot.host}（${snapshot.url}）`, 120);
  return { snapshot, summary, markdown, headline };
}
