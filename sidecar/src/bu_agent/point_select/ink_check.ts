/**
 * 墨迹采样 + 局部质心吸附（Visual Grid 格心精修）
 * 同页离屏 canvas，不注入 DOM、不 newPage。
 */
import type { Page } from "playwright-core";
import type { PixelPoint } from "./types.js";
export type InkTargetKind = "glyph" | "shape";

export type InkCentroidResult = {
  /** 吸附后的点击点；blank 时仍为中心，勿盲点 */
  point: PixelPoint;
  blank: boolean;
  dx: number;
  dy: number;
  inkPixels: number;
  /** 暖色高饱和（插画/头盔）嫌疑；shape 模式下不用于拦彩色目标 */
  illustrationLikely?: boolean;
  /** 贯穿细线/竖直纹理假墨（无二维字斑） */
  lineNoiseLikely?: boolean;
};

const CENTROID_HALF = 18; // 36×36
/** 最终点：墨迹质心权重（质心天然居中；包围盒中心易被孤立长笔/偏旁拉歪） */
const MASS_CENTER_WEIGHT = 0.62;
/** 相对格心最大偏移，防吸到邻字 */
const MAX_OFFSET_RATIO = 0.9;

/** 逐轴采样半宽：x/y 各自独立，便于按格宽高对齐 */
export type InkHalfSize = number | { halfX: number; halfY: number };

/**
 * 采样半宽严格等于「半格」：窗口正好铺满本格，绝不越界到邻格。
 * 旧值 max(18, ceil(max(cellW,cellH)*0.55)) 比半格大，相邻格采样窗重叠，
 * 两个目标会共同吸附到同一墨迹（实测两个点击点只隔 8px）→ 该题必失败。
 * 按半格收口后，每个目标只能在自己格内找墨迹，空白格才会被正确判为空白并自愈。
 */
export function inkHalfForCell(
  cellWidth: number,
  cellHeight: number,
): { halfX: number; halfY: number } {
  return {
    halfX: Math.max(6, Math.floor(cellWidth / 2)),
    halfY: Math.max(6, Math.floor(cellHeight / 2)),
  };
}
/**
 * 以格心为中心取邻域，找笔画/色块后点在质心偏中间。
 * kind=glyph：汉字（拒暖色插画、拒线噪）
 * kind=shape：彩色图标/几何形（暖色算有效墨，线噪更宽松）
 */
