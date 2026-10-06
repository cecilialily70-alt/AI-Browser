/**
 * P1.4 — HITL 情境文案（AI 生成 + 模板兜底）
 *
 * Layer 3 弹窗主文案：短标题 + 2–4 行说明 + 主按钮。
 * 禁止编造未证实细节（如具体手机尾号）；LLM 超时/失败必须回退模板，UI 永不空白。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import { beginAgentLlmWait, createLlmClient, extractAssistantContent } from "../ai_client.js";
import { createModelRouter, isIntentConfigured } from "../ai_model_router.js";
import { extractJsonObject } from "../bu_agent/prompts.js";
import type { SidecarAiSettings } from "../engine.js";
import { readAppEnv } from "../app_env.js";

/** 用户需要执行的动作类型（计划强制枚举） */
export type HitlUserAction =
  | "enter_code"
  | "complete_challenge"
  | "confirm_payment"
  | "take_over_browser";

/** 失败/触发原因枚举（稳定字段，便于日志与测试） */
export type HitlFailureReason =
  | "otp_channel_missing"
  | "otp_channel_failed"
  | "otp_human_required"
  | "captcha_attempts_exhausted"
  | "captcha_ambiguous"
  | "payment_critical"
  | "sensitive_confirm"
  | "arbiter_escalate"
  | "agent_ask"
  | "agent_handover"
  | "empty_fill"
  | "low_confidence"
  | "other";

export interface HitlAiCopy {
  title: string;
  /** 2–4 行说明，用 \\n 分隔 */
  body: string;
  primaryButton: string;
  source: "llm" | "template";
  actionType: HitlUserAction;
}

/** 结构化事实包（强制字段；禁止塞入未证实细节） */
export interface HitlCopyFactPack {
  goalSummary: string;
  url: string;
  pageTitle: string;
  pageKind: string;
  pendingCredentialFields: string[];
  captchaAttempts: number | null;
  failureReason: HitlFailureReason;
  userAction: HitlUserAction;
  /** 模型/动作原始 question 或 reason（可截断；不得含 OTP 明文） */
  rawHint?: string;
}

interface HitlCopyTemplate {
  title: string;
  body: string;
  primaryButton: string;
}

interface HitlCopyConfig {
  llmTimeoutMs: number;
  templates: Record<HitlUserAction, HitlCopyTemplate>;
}

const DEFAULT_TEMPLATES: Record<HitlUserAction, HitlCopyTemplate> = {
  enter_code: {
    title: "需要你输入验证码",
    body:
      "当前页面在等待邮箱/短信/验证器里的一次性验证码。\n" +
      "请打开对应收件箱或验证器，把刚收到的码填到下方。\n" +
      "系统不会猜测或编造验证码。",
    primaryButton: "提交验证码",
  },
  complete_challenge: {
    title: "需要你完成人机验证",
    body:
      "自动过验证码已达上限或无法继续。\n" +
      "请在浏览器里手动完成滑块/点选等人机挑战。\n" +
      "完成后点继续，Agent 会重新感知页面。",
    primaryButton: "我已完成验证",
  },
  confirm_payment: {
    title: "支付前需你确认",
    body:
      "即将触及支付/扣款相关操作，Agent 不会自动提交支付。\n" +
      "请核对金额与收款方后，由你本人确认或接管浏览器完成支付。\n" +
      "取消将视为本步失败，Agent 不会换说法重试同一支付动作。",
    primaryButton: "确认继续",
  },
  take_over_browser: {
    title: "需要你接管浏览器",
    body:
      "当前步骤无法安全自动完成，Agent 已暂停。\n" +
      "请在浏览器中手动处理当前页面，完成后点继续。\n" +
      "若无法继续，可中止本次任务。",
    primaryButton: "我已处理，继续",
  },
};

const DEFAULT_CONFIG: HitlCopyConfig = {
  llmTimeoutMs: 10_000,
  templates: DEFAULT_TEMPLATES,
};

const ACTION_TYPES = new Set<HitlUserAction>([
  "enter_code",
  "complete_challenge",
  "confirm_payment",
  "take_over_browser",
]);

let cachedConfig: HitlCopyConfig | undefined;

