/**
 * 幂等发件箱（§4.3）—— 聊天模式最关键的正确性防线
 *
 * 崩溃窗口是真实的：**已输入未发送**、**已发送未确认**。若不管，重启就会对同一个人重发，
 * 那就是刷屏（R7）。这里的纪律：
 *   - `effectId` 由**引擎**从 `线程 + 轮次 + 归一化文本` 派生（不用新 uuid，同轮重试得同一个 id）；
 *   - 先写 outbox（durable-before-return）再动页面；
 *   - 重启/续跑**先对账**：`pending` 且页面已能看到该文本 → 认定已发出，**不重发**；
 *   - `pending` 且页面看不到 → 只允许**一次**重试；
 *   - `unconfirmed` → **绝不自动重发**，交人工（歧义不可重放，§4.3）。
 *
 * 全文件纯函数、无 I/O（落盘在 `state.ts` / `context_store` 侧），因此可无浏览器单测。
 */
import { hash32Id } from "../hash32.js";

export type ChatOutboxStatus = "pending" | "sent" | "unconfirmed";

export interface ChatOutboxEntry {
  effectId: string;
  threadKey: string;
  /** 归一化文本的指纹（`hashText`），用于重启后与页面内容对账 */
  textHash: string;
  status: ChatOutboxStatus;
  /** 已尝试发送的次数（首次发送即为 1） */
  attempts: number;
  createdAt: string;
  lastAttemptAt: string;
  sentAt: string | null;
  note: string | null;
}

/** 一条消息最多尝试几次（首次 + 一次重试）；超过即交人工 */
export const MAX_SEND_ATTEMPTS = 2;

/**
 * 页面装饰（显示时间 / 已读勾）的**唯一口径**。
 *
 * 现场证据（§0.5.3 H）：Telegram Web K 把显示时间渲染在正文容器**内部**，
 * 读出来的正文长这样 —— `…聊聊吧。02:20 02:20`、`给我看看价格表00:1300:13`。
 * 后果有三层，一层比一层重：
 *   1. 台账 / 提示词里全是时间噪声（模型可能学着复读）；
 *   2. 去重与指纹把同一条消息算成两条；
 *   3. **我们认不出自己刚发的那条** → 被当成「不是我发的出站消息」→ 判用户接管 → 永久停手。
 *
 * 只剥**尾部连续 ≥2 个**装饰（`时间` / `勾`）：单个尾部时间可能是正文本身
 * （「明天 10:30 见」不能被削成「明天 见」）；而站点渲染出的装饰必然是**重复**的
 * （时间 + 勾各自渲染多次，上面两条现场文本都是成对出现）。
 */
const DECORATION_TAIL_RE =
  /(?:\s*(?:\d{1,2}:\d{2}|[\u2713\u2714\u2717\u2718\u2716\u00d7\ufe0f]|✓|✔)){2,}\s*$/u;

/** 剥掉尾部的页面装饰（时间 / 已读勾）。`outbox.hashText` 与读取器**共用**这一份（禁止各写一套） */
export function stripDecorationTail(text: string): string {
  const raw = String(text ?? "");
  return raw.replace(DECORATION_TAIL_RE, "").trim();
}

/** 归一化：折叠空白、去零宽、去标点与 emoji、转小写 —— 与展示文本解耦 */
export function normalizeForEffect(text: string): string {
  return stripDecorationTail(String(text ?? ""))
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\s\u3000]+/g, "")
    .replace(
      /[，。、；：！？,.;:!?"'`()[\]{}<>《》「」『』|~^*_+\-=/\\@#$%&·…—～]/g,
      "",
    )
    .replace(/[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}\ufe0f]/gu, "")
    .toLowerCase();
}

/**
 * 页面文本是否**就是我方发过的那条**（宽松比对，返回命中的那句原文，否则 `null`）。
 *
 * 为什么不能只比指纹（`hashText` 全等）：站点把时间戳 / 已读勾 / 装饰混进正文时，
 * 页面文本与草稿原文的指纹**永远对不上** —— 现场后果就是「自己发的那条被当成陌生人」。
 * 所以这里允许**归一化后的包含关系**（`页面` ⊇ `我方原文` 或反过来），
 * 但两侧都必须够长（`minChars`）：短文本的包含关系毫无区分度（「你好」会被「你好呀…」吞掉）。
 *
 * 只用于「这条出站是不是我发的」这类**我们自己的**内容比对；
 * 对方消息的去重另有其严格口径（`dedupe.ts`），不共用这条宽松规则。
 */
export function looksLikeOwnSentText(
  pageText: string,
  ownTexts: readonly string[],
  minChars = 8,
): string | null {
  const page = normalizeForEffect(pageText);
  if (page.length < minChars) return null;
  for (const own of ownTexts) {
    const mine = normalizeForEffect(own);
    if (mine.length < minChars) continue;
    if (page === mine || page.includes(mine) || mine.includes(page)) return String(own);
  }
  return null;
}

/** 内容指纹：重启后用它判断「这条到底发出去了没有」 */
export function hashText(text: string): string {
  return hash32Id(normalizeForEffect(text));
}

