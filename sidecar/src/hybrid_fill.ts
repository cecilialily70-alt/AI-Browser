import type { Page } from "playwright-core";

import type { FillProfile, SidecarAiSettings } from "./engine.js";
import { loadFillSchemaElements } from "./engine.js";
import { createModelRouter } from "./ai_model_router.js";
import { parseJsonObjectFromText } from "./json_extract.js";
import { JsonLogger } from "./json-logger.js";
import { compactJson, FILL_MAP_MAX_TOKENS } from "./llm_budget.js";

const HYBRID_SYSTEM_PROMPT = [
  "你是一个高级表单数据生成器。",
  "请根据【结构化交互元素列表】，结合用户提供的【部分数据/指令】，生成完整的填表 JSON。",
  "用户未提供但表单必填的字段（如随机地址、姓名，或按指令撰写长文本），请你自行合理创造并补全。",
  "键名必须优先使用元素的 name 属性；若 name 为空则使用 id。",
  "必须排除 hidden 字段、likelyDynamic 为 true 的字段，以及 token/hash/signature/csrf 类动态字段。",
  "只允许返回一个纯 JSON 对象，键名为表单字段，键值为字符串填充内容。",
].join("\n");

export async function generateHybridFillProfile(
  page: Page,
  rawPartialInput: string,
  aiSettings: SidecarAiSettings,
  logger: JsonLogger,
  userDataDir?: string | null,
): Promise<FillProfile> {
  logger.progress("hybrid_fill_preprocessing", { status: "正在混合推演填表数据..." });

  const schema = await loadFillSchemaElements(page, userDataDir);
  if (schema.elements.length === 0) {
    throw new Error("当前页面未检测到可填写的交互元素");
  }

  const partialInput = rawPartialInput.trim();
  if (!partialInput) {
    throw new Error("原始填表数据为空，无法执行混合推演");
  }

  // 深度逻辑：混合推演需补全缺失字段，属复杂表单推理
  const { route, client } = createModelRouter(aiSettings).forIntent(
    "logic",
    "混合推演填表：深度逻辑模型",
  );
  const model = route.model;

  const compactElements = schema.elements.map((element) => {
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
    if (element.hidden) {
      row.hidden = true;
    }
    if (element.likelyDynamic) {
      row.likelyDynamic = true;
    }
    return row;
  });

  logger.progress("hybrid_fill_llm_request", {
    model,
    fieldCount: compactElements.length,
    partialInputLength: partialInput.length,
  });

  const response = await client.chat.completions.create({
    model,
    temperature: 0.3,
    max_tokens: FILL_MAP_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: HYBRID_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "【目标交互元素列表】",
          compactJson(compactElements),
          "",
          "【部分数据/指令】",
          partialInput,
        ].join("\n"),
      },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("混合推演模型返回空内容");
  }

  const profile = parseJsonObjectFromText(content);
  if (Object.keys(profile).length === 0) {
    throw new Error("混合推演结果为空对象");
  }

  logger.result("hybrid_fill_profile_ready", {
    keyCount: Object.keys(profile).length,
    keys: Object.keys(profile),
  });

  return profile;
}
