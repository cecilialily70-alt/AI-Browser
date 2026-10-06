/**
 * 聊天模式的用户设置（`global_settings.chat_mode`，JSON 字符串）。
 *
 * 纪律（§3.5 / §5.7 / §9）：
 * - **默认关**：`enabled=false` 时任何地方都不得为聊天注册定时器或自动拉起（§0.5.2）。
 * - 节奏默认值**逐字镜像** Sidecar `core/web_chat/cadence.ts::DEFAULT_CADENCE`，
 *   避免「设置里显示 48h、实际跑 24h」这类两套默认值互相打架。
 * - 解析失败/越界**不静默降级**：能修的夹到合法区间，不能修的记进 `diagnostics` 由调用方展示。
 */

import type { ChatContactInput } from "../types";

export const DEFAULT_QUIET_HOURS = { start: "22:00", end: "08:00" } as const;

/**
 * 回访节奏各字段的**唯一区间口径**（`[下限, 上限]`），与 Sidecar
 * `core/web_chat/cadence.ts::CADENCE_LIMITS` **逐字一致**。
 *
 * 纪律：**界面上能填的范围 = 引擎真正接受的范围**。以前前端夹在 1–1440、侧车无上界，
 * 同一个输入两种结论（§0.5.3 C）。改这里必须同时改侧车，
 * 由 `sidecar/tests/chat-settings-parity.mjs` 做源码级对齐断言。
 * `maxFollowUps` / `followUpCoolDownDays` / `maxPerDay` 的 **0 是实义值**（不追发 / 不冷却 / 不限）。
 */
export const CADENCE_LIMITS = {
  followUpHours: [1, 1440],
  maxFollowUps: [0, 60],
  followUpCoolDownDays: [0, 365],
  followUpRevivalDays: [1, 3650],
  maxPerDay: [0, 2000],
  jitterRatio: [0, 0.5],
} as const;

/** 与 Sidecar `DEFAULT_CADENCE` 对齐 */
export const DEFAULT_CHAT_CADENCE: ChatCadenceSettings = {
  followUpEnabled: false,
  followUpHours: 48,
  followUpBackoffHours: [96, 168],
  maxFollowUps: 0,
  followUpCoolDownDays: 10,
  followUpRevivalDays: 90,
  quietHours: null,
  maxPerDay: 0,
  jitterRatio: 0.1,
};

export interface ChatCadenceSettings {
  followUpEnabled: boolean;
  followUpHours: number;
  followUpBackoffHours: number[];
  maxFollowUps: number;
  followUpCoolDownDays: number;
  followUpRevivalDays: number;
  quietHours: { start: string; end: string } | null;
  maxPerDay: number;
  jitterRatio: number;
}

/** 视图里的一行聊天目标（不进 Sidecar，只作「常用目标」便于下次恢复） */
export interface ChatTargetDraft {
  label: string;
  url: string;
}

/** 每个联系人可选择的人工接管模式（与 Sidecar `CHAT_TAKEOVER_MODES` 逐字一致） */
export const CHAT_TAKEOVER_MODES = ["engine", "human", "paused"] as const;
export type ChatTakeoverMode = (typeof CHAT_TAKEOVER_MODES)[number];

/**
 * 接管键的**唯一产生口径**：`<站点目录段>|<联系人目录段>`（`ChatThreadRow` 的
 * `siteKey` / `contactKey` 就是这两段，都已经是目录名）。
 *
 * 为什么收敛成一个函数：以前视图、引擎、索引表各拼一套，写进去的键和查表的键对不上，
 * 表现是「点了『引擎值守』毫无反应」或「卡片显示我接管、日志说引擎还在发」（§0.5.3 H）。
 * 侧车 `chat_session.ts::takeoverKeyOf` 与之逐字一致，由 `chat-settings-parity.mjs` 锁住。
 */
export function takeoverKeyOf(siteKey: string, contactKey: string): string {
  return `${siteKey}|${contactKey}`;
}

