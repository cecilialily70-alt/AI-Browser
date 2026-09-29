import { invoke } from "@tauri-apps/api/core";

import type {
  AddProxyInput,
  AppSettings,
  BatchCreateProfilesInput,
  BatchDeleteResult,
  ChatHistoryMessage,
  ChatAttachmentPayload,
  CloakBinaryStatus,
  CacheCleanupReport,
  BrowserDataEnvSummary,
  BrowserDataScope,
  PurgeBrowserDataReport,
  PurgeAllBrowserDataReport,
  ChatEnvSummary,
  ChatCadenceInput,
  ChatContactInput,
  ChatSliceResult,
  ChatPatrolReport,
  ChatStatusPayload,
  ChatConnectorStatusPayload,
  ChatConnectorDeletePayload,
  ChatContactsPayload,
  ChatThreadMessage,
  PurgeAllChatContextReport,
  PurgeChatContextReport,
  KeyFileActionResult,
  LicenseEntitlement,
  CreateProfileInput,
  DynamicApiProxyInput,
  AgentRun,
  AgentRunBoard,
  AgentTrajectory,
  AgentControlMemory,
  LocalKernel,
  PlanBatchDataResult,
  Profile,
  Proxy,
  ProxyTestResult,
  OtpChannelTestResult,
  ReplayPlanRequest,
  ReplayRunPlan,
  RpaAction,
  RpaRunResult,
  SandboxFieldOverride,
  StartProfileResult,
  UpdateProfileInput,
} from "../types";
import {
  emptyTaskModels,
  normalizeAiProviderId,
  parseAiExtraModels,
  parseAiTaskModels,
  serializeAiExtraModels,
  serializeAiTaskModels,
  type AiExtraModel,
  type AiProviderId,
} from "../types";

/**
 * 把「已经在用的模型」一次性搬进模型库 + 任务槽，让老用户升级后零感知 ——
 * 模型库本身是空的（不再预置任何写死的模型 ID），库里只有用户真正用过的那些。
 *
 * 只做加法：已有的库条目 / 任务槽原样保留，只在缺失时补；视觉档的模型打上 `vision`
 * 标记；旧字段（`*_chat_model`）同时补进 chat / agent 槽，避免出现
 * 「下拉空着但运行时其实在用」的错位。
 *
 * 纯函数且幂等，所以不必立刻落库；用户下次保存 AI 设置时自然写入。
 */
function migrateAiModelsOnce(
  raw: Record<string, string>,
  taskModelsRaw: string,
  legacy: Record<AiProviderId, string>,
): { aiExtraModels: string; aiTaskModels: string } {
  const library = parseAiExtraModels(raw.ai_extra_models ?? "[]");
  const byValue = new Map(library.map((item) => [item.value.toLowerCase(), item] as const));

  const ensureInLibrary = (value: string | undefined, provider: AiProviderId, vision: boolean): void => {
    const id = String(value ?? "").trim();
    if (!id) {
      return;
    }
    const key = id.toLowerCase();
    const existing = byValue.get(key);
    if (existing) {
      if (vision && !existing.vision) {
        existing.vision = true;
      }
      return;
    }
    const hint =
      provider === "zhipu" ? "智谱 BigModel" : provider === "custom" ? "自定义端点" : "DeepSeek";
    const entry: AiExtraModel = {
      value: id,
      label: id,
      hint,
      vision,
      provider,
      custom: true,
    };
    byValue.set(key, entry);
    library.push(entry);
  };

  const map = parseAiTaskModels(taskModelsRaw);
  for (const provider of ["deepseek", "zhipu", "custom"] as AiProviderId[]) {
    const row = map[provider] ?? emptyTaskModels();
    // 只有旧的单一 chat 字段有值时，才回填 chat / agent 两档（与运行时兜底口径一致）
    const legacyModel = String(legacy[provider] ?? "").trim();
    if (legacyModel) {
      if (!row.chat) {
        row.chat = legacyModel;
      }
      if (!row.agent) {
        row.agent = legacyModel;
      }
    }
    ensureInLibrary(row.chat, provider, false);
    ensureInLibrary(row.agent, provider, false);
    ensureInLibrary(row.vision, provider, true);
    if (row.chat || row.agent || row.vision) {
      map[provider] = row;
    }
  }

  return {
    aiExtraModels: serializeAiExtraModels(library),
    aiTaskModels: serializeAiTaskModels(map),
  };
}

export async function fetchProfiles(): Promise<Profile[]> {
  return invoke<Profile[]>("get_profiles");
}
/**
 * 原始 global_settings（key → 字符串值）。
 * `fetchSettings()` 只映射它认识的那部分键；规则库（`agent_rules` 等）这类新键必须走这里，
 * 否则会在被映射时丢掉。读侧一律经本函数，避免各处重复 invoke("get_settings")。
 */
export async function fetchRawSettings(): Promise<Record<string, string>> {
  try {
    return await invoke<Record<string, string>>("get_settings");
  } catch {
    return {};
  }
}

/**
 * 严格读取设置：失败时**抛出**而不是吞成空对象。
 * 供「规则库」这类「读失败就禁止保存」的场景使用 —— 若沿用途中的宽容版，
 * 读取失败会显示空库，用户随后任何保存都会把既有库覆盖成空。
 */
