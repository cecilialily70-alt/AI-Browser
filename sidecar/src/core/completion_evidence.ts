/**
 * 完成度证据（Completion Evidence）
 *
 * 背景：`done(success=true)` 以前是**无成本的自我声明** —— 模型说完成就算完成。
 * 观察到的真实事故：注册表单还是空的、提交按钮从没点过、页面没有任何成功提示，
 * 模型照样 done；事后的 judge 又常因「短轨迹已成功」被跳过，于是错误结论被当成结果交付。
 *
 * 这里把「完成」当成需要举证的命题：运行期持续记账（证据台账），done 时用**可验证的客观事实**
 * 与该任务意图要求的证据形态做比对，缺证据就驳回本次 done（不结束任务），并把「该怎么补证据」
 * 明确回给模型，让它继续干活。判定所需的词表全部来自外部数据文件（completion_lexicon.json）。
 *
 * 设计约束：
 *   - 只做确定性判定，不呼叫模型（模型判定留给 judge，二者互补：先证据、后语义）；
 *   - 宁可漏判不可错杀：无证据才驳回，且驳回次数封顶（超限放行并标注「未验证」），杜绝死循环；
 *   - 不硬编码任何站点文案；词典缺失时退化为「通用意图 + 只认可验证副作用」。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";

import { readAppEnv } from "../app_env.js";
import { mayClaimPaymentSuccess } from "./hitl_policy.js";
import { allHits, firstHit, normalizeHaystack } from "./text_match.js";

/** 证据种类：只有「可验证的副作用」才算数，单纯的「执行过某动作」不算 */
export type EvidenceKind =
  | "navigated"
  | "navigation_reached"
  | "fill_verified"
  | "choice_changed"
  | "overlay_cleared"
  | "content_extracted"
  | "user_answered"
  | "screenshot_after_mutation"
  | "page_digest"
  | "file_downloaded"
  | "action_failed";

export interface EvidenceFact {
  kind: EvidenceKind;
  /** 发生该事实的步号（0 起，运行期单调递增） */
  step: number;
  /** 发生时的页面 URL */
  url: string;
  detail: string;
}

/** 运行期共享台账：由 service 创建，随 ActionContext 下传，逐步骤记账 */
export interface EvidenceLedger {
  startUrl: string;
  startTitle: string;
  facts: EvidenceFact[];
  /** 最近一次「会改变页面状态」的动作（click/input/select/navigate…）所在步号；无则为 -1 */
  lastMutationStep: number;
  /** 最近一次「会改变页面状态」的动作发生时的 URL：用于判断之后是否真的离开了该页面 */
  lastMutationUrl: string;
  /** 最近一次成功的文本填写发生时的 URL（表单提交前后的对照基准） */
  lastFillUrl: string | null;
  /** 上一步记账时的 URL：用于识别「本步动作引发了跳转」 */
  prevUrl: string;
  /** done 因缺证据被驳回的次数 */
  rejections: number;
  /** 最近一次观测到的页面摘要（仅判空/长度，不保存全文） */
  pageDigestChars: number;
  /**
   * 已为哪些「一次性凭证字段」弹过人工接管窗（键 = URL + 字段身份）。
   * 同一处只弹一次：用户的注意力不能被同一个验证码框反复打断，
   * 但**拒绝 done** 这条硬闸不受此限制 —— 没拿到码就不算完成。
   */
  humanHandoverKeys: Set<string>;
  /**
   * 用户本任务里是否真的参与过（回答了 ask_user / 接管过浏览器 / 在确认框里补过值）。
   * 一次性凭证字段只认「人给的值」：没人给过值时，AI 自己编一个填进去必须被拦下。
   */
  humanInvolved: boolean;
  /**
   * 用户是否已确认过「提交支付」动作（或代付目标下完成了接管）。
   * 缺省/false：不得把「已下单 / 已付款」当成 done(success=true)。
   */
  humanPaymentConfirmed?: boolean;
  /**
   * P1.2：邮箱 OTP 通道刚解析出的码（用完即弃）。
   * 仅允许匹配后写入**邮箱类** human_only 字段；禁止写入轨迹 / results / 控制记忆。
   */
  channelEmailOtp: ChannelEmailOtpSlot | null;
  /**
   * P5.3：短信接码平台刚解析出的码（用完即弃）。
   * 仅允许匹配后写入**短信类** human_only 字段；禁止写入轨迹 / results / 控制记忆。
   */
  channelSmsOtp: ChannelSmsOtpSlot | null;
}

/** 邮箱通道取码的短暂槽位（证据台账持有，禁止落盘明文） */
export type ChannelEmailOtpSlot = {
  code: string;
  messageId: string;
  fetchedAt: number;
};

/** 短信通道取码的短暂槽位（证据台账持有，禁止落盘明文） */
export type ChannelSmsOtpSlot = {
  code: string;
  messageId: string;
  fetchedAt: number;
};