export interface ChatModeSettings {
  enabled: boolean;
  /** 聊天的大方向（可写 @人设名 / @规则名，与 Agent 同一套解析） */
  goal: string;
  /** 语气风格提示（可选） */
  styleHint: string;
  /** 绝对不说的词（逗号分隔存储前的原始数组） */
  bannedWords: string[];
  sliceMs: number;
  maxContactsPerSlice: number;
  /**
   * 同时最多几个环境在值守（宿主调度器席位口径）。
   * 免费档**恒为 1**（与 Agent 的 `resolveAgentMaxAllowed` 同一条纪律），
   * Pro 也受 {@link CHAT_PARALLEL_MAX} 硬顶约束 —— 不为聊天开不受限通道（R7）。
   */
  maxParallelSlices: number;
  /** 每个环境的常用目标（key = profileId） */
  targetsByEnv: Record<string, ChatTargetDraft[]>;
  /**
   * 「**没指定对象**时，直接用当前打开的聊天窗口」。
   *
   * 为什么默认开：用户对着一个已经开好的会话说「聊吧」是最自然的用法，
   * 这时还要求他先抄一遍昵称和会话 URL 是纯负担。它**只在目标为空时生效**，
   * 且只认「已经开着、且判定为聊天页」的标签 —— 判不出来就如实失败，绝不猜、绝不新开标签。
   */
  useCurrentWindow: boolean;
  cadence: ChatCadenceSettings;
  /**
   * 用户为**单个联系人**指定的人工接管模式（§5「人工优先」）。
   *
   * 键是联系人稳定身份（`conversationKeyOf` 算出的 `contact_key`，与快照/索引表同源），
   * 值是 `engine`（交还给引擎值守，默认）/ `human`（用户接管，引擎只记账不发）/ `paused`（彻底不碰）。
   *
   * 为什么不落快照文件：快照的**唯一写入方**是 Sidecar 引擎，Host 或前端去写会与正在跑的片抢文件。
   * 用户意图存设置（片启动时读一次），引擎自己检测到的接管存快照，取「用户优先」。
   */
  takeovers: Record<string, ChatTakeoverMode>;
  /**
   * 每联系人开关（§5.7）：`{ "<站点>|<联系人>": { autoReply?, followUp? } }`。
   *
   * 与 {@link ChatModeSettings.takeovers} 同一套键、同一份来源。**未设置＝开**
   * （老设置里没有这个键时行为完全不变）。
   */
  contactFlags: Record<string, ChatContactFlags>;
  /**
   * 聊天角色库（用户自建）。空库 = 不套角色；草稿按「真人朋友」口径写。
   * 非法条目解析时跳过并记进 `diagnostics`，不整份崩掉。
   */
  roles: ChatRole[];
  /** 当前选用的角色 id；`null` / 不在库中 = 无角色 */
  activeRoleId: string | null;
  /**
   * 发图图库目录（本机路径）。空串 = 用软件自带的 `chat_media`。
   * 填写后只认这个文件夹（不存在或空 → 要图时只回文字备图）。
   */
  mediaLibraryDir: string;
  /**
   * 目标里 `@` 展开后的快照（保存目标时写入）。没有 @ 则为 null。
   * 调度器不解析 @，靠这份快照把规则带给 Sidecar。
   */
  taskRules: unknown[] | null;
  taskPersona: { label: string; fixed: Record<string, string> } | null;
  /**
   * 已配置付款方式（USDT/银行卡等）。对方要地址时只发这里的纯内容，禁止编造。
   * 目标框里若粘了钱包地址，保存时也会自动并入。
   */
  paymentMethods: ChatPaymentMethod[];
}

export type ChatPaymentKind = "usdt_trc20" | "usdt_erc20" | "bank" | "other";

export interface ChatPaymentMethod {
  id: string;
  kind: ChatPaymentKind;
  label: string;
  value: string;
}

/** 一位联系人的两个开关；缺省（未设置）＝开 */
export interface ChatContactFlags {
  /** 对方来消息时引擎回不回 */
  autoReply?: boolean;
  /** 对方沉默时是否主动追问（不冷场）；缺省＝开 */
  followUp?: boolean;
}

