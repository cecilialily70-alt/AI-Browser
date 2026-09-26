import { randomUUID } from "node:crypto";
import type { Frame, Page } from "playwright-core";
import { resolveGateway } from "../core/action_gateway.js";
import type { OmniActionGateway } from "../core/action_gateway.js";
import { preciseClick } from "../core/precise_click.js";
import { isContentPageUrl } from "../core/url_match.js";
import {
  NO_OFFSET,
  describeFrameFailure,
  frameVisibleBox,
  resolveElementScope,
  type DomScope,
  type FrameOffset,
} from "../core/dom_scope.js";
import { describeCompanionHint } from "../core/target_affinity.js";
import {
  defineFailure,
  failureTargetKey,
  type ActionFailureKind,
  type FailureLedger,
} from "../core/action_feedback.js";
import { applyObstaclePlan, resolveObstaclePlan } from "../core/obstacle_arbiter.js";
import {
  describeFillVerification,
  isTruncatedTailLoss,
  maskSensitive,
  readFieldSnapshot,
  verifyFill,
  type FieldSnapshot,
  type FillVerification,
} from "../core/fill_verify.js";
import { checkElementFreshness } from "../core/element_freshness.js";
import {
  ELEMENT_HEAL_MAX_ATTEMPTS,
  healByFingerprint,
} from "../element_heal.js";
import { createSelectorMap } from "./browser_state.js";
import { describeAvailableTabs, resolveTab, tabIdOf, tabPosition } from "./tab_registry.js";
import {
  VISION_RELOCATE_CONFIG,
  visionRelocateTarget,
} from "../core/vision_relocate.js";
import {
  annotateUnverified,
  classifyGoalIntent,
  consumeChannelEmailOtp,
  consumeChannelSmsOtp,
  evaluateCompletion,
  goalDemandsHumanPayment,
  isPaymentSubmitLabel,
  loadCompletionLexicon,
  scanPageSignals,
  stashChannelEmailOtp,
  stashChannelSmsOtp,
  type CompletionVerdict,
} from "../core/completion_evidence.js";
import {
  describeHits,
  guardUserConstraints,
  noteTaskRuleClick,
  type TaskRulesRuntime,
} from "../core/task_rules.js";
import { decideHitlConfirm, type HitlPolicyDecision } from "../core/hitl_policy.js";
import { elementsFromSelectorMap, resolveHitlAiCopy } from "../core/hitl_copy_resolve.js";
import {
  classifyNavigationPolicy,
  isEngineHomepageUrl,
} from "../core/page_policy.js";
import { verifyDeliverables, deniedVerdicts, uncertainVerdicts } from "../core/deliverable_verify.js";
import {
  isUnrequestedDeliverable,
  listDeliverables,
  listPendingDeliverables,
  markDeliverableSatisfied,
  waiveDeliverable,
  type DeliverableLedger,
  type DeliverableSpec,
  type PendingDeliverable,
} from "./task_contract.js";
import { judgeDeliverable } from "./deliverable_judge.js";
import {
  classifyHumanCredentialKind,
  findPendingHumanCredentials,
  isEmailOtpChannelEligible,
  isHumanCredentialValueAuthorized,
  isSmsOtpChannelEligible,
  matchesChannelResolvedOtp,
} from "../core/human_credential.js";
import {
  fetchEmailOtp,
  fetchSmsOtp,
  isOtpChannelConfigured,
  isSmsOtpServiceConfigured,
  parseOtpChannel,
  parseSmsOtpService,
  readWebmailInboxPage,
} from "../otp/index.js";
import { beginAgentLlmWait, createLlmClient } from "../ai_client.js";
import { scrapePageData, downloadMediaFromUrl, downloadStaticMedia, downloadTriggeredFile } from "../tools/scraper_engine.js";
import { listContentMediaUrls } from "./content_media.js";
import { visionLocateAndClick, clickViewportPercent } from "../page_vision_locate.js";
import {
  createModelRouter,
  isIntentConfigured,
  isVisualModelNotConfiguredError,
} from "../ai_model_router.js";
import { CONFIRM_SKIP_THRESHOLD } from "../agent_confidence.js";
import { PAGE_PIPELINE_CONFIG } from "../page_pipeline/config.js";
import { registerAction, getActionHandler, type ActionContext } from "./registry.js";
import { extractPageReading, formatPageReadingForLlm } from "../page_read.js";
import { summarizeCurrentPage } from "../core/page_summary.js";
import { captureScreenshot } from "../core/safe_screenshot.js";
import { PLAN_TOOL_NAME, readPlanCommand } from "./plan_expects.js";
import { registerSkillMetaActions } from "./skills/index.js";
import {
  checkCaptchaOutcome,
  refreshCaptchaMedia,
  readCaptchaFingerprint,
  noteCaptchaAttempt,
  resetCaptchaAttempts,
  getCaptchaAttempts,
  CAPTCHA_MAX_ATTEMPTS,
} from "./animated_captcha.js";
import {
  solveCaptcha,
  cleanupCaptchaArtifacts,
} from "./captcha_dispatch.js";
import { findIndexByTextHint } from "./captcha_form_hints.js";
import { sleep } from "./captcha_utils.js";
import {
  armBrowserRestart,
  disarmBrowserRestart,
  getAgentCdpUrl,
  reconnectAgentBrowser,
  requestHostBrowserRestart,
  waitForBrowserRestartCycle,
} from "../browser_session.js";
import type { ActionResult, IndexedElementRef } from "./views.js";

const VISION_CAPABILITY_ERROR =
  "当前需要视觉定位（图标/图片入口），但未配置视觉模型（vision）。" +
  "请到「设置 → AI」填写视觉模型后重试。禁止用 ask_user 猜测要点哪个图标。";

const SCREENSHOT_CAPABILITY_ERROR =
  "需要截图才能继续，但当前无法获取页面截图。请确认浏览器可用；若仍失败，请开启 Agent 截图能力并配置视觉模型后重试。";

function isVisualTargetQuestion(text: string): boolean {
  const q = String(text ?? "").trim();
  // 验证码/读码类 HITL：允许 ask_user（勿因含「图片」误拦）
  if (
    /验证码|captcha|识别.*码|码是什么|填写验证|读出|字母数字/i.test(q) &&
    !/点哪|点击哪|哪个图标|点哪个/i.test(q)
  ) {
    return false;
  }
  // 仅拦截「要点哪个图标/语言入口」类空转提问
  return (
    /点哪|点击哪|点哪个|哪个图标|哪一个图标|语言球|客服图标/i.test(q) ||
    (/(图标|语言入口|地球|国旗|locale|hebrew)/i.test(q) &&
      /哪个|哪一个|点哪|点击|定位/i.test(q))
  );
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * 按选择器读「原样值」：优先输入类控件的 value，其次渲染文本（innerText），最后 textContent。
 * 读不到就返回空数组 —— 由调用方决定是「报缺失」还是「失败」，这里**绝不**编造兜底值。
 */
async function readSelectorValues(
  page: Page,
  selector: string,
  attr: string,
  all: boolean,
): Promise<string[]> {
  const loc = page.locator(selector);
  let count = 0;
  try {
    count = await loc.count();
  } catch {
    return [];
  }
  if (count === 0) {
    return [];
  }
  const limit = all ? Math.min(count, 50) : 1;
  const out: string[] = [];
  for (let i = 0; i < limit; i++) {
    const el = loc.nth(i);
    if (attr) {
      const value = await el.getAttribute(attr).catch(() => null);
      out.push(value == null ? "" : value);
      continue;
    }
    const inputValue = await el.inputValue({ timeout: 1_000 }).catch(() => null);
    if (inputValue != null) {
      out.push(inputValue);
      continue;
    }
    const text = await el.innerText({ timeout: 1_000 }).catch(() => null);
    if (text != null) {
      out.push(text);
      continue;
    }
    const fallback = await el.textContent({ timeout: 1_000 }).catch(() => null);
    out.push(fallback == null ? "" : fallback);
  }
  return out;
}

function elementLabelBlob(el: {
  text?: string;
  placeholder?: string;
  name?: string;
  role?: string;
  tagName?: string;
  inputType?: string | null;
}): string {
  return [el.text, el.placeholder, el.name, el.role, el.tagName, el.inputType ?? ""]
    .filter(Boolean)
    .join(" ");
}

/** Playwright 选择器：xpath 路径必须带 xpath= 前缀，否则会被当 CSS 解析失败 */
function elementPlaywrightSelector(el: {
  selector: string;
  xpath?: string;
}): string {
  const xp = String(el.xpath ?? "").trim();
  if (xp) return xp.startsWith("xpath=") ? xp : `xpath=${xp}`;
  const sel = String(el.selector ?? "").trim();
  if (!sel) return sel;
  if (sel.startsWith("xpath=") || sel.startsWith("css=") || sel.startsWith("text=")) return sel;
  if (sel.startsWith("/") || sel.startsWith("(") || sel.startsWith("./")) {
    return `xpath=${sel}`;
  }
  return sel;
}

function hitlDeniedMessage(
  kind: "click" | "fill",
  level: HitlPolicyDecision["level"],
): string {
  if (level === "critical") {
    return kind === "click"
      ? "用户取消支付/不可逆确认：本动作失败。禁止换说法重试同一支付动作；购物/订票合法终态为 awaiting_human_payment（停在支付前），不得 done(success=true) 冒充已付款。"
      : "用户取消支付字段填写确认：本动作失败。禁止换说法重试同一 critical 填写；支付 critical 永不自动填。";
  }
  return kind === "click" ? "用户取消点击确认" : "用户取消填写确认";
}

/**
 * 任务级 HITL 判定（替代旧的关键词拦截）。
 * 返回判定结果与用户可见的确认理由；未命中风险则返回 null（不需要确认）。
 */
function resolveHitlDecision(
  ctx: ActionContext,
  kind: "fill" | "click" | "select",
  label: string,
  value?: string,
  element?: {
    role?: string;
    inputType?: string | null;
    name?: string;
    selector?: string;
  } | null,
): HitlPolicyDecision | null {
  const decision = decideHitlConfirm({
    kind,
    label,
    value,
    goal: ctx.goal ?? "",
    // 页面上下文只用于「引擎首页搜索豁免」：拿**当前**地址（而不是观察快照），
    // 否则点击发生在导航之后时会拿着旧 URL 判"是不是引擎首页"。
    page: {
      url: ctx.page.url() || ctx.browserState?.url || "",
      role: element?.role,
      inputType: element?.inputType,
      name: element?.name,
      selector: element?.selector,
    },
  });
  if (!decision.confirm) {
    if (decision.level !== "none") {
      // 放行也要留痕：便于排查「为什么这次没拦」
      ctx.logger.agentProgress?.(`HITL 放行（${decision.level}）：${decision.reason}`, {
        phase: "hitl",
        level: decision.level,
        matched: decision.matched,
        goalMatched: decision.goalMatched,
      });
    }
    return null;
  }
  return decision;
}

function ok(content: string, extra?: Partial<ActionResult>): ActionResult {
  return { extractedContent: content, longTermMemory: content, success: true, ...extra };
}

/** 总结报告的落盘文件名（纯文件名；AgentFileSystem 会再取 basename 安全化） */
function reportFileName(snapshot: { host: string; title: string }): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base =
    (snapshot.host || snapshot.title || "page")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "page";
  return `page-summary-${base}-${stamp}.md`;
}

/**
 * 把带前缀的 Playwright 选择器拆成 CSS / xpath（精确命中解析需要分开传）
 */
function splitPlaywrightSelector(raw: string): { selector: string; xpath: string } {
  const value = String(raw ?? "").trim();
  if (value.startsWith("xpath=")) return { selector: "", xpath: value.slice("xpath=".length) };
  if (value.startsWith("css=")) return { selector: value.slice("css=".length), xpath: "" };
  if (value.startsWith("/") || value.startsWith("(") || value.startsWith("./")) {
    return { selector: "", xpath: value };
  }
  return { selector: value, xpath: "" };
}

/** 勾选类控件需要「点击后验证勾选态」，普通按钮不需要 */
function inferClickExpectation(el: IndexedElementRef): "auto" | "check" {
  const inputType = String(el.inputType ?? "").toLowerCase();
  const role = String(el.role ?? "").toLowerCase();
  if (inputType === "checkbox" || inputType === "radio") return "check";
  if (role === "checkbox" || role === "radio" || role === "switch") return "check";
  return "auto";
}

/**
 * 带 aria-haspopup 的控件：点一下常常只是聚焦，列表要再点才展开。
 * 返回 open / closed；不是这种控件则 not-popup（普通按钮不走这条）。
 */
async function popupDisclosureState(
  scope: DomScope,
  playwrightSelector: string,
): Promise<"open" | "closed" | "not-popup"> {
  if (!playwrightSelector) return "not-popup";
  try {
    return await scope.locator(playwrightSelector).first().evaluate((node) => {
      const el = node as HTMLElement;
      const popup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
      const role = (el.getAttribute("role") || "").toLowerCase();
      const tag = el.tagName;
      const declaresPopup =
        popup === "listbox" ||
        popup === "menu" ||
        popup === "true" ||
        popup === "dialog" ||
        (role === "combobox" && tag !== "INPUT" && tag !== "TEXTAREA");
      if (!declaresPopup) return "not-popup";
      const visible = (candidate: Element | null) => {
        if (!candidate) return false;
        const style = getComputedStyle(candidate);
        const rect = (candidate as HTMLElement).getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
      };
      if (el.getAttribute("aria-expanded") === "true") return "open";
      const owned = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      if (visible(owned ? el.ownerDocument.getElementById(owned) : null)) return "open";
      const lists = el.ownerDocument.querySelectorAll('[role="listbox"], [role="menu"]');
      for (const list of lists) {
        if (visible(list)) return "open";
      }
      return "closed";
    });
  } catch {
    return "not-popup";
  }
}

/** 下拉没展开就在同一次动作里再点，最多共 3 下；仍没展开则不算成功。 */
async function ensurePopupOpened(
  scope: DomScope,
  playwrightSelector: string,
): Promise<"open" | "closed" | "not-popup"> {
  let state = await popupDisclosureState(scope, playwrightSelector);
  for (let extra = 0; extra < 2 && state === "closed"; extra += 1) {
    try {
      await scope.locator(playwrightSelector).first().click({ timeout: 2_000 });
    } catch {
      break;
    }
    await scope.waitForTimeout(200);
    state = await popupDisclosureState(scope, playwrightSelector);
  }
  return state;
}

/**
 * 替代写法：聚焦 + 全选 + 逐字输入（应对受控组件 / 热键吞键 / 框架 value tracker）。
 * 与主路径同样是「不依赖站点选择器」的通用手法；始终按整体覆盖语义写入。
 */
async function retryFieldWrite(
  page: DomScope,
  target: { selector: string; xpath: string },
  value: string,
): Promise<void> {
  const playwrightSelector = target.xpath ? `xpath=${target.xpath}` : target.selector;
  if (!playwrightSelector) return;
  const locator = page.locator(playwrightSelector).first();
  await locator.click({ timeout: 5_000 }).catch(() => undefined);
  await locator.press("Control+a", { timeout: 5_000 }).catch(() => undefined);
  await locator.press("Backspace", { timeout: 5_000 }).catch(() => undefined);
  if (value.length > 0) {
    await locator.pressSequentially(value, { delay: 30, timeout: Math.max(8_000, value.length * 60) });
  }
}

/** 回读轮询次数 / 间隔：只用来吸收「值还没落到 DOM」的提交延迟，不掩盖真实失败 */
const FILL_READBACK_TRIES = 4;
const FILL_READBACK_DELAY_MS = 120;

/**
 * 带短轮询的字段回读。
 *
 * 为什么不能只读一次：受控组件 / 防抖重渲染 / 站点自己的格式化钩子会让值晚一步才进 DOM，
 * 瞬时读取会得到 empty —— 于是运行时"为了保险"再清空重写一次，用户看到的就是
 * 「输入框被清空后又重新打了一遍」。轮询只吸收这点提交延迟（毫秒级），
 * 真没写进去的字段照样判 empty，不会因为等待而放行假成功。
 */
async function readFieldSettled(
  page: DomScope,
  target: { selector: string; xpath: string },
  options: { before: FieldSnapshot | null; append: boolean; text: string },
): Promise<FillVerification> {
  let verification = verifyFill(await readFieldSnapshot(page, target).catch(() => null), options);
  for (let i = 1; i < FILL_READBACK_TRIES; i += 1) {
    if (verification.verdict === "ok") break;
    const expected = verification.expected;
    const stillLost =
      verification.verdict === "empty" || isTruncatedTailLoss(expected, verification.actual);
    // 站点格式化（mismatch 但内容确实在）不需要等：等到天荒地老它也不会变成期望值
    if (!stillLost) break;
    await sleep(FILL_READBACK_DELAY_MS);
    verification = verifyFill(await readFieldSnapshot(page, target).catch(() => null), options);
  }
  return verification;
}

/**
 * 元素所在文档 + 物理坐标换算所需的全部上下文。
 * 主文档：scope = page，offset = 0；嵌套框架：scope = frame，offset = 框架左上角。
 */
interface ElementDocument {
  scope: DomScope;
  offset: FrameOffset;
  /** 框架在主文档视口里的矩形；主文档为 null */
  box: { x: number; y: number; w: number; h: number } | null;
  /** 框架自身的可见盒子（框架局部坐标）；主文档为 null */
  frameVisible: { w: number; h: number } | null;
  frameUrl: string | null;
}

/**
 * 解析元素所在文档。
 *
 * 索引的 selector/xpath 都是**元素所在文档内**的相对路径：主文档元素在主文档里找，
 * iframe 元素必须回到那个 iframe 里找。此前整条执行链只认主文档，导致观察层列出的
 * iframe 控件「看得见、点不着」—— 这一层就是把这个断层补上。
 *
 * 框架已不可用（跨域 / 已卸载）时**不猜、不硬点**：返回结构化失败，让模型拿到可执行路径。
 */
async function resolveElementDocument(
  ctx: ActionContext,
  el: IndexedElementRef,
): Promise<{ doc: ElementDocument } | { fail: ActionResult }> {
  const frameUrl = el.frameUrl ?? null;
  if (!frameUrl) {
    return { doc: { scope: ctx.page, offset: NO_OFFSET, box: null, frameVisible: null, frameUrl: null } };
  }
  const resolved = await resolveElementScope(ctx.page, frameUrl);
  if (resolved.failure) {
    return {
      fail: failKind(ctx, {
        kind: "frame-missing",
        action: "resolve-frame",
        targetKey: failureTargetKey("selector", frameUrl),
        message: describeFrameFailure(resolved.failure, frameUrl),
        evidence: { frameUrl, reason: resolved.failure },
      }),
    };
  }
  const frame = resolved.scope === ctx.page ? null : (resolved.scope as Frame);
  return {
    doc: {
      scope: resolved.scope,
      offset: resolved.offset,
      box: resolved.box,
      frameVisible: frame ? await frameVisibleBox(frame) : null,
      frameUrl,
    },
  };
}

/**
 * 动作执行前的索引新鲜度闸门：过期索引直接失败并给出重新观察指引，
 * 避免「点错元素 / 点空气却回报成功」。 */
async function guardStaleIndex(
  ctx: ActionContext,
  el: IndexedElementRef,
  index: number,
  scope: DomScope = ctx.page,
): Promise<ActionResult | null> {
  const target = splitPlaywrightSelector(elementPlaywrightSelector(el));
  if (!target.selector && !target.xpath) return null;
  const report = await checkElementFreshness(scope, target, {
    tagName: el.tagName,
    text: el.text,
    placeholder: el.placeholder,
    semanticLabel: el.text,
  });
  if (report.verdict === "missing" || report.verdict === "tag-changed") {
    ctx.logger.agentProgress?.(`索引过期：[${index}] ${el.text ?? ""} — ${report.note}`, {
      phase: "stale_index",
      verdict: report.verdict,
      actualTag: report.actualTag,
      actualText: report.actualText,
    });
    return failKind(ctx, {
      kind: "stale-index",
      action: "index-freshness",
      targetKey: failureTargetKey("index", index),
      message: `无效/过期 index ${index}：${report.note}`,
      evidence: {
        index,
        verdict: report.verdict,
        actualTag: report.actualTag,
        actualText: report.actualText,
      },
      extraMetadata: { staleIndex: report.verdict, actualTag: report.actualTag },
    });
  }
  if (report.verdict === "text-drift") {
    ctx.logger.agentProgress?.(`索引文案漂移：[${index}] ${report.note}`, {
      phase: "stale_index",
      verdict: report.verdict,
    });
  }
  return null;
}

