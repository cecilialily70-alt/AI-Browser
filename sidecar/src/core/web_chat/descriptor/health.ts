/**
 * 描述符健康与熔断（纯状态机 · 无 I/O）
 *
 * 为什么需要它（§6.3「漂移运维是持续的，不是一次性的」）：站点改版会让描述符失效。诚实的能力
 * 边界是「**先结构自愈，再停用并回落通用模式**」，而不是假装能自愈到永远 ——
 * 所以健康度与最近失败原因必须可查，且**不静默**。
 *
 * 两条不同待遇（宪法 §3 硬纪律）：
 *   - `learned`（AI 学来的）：形状不匹配先试一次结构重映射；仍失败 → **自动停用**并回落通用模式。
 *   - `builtin`（随仓库发版的）：**只报错、不自动改**（人手写的文件不该被运行时悄悄关掉）。
 *
 * 本模块只做状态推进；持久化与视图展示由调用方负责（唯一权威在这里，别处不许再算一遍）。
 */

export type DescriptorHealthKind = "builtin" | "learned";

export interface ConnectorHealth {
  id: string;
  /** 连续失败次数（成功即清零） */
  consecutiveFailures: number;
  /** 已停用（熔断）；需显式重新启用才恢复 */
  disabled: boolean;
  /** 最近一次失败的人话原因（进视图，不静默） */
  reason: string | null;
  lastFailureAt: string | null;
  /** 形状不匹配时是否已经试过一次结构重映射（只试一次） */
  remapAttempted: boolean;
  totalOk: number;
  totalFail: number;
}

export interface HealthPolicy {
  /** 普通错误连续失败到几次触发停用（只对 learned 生效） */
  failureThreshold: number;
  /** 形状不匹配时是否允许一次结构重映射 */
  allowRemap: boolean;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  failureThreshold: 3,
  allowRemap: true,
};

export type HealthOutcomeKind = "ok" | "shape_mismatch" | "error";

export interface HealthOutcome {
  kind: HealthOutcomeKind;
  reason?: string;
}

export type HealthAction =
  /** 继续可用 */
  | "ok"
  /** 把这一轮标记为「已尝试结构重映射」，调用方重试一次 */
  | "remap"
  /** 停用该描述符，回落通用模式 */
  | "disabled";

export interface HealthDecision {
  health: ConnectorHealth;
  action: HealthAction;
  reason: string;
}

export function newConnectorHealth(id: string): ConnectorHealth {
  return {
    id,
    consecutiveFailures: 0,
    disabled: false,
    reason: null,
    lastFailureAt: null,
    remapAttempted: false,
    totalOk: 0,
    totalFail: 0,
  };
}

/** 可用性只看 `disabled`；**不**因为「连续失败但没到阈值」就提前不用它 */
export function isConnectorUsable(health: ConnectorHealth | null | undefined): boolean {
  return !health || !health.disabled;
}

/**
 * 推进一次结果。
 *
 * `now` 由调用方注入（本模块不读时钟，才能确定性地单测）。
 */
export function recordHealthOutcome(
  health: ConnectorHealth,
  outcome: HealthOutcome,
  now: string,
  kind: DescriptorHealthKind,
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): HealthDecision {
  const next: ConnectorHealth = { ...health };
  const autoDisable = kind === "learned";

  if (outcome.kind === "ok") {
    next.consecutiveFailures = 0;
    next.reason = null;
    next.remapAttempted = false;
    next.totalOk += 1;
    return { health: next, action: "ok", reason: "正常" };
  }

  next.totalFail += 1;
  next.consecutiveFailures += 1;
  next.lastFailureAt = now;
  next.reason = outcome.reason?.trim() || (outcome.kind === "shape_mismatch" ? "页面结构与描述符不匹配" : "运行失败");

  if (outcome.kind === "shape_mismatch") {
    // 形状不匹配是「站点改版」的信号：先给它一次结构自愈的机会（且只给一次）。
    // 只有 learned 才有「自愈」这一说 —— builtin 是随仓库发版的人手文件，运行时不许改它，
    // 所以对 builtin 直接如实报错（别给一个永远不会兑现的 remap 动作）。
    if (autoDisable && policy.allowRemap && !next.remapAttempted) {
      next.remapAttempted = true;
      return { health: next, action: "remap", reason: `${next.reason}（先尝试结构重映射）` };
    }
    if (autoDisable) {
      next.disabled = true;
      return {
        health: next,
        action: "disabled",
        reason: `${next.reason}，已停用该描述符并回落通用模式`,
      };
    }
    return { health: next, action: "ok", reason: `${next.reason}（builtin 不自动停用，请修描述符）` };
  }

  if (!autoDisable) {
    return { health: next, action: "ok", reason: `${next.reason}（builtin 不自动停用，请修描述符）` };
  }
  if (next.consecutiveFailures >= policy.failureThreshold) {
    next.disabled = true;
    return {
      health: next,
      action: "disabled",
      reason: `连续 ${next.consecutiveFailures} 次失败（${next.reason}），已停用该描述符并回落通用模式`,
    };
  }
  return {
    health: next,
    action: "ok",
    reason: `${next.reason}（连续 ${next.consecutiveFailures}/${policy.failureThreshold} 次，下次仍失败则停用）`,
  };
}

/** 显式重新启用（「更新」按钮 / 用户手动重新启用）：保留累计计数，但清零疲劳与停用标记 */
export function reenableConnector(health: ConnectorHealth): ConnectorHealth {
  return { ...health, disabled: false, consecutiveFailures: 0, remapAttempted: false, reason: null };
}
