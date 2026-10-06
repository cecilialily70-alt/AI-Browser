/**
 * 一次性凭证字段（Human-Only Credential）
 *
 * 解决的问题：邮箱验证码 / 短信验证码 / 验证器动态码（OTP、TOTP）的**值只可能在用户本人手上**
 * （或经用户配置的邮箱 OTP 通道代取 —— P1.2 Layer 2）。
 * 提示词里早已写明「必须 ask_user 取得码值、禁止 AI 编造」，但那是**契约**，模型不遵守时没有任何兜底 ——
 * 用户报障的正是这个：Agent 走到「输入邮箱验证码」这一步，直接 done(success=true) 把任务"完成"了。
 *
 * 本模块把这件事变成**可判定的结构事实**：
 *   ① 判定（classify）：这个字段是不是「只能人来填」？依据是 Web 标准信号 + 结构信号 + 外部词典数据，
 *      代码里不含任何站点文案，也不靠「像不像验证码」这种模糊猜测；
 *   ② 渠道细分（kind）：email → fetch_email_otp；sms → fetch_sms_otp（须显式启用接码平台）；totp / generic 仍强制人工；
 *   ③ 汇总（findPending）：当前观察里还有哪些这样的字段是空的 —— 供完成度闸门与人工接管使用。
 *   ④ 通道已解析（channel-resolved）：邮箱通道取到的码视为已满足硬闸，用完即弃。
 *
 * 判定只用两条路，宁可漏判不可错杀（错杀的代价是打断用户）：
 *   A. `autocomplete="one-time-code"` —— HTML 标准里专门给一次性验证码留的取值，最强且与站点无关；
 *   B. 字段文案命中「站外送达的一次性凭证」词条（邮箱验证码/短信验证码/OTP/验证器…）。
 *   都不命中时，只在「文案只说『码』」+「数字型输入」+「旁边有发码入口」+「不是图形验证码」四条**同时**成立时才判定，
 *   专门用来兜住「验证码」这种一词两义（图形验证码 vs 邮箱验证码）的写法。
 *
 * 词典缺失（文件被删/被替换/解析失败）时退化为「只认 A 这一条标准信号」，功能不失效。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";

export interface HumanCredentialLexicon {
  autocompleteValues: string[];
  numericInputModes: string[];
  numericInputTypes: string[];
  numericPatternFragments: string[];
  outOfBandTerms: string[];
  /** P1.2：邮箱 OTP（可走通道） */
  emailKindTerms: string[];
  /** P1.2：短信 OTP（仍强制人工） */
  smsKindTerms: string[];
  /** P1.2：验证器 / TOTP（仍强制人工） */
  totpKindTerms: string[];
  genericCodeTerms: string[];
  sendCodeTerms: string[];
  imageCaptchaTerms: string[];
  codeMaxLengthMin: number;
  codeMaxLengthMax: number;
}

/** 一次性凭证渠道细分（决定能否走邮箱 OTP 通道） */
export type HumanCredentialKind = "email" | "sms" | "totp" | "generic";

/** 判定所需的字段事实（来自页内抽取；全部是结构/属性，不是站点文案判断） */
export interface HumanCredentialFieldFacts {
  tagName?: string | null;
  inputType?: string | null;
  autocomplete?: string | null;
  inputMode?: string | null;
  pattern?: string | null;
  maxLength?: number | null;
  /** 数字型输入（inputmode/type/pattern 任一命中） */
  numericHint?: boolean;
  /** 字段可引用文案（placeholder / label / name / aria-label / 自身文本 拼接） */
  label?: string | null;
  /** 同一容器内相邻可点控件的文案：用于识别「获取验证码 / 重新发送」与「刷新图形验证码」 */
  nearbyControls?: string[] | null;
}

export interface HumanCredentialVerdict {
  humanOnly: boolean;
  /** 结构化判定依据（写进观察层与日志，回答「凭什么说它只能人来填」） */
  reason: string;
}

const MAX_TERM_LENGTH = 48;
/** 单条依据最多引用几个相邻控件文案（避免 observation 膨胀） */
const MAX_NEARBY_QUOTED = 2;

