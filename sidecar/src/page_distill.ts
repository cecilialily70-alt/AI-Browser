/**
 * Page control distillation: short-ID map, prioritize, structure hash, diffs.
 * Deterministic Node-side preprocessing — LLM never sees long selectors/xpaths.
 *
 * 原则：脚本优先给 Agent 的短 ID 树必须「表单字段 > 主操作按钮 > 链接噪音」，
 * 并按目标词/视口加权，避免 dense 页把输入框截断掉。
 */

import { createHash } from "node:crypto";

import type { AgentElementRef, AgentExtractResult, AgentLlmElement } from "./interactive_elements.js";
import { AGENT_LLM_JSON_CAP, type AgentSenseMode } from "./llm_budget.js";
import { PAGE_PIPELINE_CONFIG } from "./page_pipeline/config.js";
import type { AffinityControl, AffinityIndex } from "./core/target_affinity.js";

const TYPE_PRIORITY: Record<string, number> = {
  searchbox: 0,
  textbox: 0,
  combobox: 1,
  checkbox: 2,
  radio: 2,
  button: 3,
  link: 4,
  tab: 5,
  menuitem: 5,
  iframe: 6,
  other: 9,
};

const FILLABLE_TYPES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "textarea",
  "select",
]);

const NOISE_LINK_RE =
  /home|首页|主页|about|关于|privacy|隐私|cookie|terms|协议|copyright|©|footer|下载.?app|帮助中心/i;

/** 短标签 / 图标控件：不应当页脚噪音挤掉 */
const CHROME_KEEP_RE =
  /^(en|eng|english|he|zh|cn|中文|繁|简|language|support|客服|icon[:.].+|headset)$/i;

export interface DistillOptions {
  /** 用户目标：命中文案/placeholder/name 的控件优先保留 */
  goal?: string;
  /** 视口尺寸；有 rect 时偏好可见控件 */
  viewport?: { width: number; height: number } | null;
  /** 意图→目标关联仲裁结果（观察时刻的「这一行谁才是该点的」裁决） */
  affinity?: AffinityIndex | null;
}

export interface DistillResult {
  llm_json: AgentLlmElement[];
  element_map: Map<string, AgentElementRef>;
  structureHash: string;
  truncated: number;
  host: string;
  denoise: DenoiseStats;
}

/** 去噪账本：便于日志解释「这轮丢了多少噪音、为什么」 */
export interface DenoiseStats {
  input: number;
  output: number;
  dropped: number;
  /** 各规则的丢弃数 */
  drops: Record<string, number>;
  /** 被降权的重复噪音数 */
  demoted: number;
}

/** 兼容历史 input:text / textarea / select → 蒸馏友好类型 */
export function normalizeDistillType(type: string): string {
  const t = String(type ?? "").toLowerCase().trim();
  if (!t) {
    return "other";
  }
  if (TYPE_PRIORITY[t] !== undefined) {
    return t;
  }
  if (t === "textarea" || t === "input:text" || t === "input:email" || t === "input:password" || t === "input:tel" || t === "input:number" || t === "input:url") {
    return "textbox";
  }
  if (t === "input:search" || t === "search") {
    return "searchbox";
  }
  if (t === "select" || t === "input:select-one") {
    return "combobox";
  }
  if (t.startsWith("input:")) {
    return "textbox";
  }
  return t;
}

function typeRank(type: string): number {
  return TYPE_PRIORITY[normalizeDistillType(type)] ?? TYPE_PRIORITY.other;
}

function isFillableType(type: string): boolean {
  const n = normalizeDistillType(type);
  return FILLABLE_TYPES.has(n) || n.startsWith("input:");
}

function controlBlob(el: AgentLlmElement): string {
  return `${el.text ?? ""} ${el.name ?? ""} ${el.placeholder ?? ""} ${el.type ?? ""}`.toLowerCase();
}

