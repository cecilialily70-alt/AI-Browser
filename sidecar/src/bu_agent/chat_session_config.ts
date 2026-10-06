/**
 * 聊天模式会话的**配置面**（一次任务的输入 + 纯解析/键派生）。
 *
 * 为什么单独一个模块：这些函数是**纯的**（输入 payload → 规范化后的配置），
 * 与浏览器、模型、磁盘都无关，所以可以无浏览器单测（见 `tests/chat-prompt.mjs` /
 * `chat-pacing.mjs` / `chat-settings-parity.mjs`）。装配函数只负责把它们接起来。
 *
 * 口径纪律：区间与默认值必须与前端设置逐字一致（`CADENCE_LIMITS` /
 * `src/lib/chatModeSettings.ts`），由 `tests/chat-settings-parity.mjs` 做源码级对齐断言。
 */
import { join } from "node:path";

import {
  CADENCE_LIMITS,
  DEFAULT_CADENCE,
  clampCadenceValue,
  normalizeQuietHours,
  type CadenceConfig,
} from "../core/web_chat/cadence.js";
import { chatContextRoot, sanitizeSegment } from "../core/web_chat/context_store.js";
import { siteKeyOf } from "../core/web_chat/site_detect.js";
import { CHAT_TAKEOVER_MODES, type ChatTakeoverMode } from "../core/web_chat/state.js";
import type { PacingConfig } from "../core/web_chat/pacing.js";

/** 一次聊天任务的输入（来自 Host `chat_start`） */
export interface ChatSessionConfig {
  envId: string;
  profileId: number | null;
  /** 会话目标（用户写的；例如「约线下看展」） */
  goal: string;
  /** 风格/边界（用户规则） */
  styleHint: string | null;
  /** 禁用词表（用户规则） */
  bannedWords: readonly string[];
  /** 值守片时长 */
  sliceMs: number;
  /** 单轮最多处理几个联系人 */
  maxContactsPerSlice: number;
  cadence: CadenceConfig;
  /**
   * 发送节奏护栏（同线程最小间隔 + 阅读延迟 + 抖动）。缺省＝`DEFAULT_PACING`。
   * **只为防封号，不做任何每日上限**（唯一的每日口径是 `cadence.maxPerDay`，`0`＝不限）。
   */
  pacing?: PacingConfig;
  /**
   * 快照文件（耐久续跑）。
   * `null` = 这一片没有 userDataDir（无记忆模式）：**不读也不写**快照，
   * 但必须如实记日志（见 `readSnapshot` / 落盘处），不许偷偷写到相对路径。
   */
  snapshotFile: string | null;
  /**
   * 「没指定对象就用**当前打开的**聊天窗口」（用户显式意图）。
   *
   * 这时引擎**不新开标签**，而是绑到用户此刻开着的那张聊天标签上：只读、只往输入框里打字，
   * 不导航、不关标签（用户的窗口原样保留）。目标为空但没有这个标志时仍然拒绝启动（不猜对象）。
   */
  useCurrentWindow: boolean;
  /**
   * 该环境的 userDataDir（`browser-profiles/profile-{id}`）。
   * **每联系人上下文就落在这里**（`chat_context/{site}/{contact}/`），
   * 环境被删除时随 profile 目录一起清掉，不会串号到复用的新环境。
   */
  userDataDir: string | null;
  /**
   * 人工优先的一等控制（§5）：用户在设置里为**单个联系人**选的模式
   * （`{ "<contactKey>": "engine" | "human" | "paused" }`）。
   *
   * 为什么走设置而不是让 Host 去改 Sidecar 的快照文件：快照的**唯一写入方**是 Sidecar
   * （`context_store` / `state.ts`），Host 去写会与正在跑的引擎抢同一个文件。
   * 用户意图存设置（只在片启动时读一次），自动检测的接管存快照，两者取「用户优先」。
   */
  takeovers?: Record<string, ChatTakeoverMode>;
  /**
   * 每联系人开关（§5.7）：`{ "<站点>|<联系人>": { autoReply?: boolean; followUp?: boolean } }`。
   *
   * 与 `takeovers` 同一套键与同一份来源（设置「聊天」Tab）。**未设置＝开**：
   * 老设置里没有这个键时行为完全不变（不是「默认关闭」）。
   */
  contactFlags?: Record<string, ChatContactFlags>;
  /**
   * 聊天角色库（用户自建）。空库 / 未选 = 不套角色。
   * 坏条目由 {@link parseRoles} 跳过；权威解析只在本模块。
   */
  roles?: readonly ChatRole[];
  /** 当前选用的角色 id；`null` / 不在库中 = 无角色 */
  activeRoleId?: string | null;
  /**
   * 用户自定义图库目录（本机绝对路径）。空 / 未设 = 用内置 `sidecar/chat_media`。
   * 写了却不存在 → 空库（不静默回落内置）。
   */
  mediaLibraryDir?: string | null;
  /**
   * 目标里 `@规则 / @人设` 展开后的载荷（前端解析；Host 原样转发）。
   * 没有 @ 时不要传，以免空数组被当成「有规则」。
   */
  taskRules?: unknown;
  taskPersona?: unknown;
}