export async function refineInkCentroid(
  page: Page,
  cleanImageB64: string,
  center: PixelPoint,
  halfSize: InkHalfSize = CENTROID_HALF,
  kind: InkTargetKind = "glyph",
): Promise<InkCentroidResult> {
  const halfX = typeof halfSize === "number" ? halfSize : halfSize.halfX;
  const halfY = typeof halfSize === "number" ? halfSize : halfSize.halfY;
  try {
    const raw = await page.evaluate(
      async ({
        b64,
        cx,
        cy,
        halfX: hx,
        halfY: hy,
        massW,
        maxOffRatio,
        kind: inkKind,
      }: {
        b64: string;
        cx: number;
        cy: number;
        halfX: number;
        halfY: number;
        massW: number;
        maxOffRatio: number;
        kind: "glyph" | "shape";
      }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);
        const w = bitmap.width;
        const h = bitmap.height;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });
        if (!ctx) {
          bitmap.close();
          return {
            blank: true,
            dx: 0,
            dy: 0,
            inkPixels: 0,
            fx: cx,
            fy: cy,
            warmChroma: 0,
            illustrationLikely: false,
            lineNoiseLikely: false,
          };
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();

        const px = Math.max(0, Math.min(w - 1, Math.round(cx)));
        const py = Math.max(0, Math.min(h - 1, Math.round(cy)));
        const x0 = Math.max(0, px - hx);
        const y0 = Math.max(0, py - hy);
        const x1 = Math.min(w, px + hx);
        const y1 = Math.min(h, py + hy);
        const iw = Math.max(1, x1 - x0);
        const ih = Math.max(1, y1 - y0);
        const data = ctx.getImageData(x0, y0, iw, ih).data;

        const lumas: number[] = [];
        const chromas: number[] = [];
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          lumas.push(0.299 * r + 0.587 * g + 0.114 * b);
          chromas.push(Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r));
        }
        const sorted = lumas.slice().sort((a, b) => a - b);
        const mid = sorted[Math.floor(sorted.length / 2)] ?? 128;
        const sortedC = chromas.slice().sort((a, b) => a - b);
        const midC = sortedC[Math.floor(sortedC.length / 2)] ?? 0;

        const darkThresh = mid - (inkKind === "shape" ? 12 : 18);
        const chromaThresh = midC + (inkKind === "shape" ? 14 : 22);
        let sumX = 0;
        let sumY = 0;
        let inkN = 0;
        let minL = 255;
        let maxL = 0;
        let minIX = iw;
        let maxIX = -1;
        let minIY = ih;
        let maxIY = -1;
        for (let yy = 0; yy < ih; yy++) {
          for (let xx = 0; xx < iw; xx++) {
            const i = (yy * iw + xx) * 4;
            const r = data[i]!;
            const g = data[i + 1]!;
            const b = data[i + 2]!;
            const l = 0.299 * r + 0.587 * g + 0.114 * b;
            const ch = Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
            if (l < minL) minL = l;
            if (l > maxL) maxL = l;
            if (l <= darkThresh || ch >= chromaThresh) {
              sumX += x0 + xx;
              sumY += y0 + yy;
              inkN += 1;
              if (xx < minIX) minIX = xx;
              if (xx > maxIX) maxIX = xx;
              if (yy < minIY) minIY = yy;
              if (yy > maxIY) maxIY = yy;
            }
          }
        }

        const range = maxL - minL;
        const minInk = inkKind === "shape" ? 10 : 8;
        const minRange = inkKind === "shape" ? 14 : 22;
        if (inkN < minInk || range < minRange || maxIX < minIX || maxIY < minIY) {
          return {
            blank: true,
            dx: 0,
            dy: 0,
            inkPixels: inkN,
            fx: px,
            fy: py,
            warmChroma: 0,
            illustrationLikely: false,
            lineNoiseLikely: false,
          };
        }

        // 结构门禁：贯穿细线；shape（星形尖角）更宽松
        const bboxW = maxIX - minIX + 1;
        const bboxH = maxIY - minIY + 1;
        const fillRatio = inkN / Math.max(1, bboxW * bboxH);
        const aspect =
          Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH));
        const lineNoiseLikely =
          inkKind === "shape"
            ? aspect >= 6.5 && fillRatio < 0.1
            : (aspect >= 3.8 && fillRatio < 0.28) ||
              (inkN < 28 && fillRatio < 0.18) ||
              bboxW < 5 ||
              bboxH < 5;
        if (lineNoiseLikely) {
          return {
            blank: true,
            dx: 0,
            dy: 0,
            inkPixels: inkN,
            fx: px,
            fy: py,
            warmChroma: 0,
            illustrationLikely: false,
            lineNoiseLikely: true,
          };
        }

        // 墨迹质心（天然居中）为主；包围盒中心仅小幅抗「孤立长笔/偏旁」拖拽
        const massX = sumX / inkN;
        const massY = sumY / inkN;
        const boxCx = x0 + (minIX + maxIX) / 2;
        const boxCy = y0 + (minIY + maxIY) / 2;
        const fx0 = massX * massW + boxCx * (1 - massW);
        const fy0 = massY * massW + boxCy * (1 - massW);

        const maxOffX = hx * maxOffRatio;
        const maxOffY = hy * maxOffRatio;
        let fx = Math.max(cx - maxOffX, Math.min(cx + maxOffX, fx0));
        let fy = Math.max(cy - maxOffY, Math.min(cy + maxOffY, fy0));
        fx = Math.max(0, Math.min(w - 1, fx));
        fy = Math.max(0, Math.min(h - 1, fy));

        let warmN = 0;
        let warmChromaSum = 0;
        let glyphInkN = 0;
        for (let yy = 0; yy < ih; yy++) {
          for (let xx = 0; xx < iw; xx++) {
            const i = (yy * iw + xx) * 4;
            const r = data[i]!;
            const g = data[i + 1]!;
            const b = data[i + 2]!;
            const l = 0.299 * r + 0.587 * g + 0.114 * b;
            const chv = Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
            const isWarm = r > 160 && r > g + 25 && r > b + 25;
            if (isWarm) {
              warmN += 1;
              warmChromaSum += chv;
            }
            const isInk = l <= darkThresh || chv >= chromaThresh;
            if (isInk && !isWarm) glyphInkN += 1;
          }
        }
        const warmRatio = warmN / Math.max(1, iw * ih);
        const warmChroma = warmN > 0 ? warmChromaSum / warmN : 0;
        const glyphRatio = glyphInkN / Math.max(1, inkN);
        // glyph：暖色装饰无笔画 → 插画；shape：彩色目标本身常是暖色，不标插画
        const illustrationLikely =
          inkKind === "glyph" &&
          warmRatio > 0.28 &&
          warmChroma > 80 &&
          glyphRatio < 0.2;
        return {
          blank: false,
          dx: fx - cx,
          dy: fy - cy,
          inkPixels: inkN,
          fx,
          fy,
          warmChroma,
          illustrationLikely,
          lineNoiseLikely: false,
        };
      },
      {
        b64: cleanImageB64,
        cx: center.x,
        cy: center.y,
        halfX,
        halfY,
        massW: MASS_CENTER_WEIGHT,
        maxOffRatio: MAX_OFFSET_RATIO,
        kind,
      },
    );

    return {
      point: {
        x: Math.max(0, raw.fx),
        y: Math.max(0, raw.fy),
      },
      blank: raw.blank,
      dx: raw.dx,
      dy: raw.dy,
      inkPixels: raw.inkPixels,
      illustrationLikely: Boolean(
        (raw as { illustrationLikely?: boolean }).illustrationLikely,
      ),
      lineNoiseLikely: Boolean(
        (raw as { lineNoiseLikely?: boolean }).lineNoiseLikely,
      ),
    };
  } catch {
    return {
      point: { x: center.x, y: center.y },
      blank: true,
      dx: 0,
      dy: 0,
      inkPixels: 0,
      illustrationLikely: false,
      lineNoiseLikely: false,
    };
  }
}
/**
 * 裁出某一格（含少量 padding）为 JPEG base64，供逐格视觉核验。
 */
