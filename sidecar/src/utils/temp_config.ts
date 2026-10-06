/**
 * 一次性临时配置的「读后即焚」约定。
 *
 * 背景：Rust 核心把含凭据的配置（AI API Key / License Key）写进临时文件，
 * 再以 `--config-file=` 交给本进程。约定由**读取方**在读完后立即删除，
 * 把凭据落盘窗口收敛到进程启动期——Rust 侧只能覆盖到「子进程退出」这一粒度。
 *
 * 已知调用方：chat.ts、data_planner_cli.ts、launch.ts。
 * 其中 launch.ts 的 sidecar 生命周期很长，Rust 侧无法在其存续期间删除，
 * 更依赖这里的读取即删。
 */
import { readFile, unlink } from "node:fs/promises";

export const CONFIG_FILE_FLAG = "--config-file=";

/** 从 argv 中取出 `--config-file=` 的路径；未提供时返回 null。 */
export function findConfigFileArg(argv: readonly string[]): string | null {
  const match = argv.find((arg) => arg.startsWith(CONFIG_FILE_FLAG));
  if (!match) {
    return null;
  }
  const path = match.slice(CONFIG_FILE_FLAG.length);
  return path.length > 0 ? path : null;
}

/** 尽力删除临时配置：已被 Rust Drop 提前清理属正常，任何失败都不阻断主流程。 */
export async function removeTempConfig(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/**
 * 读取临时配置并立即删除（读后即焚），返回解析后的对象。
 *
 * 采用 `finally` 保证即便 JSON 解析失败也会删除，避免畸形配置永久滞留磁盘。
 * BOM 与首尾空白先行清理，兼容 Windows 侧写入。
 */
export async function readConsumedJsonConfig<T>(path: string): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    const normalized = raw.replace(/^\uFEFF/, "").trim();
    return JSON.parse(normalized) as T;
  } finally {
    await removeTempConfig(path);
  }
}