/** 聊天角色库里的一条 */
export interface ChatRole {
  id: string;
  name: string;
  prompt: string;
}

/** 与前端 `CHAT_ROLES_MAX` / 名称·提示词上限逐字一致 */
export const CHAT_ROLES_MAX = 40;
export const CHAT_ROLE_NAME_MAX = 60;
export const CHAT_ROLE_PROMPT_MAX = 4_000;

/** 一位联系人的两个开关；缺省（未设置）＝开 */
export interface ChatContactFlags {
  /** 对方来消息时引擎回不回 */
  autoReply?: boolean;
  /** 兼容读：曾表示「到点要不要主动找话」；引擎开场不读，主动追发已下线 */
  followUp?: boolean;
}

export interface ChatContactSeed {
  key: string;
  label: string;
  siteKey: string;
  url: string | null;
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** 从 payload 里解析联系人列表（Host 指定的目标；不猜） */
export function parseContactSeeds(raw: unknown): ChatContactSeed[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatContactSeed[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const label = String(record.label ?? record.name ?? "").trim();
    const key = String(record.key ?? "").trim();
    const siteKey = String(record.siteKey ?? record.site_key ?? "unknown").trim() || "unknown";
    const url = String(record.url ?? record.chatUrl ?? record.chat_url ?? "").trim() || null;
    if (!label && !key) continue;
    out.push({ key: key || `${siteKey}|${label}`, label: label || key, siteKey, url });
  }
  return out;
}

/**
 * 联系人身份的**唯一派生**：`{label, url}`（可选 key/siteKey）→ 引擎运行期真正会用的
 * `{siteKey, key}`。
 *
 * 为什么必须抽成纯函数（§0.5.3 H「同一事实两个来源」）：视图在「读取当前页面会话列表」里
 * 勾人时会顺手把「自动聊天」写进设置表（`contactFlags`），而设置表的键必须与
 * **引擎运行期算出来的键逐字节相同**，否则表现就是「在列表里关了自动回复，引擎照样开口」。
 * 前端没有 `siteKeyOf` / `sanitizeSegment`（也不该有第二份实现），所以键由侧车算好随列表回传；
 * 引擎与列表探针**共用本函数**，两边不可能分叉。
 *
 * `hasLegacyDir`：站点键从「一律 `unknown`」改成「从 URL 派生」之后，老用户的
 * `unknown/<联系人>/` 还在。直接换目录 = 同一个人被当新对象重新开场（R7 刷屏事故），
 * 所以由调用方注入一次「旧目录在不在」的判定，在就沿用旧键（读旧写旧），并如实留痕。
 *
 * 纯函数：不读磁盘、不写日志（旧目录判定由调用方注入），同输入必得同输出。
 */
export function seedIdentityOf(
  seed: ChatContactSeed,
  legacyKey: string = seed.key,
  hasLegacyDir?: (siteKey: string, contactKey: string) => boolean,
): { seed: ChatContactSeed; derivedSiteKey: string; legacyUsed: boolean } {
  const current = String(seed.siteKey ?? "").trim() || "unknown";
  const derivedSiteKey = siteKeyOf(seed.url ?? "", current === "unknown" ? null : current);
  if (derivedSiteKey === current) return { seed, derivedSiteKey, legacyUsed: false };
  if (hasLegacyDir?.("unknown", legacyKey)) {
    return {
      seed: { ...seed, key: legacyKey, siteKey: "unknown" },
      derivedSiteKey,
      legacyUsed: true,
    };
  }
  // Host 给的键是 `<旧站点键>|<原样部分>`：只换前缀，别的字节一个不动
  const key = legacyKey.startsWith(`${current}|`)
    ? `${derivedSiteKey}${legacyKey.slice(current.length)}`
    : legacyKey;
  return { seed: { ...seed, key, siteKey: derivedSiteKey }, derivedSiteKey, legacyUsed: false };
}

/**
 * 「绑用户当前窗口、只读不导航」这条纪律**只对「没指定对象」成立**（§1.6 / R7）。
 *
 * 依据就是设置项自己的原话：「**未指定对象时**使用当前打开的窗口」。用户一旦写下要聊的人，
 * 目标本身就是目的地，必须能打开过去 —— 否则页面停在会话列表（Telegram 首屏就是列表、
 * 没点开会话）时，引擎既打不开任何会话（`container_missing`）又不会自己开标签，
 * 整片只会「一秒结束」（现场日志：`chat_site_without_conversation` → `no_targets`）。
 *
 * 有显式目标时改走**聊天专用标签**（复用上次留下的那一个，绝不劫持用户正在看的标签）。
 */
export function useCurrentWindowMode(useCurrentWindow: boolean, targetCount: number): boolean {
  return useCurrentWindow && targetCount <= 0;
}

/**
 * 接管键的**唯一产生口径**（`<站点目录段>|<联系人目录段>`）。
 *
 * 键以前有三个键空间各拼一套（视图写 `<site>|<联系人>`、引擎写会话键、`chat_threads`
 * 存目录名）→ 点了「引擎值守」毫无反应、卡片与日志口径相反（§0.5.3 H）。
 * 现在拼键只此一处；前端 `src/lib/chatModeSettings.ts::takeoverKeyOf` 与之逐字一致
 * （由 `tests/chat-settings-parity.mjs` 锁住）。
 */
export function takeoverKeyOf(seed: { key: string; siteKey: string }): string {
  return `${seed.siteKey}|${sanitizeSegment(seed.key)}`;
}

/**
 * 人工优先覆盖（`chat_mode.takeovers`）的查表。
 *
 * 只认两种写法，都过**同一套清洗**（`sanitizeSegment`）：
 *   - {@link takeoverKeyOf}：规范写法，视图写的就是它（无歧义，不会跨站点撞名）
 *   - `seed.key`：引擎的会话键（`unknown|Anne`），**唯一的迁移读**（老设置里可能存过这一种）
 *
 * 猜出来的写法（`<site>|<昵称>`、只写目录名）一律不再认：昵称会改、会重名，
 * 拿它当身份可能把接管错记到**另一个人**头上；目录名跨站点还会撞名。
 */
export function takeoverOverrideOf(
  takeovers: Record<string, unknown> | undefined | null,
  seed: { key: string; siteKey: string },
): ChatTakeoverMode | undefined {
  if (!takeovers) return undefined;
  for (const spelling of [takeoverKeyOf(seed), seed.key]) {
    const value = takeovers[spelling];
    if (value === "engine" || value === "human" || value === "paused") return value;
  }
  return undefined;
}

/**
 * 解析每联系人开关（`chat_mode.contactFlags`）。
 *
 * 只收「对象 + 布尔字段」，且**至少要有一个真正的布尔**才收这一条
 * （全空的项等于没设置，留着只会让 `null` 与 `undefined` 两种「没设置」打架）。
 * 坏值一律进 `diagnostics`，不静默当成「关」—— 「用户以为关了其实还在发」与
 * 「用户以为开着其实不发」都是最难排查的那种错（§0.5.3 B）。
 */
export function parseContactFlags(
  raw: unknown,
  diagnostics?: string[],
): Record<string, ChatContactFlags> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ChatContactFlags> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const contactKey = String(key ?? "").trim();
    if (!contactKey) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      diagnostics?.push(`contact_flags_invalid:${contactKey}`);
      continue;
    }
    const record = value as Record<string, unknown>;
    const flags: ChatContactFlags = {};
    for (const field of ["autoReply", "followUp"] as const) {
      const entry = record[field];
      if (entry === undefined || entry === null) continue;
      if (typeof entry !== "boolean") {
        diagnostics?.push(`contact_flags_invalid:${contactKey}:${field}`);
        continue;
      }
      flags[field] = entry;
    }
    if (Object.keys(flags).length > 0) out[contactKey] = flags;
  }
  return out;
}

