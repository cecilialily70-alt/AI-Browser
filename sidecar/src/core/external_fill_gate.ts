/**
 * 外部数据 API（Python / JSON）的字段闸门。
 *
 * 为什么单独一个模块：外部程序只会给我们「字段名 + 值」，**没有 DOM 事实**
 * （没有 autocomplete / 相邻发码按钮 / maxlength 这些结构证据），所以不可能像
 * `human_credential.ts` 那样做结构判定。这时唯一可复核的依据就是**字段名**。
 *
 * 纪律（不做「尽力而为」的猜测，一律保守拒绝）：
 * - 支付/证件/私钥类字段 → 拒绝（R1：外部 API 永远不碰支付与不可逆凭证）；
 * - 站外送达的一次性凭证（邮箱/短信验证码、验证器/TOTP）→ 拒绝（R2：一次性码只走
 *   OTP 通道或人工，绝不允许外部程序直接灌进来）；
 * - 只说「码」的泛化字段（promo code / 验证码 / pin）→ **放行但告警**：正常优惠码
 *   也长这样，硬拒会误伤真实业务；把告警如实回给调用方，由它自己判断。
 *
 * 词典仍然是**配置**（`config/human_credential_lexicon.json` +
 * `config/action_risk_lexicon.json`），代码里不含任何站点文案（§7.2）。
 */
import { loadHumanCredentialLexicon } from "./human_credential.js";
import { loadActionRiskLexicon } from "./hitl_policy.js";

export interface ExternalFillVerdict {
  /** false = 该字段禁止由外部 API 填写 */
  allowed: boolean;
  /** 拒绝/告警的结构化依据（写明命中了哪条词条，便于调用方改字段名或改走 Agent） */
  reason: string;
  /** 命中了泛化「码」词条：放行，但要在回执里提醒调用方 */
  warning: string | null;
}

const ALLOWED: ExternalFillVerdict = { allowed: true, reason: "", warning: null };

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function firstHit(haystack: string, terms: string[]): string | null {
  for (const term of terms) {
    if (term && haystack.includes(term)) {
      return term;
    }
  }
  return null;
}

const FALLBACK_CRITICAL_FIELDS = ["cvv", "cvc", "card number", "private key", "seed phrase"];

/**
 * 判定一个字段名能否由外部数据 API 填写。
 *
 * @param rawName 字段名（调用方给的 name；也允许它直接给页面上的 label 文案）
 */
export function classifyExternalFillFieldName(rawName: string): ExternalFillVerdict {
  const name = normalize(String(rawName ?? ""));
  if (!name) {
    return { allowed: false, reason: "字段名为空", warning: null };
  }

  const risk = loadActionRiskLexicon();
  const criticalFields = risk?.fieldTerms.critical ?? FALLBACK_CRITICAL_FIELDS;
  const criticalHit = firstHit(name, criticalFields);
  if (criticalHit) {
    return {
      allowed: false,
      reason: `字段名命中支付/证件/密钥类词条「${criticalHit}」：外部 API 不得填写（R1）`,
      warning: null,
    };
  }

  const credential = loadHumanCredentialLexicon();
  if (credential) {
    const outOfBand = firstHit(name, credential.outOfBandTerms);
    if (outOfBand) {
      return {
        allowed: false,
        reason: `字段名命中「站外送达的一次性凭证」词条「${outOfBand}」：只走邮箱/短信通道或人工确认（R2）`,
        warning: null,
      };
    }
    const totp = firstHit(name, credential.totpKindTerms);
    if (totp) {
      return {
        allowed: false,
        reason: `字段名命中验证器/TOTP 词条「${totp}」：动态口令必须人工提供（R2）`,
        warning: null,
      };
    }
    const generic = firstHit(name, credential.genericCodeTerms);
    if (generic) {
      return {
        allowed: true,
        reason: "",
        warning: `字段名含「${generic}」，像验证码类字段：若它其实是一次性凭证，请改走 Agent 的 OTP 通道或人工确认`,
      };
    }
  }

  return ALLOWED;
}

/** 批量判定；任一被拒都不填（外部 API 一律**全有或全无**，避免半填出脏表单） */
export function classifyExternalFillFields(names: string[]): {
  refused: Array<{ name: string; reason: string }>;
  warnings: string[];
} {
  const refused: Array<{ name: string; reason: string }> = [];
  const warnings: string[] = [];
  for (const name of names) {
    const verdict = classifyExternalFillFieldName(name);
    if (!verdict.allowed) {
      refused.push({ name, reason: verdict.reason });
      continue;
    }
    if (verdict.warning) {
      warnings.push(`${name}：${verdict.warning}`);
    }
  }
  return { refused, warnings };
}
