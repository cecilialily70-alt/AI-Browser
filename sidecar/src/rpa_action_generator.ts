import { createModelRouter } from "./ai_model_router.js";
import { stripFencedJson } from "./json_extract.js";
import type { SidecarAiSettings } from "./engine.js";
import type { PageFormSchema } from "./dom_parser.js";
import type { JsonLogger } from "./json-logger.js";
import type { RpaAction } from "./rpa_engine.js";
import { schemaToRpaActions, buildFieldSelector } from "./rpa_schema.js";

function buildRpaActionSystemPrompt(allowedKeys: string[]): string {
  const keyList = allowedKeys.length > 0 ? allowedKeys.map((key) => `"${key}"`).join(", ") : "(无)";
  return [
    "你正在生成 Playwright RPA 动作数组。",
    '返回 JSON：{"actions":[{"step":1,"type":"fill|select|click|wait","selector":"CSS选择器","dataKey":"键名"}]}',
    "",
    "【dataKey 强制约束 — 最高优先级】",
    "数组中每个动作的 dataKey 必须绝对等于我提供的 JSON Profile 中的【键名】（例如 countryCode, email）。",
    "绝对禁止将 JSON Profile 中的【键值】（例如 'Hong Kong SAR, China'、'4242424242424242'）当作 dataKey 填入！",
    "部分恶劣网页会将 value 写在 name 属性里，你必须以 JSON Profile 的 Key 为准，忽略 DOM name/id 若它们与键值相同。",
    "",
    `dataKey 只能从以下键名中选择：[${keyList}]`,
    "若某 DOM 字段无法映射到任何键名，则跳过该字段，不要编造 dataKey。",
    "selector 必须原样使用我提供的 DOM 字段 selector，禁止臆造。",
    "type 规则：select 标签用 select；checkbox/radio 用 click；文本输入用 fill。",
  ].join("\n");
}

function parseLlmRpaActions(raw: string): RpaAction[] {
  const trimmed = raw.trim();
  const candidate = stripFencedJson(trimmed);
  const parsed = JSON.parse(candidate) as { actions?: unknown[] } | unknown[];

  const rows = Array.isArray(parsed) ? parsed : parsed.actions;
  if (!Array.isArray(rows)) {
    throw new Error("LLM RPA response missing actions array");
  }

  const actions: RpaAction[] = [];
  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = String(record.type ?? "").trim();
    const selector = String(record.selector ?? "").trim();
    const dataKey = record.dataKey ? String(record.dataKey).trim() : undefined;
    if (!selector || !["fill", "click", "select", "wait"].includes(type)) {
      continue;
    }
    actions.push({
      step: Number(record.step ?? actions.length + 1),
      type: type as RpaAction["type"],
      selector,
      dataKey,
      value: record.value ? String(record.value) : undefined,
    });
  }

  return actions.map((action, index) => ({
    ...action,
    step: index + 1,
  }));
}

function sanitizeDataKeys(actions: RpaAction[], profile: Record<string, string>): RpaAction[] {
  const allowedKeys = new Set(Object.keys(profile));
  const profileValues = new Set(Object.values(profile).map((value) => value.trim()).filter(Boolean));

  return actions
    .map((action) => {
      const dataKey = action.dataKey?.trim() ?? "";
      if (dataKey && allowedKeys.has(dataKey)) {
        return action;
      }
      if (dataKey && profileValues.has(dataKey)) {
        return { ...action, dataKey: undefined };
      }
      return action;
    })
    .filter((action) => {
      if (action.type === "wait") {
        return true;
      }
      return Boolean(action.dataKey && allowedKeys.has(action.dataKey));
    });
}

function buildFieldPayload(schema: PageFormSchema, baseActions: RpaAction[]) {
  return baseActions.map((action) => {
    const field = schema.fields.find(
      (candidate) => buildFieldSelector(candidate) === action.selector,
    );
    return {
      step: action.step,
      selector: action.selector,
      suggestedType: action.type,
      domName: field?.name ?? null,
      domId: field?.id ?? null,
      label: field?.label ?? null,
      tag: field?.tag ?? null,
      currentDataKey: action.dataKey ?? null,
    };
  });
}

export async function generateRpaActionsFromProfile(
  schema: PageFormSchema,
  profile: Record<string, string>,
  aiSettings: SidecarAiSettings,
  logger: JsonLogger,
): Promise<RpaAction[]> {
  const allowedKeys = Object.keys(profile);
  const baseActions = schemaToRpaActions(schema, 1, profile);

  if (allowedKeys.length === 0) {
    return baseActions;
  }

  if (baseActions.length === 0) {
    return baseActions;
  }

  // Heuristic coverage: each profile key already mapped → skip second LLM
  const covered = new Set(
    baseActions.map((action) => String(action.dataKey ?? "").trim()).filter(Boolean),
  );
  if (allowedKeys.every((key) => covered.has(key))) {
    logger.progress("rpa_action_heuristic_skip_llm", {
      profileKeyCount: allowedKeys.length,
      actionCount: baseActions.length,
    });
    return baseActions;
  }

  const { route, client } = createModelRouter(aiSettings).forIntent(
    "logic",
    "RPA 动作生成：深度逻辑模型",
  );
  const model = route.model;
  const fieldPayload = buildFieldPayload(schema, baseActions);

  logger.progress("rpa_action_llm_request", {
    model,
    fieldCount: fieldPayload.length,
    profileKeyCount: allowedKeys.length,
  });

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: buildRpaActionSystemPrompt(allowedKeys),
      },
      {
        role: "user",
        content: [
          "【JSON Profile 键名 — dataKey 只能从中选择】",
          JSON.stringify(allowedKeys),
          "",
          "【JSON Profile 完整数据 — 键值为填充内容，禁止作为 dataKey】",
          JSON.stringify(profile, null, 2),
          "",
          "【页面 DOM 字段与建议 selector — 请为每个字段分配正确的 dataKey】",
          JSON.stringify(fieldPayload, null, 2),
        ].join("\n"),
      },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("RPA action model returned empty content");
  }

  const llmActions = sanitizeDataKeys(parseLlmRpaActions(content), profile);
  if (llmActions.length === 0) {
    logger.warn("rpa_action_llm_empty", { fallback: "schema_to_rpa_actions" });
    return sanitizeDataKeys(baseActions, profile);
  }

  logger.progress("rpa_action_llm_ready", { actionCount: llmActions.length });
  return llmActions;
}

export function remapRpaActionDataKeys(
  actions: RpaAction[],
  profile: Record<string, string>,
): RpaAction[] {
  return sanitizeDataKeys(actions, profile);
}
