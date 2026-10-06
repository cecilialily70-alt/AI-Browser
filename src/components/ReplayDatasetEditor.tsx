/**
 * 回放数据集编辑器（执行计划.md §8.2 ⑤ / §4.3）。
 *
 * 职责：把「上传的文件 / 粘贴的多行文本」解析成数据集，并让人看清
 * 「解析成了什么、几行几列、够不够用、哪列对应哪个字段」——解析失败时**明确报出行列**
 * 且不给启动（由父组件根据 `error` 禁用按钮）。
 *
 * 三入口（对齐业界 bulk import 的 File → Map → Validate → Submit 习惯）：
 *   ① 拖拽 / 选择文件（TXT / JSON / JSONL / CSV / TSV）
 *   ② 粘贴文本（含「生成 JSON」骨架）
 *   ③ 变量值表（手动逐格改；改完回写成 JSON，保证「文本域 = 所见即所得」）
 *
 * 纯只读计算：不碰浏览器、不发任何请求（§4.6.2「干跑不碰浏览器」）。
 */
import { useMemo, useRef, useState, type DragEvent } from "react";
import { AlertTriangle, CheckCircle2, FileJson, FileUp, Plus, RefreshCw, Trash2, Wand2 } from "lucide-react";

import type { SandboxFormField } from "../types";
import {
  autoMapColumns,
  DATASET_MAX_ROWS,
  generateDatasetSkeleton,
  parseDatasetText,
  previewRow,
  renameDatasetColumn,
  serializeDatasetRows,
  type DatasetFormat,
  type DatasetRow,
} from "../lib/replayDataset";
import { DYNAMIC_MAGIC_VAR_HINTS, MAGIC_VARS } from "../lib/magicVars";

export interface ReplayDatasetDraft {
  format: DatasetFormat;
  rows: DatasetRow[];
  columns: string[];
  /** 字段 key → 列名 */
  columnMap: Record<string, string>;
  /** 原始文本（仅用于「文本域」展示；下发预检单的是 rows/columns） */
  text: string;
  /** 解析错误（非 null 时禁止启动） */
  error: string | null;
  /** 解析错误位置（行 / 列，1 基） */
  errorLine?: number;
  errorColumn?: number;
}

interface ReplayDatasetEditorProps {
  fields: SandboxFormField[];
  draft: ReplayDatasetDraft | null;
  onChange: (draft: ReplayDatasetDraft | null) => void;
  /** 需要的行数（环境数 × 轮次），用于「行数够不够」提示 */
  requiredRows: number;
  disabled?: boolean;
}

const TOOLBAR_BTN = "btn btn-outline btn-compact h-7";
/** 上传文件大小上限；数据集自身还有 2000 行 / 单值 4096 字符的上限兜底 */
const MAX_FILE_BYTES = 1024 * 1024;
/** 变量值表最多渲染多少行（避免大表卡住弹窗） */
const GRID_MAX_ROWS = 20;

function parseToDraft(text: string, fields: SandboxFormField[]): ReplayDatasetDraft {
  const result = parseDatasetText(text);
  if (!result.ok) {
    return {
      format: "txt",
      rows: [],
      columns: [],
      columnMap: {},
      text,
      error: result.error,
      errorLine: result.line,
      errorColumn: result.column,
    };
  }
  return {
    format: result.dataset.format,
    rows: result.dataset.rows,
    columns: result.dataset.columns,
    columnMap: autoMapColumns(result.dataset.columns, fields, result.dataset.rows),
    text,
    error: null,
  };
}

