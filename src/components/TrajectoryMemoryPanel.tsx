import { Grid3X3, History, Loader2, Play, Square, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { domainMatchesTemplate, normalizeDomain } from "../lib/domain";
import type { AgentTrajectory, Profile, TerminalLine } from "../types";
import { useAppDialog } from "./AppDialogProvider";
import { BatchReplaySandbox } from "./BatchReplaySandbox";
import { ControlMemorySection } from "./ControlMemorySection";
import { TerminalLog } from "./TerminalLog";

const REPLAY_LOG_HEIGHT_KEY = "ai-browser-replay-log-height";
const REPLAY_LOG_MIN = 96;
const REPLAY_LOG_MAX = 420;
const REPLAY_LOG_DEFAULT = 160;

interface TrajectoryMemoryPanelProps {
  currentDomain: string;
  boundProfileId: string | null;
  trajectories: AgentTrajectory[];
  selectedId: number | null;
  busy: boolean;
  envExecuting: boolean;
  busyReason?: string;
  executingId: number | null;
  profiles: Profile[];
  busyEnvIds: string[];
  /** 浏览器 Agent「录制执行轨迹」是否已勾选 */
  recordingEnabled?: boolean;
  /** 回放专用日志（不与 Agent Monitor 共用） */
  monitorLines: TerminalLine[];
  onClearMonitor?: () => void;
  onSelect: (id: number) => void;
  onRefresh: () => void;
  onDelete: (trajectory: AgentTrajectory) => void;
  onExecute: (trajectory: AgentTrajectory) => void;
  /** 回放进行中：停止当前回放 */
  onStop: () => void;
  /** 沙盘/单开回放时同步「执行→停止」按钮状态 */
  onExecutingIdChange?: (id: number | null) => void;
  /** 沙盘派发结束：仅当仍是该轨迹时清除执行态 */
  onClearExecutingId?: (trajectoryId: number) => void;
  /** 跳转到浏览器 Agent 并引导勾选录制 */
  onOpenAgentForRecording?: () => void;
  onError: (message: string) => void;
  onLog: (tone: "info" | "success" | "error" | "warn", text: string) => void;
  onEnvTrajectoryBusy: (profileId: string, busy: boolean) => void;
}

/** 轨迹动作字段名在 sidecar 各链路间不统一（type / action / kind），统一解析避免漏显。 */
function actionKind(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }
  const step = raw as Record<string, unknown>;
  return String(step.type ?? step.action ?? step.kind ?? "")
    .trim()
    .toLowerCase();
}

const ACTION_KIND_LABELS: Record<string, string> = {
  fill: "填写",
  click: "点击",
  click_point: "坐标点击",
  select: "选择",
  navigate: "跳转",
  wait: "等待",
  press: "按键",
  keypress: "按键",
  scroll: "滚动",
};

interface ParsedActionStep {
  index: number;
  kindLabel: string;
  detail: string;
}

function truncateText(value: string, max = 72): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

function formatActionDetail(raw: unknown, kind: string): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }
  const step = raw as Record<string, unknown>;
  const selector = String(step.selector ?? "").trim();
  const value = String(step.value ?? "").trim();
  const url = String(step.url ?? "").trim();
  const dataKey = String(step.dataKey ?? "").trim();

  if (kind === "navigate") {
    return truncateText(url || value || selector || "（无 URL）");
  }
  if (kind === "wait") {
    return truncateText(value ? `${value} ms` : "等待");
  }
  if (kind === "fill" || kind === "select") {
    const label = String(step.semanticLabel ?? step.label ?? "").trim();
    // 敏感字段落盘时已脱敏：不展示掩码，明确告知需回放时补齐
    const shownValue = step.redacted ? "（已脱敏，回放时需重新提供）" : value;
    const parts = [
      label ? `【${label}】` : "",
      selector,
      shownValue ? `= ${shownValue}` : "",
      dataKey ? `(${dataKey})` : "",
    ].filter(Boolean);
    return truncateText(parts.join(" ") || "（无目标）");
  }
  if (kind === "click" || kind === "press" || kind === "keypress") {
    const label = String(step.semanticLabel ?? step.label ?? "").trim();
    return truncateText(label || selector || value || "（无目标）");
  }
  if (kind === "click_point") {
    const label = String(step.semanticLabel ?? step.label ?? "").trim();
    const fallback = String(step.primarySelector ?? step.fallbackSelector ?? "").trim();
    const coords = (step.fallbackCoordinates as { x?: number; y?: number } | undefined) ?? {};
    const x = coords.x ?? step.x;
    const y = coords.y ?? step.y;
    const coordText = Number.isFinite(Number(x)) && Number.isFinite(Number(y)) ? `@(${x},${y})` : "";
    return truncateText(
      [label ? `【${label}】` : "", fallback || selector, coordText].filter(Boolean).join(" ") ||
        "（坐标点击）",
    );
  }
  if (kind === "scroll") {
    return truncateText(value || "滚动");
  }
  return truncateText([selector, value, url].filter(Boolean).join(" ") || "（无详情）");
}

