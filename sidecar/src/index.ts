import { chromium, type Browser, type Page } from "playwright-core";
import { humanizeConnectedBrowser } from "./cloakbrowser_extra.js";
import {
  bindAgentCdpUrl,
  isBrowserRestartArmed,
  onAgentBrowserReplaced,
} from "./browser_session.js";

import {
  bindActivePage,
  resetActivePageBinding,
  resolveActivePageFromBrowser,
} from "./cdp_session.js";
import { extractPageFormSchema } from "./dom_parser.js";
import { parseFillInput } from "./fill_export.js";
import { exportFillProfileToDataDir, createFillDataLedger } from "./core/fill_data_export.js";
import { fillActionsToRpaActions, mergeProfileIntoFillActions } from "./fill_action_builder.js";
import { runFillEngine, runFillEngineFromActions, type FillProfile, type SidecarAiSettings } from "./engine.js";
import { generateHybridFillProfile } from "./hybrid_fill.js";
import { generateRpaActionsFromProfile, remapRpaActionDataKeys } from "./rpa_action_generator.js";
import { randomUUID } from "node:crypto";
import { installIpcGuards, JsonLogger, bindCommandWaitId, clearActiveCommandWaitId } from "./json-logger.js";
import { IpcClient, reportOrFallback } from "./ipc_client.js";
import { attachStdinLineParser } from "./stdin_line_parser.js";
import {
  awaitPause,
  resumePause,
  startPauseHttpServer,
  stopPauseHttpServer,
} from "./task_pause_lock.js";
import {
  clearUserPauseRequest,
  drainUserPauseGate,
  requestUserPause,
  userPauseLockId,
} from "./bu_agent/user_pause_gate.js";
import {
  clearUserSuccessRequest,
  requestUserSuccess,
} from "./bu_agent/user_success_gate.js";
import { installParentProcessWatchdog } from "./parent_process_watchdog.js";
import {
  parseRpaActions,
  parseRpaData,
  RpaStateMachine,
  type RpaAction,
} from "./rpa_engine.js";
import { attachBrowserUrlWatchers, createPageUrlEmitter } from "./page_url_watcher.js";
import { applyBrowserDownloadDir, installDownloadAutoSaveOnBrowser } from "./download_autosave.js";
import { configureDownloadRoots, getResolvedDownloadPath } from "./utils/file_manager.js";
import {
  ENV_BROWSER_DOWNLOAD_DIR,
  ENV_PROFILE_ID,
  ENV_SCRAPER_DOWNLOAD_DIR,
  readAppEnv,
} from "./app_env.js";
import { prepareSmartElementFill } from "./smart_element_fill.js";
import { schemaToRpaActions } from "./rpa_schema.js";
import { buildFillReadyExportJson } from "./fill_export.js";
import {
  readInteractiveElementCache,
  snapshotInteractiveElements,
} from "./interactive_elements.js";
import { runAutonomousAgentLoop } from "./agent_loop.js";
import {
  buildChatSession,
  chatSnapshotPath,
  parseActiveRoleId,
  parseCadence,
  parseContactFlags,
  parseContactSeeds,
  parseRoles,
  parseTakeovers,
  type ChatSessionHandle,
} from "./bu_agent/chat_session.js";
import { closeChatPage, contextOf } from "./bu_agent/chat_actions.js";
import { listPageThreads } from "./bu_agent/chat_contacts.js";
import { learnSite } from "./bu_agent/chat_learn.js";
import {
  CHAT_CONTACTS_PER_SLICE_DEFAULT,
  CHAT_SLICE_MS_DEFAULT,
} from "./core/web_chat/slice_limits.js";
import { resolveLearnedConnectorDir } from "./core/web_chat/descriptor/registry.js";
import { parsePacingConfig } from "./core/web_chat/pacing.js";
import { parseControlMemorySeed } from "./cross_task_memory.js";
import { parseFieldOverrides } from "./deferred_generation.js";
import { parseGeoContext } from "./persona_engine.js";
import { replayTrajectoryOnPage, type ReplayEngineOptions } from "./replay_engine.js";
import { deliverAfterTrajectoryReplay, trajectoryNeedsAiDelivery } from "./replay_deliver.js";
import { openReplayTab, REPLAY_TAB_LIMIT } from "./core/replay_tabs.js";
import { buildReplayTemplateExtra, parseReplayRunIdentity } from "./core/replay_run.js";
import {
  buildTaskRulesBrief,
  createTaskRulesRuntime,
  evaluateTaskRules,
  guardUserConstraints,
  noteTaskRuleClick,
  shouldFireTaskRuleHitl,
} from "./core/task_rules.js";
import {
  ENGINE_BUSY_MESSAGE,
  formatEngineBusyMessage,
  isEngineBusy,
  type EngineBusyState,
} from "./engine_mutex.js";
import {
  deletePersistedTrajectory,
  listPersistedTrajectories,
  loadTrajectoryFromFile,
  unpackActionsWithReplayHints,
  type TrajectoryStep,
} from "./trajectory.js";
import { classifyExternalFillFields } from "./core/external_fill_gate.js";

installIpcGuards();
installParentProcessWatchdog();

const logger = new JsonLogger();

/** 外部数据 API 的硬上限：一次最多多少个字段、单个值多长（防误传整份表格/日志） */
const MAX_EXTERNAL_FIELDS = 64;
const MAX_EXTERNAL_VALUE_CHARS = 4096;

// —— Milestone 1：初始化本地 IPC 上报客户端（懒加载，未注入 env 则为 null）——
const ipcClient = IpcClient.global;
logger.status("ipc_client_init", {
  enabled: ipcClient !== null,
  baseUrl: ipcClient?.baseUrl ?? null,
});

let rpaMachine: RpaStateMachine | null = null;
let rpaRunning = false;
let agentRunning = false;
let trajectoryReplayRunning = false;
/**
 * 聊天模式（第四种执行形态，§0.4）正在占用该环境。
 *
 * 必须登记进同一个互斥（§7.4 / S5）：聊天有自己的引擎与循环，但「谁在占这台浏览器」
 * 只有一个答案。它由 `chat_start` 置位、`chat_stop` 与引擎退出时清位。
 */
let chatRunning = false;
/**
 * 正在**学习站点**（发现流水线）时的句柄。
 *
 * 学习同样在占用这台浏览器（会开/导航我们自己的聊天标签），所以也登记进 `chatRunning`
 * 这一把互斥 —— 但它**不是一片值守**：`chat_stop` 必须能把它一起中止，
 * 否则用户点了停止而学习还在跑（假停止）。
 */
let chatLearning: { controller: AbortController; waitId: string | null } | null = null;
/**
 * 当前聊天会话句柄（一个环境同时最多一个；§4.3「一个 run 一个 driver」）。
 * 持有 abort controller 与 done promise，供 `chat_stop` 精确停住并等待收尾。
 */
let chatSession: ChatSessionHandle | null = null;
let trajectoryReplayAbort: AbortController | null = null;
/**
 * 本次回放运行途中读取的剪贴板内容（`{{clip.N}}` / `{{clip.<into>}}`）。
 * **绝不落盘 / 绝不进日志**（R2 / §1.3）；每次回放开始时清空、结束时清空。
 * 数字键是顺序号（`{{clip.0}}`），具名键来自步骤的 `into`。
 */
let replayClipValues: Record<string, string> = {};

function engineBusySnapshot(): EngineBusyState {
  return { agentRunning, rpaRunning, trajectoryReplayRunning, chatRunning };
}

/** 互斥拦截：忙则写明确错误并返回 true（调用方应立即 return） */
function rejectIfEngineBusy(
  requested: string,
  channel: "agent" | "rpa",
  waitId?: string | null,
): boolean {
  const state = engineBusySnapshot();
  if (!isEngineBusy(state)) {
    return false;
  }
  const msg = formatEngineBusyMessage(state, requested);
  logger.warn("engine_busy_reject", { requested, ...state, msg, waitId: waitId ?? null });
  const waitPayload = waitId?.trim() ? { waitId: waitId.trim() } : {};
  if (channel === "agent") {
    logger.agentState("failed", { step: 0, msg, ...waitPayload });
  } else {
    logger.rpaState("paused", {
      step: 0,
      msg,
      actions: rpaMachine?.actions ?? [],
      ...waitPayload,
    });
  }
  return true;
}
/** stdin 命令串行队列：保证 rpaRunning 读改写原子、禁止并发污染 */
let commandQueue: Promise<void> = Promise.resolve();
const pageUrlEmitter = createPageUrlEmitter(logger);

type ConfirmResolver = (value: {
  approved: boolean;
  fillOverrides?: Record<string, string>;
}) => void;
type AskResolver = (value: string) => void;
type HostRequestResolver = (value: {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}) => void;

const pendingConfirmResolvers = new Map<string, ConfirmResolver>();
const pendingAskResolvers = new Map<string, AskResolver>();
const pendingHostResolvers = new Map<string, HostRequestResolver>();
/** 宿主请求超时（新建环境要落库，给足时间；超时后必须**失败**，不能让动作悬着） */
const HOST_REQUEST_TIMEOUT_MS = 20_000;
/**
 * `chat_stop` 等引擎收尾的限期：到点仍未落地就摘掉忙标记并补发终态行。
 * 正常收尾是毫秒级；这里只是保险丝，防「卡住的引擎把这个环境永久判成正忙」。
 */
const CHAT_STOP_SETTLE_MS = 20_000;
/**
 * 「读会话列表」这一次只读探针的预算：到点就带着人话原因返回。
 * 它是给视图勾选对象用的短任务，卡住时宁可如实说「读不到」，也不让宿主干等。
 */
const CHAT_LIST_CONTACTS_TIMEOUT_MS = 15_000;
const EVALUATE_TASK_RULES_TIMEOUT_MS = 20_000;
let agentAbortController: AbortController | null = null;

function enqueueCommand(task: () => Promise<void>): void {
  commandQueue = commandQueue
    .then(async () => {
      await task();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("command_queue_failed", { error: message });
    });
}

/**
 * 宿主请求通道（Sidecar → 宿主回环）。
 *
 * 环境是宿主的资产：Sidecar 只发「意图 + requestId」到 stdout，宿主落库/读系统资源后
 * 把结果写回 stdin。超时必须**失败**（不能返回 undefined 让调用方假装成功）。
 *
 * 为什么裸写 stdout：宿主按**顶层 `type`** 分发事件，而 `logger.result` 会把载荷塞进
 * `data` 里，宿主就看不见了（§0.5.3 坑族）。这里与 `browser_restart_request` 保持同一写法。
 */
