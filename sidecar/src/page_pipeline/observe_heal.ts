/**
 * 观察自愈（Observation Healing）
 *
 * 背景：观察失败时旧实现只做「软着陆」——把空占位包交给模型，并提示它「reload or go_back」。
 * 于是「页面还在加载 / 首屏尚未渲染 / evaluate 卡超时」这类**运行时问题被转嫁给模型**：
 * 模型拿着空控件树盲点、盲填，或者干脆自称完成（配合 done 闸门之前就是「显示级 Agent」）。
 *
 * 这里把重试与降级收回到运行时：
 *   1. 抽取不可用（软错误 / 无控件也无图）时，按配置的静默阶梯自动重试（等 DOM 就绪 → 再抽）；
 *   2. 重试仍不可用 → **降级观察**：不再给控件索引，只给 URL/标题/正文（或补救截图），并显式标注 degraded；
 *   3. 全过程受总预算约束，绝不因为页面卡死而挂住 Agent。
 *
 * 原则：宁可明确「降级」，也绝不伪造控件索引 —— 模型必须知道自己看到的是什么质量的状态。
 */
import type { Page } from "playwright-core";

import type { ObservationPack, PrepareObservationOptions } from "./observe_gate.js";
import { disposeObservation, prepareObservation } from "./observe_gate.js";
import { PAGE_PIPELINE_CONFIG } from "./config.js";
import { extractPageReading, formatPageReadingForLlm } from "../page_read.js";
import type { PanoramaFrame } from "./panorama.js";
import { captureScreenshot } from "../core/safe_screenshot.js";

export type ObservationMode = "full" | "degraded-text" | "failed";

export interface ObservationQuality {
  /** 是否拿到了可用的控件索引 */
  ok: boolean;
  /** 是否是降级观察（无控件索引，但有正文/截图可依据） */
  degraded: boolean;
  /** 实际抽取尝试次数 */
  attempts: number;
  /** 控件数量 */
  elementCount: number;
  mode: ObservationMode;
  /** 为什么降级/失败（人类可读，串联每次尝试的原因） */
  reason: string | null;
}

export interface ResilientObservation {
  pack: ObservationPack;
  quality: ObservationQuality;
}

/**
 * 可用 = 没有软错误，且「有控件索引」或「有截图可看」。
 * 后者很重要：Canvas/影子 DOM 页可能 0 控件，但模型明确要看图时，视觉就是可用观察。
 */
function isUsable(pack: ObservationPack): boolean {
  return !pack.softError && (pack.llm_json.length > 0 || (pack.shots?.length ?? 0) > 0);
}

function describeUnusable(pack: ObservationPack): string {
  if (pack.softError) return String(pack.error ?? "观察失败");
  const note = String(pack.readyNote ?? "").trim();
  return note ? `未提取到任何可见控件（${note}）` : "未提取到任何可见控件";
}

/** 保留信息量更大的包：优先非软错误 → 控件更多 → 截图更多 */
function betterPack(a: ObservationPack | null, b: ObservationPack): ObservationPack {
  if (!a) return b;
  if (a.softError !== b.softError) return a.softError ? b : a;
  if (a.llm_json.length !== b.llm_json.length) {
    return a.llm_json.length > b.llm_json.length ? a : b;
  }
  return (a.shots?.length ?? 0) >= (b.shots?.length ?? 0) ? a : b;
}

/** 重抽前的等待：先给页面一次完成加载的机会，再静默退避 */
async function healWait(page: Page, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await page
    .waitForLoadState("domcontentloaded", { timeout: Math.min(3_000, Math.max(500, ms)) })
    .catch(() => undefined);
  if (signal?.aborted) return;
  if (ms > 0) await page.waitForTimeout(ms).catch(() => undefined);
}

/** 降级正文：确定性阅读（零二次 LLM），带独立超时 */
async function readDegradedText(page: Page, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  try {
    const reading = await Promise.race([
      extractPageReading(page),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), PAGE_PIPELINE_CONFIG.degradedTextTimeoutMs),
      ),
    ]);
    if (!reading) return null;
    const text = formatPageReadingForLlm(reading).trim();
    return text ? text.slice(0, PAGE_PIPELINE_CONFIG.degradedTextChars) : null;
  } catch {
    return null;
  }
}

