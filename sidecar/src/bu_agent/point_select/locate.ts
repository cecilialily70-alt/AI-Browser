/**
 * 定位主画布 img/canvas 的 content-box 并静默采帧。
 * 铁律：只用元素 content-box；禁止父容器；禁止 padding 并入原点。
 */
import type { Page } from "playwright-core";
import type { AgentFileSystem } from "../filesystem.js";
import type { CaptchaCrop } from "./types.js";
import { isDomInstructionUnreliable } from "./dom_hint.js";
import { readJpegSize } from "./jpeg_size.js";
import {
  locateMediaElement,
  MEDIA_ATTR,
  readMediaContentBox,
  type MediaContentBox,
} from "./media_box.js";
import {
  captureCaptchaCdpFallback,
  captureMediaSilentCanvas,
  captureTipIconParts,
  captureTipSilentCanvas,
  softScrollMediaIntoView,
  waitCaptureSettle,
} from "./silent_capture.js";

export type LocateShot = {
  crop: CaptchaCrop;
  buf: Buffer;
  b64: string;
  path?: string;
  tipB64?: string;
  /** 题干内联图标逐枚（LTR 完整答案小图） */
  tipIcons?: string[];
  captureMethod?: "fetch" | "canvas" | "cdp_fallback";
  /** content-box 诊断 */
  contentBox?: MediaContentBox;
};

export async function clearPointCropMark(page: Page): Promise<void> {
  await page
    .evaluate((attr) => {
      document.querySelectorAll(`[${attr}]`).forEach((el) =>
        el.removeAttribute(attr),
      );
    }, MEDIA_ATTR)
    .catch(() => null);
}

function boxToCrop(
  box: MediaContentBox,
  instruction: string,
  imageWidth: number,
  imageHeight: number,
): CaptchaCrop {
  return {
    startX: box.left,
    startY: box.top,
    width: box.width,
    height: box.height,
    imageWidth,
    imageHeight,
    dpr: imageWidth / Math.max(1, box.width),
    instruction,
    instructionUnreliable: isDomInstructionUnreliable(instruction),
  };
}

/** 微滚 → 稳定 → 按 content-box 采主图 */
export async function locateAndCaptureCaptcha(
  page: Page,
  fileSystem?: AgentFileSystem,
): Promise<LocateShot | null> {
  const first = await locateMediaElement(page);
  if (!first) return null;

  const didScroll = await softScrollMediaIntoView(page, MEDIA_ATTR, "media");
  if (didScroll) await waitCaptureSettle();
  await waitCaptureSettle(didScroll ? 280 : 360);

  // 滚动后再定位一次，保证标记与 content-box 最新
  const located = await locateMediaElement(page);
  if (!located) return null;

  let box = located.box;
  // 采帧直前再读一次 content-box（与截图紧耦合）
  const live = await readMediaContentBox(page);
  if (live) box = live;

  if (box.width < 80 || box.height < 40) return null;

  // padding 诊断：有 padding/border 时旧逻辑会右下漂
  const padDrift =
    Math.abs(box.paddingLeft) > 0.5 || Math.abs(box.paddingTop) > 0.5;

  let buf: Buffer;
  let captureMethod: "fetch" | "canvas" | "cdp_fallback" = "canvas";
  try {
    // 优先按元素真实绘制导出（尊重 object-fit）；尺寸=content-box
    const silent = await captureMediaSilentCanvas(page, {
      attr: MEDIA_ATTR,
      mediaValue: "media",
      startX: box.left,
      startY: box.top,
      width: box.width,
      height: box.height,
      preferElementDraw: true,
    });
    buf = Buffer.from(silent.b64, "base64");
    captureMethod = silent.method;
  } catch {
    captureMethod = "cdp_fallback";
    await waitCaptureSettle(400);
    buf = await captureCaptchaCdpFallback(page, {
      x: Math.max(0, Math.floor(box.left)),
      y: Math.max(0, Math.floor(box.top)),
      width: Math.max(1, Math.floor(box.width)),
      height: Math.max(1, Math.floor(box.height)),
    });
  }

  let tipB64: string | undefined;
  let tipIcons: string[] = [];
  try {
    const tip = await captureTipSilentCanvas(page, {
      attr: MEDIA_ATTR,
      hintValue: "hint",
    });
    if (tip?.b64) tipB64 = tip.b64;
    const parts = await captureTipIconParts(page, {
      attr: MEDIA_ATTR,
      hintValue: "hint",
    });
    tipIcons = parts.map((p) => p.b64);
  } catch {
    tipB64 = undefined;
    tipIcons = [];
  }

  // 采帧后再读 content-box（禁止中间滚动）
  const after = await readMediaContentBox(page);
  const finalBox = after ?? box;

  const bitmap = readJpegSize(buf);
  let imageWidth = bitmap?.w ?? Math.round(finalBox.width);
  let imageHeight = bitmap?.h ?? Math.round(finalBox.height);

  // 若位图与 content-box 偏差过大，强制记为需比例映射
  if (
    Math.abs(imageWidth - finalBox.width) > 2 ||
    Math.abs(imageHeight - finalBox.height) > 2
  ) {
    // 保持真实位图尺寸；点击路径会按比例缩到 content-box
  }

  let path: string | undefined;
  if (fileSystem) {
    path = fileSystem.writeBinaryFile(
      `captcha_point_media_${captureMethod}_${Date.now()}.jpg`,
      buf,
    );
    if (tipB64) {
      fileSystem.writeBinaryFile(
        `captcha_point_tip_${Date.now()}.jpg`,
        Buffer.from(tipB64, "base64"),
      );
    }
    tipIcons.forEach((b64, i) => {
      fileSystem.writeBinaryFile(
        `captcha_point_tip_icon_${i}_${Date.now()}.jpg`,
        Buffer.from(b64, "base64"),
      );
    });
    if (padDrift) {
      fileSystem.writeFile(
        `captcha_point_box_${Date.now()}.json`,
        JSON.stringify({ finalBox, padDrift, captureMethod }, null, 2),
      );
    }
  }

  return {
    crop: boxToCrop(
      finalBox,
      located.instruction,
      imageWidth,
      imageHeight,
    ),
    buf,
    b64: buf.toString("base64"),
    tipB64,
    tipIcons: tipIcons.length ? tipIcons : undefined,
    path,
    captureMethod,
    contentBox: finalBox,
  };
}
