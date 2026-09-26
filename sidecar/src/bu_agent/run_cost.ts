/**
 * P5.4：单次 Agent 的 token / 估算费用 / 失败分类。
 *
 * - 只累计供应商返回的 usage，禁止按字符数估 token
 * - 单价来自 llm_cost_rates.json；未知模型用 default，并标记
 * - 失败次数只保留 ActionFailureKind → 整数；不含目标、选择器、OTP、密钥
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FAILURE_POLICY } from "../core/action_feedback.js";
import { redactSecretText } from "../secret_redaction.js";

export interface TokenRate {
  prompt: number;
  completion: number;
}

export interface LlmCostRates {
  currency: "USD";
  defaultPerMillion: TokenRate;
  models: Record<string, TokenRate>;
}

export const DEFAULT_LLM_COST_RATES: LlmCostRates = {
  currency: "USD",
  defaultPerMillion: { prompt: 0.5, completion: 1.5 },
  models: {
    "deepseek-chat": { prompt: 0.14, completion: 0.28 },
    "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
    "gpt-4o": { prompt: 2.5, completion: 10 },
  },
};

const FAILURE_KINDS = new Set<string>(Object.keys(FAILURE_POLICY));

const storage = new AsyncLocalStorage<RunCostMeter>();
let cachedRates: LlmCostRates | undefined;

function rateCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "../../config/llm_cost_rates.json"),
    join(here, "../../../config/llm_cost_rates.json"),
    join(process.cwd(), "config", "llm_cost_rates.json"),
    join(process.cwd(), "sidecar", "config", "llm_cost_rates.json"),
  ];
}

export function resolveLlmCostRatesPath(): string | null {
  for (const candidate of rateCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* 单个候选异常不阻断 */
    }
  }
  return null;
}

function readRate(raw: unknown, fallback: TokenRate): TokenRate {
  if (!raw || typeof raw !== "object") return fallback;
  const row = raw as Record<string, unknown>;
  const prompt = Number(row.prompt);
  const completion = Number(row.completion);
  return {
    prompt: Number.isFinite(prompt) && prompt >= 0 ? prompt : fallback.prompt,
    completion: Number.isFinite(completion) && completion >= 0 ? completion : fallback.completion,
  };
}

export function loadLlmCostRates(): LlmCostRates {
  if (cachedRates) return cachedRates;
  const path = resolveLlmCostRatesPath();
  if (!path) {
    cachedRates = DEFAULT_LLM_COST_RATES;
    return cachedRates;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const modelsRaw = parsed.models;
    const models: Record<string, TokenRate> = {};
    if (modelsRaw && typeof modelsRaw === "object") {
      for (const [key, value] of Object.entries(modelsRaw as Record<string, unknown>)) {
        const id = key.trim().toLowerCase();
        if (!/^[a-z0-9._:/-]{1,80}$/.test(id)) continue;
        models[id] = readRate(value, DEFAULT_LLM_COST_RATES.defaultPerMillion);
      }
    }
    cachedRates = {
      currency: "USD",
      defaultPerMillion: readRate(parsed.defaultPerMillion, DEFAULT_LLM_COST_RATES.defaultPerMillion),
      models: Object.keys(models).length > 0 ? models : { ...DEFAULT_LLM_COST_RATES.models },
    };
  } catch {
    cachedRates = DEFAULT_LLM_COST_RATES;
  }
  return cachedRates;
}

/** 测试隔离：避免进程内缓存挡住换文件。 */
export function clearLlmCostRateCache(): void {
  cachedRates = undefined;
}

export function nonnegInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

function addCount(sum: number, delta: number): number {
  const next = sum + delta;
  if (!Number.isFinite(next) || next < 0) return sum;
  return Math.min(next, Number.MAX_SAFE_INTEGER);
}

/** 模型名只留安全字符；密钥形态整段丢弃，不写入看板。 */
export function sanitizeLlmModelId(raw: unknown): string {
  const text = redactSecretText(String(raw ?? "")).trim();
  if (!text || text.includes("***") || /sk-/i.test(text)) return "";
  if (!/^[A-Za-z0-9._:/-]{1,80}$/.test(text)) return "";
  return text;
}

function hasOtpDigitRun(value: string): boolean {
  let run = 0;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      run += 1;
      if (run >= 4) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

export function isBoardLabel(value: string): boolean {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(value)) return false;
  if (hasOtpDigitRun(value)) return false;
  if (/(otp|secret|password|apikey|token|cvv|sk-)/.test(value)) return false;
  return true;
}

/** 只保留已知失败 kind 的正整数次数。 */
export function sanitizeFailureCounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!FAILURE_KINDS.has(key) || !isBoardLabel(key)) continue;
    if (typeof value !== "number") continue;
    const n = nonnegInt(value);
    if (n <= 0) continue;
    out[key] = Math.min(n, 100_000);
    if (Object.keys(out).length >= 24) break;
  }
  return out;
}

function dominantFailureKind(counts: Record<string, number>): string | null {
  let best: string | null = null;
  let n = 0;
  for (const key of Object.keys(counts).sort()) {
    const count = counts[key] ?? 0;
    if (count > n) {
      n = count;
      best = key;
    }
  }
  return best;
}

/**
 * 本轮主失败类（稳定 id，不是文案）。
 * 成功 → none（次数仍可另存）；中止优先于动作失败；否则取次数最多的 kind。
 */
export function classifyRunFailure(input: {
  success: boolean;
  status?: string;
  hitlOccurred: boolean;
  counts?: unknown;
}): string {
  if (input.status === "aborted") return "aborted";
  if (input.success) return "none";
  const dominant = dominantFailureKind(sanitizeFailureCounts(input.counts));
  if (dominant) return dominant;
  if (input.hitlOccurred) return "needs-human";
  return "unclassified";
}

