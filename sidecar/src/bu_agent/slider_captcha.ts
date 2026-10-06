/**
 * 滑块缺口验证码（策略 slider_gap_drag）
 * 定位控件 → 像素/视觉求缺口 dx → 拟人拖拽 → 验收 → 毁图
 * 可选监听校验响应（协议观察，不改指纹）
 */
import type { Page } from "playwright-core";

import { createModelRouter, isIntentConfigured } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import type { JsonLogger } from "../json-logger.js";
import type { AgentFileSystem } from "./filesystem.js";
import {
  encodeBytesToJpegOnPage,
  fetchImageBuffer,
  freezePageForCapture,
  unfreezePageForCapture,
  waitCaptureSettle,
} from "./point_select/silent_capture.js";
import { openCvSliderGap } from "./opencv_preprocess.js";
import { SliderVisionSolver } from "./slider_vision_solver.js";
import { sleep, destroyPaths, classifyCaptchaOutcomeText } from "./captcha_utils.js";
import { captureScreenshot } from "../core/safe_screenshot.js";
import { createProtocolObserver } from "./point_select/verify.js";

export interface SliderSolveResult {
  ok: boolean;
  strategy: "slider_gap_drag" | "unsupported";
  gapX: number;
  dragDistance: number;
  confidence: number;
  method: string;
  verified: boolean | null;
  verifySignal: string;
  protocolHints: string[];
  artifactPaths: string[];
  detail?: string;
}

type SliderDomInfo = {
  ok: boolean;
  reason?: string;
  /** 底图视口盒 */
  image: { x: number; y: number; w: number; h: number } | null;
  /** 滑块手柄中心 */
  handle: { x: number; y: number; w: number; h: number } | null;
  /** 轨道盒（可滑动条，非文案节点） */
  track: { x: number; y: number; w: number; h: number } | null;
  /** 拼图块盒（独立覆盖在底图上的可拖小块，可能是独立 DOM 元素） */
  piece: { x: number; y: number; w: number; h: number } | null;
  /** 供像素分析：在页内标记的 data 属性选择器 */
  imageSelector: string;
  /** 拼图块元素的 data 属性选择器（供截图/取原图），未定位到时为空串 */
  pieceSelector: string;
  imgSrc: string;
  /** 拼图块原图 URL（带 Alpha 的 PNG 才有意义），非图片元素时为空串 */
  pieceSrc: string;
};

async function locateSliderDom(page: Page): Promise<SliderDomInfo> {
  return page.evaluate(() => {
    const ATTR = "data-cf-slider-target";
    const PIECE_ATTR = "data-cf-slider-piece";
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
    document.querySelectorAll(`[${PIECE_ATTR}]`).forEach((el) => el.removeAttribute(PIECE_ATTR));

    const box = (el: Element | null) => {
      if (!el) return null;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };

    const textBlob = (el: Element) =>
      `${el.id || ""} ${String((el as HTMLElement).className || "")} ${el.getAttribute("aria-label") || ""} ${(el as HTMLElement).innerText || ""}`.slice(
        0,
        240,
      );

    // 1) 底图：优先大面积横向图（排除 154×50 一类图标/装饰）。
    // 兼容三种渲染：<img> / <canvas> / CSS background-image（大量自定义滑块用 div 背景图，
    // 不存在 <img>/<canvas>，否则会误报 missing image）。
    const bgUrlOf = (el: Element): string => {
      try {
        const bi = window.getComputedStyle(el).backgroundImage;
        if (!bi || bi === "none") return "";
        const m = /url\(["']?(.*?)["']?\)/i.exec(bi);
        return m?.[1] ?? "";
      } catch {
        return "";
      }
    };

    const imgCands: Array<{ el: Element; src: string }> = [];
    for (const el of Array.from(document.querySelectorAll("img,canvas")) as Element[]) {
      const src =
        el instanceof HTMLImageElement
          ? String(el.currentSrc || el.src || "")
          : "";
      imgCands.push({ el, src });
    }
    for (const el of Array.from(
      document.querySelectorAll("div,section,span,li,a"),
    ) as HTMLElement[]) {
      const src = bgUrlOf(el);
      if (src) imgCands.push({ el, src });
    }

    let imgEl: Element | null = null;
    let imgSrcUrl = "";
    let bestImg = -1;
    for (const { el, src } of imgCands) {
      const r = el.getBoundingClientRect();
      if (r.width < 180 || r.height < 60) continue; // 拒绝过小「底图」
      if (r.bottom < 0 || r.top > innerHeight) continue;
      let score = r.width * r.height;
      const ratio = r.width / Math.max(1, r.height);
      if (ratio >= 1.2 && ratio <= 4.5) score *= 1.4;
      if (/captcha|slide|verify|gap|puzzle|match/i.test(src)) score *= 1.5;
      // 越靠近视口中部越好
      score *= 1 + Math.max(0, 1 - Math.abs(r.top + r.height / 2 - innerHeight / 2) / innerHeight);
      if (score > bestImg) {
        bestImg = score;
        imgEl = el;
        imgSrcUrl = src;
      }
    }

    // 2) 轨道：底图正下方、宽度接近底图的条；勿用仅含文案的窄 span
    let trackEl: HTMLElement | null = null;
    const imgBox = imgEl?.getBoundingClientRect();
    const candidates = Array.from(
      document.querySelectorAll("div,section,ul,li,p"),
    ) as HTMLElement[];
    let bestTrack = -1;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 18 || r.height > 90) continue;
      const t = textBlob(el);
      const hasHint = /请按住滑块|缓慢拖动|拖动到合适位置|slider|slide/i.test(t);
      let score = 0;
      if (hasHint) score += 80;
      if (imgBox) {
        const gap = r.top - imgBox.bottom;
        if (gap >= -4 && gap <= 80) score += 60 - Math.min(60, Math.abs(gap));
        const widthDiff = Math.abs(r.width - imgBox.width);
        if (widthDiff < imgBox.width * 0.35) score += 40;
        if (Math.abs(r.left - imgBox.left) < 40) score += 20;
      }
      // 惩罚：自身几乎只有文字、没有可拖子块
      const kids = el.querySelectorAll("div,span,button");
      if (kids.length === 0) score -= 30;
      if (score > bestTrack) {
        bestTrack = score;
        trackEl = el;
      }
    }

    // 回退：任意含提示文案的块
    if (!trackEl) {
      for (const el of candidates) {
        if (/请按住滑块|缓慢拖动到合适位置/i.test(textBlob(el))) {
          // 向上找更宽的父级作为轨道
          let cur: HTMLElement | null = el;
          for (let i = 0; i < 4 && cur; i++) {
            const r = cur.getBoundingClientRect();
            if (r.width >= 180 && r.height >= 24 && r.height <= 100) {
              trackEl = cur;
              break;
            }
            cur = cur.parentElement;
          }
          if (!trackEl) trackEl = el;
          break;
        }
      }
    }

    // 3) 手柄：轨道内最左侧、接近正方形的可拖块
    let handleEl: HTMLElement | null = null;
    if (trackEl) {
      const tr = trackEl.getBoundingClientRect();
      const kids = Array.from(
        trackEl.querySelectorAll("div,span,button,i,em,a"),
      ) as HTMLElement[];
      let bestH = -1;
      for (const el of kids) {
        const r = el.getBoundingClientRect();
        if (r.width < 12 || r.width > 72 || r.height < 12 || r.height > 72) continue;
        // 必须在轨道左 30%
        if (r.left > tr.left + tr.width * 0.3) continue;
        let score = 50 - (r.left - tr.left);
        if (/slider|btn|handle|thumb|drag|block|btn/i.test(textBlob(el))) score += 25;
        if (Math.abs(r.width - r.height) < 12) score += 15;
        if (score > bestH) {
          bestH = score;
          handleEl = el;
        }
      }
      if (!handleEl) {
        handleEl = (trackEl.querySelector("div,span,button") as HTMLElement | null) ?? null;
      }
    }

    if (!imgEl || !trackEl || !handleEl) {
      return {
        ok: false,
        reason: `missing image=${imgEl ? 1 : 0} track=${trackEl ? 1 : 0} handle=${handleEl ? 1 : 0}`,
        image: null,
        handle: null,
        track: null,
        piece: null,
        imageSelector: "",
        pieceSelector: "",
        imgSrc: "",
        pieceSrc: "",
      };
    }

    imgEl.setAttribute(ATTR, "1");
    const imageBox = box(imgEl as Element);
    const trackBox2 = box(trackEl as Element);
    const hb = box(handleEl as Element);

    // 4) 拼图块：独立覆盖在底图上的可拖小块。它通常不是底图的一部分（<img>/<canvas>/背景图），
    //    而是另一个绝对定位的 <img>/<div>，与手柄同步移动。仅从底图像素里「找拼图块」会臆造位置，
    //    导致 drag = gap - piece 整体偏移。这里优先从 DOM 语义 + 几何特征定位真实拼图块。
    let pieceEl: Element | null = null;
    if (imageBox && trackBox2 && hb) {
      const isPieceLike = (r: DOMRect): boolean => {
        if (r.width < 16 || r.height < 16) return false;
        // 接近正方形（拼图块常为方形小图）
        const ratio = r.width / Math.max(1, r.height);
        if (ratio < 0.6 || ratio > 1.6) return false;
        // 底图纵向范围内（拼图块浮在底图上，而非轨道里）
        const cy = r.top + r.height / 2;
        if (cy < imageBox.y - 8 || cy > imageBox.y + imageBox.h + 8) return false;
        // 不超底图太宽
        if (r.width > imageBox.w * 0.5) return false;
        return true;
      };
      const pieceCands: Array<{ el: Element; r: DOMRect; score: number }> = [];
      const walk = (root: ParentNode) => {
        for (const el of Array.from(root.querySelectorAll("img,canvas,div,span,i,em,button")) as Element[]) {
          if (el === imgEl) continue;
          if (el === handleEl) continue;
          const r = el.getBoundingClientRect();
          if (!isPieceLike(r)) continue;
          // 排除纯装饰图标（无图片内容、无背景图、且太薄）
          const bi = bgUrlOf(el);
          const isImg = el instanceof HTMLImageElement || el instanceof HTMLCanvasElement;
          if (!isImg && !bi && r.width * r.height < 2500) continue;
          let score = 0;
          if (isImg) score += 20;
          if (bi) score += 15;
          // 与手柄水平起点接近（拼图块与手柄 1:1 同步，初始都靠左）
          const hLeft = trackBox2.x;
          const px = r.x - hLeft;
          if (px >= -20 && px <= trackBox2.w * 0.6) score += 15;
          // 越像正方形越高
          const rr = r.width / Math.max(1, r.height);
          score += 10 - Math.min(10, Math.abs(rr - 1) * 8);
          // 文本/语义提示
          if (/piece|puzzle|block|slide|drag|verif|captcha/i.test(textBlob(el))) score += 10;
          // 排除手柄本身（在轨道内，纵向中心更低）
          if (r.top > trackBox2.y - 4) score -= 30;
          pieceCands.push({ el, r, score });
        }
      };
      walk(document);
      pieceCands.sort((a, b) => b.score - a.score);
      if (pieceCands.length > 0) {
        pieceEl = pieceCands[0]!.el;
      }
    }
    const pieceBox = pieceEl ? box(pieceEl) : null;
    // 拼图块若为独立图片资源（带 Alpha 的 PNG），标记后供上层取原图做
    // 「Alpha 轮廓 + Hu 矩」高精度识别；canvas/背景图类则不提供 src，上层自动降级。
    let pieceSrc = "";
    if (pieceEl) {
      pieceEl.setAttribute(PIECE_ATTR, "1");
      pieceSrc =
        pieceEl instanceof HTMLImageElement
          ? String(pieceEl.currentSrc || pieceEl.src || "")
          : bgUrlOf(pieceEl);
    }

    if (!imageBox || !trackBox2 || !hb) {
      return {
        ok: false,
        reason: "bbox_failed",
        image: null,
        handle: null,
        track: null,
        piece: null,
        imageSelector: "",
        pieceSelector: "",
        imgSrc: "",
        pieceSrc: "",
      };
    }
    const handleCenter = {
      x: hb.x + hb.w / 2,
      y: hb.y + hb.h / 2,
      w: hb.w,
      h: hb.h,
    };
    // 拼图块静止时的左缘（相对底图左缘）：供像素级缺口检测做「缺口必在拼图块右侧」的几何先验。
    // 通过属性传递，避免为页内函数增加参数与缩进改动。
    (imgEl as Element).setAttribute(
      "data-cf-piece-prior",
      String(Math.max(0, Math.round(hb.x - imageBox.x))),
    );
    // <img> 用 currentSrc/src；<canvas> 无 src；背景图 div 用已解析的 background url
    const imgSrc =
      imgEl instanceof HTMLImageElement
        ? String(imgEl.currentSrc || imgEl.src || "")
        : imgSrcUrl;

    return {
      ok: true,
      image: imageBox,
      handle: handleCenter,
      track: trackBox2,
      piece: pieceBox,
      imageSelector: `[${ATTR}="1"]`,
      pieceSelector: pieceEl ? `[${PIECE_ATTR}="1"]` : "",
      imgSrc,
      pieceSrc,
    };
  });
}

