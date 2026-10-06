/**
 * P5.5：把已有 Consult 总线的 `plan_conflict` 接到 Arbiter escalate。
 *
 * 不新造总线，不调用其它路由。失败（超时 / 中止 / 预算 / 契约 / 未知错误）
 * 一律返回 HITL 回落，由主循环套用既有 ask_user / handover 文案。禁止抛回
 * Arbiter 的 fail-open catch（那会被记成「已忽略」）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redactSecretText } from "../secret_redaction.js";
import {
  ConsultSchemaError,
  ConsultUnavailableError,
  askJson,
  createConsultBudget,
  type ConsultBudget,
  type ConsultCallContext,
} from "./consult.js";
import type { ConsultResultMap } from "./consult_contract.js";

export const DEFAULT_CONSULT_MAX_CALLS = 4;
const MAX_CALLS_CAP = 32;

export interface ConsultBusPolicy {
  maxCallsPerRun: number;
}

export type PlanConflictConsultOutcome =
  | { ok: true; conflict: false; reason: string }
  | { ok: true; conflict: true; reason: string; revisedStep: string }
  | { ok: false; fallback: "hitl"; reason: string };

export interface PlanConflictConsultInput {
  goal: string;
  step: string;
  url: string;
  facts: string[];
}

let cached: ConsultBusPolicy | undefined;

function policyCandidates(): string[] {
  const out: string[] = [];
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/consult_bus.json"));
  out.push(join(here, "../../../config/consult_bus.json"));
  out.push(join(process.cwd(), "config", "consult_bus.json"));
  out.push(join(process.cwd(), "sidecar", "config", "consult_bus.json"));
  return out;
}

/** 非法值回落到默认；0 合法（等于关闭咨询，全部走 HITL）。 */
export function parseConsultMaxCalls(raw: unknown, fallback = DEFAULT_CONSULT_MAX_CALLS): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(MAX_CALLS_CAP, Math.floor(n)));
}

export function loadConsultBusPolicy(): ConsultBusPolicy {
  if (cached) return cached;
  let maxCallsPerRun = DEFAULT_CONSULT_MAX_CALLS;
  for (const candidate of policyCandidates()) {
    try {
      if (!candidate || !existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      maxCallsPerRun = parseConsultMaxCalls(parsed.maxCallsPerRun);
      break;
    } catch {
      /* 坏文件 → 继续找下一个；全失败用默认 */
    }
  }
  cached = { maxCallsPerRun };
  return cached;
}

export function resetConsultBusPolicyCache(): void {
  cached = undefined;
}

export function createRunConsultBudget(policy: ConsultBusPolicy = loadConsultBusPolicy()): ConsultBudget {
  return createConsultBudget(policy.maxCallsPerRun);
}

/** 预算还有、且任务没被中止，才允许把矛盾送去咨询。 */
export function consultBudgetReady(budget: ConsultBudget, aborted: boolean): boolean {
  return !aborted && budget.left > 0;
}

export function interpretPlanConflict(result: ConsultResultMap["plan_conflict"]): PlanConflictConsultOutcome {
  const reason = String(result.reason ?? "").trim().slice(0, 300);
  if (!result.conflict) {
    return { ok: true, conflict: false, reason };
  }
  let revised = String(result.revised_step ?? "").trim().slice(0, 200);
  if (!revised) {
    return { ok: false, fallback: "hitl", reason: reason || "conflict_without_revision" };
  }
  // 咨询偶发建议「地址栏拼 ?wd=/?q=」——违反搜索宪法，改成合法真人路径。
  if (revisedStepViolatesSearchConstitution(revised)) {
    revised =
      "在当前搜索引擎首页的搜索框输入检索词，再按 Enter 或点击搜索按钮进入结果页（禁止拼接或直达结果页 URL）";
  }
  return { ok: true, conflict: true, reason, revisedStep: revised };
}

/** 修订步是否在教模型拼搜索引擎结果页（机器特征，运行期也会拦）。 */
export function revisedStepViolatesSearchConstitution(step: string): boolean {
  const text = String(step ?? "");
  if (/[?&](q|wd|word|query|keyword)=/i.test(text)) return true;
  if (/\/s\?wd=|\/search\?/i.test(text)) return true;
  if (/地址栏.*(搜索|结果|拼)|直接.*(访问|打开|导航).*(结果页|搜索页)/i.test(text)) return true;
  if (/https?:\/\/[^/\s]*(baidu|google|bing|sogou|so\.com)[^/\s]*\/(s|search)\b/i.test(text)) {
    return true;
  }
  return false;
}

/** 咨询认定有矛盾：只给模型一段修订说明，不执行动作。 */
export function consultRevisionNudge(revisedStep: string, reason: string): string {
  return (
    `【Consult·计划矛盾】咨询判定当前计划与页面事实冲突。原因：${reason.slice(0, 180)}。` +
    `请改为执行：「${revisedStep.slice(0, 200)}」。先 plan_update 再行动；禁止重复原动作；禁止把咨询结果当成已付款或已提交。`
  );
}

/** 咨询认定无实质矛盾：继续当前计划，不要为此打断用户。 */
export function consultClearNudge(reason: string): string {
  const why = reason.trim();
  return (
    `【Consult·计划核对】咨询判定当前计划与页面事实并不冲突` +
    `${why ? `（${why.slice(0, 120)}）` : ""}。继续当前计划项，不要为此 ask_user。`
  );
}

function clip(text: string, max: number, empty: string): string {
  const cleaned = redactSecretText(String(text ?? "")).trim().slice(0, max);
  return cleaned || empty;
}

function fallback(reason: string): PlanConflictConsultOutcome {
  return { ok: false, fallback: "hitl", reason: reason.slice(0, 200) || "consult_failed" };
}

/**
 * 问一次 plan_conflict。任何失败都是 `{ ok:false, fallback:"hitl" }`，不抛错。
 */
export async function consultPlanConflict(
  input: PlanConflictConsultInput,
  ctx: ConsultCallContext,
): Promise<PlanConflictConsultOutcome> {
  if (ctx.signal?.aborted) return fallback("aborted");
  if (ctx.budget && ctx.budget.left <= 0) return fallback("budget");

  try {
    const result = await askJson(
      "plan_conflict",
      {
        goal: clip(input.goal, 2000, "（无目标）"),
        step: clip(input.step, 500, "（无当前计划项）"),
        url: clip(input.url, 500, "（无地址）"),
        facts: (input.facts.length ? input.facts : ["（无客观事实）"])
          .slice(0, 12)
          .map((fact) => clip(fact, 300, "（空）")),
      },
      ctx,
    );
    return interpretPlanConflict(result);
  } catch (error) {
    if (error instanceof ConsultUnavailableError) return fallback(error.reason);
    if (error instanceof ConsultSchemaError) return fallback(error.errors[0] ?? "schema");
    const message = error instanceof Error ? error.message : String(error ?? "consult_failed");
    return fallback(message);
  }
}
