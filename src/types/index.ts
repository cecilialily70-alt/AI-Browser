export type WebglMode = "local" | "random";

export const WEBGL_MODE_OPTIONS = [
  {
    value: "local" as const,
    label: "本机显卡",
    hint: "默认用本机真实显卡信息",
  },
  {
    value: "random" as const,
    label: "随机显卡",
    hint: "从常见桌面显卡中按指纹种子稳定选用一种",
  },
] as const;

export interface Profile {
  id: number;
  name: string;
  proxy_id: number | null;
  custom_proxy: string | null;
  cdp_port: number | null;
  status: string;
  fraud_score: number;
  fraud_details: string | null;
  theme_color: string;
  created_at: string;
  use_geoip: boolean;
  humanize: boolean;
  fingerprint_seed: string;
  stealth_preset: StealthPreset;
  /** 该环境是否开启页面交互元素自动提取（默认 false） */
  interactive_element_extract_enabled: boolean;
  /** Agent 观察是否附带多帧低质量视口截图（关=零截图） */
  agent_panorama_enabled?: boolean;
  /** WebGL 指纹策略：local=本机显卡，random=指纹种子映射真实显卡池 */
  webgl_mode: WebglMode;
  /** 空字符串=使用 CloakBrowser 最新版；非空则 pin 到指定 Chromium 版本 */
  browser_version?: string;
  /**
   * 历史字段（INFO 残留）：环境人设已下线，用户人设改由「规则」窗口维护。
   * 列保留以避免迁移风险，当前无写入方，也不再被自动填表/回放读取。
   */
  persona_data?: string | null;
  /** 启动额外打开的网站 JSON 数组字符串（首位 BrowserScan 由引擎强制） */
  startup_urls?: string;
  /** P1.1：邮箱 OTP 通道绑定 JSON（仅 secretRef，不含密码明文） */
  otp_channel?: string | null;
}

export type StealthPreset = "default" | "fpjs_bypass";

export const STEALTH_PRESET_OPTIONS = [
  { value: "default" as const, label: "标准", hint: "推荐日常使用" },
  {
    value: "fpjs_bypass" as const,
    label: "加强",
    hint: "针对更严的指纹检测；日常场景一般不必选",
  },
] as const;

export function randomFingerprintSeed(): string {
  return String(Math.floor(Math.random() * 90000) + 10000);
}

export interface Proxy {
  id: number;
  type: "HTTP" | "SOCKS5" | "DYNAMIC_API" | string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  api_config?: string | null;
}

export interface SidecarAiSettings {
  apiKey: string;
  apiBaseUrl: string;
  textModel?: string;
  chatModel?: string;
  agentModel?: string;
  visionModel?: string;
}

/** OpenAI 兼容服务商 */
export type AiProviderId = "deepseek" | "zhipu" | "custom";

