/**
 * 描述符驱动的**页内事实采集**（P2）
 *
 * 为什么单独做一层（而不是继续用通用读取器）：
 *   通用读取器（`conversation_extract`）**只抽文本** —— 纯文本行之外的什么都看不见。
 *   于是「对方发来一张图」「对方撤回了」「对方引用我说的那句」在它眼里统统等于「没说话」，
 *   引擎就会以为对方沉默而继续主动找话（用户观感：只会复读）。本模块按描述符把一行
 *   抽成**扁平事实** {@link RowFact}：
 *
 *   1. **引用块必须从正文里剔除** —— 不剔的话被引的原文会混进正文，同一句话被算两次
 *      （既污染记忆，又可能触发去重误判）。
 *   2. **附件行 = 有内容**（`hasMedia`）—— 只记「对方回了」+ 类型，**绝不取内容、绝不用于取码**（R2/B7）。
 *   3. **撤回行**（`retracted`）—— id 还在、文本空了；不能继续拿旧文本当记忆。
 *   4. **显示时间戳一律不信** —— 只留痕（`seenTs`），回访一律用我方观测时间。
 *
 * 纪律：**零动态求值**（R8）—— `spec` 是纯 JSON（选择器 / 属性名 / 正则源码 / 布尔 / 数字），
 * 本模块把它当**数据**用：`querySelector` / `getAttribute` / `new RegExp`（Node 侧）之外，
 * 不做任何字符串→代码的转换。页内函数是**固定代码**，不是从描述符生成出来的。
 */

import { stripDecorationTail } from "../outbox.js";
import { readChatSliceSize } from "../wait.js";
import type { Page } from "playwright-core";
import type { RowsSpec, RowFact, ThreadFacts } from "./types.js";

/** 单行事实的采集上限（虚拟列表一次最多这么多行；超出的留给下一轮滚动，绝不假装读完） */
export const FACT_ROW_LIMIT = 400;

/** 页内小工具函数体积很小但这行必须存在：它是「Node 侧不再碰 DOM」的边界 */
export interface ExtractFactsArg {
  containerSelector: string;
  rows: RowsSpec;
  /** 页内 poll 兜底间隔（MutationObserver 不可用时的降级；不静默，`fallbackPoll=true`） */
  limit: number;
}

/* eslint-disable complexity */
/**
 * **页内**采集函数。
 *
 * 必须自包含：Playwright 会把函数体序列化后送进页面，所以它不能引用本模块的其它符号
 * （也不许引用闭包变量）。`spec` 里的每一样都只用「读」的方式使用。
 */
