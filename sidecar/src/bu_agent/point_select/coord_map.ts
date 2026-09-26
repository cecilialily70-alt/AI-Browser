/**
 * 点选坐标映射（执行层）：
 *   finalX = contentBox.left + modelPixelX
 *   finalY = contentBox.top  + modelPixelY
 *
 * 网格路径：格号 → gridIdToCenter(原图中心) → 墨迹质心精修 → 本模块加视口偏移。
 * content-box = 去掉 padding/border 后的画面区（防右下漂）。
 */
import type { Page } from "playwright-core";
import type { CaptchaCrop, PixelPoint } from "./types.js";
import { readMediaContentBox } from "./media_box.js";

export type MediaRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  canvasInternalW?: number;
  canvasInternalH?: number;
  tag?: string;
  contentInsetX?: number;
  contentInsetY?: number;
};

export type UnitPoint = {
  u: number;
  v: number;
  space: "pixel" | "norm1000" | "unit";
  /** 原始模型像素（已钳制到图内） */
  modelX: number;
  modelY: number;
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/** 规范化单点到图内像素（处理 1000 空间 / 0~1） */
export function normalizeModelPixel(
  p: PixelPoint,
  imageW: number,
  imageH: number,
): PixelPoint {
  const w = Math.max(1, imageW);
  const h = Math.max(1, imageH);
  let x = Number(p.x);
  let y = Number(p.y);
  const xs = String(p.x);
  const ys = String(p.y);

  if (
    x >= 0 &&
    y >= 0 &&
    x <= 1 &&
    y <= 1 &&
    (/\./.test(xs) || /\./.test(ys))
  ) {
    return { x: x * w, y: y * h };
  }

  if ((x > w || y > h) && x <= 1000 && y <= 1000 && x >= 0 && y >= 0) {
    return { x: (x / 1000) * w, y: (y / 1000) * h };
  }

  return {
    x: clamp(x, 0, w - 1),
    y: clamp(y, 0, h - 1),
  };
}

export function aiPointToUnit(
  p: PixelPoint,
  imageW: number,
  imageH: number,
): UnitPoint {
  const w = Math.max(1, imageW);
  const h = Math.max(1, imageH);
  const norm = normalizeModelPixel(p, w, h);
  const rawX = Number(p.x);
  const rawY = Number(p.y);
  let space: UnitPoint["space"] = "pixel";
  if (
    rawX >= 0 &&
    rawY >= 0 &&
    rawX <= 1 &&
    rawY <= 1 &&
    (/\./.test(String(p.x)) || /\./.test(String(p.y)))
  ) {
    space = "unit";
  } else if (
    (rawX > w || rawY > h) &&
    rawX <= 1000 &&
    rawY <= 1000
  ) {
    space = "norm1000";
  }
  return {
    u: clamp01(norm.x / w),
    v: clamp01(norm.y / h),
    space,
    modelX: norm.x,
    modelY: norm.y,
  };
}

export function aiPointsToUnits(
  points: PixelPoint[],
  imageW: number,
  imageH: number,
): UnitPoint[] {
  return points.map((pt) => aiPointToUnit(pt, imageW, imageH));
}

/**
 * 工业公式（CSS 1:1）：
 * finalX = rect.left + modelPixelX
 * 若位图≠CSS，则 model 先按比例映射到 CSS 局部坐标
 */
export function modelPixelToViewport(
  rect: MediaRect,
  modelX: number,
  modelY: number,
  imageW: number,
  imageH: number,
): PixelPoint {
  const rw = Math.max(1, rect.width);
  const rh = Math.max(1, rect.height);
  const iw = Math.max(1, imageW);
  const ih = Math.max(1, imageH);

  let localX: number;
  let localY: number;
  // 1:1（容差 2px）→ 直接相加
  if (Math.abs(iw - rw) <= 2 && Math.abs(ih - rh) <= 2) {
    localX = modelX;
    localY = modelY;
  } else {
    localX = (modelX / iw) * rw;
    localY = (modelY / ih) * rh;
  }

  const inset = 0.5;
  const lx = clamp(localX, inset, rw - inset);
  const ly = clamp(localY, inset, rh - inset);
  return {
    x: rect.left + lx,
    y: rect.top + ly,
  };
}

export function unitToViewport(
  rect: MediaRect,
  unit: UnitPoint,
  imageW?: number,
  imageH?: number,
): PixelPoint {
  const iw = Math.max(1, imageW ?? rect.width);
  const ih = Math.max(1, imageH ?? rect.height);
  return modelPixelToViewport(rect, unit.modelX, unit.modelY, iw, ih);
}

export function toViewportPoints(
  crop: CaptchaCrop,
  imagePoints: PixelPoint[],
): PixelPoint[] {
  const imgW = Math.max(1, crop.imageWidth ?? crop.width);
  const imgH = Math.max(1, crop.imageHeight ?? crop.height);
  const rect: MediaRect = {
    left: crop.startX,
    top: crop.startY,
    width: crop.width,
    height: crop.height,
  };
  return aiPointsToUnits(imagePoints, imgW, imgH).map((u) =>
    unitToViewport(rect, u, imgW, imgH),
  );
}

export function resolveCropDpr(crop: CaptchaCrop): number {
  const cssW = Math.max(1, crop.width);
  const imgW = Math.max(1, crop.imageWidth ?? crop.width);
  return imgW / cssW;
}

const ATTR = "data-cf-point-crop";

/** 点击前读取 media 的 content-box（唯一合法原点） */
export async function readLiveMediaRect(page: Page): Promise<MediaRect | null> {
  const box = await readMediaContentBox(page);
  if (box) {
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      tag: box.tag,
      canvasInternalW: box.canvasInternalW,
      canvasInternalH: box.canvasInternalH,
      contentInsetX: box.paddingLeft,
      contentInsetY: box.paddingTop,
    };
  }
  return page
    .evaluate((attr) => {
      const el = document.querySelector(
        `[${attr}="media"]`,
      ) as HTMLElement | null;
      if (!el) return null;
      if (el.tagName !== "IMG" && el.tagName !== "CANVAS") return null;
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const bb = parseFloat(cs.borderBottomWidth) || 0;
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      const left = r.left + bl + pl;
      const top = r.top + bt + pt;
      const width = Math.max(1, r.width - bl - br - pl - pr);
      const height = Math.max(1, r.height - bt - bb - pt - pb);
      if (width < 8 || height < 8) return null;
      return {
        left,
        top,
        width,
        height,
        tag: el.tagName.toLowerCase(),
        contentInsetX: bl + pl,
        contentInsetY: bt + pt,
      };
    }, ATTR)
    .catch(() => null);
}

export function clampToViewport(
  pt: PixelPoint,
  viewportW: number,
  viewportH: number,
): PixelPoint {
  return {
    x: Math.min(Math.max(0, pt.x), Math.max(0, viewportW - 1)),
    y: Math.min(Math.max(0, pt.y), Math.max(0, viewportH - 1)),
  };
}
