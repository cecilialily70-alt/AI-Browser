import { ChevronDown, ChevronUp, Download, FileText, FolderOpen, X } from "lucide-react";
import { useMemo, useState } from "react";

import { downloadAsCSV } from "../lib/csvExport";
import { formatInvokeError, openPathInOs } from "../lib/tauri";

const PREVIEW_ROWS = 8;

type ScraperDataPanelProps = {
  data: Array<Record<string, unknown>>;
  /** Required for CSV native export into global download dirs. */
  profileId: string;
  meta?: {
    mode?: string | null;
    url?: string | null;
    count?: number | null;
    localPath?: string | null;
  };
  onClear?: () => void;
  onToastError?: (message: string) => void;
  onToastSuccess?: (message: string) => void;
};

function isFileRow(row: Record<string, unknown>): boolean {
  return typeof row.localPath === "string" && String(row.localPath).trim().length > 0;
}

export function ScraperDataPanel({
  data,
  profileId,
  meta,
  onClear,
  onToastError,
  onToastSuccess,
}: ScraperDataPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fileRows = useMemo(() => data.filter(isFileRow), [data]);
  const tableRows = useMemo(() => data.filter((row) => !isFileRow(row)), [data]);

  const columns = useMemo(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const row of tableRows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    return keys;
  }, [tableRows]);

  const preview = tableRows.slice(0, PREVIEW_ROWS);
  const count = meta?.count ?? data.length;

  if (data.length === 0) {
    return null;
  }

  const openPath = async (target: string, revealFile: boolean) => {
    try {
      await openPathInOs(target);
    } catch (error) {
      onToastError?.(formatInvokeError(error));
    }
    void revealFile;
  };

  const handleExportCsv = async () => {
    if (!profileId.trim()) {
      onToastError?.("缺少环境 ID，无法导出到全局下载目录");
      return;
    }
    setExporting(true);
    try {
      const savedPath = await downloadAsCSV(
        tableRows,
        `tianshutai-scrape-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`,
        { profileId, track: "browser" },
      );
      onToastSuccess?.(`CSV 已保存：${savedPath}`);
      try {
        await openPathInOs(savedPath);
      } catch {
        // path open is best-effort after successful write
      }
    } catch (error) {
      onToastError?.(formatInvokeError(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mb-2 shrink-0 overflow-hidden rounded-lg bg-sunken">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          className="icon-button h-6 w-6"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "展开" : "折叠"}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-semibold text-foreground">采集结果</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {count} 条{meta?.mode ? ` · ${meta.mode}` : ""}
            {meta?.url ? ` · ${meta.url}` : ""}
          </div>
        </div>
        {tableRows.length > 0 ? (
          <button
            type="button"
            className="btn btn-outline btn-compact h-6"
            onClick={() => void handleExportCsv()}
            disabled={exporting || !profileId.trim()}
            title="导出 CSV 到浏览器下载目录"
          >
            <Download size={11} />
            {exporting ? "导出中…" : "导出 CSV"}
          </button>
        ) : null}
        {onClear ? (
          <button type="button" className="icon-button h-6 w-6" onClick={onClear} title="关闭面板">
            <X size={12} />
          </button>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="max-h-56 space-y-2 overflow-auto p-2">
          {fileRows.length > 0 ? (
            <div className="space-y-1.5">
              {fileRows.map((row, idx) => {
                const localPath = String(row.localPath ?? "");
                const filename = String(row.filename ?? localPath.split(/[/\\]/).pop() ?? "file");
                return (
                  <div
                    key={`file-${idx}-${localPath}`}
                    className="flex items-center gap-2 rounded-md bg-surface-muted px-2 py-1.5"
                  >
                    <FileText size={14} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui font-medium text-foreground">{filename}</div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground" title={localPath}>
                        {localPath}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline btn-compact h-6"
                      onClick={() => void openPath(localPath, true)}
                      title="打开所在目录"
                    >
                      <FolderOpen size={11} />
                      打开目录
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {tableRows.length > 0 ? (
            <>
              <div className="segmented w-fit">
                <button
                  type="button"
                  className={`segmented-item ${!showJson ? "segmented-item-active" : ""}`}
                  onClick={() => setShowJson(false)}
                >
                  表格
                </button>
                <button
                  type="button"
                  className={`segmented-item ${showJson ? "segmented-item-active" : ""}`}
                  onClick={() => setShowJson(true)}
                >
                  JSON
                </button>
              </div>

              {showJson ? (
                <pre className="max-h-40 overflow-auto rounded-md bg-surface-muted p-2 font-mono text-[10px] leading-4 text-muted-foreground">
                  {JSON.stringify(preview, null, 2)}
                  {tableRows.length > PREVIEW_ROWS ? `\n… 另有 ${tableRows.length - PREVIEW_ROWS} 条` : ""}
                </pre>
              ) : (
                <div className="overflow-auto rounded-md ">
                  <table className="w-full min-w-max border-collapse text-left text-[10px]">
                    <thead className="sticky top-0 bg-surface-muted">
                      <tr>
                        {columns.map((col) => (
                          <th
                            key={col}
                            className="whitespace-nowrap px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, idx) => (
                        <tr
                          key={`row-${idx}-${columns.map((c) => String(row[c] ?? "")).join("|")}`}
                          className="odd:bg-transparent even:bg-surface-muted"
                        >
                          {columns.map((col) => {
                            const raw = row[col];
                            const text =
                              raw === null || raw === undefined
                                ? ""
                                : typeof raw === "object"
                                  ? JSON.stringify(raw)
                                  : String(raw);
                            return (
                              <td
                                key={col}
                                className="max-w-[160px] truncate px-2 py-1 text-muted-foreground"
                                title={text}
                              >
                                {text || "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {tableRows.length > PREVIEW_ROWS ? (
                    <div className=" px-2 py-1 text-[10px] text-muted-foreground">
                      预览前 {PREVIEW_ROWS} 条 · 共 {tableRows.length} 条
                    </div>
                  ) : null}
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