/** 展开轨迹中的每一步动作（不再汇总成「填写×N」）。 */
function listActionSteps(row: AgentTrajectory): ParsedActionStep[] {
  let parsed: unknown[] = [];
  try {
    const raw = JSON.parse(row.actions) as unknown;
    parsed = Array.isArray(raw) ? raw : [];
  } catch {
    parsed = [];
  }

  return parsed.map((raw, index) => {
    const kind = actionKind(raw);
    return {
      index: index + 1,
      kindLabel: ACTION_KIND_LABELS[kind] ?? (kind || "动作"),
      detail: formatActionDetail(raw, kind),
    };
  });
}

function stepCountLabel(row: AgentTrajectory, steps: ParsedActionStep[]): number {
  if (steps.length > 0) {
    return steps.length;
  }
  return typeof row.step_count === "number" && row.step_count > 0 ? row.step_count : 0;
}

function formatTime(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return trimmed;
  }
  return date.toLocaleString();
}

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("://")) {
    return normalizeDomain(trimmed);
  }
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
}

function isDomainMatch(currentDomain: string, rowDomain: string): boolean {
  const current = normalizeHost(currentDomain);
  if (!current) {
    return false;
  }
  return domainMatchesTemplate(current, normalizeHost(rowDomain));
}

/**
 * 全局 RPA 资产库排序：无域名 → 全量；有域名 → 匹配项置顶，其余保留在下方。
 */
function sortTrajectoriesForLibrary(
  rows: AgentTrajectory[],
  currentDomain: string,
): { rows: AgentTrajectory[]; matchedCount: number } {
  if (!rows.length) {
    return { rows: [], matchedCount: 0 };
  }
  const domain = normalizeHost(currentDomain);
  if (!domain) {
    return { rows: [...rows], matchedCount: 0 };
  }

  const matched: AgentTrajectory[] = [];
  const rest: AgentTrajectory[] = [];
  for (const row of rows) {
    if (isDomainMatch(domain, row.domain)) {
      matched.push(row);
    } else {
      rest.push(row);
    }
  }
  return { rows: [...matched, ...rest], matchedCount: matched.length };
}

function clampLogHeight(value: number): number {
  return Math.min(REPLAY_LOG_MAX, Math.max(REPLAY_LOG_MIN, Math.round(value)));
}