function extractGoalTokens(goal: string): string[] {
  const raw = String(goal ?? "");
  if (!raw.trim()) {
    return [];
  }
  const tokens = new Set<string>();
  for (const m of raw.matchAll(
    /[\u4e00-\u9fff]{2,8}|[A-Za-z]{3,16}|עברית|עִבְרִית|Hebrew|EN|HE|Login|Register|password|邮箱|手机|验证码/gi,
  )) {
    const t = String(m[0] ?? "").trim().toLowerCase();
    if (t.length >= 2) {
      tokens.add(t);
    }
  }
  return Array.from(tokens).slice(0, 24);
}

function goalHitScore(el: AgentLlmElement, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const blob = controlBlob(el);
  let hits = 0;
  for (const token of tokens) {
    if (blob.includes(token.toLowerCase())) {
      hits += 1;
    }
  }
  return hits;
}

function viewportScore(
  ref: AgentElementRef | undefined,
  viewport: { width: number; height: number } | null | undefined,
): number {
  const rect = ref?.rect;
  if (!rect || !viewport || viewport.width < 1 || viewport.height < 1) {
    return 0;
  }
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  if (cx < 0 || cy < 0 || cx > viewport.width || cy > viewport.height) {
    return 2; // 视口外略降权（仍可能是表单，不丢）
  }
  if (cy < viewport.height * 0.85 && cx < viewport.width * 0.98) {
    return -1; // 视口内加权
  }
  return 0;
}

function noisePenalty(el: AgentLlmElement): number {
  const n = normalizeDistillType(el.type);
  if (n === "link" || n === "button") {
    const text = (el.text ?? "").trim();
    if (CHROME_KEEP_RE.test(text)) {
      return 0;
    }
    if (NOISE_LINK_RE.test(text) && text.length > 10) {
      return 4;
    }
    // 巨型链接文案通常是导航块
    if (n === "link" && text.length > 40) {
      return 2;
    }
  }
  return 0;
}

/** 语言 / 客服 / 注册相关控件加权 */
function chromeBoost(el: AgentLlmElement, goal: string): number {
  const blob = controlBlob(el);
  const g = String(goal ?? "");
  let boost = 0;
  if (/language|support|icon:|\ben\b|中文|客服/i.test(blob)) {
    boost -= 6;
  }
  if (/注册|register|中文|语言|english|客服|support/i.test(g) && /register|注册|language|support|en|中文|icon:/i.test(blob)) {
    boost -= 10;
  }
  return boost;
}

/**
 * 去噪（硬丢）：只丢「模型无法有意义引用」或「根本不是可点目标」的条目。
 * 只降权、不乱丢：重复噪音走 repetitionPenalty，避免把真实列表项删掉。
 */
export function denoiseControls(
  list: AgentLlmElement[],
  elementMap?: Map<string, AgentElementRef>,
): { list: AgentLlmElement[]; stats: DenoiseStats } {
  const drops: Record<string, number> = {};
  const droppedIds = new Set<string>();
  const tolerance = PAGE_PIPELINE_CONFIG.denoiseOffscreenTolerancePx;
  const minEdge = PAGE_PIPELINE_CONFIG.denoiseMinEdgePx;

  const drop = (id: string, rule: string) => {
    if (droppedIds.has(id)) return;
    droppedIds.add(id);
    drops[rule] = (drops[rule] ?? 0) + 1;
  };

  for (const el of list) {
    const type = normalizeDistillType(el.type);
    const fillable = isFillableType(type);
    const hasIdentity = Boolean(
      (el.text ?? "").trim() || (el.name ?? "").trim() || (el.placeholder ?? "").trim(),
    );
    // R1 无任何可引用标识的 generic 容器：模型既点不准也叫不出
    if (type === "other" && !hasIdentity) {
      drop(el.id, "unidentifiable");
      continue;
    }
    const rect = elementMap?.get(el.id)?.rect;
    if (!rect) continue;
    // R2 装饰性微元素（图标碎屑、0–2px 伪影）；可填控件豁免（勾选框本体可能很小）
    if (!fillable && (rect.w < minEdge || rect.h < minEdge)) {
      drop(el.id, "tiny");
      continue;
    }
    // R3 完全落在视口左/上方的离屏元素：离屏抽屉、影子菜单副本（点它是典型误点）
    if (rect.x + rect.w < -tolerance) {
      drop(el.id, "offscreen-left");
      continue;
    }
    if (rect.y + rect.h < -tolerance) {
      drop(el.id, "offscreen-top");
      continue;
    }
  }

  const kept = list.filter((el) => !droppedIds.has(el.id));
  const droppedCount = list.length - kept.length;
  return {
    list: kept,
    stats: {
      input: list.length,
      output: kept.length,
      dropped: droppedCount,
      drops,
      demoted: 0,
    },
  };
}