export type GoalIntent = "outcome" | "informational" | "generic";

/** 购物/订票：停在支付前 vs 不得自动当成已付款 */
export interface CommerceHaltLexicon {
  prePayTerms: string[];
  notAutoSuccessTerms: string[];
  paidClaimTerms: string[];
  payDemandTerms: string[];
  checkoutStopTerms: string[];
  paymentConfirmTerms: string[];
}

export interface CompletionLexicon {
  maxDoneRejections: number;
  scanChars: number;
  minClaimChars: number;
  outcomeTerms: string[];
  informationalTerms: string[];
  strongSuccessTerms: string[];
  weakSuccessTerms: string[];
  failureTerms: string[];
  commerce: CommerceHaltLexicon;
}

export interface PageSignals {
  ok: boolean;
  strong: string[];
  weak: string[];
  failure: string[];
  /** 已加购 / 已达收银台 / 待支付（停在支付前，不是已付款） */
  prePay?: string[];
  /** 已下单 / 已付款等：不得单独作为自动成功 */
  paymentClaims?: string[];
  /** 页面文案长度（截断后） */
  chars: number;
}

export interface CompletionVerdict {
  /** 是否放行本次 done(success=true) */
  acceptable: boolean;
  goalIntent: GoalIntent;
  /** 支撑证据（人类可读） */
  supports: string[];
  /** 反向证据（人类可读） */
  counter: string[];
  /** 驳回时给模型的下一步指引 */
  guidance: string;
  /** 是否因超限而放行（结论需标注「未验证」） */
  forced: boolean;
}

const MAX_TERM_LENGTH = 48;

let cached: CompletionLexicon | null | undefined;

function lexiconCandidates(): string[] {
  const env = readAppEnv("COMPLETION_LEXICON");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/completion_lexicon.json"));
  out.push(join(here, "../../../config/completion_lexicon.json"));
  out.push(join(process.cwd(), "config", "completion_lexicon.json"));
  out.push(join(process.cwd(), "sidecar", "config", "completion_lexicon.json"));
  return out;
}

export function resolveCompletionLexiconPath(): string | null {
  for (const candidate of lexiconCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* 单个候选路径异常不阻断 */
    }
  }
  return null;
}

function sanitizeTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/\s+/g, " ").trim().toLowerCase())
        .filter((item) => item.length > 0 && item.length <= MAX_TERM_LENGTH),
    ),
  );
}

export function loadCompletionLexicon(): CompletionLexicon | null {
  if (cached !== undefined) return cached;
  const path = resolveCompletionLexiconPath();
  if (!path) {
    cached = null;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const policy = (parsed.policy ?? {}) as Record<string, unknown>;
    const intents = (parsed.goalIntents ?? {}) as Record<string, Record<string, unknown>>;
    const success = (parsed.successSignals ?? {}) as Record<string, Record<string, unknown>>;
    const failure = (parsed.failureSignals ?? {}) as Record<string, unknown>;
    const commerce = (parsed.commerceHalt ?? {}) as Record<string, Record<string, unknown>>;
    const termsOf = (section: string): string[] => sanitizeTerms(commerce[section]?.terms);
    const num = (raw: unknown, fallback: number, min: number, max: number): number => {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(n)));
    };
    cached = {
      maxDoneRejections: num(policy.maxDoneRejections, 2, 0, 5),
      scanChars: num(policy.scanChars, 6000, 500, 20000),
      minClaimChars: num(policy.minClaimChars, 30, 0, 500),
      outcomeTerms: sanitizeTerms(intents.outcome?.terms),
      informationalTerms: sanitizeTerms(intents.informational?.terms),
      strongSuccessTerms: sanitizeTerms(success.strong?.terms),
      weakSuccessTerms: sanitizeTerms(success.weak?.terms),
      failureTerms: sanitizeTerms(failure.terms),
      commerce: {
        prePayTerms: termsOf("prePay"),
        notAutoSuccessTerms: termsOf("notAutoSuccess"),
        paidClaimTerms: termsOf("paidClaims"),
        payDemandTerms: termsOf("payDemand"),
        checkoutStopTerms: termsOf("checkoutStop"),
        paymentConfirmTerms: termsOf("paymentConfirm"),
      },
    };
  } catch {
    cached = null;
  }
  return cached;
}

export async function createEvidenceLedger(page: Page): Promise<EvidenceLedger> {
  return {
    startUrl: page.url(),
    startTitle: await page.title().catch(() => ""),
    facts: [],
    lastMutationStep: -1,
    lastMutationUrl: page.url(),
    lastFillUrl: null,
    prevUrl: page.url(),
    rejections: 0,
    pageDigestChars: 0,
    humanHandoverKeys: new Set<string>(),
    humanInvolved: false,
    humanPaymentConfirmed: false,
    channelEmailOtp: null,
    channelSmsOtp: null,
  };
}

