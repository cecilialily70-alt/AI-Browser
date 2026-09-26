/**
 * 计划期望（PlanExpects）与本地零成本核对（Phase 3.0 基建 · 3.2 接线 · P0.2 soft-gate）
 *
 * 背景：执行环以前只能靠"上一步失败了"来判断走没走对路，计划项本身**不携带任何预期**，
 * 于是模型在错误的计划上原地打转（用户现场：到了结果页反复 done）。
 *
 * 这里给计划项配一份**可本地核对**的期望（世界模型的最小形态）：
 *   `url_pattern` / `must_appear_in_a11y` / `must_not_appear` / `state_change`
 * 每步执行后零成本比对一次；P0.2 起 soft-gate：首次违反强 nudge，连续 N 次强制 replan。
 *
 * ⚠️ 本文件最危险的地方不是"漏判"，而是"误判"：
 * 一次错误的"计划矛盾"会触发**付费咨询 + 错误重规划**，比不判更糟。
 * 因此所有取舍一律倒向"宁可跳过校验，也不凭空认定违反"——
 * 事实缺失时进 `skipped`（不算违反），只有拿到确定的相反事实才进 `violations`。
 */
import { a11yRoleOfToken } from "../core/a11y_roles.js";
import type { PageKindVerdict } from "../core/page_kind.js";

/* ───────────────────────── 类型 ───────────────────────── */

export interface PlanExpects {
  /**
   * 期望的 URL 形态。
   *
   * 刻意**不是正则**：这是模型生成的字符串，直接 `new RegExp` 等于让模型向我们的进程
   * 注入任意正则（ReDoS 是真实风险）。这里按"通配符 + 子串"求值，表达力足够（计划项级别的
   * 预期本来就很粗），且**不存在灾难性回溯**。
   */
  url_pattern?: string;
  /**
   * 期望页面上出现的 A11y 语义标签。
   *
   * 只接受两种形态（由 `a11y_roles.ts` 的闭集词表校验，其余**本地丢弃**）：
   *   · `role`        —— 例：`textbox`、`button`
   *   · `role:名称`   —— 例：`textbox:搜索`、`button:登录`
   * 网页可见文案（「搜索结果列表」）**不是**合法 token：它匹配不到 `role:名称` 标签集，
   * 留着只会凭空产出 violation（用户现场就是这样误判出"计划矛盾"的）。
   */
  must_appear_in_a11y?: string[];
  /** 期望页面上**不该**出现的 A11y 语义标签（形态约束同 `must_appear_in_a11y`） */
  must_not_appear?: string[];
  /** 期望的状态变化 */
  state_change?: "url_changed" | "dom_reloaded" | "none";
}

export interface PlanStepLike {
  text: string;
  expects?: PlanExpects;
}

/** 核对所需的最小事实集（刻意与 FactSheet 解耦，便于单测与复用） */
export interface ExpectsFacts {
  url: string;
  /** 上一步的 URL；未知传 null/undefined */
  prevUrl?: string | null;
  /** 归一化后的 A11y 标签集；未知传 undefined（**不是**空数组） */
  a11yLabels?: readonly string[];
  /** 观察层是否观察到 DOM 重载；未知传 undefined */
  domReloaded?: boolean;
}

export interface ExpectsCheckResult {
  /** 无 violations 即通过（含"因事实不足而全部跳过"） */
  ok: boolean;
  /** 确定的违反项（可读原因，直接可用于日志与纠正提示） */
  violations: string[];
  /** 因事实不足而未校验的项（不算违反，但应可观测） */
  skipped: string[];
  /** 实际校验通过的项 */
  checked: string[];
}

/* ───────────────────────── 尺寸上限（防止模型给出巨型期望） ───────────────────────── */

const MAX_EXPECTS_TOKENS = 6;
const MAX_TOKEN_CHARS = 60;
const MAX_URL_PATTERN_CHARS = 200;

const STATE_CHANGES = new Set(["url_changed", "dom_reloaded", "none"]);

