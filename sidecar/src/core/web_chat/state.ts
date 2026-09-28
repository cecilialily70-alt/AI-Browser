/**
 * 耐久快照（§4.2）—— 聊天模式的「检查点 + 调度状态」
 *
 * 三条硬纪律：
 *   1. **原子写**：先写 `state.json.tmp` 再 `rename` —— 看门狗若读到半截 JSON 会误判成卡死。
 *   2. **版本化**：`schemaVersion` 不兼容时**拒绝续跑**并给出恢复提示，绝不带病运行。
 *   3. **`nextWakeAt` 就是调度状态**：Host 调度器据此排班，也尊重静默时段。
 *
 * 快照刻意**只留索引级信息**（阶段/到期/计数/发件箱），摘要与流水放在联系人目录里 ——
 * 这样「工作流跑几个月也不会越来越重」（durable-phases）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { trimOutbox, type ChatOutboxEntry } from "./outbox.js";
import { assertTransition, CHAT_PHASES, type ChatPhase } from "./phases.js";

export const CHAT_STATE_SCHEMA_VERSION = 1;

/** 每线程业务阶段（与引擎相位正交） */
export type ChatStage =
  | "cold"
  | "engaged"
  | "interested"
  | "negotiating"
  | "converted"
  | "rejected"
  | "opted_out"
  | "risk";

export const CHAT_STAGES: readonly ChatStage[] = [
  "cold",
  "engaged",
  "interested",
  "negotiating",
  "converted",
  "rejected",
  "opted_out",
  "risk",
];

/** 一旦进入这些阶段，不再优先排队（仅 risk；拒绝/退订不再停手 —— R7 已改） */
export const CHAT_STOPPING_STAGES: readonly ChatStage[] = ["risk"];

export function isStoppingStage(stage: ChatStage): boolean {
  return CHAT_STOPPING_STAGES.includes(stage);
}

/** @deprecated 接管产品面已删除；保留类型仅兼容旧快照字段 */
export type ChatTakeoverMode = "engine" | "human" | "paused";

export const CHAT_TAKEOVER_MODES: readonly ChatTakeoverMode[] = ["engine", "human", "paused"];

/** 用户在设置里为该联系人选择了「接管 / 暂停」时写入 `takeoverReason` 的共享常量 */
export const USER_TAKEOVER_REASON = "用户在设置里为该联系人选择了「接管 / 暂停」";

/** 缺省＝开（老快照 / 未设置都表示「回」，只有用户显式关掉才不回） */
export function autoReplyOf(contact: { autoReply?: boolean | null }): boolean {
  return contact.autoReply !== false;
}

export interface ChatContactState {
  key: string;
  label: string;
  siteKey: string;
  stage: ChatStage;
  followUpIndex: number;
  /** 下次回访到期时间（§10：必须持久化，否则重启即回访风暴） */
  nextDueAt: string | null;
  /**
   * 下次**短复查**时间（看有没有新消息，不发就不发）。
   *
   * 与 `nextDueAt` 分开是刻意的：回访（对方不理我，48h 起）与「我方刚发完、看对方回不回」
   * 是两种语义。用一个字段兼任会导致二选一的坏结果 —— 要么发完就结束（用户看到的真坑），
   * 要么十分钟没回就催一遍（骚扰）。由 `cadence.liveReplyRecheckAt` 从耐久事实推导。
   */
  nextCheckAt?: string | null;
  lastIncomingHash: string | null;
  lastSentHash: string | null;
  stopped: boolean;
  stopReason: string | null;
  /** fencing：防迟到完成覆盖新结果 */
  lease: number;
  updatedAt: string;
  /**
   * 人工优先的一等控制（§5）：用户可对**单个联系人**接管 / 暂停 / 交还。
   *
   * 为什么是一等状态而不是「一个开关」：用户手动接过话之后，引擎若还继续替他回复，
   * 同一句话会被两个人（用户 + 引擎）各发一次 —— 这既是刷屏也是「抢话」。
   * 缺省（`undefined`）＝ `engine`，老快照无需迁移。
   */
  takeover?: ChatTakeoverMode;
  /** 被判定为「用户接管」的原因（视图要说清为什么停手，不静默） */
  takeoverReason?: string | null;
  /**
   * 每联系人开关（§5.7）：`autoReply`＝开场 + 对方来消息时引擎回不回。
   * `followUp` 字段仍可读（老设置兼容），但**主动追发产品已下线**，引擎不再读取它。
   * **缺省（`undefined`）＝开**，老快照无需迁移。
   *
   * 与 `takeover` 的分工：`takeover` 是「谁能说话」的总闸（human/paused 连读都不读），
   * `autoReply` 是「引擎可以说话时，开不开口 / 回不回」——关掉＝只记账。
   */
  autoReply?: boolean;
  /** @deprecated 主动追发已下线；保留字段仅兼容老设置，引擎不读 */
  followUp?: boolean;
  /**
   * 待发多句队列（跨片说完）：草稿一次产出多句时，本片预算不够就留下，
   * 下一片优先发出去，不再重新找模型写半截话。
   */
  pendingTexts?: string[];
}