/**
 * 每联系人开关的查表。与 {@link takeoverOverrideOf} 同一套键（规范写法 + 一个迁移读），
 * 因此**不存在第三种拼法**（§0.5.3 H「同一事实两个来源」）。
 */
export function contactFlagsOf(
  flags: Record<string, ChatContactFlags> | undefined | null,
  seed: { key: string; siteKey: string },
): ChatContactFlags | undefined {
  if (!flags) return undefined;
  for (const spelling of [takeoverKeyOf(seed), seed.key]) {
    const value = flags[spelling];
    if (value) return value;
  }
  return undefined;
}

/**
 * 解析角色库。坏条目**跳过并记诊断**，不整份崩掉；与前端 `parseRoles` 同一口径。
 */
export function parseRoles(raw: unknown, diagnostics?: string[]): ChatRole[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    diagnostics?.push("roles_not_array");
    return [];
  }
  const out: ChatRole[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      diagnostics?.push(`role_invalid:${index}`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    const name = String(record.name ?? "").trim().slice(0, CHAT_ROLE_NAME_MAX);
    const promptRaw = record.prompt;
    if (!id || !name) {
      diagnostics?.push(`role_incomplete:${index}`);
      continue;
    }
    if (seen.has(id)) {
      diagnostics?.push(`role_duplicate:${id}`);
      continue;
    }
    if (typeof promptRaw !== "string" && promptRaw !== undefined && promptRaw !== null) {
      diagnostics?.push(`role_prompt_invalid:${id}`);
      continue;
    }
    let prompt = typeof promptRaw === "string" ? promptRaw : "";
    if (prompt.length > CHAT_ROLE_PROMPT_MAX) {
      diagnostics?.push(`role_prompt_truncated:${id}`);
      prompt = prompt.slice(0, CHAT_ROLE_PROMPT_MAX);
    }
    seen.add(id);
    out.push({ id, name, prompt });
    if (out.length >= CHAT_ROLES_MAX) {
      if (raw.length > CHAT_ROLES_MAX) diagnostics?.push("roles_cap");
      break;
    }
  }
  return out;
}

