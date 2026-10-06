import { launchProfileBrowser, type ProfileLaunchConfig } from "./browser_launcher.js";
import { applyBrowserDownloadDir } from "./download_autosave.js";
import { configureDownloadRoots, getResolvedDownloadPath } from "./utils/file_manager.js";
import { findConfigFileArg, readConsumedJsonConfig } from "./utils/temp_config.js";
import {
  attachInteractiveElementWatcher,
  pushInteractiveExtractForContext,
} from "./interactive_elements.js";
import { attachContextUrlWatchers } from "./page_url_watcher.js";
import { installIpcGuards, JsonLogger } from "./json-logger.js";
import { installParentProcessWatchdog } from "./parent_process_watchdog.js";

installIpcGuards();
installParentProcessWatchdog();

const logger = new JsonLogger();

async function parseLaunchConfig(argv: string[]): Promise<ProfileLaunchConfig> {
  // 内联 --config= 仅在不含凭据的调试场景使用，无文件需要回收。
  const inline = argv.find((arg) => arg.startsWith("--config="));
  if (inline) {
    return JSON.parse(inline.slice("--config=".length)) as ProfileLaunchConfig;
  }

  const path = findConfigFileArg(argv);
  if (path) {
    // 配置含 License Key：读完立即删除。本进程生命周期远长于读取时刻，
    // 若留给 Rust Drop 回收，凭据会滞留磁盘至浏览器关闭。
    return readConsumedJsonConfig<ProfileLaunchConfig>(path);
  }

  throw new Error("missing --config= or --config-file=");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function cdpEndpointUp(port: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 600);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: ctrl.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 关掉旧进程后再拉起，避免端口还被占就立刻 launch 失败。 */
async function waitForCdpDown(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await cdpEndpointUp(port))) {
      return;
    }
    await delay(200);
  }
}

async function main(): Promise<void> {
  let context: Awaited<ReturnType<typeof launchProfileBrowser>> | null = null;
  let shuttingDown = false;
  let restarting = false;
  let profileId = "unknown";
  let cdpPort = 0;
  let sessionResolve: ((reason: string) => void) | null = null;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.status("browser_shutting_down", { reason, profileId });
    if (context) {
      try {
        await Promise.race([
          context.close(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 8000);
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("browser_close_error", { error: message, profileId });
      }
      context = null;
    }
    if (cdpPort > 0) {
      logger.browserStatus(profileId, "stopped", cdpPort);
    }
    logger.result("browser_stopped", { reason, exitCode, profileId });
    process.exit(exitCode);
  };

  const installCommands = (): void => {
    if (process.stdin.isTTY) {
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
    } else {
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
    }

    let buffer = "";
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as {
            command?: string;
            browserDownloadDir?: string;
            scraperDownloadDir?: string;
          };
          if (parsed.command === "extract_now" || parsed.command === "interactive_extract_now") {
            if (context) {
              void pushInteractiveExtractForContext(context, logger, profileId).catch((err) => {
                logger.warn("extract_now_failed", {
                  profileId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            } else {
              logger.warn("extract_now_no_context", { profileId });
            }
            continue;
          }
          if (parsed.command === "set_download_dirs") {
            configureDownloadRoots({
              browserDownloadDir: parsed.browserDownloadDir,
              scraperDownloadDir: parsed.scraperDownloadDir,
            });
            const target = context?.browser();
            if (target) {
              void applyBrowserDownloadDir(
                target,
                () => getResolvedDownloadPath("browser", profileId),
                logger,
                profileId,
              ).catch(() => undefined);
            }
            continue;
          }
          if (parsed.command === "restart") {
            if (restarting || !context) {
              logger.warn("browser_restart_ignored", {
                profileId,
                restarting,
                hasContext: Boolean(context),
              });
              continue;
            }
            restarting = true;
            logger.browserStatus(profileId, "restarting", cdpPort);
            logger.status("browser_restarting", { profileId, cdpPort });
            sessionResolve?.("restart");
            continue;
          }
          if (parsed.command === "shutdown") {
            sessionResolve?.("stdin_shutdown");
            return;
          }
        } catch {
          // fall through to substring shutdown check
        }

        if (trimmed.includes("shutdown")) {
          sessionResolve?.("stdin_shutdown");
          return;
        }
      }
    });

    process.once("SIGINT", () => sessionResolve?.("sigint"));
    process.once("SIGTERM", () => sessionResolve?.("sigterm"));
  };

  const waitForSessionEnd = (
    browser: { isConnected(): boolean; once(event: "disconnected", listener: () => void): void } | null,
  ): Promise<string> =>
    new Promise((resolve) => {
      let settled = false;
      sessionResolve = (reason: string) => {
        if (settled) {
          return;
        }
        settled = true;
        sessionResolve = null;
        resolve(reason);
      };
      if (!browser || !browser.isConnected()) {
        sessionResolve("browser_disconnected");
        return;
      }
      browser.once("disconnected", () => {
        if (restarting) {
          return;
        }
        sessionResolve?.("browser_disconnected");
      });
    });

  const closeContext = async (): Promise<void> => {
    if (!context) {
      return;
    }
    const closing = context;
    context = null;
    try {
      await Promise.race([
        closing.close(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 8000);
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("browser_close_error", { error: message, profileId });
    }
  };

  const attachWatchers = async (
    next: NonNullable<typeof context>,
    config: ProfileLaunchConfig,
  ): Promise<void> => {
    await attachContextUrlWatchers(next, logger, config.profileId);
    await attachInteractiveElementWatcher(
      next,
      true,
      config.userDataDir,
      logger,
      config.profileId,
    );
    void pushInteractiveExtractForContext(next, logger, config.profileId).catch(() => undefined);
  };

  try {
    const config = await parseLaunchConfig(process.argv.slice(2));
    profileId = config.profileId;
    cdpPort = config.cdpPort;
    installCommands();

    logger.status("launch_starting", {
      profileId: config.profileId,
      cdpPort: config.cdpPort,
      userDataDir: config.userDataDir,
      useGeoip: config.useGeoip,
      humanize: config.humanize,
      stealthPreset: config.stealthPreset,
    });

    context = await launchProfileBrowser(config, logger);
    await attachWatchers(context, config);

    while (!shuttingDown) {
      const reason = await waitForSessionEnd(context?.browser() ?? null);
      if (reason !== "restart") {
        await shutdown(reason);
        return;
      }
      await closeContext();
      if (cdpPort > 0) {
        await waitForCdpDown(cdpPort, 12_000);
      }
      try {
        context = await launchProfileBrowser(config, logger);
        await attachWatchers(context, config);
        restarting = false;
        logger.status("browser_restarted", { profileId, cdpPort });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("browser_restart_failed", { profileId, error: message });
        await shutdown("restart_failed", 1);
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("LAUNCH_FAILED")) {
      logger.launchError("LAUNCH_FAILED", message, profileId);
    }
    logger.error("launch_failed", { profileId, error: message });
    await shutdown("launch_failed", 1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.launchError("LAUNCH_FAILED", message, "unknown");
  logger.error("unhandled_launch_error", { error: message });
  process.exit(1);
});
