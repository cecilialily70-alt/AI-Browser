/**
 * 发送节奏护栏（§5 · P2）
 *
 * **它只为防封号，不为省钱，而且不含任何每日上限。**
 * 站点看的不是「你今天回了几条」，而是「回得多快、多机械」：两条消息之间零间隔、
 * 收到 500 字长文 200ms 就回、整点准时发 —— 这些才是机器人特征。
 *
 * 三条纪律：
 *   1. **抖动是确定性的**（由 `线程 key` 派生，不是 `Math.random`）：行为上不像机器，
 *      但同一线程同一场景每次算出的值都一样 —— 可复现、可测试（§0.5.3 F「随机当唯一」的反面）。
 *   2. **不做上限**：这里只算「该等多久」，绝不产生「今天不能再发了」这种结论
 *      （唯一保留的上限是跨线程 `maxPerDay`，且配成 `0` 即「不限」）。
 *   3. **纯函数、无 I/O、无时钟依赖**：`now` 一律由调用方传入。
 */
import { hash32 } from "../hash32.js";

export interface PacingConfig {
  /** 同线程两条消息之间的最小间隔（ms）；`0` = 不限制 */
  minSendIntervalMs: number;
  /** 阅读延迟：对方每条消息每字加多少 ms（0 = 不加） */
  readDelayPerCharMs: number;
  /** 阅读延迟上限（ms）：再长的长文也不至于看到天亮 */
  readDelayMaxMs: number;
  /** 抖动比例（0~0.5）：在上面两项上叠一层确定性抖动 */
  jitterRatio: number;
}

/**
 * 默认值（都可配）。
 *
 * 依据：IM 中位回复时间 15s、92% 在 5 分钟内回 —— 人不是「收到就回」。
 * 所以最小间隔取 2s（不是 0），阅读延迟按字数给（上限 4s），抖动 ±20%。
 */
export const DEFAULT_PACING: PacingConfig = {
  minSendIntervalMs: 4_000,
  readDelayPerCharMs: 45,
  readDelayMaxMs: 14_000,
  jitterRatio: 0.25,
};

export type PacingWaitReason = "none" | "min_interval" | "read_delay";

export interface PacingWait {
  /** 该等多久再发（0 = 立刻） */
  waitMs: number;
  /** 为什么等（日志与视图用同一套说法，不是沉默地拖时间） */
  reason: PacingWaitReason;
  /** 抖动前的基础时长（排查用：能看出「等这么久」是配置还是抖动造成的） */
  baseMs: number;
}

/** 确定性抖动系数：同 `key + salt` 永远同一值（落在 [1-ratio, 1+ratio]） */
export function pacingJitter(key: string, salt: string, ratio: number): number {
  const bound = Math.max(0, Math.min(0.5, Number.isFinite(ratio) ? ratio : 0));
  if (bound === 0) return 1;
  const unit = (hash32(`${key}|${salt}`) % 1000) / 1000;
  return 1 + (unit * 2 - 1) * bound;
}

/**
 * 阅读延迟：按「对方这轮说了多少字」给一点缓冲（封顶在 `readDelayMaxMs`）。
 *
 * 只按**对方**的字数算 —— 我方要发的字数跟「读了多久」没关系；
 * 附件/非文字消息（无文本）按 1 个字符算，不给零延迟（「图都不看就秒回」也很假）。
 */
export function readDelayMs(incomingText: string, config: PacingConfig = DEFAULT_PACING): number {
  const perChar = Math.max(0, config.readDelayPerCharMs);
  const max = Math.max(0, config.readDelayMaxMs);
  if (perChar === 0 || max === 0) return 0;
  const chars = Math.max(1, [...String(incomingText ?? "")].length);
  return Math.min(max, Math.round(chars * perChar));
}

/**
 * 本轮发送前该等多久（纯函数）。
 *
 * - `minSendIntervalMs`：同线程两条之间的硬间隔（按 `lastSentAt` 算，只看**我方**发出时间）；
 * - `readDelayMs`：这轮要回的话有多长；
 * - 两者取**较大者**（不是相加）：相加会让「刚发完又收到长文」等两倍时间，过于拖沓；
 * - 最后叠确定性抖动，并保证结果非负、有限。
 *
 * **不产生任何否决**：即使算出 0 也只是「立刻发」。是否发由 `gateSend` / `planFollowUp` 决定。
 */
export function planSendWait(input: {
  /** 线程 key（抖动来源；同线程稳定） */
  threadKey: string;
  /** 当前时刻（ms） */
  now: number;
  /** 我方上次发出的时刻（ms）；`null` = 没发过 */
  lastSentAt: number | null;
  /** 对方这轮说的（拼接后的）文本，用于算阅读延迟 */
  incomingText: string;
  config?: PacingConfig;
}): PacingWait {
  const config = input.config ?? DEFAULT_PACING;
  const minInterval = Math.max(0, Number.isFinite(config.minSendIntervalMs) ? config.minSendIntervalMs : 0);
  const readDelay = readDelayMs(input.incomingText, config);

  let baseMs = 0;
  let reason: PacingWaitReason = "none";

  if (readDelay > 0) {
    baseMs = readDelay;
    reason = "read_delay";
  }

  if (minInterval > 0 && input.lastSentAt !== null && Number.isFinite(input.lastSentAt)) {
    const elapsed = Math.max(0, input.now - input.lastSentAt);
    const remaining = minInterval - elapsed;
    if (remaining > baseMs) {
      baseMs = remaining;
      reason = "min_interval";
    }
  }

  if (baseMs <= 0) return { waitMs: 0, reason: "none", baseMs: 0 };

  const jittered = Math.round(baseMs * pacingJitter(input.threadKey, "send", config.jitterRatio));
  return { waitMs: Math.max(0, jittered), reason, baseMs: Math.round(baseMs) };
}

/** 把对方这轮的文本拼成「阅读延迟」的输入（附件按空串，由 {@link readDelayMs} 兜成 1 字） */
export function incomingTextOf(messages: readonly { text: string }[]): string {
  return messages.map((message) => String(message.text ?? "")).join("\n");
}

/** 从用户配置片段解析节奏：**永不抛**；坏值回落默认并写进 `diagnostics`（不静默降级） */
export function parsePacingConfig(raw: unknown, diagnostics: string[] = []): PacingConfig {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (key: string, fallback: number, min: number, max: number, label: string): number => {
    const value = Number(source[key]);
    if (source[key] === undefined || source[key] === null || source[key] === "") return fallback;
    if (!Number.isFinite(value)) {
      diagnostics.push(`${label}不是数字，已用默认值 ${fallback}`);
      return fallback;
    }
    if (value < min || value > max) {
      diagnostics.push(`${label}超出范围，已收窄到 ${min}–${max}`);
      return Math.min(max, Math.max(min, value));
    }
    return value;
  };
  return {
    minSendIntervalMs: num("minSendIntervalMs", DEFAULT_PACING.minSendIntervalMs, 0, 60_000, "同线程最小发送间隔（毫秒）"),
    readDelayPerCharMs: num("readDelayPerCharMs", DEFAULT_PACING.readDelayPerCharMs, 0, 500, "阅读延迟（每字毫秒）"),
    readDelayMaxMs: num("readDelayMaxMs", DEFAULT_PACING.readDelayMaxMs, 0, 60_000, "阅读延迟上限（毫秒）"),
    jitterRatio: num("jitterRatio", DEFAULT_PACING.jitterRatio, 0, 0.5, "抖动比例"),
  };
}
