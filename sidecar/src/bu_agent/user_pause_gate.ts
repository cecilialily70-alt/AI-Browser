/**
 * P4.5 — 用户暂停 / 恢复闸门
 *
 * 复用 `task_pause_lock`（awaitPause / resumePause），禁止另造一套暂停锁。
 * 主循环在 multi_act 前调用；恢复后调用方须 forceObserveNext 并从观察步重来。
 */
import { awaitPause } from "../task_pause_lock.js";

export const USER_PAUSE_LOCK_PREFIX = "agent-user-pause";

let pauseRequested = false;

export function requestUserPause(): void {
  pauseRequested = true;
}

export function clearUserPauseRequest(): void {
  pauseRequested = false;
}

export function isUserPauseRequested(): boolean {
  return pauseRequested;
}

export function userPauseLockId(profileId?: string | null): string {
  const id = String(profileId ?? "").trim() || "default";
  return `${USER_PAUSE_LOCK_PREFIX}:${id}`;
}

export function isUserPauseLockId(lockId: unknown): boolean {
  const id = String(lockId ?? "").trim();
  return id.startsWith(`${USER_PAUSE_LOCK_PREFIX}:`);
}

/**
 * 若用户已点暂停：进入 awaitPause，直到 Host 经 HTTP/stdin resume。
 * @returns true = 刚从暂停恢复，调用方应跳过本轮 multi_act 并强制下一轮观察
 */
export async function drainUserPauseGate(options: {
  profileId: string;
  signal?: AbortSignal;
  onPaused?: (lockId: string) => void;
  onResumed?: (lockId: string) => void;
}): Promise<boolean> {
  if (!pauseRequested) {
    return false;
  }
  pauseRequested = false;
  const lockId = userPauseLockId(options.profileId);
  options.onPaused?.(lockId);
  await awaitPause(lockId);
  if (options.signal?.aborted) {
    throw new Error("Agent 已中止");
  }
  options.onResumed?.(lockId);
  return true;
}
