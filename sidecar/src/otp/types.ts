/**
 * 邮箱 OTP 通道契约（P1.1）
 *
 * 默认不是网页邮箱 UI。网页邮箱仅 `webmail_adapter` 且 enabled===true 时可用。
 * 密钥只以 secretRef / apiKeyRef 句柄出现，明文仅运行时注入。
 * 码用完即弃：调用方不得写入 results.md / 轨迹明文。
 */

export type OtpChannel =
  | { type: "none" }
  | {
      type: "imap";
      host: string;
      port: number;
      user: string;
      /** Host secret_store 句柄；Sidecar 不存明文 */
      secretRef: string;
      folder?: string;
      tls?: boolean;
    }
  | {
      type: "tempmail_provider";
      providerId: string;
      apiKeyRef: string;
      inboxAddress?: string;
    }
  | {
      /** P5.6：须 enabled===true；不是默认通道 */
      type: "webmail_adapter";
      enabled: true;
      providerId: string;
    };

export type OtpFetchRequest = {
  sinceIso: string;
  /** 通用发件人提示（非站点硬编码） */
  fromHint?: string;
  subjectHint?: string;
  timeoutMs: number;
};

export type OtpFetchFailReason =
  | "timeout"
  | "not_configured"
  | "auth_failed"
  | "parse_failed"
  | "unsafe";

export type OtpFetchResult =
  | { ok: true; code: string; messageId: string }
  | { ok: false; reason: OtpFetchFailReason };

export type MailMessage = {
  messageId: string;
  from: string;
  subject: string;
  dateIso: string;
  text: string;
};

export type MailFetchQuery = {
  sinceIso: string;
  fromHint?: string;
  subjectHint?: string;
  folder?: string;
  limit?: number;
};

/** 可注入的取信传输；测试用 Memory，生产用 IMAP / 临时邮适配器 */
export interface MailTransport {
  fetchMessages(query: MailFetchQuery): Promise<MailMessage[]>;
  dispose?(): Promise<void> | void;
}

export type SecretResolver = (ref: string) => Promise<string | null> | string | null;
