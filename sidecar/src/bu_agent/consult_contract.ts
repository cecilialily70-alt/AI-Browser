/**
 * Consult 闭集路由表（Phase 2 基建 · **内容与契约层**）
 *
 * 纪律：Consult 不是「开放式问答」。能问什么、怎么问、答案长什么样，全部在这里被**类型锁死**。
 * 调用方拿不到"随便问一句"的能力 —— 它只能从 `ConsultRoute` 联合里选一条，并按该路由的
 * `ConsultInputMap[R]` 形状提供输入，拿回 `ConsultResultMap[R]` 形状的答案。
 *
 * 防漂移设计（本文件的立身之本）：
 *   `RESULT_FIELDS` **一份声明**同时派生出三样东西 ——
 *     ① 第 1 档 `json_schema` 用的 JSON Schema；
 *     ② 第 3 档与终局兜底用的本地强校验器；
 *     ③ `ConsultResultMap` 的 TypeScript 类型。
 *   三者由同一份数据生成，因此**结构上不可能互相漂移**（改一处就三处同时改）。
 *
 * 刻意的取舍：
 *   - 不引 zod（仓库无此依赖，且引入等于新增一套并行契约体系）；
 *   - `engine` 字段不写静态枚举，而是在 `refine` 里对照 `page_policy.engineIds()`
 *     动态校验 —— 否则引擎清单会出现第二份事实源，加引擎时必漏。
 */
import { engineIds } from "../core/page_policy.js";
import type { ModelIntent } from "../ai_model_router.js";

/** 闭集：Consult 只允许问这 7 件事 */
export type ConsultRoute =
  | "classify_goal"
  | "classify_page"
  | "plan_conflict"
  | "captcha_kind"
  | "next_action"
  | "engine_fallback"
  | "locate_control";

/**
 * 保留名单：将来（Phase 3）才该出现的路由。
 * 它们**永远不许缓存** —— 答案随当前事实变化，缓存等于用过期事实决策。
 * 本名单由 `consult-bus.mjs` 看守：谁把这两个名字加进路由表却忘了标 `cache: "never"`，测试立刻红。
 */
export const RESERVED_NEVER_CACHE = ["derive_param", "completion"] as const;

/* ───────────────────────── 字段规格 → 三样产物 ───────────────────────── */

export type ConsultFieldSpec =
  | { readonly type: "string"; readonly required?: boolean; readonly enum?: readonly string[]; readonly maxChars?: number }
  | { readonly type: "boolean"; readonly required?: boolean }
  | { readonly type: "number"; readonly required?: boolean; readonly min?: number; readonly max?: number; readonly integer?: boolean }
  | { readonly type: "nullableNumber"; readonly required?: boolean; readonly min?: number; readonly max?: number; readonly integer?: boolean }
  | { readonly type: "stringArray"; readonly required?: boolean; readonly maxItems?: number; readonly maxChars?: number }
  | { readonly type: "nullableString"; readonly required?: boolean; readonly maxChars?: number }
  | { readonly type: "looseObject"; readonly required?: boolean }
  | {
      readonly type: "objectArray";
      readonly required?: boolean;
      readonly maxItems?: number;
      readonly fields: Readonly<Record<string, ConsultFieldSpec>>;
    };

/** 字段规格 → TS 值类型（③ 的原料） */
type FieldValue<S> =
  S extends { type: "string"; enum: readonly (infer E)[] } ? Extract<E, string>
    : S extends { type: "string" } ? string
      : S extends { type: "boolean" } ? boolean
        : S extends { type: "number" } ? number
          : S extends { type: "nullableNumber" } ? number | null
            : S extends { type: "stringArray" } ? string[]
              : S extends { type: "nullableString" } ? string | null
                : S extends { type: "looseObject" } ? Record<string, unknown>
                  : S extends { type: "objectArray"; fields: infer F }
                    ? F extends Record<string, ConsultFieldSpec>
                      ? Array<InferFields<F>>
                      : never
                    : never;

type RequiredKeys<F> = { [K in keyof F]: F[K] extends { required: true } ? K : never }[keyof F];