function configCandidates(): string[] {
  const env = readAppEnv("HITL_COPY_TEMPLATES");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/hitl_copy_templates.json"));
  out.push(join(here, "../../../config/hitl_copy_templates.json"));
  out.push(join(process.cwd(), "config", "hitl_copy_templates.json"));
  out.push(join(process.cwd(), "sidecar", "config", "hitl_copy_templates.json"));
  return out;
}

export function resolveHitlCopyTemplatesPath(): string | null {
  for (const candidate of configCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* skip */
    }
  }
  return null;
}

function parseTemplate(raw: unknown): HitlCopyTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = String(o.title ?? "").trim();
  const body = String(o.body ?? "").trim();
  const primaryButton = String(o.primaryButton ?? o.primary_button ?? "").trim();
  if (!title || !body || !primaryButton) return null;
  return { title, body, primaryButton };
}

export function loadHitlCopyConfig(): HitlCopyConfig {
  if (cachedConfig) return cachedConfig;
  let timeoutMs = DEFAULT_CONFIG.llmTimeoutMs;
  const templates: Record<HitlUserAction, HitlCopyTemplate> = { ...DEFAULT_TEMPLATES };
  const path = resolveHitlCopyTemplatesPath();
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const t = Number(parsed.llmTimeoutMs ?? parsed.llm_timeout_ms);
      if (Number.isFinite(t) && t >= 2000 && t <= 60_000) timeoutMs = Math.floor(t);
      const block = parsed.templates;
      if (block && typeof block === "object") {
        for (const key of ACTION_TYPES) {
          const one = parseTemplate((block as Record<string, unknown>)[key]);
          if (one) templates[key] = one;
        }
      }
    } catch {
      /* 坏文件 → 内置默认 */
    }
  }
  cachedConfig = { llmTimeoutMs: timeoutMs, templates };
  return cachedConfig;
}

/** 测试用：清空配置缓存 */
export function resetHitlCopyConfigCache(): void {
  cachedConfig = undefined;
}

