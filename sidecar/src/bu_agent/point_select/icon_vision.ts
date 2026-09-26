/**
 * 图标识图增强：本地色块普查 + 送模前对比度/色度拉伸。
 * 淡色半透明星形对纯 VLM 几乎不可见；本地色差连通域不依赖模型。
 *
 * 米色斜纹底图会把「相对整图背景」掩码连成整片 → 改用局部对比度 + 自适应密度。
 */
import type { Page } from "playwright-core";
import type { GridConfig } from "./grid_overlay.js";
import { formatGridId } from "./grid_overlay.js";

export type ChromaBlob = {
  grid: string;
  cx: number;
  cy: number;
  area: number;
  meanChroma: number;
};

/**
 * 连通域原始组件（像素 bbox + 统计）。
 * 这是「局部对比掩码 + 连通域」的**唯一**来源：图标色块普查（→网格）与
 * SoM 动态标记（→自由框）都基于它派生，避免两处掩码口径漂移。
 */
export type BlobComponent = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  area: number;
  meanChroma: number;
  warmRatio: number;
  meanDev: number;
};

/**
 * 拉伸色度/对比度，让淡粉/淡绿星对 VLM 可见；输出 JPEG base64。
 */
export async function enhanceChromaContrast(
  page: Page,
  imageB64: string,
  strength = 2.2,
): Promise<string | null> {
  try {
    return await page.evaluate(
      async ({ b64, strength: s }: { b64: string; strength: number }) => {
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
          return null;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i]!;
          const g = d[i + 1]!;
          const b = d[i + 2]!;
          const mid = (r + g + b) / 3;
          let nr = mid + (r - mid) * s;
          let ng = mid + (g - mid) * s;
          let nb = mid + (b - mid) * s;
          nr = (nr - 128) * 1.15 + 128;
          ng = (ng - 128) * 1.15 + 128;
          nb = (nb - 128) * 1.15 + 128;
          d[i] = Math.max(0, Math.min(255, nr));
          d[i + 1] = Math.max(0, Math.min(255, ng));
          d[i + 2] = Math.max(0, Math.min(255, nb));
        }
        ctx.putImageData(img, 0, 0);
        return canvas.toDataURL("image/jpeg", 0.92).split(",")[1] ?? null;
      },
      { b64: imageB64, strength },
    );
  } catch {
    return null;
  }
}

/**
 * 局部对比连通域 → 网格。排除右侧大暖色卡通。
 */