type InferFields<F> =
  F extends Record<string, ConsultFieldSpec>
    ? { [K in RequiredKeys<F>]: FieldValue<F[K]> } &
        { [K in Exclude<keyof F, RequiredKeys<F>>]?: FieldValue<F[K]> }
    : never;

export interface ConsultValidation<T> {
  ok: boolean;
  value: T | null;
  /** 面向"纠正轮"的可执行描述（会原文回敬模型） */
  errors: string[];
}

/* ───────────────────── 路由结果声明（唯一事实源） ───────────────────── */

const RESULT_FIELDS = {
  classify_goal: {
    kind: { type: "string", required: true, enum: ["navigate", "search", "understand", "task"] },
    engine: { type: "nullableString", required: true, maxChars: 32 },
    query: { type: "nullableString", required: true, maxChars: 200 },
    needsFollowup: { type: "boolean", required: true },
  },
  classify_page: {
    kind: {
      type: "string",
      required: true,
      enum: ["engine_home", "engine_serp", "captcha_gate", "form", "content", "other"],
    },
    engine: { type: "nullableString", required: true, maxChars: 32 },
    hasSearchBox: { type: "boolean", required: true },
    hasBlockingOverlay: { type: "boolean", required: true },
  },
  plan_conflict: {
    conflict: { type: "boolean", required: true },
    reason: { type: "string", required: true, maxChars: 300 },
    revised_step: { type: "nullableString", required: true, maxChars: 200 },
  },
  captcha_kind: {
    kind: {
      type: "string",
      required: true,
      enum: ["image_text", "slider", "math", "point", "animated", "human_only", "none"],
    },
    confidence: { type: "number", required: true, min: 0, max: 1 },
  },
  // Reflexion：强制"先反思、后动作"，禁止直接抛出一个没有推理依据的动作
  next_action: {
    past_failure_analysis: { type: "string", required: true, maxChars: 400 },
    hypothesis: { type: "string", required: true, maxChars: 300 },
    next_action: {
      type: "objectArray",
      required: true,
      maxItems: 4,
      fields: {
        name: { type: "string", required: true, maxChars: 64 },
        params: { type: "looseObject", required: true },
      },
    },
  },
  engine_fallback: {
    decision: { type: "string", required: true, enum: ["use_engine", "handover"] },
    engine: { type: "nullableString", required: true, maxChars: 32 },
    reason: { type: "string", required: true, maxChars: 300 },
  },
  locate_control: {
    found: { type: "boolean", required: true },
    index: { type: "nullableNumber", required: true, integer: true, min: 0, max: 100_000 },
    reason: { type: "string", required: true, maxChars: 300 },
  },
} as const satisfies Record<ConsultRoute, Record<string, ConsultFieldSpec>>;

type ResultFieldsOf<R extends ConsultRoute> = (typeof RESULT_FIELDS)[R];

/** 派生结果类型：调用方拿到的答案类型随 route 自动收窄 */
export type ConsultResultMap = { [R in ConsultRoute]: InferFields<ResultFieldsOf<R>> };

/* ───────────────────────── 输入声明 ───────────────────────── */

export interface ConsultInputMap {
  classify_goal: { goal: string; visibleText?: string; engines: string[] };
  classify_page: { url: string; title: string; a11yRoles?: string[]; engines: string[] };
  plan_conflict: { goal: string; step: string; url: string; facts: string[] };
  captcha_kind: { url: string; title: string; a11yRoles?: string[]; controlLabels: string[] };
  next_action: { goal: string; lastFailure: string; url: string; a11yRoles?: string[] };
  engine_fallback: { engines: string[]; failedEngine: string; failure: string };
  locate_control: { goal: string; controls: Array<{ index: number; role: string; text: string }> };
}

/* ───────────────────────── 校验器（② 由字段规格生成） ───────────────────────── */

const MAX_LOOSE_OBJECT_DEPTH = 4;
function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** 宽松对象：放行任意结构，但压住体积与深度（模型可能吐出巨型嵌套） */
function sanitizeLooseObject(raw: unknown, depth = 0): Record<string, unknown> {
  if (!isPlainObject(raw) || depth > MAX_LOOSE_OBJECT_DEPTH) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      out[key] = value.slice(0, 500);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 20)
        .map((item) =>
          typeof item === "string"
            ? item.slice(0, 200)
            : isPlainObject(item)
              ? sanitizeLooseObject(item, depth + 1)
              : item,
        );
    } else if (isPlainObject(value)) {
      out[key] = sanitizeLooseObject(value, depth + 1);
    }
  }
  return out;
}

