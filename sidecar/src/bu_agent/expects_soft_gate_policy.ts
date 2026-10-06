/**
 * Plan Expects soft-gate 政策加载（P0.2）。
 *
 * 裁决纯函数在 `plan_expects.ts`；本模块只负责读配置，保持 plan_expects 零 I/O。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";
import { DEFAULT_EXPECTS_SOFT_GATE_STREAK } from "./plan_expects.js";

export interface ExpectsSoftGatePolicy {
  consecutiveViolationsToReplan: number;
}

export const DEFAULT_EXPECTS_SOFT_GATE_POLICY: ExpectsSoftGatePolicy = {
  consecutiveViolationsToReplan: DEFAULT_EXPECTS_SOFT_GATE_STREAK,
};

let cached: ExpectsSoftGatePolicy | undefined;

function policyCandidates(): string[] {
  const env = readAppEnv("EXPECTS_SOFT_GATE_POLICY");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/expects_soft_gate.json"));
  out.push(join(here, "../../../config/expects_soft_gate.json"));
  out.push(join(process.cwd(), "config", "expects_soft_gate.json"));
  out.push(join(process.cwd(), "sidecar", "config", "expects_soft_gate.json"));
  return out;
}

export function resolveExpectsSoftGatePolicyPath(): string | null {
  for (const candidate of policyCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* 单个候选异常不阻断 */
    }
  }
  return null;
}

function parseThreshold(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const clamped = Math.floor(n);
  if (clamped < 1 || clamped > 10) return null;
  return clamped;
}

export function loadExpectsSoftGatePolicy(): ExpectsSoftGatePolicy {
  if (cached) return cached;

  let threshold = DEFAULT_EXPECTS_SOFT_GATE_POLICY.consecutiveViolationsToReplan;
  const path = resolveExpectsSoftGatePolicyPath();
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const fromFile = parseThreshold(parsed.consecutiveViolationsToReplan);
      if (fromFile) threshold = fromFile;
    } catch {
      /* 坏文件 → 默认 */
    }
  }

  const envThreshold = parseThreshold(readAppEnv("EXPECTS_SOFT_GATE_STREAK"));
  if (envThreshold) threshold = envThreshold;

  cached = { consecutiveViolationsToReplan: threshold };
  return cached;
}

/** 测试用：清空缓存，使下次 load 重新读盘/环境。 */
export function resetExpectsSoftGatePolicyCache(): void {
  cached = undefined;
}