/** 当前角色 id：空 / 不在库 → `null` */
export function parseActiveRoleId(
  raw: unknown,
  roles: readonly ChatRole[],
  diagnostics?: string[],
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" && typeof raw !== "number") {
    diagnostics?.push("active_role_invalid");
    return null;
  }
  const id = String(raw).trim();
  if (!id) return null;
  if (!roles.some((role) => role.id === id)) {
    diagnostics?.push(`active_role_missing:${id}`);
    return null;
  }
  return id;
}

/** 从配置取出当前角色；没有或对不上 → `null` */
export function activeRoleOf(config: {
  roles?: readonly ChatRole[] | null;
  activeRoleId?: string | null;
}): ChatRole | null {
  const id = config.activeRoleId;
  if (!id || !config.roles?.length) return null;
  return config.roles.find((role) => role.id === id) ?? null;
}

/**
 * 从 payload 解析回访节奏。
 *
 * 来源是设置「聊天」Tab（`global_settings.chat_mode`），不是规则窗口；
 * 缺省用 {@link DEFAULT_CADENCE}，区间与前端**逐字一致**（{@link CADENCE_LIMITS}，
 * 由 `tests/chat-settings-parity.mjs` 锁住），不再出现「设置里夹到 1440、引擎按 20000 跑」。
 *
 * 注意：`maxFollowUps` / `followUpCoolDownDays` / `maxPerDay` 的**0 是实义值**
 * （「不追发」「不冷却」「不限」），这里不得当成缺失回落默认（§0.5.3 B）。
 */
