/**
 * 敏感信息脱敏（日志 / 轨迹统一入口）
 *
 * 目标：任何写向 stdout、本地 IPC、磁盘轨迹的内容都不落地明文密钥。
 * 三类能力：
 * 1. `redactSecrets`  —— 按 key 名递归遮蔽对象/数组中的密文值（日志 data）。
 * 2. `redactSecretText` —— 按形态遮蔽自由文本里的密钥（日志 message，保留其余可读内容）。
 * 3. `isSecretInput`  —— 判断表单字段是否属于密码/验证码类，供轨迹落盘替换 value。
 */

/** 敏感词表：key 名「包含」其中之一才有资格被遮蔽（再由安全后缀排除元数据字段）。 */
const SECRET_KEY_TOKENS = [
  "apikey",
  "secret",
  "passwd",
  "password",
  "passphrase",
  "authorization",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "bearer",
  "credential",
  "privatekey",
  "licensekey",
  "sessionid",
  "cookie",
  "otp",
  "cvv",
  "cardnumber",
  "验证码",
  "密码",
  "密钥",
];

/**
 * 安全后缀：命中这些后缀说明字段是「关于密钥的元数据」而非密钥本身。
 * 没有这条排除规则时，`licenseKeySource` / `tokenCount` / `passwordFile` 会被整体
 * 误遮蔽成 `***`，把排障信息一起抹掉（曾经的过度遮蔽问题）。
 */
const SAFE_KEY_SUFFIXES = [
  "source",
  "path",
  "file",
  "name",
  "status",
  "count",
  "plan",
  "kind",
  "type",
  "reason",
  "url",
  "provider",
  "state",
  "tier",
  "valid",
  "expires",
  "at",
];

/** key 名是否为敏感字段（对比紧凑化后的名字，忽略 `_`/`-` 与大小写）。 */
export function isSecretKeyName(key: string): boolean {
  const compact = String(key ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  if (!compact) {
    return false;
  }
  if (SAFE_KEY_SUFFIXES.some((suffix) => compact.endsWith(suffix))) {
    return false;
  }
  return SECRET_KEY_TOKENS.some((token) => compact.includes(token));
}

/** 自由文本中的密钥形态：Bearer xxx、JWT、sk-xxx、cb_xxx（本产品 License Key）。 */
const SECRET_TEXT_RES = [
  /\b(?:bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  // CloakBrowser License Key（含内置免费 Key）：绝不允许出现在日志/上报里
  /\bcb_[0-9a-z]{16,}\b/gi,
];

/** `key=value` / `key: value` 形态：保留键名便于排障，只遮蔽值。 */
const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|secret|license[_-]?key)\b(\s*[:=]\s*)("?)([^\s,;"'}]{4,})\3/gi;

const MASK = "***";
const MAX_DEPTH = 24;

/** 遮蔽自由文本中的密钥；无命中时原样返回，保持日志可读性与协议字段语义。 */
export function redactSecretText(text: string): string {
  let out = String(text ?? "");
  for (const re of SECRET_TEXT_RES) {
    out = out.replace(re, MASK);
  }
  return out.replace(
    SECRET_ASSIGNMENT_RE,
    (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}${MASK}${quote}`,
  );
}

/** 递归遮蔽对象中的敏感值；超出深度或循环引用时降级为字符串，绝不抛异常。 */
export function redactSecrets(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (value == null || typeof value !== "object") {
    return typeof value === "string" ? redactSecretText(value) : value;
  }
  if (depth >= MAX_DEPTH) {
    return "[depth-limit]";
  }
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value as object)) {
    return "[circular]";
  }
  visited.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1, visited));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      isSecretKeyName(key) && entry != null
        ? MASK
        : redactSecrets(entry, depth + 1, visited);
  }
  return out;
}

/** 表单字段是否为密码/验证码类：type 优先，其次 name/id/label 语义。 */
export function isSecretInput(input: {
  inputType?: string | null;
  label?: string | null;
  selector?: string | null;
}): boolean {
  const type = String(input.inputType ?? "").trim().toLowerCase();
  if (type === "password" || type === "hidden") {
    return true;
  }
  const hint = [input.label, input.selector].map((v) => String(v ?? "")).join(" ");
  return /password|passwd|pwd|otp|one[_-]?time|cvv|card[_-]?number|secret|pin\b|密码|验证码|口令/i.test(
    hint,
  );
}

export { MASK as REDACTED_PLACEHOLDER };
