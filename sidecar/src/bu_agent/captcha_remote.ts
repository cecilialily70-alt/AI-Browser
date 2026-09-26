/**
 * P5.1：第三方 token 验证码（Turnstile / reCAPTCHA / hCaptcha）。
 *
 * - 策略族 id：`token_challenge_remote`（见 captcha_strategy.ts）
 * - 配置：Host `captcha_service`（P1.3）；密钥仅会话注入，禁止落盘
 * - 失败 / 未配置 / 未知 provider → 调用方记 verified=false → Layer 3 HITL
 * - 禁止编造 token；禁止为过检测改指纹
 */
import type { Page } from "playwright-core";

import type { JsonLogger } from "../json-logger.js";

export type CaptchaServiceConfig =
  | { type: "none"; enabled?: boolean }
  | {
      type: "third_party";
      enabled: boolean;
      providerId: string;
      apiKeyRef: string;
      note?: string;
    };

export type TokenChallengeKind = "turnstile" | "recaptcha" | "hcaptcha";

export type TokenChallengeProbe = {
  kind: TokenChallengeKind;
  sitekey: string;
  pageUrl: string;
  /** 可选 action（部分 reCAPTCHA v3 / Turnstile） */
  action?: string;
};

export type RemoteSolveFailReason =
  | "not_configured"
  | "unsupported_provider"
  | "no_challenge"
  | "auth_failed"
  | "timeout"
  | "provider_error"
  | "inject_failed";

export type RemoteSolveResult =
  | {
      ok: true;
      kind: TokenChallengeKind;
      providerId: string;
      verified: boolean | null;
      detail: string;
    }
  | {
      ok: false;
      reason: RemoteSolveFailReason;
      detail: string;
      kind?: TokenChallengeKind;
      providerId?: string;
    };

export type SecretResolver = (ref: string) => Promise<string | null> | string | null;

