/**
 * Set-of-Mark (SoM) 统一标记层。
 *
 * 存在意义：文本索引（`[12] <input ... />`）与画面之间本来没有任何硬链接，
 * 模型只能自己把「第 12 个控件」脑补到截图的某个位置 —— 框选错位就是这么来的。
 * 本模块把「编号」同时画进图里，且**编号与文本 index 严格同源**：
 *
 *   编号 N  ===  交互元素列表里的 index N
 *
 * 于是模型可以「看图确认 + 用 index 执行」，两条通道互为交叉验证，
 * 而不是两套互相打架的坐标系。
 *
 * 实现要点（都是踩过的坑）：
 *  - 标记层是**零尺寸宿主 + 文档坐标**绝对定位：不参与布局、不影响 scrollHeight
 *    （否则会污染全景截图的分帧步长），并且滚动时标记跟着元素走，
 *    一次注入即可服务多帧全景截图。
 *  - 只标注「蒸馏后仍在列表里」的元素，编号才不会出现「图上有 37、列表里没有 37」。
 *  - 全程 fail-safe：注入/清除失败都不抛错，最坏退化成「无标记截图」。
 */
import type { Page } from "playwright-core";

import {
  pointInsideBox,
  resolveFrameScope,
  frameVisibleBox,
  type DomScope,
} from "./dom_scope.js";
import type { AgentElementRef, AgentLlmElement } from "../interactive_elements.js";

export interface SomMark {
  /** 与交互元素文本列表的 index 严格一致 */
  index: number;
  /** **主文档视口**坐标（CSS px，采集时刻）：框架元素的坐标已换算过 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 元素文案，仅用于诊断日志 */
  label: string;
  /** 所属嵌套框架 URL；主文档为 null。标记要画进元素自己的文档，否则会被框架裁剪掉 */
  frameUrl?: string | null;
}

export interface SomMarkStats {
  /** 真正画进图里的编号数量 */
  marked: number;
  /** 可标注的候选数量（去噪后列表里带有效矩形的元素） */
  candidates: number;
  /** 未标注的原因（供模型理解「编号可能不全」） */
  reason: string | null;
}

interface SomSource {
  llm_json: AgentLlmElement[];
  element_map: Map<string, AgentElementRef>;
}

const HOST_ATTR = "data-agent-som-host";
const MARK_ATTR = "data-agent-som";

/** 描边框与编号徽标的配色（红底白字，与既有 captcha SoM 标记保持同一视觉语言） */
const MARK_COLOR = "#e11d48";

export interface BuildSomMarksOptions {
  max: number;
  /** 采集矩形时的视口尺寸（CSS px）。用于在超上限时优先保留「模型马上能看到」的元素 */
  viewport?: { width: number; height: number } | null;
}

/** 矩形中心到视口中心的距离；缺视口信息时退化为「离视口左上角多近」 */
function viewportDistance(
  rect: SomMark,
  viewport: BuildSomMarksOptions["viewport"],
): number {
  if (viewport && viewport.width > 1 && viewport.height > 1) {
    const dx = rect.x + rect.w / 2 - viewport.width / 2;
    const dy = rect.y + rect.h / 2 - viewport.height / 2;
    return Math.hypot(dx, dy);
  }
  return Math.abs(rect.x) + Math.abs(rect.y);
}

/**
 * 从（蒸馏后的）元素列表推导可标注目标。
 *
 * 只标注有有效矩形的元素；超上限时优先保留离视口中心最近的，
 * 最后按 index 升序输出 —— 保证同一页面同一状态下的标记结果确定可复现。
 */
