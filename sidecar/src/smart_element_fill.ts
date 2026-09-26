import type { Page } from "playwright-core";

import type { FillProfile, SidecarAiSettings } from "./engine.js";
import { createModelRouter } from "./ai_model_router.js";
import {
  applyProfileToExport,
  buildFillReadyExportJson,
  type FillReadyExport,
} from "./fill_export.js";
import { mergeProfileIntoFillActions } from "./fill_action_builder.js";
import { parseJsonObjectFromText } from "./json_extract.js";
import type { JsonLogger } from "./json-logger.js";
import {
  readInteractiveElementCache,
  snapshotInteractiveElements,
} from "./interactive_elements.js";

const SMART_FILL_SYSTEM_PROMPT = [
  "你是天枢台表单填表助手。",
  "根据【页面字段列表】和【用户自然语言】，提取并补全各字段的填表值。",
  "",
  "【强制规则】",
  "1. 返回纯 JSON 对象，键名必须且只能来自字段列表中的 key。",
  "2. 禁止新增列表外的键；无法从用户描述推断的字段 value 设为 \"\"。",
  "3. 信用卡、地址、姓名、电话、邮箱等按用户原文或合理格式填写。",
  "4. 用户描述是部分信息时，只填能确定的字段，其余留空。",
].join("\n");

export interface SmartElementFillResult {
  exportPayload: FillReadyExport;
  fillProfile: FillProfile;
  filledFieldCount: number;
  actionCount: number;
}

async function loadFillReadyExport(
  page: Page,
  userDataDir: string | null,
  logger: JsonLogger,
): Promise<FillReadyExport> {
  const currentUrl = page.url();
  const cached = userDataDir ? await readInteractiveElementCache(userDataDir, currentUrl) : null;
  if (cached) {
    logger.progress("smart_fill_cache_hit", { url: currentUrl });
    return buildFillReadyExportJson(cached);
  }

  logger.progress("smart_fill_snapshot", { url: currentUrl });
  const snapshot = await snapshotInteractiveElements(page, userDataDir ?? undefined);
  return buildFillReadyExportJson(snapshot);
}

function buildFieldPromptRows(exportPayload: FillReadyExport) {
  if (exportPayload.elements?.length) {
    return exportPayload.elements
      .filter((row) => row.category === "fillable")
      .map((row) => ({
        key: row.key,
        label: row.label,
        tag: row.tag,
        type: row.type,
        selector: row.selector,
      }));
  }

  return exportPayload.fillActions
    .filter((action) => action.action === "fill" || action.action === "select")
    .map((action) => ({
      key: action.field,
      label: action.field,
      tag: "",
      type: action.action,
      selector: action.selector,
    }));
}

export async function generateProfileFromNaturalLanguage(
  exportPayload: FillReadyExport,
  naturalLanguage: string,
  aiSettings: SidecarAiSettings,
  logger: JsonLogger,
  seedProfile: FillProfile = {},
): Promise<FillProfile> {
  const trimmed = naturalLanguage.trim();
  if (!trimmed) {
    throw new Error("请提供自然语言填表信息（例如在上方输入框描述卡号、地址等）");
  }

  const fieldRows = buildFieldPromptRows(exportPayload);
  if (fieldRows.length === 0) {
    throw new Error("当前页面没有可填写的字段：请确认页面已加载完成，或刷新后再试");
  }

  const allowedKeys = fieldRows.map((row) => row.key);
  // 深度逻辑：智能填表字段映射属复杂推理
  const { route, client } = createModelRouter(aiSettings).forIntent(
    "logic",
    "智能填表映射：深度逻辑模型",
  );
  const model = route.model;

  logger.progress("smart_fill_llm_request", {
    model,
    fieldCount: fieldRows.length,
    textLength: trimmed.length,
  });

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SMART_FILL_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "【允许的字段 key】",
          JSON.stringify(allowedKeys),
          "",
          "【字段详情】",
          JSON.stringify(fieldRows, null, 2),
          "",
          "【已有填表数据（可覆盖/补全）】",
          JSON.stringify(seedProfile, null, 2),
          "",
          "【用户自然语言】",
          trimmed,
        ].join("\n"),
      },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("智能填表模型返回空内容");
  }

  const generated = parseJsonObjectFromText(content);
  const merged: FillProfile = { ...exportPayload.fillProfile, ...seedProfile };
  for (const key of allowedKeys) {
    if (generated[key] !== undefined && generated[key] !== null) {
      merged[key] = String(generated[key]);
    }
  }

  logger.result("smart_fill_profile_ready", {
    keys: Object.keys(merged).filter((key) => merged[key]?.trim()),
    totalKeys: allowedKeys.length,
  });

  return merged;
}

export async function prepareSmartElementFill(
  page: Page,
  naturalLanguage: string,
  aiSettings: SidecarAiSettings,
  logger: JsonLogger,
  options?: {
    userDataDir?: string | null;
    seedProfile?: FillProfile;
  },
): Promise<SmartElementFillResult> {
  const exportPayload = await loadFillReadyExport(page, options?.userDataDir ?? null, logger);
  const seedProfile = options?.seedProfile ?? {};
  const fillProfile = await generateProfileFromNaturalLanguage(
    exportPayload,
    naturalLanguage,
    aiSettings,
    logger,
    seedProfile,
  );

  const mergedExport = applyProfileToExport(exportPayload, fillProfile);
  const actions = mergeProfileIntoFillActions(mergedExport.fillActions, fillProfile).filter(
    (action) => (action.value ?? "").trim().length > 0,
  );

  if (actions.length === 0) {
    throw new Error("未能从自然语言中匹配到任何可填字段，请补充更具体的字段信息");
  }

  return {
    exportPayload: mergedExport,
    fillProfile,
    filledFieldCount: Object.values(fillProfile).filter((value) => value.trim()).length,
    actionCount: actions.length,
  };
}
