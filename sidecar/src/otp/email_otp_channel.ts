/**
 * 邮箱 OTP 通道（P1.1）
 *
 * - 未配置 → not_configured（与现有 ask_user 路径兼容，本 Task 不改 actions）
 * - IMAP / 临时邮 API → 取信 + 配置化抽码
 * - 旧网页邮箱类型、以及未显式启用的 webmail_adapter → unsafe
 * - 显式启用的 webmail_adapter 才走网页邮箱；IMAP / 临时邮失败不会自动改道
 * - 码与密钥不得进入日志（走 secret_redaction）
 */
import { redactSecrets, redactSecretText } from "../secret_redaction.js";
import { extractOtpFromMessages } from "./code_extract.js";
import {
  createImapMailTransport,
  getTempmailProvider,
  type ImapTransportOptions,
} from "./mail_transport.js";
import "./tempmail_providers.js";
import { fetchWebmailOtp, getWebmailProvider, type WebmailInboxReader } from "./webmail_adapter.js";
import type {
  MailTransport,
  OtpChannel,
  OtpFetchFailReason,
  OtpFetchRequest,
  OtpFetchResult,
  SecretResolver,
} from "./types.js";

export type FetchEmailOtpOptions = {
  channel: OtpChannel | null | undefined;
  request: OtpFetchRequest;
  resolveSecret?: SecretResolver;
  /** 测试/模拟注入；缺省时按 channel 类型构建 */
  transport?: MailTransport;
  /** P5.6：仅 webmail_adapter 使用；缺省则无法读网页邮箱（not_configured） */
  webmailReader?: WebmailInboxReader;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

function fail(reason: OtpFetchFailReason): OtpFetchResult {
  return { ok: false, reason };
}

function safeLog(
  log: FetchEmailOtpOptions["log"],
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

export function parseOtpChannel(raw: unknown): OtpChannel {
  if (raw == null) return { type: "none" };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { type: "none" };
    try {
      return parseOtpChannel(JSON.parse(trimmed));
    } catch {
      return { type: "none" };
    }
  }
  if (typeof raw !== "object") return { type: "none" };
  const row = raw as Record<string, unknown>;
  const type = String(row.type ?? "none").trim().toLowerCase();
  if (type === "none" || type === "") return { type: "none" };
  if (type === "webmail" || type === "webmail_ui" || type === "browser_mailbox") {
    // 旧类型名永远不是合法通道；fetch 对原始对象返回 unsafe
    return { type: "none" };
  }
  if (type === "webmail_adapter") {
    if (row.enabled !== true) return { type: "none" };
    const providerId = String(row.providerId ?? row.provider_id ?? "").trim().toLowerCase();
    if (!providerId) return { type: "none" };
    return { type: "webmail_adapter", enabled: true, providerId };
  }
  if (type === "imap") {
    const host = String(row.host ?? "").trim();
    const user = String(row.user ?? "").trim();
    const secretRef = String(row.secretRef ?? row.secret_ref ?? "").trim();
    const port = Number(row.port);
    if (!host || !user || !secretRef || !Number.isFinite(port) || port < 1 || port > 65535) {
      return { type: "none" };
    }
    const folder =
      typeof row.folder === "string" && row.folder.trim() ? row.folder.trim() : undefined;
    const tls = row.tls === false ? false : true;
    return { type: "imap", host, port: Math.floor(port), user, secretRef, folder, tls };
  }
  if (type === "tempmail_provider" || type === "tempmail") {
    const providerId = String(row.providerId ?? row.provider_id ?? "").trim();
    const apiKeyRef = String(row.apiKeyRef ?? row.api_key_ref ?? "").trim();
    if (!providerId || !apiKeyRef) return { type: "none" };
    const inboxAddress =
      typeof row.inboxAddress === "string" && row.inboxAddress.trim()
        ? row.inboxAddress.trim()
        : undefined;
    return { type: "tempmail_provider", providerId, apiKeyRef, inboxAddress };
  }
  return { type: "none" };
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

type TransportBuild =
  | { ok: true; transport: MailTransport }
  | { ok: false; reason: "not_configured" };

async function buildTransport(
  channel: Exclude<OtpChannel, { type: "none" }>,
  resolveSecret: SecretResolver | undefined,
  injected: MailTransport | undefined,
): Promise<TransportBuild> {
  if (injected) return { ok: true, transport: injected };

  if (channel.type === "imap") {
    const password = await resolveRef(resolveSecret, channel.secretRef);
    if (!password) return { ok: false, reason: "not_configured" };
    const opts: ImapTransportOptions = {
      host: channel.host,
      port: channel.port,
      user: channel.user,
      password,
      folder: channel.folder,
      tls: channel.tls,
    };
    return { ok: true, transport: createImapMailTransport(opts) };
  }

  if (channel.type === "tempmail_provider") {
    const adapter = getTempmailProvider(channel.providerId);
    if (!adapter) return { ok: false, reason: "not_configured" };
    const needsKey = adapter.requiresApiKey !== false;
    // 仅显式 requiresInbox=true 时强制；自定义/测试适配器默认不强制
    const needsInbox = adapter.requiresInbox === true;
    if (needsInbox && !String(channel.inboxAddress ?? "").trim()) {
      return { ok: false, reason: "not_configured" };
    }
    const apiKey = needsKey
      ? await resolveRef(resolveSecret, channel.apiKeyRef)
      : (await resolveRef(resolveSecret, channel.apiKeyRef)) ?? "";
    if (needsKey && !apiKey) return { ok: false, reason: "not_configured" };
    const transport: MailTransport = {
      async fetchMessages(query) {
        return adapter.fetchInbox({
          apiKey: apiKey ?? "",
          inboxAddress: channel.inboxAddress,
          query,
        });
      },
    };
    return { ok: true, transport };
  }

  return { ok: false, reason: "not_configured" };
}

/**
 * 拉取并抽取邮箱 OTP。成功时 code 仅返回给调用方内存；本函数日志不含码与密钥。
 */
export async function fetchEmailOtp(options: FetchEmailOtpOptions): Promise<OtpFetchResult> {
  const channel = parseOtpChannel(options.channel);
  const log = options.log;

  // 显式网页邮箱类型（未归一化前）→ unsafe
  if (options.channel && typeof options.channel === "object") {
    const rawType = String((options.channel as { type?: unknown }).type ?? "")
      .trim()
      .toLowerCase();
    if (rawType === "webmail" || rawType === "webmail_ui" || rawType === "browser_mailbox") {
      safeLog(log, "email_otp_channel rejected webmail default path", { reason: "unsafe" });
      return fail("unsafe");
    }
    if (rawType === "webmail_adapter" && (options.channel as { enabled?: unknown }).enabled !== true) {
      safeLog(log, "email_otp_channel rejected webmail without explicit enable", { reason: "unsafe" });
      return fail("unsafe");
    }
  }

  if (channel.type === "webmail_adapter") {
    return fetchWebmailOtp({
      providerId: channel.providerId,
      request: options.request,
      reader: options.webmailReader,
      log,
    });
  }

  if (channel.type === "none") {
    safeLog(log, "email_otp_channel not configured", { reason: "not_configured" });
    return fail("not_configured");
  }

  const timeoutMs = normalizeTimeoutMs(options.request.timeoutMs);
  const built = await buildTransport(channel, options.resolveSecret, options.transport);
  if (!built.ok) {
    safeLog(log, "email_otp_channel transport unavailable", {
      reason: built.reason,
      channelType: channel.type,
    });
    return fail(built.reason);
  }

  const transport = built.transport;
  try {
    const messages = await withTimeout(
      transport.fetchMessages({
        sinceIso: options.request.sinceIso,
        fromHint: options.request.fromHint,
        subjectHint: options.request.subjectHint,
        folder: channel.type === "imap" ? channel.folder : undefined,
        limit: 20,
      }),
      timeoutMs,
    );

    const hit = extractOtpFromMessages(messages, {
      fromHint: options.request.fromHint,
      subjectHint: options.request.subjectHint,
    });
    if (!hit) {
      safeLog(log, "email_otp_channel parse failed", {
        reason: "parse_failed",
        messageCount: messages.length,
      });
      return fail("parse_failed");
    }

    safeLog(log, "email_otp_channel code extracted", {
      ok: true,
      messageId: hit.messageId,
      patternId: hit.patternId,
      // 故意不写 code
    });
    return { ok: true, code: hit.code, messageId: hit.messageId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("otp_timeout") || msg.includes("imap_read_timeout")) {
      safeLog(log, "email_otp_channel timeout", { reason: "timeout" });
      return fail("timeout");
    }
    if (msg.includes("tempmail_not_configured")) {
      safeLog(log, "email_otp_channel tempmail not configured", {
        reason: "not_configured",
        error: redactSecretText(msg),
      });
      return fail("not_configured");
    }
    if (
      msg.includes("imap_command_failed") ||
      msg.includes("imap_auth") ||
      msg.includes("tempmail_auth_failed") ||
      msg.includes("tempmail_http_") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("certificate")
    ) {
      safeLog(log, "email_otp_channel auth/connect failed", {
        reason: "auth_failed",
        error: redactSecretText(msg),
      });
      return fail("auth_failed");
    }
    safeLog(log, "email_otp_channel unexpected failure", {
      reason: "auth_failed",
      error: redactSecretText(msg),
    });
    return fail("auth_failed");
  } finally {
    try {
      await transport.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

/** 通道是否已配置（可供 P1.2 闸门判断；未配置则继续 ask_user） */
export function isOtpChannelConfigured(channel: OtpChannel | null | undefined): boolean {
  const parsed = parseOtpChannel(channel);
  if (parsed.type === "webmail_adapter") {
    return getWebmailProvider(parsed.providerId) != null;
  }
  return parsed.type !== "none";
}
