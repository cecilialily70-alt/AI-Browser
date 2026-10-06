/**
 * 回放 / 沙盘单元格与固定值可用的魔法变量（前端展示 + 提示用）。
 *
 * 真正的插值由 Sidecar 的 `interpolateTemplate` 执行（含 `run.*` / `data.*` / `clip.N`），
 * 这里只维护**给用户看的名字与说明**，避免两处文案打架。
 */

export interface MagicVar {
  token: string;
  label: string;
}

/** 静态变量（人设 / 出口地理 / 轮次身份 / 剪贴板顺序号） */
export const MAGIC_VARS: readonly MagicVar[] = [
  { token: "persona.name", label: "人设姓名" },
  { token: "persona.email", label: "人设邮箱" },
  { token: "persona.phone", label: "人设电话" },
  { token: "persona.city", label: "人设城市" },
  { token: "persona.postalCode", label: "人设邮编" },
  { token: "geoip.city", label: "出口城市" },
  { token: "geoip.region", label: "出口省/州" },
  { token: "geoip.country", label: "出口国家" },
  { token: "geoip.countryCode", label: "国家代码" },
  { token: "geoip.exitIp", label: "出口 IP" },
  { token: "run.seq", label: "全局序号（0 基）" },
  { token: "run.index", label: "本环境第几次（0 基）" },
  { token: "run.envId", label: "环境 id" },
  { token: "run.jobId", label: "任务 id" },
  { token: "run.uniqueId", label: "分配器发的唯一整数" },
  { token: "run.uniqueHex", label: "唯一整数（8 位十六进制）" },
  { token: "clip.0", label: "第 1 次剪贴板读取内容" },
] as const;

/**
 * 动态变量：需按数据集的列名/序号现场展开，不适合放进静态清单。
 * 例如 `{{data.email}}`、`{{clip.3}}`。
 */
export const DYNAMIC_MAGIC_VAR_HINTS = ["{{data.<列名>}}", "{{clip.N}}"] as const;
