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
  buildDeterministicReplayPassword,
  isOneTimeOrPaymentSecretField,
  isReplayablePasswordField,
  lookupFieldOverride,
  resolveFieldOverrideValue,
  type FieldOverrideSpec,
  type ResolveOverrideContext,
} from "./deferred_generation.js";
import { isTempIdSelector, type TrajectoryActionType, type TrajectoryPostCondition, type TrajectoryStep } from "./trajectory.js";
import { decideHitlConfirm } from "./core/hitl_policy.js";
import { describeClipboardForLog, gateClipboardValue } from "./core/clipboard_gate.js";
import { readFieldSnapshot, verifyFill } from "./core/fill_verify.js";
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
  /**
   * 填写 / 下拉选择成功后的回调（把实际写入值落到「数据目录」）。
   * 失败不阻断回放；剪贴板内容禁止经此回调落盘。
   */
  onFillStep?: (info: {
    step: number;
    type: "fill" | "select";
    selector: string;
    label: string;
    value: string;
    fieldType?: string | null;
    url: string;
  }) => Promise<void> | void;
  /** 轨迹目标（仅用于日志/文案；critical 永不因目标覆盖豁免） */
  goal?: string;
  /**
   * 单步 AI 愈合（机械+启发式穷尽后）。默认启用；关闭则纯机械失败即停。
   * 成功后必须交回机械 N+1，禁止多步接管。
   */
  aiHeal?: {
    enabled?: boolean;
    maxPerRun?: number;
    allowDismissBlocker?: boolean;
  };
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

/**
 * 录制侧 elementLabelBlob 会拼出「lamchunho09281 button button」这类噪声标签。
 * 回放 getByText 须剥掉尾部 role/tag，否则文案愈合永远对不上页面真文案。
 */
const CLICK_LABEL_HEAL_NOISE = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "option",
  "menuitem",
  "img",
  "image",
  "a",
  "input",
  "select",
  "textarea",
  "div",
  "span",
  "submit",
  "reset",
  "combobox",
  "listbox",
  "tab",
]);

export function clickLabelHealCandidates(raw: string): string[] {
  const label = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!label || label === "（点击）" || label === "（坐标点击）") {
    return [];
  }
  const out: string[] = [];
  const push = (value: string) => {
    const next = value.replace(/\s+/g, " ").trim();
    if (!next || next === "（点击）" || next === "（坐标点击）") {
      return;
    }
    if (!out.includes(next)) {
      out.push(next);
    }
  };
  const parts = label.split(" ");
  while (parts.length > 1 && CLICK_LABEL_HEAL_NOISE.has(parts[parts.length - 1]!.toLowerCase())) {
    parts.pop();
  }
  // 优先干净文案，再退回完整 blob（兼容旧轨迹）
  if (parts.length) {
    push(parts.join(" "));
    if (parts[0] && parts[0].length >= 2) {
      push(parts[0]);
    }
  }
  push(label);
  // 日期/序号：「15日」页上常只有「15」
  const core = out[0] ?? "";
  const dayLike = core.match(/^(\d{1,4})([日月年号號]?)$/);
  if (dayLike?.[1]) {
    push(dayLike[1]);
    if (dayLike[2]) {
      push(`${dayLike[1]}${dayLike[2]}`);
    }
  }
  return out;
}

/** 常见表单 CTA：不是「建议用户名/邮箱」类动态按钮 */
const CLICK_CTA_LABEL_RE =
  /下一步|下一步骤|继续|確定|确定|確認|确认|提交|登录|登錄|註冊|注册|同意|允许|允許|取消|返回|關閉|关闭|next|continue|submit|sign\s*in|create|allow|cancel|back|close|ok|done/i;

/**
 * 录制标签是否像「动态建议项」（如微软占用邮箱后的备用名）。
 * 回放时录制名往往已不在页上，不能靠原文案愈合。
 */
export function looksLikeDynamicSuggestionLabel(raw: string): boolean {
  const core = clickLabelHealCandidates(raw)[0] ?? "";
  if (!core || core.length < 3 || core.length > 64) {
    return false;
  }
  if (CLICK_CTA_LABEL_RE.test(core) || /\s/.test(core)) {
    return false;
  }
  // 本地名 / 句柄：字母数字为主，可含 . _ + -
  return /^[a-z0-9][a-z0-9._+-]*$/i.test(core);
}

/** 是否像下拉选项（生日日/月、带 option 噪声的 blob） */
export function looksLikeDropdownOptionLabel(raw: string): boolean {
  const blob = String(raw ?? "").toLowerCase();
  if (/\boption\b|\bmenuitem\b/.test(blob)) {
    return true;
  }
  const core = clickLabelHealCandidates(raw)[0] ?? "";
  if (!core || CLICK_CTA_LABEL_RE.test(core)) {
    return false;
  }
  if (/^\d{1,4}[日月年号號]?$/.test(core)) {
    return true;
  }
  if (
    /月$/.test(core) ||
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)/i.test(
      core,
    )
  ) {
    return true;
  }
  return false;
}