export async function fetchRawSettingsStrict(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_settings");
}
export async function fetchSettings(): Promise<AppSettings> {
  const raw = await fetchRawSettings();
  const baseUrl = raw.deepseek_base_url ?? "https://api.deepseek.com";
  const deepseekKey = raw.deepseek_api_key ?? "";
  const storedZhipu = raw.zhipu_api_key ?? "";
  const provider = normalizeAiProviderId(raw.ai_provider, baseUrl);
  // 升级兼容：此前智谱 Key 可能写在 deepseek_api_key
  const zhipuKey = storedZhipu || (provider === "zhipu" && deepseekKey ? deepseekKey : "");
  /**
   * 模型 ID 不再有写死的默认值：服务商迭代太快，写死必然过期。
   * 旧库里的 *_chat_model / ai_task_models 原样保留（历史值仍能用），
   * 空库则留给用户在「设置 → AI 设置 → 模型库」自己填。
   */
  const deepseekModel = raw.deepseek_chat_model ?? "";
  const zhipuModel = raw.zhipu_chat_model ?? "";
  const customModel = raw.custom_chat_model ?? "";
  const migrated = migrateAiModelsOnce(raw, raw.ai_task_models ?? "{}", {
    deepseek: deepseekModel,
    zhipu: zhipuModel,
    custom: customModel,
  });
  return {
    deepseek_api_key: deepseekKey,
    zhipu_api_key: zhipuKey,
    custom_api_key: raw.custom_api_key ?? "",
    ai_provider: provider,
    deepseek_base_url: baseUrl,
    deepseek_chat_model: deepseekModel,
    zhipu_chat_model: zhipuModel,
    custom_chat_model: customModel,
    ai_extra_models: migrated.aiExtraModels,
    ai_task_models: migrated.aiTaskModels,
    cloak_path: raw.cloak_path ?? "",
    cloak_license_key: raw.cloak_license_key ?? "",
    key_file_path: raw.key_file_path ?? "",
    kernel_paths: raw.kernel_paths ?? "{}",
    browser_download_dir: raw.browser_download_dir ?? "",
    scraper_download_dir: raw.scraper_download_dir ?? "",
    license_through_proxy: raw.license_through_proxy === "true" || raw.license_through_proxy === "1",
    allow_third_party_cookies:
      raw.allow_third_party_cookies === "true" || raw.allow_third_party_cookies === "1",
    fingerprint_off: raw.fingerprint_off === "true" || raw.fingerprint_off === "1",
    agent_sense_mode: (() => {
      const mode = (raw.agent_sense_mode ?? "balanced").trim().toLowerCase();
      if (mode === "economy" || mode === "classic") {
        return mode;
      }
      return "balanced";
    })(),
    default_browser_version: (raw.default_browser_version ?? "").trim(),
    otp_channel: (raw.otp_channel ?? "").trim(),
    captcha_service: (raw.captcha_service ?? "").trim(),
    sms_otp_service: (raw.sms_otp_service ?? "").trim(),
  };
}

/** 持久化 AI 服务商 / Key / 模型（切换即生效） */
export async function persistAiSettings(settings: AppSettings): Promise<void> {
  const provider = normalizeAiProviderId(settings.ai_provider, settings.deepseek_base_url);
  await Promise.all([
    updateSetting("ai_provider", provider),
    updateSetting("deepseek_api_key", settings.deepseek_api_key ?? ""),
    updateSetting("zhipu_api_key", settings.zhipu_api_key ?? ""),
    updateSetting("custom_api_key", settings.custom_api_key ?? ""),
    updateSetting("deepseek_base_url", settings.deepseek_base_url ?? ""),
    updateSetting("deepseek_chat_model", settings.deepseek_chat_model ?? ""),
    updateSetting("zhipu_chat_model", settings.zhipu_chat_model ?? ""),
    updateSetting("custom_chat_model", settings.custom_chat_model ?? ""),
    updateSetting("ai_extra_models", settings.ai_extra_models ?? "[]"),
    updateSetting("ai_task_models", settings.ai_task_models ?? "{}"),
  ]);
}

export async function pickDirectory(title?: string): Promise<string | null> {
  return invoke<string | null>("pick_directory", { title: title ?? null });
}

export async function openPathInOs(path: string): Promise<void> {
  await invoke("open_path_in_os", { path });
}

/** 打开「常规下载目录」或「数据目录」根路径（不存在则先创建）。 */
export async function openDownloadDir(track: "browser" | "scraper"): Promise<string> {
  return invoke<string>("open_download_dir", { track });
}

/** Write text into `{browser|scraper download root}/{profileId}/{filename}`. */
export async function exportTextToDownloadDir(input: {
  track: "browser" | "scraper";
  profileId: string;
  filename: string;
  content: string;
}): Promise<string> {
  return invoke<string>("export_text_to_download_dir", {
    track: input.track,
    profileId: input.profileId,
    filename: input.filename,
    content: input.content,
  });
}

export async function testAiConnection(baseUrl: string, apiKey: string): Promise<void> {
  return invoke("test_ai_connection", { baseUrl, apiKey });
}

export async function testCloakPath(path: string): Promise<void> {
  return invoke("test_cloak_path", { path });
}
/** Paste CloakBrowser official `cb_…` license key (no .tsk required). */
export async function setCloakLicenseKey(licenseKey: string): Promise<KeyFileActionResult> {
  return invoke<KeyFileActionResult>("set_cloak_license_key", { licenseKey });
}