let cached: HumanCredentialLexicon | null | undefined;

function lexiconCandidates(): string[] {
  const env = readAppEnv("HUMAN_CREDENTIAL_LEXICON");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/core 与 src/core 共用同一相对深度：../../config
  out.push(join(here, "../../config/human_credential_lexicon.json"));
  out.push(join(here, "../../../config/human_credential_lexicon.json"));
  out.push(join(process.cwd(), "config", "human_credential_lexicon.json"));
  out.push(join(process.cwd(), "sidecar", "config", "human_credential_lexicon.json"));
  return out;
}

export function resolveHumanCredentialLexiconPath(): string | null {
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

function sanitizeNumberRange(raw: unknown): [number, number] {
  const fallback: [number, number] = [3, 8];
  if (!Array.isArray(raw) || raw.length < 2) return fallback;
  const min = Number(raw[0]);
  const max = Number(raw[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return fallback;
  return [Math.trunc(min), Math.trunc(max)];
}

export function loadHumanCredentialLexicon(): HumanCredentialLexicon | null {
  if (cached !== undefined) return cached;
  const path = resolveHumanCredentialLexiconPath();
  if (!path) {
    cached = null;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const policy = (parsed.policy ?? {}) as Record<string, unknown>;
    const signals = (parsed.signals ?? {}) as Record<string, unknown>;
    const terms = (parsed.terms ?? {}) as Record<string, unknown>;
    const range = sanitizeNumberRange(policy.codeMaxLengthRange);
    cached = {
      autocompleteValues: sanitizeTerms(signals.autocompleteValues),
      numericInputModes: sanitizeTerms(signals.numericInputModes),
      numericInputTypes: sanitizeTerms(signals.numericInputTypes),
      numericPatternFragments: sanitizeTerms(signals.numericPatternFragments),
      // terms 里的 `_comment*` 键不是词表，sanitizeTerms 只认数组，天然忽略
      outOfBandTerms: sanitizeTerms(terms.outOfBand),
      emailKindTerms: sanitizeTerms(terms.emailKind),
      smsKindTerms: sanitizeTerms(terms.smsKind),
      totpKindTerms: sanitizeTerms(terms.totpKind),
      genericCodeTerms: sanitizeTerms(terms.genericCode),
      sendCodeTerms: sanitizeTerms(terms.sendCode),
      imageCaptchaTerms: sanitizeTerms(terms.imageCaptcha),
      codeMaxLengthMin: range[0],
      codeMaxLengthMax: range[1],
    };
  } catch {
    cached = null;
  }
  return cached;
}

/** 词条命中：整串相等或作为子串出现（与其它词典同一套匹配语义，避免大小写/空格差异漏判） */
function hitTerms(hay: string, terms: string[]): string | null {
  if (!hay || terms.length === 0) return null;
  for (const term of terms) {
    if (hay.includes(term)) return term;
  }
  return null;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 数字型输入判定（inputmode / type / pattern 三条结构线索） */
function looksNumeric(facts: HumanCredentialFieldFacts, lexicon: HumanCredentialLexicon | null): boolean {
  if (facts.numericHint === true) return true;
  const inputMode = normalize(facts.inputMode);
  const inputType = normalize(facts.inputType);
  const pattern = String(facts.pattern ?? "").toLowerCase();
  if (lexicon) {
    if (inputMode && lexicon.numericInputModes.includes(inputMode)) return true;
    if (inputType && lexicon.numericInputTypes.includes(inputType)) return true;
    if (pattern && lexicon.numericPatternFragments.some((frag) => pattern.includes(frag))) return true;
  } else {
    if (["numeric", "tel", "decimal"].includes(inputMode)) return true;
    if (["tel", "number"].includes(inputType)) return true;
  }
  return false;
}

/**
 * 判定一个字段是否「只能由用户本人提供」。
 *
 * 返回值里 `reason` 是结构化依据（哪条信号命中的），既不写进任何站点文案猜测，也不是「像」——
 * 全都是「标准属性 / 词典词条 / 同容器控件关系」这三类可复核的事实。
 */
export function classifyHumanCredentialField(
  facts: HumanCredentialFieldFacts,
): HumanCredentialVerdict {
  const none: HumanCredentialVerdict = { humanOnly: false, reason: "" };
  const tag = normalize(facts.tagName);
  const type = normalize(facts.inputType);
  // 只判「可输入文本的字段」：按钮/链接/下拉/勾选都没有「值」这回事
  const isField =
    tag === "input" || tag === "textarea" || (!tag && Boolean(type)) || type === "text" || type === "tel";
  if (!isField) return none;
  if (["hidden", "checkbox", "radio", "submit", "button", "file", "reset"].includes(type)) return none;

  const lexicon = loadHumanCredentialLexicon();

  // A. Web 标准信号：一次性验证码专用 autocomplete 取值（与站点、语言无关）
  const autocomplete = normalize(facts.autocomplete);
  const autocompleteHit = lexicon
    ? lexicon.autocompleteValues.find((value) => value && autocomplete.includes(value))
    : autocomplete.includes("one-time-code")
      ? "one-time-code"
      : undefined;
  if (autocompleteHit) {
    return { humanOnly: true, reason: `autocomplete=${autocompleteHit}（一次性验证码标准标记）` };
  }
  if (!lexicon) return none;

  const label = normalize(facts.label);
  const nearby = (facts.nearbyControls ?? []).map((item) => normalize(item)).filter(Boolean);
  const nearbyBlob = nearby.join(" ");

  // B. 文案直接说明「码由站外送达」：邮箱/短信/验证器 —— 命中即判定
  const outOfBand = hitTerms(label, lexicon.outOfBandTerms);
  if (outOfBand) {
    return { humanOnly: true, reason: `字段文案命中「站外送达的一次性凭证」词条「${outOfBand}」` };
  }

  // C. 兜底：只说「码」时，必须同时满足「数字型 + 旁边有发码入口 + 不是图形验证码」才判定
  const generic = hitTerms(label, lexicon.genericCodeTerms);
  if (generic) {
    const imageHit = hitTerms(label, lexicon.imageCaptchaTerms) ?? hitTerms(nearbyBlob, lexicon.imageCaptchaTerms);
    if (imageHit) return none; // 图形验证码：由视觉模型读，不是一次性凭证
    const sendHit = hitTerms(nearbyBlob, lexicon.sendCodeTerms);
    if (!sendHit) return none;
    if (!looksNumeric(facts, lexicon)) return none;
    const maxLength = facts.maxLength;
    if (
      typeof maxLength === "number" &&
      maxLength > 0 &&
      (maxLength < lexicon.codeMaxLengthMin || maxLength > lexicon.codeMaxLengthMax)
    ) {
      // 长度不像验证码（例如 maxlength=20 的「优惠码」）→ 不判定
      return none;
    }
    const quoted = nearby.filter((item) => hitTerms(item, lexicon.sendCodeTerms)).slice(0, MAX_NEARBY_QUOTED);
    return {
      humanOnly: true,
      reason: `「${generic}」这类字段 + 数字型输入 + 相邻发码入口「${quoted.join(" / ") || sendHit}」`,
    };
  }

  return none;
}

/** 汇总所需的元素事实（避免 core 反向依赖 bu_agent 的类型） */
export interface HumanCredentialCandidate {
  index: number;
  /** 人类可读的字段身份（用于日志与提示） */
  label: string;
  /** 判定依据 */
  reason: string;
  /** 字段当前是否已有内容 */
  filled: boolean;
  /** P1.2：渠道细分（决定能否走邮箱 OTP 通道） */
  kind: HumanCredentialKind;
}

/**
 * 当前观察里「还没填的一次性凭证字段」。
 * 只报**空**字段：已有内容说明码已经拿到（用户给的、用户自己填的、或通道已填的），不再需要人工介入。
 */
export function findPendingHumanCredentials(
  elements: Iterable<{
    index: number;
    humanOnly?: string | null;
    filled?: boolean | null;
    text?: string;
    placeholder?: string;
    name?: string;
  }>,
): HumanCredentialCandidate[] {
  const out: HumanCredentialCandidate[] = [];
  for (const el of elements) {
    const reason = String(el.humanOnly ?? "").trim();
    if (!reason) continue;
    if (el.filled === true) continue;
    const label = String(el.text || el.placeholder || el.name || `[${el.index}]`).trim().slice(0, 60);
    out.push({
      index: el.index,
      label,
      reason,
      filled: false,
      kind: classifyHumanCredentialKind({ label, reason }),
    });
  }
  return out;
}

/**
 * 细分凭证渠道：email / sms 可分别委托 Layer 2；TOTP / 不明来源仍强制人工。
 * 优先级：totp > sms > email > generic（宁可保守，避免把短信误判成可自动取）。
 */
export function classifyHumanCredentialKind(input: {
  label?: string | null;
  reason?: string | null;
}): HumanCredentialKind {
  const hay = `${normalize(input.label)} ${normalize(input.reason)}`.trim();
  if (!hay) return "generic";
  const lexicon = loadHumanCredentialLexicon();
  if (lexicon) {
    if (hitTerms(hay, lexicon.totpKindTerms)) return "totp";
    if (hitTerms(hay, lexicon.smsKindTerms)) return "sms";
    if (hitTerms(hay, lexicon.emailKindTerms)) return "email";
    return "generic";
  }
  // 词典缺失时的最小兜底（与红线一致：只认明确邮箱线索）
  if (/authenticator|totp|验证器|两步验证|双因素|2fa|mfa/.test(hay)) return "totp";
  if (/短信|手机验证|sms\b|text message/.test(hay)) return "sms";
  if (/邮箱|邮件|e-?mail/.test(hay)) return "email";
  return "generic";
}

/** 邮箱 OTP 可走 Layer 2 邮箱通道 */
export function isEmailOtpChannelEligible(kind: HumanCredentialKind): boolean {
  return kind === "email";
}

/** P5.3：短信 OTP 可走 Layer 2 接码平台（须服务显式启用；否则仍 HITL） */
export function isSmsOtpChannelEligible(kind: HumanCredentialKind): boolean {
  return kind === "sms";
}

/** 通道已解析的码是否与待写入值一致（用完即弃前的匹配） */
export function matchesChannelResolvedOtp(
  value: string,
  channel: { code: string } | null | undefined,
): boolean {
  const expected = String(channel?.code ?? "").trim();
  const actual = String(value ?? "").trim();
  if (!expected || !actual) return false;
  return expected === actual;
}

/**
 * 一次性凭证硬闸是否放行本次数值。
 * - 人给的值（ask_user / 确认框 override / handover 后 humanInvolved）
 * - 或：邮箱类字段 + 与邮箱通道刚解析的码一致（P1.2）
 * - 或：短信类字段 + 与短信通道刚解析的码一致（P5.3；服务须显式启用）
 * TOTP / generic 永不因通道放行。
 */
export function isHumanCredentialValueAuthorized(input: {
  humanOnlyReason: string;
  label: string;
  value: string;
  humanProvided: boolean;
  /** @deprecated 兼容旧调用：等同 channelEmailOtp */
  channelOtp?: { code: string } | null;
  channelEmailOtp?: { code: string } | null;
  channelSmsOtp?: { code: string } | null;
}): boolean {
  if (input.humanProvided) return true;
  const reason = String(input.humanOnlyReason ?? "").trim();
  if (!reason) return true; // 非凭证字段
  const kind = classifyHumanCredentialKind({ label: input.label, reason });
  if (isEmailOtpChannelEligible(kind)) {
    return matchesChannelResolvedOtp(
      input.value,
      input.channelEmailOtp ?? input.channelOtp,
    );
  }
  if (isSmsOtpChannelEligible(kind)) {
    return matchesChannelResolvedOtp(input.value, input.channelSmsOtp);
  }
  return false;
}