/** 页内 canvas：精确定位灰色拼图缺口左缘（排除彩色角色/涟漪噪点），并尝试定位拼图块左缘。 */
async function findGapByPixels(
  page: Page,
  imageSelector: string,
): Promise<{
  gapX: number;
  gapCenter: number;
  gapW: number;
  pieceX?: number;
  pieceW?: number;
  imageWidth: number;
  imageHeight: number;
  confidence: number;
  detail: string;
} | null> {
  return page.evaluate(async (sel) => {
    const target = document.querySelector(sel) as HTMLElement | null;
    if (!target || !target.isConnected) return null;
    /**
     * 「缺口必在拼图块右侧」的几何先验：拖拽距离恒为正，拼图块静止时位于手柄处。
     * 当站点把「拼图块」和「缺口」都画成平坦高对比色块时，纯几何外观无法区分二者，
     * 只能靠位置关系：与手柄静止位重合的平坦块多半是拼图块本身，不是缺口。
     */
    const pieceZone =
      (Number(target.getAttribute("data-cf-piece-prior") || "0") || 0) +
      Math.max(10, Math.round((target.getBoundingClientRect().width || 0) * 0.06));

    const disp = target.getBoundingClientRect();
    // 解析真实绘制源：<canvas>/<img> 直接画；CSS 背景图 div 需加载背景 URL。
    // 跨域未放行时 canvas 会被 taint，getImageData 失败 → 返回 null（降级给 OpenCV/视觉）。
    let drawSource: CanvasImageSource | null = null;
    let w = 0;
    let h = 0;
    if (target instanceof HTMLCanvasElement) {
      drawSource = target;
      w = target.width;
      h = target.height;
    } else if (target instanceof HTMLImageElement) {
      drawSource = target;
      w = target.naturalWidth || Math.floor(disp.width);
      h = target.naturalHeight || Math.floor(disp.height);
    } else {
      let bgUrl = "";
      try {
        const bi = window.getComputedStyle(target).backgroundImage;
        const m = /url\(["']?(.*?)["']?\)/i.exec(bi || "");
        bgUrl = m?.[1] ?? "";
      } catch {
        bgUrl = "";
      }
      if (!bgUrl) return null;
      try {
        drawSource = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error("bg load fail"));
          im.src = bgUrl;
        });
        w = (drawSource as HTMLImageElement).naturalWidth;
        h = (drawSource as HTMLImageElement).naturalHeight;
      } catch {
        return null;
      }
    }
    if (w < 40 || h < 20) return null;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    try {
      ctx.drawImage(drawSource, 0, 0, w, h);
    } catch {
      return null;
    }
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch {
      // 跨域 canvas 污染：无法读像素
      return null;
    }

    const at = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! };
    };
    const lumaOf = (p: { r: number; g: number; b: number }) =>
      0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
    const satOf = (p: { r: number; g: number; b: number }) => {
      const max = Math.max(p.r, p.g, p.b);
      const min = Math.min(p.r, p.g, p.b);
      return max === 0 ? 0 : (max - min) / max;
    };

    const cornerSamples: Array<{ luma: number; sat: number }> = [];
    for (const [cx, cy] of [
      [4, 4],
      [w - 5, 4],
      [4, h - 5],
      [Math.floor(w * 0.5), 4],
      [Math.floor(w * 0.25), 4],
      [Math.floor(w * 0.75), 4],
    ] as Array<[number, number]>) {
      const p = at(Math.max(0, Math.min(w - 1, cx)), Math.max(0, Math.min(h - 1, cy)));
      if (p.a > 20 && satOf(p) < 0.25) cornerSamples.push({ luma: lumaOf(p), sat: satOf(p) });
    }
    const bgLuma =
      cornerSamples.length > 0
        ? cornerSamples.reduce((a, b) => a + b.luma, 0) / cornerSamples.length
        : 210;
    /**
     * 背景相对中性容差：真正的「缺口/凹槽」与周围同色同饱和（灰、阴影、半透明暗区），
     * 而彩色装饰插画（吉祥物 / 图标 / logo）饱和度显著高于背景。
     * 以「背景自身饱和度」为基准 → 彩色照片底图（bgSat 高）不会误杀缺口，
     * 纯色低饱和底图上的彩色装饰则被排除；下限 0.12 保证灰阶底图不被误伤。
     */
    const bgSat =
      cornerSamples.length > 0
        ? cornerSamples.reduce((a, b) => a + b.sat, 0) / cornerSamples.length
        : 0;
    const satTol = Math.max(0.12, bgSat * 1.6);
    // 相对阈值：半透明灰缺口常在 bg-70~bg-25（如 bg≈240、缺口≈168），
    // 旧硬顶 luma<165 会把涟漪题缺口整段误杀。
    const gapDarkMax = Math.min(bgLuma - 18, bgLuma * 0.88);
    const gapDarkMin = Math.max(40, bgLuma * 0.35);
    // 浅色线框缺口：比背景更亮（白/浅色凹槽），上限防止把纯白高光噪点当缺口
    const gapLightMin = Math.min(255, bgLuma + 18);
    const gapLightMax = Math.min(255, bgLuma + 120);
    /**
     * 启用「中性实心块为主信号」的密度下限。
     * 单位 = 块与背景的平均亮度差 × 高度适配系数 × 1.2：达到该值说明画面中存在一段
     * 足够高、色差足够大的平坦中性区域，才判定为「实心占位缺口」；低于该值说明是
     * 彩色照片类底图（无实心占位块），退回原有「边缘主导」融合。
     * 必须声明在页内函数中——页面上下文取不到模块作用域常量。
     */
    const solidBlockMin = 6;

    const y0 = Math.floor(h * 0.1);
    const y1 = Math.floor(h * 0.9);
    const colDark = new Float64Array(w);
    const colLight = new Float64Array(w);
    const colEdge = new Float64Array(w);
    /** 中性实心块密度（平坦单色占位凹槽） */
    const colSolid = new Float64Array(w);
    /**
     * 站点无关的「矩形缺口」证据通道（不依赖任何配色假设）。
     * 滑块缺口在所有站点上的共同几何特征只有三条：
     *   ① 左右两条近似平行的竖直强边界；② 内部平坦（无纹理）；③ 与两侧背景有色差。
     * 底图是灰阶、纯色、渐变还是照片，都不影响这三条 —— 因此它是唯一可泛化的判据。
     * colEdgeRaw：原始灰度梯度密度（不做饱和度门控，彩色缺口同样有边界）
     * colFlat：局部平坦像素占比（缺口内部无纹理）
     * colDevRaw：与左右远端背景的平均色差（缺口相对背景「有反差」）
     */
    const colEdgeRaw = new Float64Array(w);
    const colFlat = new Float64Array(w);
    const colDevRaw = new Float64Array(w);
    /**
     * 各列的平均亮度：用于校验「矩形内部颜色是否均匀」。
     * 真实缺口是一整块同色区域 → 内部各列均值几乎相同；
     * 若把两条不相干的强边界（如缺口左缘 + 装饰物左缘）配成一对，内部会同时含
     * 「缺口色 + 背景色」两种颜色 → 列均值方差很大，据此排除。
     */
    const colMean = new Float64Array(w);

    // 逐列计算「水平灰度梯度」（颜色无关）。拼图块与缺口的左右边界（阴影/线框/拼图切线）
    // 都会在灰度上形成强梯度，是彩色照片类验证码上唯一稳定可用的特征。
    // 旧实现按饱和度过滤像素，导致彩色底图上 colDark/colLight/colEdge 全为 0（检测完全失效）。
    const grad = new Float64Array(w);
    for (let x = 1; x < w - 1; x++) {
      let gSum = 0;
      let gN = 0;
      let darkN = 0;
      let darkSum = 0;
      let lightN = 0;
      let lightSum = 0;
      let bestDarkRun = 0;
      let darkRun = 0;
      let bestLightRun = 0;
      let lightRun = 0;
      let solidN = 0;
      let solidSum = 0;
      let bestSolidRun = 0;
      let solidRun = 0;
      let rawGSum = 0;
      let rawGN = 0;
      let flatN = 0;
      let devSum = 0;
      let lumaSum = 0;
      // 远端背景采样距离：略大于常见缺口宽度（0.05~0.2w），确保取到缺口之外的背景
      const kx = Math.max(8, Math.round(w * 0.16));
      for (let y = y0; y < y1; y++) {
        const p = at(x, y);
        if (p.a < 20) {
          darkRun = 0;
          lightRun = 0;
          solidRun = 0;
          continue;
        }
        const luma = lumaOf(p);
        // 中性门控：缺口与背景同饱和；彩色装饰插画的边缘/色块在这里被排除，
        // 避免高对比吉祥物/图标靠「边缘密度」压过真正的缺口。
        const neutral = satOf(p) <= satTol;
        // 灰度水平梯度（Sobel-like，颜色无关）
        const gl = lumaOf(at(x - 1, y));
        const gr = lumaOf(at(x + 1, y));
        const g = Math.abs(gr - gl);
        if (g > 18 && neutral) {
          gSum += g;
          gN += 1;
        }
        // —— 通用矩形缺口证据（颜色/站点无关）——
        lumaSum += luma;
        if (g > 18) {
          rawGSum += g;
          rawGN += 1;
        }
        {
          const nL = lumaOf(at(Math.max(0, x - 1), y));
          const nR = lumaOf(at(Math.min(w - 1, x + 1), y));
          const nU = lumaOf(at(x, Math.max(0, y - 1)));
          const nD = lumaOf(at(x, Math.min(h - 1, y + 1)));
          const lo = Math.min(luma, nL, nR, nU, nD);
          const hi = Math.max(luma, nL, nR, nU, nD);
          if (hi - lo < 12) flatN += 1;
        }
        {
          const farL = lumaOf(at(Math.max(0, x - kx), y));
          const farR = lumaOf(at(Math.min(w - 1, x + kx), y));
          devSum += Math.abs(luma - (farL + farR) / 2);
        }
        // 深色块（拼图块阴影/深色缺口）
        if (neutral && luma <= gapDarkMax && luma >= gapDarkMin && luma < bgLuma - 18) {
          darkRun += 1;
          bestDarkRun = Math.max(bestDarkRun, darkRun);
          darkSum += bgLuma - luma;
          darkN += 1;
        } else {
          darkRun = 0;
        }
        // 浅色块（浅色线框缺口）
        if (neutral && luma >= gapLightMin && luma <= gapLightMax) {
          lightRun += 1;
          bestLightRun = Math.max(bestLightRun, lightRun);
          lightSum += luma - bgLuma;
          lightN += 1;
        } else {
          lightRun = 0;
        }
        // 实心中性块：缺口常被渲染成「平坦单色占位块」（灰块/半透明暗块）。
        // 中性 + 3×3 局部平坦（无纹理）+ 与背景有色差 —— 这是本类自定义滑块缺口
        // 最强的确定性证据，也是与「彩色插画」最本质的区别（插画内部纹理丰富）。
        if (neutral && luma < gapDarkMax && luma > gapDarkMin) {
          let nMin = 999;
          let nMax = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const l2 = lumaOf(at(x, Math.max(0, Math.min(h - 1, y + dy))));
            if (l2 < nMin) nMin = l2;
            if (l2 > nMax) nMax = l2;
          }
          if (nMax - nMin < 8) {
            solidRun += 1;
            bestSolidRun = Math.max(bestSolidRun, solidRun);
            solidSum += bgLuma - luma;
            solidN += 1;
            continue;
          }
        }
        solidRun = 0;
      }
      const heightFitOf = (bestRun: number): number => {
        const hRatio = bestRun / Math.max(1, h);
        if (hRatio >= 0.15 && hRatio <= 0.85) return 1;
        if (hRatio >= 0.08 && hRatio < 0.15) return 0.5;
        return 0;
      };
      const avgDark = darkN > 0 ? darkSum / darkN : 0;
      const avgLight = lightN > 0 ? lightSum / lightN : 0;
      const avgSolid = solidN > 0 ? solidSum / solidN : 0;
      colDark[x] = Math.max(0, avgDark * heightFitOf(bestDarkRun) * 1.2);
      colLight[x] = Math.max(0, avgLight * heightFitOf(bestLightRun) * 1.2);
      colSolid[x] = Math.max(0, avgSolid * heightFitOf(bestSolidRun) * 1.2);
      const edgeAvg = gN > 0 ? gSum / Math.max(1, y1 - y0) : 0;
      const edgeFit = gN / Math.max(1, y1 - y0);
      grad[x] = edgeAvg * (edgeFit >= 0.08 ? 1 : edgeFit >= 0.04 ? 0.5 : 0);
      const span = Math.max(1, y1 - y0);
      colEdgeRaw[x] = rawGN > 0 ? (rawGSum / span) * (rawGN / span >= 0.1 ? 1 : 0.5) : 0;
      colFlat[x] = flatN / span;
      colDevRaw[x] = devSum / span;
      colMean[x] = lumaSum / span;
    }
    colEdge.set(grad);

    const smoothCol = (src: Float64Array): Float64Array => {
      const out = new Float64Array(w);
      const rad = Math.max(2, Math.floor(w * 0.01));
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let c = 0;
        for (let k = -rad; k <= rad; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          sum += src[xx]!;
          c += 1;
        }
        out[x] = c ? sum / c : 0;
      }
      return out;
    };
    const smoothDark = smoothCol(colDark);
    const smoothLight = smoothCol(colLight);
    const smoothEdge = smoothCol(colEdge);
    const smoothSolid = smoothCol(colSolid);
    // 融合：边缘梯度（颜色无关）+ 明/暗块密度（辅助）+ 中性实心块（结构性主信号）。
    // 彩色照片题无实心占位块 → 走原有权重，靠边缘定位；一旦检出显著的平坦中性块，
    // 它才是缺口的确定性证据，权重转为以它为主，防止高对比装饰物靠边缘密度夺位。
    const smooth = new Float64Array(w);
    let maxD = 0;
    let maxL = 0;
    let maxE = 0;
    let maxS = 0;
    for (let x = 0; x < w; x++) {
      maxD = Math.max(maxD, smoothDark[x]!);
      maxL = Math.max(maxL, smoothLight[x]!);
      maxE = Math.max(maxE, smoothEdge[x]!);
      maxS = Math.max(maxS, smoothSolid[x]!);
    }
    const solidSignificant = maxS >= solidBlockMin;
    for (let x = 0; x < w; x++) {
      const d = maxD > 0 ? smoothDark[x]! / maxD : 0;
      const l = maxL > 0 ? smoothLight[x]! / maxL : 0;
      const e = maxE > 0 ? smoothEdge[x]! / maxE : 0;
      const s = solidSignificant && maxS > 0 ? smoothSolid[x]! / maxS : 0;
      smooth[x] = solidSignificant
        ? s * 0.5 + e * 0.22 + Math.max(d, l) * 0.28
        : e * 0.6 + Math.max(d, l) * 0.4;
    }

    const xStart = Math.floor(w * 0.04);
    const xEnd = Math.floor(w * 0.92);
    const expectedW = Math.max(24, Math.floor(w * 0.12));
    let bestLeft = xStart;
    let bestRight = xStart + expectedW;
    let bestIntegral = -1;
    const winMin = Math.max(16, Math.floor(w * 0.07));
    const winMax = Math.min(Math.floor(w * 0.3), xEnd - xStart);
    for (let win = winMin; win <= winMax; win += 2) {
      let acc = 0;
      for (let x = xStart; x < xStart + win && x < xEnd; x++) acc += smooth[x]!;
      for (let left = xStart; left + win <= xEnd; left++) {
        if (left > xStart) {
          acc -= smooth[left - 1]!;
          acc += smooth[left + win - 1]!;
        }
        const wFit = 1 - Math.min(1, Math.abs(win - expectedW) / expectedW);
        const score = acc * (0.65 + 0.35 * wFit);
        if (score > bestIntegral) {
          bestIntegral = score;
          bestLeft = left;
          bestRight = left + win;
        }
      }
    }

    // 提取所有显著块（连续 smooth≥阈值 的区间），用于区分「拼图块(左)」与「缺口(右)」。
    // 拼图块与缺口各有明显边界（阴影/线框/拼图切线），在边缘加权信号上各成一块。
    const blockThresh = 0.12;
    const blocks: Array<{ left: number; right: number; strength: number }> = [];
    {
      let i = xStart;
      while (i < xEnd) {
        if (smooth[i]! < blockThresh) {
          i += 1;
          continue;
        }
        let j = i;
        while (j < xEnd && smooth[j]! >= blockThresh) j += 1;
        let strength = 0;
        for (let x = i; x < j; x++) strength += smooth[x]!;
        if (j - i >= winMin * 0.5) blocks.push({ left: i, right: j, strength });
        i = j + 1;
      }
    }
    blocks.sort((a, b) => a.left - b.left);

    let pieceX: number | undefined;
    let pieceW: number | undefined;
    let left: number;
    let gapCenter: number;
    let gapW: number;

    let ambiguous = false;
    if (blocks.length >= 2) {
      // 左块=拼图块，右块=缺口（拼图类验证码拼图块总在缺口左侧）
      const pieceBlk = blocks[0]!;
      const gapBlk = blocks[blocks.length - 1]!;
      pieceX = pieceBlk.left;
      pieceW = pieceBlk.right - pieceBlk.left;
      left = gapBlk.left;
      gapW = gapBlk.right - gapBlk.left;
      gapCenter = Math.floor((gapBlk.left + gapBlk.right) / 2);
    } else if (blocks.length === 1) {
      // 单块：无法区分是拼图块还是缺口，标记为歧义（低置信，交给视觉裁决）
      ambiguous = true;
      left = blocks[0]!.left;
      gapW = blocks[0]!.right - blocks[0]!.left;
      gapCenter = Math.floor((blocks[0]!.left + blocks[0]!.right) / 2);
    } else {
      // 无块：退化为滑窗积分（取最强窗）
      ambiguous = true;
      const win = bestRight - bestLeft;
      gapW = Math.max(1, win);
      gapCenter = Math.floor((bestLeft + bestRight) / 2);
      let m = 0;
      for (let x = bestLeft; x < bestRight; x++) m += smooth[x]!;
      m /= gapW;
      const thresh = m * 0.4;
      left = gapCenter;
      while (left > xStart && smooth[left]! >= thresh) left -= 1;
      left = Math.min(w - 2, Math.max(0, left + 1));
    }

    // 用明/暗块通道、实心块通道与边缘的绝对峰值辅助置信度
    const darkPeak = smoothDark[gapCenter] ?? 0;
    const lightPeak = smoothLight[gapCenter] ?? 0;
    const edgePeak = smoothEdge[gapCenter] ?? 0;
    const solidPeak = smoothSolid[gapCenter] ?? 0;
    const blockPeak = Math.max(darkPeak, lightPeak, solidPeak);
    const peakV = smooth[gapCenter] ?? 0;
    let confidence = 0.28;
    if (peakV > 0.25 && gapW >= winMin && gapW <= winMax) {
      confidence = Math.min(
        0.96,
        0.48 + peakV * 0.35 + Math.min(blockPeak, 40) / 120 + Math.min(edgePeak, 30) / 100,
      );
    }
    if (left < w * 0.05 || left > w * 0.85) confidence *= 0.7;
    // 找到拼图块与缺口两个分离块 = 结构性证据，大幅加分
    if (blocks.length >= 2) confidence = Math.min(0.96, confidence + 0.15);
    // 单块/无块通常是「拼图块未被检出」（画布内镂空/边框，或被 xStart 裁掉），
    // 而非信号不可靠 —— 只要该块有实心中性结构支撑，它就是确定性缺口，不降置信；
    // 否则压到低置信，交给视觉裁决。
    if (ambiguous) confidence = Math.min(confidence, solidSignificant ? 0.9 : 0.32);

    // ——— 通用「矩形缺口」裁决（站点 / 配色无关）———
    // 穷举「左边界 × 宽度」，用前缀和 O(1) 取区间均值，找同时满足
    // 「左右边界够强 + 内部够平 + 与两侧背景色差够大」的矩形。适用于
    // 灰阶缺口、彩色/深色缺口、浅色凹槽、照片底图等一切滑块类型。
    const smoothEdgeRaw = smoothCol(colEdgeRaw);
    const smoothFlat = smoothCol(colFlat);
    const smoothDev = smoothCol(colDevRaw);
    const smoothMean = smoothCol(colMean);
    let maxEdgeRaw = 0;
    let maxDev = 0;
    for (let x = 0; x < w; x++) {
      maxEdgeRaw = Math.max(maxEdgeRaw, smoothEdgeRaw[x]!);
      maxDev = Math.max(maxDev, smoothDev[x]!);
    }
    const preFlat = new Float64Array(w + 1);
    const preDev = new Float64Array(w + 1);
    const preM = new Float64Array(w + 1);
    const preM2 = new Float64Array(w + 1);
    for (let x = 0; x < w; x++) {
      preFlat[x + 1] = preFlat[x]! + smoothFlat[x]!;
      preDev[x + 1] = preDev[x]! + smoothDev[x]!;
      preM[x + 1] = preM[x]! + smoothMean[x]!;
      preM2[x + 1] = preM2[x]! + smoothMean[x]! * smoothMean[x]!;
    }
    const meanIn = (pre: Float64Array, a: number, b: number): number =>
      b > a ? (pre[b]! - pre[a]!) / (b - a) : 0;
    const gwMin = Math.max(12, Math.floor(w * 0.05));
    const gwMax = Math.max(gwMin + 4, Math.floor(w * 0.22));
    const rect = { x: 0, gw: 0, score: 0, border: 0, flat: 0, dev: 0, uniform: 0 };
    for (let gw = gwMin; gw <= gwMax; gw += 2) {
      for (let x1 = xStart; x1 + gw < xEnd; x1++) {
        const x2 = x1 + gw;
        const border =
          (smoothEdgeRaw[x1]! + smoothEdgeRaw[x2]!) / 2 / (maxEdgeRaw || 1);
        if (border < 0.3) continue;
        const flat = meanIn(preFlat, x1, x2);
        if (flat < 0.2) continue;
        // 「相对平滑优势」：缺口内部应比左右两侧背景更平滑。
        // 用相对量而非绝对平坦度 → 照片/噪点底图同样成立（半透明缺口叠在纹理上仍比原始纹理平滑）；
        // 彩色插画/吉祥物内部纹理丰富，两侧背景反而更平整 → 优势为负，被自然排除。
        const flankA = meanIn(preFlat, Math.max(xStart, x1 - gw), x1);
        const flankB = meanIn(preFlat, x2, Math.min(xEnd, x2 + gw));
        const flatOut = (flankA + flankB) / 2;
        const smoothAdv = Math.max(0, Math.min(1, (flat - flatOut) / 0.25 + 0.5));
        // 色差用「图像自身最强反差」的 55% 作为饱和参考，避免被单个极高反差区域压扁
        const devRef = Math.max(18, maxDev * 0.55);
        const dev = Math.min(1, meanIn(preDev, x1, x2) / devRef);
        // 内部颜色均匀性：真实缺口是一整块同色区，各列均值方差极小；
        // 「缺口左缘 + 装饰物左缘」这类不相干配对内部含两种颜色，方差大 → 被排除。
        const nIn = Math.max(1, x2 - x1);
        const meanIn2 = (preM[x2]! - preM[x1]!) / nIn;
        const varIn = Math.max(0, (preM2[x2]! - preM2[x1]!) / nIn - meanIn2 * meanIn2);
        const uniform = Math.max(0, Math.min(1, 1 - Math.sqrt(varIn) / 28));
        let score = border * smoothAdv * dev * uniform;
        // 与手柄静止位重合 → 多半是「拼图块」而非缺口（二者外观相同时唯一的区分依据）。
        // 软惩罚而非硬排除：若全图只有这一个块，它仍可能被选中做兜底。
        if (x1 <= pieceZone) score *= 0.5;
        if (score > rect.score) {
          rect.x = x1;
          rect.gw = gw;
          rect.score = score;
          rect.border = border;
          rect.flat = smoothAdv;
          rect.dev = dev;
          rect.uniform = uniform;
        }
      }
    }
    // 矩形通道是几何证据（平行边界 + 平坦内部 + 色差），比任何单像素密度启发式更可靠，
    // 达到阈值即以它为准；否则保留上面的列密度结论作为兜底。
    const rectAccepted = rect.score >= 0.3;
    if (rectAccepted) {
      left = rect.x;
      gapW = rect.gw;
      gapCenter = rect.x + Math.floor(rect.gw / 2);
      confidence = Math.min(0.95, 0.5 + rect.score * 0.5);
      // 矩形通道只声明「缺口在哪」，不声明「拼图块在哪」——若沿用上面块启发式给的
      // pieceX，会在 Node 侧被当成真实拼图块而做 gap−piece 相减，反而引入偏移。
      // 置空后由手柄几何先验 / DOM 拼图块接管，这正是已验证正确的路径。
      pieceX = undefined;
      pieceW = undefined;
    }

    return {
      gapX: left,
      gapCenter,
      gapW,
      pieceX,
      pieceW,
      imageWidth: w,
      imageHeight: h,
      confidence,
      detail: `left=${left} center=${gapCenter} gapW=${gapW} peak=${peakV.toFixed(2)} dark=${darkPeak.toFixed(1)} light=${lightPeak.toFixed(1)} edge=${edgePeak.toFixed(1)} solid=${solidPeak.toFixed(1)} bg=${bgLuma.toFixed(0)} bgSat=${bgSat.toFixed(2)} satTol=${satTol.toFixed(2)} solidOn=${solidSignificant ? 1 : 0} blocks=${blocks.length} rect=${rectAccepted ? 1 : 0}@${rect.score.toFixed(2)}(b=${rect.border.toFixed(2)},f=${rect.flat.toFixed(2)},d=${rect.dev.toFixed(2)},u=${rect.uniform.toFixed(2)})`,
    };
  }, imageSelector);
}

