import type { Page } from "playwright-core";

import { resolveGateway } from "./core/action_gateway.js";
import type { JsonLogger } from "./json-logger.js";

async function nativeSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 填表完成后按 Playwright 最佳实践在末字段或页面级触发 Enter 提交 */
export async function pressEnterAfterFillIfEnabled(
  page: Page,
  logger: JsonLogger,
  enabled: boolean,
  lastFilledSelector?: string | null,
): Promise<void> {
  if (!enabled) {
    return;
  }

  await nativeSleep(400);
  logger.progress("fill_press_enter", { selector: lastFilledSelector ?? null });

  const gw = resolveGateway(page);
  const noRecord = { record: false as const, skipSettle: true };

  const selector = lastFilledSelector?.trim();
  if (selector) {
    try {
      await page.locator(selector).first().focus({ timeout: 5_000 });
      await gw.executeKeyPress("Enter", noRecord);
      logger.progress("fill_press_enter_done", { method: "gateway_keypress_focused" });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("fill_press_enter_locator_failed", { selector, error: message });
    }
  }

  await gw.executeKeyPress("Enter", noRecord);
  logger.progress("fill_press_enter_done", { method: "gateway_keypress" });
}

export function resolveLastFilledSelector(
  selectors: Array<string | undefined | null>,
): string | null {
  for (let index = selectors.length - 1; index >= 0; index -= 1) {
    const selector = selectors[index]?.trim();
    if (selector) {
      return selector;
    }
  }
  return null;
}