export interface AppSettings {
  deepseek_api_key: string;
  /** 智谱 BigModel 专用 Key（与 DeepSeek 分存，切换服务商不丢） */
  zhipu_api_key: string;
  /** 自定义 OpenAI 兼容端点 Key */
  custom_api_key: string;
  /** 当前选用的服务商（显式持久化，避免仅靠 URL 推断导致弹回） */
  ai_provider: AiProviderId;
  deepseek_base_url: string;
  /** DeepSeek 选用的模型 */
  deepseek_chat_model: string;
  /** 智谱选用的模型 */
  zhipu_chat_model: string;
  /** 自定义端点选用的模型 */
  custom_chat_model: string;
  /** 用户自行添加的模型（JSON 数组） */
  ai_extra_models: string;
  /** 按服务商×任务（极速文本/深度逻辑/视觉坐标）选用的模型（JSON） */
  ai_task_models: string;
  cloak_path: string;
  cloak_license_key: string;
  key_file_path: string;
  /** 按 Chromium 版本 pin 自定义 chrome.exe 路径（JSON：{ "151.0.7922.108.6": "C:\\...\\chrome.exe" }）；命中即跳过下载 */
  kernel_paths: string;
  /** 常规浏览器下载根目录；空则使用应用数据目录下 downloads/browser */
  browser_download_dir: string;
  /** 爬虫/AI 抓取下载根目录；空则使用应用数据目录下 downloads/scraper */
  scraper_download_dir: string;
  /** Pro 授权检查走浏览器代理（--license-through-proxy），企业网/受限网络直连授权服务器失败时开启 */
  license_through_proxy: boolean;
  /** 允许第三方 Cookie（--fingerprint-allow-3p-cookies），嵌入式登录/支付/reCAPTCHA 卡住时按需开启 */
  allow_third_party_cookies: boolean;
  /** Windows 调试：关闭全部指纹伪装显示真实指纹（--fingerprint=off），诊断用 */
  fingerprint_off: boolean;
  /**
   * Agent 感知模式（已固定 balanced；保留字段兼容旧设置库）。
   * economy/classic 已不再暴露 UI。
   */
  agent_sense_mode: "economy" | "balanced" | "classic";
  /**
   * 新建环境默认 Chromium 版本 Pin（空=自动）。
   * 常用：免费核 146… / 打包 151-pro（仅指纹）。
   */
  default_browser_version: string;
  /** P1.1/P1.3：全局邮箱 OTP 通道 JSON（仅 secretRef，不含明文） */
  otp_channel: string;
  /** P1.3 / P5.1：第三方验证码服务配置 JSON（密钥走 secret_store；solver 见 captcha_remote） */
  captcha_service: string;
  /** P5.3：短信接码平台配置 JSON（默认 enabled=false；密钥走 secret_store） */
  sms_otp_service: string;
}

export interface LicenseEntitlement {
  isPro: boolean;
  isValid: boolean;
  licensePlan?: string | null;
  keyFilePath?: string | null;
}

export interface KeyFileActionResult {
  ok: boolean;
  message: string;
  isPro: boolean;
  isValid: boolean;
  keyFilePath?: string | null;
  licensePlan?: string | null;
}

export interface CacheCleanupReport {
  removedDirs: number;
  removedFiles: number;
  freedBytes: number;
  details: string[];
}

export interface CloakBinaryStatus {
  installed: boolean;
  version?: string | null;
  bundledVersion?: string | null;
  tier?: string | null;
  platform?: string | null;
  binaryPath?: string | null;
  cacheDir?: string | null;
  cacheRoot?: string | null;
  chromiumDirs?: string[];
  unusedCount?: number;
  hasLicense?: boolean;
  releaseChannel?: string | null;
  wrapperVersion?: string | null;
  browserVersionPin?: string | null;
  licenseValid?: boolean | null;
  licensePlan?: string | null;
  proLatestVersion?: string | null;
  proResolvedChannel?: string | null;
  proChannelFallback?: boolean | null;
  sessionSeatsActive?: number | null;
  sessionSeatsLimit?: number | null;
  sessionSeatsState?: string | null;
  updated?: boolean | null;
  updatedTo?: string | null;
  removedCount?: number | null;
  message?: string | null;
  usedKeylessFreePin?: boolean | null;
  licenseFallbackReason?: string | null;
  licenseKeySource?: string | null;
  diagnosticOk?: boolean | null;
  diagnosticSummary?: string | null;
  checks?: CloakDiagnosticCheck[] | null;
}

export interface CloakDiagnosticCheck {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
}

/** 本地运行目录 / 缓存中检测到的 Chromium 内核 */
export interface LocalKernel {
  version: string;
  dirName: string;
  chromePath: string;
  /** "pro" | "free" */
  tier: string;
  /** "bundled"（本地运行目录：exe 旁 Browse/ 或 开发目录 Kernel/）| "cache"（~/.cloakbrowser） */
  source: string;
}

export type ConnectivityStatus = "idle" | "testing" | "success" | "error";

export type ProxyStrategy = "none" | "pool_random" | "pool_shared" | "sequential_ports";

export type ProfileProxyMode = "none" | "pool" | "custom";

