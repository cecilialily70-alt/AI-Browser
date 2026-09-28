/**
 * 回访节奏（§10）—— 有节制、频率可配、可停
 *
 * 联网最优解（Sales Cadence 系列）落成的参数：首次回访至少隔 ~48h，之后拉到 4–7 天，
 * 一轮 3–5 次，一轮后 7–10 天冷却，彻底静默的隔 90–180 天才重启，且**必须带新角度**。
 * **任何回复、异议、退订、明确拒绝 → 立即停止全部后续。**
 *
 * 两条硬纪律：
 *   - `nextDueAt` 必须持久化（`visit.json` / 快照），否则每次重启立即重发 → 回访风暴（§0.5.3 H）。
 *   - 禁止「在吗 / 还在考虑吗」式空访：没有新角度就本轮不发，如实记 `chat_followup_skipped`。
 *
 * 间隔带**确定性抖动**（由线程 key 派生，不是随机数）：多环境不会同刻齐发，
 * 但同一线程每次算出的值都一样 —— 既不像机器，又可测可复现（§0.5.3 F）。
 *
 * 纯函数、无 I/O。
 */
import { hash32 } from "../hash32.js";

export interface QuietHours {
  /** "HH:MM"（本地时间） */
  start: string;
  /** "HH:MM"（本地时间） */
  end: string;
}

export interface CadenceConfig {
  followUpEnabled: boolean;
  /** 首次回访间隔（小时），默认 48 */
  followUpHours: number;
  /** 后续回访间隔序列（小时），默认 [96, 168] = 4 天、7 天 */
  followUpBackoffHours: number[];
  /** 一轮最多回访几次，默认 4 */
  maxFollowUps: number;
  /** 一轮结束后冷却（天），默认 10 */
  followUpCoolDownDays: number;
  /** 彻底静默多久才允许重启新一轮（天），默认 90 */
  followUpRevivalDays: number;
  /** 静默时段（本地时间）；null 表示不设 */
  quietHours: QuietHours | null;
  /**
   * 每日发送上限（跨线程）。
   *
   * **`0` = 不限**（我们有意识地不在默认路径上节流；这里只防「一次崩坏把额度烧光」）。
   * 它不是省钱手段，也不该被当成「聊天配额」（§1.5 / §10 第 5 条）。
   */
  maxPerDay: number;
  /** 间隔抖动比例（0~0.5），默认 0.1 */
  jitterRatio: number;
}

