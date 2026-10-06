/**
 * 天枢台 V2 · Milestone 2：三档动态模型路由分发器
 *
 * 意图枚举（上层 Agent 只声明 intent，不关心具体模型名）：
 * - fast_text  极速文本：侧边聊天 / 简单抽取 / 汇报分析 / 边缘造数
 * - logic      深度逻辑：Agent 调度 / 复杂填表推理 / 工具决策 / 规划重规划
 * - vision     视觉坐标：截图救赎 / SoM / DOM 无法解析的坐标任务
 *
 * 硬拦截铁律：
 * 1. 绝不编造未配置的模型名去请求
 * 2. 视觉任务未配置 vision 模型 → 抛出 "Visual model not configured"（禁止静默降级到纯文本）
 * 3. 候选模型必须落在「按任务选用」三档配置池内
 */
import type OpenAI from "openai";

import { createLlmClient } from "./ai_client.js";
import type { SidecarAiSettings } from "./engine.js";

/** 上层声明的意图（唯一推荐 API） */
export type ModelIntent = "fast_text" | "logic" | "vision";

/**
 * 兼容旧日志 / 设置字段角色名：
 * chat → fast_text · agent → logic · vision → vision
 */
export type AgentModelRole = "chat" | "agent" | "vision";

export interface AgentModelPool {
  /** 极速文本（可能为空 = 未配置） */
  chat: string;
  /** 深度逻辑（可能为空 = 未配置） */
  agent: string;
  /** 视觉坐标（可能为空 = 未配置） */
  vision: string;
}

export interface ModelRouteResult {
  intent: ModelIntent;
  /** 兼容旧字段：chat / agent / vision */
  role: AgentModelRole;
  model: string;
  reason: string;
}

const DELIVERABLE_RE =
  /告诉我|发给我|发送给我|回复我|给我|总结|简化|分析|第一条|前\s*\d+|结果|多少|几度|温度|回答|报告|提取|说一下|是什么/i;

const VISION_NOT_CONFIGURED = "Visual model not configured";
const LOGIC_NOT_CONFIGURED = "Logic model not configured";
const FAST_TEXT_NOT_CONFIGURED = "Fast text model not configured";
function trimModel(raw: unknown): string {
  return String(raw ?? "").trim();
}

/**
 * 仅从设置组装三档池。空字符串 = 未配置。
 * 严禁用 DEFAULT_* 常量填空（那是「编造模型名」）。
 */
export function buildAgentModelPool(settings: SidecarAiSettings): AgentModelPool {
  const agent = trimModel(settings.agentModel) || trimModel(settings.textModel);
  const chat = trimModel(settings.chatModel);
  const vision = trimModel(settings.visionModel);
  return { chat, agent, vision };
}

/** 池内是否已配置指定意图对应档位（视觉只看 vision 槽，不交叉） */
export function isIntentConfigured(pool: AgentModelPool, intent: ModelIntent): boolean {
  switch (intent) {
    case "vision":
      return Boolean(pool.vision);
    case "logic":
      return Boolean(pool.agent || pool.chat);
    case "fast_text":
      return Boolean(pool.chat || pool.agent);
  }
}

/**
 * 按意图硬解析模型。
 * - vision：未配置 → 抛 VISION_NOT_CONFIGURED（禁止降级文本）
 * - logic / fast_text：本档优先，允许交叉使用另一档**已配置**的文本模型；两档皆空才抛错
 */
export function resolveByIntent(
  pool: AgentModelPool,
  intent: ModelIntent,
  reason?: string,
): ModelRouteResult {
  if (intent === "vision") {
    if (!pool.vision) {
      throw new Error(VISION_NOT_CONFIGURED);
    }
    return {
      intent: "vision",
      role: "vision",
      model: pool.vision,
      reason: reason ?? "视觉坐标任务：使用已配置的视觉模型",
    };
  }

  if (intent === "logic") {
    const model = pool.agent || pool.chat;
    if (!model) {
      throw new Error(LOGIC_NOT_CONFIGURED);
    }
    return {
      intent: "logic",
      role: "agent",
      model,
      reason:
        reason ??
        (pool.agent
          ? "深度逻辑任务：使用已配置的 Agent 模型"
          : "深度逻辑任务：Agent 未配置，交叉使用已配置的极速文本模型"),
    };
  }

  // fast_text
  const model = pool.chat || pool.agent;
  if (!model) {
    throw new Error(FAST_TEXT_NOT_CONFIGURED);
  }
  return {
    intent: "fast_text",
    role: "chat",
    model,
    reason:
      reason ??
      (pool.chat
        ? "极速文本任务：使用已配置的对话模型"
        : "极速文本任务：对话未配置，交叉使用已配置的 Agent 模型"),
  };
}
/**
 * 按本轮态势自动选模（不引入池外模型）：
 * 1) 工具决策轮一律 logic（禁止 fast_text 空转「思考」）
 * 2) 显式开眼且同页已卡住 → vision
 * 3) 仅当 deliveryReady（PageReality.deliveryReady / expect 已真）→ 可用 fast_text 写交付文
 */