export async function clearCloakLicenseKey(): Promise<KeyFileActionResult> {
  return invoke<KeyFileActionResult>("clear_cloak_license_key");
}

export async function checkLicenseEntitlement(): Promise<LicenseEntitlement> {
  return invoke<LicenseEntitlement>("check_license_entitlement");
}

/** 弹出系统文件选择框挑选 `.tsk` Key 文件；用户取消时返回 null */
export async function pickKeyFile(): Promise<string | null> {
  return invoke<string | null>("pick_key_file");
}

/** 解密并落库 Key 文件（等价于手工粘贴 cb_ 密钥），随后在线校验授权 */
export async function importKeyFile(path: string): Promise<KeyFileActionResult> {
  return invoke<KeyFileActionResult>("import_key_file", { path });
}

/** 只做解密与在线校验，不写入数据库 */
export async function testKeyFile(path: string): Promise<KeyFileActionResult> {
  return invoke<KeyFileActionResult>("test_key_file", { path });
}

export async function getCloakBinaryStatus(
  licenseKey?: string,
  browserVersion?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("get_cloak_binary_status", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
  });
}

/** 列出本地运行目录与缓存中已检测到的全部内核（本地运行目录优先）。 */
export async function listLocalKernels(): Promise<LocalKernel[]> {
  return invoke<LocalKernel[]>("list_local_kernels");
}

export async function downloadCloakBinary(
  licenseKey?: string,
  browserVersion?: string,
  downloadDir?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("download_cloak_binary", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
    downloadDir: downloadDir?.trim() || null,
  });
}

export async function updateCloakBinary(
  licenseKey?: string,
  browserVersion?: string,
  downloadDir?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("update_cloak_binary", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
    downloadDir: downloadDir?.trim() || null,
  });
}

export async function cleanupCloakBinary(
  licenseKey?: string,
  browserVersion?: string,
  downloadDir?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("cleanup_cloak_binary", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
    downloadDir: downloadDir?.trim() || null,
  });
}

export async function purgeAutomationCache(): Promise<CacheCleanupReport> {
  return invoke<CacheCleanupReport>("purge_automation_cache");
}

/**
 * 清理聊天上下文。`siteKey` / `contactKey` 可选：
 * 都不给 = 清该环境全部；只给 siteKey = 清该站点；两个都给 = 清该联系人。
 * 环境正在运行时会拒绝（避免把 Sidecar 正写的目录从底下抽掉）。
 */
export async function purgeChatContext(
  profileId: string,
  options?: { siteKey?: string | null; contactKey?: string | null },
): Promise<PurgeChatContextReport> {
  return invoke<PurgeChatContextReport>("purge_chat_context", {
    profileId,
    siteKey: options?.siteKey ?? null,
    contactKey: options?.contactKey ?? null,
  });
}

/** 有聊天上下文的环境总览（设置里的清理入口用） */
export async function listChatContextOverview(): Promise<ChatEnvSummary[]> {
  return invoke<ChatEnvSummary[]>("list_chat_context_overview");
}

/** 全局清理聊天上下文（运行中的环境会逐个列出原因地跳过） */
export async function purgeAllChatContexts(): Promise<PurgeAllChatContextReport> {
  return invoke<PurgeAllChatContextReport>("purge_all_chat_contexts");
}

/* ————————————————————————— 环境数据清理：Host 命令面 ————————————————————————— */

/** 各环境的 Cookie / 站点存储 / 缓存占用（设置页展示用，无副作用） */
export async function listBrowserDataOverview(): Promise<BrowserDataEnvSummary[]> {
  return invoke<BrowserDataEnvSummary[]>("list_browser_data_overview");
}

/**
 * 清理某个环境的浏览器身份数据（Cookie / 站点存储 / 缓存）。
 *
 * 与「清理缓存」不同：这里清的是**仍在列表里的这个环境自己的**站点数据 ——
 * 站点登录态坏了（例如网页版反复自我登出、二维码出不来）时用它复位。
 * 环境正在运行时会被拒绝（浏览器持有文件锁）。
 */
export async function purgeBrowserData(
  profileId: string,
  scope: BrowserDataScope = "all",
): Promise<PurgeBrowserDataReport> {
  return invoke<PurgeBrowserDataReport>("purge_browser_data", { profileId, scope });
}

/** 批量清理全部环境的数据（运行中的环境会逐个列出原因地跳过） */
export async function purgeAllBrowserData(
  scope: BrowserDataScope = "all",
): Promise<PurgeAllBrowserDataReport> {
  return invoke<PurgeAllBrowserDataReport>("purge_all_browser_data", { scope });
}

/* ————————————————————————— P7 聊天模式：Host 命令面 ————————————————————————— */

/**
 * 启动**一片**聊天值守（不是长任务）。
 *
 * Sidecar 跑完一片就让位并把 `nextWakeAt` 写进快照；调用方（视图 / P8 调度器）按需再拉起。
 * 环境浏览器未运行、引擎忙、没有明确目标都会被 Host 拒绝并给出可读原因。
 */