/** 暂存通道码（覆盖旧槽；禁止写入日志明文） */
export function stashChannelEmailOtp(
  ledger: EvidenceLedger | null | undefined,
  slot: ChannelEmailOtpSlot,
): void {
  if (!ledger) return;
  ledger.channelEmailOtp = {
    code: String(slot.code ?? "").trim(),
    messageId: String(slot.messageId ?? "").trim(),
    fetchedAt: slot.fetchedAt || Date.now(),
  };
}

/** 匹配成功后丢弃槽位（用完即弃） */
export function consumeChannelEmailOtp(
  ledger: EvidenceLedger | null | undefined,
  value: string,
): boolean {
  if (!ledger?.channelEmailOtp) return false;
  const expected = String(ledger.channelEmailOtp.code ?? "").trim();
  const actual = String(value ?? "").trim();
  if (!expected || expected !== actual) return false;
  ledger.channelEmailOtp = null;
  return true;
}

/** P5.3：暂存短信通道码（覆盖旧槽；禁止写入日志明文） */
export function stashChannelSmsOtp(
  ledger: EvidenceLedger | null | undefined,
  slot: ChannelSmsOtpSlot,
): void {
  if (!ledger) return;
  ledger.channelSmsOtp = {
    code: String(slot.code ?? "").trim(),
    messageId: String(slot.messageId ?? "").trim(),
    fetchedAt: slot.fetchedAt || Date.now(),
  };
}

/** P5.3：匹配成功后丢弃短信槽位（用完即弃） */
export function consumeChannelSmsOtp(
  ledger: EvidenceLedger | null | undefined,
  value: string,
): boolean {
  if (!ledger?.channelSmsOtp) return false;
  const expected = String(ledger.channelSmsOtp.code ?? "").trim();
  const actual = String(value ?? "").trim();
  if (!expected || expected !== actual) return false;
  ledger.channelSmsOtp = null;
  return true;
}

/** 动作名 → 是否属于「会改变页面状态」的动作 */
const MUTATING_ACTIONS = new Set([
  "click",
  "input",
  "select_dropdown",
  "navigate",
  "go_back",
  "scroll",
  "send_keys",
  "drag",
  "execute_script",
  "solve_captcha",
  "fetch_email_otp",
]);

