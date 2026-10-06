/**
 * 会话列表采集（「要聊的对象」勾选用）—— 描述符驱动的**只读**采集 + 纯映射
 *
 * 为什么单独一层：用户不该手打昵称（差一个字就点不中），而应该从页面上**真实存在的**会话列表里勾。
 * 但「读列表」在不同站点形状完全不同（有的项带 `data-peer-id`，有的只有一串可见文本），
 * 所以：
 *   - 描述符声明了 `threads` → 按声明读（准）；
 *   - 没声明 / 没命中 → 通用启发式（页面上「像会话项的可见链接」），**如实标注 `source: "generic"`**，
 *     让视图能告诉用户「这是猜的」。
 *
 * 三条硬纪律：
 *   1. **只读**：本模块（含页内函数）不含任何点击 / 导航 / 滚动 —— 采完列表由 `openContact` 决定怎么打开。
 *   2. **空列表 ≠ 读不到**：一条都没采到时，先看页面上到底有没有像会话项的东西；
 *      真的没有才回 `ok:true, items:[]`；结构不匹配一律 `ok:false`（坑族 A）。
 *   3. **零动态求值**（R8）：页内函数是**固定代码**，描述符只提供选择器 / 属性名 / 数字。
 */

import type { Page } from "playwright-core";

import type { ThreadListItem, ThreadsSpec } from "./types.js";

/** 一次最多采集的候选数（页内夹一次，Node 侧再夹一次；超出的宁可少不要乱） */
export const THREAD_CANDIDATE_LIMIT = 200;

export interface ExtractThreadsArg {
  spec: ThreadsSpec | null;
  limit: number;
}

export interface ThreadsRawItem {
  key: string | null;
  label: string;
  href: string | null;
  unread: boolean;
}

export interface ThreadsProbe {
  ok: boolean;
  reason: string | null;
  source: "descriptor" | "generic";
  items: ThreadsRawItem[];
}

/* eslint-disable complexity */
/**
 * **页内**采集函数（自包含；Playwright 序列化后送进页面）。
 *
 * 通用模式只认「可见链接」：会话列表项在绝大多数站点上就是 `<a href="...">`；
 * 判据刻意保守 —— 有文本、有尺寸、href 不是 `javascript:`/`mailto:`，并且**不是当前地址**
 * （当前地址那一项是「正在看的这个会话」，勾它没有意义）。
 */
function extractThreadsInPage(arg: ExtractThreadsArg): ThreadsProbe {
  const spec = arg.spec;

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };

  const clean = (raw: string): string => String(raw ?? "").replace(/\s+/g, " ").trim();

  const firstText = (root: Element, selectors: string[]): string => {
    for (const selector of selectors) {
      try {
        const node = root.querySelector(selector);
        const text = clean(node?.textContent ?? "");
        if (text) return text;
      } catch {
        /* 选择器不合法：跳过（校验器应当已经拦下） */
      }
    }
    return "";
  };

  const matchesAny = (root: Element, selectors: string[]): boolean => {
    for (const selector of selectors) {
      try {
        if (root.matches(selector) || root.querySelector(selector)) return true;
      } catch {
        /* 同上 */
      }
    }
    return false;
  };

  const absolute = (raw: string | null): string | null => {
    const text = clean(raw ?? "");
    if (!text) return null;
    if (/^(javascript|mailto|tel):/i.test(text)) return null;
    try {
      return new URL(text, window.location.href).href;
    } catch {
      return null;
    }
  };

  const collect = (nodes: Element[], source: "descriptor" | "generic"): ThreadsProbe => {
    const items: ThreadsRawItem[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      if (items.length >= arg.limit) break;
      if (!isVisible(node)) continue;
      // hrefAttr === null 表示「本站没有会话直链」（WhatsApp）：禁止回落读 href，
      // 否则会把无关 a[href] 或空串当成 url，openContact 去 goto / 误开页。
      const href =
        spec && spec.hrefAttr === null
          ? null
          : absolute(node.getAttribute(spec?.hrefAttr || "href"));
      const keyAttr = spec?.keyAttr ?? null;
      const key = keyAttr ? clean(node.getAttribute(keyAttr) ?? "") || null : null;
      const label =
        (spec && spec.labelSelectors.length > 0 ? firstText(node, spec.labelSelectors) : "") ||
        clean(node.getAttribute("aria-label") ?? "") ||
        clean(node.textContent ?? "");
      if (!label) continue;
      // 身份：站点属性 > 直链 > 展示名指纹。三者都没有就不收（可变 key 会让用户勾的人与聊的人错位）
      const identity = key ?? href ?? label.slice(0, 80);
      if (seen.has(identity)) continue;
      seen.add(identity);
      items.push({
        key,
        label: label.slice(0, 80),
        href,
        unread: spec ? matchesAny(node, spec.unreadSelectors) : false,
      });
    }
    return { ok: true, reason: null, source, items };
  };

  // ① 描述符声明：按 itemSelectors 顺序试，**第一个能选出东西的**说了算
  if (spec && spec.itemSelectors.length > 0) {
    for (const selector of spec.itemSelectors) {
      let nodes: Element[] = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch {
        return { ok: false, reason: `item_selector_invalid:${selector}`, source: "descriptor", items: [] };
      }
      if (nodes.length === 0) continue;
      const probe = collect(nodes, "descriptor");
      if (probe.items.length > 0) return probe;
      // 选中了节点却一条可用项都没有：**不说「列表是空的」**，如实报形状不匹配
      return { ok: false, reason: "items_unusable", source: "descriptor", items: [] };
    }
    return { ok: false, reason: "items_not_found", source: "descriptor", items: [] };
  }

  // ② 通用启发式：可见链接（排除当前地址那一项）
  const here = (() => {
    try {
      return window.location.href.split("#")[0];
    } catch {
      return "";
    }
  })();
  const anchors = Array.from(document.querySelectorAll("a[href]")).filter((node) => {
    const href = absolute(node.getAttribute("href"));
    if (!href) return false;
    if (here && href.split("#")[0] === here) return false;
    return true;
  });
  return collect(anchors, "generic");
}

