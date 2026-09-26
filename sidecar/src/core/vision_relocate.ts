/**
 * 视觉重定位（P2 视觉自愈的「找回目标」一环）
 *
 * 解决的问题：**DOM 变了，index 失效了，任务就断在原地**。
 * 现有链路里 index 过期只有一条出路 —— 「重新观察，让模型自己再挑一次」。
 * 可真实网页里失效的常常是「列表/表单重渲染」「内容懒加载后整体重排」，
 * 重观察后模型面对一份全新的编号，很容易挑错（尤其当目标是同名的链接 / 文案 / 图标时）。
 *
 * 本模块把「找回目标」做成一条**不依赖模型记忆**的确定性链路：
 *   ① 就地把页面**重新抽取 + 重新编号**（编号规则复用 core/index_space，与模型索引空间同源）；
 *   ② 把这些编号**画进截图**（复用 SoM：图上的数字 === 列表里的 index）；
 *   ③ 问视觉模型一个**闭集问题**：「失效的那条目标，对应清单里哪个编号？」
 *      —— 答案必须落在候选集合内，编造编号一律作废；
 *   ④ 命中 → 返回**新 index**，调用方用正常 `click/input` 链路执行
 *      （新鲜度守卫、遮挡仲裁、命中点测试、状态回读全部照旧，没有任何旁路）。
 *
 * 退一步的兜底：候选里确实没有该目标（画布控件、图上文字、清单截断）时，
 * 允许降级成「自由坐标定位 + 点击」——这条路径本身带点击守卫，且只在闭集失败后才走。
 *
 * 设计约束：
 *   - 全程 fail-safe：任何一步失败都返回 applied="none"，绝不抛出打断动作链；
 *   - 不自己点击（除兜底路径）：命中编号只**给出 index**，把执行权交回动作层，避免绕过验证；
 *   - 视觉未配置时静默跳过（返回 none），不产生任何副作用与额外请求。
 */
import type { Page } from "playwright-core";

import type { SidecarAiSettings } from "../engine.js";
import type { JsonLogger } from "../json-logger.js";
import { extractAgentInteractiveTree } from "../interactive_elements.js";
import { indexElements, type IndexedElementBrief, type IndexSource } from "./index_space.js";
import { buildSomMarks, withSomMarks, type SomMark } from "./som_marker.js";
import { captureScreenshot } from "./safe_screenshot.js";
import {
  askVisionPickIndex,
  buildVisionPickQuestion,
  visionLocateAndClick,
  type VisionPickResult,
} from "../page_vision_locate.js";

export const VISION_RELOCATE_CONFIG = {
  /** 单次重定位最多给视觉模型看的候选数（与 SoM 上限共用一套编号） */
  maxCandidates: 60,
  /** 标注截图的 JPEG 质量 */
  screenshotQuality: 62,
} as const;

export interface RelocateScope {
  source: IndexSource;
  candidates: IndexedElementBrief[];
  marks: SomMark[];
  url: string | null;
}

export type RelocateObserver = (page: Page, max: number) => Promise<RelocateScope | null>;

export type RelocatePicker = (input: {
  screenshotBase64: string;
  question: string;
  candidates: IndexedElementBrief[];
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
}) => Promise<VisionPickResult | null>;

export type RelocatePointLocator = (input: {
  page: Page;
  targetText: string;
  goal: string;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
}) => Promise<{ ok: boolean; detail: string }>;

export type RelocateApplied = "index" | "point" | "none";

export interface VisionRelocateResult {
  ok: boolean;
  /** index = 用返回的新 index 继续执行；point = 已按视觉坐标点击；none = 没找回 */
  applied: RelocateApplied;
  /** 新索引空间里**可直接执行**的编号 */
  index: number | null;
  description: string;
  confidence: number;
  /** 候选总数 / 图上真正标注的数量（数量不等时模型看到的编号可能不全） */
  candidates: number;
  marked: number;
  /** 刷新后的索引空间：applied="index" 时调用方必须据此替换 selectorMap，否则新 index 解析不到 */
  source: IndexSource | null;
  url: string | null;
  /** 一句话结论（回执给模型/日志复用） */
  detail: string;
}

