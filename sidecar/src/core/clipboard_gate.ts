/**
 * 剪贴板闸门（N5 / N6 · §6.4）—— 一次性凭证**默认拒绝自动填入**。
 *
 * 为什么需要它：剪贴板是数据源，但也是**最容易绕过 R2 的旁路** ——
 * 「去网页点复制验证码 → 回放粘贴」如果默认放行，就等于把「自动取码」做成了产品能力。
 * 因此这里做**结构判定**（不猜站点、不看语言）：
 *
 *   ① 命中 `human_credential_lexicon.json` 的站外送达 / 通用验证码词条 → 一次性凭证；
 *   ② 纯数字（可含空格/连字符）且位数落在词表的码长区间（默认 3–8）→ 一次性凭证。
 *
 * 判定是的**内容**而不是字段：值本身像码就拦，与它来自哪个页面无关。
 * 只有用户在回放设置里显式勾选「剪贴板视为人工提供」才放行 —— 勾选即视为用户明示
 * 「这是我自己复制的码」，责任回到人身上（与 `human_credential` 的 humanProvided 同一条口径）。
 *
 * 日志纪律（§6.4 / R1.3）：本模块**只输出长度与依据，永不输出内容**。
 */
import {
  loadHumanCredentialLexicon,
  type HumanCredentialLexicon,
} from "./human_credential.js";

export interface ClipboardTextVerdict {
  /** 内容被判为一次性凭证 → 默认不允许自动填入 */
  credential: boolean;
  /** 结构化依据（可写进日志：只讲「凭什么判」，不含任何内容字符） */
  reason: string;
  /** 内容长度（字符数） */
  length: number;
}

/** 日志/上报安全的描述：只给长度。 */
export function describeClipboardForLog(text: string): string {
  return `剪贴板文本 ${text.length} 字符`;
}

/** 纯数字（允许分隔用的空格 / 连字符 / 全角空格） */
function digitsOnly(text: string): string {
  return text.replace(/[\s\u3000\-–—]/g, "");
}

function hitAny(hay: string, terms: string[]): string | null {
  const lower = hay.toLowerCase();
  for (const term of terms) {
    if (term && lower.includes(term)) return term;
  }
  return null;
}

/**
 * 判定剪贴板**内容**是否属于一次性凭证。
 *
 * 宁可漏判不可错杀：把订单号（长数字）判成码会让主用途失效，
 * 所以数字启发只覆盖**短码区间**（词表 `codeMaxLengthRange`，默认 3–8）。
 */
export function classifyClipboardText(raw: string): ClipboardTextVerdict {
  const text = String(raw ?? "").replace(/\u0000/g, "").trim();
  const length = text.length;
  if (!text) {
    return { credential: false, reason: "内容为空", length: 0 };
  }

  const lexicon: HumanCredentialLexicon | null = loadHumanCredentialLexicon();
  const wordTerms = lexicon
    ? [
        ...lexicon.outOfBandTerms,
        ...lexicon.emailKindTerms,
        ...lexicon.smsKindTerms,
        ...lexicon.totpKindTerms,
        ...lexicon.genericCodeTerms,
      ]
    : ["验证码", "校验码", "动态码", "verification code", "one-time", "otp", "totp"];

  // ① 文本自带凭证语义（例如「您的验证码是 123456」）
  const wordHit = hitAny(text, wordTerms);
  if (wordHit) {
    return {
      credential: true,
      reason: `内容命中一次性凭证词条「${wordHit}」`,
      length,
    };
  }

  // ② 纯数字短码
  const digits = digitsOnly(text);
  const min = lexicon?.codeMaxLengthMin ?? 3;
  const max = lexicon?.codeMaxLengthMax ?? 8;
  if (/^\d+$/.test(digits) && digits.length >= min && digits.length <= max) {
    return {
      credential: true,
      reason: `纯数字 ${digits.length} 位（落在一次性码长度区间 ${min}-${max}）`,
      length,
    };
  }

  return { credential: false, reason: "普通数据（非一次性凭证）", length };
}

export interface ClipboardGateInput {
  text: string;
  /** 用户在回放设置里显式勾选「剪贴板视为人工提供」 */
  treatAsHuman?: boolean;
}

export interface ClipboardGateVerdict extends ClipboardTextVerdict {
  allowed: boolean;
}

/**
 * 闸门：是否允许把这份剪贴板内容当作自动填入的值。
 *
 * - 普通数据 → 放行（订单号、链接、验证结果等，这是剪贴板的主要用途）；
 * - 一次性凭证 → **默认拒绝**；只有 `treatAsHuman === true` 才放行（用户明示）。
 */
export function gateClipboardValue(input: ClipboardGateInput): ClipboardGateVerdict {
  const verdict = classifyClipboardText(input.text);
  const allowed = !verdict.credential || input.treatAsHuman === true;
  return { ...verdict, allowed };
}
