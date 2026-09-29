/**
 * 沙盘延迟生成引擎 — 变量插值 + Just-in-Time fast_text 造数
 */
import type { SidecarAiSettings } from "./engine.js";
import { createModelRouter } from "./ai_model_router.js";
import { extractAssistantContent } from "./ai_client.js";
import type { JsonLogger } from "./json-logger.js";
import {
  buildGeoPersonaContextBlock,
  COLLOQUIAL_TEXT_CONSTRAINT,
  isColloquialField,
  parseGeoContext,
  parsePersonaData,
  suggestPhoneHint,
  type GeoContext,
  type PersonaData,
} from "./persona_engine.js";
import { formatConstraintForInputType } from "./semantic_sniff.js";
import { hash32 } from "./core/hash32.js";

export type FieldOverrideMode = "fixed" | "ai_prompt";

export interface FieldOverrideSpec {
  mode: FieldOverrideMode;
  value: string;
  label?: string;
  inputType?: string;
}
export function normalizeFieldOverride(raw: unknown): FieldOverrideSpec {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return { mode: "fixed", value: String(raw ?? "") };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const modeRaw = String(record.mode ?? "fixed").trim().toLowerCase();
    const mode: FieldOverrideMode = modeRaw === "ai_prompt" ? "ai_prompt" : "fixed";
    return {
      mode,
      value: record.value == null ? "" : String(record.value),
      label: record.label != null ? String(record.label) : undefined,
      inputType: record.inputType != null ? String(record.inputType) : undefined,
    };
  }
  return { mode: "fixed", value: "" };
}

