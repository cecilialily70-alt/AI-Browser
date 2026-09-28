/**
 * 事实包 / 通用快照 → 消息（**纯函数**，无 I/O、无 DOM）
 *
 * 这里是「结构性修掉三个现有 BUG」的落点（宪法 §2 / §0.5.3 J），不是打补丁：
 *
 *   1. **我方消息被当成对方回话** —— 现有引擎用不分方向的 `read.newCount` 判「有回复」，
 *      自己刚发的那条渲染成新节点就会被判成对方回话，于是对同一句再回一次。
 *      本模块直接产出 `newIncoming` / `newOutgoing`，**方向是结构的一部分**。
 *   2. **杂散 DOM 变化终止对话** —— 正在输入、已读回执、撤回都会让「等待」误以为有动静。
 *      本模块把「事件」与「消息」分开：只有**方向为 in 的新消息**才算「对方回话」。
 *   3. **显示时间戳污染回访** —— 站点渲染的「12:30 / 昨天 / 刚刚」不可靠且是本地化文本。
 *      本模块只把 `seenTs` 留痕，**绝不**用它参与排序或回访计算（回访用我方观测时间）。
 *
 * 两条输入路径，**同一套 diff**（避免两套口径分叉）：
 *   - {@link mapRows}：描述符驱动的**事实包**（含媒体/撤回/编辑、图标回退）——P2 `page_agent` 的输入；
 *   - {@link snapshotFromMessages}：现有通用读取器的快照（只有文本/方向），P1 先接上，
 *     并额外用描述符的 id 前缀规则**升级方向**（这一步不需要 DOM，今天就能生效）。
 */

import type { ChatSitePolicy } from "../site_detect.js";
import { loadChatSitePolicy } from "../site_detect.js";
import { resolveDirection, type ChatMessage } from "../conversation_extract.js";
import { hash32Id } from "../../hash32.js";
import { compileDescriptorPattern } from "./manifest.js";
import type {
  ConnectorMessage,
  ConnectorMessageKind,
  RowFact,
  SiteDescriptor,
} from "./types.js";

export interface MapRowsResult {
  /** 去重后的完整快照（按出现顺序） */
  messages: ConnectorMessage[];
  /** 新增且方向为 in —— 只有这些才算「对方回话」 */
  newIncoming: ConnectorMessage[];
  /** 新增且方向为 out（幂等对账用） */
  newOutgoing: ConnectorMessage[];
  /** 同一 id 但内容版本变了（编辑 / 撤回状态变化）：要更新记忆，但**不是**新消息 */
  edited: ConnectorMessage[];
}

/* ————————————————————————— 身份与方向（描述符声明驱动） ————————————————————————— */

/** 从通用读取器的 `key`（`<attr>:<value>`）里拆出属性名与原值 */
export function splitRowKey(key: string | null | undefined): { attr: string; value: string } | null {
  const text = String(key ?? "");
  const at = text.indexOf(":");
  if (at <= 0) return null;
  const attr = text.slice(0, at);
  const value = text.slice(at + 1);
  if (!attr || !value) return null;
  return { attr, value };
}

/** id 是否被描述符声明为「可接受的站点 id 形态」 */
export function isAcceptableRowId(descriptor: SiteDescriptor, rawId: string | null): boolean {
  if (!rawId) return false;
  const spec = descriptor.rows.id;
  // 没声明 id 形态时不做过滤（否则会把通用读取器给的稳定 key 白白丢掉）
  if (!spec || spec.accept.length === 0) return true;
  for (const source of spec.accept) {
    const re = compileDescriptorPattern(source);
    if (re && re.test(rawId)) return true;
  }
  return false;
}

/** 从 id 文本前缀判方向（`false_` = 我方）。前缀是**精确前缀**，不是子串 */
export function directionFromIdPrefix(
  descriptor: SiteDescriptor,
  rawId: string | null,
): "out" | "in" | null {
  const spec = descriptor.rows.idPrefixDirection;
  if (!spec || !rawId) return null;
  if (rawId.startsWith(spec.out)) return "out";
  if (rawId.startsWith(spec.in)) return "in";
  return null;
}