function describeType(spec: ConsultFieldSpec): string {
  switch (spec.type) {
    case "string":
      return spec.enum ? `其一 ${JSON.stringify(spec.enum)}` : "字符串";
    case "nullableString":
      return "字符串或 null";
    case "boolean":
      return "布尔";
    case "number":
      return "数字";
    case "nullableNumber":
      return "数字或 null";
    case "stringArray":
      return "字符串数组";
    case "looseObject":
      return "对象";
    case "objectArray":
      return "对象数组";
  }
}

/** 单个字段校验：**只接受白名单字段**，类型不符即报错；自由文本按上限截断（不因长而废掉整次咨询） */
function validateField(
  path: string,
  spec: ConsultFieldSpec,
  raw: Record<string, unknown>,
  errors: string[],
): unknown {
  const key = path.split(".").pop()!;
  const present = Object.prototype.hasOwnProperty.call(raw, key);
  const value = raw[key];

  if (!present || value === undefined) {
    if (spec.required) errors.push(`${path}: 缺少必填字段（期望 ${describeType(spec)}）`);
    return undefined;
  }

  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") {
        errors.push(`${path}: 期望 ${describeType(spec)}，实际 ${JSON.stringify(value)?.slice(0, 60)}`);
        return undefined;
      }
      const text = value.trim();
      if (spec.enum && !spec.enum.includes(text)) {
        errors.push(`${path}: 期望其一 ${JSON.stringify(spec.enum)}，实际 ${JSON.stringify(text.slice(0, 60))}`);
        return undefined;
      }
      return spec.maxChars ? text.slice(0, spec.maxChars) : text;
    }
    case "nullableString": {
      if (value === null) return null;
      if (typeof value !== "string") {
        errors.push(`${path}: 期望 ${describeType(spec)}，实际 ${JSON.stringify(value)?.slice(0, 60)}`);
        return undefined;
      }
      const text = value.trim();
      // 模型常把"没有"写成空串或 none/unknown：统一归零为 null，避免下游把占位符当真实值
      if (!text || /^(none|null|unknown|n\/a|\u65e0|-)$/i.test(text)) return null;
      return spec.maxChars ? text.slice(0, spec.maxChars) : text;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        errors.push(`${path}: 期望 布尔，实际 ${JSON.stringify(value)?.slice(0, 60)}`);
        return undefined;
      }
      return value;
    }
    case "number":
    case "nullableNumber": {
      if (value === null && spec.type === "nullableNumber") return null;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${path}: 期望 ${describeType(spec)}，实际 ${JSON.stringify(value)?.slice(0, 60)}`);
        return undefined;
      }
      if (spec.integer && !Number.isInteger(value)) {
        errors.push(`${path}: 期望整数，实际 ${value}`);
        return undefined;
      }
      if (spec.min !== undefined && value < spec.min) {
        errors.push(`${path}: 低于下限 ${spec.min}（实际 ${value}）`);
        return undefined;
      }
      if (spec.max !== undefined && value > spec.max) {
        errors.push(`${path}: 高于上限 ${spec.max}（实际 ${value}）`);
        return undefined;
      }
      return value;
    }
    case "stringArray": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: 期望 字符串数组，实际 ${JSON.stringify(value)?.slice(0, 60)}`);
        return undefined;
      }
      const list = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => (spec.maxChars ? item.trim().slice(0, spec.maxChars) : item.trim()))
        .filter((item) => item.length > 0);
      return spec.maxItems ? list.slice(0, spec.maxItems) : list;
    }
    case "looseObject":
      return isPlainObject(value) ? sanitizeLooseObject(value) : {};
    case "objectArray": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: 期望 对象数组，实际 ${JSON.stringify(value)?.slice(0, 60)}`);
        return undefined;
      }
      const out: Array<Record<string, unknown>> = [];
      const limit = spec.maxItems ?? value.length;
      for (const item of value.slice(0, limit)) {
        if (!isPlainObject(item)) {
          errors.push(`${path}: 元素必须是对象，实际 ${JSON.stringify(item)?.slice(0, 60)}`);
          continue;
        }
        const nested: Record<string, unknown> = {};
        for (const [childKey, childSpec] of Object.entries(spec.fields)) {
          const child = validateField(`${path}.${childKey}`, childSpec, item, errors);
          if (child !== undefined) nested[childKey] = child;
        }
        out.push(nested);
      }
      return out;
    }
  }
}

/**
 * 由字段规格生成校验器（②）。
 * 语义：**白名单裁剪 + 类型强校验**，任何声明外的字段一律丢弃（防止模型夹带私货穿透到执行层）。
 */
export function makeValidator<F extends Record<string, ConsultFieldSpec>>(
  fields: F,
): (raw: unknown) => ConsultValidation<InferFields<F>> {
  return (raw: unknown): ConsultValidation<InferFields<F>> => {
    const errors: string[] = [];
    if (!isPlainObject(raw)) {
      return { ok: false, value: null, errors: ["顶层不是 JSON 对象"] };
    }
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(fields)) {
      const value = validateField(key, spec, raw, errors);
      if (value !== undefined) out[key] = value;
    }
    if (errors.length) return { ok: false, value: null, errors };
    return { ok: true, value: out as InferFields<F>, errors: [] };
  };
}

/**
 * `classify_goal` 的校验器 —— **导出给非总线调用方复用**（Phase 3.2：Planner 相位的 P0 意图）。
 *
 * 为什么导出：Planner 用**自己那一次** LLM 调用顺带产出意图（不额外花钱），但它必须与
 * consult 总线给出**同一种东西**。共用这一个由 `RESULT_FIELDS` 生成的校验器，就保证了
 * "一 Schema、两生产者" —— 意图字段若改，两个生产者同时被编译器与校验器盯住，不会漂移。
 *
 * 注意这里导出的只是**纯校验器**，不是总线本身：Planner 不接触缓存/预算/降级逻辑，
 * 因此不违反 Phase 2 "基建不并入主循环" 的纪律。
 */
export const GOAL_INTENT_VALIDATOR = makeValidator(RESULT_FIELDS.classify_goal);

/** `classify_goal` 的结果类型别名（Planner 与 consult 总线共用同一形状） */
export type GoalIntent = ConsultResultMap["classify_goal"];

/* ───────────────────── JSON Schema（① 由字段规格生成） ───────────────────── */
function fieldJsonSchema(spec: ConsultFieldSpec): Record<string, unknown> {
  switch (spec.type) {
    case "string":
      return {
        type: "string",
        ...(spec.enum ? { enum: [...spec.enum] } : {}),
        ...(spec.maxChars ? { maxLength: spec.maxChars } : {}),
      };
    case "nullableString":
      return { type: ["string", "null"], ...(spec.maxChars ? { maxLength: spec.maxChars } : {}) };
    case "boolean":
      return { type: "boolean" };
    case "number":
      return {
        type: "number",
        ...(spec.min !== undefined ? { minimum: spec.min } : {}),
        ...(spec.max !== undefined ? { maximum: spec.max } : {}),
      };
    case "nullableNumber":
      return {
        type: ["number", "null"],
        ...(spec.min !== undefined ? { minimum: spec.min } : {}),
        ...(spec.max !== undefined ? { maximum: spec.max } : {}),
      };
    case "stringArray":
      return {
        type: "array",
        items: { type: "string", ...(spec.maxChars ? { maxLength: spec.maxChars } : {}) },
        ...(spec.maxItems ? { maxItems: spec.maxItems } : {}),
      };
    case "looseObject":
      return { type: "object", additionalProperties: true };
    case "objectArray":
      return {
        type: "array",
        ...(spec.maxItems ? { maxItems: spec.maxItems } : {}),
        items: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(spec.fields).map(([key, child]) => [key, fieldJsonSchema(child)]),
          ),
          required: Object.entries(spec.fields)
            .filter(([, child]) => child.required)
            .map(([key]) => key),
          additionalProperties: false,
        },
      };
  }
}

/**
 * 生成 OpenAI `json_schema`（strict）用的结构。
 * strict 模式要求"属性全在 required 里 + additionalProperties:false"，
 * 因此本文件的路由**刻意不声明可选字段**（由 `consult-bus.mjs` 断言守死），否则第 1 档会被供应商拒绝。
 */
export function buildResultJsonSchema(route: ConsultRoute): Record<string, unknown> {
  const fields = RESULT_FIELDS[route] as Record<string, ConsultFieldSpec>;
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, fieldJsonSchema(spec)])),
    required: Object.entries(fields)
      .filter(([, spec]) => spec.required)
      .map(([key]) => key),
    additionalProperties: false,
  };
}

/** 供测试断言用 */
export function routeFieldNames(route: ConsultRoute): string[] {
  return Object.keys(RESULT_FIELDS[route]);
}

export function hasOptionalFields(route: ConsultRoute): boolean {
  const fields = RESULT_FIELDS[route] as Record<string, ConsultFieldSpec>;
  return Object.values(fields).some((spec) => !spec.required);
}

/* ───────────────────────── 路由规格 ───────────────────────── */

export interface ConsultRouteSpec<R extends ConsultRoute> {
  /** 缓存策略：由路由表决定，调用方**不可覆盖** */
  cache: "cacheable" | "never";
  modelIntent: ModelIntent;
  timeoutMs: number;
  /** **总** LLM 调用次数的硬上限（含纠正轮）—— 成本上限由此确定，不会被降级试错放大 */
  maxRounds: number;
  maxTokens: number;
  system: string;
  buildPrompt: (input: ConsultInputMap[R]) => string;
  validate: (raw: unknown) => ConsultValidation<ConsultResultMap[R]>;
  /** 额外语义校验（需要对照输入/政策数据，无法用字段规格表达） */
  refine?: (value: ConsultResultMap[R], input: ConsultInputMap[R]) => string[];
  /**
   * URL 参与缓存键的方式。默认 `"path"`：查询串里常是跟踪参数/会话 id，
   * 纳入键会让缓存永远打不中；代价是"仅查询串不同"的两个页面会共用一个答案。
   * 对查询串敏感的路由应显式改 `"full"`。
   */
  cacheUrl?: "path" | "full";
  /**
   * 显式排除出缓存键的输入字段（可评审的取舍）。
   *
   * 默认（不填）**把每个输入字段都算进键**：这样结构上不可能出现
   * "答案依赖某个输入、但那个输入没进键"的静默错答。只有确认某字段与答案无关时才排除。
   * 类型上限定为该路由**输入字段名的子集**，因此写错字段名编译期即失败。
   */
  cacheIgnores?: readonly (keyof ConsultInputMap[R] & string)[];
}

const CLOSED_VOCAB_RULE =
  "只输出 JSON 对象，不要解释、不要 markdown 代码块。字段值必须严格取自给定选项，禁止自创新值。";

function engineList(engines: string[]): string {
  return (engines.length ? engines : engineIds()).join(" | ");
}

/** 引擎字段必须落在政策闭集内（否则模型可能编出一个我们根本没有首页地址的引擎） */
function refineEngine(id: string | null, engines: string[]): string[] {
  if (!id) return [];
  const allowed = engines.length ? engines : engineIds();
  if (allowed.includes(id)) return [];
  return [`engine: 期望其一 ${JSON.stringify(allowed)}，实际 ${JSON.stringify(id)}`];
}

/**
 * 把模型给的引擎 id 规范化到**政策闭集**内的规范写法（小写、必须是配置里真有的引擎）。
 *
 * 为什么需要：`nullableString` 校验只保证"是字符串"，不保证"是我们认识的引擎"。
 * 模型给 `"BAIDU"` 或不存在的 `"yandex"` 都会原样通过类型校验，然后在 3.3 里
 * 让 `page_policy` 查不到引擎 —— 那是一个看起来合法、实际查无此物的**假事实**。
 *
 * 命不中一律归 null：语义退化为"用户没点名引擎"（下游会走默认引擎），
 * 比留一个查不到的 id 安全得多。大小写差异属规范化，不算信息丢失。
 */
export function canonicalEngineId(id: unknown, engines: string[] = engineIds()): string | null {
  const raw = String(id ?? "").trim().toLowerCase();
  if (!raw) return null;
  return engines.some((engine) => engine.toLowerCase() === raw) ? raw : null;
}

/**
 * 路由规格表。**显式标注为映射类型**（而不是靠 `satisfies` 保留字面量）：
 * 这样 `CONSULT_ROUTE_SPECS[route]` 在 `route` 为泛型 `R` 时能精确解析成
 * `ConsultRouteSpec<R>`，调用方拿到的 `buildPrompt` / `validate` / `refine` 都是强类型。
 *
 * 闭集性由对象字面量的上下文类型保证：漏一条 → 缺属性报错；多一条 → 多余属性报错。
 */
export const CONSULT_ROUTE_SPECS: { [R in ConsultRoute]: ConsultRouteSpec<R> } = {
  classify_goal: {
    cache: "cacheable",
    modelIntent: "logic",
    timeoutMs: 25_000,
    maxRounds: 2,
    maxTokens: 400,
    system: `你是目标意图分类器。判断用户目标属于哪一类，并抽出检索要素。${CLOSED_VOCAB_RULE}`,
    buildPrompt: (input) =>
      [
        `<用户目标>${input.goal}</用户目标>`,
        `<可选搜索引擎>${engineList(input.engines)}</可选搜索引擎>`,
        input.visibleText ? `<当前页面可见文本>${input.visibleText.slice(0, 600)}</当前页面可见文本>` : "",
        `分类口径：