/**
 * 期望 token 的裁剪：数量、长度、**可匹配性**。
 *
 * 最后一道是本轮新增的硬约束（用户现场）：token 必须能落在 A11y 树上 ——
 * 只接受 `role` 或 `role:名称`（role 取自 a11y_roles.ts 的闭集词表）。
 * 模型写来的自由文本（「搜索结果列表」「下一页」）一律丢弃：它永远匹配不到
 * `role:名称` 标签集，留着只会产出"事实是对的、判据是错的"这类最贵的假矛盾。
 *
 * 丢弃而不是整份作废：坏 token 不该让我们损失同一份期望里其余可用的校验能力
 * （与 url_pattern/state_change 的逐项容错口径一致）。
 */
function sanitizeTokens(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tokens = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 0)
    .map((item) => item.slice(0, MAX_TOKEN_CHARS))
    .filter((item) => a11yRoleOfToken(item) !== null);
  if (!tokens.length) return undefined;
  return tokens.slice(0, MAX_EXPECTS_TOKENS);
}

/**
 * 供日志留痕：原始期望里被丢弃的 token（自由文本 / 假 role）。
 *
 * 为什么单独暴露：`sanitizeExpects` 是纯函数、静默裁剪，如果不在日志里留下"模型原本写了什么"，
 * 将来期望被大量丢弃时我们只会看到"没有 violation"，无从发现判据已被清空。
 */
export function droppedExpectTokens(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const source = raw as Record<string, unknown>;
  const all = [source.must_appear_in_a11y, source.must_not_appear].flatMap((field) =>
    Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [],
  );
  return all
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 0 && a11yRoleOfToken(item) === null);
}

/**
 * 白名单裁剪。坏字段**逐项丢弃**（而不是整份 expect 作废）：
 * 模型写坏一个字段不该让我们损失其余可用的校验能力。
 */
export function sanitizeExpects(raw: unknown): PlanExpects | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const expects: PlanExpects = {};

  if (typeof source.url_pattern === "string") {
    const pattern = source.url_pattern.replace(/\s+/g, " ").trim().slice(0, MAX_URL_PATTERN_CHARS);
    if (pattern) expects.url_pattern = pattern;
  }
  const appear = sanitizeTokens(source.must_appear_in_a11y);
  if (appear) expects.must_appear_in_a11y = appear;
  const notAppear = sanitizeTokens(source.must_not_appear);
  if (notAppear) expects.must_not_appear = notAppear;
  if (typeof source.state_change === "string" && STATE_CHANGES.has(source.state_change)) {
    expects.state_change = source.state_change as PlanExpects["state_change"];
  }

  return Object.keys(expects).length ? expects : undefined;
}

/**
 * 解析 `plan_update` 的单项，**双形态兼容**。
 *
 * 这是最容易埋雷的一处：既有解析器用 `filter(typeof x === "string")`，
 * 会把对象形态**静默吃掉**（不是报错，是消失）。因此这里逐项容错：
 * 坏项返回 null 被丢弃，好项照常通过 —— 绝不因一项坏掉整批计划。
 *
 * 兼容口径（刻意与改造前逐字对齐，避免"顺手收紧"改变既有行为）：
 *   · 字符串 / 数字 / 布尔：与旧版 `String(s ?? "").trim()` 完全一致 —— **只 trim，不折叠内部空白**；
 *   · 对象：仅认 `{text: string}`，无 text 的对象视为坏项丢弃
 *     （旧版会把它变成 "[object Object]" 挂进计划，那是垃圾不是计划项）；
 *   · null / undefined / 数组：丢弃。
 * 为什么对原始值这么宽容：丢项会让任务少做一步，而"数字计划项"最多是难看 ——
 * 两类错的代价不对称，所以宁可留着。
 */
export function coercePlanStep(raw: unknown): PlanStepLike | null {
  if (typeof raw === "string") {
    const text = raw.trim();
    return text ? { text } : null;
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    const text = String(raw).trim();
    return text ? { text } : null;
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const source = raw as Record<string, unknown>;
    if (typeof source.text !== "string") return null;
    const text = source.text.trim();
    if (!text) return null;
    const expects = sanitizeExpects(source.expects);
    return expects ? { text, expects } : { text };
  }
  return null;
}