/** 方向判定：严格按描述符声明的顺序回退；最后才用几何 + token 消歧 */
export function resolveFactDirection(
  fact: RowFact,
  descriptor: SiteDescriptor,
  policy: ChatSitePolicy,
): "out" | "in" | "unknown" {
  const fromPrefix = directionFromIdPrefix(descriptor, fact.rawId);
  if (fromPrefix) return fromPrefix;
  if (fact.tailIcon === "out" || fact.tailIcon === "in") return fact.tailIcon;
  if (fact.checkIcon) return "out";
  return resolveDirection({ cxRatio: fact.cxRatio, tokens: fact.tokens }, policy);
}

/**
 * 用描述符的 **id 前缀规则**升级通用快照的方向（不需要 DOM）。
 *
 * 为什么值得单独做：`extractChatItems` 已经回传站点原始 id（`data-id:false_4479…`），
 * 前缀是最可靠的一手方向证据 —— 只靠几何猜，会把「同一侧两条」判模糊；有了前缀就没有猜的余地。
 */
export function upgradeDirections(
  messages: readonly ChatMessage[],
  descriptor: SiteDescriptor,
): ChatMessage[] {
  if (!descriptor.rows.idPrefixDirection) return [...messages];
  return messages.map((message) => {
    const parsed = splitRowKey(message.id.startsWith("k:") ? message.id.slice(2) : null);
    if (!parsed) return message;
    const expectedAttr = descriptor.rows.id?.attr;
    if (expectedAttr && parsed.attr !== expectedAttr) return message;
    const direction = directionFromIdPrefix(descriptor, parsed.value);
    return direction ? { ...message, direction } : message;
  });
}

/* ————————————————————————— 内容版本与类型 ————————————————————————— */

export function contentVersionOf(kind: ConnectorMessageKind, text: string): string {
  return hash32Id(`${kind}|${text}`);
}

function kindOf(fact: RowFact): ConnectorMessageKind {
  if (fact.retracted) return "retracted";
  if (fact.hasMedia) return "media";
  return "text";
}

/**
 * 生成身份。
 *
 * - 有站点 id（且形态被接受）→ `k:<attr>:<rawId>`，`stableId=true`（**首选**）。
 * - 没有 → 内容指纹，`stableId=false`。同一次读取里的**同文重复**再挂一个出现序号，
 *   避免把两条不同气泡折叠成一条（折叠是可接受的已知代价，但「两条变一条」必须是我们
 *   主动、可解释的行为，而不是哈希撞车）。
 */
function identityOf(
  fact: RowFact,
  descriptor: SiteDescriptor,
  kind: ConnectorMessageKind,
  direction: string,
  occurrence: number,
): { id: string; stableId: boolean } {
  if (isAcceptableRowId(descriptor, fact.rawId)) {
    const attr = descriptor.rows.id?.attr ?? "id";
    return { id: `k:${attr}:${fact.rawId}`, stableId: true };
  }
  const seed = `${kind}|${direction}|${fact.text}|${fact.identity ?? ""}`;
  const suffix = occurrence > 0 ? `#${occurrence}` : "";
  return { id: `t:${hash32Id(seed)}${suffix}`, stableId: false };
}

/* ————————————————————————— 唯一的 diff 口径 ————————————————————————— */

/**
 * 「已知消息」的最小形状 —— **专门用来放宽 `previous` 的入参**。
 *
 * 为什么需要：上一次的台账可能来自**磁盘流水**（`thread.jsonl` 只存 id/方向/文本），
 * 那时没有 `contentVersion`。把 `previous` 强卡成完整 {@link ConnectorMessage} 只会逼调用方
 * 造一个假版本号（比漏报编辑更坏）。缺版本号时就不报「被编辑」。
 */
export interface KnownMessageRef {
  id: string;
  contentVersion?: string;
}

/**
 * 与上一次快照对比，区分「新增的对方消息 / 新增的我方消息 / 被编辑的」。
 *
 * 撤回**不进** incoming/outgoing：它不是「对方说了新话」，只是一种状态变化（要更新记忆）。
 * 方向 `unknown` 也**不进** incoming：分不出方向时宁可不当成回话，也不冒「自己回自己」的险。
 */
