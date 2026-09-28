/**
 * FNV-1a 32 位哈希（无依赖叶子原语）。
 *
 * 为什么单独抽出来：它是「确定性唯一标识」的唯一来源（§0.5.3 F：唯一性来自种子 + 序号，
 * 不用随机/时间戳），被生成型数据与聊天模式的幂等发送（`effectId`）共用。
 * 之前它住在 `deferred_generation.ts` 里，而那会连带拉进整条 AI 依赖链 ——
 * 聊天核心与回归测试只需要这一个纯函数，不该被迫加载 LLM 客户端。
 */

/** FNV-1a 32 位哈希：把「稳定身份 + 序号 + 内容」派生成确定性标识 */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 便于落盘的短字符串形式（36 进制，无符号） */
export function hash32Id(text: string): string {
  return hash32(text).toString(36);
}
