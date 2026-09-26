/**
 * HITL（人工确认）策略：任务级判定，而不是关键词级拦截。
 *
 * 旧实现只要控件文案/字段名命中「注册 / 登录 / 邮箱 / 密码 / 提交」就打断用户，
 * 于是「帮我在某站注册一个账号」这类任务会被自己拆解出的每一步反复确认 —— 确认疲劳，
 * 而且和用户意图直接冲突。这里改成两级判定，判定依据全部来自外部数据文件：
 *
 *   - critical（外部不可逆副作用：支付/转账/删除/发布/发送/改密…）
 *     → **任何情况下都确认**，且不因目标覆盖而豁免。
 *   - sensitive（注册/登录/提交 + 密码/验证码/邮箱/手机号等）
 *     → 只有当「用户目标本身没有覆盖该意图」时才确认；
 *       目标已明确要求（例如 goal 含「注册」「登录」）则视为用户已授权，放行并记录日志。
 *
 * 覆盖有两种来源：
 *   ① 目标命中同一风险级别的词（内建判定，如上）；
 *   ② 目标级**填写授权**短语（纯配置 `goalAuthorization.sensitiveFillTerms`，如「其余随机 /
 *      跳过人工」）：用户已写明让 AI 自行生成/填写其余字段 → 视为覆盖填写意图。
 *      只对 `kind === "fill"` 生效 —— sensitive 点击（提交/同意…）照旧确认；
 *      **critical 永不因此豁免**（上面的 critical 分支先返回）。
 *
 * 词典缺失时退化为保守策略：critical 仍确认，sensitive 一律确认（宁可多问，不可擅动）。
 *
 * ## 支付红线（P1.5 · 产品不可协商）
 *
 * - **无「自动支付」路径**：不存在跳过 HITL 的扣款/提交支付分支；`AUTO_PAYMENT_ALLOWED === false`。
 * - 支付 / 卡号 / CVV 等 critical 字段与点击：**永远 Layer 3**（人工确认或 handover）。
 * - 用户取消确认 = 动作失败（`denied-by-user`，不可重试同一动作）。
 * - 购物 / 订票（P3 commerce / booking Skill）合法终态是 `awaiting_human_payment`
 *   （停在支付前、待人工支付）；**禁止**在未获人工确认支付时用 `done(success=true)` 冒充已付款。
 * - 详见 `mayClaimPaymentSuccess` / `AWAITING_HUMAN_PAYMENT`。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";
import { engineSearchExemption } from "./page_policy.js";
import { firstHit, normalizeHaystack } from "./text_match.js";

export type RiskLevel = "critical" | "sensitive" | "none";

/**
 * Commerce / booking Skill 合法终态：已到收银台/确认页，等待人工完成支付。
 * P3 阶段 Skill 必须以该状态结束「代付」类目标；不得在无人确认时宣称已付款。
 */
export const AWAITING_HUMAN_PAYMENT = "awaiting_human_payment" as const;
export type PaymentTerminalStatus = typeof AWAITING_HUMAN_PAYMENT;

/** 产品红线：永远不存在自动提交支付 / 自动扣款路径 */
export const AUTO_PAYMENT_ALLOWED = false as const;

/**
 * 是否允许以「已付款 / 支付成功」宣称 `done(success=true)`。
 * 仅当人工侧已确认支付（HITL 确认完成或用户明确接管并完成）时为 true。
 * 与 `AUTO_PAYMENT_ALLOWED === false` 配套：无人确认永远不得宣称已付款。
 */
export function mayClaimPaymentSuccess(input: {
  humanPaymentConfirmed: boolean;
}): boolean {
  return AUTO_PAYMENT_ALLOWED === false && input.humanPaymentConfirmed === true;
}

export interface ActionRiskLexicon {
  /** critical 是否无条件确认（默认 true） */
  criticalConfirm: boolean;
  /** sensitive 是否仅在目标未覆盖时确认（默认 true） */
  sensitiveConfirmWhenGoalUncovered: boolean;
  /** 动作类风险词（点击/提交类文案） */
  actionTerms: Record<"critical" | "sensitive", string[]>;
  /** 字段类风险词（填写类字段名/占位符） */
  fieldTerms: Record<"critical" | "sensitive", string[]>;
  /**
   * 目标级「填写授权」短语（纯配置 `goalAuthorization.sensitiveFillTerms`）。
   * 命中即视为用户已覆盖 sensitive 填写意图（不逐条确认）；只对 fill 生效，critical 永不豁免。
   */
  sensitiveFillGoalTerms?: string[];
}

