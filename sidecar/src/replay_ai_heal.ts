/**
 * 回放单步 AI 愈合 — 机械穷尽后的有界兜底。
 *
 * 纪律（对齐计划）：
 * - 只修本步定位/合法 skip/清障一下；禁止多步规划与改写轨迹
 * - 成功后由调用方交回机械 N+1（dismiss 则在本模块内尽量完成本步意图）
 * - 不 import Agent 主循环 / ActionContext
 */
import type { Page } from "playwright-core";

import { extractAssistantContent } from "./ai_client.js";
import { createModelRouter } from "./ai_model_router.js";
import type { SidecarAiSettings } from "./engine.js";
import type { JsonLogger } from "./json-logger.js";
import type { TrajectoryStep } from "./trajectory.js";

/** 与 replay_engine 同口径文案剥离（本地镜像，避免循环依赖） */
const CLICK_LABEL_HEAL_NOISE = new Set([
  "button",
  "link",
  "textbox",
  "option",
  "menuitem",
  "div",
  "span",
  "input",
  "select",
  "combobox",
  "listbox",
]);

function clickLabelHealCandidates(raw: string): string[] {
  const label = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!label || label === "（点击）") return [];
  const out: string[] = [];
  const push = (value: string) => {
    const next = value.replace(/\s+/g, " ").trim();
    if (next && !out.includes(next)) out.push(next);
  };
  const parts = label.split(" ");
  while (parts.length > 1 && CLICK_LABEL_HEAL_NOISE.has(parts[parts.length - 1]!.toLowerCase())) {
    parts.pop();
  }
  if (parts.length) {
    push(parts.join(" "));
    if (parts[0] && parts[0].length >= 2) push(parts[0]);
  }
  push(label);
  const core = out[0] ?? "";
  const dayLike = core.match(/^(\d{1,4})([日月年号號]?)$/);
  if (dayLike?.[1]) {
    push(dayLike[1]);
    if (dayLike[2]) push(`${dayLike[1]}${dayLike[2]}`);
  }
  return out;
}

function looksLikeDropdownOptionLabel(raw: string): boolean {
  const blob = String(raw ?? "").toLowerCase();
  if (/\boption\b|\bmenuitem\b/.test(blob)) return true;
  const core = clickLabelHealCandidates(raw)[0] ?? "";
  if (!core) return false;
  return /^\d{1,4}[日月年号號]?$/.test(core) || /月$/.test(core);
}

async function tryClickListOptionByLabel(page: Page, rawLabel: string): Promise<boolean> {
  for (const wanted of clickLabelHealCandidates(rawLabel)) {
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
        document.querySelectorAll('[role="listbox"], [role="menu"], ul[role="listbox"]'),
      ).filter(visible);
      const pool: Element[] = [];
      for (const root of lists) {
        for (const node of Array.from(
          root.querySelectorAll('[role="option"], [role="menuitem"], li, button'),
        )) {
          if (visible(node)) pool.push(node);
        }
        for (const node of Array.from(root.children)) {
          if (visible(node) && textOf(node).length <= 40) pool.push(node);
        }
      }
      if (!pool.length) {
        for (const node of Array.from(
          document.querySelectorAll('[role="option"], [role="menuitem"]'),
        )) {
          if (visible(node)) pool.push(node);
        }
      }
      for (const node of pool) {
        if (normalize(textOf(node)) === want) return node;
      }
      for (const node of pool) {
        const t = normalize(textOf(node));
        if (t.includes(want) || (wantDigits && t === wantDigits)) return node;
      }
      return null;
    }, wanted);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => undefined);
      continue;
    }
    try {
      await el.click({ timeout: 4_000 });
      return true;
    } catch {
      /* next */
    } finally {
      await el.dispose().catch(() => undefined);
      await handle.dispose().catch(() => undefined);
    }
  }
  return false;
}

export type ReplayAiHealAction =
  | "click_text"
  | "click_role"
  | "fill"
  | "select_option"
  | "skip_step"
  | "dismiss_blocker"
  | "need_hitl"
  | "abort";