/**
 * OpenAI 兼容服务商预设（设置页一键切换）。
 *
 * **不预置任何模型 ID**：模型迭代太快，写死必然过时（要么被服务商下线，要么
 * 404 报错）。这里只保留「服务商」这一层概念 —— 它决定 Base URL 默认值与
 * API Key 分开存放的位置。模型由用户在「设置 → AI 设置 → 模型库」自己加。
 */
export interface AiProviderPreset {
  id: AiProviderId;
  label: string;
  /** 文档入口（模型清单以服务商文档为准） */
  docsUrl?: string;
  baseUrl: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    docsUrl: "https://api-docs.deepseek.com/",
    baseUrl: "https://api.deepseek.com",
  },
  {
    id: "zhipu",
    label: "智谱 BigModel",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/start/model-overview",
    /** OpenAI 兼容：https://open.bigmodel.cn/api/paas/v4/ */
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "custom",
    label: "自定义 OpenAI 兼容",
    baseUrl: "",
  },
];
export function detectAiProviderId(baseUrl: string): AiProviderId {
  const u = baseUrl.trim().toLowerCase();
  if (!u) {
    return "custom";
  }
  if (u.includes("bigmodel.cn") || u.includes("bigmodel")) {
    return "zhipu";
  }
  if (u.includes("deepseek.com") || u.includes("deepseek")) {
    return "deepseek";
  }
  return "custom";
}

export function normalizeAiProviderId(raw: string | undefined | null, baseUrl: string): AiProviderId {
  const id = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (id === "deepseek" || id === "zhipu" || id === "custom") {
    return id;
  }
  return detectAiProviderId(baseUrl);
}

/** 当前服务商对应的 API Key 字段 */
export function aiApiKeyFieldForProvider(
  providerId: AiProviderId,
): "deepseek_api_key" | "zhipu_api_key" | "custom_api_key" {
  if (providerId === "zhipu") {
    return "zhipu_api_key";
  }
  if (providerId === "custom") {
    return "custom_api_key";
  }
  return "deepseek_api_key";
}

export function aiChatModelFieldForProvider(
  providerId: AiProviderId,
): "deepseek_chat_model" | "zhipu_chat_model" | "custom_chat_model" {
  if (providerId === "zhipu") {
    return "zhipu_chat_model";
  }
  if (providerId === "custom") {
    return "custom_chat_model";
  }
  return "deepseek_chat_model";
}

/** 任务角色：极速文本 / 深度逻辑 / 视觉坐标（存储键仍为 chat/agent/vision） */
export type AiTaskRole = "chat" | "agent" | "vision";
export interface AiTaskModelMap {
  chat: string;
  agent: string;
  vision: string;
}

export type AiTaskModelsByProvider = Partial<Record<AiProviderId, AiTaskModelMap>>;

/** 用户模型库里的一条模型（唯一来源是「设置 → AI 设置 → 模型库」） */
export interface AiModelOption {
  value: string;
  label: string;
  hint: string;
  /** 可用于 Agent 截图 / 开眼 */
  vision?: boolean;
  /**
   * 该模型默认开启 thinking，与 Agent 强制工具调用（tool_choice=required）互斥。
   * 由用户在模型库里标注，运行时据此给请求体补 thinking.disabled；
   * 不再靠模型名正则去猜（新模型 ID 会猜不中而 400）。
   */
  disableThinkingForForcedTools?: boolean;
}

export interface AiExtraModel extends AiModelOption {
  /** 归属服务商；空=全服务商可见 */
  provider?: AiProviderId | "";
  /** 用户添加（可删） */
  custom?: boolean;
}