export interface HitlPolicyPageContext {
  /** 当前页面地址（用于"是否停在引擎首页"这一政策事实） */
  url: string;
  /** 控件的无障碍 role / 类型 / 身份（用于识别"这是引擎的搜索控件"） */
  role?: string | null;
  inputType?: string | null;
  name?: string | null;
  selector?: string | null;
}

export interface HitlPolicyInput {
  kind: "fill" | "click" | "select" | "evaluate";
  /** 控件可访问名 / 字段标签 */
  label: string;
  /** 将写入的值（fill 才有） */
  value?: string;
  /** 用户原始目标 */
  goal: string;
  /**
   * 页面/控件上下文（可选）。
   *
   * 缺省 = 没有任何豁免证据 → 判定与改造前**逐字一致**（既有调用方/单测无需改动）。
   * 传入后仅用于《搜索宪法》的引擎首页搜索豁免，不影响词典判定本身。
   */
  page?: HitlPolicyPageContext | null;
}

export interface HitlPolicyDecision {
  confirm: boolean;
  level: RiskLevel;
  /** 命中的风险词（动作侧或字段侧） */
  matched: string | null;
  /** 目标里覆盖该意图的词（未覆盖为 null） */
  goalMatched: string | null;
  /** 判定说明，用于日志与 HITL 卡片文案 */
  reason: string;
}

const MAX_TERM_LENGTH = 48;

let cached: ActionRiskLexicon | null | undefined;

function lexiconCandidates(): string[] {
  const env = readAppEnv("ACTION_RISK_LEXICON");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/action_risk_lexicon.json"));
  out.push(join(here, "../../../config/action_risk_lexicon.json"));
  out.push(join(process.cwd(), "config", "action_risk_lexicon.json"));
  out.push(join(process.cwd(), "sidecar", "config", "action_risk_lexicon.json"));
  return out;
}

