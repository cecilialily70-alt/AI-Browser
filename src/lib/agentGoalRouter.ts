import { normalizeDomain } from "./domain";

export interface AgentGoalAssignment {
  profileId: string;
  goal: string;
}

export type AgentRouteMode = "broadcast" | "named";

export interface AgentSeatPolicy {
  /** Pro / Solo with valid license → multi; otherwise Free cap = 1. */
  isPro: boolean;
  /**
   * CloakBrowser session seat limit (e.g. Free=1, Solo may be 1+).
   * null/undefined → unknown; Free still forced to 1, Pro uncapped by seats.
   */
  seatLimit?: number | null;
}

export interface AgentRouteResult {
  mode: AgentRouteMode;
  assignments: AgentGoalAssignment[];
  /** Named / selected IDs skipped because browser not running. */
  skippedNotRunning: string[];
  /** Dropped because over Free/seat cap (kept in order). */
  skippedOverCap: string[];
  /** Effective parallel cap applied (1 for Free, or seatLimit). */
  maxAllowed: number | null;
  /** Human-readable error; when set, do not start. */
  error?: string;
}

export interface ResolveAgentTargetsInput {
  goal: string;
  /** Left-panel checkbox selection (broadcast pool). */
  selectedIds: string[];
  /** Profiles with status === running. */
  runningIds: string[];
  policy: AgentSeatPolicy;
}

/** Must stay in sync with sidecar `chat_intent_router` AGENT_BRIDGE_* markers. */
export const AGENT_BRIDGE_OPEN = "⟦tsi_agent_bridge⟧";
export const AGENT_BRIDGE_CLOSE = "⟦/tsi_agent_bridge⟧";

export interface ChatAgentBridgePayload {
  v: 1;
  action: "start";
  goal: string;
  intent: "autonomous_agent";
}

/** Parse Chat→Agent bridge payload embedded in ai_chat reply. */
export function parseAgentBridgePayload(reply: string): ChatAgentBridgePayload | null {
  const start = reply.indexOf(AGENT_BRIDGE_OPEN);
  const end = reply.indexOf(AGENT_BRIDGE_CLOSE);
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }
  const raw = reply.slice(start + AGENT_BRIDGE_OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<ChatAgentBridgePayload>;
    if (parsed?.v !== 1 || parsed.action !== "start" || parsed.intent !== "autonomous_agent") {
      return null;
    }
    const goal = typeof parsed.goal === "string" ? parsed.goal.replace(/\s+/g, " ").trim() : "";
    if (!goal) {
      return null;
    }
    return { v: 1, action: "start", goal, intent: "autonomous_agent" };
  } catch {
    return null;
  }
}

/** Strip machine marker so Chat UI only shows human text. */
export function stripAgentBridgeMarker(reply: string): string {
  const start = reply.indexOf(AGENT_BRIDGE_OPEN);
  const end = reply.indexOf(AGENT_BRIDGE_CLOSE);
  if (start < 0 || end < 0 || end <= start) {
    return reply.trim();
  }
  const before = reply.slice(0, start).trim();
  const after = reply.slice(end + AGENT_BRIDGE_CLOSE.length).trim();
  return [before, after].filter(Boolean).join("\n").trim();
}

/** Normalize goal text for confirm-coalesce keys. */
export function normalizeAgentGoalKey(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().toLowerCase();
}

export function agentConfirmCohortKey(kind: string, goalKey: string, urlOrDomain: string): string {
  const domain = urlOrDomain.includes("://")
    ? normalizeDomain(urlOrDomain)
    : urlOrDomain
        .trim()
        .toLowerCase()
        .replace(/^www\./, "");
  return `${kind}|${normalizeAgentGoalKey(goalKey)}|${domain || "_"}`;
}

/** Max parallel Agent targets: Free→1; Pro→seatLimit when known. Opening browsers is unlimited. */
export function resolveAgentMaxAllowed(policy: AgentSeatPolicy): number | null {
  if (!policy.isPro) {
    return 1;
  }
  const limit = policy.seatLimit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit);
  }
  return null;
}

function applySeatCap(
  assignments: AgentGoalAssignment[],
  maxAllowed: number | null,
): { kept: AgentGoalAssignment[]; skippedOverCap: string[] } {
  if (maxAllowed == null || assignments.length <= maxAllowed) {
    return { kept: assignments, skippedOverCap: [] };
  }
  const sorted = [...assignments].sort((a, b) => compareProfileIdAsc(a.profileId, b.profileId));
  const kept = sorted.slice(0, maxAllowed);
  const skippedOverCap = sorted.slice(maxAllowed).map((item) => item.profileId);
  return { kept, skippedOverCap };
}

