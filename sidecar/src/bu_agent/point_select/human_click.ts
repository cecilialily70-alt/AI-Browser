/**
 * 拟人点击：modelPixel + live rect → CSS 视口
 * final = rect.left + modelX（1:1）
 */
import type { Page } from "playwright-core";
import type { JsonLogger } from "../../json-logger.js";
import {
  clampToViewport,
  modelPixelToViewport,
  readLiveMediaRect,
  type UnitPoint,
} from "./coord_map.js";
import type { PixelPoint } from "./types.js";
import { sleep } from "../captcha_utils.js";

/**
 * 移动鼠标到目标点：轨迹交由 CloakBrowser 内核（humanize）生成。
 *
 * 内核已重写 `page.mouse.move`，单次调用即生成 Bezier 曲线 + 加速度偏移。
 * 旧实现自己算二次贝塞尔 + 缓动 + 抖动，并在循环里调用 14~40 次 move，
 * 等于在内核曲线上再套一层曲线（N 次相乘），既慢又破坏仿生特征。
 */
async function moveKernel(
  page: Page,
  from: PixelPoint,
  to: PixelPoint,
  signal?: AbortSignal,
): Promise<void> {
  void from; // 起点由内核内部光标跟踪，无需自行维护
  if (signal?.aborted) throw new Error("Agent 已中止");
  await page.mouse.move(to.x, to.y);
}

/** 验证码抖动极小，避免偏离质心 */
export function jitterPoint(base: PixelPoint, amplitude = 0.8): PixelPoint {
  const a = Math.max(0, amplitude);
  return {
    x: base.x + (Math.random() - 0.5) * 2 * a,
    y: base.y + (Math.random() - 0.5) * 2 * a,
  };
}

export { toViewportPoints, resolveCropDpr } from "./coord_map.js";

/**
 * 按模型像素拟人点击；每点前 live getBoundingClientRect
 */
export async function humanClickSequence(input: {
  page: Page;
  logger: JsonLogger;
  units?: UnitPoint[];
  imageWidth?: number;
  imageHeight?: number;
  viewportPoints?: PixelPoint[];
  signal?: AbortSignal;
}): Promise<{ clicked: number; viewportPoints: PixelPoint[] }> {
  const units = input.units ?? [];
  const imgW = Math.max(1, input.imageWidth ?? 1);
  const imgH = Math.max(1, input.imageHeight ?? 1);
  const planned: PixelPoint[] = [];
  let clicked = 0;
  let cursor = { x: 80 + Math.random() * 40, y: 120 + Math.random() * 40 };
  try {
    const pos = await input.page.evaluate(() => ({
      x: (window as unknown as { __cfMx?: number }).__cfMx,
      y: (window as unknown as { __cfMy?: number }).__cfMy,
    }));
    if (typeof pos?.x === "number" && typeof pos?.y === "number") {
      cursor = { x: pos.x, y: pos.y };
    }
  } catch {
    /* keep */
  }

  const vp = input.page.viewportSize();
  const vw = vp?.width ?? 1280;
  const vh = vp?.height ?? 800;
  const n = units.length > 0 ? units.length : (input.viewportPoints?.length ?? 0);

  for (let i = 0; i < n; i++) {
    if (input.signal?.aborted) throw new Error("Agent 已中止");

    let base: PixelPoint;
    if (units.length > 0) {
      const live = await readLiveMediaRect(input.page);
      if (!live) throw new Error("点击前无法读取媒体 getBoundingClientRect");
      if (
        live.canvasInternalW &&
        live.canvasInternalH &&
        (Math.abs(live.canvasInternalW - live.width) > 2 ||
          Math.abs(live.canvasInternalH - live.height) > 2)
      ) {
        input.logger.warn("point_select_canvas_internal_scale", {
          css: { w: live.width, h: live.height },
          internal: { w: live.canvasInternalW, h: live.canvasInternalH },
          note: "点击用 CSS rect + modelPixel，不用 canvas 内部像素",
        });
      }
      if (
        (live.contentInsetX && live.contentInsetX > 0.5) ||
        (live.contentInsetY && live.contentInsetY > 0.5)
      ) {
        input.logger.agentProgress(
          `已扣除边框/内边距 ${live.contentInsetX?.toFixed(0) ?? 0}×${live.contentInsetY?.toFixed(0) ?? 0}px，避免点偏右下`,
          { phase: "point_select_captcha", stage: "content_box" },
        );
      }
      const u = units[i]!;
      base = modelPixelToViewport(live, u.modelX, u.modelY, imgW, imgH);
      base = clampToViewport(base, vw, vh);

      input.logger.agentProgress(
        `[核对] 画面内容区左上角 (${live.left.toFixed(0)}, ${live.top.toFixed(0)})；` +
          `AI 说点图内 (${u.modelX.toFixed(0)}, ${u.modelY.toFixed(0)})；` +
          `鼠标要点 (${base.x.toFixed(0)}, ${base.y.toFixed(0)})`,
        {
          phase: "point_select_captcha",
          stage: "debug_coord",
          i: i + 1,
        },
      );
    } else {
      base = input.viewportPoints![i]!;
    }

    const target = jitterPoint(base, 0.8);
    planned.push(target);

    input.logger.agentProgress(
      `⑤ 正在点第 ${i + 1}/${n} 下（屏幕 ${target.x.toFixed(0)}, ${target.y.toFixed(0)}）`,
      {
        phase: "point_select_captcha",
        stage: "click",
        i: i + 1,
        x: target.x,
        y: target.y,
        modelX: units[i]?.modelX,
        modelY: units[i]?.modelY,
      },
    );

    await moveKernel(input.page, cursor, target, input.signal);
    await sleep(40 + Math.floor(Math.random() * 40));
    await input.page.mouse.down();
    // down→up：80–150ms
    await sleep(80 + Math.floor(Math.random() * 71));
    await input.page.mouse.up();
    clicked += 1;
    cursor = target;

    if (i < n - 1) {
      // 多目标间隔 400–700ms
      await sleep(400 + Math.floor(Math.random() * 301));
    }
  }
  return { clicked, viewportPoints: planned };
}

/**
 * 点击后尝试触发验证确认类按钮（不点「提交参赛代码」以免误交参赛）。
 * 仅认「确认/验证」类短标签；刷新、换图、条款、取消等一律跳过，
 * 避免把「确认条款」「验证码刷新」当成提交按钮误点。
 */
export async function maybeClickCaptchaConfirm(
  page: Page,
  logger: JsonLogger,
): Promise<boolean> {
  await sleep(300);
  const clicked = await page
    .evaluate(() => {
      const confirmRe = /^(确认|确定|验证|提交验证|完成验证|确认提交|确认验证|submit|confirm|verify)$/i;
      const skipRe = /提交参赛|参赛|刷新|换一张|换一个|重新获取|重新发送|条款|协议|取消|关闭|返回/;
      const nodes = Array.from(
        document.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']"),
      );
      for (const el of nodes) {
        const t = (
          (el as HTMLElement).innerText ||
          (el as HTMLInputElement).value ||
          ""
        )
          .replace(/\s+/g, "")
          .replace(/[。.!！?？,，]+$/, "")
          .trim();
        if (!t || skipRe.test(t) || !confirmRe.test(t)) continue;
        (el as HTMLElement).click();
        return t;
      }
      return "";
    })
    .catch(() => "");
  if (clicked) {
    logger.agentProgress(`点完后顺手点了「${clicked}」按钮`, {
      phase: "point_select_captcha",
      stage: "confirm",
    });
    return true;
  }
  return false;
}