/** 向后找下一个可定位的 fill/select（跳过临时 ID） */
export function findNextFillSelectStep(
  steps: TrajectoryStep[],
  fromIndex: number,
): {
  index: number;
  selector: string;
  label: string;
  inputType: string;
} | null {
  for (let i = Math.max(0, fromIndex); i < steps.length; i += 1) {
    const step = steps[i] as LooseStep;
    const type = resolveStepType(step);
    if (type !== "fill" && type !== "select") {
      continue;
    }
    const selector = String(step.selector ?? "").trim();
    if (!selector || isTempIdSelector(selector)) {
      continue;
    }
    const label = String(step.semanticLabel ?? step.label ?? step.semanticContext?.label ?? "").trim();
    const inputType = String(
      step.inputType ?? step.semanticContext?.inputType ?? "",
    )
      .trim()
      .toLowerCase();
    return { index: i, selector, label, inputType };
  }
  return null;
}

async function isSelectorAttachedQuick(
  page: Page,
  selector: string,
  timeoutMs = 700,
): Promise<boolean> {
  const pw = toPlaywrightSelector(selector);
  if (!pw) {
    return false;
  }
  try {
    const locator = page.locator(pw).first();
    await locator.waitFor({ state: "attached", timeout: timeoutMs });
    return (await locator.count().catch(() => 0)) > 0;
  } catch {
    return false;
  }
}

/** 录制 xpath 漂移时，用字段语义再探一次（密码/邮箱等），避免该跳过却硬点 */
async function isNextFillReadyOnPage(
  page: Page,
  next: {
    selector: string;
    label: string;
    inputType: string;
  },
): Promise<boolean> {
  if (await isSelectorAttachedQuick(page, next.selector, 800)) {
    return true;
  }
  const blob = `${next.label} ${next.inputType}`.toLowerCase();
  const probes: string[] = [];
  if (next.inputType === "password" || /password|密碼|密码|pwd|口令/.test(blob)) {
    probes.push('input[type="password"]');
  }
  if (
    next.inputType === "email" ||
    /e-?mail|邮箱|郵箱|郵件|邮件/.test(blob)
  ) {
    probes.push('input[type="email"]');
  }
  for (const probe of probes) {
    if (await isSelectorAttachedQuick(page, probe, 500)) {
      return true;
    }
  }
  return false;
}

/**
 * 后续填写控件已出现 → 当前 click 是录制时的中间页（建议邮箱等），应跳过，
 * 禁止再用「下一步」文案误点到新页上的同名按钮。
 */
export async function shouldSkipOptionalClick(
  page: Page,
  steps: TrajectoryStep[],
  clickIndex: number,
): Promise<{ skip: true; reason: string } | { skip: false }> {
  const next = findNextFillSelectStep(steps, clickIndex + 1);
  if (!next) {
    return { skip: false };
  }
  const present = await isNextFillReadyOnPage(page, next);
  if (!present) {
    return { skip: false };
  }
  const hint = (next.label || next.selector).slice(0, 40);
  return {
    skip: true,
    reason: `后续填写「${hint}」已在页面上（中间建议/确认页未出现，跳过以免误点）`,
  };
}

/** 仍停在建议页时：点第一个像用户名的按钮（不依赖录制时的具体名字） */
async function tryClickDynamicSuggestion(
  page: Page,
  signal?: AbortSignal,
): Promise<boolean> {
  assertNotAborted(signal);
  const locators = page.locator("button, [role='button'], a[role='button']");
  const count = await locators.count().catch(() => 0);
  const limit = Math.min(count, 40);
  for (let i = 0; i < limit; i += 1) {
    assertNotAborted(signal);
    const item = locators.nth(i);
    const text = String((await item.innerText().catch(() => "")) ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!looksLikeDynamicSuggestionLabel(text)) {
      continue;
    }
    const visible = await item.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    try {
      await withAbort(
        signal,
        item.click({ force: true, delay: 50, timeout: CLICK_TIMEOUT_MS }),
      );
      return true;
    } catch {
      /* try next candidate */
    }
  }
  return false;
}

/**
 * 自定义下拉选项回放：与 Agent select_dropdown 同口径（页内找可见 option，禁 RegExp hasText）。
 * 覆盖 Fluent 等「只有数字、无 role=option 的 div 列表」；可选重开上一步触发器。
 */