function extractFactsInPage(arg: ExtractFactsArg): ThreadFacts {
  const rows = arg.rows;
  const root = document.querySelector(arg.containerSelector);

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };

  const textOf = (el: Element | null): string => {
    if (!el) return "";
    // 引用块先摘掉：不摘就会把「被引的原文」当成本条正文（重复计数、污染记忆）
    const clone = el.cloneNode(true) as Element;
    for (const selector of rows.quotedReplySelectors) {
      clone.querySelectorAll(selector).forEach((node) => node.remove());
    }
    // 页面装饰（显示时间 / 已读勾）同样摘掉：它们渲染在正文容器**内部**，
    // 留着就会变成正文的一部分（`…聊聊吧。02:20 02:20`）——指纹对不上、记忆被污染，
    // 最严重的是让我们认不出自己刚发的那条（见 `RowsSpec.timeSelectors`）。
    for (const selector of rows.timeSelectors ?? []) {
      try {
        clone.querySelectorAll(selector).forEach((node) => node.remove());
      } catch {
        /* 选择器不合法：跳过（校验器应已拦下，这里只是双保险） */
      }
    }
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  };

  const matchesAny = (el: Element, selectors: string[]): boolean => {
    for (const selector of selectors) {
      try {
        if (el.matches(selector)) return true;
      } catch {
        /* 选择器不合法：跳过（校验器应当已经拦下，此处只是双保险） */
      }
    }
    return false;
  };

  const hasAny = (el: Element, selectors: string[]): boolean => {
    for (const selector of selectors) {
      try {
        if (el.querySelector(selector)) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  };

  if (!root) {
    return { ok: false, reason: "container_missing", rows: [], moreAbove: false, fallbackPoll: false };
  }

  let rowEls: Element[] = [];
  try {
    rowEls = Array.from(root.querySelectorAll(rows.selector));
  } catch {
    return { ok: false, reason: "rows_selector_invalid", rows: [], moreAbove: false, fallbackPoll: false };
  }
  if (rowEls.length > arg.limit) rowEls = rowEls.slice(-arg.limit);

  const rootRect = root.getBoundingClientRect();
  const width = rootRect.width > 0 ? rootRect.width : 1;
  const idAttr = rows.id ? rows.id.attr : null;
  const tokenAttrs = rows.tokenAttrs.length > 0 ? rows.tokenAttrs : ["class"];

  const facts: RowFact[] = [];
  for (const row of rowEls) {
    if (!isVisible(row)) continue;

    const rawId = idAttr ? row.getAttribute(idAttr) : null;

    // 正文：按候选顺序取第一个非空（已剔除引用块）
    let text = "";
    for (const selector of rows.textSelectors) {
      let candidate: Element | null = null;
      try {
        candidate = row.querySelector(selector);
      } catch {
        candidate = null;
      }
      const value = textOf(candidate);
      if (value) {
        text = value;
        break;
      }
    }
    if (!text) text = textOf(row);

    const excluded = matchesAny(row, rows.exclude) || hasAny(row, rows.exclude);
    const retracted = matchesAny(row, rows.retractedSelectors) || hasAny(row, rows.retractedSelectors);
    const hasMedia = matchesAny(row, rows.attachmentSelectors) || hasAny(row, rows.attachmentSelectors);

    let tailIcon: "out" | "in" | null = null;
    const tail = rows.thenTailIcons;
    if (tail) {
      if (hasAny(row, tail.out) || matchesAny(row, tail.out)) tailIcon = "out";
      else if (hasAny(row, tail.in) || matchesAny(row, tail.in)) tailIcon = "in";
    }
    const checkSpec = rows.thenCheckIcons;
    const checkIcon = checkSpec ? hasAny(row, checkSpec.out) || matchesAny(row, checkSpec.out) : false;

    const rect = row.getBoundingClientRect();
    const cxRatio = Math.max(0, Math.min(1, (rect.left + rect.width / 2 - rootRect.left) / width));

    const tokens: string[] = [];
    for (const attr of tokenAttrs) {
      const value = row.getAttribute(attr) ?? "";
      for (const token of value.toLowerCase().split(/\s+/)) {
        const clean = token.trim();
        if (clean && clean.length <= 40 && !tokens.includes(clean)) tokens.push(clean);
      }
    }

    // 显示时间戳只留痕（本地化文本、不可靠）：**绝不**参与排序或回访计算
    let seenTs: string | null = null;
    const timeEl = row.querySelector("time, [datetime]");
    if (timeEl) {
      const raw = timeEl.getAttribute("datetime") ?? (timeEl.textContent ?? "").trim();
      seenTs = raw ? raw : null;
    }

    facts.push({
      rawId,
      text,
      hasMedia,
      excluded,
      retracted,
      tailIcon,
      checkIcon,
      cxRatio,
      tokens: tokens.slice(0, 24),
      seenTs,
      identity: null,
    });
  }

  // 容器上方还有没有没读到的历史：只看滚动位置，**不假装读完**
  let moreAbove = false;
  try {
    const scroller =
      rows.selector && root.scrollTop > 4
        ? root
        : (() => {
            const candidates = root.querySelectorAll("*");
            for (const el of Array.from(candidates)) {
              if (el.scrollTop > 4) return el;
            }
            return null;
          })();
    moreAbove = Boolean(scroller && scroller.scrollTop > 4);
  } catch {
    moreAbove = false;
  }

  return { ok: true, reason: null, rows: facts, moreAbove, fallbackPoll: false };
}

export interface ExtractFactsOptions {
  containerSelector: string;
  rows: RowsSpec;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * 采一次事实包。
 *
 * 诚实边界：失败**原样上报**（`ok:false` + `reason`），调用方据此走诊断/熔断，
 * **不**把失败伪装成「空会话」（那会让引擎以为对方沉默而继续找话，是最坏的错法）。
 */
export async function extractThreadFacts(
  page: Page,
  options: ExtractFactsOptions,
): Promise<ThreadFacts> {
  if (options.signal?.aborted) {
    return { ok: false, reason: "aborted", rows: [], moreAbove: false, fallbackPoll: false };
  }
  const container = String(options.containerSelector ?? "").trim();
  if (!container) {
    return { ok: false, reason: "container_missing", rows: [], moreAbove: false, fallbackPoll: false };
  }
  try {
    const raw = await page.evaluate(extractFactsInPage, {
      containerSelector: container,
      rows: options.rows,
      limit: Math.max(20, Math.min(FACT_ROW_LIMIT, options.limit ?? FACT_ROW_LIMIT)),
    } satisfies ExtractFactsArg);
    // 页内返回值**不可信**（可能是 null / 老版本脚本 / 注入失败）：形状不对就如实报错，
    // 绝不把「没采到」伪装成「空会话」（那会让引擎以为对方沉默而继续找话）
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as ThreadFacts).rows)) {
      return { ok: false, reason: "facts_shape_invalid", rows: [], moreAbove: false, fallbackPoll: false };
    }
    const facts = raw as ThreadFacts;
    return {
      ok: facts.ok === true,
      reason: facts.reason ?? null,
      // 正文再走一遍**与指纹同一套**的去装饰口径（页面里 textSelectors 可能没覆盖到的形态，
      // 例如时间戳以文本节点形式直接挂在正文里）：必须在**进台账之前**做，
      // 否则流水与指纹两套口径分叉（§0.5.3 A）。
      rows: facts.rows.map((row) => ({ ...row, text: stripDecorationTail(row.text) })),
      moreAbove: facts.moreAbove === true,
      fallbackPoll: facts.fallbackPoll === true,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      rows: [],
      moreAbove: false,
      fallbackPoll: false,
    };
  }
}

/**
 * 容器里到底有没有东西 —— 用来判「描述符没采到行」是**形状不匹配**（站点改版）还是**真的空会话**。
 *
 * 这两个必须分开（坑族 A「判定失败谎报为未命中」）：空会话是正常事实；
 * 有内容却一行都没匹配到，是描述符失效，要进健康熔断而不是装作「对方没说话」。
 */
export async function containerLooksEmpty(page: Page, containerSelector: string): Promise<boolean> {
  const size = await readChatSliceSize(page, containerSelector);
  if (!size) return true;
  return size.childCount === 0;
}