export async function chatStart(input: {
  profileId: string;
  contacts: ChatContactInput[];
  goal?: string;
  styleHint?: string;
  bannedWords?: string[];
  cadence?: ChatCadenceInput;
  sliceMs?: number;
  maxContactsPerSlice?: number;
  /**
   * 「没指定对象 → 用**当前打开的**聊天窗口」。
   *
   * 只在 `contacts` 为空时才有意义；Host 会照样放行到 Sidecar，
   * 由 Sidecar 运行期判定「当前那个标签确实是聊天页」（判不出来就如实失败，不猜）。
   */
  useCurrentWindow?: boolean;
  /**
   * 人工优先（§5）：用户为**单个联系人**指定的接管模式。
   * 键是联系人稳定身份（与快照/索引表同源）；缺省不传即全部按引擎值守。
   */
  takeovers?: Record<string, "engine" | "human" | "paused">;
  /**
   * 每联系人开关（§5.7）：`{ "<站点>|<联系人>": { autoReply?, followUp? } }`。
   * 与 `takeovers` 同一套键；缺省不传＝两个开关都开（老行为不变）。
   */
  contactFlags?: Record<string, { autoReply?: boolean; followUp?: boolean }>;
  /** 聊天角色库（原样转发；合法性由 Sidecar 解析） */
  roles?: Array<{ id: string; name: string; prompt: string }>;
  /** 当前选用的角色 id；`null`＝无角色 */
  activeRoleId?: string | null;
  /**
   * 自定义发图图库目录；空 / 不传 = 软件自带 `chat_media`。
   * Host 只读转发，合法性与是否存在由 Sidecar 处理。
   */
  mediaLibraryDir?: string | null;
}): Promise<ChatSliceResult> {
  return invoke<ChatSliceResult>("chat_start", {
    profileId: input.profileId,
    goal: input.goal ?? null,
    contacts: input.contacts,
    styleHint: input.styleHint ?? null,
    bannedWords: input.bannedWords ?? null,
    cadence: input.cadence ?? null,
    takeovers: input.takeovers ?? null,
    contactFlags: input.contactFlags ?? null,
    roles: input.roles ?? null,
    activeRoleId: input.activeRoleId ?? null,
    mediaLibraryDir: input.mediaLibraryDir?.trim() || null,
    sliceMs: input.sliceMs ?? null,
    maxContactsPerSlice: input.maxContactsPerSlice ?? null,
    useCurrentWindow: input.useCurrentWindow ?? false,
  });
}

/** 停住聊天值守（即时生效，不等待） */
export async function chatStop(profileId: string, reason?: string): Promise<void> {
  return invoke<void>("chat_stop", { profileId, reason: reason ?? null });
}

/** 聊天模式状态（Host 事实 + 引擎快照 + 每联系人索引） */
export async function chatStatus(profileId: string): Promise<ChatStatusPayload> {
  return invoke<ChatStatusPayload>("chat_status", { profileId });
}

/** 某联系人会话流水尾部（已脱敏） */
export async function getChatThreadMessages(
  profileId: string,
  siteKey: string,
  contactKey: string,
  limit?: number,
): Promise<ChatThreadMessage[]> {
  return invoke<ChatThreadMessage[]>("get_chat_thread_messages", {
    profileId,
    siteKey,
    contactKey,
    limit: limit ?? null,
  });
}

/**
 * 读当前浏览器里那个聊天页的**会话列表**（视图里勾选聊天对象的唯一入口）。
 *
 * 只读探针：不建会话、不改状态。环境浏览器没跑、引擎正忙或没有认得出来的聊天页时，
 * Host 会**拒绝**并给出人话原因（`ok:false` 也带原因，绝不把「读不到」说成「你没有会话」）。
 */
export async function chatListContacts(profileId: string): Promise<ChatContactsPayload> {
  return invoke<ChatContactsPayload>("chat_list_contacts", { profileId });
}

/** 宿主聊天调度器快照（含被看门狗挂起自动拉起的环境） */
export async function chatPatrolState(): Promise<ChatPatrolReport> {
  return invoke<ChatPatrolReport>("chat_patrol_state");
}

/* ————————————————————— 站点描述符：学习 / 查看 / 删除（P5 发现流水线） ————————————————————— */

/** 列站点支持（无浏览器也可用：纯文件系统 + 权威校验器，0 token） */
export async function chatConnectorStatus(profileId: string): Promise<ChatConnectorStatusPayload> {
  return invoke<ChatConnectorStatusPayload>("chat_connector_status", { profileId });
}

/** 删除一个**学来的**描述符（内置的删不掉） */
export async function chatConnectorDelete(
  profileId: string,
  siteKey: string,
): Promise<ChatConnectorDeletePayload> {
  return invoke<ChatConnectorDeletePayload>("chat_connector_delete", { profileId, siteKey });
}

/**
 * 学习当前站点（长任务，一片完成）。
 *
 * `url` 留空 = 用**此刻打开的**聊天窗口（Sidecar 会判定那确实是聊天页；判不出来就如实失败）。
 * `selfTestContact` 是写入自测对象 —— **必须是你自己的会话/收藏夹**：会给它发一条固定文案的
 * 自检消息，再读回来逐字核对。不给就只验读、并如实标注写入未验证。
 */