export function ReplayDatasetEditor({
  fields,
  draft,
  onChange,
  requiredRows,
  disabled = false,
}: ReplayDatasetEditorProps) {
  const [text, setText] = useState(draft?.text ?? "");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const columnOptions = draft?.columns ?? [];
  const rowCount = draft?.rows.length ?? 0;
  const short = !draft?.error && rowCount > 0 && rowCount < requiredRows;
  const unmapped = useMemo(() => fields.filter((field) => !draft?.columnMap?.[field.key]), [fields, draft]);
  /** 有数据却一个字段都没映射：多半是「以为换了值、其实没生效」 */
  const allUnmapped = !draft?.error && rowCount > 0 && fields.length > 0 && unmapped.length === fields.length;
  const singleColumn = !draft?.error && columnOptions.length === 1 ? columnOptions[0]! : null;

  const applyText = (next: string) => {
    setText(next);
    onChange(next.trim() ? parseToDraft(next, fields) : null);
  };

  /** 表格编辑：行数据是权威，回写成 JSON 文本（保持「文本域 = 所见即所得」） */
  const commitRows = (rows: DatasetRow[], columns: string[], columnMap: Record<string, string>) => {
    const nextText = serializeDatasetRows(rows);
    setText(nextText);
    onChange({ format: "json", rows, columns, columnMap, text: nextText, error: null });
  };

  const handleGenerate = () => {
    setFileName(null);
    applyText(generateDatasetSkeleton(fields, Math.max(requiredRows, 5)));
  };

  const loadFile = async (file: File | undefined | null) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError(
        `「${file.name}」${Math.round(file.size / 1024)}KB 超过上限 ${MAX_FILE_BYTES / 1024}KB；` +
          `请精简后重试（数据集上限 ${DATASET_MAX_ROWS} 行）。`,
      );
      return;
    }
    try {
      const content = await file.text();
      setFileError(null);
      setFileName(file.name);
      setText(content);
      onChange(content.trim() ? parseToDraft(content, fields) : null);
    } catch {
      setFileError(`读取「${file.name}」失败（文件可能已被移动或没有权限）`);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    void loadFile(event.dataTransfer?.files?.[0]);
  };

  const setMapping = (fieldKey: string, column: string) => {
    if (!draft) return;
    const columnMap = { ...draft.columnMap };
    if (column) columnMap[fieldKey] = column;
    else delete columnMap[fieldKey];
    onChange({ ...draft, columnMap });
  };

  /** 改「变量名」（单列数据集）：列名、行键、字段映射一起改，避免「改了名丢了值」 */
  const commitRename = (next: string): boolean => {
    if (!draft || !singleColumn) return false;
    const trimmed = next.trim();
    if (!trimmed || trimmed === singleColumn) {
      setNameError(null);
      return false;
    }
    const renamed = renameDatasetColumn(draft, draft.columnMap, singleColumn, trimmed);
    if (!renamed) {
      setNameError("变量名不能为空，也不能与其它列重复");
      return false;
    }
    setNameError(null);
    commitRows(renamed.rows, renamed.columns, renamed.columnMap);
    return true;
  };

  const updateCell = (rowIndex: number, column: string, value: string) => {
    if (!draft) return;
    const rows = draft.rows.map((row, index) => (index === rowIndex ? { ...row, [column]: value } : row));
    commitRows(rows, draft.columns, draft.columnMap);
  };

  const addRow = () => {
    if (!draft || draft.rows.length >= DATASET_MAX_ROWS) return;
    const last = draft.rows[draft.rows.length - 1] ?? {};
    const row: DatasetRow = {};
    for (const column of draft.columns) row[column] = String(last[column] ?? "");
    commitRows([...draft.rows, row], draft.columns, draft.columnMap);
  };

  const removeRow = (rowIndex: number) => {
    if (!draft || draft.rows.length <= 1) return;
    commitRows(
      draft.rows.filter((_row, index) => index !== rowIndex),
      draft.columns,
      draft.columnMap,
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="field-label">
          <FileJson size={12} className="mr-1 inline" />
          数据集（TXT / JSON / JSONL / CSV / TSV）
        </span>
        <button
          type="button"
          className={TOOLBAR_BTN}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          title="上传 TXT / JSON / CSV 等数据文件（每行一条值，或每行一个变量组合）"
        >
          <FileUp size={12} />
          上传文件
        </button>
        <button
          type="button"
          className={TOOLBAR_BTN}
          disabled={disabled}
          onClick={() => applyText(text)}
          title="重新解析当前文本"
        >
          <RefreshCw size={12} />
          解析
        </button>
        <button
          type="button"
          className={TOOLBAR_BTN}
          disabled={disabled || fields.length === 0}
          onClick={handleGenerate}
          title="按当前轨迹的字段生成 JSON 骨架，自动带 {{run.uniqueId}} 保证各行不同"
        >
          <Wand2 size={12} />
          生成 JSON
        </button>
        <button
          type="button"
          className={TOOLBAR_BTN}
          disabled={disabled || !draft}
          onClick={() => {
            setText("");
            setFileName(null);
            setFileError(null);
            setNameError(null);
            onChange(null);
          }}
        >
          清空
        </button>
        {fileName ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground" title={fileName}>
            已载入 {fileName}
          </span>
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.json,.jsonl,.csv,.tsv,text/plain,application/json,text/csv,text/tab-separated-values"
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          void loadFile(event.target.files?.[0]);
          // 允许连续上传同一个文件（否则第二次不触发 change）
          event.target.value = "";
        }}
      />

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => {
          if (!disabled) fileInputRef.current?.click();
        }}
        className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[11px] transition-colors ${
          dragging ? " bg-primary/10 text-primary-text" : " bg-sunken text-muted-foreground hover:bg-secondary/40"
        }`}
      >
        <FileUp size={13} />把 TXT / JSON / CSV 文件拖到这里，或点击选择
        <span className="text-[10px] text-muted-foreground">（每行一个值，或每行一个变量组合）</span>
      </div>

      <textarea
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => applyText(event.target.value)}
        placeholder={
          "TXT（每行一个值）：\n刘亦菲\n张三\n" +
          'JSON（多变量多轮）：[{"name":"刘亦菲","city":"北京"}]\n' +
          'JSON（列式）：{"name":["刘亦菲","张三"]}'
        }
        className="field-input h-32 w-full resize-y p-2 font-mono text-[11px] leading-5"
      />

      {fileError ? (
        <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{fileError}</span>
        </div>
      ) : null}

      <p className="text-[10px] leading-4 text-muted-foreground">
        单元格可用：
        {MAGIC_VARS.slice(0, 6)
          .map((item) => item.token)
          .join(" / ")}{" "}
        …，以及 <code className="rounded bg-secondary/60 px-1">{DYNAMIC_MAGIC_VAR_HINTS[0]}</code>、
        <code className="rounded bg-secondary/60 px-1">{DYNAMIC_MAGIC_VAR_HINTS[1]}</code>、
        <code className="rounded bg-secondary/60 px-1">{"{{run.uniqueId}}"}</code>
        。单值上限 4096 字符，行数上限 {DATASET_MAX_ROWS}。
        <span className="text-warning">文件内容会随预检单落盘，请勿放卡号 / 验证码等一次性凭证。</span>
      </p>

      {draft?.error ? (
        <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            解析失败：{draft.error}
            {draft.errorLine != null ? `（第 ${draft.errorLine} 行` : ""}
            {draft.errorColumn != null ? `第 ${draft.errorColumn} 列）` : draft.errorLine != null ? "）" : ""}
            — 已禁止启动，请修正后再试。
          </span>
        </div>
      ) : draft && rowCount > 0 ? (
        <div className="space-y-1.5 rounded-lg bg-sunken px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <CheckCircle2 size={13} className="text-primary" />
            <span className="text-foreground">
              {draft.format.toUpperCase()} · {rowCount} 行 · {columnOptions.length} 列
            </span>
            {short ? (
              <span className="text-warning">行数不足（需要 {requiredRows}）</span>
            ) : (
              <span className="text-muted-foreground">行数够用（需要 {requiredRows}）</span>
            )}
            {unmapped.length > 0 ? (
              <span className="text-muted-foreground">· 未映射字段 {unmapped.length} 个</span>
            ) : null}
          </div>

          {allUnmapped ? (
            <p className="rounded-md bg-warning/10 px-2 py-1.5 text-[10px] leading-4 text-warning">
              数据已载入，但没有「变量 → 字段」映射：本轮不会替换任何字段。
            </p>
          ) : null}

          {singleColumn ? (
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="text-muted-foreground">变量名（列名）</span>
              <input
                key={singleColumn}
                defaultValue={singleColumn}
                disabled={disabled}
                spellCheck={false}
                onBlur={(event) => {
                  if (!commitRename(event.target.value)) {
                    event.target.value = singleColumn ?? "";
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (!commitRename((event.target as HTMLInputElement).value)) {
                      (event.target as HTMLInputElement).value = singleColumn ?? "";
                    }
                  }
                }}
                className="field-input h-6 w-40 px-1.5 py-0 font-mono text-[10px]"
              />
              <span className="text-muted-foreground">
                单列数据集的变量名（可改）；多变量请用 JSON / CSV。
              </span>
            </div>
          ) : null}
          {nameError ? <p className="text-[10px] text-destructive">{nameError}</p> : null}

          <button
            type="button"
            className="btn btn-ghost btn-compact h-6"
            onClick={() => setGridOpen((current) => !current)}
          >
            {gridOpen ? "收起变量值表" : `展开变量值表（手动修改 · 共 ${rowCount} 行）`}
          </button>

          {gridOpen ? (
            <div className="space-y-1.5">
              <div className="max-h-40 overflow-auto rounded-lg bg-sunken">
                <table className="w-full border-collapse text-[10px]">
                  <thead className="sticky top-0 bg-raised">
                    <tr className="text-muted-foreground">
                      <th className=" px-1 py-0.5 text-left font-medium">#</th>
                      {columnOptions.map((column) => (
                        <th key={column} className=" px-1 py-0.5 text-left font-medium">
                          {column}
                        </th>
                      ))}
                      <th className=" px-1 py-0.5 text-left font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.rows.slice(0, GRID_MAX_ROWS).map((row, index) => (
                      <tr key={index}>
                        <td className=" px-1 py-0.5 text-muted-foreground">{index + 1}</td>
                        {columnOptions.map((column) => (
                          <td key={column} className=" px-1 py-0.5">
                            <input
                              value={String(row[column] ?? "")}
                              disabled={disabled}
                              spellCheck={false}
                              onChange={(event) => updateCell(index, column, event.target.value)}
                              className="field-input h-6 w-full rounded px-1 py-0 font-mono text-[10px]"
                            />
                          </td>
                        ))}
                        <td className=" px-1 py-0.5">
                          <button
                            type="button"
                            className="icon-button"
                            disabled={disabled || rowCount <= 1}
                            title="删除这一行"
                            aria-label="删除这一行"
                            onClick={() => removeRow(index)}
                          >
                            <Trash2 size={11} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <button
                  type="button"
                  className="btn btn-outline btn-compact h-6"
                  disabled={disabled || rowCount >= DATASET_MAX_ROWS}
                  onClick={addRow}
                >
                  <Plus size={11} />
                  添加一行
                </button>
                {rowCount > GRID_MAX_ROWS ? (
                  <span>
                    仅可编辑前 {GRID_MAX_ROWS} 行（共 {rowCount} 行）
                  </span>
                ) : (
                  <span>修改会写回 JSON 文本；保存后需重新生成预检单。</span>
                )}
              </div>
            </div>
          ) : null}

          {columnOptions.length > 0 && !gridOpen ? (
            <div className="max-h-24 overflow-auto">
              <table className="w-full border-collapse text-[10px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className=" px-1 py-0.5 text-left font-medium">#</th>
                    {columnOptions.map((column) => (
                      <th key={column} className=" px-1 py-0.5 text-left font-medium">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draft.rows.slice(0, 5).map((row, index) => (
                    <tr key={index} className="text-foreground">
                      <td className=" px-1 py-0.5 text-muted-foreground">{index + 1}</td>
                      {columnOptions.map((column) => (
                        <td
                          key={column}
                          className="max-w-[140px] truncate px-1 py-0.5"
                          title={String(row[column] ?? "")}
                        >
                          {String(row[column] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rowCount > 5 ? (
                <p className="px-1 pt-1 text-[10px] text-muted-foreground">
                  仅预览前 5 行（共 {rowCount} 行）；{previewRow(draft.rows[0]!, columnOptions, 2)}
                </p>
              ) : null}
            </div>
          ) : null}

          {fields.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground">字段映射（列 → 轨迹字段）</p>
              {fields.map((field) => (
                <div key={field.key} className="flex items-center gap-2 text-[10px]">
                  <span className="w-24 shrink-0 truncate text-foreground" title={field.key}>
                    {field.label}
                  </span>
                  <select
                    value={draft.columnMap[field.key] ?? ""}
                    disabled={disabled}
                    onChange={(event) => setMapping(field.key, event.target.value)}
                    className="field-input h-6 px-1 py-0 text-[10px]"
                  >
                    <option value="">（未映射）</option>
                    {columnOptions.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">上传或粘贴数据后显示解析结果。</p>
      )}
    </div>
  );
}