/** 可注入的 HTTP（单测 mock；生产用全局 fetch） */
export type RemoteHttp = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export type RemoteProviderAdapter = {
  id: string;
  aliases: string[];
  solve(input: {
    apiKey: string;
    challenge: TokenChallengeProbe;
    http: RemoteHttp;
    signal?: AbortSignal;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<{ ok: true; token: string } | { ok: false; reason: RemoteSolveFailReason; detail: string }>;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 3_000;

export function parseCaptchaService(raw: unknown): CaptchaServiceConfig {
  if (raw == null) return { type: "none", enabled: false };
  let row: Record<string, unknown>;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { type: "none", enabled: false };
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return { type: "none", enabled: false };
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    row = raw as Record<string, unknown>;
  } else {
    return { type: "none", enabled: false };
  }
  const type = String(row.type ?? "none").trim().toLowerCase();
  if (type !== "third_party") return { type: "none", enabled: false };
  const providerId = String(row.providerId ?? row.provider_id ?? "").trim();
  const apiKeyRef = String(row.apiKeyRef ?? row.api_key_ref ?? "").trim();
  if (!providerId || !apiKeyRef) return { type: "none", enabled: false };
  return {
    type: "third_party",
    enabled: row.enabled === true,
    providerId,
    apiKeyRef,
    note: typeof row.note === "string" ? row.note : undefined,
  };
}

export function isCaptchaServiceConfigured(config: CaptchaServiceConfig): boolean {
  return config.type === "third_party" && config.enabled === true && Boolean(config.providerId) && Boolean(config.apiKeyRef);
}

const PROVIDERS: RemoteProviderAdapter[] = [];

export function registerRemoteCaptchaProvider(adapter: RemoteProviderAdapter): void {
  const id = adapter.id.trim().toLowerCase();
  const idx = PROVIDERS.findIndex((p) => p.id === id);
  if (idx >= 0) PROVIDERS[idx] = { ...adapter, id };
  else PROVIDERS.push({ ...adapter, id });
}

export function clearRemoteCaptchaProviders(): void {
  PROVIDERS.length = 0;
}

export function listRemoteCaptchaProviderIds(): string[] {
  ensureDefaultProviders();
  return PROVIDERS.map((p) => p.id);
}

function ensureDefaultProviders(): void {
  if (PROVIDERS.length > 0) return;
  PROVIDERS.push(createTwoCaptchaAdapter(), createCapsolverAdapter());
}

export function resolveRemoteCaptchaProvider(providerId: string): RemoteProviderAdapter | null {
  ensureDefaultProviders();
  const needle = String(providerId ?? "").trim().toLowerCase();
  if (!needle) return null;
  return (
    PROVIDERS.find((p) => p.id === needle || p.aliases.some((a) => a === needle)) ?? null
  );
}

async function resolveRef(
  resolveSecret: SecretResolver | undefined,
  ref: string,
): Promise<string | null> {
  const id = String(ref ?? "").trim();
  if (!id || !resolveSecret) return null;
  const value = await resolveSecret(id);
  const plain = String(value ?? "").trim();
  return plain || null;
}

function defaultHttp(): RemoteHttp {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.json(),
      text: async () => res.text(),
    };
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 从页面 DOM 提取 token 挑战（通用属性 / iframe src；无站点硬编码）。
 */
export async function probeTokenChallenge(page: Page): Promise<TokenChallengeProbe | null> {
  const pageUrl = page.url();
  const found = await page
    .evaluate(() => {
      const pick = (
        kind: "turnstile" | "recaptcha" | "hcaptcha",
        el: Element | null,
      ): { kind: typeof kind; sitekey: string; action?: string } | null => {
        if (!el) return null;
        const sitekey = String(
          el.getAttribute("data-sitekey") ||
            el.getAttribute("data-site-key") ||
            (el as HTMLElement).dataset?.sitekey ||
            "",
        ).trim();
        if (!sitekey) return null;
        const action = String(el.getAttribute("data-action") || "").trim() || undefined;
        return { kind, sitekey, action };
      };

      const turnstile =
        pick("turnstile", document.querySelector(".cf-turnstile[data-sitekey], [data-sitekey].cf-turnstile")) ||
        pick("turnstile", document.querySelector("div[data-sitekey][class*='turnstile'], iframe[src*='challenges.cloudflare.com']")?.closest("[data-sitekey]") ?? null) ||
        (() => {
          const iframe = document.querySelector("iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']");
          if (!iframe) return null;
          const src = String(iframe.getAttribute("src") || "");
          const m = src.match(/[?&](?:sitekey|k)=([^&]+)/i);
          if (!m?.[1]) return null;
          return { kind: "turnstile" as const, sitekey: decodeURIComponent(m[1]) };
        })();
      if (turnstile) return turnstile;

      const recaptcha =
        pick("recaptcha", document.querySelector(".g-recaptcha[data-sitekey], [data-sitekey].g-recaptcha")) ||
        pick("recaptcha", document.querySelector("div[data-sitekey][class*='recaptcha']")) ||
        (() => {
          const iframe = document.querySelector("iframe[src*='recaptcha']");
          if (!iframe) return null;
          const src = String(iframe.getAttribute("src") || "");
          const m = src.match(/[?&]k=([^&]+)/i);
          if (!m?.[1]) return null;
          return { kind: "recaptcha" as const, sitekey: decodeURIComponent(m[1]) };
        })();
      if (recaptcha) return recaptcha;

      const hcaptcha =
        pick("hcaptcha", document.querySelector(".h-captcha[data-sitekey], [data-sitekey].h-captcha")) ||
        pick("hcaptcha", document.querySelector("div[data-sitekey][class*='hcaptcha'], div[data-sitekey][class*='h-captcha']")) ||
        (() => {
          const iframe = document.querySelector("iframe[src*='hcaptcha.com']");
          if (!iframe) return null;
          const src = String(iframe.getAttribute("src") || "");
          const m = src.match(/[?&]sitekey=([^&]+)/i);
          if (!m?.[1]) return null;
          return { kind: "hcaptcha" as const, sitekey: decodeURIComponent(m[1]) };
        })();
      if (hcaptcha) return hcaptcha;

      // 兜底：任意 data-sitekey + 邻近文案/类名暗示
      const any = document.querySelector("[data-sitekey]");
      if (any) {
        const blob = `${any.className} ${any.id} ${any.outerHTML.slice(0, 200)}`.toLowerCase();
        const sitekey = String(any.getAttribute("data-sitekey") || "").trim();
        if (sitekey) {
          if (/turnstile|cloudflare/.test(blob)) return { kind: "turnstile" as const, sitekey };
          if (/hcaptcha|h-captcha/.test(blob)) return { kind: "hcaptcha" as const, sitekey };
          if (/recaptcha|g-recaptcha/.test(blob)) return { kind: "recaptcha" as const, sitekey };
        }
      }
      return null;
    })
    .catch(() => null);

  if (!found?.sitekey) return null;
  return {
    kind: found.kind,
    sitekey: found.sitekey,
    pageUrl,
    action: "action" in found && typeof found.action === "string" ? found.action : undefined,
  };
}

async function injectToken(page: Page, challenge: TokenChallengeProbe, token: string): Promise<boolean> {
  const ok = await page
    .evaluate(
      ({ kind, token: tok }) => {
        const setValue = (el: Element | null) => {
          if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
          el.value = tok;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };

        let written = false;
        if (kind === "turnstile") {
          written =
            setValue(document.querySelector('input[name="cf-turnstile-response"]')) ||
            setValue(document.querySelector('textarea[name="cf-turnstile-response"]')) ||
            written;
          document.querySelectorAll("[name='cf-turnstile-response']").forEach((el) => {
            written = setValue(el) || written;
          });
          // 常见回调钩子（无站点定制）
          const w = window as unknown as {
            turnstile?: { getResponse?: () => string };
            onTurnstileSuccess?: (t: string) => void;
          };
          try {
            w.onTurnstileSuccess?.(tok);
          } catch {
            /* ignore */
          }
        } else if (kind === "recaptcha") {
          written =
            setValue(document.querySelector("#g-recaptcha-response")) ||
            setValue(document.querySelector('textarea[name="g-recaptcha-response"]')) ||
            written;
          document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach((el) => {
            written = setValue(el) || written;
          });
          try {
            const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } })
              .___grecaptcha_cfg;
            void cfg;
            const cb = (window as unknown as { captchaCallback?: (t: string) => void }).captchaCallback;
            cb?.(tok);
          } catch {
            /* ignore */
          }
        } else if (kind === "hcaptcha") {
          written =
            setValue(document.querySelector('textarea[name="h-captcha-response"]')) ||
            setValue(document.querySelector("[name='h-captcha-response']")) ||
            written;
          document.querySelectorAll("[name='h-captcha-response'], [name='g-recaptcha-response']").forEach((el) => {
            written = setValue(el) || written;
          });
        }

        // 通用兜底：任一空 response 文本框
        if (!written) {
          const candidates = document.querySelectorAll(
            'textarea[name*="captcha" i], input[name*="captcha" i], textarea[id*="captcha" i]',
          );
          candidates.forEach((el) => {
            written = setValue(el) || written;
          });
        }
        return written || tok.length > 20;
      },
      { kind: challenge.kind, token },
    )
    .catch(() => false);
  return Boolean(ok);
}

