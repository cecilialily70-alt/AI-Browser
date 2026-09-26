/**
 * 特征感知回放引擎 — 无 LLM，按 TrajectoryStep[] 在 Playwright Page 上顺序执行
 *
 * - 防遮挡：click 使用 force + 短超时，避免被下拉/弹层卡死 60s
 * - 特征屏障：带 postCondition 的步先断言 URL，再 networkidle + 人类停顿；旧轨迹无特征则降级
 *
 * 注意：默认不写 console（Sidecar 仅允许 JSON stdout）；诊断脚本可设 verboseConsole。
 * 数据覆盖：可选 valueOverrides / fieldOverrides 按 selector 运行时覆盖 fill/select 值，不改轨迹 JSON。
 * 延迟生成：fieldOverrides.mode=ai_prompt 时在填表前一秒 JIT 调用 fast_text。
 */
import type { Page } from "playwright-core";

import { resolveCoordToViewportPixels } from "./core/action_gateway.js";
import { safeGoto, softSettleAfterNavigation } from "./cdp_session.js";
import {
  lookupFieldOverride,
  resolveFieldOverrideValue,
  type FieldOverrideSpec,
  type ResolveOverrideContext,
} from "./deferred_generation.js";
import { isTempIdSelector, type TrajectoryActionType, type TrajectoryPostCondition, type TrajectoryStep } from "./trajectory.js";
import { decideHitlConfirm } from "./core/hitl_policy.js";
import { describeClipboardForLog, gateClipboardValue } from "./core/clipboard_gate.js";
import { JsonLogger } from "./json-logger.js";

const logger = new JsonLogger();

/** 单步选择器等待上限（避免 Playwright 反复重试拖成数分钟） */
const DEFAULT_SELECTOR_TIMEOUT_MS = 8_000;
/** 点击强点：3s 内穿透遮罩，禁止 60s 死等 */
const CLICK_TIMEOUT_MS = 3_000;
const FILL_TIMEOUT_MS = 6_000;
const POST_URL_TIMEOUT_MS = 5_000;
const NETWORK_IDLE_TIMEOUT_MS = 3_000;
const HUMAN_SETTLE_MS = 1_500;
/** 回放全部完成后 → AI 交接前的防抢跑屏障 */
const HANDOFF_NETWORK_IDLE_MS = 8_000;
const HANDOFF_DOM_STABLE_TIMEOUT_MS = 8_000;
const HANDOFF_DOM_POLL_MS = 400;
const HANDOFF_HUMAN_BUFFER_MS = 2_500;
const HANDOFF_MIN_BODY_CHARS = 60;

const SEARCH_INPUT_FALLBACKS = [
  "#kw",
  'input[name="wd"]',
  "#chat-textarea",
  'input[type="search"]',
];

const SEARCH_SUBMIT_SELECTORS = new Set([
  "#su",
  "#chat-submit-button",
  'input[type="submit"]',
  'button[type="submit"]',
]);

export interface ReplayEngineOptions {
  selectorTimeoutMs?: number;
  stepPauseMs?: number;
  verboseConsole?: boolean;
  /** @deprecated 旧版 string 覆盖；优先使用 fieldOverrides */
  valueOverrides?: Record<string, string>;
  /** 结构化覆盖：fixed（含 {{变量}}）/ ai_prompt（JIT） */
  fieldOverrides?: Record<string, FieldOverrideSpec>;
  /** JIT / 变量插值上下文 */
  resolveContext?: ResolveOverrideContext;
  /** 用户中止回放 */
  signal?: AbortSignal;
  onProgress?: (event: ReplayProgressEvent) => void;
  /**
   * critical 步骤的人工确认闸门（R1）。
   * 未提供时**一律拒绝执行 critical 步骤**（fail-closed）—— 回放绝不是绕过支付闸门的旁路。
   */
  requestCriticalConfirm?: (request: {
    step: number;
    kind: "click" | "fill" | "select";
    label: string;
    reason: string;
    matched: string | null;
    url: string;
  }) => Promise<{ approved: boolean; fillOverrides?: Record<string, string> }>;
  /**
   * N5 / N6：运行途中读取剪贴板（`clipboard_read` 步）。
   *
   * `scope=system` 时**只能由宿主读**（Host 唯一入口，§6.2）；未提供通道即如实报错，禁止编造内容。
   */
  readClipboard?: (request: {
    scope: "page" | "system";
    origin: string;
    timeoutMs: number;
  }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /**
   * 剪贴板策略：
   * - `treatAsHuman` = 用户显式勾选「剪贴板视为人工提供」（一次性凭证的放行条件）；
   * - `mode = "off"` = 调用方（设置 / 外部 API）整条关闭剪贴板读取 → `clipboard_read` 直接报错停。
   */
  clipboard?: { mode?: "snapshot" | "per_run" | "off"; treatAsHuman?: boolean };
  /**
   * 剪贴板变量落点（`{{clip.N}}` / `{{clip.<into>}}`）。
   * 由调用方持有：内容**绝不落盘**（§6.4），回放结束即清空。
   */
  clipboardSink?: Record<string, string>;
  /**
   * 点击步骤成功后的回调（用户规则 `must_click` 的点击台账）。
   * 台账失败**不阻断回放**：判定缺失时由收尾硬闸 fail-closed，而不是让回放半路崩。
   */
  onClickStep?: (info: { step: number; selector: string; label: string }) => Promise<void> | void;
  /** 轨迹目标（仅用于日志/文案；critical 永不因目标覆盖豁免） */
  goal?: string;
}

export interface ReplayProgressEvent {
  step: number;
  type: string;
  selector: string;
  status: "start" | "ok" | "fail";
  message?: string;
}

export interface ReplayEngineResult {
  ok: boolean;
  completedSteps: number;
  failedStep?: number;
  error?: string;
}

type LooseStep = TrajectoryStep & {
  action?: string;
  postCondition?: TrajectoryPostCondition;
  text?: string;
  /** `clipboard_read` 的键同时支持 camelCase 与 snake_case（外部 API / 手写轨迹两种写法） */
  timeout_ms?: number;
};

/** 页面剪贴板读取（Chromium）：必须**带 origin** 授权，避免把权限发给意外打开的第三方页 */
async function readPageClipboardText(
  page: Page,
  origin: string,
  timeoutMs: number,
): Promise<string> {
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  return Promise.race([
    page.evaluate(() => navigator.clipboard.readText()),
    new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`页面剪贴板读取超时（${timeoutMs}ms）`)), timeoutMs);
    }),
  ]);
}

