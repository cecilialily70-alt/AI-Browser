/**
 * 像素指纹（Visual Fingerprint）—— 「这一下到底让页面变了吗？」
 *
 * 背景：现有的结果验证全部依赖 DOM（回读字段值、勾选态、URL、成功文案）。
 * 于是有两类真实事故：
 *   ① 画布类/自定义控件（canvas 地图、富文本、播放器、拖拽列表）真的生效了，
 *      DOM 却毫无变化 → 被判成 no-effect，模型开始无意义地重试同一个目标；
 *   ② 点击被静默吞掉（按钮失效、事件被拦截、目标根本没渲染）→ 没有任何信号告诉模型
 *      「你刚才那一下什么都没发生」，于是它继续在错误的前提上往下走。
 * 两者都可以用最朴素的事实回答：**动作前后的画面是否发生像素级变化**。
 *
 * 实现取向（为什么不用图像库）：
 *   - 不引入 sharp/pngjs 之类依赖：解码交给**浏览器自己**（createImageBitmap + canvas 缩放），
 *     我们在页面里把它压成 64×36 的 RGB 网格再传回来 —— 跨进程只搬几 KB，
 *     且天然不依赖 JPEG/PNG 解码实现。
 *   - `createImageBitmap(blob)` 不经网络，因此**不受站点 CSP 的 img-src 限制**；
 *     页面禁用脚本（sandbox）时整体失败 → 返回 null，绝不抛错打断动作链。
 *   - 网格是纯数值，diff 在 Node 侧算：确定性、可单测、无副作用。
 *
 * 定位：这是**辅助证据**，不是验收闸门。
 *   「视觉有变化」不足以证明任务完成（动画、轮播、时间戳都会变），
 *   但「DOM 无变化 + 视觉无变化」是很强的「这一下没生效」信号，
 *   足以让模型停止原样重试、改换策略。
 */
import type { Page } from "playwright-core";

import { captureScreenshot } from "./safe_screenshot.js";

export const VISUAL_FINGERPRINT_CONFIG = {
  /**
   * 网格列/行。96×54 在 1000×700 视口下每格约 10×13px —— 一个字的改动就能占满 1–2 格，
   * 因此「文本微调」也能被测到；再细一档收益递减、跨进程数据量翻倍。
   */
  cols: 96,
  rows: 54,
  /** 抓指纹用的 JPEG 质量（只做像素比较，不需要好看） */
  jpegQuality: 52,
  /** 单格 RGB 最大通道差超过此值才算「这一格变了」（0–255） */
  cellDelta: 12,
  /**
   * 变化格**数量**门槛（绝对格数，比占比更直观）。
   * 定得这么小是因为实测噪声几乎为 0（静止页面两次指纹逐格完全相同）：
   * 1 格 = 96×54 网格里约 10×13px 的区块整体变了 ≥12/255，已远超 JPEG/抗锯齿抖动。
   * 注意：这是「**什么都没发生**」的门槛，不是「生效了」的门槛 —— 见 visibleChangedRatio。
   */
  minChangedCells: 1,
  /** 平均通道差达到此值也算「画面动了」（整屏亮度/配色渐变等） */
  minMeanDelta: 0.8,
  /**
   * 「**可见变化**」门槛：只有到这个量级才敢对模型说「画面已响应」。
   *
   * 为什么要两档：点击必然带来**指针状态变化**（hover 高亮、焦点环、按压涟漪），
   * 它们都是真实像素变化，但**不代表点击生效**。若把这种变化报成「生效了」，
   * 就会主动误导模型（比没有信号更糟）。所以：
   *   低于 minChangedRatio           → 「什么都没发生」（可靠，可报警）
   *   介于两者之间（多为 hover/焦点）  → 不下结论（沉默）
   *   高于 visibleChangedRatio        → 「画面已响应」（面积级/亮度级变化，如弹层、面板、画布重绘）
   */
  visibleChangedRatio: 0.01,
  visibleMeanDelta: 2.5,
  /** 判定「无变化」时忽略的命中点邻域半径（px）：把 hover/焦点环这类指针伪影排除在外 */
  ignoreAroundHitPx: 70,
  /** 截图超时（ms）：绝不因截图把动作链挂死 */
  captureTimeoutMs: 6_000,
  /** 动作后限时观察画面变化的上限（ms）：见到变化立即返回，到点才下「没动」的结论 */
  postActionWaitMs: 900,
} as const;