/** 批量解析，丢弃坏项 */
export function coercePlanSteps(raw: unknown): PlanStepLike[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(coercePlanStep).filter((item): item is PlanStepLike => item !== null);
}

/* ───────────────────────── 同 index 继承（带文本校验） ───────────────────────── */

/**
 * 文本重叠不足以支撑继承时的最小长度。太短的重叠（如"打开"）没有判别力：
 * 「打开登录页」与「打开注册页」会因共同前缀而互相继承，正是我们要避免的错配。
 */
const MIN_INHERIT_OVERLAP = 4;

const PUNCTUATION_RE = /[\s\u3000，。、；：,.;:!！?？"'“”‘’()（）\[\]【】《》<>·\-—_/\\]/g;

function normalizeStepText(text: string): string {
  return String(text ?? "").replace(PUNCTUATION_RE, "").toLowerCase();
}

/**
 * 是否允许把旧计划同 index 的期望继承给新步骤。
 *
 * 规则（架构师裁决 A）：规范化文本**相等**或**互为子串**才继承，否则丢弃。
 *
 * 为什么不能纯按 index 继承：`plan_update` 是整表替换，模型完全可能重排/合并计划。
 * 此时按 index 继承会把「打开登录页」的期望挂到「下载附件」上 —— **不会报错**，
 * 只会让 Arbiter 在错误的事实上判矛盾（正是"给状态机喂错误事实"）。
 * 宁可安全地退化为"无期望"（只是少一层校验），也绝不继承错的。
 */
export function expectationInheritanceAllowed(prevText: string, nextText: string): boolean {
  const a = normalizeStepText(prevText);
  const b = normalizeStepText(nextText);
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length < MIN_INHERIT_OVERLAP) return false;
  return long.includes(short);
}

/** 解析单个新步骤的期望：显式优先，其次带校验的 index 继承，最后无期望 */
export function resolveInheritedExpects(
  prevPlan: ReadonlyArray<PlanStepLike>,
  step: PlanStepLike,
  index: number,
): PlanStepLike {
  if (step.expects) return step;
  const prev = prevPlan[index];
  if (!prev?.expects) return step;
  if (!expectationInheritanceAllowed(prev.text, step.text)) return step;
  return { text: step.text, expects: prev.expects };
}

/** 整批继承（message_manager 的 `applyPlanUpdate` 用） */
export function inheritPlanExpects(
  prevPlan: ReadonlyArray<PlanStepLike>,
  steps: ReadonlyArray<PlanStepLike>,
): PlanStepLike[] {
  return steps.map((step, index) => resolveInheritedExpects(prevPlan, step, index));
}

/* ───────────────────────── 计划更新命令（`update_plan` 工具） ───────────────────────── */

/** 计划更新工具名。**唯一常量**：注册表、工具 schema、服务拦截、测试全部引用它。 */
export const PLAN_TOOL_NAME = "update_plan";

/** 与 `task_analyze` 的 PLAN_HARD_CAP 同量级：防止脏数据灌爆提示词 */
const MAX_PLAN_COMMAND_ITEMS = 12;

export interface PlanCommand {
  /** 新计划（**整表替换**，不是增量）；每项可带期望 */
  steps: PlanStepLike[];
  /** 模型指定的当前项（从 0 开始）；没给则为 null（沿用既有推进状态） */
  currentIndex: number | null;
}

export interface PlanCommandRead {
  command: PlanCommand | null;
  /** 读取失败的原因（可读、可直接回敬模型）；成功时为 null */
  error: string | null;
  /**
   * 原始 `plan` 里被本地丢弃的期望 token（自由文本 / 假 role）。
   *
   * 失败分支也返回（空数组）：读不通的原因是"整份拒绝"，与"某个 token 被裁剪"是两码事。
   */
  dropped: string[];
}

