/**
 * P5.6：网页邮箱适配器（非默认，高级选项）
 *
 * - 只有 enabled===true 且服务商在配置中，才允许取码
 * - 默认通道仍是 IMAP / 临时邮；本模块不会在它们失败后被自动调用
 * - 临时新开标签，只读配置中的收件箱 URL，读完即关；不代填登录、不改指纹
 * - 登录墙 / 超时 / 无码 → 失败，由调用方升 Layer 3 HITL
 * - 验证码不得进入日志
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";
import { redactSecrets, redactSecretText } from "../secret_redaction.js";
import { extractOtpFromMessages } from "./code_extract.js";
import type { OtpFetchFailReason, OtpFetchRequest, OtpFetchResult } from "./types.js";

export type WebmailProviderMeta = {
  id: string;
  label: string;
  inboxUrl: string;
  inboxHosts: string[];
  loginHosts: string[];
  aliases: string[];
};

export type WebmailInboxReader = (input: {
  inboxUrl: string;
  timeoutMs: number;
  allowedHosts: string[];
}) => Promise<
  | { ok: true; url: string; text: string }
  | { ok: false; reason: "timeout" | "auth_failed" }
>;

export type WebmailTab = {
  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  url(): string;
  evaluate(pageFunction: () => string | Promise<string>): Promise<string>;
  close(): Promise<unknown>;
};

export type WebmailBrowser = {
  context(): { newPage(): Promise<WebmailTab> };
};

type WebmailProvidersFile = {
  providers?: Record<
    string,
    {
      label?: string;
      inboxUrl?: string;
      inboxHosts?: string[];
      loginHosts?: string[];
      aliases?: string[];
    }
  >;
};

const TEXT_CAP = 12_000;
let cachedMeta: WebmailProviderMeta[] | null = null;

function configCandidates(): string[] {
  const env = readAppEnv("WEBMAIL_PROVIDERS_CONFIG");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/webmail_providers.json"));
  out.push(join(here, "../../../config/webmail_providers.json"));
  out.push(join(process.cwd(), "config", "webmail_providers.json"));
  out.push(join(process.cwd(), "sidecar", "config", "webmail_providers.json"));
  return out;
}

export function resolveWebmailProvidersConfigPath(): string | null {
  for (const candidate of configCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function asHostList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean);
}

function loadProviderMeta(): WebmailProviderMeta[] {
  if (cachedMeta) return cachedMeta;
  const path = resolveWebmailProvidersConfigPath();
  if (!path) {
    cachedMeta = [];
    return cachedMeta;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as WebmailProvidersFile;
    const rows = raw.providers ?? {};
    const out: WebmailProviderMeta[] = [];
    for (const [id, row] of Object.entries(rows)) {
      const needle = String(id ?? "").trim().toLowerCase();
      const inboxUrl = String(row.inboxUrl ?? "").trim();
      if (!needle || !inboxUrl) continue;
      const aliases = Array.isArray(row.aliases)
        ? row.aliases.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
        : [];
      out.push({
        id: needle,
        label: String(row.label ?? needle).trim() || needle,
        inboxUrl,
        inboxHosts: asHostList(row.inboxHosts),
        loginHosts: asHostList(row.loginHosts),
        aliases,
      });
    }
    cachedMeta = out;
  } catch {
    cachedMeta = [];
  }
  return cachedMeta;
}

export function resetWebmailProvidersConfigCache(): void {
  cachedMeta = null;
}

export function listWebmailProviderMeta(): WebmailProviderMeta[] {
  return loadProviderMeta().map((item) => ({
    ...item,
    inboxHosts: [...item.inboxHosts],
    loginHosts: [...item.loginHosts],
    aliases: [...item.aliases],
  }));
}

export function listWebmailProviderIds(): string[] {
  return loadProviderMeta().map((item) => item.id);
}

export function getWebmailProvider(providerId: string): WebmailProviderMeta | null {
  const needle = String(providerId ?? "").trim().toLowerCase();
  if (!needle) return null;
  return (
    loadProviderMeta().find(
      (item) => item.id === needle || item.aliases.some((alias) => alias === needle),
    ) ?? null
  );
}

export function hostnameOf(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hostMatches(host: string, suffixes: string[]): boolean {
  const needle = host.trim().toLowerCase();
  if (!needle) return false;
  return suffixes.some((item) => {
    const hint = String(item ?? "").trim().toLowerCase();
    if (!hint) return false;
    return needle === hint || needle.endsWith(`.${hint}`);
  });
}

/** 登录墙或非收件箱主机 → 不读正文。收件箱主机才允许抽码。 */
export function classifyWebmailLanding(
  url: string,
  provider: WebmailProviderMeta,
): { ok: true } | { ok: false; reason: "auth_failed" } {
  const host = hostnameOf(url);
  if (!host) return { ok: false, reason: "auth_failed" };
  if (hostMatches(host, provider.loginHosts)) return { ok: false, reason: "auth_failed" };
  if (hostMatches(host, provider.inboxHosts)) return { ok: true };
  return { ok: false, reason: "auth_failed" };
}