export const DEFAULT_CADENCE: CadenceConfig = {
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

/**
 * 回访节奏各字段的**唯一区间口径**（[下限, 上限]）。
 *
 * 为什么区间也要收敛成常量：以前前端一套（还带越界诊断）、侧车一套（有的字段连上界都没有），
 * 同一个输入两种结论 —— 设置里显示 1440 小时、引擎按 20000 小时跑（§0.5.3 C「两套口径」）。
 *
 * **改这里必须同时改** `src/lib/chatModeSettings.ts::CADENCE_LIMITS`，
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

/**
 * 把外部传入的节奏字段**夹到合法区间**（不是丢弃也不是静默换默认）。
 * 缺失 / `null` / 空串 / 非数字 → 回落 `fallback`；越界 → 夹到区间边界。
 */
export function clampCadenceValue(
  raw: unknown,
  fallback: number,
  range: readonly [number, number],
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(range[1], Math.max(range[0], value));
}

/** 单个联系人的回访状态（落在 `visit.json`，并索引进快照） */
export interface FollowUpState {
  /** 已发起的回访轮次（0 = 还没回过访） */
  followUpIndex: number;
  /** 下次回访到期时间（ISO）；必须持久化 */
  nextDueAt: string | null;
  /** 我方上次发出时间 */
  lastContactAt: string | null;
  /** 对方上次回复时间 */
  lastReplyAt: string | null;
  stopped: boolean;
}

export type FollowUpSkipReason =
  | "disabled"
  | "chat_off"
  | "contact_off"
  | "stopped"
  | "replied"
  | "not_due"
  | "round_exhausted"
  | "no_new_angle"
  | "daily_cap"
  | "quiet_hours";

export type FollowUpPlan =
  | { action: "send"; reason: "due"; /** 基准间隔（未抖动）；落库请用 `computeNextDueAt` 传入真实线程 key */ intervalHours: number }
  | { action: "skip"; reason: FollowUpSkipReason };

/** 对方在我方上次发出之后回过话 → 回访无意义（对话由正常回复流程接管） */
export function repliedSinceLastContact(state: FollowUpState): boolean {
  if (!state.lastReplyAt) return false;
  if (!state.lastContactAt) return true;
  return new Date(state.lastReplyAt).getTime() > new Date(state.lastContactAt).getTime();
}

/** 第 `index` 次回访（已发 `index` 次之后要等多久）对应的基准间隔小时数 */
export function intervalHoursFor(index: number, config: CadenceConfig = DEFAULT_CADENCE): number {
  const idx = Math.max(0, Math.trunc(index));
  if (idx === 0) return Math.max(1, config.followUpHours);
  const backoff = config.followUpBackoffHours.length > 0 ? config.followUpBackoffHours : DEFAULT_CADENCE.followUpBackoffHours;
  const value = backoff[Math.min(idx - 1, backoff.length - 1)];
  return Math.max(1, Number.isFinite(value) ? value : DEFAULT_CADENCE.followUpHours);
}

/** 确定性抖动系数：由 `线程 key + 序号` 派生（同线程同序号永远同一值） */
export function jitterFactor(threadKey: string, index: number, jitterRatio: number): number {
  const ratio = Math.max(0, Math.min(0.5, Number.isFinite(jitterRatio) ? jitterRatio : 0));
  if (ratio === 0) return 1;
  const unit = (hash32(`${threadKey}|${Math.trunc(index)}`) % 1000) / 1000; // [0, 1)
  return 1 + (unit * 2 - 1) * ratio;
}

/** 抖动后的间隔小时数（正数） */
export function jitteredIntervalHours(
  threadKey: string,
  index: number,
  config: CadenceConfig = DEFAULT_CADENCE,
): number {
  const base = intervalHoursFor(index, config);
  return Math.max(1, base * jitterFactor(threadKey, index, config.jitterRatio));
}

/** 算出下一次到期时间：`已发 followUpIndex 次` → +该轮间隔 */
export function computeNextDueAt(
  threadKey: string,
  followUpIndex: number,
  config: CadenceConfig,
  nowIso: string,
): string {
  const hours = jitteredIntervalHours(threadKey, followUpIndex, config);
  const now = new Date(nowIso).getTime();
  return new Date(now + hours * 3600 * 1000).toISOString();
}

/**
 * 「发完就结束」的真坑（§0.5.3 H）：引擎是**切片式**的（一片到点就让位），
 * 而「对方回话」只可能在下一次被唤醒时才发现。若下次唤醒按回访节奏算（48h 起），
 * 一场正常对话就被拖成两天一轮 —— 用户看到的就是「发完一条信息就结束了」。
 *
 * 所以把两件事**分开**（不要用一个 `nextDueAt` 兼任两种语义）：
 *   - `nextDueAt`  仍是**回访**到期（对方不理我时才用；48h 起，语义不变）；
 *   - 本函数算的是**短复查**时间（只去看有没有新消息，不发就不发）。
 *
 * 两条边界，防止「回访风暴」变成「空转风暴」：
 *   1. 只在**我方最后说话**后的 `windowMinutes`（默认 {@link LIVE_REPLY_WINDOW_MINUTES}＝12h）内复查；超窗即 `null`（回归正常回访节奏）；
 *   2. 锚点是**耐久事实** `lastContactAt`（`visit.json`），不依赖内存，重启也不会算错。
 */
/**
 * 短复查的**两段式**口径（锚点始终是耐久事实，确定性、不随唤醒时间漂移）：
 *
 *   1. **热窗口**（{@link LIVE_REPLY_HOT_MINUTES}＝10 分钟）：对话正在进行中 → **固定 30 秒**看一眼。
 *      用户要的就是「对方一说话就接上」；30 秒是「重接页面 + 读一遍会话」的开销与反应速度的平衡点
 *      （更密只是在空转，更稀就变成「人回了它不理」）。
 *   2. **冷阶段**（10 分钟 → 12 小时）：对方一直没回 → 递增阶梯
 *      {@link LIVE_REPLY_COOL_LADDER_MINUTES}（15 → 30 → 45 → 60 → 120 分钟），其后按末档重复。
 *      越等越稀，绝不空转风暴。
 *
 * 超出 `windowMinutes`（默认 {@link LIVE_REPLY_WINDOW_MINUTES}＝12h）→ `null`：回归正常回访节奏。
 */
export const LIVE_REPLY_HOT_MINUTES = 60;
/** 热窗口内的复查节拍（毫秒）：5 秒（近实时盯守） */
export const LIVE_REPLY_HOT_STEP_MS = 5_000;
/** 冷阶段的递增阶梯（分钟）——仍保持秒级可唤醒，只是略稀 */
export const LIVE_REPLY_COOL_LADDER_MINUTES: readonly number[] = [1, 2, 5, 10, 15];
/** 末档（冷阶段阶梯用尽后的复查间隔，分钟） */
export const LIVE_REPLY_RECHECK_MINUTES = LIVE_REPLY_COOL_LADDER_MINUTES[
  LIVE_REPLY_COOL_LADDER_MINUTES.length - 1
]!;
/** 复查窗口（分钟）：24 小时内都持续盯 */
export const LIVE_REPLY_WINDOW_MINUTES = 1440;
/**
 * 算出来的复查时间离「现在」至少留这么久（毫秒）。
 *
 * 只作**安全网**（正常路径算出的刻度天然在未来）：极小，否则会把 30 秒的热节拍硬生生推后
 * ——用户要的是「30 秒看一眼」，不是「至少 45 秒才看一眼」。
 */
export const LIVE_REPLY_MIN_GAP_MS = 2_000;
/**
 * 「对方刚回话、我方还没接上」的兜底复查阶梯（秒）：`15 → 30 → 60 → 120 → 300`。
 *
 * 为什么需要这一条（片末竞态，**必须**堵住）：对方那句恰好落在「片内观察结束」与「片末结算」
 * 之间时，`lastReplyAt > lastContactAt`，若这里按老口径直接返回 `null`（放弃盯着），下一次唤醒
 * 就会掉到 48 小时后的回访 —— 用户看到的就是「人明明回了，它两天不理」。
 * 而这里**必须有上限**：接不上（用户关了自动聊天 / 已交人工）时，5 分钟后放弃盯守，
 * 交回正常回访节奏 —— 否则会变成 15 秒一轮的永久空转。
 */
export const PENDING_REPLY_LADDER_SECONDS: readonly number[] = [15, 30, 60, 120, 300];

export function liveReplyRecheckAt(input: {
  nowIso: string;
  /** 我方上次发出时间（权威来自 `visit.json`，不是内存） */
  lastContactAt: string | null;
  /** 对方上次回复时间（我方之后回过话 → 那不算「等对方回」，而是「对方在等我」） */
  lastReplyAt: string | null;
  windowMinutes?: number;
  /** 覆盖热窗口（测试用；生产走 {@link LIVE_REPLY_HOT_MINUTES}） */
  hotMinutes?: number;
  /** 覆盖冷阶段阶梯（测试用；生产走 {@link LIVE_REPLY_COOL_LADDER_MINUTES}） */
  ladderMinutes?: readonly number[];
  /** 覆盖「对方在等我」的阶梯（测试用；生产走 {@link PENDING_REPLY_LADDER_SECONDS}） */
  pendingLadderSeconds?: readonly number[];
}): string | null {
  const now = new Date(input.nowIso).getTime();
  if (!Number.isFinite(now)) return null;
  if (!input.lastContactAt) return null;
  const last = new Date(input.lastContactAt).getTime();
  if (!Number.isFinite(last)) return null;

  const windowMinutes = Math.max(1, input.windowMinutes ?? LIVE_REPLY_WINDOW_MINUTES);
  const windowEnd = last + windowMinutes * 60_000;
  const floor = now + LIVE_REPLY_MIN_GAP_MS;

  const reply = input.lastReplyAt ? new Date(input.lastReplyAt).getTime() : Number.NaN;

  // 对方在等我（片末恰好错过对方那句）：先用**短阶梯**追上去
  if (Number.isFinite(reply) && reply > last) {
    const sinceReply = now - reply;
    if (sinceReply >= 0 && sinceReply < windowMinutes * 60_000) {
      const ladder = (input.pendingLadderSeconds ?? PENDING_REPLY_LADDER_SECONDS)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
      const rung = ladder.find((seconds) => seconds * 1000 > sinceReply);
      if (rung !== undefined) {
        const candidate = Math.max(reply + rung * 1000, floor);
        if (candidate <= now) return null;
        return new Date(Math.min(candidate, windowEnd)).toISOString();
      }
    }
    // **追不上也不能返回 `null`**：那会把「对方在等我」直接丢到 48 小时后的回访上
    //（用户看到的就是「人明明回了，它两天不理」）。落到下面的冷阶段阶梯 —— 更稀，但一定会来。
  }

  const elapsed = now - last;
  if (elapsed < 0 || elapsed >= windowMinutes * 60_000) return null;

  const hotMinutes = Math.max(0, input.hotMinutes ?? LIVE_REPLY_HOT_MINUTES);
  let candidate: number;
  if (hotMinutes > 0 && elapsed < hotMinutes * 60_000) {
    // 热窗口：固定节拍，锚在 `lastContactAt` 上取「还没走到的下一个刻度」
    // （片跑久了也不会漏档，最多 30 秒后就补上）
    const steps = Math.floor(elapsed / LIVE_REPLY_HOT_STEP_MS) + 1;
    candidate = Math.max(last + steps * LIVE_REPLY_HOT_STEP_MS, floor);
  } else {
    const ladder = (input.ladderMinutes ?? LIVE_REPLY_COOL_LADDER_MINUTES)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    const tail = ladder.length > 0 ? ladder[ladder.length - 1]! : LIVE_REPLY_RECHECK_MINUTES;
    const rung = ladder.find((minutes) => minutes * 60_000 > elapsed);
    // 命中档位时它**严格晚于**已过去的时间 → 天然在未来（不需要再夹）；
    // 阶梯走完则从「现在」起按末档重排（绝不会排到过去那种「立刻空转」）。
    candidate = rung !== undefined ? last + rung * 60_000 : now + tail * 60_000;
  }
  const capped = Math.min(candidate, windowEnd);
  if (capped <= now) return null;
  return new Date(capped).toISOString();
}

/**
 * `"HH:MM"` 归一化：`"9:05"` → `"09:05"`；非法一律返回 `null`（**不猜、不修正**成别的时刻）。
 *
 * 与前端 `src/lib/chatModeSettings.ts::parseClock` 同一套文法（逐字镜像，改一边必须改另一边）。
 */
export function normalizeClock(value: unknown): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * 静默时段归一化（两侧共用的唯一文法）。
 *
 * - `null` → `null`（用户显式「不设静默」）
 * - 合法对象 → 归一化后的 `{start, end}`
 * - **非法 / 缺失 → `undefined`**：由调用方决定是回落默认还是记诊断，
 *   绝不把 `"25:00"` 这种值原样喂给引擎（§0.5.3 A「判定失败别谎报」）。
 */
export function normalizeQuietHours(raw: unknown): QuietHours | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const start = normalizeClock(record.start);
  const end = normalizeClock(record.end);
  if (start === null || end === null) return undefined;
  return { start, end };
}