export async function chatLearnSite(input: {
  profileId: string;
  url?: string | null;
  siteLabel?: string | null;
  selfTestContact?: { label: string; url?: string | null } | null;
  slot?: "logic" | "fast_text";
  maxRounds?: number;
}): Promise<ChatSliceResult> {
  return invoke<ChatSliceResult>("chat_learn_site", {
    profileId: input.profileId,
    url: input.url?.trim() || null,
    siteLabel: input.siteLabel?.trim() || null,
    selfTestContact: input.selfTestContact ?? null,
    slot: input.slot ?? null,
    maxRounds: input.maxRounds ?? null,
  });
}

/** 人工恢复某环境被挂起的自动值守（明确意图才恢复，不自动重试） */
export async function chatPatrolResume(profileId: string): Promise<ChatPatrolReport> {
  return invoke<ChatPatrolReport>("chat_patrol_resume", { profileId });
}

export async function diagnoseCloakBinary(
  licenseKey?: string,
  browserVersion?: string,
  downloadDir?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("diagnose_cloak_binary", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
    downloadDir: downloadDir?.trim() || null,
  });
}

export async function batchAddProxies(proxies: AddProxyInput[]): Promise<number> {
  return invoke<number>("batch_add_proxies", { proxies });
}

export async function batchDeleteProxies(proxyIds: number[]): Promise<number> {
  return invoke<number>("batch_delete_proxies", { proxyIds });
}

export async function updateSetting(key: keyof AppSettings | string, value: string): Promise<void> {
  return invoke("update_setting", { key, value });
}

/** 外部数据 API 状态（是否启用 / 地址 / 令牌 / 限额）。令牌仅本机可见，出网无门。 */
export interface ExternalDataApiState {
  enabled: boolean;
  running: boolean;
  baseUrl: string | null;
  token: string;
  docsPath: string;
  limits: {
    maxFields: number;
    maxValueChars: number;
    maxRunningReplayJobs?: number;
    maxRepeatCount?: number;
    maxConcurrency?: number;
  };
  /** 独立能力开关（各自默认关）：回放族 / 剪贴板读取 */
  capabilities?: { replay: boolean; clipboard: boolean };
  appVersion: string;
  apiVersion: string;
  app: string;
}

export async function getExternalDataApiState(): Promise<ExternalDataApiState> {
  return invoke<ExternalDataApiState>("get_external_data_api_state");
}

export async function setExternalDataApiEnabled(enabled: boolean): Promise<Partial<ExternalDataApiState>> {
  return invoke<Partial<ExternalDataApiState>>("set_external_data_api_enabled", { enabled });
}

/** 开关独立能力：`replay`（/v1/replay 族）或 `clipboard`（/v1/clipboard）。立即生效，不需重启服务。 */
export async function setExternalDataApiCapability(
  capability: "replay" | "clipboard",
  enabled: boolean,
): Promise<{ capability: string; enabled: boolean }> {
  return invoke<{ capability: string; enabled: boolean }>("set_external_data_api_capability", {
    capability,
    enabled,
  });
}

export async function regenerateExternalDataApiToken(): Promise<Partial<ExternalDataApiState>> {
  return invoke<Partial<ExternalDataApiState>>("regenerate_external_data_api_token");
}

export async function fetchProxies(): Promise<Proxy[]> {
  return invoke<Proxy[]>("get_proxies");
}

export async function addProxy(proxy: AddProxyInput): Promise<Proxy> {
  return invoke<Proxy>("add_proxy", { proxy });
}

export async function addDynamicApiProxy(input: DynamicApiProxyInput): Promise<Proxy> {
  return invoke<Proxy>("add_dynamic_api_proxy", { input });
}

export async function testProxyConnection(proxy: string): Promise<ProxyTestResult> {
  return invoke<ProxyTestResult>("test_proxy_connection", { proxy });
}

/** P1.3：写入命名密钥（DPAPI）；返回值不含明文 */
export async function putSecretRef(refId: string, plaintext: string, kind?: string): Promise<void> {
  return invoke("put_secret_ref", {
    refId,
    plaintext,
    kind: kind ?? "otp",
  });
}

export async function deleteSecretRef(refId: string): Promise<boolean> {
  return invoke<boolean>("delete_secret_ref", { refId });
}

export async function secretRefExists(refId: string): Promise<boolean> {
  return invoke<boolean>("secret_ref_exists", { refId });
}

/** 环境级邮箱 OTP 通道绑定；空字符串清除 */
export async function setProfileOtpChannel(
  profileId: string | number,
  channelJson: string,
): Promise<Profile> {
  return invoke<Profile>("set_profile_otp_channel", {
    profileId: String(profileId),
    channelJson,
  });
}

/** 测试邮箱 OTP 通道连通性（IMAP LOGIN / 临时邮结构校验） */
export async function testOtpChannel(
  channelJson: string,
  draftSecret?: string | null,
): Promise<OtpChannelTestResult> {
  return invoke<OtpChannelTestResult>("test_otp_channel", {
    channelJson,
    draftSecret: draftSecret?.trim() ? draftSecret.trim() : null,
  });
}

export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  return invoke<Profile>("create_profile", { input });
}

export async function batchCreateProfiles(input: BatchCreateProfilesInput): Promise<Profile[]> {
  return invoke<Profile[]>("batch_create_profiles", { input });
}

export async function updateProfile(input: UpdateProfileInput): Promise<Profile> {
  return invoke<Profile>("update_profile", { input });
}

export async function requestProfileInteractiveExtract(profileId: string): Promise<void> {
  return invoke<void>("request_profile_interactive_extract", {
    profileId: String(profileId),
  });
}

