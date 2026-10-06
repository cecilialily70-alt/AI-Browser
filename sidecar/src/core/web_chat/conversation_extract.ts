/**
 * 通用会话读取器（聊天模式 P1）
 *
 * 职责：在任意网站的会话页里定位「消息条目层」，逐条读出文本/方向/身份/时间，
 * 并支持**虚拟列表增量累积**（被动滚上 + 稳定 id 去重）。
 *
 * 分层（与 `site_detect.ts` 同一纪律）：页内只产出**机械事实**（文本、水平中心比、
 * class token、data-* 原样值），方向判定与去重全在 Node 侧纯函数 —— 因此可无浏览器单测。
 *
 * 静音约束（§5）：本模块**永不截图**、不做全景/SoM/a11y/控件树；只用 DOM + 滚动。
 *
 * 诚实约束（§0.5.3 H）：`querySelectorAll` 只会静默给局部结果。拿不到历史就标
 * `moreAbove=true`，**绝不假装读完了**。
 */
import type { Page } from "playwright-core";

import { hash32Id } from "../hash32.js";
import {
  type ChatSitePolicy,
  loadChatSitePolicy,
  matchChatSiteProfile,
} from "./site_detect.js";

export type ChatDirection = "out" | "in" | "unknown";

export interface ChatMessage {
  /** 稳定去重 id（有站点 key 用 key，否则用内容指纹） */
  id: string;
  direction: ChatDirection;
  text: string;
  ts: string | null;
  identity: string | null;
  /** id 是否来自站点自身 key（false 表示用的是内容指纹，可能把同文重复折叠） */
  stableId: boolean;
  /**
   * 消息形态（描述符层产出；通用读取器只产出 `text`）。
   *
   * 为什么必须是**结构**而不是「文本为空就跳过」：对方回了一张图 / 一条语音时文本为空，
   * 若当成「对方没回」，回访阶梯就会去催一个已经回过话的人（§0.5.3 J）。
   * 缺省（`undefined`）按 `text` 处理。
   */
  kind?: "text" | "media" | "retracted";
  /** 同一 id 的内容版本（编辑 / 撤回会变）；缺省表示「无从比对，不报编辑」 */
  contentVersion?: string;
}

export interface ConversationSnapshot {
  ok: boolean;
  /** container_missing | empty | error | null */
  reason: string | null;
  containerSelector: string | null;
  messages: ChatMessage[];
  /** 相对上一次快照新增条数 */
  newCount: number;
  /** 容器上方仍有未读到的历史（滚动位置未到顶） */
  moreAbove: boolean;
  scrollRounds: number;
  /** 是否退化为兜底轮询（页内事件观察不可用）—— 不静默降级 */
  fallbackPoll: boolean;
}

/* ————————————————————————— 页内：机械读取 ————————————————————————— */

export interface ExtractChatArg {
  selector: string;
  maxItems: number;
  maxTextChars: number;
  /** 传数值则先把容器滚到该位置再读（用于虚拟列表回溯）；null 表示原地读 */
  scrollTop: number | null;
}

export interface RawChatItem {
  /** 站点自身的稳定 id（data-message-id / data-id / id=…msg…），没有则 null */
  key: string | null;
  text: string;
  /** 条目水平中心相对容器的比例（0=最左，1=最右） */
  cxRatio: number;
  /** 条目及其后代的小写 class token（去重、限量） */
  tokens: string[];
  ts: string | null;
  identity: string | null;
}

export interface ExtractChatResult {
  ok: boolean;
  /** container_missing | empty | error | null */
  reason: string | null;
  items: RawChatItem[];
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  atBottom: boolean;
}