/** URL 脱敏：只保留 origin + pathname（去 query/hash，防 token 泄漏） */
export function redactHitlUrl(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`.slice(0, 180);
  } catch {
    return s.replace(/[?#].*$/, "").slice(0, 180);
  }
}

/** 目标摘要：截断，去掉疑似码值 */
export function summarizeGoalForHitl(goal: string, max = 120): string {
  let s = String(goal ?? "").replace(/\s+/g, " ").trim();
  s = scrubUnverifiedDetails(s);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * scrub 未证实细节：手机尾号、完整手机号、看起来像 OTP 的独立数字串。
 * 用于 LLM 输出与事实包 hint，防止弹窗编造「尾号 1234」之类。
 */
export function scrubUnverifiedDetails(text: string): string {
  let s = String(text ?? "");
  s = s.replace(/尾号\s*[:：]?\s*\d{2,8}/gi, "尾号（未证实，已省略）");
  s = s.replace(
    /(?:手机|电话|号码).{0,6}(?:后|末)\s*\d{0,4}\s*位\s*[:：]?\s*\d{2,8}/gi,
    "手机号（未证实，已省略）",
  );
  s = s.replace(/(?:^|[^\d])(1[3-9]\d{9})(?!\d)/g, (m) =>
    m.replace(/1[3-9]\d{9}/, "[手机号已省略]"),
  );
  s = s.replace(
    /(?:验证码|校验码|动态码|code)\s*[:：=]?\s*\d{4,8}/gi,
    "验证码（请到收件端查看）",
  );
  return s.trim();
}

function normalizeBodyLines(body: string): string {
  const lines = scrubUnverifiedDetails(body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (lines.length < 2) {
    return lines[0] ?? body.trim();
  }
  return lines.join("\n");
}

export function templateHitlCopy(action: HitlUserAction): HitlAiCopy {
  const cfg = loadHitlCopyConfig();
  const t = cfg.templates[action] ?? DEFAULT_TEMPLATES[action];
  return {
    title: t.title,
    body: t.body,
    primaryButton: t.primaryButton,
    source: "template",
    actionType: action,
  };
}

function parseLlmCopy(content: string, action: HitlUserAction): HitlAiCopy | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = extractJsonObject(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed) return null;
  const title = scrubUnverifiedDetails(String(parsed.title ?? "").trim()).slice(0, 40);
  const body = normalizeBodyLines(String(parsed.body ?? parsed.description ?? ""));
  const primaryButton = scrubUnverifiedDetails(
    String(parsed.primaryButton ?? parsed.primary_button ?? parsed.button ?? "").trim(),
  ).slice(0, 24);
  if (!title || !body || !primaryButton) return null;
  if (/\d{4,}/.test(title) && /尾号|后四位|末四位/.test(title)) return null;
  const lineCount = body.split("\n").filter(Boolean).length;
  if (lineCount > 4) return null;
  return {
    title,
    body,
    primaryButton,
    source: "llm",
    actionType: action,
  };
}

/** 从上下文启发式推断 userAction（无站点硬编码） */
export function inferHitlUserAction(input: {
  channel: "ask" | "handover" | "confirm";
  text?: string;
  confirmLevel?: string | null;
  captchaAttempts?: number | null;
  pendingCredentialKinds?: string[];
}): HitlUserAction {
  const hay = `${input.text ?? ""} ${input.confirmLevel ?? ""}`.toLowerCase();
  const kinds = input.pendingCredentialKinds ?? [];
  if (
    input.confirmLevel === "critical" ||
    /支付|付款|checkout|payment|pay\b|扣款|转账|提现|redeem/i.test(hay)
  ) {
    return "confirm_payment";
  }
  if (
    input.channel === "handover" &&
    /滑块|点选|人机|captcha|turnstile|recaptcha|拼图|验证码连续|无法判定/i.test(hay)
  ) {
    return "complete_challenge";
  }
  if (
    (typeof input.captchaAttempts === "number" && input.captchaAttempts >= 1) &&
    /滑块|点选|人机|captcha|验证/i.test(hay)
  ) {
    return "complete_challenge";
  }
  if (
    kinds.length > 0 ||
    /验证码|校验码|otp|sms|邮箱.?码|短信|验证器|totp|auth\s*code/i.test(hay)
  ) {
    return "enter_code";
  }
  return "take_over_browser";
}

export function inferHitlFailureReason(input: {
  channel: "ask" | "handover" | "confirm";
  text?: string;
  confirmLevel?: string | null;
  userAction?: HitlUserAction;
}): HitlFailureReason {
  const hay = String(input.text ?? "");
  if (/not_configured|未配置/.test(hay)) return "otp_channel_missing";
  if (/通道失败|otp.*fail|timeout|超时/.test(hay) && /邮箱|otp|通道/i.test(hay)) {
    return "otp_channel_failed";
  }
  if (input.userAction === "enter_code" || /验证码|otp|sms|totp/i.test(hay)) {
    return "otp_human_required";
  }
  if (/连续失败|attempts_exhausted|满\s*\d+\s*次/i.test(hay)) return "captcha_attempts_exhausted";
  if (/无法判定|ambiguous/i.test(hay)) return "captcha_ambiguous";
  if (input.userAction === "confirm_payment" || input.confirmLevel === "critical") {
    return "payment_critical";
  }
  if (input.confirmLevel === "sensitive") return "sensitive_confirm";
  if (/arbiter|计划矛盾/i.test(hay)) return "arbiter_escalate";
  if (input.channel === "ask") return "agent_ask";
  if (input.channel === "handover") return "agent_handover";
  if (/内容为空|需确认/.test(hay)) return "empty_fill";
  if (/低置信/.test(hay)) return "low_confidence";
  return "other";
}

/** 纯模板路径（同步）——保证 UI 永不空白 */
export function buildHitlCopyFromTemplate(facts: HitlCopyFactPack): HitlAiCopy {
  return templateHitlCopy(facts.userAction);
}

/**
 * 生成 HITL 情境文案：先尝试短 LLM，失败/超时/不合规 → 模板。
 */
export async function generateHitlCopy(input: {
  facts: HitlCopyFactPack;
  aiSettings: SidecarAiSettings;
  signal?: AbortSignal;
}): Promise<HitlAiCopy> {
  const fallback = buildHitlCopyFromTemplate(input.facts);
  const cfg = loadHitlCopyConfig();
  let wait: ReturnType<typeof beginAgentLlmWait> | null = null;
  try {
    const router = createModelRouter(input.aiSettings);
    if (!isIntentConfigured(router.pool, "logic") && !isIntentConfigured(router.pool, "fast_text")) {
      return fallback;
    }
    const intent = isIntentConfigured(router.pool, "logic") ? "logic" : "fast_text";
    const resolved = router.resolve(intent);
    const client = createLlmClient(input.aiSettings);
    wait = beginAgentLlmWait({
      parentSignal: input.signal,
      timeoutMs: cfg.llmTimeoutMs,
    });
    const f = input.facts;
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `你是浏览器 Agent 的人工介入文案助手。根据结构化事实生成弹窗文案。
只输出 JSON：{"title":"短标题","body":"2到4行说明，用换行分隔","primaryButton":"主按钮文案"}
硬约束：
- 禁止编造未证实细节（禁止写具体手机尾号、完整手机号、具体验证码数字、未给出的金额）；
- 只依据事实包；事实没有的信息不要补；
- title ≤ 20 字；body 2～4 行；primaryButton ≤ 12 字；
- 语气清晰、可操作；中文；不要 Markdown。`,
      },
      {
        role: "user",
        content:
          `<action_type>${f.userAction}</action_type>\n` +
          `<failure_reason>${f.failureReason}</failure_reason>\n` +
          `<goal>${f.goalSummary || "（未提供）"}</goal>\n` +
          `<url>${f.url || "（未知）"}</url>\n` +
          `<page_title>${(f.pageTitle || "").slice(0, 80) || "（无）"}</page_title>\n` +
          `<page_kind>${f.pageKind || "other"}</page_kind>\n` +
          `<pending_credential_fields>${
            f.pendingCredentialFields.slice(0, 6).join(" | ") || "（无）"
          }</pending_credential_fields>\n` +
          `<captcha_attempts>${
            f.captchaAttempts == null ? "未知" : String(f.captchaAttempts)
          }</captcha_attempts>\n` +
          `<raw_hint>${(f.rawHint || "").slice(0, 200) || "（无）"}</raw_hint>\n` +
          `请生成弹窗文案。`,
      },
    ];
    const completion = await client.chat.completions.create(
      {
        model: resolved.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      } as never,
      { signal: wait.signal },
    );
    const parsed = parseLlmCopy(extractAssistantContent(completion), f.userAction);
    if (parsed) return parsed;
    return fallback;
  } catch {
    return fallback;
  } finally {
    wait?.stop();
  }
}

/** 组装事实包（调用方提供已有上下文；本函数做脱敏与推断） */
export function buildHitlCopyFactPack(input: {
  channel: "ask" | "handover" | "confirm";
  goal: string;
  url: string;
  pageTitle?: string;
  pageKind?: string;
  pendingCredentialFields?: string[];
  pendingCredentialKinds?: string[];
  captchaAttempts?: number | null;
  confirmLevel?: string | null;
  rawHint?: string;
  userAction?: HitlUserAction;
  failureReason?: HitlFailureReason;
}): HitlCopyFactPack {
  const userAction =
    input.userAction ??
    inferHitlUserAction({
      channel: input.channel,
      text: input.rawHint,
      confirmLevel: input.confirmLevel,
      captchaAttempts: input.captchaAttempts,
      pendingCredentialKinds: input.pendingCredentialKinds,
    });
  const failureReason =
    input.failureReason ??
    inferHitlFailureReason({
      channel: input.channel,
      text: input.rawHint,
      confirmLevel: input.confirmLevel,
      userAction,
    });
  return {
    goalSummary: summarizeGoalForHitl(input.goal),
    url: redactHitlUrl(input.url),
    pageTitle: scrubUnverifiedDetails(String(input.pageTitle ?? "").slice(0, 80)),
    pageKind: String(input.pageKind ?? "other").slice(0, 40),
    pendingCredentialFields: (input.pendingCredentialFields ?? [])
      .map((x) => scrubUnverifiedDetails(String(x).slice(0, 40)))
      .filter(Boolean)
      .slice(0, 8),
    captchaAttempts:
      typeof input.captchaAttempts === "number" && Number.isFinite(input.captchaAttempts)
        ? Math.max(0, Math.floor(input.captchaAttempts))
        : null,
    failureReason,
    userAction,
    rawHint: input.rawHint
      ? scrubUnverifiedDetails(String(input.rawHint).slice(0, 240))
      : undefined,
  };
}