export interface VisualFingerprint {
  cols: number;
  rows: number;
  /** 行优先的 RGB 三联组，长度 = cols*rows*3 */
  cells: number[];
  /** 抓取时刻的位图尺寸（用于诊断分辨率/缩放变化） */
  width: number;
  height: number;
}

export interface VisualDiff {
  /** 是否存在**任何**可感知的画面变化（含 hover/焦点这类指针伪影）→ 用于「什么都没发生」判定 */
  changed: boolean;
  /** 是否达到「可见变化」量级 → 只有它为真才敢说「画面已响应」 */
  visible: boolean;
  changedCells: number;
  cells: number;
  changedRatio: number;
  meanDelta: number;
}

export interface VisualVerifyResult extends VisualDiff {
  before: VisualFingerprint;
  after: VisualFingerprint;
}

/** 判定时忽略的矩形区域（视口 px）：用来把「指针停在目标上」造成的 hover/焦点伪影排除掉 */
export interface VisualIgnoreRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把视口 px 矩形换算成网格列/行区间（越界即裁剪） */
function ignoreCellRange(
  ignore: VisualIgnoreRect | null | undefined,
  viewport: { width: number; height: number } | null | undefined,
  cols: number,
  rows: number,
): { c0: number; c1: number; r0: number; r1: number } | null {
  if (!ignore || !viewport || viewport.width <= 0 || viewport.height <= 0) return null;
  const toCol = (px: number) => Math.round((px / viewport.width) * cols);
  const toRow = (px: number) => Math.round((px / viewport.height) * rows);
  const c0 = Math.max(0, toCol(ignore.x));
  const c1 = Math.min(cols - 1, toCol(ignore.x + ignore.w));
  const r0 = Math.max(0, toRow(ignore.y));
  const r1 = Math.min(rows - 1, toRow(ignore.y + ignore.h));
  if (c1 < c0 || r1 < r0) return null;
  return { c0, c1, r0, r1 };
}

/**
 * 页面内取指纹：base64 → Blob → ImageBitmap → canvas 缩放 → RGB 网格。
 * 必须自包含（Playwright 会把函数源码序列化进页面，不能引用模块作用域）。
 */