function readStoredLogHeight(): number {
  try {
    const raw = localStorage.getItem(REPLAY_LOG_HEIGHT_KEY);
    if (!raw) {
      return REPLAY_LOG_DEFAULT;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampLogHeight(parsed) : REPLAY_LOG_DEFAULT;
  } catch {
    return REPLAY_LOG_DEFAULT;
  }
}

/**
 * 轨迹记忆：全局资产库 + 域名置顶 + 沙盘解耦
 */
export function TrajectoryMemoryPanel({
  currentDomain,
  boundProfileId,
  trajectories,
  selectedId,
  busy,
  envExecuting,
  busyReason = "",
  executingId,
  profiles,
  busyEnvIds,
  recordingEnabled = false,
  monitorLines,
  onClearMonitor,
  onSelect,
  onRefresh,
  onDelete,
  onExecute,
  onStop,
  onExecutingIdChange,
  onClearExecutingId,
  onOpenAgentForRecording,
  onError,
  onLog,
  onEnvTrajectoryBusy,
}: TrajectoryMemoryPanelProps) {
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [sandboxTrajectory, setSandboxTrajectory] = useState<AgentTrajectory | null>(null);
  const [logHeight, setLogHeight] = useState(readStoredLogHeight);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const { confirm } = useAppDialog();

  const { rows: libraryRows, matchedCount } = useMemo(
    () => sortTrajectoriesForLibrary(trajectories, currentDomain),
    [trajectories, currentDomain],
  );

  const hasBoundEnv = Boolean(boundProfileId);
  const executeLocked = busy || envExecuting;

  useEffect(() => {
    try {
      localStorage.setItem(REPLAY_LOG_HEIGHT_KEY, String(logHeight));
    } catch {
      /* ignore */
    }
  }, [logHeight]);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragRef.current = { startY: event.clientY, startHeight: logHeight };
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        // 向上拖 → 增高日志区
        const next = clampLogHeight(drag.startHeight + (drag.startY - moveEvent.clientY));
        setLogHeight(next);
      };
      const onUp = (upEvent: PointerEvent) => {
        dragRef.current = null;
        target.releasePointerCapture(upEvent.pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [logHeight],
  );

  const openSandbox = (row: AgentTrajectory) => {
    onSelect(row.id);
    setSandboxTrajectory(row);
    setSandboxOpen(true);
  };

  const handleDeleteClick = async (row: AgentTrajectory) => {
    const label = row.title || row.goal || row.file_name || "未命名轨迹";
    const confirmed = await confirm({
      title: "删除轨迹",
      description: `确定删除「${label}」？此操作不可撤销。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (confirmed) {
      onDelete(row);
    }
  };

  const handleExecuteClick = (row: AgentTrajectory) => {
    onSelect(row.id);
    if (!boundProfileId) {
      onError("请先在左侧选择或启动一个环境后再执行单开回放");
      return;
    }
    if (executeLocked) {
      onError(
        envExecuting
          ? `当前环境正忙${busyReason ? `（${busyReason}）` : ""}，请先停止任务后再执行`
          : "当前环境正忙，请稍后再执行",
      );
      return;
    }
    onExecute(row);
  };

  const headerHint = hasBoundEnv
    ? `全局 ${libraryRows.length} 条 · 环境 #${boundProfileId}${
        currentDomain
          ? ` · 当前站 ${currentDomain} 同站 ${matchedCount} 条置顶`
          : " · 浏览器未打开亦可浏览全部"
      }`
    : `全局 ${libraryRows.length} 条 · 未绑定环境亦可浏览全部；有当前站时同站置顶`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2 pt-2">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2 pb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-ui-lg font-semibold tracking-tight text-foreground">
            <History size={14} className="shrink-0 text-primary" />
            已记忆的网站流程
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{headerHint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`badge ${recordingEnabled ? "badge-success" : ""}`}
            title={
              recordingEnabled
                ? "浏览器 Agent 已勾选「录制轨迹」：成功结束后写入本库"
                : "未勾选录制：不回写轨迹，运行摘要仍会保存"
            }
          >
            {recordingEnabled ? "录制 · 开" : "录制 · 关"}
          </span>
          <button type="button" className="btn btn-outline btn-compact h-7" onClick={onRefresh}>
            刷新
          </button>
        </div>
      </div>

      {!recordingEnabled ? (
        <div className="mb-2 flex shrink-0 items-start justify-between gap-2 rounded-md bg-warning/15 px-2.5 py-2">
          <p className="min-w-0 text-[11px] leading-4 text-muted-foreground">
            回放轨迹仅来自勾选
            <span className="mx-0.5 font-medium text-foreground">录制轨迹</span>
            且任务成功；运行历史仍会自动保存摘要。
          </p>
          {onOpenAgentForRecording ? (
            <button
              type="button"
              className="btn btn-outline btn-compact h-7"
              onClick={onOpenAgentForRecording}
            >
              去开启
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-sunken">
          {libraryRows.length === 0 ? (
            <div className="flex h-full min-h-[100px] items-center justify-center px-5 py-8">
              <div className="max-w-[340px] text-center">
                <p className="text-ui font-medium text-foreground">还没有可回放的轨迹</p>
                <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
                  勾选「录制轨迹」跑通一次成功任务后，流程会保存在这里，可单开回放或沙盘分发。
                </p>
                {onOpenAgentForRecording ? (
                  <button
                    type="button"
                    className="btn btn-primary mt-3 h-8 px-3 text-[11px]"
                    onClick={onOpenAgentForRecording}
                  >
                    {recordingEnabled ? "去跑 Agent" : "先开启录制，再启动 Agent"}
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <ul className="">
              {libraryRows.map((row) => {
                const active = row.id === selectedId;
                const steps = listActionSteps(row);
                const stepTotal = stepCountLabel(row, steps);
                const rowBusy = executingId === row.id;
                const intent = row.goal || row.title || row.file_name || "未命名轨迹";
                const domainLabel = normalizeHost(row.domain) || row.domain || "unknown";
                const pinned = Boolean(currentDomain) && isDomainMatch(currentDomain, row.domain);

                return (
                  <li
                    key={`${row.source ?? "row"}-${row.id}-${row.file_path ?? ""}`}
                    className={`group flex items-start gap-2 px-2.5 py-2.5 transition-colors ${
                      pinned
                        ? "bg-primary/10 shadow-[inset_2px_0_0_0_hsl(var(--primary))]"
                        : active
                          ? "row-selected"
                          : "row-selectable"
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 py-0.5 text-left"
                      onClick={() => onSelect(row.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="truncate text-ui font-semibold text-foreground"
                            title={domainLabel}
                          >
                            {domainLabel}
                          </span>
                          {pinned ? <span className="badge badge-primary shrink-0">同站置顶</span> : null}
                        </div>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {stepTotal} 步
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{intent}</div>
                      {steps.length > 0 ? (
                        <ol className="mt-1.5 space-y-0.5">
                          {steps.map((step) => (
                            <li
                              key={`${row.id}-step-${step.index}`}
                              className="flex items-start gap-1.5 text-[10px] leading-4 text-muted-foreground"
                            >
                              <span className="shrink-0 tabular-nums text-muted-foreground">
                                {step.index}.
                              </span>
                              <span className="shrink-0 rounded bg-secondary px-1 py-px font-medium text-foreground">
                                {step.kindLabel}
                              </span>
                              <span className="min-w-0 break-all" title={step.detail}>
                                {step.detail}
                              </span>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {row.file_name ? `${row.file_name} · ` : ""}
                        {formatTime(row.created_at)}
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-1 pt-0.5">
                      {rowBusy ? (
                        <button
                          type="button"
                          className="btn h-7 px-2.5 text-[11px] bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          title="停止当前回放"
                          onClick={(event) => {
                            event.stopPropagation();
                            onStop();
                          }}
                        >
                          <Square size={12} />
                          停止
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary h-7 px-2.5 text-[11px]"
                          disabled={hasBoundEnv && executeLocked}
                          title={
                            !hasBoundEnv
                              ? "请先在左侧选择或启动环境后再单开回放"
                              : executeLocked
                                ? `当前环境正忙${busyReason ? `（${busyReason}）` : ""}`
                                : "跳过 LLM，在当前绑定环境回放"
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            handleExecuteClick(row);
                          }}
                        >
                          {busy && executingId === row.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Play size={12} />
                          )}
                          执行
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-outline btn-compact h-7"
                        title="多环境数据分发：未绑定环境也可先打开沙盘规划"
                        onClick={(event) => {
                          event.stopPropagation();
                          openSandbox(row);
                        }}
                      >
                        <Grid3X3 size={12} />
                        沙盘
                      </button>
                      <button
                        type="button"
                        className="btn-icon-danger opacity-60 group-hover:opacity-100"
                        title="删除此轨迹"
                        aria-label="删除轨迹"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteClick(row);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <ControlMemorySection currentDomain={currentDomain} />

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整回放日志高度"
          title="拖动调整回放日志高度"
          className="group flex h-2.5 shrink-0 cursor-ns-resize items-center justify-center"
          onPointerDown={onResizePointerDown}
        >
          <span className="h-0.5 w-10 rounded-full bg-border transition-colors group-hover:bg-primary/50" />
        </div>

        <div className="shrink-0 flex-none overflow-hidden" style={{ height: logHeight }}>
          <TerminalLog
            lines={monitorLines}
            title="回放日志"
            emptyHint="回放日志（独立于监视日志）"
            className="h-full"
            onClear={onClearMonitor}
          />
        </div>
      </div>

      <BatchReplaySandbox
        open={sandboxOpen}
        trajectory={sandboxTrajectory}
        profiles={profiles}
        busyEnvIds={busyEnvIds}
        onClose={() => {
          setSandboxOpen(false);
          setSandboxTrajectory(null);
        }}
        onError={onError}
        onLog={onLog}
        onEnvTrajectoryBusy={onEnvTrajectoryBusy}
        onDispatchStart={(trajectoryId) => {
          onSelect(trajectoryId);
          onExecutingIdChange?.(trajectoryId);
        }}
        onDispatchEnd={(trajectoryId) => {
          onClearExecutingId?.(trajectoryId);
        }}
      />
    </div>
  );
}