- navigate：只要"打开/进入某个站点或页面"，没有检索动作；
- search：要"检索/查询/搜一下某内容"（哪怕顺带说打开某引擎首页）；
- understand：交付物是"读懂并告诉我"（总结/分析/回答）；
- task：包含填表、登录、注册、下载、下单等多步操作。
engine：仅当用户在目标里点名了搜索引擎时给出其 id（从可选列表里选），否则 null。
query：仅 search 时给出**纯检索词**（剥掉站点名、"首页/官网"这类页面代称），否则 null。
needsFollowup：目标除了打开/搜索之外还有后续动作（点击某项、下载、切换栏目…）时为 true。`,
      ]
        .filter(Boolean)
        .join("\n"),
    validate: makeValidator(RESULT_FIELDS.classify_goal),
    refine: (value, input) => refineEngine(value.engine, input.engines),
  },
  classify_page: {
    cache: "cacheable",
    modelIntent: "logic",
    timeoutMs: 25_000,
    maxRounds: 2,
    maxTokens: 400,
    system: `你是页面类型分类器。只看给定事实判断这是什么页面。${CLOSED_VOCAB_RULE}`,
    buildPrompt: (input) =>
      [
        `<地址>${input.url}</地址>`,
        `<标题>${input.title}</标题>`,
        input.a11yRoles?.length ? `<无障碍角色>${input.a11yRoles.slice(0, 60).join(", ")}</无障碍角色>` : "",
        `<可选搜索引擎>${engineList(input.engines)}</可选搜索引擎>`,
        `分类口径：
