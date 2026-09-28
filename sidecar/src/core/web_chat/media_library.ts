/**
 * 聊天图库：按文件夹名 / 文件名（中文或英文）与对方话术做确定性匹配。
 *
 * 默认根目录是仓库内 `sidecar/chat_media/`（随包拷贝）。用户可在设置里改成
 * 本机任意文件夹；自定义路径**写了就只认它**（目录不存在 → 空库，不静默回落内置）。
 * 匹配是纯函数、零 LLM，不进起草循环 —— 选不中就返回 null，绝不猜一张无关图。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/** 自定义路径硬顶（防设置里塞进超长垃圾） */
export const MEDIA_LIBRARY_DIR_MAX = 1_024;

export const MEDIA_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

export interface MediaAsset {
  /** 绝对路径（发给页面的就是它） */
  path: string;
  /** 品类/SKU 文件夹名；根目录散文件则为空串 */
  folder: string;
  /** 不含扩展名的文件名 */
  fileStem: string;
  /** 给人看的短标签：`文件夹/文件名` */
  label: string;
}

const SKIP_DIR_NAMES = new Set([".", ".."]);

/** 小写、去掉空白与标点，保留中文与拉丁数字字母 */
export function normalizeMediaKey(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[\s_\-./\\]+/g, "")
    .replace(/[^\p{L}\p{N}\u3400-\u9fff]/gu, "");
}

/** 从话术/路径抽出匹配用 token（拉丁词 + 连续汉字串 + 汉字 2-gram） */
export function mediaTokens(raw: string): string[] {
  const text = String(raw ?? "").toLowerCase();
  const out = new Set<string>();
  for (const word of text.match(/[a-z0-9]{2,}/g) ?? []) {
    out.add(word);
  }
  for (const run of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    out.add(run);
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i += 1) {
        out.add(run.slice(i, i + 2));
      }
    }
  }
  return [...out];
}

function scoreAsset(queryTokens: readonly string[], asset: MediaAsset): number {
  if (queryTokens.length === 0) return 0;
  const folderTokens = mediaTokens(asset.folder);
  const fileTokens = mediaTokens(asset.fileStem);
  let folderHits = 0;
  let fileHits = 0;
  for (const token of queryTokens) {
    if (folderTokens.some((piece) => piece.includes(token) || token.includes(piece))) {
      folderHits += 1;
    }
    if (fileTokens.some((piece) => piece.includes(token) || token.includes(piece))) {
      fileHits += 1;
    }
  }
  if (folderHits === 0 && fileHits === 0) return 0;
  return folderHits * 10 + fileHits * 3;
}

/**
 * 在已扫描的资产里选一张。同分取路径字典序第一张（稳定可测）。
 * 查询里没有任何与路径重合的实质 token → null。
 */
export function matchMedia(query: string, assets: readonly MediaAsset[]): MediaAsset | null {
  const queryTokens = mediaTokens(query);
  if (queryTokens.length === 0 || assets.length === 0) return null;
  let best: MediaAsset | null = null;
  let bestScore = 0;
  const ranked = [...assets].sort((a, b) => a.path.localeCompare(b.path));
  for (const asset of ranked) {
    const score = scoreAsset(queryTokens, asset);
    if (score > bestScore) {
      bestScore = score;
      best = asset;
    }
  }
  return bestScore > 0 ? best : null;
}

function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return MEDIA_EXTENSIONS.has(lower.slice(dot));
}

function fileStemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 扫描一个图库根目录（跳过 README / 隐藏项）。目录不存在则空列表。 */
export function scanMediaLibrary(rootDir: string): MediaAsset[] {
  const root = String(rootDir ?? "").trim();
  if (!root || !existsSync(root)) return [];
  const out: MediaAsset[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!name || name.startsWith(".") || name.toLowerCase() === "readme.md") continue;
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = join(root, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let children: string[] = [];
      try {
        children = readdirSync(full);
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child || child.startsWith(".") || !isImageFile(child)) continue;
        const path = join(full, child);
        const stem = fileStemOf(child);
        out.push({
          path,
          folder: name,
          fileStem: stem,
          label: `${name}/${stem}`,
        });
      }
      continue;
    }
    if (stat.isFile() && isImageFile(name)) {
      const stem = fileStemOf(name);
      out.push({ path: full, folder: "", fileStem: stem, label: stem });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 归一化用户/环境给出的图库路径。
 * - 空 / 非法 → `null`（调用方走内置默认）
 * - 非空 → 规范化后的绝对或相对路径字符串（**不**在这里判目录是否存在）
 */
export function normalizeMediaLibraryDir(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let text = String(raw).trim();
  if (!text) return null;
  if (text.includes("\0")) return null;
  if (text.length > MEDIA_LIBRARY_DIR_MAX) {
    text = text.slice(0, MEDIA_LIBRARY_DIR_MAX);
  }
  try {
    text = normalize(text);
  } catch {
    return null;
  }
  if (!text || text === "." || text === "..") return null;
  return text;
}

/** 内置候选根（与 connectors 同族：dist 相对、cwd、sidecar/chat_media）；不含用户自定义 */
export function chatMediaCandidateRoots(): string[] {
  const out: string[] = [];
  const env = normalizeMediaLibraryDir(process.env.TST_CHAT_MEDIA_DIR);
  if (env) out.push(env);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    out.push(join(here, "../../../../chat_media"));
  } catch {
    /* bundled without import.meta */
  }
  out.push(join(process.cwd(), "chat_media"));
  out.push(join(process.cwd(), "sidecar", "chat_media"));
  return out;
}

export function resolveChatMediaRoot(preferred?: string | null): string | null {
  const custom = normalizeMediaLibraryDir(preferred);
  if (custom) {
    // 用户显式指定：只认这一条（目录不在也返回它，让上层如实说「图库空」）
    return isAbsolute(custom) ? custom : join(process.cwd(), custom);
  }
  for (const dir of chatMediaCandidateRoots()) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * @param rootDir 用户自定义图库目录；空则用内置 `chat_media`。
 *   自定义目录不存在时返回 `[]`（不回落内置，避免「以为在用自定义其实在用仓库图」）。
 */
export function loadMediaLibrary(rootDir?: string | null): MediaAsset[] {
  const custom = normalizeMediaLibraryDir(rootDir);
  const root = resolveChatMediaRoot(custom);
  if (!root) return [];
  if (custom && !existsSync(root)) return [];
  return scanMediaLibrary(root);
}
