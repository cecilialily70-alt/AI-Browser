/**
 * CSV helpers for scraped Agent data — export via Tauri native FS into global download dirs.
 */
import { saveTextToDownloadDir, type DownloadTrack } from "./nativeFsExport";

function csvEscapeCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  // Escape quotes; wrap if comma / quote / CR / LF present
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/** Flatten nested objects for a single table cell. */
function cellValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

/**
 * Convert a JSON array of objects to a CSV string (UTF-8 BOM for Excel).
 * Keys from all rows are unioned as headers (stable: first-seen order).
 */
export function jsonArrayToCsv(data: Array<Record<string, unknown>>): string {
  if (!Array.isArray(data) || data.length === 0) {
    return "\uFEFF";
  }

  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }

  if (headers.length === 0) {
    return "\uFEFF";
  }

  const lines: string[] = [headers.map(csvEscapeCell).join(",")];
  for (const row of data) {
    const record =
      row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
    lines.push(headers.map((h) => csvEscapeCell(cellValue(record[h]))).join(","));
  }

  return `\uFEFF${lines.join("\r\n")}`;
}

export type { DownloadTrack };

export type ExportCsvOptions = {
  /** Environment / profile id — files land under `{root}/{profileId}/`. */
  profileId: string;
  /** Default: browser (matches global「常规浏览器下载目录」). */
  track?: DownloadTrack;
};

/**
 * Write CSV into the configured global download directory via Tauri FS
 * (no Blob / `<a download>` — respects browser_download_dir / scraper_download_dir).
 * @returns Absolute path of the written file.
 */
export async function downloadAsCSV(
  data: Array<Record<string, unknown>>,
  filename = "scraper-export.csv",
  options?: ExportCsvOptions,
): Promise<string> {
  const profileId = String(options?.profileId ?? "").trim();
  if (!profileId) {
    throw new Error("导出 CSV 需要 profileId，以便写入全局下载目录下的环境子目录");
  }
  const track: DownloadTrack = options?.track === "scraper" ? "scraper" : "browser";
  const safeName = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  const csv = jsonArrayToCsv(data);

  return saveTextToDownloadDir({
    content: csv,
    filename: safeName,
    profileId,
    track,
  });
}

/** Coerce sidecar payload rows into plain objects for table/CSV. */
export function normalizeScrapedRows(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item, index) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return item as Record<string, unknown>;
    }
    return { index, value: item as unknown };
  });
}
