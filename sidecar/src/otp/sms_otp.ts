/**
 * P5.3：短信接码平台（可选，默认关）
 *
 * - enabled 必须显式 true；缺省/false → not_configured → Layer 3 HITL
 * - 密钥仅运行时注入（apiKeyRef）；禁止配置 JSON 明文
 * - 未知 provider / 缺 activationId / API 失败 / 超时 → 失败回落 HITL
 * - 禁止编造短信码；TOTP / 支付 critical 不走本模块
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";
import { redactSecrets, redactSecretText } from "../secret_redaction.js";
import { extractOtpFromMessage } from "./code_extract.js";
import type { SecretResolver } from "./types.js";

export type SmsOtpService =
  | { type: "none"; enabled?: boolean }
  | {
      type: "third_party";
      enabled: boolean;
      providerId: string;
      apiKeyRef: string;
      /** 接码平台订单/激活 ID；亦可由动作参数覆盖 */
      activationId?: string;
      note?: string;
    };

export type SmsOtpFailReason =
  | "not_configured"
  | "unsupported_provider"
  | "auth_failed"
  | "timeout"
  | "parse_failed"
  | "provider_error";

export type SmsOtpFetchResult =
  | { ok: true; code: string; messageId: string }
  | { ok: false; reason: SmsOtpFailReason; detail?: string };

export type SmsHttp = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

export type SmsProviderMeta = {
  id: string;
  baseUrl: string;
  aliases: string[];
};

export type SmsProviderAdapter = {
  id: string;
  aliases: string[];
  waitForSms(input: {
    apiKey: string;
    activationId: string;
    http: SmsHttp;
    signal?: AbortSignal;
    pollIntervalMs?: number;
    timeoutMs?: number;
    baseUrl?: string;
  }): Promise<
    | { ok: true; text: string; messageId: string }
    | { ok: false; reason: SmsOtpFailReason; detail: string }
  >;
};

type SmsProvidersFile = {
  providers?: Record<string, { baseUrl?: string; aliases?: string[] }>;
};

const BUILTIN_META: SmsProviderMeta[] = [
  {
    id: "sms-activate",
    baseUrl: "https://api.sms-activate.org/stubs/handler_api.php",
    aliases: ["sms_activate", "smsactivate"],
  },
  {
    id: "five_sim",
    baseUrl: "https://5sim.net/v1",
    aliases: ["5sim", "fivesim"],
  },
];

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 3_000;

let cachedMeta: SmsProviderMeta[] | null = null;
const PROVIDERS: SmsProviderAdapter[] = [];
let defaultsSeeded = false;

function configCandidates(): string[] {
  const env = readAppEnv("SMS_PROVIDERS_CONFIG");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/sms_providers.json"));
  out.push(join(here, "../../../config/sms_providers.json"));
  out.push(join(process.cwd(), "config", "sms_providers.json"));
  out.push(join(process.cwd(), "sidecar", "config", "sms_providers.json"));
  return out;
}