export interface ExtractThreadsOptions {
  spec: ThreadsSpec | null;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * 采一次会话列表。
 *
 * 诚实边界：页内返回值不可信（可能是 null / 注入失败）→ 形状不对一律 `ok:false`，
 * 绝不把「没采到」伪装成「列表是空的」。
 */
export async function extractThreads(page: Page, options: ExtractThreadsOptions): Promise<ThreadsProbe> {
  if (options.signal?.aborted) {
    return { ok: false, reason: "aborted", source: options.spec ? "descriptor" : "generic", items: [] };
  }
  const limit = Math.max(1, Math.min(THREAD_CANDIDATE_LIMIT, options.limit ?? options.spec?.limit ?? 50));
  try {
    const raw = await page.evaluate(extractThreadsInPage, {
      spec: options.spec,
      limit,
    } satisfies ExtractThreadsArg);
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as ThreadsProbe).items)) {
      return { ok: false, reason: "threads_shape_invalid", source: "descriptor", items: [] };
    }
    const probe = raw as ThreadsProbe;
    return {
      ok: probe.ok === true,
      reason: probe.reason ?? null,
      source: probe.source === "generic" ? "generic" : "descriptor",
      items: probe.items,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      source: options.spec ? "descriptor" : "generic",
      items: [],
    };
  }
}

/* ————————————————————————— 纯映射（可离线单测） ————————————————————————— */

export interface MapThreadsOptions {
  /** 页面地址（把相对 href 补成绝对地址，并据此判「是不是同一个会话」） */
  baseUrl: string;
  limit?: number;
}

/**
 * 候选 → 视图用的会话项（**纯函数**）。
 *
 * 两件事在这里做：
 *   1. **补齐绝对地址**：`#123` 这类 hash 直链必须还原成 `https://host/k/#123`
 *      —— 否则 `openContact` 拿到一个相对地址会 `goto` 到错误的地方。
 *   2. **身份（key）落定**：站点属性 > 绝对地址 > 展示名指纹；`key` 必须稳定（展示名会变）。
 */
export function mapThreads(items: readonly ThreadsRawItem[], options: MapThreadsOptions): ThreadListItem[] {
  const limit = Math.max(1, Math.min(THREAD_CANDIDATE_LIMIT, options.limit ?? items.length));
  const out: ThreadListItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (out.length >= limit) break;
    const label = String(item?.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!label) continue;
    const url = resolveUrl(item?.href ?? null, options.baseUrl);
    const key = String(item?.key ?? "").trim() || url || `label:${label}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label, url, unread: item?.unread === true });
  }
  return out;
}

/** 相对地址补全（拿不到 base 就返回原值；非法或危险协议一律 null —— 不猜、也不把 `javascript:` 交给导航） */
export function resolveUrl(href: string | null, baseUrl: string): string | null {
  const text = String(href ?? "").trim();
  if (!text) return null;
  if (/^(javascript|mailto|tel|data|blob):/i.test(text)) return null;
  try {
    const resolved = new URL(text, baseUrl || undefined).href;
    return /^(javascript|mailto|tel|data|blob):/i.test(resolved) ? null : resolved;
  } catch {
    return null;
  }
}