/** 补救截图：模型明确要看图却抽不出控件时，至少把视口画面给它 */
async function rescueViewportShot(page: Page, signal?: AbortSignal): Promise<PanoramaFrame[] | null> {
  if (signal?.aborted) return null;
  try {
    const buffer = await captureScreenshot(page, {
      type: "jpeg",
      quality: 62,
      fullPage: false,
      timeout: 5_000,
    });
    return [{ buffer: Buffer.from(buffer), index: 0, scrollY: 0 }];
  } catch {
    return null;
  }
}

/** 降级包：复用失败包的现场信息（遮罩指纹、截图），但明确「无控件索引」 */
function degradePack(
  page: Page,
  source: ObservationPack | null,
  reason: string,
  text: string | null,
  shots: PanoramaFrame[] | null,
): ObservationPack {
  let url = "";
  try {
    url = page.url();
  } catch {
    url = "";
  }
  const hasSubstance = Boolean(text) || (shots?.length ?? 0) > 0;
  return {
    // 还有正文/截图可依据时不算「软错误」：走 degraded 通道而不是 observation_error
    ok: false,
    softError: !hasSubstance,
    url: source?.url || url,
    title: source?.title ?? "",
    extractedAt: new Date().toISOString(),
    llm_json: [],
    element_map: new Map(),
    structureHash: "degraded",
    truncated: 0,
    a11ySummary: null,
    a11yStructure: null,
    denoise: null,
    degradedText: text,
    overlay:
      source?.overlay ?? {
        present: false,
        fingerprint: null,
        label: null,
        recurrenceCount: 0,
        stopChasing: false,
        note: "",
      },
    readyNote: `降级观察：${reason}`,
    shots,
    panoramaEnabled: false,
    reusedShots: false,
    // 降级观察没有控件索引，也就没有可标注的编号（绝不画「无主编号」）
    somMarks: null,
    suggestedAction: "reload or go_back",
    error: reason,
    disposed: false,
  };
}

/**
 * 带自愈的观察：抽取 → 不可用则阶梯重试 → 仍不可用则降级（正文 / 补救截图）。
 * 返回的 pack 语义与 `prepareObservation` 一致，可直接走既有下游。
 */
export async function prepareObservationResilient(
  page: Page,
  opts: PrepareObservationOptions,
): Promise<ResilientObservation> {
  const maxAttempts = Math.max(1, PAGE_PIPELINE_CONFIG.observeMaxAttempts);
  const budgetMs = PAGE_PIPELINE_CONFIG.observeHealBudgetMs;
  const startedAt = Date.now();
  const onHealAttempt = opts.onHealAttempt;

  let best: ObservationPack | null = null;
  let attempts = 0;
  let reason: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (opts.signal?.aborted) break;
    const pack = await prepareObservation(page, opts);
    attempts += 1;
    if (isUsable(pack)) {
      if (best && best !== pack) disposeObservation(best);
      return {
        pack,
        quality: {
          ok: true,
          degraded: false,
          attempts,
          elementCount: pack.llm_json.length,
          mode: "full",
          reason: null,
        },
      };
    }

    const failure = describeUnusable(pack);
    reason = reason ? `${reason} → ${failure}` : failure;
    const winner = betterPack(best, pack);
    if (winner === pack && best) {
      disposeObservation(best);
    } else if (winner === best) {
      disposeObservation(pack);
    }
    best = winner;

    if (attempt < maxAttempts - 1) {
      const remaining = budgetMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      const backoff = PAGE_PIPELINE_CONFIG.observeRetryBackoffMs[attempt] ?? 1_000;
      const waitMs = Math.min(backoff, remaining);
      onHealAttempt?.(attempts, reason ?? "", waitMs);
      await healWait(page, waitMs, opts.signal);
    }
  }

  const text = await readDegradedText(page, opts.signal);
  let shots = best?.shots ?? null;
  if (!text && !shots && opts.forceViewportShot) {
    shots = await rescueViewportShot(page, opts.signal);
  }
  // best 的 frames 所有权转移给降级包：不能再 dispose 它
  const pack = degradePack(page, best, reason ?? "观察失败", text, shots);
  if (best && shots === null) disposeObservation(best);
  const mode: ObservationMode = text || shots ? "degraded-text" : "failed";
  return {
    pack,
    quality: {
      ok: false,
      degraded: mode === "degraded-text",
      attempts,
      elementCount: 0,
      mode,
      reason: pack.error,
    },
  };
}