function parseClock(value: string): number | null {
  const normalized = normalizeClock(value);
  if (normalized === null) return null;
  const [hours, minutes] = normalized.split(":").map(Number);
  return hours * 60 + minutes;
}

/** 是否处于静默时段（支持跨零点，如 22:00–08:00） */
export function isWithinQuietHours(iso: string, quiet: QuietHours | null): boolean {
  if (!quiet) return false;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === null || end === null || start === end) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** 静默时段结束时刻（不在静默中则返回 null）；调度器用它把唤醒挪到天亮 */
export function nextQuietEnd(iso: string, quiet: QuietHours | null): string | null {
  if (!isWithinQuietHours(iso, quiet) || !quiet) return null;
  const end = parseClock(quiet.end);
  if (end === null) return null;
  const now = new Date(iso);
  const target = new Date(now.getTime());
  target.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setTime(target.getTime() + 24 * 3600 * 1000);
  }
  return target.toISOString();
}

/**
 * 主判定（纯函数）：本轮该不该回访。
 *
 * 检查顺序刻意「先权威后便宜」：开关 → 停止 → 对方已回 → 未到期 → 轮次用尽 →
 * 无新角度 → 日上限 → 静默时段。任何一条命中都**如实给出原因**，不静默跳过（§0.5.3 B）。
 */