/** 页内读取（自包含：不得引用模块作用域，见 `probeChatDom` 同款约束） */
export async function extractChatItems(arg: ExtractChatArg): Promise<ExtractChatResult> {
  const fail = (reason: string): ExtractChatResult => ({
    ok: false,
    reason,
    items: [],
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    atBottom: true,
  });

  try {
    const container = document.querySelector(arg.selector) as HTMLElement | null;
    if (!container) return fail("container_missing");

    if (arg.scrollTop !== null && Number.isFinite(arg.scrollTop)) {
      container.scrollTop = Math.max(0, arg.scrollTop);
      // 等两帧：一帧应用滚动、一帧等虚拟列表把新条目渲染出来
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    }

    const tokenize = (el: Element): string[] => {
      const raw = (el as HTMLElement).className;
      if (typeof raw !== "string" || !raw) return [];
      return raw.split(/\s+/).filter(Boolean).slice(0, 6);
    };
    const sigOf = (el: Element): string => {
      const cls = tokenize(el).slice(0, 2).sort().join(".");
      return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
    };

    /**
     * 定位「消息条目层」：BFS 找到第一个「子节点 ≥3、同签名占比 ≥0.5、每项都有文本」的层。
     * 为什么不直接取 `container.children`：真实站点常多一层 wrapper（列表内层）；
     * 而 BFS + 命中即返回能避免误入「某个消息内部的 span 组」。
     */
    const pickItemLevel = (): Element[] => {
      const queue: Array<{ el: Element; depth: number }> = [{ el: container, depth: 0 }];
      let fallback: Element[] | null = null;
      let guard = 0;
      while (queue.length > 0 && guard < 200) {
        guard += 1;
        const { el, depth } = queue.shift()!;
        const kids = Array.from(el.children);
        if (kids.length >= 3 && kids.length <= 300) {
          const counts = new Map<string, number>();
          let textTotal = 0;
          for (const kid of kids) {
            const sig = sigOf(kid);
            counts.set(sig, (counts.get(sig) ?? 0) + 1);
            textTotal += (kid.textContent ?? "").trim().length;
          }
          let maxCount = 0;
          for (const n of counts.values()) if (n > maxCount) maxCount = n;
          const repeat = maxCount / kids.length;
          const avgText = textTotal / kids.length;
          if (avgText >= 1) {
            if (repeat >= 0.5) return kids;
            if (!fallback || repeat > 0.4) fallback = kids;
          }
        }
        if (depth < 3) {
          for (const kid of kids.slice(0, 40)) queue.push({ el: kid, depth: depth + 1 });
        }
      }
      return fallback ?? Array.from(container.children);
    };

    const TIME_NOISE = /^\s*(?:\d{1,2}[:：]\d{2}(?::\d{2})?\s*(?:[APap]\.?[Mm]\.?)?|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*$/;

    const cleanText = (raw: string): string => {
      const lines = String(raw ?? "")
        .replace(/[\u200b-\u200d\ufeff]/g, "")
        .split(/\n+/)
        .map((line) => line.replace(/[\t ]+/g, " ").trim())
        .filter((line) => line.length > 0 && !TIME_NOISE.test(line));
      return lines.join("\n").trim();
    };

    const findKey = (el: Element): string | null => {
      let node: Element | null = el;
      let depth = 0;
      while (node && depth < 3) {
        for (const attr of ["data-message-id", "data-msg-id", "data-id", "data-mid"]) {
          const value = node.getAttribute(attr);
          if (value && value.trim()) return `${attr}:${value.trim()}`;
        }
        const id = node.getAttribute("id");
        if (id && /msg|message|item|chat/i.test(id)) return `id:${id}`;
        node = node.parentElement;
        depth += 1;
      }
      return null;
    };

    const findTs = (el: Element): string | null => {
      const time = el.querySelector("time[datetime]");
      const fromTime = time?.getAttribute("datetime");
      if (fromTime) return fromTime;
      for (const attr of ["data-timestamp", "data-ts", "data-time"]) {
        const value = el.getAttribute(attr);
        if (value && value.trim()) return value.trim();
      }
      return null;
    };

    const findIdentity = (el: Element): string | null => {
      for (const attr of ["data-author", "data-sender", "data-user", "data-name", "data-from"]) {
        const value = el.getAttribute(attr);
        if (value && value.trim()) return value.trim().slice(0, 60);
      }
      const named = el.querySelector(
        '[class*="author"],[class*="sender"],[class*="nickname"],[class*="user-name"]',
      );
      const text = (named?.textContent ?? "").replace(/\s+/g, " ").trim();
      return text ? text.slice(0, 60) : null;
    };

    const collectTokens = (el: Element): string[] => {
      const out = new Set<string>();
      const add = (node: Element): void => {
        for (const token of tokenize(node)) out.add(token.toLowerCase());
      };
      add(el);
      for (const child of Array.from(el.querySelectorAll("*")).slice(0, 8)) add(child);
      return [...out].slice(0, 14);
    };

    const items: RawChatItem[] = [];
    const containerRect = container.getBoundingClientRect();
    for (const el of pickItemLevel()) {
      if (items.length >= arg.maxItems) break;
      const text = cleanText((el as HTMLElement).innerText ?? el.textContent ?? "").slice(0, arg.maxTextChars);
      if (!text) continue;
      const rect = el.getBoundingClientRect();
      const cxRatio =
        containerRect.width > 0 ? (rect.left + rect.width / 2 - containerRect.left) / containerRect.width : 0.5;
      items.push({
        key: findKey(el),
        text,
        cxRatio: Math.max(0, Math.min(1, cxRatio)),
        tokens: collectTokens(el),
        ts: findTs(el),
        identity: findIdentity(el),
      });
    }

    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight || 0;
    const clientHeight = container.clientHeight || 0;

    return {
      ok: true,
      reason: items.length === 0 ? "empty" : null,
      items,
      scrollTop,
      scrollHeight,
      clientHeight,
      atBottom: scrollTop + clientHeight >= scrollHeight - 8,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "extract_failed");
  }
}

/* ————————————————————————— Node 侧纯函数：方向 / 去重 ————————————————————————— */

/** 几何权重高于 class token：token 只作「几何含糊时」的消歧，猜错也不会翻掉明确几何 */
export function resolveDirection(
  item: Pick<RawChatItem, "cxRatio" | "tokens">,
  policy: ChatSitePolicy = loadChatSitePolicy(),
  profileOutTokens?: string[],
  profileInTokens?: string[],
): ChatDirection {
  let score = 0;
  if (item.cxRatio > 0.58) score += 1;
  else if (item.cxRatio < 0.42) score -= 1;

  const tokens = new Set((item.tokens ?? []).map((t) => t.toLowerCase()));
  const outTokens = profileOutTokens?.length ? profileOutTokens : policy.outTokens;
  const inTokens = profileInTokens?.length ? profileInTokens : policy.inTokens;
  if (outTokens.some((t) => tokens.has(t.toLowerCase()))) score += 1;
  if (inTokens.some((t) => tokens.has(t.toLowerCase()))) score -= 1;

  if (score > 0) return "out";
  if (score < 0) return "in";
  return "unknown";
}

/** 生成稳定 id：站点 key 优先；否则内容指纹（可能把同文重复折叠，如实标 `stableId=false`） */
export function messageIdOf(item: RawChatItem, direction: ChatDirection): { id: string; stableId: boolean } {
  if (item.key) return { id: `k:${item.key}`, stableId: true };
  return { id: `t:${hash32Id(`${direction}|${item.text}`)}`, stableId: false };
}

function toMessage(
  item: RawChatItem,
  policy: ChatSitePolicy,
  outTokens?: string[],
  inTokens?: string[],
): ChatMessage {
  const direction = resolveDirection(item, policy, outTokens, inTokens);
  const { id, stableId } = messageIdOf(item, direction);
  return { id, direction, text: item.text, ts: item.ts, identity: item.identity, stableId };
}

function dedupeOrdered(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    out.push(message);
  }
  return out;
}