/** 可重复类型（表单控件可能在列表里合法重复，绝不降权） */
const REPEATABLE_TYPES = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "iframe"]);

/**
 * 关联仲裁应用的产物：被补回/被标注的条目 + 需要在排名里扶正/压低的关系。
 */
interface AffinityApplied {
  list: AgentLlmElement[];
  elementMap: Map<string, AgentElementRef>;
  /** 同伴条目 id → 真正该点的控件条目 id（长 id，短 id 重映射后修正） */
  companionTargets: Map<string, string>;
  /** 该条目点击会离开当前文档 */
  navigatingCompanions: Set<string>;
  controlIds: Set<string>;
  /** 控件条目 id → 关联依据（供列表直接写出理由） */
  controlReasons: Map<string, string>;
  rescued: number;
}

/** 合成条目 id 前缀：只存在于观察层内部，重映射后即被短 id 取代 */
const AFFINITY_SYNTHETIC_PREFIX = "aff";

/** 三态语义：开关（switch）与复选框在交互上同属「二元勾选」，统一走可填类型以豁免去噪 */
function choiceTypeOf(control: AffinityControl): string {
  if (control.inputType === "radio" || control.role === "radio") {
    return "radio";
  }
  if (control.inputType === "checkbox") {
    return "checkbox";
  }
  return "checkbox";
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

/** 无信息量的「身份」：等于自身类型名 / 标签名，或干脆为空 —— 一律视为「没有可引用身份」 */
const GENERIC_IDENTITIES = new Set([
  "checkbox",
  "radio",
  "switch",
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "other",
  "input",
  "select",
  "textarea",
  "label",
  "div",
  "span",
  "iframe",
  "tab",
  "menuitem",
  "img",
  "svg",
]);

function isGenericIdentity(text: string, ...fallbacks: Array<string | null | undefined>): boolean {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) return true;
  if (GENERIC_IDENTITIES.has(normalized)) return true;
  for (const fallback of fallbacks) {
    const other = String(fallback ?? "").trim().toLowerCase();
    if (other && normalized === other) return true;
  }
  return false;
}

/**
 * 意图→目标关联仲裁在观察层的落点：
 *   ① 把提取阶段漏掉的勾选控件（视觉折叠）补成独立条目，让它有 index、有可点坐标；
 *   ② 给「同行文案/外链」记下它真正该点的控件，重映射时转成短 id 直接写进列表。
 * 全部建立在结构化数据上，不引入任何站点文案判断。
 */
