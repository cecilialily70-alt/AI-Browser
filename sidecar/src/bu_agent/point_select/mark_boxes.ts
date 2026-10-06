/**
 * Set-of-Mark (SoM) 动态标记：把连通域候选合并成「目标框」，编号后画在图上送 VLM。
 *
 * 与固定 Visual Grid 的本质区别：
 *  - 框由图像自适应产生，编号与目标**一一对应** → 「两个目标落进同一格」这类
 *    冲突从定义上不存在（旧路径只能靠 assertExclusiveGrids 判冲突后重绑/作废）；
 *  - 点击取真·框心，无「格心 → 格内质心」的量化误差；
 *  - VLM 只在闭集序号里做**分类**，不再做像素/比例**回归**。
 *
 * 图像处理仍走页内离屏 canvas，不引入 node-canvas 等原生依赖（打包体积敏感）。
 */
import type { Page } from "playwright-core";
import { readJpegSize } from "./jpeg_size.js";
import { detectBlobComponents, type BlobComponent } from "./icon_vision.js";

export type MarkBoxKind = "glyph" | "shape";

export type MarkBox = {
  /** 1..N，与标记图上画的序号严格一致 */
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 框心（图像像素空间）＝点击目标 */
  cx: number;
  cy: number;
  area: number;
  /** 显著度 = meanDev * sqrt(area)，用于排序与裁剪 */
  scale: number;
};

/** 合并容差：笔画/偏旁之间的缝隙。过大会把相邻目标并成一个 → 必须保守 */
export function mergeGapForSize(width: number, height: number): number {
  return Math.max(3, Math.min(8, Math.round(Math.min(width, height) * 0.02)));
}

function toBox(c: BlobComponent): MarkBox {
  return {
    id: 0,
    x0: c.x0,
    y0: c.y0,
    x1: c.x1,
    y1: c.y1,
    cx: c.cx,
    cy: c.cy,
    area: c.area,
    scale: c.meanDev * Math.sqrt(c.area),
  };
}

function unionBox(a: MarkBox, b: MarkBox): MarkBox {
  const area = a.area + b.area;
  return {
    id: 0,
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    cx: (a.cx * a.area + b.cx * b.area) / Math.max(1, area),
    cy: (a.cy * a.area + b.cy * b.area) / Math.max(1, area),
    area,
    scale: Math.max(a.scale, b.scale),
  };
}

/**
 * 单个连通域的形状门禁：剔除噪点、贯穿细线、整片底纹/插画。
 * glyph：复用 ink_check 的插画判据（暖色高占比且非笔画）。
 * shape：彩色目标本身常是暖色，绝不能用暖色拦。
 */
function shapeOk(
  c: BlobComponent,
  kind: MarkBoxKind,
  width: number,
  height: number,
): boolean {
  const bw = c.x1 - c.x0 + 1;
  const bh = c.y1 - c.y0 + 1;
  if (bw < 4 || bh < 6) return false; // 太小：噪点
  if (bw > width * 0.72 || bh > height * 0.72) return false; // 太大：底纹/卡通整片
  const fill = c.area / Math.max(1, bw * bh);
  const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
  const thinAspect = kind === "shape" ? 6.5 : 5;
  const thinFill = kind === "shape" ? 0.1 : 0.16;
  if (aspect >= thinAspect && fill < thinFill) return false; // 贯穿细线/竖直纹理
  if (kind === "glyph" && c.warmRatio > 0.34 && c.area > 160) return false; // 暖色插画非汉字
  return true;
}

/** 反复并框，直到不再有可并项（同一汉字的笔画/偏旁常被切成多块） */
export function mergeBoxes(boxes: MarkBox[], gap: number): MarkBox[] {
  let cur = boxes;
  for (let iter = 0; iter < 8; iter++) {
    const used = new Array<boolean>(cur.length).fill(false);
    const next: MarkBox[] = [];
    let merged = false;
    for (let i = 0; i < cur.length; i++) {
      if (used[i]) continue;
      let acc = cur[i]!;
      used[i] = true;
      for (let j = i + 1; j < cur.length; j++) {
        if (used[j]) continue;
        const b = cur[j]!;
        const touch =
          acc.x0 - gap <= b.x1 &&
          b.x0 - gap <= acc.x1 &&
          acc.y0 - gap <= b.y1 &&
          b.y0 - gap <= acc.y1;
        if (!touch) continue;
        acc = unionBox(acc, b);
        used[j] = true;
        merged = true;
      }
      next.push(acc);
    }
    cur = next;
    if (!merged) break;
  }
  return cur;
}

/**
 * 行主序编号：先按行分带（容差 = 框中位高 * 0.7），带内再按 x。
 * 用带号而非「y 差比较」保证排序可传递、结果确定。
 */
export function numberRowMajor(boxes: MarkBox[]): MarkBox[] {
  if (!boxes.length) return [];
  const heights = boxes.map((b) => b.y1 - b.y0 + 1).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 24;
  const band = Math.max(8, Math.round(median * 0.7));
  return boxes
    .slice()
    .sort((a, b) => {
      const ba = Math.floor(a.cy / band);
      const bb = Math.floor(b.cy / band);
      return ba !== bb ? ba - bb : a.cx - b.cx;
    })
    .map((b, i) => ({ ...b, id: i + 1 }));
}

