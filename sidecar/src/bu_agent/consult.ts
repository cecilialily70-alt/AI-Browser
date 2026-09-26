/**
 * Consult 问答总线（Phase 2 基建 · **通用基建层**）
 *
 * 定位：给"需要判断"的地方提供**一条受控的、可审计的、预算内的** LLM 咨询通道。
 * 它不知道任何一条路由的语义（那是 consult_routes.ts 的事），只负责把一次咨询
 * 可靠地送出去、把答案按契约收回来、并把成本与失败都留下痕迹。
 *
 * 三条设计底线：
 *
 * 1. **成本有硬上限**。一次 `askJson` 最多发出 `spec.maxRounds` 次 LLM 请求
 *    （含纠正轮）。降级试错**不额外消耗**额度，因此"最坏情况"是确定的，不会被
 *    供应商能力探测放大成成本黑洞。
 *
 * 2. **失败方向永远倒向安全侧**。缓存上下文不全 → 不缓存（宁可多花一次钱）；
 *    限流/超时不改能力档位（误降级会让后续所有调用悄悄退到最弱档）；
 *    上下文缺失时不做"猜测式"补全。
 *
 * 3. **绝不因咨询失败打死任务**。超时/中止归一为 `ConsultUnavailableError`；
 *    契约始终对不上归一为 `ConsultSchemaError`。调用方必须据此降级，
 *    而不是把整个 Agent 循环拖崩。`tryAskJson` 是空安全包装（返回 null）。
 *
 * P5.5：仅 `plan_conflict` 经 `consult_escalate.ts` 接入 Arbiter escalate。
 * 失败由该适配器回落 HITL。其它路由仍不得被主循环直接调用
 * （`consult-bus.mjs` 看守：主循环不得直接 import 本模块）。
 */
import { createHash } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import {
  beginAgentLlmWait,
  createLlmClient,
  extractAssistantContent,
  isLlmAbortOrTimeoutError,
} from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import {
  CONSULT_ROUTE_SPECS,
  buildResultJsonSchema,
  type ConsultInputMap,
  type ConsultResultMap,
  type ConsultRoute,
  type ConsultValidation,
} from "./consult_contract.js";
import { extractJsonObject } from "./prompts.js";

/** 只需要一个 progress 出口，避免把整个 JsonLogger 契约搬进基建层（也让测试能注入假 logger） */
export interface ConsultLogger {
  agentProgress?: (message: string, data?: Record<string, unknown>) => void;
}

/* ───────────────────────── 错误分类 ───────────────────────── */

/** 咨询不可用（超时/中止/预算耗尽）：调用方应降级到本地兜底，而不是重试 */
export class ConsultUnavailableError extends Error {
  readonly route: ConsultRoute;
  readonly reason: string;
  constructor(route: ConsultRoute, reason: string) {
    super(`咨询不可用[${route}]：${reason}`);
    this.name = "ConsultUnavailableError";
    this.route = route;
    this.reason = reason;
  }
}

/** 契约始终对不上：这是真 bug 或模型能力不足，必须让调用方知道（而不是静默返回空） */
export class ConsultSchemaError extends Error {
  readonly route: ConsultRoute;
  readonly errors: string[];
  readonly lastRaw: string;
  constructor(route: ConsultRoute, errors: string[], lastRaw: string) {
    super(`咨询契约校验失败[${route}]：${errors.slice(0, 4).join("；")}`);
    this.name = "ConsultSchemaError";
    this.route = route;
    this.errors = errors;
    this.lastRaw = lastRaw;
  }
}

/* ───────────────────────── 传输层（可注入，测试零网络） ───────────────────────── */

export interface ConsultTransportRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  /** null = 不带 response_format（第 3 档纯文本） */
  responseFormat: Record<string, unknown> | null;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ConsultTransport {
  /** 返回 assistant 的原始文本内容；抛错表示本次请求失败 */
  complete(request: ConsultTransportRequest): Promise<string>;
}

function createDefaultTransport(settings: SidecarAiSettings): ConsultTransport {
  return {
    async complete(request) {
      const client = createLlmClient(settings);
      const completion = await client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages,
          temperature: 0,
          max_tokens: request.maxTokens,
          ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
        } as never,
        request.signal ? { signal: request.signal } : undefined,
      );
      return extractAssistantContent(completion);
    },
  };
}

/* ───────────────────────── 三级降级 ───────────────────────── */

/**
 * 传输档位。供应商对三层能力支持不一（现有 Provider 矩阵不保证 strict json_schema），
 * 所以不能硬依赖任何一层。
 */
export type ConsultWireMode = "json_schema" | "json_object" | "plain_text";

const TIER_ORDER: readonly ConsultWireMode[] = ["json_schema", "json_object", "plain_text"];

