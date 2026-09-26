/**
 * Parent-process watchdog: when Tauri/Rust dies, the stdin pipe closes and Node must exit.
 * Install at every long-lived sidecar entry (index.ts, launch.ts) immediately after installIpcGuards().
 */

let installed = false;
let exiting = false;

function selfDestruct(reason: string): void {
  if (exiting) {
    return;
  }
  exiting = true;
  // stderr only — parent may be gone; avoid polluting JSON stdout IPC
  try {
    process.stderr.write(`[sidecar] parent stdin ${reason}; self-destruct\n`);
  } catch {
    // ignore
  }
  process.exit(0);
}

/**
 * Keep stdin open and exit when the parent process closes the pipe (Windows orphan Node fix).
 */
export function installParentProcessWatchdog(): void {
  if (installed) {
    return;
  }
  installed = true;

  const stdin = process.stdin;
  if (!stdin || typeof stdin.on !== "function") {
    return;
  }

  try {
    stdin.setEncoding("utf8");
  } catch {
    // ignore
  }

  try {
    stdin.resume();
  } catch {
    // ignore
  }

  stdin.on("end", () => {
    selfDestruct("ended");
  });
  stdin.on("close", () => {
    selfDestruct("closed");
  });
  stdin.on("error", (error: NodeJS.ErrnoException) => {
    const code = error?.code ?? "";
    if (code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") {
      selfDestruct(`error:${code}`);
    }
  });
}
