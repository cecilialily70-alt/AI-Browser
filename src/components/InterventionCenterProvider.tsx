import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";

import {
  buildPendingHuman,
  groupHumanInbox,
  humanItemKey,
  removeHumanFromInbox,
  upsertHumanInbox,
  type AgentHumanKind,
  type PendingAgentHuman,
} from "../lib/agentHumanQueue";
import { normalizeHitlAiCopy } from "../lib/hitlAiCopy";
import { createLogger } from "../lib/logger";
import {
  abortAutonomousAgent,
  bringProfileToFront,
  cancelAgentAction,
  confirmAgentAction,
  continueAgentHandover,
  formatInvokeError,
  replyAgentAsk,
} from "../lib/tauri";
import type { AgentConfirmActionRow } from "./AgentConfirmModal";

const logger = createLogger("InterventionCenter");

/** @deprecated 兼容旧 Panel 引用；统一使用 PendingAgentHuman */
export type BlockedTask = PendingAgentHuman;

interface InterventionCenterValue {
  /** SSOT 介入队列（confirm / ask / handover） */
  inbox: PendingAgentHuman[];
  /** 按同站同任务合并后的 cohort 列表 */
  cohorts: PendingAgentHuman[][];
  busyKeys: Record<string, boolean>;
  goErrors: Record<string, string>;
  /** 深链高亮：抽屉可触发，避免第二套弹窗 */
  pulseToken: number;
  registerAgentGoals: (goalByProfile: Record<string, string>) => void;
  pulseInbox: () => void;
  resumeHandover: (cohort: PendingAgentHuman[]) => Promise<void>;
  abortTasks: (cohort: PendingAgentHuman[]) => Promise<void>;
  confirmTasks: (cohort: PendingAgentHuman[], fillValues: Record<string, string>) => Promise<void>;
  cancelConfirm: (cohort: PendingAgentHuman[]) => Promise<void>;
  replyAsk: (cohort: PendingAgentHuman[], answer: string) => Promise<void>;
  goHandle: (task: PendingAgentHuman) => Promise<void>;
  dismissTasks: (cohort: PendingAgentHuman[]) => void;
}

const InterventionCenterContext = createContext<InterventionCenterValue | null>(null);

function taskBusyKey(item: Pick<PendingAgentHuman, "kind" | "profileId" | "requestId">): string {
  return humanItemKey(item);
}

function pickScreenshot(payload: Record<string, unknown>): string | undefined {
  const raw = payload.screenshotBase64 ?? payload.screenshot_base64 ?? payload.screenshot ?? null;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function attachListen<T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
  cancelled: () => boolean,
  unlistenFns: Array<() => void>,
): void {
  void listen<T>(eventName, handler)
    .then((fn) => {
      if (cancelled()) {
        fn();
      } else {
        unlistenFns.push(fn);
      }
    })
    .catch((error) => {
      logger.error(`listen ${eventName} failed`, error);
    });
}