/** 聊天角色库里的一条（人设提示词，供值守草稿注入） */
export interface ChatRole {
  id: string;
  name: string;
  prompt: string;
}

/** 角色库上限：防止一份设置塞进海量长文拖垮读写 */
export const CHAT_ROLES_MAX = 40;
export const CHAT_ROLE_NAME_MAX = 60;
export const CHAT_ROLE_PROMPT_MAX = 4_000;

export const DEFAULT_CHAT_MODE_SETTINGS: ChatModeSettings = {
  enabled: false,
  goal: "",
  styleHint: "",
  bannedWords: [],
  // 与 `sidecar/src/core/web_chat/slice_limits.ts` 的默认值逐字一致（对齐断言见 chat-settings-parity.mjs）
  sliceMs: 90_000,
  maxContactsPerSlice: 5,
  maxParallelSlices: 1,
  targetsByEnv: {},
  useCurrentWindow: true,
  cadence: DEFAULT_CHAT_CADENCE,
  takeovers: {},
  contactFlags: {},
  roles: [],
  activeRoleId: null,
  mediaLibraryDir: "",
  taskRules: null,
  taskPersona: null,
  paymentMethods: [],
};

export const CHAT_SLICE_MS_MIN = 15_000;
/**
 * 单片上限 30 分钟。
 * **必须与 Rust 侧 `rpa_session::CHAT_SLICE_MAX_MS` 一致**：宿主按这一片的盒长算等待上限
 * （盒长 + 结算宽限），两边对不上就会出现「设置里能填、跑起来报超时」。
 */
export const CHAT_SLICE_MS_MAX = 1_800_000;
export const CHAT_CONTACTS_PER_SLICE_MAX = 50;
/** 与 Rust `chat_patrol::CHAT_PARALLEL_HARD_MAX` 对齐（改一边必须同步） */
export const CHAT_PARALLEL_MAX = 4;

export interface ChatModeSettingsParseResult {
  settings: ChatModeSettings;
  /** 被修正/丢弃的项（人话描述）——**必须先说后跑**，不许静默改用户配置 */
  diagnostics: string[];
}

function clampNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
  diagnostics: string[],
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    if (raw !== undefined && raw !== null && raw !== "") {
      diagnostics.push(`${label} 不是数字，已用默认值 ${fallback}`);
    }
    return fallback;
  }
  if (value < min || value > max) {
    diagnostics.push(`${label} 超出范围，已收窄到 ${min}–${max}`);
    return Math.min(max, Math.max(min, value));
  }
  return value;
}

function parseClock(raw: unknown): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * 静默时段归一化（与 Sidecar `cadence.ts::normalizeQuietHours` 同一套文法）。
 *
 * - `null` → `null`（显式「不设静默」）
 * - 合法对象 → 归一化后的 `{start, end}`
 * - **非法/缺失 → `undefined`**，由调用方决定回落默认并记诊断（不把 `25:00` 当成有效值）
 */
export function normalizeQuietHours(
  raw: unknown,
): { start: string; end: string } | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const start = parseClock(record.start);
  const end = parseClock(record.end);
  if (!start || !end) return undefined;
  return { start, end };
}

function parseBackoff(raw: unknown, diagnostics: string[]): number[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_CHAT_CADENCE.followUpBackoffHours];
  }
  const values = raw
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  if (values.length === 0) {
    diagnostics.push("递进间隔列表为空或全非法，已用默认 4/7 天");
    return [...DEFAULT_CHAT_CADENCE.followUpBackoffHours];
  }
  return values;
}

function parseTargets(raw: unknown): Record<string, ChatTargetDraft[]> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ChatTargetDraft[]> = {};
  for (const [profileId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const rows: ChatTargetDraft[] = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const label = String(record.label ?? "").trim();
      const url = String(record.url ?? "").trim();
      if (!label && !url) continue;
      rows.push({ label: label || url, url });
    }
    if (rows.length > 0) out[profileId] = rows;
  }
  return out;
}

