/**
 * 标签页的**稳定 id**（`t1` / `t2` …）与位置别名（`*2` / `2` / `0002`）。
 *
 * 为什么需要：
 * 旧实现把「第 N 个标签」直接当 id（`0002` = 页序号）。一旦关掉前面的标签，
 * 后面所有标签的序号整体左移 —— 模型手里的 `*3` 会**静默指到别的页**，
 * 于是「取标签1的数据、填到标签3」这类跨标签任务会写错页，且没有任何报错。
 *
 * 设计取舍：
 * - 用 **Page 对象身份**做键（WeakMap），**不用 CDP targetId**：跨进程导航（部分重定向）
 *   会把 targetId 换掉，而 Page 在导航中稳定。
 * - id **只发一次、永不复用**：关掉 t2 之后再开新标签是 t4，不会让新页沿用 t2 的语义。
 * - 编号按**每个浏览器上下文**内「首次被观察到的顺序」递增 —— 新标签总是追加在末尾，
 *   所以该顺序就是创建顺序，且列表里永远是密集的 t1..tn，不会出现跳号。
 * - 位置别名仍然可用（模型/用户习惯说「第二个标签」），但只在**当次**解析位置；
 *   越界一律报错，绝不静默落到别的页（fail closed）。
 */
import type { BrowserContext, Page } from "playwright-core";

/** 每个上下文已发出去的 id 计数（永不回退） */
const contextOrdinal = new WeakMap<BrowserContext, number>();
/** Page → 稳定 id（Page 被 GC 时自动回收） */
const pageToTabId = new WeakMap<Page, string>();

/** 拿不到上下文时的兜底 id（极少数已销毁页面，只用于日志展示） */
const ORPHAN_TAB_ID = "t?";

function livePages(page: Page): Page[] {
  try {
    return page.context().pages();
  } catch {
    return [];
  }
}

/**
 * 取该页的稳定 id；首次调用时分配。
 * 同一 Page 多次调用返回同一个 id（导航、刷新都不变）。
 */
export function tabIdOf(page: Page): string {
  const existing = pageToTabId.get(page);
  if (existing) {
    return existing;
  }
  let context: BrowserContext;
  try {
    context = page.context();
  } catch {
    return ORPHAN_TAB_ID;
  }
  const next = (contextOrdinal.get(context) ?? 0) + 1;
  contextOrdinal.set(context, next);
  const id = `t${next}`;
  pageToTabId.set(page, id);
  return id;
}

/** 该页在当前上下文里的位置（1 基）；已不在上下文里返回 0 */
export function tabPosition(page: Page): number {
  const pages = livePages(page);
  const index = pages.indexOf(page);
  return index < 0 ? 0 : index + 1;
}

/** 解析模型给的 tab 引用：`t2`（稳定）/ `*2`、`2`、`0002`（位置） */
export type TabRef = { kind: "stable"; id: string } | { kind: "position"; index: number };

export function parseTabRef(raw: string): TabRef | null {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }
  const stable = /^t(\d+)$/i.exec(text);
  if (stable) {
    const n = Number.parseInt(stable[1]!, 10);
    return n > 0 ? { kind: "stable", id: `t${n}` } : null;
  }
  const positional = /^\*?(0*)(\d+)$/.exec(text);
  if (positional) {
    const n = Number.parseInt(positional[2]!, 10);
    return n > 0 ? { kind: "position", index: n } : null;
  }
  return null;
}

/**
 * 把 tab 引用解析成具体的 Page。
 * - 稳定 id：只在**已分配过**的 id 里找（不顺手给别的页发 id，避免解析带副作用）
 * - 位置：按当前 `context.pages()` 顺序取第 N 个
 * 解析不到返回 null（调用方负责报错，禁止兜底到别的页）。
 */
export function resolveTab(page: Page, raw: string): Page | null {
  const ref = parseTabRef(raw);
  if (!ref) {
    return null;
  }
  const pages = livePages(page);
  if (ref.kind === "stable") {
    return pages.find((candidate) => pageToTabId.get(candidate) === ref.id) ?? null;
  }
  return pages[ref.index - 1] ?? null;
}

/** 当前可用的标签（用于失败时给模型准确的可选值，而不是让它瞎猜） */
export function describeAvailableTabs(page: Page): string {
  const pages = livePages(page);
  if (pages.length === 0) {
    return "当前没有可用标签页";
  }
  return pages
    .map((candidate, index) => {
      const id = tabIdOf(candidate);
      const url = (() => {
        try {
          return candidate.url();
        } catch {
          return "";
        }
      })();
      return `${id}(*${index + 1})`;
    })
    .join("、");
}

/** tab_id 文案（工具描述与报错共用一套，避免两处说法打架） */
export const TAB_ID_SPEC =
  "tab_id 用观察结果里的稳定 id（如 t2）或位置写法（*2 / 2）。稳定 id 关掉别的标签后不变；" +
  "位置写法按当前顺序解析。两者都找不到时直接报错，不会落到别的标签。";
