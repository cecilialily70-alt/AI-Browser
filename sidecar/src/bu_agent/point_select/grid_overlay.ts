/**
 * Visual Grid 网格化定位（Canvas 离屏叠图）
 *
 * 模块职责：
 * 1. 在验证码原图上叠半透明等分网格 + 高对比格号（送 VLM）
 * 2. 把模型返回的格号（如 C4）逆向成原图中心像素
 *
 * 网格密度计算（后续调密/调疏只改常量或传入 options）：
 *   cellWidth  = imageWidth  / cols
 *   cellHeight = imageHeight / rows
 *   格心 (x,y) = ((col+0.5)*cellWidth, (row+0.5)*cellHeight)
 *
 * 默认 10×10：列 A–J，行 0–9（与常见「A1–J10」差在行从 0 起，避免改动既有解析/日志）。
 * 不引入 Sharp；严禁 newPage(about:blank) 抢焦点。
 */
import type { Page } from "playwright-core";
import { readJpegSize } from "./jpeg_size.js";
import type { PixelPoint } from "./types.js";

export type GridConfig = {
  cols: number;
  rows: number;
  /** 列标签串，长度须 = cols，例如 "ABCDEFGHIJ" */
  colLabels: string;
  imageWidth: number;
  imageHeight: number;
  /** cellWidth = imageWidth / cols */
  cellWidth: number;
  /** cellHeight = imageHeight / rows */
  cellHeight: number;
};

export type GridOverlayResult = {
  buf: Buffer;
  b64: string;
  processedImageBase64: string;
  gridInfo: GridConfig;
  imageWidth: number;
  imageHeight: number;
};

/** 密度：默认 10×10。调密（如 12）可提高定位精度，但格号更挤、VLM 更易读错。 */
export const VISUAL_GRID_COLS = 10;
export const VISUAL_GRID_ROWS = 10;
export const VISUAL_GRID_COL_LABELS = "ABCDEFGHIJ";

export type GridDensityOptions = {
  /** 列数，默认 10；须 ≤ colLabels 可用字母数 */
  cols?: number;
  /** 行数，默认 10；行号仍为 0..(rows-1) 的个位数字（≤10 行） */
  rows?: number;
  /** 列标签，默认 A–J；长度须 ≥ cols */
  colLabels?: string;
};

export function buildGridConfig(
  imageWidth: number,
  imageHeight: number,
  density?: GridDensityOptions,
): GridConfig {
  const w = Math.max(1, Math.round(imageWidth));
  const h = Math.max(1, Math.round(imageHeight));
  const colLabels = (density?.colLabels || VISUAL_GRID_COL_LABELS).toUpperCase();
  // 密度钳制：行用个位数字 0–9，故 rows 最大 10；列受字母表长度限制
  const cols = Math.max(
    2,
    Math.min(density?.cols ?? VISUAL_GRID_COLS, colLabels.length, 26),
  );
  const rows = Math.max(2, Math.min(density?.rows ?? VISUAL_GRID_ROWS, 10));
  return {
    cols,
    rows,
    colLabels: colLabels.slice(0, cols),
    imageWidth: w,
    imageHeight: h,
    // —— 网格长宽比例 ——
    // cellWidth  = 图宽 / 列数；cellHeight = 图高 / 行数
    // 例如 526×312、10×10 → cell ≈ 52.6 × 31.2 px
    cellWidth: w / cols,
    cellHeight: h / rows,
  };
}

/**
 * 解析 "C2" / "c2" / "C-2" → {col,row,id}；非法返回 null。
 * 仅接受当前 grid.colLabels 内的列字母 + 个位行号。
 */
export function parseGridId(
  raw: string,
  grid: GridConfig = buildGridConfig(1, 1),
): { col: number; row: number; id: string } | null {
  const s = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const m = s.match(/^([A-Z])(\d)$/);
  if (!m) return null;
  const col = grid.colLabels.indexOf(m[1]!);
  const row = Number(m[2]);
  if (col < 0 || col >= grid.cols) return null;
  if (!Number.isInteger(row) || row < 0 || row >= grid.rows) return null;
  return { col, row, id: `${m[1]}${row}` };
}

/**
 * 格号 → 原图中心像素（相对图左上角 0,0）。
 * x = (col + 0.5) * cellWidth
 * y = (row + 0.5) * cellHeight
 */
export function gridIdToCenter(
  gridId: string,
  grid: GridConfig,
): PixelPoint | null {
  const parsed = parseGridId(gridId, grid);
  if (!parsed) return null;
  return {
    x: (parsed.col + 0.5) * grid.cellWidth,
    y: (parsed.row + 0.5) * grid.cellHeight,
  };
}