/**
 * 「对方还在等回话」的那些消息 —— 会话**尾部**那一段连续的对方消息（上一个「我方发言」之后）。
 *
 * 为什么要按**会话顺序**推导，而不是只认「本片新增」（`newIncoming`）：
 *   用户现场（§0.5.3 H「已读到却没回成的消息没人管」）—— 上一片把对方的消息读进了台账，
 *   却在回复之前被中断 / 停了（看门狗、手动停、判成接管、片预算用尽），下一片（含重启后）
 *   再读时这些消息**不再是「新增」**，引擎就以为「对方没说话」，于是**永远不回复**。
 *   用户原话：「重启机器后检查聊天记录还是上次那些，不会自动回复」。
 *   由页面上真实的先后顺序推导，跨片、跨重启都成立。
 *
 * 撤回**不算**对方在等回话（`map_rows` 同一口径：撤回不是「对方说了新话」）。
 * 附件行（`kind === "media"`，文本为空）**算**：对方发了张图也是回了话，必须接住（B7：只回话、不取内容）。
 *
 * `isOwnText`（可选）：方向没判出来的行（`direction === "unknown"`）如果**内容其实就是我方发的**，
 * 它同样算「我方发过话」，这段就到此为止。少了这道，一次方向误判就会让引擎反复回同一句话
 * （宁可不回，也不能刷屏，R7）。
 */
