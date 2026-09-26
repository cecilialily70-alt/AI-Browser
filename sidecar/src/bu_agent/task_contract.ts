/**
 * 任务契约（Task Contract）与交付物台账（Deliverable Ledger）
 *
 * 背景：过去「任务完成」只有一个判据 —— 模型自己说 done。计划（plan）只是一串给模型看的文本，
 * 运行期**没有任何一份清单**能回答「这个目标到底要交付几样东西、哪几样还没做」。
 * 于是出现用户报障的真实场景：目标是「搜索 → 点图片栏目 → 下载第二张图」，
 * 模型一到搜索结果页就 done（缺 2 项交付物），被驳回后又只是机械重试同一个 done。
 *
 * 这里把目标编译成一份**可逐项核销的契约**：
 *   - Planner（task_analyze）产出 deliverables；规则层在 LLM 不可用时按词典兜底推导；
 *   - 运行期每步都能把「已满足的交付物」核销掉，并在提示词里回喂剩余清单；
 *   - done 时逐项闸门（actions.ts）按这份清单拒绝，并明确点出**还缺哪一项**。
 *
 * 设计约束：
 *   - 全部词表来自 config/deliverable_lexicon.json（纯数据，可整体替换），代码零站点文案；
 *   - 无契约（老调用路径/单测）时退化为「无交付物」→ 行为与改造前一致，绝不误拦；
 *   - 契约只描述「要交付什么」，怎么验证交给 core/deliverable_verify.ts（职责分离）。
 */
import { readFileSync } from "node:fs";

import { readAppEnv } from "../app_env.js";
import {
  diceSimilarity,
  normalizeForSimilarity,
  normalizeHaystack,
  termHit,
} from "../core/text_match.js";
import type { GoalIntent } from "../core/completion_evidence.js";
import { loadDeliverableLexicon, resolveDeliverableLexiconPath } from "./deterministic.js";

/**
 * 交付物类型：每一种都对应一个「确定性可验证」的客观事实形态。
 * 新增类型必须在 core/deliverable_verify.ts 里给出对应验证器，否则视为未实现。
 */
export type DeliverableKind =
  | "navigation"
  | "content_read"
  | "field_filled"
  | "choice_made"
  | "prepay_reached"
  | "submitted"
  | "download"
  | "element_state"
  | "answer_given";

export const DELIVERABLE_KINDS: DeliverableKind[] = [
  "navigation",
  "content_read",
  "field_filled",
  "choice_made",
  "prepay_reached",
  "submitted",
  "download",
  "element_state",
  "answer_given",
];

export interface DeliverableSpec {
  id: string;
  kind: DeliverableKind;
  /** 人类可读的交付物描述（直接来自用户目标/计划原话，便于回喂模型与展示给用户） */
  text: string;
  /** 判定线索：目标里同时出现的检索词/序数/对象名等，验证器据此比对 URL 与页面文案 */
  hints: string[];
  required: boolean;
}

export interface TaskContract {
  goal: string;
  intent: GoalIntent;
  deliverables: DeliverableSpec[];
  /** 契约来源：便于日志区分「模型给的」还是「规则兜底」 */
  source: "llm" | "rule" | "rule_partial";
}

export type DeliverableStatus = "pending" | "satisfied" | "waived";

export interface DeliverableRecord {
  id: string;
  status: DeliverableStatus;
  /** 核销依据（人类可读：哪个验证器、看到了什么事实） */
  evidence: string;
  /** 核销发生的步号 */
  step: number;
  /** 该项被 done 闸门驳回过几次（用于防死循环） */
  blocks: number;
}

/**
 * 运行期台账：由 service 创建，随 ActionContext 下传，逐步骤核销。
 * 与 EvidenceLedger（客观事实流水）互补：这里是「目标要求的清单 + 各项状态」。
 */
export interface DeliverableLedger {
  contract: TaskContract;
  records: Map<string, DeliverableRecord>;
  /** 剩余可用的「模型兜底判定次数」（不确定型交付物才消耗，确定性判定不花钱） */
  judgementsLeft: number;
  /** done 因「交付物未齐」被驳回的次数 */
  rejections: number;
  /** 是否已经把「剩余清单」告知过模型（避免每步重复刷屏） */
  announced: boolean;
}

export interface DeliverableLexiconKinds {
  priority: DeliverableKind[];
  terms: Record<DeliverableKind, string[]>;
  required: Record<DeliverableKind, boolean>;
  maxHints: number;
  maxDeliverables: number;
}