export function buildSomMarks(source: SomSource, options: BuildSomMarksOptions): SomMark[] {
  const candidates: Array<{ mark: SomMark; distance: number }> = [];
  for (const el of source.llm_json) {
    const index = Number(el.id);
    if (!Number.isFinite(index) || index <= 0) continue;
    const ref = source.element_map.get(el.id);
    if (!ref) continue;
    const rect = ref.rect;
    if (!rect || rect.w < 2 || rect.h < 2) continue;
    // 极端离屏（虚拟列表回收后残留的坐标）不标，避免在页面外围画出幽灵标记
    if (rect.x < -8000 || rect.y < -8000) continue;
    const mark: SomMark = {
      index,
      // 已是主文档视口坐标；框架元素另记 frameUrl，注入时按框架分组
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      label: (el.text || ref.text || "").slice(0, 40),
      frameUrl: ref.frameUrl ?? null,
    };
    candidates.push({ mark, distance: viewportDistance(mark, options.viewport) });
  }

  const limit = Math.max(1, Math.floor(options.max));
  const picked =
    candidates.length <= limit
      ? candidates
      : candidates.slice().sort((a, b) => a.distance - b.distance).slice(0, limit);
  return picked.map((c) => c.mark).sort((a, b) => a.index - b.index);
}

/** 同一文档内的标记集合：坐标已换算成该文档自己的坐标系 */
interface SomScopeGroup {
  scope: DomScope;
  items: SomMark[];
}

/**
 * 按所属文档分组，并把主文档坐标换算回**各文档自己的坐标系**。
 * 标记必须画在元素所在的文档里：画在主文档只会被框架裁剪掉，
 * 而画到错的文档上则会盖住完全无关的内容。
 */
async function groupMarksByScope(page: Page, marks: SomMark[]): Promise<SomScopeGroup[]> {
  const groups = new Map<string, SomScopeGroup>();
  const push = (key: string, scope: DomScope, item: SomMark) => {
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      return;
    }
    groups.set(key, { scope, items: [item] });
  };
  for (const mark of marks) {
    const frameUrl = String(mark.frameUrl ?? "").trim();
    if (!frameUrl) {
      push("", page, mark);
      continue;
    }
    const lookup = await resolveFrameScope(page, frameUrl);
    if (!lookup.ok || !lookup.frame) continue; // 解析不到框架 → 宁可不标，也不能标错位置
    const visible = await frameVisibleBox(lookup.frame);
    const local: SomMark = {
      ...mark,
      x: mark.x - lookup.offset.x,
      y: mark.y - lookup.offset.y,
    };
    if (!pointInsideBox({ x: local.x, y: local.y }, visible)) continue;
    push(frameUrl, lookup.frame, local);
  }
  return [...groups.values()];
}

/** 需要清理标记的文档：主文档（兜底） + 每个标记所属的文档 */
async function somScopes(page: Page, marks: SomMark[]): Promise<DomScope[]> {
  const scopes: DomScope[] = [page];
  const seen = new Set<string>([""]);
  for (const mark of marks) {
    const frameUrl = String(mark.frameUrl ?? "").trim();
    if (!frameUrl || seen.has(frameUrl)) continue;
    seen.add(frameUrl);
    const lookup = await resolveFrameScope(page, frameUrl);
    if (lookup.ok && lookup.frame) scopes.push(lookup.frame);
  }
  return scopes;
}

/**
 * 注入标记。返回实际注入数量；任何失败都返回 0（不抛错）。
 */
export async function injectSomMarks(page: Page, marks: SomMark[]): Promise<number> {
  if (!marks.length || page.isClosed()) return 0;
  try {
    const groups = await groupMarksByScope(page, marks);
    let injected = 0;
    for (const group of groups) {
      injected += await injectIntoScope(group.scope, group.items);
    }
    return injected;
  } catch {
    return 0;
  }
}