type SliderClip = { x: number; y: number; width: number; height: number };

function clipFromImageBox(imageBox: { x: number; y: number; w: number; h: number }): SliderClip {
  return {
    x: Math.max(0, Math.floor(imageBox.x)),
    y: Math.max(0, Math.floor(imageBox.y)),
    width: Math.max(1, Math.floor(imageBox.w)),
    height: Math.max(1, Math.floor(imageBox.h)),
  };
}

/**
 * 静默采元素图（优先原图 / 离屏 canvas，仅失败才截图防闪）。
 * 底图与拼图块共用本函数：底图走 JPEG（体积小），拼图块需 preserveAlpha 走 PNG
 * 并原样保留 Alpha 通道（转码/截图都会摧毁透明层，导致轮廓与面积提取失效）。
 */
async function captureElementImage(input: {
  page: Page;
  box: { x: number; y: number; w: number; h: number };
  selector?: string;
  src?: string;
  /** 保留 Alpha（拼图块）：用 PNG 编码，且不做截图兜底 */
  preserveAlpha?: boolean;
}): Promise<{ buf: Buffer; clip: SliderClip } | null> {
  const clip = clipFromImageBox(input.box);
  const keepAlpha = input.preserveAlpha === true;
  let buf: Buffer | null = null;
  if (input.src) {
    try {
      const raw = await fetchImageBuffer(input.page, input.src);
      if (raw) {
        if (keepAlpha) {
          // 原样透传：任何重编码都会丢掉 Alpha 通道
          buf = raw;
        } else {
          const enc = await encodeBytesToJpegOnPage(input.page, raw, clip.width, clip.height);
          if (enc?.b64) buf = Buffer.from(enc.b64, "base64");
        }
      }
    } catch {
      /* fall through */
    }
  }
  if (!buf && input.selector) {
    try {
      const dataUrl = await input.page.evaluate(
        async (args: { sel: string; alpha: boolean }) => {
          const el = document.querySelector(args.sel) as
            | HTMLImageElement
            | HTMLCanvasElement
            | null;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const w = Math.max(1, Math.round(r.width));
          const h = Math.max(1, Math.round(r.height));
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d");
          if (!ctx) return null;
          try {
            ctx.drawImage(el as CanvasImageSource, 0, 0, w, h);
            return c.toDataURL(args.alpha ? "image/png" : "image/jpeg", 0.92);
          } catch {
            return null;
          }
        },
        { sel: input.selector, alpha: keepAlpha },
      );
      if (dataUrl && dataUrl.includes(",")) {
        buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      }
    } catch {
      /* fall through */
    }
  }
  // 截图只能产出 JPEG（无 Alpha），对拼图块毫无意义 → 直接放弃交由调用方降级
  if (!buf && !keepAlpha) {
    await freezePageForCapture(input.page);
    try {
      await waitCaptureSettle();
      buf = await captureScreenshot(input.page, {
        type: "jpeg",
        quality: 92,
        clip,
        scale: "css",
        animations: "disabled",
        caret: "hide",
      });
    } finally {
      await unfreezePageForCapture(input.page);
    }
  }
  return buf ? { buf, clip } : null;
}