const MAX_SPEC_TEXT = 160;
const MAX_HINT_LENGTH = 32;

/** 句子切分：中英文标点 + 顺序连接词（用户写「然后/接着/再」时就是两个交付动作） */
const CLAUSE_SPLIT_RE = /[，。；；、,;.!?！？\n]+|(?:然后|接着|之后|随后|再|并(?:且)?|,|->|→)/;

let cachedKinds: DeliverableLexiconKinds | null | undefined;

function sanitizeTermList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => normalizeHaystack(item))
        .filter((item) => item.length > 0 && item.length <= MAX_HINT_LENGTH * 2),
    ),
  );
}

function readPolicyNumber(policy: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const n = typeof policy[key] === "number" ? (policy[key] as number) : Number(policy[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 交付物类型词表（与「后续动作识别」共用同一个数据文件，避免两份词表各自漂移）。
 * 缺文件/缺节时返回 null —— 调用方退化为「无法推导契约」而不是猜。
 */
export function loadDeliverableKinds(): DeliverableLexiconKinds | null {
  if (cachedKinds !== undefined) return cachedKinds;
  cachedKinds = null;
  const path = resolveDeliverableLexiconPath();
  if (!path) return cachedKinds;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const section = (parsed.deliverableKinds ?? {}) as Record<string, unknown>;
    const rawKinds = (section.kinds ?? {}) as Record<string, Record<string, unknown>>;
    const policy = (section.policy ?? {}) as Record<string, unknown>;
    const priorityRaw = Array.isArray(section.priority) ? section.priority : DELIVERABLE_KINDS;
    const priority = priorityRaw
      .map((k) => String(k))
      .filter((k): k is DeliverableKind => (DELIVERABLE_KINDS as string[]).includes(k));
    const terms = {} as Record<DeliverableKind, string[]>;
    const required = {} as Record<DeliverableKind, boolean>;
    let found = 0;
    for (const kind of DELIVERABLE_KINDS) {
      const entry = rawKinds[kind] ?? {};
      terms[kind] = sanitizeTermList(entry.terms);
      if (terms[kind].length) found += 1;
      required[kind] = entry.required !== false;
    }
    if (found === 0) return cachedKinds;
    cachedKinds = {
      priority: priority.length ? priority : DELIVERABLE_KINDS,
      terms,
      required,
      maxHints: readPolicyNumber(policy, "maxHints", 6, 1, 12),
      maxDeliverables: readPolicyNumber(policy, "maxDeliverables", 8, 1, 16),
    };
  } catch {
    cachedKinds = null;
  }
  return cachedKinds;
}

/* 统一用顶部 import 的 readFileSync：契约推导发生在分析相位，同步读一次成本可忽略。 */

/* 统一用顶部 import 的 readFileSync：契约推导发生在分析相位，同步读一次成本可忽略。 */

/* 统一用顶部 import 的 readFileSync：契约推导发生在分析相位，同步读一次成本可忽略。 */

/* 统一用顶部 import 的 readFileSync：契约推导发生在分析相位，同步读一次成本可忽略。 */

/** 一句话 → 交付物类型（按 priority 取第一个命中的 kind；全不命中返回 null） */
export function classifyDeliverableText(text: string, kinds = loadDeliverableKinds()): DeliverableKind | null {
  if (!kinds) return null;
  const hay = normalizeHaystack(text);
  if (!hay) return null;
  for (const kind of kinds.priority) {
    const hit = kinds.terms[kind].find((term) => termHit(hay, term));
    if (hit) return kind;
  }
  return null;
}

/**
 * 信息型目标里「读页面」本身不是交付物，交付物是结论 —— 统一归到 `answer_given`。
 * 规则的唯一来源；契约生成的两条路径都走它。
 */
function normalizeDeliverableKindForIntent(
  kind: DeliverableKind,
  intent: GoalIntent,
): DeliverableKind {
  return kind === "content_read" && intent === "informational" ? "answer_given" : kind;
}

/**
 * 交付物类型裁定：**文本优先于模型自述**。
 *
 * 模型给的 `kind` 是自由字段，历史上出现过「文本写的是总结结论、kind 却填 navigation」这种
 * 自相矛盾的条目（用户现场：`帮我总结这个网站的内容` → 契约里凭空多出必交的 `[navigation#2]`，
 * `verifyNavigation` 判「页面从未离开起始地址」→ done 被永久驳回 → 任务原地打转）。
 * 因此：文本能归类时以文本为准（语言无关的通用语义），模型自述只在文本判不出时才作数。
 */
function resolveDeliverableKind(
  text: string,
  declared: DeliverableKind | null,
  kinds: DeliverableLexiconKinds | null,
  intent: GoalIntent,
): DeliverableKind {
  const base = classifyDeliverableText(text, kinds) ?? declared ?? "element_state";
  return normalizeDeliverableKindForIntent(base, intent);
}

/**
 * 信息型目标会不会「为了读懂而导航」？
 *
 * 不会。`总结/分析/介绍这个网站` 的阅读对象就是**当前页**；除非目标里点名了要打开的
 * URL/站点（explicitNavigation），否则 navigation 交付物一定是臆造 —— 而它一旦入账，
 * `verifyNavigation` 就会永久判「未达成」，把 done 卡死在驳回循环里。
 * 宁可不收，也不收一条注定无法核销的债务。
 */
function isPhantomNavigation(
  kind: DeliverableKind,
  intent: GoalIntent,
  explicitNavigation: boolean,
): boolean {
  return kind === "navigation" && intent === "informational" && !explicitNavigation;
}

/**
 * 运行期判据（done 闸门用）：这项交付物是否**目标从未要求**。
 *
 * 与契约生成时的 `isPhantomNavigation` 共用同一份规则 —— 规则的唯一来源在这里，
 * 生成端负责不收，闸门端负责在残留情况下不再把任务锁死。
 */
export function isUnrequestedDeliverable(spec: DeliverableSpec, intent: GoalIntent): boolean {
  return isPhantomNavigation(spec.kind, intent, false);
}

/** 收集一句话里的判定线索：命中词 + 后续动作词（序数/对象名）+ 检索词 + URL 片段 */
function collectHints(text: string, extraTerms: string[], kinds: DeliverableLexiconKinds | null): string[] {
  const maxHints = kinds?.maxHints ?? 6;
  const hay = normalizeHaystack(text);
  const out: string[] = [];
  const kind = classifyDeliverableText(text, kinds);
  if (kind && kinds) {
    for (const term of kinds.terms[kind]) {
      if (out.length >= maxHints) break;
      if (termHit(hay, term)) out.push(term);
    }
  }
  // 后续动作词表（第 N 张 / 前三条 / 图片栏…）是「这一项交付什么」的关键线索，必须一起收进来：
  // 否则「下载第二张图片」只剩「下载」一个线索，验证器无法判断数量要求。
  for (const term of loadDeliverableLexicon() ?? []) {
    if (out.length >= maxHints) break;
    const normalized = normalizeHaystack(term);
    if (normalized && termHit(hay, normalized)) out.push(normalized);
  }
  for (const extra of extraTerms) {
    if (out.length >= maxHints) break;
    const term = normalizeHaystack(extra);
    if (term && termHit(hay, term)) out.push(term);
  }
  // URL 片段：目标里写明的路径/主机名同样是可验证线索
  const urlMatch = String(text).match(/https?:\/\/[^\s，。；、）)\]」"']+/i);
  if (urlMatch?.[0] && out.length < maxHints) out.push(urlMatch[0]);
  return Array.from(new Set(out)).slice(0, maxHints);
}

/**
 * 是否与已有交付物重复。
 *
 * 目标句与计划项常常是同一件事的两种说法（「点击打开图片栏」vs「执行：点击打开图片栏」），
 * 只按字符串相等去重会让同一交付物出现三四次，契约立刻失去意义（模型看到 7 项其实只有 3 件事）。
 * 因此按「同 kind + 文本相似度」判重：这是语言无关的通用手段，不需要任何词典。
 */
function isDuplicateSpec(specs: DeliverableSpec[], kind: DeliverableKind, text: string): boolean {
  const normalized = normalizeForSimilarity(text);
  return specs.some(
    (spec) => spec.kind === kind && diceSimilarity(normalizeForSimilarity(spec.text), normalized) >= 0.6,
  );
}

function specId(kind: DeliverableKind, index: number): string {
  return `${kind}#${index}`;
}

function clip(text: string): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX_SPEC_TEXT ? `${t.slice(0, MAX_SPEC_TEXT - 1)}…` : t;
}

export interface DeriveContractInput {
  goal: string;
  intent: GoalIntent;
  /** 计划项（规则骨架或模型给的都可） */
  plan?: string[];
  /** 目标里显式出现的检索词/关键词，作为线索来源 */
  queryTerms?: string[];
  /**
   * 目标是否**点名**要求打开某个 URL/站点（如「打开 https://… 并总结」）。
   * 缺省 false = 不认为需要导航 —— 信息型目标据此丢弃臆造的 navigation 交付物。
   */
  explicitNavigation?: boolean;
}

/**
 * 规则层契约推导（LLM 不可用 / 未返回 deliverables 时的兜底）。
 *
 * 输入只有「用户原话 + 计划项」，输出是可逐项核销的交付物清单：
 * 拆句 → 归类 → 去重 → 保序。不猜测站点结构，只把用户自己写的动作变成可验证项。
 */
export function deriveContractFromRules(input: DeriveContractInput): TaskContract {
  const kinds = loadDeliverableKinds();
  const goal = String(input.goal ?? "").trim();
  const clauses = String(goal)
    .split(CLAUSE_SPLIT_RE)
    .map((c) => c.trim())
    .filter((c) => c.length > 1);
  const steps = (input.plan ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  const specs: DeliverableSpec[] = [];
  const max = kinds?.maxDeliverables ?? 8;
  const coveredKinds = new Set<DeliverableKind>();

  // 先按**用户原话**建契约（目标才是交付物的唯一权威来源），
  // 再看计划项里有没有引入「原话没提到的新类型交付动作」——有才补，避免同一件事换种说法就多出一项。
  const ordered: Array<{ text: string; fromPlan: boolean }> = [
    ...clauses.map((text) => ({ text, fromPlan: false })),
    ...steps.map((text) => ({ text, fromPlan: true })),
  ];

  for (const { text, fromPlan } of ordered) {
    if (specs.length >= max) break;
    const kind = classifyDeliverableText(text, kinds);
    if (!kind) continue;
    const effectiveKind = normalizeDeliverableKindForIntent(kind, input.intent);
    if (isPhantomNavigation(effectiveKind, input.intent, input.explicitNavigation === true)) continue;
    // 结论型交付物唯一：同一任务不会要两份「用自己的话总结」
    if (effectiveKind === "answer_given" && specs.some((spec) => spec.kind === "answer_given")) {
      continue;
    }
    if (fromPlan && coveredKinds.has(effectiveKind)) continue;
    if (isDuplicateSpec(specs, effectiveKind, text)) continue;
    coveredKinds.add(effectiveKind);
    specs.push({
      id: specId(effectiveKind, specs.length + 1),
      kind: effectiveKind,
      text: clip(text),
      hints: collectHints(text, input.queryTerms ?? [], kinds),
      required: effectiveKind === "answer_given" ? true : kinds?.required[effectiveKind] !== false,
    });
  }

  // 纯搜索/打开类目标（无任何交付动作命中）也要有一项，否则契约空转
  if (specs.length === 0 && steps.length > 0) {
    const kind: DeliverableKind = input.intent === "informational" ? "answer_given" : "navigation";
    specs.push({
      id: specId(kind, 1),
      kind,
      text: clip(steps[0]!),
      hints: collectHints(steps[0]!, input.queryTerms ?? [], kinds),
      required: true,
    });
  }

  return { goal, intent: input.intent, deliverables: specs, source: "rule" };
}

export interface NormalizeContractInput {
  goal: string;
  intent: GoalIntent;
  /** LLM 返回的 deliverables（可能脏、可能缺） */
  raw: unknown;
  plan?: string[];
  queryTerms?: string[];
  /** 目标是否点名要求打开某 URL/站点（见 DeriveContractInput.explicitNavigation） */
  explicitNavigation?: boolean;
}

/** 把模型返回的 deliverables 规整成契约；不可用时回退规则推导 */
export function buildTaskContract(input: NormalizeContractInput): TaskContract {
  const kinds = loadDeliverableKinds();
  const rule = deriveContractFromRules({
    goal: input.goal,
    intent: input.intent,
    plan: input.plan,
    queryTerms: input.queryTerms,
    explicitNavigation: input.explicitNavigation,
  });
  const rawList = Array.isArray(input.raw) ? input.raw : [];
  if (rawList.length === 0) return rule;

  const max = kinds?.maxDeliverables ?? 8;
  const specs: DeliverableSpec[] = [];
  for (const entry of rawList) {
    if (specs.length >= max) break;
    const item = (entry ?? {}) as Record<string, unknown>;
    const text = clip(String(item.text ?? item.deliverable ?? item.name ?? ""));
    if (!text) continue;
    const rawKind = String(item.kind ?? "").trim();
    const declared: DeliverableKind | null = (DELIVERABLE_KINDS as string[]).includes(rawKind)
      ? (rawKind as DeliverableKind)
      : null;
    // 文本优先裁定类型；再由结构闸门拦掉「目标从未要求」的导航债务
    const kind = resolveDeliverableKind(text, declared, kinds, input.intent);
    if (isPhantomNavigation(kind, input.intent, input.explicitNavigation === true)) continue;
    if (kind === "answer_given" && specs.some((spec) => spec.kind === "answer_given")) continue;
    if (isDuplicateSpec(specs, kind, text)) continue;
    const hints = Array.isArray(item.hints)
      ? sanitizeTermList(item.hints)
      : collectHints(text, input.queryTerms ?? [], kinds);
    specs.push({
      id: specId(kind, specs.length + 1),
      kind,
      text,
      hints: hints.slice(0, kinds?.maxHints ?? 6),
      required: item.required === false ? false : kinds?.required[kind] !== false,
    });
  }
  if (specs.length === 0) return rule;

  // 模型漏报的交付物用规则补齐（目标里写明的动作一项都不能丢，这是本契约存在的意义）
  const covered = new Set(specs.map((s) => s.kind));
  const llmCount = specs.length;
  for (const missing of rule.deliverables) {
    if (specs.length >= max) break;
    if (covered.has(missing.kind) || isDuplicateSpec(specs, missing.kind, missing.text)) continue;
    specs.push({ ...missing, id: specId(missing.kind, specs.length + 1) });
    covered.add(missing.kind);
  }
  return {
    goal: input.goal,
    intent: input.intent,
    deliverables: specs,
    source: specs.length === llmCount ? "llm" : "rule_partial",
  };
}

export function createDeliverableLedger(contract: TaskContract): DeliverableLedger {
  const records = new Map<string, DeliverableRecord>();
  for (const spec of contract.deliverables) {
    records.set(spec.id, { id: spec.id, status: "pending", evidence: "", step: -1, blocks: 0 });
  }
  const raw = Number(readAppEnv("DELIVERABLE_LLM_JUDGEMENTS") ?? "");
  const judgements = Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.trunc(raw))) : 3;
  return { contract, records, judgementsLeft: judgements, rejections: 0, announced: false };
}