/**
 * 能力负缓存：`baseURL|model` → 已知可达的最高档。
 * 意义：一旦探明某供应商不支持 strict，后续调用**直接从 json_object 起步**，
 * 不再每次都先撞一次 400 再降级（省一次请求 + 一段延迟）。
 */
const wireSupport = new Map<string, ConsultWireMode>();

function capabilityId(settings: SidecarAiSettings, model: string): string {
  return `${settings.apiBaseUrl.trim() || "(default)"}|${model}`;
}

function rememberWireSupport(id: string, mode: ConsultWireMode): void {
  wireSupport.set(id, mode);
}

/** 测试用：清空能力负缓存 */
export function resetWireSupportCache(): void {
  wireSupport.clear();
}

function demote(mode: ConsultWireMode): ConsultWireMode {
  const index = TIER_ORDER.indexOf(mode);
  return TIER_ORDER[Math.min(index + 1, TIER_ORDER.length - 1)]!;
}

/**
 * 关键判定：这个错是"供应商不支持该传输能力"吗？
 *
 * 必须把**限流/鉴权/网络/超时**排除在外 —— 它们也会伪装成 400 家族，
 * 但如果据此降级，后续所有调用会被永久打落到最弱档（静默的质量与成本双重劣化）。
 */
export function isUnsupportedFeatureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message) return false;
  if (/timeout|timedout|abort|econnreset|econnrefused|network|rate.?limit|429|401|403|insufficient|quota|balance/i.test(message)) {
    return false;
  }
  return /response_format|json_schema|json[_ ]?object|unsupported|not support|does not support|invalid.?request|strict/i.test(
    message,
  );
}

/* ───────────────────────── 缓存 ───────────────────────── */

export interface ConsultStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  readonly size: number;
}

/** 有界内存缓存（超限淘汰最早写入项），避免长驻 sidecar 里无限增长 */
export function createConsultStore(maxEntries = 200): ConsultStore {
  const map = new Map<string, unknown>();
  const limit = Math.max(1, Math.floor(maxEntries));
  return {
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      if (map.size >= limit) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
      map.set(key, value);
    },
    get size() {
      return map.size;
    },
  };
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 20);
}

function normalizeText(text: string): string {
  return String(text).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeUrl(raw: string, mode: "path" | "full"): string {
  try {
    const url = new URL(String(raw));
    return mode === "full" ? `${url.origin}${url.pathname}${url.search}` : url.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return normalizeText(raw);
  }
}

/**
 * 单个输入字段的规范化：
 *  - `url`：默认只取 path（查询串里多为跟踪参数，纳入键会让缓存永远打不中）；
 *  - 数组：**排序**后拼接（DOM 顺序抖动不该击穿缓存；多重集语义保留重复项）；
 *  - 对象数组：按规范化 JSON 排序（同上）；
 *  - 字符串：去空白 + 统一大小写（模型/页面给的同一事实不该因排版差异变成两个键）。
 */
function canonicalizeValue(key: string, value: unknown, urlMode: "path" | "full"): string {
  if (value === null || value === undefined) return "";
  if (key === "url" && typeof value === "string") return normalizeUrl(value, urlMode);
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) =>
      typeof item === "string"
        ? normalizeText(item)
        : JSON.stringify(item, Object.keys(item as object).sort()),
    );
    return parts.slice().sort().join("␟");
  }
  return JSON.stringify(value);
}

/**
 * 缓存键：`route ⊕ 规范化后的全部输入`。
 *
 * 与"只挑几个字段做键"相比，这里**默认把每个输入字段都算进键**（安全默认），
 * 从而不可能出现"答案依赖某个输入、但那个输入没进键"这种静默错答。
 * 少数字段确实与答案无关时，才用 route spec 的 `cacheIgnores` 显式排除（可评审的取舍）。
 */
export function consultCacheKey<R extends ConsultRoute>(
  route: R,
  input: ConsultInputMap[R],
  ignores: readonly string[] = [],
): string {
  const spec = CONSULT_ROUTE_SPECS[route] as { cacheUrl?: "path" | "full" };
  const urlMode = spec.cacheUrl ?? "path";
  const skip = new Set(ignores);
  const parts = Object.keys(input as Record<string, unknown>)
    .sort()
    .filter((key) => !skip.has(key))
    .map((key) => `${key}=${canonicalizeValue(key, (input as Record<string, unknown>)[key], urlMode)}`);
  return sha1(`${route}\u0000${parts.join("\u0001")}`);
}

/* ───────────────────────── 预算 ───────────────────────── */

export interface ConsultBudget {
  left: number;
}

/** 每个任务建一份（Phase 3 由 service 创建）；耗尽后咨询一律拒发 */
export function createConsultBudget(maxCalls: number): ConsultBudget {
  return { left: Math.max(0, Math.floor(maxCalls)) };
}

