import type { Page } from "playwright-core";

import {
  assertPageAlive,
  fillAddressFieldWithAutocomplete,
  isAddressLikeField,
  selectOptionWithFallback,
} from "../fill_interactions.js";
import { resolveGateway } from "../core/action_gateway.js";
import { safeGoto } from "../cdp_session.js";
import type { JsonLogger } from "../json-logger.js";
import type { RpaAction } from "./types.js";

const ELEMENT_TIMEOUT_MS = 3000;
const RPA_NO_RECORD = { record: false as const, skipSettle: true };

/** 单步 RPA 动作执行器 */
export async function executeRpaAction(
  page: Page,
  action: RpaAction,
  data: Record<string, string>,
  logger: JsonLogger,
): Promise<void> {
  assertPageAlive(page);

  if (action.type === "navigate") {
    const target = String(action.value ?? action.url ?? action.selector ?? "").trim();
    if (!target) {
      throw new Error("navigate 缺少目标 URL");
    }
    logger.progress("rpa_navigate", { step: action.step, url: target });
    await safeGoto(page, target);
    return;
  }

  if (action.type === "wait") {
    const delayMs = Number(action.value ?? 500);
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 500));
    return;
  }

  const locator = page.locator(action.selector).first();
  try {
    await locator.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  } catch {
    throw new Error(`目标元素不可见或不存在: ${action.selector}`);
  }

  const gw = resolveGateway(page);

  switch (action.type) {
    case "fill": {
      const dataKey = action.dataKey ?? "";
      const value = data[dataKey] ?? action.value ?? "";
      if (isAddressLikeField(dataKey, action.selector)) {
        logger.progress("rpa_address_autocomplete_bypass", {
          step: action.step,
          dataKey,
          selector: action.selector,
        });
        await fillAddressFieldWithAutocomplete(page, locator, value, ELEMENT_TIMEOUT_MS);
        return;
      }
      await gw.fill(locator, value, {
        ...RPA_NO_RECORD,
        humanLike: true,
        timeoutMs: ELEMENT_TIMEOUT_MS,
        semanticLabel: dataKey || action.selector,
      });
      return;
    }
    case "select": {
      const dataKey = action.dataKey ?? "";
      const value = data[dataKey] ?? action.value ?? "";
      const isCascadeField =
        /region|province|state|zone|city|country|area|district/i.test(
          `${dataKey} ${action.selector}`,
        );
      if (isCascadeField) {
        logger.progress("rpa_cascade_select_wait", {
          step: action.step,
          dataKey,
          selector: action.selector,
          targetValue: value,
        });
      }
      await selectOptionWithFallback(
        page,
        locator,
        value,
        ELEMENT_TIMEOUT_MS,
        action.selector,
        (message) => {
          logger.warn("rpa_cascade_select_timeout", {
            step: action.step,
            selector: action.selector,
            targetValue: value,
            message,
          });
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    case "click":
      await gw.click(locator, {
        ...RPA_NO_RECORD,
        timeoutMs: ELEMENT_TIMEOUT_MS,
        semanticLabel: action.selector,
      });
      return;
    default:
      throw new Error(`unsupported rpa action type: ${String(action.type)}`);
  }
}