/**
 * 读取 `update_plan` 的参数。
 *
 * 刻意做成"要么完整可用、要么给出可执行的原因"：
 * 计划是**整表替换**，半份计划比没有计划更危险（会让已完成步骤消失、被重做一遍）。
 * 所以任何一处读不通就整份拒绝，并把原因原文回敬给模型让它自己改。
 */
/**
 * 从原始 plan 数组里收集被丢弃的期望 token（自由文本 / 假 role），供日志留痕。
 * 参数是**未裁剪**的原始值 —— 裁过的 expects 里已经没有被丢弃的东西了。
 */
export function droppedPlanExpectTokens(rawPlan: unknown): string[] {
  if (!Array.isArray(rawPlan)) return [];
  return rawPlan.flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? droppedExpectTokens((item as Record<string, unknown>).expects)
      : [],
  );
}

export function readPlanCommand(params: Record<string, unknown> | null | undefined): PlanCommandRead {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {
      command: null,
      error: `update_plan 需要参数对象，形如 {"plan":["步骤1",{"text":"步骤2","expects":{...}}],"current_index":0}`,
      dropped: [],
    };
  }
  if (!Array.isArray(params.plan)) {
    return {
      command: null,
      error: "update_plan 缺少 plan：必须给出**完整**的新计划数组（整表替换，不是增量），不能为空",
      dropped: [],
    };
  }
  const steps = coercePlanSteps(params.plan).slice(0, MAX_PLAN_COMMAND_ITEMS);
  if (!steps.length) {
    return {
      command: null,
      error: "update_plan 的 plan 解析后为空：每项应为字符串或 {text, expects}，坏项会被丢弃但不能全是坏项",
      dropped: droppedPlanExpectTokens(params.plan),
    };
  }
  const rawIndex = params.current_index;
  const currentIndex =
    typeof rawIndex === "number" && Number.isFinite(rawIndex)
      ? Math.max(0, Math.min(Math.trunc(rawIndex), steps.length - 1))
      : null;
  return {
    command: { steps, currentIndex },
    error: null,
    dropped: droppedPlanExpectTokens(params.plan),
  };
}

export interface PlanCommandScan {
  /** 一条合法命令都没有时为 null */
  command: PlanCommand | null;
  /** 参数读不通的原因（逐条，回敬模型用） */
  errors: string[];
  /** 被本地丢弃的期望 token（自由文本/假 role）：留痕用，不影响命令是否被接受 */
  dropped: string[];
}

/**
 * 从动作列表里扫描 `update_plan`（服务在**执行前**拦截，转成 `plan_update`）。
 *
 * 同一步里若出现多条，取**最后一条**：模型连发两条时，后一条是它的最终意见。
 */
export function scanPlanCommands(
  actions: ReadonlyArray<{ name: string; params?: Record<string, unknown> }>,
  toolName: string = PLAN_TOOL_NAME,
): PlanCommandScan {
  let command: PlanCommand | null = null;
  const errors: string[] = [];
  const dropped: string[] = [];
  for (const action of actions) {
    if (action?.name !== toolName) continue;
    const read = readPlanCommand(action.params);
    if (read.command) command = read.command;
    else if (read.error) errors.push(read.error);
    if (read.dropped.length) dropped.push(...read.dropped);
  }
  return { command, errors, dropped };
}



/**
 * URL 通配符匹配：`*` 任意串，其余按字面，**不区分大小写、忽略结尾斜杠**。
 *
 * 语义刻意是**子串式 glob**（两端隐式 `*`）而非全串锚定：
 * 模型写 `baidu.com` 时想表达的是"地址里有它"，若锚定全串就会与
 * `https://www.baidu.com/` 失配 → 凭空产出 violation → 触发付费咨询。
 * 计划项级别的预期本来就很粗，宽容匹配才是正确的方向。
 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  const target = String(url ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const raw = String(pattern ?? "").trim();
  if (!target || !raw) return false;
  const placeholder = "\u0000";
  const body = raw
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // 先转义全部元字符 —— 模型给的绝不是正则
    .replace(/\\\*/g, placeholder) // 再把被转义的 \* 还原成通配占位
    .replace(new RegExp(placeholder, "g"), ".*");
  try {
    return new RegExp(`^.*${body}.*$`, "i").test(target);
  } catch {
    // 理论上不会发生（全部元字符已转义）；真发生则退化为子串匹配，绝不抛出
    return target.includes(raw.toLowerCase());
  }
}