/**
 * P4.1：stale 时按指纹静默重查（≤2），成功则就地修补 selector/xpath，对模型透明。
 * 返回 true = 已愈，调用方继续原动作；false = 未愈，交给 vision_relocate / 原失败。
 *
 * 安全红线：找不到唯一高置信匹配时绝不猜，避免盲点错误 index。
 */
async function tryFingerprintHealOnStale(
  ctx: ActionContext,
  el: IndexedElementRef,
  index: number,
  scope: DomScope,
): Promise<boolean> {
  const fingerprint = el.fingerprint;
  if (!fingerprint?.tagName) return false;

  ctx.logger.agentProgress?.(`索引过期，按元素指纹静默重查 [${index}]…`, {
    phase: "element_heal",
    index,
    maxAttempts: ELEMENT_HEAL_MAX_ATTEMPTS,
  });

  const healed = await healByFingerprint(scope, fingerprint, {
    maxAttempts: ELEMENT_HEAL_MAX_ATTEMPTS,
  });
  if (!healed) {
    ctx.logger.agentProgress?.(`指纹自愈未命中唯一目标 [${index}]，改交视觉重定位`, {
      phase: "element_heal",
      index,
      healed: false,
    });
    return false;
  }

  // 就地修补：同一 index 对象更新 locator，后续 preciseClick / fill 用新路径
  el.selector = healed.selector || el.selector;
  el.xpath = healed.xpath || el.xpath;
  if (healed.tagName) el.tagName = healed.tagName;
  // 指纹里的 locator 同步成新值，避免同一步二次 stale 仍拿旧路径
  el.fingerprint = {
    ...fingerprint,
    selector: healed.selector || fingerprint.selector,
    xpath: healed.xpath || fingerprint.xpath,
    tagName: healed.tagName || fingerprint.tagName,
  };

  const recheck = await checkElementFreshness(
    scope,
    { selector: el.selector, xpath: el.xpath },
    {
      tagName: el.tagName,
      text: el.text,
      placeholder: el.placeholder,
      semanticLabel: el.text,
    },
  );
  if (recheck.verdict === "missing" || recheck.verdict === "tag-changed") {
    ctx.logger.agentProgress?.(
      `指纹自愈后仍未通过新鲜度校验 [${index}]：${recheck.note}`,
      { phase: "element_heal", index, healed: false, verdict: recheck.verdict },
    );
    return false;
  }

  ctx.logger.agentProgress?.(
    `指纹自愈成功：[${index}] 已重连（第 ${healed.attempt} 次，分 ${healed.score}）`,
    {
      phase: "element_heal",
      index,
      healed: true,
      attempt: healed.attempt,
      score: healed.score,
      selector: healed.selector,
    },
  );
  return true;
}

/**
 * stale 自救链：指纹重连 →（失败）视觉重定位 →（再失败）原 stale 失败。
 * click / input 共用，避免两条路径漂移。
 */
async function recoverFromStaleIndex(
  ctx: ActionContext,
  input: {
    index: number;
    el: IndexedElementRef;
    scope: DomScope;
    stale: ActionResult;
    reason: string;
    action: "click" | "input";
    params: Record<string, unknown>;
  },
): Promise<ActionResult | "healed"> {
  const healed = await tryFingerprintHealOnStale(ctx, input.el, input.index, input.scope);
  if (healed) return "healed";
  const relocated = await tryVisionRelocateOnInvalidIndex(ctx, {
    index: input.index,
    el: input.el,
    reason: input.reason,
    action: input.action,
    params: input.params,
  });
  return relocated ?? input.stale;
}

/**
 * 遮挡预检：坐标点击没有 DOM 目标，只能按「点被层覆盖 + 点不在层内对话框/控件上」判定，
 * 命中则先用词典仲裁清障，返回是否清障成功供日志说明。
 */
