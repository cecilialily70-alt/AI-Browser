import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import type { ExitCloseChoice, ExitCloseOptions } from "../components/AppDialogProvider";
import { createLogger } from "../lib/logger";
import { getRunningProfileIds, prepareConsoleExit, stopAllProfiles } from "../lib/tauri";

const logger = createLogger("useAppCloseGuard");

async function resolveRunningProfileIds(): Promise<string[]> {
  try {
    return await getRunningProfileIds();
  } catch {
    return [];
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useAppCloseGuard(exitClose: (options: ExitCloseOptions) => Promise<ExitCloseChoice>): void {
  const allowCloseRef = useRef(false);
  const busyRef = useRef(false);
  const exitCloseRef = useRef(exitClose);

  useEffect(() => {
    exitCloseRef.current = exitClose;
  }, [exitClose]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: (() => void) | undefined;

    const setup = async () => {
      const appWindow = getCurrentWindow();
      unlisten = await appWindow.onCloseRequested(async (event) => {
        if (allowCloseRef.current) {
          return;
        }
        if (busyRef.current) {
          event.preventDefault();
          return;
        }

        event.preventDefault();
        busyRef.current = true;

        try {
          const runningIds = await resolveRunningProfileIds();
          const description =
            runningIds.length > 0
              ? `当前有 ${runningIds.length} 个浏览器环境正在运行。关闭控制台时是否一并关闭这些浏览器？`
              : "确定要关闭天枢台控制台吗？";

          const choice = await exitCloseRef.current({
            title: "退出天枢台",
            description,
            yesLabel: "是",
            noLabel: "否",
            ignoreLabel: "忽略",
          });

          if (choice === "ignore") {
            return;
          }

          // 提前告知 Rust 是否保留运行中的浏览器/Agent，
          // 避免 Rust 退出钩子在 destroy 后无条件清场覆盖用户意图。
          await prepareConsoleExit(choice === "no");

          if (choice === "yes") {
            try {
              await stopAllProfiles();
              await new Promise((resolve) => {
                setTimeout(resolve, 400);
              });
            } catch (error) {
              logger.error("stopAllProfiles failed:", error);
            }
          }

          allowCloseRef.current = true;
          await appWindow.destroy();
        } catch (error) {
          logger.error("close flow failed:", error);
        } finally {
          busyRef.current = false;
        }
      });
    };

    void setup().catch((error) => {
      logger.error("onCloseRequested setup failed:", error);
    });

    return () => {
      unlisten?.();
    };
  }, []);
}
