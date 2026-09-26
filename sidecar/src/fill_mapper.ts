import type OpenAI from "openai";

import type { InteractiveElement } from "./interactive_elements.js";
import type { FillAction, FillActionKind, FillProfile } from "./engine.js";
import { compactJson, FILL_MAP_MAX_TOKENS } from "./llm_budget.js";
import { stripFencedJson } from "./json_extract.js";

const FILL_MAPPER_SYSTEM_PROMPT = [
  "你是网页表单字段映射专家。",
  "根据【结构化交互元素列表】与【填表 Profile JSON】，返回字段到选择器的映射表。",
  "必须 100% 使用中文 reasoning（仅内部思考，不要输出 reasoning 字段）。",
  "",
  "【输出格式 — 纯 JSON】",
  '{"mappings":[{"field":"Profile键名","selector":"CSS选择器或XPath","action":"fill|select|click|check","value":"填充值"}]}',
  "",
  "【强制规则】",
  "1. field 必须等于 Profile JSON 的【键名】，禁止把键值当作 field。",
  "2. selector 必须来自交互元素列表中的 selector 或 xpath（优先 selector）。",
  "3. 禁止编造列表中不存在的 selector。",
  "4. hidden / likelyDynamic 为 true 的元素禁止映射。",
  "5. select 标签用 action=select；checkbox/radio 用 click；文本输入用 fill。",
  "6. value 取自 Profile JSON 对应键的值。",
].join("\n");

interface MappingRow {
  field?: string;
  selector?: string;
  xpath?: string;
  action?: string;
  value?: string;
}

function normalizeAction(raw: string | undefined): FillActionKind {
  const action = String(raw ?? "fill").trim().toLowerCase();
  if (action === "select" || action === "click" || action === "check") {
    return action;
  }
  return "fill";
}

function selectorFromElement(element: InteractiveElement): string {
  const selector = element.selector?.trim();
  if (selector && !selector.startsWith("/")) {
    return selector;
  }
  const xpath = element.xpath?.trim();
  if (xpath) {
    return xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`;
  }
  return selector ?? "";
}

function buildAllowedSelectorSet(elements: InteractiveElement[]): Set<string> {
  const allowed = new Set<string>();
  for (const element of elements) {
    const selector = element.selector?.trim();
    const xpath = element.xpath?.trim();
    if (selector) {
      allowed.add(selector);
    }
    if (xpath) {
      allowed.add(xpath);
      allowed.add(xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`);
    }
  }
  return allowed;
}

function parseMappingsFromContent(content: string): MappingRow[] {
  const trimmed = content.trim();
  const candidate = stripFencedJson(trimmed);
  const parsed = JSON.parse(candidate) as { mappings?: MappingRow[] };
  if (!Array.isArray(parsed.mappings)) {
    throw new Error("LLM 返回缺少 mappings 数组");
  }
  return parsed.mappings;
}

export function heuristicMappings(profile: FillProfile, elements: InteractiveElement[]): FillAction[] {
  const profileKeys = Object.keys(profile);
  const actions: FillAction[] = [];

  for (const key of profileKeys) {
    const value = profile[key];
    const keyLower = key.toLowerCase();

    const matched =
      elements.find((element) => element.name?.toLowerCase() === keyLower) ??
      elements.find((element) => element.id?.toLowerCase() === keyLower) ??
      elements.find((element) => element.label?.toLowerCase().includes(keyLower));

    if (!matched) {
      continue;
    }

    const selector = selectorFromElement(matched);
    if (!selector) {
      continue;
    }

    let action: FillActionKind = "fill";
    if (matched.tagName === "select") {
      action = "select";
    } else if (matched.inputType === "checkbox" || matched.inputType === "radio") {
      action = "click";
    }

    actions.push({
      field: key,
      selector,
      xpath: matched.xpath,
      action,
      value,
    });
  }

  return actions;
}

/** Exact name/id match only — safe to skip LLM. */
function heuristicExactMappings(profile: FillProfile, elements: InteractiveElement[]): FillAction[] {
  const actions: FillAction[] = [];
  for (const key of Object.keys(profile)) {
    const keyLower = key.toLowerCase();
    const matched =
      elements.find((element) => element.name?.toLowerCase() === keyLower) ??
      elements.find((element) => element.id?.toLowerCase() === keyLower);
    if (!matched) {
      continue;
    }
    const selector = selectorFromElement(matched);
    if (!selector) {
      continue;
    }
    let action: FillActionKind = "fill";
    if (matched.tagName === "select") {
      action = "select";
    } else if (matched.inputType === "checkbox" || matched.inputType === "radio") {
      action = "click";
    }
    actions.push({
      field: key,
      selector,
      xpath: matched.xpath,
      action,
      value: profile[key],
    });
  }
  return actions;
}

export async function requestFillMappings(
  client: OpenAI,
  model: string,
  elements: InteractiveElement[],
  profile: FillProfile,
): Promise<FillAction[]> {
  const fillable = elements.filter((element) => !element.hidden && !element.likelyDynamic);
  const profileKeys = Object.keys(profile);
  const keyList = profileKeys.map((key) => `"${key}"`).join(", ");
  const allowedSelectors = buildAllowedSelectorSet(fillable);

  const compactElements = fillable.map((element) => {
    const row: Record<string, unknown> = {
      tagName: element.tagName,
      inputType: element.inputType,
      id: element.id,
      name: element.name,
      placeholder: element.placeholder,
      ariaLabel: element.ariaLabel,
      label: element.label,
      selector: element.selector,
    };
    if (!element.selector?.trim() && element.xpath) {
      row.xpath = element.xpath;
    }
    return row;
  });

  // 仅 name/id 精确全覆盖时跳过 LLM，避免 label includes 误匹配
  const exact = heuristicExactMappings(profile, fillable);
  if (exact.length === profileKeys.length && profileKeys.length > 0) {
    return exact;
  }

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: FILL_MAP_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: FILL_MAPPER_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "【Profile 键名 — field 只能从中选择】",
          compactJson(profileKeys),
          profileKeys.length > 0 ? `可选键名：[${keyList}]` : "",
          "",
          "【Profile JSON — 键值为填充内容】",
          compactJson(profile),
          "",
          "【结构化交互元素列表】",
          compactJson(compactElements),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("填表映射模型返回空内容");
  }

  let rows: MappingRow[] = [];
  try {
    rows = parseMappingsFromContent(content);
  } catch {
    rows = [];
  }

  const allowedKeys = new Set(profileKeys);
  const actions: FillAction[] = [];

  for (const row of rows) {
    const field = String(row.field ?? "").trim();
    const selectorRaw = String(row.selector ?? row.xpath ?? "").trim();
    if (!field || !allowedKeys.has(field)) {
      continue;
    }
    if (!selectorRaw) {
      continue;
    }

    const normalizedSelector = selectorRaw.startsWith("/")
      ? selectorRaw.startsWith("xpath=")
        ? selectorRaw
        : `xpath=${selectorRaw}`
      : selectorRaw;

    if (!allowedSelectors.has(selectorRaw) && !allowedSelectors.has(normalizedSelector)) {
      continue;
    }

    actions.push({
      field,
      selector: normalizedSelector,
      xpath: row.xpath ? String(row.xpath) : undefined,
      action: normalizeAction(row.action),
      value: row.value !== undefined ? String(row.value) : profile[field],
    });
  }

  if (actions.length === 0) {
    return heuristicMappings(profile, fillable);
  }

  return actions;
}