export interface ChatEngineState {
  phase: ChatPhase;
  since: string;
  /** 单调递增的进展计数（看门狗据此判活，而不是读心跳时间戳） */
  progressCounter: number;
  nextWakeAt: string | null;
  campaignEndsAt: string | null;
  heartbeatAt: string | null;
  profileId: number | null;
  /** 看门狗重启次数（有上限，超限即停并如实报错） */
  restarts: number;
}

export interface ChatCounters {
  /** 本地日期键（YYYY-MM-DD），跨天自动归零 */
  dayKey: string;
  sentToday: number;
  rejectedToday: number;
  llmCallsToday: number;
  sentTotal: number;
  costMicroUsd: number;
}

export interface ChatStateSnapshot {
  schemaVersion: number;
  envId: string;
  engine: ChatEngineState;
  contacts: ChatContactState[];
  outbox: ChatOutboxEntry[];
  counters: ChatCounters;
}

export function dayKeyOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function createInitialSnapshot(options: {
  envId: string;
  profileId: number | null;
  now: string;
  phase?: ChatPhase;
}): ChatStateSnapshot {
  const phase = options.phase ?? "booting";
  return {
    schemaVersion: CHAT_STATE_SCHEMA_VERSION,
    envId: String(options.envId),
    engine: {
      phase,
      since: options.now,
      progressCounter: 0,
      nextWakeAt: null,
      campaignEndsAt: null,
      heartbeatAt: options.now,
      profileId: options.profileId,
      restarts: 0,
    },
    contacts: [],
    outbox: [],
    counters: {
      dayKey: dayKeyOf(options.now),
      sentToday: 0,
      rejectedToday: 0,
      llmCallsToday: 0,
      sentTotal: 0,
      costMicroUsd: 0,
    },
  };
}

/** 相位推进（唯一合法入口）：断言转移合法 + `progressCounter` 单调 +1 */
export function advancePhase(
  snapshot: ChatStateSnapshot,
  nextPhase: ChatPhase,
  now: string,
  patch: Partial<Omit<ChatEngineState, "phase" | "since" | "progressCounter">> = {},
): ChatStateSnapshot {
  assertTransition(snapshot.engine.phase, nextPhase);
  return {
    ...snapshot,
    engine: {
      ...snapshot.engine,
      ...patch,
      phase: nextPhase,
      since: now,
      progressCounter: snapshot.engine.progressCounter + 1,
      heartbeatAt: now,
    },
  };
}

/**
 * 同相位内的子步骤进展（§4.4）：等 LLM、逐条读取、逐轮回滚都该在这里 bump。
 * 这是「健康」的唯一权威信号；刻意不提供「只更新时间戳」的方法，避免心跳说谎。
 */
export function bumpProgress(snapshot: ChatStateSnapshot, now: string): ChatStateSnapshot {
  return {
    ...snapshot,
    engine: {
      ...snapshot.engine,
      progressCounter: snapshot.engine.progressCounter + 1,
      heartbeatAt: now,
    },
  };
}

export function setNextWakeAt(snapshot: ChatStateSnapshot, iso: string | null): ChatStateSnapshot {
  return { ...snapshot, engine: { ...snapshot.engine, nextWakeAt: iso } };
}

