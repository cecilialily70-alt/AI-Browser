/**
 * 回放用「新标签」生命周期管理（N4 / N8）。
 *
 * 语义（执行计划.md §4.1，写死防止实现时各说各话）：
 *   - 默认 `openInNewTab = true`：回放开始前在当前 context 里 `newPage()`，该页成为**绑定活动页**；
 *   - 每轮新标签：`repeatCount > 1` 时第 i 轮用第 i 个标签（每轮结束后为下一轮新建）；
 *   - 标签去留：默认**保留**（用户要看结果）；`closePrevious` 开启时每轮开始前关掉上一轮；
 *   - 硬上限：单环境回放标签数 ≤ 20；达到上限时**不静默** —— 记日志并自动关最旧的
 *     「本轮之前由回放创建的标签」（只关自己开的，不碰用户手开的）。
 *
 * 只跟踪**回放自己创建的页**（WeakMap 以 BrowserContext 为键），不碰用户已打开的标签；
 * 稳定 id 由 `bu_agent/tab_registry.ts` 统一分配。
 */
import type { BrowserContext, Page } from "playwright-core";

import { tabIdOf } from "../bu_agent/tab_registry.js";

/** 每个 context 里由回放创建、仍存活的页（按创建顺序） */
const replayTabs = new WeakMap<BrowserContext, Page[]>();

/** 单环境回放标签硬上限（执行计划.md §4.1） */
export const REPLAY_TAB_LIMIT = 20;

function liveReplayTabs(context: BrowserContext): Page[] {
  const tracked = replayTabs.get(context) ?? [];
  const alive = tracked.filter((page) => {
    try {
      return page.isClosed() === false;
    } catch {
      return false;
    }
  });
  if (alive.length !== tracked.length) {
    replayTabs.set(context, alive);
  }
  return alive;
}

export interface ReplayTabLogger {
  warn?: (event: string, data?: Record<string, unknown>) => void;
  agentProgress?: (message: string, data?: Record<string, unknown>) => void;
}

export interface OpenReplayTabOptions {
  /** 是否在开新标签前关掉上一轮标签（默认关） */
  closePrevious?: boolean;
  /** 标签上限（默认 20） */
  limit?: number;
  /** 本轮序号（0 基），仅用于日志 */
  round?: number;
  logger?: ReplayTabLogger;
}

export interface OpenReplayTabResult {
  page: Page;
  tabId: string;
  /** 因为「关闭上一轮」而关掉的页 id */
  closedPrevious: string[];
  /** 因为触顶而强制回收的最旧页 id */
  evicted: string[];
}

/**
 * 在当前 context 里开一个回放标签并登记。返回新页（调用方负责 bindActivePage）。
 */
export async function openReplayTab(
  context: BrowserContext,
  options: OpenReplayTabOptions = {},
): Promise<OpenReplayTabResult> {
  const limit = Math.max(1, Math.min(options.limit ?? REPLAY_TAB_LIMIT, REPLAY_TAB_LIMIT));
  const tracked = liveReplayTabs(context);
  const closedPrevious: string[] = [];
  const evicted: string[] = [];

  if (options.closePrevious && tracked.length > 0) {
    const previous = tracked.pop()!;
    const id = tabIdOf(previous);
    try {
      await previous.close();
      closedPrevious.push(id);
    } catch {
      /* 已关闭/关闭失败都不阻断本轮 */
    }
    replayTabs.set(context, tracked);
  }

  while (tracked.length >= limit) {
    const oldest = tracked.shift()!;
    const id = tabIdOf(oldest);
    try {
      await oldest.close();
      evicted.push(id);
    } catch {
      /* ignore */
    }
  }

  const page = await context.newPage();
  tracked.push(page);
  replayTabs.set(context, tracked);
  const tabId = tabIdOf(page);

  if (evicted.length > 0) {
    options.logger?.warn?.("replay_tab_limit_evict", {
      limit,
      round: options.round ?? null,
      evicted,
      kept: tracked.length,
    });
    options.logger?.agentProgress?.(
      `回放标签触顶（上限 ${limit}）：已回收最旧的回放标签 ${evicted.join("、")}（只关回放自己开的）`,
      { phase: "replay_tab_limit", limit, evicted },
    );
  }
  if (closedPrevious.length > 0) {
    options.logger?.agentProgress?.(`已关闭上一轮回放标签 ${closedPrevious.join("、")}`, {
      phase: "replay_tab_rotate",
      closed: closedPrevious,
    });
  }
  return { page, tabId, closedPrevious, evicted };
}

/** 当前已登记的存活回放标签（只读快照） */
export function listReplayTabs(context: BrowserContext): Page[] {
  return [...liveReplayTabs(context)];
}

/**
 * 释放该 context 下所有回放创建的标签。
 * 默认**不调用**（§4.1：回放结束不自动关标签）；供 job 结束且用户选择回收时使用。
 */
export async function closeAllReplayTabs(context: BrowserContext): Promise<string[]> {
  const tracked = liveReplayTabs(context);
  const closed: string[] = [];
  for (const page of tracked) {
    const id = tabIdOf(page);
    try {
      await page.close();
      closed.push(id);
    } catch {
      /* ignore */
    }
  }
  replayTabs.set(context, []);
  return closed;
}
