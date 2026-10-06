/**
 * 聊天模式共用的**敏感内容判定与落盘脱敏**。
 *
 * 为什么单独一个模块：发送闸门（`engine.ts` 判「能不能发」）与上下文落盘
 * （`context_store.ts` 判「能不能写」）必须用**同一套口径**。两处各写一份正则，
 * 迟早一边放宽一边收紧，出现「发不出去但已经写进磁盘」这种最难查的缝。
 *
 * 两条红线（§1.2 / §1.3）：
 * - R2：一次性码（短信码 / TOTP / 验证码 token）**绝不落盘、绝不代发、绝不编造**。
 * - R1：支付 / 证件语义**绝不由聊天模式代发**。
 */
import { hashText } from "./outbox.js";

/**
 * 一次性码形态：**必须带上下文**才判定。
 *
 * 刻意不用「任意 4~8 位数字」——那会把「报价 5999」「库存 1200」这类正常内容统统拦死。
 * 只有紧跟验证码/口令类词、或紧跟 code/otp/pin 的数字串才算（宁漏不误拦；
 * 漏掉的由「绝不代发验证码」的人工路径兜住）。
 */
export const OTP_CONTEXT_RE =
  /(验证码|校验码|动态码|短信码|一次性密码|口令|code|otp|pin|token)[^\d\n]{0,12}\d{4,8}|\d{4,8}[^\d\n]{0,6}(验证码|校验码|动态码|短信码)/i;

/**
 * Agent 侧支付 / 证件语义（显式词表，避免误伤「转 2 号线地铁」）。
 * 聊天模式的 USDT/钱包通道另走 `chat_payment.ts`（只许发已配置付款方式，禁止编造）。
 */
export const SENSITIVE_TEXT_RE =
  /转账|转钱|转款|打款|汇款|付款|支付|收款码|付款码|红包提现|绑定银行卡|银行卡号|信用卡|卡号|cvv|安全码|身份证|护照|验证令牌|verification code|one[\s-]?time/i;

/** 任意 4~8 位数字串（仅在已确认处于一次性码语境时才用于脱敏） */
const DIGIT_RUN_RE = /\d{4,8}/g;

/** 疑似令牌：长十六进制/base64 串（token 语境下才脱敏） */
const TOKEN_LIKE_RE = /\b[A-Za-z0-9_-]{16,}\b/g;

export const REDACTION_PLACEHOLDER = "[已脱敏]";

/** 是否含红线语义（支付/证件 或 一次性码） */
export function isRedlineText(text: string): boolean {
  const raw = String(text ?? "");
  return SENSITIVE_TEXT_RE.test(raw) || OTP_CONTEXT_RE.test(raw);
}

/** 是否含一次性码语义（仅 R2，用于聊天模式「直接不发」而非「转人工」） */
export function hasOneTimeCode(text: string): boolean {
  return OTP_CONTEXT_RE.test(String(text ?? ""));
}

/** 是否含支付/证件语义（R1，需要转人工） */
export function hasPaymentIntent(text: string): boolean {
  return SENSITIVE_TEXT_RE.test(String(text ?? ""));
}

/**
 * 落盘前脱敏（§1.3「一次性码用完即弃」）。
 *
 * 策略是**fail-closed 的粗粒度遮蔽**：只要这段文本处于一次性码/令牌语境，
 * 就把其中所有 4~8 位数字串与长令牌串整体替换掉。宁可多遮几个字，
 * 也不能让一个真码留在 `thread.jsonl` 里。
 *
 * **非码语境的文本原样返回**：脱敏不能破坏正常对话的可读性（那会让上下文毫无用处）。
 */
export function redactForStorage(text: string): string {
  const raw = String(text ?? "");
  if (!raw) return raw;

  const codeContext = OTP_CONTEXT_RE.test(raw);
  const tokenContext = /\b(token|令牌|otp|验证码|口令|pin)\b/i.test(raw);
  if (!codeContext && !tokenContext) {
    return raw;
  }

  let out = raw;
  if (codeContext || tokenContext) {
    out = out.replace(DIGIT_RUN_RE, REDACTION_PLACEHOLDER);
  }
  if (tokenContext) {
    out = out.replace(TOKEN_LIKE_RE, (match) => (match.length >= 16 ? REDACTION_PLACEHOLDER : match));
  }
  return out;
}

/**
 * 内容指纹 —— **与发件箱 / 去重同一套**（`outbox.hashText`）。
 * 历史名 `fingerprint` 保留给调用方；禁止再实现第二套归一化。
 */
export function fingerprint(text: string): string {
  return hashText(text);
}

/** 脱敏 + 折叠空白：写进 ledger 的就是这个结果 */
export function sanitizeForLedger(text: string, maxChars = 2000): string {
  return redactForStorage(String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, maxChars);
}