/**
 * 剔除「明显不是目标」的超大块（卡通插画 / 大片底纹 / 光晕粘连）。
 *
 * 判据**自适应**：与其余框的面积中位数比较，而不是写死像素阈值（多站点泛用）。
 * 框数太少（<4）时不做相对剔除 —— 目标本身可能就很大，避免把唯一目标误杀。
 */
export function dropOversizedOutliers(boxes: MarkBox[]): MarkBox[] {
  if (boxes.length < 4) return boxes;
  const areas = boxes.map((b) => b.area).sort((a, b) => a - b);
  const median = areas[Math.floor(areas.length / 2)] ?? 0;
  if (median <= 0) return boxes;
  const limit = median * 4;
  const kept = boxes.filter((b) => b.area <= limit);
  // 全被剔除说明中位数被大块带偏，退回原集合（宁多勿错杀）
  return kept.length ? kept : boxes;
}

/**
 * 候选框检测：连通域 → 形状门禁 → 并框 → 剔除超大离群块 → 行主序编号。
 * 框数不足由调用方决定回退（本函数不猜、不补齐）。
 */
export async function detectMarkBoxes(input: {
  page: Page;
  cleanB64: string;
  kind: MarkBoxKind;
  maxBoxes?: number;
  /** 已知位图尺寸时传入，省一次头部解析 */
  width?: number;
  height?: number;
}): Promise<MarkBox[]> {
  const comps = await detectBlobComponents(input.page, input.cleanB64);
  if (!comps.length) return [];
  const size = readJpegSize(Buffer.from(input.cleanB64, "base64"));
  const width = input.width ?? size?.w ?? 0;
  const height = input.height ?? size?.h ?? 0;
  if (width <= 0 || height <= 0) return [];
  const gap = mergeGapForSize(width, height);
  const kept = comps
    .filter((c) => shapeOk(c, input.kind, width, height))
    .map(toBox);
  let boxes = mergeBoxes(kept, gap).filter((b) => {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    // 并框后仍不允许吞掉整幅图
    return bw < width * 0.9 && bh < height * 0.9 && b.area > 0;
  });
  boxes = dropOversizedOutliers(boxes);
  const max = Math.max(2, input.maxBoxes ?? 12);
  if (boxes.length > max) {
    boxes = boxes.slice().sort((a, b) => b.scale - a.scale).slice(0, max);
  }
  return numberRowMajor(boxes);
}

/**
 * 在图上画红框 + 大号序号，生成「标记图」。
 * 序号徽标默认放在框上方外侧，避免压住目标笔画；贴顶时改放框内左上角。
 */
export async function overlayMarkBoxes(input: {
  page: Page;
  imageBuf: Buffer;
  boxes: MarkBox[];
}): Promise<{ b64: string; imageWidth: number; imageHeight: number } | null> {
  const size = readJpegSize(input.imageBuf);
  if (!size) return null;
  const rects = input.boxes.map((b) => ({
    id: b.id,
    x0: b.x0,
    y0: b.y0,
    x1: b.x1,
    y1: b.y1,
  }));
  try {
    const b64 = await input.page.evaluate(
      async ({
        src,
        rects: boxes,
      }: {
        src: string;
        rects: Array<{ id: number; x0: number; y0: number; x1: number; y1: number }>;
      }) => {
        const bin = atob(src);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);
        const w = bitmap.width;
        const h = bitmap.height;
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

        const fontPx = Math.max(
          14,
          Math.min(30, Math.round(Math.min(w, h) * 0.05)),
        );
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255, 0, 0, 0.95)";
        ctx.font = `bold ${fontPx}px sans-serif`;
        ctx.textBaseline = "top";

        for (const b of boxes) {
          const x0 = Math.max(0, Math.min(w - 1, Math.round(b.x0)));
          const y0 = Math.max(0, Math.min(h - 1, Math.round(b.y0)));
          const x1 = Math.max(0, Math.min(w - 1, Math.round(b.x1)));
          const y1 = Math.max(0, Math.min(h - 1, Math.round(b.y1)));
          ctx.strokeRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));

          const label = String(b.id);
          const chipW = Math.round(fontPx * label.length * 0.66) + 8;
          const chipH = fontPx + 6;
          // 优先放框上方外侧；贴顶则放框内左上角
          const above = y0 - chipH - 2 >= 0;
          const cx0 = Math.max(0, Math.min(w - chipW, x0));
          const cy0 = above ? y0 - chipH - 2 : Math.max(0, y0 + 1);
          ctx.fillStyle = "rgba(220, 0, 0, 0.95)";
          ctx.fillRect(cx0, cy0, chipW, chipH);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, cx0 + 4, cy0 + 3);
        }
        return canvas.toDataURL("image/jpeg", 0.92).split(",")[1]!;
      },
      { src: input.imageBuf.toString("base64"), rects },
    );
    return { b64, imageWidth: size.w, imageHeight: size.h };
  } catch {
    return null;
  }
}
