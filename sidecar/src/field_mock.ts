/**
 * 沙盘字段级 AI 造数 — 强制 fast_text 极速模型 + GeoIP/人设静默绑定
 */
import { createModelRouter } from "./ai_model_router.js";
import { stripFencedJson } from "./json_extract.js";
import type { SidecarAiSettings } from "./engine.js";
import {
  buildGeoPersonaContextBlock,
  COLLOQUIAL_TEXT_CONSTRAINT,
  isColloquialField,
  suggestPhoneHint,
  type GeoContext,
  type PersonaData,
} from "./persona_engine.js";

export interface SandboxMockFieldInput {
  /** valueOverrides 的 Key（通常为 selector） */
  key: string;
  /** 展示用 Label / Selector 提示 */
  label: string;
  /** 最终值输入框当前内容（可能是指令或已确认值） */
  currentValue: string;
}

export interface MockSandboxEnvFieldsRequest {
  envId: string;
  fields: SandboxMockFieldInput[];
  geo?: GeoContext | null;
  persona?: PersonaData | null;
  /** 仅 mock 指定 key；缺省则处理全部字段 */
  onlyKeys?: string[];
}

export interface MockSandboxEnvFieldsResult {
  envId: string;
  valueOverrides: Record<string, string>;
  summary: string;
}

const MAX_FIELDS = 40;

/** 指令特征：以「生成…」开头，或末尾问号，或明显造数口令 */
export function looksLikeAiInstruction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (/[?？]\s*$/.test(trimmed)) {
    return true;
  }
  if (
    /^(请|幫|帮)?(帮我|幫我)?(生成|隨機|随机|编造|編造|虚构|虛構|模拟|模擬|随便|隨便)/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/生成(一个|一個|一組|一组)?.{0,40}(电话|手機|手机|郵箱|邮箱|姓名|地址|邮编|郵編)/i.test(trimmed)) {
    return true;
  }
  return false;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const candidate = stripFencedJson(trimmed);
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("字段造数未返回 JSON 对象");
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("字段造数 JSON 根节点必须是对象");
  }
  return parsed as Record<string, unknown>;
}

function resolveUserPromptForField(field: SandboxMockFieldInput): string {
  const current = field.currentValue.trim();
  if (!current) {
    return `请为表单字段「${field.label || field.key}」生成一个符合上下文的真实测试值。`;
  }
  if (looksLikeAiInstruction(current)) {
    return current;
  }
  // 已有固定值：再点随机时，按 Label 盲盒重造（不把旧值当指令）
  return `请为表单字段「${field.label || field.key}」重新生成一个不同的真实测试值（勿复述旧值）。旧值仅供参考风格：${current.slice(0, 80)}`;
}

/**
 * 单环境多字段造数（一次 LLM 调用）。强制 fast_text。
 * 返回的 valueOverrides Key 必须与输入 field.key 原样一致。
 */
export async function mockSandboxEnvFields(
  request: MockSandboxEnvFieldsRequest,
  aiSettings: SidecarAiSettings,
): Promise<MockSandboxEnvFieldsResult> {
  const envId = String(request.envId ?? "").trim();
  if (!envId) {
    throw new Error("envId 不能为空");
  }

  const only = request.onlyKeys?.length
    ? new Set(request.onlyKeys.map((key) => String(key).trim()).filter(Boolean))
    : null;

  const fields = request.fields
    .map((field) => ({
      key: String(field.key ?? "").trim(),
      label: String(field.label ?? "").trim() || String(field.key ?? "").trim(),
      currentValue: String(field.currentValue ?? ""),
    }))
    .filter((field) => field.key)
    .filter((field) => (only ? only.has(field.key) : true))
    .slice(0, MAX_FIELDS);

  if (fields.length === 0) {
    throw new Error("没有可生成的字段");
  }

  // 私密字段跳过 AI，保留原值
  const skipKeys = new Set<string>();
  for (const field of fields) {
    if (/password|passwd|otp|token|card|cvv|ssn|密码|驗證|验证码/i.test(field.label) ||
      /password|passwd|otp|token|card|cvv|ssn|密码|驗證|验证码/i.test(field.key)) {
      skipKeys.add(field.key);
    }
  }

  const workFields = fields.filter((field) => !skipKeys.has(field.key));
  if (workFields.length === 0) {
    const valueOverrides: Record<string, string> = {};
    for (const field of fields) {
      valueOverrides[field.key] = field.currentValue;
    }
    return {
      envId,
      valueOverrides,
      summary: "敏感字段已跳过 AI 生成，保留原值",
    };
  }

  const { route, client } = createModelRouter(aiSettings).forIntent(
    "fast_text",
    "沙盘字段造数：极速文本",
  );

  const geo = request.geo ?? null;
  const persona = request.persona ?? null;
  const contextBlock = buildGeoPersonaContextBlock(geo, persona);
  const phoneHint = suggestPhoneHint(geo);
  const anyColloquial = workFields.some((field) => isColloquialField(field.label));

  const systemParts = [
    "你是天枢台沙盘的字段级造数引擎。为浏览器自动化测试生成真实、可用的表单值。",
    "必须输出纯 JSON：{ \"values\": { \"<fieldKey>\": \"<value>\" }, \"summary\": \"中文短说明\" }",
    "values 的 Key 必须是输入提供的 fieldKey 原样字符串，不得改写。",
    "每个 value 只含最终填入值，不要引号包裹说明，不要 Markdown。",
    "电话/邮编/地址必须与 GeoIP 同城。姓名、生日每次现生成，不要复用旧姓名。",
    `电话格式提示：${phoneHint}`,
    contextBlock,
  ];
  if (anyColloquial) {
    systemParts.push(COLLOQUIAL_TEXT_CONSTRAINT);
  }

  const fieldSpecs = workFields.map((field) => ({
    fieldKey: field.key,
    label: field.label,
    prompt: resolveUserPromptForField(field),
    emptyBlindBox: !field.currentValue.trim(),
    instructionMode: looksLikeAiInstruction(field.currentValue),
  }));

  const response = await client.chat.completions.create({
    model: route.model,
    temperature: anyColloquial ? 0.65 : 0.35,
    max_tokens: Math.min(2048, 80 + workFields.length * 60),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemParts.join("\n") },
      {
        role: "user",
        content: [
          `环境 ID：${envId}`,
          "请为下列字段生成最终值：",
          JSON.stringify(fieldSpecs, null, 2),
        ].join("\n"),
      },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("字段造数返回空内容");
  }

  const parsed = parseJsonObject(content);
  const valuesRaw =
    parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values)
      ? (parsed.values as Record<string, unknown>)
      : parsed.valueOverrides &&
          typeof parsed.valueOverrides === "object" &&
          !Array.isArray(parsed.valueOverrides)
        ? (parsed.valueOverrides as Record<string, unknown>)
        : parsed;

  const valueOverrides: Record<string, string> = {};
  for (const field of fields) {
    if (skipKeys.has(field.key)) {
      valueOverrides[field.key] = field.currentValue;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(valuesRaw, field.key)) {
      valueOverrides[field.key] = String(valuesRaw[field.key] ?? "")
        .trim()
        .replace(/^["'`]+|["'`]+$/g, "");
    } else {
      // 模型漏字段：留空让用户重试，避免错填
      valueOverrides[field.key] = "";
    }
  }

  const summary =
    String(parsed.summary ?? "").trim() ||
    `已为环境 #${envId} 生成 ${workFields.length} 个字段（模型 ${route.model}）`;

  return { envId, valueOverrides, summary };
}