export interface StepEvidenceInput {
  step: number;
  /** 本步动作名（与 results 顺序对应） */
  actionNames: string[];
  results: Array<{
    error?: string | null;
    metadata?: Record<string, unknown> | null;
    extractedContent?: string | null;
  }>;
  /** 本步结束时活动页 URL */
  url: string;
  /**
   * 本步动作**开始前**活动页 URL。
   *
   * 为什么必须单独给：`url` 是动作**之后**的 URL，用它当"填写发生在哪一页"的基准会自我抵消 ——
   * 一次「输入 + 回车」在同一批动作里触发跳转时，基准会被记成**跳转后**的页面，
   * 于是"提交后离开了表单页"永远不成立（真提交反而永远核销不掉）。
   * 用户现场就是这个 bug：真提交没被认，之后一次无关 navigate 反而凭空认了。
   */
  stepStartUrl?: string;
  /** 本步模型是否拿到截图（说明它确实「看过」结果） */
  screenshotTaken: boolean;
  /** 本步观测到的页面摘要长度（0 表示无摘要） */
  pageDigestChars: number;
}

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 逐步骤记账：只从「结构化结果」提取事实，不做任何文案猜测 */
export function recordStepEvidence(ledger: EvidenceLedger, input: StepEvidenceInput): void {
  const step = input.step;
  const url = input.url || ledger.lastMutationUrl;
  let mutated = false;

  for (let i = 0; i < input.results.length; i += 1) {
    const result = input.results[i];
    const actionName = input.actionNames[i] ?? "";
    const meta = (result?.metadata ?? {}) as Record<string, unknown>;

    if (result?.error) {
      ledger.facts.push({ kind: "action_failed", step, url, detail: `${actionName}: ${result.error.slice(0, 120)}` });
    }

    // 填写回读：verifyFill 的 verdict 已经由 actions 层写入 metadata
    const fillVerdict = pickString(meta, ["fillVerify", "fillVerdict", "verifyFill"]);
    if (fillVerdict === "ok") {
      ledger.facts.push({ kind: "fill_verified", step, url, detail: "回读一致" });
      // 基准记「填写时所在的页面」= 本步动作**开始前**的 URL（不是动作后的）。
      // stepStartUrl 缺失时（单测/老调用方）退回现状，行为与改造前一致。
      ledger.lastFillUrl = input.stepStartUrl || url;
    }

    // 勾选/单选状态变化：precise_click 的结果自检
    const checkedBefore = meta.checkedBefore;
    const checkedAfter = meta.checkedAfter;
    if (meta.choiceChanged === true) {
      ledger.facts.push({
        kind: "choice_changed",
        step,
        url,
        detail: pickString(meta, ["choiceLabel", "choice"]) || actionName || "choice",
      });
      mutated = true;
    }

    if (typeof checkedBefore === "boolean" && typeof checkedAfter === "boolean" && checkedBefore !== checkedAfter) {
      ledger.facts.push({
        kind: "choice_changed",
        step,
        url,
        detail: `${checkedBefore} → ${checkedAfter}`,
      });
    }

    // 命中自检 / 遮挡仲裁的证据
    const overlay = meta.overlay ?? meta.clearedOverlay ?? meta.overlayArbitration;
    if (overlay) {
      const label = typeof overlay === "string" ? overlay : JSON.stringify(overlay).slice(0, 80);
      ledger.facts.push({ kind: "overlay_cleared", step, url, detail: label });
    }

    if (actionName === "extract" || actionName === "scrape_page_data" || actionName === "page_summary") {
      const content = String(result?.extractedContent ?? "").trim();
      if (result?.error == null && content.length > 0) {
        ledger.facts.push({ kind: "content_extracted", step, url, detail: `${content.length} chars` });
      }
    }
    if (actionName === "ask_user") {
      ledger.facts.push({ kind: "user_answered", step, url, detail: "" });
      ledger.humanInvolved = true;
    }
    // 人工接管同样是「人参与了」：用户可能直接在浏览器里把码填了
    if (actionName === "handover_to_human") {
      ledger.facts.push({ kind: "user_answered", step, url, detail: "handover" });
      ledger.humanInvolved = true;
    }
    // 人工在确认框里补的值（fillOverride）：值的来源是人，允许写进一次性凭证字段
    if (actionName === "input" && meta.humanProvided === true) {
      ledger.humanInvolved = true;
    }
    // P1.2：通道已填邮箱码 —— 不把 humanInvolved 翻成 true（人没参与），但字段已有内容即可过 done 闸门
    if (actionName === "input" && meta.channelProvided === true) {
      ledger.facts.push({ kind: "content_extracted", step, url, detail: "channel_email_otp_filled" });
    }

    if (MUTATING_ACTIONS.has(actionName)) mutated = true;
  }

  if (mutated) {
    ledger.lastMutationStep = step;
    ledger.lastMutationUrl = url;
  }
  // 本步动作引发了跳转（主循环步才有意义：引导导航不算「任务推进的证据」）
  if (step >= 1 && url && ledger.prevUrl && url !== ledger.prevUrl) {
    ledger.facts.push({
      kind: "navigated",
      step,
      url,
      detail: `${ledger.prevUrl.slice(0, 60)} → ${url.slice(0, 60)}`,
    });
  }
  ledger.prevUrl = url || ledger.prevUrl;
  if (input.screenshotTaken) {
    ledger.facts.push({ kind: "screenshot_after_mutation", step, url, detail: "" });
  }
  ledger.pageDigestChars = input.pageDigestChars;
}

/**
 * 记录「当前 URL 已到达目标页面」这一客观事实（纯导航目标本地收尾的证据）。
 * 去重：同一任务只记一次 —— 它描述的是「到达了」，不是「还在这一页」。
 */
export function markNavigationReached(
  ledger: EvidenceLedger,
  input: { step: number; url: string; detail: string },
): boolean {
  if (ledger.facts.some((fact) => fact.kind === "navigation_reached")) return false;
  ledger.facts.push({
    kind: "navigation_reached",
    step: input.step,
    url: input.url,
    detail: input.detail.slice(0, 200),
  });
  return true;
}

/** 页面文案扫描脚本（自包含：注入浏览器上下文后不依赖模块作用域） */
const PAGE_TEXT_SCRIPT = (limit: number) => {
  const body = document.body as HTMLElement | null;
  const raw = body ? body.innerText || body.textContent || "" : "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, limit);
};

const EMPTY_COMMERCE: CommerceHaltLexicon = {
  prePayTerms: [],
  notAutoSuccessTerms: [],
  paidClaimTerms: [],
  payDemandTerms: [],
  checkoutStopTerms: [],
  paymentConfirmTerms: [],
};

function commerceOf(lexicon: CompletionLexicon | null): CommerceHaltLexicon {
  return lexicon?.commerce ?? EMPTY_COMMERCE;
}

/** 目标明确要求付掉/支付成功（优先于「加购到结算页」） */
export function goalDemandsHumanPayment(goal: string, lexicon: CompletionLexicon | null): string | null {
  return firstHit(normalizeHaystack(goal), commerceOf(lexicon).payDemandTerms);
}

/** 目标只要加购/到收银台，且没有「帮我付掉」 */
export function goalStopsBeforePay(goal: string, lexicon: CompletionLexicon | null): string | null {
  if (goalDemandsHumanPayment(goal, lexicon)) return null;
  return firstHit(normalizeHaystack(goal), commerceOf(lexicon).checkoutStopTerms);
}