async function requestHostChannel(
  kind: string,
  payload: Record<string, unknown>,
  profileId: string,
  timeoutMs: number = HOST_REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const requestId = `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingHostResolvers.delete(requestId);
      logger.warn("agent_host_request_timeout", { requestId, kind });
      resolve({ ok: false, error: "宿主没有响应（超时），请让用户手动处理" });
    }, timeoutMs);
    pendingHostResolvers.set(requestId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    process.stdout.write(
      `${JSON.stringify({
        type: "agent_host_request",
        requestId,
        kind,
        payload,
        profileId,
        ts: new Date().toISOString(),
      })}\n`,
    );
  });
}

function parseCdpUrl(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-url" && argv[index + 1]) {
      return argv[index + 1];
    }
    if (arg.startsWith("--cdp-url=")) {
      return arg.slice("--cdp-url=".length);
    }
  }

  throw new Error("missing required argument: --cdp-url");
}

/** 解析轨迹回放覆盖表（兼容旧 string 与新 {mode,value,label,inputType}） */
function parseValueOverrides(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  let hasPlain = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const selector = String(key ?? "").trim();
    if (!selector) {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // 结构化覆盖交给 parseFieldOverrides
      continue;
    }
    out[selector] = value == null ? "" : String(value);
    hasPlain = true;
  }
  return hasPlain ? out : undefined;
}

function attachStdinAbortListener(
  abortController: AbortController,
  onAbort: () => void | Promise<void>,
  onCommand?: (payload: Record<string, unknown>) => void | Promise<void>,
): void {
  /** 确认/问答必须绕过串行队列，否则会被 agent_start 阻塞 */
  const IMMEDIATE_COMMANDS = new Set([
    "agent_confirm",
    "agent_cancel",
    "agent_user_reply",
    "agent_handover_continue",
    "agent_host_response",
    "agent_pause",
    "agent_abort",
    "agent_success",
    "agent_bring_to_front",
    // 聊天值守可能正跑一个很长的片：停止必须绕过串行队列，否则「停不下来」
    "chat_stop",
  ]);

  attachStdinLineParser((trimmed) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.warn("ignored non-json stdin line", { line: trimmed });
      return;
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "command" in parsed &&
      (parsed as { command: unknown }).command === "abort"
    ) {
      if (!abortController.signal.aborted) {
        abortController.abort("stdin abort");
      }
      return;
    }

    if (onCommand && typeof parsed === "object" && parsed !== null && "command" in parsed) {
      const payload = parsed as Record<string, unknown>;
      const command = String(payload.command ?? "");
      if (IMMEDIATE_COMMANDS.has(command)) {
        void Promise.resolve(onCommand(payload)).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("immediate_command_failed", { command, error: message });
        });
        return;
      }
      enqueueCommand(async () => {
        await onCommand(payload);
      });
    }
  });

  abortController.signal.addEventListener(
    "abort",
    () => {
      void onAbort();
    },
    { once: true },
  );
}

async function disconnectBrowser(browser: Browser | null): Promise<void> {
  if (!browser || !browser.isConnected()) {
    return;
  }

  try {
    await browser.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("browser close reported an error during teardown", { error: message });
  }
}

function resolveActivePage(browser: Browser) {
  return resolveActivePageFromBrowser(browser);
}

/** 宽松布尔解析：只认真正的布尔值，缺省回落（避免 "false" 字符串被当成真） */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

interface ProxyAuthSettings {
  server: string;
  username?: string | null;
  password?: string | null;
}

function asProxyAuth(value: unknown): ProxyAuthSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const server = String(record.server ?? "").trim();
  if (!server) {
    return null;
  }
  return {
    server,
    username: record.username ? String(record.username) : null,
    password: record.password ? String(record.password) : null,
  };
}

/** 已挂过代理鉴权的 Page，避免重复 Fetch.enable 叠监听 */
const proxyAuthPages = new WeakSet<object>();
/** 已挂过代理鉴权的 BrowserContext，避免 install 被多条命令重复调用时累积 context.on("page") 监听 */
const proxyAuthContexts = new WeakSet<object>();

/**
 * CDP 代理鉴权兜底。
 * 注意：Fetch.enable 默认会拦截请求；若只处理 authRequired、不 continueRequest，
 * Playwright page.goto 会一直挂起（页面左上角转圈），而地址栏手动输入仍可能“看起来能开”。
 * Manifest V2 扩展是主路径；此处必须同时 continue 所有 requestPaused。
 */
async function attachProxyAuthToPage(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  if (proxyAuthPages.has(page)) {
    return;
  }
  proxyAuthPages.add(page);

  const session = await page.context().newCDPSession(page);

  session.on("Fetch.requestPaused", (event: { requestId?: string }) => {
    const requestId = event.requestId;
    if (!requestId) {
      return;
    }
    void session.send("Fetch.continueRequest", { requestId }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Target closed|Session closed|already been used/i.test(message)) {
        logger.warn("proxy_fetch_continue_failed", { error: message });
      }
    });
  });

  session.on("Fetch.authRequired", (event: { requestId?: string }) => {
    const requestId = event.requestId;
    if (!requestId) {
      return;
    }
    void session
      .send("Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username,
          password,
        },
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("proxy auth handler failed", { error: message });
      });
  });

  await session.send("Fetch.enable", { handleAuthRequests: true });
}

async function installProxyAuthHandler(browser: Browser, proxyAuth: ProxyAuthSettings): Promise<void> {
  const username = proxyAuth.username?.trim() ?? "";
  const password = proxyAuth.password?.trim() ?? "";
  if (!username) {
    return;
  }

  const contexts = browser.contexts();
  for (const context of contexts) {
    for (const page of context.pages()) {
      try {
        await attachProxyAuthToPage(page, username, password);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("proxy_auth_attach_page_failed", { error: message });
      }
    }
    // 同一 context 只挂一次 page 监听，避免 install 被多条命令重复调用时累积监听器
    if (proxyAuthContexts.has(context)) {
      continue;
    }
    proxyAuthContexts.add(context);
    context.on("page", (page) => {
      void attachProxyAuthToPage(page, username, password).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("proxy_auth_attach_newpage_failed", { error: message });
      });
    });
  }
  logger.status("proxy_auth_handler_installed", {
    server: proxyAuth.server,
    note: "Fetch.enable + continueRequest（修复代理下 goto 挂死）",
  });
}

function asOptionalFillProfile(value: unknown): FillProfile {
  if (value === undefined || value === null) {
    return {};
  }
  return asFillProfile(value);
}

function resolveUserDataDir(payload: Record<string, unknown>): string | null {
  const raw = payload.userDataDir ?? payload.user_data_dir;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePressEnterAfterFill(payload: Record<string, unknown>): boolean {
  return payload.pressEnterAfterFill === true || payload.press_enter_after_fill === true;
}

async function handleRpaStart(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  bindCommandWaitId(waitId);
  if (rejectIfEngineBusy("RPA 填表/启动", "rpa", waitId)) {
    return;
  }

  rpaRunning = true;
  try {
    const page = resolveActivePage(browser);
    const proxyAuth = asProxyAuth(payload.proxyAuth);
    if (proxyAuth) {
      await installProxyAuthHandler(browser, proxyAuth);
    }

    const skipHybrid = payload.skipHybrid === true || payload.skip_hybrid === true;
    const continuous =
      payload.continuous === true ||
      payload.continuousReplay === true ||
      payload.continuous_replay === true;
    const pressEnterAfterFill = resolvePressEnterAfterFill(payload);
    const rawInput = String(payload.rawInput ?? payload.raw_input ?? "").trim();
    const parsedFill = rawInput ? parseFillInput(rawInput) : null;
    const rawActions = parseRpaActions(payload.actions);
    let data = parseRpaData(payload.data ?? payload.profile);

    if (Object.keys(data).length === 0 && parsedFill && Object.keys(parsedFill.profile).length > 0) {
      data = parsedFill.profile;
    }

    if (payload.confirmedProfile !== undefined && payload.confirmedProfile !== null) {
      data = parseRpaData(payload.confirmedProfile);
    } else if (Object.keys(data).length === 0) {
      const partialProfile = asOptionalFillProfile(payload.profile);
      data = Object.fromEntries(
        Object.entries(partialProfile).map(([key, value]) => [key, String(value)]),
      );
    }

    let actions: RpaAction[] = rawActions;

    if (actions.length === 0 && parsedFill?.actions?.length) {
      actions = fillActionsToRpaActions(parsedFill.actions);
      logger.progress("rpa_actions_from_fill_export", { actionCount: actions.length });
    }

    if (actions.length === 0 && !skipHybrid) {
      const aiSettings = asAiSettings(payload.ai);
      const partialHint =
        rawInput ||
        Object.entries(data)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");

      logger.progress("rpa_hybrid_preprocess", { partialInputLength: partialHint.length });
      const userDataDir = resolveUserDataDir(payload);
      const hybridProfile = await generateHybridFillProfile(
        page,
        partialHint,
        aiSettings,
        logger,
        userDataDir,
      );
      data = Object.fromEntries(
        Object.entries(hybridProfile).map(([key, value]) => [key, String(value)]),
      );

      const schema = await extractPageFormSchema(page);
      try {
        actions = await generateRpaActionsFromProfile(schema, data, aiSettings, logger);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("rpa_action_llm_failed", { error: message, fallback: "schema_to_rpa_actions" });
        actions = remapRpaActionDataKeys(schemaToRpaActions(schema, 1, data), data);
      }
      logger.rpaActions(actions, 0);
    } else if (actions.length > 0 && Object.keys(data).length > 0) {
      actions = remapRpaActionDataKeys(actions, data);
    }

    rpaMachine = new RpaStateMachine(actions, data, {
      pressEnterAfterFill,
      pauseAfterClick: !continuous,
    });
    logger.status("rpa_session_ready", {
      actionCount: actions.length,
      dataKeys: Object.keys(data).length,
      continuous,
    });
    await rpaMachine.runUntilPause(page, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("rpa_start_failed", { error: message });
    logger.rpaState("paused", { step: 0, msg: message, actions: rpaMachine?.actions ?? [] });
  } finally {
    rpaRunning = false;
  }
}

async function handleRpaResume(browser: Browser): Promise<void> {
  if (!rpaMachine) {
    logger.warn("rpa_resume_ignored", { reason: "no_active_session" });
    logger.rpaState("paused", { step: 0, msg: "无活动 RPA 会话，请先启动填表" });
    return;
  }
  if (rejectIfEngineBusy("RPA 继续", "rpa", null)) {
    return;
  }

  rpaRunning = true;
  try {
    const page = resolveActivePage(browser);
    rpaMachine.resume();
    await rpaMachine.runUntilPause(page, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("rpa_resume_failed", { error: message });
    logger.rpaState("paused", {
      step: rpaMachine.stepIndex,
      msg: message,
      actions: rpaMachine.actions,
    });
  } finally {
    rpaRunning = false;
  }
}

async function handleRpaRescan(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const page = resolveActivePage(browser);
    const startStep = (rpaMachine?.actions.length ?? 0) + 1;
    const profileData = parseRpaData(payload.data ?? payload.profile);
    const rawInput = String(payload.rawInput ?? payload.raw_input ?? "").trim();
    const parsedFill = rawInput ? parseFillInput(rawInput) : null;
    const mergedProfile =
      Object.keys(profileData).length > 0
        ? profileData
        : parsedFill && Object.keys(parsedFill.profile).length > 0
          ? parsedFill.profile
          : profileData;
    const userDataDir = resolveUserDataDir(payload);

    let newActions: RpaAction[] = [];
    const cached = userDataDir ? await readInteractiveElementCache(userDataDir, page.url()) : null;
    if (cached) {
      const exportPayload = buildFillReadyExportJson(cached);
      newActions = fillActionsToRpaActions(
        mergeProfileIntoFillActions(exportPayload.fillActions, mergedProfile),
      ).map((action, index) => ({ ...action, step: startStep + index }));
      logger.progress("rpa_rescan_interactive_elements", { actionCount: newActions.length });
    } else {
      const snapshot = userDataDir
        ? await snapshotInteractiveElements(page, userDataDir)
        : null;
      if (snapshot) {
        const exportPayload = buildFillReadyExportJson(snapshot);
        newActions = fillActionsToRpaActions(
          mergeProfileIntoFillActions(exportPayload.fillActions, mergedProfile),
        ).map((action, index) => ({ ...action, step: startStep + index }));
        logger.progress("rpa_rescan_snapshot_elements", { actionCount: newActions.length });
      } else {
        const schema = await extractPageFormSchema(page);
        newActions = schemaToRpaActions(schema, startStep, mergedProfile);
        logger.progress("rpa_rescan_dom_schema", { actionCount: newActions.length });
      }
    }

    if (!rpaMachine) {
      rpaMachine = new RpaStateMachine([], mergedProfile);
    }

    rpaMachine.appendActions(newActions);
    rpaMachine.pauseManual();
    logger.rpaActions(rpaMachine.actions, rpaMachine.stepIndex);
    logger.rpaState("paused", {
      step: rpaMachine.stepIndex,
      msg: `已追加 ${newActions.length} 个步骤，等待继续执行`,
      actions: rpaMachine.actions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("rpa_rescan_failed", { error: message });
    logger.rpaState("paused", {
      step: rpaMachine?.stepIndex ?? 0,
      msg: `扫描失败: ${message}`,
      actions: rpaMachine?.actions ?? [],
    });
  }
}

async function handleRpaPause(): Promise<void> {
  if (!rpaMachine) {
    logger.rpaState("paused", { step: 0, msg: "无活动 RPA 会话" });
    return;
  }
  rpaMachine.pauseManual();
  logger.rpaState("paused", {
    step: rpaMachine.stepIndex,
    msg: "用户手动暂停",
    actions: rpaMachine.actions,
  });
}

async function handleGetUrl(browser: Browser): Promise<void> {
  try {
    const page = resolveActivePage(browser);
    // 这是请求/响应式查询，不是被动监听：必须无条件回一行
    pageUrlEmitter.emitQuery(page.url());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("get_url_failed", { error: message });
  }
}

async function handleLegacyFill(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  if (rejectIfEngineBusy("直接/混合填表", "rpa", waitId)) {
    throw new Error(
      formatEngineBusyMessage(engineBusySnapshot(), "直接/混合填表") || ENGINE_BUSY_MESSAGE,
    );
  }

  rpaRunning = true;
  try {
    await runLegacyFillBody(browser, payload);
  } finally {
    rpaRunning = false;
  }
}

async function runLegacyFillBody(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const page = resolveActivePage(browser);
  const partialProfile = asFillProfile(payload.profile);
  const directFill = payload.directFill === true || payload.direct_fill === true;
  let aiSettings: SidecarAiSettings | null = null;
  try {
    aiSettings = asAiSettings(payload.ai);
  } catch (error) {
    if (!directFill) {
      throw error;
    }
  }
  const proxyAuth = asProxyAuth(payload.proxyAuth);
  if (proxyAuth) {
    await installProxyAuthHandler(browser, proxyAuth);
  }

  const rawInput = String(payload.rawInput ?? payload.raw_input ?? "").trim();
  const skipHybrid = payload.skipHybrid === true || payload.skip_hybrid === true;
  const pressEnterAfterFill = resolvePressEnterAfterFill(payload);
  const userDataDir = resolveUserDataDir(payload);
  const partialHint =
    rawInput ||
    Object.entries(partialProfile)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

  logger.progress("fill_command_received", {
    fieldCount: Object.keys(partialProfile).length,
    textModel: aiSettings?.textModel ?? "direct-heuristic",
    hybrid: !skipHybrid && payload.confirmedProfile === undefined,
    directFill,
  });

  let completeProfile: FillProfile;
  if (payload.confirmedProfile !== undefined && payload.confirmedProfile !== null) {
    completeProfile = asFillProfile(payload.confirmedProfile);
  } else if (skipHybrid || directFill) {
    completeProfile = partialProfile;
  } else {
    if (!aiSettings) {
      throw new Error("混合推演填表需要配置 AI API Key");
    }
    completeProfile = await generateHybridFillProfile(
      page,
      partialHint,
      aiSettings,
      logger,
      userDataDir,
    );
  }

  if (Object.keys(completeProfile).length === 0) {
    throw new Error("填表数据为空或无法解析为 JSON 对象");
  }

  const parsedInput = parseFillInput(rawInput || JSON.stringify(completeProfile));
  const mergedProfile = { ...parsedInput.profile, ...completeProfile };
  const prebuiltActions =
    parsedInput.actions && parsedInput.actions.length > 0
      ? mergeProfileIntoFillActions(parsedInput.actions, mergedProfile).filter((action) =>
          action.action === "click" ? true : (action.value ?? "").trim().length > 0,
        )
      : null;

  if ((directFill || prebuiltActions) && prebuiltActions && prebuiltActions.length > 0) {
    logger.progress("fill_using_prebuilt_actions", { actionCount: prebuiltActions.length });
    await runFillEngineFromActions(page, prebuiltActions, logger, { pressEnterAfterFill });
    const fillProfileId =
      String(payload.profileId ?? payload.profile_id ?? "").trim() || "unknown";
    const exportProfile: Record<string, string> = {};
    for (const action of prebuiltActions) {
      if (action.action === "click") continue;
      const key = String(action.field || "").trim();
      const val = String(action.value ?? "").trim();
      if (key && val) exportProfile[key] = val;
    }
    exportFillProfileToDataDir({
      profileId: fillProfileId,
      profile: Object.keys(exportProfile).length > 0 ? exportProfile : mergedProfile,
      url: page.url(),
      logger,
    });
    return;
  }

  await runFillEngine(page, mergedProfile, logger, aiSettings, {
    userDataDir,
    directMappingOnly: directFill,
    pressEnterAfterFill,
  });
  exportFillProfileToDataDir({
    profileId: String(payload.profileId ?? payload.profile_id ?? "").trim() || "unknown",
    profile: mergedProfile,
    url: page.url(),
    logger,
  });
}

/**
 * 外部数据 API（Python/JSON）**唯一**的填表入口：只收「字段名 → 值」的数据，不收命令。
 *
 * 与 `handleLegacyFill` 的关键差别：
 * - 不解析 `rawInput`，因此 `{actions:[...]}` 这类**命令载荷**在这里根本无从生效；
 * - 填之前先过 `external_fill_gate`（字段名命中支付/证件/一次性凭证 → 整单拒绝），
 *   与 Agent `input` 的支付/凭证闸门同源同词典（R1/R2）；
 * - 结果按字段逐条回报，调用方能精确知道哪一项没落地（不允许「假装成功」）。
 */
async function handleExternalFill(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  const finish = (data: Record<string, unknown>): void => {
    // 单条终态行：宿主靠它判定「这一单结束了」（与 fill_engine_complete 同机制）
    logger.result("external_fill_result", { ...data, ...(waitId ? { waitId } : {}) });
    clearActiveCommandWaitId(waitId);
  };

  // 命令载荷一律拒绝：外部 API 的契约是「只传数据」（§4.2 / R4）
  if (payload.actions !== undefined || payload.commands !== undefined) {
    finish({
      ok: false,
      error: "外部数据 API 只接受 {fields:[{name,value}]} 数据载荷，不接受 actions/commands",
    });
    return;
  }

  const rawFields = payload.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    finish({ ok: false, error: "fields 必须是非空数组：[{name, value}, ...]" });
    return;
  }
  if (rawFields.length > MAX_EXTERNAL_FIELDS) {
    finish({
      ok: false,
      error: `一次最多提交 ${MAX_EXTERNAL_FIELDS} 个字段（收到 ${rawFields.length} 个）`,
    });
    return;
  }

  const profile: Record<string, string> = {};
  const names: string[] = [];
  for (const [index, entry] of rawFields.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      finish({ ok: false, error: `fields[${index}] 必须是 {name, value} 对象` });
      return;
    }
    const record = entry as Record<string, unknown>;
    const extraKeys = Object.keys(record).filter(
      (key) => key !== "name" && key !== "value" && key !== "selector",
    );
    if (extraKeys.length > 0) {
      finish({
        ok: false,
        error: `fields[${index}] 含不允许的键：${extraKeys.join("、")}（只允许 name / value）`,
      });
      return;
    }
    const name = String(record.name ?? "").trim();
    const value = record.value === undefined || record.value === null ? "" : String(record.value);
    if (!name) {
      finish({ ok: false, error: `fields[${index}] 缺少 name` });
      return;
    }
    if (value.length > MAX_EXTERNAL_VALUE_CHARS) {
      finish({
        ok: false,
        error: `fields[${index}] 的值超过 ${MAX_EXTERNAL_VALUE_CHARS} 字符上限`,
      });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(profile, name)) {
      finish({ ok: false, error: `字段名重复：${name}` });
      return;
    }
    profile[name] = value;
    names.push(name);
  }

  const gate = classifyExternalFillFields(names);
  if (gate.refused.length > 0) {
    logger.progress("external_fill_refused", {
      phase: "external_fill_gate",
      refused: gate.refused.map((item) => ({ name: item.name, reason: item.reason })),
    });
    finish({
      ok: false,
      refused: gate.refused,
      warnings: gate.warnings,
      error: "存在禁止由外部 API 填写的字段，整单已拒绝（未写入任何字段）",
    });
    return;
  }

  if (rejectIfEngineBusy("外部数据 API 填表", "rpa", waitId)) {
    finish({
      ok: false,
      error: formatEngineBusyMessage(engineBusySnapshot(), "外部数据 API 填表") || ENGINE_BUSY_MESSAGE,
    });
    return;
  }

  rpaRunning = true;
  try {
    const page = resolveActivePage(browser);
    logger.progress("external_fill_start", {
      phase: "external_fill",
      fieldCount: names.length,
      // 只报字段数量与名字，**不回传值**（一次性数据不留痕）
      fields: names,
    });
    const result = await runFillEngine(page, profile, logger, null, {
      directMappingOnly: true,
      pressEnterAfterFill: payload.pressEnterAfterFill === true,
    });
    const perField = result.results.map((item) => ({
      name: item.action.field,
      ok: item.ok,
      error: item.ok ? undefined : (item.error ?? "未落地"),
    }));
    const filledNames = new Set(perField.filter((item) => item.ok).map((item) => item.name));
    const missing = names.filter((name) => !filledNames.has(name));
    finish({
      ok: missing.length === 0,
      filled: filledNames.size,
      total: names.length,
      missing,
      warnings: gate.warnings,
      results: perField,
      error:
        missing.length === 0
          ? undefined
          : `有 ${missing.length} 个字段未落地：${missing.join("、")}（页面上可能没有对应输入框）`,
    });
  } finally {
    rpaRunning = false;
  }
}

async function handleSmartElementFill(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  if (rejectIfEngineBusy("智能填表", "rpa", waitId)) {
    throw new Error(
      formatEngineBusyMessage(engineBusySnapshot(), "智能填表") || ENGINE_BUSY_MESSAGE,
    );
  }

  rpaRunning = true;
  try {
    await runSmartElementFillBody(browser, payload);
  } finally {
    rpaRunning = false;
  }
}

async function runSmartElementFillBody(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const page = resolveActivePage(browser);
  const aiSettings = asAiSettings(payload.ai);
  const proxyAuth = asProxyAuth(payload.proxyAuth);
  if (proxyAuth) {
    await installProxyAuthHandler(browser, proxyAuth);
  }

  const naturalLanguage = String(
    payload.naturalLanguage ?? payload.natural_language ?? payload.rawInput ?? payload.raw_input ?? "",
  ).trim();
  if (!naturalLanguage) {
    throw new Error("智能填表需要自然语言描述（例如卡号、地址、姓名等）");
  }

  const userDataDir = resolveUserDataDir(payload);
  const seedRaw = String(payload.seedInput ?? payload.seed_input ?? "").trim();
  const seedParsed = seedRaw ? parseFillInput(seedRaw) : { profile: {}, actions: null, exportPayload: null };
  const requireExtract = payload.requireInteractiveExtract === true;

  if (requireExtract && !userDataDir) {
    throw new Error("智能填表需要环境 userDataDir（环境未启动或路径未传入）");
  }

  logger.progress("smart_element_fill_start", {
    textLength: naturalLanguage.length,
    hasSeedProfile: Object.keys(seedParsed.profile).length > 0,
  });

  const prepared = await prepareSmartElementFill(page, naturalLanguage, aiSettings, logger, {
    userDataDir,
    seedProfile: seedParsed.profile,
  });

  const actions = mergeProfileIntoFillActions(
    prepared.exportPayload.fillActions,
    prepared.fillProfile,
  ).filter((action) => (action.value ?? "").trim().length > 0);

  logger.result("smart_fill_ready", {
    type: "smart_fill_ready",
    exportPayload: prepared.exportPayload,
    fillProfile: prepared.fillProfile,
    filledFieldCount: prepared.filledFieldCount,
    actionCount: actions.length,
  });

  await runFillEngineFromActions(page, actions, logger, {
    pressEnterAfterFill: resolvePressEnterAfterFill(payload),
  });

  exportFillProfileToDataDir({
    profileId: String(payload.profileId ?? payload.profile_id ?? "").trim() || "unknown",
    profile: prepared.fillProfile,
    url: page.url(),
    logger,
  });

  logger.result("smart_element_fill_complete", {
    filledFieldCount: prepared.filledFieldCount,
    actionCount: actions.length,
  });
}

function resolvePendingConfirm(
  requestId: string,
  approved: boolean,
  fillOverrides?: Record<string, string>,
): boolean {
  const resolver = pendingConfirmResolvers.get(requestId);
  if (!resolver) {
    return false;
  }
  pendingConfirmResolvers.delete(requestId);
  resolver({ approved, fillOverrides });
  return true;
}

function resolvePendingAsk(requestId: string, answer: string): boolean {
  const resolver = pendingAskResolvers.get(requestId);
  if (!resolver) {
    return false;
  }
  pendingAskResolvers.delete(requestId);
  resolver(answer);
  return true;
}

function resolvePendingHandover(requestId: string): boolean {
  // Milestone 4：走真·挂起锁（HTTP / stdin 共用）
  return resumePause(requestId || null);
}

function resolvePendingHostRequest(
  requestId: string,
  value: { ok: boolean; data?: Record<string, unknown>; error?: string },
): boolean {
  const resolver = pendingHostResolvers.get(requestId);
  if (!resolver) {
    return false;
  }
  pendingHostResolvers.delete(requestId);
  resolver(value);
  return true;
}

function rejectAllAgentPendings(reason: string): void {
  for (const [id, resolver] of pendingConfirmResolvers) {
    pendingConfirmResolvers.delete(id);
    resolver({ approved: false });
  }
  for (const [id, resolver] of pendingAskResolvers) {
    pendingAskResolvers.delete(id);
    resolver(`（中止）${reason}`);
  }
  // 释放全部挂起锁，避免 Agent abort 后 Promise 永挂
  clearUserPauseRequest();
  clearUserSuccessRequest();
  resumePause(null);
  void reason;
}

function reportTaskBlocked(payload: {
  requestId: string;
  url: string;
  reason: string;
  profileId: string;
  ai_copy?: Record<string, unknown>;
}): void {
  const data = {
    requestId: payload.requestId,
    url: payload.url,
    reason: payload.reason,
    profileId: payload.profileId,
    pausedAt: new Date().toISOString(),
    ...(payload.ai_copy ? { ai_copy: payload.ai_copy } : {}),
  };
  const fallback = (): void => {
    logger.agentHandoverRequired(data);
  };
  reportOrFallback("agent_task_blocked", data, fallback);
  logger.agentState("paused", {
    step: 0,
    msg: `任务已挂起，等待人工接管：${payload.reason.slice(0, 80)}`,
    requestId: payload.requestId,
  });
}

async function handleAgentStart(
  browser: Browser,
  payload: Record<string, unknown>,
  waitId?: string | null,
): Promise<void> {
  const boundWaitId =
    waitId?.trim() || String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  bindCommandWaitId(boundWaitId);
  if (rejectIfEngineBusy("Agent 启动", "agent", boundWaitId)) {
    return;
  }

  const rawGoal = String(payload.goal ?? payload.userGoal ?? "").trim();
  const hasAttachments = Array.isArray(payload.attachments) && payload.attachments.length > 0;
  if (!rawGoal && !hasAttachments) {
    logger.agentState("failed", { step: 0, msg: "缺少用户目标 goal" });
    return;
  }
  // 只有附件没写目标：用兜底目标驱动任务，附件内容会一并交给模型
  const goal = rawGoal || "请根据所附图片/文件与当前页面完成相应操作，并在结束时说明结果。";

  const aiSettings = asAiSettings(payload.ai);
  const maxRounds = Number(payload.maxRounds ?? 200);
  const profileId = String(payload.profileId ?? payload.profile_id ?? "unknown").trim() || "unknown";
  const storage = (payload.storage && typeof payload.storage === "object"
    ? payload.storage
    : {}) as Record<string, unknown>;
  // 启动时已用 Rust 注入的环境变量配置过根目录；这里仅在 payload 明确带了值时才覆盖
  // （空值走 configureDownloadRoots 的「保留现值」语义，不会清回默认值）。
  const browserDownloadRoot =
    String(storage.browserDownloadDir ?? payload.browserDownloadDir ?? "").trim();
  const scraperDownloadRoot =
    String(storage.scraperDownloadDir ?? payload.scraperDownloadDir ?? "").trim();
  if (browserDownloadRoot || scraperDownloadRoot) {
    configureDownloadRoots({
      browserDownloadDir: browserDownloadRoot || undefined,
      scraperDownloadDir: scraperDownloadRoot || undefined,
    });
    // 目录可能刚被用户改过：重新下发浏览器级落盘目录，避免继续写进旧目录。
    await applyBrowserDownloadDir(
      browser,
      () => getResolvedDownloadPath("browser", profileId),
      logger,
      profileId,
    );
  }

  agentAbortController = new AbortController();
  agentRunning = true;
  clearUserPauseRequest();
  clearUserSuccessRequest();

  try {
    // 新任务从「第一个标签」开始：清掉上一次任务/命令留下的 switch 绑定。
    // 用户口径：没有明确要求操作 *N 时，默认操作第一个标签。
    resetActivePageBinding();
    const page = resolveActivePage(browser);
    bindActivePage(page);
    const proxyAuth = asProxyAuth(payload.proxyAuth);
    if (proxyAuth) {
      await installProxyAuthHandler(browser, proxyAuth);
    }

    const result = await runAutonomousAgentLoop(page, {
      logger,
      aiSettings,
      goal,
      profileId,
      userDataDir: resolveUserDataDir(payload),
      maxRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? maxRounds : 200,
      senseMode: String(payload.senseMode ?? payload.agentSenseMode ?? "balanced"),
      panoramaEnabled:
        payload.panoramaEnabled === true ||
        payload.agent_panorama_enabled === true ||
        payload.agentPanoramaEnabled === true,
      enableRecording:
        payload.enableRecording === true ||
        payload.enable_recording === true,
      controlMemorySeed: parseControlMemorySeed(
        payload.controlMemory ?? payload.control_memory,
      ),
      geoContext: parseGeoContext(payload.geoContext ?? payload.geo_context),
      otpChannel: payload.otpChannel ?? payload.otp_channel ?? null,
      resolveOtpSecret: buildOtpSecretResolver(payload),
      smsOtpService: payload.smsOtpService ?? payload.sms_otp_service ?? null,
      resolveSmsOtpSecret: buildSmsOtpSecretResolver(payload),
      captchaService: payload.captchaService ?? payload.captcha_service ?? null,
      resolveCaptchaSecret: buildCaptchaSecretResolver(payload),
      // 用户「规则」窗口：规则 / 人设 / Agent 输入框附件（缺省即不改变原行为）
      taskRules: payload.taskRules ?? payload.task_rules ?? null,
      taskPersona: payload.taskPersona ?? payload.task_persona ?? null,
      // attachments 是单词键，camel/snake 同名，无需双命名回退
      attachments: payload.attachments ?? null,
      signal: agentAbortController.signal,
      awaitUserPauseGate: () =>
        drainUserPauseGate({
          profileId,
          signal: agentAbortController?.signal,
          onPaused: (lockId) => {
            logger.agentState("paused", {
              step: 0,
              msg: "用户已暂停 Agent · 点击「继续」后从观察步恢复",
              requestId: lockId,
              phase: "user_pause",
            });
          },
          onResumed: (lockId) => {
            logger.agentState("running", {
              step: 0,
              msg: "用户继续 · 从观察步恢复",
              requestId: lockId,
              phase: "user_pause_resume",
            });
          },
        }),
      requestConfirm: (request) =>
        new Promise((resolve) => {
          pendingConfirmResolvers.set(request.requestId, resolve);
        }),
      requestHostRequest: async (request) => {
        /*
         * 环境是宿主的资产：Sidecar 只发「意图 + requestId」到 stdout，宿主落库后
         * 把结果写回 stdin。超时必须**失败**（不能返回 undefined 让动作假装成功）。
         */
        return requestHostChannel(request.kind, request.payload ?? {}, profileId);
      },
      askUser: (requestId, _question, meta) =>
        new Promise((resolve) => {
          pendingAskResolvers.set(requestId, resolve);
          void meta;
        }),
      requestHandover: async (request) => {
        const profileIdStr = String(profileId ?? "").trim();
        reportTaskBlocked({
          requestId: request.requestId,
          url: request.url ?? "",
          reason: request.reason ?? "需要人工接管",
          profileId: profileIdStr,
          ai_copy: request.ai_copy as Record<string, unknown> | undefined,
        });
        // 真·挂起：未决 Promise，直到 resume（HTTP / stdin）调用 resolve
        await awaitPause(request.requestId);
        logger.agentState("running", {
          step: 0,
          msg: "人工接管完成，恢复执行",
          requestId: request.requestId,
        });
      },
    });

    logger.result("agent_loop_done", {
      success: result.success,
      summary: result.summary,
      rounds: result.rounds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("agent_start_failed", { error: message });
    logger.agentState("failed", { step: 0, msg: message });
  } finally {
    rejectAllAgentPendings("Agent 已结束");
    agentRunning = false;
    agentAbortController = null;
  }
}

/* ————————————————————————— 聊天模式（第四种执行形态，§0.4） ————————————————————————— */

/**
 * 启动聊天模式值守。
 *
 * 与 Agent / RPA / 回放**共用同一个互斥**：忙则拒绝（S5）。启动后引擎按自己的相位
 * 跑一个值守片，片末让位并把 `nextWakeAt` 写进快照；由 Host 调度器决定何时再拉起。
 */
async function handleChatStart(
  browser: Browser,
  payload: Record<string, unknown>,
  waitId?: string | null,
): Promise<void> {
  const boundWaitId = waitId?.trim() || String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  bindCommandWaitId(boundWaitId);

  // 互斥（S5）：任何引擎在跑都不允许再起聊天
  const busy = engineBusySnapshot();
  if (isEngineBusy(busy)) {
    const msg = formatEngineBusyMessage(busy, "聊天模式启动") || ENGINE_BUSY_MESSAGE;
    logger.warn("engine_busy_reject", { requested: "聊天模式启动", ...busy, msg, waitId: boundWaitId });
    // 只走聊天协议终态（带 waitId + stopReason），**不**打 agentState(failed)：
    // 否则 Agent 监视栏会多一条吓人的「失败」，调度器还可能把正忙当成硬失败去退避挂起。
    logger.chatProgress(msg, {
      type: "chat_state_update",
      phase: "stopped",
      stopReason: "engine_busy",
      ...(boundWaitId ? { waitId: boundWaitId } : {}),
    });
    return;
  }

  const contacts = parseContactSeeds(payload.contacts ?? payload.targets);
  /**
   * 「没指定对象 → 用**当前打开的**聊天窗口」（用户显式意图：`useCurrentWindow`）。
   *
   * 注意这里**只是放行空名单**，真正「绑哪个会话」由 Sidecar 会话装配层在运行期
   * 用 `resolveCurrentConversation` 判定（必须确认那确实是一个聊天页，不猜）。
   * 没有这个标志又没给名单 → 仍然拒绝启动（不猜对象）。
   */
  const useCurrentWindow = payload.useCurrentWindow === true || payload.use_current_window === true;
  if (contacts.length === 0 && !useCurrentWindow) {
    const msg = "聊天模式未指定联系人（需要 host 明确给出要聊的对象，不猜）";
    logger.chatProgress(msg, { type: "chat_state_update", phase: "stopped", stopReason: "no_contacts" });
    logger.agentState("failed", { step: 0, msg, ...(boundWaitId ? { waitId: boundWaitId } : {}) });
    return;
  }

  const envId = String(readAppEnv(ENV_PROFILE_ID) ?? "").trim() || "unknown";
  const profileIdNum = Number(payload.profileId ?? payload.profile_id ?? NaN);
  const userDataDir = resolveUserDataDir(payload);

  // 每联系人上下文必须落在该环境的 userDataDir 里（环境删除才能一并清掉，避免串号）。
  // 拿不到就**不启动**，而不是悄悄跑一个「没有记忆」的聊天——那是静默降级（§0.5.3 B）。
  if (!userDataDir) {
    const msg = "聊天模式缺少 userDataDir：无法持久化每联系人上下文，已拒绝启动";
    logger.chatProgress(msg, { type: "chat_state_update", phase: "stopped", stopReason: "no_user_data_dir" });
    logger.agentState("failed", { step: 0, msg, ...(boundWaitId ? { waitId: boundWaitId } : {}) });
    return;
  }

  const sliceMs = Number(payload.sliceMs ?? payload.slice_ms ?? CHAT_SLICE_MS_DEFAULT);
  const maxContacts = Number(
    payload.maxContactsPerSlice ?? payload.max_contacts ?? CHAT_CONTACTS_PER_SLICE_DEFAULT,
  );

  const controller = new AbortController();
  /**
   * 页内哨兵 / 事件桥的**成对销毁**（坑族 J / R8 第③条）。
   *
   * 会话装配层把销毁钩子登记进来，这里在**这一片真正落地**时执行一次：
   * 观察器与 `exposeFunction` 是**页面级**资源 —— 尤其「用当前打开的窗口」那条路径，
   * 那个标签属于用户，收工后必须还回去（不许留着常驻拦截全站键盘）。
   */
  let disposeConnector: (() => Promise<void>) | null = null;
  // 每联系人开关解析出的坏值：**不许静默丢弃**（§0.5.3 B）—— 收集起来在下面如实记一条日志
  const contactFlagDiagnostics: string[] = [];
  const roleDiagnostics: string[] = [];
  const roles = parseRoles(payload.roles, roleDiagnostics);
  const activeRoleId = parseActiveRoleId(
    payload.activeRoleId ?? payload.active_role_id,
    roles,
    roleDiagnostics,
  );
  const engine = buildChatSession({
    browser,
    logger,
    aiSettings: asAiSettings(payload.ai),
    contacts,
    signal: controller.signal,
    registerDispose: (fn) => {
      disposeConnector = fn;
    },
    askUser: (requestId, _question, meta) =>
      new Promise((resolve) => {
        pendingAskResolvers.set(requestId, resolve);
        void meta;
      }),
    config: {
      envId,
      profileId: Number.isFinite(profileIdNum) ? profileIdNum : null,
      goal: String(payload.goal ?? "").trim(),
      styleHint: String(payload.styleHint ?? payload.style_hint ?? "").trim() || null,
      bannedWords: Array.isArray(payload.bannedWords)
        ? payload.bannedWords.map((w) => String(w)).filter(Boolean)
        : [],
      sliceMs: Number.isFinite(sliceMs) && sliceMs > 0 ? sliceMs : CHAT_SLICE_MS_DEFAULT,
      maxContactsPerSlice:
        Number.isFinite(maxContacts) && maxContacts > 0
          ? maxContacts
          : CHAT_CONTACTS_PER_SLICE_DEFAULT,
      cadence: parseCadence(payload.cadence ?? payload.chatCadence),
      pacing: parsePacingConfig(payload.pacing, []),
      takeovers: parseTakeovers(payload.takeovers ?? payload.chatTakeovers),
      contactFlags: parseContactFlags(
        payload.contactFlags ?? payload.contact_flags,
        contactFlagDiagnostics,
      ),
      roles,
      activeRoleId,
      mediaLibraryDir:
        String(payload.mediaLibraryDir ?? payload.media_library_dir ?? "").trim() || null,
      snapshotFile: chatSnapshotPath(userDataDir, envId),
      userDataDir,
      useCurrentWindow,
      taskRules: payload.taskRules ?? payload.task_rules ?? null,
      taskPersona: payload.taskPersona ?? payload.task_persona ?? null,
    },
  });

  chatRunning = true;
  if (contactFlagDiagnostics.length > 0) {
    // 坏设置会让「用户以为关了、其实还在发」或反过来；如实说清哪几条没认，不静默降级
    logger.warn("chat_contact_flags_diagnostics", {
      diagnostics: contactFlagDiagnostics,
      count: contactFlagDiagnostics.length,
    });
  }
  if (roleDiagnostics.length > 0) {
    logger.warn("chat_roles_diagnostics", {
      diagnostics: roleDiagnostics,
      count: roleDiagnostics.length,
    });
  }
  logger.chatProgress(
    useCurrentWindow && contacts.length === 0
      ? "开始值守（用你当前打开的聊天窗口）"
      : `开始值守（要聊 ${contacts.length} 人）`,
    {
      type: "chat_start",
      phase: "booting",
      envId,
      contactCount: contacts.length,
      useCurrentWindow,
      ...(boundWaitId ? { waitId: boundWaitId } : {}),
    },
  );

  const done = engine
    .run()
    .then((result) => {
      logger.result("chat_engine_done", {
        stopReason: result.stopReason,
        processed: result.processed,
        sent: result.sent,
        skipped: result.skipped,
        nextWakeAt: result.snapshot.engine.nextWakeAt,
        note: result.note ?? null,
      });
      logger.chatProgress(`聊天值守结束：${result.stopReason}`, {
        type: "chat_state",
        phase: result.snapshot.engine.phase,
        stopReason: result.stopReason,
        processed: result.processed,
        sent: result.sent,
        skipped: result.skipped,
        nextWakeAt: result.snapshot.engine.nextWakeAt,
        // 片终态带上人话原因（目前是 `no_targets` 的「为什么没对象可聊 + 现在该做什么」）：
        // 宿主把它透传进 `msg`，视图据此弹提示 —— 否则用户只看到「开始 1 秒后结束」（§0.5.3 H）
        msg: result.note ?? null,
        ...(boundWaitId ? { waitId: boundWaitId } : {}),
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("chat_engine_failed", { error: message });
      logger.chatProgress(`聊天值守异常：${message.slice(0, 200)}`, {
        type: "chat_state",
        phase: "stopped",
        stopReason: "exception",
        ...(boundWaitId ? { waitId: boundWaitId } : {}),
      });
    })
    .finally(() => {
      // 身份校验：被强制停掉之后可能已经起了**新的一片**，
      // 老引擎迟到收尾绝不能把新会话的忙标记抹掉（否则两片互相覆盖）。
      if (chatSession?.engine === engine) {
        chatRunning = false;
        chatSession = null;
      }
      clearActiveCommandWaitId(boundWaitId);
      // 收尾必须释放页内资源（幂等；失败不改这一片的结论，也不许把终态行吞掉）
      void disposeConnector?.().catch(() => undefined);
      for (const [id, resolver] of pendingAskResolvers) {
        if (!id.startsWith("chat-")) continue;
        pendingAskResolvers.delete(id);
        resolver("（中止）聊天值守已结束");
      }
    });

  chatSession = { engine, controller, done, waitId: boundWaitId };
}

/** 停止聊天值守：中止 + 等收尾 + 关掉聊天专用标签（只关自己开的） */
async function handleChatStop(browser: Browser | null, payload: Record<string, unknown>): Promise<void> {
  const handle = chatSession;
  const learning = chatLearning;
  if (!handle && !learning) {
    // 没在跑也要把忙标记归位：否则一次异常退出会把这个环境**永久**判成「正忙」，
    // 之后 Agent / 回放 / 填表全都被拒，而 UI 没有任何手段能自行恢复。
    chatRunning = false;
    logger.chatProgress("聊天模式本来就没在跑", { type: "chat_state", phase: "stopped" });
    return;
  }
  const reason = String(payload.reason ?? "user_stop");

  if (learning) {
    // 学习也必须能被停下（否则就是「假停止」）：中止信号由 learnSite 一路透传进采集/推断/自检
    chatLearning = null;
    chatRunning = false;
    learning.controller.abort(reason);
    logger.chatProgress("站点学习已请求停止", {
      type: "chat_state",
      phase: "stopped",
      stopReason: reason,
      ...(learning.waitId ? { waitId: learning.waitId } : {}),
    });
    clearActiveCommandWaitId(learning.waitId);
  }

  if (!handle) {
    // 只有学习在跑：上面已经中止并摘了忙标记，不需要再等一片值守的收尾
    logger.chatProgress(`聊天值守已停止（${reason}）`, {
      type: "chat_state",
      phase: "stopped",
      stopReason: reason,
    });
    return;
  }

  // 先摘会话与忙标记，再等收尾：停止必须即时生效，不能被一个卡住的 LLM 调用挂住
  // （与 `agent_abort` 同口径）。收尾由下面的限期等待负责，超时即如实上报（不静默）。
  if (chatSession?.engine === handle.engine) {
    chatSession = null;
    chatRunning = false;
  }
  handle.controller.abort(reason);

  const settled = await Promise.race([
    handle.done.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), CHAT_STOP_SETTLE_MS);
    }),
  ]);

  if (!settled) {
    // 引擎在限期内没落地：忙标记已摘（环境可重新拉起），但必须留痕，
    // 并补发终态行让宿主 waiter 立刻结算（否则宿主只能干等自己的 300s 超时）。
    logger.chatProgress("聊天引擎未在限期内收工，已强制摘除忙标记（该环境可重新拉起）", {
      type: "chat_state",
      phase: "stopped",
      stopReason: "force_stopped",
      ...(handle.waitId ? { waitId: handle.waitId } : {}),
    });
    clearActiveCommandWaitId(handle.waitId);
  }

  // 关掉聊天标签，别把用户浏览器留一堆我们开的页
  if (browser) {
    try {
      await closeChatPage(contextOf(browser));
    } catch {
      /* 浏览器可能已关，忽略 */
    }
  }
  logger.chatProgress(`聊天值守已停止（${reason}）`, { type: "chat_state", phase: "stopped", stopReason: reason });
}

/* 不在本进程回答：`chat_status` 由 Host 读快照文件 + `chat_threads` 索引作答
   （`chat_context.rs::read_chat_runtime_status`），这样**没有活会话时也能答**（§0.5.3 H）。 */

/* ————————————————————— 站点描述符：学习（P5 发现流水线） ————————————————————— */
/* 总览与删除走一次性 CLI（`chat_connector_cli.js`）；本进程只负责**学习当前站点**。 */

/**
 * 学习当前站点：采集 → 推断 → 机器自检 →（通过才）落盘。
 *
 * 这是**长任务**（要调模型、可能多轮修正），因此：
 *   - 进度行**不带** waitId（片内进度不该唤醒宿主，§0.5.3 E）；
 *   - 终态单独发一条带 waitId 的 `chat_learn_done`，宿主据此结算；
 *   - 学不成也要有终态（`ok:false` + 人话原因），绝不让宿主干等超时。
 */
async function handleChatLearnSite(
  browser: Browser,
  payload: Record<string, unknown>,
  waitId?: string | null,
): Promise<void> {
  const boundWaitId = waitId?.trim() || String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  bindCommandWaitId(boundWaitId);

  // 互斥（S5）：学习会开/导航聊天标签，别的引擎在跑就不许开始
  const busy = engineBusySnapshot();
  if (isEngineBusy(busy)) {
    const msg = formatEngineBusyMessage(busy, "站点学习") || ENGINE_BUSY_MESSAGE;
    logger.warn("engine_busy_reject", { requested: "站点学习", ...busy, msg, waitId: boundWaitId });
    logger.chatProgress(msg, {
      type: "chat_learn_done",
      ok: false,
      outcome: "failed",
      phase: "stopped",
      stopReason: "engine_busy",
      ...(boundWaitId ? { waitId: boundWaitId } : {}),
    });
    clearActiveCommandWaitId(boundWaitId);
    return;
  }

  const userDataDir = resolveUserDataDir(payload) ?? null;
  if (!userDataDir) {
    // 学习成果必须落在该环境自己的目录里；拿不到就**不学**（免得写到一个猜出来的全局路径）
    const msg = "站点学习缺少该环境的数据目录：不落盘的学习没有意义，已拒绝开始";
    logger.chatProgress(msg, {
      type: "chat_learn_done",
      ok: false,
      outcome: "failed",
      phase: "stopped",
      stopReason: "no_user_data_dir",
      ...(boundWaitId ? { waitId: boundWaitId } : {}),
    });
    clearActiveCommandWaitId(boundWaitId);
    return;
  }

  const aiSettings = asAiSettings(payload.ai);
  const controller = new AbortController();
  chatLearning = { controller, waitId: boundWaitId };
  chatRunning = true;

  const selfTestRaw = payload.selfTestContact ?? payload.self_test_contact;
  const selfTestContact =
    selfTestRaw && typeof selfTestRaw === "object" && !Array.isArray(selfTestRaw)
      ? {
          label: String((selfTestRaw as Record<string, unknown>).label ?? "").trim(),
          url:
            typeof (selfTestRaw as Record<string, unknown>).url === "string"
              ? String((selfTestRaw as Record<string, unknown>).url)
              : null,
        }
      : null;

  try {
    const result = await learnSite({
      browser,
      logger,
      aiSettings,
      userDataDir,
      url: typeof payload.url === "string" ? payload.url : null,
      siteLabel: typeof payload.siteLabel === "string" ? payload.siteLabel : null,
      slot: payload.slot === "fast_text" ? "fast_text" : "logic",
      maxRounds: Number.isFinite(Number(payload.maxRounds)) ? Number(payload.maxRounds) : undefined,
      selfTestContact: selfTestContact && selfTestContact.label ? selfTestContact : null,
      signal: controller.signal,
    });

    logger.chatProgress(result.summary, {
      type: "chat_learn_done",
      ok: result.ok,
      outcome: result.outcome,
      siteKey: result.siteKey,
      descriptorId: result.descriptorId,
      savedPaths: result.savedPaths,
      readVerified: result.readVerified,
      sendVerified: result.sendVerified,
      attempts: result.attempts,
      usage: result.usage,
      checks: result.checks,
      schemaDiagnostics: result.schemaDiagnostics,
      learnedDir: resolveLearnedConnectorDir(userDataDir),
      preview: result.preview,
      ...(boundWaitId ? { waitId: boundWaitId } : {}),
    });
    clearActiveCommandWaitId(boundWaitId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("chat_learn_failed", { error: message });
    logger.chatProgress(`站点学习失败：${message.slice(0, 200)}`, {
      type: "chat_learn_done",
      ok: false,
      outcome: "failed",
      phase: "stopped",
      stopReason: "exception",
      ...(boundWaitId ? { waitId: boundWaitId } : {}),
    });
    clearActiveCommandWaitId(boundWaitId);
  } finally {
    // 身份校验后清理：别把后来者的状态抹掉（§0.5.3 H「老引擎迟到收尾」）
    if (chatLearning?.controller === controller) {
      chatLearning = null;
      chatRunning = false;
    }
  }
}

/**
 * 「读当前浏览器里那个聊天页的会话列表」——视图里勾选聊天对象的**只读**探针。
 *
 * 纪律：
 *   - **只读**：不点击 / 不导航 / 不新开 / 不滚动（`chat_contacts.ts` 页内函数里也没有这些动作）；
 *   - **无对话内容**：返回的只有展示名 / 会话直链 / 未读标记，正文一个字都不取；
 *   - **不占互斥**：它不建会话、不改状态，也不是「引擎」，因此不进 `engine_mutex`；
 *     但宿主在引擎忙时**会先拒**（并发读页只会让两边都读不准）；
 *   - **终态裸写 stdout**：宿主按顶层 `type` 分发（`logger.result` 会把载荷塞进 `data`，
 *     宿主永远收不到 → 请求悬到超时的老坑，§0.5.3 E）。
 */
async function handleChatListContacts(
  browser: Browser,
  payload: Record<string, unknown>,
  waitId?: string | null,
): Promise<void> {
  const boundWaitId = waitId?.trim() || String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  const userDataDir = resolveUserDataDir(payload) ?? null;
  // 预算是硬的：读列表是短任务，卡住就往回说，不让宿主的 waiter 干等（§0.5.3 E）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), CHAT_LIST_CONTACTS_TIMEOUT_MS);
  try {
    const result = await listPageThreads(browser, {
      userDataDir,
      signal: controller.signal,
      onDiagnostic: (code, detail) => logger.warn("chat_list_contacts_diagnostic", { code, detail }),
    });
    process.stdout.write(
      `${JSON.stringify({
        type: "chat_contacts_list",
        ok: result.ok,
        reason: result.reason,
        source: result.source,
        siteKey: result.siteKey,
        pageUrl: result.pageUrl,
        items: result.items.map((item) => ({
          key: item.key,
          // 标签在探针里已经过统一脱敏（`sanitizeForLedger`），且身份（`flagKey`）
          // 就是用这个标签算出来的 —— 这里不再动它，否则视图回传的标签会对不上身份。
          label: item.label,
          url: item.url,
          unread: item.unread,
          // 视图把「自动聊天」写进设置表时用的键（由侧车算，前端不自己拼）
          flagKey: item.flagKey,
        })),
        scannedAt: new Date().toISOString(),
        ...(boundWaitId ? { waitId: boundWaitId } : {}),
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("chat_list_contacts_failed", { error: message });
    // 失败也要有终态：否则宿主的 waiter 只能干等超时（§0.5.3 E）
    process.stdout.write(
      `${JSON.stringify({
        type: "chat_contacts_list",
        ok: false,
        reason: `读取会话列表失败：${message.slice(0, 200)}`,
        source: "generic",
        siteKey: "unknown",
        pageUrl: null,
        items: [],
        ...(boundWaitId ? { waitId: boundWaitId } : {}),
      })}\n`,
    );
  } finally {
    clearTimeout(timer);
    clearActiveCommandWaitId(boundWaitId);
  }
}

/** 与 `task_rules.isMachineCheckable` 同口径（该函数未导出） */
function taskRuleIsMachineCheckable(rule: {
  kind: string;
  selector?: string;
  matchText?: string;
  image?: string;
}): boolean {
  return (
    (rule.kind === "dom" && Boolean(rule.selector || rule.matchText)) ||
    (rule.kind === "vision" && Boolean(rule.image))
  );
}

/**
 * 规则试跑（只读）：对当前页评估传入的规则，不写状态、不占引擎互斥。
 * 探针失败 / 无页 → inconclusive 或 ok:false，**绝不**把探针失败标成 not_matched。
 */
async function handleEvaluateTaskRules(
  browser: Browser,
  payload: Record<string, unknown>,
  waitId?: string | null,
): Promise<void> {
  const boundWaitId = waitId?.trim() || String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), EVALUATE_TASK_RULES_TIMEOUT_MS);

  const emit = (body: Record<string, unknown>) => {
    process.stdout.write(
      `${JSON.stringify({
        type: "task_rules_try_result",
        ...body,
        ...(boundWaitId ? { waitId: boundWaitId } : {}),
      })}\n`,
    );
  };

  try {
    let page: Page;
    let pageUrl: string | null = null;
    try {
      page = resolveActivePage(browser);
      pageUrl = page.url();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        ok: false,
        reason: `无法获取当前页面：${message.slice(0, 200)}`,
        pageUrl: null,
        results: [],
      });
      return;
    }

    const taskRulesRaw = payload.taskRules ?? payload.task_rules;
    const taskRules = Array.isArray(taskRulesRaw) ? taskRulesRaw : [];
    const runtime = createTaskRulesRuntime({
      taskRules,
      taskPersona: null,
      attachments: null,
    });

    if (!runtime || runtime.rules.length === 0) {
      emit({
        ok: true,
        reason: runtime ? "没有可判定的规则条目" : "未解析出有效规则",
        pageUrl,
        results: [],
      });
      return;
    }

    const allowVision = bool(payload.allowVision ?? payload.allow_vision, false);
    const aiSettings =
      allowVision && payload.ai
        ? asAiSettings(payload.ai)
        : { apiKey: "", apiBaseUrl: "" };

    let checked: Awaited<ReturnType<typeof evaluateTaskRules>>;
    try {
      checked = await evaluateTaskRules(runtime, {
        page,
        aiSettings,
        step: 0,
        signal: controller.signal,
        allowVision,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("evaluate_task_rules_failed", { error: message });
      emit({
        ok: false,
        reason: `规则试跑失败：${message.slice(0, 200)}`,
        pageUrl,
        results: runtime.rules.map((rule) => ({
          ruleId: rule.id,
          title: rule.title,
          role: rule.role,
          kind: rule.kind,
          status: "inconclusive",
          detail: message.slice(0, 240),
        })),
      });
      return;
    }

    const results = runtime.rules.map((rule) => {
      const hit = runtime.hits.get(rule.id);
      if (hit) {
        return {
          ruleId: rule.id,
          title: rule.title,
          role: rule.role,
          kind: rule.kind,
          status: "matched",
          detail: hit.detail,
        };
      }
      const inconclusiveDetail = checked.inconclusive.get(rule.id);
      if (inconclusiveDetail != null) {
        return {
          ruleId: rule.id,
          title: rule.title,
          role: rule.role,
          kind: rule.kind,
          status: "inconclusive",
          detail: inconclusiveDetail,
        };
      }
      if (checked.evaluated.has(rule.id)) {
        return {
          ruleId: rule.id,
          title: rule.title,
          role: rule.role,
          kind: rule.kind,
          status: "not_matched",
        };
      }
      let detail: string;
      if (rule.kind === "text" || !taskRuleIsMachineCheckable(rule)) {
        detail = "纯文字/提示类规则不做机器核对（试跑会跳过）";
      } else if (rule.kind === "vision" && !allowVision) {
        detail = "试跑未开启视觉判定（allowVision=false）";
      } else if (rule.kind === "vision") {
        detail = "视觉规则未执行（预算用尽或本轮检查点视觉上限）";
      } else {
        detail = "本条规则未参与本次试跑";
      }
      return {
        ruleId: rule.id,
        title: rule.title,
        role: rule.role,
        kind: rule.kind,
        status: "skipped",
        detail,
      };
    });

    emit({
      ok: true,
      reason: "",
      pageUrl,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("evaluate_task_rules_failed", { error: message });
    emit({
      ok: false,
      reason: `规则试跑失败：${message.slice(0, 200)}`,
      pageUrl: null,
      results: [],
    });
  } finally {
    clearTimeout(timer);
    clearActiveCommandWaitId(boundWaitId);
  }
}

async function handleTrajectoryList(payload: Record<string, unknown>): Promise<void> {
  const domain = String(payload.domain ?? "").trim();
  try {
    const items = await listPersistedTrajectories(domain || undefined);
    logger.result("trajectory_list", {
      count: items.length,
      items: items.map((item) => ({
        fileName: item.fileName,
        filePath: item.filePath,
        domain: item.domain,
        title: item.title,
        goal: item.goal,
        startUrl: item.startUrl,
        stepCount: item.stepCount,
        savedAt: item.savedAt,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("trajectory_list_failed", { error: message });
  }
}

/**
 * 「剪贴板视为人工提供」开关（§6.4）：默认 **false** —— 一次性凭证一律拒绝自动填入。
 * 只认显式 true；字符串 "true"/"1" 也认（外部 API / 命令行传参的常见形态）。
 */
function clipboardTreatAsHuman(payload: Record<string, unknown>): boolean {
  const raw = payload.clipboard ?? payload.clipboard_policy ?? payload.clipboardPolicy;
  const fromObject =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).treatAsHuman ??
        (raw as Record<string, unknown>).treat_as_human
      : undefined;
  const candidates = [fromObject, payload.clipboardTreatAsHuman, payload.clipboard_treat_as_human];
  return candidates.some(
    (value) => value === true || value === "true" || value === "1" || value === 1,
  );
}

/**
 * 剪贴板运行策略（§6.4 / §7.3.2）：`snapshot`（默认）| `per_run` | `off`。
 *
 * 只认显式 `off` —— 缺省、拼错、未知值一律按「没有关闭」处理（默认行为不变，零回归）。
 */
function clipboardMode(payload: Record<string, unknown>): "snapshot" | "per_run" | "off" {
  const raw = payload.clipboard ?? payload.clipboard_policy ?? payload.clipboardPolicy;
  const fromObject =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? String((raw as Record<string, unknown>).mode ?? "")
      : "";
  const value = fromObject.trim().toLowerCase();
  if (value === "off" || value === "per_run") return value;
  return "snapshot";
}

async function handleTrajectoryReplay(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  bindCommandWaitId(waitId);
  if (rejectIfEngineBusy("轨迹回放", "agent", waitId)) {
    return;
  }

  trajectoryReplayRunning = true;
  trajectoryReplayAbort = new AbortController();
  replayClipValues = {};
  const title = String(payload.title ?? "轨迹回放").trim() || "轨迹回放";
  const engineTag = { engine: "trajectory_replay" as const };
  let goal = String(payload.goal ?? "").trim();
  const profileId = String(payload.profileId ?? payload.profile_id ?? "").trim() ||
    (readAppEnv(ENV_PROFILE_ID) ?? "");

  /*
   * 回放里 `@人设名` / `@规则名`（与 Agent 输入框同口径）：
   *   - 人设：`taskPersona`（label + 固定字段）进规则运行时；`personaData`（整套字段）供 `{{persona.*}}` 插值；
   *   - 规则：进同一个规则运行时，机械步全部跑完后由 `guardUserConstraints` 硬校验
   *     （严格完成条件 / 必须点击 / 固定数据）；没满足就**不报成功**，并如实说明差在哪。
   * 没写 @ 时这两个载荷为空 → 完全保持原有行为。
   */
  const taskRulesRuntime = createTaskRulesRuntime({
    taskRules: payload.taskRules ?? payload.task_rules ?? null,
    taskPersona: payload.taskPersona ?? payload.task_persona ?? null,
    attachments: null,
  });
  // `{{persona.*}}` 插值用**整套字段**（不受「固定字段」勾选限制，与回放既有口径一致）。
  const replayPersonaTemplate = payload.personaData ?? payload.persona_data ?? null;

  try {
    let steps: TrajectoryStep[] = [];
    let replayHintsNote = "";
    const filePath = String(payload.filePath ?? payload.file_path ?? "").trim();
    if (filePath) {
      const loaded = await loadTrajectoryFromFile(filePath);
      steps = loaded.actions;
      if (!goal) {
        goal = String(loaded.goal ?? loaded.title ?? title).trim();
      }
      const hints = loaded.replayHints;
      if (hints?.needsHuman || hints?.nonMechanical) {
        replayHintsNote =
          ` · 难点：${(hints.reasons || []).join("/") || "需人工"}（不宜纯机械批量）`;
        logger.agentProgress(
          `本轨迹含非机械难点（${(hints.reasons || []).join("、") || "需人工"}）：验证码/OTP 等不会自动复现；定位失败时会尝试单步 AI 愈合后再交回机械`,
          { ...engineTag, phase: "replay_hints", replayHints: hints },
        );
      }
      logger.agentState("running", {
        ...engineTag,
        step: 0,
        msg: `开始回放「${loaded.title || title}」· ${steps.length} 步` +
          (trajectoryNeedsAiDelivery(goal) ? " · 完成后将 AI 交付" : "") +
          replayHintsNote,
      });
    } else {
      const rawActions = payload.actions;
      if (!Array.isArray(rawActions)) {
        throw new Error("缺少 filePath 或 actions");
      }
      const unpacked = unpackActionsWithReplayHints(rawActions);
      steps = unpacked.actions;
      if (unpacked.hints?.needsHuman || unpacked.hints?.nonMechanical) {
        replayHintsNote =
          ` · 难点：${(unpacked.hints.reasons || []).join("/") || "需人工"}`;
        logger.agentProgress(
          `本轨迹含非机械难点（${(unpacked.hints.reasons || []).join("、") || "需人工"}）：脱敏字段须有覆盖值，验证码不会自动复现`,
          { ...engineTag, phase: "replay_hints", replayHints: unpacked.hints },
        );
      }
      if (!goal) {
        goal = title;
      }
      logger.agentState("running", {
        ...engineTag,
        step: 0,
        msg: `开始回放「${title}」· ${steps.length} 步` +
          (trajectoryNeedsAiDelivery(goal) ? " · 完成后将 AI 交付" : "") +
          replayHintsNote,
      });
    }

    let page = resolveActivePage(browser);
    const proxyAuth = asProxyAuth(payload.proxyAuth);
    if (proxyAuth) {
      await installProxyAuthHandler(browser, proxyAuth);
    }

    // —— N4 / N8：回放默认在新标签里跑；每轮一个新标签（标签上限不静默）——
    const openInNewTab = bool(payload.openInNewTab ?? payload.open_in_new_tab, true);
    const closePreviousTab = bool(payload.closePreviousTab ?? payload.close_previous_tab, false);
    const round = Math.max(0, Math.floor(Number(payload.round ?? 0) || 0));
    const tabLimit = Math.max(1, Math.floor(Number(payload.tabLimit ?? payload.tab_limit) || REPLAY_TAB_LIMIT));
    if (openInNewTab) {
      const opened = await openReplayTab(page.context(), {
        closePrevious: closePreviousTab,
        limit: tabLimit,
        round,
        logger,
      });
      page = opened.page;
      bindActivePage(page);
      try {
        await page.bringToFront();
      } catch {
        /* 前台失败不阻断回放 */
      }
      logger.agentProgress(
        `第 ${round + 1} 轮：在新标签 ${opened.tabId} 中回放` +
          (closePreviousTab ? "（已关闭上一轮标签）" : ""),
        { ...engineTag, phase: "replay_new_tab", round, tabId: opened.tabId, closePreviousTab },
      );
    }

    const overridesRaw = payload.valueOverrides ?? payload.value_overrides;
    const valueOverrides = parseValueOverrides(overridesRaw);
    const fieldOverrides = parseFieldOverrides(overridesRaw);
    const aiSettings = payload.ai ? asAiSettings(payload.ai) : null;

    // §5.7 / §7.6：轮次身份 + 当前数据行 → {{run.*}} / {{data.*}} / {{clip.N}}
    const runIdentity = parseReplayRunIdentity(payload.runContext ?? payload.run_context, {
      round,
      runSeed: Number(payload.runSeed ?? payload.run_seed ?? 0) || null,
    });
    const dataRow = (() => {
      const direct = payload.dataRow ?? payload.data_row;
      if (direct && typeof direct === "object" && !Array.isArray(direct)) {
        return direct as Record<string, string>;
      }
      const fromContext = (payload.runContext ?? payload.run_context) as
        | Record<string, unknown>
        | undefined;
      const nested = fromContext?.data;
      return nested && typeof nested === "object" && !Array.isArray(nested)
        ? (nested as Record<string, string>)
        : null;
    })();
    const templateExtra = buildReplayTemplateExtra({
      run: runIdentity,
      data: dataRow,
      clip: replayClipValues,
    });

    // 本轮回放数据 →「数据目录」：数据集行 / 人设 / 实际填入值
    const personaFlat = (() => {
      if (!replayPersonaTemplate || typeof replayPersonaTemplate !== "object") {
        return {} as Record<string, string>;
      }
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(replayPersonaTemplate as Record<string, unknown>)) {
        if (value == null) continue;
        if (typeof value === "object") continue;
        const text = String(value).trim();
        if (text) out[key] = text;
      }
      return out;
    })();
    const dataFlat: Record<string, string> = {};
    if (dataRow) {
      for (const [key, value] of Object.entries(dataRow)) {
        const text = String(value ?? "").trim();
        if (text) dataFlat[key] = text;
      }
    }
    const fillDataLedger = createFillDataLedger({
      profileId: profileId || "unknown",
      runId: `replay-r${round + 1}-${runIdentity.uniqueId ?? Date.now()}`,
      logger,
      filePrefix: "replay-fill",
      meta: {
        kind: "replay",
        round: round + 1,
        goal: goal.slice(0, 500),
        dataRow: dataFlat,
        persona: personaFlat,
      },
    });

    /*
     * R1 · critical 闸门：回放里遇到支付/卡号/转账/删号/改密这类**不可逆**动作时，
     * 必须走介入中心人工确认 —— 预检单只是「提前告知」，**不能**用来预授权支付。
     * 复用 Agent 路径同一条收件箱（`agent_confirm_required` → InterventionCenter → `agent_confirm`）。
     */
    const requestCriticalConfirm: ReplayEngineOptions["requestCriticalConfirm"] = async (request) => {
      const requestId = randomUUID();
      logger.agentConfirmRequired({
        requestId,
        url: request.url,
        reason:
          `回放第 ${request.step} 步命中支付/不可逆动作：${request.label}` +
          `${request.matched ? `（命中「${request.matched}」）` : ""}。` +
          `确认后才会执行；不确认则本轮回放中止（R1：不存在无人支付路径）。`,
        actions: [{ kind: request.kind, id: String(request.step), text: request.label }],
        profileId,
        phase: "replay_critical_gate",
      });
      return new Promise((resolve) => {
        pendingConfirmResolvers.set(requestId, (value) => {
          resolve({ approved: value.approved, fillOverrides: value.fillOverrides });
        });
      });
    };

    const result = await replayTrajectoryOnPage(page, steps, {
      selectorTimeoutMs: 8_000,
      signal: trajectoryReplayAbort.signal,
      goal,
      requestCriticalConfirm,
      // N5 / N6：运行途中 `clipboard_read` 步（系统通道由宿主提供；内容只进内存变量）
      readClipboard: async (request) => {
        const response = await requestHostChannel(
          "clipboard_read",
          { scope: request.scope, origin: request.origin, timeoutMs: request.timeoutMs },
          profileId,
        );
        if (!response.ok) {
          return { ok: false, error: response.error ?? "宿主读取剪贴板失败" };
        }
        const text = String(response.data?.text ?? "");
        return { ok: true, text };
      },
      clipboard: {
        mode: clipboardMode(payload),
        treatAsHuman: clipboardTreatAsHuman(payload),
      },
      clipboardSink: replayClipValues,
      valueOverrides,
      fieldOverrides,
      onClickStep: async (info) => {
        // must_click 台账：判据与 Agent 侧同源（选择器元素级匹配 + 标签文本包含）。
        await noteTaskRuleClick(taskRulesRuntime, {
          step: info.step,
          label: info.label,
          matchesSelector: async (ruleSelector) => {
            const target = String(ruleSelector ?? "").trim();
            if (!target) return false;
            const used = String(info.selector ?? "").trim();
            if (used && used === target) return true;
            // 元素级兜底：规则选择器在当前页确实匹配到元素（回放用的是同一条录制选择器）
            try {
              const locator = page.locator(target).first();
              return (await locator.count()) > 0;
            } catch {
              return false;
            }
          },
        });
      },
      onFillStep: (info) => {
        fillDataLedger.record({
          label: info.label || info.selector,
          value: info.value,
          fieldType: info.fieldType,
          url: info.url,
          source: info.type === "select" ? "replay_select" : "replay_fill",
          step: info.step,
        });
      },
      resolveContext: {
        geo: payload.geoContext ?? payload.geo_context ?? null,
        persona: replayPersonaTemplate,
        aiSettings,
        templateExtra,
        logger,
      },
      aiHeal: (payload.replayAiHeal ?? payload.replay_ai_heal ?? {}) as {
        enabled?: boolean;
        maxPerRun?: number;
        allowDismissBlocker?: boolean;
      },
      onProgress: async (event) => {
        if (event.status === "start") {
          logger.agentProgress(
            `正在执行第 ${event.step} 步 [${event.type}] ${event.selector || ""}`.trim(),
            {
              ...engineTag,
              step: event.step,
              type: event.type,
              selector: event.selector,
            },
          );
        } else if (event.status === "ok") {
          const detail = event.message ? ` · ${event.message}` : "";
          logger.agentProgress(`回放第 ${event.step} 步完成 [${event.type}]${detail}`, {
            ...engineTag,
            step: event.step,
            type: event.type,
            message: event.message ?? null,
          });
          if (taskRulesRuntime) {
            const checked = await evaluateTaskRules(taskRulesRuntime, {
              page,
              aiSettings: (payload.ai ? asAiSettings(payload.ai) : null) ?? {
                apiKey: "",
                apiBaseUrl: "",
              },
              step: event.step,
              signal: trajectoryReplayAbort?.signal,
              allowVision: false,
            });
            for (const hit of checked.newlyHit) {
              logger.agentProgress(
                `回放命中规则「${hit.rule.title}」：${hit.detail}`.slice(0, 240),
                { ...engineTag, phase: "replay_rule_hit", step: event.step, ruleId: hit.rule.id },
              );
              if (hit.rule.role === "hitl" && shouldFireTaskRuleHitl(taskRulesRuntime, hit.rule.id)) {
                const approved = await requestCriticalConfirm({
                  step: event.step,
                  kind: "click",
                  label: `规则「${hit.rule.title}」要求确认：${hit.detail}`,
                  reason: hit.detail,
                  url: page.url(),
                  matched: hit.rule.title,
                });
                if (!approved.approved) {
                  throw new Error(`用户未确认规则「${hit.rule.title}」，回放已停`);
                }
              }
            }
          }
        } else if (event.status === "fail") {
          logger.agentState("failed", {
            ...engineTag,
            step: event.step,
            msg: `回放失败：第 ${event.step} 步 · ${event.message ?? ""}`,
          });
        }
      },
    });

    if (!result.ok) {
      const aborted = Boolean(trajectoryReplayAbort?.signal.aborted);
      if (aborted && !String(result.error ?? "").includes("回放已手动停止")) {
        logger.agentState("failed", {
          ...engineTag,
          step: result.failedStep ?? result.completedSteps,
          msg: "回放已手动停止",
        });
      }
      logger.result("trajectory_replay_done", {
        ok: false,
        completedSteps: result.completedSteps,
        failedStep: result.failedStep ?? null,
        error: result.error ?? "回放失败",
        aborted,
      });
      return;
    }

    // P2：支付收尾闸（目标要求付掉时，机械回放不得报成功冒充已付款）
    try {
      const { goalDemandsHumanPayment, loadCompletionLexicon } = await import(
        "./core/completion_evidence.js"
      );
      const demand = goalDemandsHumanPayment(goal, loadCompletionLexicon());
      if (demand) {
        const message =
          `回放机械步已走完，但目标含「${demand}」：回放不会自动完成支付（R1）。请人工支付后改用 Agent，或去掉「付掉/支付成功」类目标词。`;
        logger.agentState("failed", {
          ...engineTag,
          step: result.completedSteps,
          msg: message,
          phase: "replay_payment_credential_gate",
        });
        logger.result("trajectory_replay_done", {
          ok: false,
          completedSteps: result.completedSteps,
          error: message,
          aborted: false,
        });
        return;
      }
    } catch (gateErr) {
      logger.warn("replay_payment_credential_gate_failed", {
        error: gateErr instanceof Error ? gateErr.message : String(gateErr),
      });
    }

    // 人机验证收尾闸：步数跑完但页面仍停在「證明您是人類 / 長按」等，禁止报成功
    try {
      const { probeBlockingCaptchaOnPage } = await import("./bu_agent/captcha_dispatch.js");
      const captchaBlock = await probeBlockingCaptchaOnPage(page);
      if (captchaBlock.blocked) {
        const message =
          captchaBlock.reason ||
          "回放机械步已走完，但页面仍停在人机验证，禁止报成功";
        logger.agentState("failed", {
          ...engineTag,
          step: result.completedSteps,
          msg: message,
          phase: "replay_captcha_gate",
          captchaStrategy: captchaBlock.strategy,
          captchaMatched: captchaBlock.matched,
        });
        logger.result("trajectory_replay_done", {
          ok: false,
          completedSteps: result.completedSteps,
          error: message,
          aborted: false,
        });
        return;
      }
    } catch (gateErr) {
      // 探测本身失败 → fail-closed（读不到就不敢声称已过码）
      const detail = gateErr instanceof Error ? gateErr.message : String(gateErr);
      const message = `回放收尾无法确认是否已过验证码（${detail}）：禁止报成功，请人工核对页面`;
      logger.agentState("failed", {
        ...engineTag,
        step: result.completedSteps,
        msg: message,
        phase: "replay_captcha_gate",
      });
      logger.result("trajectory_replay_done", {
        ok: false,
        completedSteps: result.completedSteps,
        error: message,
        aborted: false,
      });
      return;
    }

    /*
     * `@规则名` 的硬闸（与 Agent 的 done 闸门同一份判定）：
     * 机械步全部跑完，先核对「严格完成条件 / 必须点击 / 固定数据」，没满足就**不报成功**。
     * 判定不确定（视觉额度/模型不可用）同样 fail-closed —— 绝不谎报「界面没出现」。
     *
     * C2：有界 AI heal 只修定位/文案，不得绕过规则闸。heal 步虽会 onProgress(ok) 逐步巡检，
     * 若本 run 用过 heal，收尾前再强制 evaluate 一次，与 guardUserConstraints 同一套运行时。
     */
    if (taskRulesRuntime) {
      if (result.aiHealUsed) {
        await evaluateTaskRules(taskRulesRuntime, {
          page,
          aiSettings: (payload.ai ? asAiSettings(payload.ai) : null) ?? {
            apiKey: "",
            apiBaseUrl: "",
          },
          step: result.completedSteps,
          signal: trajectoryReplayAbort.signal,
          allowVision: true,
        });
      }
      const constraint = await guardUserConstraints(taskRulesRuntime, {
        page,
        aiSettings: (payload.ai ? asAiSettings(payload.ai) : null) ?? {
          apiKey: "",
          apiBaseUrl: "",
        },
        step: result.completedSteps,
        signal: trajectoryReplayAbort.signal,
        allowVision: true,
      });
      if (constraint) {
        const message =
          `回放机械步已走完，但用户规则未满足：${constraint.reason}`;
        logger.agentState("failed", {
          ...engineTag,
          step: result.completedSteps,
          msg: message,
          phase: "replay_rule_gate",
          ruleIds: constraint.ruleIds,
        });
        logger.result("trajectory_replay_done", {
          ok: false,
          completedSteps: result.completedSteps,
          error: message,
          ruleIds: constraint.ruleIds,
          inconclusiveRuleIds: constraint.inconclusiveRuleIds,
          aborted: false,
        });
        return;
      }
    }

    // 混合回放：机械步成功后，若目标需分析/汇报 → 单次 LLM 交付（对齐 Agent 效果）
    let deliverSummary = "";
    let delivered = false;
    if (trajectoryNeedsAiDelivery(goal) && !trajectoryReplayAbort.signal.aborted) {
      try {
        logger.agentProgress("回放机械步完成，开始 AI 交付分析…", {
          ...engineTag,
          step: result.completedSteps,
        });
        const aiSettings = payload.ai ? asAiSettings(payload.ai) : null;
        const deliver = await deliverAfterTrajectoryReplay(
          page,
          goal,
          aiSettings,
          logger,
          trajectoryReplayAbort.signal,
          // `@规则名` 的提醒 / 人工介入时机等进交付提示词（只影响交付，不改变是否交付）
          buildTaskRulesBrief(taskRulesRuntime),
        );
        delivered = deliver.delivered;
        deliverSummary = deliver.summary;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (trajectoryReplayAbort.signal.aborted || message.includes("回放已手动停止")) {
          logger.agentState("failed", {
            ...engineTag,
            step: result.completedSteps,
            msg: "回放已手动停止",
          });
          logger.result("trajectory_replay_done", {
            ok: false,
            completedSteps: result.completedSteps,
            aborted: true,
            error: "回放已手动停止",
          });
          return;
        }
        logger.warn("replay_deliver_failed", { error: message });
        deliverSummary = `机械回放成功，但 AI 交付失败：${message}`;
      }
    }

    const completeMsg = delivered
      ? deliverSummary
      : deliverSummary
        ? `回放成功 · 共 ${result.completedSteps} 步\n${deliverSummary}`
        : `回放成功 · 共 ${result.completedSteps} 步`;

    logger.agentState("complete", {
      ...engineTag,
      step: result.completedSteps,
      msg: completeMsg,
    });
    logger.result("trajectory_replay_done", {
      ok: true,
      completedSteps: result.completedSteps,
      delivered,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("trajectory_replay_failed", { error: message });
    logger.agentState("failed", {
      ...engineTag,
      step: 0,
      msg: `回放失败：${message}`,
    });
  } finally {
    trajectoryReplayRunning = false;
    trajectoryReplayAbort = null;
    replayClipValues = {};
  }
}

async function handleTrajectoryDelete(payload: Record<string, unknown>): Promise<void> {
  const filePath = String(payload.filePath ?? payload.file_path ?? "").trim();
  if (!filePath) {
    logger.error("trajectory_delete_failed", { error: "缺少 filePath" });
    return;
  }
  try {
    await deletePersistedTrajectory(filePath);
    logger.result("trajectory_deleted", { filePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("trajectory_delete_failed", { error: message });
  }
}

function handleAgentImmediateCommand(payload: Record<string, unknown>): boolean {
  const command = String(payload.command ?? "");

  if (command === "agent_confirm") {
    const requestId = String(payload.requestId ?? "").trim();
    const fillOverrides =
      typeof payload.fillOverrides === "object" && payload.fillOverrides !== null
        ? Object.fromEntries(
            Object.entries(payload.fillOverrides as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value ?? ""),
            ]),
          )
        : undefined;
    if (!resolvePendingConfirm(requestId, true, fillOverrides)) {
      logger.warn("agent_confirm_no_pending", { requestId });
    }
    return true;
  }

  if (command === "agent_cancel") {
    const requestId = String(payload.requestId ?? "").trim();
    if (requestId) {
      resolvePendingConfirm(requestId, false);
    } else {
      rejectAllAgentPendings("用户取消");
    }
    return true;
  }

  if (command === "agent_user_reply") {
    const requestId = String(payload.requestId ?? "").trim();
    const answer = String(payload.answer ?? payload.reply ?? "").trim();
    if (!resolvePendingAsk(requestId, answer || "（用户未填写）")) {
      logger.warn("agent_user_reply_no_pending", { requestId });
    }
    return true;
  }

  if (command === "agent_handover_continue") {
    const requestId = String(payload.requestId ?? "").trim();
    if (requestId) {
      if (!resolvePendingHandover(requestId)) {
        logger.warn("agent_handover_continue_no_pending", { requestId });
      }
    } else {
      // 无 requestId：恢复全部挂起锁
      resumePause(null);
    }
    return true;
  }

  if (command === "agent_host_response") {
    const requestId = String(payload.requestId ?? "").trim();
    const ok = payload.ok === true;
    const data =
      typeof payload.data === "object" && payload.data !== null
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const error = String(payload.error ?? "").trim() || undefined;
    if (!resolvePendingHostRequest(requestId, { ok, data, error })) {
      logger.warn("agent_host_response_no_pending", { requestId });
    }
    return true;
  }

  // P4.5：用户暂停（软闸）— 主循环在 multi_act 前 drainUserPauseGate
  if (command === "agent_pause") {
    if (!agentRunning) {
      logger.warn("agent_pause_ignored", { reason: "agent_not_running" });
      return true;
    }
    requestUserPause();
    logger.status("agent_pause_requested", { profileId: String(payload.profileId ?? "") });
    return true;
  }

  if (command === "agent_success") {
    if (!agentRunning) {
      logger.warn("agent_success_ignored", { reason: "agent_not_running" });
      return true;
    }
    requestUserSuccess();
    // 解开暂停与挂起的 HITL，让主循环尽快读到成功闸
    clearUserPauseRequest();
    resumePause(userPauseLockId(String(payload.profileId ?? "")));
    resumePause(null);
    for (const [id, resolver] of pendingConfirmResolvers) {
      pendingConfirmResolvers.delete(id);
      resolver({ approved: false });
    }
    for (const [id, resolver] of pendingAskResolvers) {
      pendingAskResolvers.delete(id);
      resolver("（用户已标记成功）");
    }
    logger.agentProgress("已请求标记成功 · 当前步结束后收尾并写入轨迹（若已勾选录制）", {
      phase: "user_success",
      profileId: String(payload.profileId ?? ""),
    });
    logger.status("agent_success_requested", { profileId: String(payload.profileId ?? "") });
    return true;
  }

  if (command === "agent_abort" || command === "trajectory_abort") {
    rejectAllAgentPendings("用户中止 Agent");
    if (agentAbortController && !agentAbortController.signal.aborted) {
      agentAbortController.abort("agent_abort");
    }
    if (trajectoryReplayAbort && !trajectoryReplayAbort.signal.aborted) {
      // 仅打断回放循环；终态由 handleTrajectoryReplay 统一推送
      trajectoryReplayAbort.abort("trajectory_abort");
    } else if (command === "agent_abort") {
      logger.agentState("failed", { step: 0, msg: "用户中止 Agent" });
    }
    return true;
  }

  return false;
}

/** Milestone 4：CDP/Playwright 将当前页唤到前台，方便用户处理验证码 */
async function handleBringToFront(browser: Browser): Promise<void> {
  try {
    const page = await resolveActivePageFromBrowser(browser);
    await page.bringToFront();
    // 双保险：经 CDP Session 再发 Page.bringToFront
    try {
      const session = await page.context().newCDPSession(page);
      await session.send("Page.bringToFront").catch(() => undefined);
      await session.detach().catch(() => undefined);
    } catch {
      // Playwright bringToFront 已足够；CDP 失败可忽略
    }
    logger.result("agent_bring_to_front", { ok: true, url: page.url() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("agent_bring_to_front_failed", { error: message });
  }
}

function asFillProfile(value: unknown): FillProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fill profile must be a JSON object");
  }

  const profile: FillProfile = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }
    profile[key] = String(entry);
  }
  return profile;
}

function buildOtpSecretResolver(
  payload: Record<string, unknown>,
): ((ref: string) => string | null) | undefined {
  const raw = payload.otpSecrets ?? payload.otp_secrets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(key ?? "").trim();
    const plain = String(value ?? "").trim();
    if (id && plain) map.set(id, plain);
  }
  if (map.size === 0) return undefined;
  return (ref: string) => {
    const id = String(ref ?? "").trim();
    return id ? map.get(id) ?? null : null;
  };
}

/** P5.1：与 OTP 同模式 — Host 会话注入 captchaSecrets，禁止落盘 */
function buildCaptchaSecretResolver(
  payload: Record<string, unknown>,
): ((ref: string) => string | null) | undefined {
  const raw = payload.captchaSecrets ?? payload.captcha_secrets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(key ?? "").trim();
    const plain = String(value ?? "").trim();
    if (id && plain) map.set(id, plain);
  }
  if (map.size === 0) return undefined;
  return (ref: string) => {
    const id = String(ref ?? "").trim();
    return id ? map.get(id) ?? null : null;
  };
}

/** P5.3：短信接码密钥 — Host 会话注入 smsOtpSecrets，禁止落盘 */
function buildSmsOtpSecretResolver(
  payload: Record<string, unknown>,
): ((ref: string) => string | null) | undefined {
  const raw = payload.smsOtpSecrets ?? payload.sms_otp_secrets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(key ?? "").trim();
    const plain = String(value ?? "").trim();
    if (id && plain) map.set(id, plain);
  }
  if (map.size === 0) return undefined;
  return (ref: string) => {
    const id = String(ref ?? "").trim();
    return id ? map.get(id) ?? null : null;
  };
}

function asAiSettings(value: unknown): SidecarAiSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fill command requires ai settings object from Rust host");
  }
  const record = value as Record<string, unknown>;
  const apiKey = String(record.apiKey ?? record.api_key ?? "").trim();
  const apiBaseUrl = String(record.apiBaseUrl ?? record.api_base_url ?? "").trim();
  if (!apiKey) {
    throw new Error("fill command ai.apiKey is required");
  }
  if (!apiBaseUrl) {
    throw new Error("fill command ai.apiBaseUrl is required");
  }
  return {
    apiKey,
    apiBaseUrl,
    textModel: record.textModel
      ? String(record.textModel)
      : record.agentModel
        ? String(record.agentModel)
        : undefined,
    chatModel: record.chatModel ? String(record.chatModel) : undefined,
    agentModel: record.agentModel
      ? String(record.agentModel)
      : record.textModel
        ? String(record.textModel)
        : undefined,
    visionModel: record.visionModel ? String(record.visionModel) : undefined,
    agentModelDisableThinking: record.agentModelDisableThinking === true,
  };
}