export interface ReplayAiHealConfig {
  enabled: boolean;
  maxPerRun: number;
  allowDismissBlocker: boolean;
}

const DEFAULT_CONFIG: ReplayAiHealConfig = {
  enabled: true,
  maxPerRun: 3,
  allowDismissBlocker: true,
};

export function parseReplayAiHealConfig(raw: unknown): ReplayAiHealConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_CONFIG };
  }
  const o = raw as Record<string, unknown>;
  const maxRaw = Number(o.maxPerRun ?? o.max_per_run ?? DEFAULT_CONFIG.maxPerRun);
  const maxPerRun = Number.isFinite(maxRaw)
    ? Math.max(0, Math.min(10, Math.floor(maxRaw)))
    : DEFAULT_CONFIG.maxPerRun;
  return {
    enabled: o.enabled !== false && o.enabled !== 0 && o.enabled !== "false",
    maxPerRun,
    allowDismissBlocker:
      o.allowDismissBlocker !== false &&
      o.allow_dismiss_blocker !== false &&
      o.allowDismissBlocker !== 0 &&
      o.allow_dismiss_blocker !== 0,
  };
}

export class ReplayAiHealBudget {
  used = 0;
  constructor(private readonly maxPerRun: number) {}
  remaining(): number {
    return Math.max(0, this.maxPerRun - this.used);
  }
  canUse(): boolean {
    return this.maxPerRun > 0 && this.used < this.maxPerRun;
  }
  consume(): void {
    this.used += 1;
  }
}

const REDLINE_LABEL_RE =
  /验证码|驗證碼|captcha|otp|短信|邮箱验证|郵箱驗證|支付|付款|checkout|卡号|卡號|cvv|删号|刪號|改密|转账|轉帳/i;

export type HealEligibility =
  | { ok: true; reason: "locator_drift" | "dropdown_option" | "optional_skip_assist" }
  | { ok: false; reason: string };

/** 准入闸：红线/非交互步直接拒绝；定位类与可选 skip 辅助才放行 */
export function classifyHealEligibility(input: {
  stepType: string;
  label: string;
  redacted?: boolean;
  failReason: string;
}): HealEligibility {
  const type = String(input.stepType || "").toLowerCase();
  if (type === "navigate" || type === "download" || type === "wait" || type === "solve_captcha") {
    return { ok: false, reason: `步骤类型 ${type} 不走 AI 愈合` };
  }
  if (type !== "click" && type !== "click_point" && type !== "fill" && type !== "select") {
    return { ok: false, reason: `步骤类型 ${type} 不在愈合白名单` };
  }
  const label = String(input.label ?? "").trim();
  if (REDLINE_LABEL_RE.test(label) || REDLINE_LABEL_RE.test(input.failReason)) {
    return { ok: false, reason: "命中验证码/支付等红线，禁止 AI 愈合" };
  }
  if (input.redacted && (type === "fill" || type === "select")) {
    return { ok: false, reason: "脱敏字段禁止 AI 编造取值" };
  }
  if (looksLikeDropdownOptionLabel(label)) {
    return { ok: true, reason: "dropdown_option" };
  }
  if (type === "click" || type === "click_point" || type === "fill" || type === "select") {
    return { ok: true, reason: "locator_drift" };
  }
  return { ok: false, reason: "未分类为可愈合失败" };
}

export type HealAttemptResult =
  | { ok: true; outcome: "healed" | "skip_step"; message: string; action: ReplayAiHealAction }
  | { ok: false; reason: string; action?: ReplayAiHealAction };

interface VisibleControl {
  text: string;
  role: string;
  tag: string;
}

async function collectVisibleControls(page: Page, limit = 40): Promise<VisibleControl[]> {
  try {
    return await page.evaluate((max: number) => {
      const out: Array<{ text: string; role: string; tag: string }> = [];
      const nodes = Array.from(
        document.querySelectorAll(
          'button, a, [role="button"], [role="option"], [role="menuitem"], input, select, textarea, [role="combobox"]',
        ),
      );
      for (const node of nodes) {
        if (out.length >= max) break;
        const el = node as HTMLElement;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (rect.width < 2 || rect.height < 2) continue;
        const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        if (!text) continue;
        out.push({
          text,
          role: (el.getAttribute("role") || "").slice(0, 24),
          tag: el.tagName.toLowerCase(),
        });
      }
      return out;
    }, limit);
  } catch {
    return [];
  }
}