/** 视觉模型：同时识别「拼图块」与「缺口」，返回两者左缘（关键：拖距 = gapX - pieceX）。 */
async function gapByVisionFromBuffer(input: {
  buf: Buffer;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
  clip: SliderClip;
}): Promise<{
  gapX: number;
  gapCenter?: number;
  pieceX?: number;
  pieceW?: number;
  gapW?: number;
  imageWidth: number;
  confidence: number;
  path?: string;
} | null> {
  if (!isIntentConfigured(createModelRouter(input.aiSettings).pool, "vision")) {
    return null;
  }
  let path: string | undefined;
  if (input.fileSystem) {
    path = input.fileSystem.writeBinaryFile(`captcha_slider_${Date.now()}.jpg`, input.buf);
  }
  const b64 = input.buf.toString("base64");
  const router = createModelRouter(input.aiSettings);
  const { route, client } = router.forIntent("vision", "滑块缺口定位");
  try {
    const resp = await client.chat.completions.create(
      {
        model: route.model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "这是滑块拼图验证码的底图。请找出图中两个物体，并分别给出它们左缘到图像左边缘的像素距离：" +
                  "①「拼图块」= 实心、内部有完整图像内容、边缘清晰的一块（常带阴影、比周围略暗），它会被用户拖动。" +
                  "②「缺口」= 拼图块要嵌入的目标凹槽，是被挖空/镂空的区域（比周围更暗的阴影凹槽，或比周围更亮的浅色线框），内部通常没有完整的图像内容。" +
                  "通常缺口在拼图块的右侧。忽略底部滑轨与装饰元素。" +
                  `本图显示宽约 ${input.clip.width}px。` +
                  "只输出一行 JSON：{\"pieceX\":40,\"gapX\":180,\"pieceW\":50,\"gapW\":50,\"imageWidth\":300,\"confidence\":0.8}。" +
                  "pieceX=拼图块左缘x；gapX=缺口左缘x；pieceW=拼图块宽；gapW=缺口宽；imageWidth=图宽像素；confidence=0~1。" +
                  "即使不确定也必须给出最可能的值（禁止输出 0 或省略字段）。禁止思考。",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
              },
            ],
          },
        ],
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    const raw = String(resp.choices?.[0]?.message?.content ?? "").trim();
    let obj: Record<string, unknown> | null = null;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        obj = null;
      }
    }

    let imageWidth = Number(obj?.imageWidth ?? input.clip.width);
    if (!Number.isFinite(imageWidth) || imageWidth <= 0) imageWidth = input.clip.width;
    const rescale = (v: number): number => {
      if (Number.isFinite(v) && v > 0 && v <= 1.5) return v * imageWidth;
      return v;
    };
    let gapX = rescale(Number(obj?.gapX ?? obj?.x ?? 0));
    let gapCenter = rescale(Number(obj?.gapCenter ?? obj?.centerX ?? 0));
    let pieceX = rescale(Number(obj?.pieceX ?? 0));
    let pieceW = rescale(Number(obj?.pieceW ?? 0));
    let gapW = rescale(Number(obj?.gapW ?? 0));
    let confidence = Number(obj?.confidence ?? 0.6);

    // 模型拒绝/未返回 JSON 时，从自由文本里按「图宽 10%~92%」区间捞数值，
    // 两个数通常分别对应拼图块与缺口（左小右大）。
    if (!Number.isFinite(gapX) || gapX <= 0) {
      const nums = (raw.match(/-?\d{2,4}/g) ?? [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= imageWidth * 0.1 && n <= imageWidth * 0.92)
        .sort((a, b) => a - b);
      if (nums.length >= 2) {
        pieceX = nums[0]!;
        gapX = nums[1]!;
        confidence = 0.45;
      } else if (nums.length === 1) {
        gapX = nums[0]!;
        confidence = 0.4;
      }
    }
    if (!Number.isFinite(gapX) || gapX <= 0) {
      return path ? { gapX: 0, imageWidth, confidence: 0, path } : null;
    }
    if (!Number.isFinite(confidence)) confidence = 0.6;
    // 若模型 imageWidth 与裁剪宽差太大，按显示宽重标定
    if (Math.abs(imageWidth - input.clip.width) > input.clip.width * 0.25) {
      const k = input.clip.width / imageWidth;
      gapX *= k;
      gapCenter *= k;
      pieceX *= k;
      pieceW *= k;
      gapW *= k;
      imageWidth = input.clip.width;
    }

    const out = {
      gapX: Math.floor(gapX),
      gapCenter: Number.isFinite(gapCenter) && gapCenter > 0 ? Math.floor(gapCenter) : undefined,
      pieceX: Number.isFinite(pieceX) && pieceX > 0 ? Math.floor(pieceX) : undefined,
      pieceW: Number.isFinite(pieceW) && pieceW > 0 ? Math.floor(pieceW) : undefined,
      gapW: Number.isFinite(gapW) && gapW > 0 ? Math.floor(gapW) : undefined,
      imageWidth: Math.max(1, Math.floor(imageWidth || input.clip.width)),
      confidence: Math.min(1, Math.max(0, confidence)),
      path,
    };
    return out;
  } catch (err) {
    if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
      throw new Error("Agent 已中止");
    }
    input.logger.warn("slider_vision_gap_failed", {
      error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
    });
    return path ? { gapX: 0, imageWidth: input.clip.width, confidence: 0, path } : null;
  }
}