function fail(reason: OtpFetchFailReason): OtpFetchResult {
  return { ok: false, reason };
}

function safeLog(
  log: ((message: string, data?: Record<string, unknown>) => void) | undefined,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!log) return;
  try {
    log(redactSecretText(message), data ? (redactSecrets(data) as Record<string, unknown>) : undefined);
  } catch {
    /* 日志失败不得影响主路径 */
  }
}

function normalizeTimeoutMs(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 30_000;
  return Math.max(1_000, Math.min(Math.floor(raw), 180_000));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("otp_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 显式启用后的网页邮箱取码。无 reader（没有浏览器会话）→ not_configured，不编造码。
 */
export async function fetchWebmailOtp(options: {
  providerId: string;
  request: OtpFetchRequest;
  reader?: WebmailInboxReader;
  log?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<OtpFetchResult> {
  const provider = getWebmailProvider(options.providerId);
  if (!provider) {
    safeLog(options.log, "webmail_adapter unknown provider", {
      reason: "not_configured",
      providerId: String(options.providerId ?? "").slice(0, 32),
    });
    return fail("not_configured");
  }
  if (!options.reader) {
    safeLog(options.log, "webmail_adapter has no browser session", { reason: "not_configured" });
    return fail("not_configured");
  }

  const timeoutMs = normalizeTimeoutMs(options.request.timeoutMs);
  try {
    const snapshot = await withTimeout(
      options.reader({
        inboxUrl: provider.inboxUrl,
        timeoutMs,
        allowedHosts: provider.inboxHosts,
      }),
      timeoutMs,
    );
    if (!snapshot.ok) {
      safeLog(options.log, "webmail_adapter read failed", {
        reason: snapshot.reason,
        providerId: provider.id,
      });
      return fail(snapshot.reason);
    }
    const landing = classifyWebmailLanding(snapshot.url, provider);
    if (!landing.ok) {
      safeLog(options.log, "webmail_adapter login wall or unexpected host", {
        reason: "auth_failed",
        providerId: provider.id,
      });
      return fail("auth_failed");
    }
    const text = String(snapshot.text ?? "").slice(0, TEXT_CAP);
    if (!text.trim()) {
      safeLog(options.log, "webmail_adapter empty inbox text", {
        reason: "parse_failed",
        providerId: provider.id,
      });
      return fail("parse_failed");
    }
    const hit = extractOtpFromMessages(
      [
        {
          messageId: `webmail:${provider.id}`,
          from: "",
          subject: "",
          dateIso: new Date().toISOString(),
          text,
        },
      ],
      {
        fromHint: options.request.fromHint,
        subjectHint: options.request.subjectHint,
      },
    );
    if (!hit) {
      safeLog(options.log, "webmail_adapter parse failed", {
        reason: "parse_failed",
        providerId: provider.id,
      });
      return fail("parse_failed");
    }
    safeLog(options.log, "webmail_adapter code extracted", {
      ok: true,
      providerId: provider.id,
      messageId: `webmail:${provider.id}`,
      patternId: hit.patternId,
    });
    return { ok: true, code: hit.code, messageId: `webmail:${provider.id}:${Date.now()}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("otp_timeout") || /timeout/i.test(msg)) {
      safeLog(options.log, "webmail_adapter timeout", { reason: "timeout", providerId: provider.id });
      return fail("timeout");
    }
    safeLog(options.log, "webmail_adapter unexpected failure", {
      reason: "auth_failed",
      providerId: provider.id,
      error: redactSecretText(msg).slice(0, 180),
    });
    return fail("auth_failed");
  }
}

/**
 * 用已有浏览器上下文临时开标签读取收件箱可见正文。
 * 不调用 setActivePage、不填写登录、不注入指纹脚本。
 */
export async function readWebmailInboxPage(
  browser: WebmailBrowser,
  input: { inboxUrl: string; timeoutMs: number; allowedHosts: string[] },
): Promise<
  | { ok: true; url: string; text: string }
  | { ok: false; reason: "timeout" | "auth_failed" }
> {
  const host = hostnameOf(input.inboxUrl);
  if (!host || !hostMatches(host, input.allowedHosts)) {
    return { ok: false, reason: "auth_failed" };
  }
  let tab: WebmailTab | null = null;
  try {
    tab = await browser.context().newPage();
    await tab.goto(input.inboxUrl, {
      waitUntil: "domcontentloaded",
      timeout: normalizeTimeoutMs(input.timeoutMs),
    });
    const url = tab.url();
    const text = await tab.evaluate(() => {
      const body = (globalThis as { document?: { body?: { innerText?: string } } }).document?.body;
      return String(body?.innerText || "").slice(0, 12_000);
    });
    return { ok: true, url, text };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(msg)) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "auth_failed" };
  } finally {
    try {
      await tab?.close();
    } catch {
      /* 关标签失败不得泄漏验证码 */
    }
  }
}
