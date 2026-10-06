/**
 * 验证码静默采帧（零闪动）：
 * - 禁止向验证码页注入可见 style / 禁止首选 page.screenshot
 * - img：优先 context.request 拉原图（完全不碰页面合成）
 * - 非 JPEG：在页内离屏 canvas 转码（不挂 DOM）
 * - canvas/img 元素：页内离屏 drawImage 导出
 * - 网格：同页离屏 canvas 绘制，永不 newPage / 不占验证码页布局
 */
import type { Page } from "playwright-core";
import { readJpegSize } from "./jpeg_size.js";
import { captureScreenshot } from "../../core/safe_screenshot.js";

export const CAPTURE_SETTLE_MS_MIN = 280;
export const CAPTURE_SETTLE_MS_MAX = 420;

export async function waitCaptureSettle(ms?: number): Promise<number> {
  const t =
    ms ??
    CAPTURE_SETTLE_MS_MIN +
      Math.floor(
        Math.random() * (CAPTURE_SETTLE_MS_MAX - CAPTURE_SETTLE_MS_MIN + 1),
      );
  await new Promise((r) => setTimeout(r, t));
  return t;
}

/** @deprecated 注入 style 本身会闪，已废弃为空操作 */
export async function freezePageForCapture(_page: Page): Promise<void> {
  /* no-op：禁止向页面 appendChild(style) */
}

/** @deprecated */
export async function unfreezePageForCapture(_page: Page): Promise<void> {
  /* no-op */
}

/**
 * 仅当主图未充分入视口时 nearest 微滚（等同 scrollIntoViewIfNeeded）；禁止 block:center。
 */
export async function softScrollMediaIntoView(
  page: Page,
  attr: string,
  mediaValue: string,
): Promise<boolean> {
  return page
    .evaluate(
      ({ attr, mediaValue }) => {
        const el = document.querySelector(
          `[${attr}="${mediaValue}"]`,
        ) as HTMLElement | null;
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight || 1;
        const vw = window.innerWidth || 1;
        const visibleH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        const visibleW = Math.min(r.right, vw) - Math.max(r.left, 0);
        const ratio =
          (Math.max(0, visibleH) * Math.max(0, visibleW)) /
          Math.max(1, r.width * r.height);
        if (ratio >= 0.98) return false;
        // 等价 scrollIntoViewIfNeeded：仅补齐入视口
        el.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "auto",
        });
        return true;
      },
      { attr, mediaValue },
    )
    .catch(() => false);
}

export type SilentFrame = {
  b64: string;
  cssWidth: number;
  cssHeight: number;
  startX: number;
  startY: number;
  method: "fetch" | "canvas" | "cdp_fallback";
};

type MediaMeta = {
  kind: "img" | "canvas" | "other";
  src: string;
  cssW: number;
  cssH: number;
  startX: number;
  startY: number;
};

async function readMediaMeta(
  page: Page,
  attr: string,
  mediaValue: string,
): Promise<MediaMeta | null> {
  return page.evaluate(
    ({ attr, mediaValue }) => {
      const el = document.querySelector(
        `[${attr}="${mediaValue}"]`,
      ) as HTMLElement | null;
      if (!el) return null;
      // content-box（与点击原点一致）
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;
      const bb = parseFloat(cs.borderBottomWidth) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      const startX = r.left + bl + pl;
      const startY = r.top + bt + pt;
      const cssW = Math.max(1, r.width - bl - br - pl - pr);
      const cssH = Math.max(1, r.height - bt - bb - pt - pb);

      if (el instanceof HTMLImageElement) {
        return {
          kind: "img" as const,
          src: String(el.currentSrc || el.src || ""),
          cssW,
          cssH,
          startX,
          startY,
        };
      }
      if (el instanceof HTMLCanvasElement) {
        return {
          kind: "canvas" as const,
          src: "",
          cssW,
          cssH,
          startX,
          startY,
        };
      }
      return {
        kind: "other" as const,
        src: "",
        cssW,
        cssH,
        startX,
        startY,
      };
    },
    { attr, mediaValue },
  );
}

