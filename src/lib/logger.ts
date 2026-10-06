/**
 * 前端统一日志封装（轻量、零依赖）。
 * - 模块前缀标签：createLogger("AIFillDrawer") → 输出形如 [AIFillDrawer] ...
 * - 环境变量开关：VITE_LOG_LEVEL=trace|debug|info|warn|error（默认 info，即静默 debug/trace）。
 * - 仅替换裸 console，不改动任何 IPC / 业务链路；warn/error 恒输出。
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

function resolveMinLevel(): LogLevel {
  const raw = (import.meta.env.VITE_LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw === "trace" || raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(tag: string): Logger {
  const minLevel = resolveMinLevel();
  const prefix = `[${tag}]`;
  const enabled = (level: LogLevel): boolean => LEVEL_RANK[level] >= LEVEL_RANK[minLevel];

  return {
    trace: (...args) => {
      if (enabled("trace")) console.debug(prefix, ...args);
    },
    debug: (...args) => {
      if (enabled("debug")) console.debug(prefix, ...args);
    },
    info: (...args) => {
      if (enabled("info")) console.info(prefix, ...args);
    },
    warn: (...args) => {
      if (enabled("warn")) console.warn(prefix, ...args);
    },
    error: (...args) => {
      if (enabled("error")) console.error(prefix, ...args);
    },
  };
}