export async function detectBlobComponents(
  page: Page,
  cleanB64: string,
  maxComponents = 120,
): Promise<BlobComponent[]> {
  try {
    return await page.evaluate(
      async ({ b64, maxN }: { b64: string; maxN: number }) => {
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
          return [] as Array<{
            x0: number;
            y0: number;
            x1: number;
            y1: number;
            cx: number;
            cy: number;
            area: number;
            meanChroma: number;
            warmRatio: number;
            meanDev: number;
          }>;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const data = ctx.getImageData(0, 0, w, h).data;
        const nPx = w * h;

        // 积分图加速局部均值（半径 r）
        const rCh = new Float64Array(nPx);
        const gCh = new Float64Array(nPx);
        const bCh = new Float64Array(nPx);
        const chroma = new Float32Array(nPx);
        for (let i = 0, p = 0; i < nPx; i++, p += 4) {
          const r0 = data[p]!;
          const g0 = data[p + 1]!;
          const b0 = data[p + 2]!;
          rCh[i] = r0;
          gCh[i] = g0;
          bCh[i] = b0;
          chroma[i] = Math.abs(r0 - g0) + Math.abs(g0 - b0) + Math.abs(b0 - r0);
        }

        const integ = (src: Float64Array | Float32Array) => {
          const out = new Float64Array((w + 1) * (h + 1));
          for (let y = 1; y <= h; y++) {
            let rowSum = 0;
            for (let x = 1; x <= w; x++) {
              rowSum += src[(y - 1) * w + (x - 1)]!;
              out[y * (w + 1) + x] = out[(y - 1) * (w + 1) + x]! + rowSum;
            }
          }
          return out;
        };
        const iR = integ(rCh);
        const iG = integ(gCh);
        const iB = integ(bCh);
        const iC = integ(chroma);
        const boxSum = (integArr: Float64Array, x0: number, y0: number, x1: number, y1: number) => {
          const W = w + 1;
          return (
            integArr[y1 * W + x1]! -
            integArr[y0 * W + x1]! -
            integArr[y1 * W + x0]! +
            integArr[y0 * W + x0]!
          );
        };

        const rad = Math.max(6, Math.round(Math.min(w, h) * 0.035));
        const localDev = new Float32Array(nPx);
        let devSum = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - rad);
            const y0 = Math.max(0, y - rad);
            const x1 = Math.min(w, x + rad + 1);
            const y1 = Math.min(h, y + rad + 1);
            const area = (x1 - x0) * (y1 - y0);
            const mr = boxSum(iR, x0, y0, x1, y1) / area;
            const mg = boxSum(iG, x0, y0, x1, y1) / area;
            const mb = boxSum(iB, x0, y0, x1, y1) / area;
            const mc = boxSum(iC, x0, y0, x1, y1) / area;
            const idx = y * w + x;
            const r0 = rCh[idx]!;
            const g0 = gCh[idx]!;
            const b0 = bCh[idx]!;
            const dist = Math.hypot(r0 - mr, g0 - mg, b0 - mb);
            const chBoost = Math.max(0, chroma[idx]! - mc);
            const score = dist + chBoost * 0.55;
            localDev[idx] = score;
            devSum += score;
          }
        }
        const meanDev = devSum / Math.max(1, nPx);
        // 百分位近似：抽样估阈值
        const sample: number[] = [];
        const step = Math.max(1, Math.floor(nPx / 4000));
        for (let i = 0; i < nPx; i += step) sample.push(localDev[i]!);
        sample.sort((a, b) => a - b);
        const pct = (p: number) => sample[Math.min(sample.length - 1, Math.floor(sample.length * p))] ?? meanDev;

        const buildMask = (floor: number) => {
          const mask = new Uint8Array(nPx);
          let on = 0;
          for (let i = 0; i < nPx; i++) {
            if (localDev[i]! >= floor) {
              mask[i] = 1;
              on += 1;
            }
          }
          return { mask, density: on / nPx };
        };

        // 目标密度约 1.5%~8%（图标+光晕）
        let floor = Math.max(meanDev * 1.35, pct(0.88));
        let { mask, density } = buildMask(floor);
        for (let i = 0; i < 6 && density > 0.1; i++) {
          floor = Math.max(floor * 1.12, pct(0.9 + i * 0.012));
          ({ mask, density } = buildMask(floor));
        }
        for (let i = 0; i < 4 && density < 0.01; i++) {
          floor *= 0.88;
          ({ mask, density } = buildMask(floor));
        }

        // 连通域
        const seen = new Uint8Array(nPx);
        const comps: Array<{
          x0: number;
          y0: number;
          x1: number;
          y1: number;
          cx: number;
          cy: number;
          area: number;
          meanChroma: number;
          warmRatio: number;
          meanDev: number;
        }> = [];
        const stackX: number[] = [];
        const stackY: number[] = [];
        const minArea = Math.max(28, Math.floor(nPx * 0.00025));
        const maxArea = Math.floor(nPx * 0.08);

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (!mask[idx] || seen[idx]) continue;
            stackX.length = 0;
            stackY.length = 0;
            stackX.push(x);
            stackY.push(y);
            seen[idx] = 1;
            let area = 0;
            let sumX = 0;
            let sumY = 0;
            let sumCh = 0;
            let sumDev = 0;
            let warmN = 0;
            let minX = w;
            let minY = h;
            let maxX = -1;
            let maxY = -1;
            while (stackX.length) {
              const cx0 = stackX.pop()!;
              const cy0 = stackY.pop()!;
              const ci = cy0 * w + cx0;
              area += 1;
              sumX += cx0;
              sumY += cy0;
              sumCh += chroma[ci]!;
              sumDev += localDev[ci]!;
              if (cx0 < minX) minX = cx0;
              if (cy0 < minY) minY = cy0;
              if (cx0 > maxX) maxX = cx0;
              if (cy0 > maxY) maxY = cy0;
              const r0 = rCh[ci]!;
              const g0 = gCh[ci]!;
              const b0 = bCh[ci]!;
              if (r0 > 160 && r0 > g0 + 20 && r0 > b0 + 20) warmN += 1;
              const nbs: Array<[number, number]> = [
                [cx0 + 1, cy0],
                [cx0 - 1, cy0],
                [cx0, cy0 + 1],
                [cx0, cy0 - 1],
              ];
              for (const [nx, ny] of nbs) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const ni = ny * w + nx;
                if (!mask[ni] || seen[ni]) continue;
                seen[ni] = 1;
                stackX.push(nx);
                stackY.push(ny);
              }
            }
            if (area < minArea || area > maxArea) continue;
            const cx = sumX / area;
            const cy = sumY / area;
            const warmRatio = warmN / area;
            if (cx >= w * 0.76 && warmRatio > 0.32 && area > 180) continue;
            comps.push({
              x0: minX,
              y0: minY,
              x1: maxX,
              y1: maxY,
              cx,
              cy,
              area,
              meanChroma: sumCh / area,
              warmRatio,
              meanDev: sumDev / area,
            });
          }
        }

        // 按显著度取前 N 个；网格去重（各格保留最优）与 SoM 合并都在 TS 侧做
        return comps
          .sort(
            (a, b) =>
              b.meanDev * Math.sqrt(b.area) - a.meanDev * Math.sqrt(a.area),
          )
          .slice(0, maxN);
      },
      { b64: cleanB64, maxN: maxComponents },
    );
  } catch {
    return [];
  }
}

