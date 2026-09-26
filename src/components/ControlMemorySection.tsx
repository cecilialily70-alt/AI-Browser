import { Brain, ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { clearAgentControlMemory, formatInvokeError, listAgentControlMemory } from "../lib/tauri";
import type { AgentControlMemory } from "../types";
import { useAppDialog } from "./AppDialogProvider";

interface ControlMemorySectionProps {
  /** 当前站点域名；为空时只能查看全量 */
  currentDomain: string;
}

type Scope = "domain" | "all";

function formatTime(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? trimmed : date.toLocaleString();
}

function describeTarget(row: AgentControlMemory): string {
  const selector = row.selector.trim();
  if (selector) {
    return selector;
  }
  if (Number.isFinite(row.x_percent ?? NaN) && Number.isFinite(row.y_percent ?? NaN)) {
    return `坐标 (${row.x_percent}%, ${row.y_percent}%)`;
  }
  return row.text_hint.trim() || "（无目标信息）";
}

/**
 * 同站控件记忆查看与清理。
 *
 * 这些记录由 Agent 成功操作后自动落库，并在每次开局注入 sidecar 作为定位先验。
 * 站点改版后旧选择器可能失效并拖慢定位，因此需要给用户一个可见、可清理的入口。
 */
export function ControlMemorySection({ currentDomain }: ControlMemorySectionProps) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AgentControlMemory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<Scope>("domain");
  const { confirm } = useAppDialog();

  const canScopeDomain = Boolean(currentDomain.trim());
  const effectiveScope: Scope = canScopeDomain ? scope : "all";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await listAgentControlMemory(effectiveScope === "domain" ? currentDomain : ""));
    } catch (invokeError) {
      setError(formatInvokeError(invokeError));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [currentDomain, effectiveScope]);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [load, open]);

  const handleClear = async () => {
    const scopeLabel = effectiveScope === "domain" ? `站点 ${currentDomain}` : "全部站点";
    const confirmed = await confirm({
      title: "清空控件记忆",
      description:
        `将删除${scopeLabel}的 ${rows.length} 条控件记忆。` +
        "删除后 Agent 需重新摸索控件位置（不会删除轨迹与模板）。是否继续？",
      confirmLabel: "清空",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    try {
      await clearAgentControlMemory(effectiveScope === "domain" ? currentDomain : "");
      await load();
    } catch (invokeError) {
      setError(formatInvokeError(invokeError));
    }
  };

  return (
    <div className="shrink-0 overflow-hidden rounded-lg bg-sunken">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
          )}
          <Brain size={13} className="shrink-0 text-primary" />
          <span className="text-ui font-semibold text-foreground">控件记忆</span>
          <span className="truncate text-[10px] text-muted-foreground">
            {open
              ? `${rows.length} 条 · ${effectiveScope === "domain" ? currentDomain : "全部站点"}`
              : "已记住的控件位置"}
          </span>
        </button>
        {open ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {canScopeDomain ? (
              <button
                type="button"
                className="btn btn-outline btn-compact h-7"
                title="切换统计范围"
                onClick={() => setScope((current) => (current === "domain" ? "all" : "domain"))}
              >
                {scope === "domain" ? "当前站" : "全部"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-outline btn-compact h-7 px-2"
              disabled={loading}
              onClick={() => void load()}
              title="读取"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              type="button"
              className="btn-icon-danger opacity-70 hover:opacity-100"
              disabled={loading || rows.length === 0}
              title="清空当前范围的全部控件记忆"
              aria-label="清空控件记忆"
              onClick={() => void handleClear()}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="">
          {error ? (
            <p className="px-2.5 py-2 text-caption leading-4 text-destructive">{error}</p>
          ) : rows.length === 0 ? (
            <p className="px-2.5 py-3 text-caption leading-4 text-muted-foreground">
              {loading ? "读取中…" : "暂无控件记忆"}
            </p>
          ) : (
            <ul className="max-h-[184px] overflow-y-auto">
              {rows.map((row) => (
                <li key={row.id} className="px-2.5 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-ui font-medium text-foreground" title={row.intent}>
                      {row.intent || "（未命名意图）"}
                    </span>
                    <span className="badge shrink-0">{row.kind || "click"}</span>
                  </div>
                  <div
                    className="mt-0.5 break-all font-mono text-[10px] leading-4 text-muted-foreground"
                    title={describeTarget(row)}
                  >
                    {describeTarget(row)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="truncate">{row.domain}</span>
                    <span className="shrink-0 tabular-nums">命中 {row.hit_count}</span>
                    <span className="shrink-0">{formatTime(row.updated_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
