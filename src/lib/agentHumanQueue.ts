import { normalizeDomain } from "./domain";
import {
  agentConfirmCohortKey,
  compareProfileIdAsc,
  normalizeAgentGoalKey,
  type AgentRouteMode,
} from "./agentGoalRouter";
import type { AgentConfirmActionRow } from "../components/AgentConfirmModal";
import type { HitlAiCopy } from "./hitlAiCopy";

export type AgentHumanKind = "confirm" | "handover" | "ask";

export interface PendingAgentHuman {
  profileId: string;
  kind: AgentHumanKind;
  requestId: string;
  url: string;
  domain: string;
  goalKey: string;
  reason?: string;
  question?: string;
  aiCopy?: HitlAiCopy;
  actions?: AgentConfirmActionRow[];
  fillValues?: Record<string, string>;
  /** 事件已带截图时复用（base64，可含 data: 前缀） */
  screenshotBase64?: string;
  pausedAt?: string;
}

export function humanItemKey(item: Pick<PendingAgentHuman, "kind" | "profileId" | "requestId">): string {
  return `${item.kind}:${item.profileId}:${item.requestId}`;
}

export function buildPendingHuman(input: {
  profileId: string;
  kind: AgentHumanKind;
  requestId: string;
  url?: string;
  goalKey: string;
  reason?: string;
  question?: string;
  aiCopy?: HitlAiCopy;
  actions?: AgentConfirmActionRow[];
  fillValues?: Record<string, string>;
  screenshotBase64?: string;
  pausedAt?: string;
}): PendingAgentHuman {
  const url = input.url?.trim() ?? "";
  return {
    profileId: input.profileId,
    kind: input.kind,
    requestId: input.requestId,
    url,
    domain: normalizeDomain(url) || url.trim().toLowerCase(),
    goalKey: normalizeAgentGoalKey(input.goalKey),
    reason: input.reason,
    question: input.question,
    aiCopy: input.aiCopy,
    actions: input.actions,
    fillValues: input.fillValues,
    screenshotBase64: input.screenshotBase64?.trim() || undefined,
    pausedAt: input.pausedAt,
  };
}

export function cohortKeyOf(item: PendingAgentHuman): string {
  return agentConfirmCohortKey(item.kind, item.goalKey, item.domain || item.url);
}

/** Pull the next cohort (same kind+goal+domain) sorted by profile id ascending. */
export function takeNextHumanCohort(pending: PendingAgentHuman[]): {
  cohort: PendingAgentHuman[];
  rest: PendingAgentHuman[];
} {
  if (pending.length === 0) {
    return { cohort: [], rest: [] };
  }
  const sorted = [...pending].sort((a, b) => compareProfileIdAsc(a.profileId, b.profileId));
  const first = sorted[0];
  const key = cohortKeyOf(first);
  const cohort = sorted.filter((item) => cohortKeyOf(item) === key);
  const cohortIds = new Set(cohort.map((item) => humanItemKey(item)));
  const rest = pending.filter((item) => !cohortIds.has(humanItemKey(item)));
  return { cohort, rest };
}

/** Group inbox into cohorts (batch merge)，保持同站同任务合并策略。 */
export function groupHumanInbox(pending: PendingAgentHuman[]): PendingAgentHuman[][] {
  const remaining = [...pending];
  const groups: PendingAgentHuman[][] = [];
  while (remaining.length > 0) {
    const { cohort, rest } = takeNextHumanCohort(remaining);
    if (cohort.length === 0) {
      break;
    }
    groups.push(cohort);
    remaining.length = 0;
    remaining.push(...rest);
  }
  return groups;
}

export function mergeIntoActiveCohort(
  active: PendingAgentHuman[],
  incoming: PendingAgentHuman,
): PendingAgentHuman[] | null {
  if (active.length === 0) {
    return null;
  }
  if (cohortKeyOf(active[0]) !== cohortKeyOf(incoming)) {
    return null;
  }
  if (active.some((item) => humanItemKey(item) === humanItemKey(incoming))) {
    return active;
  }
  return [...active, incoming].sort((a, b) => compareProfileIdAsc(a.profileId, b.profileId));
}