/**
 * 局部对比连通域 → 网格（图标色块普查）。
 * 保留既有语义：同格只留显著度最高者，取前 10。
 */
export async function detectChromaBlobGrids(
  page: Page,
  cleanB64: string,
  grid: GridConfig,
): Promise<ChromaBlob[]> {
  const comps = await detectBlobComponents(page, cleanB64);
  const cellW = Math.max(1, grid.imageWidth) / grid.cols;
  const cellH = Math.max(1, grid.imageHeight) / grid.rows;
  const best = new Map<string, { c: BlobComponent; id: string; score: number }>();
  for (const c of comps) {
    const col = Math.min(
      grid.cols - 1,
      Math.max(0, Math.floor(c.cx / cellW)),
    );
    const row = Math.min(
      grid.rows - 1,
      Math.max(0, Math.floor(c.cy / cellH)),
    );
    const id = formatGridId(col, row, grid);
    if (!id) continue;
    const score = c.meanDev * Math.sqrt(c.area);
    const prev = best.get(id);
    if (!prev || score > prev.score) best.set(id, { c, id, score });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((e) => ({
      grid: e.id,
      cx: e.c.cx,
      cy: e.c.cy,
      area: e.c.area,
      meanChroma: e.c.meanChroma,
    }));
}

/**
 * 题干模板 ↔ 主图格：外形轮廓 Dice（忽略填色差异，适配深色题干图 vs 浅色主画布）。
 * 返回池内格按相似度降序。
 */
export async function rankGridsByTipSilhouette(
  page: Page,
  cleanB64: string,
  tipB64: string,
  grid: GridConfig,
  pool: string[],
): Promise<Array<{ grid: string; score: number }>> {
  if (!pool.length) return [];
  try {
    const raw = await page.evaluate(
      async ({
        mainB64,
        tipB64: tip,
        cols,
        rows,
        colLabels,
        poolIds,
      }: {
        mainB64: string;
        tipB64: string;
        cols: number;
        rows: number;
        colLabels: string;
        poolIds: string[];
      }) => {
        const decode = async (b64: string) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: "image/jpeg" });
          const bitmap = await createImageBitmap(blob);
          const c = document.createElement("canvas");
          c.width = bitmap.width;
          c.height = bitmap.height;
          const ctx = c.getContext("2d", { alpha: false, willReadFrequently: true });
          if (!ctx) {
            bitmap.close();
            return null;
          }
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data, canvas: c, ctx };
        };

        const SIZE = 32;
        const toMask = (
          data: Uint8ClampedArray,
          w: number,
          h: number,
          x0: number,
          y0: number,
          bw: number,
          bh: number,
        ) => {
          // 采样区域背景（边框）
          const border: number[] = [];
          const push = (x: number, y: number) => {
            const xi = Math.min(w - 1, Math.max(0, Math.floor(x)));
            const yi = Math.min(h - 1, Math.max(0, Math.floor(y)));
            const i = (yi * w + xi) * 4;
            border.push(data[i]!, data[i + 1]!, data[i + 2]!);
          };
          for (let t = 0; t < 8; t++) {
            const u = t / 7;
            push(x0 + u * bw, y0);
            push(x0 + u * bw, y0 + bh - 1);
            push(x0, y0 + u * bh);
            push(x0 + bw - 1, y0 + u * bh);
          }
          const med = (off: number) => {
            const arr = [];
            for (let i = off; i < border.length; i += 3) arr.push(border[i]!);
            arr.sort((a, b) => a - b);
            return arr[Math.floor(arr.length / 2)] ?? 128;
          };
          const br = med(0);
          const bg = med(1);
          const bb = med(2);
          const mask = new Uint8Array(SIZE * SIZE);
          for (let sy = 0; sy < SIZE; sy++) {
            for (let sx = 0; sx < SIZE; sx++) {
              const x = x0 + ((sx + 0.5) / SIZE) * bw;
              const y = y0 + ((sy + 0.5) / SIZE) * bh;
              const xi = Math.min(w - 1, Math.max(0, Math.floor(x)));
              const yi = Math.min(h - 1, Math.max(0, Math.floor(y)));
              const i = (yi * w + xi) * 4;
              const r = data[i]!;
              const g = data[i + 1]!;
              const b = data[i + 2]!;
              const dist = Math.hypot(r - br, g - bg, b - bb);
              const ch = Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
              mask[sy * SIZE + sx] = dist >= 18 || ch >= 24 ? 1 : 0;
            }
          }
          return mask;
        };

        const dice = (a: Uint8Array, b: Uint8Array) => {
          let inter = 0;
          let sa = 0;
          let sb = 0;
          for (let i = 0; i < a.length; i++) {
            const av = a[i]!;
            const bv = b[i]!;
            sa += av;
            sb += bv;
            inter += av & bv;
          }
          if (sa + sb === 0) return 0;
          return (2 * inter) / (sa + sb);
        };

        const tipImg = await decode(tip);
        const mainImg = await decode(mainB64);
        if (!tipImg || !mainImg) return [] as Array<{ id: string; score: number }>;

        const tipMask = toMask(tipImg.data, tipImg.w, tipImg.h, 0, 0, tipImg.w, tipImg.h);
        const tipOn = tipMask.reduce((s, v) => s + v, 0);
        if (tipOn < 8) return [] as Array<{ id: string; score: number }>;

        const cellW = mainImg.w / cols;
        const cellH = mainImg.h / rows;
        const scores: Array<{ id: string; score: number }> = [];

        for (const id of poolIds) {
          const col = colLabels.indexOf(id[0]!);
          const row = Number(id.slice(1));
          if (col < 0 || !Number.isFinite(row)) continue;
          const x0 = col * cellW;
          const y0 = row * cellH;
          const cellMask = toMask(mainImg.data, mainImg.w, mainImg.h, x0, y0, cellW, cellH);
          const score = dice(tipMask, cellMask);
          scores.push({ id, score });
        }
        scores.sort((a, b) => b.score - a.score);
        return scores;
      },
      {
        mainB64: cleanB64,
        tipB64,
        cols: grid.cols,
        rows: grid.rows,
        colLabels: grid.colLabels,
        poolIds: pool,
      },
    );
    return (raw ?? []).map((r) => ({ grid: r.id, score: r.score }));
  } catch {
    return [];
  }
}
