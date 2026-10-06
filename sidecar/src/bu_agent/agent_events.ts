/**
 * AgentEvent SSOT — 浏览器 Agent 结构化事件（仅 Agent 形态）。
 *
 * 协议：顶层 type 恒为 agent_state；语义落在 eventKind。
 * 与 chat_state / chatProgress 永久分家（B8 / ChatFireWall）。
 * 人视只消费瘦字段；DOM/JSON 证据只进 Sidecar 内存 → RunBrief，不过 Host。
 */
export type AgentEventKind =
  | "step_start"
  | "step_action"
  | "step_observe"
  | "action_ok"
  | "action_fail"
  | "action_blocked"
  | "deliverable_progress"
  | "deliverable_done"
  | "gate_reject"
  | "hitl"
  | "run_complete"
  | "run_failed"
  | "run_aborted"
  | "note";

export type AgentEventPhase =
  | "boot"
  | "observe"
  | "decide"
  | "act"
  | "verify"
  | "hitl"
  | "settle"
  | "done"
  | "error";

/** 人视通道允许的字段（Host 透传；不含 DOM/JSON/截图） */
export const AGENT_HUMAN_KEYS = [
  "eventKind",
  "phase",
  "step",
  "msg",
  "engine",
  "summary",
  "state",
  "profileId",
  "profile_id",
  "waitId",
  "url",
  "error",
  "selector",
  "verifyVerdict",
  "actionName",
  "pendingCount",
  "doneCount",
  "targetCount",
  "elements",
] as const;

/** Host / 人视必须剥掉的重载荷键 */
export const AGENT_HEAVY_KEYS = [
  "domBefore",
  "domAfter",
  "domSnippet",
  "networkJson",
  "networkHits",
  "screenshotBase64",
  "screenshot",
  "visionImages",
  "interactiveTree",
  "plan",
  "rawHtml",
] as const;

export interface AgentEventInput {
  eventKind: AgentEventKind;
  msg: string;
  phase?: AgentEventPhase | string;
  step?: number;
  state?: string;
  profileId?: string;
  engine?: string;
  summary?: string;
  waitId?: string;
  /** 附加瘦字段（会过 HUMAN_KEYS 过滤进人视；全量可进内存 ring） */
  data?: Record<string, unknown>;
}

/** 从任意 payload 抽出人视瘦对象（剥重载荷） */
export function slimAgentEventForHuman(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!data) return out;
  const heavy = new Set<string>(AGENT_HEAVY_KEYS);
  const allow = new Set<string>(AGENT_HUMAN_KEYS);
  for (const [key, value] of Object.entries(data)) {
    if (heavy.has(key)) continue;
    if (allow.has(key) || key === "eventKind" || key === "phase") {
      out[key] = value;
    }
  }
  return out;
}

/** 协议 eventKind → 人视 TerminalLine.kind（不得直灌） */
export function mapEventKindToUiKind(
  eventKind: string | undefined | null,
): "thought" | "perceive" | "action" | "alert" | "success" | "error" | "system" | undefined {
  const k = String(eventKind ?? "").trim();
  if (!k) return undefined;
  switch (k) {
    case "step_observe":
      return "perceive";
    case "step_start":
    case "note":
    case "deliverable_progress":
      return "thought";
    case "step_action":
    case "action_ok":
      return "action";
    case "action_blocked":
    case "gate_reject":
    case "hitl":
      return "alert";
    case "action_fail":
    case "run_failed":
      return "error";
    case "deliverable_done":
    case "run_complete":
      return "success";
    case "run_aborted":
      return "system";
    default:
      return undefined;
  }
}
