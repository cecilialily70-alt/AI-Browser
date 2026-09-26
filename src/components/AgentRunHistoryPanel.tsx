import { ChevronDown, ChevronRight, History, Loader2, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  batchDeleteAgentRuns,
  deleteAgentRun,
  getAgentRun,
  listAgentRuns,
  summarizeAgentRunBoard,
} from "../lib/tauri";
import type { AgentRun, AgentRunBoard, AgentRunThoughtLine } from "../types";
import { useAppDialog } from "./AppDialogProvider";

interface AgentRunHistoryPanelProps {
  /** 打开关联轨迹（若有 trajectory_id） */
  onOpenTrajectory?: (trajectoryId: number) => void;
  onError: (message: string) => void;
  /** 外部 bump 时重新拉取（如 agent-run-saved） */
  refreshToken?: number;
}

function parseThoughts(raw: string): AgentRunThoughtLine[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const row = item as Record<string, unknown>;
        const text = String(row.text ?? "").trim();
        if (!text) {
          return null;
        }
        return { ts: String(row.ts ?? ""), text };
      })
      .filter((item): item is AgentRunThoughtLine => Boolean(item));
  } catch {
    return [];
  }
}

function statusLabel(run: AgentRun): string {
  if (run.status === "running") {
    return "运行中";
  }
  if (run.status === "aborted") {
    return "已中止";
  }
  if (run.success === true || run.status === "complete") {
    return "成功";
  }
  return "失败";
}

function statusClass(run: AgentRun): string {
  if (run.status === "running") {
    return "bg-primary/10 text-primary-text";
  }
  if (run.success === true || run.status === "complete") {
    return "bg-success/10 text-success";
  }
  if (run.status === "aborted") {
    return "bg-secondary text-muted-foreground";
  }
  return "bg-destructive/10 text-destructive";
}

function formatTime(value?: string | null): string {
  if (!value) {
    return "—";
  }
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  return d.toLocaleString();
}

const FAILURE_LABELS: Record<string, string> = {
  "target-missing": "找不到目标",
  "stale-index": "编号过期",
  "blocked-by-overlay": "被遮挡",
  "frame-missing": "框架失效",
  "not-actionable": "不可交互",
  "no-effect": "未完成",
  navigation: "页面已跳转",
  timeout: "超时",
  "denied-by-user": "用户取消",
  "invalid-params": "参数不对",
  "policy-violation": "违反策略",
  unsupported: "当前不支持",
  "needs-human": "需要人工",
  "tool-error": "工具异常",
  aborted: "已中止",
  unclassified: "未分类",
  none: "无失败",
};

function failureLabel(id: string): string {
  return FAILURE_LABELS[id] ?? id;
}

function isBoardLabel(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,39}$/.test(value) && !/\d{4,}/.test(value);
}

function parseCountMap(raw?: string | null): Array<[string, number]> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    return Object.entries(parsed as Record<string, unknown>)
      .map(([key, value]) => [key, typeof value === "number" ? value : Number.NaN] as [string, number])
      .filter(([key, count]) => isBoardLabel(key) && Number.isFinite(count) && count > 0)
      .sort((a, b) => b[1] - a[1]);
  } catch {
    return [];
  }
}

function formatTokenCount(value?: number | null): string {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  return n.toLocaleString();
}

function formatUsdFromMicro(micro?: number | null): string {
  const usd = Math.max(0, Number(micro) || 0) / 1_000_000;
  if (usd === 0) {
    return "$0";
  }
  if (usd < 0.0001) {
    return `$${usd.toExponential(1)}`;
  }
  if (usd < 1) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

function formatRunUsage(run: AgentRun): string {
  const calls = Math.max(0, Math.floor(Number(run.llm_calls) || 0));
  const tokens = Math.max(0, Math.floor(Number(run.total_tokens) || 0));
  if (calls <= 0 && tokens <= 0) {
    return "无模型调用";
  }
  if (tokens <= 0) {
    return "用量未回报";
  }
  const rate = run.cost_used_default_rate ? " · 默认单价" : "";
  return `${formatTokenCount(tokens)} tok · 估算 ${formatUsdFromMicro(run.estimated_cost_micro_usd)}${rate}`;
}

function safeModel(value?: string | null): string {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:/-]{1,80}$/.test(text) || /sk-/i.test(text)) {
    return "";
  }
  return text;
}