export async function tryClickListOptionByLabel(
  page: Page,
  rawLabel: string,
  signal?: AbortSignal,
  reopenSelector?: string,
): Promise<boolean> {
  const candidates = clickLabelHealCandidates(rawLabel).filter(
    (c) => c && !CLICK_CTA_LABEL_RE.test(c),
  );
  if (candidates.length === 0) {
    return false;
  }

  const findAndClick = async (wanted: string): Promise<boolean> => {
    assertNotAborted(signal);
    const handle = await page.evaluateHandle((wantRaw: string) => {
      const normalize = (value: string) =>
        String(value ?? "")
          .replace(/\s+/g, "")
          .toLowerCase();
      const want = normalize(wantRaw);
      const wantDigits = want.replace(/[^\d]/g, "");
      const visible = (node: Element) => {
        const style = getComputedStyle(node);
        const rect = (node as HTMLElement).getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 2 &&
          rect.height > 2
        );
      };
      const textOf = (node: Element) =>
        (node.textContent || "").replace(/\s+/g, " ").trim();
      const lists = Array.from(
        document.querySelectorAll(
          '[role="listbox"], [role="menu"], ul[role="listbox"], [class*="Dropdown-items" i], [class*="ms-Dropdown-items" i]',
        ),
      ).filter(visible);
      const roots = lists.length > 0 ? lists : [];
      const pool: Element[] = [];
      const pushUnique = (node: Element) => {
        if (!pool.includes(node)) pool.push(node);
      };
      for (const root of roots) {
        for (const node of Array.from(
          root.querySelectorAll('[role="option"], [role="menuitem"], li, button'),
        )) {
          if (visible(node)) pushUnique(node);
        }
        // Fluent / 无 role：列表下短文案 div
        for (const node of Array.from(root.children)) {
          if (!visible(node)) continue;
          const t = textOf(node);
          if (t && t.length <= 40) pushUnique(node);
        }
      }
      if (pool.length === 0) {
        for (const node of Array.from(
          document.querySelectorAll('[role="option"], [role="menuitem"]'),
        )) {
          if (visible(node)) pushUnique(node);
        }
      }
      let hit: Element | null = null;
      for (const node of pool) {
        if (normalize(textOf(node)) === want) {
          hit = node;
          break;
        }
      }
      if (!hit) {
        for (const node of pool) {
          const t = normalize(textOf(node));
          if (t.includes(want) || (wantDigits.length > 0 && t === wantDigits)) {
            hit = node;
            break;
          }
        }
      }
      if (!hit && wantDigits.length > 0) {
        for (const node of pool) {
          const t = normalize(textOf(node));
          if (t.includes(wantDigits) && t.length <= wantDigits.length + 4) {
            hit = node;
            break;
          }
        }
      }
      return hit;
    }, wanted);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => undefined);
      return false;
    }
    try {
      await el.evaluate((node) => {
        (node as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" });
      }).catch(() => undefined);
      await withAbort(signal, el.click({ timeout: 4_000 }));
      return true;
    } catch {
      return false;
    } finally {
      await el.dispose().catch(() => undefined);
      await handle.dispose().catch(() => undefined);
    }
  };

  for (const wanted of candidates) {
    if (await findAndClick(wanted)) {
      return true;
    }
  }

  const reopen = String(reopenSelector ?? "").trim();
  if (reopen && !isTempIdSelector(reopen)) {
    try {
      assertNotAborted(signal);
      await clickSearchOrButton(page, reopen, CLICK_TIMEOUT_MS, signal);
      await sleep(280);
    } catch {
      return false;
    }
    for (const wanted of candidates) {
      if (await findAndClick(wanted)) {
        return true;
      }
    }
  }
  return false;
}

function describeClickSelectorFailure(primary: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const short = primary.slice(0, 96);
  if (/Timeout|exceeded|waiting for/i.test(msg)) {
    return `selector 超时未找到（${short}）`;
  }
  if (/not found|No node|strict mode violation|resolved to 0/i.test(msg)) {
    return `selector 未命中（${short}）`;
  }
  if (msg.trim()) {
    return `selector 点击失败：${msg.slice(0, 120)}`;
  }
  return `selector 不可用（${short}）`;
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
  // 已脱敏的密码/验证码步骤：掩码不是真实值，必须有覆盖/人工值，禁止空填假成功（P0）
  // 例外：普通注册密码可用确定性本地密码（非 OTP、非 AI）
  const recorded = step.redacted ? "" : String(step.value ?? "");
  const labelForSecret = String(
    step.label || step.semanticLabel || step.semanticContext?.label || selector,
  ).trim();
  const inputTypeForSecret = String(
    step.inputType || step.semanticContext?.inputType || "",
  ).trim();

  const passwordFallbackIfAllowed = (emptyReason: string): string => {
    if (
      step.redacted &&
      isReplayablePasswordField(labelForSecret, inputTypeForSecret) &&
      !isOneTimeOrPaymentSecretField(labelForSecret, inputTypeForSecret)
    ) {
      const local = buildDeterministicReplayPassword(options?.resolveContext?.templateExtra);
      options?.resolveContext?.logger?.progress?.("replay_password_local_fallback", {
        label: labelForSecret.slice(0, 60),
        reason: emptyReason,
      });
      return local;
    }
    throw new Error(
      `敏感字段已脱敏且无可用覆盖值（${labelForSecret.slice(0, 60)}）：请在沙盘填固定值/数据集；OTP/验证码禁止自动编造`,
    );
  };

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
    const resolved = await resolveFieldOverrideValue(enriched, recorded, options.resolveContext);
    if (step.redacted && !String(resolved ?? "").trim()) {
      return passwordFallbackIfAllowed("field_override_empty");
    }
    return resolved;
  }
  if (fieldSpec) {
    if (fieldSpec.mode === "fixed") {
      const fixed = fieldSpec.value.length > 0 ? fieldSpec.value : recorded;
      if (step.redacted && !String(fixed ?? "").trim()) {
        return passwordFallbackIfAllowed("fixed_override_empty");
      }
      return fixed;
    }
    if (step.redacted) {
      return passwordFallbackIfAllowed("ai_prompt_without_context");
    }
    return recorded;
  }
  const fromOverrides = resolveReplayFillValue(selector, recorded, options?.valueOverrides);
  if (step.redacted && !String(fromOverrides ?? "").trim()) {
    return passwordFallbackIfAllowed("no_override");
  }
  return fromOverrides;
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