export async function deleteProfile(profileId: string): Promise<void> {
  return invoke("delete_profile", { profileId });
}

export async function batchDeleteProfiles(profileIds: string[]): Promise<BatchDeleteResult> {
  return invoke<BatchDeleteResult>("batch_delete_profiles", { profileIds });
}

export async function startProfile(profileId: string): Promise<StartProfileResult> {
  return invoke<StartProfileResult>("start_profile", { profileId });
}

export async function stopProfile(profileId: string): Promise<void> {
  return invoke("stop_profile", { profileId });
}

export async function stopAllProfiles(): Promise<number> {
  return invoke<number>("stop_all_profiles");
}

export async function prepareConsoleExit(keepBrowsers: boolean): Promise<void> {
  return invoke("prepare_console_exit", { keepBrowsers });
}

export async function getRunningProfileIds(): Promise<string[]> {
  return invoke<string[]>("get_running_profile_ids");
}

export interface CookieExportResult {
  format: string;
  count: number;
  content: string;
}

export interface CookieImportResult {
  count: number;
  appliedNow: boolean;
  pendingPath?: string | null;
}

export async function exportProfileCookies(
  profileId: string,
  format: "json" | "netscape" = "json",
): Promise<CookieExportResult> {
  return invoke<CookieExportResult>("export_profile_cookies", { profileId, format });
}

export async function importProfileCookies(profileId: string, payload: string): Promise<CookieImportResult> {
  return invoke<CookieImportResult>("import_profile_cookies", { profileId, payload });
}
export async function previewAiFill(profileId: string, rawInput: string): Promise<string> {
  return invoke<string>("preview_ai_fill", { profileId, rawInput });
}

export async function runSmartFill(
  profileId: string,
  naturalLanguage: string,
  seedInput?: string,
  pressEnterAfterFill?: boolean,
): Promise<string> {
  return invoke<string>("run_smart_fill", {
    profileId,
    naturalLanguage,
    seedInput: seedInput ?? null,
    pressEnterAfterFill: pressEnterAfterFill ?? false,
  });
}

export async function runDirectFill(
  profileId: string,
  rawInput: string,
  pressEnterAfterFill?: boolean,
): Promise<void> {
  return invoke("run_direct_fill", {
    profileId,
    rawInput,
    pressEnterAfterFill: pressEnterAfterFill ?? false,
  });
}
export async function sendAiChat(
  message: string,
  profileId?: string,
  history?: ChatHistoryMessage[],
  options?: {
    attachments?: ChatAttachmentPayload[];
    scrapeSummary?: string;
  },
): Promise<string> {
  return invoke<string>("ai_chat", {
    message,
    profileId: profileId ?? null,
    history: history ?? [],
    attachments: options?.attachments ?? [],
    scrapeSummary: options?.scrapeSummary ?? null,
  });
}

export interface RunRpaFillOptions {
  actions?: RpaAction[];
  confirmedProfile?: string;
  skipHybrid?: boolean;
  pressEnterAfterFill?: boolean;
  /** 轨迹记忆回放：点击后不暂停，连续跑完 */
  continuous?: boolean;
}

export async function runRpaFill(
  profileId: string,
  rawInput: string,
  options?: RunRpaFillOptions,
): Promise<RpaRunResult> {
  return invoke<RpaRunResult>("run_rpa_fill", {
    profileId,
    rawInput,
    actions: options?.actions ?? null,
    confirmedProfile: options?.confirmedProfile ?? null,
    skipHybrid: options?.skipHybrid ?? false,
    pressEnterAfterFill: options?.pressEnterAfterFill ?? false,
    continuous: options?.continuous ?? false,
  });
}

export interface AgentRunResult {
  state: string;
  step: number;
  msg: string;
}

export async function startAutonomousAgent(
  profileId: string,
  goal: string,
  maxRounds?: number,
  senseMode?: "economy" | "balanced" | "classic",
  enableRecording?: boolean,
  options?: {
    /** Agent 输入框附件（图片→vision、文本→摘要；禁止当 OTP 取码依据） */
    attachments?: ChatAttachmentPayload[];
    /** 用户自定义规则（完成条件 / 检查点 / 提醒 / 人工介入 / 必须点击 / 固定数据） */
    taskRules?: Array<Record<string, unknown>>;
    /** 本环境启用的人设：fields = 固定字段，fixed = 字段值 */
    taskPersona?: {
      label: string;
      fields: string[];
      fixed: Record<string, string>;
    } | null;
  },
): Promise<AgentRunResult> {
  return invoke<AgentRunResult>("start_autonomous_agent", {
    profileId,
    goal,
    maxRounds: maxRounds ?? 200,
    senseMode: senseMode ?? "balanced",
    enableRecording: enableRecording === true,
    attachments: options?.attachments ?? [],
    taskRules: options?.taskRules ?? [],
    taskPersona: options?.taskPersona ?? null,
  });
}

export async function confirmAgentAction(
  profileId: string,
  requestId: string,
  fillOverrides?: Record<string, string>,
): Promise<void> {
  return invoke("confirm_agent_action", {
    profileId,
    requestId,
    fillOverrides: fillOverrides ?? null,
  });
}

export async function cancelAgentAction(profileId: string, requestId?: string): Promise<void> {
  return invoke("cancel_agent_action", {
    profileId,
    requestId: requestId ?? null,
  });
}

