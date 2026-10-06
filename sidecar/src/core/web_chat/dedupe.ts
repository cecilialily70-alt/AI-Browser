/**
 * 语义去重（§11）—— 对「只会重复同一句话」这个原始故障的**系统级硬拦**
 *
 * 只用提示词要求「不要重复」是不可靠的（§0.5.3 H：复读不拦）。这里在**发送之前**做机器判定：
 *   归一化（去空白/标点/emoji，数字→`#`）
 *   → 中文 2-gram 与 3-gram 的 Jaccard 相似度
 *   → 命中任一即**拒发**：Jaccard ≥ 阈值（默认 0.62）**或**归一化文本开头 8 字完全相同。
 *
 * 拒发不是终点：把「你已说过：<原句>」回传给模型强制换角度重写；连续多次仍重复则由引擎
 * 放弃本轮并如实记 `chat_draft_rejected`（绝不硬发）。
 *
 * 比较集**只含我方已发出的文本**（§11：同线程最近 20 条 + 跨线程最近 50 条）——
 * 对方的原话不参与，否则正常回应也可能被误判成复读。
 *
 * 纯函数、无 I/O，可无浏览器单测。
 */
import { normalizeForEffect } from "./outbox.js";

/** 归一化（在「幂等键归一化」基础上把数字折叠成 `#`：换了个价格数字不算新话术） */
export function normalizeForDedupe(text: string): string {
  return normalizeForEffect(text).replace(/\d+/g, "#");
}

/** 默认相似度阈值 */
export const DEDUPE_DEFAULT_THRESHOLD = 0.62;
/** 默认「开头相同」判定长度 */
export const DEDUPE_PREFIX_LENGTH = 8;
/** 同线程比较集上限 */
export const DEDUPE_THREAD_LIMIT = 20;
/** 跨线程比较集上限 */
export const DEDUPE_CROSS_LIMIT = 50;
/** 连续被拒上限：达到即放弃本轮（引擎据此记 `chat_draft_rejected`） */
export const MAX_DEDUPE_ATTEMPTS = 3;

function ngramSet(text: string, n: number): Set<string> {
  const out = new Set<string>();
  if (text.length < n) {
    if (text.length > 0) out.add(text);
    return out;
  }
  for (let i = 0; i + n <= text.length; i += 1) out.add(text.slice(i, i + n));
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

export type DedupeReason = "empty" | "prefix_match" | "similar";

export interface DedupeDecision {
  duplicate: boolean;
  reason: DedupeReason | null;
  /** 2-gram / 3-gram 里较高的那个相似度（拒发时为触发值） */
  similarity: number;
  /** 命中的历史原句（用于回传「你已说过：…」） */
  matched: string | null;
  /** 命中时给模型的强制重写指令；未命中为 null */
  rewriteHint: string | null;
}

export interface DedupeHistory {
  /** 同一联系人已发出的文本（近 → 远或远 → 近都可，内部按上限截取） */
  thread: readonly string[];
  /** 其它联系人已发出的文本（防止跨线程也复读同一段话术） */
  cross: readonly string[];
}

export interface DedupeOptions {
  threshold?: number;
  prefixLength?: number;
  threadLimit?: number;
  crossLimit?: number;
}

const NOT_DUPLICATE: DedupeDecision = {
  duplicate: false,
  reason: null,
  similarity: 0,
  matched: null,
  rewriteHint: null,
};

/**
 * 判定一段草稿是否与历史重复。
 *
 * @param draft 待发送文本
 * @param history 只含**我方**已发文本
 */
export function checkDuplicate(
  draft: string,
  history: DedupeHistory,
  options: DedupeOptions = {},
): DedupeDecision {
  const threshold = options.threshold ?? DEDUPE_DEFAULT_THRESHOLD;
  const prefixLength = options.prefixLength ?? DEDUPE_PREFIX_LENGTH;
  const threadLimit = options.threadLimit ?? DEDUPE_THREAD_LIMIT;
  const crossLimit = options.crossLimit ?? DEDUPE_CROSS_LIMIT;

  const normalizedDraft = normalizeForDedupe(draft);
  if (!normalizedDraft) {
    return { ...NOT_DUPLICATE, duplicate: true, reason: "empty", rewriteHint: "草稿为空：请重新生成一条有实际内容的话" };
  }

  const candidates = [
    ...history.thread.slice(-Math.max(0, threadLimit)),
    ...history.cross.slice(-Math.max(0, crossLimit)),
  ].filter((text) => normalizeForDedupe(text).length > 0);

  const draft2 = ngramSet(normalizedDraft, 2);
  const draft3 = ngramSet(normalizedDraft, 3);

  let best = 0;
  let bestMatched: string | null = null;

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeForDedupe(candidate);

    // 规则一：开头完全相同（只在双方都够长时才用，避免短句被误判）
    if (
      normalizedDraft.length >= prefixLength &&
      normalizedCandidate.length >= prefixLength &&
      normalizedDraft.slice(0, prefixLength) === normalizedCandidate.slice(0, prefixLength)
    ) {
      return {
        duplicate: true,
        reason: "prefix_match",
        similarity: 1,
        matched: candidate,
        rewriteHint: buildRewriteHint(candidate, "开头与已发出的内容完全相同"),
      };
    }

    // 规则二：2-gram / 3-gram Jaccard 取高者
    const similarity = Math.max(
      jaccard(draft2, ngramSet(normalizedCandidate, 2)),
      jaccard(draft3, ngramSet(normalizedCandidate, 3)),
    );
    if (similarity > best) {
      best = similarity;
      bestMatched = candidate;
    }
  }

  if (best >= threshold) {
    return {
      duplicate: true,
      reason: "similar",
      similarity: best,
      matched: bestMatched,
      rewriteHint: buildRewriteHint(bestMatched, `与已发出的内容相似度 ${best.toFixed(2)}`),
    };
  }

  return { duplicate: false, reason: null, similarity: Number(best.toFixed(3)), matched: null, rewriteHint: null };
}

function buildRewriteHint(matched: string | null, why: string): string {
  const quoted = matched ? matched.replace(/\s+/g, " ").slice(0, 60) : "（未知）";
  return [
    `被去重硬拦（${why}）：你已说过「${quoted}」。`,
    "请换一个**未用过的角度**并带上**新信息或新问题**重新生成；",
    "禁止改写原句、禁止换同义词复述、禁止只加语气词。",
  ].join("");
}

/** 连续被拒是否应放弃本轮（引擎据此落 `chat_draft_rejected`） */export function shouldGiveUpDraft(attempts: number, max = MAX_DEDUPE_ATTEMPTS): boolean {
  return attempts >= Math.max(1, max);
}

/** 从「我方已发流水」里抽出比较集：只保留 direction === "out" 的文本 */
export function collectSentTexts(
  messages: ReadonlyArray<{ direction: string; text: string }>,
  limit: number,
): string[] {
  const sent = messages.filter((m) => m.direction === "out").map((m) => m.text);
  return limit >= sent.length ? sent : sent.slice(sent.length - limit);
}