/**
 * 拖拽分段长度上限（视口 px）。
 *
 * 内核 humanMove 的垂直摆幅 bias = rand(-0.3, 0.3) × dist 与「单次移动距离」成正比：
 * 一次性拖 275px 时实测垂直偏离最坏 34px（轨道仅 40px 高），有 10 个 mousemove 事件
 * 落在轨道之外 —— 真人拖滑块是贴着轨道走的，这种大摆幅是风控识别的强特征，
 * 也是「位置拖对了但人机验证不过」的直接原因。
 * 拆成 ≤50px 的短段后偏移随段长等比缩小（实测 ≤10px 且 0 事件越轨）。
 */
const DRAG_SEGMENT_PX = 50;
const DRAG_SEGMENT_MIN = 2;
/** 分段上限：避免超长距离拖拽被拆得过碎而耗时失控 */
const DRAG_SEGMENT_MAX = 12;

/**
 * 拖拽滑块：轨迹 100% 交由 CloakBrowser 内核（humanize）生成。
 *
 * 内核已重写 `page.mouse.move`，每次调用内部都会生成一条 Bezier 曲线 + 加速度偏移：
 *   page.mouse.move = (x, y) => humanMove(raw, cursor, x, y, cfg)
 * 因此这里**只负责给航点**，绝不自己做插值/缓动/抖动。
 *
 * 分段推进的意义（见 DRAG_SEGMENT_PX 注释）：既把内核曲线的垂直摆幅约束在轨道内，
 * 又自然形成「分段推进 + 中途微停顿」的真人拖拽节奏。
 */
async function dragSliderByKernel(
  page: Page,
  from: { x: number; y: number },
  distance: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Agent 已中止");
  try {
    await page.mouse.move(from.x, from.y);
    // 停稳再按下：真人会先定位手柄，且内核在该次移动后可能仍有微超冲待回正
    await sleep(120 + Math.floor(Math.random() * 80));
    await page.mouse.down();
    await sleep(90 + Math.floor(Math.random() * 70));

    const segments = Math.max(
      DRAG_SEGMENT_MIN,
      Math.min(DRAG_SEGMENT_MAX, Math.round(distance / DRAG_SEGMENT_PX)),
    );
    for (let i = 1; i <= segments; i++) {
      if (signal?.aborted) throw new Error("Agent 已中止");
      await page.mouse.move(from.x + (distance * i) / segments, from.y);
      if (i < segments) await sleep(30 + Math.floor(Math.random() * 45));
    }
    // 松手前停顿：真人确认滑块已到位后才释放按键
    await sleep(120 + Math.floor(Math.random() * 120));
  } catch (err) {
    // 拖拽中途异常必须保证按键释放，否则残留 pressed 状态会污染后续所有鼠标动作
    await page.mouse.up().catch(() => undefined);
    throw err;
  }
  await page.mouse.up();
}

/** 滑块协议观察器 URL 正则（去掉 token：CSRF/session token 易误匹配非验证码请求） */
const SLIDER_URL_PATTERN = /captcha|verify|slide|check|gap|ripple|challenge/i;