export function parseFieldOverrides(
  raw: unknown,
): Record<string, FieldOverrideSpec> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, FieldOverrideSpec> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const selector = String(key ?? "").trim();
    if (!selector) {
      continue;
    }
    out[selector] = normalizeFieldOverride(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function lookupPath(root: Record<string, unknown>, path: string): string {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  let cursor: unknown = root;
  for (const part of parts) {
    if (Array.isArray(cursor)) {
      // 支持 {{clip.0}} 这类数组下标（回放中途读取的剪贴板内容）
      const index = Number.parseInt(part, 10);
      if (!Number.isInteger(index) || index < 0) return "";
      cursor = cursor[index];
      continue;
    }
    if (!cursor || typeof cursor !== "object") {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor == null) {
    return "";
  }
  return String(cursor);
}

/** 构建模板上下文：persona.* / geoip.* 及别名；extra 用于回放期的 run.* / data.* / clip.* */
export function buildTemplateContext(
  geo: GeoContext | null | undefined,
  persona: PersonaData | null | undefined,
  extra?: Record<string, unknown> | null,
): Record<string, unknown> {
  const personaObj: Record<string, unknown> = { ...(persona ?? {}) };
  if (persona?.fullName && !personaObj.name) {
    personaObj.name = persona.fullName;
  }
  if (persona?.firstName && persona?.lastName && !personaObj.name) {
    personaObj.name = `${persona.firstName} ${persona.lastName}`.trim();
  }
  const geoObj: Record<string, unknown> = {
    city: geo?.city ?? "",
    country: geo?.country ?? "",
    countryCode: geo?.countryCode ?? "",
    region: geo?.region ?? "",
    timezone: geo?.timezone ?? "",
    locale: geo?.locale ?? "",
    exitIp: geo?.exitIp ?? "",
    ip: geo?.exitIp ?? "",
  };
  return {
    persona: personaObj,
    geoip: geoObj,
    geo: geoObj,
    ...(extra ?? {}),
  };
}

// 变量名允许中文（列名/人设字段可能是中文）：`{{data.关键词}}` / `{{persona.姓名}}`
const VAR_RE = /\{\{\s*([a-zA-Z_\u4e00-\u9fa5][\w.\u4e00-\u9fa5]*)\s*\}\}/g;

/** FNV-1a 32 位哈希（实现已下沉到无依赖叶子模块 `core/hash32.ts`；此处仅对外保持原入口） */

/**
 * 生成型数据的确定性种子（§5.7）：
 *   seed = hash32(`${runSeed}:${envId}:${runIndex}:${fieldKey}`)
 * 注意：模型/库的「确定性」只在同版本、同配置、同调用顺序下成立 ——
 * `runSeed` 必须落台账，且**不承诺值完全可复现**，只承诺「不同」＋「可诊断」。
 */
export function deriveGenerationSeed(
  templateExtra: Record<string, unknown> | null | undefined,
  fieldKey: string,
): number | null {
  const run = templateExtra?.run;
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const record = run as Record<string, unknown>;
  const runSeed = record.runSeed;
  if (runSeed == null || String(runSeed).trim() === "") return null;
  return hash32(`${runSeed}:${record.envId ?? ""}:${record.index ?? ""}:${fieldKey}`);
}

/** 将 {{persona.name}} / {{geoip.city}} / {{run.seq}} / {{data.email}} 替换为真实值 */
export function interpolateTemplate(
  template: string,
  geo: GeoContext | null | undefined,
  persona: PersonaData | null | undefined,
  extra?: Record<string, unknown> | null,
): string {
  const ctx = buildTemplateContext(geo, persona, extra);
  return String(template ?? "").replace(VAR_RE, (_match, path: string) => {
    return lookupPath(ctx, path);
  });
}

function fieldSemanticsHint(label: string, inputType?: string): string {
  return `${label} ${inputType ?? ""}`.trim();
}

/** 密码 / OTP / 卡号等：禁止 AI 盲盒，空值须用户在沙盘或数据集提供（R2） */
export function isMustUserProvideField(label: string, inputType?: string): boolean {
  const type = String(inputType ?? "").trim().toLowerCase();
  if (type === "password") {
    return true;
  }
  return /password|passwd|pwd|otp|token|card|cvv|ssn|密码|密碼|驗證|验证码|口令|pin\b/i.test(
    fieldSemanticsHint(label, inputType),
  );
}

/**
 * 一次性码 / 卡号等：回放也绝不可本地编造（R2）。
 * 普通「注册密码」除外——录制值已脱敏，回放可用确定性测试密码开新号。
 */
export function isOneTimeOrPaymentSecretField(label: string, inputType?: string): boolean {
  const type = String(inputType ?? "").trim().toLowerCase();
  if (type === "password") {
    return false;
  }
  return /otp|token|card|cvv|ssn|totp|sms|驗證碼|验证码|校验码|校驗碼|卡号|卡號|信用卡/i.test(
    fieldSemanticsHint(label, inputType),
  );
}

/** 是否像「注册/登录用的密码框」（可走确定性回放密码） */
export function isReplayablePasswordField(label: string, inputType?: string): boolean {
  const type = String(inputType ?? "").trim().toLowerCase();
  if (type === "password") {
    return !isOneTimeOrPaymentSecretField(label, inputType);
  }
  const hint = fieldSemanticsHint(label, inputType);
  if (/otp|token|cvv|驗證碼|验证码/i.test(hint)) {
    return false;
  }
  return /password|passwd|pwd|密码|密碼|口令/i.test(hint);
}

/** 邮箱 / 用户名：回放注册场景允许确定性本地兜底（非 OTP） */
export function isEmailOrUsernameField(label: string, inputType?: string): boolean {
  const type = String(inputType ?? "").trim().toLowerCase();
  if (type === "email") {
    return true;
  }
  return /email|e-?mail|郵箱|邮箱|電子郵件|电子邮箱|username|user[_-]?name|帳號|账号|用户名|登入名|登录名/i.test(
    fieldSemanticsHint(label, inputType),
  );
}

/**
 * 姓名类（姓氏/名字/姓名）：回放注册允许确定性本地兜底。
 * 排除用户名/显示名/昵称，避免和邮箱用户名兜底抢语义。
 */
export function isPersonNameField(label: string, inputType?: string): boolean {
  const hint = fieldSemanticsHint(label, inputType);
  if (
    /username|user[_-]?name|display[_-]?name|顯示名|显示名|昵称|暱稱|公司名|店铺名|店名|商品名/i.test(
      hint,
    )
  ) {
    return false;
  }
  return /姓氏|名字|姓名|完整姓名|first[_-]?name|last[_-]?name|given[_-]?name|sur[_-]?name|family[_-]?name|full[_-]?name|lastNameInput|firstNameInput|\blastname\b|\bfirstname\b/i.test(
    hint,
  );
}

export type PersonNameKind = "last" | "first" | "full";

export function personNameKind(label: string, inputType?: string): PersonNameKind | null {
  if (!isPersonNameField(label, inputType)) {
    return null;
  }
  const hint = fieldSemanticsHint(label, inputType);
  if (/姓氏|last[_-]?name|sur[_-]?name|family[_-]?name|lastNameInput|\blastname\b/i.test(hint)) {
    return "last";
  }
  if (/姓名|full[_-]?name|完整姓名/i.test(hint)) {
    return "full";
  }
  if (/名字|first[_-]?name|given[_-]?name|firstNameInput|\bfirstname\b/i.test(hint)) {
    return "first";
  }
  return "full";
}

function isEmailSemantics(label: string, inputType?: string): boolean {
  const type = String(inputType ?? "").trim().toLowerCase();
  if (type === "email") {
    return true;
  }
  return /email|e-?mail|郵箱|邮箱|電子郵件|电子邮箱/i.test(fieldSemanticsHint(label, inputType));
}

/** ASCII 姓名表：微软等注册页中英皆可；按 seed 取下标，可复现 */
const REPLAY_LAST_NAMES = [
  "Chen",
  "Lin",
  "Wang",
  "Zhang",
  "Li",
  "Huang",
  "Wu",
  "Liu",
  "Tsai",
  "Yang",
] as const;
const REPLAY_FIRST_NAMES = [
  "Ming",
  "Wei",
  "Jia",
  "Ting",
  "Hao",
  "Jun",
  "Mei",
  "Yu",
  "Hong",
  "Han",
] as const;

function pickBySeed<T extends readonly string[]>(table: T, seed: number): T[number] {
  const idx = Math.abs(seed) % table.length;
  return table[idx]!;
}

function buildDeterministicPersonName(
  kind: PersonNameKind,
  templateExtra?: Record<string, unknown> | null,
  persona?: PersonaData | null,
): string {
  const fromPersonaLast = String(persona?.lastName ?? "").trim();
  const fromPersonaFirst = String(persona?.firstName ?? "").trim();
  const fromPersonaFull = String(persona?.fullName ?? "").trim();
  if (kind === "last" && fromPersonaLast) return fromPersonaLast;
  if (kind === "first" && fromPersonaFirst) return fromPersonaFirst;
  if (kind === "full" && fromPersonaFull) return fromPersonaFull;
  if (kind === "full" && fromPersonaFirst && fromPersonaLast) {
    return `${fromPersonaFirst} ${fromPersonaLast}`.trim();
  }
  if (kind === "last" && fromPersonaFull) {
    const parts = fromPersonaFull.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 1]!;
  }
  if (kind === "first" && fromPersonaFull) {
    const parts = fromPersonaFull.split(/\s+/).filter(Boolean);
    if (parts.length >= 1) return parts[0]!;
  }

  const seed =
    deriveGenerationSeed(templateExtra, `name:${kind}`) ??
    hash32(`name:${kind}:${String((templateExtra?.run as Record<string, unknown> | undefined)?.uniqueId ?? "0")}`);
  const last = pickBySeed(REPLAY_LAST_NAMES, seed);
  const first = pickBySeed(REPLAY_FIRST_NAMES, seed >>> 8);
  if (kind === "last") return last;
  if (kind === "first") return first;
  return `${first} ${last}`;
}

/**
 * 回放注册密码：确定性、可复现、满足常见站点复杂度（大写+小写+数字+符号，≥10 位）。
 * 不是录制原值，也不经 AI（R2：不碰 OTP/token）。
 */
export function buildDeterministicReplayPassword(
  templateExtra?: Record<string, unknown> | null,
): string {
  const run =
    templateExtra?.run && typeof templateExtra.run === "object" && !Array.isArray(templateExtra.run)
      ? (templateExtra.run as Record<string, unknown>)
      : {};
  const uniqueRaw = run.uniqueId ?? run.unique_id;
  const uniqueId =
    uniqueRaw != null && String(uniqueRaw).trim() !== "" ? String(uniqueRaw).trim() : null;
  const seed = deriveGenerationSeed(templateExtra, "password");
  const id = (uniqueId ?? (seed != null ? String(seed >>> 0) : "0")).replace(/[^a-zA-Z0-9]/g, "");
  const body = ((id || "0") + "ReplayPad").slice(0, 12);
  return `Aa1!${body}zZ`;
}

/**
 * JIT / fast_text 返回空时的确定性本地值（§5.7）：优先 `run.uniqueId`，否则 seed / seq。
 * 邮箱 / 用户名 / 姓名；密码请用 buildDeterministicReplayPassword；OTP 不得走此路径。
 */
export function buildDeterministicLocalValue(
  label: string,
  inputType: string | undefined,
  templateExtra?: Record<string, unknown> | null,
  persona?: PersonaData | null,
): string | null {
  if (isMustUserProvideField(label, inputType)) {
    return null;
  }
  const nameKind = personNameKind(label, inputType);
  if (nameKind) {
    return buildDeterministicPersonName(nameKind, templateExtra, persona);
  }
  if (!isEmailOrUsernameField(label, inputType)) {
    return null;
  }
  const run =
    templateExtra?.run && typeof templateExtra.run === "object" && !Array.isArray(templateExtra.run)
      ? (templateExtra.run as Record<string, unknown>)
      : {};
  const uniqueRaw = run.uniqueId ?? run.unique_id;
  const uniqueId =
    uniqueRaw != null && String(uniqueRaw).trim() !== "" ? String(uniqueRaw).trim() : null;
  const seq = run.seq != null && String(run.seq).trim() !== "" ? String(run.seq).trim() : "0";
  const envRaw = String(run.envId ?? run.env_id ?? "env").replace(/[^a-zA-Z0-9]/g, "");
  const envTail = (envRaw || "env").slice(-6);
  const seed = deriveGenerationSeed(templateExtra, label);
  const id = uniqueId ?? (seed != null ? String(seed >>> 0) : `${envTail}${seq}`);
  if (isEmailSemantics(label, inputType)) {
    return `replay${id}@example.com`;
  }
  return `user${id}`;
}

function throwEmptyJitError(label: string, inputType?: string): never {
  if (isMustUserProvideField(label, inputType)) {
    throw new Error(
      `敏感字段「${label}」AI 盲盒未返回可用值：请在沙盘填固定值或用数据集覆盖（禁止空填/编造 OTP）`,
    );
  }
  throw new Error(
    `AI 盲盒造数返回空值（${label}）：请改用沙盘固定值（可用 {{run.uniqueId}}）或数据集列覆盖`,
  );
}

async function generateJustInTimeValue(input: {
  label: string;
  prompt: string;
  inputType?: string;
  geo: GeoContext | null;
  persona: PersonaData | null;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  /** 回放期模板上下文：{{run.*}} / {{data.*}} 在提示词里就地插值（§5.7） */
  templateExtra?: Record<string, unknown> | null;
}): Promise<string> {
  const label = input.label.trim() || "字段";
  if (isMustUserProvideField(label, input.inputType)) {
    throw new Error(
      `敏感字段「${label}」禁止 AI 盲盒生成：请在沙盘填固定值或用数据集覆盖`,
    );
  }

  const { route, client } = createModelRouter(input.aiSettings).forIntent(
    "fast_text",
    "沙盘 JIT 造数：极速文本",
  );

  const formatLock = formatConstraintForInputType(input.inputType);
  const phoneHint = suggestPhoneHint(input.geo);
  const contextBlock = buildGeoPersonaContextBlock(input.geo, input.persona);
  const mustColloquial = isColloquialField(label);
  // 模板里的 {{run.seq}} / {{data.x}} 先插值成具体值，再交给模型（让「这是第 N 次」可判定）
  const interpolatedPrompt = interpolateTemplate(input.prompt, input.geo, input.persona, input.templateExtra);
  const userPrompt = interpolatedPrompt.trim()
    ? interpolatedPrompt.trim()
    : `请为表单字段「${label}」生成一个符合上下文的真实测试值。`;

  const systemParts = [
    "你是天枢台沙盘延迟造数引擎（Just-in-Time）。为即将填入的表单字段生成最终值。",
    formatLock,
    `电话格式提示：${phoneHint}`,
    contextBlock,
  ];
  if (mustColloquial) {
    systemParts.push(COLLOQUIAL_TEXT_CONSTRAINT);
  }
  const seed = deriveGenerationSeed(input.templateExtra, label);

  input.logger.progress("sandbox_jit_generate", {
    model: route.model,
    intent: route.intent,
    label,
    inputType: input.inputType ?? null,
    seed,
  });

  const response = await client.chat.completions.create({
    model: route.model,
    temperature: mustColloquial ? 0.65 : 0.3,
    max_tokens: 80,
    ...(seed != null ? { seed } : {}),
    messages: [
      { role: "system", content: systemParts.join("\n") },
      {
        role: "user",
        content: [
          `Field label: ${label}`,
          `inputType: ${input.inputType ?? "text"}`,
          `Instruction: ${userPrompt}`,
          "Output ONLY the raw value:",
        ].join("\n"),
      },
    ],
  });

  const text = extractAssistantContent(response)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
  if (!text) {
    const local = buildDeterministicLocalValue(
      label,
      input.inputType,
      input.templateExtra,
      input.persona,
    );
    if (local) {
      const kind = local.includes("@")
        ? "email"
        : personNameKind(label, input.inputType)
          ? "name"
          : "username";
      input.logger.progress("sandbox_jit_local_fallback", {
        label,
        inputType: input.inputType ?? null,
        kind,
      });
      return local;
    }
    throwEmptyJitError(label, input.inputType);
  }
  return text;
}

export interface ResolveOverrideContext {
  geo?: unknown;
  persona?: unknown;
  aiSettings?: SidecarAiSettings | null;
  logger: JsonLogger;
  /** 回放期模板上下文：{ run, data, clip } → 供 {{run.*}} / {{data.*}} / {{clip.N}} 插值 */
  templateExtra?: Record<string, unknown> | null;
}

/**
 * 解析单字段运行时最终值：
 * - fixed → 模板插值
 * - ai_prompt → 填表前一秒 fast_text JIT
 */
export async function resolveFieldOverrideValue(
  spec: FieldOverrideSpec,
  fallbackRecorded: string,
  ctx: ResolveOverrideContext,
): Promise<string> {
  const geo = parseGeoContext(ctx.geo);
  const persona = parsePersonaData(ctx.persona);

  if (spec.mode === "fixed") {
    const raw = spec.value.length > 0 ? spec.value : fallbackRecorded;
    return interpolateTemplate(raw, geo, persona, ctx.templateExtra);
  }

  // ai_prompt
  if (!ctx.aiSettings?.apiKey?.trim()) {
    throw new Error("AI 盲盒字段需要配置 API Key（fast_text）");
  }
  return generateJustInTimeValue({
    label: spec.label?.trim() || "字段",
    prompt: spec.value,
    inputType: spec.inputType,
    geo,
    persona,
    aiSettings: ctx.aiSettings,
    templateExtra: ctx.templateExtra,
    logger: ctx.logger,
  });
}

export function lookupFieldOverride(
  selector: string,
  overrides?: Record<string, FieldOverrideSpec>,
): FieldOverrideSpec | undefined {
  if (!overrides) {
    return undefined;
  }
  const raw = String(selector ?? "").trim();
  if (!raw) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, raw)) {
    return overrides[raw];
  }
  // 与 replay_engine 选择器归一对齐的轻量兜底
  if (raw.startsWith("xpath=") && Object.prototype.hasOwnProperty.call(overrides, raw.slice(6))) {
    return overrides[raw.slice(6)];
  }
  if (!raw.startsWith("xpath=") && Object.prototype.hasOwnProperty.call(overrides, `xpath=${raw}`)) {
    return overrides[`xpath=${raw}`];
  }
  return undefined;
}