/** 默认观察者：就地重新抽取 + 重新编号 + 生成标注 */
async function defaultObserve(page: Page, max: number): Promise<RelocateScope | null> {
  try {
    const raw = await extractAgentInteractiveTree(page, { includeScreenshot: false });
    const entries = indexElements(raw);
    if (entries.size === 0) return null;

    const llm_json: IndexSource["llm_json"] = [];
    const element_map: IndexSource["element_map"] = new Map();
    const labelByIndex = new Map<number, string>();
    for (const entry of entries.values()) {
      const id = String(entry.index);
      llm_json.push({ ...entry.llm, id });
      element_map.set(id, { ...entry.ref, id });
      const label = String(entry.llm.text ?? entry.ref.text ?? "").trim();
      labelByIndex.set(entry.index, label || `[${entry.llm.type || "element"}]`);
    }
    const source: IndexSource = { llm_json, element_map };
    const marks = buildSomMarks(source, {
      max,
      viewport: page.viewportSize() ?? null,
    });
    // 候选严格来自「真正画进图里的编号」：图上有框的才允许被回答，杜绝图外编号
    const candidates: IndexedElementBrief[] = marks.map((m) => ({
      index: m.index,
      label: labelByIndex.get(m.index) ?? m.label ?? "",
    }));
    return { source, candidates, marks, url: raw.url || page.url() };
  } catch {
    return null;
  }
}

const defaultPicker: RelocatePicker = async (input) =>
  askVisionPickIndex({
    screenshotBase64: input.screenshotBase64,
    question: input.question,
    candidates: input.candidates,
    aiSettings: input.aiSettings,
    logger: input.logger,
  });

const defaultPointLocate: RelocatePointLocator = async (input) => {
  const res = await visionLocateAndClick({
    page: input.page,
    goal: input.goal,
    question:
      `请定位「${input.targetText.slice(0, 60)}」的中心位置并点击它。` +
      "只找同一个目标（同样的类型与含义），不要点同名的链接、条款或说明文案。",
    aiSettings: input.aiSettings,
    logger: input.logger,
    autoClick: true,
  });
  return { ok: res.ok, detail: res.detail };
};

export interface VisionRelocateInput {
  page: Page;
  /** 失效目标的文案（越具体越准，例如「同意隐私声明」） */
  targetText: string;
  /** 失效目标的控件类型（checkbox / radio / link / button / input…），用于强制同类匹配 */
  targetKind?: string | null;
  /** 原编号（仅用于提问与日志） */
  previousIndex?: number | null;
  goal: string;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  signal?: AbortSignal;
  /** 测试注入点：观察者 / 闭集挑选器 / 坐标兜底 */
  observe?: RelocateObserver;
  pick?: RelocatePicker;
  pointLocate?: RelocatePointLocator;
  /** 闭集失败后是否允许降级为坐标点击（默认允许） */
  allowPointFallback?: boolean;
  maxCandidates?: number;
}

/**
 * 找回失效目标。永不抛错；失败时 applied="none" 且 detail 说明原因（供回执）。
 */