export function planFollowUp(
  state: FollowUpState,
  config: CadenceConfig = DEFAULT_CADENCE,
  nowIso: string,
  ctx: {
    newAngleAvailable: boolean;
    sentToday: number;
    /** 该联系人被用户关掉了「定时回访」（§5.7 每联系人开关）；缺省＝开 */
    contactFollowUpOff?: boolean;
  },
): FollowUpPlan {
  if (!config.followUpEnabled) return { action: "skip", reason: "disabled" };
  if (ctx.contactFollowUpOff === true) return { action: "skip", reason: "contact_off" };
  if (state.stopped) return { action: "skip", reason: "stopped" };
  if (repliedSinceLastContact(state)) return { action: "skip", reason: "replied" };
  if (state.followUpIndex >= config.maxFollowUps) return { action: "skip", reason: "round_exhausted" };

  const now = new Date(nowIso).getTime();
  if (!state.nextDueAt || !Number.isFinite(new Date(state.nextDueAt).getTime())) {
    return { action: "skip", reason: "not_due" };
  }
  if (new Date(state.nextDueAt).getTime() > now) return { action: "skip", reason: "not_due" };

  // 禁止空访：没有新角度就不发
  if (!ctx.newAngleAvailable) return { action: "skip", reason: "no_new_angle" };
  // `maxPerDay = 0` 即「不限」：不新增任何每日回复上限，默认路径上不节流
  if (config.maxPerDay > 0 && ctx.sentToday >= config.maxPerDay) {
    return { action: "skip", reason: "daily_cap" };
  }
  if (isWithinQuietHours(nowIso, config.quietHours)) return { action: "skip", reason: "quiet_hours" };

  return { action: "send", reason: "due", intervalHours: intervalHoursFor(state.followUpIndex, config) };
}