export function diffSnapshot(
  messages: readonly ConnectorMessage[],
  previous: readonly KnownMessageRef[] = [],
): Omit<MapRowsResult, "messages"> {
  const previousById = new Map(previous.map((m) => [m.id, m]));
  const newIncoming: ConnectorMessage[] = [];
  const newOutgoing: ConnectorMessage[] = [];
  const edited: ConnectorMessage[] = [];

  for (const message of messages) {
    const before = previousById.get(message.id);
    if (!before) {
      if (message.kind === "retracted") continue;
      if (message.direction === "in") newIncoming.push(message);
      else if (message.direction === "out") newOutgoing.push(message);
      continue;
    }
    // 旧台账（磁盘流水）里没有内容版本：无从比对就**不报编辑**（编辑只是记忆维护信号，宁可漏报）
    if (before.contentVersion && before.contentVersion !== message.contentVersion) edited.push(message);
  }

  return { newIncoming, newOutgoing, edited };
}

/* ————————————————————————— 入口 A：事实包（描述符驱动） ————————————————————————— */

export function mapRows(
  rows: readonly RowFact[],
  descriptor: SiteDescriptor,
  previous: readonly KnownMessageRef[] = [],
  policy: ChatSitePolicy = loadChatSitePolicy(),
): MapRowsResult {
  const messages: ConnectorMessage[] = [];
  const seenIds = new Set<string>();
  const occurrences = new Map<string, number>();

  for (const fact of rows) {
    if (fact.excluded) continue;

    const direction = resolveFactDirection(fact, descriptor, policy);
    const kind = kindOf(fact);
    const seed = `${kind}|${direction}|${fact.text}|${fact.identity ?? ""}`;
    const occurrence = occurrences.get(seed) ?? 0;
    occurrences.set(seed, occurrence + 1);

    const { id, stableId } = identityOf(fact, descriptor, kind, direction, occurrence);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    messages.push({
      id,
      direction,
      text: fact.text,
      // 站点显示时间戳只留痕：回访一律用我方观测时间（见文件头第 3 条）
      ts: fact.seenTs,
      identity: fact.identity,
      stableId,
      kind,
      contentVersion: contentVersionOf(kind, fact.text),
    });
  }

  return { messages, ...diffSnapshot(messages, previous) };
}

/* ————————————————————————— 入口 B：通用读取器快照 ————————————————————————— */

/**
 * 把现有通用读取器的快照转成连接器口径。
 *
 * 诚实边界：通用读取器**只抽文本**（无文本的行直接跳过），所以它**看不见**附件/撤回 ——
 * 对方的图片会被记成「没回」。这正是描述符 + 页内事实包（{@link mapRows}）存在的理由；
 * 本函数只保证「把能看见的部分按同一套 diff 口径处理」，并且在拿到描述符时
 * 用 id 前缀把方向钉准。
 */
export function snapshotFromMessages(
  messages: readonly ChatMessage[],
  descriptor: SiteDescriptor | null,
  previous: readonly KnownMessageRef[] = [],
): MapRowsResult {
  const upgraded = descriptor ? upgradeDirections(messages, descriptor) : [...messages];
  const converted: ConnectorMessage[] = upgraded.map((message) => ({
    ...message,
    kind: "text" as const,
    contentVersion: contentVersionOf("text", message.text),
  }));
  return { messages: converted, ...diffSnapshot(converted, previous) };
}

/** 引擎只读这一个机械结论：「对方回话了没有」 */
export function hasIncomingReply(result: MapRowsResult): boolean {
  return result.newIncoming.length > 0;
}

/**
 * 描述符是否**有任何**方向证据 —— 自检与熔断的前置判据。
 *
 * 一个只会认 id、却没有任何方向手段（前缀 / 图标 / 几何）的描述符会把方向全判成 `unknown`，
 * 从而**永远不会**认为对方回话。这必须在启用前拦下（fail-closed），
 * 而不是等到线上「怎么都不回话」再排查。
 */
export function hasDirectionEvidence(descriptor: SiteDescriptor): boolean {
  const rows = descriptor.rows;
  return Boolean(rows.idPrefixDirection || rows.thenTailIcons || rows.thenCheckIcons);
}