function FailureChips({ title, counts }: { title: string; counts: Array<[string, number]> }) {
  if (counts.length === 0) {
    return <p className="mt-0.5">{title}：暂无</p>;
  }
  return (
    <p className="mt-0.5">
      {title}：{counts.map(([key, count]) => `${failureLabel(key)} ${count}`).join(" · ")}
    </p>
  );
}

/**
 * P4.3 / P5.4：可搜索 Agent Run History；可展开 thought，并看 token / 估算费用 / 失败分类。
 */
export function AgentRunHistoryPanel({
  onOpenTrajectory,
  onError,
  refreshToken = 0,
}: AgentRunHistoryPanelProps) {
  const { confirm } = useAppDialog();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [rows, setRows] = useState<AgentRun[]>([]);
  const [board, setBoard] = useState<AgentRunBoard | null>(null);
  const [boardNote, setBoardNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AgentRun | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);

  const allSelected = rows.length > 0 && selectedIds.length === rows.length;

  const refresh = useCallback(
    async (search = query) => {
      setLoading(true);
      try {
        const [list, summary] = await Promise.all([
          listAgentRuns(search, 120),
          summarizeAgentRunBoard().catch(() => null),
        ]);
        setRows(list);
        setSelectedIds((prev) => prev.filter((id) => list.some((run) => run.id === id)));
        setBoard(summary);
        setBoardNote(summary ? "" : "合计暂不可用，下面仍是运行记录");
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [onError, query],
  );

  useEffect(() => {
    void refresh(query);
  }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps -- mount + token bump

  const thoughts = useMemo(() => (detail ? parseThoughts(detail.thought_summary) : []), [detail]);

  const handleSearch = () => {
    const next = draft.trim();
    setQuery(next);
    void refresh(next);
  };

  const handleExpand = async (run: AgentRun) => {
    if (expandedId === run.id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(run.id);
    setDetailLoading(true);
    try {
      const full = await getAgentRun(run.id);
      setDetail(full);
    } catch (error) {
      setDetail(run);
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDelete = async (run: AgentRun) => {
    const label = run.goal.slice(0, 40) || run.run_id;
    const ok = await confirm({
      title: "删除运行记录",
      description: `确定删除「${label}」？不影响已保存的轨迹回放文件。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) {
      return;
    }
    try {
      await deleteAgentRun(run.id);
      setSelectedIds((prev) => prev.filter((id) => id !== run.id));
      if (expandedId === run.id) {
        setExpandedId(null);
        setDetail(null);
      }
      await refresh(query);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(rows.map((run) => run.id));
  };

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) {
      return;
    }
    const ok = await confirm({
      title: "批量删除运行记录",
      description: `确定删除选中的 ${selectedIds.length} 条记录？不影响已保存的轨迹回放文件。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) {
      return;
    }
    setBatchDeleting(true);
    try {
      const deleted = await batchDeleteAgentRuns(selectedIds);
      if (expandedId != null && selectedIds.includes(expandedId)) {
        setExpandedId(null);
        setDetail(null);
      }
      setSelectedIds([]);
      await refresh(query);
      if (deleted === 0) {
        onError("没有删除任何记录（可能已被清掉）");
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-sunken">
      <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 py-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-ui font-semibold text-foreground">
            <History size={13} className="shrink-0 text-primary" />
            运行历史
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="btn btn-outline btn-compact h-7 text-destructive hover:bg-destructive/10"
            onClick={() => void handleBatchDelete()}
            disabled={loading || batchDeleting || selectedIds.length === 0}
            title={selectedIds.length === 0 ? "先勾选要删除的记录" : `删除选中 ${selectedIds.length} 条`}
          >
            {batchDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            删除{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
          </button>
          <button
            type="button"
            className="btn btn-outline btn-compact h-7"
            onClick={() => void refresh(query)}
            disabled={loading || batchDeleting}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : "刷新"}
          </button>
        </div>
      </div>

      <div className="shrink-0 px-2.5 py-1.5 text-[10px] leading-4 text-muted-foreground">
        {board ? (
          <>
            <p className="truncate" title="本机估算，不同步，非账单">
              本机估算 · 已结束 {board.finished_count}/{board.run_count}
              {" · "}
              Token {formatTokenCount(board.total_tokens)}
              {" · "}
              {formatUsdFromMicro(board.estimated_cost_micro_usd)}
            </p>
            <FailureChips title="未完成" counts={parseCountMap(board.failure_classes)} />
            <FailureChips title="动作失败" counts={parseCountMap(board.failure_events)} />
          </>
        ) : (
          <p>{boardNote || "合计加载中…"}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            className="field-input h-7 pl-7 pr-2 text-[11px]"
            placeholder="搜索目标 / 域名 / 失败分类…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleSearch();
              }
            }}
          />
        </div>
        <button type="button" className="btn btn-outline btn-compact h-7" onClick={handleSearch}>
          搜索
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            {loading ? "加载中…" : "暂无运行记录"}
          </p>
        ) : (
          <>
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface-muted px-2 py-1.5">
              <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={loading || batchDeleting}
                  onChange={toggleSelectAll}
                />
                全选本页 · 已选 {selectedIds.length}/{rows.length}
              </label>
            </div>
            <ul className="space-y-1">
              {rows.map((run) => {
                const open = expandedId === run.id;
                const checked = selectedIds.includes(run.id);
                return (
                  <li
                    key={run.id}
                    className={`rounded-md px-2 py-1.5 transition-colors ${
                      checked ? "row-selected" : "row-selectable"
                    }`}
                  >
                    <div className="flex items-start gap-1.5">
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        checked={checked}
                        disabled={loading || batchDeleting}
                        onChange={() => toggleSelect(run.id)}
                        aria-label={`选择运行记录 ${run.id}`}
                      />
                      <button
                        type="button"
                        className="mt-0.5 shrink-0 text-muted-foreground"
                        onClick={() => void handleExpand(run)}
                        title={open ? "收起" : "展开 thought"}
                      >
                        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => void handleExpand(run)}
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`status-pill text-[10px] ${statusClass(run)}`}>
                            {statusLabel(run)}
                          </span>
                          {run.hitl_occurred ? <span className="badge badge-warning">HITL</span> : null}
                          {run.failure_class &&
                          run.failure_class !== "none" &&
                          isBoardLabel(run.failure_class) ? (
                            <span className="badge">{failureLabel(run.failure_class)}</span>
                          ) : null}
                          <span className="text-[10px] text-muted-foreground">
                            #{run.profile_id || "—"} · {run.step_count} 步
                            {run.domain ? ` · ${run.domain}` : ""}
                            {` · ${formatRunUsage(run)}`}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-caption text-foreground">
                          {run.goal || "（无目标）"}
                        </p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {formatTime(run.ended_at || run.started_at)}
                        </p>
                      </button>
                      <button
                        type="button"
                        className="icon-button h-6 w-6 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="删除记录"
                        disabled={batchDeleting}
                        onClick={() => void handleDelete(run)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    {open ? (
                      <div className="mt-1.5 pt-1.5 pl-5">
                        {detailLoading ? (
                          <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Loader2 size={11} className="animate-spin" /> 加载详情…
                          </p>
                        ) : (
                          <>
                            {detail?.summary ? (
                              <p className="mb-1 text-caption text-muted-foreground">
                                结果：{detail.summary}
                              </p>
                            ) : null}
                            {detail ? (
                              <p className="mb-1 text-[10px] text-muted-foreground">
                                {formatRunUsage(detail)}
                                {safeModel(detail.llm_model) ? ` · 模型 ${safeModel(detail.llm_model)}` : ""}
                              </p>
                            ) : null}
                            {detail && parseCountMap(detail.failure_counts).length > 0 ? (
                              <p className="mb-1 text-[10px] text-muted-foreground">
                                失败次数：
                                {parseCountMap(detail.failure_counts)
                                  .map(([key, count]) => `${failureLabel(key)} ${count}`)
                                  .join(" · ")}
                              </p>
                            ) : null}
                            {detail?.trajectory_id && onOpenTrajectory ? (
                              <button
                                type="button"
                                className="mb-1 text-caption text-primary-text underline-offset-2 hover:underline"
                                onClick={() => onOpenTrajectory(detail.trajectory_id!)}
                              >
                                打开关联轨迹 #{detail.trajectory_id}
                              </button>
                            ) : (
                              <p className="mb-1 text-[10px] text-muted-foreground">
                                无关联轨迹（未勾选录制或未成功录制）
                              </p>
                            )}
                            <div className="max-h-28 overflow-y-auto rounded-md bg-surface-muted px-2 py-1.5">
                              <p className="mb-1 text-[10px] font-medium text-muted-foreground">
                                Thought 摘要
                              </p>
                              {thoughts.length === 0 ? (
                                <p className="text-[10px] text-muted-foreground">（无）</p>
                              ) : (
                                <ul className="space-y-0.5">
                                  {thoughts.map((line, index) => (
                                    <li
                                      key={`${line.ts}-${index}`}
                                      className="text-[10px] leading-4 text-foreground/90"
                                    >
                                      {line.text}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
