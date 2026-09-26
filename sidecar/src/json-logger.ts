import { reportOrFallback } from "./ipc_client.js";
import { redactSecretText, redactSecrets } from "./secret_redaction.js";
import { ENV_LOG_LEVEL, readAppEnv } from "./app_env.js";

export type JsonLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type JsonLogKind = "status" | "progress" | "log" | "error" | "result";

export interface JsonLogPayload {
  kind: JsonLogKind;
  level: JsonLogLevel;
  message: string;
  ts: string;
  data?: Record<string, unknown>;
  /** 模块前缀标签（如 "AI-Agent" / "WebView"），可选；不写入 message，避免破坏下游 message 精确匹配 */
  tag?: string;
}

/** 日志级别门控权重：仅对 kind==="log" 生效；status/progress/error/result 为协议事件恒过 */
const LEVEL_RANK: Record<JsonLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

let ipcGuardsInstalled = false;

/** agent_state.msg 默认上限：进度行是「当前进展」，不需要全文 */
const AGENT_STATE_MSG_MAX = 500;
/** 交付物正文上限（preserveFull 时生效）：信息型任务的结论就是交付物，不能截断 */
const AGENT_STATE_DELIVERABLE_MAX = 8000;

/** 与 Rust send_and_wait 的 waitId 对齐，终态原样回传避免 waiter 扇出 */
let activeCommandWaitId: string | null = null;

export function bindCommandWaitId(waitId: string | null | undefined): void {
  const trimmed = String(waitId ?? "").trim();
  activeCommandWaitId = trimmed || null;
}

export function getActiveCommandWaitId(): string | null {
  return activeCommandWaitId;
}

export function clearActiveCommandWaitId(matched?: string | null): void {
  if (!activeCommandWaitId) {
    return;
  }
  if (matched && matched.trim() && matched.trim() !== activeCommandWaitId) {
    return;
  }
  activeCommandWaitId = null;
}

