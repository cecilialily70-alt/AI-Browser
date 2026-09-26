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

/** FNV-1a 32 位哈希：把「运行种子 + 稳定身份 + 字段」派生成确定性种子（§5.7） */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

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
  if (/password|passwd|otp|token|card|cvv|ssn|密码|驗證|验证码/i.test(label)) {
    throw new Error(`敏感字段「${label}」禁止 AI 盲盒生成`);
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
    throw new Error(`JIT 造数返回空值（${label}）`);
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