export function InterventionCenterProvider({ children }: { children: ReactNode }) {
  const [inbox, setInbox] = useState<PendingAgentHuman[]>([]);
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});
  const [goErrors, setGoErrors] = useState<Record<string, string>>({});
  const [pulseToken, setPulseToken] = useState(0);
  const goalByProfileRef = useRef<Record<string, string>>({});

  const registerAgentGoals = useCallback((next: Record<string, string>) => {
    goalByProfileRef.current = { ...goalByProfileRef.current, ...next };
  }, []);

  const pulseInbox = useCallback(() => {
    setPulseToken((n) => n + 1);
  }, []);

  const enqueue = useCallback((item: PendingAgentHuman) => {
    if (!item.profileId || !item.requestId) {
      return;
    }
    setInbox((current) => upsertHumanInbox(current, item));
  }, []);

  const removeItems = useCallback(
    (profileId: string, requestId?: string | null, kind?: AgentHumanKind | null) => {
      setInbox((current) => removeHumanFromInbox(current, profileId, requestId, kind));
      setBusyKeys((current) => {
        const next = { ...current };
        for (const key of Object.keys(next)) {
          if (requestId && kind) {
            if (key === taskBusyKey({ kind, profileId, requestId })) {
              delete next[key];
            }
          } else if (requestId) {
            if (key.includes(`:${profileId}:${requestId}`)) {
              delete next[key];
            }
          } else if (key.includes(`:${profileId}:`)) {
            delete next[key];
          }
        }
        return next;
      });
      setGoErrors((current) => {
        const next = { ...current };
        for (const key of Object.keys(next)) {
          if (requestId && kind) {
            if (key === taskBusyKey({ kind, profileId, requestId })) {
              delete next[key];
            }
          } else if (requestId) {
            if (key.includes(`:${profileId}:${requestId}`)) {
              delete next[key];
            }
          } else if (key.includes(`:${profileId}:`)) {
            delete next[key];
          }
        }
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];
    const isCancelled = () => cancelled;

    const resolveGoal = (profileId: string) => goalByProfileRef.current[profileId] ?? "";

    attachListen<{
      profileId?: string;
      requestId?: string;
      url?: string;
      reason?: string;
      actions?: AgentConfirmActionRow[];
      ai_copy?: unknown;
      screenshotBase64?: string;
      screenshot_base64?: string;
      screenshot?: string;
    }>(
      "agent-confirm-required",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const requestId = String(event.payload.requestId ?? "").trim();
        if (!profileId || !requestId) {
          logger.warn("agent-confirm-required missing profileId/requestId, ignored");
          return;
        }
        const actions = Array.isArray(event.payload.actions) ? event.payload.actions : [];
        const fillValues: Record<string, string> = {};
        for (const action of actions) {
          if (action.kind === "fill") {
            fillValues[action.id] = action.value ?? "";
          }
        }
        enqueue(
          buildPendingHuman({
            profileId,
            kind: "confirm",
            requestId,
            url: event.payload.url,
            goalKey: resolveGoal(profileId),
            reason: event.payload.reason,
            aiCopy: normalizeHitlAiCopy(event.payload.ai_copy),
            actions,
            fillValues,
            screenshotBase64: pickScreenshot(event.payload as Record<string, unknown>),
            pausedAt: new Date().toISOString(),
          }),
        );
      },
      isCancelled,
      unlistenFns,
    );

    attachListen<{
      profileId?: string;
      requestId?: string;
      question?: string;
      url?: string;
      ai_copy?: unknown;
      screenshotBase64?: string;
      screenshot?: string;
    }>(
      "agent-ask-user",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const requestId = String(event.payload.requestId ?? "").trim();
        if (!profileId || !requestId) {
          logger.warn("agent-ask-user missing profileId/requestId, ignored");
          return;
        }
        enqueue(
          buildPendingHuman({
            profileId,
            kind: "ask",
            requestId,
            url: event.payload.url,
            goalKey: resolveGoal(profileId),
            question: event.payload.question ?? "请补充信息",
            reason: event.payload.question,
            aiCopy: normalizeHitlAiCopy(event.payload.ai_copy),
            screenshotBase64: pickScreenshot(event.payload as Record<string, unknown>),
            pausedAt: new Date().toISOString(),
          }),
        );
      },
      isCancelled,
      unlistenFns,
    );

    const ingestHandover = (payload: {
      profileId?: string;
      requestId?: string;
      url?: string;
      reason?: string;
      pausedAt?: string;
      ai_copy?: unknown;
      screenshotBase64?: string;
      screenshot?: string;
    }) => {
      const profileId = String(payload.profileId ?? "").trim();
      const requestId = String(payload.requestId ?? "").trim();
      if (!profileId || !requestId) {
        logger.warn("handover/blocked missing profileId/requestId, ignored");
        return;
      }
      enqueue(
        buildPendingHuman({
          profileId,
          kind: "handover",
          requestId,
          url: payload.url,
          goalKey: resolveGoal(profileId),
          reason: payload.reason ?? "需要人工接管",
          aiCopy: normalizeHitlAiCopy(payload.ai_copy),
          screenshotBase64: pickScreenshot(payload as Record<string, unknown>),
          pausedAt: String(payload.pausedAt ?? new Date().toISOString()),
        }),
      );
    };

    type HandoverPayload = {
      profileId?: string;
      requestId?: string;
      url?: string;
      reason?: string;
      pausedAt?: string;
      ai_copy?: unknown;
      screenshotBase64?: string;
      screenshot?: string;
    };

    attachListen<HandoverPayload>(
      "agent-task-blocked",
      (event) => ingestHandover(event.payload),
      isCancelled,
      unlistenFns,
    );
    attachListen<HandoverPayload>(
      "agent-handover-required",
      (event) => ingestHandover(event.payload),
      isCancelled,
      unlistenFns,
    );

    attachListen<{
      profileId?: string;
      requestId?: string | null;
      aborted?: boolean;
    }>(
      "agent-task-resumed",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        if (!profileId) {
          logger.warn("agent-task-resumed missing profileId, ignored");
          return;
        }
        const requestId = event.payload.requestId ? String(event.payload.requestId).trim() : null;
        removeItems(profileId, requestId, requestId ? "handover" : null);
      },
      isCancelled,
      unlistenFns,
    );

    attachListen<{
      profileId?: string;
      state?: string;
      msg?: string;
    }>(
      "agent-state",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const state = String(event.payload.state ?? "");
        if (!profileId) {
          logger.warn("agent-state missing profileId, ignored");
          return;
        }
        if (state === "complete" || state === "failed" || state === "aborted" || state === "stopped") {
          removeItems(profileId, null, null);
        }
      },
      isCancelled,
      unlistenFns,
    );

    attachListen<{
      profileId?: string;
      profile_id?: string;
      state?: string;
    }>(
      "rpa-state",
      (event) => {
        const profileId = String(event.payload.profileId ?? event.payload.profile_id ?? "").trim();
        const state = String(event.payload.state ?? "").toLowerCase();
        if (!profileId) {
          logger.warn("rpa-state missing profileId, ignored");
          return;
        }
        if (
          state === "failed" ||
          state === "aborted" ||
          state === "complete" ||
          state === "stopped" ||
          state === "error"
        ) {
          removeItems(profileId, null, null);
        }
      },
      isCancelled,
      unlistenFns,
    );

    attachListen<{
      profileId?: string;
      status?: string;
    }>(
      "browser-status",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const status = String(event.payload.status ?? "").toLowerCase();
        if (!profileId) {
          logger.warn("browser-status missing profileId, ignored");
          return;
        }
        if (status === "stopped" || status === "exited" || status === "crashed") {
          removeItems(profileId, null, null);
        }
      },
      isCancelled,
      unlistenFns,
    );

    return () => {
      cancelled = true;
      for (const fn of unlistenFns) {
        fn();
      }
    };
  }, [enqueue, removeItems]);

  const withBusy = useCallback(async (cohort: PendingAgentHuman[], work: () => Promise<void>) => {
    const keys = cohort.map((item) => taskBusyKey(item));
    setBusyKeys((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      return next;
    });
    try {
      await work();
    } finally {
      setBusyKeys((current) => {
        const next = { ...current };
        for (const key of keys) {
          delete next[key];
        }
        return next;
      });
    }
  }, []);

  const resumeHandover = useCallback(
    async (cohort: PendingAgentHuman[]) => {
      const items = cohort.filter((item) => item.kind === "handover");
      if (items.length === 0) {
        return;
      }
      await withBusy(items, async () => {
        await Promise.all(items.map((item) => continueAgentHandover(item.profileId, item.requestId)));
        for (const item of items) {
          removeItems(item.profileId, item.requestId, "handover");
        }
      });
    },
    [removeItems, withBusy],
  );

  const abortTasks = useCallback(
    async (cohort: PendingAgentHuman[]) => {
      if (cohort.length === 0) {
        return;
      }
      await withBusy(cohort, async () => {
        const profileIds = [...new Set(cohort.map((item) => item.profileId))];
        await Promise.allSettled(profileIds.map((id) => abortAutonomousAgent(id)));
        for (const id of profileIds) {
          removeItems(id, null, null);
        }
      });
    },
    [removeItems, withBusy],
  );

  const confirmTasks = useCallback(
    async (cohort: PendingAgentHuman[], fillValues: Record<string, string>) => {
      const items = cohort.filter((item) => item.kind === "confirm");
      if (items.length === 0) {
        return;
      }
      await withBusy(items, async () => {
        await Promise.all(
          items.map((item) => confirmAgentAction(item.profileId, item.requestId, fillValues)),
        );
        for (const item of items) {
          removeItems(item.profileId, item.requestId, "confirm");
        }
      });
    },
    [removeItems, withBusy],
  );

  const cancelConfirm = useCallback(
    async (cohort: PendingAgentHuman[]) => {
      const items = cohort.filter((item) => item.kind === "confirm");
      if (items.length === 0) {
        return;
      }
      await withBusy(items, async () => {
        await Promise.allSettled(items.map((item) => cancelAgentAction(item.profileId, item.requestId)));
        for (const item of items) {
          removeItems(item.profileId, item.requestId, "confirm");
        }
      });
    },
    [removeItems, withBusy],
  );

  const replyAsk = useCallback(
    async (cohort: PendingAgentHuman[], answer: string) => {
      const items = cohort.filter((item) => item.kind === "ask");
      if (items.length === 0) {
        return;
      }
      await withBusy(items, async () => {
        await Promise.all(items.map((item) => replyAgentAsk(item.profileId, item.requestId, answer)));
        for (const item of items) {
          removeItems(item.profileId, item.requestId, "ask");
        }
      });
    },
    [removeItems, withBusy],
  );

  const goHandle = useCallback(async (task: PendingAgentHuman) => {
    const key = taskBusyKey(task);
    try {
      await bringProfileToFront(task.profileId);
      setGoErrors((current) => {
        if (!(key in current)) {
          return current;
        }
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (error) {
      const message = formatInvokeError(error);
      logger.warn("bring to front failed", message);
      setGoErrors((current) => ({ ...current, [key]: message }));
    }
  }, []);

  const dismissTasks = useCallback(
    (cohort: PendingAgentHuman[]) => {
      for (const item of cohort) {
        removeItems(item.profileId, item.requestId, item.kind);
      }
    },
    [removeItems],
  );

  const cohorts = useMemo(() => groupHumanInbox(inbox), [inbox]);

  const value = useMemo(
    () => ({
      inbox,
      cohorts,
      busyKeys,
      goErrors,
      pulseToken,
      registerAgentGoals,
      pulseInbox,
      resumeHandover,
      abortTasks,
      confirmTasks,
      cancelConfirm,
      replyAsk,
      goHandle,
      dismissTasks,
    }),
    [
      abortTasks,
      busyKeys,
      cancelConfirm,
      cohorts,
      confirmTasks,
      dismissTasks,
      goErrors,
      goHandle,
      inbox,
      pulseInbox,
      pulseToken,
      registerAgentGoals,
      replyAsk,
      resumeHandover,
    ],
  );

  return <InterventionCenterContext.Provider value={value}>{children}</InterventionCenterContext.Provider>;
}

export function useInterventionCenter(): InterventionCenterValue {
  const ctx = useContext(InterventionCenterContext);
  if (!ctx) {
    throw new Error("useInterventionCenter must be used within InterventionCenterProvider");
  }
  return ctx;
}
