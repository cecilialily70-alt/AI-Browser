/**
 * 邮箱 OTP 通道模块出口（P1.1）
 *
 * 码用完即弃：禁止写入 results.md / 轨迹明文 / 控制记忆值字段。
 */
export type {
  MailFetchQuery,
  MailMessage,
  MailTransport,
  OtpChannel,
  OtpFetchFailReason,
  OtpFetchRequest,
  OtpFetchResult,
  SecretResolver,
} from "./types.js";

export {
  extractOtpFromMessage,
  extractOtpFromMessages,
  loadEmailOtpLexicon,
  resetEmailOtpLexiconCache,
  resolveEmailOtpLexiconPath,
} from "./code_extract.js";

export {
  MemoryMailTransport,
  ImapMailTransport,
  clearTempmailProviders,
  createImapMailTransport,
  createMemoryMailTransport,
  getTempmailProvider,
  hasTempmailProvider,
  probeImapLogin,
  registerTempmailProvider,
} from "./mail_transport.js";
export type { TempmailHttp, TempmailProviderAdapter } from "./mail_transport.js";

export {
  createMailslurpAdapter,
  createOneSecmailAdapter,
  ensureDefaultTempmailProviders,
  getTempmailProviderMeta,
  listTempmailProviderIds,
  listTempmailProviderMeta,
  resetTempmailProvidersConfigCache,
  resetTempmailProviderDefaultsFlag,
  resolveTempmailProvidersConfigPath,
} from "./tempmail_providers.js";
export type { TempmailProviderMeta } from "./tempmail_providers.js";

// 侧效：安装默认临时邮适配器 installer
import "./tempmail_providers.js";

export {
  fetchEmailOtp,
  isOtpChannelConfigured,
  parseOtpChannel,
} from "./email_otp_channel.js";

export {
  classifyWebmailLanding,
  fetchWebmailOtp,
  getWebmailProvider,
  hostMatches,
  hostnameOf,
  listWebmailProviderIds,
  listWebmailProviderMeta,
  readWebmailInboxPage,
  resetWebmailProvidersConfigCache,
  resolveWebmailProvidersConfigPath,
} from "./webmail_adapter.js";
export type { WebmailBrowser, WebmailInboxReader, WebmailProviderMeta, WebmailTab } from "./webmail_adapter.js";

export { describeOtpChannel, probeOtpChannel } from "./probe.js";
export type { OtpProbeResult } from "./probe.js";

export {
  clearSmsProviders,
  ensureDefaultSmsProviders,
  fetchSmsOtp,
  getSmsProviderMeta,
  isSmsOtpServiceConfigured,
  listSmsProviderIds,
  listSmsProviderMeta,
  parseSmsOtpService,
  registerSmsProvider,
  resetSmsProviderDefaultsFlag,
  resetSmsProvidersConfigCache,
  resolveSmsProvider,
  resolveSmsProvidersConfigPath,
} from "./sms_otp.js";
export type {
  FetchSmsOtpOptions,
  SmsHttp,
  SmsOtpFailReason,
  SmsOtpFetchResult,
  SmsOtpService,
  SmsProviderAdapter,
  SmsProviderMeta,
} from "./sms_otp.js";

// 侧效：安装默认短信接码适配器
import "./sms_otp.js";
