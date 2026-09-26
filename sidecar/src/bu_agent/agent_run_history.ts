/**
 * P4.3 — Agent Run History（与「录制轨迹」解耦）
 *
 * 每次 Agent 起止强制落摘要：goal / profile / 结果 / 步数 / 是否 HITL / 可选轨迹 id。
 * 密钥与 OTP 在写入前脱敏；禁止把一次性码写进 run history。
 */
import { randomUUID } from "node:crypto";

import { redactSecretText } from "../secret_redaction.js";
import {
  classifyRunFailure,
  nonnegInt,
  sanitizeFailureCounts,
  sanitizeLlmModelId,
} from "./run_cost.js";

export const AGENT_RUN_THOUGHT_MAX = 80;
export const AGENT_RUN_THOUGHT_LINE_MAX = 200;
/**
 * 交付物正文上限。summary 是「这次任务到底交付了什么」——信息型任务（总结/分析）里
 * 它本身就是交付物，截断等于交付残缺。思考流保持 200 短行，交付物单独放宽。
 */
export const AGENT_RUN_SUMMARY_MAX = 8000;

/** 验证码/OTP 邻近数字串：遮蔽值，保留语境词便于排障。 */
const OTP_NEAR_RE =
  /((?:验证码|校验码|动态码|短信码|邮箱码|one[-\s]?time|otp|totp|2fa|sms\s*code|email\s*code|auth(?:entication)?\s*code)\s*[:：=]?\s*)([0-9A-Za-z]{4,12})/gi;

export type AgentRunStatus = "running" | "complete" | "failed" | "aborted";

export interface AgentRunThoughtLine {
  ts: string;
  text: string;
}

export interface AgentRunStartPayload {
  runId: string;
  profileId: string;
  goal: string;
  startUrl: string;
  domain: string;
  status: "running";
  phase: "agent_run_start";
}

export interface AgentRunFinishPayload {
  runId: string;
  profileId: string;
  goal: string;
  startUrl: string;
  domain: string;
  status: "complete" | "failed" | "aborted";
  success: boolean;
  summary: string;
  stepCount: number;
  hitlOccurred: boolean;
  trajectoryId?: number | null;
  thoughtSummary: AgentRunThoughtLine[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  llmCalls: number;
  llmModel: string;
  costUsedDefaultRate: boolean;
  failureClass: string;
  failureCounts: Record<string, number>;
  phase: "agent_run_finish";
}

export function createAgentRunId(): string {
  return randomUUID();
}

/** 脱敏 thought / summary：密钥形态 + OTP 邻近码。 */
export function sanitizeRunHistoryText(raw: string, maxLen = AGENT_RUN_THOUGHT_LINE_MAX): string {
  let text = redactSecretText(String(raw ?? ""));
  text = text.replace(OTP_NEAR_RE, (_m, prefix: string) => `${prefix}***`);
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}…`;
}

export function appendThoughtLine(
  lines: AgentRunThoughtLine[],
  message: string,
  max = AGENT_RUN_THOUGHT_MAX,
): void {
  const text = sanitizeRunHistoryText(message);
  if (!text) {
    return;
  }
  lines.push({ ts: new Date().toISOString(), text });
  if (lines.length > max) {
    lines.splice(0, lines.length - max);
  }
}

export function buildAgentRunStartPayload(input: {
  runId: string;
  profileId: string;
  goal: string;
  startUrl: string;
  domain: string;
}): AgentRunStartPayload {
  return {
    runId: input.runId,
    profileId: input.profileId,
    goal: sanitizeRunHistoryText(input.goal, 400),
    startUrl: String(input.startUrl ?? "").trim().slice(0, 500),
    domain: String(input.domain ?? "").trim().slice(0, 200),
    status: "running",
    phase: "agent_run_start",
  };
}

export function buildAgentRunFinishPayload(input: {
  runId: string;
  profileId: string;
  goal: string;
  startUrl: string;
  domain: string;
  success: boolean;
  status?: "complete" | "failed" | "aborted";
  summary: string;
  stepCount: number;
  hitlOccurred: boolean;
  trajectoryId?: number | null;
  thoughtSummary: AgentRunThoughtLine[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostMicroUsd?: number;
  llmCalls?: number;
  llmModel?: string;
  costUsedDefaultRate?: boolean;
  failureCounts?: unknown;
}): AgentRunFinishPayload {
  const status =
    input.status ?? (input.success ? "complete" : "failed");
  const failureCounts = sanitizeFailureCounts(input.failureCounts);
  const hitlOccurred = input.hitlOccurred === true;
  const success = input.success === true;
  return {
    runId: input.runId,
    profileId: input.profileId,
    goal: sanitizeRunHistoryText(input.goal, 400),
    startUrl: String(input.startUrl ?? "").trim().slice(0, 500),
    domain: String(input.domain ?? "").trim().slice(0, 200),
    status,
    success,
    summary: sanitizeRunHistoryText(input.summary, AGENT_RUN_SUMMARY_MAX),
    stepCount: Math.max(0, Math.floor(Number(input.stepCount) || 0)),
    hitlOccurred,
    trajectoryId: input.trajectoryId ?? null,
    thoughtSummary: (input.thoughtSummary ?? []).map((line) => ({
      ts: String(line.ts ?? ""),
      text: sanitizeRunHistoryText(line.text),
    })),
    promptTokens: nonnegInt(input.promptTokens),
    completionTokens: nonnegInt(input.completionTokens),
    totalTokens: nonnegInt(input.totalTokens),
    estimatedCostMicroUsd: nonnegInt(input.estimatedCostMicroUsd),
    llmCalls: nonnegInt(input.llmCalls),
    llmModel: sanitizeLlmModelId(input.llmModel),
    costUsedDefaultRate: input.costUsedDefaultRate === true,
    failureClass: classifyRunFailure({
      success,
      status,
      hitlOccurred,
      counts: failureCounts,
    }),
    failureCounts,
    phase: "agent_run_finish",
  };
}

/** 回归：摘要/thought 不得含常见明文 OTP。 */
export function runHistoryLooksClean(payload: {
  summary?: string;
  thoughtSummary?: AgentRunThoughtLine[];
  goal?: string;
  llmModel?: string;
  failureClass?: string;
  failureCounts?: Record<string, number>;
}): boolean {
  const blobs = [
    payload.summary ?? "",
    payload.goal ?? "",
    payload.llmModel ?? "",
    payload.failureClass ?? "",
    JSON.stringify(payload.failureCounts ?? {}),
    ...(payload.thoughtSummary ?? []).map((l) => l.text),
  ].join("\n");
  if (/验证码\s*[:：=]?\s*\d{4,8}/i.test(blobs)) {
    return false;
  }
  if (/\botp\s*[:：=]?\s*[0-9A-Za-z]{4,12}\b/i.test(blobs)) {
    return false;
  }
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(blobs)) {
    return false;
  }
  return true;
}