export async function fetchImageBuffer(
  page: Page,
  src: string,
): Promise<Buffer | null> {
  const raw = String(src || "").trim();
  if (!raw) return null;
  if (raw.startsWith("data:image/")) {
    const m = raw.match(/^data:image\/[\w+.-]+;base64,(.+)$/i);
    if (!m?.[1]) return null;
    try {
      return Buffer.from(m[1], "base64");
    } catch {
      return null;
    }
  }
  let url = raw;
  try {
    url = new URL(raw, page.url()).href;
  } catch {
    return null;
  }
  try {
    const res = await page.context().request.get(url, { timeout: 12000 });
    if (!res.ok()) return null;
    const body = Buffer.from(await res.body());
    return body.length >= 64 ? body : null;
  } catch {
    return null;
  }
}

/**
 * 任意图像字节 → JPEG。
 * 若提供 targetCssW/H：强制缩放到 CSS 显示尺寸（1:1，禁用 devicePixelRatio）。
 */
export async function encodeBytesToJpegOnPage(
  page: Page,
  buf: Buffer,
  targetCssW?: number,
  targetCssH?: number,
): Promise<{ b64: string; w: number; h: number } | null> {
  const tw =
    typeof targetCssW === "number" && targetCssW > 0
      ? Math.max(1, Math.round(targetCssW))
      : 0;
  const th =
    typeof targetCssH === "number" && targetCssH > 0
      ? Math.max(1, Math.round(targetCssH))
      : 0;

  // 已是 JPEG 且无需缩放 → 零页内开销
  const jpeg = readJpegSize(buf);
  if (jpeg && (!tw || !th || (jpeg.w === tw && jpeg.h === th))) {
    return { b64: buf.toString("base64"), w: jpeg.w, h: jpeg.h };
  }

  try {
    const out = await page.evaluate(
      async ({
        b64,
        tw,
        th,
      }: {
        b64: string;
        tw: number;
        th: number;
      }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes]);
        const bitmap = await createImageBitmap(blob);
        const w = tw > 0 ? tw : bitmap.width;
        const h = th > 0 ? th : bitmap.height;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) {
          bitmap.close();
          return null;
        }
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        return {
          b64: dataUrl.slice(dataUrl.indexOf(",") + 1),
          w,
          h,
        };
      },
      { b64: buf.toString("base64"), tw, th },
    );
    if (!out?.b64) return null;
    return out;
  } catch {
    return null;
  }
}

async function exportCanvasElement(
  page: Page,
  attr: string,
  mediaValue: string,
  cssW: number,
  cssH: number,
): Promise<string | null> {
  const result = await page.evaluate(
    ({ attr, mediaValue, cssW, cssH }) => {
      const el = document.querySelector(
        `[${attr}="${mediaValue}"]`,
      ) as HTMLCanvasElement | null;
      if (!el || !(el instanceof HTMLCanvasElement)) {
        return { ok: false as const };
      }
      // 强制 CSS 1:1，严禁 devicePixelRatio
      const w = Math.max(1, Math.round(cssW));
      const h = Math.max(1, Math.round(cssH));
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const ctx = out.getContext("2d", { alpha: false });
      if (!ctx) return { ok: false as const };
      try {
        ctx.drawImage(el, 0, 0, w, h);
        const dataUrl = out.toDataURL("image/jpeg", 0.92);
        return {
          ok: true as const,
          b64: dataUrl.slice(dataUrl.indexOf(",") + 1),
        };
      } catch {
        return { ok: false as const };
      }
    },
    { attr, mediaValue, cssW, cssH },
  );
  return result && "ok" in result && result.ok ? result.b64 : null;
}