const FINGERPRINT_SCRIPT = async (args: {
  b64: string;
  cols: number;
  rows: number;
}): Promise<{ cells: number[]; width: number; height: number }> => {
  const binary = atob(args.b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  // createImageBitmap 不走网络请求，因此不受 CSP img-src/connect-src 约束
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const canvas = document.createElement("canvas");
  canvas.width = args.cols;
  canvas.height = args.rows;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("canvas_2d_unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, args.cols, args.rows);
  const data = ctx.getImageData(0, 0, args.cols, args.rows).data;
  const cells: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    cells.push(data[i], data[i + 1], data[i + 2]);
  }
  const size = { cells, width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  canvas.width = 0;
  canvas.height = 0;
  return size;
};

/**
 * 抓一次画面指纹。任何失败（页面关闭、截图失败、canvas/位图不可用、CSP 特殊站点）
 * 都返回 null —— 调用方按「没有像素证据」处理，绝不因此中断动作。
 */
export async function captureVisualFingerprint(
  page: Page,
  options?: { cols?: number; rows?: number; signal?: AbortSignal },
): Promise<VisualFingerprint | null> {
  const cols = Math.max(8, Math.floor(options?.cols ?? VISUAL_FINGERPRINT_CONFIG.cols));
  const rows = Math.max(8, Math.floor(options?.rows ?? VISUAL_FINGERPRINT_CONFIG.rows));
  try {
    if (options?.signal?.aborted || page.isClosed()) return null;
    const shot = await captureScreenshot(page, {
      type: "jpeg",
      quality: VISUAL_FINGERPRINT_CONFIG.jpegQuality,
      fullPage: false,
      timeout: VISUAL_FINGERPRINT_CONFIG.captureTimeoutMs,
    });
    const b64 = Buffer.from(shot).toString("base64");
    const grid = (await page.evaluate(FINGERPRINT_SCRIPT, { b64, cols, rows })) as {
      cells: number[];
      width: number;
      height: number;
    };
    if (!grid || !Array.isArray(grid.cells) || grid.cells.length !== cols * rows * 3) {
      return null;
    }
    return { cols, rows, cells: grid.cells, width: grid.width, height: grid.height };
  } catch {
    return null;
  }
}

/**
 * 两张指纹的差异。尺寸/网格不一致（用过不同参数抓取）时返回 null，宁可没有结论也不给错结论。
 *
 * 三个量各自服务一个决策：
 *   - `changed`：有没有**任何**变化（哪怕一格）→ 说「什么都没发生」的依据；
 *   - `visible`：有没有**量级足够**的变化 → 说「画面已响应」的依据；
 *   - 两者之间：沉默（多半是 hover 高亮 / 焦点环 / 按压涟漪，不能当生效证据）。
 * `ignore` 区域（通常是点击命中点邻域）完全不计入，专门用来剔除指针伪影。
 */
export function diffFingerprints(
  before: VisualFingerprint | null,
  after: VisualFingerprint | null,
  options?: {
    cellDelta?: number;
    minChangedCells?: number;
    minMeanDelta?: number;
    visibleChangedRatio?: number;
    visibleMeanDelta?: number;
    ignore?: VisualIgnoreRect | null;
    viewport?: { width: number; height: number } | null;
  },
): VisualDiff | null {
  if (!before || !after) return null;
  if (before.cells.length !== after.cells.length || before.cells.length === 0) return null;
  if (before.cells.length % 3 !== 0) return null;

  const cellDelta = options?.cellDelta ?? VISUAL_FINGERPRINT_CONFIG.cellDelta;
  const minChangedCells = options?.minChangedCells ?? VISUAL_FINGERPRINT_CONFIG.minChangedCells;
  const minMeanDelta = options?.minMeanDelta ?? VISUAL_FINGERPRINT_CONFIG.minMeanDelta;
  const visibleRatio = options?.visibleChangedRatio ?? VISUAL_FINGERPRINT_CONFIG.visibleChangedRatio;
  const visibleMean = options?.visibleMeanDelta ?? VISUAL_FINGERPRINT_CONFIG.visibleMeanDelta;
  const ignore = ignoreCellRange(options?.ignore, options?.viewport, before.cols, before.rows);

  const cells = before.cells.length / 3;
  let counted = 0;
  let changedCells = 0;
  let sum = 0;
  for (let i = 0; i < before.cells.length; i += 3) {
    const cellIndex = i / 3;
    const col = cellIndex % before.cols;
    const row = Math.floor(cellIndex / before.cols);
    const inIgnore =
      ignore != null && col >= ignore.c0 && col <= ignore.c1 && row >= ignore.r0 && row <= ignore.r1;
    if (inIgnore) continue;
    counted += 1;
    const dr = Math.abs(before.cells[i]! - after.cells[i]!);
    const dg = Math.abs(before.cells[i + 1]! - after.cells[i + 1]!);
    const db = Math.abs(before.cells[i + 2]! - after.cells[i + 2]!);
    const delta = Math.max(dr, dg, db);
    sum += delta;
    if (delta >= cellDelta) changedCells += 1;
  }
  if (counted === 0) return null;
  const changedRatio = changedCells / counted;
  const meanDelta = sum / counted;
  const changed = changedCells >= minChangedCells || meanDelta >= minMeanDelta;
  const visible = changedRatio >= visibleRatio || meanDelta >= visibleMean;
  return { changed, visible, changedCells, cells: counted, changedRatio, meanDelta };
}

/** 采集「动作后」画面并与「动作前」比对；缺任一侧时返回 null（没有像素证据） */
export async function verifyVisualChange(
  page: Page,
  before: VisualFingerprint | null,
  options?: { signal?: AbortSignal; ignore?: VisualIgnoreRect | null },
): Promise<VisualVerifyResult | null> {
  if (!before) return null;
  const after = await captureVisualFingerprint(page, { signal: options?.signal });
  if (!after) return null;
  const diff = diffFingerprints(before, after, {
    ignore: options?.ignore ?? null,
    viewport: page.viewportSize() ?? null,
  });
  if (!diff) return null;
  return { ...diff, before, after };
}

export interface VisualChangeObservation extends VisualDiff {
  /** 从动作结束到「看到变化」实际等待的毫秒数 */
  waitedMs: number;
  /** 轮询次数（诊断用：次数越多说明页面越迟钝） */
  polls: number;
}

/**
 * 动作后**限时观察**画面变化。
 *
 * 为什么要轮询而不是立刻拍一张：
 *   - 立刻拍 → 渲染还没发生，会把「慢一点但确实生效」的点击误判成「什么都没发生」，
 *     而这种误判会直接误导模型（比没有信号更糟）；
 *   - 固定等一个长 settle → 每次点击都白等几百毫秒。
 * 折中：小步轮询，**一旦见到变化立即返回**；到点仍无变化才下结论「这段时间里没动」。
 * 结论口径必须诚实：changed=false 的含义是「等了这么久都没看到变化」，不是「绝对没生效」。
 */
export async function observeVisualChangeWithin(
  page: Page,
  before: VisualFingerprint | null,
  options?: { maxWaitMs?: number; pollMs?: number; signal?: AbortSignal; ignore?: VisualIgnoreRect | null },
): Promise<VisualChangeObservation | null> {
  if (!before) return null;
  const maxWaitMs = Math.max(0, Math.floor(options?.maxWaitMs ?? 900));
  const pollMs = Math.max(40, Math.floor(options?.pollMs ?? 160));
  const started = Date.now();
  let polls = 0;
  let last: VisualDiff | null = null;
  for (;;) {
    polls += 1;
    const diff = await verifyVisualChange(page, before, {
      signal: options?.signal,
      ignore: options?.ignore ?? null,
    });
    if (!diff) return null;
    last = diff;
    // 见到「可见变化」立即收工；只见到 hover/焦点级的小变化也停 —— 再等下去它也不会变大，
    // 而每个点击都多等几百毫秒是不可接受的成本。
    if (diff.visible) {
      return { ...diff, waitedMs: Date.now() - started, polls };
    }
    if (diff.changed) {
      return { ...diff, waitedMs: Date.now() - started, polls };
    }
    if (Date.now() - started >= maxWaitMs || options?.signal?.aborted) break;
    await page.waitForTimeout(pollMs).catch(() => undefined);
  }
  return last ? { ...last, waitedMs: Date.now() - started, polls } : null;
}

/** 给人/模型看的一句话（百分比 + 格数，避免模型误以为这是精确测量） */
export function describeVisualDiff(diff: VisualDiff, before?: VisualFingerprint | null): string {
  const pct = (diff.changedRatio * 100).toFixed(2);
  const grid = before ? `${before.cols}×${before.rows}` : `${diff.cells}`;
  return diff.changed
    ? `画面有变化（${grid} 网格中 ${diff.changedCells} 格变化，占 ${pct}%，平均差 ${diff.meanDelta.toFixed(1)}）`
    : `画面无变化（${grid} 网格差异 ${pct}%，平均差 ${diff.meanDelta.toFixed(1)}）`;
}