/** 文案是否在用「已下单 / 已付款」冒充完成 */
export function findPaymentClaim(text: string, lexicon: CompletionLexicon | null): string | null {
  return firstHit(normalizeHaystack(text), commerceOf(lexicon).notAutoSuccessTerms);
}

/**
 * 「用户规则命中即收尾」前的红线闸门（R1 + 一次性凭证）。
 *
 * 用户可以把「出现下单成功」写成完成条件，但**规则命中不等于付款完成**：只要目标要求
 * 付掉而没有人侧支付确认，就绝不允许靠规则命中自动收尾。页面还留着空的一次性凭证字段
 * （邮箱/短信/验证器码）时同理 —— 那正是 done 闸门要拦的自欺。
 *
 * 返回 null = 允许自动收尾；返回字符串 = 禁止自动收尾的原因（写入日志，任务继续走正常流程）。
 */
export function blocksRuleAutoComplete(input: {
  goal: string;
  lexicon: CompletionLexicon | null;
  humanPaymentConfirmed: boolean;
  hasPendingCredential: boolean;
}): string | null {
  const demand = goalDemandsHumanPayment(input.goal, input.lexicon);
  if (demand && !input.humanPaymentConfirmed) {
    return (
      `目标要求完成支付（「${demand}」）且没有人工确认：规则命中不构成完成，` +
      `必须 ask_user / handover_to_human 由人工支付，禁止自动收尾冒充已付款。`
    );
  }
  if (input.hasPendingCredential) {
    return "页面上还有待人工提供的一次性凭证（邮箱/短信/验证器码）未填写：规则命中不算完成。";
  }
  return null;
}

/** 用户批准的是提交支付/卡信息，而不是「去结算 / 加购」 */
export function isPaymentSubmitLabel(label: string, lexicon: CompletionLexicon | null = loadCompletionLexicon()): boolean {
  return firstHit(normalizeHaystack(label), commerceOf(lexicon).paymentConfirmTerms) != null;
}

function hasPaidClaim(claims: readonly string[], lexicon: CompletionLexicon | null): boolean {
  const paid = new Set(commerceOf(lexicon).paidClaimTerms);
  return claims.some((term) => paid.has(term));
}

export function usableStrongSignals(signals: PageSignals, lexicon: CompletionLexicon | null): string[] {
  const claims = signals.paymentClaims ?? [];
  // 页面已经出现「已下单 / 已付款」时，旁边的「已提交 / 成功」不能再单独放行。
  if (claims.length > 0) return [];
  const forbidden = new Set(commerceOf(lexicon).notAutoSuccessTerms);
  return (signals.strong ?? []).filter((term) => !forbidden.has(term));
}

/** 页面已出现「已下单 / 已付款」时，旁边的「成功 / 已提交」不再单独算完成。 */
export function usableWeakSignals(signals: PageSignals, _lexicon: CompletionLexicon | null): string[] {
  if ((signals.paymentClaims ?? []).length > 0) return [];
  return signals.weak ?? [];
}

export async function scanPageSignals(
  page: Page,
  lexicon: CompletionLexicon,
): Promise<PageSignals> {
  const empty: PageSignals = {
    ok: false,
    strong: [],
    weak: [],
    failure: [],
    prePay: [],
    paymentClaims: [],
    chars: 0,
  };
  let text = "";
  try {
    text = (await page.evaluate(PAGE_TEXT_SCRIPT, lexicon.scanChars)) as string;
  } catch {
    return empty;
  }
  const hay = normalizeHaystack(text ?? "");
  if (!hay) return { ...empty, ok: true };
  const paymentClaims = allHits(hay, lexicon.commerce.notAutoSuccessTerms, 8);
  const strong = allHits(hay, lexicon.strongSuccessTerms).filter(
    (term) => !paymentClaims.some((bad) => bad === term || bad.includes(term)),
  );
  const weak = allHits(hay, lexicon.weakSuccessTerms).filter(
    (term) => !paymentClaims.some((bad) => bad.includes(term)),
  );
  return {
    ok: true,
    strong,
    weak,
    failure: allHits(hay, lexicon.failureTerms),
    prePay: allHits(hay, lexicon.commerce.prePayTerms, 8),
    paymentClaims,
    chars: hay.length,
  };
}

const FALLBACK_OUTCOME_TERMS = [
  "register", "sign up", "signup", "login", "sign in", "submit", "purchase", "buy", "checkout", "place order", "send", "publish", "upload", "apply", "subscribe", "order",
];
const FALLBACK_INFORMATIONAL_TERMS = [
  "summarize", "summary", "what is", "how much", "tell me", "find out", "explain", "compare", "list", "extract", "read", "answer",
];