/** 由列行生成格号 */
export function formatGridId(
  col: number,
  row: number,
  grid: GridConfig,
): string | null {
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
  const label = grid.colLabels[col];
  if (!label) return null;
  return `${label}${row}`;
}

/**
 * 邻格（切比雪夫距离 1…maxRing），由近到远；不含自身。
 * 用于空白格本地自愈，避免无状态复读同一错格。
 */
export function neighborGridIds(
  gridId: string,
  grid: GridConfig,
  maxRing = 2,
): string[] {
  const parsed = parseGridId(gridId, grid);
  if (!parsed) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let ring = 1; ring <= maxRing; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const id = formatGridId(parsed.col + dx, parsed.row + dy, grid);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/**
 * 同页离屏 Canvas 叠 Visual Grid（半透明线 + 高对比格号）。
 * 输出 JPEG Base64，供视觉 API；原图不动（墨迹吸附仍用 cleanB64）。
 */
export async function overlayGrid(
  page: Page,
  imageBuffer: Buffer,
  density?: GridDensityOptions,
): Promise<GridOverlayResult> {
  const inSize = readJpegSize(imageBuffer);
  if (!inSize) throw new Error("visual_grid: bad jpeg");
  const gridInfo = buildGridConfig(inSize.w, inSize.h, density);

  const outB64 = await page.evaluate(
    async ({
      b64,
      expectW,
      expectH,
      cols,
      rows,
      colLabels,
    }: {
      b64: string;
      expectW: number;
      expectH: number;
      cols: number;
      rows: number;
      colLabels: string;
    }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      const w = bitmap.width;
      const h = bitmap.height;
      if (w !== expectW || h !== expectH) {
        bitmap.close();
        throw new Error(`size drift ${w}x${h}`);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) {
        bitmap.close();
        throw new Error("no ctx");
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      // cellW/H：等分原图；后续调密度只改 cols/rows
      const cellW = w / cols;
      const cellH = h / rows;

      // 半透明细线（不遮挡主体笔画）
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255, 60, 60, 0.42)";
      for (let c = 0; c <= cols; c++) {
        const x = Math.min(w - 1, Math.round(c * cellW)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let r = 0; r <= rows; r++) {
        const y = Math.min(h - 1, Math.round(r * cellH)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // 格号：左上角高对比（黑底 + 亮字），抗噪点/背景融合
      const fontPx = Math.max(
        10,
        Math.min(13, Math.floor(Math.min(cellW, cellH) / 3.8)),
      );
      ctx.font = `bold ${fontPx}px monospace`;
      ctx.textBaseline = "top";
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const id = `${colLabels[c]}${r}`;
          const x = Math.round(c * cellW) + 2;
          const y = Math.round(r * cellH) + 2;
          const tw = fontPx * id.length * 0.62 + 4;
          const th = fontPx + 3;
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(x, y, tw, th);
          // 描边提升对比，避免被贯穿线/噪点淹没
          ctx.strokeStyle = "rgba(0,0,0,0.85)";
          ctx.lineWidth = 2;
          ctx.strokeText(id, x + 1, y + 1);
          ctx.fillStyle = "rgba(255, 245, 80, 0.95)";
          ctx.fillText(id, x + 1, y + 1);
        }
      }

      // 角标说明（提醒模型坐标系）
      const tag = `${cols}×${rows} ${colLabels[0]}-${colLabels[cols - 1]} / 0-${rows - 1}`;
      ctx.font = `bold ${Math.max(10, fontPx)}px monospace`;
      const tagW = ctx.measureText(tag).width;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(w - tagW - 10, h - fontPx - 8, tagW + 8, fontPx + 6);
      ctx.fillStyle = "rgba(255,220,80,0.95)";
      ctx.fillText(tag, w - tagW - 6, h - fontPx - 5);

      return canvas.toDataURL("image/jpeg", 0.92).split(",")[1]!;
    },
    {
      b64: imageBuffer.toString("base64"),
      expectW: inSize.w,
      expectH: inSize.h,
      cols: gridInfo.cols,
      rows: gridInfo.rows,
      colLabels: gridInfo.colLabels,
    },
  );

  const buf = Buffer.from(outB64, "base64");
  return {
    buf,
    b64: outB64,
    processedImageBase64: outB64,
    gridInfo,
    imageWidth: inSize.w,
    imageHeight: inSize.h,
  };
}
export { readJpegSize } from "./jpeg_size.js";