export async function checkSliderOutcome(
  page: Page,
  domBefore?: SliderDomInfo,
  /** 本轮实际拖拽距离（视口像素）：用于确认手柄是否停在缺口位置 */
  expectedDragPx?: number,
): Promise<{
  verified: boolean | null;
  signal: string;
}> {
  // 两相验收：成功与失败都可能伴随「手柄复位 + 换题/弹层」，单次快照极易误判。
  // 第一相短等后先看硬证据（弹层消失 / 失败文案 / 成功文案 / 手柄停留）；
  // 若仅见「手柄复位」，不立即判失败——成功也可能是「复位后弹层延迟消失」，
  // 再等第二相确认：弹层消失=成功，仍在且无成功信号=失败（换新题）。
  const probe = async (): Promise<{
    verified: boolean | null;
    signal: string;
    handleReset: boolean;
  }> => {
    let dismissed = false;
    let handleReset = false;
    let handleHeld = false;
    let movedPx: number | null = null;
    if (domBefore?.ok && domBefore.handle && domBefore.track) {
      const domNow = await locateSliderDom(page).catch(() => null);
      if (!domNow?.ok) {
        const reason = domNow?.reason ?? "";
        // 仅当轨道与手柄都从 DOM 里消失才判通过；只缺底图(换图)或仅隐藏不算。
        dismissed = /track=0/.test(reason) && /handle=0/.test(reason);
      } else if (domNow.handle) {
        movedPx = domNow.handle.x - domBefore.handle.x;
        const backToStart = Math.abs(movedPx) <= domNow.handle.w * 1.5 + 6;
        if (backToStart) handleReset = true;
        else handleHeld = true;
      }
    }

    const text = await page
      .evaluate(() => String(document.body?.innerText || "").slice(0, 5000))
      .catch(() => "");

    if (dismissed) return { verified: true, signal: "slider_dismissed", handleReset };
    const { verdict, signal } = classifyCaptchaOutcomeText(text);
    if (verdict === "fail") return { verified: false, signal, handleReset };
    if (verdict === "success") return { verified: true, signal, handleReset };
    // 手柄脱离起点≠通过：只有停在预期终点附近才算硬信号；半途卡住视为未决，
    // 避免把「拖到一半就松手」误判为已通过而漏掉重试。
    if (handleHeld) {
      const nearExpected =
        expectedDragPx != null &&
        expectedDragPx > 0 &&
        movedPx != null &&
        Math.abs(movedPx - expectedDragPx) <= Math.max(12, expectedDragPx * 0.35);
      return nearExpected
        ? { verified: true, signal: "handle_held_at_gap", handleReset }
        : { verified: null, signal: "handle_held_off_gap", handleReset };
    }
    if (handleReset) return { verified: null, signal: "handle_reset", handleReset };
    return { verified: null, signal: "no_clear_signal", handleReset };
  };

  await sleep(700);
  const first = await probe();
  if (first.verified != null) {
    return { verified: first.verified, signal: first.signal };
  }

  // 仅见「手柄复位」：第二相等 800ms 再探一次，区分「成功→延迟消失」与「失败→换新题」。
  if (first.signal === "handle_reset") {
    await sleep(800);
    const second = await probe();
    if (second.verified != null) {
      return { verified: second.verified, signal: second.signal };
    }
    return { verified: false, signal: "handle_reset" };
  }

  return { verified: null, signal: first.signal };
}

/** OpenCV 滑块缺口检测的置信度封顶：轮廓对只是启发式证据，不得压过视觉/强像素。 */
const OPENCV_SLIDER_MAX_CONF = 0.35;

type GapCandidate = {
  label: string;
  /** 缺口左缘在显示坐标系（dom.image.w）下的位置 */
  disp: number;
  conf: number;
};

/**
 * 多源缺口候选融合（pixel / opencv / vision）。
 * 高置信优先；多候选一致（落在容差内）则按置信度加权平均。
 */
function fuseGapCandidates(
  cands: GapCandidate[],
  imageW: number,
  opts?: { pieceDisp?: number; pieceTol?: number },
): { disp: number; conf: number; method: string } | null {
  const valid = cands.filter(
    (c) => c.disp > 0 && c.disp < imageW * 0.98 && c.conf > 0,
  );
  if (valid.length === 0) return null;

  // 几何先验：拼图块与手柄对齐（初始在底图左缘/手柄正上方）。
  // 落在拼图块范围内的候选大概率是「深色拼图块」而非缺口，需降权。
  const pieceTol = opts?.pieceTol ?? Math.max(16, imageW * 0.14);
  const scored = valid
    .map((c) => {
      if (opts?.pieceDisp != null && Math.abs(c.disp - opts.pieceDisp) <= pieceTol) {
        return { ...c, conf: c.conf * 0.35 };
      }
      return c;
    })
    .filter((c) => c.conf > 0);

  const tol = Math.max(10, imageW * 0.035);

  // 视觉权威：视觉能语义区分「拼图块」与「缺口」，但定位精度（±20~30px）远逊于
  // 像素/OpenCV 的逐像素精度。只有当所有确定性通道都偏弱（conf<0.4，即未找到
  // 「拼图块+缺口」结构对）时，才以视觉为准兜底。确定性结构对永远优先。
  const vision = scored.find((c) => c.label === "vision");
  const nonVision = scored.filter((c) => c.label !== "vision");
  const nonVisionWeak = nonVision.length === 0 || nonVision.every((c) => c.conf < 0.4);
  if (
    vision &&
    nonVisionWeak &&
    !nonVision.some((c) => Math.abs(c.disp - vision.disp) <= tol)
  ) {
    return { disp: vision.disp, conf: vision.conf, method: "vision(override)" };
  }

  scored.sort((a, b) => b.conf - a.conf);
  const best = scored[0]!;
  const agree = scored.filter((c) => Math.abs(c.disp - best.disp) <= tol);
  if (agree.length >= 2) {
    const wSum = agree.reduce((s, c) => s + c.conf, 0);
    return {
      disp: agree.reduce((s, c) => s + c.disp * c.conf, 0) / wSum,
      conf: Math.min(0.98, agree.reduce((s, c) => s + c.conf, 0) / agree.length + 0.06),
      method: `fuse:${agree.map((c) => c.label).join("+")}`,
    };
  }
  return { disp: best.disp, conf: best.conf, method: best.label };
}

/**
 * 融合「内部自洽拖距」候选（gap - piece 来自同一源）。
 * 拖距是最终要用的量，直接融合拖距比「先融缺口、再单独挑拼图块」更可靠。
 */
function fuseDragCandidates(
  cands: Array<{ label: string; drag: number; conf: number }>,
  trackUsable: number,
): { drag: number; conf: number; method: string } | null {
  const valid = cands.filter(
    (c) => c.drag > 0 && c.drag < trackUsable * 1.1 && c.conf > 0,
  );
  if (valid.length === 0) return null;

  const tol = Math.max(12, trackUsable * 0.08);
  valid.sort((a, b) => b.conf - a.conf);
  const best = valid[0]!;
  const agree = valid.filter((c) => Math.abs(c.drag - best.drag) <= tol);
  if (agree.length >= 2) {
    const wSum = agree.reduce((s, c) => s + c.conf, 0);
    return {
      drag: agree.reduce((s, c) => s + c.drag * c.conf, 0) / wSum,
      conf: Math.min(0.98, agree.reduce((s, c) => s + c.conf, 0) / agree.length + 0.06),
      method: `fuse:${agree.map((c) => c.label).join("+")}`,
    };
  }
  return { drag: best.drag, conf: best.conf, method: best.label };
}

type GapDetection = {
  /** 缺口左缘相对底图左缘（显示 px） */
  gapOnDisplayPx: number;
  /** 拼图块左缘相对底图左缘（显示 px），未知时为 0 */
  pieceOnDisplayPx: number;
  /** 拼图块宽（显示 px），未知时为 0 */
  pieceW: number;
  /**
   * 内部自洽拖距（显示 px）：每个源用自己的 gap - 自己的 piece。
   * 混合「融合缺口 + 单独选的拼图块」会破坏源内部一致性（如 OpenCV gap=196 piece=74
   * → 自洽拖距 122，但配 DOM piece=0 → 196），导致整体偏移。
   */
  dragOnDisplayPx: number;
  gapW: number;
  imageWidth: number;
  confidence: number;
  method: string;
  candidates: GapCandidate[];
};

