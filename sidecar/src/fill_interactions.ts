import type { Locator, Page } from "playwright-core";

import { resolveGateway } from "./core/action_gateway.js";

const KEYSTROKE_DELAY_MS = 50;
const INTERACTION_TIMEOUT_MS = 3000;
const SELECT_TRY_TIMEOUT_MS = 1500;
const CASCADE_SELECT_WAIT_MS = 5000;
const SELECT_CASCADE_SETTLE_MS = 500;

/** Fill/RPA：走网关抗干扰，禁止写入 Agent 轨迹 */
const FILL_GW = { record: false as const, skipSettle: true };

/** 页面生命周期检查：关闭后禁止继续 Playwright 操作 */
export function assertPageAlive(page: Page): void {
  if (page.isClosed()) {
    throw new Error("检测到页面已经被关闭，停止当前执行任务。");
  }
}

function typingTimeoutMs(value: string, baseMs: number): number {
  return Math.max(baseMs, value.length * (KEYSTROKE_DELAY_MS + 10) + 1500);
}

export function isAddressLikeField(dataKey: string, selector: string): boolean {
  const normalizedKey = dataKey.trim().toLowerCase();
  const normalizedSelector = selector.trim().toLowerCase();
  return (
    normalizedKey.includes("address") ||
    normalizedKey.includes("street") ||
    normalizedSelector.includes("address") ||
    normalizedSelector.includes("street")
  );
}

export async function bypassAddressAutocompleteManualEntry(page: Page): Promise<boolean> {
  assertPageAlive(page);
  const manualBtn = page
    .locator(
      'button:has-text("Enter address manually"), a:has-text("Enter address manually"), [data-robot="shipping-expandAddress"]',
    )
    .first();

  const visible = await manualBtn.isVisible().catch(() => false);
  if (!visible) {
    return false;
  }

  await resolveGateway(page).click(manualBtn, {
    ...FILL_GW,
    timeoutMs: INTERACTION_TIMEOUT_MS,
    semanticLabel: "Enter address manually",
  });
  await page.waitForTimeout(500);
  return true;
}

export async function fillAddressFieldWithAutocomplete(
  page: Page,
  locator: Locator,
  value: string,
  timeoutMs: number,
): Promise<void> {
  assertPageAlive(page);
  const effectiveTimeout = typingTimeoutMs(value, timeoutMs);
  await locator.waitFor({ state: "attached", timeout: effectiveTimeout });

  await bypassAddressAutocompleteManualEntry(page);

  const gw = resolveGateway(page);
  await gw.fill(locator, value, {
    ...FILL_GW,
    humanLike: true,
    timeoutMs: effectiveTimeout,
  });

  assertPageAlive(page);
  await page.waitForTimeout(1000);
  await gw.executeKeyPress("ArrowDown", FILL_GW).catch(() => undefined);
  await gw.executeKeyPress("Enter", FILL_GW).catch(() => undefined);
  await page.waitForTimeout(200);
}

async function waitForSelectOptionLoaded(
  page: Page,
  selector: string,
  targetValue: string,
  timeoutMs: number,
): Promise<boolean> {
  assertPageAlive(page);
  const trimmed = targetValue.trim();
  if (!trimmed || !selector.trim()) {
    return false;
  }

  try {
    await page.waitForFunction(
      ({ sel, val }) => {
        const el = document.querySelector(sel);
        if (!(el instanceof HTMLSelectElement)) {
          return false;
        }
        const normalized = val.trim().toLowerCase();
        return Array.from(el.options).some((opt) => {
          const optionValue = opt.value.trim().toLowerCase();
          const optionText = opt.text.trim().toLowerCase();
          return (
            optionValue === normalized ||
            optionText.includes(normalized) ||
            normalized.includes(optionText)
          );
        });
      },
      { sel: selector, val: trimmed },
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

export async function forceFocusElement(locator: Locator): Promise<void> {
  await locator
    .evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.focus({ preventScroll: true });
      }
    })
    .catch(() => undefined);
}

/**
 * 通过 HTMLSelectElement.prototype.value 的原生 setter 强制写入，
 * 绕过 React/Vue 对实例属性的劫持，再派发 input/change/blur 激活框架监听。
 */
async function injectSelectViaNativePrototypeSetter(
  locator: Locator,
  targetValue: string,
): Promise<void> {
  await locator.evaluate((node, val) => {
    if (!(node instanceof HTMLSelectElement)) {
      throw new Error("element is not a select");
    }

    const sel = node;
    const normalized = val.trim().toLowerCase();
    const targetOpt = Array.from(sel.options).find((opt) => {
      const optionValue = opt.value.trim();
      const optionText = opt.text.trim().toLowerCase();
      return (
        optionValue === val ||
        optionValue.toLowerCase() === normalized ||
        optionText.includes(normalized) ||
        (optionText.length > 0 && normalized.includes(optionText))
      );
    });

    const finalValue = targetOpt ? targetOpt.value : val;

    const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;

    if (nativeSelectValueSetter) {
      nativeSelectValueSetter.call(sel, finalValue);
    } else {
      sel.value = finalValue;
    }

    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    sel.dispatchEvent(new Event("blur", { bubbles: true }));
  }, targetValue);
}

export async function selectOptionWithFallback(
  page: Page,
  locator: Locator,
  value: string,
  timeoutMs: number,
  selector?: string,
  onCascadeTimeout?: (message: string) => void,
): Promise<void> {
  assertPageAlive(page);
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("select value is empty");
  }

  try {
    const tryTimeout = Math.min(timeoutMs, SELECT_TRY_TIMEOUT_MS);
    await locator.waitFor({ state: "attached", timeout: timeoutMs });
    await forceFocusElement(locator);

    if (selector) {
      const loaded = await waitForSelectOptionLoaded(
        page,
        selector,
        trimmed,
        Math.max(timeoutMs, CASCADE_SELECT_WAIT_MS),
      );
      if (!loaded) {
        onCascadeTimeout?.(
          `[RPA Warning] 级联选项 ${trimmed} 加载超时，尝试强行注入`,
        );
      }
    }

    const valueOk = await locator
      .selectOption({ value: trimmed }, { force: true, timeout: tryTimeout })
      .then(() => true)
      .catch(() => false);
    if (valueOk) {
      assertPageAlive(page);
      await page.waitForTimeout(SELECT_CASCADE_SETTLE_MS);
      return;
    }

    const labelOk = await locator
      .selectOption({ label: trimmed }, { force: true, timeout: tryTimeout })
      .then(() => true)
      .catch(() => false);
    if (labelOk) {
      assertPageAlive(page);
      await page.waitForTimeout(SELECT_CASCADE_SETTLE_MS);
      return;
    }

    try {
      await injectSelectViaNativePrototypeSetter(locator, trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Select 强制破解注入失败: ${message}`);
    }

    assertPageAlive(page);
    await page.waitForTimeout(SELECT_CASCADE_SETTLE_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`selectOptionWithFallback failed: ${message}`);
  }
}
