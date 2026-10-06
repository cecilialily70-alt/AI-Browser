/**
 * Agent 工作记忆压缩：对齐聊天值守 `chat_memory` 的三条硬规则，
 * 但不调模型（执行器循环不因此变成第二套 ReAct）。
 *
 * 1. 只把即将退出热窗口的**原始步骤**拼进记忆，禁止拿摘要再总结摘要。
 * 2. 代数到顶后只丢热窗口外的步骤，不再改 compactedMemory。
 * 3. 记忆正文只裁最旧部分。
 */
import {
  clampSummary,
  decideCompact,
  DEFAULT_MEMORY_CONFIG,
} from "../core/web_chat/chat_memory.js";
import type { HistoryItem } from "./views.js";

export const AGENT_HISTORY_HOT_MAX = 24;
export const AGENT_COMPACT_MAX_CHARS = 1400;
export const AGENT_COMPACT_MAX_GENERATIONS = 60;

export function formatDroppedHistory(items: readonly HistoryItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const actions = (item.actions ?? []).map((action) => action.name).filter(Boolean).join(",");
    const bits = [
      `#${item.stepNumber}`,
      item.evaluationPreviousGoal,
      item.memory,
      item.nextGoal,
      actions,
    ]
      .map((part) => String(part ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (bits.length) {
      lines.push(bits.join(" · ").slice(0, 280));
    }
  }
  return lines.join("\n").trim();
}

export function mergeExtractiveMemory(input: {
  previous: string | null;
  dropped: readonly HistoryItem[];
  generations: number;
}): { text: string | null; generations: number; compacted: boolean } {
  const dropped = input.dropped.filter(Boolean);
  const generations = Math.max(0, Math.trunc(input.generations));
  const decision = decideCompact({
    totalMessages: dropped.length,
    uncoveredMessages: dropped.length,
    generations,
    config: {
      ...DEFAULT_MEMORY_CONFIG,
      compactAfterMessages: 1,
      summaryMaxChars: AGENT_COMPACT_MAX_CHARS,
      maxGenerations: AGENT_COMPACT_MAX_GENERATIONS,
    },
  });
  if (!decision.needed || dropped.length === 0) {
    return { text: input.previous, generations, compacted: false };
  }
  if (!decision.requiresLlm) {
    return { text: input.previous, generations, compacted: false };
  }
  const chunk = formatDroppedHistory(dropped);
  if (!chunk) {
    return { text: input.previous, generations, compacted: false };
  }
  const merged = [String(input.previous ?? "").trim(), chunk].filter(Boolean).join("\n");
  return {
    text: clampSummary(merged, AGENT_COMPACT_MAX_CHARS),
    generations: generations + 1,
    compacted: true,
  };
}
