/**
 * 聊天模式**每联系人上下文**（§4.2 / §5.7 / §10）。
 *
 * 布局（根目录就是该环境的 `userDataDir`，即 `browser-profiles/profile-{id}`）：
 *
 * ```
 * chat_context/
 *   state.json                        ← 引擎耐久快照（state.ts 管）
 *   {siteKey}/{contactKey}/
 *     thread.jsonl                    ← 会话流水（append-only，**已脱敏**）
 *     visit.json                      ← 回访状态（followUpIndex / nextDueAt / stage）
 *     summary.json                    ← 滚动摘要（P5 生成，这里只负责存）
 *     angles.json                     ← 已用过的切入角度（禁止复读）
 *     facts.json                      ← 关于对方的长期事实
 *     outbox.jsonl                    ← 发件审计流水（与快照里的 outbox 互为印证）
 * ```
 *
 * **为什么放在 profile 目录里而不是全局目录**：环境被删除时 `purge_profile_data_dir`
 * 会整个清掉 `browser-profiles/profile-{id}`，上下文随之消失。若放全局目录，删除后又
 * 新建一个「撞上同一 ID」的环境，新环境会**继承上一个环境的聊天记忆**——那是真实的
 * 串号事故（同 `purge_profile_data_dir` 关于 Cookie/指纹的既有理由）。
 *
 * 三条硬纪律：
 * 1. **写入必脱敏**：一次性码/令牌绝不落盘（R2 / §1.3），口径见 `chat_redaction.ts`。
 * 2. **路径不可穿越**：`siteKey` / `contactKey` 来自外部输入，必须清洗。
 * 3. **原子写**：tmp → rename，避免看门狗/重启读到半截 JSON。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { sanitizeForLedger } from "./chat_redaction.js";
import type { ChatMessage } from "./conversation_extract.js";
import type { ChatStage } from "./state.js";

export const CHAT_CONTEXT_DIR = "chat_context";
/** 热窗口：模型与 UI 默认读这里 */
export const THREAD_LEDGER_LIMIT = 400;
/** 超出热窗口的旧流水进归档，不再丢掉 */
export const THREAD_ARCHIVE_FILE = "thread.archive.jsonl";
/** 长期事实最多留多少条 */
export const FACTS_LIMIT = 40;
/** 角度最多留多少条 */
export const ANGLES_LIMIT = 40;

/* ————————————————————————— 路径 ————————————————————————— */

/**
 * 清洗单个路径段。
 *
 * **安全关键**：`contactKey` 可能来自用户输入或宿主 payload，必须挡住 `../` 与
 * 绝对路径，否则「清空某个联系人」会变成删除磁盘任意目录。
 *
 * 特别注意**清洗后可能变空**（例如 `" . "` / `"..."`）。此时必须回退到 fallback：
 * 返回空串会让路径少一段，`{site}/` 直接等于站点目录 —— 「清一个联系人」就变成
 * 「清整个站点」（fail-open）。这是真踩得到的边界，Rust 侧同样口径。
 */
export function sanitizeSegment(raw: unknown, fallback = "unknown"): string {
  const base = String(raw ?? "").trim();
  const source = base || fallback;
  const cleaned = source
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 96);
  return cleaned || fallback;
}

export function chatContextRoot(userDataDir: string): string {
  const root = String(userDataDir ?? "").trim();
  if (!root) {
    throw new Error("chat_context_root_required");
  }
  return join(root, CHAT_CONTEXT_DIR);
}

export function contactDir(userDataDir: string, siteKey: string, contactKey: string): string {
  return join(
    chatContextRoot(userDataDir),
    sanitizeSegment(siteKey, "unknown-site"),
    sanitizeSegment(contactKey, "unknown-contact"),
  );
}

/* ————————————————————————— 原子写 / JSON 读写 ————————————————————————— */

export interface FileOpResult {
  ok: boolean;
  error: string | null;
}

function writeTextAtomic(file: string, text: string): FileOpResult {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "写入失败" };
  }
}

function writeJsonAtomic(file: string, value: unknown): FileOpResult {
  return writeTextAtomic(file, JSON.stringify(value, null, 2));
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // 损坏就当作没有：不猜、不崩（由上层按「首次接触」处理）
    return null;
  }
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    const text = readFileSync(file, "utf8");
    const out: T[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        // 单行损坏跳过，不影响其余历史（append-only 的部分损坏不该毁掉整份记忆）
      }
    }
    return out;
  } catch {
    return [];
  }
}

function appendJsonl(file: string, rows: readonly unknown[]): FileOpResult {
  if (rows.length === 0) return { ok: true, error: null };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const payload = rows.map((row) => JSON.stringify(row)).join("\n");
    appendFileSync(file, `${payload}\n`, "utf8");
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "追加失败" };
  }
}