/**
 * 提取用于 URL 特征匹配的主路径。
 * 保留 hash（SPA 会话常只在 hash 不同）；去掉 query（动态参数）。
 */
export function postConditionUrlNeedle(rawUrl: string): string {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) {
    return "";
  }
  try {
    const u = new URL(trimmed);
    // origin + pathname + hash；不含 search
    return `${u.origin}${u.pathname}${u.hash}`;
  } catch {
    // 相对/残缺 URL：去掉 ?query，保留 #
    const q = trimmed.indexOf("?");
    if (q < 0) return trimmed;
    const hashIdx = trimmed.indexOf("#");
    if (hashIdx > q) {
      return `${trimmed.slice(0, q)}${trimmed.slice(hashIdx)}`;
    }
    return trimmed.slice(0, q);
  }
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

  const { parseReplayAiHealConfig, ReplayAiHealBudget, attemptReplayAiHeal } = await import(
    "./replay_ai_heal.js"
  );
  const aiHealConfig = parseReplayAiHealConfig(options?.aiHeal ?? {});
  const aiHealBudget = new ReplayAiHealBudget(aiHealConfig.maxPerRun);
  const aiSettings = options?.resolveContext?.aiSettings ?? null;
  const healLogger = options?.resolveContext?.logger ?? logger;

  const tryAiHealStep = async (args: {
    stepNo: number;
    stepIndex: number;
    stepType: string;
    label: string;
    failReason: string;
    redacted?: boolean;
    fillValue?: string;
    skipAllowed: boolean;
    skipReason?: string;
  }) => {
    if (!aiHealConfig.enabled || !aiHealBudget.canUse()) {
      return null;
    }
    const result = await attemptReplayAiHeal({
      page,
      stepType: args.stepType,
      label: args.label,
      failReason: args.failReason,
      redacted: args.redacted,
      fillValue: args.fillValue,
      skipAllowed: args.skipAllowed,
      skipReason: args.skipReason,
      config: aiHealConfig,
      budget: aiHealBudget,
      aiSettings,
      logger: healLogger,
      signal,
      steps,
      stepIndex: args.stepIndex,
    });
    if (result.ok) {
      healLogger.agentProgress(
        `回放 AI 愈合成功 · 第 ${args.stepNo} 步 · ${result.message}`,
        {
          phase: "replay_ai_heal_ok",
          step: args.stepNo,
          action: result.action,
          outcome: result.outcome,
          budgetLeft: aiHealBudget.remaining(),
        },
      );
      return result;
    }
    healLogger.agentProgress(
      `回放 AI 愈合未成 · 第 ${args.stepNo} 步 · ${result.reason}`,
      {
        phase: "replay_ai_heal_fail",
        step: args.stepNo,
        reason: result.reason,
        action: result.action ?? null,
        budgetLeft: aiHealBudget.remaining(),
      },
    );
    return null;
  };

  for (let index = 0; index < steps.length; index += 1) {
    assertNotAborted(signal);
    const step = steps[index] as LooseStep;
    const stepNo = step.step ?? index + 1;
    const type = resolveStepType(step);
    const selector = String(step.selector ?? "").trim();
    const validSelector = toPlaywrightSelector(selector);
    let usedFeatureSettle = false;
    let skippedOptionalClick = false;
    let stepOkMessage: string | undefined;

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
      // click / click_point：临时 ID 不在此硬抛——留给分支用文案/坐标愈合
      if (selector && isTempIdSelector(selector) && type !== "click" && type !== "click_point") {
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
          const fillLabel = String(
            step.label || step.semanticLabel || step.semanticContext?.label || selector,
          ).trim();
          let finalValueForHeal = "";
          try {
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
            finalValueForHeal = finalValue;
            const locator = page.locator(resolved).first();
            if (type === "select") {
              await withAbort(
                signal,
                locator.selectOption({ label: finalValue }).catch(async () => {
                  await locator.selectOption({ value: finalValue });
                }),
              );
            } else {
              const beforeSnap = await readFieldSnapshot(page, { selector: resolved }).catch(() => null);
              await locator.click({ force: true, timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
              await withAbort(
                signal,
                locator.fill(finalValue, { timeout: FILL_TIMEOUT_MS }).catch(async () => {
                  await locator.fill("").catch(() => undefined);
                  await page.keyboard.type(finalValue, { delay: 15 });
                }),
              );
              // 稳态回读：空框硬失败，禁止「填了其实空」继续点下一步
              await sleep(120);
              const afterSnap = await readFieldSnapshot(page, { selector: resolved }).catch(() => null);
              if (afterSnap && beforeSnap) {
                const verdict = verifyFill(afterSnap, {
                  before: beforeSnap,
                  text: finalValue,
                  append: false,
                });
                if (verdict.verdict === "empty") {
                  throw new Error(
                    `回放填写后回读为空（${fillLabel.slice(0, 60)}）：${verdict.note}`,
                  );
                }
              } else if (afterSnap && !String(afterSnap.value ?? "").trim() && String(finalValue).trim()) {
                throw new Error(
                  `回放填写后回读为空（${fillLabel.slice(0, 60)}）`,
                );
              }
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
            // 实际写入值交给调用方落「数据目录」（与 Agent 填表记录同口径）
            if (options?.onFillStep) {
              try {
                await Promise.resolve(
                  options.onFillStep({
                    step: stepNo,
                    type,
                    selector: resolved || selector,
                    label: fillLabel,
                    value: finalValue,
                    fieldType:
                      step.inputType ||
                      step.semanticContext?.inputType ||
                      null,
                    url: page.url(),
                  }),
                );
              } catch (error) {
                log.dim(
                  `  填表记录落盘失败（不阻断回放）：${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
            }
            break;
          } catch (fillError) {
            assertNotAborted(signal);
            if (!finalValueForHeal) {
              try {
                finalValueForHeal = await resolveReplayFillValueDeferred(selector, step, options);
              } catch {
                finalValueForHeal = step.redacted ? "" : String(step.value ?? "");
              }
            }
            const failReason =
              fillError instanceof Error ? fillError.message : String(fillError ?? "fill failed");
            const healed = await tryAiHealStep({
              stepNo,
              stepIndex: index,
              stepType: type,
              label: fillLabel || stepHitlLabel(step, selector),
              failReason,
              redacted: Boolean(step.redacted),
              fillValue: finalValueForHeal,
              skipAllowed: false,
            });
            if (healed && healed.outcome === "healed") {
              stepOkMessage = healed.message;
              usedFeatureSettle = true;
              if (options?.onFillStep && finalValueForHeal) {
                try {
                  await Promise.resolve(
                    options.onFillStep({
                      step: stepNo,
                      type: type === "select" ? "select" : "fill",
                      selector,
                      label: fillLabel,
                      value: finalValueForHeal,
                      fieldType: step.inputType || step.semanticContext?.inputType || null,
                      url: page.url(),
                    }),
                  );
                } catch {
                  /* ignore */
                }
              }
              break;
            }
            throw fillError instanceof Error
              ? fillError
              : new Error(`${failReason}。若页面流程已变，请重录该段轨迹后再回放`);
          }
        }
        case "click": {
          const primary =
            String(step.primarySelector ?? step.fallbackSelector ?? selector).trim() ||
            validSelector;
          if (!primary && !(Number.isFinite(Number(step.x)) || step.fallbackCoordinates)) {
            throw new Error("click 缺少 selector");
          }
          assertNotAborted(signal);
          // 中间页已跳过（如邮箱可用 → 直接到密码）：禁止再点录制的建议名 / 误点新页「下一步」
          {
            const optional = await shouldSkipOptionalClick(page, steps, index);
            if (optional.skip) {
              skippedOptionalClick = true;
              stepOkMessage = optional.reason;
              usedFeatureSettle = true;
              log.dim(`  跳过 step ${stepNo} [click]：${optional.reason}`);
              break;
            }
          }
          let selectorFailReason = "";
          if (primary) {
            if (isTempIdSelector(primary)) {
              selectorFailReason = `临时 ID「${primary}」`;
            } else {
              try {
                await clickSearchOrButton(page, primary, timeout, signal);
                await settleAfterStateChange(page, step, signal);
                usedFeatureSettle = true;
                break;
              } catch (primaryError) {
                assertNotAborted(signal);
                selectorFailReason = describeClickSelectorFailure(primary, primaryError);
                /* fall through：文案愈合 → 坐标 */
              }
            }
          } else {
            selectorFailReason = "无 selector";
          }
          const rawLabel = String(step.semanticLabel ?? step.label ?? "").trim();
          let labelHealFailed = false;
          const healCandidates = clickLabelHealCandidates(rawLabel);
          for (const labelHeal of healCandidates) {
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
              labelHealFailed = true;
              /* next candidate / coordinates */
            }
          }
          if (usedFeatureSettle) {
            break;
          }
          // 自定义下拉选项：页内按文案找 option（「15日」↔「15」），必要时重开上一步触发器
          if (looksLikeDropdownOptionLabel(rawLabel)) {
            const prev = steps[index - 1] as LooseStep | undefined;
            const reopen =
              prev &&
              (resolveStepType(prev) === "click" || resolveStepType(prev) === "click_point")
                ? String(
                    prev.primarySelector ?? prev.fallbackSelector ?? prev.selector ?? "",
                  ).trim()
                : "";
            const pickedOption = await tryClickListOptionByLabel(
              page,
              rawLabel,
              signal,
              reopen || undefined,
            );
            if (pickedOption) {
              await settleAfterStateChange(page, step, signal);
              usedFeatureSettle = true;
              stepOkMessage = "已按选项文案点中下拉项";
              break;
            }
          }
          // 仍在建议页、录制名已变：点任意可用用户名建议
          if (looksLikeDynamicSuggestionLabel(rawLabel)) {
            const picked = await tryClickDynamicSuggestion(page, signal);
            if (picked) {
              await settleAfterStateChange(page, step, signal);
              usedFeatureSettle = true;
              stepOkMessage = "已改点页面上的可用建议项（录制名已不在）";
              break;
            }
          }
          // 点击失败后再探一次：可能 SPA 在尝试期间已切到后续填写页
          {
            const optional = await shouldSkipOptionalClick(page, steps, index);
            if (optional.skip) {
              skippedOptionalClick = true;
              stepOkMessage = optional.reason;
              usedFeatureSettle = true;
              log.dim(`  跳过 step ${stepNo} [click]：${optional.reason}`);
              break;
            }
          }
          const rawCoords = step.fallbackCoordinates ?? {
            x: Number(step.x),
            y: Number(step.y),
            unit: undefined as "relative" | "px" | undefined,
          };
          if (!Number.isFinite(Number(rawCoords.x)) || !Number.isFinite(Number(rawCoords.y))) {
            const why = selectorFailReason || "selector 不可用";
            const labelNote = healCandidates.length
              ? labelHealFailed
                ? `；文案愈合未命中「${rawLabel.slice(0, 40)}」`
                : ""
              : "；无可用文案愈合";
            const failReason = `click 缺少可用 selector 与坐标（${why}${labelNote}）`;
            const skipProbe = await shouldSkipOptionalClick(page, steps, index);
            const healed = await tryAiHealStep({
              stepNo,
              stepIndex: index,
              stepType: "click",
              label: rawLabel || stepHitlLabel(step, selector),
              failReason,
              skipAllowed: skipProbe.skip,
              skipReason: skipProbe.skip ? skipProbe.reason : undefined,
            });
            if (healed) {
              if (healed.outcome === "skip_step") {
                skippedOptionalClick = true;
              }
              stepOkMessage = healed.message;
              usedFeatureSettle = true;
              await settleAfterStateChange(page, step, signal).catch(() => undefined);
              break;
            }
            throw new Error(
              `${failReason}。若页面流程已变，请重录该段轨迹后再回放`,
            );
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
          {
            const optional = await shouldSkipOptionalClick(page, steps, index);
            if (optional.skip) {
              skippedOptionalClick = true;
              stepOkMessage = optional.reason;
              usedFeatureSettle = true;
              log.dim(`  跳过 step ${stepNo} [click_point]：${optional.reason}`);
              break;
            }
          }
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
            const labelCandidates = clickLabelHealCandidates(
              String(step.semanticLabel ?? step.label ?? "").trim(),
            );
            for (const labelHeal of labelCandidates) {
              try {
                await withAbort(
                  signal,
                  page.getByText(labelHeal, { exact: false }).first().click({
                    force: true,
                    delay: 50,
                    timeout: CLICK_TIMEOUT_MS,
                  }),
                );
                clicked = true;
                break;
              } catch {
                /* next / coords */
              }
            }
          }
          if (
            !clicked &&
            looksLikeDropdownOptionLabel(
              String(step.semanticLabel ?? step.label ?? "").trim(),
            )
          ) {
            const prev = steps[index - 1] as LooseStep | undefined;
            const reopen =
              prev &&
              (resolveStepType(prev) === "click" || resolveStepType(prev) === "click_point")
                ? String(
                    prev.primarySelector ?? prev.fallbackSelector ?? prev.selector ?? "",
                  ).trim()
                : "";
            clicked = await tryClickListOptionByLabel(
              page,
              String(step.semanticLabel ?? step.label ?? "").trim(),
              signal,
              reopen || undefined,
            );
            if (clicked) {
              stepOkMessage = "已按选项文案点中下拉项";
            }
          }
          if (
            !clicked &&
            looksLikeDynamicSuggestionLabel(
              String(step.semanticLabel ?? step.label ?? "").trim(),
            )
          ) {
            clicked = await tryClickDynamicSuggestion(page, signal);
            if (clicked) {
              stepOkMessage = "已改点页面上的可用建议项（录制名已不在）";
            }
          }
          if (!clicked) {
            const optional = await shouldSkipOptionalClick(page, steps, index);
            if (optional.skip) {
              skippedOptionalClick = true;
              stepOkMessage = optional.reason;
              usedFeatureSettle = true;
              log.dim(`  跳过 step ${stepNo} [click_point]：${optional.reason}`);
              break;
            }
          }
          if (!clicked) {
            const box = page.viewportSize() ?? { width: 1280, height: 720 };
            const rawX = Number(step.fallbackCoordinates?.x ?? step.x);
            const rawY = Number(step.fallbackCoordinates?.y ?? step.y);
            if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
              const why = !fallback
                ? "无 selector"
                : isTempIdSelector(fallback)
                  ? `临时 ID「${fallback}」`
                  : `selector 未点成（${fallback.slice(0, 80)}）`;
              const labelNote = String(step.semanticLabel ?? step.label ?? "").trim()
                ? `；文案愈合未命中`
                : "；无可用文案愈合";
              const failReason = `click_point 缺少可用 selector 与坐标（${why}${labelNote}）`;
              const skipProbe = await shouldSkipOptionalClick(page, steps, index);
              const healed = await tryAiHealStep({
                stepNo,
                stepIndex: index,
                stepType: "click_point",
                label: String(step.semanticLabel ?? step.label ?? "").trim() || stepHitlLabel(step, selector),
                failReason,
                skipAllowed: skipProbe.skip,
                skipReason: skipProbe.skip ? skipProbe.reason : undefined,
              });
              if (healed) {
                if (healed.outcome === "skip_step") {
                  skippedOptionalClick = true;
                }
                stepOkMessage = healed.message;
                usedFeatureSettle = true;
                await settleAfterStateChange(page, step, signal).catch(() => undefined);
                break;
              }
              throw new Error(
                `${failReason}。若页面流程已变，请重录该段轨迹后再回放`,
              );
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
        case "solve_captcha":
        case "captcha": {
          // P2：不追求录 physics；回放桥接 Layer1（仍禁编造）；无模型/失败则明示交人工
          // 与 Agent 同口径：单次不一定过，最多 CAPTCHA_MAX_ATTEMPTS 次再 fail-closed
          const aiSettings = options?.resolveContext?.aiSettings;
          if (!aiSettings) {
            throw new Error(
              "回放遇到验证码步但缺少 AI 设置，无法调用 Layer1：请人工过码后用 Agent 继续，或配置模型后重放",
            );
          }
          const { solveCaptcha, cleanupCaptchaArtifacts } = await import(
            "./bu_agent/captcha_dispatch.js"
          );
          const { CAPTCHA_MAX_ATTEMPTS } = await import("./bu_agent/animated_captcha.js");
          const forceStrategy = String(step.value ?? "").trim();
          const maxAttempts = Math.max(1, CAPTCHA_MAX_ATTEMPTS);
          let lastFailDetail = "";
          let captchaPassed = false;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            assertNotAborted(signal);
            if (attempt > 1) {
              log.dim(`  验证码未过，第 ${attempt}/${maxAttempts} 次重试（勿刷新）…`);
              emit?.({
                step: stepNo,
                type,
                selector: "",
                status: "start",
                message: `验证码重试 ${attempt}/${maxAttempts}`,
              });
              await withAbort(signal, sleep(800 + Math.floor(Math.random() * 700)));
            }
            const unified = await withAbort(
              signal,
              solveCaptcha({
                page,
                aiSettings,
                logger,
                selectorMap: new Map(),
                pageHint: String(step.label || options?.goal || "").slice(0, 240),
                goalHint: options?.goal,
                forceStrategy:
                  forceStrategy && forceStrategy !== "auto" ? forceStrategy : undefined,
                signal,
              }),
            );
            if (unified.kind === "unsupported") {
              throw new Error(
                `回放验证码类型不支持：${unified.detail || "unknown"}（需人工；禁止编造 token）`,
              );
            }
            if (unified.kind === "remote" && !unified.remote.ok) {
              lastFailDetail = unified.remote.detail || unified.remote.reason || "remote_fail";
              if (attempt >= maxAttempts) {
                throw new Error(
                  `回放第三方验证码失败（已试 ${maxAttempts} 次）：${lastFailDetail}（升 HITL，禁止编造）`,
                );
              }
              continue;
            }
            if (unified.kind === "slider") {
              cleanupCaptchaArtifacts(unified.slider.artifactPaths, logger);
              if (unified.slider.verified === true) {
                captchaPassed = true;
                stepOkMessage = `滑块已通过（第 ${attempt} 次）`;
                break;
              }
              lastFailDetail = unified.slider.verifySignal || "slider_not_verified";
              if (attempt >= maxAttempts) {
                throw new Error(
                  `回放滑块验证未通过（已试 ${maxAttempts} 次：${lastFailDetail}；需人工重试）`,
                );
              }
              continue;
            }
            if (unified.kind === "point") {
              if (unified.point.verified === true) {
                captchaPassed = true;
                stepOkMessage = `点选已通过（第 ${attempt} 次）`;
                break;
              }
              lastFailDetail = unified.point.verifySignal || "point_not_verified";
              if (attempt >= maxAttempts) {
                throw new Error(
                  `回放点选验证未通过（已试 ${maxAttempts} 次：${lastFailDetail}；需人工重试）`,
                );
              }
              continue;
            }
            if (unified.kind === "pressHold") {
              if (unified.pressHold.strategy === "unsupported") {
                throw new Error(
                  `回放长按策略未命中：${unified.pressHold.detail || "unsupported"}（需人工；禁止编造）`,
                );
              }
              if (unified.pressHold.verified === true) {
                captchaPassed = true;
                stepOkMessage = `长按已通过（第 ${attempt} 次）`;
                break;
              }
              lastFailDetail =
                unified.pressHold.verifySignal || unified.pressHold.detail || "press_hold_not_verified";
              if (attempt >= maxAttempts) {
                throw new Error(
                  `回放长按验证未通过（已试 ${maxAttempts} 次：${lastFailDetail}；页面可能仍在「按住」人机验证，需人工过码）`,
                );
              }
              continue;
            }
            // imageText / math / remote ok：无强 verified 时靠收尾闸拦；本步视为已执行
            captchaPassed = true;
            stepOkMessage = attempt > 1 ? `验证码步骤完成（第 ${attempt} 次）` : undefined;
            break;
          }
          if (!captchaPassed) {
            throw new Error(
              `回放验证码未通过（已试 ${maxAttempts} 次：${lastFailDetail || "unknown"}；需人工）`,
            );
          }
          await settleAfterStateChange(page, step, signal);
          usedFeatureSettle = true;
          break;
        }
        case "wait_for_page":
        case "switch": {
          const rawTarget = String(step.url ?? step.value ?? "").trim();
          if (!rawTarget) {
            throw new Error("wait_for_page 缺少目标 URL");
          }
          const target = applyOverridePairsToText(rawTarget, navigateRewritePairs);
          const needle = postConditionUrlNeedle(target);
          // 先看已有标签是否已在目标（保留 hash）
          const pages = page.context().pages();
          let matched = pages.find((p) => {
            try {
              const href = p.url();
              return href.includes(needle) || postConditionUrlNeedle(href).includes(needle);
            } catch {
              return false;
            }
          });
          if (matched && matched !== page) {
            await matched.bringToFront().catch(() => undefined);
            // 回放固定在当前标签机械执行：把目标 URL 拉到本页，避免后续步仍落在旧文档
            await withAbort(signal, safeGoto(page, matched.url(), { softNetworkIdle: false }));
          } else if (!matched) {
            await withAbort(signal, safeGoto(page, target, { softNetworkIdle: false }));
          }
          await withAbort(
            signal,
            softSettleAfterNavigation(page, {
              softNetworkIdle: false,
              domTimeoutMs: 2_500,
            }),
          );
          await settleAfterStateChange(page, step, signal);
          usedFeatureSettle = true;
          break;
        }
        case "download": {
          throw new Error(
            "本轨迹含下载步：机械回放不会自动下载文件。请改用 Agent 完成下载，或去掉下载相关步骤后再批量回放。",
          );
        }
        case "user_success":
        case "done": {
          // 用户标记的成功终点：正常结束回放，不再执行后续步
          emit?.({ step: stepNo, type, selector: "", status: "ok", message: "用户标记成功 · 回放结束" });
          log.ok(`step ${stepNo} [user_success] 回放在此结束`);
          await settleBeforeAiHandoff(page, signal);
          return { ok: true, completedSteps: index + 1 };
        }
        default:
          throw new Error(`不支持的动作类型: ${type || "(empty)"}`);
      }

      // 用户规则 must_click 台账：真正点成功了才记（跳过的中间 click 不记）
      if (
        (type === "click" || type === "click_point") &&
        !skippedOptionalClick &&
        options?.onClickStep
      ) {
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

      emit?.({
        step: stepNo,
        type,
        selector: validSelector || selector,
        status: "ok",
        message: stepOkMessage,
      });
      log.ok(
        stepOkMessage
          ? `step ${stepNo} [${type}] 完成 · ${stepOkMessage}`
          : `step ${stepNo} [${type}] 完成`,
      );
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
