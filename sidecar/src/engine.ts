import type { Locator, Page } from "playwright-core";

import { createModelRouter } from "./ai_model_router.js";
import { heuristicMappings, requestFillMappings } from "./fill_mapper.js";
import {
  extractInteractiveElements,
  filterFillableElements,
  readInteractiveElementCache,
  snapshotInteractiveElements,
  type InteractiveElement,
} from "./interactive_elements.js";
import {
  selectOptionWithFallback,
} from "./fill_interactions.js";
import {
  pressEnterAfterFillIfEnabled,
  resolveLastFilledSelector,
} from "./fill_submit.js";
import { resolveGateway } from "./core/action_gateway.js";
import { JsonLogger } from "./json-logger.js";

const FILL_NO_RECORD = { record: false as const, skipSettle: true };

export type FillProfile = Record<string, string>;

export type FillActionKind = "fill" | "select" | "click" | "check";

/** 字段-选择器映射动作（优先 selector/xpath，兼容 legacy cloak_id） */
export interface FillAction {
  field: string;
  action: FillActionKind;
  value?: string;
  selector?: string;
  xpath?: string;
  /** @deprecated 视觉兜底仍可能使用 cloak_id */
  cloak_id?: string;
}

export interface FillEngineOptions {
  textModel?: string;
  visionModel?: string;
  actionTimeoutMs?: number;
  visionFailureThreshold?: number;
  apiKey?: string;
  baseURL?: string;
  /** profile userDataDir — 读取 launch 侧缓存的交互元素快照 */
  userDataDir?: string | null;
  /** 仅按 name/id/label 启发式映射，不调用 LLM（直接填表） */
  directMappingOnly?: boolean;
  /** 填表完成后自动按 Enter 提交 */
  pressEnterAfterFill?: boolean;
}

export interface SidecarAiSettings {
  apiKey: string;
  apiBaseUrl: string;
  /** @deprecated 兼容旧字段；等同 agentModel */
  textModel?: string;
  /** 对话任务模型（侧边聊天 / Agent 汇报分析） */
  chatModel?: string;
  /** Agent 工具操作模型 */
  agentModel?: string;
  /** 视觉开眼模型 */
  visionModel?: string;
  /**
   * 用户在「模型库」里给这个 Agent 模型标了「强制工具调用时禁用 thinking」。
   * 优先于按模型名正则猜测 —— 新模型 ID 猜不中会让强制工具轮直接 400。
   */
  agentModelDisableThinking?: boolean;
}

export interface ActionExecutionResult {
  action: FillAction;
  ok: boolean;
  error?: string;
}

export interface FillEngineResult {
  phase: "selector" | "vision" | "selector+vision";
  totalActions: number;
  succeeded: number;
  failed: number;
  selectorFailures: number;
  visionRetried: number;
  results: ActionExecutionResult[];
}

const DEFAULT_ACTION_TIMEOUT_MS = 1500;
const DEFAULT_VISION_FAILURE_THRESHOLD = 0.3;

function resolveLocator(page: Page, action: FillAction): Locator {
  const selector = action.selector?.trim();
  if (selector) {
    if (selector.startsWith("xpath=")) {
      return page.locator(selector).first();
    }
    if (selector.startsWith("/")) {
      return page.locator(`xpath=${selector}`).first();
    }
    return page.locator(selector).first();
  }

  const xpath = action.xpath?.trim();
  if (xpath) {
    const normalized = xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`;
    return page.locator(normalized).first();
  }

  const cloakId = action.cloak_id?.trim();
  if (cloakId) {
    return page.locator(`[data-cloak-id="${cloakId.replace(/"/g, '\\"')}"]`).first();
  }

  throw new Error(`动作 ${action.field} 缺少 selector/xpath`);
}

async function resolveInteractiveElements(
  page: Page,
  userDataDir?: string | null,
): Promise<InteractiveElement[]> {
  const cached = userDataDir ? await readInteractiveElementCache(userDataDir, page.url()) : null;
  if (cached?.elements?.length) {
    return cached.elements;
  }
  const snapshot = await snapshotInteractiveElements(page, userDataDir ?? undefined);
  return snapshot.elements;
}