export function setContacts(
  snapshot: ChatStateSnapshot,
  contacts: readonly ChatContactState[],
): ChatStateSnapshot {
  return { ...snapshot, contacts: [...contacts] };
}

export function upsertContact(snapshot: ChatStateSnapshot, contact: ChatContactState): ChatStateSnapshot {
  const index = snapshot.contacts.findIndex((c) => c.key === contact.key);
  const contacts = [...snapshot.contacts];
  if (index < 0) contacts.push(contact);
  else contacts[index] = contact;
  return { ...snapshot, contacts };
}

export function getContact(snapshot: ChatStateSnapshot, key: string): ChatContactState | null {
  return snapshot.contacts.find((c) => c.key === key) ?? null;
}

export function setOutbox(snapshot: ChatStateSnapshot, outbox: readonly ChatOutboxEntry[]): ChatStateSnapshot {
  return { ...snapshot, outbox: trimOutbox(outbox) };
}

/** 跨天把「今日」计数归零（不碰累计值） */
export function rollCountersIfNewDay(snapshot: ChatStateSnapshot, now: string): ChatStateSnapshot {
  const key = dayKeyOf(now);
  if (!key || snapshot.counters.dayKey === key) return snapshot;
  return {
    ...snapshot,
    counters: { ...snapshot.counters, dayKey: key, sentToday: 0, rejectedToday: 0, llmCallsToday: 0 },
  };
}

/**
 * 确定性扫描到期回访与未停联系人（**零 LLM、零 I/O**，§4.1 `scanning`）。
 *
 * 排序刻意完全确定（到期时间 → 回访序号 → key），保证同输入同顺序，
 * 便于审计与测试；随机性只允许发生在候选集合之外。
 */
