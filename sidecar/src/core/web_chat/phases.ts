/**
 * 聊天模式相位表与转移守卫（§4.1）
 *
 * 这是聊天模式「耐久相位状态机」的骨架：**每个阻塞边界都是一个显式相位**，
 * 相位边界就是耐久检查点。相位是纯数据 + 纯函数守卫 —— 随机性（LLM）只发生在
 * `drafting` 这种单个相位内部，因此整条工作流可审计、可单测（PIOAGENT 的"确定性路由"）。
 *
 * 与 `bu_agent` 的 ReAct 步进循环**没有任何关系**（§0.4 / §7.4：禁止跨形态借用循环）。
 */

export type ChatPhase =
  | "booting"
  | "scanning"
  | "waiting"
  | "reading"
  | "deciding"
  | "drafting"
  | "verifying"
  | "sending"
  | "recording"
  | "yielding"
  | "paused"
  | "handover"
  | "stopped";

export const CHAT_PHASES: readonly ChatPhase[] = [
  "booting",
  "scanning",
  "waiting",
  "reading",
  "deciding",
  "drafting",
  "verifying",
  "sending",
  "recording",
  "yielding",
  "paused",
  "handover",
  "stopped",
];

/**
 * 「空闲」相位：看门狗**不计时**。
 *
 * 这是相位模型相对心跳时间戳的核心优势（§4.4）：`waiting` 可能一待几小时，
 * 那是正常的，不需要「记得 bump 心跳」也不会被误判成卡死。
 */
export const CHAT_IDLE_PHASES: readonly ChatPhase[] = ["waiting", "paused", "handover"];

/** 等 LLM 的相位：慢不等于卡死，看门狗阈值必须放宽 */
export const CHAT_LLM_PHASES: readonly ChatPhase[] = ["deciding", "drafting"];

/** 终态 */
export const CHAT_TERMINAL_PHASES: readonly ChatPhase[] = ["stopped"];

export function isIdlePhase(phase: ChatPhase): boolean {
  return CHAT_IDLE_PHASES.includes(phase);
}

export function isLlmPhase(phase: ChatPhase): boolean {
  return CHAT_LLM_PHASES.includes(phase);
}

export function isTerminalPhase(phase: ChatPhase): boolean {
  return CHAT_TERMINAL_PHASES.includes(phase);
}

/** 看门狗该不该对这个相位计时 */
export function isWatchdogRelevant(phase: ChatPhase): boolean {
  return !isIdlePhase(phase) && !isTerminalPhase(phase);
}

const TRANSITIONS: Readonly<Record<ChatPhase, readonly ChatPhase[]>> = {
  booting: ["scanning", "waiting", "handover", "stopped"],
  scanning: ["reading", "deciding", "waiting", "yielding", "handover", "stopped"],
  waiting: ["scanning", "reading", "paused", "handover", "stopped"],
  reading: ["deciding", "recording", "waiting", "handover", "stopped"],
  deciding: ["drafting", "recording", "waiting", "handover", "stopped"],
  drafting: ["verifying", "recording", "waiting", "handover", "stopped"],
  verifying: ["sending", "recording", "waiting", "handover", "stopped"],
  sending: ["recording", "waiting", "handover", "stopped"],
  recording: ["scanning", "waiting", "yielding", "handover", "stopped"],
  yielding: ["waiting", "paused", "stopped"],
  paused: ["scanning", "waiting", "handover", "stopped"],
  handover: ["waiting", "paused", "scanning", "stopped"],
  stopped: [],
};

/**
 * 转移守卫（纯函数）。同相位重复进入是允许的（幂等重启同一相位）。
 *
 * 紧急出口：任何非终态相位都允许直接进 `handover` / `stopped` —— 风控、席位被夺、
 * 用户按停这些情况不该被状态机挡住（安全优先于流程完整）。
 *
 * **会话开始例外**：任何相位都允许进 `booting`。一次新的值守片总是从 `booting` 起步，
 * 而上一片结束时状态机停在 `waiting` / `paused` / `handover`（甚至 `stopped` ——
 * 那表示「上一片结束了」，不表示「这个环境永远不能再聊」）。若不放行这一条，
 * 引擎就无法从**自己写下的持久化快照**里续跑 —— 这是实测踩到的真坑，不是假想。
 */
export function canTransition(from: ChatPhase, to: ChatPhase): boolean {
  if (from === to) return true;
  if (to === "booting") return true;
  if (to === "stopped" || to === "handover") return !isTerminalPhase(from);
  if (isTerminalPhase(from)) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: ChatPhase, to: ChatPhase): void {
  if (!canTransition(from, to)) {
    throw new Error(`chat_phase_transition_illegal: ${from} -> ${to}`);
  }
}

/** 相位的中文标签（仅供日志与视图展示） */
const PHASE_LABELS: Readonly<Record<ChatPhase, string>> = {
  booting: "启动装载",
  scanning: "扫描到期",
  waiting: "事件等待",
  reading: "读取会话",
  deciding: "判断是否说话",
  drafting: "生成草稿",
  verifying: "闸门校验",
  sending: "发送确认",
  recording: "落库更新",
  yielding: "让出席位",
  paused: "已暂停",
  handover: "转人工",
  stopped: "已结束",
};

export function phaseLabel(phase: ChatPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}