/**
 * 解析「用户为单个联系人指定的接管模式」。
 *
 * 非法值**丢弃并记进 `diagnostics`**，绝不静默当成 `engine` ——
 * 「用户以为已接管、其实引擎还在发」是最不能容忍的错配（§0.5.3 B）。
 */function parseTakeovers(raw: unknown, diagnostics: string[]): Record<string, ChatTakeoverMode> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ChatTakeoverMode> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const contactKey = String(key ?? "").trim();
    if (!contactKey) continue;
    const mode = String(value ?? "").trim() as ChatTakeoverMode;
    if (!CHAT_TAKEOVER_MODES.includes(mode)) {
      diagnostics.push(`联系人「${contactKey}」的接管模式无法识别，已忽略`);
      continue;
    }
    out[contactKey] = mode;
  }
  return out;
}

/**
 * 解析每联系人开关（`contactFlags`）。
 *
 * 只收对象 + 布尔；一条都没有真正布尔值时**整条丢弃**（等于没设置）。
 * 坏值记进 `diagnostics`：这两个开关直接决定「引擎会不会开口」，
 * 静默当成「关」或「开」都可能让用户看到与实际相反的状态（§0.5.3 B）。
 */
function parseContactFlags(
  raw: unknown,
  diagnostics: string[],
): Record<string, ChatContactFlags> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ChatContactFlags> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const contactKey = String(key ?? "").trim();
    if (!contactKey) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      diagnostics.push(`联系人「${contactKey}」的开关无法识别，已忽略`);
      continue;
    }
    const record = value as Record<string, unknown>;
    const flags: ChatContactFlags = {};
    for (const field of ["autoReply", "followUp"] as const) {
      const entry = record[field];
      if (entry === undefined || entry === null) continue;
      if (typeof entry !== "boolean") {
        diagnostics.push(`联系人「${contactKey}」的「${field}」不是布尔值，已忽略`);
        continue;
      }
      flags[field] = entry;
    }
    if (Object.keys(flags).length > 0) out[contactKey] = flags;
  }
  return out;
}

/**
 * 解析角色库。坏条目**跳过并记诊断**，不整份崩掉；超上限截断并说明。
 * id / name 必填；prompt 允许空串（用户可后补）。
 */
