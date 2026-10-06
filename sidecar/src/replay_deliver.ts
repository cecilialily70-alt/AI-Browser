/**
 * 轨迹回放交付阶段 — 先进混合回放：
 * 脚本步确定性执行（零 Token）→ 结果因目标参数而变 / 需分析时再 LLM 介入。
 * 对齐 FlowReplay / Liberate Smart RPA：机械回放省 Token，不确定时才开 AI。
 */
import type { Page } from "playwright-core";
import type OpenAI from "openai";

import { createModelRouter } from "./ai_model_router.js";
import { extractAssistantContent } from "./ai_client.js";
import type { SidecarAiSettings } from "./engine.js";
import type { JsonLogger } from "./json-logger.js";
import {
  extractPageReading,
  formatPageReadingForLlm,
  type PageReadingResult,
} from "./page_read.js";

const DELIVER_CONFIRM_IDLE_MS = 3_000;
const DELIVER_CONFIRM_PAUSE_MS = 400;

const DELIVERABLE_GOAL_RE =
  /总结|简化|分析|提取|理解|解读|归纳|概括|提炼|告诉我|发给我|发送给我|回复我|报告|汇报|回答我/i;

/** @deprecated 保留别名：仅认知/交付类提示词才 AI 介入 */
export function goalRequiresDeliverable(goal: string): boolean {
  return DELIVERABLE_GOAL_RE.test(String(goal ?? ""));
}

/**
 * AI 回放介入：仅当目标提示词要求总结/分析/提取/简化/理解等认知交付。
 * 「仅搜索/打开」不触发 AI；下载属动作能力，不因「搜索」二字开 LLM。
 */
export function trajectoryNeedsAiDelivery(goal: string): boolean {
  const g = String(goal ?? "").trim();
  if (!g) {
    return false;
  }
  return goalRequiresDeliverable(g);
}