/**
 * Split a natural-language agent goal into per-profile assignments.
 *
 * Broadcast (no #ID): selected ∩ running only; not-running selected are ignored.
 * Named (`#12` / `环境12`): explicit IDs that are running (selection not required).
 * Cap (AI parallel only — opening browsers is never capped here):
 * Free → 1 AI target; Pro → cannot exceed session seat limit when known.
 */
export function resolveAgentTargets(input: ResolveAgentTargetsInput): AgentRouteResult {
  const trimmed = input.goal.replace(/\s+/g, " ").trim();
  const maxAllowed = resolveAgentMaxAllowed(input.policy);
  const empty = {
    mode: "broadcast" as const,
    assignments: [] as AgentGoalAssignment[],
    skippedNotRunning: [] as string[],
    skippedOverCap: [] as string[],
    maxAllowed,
  };

  if (!trimmed) {
    return { ...empty, error: "请填写 Agent 目标" };
  }

  const runningSet = new Set(input.runningIds.map((id) => id.trim()).filter(Boolean));
  const selectedIds = input.selectedIds.map((id) => id.trim()).filter(Boolean);

  const markerRe = /(?:环境\s*#?\s*|#)(\d+)/gi;
  const markers: Array<{ index: number; id: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(trimmed)) !== null) {
    markers.push({ index: match.index, id: match[1] });
  }

  if (markers.length === 0) {
    if (selectedIds.length === 0) {
      return {
        ...empty,
        error: "请先在左侧勾选要操作的环境（未点名时默认操作已选且已打开的浏览器）",
      };
    }

    const skippedNotRunning = selectedIds.filter((id) => !runningSet.has(id));
    const selectedRunning = selectedIds.filter((id) => runningSet.has(id));
    if (selectedRunning.length === 0) {
      return {
        ...empty,
        skippedNotRunning,
        error: "勾选的环境均未启动，已全部忽略。请先打开浏览器后再运行 Agent",
      };
    }

    const raw = selectedRunning.map((profileId) => ({ profileId, goal: trimmed }));
    const { kept, skippedOverCap } = applySeatCap(raw, maxAllowed);
    if (kept.length === 0) {
      return {
        ...empty,
        skippedNotRunning,
        skippedOverCap,
        error: !input.policy.isPro
          ? "免费版 AI 同时仅可控制 1 个已打开环境（打开指纹浏览器不限个数）"
          : `AI 并行超过授权席位上限（${maxAllowed}）。打开浏览器不限；请减少本次 Agent 目标数`,
      };
    }

    return {
      mode: "broadcast",
      assignments: kept,
      skippedNotRunning,
      skippedOverCap,
      maxAllowed,
    };
  }

  // Named dispatch
  markers.sort((a, b) => a.index - b.index);
  const named: AgentGoalAssignment[] = [];
  const skippedNotRunning: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < markers.length; i += 1) {
    const current = markers[i];
    const next = markers[i + 1];
    const start = current.index;
    const markerMatch = trimmed.slice(start).match(/^(?:环境\s*#?\s*|#)\d+/i);
    const bodyStart = start + (markerMatch?.[0].length ?? 0);
    const end = next ? next.index : trimmed.length;
    let clause = trimmed.slice(bodyStart, end).trim();
    clause = clause.replace(/^[\s:：,，\-—]+/, "").trim();
    if (!clause) {
      clause = trimmed;
    }

    if (seen.has(current.id)) {
      continue;
    }
    seen.add(current.id);

    if (!runningSet.has(current.id)) {
      skippedNotRunning.push(current.id);
      continue;
    }
    named.push({ profileId: current.id, goal: clause });
  }

  if (named.length === 0) {
    return {
      mode: "named",
      assignments: [],
      skippedNotRunning,
      skippedOverCap: [],
      maxAllowed,
      error:
        skippedNotRunning.length > 0
          ? `点名的环境均未运行（#${skippedNotRunning.join("、#")}），已忽略`
          : "未能解析有效的点名分派",
    };
  }

  const { kept, skippedOverCap } = applySeatCap(named, maxAllowed);
  if (kept.length === 0) {
    return {
      mode: "named",
      assignments: [],
      skippedNotRunning,
      skippedOverCap,
      maxAllowed,
      error: !input.policy.isPro
        ? "免费版 AI 同时仅可控制 1 个已打开环境，请只点名一个（打开指纹浏览器不限个数）"
        : `点名数量超过 AI 席位上限（${maxAllowed}）。打开浏览器不限；请减少点名`,
    };
  }

  return {
    mode: "named",
    assignments: kept,
    skippedNotRunning,
    skippedOverCap,
    maxAllowed,
  };
}

export function compareProfileIdAsc(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === a && String(nb) === b) {
    return na - nb;
  }
  return a.localeCompare(b);
}