export function unansweredIncoming(
  messages: readonly ChatMessage[],
  opts: {
    isOwnText?: (text: string) => boolean;
    /** 已有我方发件证据时，才允许把「标成 out 但不像我方」的行改按入站收（防 RTL/几何误判） */
    reinterpretMislabeledOut?: boolean;
  } = {},
): ChatMessage[] {
  const collected: ChatMessage[] = [];
  const own = opts.isOwnText;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const text = String(message.text ?? "").trim();
    // 标成 in、但内容就是我方发过的 → 方向误判，按出站截断
    if (message.direction === "in" && own && text && own(text)) break;
    if (message.direction === "in") {
      if (message.kind === "retracted") continue;
      collected.push(message);
      continue;
    }
    if (message.direction === "out") {
      // 标成 out、但内容完全不像我方 → 多半是几何/RTL 把对方气泡判反了
      if (opts.reinterpretMislabeledOut && own && text && !own(text)) {
        if (message.kind === "retracted") continue;
        collected.push(message);
        continue;
      }
      break;
    }
    if (own && text && own(text)) break;
    // 其余（方向未知且看不出是我方 / 系统行）：既不算对方在等回话，也不算「我方发过话」
  }
  return collected.reverse();
}

/** 「原地读最新」合并：新快照替换旧快照，只统计真正新增的条数 */
export function mergeLatest(
  previous: readonly ChatMessage[],
  items: readonly RawChatItem[],
  policy: ChatSitePolicy = loadChatSitePolicy(),
  outTokens?: string[],
  inTokens?: string[],
): { messages: ChatMessage[]; newCount: number } {
  const messages = dedupeOrdered(items.map((item) => toMessage(item, policy, outTokens, inTokens)));
  const known = new Set(previous.map((m) => m.id));
  const newCount = messages.filter((m) => !known.has(m.id)).length;
  return { messages, newCount };
}

/**
 * 「回溯更早」合并：本轮读到的是**更早**的条目，因此拼在新集合之前。
 * 用 id 去重，先出现者（即更早者）胜。
 */
export function mergeOlder(
  previous: readonly ChatMessage[],
  items: readonly RawChatItem[],
  policy: ChatSitePolicy = loadChatSitePolicy(),
  outTokens?: string[],
  inTokens?: string[],
): { messages: ChatMessage[]; newCount: number } {
  const older = items.map((item) => toMessage(item, policy, outTokens, inTokens));
  const known = new Set(previous.map((m) => m.id));
  const merged = dedupeOrdered([...older, ...previous]);
  const newCount = older.filter((m) => !known.has(m.id)).length;
  return { messages: merged, newCount };
}

/* ————————————————————————— 浏览器入口 ————————————————————————— */