async function clearOverlayOverPoint(
  page: DomScope,
  point: { x: number; y: number },
  offset: FrameOffset = NO_OFFSET,
): Promise<{ cleared: boolean; detail: string }> {
  try {
    const resolution = await resolveObstaclePlan(page, point);
    if (!resolution.plan) return { cleared: false, detail: resolution.reason };
    const applied = await applyObstaclePlan(page, resolution.plan, point, offset);
    const actor = resolution.plan.control?.name ?? resolution.plan.label;
    return applied.ok
      ? { cleared: true, detail: `${actor}（${applied.method}）` }
      : { cleared: false, detail: `${actor} 清障失败：${applied.detail}` };
  } catch (err) {
    return { cleared: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 索引取不到时的失败说明：降级观察下必须点明「本轮没有控件索引」，
 * 否则模型会把「无效 index」误读成自己数错号，反复重试同一个 index。
 */
function failMissingIndex(ctx: ActionContext, index: number): ActionResult {
  const quality = ctx.browserState.observationQuality;
  if (quality && quality.mode !== "full") {
    return failKind(ctx, {
      kind: "unsupported",
      action: "resolve-index",
      targetKey: failureTargetKey("index", index),
      message:
        `无效 index ${index}：本轮为${quality.mode === "degraded-text" ? "降级观察（只有正文，无控件索引）" : "不可用观察"}。` +
        `请改用正文/截图判断、scroll/read 重读、request_vision 视觉定位或 navigate；下一轮会自动重试完整观察。`,
      evidence: { index, observationQuality: quality.mode },
    });
  }
  return failKind(ctx, {
    kind: "target-missing",
    action: "resolve-index",
    targetKey: failureTargetKey("index", index),
    message: `无效 index: ${index}`,
    evidence: { index },
  });
}

/* ─────────────────────── P2 视觉自愈：index 失效就地找回目标 ─────────────────────── */

/** 每步允许的视觉重定位次数：一次足够；再多只会变成另一种「无脑重试」（可配置） */
export const VISION_RELOCATE_MAX_PER_STEP = PAGE_PIPELINE_CONFIG.visionRelocateMaxPerStep;

/** 失效目标的语义线索：类型 + 文案。同名链接 ≠ 同名勾选框，两者都必须给视觉模型 */
function relocationHint(el: IndexedElementRef): { text: string; kind: string | null } {
  const kind = String(el.inputType ?? el.role ?? el.tagName ?? "").trim() || null;
  const text = String(el.text ?? el.name ?? el.placeholder ?? "").trim();
  return { text: text || `[${el.tagName || "element"}]`, kind };
}

/**
 * index 失效（不存在 / 已过期）时的自救：让视觉模型在当前画面里把目标**按编号找回来**。
 *
 * 触发条件（全部满足才动手，避免把「顺手重试」变成新的噪声源）：
 *   - 有失效目标的语义线索（拿不到线索就是无从找起，交给原失败路径让模型重新观察）；
 *   - 配了视觉模型（没配就不产生任何请求与副作用）；
 *   - 本步重定位预算还有（默认 1 次）。
 *
 * 找回后的执行**不走旁路**：刷新索引空间 → 用新 index 重放同一个动作
 * （新鲜度守卫、遮挡仲裁、命中点测试、状态回读全部照旧生效）。
 *
 * 返回 null = 没能力重定位，调用方照原样返回失败。
 */
async function tryVisionRelocateOnInvalidIndex(
  ctx: ActionContext,
  input: {
    index: number;
    el: IndexedElementRef | null;
    reason: string;
    action: "click" | "input";
    params: Record<string, unknown>;
  },
): Promise<ActionResult | null> {
  if (!PAGE_PIPELINE_CONFIG.visionRelocate) return null;
  if (!input.el) return null;
  const budget = ctx.relocationBudget;
  if (!budget || budget.left <= 0) return null;
  const router = createModelRouter(ctx.aiSettings);
  if (!isIntentConfigured(router.pool, "vision")) return null;

  budget.left -= 1;
  const hint = relocationHint(input.el);
  ctx.logger.agentProgress?.(
    `索引失效，改用视觉重定位找回「${hint.text}」…`,
    { phase: "vision_relocate", index: input.index, kind: hint.kind, reason: input.reason },
  );

  let relocated;
  try {
    relocated = await visionRelocateTarget({
      page: ctx.page,
      targetText: hint.text,
      targetKind: hint.kind,
      previousIndex: input.index,
      goal: ctx.goal ?? "",
      aiSettings: ctx.aiSettings,
      logger: ctx.logger,
      signal: ctx.signal,
      maxCandidates: VISION_RELOCATE_CONFIG.maxCandidates,
    });
  } catch (err) {
    ctx.logger.warn?.("vision_relocate_crashed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (relocated.applied === "point") {
    ctx.failures?.settle(failureTargetKey("index", input.index));
    return ok(
      `[${input.index}] ${hint.text} 的 index 已失效（${input.reason}）。${relocated.detail}。` +
        "已按视觉坐标点击，请用截图/正文核对结果；若未生效请重新观察后再决定下一步。",
      {
        metadata: {
          relocated: { from: input.index, to: null, applied: "point" },
          indexSpaceRefreshed: relocated.source != null,
        },
      },
    );
  }

  if (!relocated.ok || relocated.index == null || !relocated.source) {
    return failKind(ctx, {
      kind: "stale-index",
      action: input.action,
      targetKey: failureTargetKey("index", input.index),
      message:
        `[${input.index}] ${hint.text} 已失效（${input.reason}），视觉重定位也没找回该目标：` +
        `${relocated.detail}。请重新观察页面后按新 index 选择目标。`,
      evidence: { index: input.index, relocated: false, candidates: relocated.candidates },
      extraMetadata: { relocated: { from: input.index, to: null, applied: "none" } },
    });
  }

  // 刷新索引空间：新编号必须真的能解析，否则重放会在同一个坑里再摔一次
  const freshMap = createSelectorMap(relocated.source);
  if (freshMap.size === 0) {
    return failKind(ctx, {
      kind: "stale-index",
      action: input.action,
      targetKey: failureTargetKey("index", input.index),
      message: `[${input.index}] ${hint.text} 已失效，视觉重定位拿到的新编号无法解析为元素，请重新观察。`,
      evidence: { index: input.index, relocated: false },
    });
  }
  ctx.browserState.selectorMap = freshMap;
  ctx.browserState.elementCount = freshMap.size;

  const newIndex = relocated.index;
  const handler = getActionHandler(input.action);
  if (!handler) {
    return fail(`内部错误：${input.action} 处理器未注册`);
  }
  const replayParams: Record<string, unknown> = { ...input.params, index: newIndex };
  let replayed: ActionResult;
  try {
    replayed = await handler(replayParams, ctx);
  } catch (err) {
    replayed = fail(
      `${input.action} 重放失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  ctx.failures?.settle(failureTargetKey("index", input.index));

  const prefix =
    `原 index [${input.index}]（${hint.text}）已失效，视觉重定位到 [${newIndex}]：` +
    `${relocated.description || hint.text}（置信 ${relocated.confidence.toFixed(2)}）。`;
  const meta = {
    ...(replayed.metadata ?? {}),
    relocated: { from: input.index, to: newIndex, applied: "index" },
    // 索引空间已换：主循环据此强制下一步重新观察（否则模型手里的旧编号会与新映射错位）
    indexSpaceRefreshed: true,
  };
  if (replayed.error) {
    return {
      ...replayed,
      error: `${prefix}但重放同一动作仍失败：${replayed.error}`.slice(0, 600),
      metadata: meta,
    };
  }
  return {
    ...replayed,
    extractedContent: `${prefix}${replayed.extractedContent ?? ""}`,
    longTermMemory: `${prefix}${replayed.longTermMemory ?? ""}`,
    metadata: meta,
  };
}

/**
 * 一次性凭证闸门（Human-Only Credential Gate）
 *
 * 用户报障：「遇到输入邮箱验证码的时候直接完成了任务」。根因不是模型不会问，而是
 * **没人拦住它不问** —— 提示词里的「必须 ask_user」只是契约，运行时没有任何硬闸。
 *
 * 这里的判定完全结构化：观察层已经把「值只可能在用户本人手上」的字段标了出来（human_only），
 * 只要当前页面还留着一个**空的**这类字段，而用户目标又是「结果型」（真要完成一件事），
 * 那么 `done(success=true)` 一律不成立 —— 顺带**弹一次人工接管**，把码的来源交给用户。
 *
 * 只弹一次（按 URL + 字段身份记账）：同一个验证码框不该反复打断用户；
 * 但「拒绝 done」这条硬闸不受次数限制 —— 没拿到码就不算完成，宁可任务停在这里等用户。
 */
async function guardPendingHumanCredential(ctx: ActionContext): Promise<ActionResult | null> {
  const pending = findPendingHumanCredentials(ctx.browserState.selectorMap.values());
  if (pending.length === 0) return null;
  // 信息型/通用型任务路过一个验证码框，不代表任务要求拿到它 —— 不拦
  if (classifyGoalIntent(ctx.goal, loadCompletionLexicon()) !== "outcome") return null;

  const target = pending[0]!;
  const others = pending.slice(1).map((item) => `[${item.index}] ${item.label}`);
  const ledger = ctx.evidence;
  const askKey = `${ctx.page.url()}::${target.label}`;
  const alreadyAsked = ledger?.humanHandoverKeys.has(askKey) === true;
  const userInvolved = ledger?.humanInvolved === true;
  const channelReady = isOtpChannelConfigured(parseOtpChannel(ctx.otpChannel));
  const smsService = parseSmsOtpService(ctx.smsOtpService);
  const smsReady = isSmsOtpServiceConfigured(smsService);
  const emailEligible = isEmailOtpChannelEligible(target.kind);
  const smsEligible = isSmsOtpChannelEligible(target.kind);
  if (ledger && !alreadyAsked) {
    ledger.humanHandoverKeys.add(askKey);
    // 阻塞式人工接管：用户可以在浏览器里直接把码填好；也可能关掉对话框把码告诉 Agent
    const reason =
      emailEligible && channelReady
        ? `页面要求填写「${target.label}」——这是${target.reason}。` +
          `已配置邮箱 OTP 通道时请先让 Agent 调用 fetch_email_otp；若通道失败或你更想自己填，请接管浏览器把码填好。`
        : smsEligible && smsReady
          ? `页面要求填写「${target.label}」——这是${target.reason}。` +
            `已启用短信接码平台时请先让 Agent 调用 fetch_sms_otp；若失败或你更想自己填，请接管浏览器把码填好。`
          : `页面要求填写「${target.label}」——这是${target.reason}，值只可能在你自己手上。` +
            `请接管浏览器把它填好（或关闭本框后把码发给 Agent，让它继续）。`;
    await ctx
      .requestHandover({
        requestId: randomUUID(),
        reason,
        url: ctx.page.url(),
      })
      .catch(() => undefined);
    ctx.logger.agentProgress?.(`一次性凭证待人工提供：[${target.index}] ${target.label} → 已弹人工接管`, {
      phase: "human_credential",
      reason: target.reason,
      kind: target.kind,
      index: target.index,
    });
  }
  const emailHint =
    emailEligible && channelReady
      ? "请先 fetch_email_otp（成功后会自动填入邮箱验证码字段）；失败再用 ask_user / handover。"
      : emailEligible
        ? "未配置邮箱 OTP 通道：请 ask_user 索取邮箱码，或 handover 让用户自己填；也可稍后在设置中配置通道。"
        : smsEligible && smsReady
          ? "请先 fetch_sms_otp（成功后会自动填入短信验证码字段）；失败再用 ask_user / handover。"
          : smsEligible
            ? "未启用短信接码平台：请 ask_user 索取短信码，或 handover；也可在设置中显式启用接码平台。"
            : "验证器码禁止自动猜测：请 ask_user 索取，或 handover 让用户自己填。";
  return failKind(ctx, {
    kind: "needs-human",
    action: "completion-gate",
    targetKey: failureTargetKey("index", target.index),
    message:
      `done 被驳回：页面上还有未填写的一次性凭证字段 [${target.index}] ${target.label}（${target.reason}；渠道=${target.kind}）。` +
      `这个值不能由 AI 编造，所以现在**不算完成**。` +
      (alreadyAsked ? "已为你弹过一次人工接管；" : "") +
      (userInvolved
        ? "用户参与过但该字段仍为空，请再次索取码值（拿到后 input 进去），或 handover 让用户自己填。"
        : emailHint) +
      (others.length ? `同时还有：${others.join("；")}。` : "") +
      `若确实拿不到，请用 done(success=false) 说明卡点。`,
    evidence: {
      index: target.index,
      humanOnly: target.reason,
      kind: target.kind,
      pending: pending.length,
    },
  });
}

/**
 * 完成度验收：把 done(success=true) 当成需要举证的命题。
 * 证据来自运行期台账（填写回读/勾选变化/跳转/内容提取）+ 当前页面文案信号。
 * 无台账（老调用路径/单测直接调 action）时退化为「只扫页面」的轻量判定，绝不因缺台账而卡死任务。
 */
/**
 * 交付物逐项闸门：done 之前必须**逐项**交代清楚。
 *
 * 为什么需要它：完成度证据闸门只会说「轨迹里没有可验证副作用」，
 * 但用户真正需要知道的是「还差哪一项」。契约（task_contract）就是那份清单：
 *   - 确定性验证器给出「确认未达成」→ 直接驳回，并点名这一项（最有说服力，且零成本）；
 *   - 判不出来（不确定）的项 → 用一次 llm_judge 闭合提问兜底（预算受限）；
 *   - 仍不确定 → 交给证据闸门，不在这里猜。
 *
 * 与证据闸门共用驳回预算：两者都不允许把任务卡成死循环，
 * 超限后由 done 统一放行并标注「未验证」（同时列出未核销的交付物）。
 */
async function guardPendingDeliverables(ctx: ActionContext, claim: string): Promise<ActionResult | null> {
  const ledger = ctx.deliverables;
  if (!ledger) return null;
  const pending = listPendingDeliverables(ledger);
  if (pending.length === 0) return null;
  // 与证据闸门共用驳回上限：超限即放行（由 done 统一标注「未验证」并列明未核销项），
  // 否则两个闸门会互相接力，把任务锁死在 done 循环里。
  const rejectBudget = loadCompletionLexicon()?.maxDoneRejections ?? 2;
  if (ctx.evidence && ctx.evidence.rejections >= rejectBudget) {
    ctx.logger.agentProgress("契约交付物仍未核销，但已到驳回上限 → 放行未验证", {
      phase: "deliverable_gate",
      forced: true,
      pending: pending.map((item) => item.spec.id),
    });
    return null;
  }

  const verdictContext = await buildVerifierContext(ctx, claim);
  const verdicts = verifyDeliverables(
    pending.map((item) => item.spec),
    verdictContext,
  );

  // 确定性已确认达成的项：立刻核销。否则 answer_given 会「验证通过却仍 pending」，
  // 完成度询问看到未核销清单就反复 no → 重规划（用户报障：总结写好了仍被打回）。
  for (const verdict of verdicts) {
    if (verdict.result.ok !== true) continue;
    if (
      markDeliverableSatisfied(
        ledger,
        verdict.spec.id,
        `${verdict.result.verifier}：${verdict.result.reason}`,
        0,
      )
    ) {
      ctx.logger.agentProgress(`交付物已核销：[${verdict.spec.id}] ${verdict.spec.text}`, {
        phase: "deliverable",
        verifier: verdict.result.verifier,
        reason: verdict.result.reason.slice(0, 160),
      });
    }
  }
  let stillPending = listPendingDeliverables(ledger);
  if (stillPending.length === 0) return null;

  /*
   * ⓪ 无要求项豁免（**结构事实**，不必攒次数）：目标**从未要求**的交付物
   * （信息型目标里的 navigation，见 task_contract 的 `isUnrequestedDeliverable`）
   * 不是「还没做到」，而是契约本身多出来的一笔债 —— 它永远不会变成已达成，
   * 拦下去只会让 done 被无限驳回、模型原地打转（用户现场：总结任务被 `[navigation#2]` 卡死）。
   *
   * 这一点在拿到契约的那一刻就成立，不需要等验证器表态：
   *   - `verifyNavigation` 对信息型目标返回「不确定」，它压根不会出现在「确定性否认」里，
   *     所以「攒够否认次数再豁免」对这种项是无效的（会把预算烧在无意义的兜底判定上）；
   *   - 正常路径下契约生成阶段已经丢弃它，这里兜的是遗留契约 / 重规划补出来的残余。
   */
  const goalIntent = classifyGoalIntent(ctx.goal, loadCompletionLexicon());
  const waivedIds = new Set<string>();
  for (const item of stillPending) {
    if (!isUnrequestedDeliverable(item.spec, goalIntent)) continue;
    waiveDeliverable(ledger, item.spec.id, `目标未要求（${item.spec.kind}），不作为硬闸`, 0);
    waivedIds.add(item.spec.id);
    ctx.logger.agentProgress(`交付物已豁免：[${item.spec.id}] ${item.spec.text}`, {
      phase: "deliverable_gate",
      kind: item.spec.kind,
      reason: "目标未要求该类交付（信息型目标的阅读对象即当前页），不再作为硬闸",
    });
  }
  if (waivedIds.size > 0) {
    stillPending = listPendingDeliverables(ledger);
    if (stillPending.length === 0) return null;
  }

  const denied = deniedVerdicts(verdicts).filter((v) =>
    stillPending.some((item) => item.spec.id === v.spec.id),
  );

  // ① 确定性否认：这是「确实没做」，直接驳回并点名
  if (denied.length > 0) {
    return rejectDeliverables(ctx, ledger, stillPending, {
      reasons: denied.map((v) => `[${v.spec.id}] ${v.spec.text} —— ${v.result.reason}`),
      uncertain: uncertainVerdicts(verdicts)
        .filter((v) => stillPending.some((item) => item.spec.id === v.spec.id))
        .map((v) => v.spec),
      judged: false,
    });
  }

  // ② 不确定项交给模型兜底判定（闭合提问，预算受限）
  const uncertain = uncertainVerdicts(verdicts).filter((v) =>
    stillPending.some((item) => item.spec.id === v.spec.id),
  );
  if (uncertain.length > 0 && ledger.judgementsLeft > 0) {
    const target = uncertain[0]!;
    ledger.judgementsLeft -= 1;
    const judged = await judgeDeliverable({
      deliverable: target.spec.text,
      kind: target.spec.kind,
      hints: target.spec.hints,
      goal: ctx.goal,
      currentUrl: ctx.page.url(),
      factLines: describeFactsForJudge(ctx),
      pageDigest: ctx.browserState?.pageDigest ?? undefined,
      claim,
      aiSettings: ctx.aiSettings,
      signal: ctx.signal,
    });
    const label = `模型判定（${target.spec.id}）`;
    if (judged.outcome === "yes") {
      markDeliverableSatisfied(
        ledger,
        target.spec.id,
        `${label}：已完成${judged.reason ? `（${judged.reason.slice(0, 80)}）` : ""}`,
        0,
      );
      ctx.logger.agentProgress(`交付物兜底判定通过：${target.spec.text}`, {
        phase: "deliverable_judge",
        deliverable: target.spec.id,
        reason: judged.reason,
      });
      const rest = listPendingDeliverables(ledger);
      if (rest.length === 0) return null;
      return rejectDeliverables(ctx, ledger, rest, {
        reasons: [],
        uncertain: rest.map((item) => item.spec),
        judged: true,
      });
    }
    if (judged.outcome === "no") {
      return rejectDeliverables(ctx, ledger, stillPending, {
        reasons: [`[${target.spec.id}] ${target.spec.text} —— ${label}：未完成（${judged.reason.slice(0, 100)}）`],
        uncertain: uncertain.slice(1).map((v) => v.spec),
        judged: true,
      });
    }
    // unknown：判定失败不惩罚任务，退回证据闸门
  }
  return null;
}

async function buildVerifierContext(ctx: ActionContext, claim: string) {
  const labels = [...(ctx.browserState?.selectorMap?.values() ?? [])]
    .map((el) => String(el.text ?? "").trim())
    .filter(Boolean)
    .slice(0, 120);
  const lexicon = loadCompletionLexicon();
  const signals = lexicon ? await scanPageSignals(ctx.page, lexicon) : undefined;
  return {
    goal: ctx.goal,
    ledger: ctx.evidence!,
    currentUrl: ctx.page.url(),
    currentTitle: ctx.browserState?.title ?? "",
    visibleLabels: labels,
    signals,
    artifacts: ctx.artifacts,
    claim,
    minClaimChars: lexicon?.minClaimChars ?? 30,
    serpForQuery: ctx.pageFacts?.serpForQuery === true,
    observedUrl: ctx.browserState?.url,
    // 信息型目标的阅读对象就是当前页 → verifyNavigation 不据此判「未达成」
    goalIntent: classifyGoalIntent(ctx.goal, lexicon),
  };
}

/** 事实台账 → 判定用的简短文本（只给客观事实，不给站点假设） */
function describeFactsForJudge(ctx: ActionContext): string[] {
  const facts = ctx.evidence?.facts ?? [];
  const lines = facts.slice(-24).map((fact) => `第${fact.step}步 ${fact.kind}: ${fact.detail || "-"}`);
  for (const artifact of ctx.artifacts ?? []) {
    lines.push(`已落盘文件: ${artifact.name}${artifact.url ? ` ← ${artifact.url.slice(0, 80)}` : ""}`);
  }
  return lines;
}

function rejectDeliverables(
  ctx: ActionContext,
  ledger: DeliverableLedger,
  pending: PendingDeliverable[],
  detail: { reasons: string[]; uncertain: DeliverableSpec[]; judged: boolean },
): ActionResult {
  ledger.rejections += 1;
  for (const item of pending) {
    const record = ledger.records.get(item.spec.id);
    if (record) record.blocks += 1;
  }
  const reasonLines = detail.reasons.length
    ? detail.reasons
    : detail.uncertain.map((spec) => `[${spec.id}] ${spec.text} —— 缺少可核销的完成证据`);
  const done = listDeliverables(ledger).filter((item) => item.record.status !== "pending");
  const message =
    `done 被驳回：任务契约里还有 ${pending.length} 项交付物未核销（本次由${
      detail.judged ? "模型判定 + 确定性验证" : "确定性验证"
    }得出）：${reasonLines.join("；")}。` +
    `请**只针对这些未完成项**继续执行（不要再重试同一个 done）：` +
    `需要点击/切换的就去点击，需要下载的就把文件真正落盘（产出可核销的下载记录），需要填写的就写入并回读确认。` +
    (done.length
      ? `已完成项（不要重做）：${done.map((item) => `${item.spec.id}${item.record.status === "satisfied" ? "✔" : "—"}`).join("、")}。`
      : "") +
    `全部核销后再次 done；若某项确实做不到，请用 done(success=false) 说明卡在哪一项。`;
  ctx.logger.agentProgress(
    `done 被驳回：契约交付物未齐（第 ${ledger.rejections} 次）· 还差 ${pending.length} 项`,
    {
      phase: "deliverable_gate",
      pending: pending.map((item) => item.spec.id),
      reasons: reasonLines.map((line) => line.slice(0, 160)),
    },
  );
  return fail(message, {
    metadata: {
      failure: {
        kind: "not-verified",
        retryable: true,
        targetKey: `deliverables:${pending.map((item) => item.spec.id).join(",")}`,
        guidance: reasonLines.join("；").slice(0, 400),
      },
      deliverableGate: {
        pending: pending.map((item) => `${item.spec.id}:${item.spec.kind}`),
        judged: detail.judged,
        judgementsLeft: ledger.judgementsLeft,
      },
    },
  });
}

async function verifyCompletionEvidence(
  ctx: ActionContext,
  claim: string,
  userRules?: { satisfied: boolean; details: string[] },
): Promise<CompletionVerdict> {
  const lexicon = loadCompletionLexicon();
  const signals = await scanPageSignals(ctx.page, lexicon ?? {
    maxDoneRejections: 2,
    scanChars: 6000,
    minClaimChars: 30,
    outcomeTerms: [],
    informationalTerms: [],
    strongSuccessTerms: [],
    weakSuccessTerms: [],
    failureTerms: [],
    commerce: {
      prePayTerms: [],
      notAutoSuccessTerms: [],
      paidClaimTerms: [],
      payDemandTerms: [],
      checkoutStopTerms: [],
      paymentConfirmTerms: [],
    },
  });
  const ledger = ctx.evidence;
  if (!ledger) {
    // 无台账：只用页面信号判定「结果型任务」，且不占用驳回额度（rejections 无处置零）
    return evaluateCompletion({
      ledger: {
        startUrl: ctx.page.url(),
        startTitle: "",
        facts: [],
        lastMutationStep: -1,
        lastMutationUrl: ctx.page.url(),
        lastFillUrl: null,
        prevUrl: ctx.page.url(),
        rejections: 99,
        pageDigestChars: 0,
        humanHandoverKeys: new Set<string>(),
        humanInvolved: false,
        channelEmailOtp: null,
        channelSmsOtp: null,
      },
      lexicon,
      goal: ctx.goal,
      claim,
      signals,
      currentUrl: ctx.page.url(),
      screenshotRecent: false,
      userRules,
    });
  }
  return evaluateCompletion({
    ledger,
    lexicon,
    goal: ctx.goal,
    claim,
    signals,
    currentUrl: ctx.page.url(),
    screenshotRecent: ctx.screenshotAfterMutation?.() === true,
    userRules,
  });
}

function fail(error: string, extra?: Partial<ActionResult>): ActionResult {
  return { error, success: false, ...extra };
}

/**
 * 目标键：失败台账按它归并。
 * 用「动作家族 + 目标身份」而不是动作名 —— 模型换 click/input 打同一个目标也应算同一笔账。
 */
/**
 * 结构化失败回执：给失败打上机器可读的分类，登记失败台账；
 * 同一目标同因撞墙后，把「禁止再试 + 替代路径」**直接写进本次返回值**，
 * 让模型在同一步就改道，而不是等它自己从历史里悟出来。
 */
function failKind(
  ctx: ActionContext,
  input: {
    kind: ActionFailureKind;
    message: string;
    action: string;
    targetKey?: string;
    evidence?: Record<string, unknown>;
    /** 兼容既有调用方/测试读的 metadata 键（如 fillVerify / staleIndex） */
    extraMetadata?: Record<string, unknown>;
  },
): ActionResult {
  const record = input.targetKey
    ? ctx.failures?.record({
        targetKey: input.targetKey,
        actionName: input.action,
        kind: input.kind,
        evidence: input.evidence,
      })
    : null;
  const failure = record?.failure ?? defineFailure(input.kind, input.evidence);
  const text = record?.escalate ? `${input.message}${record.escalateHint}` : input.message;
  ctx.logger.agentProgress?.(`动作失败[${input.kind}]：${input.message}`, {
    phase: "action_failure",
    kind: input.kind,
    retryable: failure.retryable,
    attempts: record?.attempts ?? 1,
    escalated: record?.escalate ?? false,
    ...(input.evidence ?? {}),
  });
  return fail(text, { metadata: { ...(input.extraMetadata ?? {}), failure } });
}

function failCaptcha(
  error: string,
  kind: "image_text" | "slider" | "math" | "point" | "press_hold" | "remote" | "unknown" = "unknown",
  signal = "tool_fail",
): ActionResult {
  return fail(error, {
    metadata: { captcha: { kind, verified: false, signal } },
  });
}

/**
 * 《搜索宪法》硬拦截（政策层，不经模型判断）。
 *
 * 拦的是**动作想去哪**（navigate 的目标地址 / click 命中的 href / evaluate 里构造的跳转），
 * 不是**最终 URL 长什么样** —— 宪法合法路径（首页填表提交）本身也会到达结果页，
 * 按结果判会把合法路径一起拦死。详见 core/page_policy.ts。
 *
 * 返回 null = 放行；返回 ActionResult = 本动作被拦下（policy-violation，不可重试）。
 */
function guardSearchConstitution(
  ctx: ActionContext,
  input: {
    actionName: string;
    targetUrl?: string | null;
    scriptText?: string | null;
    targetKey?: string;
  },
): ActionResult | null {
  const verdict = classifyNavigationPolicy({
    actionName: input.actionName,
    targetUrl: input.targetUrl,
    scriptText: input.scriptText,
    pageUrl: safeCurrentUrl(ctx),
    goalText: ctx.goal,
    searchBoxFilled: ctx.taskPolicy?.searchBoxFilled === true,
  });
  if (verdict.allowed) return null;
  return failKind(ctx, {
    kind: "policy-violation",
    action: input.actionName,
    targetKey: input.targetKey ?? failureTargetKey("action", `policy:${input.actionName}`),
    message: verdict.reason,
    evidence: { blockedUrl: verdict.blockedUrl, engine: verdict.engineId },
  });
}

/** 当前页面地址（页面可能已关闭；失败不影响裁决，只是少一个判断依据） */
function safeCurrentUrl(ctx: ActionContext): string | null {
  try {
    return ctx.page?.url() ?? null;
  } catch {
    return null;
  }
}

/** 读元素 href（只有链接类元素才有；用于宪法裁决的「点这个链接会不会直达结果页」） */
async function readElementHref(ctx: ActionContext, el: IndexedElementRef): Promise<string | null> {
  const tag = String(el.tagName ?? "").toLowerCase();
  const role = String(el.role ?? "").toLowerCase();
  if (tag !== "a" && tag !== "area" && role !== "link") return null;
  // 嵌套框架里的元素：selector 是**那个文档内**的相对路径，在主文档上按同一路径查会命中
  // 无关元素，读到的 href 也就是别人的 —— 宁可放弃这一次裁决，也不能凭错的 href 拦下合法点击。
  if (String(el.frameUrl ?? "").trim()) return null;
  try {
    const raw = await ctx.page
      .locator(el.selector)
      .first()
      .getAttribute("href", { timeout: 1_000 });
    if (!raw) return null;
    try {
      return new URL(raw, ctx.page.url()).toString();
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** 文本输入类控件（不靠文案匹配，只看结构） */
function looksLikeTextEntry(el: IndexedElementRef): boolean {
  const tag = String(el.tagName ?? "").toLowerCase();
  const role = String(el.role ?? "").toLowerCase();
  if (tag === "textarea") return true;
  if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
  if (tag !== "input") return false;
  const type = String(el.inputType ?? "text").toLowerCase();
  return !["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden", "range", "color"].includes(
    type,
  );
}

/**
 * 记录宪法「合法路径」状态：在**引擎首页**的文本框里写入过检索词。
 * 之后点击结果项/搜索建议就不再算「直达 SERP」（真人也是这么点的）。
 */
function noteSearchBoxFilled(ctx: ActionContext, el: IndexedElementRef): void {
  if (!ctx.taskPolicy || ctx.taskPolicy.searchBoxFilled) return;
  if (!isEngineHomepageUrl(ctx.page.url())) return;
  if (!looksLikeTextEntry(el)) return;
  ctx.taskPolicy.searchBoxFilled = true;
  ctx.logger.agentProgress?.("宪法：已在引擎首页搜索框输入检索词，后续点击结果链接放行", {
    phase: "search_constitution",
    url: ctx.page.url(),
  });
}

/** 文案兜底找提交控件：名词/上传/登录已由 hint 层过滤，这里只列动作动词。 */
const SUBMIT_HINT_RE = /验证答案|提交|确定|校验|confirm|submit|verify/i;

/** 上一轮已提交过的「验证码图指纹 + 答案」，用于拦截重复填交同一答案。 */
const lastCaptchaSubmission = new WeakMap<
  Page,
  { hash: string; code: string; submitted: boolean }
>();

function isNavigationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed|Target closed|navigat/i.test(msg);
}

/** 取当前页 URL，页面已销毁/关闭时返回空串（不抛）。 */
function tryPageUrl(page: ActionContext["page"]): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/** 点击单个元素；主选择器失败时退回 xpath（同一目标，不做二次猜测）。 */
async function clickElement(gw: OmniActionGateway, el: IndexedElementRef): Promise<void> {
  const sel = elementPlaywrightSelector(el);
  try {
    await gw.click(sel, { semanticLabel: el.text });
  } catch (err) {
    if (!el.xpath) throw err;
    await gw.click(`xpath=${el.xpath}`, { semanticLabel: el.text });
  }
}

/** 提交后探测页内成败信号；导航/上下文销毁视为「无明确信号」而非异常。 */
async function probeCaptchaOutcome(
  ctx: ActionContext,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const outcome = await checkCaptchaOutcome(ctx.page);
    payload.verified = outcome.verified;
    payload.verifySignal = outcome.signal;
  } catch (err) {
    if (!isNavigationError(err)) throw err;
    payload.verifySignal = "nav_or_context_destroyed";
    payload.verified = null;
  }
}

export function registerAllActions(): void {
  // 《搜索宪法》：search 工具本身会直达结果页（机器特征强，站点风控因此弹验证码）。
  // 保留 handler 只为给模型一个**准确的**拒绝理由与正确姿势；它已不在工具清单里
  // （见 registry.POLICY_BLOCKED_ACTIONS），模型看不见它。
  registerAction("search", async (_params, ctx) =>
    failKind(ctx, {
      kind: "policy-violation",
      action: "search",
      message:
        "宪法禁止使用 search 工具（它会自己拼出搜索引擎结果页地址）。" +
        "请改用真人路径：navigate 到引擎首页（用户没指定就用 google.com）→ " +
        "input 在页面搜索框里输入检索词 → 点击搜索按钮或 send_keys(Enter)。",
    }),
  );

  registerAction("navigate", async (params, ctx) => {
    let url = str(params.url).trim();
    if (!url) return fail("navigate 需要 url");
    /*
     * 非网页协议一律拒绝。这里以前只做 `https://` 前缀补齐，于是 `about:blank`
     * 被改写成 `https://about:blank` 发了出去 —— 用户现场：模型在百度首页卡住时
     * 突然 `navigate about:blank`「重置页面」，白烧一步，还顺带让
     * `navigation` 交付物凭空核销（判据用了上一轮观测的页面文案，见 verifyNavigation）。
     * 想让页面回到干净状态，正确手段是 `restart_browser`，不是导航到不可访问的地址。
     */
    const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
    if (!isContentPageUrl(url)) {
      return failKind(ctx, {
        kind: "invalid-params",
        action: "navigate",
        targetKey: failureTargetKey("action", `url:${url}`),
        message:
          `navigate 拒绝非网页地址「${url}」（协议 ${scheme ?? "?"}:）：它不是能承载内容的页面，` +
          `导航过去只会把当前进度丢在一个空白页上（也不构成「到达目标页」的证据）。` +
          `要重新开始请用 restart_browser；要回上一页请用 go_back；要继续任务请留在当前页处理。`,
        evidence: { url, scheme: scheme ?? null },
      });
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;

    const blocked = guardSearchConstitution(ctx, {
      actionName: "navigate",
      targetUrl: url,
      targetKey: failureTargetKey("action", `url:${url}`),
    });
    if (blocked) return blocked;

    const newTab = bool(params.new_tab, false);
    if (newTab) {
      const p = await ctx.page.context().newPage();
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await p.bringToFront();
      ctx.setActivePage?.(p);
      const gw = resolveGateway(p);
      await gw.navigate(url, { alreadyNavigated: true });
      return ok(`新标签打开 ${url}`);
    }
    const gw = resolveGateway(ctx.page);
    await gw.navigate(url);
    return ok(`已导航 ${url}`);
  });

  registerAction("go_back", async (_params, ctx) => {
    const gw = resolveGateway(ctx.page);
    await gw.goBack();
    return ok("已后退");
  });

  registerAction("wait", async (params, ctx) => {
    const seconds = Math.min(30, Math.max(0.5, num(params.seconds, 1)));
    await resolveGateway(ctx.page).wait(seconds);
    return ok(`等待 ${seconds}s`);
  });

  /**
   * 计划修正：**不碰浏览器**，只把"账本"改掉。
   *
   * 真正的落账由 service 在**执行前**把本动作转写成 `output.plan_update` 完成
   * （走 MessageManager 这一条唯一写路径）。所以这里只是**安全网**：
   * 若某条调用路径没经过 service 的拦截（单测直调 / 将来新增的调用方），
   * 也要给出明确回执，绝不静默成功 —— 那会让模型以为计划改了而实际没改。
   */
  registerAction(PLAN_TOOL_NAME, async (params, ctx) => {
    const read = readPlanCommand(params);
    if (!read.command) {
      return {
        success: false,
        error: read.error ?? "update_plan 参数无法解析",
        longTermMemory: read.error ?? "update_plan 参数无法解析",
      };
    }
    const { steps, currentIndex } = read.command;
    const withExpects = steps.filter((step) => step.expects).length;
    const at = currentIndex == null ? "" : `，当前项 #${currentIndex}`;
    const droppedNote = read.dropped.length
      ? `；已丢弃 ${read.dropped.length} 个非法期望 token（${read.dropped.slice(0, 3).join("/")}）—— must_appear_in_a11y 只接受 role 或 role:名称`
      : "";
    const detail = `计划已接受：${steps.length} 项（${withExpects} 项带期望）${at}${droppedNote}`;
    ctx.logger.agentProgress?.(detail, {
      phase: "plan",
      steps: steps.length,
      expects: withExpects,
      expectsDropped: read.dropped,
    });
    return ok(detail, { metadata: { planUpdate: steps, currentPlanItem: currentIndex } });
  });

  registerAction("click", async (params, ctx) => {
    const index = params.index != null ? num(params.index) : null;
    const x = params.coordinate_x != null ? num(params.coordinate_x) : null;
    const y = params.coordinate_y != null ? num(params.coordinate_y) : null;
    const gw = resolveGateway(ctx.page);
    if (x != null && y != null) {
      const preflight = await clearOverlayOverPoint(ctx.page, { x, y });
      if (preflight.cleared) {
        ctx.logger.agentProgress?.(`坐标点击前已清除遮挡：${preflight.detail}`, { phase: "overlay" });
      }
      await gw.pointClick(x, y);
      return ok(
        `坐标点击 (${x},${y})${preflight.cleared ? `（已先清除遮挡「${preflight.detail}」）` : ""}`,
      );
    }
    if (index == null) return fail("click 需要 index 或坐标");
    const key = failureTargetKey("index", index);
    const el = ctx.resolveElement(index);
    if (!el) return failMissingIndex(ctx, index);
    // 先定文档：索引的 selector 是「元素所在文档内」的相对路径，iframe 元素必须回到那个 iframe 里找
    const resolvedDoc = await resolveElementDocument(ctx, el);
    if ("fail" in resolvedDoc) return resolvedDoc.fail;
    const doc = resolvedDoc.doc;
    const stale = await guardStaleIndex(ctx, el, index, doc.scope);
    if (stale) {
      const recovered = await recoverFromStaleIndex(ctx, {
        index,
        el,
        scope: doc.scope,
        stale,
        reason: "页面结构已变化，旧坐标/选择器不再指向该元素",
        action: "click",
        params,
      });
      if (recovered !== "healed") return recovered;
    }
    // 宪法：点击一个 href 就是结果页的链接 = 绕过「首页填表」直达 SERP
    const clickHref = await readElementHref(ctx, el);
    const blockedClick = guardSearchConstitution(ctx, {
      actionName: "click",
      targetUrl: clickHref,
      targetKey: key,
    });
    if (blockedClick) return blockedClick;
    const label = elementLabelBlob(el) || el.tagName;
    const hitl = resolveHitlDecision(ctx, "click", label, undefined, el);
    let paymentSubmitApproved = false;
    if (hitl) {
      const confirmId = randomUUID();
      const decision = await ctx.requestConfirm({
        requestId: confirmId,
        url: ctx.page.url(),
        reason: `点击 [${index}] ${label}（${hitl.reason}）`,
        actions: [{ kind: "click", id: String(index), text: label }],
      });
      if (!decision.approved) {
        return failKind(ctx, {
          kind: "denied-by-user",
          action: "click",
          targetKey: key,
          message: hitlDeniedMessage("click", hitl.level),
          evidence: { index, hitlLevel: hitl.level },
        });
      }
      paymentSubmitApproved = isPaymentSubmitLabel(label);
    }

    // 精确命中闭环：意图关联（复选框/单选框等）→ 命中自检 → 遮挡仲裁自愈 → 结果验证
    const target = splitPlaywrightSelector(elementPlaywrightSelector(el));
    const precise = await preciseClick(ctx.page, {
      selector: target.selector,
      xpath: target.xpath,
      expect: inferClickExpectation(el),
      semanticLabel: el.text,
      scope: doc.scope,
      offset: doc.offset,
      frameVisible: doc.frameVisible,
      frameBox: doc.box,
    });
    if (precise.clearedOverlay) {
      ctx.logger.agentProgress?.(
        `点击前自动清除遮挡层「${precise.clearedOverlay.label}」（${precise.clearedOverlay.method}）`,
        { phase: "overlay", attempts: precise.attempts },
      );
    }
    if (precise.ok) {
      const popup = await ensurePopupOpened(doc.scope, elementPlaywrightSelector(el));
      if (popup === "closed") {
        return fail(
          `已命中 [${index}] ${label}，但下拉列表没有展开。不要把这一下当成已打开；请改用 select_dropdown(index, text) 直接选中选项，或重新观察后再点。`,
        );
      }
      ctx.failures?.settle(key);
      if (paymentSubmitApproved && ctx.evidence) ctx.evidence.humanPaymentConfirmed = true;
      // B2：把「真的点过这个元素」记进 must_click 台账（元素级 matches，点击当刻判定）。
      const clickedSelector = elementPlaywrightSelector(el);
      await noteTaskRuleClick(ctx.taskRules ?? null, {
        step: ctx.step ?? 0,
        label,
        matchesSelector: async (ruleSelector) => {
          if (!clickedSelector) return false;
          return await doc.scope
            .locator(clickedSelector)
            .first()
            .evaluate((node, arg) => (node as Element).matches(String(arg)), ruleSelector)
            .catch(() => false);
        },
      }).catch(() => undefined);
      const openedNote = popup === "open" ? "，下拉已展开" : "";
      return ok(`已点击 [${index}] ${label}（${precise.feedback}）${openedNote}${describeCompanionHint(el)}`, {
        metadata: {
          hitPoint: precise.clickedPoint,
          clickMethod: precise.method,
          associated: precise.associated
            ? { reason: precise.associated.reason, tag: precise.associated.tag }
            : null,
          checkedBefore: precise.checkedBefore,
          checkedAfter: precise.checkedAfter,
          clearedOverlay: precise.clearedOverlay,
          popupOpened: popup === "open",
        },
      });
    }
    if (precise.blocked) {
      // 明确是遮挡导致：禁止用 force 硬点掩盖问题，把事实交回模型自纠
      ctx.logger.agentProgress?.(`点击被遮挡层拦截：${precise.feedback}`, {
        phase: "overlay",
        attempts: precise.attempts,
      });
      return failKind(ctx, {
        kind: "blocked-by-overlay",
        action: "click",
        targetKey: key,
        message: `点击 [${index}] ${label} 被弹层拦截且自动清障未成功：${precise.feedback}`,
        evidence: { index, attempts: precise.attempts.length, clearedOverlay: precise.clearedOverlay },
      });
    }

    // 非遮挡类失败：退回既有选择器点击路径（保持兼容）
    try {
      await gw.click(elementPlaywrightSelector(el), {
        semanticLabel: el.text,
        scope: doc.scope,
        offset: doc.offset,
      });
    } catch (err) {
      if (el.xpath) {
        await gw.click(`xpath=${el.xpath}`, {
          semanticLabel: el.text,
          scope: doc.scope,
          offset: doc.offset,
        });
      } else {
        throw err;
      }
    }
    ctx.failures?.settle(key);
    if (paymentSubmitApproved && ctx.evidence) ctx.evidence.humanPaymentConfirmed = true;
    const popup = await ensurePopupOpened(doc.scope, elementPlaywrightSelector(el));
    if (popup === "closed") {
      return fail(
        `已命中 [${index}] ${label}，但下拉列表没有展开。不要把这一下当成已打开；请改用 select_dropdown(index, text) 直接选中选项，或重新观察后再点。`,
      );
    }
    const openedNote = popup === "open" ? "，下拉已展开" : "";
    return ok(`已点击 [${index}] ${label}（兜底选择器路径；${precise.feedback}）${openedNote}`);
  });

  registerAction("input", async (params, ctx) => {
    const index = num(params.index);
    const text = str(params.text);
    const clear = bool(params.clear, true);
    const key = failureTargetKey("index", index);
    const el = ctx.resolveElement(index);
    if (!el) return failMissingIndex(ctx, index);
    const resolvedDoc = await resolveElementDocument(ctx, el);
    if ("fail" in resolvedDoc) return resolvedDoc.fail;
    const doc = resolvedDoc.doc;
    const stale = await guardStaleIndex(ctx, el, index, doc.scope);
    if (stale) {
      const recovered = await recoverFromStaleIndex(ctx, {
        index,
        el,
        scope: doc.scope,
        stale,
        reason: "页面结构已变化，旧坐标/选择器不再指向该输入框",
        action: "input",
        params,
      });
      if (recovered !== "healed") return recovered;
    }
    const label = elementLabelBlob(el) || el.tagName;
    let value = text;
    // 人工在确认框里补的值算「人给的值」（可写进一次性凭证字段）
    let humanProvidedOverride = false;
    const humanCredentialEarly = String(el.humanOnly ?? "").trim();
    const earlyKind = humanCredentialEarly
      ? classifyHumanCredentialKind({ label, reason: humanCredentialEarly })
      : null;
    const channelFillPending =
      Boolean(humanCredentialEarly) &&
      ((isEmailOtpChannelEligible(earlyKind!) &&
        matchesChannelResolvedOtp(text, ctx.evidence?.channelEmailOtp)) ||
        (isSmsOtpChannelEligible(earlyKind!) &&
          matchesChannelResolvedOtp(text, ctx.evidence?.channelSmsOtp)));
    const hitl = resolveHitlDecision(ctx, "fill", label, text, el);
    // P1.2：通道码自动填入时跳过 sensitive 确认（避免把码弹到确认框）；critical 永不跳过
    const skipHitlForChannel = channelFillPending && hitl != null && hitl.level !== "critical";
    if ((hitl && !skipHitlForChannel) || text.length === 0) {
      const confirmId = randomUUID();
      const decision = await ctx.requestConfirm({
        requestId: confirmId,
        url: ctx.page.url(),
        reason: `填写 [${index}] ${label}${hitl ? `（${hitl.reason}）` : "（内容为空，需确认）"}`,
        actions: [
          {
            kind: "fill",
            id: String(index),
            text: label,
            value: text,
          },
        ],
      });
      if (!decision.approved) {
        return failKind(ctx, {
          kind: "denied-by-user",
          action: "fill",
          targetKey: key,
          message: hitlDeniedMessage("fill", hitl?.level ?? "none"),
          evidence: { index, hitlLevel: hitl?.level ?? "none" },
        });
      }
      const override = decision.fillOverrides?.[String(index)];
      if (override != null) {
        humanProvidedOverride = true;
        value = override;
      }
    } else if (
      !skipHitlForChannel &&
      typeof params.confidence === "number" &&
      params.confidence < CONFIRM_SKIP_THRESHOLD
    ) {
      const confirmId = randomUUID();
      const decision = await ctx.requestConfirm({
        requestId: confirmId,
        url: ctx.page.url(),
        reason: `低置信填写 [${index}] ${label}`,
        actions: [{ kind: "fill", id: String(index), text: label, value: text }],
      });
      if (!decision.approved) {
        return failKind(ctx, {
          kind: "denied-by-user",
          action: "fill",
          targetKey: key,
          message: hitlDeniedMessage("fill", "none"),
          evidence: { index },
        });
      }
      const override = decision.fillOverrides?.[String(index)];
      if (override != null) {
        humanProvidedOverride = true;
        value = override;
      }
    }

    // 一次性凭证硬闸：邮箱/短信/验证器动态码禁止 AI 编造。
    // P1.2：邮箱类允许通道码；P5.3：短信类允许接码平台码（须显式启用）；TOTP 仍禁止。
    const humanCredential = String(el.humanOnly ?? "").trim();
    const valueFromHuman = humanProvidedOverride || ctx.evidence?.humanInvolved === true;
    const channelAuthorized = isHumanCredentialValueAuthorized({
      humanOnlyReason: humanCredential,
      label,
      value,
      humanProvided: valueFromHuman,
      channelEmailOtp: ctx.evidence?.channelEmailOtp,
      channelSmsOtp: ctx.evidence?.channelSmsOtp,
    });
    if (humanCredential && !channelAuthorized) {
      const kind = classifyHumanCredentialKind({ label, reason: humanCredential });
      const emailHint = isEmailOtpChannelEligible(kind)
        ? isOtpChannelConfigured(parseOtpChannel(ctx.otpChannel))
          ? "请先 fetch_email_otp（成功后自动填入），失败再 ask_user / handover。"
          : "未配置邮箱通道：请 ask_user 索取邮箱码，或 handover；禁止猜测。"
        : isSmsOtpChannelEligible(kind)
          ? isSmsOtpServiceConfigured(parseSmsOtpService(ctx.smsOtpService))
            ? "请先 fetch_sms_otp（成功后自动填入），失败再 ask_user / handover。"
            : "未启用短信接码平台：请 ask_user 或 handover；禁止猜测。"
          : "验证器码禁止自动取：请 ask_user 或 handover；禁止猜测。";
      return failKind(ctx, {
        kind: "needs-human",
        action: "fill",
        targetKey: key,
        message:
          `输入 [${index}] ${label} 被拒：这是**一次性凭证**字段（${humanCredential}；渠道=${kind}），` +
          `禁止 AI 编造。${emailHint}`,
        evidence: { index, humanOnly: humanCredential, kind },
      });
    }
    let channelProvided = false;
    if (humanCredential && !valueFromHuman && channelAuthorized) {
      const kind = classifyHumanCredentialKind({ label, reason: humanCredential });
      channelProvided = isSmsOtpChannelEligible(kind)
        ? consumeChannelSmsOtp(ctx.evidence, value)
        : consumeChannelEmailOtp(ctx.evidence, value);
    }

    const gw = resolveGateway(ctx.page);
    const selector = elementPlaywrightSelector(el);
    const fieldTarget = splitPlaywrightSelector(selector);

    /*
     * 写入前记下页面身份。纠正重写/键盘重打都是「按同一个选择器再写一次」，
     * 而选择器在新页面上完全可能命中**另一个**字段 —— 百度首页与结果页的搜索框都是 `#kw`：
     * 页面在写入期间跳转后还去重写，就会把内容打进新页的同名输入框、给它带上焦点并弹出联想层
     * （页面被盖住、回读必然失败，用户现场看到的「焦点一直卡在输入框里」正是这个形态）。
     * 页面一旦变了，写入结果就**无法确认** —— 如实上报，绝不再写第二次。
     */
    const urlBeforeWrite = tryPageUrl(ctx.page);

    // 填写前快照：用于推算 append 期望值，并识别只读/受控/联想字段
    const beforeField = await readFieldSnapshot(doc.scope, fieldTarget).catch(() => null);

    const wrote = await gw.fill(selector, value, {
      semanticLabel: label,
      humanLike: true,
      append: !clear,
      scope: doc.scope,
      offset: doc.offset,
    });

    // 回读真值：工具「不抛错」不等于「写进去了」。
    // 带短轮询：站点把值落到 DOM 有延迟（受控组件提交、防抖重渲染）时，
    // 一次瞬时读取会把「还没写进 DOM」误判成 empty，进而触发一次多余的清空重写。
    let verification = await readFieldSettled(doc.scope, fieldTarget, {
      before: beforeField,
      append: !clear,
      text: value,
    });

    // 写入没落地（空）或「写一半被清掉」（只剩期望值的尾部）→ 纠正一次。
    // 两者都是**数据没进去**，不是站点格式化；纠正手法按「先原子后键盘」排序：
    //   ① 原子覆盖（一次性写入全文，页面上看不到「清空再逐字重打」）；
    //   ② 仍不生效才退回键盘重打（应对吞掉原生 setter 的受控组件）。
    // 必须按期望值整体重写，不能追加，否则内容会被插到中间/重复。
    // 只读字段例外：它不是「没写到 DOM」，而是**永远写不进去**，重写只会白费一次写入
    // （由下面的只读判定给出 not-actionable 回执，让模型换入口）。
    const expectedValue = verification.expected;
    const readOnlyField = beforeField?.readOnly === true;
    // 页面在写入+回读的窗口里跳转过 → 手里这个选择器已经不属于当初那个字段了（见 urlBeforeWrite 的注释）
    const urlNow = tryPageUrl(ctx.page);
    const pageMovedDuringWrite = Boolean(urlBeforeWrite && urlNow && urlBeforeWrite !== urlNow);
    if (
      !readOnlyField &&
      !pageMovedDuringWrite &&
      (verification.verdict === "empty" || isTruncatedTailLoss(expectedValue, verification.actual))
    ) {
      const lostNote = verification.actual ? `（写一半被清空，实际「${verification.actual.slice(0, 24)}」）` : "";
      ctx.logger.agentProgress?.(`写入未落地${lostNote}：[${index}] ${label} → 原子覆盖重写`, {
        phase: "fill_verify",
        verdict: verification.verdict,
      });
      await gw
        .fill(selector, expectedValue, {
          semanticLabel: label,
          append: false,
          scope: doc.scope,
          offset: doc.offset,
        })
        .catch(() => undefined);
      let retry = await readFieldSettled(doc.scope, fieldTarget, {
        before: beforeField,
        append: !clear,
        text: value,
      });
      if (retry.verdict !== "ok") {
        // 原子写入被吞（受控组件忽略原生 setter）→ 键盘重打兜底
        await retryFieldWrite(doc.scope, fieldTarget, expectedValue).catch(() => undefined);
        retry = await readFieldSettled(doc.scope, fieldTarget, {
          before: beforeField,
          append: !clear,
          text: value,
        });
      }
      if (retry.verdict === "ok") verification = retry;
    }

    const readback = describeFillVerification(verification, beforeField?.type ?? el.inputType);
    const verifyHit = findIndexByTextHint(
      ctx.browserState.selectorMap,
      /验证答案/i,
      /提交参赛/i,
    );

    // 页面在写入窗口里跳转过、且回读拿不出确认 → 只上报事实，绝不重写（见 urlBeforeWrite 的注释）。
    // 这里必须挡在所有「纠正/重试/假成功」分支之前：回读本身也已经不可信（它读的可能是新文档里的同名字段）。
    if (pageMovedDuringWrite && verification.verdict !== "ok") {
      ctx.logger.agentProgress(
        `页面在写入期间已跳转（${urlBeforeWrite} → ${urlNow}），未做纠正重写：[${index}] ${label}`,
        { phase: "fill_verify", verdict: verification.verdict },
      );
      return failKind(ctx, {
        kind: "no-effect",
        action: "fill",
        targetKey: key,
        message:
          `输入 [${index}] ${label} 无法确认：写入期间页面已跳转（${urlBeforeWrite} → ${urlNow}），回读 ${readback}。` +
          `**未做纠正重写**（新页面的同名选择器可能指向另一个字段）。` +
          `请重新观察当前页面：确认目标是否已经进入下一状态（跳转本身就是提交生效的迹象），再决定下一步。`,
        evidence: { index, fillVerify: verification.verdict, pageMovedDuringWrite: true },
        extraMetadata: { fillVerify: verification.verdict, pageMovedDuringWrite: true },
      });
    }

    // 只读字段：写入永远不会落地。回读已证实没写进去时，直接判「控件不可交互」（不可重试），
    // 而不是把 mismatch 当『站点格式化』放行 —— 否则模型会以为填好了，带着空字段往下走。
    if (beforeField?.readOnly === true && verification.verdict !== "ok") {
      return failKind(ctx, {
        kind: "not-actionable",
        action: "fill",
        targetKey: key,
        message: `输入 [${index}] ${label} 未落地：该字段为只读（回读 ${readback}）。请换一个可编辑的等价入口。`,
        evidence: { index, readOnly: true, fillVerify: verification.verdict },
        extraMetadata: { fillVerify: verification.verdict },
      });
    }

    if (verification.verdict === "empty") {
      // 明确是假成功：禁止上层继续往下走（例如以空框去提交注册）
      ctx.logger.agentProgress?.(`填写未生效：[${index}] ${label} — ${readback}`, {
        phase: "fill_verify",
        expected: maskSensitive(verification.expected, beforeField?.type),
        actual: maskSensitive(verification.actual, beforeField?.type),
      });
      return failKind(ctx, {
        kind: "no-effect",
        action: "fill",
        targetKey: key,
        message: `输入 [${index}] ${label} 未生效：回读 ${readback}。请先确认该字段可编辑（可能被弹层遮挡/为只读/需先点击激活），再重试或改用其他输入入口。`,
        evidence: { index, fillVerify: verification.verdict },
        extraMetadata: {
          fillVerify: verification.verdict,
          expected: maskSensitive(verification.expected, beforeField?.type),
          actualValue: maskSensitive(verification.actual, beforeField?.type),
        },
      });
    }

    if (verification.verdict === "ok" || verification.verdict === "mismatch") {
      // mismatch 是「站点格式化/截断」这类已放行的结果，同样代表写入已发生 → 结清该目标的失败账
      ctx.failures?.settle(key);
      // 宪法「合法路径」状态：在引擎首页搜索框写过检索词 → 之后的点击（结果项/建议）放行
      noteSearchBoxFilled(ctx, el);
    }

    const duplicateWrite = wrote.skipped === "identical";
    const suffix = duplicateWrite
      ? `（字段里已经是这个内容，**未重复写入**：没有清空、也没有重打。禁止再对同一字段发一次 input）`
      : verification.verdict === "ok"
        ? `（回读确认：${readback}）`
        : `（回读：${readback}）`;
    if (duplicateWrite) {
      ctx.failures?.settle(key);
      ctx.logger.agentProgress?.(`重复写入已跳过：[${index}] ${label} 内容一致`, {
        phase: "fill_verify",
        verdict: "identical-skip",
      });
    }
    const fillMeta = {
      fillVerify: verification.verdict,
      ...(humanCredential ? { humanOnly: true } : {}),
      ...(humanProvidedOverride ? { humanProvided: true } : {}),
      ...(channelProvided ? { channelProvided: true } : {}),
    };
    if (verifyHit) {
      return ok(
        `已输入 [${index}]: ${maskSensitive(value, beforeField?.type).slice(0, 80)}${suffix}。下一动作立即 click(index=${verifyHit.index})「${verifyHit.label}」，勿空等、勿再 solve_captcha。`,
        { metadata: fillMeta },
      );
    }
    return ok(`已输入 [${index}]: ${maskSensitive(value, beforeField?.type).slice(0, 80)}${suffix}`, {
      metadata: fillMeta,
    });
  });

  registerAction("scroll", async (params, ctx) => {
    const down = bool(params.down, true);
    const pages = Math.max(0.1, num(params.pages, 1));
    const gw = resolveGateway(ctx.page);
    if (pages >= 10) {
      await gw.scroll(down ? "bottom" : "up");
    } else {
      for (let i = 0; i < Math.ceil(pages); i++) {
        await gw.scroll(down ? "down" : "up");
      }
    }
    return ok(`滚动 ${down ? "下" : "上"} ×${pages}`);
  });

  registerAction("send_keys", async (params, ctx) => {
    const keys = str(params.keys).trim();
    if (!keys) return fail("send_keys 需要 keys");
    await resolveGateway(ctx.page).executeKeyPress(keys);
    return ok(`按键 ${keys}`);
  });

  registerAction("find_text", async (params, ctx) => {
    const text = str(params.text).trim();
    if (!text) return fail("find_text 需要 text");
    for (let i = 0; i < 8; i++) {
      const found = await ctx.page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
      if (found) {
        await ctx.page.getByText(text, { exact: false }).first().scrollIntoViewIfNeeded().catch(() => null);
        return ok(`已找到文本: ${text}`);
      }
      await resolveGateway(ctx.page).scroll("down");
    }
    return fail(`未找到文本: ${text}`);
  });

  registerAction("switch", async (params, ctx) => {
    const tabId = str(params.tab_id).trim();
    // 稳定 id（t2）优先；位置写法（*2 / 2 / 0002）按当前顺序解析。找不到就报错，不落到别的页。
    const target = resolveTab(ctx.page, tabId);
    if (!target) {
      return fail(`标签不存在: ${tabId}；当前可用：${describeAvailableTabs(ctx.page)}`);
    }
    await target.bringToFront();
    ctx.setActivePage?.(target);
    // 回放无法复现「切标签」语义，落盘为导航到该标签 URL
    const finalUrl = target.url();
    if (finalUrl && !/^about:blank/i.test(finalUrl)) {
      resolveGateway(target).recordNavigate(finalUrl);
    }
    return ok(`已切换到标签 ${tabId}`);
  });

  registerAction("close", async (params, ctx) => {
    const tabId = str(params.tab_id).trim();
    const target = resolveTab(ctx.page, tabId);
    if (!target) {
      return fail(`标签不存在: ${tabId}；当前可用：${describeAvailableTabs(ctx.page)}`);
    }
    if (ctx.page.context().pages().length <= 1) return fail("不能关闭最后一个标签");
    await target.close();
    return ok(`已关闭标签 ${tabId}`);
  });

  /**
   * 新建一个浏览器环境（宿主资产，经 `hostRequest` 回环，由宿主复用 DB 逻辑落库）。
   *
   * **重要边界**：新建的环境**不会**接管当前任务 —— 本任务仍然跑在原环境里。
   * 这一点必须如实回执，否则模型会以为「已经在新环境里操作」而继续瞎点空白页。
   * 需要在新环境里干活，得在环境列表里启动它、再对它派发新任务。
   */
  registerAction("create_environment", async (params, ctx) => {
    if (!ctx.hostRequest) {
      return fail("当前宿主不支持由 Agent 新建环境，请让用户在环境列表里手动新建");
    }
    const rawName = str(params.name).trim();
    const rawProxy = params.proxy_id ?? params.proxyId;
    const proxyId = Number.isFinite(Number(rawProxy)) && Number(rawProxy) > 0 ? Number(rawProxy) : null;
    const result = await ctx.hostRequest({
      kind: "create_environment",
      payload: {
        name: rawName || null,
        proxyId,
        useGeoip: params.use_geoip !== false,
      },
    });
    if (!result.ok) {
      return fail(result.error ?? "新建环境失败");
    }
    const createdId = String(result.data?.profileId ?? "");
    const createdName = String(result.data?.name ?? rawName);
    ctx.logger.agentProgress(
      `已新建环境 #${createdId}${createdName ? ` ${createdName}` : ""}（不会接管当前任务）`,
      { phase: "host_create_environment", profileId: createdId },
    );
    return ok(
      `已新建环境 #${createdId}${createdName ? `（${createdName}）` : ""}。` +
        `注意：**当前任务仍在原环境继续**，新环境不会自动接管；` +
        (proxyId ? `已使用代理池 #${proxyId}。` : "未绑定代理。") +
        `需要在新环境里操作时，请让用户在环境列表启动它后再派发新任务。`,
      { metadata: { createdProfileId: createdId, createdProfileName: createdName } },
    );
  });

  /**
   * 删除一个浏览器环境（不可逆）。
   *
   * 强制人工确认：环境里可能是用户长期养好的登录态/指纹，删错就是不可逆的数据损失。
   * 用户拒绝 → 直接失败，不做任何「再试一次」的换说法重试（§0.5.3）。
   */
  registerAction("delete_environment", async (params, ctx) => {
    if (!ctx.hostRequest) {
      return fail("当前宿主不支持由 Agent 删除环境，请让用户在环境列表里手动删除");
    }
    const rawId = str(params.profile_id ?? params.profileId).trim();
    if (!/^\d+$/.test(rawId)) {
      return fail("删除环境需要明确的 profile_id（环境列表里的数字 id）");
    }
    const reason = str(params.reason).trim() || `Agent 请求删除环境 #${rawId}`;
    const requestId = `env-del-${rawId}-${Date.now().toString(36)}`;
    const verdict = await ctx.requestConfirm({
      requestId,
      url: ctx.page.url(),
      reason: `删除环境 #${rawId}（${reason}）—— 该操作不可撤销，环境里的登录态/指纹数据会一起消失`,
      actions: [{ kind: "click", id: "delete_environment", text: `删除环境 #${rawId}` }],
    });
    if (!verdict.approved) {
      return {
        ...fail(`用户拒绝删除环境 #${rawId}：已取消。禁止换说法重试同一删除动作。`),
        metadata: {
          failure: {
            kind: "denied-by-user",
            retryable: false,
            hint: "用户已取消该删除动作；本轮禁止再次触发同一确认。",
          },
        },
      };
    }
    const result = await ctx.hostRequest({
      kind: "delete_environment",
      payload: { profileId: rawId },
    });
    if (!result.ok) {
      return fail(result.error ?? `删除环境 #${rawId} 失败`);
    }
    ctx.logger.agentProgress(`已删除环境 #${rawId}（人工确认后）`, {
      phase: "host_delete_environment",
      profileId: rawId,
    });
    return ok(`已删除环境 #${rawId}。`);
  });

  /**
   * 读取别的标签页的**原文值**（确定性 DOM 取值，零 LLM 改写）。
   *
   * 为什么单独做一个工具，而不是让模型 `extract` 之后再转述：
   * 「标签1 取数据 → 填到标签3」这条路上，任何一次「模型转述」都可能改掉字符
   * （信用卡号少一位、金额被四舍五入、编码被规范化）。read_tab 把值**原样**取出来给模型看；
   * 真正要搬运时用 fill_from_tab，值全程不经过模型。
   *
   * `tab_id` 缺省 = 当前活动标签（这时它就是「确定性读当前页」的标准工具，
   * 比 extract 更适合取值：不走 LLM、不改写、不总结）。
   */
  registerAction("read_tab", async (params, ctx) => {
    const rawTabId = str(params.tab_id).trim();
    let target = ctx.page;
    if (rawTabId) {
      const resolved = resolveTab(ctx.page, rawTabId);
      if (!resolved) {
        return fail(`标签不存在: ${rawTabId}；当前可用：${describeAvailableTabs(ctx.page)}`);
      }
      target = resolved;
    }
    const specs = Array.isArray(params.selectors) ? params.selectors : [];
    const wantText = bool(params.text, false);
    if (specs.length === 0 && !wantText) {
      return fail("read_tab 需要 selectors（要读哪些字段）或 text=true（读可见正文）");
    }

    const tabLabel = `${tabIdOf(target)}(*${tabPosition(target) || 1})`;
    const lines: string[] = [`read_tab ${tabLabel} — 原文取值（不做摘要/改写）`];
    const values: Record<string, string | string[]> = {};
    const missing: string[] = [];

    for (const raw of specs.slice(0, 20)) {
      if (!raw || typeof raw !== "object") continue;
      const spec = raw as Record<string, unknown>;
      const selector = str(spec.selector).trim();
      if (!selector) continue;
      const name = str(spec.name).trim() || selector;
      const attr = str(spec.attr).trim();
      const all = bool(spec.all, false);
      const read = await readSelectorValues(target, selector, attr, all);
      if (read.length === 0) {
        missing.push(`${name}（选择器未匹配：${selector}）`);
        continue;
      }
      const shown = all ? read : [read[0]!];
      // 用 JSON.stringify 展示：引号把首尾空格/换行这些「隐形字符」也暴露出来，
      // 避免模型以为取到的是干净字符串。
      lines.push(`- ${name}: ${shown.map((v) => JSON.stringify(v)).join(", ")}`);
      values[name] = all ? shown : shown[0]!;
    }

    if (wantText) {
      try {
        const body = (await target.evaluate(() => document.body?.innerText ?? "")) as string;
        const clipped = body.replace(/\n{3,}/g, "\n\n").trim().slice(0, 8_000);
        lines.push("--- 可见正文（截断 8000 字符） ---", clipped || "(空)");
      } catch (error) {
        lines.push(`--- 可见正文读取失败：${String(error).slice(0, 120)} ---`);
      }
    }

    if (missing.length > 0) {
      lines.push(`未读到：${missing.join("、")}`);
    }
    return ok(lines.join("\n"), { metadata: { values, missing, tab: tabLabel } });
  });

  /**
   * 跨标签搬运：从**源标签**的某个元素取值，原样填进**当前活动标签**的某个输入框。
   *
   * 值全程只经过一个字符串变量，**不经过模型**（模型抄一遍就可能改字符）。
   * 目标必须用 `index`（browser_state 里的控件编号）且在当前活动标签上 ——
   * 这样本次写入仍然完整复用 input 动作的**全部**闸门：一次性凭证硬拦（R2）、
   * index 新鲜度、HITL 敏感确认、回读比对。要填别的标签，请先 `switch(tab_id)` 过去再调用。
   */
  registerAction("fill_from_tab", async (params, ctx) => {
    const rawFromTab = str(params.from_tab).trim();
    let source = ctx.page;
    if (rawFromTab) {
      const resolved = resolveTab(ctx.page, rawFromTab);
      if (!resolved) {
        return fail(`源标签不存在: ${rawFromTab}；当前可用：${describeAvailableTabs(ctx.page)}`);
      }
      source = resolved;
    }
    const fromSelector = str(params.from_selector).trim();
    if (!fromSelector) return fail("fill_from_tab 需要 from_selector（从哪个元素取值）");
    const fromAttr = str(params.from_attr).trim();
    const index = num(params.index);
    if (index <= 0) return fail("fill_from_tab 需要 index（当前标签内目标输入框的控件编号）");

    // 目标必须在当前活动标签：不做静默切页（切页会换掉观察作用域和全部 index）
    if (rawFromTab) {
      const sourceTabId = tabIdOf(source);
      const activeTabId = tabIdOf(ctx.page);
      if (sourceTabId === activeTabId) {
        return fail(
          `from_tab 指向的就是当前活动标签 ${sourceTabId}：取值和写入在同一页，请直接用 input。` +
            `要搬到别的标签，请先 switch(tab_id=...) 切到目标标签再调用 fill_from_tab。`,
        );
      }
    }

    const read = await readSelectorValues(source, fromSelector, fromAttr, false);
    // 原样搬运，**不做 trim**：首尾空白由 read_tab 的带引号回执暴露给模型判断，
    // 这里擅自修掉就等于「悄悄改写用户要搬的数据」。
    const value = read[0] ?? "";
    if (!value.trim()) {
      return failKind(ctx, {
        kind: "target-missing",
        action: "fill_from_tab",
        targetKey: failureTargetKey("action", `from:${fromSelector}`),
        message:
          `源标签 ${tabIdOf(source)}(*${tabPosition(source) || 1}) 的元素「${fromSelector}」没有读到值` +
          `（元素不存在 / 还没加载出来 / 值为空）。请先 read_tab 确认能读到，再搬运。`,
        evidence: { fromSelector, fromAttr: fromAttr || null },
      });
    }

    // 交给 input 走完整闸门（凭证硬拦 / HITL / 新鲜度 / 回读）
    const inputHandler = getActionHandler("input");
    if (!inputHandler) return fail("内部错误：input 动作未注册");
    const result = await inputHandler({ index, text: value, clear: true }, ctx);
    const tabNote = `${tabIdOf(source)}(*${tabPosition(source) || 1}) → 当前标签 #${index}`;
    if (!result.success) {
      return {
        ...result,
        error: `${result.error ?? "填写失败"}（搬运 ${tabNote}）`,
      };
    }
    return ok(`已搬运 ${tabNote}（值未经模型转述，长度 ${value.length}）`, {
      metadata: { ...(result.metadata ?? {}), fromSelector, fromTab: tabIdOf(source) },
    });
  });

  registerAction("extract", async (params, ctx) => {
    const query = str(params.query).trim();
    if (!query) return fail("extract 需要 query");
    /*
     * 正文一律走**页面阅读**这一条共用路径（净化可见文本 + 结果页结构化首条），
     * 不再自己 clone+innerText —— 那套会退化成 textContent，把 CSS 当正文喂给模型
     * （用户现场：百度结果页 extract 只回「大片 CSS」，模型据此怀疑首条结果、白烧两步）。
     */
    const reading = await extractPageReading(ctx.page, { visibleTextMaxChars: 12_000 });
    const body = formatPageReadingForLlm(reading, { includeRules: false });
    const client = createLlmClient(ctx.aiSettings);
    // 走统一意图路由：不在核心循环里写死任何模型 ID（未配置时抛明确配置错误）
    const model = createModelRouter(ctx.aiSettings).resolve("logic").model;
    const wait = beginAgentLlmWait({ timeoutMs: 45_000 });
    try {
      const completion = await client.chat.completions.create(
        {
          model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "你是页面信息提取器。只根据给定正文回答用户查询，不要编造。用简洁中文或用户要求的格式。",
            },
            {
              role: "user",
              content: `查询：${query}\n\n页面正文：\n${body.slice(0, 60_000)}`,
            },
          ],
        } as never,
        { signal: wait.signal },
      );
      const text = completion.choices[0]?.message?.content?.trim() || "(空)";
      return ok(text, { includeExtractedContentOnlyOnce: true, extractedContent: text });
    } finally {
      wait.stop();
    }
  });

  /**
   * 当前页总结 / 分析。
   *
   * 信息型目标（「总结这个网站」「分析当前页面」）的阅读对象就是**当前打开的页面**：
   * 本动作确定性采集页面结构 + 可见正文，一次模型归纳出「定位 / 功能与栏目 / 要点 /
   * 注意 / 不确定」，Markdown 直接作为交付正文回给模型去 done。**不滚动、不导航**。
   */
  registerAction("page_summary", async (params, ctx) => {
    const saveReport = bool(params.save_report, false);
    const controlLabels = [...(ctx.browserState?.selectorMap?.values() ?? [])]
      .map((el) => String(el.text ?? "").trim())
      .filter(Boolean)
      .slice(0, 60);
    const result = await summarizeCurrentPage(ctx.page, {
      aiSettings: ctx.aiSettings,
      goal: ctx.goal,
      signal: ctx.signal,
      controlLabels,
    });
    if (result.snapshot.mainText.length === 0 && result.snapshot.headings.length === 0) {
      return fail("当前页没有可读取的可见内容（页面可能还没加载完或不是内容页）；请先 wait 或确认页面已打开");
    }

    let savedPath = "";
    if (saveReport) {
      savedPath = ctx.fileSystem.writeFile(reportFileName(result.snapshot), result.markdown, false);
      ctx.artifacts?.push({
        kind: "file",
        name: savedPath,
        url: ctx.page.url().slice(0, 500),
        step: -1,
      });
      ctx.logger.agentProgress(`总结报告已落盘：${savedPath}`, { phase: "page_summary" });
    }

    // 页面内容确实读过 → 信息型目标的完成度验收有据可依（content_extracted 事实由
    // core/completion_evidence 的统一入口登记，这里不再重复落账）
    ctx.logger.agentProgress(
      `页面已总结：${result.headline}${result.summary.modelUsed ? "" : "（降级：未做语义归纳）"}`,
      {
        phase: "page_summary",
        modelUsed: result.summary.modelUsed,
        headings: result.snapshot.headings.length,
        chars: result.snapshot.mainText.length,
      },
    );

    return ok(result.markdown, {
      includeExtractedContentOnlyOnce: true,
      metadata: {
        pageSummary: {
          url: result.snapshot.url,
          host: result.snapshot.host,
          modelUsed: result.summary.modelUsed,
          reportPath: savedPath || null,
        },
      },
    });
  });

  registerAction("search_page", async (params, ctx) => {
    const pattern = str(params.pattern);
    if (!pattern) return fail("search_page 需要 pattern");
    const useRegex = bool(params.regex, false);
    const caseSensitive = bool(params.case_sensitive, false);
    const maxResults = Math.min(50, Math.max(1, num(params.max_results, 25)));
    const contextChars = Math.min(400, Math.max(40, num(params.context_chars, 150)));
    const matches = await ctx.page.evaluate(
      ({ pattern, useRegex, caseSensitive, maxResults, contextChars }) => {
        const text = document.body?.innerText || "";
        const out: string[] = [];
        if (useRegex) {
          const flags = caseSensitive ? "g" : "gi";
          const re = new RegExp(pattern, flags);
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) && out.length < maxResults) {
            const i = m.index;
            out.push(text.slice(Math.max(0, i - contextChars), i + m[0].length + contextChars));
          }
        } else {
          const hay = caseSensitive ? text : text.toLowerCase();
          const needle = caseSensitive ? pattern : pattern.toLowerCase();
          let from = 0;
          while (out.length < maxResults) {
            const i = hay.indexOf(needle, from);
            if (i < 0) break;
            out.push(text.slice(Math.max(0, i - contextChars), i + pattern.length + contextChars));
            from = i + Math.max(1, needle.length);
          }
        }
        return out;
      },
      { pattern, useRegex, caseSensitive, maxResults, contextChars },
    );
    const content = matches.length
      ? `找到 ${matches.length} 处：\n${matches.map((m, i) => `${i + 1}. …${m}…`).join("\n")}`
      : "未找到匹配";
    return ok(content, { includeExtractedContentOnlyOnce: true, extractedContent: content });
  });

  registerAction("find_elements", async (params, ctx) => {
    const selector = str(params.selector).trim();
    if (!selector) return fail("find_elements 需要 selector");
    const maxResults = Math.min(100, Math.max(1, num(params.max_results, 50)));
    const includeText = bool(params.include_text, true);
    const attributes = Array.isArray(params.attributes)
      ? params.attributes.filter((x): x is string => typeof x === "string")
      : [];
    const rows = await ctx.page.evaluate(
      ({ selector, maxResults, includeText, attributes }) => {
        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, maxResults);
        return nodes.map((n) => {
          const el = n as HTMLElement;
          const row: Record<string, string> = { tag: el.tagName.toLowerCase() };
          if (includeText) row.text = (el.innerText || "").trim().slice(0, 200);
          for (const a of attributes) {
            row[a] = el.getAttribute(a) || "";
          }
          return row;
        });
      },
      { selector, maxResults, includeText, attributes },
    );
    const content = JSON.stringify(rows, null, 2);
    return ok(`匹配 ${rows.length} 个元素\n${content}`, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
    });
  });

  registerAction("dropdown_options", async (params, ctx) => {
    const index = num(params.index);
    const el = ctx.resolveElement(index);
    if (!el) return failMissingIndex(ctx, index);
    const locator = elementPlaywrightSelector(el);
    if (!locator) return fail(`dropdown_options：index [${index}] 没有可用的定位器`);
    try {
      const options = await ctx.page.locator(locator).first().evaluate((node) => {
        const select = node as HTMLSelectElement;
        if (select.tagName === "SELECT") {
          return Array.from(select.options).map((o) => o.text);
        }
        const owned = select.getAttribute("aria-controls");
        const list = owned ? select.ownerDocument.getElementById(owned) : null;
        const root = list ?? select;
        const local = Array.from(root.querySelectorAll('[role="option"], option, li'))
          .map((o) => (o.textContent || "").trim())
          .filter(Boolean);
        if (local.length > 0) return local;
        const visible = (node: Element) => {
          const style = getComputedStyle(node);
          const rect = (node as HTMLElement).getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
        };
        return Array.from(select.ownerDocument.querySelectorAll('[role="option"], [role="menuitem"]'))
          .filter((node) => visible(node))
          .map((o) => (o.textContent || "").trim())
          .filter(Boolean);
      });
      const content = options.slice(0, 80).join("\n");
      return ok(content || "(无选项)", {
        includeExtractedContentOnlyOnce: true,
        extractedContent: content,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`dropdown_options 读取失败：${msg.slice(0, 240)}`);
    }
  });

  registerAction("select_dropdown", async (params, ctx) => {
    const index = num(params.index);
    const text = str(params.text).trim();
    const el = ctx.resolveElement(index);
    if (!el) return failMissingIndex(ctx, index);
    if (!text) return fail("select_dropdown 需要 text");
    const resolvedDoc = await resolveElementDocument(ctx, el);
    if ("fail" in resolvedDoc) return resolvedDoc.fail;
    const doc = resolvedDoc.doc;
    const stale = await guardStaleIndex(ctx, el, index, doc.scope);
    if (stale) return stale;
    const gw = resolveGateway(ctx.page);
    const label = el.text || el.tagName;
    const locator = elementPlaywrightSelector(el);
    const nativeSelect = String(el.tagName || "").toUpperCase() === "SELECT";
    const choiceMeta = { choiceChanged: true, choiceLabel: text.slice(0, 80) };
    try {
      if (nativeSelect) {
        await gw.selectOption(locator, text, {
          semanticLabel: label,
          scope: doc.scope,
          offset: doc.offset,
        });
        return ok(`已选择 [${index}] → ${text}`, { metadata: choiceMeta });
      }
      const target = doc.scope.locator(locator).first();
      const popup = await popupDisclosureState(doc.scope, locator);
      if (popup !== "open") {
        await target.click({ timeout: 3_000 });
        await doc.scope.waitForTimeout(250);
      }
      const picked = await doc.scope.evaluate((wanted) => {
        const want = wanted.replace(/\s+/g, "").toLowerCase();
        const visible = (node: Element) => {
          const style = getComputedStyle(node);
          const rect = (node as HTMLElement).getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
        };
        const nodes = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li'));
        const textOf = (node: Element) => (node.textContent || "").replace(/\s+/g, "").toLowerCase();
        const exact = nodes.find((node) => visible(node) && textOf(node) === want);
        const hit = (exact ?? nodes.find((node) => visible(node) && textOf(node).includes(want))) as HTMLElement | undefined;
        if (!hit) return { ok: false, detail: "列表里没有匹配的可见选项" };
        hit.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        hit.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        hit.click();
        return { ok: true, detail: (hit.innerText || hit.textContent || "").trim().slice(0, 40) };
      }, text);
      if (!picked.ok) {
        return fail(`select_dropdown 未选中「${text}」：${picked.detail}`);
      }
      gw.recordClick({ selector: `text=${text}`, label: text });
      return ok(`已选择 [${index}] → ${picked.detail || text}`, { metadata: choiceMeta });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`select_dropdown 未选中「${text}」：${msg.slice(0, 240)}`);
    }
  });

  registerAction("screenshot", async (params, ctx) => {
    const fileName = str(params.file_name).trim();
    if (fileName) {
      try {
        const buf = await captureScreenshot(ctx.page, { type: "png", fullPage: false });
        const path = ctx.fileSystem.writeBinaryFile(
          fileName.endsWith(".png") ? fileName : `${fileName}.png`,
          buf,
        );
        return ok(`截图已保存 ${path}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`${SCREENSHOT_CAPABILITY_ERROR}（${msg}）`);
      }
    }
    // 先探针能否截图；失败立即报权限/能力错误，禁止「已请求」后静默截图关闭
    try {
      await captureScreenshot(ctx.page, { type: "jpeg", quality: 40, fullPage: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
        return fail(`${SCREENSHOT_CAPABILITY_ERROR}（${msg}）`);
    }
    ctx.setIncludeScreenshotNext(true);
    return ok("已请求下一轮附带截图（将强制拍视口图并交给决策模型）");
  });

  registerAction("write_file", async (params, ctx) => {
    const fileName = str(params.file_name).trim();
    const content = str(params.content);
    const append = bool(params.append, false);
    if (!fileName) return fail("write_file 需要 file_name");
    const path = ctx.fileSystem.writeFile(fileName, content, append);
    return ok(`已写入 ${path}`);
  });

  registerAction("replace_file", async (params, ctx) => {
    const fileName = str(params.file_name).trim();
    const oldStr = str(params.old_str);
    const newStr = str(params.new_str);
    const path = ctx.fileSystem.replaceFile(fileName, oldStr, newStr);
    return ok(`已替换 ${path}`);
  });

  registerAction("read_file", async (params, ctx) => {
    const fileName = str(params.file_name).trim();
    const content = ctx.fileSystem.readFile(fileName);
    return ok(content, { includeExtractedContentOnlyOnce: true, extractedContent: content });
  });

  registerAction("evaluate", async (params, ctx) => {
    const code = str(params.code).trim();
    if (!code) return fail("evaluate 需要 code");
    const banned =
      /navigator\.|webgl|WebGL|AudioContext|canvas\.toDataURL|chrome\.runtime|permissions/i;
    if (banned.test(code)) {
      return fail("evaluate 禁止触碰指纹/环境相关 API");
    }
    const blocked = guardSearchConstitution(ctx, {
      actionName: "evaluate",
      scriptText: code,
    });
    if (blocked) return blocked;
    const result = await ctx.page.evaluate(async (c) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${c})`);
      const v = fn();
      return typeof v?.then === "function" ? await v : v;
    }, code);
    return ok(`evaluate 结果: ${JSON.stringify(result)?.slice(0, 2000)}`);
  });

  registerAction("upload_file", async (params, ctx) => {
    const index = num(params.index);
    const path = str(params.path).trim();
    const el = ctx.resolveElement(index);
    if (!el) return failMissingIndex(ctx, index);
    if (!path) return fail("upload_file 需要 path");
    await ctx.page.locator(el.selector).first().setInputFiles(path);
    return ok(`已上传文件到 [${index}]`);
  });

  registerAction("download", async (params, ctx) => {
    const profileId = String(ctx.profileId || "unknown");
    const ordinal = Math.trunc(num(params.ordinal ?? params.nth));
    const urlParam = str(params.url).trim();
    const index = params.index == null || params.index === "" ? 0 : num(params.index);
    const preferred = str(params.filename || params.file_name).trim();
    let saved: { success: boolean; localPath?: string; error?: string };
    let source = "";
    let usedOrdinal: number | undefined;

    if (urlParam) {
      saved = await downloadMediaFromUrl(ctx.page, urlParam, profileId, {
        preferredBaseName: preferred || null,
      });
      source = urlParam;
    } else if (index > 0) {
      const el = ctx.resolveElement(index);
      if (!el) return failMissingIndex(ctx, index);
      const locator = el.selector || (el.xpath ? `xpath=${el.xpath}` : "");
      if (!locator) return fail(`download：index [${index}] 没有可用的定位器`);
      saved = await downloadStaticMedia(ctx.page, locator, "src", profileId);
      if (!saved.success) {
        saved = await downloadTriggeredFile(ctx.page, locator, profileId);
      }
      source = locator;
    } else if (ordinal > 0) {
      const urls = await listContentMediaUrls(ctx.page);
      const picked = urls[ordinal - 1];
      if (!picked) {
        return fail(
          `download：页面上可用的内容图只有 ${urls.length} 张（已忽略过小的图标），没有第 ${ordinal} 张。请先滚到目标出现，或改用 index / url。`,
        );
      }
      saved = await downloadMediaFromUrl(ctx.page, picked, profileId, {
        preferredBaseName: preferred || `item-${ordinal}`,
      });
      source = picked;
      usedOrdinal = ordinal;
    } else {
      return fail("download 需要 url、index 或 ordinal（第几张，从 1 开始）三者之一");
    }

    if (!saved.success || !saved.localPath) {
      return fail(saved.error || "下载失败：没有落盘路径");
    }
    ctx.artifacts?.push({
      kind: "download",
      name: saved.localPath,
      url: source.slice(0, 500),
      step: -1,
      ...(usedOrdinal ? { ordinal: usedOrdinal } : {}),
    });
    ctx.evidence?.facts.push({
      kind: "file_downloaded",
      step: -1,
      url: ctx.page.url(),
      detail: saved.localPath.slice(0, 160),
    });
    ctx.logger.agentProgress?.(`已下载：${saved.localPath}`, {
      phase: "download",
      ordinal: usedOrdinal ?? null,
      profileId,
    });
    return ok(`已下载到 ${saved.localPath}`, {
      metadata: { downloadPath: saved.localPath, ordinal: usedOrdinal ?? null },
    });
  });

  registerAction("save_as_pdf", async (params, ctx) => {
    const fileName = str(params.file_name, "page").trim() || "page";
    const pdf = await ctx.page.pdf({
      printBackground: bool(params.print_background, true),
      landscape: bool(params.landscape, false),
    });
    const path = ctx.fileSystem.writeBinaryFile(
      fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`,
      pdf,
    );
    return ok(`PDF 已保存 ${path}`);
  });

  registerAction("done", async (params, ctx) => {
    const text = str(params.text, "");
    const success = bool(params.success, true);
    if (!success) {
      return {
        isDone: true,
        success: false,
        extractedContent: text,
        longTermMemory: text,
      };
    }

    // 先过「一次性凭证」硬闸：页面上还有空的邮箱/短信/验证器码字段时，
    // 无论证据多充分都不算完成 —— 这正是用户报障的那一步。
    const credentialGate = await guardPendingHumanCredential(ctx);
    if (credentialGate) {
      ctx.logger.agentProgress("done 被驳回：存在待人工提供的一次性凭证", {
        phase: "human_credential_gate",
      });
      return credentialGate;
    }

    /*
     * 再过「用户自定义规则」硬校验（「规则」窗口的完成条件）：
     * 严格条件由系统按用户给的 CSS 选择器/文本或界面参考图机器核对，不通过就不放行。
     * 位置在凭证闸门之后、交付物闸门之前 —— 支付/OTP 红线优先，其次才是用户判据。
     */
    const taskRuleRuntime: TaskRulesRuntime | null = ctx.taskRules ?? null;
    const ruleViolation = await guardUserConstraints(taskRuleRuntime, {
      page: ctx.page,
      aiSettings: ctx.aiSettings,
      // 用主循环的真实步号（单测直调缺省时回落到证据条数，保持原行为）
      step: ctx.step ?? ctx.evidence?.facts.length ?? 0,
      signal: ctx.signal,
      allowVision: true,
    });
    if (ruleViolation) {
      if (ctx.evidence) ctx.evidence.rejections += 1;
      ctx.logger.agentProgress(
        `done 被驳回（用户硬约束未满足）：${ruleViolation.reason.slice(0, 220)}`,
        {
          phase: "task_rule_gate",
          ruleIds: ruleViolation.ruleIds,
          inconclusiveRuleIds: ruleViolation.inconclusiveRuleIds,
          kinds: ruleViolation.kinds,
          hits: describeHits(taskRuleRuntime),
        },
      );
      if (ruleViolation.inconclusiveRuleIds.length > 0) {
        ctx.logger.agentProgress(
          "用户规则中有条件无法判定（inconclusive），已按 fail-closed 拦下：不谎报为「未出现」",
          { phase: "task_rule_inconclusive", ruleIds: ruleViolation.inconclusiveRuleIds },
        );
      }
      return fail(ruleViolation.reason);
    }

    // 再过「交付物逐项」闸门：契约里每一项都必须有可核销的完成证据。
    // 它比证据闸门更早开口，因为「还差哪一项」才是模型下一步能直接照做的信息。
    const deliverableGate = await guardPendingDeliverables(ctx, text);
    if (deliverableGate) return deliverableGate;

    // 用户完成条件全部核对通过时，把它作为 done 的达成依据：用户自己下的判据优先于通用证据推断。
    // （支付闸门仍在 evaluateCompletion 内最先判定，不会被这里绕过。）
    const userRules =
      taskRuleRuntime?.hasStrictComplete === true
        ? { satisfied: true, details: describeHits(taskRuleRuntime) }
        : undefined;

    const verdict = await verifyCompletionEvidence(ctx, text, userRules);
    if (!verdict.acceptable) {
      // 不是「提前结束」，而是「拒绝结束」：以失败结果返回，让模型按指引补证据后继续。
      ctx.evidence!.rejections += 1;
      ctx.logger.agentProgress(
        `done 被驳回（第 ${ctx.evidence!.rejections} 次）：${verdict.guidance.slice(0, 220)}`,
        {
          phase: "completion_gate",
          goalIntent: verdict.goalIntent,
          supports: verdict.supports,
          counter: verdict.counter,
        },
      );
      return fail(`${verdict.guidance}`);
    }

    if (verdict.forced) {
      const stillPending = ctx.deliverables ? listPendingDeliverables(ctx.deliverables) : [];
      ctx.logger.agentProgress("done 放行但标注「未验证」（已到驳回上限）", {
        phase: "completion_gate",
        goalIntent: verdict.goalIntent,
        forced: true,
        supports: verdict.supports,
        pendingDeliverables: stillPending.map((item) => item.spec.id),
      });
      // 放行也必须留痕：未核销的交付物直接写进交付文案，用户与 judge 都能看出「哪些没做完」
      const pendingNote = stillPending.length
        ? `\n[未核销交付物] ${stillPending
            .map((item) => `[${item.spec.id}] ${item.spec.text}`)
            .join("；")}`
        : "";
      const annotated = `${annotateUnverified(text)}${pendingNote}`;
      return {
        isDone: true,
        success: true,
        extractedContent: annotated,
        longTermMemory: annotated,
      };
    }

    ctx.logger.agentProgress(
      `done 验收通过 · 依据：${verdict.supports.join("；").slice(0, 200) || "无（无需证据的任务）"}`,
      { phase: "completion_gate", goalIntent: verdict.goalIntent },
    );
    return {
      isDone: true,
      success: true,
      extractedContent: text,
      longTermMemory: text,
    };
  });

  registerAction("scrape_page_data", async (params, ctx) => {
    const targetDescription = str(params.targetDescription || params.target_description).trim();
    const result = await scrapePageData(ctx.page, {
      mode: "dom",
      targetDescription: targetDescription || undefined,
      fields:
        params.fields && typeof params.fields === "object" && !Array.isArray(params.fields)
          ? (params.fields as Record<string, string>)
          : undefined,
      autoScroll: bool(params.autoScroll ?? params.auto_scroll, false),
      profileId: ctx.profileId,
      aiSettings: ctx.aiSettings,
    });
    const content = JSON.stringify(result).slice(0, 12_000);
    return ok(content, { includeExtractedContentOnlyOnce: true, extractedContent: content });
  });

  /**
   * P1.2 Layer 2：从已配置邮箱通道取 OTP，并写入邮箱类 human_only 字段。
   * 码不进轨迹/longTermMemory；短信/TOTP/支付 critical/图形验证码均禁止走本动作。
   */
  registerAction("fetch_email_otp", async (params, ctx) => {
    const channel = parseOtpChannel(ctx.otpChannel);
    if (!isOtpChannelConfigured(channel)) {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_email_otp",
        message:
          "邮箱 OTP 通道未配置（not_configured）。请 ask_user 向用户索取邮箱验证码，或 handover_to_human；" +
          "也可在设置中绑定 IMAP/临时邮。网页邮箱不是默认路径，须在设置中显式启用后才会使用。禁止猜测/编造。",
        evidence: { reason: "not_configured" },
      });
    }

    const pending = findPendingHumanCredentials(ctx.browserState.selectorMap.values());
    const indexParam = params.index != null ? num(params.index) : NaN;
    let target =
      Number.isFinite(indexParam) && indexParam > 0
        ? pending.find((item) => item.index === indexParam) ?? null
        : pending.find((item) => isEmailOtpChannelEligible(item.kind)) ?? null;

    // 指定了 index 但不在 pending：仍允许对已标 human_only 的邮箱字段取码填入
    if (!target && Number.isFinite(indexParam) && indexParam > 0) {
      const el = ctx.resolveElement(indexParam);
      const reason = String(el?.humanOnly ?? "").trim();
      if (el && reason) {
        const label = String(el.text || el.placeholder || el.name || `[${indexParam}]`)
          .trim()
          .slice(0, 60);
        const kind = classifyHumanCredentialKind({ label, reason });
        target = { index: indexParam, label, reason, filled: false, kind };
      }
    }

    if (!target) {
      return fail(
        "当前页没有可走邮箱通道的空验证码字段。请先 click「发送验证码/获取验证码」，再 fetch_email_otp；" +
          "短信/验证器字段禁止用本工具。",
      );
    }
    if (!isEmailOtpChannelEligible(target.kind)) {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_email_otp",
        targetKey: failureTargetKey("index", target.index),
        message:
          `字段 [${target.index}] ${target.label} 是 ${target.kind} 类凭证，禁止走邮箱通道。` +
          `请 ask_user 或 handover；禁止猜测。`,
        evidence: { index: target.index, kind: target.kind },
      });
    }

    // 支付等 critical 字段永不自动填充
    const risk = decideHitlConfirm({
      kind: "fill",
      label: target.label,
      value: "",
      goal: ctx.goal ?? "",
      page: { url: ctx.page.url() || ctx.browserState?.url || "" },
    });
    if (risk.level === "critical") {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_email_otp",
        targetKey: failureTargetKey("index", target.index),
        message:
          `字段 [${target.index}] ${target.label} 命中支付/critical 风险（${risk.reason}），禁止自动填充。` +
          `请 handover 或经人工确认后填写。`,
        evidence: { index: target.index, level: risk.level, matched: risk.matched },
      });
    }

    const timeoutMs = Math.max(
      1_000,
      Math.min(180_000, Number(params.timeout_ms ?? params.timeoutMs ?? 45_000) || 45_000),
    );
    const sinceIso =
      String(params.since_iso ?? params.sinceIso ?? "").trim() ||
      new Date(Date.now() - 15 * 60_000).toISOString();
    const fromHint = String(params.from_hint ?? params.fromHint ?? "").trim() || undefined;
    const subjectHint = String(params.subject_hint ?? params.subjectHint ?? "").trim() || undefined;

    ctx.logger.agentProgress?.(`邮箱 OTP 通道取码中…（字段 [${target.index}] ${target.label}）`, {
      phase: "fetch_email_otp",
      index: target.index,
      kind: target.kind,
      channelType: channel.type,
    });

    const fetched = await fetchEmailOtp({
      channel,
      request: { sinceIso, fromHint, subjectHint, timeoutMs },
      resolveSecret: ctx.resolveOtpSecret,
      transport: ctx.otpMailTransport,
      webmailReader:
        channel.type === "webmail_adapter"
          ? (input) => readWebmailInboxPage(ctx.page, input)
          : undefined,
      log: (message, data) => {
        ctx.logger.agentProgress?.(message, { phase: "fetch_email_otp", ...(data ?? {}) });
      },
    });

    if (!fetched.ok) {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_email_otp",
        targetKey: failureTargetKey("index", target.index),
        message:
          `邮箱 OTP 通道失败（${fetched.reason}）。已升 Layer 3：请 ask_user 索取邮箱验证码，或 handover_to_human。` +
          `禁止猜测/编造。`,
        evidence: { reason: fetched.reason, index: target.index },
      });
    }

    stashChannelEmailOtp(ctx.evidence, {
      code: fetched.code,
      messageId: fetched.messageId,
      fetchedAt: Date.now(),
    });

    const inputHandler = getActionHandler("input");
    if (!inputHandler) {
      // 极少见：注册不完整；丢弃码，避免泄漏
      if (ctx.evidence) ctx.evidence.channelEmailOtp = null;
      return fail("内部错误：input 动作未注册，无法写入邮箱验证码");
    }

    const fillResult = await inputHandler(
      { index: target.index, text: fetched.code, clear: true },
      ctx,
    );

    // 无论成败，确保码不残留在台账（input 成功路径会 consume；失败则这里清掉）
    if (ctx.evidence?.channelEmailOtp) {
      ctx.evidence.channelEmailOtp = null;
    }

    if (fillResult.error || fillResult.success === false) {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_email_otp",
        targetKey: failureTargetKey("index", target.index),
        message:
          `邮箱通道已取到码，但写入 [${target.index}] ${target.label} 失败：${fillResult.error ?? "unknown"}。` +
          `请 ask_user / handover；禁止把码写入文件或 memory。`,
        evidence: { index: target.index, fillFailed: true },
      });
    }

    const safeMsg = `已从邮箱 OTP 通道取得验证码并填入 [${target.index}] ${target.label}（码未写入轨迹）。请继续后续步骤。`;
    return {
      success: true,
      extractedContent: safeMsg,
      longTermMemory: safeMsg,
      metadata: {
        ...(fillResult.metadata ?? {}),
        channelProvided: true,
        channelOtp: true,
        index: target.index,
      },
    };
  });

  /**
   * P5.3 Layer 2：从已启用短信接码平台取 OTP，并写入短信类 human_only 字段。
   * 默认关；未启用/失败 → Layer 3 HITL。TOTP/支付 critical/邮箱/图形验证码禁止走本动作。
   */
  registerAction("fetch_sms_otp", async (params, ctx) => {
    const service = parseSmsOtpService(ctx.smsOtpService);
    if (!isSmsOtpServiceConfigured(service)) {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_sms_otp",
        message:
          "短信接码平台未启用（not_configured）。默认关闭；请 ask_user 索取短信验证码，或 handover_to_human；" +
          "也可在设置中显式启用接码平台后再试。禁止猜测/编造。",
        evidence: { reason: "not_configured" },
      });
    }

    const pending = findPendingHumanCredentials(ctx.browserState.selectorMap.values());
    const indexParam = params.index != null ? num(params.index) : NaN;
    let target =
      Number.isFinite(indexParam) && indexParam > 0
        ? pending.find((item) => item.index === indexParam) ?? null
        : pending.find((item) => isSmsOtpChannelEligible(item.kind)) ?? null;

    if (!target && Number.isFinite(indexParam) && indexParam > 0) {
      const el = ctx.resolveElement(indexParam);
      const reason = String(el?.humanOnly ?? "").trim();
      if (el && reason) {
        const label = String(el.text || el.placeholder || el.name || `[${indexParam}]`)
          .trim()
          .slice(0, 60);
        const kind = classifyHumanCredentialKind({ label, reason });
        target = { index: indexParam, label, reason, filled: false, kind };
      }
    }

    if (!target) {
      return fail(
        "当前页没有可走短信通道的空验证码字段。请先 click「发送验证码/获取验证码」，再 fetch_sms_otp；" +
          "邮箱请用 fetch_email_otp；验证器字段禁止用本工具。",
      );
    }
    if (!isSmsOtpChannelEligible(target.kind)) {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_sms_otp",
        targetKey: failureTargetKey("index", target.index),
        message:
          `字段 [${target.index}] ${target.label} 是 ${target.kind} 类凭证，禁止走短信接码通道。` +
          `请改用对应工具或 ask_user / handover；禁止猜测。`,
        evidence: { index: target.index, kind: target.kind },
      });
    }

    const risk = decideHitlConfirm({
      kind: "fill",
      label: target.label,
      value: "",
      goal: ctx.goal ?? "",
      page: { url: ctx.page.url() || ctx.browserState?.url || "" },
    });
    if (risk.level === "critical") {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_sms_otp",
        targetKey: failureTargetKey("index", target.index),
        message:
          `字段 [${target.index}] ${target.label} 命中支付/critical 风险（${risk.reason}），禁止自动填充。` +
          `请 handover 或经人工确认后填写。`,
        evidence: { index: target.index, level: risk.level, matched: risk.matched },
      });
    }

    const timeoutMs = Math.max(
      1_000,
      Math.min(180_000, Number(params.timeout_ms ?? params.timeoutMs ?? 90_000) || 90_000),
    );
    const activationId =
      String(params.activation_id ?? params.activationId ?? "").trim() || undefined;

    ctx.logger.agentProgress?.(`短信接码平台取码中…（字段 [${target.index}] ${target.label}）`, {
      phase: "fetch_sms_otp",
      index: target.index,
      kind: target.kind,
      providerId: service.type === "third_party" ? service.providerId : undefined,
    });

    const fetched = await fetchSmsOtp({
      service,
      activationId,
      timeoutMs,
      resolveSecret: ctx.resolveSmsOtpSecret ?? ctx.resolveOtpSecret,
      signal: ctx.signal,
      log: (message, data) => {
        ctx.logger.agentProgress?.(message, { phase: "fetch_sms_otp", ...(data ?? {}) });
      },
    });

    if (!fetched.ok) {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_sms_otp",
        targetKey: failureTargetKey("index", target.index),
        message:
          `短信接码失败（${fetched.reason}）。已升 Layer 3：请 ask_user 索取短信验证码，或 handover_to_human。` +
          `禁止猜测/编造。`,
        evidence: { reason: fetched.reason, index: target.index, detail: fetched.detail },
      });
    }

    stashChannelSmsOtp(ctx.evidence, {
      code: fetched.code,
      messageId: fetched.messageId,
      fetchedAt: Date.now(),
    });

    const inputHandler = getActionHandler("input");
    if (!inputHandler) {
      if (ctx.evidence) ctx.evidence.channelSmsOtp = null;
      return fail("内部错误：input 动作未注册，无法写入短信验证码");
    }

    const fillResult = await inputHandler(
      { index: target.index, text: fetched.code, clear: true },
      ctx,
    );

    if (ctx.evidence?.channelSmsOtp) {
      ctx.evidence.channelSmsOtp = null;
    }

    if (fillResult.error || fillResult.success === false) {
      return failKind(ctx, {
        kind: "needs-human",
        action: "fetch_sms_otp",
        targetKey: failureTargetKey("index", target.index),
        message:
          `短信通道已取到码，但写入 [${target.index}] ${target.label} 失败：${fillResult.error ?? "unknown"}。` +
          `请 ask_user / handover；禁止把码写入文件或 memory。`,
        evidence: { index: target.index, fillFailed: true },
      });
    }

    const safeMsg = `已从短信接码平台取得验证码并填入 [${target.index}] ${target.label}（码未写入轨迹）。请继续后续步骤。`;
    return {
      success: true,
      extractedContent: safeMsg,
      longTermMemory: safeMsg,
      metadata: {
        ...(fillResult.metadata ?? {}),
        channelProvided: true,
        channelSmsOtp: true,
        index: target.index,
      },
    };
  });

  registerAction("ask_user", async (params, ctx) => {
    const question = str(params.question || params.text).trim() || "请提供所需信息";
    // 通用：问「点哪个图标/语言球」不是 HITL，禁止空转 ask_user
    if (isVisualTargetQuestion(question)) {
      const router = createModelRouter(ctx.aiSettings);
      if (!isIntentConfigured(router.pool, "vision")) {
        return fail(VISION_CAPABILITY_ERROR);
      }
      return fail(
        "不要用 ask_user 询问要点哪个图标/图片/语言入口。请改用 ask_vision_locate(query=清晰形态描述, click=true)。",
      );
    }
    // 禁止把 recall_skill 手册全文当「问题」卡住人工
    if (
      /#\s*Skill:|##\s*何时用|网格化定位|格号\s*[-→>]|禁止\s*`?ask_user|本轮唯一动作/i.test(question) ||
      (question.length > 800 && /Skill:|何时用|suggestedSkill|recall_skill/i.test(question))
    ) {
      return fail(
        "ask_user 的 question 不能是技能手册/召回正文。点选请 solve_captcha；" +
          "邮箱码优先 fetch_email_otp；短信码优先 fetch_sms_otp（须显式启用）；验证器码才用 ask_user 问短问题。",
      );
    }
    const requestId = randomUUID();
    const pageUrl = ctx.page.url();
    // P1.4：Layer 3 情境文案（LLM + 模板兜底）
    const ai_copy = await resolveHitlAiCopy({
      channel: "ask",
      goal: ctx.goal ?? "",
      url: pageUrl,
      pageTitle: ctx.browserState?.title,
      elements: elementsFromSelectorMap(ctx.browserState?.selectorMap),
      captchaAttempts: getCaptchaAttempts(ctx.page),
      rawHint: question,
      aiSettings: ctx.aiSettings,
      signal: ctx.signal,
    });
    ctx.logger.agentAskUser({
      requestId,
      question,
      url: pageUrl,
      profileId: ctx.profileId,
      ai_copy,
      phase: "hitl_ai_copy",
      ...(() => {
        const raw =
          (typeof ctx.browserState?.screenshotBase64 === "string" &&
            ctx.browserState.screenshotBase64.trim()) ||
          (typeof ctx.browserState?.screenshotList?.[0] === "string" &&
            ctx.browserState.screenshotList[0].trim()) ||
          "";
        return raw && raw.length <= 180_000 ? { screenshotBase64: raw } : {};
      })(),
    });
    const answer = await ctx.askUser(requestId, question, { ai_copy, url: pageUrl });
    return ok(`用户回答: ${answer}`);
  });

  registerAction("handover_to_human", async (params, ctx) => {
    const reason = str(params.reason, "需要人工接管");
    const requestId = randomUUID();
    const pageUrl = ctx.page.url();
    const ai_copy = await resolveHitlAiCopy({
      channel: "handover",
      goal: ctx.goal ?? "",
      url: pageUrl,
      pageTitle: ctx.browserState?.title,
      elements: elementsFromSelectorMap(ctx.browserState?.selectorMap),
      captchaAttempts: getCaptchaAttempts(ctx.page),
      rawHint: reason,
      aiSettings: ctx.aiSettings,
      signal: ctx.signal,
    });
    await ctx.requestHandover({ requestId, reason, url: pageUrl, ai_copy });
    if (
      ctx.evidence &&
      goalDemandsHumanPayment(ctx.goal ?? "", loadCompletionLexicon())
    ) {
      ctx.evidence.humanPaymentConfirmed = true;
    }
    return ok(`人工接管完成，继续执行。原因: ${reason}`);
  });

  registerAction("ask_vision_locate", async (params, ctx) => {
    const query = str(params.query || params.target).trim();
    if (!query) return fail("ask_vision_locate 需要 query");
    const router = createModelRouter(ctx.aiSettings);
    if (!isIntentConfigured(router.pool, "vision")) {
      return fail(VISION_CAPABILITY_ERROR);
    }
    // 短问法自动扩成「先描述再坐标」；语言类补 EN 圆钮线索（形态提示，非站点硬编码）
    const enrichedHint =
      /语言|中文|english|\ben\b|hebrew|עבר|locale/i.test(query) &&
      !/右上|圆形|EN|地球|国旗|图标/i.test(query)
        ? `${query}（常见为右上角语言入口：圆形语种缩写/地球仪/国旗图标）`
        : query;
    try {
      const result = await visionLocateAndClick({
        page: ctx.page,
        goal: ctx.goal,
        question: enrichedHint,
        aiSettings: ctx.aiSettings,
        logger: ctx.logger,
        autoClick: bool(params.click, true),
      });
      if (!result.ok) {
        const detail = result.detail || "视觉定位失败";
        if (/截图失败/i.test(detail)) {
          return fail(`${SCREENSHOT_CAPABILITY_ERROR}（${detail}）`);
        }
        return fail(detail);
      }
      return ok(JSON.stringify(result).slice(0, 2000));
    } catch (err) {
      if (isVisualModelNotConfiguredError(err)) {
        return fail(VISION_CAPABILITY_ERROR);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/截图失败|screenshot/i.test(msg)) {
        return fail(`${SCREENSHOT_CAPABILITY_ERROR}（${msg}）`);
      }
      return fail(`ask_vision_locate 失败：${msg}`);
    }
  });

  registerAction("click_viewport", async (params, ctx) => {
    const xPercent = num(params.xPercent ?? params.x_percent);
    const yPercent = num(params.yPercent ?? params.y_percent);
    await clickViewportPercent(ctx.page, xPercent, yPercent);
    return ok(`视口点击 ${xPercent}%,${yPercent}%`);
  });

  registerAction("restart_browser", async (_params, ctx) => {
    if (!getAgentCdpUrl()) {
      return fail("restart_browser：当前进程没有 CDP 地址，无法重启浏览器");
    }
    armBrowserRestart();
    requestHostBrowserRestart(ctx.profileId);
    try {
      await waitForBrowserRestartCycle(ctx.signal);
      const page = await reconnectAgentBrowser({
        logger: ctx.logger,
        profileId: ctx.profileId || "unknown",
      });
      ctx.setActivePage?.(page);
      return ok(
        "浏览器已重启并重新连接。标签页和未保存内容已清空，旧 index 全部作废。请按当前页面重新导航，不要沿用重启前的编号。",
      );
    } catch (error) {
      disarmBrowserRestart();
      const message = error instanceof Error ? error.message : String(error);
      return fail(`restart_browser 失败：${message}`);
    }
  });

  registerAction("solve_captcha", handleSolveCaptcha);
  registerAction("solve_animated_captcha", handleSolveCaptcha);
  registerAction("solve_slider_captcha", async (params, ctx) => {
    return handleSolveCaptcha({ ...params, strategy: "slider_gap_drag" }, ctx);
  });
  registerAction("solve_math_captcha", async (params, ctx) => {
    return handleSolveCaptcha({ ...params, strategy: "math_image_solve" }, ctx);
  });
  registerAction("solve_point_select_captcha", async (params, ctx) => {
    return handleSolveCaptcha({ ...params, strategy: "point_select_click" }, ctx);
  });
}

async function handleSolveCaptcha(
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ActionResult> {
  const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("Agent 已中止");
  };
  throwIfAborted(ctx.signal);
  const autoFill = bool(params.auto_fill ?? params.autoFill, true);
  const autoSubmit = bool(params.auto_submit ?? params.autoSubmit, true);
  const pageHint = str(params.page_hint || params.hint || ctx.goal).slice(0, 240);
  const forceStrategy = str(params.strategy || params.force_strategy || "").slice(0, 64);

  let unified;
  try {
    unified = await solveCaptcha({
      page: ctx.page,
      aiSettings: ctx.aiSettings,
      logger: ctx.logger,
      selectorMap: ctx.browserState.selectorMap,
      pageHint: pageHint || undefined,
      goalHint: ctx.goal,
      forceStrategy: forceStrategy || undefined,
      fileSystem: ctx.fileSystem,
      signal: ctx.signal,
      captchaService: ctx.captchaService,
      resolveCaptchaSecret: ctx.resolveCaptchaSecret,
    });
  } catch (err) {
    if (isVisualModelNotConfiguredError(err)) {
      return failCaptcha(VISION_CAPABILITY_ERROR);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/已中止|aborted|AbortError/i.test(msg)) {
      return fail("Agent 已中止");
    }
    return failCaptcha(`solve_captcha 失败：${msg}`);
  }

  throwIfAborted(ctx.signal);

  if (unified.kind === "unsupported") {
    return failCaptcha(unified.detail);
  }

  if (unified.kind === "remote") {
    const result = unified.remote;
    if (!result.ok) {
      const signal =
        result.reason === "not_configured" || result.reason === "unsupported_provider"
          ? "remote_not_configured"
          : result.reason === "timeout"
            ? "remote_timeout"
            : "remote_fail";
      return failCaptcha(
        result.detail || `第三方验证码失败（${result.reason}）`,
        "remote",
        signal,
      );
    }
    const payload: Record<string, unknown> = {
      strategy: "token_challenge_remote",
      kind: result.kind,
      providerId: result.providerId,
      verified: result.verified,
      next: result.detail,
    };
    const content = JSON.stringify(payload);
    return ok(content, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
      longTermMemory: `第三方 ${result.kind} token 已注入（${result.providerId}）`,
      success: true,
      metadata: {
        captcha: {
          kind: "remote",
          verified: result.verified,
          signal: "token_injected",
        },
      },
    });
  }

  if (unified.kind === "slider") {
    const result = unified.slider;
    if (result.strategy === "unsupported" || (!result.ok && result.verified === null && result.gapX <= 0)) {
      return failCaptcha(result.detail || "滑块验证码未能完成", "slider");
    }
    const payload: Record<string, unknown> = {
      strategy: "slider_gap_drag",
      gapX: result.gapX,
      dragDistance: result.dragDistance,
      confidence: result.confidence,
      method: result.method,
      verified: result.verified,
      verifySignal: result.verifySignal,
      protocolHints: result.protocolHints,
    };
    if (result.verified === true) {
      payload.next =
        "滑块验证已通过。立即观察页面：若登录/后续流程已自动推进，继续后续步骤；若任务就是过验证码，直接 done(success=true)。禁止再调 solve_captcha。";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else if (result.verified === false) {
      payload.next =
        "滑块失败：captcha_attempt+1；勿刷新；继续只用 solve_captcha（勿换别名空转）；满 3 次必须 handover_to_human。";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else {
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
      payload.next =
        "已拖拽；观察页面：若出现 success/页面跳转则 done(success=true)；否则未满 3 次可再 solve_captcha。";
    }
    const content = JSON.stringify(payload);
    return ok(content, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
      longTermMemory:
        result.verified === true
          ? `滑块验证通过 drag=${result.dragDistance.toFixed(1)}`
          : result.verified === false
            ? `滑块验证失败（${result.verifySignal}）`
            : `滑块已拖拽 gapX=${result.gapX} drag=${result.dragDistance.toFixed(1)}`,
      success: result.verified === false ? false : true,
      metadata: {
        captcha: { kind: "slider", verified: result.verified, signal: result.verifySignal },
      },
    });
  }

  if (unified.kind === "point") {
    const result = unified.point;
    if (result.strategy === "unsupported" || (!result.ok && result.points.length === 0)) {
      return failCaptcha(result.detail || "点选验证码未能完成", "point");
    }
    const payload: Record<string, unknown> = {
      strategy: "point_select_click",
      points: result.points,
      viewportPoints: result.viewportPoints,
      confidence: result.confidence,
      method: result.method,
      verified: result.verified,
      verifySignal: result.verifySignal,
      protocolHints: result.protocolHints,
      crop: result.crop,
    };
    if (result.verified === true) {
      payload.next =
        "点选已通过。立即观察页面：若已自动推进则继续后续步骤；若任务就是过验证码则 done(success=true)。禁止再调 solve_captcha。";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else if (result.verified === false) {
      payload.next =
        "点选失败：captcha_attempt+1；勿刷新；继续只用 solve_captcha；满 3 次 handover_to_human（勿 ask_user 代点）";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else {
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
      payload.next =
        "已拟人点选；观察页面：成功则 done(success=true)；否则未满3次再 solve_captcha";
    }
    const content = JSON.stringify(payload);
    return ok(content, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
      longTermMemory:
        result.verified === true
          ? `点选通过 n=${result.points.length}`
          : result.verified === false
            ? `点选失败（${result.verifySignal}）`
            : `点选已点击 n=${result.points.length}`,
      success: result.verified === false ? false : true,
      metadata: {
        captcha: { kind: "point", verified: result.verified, signal: result.verifySignal },
      },
    });
  }

  if (unified.kind === "pressHold") {
    const result = unified.pressHold;
    if (result.strategy === "unsupported") {
      /*
       * 策略识别命中 Arkose 容器、但当前题并非「按住不放」：这是**路由未命中**，不是一次答错。
       * 按未决（verified=null）处理，避免计入「连续硬失败」而提前触发 HITL；同时明确制止重复空转。
       */
      return fail(
        `${result.detail || "当前验证码不是「按住不放」题型"}。请勿重复调用 solve_captcha 求解长按；` +
          "请按实际题型处理，或 ask_user / handover_to_human。",
        {
          metadata: {
            captcha: { kind: "press_hold", verified: null, signal: "unsupported_strategy" },
          },
        },
      );
    }
    if (result.verified === null && result.holdMs <= 0) {
      return failCaptcha(result.detail || "长按验证码未能完成", "press_hold");
    }
    const payload: Record<string, unknown> = {
      strategy: "press_hold_captcha",
      holdMs: result.holdMs,
      method: result.method,
      verified: result.verified,
      verifySignal: result.verifySignal,
      accessibilityUsed: result.accessibilityUsed,
    };
    if (result.verified === true) {
      payload.next =
        "长按验证已通过。立即观察页面：若登录/后续流程已自动推进，继续后续步骤；若任务就是过验证码，直接 done(success=true)。禁止再调 solve_captcha。";
    } else if (result.verified === false) {
      payload.next =
        "长按验证失败：captcha_attempt+1；勿刷新；继续只用 solve_captcha（勿换别名空转）；满 3 次必须 handover_to_human。";
    } else {
      payload.next =
        "已按住并松开；观察页面：若出现 success/页面跳转则 done(success=true)；否则未满 3 次可再 solve_captcha。";
    }
    const content = JSON.stringify(payload);
    return ok(content, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
      longTermMemory:
        result.verified === true
          ? `长按验证通过 hold=${(result.holdMs / 1000).toFixed(1)}s`
          : result.verified === false
            ? `长按验证失败（${result.verifySignal}）`
            : `长按已执行 hold=${(result.holdMs / 1000).toFixed(1)}s`,
      success: result.verified === false ? false : true,
      metadata: {
        captcha: { kind: "press_hold", verified: result.verified, signal: result.verifySignal },
      },
    });
  }

  if (unified.kind === "math") {
    const result = unified.math;
    if (!result.ok || !result.answer) {
      return failCaptcha(
        result.detail ||
          "未能求解算式。勿刷新；继续只用 solve_captcha（勿改用 solve_math_captcha 空转同一路径）；满 3 次 HITL。",
        "math",
      );
    }

    const payload: Record<string, unknown> = {
      strategy: "math_image_solve",
      expr: result.expr,
      answer: result.answer,
      confidence: result.confidence,
      method: result.method,
      inputIndex: result.formHints.inputIndex,
      submitIndex: result.formHints.submitIndex,
      filled: false,
      submitted: false,
      verified: null as boolean | null,
      verifySignal: "",
    };

    const gw = resolveGateway(ctx.page);
    ctx.logger.agentProgress(
      `④ 答案「${result.answer}」（${result.expr}）→ 填入并点「验证答案」`,
      {
        phase: "math_image_captcha",
        stage: "fill_submit",
        answer: result.answer,
        expr: result.expr,
      },
    );

    if (autoFill && result.formHints.inputIndex != null) {
      const index = result.formHints.inputIndex;
      const el = ctx.resolveElement(index);
      if (el) {
        const sel = elementPlaywrightSelector(el);
        const answer = String(result.answer);
        await gw.fill(sel, answer, {
          semanticLabel: elementLabelBlob(el) || el.tagName,
          humanLike: false,
          append: false,
        });
        // 回读防幻觉/错填：DOM 值必须等于求值结果
        const actual = await ctx.page
          .locator(sel)
          .inputValue()
          .catch(async () =>
            ctx.page.locator(sel).evaluate((n) => String((n as HTMLInputElement).value ?? "")),
          )
          .catch(() => "");
        const norm = (s: string) => String(s).trim().replace(/\s+/g, "");
        if (norm(actual) !== norm(answer)) {
          ctx.logger.warn("math_fill_mismatch_refill", {
            expected: answer,
            actual: String(actual).slice(0, 32),
          });
          await gw.fill(sel, answer, {
            semanticLabel: elementLabelBlob(el) || el.tagName,
            humanLike: false,
            append: false,
          });
          const again = await ctx.page
            .locator(sel)
            .inputValue()
            .catch(() => "");
          if (norm(again) !== norm(answer)) {
            return failCaptcha(
              `算式已求出「${answer}」（${result.expr}），但输入框回读为「${again || actual}」。请下一轮用 input 填入 ${answer}。`,
              "math",
            );
          }
        }
        payload.filled = true;
        payload.filledValue = answer;
      } else {
        return failCaptcha(
          `已算出「${result.answer}」，但输入框 index=${index} 已失效。请下一轮用 input 填入。`,
          "math",
        );
      }
    }

    if (autoSubmit && result.formHints.submitIndex != null && payload.filled) {
      const index = result.formHints.submitIndex;
      const el = ctx.resolveElement(index);
      if (!el) {
        return failCaptcha(
          `已填入「${result.answer}」，但验证按钮 index=${index} 已失效。请下一轮 click 文案含「验证答案」的 index；勿空等。`,
          "math",
        );
      }
      const sel = elementPlaywrightSelector(el);
      try {
        await gw.click(sel, { semanticLabel: el.text });
      } catch {
        if (el.xpath) {
          await gw.click(`xpath=${el.xpath}`, { semanticLabel: el.text });
        } else {
          throw new Error(`验证答案按钮点击失败 index=${index}`);
        }
      }
      payload.submitted = true;
      try {
        const outcome = await checkCaptchaOutcome(ctx.page);
        payload.verified = outcome.verified;
        payload.verifySignal = outcome.signal;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Execution context was destroyed|Target closed|navigat/i.test(msg)) {
          payload.verifySignal = "nav_or_context_destroyed";
          payload.verified = null;
        } else {
          throw err;
        }
      }
    } else if (autoSubmit && payload.filled && result.formHints.submitIndex == null) {
      const hit = findIndexByTextHint(
        ctx.browserState.selectorMap,
        /验证答案/i,
        /提交参赛/i,
      );
      if (hit) {
        const el = ctx.resolveElement(hit.index);
        if (el) {
          await gw.click(elementPlaywrightSelector(el), { semanticLabel: el.text });
          payload.submitted = true;
          payload.submitIndex = hit.index;
          try {
            const outcome = await checkCaptchaOutcome(ctx.page);
            payload.verified = outcome.verified;
            payload.verifySignal = outcome.signal;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/Execution context was destroyed|Target closed|navigat/i.test(msg)) {
              payload.verifySignal = "nav_or_context_destroyed";
              payload.verified = null;
            } else {
              throw err;
            }
          }
        }
      }
    }

    if (payload.verified === true) {
      payload.next =
        "页内已通过验证答案；勿点「提交参赛代码」除非用户目标要求；若任务已达成则 done(success=true)，否则继续任务。禁止再调 solve_captcha。";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else if (payload.verified === false) {
      payload.next =
        "答案错误：captcha_attempt+1；勿刷新；继续只用 solve_captcha（勿换别名空转）；满 3 次 HITL";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else if (payload.filled && payload.submitted) {
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
      payload.next = "已填交验证答案；若页内出现成功提示可 done(success=true)；勿误点提交参赛代码";
    } else if (payload.filled && !payload.submitted) {
      payload.next =
        result.formHints.submitIndex != null
          ? `已填入；下一轮仅 click(index=${result.formHints.submitIndex}) 验证答案`
          : "已填入，请点击「验证答案」";
    } else if (!payload.filled) {
      payload.next = `用 input 填入 "${result.answer}" 后点击「验证答案」`;
    }

    const content = JSON.stringify(payload);
    const mem =
      payload.verified === true
        ? `算式验证通过: ${result.expr}=${result.answer}`
        : payload.verified === false
          ? `算式验证失败: ${result.expr}=${result.answer}（${payload.verifySignal}）`
          : `算式求解: ${result.expr}=${result.answer}`;
    return ok(content, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
      longTermMemory: mem,
      success: payload.verified === false ? false : true,
      metadata: {
        captcha: { kind: "math", verified: payload.verified, signal: payload.verifySignal },
      },
    });
  }

  // 图片字符路径（静态图 / GIF 动图）——具体子模式见 result.strategy
  const result = unified.imageText;
  if (result.strategy === "unsupported") {
    return failCaptcha(
      result.detail ||
        "unsupported: 当前验证码类型未封装。请勿重试本工具。",
      "image_text",
    );
  }

  // 弃权机已删除：该页点「刷新」不换图，弃权等于 0% 成功率，且实测连续两次运行里
  // 弃权都被兜底分支覆盖——净信息产出为 0。现在只保留单一决策：有码就提交一次。
  if (!result.ok || !result.code) {
    const attempt = noteCaptchaAttempt(ctx.page);
    const refreshed = await refreshCaptchaMedia(ctx.page, ctx.logger);
    cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    const capNote =
      attempt >= CAPTCHA_MAX_ATTEMPTS
        ? "；已达尝试上限，改 handover_to_human。"
        : "；请再调 solve_captcha。";
    const refreshNote = refreshed.refreshed
      ? "已换新验证码"
      : `未能换新验证码(${refreshed.reason})：重解同一张图只会得到同一答案，此时别再空转`;
    return failCaptcha(
      `${result.detail || "未能识别"}；${refreshNote}；captcha_attempt=${attempt}${capNote}`,
      "image_text",
    );
  }

  const payload: Record<string, unknown> = {
    strategy: result.strategy,
    code: result.code,
    frame: result.frame,
    confidence: result.confidence,
    framesCaptured: result.framesCaptured,
    framePaths: result.framePaths ?? [],
    gifPath: result.gifPath ?? "",
    inputIndex: result.formHints.inputIndex,
    submitIndex: result.formHints.submitIndex,
    filled: false,
    submitted: false,
    verified: null as boolean | null,
    verifySignal: "",
  };

  const gw = resolveGateway(ctx.page);
  ctx.logger.agentProgress(
    `③ 读码完成「${result.code}」(最清晰帧 ${result.frame}) → 立即填写提交`,
    {
      phase: "animated_captcha",
      stage: "fill_submit",
      code: result.code,
    },
  );

  // 同一张验证码图 + 同一个答案 = 必然同一个结果：不再重复提交，直接换新码。
  const fingerprint = await readCaptchaFingerprint(ctx.page);
  const lastTry = lastCaptchaSubmission.get(ctx.page);
  if (
    fingerprint &&
    lastTry?.submitted &&
    lastTry.code === result.code &&
    lastTry.hash === fingerprint.hash
  ) {
    const attempt = noteCaptchaAttempt(ctx.page);
    const refreshed = await refreshCaptchaMedia(ctx.page, ctx.logger);
    cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    return failCaptcha(
      `本轮解出的「${result.code}」与上一次已提交的答案完全相同，且验证码图未变——重复提交必然同样失败，故不再提交。` +
        (refreshed.refreshed
          ? "已换新验证码，请再调 solve_captcha。"
          : `未能换新验证码(${refreshed.reason})，请 handover_to_human。`) +
        ` captcha_attempt=${attempt}`,
      "image_text",
    );
  }

  let fillElement: IndexedElementRef | null = null;
  if (autoFill && result.formHints.inputIndex != null) {
    const index = result.formHints.inputIndex;
    const el = ctx.resolveElement(index);
    if (!el) {
      return failCaptcha(
        `已识别验证码「${result.code}」，但输入框 index=${index} 已失效。请下一轮用 input 填入。`,
        "image_text",
      );
    }
    fillElement = el;
    await gw.fill(elementPlaywrightSelector(el), result.code, {
      semanticLabel: elementLabelBlob(el) || el.tagName,
      humanLike: false,
      append: false,
    });
    payload.filled = true;
    payload.filledValue = result.code;
  }

  if (autoSubmit && payload.filled) {
    let submitVia = "input";
    const submitIndex = result.formHints.submitIndex;
    let clicked = false;
    if (submitIndex != null) {
      const el = ctx.resolveElement(submitIndex);
      if (el) {
        await clickElement(gw, el);
        payload.submitIndex = submitIndex;
        clicked = true;
        submitVia = `click#${submitIndex}`;
      }
    }
    if (!clicked) {
      // 已有 hint 不可用：再按文案找一次真实提交控件（名词/上传/登录已在 hint 层排除）
      const hit = findIndexByTextHint(ctx.browserState.selectorMap, SUBMIT_HINT_RE);
      const el = hit ? ctx.resolveElement(hit.index) : null;
      if (hit && el) {
        await clickElement(gw, el);
        payload.submitIndex = hit.index;
        clicked = true;
        submitVia = `click#${hit.index}(hint)`;
      }
    }
    if (!clicked && fillElement) {
      // 兜底：输入框回车走表单提交。比「点一个拿不准的元素」安全得多——
      // 实测误点验证码图会把验证码刷新、输入清空，看起来像「填了但没反应」。
      await gw.click(elementPlaywrightSelector(fillElement), {
        semanticLabel: elementLabelBlob(fillElement) || fillElement.tagName,
      });
      await gw.executeKeyPress("Enter");
      clicked = true;
      submitVia = "enter_on_input";
    }
    payload.submitted = clicked;
    payload.submitVia = submitVia;
    if (clicked) {
      await probeCaptchaOutcome(ctx, payload);
    }
    if (fingerprint) {
      lastCaptchaSubmission.set(ctx.page, {
        hash: fingerprint.hash,
        code: result.code,
        submitted: clicked,
      });
    }
  }

  if (payload.verified === true) {
    resetCaptchaAttempts(ctx.page);
    payload.next =
      "页内已出现成功提示；若任务已达成则 done(success=true)，否则继续任务。禁止再调 solve_captcha。";
    cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
  } else if (payload.verified === false) {
    const attempt = noteCaptchaAttempt(ctx.page);
    const refreshed = await refreshCaptchaMedia(ctx.page, ctx.logger);
    payload.next =
      `页内提示失败：已提交「${result.code}」不对。` +
      (refreshed.refreshed
        ? "已换新验证码，请直接再调 solve_captcha 解新码"
        : `未能换新验证码(${refreshed.reason})，重解同一张图只会重复同一答案`) +
      `；captcha_attempt=${attempt}` +
      (attempt >= CAPTCHA_MAX_ATTEMPTS ? "；已达上限，改 handover_to_human。" : "。");
    cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
  } else if (payload.filled && payload.submitted) {
    cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    payload.next =
      `已把「${result.code}」填入并提交（方式 ${payload.submitVia}），但页内没有明确成败信号。` +
      "**禁止再次输入同一答案**（重复填交不会改变结果，只会浪费一次机会）。" +
      "本轮只做只读核查（screenshot / 读页内文本 / 看网络响应）；若始终无信号，直接 handover_to_human 说明已提交的答案。";
  } else if (payload.filled && !payload.submitted) {
    payload.next =
      result.formHints.submitIndex != null
        ? `已填入；下一轮仅 click(index=${result.formHints.submitIndex})，勿重复 input。`
        : "已填入；未找到可信的提交控件，请下一轮 click 含「提交/验证答案/确定」的元素，或对输入框用 send_keys 回车；勿重复 input。";
  } else if (!payload.filled) {
    payload.next = `用 input 填入 "${result.code}" 后提交（仅一次）`;
  }

  const content = JSON.stringify(payload);
  const mem =
    payload.verified === true
      ? `验证码通过: ${result.code}`
      : payload.verified === false
        ? `验证码错误: ${result.code}（${payload.verifySignal}）`
        : `GIF验证码识别(帧${result.frame}): ${result.code}`;
  return ok(content, {
    includeExtractedContentOnlyOnce: true,
    extractedContent: content,
    longTermMemory: mem,
    success: payload.verified === false ? false : true,
    metadata: {
      captcha: { kind: "image_text", verified: payload.verified, signal: payload.verifySignal },
    },
  });
}

/** 懒加载注册 */
let registered = false;
export function ensureActionsRegistered(): void {
  if (registered) return;
  registerAllActions();
  registerSkillMetaActions();
  registered = true;
}

export type { Page, ActionContext };