/** 对当前底图做一次完整缺口检测（像素 → OpenCV → 视觉 → 融合）。 */
async function detectSliderGap(input: {
  page: Page;
  dom: SliderDomInfo;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
  artifactPaths: string[];
}): Promise<GapDetection> {
  const { page, dom } = input;
  const image = dom.image!;
  let gapW = 0;
  let imageWidth = Math.floor(image.w);
  const candidates: GapCandidate[] = [];
  // 拼图块左缘（相对底图左缘，显示 px）。DOM 定位的拼图块是「真实存在」的独立元素，
  // 优先级最高（它才是拖拽同步的对象）；视觉其次；像素/OpenCV 再次。
  // 全部缺失时才退化为 0（假设拼图块在底图左缘）。
  let pieceOnDisplayPx = 0;
  let pieceW = 0;
  let pieceSource = "none";
  /**
   * 拼图块左缘的几何先验：滑块拼图中拼图块与手柄 1:1 同步，静止时其左缘 ≈ 手柄在轨道内的左位移。
   * 只用于「证伪」：像素/OpenCV 报出的拼图块若与先验严重不符，多半是把缺口或装饰物当成了
   * 拼图块（本类站点缺口就是实心中性块，最容易被误判），此时宁可用先验兜底；
   * 静止时先验 = 0，与原「拼图块贴左缘」兜底一致，不改变既有站点行为。
   */
  const pieceLeftPrior = dom.handle
    ? Math.max(0, dom.handle.x - dom.handle.w / 2 - (dom.track?.x ?? image.x))
    : 0;
  const piecePriorTol = Math.max(24, image.w * 0.08);
  /** 像素/OpenCV 的拼图块估计是否与几何先验相符 */
  const pieceEstimateAgrees = (disp: number): boolean =>
    Math.abs(disp - pieceLeftPrior) <= piecePriorTol;
  // DOM 拼图块（可靠时）：只作为「拼图块贴近左缘」的基准与兜底。真正拖距用源内自洽的
  // (gap - piece) 融合，避免 DOM 误检（左缘装饰元素）与底图内拼图块位置冲突。
  let basePieceDisp = 0;
  if (dom.piece) {
    const off = dom.piece.x - image.x;
    if (off > image.w * 0.45) {
      // 跑到底图右半区：上一次拖拽残留或误检，退化为左缘(0)。
      pieceOnDisplayPx = 0;
      pieceW = dom.piece.w;
      pieceSource = "dom(stale→0)";
    } else {
      pieceOnDisplayPx = off;
      pieceW = dom.piece.w;
      pieceSource = "dom";
      basePieceDisp = off;
    }
  }

  // 内部自洽拖距候选（每个源用自己的 gap - 自己的 piece）。
  const dragCandidates: Array<{ label: string; drag: number; conf: number }> = [];

  const pixel = await findGapByPixels(page, dom.imageSelector);
  let pixelDetail = pixel?.detail ?? "";
  if (pixel && pixel.gapX > 0 && pixel.gapX < pixel.imageWidth) {
    gapW = pixel.gapW;
    imageWidth = pixel.imageWidth;
    const pixelGapDisp = (pixel.gapX / Math.max(1, pixel.imageWidth)) * image.w;
    candidates.push({ label: "pixel", disp: pixelGapDisp, conf: pixel.confidence });
    const pixelPieceDisp =
      pixel.pieceX != null && pixel.pieceX > 0
        ? (pixel.pieceX / Math.max(1, pixel.imageWidth)) * image.w
        : null;
    dragCandidates.push({
      label: "pixel",
      drag: Math.max(0, pixelGapDisp - (pixelPieceDisp ?? basePieceDisp)),
      conf: pixel.confidence,
    });
    if (pixel.pieceX != null && pixel.pieceX > 0 && pieceSource === "none") {
      if (pieceEstimateAgrees(pixelPieceDisp!)) {
        pieceOnDisplayPx = pixelPieceDisp!;
        pieceW = ((pixel.pieceW ?? pixel.gapW) / Math.max(1, pixel.imageWidth)) * image.w;
        pieceSource = "pixel";
      } else {
        // 像素块与手柄几何矛盾：它多半是缺口/装饰物，不是拼图块 → 用先验兜底。
        pieceOnDisplayPx = pieceLeftPrior;
        pieceSource = "handle(pixel≠prior)";
      }
    }
    if (pixel.confidence < 0.32) {
      input.logger.agentProgress(
        `像素缺口置信偏低 conf=${pixel.confidence.toFixed(2)} · ${pixel.detail}`,
        { phase: "slider_captcha", stage: "pixel_gap_weak", conf: pixel.confidence },
      );
    }
  }

  const captured = await captureElementImage({
    page,
    box: image,
    selector: dom.imageSelector,
    src: dom.imgSrc,
  });

  // ——— 高级视觉通道：Alpha 轮廓 + 面积约束 ±15% + Hu 矩形状匹配 ———
  // 仅在页面暴露「带 Alpha 的独立拼图块图」时可用；无该资源时求解器返回
  // ok=false，静默降级到下面的像素/OpenCV 通道，不影响既有站点。
  if (dom.pieceSrc || dom.pieceSelector) {
    const solver = new SliderVisionSolver(input.logger);
    const pieceBox = dom.piece;
    const pieceImg = pieceBox
      ? await captureElementImage({
          page,
          box: pieceBox,
          selector: dom.pieceSelector || undefined,
          src: dom.pieceSrc || undefined,
          preserveAlpha: true,
        })
      : null;
    const bgForVision = captured ?? (await captureElementImage({ page, box: image, selector: dom.imageSelector }));
    if (pieceImg && bgForVision) {
      const vision = await solver.solve({
        bgImage: bgForVision.buf,
        pieceImage: pieceImg.buf,
        pieceAnchorX: (pieceBox ? pieceBox.x - image.x : 0) * (bgForVision.clip.width / image.w),
        // 拼图块原图可能是 2x/3x 高清资源，须告知其页面显示尺寸才能与背景同尺度
        pieceDisplayW: pieceBox?.w,
        pieceDisplayH: pieceBox?.h,
        signal: input.signal,
      });
      if (vision.ok && vision.diagnostics) {
        const d = vision.diagnostics;
        const visionGapDisp = (vision.gapLeft / Math.max(1, d.imageWidth || bgForVision.clip.width)) * image.w;
        candidates.push({ label: "alpha_hu", disp: visionGapDisp, conf: vision.confidence });
        dragCandidates.push({
          label: "alpha_hu",
          drag: (vision.dragDistance / Math.max(1, d.imageWidth || bgForVision.clip.width)) * image.w,
          conf: vision.confidence,
        });
        if (pieceSource === "none") {
          pieceOnDisplayPx = visionGapDisp - (vision.dragDistance / Math.max(1, d.imageWidth || bgForVision.clip.width)) * image.w;
          pieceW = (d.pieceW / Math.max(1, d.imageWidth || bgForVision.clip.width)) * image.w;
          pieceSource = "alpha_hu";
        }
        input.logger.agentProgress(`Alpha+Hu矩缺口：${vision.detail}`, {
          phase: "slider_captcha",
          stage: "vision_alpha_hu",
          gapLeft: vision.gapLeft,
          dragDistance: vision.dragDistance,
          matchScore: d.matchScore,
          candidates: d.candidates,
          areaRejected: d.areaRejected,
          ambiguous: vision.ambiguous,
        });
      } else {
        // 无 Alpha / 无面积匹配属于「本页面不适用该通道」，不是故障
        input.logger.debug("slider_vision_skipped", {
          reason: vision.reason ?? "unknown",
          detail: vision.detail.slice(0, 120),
        });
      }
    }
  }

  if (captured) {
    const cv = await openCvSliderGap({
      buf: captured.buf,
      logger: input.logger,
      signal: input.signal,
    });
    if (cv && cv.gapX > 0 && cv.confidence >= 0.2 && cv.imageWidth > 0) {
      const cvGapDisp = (cv.gapX / Math.max(1, cv.imageWidth)) * image.w;
      // OpenCV 轮廓几何是启发式（contour_pair 只是「找到两个块」，并不验证它们真是一对
      // 拼图块+缺口），置信度被公式虚高到 0.98，会在新站点上以高置信给出错误拖距、
      // 压过像素/视觉两个原本可靠的通道。按「锦上添花」原则：OpenCV 只作辅助投票，
      // 置信度封顶，无法再单方面左右结果（视觉与强像素永远优先）。
      const cvConf = Math.min(cv.confidence, OPENCV_SLIDER_MAX_CONF);
      candidates.push({ label: "opencv", disp: cvGapDisp, conf: cvConf });
      const cvPieceDisp =
        cv.pieceX != null && cv.pieceX > 0
          ? (cv.pieceX / Math.max(1, cv.imageWidth)) * image.w
          : null;
      dragCandidates.push({
        label: "opencv",
        drag: Math.max(0, cvGapDisp - (cvPieceDisp ?? basePieceDisp)),
        conf: cvConf,
      });
      if (cv.pieceX != null && cv.pieceX > 0 && pieceSource === "none") {
        if (pieceEstimateAgrees(cvPieceDisp!)) {
          pieceOnDisplayPx = cvPieceDisp!;
          pieceW = ((cv.pieceW ?? cv.gapW) / Math.max(1, cv.imageWidth)) * image.w;
          pieceSource = "opencv";
        } else {
          pieceOnDisplayPx = pieceLeftPrior;
          pieceSource = "handle(opencv≠prior)";
        }
      }
      input.logger.agentProgress(
        `OpenCV 缺口：gapX=${cv.gapX} pieceX=${cv.pieceX ?? "-"} conf=${cv.confidence.toFixed(2)} ${cv.method}`,
        { phase: "slider_captcha", stage: "opencv_gap", gapX: cv.gapX, pieceX: cv.pieceX ?? null, conf: cv.confidence },
      );
    }
  }

  const visionConfigured = isIntentConfigured(
    createModelRouter(input.aiSettings).pool,
    "vision",
  );
  const interim = fuseGapCandidates(candidates, image.w, {
    pieceDisp: pieceOnDisplayPx || undefined,
  });

  // 视觉是唯一能语义区分「拼图块」与「缺口」的通道，只要配置了视觉就始终交叉校验。
  const needVision = visionConfigured;

  if (needVision && captured) {
    input.logger.agentProgress("②b 视觉交叉校验缺口…", {
      phase: "slider_captcha",
      stage: "vision_gap",
      prevConf: interim?.conf ?? 0,
    });
    // 视觉喂原图（彩色）：灰度增强图会丢失「拼图块 vs 缺口」的颜色语义。
    const vision = await gapByVisionFromBuffer({
      buf: captured.buf,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      clip: captured.clip,
    });
    if (vision?.path) input.artifactPaths.push(vision.path);
    if (vision && vision.gapX > 0) {
      const visionGapDisp = (vision.gapX / Math.max(1, vision.imageWidth)) * image.w;
      const visionPieceDisp =
        vision.pieceX != null && vision.pieceX > 0
          ? (vision.pieceX / Math.max(1, vision.imageWidth)) * image.w
          : null;
      // 健全性检查：若视觉把缺口定位得离拼图块过近（< 1.2×块宽），
      // 大概率是把「深色拼图块」误当成了缺口（第1次日志 gap=50 piece=40 即此病）。
      // 此时丢弃视觉的缺口候选，仅保留其拼图块位置。
      const minGapDx = Math.max(28, pieceW * 1.2);
      const tooClose =
        (visionPieceDisp ?? 0) > 0 && visionGapDisp - (visionPieceDisp ?? 0) < minGapDx;
      if (!tooClose) {
        candidates.push({ label: "vision", disp: visionGapDisp, conf: vision.confidence });
        dragCandidates.push({
          label: "vision",
          drag: Math.max(0, visionGapDisp - (visionPieceDisp ?? basePieceDisp)),
          conf: vision.confidence,
        });
      }
      // 视觉给出的拼图块位置：仅在 DOM 未定位到真实拼图块时才采用
      // （DOM 拼图块是拖拽同步的实体，比「从底图语义猜位置」更可信）。
      if (vision.pieceX != null && vision.pieceX > 0 && pieceSource === "none") {
        pieceOnDisplayPx = visionPieceDisp!;
        pieceW = ((vision.pieceW ?? vision.gapW ?? 0) / Math.max(1, vision.imageWidth)) * image.w;
        pieceSource = "vision";
      }
      input.logger.agentProgress(
        `视觉：gap=${vision.gapX} piece=${vision.pieceX ?? "-"} gapW=${vision.gapW ?? "-"} pieceW=${vision.pieceW ?? "-"}${tooClose ? " [gap≈piece 已弃]" : ""}`,
        { phase: "slider_captcha", stage: "vision_detail" },
      );
    }
  }

  input.logger.agentProgress(
    `候选缺口：[${candidates
      .map((c) => `${c.label}=${c.disp.toFixed(0)}@${c.conf.toFixed(2)}`)
      .join(" ")}] piece=${pieceOnDisplayPx.toFixed(0)}(${pieceSource})`,
    {
      phase: "slider_captcha",
      stage: "gap_candidates",
      pixelDetail: pixelDetail || undefined,
    },
  );

  const fused = fuseGapCandidates(candidates, image.w, {
    pieceDisp: pieceOnDisplayPx || undefined,
  });

  // 拖距融合：优先采用源内自洽 (gap - piece)，避免「融缺口 + 单挑拼图块」的错位。
  const trackUsableForDrag = Math.max(
    40,
    (dom.track?.w ?? image.w) - (dom.handle?.w ?? 40) - 6,
  );
  const fusedDrag = fuseDragCandidates(dragCandidates, trackUsableForDrag);
  return {
    gapOnDisplayPx: fused?.disp ?? 0,
    pieceOnDisplayPx,
    pieceW,
    dragOnDisplayPx:
      fusedDrag?.drag ?? Math.max(0, (fused?.disp ?? 0) - basePieceDisp),
    gapW,
    imageWidth,
    confidence: fusedDrag?.conf ?? fused?.conf ?? 0,
    method: fusedDrag?.method ?? fused?.method ?? "none",
    candidates,
  };
}