function applyAffinity(
  extract: AgentExtractResult,
  affinity: AffinityIndex | null | undefined,
): AffinityApplied {
  const list: AgentLlmElement[] = extract.llm_json.map((el) => ({ ...el }));
  const elementMap = new Map<string, AgentElementRef>(extract.element_map);
  const companionTargets = new Map<string, string>();
  const navigatingCompanions = new Set<string>();
  const controlIds = new Set<string>();
  const controlReasons = new Map<string, string>();
  if (!affinity || (!affinity.byPeer.size && !affinity.rescued.length)) {
    return { list, elementMap, companionTargets, navigatingCompanions, controlIds, controlReasons, rescued: 0 };
  }

  const bySelector = new Map<string, string>();
  const byXpath = new Map<string, string>();
  for (const [id, ref] of elementMap) {
    if (ref.selector) bySelector.set(ref.selector, id);
    if (ref.xpath) byXpath.set(ref.xpath, id);
  }

  // ① 补回被视觉折叠漏掉的勾选控件
  const rescuedIds = new Set<string>();
  affinity.rescued.forEach((control, index) => {
    const id = `${AFFINITY_SYNTHETIC_PREFIX}${index + 1}`;
    const text = firstNonEmpty(control.label, control.rowText, control.tag);
    list.push({ id, type: choiceTypeOf(control), text: text.slice(0, 60) });
    elementMap.set(id, {
      id,
      selector: control.selector,
      xpath: control.xpath,
      tagName: control.tag,
      inputType: control.inputType,
      text,
      checked: control.checked,
      frameUrl: null,
      rect: control.clickRect ?? control.rect,
    });
    rescuedIds.add(id);
    if (control.selector) bySelector.set(control.selector, id);
    if (control.xpath) byXpath.set(control.xpath, id);
  });

  // ② 建立「同伴 → 控件」关系，并把控件身份补全
  const byId = new Map(list.map((el) => [el.id, el]));
  for (const link of affinity.byPeer.values()) {
    const control = link.control;
    const controlId =
      bySelector.get(control.selector) ??
      (control.xpath ? byXpath.get(control.xpath) : undefined) ??
      [...rescuedIds].find((id) => elementMap.get(id)?.selector === control.selector);
    if (!controlId) continue;
    const controlItem = byId.get(controlId);
    if (controlItem) {
      // 控件身份可能退化成「checkbox」这类无信息量字样（裸复选框无 label 关联）：
      // 此时用探针从同行结构里取到的可引用文案补上，否则模型拿到的是一个叫「checkbox」的目标。
      const ref = elementMap.get(controlId);
      if (isGenericIdentity(String(controlItem.text ?? ""), controlItem.type, ref?.tagName)) {
        const better = firstNonEmpty(control.label, control.rowText);
        if (better) controlItem.text = better.slice(0, 60);
      }
    }
    controlIds.add(controlId);
    controlReasons.set(controlId, control.reason);
    companionTargets.set(link.peerId, controlId);
    if (link.navigates) navigatingCompanions.add(link.peerId);
  }

  return {
    list,
    elementMap,
    companionTargets,
    navigatingCompanions,
    controlIds,
    controlReasons,
    rescued: rescuedIds.size,
  };
}

/** 重复噪音计数键：同类型同文案的链接/按钮 */
function repetitionKey(el: AgentLlmElement): string | null {
  const type = normalizeDistillType(el.type);
  if (REPEATABLE_TYPES.has(type)) return null;
  const text = (el.text ?? "").trim().toLowerCase();
  if (!text) return null;
  return `${type}|${text}`;
}

