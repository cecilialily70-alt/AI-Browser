/**
 * 跨文档作用域（Frame Scope）
 *
 * 解决的问题：注册/支付/第三方登录的真实控件大量住在 `<iframe>` 里。观察层早就能列出它们
 * （`page.frames()` 逐个穿透），但**执行层只认主文档** —— 于是模型看到 `[12] <input type=checkbox>`、
 * 点了却什么都没发生，还得不出「为什么」。这比不列出来更糟：它会一直重试。
 *
 * 本模块只做一件事：把「元素属于哪个文档」变成可传递的一等公民。
 *
 *   - `DomScope`：主文档 = `Page`，嵌套文档 = `Frame`。两者都支持 `evaluate` / `locator`，
 *     所以探针类逻辑（命中点、新鲜度、回读、遮挡）对两者一视同仁，判据完全一致。
 *   - 坐标换算：嵌套文档里的 `getBoundingClientRect()` 是**框架局部坐标**，
 *     物理鼠标点击要的是**主文档视口坐标**。偏移量取 `frameElement().boundingBox()`
 *     （Playwright 已把整条框架链折算好），一处换算、全链路统一。
 *
 * 不做的事：跨域框架。跨域文档连 `evaluate` 都进不去，只能靠视觉兜底或人工接管，
 * 这里显式返回 `cross-origin`，让上层给出可执行的替代路径，而不是让模型反复点空气。
 */
import type { ElementHandle, Frame, Page } from "playwright-core";

/** 文档作用域：主文档是 Page，嵌套文档是 Frame */
export type DomScope = Page | Frame;

/**
 * 文档/窗口「已经不在了」类错误：页面（或整个浏览器）在被读/被操作的过程中被关掉。
 *
 * 为什么必须单独识别：第三方授权弹窗办完事会**自己关掉**，用户也可能随时关标签页。
 * 这时页面引用突然失效，Playwright 抛的是 `Target page, context or browser has been closed`
 * —— 它是**环境变了**，不是任务失败。把它当成硬错误抛出去，整个任务就死在一个已经消失的窗口上。
 *
 * 判据按错误类名 + 语义匹配（不用站点/文案硬编码）：Playwright 在不同阶段抛的文案并不一致，
 * 但都表达同一件事 —— 你手里的文档没了。
 */
export function isScopeGoneError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "object" && err !== null) {
    const name = String((err as { name?: unknown }).name ?? "");
    if (name === "TargetClosedError") return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /Target page, context or browser has been closed|Target closed|browser has been closed|Frame was detached|Execution context was destroyed/i.test(
    message,
  );
}

export interface FrameOffset {
  x: number;
  y: number;
}

export interface ElementScope {
  /** 元素所在文档 */
  scope: DomScope;
  /** 嵌套文档相对主文档视口的偏移；主文档为 (0,0) */
  offset: FrameOffset;
  /** 嵌套文档在主文档视口里的矩形；主文档为 null */
  box: { x: number; y: number; w: number; h: number } | null;
  /** 嵌套文档 URL；主文档为 null */
  frameUrl: string | null;
}

export const NO_OFFSET: FrameOffset = { x: 0, y: 0 };

export type FrameLookupFailure = "cross-origin" | "detached";

export interface FrameLookup {
  ok: boolean;
  frame: Frame | null;
  /** 框架在主文档视口里的矩形；解析不到时为 null */
  box: { x: number; y: number; w: number; h: number } | null;
  offset: FrameOffset;
  failure: FrameLookupFailure | null;
  /** 观测时记录的框架 URL（用于日志与失败回执）；主文档为 null */
  frameUrl: string | null;
}

/**
 * 取作用域所属的 Page。
 * 用途：`mouse` / `keyboard` 这类**页面级**能力只存在于 Page 上；
 * 嵌套框架的文档内操作走 `evaluate`/`locator`，物理输入则统一回到 Page。
 */
export function scopePage(scope: DomScope): Page {
  const maybePage = (scope as Frame).page;
  return typeof maybePage === "function" ? (scope as Frame).page() : (scope as Page);
}

/** 框架局部坐标 → 主文档视口坐标 */
export function toPagePoint(point: { x: number; y: number }, offset: FrameOffset): { x: number; y: number } {
  return { x: Math.round(point.x + offset.x), y: Math.round(point.y + offset.y) };
}