/** 当前页面的 origin（授权只发给它自己；拿不到就是拿不到，不猜） */
function originOf(page: Page): string {
  try {
    return new URL(page.url()).origin;
  } catch {
    return "";
  }
}

function resolveStepType(step: LooseStep): TrajectoryActionType | string {
  return (step.type || step.action || "").toLowerCase();
}

/** HITL 判定用的交互种类；非交互类型返回 null */
function hitlKindOf(type: string): "click" | "fill" | "select" | null {
  if (type === "fill") return "fill";
  if (type === "select") return "select";
  if (type === "click" || type === "click_point") return "click";
  return null;
}

/** 与 Agent 路径同一口径的可引用文案（semanticLabel > label > text > selector） */
function stepHitlLabel(step: LooseStep, selector: string): string {
  return String(step.semanticLabel ?? step.label ?? step.text ?? selector ?? "").trim().slice(0, 60);
}

/**
 * R1 · 支付/不可逆动作的 critical 闸门。
 *
 * 为什么只拦 critical、不拦 sensitive：回放的是**用户自己录下来的动作**，
 * 「注册/提交/邮箱密码」这类 sensitive 步骤等于用户已经表达过意图，逐步弹框只会造成确认疲劳
 * 并把回放体验毁掉；而支付/卡号/转账/删号/改密这类**不可逆**动作，产品红线要求
 * **任何情况下都确认**（词典的 critical 分支不因目标覆盖豁免）。
 *
 * fail-closed：没有确认通道时**不执行**该步（宁可停下来，也不许无人支付）。
 * 返回 null = 放行；返回 ReplayEngineResult = 该步被拦下（整个回放以失败结束，不冒充成功）。
 */
async function gateCriticalStep(input: {
  options?: ReplayEngineOptions;
  step: LooseStep;
  selector: string;
  type: string;
  stepNo: number;
  page: Page;
  /** 人工现场给的值写这里（selector → value），供 fill/select 优先取用 */
  humanProvidedValues: Map<string, string>;
}): Promise<ReplayEngineResult | null> {
  const kind = hitlKindOf(input.type);
  if (!kind) return null;
  const label = stepHitlLabel(input.step, input.selector);
  if (!label) return null;

  const decision = decideHitlConfirm({
    kind,
    label,
    value: kind === "click" ? undefined : String(input.step.value ?? ""),
    goal: input.options?.goal ?? "",
  });
  if (decision.level !== "critical") {
    if (decision.level === "sensitive") {
      logger.debug(
        `replay_hitl_sensitive_allow: step ${input.stepNo} ${label}（回放的是用户录制的动作，视为已授权）`,
      );
    }
    return null;
  }

  const request = input.options?.requestCriticalConfirm;
  if (!request) {
    return {
      ok: false,
      completedSteps: 0,
      failedStep: input.stepNo,
      error:
        `第 ${input.stepNo} 步命中支付/不可逆动作（${decision.reason}），但当前没有可用的确认通道，` +
        `已按红线拒绝执行（R1：不存在无人支付路径）。`,
    };
  }

  const decisionResult = await request({
    step: input.stepNo,
    kind,
    label,
    reason: decision.reason,
    matched: decision.matched,
    url: input.page.url() || "",
  });
  if (!decisionResult.approved) {
    return {
      ok: false,
      completedSteps: 0,
      failedStep: input.stepNo,
      error:
        kind === "click"
          ? `第 ${input.stepNo} 步「${label}」被人工拒绝执行：支付/不可逆动作未获确认（R1），回放中止。`
          : `第 ${input.stepNo} 步向「${label}」写入被人工拒绝：critical 字段永不自动填（R1），回放中止。`,
    };
  }
  // 人工在确认框里现场给了值（例如卡号以外的 critical 字段）→ 以人工值为准，覆盖轨迹/数据集
  const provided = decisionResult.fillOverrides?.[input.selector];
  if (typeof provided === "string" && provided.length > 0) {
    input.humanProvidedValues.set(input.selector, provided);
  }
  return null;
}

