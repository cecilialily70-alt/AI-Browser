import { useEffect, useMemo, useState } from "react";
import { Hand, HelpCircle, MonitorUp, Play, ShieldAlert, Square, TriangleAlert, X } from "lucide-react";

import {
  cohortKeyOf,
  mergeConfirmActions,
  pickCohortScreenshot,
  screenshotSrc,
  type PendingAgentHuman,
} from "../lib/agentHumanQueue";
import { AgentConfirmModal } from "./AgentConfirmModal";
import { useInterventionCenter } from "./InterventionCenterProvider";

function shortUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "（无 URL）";
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}${parsed.pathname.length > 40 ? `${parsed.pathname.slice(0, 37)}…` : parsed.pathname}`;
  } catch {
    return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
  }
}

function kindLabel(kind: PendingAgentHuman["kind"]): string {
  if (kind === "confirm") return "确认";
  if (kind === "ask") return "问答";
  return "接管";
}

function KindIcon({ kind }: { kind: PendingAgentHuman["kind"] }) {
  if (kind === "confirm") {
    return <ShieldAlert className="h-3.5 w-3.5 shrink-0" />;
  }
  if (kind === "ask") {
    return <HelpCircle className="h-3.5 w-3.5 shrink-0" />;
  }
  return <Hand className="h-3.5 w-3.5 shrink-0" />;
}

function CohortCard({
  cohort,
  busy,
  goError,
  askDraft,
  onAskDraftChange,
  onGo,
  onResume,
  onAbort,
  onDismiss,
  onOpenConfirm,
  onSubmitAsk,
}: {
  cohort: PendingAgentHuman[];
  busy: boolean;
  goError: string | null;
  askDraft: string;
  onAskDraftChange: (value: string) => void;
  onGo: () => void;
  onResume: () => void;
  onAbort: () => void;
  onDismiss: () => void;
  onOpenConfirm: () => void;
  onSubmitAsk: () => void;
}) {
  const representative = cohort[0];
  const kind = representative.kind;
  const idsLabel = cohort.map((item) => `#${item.profileId}`).join("、");
  const title =
    representative.aiCopy?.title?.trim() ||
    (kind === "confirm"
      ? `待确认 · ${idsLabel}`
      : kind === "ask"
        ? `需要信息 · ${idsLabel}`
        : `需人工接管 · ${idsLabel}`);
  const body =
    representative.aiCopy?.body?.trim() ||
    representative.question ||
    representative.reason ||
    (kind === "confirm"
      ? "请核对 Agent 拟执行的填表/点击。"
      : kind === "ask"
        ? "请补充验证码或其他信息。"
        : "AI 遇到验证码或无法继续，请手动处理后恢复。");
  const shot = pickCohortScreenshot(cohort);
  const mergeHint = cohort.length > 1 ? `同站同任务合并 · ${cohort.length} 个环境` : `环境 ${idsLabel}`;

  return (
    <div className="rounded-lg bg-raised/95 p-3 shadow-pop backdrop-blur-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-ui font-medium text-warning">
          <KindIcon kind={kind} />
          <span className="truncate">
            [{kindLabel(kind)}] {title}
          </span>
        </div>
        <button
          type="button"
          className="icon-button h-6 w-6 shrink-0"
          title="从收件箱移除（不中止 Agent）"
          onClick={onDismiss}
          disabled={busy}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mb-1 truncate font-mono text-[10px] text-muted-foreground" title={representative.url}>
        {mergeHint} · {shortUrl(representative.url)}
      </p>
      <p className="mb-2 line-clamp-4 whitespace-pre-wrap text-caption leading-5 text-foreground">{body}</p>
      {shot ? (
        <img
          src={screenshotSrc(shot)}
          alt="介入时页面截图"
          className="mb-2 max-h-28 w-full rounded-md object-cover object-top"
        />
      ) : null}

      {kind === "ask" ? (
        <div className="mb-2 space-y-1.5">
          <input
            type="text"
            className="field-input h-8 w-full text-ui"
            placeholder="短信 / 邮箱验证码或其他信息…"
            value={askDraft}
            onChange={(event) => onAskDraftChange(event.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="btn btn-primary btn-compact h-7"
            onClick={onSubmitAsk}
            disabled={busy || !askDraft.trim()}
          >
            {busy ? "…" : representative.aiCopy?.primaryButton?.trim() || "发送给 Agent"}
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="btn btn-outline btn-compact h-7"
          onClick={onGo}
          disabled={busy}
          title="唤起该环境浏览器到前台"
        >
          <MonitorUp className="h-3 w-3" />
          去处理
        </button>
        {kind === "confirm" ? (
          <button
            type="button"
            className="btn btn-primary btn-compact h-7"
            onClick={onOpenConfirm}
            disabled={busy}
          >
            {busy ? "…" : representative.aiCopy?.primaryButton?.trim() || "打开确认"}
          </button>
        ) : null}
        {kind === "handover" ? (
          <button
            type="button"
            className="btn btn-primary btn-compact h-7"
            onClick={onResume}
            disabled={busy}
          >
            <Play className="h-3 w-3" />
            {busy ? "…" : representative.aiCopy?.primaryButton?.trim() || "恢复执行"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-outline btn-compact h-7 text-destructive"
          onClick={onAbort}
          disabled={busy}
        >
          <Square className="h-3 w-3" />
          中止
        </button>
      </div>
      {goError ? (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-[10px] leading-4 text-destructive">
          无法置顶该环境窗口 · {goError}
        </p>
      ) : null}
    </div>
  );
}

/** 左下角统一介入收件箱（HITL SSOT）：切 Tab 仍常驻 */
export function InterventionCenterPanel() {
  const {
    cohorts,
    busyKeys,
    goErrors,
    pulseToken,
    resumeHandover,
    abortTasks,
    confirmTasks,
    cancelConfirm,
    replyAsk,
    goHandle,
    dismissTasks,
  } = useInterventionCenter();

  const [askDrafts, setAskDrafts] = useState<Record<string, string>>({});
  const [confirmCohortKey, setConfirmCohortKey] = useState<string | null>(null);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (pulseToken <= 0) {
      return;
    }
    setPulse(true);
    const timer = window.setTimeout(() => setPulse(false), 1600);
    return () => window.clearTimeout(timer);
  }, [pulseToken]);

  const activeConfirm = useMemo(() => {
    if (!confirmCohortKey) {
      return null;
    }
    return cohorts.find((cohort) => cohortKeyOf(cohort[0]) === confirmCohortKey) ?? null;
  }, [cohorts, confirmCohortKey]);

  useEffect(() => {
    if (!activeConfirm) {
      setConfirmCohortKey(null);
      return;
    }
    const merged: Record<string, string> = {};
    for (const item of activeConfirm) {
      Object.assign(merged, item.fillValues ?? {});
    }
    setFillValues(merged);
  }, [activeConfirm]);

  if (cohorts.length === 0) {
    return null;
  }

  const totalItems = cohorts.reduce((sum, cohort) => sum + cohort.length, 0);

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-[80] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      <div
        className={`pointer-events-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
          pulse ? "bg-warning/25 text-foreground" : "bg-warning/10 text-warning"
        }`}
      >
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
        介入收件箱 · {cohorts.length} 组 / {totalItems} 项
      </div>
      <div className="pointer-events-auto flex max-h-[min(56vh,480px)] flex-col gap-2 overflow-y-auto pr-0.5">
        {cohorts.map((cohort) => {
          const key = cohortKeyOf(cohort[0]);
          const busy = cohort.some((item) => busyKeys[`${item.kind}:${item.profileId}:${item.requestId}`]);
          const goError = goErrors[`${cohort[0].kind}:${cohort[0].profileId}:${cohort[0].requestId}`] ?? null;
          return (
            <CohortCard
              key={key}
              cohort={cohort}
              busy={busy}
              goError={goError}
              askDraft={askDrafts[key] ?? ""}
              onAskDraftChange={(value) => setAskDrafts((current) => ({ ...current, [key]: value }))}
              onGo={() => void goHandle(cohort[0])}
              onResume={() => void resumeHandover(cohort)}
              onAbort={() => void abortTasks(cohort)}
              onDismiss={() => dismissTasks(cohort)}
              onOpenConfirm={() => setConfirmCohortKey(key)}
              onSubmitAsk={() => {
                const answer = (askDrafts[key] ?? "").trim();
                if (!answer) {
                  return;
                }
                void replyAsk(cohort, answer).then(() => {
                  setAskDrafts((current) => {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  });
                });
              }}
            />
          );
        })}
      </div>

      {activeConfirm ? (
        <AgentConfirmModal
          open
          loading={confirmLoading}
          url={activeConfirm[0].url}
          reason={[
            activeConfirm.length > 1
              ? `同站同任务合并 · ${activeConfirm.map((item) => `#${item.profileId}`).join("、")}`
              : `环境 #${activeConfirm[0].profileId}`,
            activeConfirm[0].reason,
          ]
            .filter(Boolean)
            .join(" · ")}
          aiCopy={activeConfirm[0].aiCopy ?? null}
          actions={activeConfirm.reduce(
            (acc, item) => mergeConfirmActions(acc, item.actions),
            [] as NonNullable<PendingAgentHuman["actions"]>,
          )}
          fillValues={fillValues}
          onFillValueChange={(id, value) => setFillValues((current) => ({ ...current, [id]: value }))}
          onConfirm={() => {
            setConfirmLoading(true);
            void confirmTasks(activeConfirm, fillValues)
              .then(() => setConfirmCohortKey(null))
              .finally(() => setConfirmLoading(false));
          }}
          onCancel={() => {
            setConfirmLoading(true);
            void cancelConfirm(activeConfirm)
              .then(() => setConfirmCohortKey(null))
              .finally(() => setConfirmLoading(false));
          }}
        />
      ) : null}
    </div>
  );
}
