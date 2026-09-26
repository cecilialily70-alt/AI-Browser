/**
 * Agent 侧 CDP 会话。重启浏览器时进程不能退出：先标记「这次断开是预期的」，
 * 等同一 CDP 端口回来后再连上，并把新 Browser 交回 index.ts。
 */
import { chromium, type Browser, type Page } from "playwright-core";

import { resolveActivePageFromBrowser } from "./cdp_session.js";
import { humanizeConnectedBrowser } from "./cloakbrowser_extra.js";
import {
  applyBrowserDownloadDir,
  installDownloadAutoSaveOnBrowser,
} from "./download_autosave.js";
import type { JsonLogger } from "./json-logger.js";
import { getResolvedDownloadPath } from "./utils/file_manager.js";

let cdpUrl = "";
let restartArmed = false;
let replaceHandler: ((browser: Browser) => void) | null = null;

export function bindAgentCdpUrl(url: string): void {
  cdpUrl = url.trim();
}

export function getAgentCdpUrl(): string {
  return cdpUrl;
}

export function armBrowserRestart(): void {
  restartArmed = true;
}

export function isBrowserRestartArmed(): boolean {
  return restartArmed;
}

export function disarmBrowserRestart(): void {
  restartArmed = false;
}

export function onAgentBrowserReplaced(handler: (browser: Browser) => void): void {
  replaceHandler = handler;
}

/** 经 stdout 请 Rust 向 launch sidecar 下发 restart。宿主不在时由调用方超时失败。 */
export function requestHostBrowserRestart(profileId?: string): void {
  const line = JSON.stringify({
    type: "browser_restart_request",
    profileId: profileId ?? null,
    ts: new Date().toISOString(),
  });
  process.stdout.write(`${line}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function cdpAlive(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 800);
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/json/version`, {
      signal: ctrl.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 先等到旧 CDP 掉线，再等到新进程把同一端口重新打开。 */
export async function waitForBrowserRestartCycle(
  signal?: AbortSignal,
  timeoutMs = 90_000,
): Promise<void> {
  if (!cdpUrl) {
    throw new Error("没有 CDP 地址，无法等待浏览器重启");
  }
  const deadline = Date.now() + timeoutMs;
  const downUntil = Date.now() + 20_000;
  while (Date.now() < downUntil) {
    if (signal?.aborted) {
      throw new Error("Agent 已中止");
    }
    if (!(await cdpAlive(cdpUrl))) {
      break;
    }
    await delay(250);
  }
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Agent 已中止");
    }
    if (await cdpAlive(cdpUrl)) {
      return;
    }
    await delay(400);
  }
  throw new Error("重启后浏览器没有在时限内重新连上");
}

export async function reconnectAgentBrowser(input: {
  logger: JsonLogger;
  profileId: string;
}): Promise<Page> {
  if (!cdpUrl) {
    throw new Error("没有 CDP 地址，无法重新连接");
  }
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 30_000 });
  await humanizeConnectedBrowser(browser).catch(() => false);
  const resolveDir = (): string => getResolvedDownloadPath("browser", input.profileId);
  installDownloadAutoSaveOnBrowser(browser, input.logger, input.profileId, resolveDir);
  await applyBrowserDownloadDir(browser, resolveDir, input.logger, input.profileId).catch(
    () => undefined,
  );
  replaceHandler?.(browser);
  disarmBrowserRestart();
  return resolveActivePageFromBrowser(browser);
}