export function pickAgentTurnModel(
  pool: AgentModelPool,
  input: {
    hasScreenshot: boolean;
    goal: string;
    pageReadingInjected?: boolean;
    /** 同页卡住或工具主动请求开眼 */
    preferVisionRole?: boolean;
    /** 同页连续无进展次数；0=本页首轮 */
    samePageLoopCount?: number;
    /**
     * 交付子目标已由页面现实验收（SERP 查询对齐 + 有结果）。
     * 首页 / 查询不符 / 非 SERP 一律 false — 禁止 fast_text。
     */
    readyToDeliver?: boolean;
    /** 与 readyToDeliver 同义；Brain Kernel 优先读此字段 */
    deliveryReady?: boolean;
  },
): ModelRouteResult {
  const samePage = Math.max(0, Number(input.samePageLoopCount ?? 0) || 0);
  const deliveryReady = Boolean(input.deliveryReady ?? input.readyToDeliver);

  // 仅同页已卡住（≥1）且明确开眼时才用 vision
  if (input.preferVisionRole && input.hasScreenshot && samePage >= 1) {
    return resolveByIntent(
      pool,
      "vision",
      "截图救赎：同页已卡住且请求开眼，使用视觉坐标模型",
    );
  }

  // 交付文：仅 delivery_ready 已真时允许 fast_text；否则强制 logic 选工具
  if (
    deliveryReady &&
    input.pageReadingInjected &&
    DELIVERABLE_RE.test(String(input.goal ?? ""))
  ) {
    return resolveByIntent(
      pool,
      "fast_text",
      "delivery_ready 已验收：极速文本写交付文",
    );
  }

  // 硬规则：工具决策轮强制 logic（含新页首轮 / 首页搜索）
  return resolveByIntent(
    pool,
    "logic",
    samePage === 0
      ? "BrainKernel：深度逻辑选工具，禁止 fast_text/vision 空转"
      : "工具操作轮：深度逻辑模型",
  );
}
export function isVisualModelNotConfiguredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(VISION_NOT_CONFIGURED);
}

/**
 * 路由工厂：上层只需 `router.resolve('logic' | 'vision' | 'fast_text')`。
 * 负责模型选用、API Key 校验与 OpenAI 客户端创建。
 */
export class ModelRouter {
  readonly settings: SidecarAiSettings;
  readonly pool: AgentModelPool;

  constructor(settings: SidecarAiSettings) {
    this.settings = settings;
    this.pool = buildAgentModelPool(settings);
  }

  /** 按意图硬解析（未配置则抛错） */
  resolve(intent: ModelIntent, reason?: string): ModelRouteResult {
    return resolveByIntent(this.pool, intent, reason);
  }

  /** Agent 主循环自动选模 */
  pickTurn(input: Parameters<typeof pickAgentTurnModel>[1]): ModelRouteResult {
    return pickAgentTurnModel(this.pool, input);
  }

  /** 校验 API Key 后创建客户端（Key 缺失立即失败，不静默） */
  createClient(): OpenAI {
    return createLlmClient(this.settings);
  }

  /** 便捷：解析意图并返回 { route, client } */
  forIntent(intent: ModelIntent, reason?: string): {
    route: ModelRouteResult;
    client: OpenAI;
  } {
    const route = this.resolve(intent, reason);
    return { route, client: this.createClient() };
  }

  snapshot(): Record<string, unknown> {
    return {
      fast_text: this.pool.chat || null,
      logic: this.pool.agent || null,
      vision: this.pool.vision || null,
      configured: {
        fast_text: isIntentConfigured(this.pool, "fast_text"),
        logic: isIntentConfigured(this.pool, "logic"),
        vision: isIntentConfigured(this.pool, "vision"),
      },
    };
  }
}

/** 工厂入口：Agent / 填表 / 视觉 / 聊天统一由此创建 */
export function createModelRouter(settings: SidecarAiSettings): ModelRouter {
  return new ModelRouter(settings);
}

export {
  VISION_NOT_CONFIGURED,
  LOGIC_NOT_CONFIGURED,
  FAST_TEXT_NOT_CONFIGURED,
};
