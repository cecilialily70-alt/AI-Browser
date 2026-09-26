/**
 * Sidecar 单进程引擎互斥：Agent / RPA / 轨迹回放 不可重叠。
 */
export type EngineKind = "agent" | "rpa" | "trajectory_replay" | "idle";

export interface EngineBusyState {
  agentRunning: boolean;
  rpaRunning: boolean;
  trajectoryReplayRunning: boolean;
}

export const ENGINE_BUSY_MESSAGE = "当前环境正忙，请先停止当前任务";

export function resolveBusyEngine(state: EngineBusyState): EngineKind {
  if (state.agentRunning) {
    return "agent";
  }
  if (state.rpaRunning) {
    return "rpa";
  }
  if (state.trajectoryReplayRunning) {
    return "trajectory_replay";
  }
  return "idle";
}

export function formatEngineBusyMessage(state: EngineBusyState, requested: string): string {
  const busy = resolveBusyEngine(state);
  if (busy === "idle") {
    return "";
  }
  const label =
    busy === "agent" ? "Agent" : busy === "rpa" ? "RPA 填表" : "轨迹回放";
  return `${ENGINE_BUSY_MESSAGE}（正在执行：${label}；拒绝：${requested}）`;
}

export function isEngineBusy(state: EngineBusyState): boolean {
  return resolveBusyEngine(state) !== "idle";
}