export function resolveActionRiskLexiconPath(): string | null {
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

export function loadActionRiskLexicon(): ActionRiskLexicon | null {
  if (cached !== undefined) return cached;
  const path = resolveActionRiskLexiconPath();
  if (!path) {
    cached = null;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const policy = (parsed.policy ?? {}) as Record<string, unknown>;
    const risk = (parsed.risk ?? {}) as Record<string, Record<string, unknown>>;
    const goalAuth = (parsed.goalAuthorization ?? {}) as Record<string, unknown>;
    cached = {
      criticalConfirm: policy.criticalConfirm !== false,
      sensitiveConfirmWhenGoalUncovered: policy.sensitiveConfirmWhenGoalUncovered !== false,
      actionTerms: {
        critical: sanitizeTerms(risk.critical?.terms),
        sensitive: sanitizeTerms(risk.sensitive?.terms),
      },
      fieldTerms: {
        critical: sanitizeTerms(risk.critical?.fields),
        sensitive: sanitizeTerms(risk.sensitive?.fields),
      },
      sensitiveFillGoalTerms: sanitizeTerms(goalAuth.sensitiveFillTerms),
    };
  } catch {
    cached = null;
  }
  return cached;
}

/** 保守兜底：词典不可用时的最小风险词集（同样是通用动词，非站点文案） */
const FALLBACK_CRITICAL_ACTIONS = ["pay", "payment", "transfer", "withdraw", "delete", "publish", "send"];
const FALLBACK_CRITICAL_FIELDS = ["cvv", "cvc", "card number", "private key", "seed phrase"];
const FALLBACK_SENSITIVE_ACTIONS = ["sign up", "signup", "register", "login", "submit", "confirm"];
const FALLBACK_SENSITIVE_FIELDS = ["password", "otp", "email", "phone", "username"];

function normalize(value: string): string {
  return normalizeHaystack(value);
}

function classify(
  haystack: string,
  terms: { critical: string[]; sensitive: string[] },
): { level: RiskLevel; matched: string | null } {
  const critical = firstHit(haystack, terms.critical);
  if (critical) return { level: "critical", matched: critical };
  const sensitive = firstHit(haystack, terms.sensitive);
  if (sensitive) return { level: "sensitive", matched: sensitive };
  return { level: "none", matched: null };
}

/**
 * 判定某个动作是否需要人工确认。
 * 目标覆盖（goal coverage）：目标文本命中**同一风险级别**的任一词 → 视为用户已授权该级别意图。
 */
export function decideHitlConfirm(
  input: HitlPolicyInput,
  lexicon: ActionRiskLexicon | null = loadActionRiskLexicon(),
): HitlPolicyDecision {
  const label = String(input.label ?? "");
  const goal = normalize(input.goal ?? "");
  const actionHay = normalize(`${label} ${input.value ?? ""}`);
  const fieldHay = input.kind === "fill" ? normalize(label) : "";

  const actionTerms = lexicon?.actionTerms ?? {
    critical: FALLBACK_CRITICAL_ACTIONS,
    sensitive: FALLBACK_SENSITIVE_ACTIONS,
  };
  const fieldTerms = lexicon?.fieldTerms ?? {
    critical: FALLBACK_CRITICAL_FIELDS,
    sensitive: FALLBACK_SENSITIVE_FIELDS,
  };

  const fromAction = classify(actionHay, actionTerms);
  const fromField = fieldHay.length > 0 ? classify(fieldHay, fieldTerms) : { level: "none" as RiskLevel, matched: null };

  const level: RiskLevel =
    fromAction.level === "critical" || fromField.level === "critical"
      ? "critical"
      : fromAction.level === "sensitive" || fromField.level === "sensitive"
        ? "sensitive"
        : "none";
  const matched = fromAction.matched ?? fromField.matched;

  if (level === "none") {
    return {
      confirm: false,
      level,
      matched: null,
      goalMatched: null,
      reason: "未命中风险词典，属常规交互",
    };
  }

  /*
   * 《搜索宪法》配套豁免：引擎首页的搜索动作是**只读检索意图**，不是"敏感提交"。
   *
   * 位置很关键 —— 必须在 critical 判定**之后**、sensitive 目标覆盖判定**之前**：
   *   · 放 critical 之前 → 「不可逆动作任何情况下都要确认」会被绕过（安全约束失效）；
   *   · 放覆盖判定之后 → 目标未提"搜索"时仍会弹框（这正是不该发生的那次弹框）。
   * 只作用于 sensitive：critical 层永远不豁免。
   */
  if (level === "sensitive" && input.page) {
    const exempted = engineSearchExemption({
      url: input.page.url,
      kind: input.kind,
      role: input.page.role,
      inputType: input.page.inputType,
      name: input.page.name,
      selector: input.page.selector,
    });
    if (exempted) {
      // level 保留真实层级：调用方会据此打一条「HITL 放行」日志，豁免原因可追溯
      return {
        confirm: false,
        level,
        matched,
        goalMatched: null,
        reason: `${exempted}（HITL 豁免，非提交语义）`,
      };
    }
  }

  // 目标覆盖：同风险级别任一侧命中即算覆盖
  const goalMatched =
    level === "critical"
      ? (firstHit(goal, actionTerms.critical) ?? firstHit(goal, fieldTerms.critical))
      : (firstHit(goal, actionTerms.sensitive) ?? firstHit(goal, fieldTerms.sensitive));

  if (level === "critical") {
    const criticalConfirm = lexicon ? lexicon.criticalConfirm : true;
    return {
      confirm: criticalConfirm,
      level,
      matched,
      goalMatched,
      reason: `命中高不可逆风险词「${matched}」${
        goalMatched ? `，目标虽提及「${goalMatched}」也不豁免` : ""
      }，需确认`,
    };
  }

  const sensitiveConfirm = lexicon ? lexicon.sensitiveConfirmWhenGoalUncovered : true;
  // 目标级填写授权（纯配置短语）：用户已在目标里写明「其余随机 / 跳过人工」这类指令
  // → 视为已覆盖填写意图，填表不再逐条确认。只对 fill 生效；critical 分支在上面已返回，永不因此豁免。
  const fillAuthorized =
    input.kind === "fill" && lexicon
      ? firstHit(goal, lexicon.sensitiveFillGoalTerms ?? [])
      : null;
  if ((goalMatched || fillAuthorized) && sensitiveConfirm) {
    return {
      confirm: false,
      level,
      matched,
      goalMatched: goalMatched ?? fillAuthorized,
      reason: goalMatched
        ? `命中敏感词「${matched}」，但用户目标已用「${goalMatched}」明确覆盖该意图，视为已授权`
        : `命中敏感词「${matched}」，但目标已明示「${fillAuthorized}」授权其余字段自行填写，视为已授权（critical 仍不豁免）`,
    };
  }
  return {
    confirm: true,
    level,
    matched,
    goalMatched: null,
    reason: `命中敏感词「${matched}」，且用户目标未覆盖该意图，需确认`,
  };
}