async function main(): Promise<void> {
  const abortController = new AbortController();
  let browser: Browser | null = null;
  let shuttingDown = false;
  /**
   * 浏览器就绪闸门。
   *
   * `ensure_session` 只做固定等待（1500ms）便下发命令，而 CDP 连接最长可等 30s，
   * 因此命令**必然**会早于连接到达。此前 `if (!browser) return;` 把它们静默丢弃，
   * 父进程只能白等到 60s/600s 超时。现在改为等待就绪后继续处理。
   */
  let markBrowserReady: () => void = () => {};
  const browserReady = new Promise<void>((resolve) => {
    markBrowserReady = resolve;
  });

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.status("shutting_down", { reason });
    stopPauseHttpServer();
    await disconnectBrowser(browser);
    logger.result("sidecar_stopped", { reason, exitCode });
    process.exit(exitCode);
  };

  attachStdinAbortListener(abortController, () => {
    void shutdown("abort_signal");
  }, async (payload) => {
    if (!browser) {
      // 连接未就绪：等闸门放行，绝不丢弃命令（丢弃会让发起方干等到超时）
      await browserReady;
    }
    if (!browser) {
      // 连接失败时上层会直接退出进程；这里仅兜底并留痕，不再静默
      logger.warn("command_dropped_browser_unavailable", {
        command: String(payload.command ?? ""),
      });
      return;
    }

    if (handleAgentImmediateCommand(payload)) {
      return;
    }

    const command = String(payload.command ?? "");
    const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
    // 长任务命令绑定 waitId，终态回传给 Rust 精确唤醒
    if (
      command === "agent_start" ||
      command === "rpa_start" ||
      command === "chat_start" ||
      command === "trajectory_replay" ||
      command === "fill" ||
      command === "smart_element_fill" ||
      command === "external_fill"
    ) {
      bindCommandWaitId(waitId);
    }

    if (command === "agent_bring_to_front") {
      // 仅 Intervention「去处理」经 Rust 下发；自动化循环禁止主动抢焦点
      await handleBringToFront(browser);
      return;
    }

    if (command === "agent_start") {
      try {
        await handleAgentStart(browser, payload, waitId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("agent_start_failed", { error: message });
      }
      return;
    }

    if (command === "chat_start") {
      try {
        await handleChatStart(browser, payload, waitId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("chat_start_failed", { error: message });
        logger.chatProgress(`聊天模式启动失败：${message.slice(0, 200)}`, {
          type: "chat_state",
          phase: "stopped",
          stopReason: "start_failed",
          // 必须带 waitId：否则宿主的 waiter 等不到终态行，只能干等 300s 超时（§0.5.3 E）
          ...(waitId ? { waitId } : {}),
        });
      }
      return;
    }

    if (command === "chat_stop") {
      await handleChatStop(browser, payload);
      return;
    }

    if (command === "chat_list_contacts") {
      try {
        await handleChatListContacts(browser, payload, waitId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("chat_list_contacts_failed", { error: message });
      }
      return;
    }

    if (command === "evaluate_task_rules") {
      try {
        await handleEvaluateTaskRules(browser, payload, waitId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("evaluate_task_rules_failed", { error: message });
      }
      return;
    }

    if (command === "chat_learn_site") {
      try {
        await handleChatLearnSite(browser, payload, waitId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("chat_learn_site_failed", { error: message });
        // 终态必须带 waitId，否则宿主的 waiter 只能干等超时（§0.5.3 E）
        logger.chatProgress(`站点学习启动失败：${message.slice(0, 200)}`, {
          type: "chat_learn_done",
          ok: false,
          outcome: "failed",
          phase: "stopped",
          stopReason: "start_failed",
          ...(waitId ? { waitId } : {}),
        });
        clearActiveCommandWaitId(waitId);
      }
      return;
    }

    if (command === "trajectory_list") {
      await handleTrajectoryList(payload);
      return;
    }

    if (command === "trajectory_replay") {
      await handleTrajectoryReplay(browser, payload);
      return;
    }

    if (command === "trajectory_delete") {
      await handleTrajectoryDelete(payload);
      return;
    }

    if (command === "preview_hybrid") {
      const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
      try {
        if (rejectIfEngineBusy("混合填表预览", "rpa", waitId)) {
          throw new Error(
            formatEngineBusyMessage(engineBusySnapshot(), "混合填表预览") || ENGINE_BUSY_MESSAGE,
          );
        }
        rpaRunning = true;
        try {
          const page = resolveActivePage(browser);
          const aiSettings = asAiSettings(payload.ai);
          const proxyAuth = asProxyAuth(payload.proxyAuth);
          if (proxyAuth) {
            await installProxyAuthHandler(browser, proxyAuth);
          }

          const rawInput = String(payload.rawInput ?? payload.raw_input ?? "").trim();
          const partialProfile = asFillProfile(payload.profile);
          const partialHint =
            rawInput ||
            Object.entries(partialProfile)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n");

          logger.progress("preview_hybrid_start", {
            partialInputLength: partialHint.length,
          });

          const profile = await generateHybridFillProfile(
            page,
            partialHint,
            aiSettings,
            logger,
            resolveUserDataDir(payload),
          );
          process.stdout.write(`${JSON.stringify({ type: "hybrid_preview", profile })}\n`);
          logger.result("hybrid_preview_ready", { keyCount: Object.keys(profile).length });
        } finally {
          rpaRunning = false;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("preview_hybrid_failed", { error: message });
      }
      return;
    }

    if (command === "rpa_start") {
      await handleRpaStart(browser, payload);
      return;
    }

    if (command === "rpa_resume") {
      await handleRpaResume(browser);
      return;
    }

    if (command === "rpa_rescan") {
      await handleRpaRescan(browser, payload);
      return;
    }

    if (command === "rpa_pause") {
      await handleRpaPause();
      return;
    }

    if (command === "get_url") {
      await handleGetUrl(browser);
      return;
    }

    if (command === "smart_element_fill") {
      try {
        await handleSmartElementFill(browser, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("smart_element_fill_failed", { error: message });
      }
      return;
    }

    if (command === "fill") {
      try {
        await handleLegacyFill(browser, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("fill_command_failed", { error: message });
      }
      return;
    }

    if (command === "external_fill") {
      try {
        await handleExternalFill(browser, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("external_fill_failed", { error: message });
      }
      return;
    }
  });

  process.on("SIGINT", () => {
    if (!abortController.signal.aborted) {
      abortController.abort("sigint");
    }
  });

  process.on("SIGTERM", () => {
    if (!abortController.signal.aborted) {
      abortController.abort("sigterm");
    }
  });

  const cdpUrl = parseCdpUrl(process.argv.slice(2));
  logger.status("sidecar_starting", { cdpUrl });

  // Milestone 4：真·挂起 Resume HTTP（127.0.0.1 随机端口），供 Rust 直连唤醒
  try {
    const pausePort = await startPauseHttpServer();
    process.stdout.write(
      `${JSON.stringify({
        type: "pause_server",
        port: pausePort,
        ts: new Date().toISOString(),
      })}\n`,
    );
    logger.status("pause_server_ready", { port: pausePort });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("pause_server_failed", { error: message });
  }

  try {
    logger.progress("connecting_cdp", { cdpUrl });
    browser = await chromium.connectOverCDP(cdpUrl, {
      timeout: 30_000,
    });
    // 放行在连接期间到达的命令（见 browserReady 注释）
    markBrowserReady();
    bindAgentCdpUrl(cdpUrl);
    const watchDisconnect = (target: Browser): void => {
      target.on("disconnected", () => {
        if (isBrowserRestartArmed()) {
          logger.status("browser_restart_disconnect_ignored", { cdpUrl });
          return;
        }
        logger.status("browser_disconnected", { cdpUrl });
        void shutdown("browser_disconnected");
      });
    };
    watchDisconnect(browser);
    onAgentBrowserReplaced((next) => {
      browser = next;
      watchDisconnect(next);
    });
    // 内核 humanize 是启动进程内的 JS 补丁，不随 CDP 传播；不补则 Agent 的
    // page.mouse.move 退化为瞬移（滑块「没动就过」，无仿生轨迹）。
    const humanized = await humanizeConnectedBrowser(browser);
    logger.status("cdp_humanize", { cdpUrl, humanized });
    if (!humanized) {
      logger.warn("cdp_humanize_failed", {
        cdpUrl,
        impact: "鼠标轨迹退化为瞬移，拟人交互与滑块拖拽会明显失真",
      });
    }

    const contexts = browser.contexts();
    logger.status("cdp_connected", {
      cdpUrl,
      contextCount: contexts.length,
      browserConnected: browser.isConnected(),
    });

    // 下载接管：connectOverCDP 会用自己的临时 artifactsDir 覆盖整浏览器的下载行为，
    // 因此用户手动点击/另存的下载事件实际落在本进程。逐页挂 download 监听并 saveAs 到
    // 常规浏览器下载目录，避免临时包被清理导致「文件找不到」。
    const downloadProfileId = readAppEnv(ENV_PROFILE_ID) ?? "unknown";
    configureDownloadRoots({
      browserDownloadDir: readAppEnv(ENV_BROWSER_DOWNLOAD_DIR) ?? null,
      scraperDownloadDir: readAppEnv(ENV_SCRAPER_DOWNLOAD_DIR) ?? null,
    });
    const resolveBrowserDownloadDir = (): string =>
      getResolvedDownloadPath("browser", downloadProfileId);
    installDownloadAutoSaveOnBrowser(
      browser,
      logger,
      downloadProfileId,
      resolveBrowserDownloadDir,
    );
    // 纠正 connectOverCDP 抢走的落盘目录（allowAndName + 临时 artifactsDir → allow + 用户目录）。
    const appliedDownloadDir = await applyBrowserDownloadDir(
      browser,
      resolveBrowserDownloadDir,
      logger,
      downloadProfileId,
    );
    logger.status("download_takeover_installed", {
      profileId: downloadProfileId,
      downloadsDir: appliedDownloadDir ?? resolveBrowserDownloadDir(),
      contextCount: browser.contexts().length,
    });

    await attachBrowserUrlWatchers(browser, logger);

    logger.progress("awaiting_commands", {
      hint: 'send {"command":"rpa_start"|fill|rpa_resume|rpa_rescan|get_url|abort}',
    });

    await new Promise<void>((resolve) => {
      if (abortController.signal.aborted) {
        resolve();
        return;
      }
      abortController.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    await shutdown("abort_signal");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("sidecar_failed", { error: message, cdpUrl });
    await disconnectBrowser(browser);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("unhandled_sidecar_error", { error: message });
  process.exit(1);
});
