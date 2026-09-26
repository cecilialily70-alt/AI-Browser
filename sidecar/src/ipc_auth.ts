/**
 * 本地 IPC 共享令牌（Rust 宿主 ↔ Node Sidecar）
 *
 * Rust 启动 Sidecar 时经 `TIANSHUTAI_IPC_TOKEN` 注入一枚会话级随机令牌：
 * - 客户端侧（ipc_client.ts）随每个 /report 请求带 `X-Auth-Token`；
 * - 服务端侧（task_pause_lock.ts）校验 /resume、/paused 的同一枚令牌。
 *
 * 未注入令牌（例如独立调试 Sidecar）时返回空串：此时请求不带令牌、服务端一律拒绝，
 * 保证「无令牌即不可用」的安全默认，而不是退化成谁都能调。
 */
import { timingSafeEqual } from "node:crypto";

import { ENV_IPC_TOKEN, readAppEnv } from "./app_env.js";
/** 读取本进程的 IPC 共享令牌；未注入返回空串。 */
export function resolveIpcAuthToken(): string {
  return readAppEnv(ENV_IPC_TOKEN) ?? "";
}

/** 定长常量时间比较，避免按字符短路比较泄漏令牌前缀。 */
export function tokenEquals(expected: string, provided: string): boolean {
  if (!expected) {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * 从请求头提取调用方令牌：优先 `X-Auth-Token`，兼容 `Authorization: Bearer`。
 * Node 已把同名头合并为逗号串，取首段即可。
 */
export function readBearerToken(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  const trimmed = String(raw).trim();
  const bearer = /^bearer\s+(.+)$/i.exec(trimmed);
  return (bearer?.[1] ?? trimmed).split(",")[0]!.trim();
}