export function parseAiExtraModels(raw: string | undefined | null): AiExtraModel[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: AiExtraModel[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const rec = row as Record<string, unknown>;
      const value = String(rec.value ?? rec.id ?? "").trim();
      if (!value) {
        continue;
      }
      out.push({
        value,
        label: String(rec.label ?? value).trim() || value,
        hint: String(rec.hint ?? "用户添加").trim() || "用户添加",
        vision: Boolean(rec.vision),
        disableThinkingForForcedTools: Boolean(rec.disableThinkingForForcedTools),
        provider: (String(rec.provider ?? "") as AiProviderId | "") || "",
        custom: true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeAiExtraModels(models: AiExtraModel[]): string {
  return JSON.stringify(
    models.map((m) => ({
      value: m.value,
      label: m.label || m.value,
      hint: m.hint || "用户添加",
      vision: Boolean(m.vision),
      disableThinkingForForcedTools: Boolean(m.disableThinkingForForcedTools),
      provider: m.provider || "",
      custom: true,
    })),
  );
}

export function parseAiTaskModels(raw: string | undefined | null): AiTaskModelsByProvider {
  try {
    const parsed = JSON.parse(String(raw ?? "{}")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: AiTaskModelsByProvider = {};
    for (const key of ["deepseek", "zhipu", "custom"] as AiProviderId[]) {
      const row = (parsed as Record<string, unknown>)[key];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        continue;
      }
      const rec = row as Record<string, unknown>;
      out[key] = {
        chat: String(rec.chat ?? "").trim(),
        agent: String(rec.agent ?? "").trim(),
        vision: String(rec.vision ?? "").trim(),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeAiTaskModels(map: AiTaskModelsByProvider): string {
  return JSON.stringify(map);
}

/** 空的任务模型槽：模型不再预置，全部由用户在「模型库」里配置 */
export function emptyTaskModels(): AiTaskModelMap {
  return { chat: "", agent: "", vision: "" };
}

/** 模型库（= 用户模型），按服务商过滤。不再合并任何预置清单。 */
export function buildModelCatalog(providerId: AiProviderId, extraRaw: string): AiExtraModel[] {
  const extras = parseAiExtraModels(extraRaw).filter(
    (m) => !m.provider || m.provider === providerId || providerId === "custom",
  );
  const seen = new Set<string>();
  const merged: AiExtraModel[] = [];
  for (const m of extras) {
    const key = m.value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(m);
  }
  return merged;
}

export function resolveTaskModel(
  settings: {
    ai_provider?: AiProviderId;
    deepseek_base_url: string;
    deepseek_chat_model: string;
    zhipu_chat_model: string;
    custom_chat_model: string;
    ai_task_models?: string;
  },
  role: AiTaskRole,
): string {
  const provider = normalizeAiProviderId(settings.ai_provider, settings.deepseek_base_url);
  const map = parseAiTaskModels(settings.ai_task_models);
  const row = map[provider];
  const fromTask = String(row?.[role] ?? "").trim();
  if (fromTask) {
    return fromTask;
  }
  // 旧字段兼容（升级上来的库只有 chat 档有历史值）。
  // 视觉档不再按模型名猜谁是视觉模型 —— 猜不中就发错请求；缺就沿用文本档。
  const field = aiChatModelFieldForProvider(provider);
  const legacy = String(settings[field] ?? "").trim();
  if (legacy) {
    return legacy;
  }
  return String(row?.chat ?? "").trim();
}

export function upsertTaskModel(
  taskModelsRaw: string,
  providerId: AiProviderId,
  role: AiTaskRole,
  model: string,
): string {
  const map = parseAiTaskModels(taskModelsRaw);
  const current = map[providerId] ?? emptyTaskModels();
  map[providerId] = { ...current, [role]: model.trim() };
  return serializeAiTaskModels(map);
}

export function getAiApiKeyForSettings(settings: {
  deepseek_api_key: string;
  zhipu_api_key: string;
  custom_api_key: string;
  ai_provider?: AiProviderId;
  deepseek_base_url: string;
}): string {
  const provider = normalizeAiProviderId(settings.ai_provider, settings.deepseek_base_url);
  const field = aiApiKeyFieldForProvider(provider);
  return String(settings[field] ?? "").trim();
}
export interface CreateProfileInput {
  name: string;
  theme_color?: string;
  proxy_id?: number | null;
  custom_proxy?: string | null;
  use_geoip?: boolean;
  humanize?: boolean;
  fingerprint_seed?: string;
  stealth_preset?: StealthPreset;
  webgl_mode?: WebglMode;
  browser_version?: string;
  startup_urls?: string;
}

export interface BatchCreateProfilesInput {
  prefix: string;
  count: number;
  theme_color?: string;
  proxy_strategy?: ProxyStrategy;
  proxy_id?: number | null;
  sequential_host?: string;
  sequential_start_port?: number;
  sequential_proxy_type?: "HTTP" | "SOCKS5";
  webgl_mode?: WebglMode;
  stealth_preset?: StealthPreset;
  startup_urls?: string;
  browser_version?: string;
}

export interface UpdateProfileInput {
  id: number;
  name: string;
  theme_color?: string;
  proxy_id?: number | null;
  custom_proxy?: string | null;
  use_geoip?: boolean;
  humanize?: boolean;
  fingerprint_seed?: string;
  stealth_preset?: StealthPreset;
  webgl_mode?: WebglMode;
  browser_version?: string;
  startup_urls?: string;
}

export interface AddProxyInput {
  type: "HTTP" | "SOCKS5" | "DYNAMIC_API" | string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  api_config?: string | null;
}

export interface DynamicApiProxyInput {
  api_url: string;
  protocol: "HTTP" | "SOCKS5";
  region: string;
  label?: string | null;
}

export interface ProxyTestResult {
  ok: boolean;
  message: string;
}

/** P1.3：邮箱 OTP 通道测试结果 */
export interface OtpChannelTestResult {
  ok: boolean;
  message: string;
  reason?: string | null;
}

/** P1.3 / P5.6：邮箱 OTP 通道（与 Host/Sidecar 契约对齐；网页邮箱须显式启用） */
export type OtpChannelType = "none" | "imap" | "tempmail_provider" | "webmail_adapter";

export type OtpChannelConfig =
  | { type: "none" }
  | {
      type: "imap";
      host: string;
      port: number;
      user: string;
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
      type: "webmail_adapter";
      enabled: true;
      providerId: string;
    };

/** P1.3 / P5.1：第三方验证码服务（enabled 默认关；密钥仅 apiKeyRef） */
export type CaptchaServiceConfig =
  | { type: "none"; enabled?: boolean }
  | {
      type: "third_party";
      enabled: boolean;
      providerId: string;
      apiKeyRef: string;
      note?: string;
    };

/** P5.3：短信接码平台（enabled 必须显式 true；密钥仅 apiKeyRef） */
export type SmsOtpServiceConfig =
  | { type: "none"; enabled?: boolean }
  | {
      type: "third_party";
      enabled: boolean;
      providerId: string;
      apiKeyRef: string;
      activationId?: string;
      note?: string;
    };

export function parseOtpChannelConfig(raw: string | null | undefined): OtpChannelConfig {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { type: "none" };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = String(parsed.type ?? "none")
      .trim()
      .toLowerCase();
    if (type === "imap") {
      const host = String(parsed.host ?? "").trim();
      const user = String(parsed.user ?? "").trim();
      const secretRef = String(parsed.secretRef ?? parsed.secret_ref ?? "").trim();
      const port = Number(parsed.port);
      if (!host || !user || !secretRef || !Number.isFinite(port) || port < 1 || port > 65535) {
        return { type: "none" };
      }
      const folder =
        typeof parsed.folder === "string" && parsed.folder.trim() ? parsed.folder.trim() : undefined;
      return {
        type: "imap",
        host,
        port: Math.floor(port),
        user,
        secretRef,
        folder,
        tls: parsed.tls === false ? false : true,
      };
    }
    if (type === "tempmail_provider" || type === "tempmail") {
      const providerId = String(parsed.providerId ?? parsed.provider_id ?? "").trim();
      const apiKeyRef = String(parsed.apiKeyRef ?? parsed.api_key_ref ?? "").trim();
      if (!providerId || !apiKeyRef) {
        return { type: "none" };
      }
      const inboxAddress =
        typeof parsed.inboxAddress === "string" && parsed.inboxAddress.trim()
          ? parsed.inboxAddress.trim()
          : undefined;
      return { type: "tempmail_provider", providerId, apiKeyRef, inboxAddress };
    }
    if (type === "webmail_adapter") {
      if (parsed.enabled !== true) return { type: "none" };
      const providerId = String(parsed.providerId ?? parsed.provider_id ?? "")
        .trim()
        .toLowerCase();
      if (providerId !== "gmail" && providerId !== "qq" && providerId !== "outlook") {
        return { type: "none" };
      }
      return { type: "webmail_adapter", enabled: true, providerId };
    }
    return { type: "none" };
  } catch {
    return { type: "none" };
  }
}

export function serializeOtpChannelConfig(channel: OtpChannelConfig): string {
  if (channel.type === "none") {
    return JSON.stringify({ type: "none" });
  }
  return JSON.stringify(channel);
}

export function parseCaptchaServiceConfig(raw: string | null | undefined): CaptchaServiceConfig {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { type: "none", enabled: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = String(parsed.type ?? "none")
      .trim()
      .toLowerCase();
    if (type === "third_party") {
      const providerId = String(parsed.providerId ?? parsed.provider_id ?? "").trim();
      const apiKeyRef = String(parsed.apiKeyRef ?? parsed.api_key_ref ?? "").trim();
      if (!providerId || !apiKeyRef) {
        return { type: "none", enabled: false };
      }
      return {
        type: "third_party",
        enabled: parsed.enabled === true,
        providerId,
        apiKeyRef,
        note: typeof parsed.note === "string" ? parsed.note : undefined,
      };
    }
    return { type: "none", enabled: false };
  } catch {
    return { type: "none", enabled: false };
  }
}

export function serializeCaptchaServiceConfig(config: CaptchaServiceConfig): string {
  if (config.type === "none") {
    return JSON.stringify({ type: "none", enabled: false });
  }
  return JSON.stringify(config);
}

export function parseSmsOtpServiceConfig(raw: string | null | undefined): SmsOtpServiceConfig {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { type: "none", enabled: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = String(parsed.type ?? "none")
      .trim()
      .toLowerCase();
    if (type === "third_party") {
      const providerId = String(parsed.providerId ?? parsed.provider_id ?? "").trim();
      const apiKeyRef = String(parsed.apiKeyRef ?? parsed.api_key_ref ?? "").trim();
      if (!providerId || !apiKeyRef) {
        return { type: "none", enabled: false };
      }
      const activationId =
        typeof parsed.activationId === "string" && parsed.activationId.trim()
          ? parsed.activationId.trim()
          : typeof parsed.activation_id === "string" && parsed.activation_id.trim()
            ? parsed.activation_id.trim()
            : undefined;
      return {
        type: "third_party",
        enabled: parsed.enabled === true,
        providerId,
        apiKeyRef,
        activationId,
        note: typeof parsed.note === "string" ? parsed.note : undefined,
      };
    }
    return { type: "none", enabled: false };
  } catch {
    return { type: "none", enabled: false };
  }
}

export function serializeSmsOtpServiceConfig(config: SmsOtpServiceConfig): string {
  if (config.type === "none") {
    return JSON.stringify({ type: "none", enabled: false });
  }
  return JSON.stringify(config);
}

export function otpSecretRefId(scope: "global" | number, kind: "imap" | "tempmail"): string {
  if (scope === "global") {
    return `otp:global:${kind}`;
  }
  return `otp:profile:${scope}:${kind}`;
}

export function captchaApiKeyRefId(): string {
  return "captcha:global:api";
}

export function smsOtpApiKeyRefId(): string {
  return "sms:global:api";
}

export interface ProfileIpGeo {
  profile_id: string;
  ip: string | null;
  country: string | null;
  country_code: string | null;
  region?: string | null;
  city?: string | null;
  status: "ok" | "no_proxy" | "error" | string;
  message?: string | null;
}

export interface StartProfileResult {
  profile_id: string;
  cdp_port: number;
  ip_geo?: ProfileIpGeo | null;
}

export interface SidecarLogPayload {
  line: string;
  parsed?: Record<string, unknown> | null;
}

export interface TerminalLine {
  id: string;
  ts: string;
  tone: "info" | "success" | "warn" | "error" | "progress";
  text: string;
  role?: "user" | "assistant" | "system";
  /** Agent Monitor 思考流卡片类型（可选；缺省时前端按文案归类） */
  kind?: "thought" | "perceive" | "action" | "alert" | "success" | "error" | "system";
  meta?: {
    tool?: string;
    target?: string;
    detail?: string;
    url?: string;
  };
}
/** AI 对话历史（传给 sidecar 多轮上下文） */
export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Ai Chat 附件（图片走 vision；文本类读入摘要；禁止当 OTP 取码依据） */
export interface ChatAttachmentPayload {
  kind: "image" | "text";
  name: string;
  mime: string;
  /** data:image/...;base64,... */
  dataUrl?: string;
  /** 文本类文件截断后的正文 */
  textContent?: string;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  skipped_running_ids: string[];
}

export interface FormTemplate {
  id: number;
  domain: string;
  template_name: string;
  actions: string;
  auto_apply: boolean;
  created_at: string;
}

export interface AgentTrajectory {
  id: number;
  domain: string;
  title: string;
  goal: string;
  start_url: string;
  actions: string;
  created_at: string;
  file_path?: string | null;
  file_name?: string | null;
  step_count?: number | null;
  source?: string | null;
}

/** P4.3：持久 Agent Run History（摘要；不含 OTP/密钥明文） */
export interface AgentRun {
  id: number;
  run_id: string;
  profile_id: string;
  goal: string;
  start_url: string;
  domain: string;
  status: string;
  success?: boolean | null;
  summary: string;
  step_count: number;
  hitl_occurred: boolean;
  trajectory_id?: number | null;
  /** JSON 数组：[{ts,text}, ...] */
  thought_summary: string;
  started_at: string;
  ended_at?: string | null;
  created_at: string;
  /** P5.4：供应商 usage 累计；缺失时前端按 0 / 未回报展示 */
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** 估算费用，micro-USD（1 美元 = 1_000_000）。不是账单。 */
  estimated_cost_micro_usd?: number;
  llm_calls?: number;
  llm_model?: string;
  cost_used_default_rate?: boolean;
  failure_class?: string;
  /** JSON 对象：失败 kind → 次数 */
  failure_counts?: string;
}

export interface AgentRunThoughtLine {
  ts: string;
  text: string;
}

/** P5.4：运行历史看板合计（同一张 agent_runs） */
export interface AgentRunBoard {
  run_count: number;
  finished_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_micro_usd: number;
  cost_used_default_rate: boolean;
  /** JSON：主失败类 → 未成功运行次数 */
  failure_classes: string;
  /** JSON：动作失败 kind → 次数 */
  failure_events: string;
}

/**
 * 同站控件记忆：Agent 成功点过的控件（意图 → 选择器/坐标），
 * 下次开局注入 sidecar 作为定位先验。
 */
export interface AgentControlMemory {
  id: number;
  domain: string;
  intent: string;
  intent_key: string;
  kind: string;
  selector: string;
  text_hint: string;
  x_percent?: number | null;
  y_percent?: number | null;
  hit_count: number;
  updated_at: string;
}
/** 沙盘动态表单字段（由轨迹 fill / agent_batch_fill 反推） */
export interface SandboxFormField {
  key: string;
  label: string;
  recordedValue: string;
  inputType?: string;
  semanticSource?: string;
}

/** 沙盘字段覆盖模式 */
export type SandboxFieldMode = "fixed" | "ai_prompt";

export interface SandboxFieldOverride {
  mode: SandboxFieldMode;
  value: string;
  label?: string;
  inputType?: string;
}

export interface PlanBatchEnvRow {
  envId: string;
  /** @deprecated 旧版纯字符串；新沙盘用 fieldOverrides */
  valueOverrides: Record<string, string>;
  fieldOverrides?: Record<string, SandboxFieldOverride>;
}

export interface PlanBatchDataResult {
  summary: string;
  planMatrix: PlanBatchEnvRow[];
}

/* ------------------------------------------------------------------ *
 * N13 · 回放预检单（RunPlan）—— 与 Host `replay_job.rs` 的结构一一对应
 * ------------------------------------------------------------------ */

/** 分配策略（§5.6） */
export type ReplayAllocMode = "seq_interleave" | "seq_block" | "claim" | "cycle" | "generate";
/** 数据行不够时怎么办（必须显式选择，不许静默） */
export type ReplayOnExhausted = "error" | "cycle" | "generate";
/** 标签策略 */
export type ReplayTabMode = "new" | "reuse" | "new_close";

export interface ReplayPlanWarning {
  /** `red` = 禁止启动；`yellow` = 允许但必须可见 */
  level: "red" | "yellow" | string;
  code: string;
  text: string;
}

export interface ReplayPlanRecord {
  source: "dataset" | "generate" | "clipboard" | string;
  /** 数据行号（0 基）；生成型为 null */
  index: number | null;
  /** 插值后的关键字段（用户看到的就是将要填进去的值） */
  preview: Record<string, unknown>;
}

export interface ReplayPlanTab {
  mode: ReplayTabMode | string;
  closeAfter: boolean;
  label: string;
}

export interface ReplayPlanRow {
  seq: number;
  envId: string;
  runIndex: number;
  uniqueId: number;
  skipped: boolean;
  record: ReplayPlanRecord;
  tab: ReplayPlanTab;
}

export interface ReplayPlanTotals {
  envs: number;
  repeatCount: number;
  totalRuns: number;
  plannedNewTabs: number;
  maxConcurrency: number;
  staggerMs: number;
}

export interface ReplayRunPlan {
  ok: boolean;
  planId: string;
  /** 执行时必须原样回传；Host 会重算比对，不一致 → 拒绝启动 */
  planHash: string;
  jobTitle: string;
  trajectoryId: number | null;
  trajectoryTitle: string;
  totals: ReplayPlanTotals;
  dataset: {
    source: string;
    size: number;
    columns: string[];
    hash: string | null;
  };
  allocation: {
    mode: ReplayAllocMode | string;
    onExhausted: ReplayOnExhausted | string;
    runSeed: number;
  };
  openInNewTab: boolean;
  closeAfter: boolean;
  stopOnFirstFailure: boolean;
  runTimeoutMs: number;
  warnings: ReplayPlanWarning[];
  /** 非空 → 禁止启动 */
  errors: ReplayPlanWarning[];
  rows: ReplayPlanRow[];
}

/** 单元级手工修改（§4.6.5） */
export interface ReplayPlanEdit {
  seq: number;
  useRecordIndex?: number | null;
  skipped?: boolean | null;
  recordSource?: "dataset" | "generate" | "clipboard" | null;
  tabMode?: ReplayTabMode | null;
}

/** 预检请求（与执行请求同构） */
export interface ReplayPlanRequest {
  trajectoryId: number | null;
  trajectoryTitle: string;
  actions: unknown[];
  goal: string;
  profileIds: string[];
  repeatCount: number;
  dataset: {
    source: "none" | "inline" | "clipboard";
    columns: string[];
    rows: Array<Record<string, string>>;
  };
  /** 轨迹字段 key → 数据集列名 */
  fieldMap: Record<string, string>;
  allocation: {
    mode: ReplayAllocMode;
    onExhausted: ReplayOnExhausted;
    runSeed?: number | null;
  };
  openInNewTab: boolean;
  closeAfter: boolean;
  stopOnFirstFailure: boolean;
  runTimeoutMs: number;
  maxConcurrency: number;
  staggerMs: number;
  edits: ReplayPlanEdit[];
  runSeed?: number | null;
}

export type RpaActionType = "fill" | "click" | "select" | "wait" | "navigate";

export interface RpaAction {
  step: number;
  type: RpaActionType;
  selector: string;
  dataKey?: string;
  value?: string;
  url?: string;
}

export interface RpaStatePayload {
  state: string;
  step: number;
  msg: string;
  actions?: RpaAction[] | null;
  profile_id: string;
}

export interface RpaRunResult {
  state: string;
  step: number;
  msg: string;
  actions?: RpaAction[] | null;
}
export const THEME_COLORS = ["#6366f1", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"] as const;