export interface ReadConversationOptions {
  /** 已知容器选择器；缺省时按 URL 画像 / 外部传入值定位 */
  containerSelector?: string | null;
  /** 主动回溯历史（虚拟列表）；默认关（静音优先） */
  loadHistory?: boolean;
  policy?: ChatSitePolicy;
  signal?: AbortSignal;
  /** 上一次快照，用于统计新增与去重累积 */
  previous?: readonly ChatMessage[];
  /** 每轮回溯回调（供日志如实记录滚了多少轮） */
  onScrollRound?: (round: number, added: number) => void;
}

const ABORTED: ConversationSnapshot = {
  ok: false,
  reason: "aborted",
  containerSelector: null,
  messages: [],
  newCount: 0,
  moreAbove: false,
  scrollRounds: 0,
  fallbackPoll: false,
};

/**
 * 读取一次会话。**不截图、不观测、不空转**；`loadHistory` 关闭时只读当前视口。
 */
export async function readConversation(
  page: Page,
  options: ReadConversationOptions = {},
): Promise<ConversationSnapshot> {
  const policy = options.policy ?? loadChatSitePolicy();
  const signal = options.signal;
  if (signal?.aborted) return { ...ABORTED };

  const selector = String(options.containerSelector ?? "").trim();
  if (!selector) {
    return {
      ...ABORTED,
      reason: "container_missing",
      messages: [],
    };
  }

  const profile = matchChatSiteProfile(page.url(), policy);
  const outTokens = profile?.outTokens;
  const inTokens = profile?.inTokens;
  const previous = options.previous ?? [];

  const limits = policy.limits;
  const baseArg: ExtractChatArg = {
    selector,
    maxItems: limits.maxMessagesPerRound,
    maxTextChars: 2000,
    scrollTop: null,
  };

  let first: ExtractChatResult;
  try {
    first = await page.evaluate(extractChatItems, baseArg);
  } catch (error) {
    return {
      ...ABORTED,
      reason: `error:${error instanceof Error ? error.message : String(error)}`,
      containerSelector: selector,
    };
  }

  if (!first.ok) {
    return {
      ...ABORTED,
      reason: first.reason,
      containerSelector: selector,
    };
  }

  let merged = mergeLatest(previous, first.items, policy, outTokens, inTokens);
  let messages = merged.messages;
  let newCount = merged.newCount;
  let scrollRounds = 0;
  let moreAbove = first.scrollTop > 4;

  if (options.loadHistory && limits.maxScrollRounds > 0 && moreAbove) {
    const startScrollTop = first.scrollTop;
    let cursor = first.scrollTop;
    const step = Math.max(120, Math.floor(first.clientHeight * 0.9));
    for (let round = 0; round < limits.maxScrollRounds; round += 1) {
      if (signal?.aborted) break;
      const next = Math.max(0, cursor - step);
      if (next >= cursor) break;
      let roundResult: ExtractChatResult;
      try {
        roundResult = await page.evaluate(extractChatItems, { ...baseArg, scrollTop: next });
      } catch {
        break;
      }
      scrollRounds += 1;
      if (roundResult.ok && roundResult.items.length > 0) {
        const older = mergeOlder(messages, roundResult.items, policy, outTokens, inTokens);
        messages = older.messages;
        newCount += older.newCount;
        options.onScrollRound?.(round + 1, older.newCount);
      }
      cursor = next;
      if (next <= 0) break;
    }
    // 读历史不该把用户的视图甩到顶部：读完还原（失败不阻断）
    try {
      await page.evaluate(extractChatItems, { ...baseArg, scrollTop: startScrollTop });
    } catch {
      /* 还原失败不影响快照正确性 */
    }
    moreAbove = cursor > 4;
  }

  return {
    ok: true,
    reason: messages.length === 0 ? "empty" : null,
    containerSelector: selector,
    messages,
    newCount,
    moreAbove,
    scrollRounds,
    fallbackPoll: false,
  };
}
