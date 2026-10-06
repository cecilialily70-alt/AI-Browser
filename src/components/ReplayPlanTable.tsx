/**
 * N13 · 执行计划确认表（预检单 / Run Plan）—— 执行计划.md §4.6.4 / §8.2 ⑦。
 *
 * 这个组件的唯一职责是「让人在开跑前看清并改好将要精确执行的每一轮」：
 *   - 汇总条：`2 环境 × 10 轮 = 20 次 · 计划新建 20 个标签 · 并发 4`（N13-a）
 *   - 红条 / 黄条：红条禁止启动，黄条不拦但必须可见（不折叠、不静默）
 *   - 逐行可改：换用第 N 行 / 改成生成 / 跳过这一轮 / 改标签策略（§4.6.5）
 *
 * 它是**纯展示 + 回调**：不自己算 hash、不自己改 plan —— 每次修改都回给父组件，
 * 由父组件重新调 `buildReplayRunPlan` 拿新的 `planHash`（N13-b「改了就重算」）。
 */
import { AlertTriangle, Info, RefreshCw, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ReplayPlanEdit, ReplayRunPlan, ReplayTabMode } from "../types";

const DEFAULT_VISIBLE_ROWS = 200;

interface ReplayPlanTableProps {
  plan: ReplayRunPlan;
  /** 正在重算（Host 侧跑一次 Sidecar 风险判定，非即时） */
  planning: boolean;
  disabled?: boolean;
  /** 行级修改：父组件负责合并进 edits 并重算预检单 */
  onEdit: (edit: ReplayPlanEdit) => void;
  /** 按策略重算整表（丢弃手工改行） */
  onReset: () => void;
  /** 环境 id → 展示名 / 是否运行中 */
  envInfo: Record<string, { name: string; running: boolean }>;
}

