/**
 * Arbiter 运行时政策（P0.1）：影子 / 引导 / 硬闸 三档。
 *
 * 纯配置加载，不做裁决。裁决仍在 `arbiter.ts`；本模块只回答「裁决结果是否改主循环行为」。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";

export type ArbiterMode = "shadow" | "guide" | "hard";

export interface ArbiterPolicy {
  mode: ArbiterMode;
}

export const DEFAULT_ARBITER_POLICY: ArbiterPolicy = {
  mode: "guide",
};

const MODES = new Set<ArbiterMode>(["shadow", "guide", "hard"]);

let cached: ArbiterPolicy | undefined;

function policyCandidates(): string[] {
  const env = readAppEnv("ARBITER_POLICY");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/arbiter_policy.json"));
  out.push(join(here, "../../../config/arbiter_policy.json"));
  out.push(join(process.cwd(), "config", "arbiter_policy.json"));
  out.push(join(process.cwd(), "sidecar", "config", "arbiter_policy.json"));
  return out;
}

export function resolveArbiterPolicyPath(): string | null {
  for (const candidate of policyCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* 单个候选异常不阻断 */
    }
  }
  return null;
}

function parseMode(raw: unknown): ArbiterMode | null {
  if (typeof raw !== "string") return null;
  const mode = raw.trim().toLowerCase() as ArbiterMode;
  return MODES.has(mode) ? mode : null;
}

function planConflictHitlNudge(reason: string, violations: string[], channel: string): string {
  const detail = (violations[0] ?? reason).slice(0, 180);
  return (
    `【Arbiter·计划矛盾】页面事实与当前计划项期望不符：${detail}。` +
    `${channel}，禁止静默继续。请立即 plan_update 修正计划，或 ask_user / handover_to_human 请人确认；禁止重复原动作空转。`
  );
}

/** Consult 未就绪时 escalate 的模板兜底文案（P1.4 HITL 情境文案在 ask/handover 出口再生成）。 */
export function arbiterEscalateHitlNudge(reason: string, violations: string[]): string {
  return planConflictHitlNudge(reason, violations, "Consult 通道未就绪");
}

/** Consult 已尝试但失败：仍回落同一 HITL，禁止当成「没矛盾」继续。 */
export function arbiterConsultFailedHitlNudge(reason: string, violations: string[]): string {
  return planConflictHitlNudge(reason, violations, "Consult 咨询失败，已回落人工确认");
}

export function loadArbiterPolicy(): ArbiterPolicy {
  if (cached) return cached;

  let mode = DEFAULT_ARBITER_POLICY.mode;
  const path = resolveArbiterPolicyPath();
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const fromFile = parseMode(parsed.mode);
      if (fromFile) mode = fromFile;
    } catch {
      /* 坏文件 → 默认 guide */
    }
  }

  const envMode = parseMode(readAppEnv("ARBITER_MODE"));
  if (envMode) mode = envMode;

  cached = { mode };
  return cached;
}

/** 测试用：清空缓存，使下次 load 重新读盘/环境。 */
export function resetArbiterPolicyCache(): void {
  cached = undefined;
}

export function isArbiterAuthoritative(mode: ArbiterMode): boolean {
  return mode === "guide" || mode === "hard";
}
