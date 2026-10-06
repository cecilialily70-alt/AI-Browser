/**
 * Listener：页面稳定等待。
 * - document / soft networkidle / SERP（复用 page_ready）
 * - MutationObserver：仅视口内、有面积的 childList 突变重置静默窗
 * - 硬 deadline，避免动画永不静默
 */
import type { Page } from "playwright-core";

import { waitUntilPageReadyForObserve } from "../page_ready.js";
import { PAGE_PIPELINE_CONFIG } from "./config.js";

export interface QuietWaitResult {
  quietReached: boolean;
  deadlineHit: boolean;
  meaningfulMutations: number;
  note: string;
  url: string;
  documentReady: boolean;
  serpReady: boolean | null;
}

/**
 * 等待文档就绪 + DOM 静默（视口过滤）。
 */
export async function waitForPageQuiet(
  page: Page,
  opts?: {
    expectSerp?: boolean;
    goalHint?: string;
    signal?: AbortSignal;
    /** Agent 主路径用更短静默，避免百度热搜动画拖死 */
    mode?: "default" | "agent";
  },
): Promise<QuietWaitResult> {
  if (opts?.signal?.aborted) {
    throw new Error("观察已中止");
  }

  const quietMs =
    opts?.mode === "agent"
      ? PAGE_PIPELINE_CONFIG.agentQuietMs
      : PAGE_PIPELINE_CONFIG.quietMs;
  const deadlineMs =
    opts?.mode === "agent"
      ? PAGE_PIPELINE_CONFIG.agentDeadlineMs
      : PAGE_PIPELINE_CONFIG.deadlineMs;

  // Agent 路径：文档就绪即可，不做长 networkidle / 长 SERP 轮询（避免「永远思考中」）
  if (opts?.mode === "agent") {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 8_000 });
    } catch {
      /* soft */
    }
    await page.waitForTimeout(200).catch(() => undefined);
  } else {
    await waitUntilPageReadyForObserve(page, {
      expectSerp: opts?.expectSerp,
      goalHint: opts?.goalHint,
    });
  }

  const quiet = await waitViewportQuietGap(page, {
    quietMs,
    deadlineMs,
    minArea: PAGE_PIPELINE_CONFIG.minMutationArea,
    signal: opts?.signal,
  });

  const noteParts: string[] = [];
  if (opts?.mode === "agent") {
    noteParts.push("Agent 快速就绪");
  }
  if (quiet.quietReached) {
    noteParts.push(`DOM 静默 ${quietMs}ms`);
  } else if (quiet.deadlineHit) {
    noteParts.push(`DOM 未完全静默（已达 ${deadlineMs}ms 上限）`);
  }
  if (quiet.meaningfulMutations > 0) {
    noteParts.push(`视口内突变 ${quiet.meaningfulMutations} 次`);
  }

  return {
    quietReached: quiet.quietReached,
    deadlineHit: quiet.deadlineHit,
    meaningfulMutations: quiet.meaningfulMutations,
    note: noteParts.join(" · ") || "ready",
    url: page.url(),
    documentReady: true,
    serpReady: null,
  };
}

async function waitViewportQuietGap(
  page: Page,
  opts: {
    quietMs: number;
    deadlineMs: number;
    minArea: number;
    signal?: AbortSignal;
  },
): Promise<{ quietReached: boolean; deadlineHit: boolean; meaningfulMutations: number }> {
  try {
    if (page.isClosed()) {
      return { quietReached: false, deadlineHit: true, meaningfulMutations: 0 };
    }

    const result = await page.evaluate(
      ({ quietMs, deadlineMs, minArea }) =>
        new Promise<{
          quietReached: boolean;
          deadlineHit: boolean;
          meaningfulMutations: number;
        }>((resolve) => {
          const started = performance.now();
          let meaningfulMutations = 0;
          let quietTimer = 0;
          let finished = false;

          const finish = (quietReached: boolean, deadlineHit: boolean) => {
            if (finished) {
              return;
            }
            finished = true;
            window.clearTimeout(quietTimer);
            window.clearTimeout(deadlineTimer);
            try {
              observer.disconnect();
            } catch {
              /* ignore */
            }
            resolve({ quietReached, deadlineHit, meaningfulMutations });
          };

          const isInViewportSized = (node: Node): boolean => {
            const el =
              node.nodeType === Node.ELEMENT_NODE
                ? (node as Element)
                : node.parentElement;
            if (!el || !(el instanceof Element)) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (area < minArea) {
              return false;
            }
            const vw = window.innerWidth || 1;
            const vh = window.innerHeight || 1;
            // 与视口相交即可
            if (rect.bottom < 0 || rect.right < 0 || rect.top > vh || rect.left > vw) {
              return false;
            }
            return true;
          };

          const onMeaningful = () => {
            meaningfulMutations += 1;
            window.clearTimeout(quietTimer);
            quietTimer = window.setTimeout(() => finish(true, false), quietMs);
          };

          const observer = new MutationObserver((records) => {
            for (const record of records) {
              // 忽略纯 attribute / characterData（样式重绘、倒计时文本）
              if (record.type !== "childList") {
                continue;
              }
              const nodes = [
                ...Array.from(record.addedNodes),
                ...Array.from(record.removedNodes),
              ];
              if (nodes.length === 0) {
                continue;
              }
              if (nodes.some((n) => isInViewportSized(n))) {
                onMeaningful();
                return;
              }
            }
          });

          const root = document.body || document.documentElement;
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false,
          });

          const deadlineTimer = window.setTimeout(
            () => finish(false, true),
            deadlineMs,
          );
          quietTimer = window.setTimeout(() => finish(true, false), quietMs);

          // 防止 evaluate 卡死：若页面已卸载
          void started;
        }),
      {
        quietMs: opts.quietMs,
        deadlineMs: opts.deadlineMs,
        minArea: opts.minArea,
      },
    );

    return result;
  } catch {
    return { quietReached: false, deadlineHit: true, meaningfulMutations: 0 };
  }
}