/** Merge fill actions from two confirm payloads (same profile sequential → one form). */
export function mergeConfirmActions(
  existing: AgentConfirmActionRow[] | undefined,
  incoming: AgentConfirmActionRow[] | undefined,
): AgentConfirmActionRow[] {
  const map = new Map<string, AgentConfirmActionRow>();
  for (const row of existing ?? []) {
    map.set(`${row.kind}:${row.id}`, row);
  }
  for (const row of incoming ?? []) {
    map.set(`${row.kind}:${row.id}`, row);
  }
  return Array.from(map.values());
}

export function mergeFillValues(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> {
  return { ...(existing ?? {}), ...(incoming ?? {}) };
}

/**
 * Upsert into SSOT inbox：同 request 覆盖；同环境连续 confirm 合并字段；
 * handover 双事件（blocked + handover）按 requestId 去重。
 */
export function upsertHumanInbox(
  current: PendingAgentHuman[],
  incoming: PendingAgentHuman,
): PendingAgentHuman[] {
  const key = humanItemKey(incoming);
  const existingIdx = current.findIndex((item) => humanItemKey(item) === key);
  if (existingIdx >= 0) {
    const prev = current[existingIdx];
    const next = [...current];
    next[existingIdx] = {
      ...prev,
      ...incoming,
      aiCopy: incoming.aiCopy ?? prev.aiCopy,
      screenshotBase64: incoming.screenshotBase64 ?? prev.screenshotBase64,
      actions:
        incoming.kind === "confirm"
          ? mergeConfirmActions(prev.actions, incoming.actions)
          : (incoming.actions ?? prev.actions),
      fillValues:
        incoming.kind === "confirm"
          ? mergeFillValues(prev.fillValues, incoming.fillValues)
          : (incoming.fillValues ?? prev.fillValues),
      reason: [prev.reason, incoming.reason].filter(Boolean).join(" · ") || incoming.reason,
      pausedAt: incoming.pausedAt ?? prev.pausedAt,
    };
    return next;
  }

  return [...current, incoming];
}

export function removeHumanFromInbox(
  current: PendingAgentHuman[],
  profileId: string,
  requestId?: string | null,
  kind?: AgentHumanKind | null,
): PendingAgentHuman[] {
  return current.filter((item) => {
    if (item.profileId !== profileId) {
      return true;
    }
    if (kind && item.kind !== kind) {
      return true;
    }
    if (!requestId) {
      return false;
    }
    return item.requestId !== requestId;
  });
}

export function pickCohortScreenshot(cohort: PendingAgentHuman[]): string | undefined {
  for (const item of cohort) {
    const shot = item.screenshotBase64?.trim();
    if (shot) {
      return shot;
    }
  }
  return undefined;
}

export function screenshotSrc(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("data:")) {
    return trimmed;
  }
  return `data:image/jpeg;base64,${trimmed}`;
}

export function formatAgentRouteBadge(
  mode: AgentRouteMode | "idle",
  batchIds: string[],
  focusId: string | null,
): { label: string; title: string } {
  if (mode === "idle" || batchIds.length === 0) {
    return {
      label: focusId ? `当前控制 #${focusId}` : "未绑定环境",
      title: focusId
        ? "智能填表 / 单开回放作用于焦点环境；Agent 未点名时操作「已勾选且已打开」的环境（仅限制 AI 并行数，打开浏览器不限）"
        : "请在左侧勾选并启动环境",
    };
  }
  if (mode === "broadcast") {
    return {
      label: `广播 ${batchIds.length} 个`,
      title: `未点名：已选且已打开的环境并行同一任务（#${batchIds.join("、#")}）`,
    };
  }
  return {
    label: `分派 ${batchIds.length} 个`,
    title: `点名分派：#${batchIds.join("、#")}`,
  };
}