function resolveRate(model: string, rates: LlmCostRates): { rate: TokenRate; usedDefault: boolean } {
  const id = model.trim().toLowerCase();
  const direct = id ? rates.models[id] : undefined;
  if (direct) return { rate: direct, usedDefault: false };
  let bestKey = "";
  let best: TokenRate | null = null;
  for (const [key, rate] of Object.entries(rates.models)) {
    const k = key.toLowerCase();
    if (id === k || id.startsWith(`${k}-`) || id.startsWith(`${k}:`)) {
      if (k.length > bestKey.length) {
        bestKey = k;
        best = rate;
      }
    }
  }
  if (best) return { rate: best, usedDefault: false };
  return { rate: rates.defaultPerMillion, usedDefault: true };
}

/** micro-USD = tokens ×（美元 / 百万 token）。 */
export function estimateCostMicroUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  rates: LlmCostRates = loadLlmCostRates(),
): { microUsd: number; usedDefault: boolean } {
  const prompt = nonnegInt(promptTokens);
  const completion = nonnegInt(completionTokens);
  if (prompt === 0 && completion === 0) return { microUsd: 0, usedDefault: false };
  const safeModel = sanitizeLlmModelId(model);
  const { rate, usedDefault } = resolveRate(safeModel, rates);
  const micro = Math.round(prompt * rate.prompt + completion * rate.completion);
  return {
    microUsd: Number.isFinite(micro) && micro > 0 ? Math.min(micro, Number.MAX_SAFE_INTEGER) : 0,
    usedDefault,
  };
}

export interface RunCostSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  llmCalls: number;
  llmModel: string;
  costUsedDefaultRate: boolean;
}

export interface LlmUsageNote {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

export class RunCostMeter {
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  estimatedCostMicroUsd = 0;
  llmCalls = 0;
  llmModel = "";
  costUsedDefaultRate = false;

  constructor(private readonly rates: LlmCostRates) {}

  /**
   * 记一次已返回的 completion。usage 缺失则只增加 llmCalls，token 保持 0（不估算）。
   */
  note(input: LlmUsageNote): void {
    this.llmCalls = addCount(this.llmCalls, 1);
    const prompt = nonnegInt(input.usage?.prompt_tokens);
    const completion = nonnegInt(input.usage?.completion_tokens);
    let total = nonnegInt(input.usage?.total_tokens);
    if (total === 0 && (prompt > 0 || completion > 0)) total = prompt + completion;
    this.promptTokens = addCount(this.promptTokens, prompt);
    this.completionTokens = addCount(this.completionTokens, completion);
    this.totalTokens = addCount(this.totalTokens, total);
    const model = sanitizeLlmModelId(input.model);
    if (model) this.llmModel = model;
    if (prompt > 0 || completion > 0) {
      const priced = estimateCostMicroUsd(model || this.llmModel, prompt, completion, this.rates);
      this.estimatedCostMicroUsd = addCount(this.estimatedCostMicroUsd, priced.microUsd);
      if (priced.usedDefault) this.costUsedDefaultRate = true;
    }
  }

  snapshot(): RunCostSnapshot {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      estimatedCostMicroUsd: this.estimatedCostMicroUsd,
      llmCalls: this.llmCalls,
      llmModel: this.llmModel,
      costUsedDefaultRate: this.costUsedDefaultRate,
    };
  }
}

export function createRunCostMeter(rates: LlmCostRates = loadLlmCostRates()): RunCostMeter {
  return new RunCostMeter(rates);
}

export function currentRunCostMeter(): RunCostMeter | undefined {
  return storage.getStore();
}

export function withRunCostScope<T>(meter: RunCostMeter, fn: () => Promise<T>): Promise<T> {
  return storage.run(meter, fn);
}

export function usageFromChatCompletion(result: unknown): {
  model: string;
  usage: LlmUsageNote["usage"];
} | null {
  if (!result || typeof result !== "object") return null;
  if (Symbol.asyncIterator in result) return null;
  const row = result as Record<string, unknown>;
  if (!Array.isArray(row.choices)) return null;
  const model = typeof row.model === "string" ? row.model : "";
  if (row.usage == null || typeof row.usage !== "object") {
    return { model, usage: null };
  }
  const usage = row.usage as Record<string, unknown>;
  return {
    model,
    usage: {
      prompt_tokens: nonnegInt(usage.prompt_tokens),
      completion_tokens: nonnegInt(usage.completion_tokens),
      total_tokens: nonnegInt(usage.total_tokens),
    },
  };
}

const instrumentedClients = new WeakSet<object>();

/**
 * 仅当处于 Agent 成本作用域时包装 client。Chat 等作用域外调用保持原样。
 * 流式响应不记（没有一次性 usage），也不按正文长度估 token。
 */
export function instrumentLlmClient(client: unknown): void {
  const meter = currentRunCostMeter();
  if (!meter || !client || typeof client !== "object") return;
  const slot = (client as { chat?: { completions?: { create?: unknown } } }).chat?.completions as
    | { create?: (...args: unknown[]) => Promise<unknown> }
    | undefined;
  if (!slot || typeof slot.create !== "function" || instrumentedClients.has(slot)) return;
  const original = slot.create.bind(slot);
  instrumentedClients.add(slot);
  slot.create = async (...args: unknown[]) => {
    const result = await original(...args);
    const parsed = usageFromChatCompletion(result);
    if (parsed) {
      const body = args[0];
      const requested =
        body && typeof body === "object" && typeof (body as { model?: unknown }).model === "string"
          ? String((body as { model: string }).model)
          : "";
      meter.note({ model: parsed.model || requested, usage: parsed.usage });
    }
    return result;
  };
}