function parsePaymentMethods(raw: unknown, diagnostics: string[]): ChatPaymentMethod[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push("付款方式不是列表，已忽略");
    return [];
  }
  const out: ChatPaymentMethod[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (typeof entry !== "object" || entry === null) {
      diagnostics.push(`付款方式第 ${index + 1} 条无法识别，已跳过`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const value = String(record.value ?? "").trim();
    if (!value || value.length > 200) {
      diagnostics.push(`付款方式第 ${index + 1} 条内容无效，已跳过`);
      continue;
    }
    const id = String(record.id ?? "").trim() || `pay_${index + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kindRaw = String(record.kind ?? "other").trim().toLowerCase();
    const kind: ChatPaymentKind =
      kindRaw === "usdt_trc20" ||
      kindRaw === "usdt_erc20" ||
      kindRaw === "bank" ||
      kindRaw === "other"
        ? kindRaw
        : "other";
    out.push({
      id,
      kind,
      label: String(record.label ?? "").trim().slice(0, 60) || kind,
      value,
    });
    if (out.length >= 20) break;
  }
  return out;
}

function extractPaymentMethodsFromGoal(goal: string): ChatPaymentMethod[] {
  const found: ChatPaymentMethod[] = [];
  const tron = String(goal ?? "").match(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/);
  if (tron) {
    found.push({
      id: "goal_usdt_trc20",
      kind: "usdt_trc20",
      label: "USDT-TRC20",
      value: tron[0],
    });
  }
  const eth = String(goal ?? "").match(/\b0x[a-fA-F0-9]{40}\b/);
  if (eth) {
    found.push({
      id: "goal_usdt_erc20",
      kind: "usdt_erc20",
      label: "USDT-ERC20",
      value: eth[0],
    });
  }
  return found;
}

function mergePaymentMethods(
  configured: ChatPaymentMethod[],
  fromGoal: ChatPaymentMethod[],
): ChatPaymentMethod[] {
  const byValue = new Map<string, ChatPaymentMethod>();
  for (const method of [...configured, ...fromGoal]) {
    const key = method.value.replace(/\s+/g, "").toLowerCase();
    if (!key || byValue.has(key)) continue;
    byValue.set(key, method);
  }
  return [...byValue.values()];
}

function parseRoles(raw: unknown, diagnostics: string[]): ChatRole[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push("角色库不是列表，已忽略");
    return [];
  }
  const out: ChatRole[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      diagnostics.push(`角色库第 ${index + 1} 条不是对象，已跳过`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    const name = String(record.name ?? "").trim().slice(0, CHAT_ROLE_NAME_MAX);
    const promptRaw = record.prompt;
    if (!id || !name) {
      diagnostics.push(`角色库第 ${index + 1} 条缺少 id 或名称，已跳过`);
      continue;
    }
    if (seen.has(id)) {
      diagnostics.push(`角色「${name}」的 id 重复，已跳过副本`);
      continue;
    }
    if (typeof promptRaw !== "string" && promptRaw !== undefined && promptRaw !== null) {
      diagnostics.push(`角色「${name}」的提示词不是文本，已跳过`);
      continue;
    }
    let prompt = typeof promptRaw === "string" ? promptRaw : "";
    if (prompt.length > CHAT_ROLE_PROMPT_MAX) {
      diagnostics.push(`角色「${name}」的提示词过长，已截到 ${CHAT_ROLE_PROMPT_MAX} 字`);
      prompt = prompt.slice(0, CHAT_ROLE_PROMPT_MAX);
    }
    seen.add(id);
    out.push({ id, name, prompt });
    if (out.length >= CHAT_ROLES_MAX) {
      if (raw.length > CHAT_ROLES_MAX) {
        diagnostics.push(`角色库超过 ${CHAT_ROLES_MAX} 条，多余的已忽略`);
      }
      break;
    }
  }
  return out;
}

/** 当前角色：空 / 不在库中 → `null`（无角色），并记诊断 */
function parseActiveRoleId(
  raw: unknown,
  roles: readonly ChatRole[],
  diagnostics: string[],
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" && typeof raw !== "number") {
    diagnostics.push("当前角色 id 无法识别，已清空");
    return null;
  }
  const id = String(raw).trim();
  if (!id) return null;
  if (!roles.some((role) => role.id === id)) {
    diagnostics.push(`当前角色「${id}」不在角色库中，已清空`);
    return null;
  }
  return id;
}

/** 新建一条角色（id 本地生成，不依赖服务器） */
export function createChatRole(partial?: Partial<Pick<ChatRole, "name" | "prompt">>): ChatRole {
  const stamp =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `role_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: stamp,
    name: String(partial?.name ?? "").trim() || "新角色",
    prompt: typeof partial?.prompt === "string" ? partial.prompt : "",
  };
}

/**
 * 解析持久化设置。**永不抛异常**（读坏了一份配置不该让设置面板打不开），
 * 但也**不复述假话**：任何修正都写进 `diagnostics`。
 */
export function parseChatModeSettings(raw: unknown): ChatModeSettingsParseResult {
  const diagnostics: string[] = [];
  let source: Record<string, unknown> = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        source = parsed as Record<string, unknown>;
      } else {
        diagnostics.push("聊天设置不是对象，已用默认值");
      }
    } catch {
      diagnostics.push("聊天设置解析失败（JSON 损坏），已用默认值");
    }
  }

  const cadenceRaw =
    typeof source.cadence === "object" && source.cadence !== null
      ? (source.cadence as Record<string, unknown>)
      : {};

  const quietSource = cadenceRaw.quietHours;
  const normalizedQuiet = normalizeQuietHours(quietSource);
  let quietHours: { start: string; end: string } | null = null;
  if (quietSource === undefined) {
    // 缺键 = 用默认（连续聊天默认不设静默时段）
    quietHours = DEFAULT_CHAT_MODE_SETTINGS.cadence.quietHours;
  } else if (quietSource === null) {
    quietHours = null;
  } else if (normalizedQuiet === undefined) {
    diagnostics.push("静默时段格式非法（需 HH:MM 或 null），已关闭静默时段");
    quietHours = null;
  } else {
    quietHours = normalizedQuiet;
  }

  const bannedRaw = Array.isArray(source.bannedWords) ? source.bannedWords : [];
  const bannedWords = bannedRaw
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 60);

  const roles = parseRoles(source.roles, diagnostics);
  const activeRoleId = parseActiveRoleId(source.activeRoleId, roles, diagnostics);
  const goalText = typeof source.goal === "string" ? source.goal : "";
  const paymentMethods = mergePaymentMethods(
    parsePaymentMethods(source.paymentMethods, diagnostics),
    extractPaymentMethodsFromGoal(goalText),
  );

  let mediaLibraryDir = "";
  if (source.mediaLibraryDir !== undefined && source.mediaLibraryDir !== null) {
    if (typeof source.mediaLibraryDir !== "string" && typeof source.mediaLibraryDir !== "number") {
      diagnostics.push("图库目录不是文本路径，已忽略（继续用软件自带图库）");
    } else {
      mediaLibraryDir = String(source.mediaLibraryDir).trim();
      if (mediaLibraryDir.includes("\0")) {
        diagnostics.push("图库目录含非法字符，已忽略");
        mediaLibraryDir = "";
      } else if (mediaLibraryDir.length > 1_024) {
        diagnostics.push("图库目录路径过长，已截断");
        mediaLibraryDir = mediaLibraryDir.slice(0, 1_024);
      }
    }
  }

  const settings: ChatModeSettings = {
    enabled: source.enabled === true || source.enabled === "true" || source.enabled === 1,
    goal: goalText,
    styleHint: typeof source.styleHint === "string" ? source.styleHint : "",
    bannedWords,
    paymentMethods,
    sliceMs: clampNumber(
      source.sliceMs,
      DEFAULT_CHAT_MODE_SETTINGS.sliceMs,
      CHAT_SLICE_MS_MIN,
      CHAT_SLICE_MS_MAX,
      "单次值守时长",
      diagnostics,
    ),
    maxContactsPerSlice: clampNumber(
      source.maxContactsPerSlice,
      DEFAULT_CHAT_MODE_SETTINGS.maxContactsPerSlice,
      1,
      CHAT_CONTACTS_PER_SLICE_MAX,
      "单次值守联系人数",
      diagnostics,
    ),
    maxParallelSlices: clampNumber(
      source.maxParallelSlices,
      DEFAULT_CHAT_MODE_SETTINGS.maxParallelSlices,
      1,
      CHAT_PARALLEL_MAX,
      "同时值守环境数",
      diagnostics,
    ),
    targetsByEnv: parseTargets(source.targetsByEnv),
    // 默认开；只有用户显式关掉（`false`）才算关（与「没指定就用当前窗口」的默认口径一致）
    useCurrentWindow: source.useCurrentWindow !== false,
    takeovers: parseTakeovers(source.takeovers, diagnostics),
    contactFlags: parseContactFlags(source.contactFlags, diagnostics),
    roles,
    activeRoleId,
    mediaLibraryDir,
    taskRules: Array.isArray(source.taskRules) && source.taskRules.length > 0 ? source.taskRules : null,
    taskPersona:
      source.taskPersona && typeof source.taskPersona === "object" && !Array.isArray(source.taskPersona)
        ? (() => {
            const label = String((source.taskPersona as { label?: unknown }).label ?? "").trim();
            if (!label) return null;
            const fixedRaw = (source.taskPersona as { fixed?: unknown }).fixed;
            const fixed: Record<string, string> = {};
            if (fixedRaw && typeof fixedRaw === "object" && !Array.isArray(fixedRaw)) {
              for (const [key, value] of Object.entries(fixedRaw as Record<string, unknown>)) {
                const text = String(value ?? "").trim();
                if (text) fixed[key] = text;
              }
            }
            return { label, fixed };
          })()
        : null,
    cadence: {
      followUpEnabled: cadenceRaw.followUpEnabled === true,
      followUpHours: clampNumber(
        cadenceRaw.followUpHours,
        DEFAULT_CHAT_CADENCE.followUpHours,
        CADENCE_LIMITS.followUpHours[0],
        CADENCE_LIMITS.followUpHours[1],
        "首次回访间隔（小时）",
        diagnostics,
      ),
      followUpBackoffHours: parseBackoff(cadenceRaw.followUpBackoffHours, diagnostics),
      // 0 是实义值（不追发）
      maxFollowUps: clampNumber(
        cadenceRaw.maxFollowUps,
        DEFAULT_CHAT_CADENCE.maxFollowUps,
        CADENCE_LIMITS.maxFollowUps[0],
        CADENCE_LIMITS.maxFollowUps[1],
        "单轮回访上限",
        diagnostics,
      ),
      // 0 是实义值（不冷却）
      followUpCoolDownDays: clampNumber(
        cadenceRaw.followUpCoolDownDays,
        DEFAULT_CHAT_CADENCE.followUpCoolDownDays,
        CADENCE_LIMITS.followUpCoolDownDays[0],
        CADENCE_LIMITS.followUpCoolDownDays[1],
        "冷却天数",
        diagnostics,
      ),
      followUpRevivalDays: clampNumber(
        cadenceRaw.followUpRevivalDays,
        DEFAULT_CHAT_CADENCE.followUpRevivalDays,
        CADENCE_LIMITS.followUpRevivalDays[0],
        CADENCE_LIMITS.followUpRevivalDays[1],
        "重启门槛（天）",
        diagnostics,
      ),
      quietHours,
      // 0 = 不限（以前下限是 1，导致这个语义**根本填不出来**）
      maxPerDay: clampNumber(
        cadenceRaw.maxPerDay,
        DEFAULT_CHAT_CADENCE.maxPerDay,
        CADENCE_LIMITS.maxPerDay[0],
        CADENCE_LIMITS.maxPerDay[1],
        "每日发送上限",
        diagnostics,
      ),
      jitterRatio: clampNumber(
        cadenceRaw.jitterRatio,
        DEFAULT_CHAT_CADENCE.jitterRatio,
        CADENCE_LIMITS.jitterRatio[0],
        CADENCE_LIMITS.jitterRatio[1],
        "抖动比例",
        diagnostics,
      ),
    },
  };

  return { settings, diagnostics };
}

export function serializeChatModeSettings(settings: ChatModeSettings): string {
  return JSON.stringify(settings);
}

/** 把「昵称 | 会话URL」多行文本解析成目标列表（空行与注释行跳过） */
export function parseChatTargetsText(text: string): ChatTargetDraft[] {
  const out: ChatTargetDraft[] = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("|");
    if (separator < 0) {
      out.push({ label: line, url: "" });
      continue;
    }
    const label = line.slice(0, separator).trim();
    const url = line.slice(separator + 1).trim();
    if (!label && !url) continue;
    out.push({ label: label || url, url });
  }
  return out;
}

export function formatChatTargetsText(targets: readonly ChatTargetDraft[]): string {
  return targets
    .map((target) => (target.url ? `${target.label} | ${target.url}` : target.label))
    .join("\n");
}

/** 把目标列表转成 Host 需要的 `ChatContactInput`（不做任何猜测） */
export function toChatContactInputs(targets: readonly ChatTargetDraft[]): ChatContactInput[] {
  return targets.map((target) => ({
    label: target.label.trim(),
    url: target.url.trim() || null,
  }));
}
