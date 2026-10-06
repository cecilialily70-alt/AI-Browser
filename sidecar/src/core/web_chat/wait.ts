/**
 * 聊天模式的事件驱动等待（§6）—— **绝不用截图、绝不用 Node 轮询当主手段**
 *
 * 联网共识（Playwright 官方建议）：不要在 Node 侧轮询、更不要用截图判断；
 * 在页面内挂 `MutationObserver`，条件满足即 resolve。
 *
 * 首选：`waitForChatActivity` 在会话容器上观察 `childList + characterData + subtree`，
 * 出现「新条目 / 文本变化」即返回。硬超时兜底。
 * 兜底：观察不可用（极少数页面环境）→ 退回抖动轮询，并**如实标注** `chat_wait_fallback_poll`，
 * 不静默降级（§0.5.3：降级必须可见）。
 *
 * 另含「人工优先」探针：记录用户最近是否在该浏览器有输入，聊天引擎据此让位（§4.5 / R7）。
 */
import type { Page } from "playwright-core";

/* ————————————————————————— 人工优先探针 ————————————————————————— */

/**
 * 页内安装 + 读取，**一次 `page.evaluate` 完成**（自包含，不使用 `new Function` /
 * `eval` —— §0.5.3 B 明令禁止动态执行代码，本模块也不例外）。
 *
 * 只记录时间戳，**不采集用户输入了什么内容**（人工优先只需知道「有人在动」）。
 */
export interface UserActivityResult {
  active: boolean;
  lastActivityAt: number;
  probeAvailable: boolean;
}

/**
 * 用户最近 `windowMs` 内是否在动（人工优先）。
 * 探针不可用时**不阻拦**引擎（返回 `active: false` 并如实标 `probeAvailable: false`）。
 */
export async function detectRecentUserActivity(
  page: Page,
  windowMs = 20_000,
): Promise<UserActivityResult> {
  try {
    const result = await page.evaluate((windowSize: number) => {
      const FLAG = "__tst_chat_user_activity_installed";
      const AT = "__tst_chat_user_activity_at";
      const store = window as unknown as Record<string, unknown>;
      if (store[FLAG] !== true) {
        store[FLAG] = true;
        store[AT] = 0;
        const mark = (): void => {
          store[AT] = Date.now();
        };
        for (const type of ["keydown", "pointerdown", "mousedown", "input", "wheel"]) {
          document.addEventListener(type, mark, { capture: true, passive: true });
        }
      }
      const lastActivityAt = Number(store[AT] ?? 0) || 0;
      return {
        lastActivityAt,
        probeAvailable: true,
        active: lastActivityAt > 0 && Date.now() - lastActivityAt <= windowSize,
      };
    }, windowMs);
    const lastActivityAt = Number(result?.lastActivityAt ?? 0);
    return {
      active: Boolean(result?.active),
      lastActivityAt,
      probeAvailable: Boolean(result?.probeAvailable),
    };
  } catch {
    return { active: false, lastActivityAt: 0, probeAvailable: false };
  }
}

/* ————————————————————————— 事件驱动等待 ————————————————————————— */

export type ChatWaitSignal = "mutation" | "timeout" | "aborted" | "observer_unavailable" | "page_closed";

export interface WaitForChatActivityArg {
  selector: string;
  /** 观察起点：容器当前子节点数（用于判定「有新条目」） */
  baselineChildCount: number;
  /** 观察起点：容器当前文本长度（用于判定「文本变化」） */
  baselineTextLength: number;
  timeoutMs: number;
  /** 观察不可用时的兜底轮询间隔（毫秒） */
  pollIntervalMs: number;
}

export interface ChatActivityResult {
  signal: ChatWaitSignal;
  elapsedMs: number;
  childCount: number;
  textLength: number;
  /** 观察器是否真的挂上了（false → 走了兜底轮询，调用方必须如实记 `chat_wait_fallback_poll`） */
  observerAttached: boolean;
}

export interface WaitForChatActivityOptions {
  selector: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** 观察起点（缺省由本函数先读一次当前值） */
  baseline?: { childCount: number; textLength: number };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 15_000;

/** 页内读取容器当前规模（自包含） */
export async function readChatSliceSize(
  page: Page,
  selector: string,
): Promise<{ childCount: number; textLength: number } | null> {
  try {
    return await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return { childCount: el.children.length, textLength: (el.textContent ?? "").length };
    }, selector);
  } catch {
    return null;
  }
}

/**
 * 等待会话出现新动静。返回**为什么**醒来（`mutation` / `timeout` / …），由调用方如实落日志。
 */