export function dueContacts(
  snapshot: ChatStateSnapshot,
  nowIso: string,
  limit = Number.POSITIVE_INFINITY,
): ChatContactState[] {
  const now = new Date(nowIso).getTime();
  const out = snapshot.contacts
    .filter((contact) => {
      if (contact.stopped || isStoppingStage(contact.stage)) return false;
      if (!contact.nextDueAt) return false;
      const due = new Date(contact.nextDueAt).getTime();
      return Number.isFinite(due) && due <= now;
    })
    .sort((a, b) => {
      const at = a.nextDueAt ?? "";
      const bt = b.nextDueAt ?? "";
      if (at !== bt) return at < bt ? -1 : 1;
      if (a.followUpIndex !== b.followUpIndex) return a.followUpIndex - b.followUpIndex;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  return Number.isFinite(limit) ? out.slice(0, Math.max(0, Math.trunc(limit))) : out;
}

/* ————————————————————————— 解析与校验 ————————————————————————— */

export type SnapshotReadResult =
  | { ok: true; snapshot: ChatStateSnapshot }
  | {
      ok: false;
      /**
       * `no_snapshot_path` = 本片没有 userDataDir（`chatSnapshotPath` 返回 null）。
       * 这不是「读失败」而是「根本不该读」：调用方必须走无记忆模式并**如实记一笔**，
       * 绝不许退到一个相对路径上去读别人的状态（§0.5.3 H）。
       */
      reason:
        | "missing"
        | "corrupt"
        | "version_mismatch"
        | "invalid"
        | "env_mismatch"
        | "no_snapshot_path";
      detail: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 严格解析：**只信自己能验证的字段**。校验不过就拒绝续跑，不做「尽力而为」的修补
 * —— 修补过的状态比没有状态更危险（§4.2）。
 */
export function parseSnapshot(raw: unknown): SnapshotReadResult {
  if (!isRecord(raw)) return { ok: false, reason: "invalid", detail: "快照不是对象" };

  const version = Number(raw.schemaVersion);
  if (!Number.isFinite(version)) {
    return { ok: false, reason: "invalid", detail: "缺少 schemaVersion" };
  }
  if (version !== CHAT_STATE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "version_mismatch",
      detail: `快照版本 ${version} 与当前 ${CHAT_STATE_SCHEMA_VERSION} 不兼容：请清理该环境的聊天上下文后重新启动`,
    };
  }

  const engineRaw = raw.engine;
  if (!isRecord(engineRaw)) return { ok: false, reason: "invalid", detail: "缺少 engine" };
  const phase = String(engineRaw.phase ?? "") as ChatPhase;
  if (!CHAT_PHASES.includes(phase)) {
    return { ok: false, reason: "invalid", detail: `未知相位：${String(engineRaw.phase)}` };
  }
  const progressCounter = Number(engineRaw.progressCounter);
  if (!Number.isFinite(progressCounter) || progressCounter < 0) {
    return { ok: false, reason: "invalid", detail: "progressCounter 非法" };
  }

  const contactsRaw = raw.contacts;
  if (!Array.isArray(contactsRaw)) return { ok: false, reason: "invalid", detail: "contacts 不是数组" };
  const contacts: ChatContactState[] = [];
  for (const item of contactsRaw) {
    if (!isRecord(item)) return { ok: false, reason: "invalid", detail: "contacts 含非对象项" };
    const key = String(item.key ?? "").trim();
    if (!key) return { ok: false, reason: "invalid", detail: "contacts 含空 key" };
    const stage = String(item.stage ?? "cold") as ChatStage;
    if (!CHAT_STAGES.includes(stage)) {
      return { ok: false, reason: "invalid", detail: `未知阶段：${String(item.stage)}` };
    }
    contacts.push({
      key,
      label: String(item.label ?? ""),
      siteKey: String(item.siteKey ?? ""),
      stage,
      followUpIndex: Number.isFinite(Number(item.followUpIndex)) ? Math.trunc(Number(item.followUpIndex)) : 0,
      nextDueAt: typeof item.nextDueAt === "string" ? item.nextDueAt : null,
      nextCheckAt: typeof item.nextCheckAt === "string" ? item.nextCheckAt : null,
      lastIncomingHash: typeof item.lastIncomingHash === "string" ? item.lastIncomingHash : null,
      lastSentHash: typeof item.lastSentHash === "string" ? item.lastSentHash : null,
      stopped: item.stopped === true,
      stopReason: typeof item.stopReason === "string" ? item.stopReason : null,
      lease: Number.isFinite(Number(item.lease)) ? Math.trunc(Number(item.lease)) : 0,
      updatedAt: String(item.updatedAt ?? ""),
      // 人工优先的一等控制：**只认合法枚举**，坏值按「引擎值守」处理并留痕（不静默丢整条联系人）
      takeover: (() => {
        const mode = String(item.takeover ?? "engine") as ChatTakeoverMode;
        return CHAT_TAKEOVER_MODES.includes(mode) ? mode : "engine";
      })(),
      takeoverReason: typeof item.takeoverReason === "string" ? item.takeoverReason : null,
      // 每联系人开关：只认真正的布尔（坏值按「未设置＝开」处理，不静默把整条联系人丢掉）
      ...(typeof item.autoReply === "boolean" ? { autoReply: item.autoReply } : {}),
      ...(typeof item.followUp === "boolean" ? { followUp: item.followUp } : {}),
      ...(Array.isArray(item.pendingTexts)
        ? {
            pendingTexts: item.pendingTexts
              .map((t) => String(t ?? "").trim())
              .filter((t) => t.length > 0)
              .slice(0, 5),
          }
        : {}),
    });
  }

  const outboxRaw = raw.outbox;
  if (!Array.isArray(outboxRaw)) return { ok: false, reason: "invalid", detail: "outbox 不是数组" };
  const outbox: ChatOutboxEntry[] = [];
  for (const item of outboxRaw) {
    if (!isRecord(item)) return { ok: false, reason: "invalid", detail: "outbox 含非对象项" };
    const effectId = String(item.effectId ?? "").trim();
    if (!effectId) return { ok: false, reason: "invalid", detail: "outbox 含空 effectId" };
    const status = String(item.status ?? "pending");
    if (status !== "pending" && status !== "sent" && status !== "unconfirmed") {
      return { ok: false, reason: "invalid", detail: `outbox 状态非法：${status}` };
    }
    outbox.push({
      effectId,
      threadKey: String(item.threadKey ?? ""),
      textHash: String(item.textHash ?? ""),
      status,
      attempts: Number.isFinite(Number(item.attempts)) ? Math.trunc(Number(item.attempts)) : 0,
      createdAt: String(item.createdAt ?? ""),
      lastAttemptAt: String(item.lastAttemptAt ?? ""),
      sentAt: typeof item.sentAt === "string" ? item.sentAt : null,
      note: typeof item.note === "string" ? item.note : null,
    });
  }

  const countersRaw = isRecord(raw.counters) ? raw.counters : {};
  const counters: ChatCounters = {
    dayKey: String(countersRaw.dayKey ?? ""),
    sentToday: Number(countersRaw.sentToday) || 0,
    rejectedToday: Number(countersRaw.rejectedToday) || 0,
    llmCallsToday: Number(countersRaw.llmCallsToday) || 0,
    sentTotal: Number(countersRaw.sentTotal) || 0,
    costMicroUsd: Number(countersRaw.costMicroUsd) || 0,
  };

  const engine: ChatEngineState = {
    phase,
    since: String(engineRaw.since ?? ""),
    progressCounter: Math.trunc(progressCounter),
    nextWakeAt: typeof engineRaw.nextWakeAt === "string" ? engineRaw.nextWakeAt : null,
    campaignEndsAt: typeof engineRaw.campaignEndsAt === "string" ? engineRaw.campaignEndsAt : null,
    heartbeatAt: typeof engineRaw.heartbeatAt === "string" ? engineRaw.heartbeatAt : null,
    profileId: Number.isFinite(Number(engineRaw.profileId)) ? Math.trunc(Number(engineRaw.profileId)) : null,
    restarts: Number.isFinite(Number(engineRaw.restarts)) ? Math.trunc(Number(engineRaw.restarts)) : 0,
  };

  return {
    ok: true,
    snapshot: {
      schemaVersion: CHAT_STATE_SCHEMA_VERSION,
      envId: String(raw.envId ?? ""),
      engine,
      contacts,
      outbox: trimOutbox(outbox),
      counters,
    },
  };
}

export function readSnapshotFile(file: string): SnapshotReadResult {
  if (!existsSync(file)) return { ok: false, reason: "missing", detail: "尚无快照" };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, reason: "corrupt", detail: error instanceof Error ? error.message : "读取失败" };
  }
  try {
    return parseSnapshot(JSON.parse(text));
  } catch (error) {
    return { ok: false, reason: "corrupt", detail: error instanceof Error ? error.message : "JSON 损坏" };
  }
}