function makeConsole(verbose: boolean) {
  return {
    ok: (message: string) => {
      if (verbose) {
        logger.debug(`replay_ok: ${message}`);
      }
    },
    fail: (message: string) => {
      if (verbose) {
        logger.debug(`replay_fail: ${message}`);
      }
    },
    dim: (message: string) => {
      if (verbose) {
        logger.debug(`replay_detail: ${message}`);
      }
    },
  };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("回放已手动停止");
  }
}

/** 让 Stop 能打断正在进行的 Playwright 等待 */
function withAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) {
    return promise;
  }
  assertNotAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("回放已手动停止"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** 去掉 Playwright Call log 里的 ANSI，避免前端刷屏 */
export function stripAnsi(text: string): string {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
}

export function toPlaywrightSelector(selector: string): string {
  const trimmed = String(selector ?? "").trim();
  if (!trimmed) {
    return trimmed;
  }
  if (
    trimmed.startsWith("xpath=") ||
    trimmed.startsWith("css=") ||
    trimmed.startsWith("text=") ||
    trimmed.startsWith("internal:")
  ) {
    return trimmed;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("(")) {
    return `xpath=${trimmed}`;
  }
  return trimmed;
}

export function resolveReplayFillValue(
  selector: string,
  recordedValue: string | undefined,
  valueOverrides?: Record<string, string>,
): string {
  const fallback = String(recordedValue ?? "");
  if (!valueOverrides) {
    return fallback;
  }
  const raw = String(selector ?? "").trim();
  const pw = toPlaywrightSelector(raw);
  if (Object.prototype.hasOwnProperty.call(valueOverrides, raw)) {
    return String(valueOverrides[raw] ?? "");
  }
  if (pw !== raw && Object.prototype.hasOwnProperty.call(valueOverrides, pw)) {
    return String(valueOverrides[pw] ?? "");
  }
  if (pw.startsWith("xpath=") && Object.prototype.hasOwnProperty.call(valueOverrides, pw.slice(6))) {
    return String(valueOverrides[pw.slice(6)] ?? "");
  }
  if (
    !raw.startsWith("xpath=") &&
    Object.prototype.hasOwnProperty.call(valueOverrides, `xpath=${raw}`)
  ) {
    return String(valueOverrides[`xpath=${raw}`] ?? "");
  }
  return fallback;
}

/** 收集 fill 录制值 → 固定覆盖值，用于改写 navigate URL 里的旧查询词 */
function collectFixedOverridePairs(
  steps: TrajectoryStep[],
  options?: ReplayEngineOptions,
): Array<{ from: string; to: string }> {
  const pairs: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const type = resolveStepType(step as LooseStep);
    if (type !== "fill" && type !== "select") {
      continue;
    }
    const recorded = step.redacted ? "" : String(step.value ?? "").trim();
    if (!recorded || seen.has(recorded)) {
      continue;
    }
    const selector = String(step.selector ?? "").trim();
    const fieldSpec = lookupFieldOverride(selector, options?.fieldOverrides);
    let next = "";
    if (fieldSpec?.mode === "fixed" && fieldSpec.value.trim()) {
      next = fieldSpec.value.trim();
    } else if (!fieldSpec) {
      next = resolveReplayFillValue(selector, recorded, options?.valueOverrides).trim();
    }
    if (!next || next === recorded) {
      continue;
    }
    seen.add(recorded);
    pairs.push({ from: recorded, to: next });
  }
  return pairs;
}

function applyOverridePairsToText(
  text: string,
  pairs: Array<{ from: string; to: string }>,
): string {
  let next = String(text ?? "");
  if (!next || pairs.length === 0) {
    return next;
  }
  for (const { from, to } of pairs) {
    if (next.includes(from)) {
      next = next.split(from).join(to);
    }
    const encFrom = encodeURIComponent(from);
    const encTo = encodeURIComponent(to);
    if (encFrom && encFrom !== from && next.includes(encFrom)) {
      next = next.split(encFrom).join(encTo);
    }
  }
  return next;
}