async function executeAction(
  page: Page,
  action: FillAction,
  logger: JsonLogger,
  timeoutMs: number,
): Promise<ActionExecutionResult> {
  logger.fieldProgress(action.field, {
    stage: "before",
    selector: action.selector ?? action.xpath ?? action.cloak_id,
    action: action.action,
  });

  try {
    const locator = resolveLocator(page, action);
    await locator.waitFor({ state: "visible", timeout: timeoutMs });

    switch (action.action) {
      case "fill":
        await resolveGateway(page).fill(locator, action.value ?? "", {
          ...FILL_NO_RECORD,
          humanLike: true,
          timeoutMs,
          semanticLabel: action.field,
        });
        break;
      case "select":
        await selectOptionWithFallback(page, locator, action.value ?? "", timeoutMs);
        break;
      case "click":
        await resolveGateway(page).click(locator, {
          ...FILL_NO_RECORD,
          timeoutMs,
          semanticLabel: action.field,
        });
        break;
      case "check":
        await locator.check({ force: true, timeout: timeoutMs }).catch(async () => {
          await resolveGateway(page).click(locator, {
            ...FILL_NO_RECORD,
            timeoutMs,
            semanticLabel: action.field,
          });
        });
        break;
      default:
        throw new Error(`unsupported action: ${String(action.action)}`);
    }

    logger.fieldProgress(action.field, {
      stage: "after",
      selector: action.selector ?? action.xpath,
      ok: true,
    });
    return { action, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.fieldProgress(action.field, {
      stage: "after",
      selector: action.selector ?? action.xpath,
      ok: false,
      error: message,
    });
    return { action, ok: false, error: message };
  }
}

function shouldFallbackToVision(failures: number, total: number, threshold: number): boolean {
  if (failures <= 0 || total <= 0) {
    return false;
  }
  if (failures === total) {
    return true;
  }
  return failures / total >= threshold;
}

function resolveAiSettings(
  aiSettings: SidecarAiSettings,
  options: FillEngineOptions,
): SidecarAiSettings {
  // 不再用 DEFAULT_* 编造模型名；空档保持空，由 ModelRouter 硬拦截
  return {
    apiKey: aiSettings.apiKey,
    apiBaseUrl: aiSettings.apiBaseUrl,
    textModel: aiSettings.textModel ?? options.textModel,
    chatModel: aiSettings.chatModel,
    agentModel: aiSettings.agentModel ?? aiSettings.textModel ?? options.textModel,
    visionModel: aiSettings.visionModel ?? options.visionModel,
  };
}

export async function runFillEngine(
  page: Page,
  profile: FillProfile,
  logger: JsonLogger,
  aiSettings: SidecarAiSettings | null,
  options: FillEngineOptions = {},
): Promise<FillEngineResult> {
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const visionFailureThreshold =
    options.visionFailureThreshold ?? DEFAULT_VISION_FAILURE_THRESHOLD;

  logger.progress("fill_engine_start", {
    phase: options.directMappingOnly ? "heuristic" : "selector",
    directMappingOnly: Boolean(options.directMappingOnly),
  });

  const allElements = await resolveInteractiveElements(page, options.userDataDir);
  const fillableElements = filterFillableElements(allElements);
  logger.progress("interactive_elements_ready", {
    total: allElements.length,
    fillable: fillableElements.length,
    fromCache: Boolean(options.userDataDir),
  });

  const mappingElements = fillableElements.length > 0 ? fillableElements : allElements;
  let selectorActions: FillAction[];
  if (options.directMappingOnly) {
    selectorActions = heuristicMappings(profile, mappingElements);
    logger.progress("heuristic_mappings_ready", { actionCount: selectorActions.length });
  } else {
    if (!aiSettings) {
      throw new Error("填表映射需要配置 AI API Key，或使用「直接填表」走启发式映射");
    }
    const resolved = resolveAiSettings(aiSettings, options);
    // 极速文本：字段→选择器映射属于简单抽取
    const { route, client } = createModelRouter(resolved).forIntent(
      "fast_text",
      "填表字段映射：极速文本模型",
    );
    const textModel = route.model;
    selectorActions = await requestFillMappings(client, textModel, mappingElements, profile);
    logger.progress("selector_mappings_ready", {
      actionCount: selectorActions.length,
      intent: route.intent,
      model: textModel,
    });
  }

  const selectorResults: ActionExecutionResult[] = [];
  for (const action of selectorActions) {
    const result = await executeAction(page, action, logger, actionTimeoutMs);
    selectorResults.push(result);
    if (!result.ok) {
      logger.warn("fail_fast_action_error", {
        field: action.field,
        selector: action.selector ?? action.xpath,
        error: result.error,
      });
    }
  }

  const selectorFailures = selectorResults.filter((item) => !item.ok);
  let allResults = [...selectorResults];
  let visionRetried = 0;
  let phase: FillEngineResult["phase"] = "selector";

  // 视觉兜底：仅在 selector 映射大面积失败时启用（仍走 legacy 打标流程）
  if (shouldFallbackToVision(selectorFailures.length, selectorResults.length, visionFailureThreshold)) {
    phase = "vision";
    logger.progress("vision_fallback_skipped", {
      reason: "selector_based_fill_preferred",
      failed: selectorFailures.length,
      total: selectorResults.length,
    });
  }

  const succeeded = allResults.filter((item) => item.ok).length;
  const failed = allResults.length - succeeded;

  if (options.pressEnterAfterFill && succeeded > 0) {
    const lastSelector = resolveLastFilledSelector(
      selectorResults.filter((item) => item.ok).map((item) => item.action.selector ?? item.action.xpath),
    );
    await pressEnterAfterFillIfEnabled(page, logger, true, lastSelector);
  }

  const summary: FillEngineResult = {
    phase,
    totalActions: allResults.length,
    succeeded,
    failed,
    selectorFailures: selectorFailures.length,
    visionRetried,
    results: allResults,
  };

  logger.result("fill_engine_complete", summary as unknown as Record<string, unknown>);
  return summary;
}

/** 按预构建 selector 动作直接填表（元素提取导出 / 智能填表） */
export async function runFillEngineFromActions(
  page: Page,
  actions: FillAction[],
  logger: JsonLogger,
  options: { actionTimeoutMs?: number; pressEnterAfterFill?: boolean } = {},
): Promise<FillEngineResult> {
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const executable = actions.filter((action) => {
    if (action.action === "click") {
      return true;
    }
    return (action.value ?? "").trim().length > 0;
  });

  if (executable.length === 0) {
    throw new Error("没有可执行的填表动作（请检查字段值是否为空）");
  }

  logger.progress("fill_engine_actions_start", { actionCount: executable.length });

  const results: ActionExecutionResult[] = [];
  for (const action of executable) {
    const result = await executeAction(page, action, logger, actionTimeoutMs);
    results.push(result);
    if (!result.ok) {
      logger.warn("fill_action_error", {
        field: action.field,
        selector: action.selector ?? action.xpath,
        error: result.error,
      });
    }
  }

  const succeeded = results.filter((item) => item.ok).length;
  if (options.pressEnterAfterFill && succeeded > 0) {
    const lastSelector = resolveLastFilledSelector(
      results.filter((item) => item.ok).map((item) => item.action.selector ?? item.action.xpath),
    );
    await pressEnterAfterFillIfEnabled(page, logger, true, lastSelector);
  }

  const summary: FillEngineResult = {
    phase: "selector",
    totalActions: results.length,
    succeeded,
    failed: results.length - succeeded,
    selectorFailures: results.length - succeeded,
    visionRetried: 0,
    results,
  };

  logger.result("fill_engine_complete", summary as unknown as Record<string, unknown>);
  return summary;
}

/** 供 hybrid / chat 使用的精简表单结构 */
export async function loadFillSchemaElements(
  page: Page,
  userDataDir?: string | null,
): Promise<{ url: string; elements: InteractiveElement[] }> {
  const elements = await resolveInteractiveElements(page, userDataDir);
  return {
    url: page.url(),
    elements: filterFillableElements(elements),
  };
}

export { extractInteractiveElements, filterFillableElements, snapshotInteractiveElements };