function safeStdoutWrite(chunk: string): void {
  try {
    process.stdout.write(chunk, (error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "EPIPE") {
        process.stderr.write(`Stdout write failed: ${String(error)}\n`);
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
      process.stderr.write(`Stdout write threw: ${String(error)}\n`);
    }
  }
}

/**
 * 唯一出口：先做密钥脱敏再序列化，保证任何事件（含协议事件）都不会把明文密钥写进 stdout。
 * 对象 key 命中敏感词整体遮蔽；自由文本按密钥形态遮蔽，其余内容保持原样。
 */
function writeRedacted(record: Record<string, unknown>): void {
  safeStdoutWrite(`${JSON.stringify(redactSecrets(record))}\n`);
}

function emitFatalKeepAlive(kind: string, errorMessage: string): void {
  const ts = new Date().toISOString();
  writeRedacted({
    kind: "error",
    level: "error",
    message: kind,
    ts,
    data: { error: errorMessage, keepAlive: true },
  });
  // 唤醒可能挂起的 Rust waiter，同时通知前端；绝不 process.exit
  writeRedacted({
    type: "agent_state",
    state: "failed",
    step: 0,
    msg: `Sidecar 捕获致命错误（进程保持存活）: ${errorMessage}`,
    actions: [],
    ts,
  });
  writeRedacted({
    type: "rpa_state",
    state: "paused",
    step: 0,
    msg: `Sidecar 捕获致命错误（进程保持存活）: ${errorMessage}`,
    actions: [],
    ts,
  });
}

/**
 * 防止 Rust 宿主停止读取 stdout 时 EPIPE 导致 Sidecar 进程崩溃；
 * 并拦截 uncaughtException / unhandledRejection，避免 Node 进程暴毙引发 os error 232。
 * 所有 Sidecar 入口文件必须在任何日志输出前调用一次。
 */
export function installIpcGuards(): void {
  if (ipcGuardsInstalled) {
    return;
  }
  ipcGuardsInstalled = true;

  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      return;
    }
    process.stderr.write(`Stdout error: ${String(error)}\n`);
  });

  process.on("uncaughtException", (err: Error) => {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    emitFatalKeepAlive("uncaught_exception", message.trim());
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const message =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ""}`
        : typeof reason === "string"
          ? reason
          : JSON.stringify(reason);
    emitFatalKeepAlive("unhandled_rejection", message.trim());
  });
}

/**
 * Sidecar 唯一允许的输出通道：每条消息必须是单行 JSON，经 stdout 写出。
 * 禁止 console.log / console.error 等纯文本输出。
 */
export class JsonLogger {
  private minLevel: JsonLogLevel = "debug";
  private tag: string | undefined;

  constructor() {
    // 环境变量开关：TIANSHUTAI_LOG_LEVEL=trace|debug|info|warn|error（默认 debug，即仅静默新 trace 级）。
    this.setLevelFromEnv();
  }

  /** 设置全局日志级别（仅门控 kind==="log" 的 info/warn/debug/trace；error 协议事件恒过） */
  setLevel(level: JsonLogLevel): void {
    this.minLevel = level;
  }

  getLevel(): JsonLogLevel {
    return this.minLevel;
  }

  /** 从环境变量读取日志级别（非法/未设则保持当前值，缺省 debug 保证零行为变更） */
  setLevelFromEnv(suffix = ENV_LOG_LEVEL): void {
    const raw = readAppEnv(suffix)?.toLowerCase();
    if (!raw) {
      return;
    }
    if (raw === "trace" || raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
      this.minLevel = raw;
    }
  }

  /** 设置本实例的模块前缀标签（后续所有 write 都会带上 tag 字段） */
  setTag(tag: string | undefined): void {
    this.tag = tag;
  }

  write(payload: Omit<JsonLogPayload, "ts"> & { ts?: string }): void {
    // 仅 kind==="log" 受级别门控；status/progress/error/result 是 Rust 宿主/前端依赖的协议事件，必须恒过。
    if (payload.kind === "log" && LEVEL_RANK[payload.level] < LEVEL_RANK[this.minLevel]) {
      return;
    }
    const tag = payload.tag ?? this.tag;
    const line: JsonLogPayload = {
      ts: payload.ts ?? new Date().toISOString(),
      kind: payload.kind,
      level: payload.level,
      message: redactSecretText(payload.message),
      ...(payload.data !== undefined
        ? { data: redactSecrets(payload.data) as Record<string, unknown> }
        : {}),
      ...(tag ? { tag } : {}),
    };

    writeRedacted(line as unknown as Record<string, unknown>);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write({ kind: "log", level: "debug", message, data });
  }

  trace(message: string, data?: Record<string, unknown>): void {
    this.write({ kind: "log", level: "trace", message, data });
  }

  status(message: string, data?: Record<string, unknown>): void {
    this.write({ kind: "status", level: "info", message, data });
  }

  progress(message: string, data?: Record<string, unknown>): void {
    this.write({ kind: "progress", level: "info", message, data });
  }

  /**
   * Agent / 轨迹回放阶段进度：同时写 progress（终端）与 agent_state（Monitor）。
   * Monitor 只听 agent-state；仅 progress 会导致「假卡在任务分析」。
   *
   * `preserveFull`：交付物正文（如 done 的结论）要完整送给监视器，
   * 由前端自己决定折叠多少；其余进度仍按 AGENT_STATE_MSG_MAX 截短，避免刷爆 stdout。
   */
  agentProgress(message: string, data?: Record<string, unknown>): void {
    const text = String(message ?? "").trim();
    if (!text) {
      return;
    }
    this.progress(text, data);
    const profileId =
      (typeof data?.profileId === "string" && data.profileId.trim()) ||
      (typeof data?.profile_id === "string" && data.profile_id.trim()) ||
      undefined;
    // 勿把 plan/截图等大字段塞进 agent_state（stdout 行）
    const slim: Record<string, unknown> = {};
    if (data) {
      for (const key of ["phase", "step", "engine", "url", "elements", "error", "type", "selector"]) {
        if (data[key] !== undefined) slim[key] = data[key];
      }
    }
    const msgLimit = data?.preserveFull ? AGENT_STATE_DELIVERABLE_MAX : AGENT_STATE_MSG_MAX;
    this.agentState("running", {
      ...slim,
      ...(profileId ? { profileId } : {}),
      msg: text.slice(0, msgLimit),
    });
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write({ kind: "log", level: "info", message, data });
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write({ kind: "log", level: "warn", message, data });
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write({ kind: "error", level: "error", message, data });
  }

  result(message: string, data?: Record<string, unknown>): void {
    this.write({ kind: "result", level: "info", message, data });
  }

  /** Rust 宿主约定的字段级进度格式：{"type":"progress","field":"email",...} */
  fieldProgress(field: string, data?: Record<string, unknown>): void {
    writeRedacted({
      type: "progress",
      field,
      ts: new Date().toISOString(),
      ...data,
    });
  }

  /** 浏览器启动失败 — Rust 宿主直接解析 */
  launchError(code: string, message: string, profileId: string): void {
    writeRedacted({
      type: "error",
      code,
      message,
      profile_id: profileId,
      ts: new Date().toISOString(),
    });
  }

  /** 浏览器状态同步 — Rust 宿主转发为 browser-status 事件 */
  browserStatus(profileId: string, status: string, cdpPort: number): void {
    writeRedacted({
      type: "browser_status",
      profile_id: profileId,
      status,
      cdp_port: cdpPort,
      ts: new Date().toISOString(),
    });
  }

  /** AI 对话工具执行进度 */
  chatStatus(status: string, data?: Record<string, unknown>): void {
    writeRedacted({
      type: "chat_status",
      status,
      ts: new Date().toISOString(),
      ...data,
    });
  }

  /** RPA 状态机 — Rust 宿主与前端解析 */
  rpaState(state: string, data?: Record<string, unknown>): void {
    const waitId =
      (typeof data?.waitId === "string" && data.waitId.trim()) ||
      getActiveCommandWaitId() ||
      undefined;
    writeRedacted({
      type: "rpa_state",
      state,
      ts: new Date().toISOString(),
      ...(waitId ? { waitId } : {}),
      ...data,
    });
    if (state === "paused" || state === "complete" || state === "failed") {
      clearActiveCommandWaitId(typeof data?.waitId === "string" ? data.waitId : waitId);
    }
  }

  /** 遗留 agent_state 事件格式（IPC 致命错误兜底仍可能输出） */
  agentState(state: string, data?: Record<string, unknown>): void {
    const waitId =
      (typeof data?.waitId === "string" && data.waitId.trim()) ||
      getActiveCommandWaitId() ||
      undefined;
    writeRedacted({
      type: "agent_state",
      state,
      ts: new Date().toISOString(),
      ...(waitId ? { waitId } : {}),
      ...data,
    });
    if (state === "complete" || state === "failed") {
      clearActiveCommandWaitId(typeof data?.waitId === "string" ? data.waitId : waitId);
    }
  }

  /** Agent 人工确认请求 — Rust 转发为 agent-confirm-required */
  agentConfirmRequired(data: Record<string, unknown>): void {
    writeRedacted({
      type: "agent_confirm_required",
      ts: new Date().toISOString(),
      ...data,
    });
  }

  /** Agent 向用户提问 — Rust 转发为 agent-ask-user */
  agentAskUser(data: Record<string, unknown>): void {
    writeRedacted({
      type: "agent_ask_user",
      ts: new Date().toISOString(),
      ...data,
    });
  }

  /** Agent 人工接管（验证码/卡死）— Rust 转发为 agent-handover-required */
  agentHandoverRequired(data: Record<string, unknown>): void {
    writeRedacted({
      type: "agent_handover_required",
      ts: new Date().toISOString(),
      ...data,
    });
  }

  /** Agent 成功轨迹 — 优先走本地 IPC /report，失败回退 stdout（Rust 落库并转发） */
  agentTrajectory(data: Record<string, unknown>): void {
    const fallback = (): void => {
      writeRedacted({
        type: "agent_trajectory",
        ts: new Date().toISOString(),
        ...data,
      });
    };
    reportOrFallback("agent_trajectory", data, fallback);
  }

  /** P4.3：Agent Run History 起止摘要 — 与录制轨迹解耦，强制落库 */
  agentRun(data: Record<string, unknown>): void {
    const fallback = (): void => {
      writeRedacted({
        type: "agent_run",
        ts: new Date().toISOString(),
        ...data,
      });
    };
    reportOrFallback("agent_run", data, fallback);
  }

  /** 同站控件记忆 upsert — 优先走本地 IPC /report，失败回退 stdout（仅脱敏 selector/意图） */
  agentControlMemoryUpsert(data: Record<string, unknown>): void {
    const fallback = (): void => {
      writeRedacted({
        type: "agent_control_memory",
        ts: new Date().toISOString(),
        ...data,
      });
    };
    reportOrFallback("agent_control_memory", data, fallback);
  }

  /** 当前内存动作流快照 */
  rpaActions(actions: unknown[], stepIndex?: number): void {
    writeRedacted({
      type: "rpa_actions",
      actions,
      stepIndex: stepIndex ?? 0,
      ts: new Date().toISOString(),
    });
  }

  /** 单次 URL 查询响应（仅在 URL 变化时由 page_url_watcher 推送） */
  pageUrl(url: string, data?: Record<string, unknown>): void {
    writeRedacted({
      type: "page_url",
      url,
      ts: new Date().toISOString(),
      ...data,
    });
  }

  /** P4.4：Open Tabs 快照 — Rust 转发为 agent-open-tabs（控制台只读列表） */
  openTabs(data: Record<string, unknown>): void {
    writeRedacted({
      type: "open_tabs",
      ts: new Date().toISOString(),
      ...data,
    });
  }

  /** 爬虫采集结果 — Rust 转发为 scraper-data-collected */
  scraperDataCollected(data: unknown[], extra?: Record<string, unknown>): void {
    writeRedacted({
      type: "scraper_data_collected",
      data,
      ts: new Date().toISOString(),
      ...extra,
    });
  }

  /** 交互元素提取调试 — Rust 转发为 interactive-extract-updated */
  interactiveExtract(data: Record<string, unknown>): void {
    writeRedacted({
      type: "interactive_extract",
      ts: new Date().toISOString(),
      ...data,
    });
  }
}