/**
 * 计算拟人拖拽基准距离。
 *
 * 正确物理模型：拼图块与手柄 1:1 同步（同为页面坐标系、同比例渲染）。
 * 拖拽距离 = 缺口左缘 − 拼图块左缘（均相对底图左缘，页面 px）。
 * 用户实测参考：drag = target_gap.x - slider_block.x，无缩放。
 * 旧实现强加的「轨道/底图缩放比」是错误来源（在 image.w≈track.w 时引入 ~3% 且与 1:1 不符）。
 */
function buildBaseDrag(det: GapDetection, dom: SliderDomInfo): number {
  const track = dom.track!;
  const handle = dom.handle!;

  // 优先用源内自洽拖距（gap - piece 来自同一源）；缺失时退化为缺口 − 拼图块左缘。
  const dx =
    det.dragOnDisplayPx > 0
      ? det.dragOnDisplayPx
      : det.gapOnDisplayPx - det.pieceOnDisplayPx;

  const trackUsable = Math.max(40, track.w - handle.w - 6);
  return Math.max(15, Math.min(trackUsable, Math.max(0, dx)));
}

export async function solveSliderCaptcha(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
  pageHint?: string;
  goalHint?: string;
}): Promise<SliderSolveResult> {
  if (input.signal?.aborted) throw new Error("Agent 已中止");
  const artifactPaths: string[] = [];

  input.logger.agentProgress("① 滑块策略：定位底图/手柄/轨道…", {
    phase: "slider_captcha",
    stage: "locate",
  });

  const dom = await locateSliderDom(input.page);
  if (!dom.ok || !dom.image || !dom.handle || !dom.track || !dom.imageSelector) {
    return {
      ok: false,
      strategy: "unsupported",
      gapX: 0,
      dragDistance: 0,
      confidence: 0,
      method: "none",
      verified: null,
      verifySignal: "",
      protocolHints: [],
      artifactPaths,
      detail: `unsupported: 未定位到滑块控件（${dom.reason ?? "unknown"}）`,
    };
  }

  input.logger.agentProgress(
    `已定位底图 ${Math.round(dom.image.w)}×${Math.round(dom.image.h)} · 轨道宽 ${Math.round(dom.track.w)} · 手柄(${Math.round(dom.handle.x)},${Math.round(dom.handle.y)})` +
      (dom.piece
        ? ` · 拼图块 DOM(${Math.round(dom.piece.x)},${Math.round(dom.piece.y)} ${Math.round(dom.piece.w)}×${Math.round(dom.piece.h)})`
        : " · 拼图块 DOM 未定位"),
    { phase: "slider_captcha", stage: "located" },
  );

  // 每次尝试都重新检测缺口：拖错后底图会刷新（换新缺口），复用旧缺口只会越拖越偏。
  // 关键：该站点「验证失败即自动刷新验证码」，每次拖拽面对的都是全新缺口/全新拼图块，
  // 因此绝不能在重试时叠加人为 offset——那等于在新图正确结果上凭空加噪声。
  // 单次工具调用的内部拖拽上限；外层硬闸按「工具调用次数」计 3 次 → 最坏约 15 次拖拽。
  // 内部留余量是为了吸收「换图后首次定位偏差」，不等于无限重试；达到上限即返回未决交由外层计数。
  const MAX_ATTEMPTS = 3;
  const protocolAll: string[] = [];
  let currentDom = dom;
  let gapOnDisplayPx = 0;
  let confidence = 0;
  let method = "none";
  let lastDrag = 0;
  let lastOutcome: { verified: boolean | null; signal: string } = {
    verified: null,
    signal: "no_clear_signal",
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (input.signal?.aborted) throw new Error("Agent 已中止");

    if (attempt > 0) {
      // 失败拖拽会刷新底图（换新缺口）。手柄/轨道几何是静态的，但刷新动画期间重新
      // 定位 DOM 极易误检（实测：手柄被误检为 216px、拼图块残留旧拖拽位置 196px，
      // 导致 trackUsable 塌缩为 88、drag=gap-196→15px 这类垃圾值）。
      // 因此重试时保留原始手柄/轨道/拼图块几何，仅更新底图（src 可能已刷新）。
      const refreshed = await locateSliderDom(input.page);
      if (refreshed.ok && refreshed.image && refreshed.track) {
        currentDom = {
          ...refreshed,
          handle: dom.handle,
          track: dom.track,
          // 拼图块随失败回弹到左缘；旧位置残留会导致 dx 被抵消。
          piece: null,
        };
      } else {
        currentDom = dom;
      }
    }

    const det = await detectSliderGap({
      page: input.page,
      dom: currentDom,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      artifactPaths,
    });
    gapOnDisplayPx = det.gapOnDisplayPx;
    confidence = det.confidence;
    method = det.method;
    if (gapOnDisplayPx <= 0 || gapOnDisplayPx >= currentDom.image!.w * 0.98) break;

    const trackUsable = Math.max(40, currentDom.track!.w - currentDom.handle!.w - 6);
    const baseDrag = buildBaseDrag(det, currentDom);
    const dragDistance = Math.max(15, Math.min(trackUsable, baseDrag));
    lastDrag = dragDistance;
    const handle = currentDom.handle!;

    input.logger.agentProgress(
      `③ 缺口 ${gapOnDisplayPx.toFixed(1)}px · 拼图块 ${det.pieceOnDisplayPx.toFixed(1)}px · 自洽拖距 ${det.dragOnDisplayPx.toFixed(1)}px → 拖距 ${dragDistance.toFixed(1)}px / 可用 ${trackUsable.toFixed(0)} · ${method} · conf=${confidence.toFixed(2)}`,
      {
        phase: "slider_captcha",
        stage: "plan_drag",
        gapOnDisplayPx,
        pieceOnDisplayPx: det.pieceOnDisplayPx,
        dragOnDisplayPx: det.dragOnDisplayPx,
        baseDrag,
        trackUsable,
        dragDistance,
        confidence,
        method,
        attempt: attempt + 1,
      },
    );

    const observer = createProtocolObserver(input.page, SLIDER_URL_PATTERN);
    try {
      input.logger.agentProgress(
        `④ 拟人拖拽${attempt === 0 ? "" : `重试#${attempt + 1}`}… drag=${dragDistance.toFixed(1)}`,
        { phase: "slider_captcha", stage: "drag", attempt: attempt + 1, dragDistance },
      );
      await dragSliderByKernel(
        input.page,
        { x: handle.x, y: handle.y },
        dragDistance,
        input.signal,
      );
      // 须在 dispose 前验收：校验 XHR 常在 mouseup 之后才返回
      lastOutcome = await checkSliderOutcome(input.page, currentDom, dragDistance);
      // 协议成功仅升级「未决」→ 通过；不得覆盖 DOM 明确失败（防站内无关 JSON 误报）。
      if (observer.hits.length > 0 && lastOutcome.verified !== false) {
        lastOutcome = { verified: true, signal: "protocol_success_body" };
      }
      protocolAll.push(...observer.hits.map((h) => `${h.url} :: ${h.preview}`));
    } finally {
      observer.dispose();
    }

    input.logger.agentProgress(
      `⑤ 验收#${attempt + 1}：verified=${String(lastOutcome.verified)} signal=${lastOutcome.signal}`,
      {
        phase: "slider_captcha",
        stage: "verify",
        attempt: attempt + 1,
        verified: lastOutcome.verified,
        signal: lastOutcome.signal,
      },
    );

    if (lastOutcome.verified === true) break;
    if (lastOutcome.verified === false) {
      await sleep(450);
      continue;
    }
    break; // 无明确信号，停止（避免无限重试）
  }

  if (gapOnDisplayPx <= 0) {
    const removed = destroyPaths(artifactPaths);
    return {
      ok: false,
      strategy: "slider_gap_drag",
      gapX: 0,
      dragDistance: 0,
      confidence: 0,
      method,
      verified: null,
      verifySignal: "",
      protocolHints: [],
      artifactPaths: [],
      detail: `未能定位缺口（已毁临时图 ${removed}）。勿刷新，可重试；满3次 HITL。`,
    };
  }

  const removed = destroyPaths(artifactPaths);
  if (removed > 0) {
    input.logger.agentProgress(`已销毁滑块临时图 ${removed} 个`, {
      phase: "slider_captcha",
      stage: "cleanup",
      removed,
    });
  }

  return {
    ok: lastOutcome.verified !== false,
    strategy: "slider_gap_drag",
    gapX: Math.round(gapOnDisplayPx),
    dragDistance: lastDrag,
    confidence,
    method,
    verified: lastOutcome.verified,
    verifySignal: lastOutcome.signal,
    protocolHints: protocolAll,
    artifactPaths: [],
    detail:
      lastOutcome.verified === true
        ? `slider_ok drag=${lastDrag.toFixed(1)} ${method}`
        : lastOutcome.verified === false
          ? `slider_fail：${lastOutcome.signal}；captcha_attempt+1；勿刷新未满3次可重试`
          : `slider_done drag=${lastDrag.toFixed(1)}；无明确页内信号` +
            (protocolAll.length ? `；协议候选 ${protocolAll.length}` : ""),
  };
}
