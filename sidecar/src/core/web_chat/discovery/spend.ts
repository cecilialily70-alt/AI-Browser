/**
 * 花费账本（**只显示，不自动停机**）
 *
 * 四个桶，对应计划 §7 的口径：
 *   - `read`   **永远 0 token** —— 读会话/读列表全部由脚本从 DOM 直接取，不过模型；
 *   - `draft`  生成回复草稿（现有草稿槽）；
 *   - `memory` 记忆维护（滚动摘要 / 长期事实压缩，走极速文本槽）；
 *   - `infer`  接口分析（学一份描述符，走推理槽；一次性）。
 *
 * 纪律：**不做超限自动停止**（停由用户点）。所以本模块只累加与汇总，没有任何「闸门」。
 * 拿不到回执时如实记 `null`/`0`，不假装「这次没花钱」（§0.5.3 A 静默降级）。
 */

import type { SpendBucket, SpendEntry, SpendLedger } from "./types.js";

export const SPEND_BUCKETS: readonly SpendBucket[] = ["read", "draft", "memory", "infer"] as const;

const BUCKET_LABEL: Record<SpendBucket, string> = {
  read: "读取",
  draft: "草稿",
  memory: "记忆维护",
  infer: "接口分析",
};

export function emptyLedger(): SpendLedger {
  return { today: [], slice: [], byThread: {} };
}

function blankEntry(bucket: SpendBucket): SpendEntry {
  return { bucket, calls: 0, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 };
}

export function addSlice(ledger: SpendLedger, bucket: SpendBucket, delta: Omit<SpendEntry, "bucket">): SpendLedger {
  return { ...ledger, slice: bump(ledger.slice, bucket, delta) };
}

export function addThread(
  ledger: SpendLedger,
  threadKey: string,
  bucket: SpendBucket,
  delta: Omit<SpendEntry, "bucket">,
): SpendLedger {
  const key = String(threadKey ?? "").trim();
  if (!key) return ledger;
  return { ...ledger, byThread: { ...ledger.byThread, [key]: bump(ledger.byThread[key] ?? [], bucket, delta) } };
}

function bump(entries: readonly SpendEntry[], bucket: SpendBucket, delta: Omit<SpendEntry, "bucket">): SpendEntry[] {
  const out = entries.map((entry) => ({ ...entry }));
  let target = out.find((entry) => entry.bucket === bucket);
  if (!target) {
    target = blankEntry(bucket);
    out.push(target);
  }
  target.calls += Math.max(0, Math.round(delta.calls));
  target.promptTokens += Math.max(0, Math.round(delta.promptTokens));
  target.completionTokens += Math.max(0, Math.round(delta.completionTokens));
  target.costMicroUsd += Math.max(0, Math.round(delta.costMicroUsd));
  // **不在这里补空桶**：补空桶是显示层的事（`normalizeEntries`）。账本本身只记「花过什么」，
  // 否则「按联系人看的第一个桶」永远是 `read`（恒 0），没人看得出这个人到底花在草稿还是记忆上。
  return out;
}

/** 新的一片值守开始：清「本次值守」，但**不动**按联系人 */
export function resetSlice(ledger: SpendLedger): SpendLedger {
  return { ...ledger, slice: [] };
}

export interface SpendTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
}

export function totalsOf(entries: readonly SpendEntry[]): SpendTotals {
  const totals: SpendTotals = { calls: 0, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 };
  for (const entry of entries) {
    totals.calls += entry.calls;
    totals.promptTokens += entry.promptTokens;
    totals.completionTokens += entry.completionTokens;
    totals.costMicroUsd += entry.costMicroUsd;
  }
  return totals;
}

/** 补齐四个桶（视图四栏永远都在，不因为「这个桶还没花过」就少一栏） */
export function normalizeEntries(entries: readonly SpendEntry[]): SpendEntry[] {
  return SPEND_BUCKETS.map((bucket) => {
    const found = entries.find((entry) => entry.bucket === bucket);
    return found ? { ...found } : blankEntry(bucket);
  });
}

/** 微美元 → 人话（视图用同一套，别在前端再写一遍格式） */
export function formatMicroUsd(microUsd: number): string {
  const value = Number.isFinite(microUsd) ? Math.max(0, microUsd) : 0;
  if (value < 1000) return `$${(value / 1_000_000).toFixed(6)}`;
  return `$${(value / 1_000_000).toFixed(4)}`;
}

export interface SpendReportRow {
  bucket: SpendBucket;
  label: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costText: string;
}

/** 视图四栏（`read` 桶永远显示 0 token —— 这是设计，不是没测到） */
export function spendReport(entries: readonly SpendEntry[]): SpendReportRow[] {
  return normalizeEntries(entries).map((entry) => ({
    bucket: entry.bucket,
    label: BUCKET_LABEL[entry.bucket],
    calls: entry.calls,
    promptTokens: entry.bucket === "read" ? 0 : entry.promptTokens,
    completionTokens: entry.bucket === "read" ? 0 : entry.completionTokens,
    costText: formatMicroUsd(entry.costMicroUsd),
  }));
}