/** 向单个文档注入标记（坐标必须是该文档自己的坐标系） */
async function injectIntoScope(scope: DomScope, items: SomMark[]): Promise<number> {
  if (!items.length) return 0;
  try {
    return await scope.evaluate(
      ({ items, hostAttr, markAttr, color }: {
        items: SomMark[];
        hostAttr: string;
        markAttr: string;
        color: string;
      }) => {
        const clear = () => {
          try {
            document.querySelectorAll(`[${hostAttr}]`).forEach((node) => node.remove());
          } catch {
            /* ignore */
          }
        };
        clear();

        const scrollX = window.scrollX || 0;
        const scrollY = window.scrollY || 0;

        const host = document.createElement("div");
        host.setAttribute(hostAttr, "1");
        // 零尺寸宿主：不参与布局、不撑高 scrollHeight，子元素按文档坐标自由溢出
        host.style.cssText = [
          "position:absolute",
          "top:0",
          "left:0",
          "width:0",
          "height:0",
          "overflow:visible",
          "pointer-events:none",
          "z-index:2147483646",
        ].join(";");

        let injected = 0;
        for (const m of items) {
          try {
            const left = Math.max(0, m.x) + scrollX;
            const top = Math.max(0, m.y) + scrollY;

            const box = document.createElement("div");
            box.setAttribute(markAttr, String(m.index));
            box.style.cssText = [
              "position:absolute",
              `left:${left}px`,
              `top:${top}px`,
              `width:${m.w}px`,
              `height:${m.h}px`,
              "box-sizing:border-box",
              `border:2px solid ${color}`,
              "border-radius:2px",
              "pointer-events:none",
            ].join(";");

            const chip = document.createElement("div");
            chip.setAttribute(markAttr, String(m.index));
            chip.textContent = String(m.index);
            const chipH = 16;
            const above = m.y - chipH >= 0;
            chip.style.cssText = [
              "position:absolute",
              `left:${left}px`,
              `top:${above ? top - chipH : top}px`,
              `background:${color}`,
              "color:#fff",
              "font:700 11px/14px monospace",
              "padding:1px 4px",
              "border-radius:3px",
              "box-shadow:0 0 0 1px rgba(255,255,255,.9)",
              "pointer-events:none",
              "white-space:nowrap",
            ].join(";");

            host.appendChild(box);
            host.appendChild(chip);
            injected += 1;
          } catch {
            /* 单个标记失败不影响其余 */
          }
        }

        if (injected === 0) return 0;
        try {
          document.documentElement.appendChild(host);
        } catch {
          return 0;
        }
        return injected;
      },
      { items, hostAttr: HOST_ATTR, markAttr: MARK_ATTR, color: MARK_COLOR },
    );
  } catch {
    return 0;
  }
}

/**
 * 清除标记。失败静默 —— 残留标记会污染下一轮观察，但绝不能让动作链断掉。
 * 主文档始终清理（兜底上一轮的残留），另外逐个清理本轮标记所属的文档。
 */
export async function clearSomMarks(page: Page, marks: SomMark[] = []): Promise<void> {
  if (page.isClosed()) return;
  const scopes = await somScopes(page, marks);
  for (const scope of scopes) {
    await clearFromScope(scope);
  }
}

async function clearFromScope(scope: DomScope): Promise<void> {
  try {
    await scope.evaluate((hostAttr: string) => {
      try {
        document.querySelectorAll(`[${hostAttr}]`).forEach((node) => node.remove());
      } catch {
        /* ignore */
      }
      return true;
    }, HOST_ATTR);
  } catch {
    /* ignore */
  }
}

/**
 * 「注入 → 执行截图 → 无论成败都清除」的包围盒。
 * 无标记时直接执行，零额外开销。
 */
export async function withSomMarks<T>(
  page: Page,
  marks: SomMark[],
  capture: () => Promise<T>,
): Promise<{ result: T; marked: number }> {
  if (!marks.length) {
    return { result: await capture(), marked: 0 };
  }
  const marked = await injectSomMarks(page, marks);
  try {
    return { result: await capture(), marked };
  } finally {
    await clearSomMarks(page, marks);
  }
}

/** 汇总诊断信息：让模型知道「编号是否可能不全」 */
export function makeSomMarkStats(candidates: number, marked: number): SomMarkStats {
  const reason =
    marked === 0
      ? candidates === 0
        ? "无可标注元素"
        : "标记注入失败"
      : marked < candidates
        ? `仅标注了 ${marked}/${candidates} 个（超出上限）`
        : null;
  return { marked, candidates, reason };
}