/* ————————————————————————— 会话流水 ————————————————————————— */

export interface LedgerEntry {
  /** 稳定 id（与会话读取器一致：站点 key 或内容指纹） */
  id: string;
  direction: "in" | "out";
  /** **已脱敏**的文本 */
  text: string;
  ts: string | null;
  /** 写入时间（ISO） */
  at: string;
}

/**
 * 追加会话流水。
 *
 * - 传入的消息**先脱敏再落盘**（R2）。
 * - 按 `id` 与「已有尾部的 id 集合」去重：虚拟列表反复读到同一条不会重复写入。
 * - 超过 {@link THREAD_LEDGER_LIMIT} 时**重写裁尾**（低频操作，只在超限时发生）。
 *
 * 返回值里的 `appendedIn` / `appendedOut` 是**真正新增**的条数（已去重）。
 * 调用方统计「本轮收到几条」必须用这个，而不是传入数组的长度——引擎每轮都会把
 * 读到的整段会话传进来，用长度会把同一条消息反复计入（计数虚高）。
 */
export function appendThreadMessages(
  dir: string,
  messages: readonly ChatMessage[],
  now = new Date().toISOString(),
): FileOpResult & { appended: number; skipped: number; appendedIn: number; appendedOut: number } {
  const file = join(dir, "thread.jsonl");
  const prepared: LedgerEntry[] = [];
  let skipped = 0;

  for (const message of messages) {
    const id = String(message.id ?? "").trim();
    const rawText = String(message.text ?? "").trim();
    if (!id || !rawText) {
      skipped += 1;
      continue;
    }
    // 方向未知绝不默认成 in（现场：unknown→in 后同文再落 out，造成 in/out 翻转与假未回复）
    if (message.direction !== "in" && message.direction !== "out") {
      skipped += 1;
      continue;
    }
    prepared.push({
      id,
      direction: message.direction,
      text: sanitizeForLedger(rawText),
      ts: message.ts ?? null,
      at: now,
    });
  }
  if (prepared.length === 0) {
    return { ok: true, error: null, appended: 0, skipped, appendedIn: 0, appendedOut: 0 };
  }

  const existing = readJsonl<LedgerEntry>(file);
  const seen = new Set(existing.slice(-200).map((entry) => entry.id));
  const fresh = prepared.filter((entry) => {
    if (seen.has(entry.id)) {
      skipped += 1;
      return false;
    }
    seen.add(entry.id);
    return true;
  });

  const result = appendJsonl(file, fresh);
  if (!result.ok) {
    return { ...result, appended: 0, skipped, appendedIn: 0, appendedOut: 0 };
  }

  // 超限才把旧段挪进归档（重写热文件是低频操作）。
  // 热文件仍是 **JSONL**：文件名与内容格式保持一致。
  const total = existing.length + fresh.length;
  if (total > THREAD_LEDGER_LIMIT) {
    const all = [...existing, ...fresh];
    const overflow = all.slice(0, all.length - THREAD_LEDGER_LIMIT);
    const kept = all.slice(-THREAD_LEDGER_LIMIT);
    appendJsonl(join(dir, THREAD_ARCHIVE_FILE), overflow);
    writeTextAtomic(file, kept.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }

  return {
    ok: true,
    error: null,
    appended: fresh.length,
    skipped,
    appendedIn: fresh.filter((entry) => entry.direction === "in").length,
    appendedOut: fresh.filter((entry) => entry.direction === "out").length,
  };
}

/**
 * 读取会话流水（尾部 `limit` 条，时间正序）。
 * 兼容两种落盘形态：JSONL（常规）与 JSON 数组（旧版裁尾遗留），损坏行单独跳过。
 */
export function readThreadMessages(dir: string, limit = 60): LedgerEntry[] {
  const file = join(dir, "thread.jsonl");
  if (!existsSync(file)) return [];

  let entries: LedgerEntry[] = [];
  try {
    const text = readFileSync(file, "utf8").trim();
    if (text.startsWith("[")) {
      entries = JSON.parse(text) as LedgerEntry[];
    } else {
      entries = readJsonl<LedgerEntry>(file);
    }
  } catch {
    entries = [];
  }
  return entries.slice(-Math.max(0, limit));
}

/** 转为给模型看的消息列表（`ChatMessage` 形态） */
export function ledgerToMessages(entries: readonly LedgerEntry[]): ChatMessage[] {
  return entries.map((entry) => ({
    id: entry.id,
    direction: entry.direction,
    text: entry.text,
    ts: entry.ts,
    identity: null,
    stableId: true,
  }));
}

/* ————————————————————————— 回访状态 ————————————————————————— */

export interface VisitState {
  /** 展示名（Host 指定的联系人 label；便于 UI 列表可读） */
  label: string;
  /** 第一次接触时间 */
  firstContactAt: string | null;
  /** 最近一次我们发出消息的时间 */
  lastContactAt: string | null;
  /** 最近一次对方回话的时间 */
  lastReplyAt: string | null;
  /** 本轮回访已发几次 */
  followUpIndex: number;
  /** 下次回访到期时间（持久化 → 重启不风暴） */
  nextDueAt: string | null;
  /** 关系阶段 */
  stage: ChatStage;
  /** 已停止接触（退订/转化/风控） */
  stopped: boolean;
  stopReason: string | null;
  /** 累计收发条数 */
  totalIn: number;
  totalOut: number;
  /** 疑似交易次数（对方要付款方式 / 成交语境） */
  suspectedTradeCount?: number;
  updatedAt: string;
}

export function emptyVisitState(now = new Date().toISOString()): VisitState {
  return {
    label: "",
    firstContactAt: null,
    lastContactAt: null,
    lastReplyAt: null,
    followUpIndex: 0,
    nextDueAt: null,
    stage: "cold",
    stopped: false,
    stopReason: null,
    totalIn: 0,
    totalOut: 0,
    suspectedTradeCount: 0,
    updatedAt: now,
  };
}

export function readVisitState(dir: string): VisitState | null {
  const raw = readJson<Partial<VisitState>>(join(dir, "visit.json"));
  if (!raw) return null;
  // 缺字段按空态补齐，而不是整份丢弃（老版本写下的文件要能读）
  return { ...emptyVisitState(), ...raw } as VisitState;
}

export function writeVisitState(dir: string, state: VisitState): FileOpResult {
  return writeJsonAtomic(join(dir, "visit.json"), state);
}

/**
 * 把一次交互**记录**成回访状态。
 *
 * 这里**刻意不重算** `followUpIndex` / `nextDueAt`：那套规则（「对方回话即重置序列」、
 * 退避曲线）的唯一权威在引擎（`engine.ts` + `cadence.ts`）。本函数只把引擎算好的结果
 * 连同时间戳、累计计数一起落盘。
 *
 * 为什么强调这点：两处各写一份「回访序号怎么变」，迟早一边重置一边递增，
 * 表现就是「回访风暴」或「永不再访」——都是极难复现的线上事故（§0.5.3 F）。
 */
export function settleVisitState(
  previous: VisitState,
  input: {
    now: string;
    /** 展示名（Host 给的 label；空则沿用上一次的） */
    label?: string;
    /** 本轮收到的消息条数（>0 即视为对方回话） */
    incomingCount: number;
    /** 本轮是否真的发出去了 */
    sent: boolean;
    /** 引擎算好的回访序号（权威值） */
    followUpIndex: number;
    /** 引擎算好的下次唤醒时间（权威值） */
    nextDueAt: string | null;
    stage: ChatStage;
    stopped?: boolean;
    stopReason?: string | null;
    suspectedTradeCount?: number;
  },
): VisitState {
  const hasReply = input.incomingCount > 0;
  const trade = Math.max(
    previous.suspectedTradeCount ?? 0,
    Math.max(0, Math.round(input.suspectedTradeCount ?? 0)),
  );
  return {
    label: String(input.label ?? "").trim() || previous.label,
    firstContactAt: previous.firstContactAt ?? (input.sent ? input.now : null),
    lastContactAt: input.sent ? input.now : previous.lastContactAt,
    lastReplyAt: hasReply ? input.now : previous.lastReplyAt,
    followUpIndex: Math.max(0, Math.round(input.followUpIndex)),
    // 引擎权威：null 表示「本轮不再追」，不得用旧值顶回来
    nextDueAt: input.nextDueAt,
    stage: input.stage,
    stopped: input.stopped ?? previous.stopped,
    stopReason: input.stopReason ?? previous.stopReason,
    totalIn: previous.totalIn + Math.max(0, input.incomingCount),
    totalOut: previous.totalOut + (input.sent ? 1 : 0),
    suspectedTradeCount: trade,
    updatedAt: input.now,
  };
}

/* ————————————————————————— 摘要 / 角度 / 事实 ————————————————————————— */

export interface ThreadSummary {
  /** 滚动摘要正文（P5 由模型生成） */
  text: string;
  /** 摘要已覆盖到哪条消息 id（避免重复总结） */
  coveredUpToId: string | null;
  /** 已做过几次摘要（用于「不做递归退化」的判断） */
  generations: number;
  updatedAt: string;
}

export function readSummary(dir: string): ThreadSummary | null {
  return readJson<ThreadSummary>(join(dir, "summary.json"));
}

export function writeSummary(dir: string, summary: ThreadSummary): FileOpResult {
  return writeJsonAtomic(join(dir, "summary.json"), summary);
}

/** 读取已用过的切入角度（禁止复读的依据） */
export function readAngles(dir: string): string[] {
  const raw = readJson<{ angles?: unknown }>(join(dir, "angles.json"));
  if (!raw || !Array.isArray(raw.angles)) return [];
  return raw.angles.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/** 追加一个角度（去重 + 限量） */
export function addAngle(dir: string, angle: string): string[] {
  const value = String(angle ?? "").trim();
  const existing = readAngles(dir);
  if (!value || existing.includes(value)) {
    return existing;
  }
  const next = [...existing, value].slice(-ANGLES_LIMIT);
  writeJsonAtomic(join(dir, "angles.json"), { angles: next });
  return next;
}

/** 读取关于对方的长期事实 */
export function readFacts(dir: string): string[] {
  const raw = readJson<{ facts?: unknown }>(join(dir, "facts.json"));
  if (!raw || !Array.isArray(raw.facts)) return [];
  return raw.facts.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/** 追加长期事实（脱敏 + 去重 + 限量） */
export function addFacts(dir: string, facts: readonly string[]): string[] {
  const existing = readFacts(dir);
  const merged = [...existing];
  for (const fact of facts) {
    const value = sanitizeForLedger(String(fact ?? ""), 300);
    if (!value || merged.includes(value)) continue;
    merged.push(value);
  }
  const next = merged.slice(-FACTS_LIMIT);
  if (next.length !== existing.length) {
    writeJsonAtomic(join(dir, "facts.json"), { facts: next });
  }
  return next;
}

/* ————————————————————————— 发件审计流水 ————————————————————————— */

export interface OutboxJournalEntry {
  effectId: string;
  threadKey: string;
  /** 归一化文本指纹（**不落原文**，避免把内容重复存一遍） */
  textHash: string;
  status: "pending" | "sent" | "unconfirmed";
  attempts: number;
  at: string;
  note: string | null;
}

export function appendOutboxJournal(dir: string, entry: OutboxJournalEntry): FileOpResult {
  return appendJsonl(join(dir, "outbox.jsonl"), [entry]);
}

/**
 * 读取发件审计流水（尾部 `limit` 条，时间正序）。
 *
 * 为什么要能读回来：这是「**我们确实发过这条**」的**耐久证据**，与快照里的 `outbox` 互为印证。
 * 快照会被重置（换环境 / 快照被判不合用 / 用户清理过一半），流水不会 —— 只认快照就会把
 * 「我们自己以前发的那条」当成陌生人出站消息，进而把该联系人误判成「用户接管」并永久停手
 * （§0.5.3 H「自动检测出来的接管被当成用户意图」的真实来源之一）。
 *
 * 损坏行单独跳过（与 `readThreadMessages` 同一口径：读不出来就少几条，绝不整份失败）。
 */
export function readOutboxJournal(dir: string, limit = 200): OutboxJournalEntry[] {
  const file = join(dir, "outbox.jsonl");
  if (!existsSync(file)) return [];
  let entries: OutboxJournalEntry[] = [];
  try {
    entries = readJsonl<OutboxJournalEntry>(file);
  } catch {
    entries = [];
  }
  return entries.slice(-Math.max(0, limit));
}

/* ————————————————————————— 枚举与统计 ————————————————————————— */

export interface ContactDirRef {
  siteKey: string;
  contactKey: string;
  dir: string;
}

/** 枚举该环境下已登记过上下文的所有联系人（宿主编排与 UI 统计用） */
export function listContactDirs(userDataDir: string): ContactDirRef[] {
  const root = chatContextRoot(userDataDir);
  const out: ContactDirRef[] = [];
  let siteDirs: string[];
  try {
    siteDirs = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];
  } catch {
    return out;
  }

  for (const siteKey of siteDirs) {
    let contactDirs: string[];
    try {
      contactDirs = readdirSync(join(root, siteKey), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const contactKey of contactDirs) {
      out.push({ siteKey, contactKey, dir: join(root, siteKey, contactKey) });
    }
  }
  return out;
}

/* 清理与统计**不在本模块实现**：权威实现在 Host（`src-tauri/src/chat_context.rs` 的
 * `purge_chat_context` / `purge_all_chat_contexts` / `chat_context_stats`）—— 「引擎是否在跑」
 * 是宿主会话状态，且清理必须同时删 `chat_threads` 索引。这里曾有一份 TS 副本，只有测试在用，
 * 两套删除逻辑必然分叉（坑族 J），已删。
 *
 * 内容指纹请直接用 `outbox.hashText`（或 `chat_redaction.fingerprint`，已委托给同一套）。
 */