/** 解析最终填表值：优先结构化 fieldOverrides（含延迟 AI），否则回退旧 string overrides */
export async function resolveReplayFillValueDeferred(
  selector: string,
  step: TrajectoryStep,
  options?: ReplayEngineOptions,
): Promise<string> {
  // 已脱敏的密码/验证码步骤：掩码不是真实值，回放时按「无录制值」处理，交给 overrides / AI 生成
  const recorded = step.redacted ? "" : String(step.value ?? "");
  const fieldSpec = lookupFieldOverride(selector, options?.fieldOverrides);
  if (fieldSpec && options?.resolveContext) {
    const enriched: FieldOverrideSpec = {
      ...fieldSpec,
      label:
        fieldSpec.label ||
        step.label ||
        step.semanticContext?.label ||
        undefined,
      inputType:
        fieldSpec.inputType ||
        step.inputType ||
        step.semanticContext?.inputType ||
        undefined,
    };
    return resolveFieldOverrideValue(enriched, recorded, options.resolveContext);
  }
  if (fieldSpec) {
    // 无上下文时：fixed 原样返回；ai_prompt 无法生成则回退录制值
    if (fieldSpec.mode === "fixed") {
      return fieldSpec.value.length > 0 ? fieldSpec.value : recorded;
    }
    return recorded;
  }
  return resolveReplayFillValue(selector, recorded, options?.valueOverrides);
}

function looksLikeSearchInput(selector: string): boolean {
  const s = selector.toLowerCase();
  return (
    s.includes("chat-textarea") ||
    s.includes("#kw") ||
    s.includes('name="wd"') ||
    s.includes("search")
  );
}

function looksLikeSearchSubmit(selector: string): boolean {
  const s = selector.toLowerCase().trim();
  if (SEARCH_SUBMIT_SELECTORS.has(s)) {
    return true;
  }
  return s === "#su" || s.includes("chat-submit") || s.includes("search-btn");
}

/** 提取用于 URL 特征匹配的主路径（去掉 query，容忍动态参数） */
export function postConditionUrlNeedle(rawUrl: string): string {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const withoutQuery = trimmed.split("?")[0] ?? trimmed;
  return withoutQuery.split("#")[0] ?? withoutQuery;
}

function urlMatchesPostCondition(href: string, recordedUrl: string): boolean {
  const needle = postConditionUrlNeedle(recordedUrl);
  if (!needle) {
    return true;
  }
  try {
    const current = href.includes(needle) || postConditionUrlNeedle(href).includes(needle);
    return current;
  } catch {
    return false;
  }
}

/**
 * 特征屏障：有 postCondition 则断言 URL；无论新旧轨迹均做 AJAX 稳定 + 人类停顿。
 * 绝对禁止在状态变更后立刻进入下一步。
 */
async function settleAfterStateChange(
  page: Page,
  step: LooseStep,
  signal?: AbortSignal,
): Promise<void> {
  const postUrl = String(step.postCondition?.url ?? "").trim();
  if (postUrl) {
    const needle = postConditionUrlNeedle(postUrl);
    if (needle) {
      await withAbort(
        signal,
        page
          .waitForURL((url) => urlMatchesPostCondition(url.href, postUrl), {
            timeout: POST_URL_TIMEOUT_MS,
          })
          .catch(() => undefined),
      );
    }
  }

  // 强制 AJAX/SPA 稳定屏障（旧轨迹无 postCondition 时也走此降级路径）
  await withAbort(
    signal,
    page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined),
  );
  // 人类视觉停顿：给 SPA 渲染与动画收尾时间
  await withAbort(signal, sleep(HUMAN_SETTLE_MS));
}

/**
 * 动态 DOM 稳定：正文长度与摘要连续两次采样一致，且达到最小字符数。
 * 用于拦截 AJAX 搜索结果尚未挂载时的「残影」交接。
 */
