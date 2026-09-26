import type { JsonLogger } from "../json-logger.js";
import type { RpaAction, RpaRunState } from "./types.js";

export interface RpaStepFailureContext {
  stepIndex: number;
  action: RpaAction;
  error: unknown;
}

/** 格式化步骤失败信息 */
export function formatRpaStepError(action: RpaAction, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `步骤 ${action.step} 失败: ${message}，等待人工排查`;
}

/** 记录步骤失败并返回暂停状态 payload */
export function handleRpaStepFailure(
  logger: JsonLogger,
  context: RpaStepFailureContext,
  actions: RpaAction[],
): { state: RpaRunState; msg: string } {
  const message = context.error instanceof Error ? context.error.message : String(context.error);
  logger.warn("rpa_step_failed", {
    step: context.action.step,
    selector: context.action.selector,
    error: message,
  });

  const msg = formatRpaStepError(context.action, context.error);
  logger.rpaState("paused", {
    step: context.stepIndex,
    msg,
    actions,
  });

  return { state: "paused", msg };
}

/** 记录顶层执行中断 */
export function handleRpaRunError(
  logger: JsonLogger,
  stepIndex: number,
  error: unknown,
  actions: RpaAction[],
): { state: RpaRunState; msg: string } {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("rpa_run_until_pause_failed", { error: message, step: stepIndex });
  const msg = `RPA 执行中断: ${message}`;
  logger.rpaState("paused", { step: stepIndex, msg, actions });
  return { state: "paused", msg };
}