export function classifyGoalIntent(goal: string, lexicon: CompletionLexicon | null): GoalIntent {
  const hay = normalizeHaystack(goal);
  if (!hay) return "generic";
  const outcomeTerms = lexicon?.outcomeTerms.length ? lexicon.outcomeTerms : FALLBACK_OUTCOME_TERMS;
  if (firstHit(hay, outcomeTerms)) return "outcome";
  const infoTerms = lexicon?.informationalTerms.length ? lexicon.informationalTerms : FALLBACK_INFORMATIONAL_TERMS;
  if (firstHit(hay, infoTerms)) return "informational";
  return "generic";
}

export interface EvaluateCompletionInput {
  ledger: EvidenceLedger;
  lexicon: CompletionLexicon | null;
  goal: string;
  /** done 的结论文本（模型自述） */
  claim: string;
  signals: PageSignals;
  /** done 时的活动页 URL */
  currentUrl: string;
  /** done 时是否允许「截图为证」兜底（模型刚看过屏幕） */
  screenshotRecent: boolean;
  /**
   * 用户自定义完成条件（「规则」窗口）的机器核对结果。
   * satisfied=true 表示用户定义的完成条件全部核对通过 —— 此时不再要求通用证据。
   * 支付闸门仍先于此判定，不会被绕过（R1）。
   */
  userRules?: { satisfied: boolean; details: string[] };
}

function hasFact(ledger: EvidenceLedger, kinds: EvidenceKind[]): EvidenceFact | null {
  return ledger.facts.find((f) => kinds.includes(f.kind)) ?? null;
}

/** 取最近一次某类事实（用于给出「最近一次跳转」这类更贴合的说明） */
function lastFact(ledger: EvidenceLedger, kinds: EvidenceKind[]): EvidenceFact | null {
  for (let i = ledger.facts.length - 1; i >= 0; i -= 1) {
    const fact = ledger.facts[i]!;
    if (kinds.includes(fact.kind)) return fact;
  }
  return null;
}

/**
 * 完成度验收：判断本次 `done(success=true)` 是否有客观证据支撑。
 * 无证据时返回 acceptable=false，附带可直接回给模型的补证指引。
 */