function previewText(preview: Record<string, unknown>): string {
  const entries = Object.entries(preview);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}=${value == null ? "" : String(value)}`).join(" · ");
}

export function ReplayPlanTable({
  plan,
  planning,
  disabled = false,
  onEdit,
  onReset,
  envInfo,
}: ReplayPlanTableProps) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(
    () => (showAll ? plan.rows : plan.rows.slice(0, DEFAULT_VISIBLE_ROWS)),
    [plan.rows, showAll],
  );

  const summary = `${plan.totals.envs} 环境 × ${plan.totals.repeatCount} 轮 = ${plan.totals.totalRuns} 次 · 计划新建 ${plan.totals.plannedNewTabs} 个标签 · 并发 ${plan.totals.maxConcurrency} · 错峰 ${plan.totals.staggerMs}ms`;
  const dataCellValue = (row: ReplayRunPlan["rows"][number]): string => {
    if (row.skipped) return "skip";
    if (row.record.source === "generate") return "generate";
    if (row.record.source === "clipboard") return "clipboard";
    return row.record.index == null ? "" : String(row.record.index);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-medium text-foreground">
          执行计划确认表 · <span className="text-muted-foreground">{summary}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground" title={plan.planHash}>
            {plan.planHash.slice(0, 22)}…
          </span>
          <button
            type="button"
            className="btn btn-outline btn-compact h-7"
            disabled={disabled || planning}
            onClick={onReset}
            title="按分配策略重算整表（会丢弃手工改行）"
          >
            <RefreshCw size={11} className={planning ? "animate-spin" : ""} />
            {planning ? "重算中…" : "按策略重算"}
          </button>
        </div>
      </div>

      {/* 红条：禁止启动。黄条：允许但必须可见（不折叠） */}
      {plan.errors.length > 0 ? (
        <ul className="space-y-1 rounded-md bg-destructive/10 px-2 py-1.5">
          {plan.errors.map((entry, index) => (
            <li key={`err-${index}`} className="flex items-start gap-1.5 text-[11px] text-destructive">
              <XCircle size={13} className="mt-0.5 shrink-0" />
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {plan.warnings.filter((entry) => entry.level !== "red").length > 0 ? (
        <ul className="space-y-1 rounded-md bg-warning/10 px-2 py-1.5">
          {plan.warnings
            .filter((entry) => entry.level !== "red")
            .map((entry, index) => (
              <li key={`warn-${index}`} className="flex items-start gap-1.5 text-[11px] text-warning">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>{entry.text}</span>
              </li>
            ))}
        </ul>
      ) : null}
      {plan.dataset.size === 0 ? (
        <div className="flex items-start gap-1.5 rounded-md bg-info/10 px-2 py-1.5 text-[11px] text-info">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            无数据集：值由种子 <span className="font-mono">{plan.allocation.runSeed}</span>{" "}
            现场生成，唯一性由分配器发的 <span className="font-mono">uniqueId</span> 兜底（不靠随机）。
          </span>
        </div>
      ) : null}

      <div className="max-h-64 overflow-auto rounded-lg bg-sunken">
        <table className="w-full border-collapse text-[10px]">
          <thead className="sticky top-0 bg-raised">
            <tr className="text-muted-foreground">
              <th className=" px-1.5 py-1 text-left font-medium">#</th>
              <th className=" px-1.5 py-1 text-left font-medium">环境</th>
              <th className=" px-1.5 py-1 text-left font-medium">第几轮</th>
              <th className=" px-1.5 py-1 text-left font-medium">数据行</th>
              <th className=" px-1.5 py-1 text-left font-medium">关键字段预览</th>
              <th className=" px-1.5 py-1 text-left font-medium">标签</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const env = envInfo[row.envId];
              return (
                <tr key={row.seq} className={row.skipped ? "opacity-50" : undefined}>
                  <td className=" px-1.5 py-1 text-muted-foreground">{row.seq + 1}</td>
                  <td className=" px-1.5 py-1 text-foreground">
                    <span
                      className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
                        env?.running === false ? "bg-destructive" : "bg-success"
                      }`}
                      title={env?.running === false ? "未运行" : "运行中"}
                    />
                    #{row.envId}
                    {env?.name ? ` ${env.name}` : ""}
                  </td>
                  <td className=" px-1.5 py-1 text-muted-foreground">
                    {row.runIndex + 1}/{plan.totals.repeatCount}
                  </td>
                  <td className=" px-1.5 py-1">
                    <select
                      value={dataCellValue(row)}
                      disabled={disabled || planning}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === "skip") {
                          onEdit({ seq: row.seq, skipped: true });
                        } else if (value === "generate") {
                          onEdit({ seq: row.seq, skipped: false, recordSource: "generate" });
                        } else if (value === "clipboard") {
                          onEdit({ seq: row.seq, skipped: false, recordSource: "clipboard" });
                        } else {
                          onEdit({
                            seq: row.seq,
                            skipped: false,
                            recordSource: "dataset",
                            useRecordIndex: Number(value),
                          });
                        }
                      }}
                      className="field-input h-6 w-[8.5rem] px-1 py-0 text-[10px]"
                    >
                      <option value="skip">跳过这一轮</option>
                      <option value="generate">生成（种子）</option>
                      <option value="clipboard">剪贴板快照</option>
                      {Array.from({ length: plan.dataset.size }, (_item, index) => (
                        <option key={index} value={String(index)}>
                          第 {index + 1} 行
                        </option>
                      ))}
                    </select>
                  </td>
                  <td
                    className="max-w-[16rem] truncate px-1.5 py-1 text-muted-foreground"
                    title={previewText(row.record.preview)}
                  >
                    {row.skipped ? "—" : previewText(row.record.preview)}
                  </td>
                  <td className=" px-1.5 py-1">
                    <select
                      value={row.skipped ? "" : row.tab.mode}
                      disabled={disabled || planning || row.skipped}
                      onChange={(event) =>
                        onEdit({ seq: row.seq, tabMode: event.target.value as ReplayTabMode })
                      }
                      className="field-input h-6 w-[9.5rem] px-1 py-0 text-[10px]"
                    >
                      <option value="new">新标签</option>
                      <option value="reuse">复用当前标签</option>
                      <option value="new_close">新标签（跑完关）</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {plan.rows.length > DEFAULT_VISIBLE_ROWS ? (
        <button
          type="button"
          className="btn btn-ghost btn-compact h-7"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? "只显示前 200 行" : `展开全部 ${plan.rows.length} 行`}
        </button>
      ) : null}
    </div>
  );
}