- engine_home：搜索引擎的首页（地址是该引擎根路径，页面有搜索框）；
- engine_serp：搜索引擎的**结果页**（地址带 /search 或 ?q= / ?wd= 等查询参数）；
- captcha_gate：整页人机验证（页面上只有验证控件，没有正常业务内容）；
- form：有输入框与提交按钮的业务表单页；
- content：正文/列表/详情类内容页；
- other：以上都不是。
engine：页面属于哪个搜索引擎（从可选列表选），否则 null。`,
      ]
        .filter(Boolean)
        .join("\n"),
    validate: makeValidator(RESULT_FIELDS.classify_page),
    refine: (value, input) => refineEngine(value.engine, input.engines),
  },
  plan_conflict: {
    cache: "never",
    modelIntent: "logic",
    timeoutMs: 25_000,
    maxRounds: 2,
    maxTokens: 400,
    system: `你是计划一致性审计员。判断"当前计划项"与"页面客观事实"是否冲突。${CLOSED_VOCAB_RULE}
硬规则（搜索宪法）：revised_step **禁止**建议在地址栏拼接或直接打开搜索引擎结果页 URL（含 ?q= / ?wd= / /s?wd= / /search）。检索必须走「引擎首页 → 搜索框 input → Enter/点搜索」。`,
    buildPrompt: (input) =>
      [
        `<用户目标>${input.goal}</用户目标>`,
        `<当前计划项>${input.step}</当前计划项>`,
        `<地址>${input.url}</地址>`,
        `<客观事实>\n${input.facts.slice(0, 12).map((f) => `- ${f}`).join("\n")}\n</客观事实>`,
        `口径：事实与计划项相悖（计划假设的页面状态/前提不成立）才算 conflict=true。
