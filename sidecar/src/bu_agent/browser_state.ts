import type { Page } from "playwright-core";
import {
  type AgentElementAffinity,
  type AgentElementRef,
  type AgentExtractResult,
} from "../interactive_elements.js";
import { indexElements, type IndexSource } from "../core/index_space.js";
import { isScopeGoneError } from "../core/dom_scope.js";
import { tabIdOf } from "./tab_registry.js";
import type { BrowserStateSummary, IndexedElementRef } from "./views.js";
function toIndexedRef(
  index: number,
  shortId: string,
  ref: AgentElementRef,
  el: {
    type: string;
    text: string;
    name?: string;
    placeholder?: string;
    role?: string;
    checked?: boolean | null;
    affinity?: AgentElementAffinity;
    humanOnly?: string | null;
    filled?: boolean | null;
  },
): IndexedElementRef {
  return {
    index,
    shortId,
    selector: ref.selector,
    xpath: ref.xpath,
    tagName: ref.tagName,
    inputType: ref.inputType,
    text: el.text || ref.text,
    role: el.role,
    placeholder: el.placeholder,
    name: el.name,
    checked: el.checked ?? ref.checked ?? null,
    rect: ref.rect ?? null,
    frameUrl: ref.frameUrl ?? null,
    affinity: el.affinity,
    humanOnly: el.humanOnly ?? ref.humanOnly ?? null,
    filled: typeof el.filled === "boolean" ? el.filled : (ref.filled ?? null),
    fingerprint: ref.fingerprint,
  };
}

export interface TabInfo {
  /** 稳定 id（`t1`/`t2`…）：关掉别的标签后不变，是 switch/close 的首选目标 */
  id: string;
  url: string;
  title: string;
  /** 位置（1 基）：等价别名 `*N`；关标签后会被后面的标签顶上 */
  pos: number;
  /** 当前观察作用域所在的标签页。控件索引**只属于** active 标签页 */
  active: boolean;
}

/**
 * 列出所有标签页。`id` 是**稳定 id**（见 tab_registry），`pos` 是位置别名。
 * 由本函数统一产出，避免多处各自拼 id 后对不上。
 */
export async function listTabs(page: Page): Promise<TabInfo[]> {
  const context = page.context();
  const pages = context.pages();
  const out: TabInfo[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    let title = "";
    try {
      title = await p.title();
    } catch {
      title = "";
    }
    out.push({ id: tabIdOf(p), pos: i + 1, url: p.url(), title, active: p === page });
  }
  return out;
}

/** 当前上下文里的存活页数量（拿不到就返回 0，仅用于比较增量） */
export function countLivePages(page: Page): number {
  try {
    return page.context().pages().length;
  } catch {
    return 0;
  }
}

/**
 * 上一步是否新开了标签页（新页永远追加在末尾）。
 * 返回给模型的一句话提示；没有新页则返回空数组。
 */
export async function describeOpenedTabs(page: Page, countBefore: number): Promise<string[]> {
  if (countBefore <= 0) return [];
  try {
    const tabs = await listTabs(page);
    if (tabs.length <= countBefore) return [];
    const opened = tabs.slice(countBefore);
    const list = opened.map((t) => `${t.id}(*${t.pos}) ${t.url || "(加载中)"}`).join("；");
    return [
      `检测到新标签页：${list}。控件索引只属于 active 标签页，` +
        `若当前流程（第三方登录/支付/验证码）在新页里，请先 switch(tab_id="${opened[0]!.id}") 切过去，下一步会自动重新观察。`,
    ];
  } catch {
    return [];
  }
}