export interface PendingDeliverable {
  spec: DeliverableSpec;
  record: DeliverableRecord;
}

export function listDeliverables(ledger: DeliverableLedger): Array<{ spec: DeliverableSpec; record: DeliverableRecord }> {
  return ledger.contract.deliverables.map((spec) => ({
    spec,
    record: ledger.records.get(spec.id) ?? { id: spec.id, status: "pending", evidence: "", step: -1, blocks: 0 },
  }));
}

/** 仍待交付的项：required 优先，waived 不再算 */
export function listPendingDeliverables(ledger: DeliverableLedger): PendingDeliverable[] {
  return listDeliverables(ledger).filter(
    (item) => item.record.status === "pending" && item.spec.required,
  );
}

export function markDeliverableSatisfied(
  ledger: DeliverableLedger,
  id: string,
  evidence: string,
  step: number,
): boolean {
  const record = ledger.records.get(id);
  if (!record || record.status === "satisfied") return false;
  record.status = "satisfied";
  record.evidence = evidence;
  record.step = step;
  return true;
}

export function waiveDeliverable(ledger: DeliverableLedger, id: string, reason: string, step: number): void {
  const record = ledger.records.get(id);
  if (!record) return;
  record.status = "waived";
  record.evidence = reason;
  record.step = step;
}

/** 提示词用：把台账渲染成「清单 + 状态」，让模型每步都看得到还差什么 */
export function formatDeliverableLines(ledger: DeliverableLedger): string[] {
  return listDeliverables(ledger).map(({ spec, record }) => {
    const mark =
      record.status === "satisfied" ? "✔" : record.status === "waived" ? "—" : spec.required ? "☐" : "·";
    const why = record.evidence ? `（${record.evidence.slice(0, 80)}）` : "";
    return `${mark} [${spec.id}] ${spec.kind} ${spec.text}${why}`;
  });
}
