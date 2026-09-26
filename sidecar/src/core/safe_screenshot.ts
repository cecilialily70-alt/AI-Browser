/**
 * 截图兜底：先确保标签在前台，再带超时截图；失败后提升到前台重试一次。
 *
 * 为什么需要（§0.5.3「截图类」坑族）：
 * 后台标签的渲染合成可能被 Chromium 节流甚至暂停，`page.screenshot()` 于是会**挂住或超时**。
 * 这不是页面坏了，而是「没人在前台看它」。视觉完成条件、视觉定位、Agent 的 screenshot 动作
 * 都会因此**随机**失败 —— 时好时坏，最难查。
 *
 * 纪律：
 * - 只做前台唤醒 + 超时 + 重试，**不改浏览器启动参数、不改指纹**（R3）；
 * - 已在最前的标签不重复 bringToFront（避免无意义地抢用户焦点）；
 * - 页面已关闭 / 上下文销毁这类**真错误**不重试，直接抛出（不要用 `err.message.includes`
 *   当主路径，这里按 Playwright 的错误类型判断）。
 */
import type { BrowserContext, Page, PageScreenshotOptions } from "playwright-core";

/** 每个上下文里最后一次被我们提到前台的页（避免重复唤醒） */
const frontmostHint = new WeakMap<BrowserContext, Page>();

export interface CaptureScreenshotOptions extends PageScreenshotOptions {
  /** 截图超时（默认 15s：后台标签偶发卡顿也能兜住，又不会拖死主循环） */
  timeoutMs?: number;
  /** 跳过前台唤醒（仅当你已确认标签在最前时用） */
  skipForeground?: boolean;
}

async function bringToFrontSafe(page: Page): Promise<boolean> {
  try {
    await page.bringToFront();
    try {
      frontmostHint.set(page.context(), page);
    } catch {
      // 上下文已销毁：无所谓，取不到就别记
    }
    return true;
  } catch {
    return false;
  }
}

/** 该页是否已知在最前（拿不准时返回 false → 唤醒一次，宁可多一次也不赌） */
function knownFrontmost(page: Page): boolean {
  try {
    return frontmostHint.get(page.context()) === page;
  } catch {
    return false;
  }
}

/** 页面/上下文已销毁：这类错误重试没有意义 */
function isGoneError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name ?? "";
  const message = String((error as { message?: string }).message ?? "");
  return (
    name === "TargetClosedError" ||
    /Target (page|closed)|context or browser has been closed|Page has been closed/i.test(message)
  );
}

/**
 * 统一的截图入口。所有「为了看清页面」的截图都应该走这里，
 * 避免每个调用点自己 sleep / 自己重试（DRY，且行为一致）。
 */
export async function captureScreenshot(
  page: Page,
  options: CaptureScreenshotOptions = {},
): Promise<Buffer> {
  const { timeoutMs, skipForeground = false, ...shot } = options;
  // 调用方自己传了 timeout（PageScreenshotOptions 里的标准字段）就尊重它，不要被默认值盖掉
  const effectiveTimeout = timeoutMs ?? shot.timeout ?? 15_000;
  if (!skipForeground && !knownFrontmost(page)) {
    await bringToFrontSafe(page);
  }
  try {
    return await page.screenshot({ ...shot, timeout: effectiveTimeout });
  } catch (error) {
    if (isGoneError(error)) throw error;
    // 第一次多半是后台节流/合成暂停：强制唤醒后再给一次机会。
    await bringToFrontSafe(page);
    return await page.screenshot({ ...shot, timeout: effectiveTimeout });
  }
}