function escapeAttr(v: string): string {
  return `"${v.replace(/"/g, "'").slice(0, 80)}"`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * 从抽取结果建「模型索引 → 元素引用」映射。
 * 编号规则见 core/index_space（唯一实现）—— 这里与视觉重定位后刷新索引空间用的是同一条规则，
 * 否则会出现「回执里给的新编号在映射里解析不到」这种隐蔽错位。
 */
export function createSelectorMap(extracted: IndexSource): Map<number, IndexedElementRef> {
  const map = new Map<number, IndexedElementRef>();
  for (const { index, shortId, llm, ref } of indexElements(extracted).values()) {
    map.set(index, toIndexedRef(index, shortId, ref, llm));
  }
  return map;
}

/** 用 shortId 集合标记新元素更稳：比较上一步 shortId */
export function buildBrowserStateWithShortIdDiff(
  page: Page,
  extracted: AgentExtractResult,
  previousShortIds: Set<string> | null,
  previousUrl: string | null,
  maxChars = 40000,
): Promise<BrowserStateSummary> {
  const max = maxChars;
  const selectorMap = new Map<number, IndexedElementRef>();
  const lines: string[] = [];
  const frameUrls = new Set<string>();
  let inFrame = false;
  const urlChanged = Boolean(previousUrl) && previousUrl !== extracted.url;
  // 编号规则只有一份实现（core/index_space.ts）：这里与视觉重定位必须给出同一个 [index]
  for (const { index, shortId, llm: el, ref } of indexElements(extracted).values()) {
    selectorMap.set(index, toIndexedRef(index, shortId, ref, el));
    const isNew =
      !urlChanged && previousShortIds && previousShortIds.size > 0 && !previousShortIds.has(el.id);
    const star = isNew ? "*" : "";
    const attrs: string[] = [];
    if (el.type && el.type !== "other") attrs.push(`type=${escapeAttr(el.type)}`);
    if (el.placeholder) attrs.push(`placeholder=${escapeAttr(el.placeholder)}`);
    if (el.name) attrs.push(`name=${escapeAttr(el.name)}`);
    if (el.role) attrs.push(`role=${escapeAttr(el.role)}`);
    if (el.checked != null) attrs.push(`state=${el.checked ? '"checked"' : '"unchecked"'}`);
    // 字段已有内容：模型看不到框里的值，缺这条就会「以为没填 → 再写一遍」（重复写入的常见来源）
    if (el.filled === true || ref.filled === true) attrs.push(`filled="1"`);
    // 一次性凭证：值只可能在用户本人手上。标进列表，让模型在决策前就看到这条硬约束；
    // 运行时还会在 input/done 上强制兜底（见 core/human_credential）。
    const humanOnly = el.humanOnly ?? ref.humanOnly ?? null;
    if (humanOnly) {
      attrs.push('human_only="1"');
      attrs.push(`why=${escapeAttr(humanOnly)}`);
    }
    // 嵌套框架元素：必须显式标注。否则模型看到 index 却点不动时，
    // 只会怀疑自己数错号（这正是「看得见、点不着」最伤人的地方）。
    // URL 只在顶部的图例里列一次，避免每个元素都刷一遍长 URL 把控件树撑爆。
    if (ref.frameUrl) {
      inFrame = true;
      frameUrls.add(ref.frameUrl);
      attrs.push('in_frame="1"');
    }
    if (el.affinity) {
      const a = el.affinity;
      attrs.push(`affinity=${escapeAttr(a.kind)}`);
      if (a.kind === "choice-companion" && a.targetId) attrs.push(`click_instead=${escapeAttr(a.targetId)}`);
      if (a.kind === "choice-control") attrs.push(`is_the_target="1"`);
      if (a.navigates) attrs.push(`leaves_page="1"`);
      attrs.push(`why=${escapeAttr(a.reason)}`);
    }
    const tag = (ref.tagName || "div").toLowerCase();
    const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
    lines.push(`${star}[${index}]<${tag}${attrStr} id="${el.id}" />`);
    if (el.text?.trim()) lines.push(`\t${truncate(el.text.trim(), 120)}`);
  }
  let tree = lines.join("\n");
  if (tree.length > max) tree = `${tree.slice(0, max)}\n…(truncated)`;
  if (inFrame) {
    // 图例：说明这些条目就在嵌套框架里、可直接用 index 操作，并列出框架来源（便于人工复盘）
    const legend = [...frameUrls].map((url) => truncate(url, 70)).join(" ; ");
    tree = `# 嵌套框架（in_frame="1" 的条目属于下列文档）：${legend}\n# 这些 index 可以直接用 click/input 操作，无需任何切换（switch 是换标签页，与框架无关）；若报「框架已失效」则重新观察。\n${tree}`;
  }

  return (async () => {
    // 观察途中页面可能被关掉（第三方授权弹窗自己关闭 / 用户关标签页）：
    // 这些都是**读**，读不到就不读 —— 绝不能因为一个已经消失的窗口把整个任务抛死。
    // 上层据 pageClosed 重新绑定存活页面并重新观察。
    let pageClosed = page.isClosed();
    let pagesAbove = 0;
    let pagesBelow = 0;
    if (!pageClosed) {
      try {
        const scroll = await page.evaluate(() => {
          const doc = document.documentElement;
          const scrollTop = window.scrollY || doc.scrollTop || 0;
          const view = window.innerHeight || 1;
          const height = Math.max(doc.scrollHeight, doc.clientHeight);
          return {
            pagesAbove: Math.max(0, scrollTop / view),
            pagesBelow: Math.max(0, (height - scrollTop - view) / view),
          };
        });
        pagesAbove = scroll.pagesAbove;
        pagesBelow = scroll.pagesBelow;
      } catch (err) {
        if (!isScopeGoneError(err)) throw err;
        pageClosed = true;
      }
    }
    const tabs = pageClosed ? [] : await listTabs(page).catch(() => []);
    const title = pageClosed ? "" : await page.title().catch(() => "");
    return {
      url: extracted.url || (pageClosed ? "" : page.url()),
      title,
      tabs,
      interactiveTree: tree || "(no interactive elements in viewport)",
      elementCount: selectorMap.size,
      selectorMap,
      screenshotBase64: extracted.screenshotBase64 ?? null,
      pageClosed,
      pageInfo: {
        pagesAbove: Number(pagesAbove.toFixed(2)),
        pagesBelow: Number(pagesBelow.toFixed(2)),
      },
    };
  })();
}
