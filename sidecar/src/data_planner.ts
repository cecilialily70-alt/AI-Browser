/**
 * AI 多环境数据规划师 — 将文本/CSV 按自然语言规则切成各环境的 valueOverrides
 * 不改轨迹 JSON，仅产出 selector → 值 的覆盖表。
 */
import type { SidecarAiSettings } from "./engine.js";
import { createModelRouter } from "./ai_model_router.js";
import { stripFencedJson } from "./json_extract.js";
import { PLANNER_MAX_FILE_CHARS } from "./llm_budget.js";

export interface PlanBatchDataRequest {
  /** 从轨迹 JSON 中提取的所有需要 fill/select 的 selectors（原样字符串） */
  selectors: string[];
  /** 用户选中的多开环境 ID 列表 */
  envIds: string[];
  /** 用户的分配规则指令 */
  userPrompt: string;
  /** 用户上传文档的纯文本内容 */
  fileData?: string;
}

export interface PlanBatchEnvRow {
  envId: string;
  valueOverrides: Record<string, string>;
}

export interface PlanBatchDataResult {
  summary: string;
  planMatrix: PlanBatchEnvRow[];
}

const DATA_PLANNER_SYSTEM_PROMPT = [
  "你是一个专业的 RPA 数据分配规划师。你需要根据用户提供的文本数据、环境列表和表单字段(selectors)，按照用户的自然语言规则进行数据分配。",
  "必须强制输出纯 JSON 格式。包含 summary（规划说明，中文）和 planMatrix（数据矩阵数组）。",
  "planMatrix 的每个对象必须包含 envId 和 valueOverrides。",
  "valueOverrides 的 Key 必须是输入提供的 selectors 原样字符串，不得改写、缩写或翻译 selector。",
  "Value 是分配给该环境的实际要填入的值（字符串）。若某字段对该环境无数据，可用空字符串。",
  "planMatrix 必须覆盖输入中的每一个 envId，且不得发明未提供的 envId。",
  "若用户数据行数少于环境数，按规则复用或留空并在 summary 中说明；多于环境数时取前 N 行或按规则切片，并在 summary 说明。",
  "禁止输出 Markdown 代码围栏以外的解释文字；仅输出一个 JSON 对象。",
].join("\n");

const MAX_FILE_CHARS = PLANNER_MAX_FILE_CHARS;
const MAX_SELECTORS = 80;
const MAX_ENVS = 50;

function parsePlannerJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const candidate = stripFencedJson(trimmed);
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("规划师未返回 JSON 对象");
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("规划师 JSON 根节点必须是对象");
  }
  return parsed as Record<string, unknown>;
}

/** 用输入契约校正 LLM 输出，确保 envId / selector 集合正确 */
function normalizePlanBatchResult(
  raw: Record<string, unknown>,
  request: PlanBatchDataRequest,
): PlanBatchDataResult {
  const selectorSet = new Set(request.selectors);
  const summary = String(raw.summary ?? "").trim() || "已生成数据分配矩阵";
  const matrixRaw = Array.isArray(raw.planMatrix)
    ? raw.planMatrix
    : Array.isArray(raw.plan_matrix)
      ? raw.plan_matrix
      : [];

  const byEnv = new Map<string, Record<string, string>>();
  for (const entry of matrixRaw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const envId = String(row.envId ?? row.env_id ?? "").trim();
    if (!envId || !request.envIds.includes(envId)) {
      continue;
    }
    const overridesRaw =
      row.valueOverrides && typeof row.valueOverrides === "object" && !Array.isArray(row.valueOverrides)
        ? (row.valueOverrides as Record<string, unknown>)
        : row.value_overrides &&
            typeof row.value_overrides === "object" &&
            !Array.isArray(row.value_overrides)
          ? (row.value_overrides as Record<string, unknown>)
          : {};
    const valueOverrides: Record<string, string> = {};
    for (const selector of request.selectors) {
      if (Object.prototype.hasOwnProperty.call(overridesRaw, selector)) {
        const value = overridesRaw[selector];
        valueOverrides[selector] = value == null ? "" : String(value);
      } else {
        valueOverrides[selector] = "";
      }
    }
    // 丢弃非白名单 key
    for (const key of Object.keys(valueOverrides)) {
      if (!selectorSet.has(key)) {
        delete valueOverrides[key];
      }
    }
    byEnv.set(envId, valueOverrides);
  }

  const planMatrix: PlanBatchEnvRow[] = request.envIds.map((envId) => {
    const existing = byEnv.get(envId);
    if (existing) {
      return { envId, valueOverrides: existing };
    }
    const empty: Record<string, string> = {};
    for (const selector of request.selectors) {
      empty[selector] = "";
    }
    return { envId, valueOverrides: empty };
  });

  return { summary, planMatrix };
}