export async function replyAgentAsk(profileId: string, requestId: string, answer: string): Promise<void> {
  return invoke("reply_agent_ask", {
    profileId,
    requestId,
    answer,
  });
}

export async function continueAgentHandover(profileId: string, requestId?: string): Promise<void> {
  return invoke("continue_agent_handover", {
    profileId,
    requestId: requestId ?? null,
  });
}

/** P4.5：暂停 Agent（软闸；恢复用 continueAgentHandover） */
export async function pauseAutonomousAgent(profileId: string): Promise<void> {
  return invoke("pause_autonomous_agent", { profileId });
}

/** 用户标记成功：当前步结束后以成功收尾（若已勾选录制则写入轨迹） */
export async function markAgentSuccess(profileId: string): Promise<void> {
  return invoke("mark_agent_success", { profileId });
}

export async function abortAutonomousAgent(profileId: string): Promise<void> {
  return invoke("abort_autonomous_agent", { profileId });
}

/** Milestone 4：唤起环境浏览器前台（CDP bringToFront + Win 任务栏） */
export async function bringProfileToFront(profileId: string): Promise<void> {
  return invoke("bring_profile_to_front", { profileId });
}

export async function getProfilePageUrl(profileId: string): Promise<string> {
  return invoke<string>("get_profile_page_url", { profileId });
}

/**
 * 轨迹列表结果。
 *
 * `file_error` 非空表示轨迹文件目录不可读、已降级为仅 SQLite 记录——
 * 此时必须显式提示用户，否则「列表变空」会被误读为录制丢失。
 */
export interface TrajectoryListResult {
  rows: AgentTrajectory[];
  file_error?: string | null;
}

export async function listAgentTrajectories(domain: string): Promise<TrajectoryListResult> {
  return invoke<TrajectoryListResult>("list_agent_trajectories", { domain });
}

export async function deleteAgentTrajectory(trajectoryId: number, filePath?: string | null): Promise<void> {
  return invoke("delete_agent_trajectory", {
    trajectoryId,
    filePath: filePath ?? null,
  });
}

/** P4.3：可搜索 Agent Run History */
export async function listAgentRuns(query?: string, limit = 100): Promise<AgentRun[]> {
  return invoke<AgentRun[]>("list_agent_runs", {
    query: query?.trim() || null,
    limit,
  });
}

/** P5.4：本机合计 token / 估算费用 / 失败分类 */
export async function summarizeAgentRunBoard(): Promise<AgentRunBoard> {
  return invoke<AgentRunBoard>("summarize_agent_run_board");
}

export async function getAgentRun(id: number): Promise<AgentRun> {
  return invoke<AgentRun>("get_agent_run", { id });
}

export async function deleteAgentRun(id: number): Promise<void> {
  return invoke("delete_agent_run", { id });
}

export async function batchDeleteAgentRuns(ids: number[]): Promise<number> {
  return invoke<number>("batch_delete_agent_runs", { ids });
}

/**
 * 同站控件记忆。`domain` 留空返回全部（开局注入即用全量）。
 * 写入口只有 sidecar 的落库队列，前端只读与清理。
 */
export async function listAgentControlMemory(domain?: string): Promise<AgentControlMemory[]> {
  return invoke<AgentControlMemory[]>("list_agent_control_memory", {
    domain: domain?.trim() || null,
  });
}

/** 返回被清理的条数；`domain` 留空清全部（同时抹掉 sidecar 的磁盘备份） */
export async function clearAgentControlMemory(domain?: string): Promise<number> {
  return invoke<number>("clear_agent_control_memory", {
    domain: domain?.trim() || null,
  });
}

export async function replayAgentTrajectory(
  profileId: string,
  options: {
    filePath?: string | null;
    actions?: unknown[] | null;
    title?: string;
    goal?: string;
    valueOverrides?: Record<string, string | SandboxFieldOverride> | null;
    /** 每环境运行次数（默认 1，上限 100）；带 `plan` 时以预检单为准 */
    repeatCount?: number | null;
    /** 回放默认在新标签里跑（默认 true） */
    openInNewTab?: boolean | null;
    /** 每轮开始前关掉上一轮回放标签（默认 false） */
    closePreviousTab?: boolean | null;
    /**
     * N13：预检单（`/v1/replay/plan` 的产物）。带上即走「按表执行」：
     * Host 先重算 `planHash` 比对（不一致 → 拒绝启动），再按台账逐轮领取执行。
     */
    plan?: ReplayRunPlan | null;
    planHash?: string | null;
    /** 已解析的数据集行（与预检单同源；Host 按 `record_index` 取行） */
    datasetRows?: Array<Record<string, string>> | null;
    /** 轨迹字段 → 数据集列 */
    fieldMap?: Record<string, string> | null;
    /**
     * N5 / N6：剪贴板运行策略。
     * `treatAsHuman=true` = 用户显式勾选「剪贴板视为人工提供」（一次性凭证才允许自动填入）。
     */
    clipboard?: { mode?: "snapshot" | "per_run" | "off"; treatAsHuman?: boolean } | null;
    /**
     * 回放目标里的 `@规则名` 引用载荷（缺省 = 不校验）。
     * Sidecar 在机械步跑完后用同一份「用户硬约束」判定硬校验（严格完成条件 / 必须点击 / 固定数据），
     * 没满足就不报成功。
     */
    taskRules?: Array<Record<string, unknown>> | null;
    /** 回放目标里的 `@人设名` 引用载荷（`{ label, fixed }`；authoritative 固定字段） */
    taskPersona?: { label: string; fixed: Record<string, string> } | null;
    /**
     * `@人设` 展开的 `{{persona.*}}` 模板值（**整套字段**，不受「固定字段」勾选限制）。
     * 缺省时 Host 回落到旧数据（前端已不再写入，基本为空）。
     */
    personaData?: Record<string, string> | null;
  },
): Promise<RpaRunResult> {
  return invoke<RpaRunResult>("replay_agent_trajectory", {
    profileId,
    filePath: options.filePath ?? null,
    actions: options.actions ?? null,
    title: options.title ?? null,
    goal: options.goal ?? null,
    valueOverrides: options.valueOverrides ?? null,
    repeatCount: options.repeatCount ?? null,
    openInNewTab: options.openInNewTab ?? null,
    closePreviousTab: options.closePreviousTab ?? null,
    plan: options.plan ?? null,
    planHash: options.planHash ?? null,
    datasetRows: options.datasetRows ?? null,
    fieldMap: options.fieldMap ?? null,
    clipboard: options.clipboard ?? null,
    taskRules: options.taskRules ?? null,
    taskPersona: options.taskPersona ?? null,
    personaData: options.personaData ?? null,
  });
}

