/**
 * 值守切片与并发的**唯一区间口径**（两侧/三端共用的常量，写死字面量会立刻分叉）。
 *
 * 三处必须逐字一致，由 `sidecar/tests/chat-settings-parity.mjs` 做源码级对齐断言：
 *   - 前端 `src/lib/chatModeSettings.ts`（`CHAT_SLICE_MS_MIN` / `CHAT_SLICE_MS_MAX` /
 *     `CHAT_CONTACTS_PER_SLICE_MAX` / `CHAT_PARALLEL_MAX`）
 *   - 宿主 `src-tauri/src/rpa_session.rs`（`CHAT_SLICE_MIN_MS` / `CHAT_SLICE_DEFAULT_MS` /
 *     `CHAT_SLICE_MAX_MS`）与 `src-tauri/src/chat_patrol.rs`（`CHAT_PARALLEL_HARD_MAX`）
 *   - 侧车（本文件）
 *
 * 为什么必须一致：宿主按「这一片的盒长 + 结算宽限」算等待上限，侧车按 `sliceMs` 算片内预算，
 * 两边对不上就会出现「设置里填得下、跑起来报超时」或「片早该收了还在发」。
 */
export const CHAT_SLICE_MS_MIN = 15_000;
/** 单片默认 90 秒（与设置面板默认值一致） */
export const CHAT_SLICE_MS_DEFAULT = 90_000;
/** 单片上限 30 分钟 */
export const CHAT_SLICE_MS_MAX = 1_800_000;
export const CHAT_CONTACTS_PER_SLICE_MAX = 50;
/** 单次值守的联系人数默认 5（与设置面板默认值一致） */
export const CHAT_CONTACTS_PER_SLICE_DEFAULT = 5;
/** 并发硬顶（免费档另有恒为 1 的限制，由宿主席位口径决定） */
export const CHAT_PARALLEL_HARD_MAX = 4;
