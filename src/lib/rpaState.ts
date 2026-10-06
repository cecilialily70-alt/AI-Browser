/**
 * RPA 会话状态的展示语义（唯一来源）。
 *
 * sidecar / Rust 会发出 complete、paused、running、failed、aborted、stopped、error 等多种终态，
 * 前端统一收敛为 5 个 UI 状态，禁止在组件里硬匹配状态字符串或中文错误文案。
 */
export type RpaUiState = "idle" | "running" | "paused" | "complete" | "failed";
