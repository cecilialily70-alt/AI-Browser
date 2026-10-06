/**
 * 用户「标记成功」闸门 — 运行中点「成功」即视为任务完成。
 *
 * 与 abort 不同：不置失败、可写轨迹；与 pause 不同：不挂起，步间收尾。
 * 主循环每步开头 consume；若当时正暂停，Host 会 resumePause 以便本闸被读到。
 */
let successRequested = false;

export function requestUserSuccess(): void {
  successRequested = true;
}

export function clearUserSuccessRequest(): void {
  successRequested = false;
}

/** @returns true = 用户已点成功，调用方应立即收尾（doneSuccess=true） */
export function consumeUserSuccessRequest(): boolean {
  if (!successRequested) {
    return false;
  }
  successRequested = false;
  return true;
}
