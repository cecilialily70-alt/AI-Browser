/**
 * 回放预检单的风险判定（§4.6.6）—— 纯计算、无浏览器、无 LLM。
 *
 * 预检单要回答两个「必须复用既有词典、不许另写一套」的问题：
 *
 *   ① **轨迹里有没有 critical 步骤**（支付 / 卡号 / 转账 / 删号 / 改密…）
 *      → 🟡 告警，并明示「执行时会停在人工确认，不会无人支付」（R1）。
 *      判定必须走 `core/hitl_policy.ts` 的 `decideHitlConfirm`，与 Agent 执行时**同一套**逻辑；
 *      Host 是 Rust、跑不了 TS，所以由一次性 CLI 调本模块。
 *
 *   ② **数据集列名有没有命中一次性凭证词表**
 *      → 🔴 整份拒绝（数据集会落盘，R2 / §1.3）。复用 `core/dataset_parse.ts`。
 *
 * 为什么只报 critical、不报 sensitive：回放的是**用户自己录下来的动作**，
 * 等于用户已经对「注册/提交/邮箱密码」这类 sensitive 步骤表达过意图；
 * 若在回放里对每一步 sensitive 都弹框，就是把「确认疲劳」重新引入，且与回放语义冲突。
 * critical 则相反 —— 产品红线要求它**任何情况下都确认**（`criticalConfirm` 不因目标覆盖豁免）。
 */
import { classifyDatasetColumnName } from "./dataset_parse.js";
import { decideHitlConfirm } from "./hitl_policy.js";

export interface ReplayPlanRiskStep {
  /** 0 基步序号 */
  index: number;
  /** 人类可读的动作摘要（如「点击 确认支付」） */
  label: string;
  /** 命中的 critical 词条 */
  matched: string;
  /** 判定说明（写进预检单文案） */
  reason: string;
}

export interface ReplayPlanRiskReport {
  criticalSteps: ReplayPlanRiskStep[];
  /** 🔴 列名被拒（整份数据集不可用） */
  columnRefusals: Array<{ name: string; reason: string }>;
  /** 🟡 列名提醒（不拦） */
  columnWarnings: string[];
}

interface LooseStep {
  type?: unknown;
  action?: unknown;
  kind?: unknown;
  selector?: unknown;
  value?: unknown;
  url?: unknown;
  semanticLabel?: unknown;
  label?: unknown;
  text?: unknown;
}

const MAX_LABEL_CHARS = 60;

function asStep(raw: unknown): LooseStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as LooseStep;
}

function stepType(step: LooseStep): string {
  return String(step.type ?? step.action ?? step.kind ?? "")
    .trim()
    .toLowerCase();
}

/** 与该步在回放引擎里实际使用的可引用文案一致（semanticLabel > label > selector） */
function stepLabel(step: LooseStep): string {
  const selector = String(step.selector ?? "").trim();
  const semantic = String(step.semanticLabel ?? "").trim();
  const label = String(step.label ?? "").trim();
  const text = String(step.text ?? "").trim();
  return (semantic || label || text || selector).slice(0, MAX_LABEL_CHARS);
}

/** 一步是否属于会被 HITL 判定的交互类型（其余类型没有「点/填了什么」这回事） */
function hitlKindOf(type: string): "fill" | "select" | "click" | null {
  if (type === "fill") return "fill";
  if (type === "select") return "select";
  if (type === "click" || type === "click_point") return "click";
  return null;
}

/**
 * 扫描轨迹：列出 critical 步骤。
 *
 * `goal` 传轨迹的标题/目标（可为空）：即使目标里写了「帮我支付」，critical 也不豁免
 * （`decideHitlConfirm` 的 critical 分支先返回），所以这里传什么都没关系 —— 传它是为了日志可追溯。
 */
export function scanReplayCriticalSteps(
  actions: unknown[],
  goal = "",
): ReplayPlanRiskStep[] {
  const out: ReplayPlanRiskStep[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const step = asStep(actions[index]);
    if (!step) continue;
    const kind = hitlKindOf(stepType(step));
    if (!kind) continue;
    const label = stepLabel(step);
    if (!label) continue;
    const decision = decideHitlConfirm({
      kind,
      label,
      value: kind === "click" ? undefined : String(step.value ?? ""),
      goal,
    });
    if (decision.level !== "critical") continue;
    out.push({
      index,
      label: `${kind === "click" ? "点击" : kind === "select" ? "选择" : "填写"} ${label}`,
      matched: decision.matched ?? "",
      reason: decision.reason,
    });
  }
  return out;
}

/** 列名红线校验（复用 dataset_parse 的同一条判定，避免两套结论） */
export function scanReplayDatasetColumns(columns: string[]): {
  refusals: Array<{ name: string; reason: string }>;
  warnings: string[];
} {
  const refusals: Array<{ name: string; reason: string }> = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const raw of columns ?? []) {
    const name = String(raw ?? "");
    if (seen.has(name)) continue;
    seen.add(name);
    const refusal = classifyDatasetColumnName(name);
    if (refusal) {
      refusals.push({ name, reason: refusal });
      continue;
    }
    if (!name.trim()) warnings.push("存在空列名");
  }
  return { refusals, warnings };
}

/** 预检单风险判定的总入口（CLI 与单测共用） */
export function scanReplayPlanRisks(input: {
  actions?: unknown[];
  columns?: string[];
  goal?: string;
}): ReplayPlanRiskReport {
  const columns = scanReplayDatasetColumns(input.columns ?? []);
  return {
    criticalSteps: scanReplayCriticalSteps(input.actions ?? [], input.goal ?? ""),
    columnRefusals: columns.refusals,
    columnWarnings: columns.warnings,
  };
}
