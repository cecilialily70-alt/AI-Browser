/**
 * 邮箱 OTP 通道连通性探测（P1.3 / P5.2）
 *
 * 仅用于设置页「测试连接」：不取码、不写轨迹；密钥不入日志。
 * 未知临时邮 provider → not_configured（禁止 provider_pending 软成功）。
 */
import { redactSecretText } from "../secret_redaction.js";
import { parseOtpChannel } from "./email_otp_channel.js";
import { getTempmailProvider, probeImapLogin } from "./mail_transport.js";
import "./tempmail_providers.js";
import { getWebmailProvider } from "./webmail_adapter.js";
import type { OtpChannel } from "./types.js";

export type OtpProbeResult = {
  ok: boolean;
  reason:
    | "ok"
    | "not_configured"
    | "auth_failed"
    | "network"
    | "unsafe";
  message: string;
};

function fail(
  reason: OtpProbeResult["reason"],
  message: string,
): OtpProbeResult {
  return { ok: false, reason, message: redactSecretText(message) };
}

/**
 * @param draftSecret 表单草稿密钥（密码或 API Key）；优先于 secretsByRef
 */
export async function probeOtpChannel(input: {
  channel: unknown;
  draftSecret?: string | null;
  secretsByRef?: Record<string, string> | null;
}): Promise<OtpProbeResult> {
  if (input.channel && typeof input.channel === "object") {
    const rawType = String((input.channel as { type?: unknown }).type ?? "")
      .trim()
      .toLowerCase();
    if (rawType === "webmail" || rawType === "webmail_ui" || rawType === "browser_mailbox") {
      return fail("unsafe", "禁止将网页邮箱作为默认取码通道");
    }
    if (rawType === "webmail_adapter") {
      if ((input.channel as { enabled?: unknown }).enabled !== true) {
        return fail("unsafe", "网页邮箱须显式启用，不能作为默认取码路径");
      }
      const providerId = String(
        (input.channel as { providerId?: unknown; provider_id?: unknown }).providerId ??
          (input.channel as { provider_id?: unknown }).provider_id ??
          "",
      )
        .trim()
        .toLowerCase();
      if (!getWebmailProvider(providerId)) {
        return fail("not_configured", "未知网页邮箱服务商。已支持：gmail、qq、outlook");
      }
      return {
        ok: true,
        reason: "ok",
        message:
          "网页邮箱适配器已显式启用。取码时临时打开收件箱读取可见正文；未登录或失败将交人工。不会修改浏览器指纹。",
      };
    }
  }

  const channel = parseOtpChannel(input.channel);
  if (channel.type === "none") {
    return fail("not_configured", "尚未配置邮箱通道");
  }

  const draft = String(input.draftSecret ?? "").trim();
  const secrets = input.secretsByRef ?? {};

  if (channel.type === "imap") {
    const password =
      draft ||
      String(secrets[channel.secretRef] ?? "").trim();
    if (!password) {
      return fail("not_configured", "缺少邮箱密码：请填写后再测，或先保存密钥");
    }
    const result = await probeImapLogin({
      host: channel.host,
      port: channel.port,
      user: channel.user,
      password,
      folder: channel.folder,
      tls: channel.tls,
      commandTimeoutMs: 15_000,
    });
    if (result.ok) {
      return { ok: true, reason: "ok", message: "IMAP 登录成功" };
    }
    return fail(result.reason, result.detail);
  }

  if (channel.type === "tempmail_provider") {
    const adapter = getTempmailProvider(channel.providerId);
    if (!adapter) {
      return fail(
        "not_configured",
        `未知临时邮服务商「${channel.providerId}」。已支持：mailslurp、1secmail`,
      );
    }
    const needsKey = adapter.requiresApiKey !== false;
    const needsInbox = adapter.requiresInbox === true;
    const apiKey = draft || String(secrets[channel.apiKeyRef] ?? "").trim();
    if (needsKey && !apiKey) {
      return fail("not_configured", "缺少 API Key：请填写后再测，或先保存密钥");
    }
    if (needsInbox && !String(channel.inboxAddress ?? "").trim()) {
      return fail("not_configured", "请填写临时邮收件地址 / 收件箱 ID");
    }
    try {
      if (adapter.probe) {
        const probed = await adapter.probe({
          apiKey: apiKey || "-",
          inboxAddress: channel.inboxAddress,
        });
        if (probed.ok) {
          return { ok: true, reason: "ok", message: "临时邮通道连通成功" };
        }
        const detail = probed.detail.toLowerCase();
        if (detail.includes("key") || detail.includes("认证") || detail.includes("无权")) {
          return fail("auth_failed", probed.detail);
        }
        if (detail.includes("填写") || detail.includes("缺少") || detail.includes("地址")) {
          return fail("not_configured", probed.detail);
        }
        return fail("network", probed.detail);
      }
      await adapter.fetchInbox({
        apiKey: apiKey || "-",
        inboxAddress: channel.inboxAddress,
        query: {
          sinceIso: new Date(Date.now() - 60_000).toISOString(),
          limit: 1,
        },
      });
      return { ok: true, reason: "ok", message: "临时邮通道连通成功" };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error ?? "");
      if (raw.includes("tempmail_not_configured")) {
        return fail("not_configured", "临时邮配置不完整（收件地址等）");
      }
      if (raw.includes("tempmail_auth_failed") || /tempmail_http_40[13]/.test(raw)) {
        return fail("auth_failed", "临时邮认证失败，请检查 API Key 与收件箱");
      }
      return fail("network", "临时邮 API 调用失败，请检查 Key、收件地址与网络");
    }
  }

  return fail("not_configured", "不支持的通道类型");
}

export function describeOtpChannel(channel: OtpChannel): string {
  if (channel.type === "imap") {
    return `imap://${channel.user}@${channel.host}:${channel.port}`;
  }
  if (channel.type === "tempmail_provider") {
    return `tempmail:${channel.providerId}`;
  }
  if (channel.type === "webmail_adapter") {
    return `webmail:${channel.providerId}`;
  }
  return "none";
}