/** 框架局部矩形 → 主文档视口矩形 */
export function toPageRect<T extends { x: number; y: number }>(rect: T, offset: FrameOffset): T {
  return { ...rect, x: Math.round(rect.x + offset.x), y: Math.round(rect.y + offset.y) };
}

function isMainFrame(frame: Frame, page: Page): boolean {
  try {
    return frame === page.mainFrame();
  } catch {
    return false;
  }
}

/** 框架能否执行脚本（跨域 / 已卸载的框架会抛） */
async function isScriptable(frame: Frame): Promise<boolean> {
  try {
    await frame.evaluate(() => true);
    return true;
  } catch {
    return false;
  }
}

/**
 * 嵌套文档在主文档视口里的矩形。
 * `boundingBox()` 返回的是**主文档视口**坐标（Playwright 已折算整条框架链），
 * 因此嵌套 iframe 也只需一次调用，不必自己层层累加。
 */
export async function frameViewportBox(
  frame: Frame,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  let handle: ElementHandle | null = null;
  try {
    handle = await frame.frameElement();
  } catch {
    return null;
  }
  if (!handle) return null;
  try {
    const box = await handle.boundingBox();
    if (!box) return null;
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.width),
      h: Math.round(box.height),
    };
  } catch {
    return null;
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

/**
 * 按观测时记录的 URL 找回框架。
 *
 * 用 URL 而不是下标：观察与执行之间 DOM 可能重排，下标会指到别的框架；
 * URL 相同则取第一个仍可执行的（同一个 URL 出现多个实例时，取第一个是确定性行为，
 * 且这些实例在结构上通常互为镜像）。
 */
export async function resolveFrameScope(
  page: Page,
  frameUrl: string | null | undefined,
): Promise<FrameLookup> {
  const url = String(frameUrl ?? "").trim();
  if (!url) {
    // 主文档：没有框架可解析，直接返回主作用域信号（`scope` 由调用方给出）
    return { ok: true, frame: null, box: null, offset: NO_OFFSET, failure: null, frameUrl: null };
  }
  let candidates: Frame[] = [];
  try {
    candidates = page.frames().filter((frame) => !isMainFrame(frame, page) && frame.url() === url);
  } catch {
    return { ok: false, frame: null, box: null, offset: NO_OFFSET, failure: "detached", frameUrl: url };
  }
  if (!candidates.length) {
    return { ok: false, frame: null, box: null, offset: NO_OFFSET, failure: "detached", frameUrl: url };
  }
  for (const frame of candidates) {
    if (!(await isScriptable(frame))) continue;
    const box = await frameViewportBox(frame);
    return {
      ok: true,
      frame,
      box,
      offset: box ? { x: box.x, y: box.y } : NO_OFFSET,
      failure: null,
      frameUrl: url,
    };
  }
  // 存在同名框架但没有一个能执行 → 跨域（evaluate 必然抛）
  return {
    ok: false,
    frame: null,
    box: null,
    offset: NO_OFFSET,
    failure: "cross-origin",
    frameUrl: url,
  };
}

/**
 * 元素作用域：把「记录下来的 frameUrl」解析成可直接执行的作用域。
 * `failure` 非空表示框架已不可用（跨域 / 已卸载）——调用方应据此给出可执行路径，而不是照常点击。
 */
export async function resolveElementScope(
  page: Page,
  frameUrl: string | null | undefined,
): Promise<ElementScope & { failure: FrameLookupFailure | null }> {
  const lookup = await resolveFrameScope(page, frameUrl);
  if (lookup.ok) {
    return {
      scope: lookup.frame ?? page,
      offset: lookup.offset,
      box: lookup.box,
      frameUrl: lookup.frameUrl,
      failure: null,
    };
  }
  return {
    scope: page,
    offset: NO_OFFSET,
    box: null,
    frameUrl: lookup.frameUrl,
    failure: lookup.failure,
  };
}

/** 供日志/回执使用的一句话作用域说明（主文档不产生噪音） */
export function describeScope(frameUrl: string | null | undefined): string {
  const url = String(frameUrl ?? "").trim();
  if (!url) return "主文档";
  return `嵌套框架 ${url.length > 60 ? `${url.slice(0, 60)}…` : url}`;
}

export type FrameFailureReason = "detached" | "cross-origin";

/** 框架层面的失败说明（不含任何站点文案，给模型的是可执行路径） */
export function describeFrameFailure(reason: FrameFailureReason, frameUrl: string | null): string {
  const where = describeScope(frameUrl);
  if (reason === "cross-origin") {
    // 措辞必须谨慎：CDP 能进跨域框架，走到这里说明「这个文档连脚本注入都失败了」
    //（典型：正在卸载、被站点隔离、或文档禁用了脚本），不能断言「跨域=进不去」。
    return `${where} 当前无法注入脚本（正在卸载/被隔离/禁用脚本）：请改用视觉定位/截图判断内部控件，或 handover 交人处理`;
  }
  return `${where} 已不存在（框架已卸载或跳转）：请重新观察页面后按新 index 操作`;
}

/**
 * 嵌套文档的可见盒子（框架局部坐标下的 0..w/0..h）。
 * 用途：框架自己内部的滚动会让元素矩形落到可见盒子之外 —— 那里的坐标加上偏移后
 * 并不属于这个框架，直接点击会打到主文档的其它内容上。所以这类点必须被排除。
 */
export async function frameVisibleBox(
  frame: Frame,
): Promise<{ w: number; h: number } | null> {
  try {
    const size = (await frame.evaluate(() => ({
      w: Math.round(window.innerWidth || 0),
      h: Math.round(window.innerHeight || 0),
    }))) as { w: number; h: number };
    if (!size || size.w < 1 || size.h < 1) return null;
    return size;
  } catch {
    return null;
  }
}

/** 框架局部矩形是否落在框架的可见盒子内（用于判断能否用坐标点击） */
export function rectInsideBox(
  rect: { x: number; y: number; w: number; h: number },
  box: { w: number; h: number } | null,
): boolean {
  if (!box) return false;
  const bottom = rect.y + rect.h;
  const right = rect.x + rect.w;
  return bottom > 0 && rect.y < box.h && right > 0 && rect.x < box.w;
}

/** 框架局部坐标下的单点是否落在框架可见盒子里（框架自身滚出可视区的点不能点） */
export function pointInsideBox(
  point: { x: number; y: number },
  box: { w: number; h: number } | null,
): boolean {
  if (!box) return false;
  return point.x >= 0 && point.y >= 0 && point.x <= box.w && point.y <= box.h;
}

/**
 * 主文档顶层归属检查：判断「主文档视口里的这个点」是不是真的落在指定框架区域内。
 *
 * 必须做这一步的原因：框架内的 `elementFromPoint` 看不见主文档的弹层。
 * 一个主文档的 cookie 横幅压住整个 iframe 时，框架内部的自检会报告「一切正常」，
 * 而物理点击会被横幅吃掉 —— 于是模型看到「点击成功」但什么都没发生。
 * 返回 null = 该点确实属于这个框架盒子；否则返回遮挡者描述。
 */
export async function describeMainDocumentCover(
  page: Page,
  point: { x: number; y: number },
  frameBox: { x: number; y: number; w: number; h: number },
): Promise<string | null> {
  try {
    return (await page.evaluate(
      ({
        x,
        y,
        box,
      }: {
        x: number;
        y: number;
        box: { x: number; y: number; w: number; h: number };
      }) => {
        const clean = (value: string | null | undefined, max = 40): string =>
          String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
        const describe = (el: Element): string => {
          const tag = el.tagName.toLowerCase();
          const id = clean(el.id, 24);
          const label = clean(el.getAttribute("aria-label"), 24);
          const text = clean(el.textContent, 24);
          return `${tag}${id ? `#${id}` : ""}${label ? `「${label}」` : text ? `「${text}」` : ""}`;
        };
        const top = document.elementFromPoint(Math.round(x), Math.round(y));
        if (!top) return null;
        // 命中点落在期望的框架盒子里 → 归属正确
        const rect = top.getBoundingClientRect();
        const sameBox =
          top.tagName.toLowerCase() === "iframe" &&
          Math.abs(rect.left - box.x) <= 2 &&
          Math.abs(rect.top - box.y) <= 2 &&
          Math.abs(rect.width - box.w) <= 2 &&
          Math.abs(rect.height - box.h) <= 2;
        return sameBox ? null : describe(top);
      },
      { x: point.x, y: point.y, box: frameBox },
    )) as string | null;
  } catch {
    return null;
  }
}