/* ───────────────────────── 调用上下文 ───────────────────────── */

export interface ConsultCallContext {
  aiSettings: SidecarAiSettings;
  logger: ConsultLogger;
  signal?: AbortSignal;
  budget?: ConsultBudget;
  /**
   * 缓存容器。**不传就不缓存** —— 刻意不给模块级默认缓存：
   * 跨任务共享一个缓存会让"上一个任务的答案"泄漏到下一个任务，
   * 而缓存方向上的错答是危险的（比多花一次钱严重得多）。
   */
  store?: ConsultStore;
  /** 注入点：测试传假传输，零网络 */
  transport?: ConsultTransport;
}

/* ───────────────────────── 纯文本解析与修复 ───────────────────────── */

/** 从第一个 `{` 起按括号深度找配对的 `}`（跳过字符串内的括号） */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 第 3 档（纯文本）的解析 + 本地修复。
 *
 * 比主循环的 `extractJsonObject` 更耐"前后夹废话"：后者用 `lastIndexOf('}')`，
 * 一旦模型在 JSON 之后又写了带 `}` 的解释就会截错。这里按括号深度配对，先自己解析；
 * 失败再退回 `extractJsonObject`（复用既有实现，穷尽围栏/前后缀场景）。
 */
export function parseConsultContent(raw: string): unknown {
  const text = String(raw ?? "");
  if (!text.trim()) throw new Error("模型输出为空");
  const balanced = extractBalancedObject(text);
  if (balanced) {
    try {
      return JSON.parse(balanced) as unknown;
    } catch {
      /* 落到通用兜底 */
    }
  }
  return extractJsonObject(text);
}

/* ───────────────────────── 审计 ───────────────────────── */

/** 审计里的"档位"：真实传输档位，或未发生请求时的 cache / none（不要把没发出去的请求标成某一档） */
type AuditTier = ConsultWireMode | "cache" | "none";

interface AuditRecord {
  route: ConsultRoute;
  tier: AuditTier;
  cached: boolean;
  rounds: number;
  model: string;
  ms: number;
  ok: boolean;
  errors: string[];
}

function audit(ctx: ConsultCallContext, record: AuditRecord): void {
  const detail = record.ok
    ? record.cached
      ? "缓存命中"
      : `第 ${record.rounds} 轮、${record.tier} 档通过`
    : `失败（${record.errors.slice(0, 2).join("；") || "无细节"}）`;
  try {
    ctx.logger.agentProgress?.(`咨询[${record.route}] ${record.ok ? "完成" : "未通过"} · ${detail}`, {
      phase: "consult",
      route: record.route,
      tier: record.tier,
      cached: record.cached,
      rounds: record.rounds,
      model: record.model,
      ms: record.ms,
      ok: record.ok,
      errorCount: record.errors.length,
    });
  } catch {
    /* 审计失败绝不影响主流程 */
  }
}

/* ───────────────────────── 主入口 ───────────────────────── */

function buildResponseFormat(
  route: ConsultRoute,
  tier: ConsultWireMode,
): Record<string, unknown> | null {
  if (tier === "plain_text") return null;
  if (tier === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: { name: `consult_${route}`, strict: true, schema: buildResultJsonSchema(route) },
  };
}

function describeError(error: unknown): string {
  if (isLlmAbortOrTimeoutError(error)) {
    return `调用超时或被中止：${error instanceof Error ? error.message : String(error)}`;
  }
  return error instanceof Error ? error.message : String(error ?? "未知错误");
}

/**
 * 咨询一次。成功返回**已通过契约校验**的强类型结果。
 *
 * 失败语义（都抛错，由调用方决定降级策略）：
 *  - `ConsultUnavailableError`：预算耗尽 / 用户中止；
 *  - `ConsultSchemaError`：全部档位与轮次都没能得到合法契约。
 */