export function parseCadence(raw: unknown): CadenceConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_CADENCE;
  const r = raw as Record<string, unknown>;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof r[key] === "boolean" ? (r[key] as boolean) : fallback;
  const backoff = Array.isArray(r.followUpBackoffHours)
    ? r.followUpBackoffHours.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
    : DEFAULT_CADENCE.followUpBackoffHours;
  // 非法静默时段 → 回落默认（不把 "25:00" 这种值原样喂给引擎）；显式 null 才是「不设静默」
  const quiet = normalizeQuietHours(r.quietHours);
  return {
    followUpEnabled: bool("followUpEnabled", DEFAULT_CADENCE.followUpEnabled),
    followUpHours: clampCadenceValue(
      r.followUpHours,
      DEFAULT_CADENCE.followUpHours,
      CADENCE_LIMITS.followUpHours,
    ),
    followUpBackoffHours: backoff.length > 0 ? backoff : DEFAULT_CADENCE.followUpBackoffHours,
    maxFollowUps: clampCadenceValue(
      r.maxFollowUps,
      DEFAULT_CADENCE.maxFollowUps,
      CADENCE_LIMITS.maxFollowUps,
    ),
    followUpCoolDownDays: clampCadenceValue(
      r.followUpCoolDownDays,
      DEFAULT_CADENCE.followUpCoolDownDays,
      CADENCE_LIMITS.followUpCoolDownDays,
    ),
    followUpRevivalDays: clampCadenceValue(
      r.followUpRevivalDays,
      DEFAULT_CADENCE.followUpRevivalDays,
      CADENCE_LIMITS.followUpRevivalDays,
    ),
    quietHours: quiet === undefined ? DEFAULT_CADENCE.quietHours : quiet,
    maxPerDay: clampCadenceValue(r.maxPerDay, DEFAULT_CADENCE.maxPerDay, CADENCE_LIMITS.maxPerDay),
    jitterRatio: clampCadenceValue(
      r.jitterRatio,
      DEFAULT_CADENCE.jitterRatio,
      CADENCE_LIMITS.jitterRatio,
    ),
  };
}

/**
 * 解析「用户为单个联系人指定的接管模式」。
 *
 * 来源是设置「聊天」Tab 的 `chat_mode.takeovers`（允许按联系人覆盖）。
 * 非法值一律**丢弃并回报**（进 `diagnostics`），不静默当成 `engine` ——
 * 静默降级会让「用户以为已接管，其实引擎还在发」这种最危险的错配发生（§0.5.3 B）。
 */
export function parseTakeovers(
  raw: unknown,
  diagnostics?: string[],
): Record<string, ChatTakeoverMode> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ChatTakeoverMode> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const contactKey = String(key ?? "").trim();
    if (!contactKey) continue;
    const mode = String(value ?? "").trim() as ChatTakeoverMode;
    if (!CHAT_TAKEOVER_MODES.includes(mode)) {
      diagnostics?.push(`takeover_invalid:${contactKey}:${String(value)}`);
      continue;
    }
    out[contactKey] = mode;
  }
  return out;
}

/**
 * 快照文件路径：`<userDataDir>/chat_context/state.json`。
 *
 * 与 {@link chatContextRoot} 同一根目录（不再多套一层 `env-{id}`——userDataDir
 * 本身已经是 `profile-{id}`，再套一层只是把同一个 id 写两遍，徒增困惑）。
 */
export function chatSnapshotPath(userDataDir: string | null, _envId: string): string | null {
  const root = String(userDataDir ?? "").trim();
  // 没有 userDataDir 时**不编一个相对路径**：`"chat_context.state.json"` 相对的是 Sidecar 的
  // 启动目录，既不是任何真实位置，也会被下一个「也无 userDataDir」的环境共用 → 读到的
  // 是别人的状态。宁可返回 null，让调用方走「无记忆模式」并把这件事写进日志。
  if (!root) return null;
  return join(chatContextRoot(root), "state.json");
}