function validatePlanBatchRequest(request: PlanBatchDataRequest): PlanBatchDataRequest {
  const selectors = [...new Set(request.selectors.map((s) => String(s ?? "").trim()).filter(Boolean))];
  const envIds = [...new Set(request.envIds.map((s) => String(s ?? "").trim()).filter(Boolean))];
  const userPrompt = String(request.userPrompt ?? "").trim();
  let fileData = request.fileData != null ? String(request.fileData) : undefined;
  if (fileData && fileData.length > MAX_FILE_CHARS) {
    fileData = `${fileData.slice(0, MAX_FILE_CHARS)}\n…（已截断，请按规则使用前部数据）`;
  }

  if (selectors.length === 0) {
    throw new Error("selectors 为空：轨迹中没有 fill/select 字段可分配");
  }
  if (selectors.length > MAX_SELECTORS) {
    throw new Error(`selectors 过多（>${MAX_SELECTORS}），请精简轨迹填表步`);
  }
  if (envIds.length === 0) {
    throw new Error("envIds 为空：请至少选择一个运行中的环境");
  }
  if (envIds.length > MAX_ENVS) {
    throw new Error(`环境数过多（>${MAX_ENVS}）`);
  }
  if (!userPrompt && !(fileData && fileData.trim())) {
    throw new Error("请提供分配规则说明，或上传数据文件");
  }

  return {
    selectors: selectors.slice(0, MAX_SELECTORS),
    envIds: envIds.slice(0, MAX_ENVS),
    userPrompt: userPrompt || "请按数据文件行序依次分配给各环境；列与 selectors 顺序对齐。",
    fileData,
  };
}

function buildUserContent(request: PlanBatchDataRequest): string {
  return [
    "【环境 ID 列表 envIds】",
    JSON.stringify(request.envIds),
    "",
    "【表单字段 selectors（valueOverrides 的 Key 必须原样使用）】",
    JSON.stringify(request.selectors),
    "",
    "【用户分配规则】",
    request.userPrompt,
    "",
    "【上传数据文件纯文本】",
    request.fileData?.trim() ? request.fileData.trim() : "（未提供文件，请仅按规则与常识合理分配或留空）",
    "",
    "请输出 JSON：{ \"summary\": string, \"planMatrix\": [ { \"envId\": string, \"valueOverrides\": { [selector]: string } } ] }",
  ].join("\n");
}

/**
 * 调用 LLM 生成多环境数据矩阵
 */
export async function planBatchReplayData(
  request: PlanBatchDataRequest,
  aiSettings: SidecarAiSettings,
): Promise<PlanBatchDataResult> {
  const normalized = validatePlanBatchRequest(request);
  // 深度逻辑：多环境数据矩阵分配属复杂推理
  const { route, client } = createModelRouter(aiSettings).forIntent(
    "logic",
    "批量数据规划：深度逻辑模型",
  );
  const model = route.model;

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DATA_PLANNER_SYSTEM_PROMPT },
      { role: "user", content: buildUserContent(normalized) },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("数据规划师返回空内容");
  }

  const parsed = parsePlannerJsonObject(content);
  return normalizePlanBatchResult(parsed, normalized);
}