function parseHealJson(raw: string): {
  action: ReplayAiHealAction;
  text?: string;
  role?: string;
  confidence?: number;
} | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const fence = text.match(/\{[\s\S]*\}/);
  const body = fence ? fence[0] : text;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const action = String(parsed.action ?? "").trim() as ReplayAiHealAction;
    const allowed: ReplayAiHealAction[] = [
      "click_text",
      "click_role",
      "fill",
      "select_option",
      "skip_step",
      "dismiss_blocker",
      "need_hitl",
      "abort",
    ];
    if (!allowed.includes(action)) return null;
    const confidence = Number(parsed.confidence);
    return {
      action,
      text: typeof parsed.text === "string" ? parsed.text.trim() : undefined,
      role: typeof parsed.role === "string" ? parsed.role.trim() : undefined,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
    };
  } catch {
    return null;
  }
}

async function askHealAction(input: {
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  stepType: string;
  label: string;
  failReason: string;
  url: string;
  title: string;
  controls: VisibleControl[];
  fillValue?: string;
  allowDismissBlocker: boolean;
}): Promise<ReturnType<typeof parseHealJson>> {
  const { route, client } = createModelRouter(input.aiSettings).forIntent(
    "fast_text",
    "回放单步定位愈合",
  );
  const dismissLine = input.allowDismissBlocker
    ? `dismiss_blocker — 点掉挡路的同意/关闭（text 为按钮文案），然后系统会重试本步`
    : `(dismiss_blocker 已关闭，勿输出)`;
  const system = [
    "你是天枢台回放单步愈合助手。只修复当前失败步的定位，禁止规划后续步骤。",
    "只输出一个 JSON 对象，不要其它文字。字段：action, text?, role?, confidence(0-1)。",
    "允许的 action：",
    "click_text — 按可见文案点击（text）",
    "click_role — 按 role+name 点击（role + text）",
    "fill — 把既定值填入匹配控件（text=控件标签；值由系统提供，你不许改）",
    "select_option — 在已打开的下拉里选选项（text）",
    "skip_step — 本步是可选中间步且后续填写已在页上",
    dismissLine,
    "need_hitl — 需要人工（支付/验证码等）",
    "abort — 无法安全愈合",
    "禁止编造验证码/OTP/密码/支付。confidence < 0.55 请输出 abort。",
  ].join("\n");

  const user = [
    `stepType: ${input.stepType}`,
    `label: ${input.label.slice(0, 80)}`,
    `failReason: ${input.failReason.slice(0, 200)}`,
    `url: ${input.url.slice(0, 200)}`,
    `title: ${input.title.slice(0, 120)}`,
    input.fillValue != null ? `fillValueLength: ${String(input.fillValue).length}` : "",
    "visibleControls:",
    ...input.controls.slice(0, 30).map((c, i) => `${i + 1}. [${c.tag}/${c.role}] ${c.text}`),
  ]
    .filter(Boolean)
    .join("\n");

  input.logger.progress("replay_ai_heal_llm", {
    phase: "replay_ai_heal_start",
    model: route.model,
    label: input.label.slice(0, 60),
  });

  const response = await client.chat.completions.create({
    model: route.model,
    temperature: 0.1,
    max_tokens: 120,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return parseHealJson(extractAssistantContent(response));
}

async function clickByText(page: Page, text: string, signal?: AbortSignal): Promise<boolean> {
  const want = String(text ?? "").trim();
  if (!want) return false;
  const candidates = clickLabelHealCandidates(want);
  for (const label of candidates.length ? candidates : [want]) {
    try {
      const loc = page.getByText(label, { exact: false }).first();
      await loc.click({ force: true, timeout: 3_000 });
      return true;
    } catch {
      /* next */
    }
  }
  if (looksLikeDropdownOptionLabel(want)) {
    return tryClickListOptionByLabel(page, want);
  }
  return false;
}

async function clickByRole(page: Page, role: string, name: string): Promise<boolean> {
  const r = String(role || "button").trim().toLowerCase();
  const n = String(name || "").trim();
  if (!n) return false;
  try {
    await page.getByRole(r as "button", { name: n, exact: false }).first().click({
      force: true,
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function fillByLabel(page: Page, label: string, value: string): Promise<boolean> {
  const want = String(label ?? "").trim();
  const text = String(value ?? "");
  if (!want) return false;
  try {
    const byLabel = page.getByLabel(want, { exact: false }).first();
    if ((await byLabel.count().catch(() => 0)) > 0) {
      await byLabel.fill(text, { timeout: 4_000 });
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const byPlaceholder = page.getByPlaceholder(want, { exact: false }).first();
    if ((await byPlaceholder.count().catch(() => 0)) > 0) {
      await byPlaceholder.fill(text, { timeout: 4_000 });
      return true;
    }
  } catch {
    /* fall through */
  }
  // 密码框兜底
  if (/password|密碼|密码|pwd/i.test(want)) {
    try {
      await page.locator('input[type="password"]').first().fill(text, { timeout: 4_000 });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 尝试单步 AI 愈合。调用方须已确认机械+启发式失败。
 * skip 是否合法由 caller 传入的 `skipAllowed` 证明（后置条件）。
 */
export async function attemptReplayAiHeal(input: {
  page: Page;
  stepType: string;
  label: string;
  failReason: string;
  redacted?: boolean;
  fillValue?: string;
  skipAllowed: boolean;
  skipReason?: string;
  config: ReplayAiHealConfig;
  budget: ReplayAiHealBudget;
  aiSettings: SidecarAiSettings | null | undefined;
  logger: JsonLogger;
  signal?: AbortSignal;
  /** 仅诊断；不用于改写轨迹 */
  steps?: TrajectoryStep[];
  stepIndex?: number;
}): Promise<HealAttemptResult> {
  if (!input.config.enabled) {
    return { ok: false, reason: "AI 愈合已关闭" };
  }
  if (!input.budget.canUse()) {
    return {
      ok: false,
      reason: `本轮 AI 愈合预算已用尽（${input.config.maxPerRun}），请重录或检查页面`,
    };
  }
  if (!input.aiSettings?.apiKey?.trim()) {
    return { ok: false, reason: "缺少 AI 设置，无法步愈合" };
  }

  const eligibility = classifyHealEligibility({
    stepType: input.stepType,
    label: input.label,
    redacted: input.redacted,
    failReason: input.failReason,
  });
  if (!eligibility.ok) {
    return { ok: false, reason: eligibility.reason };
  }

  input.budget.consume();
  const page = input.page;
  let url = "";
  let title = "";
  try {
    url = page.url();
    title = await page.title();
  } catch {
    /* ignore */
  }
  const controls = await collectVisibleControls(page);

  let decided: ReturnType<typeof parseHealJson> = null;
  try {
    decided = await askHealAction({
      aiSettings: input.aiSettings,
      logger: input.logger,
      stepType: input.stepType,
      label: input.label,
      failReason: input.failReason,
      url,
      title,
      controls,
      fillValue: input.fillValue,
      allowDismissBlocker: input.config.allowDismissBlocker,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `愈合模型调用失败：${msg.slice(0, 160)}` };
  }

  if (!decided) {
    return { ok: false, reason: "愈合模型未返回合法 JSON 动作" };
  }
  if ((decided.confidence ?? 1) < 0.55) {
    return { ok: false, reason: "愈合置信过低，已拒绝", action: decided.action };
  }
  if (decided.action === "abort") {
    return { ok: false, reason: "模型判定无法安全愈合", action: "abort" };
  }
  if (decided.action === "need_hitl") {
    return { ok: false, reason: "本步需要人工介入（愈合拒做）", action: "need_hitl" };
  }
  if (decided.action === "skip_step") {
    if (!input.skipAllowed) {
      return {
        ok: false,
        reason: "模型要求跳过，但后置条件未证明后续填写已就绪",
        action: "skip_step",
      };
    }
    return {
      ok: true,
      outcome: "skip_step",
      action: "skip_step",
      message: input.skipReason || "AI 确认跳过可选中间步（后置条件已满足）",
    };
  }

  if (decided.action === "dismiss_blocker") {
    if (!input.config.allowDismissBlocker) {
      return { ok: false, reason: "清障愈合已关闭", action: "dismiss_blocker" };
    }
    const btn = String(decided.text || "").trim();
    if (!btn) {
      return { ok: false, reason: "dismiss_blocker 缺少按钮文案", action: "dismiss_blocker" };
    }
    const dismissed = await clickByText(page, btn, input.signal);
    if (!dismissed) {
      return { ok: false, reason: `清障未点中「${btn.slice(0, 40)}」`, action: "dismiss_blocker" };
    }
    // 清障后立刻在本模块内完成本步意图，避免外层改游标
    const type = input.stepType.toLowerCase();
    if (type === "fill" || type === "select") {
      const filled = await fillByLabel(page, input.label, String(input.fillValue ?? ""));
      if (!filled) {
        return {
          ok: false,
          reason: "已清障但本步填写仍未完成，请重试或重录",
          action: "dismiss_blocker",
        };
      }
      return {
        ok: true,
        outcome: "healed",
        action: "dismiss_blocker",
        message: `已清障并完成本步填写（「${btn.slice(0, 24)}」）`,
      };
    }
    const clicked =
      (await clickByText(page, input.label, input.signal)) ||
      (looksLikeDropdownOptionLabel(input.label) &&
        (await tryClickListOptionByLabel(page, input.label)));
    if (!clicked) {
      return {
        ok: false,
        reason: "已清障但本步点击仍未完成，请重试或重录",
        action: "dismiss_blocker",
      };
    }
    return {
      ok: true,
      outcome: "healed",
      action: "dismiss_blocker",
      message: `已清障并完成本步点击（「${btn.slice(0, 24)}」）`,
    };
  }

  if (decided.action === "select_option") {
    const opt = String(decided.text || input.label || "").trim();
    const ok = await tryClickListOptionByLabel(page, opt);
    if (!ok) {
      return { ok: false, reason: `未选中下拉项「${opt.slice(0, 40)}」`, action: "select_option" };
    }
    return {
      ok: true,
      outcome: "healed",
      action: "select_option",
      message: `AI 已选中下拉项「${opt.slice(0, 40)}」`,
    };
  }

  if (decided.action === "fill") {
    const ok = await fillByLabel(
      page,
      String(decided.text || input.label),
      String(input.fillValue ?? ""),
    );
    if (!ok) {
      return { ok: false, reason: "AI 填写未命中可用控件", action: "fill" };
    }
    return {
      ok: true,
      outcome: "healed",
      action: "fill",
      message: "AI 已按标签完成本步填写",
    };
  }

  if (decided.action === "click_role") {
    const ok = await clickByRole(page, String(decided.role || "button"), String(decided.text || ""));
    if (!ok) {
      return { ok: false, reason: "AI click_role 未命中", action: "click_role" };
    }
    return {
      ok: true,
      outcome: "healed",
      action: "click_role",
      message: `AI 已按角色点击「${String(decided.text || "").slice(0, 40)}」`,
    };
  }

  if (decided.action === "click_text") {
    const ok = await clickByText(page, String(decided.text || input.label), input.signal);
    if (!ok) {
      return { ok: false, reason: "AI click_text 未命中", action: "click_text" };
    }
    return {
      ok: true,
      outcome: "healed",
      action: "click_text",
      message: `AI 已按文案点击「${String(decided.text || input.label).slice(0, 40)}」`,
    };
  }

  return { ok: false, reason: `未知愈合动作 ${String(decided.action)}` };
}
