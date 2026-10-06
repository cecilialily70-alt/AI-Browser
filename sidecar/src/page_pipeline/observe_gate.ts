/**
 * Observe Gate：AI 调用前唯一观察门禁。
 * - await 稳定 → 提取蒸馏 → 可选多帧截图（Buffer）
 * - Delta Skip：结构未变且遮罩未变则复用上轮截图 Buffer
 * - 失败软着陆：占位包交给 LLM，不抛死 Agent
 * - dispose：shots=null，切断 Buffer
 */
import type { Page } from "playwright-core";

import type { AgentElementRef, AgentLlmElement } from "../interactive_elements.js";
import type { DenoiseStats } from "../page_distill.js";
import type { AgentSenseMode } from "../llm_budget.js";
import {
  buildSomMarks,
  makeSomMarkStats,
  withSomMarks,
  type SomMarkStats,
} from "../core/som_marker.js";
import { PAGE_PIPELINE_CONFIG } from "./config.js";
import { captureScreenshot } from "../core/safe_screenshot.js";
import { extractAndDistill, structureSimilarity, type A11yStructure } from "./extractor.js";
import { waitForPageQuiet } from "./listener.js";
import {
  detectOverlayHint,
  formatOverlayNudge,
  type OverlayHint,
} from "./overlay_policy.js";
import {
  capturePanoramaFrames,
  disposeFrames,
  framesToBase64DataUrls,
  type PanoramaFrame,
} from "./panorama.js";

export interface ObservationPack {
  ok: boolean;
  softError: boolean;
  url: string;
  title: string;
  extractedAt: string;
  llm_json: AgentLlmElement[];
  element_map: Map<string, AgentElementRef>;
  structureHash: string;
  truncated: number;
  a11ySummary: string | null;
  /**
   * Phase 4.1a：无障碍树的结构化视图（只读）。
   * 不进模型提示词、不参与决策 —— 供上层做页面分类与控件核对。
   */
  a11yStructure: A11yStructure | null;
  /** 元素去噪账本（噪声丢弃/降权统计），用于观测质量诊断 */
  denoise: DenoiseStats | null;
  /**
   * 降级观察正文：DOM 索引抽不出来时的兜底（仅正文，无控件索引）。
   * 非空即表示本轮是「降级观察」——模型不得用 index 动作，只能读正文/看图/导航。
   */
  degradedText: string | null;
  overlay: OverlayHint;
  readyNote: string;
  /** 内存 JPEG；dispose 后为 null */
  shots: PanoramaFrame[] | null;
  panoramaEnabled: boolean;
  reusedShots: boolean;
  /** SoM 编号标记账本：编号与文本 index 同源，marked=0 表示截图无标记 */
  somMarks: SomMarkStats | null;
  suggestedAction: string | null;
  error: string | null;
  disposed: boolean;
}

export interface PrepareObservationOptions {
  goal?: string;
  profileId?: string;
  panoramaEnabled: boolean;
  /**
   * Agent 显式 screenshot / 视觉救赎：即使未开全景，也必须拍至少 1 帧视口图。
   * 拍不到则 readyNote 带失败原因，由上层对用户报权限/能力错误。
   */
  forceViewportShot?: boolean;
  senseMode?: AgentSenseMode;
  signal?: AbortSignal;
  /** 上一步 pack（用于 Delta Skip；勿在 dispose 后传入） */
  previous?: ObservationPack | null;
  /**
   * 观察自愈回调（由 prepareObservationResilient 调用）：
   * 抽取不可用而准备重抽时触发，便于日志解释「为什么慢」。
   */
  onHealAttempt?: (attempt: number, reason: string, waitMs: number) => void;
}

/** 模块级轻量缓存：仅保留上轮 shots Buffer 供 Delta Skip（按 profile） */
const lastShotCache = new Map<
  string,
  { structureHash: string; overlayFp: string | null; frames: PanoramaFrame[] }
>();

