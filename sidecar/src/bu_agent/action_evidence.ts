/**
 * Agent 动作证据旁路（仅 multiAct 生命周期）。
 *
 * - 与动作并行开网络窗（C1）；DOM 双快照（C2）
 * - 先 mask 再截断（C5）；可空不挡主流程
 * - 禁止被聊天 / prepareObservation 主路径引用（ChatFireWall）
 */
import type { Page, Response } from "playwright-core";

import { redactSecrets, redactSecretText } from "../secret_redaction.js";

const NETWORK_WINDOW_MS = 4_000;
const BODY_MAX = 500;
const DOM_MAX = 1_200;

export interface NetworkHit {
  url: string;
  status: number;
  contentType: string;
  bodyPreview: string;
  networkCapture: "ok" | "best_effort" | "empty";
}

export interface DomSnapshot {
  before?: string;
  after?: string;
  domCapture: "ok" | "unavailable" | "partial";
}

export interface ActionEvidence {
  networkHits: NetworkHit[];
  dom: DomSnapshot;
}

export interface ActionEvidenceHandle {
  /** 动作结束后调用：收尾网络窗 + 拍 after/alerts，并拆除监听 */
  settle: () => Promise<ActionEvidence>;
  dispose: () => void;
}

/** 通用错误/提示节点选择器（词表级，无站点字面量） */
const ALERT_SELECTORS = [
  '[role="alert"]',
  '[aria-live="assertive"]',
  '[aria-live="polite"]',
  ".toast",
  ".Toast",
  ".error",
  ".Error",
  ".alert",
  ".Alert",
  "[data-testid*='error' i]",
  "[data-testid*='toast' i]",
  "[class*='error' i]",
  "[class*='toast' i]",
  "[class*='alert' i]",
];

function isJsonOrXml(ct: string): boolean {
  return /json|xml/i.test(ct);
}

function maskThenTruncate(raw: string, max: number): string {
  const masked = redactSecretText(String(raw ?? ""));
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}

async function captureNeighborhood(page: Page, selector: string | null | undefined): Promise<string | null> {
  const sel = String(selector ?? "").trim();
  if (!sel) return null;
  try {
    const html = await page.evaluate((target) => {
      const el = document.querySelector(target);
      if (!el || !(el as Element).isConnected) return null;
      const parent = el.parentElement;
      const node = parent ?? el;
      return (node as HTMLElement).outerHTML?.slice(0, 2400) ?? null;
    }, sel);
    return html ? maskThenTruncate(html, DOM_MAX) : null;
  } catch {
    return null;
  }
}

async function captureAlerts(page: Page): Promise<string | null> {
  try {
    const html = await page.evaluate((selectors) => {
      const parts: string[] = [];
      for (const sel of selectors) {
        let nodes: NodeListOf<Element>;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const node of Array.from(nodes).slice(0, 4)) {
          if (!(node as Element).isConnected) continue;
          const text = String((node as HTMLElement).innerText ?? node.textContent ?? "").trim();
          if (!text || text.length < 2) continue;
          parts.push((node as HTMLElement).outerHTML?.slice(0, 600) ?? text.slice(0, 200));
          if (parts.length >= 6) break;
        }
        if (parts.length >= 6) break;
      }
      return parts.length ? parts.join("\n<!-- -->\n") : null;
    }, ALERT_SELECTORS);
    return html ? maskThenTruncate(html, DOM_MAX) : null;
  } catch {
    return null;
  }
}

/**
 * 在 multiAct **之前**调用：拍 before、挂网络监听。
 * multiAct **之后**调用 `settle()`：短等网络、拍 after、拆除监听。
 */
export function beginActionEvidence(
  page: Page,
  options?: { selector?: string | null; windowMs?: number },
): ActionEvidenceHandle {
  const windowMs = options?.windowMs ?? NETWORK_WINDOW_MS;
  const hits: NetworkHit[] = [];
  let disposed = false;
  const startedAt = Date.now();

  const onResponse = (res: Response): void => {
    if (disposed) return;
    void (async () => {
      try {
        const status = res.status();
        const headers = res.headers();
        const ct = String(headers["content-type"] ?? "");
        if (!isJsonOrXml(ct)) return;
        let body = "";
        try {
          body = await res.text();
        } catch {
          body = "";
        }
        const preview = maskThenTruncate(body, BODY_MAX);
        const hit: NetworkHit = {
          url: res.url().slice(0, 240),
          status,
          contentType: ct.slice(0, 80),
          bodyPreview: preview,
          networkCapture: preview ? "ok" : "best_effort",
        };
        // 非 2xx 优先保留（与 captcha 观察器相反）
        if (status >= 400) {
          hits.unshift(hit);
        } else {
          hits.push(hit);
        }
        if (hits.length > 8) hits.length = 8;
      } catch {
        /* best_effort */
      }
    })();
  };

  page.on("response", onResponse);

  const beforePromise = captureNeighborhood(page, options?.selector).catch(() => null);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      page.off("response", onResponse);
    } catch {
      /* ignore */
    }
  };

  const settle = async (): Promise<ActionEvidence> => {
    const elapsed = Date.now() - startedAt;
    const remain = Math.max(0, Math.min(windowMs, windowMs - elapsed));
    // 动作已结束：最多再等剩余窗（上限约 1.2s），避免拖慢主循环
    const grace = Math.min(remain, 1_200);
    if (grace > 0) {
      await new Promise((r) => setTimeout(r, grace));
    }
    const before = await beforePromise;
    let after: string | null = null;
    let alerts: string | null = null;
    try {
      after = await captureNeighborhood(page, options?.selector);
    } catch {
      after = null;
    }
    try {
      alerts = await captureAlerts(page);
    } catch {
      alerts = null;
    }
    dispose();
    const afterCombined = [after, alerts].filter(Boolean).join("\n") || undefined;
    let domCapture: DomSnapshot["domCapture"] = "ok";
    if (!before && !afterCombined) domCapture = "unavailable";
    else if (!before || !afterCombined) domCapture = "partial";
    return {
      networkHits: hits,
      dom: {
        before: before ?? undefined,
        after: afterCombined,
        domCapture,
      },
    };
  };

  return { settle, dispose };
}

/** 把证据压成可进 RunBrief 的脱敏摘要 */
export function summarizeEvidenceForBrief(evidence: ActionEvidence): Record<string, unknown> {
  const networkJson = evidence.networkHits.slice(0, 4).map((h) => ({
    url: h.url,
    status: h.status,
    body: h.bodyPreview,
    capture: h.networkCapture,
  }));
  return redactSecrets({
    domCapture: evidence.dom.domCapture,
    domBefore: evidence.dom.before,
    domAfter: evidence.dom.after,
    networkJson,
    networkCapture: evidence.networkHits.length ? "ok" : "empty",
  }) as Record<string, unknown>;
}
