/**
 * Sidecar 单进程引擎互斥：Agent / RPA / 轨迹回放 / 聊天模式 不可重叠。
 *
 * 聊天模式是**第四种执行形态**（§0.4），同环境同样受互斥约束（§7.4 / S5）：
 * 它有自己的引擎、自己的循环，但在「谁在占这台浏览器」这件事上必须登记进同一个互斥。
 */
export type EngineKind = "agent" | "rpa" | "trajectory_replay" | "chat" | "idle";

export interface EngineBusyState {
  agentRunning: boolean;
  rpaRunning: boolean;
  trajectoryReplayRunning: boolean;
  chatRunning: boolean;
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
  if (state.chatRunning) {
    return "chat";
  }
  return "idle";
}

const ENGINE_LABELS: Readonly<Record<EngineKind, string>> = {
  agent: "Agent",
  rpa: "RPA 填表",
  trajectory_replay: "轨迹回放",
  chat: "聊天模式",
  idle: "空闲",
};

export function engineLabel(kind: EngineKind): string {
  return ENGINE_LABELS[kind] ?? kind;
}

export function formatEngineBusyMessage(state: EngineBusyState, requested: string): string {
  const busy = resolveBusyEngine(state);
  if (busy === "idle") {
    return "";
  }
  return `${ENGINE_BUSY_MESSAGE}（正在执行：${engineLabel(busy)}；拒绝：${requested}）`;
}

export function isEngineBusy(state: EngineBusyState): boolean {
  return resolveBusyEngine(state) !== "idle";
}