async function waitForDomContentStable(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + HANDOFF_DOM_STABLE_TIMEOUT_MS;
  let lastSig = "";
  let stableHits = 0;

  while (Date.now() < deadline) {
    assertNotAborted(signal);
    const sig = await withAbort(
      signal,
      page
        .evaluate((minChars) => {
          const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "LINK", "META"]);
          const root =
            document.querySelector("#content_left, #rso, #b_results, main, article") ||
            document.body;
          if (!root) {
            return "0:";
          }
          const parts: string[] = [];
          const walk = (node: Node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as HTMLElement;
              if (SKIP.has(el.tagName)) {
                return;
              }
              try {
                const style = window.getComputedStyle(el);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number(style.opacity) === 0
                ) {
                  return;
                }
              } catch {
                /* ignore */
              }
              if (el.getAttribute("aria-hidden") === "true") {
                return;
              }
              for (const child of Array.from(el.childNodes)) {
                walk(child);
              }
              return;
            }
            if (node.nodeType === Node.TEXT_NODE) {
              const t = String(node.textContent ?? "")
                .replace(/\s+/g, " ")
                .trim();
              if (t) {
                parts.push(t);
              }
            }
          };
          walk(root);
          const text = parts.join(" ").trim();
          const len = text.length;
          return `${len}:${text.slice(0, 160)}:${len >= minChars ? "1" : "0"}`;
        }, HANDOFF_MIN_BODY_CHARS)
        .catch(() => "0::0"),
    );

    const enough = sig.endsWith(":1");
    if (sig && enough && sig === lastSig) {
      stableHits += 1;
      if (stableHits >= 2) {
        return;
      }
    } else {
      stableHits = 0;
      lastSig = sig;
    }
    await withAbort(signal, sleep(HANDOFF_DOM_POLL_MS));
  }
}

/**
 * 回放全部完成后 → AI 交接前的防抢跑屏障。
 * networkidle → DOM 稳定 → 人类视觉缓冲；禁止 0ms 开环交接残影 DOM。
 */
export async function settleBeforeAiHandoff(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  await withAbort(
    signal,
    page
      .waitForLoadState("networkidle", { timeout: HANDOFF_NETWORK_IDLE_MS })
      .catch(() => undefined),
  );
  await waitForDomContentStable(page, signal);
  assertNotAborted(signal);
  await withAbort(signal, sleep(HANDOFF_HUMAN_BUFFER_MS));
}