conflict=false 时 revised_step 必须为 null。
conflict=true 时 revised_step 给出**替代的单步描述**（与目标一致、可执行），reason 用一句话说明事实与计划的矛盾点。
若当前已在搜索引擎首页且计划是「输入检索词」：revised_step 只能是「在搜索框 input 后 Enter/点搜索」，禁止改成拼结果页 URL。`,
      ]
        .filter(Boolean)
        .join("\n"),
    validate: makeValidator(RESULT_FIELDS.plan_conflict),
  },
  captcha_kind: {
    cache: "cacheable",
    modelIntent: "logic",
    timeoutMs: 20_000,
    maxRounds: 2,
    maxTokens: 300,
    system: `你是人机验证类型识别器。只看给定事实判断验证类型。${CLOSED_VOCAB_RULE}`,
    buildPrompt: (input) =>
      [
        `<地址>${input.url}</地址>`,
        `<标题>${input.title}</标题>`,
        input.a11yRoles?.length ? `<无障碍角色>${input.a11yRoles.slice(0, 60).join(", ")}</无障碍角色>` : "",
        `<页面上的控件文案>${input.controlLabels.slice(0, 40).join(" | ")}</页面上的控件文案>`,
        `口径：
- image_text：要求读出图中字符/数字填入；
- slider：拖拽滑块对齐缺口；
- math：算式题（如"3+5="）；
- point：按要求点选图中文字/图标；
- animated：动态刷新/旋转的图形验证码；
- human_only：短信/邮箱/验证器一次性动态码 —— 值只在用户本人手上，机器不可能知道；
- none：没有验证。
confidence：0~1，表示你有多确定（证据不足时给低分，不要硬猜）。`,
      ]
        .filter(Boolean)
        .join("\n"),
    validate: makeValidator(RESULT_FIELDS.captcha_kind),
  },
  next_action: {
    cache: "never",
    modelIntent: "logic",
    timeoutMs: 30_000,
    maxRounds: 3,
    maxTokens: 700,
    system: `你是失败诊断器（Reflexion）。上一步动作失败了，你必须**先分析、再假设、最后才给动作**。${CLOSED_VOCAB_RULE}`,
    buildPrompt: (input) =>
      [
        `<用户目标>${input.goal}</用户目标>`,
        `<地址>${input.url}</地址>`,
        `<上一步的失败>${input.lastFailure}</上一步的失败>`,
        input.a11yRoles?.length ? `<无障碍角色>${input.a11yRoles.slice(0, 60).join(", ")}</无障碍角色>` : "",
        `口径：