/**
 * N13 · 生成回放预检单（**干跑**：不启动任何页面、不占台账、不改环境状态）。
 *
 * 任何参数变化都要重新调用本函数拿新的 `planHash` —— 不要在前端自己拼 hash。
 */
export async function buildReplayRunPlan(request: ReplayPlanRequest): Promise<ReplayRunPlan> {
  return invoke<ReplayRunPlan>("build_replay_run_plan", {
    request: {
      ...request,
      filePath: request.filePath ?? null,
    },
  });
}

export async function planBatchReplayData(input: {
  selectors: string[];
  envIds: string[];
  userPrompt: string;
  fileData?: string;
}): Promise<PlanBatchDataResult> {
  return invoke<PlanBatchDataResult>("plan_batch_replay_data", {
    selectors: input.selectors,
    envIds: input.envIds,
    userPrompt: input.userPrompt,
    fileData: input.fileData ?? null,
  });
}

export interface MockSandboxFieldsResult {
  envId: string;
  /** 字段 key → AI 生成的具体值 */
  valueOverrides: Record<string, string>;
  summary: string;
}

/**
 * 沙盘字段级 AI 造数：给定字段与目标环境，返回一批可直接写入表单的具体值。
 * 与「AI 盲盒」不同 —— 后者把生成推迟到运行时 JIT，这里当场产出值供人工核对。
 */
export async function mockSandboxFields(input: {
  envId: string;
  fields: Array<{ key: string; label: string; currentValue: string }>;
  /** 只重新生成其中部分字段，其余保持原值 */
  onlyKeys?: string[];
  /**
   * 目标里 `@人设名` 引用的整套字段（`{{persona.*}}` 同源）。
   * 带上时造数用这套身份；缺省则回落到旧数据（前端已不再写入，基本为空 → 现生成）。
   */
  persona?: Record<string, string> | null;
}): Promise<MockSandboxFieldsResult> {
  return invoke<MockSandboxFieldsResult>("mock_sandbox_fields", {
    envId: input.envId,
    fields: input.fields,
    onlyKeys: input.onlyKeys ?? null,
    geoHint: null,
    persona: input.persona ?? null,
  });
}

function parseStructuredError(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { kind?: string; message?: string };
    if (parsed.kind && parsed.message) {
      return `${parsed.kind}: ${parsed.message}`;
    }
  } catch {
    return null;
  }
  return null;
}

export function formatInvokeError(error: unknown): string {
  if (typeof error === "string") {
    return parseStructuredError(error) ?? error;
  }
  if (error instanceof Error) {
    return parseStructuredError(error.message) ?? error.message;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { kind?: string; message?: string };
    if (record.kind && record.message) {
      return `${record.kind}: ${record.message}`;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * 用户主动停止 / Abort / NotRunning：视为正常结束，禁止红 Banner。
 */
export function isBenignAgentStopError(error: unknown): boolean {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? `${error.name} ${error.message}`
        : typeof error === "object" && error !== null
          ? JSON.stringify(error)
          : String(error);
  const text = raw.toLowerCase();
  return (
    text.includes("notrunning") ||
    text.includes("aborterror") ||
    text.includes("abort") ||
    text.includes("canceled") ||
    text.includes("cancelled") ||
    text.includes("已被用户中止") ||
    text.includes("用户中止") ||
    text.includes("agent_abort") ||
    text.includes("手动停止") ||
    text.includes("浏览器已关闭") ||
    text.includes("浏览器关闭")
  );
}

export function proxyLabel(proxy: Proxy): string {
  if (proxy.type === "DYNAMIC_API") {
    try {
      const config = JSON.parse(proxy.api_config ?? "{}") as { label?: string; region?: string };
      return config.label ?? `API 动态提取 (${config.region ?? "hk"})`;
    } catch {
      return "API 动态提取";
    }
  }
  return `${proxy.type}://${proxy.host}:${proxy.port}`;
}
