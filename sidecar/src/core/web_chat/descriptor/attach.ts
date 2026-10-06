/**
 * 出站发图：**只走附件 UI + Playwright filechooser / setInputFiles**（R8）
 *
 * 与 `composer.ts` 并列：文字走输入框，图片走回形针。禁止：
 *   - 调站点内部发送 / 上传函数
 *   - 自建网络请求把文件发出去
 *   - 一次调用提交两次
 *
 * Telegram 等站的 file input 往往要点附件才会挂上 DOM，所以顺序固定为
 * 先 `waitForEvent('filechooser')` 再点按钮，拿不到 chooser 再兜底 `setInputFiles`。
 */

import { existsSync } from "node:fs";
import type { Page } from "playwright-core";

import { resolveGateway } from "../../action_gateway.js";
import { firstVisibleSelector } from "./composer.js";
import type { ComposerSpec } from "./types.js";

const SETTLE_MS = 400;
const CHOOSER_MS = 8_000;
const PREVIEW_MS = 12_000;

const sendingPages = new WeakSet<Page>();

export interface AttachSendResult {
  ok: boolean;
  reason?: string;
  committed?: boolean;
  diagnostics?: {
    usedChooser: boolean;
    usedInput: boolean;
    button?: string | null;
    preview?: boolean;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

async function firstAttachedSelector(page: Page, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) {
    const trimmed = String(selector ?? "").trim();
    if (!trimmed) continue;
    try {
      const count = await page.locator(trimmed).count();
      if (count > 0) return trimmed;
    } catch {
      /* 选择器不合法：跳过 */
    }
  }
  return null;
}

async function waitForAny(page: Page, selectors: readonly string[], timeoutMs: number): Promise<string | null> {
  if (selectors.length === 0) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await firstVisibleSelector(page, selectors);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

/**
 * 把本地图片交给站点附件 UI，最多提交一次。
 */
export async function sendViaAttach(
  page: Page,
  spec: ComposerSpec,
  filePath: string,
  options: { signal?: AbortSignal; semanticLabel?: string } = {},
): Promise<AttachSendResult> {
  const attach = spec.attach;
  if (!attach || attach.buttonSelectors.length === 0) {
    return { ok: false, reason: "unsupported_attach" };
  }
  const abs = String(filePath ?? "").trim();
  if (!abs) return { ok: false, reason: "empty_path" };
  if (!existsSync(abs)) return { ok: false, reason: "file_missing" };
  if (options.signal?.aborted) return { ok: false, reason: "aborted" };
  if (sendingPages.has(page)) return { ok: false, reason: "send_locked" };
  sendingPages.add(page);

  const gateway = resolveGateway(page);
  const diagnostics: NonNullable<AttachSendResult["diagnostics"]> = {
    usedChooser: false,
    usedInput: false,
    button: null,
    preview: false,
  };

  try {
    const button = await firstVisibleSelector(page, attach.buttonSelectors);
    if (!button) return { ok: false, reason: "attach_button_missing", diagnostics };

    const chooserPromise = page.waitForEvent("filechooser", { timeout: CHOOSER_MS }).catch(() => null);

    await gateway.click(button, { semanticLabel: options.semanticLabel ?? "打开附件" });
    diagnostics.button = button;
    await sleep(SETTLE_MS);

    if (attach.menuItemSelectors.length > 0) {
      const menu = await firstVisibleSelector(page, attach.menuItemSelectors);
      if (menu) {
        await gateway.click(menu, { semanticLabel: "选择照片或视频" });
        await sleep(SETTLE_MS);
      }
    }

    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(abs);
      diagnostics.usedChooser = true;
    } else {
      const inputSel =
        (await firstAttachedSelector(page, attach.fileInputSelectors)) ??
        (await firstAttachedSelector(page, ['input[type="file"]']));
      if (!inputSel) return { ok: false, reason: "file_chooser_missing", diagnostics };
      await page.locator(inputSel).first().setInputFiles(abs);
      diagnostics.usedInput = true;
    }

    if (attach.previewReadySelectors.length > 0) {
      const preview = await waitForAny(page, attach.previewReadySelectors, PREVIEW_MS);
      diagnostics.preview = Boolean(preview);
      if (!preview) return { ok: false, reason: "preview_missing", diagnostics };
    } else {
      await sleep(SETTLE_MS);
    }

    const confirmSel =
      (await firstVisibleSelector(page, attach.confirmSendSelectors)) ??
      (await firstVisibleSelector(page, spec.send.selectors));
    if (confirmSel) {
      await gateway.click(confirmSel, { semanticLabel: options.semanticLabel ?? "发送图片" });
    } else {
      await page.keyboard.press("Enter");
    }
    await sleep(SETTLE_MS);
    return { ok: true, committed: true, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `attach_failed:${message.slice(0, 180)}`, diagnostics };
  } finally {
    sendingPages.delete(page);
  }
}