- past_failure_analysis：先用一两句话点明上一步**为什么**失败（是目标不在、被遮挡、参数错、还是页面已跳转），必须基于给定事实，不许泛泛而谈；
- hypothesis：提出一个**可证伪**的假设（"如果…那么…"），说明你打算改变哪个前提；
- next_action：1~4 个具体动作，必须体现上面的假设，**禁止原样重复上一步失败的手法**；动作名必须是我们支持的工具名。`,
      ]
        .filter(Boolean)
        .join("\n"),
    validate: makeValidator(RESULT_FIELDS.next_action),
  },
  engine_fallback: {
    cache: "never",
    modelIntent: "logic",
    timeoutMs: 20_000,
    maxRounds: 2,
    maxTokens: 300,
    system: `你是搜索引擎可用性决策器。首选引擎打不开时，决定改用哪个引擎，或交人工。${CLOSED_VOCAB_RULE}`,
    buildPrompt: (input) =>
      [
        `<失败的首选引擎>${input.failedEngine}</失败的首选引擎>`,
        `<失败表现>${input.failure}</失败表现>`,
        `<可选搜索引擎>${engineList(input.engines)}</可选搜索引擎>`,
        `口径：
- 首选引擎**不可达/被完全阻断**（超时、空白页、持续无搜索框）→ decision=use_engine，engine 从可选列表里选一个**与失败者不同的**候选；
- 首选引擎**可达但被人机验证挡住 / 看不出是被风控还是真故障** → decision=handover，让人来处理（换引擎也绕不过同一个人）；
- engine 只能是可选列表里的 id；decision=handover 时 engine 必须为 null。`,
      ]
        .filter(Boolean)
        .join("\n"),
    validate: makeValidator(RESULT_FIELDS.engine_fallback),
    refine: (value, input) => {
      const errors = refineEngine(value.engine, input.engines);
      if (value.decision === "use_engine" && !value.engine) {
        errors.push("engine: decision=use_engine 时必须给出候选引擎 id");
      }
      if (value.decision === "use_engine" && value.engine === input.failedEngine) {
        errors.push("engine: 候选引擎不能与失败的首选引擎相同");
      }
      if (value.decision === "handover" && value.engine !== null) {
        errors.push("engine: decision=handover 时 engine 必须是 null");
      }
      return errors;
    },
  },
  locate_control: {
    cache: "cacheable",
    modelIntent: "logic",
    timeoutMs: 20_000,
    maxRounds: 2,
    maxTokens: 300,
    system: `你是控件定位器。只能从**给定的候选控件**里挑，禁止发明不存在的编号。${CLOSED_VOCAB_RULE}`,
    buildPrompt: (input) =>
      [
        `<用户目标>${input.goal}</用户目标>`,
        `<候选控件>\n${input.controls
          .slice(0, 120)
          .map((c) => `[${c.index}] role=${c.role} 文案=${c.text.slice(0, 60)}`)
          .join("\n")}\n</候选控件>`,
        `口径：候选里确实有符合目标语义的控件时 found=true 并给出它的 index（必须是上面出现过的编号）；