export async function visionRelocateTarget(
  input: VisionRelocateInput,
): Promise<VisionRelocateResult> {
  const empty = (detail: string): VisionRelocateResult => ({
    ok: false,
    applied: "none",
    index: null,
    description: "",
    confidence: 0,
    candidates: 0,
    marked: 0,
    source: null,
    url: null,
    detail,
  });

  if (!input.aiSettings?.apiKey?.trim()) {
    return empty("未配置视觉模型，无法视觉重定位");
  }
  if (input.signal?.aborted) return empty("任务已中止");

  const max = Math.max(1, Math.floor(input.maxCandidates ?? VISION_RELOCATE_CONFIG.maxCandidates));
  const observe = input.observe ?? defaultObserve;
  const pick = input.pick ?? defaultPicker;
  const pointLocate = input.pointLocate ?? defaultPointLocate;

  let scope: RelocateScope | null = null;
  try {
    scope = await observe(input.page, max);
  } catch {
    scope = null;
  }
  if (!scope || scope.candidates.length === 0) {
    // 没有可编号的候选（画布/纯图片/抽取失败）→ 只能靠坐标兜底
    if (input.allowPointFallback === false) {
      return empty("页面没有可编号的交互元素，视觉重定位无候选");
    }
    return await runPointFallback(empty, input, pointLocate, "页面没有可编号的交互元素");
  }

  const question = buildVisionPickQuestion({
    targetText: input.targetText,
    targetKind: input.targetKind ?? null,
    candidates: scope.candidates,
    goal: input.goal,
    previousIndex: input.previousIndex ?? null,
  });

  let shot: string | null = null;
  try {
    const captured = await withSomMarks(input.page, scope.marks, async () =>
      captureScreenshot(input.page, {
        type: "jpeg",
        quality: VISION_RELOCATE_CONFIG.screenshotQuality,
        fullPage: false,
      }),
    );
    shot = Buffer.from(captured.result).toString("base64");
    if (captured.marked !== scope.marks.length) {
      input.logger?.progress?.("vision_relocate_partial_marks", {
        wanted: scope.marks.length,
        marked: captured.marked,
      });
    }
  } catch (err) {
    shot = null;
    input.logger?.warn?.("vision_relocate_shot_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const base = {
    candidates: scope.candidates.length,
    marked: scope.marks.length,
    source: scope.source,
    url: scope.url,
  };

  if (shot) {
    let picked: VisionPickResult | null = null;
    try {
      picked = await pick({
        screenshotBase64: shot,
        question,
        candidates: scope.candidates,
        aiSettings: input.aiSettings,
        logger: input.logger,
      });
    } catch (err) {
      picked = null;
      input.logger?.warn?.("vision_relocate_pick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (picked?.found && picked.index != null) {
      const label =
        scope.candidates.find((c) => c.index === picked!.index)?.label ?? input.targetText;
      input.logger?.agentProgress?.(
        `视觉重定位命中：[${picked.index}] ${label}（${picked.description}）`,
        { phase: "vision_relocate", index: picked.index, confidence: picked.confidence },
      );
      return {
        ok: true,
        applied: "index",
        index: picked.index,
        description: picked.description,
        confidence: picked.confidence,
        ...base,
        detail:
          `视觉重定位命中新编号 [${picked.index}] ${label.slice(0, 40)}` +
          `（${picked.description.slice(0, 60)}，置信 ${picked.confidence.toFixed(2)}）`,
      };
    }
  }

  if (input.allowPointFallback === false) {
    return {
      ...empty("视觉未能在候选里找到该目标"),
      ...base,
      detail: shot
        ? "视觉未能在候选里找到该目标（候选清单里没有它）"
        : "重定位截图失败，无法视觉找回",
    };
  }
  return await runPointFallback(
    (d) => ({ ...empty(d), ...base }),
    input,
    pointLocate,
    shot ? "视觉未能在候选里找到该目标" : "重定位截图失败",
  );
}

/** 坐标兜底：闭集失败后的最后一条路（画布/图上文字等没有 DOM 编号的目标） */
async function runPointFallback(
  empty: (detail: string) => VisionRelocateResult,
  input: VisionRelocateInput,
  pointLocate: RelocatePointLocator,
  reason: string,
): Promise<VisionRelocateResult> {
  if (input.signal?.aborted) return empty(`${reason}；任务已中止`);
  input.logger?.agentProgress?.(`视觉重定位改走坐标兜底：${reason}`, {
    phase: "vision_relocate",
    fallback: "point",
  });
  try {
    const res = await pointLocate({
      page: input.page,
      targetText: input.targetText,
      goal: input.goal,
      aiSettings: input.aiSettings,
      logger: input.logger,
    });
    if (res.ok) {
      return {
        ...empty(`${reason}；已按视觉坐标定位并点击`),
        ok: true,
        applied: "point",
        detail: `${reason}；已按视觉坐标定位并点击（${res.detail.slice(0, 120)}）`,
      };
    }
    return empty(`${reason}；坐标兜底也未成功：${res.detail.slice(0, 120)}`);
  } catch (err) {
    return empty(
      `${reason}；坐标兜底异常：${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    );
  }
}
