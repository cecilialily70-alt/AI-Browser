/**
 * 聊天模式付款方式（与 Agent 支付红线分开）。
 *
 * - 不得编造钱包/卡号：只许发送用户已配置的付款方式
 * - 发送时只发纯付款内容，不夹废话
 * - 对方谈交易 / 索要付款方式 → 记「疑似交易」
 */

export type ChatPaymentKind = "usdt_trc20" | "usdt_erc20" | "bank" | "other";

export interface ChatPaymentMethod {
  id: string;
  kind: ChatPaymentKind;
  label: string;
  value: string;
}

/** 像付款载荷（钱包 / 卡号 / 转账指令），不含「报价多少钱」这类日常问价 */
const PAYMENT_PAYLOAD_RE =
  /(\busdt\b|\bbtc\b|bitcoin|ethereum|\beth\b|trc20|erc20|bep20|wallet\s*address|crypto\s*wallet|银行卡|卡号|iban|swift|wire\s*transfer|bank\s*transfer|תעביר|להעביר|ארנק|0x[a-fA-F0-9]{40}\b|\bT[1-9A-HJ-NP-Za-km-z]{33}\b)/i;

/** 对方在要付款方式 / 收款地址 */
const PAYMENT_ASK_RE =
  /(钱包|地址|usdt|trc20|erc20|银行卡|卡号|收款|怎么付|付款方式|转账地址|wallet|address|iban|payment\s*method|ארנק|כתובת|איך\s*לשלם)/i;

/** 疑似进入成交 / 交易语境 */
const TRADE_SIGNAL_RE =
  /(下单|成交|付款|转账|打款|汇款|买了|要了|锁单|定金|订金|usdt|trc20|wallet|transfer|pay|order|סוגרים|תעביר|לשלם|משלוח)/i;

export function looksLikePaymentPayload(text: string): boolean {
  return PAYMENT_PAYLOAD_RE.test(String(text ?? ""));
}

export function isPaymentAsk(text: string): boolean {
  return PAYMENT_ASK_RE.test(String(text ?? ""));
}

export function isTradeSignal(text: string): boolean {
  return TRADE_SIGNAL_RE.test(String(text ?? ""));
}

export function normalizePaymentValue(value: string): string {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

export function parsePaymentMethods(raw: unknown): ChatPaymentMethod[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatPaymentMethod[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const value = String(record.value ?? "").trim();
    if (!value || value.length > 200) continue;
    const id = String(record.id ?? "").trim() || `pay_${i + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kindRaw = String(record.kind ?? "other").trim().toLowerCase();
    const kind: ChatPaymentKind =
      kindRaw === "usdt_trc20" ||
      kindRaw === "usdt_erc20" ||
      kindRaw === "bank" ||
      kindRaw === "other"
        ? kindRaw
        : "other";
    const label = String(record.label ?? "").trim().slice(0, 60) || kind;
    out.push({ id, kind, label, value });
    if (out.length >= 20) break;
  }
  return out;
}

/** 目标框里若粘了钱包地址，升成配置（避免只写在目标里却拦发送） */
export function extractPaymentMethodsFromGoal(goal: string): ChatPaymentMethod[] {
  const text = String(goal ?? "");
  const found: ChatPaymentMethod[] = [];
  const tron = text.match(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/);
  if (tron) {
    found.push({
      id: "goal_usdt_trc20",
      kind: "usdt_trc20",
      label: "USDT-TRC20",
      value: tron[0],
    });
  }
  const eth = text.match(/\b0x[a-fA-F0-9]{40}\b/);
  if (eth) {
    found.push({
      id: "goal_usdt_erc20",
      kind: "usdt_erc20",
      label: "USDT-ERC20",
      value: eth[0],
    });
  }
  return found;
}

export function mergePaymentMethods(
  configured: readonly ChatPaymentMethod[],
  fromGoal: readonly ChatPaymentMethod[],
): ChatPaymentMethod[] {
  const byNorm = new Map<string, ChatPaymentMethod>();
  for (const method of [...configured, ...fromGoal]) {
    const key = normalizePaymentValue(method.value).toLowerCase();
    if (!key || byNorm.has(key)) continue;
    byNorm.set(key, method);
  }
  return [...byNorm.values()];
}

export function findMatchingPaymentMethod(
  text: string,
  methods: readonly ChatPaymentMethod[],
): ChatPaymentMethod | null {
  const raw = String(text ?? "");
  const compact = normalizePaymentValue(raw).toLowerCase();
  if (!compact) return null;
  for (const method of methods) {
    const needle = normalizePaymentValue(method.value).toLowerCase();
    if (needle && compact.includes(needle)) return method;
  }
  return null;
}

/** 纯付款方式：整段就是配置值（允许前后空白 / 一个标签前缀） */
export function isPlainPaymentText(
  text: string,
  method: ChatPaymentMethod,
): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  const value = method.value.trim();
  if (!value) return false;
  if (raw === value) return true;
  // 允许「USDT-TRC20\n<地址>」或「<标签> <地址>」两行内
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1) {
    return normalizePaymentValue(lines[0]!) === normalizePaymentValue(value);
  }
  if (lines.length === 2) {
    const joined = lines.join("\n");
    if (joined === `${method.label}\n${value}` || joined === `${method.kind}\n${value}`) {
      return true;
    }
    return lines.some((line) => normalizePaymentValue(line) === normalizePaymentValue(value))
      && lines.every(
        (line) =>
          normalizePaymentValue(line) === normalizePaymentValue(value) ||
          line.length <= 40,
      );
  }
  return false;
}

export function plainPaymentText(method: ChatPaymentMethod): string {
  return String(method.value ?? "").trim();
}

/**
 * 聊天发送闸门用的付款判定：
 * - 不含付款载荷 → ok
 * - 含付款载荷且命中已配置且是纯付款 → ok
 * - 含付款载荷且命中已配置但夹废话 → plain_only
 * - 含付款载荷但未配置/编造 → block
 */
export type PaymentGateDecision =
  | { kind: "ok" }
  | { kind: "plain_only"; method: ChatPaymentMethod; plain: string }
  | { kind: "block"; reason: string; needHandover: boolean };

export function decidePaymentGate(
  text: string,
  methods: readonly ChatPaymentMethod[],
): PaymentGateDecision {
  const raw = String(text ?? "").trim();
  if (!raw || !looksLikePaymentPayload(raw)) return { kind: "ok" };
  const matched = findMatchingPaymentMethod(raw, methods);
  if (!matched) {
    return {
      kind: "block",
      reason:
        methods.length === 0
          ? "未配置付款方式：请在聊天设置里填写 USDT/银行卡后再发"
          : "付款内容不在已配置列表里（禁止编造支付通道）",
      needHandover: methods.length === 0,
    };
  }
  if (isPlainPaymentText(raw, matched)) return { kind: "ok" };
  return {
    kind: "plain_only",
    method: matched,
    plain: plainPaymentText(matched),
  };
}