找不到时 found=false 且 index=null（**不许硬挑一个相近的**），reason 说明缺什么。`,
      ]
        .filter(Boolean)
        .join("\n"),
    validate: makeValidator(RESULT_FIELDS.locate_control),
    refine: (value, input) => {
      const errors: string[] = [];
      const allowed = new Set(input.controls.map((c) => c.index));
      if (value.found && value.index === null) errors.push("index: found=true 时必须给出编号");
      if (!value.found && value.index !== null) errors.push("index: found=false 时 index 必须是 null");
      if (value.found && value.index !== null && !allowed.has(value.index)) {
        errors.push(`index: ${value.index} 不在候选编号里（禁止发明编号）`);
      }
      return errors;
    },
  },
};

/* ───────────────── 双向闭包证明（编译期） ───────────────── */

type SpecKeys = keyof typeof CONSULT_ROUTE_SPECS;
/** 联合里的每条路由都必须有规格 */
type _ClosedForward = ConsultRoute extends SpecKeys ? true : never;
/** 规格里不许出现联合之外的路由 */
type _ClosedBackward = SpecKeys extends ConsultRoute ? true : never;

export const CONSULT_ROUTES = Object.keys(CONSULT_ROUTE_SPECS) as ConsultRoute[];

/** 运行期双保险：闭集无法被绕过，且"保留永不缓存"名单被强制（供测试调用） */
export function assertClosedRouteSet(): void {
  const forward: _ClosedForward = true;
  const backward: _ClosedBackward = true;
  if (!forward || !backward) {
    throw new Error("Consult 路由闭集被破坏");
  }
  for (const route of RESERVED_NEVER_CACHE) {
    const spec = (CONSULT_ROUTE_SPECS as Record<string, ConsultRouteSpec<ConsultRoute>>)[route];
    if (spec && spec.cache !== "never") {
      throw new Error(`保留路由 ${route} 必须标 cache:"never"`);
    }
  }
}
