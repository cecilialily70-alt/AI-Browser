/**
 * 决策记录 `decision.jsonl`（对应 §0.5.3「幽灵 AI 决策」）
 *
 * 没有它，「它当时为什么这么说」无法复盘，只能猜。每条草稿/分析/自检/保存都落一条：
 * 草稿 id、本轮 inbound 的 id 集合、用到的摘要代数、角度、被拒原因、最终发/不发。
 *
 * 两条纪律：
 *   1. **落在该环境的 `chat_context` 之内**，不落全局目录（§0.5.3 J 的串号教训：
 *      全局目录会让「删掉环境再新建」继承上一份记忆）。
 *   2. **只落指纹与判定**：id 集合、原因、花费；**绝不落消息正文**（R2 / §1.3）。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import type { DecisionRecord } from "./types.js";

/** 单文件上限（轮转阈值）：超过就把当前文件滚成 `.1.jsonl` 并重开 */
export const DECISION_MAX_BYTES = 2 * 1024 * 1024;

/** 最多保留几个历史分片（滚更多没有意义，只会占磁盘） */
export const DECISION_MAX_SEGMENTS = 2;

export function decisionLogPath(chatContextDir: string): string {
  return join(chatContextDir, "decision.jsonl");
}

/** 一条记录 → 一行 JSON（**过滤未定义字段**，免得 jsonl 里出现 `undefined` 字面量） */
export function serializeDecision(record: DecisionRecord): string {
  const clean: Record<string, unknown> = {
    at: record.at,
    kind: record.kind,
    outcome: record.outcome,
    reason: record.reason ?? null,
  };
  if (record.threadKey) clean.threadKey = record.threadKey;
  if (record.inboundIds && record.inboundIds.length > 0) clean.inboundIds = record.inboundIds.slice(0, 200);
  if (record.summaryGeneration !== undefined) clean.summaryGeneration = record.summaryGeneration;
  if (record.angle) clean.angle = record.angle;
  if (record.costMicroUsd !== undefined && record.costMicroUsd !== null) clean.costMicroUsd = record.costMicroUsd;
  return JSON.stringify(clean);
}

/**
 * 轮转：超过阈值就把 `decision.jsonl` → `decision.1.jsonl`（旧的依次后移，超出保留数即删）。
 *
 * 为什么不用「按天切」：值守是断续的，按天切会在长跑场景下无限增长；
 * 按字节切与「上限」这个目的直接对应。
 */
export function rotateDecisionLog(dir: string, maxBytes = DECISION_MAX_BYTES, maxSegments = DECISION_MAX_SEGMENTS): boolean {
  const current = decisionLogPath(dir);
  if (!existsSync(current)) return false;
  let size = 0;
  try {
    size = statSync(current).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;

  // 旧分片依次右移，最老的一片直接删（保留数有限，否则磁盘无上限）
  for (let index = maxSegments; index >= 1; index -= 1) {
    const target = join(dir, `decision.${index}.jsonl`);
    if (existsSync(target)) {
      if (index === maxSegments) rmSync(target, { force: true });
      else renameSync(target, join(dir, `decision.${index + 1}.jsonl`));
    }
  }
  renameSync(current, join(dir, "decision.1.jsonl"));
  return true;
}

export interface AppendDecisionResult {
  path: string;
  rotated: boolean;
}

/** 追加一条决策记录（自动轮转；目录不存在就创建） */
export function appendDecision(
  dir: string,
  record: DecisionRecord,
  maxBytes = DECISION_MAX_BYTES,
): AppendDecisionResult {
  mkdirSync(dir, { recursive: true });
  const rotated = rotateDecisionLog(dir, maxBytes);
  const path = decisionLogPath(dir);
  appendFileSync(path, `${serializeDecision(record)}\n`, "utf8");
  return { path, rotated };
}

/** 读回（**对损坏行容错**：一行坏不毁整份记录；视图与用例都要能看到内容） */
export function readDecisions(dir: string, limit = 200): DecisionRecord[] {
  const path = decisionLogPath(dir);
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: DecisionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as DecisionRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") out.push(parsed);
    } catch {
      /* 损坏行跳过：一条坏行不该让整份决策记录不可读 */
    }
  }
  return out.slice(-Math.max(1, limit));
}

/** 决策目录里有几个分片（清理与自检用） */
export function listDecisionSegments(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => /^decision(\.\d+)?\.jsonl$/.test(name));
  } catch {
    return [];
  }
}