/** 页内离屏导出 <img>（CSS 1:1；不改 crossOrigin） */
async function exportImgElement(
  page: Page,
  attr: string,
  mediaValue: string,
  cssW: number,
  cssH: number,
): Promise<string | null> {
  const result = await page.evaluate(
    ({ attr, mediaValue, cssW, cssH }) => {
      const el = document.querySelector(
        `[${attr}="${mediaValue}"]`,
      ) as HTMLImageElement | null;
      if (!el || !(el instanceof HTMLImageElement)) {
        return { ok: false as const };
      }
      const w = Math.max(1, Math.round(cssW));
      const h = Math.max(1, Math.round(cssH));
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const ctx = out.getContext("2d", { alpha: false });
      if (!ctx) return { ok: false as const };
      try {
        ctx.drawImage(el, 0, 0, w, h);
        const dataUrl = out.toDataURL("image/jpeg", 0.92);
        return {
          ok: true as const,
          b64: dataUrl.slice(dataUrl.indexOf(",") + 1),
        };
      } catch {
        return { ok: false as const };
      }
    },
    { attr, mediaValue, cssW, cssH },
  );
  return result && "ok" in result && result.ok ? result.b64 : null;
}

/**
 * 主图采帧：优先按元素真实绘制导出到 content-box 尺寸；再拉原图。
 * 尺寸必须等于 content-box（不含 padding/border）。
 */
export async function captureMediaSilentCanvas(
  page: Page,
  input: {
    attr: string;
    mediaValue: string;
    startX: number;
    startY: number;
    width: number;
    height: number;
    /** true：先 draw 元素（对齐屏幕），再 fetch */
    preferElementDraw?: boolean;
  },
): Promise<SilentFrame> {
  const meta = await readMediaMeta(page, input.attr, input.mediaValue);
  const cssW = Math.max(1, Math.round(input.width));
  const cssH = Math.max(1, Math.round(input.height));
  const startX = meta?.startX ?? input.startX;
  const startY = meta?.startY ?? input.startY;
  const preferDraw = input.preferElementDraw !== false;

  const tryDraw = async (): Promise<SilentFrame | null> => {
    if (meta?.kind === "canvas") {
      const b64 = await exportCanvasElement(
        page,
        input.attr,
        input.mediaValue,
        cssW,
        cssH,
      );
      if (b64) {
        return {
          b64,
          cssWidth: cssW,
          cssHeight: cssH,
          startX,
          startY,
          method: "canvas",
        };
      }
    }
    if (meta?.kind === "img") {
      const drawn = await exportImgElement(
        page,
        input.attr,
        input.mediaValue,
        cssW,
        cssH,
      );
      if (drawn) {
        return {
          b64: drawn,
          cssWidth: cssW,
          cssHeight: cssH,
          startX,
          startY,
          method: "canvas",
        };
      }
    }
    return null;
  };

  const tryFetch = async (): Promise<SilentFrame | null> => {
    if (meta?.kind !== "img" || !meta.src) return null;
    const raw = await fetchImageBuffer(page, meta.src);
    if (!raw) return null;
    const enc = await encodeBytesToJpegOnPage(page, raw, cssW, cssH);
    if (!enc?.b64) return null;
    return {
      b64: enc.b64,
      cssWidth: cssW,
      cssHeight: cssH,
      startX,
      startY,
      method: "fetch",
    };
  };

  if (preferDraw) {
    const drawn = await tryDraw();
    if (drawn) return drawn;
    const fetched = await tryFetch();
    if (fetched) return fetched;
  } else {
    const fetched = await tryFetch();
    if (fetched) return fetched;
    const drawn = await tryDraw();
    if (drawn) return drawn;
  }

  throw new Error("silent media capture failed (draw+fetch)");
}

