/**
 * 应用自有环境变量的统一命名与读取（Node 侧，与 Rust `app_env.rs` 保持同源语义）。
 *
 * 品牌统一为 `TIANSHUTAI_*`；读取兼容迁移期旧前缀 `CLOAKFORGE_*`，
 * 让用户既有启动脚本 / 快捷方式不因改名失效（只保留「读」的兼容）。
 *
 * 注意：`CLOAKBROWSER_*` 属于上游内核契约，不在此模块管辖范围。
 */

const PREFIX = "TIANSHUTAI";
const LEGACY_PREFIX = "CLOAKFORGE";

/** 本地 IPC 服务地址（Rust 注入） */
export const ENV_IPC_URL = "IPC_URL";
/** 当前环境 ID（Rust 注入） */
export const ENV_PROFILE_ID = "PROFILE_ID";
/** 本地 IPC 会话共享令牌（Rust 注入） */
export const ENV_IPC_TOKEN = "IPC_TOKEN";
/** 日志级别开关 */
export const ENV_LOG_LEVEL = "LOG_LEVEL";
/** Agent 技能目录覆盖 */
export const ENV_AGENT_SKILLS_DIR = "AGENT_SKILLS_DIR";
/** 内核根目录覆盖 */
export const ENV_BROWSE_ROOT = "BROWSE_ROOT";
/** GPU 指纹模式覆盖 */
export const ENV_GPU_MODE = "GPU_MODE";
/** 绑定的 CDP target id */
export const ENV_CDP_TARGET_ID = "CDP_TARGET_ID";
/** 常规浏览器下载根目录（Rust 注入，供 Sidecar 侧接管手动下载时定位） */
export const ENV_BROWSER_DOWNLOAD_DIR = "BROWSER_DOWNLOAD_DIR";
/** 爬虫/媒体下载根目录（Rust 注入） */
export const ENV_SCRAPER_DOWNLOAD_DIR = "SCRAPER_DOWNLOAD_DIR";
/** 读取变量：优先新名，回退旧名；未设置或仅空白返回 undefined。 */
export function readAppEnv(suffix: string): string | undefined {
  for (const candidate of [`${PREFIX}_${suffix}`, `${LEGACY_PREFIX}_${suffix}`]) {
    const value = process.env[candidate]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
