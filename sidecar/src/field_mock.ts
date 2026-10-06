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
import {
  buildDeterministicLocalValue,
  buildDeterministicReplayPassword,
  isOneTimeOrPaymentSecretField,
  isReplayablePasswordField,
} from "./deferred_generation.js";
import { hash32 } from "./core/hash32.js";

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
  if (!trimmed) {
    throw new Error("字段造数返回空内容");
  }
  const candidate = stripFencedJson(trimmed);
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("字段造数未返回 JSON 对象（正文无 { … }）");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`字段造数 JSON 解析失败：${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("字段造数 JSON 根节点必须是对象");
  }
  return parsed as Record<string, unknown>;
}

function isJsonFormatUnsupported(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /response_format|json_object|not support|unsupported|invalid.?request/i.test(msg);
}

function clarifyMockError(error: unknown): Error {
  const msg = error instanceof Error ? error.message : String(error);
  if (/missing apiKey|api[_ ]?key.*(empty|missing|未配置)|unauthorized|401/i.test(msg)) {
    return new Error("字段造数失败：AI API Key 为空或无效，请到「设置 → AI」配置后重试");
  }
  if (/字段造数返回空内容|empty content|choices.*empty/i.test(msg)) {
    return new Error("字段造数失败：模型返回空内容（请换模型或稍后重试）");
  }
  if (/未返回 JSON|JSON 解析失败|JSON 根节点/i.test(msg)) {
    return new Error(`字段造数失败：${msg.replace(/^字段造数/, "").replace(/^失败：/, "") || msg}`);
  }
  return error instanceof Error ? error : new Error(msg);
}

/** 单字段确定性本地值（邮箱/用户名/姓名/注册密码）；OTP 等永不编造 */
export function localValueForSandboxField(input: {
  envId: string;
  key: string;
  label: string;
  currentValue?: string;
  persona?: PersonaData | null;
}): string | null {
  const hint = `${input.label} ${input.key}`.trim();
  if (isOneTimeOrPaymentSecretField(hint) || isOneTimeOrPaymentSecretField(input.label)) {
    return null;
  }
  if (isReplayablePasswordField(hint) || isReplayablePasswordField(input.label)) {
    return buildDeterministicReplayPassword({
      run: {
        envId: input.envId,
        uniqueId: input.envId,
        seq: 0,
        index: 0,
        runSeed: hash32(`${input.envId}:password:${input.key}`),
      },
    });
  }
  const local = buildDeterministicLocalValue(
    hint,
    undefined,
    {
      run: {
        envId: input.envId,
        uniqueId: null,
        seq: 0,
        index: 0,
        runSeed: hash32(`${input.envId}:${input.key}`),
      },
    },
    input.persona ?? null,
  );
  if (local) return local;
  // 普通文本框：seed 派生短串，避免整表因模型不吐 JSON 挂掉
  const seed = hash32(`${input.envId}:${input.key}:generic`) >>> 0;
  return `test${seed.toString(36)}`;
}

function buildLocalOverridesForFields(
  fields: Array<{ key: string; label: string; currentValue: string }>,
  skipKeys: Set<string>,
  envId: string,
  persona: PersonaData | null,
): Record<string, string> {
  const valueOverrides: Record<string, string> = {};
  for (const field of fields) {
    if (skipKeys.has(field.key)) {
      const kept = field.currentValue.trim();
      if (kept) {
        valueOverrides[field.key] = field.currentValue;
        continue;
      }
      const local = localValueForSandboxField({
        envId,
        key: field.key,
        label: field.label,
        currentValue: field.currentValue,
        persona,
      });
      valueOverrides[field.key] = local ?? field.currentValue;
      continue;
    }
    valueOverrides[field.key] =
      localValueForSandboxField({
        envId,
        key: field.key,
        label: field.label,
        currentValue: field.currentValue,
        persona,
      }) ?? field.currentValue;
  }
  return valueOverrides;
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

  // 一次性码 / 卡号跳过 AI；注册密码可走模型或本地确定性密码（R2：不编造 OTP）
  const skipKeys = new Set<string>();
  for (const field of fields) {
    const hint = `${field.label} ${field.key}`;
    if (isOneTimeOrPaymentSecretField(hint) || isOneTimeOrPaymentSecretField(field.label)) {
      skipKeys.add(field.key);
    }
  }

  const workFields = fields.filter((field) => !skipKeys.has(field.key));
  if (workFields.length === 0) {
    const valueOverrides = buildLocalOverridesForFields(fields, skipKeys, envId, request.persona ?? null);
    return {
      envId,
      valueOverrides,
      summary: "敏感字段已跳过 AI 生成（OTP 保留原值；注册密码可用本地确定性值）",
    };
  }

  let route;
  let client;
  try {
    ({ route, client } = createModelRouter(aiSettings).forIntent(
      "fast_text",
      "沙盘字段造数：极速文本",
    ));
  } catch (error) {
    throw clarifyMockError(error);
  }

  const geo = request.geo ?? null;
  const persona = request.persona ?? null;
  const contextBlock = buildGeoPersonaContextBlock(geo, persona);
  const phoneHint = suggestPhoneHint(geo);
  const anyColloquial = workFields.some((field) => isColloquialField(field.label));

  const systemParts = [
    "你是天枢台沙盘的字段级造数引擎。为浏览器自动化测试生成真实、可用的表单值。",
    '必须输出纯 JSON：{ "values": { "<fieldKey>": "<value>" }, "summary": "中文短说明" }',
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

  const userContent = [
    `环境 ID：${envId}`,
    "请为下列字段生成最终值：",
    JSON.stringify(fieldSpecs, null, 2),
  ].join("\n");

  const baseMessages = [
    { role: "system" as const, content: systemParts.join("\n") },
    { role: "user" as const, content: userContent },
  ];

  type ChatCreateArgs = {
    model: string;
    temperature: number;
    max_tokens: number;
    messages: Array<{ role: "system" | "user"; content: string }>;
    response_format?: { type: "json_object" };
  };

  const createChat = async (body: ChatCreateArgs) => {
    const completion = await client.chat.completions.create(body as never);
    if (!completion || typeof completion !== "object" || !("choices" in completion)) {
      throw new Error("字段造数返回空内容");
    }
    return completion as { choices: Array<{ message?: { content?: string | null } }> };
  };

  const runOnce = async (forceJsonObject: boolean) => {
    const req: ChatCreateArgs = {
      model: route.model,
      temperature: anyColloquial ? 0.65 : 0.35,
      max_tokens: Math.min(2048, 80 + workFields.length * 60),
      messages: baseMessages,
    };
    if (forceJsonObject) {
      req.response_format = { type: "json_object" };
    }
    try {
      return await createChat(req);
    } catch (error) {
      if (forceJsonObject && isJsonFormatUnsupported(error)) {
        delete req.response_format;
        return await createChat(req);
      }
      throw clarifyMockError(error);
    }
  };

  let parsed: Record<string, unknown> | null = null;
  let usedLocalFallback = false;
  try {
    const response = await runOnce(true);
    const content = String(response.choices[0]?.message?.content ?? "").trim();
    if (!content) {
      throw new Error("字段造数返回空内容");
    }
    parsed = parseJsonObject(content);
  } catch (firstError) {
    const firstMsg = firstError instanceof Error ? firstError.message : String(firstError);
    // API Key / 鉴权失败不重试；仅 JSON 格式 / 空内容 / 解析失败再 nudge 一次
    if (/API Key|apiKey|unauthorized|401/i.test(firstMsg)) {
      throw clarifyMockError(firstError);
    }
    try {
      const response = await createChat({
        model: route.model,
        temperature: anyColloquial ? 0.65 : 0.35,
        max_tokens: Math.min(2048, 80 + workFields.length * 60),
        messages: [
          ...baseMessages,
          {
            role: "user",
            content:
              '只输出 JSON 对象，不要解释、不要 markdown 代码块。形状：{"values":{...},"summary":"..."}',
          },
        ],
      });
      const content = String(response.choices[0]?.message?.content ?? "").trim();
      if (!content) {
        throw new Error("字段造数返回空内容");
      }
      parsed = parseJsonObject(content);
    } catch {
      // 模型两次都不吐 JSON：本地确定性填表，禁止整表失败（与回放 JIT 空值兜底同口径）
      usedLocalFallback = true;
      parsed = null;
    }
  }

  if (usedLocalFallback || !parsed) {
    const valueOverrides = buildLocalOverridesForFields(fields, skipKeys, envId, persona);
    return {
      envId,
      valueOverrides,
      summary: `模型未返回可用 JSON，已用本地确定性值填充 ${workFields.length} 个字段（环境 #${envId}）`,
    };
  }

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
      const kept = field.currentValue.trim();
      if (kept) {
        valueOverrides[field.key] = field.currentValue;
        continue;
      }
      valueOverrides[field.key] =
        localValueForSandboxField({
          envId,
          key: field.key,
          label: field.label,
          persona,
        }) ?? field.currentValue;
      continue;
    }
    let next = "";
    if (Object.prototype.hasOwnProperty.call(valuesRaw, field.key)) {
      next = String(valuesRaw[field.key] ?? "")
        .trim()
        .replace(/^["'`]+|["'`]+$/g, "");
    }
    if (!next) {
      next =
        localValueForSandboxField({
          envId,
          key: field.key,
          label: field.label,
          persona,
        }) ?? "";
    }
    valueOverrides[field.key] = next;
  }

  const summary =
    String(parsed.summary ?? "").trim() ||
    `已为环境 #${envId} 生成 ${workFields.length} 个字段（模型 ${route.model}）`;

  return { envId, valueOverrides, summary };
}
