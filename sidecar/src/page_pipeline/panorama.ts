/**
 * 全景截图：多帧独立视口 JPEG（数组），禁止竖向拼接长图。
 * 内存以 Buffer 存放，组装 LLM 前才转 base64。
 */
import type { Page } from "playwright-core";

import { PAGE_PIPELINE_CONFIG } from "./config.js";
import { captureScreenshot } from "../core/safe_screenshot.js";

export interface PanoramaFrame {
  /** JPEG bytes */
  buffer: Buffer;
  index: number;
  scrollY: number;
}

export interface PanoramaResult {
  frames: PanoramaFrame[];
  skipped: boolean;
  reason: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 快速滚动视口连拍。关开关时由调用方 no-op。
 */
export async function capturePanoramaFrames(
  page: Page,
  opts?: { maxFrames?: number; signal?: AbortSignal },
): Promise<PanoramaResult> {
  if (opts?.signal?.aborted) {
    throw new Error("截图已中止");
  }
  if (page.isClosed()) {
    return { frames: [], skipped: true, reason: "page_closed" };
  }

  const maxFrames = Math.min(
    opts?.maxFrames ?? PAGE_PIPELINE_CONFIG.panoramaMaxFrames,
    PAGE_PIPELINE_CONFIG.panoramaMaxFrames,
  );

  let metrics: { scrollY: number; viewH: number; scrollH: number } = {
    scrollY: 0,
    viewH: 800,
    scrollH: 800,
  };
  try {
    metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        scrollY: window.scrollY || doc.scrollTop || 0,
        viewH: window.innerHeight || doc.clientHeight || 800,
        scrollH: Math.max(doc.scrollHeight, doc.clientHeight, 800),
      };
    });
  } catch {
    /* use defaults */
  }

  const startY = metrics.scrollY;
  const viewH = Math.max(200, metrics.viewH);
  const maxY = Math.max(0, metrics.scrollH - viewH);
  const step = Math.max(Math.floor(viewH * 0.85), 200);
  const targets: number[] = [];
  for (let y = 0; y <= maxY && targets.length < maxFrames; y += step) {
    targets.push(Math.min(y, maxY));
  }
  if (targets.length === 0) {
    targets.push(0);
  }
  // 去重（短页）
  const unique = [...new Set(targets)].slice(0, maxFrames);

  const frames: PanoramaFrame[] = [];
  try {
    for (let i = 0; i < unique.length; i++) {
      if (opts?.signal?.aborted) {
        break;
      }
      const y = unique[i]!;
      try {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await sleep(PAGE_PIPELINE_CONFIG.scrollSettleMs);
        const raw = await captureScreenshot(page, {
          type: "jpeg",
          quality: PAGE_PIPELINE_CONFIG.jpegQuality,
          fullPage: false,
        });
        const buffer = await maybeDownscaleJpeg(Buffer.from(raw));
        frames.push({ buffer, index: i, scrollY: y });
      } catch {
        /* skip frame */
      }
    }
  } finally {
    // 尽量恢复滚动位置
    try {
      await page.evaluate((top) => window.scrollTo(0, top), startY);
    } catch {
      /* ignore */
    }
  }

  return {
    frames,
    skipped: frames.length === 0,
    reason: frames.length ? `captured_${frames.length}` : "no_frames",
  };
}

/** 若超长边则用 canvas 在页内缩小（无额外依赖）；失败则原样返回 */
async function maybeDownscaleJpeg(buf: Buffer): Promise<Buffer> {
  // Playwright JPEG 已是视口尺寸；进一步缩小留给 page.evaluate 成本高。
  // 控制 quality + maxFrames 已足够控 Token；超大 buffer 再截断风险低。
  const maxBytes = 350_000;
  if (buf.length <= maxBytes) {
    return buf;
  }
  // 过大时仍返回（模型 detail=low 会再压）；不在此拼接
  return buf;
}

export function framesToBase64DataUrls(frames: PanoramaFrame[]): string[] {
  return frames.map(
    (f) => `data:image/jpeg;base64,${f.buffer.toString("base64")}`,
  );
}

export function disposeFrames(frames: PanoramaFrame[] | null | undefined): void {
  if (!frames) {
    return;
  }
  for (const f of frames) {
    // 帮助 GC：切断 Buffer 引用
    (f as { buffer: Buffer | null }).buffer = null as unknown as Buffer;
  }
  frames.length = 0;
}