export async function waitForChatActivity(
  page: Page,
  options: WaitForChatActivityOptions,
): Promise<ChatActivityResult> {
  const timeoutMs = Math.max(500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1000, options.pollIntervalMs ?? DEFAULT_POLL_MS);
  const selector = String(options.selector ?? "").trim();
  const started = Date.now();

  if (options.signal?.aborted) {
    return { signal: "aborted", elapsedMs: 0, childCount: 0, textLength: 0, observerAttached: false };
  }
  if (!selector) {
    return { signal: "observer_unavailable", elapsedMs: 0, childCount: 0, textLength: 0, observerAttached: false };
  }

  const baseline = options.baseline ?? (await readChatSliceSize(page, selector)) ?? {
    childCount: 0,
    textLength: 0,
  };

  let closed = false;
  try {
    closed = page.isClosed();
  } catch {
    closed = true;
  }
  if (closed) {
    return {
      signal: "page_closed",
      elapsedMs: 0,
      childCount: baseline.childCount,
      textLength: baseline.textLength,
      observerAttached: false,
    };
  }

  const arg: WaitForChatActivityArg = {
    selector,
    baselineChildCount: baseline.childCount,
    baselineTextLength: baseline.textLength,
    timeoutMs,
    pollIntervalMs,
  };

  const inPage = page.evaluate(
    (a: WaitForChatActivityArg) =>
      new Promise<{
        signal: "mutation" | "timeout" | "observer_unavailable";
        childCount: number;
        textLength: number;
        observerAttached: boolean;
      }>((resolve) => {
        const el = document.querySelector(a.selector);
        if (!el) {
          resolve({
            signal: "observer_unavailable",
            childCount: a.baselineChildCount,
            textLength: a.baselineTextLength,
            observerAttached: false,
          });
          return;
        }

        const sizeOf = (): { childCount: number; textLength: number } => ({
          childCount: el.children.length,
          textLength: (el.textContent ?? "").length,
        });

        let finished = false;
        let quietTimer = 0;
        let deadlineTimer = 0;
        let pollTimer = 0;
        let observer: MutationObserver | null = null;

        const finish = (
          signal: "mutation" | "timeout" | "observer_unavailable",
          observerAttached: boolean,
        ): void => {
          if (finished) return;
          finished = true;
          window.clearTimeout(quietTimer);
          window.clearTimeout(deadlineTimer);
          window.clearInterval(pollTimer);
          try {
            observer?.disconnect();
          } catch {
            /* ignore */
          }
          const size = sizeOf();
          resolve({ signal, childCount: size.childCount, textLength: size.textLength, observerAttached });
        };

        // 变化去抖：DOM 抖动常见，等一小段安静期再确认「这次变化是真的」
        const DEBOUNCE_MS = 250;
        const onMeaningfulChange = (): void => {
          window.clearTimeout(quietTimer);
          quietTimer = window.setTimeout(() => finish("mutation", true), DEBOUNCE_MS);
        };

        const changed = (): boolean => {
          const size = sizeOf();
          return (
            size.childCount !== a.baselineChildCount || size.textLength !== a.baselineTextLength
          );
        };

        try {
          observer = new MutationObserver((records) => {
            if (finished) return;
            for (const record of records) {
              if (record.type === "childList" && record.addedNodes.length > 0) {
                onMeaningfulChange();
                return;
              }
              if (record.type === "characterData") {
                onMeaningfulChange();
                return;
              }
            }
            // 只删不增：也检查规模是否变了（例如撤回、已读态重排）
            if (changed()) onMeaningfulChange();
          });
          observer.observe(el, { childList: true, characterData: true, subtree: true });
        } catch {
          observer = null;
        }

        if (!observer) {
          // 观察不可用 → 兜底轮询（调用方会如实标 chat_wait_fallback_poll）
          pollTimer = window.setInterval(() => {
            if (finished) return;
            if (changed()) finish("mutation", false);
          }, a.pollIntervalMs);
        }

        // 起点就已变化（读到 baseline 之后到挂观察器之间）：立即满足
        if (changed()) {
          finish("mutation", observer !== null);
          return;
        }

        deadlineTimer = window.setTimeout(() => finish("timeout", observer !== null), a.timeoutMs);
      }),
    arg,
  );

  let aborted = false;
  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<null>((resolve) => {
    if (!options.signal) return;
    abortListener = () => {
      aborted = true;
      resolve(null);
    };
    if (options.signal.aborted) {
      aborted = true;
      resolve(null);
      return;
    }
    options.signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    const outcome = await Promise.race([inPage, abortPromise]);
    if (outcome === null || aborted) {
      return {
        signal: "aborted",
        elapsedMs: Date.now() - started,
        childCount: baseline.childCount,
        textLength: baseline.textLength,
        observerAttached: false,
      };
    }
    return {
      signal: outcome.signal,
      elapsedMs: Date.now() - started,
      childCount: outcome.childCount,
      textLength: outcome.textLength,
      observerAttached: outcome.observerAttached,
    };
  } catch {
    // 页面在等待期间关闭 / 导航：不是「没有新消息」，如实区分
    return {
      signal: "page_closed",
      elapsedMs: Date.now() - started,
      childCount: baseline.childCount,
      textLength: baseline.textLength,
      observerAttached: false,
    };
  } finally {
    if (abortListener && options.signal) {
      options.signal.removeEventListener("abort", abortListener);
    }
    // 若因 abort 提前返回，页内 promise 仍会自行超时结束（无副作用），不额外等待
  }
}
