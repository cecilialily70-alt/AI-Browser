/**
 * 主画布 DOM：必须是 img/canvas 本身的【content-box】
 * 严禁父容器；严禁把 padding/border 算进原点（否则点击系统性右下漂）
 */
import type { Page } from "playwright-core";

export const MEDIA_ATTR = "data-cf-point-crop";

export type MediaContentBox = {
  /** 内容区左上角（视口 CSS）= border+padding 之后 */
  left: number;
  top: number;
  width: number;
  height: number;
  /** border-box（仅诊断） */
  borderLeft: number;
  borderTop: number;
  borderWidth: number;
  borderHeight: number;
  paddingLeft: number;
  paddingTop: number;
  tag: "img" | "canvas" | string;
  /** canvas 内部像素（诊断） */
  canvasInternalW?: number;
  canvasInternalH?: number;
};

function parseBoxEval() {
  return ({ attr }: { attr: string }) => {
    const el = document.querySelector(
      `[${attr}="media"]`,
    ) as HTMLElement | null;
    if (!el) return null;
    const tag = el.tagName.toLowerCase();
    if (tag !== "img" && tag !== "canvas") {
      // 铁律：不允许父容器
      return null;
    }
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

    // content-box：画面真实绘制区域
    const left = r.left + bl + pl;
    const top = r.top + bt + pt;
    const width = Math.max(1, r.width - bl - br - pl - pr);
    const height = Math.max(1, r.height - bt - bb - pt - pb);

    if (width < 8 || height < 8) return null;

    const out: {
      left: number;
      top: number;
      width: number;
      height: number;
      borderLeft: number;
      borderTop: number;
      borderWidth: number;
      borderHeight: number;
      paddingLeft: number;
      paddingTop: number;
      tag: string;
      canvasInternalW?: number;
      canvasInternalH?: number;
    } = {
      left,
      top,
      width,
      height,
      borderLeft: r.left,
      borderTop: r.top,
      borderWidth: r.width,
      borderHeight: r.height,
      paddingLeft: pl + bl,
      paddingTop: pt + bt,
      tag,
    };
    if (el instanceof HTMLCanvasElement) {
      out.canvasInternalW = el.width;
      out.canvasInternalH = el.height;
    }
    return out;
  };
}

/** 读取已标记 media 的 content-box（点击/采帧唯一基准） */
export async function readMediaContentBox(
  page: Page,
): Promise<MediaContentBox | null> {
  return page
    .evaluate(parseBoxEval(), { attr: MEDIA_ATTR })
    .catch(() => null) as Promise<MediaContentBox | null>;
}

/**
 * 在页面中定位主画布：只选 img/canvas，标记 attribute，返回 content-box + 题干文字
 */
export async function locateMediaElement(page: Page): Promise<{
  box: MediaContentBox;
  instruction: string;
  instructionElMarked: boolean;
} | null> {
  const found = await page.evaluate((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) =>
      el.removeAttribute(attr),
    );

    const include = /请点击|请依次|按顺序点击|依次按照/i;
    const titlePoison =
      /提交参赛|请使用协议|Copyright|首页|下一题|上一题|点击变换/i;
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;

    let hintEl: Element | null = null;
    let hintY = 0;
    let hintW = 0;
    let bestHint = -1e9;
    for (const e of Array.from(
      document.querySelectorAll("p,div,span,label,li,h1,h2,h3,strong,section"),
    )) {
      const tx = (e.textContent || "").replace(/\s+/g, " ").trim();
      if (tx.length < 4 || tx.length > 120) continue;
      if (!include.test(tx)) continue;
      if (titlePoison.test(tx) && !/^【?请/.test(tx)) continue;
      if (/点击变换/.test(tx) && !include.test(tx)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 40 || r.height < 10 || r.height > 120) continue;
      let score = 200 + Math.max(0, 80 - tx.length);
      score -= Math.log2(Math.max(2, r.width * r.height)) * 4;
      if (/^【?请按顺序|^【?请依次|^【?请点击/.test(tx)) score += 50;
      if (r.top > vh * 0.25 && r.top < vh * 0.92) score += 20;
      if (score > bestHint) {
        bestHint = score;
        hintEl = e;
        hintY = r.y;
        hintW = r.width;
      }
    }

    type Cand = { el: HTMLElement; score: number };
    const cands: Cand[] = [];
    for (const el of Array.from(
      document.querySelectorAll("img,canvas"),
    ) as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.width < 160 || r.height < 100) continue;
      if (r.width > vw * 0.95 && r.height > vh * 0.7) continue;
      if (r.height > vh * 0.75) continue;

      const src =
        el instanceof HTMLImageElement
          ? String(el.currentSrc || el.src || "")
          : "canvas";
      if (/\.gif(\?|$)/i.test(src) || src.startsWith("data:image/gif")) continue;

      // 排除明显是题干里的小图标
      if (r.height < 80 && r.width < 200) continue;

      let score = Math.log2(Math.max(2, r.width * r.height));
      if (el.tagName === "CANVAS") score += 12;
      if (
        /captcha|verify|click|point|select|验证|点选|match|topic/i.test(
          src + (el.className || "") + (el.id || ""),
        )
      ) {
        score += 40;
      }

      if (hintEl) {
        if (r.bottom > hintY + 30 && r.top >= hintY - 10) continue;
        const gap = hintY - r.bottom;
        if (gap >= -20 && gap < 120) score += 100 + Math.max(0, 60 - Math.abs(gap));
        else if (gap >= 120 && gap < 220) score += 40;
        else if (gap < -20) score -= 50;
        if (Math.abs(r.width - hintW) < 80) score += 25;
      } else {
        score += Math.min(30, (r.width * r.height) / (vw * vh) * 80);
      }
      cands.push({ el, score });
    }
    cands.sort((a, b) => b.score - a.score);
    const media = cands[0];
    if (!media) return null;

    // 只标记 img/canvas 本身，绝不标记父 div
    media.el.setAttribute(attr, "media");
    let instruction = "";
    let instructionElMarked = false;
    if (hintEl) {
      (hintEl as HTMLElement).setAttribute(attr, "hint");
      instruction = (hintEl.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      instructionElMarked = true;
    }

    const el = media.el;
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

    return {
      instruction,
      instructionElMarked,
      box: {
        left,
        top,
        width,
        height,
        borderLeft: r.left,
        borderTop: r.top,
        borderWidth: r.width,
        borderHeight: r.height,
        paddingLeft: pl + bl,
        paddingTop: pt + bt,
        tag: el.tagName.toLowerCase(),
        canvasInternalW:
          el instanceof HTMLCanvasElement ? el.width : undefined,
        canvasInternalH:
          el instanceof HTMLCanvasElement ? el.height : undefined,
      },
    };
  }, MEDIA_ATTR);

  if (!found?.box) return null;
  return {
    box: found.box as MediaContentBox,
    instruction: found.instruction,
    instructionElMarked: found.instructionElMarked,
  };
}
