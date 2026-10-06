import type { Browser, BrowserContext, Page } from "playwright-core";

import type { JsonLogger } from "./json-logger.js";

const watchedPages = new WeakSet<Page>();
const spaHookContexts = new WeakSet<BrowserContext>();

export interface PageUrlEmitter {
  /** 变化才推送：供被动监听使用，按 URL 去重以免刷屏 */
  emitIfChanged: (url: string) => void;
  /**
   * 无门控推送：仅供 `get_url` 这类「请求/响应」查询使用。
   *
   * 必须每次都出线，否则调用方（Rust 侧在等 `page_url` 行）会一直等到超时——
   * 一次明明成功的读取被报成 60s 超时。
   */
  emitQuery: (url: string) => void;
}

export function createPageUrlEmitter(logger: JsonLogger, profileId?: string): PageUrlEmitter {
  let lastUrl = "";

  const emitIfChanged = (url: string): void => {
    const currentUrl = url.trim();
    if (!currentUrl || currentUrl === "about:blank") {
      return;
    }
    if (currentUrl === lastUrl) {
      return;
    }
    lastUrl = currentUrl;
    logger.pageUrl(currentUrl, profileId ? { profile_id: profileId } : undefined);
  };

  // 查询响应不设门槛：即使 URL 未变（或为 about:blank）也必须回一行，
  // 否则发起方拿不到应答，只能等到超时
  const emitQuery = (url: string): void => {
    const currentUrl = url.trim();
    lastUrl = currentUrl;
    logger.pageUrl(currentUrl, profileId ? { profile_id: profileId } : undefined);
  };

  return {
    emitIfChanged,
    emitQuery,
  };
}

async function ensureSpaRouteHooks(context: BrowserContext, emitIfChanged: (url: string) => void): Promise<void> {
  if (spaHookContexts.has(context)) {
    return;
  }
  spaHookContexts.add(context);

  try {
    await context.exposeFunction("notifyUrlChange", (currentUrl: string) => {
      emitIfChanged(String(currentUrl ?? ""));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("has been already registered")) {
      throw error;
    }
  }

  await context.addInitScript(() => {
    if ((window as Window & { __aiBrowserSpaHook?: boolean }).__aiBrowserSpaHook) {
      return;
    }
    (window as Window & { __aiBrowserSpaHook?: boolean }).__aiBrowserSpaHook = true;

    window.addEventListener("popstate", () => {
      window.dispatchEvent(new CustomEvent("spa_url_changed"));
    });

    const originalPushState = history.pushState.bind(history);
    history.pushState = (...args: Parameters<History["pushState"]>) => {
      originalPushState(...args);
      window.dispatchEvent(new CustomEvent("spa_url_changed"));
    };

    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = (...args: Parameters<History["replaceState"]>) => {
      originalReplaceState(...args);
      window.dispatchEvent(new CustomEvent("spa_url_changed"));
    };

    window.addEventListener("spa_url_changed", () => {
      const notify = (window as Window & { notifyUrlChange?: (url: string) => void }).notifyUrlChange;
      if (typeof notify === "function") {
        notify(window.location.href);
      }
    });
  });
}

async function bindSpaListener(page: Page): Promise<void> {
  await page.evaluate(() => {
    if ((window as Window & { __aiBrowserSpaListener?: boolean }).__aiBrowserSpaListener) {
      return;
    }
    (window as Window & { __aiBrowserSpaListener?: boolean }).__aiBrowserSpaListener = true;

    window.addEventListener("spa_url_changed", () => {
      const notify = (window as Window & { notifyUrlChange?: (url: string) => void }).notifyUrlChange;
      if (typeof notify === "function") {
        notify(window.location.href);
      }
    });
  });
}

export async function attachPageUrlWatcher(
  page: Page,
  emitter: PageUrlEmitter,
): Promise<void> {
  if (watchedPages.has(page)) {
    return;
  }
  watchedPages.add(page);

  await ensureSpaRouteHooks(page.context(), emitter.emitIfChanged);
  await bindSpaListener(page);

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      emitter.emitIfChanged(page.url());
    }
  });

  emitter.emitIfChanged(page.url());
}

export async function attachContextUrlWatchers(
  context: BrowserContext,
  logger: JsonLogger,
  profileId?: string,
): Promise<PageUrlEmitter> {
  const emitter = createPageUrlEmitter(logger, profileId);

  context.on("page", (page) => {
    void attachPageUrlWatcher(page, emitter).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("page_url_watcher_attach_failed", { error: message, profileId });
    });
  });

  for (const page of context.pages()) {
    await attachPageUrlWatcher(page, emitter);
  }

  return emitter;
}

export async function attachBrowserUrlWatchers(
  browser: Browser,
  logger: JsonLogger,
  profileId?: string,
): Promise<PageUrlEmitter> {
  const emitter = createPageUrlEmitter(logger, profileId);

  for (const context of browser.contexts()) {
    context.on("page", (page) => {
      void attachPageUrlWatcher(page, emitter).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("page_url_watcher_attach_failed", { error: message, profileId });
      });
    });

    for (const page of context.pages()) {
      await attachPageUrlWatcher(page, emitter);
    }
  }

  return emitter;
}