export function evaluateCompletion(input: EvaluateCompletionInput): CompletionVerdict {
  const { ledger, signals, goal, claim, currentUrl } = input;
  const intent = classifyGoalIntent(goal, input.lexicon);
  const supports: string[] = [];
  const counter: string[] = [];

  const fillFact = hasFact(ledger, ["fill_verified"]);
  const choiceFact = hasFact(ledger, ["choice_changed"]);
  const contentFact = hasFact(ledger, ["content_extracted", "user_answered"]);
  const overlayFact = hasFact(ledger, ["overlay_cleared"]);
  const navFact = lastFact(ledger, ["navigated"]);
  const verifiedEffect = Boolean(fillFact || choiceFact || contentFact || overlayFact);

  /*
   * 「提交后确实离开了原页面」：以最近一次**填写发生时所在的页面**为基准。
   *
   * 基准的语义必须是"填写发生在哪一页"，所以 `lastFillUrl` 记的是**本步动作开始前**的 URL
   * （见 recordStepEvidence）。改造前它记的是动作之后的 URL —— 而"输入 + 回车"同批触发跳转时
   * 那个 URL 已经是跳转后的页面，于是基准与 currentUrl 相等，这条最强证据永远拿不到
   * （用户现场：done 依据里始终缺「页面已从…跳转到…」）。
   */
  const baselineUrl = ledger.lastFillUrl ?? (ledger.lastMutationStep >= 0 ? ledger.lastMutationUrl : ledger.startUrl);
  const leftBaseline = Boolean(currentUrl && baselineUrl && currentUrl !== baselineUrl);
  if (leftBaseline) {
    supports.push(`页面已从「${baselineUrl.slice(0, 80)}」跳转到「${currentUrl.slice(0, 80)}」`);
  }
  if (navFact) supports.push(`第 ${navFact.step} 步动作后页面发生了跳转`);
  if (fillFact) supports.push(`字段写入已回读确认（第 ${fillFact.step} 步）`);
  if (choiceFact) supports.push(`勾选状态已发生可验证变化（第 ${choiceFact.step} 步）`);
  if (contentFact) supports.push(`已取得页面内容（第 ${contentFact.step} 步）`);
  if (overlayFact) supports.push(`遮罩已被清理（第 ${overlayFact.step} 步）`);
  if (signals.failure.length > 0) counter.push(`页面存在失败/校验提示：${signals.failure.join(" / ")}`);
  const maxStep = ledger.facts.reduce((acc, f) => Math.max(acc, f.step), -1);
  const failedAtLastStep = ledger.facts.find((f) => f.kind === "action_failed" && f.step === maxStep);
  if (failedAtLastStep) counter.push(`最后一步动作失败：${failedAtLastStep.detail}`);

  const rejectBudget = input.lexicon?.maxDoneRejections ?? 2;
  const minClaimChars = input.lexicon?.minClaimChars ?? 30;
  const strongHits = usableStrongSignals(signals, input.lexicon);
  const weakHits = usableWeakSignals(signals, input.lexicon);
  const strongSuccess = strongHits.length > 0;
  const weakSuccess = weakHits.length > 0;
  const screenshotEvidence = input.screenshotRecent || Boolean(hasFact(ledger, ["screenshot_after_mutation"]));
  const digestEvidence = ledger.pageDigestChars > 0;

  if (strongHits.length > 0) supports.push(`页面出现完成提示：${strongHits.join(" / ")}`);
  if (weakHits.length > 0) supports.push(`页面出现完成相关文案：${weakHits.join(" / ")}`);

  /*
   * 支付闸门**必须最先**判定：它是产品红线（R1），优先级高于「用户自定义完成条件」。
   * 否则用户把「出现『下单成功』」写成完成条件时，会绕过「已下单≠已付款」的保护。
   */
  const commerce = applyCommerceHalt({
    lexicon: input.lexicon,
    goal,
    claim,
    signals,
    humanPaymentConfirmed: ledger.humanPaymentConfirmed === true,
  });
  if (commerce.prePaySupport) supports.push(commerce.prePaySupport);
  if (commerce.paidSupport) supports.push(commerce.paidSupport);
  if (commerce.block) {
    return {
      acceptable: false,
      goalIntent: intent,
      supports,
      counter,
      guidance: `【完成度验收未通过】${commerce.block}`,
      forced: false,
    };
  }

  /*
   * 用户自定义完成条件（「规则」窗口）：命中的是**用户自己下的判据**，且已由系统按
   * 代码/选择器或界面图片机器核对过 —— 优先级高于通用证据推断，命中即达成。
   * 注意执行顺序：支付闸门在上、凭证闸门在调用方（actions.done），二者都不被本分支绕过。
   */
  if (input.userRules?.satisfied === true) {
    for (const detail of input.userRules.details ?? []) {
      supports.push(detail);
    }
    if (commerce.forceAccept) {
      supports.push("人工已确认支付（不是词表自动成功）");
    }
    return { acceptable: true, goalIntent: intent, supports, counter, guidance: "", forced: false };
  }

  let acceptable = true;
  let missing = "";

  if (intent === "outcome") {
    // 结果型任务：必须有「离开原页面」或「页面明确报成功」这类外部可观测证据。
    // 仅「填过字段 / 点过按钮」不算完成 —— 那正是本机制要拦住的自欺。
    const weakOk = weakSuccess && (verifiedEffect || leftBaseline);
    // 只有「动作引发了跳转」还不够（可能点错链接跳到了别处）；
    // 必须再加上「跳转后模型真的看过结果页（截图）」，才是可信的完成证据。
    const navigatedAndSeen = Boolean(navFact) && screenshotEvidence;
    acceptable = leftBaseline || strongSuccess || weakOk || navigatedAndSeen;
    if (!acceptable) {
      missing = "「结果型任务」缺少完成证据：没有页面跳转，也没有成功提示";
    }
  } else if (intent === "informational") {
    // 信息型任务：交付物是信息本身 → 必须有内容获取事实，或有实质正文 + 页面摘要。
    const substantiveClaim = claim.trim().length >= minClaimChars;
    acceptable = Boolean(contentFact) || (substantiveClaim && digestEvidence) || (input.screenshotRecent && substantiveClaim);
    if (!acceptable) {
      missing = `「信息型任务」缺少交付证据：既没有读取/提取页面内容，结论正文也过短（< ${minClaimChars} 字）`;
    }
  } else {
    // 通用任务：至少要有一次可验证副作用，或刚刚看过结果页（截图/摘要），
    // 或已确认「当前 URL 到达目标页面」（纯导航目标的客观证据）。
    acceptable =
      verifiedEffect ||
      leftBaseline ||
      strongSuccess ||
      screenshotEvidence ||
      Boolean(hasFact(ledger, ["navigation_reached"]));
    if (!acceptable) {
      missing = "轨迹里没有任何可验证的副作用（未跳转、未成功写入字段、未改变勾选状态）";
    }
  }

  // 结果型任务里，页面明确报错且没有任何完成迹象时不放行（避免「失败页 + 残留成功词」误判）
  if (acceptable && intent === "outcome" && signals.failure.length > 0 && !strongSuccess && !leftBaseline) {
    acceptable = false;
    missing = `页面存在失败提示：${signals.failure.join(" / ")}`;
  }

  if (commerce.forceAccept && signals.failure.length === 0) {
    acceptable = true;
    missing = "";
  }

  if (acceptable) {
    return { acceptable: true, goalIntent: intent, supports, counter, guidance: "", forced: false };
  }

  if (ledger.rejections >= rejectBudget) {
    return {
      acceptable: true,
      goalIntent: intent,
      supports,
      counter,
      guidance: "",
      forced: true,
    };
  }

  return {
    acceptable: false,
    goalIntent: intent,
    supports,
    counter,
    guidance: buildGuidance(intent, missing, counter),
    forced: false,
  };
}