export async function cropGridCellJpeg(
  page: Page,
  cleanImageB64: string,
  gridId: string,
  grid: {
    cols: number;
    rows: number;
    colLabels: string;
    imageWidth: number;
    imageHeight: number;
    cellWidth: number;
    cellHeight: number;
  },
  padRatio = 0.15,
): Promise<string | null> {
  const letter = gridId[0]?.toUpperCase() ?? "";
  const col = grid.colLabels.indexOf(letter);
  const row = Number(gridId.slice(1));
  if (col < 0 || !Number.isInteger(row) || row < 0 || row >= grid.rows) {
    return null;
  }
  const padX = grid.cellWidth * padRatio;
  const padY = grid.cellHeight * padRatio;
  const x0 = Math.max(0, Math.floor(col * grid.cellWidth - padX));
  const y0 = Math.max(0, Math.floor(row * grid.cellHeight - padY));
  const x1 = Math.min(
    grid.imageWidth,
    Math.ceil((col + 1) * grid.cellWidth + padX),
  );
  const y1 = Math.min(
    grid.imageHeight,
    Math.ceil((row + 1) * grid.cellHeight + padY),
  );
  try {
    return await page.evaluate(
      async ({
        b64,
        x0: sx,
        y0: sy,
        x1: ex,
        y1: ey,
      }: {
        b64: string;
        x0: number;
        y0: number;
        x1: number;
        y1: number;
      }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);
        const cw = Math.max(1, ex - sx);
        const ch = Math.max(1, ey - sy);
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) {
          bitmap.close();
          return null;
        }
        ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, cw, ch);
        bitmap.close();
        return canvas.toDataURL("image/jpeg", 0.92).split(",")[1] ?? null;
      },
      { b64: cleanImageB64, x0, y0, x1, y1 },
    );
  } catch {
    return null;
  }
}