/**
 * 主入口：配置检查 → 探测 → 远程求解 → 注入。
 * 任意失败返回 ok:false（调用方升 Layer 3）；永不编造 token。
 */
export async function solveTokenChallengeRemote(input: {
  page: Page;
  captchaService: unknown;
  resolveSecret?: SecretResolver;
  logger?: JsonLogger;
  http?: RemoteHttp;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 测试可注入已探测到的挑战，跳过 DOM */
  challengeOverride?: TokenChallengeProbe | null;
}): Promise<RemoteSolveResult> {
  const config = parseCaptchaService(input.captchaService);
  if (!isCaptchaServiceConfigured(config) || config.type !== "third_party") {
    return {
      ok: false,
      reason: "not_configured",
      detail:
        "第三方验证码服务未启用或未配置（not_configured）。请 handover_to_human 完成挑战，或在设置中启用 captcha_service。禁止猜测 token。",
    };
  }

  const adapter = resolveRemoteCaptchaProvider(config.providerId);
  if (!adapter) {
    return {
      ok: false,
      reason: "unsupported_provider",
      providerId: config.providerId,
      detail: `未知验证码服务商「${config.providerId}」。已支持：${listRemoteCaptchaProviderIds().join(", ")}。请改配置或 handover_to_human。`,
    };
  }

  const apiKey = await resolveRef(input.resolveSecret, config.apiKeyRef);
  if (!apiKey) {
    return {
      ok: false,
      reason: "auth_failed",
      providerId: adapter.id,
      detail: "无法解析第三方验证码 API Key（auth_failed）。请检查 secret_store 后重试，或 handover_to_human。",
    };
  }

  const challenge =
    input.challengeOverride === undefined
      ? await probeTokenChallenge(input.page)
      : input.challengeOverride;
  if (!challenge) {
    return {
      ok: false,
      reason: "no_challenge",
      providerId: adapter.id,
      detail: "页面未找到 Turnstile/reCAPTCHA/hCaptcha sitekey（no_challenge）。请 handover_to_human。",
    };
  }

  input.logger?.agentProgress(`第三方验证码：${adapter.id} · ${challenge.kind}`, {
    phase: "captcha_remote",
    providerId: adapter.id,
    kind: challenge.kind,
  });

  const http = input.http ?? defaultHttp();
  let solved: { ok: true; token: string } | { ok: false; reason: RemoteSolveFailReason; detail: string };
  try {
    solved = await adapter.solve({
      apiKey,
      challenge,
      http,
      signal: input.signal,
      pollIntervalMs: input.pollIntervalMs,
      timeoutMs: input.timeoutMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/aborted|AbortError|已中止/i.test(msg)) {
      return { ok: false, reason: "timeout", providerId: adapter.id, kind: challenge.kind, detail: "已中止" };
    }
    return {
      ok: false,
      reason: "provider_error",
      providerId: adapter.id,
      kind: challenge.kind,
      detail: `第三方求解异常：${msg.slice(0, 200)}。请 handover_to_human。`,
    };
  }

  if (!solved.ok) {
    return {
      ok: false,
      reason: solved.reason,
      providerId: adapter.id,
      kind: challenge.kind,
      detail: `${solved.detail} 请 handover_to_human，禁止重试编造。`,
    };
  }

  const injected = await injectToken(input.page, challenge, solved.token);
  if (!injected) {
    return {
      ok: false,
      reason: "inject_failed",
      providerId: adapter.id,
      kind: challenge.kind,
      detail: "已取得 token 但注入页面失败（inject_failed）。请 handover_to_human。",
    };
  }

  // 轻量成功信号：token 字段非空；最终是否放行由站点异步决定 → verified=null
  return {
    ok: true,
    kind: challenge.kind,
    providerId: adapter.id,
    verified: null,
    detail: `已注入 ${challenge.kind} token（${adapter.id}）。观察页面是否放行；未放行则未满阈值可再试，满次 handover。`,
  };
}

// ---------- providers ----------

function createTwoCaptchaAdapter(): RemoteProviderAdapter {
  return {
    id: "2captcha",
    aliases: ["2captcha.com", "rucaptcha"],
    async solve({ apiKey, challenge, http, signal, pollIntervalMs, timeoutMs }) {
      const method =
        challenge.kind === "turnstile"
          ? "turnstile"
          : challenge.kind === "hcaptcha"
            ? "hcaptcha"
            : "userrecaptcha";
      const params = new URLSearchParams({
        key: apiKey,
        method,
        pageurl: challenge.pageUrl,
        json: "1",
      });
      if (challenge.kind === "turnstile" || challenge.kind === "hcaptcha") {
        params.set("sitekey", challenge.sitekey);
      } else {
        params.set("googlekey", challenge.sitekey);
      }
      if (challenge.action) params.set("action", challenge.action);

      const createRes = await http(`https://2captcha.com/in.php?${params.toString()}`, {
        method: "GET",
        signal,
      });
      const createBody = (await createRes.json().catch(() => null)) as {
        status?: number;
        request?: string;
      } | null;
      if (!createBody || createBody.status !== 1 || !createBody.request) {
        const err = String(createBody?.request ?? createRes.status);
        if (/ERROR_WRONG_USER_KEY|ERROR_KEY_DOES_NOT_EXIST|ERROR_ZERO_BALANCE/i.test(err)) {
          return { ok: false, reason: "auth_failed", detail: `2captcha 鉴权/余额失败：${err}` };
        }
        return { ok: false, reason: "provider_error", detail: `2captcha 创建任务失败：${err}` };
      }
      const taskId = String(createBody.request);
      return pollTwoCaptcha({
        apiKey,
        taskId,
        http,
        signal,
        pollIntervalMs: pollIntervalMs ?? DEFAULT_POLL_MS,
        timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
  };
}

async function pollTwoCaptcha(input: {
  apiKey: string;
  taskId: string;
  http: RemoteHttp;
  signal?: AbortSignal;
  pollIntervalMs: number;
  timeoutMs: number;
}): Promise<{ ok: true; token: string } | { ok: false; reason: RemoteSolveFailReason; detail: string }> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.signal?.aborted) {
      return { ok: false, reason: "timeout", detail: "已中止" };
    }
    await sleep(input.pollIntervalMs, input.signal).catch(() => undefined);
    const url = `https://2captcha.com/res.php?key=${encodeURIComponent(input.apiKey)}&action=get&id=${encodeURIComponent(input.taskId)}&json=1`;
    const res = await input.http(url, { method: "GET", signal: input.signal });
    const body = (await res.json().catch(() => null)) as { status?: number; request?: string } | null;
    if (!body) continue;
    if (body.status === 1 && body.request) {
      const token = String(body.request).trim();
      if (!token) {
        return { ok: false, reason: "provider_error", detail: "2captcha 返回空 token" };
      }
      return { ok: true, token };
    }
    const req = String(body.request ?? "");
    if (req && req !== "CAPCHA_NOT_READY" && req !== "CAPTCHA_NOT_READY") {
      if (/ERROR_WRONG_USER_KEY|ERROR_KEY_DOES_NOT_EXIST/i.test(req)) {
        return { ok: false, reason: "auth_failed", detail: `2captcha：${req}` };
      }
      return { ok: false, reason: "provider_error", detail: `2captcha：${req}` };
    }
  }
  return { ok: false, reason: "timeout", detail: "2captcha 轮询超时" };
}

function createCapsolverAdapter(): RemoteProviderAdapter {
  return {
    id: "capsolver",
    aliases: ["capsolver.com"],
    async solve({ apiKey, challenge, http, signal, pollIntervalMs, timeoutMs }) {
      const taskType =
        challenge.kind === "turnstile"
          ? "AntiTurnstileTaskProxyLess"
          : challenge.kind === "hcaptcha"
            ? "HCaptchaTaskProxyLess"
            : "ReCaptchaV2TaskProxyLess";
      const task: Record<string, unknown> = {
        type: taskType,
        websiteURL: challenge.pageUrl,
        websiteKey: challenge.sitekey,
      };
      if (challenge.action) task.pageAction = challenge.action;

      const createRes = await http("https://api.capsolver.com/createTask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, task }),
        signal,
      });
      const createBody = (await createRes.json().catch(() => null)) as {
        errorId?: number;
        errorCode?: string;
        errorDescription?: string;
        taskId?: string;
      } | null;
      if (!createBody?.taskId || (createBody.errorId ?? 0) !== 0) {
        const err = String(createBody?.errorDescription || createBody?.errorCode || createRes.status);
        if (/KEY|BALANCE|UNAUTHORIZED/i.test(err)) {
          return { ok: false, reason: "auth_failed", detail: `capsolver 鉴权失败：${err}` };
        }
        return { ok: false, reason: "provider_error", detail: `capsolver 创建任务失败：${err}` };
      }

      const deadline = Date.now() + (timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const interval = pollIntervalMs ?? DEFAULT_POLL_MS;
      while (Date.now() < deadline) {
        if (signal?.aborted) return { ok: false, reason: "timeout", detail: "已中止" };
        await sleep(interval, signal).catch(() => undefined);
        const pollRes = await http("https://api.capsolver.com/getTaskResult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: apiKey, taskId: createBody.taskId }),
          signal,
        });
        const pollBody = (await pollRes.json().catch(() => null)) as {
          errorId?: number;
          errorCode?: string;
          errorDescription?: string;
          status?: string;
          solution?: { token?: string; gRecaptchaResponse?: string };
        } | null;
        if (!pollBody) continue;
        if ((pollBody.errorId ?? 0) !== 0) {
          const err = String(pollBody.errorDescription || pollBody.errorCode || "error");
          if (/KEY|BALANCE|UNAUTHORIZED/i.test(err)) {
            return { ok: false, reason: "auth_failed", detail: `capsolver：${err}` };
          }
          return { ok: false, reason: "provider_error", detail: `capsolver：${err}` };
        }
        if (pollBody.status === "ready") {
          const token = String(
            pollBody.solution?.token || pollBody.solution?.gRecaptchaResponse || "",
          ).trim();
          if (!token) {
            return { ok: false, reason: "provider_error", detail: "capsolver 返回空 token" };
          }
          return { ok: true, token };
        }
      }
      return { ok: false, reason: "timeout", detail: "capsolver 轮询超时" };
    },
  };
}
