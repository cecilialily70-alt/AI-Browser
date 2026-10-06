/**
 * Canonical frontend → native filesystem export.
 * ALL UI file dumps (CSV / cookies / JSON / …) MUST go through Tauri
 * `export_text_to_download_dir`, never Blob + `<a download>`.
 */
import { exportTextToDownloadDir, openPathInOs } from "./tauri";

export type DownloadTrack = "browser" | "scraper";

export type SaveTextToDownloadOptions = {
  content: string;
  filename: string;
  /** Environment id — files land under `{root}/{profileId}/`. */
  profileId: string;
  /** Default: browser (常规浏览器下载目录). */
  track?: DownloadTrack;
  /** Best-effort reveal / open after write. */
  openAfter?: boolean;
};

/**
 * Write UTF-8 text into the configured global download directory.
 * @returns Absolute path written.
 */
export async function saveTextToDownloadDir(options: SaveTextToDownloadOptions): Promise<string> {
  const profileId = String(options.profileId ?? "").trim();
  if (!profileId) {
    throw new Error("落盘需要 profileId（写入全局下载目录下的环境子目录）");
  }
  const filename = String(options.filename ?? "").trim();
  if (!filename) {
    throw new Error("落盘需要文件名");
  }
  const track: DownloadTrack = options.track === "scraper" ? "scraper" : "browser";
  const savedPath = await exportTextToDownloadDir({
    track,
    profileId,
    filename,
    content: String(options.content ?? ""),
  });
  if (options.openAfter) {
    try {
      await openPathInOs(savedPath);
    } catch {
      // open is best-effort
    }
  }
  return savedPath;
}