function applyCommerceHalt(input: {
  lexicon: CompletionLexicon | null;
  goal: string;
  claim: string;
  signals: PageSignals;
  humanPaymentConfirmed: boolean;
}): { block: string | null; prePaySupport: string | null; paidSupport: string | null; forceAccept: boolean } {
  const { lexicon, goal, claim, signals } = input;
  const humanPaid =
    input.humanPaymentConfirmed && mayClaimPaymentSuccess({ humanPaymentConfirmed: true });
  const demand = goalDemandsHumanPayment(goal, lexicon);
  const stop = goalStopsBeforePay(goal, lexicon);
  const prePay = signals.prePay ?? [];
  const claims = signals.paymentClaims ?? [];
  const claimHit = findPaymentClaim(claim, lexicon);
  const pagePaid = hasPaidClaim(claims, lexicon);
  const claimPaid = claimHit != null && hasPaidClaim([claimHit], lexicon);
  const none = { block: null, prePaySupport: null, paidSupport: null, forceAccept: false };

  if (demand && !humanPaid) {
    return {
      ...none,
      block:
        `目标要求完成支付（「${demand}」），但没有人工确认。页面上的「已下单 / 已付款 / 待支付」都不是已付款。` +
        `请 ask_user 或 handover_to_human 请人工完成支付，禁止自动点击支付或扣款，禁止 done(success=true) 冒充已付款。`,
    };
  }
  if (demand && humanPaid && prePay.length > 0) {
    return {
      ...none,
      block:
        `人工确认后页面仍是待支付（${prePay.join(" / ")}），不得宣称已付款。请继续交接人工，禁止自动再次提交支付。`,
    };
  }
  if (demand && humanPaid && (pagePaid || claimPaid)) {
    return {
      ...none,
      paidSupport: "人工已确认支付（不是词表自动成功）",
      forceAccept: true,
    };
  }
  if ((stop || demand) && claimHit && !humanPaid) {
    return {
      ...none,
      block:
        `不得用「${claimHit}」宣称完成。已下单不等于已付款；未人工确认时「已付款 / 支付成功」也不得自动成功。` +
        `若目标是加购到结算页，结论应写明已加购 / 已达收银台 / 待支付，并 ask_user 或 handover_to_human。禁止自动提交支付。`,
    };
  }
  if (stop && claims.length > 0 && prePay.length === 0 && !humanPaid) {
    return {
      ...none,
      block:
        `页面只有「${claims.join(" / ")}」，不能当成已付款或可自动成功。请停在待支付/收银台，并 ask_user 或 handover_to_human。禁止自动提交支付。`,
    };
  }
  if (stop && prePay.length > 0) {
    return {
      ...none,
      prePaySupport: `页面处于停在支付前：${prePay.join(" / ")}（不是已付款）`,
      forceAccept: true,
    };
  }
  if (!demand && !stop && claims.length > 0 && !humanPaid && !pagePaid) {
    return none;
  }
  return none;
}

function buildGuidance(intent: GoalIntent, missing: string, counter: string[]): string {
  const lines = [`【完成度验收未通过】${missing}。`];
  if (counter.length) lines.push(`反向证据：${counter.join("；")}。`);
  if (intent === "outcome") {
    lines.push(
      "请勿直接结束任务。下一步按顺序排查：① 若表单仍有必填项为空/未勾选（看 state=unchecked），先补齐并回读确认；② 若提交按钮还未点过，点击它；③ 若点击后页面无变化，说明动作被拦截或失败，需重新观察并处理；④ 只有出现页面跳转或明确的完成提示（如「成功」「已提交」「欢迎」等）才算完成，届时再 done。",
    );
  } else if (intent === "informational") {
    lines.push(
      "请先用 read_state / extract 取得页面内容（或用 ask_user 补齐缺失信息），再在 done 的正文里给出实质结论。",
    );
  } else {
    lines.push(
      "请继续执行能够产生可验证结果的动作（导航/提交/写入并回读），或先截图确认当前状态，再决定是否 done。",
    );
  }
  lines.push("若判断任务确实无法推进，请改用 done(success=false) 并说明卡点，或 handover_to_human。");
  return lines.join("");
}

/** 结论标注：forced 放行时在交付文案里留下「未验证」痕迹，供 judge 与用户识别 */
export function annotateUnverified(summary: string): string {
  const mark = "[未验证] done 缺少客观完成证据（已到驳回上限，按模型自述放行）";
  return summary.trim() ? `${summary}\n${mark}` : mark;
}
