import type { BrowserContext, Page } from "playwright-core";

import type { JsonLogger } from "./json-logger.js";
import { formatTaskbarBadgeLabel } from "./taskbar_badge.js";

function buildTitlePrefix(profileId: string): string {
  return `【${formatTaskbarBadgeLabel(profileId)}】`;
}

async function applyTitlePrefix(page: Page, prefix: string): Promise<void> {
  await page.evaluate((marker) => {
    const current = document.title || "";
    const stripped = current.replace(/^【\d+】/, "");
    if (!current.startsWith(marker)) {
      document.title = `${marker}${stripped}`;
    }
  }, prefix);
}

/**
 * 最简标记：窗口/任务栏悬停标题前加【ID】，不阻塞启动、不碰 Chromium 参数。
 */
export async function applyProfileWindowMarker(
  context: BrowserContext,
  profileId: string,
  logger: JsonLogger,
): Promise<void> {
  const prefix = buildTitlePrefix(profileId);

  const bindPage = (page: Page): void => {
    const refresh = (): void => {
      void applyTitlePrefix(page, prefix).catch(() => {
        // 页面切换中可能短暂失败，忽略
      });
    };
    page.on("domcontentloaded", refresh);
    page.on("load", refresh);
    refresh();
  };

  for (const page of context.pages()) {
    bindPage(page);
  }
  context.on("page", bindPage);

  logger.progress("profile_window_marker_applied", { profileId, prefix });
}