/** 一轮结束后的冷却到期时间（新一轮不得早于此） */
export function nextRoundDueAt(config: CadenceConfig, nowIso: string): string {
  const now = new Date(nowIso).getTime();
  return new Date(now + Math.max(0, config.followUpCoolDownDays) * 24 * 3600 * 1000).toISOString();
}

/** 长期静默是否已过重启门槛（新一轮还需「有新角度」才真的发，见 `planFollowUp`） */
export function shouldRevive(
  lastContactAt: string | null,
  config: CadenceConfig,
  nowIso: string,
): boolean {
  if (!lastContactAt) return false;
  const last = new Date(lastContactAt).getTime();
  if (!Number.isFinite(last)) return false;
  const elapsedDays = (new Date(nowIso).getTime() - last) / (24 * 3600 * 1000);
  return elapsedDays >= config.followUpRevivalDays;
}

/** 回访原因的中文说明（日志与视图统一用这一套，避免各写各的） */
const SKIP_LABELS: Readonly<Record<FollowUpSkipReason, string>> = {
  disabled: "回访未启用",
  chat_off: "这位的「自动聊天」是关的（引擎不会主动开口）",
  contact_off: "该联系人已关闭定时回访（不主动追；产品已下线）",
  stopped: "该联系人已停止",
  replied: "对方已回复，回访停止",
  not_due: "尚未到期",
  round_exhausted: "本轮回访次数已用尽",
  no_new_angle: "没有新角度，本轮不发",
  daily_cap: "已达当日发送上限（0 = 不限）",
  quiet_hours: "处于静默时段",
};

export function followUpSkipLabel(reason: FollowUpSkipReason): string {
  return SKIP_LABELS[reason] ?? reason;
}

/**
 * 「首次开场」还是「回访」——两者**不是一回事**，不能共用一条通道（§0.5.3 H）。
 *
 * - **开场**：引擎从没主动发过话（`lastContactAt` 空且 `followUpIndex === 0`）。
 *   用户把这个人放进「要聊的人」，要的就是这一句；它不该等 48 小时，也不该被
 *   「定时回访」（对方没回时要不要再追）拦下 —— 拦住就等于「选了人却永远不说话」。
 * - **回访**：已经主动发过话、对方没回，隔几天再找一次（频率、轮次、冷却、静默时段都在这条路上）。
 *
 * 纯函数：只读耐久事实（`visit.json` 经装配层注入），同输入必得同输出。
 */
export function isColdOpening(state: FollowUpState): boolean {
  if (state.followUpIndex > 0) return false;
  return !state.lastContactAt;
}