/** 统计重复噪音（供排名降权与日志） */
export function countRepetitions(list: AgentLlmElement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const el of list) {
    const key = repetitionKey(el);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * 综合排序：类型 → 目标命中 → 可填 → 视口 → 噪音 → 重复次数 → id
 * 重复噪音（同名链接/按钮刷屏）按超出阈值逐条降权，而不是直接删除。
 */
export function prioritizeControls(
  list: AgentLlmElement[],
  options?: DistillOptions & {
    element_map?: Map<string, AgentElementRef>;
    /** 预计算的重复计数，避免每行重算 */
    repetitions?: Map<string, number>;
    /** 关联仲裁：把这些 id 的条目扶正（真正该点的控件） */
    promoteIds?: Set<string>;
    /** 关联仲裁：把这些 id 的条目压低（会抢走勾选意图的同行文案） */
    demoteIds?: Set<string>;
  },
): AgentLlmElement[] {
  const tokens = extractGoalTokens(options?.goal ?? "");
  const viewport = options?.viewport ?? null;
  const map = options?.element_map;
  const goal = options?.goal ?? "";
  const repetitions = options?.repetitions ?? countRepetitions(list);
  const maxPerLabel = PAGE_PIPELINE_CONFIG.denoiseMaxPerLabel;
  const repeatPenalty = PAGE_PIPELINE_CONFIG.denoiseRepeatPenalty;
  const promoteIds = options?.promoteIds ?? null;
  const demoteIds = options?.demoteIds ?? null;
  const seen = new Map<string, number>();

  return [...list]
    .map((el, index) => {
      const ref = map?.get(el.id);
      const key = repetitionKey(el);
      let repeatRank = 0;
      if (key) {
        const nth = (seen.get(key) ?? 0) + 1;
        seen.set(key, nth);
        if (nth > maxPerLabel) {
          repeatRank = Math.min(12, (nth - maxPerLabel) * repeatPenalty);
        } else if ((repetitions.get(key) ?? 0) > maxPerLabel) {
          // 已确认是刷屏噪音：从第一条起就轻微降权，尽早让出预算
          repeatRank = 2;
        }
      }
      const rank =
        typeRank(el.type) * 10 +
        (isFillableType(el.type) ? -8 : 0) +
        goalHitScore(el, tokens) * -12 +
        viewportScore(ref, viewport) +
        noisePenalty(el) +
        chromeBoost(el, goal) +
        repeatRank +
        (promoteIds?.has(el.id) ? -14 : 0) +
        (demoteIds?.has(el.id) ? 16 : 0) +
        index * 0.001;
      return { el, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.el.id.localeCompare(b.el.id, undefined, { numeric: true }))
    .map((row) => row.el);
}

/** Stable skeleton fingerprint: types + normalized texts of form-like controls */
export function computeStructureHash(controls: AgentLlmElement[]): string {
  const skeleton = prioritizeControls(controls)
    .filter((el) => {
      const n = normalizeDistillType(el.type);
      return ["textbox", "searchbox", "combobox", "checkbox", "radio", "button"].includes(n);
    })
    .slice(0, 40)
    .map((el) => {
      const n = normalizeDistillType(el.type);
      const text =
        n === "button" || n === "checkbox" || n === "radio"
          ? (el.text ?? "").slice(0, 24).toLowerCase()
          : (el.name || el.placeholder || el.text || n).slice(0, 24).toLowerCase();
      return `${n}:${text}`;
    })
    .join("|");
  return createHash("sha1").update(skeleton || "empty").digest("hex").slice(0, 16);
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Remap extract to short numeric ids ("1","2",…) and cap by sense mode.
 * Local element_map keeps real selector/xpath for execution.
 */
export function distillForLlm(
  extract: AgentExtractResult,
  mode: AgentSenseMode,
  options?: DistillOptions,
): DistillResult {
  const cap = AGENT_LLM_JSON_CAP[mode];
  const affinity = applyAffinity(extract, options?.affinity);
  // 归一化类型后再排序，保证 input:text 等进入 textbox 优先级
  const normalized = affinity.list.map((el) => ({
    ...el,
    type: normalizeDistillType(el.type),
  }));
  // 先硬去噪（装饰/离屏/无标识），再做排序与预算切分
  const denoised = denoiseControls(normalized, affinity.elementMap);
  const repetitions = countRepetitions(denoised.list);
  const demoted = [...repetitions.values()].filter(
    (n) => n > PAGE_PIPELINE_CONFIG.denoiseMaxPerLabel,
  ).length;
  const denoise: DenoiseStats = { ...denoised.stats, demoted };
  const ranked = prioritizeControls(denoised.list, {
    goal: options?.goal,
    viewport: options?.viewport,
    element_map: affinity.elementMap,
    repetitions,
    // 关联仲裁：控件扶正、会抢走勾选意图的同行文案压低，保证模型先看到真正该点的目标
    promoteIds: affinity.controlIds,
    demoteIds: new Set(affinity.companionTargets.keys()),
  });

  // 硬保底：至少保留一批可填字段（避免全被链接挤掉）；关联仲裁的控件绝不能被截断掉
  const fillables = ranked.filter((el) => isFillableType(el.type));
  const others = ranked.filter((el) => !isFillableType(el.type));
  const fillKeep = Math.min(fillables.length, Math.max(12, Math.floor(cap * 0.45)));
  const protectedFillables = fillables.slice(0, fillKeep);
  for (const el of fillables) {
    if (affinity.controlIds.has(el.id) && !protectedFillables.some((p) => p.id === el.id)) {
      protectedFillables.push(el);
    }
  }
  const merged = [...protectedFillables, ...others];
  // 再按原 rank 去重保序
  const seen = new Set<string>();
  const ordered: AgentLlmElement[] = [];
  for (const el of ranked) {
    if (merged.some((m) => m.id === el.id) && !seen.has(el.id)) {
      seen.add(el.id);
      ordered.push(el);
    }
  }
  for (const el of merged) {
    if (!seen.has(el.id)) {
      seen.add(el.id);
      ordered.push(el);
    }
  }

  const truncated = Math.max(0, ordered.length - cap);
  const kept = ordered.slice(0, cap);

  const llm_json: AgentLlmElement[] = [];
  const element_map = new Map<string, AgentElementRef>();

  // 长 id → 短 id：关联仲裁的指向必须换成本轮列表里真实存在的编号，否则宁可不写（悬空指针比没有更糟）
  const longToShort = new Map<string, string>();
  kept.forEach((item, index) => longToShort.set(item.id, String(index + 1)));
  const typeById = new Map(kept.map((item) => [item.id, normalizeDistillType(item.type)]));
  const textById = new Map(kept.map((item) => [item.id, String(item.text ?? "").trim()]));

  kept.forEach((item, index) => {
    const shortId = String(index + 1);
    const ref = affinity.elementMap.get(item.id);
    const slim: AgentLlmElement = {
      id: shortId,
      type: normalizeDistillType(item.type),
      text: (item.text ?? "").slice(0, 60),
    };
    if (item.placeholder) {
      slim.placeholder = item.placeholder.slice(0, 40);
    }
    // 可填控件保留 name，方便 Agent 对齐「手机号/密码」等字段
    if (item.name && isFillableType(item.type)) {
      slim.name = item.name.slice(0, 40);
    }
    // 字段状态与一次性凭证身份必须穿过蒸馏层：它们是**运行时契约**（幂等写入 / 人工闸门），
    // 丢掉就会让「模型看到的列表」和「执行层认定的事实」两套说法打架。
    if (typeof item.filled === "boolean") {
      slim.filled = item.filled;
    }
    if (item.humanOnly) {
      slim.humanOnly = item.humanOnly;
    }

    const targetLong = affinity.companionTargets.get(item.id);
    if (targetLong) {
      const targetShort = longToShort.get(targetLong);
      if (targetShort) {
        const link = options?.affinity?.byPeer.get(item.id);
        slim.affinity = {
          kind: "choice-companion",
          targetId: targetShort,
          ...(typeById.get(targetLong) ? { targetType: typeById.get(targetLong)! } : {}),
          ...(textById.get(targetLong) ? { targetText: textById.get(targetLong)!.slice(0, 40) } : {}),
          ...(affinity.navigatingCompanions.has(item.id) ? { navigates: true } : {}),
          reason: link?.control.reason ?? "same-row",
        };
      }
    } else if (affinity.controlIds.has(item.id)) {
      const companions = [...affinity.companionTargets.entries()]
        .filter(([, controlId]) => controlId === item.id)
        .map(([peerId]) => textById.get(peerId) ?? "");
      slim.affinity = {
        kind: "choice-control",
        ...(companions.filter(Boolean).length ? { targetText: companions.filter(Boolean).join(" / ").slice(0, 40) } : {}),
        reason: affinity.controlReasons.get(item.id) ?? "same-row",
      };
    }

    // 短语言码按钮：保留 role 无必要；text 已够
    llm_json.push(slim);
    if (ref) {
      element_map.set(shortId, {
        ...ref,
        id: shortId,
        rect: ref.rect ?? null,
      });
    }
  });

  return {
    llm_json,
    element_map,
    structureHash: computeStructureHash(normalized),
    truncated,
    host: hostOfUrl(extract.url),
    denoise,
  };
}

export type DistilledExtract = AgentExtractResult & {
  structureHash: string;
  truncated: number;
  denoise: DenoiseStats;
};

export function applyDistillToExtract(
  extract: AgentExtractResult,
  mode: AgentSenseMode,
  options?: DistillOptions,
): DistilledExtract {
  const distilled = distillForLlm(extract, mode, options);
  return {
    ...extract,
    llm_json: distilled.llm_json,
    element_map: distilled.element_map,
    structureHash: distilled.structureHash,
    truncated: distilled.truncated,
    denoise: distilled.denoise,
  };
}