/** 题干条：仅有内联图标时才采；纯文字跳过 */
export async function captureTipSilentCanvas(
  page: Page,
  input: { attr: string; hintValue: string },
): Promise<SilentFrame | null> {
  const result = await page.evaluate(async (p: { attr: string; hintValue: string }) => {
    const hint = document.querySelector(
      `[${p.attr}="${p.hintValue}"]`,
    ) as HTMLElement | null;
    if (!hint) return { ok: false as const };
    const bits = Array.from(hint.querySelectorAll("img,canvas,svg"));
    if (bits.length === 0) return { ok: false as const };

    const hr = hint.getBoundingClientRect();
    const w = Math.max(40, Math.ceil(hr.width));
    const h = Math.max(24, Math.ceil(hr.height));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return { ok: false as const };
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    const loadImg = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("fail"));
        im.src = src;
      });

    for (const bit of bits) {
      const br = bit.getBoundingClientRect();
      if (br.width < 4 || br.height < 4) continue;
      const dx = br.x - hr.x;
      const dy = br.y - hr.y;
      try {
        if (bit instanceof HTMLCanvasElement || bit instanceof HTMLImageElement) {
          if (bit instanceof HTMLImageElement && !bit.complete) {
            await bit.decode().catch(() => null);
          }
          ctx.drawImage(bit as CanvasImageSource, dx, dy, br.width, br.height);
        } else if (bit.tagName.toLowerCase() === "svg") {
          const xml = new XMLSerializer().serializeToString(bit);
          const url =
            "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
          const im = await loadImg(url);
          ctx.drawImage(im, dx, dy, br.width, br.height);
        }
      } catch {
        /* skip */
      }
    }

    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    return {
      ok: true as const,
      b64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      w,
      h,
      startX: hr.x,
      startY: hr.y,
    };
  }, input);

  if (!result || !("ok" in result) || !result.ok) return null;
  return {
    b64: result.b64,
    cssWidth: result.w,
    cssHeight: result.h,
    startX: result.startX,
    startY: result.startY,
    method: "canvas",
  };
}

export type TipIconPart = { b64: string; width: number; height: number };

/**
 * 题干条内联图标逐枚导出（完整答案小图，LTR）。
 * 比整条 tip 拼图更适合做模板对照。
 */
export async function captureTipIconParts(
  page: Page,
  input: { attr: string; hintValue: string },
): Promise<TipIconPart[]> {
  const raw = await page.evaluate(async (p: { attr: string; hintValue: string }) => {
    const hint = document.querySelector(
      `[${p.attr}="${p.hintValue}"]`,
    ) as HTMLElement | null;
    if (!hint) return [] as Array<{ b64: string; w: number; h: number; x: number }>;

    const loadImg = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("fail"));
        im.src = src;
      });

    const bits = Array.from(hint.querySelectorAll("img,canvas,svg"));
    const out: Array<{ b64: string; w: number; h: number; x: number }> = [];

    for (const bit of bits) {
      const br = bit.getBoundingClientRect();
      if (br.width < 8 || br.height < 8) continue;
      // 过滤过小装饰
      if (br.width * br.height < 120) continue;
      const w = Math.max(16, Math.ceil(br.width));
      const h = Math.max(16, Math.ceil(br.height));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) continue;
      ctx.fillStyle = "#111111";
      ctx.fillRect(0, 0, w, h);
      try {
        if (bit instanceof HTMLCanvasElement || bit instanceof HTMLImageElement) {
          if (bit instanceof HTMLImageElement && !bit.complete) {
            await bit.decode().catch(() => null);
          }
          ctx.drawImage(bit as CanvasImageSource, 0, 0, w, h);
        } else if (bit.tagName.toLowerCase() === "svg") {
          const xml = new XMLSerializer().serializeToString(bit);
          const url =
            "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
          const im = await loadImg(url);
          ctx.drawImage(im, 0, 0, w, h);
        } else {
          continue;
        }
      } catch {
        continue;
      }
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      out.push({
        b64: dataUrl.slice(dataUrl.indexOf(",") + 1),
        w,
        h,
        x: br.x,
      });
    }
    out.sort((a, b) => a.x - b.x);
    return out;
  }, input);

  return (raw ?? []).map((r) => ({
    b64: r.b64,
    width: r.w,
    height: r.h,
  }));
}

/** 最后手段（可能闪）：仅当静默失败 */
export async function captureCaptchaCdpFallback(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      const raw = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 88,
        fromSurface: false,
        captureBeyondViewport: false,
        clip: {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          scale: 1,
        },
      });
      const b64 = (raw as { data?: string }).data;
      if (b64) return Buffer.from(b64, "base64");
    } finally {
      await cdp.detach().catch(() => null);
    }
  } catch {
    /* fall through */
  }
  return captureScreenshot(page, {
    type: "jpeg",
    quality: 88,
    clip,
    scale: "css",
    animations: "disabled",
    caret: "hide",
  });
}