/** 幂等键：同线程同轮次同文本必须得到同一个 id（跨进程重启也一致） */
export function computeEffectId(threadKey: string, turnSeq: number, text: string): string {
  return hash32Id(`${String(threadKey).trim()}|${Math.trunc(turnSeq)}|${normalizeForEffect(text)}`);
}

export function findOutboxEntry(
  outbox: readonly ChatOutboxEntry[],
  effectId: string,
): ChatOutboxEntry | null {
  return outbox.find((entry) => entry.effectId === effectId) ?? null;
}

export type ChatSendDecision =
  | { action: "send"; reason: "new" | "retry"; attempts: number }
  | { action: "settle_sent"; reason: "reconciled_present" }
  | { action: "skip"; reason: "already_sent" }
  | { action: "hand_off"; reason: "unconfirmed" | "retry_exhausted" };

/**
 * 发送决策（纯函数）。`seenInPage` 由调用方用 `isEffectVisibleInPage` 在页面上回读得到。
 */
export function decideSend(
  entry: ChatOutboxEntry | null | undefined,
  opts: { seenInPage: boolean },
): ChatSendDecision {
  if (!entry) {
    return { action: "send", reason: "new", attempts: 1 };
  }
  switch (entry.status) {
    case "sent":
      return { action: "skip", reason: "already_sent" };
    case "unconfirmed":
      // 歧义即停：不猜、不重发（§4.3）
      return { action: "hand_off", reason: "unconfirmed" };
    case "pending":
    default:
      if (opts.seenInPage) {
        return { action: "settle_sent", reason: "reconciled_present" };
      }
      if (entry.attempts >= MAX_SEND_ATTEMPTS) {
        return { action: "hand_off", reason: "retry_exhausted" };
      }
      return { action: "send", reason: "retry", attempts: entry.attempts + 1 };
  }
}

/** 页面可见文本里能否找到这条消息（归一化后精确比对；找不到就老实说找不到） */
export function isEffectVisibleInPage(
  entry: Pick<ChatOutboxEntry, "textHash">,
  visibleTexts: readonly string[],
): boolean {
  return visibleTexts.some((text) => hashText(text) === entry.textHash);
}

/** 开始一次发送尝试：**必须在产生副作用之前**写好（durable-before-return） */
export function beginSend(
  effectId: string,
  threadKey: string,
  text: string,
  now: string,
  previous?: ChatOutboxEntry | null,
): ChatOutboxEntry {
  return {
    effectId,
    threadKey,
    textHash: hashText(text),
    status: "pending",
    attempts: (previous?.attempts ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    lastAttemptAt: now,
    sentAt: null,
    note: null,
  };
}

export function commitSent(entry: ChatOutboxEntry, now: string): ChatOutboxEntry {
  return { ...entry, status: "sent", sentAt: now, note: null };
}

/** 重试后仍无法确认 → 标 unconfirmed，交人工；**不改回 pending**，防止再被自动重发 */
export function markUnconfirmed(entry: ChatOutboxEntry, now: string, note: string): ChatOutboxEntry {
  return { ...entry, status: "unconfirmed", lastAttemptAt: now, note };
}

/** 按 effectId 覆盖式写入（同 id 只保留一条） */
export function upsertOutbox(
  outbox: readonly ChatOutboxEntry[],
  entry: ChatOutboxEntry,
): ChatOutboxEntry[] {
  const index = outbox.findIndex((item) => item.effectId === entry.effectId);
  if (index < 0) return [...outbox, entry];
  const next = [...outbox];
  next[index] = entry;
  return next;
}

/** 保留最近 N 条（审计流水另存 `outbox.jsonl`；快照只留判定所需） */
export function trimOutbox(outbox: readonly ChatOutboxEntry[], keep = 200): ChatOutboxEntry[] {
  if (outbox.length <= keep) return [...outbox];
  return outbox.slice(outbox.length - keep);
}

export interface OutboxReconcileResult {
  outbox: ChatOutboxEntry[];
  /** 因页面已存在而被判定「其实已发出」的条目 */
  settled: ChatOutboxEntry[];
  /** 需要人工确认的条目（绝不自动重发） */
  handOff: ChatOutboxEntry[];
}

/**
 * 续跑第一步**永远先对账**（§4.4）：把 `pending` 且页面确实存在的条目落成 `sent`，
 * 把重试耗尽的落成 `unconfirmed` 并交人工。**不在这里发任何消息。**
 */
export function reconcileOutbox(
  outbox: readonly ChatOutboxEntry[],
  visibleTexts: readonly string[],
  now: string,
): OutboxReconcileResult {
  const settled: ChatOutboxEntry[] = [];
  const handOff: ChatOutboxEntry[] = [];
  const next = outbox.map((entry) => {
    if (entry.status !== "pending") {
      if (entry.status === "unconfirmed") handOff.push(entry);
      return entry;
    }
    if (isEffectVisibleInPage(entry, visibleTexts)) {
      const sent = commitSent(entry, now);
      settled.push(sent);
      return sent;
    }
    if (entry.attempts >= MAX_SEND_ATTEMPTS) {
      const stuck = markUnconfirmed(entry, now, "重试耗尽且页面未见该消息");
      handOff.push(stuck);
      return stuck;
    }
    return entry;
  });
  return { outbox: next, settled, handOff };
}