export async function prepareObservation(
  page: Page,
  opts: PrepareObservationOptions,
): Promise<ObservationPack> {
  const profileId = opts.profileId || "default";
  const panoramaEnabled = opts.panoramaEnabled === true;
  const forceViewportShot = opts.forceViewportShot === true;

  try {
    const quiet = await waitForPageQuiet(page, {
      goalHint: opts.goal,
      signal: opts.signal,
      mode: "agent",
    });

    const extracted = await extractAndDistill(page, {
      goal: opts.goal,
      senseMode: opts.senseMode,
      includeScreenshot: false,
      signal: opts.signal,
    });

    const overlay = await detectOverlayHint(page, profileId);

    if (extracted.error && extracted.extract.llm_json.length === 0) {
      return softErrorPack(page, {
        error: extracted.error,
        readyNote: quiet.note,
        panoramaEnabled,
        overlay,
      });
    }

    let shots: PanoramaFrame[] | null = null;
    let reusedShots = false;
    let shotNote = "截图关闭";
    let shotError: string | null = null;
    let somMarks: SomMarkStats | null = null;

    // SoM：编号与 (去噪后) 文本 index 同源，让模型能「看图核 index」而不是脑补位置。
    // 必须在蒸馏之后构建 —— 用抽取期的原始列表会出现「图上有编号、列表里没有该项」。
    const somEnabled =
      PAGE_PIPELINE_CONFIG.somMarks && (panoramaEnabled || forceViewportShot);
    const somMarksToDraw = somEnabled
      ? buildSomMarks(
          { llm_json: extracted.extract.llm_json, element_map: extracted.extract.element_map },
          { max: PAGE_PIPELINE_CONFIG.somMaxMarks, viewport: extracted.viewport },
        )
      : [];
    const somCandidates = somEnabled ? extracted.extract.llm_json.length : 0;

    if (panoramaEnabled) {
      const cache = lastShotCache.get(profileId);
      const sim = cache
        ? structureSimilarity(cache.structureHash, extracted.structureHash)
        : 0;
      const overlaySame =
        (cache?.overlayFp ?? null) === (overlay.fingerprint ?? null);
      const canReuse =
        cache &&
        cache.frames.length > 0 &&
        sim >= PAGE_PIPELINE_CONFIG.structureSimilarityReuse &&
        overlaySame;

      if (canReuse && cache) {
        shots = cache.frames.map((f) => ({
          buffer: Buffer.from(f.buffer),
          index: f.index,
          scrollY: f.scrollY,
        }));
        reusedShots = true;
        shotNote = `Delta Skip 复用 ${shots.length} 帧`;
        somMarks = makeSomMarkStats(somCandidates, 0);
      } else {
        // 注入 → 多帧截图 → 清除：标记层是文档坐标，滚动时跟着内容走，一次注入服务全部帧
        const captured = await withSomMarks(page, somMarksToDraw, async () => {
          return capturePanoramaFrames(page, { signal: opts.signal });
        });
        const pan = captured.result;
        shots = pan.frames;
        shotNote = pan.skipped ? `截图跳过:${pan.reason}` : `新截图 ${pan.frames.length} 帧`;
        somMarks = makeSomMarkStats(somCandidates, shots.length ? captured.marked : 0);
        if (pan.frames.length > 0) {
          lastShotCache.set(profileId, {
            structureHash: extracted.structureHash,
            overlayFp: overlay.fingerprint,
            frames: pan.frames.map((f) => ({
              buffer: Buffer.from(f.buffer),
              index: f.index,
              scrollY: f.scrollY,
            })),
          });
        } else if (pan.skipped) {
          shotError = `全景截图失败：${pan.reason}`;
        }
      }
    } else if (forceViewportShot) {
      // 通用：Agent 要看图（点图标/语言球等）时，不依赖「全景」开关
      try {
        if (opts.signal?.aborted) {
          throw new Error("截图已中止");
        }
        const captured = await withSomMarks(page, somMarksToDraw, async () => {
          return captureScreenshot(page, {
            type: "jpeg",
            quality: 62,
            fullPage: false,
          });
        });
        shots = [
          {
            buffer: Buffer.from(captured.result),
            index: 0,
            scrollY: 0,
          },
        ];
        shotNote = "视口截图 1 帧（按需）";
        somMarks = makeSomMarkStats(somCandidates, captured.marked);
      } catch (err) {
        shotError =
          err instanceof Error ? err.message : String(err ?? "screenshot_failed");
        shotNote = `截图失败:${shotError}`;
        shots = null;
        somMarks = makeSomMarkStats(somCandidates, 0);
      }
    }

    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "";
    }

    return {
      ok: true,
      softError: false,
      url: extracted.extract.url || page.url(),
      title,
      extractedAt: extracted.extract.extractedAt,
      llm_json: extracted.extract.llm_json,
      element_map: extracted.extract.element_map,
      structureHash: extracted.structureHash,
      truncated: extracted.extract.truncated,
      a11ySummary: extracted.a11ySummary,
      a11yStructure: extracted.a11yStructure,
      denoise: extracted.extract.denoise,
      degradedText: null,
      overlay,
      readyNote: `${quiet.note} · ${shotNote}`,
      shots,
      panoramaEnabled,
      reusedShots,
      somMarks,
      suggestedAction: null,
      error: shotError
        ? `${extracted.error ? `${extracted.error}; ` : ""}${shotError}`
        : extracted.error,
      disposed: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return softErrorPack(page, {
      error: message,
      readyNote: "观察失败（软着陆）",
      panoramaEnabled,
      overlay: {
        present: false,
        fingerprint: null,
        label: null,
        recurrenceCount: 0,
        stopChasing: false,
        note: "",
      },
    });
  }
}

