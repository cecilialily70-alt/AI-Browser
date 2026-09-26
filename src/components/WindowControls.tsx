import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * 无边框窗口的自绘窗口控制（最小化 / 最大化·还原 / 关闭）。
 *
 * - 关闭走 `appWindow.close()`，因此仍会经过 `useAppCloseGuard` 的退出确认，
 *   不会绕过「正在运行的浏览器环境」提示。
 * - 非 Tauri 环境（例如浏览器里跑 vite dev）不渲染，避免误报错。
 */
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [available] = useState(isTauriRuntime);

  useEffect(() => {
    if (!available) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const sync = async () => {
      try {
        const isMax = await getCurrentWindow().isMaximized();
        if (!disposed) {
          setMaximized(isMax);
        }
      } catch {
        // 窗口状态读不到时保持原样，不影响按钮可用性
      }
    };

    void sync();
    void getCurrentWindow()
      .onResized(() => void sync())
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // 事件订阅失败不致命
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [available]);

  if (!available) {
    return null;
  }

  const run = (action: () => Promise<unknown>) => {
    void action().catch(() => {
      // 窗口命令失败（例如已在销毁中）无需打扰用户
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        className="inline-flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        onClick={() => run(() => getCurrentWindow().minimize())}
        title="最小化"
        aria-label="最小化"
      >
        <Minus size={13} />
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        onClick={() =>
          run(async () => {
            const appWindow = getCurrentWindow();
            if (await appWindow.isMaximized()) {
              await appWindow.unmaximize();
            } else {
              await appWindow.maximize();
            }
          })
        }
        title={maximized ? "向下还原" : "最大化"}
        aria-label={maximized ? "向下还原" : "最大化"}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
        onClick={() => run(() => getCurrentWindow().close())}
        title="关闭"
        aria-label="关闭"
      >
        <X size={13} />
      </button>
    </div>
  );
}