export function extractGoalQueryHint(goal: string): string | null {
  const raw = String(goal ?? "");
  const patterns = [
    /搜索\s*[「『"']?([^「『"'\s，。；]+)/,
    /查找\s*[「『"']?([^「『"'\s，。；]+)/,
    /搜一下\s*[「『"']?([^「『"'\s，。；]+)/,
    /查询\s*[「『"']?([^「『"'\s，。；]+)/,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]) {
      return m[1].trim();
    }
  }
  return null;
}

/** 从 SERP URL 提取实际查询词（沙盘改词后以页面为准，不以录制 goal 为准） */
export function extractPageQueryHint(pageUrl: string): string | null {
  const raw = String(pageUrl ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    for (const key of ["wd", "word", "q", "query", "keyword", "text", "search"]) {
      const value = url.searchParams.get(key);
      if (value && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    /* ignore invalid URL */
  }
  return null;
}

/**
 * 沙盘/overrides 改了填词后，录制 goal 仍可能写着旧词。
 * 用页面实际查询词替换 goal 中的旧词，避免 AI 交付误报「目标不符」。
 */
export function resolveEffectiveReplayGoal(goal: string, pageUrl: string): {
  effectiveGoal: string;
  queryHint: string | null;
  rewritten: boolean;
} {
  const trimmedGoal = String(goal ?? "").trim();
  const pageQuery = extractPageQueryHint(pageUrl);
  const goalQuery = extractGoalQueryHint(trimmedGoal);
  if (pageQuery && goalQuery && pageQuery !== goalQuery && trimmedGoal.includes(goalQuery)) {
    return {
      effectiveGoal: trimmedGoal.split(goalQuery).join(pageQuery),
      queryHint: pageQuery,
      rewritten: true,
    };
  }
  return {
    effectiveGoal: trimmedGoal,
    queryHint: pageQuery || goalQuery,
    rewritten: false,
  };
}

export function assessReadingUncertainty(
  goal: string,
  reading: PageReadingResult,
  queryHint?: string | null,
): { uncertain: boolean; reason: string } {
  const text = String(reading.visibleText ?? "").trim();
  const organic = reading.organic?.length ?? 0;
  const query = queryHint === undefined ? extractGoalQueryHint(goal) : queryHint;

  if (!text && organic === 0 && !reading.featured && !reading.recommendedFirst) {
    return { uncertain: true, reason: "页面几乎无可见正文/结果" };
  }
  if (/function\s*\(|userAgent|webkit|检测浏览器|请开启JavaScript|Access Denied|验证码/i.test(text)) {
    return { uncertain: true, reason: "页面疑似未正常渲染（脚本/风控/验证码痕迹）" };
  }
  if (query && text && !text.includes(query) && organic === 0) {
    return { uncertain: true, reason: `页面未见目标词「${query}」，结果可能错页或不完整` };
  }
  if (query && organic === 0 && !reading.featured) {
    return { uncertain: true, reason: "检索类目标但未抽到结构化结果" };
  }
  return { uncertain: false, reason: "" };
}

export interface ReplayDeliverResult {
  delivered: boolean;
  summary: string;
  intervened: boolean;
  reason: string;
}

/**
 * 机械回放成功后：按规则决定是否 AI 读页交付（答案随目标参数变化）。
 */
export async function deliverAfterTrajectoryReplay(
  page: Page,
  goal: string,
  aiSettings: SidecarAiSettings | null | undefined,
  logger: JsonLogger,
  signal?: AbortSignal,
  /**
   * 用户「规则」的交付上下文（回放目标里 `@规则名` 引用而来）。
   * 只影响交付提示词，不参与「是否需要 AI 交付」的判定（避免规则文案误触发交付）。
   */
  extraContext?: string,
): Promise<ReplayDeliverResult> {
  const trimmedGoal = String(goal ?? "").trim();
  if (!trimmedGoal) {
    return { delivered: false, summary: "", intervened: false, reason: "无目标" };
  }

  const wantByGoal = trajectoryNeedsAiDelivery(trimmedGoal);
  if (!wantByGoal) {
    return {
      delivered: false,
      summary: "",
      intervened: false,
      reason: "目标无分析/检索交付需求，跳过 AI",
    };
  }

  if (!aiSettings?.apiKey?.trim()) {
    logger.warn("replay_deliver_skip_no_ai", { reason: "缺少 AI 配置，无法交付分析" });
    return {
      delivered: false,
      summary: "机械回放已完成，但缺少 AI 配置，无法生成分析结果。",
      intervened: true,
      reason: "需 AI 但无密钥",
    };
  }
  if (signal?.aborted) {
    throw new Error("回放已手动停止");
  }

  // 极速文本：回放交付属于汇报分析，不走深度逻辑/视觉
  const { route, client } = createModelRouter(aiSettings).forIntent(
    "fast_text",
    "混合回放交付：极速文本模型",
  );
  const model = route.model;

  logger.agentState("running", {
    engine: "trajectory_replay",
    step: 0,
    msg: `思考中… · ${model}（混合回放 · AI 读页分析）`,
  });

  // 回放结束已做完整沉淀；此处仅轻量确认，避免残影尚未挂上时抽到骨架
  await page
    .waitForLoadState("networkidle", { timeout: DELIVER_CONFIRM_IDLE_MS })
    .catch(() => undefined);
  if (signal?.aborted) {
    throw new Error("回放已手动停止");
  }
  await new Promise((resolve) => setTimeout(resolve, DELIVER_CONFIRM_PAUSE_MS));
  if (signal?.aborted) {
    throw new Error("回放已手动停止");
  }

  const pageUrl = page.url();
  const { effectiveGoal, queryHint, rewritten } = resolveEffectiveReplayGoal(trimmedGoal, pageUrl);
  const reading = await extractPageReading(page);
  const uncertainty = assessReadingUncertainty(effectiveGoal, reading, queryHint);
  const pageBlock = formatPageReadingForLlm(reading);

  logger.progress("replay_deliver_intervene", {
    model,
    intent: route.intent,
    role: route.role,
    uncertain: uncertainty.uncertain,
    uncertainReason: uncertainty.reason || undefined,
    queryHint: queryHint || undefined,
    goalRewritten: rewritten || undefined,
    readingKind: reading.kind,
  });

  logger.agentState("running", {
    engine: "trajectory_replay",
    step: 0,
    msg: uncertainty.uncertain
      ? `AI 介入中… · ${model}（不确定：${uncertainty.reason}）`
      : `AI 分析中… · ${model}`,
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你是网页任务交付助手。用户用「轨迹记忆」机械回放打开了页面；沙盘可改查询词（如刘亦菲→张学友），【本次查询词】与页面 URL 为准。" +
        "请只根据【页面阅读】完成【用户目标】中的分析/汇报，用中文直接给出完整答案。" +
        "不要用录制时的旧词去否定页面上已按沙盘改过的新词；仅当页面异常、空白或未渲染时才说明不确定点。" +
        "禁止要求用户再操作浏览器；不要输出工具调用。",
    },
    {
      role: "user",
      content: [
        `【用户目标】${effectiveGoal}`,
        queryHint ? `【本次查询词】${queryHint}` : "",
        extraContext?.trim() ? `【用户规则】\n${extraContext.trim()}` : "",
        `【当前 URL】${pageUrl}`,
        uncertainty.uncertain ? `【不确定标记】${uncertainty.reason}` : "",
        pageBlock,
        "请直接输出最终答案（可分段），不要前言套话。",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.2,
    max_tokens: 2048,
  });

  if (signal?.aborted) {
    throw new Error("回放已手动停止");
  }

  const summary = extractAssistantContent(response).trim();
  if (!summary) {
    return {
      delivered: false,
      summary: "机械回放已完成，但模型未返回分析内容。",
      intervened: true,
      reason: uncertainty.reason || "交付",
    };
  }

  logger.progress("replay_deliver_done", {
    goalChars: trimmedGoal.length,
    summaryChars: summary.length,
    kind: reading.kind,
    model,
    uncertain: uncertainty.uncertain,
  });

  return {
    delivered: true,
    summary,
    intervened: true,
    reason: uncertainty.uncertain ? uncertainty.reason : "目标需要 AI 交付",
  };
}