function normalizeLabel(label: string): string {
  return String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/* ───────────────────────── 本地核对 ───────────────────────── */

function labelHits(labels: readonly string[], token: string): boolean {
  const wanted = normalizeLabel(token);
  if (!wanted) return false;
  const colon = wanted.indexOf(":");
  if (colon > 0) {
    const role = wanted.slice(0, colon).trim();
    const name = wanted.slice(colon + 1).trim();
    if (!name) return false;
    return labels.some((label) => {
      const target = normalizeLabel(label);
      return target.startsWith(`${role}:`) && target.includes(name);
    });
  }
  // 裸 role（已由 a11y_roles 词表校验）按 **role 段** 匹配，而不是整串子串：
  // `list` 若按子串匹配会命中 `listitem:...`，凭空产出 violation。
  return labels.some((label) => {
    const target = normalizeLabel(label);
    return target === wanted || target.startsWith(`${wanted}:`);
  });
}

/**
 * 零成本核对。
 *
 * 事实缺失 → `skipped`（不判违反）；拿到相反事实才 `violations`。
 * 这条方向性约束是本文件的灵魂：误判矛盾比漏判贵得多。
 */
export function checkExpects(expects: PlanExpects | undefined, facts: ExpectsFacts): ExpectsCheckResult {
  const violations: string[] = [];
  const skipped: string[] = [];
  const checked: string[] = [];

  if (!expects || Object.keys(expects).length === 0) {
    return { ok: true, violations, skipped, checked };
  }

  if (expects.url_pattern) {
    if (!facts.url) {
      skipped.push("url_pattern：当前 URL 未知");
    } else if (urlMatchesPattern(facts.url, expects.url_pattern)) {
      checked.push(`url_pattern=${expects.url_pattern}`);
    } else {
      violations.push(`url_pattern：期望 ${expects.url_pattern}，实际 ${facts.url}`);
    }
  }

  const labels = facts.a11yLabels;
  if (expects.must_appear_in_a11y?.length) {
    if (!labels?.length) {
      skipped.push("must_appear_in_a11y：A11y 标签未知");
    } else {
      for (const token of expects.must_appear_in_a11y) {
        if (labelHits(labels, token)) checked.push(`出现 ${token}`);
        else violations.push(`must_appear_in_a11y：页面上找不到「${token}」`);
      }
    }
  }

  if (expects.must_not_appear?.length) {
    if (!labels?.length) {
      // 没有标签集就**无法证明"不存在"**——绝不能因此判违反
      skipped.push("must_not_appear：A11y 标签未知（无法证明不存在）");
    } else {
      for (const token of expects.must_not_appear) {
        if (labelHits(labels, token)) violations.push(`must_not_appear：页面上仍出现「${token}」`);
        else checked.push(`未出现 ${token}`);
      }
    }
  }

  if (expects.state_change && expects.state_change !== "none") {
    if (expects.state_change === "url_changed") {
      if (facts.prevUrl === null || facts.prevUrl === undefined) {
        skipped.push("state_change=url_changed：上一步 URL 未知");
      } else if (facts.url !== facts.prevUrl) {
        checked.push("URL 已变化");
      } else {
        violations.push("state_change=url_changed：URL 未变化");
      }
    } else if (expects.state_change === "dom_reloaded") {
      if (facts.domReloaded === undefined) {
        skipped.push("state_change=dom_reloaded：DOM 重载事实未知");
      } else if (facts.domReloaded) {
        checked.push("DOM 已重载");
      } else {
        violations.push("state_change=dom_reloaded：DOM 未重载");
      }
    }
  }

  return { ok: violations.length === 0, violations, skipped, checked };
}

/** 把 page_kind 结论转成 A11y 标签集的便捷构造（供 Arbiter/服务层组装事实用） */
export function a11yLabelsFrom(
  roles: ReadonlyArray<{ role: string; name: string }> | null | undefined,
): string[] | undefined {
  if (!roles?.length) return undefined;
  const labels = roles
    .map((node) => {
      const role = String(node?.role ?? "").trim().toLowerCase();
      const name = String(node?.name ?? "").replace(/\s+/g, " ").trim();
      if (!role) return "";
      return name ? `${role}:${name}` : role;
    })
    .filter(Boolean);
  return labels.length ? labels : undefined;
}

/** 供日志/调试：把结论压成一行 */
export function describePageKindVerdict(verdict: PageKindVerdict): string {
  const parts = [`kind=${verdict.kind}`, `conf=${verdict.confidence.toFixed(2)}`];
  if (verdict.engine) parts.push(`engine=${verdict.engine}`);
  if (verdict.hasSearchBox) parts.push("hasSearchBox");
  if (verdict.hasBlockingOverlay) parts.push("hasOverlay");
  if (verdict.engineSerp) parts.push("engineSerp");
  else if (verdict.serpLike) parts.push("serpLike");
  return parts.join(" · ");
}

/* ───────────────────────── P0.2 soft-gate（纯函数） ───────────────────────── */

/** 连续同一违反签名达到该次数 → 强制 replan（可由配置覆盖） */
export const DEFAULT_EXPECTS_SOFT_GATE_STREAK = 2;

export type ExpectsSoftGateAction = "none" | "nudge" | "replan";

export interface ExpectsSoftGateDecision {
  action: ExpectsSoftGateAction;
  nextStreakKey: string;
  nextStreakCount: number;
  nudge: string | null;
}

/** 稳定签名：同一组违反文案（顺序无关）视为「同一 expect 违反」 */
export function expectsViolationSignature(violations: readonly string[]): string {
  return [...violations]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .sort()
    .join("\u0000");
}

export function buildExpectsSoftGateNudge(
  violations: readonly string[],
  streak: number,
  threshold: number,
): string {
  const detail = violations.slice(0, 3).join("；").slice(0, 220);
  if (streak >= threshold) {
    return (
      `【期望 soft-gate】同类计划期望已连续违反 ${streak} 次（阈值 ${threshold}）：${detail}。` +
      `禁止继续原动作序列；系统将强制重规划。请只执行新计划项，勿重复刚才失败的手法。`
    );
  }
  return (
    `【期望 soft-gate】上一步未满足计划期望（第 ${streak}/${threshold} 次）：${detail}。` +
    `请立即纠正路径或 plan_update；连续 ${threshold} 次同类违反将强制重规划，禁止原动作空转。`
  );
}

/**
 * soft-gate 裁决：首次/未满阈值 → nudge；满阈值且允许 replan → replan；通过 → 清零 streak。
 *
 * `replanAllowed=false`（如简单 SERP）时永不 replan，最多 nudge，避免误杀。
 */
export function decideExpectsSoftGate(input: {
  ok: boolean;
  violations: readonly string[];
  streakKey: string;
  streakCount: number;
  threshold: number;
  replanAllowed: boolean;
}): ExpectsSoftGateDecision {
  if (input.ok || input.violations.length === 0) {
    return { action: "none", nextStreakKey: "", nextStreakCount: 0, nudge: null };
  }
  const threshold = Math.max(1, Math.floor(input.threshold) || DEFAULT_EXPECTS_SOFT_GATE_STREAK);
  const key = expectsViolationSignature(input.violations);
  const count = key && key === input.streakKey ? input.streakCount + 1 : 1;
  const nudge = buildExpectsSoftGateNudge(input.violations, count, threshold);
  if (count >= threshold && input.replanAllowed) {
    return { action: "replan", nextStreakKey: key, nextStreakCount: count, nudge };
  }
  return { action: "nudge", nextStreakKey: key, nextStreakCount: count, nudge };
}