export async function askJson<R extends ConsultRoute>(
  route: R,
  input: ConsultInputMap[R],
  ctx: ConsultCallContext,
): Promise<ConsultResultMap[R]> {
  const spec = CONSULT_ROUTE_SPECS[route];
  const started = Date.now();
  const errors: string[] = [];
  const finish = (record: Omit<AuditRecord, "route" | "ms">): void => {
    audit(ctx, { route, ms: Date.now() - started, ...record });
  };

  const router = createModelRouter(ctx.aiSettings);
  const resolved = router.resolve(spec.modelIntent);
  const model = resolved.model;

  // ——— 缓存：只在路由允许、且容器存在时生效 ———
  // 刻意排在预算闸**之前**：命中缓存是零成本答案，不该因为额度耗尽反而被拒。
  const cacheable = spec.cache === "cacheable" && Boolean(ctx.store);
  const key = cacheable ? consultCacheKey(route, input, spec.cacheIgnores ?? []) : null;
  if (key && ctx.store) {
    const hit = ctx.store.get(key);
    if (hit !== undefined) {
      finish({ tier: "cache", cached: true, rounds: 0, model, ok: true, errors: [] });
      return hit as ConsultResultMap[R];
    }
  }

  // ——— 预算闸：拒发也要留痕 ———
  if (ctx.budget && ctx.budget.left <= 0) {
    finish({ tier: "none", cached: false, rounds: 0, model, ok: false, errors: ["预算耗尽"] });
    throw new ConsultUnavailableError(route, "咨询预算已耗尽");
  }

  if (ctx.budget) ctx.budget.left -= 1;

  const id = capabilityId(ctx.aiSettings, model);
  let tier: ConsultWireMode = wireSupport.get(id) ?? "json_schema";
  let demotions = 0;
  let llmCalls = 0;
  let correction = "";
  let lastRaw = "";
  let lastTier: ConsultWireMode = tier;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: spec.system },
    { role: "user", content: spec.buildPrompt(input) },
  ];

  while (llmCalls < spec.maxRounds) {
    if (ctx.signal?.aborted) {
      finish({ tier, cached: false, rounds: llmCalls, model, ok: false, errors: ["用户已中止"] });
      throw new ConsultUnavailableError(route, "用户已中止咨询");
    }

    llmCalls += 1;
    lastTier = tier;
    const wait = beginAgentLlmWait({ parentSignal: ctx.signal, timeoutMs: spec.timeoutMs });
    let raw = "";
    try {
      const transport = ctx.transport ?? createDefaultTransport(ctx.aiSettings);
      raw = await transport.complete({
        model,
        messages: correction
          ? [...messages, { role: "user", content: correction }]
          : messages,
        responseFormat: buildResponseFormat(route, tier),
        maxTokens: spec.maxTokens,
        signal: wait.signal,
      });
    } catch (error) {
      // 能力不支持 → 降级并**退还本次额度**（它并不是一次"答题尝试"）；降级次数本身有上限，循环必然收敛
      if (isUnsupportedFeatureError(error) && demotions < TIER_ORDER.length - 1) {
        demotions += 1;
        llmCalls -= 1;
        tier = demote(tier);
        rememberWireSupport(id, tier);
        errors.push(`${lastTier} 档不被支持，已降级到 ${tier}`);
        continue;
      }
      const message = describeError(error);
      errors.push(message);
      correction = `上一轮请求失败（${message}）。请严格只输出符合契约的 JSON 对象，不要任何解释。`;
      continue;
    } finally {
      wait.stop();
    }

    lastRaw = raw;
    // ——— 契约校验：本地强 Schema 是最后一堵墙（第 1/2 档也照样过一遍，不盲信供应商） ———
    let validation: ConsultValidation<ConsultResultMap[R]>;
    try {
      validation = spec.validate(parseConsultContent(raw)) as ConsultValidation<ConsultResultMap[R]>;
    } catch (error) {
      validation = {
        ok: false,
        value: null,
        errors: [`输出无法解析为 JSON：${error instanceof Error ? error.message : String(error)}`],
      };
    }

    let refined = validation;
    if (validation.ok && validation.value && spec.refine) {
      const extra = spec.refine(validation.value, input);
      if (extra.length) refined = { ok: false, value: null, errors: extra };
    }

    if (refined.ok && refined.value) {
      if (key && ctx.store) ctx.store.set(key, refined.value);
      finish({ tier, cached: false, rounds: llmCalls, model, ok: true, errors: [] });
      return refined.value;
    }

    errors.push(...refined.errors);
    // 纠正轮：把**本地校验错误原文**回敬模型 —— 这是唯一能让它自我修正的信息
    correction = `你的上一次输出不符合契约，错误如下：\n${refined.errors
      .slice(0, 6)
      .map((line) => `- ${line}`)
      .join("\n")}\n请只输出修正后的 JSON 对象。`;
  }

  finish({ tier: lastTier, cached: false, rounds: llmCalls, model, ok: false, errors });
  throw new ConsultSchemaError(route, errors, lastRaw);
}

/** 空安全包装：任何失败都收敛为 null，供"咨询失败就走本地兜底"的调用方使用 */
export async function tryAskJson<R extends ConsultRoute>(
  route: R,
  input: ConsultInputMap[R],
  ctx: ConsultCallContext,
): Promise<ConsultResultMap[R] | null> {
  try {
    return await askJson(route, input, ctx);
  } catch (error) {
    if (error instanceof ConsultUnavailableError || error instanceof ConsultSchemaError) {
      return null;
    }
    throw error;
  }
}