export function resolveSmsProvidersConfigPath(): string | null {
  for (const candidate of configCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function loadProviderMeta(): SmsProviderMeta[] {
  if (cachedMeta) return cachedMeta;
  const path = resolveSmsProvidersConfigPath();
  if (!path) {
    cachedMeta = BUILTIN_META.map((m) => ({ ...m, aliases: [...m.aliases] }));
    return cachedMeta;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as SmsProvidersFile;
    const rows = raw.providers ?? {};
    const out: SmsProviderMeta[] = [];
    for (const [id, row] of Object.entries(rows)) {
      const needle = String(id ?? "").trim().toLowerCase();
      if (!needle) continue;
      const builtin = BUILTIN_META.find((m) => m.id === needle);
      const baseUrl = String(row.baseUrl ?? builtin?.baseUrl ?? "")
        .trim()
        .replace(/\/+$/, "");
      if (!baseUrl) continue;
      const aliases = Array.isArray(row.aliases)
        ? row.aliases.map((a) => String(a ?? "").trim().toLowerCase()).filter(Boolean)
        : [...(builtin?.aliases ?? [])];
      out.push({ id: needle, baseUrl, aliases });
    }
    cachedMeta =
      out.length > 0 ? out : BUILTIN_META.map((m) => ({ ...m, aliases: [...m.aliases] }));
  } catch {
    cachedMeta = BUILTIN_META.map((m) => ({ ...m, aliases: [...m.aliases] }));
  }
  return cachedMeta;
}

export function resetSmsProvidersConfigCache(): void {
  cachedMeta = null;
}

export function getSmsProviderMeta(providerId: string): SmsProviderMeta | null {
  const needle = String(providerId ?? "").trim().toLowerCase();
  if (!needle) return null;
  const all = loadProviderMeta();
  return (
    all.find((m) => m.id === needle || m.aliases.some((a) => a === needle)) ?? null
  );
}

export function listSmsProviderIds(): string[] {
  ensureDefaultSmsProviders();
  return PROVIDERS.map((p) => p.id);
}

export function listSmsProviderMeta(): SmsProviderMeta[] {
  return loadProviderMeta().map((m) => ({ ...m, aliases: [...m.aliases] }));
}

export function registerSmsProvider(adapter: SmsProviderAdapter): void {
  const id = adapter.id.trim().toLowerCase();
  const idx = PROVIDERS.findIndex((p) => p.id === id);
  if (idx >= 0) PROVIDERS[idx] = { ...adapter, id };
  else PROVIDERS.push({ ...adapter, id });
}

export function clearSmsProviders(): void {
  PROVIDERS.length = 0;
  defaultsSeeded = false;
}

export function resetSmsProviderDefaultsFlag(): void {
  defaultsSeeded = false;
}

export function resolveSmsProvider(providerId: string): SmsProviderAdapter | null {
  ensureDefaultSmsProviders();
  const needle = String(providerId ?? "").trim().toLowerCase();
  if (!needle) return null;
  return (
    PROVIDERS.find((p) => p.id === needle || p.aliases.some((a) => a === needle)) ?? null
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createSmsActivateAdapter(meta: SmsProviderMeta): SmsProviderAdapter {
  return {
    id: meta.id,
    aliases: [...meta.aliases],
    async waitForSms(input) {
      const base = (input.baseUrl ?? meta.baseUrl).replace(/\/+$/, "");
      const timeoutMs = Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const pollMs = Math.max(500, input.pollIntervalMs ?? DEFAULT_POLL_MS);
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (input.signal?.aborted) {
          return { ok: false, reason: "timeout", detail: "aborted" };
        }
        const url =
          `${base}?api_key=${encodeURIComponent(input.apiKey)}` +
          `&action=getStatus&id=${encodeURIComponent(input.activationId)}`;
        let body = "";
        try {
          const res = await input.http(url, { method: "GET", signal: input.signal });
          body = await res.text();
          if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: "auth_failed", detail: `http_${res.status}` };
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (/abort/i.test(msg)) {
            return { ok: false, reason: "timeout", detail: "aborted" };
          }
          // 网络抖动：继续轮询直至超时
          try {
            await sleep(pollMs, input.signal);
          } catch {
            return { ok: false, reason: "timeout", detail: "aborted" };
          }
          continue;
        }
        const text = String(body ?? "").trim();
        if (/^STATUS_OK:/i.test(text)) {
          const codePart = text.slice(text.indexOf(":") + 1).trim();
          if (!codePart) {
            return { ok: false, reason: "parse_failed", detail: "empty_status_ok" };
          }
          return {
            ok: true,
            text: `验证码 ${codePart}`,
            messageId: `sms-activate:${input.activationId}`,
          };
        }
        if (/BAD_KEY|NO_KEY|WRONG_KEY|ERROR_SQL/i.test(text)) {
          return { ok: false, reason: "auth_failed", detail: text.slice(0, 80) };
        }
        if (/STATUS_CANCEL|NO_ACTIVATION|WRONG_ACTIVATION_ID/i.test(text)) {
          return { ok: false, reason: "provider_error", detail: text.slice(0, 80) };
        }
        // STATUS_WAIT_CODE / STATUS_WAIT_RETRY 等继续等
        try {
          await sleep(pollMs, input.signal);
        } catch {
          return { ok: false, reason: "timeout", detail: "aborted" };
        }
      }
      return { ok: false, reason: "timeout", detail: "wait_code_timeout" };
    },
  };
}

function createFiveSimAdapter(meta: SmsProviderMeta): SmsProviderAdapter {
  return {
    id: meta.id,
    aliases: [...meta.aliases],
    async waitForSms(input) {
      const base = (input.baseUrl ?? meta.baseUrl).replace(/\/+$/, "");
      const timeoutMs = Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const pollMs = Math.max(500, input.pollIntervalMs ?? DEFAULT_POLL_MS);
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (input.signal?.aborted) {
          return { ok: false, reason: "timeout", detail: "aborted" };
        }
        const url = `${base}/user/check/${encodeURIComponent(input.activationId)}`;
        let payload: unknown = null;
        let status = 0;
        try {
          const res = await input.http(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${input.apiKey}`,
              Accept: "application/json",
            },
            signal: input.signal,
          });
          status = res.status;
          if (status === 401 || status === 403) {
            return { ok: false, reason: "auth_failed", detail: `http_${status}` };
          }
          payload = await res.json().catch(async () => ({ raw: await res.text() }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (/abort/i.test(msg)) {
            return { ok: false, reason: "timeout", detail: "aborted" };
          }
          try {
            await sleep(pollMs, input.signal);
          } catch {
            return { ok: false, reason: "timeout", detail: "aborted" };
          }
          continue;
        }
        const row = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (String(row.status ?? "").toLowerCase() === "canceled") {
          return { ok: false, reason: "provider_error", detail: "canceled" };
        }
        const smsList = Array.isArray(row.sms) ? row.sms : [];
        for (const item of smsList) {
          if (!item || typeof item !== "object") continue;
          const sms = item as Record<string, unknown>;
          const code = String(sms.code ?? "").trim();
          const text = String(sms.text ?? sms.message ?? "").trim();
          const body = code ? `验证码 ${code}` : text;
          if (body) {
            return {
              ok: true,
              text: body,
              messageId: `five_sim:${input.activationId}:${String(sms.created_at ?? sms.date ?? Date.now())}`,
            };
          }
        }
        try {
          await sleep(pollMs, input.signal);
        } catch {
          return { ok: false, reason: "timeout", detail: "aborted" };
        }
      }
      return { ok: false, reason: "timeout", detail: "wait_code_timeout" };
    },
  };
}

export function ensureDefaultSmsProviders(): void {
  if (defaultsSeeded && PROVIDERS.length > 0) return;
  defaultsSeeded = true;
  for (const meta of loadProviderMeta()) {
    if (PROVIDERS.some((p) => p.id === meta.id)) continue;
    if (meta.id === "five_sim" || meta.aliases.includes("5sim")) {
      PROVIDERS.push(createFiveSimAdapter(meta));
    } else {
      PROVIDERS.push(createSmsActivateAdapter(meta));
    }
  }
  if (PROVIDERS.length === 0) {
    for (const meta of BUILTIN_META) {
      if (meta.id === "five_sim") PROVIDERS.push(createFiveSimAdapter(meta));
      else PROVIDERS.push(createSmsActivateAdapter(meta));
    }
  }
}

export function parseSmsOtpService(raw: unknown): SmsOtpService {
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
  const activationId =
    typeof row.activationId === "string" && row.activationId.trim()
      ? row.activationId.trim()
      : typeof row.activation_id === "string" && row.activation_id.trim()
        ? row.activation_id.trim()
        : undefined;
  return {
    type: "third_party",
    // 红线：必须显式 true；禁止偷偷开启
    enabled: row.enabled === true,
    providerId,
    apiKeyRef,
    activationId,
    note: typeof row.note === "string" ? row.note : undefined,
  };
}

/** 已启用且具备 provider + 密钥句柄（activationId 可后补） */
export function isSmsOtpServiceConfigured(service: SmsOtpService): boolean {
  return (
    service.type === "third_party" &&
    service.enabled === true &&
    Boolean(service.providerId) &&
    Boolean(service.apiKeyRef)
  );
}

async function resolveRef(
  resolveSecret: SecretResolver | undefined,
  ref: string,
): Promise<string | null> {
  if (!ref) return null;
  if (!resolveSecret) return null;
  try {
    const value = await resolveSecret(ref);
    const trimmed = String(value ?? "").trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function defaultHttp(): SmsHttp {
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
      text: () => res.text(),
      json: () => res.json(),
    };
  };
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
    /* ignore */
  }
}

function extractCodeFromSmsText(text: string): string | null {
  const hit = extractOtpFromMessage({
    messageId: "sms",
    from: "sms-provider",
    subject: "sms",
    dateIso: new Date().toISOString(),
    text: String(text ?? ""),
  });
  return hit?.code ?? null;
}

export type FetchSmsOtpOptions = {
  service: SmsOtpService | null | undefined;
  /** 覆盖配置中的 activationId */
  activationId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  resolveSecret?: SecretResolver;
  http?: SmsHttp;
  signal?: AbortSignal;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

/**
 * 从已启用的短信接码平台取 OTP。
 * 码与密钥不得进入日志；失败原因供调用方升 HITL。
 */
export async function fetchSmsOtp(options: FetchSmsOtpOptions): Promise<SmsOtpFetchResult> {
  const service = options.service ?? { type: "none", enabled: false };
  if (!isSmsOtpServiceConfigured(service) || service.type !== "third_party") {
    return { ok: false, reason: "not_configured", detail: "sms_otp_disabled_or_missing" };
  }

  const activationId = String(options.activationId ?? service.activationId ?? "").trim();
  if (!activationId) {
    return { ok: false, reason: "not_configured", detail: "missing_activation_id" };
  }

  const adapter = resolveSmsProvider(service.providerId);
  if (!adapter) {
    return { ok: false, reason: "unsupported_provider", detail: service.providerId };
  }

  const apiKey = await resolveRef(options.resolveSecret, service.apiKeyRef);
  if (!apiKey) {
    return { ok: false, reason: "auth_failed", detail: "secret_unresolved" };
  }

  const timeoutMs = Math.max(
    1_000,
    Math.min(180_000, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  );
  const meta = getSmsProviderMeta(service.providerId);
  safeLog(options.log, "短信接码平台取码中…", {
    phase: "fetch_sms_otp",
    providerId: adapter.id,
    hasActivationId: true,
  });

  const waited = await adapter.waitForSms({
    apiKey,
    activationId,
    http: options.http ?? defaultHttp(),
    signal: options.signal,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs,
    baseUrl: meta?.baseUrl,
  });

  if (!waited.ok) {
    safeLog(options.log, `短信接码失败（${waited.reason}）`, {
      phase: "fetch_sms_otp",
      reason: waited.reason,
    });
    return { ok: false, reason: waited.reason, detail: waited.detail };
  }

  const code = extractCodeFromSmsText(waited.text);
  if (!code) {
    return { ok: false, reason: "parse_failed", detail: "no_otp_in_sms" };
  }

  return { ok: true, code, messageId: waited.messageId };
}