async function waitAttached(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<string> {
  const pw = toPlaywrightSelector(selector);
  const locator = page.locator(pw).first();
  await locator.waitFor({ state: "attached", timeout: timeoutMs });
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  return pw;
}

async function resolveFillSelector(
  page: Page,
  primary: string,
  timeoutMs: number,
): Promise<string> {
  try {
    return await waitAttached(page, primary, timeoutMs);
  } catch (primaryError) {
    if (!looksLikeSearchInput(primary)) {
      throw primaryError;
    }
    const tried = new Set([toPlaywrightSelector(primary), primary]);
    for (const candidate of SEARCH_INPUT_FALLBACKS) {
      const key = toPlaywrightSelector(candidate);
      if (tried.has(key)) {
        continue;
      }
      tried.add(key);
      try {
        return await waitAttached(page, candidate, 2_500);
      } catch {
        /* next */
      }
    }
    throw primaryError;
  }
}

async function clickSearchOrButton(
  page: Page,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  // 关掉百度联想层，避免挡住 #su
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(120);
  assertNotAborted(signal);

  const pw = toPlaywrightSelector(selector);
  const locator = page.locator(pw).first();
  const attached = await locator.count().catch(() => 0);
  if (attached > 0) {
    try {
      await withAbort(
        signal,
        locator.click({ force: true, timeout: Math.min(timeoutMs, CLICK_TIMEOUT_MS) }),
      );
      return;
    } catch (error) {
      assertNotAborted(signal);
      /* fall through to Enter */
      void error;
    }
  }

  if (looksLikeSearchSubmit(selector)) {
    await page.keyboard.press("Enter");
    await sleep(300);
    return;
  }

  await withAbort(signal, waitAttached(page, selector, timeoutMs));
  await withAbort(
    signal,
    page.locator(pw).first().click({ force: true, timeout: CLICK_TIMEOUT_MS }),
  );
}

/**
 * 核心：对已连接的 Page 回放轨迹（推荐用于 Sidecar CDP 会话）
 */
export async function replayTrajectoryOnPage(
  page: Page,
  steps: TrajectoryStep[],
  options?: ReplayEngineOptions,
): Promise<ReplayEngineResult> {
  const timeout = options?.selectorTimeoutMs ?? DEFAULT_SELECTOR_TIMEOUT_MS;
  const pauseMs = options?.stepPauseMs ?? 120;
  const valueOverrides = options?.valueOverrides;
  const fieldOverrides = options?.fieldOverrides;
  const signal = options?.signal;
  const emit = options?.onProgress;
  const log = makeConsole(options?.verboseConsole === true);
  const overrideCount =
    (fieldOverrides ? Object.keys(fieldOverrides).length : 0) ||
    (valueOverrides ? Object.keys(valueOverrides).length : 0);

  if (!Array.isArray(steps) || steps.length === 0) {
    const error = "轨迹步骤为空，无法回放";
    log.fail(error);
    return { ok: false, completedSteps: 0, error };
  }

  const navigateRewritePairs =
    overrideCount > 0 ? collectFixedOverridePairs(steps, options) : [];

  log.dim(
    `▶ 回放开始 · 共 ${steps.length} 步 · timeout=${timeout}ms` +
      (overrideCount > 0 ? ` · overrides=${overrideCount}` : ""),
  );

  /** 人工在确认框里现场给出的值（按 selector），优先于轨迹/数据集的值（R2 的合规供值路径） */
  const humanProvidedValues = new Map<string, string>();

  for (let index = 0; index < steps.length; index += 1) {
    assertNotAborted(signal);
    const step = steps[index] as LooseStep;
    const stepNo = step.step ?? index + 1;
    const type = resolveStepType(step);
    const selector = String(step.selector ?? "").trim();
    const validSelector = toPlaywrightSelector(selector);
    let usedFeatureSettle = false;

    emit?.({ step: stepNo, type, selector: validSelector || selector, status: "start" });
    log.dim(
      `  → step ${stepNo}/${steps.length} [${type}] ${validSelector || step.value || step.url || ""}`,
    );

    // R1：支付/不可逆动作必须先过人工确认；被拒就中止整轮回放（不冒充成功）
    const gated = await gateCriticalStep({
      options,
      step,
      selector,
      type,
      stepNo,
      page,
      humanProvidedValues,
    });
    if (gated) {
      emit?.({ step: stepNo, type, selector: validSelector || selector, status: "fail", message: gated.error });
      return gated;
    }

    try {
      if (selector && isTempIdSelector(selector)) {
        throw new Error(`拒绝执行临时 ID selector「${selector}」`);
      }

      switch (type) {
        case "navigate": {
          const rawTarget = String(step.value ?? step.url ?? selector).trim();
          const target = applyOverridePairsToText(rawTarget, navigateRewritePairs);
          if (!target) {
            throw new Error("navigate 缺少目标 URL");
          }
          await withAbort(signal, safeGoto(page, target, { softNetworkIdle: false }));
          await withAbort(
            signal,
            softSettleAfterNavigation(page, {
              softNetworkIdle: false,
              domTimeoutMs: 2_500,
            }),
          );
          // 特征屏障：禁止立刻进入下一步
          await settleAfterStateChange(page, step, signal);
          usedFeatureSettle = true;
          break;
        }
        case "wait": {
          const delay = Number(step.value ?? 500);
          const ms = Number.isFinite(delay) ? Math.min(delay, 10_000) : 500;
          await withAbort(signal, sleep(ms));
          break;
        }
        case "fill":
        case "select": {
          if (!validSelector) {
            throw new Error(`${type} 缺少 selector`);
          }
          const resolved = await withAbort(signal, resolveFillSelector(page, selector, timeout));
          assertNotAborted(signal);
          const humanValue = humanProvidedValues.get(selector);
          const finalValue =
            humanValue != null
              ? humanValue
              : await withAbort(
                  signal,
                  resolveReplayFillValueDeferred(selector, step, options),
                );
          const locator = page.locator(resolved).first();
          if (type === "select") {
            await withAbort(
              signal,
              locator.selectOption({ label: finalValue }).catch(async () => {
                await locator.selectOption({ value: finalValue });
              }),
            );
          } else {
            await locator.click({ force: true, timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
            await withAbort(
              signal,
              locator.fill(finalValue, { timeout: FILL_TIMEOUT_MS }).catch(async () => {
                await locator.fill("").catch(() => undefined);
                await page.keyboard.type(finalValue, { delay: 15 });
              }),
            );
            // 搜索框填完后收起联想，方便下一步点按钮；下一步若是提交也可直接 Enter
            if (looksLikeSearchInput(resolved) || looksLikeSearchInput(selector)) {
              await sleep(150);
              const next = steps[index + 1] as LooseStep | undefined;
              const nextType = next ? resolveStepType(next) : "";
              const nextSel = String(next?.selector ?? "").trim();
              if (nextType === "click" && looksLikeSearchSubmit(nextSel)) {
                // 预提交由下一步处理；此处仅 Esc 清遮挡
                await page.keyboard.press("Escape").catch(() => undefined);
              }
            }
          }
          break;
        }
        case "click": {
          const primary =
            String(step.primarySelector ?? step.fallbackSelector ?? selector).trim() ||
            validSelector;
          if (!primary && !(Number.isFinite(Number(step.x)) || step.fallbackCoordinates)) {
            throw new Error("click 缺少 selector");
          }
          assertNotAborted(signal);
          if (primary && !isTempIdSelector(primary)) {
            try {
              await clickSearchOrButton(page, primary, timeout, signal);
              await settleAfterStateChange(page, step, signal);
              usedFeatureSettle = true;
              break;
            } catch {
              /* fall through to coordinates / label */
            }
          }
          const labelHeal = String(step.semanticLabel ?? step.label ?? "").trim();
          if (labelHeal && labelHeal !== "（点击）" && labelHeal !== "（坐标点击）") {
            try {
              await withAbort(
                signal,
                page.getByText(labelHeal, { exact: false }).first().click({
                  force: true,
                  delay: 50,
                  timeout: CLICK_TIMEOUT_MS,
                }),
              );
              await settleAfterStateChange(page, step, signal);
              usedFeatureSettle = true;
              break;
            } catch {
              /* fall through to coordinates */
            }
          }
          const rawCoords = step.fallbackCoordinates ?? {
            x: Number(step.x),
            y: Number(step.y),
            unit: undefined as "relative" | "px" | undefined,
          };
          if (!Number.isFinite(Number(rawCoords.x)) || !Number.isFinite(Number(rawCoords.y))) {
            throw new Error("click 缺少可用 selector 与坐标");
          }
          const box = page.viewportSize() ?? { width: 1280, height: 720 };
          const pixel = resolveCoordToViewportPixels(
            {
              x: Number(rawCoords.x),
              y: Number(rawCoords.y),
              unit: (rawCoords as { unit?: string }).unit,
            },
            box,
            step.viewport,
          );
          if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) {
            throw new Error("click 坐标无法映射到当前视口");
          }
          await withAbort(
            signal,
            page.mouse.click(pixel.x, pixel.y, {
              delay: 50,
            }),
          );
          await settleAfterStateChange(page, step, signal);
          usedFeatureSettle = true;
          break;
        }
        case "click_point": {
          assertNotAborted(signal);
          const fallback = String(
            step.primarySelector ?? step.fallbackSelector ?? selector,
          ).trim();
          let clicked = false;
          if (fallback && !isTempIdSelector(fallback) && !fallback.startsWith("text=")) {
            try {
              await clickSearchOrButton(page, fallback, Math.min(timeout, 3_000), signal);
              clicked = true;
            } catch {
              clicked = false;
            }
          } else if (fallback.startsWith("text=")) {
            const label = fallback.slice("text=".length).trim();
            if (label) {
              try {
                await withAbort(
                  signal,
                  page.getByText(label, { exact: false }).first().click({
                    force: true,
                    delay: 50,
                    timeout: CLICK_TIMEOUT_MS,
                  }),
                );
                clicked = true;
              } catch {
                clicked = false;
              }
            }
          }
          if (!clicked) {
            const box = page.viewportSize() ?? { width: 1280, height: 720 };
            const rawX = Number(step.fallbackCoordinates?.x ?? step.x);
            const rawY = Number(step.fallbackCoordinates?.y ?? step.y);
            if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
              throw new Error("click_point 缺少可用 selector 与坐标");
            }
            const pixel = resolveCoordToViewportPixels(
              {
                x: rawX,
                y: rawY,
                unit: step.fallbackCoordinates?.unit,
              },
              box,
              step.viewport,
            );
            await withAbort(signal, page.mouse.click(pixel.x, pixel.y, { delay: 50 }));
          }
          await settleAfterStateChange(page, step, signal);
          usedFeatureSettle = true;
          break;
        }
        case "keypress": {
          const key = String(step.value ?? "").trim() || "Enter";
          await withAbort(signal, page.keyboard.press(key));
          await sleep(200);
          break;
        }
        case "scroll": {
          const direction = String(step.value ?? "down").toLowerCase();
          const dir =
            direction === "up" || direction === "bottom" ? direction : "down";
          await page.evaluate((d: string) => {
            if (d === "bottom") {
              window.scrollTo(0, document.documentElement.scrollHeight);
              return;
            }
            window.scrollBy(0, d === "up" ? -600 : 600);
          }, dir);
          await sleep(200);
          break;
        }
        case "clipboard_read": {
          /*
           * N5 / N6（§6.3）：读 → 写变量 → 继续；**内容不进日志、不落盘**。
           * 降级链：页面剪贴板失败 → 系统剪贴板 → 失败即如实报错并停（禁止编造内容）。
           */
          // N2：调用方（设置 / 外部 API）可以把剪贴板**整条关掉**。
          // 关掉就是关掉：不读、不降级、不猜 —— 直接如实报错停在这里。
          if (options?.clipboard?.mode === "off") {
            throw new Error("clipboard_read：剪贴板读取已被关闭（mode=off），拒绝读取");
          }
          const wantPage = String(step.scope ?? "system").trim().toLowerCase() === "page";
          const timeoutMs = Math.max(
            500,
            Math.min(15_000, Number(step.timeoutMs ?? step.timeout_ms ?? 5_000) || 5_000),
          );
          const currentOrigin = originOf(page);
          const declaredOrigin = String(step.origin ?? "").trim();
          if (wantPage && declaredOrigin && declaredOrigin !== currentOrigin) {
            // 只按**当前页**授权：轨迹里记录的 origin 可能是别的域，授权给它等于扩权
            log.dim(
              `  clipboard_read: 记录的 origin=${declaredOrigin} 与当前页 ${currentOrigin || "(未知)"} 不一致 → 按当前页授权`,
            );
          }
          let text = "";
          let via = "";
          let firstError = "";
          if (wantPage) {
            if (!currentOrigin) {
              throw new Error("clipboard_read(scope=page) 无法确定当前页 origin，拒绝扩大授权");
            }
            try {
              text = await withAbort(
                signal,
                readPageClipboardText(page, currentOrigin, timeoutMs),
              );
              via = `页面剪贴板（${currentOrigin}）`;
            } catch (error) {
              firstError = stripAnsi(error instanceof Error ? error.message : String(error));
              log.dim(`  clipboard_read: 页面通道失败（${firstError}）→ 降级系统剪贴板`);
            }
          }
          if (!text) {
            const readSystem = options?.readClipboard;
            if (!readSystem) {
              throw new Error(
                `clipboard_read 需要系统剪贴板通道，但当前没有可用通道` +
                  (firstError ? `（页面通道也失败：${firstError}）` : ""),
              );
            }
            const result = await withAbort(
              signal,
              readSystem({ scope: "system", origin: currentOrigin, timeoutMs }),
            );
            if (!result.ok) {
              throw new Error(
                `读取系统剪贴板失败：${result.error}` +
                  (firstError ? `（页面通道也失败：${firstError}）` : ""),
              );
            }
            text = result.text;
            via = "系统剪贴板";
          }
          text = String(text ?? "").replace(/\u0000/g, "").trim();
          if (!text) {
            throw new Error("clipboard_read 读到空内容：不做任何猜测，请先复制内容再运行");
          }
          // §6.4：一次性凭证默认拒绝自动填入（错误文案只带依据，不带内容）
          const gate = gateClipboardValue({
            text,
            treatAsHuman: options?.clipboard?.treatAsHuman === true,
          });
          if (!gate.allowed) {
            throw new Error(
              `剪贴板内容被判为一次性凭证（${gate.reason}），已按 R2 拒绝自动填入：` +
                `请在回放设置里显式勾选「剪贴板视为人工提供」，或改由人工填写`,
            );
          }
          const sink = options?.clipboardSink;
          if (sink) {
            const into = String(step.into ?? "").trim();
            const nextIndex = Object.keys(sink).filter((key) => /^\d+$/.test(key)).length;
            sink[String(nextIndex)] = text;
            if (into) {
              sink[into] = text;
            }
            log.dim(
              `  clipboard_read: ${describeClipboardForLog(text)} · 来源 ${via}` +
                (into ? ` · → {{clip.${into}}}` : ` · → {{clip.${nextIndex}}}`),
            );
          } else {
            log.dim(`  clipboard_read: ${describeClipboardForLog(text)} · 来源 ${via} · 无变量落点`);
          }
          break;
        }
        default:
          throw new Error(`不支持的动作类型: ${type || "(empty)"}`);
      }

      // 用户规则 must_click 台账：真正点成功了才记（判据用这一步实际用的选择器 + 可读标签）
      if ((type === "click" || type === "click_point") && options?.onClickStep) {
        const clickedSelector =
          String(step.primarySelector ?? step.fallbackSelector ?? selector).trim() || validSelector;
        const clickedLabel = String(step.semanticLabel ?? step.label ?? step.text ?? "").trim();
        try {
          await Promise.resolve(
            options.onClickStep({ step: stepNo, selector: clickedSelector, label: clickedLabel }),
          );
        } catch (error) {
          log.dim(
            `  must_click 台账记录失败（不阻断回放）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      emit?.({ step: stepNo, type, selector: validSelector || selector, status: "ok" });
      log.ok(`step ${stepNo} [${type}] 完成`);
      // 特征屏障已含人类停顿时不再叠 pause
      if (!usedFeatureSettle) {
        await sleep(pauseMs);
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = stripAnsi(raw);
      const aborted = signal?.aborted === true || message.includes("回放已手动停止");
      const detail = aborted
        ? `回放已手动停止 · step=${stepNo}`
        : `回放中止 · step=${stepNo} · type=${type} · selector=${validSelector || selector || "(none)"} · ${message}`;
      log.fail(detail);
      emit?.({
        step: stepNo,
        type,
        selector: validSelector || selector,
        status: "fail",
        message: detail,
      });
      return {
        ok: false,
        completedSteps: index,
        failedStep: stepNo,
        error: detail,
      };
    }
  }

  log.ok(`回放全部完成 · ${steps.length} 步`);
  // 防抢跑：最后一步后必须沉淀，再允许上层交接 AI
  log.dim("  … 交接前网络/DOM 沉淀屏障");
  await settleBeforeAiHandoff(page, signal);
  log.ok("沉淀完成 · 可安全交接 AI");
  return { ok: true, completedSteps: steps.length };
}