/** 续跑的作用域（谁在读这份快照） */
export interface ResumeScope {
  envId: string;
  profileId: number | null;
}

/**
 * 这份快照**能不能**用来续跑。
 *
 * 除了「读得到」，只多一条纪律：**快照必须属于这个环境**。
 * `userDataDir` 本来就是按 profile 分目录的，理论上看不到别人的快照；但只要路径配错一次，
 * 就会把 A 环境的发件箱 / 计数 / 「谁已接管」套到 B 环境上 —— 那比「从零开始」危险得多
 * （§4.2：修补过的状态比没有状态更危险）→ 宁可拒绝续跑并**如实上报原因**。
 */
export function decideResume(read: SnapshotReadResult, scope: ResumeScope): SnapshotReadResult {
  if (!read.ok) return read;
  const envId = String(scope.envId ?? "").trim();
  const snapshotEnv = String(read.snapshot.envId ?? "").trim();
  if (envId && snapshotEnv && snapshotEnv !== envId) {
    return {
      ok: false,
      reason: "env_mismatch",
      detail: `快照属于环境 ${snapshotEnv}，与当前环境 ${envId} 不符`,
    };
  }
  return read;
}

export interface SnapshotWriteResult {
  ok: boolean;
  error: string | null;
}

/**
 * 原子写：tmp → rename（同目录 rename 是原子替换）。
 * 返回结果而不是抛错：写盘失败必须被上层看见（durable-before-return 不能静默失败）。
 */
export function writeSnapshotAtomic(file: string, snapshot: ChatStateSnapshot): SnapshotWriteResult {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "写入失败" };
  }
}