function softErrorPack(
  page: Page,
  input: {
    error: string;
    readyNote: string;
    panoramaEnabled: boolean;
    overlay: OverlayHint;
  },
): ObservationPack {
  let url = "";
  try {
    url = page.url();
  } catch {
    url = "";
  }
  return {
    ok: false,
    softError: true,
    url,
    title: "",
    extractedAt: new Date().toISOString(),
    llm_json: [],
    element_map: new Map(),
    structureHash: "soft_error",
    truncated: 0,
    a11ySummary: null,
    a11yStructure: null,
    denoise: null,
    degradedText: null,
    overlay: input.overlay,
    readyNote: input.readyNote,
    shots: null,
    panoramaEnabled: input.panoramaEnabled,
    reusedShots: false,
    somMarks: null,
    suggestedAction: "reload or go_back",
    error: input.error,
    disposed: false,
  };
}

/**
 * AI 前检查：软错误也算「可调用」（占位包），已 dispose 则不可。
 */
export function assertObservationReady(pack: ObservationPack): void {
  if (pack.disposed) {
    throw new Error("ObservationPack 已销毁，禁止调用 AI");
  }
}

/** 组装给多模态的 data-url 列表；仅在发请求前调用 */
export function materializeShotDataUrls(pack: ObservationPack): string[] {
  if (!pack.shots?.length) {
    return [];
  }
  return framesToBase64DataUrls(pack.shots);
}

export function buildObservationNudges(pack: ObservationPack): string[] {
  const nudges: string[] = [];
  if (pack.softError) {
    nudges.push(
      `系统：页面观察失败或超时（${pack.error ?? "unknown"}）。` +
        `建议动作：${pack.suggestedAction ?? "reload or go_back"}。` +
        `请调用 wait / go_back / navigate 刷新，或 handover_to_human；禁止假装已看到页面内容。`,
    );
  } else if (pack.degradedText != null) {
    nudges.push(
      `系统：本轮为**降级观察**（控件索引不可用：${pack.error ?? "unknown"}）。` +
        `已提供正文与（可能的）视口截图；**禁止使用 index 动作**（click/input/select_dropdown 都需要 index）。` +
        `可用手段：依据正文作答、scroll 后重看、request_vision/vision 视觉定位、navigate 直达目标 URL，或 handover_to_human。` +
        `下一轮会重新尝试完整观察。`,
    );
  }
  const overlayNudge = formatOverlayNudge(pack.overlay);
  if (overlayNudge) {
    nudges.push(overlayNudge);
  }
  const denoise = pack.denoise;
  if (!pack.softError && denoise && (denoise.dropped >= 3 || denoise.demoted >= 3)) {
    nudges.push(
      `系统：本轮已对候选控件去噪（丢弃 ${denoise.dropped} 个装饰/离屏元素、降权 ${denoise.demoted} 个重复项）。` +
        `列表是被整理过的：目标不在其中时先 scroll / read 再判断，禁止凭猜测点坐标。`,
    );
  }
  if (pack.a11ySummary?.trim()) {
    nudges.push(
      `系统：已附无障碍树摘要作语义兜底（Shadow/Canvas 弱 DOM 时优先对照视觉）。`,
    );
  }
  return nudges;
}

export function serializePackForDebug(pack: ObservationPack): Record<string, unknown> {
  return {
    ok: pack.ok,
    softError: pack.softError,
    url: pack.url,
    extractedAt: pack.extractedAt,
    structureHash: pack.structureHash,
    truncated: pack.truncated,
    elementCount: pack.llm_json.length,
    llm_json: pack.llm_json,
    overlay: pack.overlay,
    readyNote: pack.readyNote,
    panoramaEnabled: pack.panoramaEnabled,
    shotFrames: pack.shots?.length ?? 0,
    reusedShots: pack.reusedShots,
    somMarks: pack.somMarks,
    a11ySummary: pack.a11ySummary
      ? pack.a11ySummary.slice(0, 500)
      : null,
    a11yRoles: pack.a11yStructure
      ? {
          interactiveCount: pack.a11yStructure.interactiveCount,
          indexSpace: pack.a11yStructure.indexSpace,
          topRoles: Object.entries(pack.a11yStructure.roleCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12),
        }
      : null,
    degradedTextChars: pack.degradedText?.length ?? 0,
    denoise: pack.denoise,
    error: pack.error,
    // 不含截图二进制
  };
}

export function disposeObservation(pack: ObservationPack | null | undefined): void {
  if (!pack || pack.disposed) {
    return;
  }
  disposeFrames(pack.shots);
  pack.shots = null;
  pack.llm_json = [];
  pack.element_map = new Map();
  pack.a11ySummary = null;
  pack.degradedText = null;
  pack.disposed = true;
}

export function clearShotCache(profileId?: string): void {
  if (profileId) {
    const row = lastShotCache.get(profileId);
    if (row) {
      disposeFrames(row.frames);
      lastShotCache.delete(profileId);
    }
    return;
  }
  for (const [, row] of lastShotCache) {
    disposeFrames(row.frames);
  }
  lastShotCache.clear();
}
