/**
 * 聊天页通用识别（聊天模式 P1 · 只做「这是不是聊天页」，不做任何 LLM 判断）
 *
 * 设计要点（宪法 §7.2 + §0.4）：
 *   - **零站点硬编码**：站点差异只来自 `config/chat_sites.json`（配置），代码里没有任何域名/CSS 字面量。
 *   - **机读事实在页内、判断在 Node**：页内只做机械测量（重复子结构比例、面积占比、滚动性…），
 *     打分/阈值/三态全部在 Node 侧纯函数里 —— 于是无需浏览器即可单测（`sidecar/tests/chat-mode.mjs`）。
 *   - **三态**：`chat_page | not_chat_page | inconclusive`。分不出来就说分不出来（§0.5.3 A 坑族：
 *     禁止把「没跑成」谎报成结论）。
 *
 * 分层评分（命中即止，低分如实说「不像聊天页」，绝不硬猜）：
 *   ① 显式画像（host 命中 chat_sites.json）
 *   ② 无障碍语义 role="log" / aria-live / role="list"
 *   ③ 重复子结构（≥3 个同签名子节点、且签名不唯一 —— 聊天气泡天然左右两类）
 *   ④ 底部输入 + 邻近发送按钮
 *   ⑤ 站点线索（host/path/标题含会话语义词）
 *   ⑥ 可滚动 + 面积占比
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";

import { readAppEnv } from "../../app_env.js";
import { allHits, normalizeHaystack, termHit } from "../text_match.js";

/** 三态结论（禁止用「未命中」掩盖「没跑成」，见 §0.5.3 A） */
export type ChatPageVerdict = "chat_page" | "not_chat_page" | "inconclusive";

export interface ChatDetectThresholds {
  /** ≥ 此分判为聊天页 */
  chatPage: number;
  /** ≤ 此分判为「不像聊天页」；中间为 inconclusive */
  notChatPage: number;
}

export interface ChatDetectLimits {
  maxContainers: number;
  maxChildrenPerContainer: number;
  maxProbeTextChars: number;
  textSampleChars: number;
  maxMessagesPerRound: number;
  maxScrollRounds: number;
}

/** 站点画像：只做「加分 + 方向消歧」，缺失时启发式必须独立可用 */
export interface ChatSiteProfile {
  id: string;
  hostPattern: RegExp | null;
  outTokens: string[];
  inTokens: string[];
}

export interface ChatSitePolicy {
  chatWords: string[];
  hostWords: string[];
  inputWords: string[];
  sendWords: string[];
  outTokens: string[];
  inTokens: string[];
  thresholds: ChatDetectThresholds;
  limits: ChatDetectLimits;
  sites: ChatSiteProfile[];
}

/* ————————————————————————— 页内机械测量（无判断） ————————————————————————— */

/** 页内采集参数（必须全部由调用方传入：evaluate 内的函数不能引用模块作用域） */
export interface ChatProbeArg {
  maxContainers: number;
  maxChildrenPerContainer: number;
  maxProbeTextChars: number;
  textSampleChars: number;
}

/** 单个候选会话容器的**机械事实**（不含任何打分） */
export interface ChatContainerProbe {
  containerId: number;
  /** 回传用于后续定位的 CSS 路径 */
  selector: string;
  /** 机械预排名的依据（仅用于排序候选，不是「是不是聊天页」的结论） */
  rank: number;
  roleLog: boolean;
  ariaLive: string | null;
  scrollable: boolean;
  areaRatio: number;
  childCount: number;
  /** 出现次数最多的「tag+class 签名」占子节点比例 */
  repeatedSignatureRatio: number;
  /** 不同签名个数（聊天列表天然 ≥2：我方/对方） */
  distinctSignatures: number;
  textChars: number;
  /** 子节点水平中心是否明显左右分居两侧（几何，与站点无关） */
  directionAlternating: boolean;
  /** 容器下方是否有可见输入框 */
  belowHasInput: boolean;
  /** 输入框邻近是否有「发送」语义按钮 */
  sendNearby: boolean;
}

export interface ChatInputProbe {
  tag: string;
  role: string | null;
  contentEditable: boolean;
  placeholder: string;
  ariaLabel: string;
  yRatio: number;
}

/** 一次页内采集的完整结果 */
export interface ChatDomProbe {
  ok: boolean;
  reason: string | null;
  url: string;
  title: string;
  containers: ChatContainerProbe[];
  inputs: ChatInputProbe[];
  textSample: string;
  viewport: { width: number; height: number };
}

/**
 * 页内机械采集（唯一需要浏览器的部分）。
 *
 * 刻意**不做任何打分/结论**：只测「重复比例、面积、滚动、左右分居、下方有没有输入框」。
 * 因此可以随聊天模式换代而无须重算阈值；阈值只在 Node 侧。
 */
export function probeChatDom(arg: ChatProbeArg): ChatDomProbe {
  const empty: ChatDomProbe = {
    ok: false,
    reason: null,
    url: "",
    title: "",
    containers: [],
    inputs: [],
    textSample: "",
    viewport: { width: 0, height: 0 },
  };

  type ProbeItem = ChatContainerProbe;

  try {
    const doc = document;
    const win = window;
    const vw = Math.max(1, win.innerWidth || 1);
    const vh = Math.max(1, win.innerHeight || 1);
    const viewportArea = vw * vh;
    /**
     * 「输入框在容器下方」还要求水平重叠至少这么多。
     * 页内函数会被序列化执行，**不能引用模块作用域常量**，所以这条阈值必须写在这里。
     */
    const COMPOSER_OVERLAP_MIN = 0.25;

    const tokenize = (el: Element): string[] => {
      const raw = (el as HTMLElement).className;
      if (typeof raw !== "string" || !raw) return [];
      return raw.split(/\s+/).filter(Boolean).slice(0, 6);
    };

    const signatureOf = (el: Element): string => {
      const cls = tokenize(el).slice(0, 2).sort().join(".");
      return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
    };

    const escapeIdent = (value: string): string => {
      try {
        return win.CSS && typeof win.CSS.escape === "function" ? win.CSS.escape(value) : value;
      } catch {
        return value;
      }
    };

    /** 回传用 CSS 路径：优先锚定 id / data-testid，否则 nth-of-type 链（≤6 段） */
    const buildSelector = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && depth < 6) {
        const current: Element = node;
        const tag = current.tagName.toLowerCase();
        const id = current.getAttribute("id");
        if (id) {
          parts.unshift(`${tag}#${escapeIdent(id)}`);
          break;
        }
        const testId = current.getAttribute("data-testid");
        if (testId) {
          parts.unshift(`${tag}[data-testid="${testId.replace(/"/g, '\\"')}"]`);
          break;
        }
        let seg = tag;
        const parent: Element | null = current.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
          if (sameTag.length > 1) {
            seg += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
          }
        }
        parts.unshift(seg);
        node = parent;
        depth += 1;
      }
      return parts.join(" > ");
    };

    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = win.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (Number(style.opacity || "1") < 0.05) return false;
      return true;
    };

    /* ——— 输入框（对话页的「下方输入」是强特征） ——— */
    const inputSelector =
      'textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable="true"], [role="textbox"]';
    const inputs: ChatInputProbe[] = [];
    const inputRects: Array<{ top: number; bottom: number; left: number; right: number }> = [];
    const inputCandidates = Array.from(doc.querySelectorAll(inputSelector)).slice(0, 40);
    for (const el of inputCandidates) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height > vh * 0.5) continue;
      const htmlEl = el as HTMLElement;
      inputs.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        contentEditable: htmlEl.isContentEditable === true || el.getAttribute("contenteditable") === "true",
        placeholder: (el.getAttribute("placeholder") ?? "").slice(0, 80),
        ariaLabel: (el.getAttribute("aria-label") ?? "").slice(0, 80),
        yRatio: rect.top / vh,
      });
      inputRects.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
    }

    /* ——— 「发送」语义按钮（图标按钮只能靠 aria/词表，不靠站点选择器） ——— */
    const sendButtons: Array<{ top: number; bottom: number; left: number; right: number }> = [];
    const buttons = Array.from(doc.querySelectorAll('button, [role="button"], input[type="submit"]')).slice(
      0,
      200,
    );
    for (const el of buttons) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > vw * 0.4 || rect.height > vh * 0.3) continue;
      sendButtons.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
    }

    /* ——— 候选容器：优先 role=log / aria-live，其次「够大 + 子节点够多 + 可滚动」 ——— */
    const containers: ProbeItem[] = [];
    const scanned = new Set<Element>();
    const discover = 'div, section, main, article, ul, ol, [role="log"], [aria-live], [role="list"]';
    const candidates = Array.from(doc.querySelectorAll(discover));
    const forced = Array.from(doc.querySelectorAll('[role="log"], [aria-live="polite"], [aria-live="assertive"]'));

    const consider = (el: Element, forcedByA11y: boolean): void => {
      if (scanned.has(el)) return;
      scanned.add(el);
      if (!isVisible(el)) return;

      const rect = el.getBoundingClientRect();
      const areaRatio = (rect.width * rect.height) / viewportArea;
      const children = Array.from(el.children);
      const roleLog = (el.getAttribute("role") ?? "").toLowerCase() === "log";
      const ariaLive = el.getAttribute("aria-live");
      const hasA11yMark = roleLog || Boolean(ariaLive && ariaLive !== "off");

      // 无 a11y 标记的容器必须「够大 + 子节点够多」才有资格，避免把导航菜单当会话
      if (children.length < 3) return;
      if (!forcedByA11y && !hasA11yMark && areaRatio < 0.08) return;

      const counts = new Map<string, number>();
      const centers: number[] = [];
      for (const child of children) {
        const sig = signatureOf(child);
        counts.set(sig, (counts.get(sig) ?? 0) + 1);
        const cr = child.getBoundingClientRect();
        if (cr.width > 0 && rect.width > 0) {
          centers.push((cr.left + cr.width / 2 - rect.left) / rect.width);
        }
      }
      let maxCount = 0;
      for (const n of counts.values()) if (n > maxCount) maxCount = n;
      const childCount = children.length;
      const textChars = Math.min((el.textContent ?? "").length, arg.maxProbeTextChars);

      const leftish = centers.filter((c) => c < 0.42).length;
      const rightish = centers.filter((c) => c > 0.58).length;
      const directionAlternating =
        childCount >= 3 && leftish >= 1 && rightish >= 1 && Math.min(leftish, rightish) / childCount >= 0.15;

      const scrollHeight = (el as HTMLElement).scrollHeight || 0;
      const clientHeight = (el as HTMLElement).clientHeight || 0;

      // 「输入框在容器下方」还必须是**同一栏**（水平重叠够多）。
      // 只按「下方 + 左右不差 40px」判，左侧会话列表也会算成「下方有输入框」——
      // 于是列表栏被当成会话正文，读出来的是整份联系人名单（§0.5.3 H：读数落错栏）。
      const overlapRatio = (r: { left: number; right: number }): number => {
        const overlap = Math.min(r.right, rect.right) - Math.max(r.left, rect.left);
        const narrow = Math.min(r.right - r.left, rect.width);
        return narrow > 0 ? Math.max(0, overlap) / narrow : 0;
      };
      const below = inputRects.filter(
        (r) => r.top >= rect.bottom - Math.max(24, vh * 0.03) && overlapRatio(r) >= COMPOSER_OVERLAP_MIN,
      );
      const belowHasInput = below.length > 0;
      let sendNearby = false;
      if (belowHasInput) {
        const anchor = below[0]!;
        sendNearby = sendButtons.some(
          (b) =>
            b.top < anchor.bottom + 80 &&
            b.bottom > anchor.top - 80 &&
            b.right > anchor.left - 260 &&
            b.left < anchor.right + 260,
        );
      }

      // 机械预排名（只为挑出 Top N 回传，不是「是不是聊天页」的判断）
      const repeatRatio = childCount > 0 ? maxCount / childCount : 0;
      const rank =
        repeatRatio +
        Math.min(1, textChars / 2000) +
        Math.min(1, areaRatio) * 0.8;

      containers.push({
        containerId: -1,
        selector: buildSelector(el),
        rank,
        roleLog,
        ariaLive,
        scrollable: scrollHeight > clientHeight + 4,
        areaRatio,
        childCount,
        repeatedSignatureRatio: repeatRatio,
        distinctSignatures: counts.size,
        textChars,
        directionAlternating,
        belowHasInput,
        sendNearby,
      });
    };

    for (const el of forced) consider(el, true);
    for (const el of candidates) consider(el, false);

    containers.sort((a, b) => b.rank - a.rank);
    const kept = containers.slice(0, Math.max(1, arg.maxContainers));
    kept.forEach((c, i) => {
      c.containerId = i;
    });

    const bodyText = (doc.body?.innerText ?? "").replace(/\s+/g, " ").trim();

    return {
      ok: true,
      reason: null,
      url: String(doc.location?.href ?? ""),
      title: String(doc.title ?? ""),
      containers: kept,
      inputs,
      textSample: bodyText.slice(0, arg.textSampleChars),
      viewport: { width: vw, height: vh },
    };
  } catch (error) {
    return { ...empty, ok: false, reason: error instanceof Error ? error.message : "probe_failed" };
  }
}

/* ————————————————————————— 站点画像与配置加载 ————————————————————————— */

const MAX_PATTERN_LENGTH = 200;

function compilePattern(source: unknown): RegExp | null {
  if (typeof source !== "string") return null;
  const pattern = source.trim();
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_PATTERN_LENGTH);
}

function numberOr(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 内置兜底：配置缺失时聊天模式必须仍可用（§0.5.3 G：绝不静默降级成「不能聊」） */
export const FALLBACK_CHAT_SITE_POLICY: ChatSitePolicy = {
  chatWords: [
    "聊天",
    "消息",
    "会话",
    "发送",
    "已读",
    "正在输入",
    "chat",
    "chats",
    "message",
    "messages",
    "conversation",
    "inbox",
    "typing",
  ],
  hostWords: ["chat", "message", "messenger", "im", "inbox", "direct"],
  inputWords: ["消息", "输入", "发送消息", "说点什么", "type a message", "message"],
  sendWords: ["发送", "送出", "send", "submit"],
  outTokens: ["is-out", "message-out", "outgoing", "sent", "from-me", "self", "own", "mine"],
  inTokens: ["is-in", "message-in", "incoming", "received", "from-them", "theirs"],
  thresholds: { chatPage: 0.55, notChatPage: 0.3 },
  limits: {
    maxContainers: 6,
    maxChildrenPerContainer: 40,
    maxProbeTextChars: 3000,
    textSampleChars: 1200,
    maxMessagesPerRound: 80,
    maxScrollRounds: 5,
  },
  sites: [],
};

let cached: ChatSitePolicy | null = null;

function policyCandidates(): string[] {
  const env = readAppEnv("CHAT_SITES");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../../config/chat_sites.json"));
  out.push(join(here, "../../../../config/chat_sites.json"));
  out.push(join(process.cwd(), "config", "chat_sites.json"));
  out.push(join(process.cwd(), "sidecar", "config", "chat_sites.json"));
  return out;
}

export function resolveChatSitePolicyPath(): string | null {
  for (const candidate of policyCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* 单个候选路径异常不阻断 */
    }
  }
  return null;
}

/** 读配置；缺失/损坏 → 内置兜底（并保留原因供日志说明，不静默假装读到了） */
export function loadChatSitePolicy(): ChatSitePolicy {
  if (cached) return cached;
  const path = resolveChatSitePolicyPath();
  if (!path) {
    cached = FALLBACK_CHAT_SITE_POLICY;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const defaults = (parsed.defaults ?? {}) as Record<string, unknown>;
    const rawThresholds = (defaults.thresholds ?? {}) as Record<string, unknown>;
    const rawLimits = (defaults.limits ?? {}) as Record<string, unknown>;
    const base = FALLBACK_CHAT_SITE_POLICY;

    const sites: ChatSiteProfile[] = [];
    const rawSites = Array.isArray(parsed.sites) ? parsed.sites : [];
    for (const item of rawSites) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const id = String(entry.id ?? "").trim();
      const hostPattern = compilePattern(entry.hostPattern);
      if (!id || !hostPattern) continue;
      sites.push({
        id,
        hostPattern,
        outTokens: stringList(entry.outTokens),
        inTokens: stringList(entry.inTokens),
      });
    }

    const pick = (key: string, fallback: string[]): string[] => {
      const list = stringList(defaults[key]);
      return list.length > 0 ? list : fallback;
    };

    cached = {
      chatWords: pick("chatWords", base.chatWords),
      hostWords: pick("hostWords", base.hostWords),
      inputWords: pick("inputWords", base.inputWords),
      sendWords: pick("sendWords", base.sendWords),
      outTokens: pick("outTokens", base.outTokens),
      inTokens: pick("inTokens", base.inTokens),
      thresholds: {
        chatPage: numberOr(rawThresholds.chatPage, base.thresholds.chatPage),
        notChatPage: numberOr(rawThresholds.notChatPage, base.thresholds.notChatPage),
      },
      limits: {
        maxContainers: Math.max(1, Math.trunc(numberOr(rawLimits.maxContainers, base.limits.maxContainers))),
        maxChildrenPerContainer: Math.max(
          1,
          Math.trunc(numberOr(rawLimits.maxChildrenPerContainer, base.limits.maxChildrenPerContainer)),
        ),
        maxProbeTextChars: Math.max(
          200,
          Math.trunc(numberOr(rawLimits.maxProbeTextChars, base.limits.maxProbeTextChars)),
        ),
        textSampleChars: Math.max(
          200,
          Math.trunc(numberOr(rawLimits.textSampleChars, base.limits.textSampleChars)),
        ),
        maxMessagesPerRound: Math.max(
          1,
          Math.trunc(numberOr(rawLimits.maxMessagesPerRound, base.limits.maxMessagesPerRound)),
        ),
        maxScrollRounds: Math.max(0, Math.trunc(numberOr(rawLimits.maxScrollRounds, base.limits.maxScrollRounds))),
      },
      sites,
    };
    return cached;
  } catch {
    cached = FALLBACK_CHAT_SITE_POLICY;
    return cached;
  }
}

/** 按 URL 找站点画像（host 命中）；不修改 hostWords 等通用词表，只用于加分与方向消歧 */
export function matchChatSiteProfile(
  url: string,
  policy: ChatSitePolicy = loadChatSitePolicy(),
): ChatSiteProfile | null {
  let host = "";
  try {
    host = new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  for (const site of policy.sites) {
    if (site.hostPattern && site.hostPattern.test(host)) return site;
  }
  return null;
}

/**
 * 会被丢掉的「非站点词」：常见子域前缀 + 常见顶级域。
 * 与 `chat_actions.ts::hostTokenOf` 同一份判别口径（那里只用于识别「标题只是站点名」）。
 */
const SITE_KEY_STOPWORDS = new Set([
  // 子域前缀
  "www",
  "web",
  "webapp",
  "m",
  "mobile",
  "app",
  "chat",
  "chats",
  "im",
  "messenger",
  "c",
  // 顶级域 / 二级公共后缀
  "com",
  "org",
  "net",
  "edu",
  "gov",
  "io",
  "app",
  "co",
  "me",
  "cn",
  "uk",
  "us",
  "jp",
  "de",
  "fr",
  "ru",
  "info",
  "biz",
  "xyz",
  "online",
  "site",
  "top",
  "dev",
  "tv",
]);

/**
 * **站点键**（上下文目录的第一段：`chat_context/{site}/{contact}/`）。
 *
 * 优先用站点画像 id（配置里显式声明的站点身份，最稳）；没有画像时**从 URL 派生**。
 *
 * 为什么必须派生（§0.5.3 H「拿 `unknown` 当站点键」）：以前一律写死 `unknown`，
 * 于是同一个昵称在两个站点会撞进**同一个目录**（`unknown/Anne`），两段对话的记忆互相覆盖；
 * 而站点画像又永远命中不上那个 `unknown`，被当成「没画像的站」。
 *
 * 派生规则刻意保守：去掉子域前缀与公共后缀，取剩下的**最后一段**（registrable label），
 * 只保留 `[a-z0-9]`；取不到就返回 `unknown`（宁可回到老口径，也不编一个假站点键）。
 * 纯函数：同输入必得同输出，无需浏览器即可单测。
 */
export function siteKeyOf(url: string, profileId?: string | null): string {
  const explicit = String(profileId ?? "").trim();
  if (explicit && explicit !== "unknown") return explicit;
  let host = "";
  try {
    host = new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (!host || host === "localhost") return "unknown";
  const parts = host.split(".").filter(Boolean);
  const kept = parts.filter((part) => !SITE_KEY_STOPWORDS.has(part));
  const token = (kept[kept.length - 1] ?? parts[0] ?? "").replace(/[^a-z0-9]/g, "");
  return token.length >= 2 ? token : "unknown";
}

/* ————————————————————————— 纯打分（可单测） ————————————————————————— */

export interface ChatDetectResult {
  verdict: ChatPageVerdict;
  confidence: number;
  evidence: string[];
  containerId: number | null;
  containerSelector: string | null;
  profileId: string | null;
  /** 探针本身失败（页面崩了等）——与「跑完了但不像聊天页」严格区分 */
  probeFailed: boolean;
}

const PROFILE_BONUS = 0.18;
const ROLE_LOG_BONUS = 0.2;
const ARIA_LIVE_BONUS = 0.1;
const REPEAT_STRONG_BONUS = 0.2;
const REPEAT_WEAK_BONUS = 0.12;
const DIRECTION_BONUS = 0.1;
const INPUT_BONUS = 0.16;
const SEND_BONUS = 0.06;
const SCROLL_BONUS = 0.05;
const CUES_BONUS = 0.1;
const INPUT_WORDS_BONUS = 0.06;
const TEXT_VOLUME_BONUS = 0.05;

/**
 * 主判定（纯函数：同输入必得同输出；无 I/O、无时间、无随机）。
 *
 * **容器相关的那部分分要在候选之间比一遍**（不能只认页内预排名第一）。
 * 预排名按「重复子结构 + 文本量 + 面积」排，左侧**会话列表**天然比会话正文更符合这三条：
 * 列表项一堆同签名子节点、文本量大、面积也不小 —— 只认第一就会把列表栏当成会话正文，
 * 于是「读到」的是整份联系人名单（§0.5.3 H：读数落错栏）。这里是**判断**（谁像会话正文），
 * 所以必须留在 Node 侧：方向分居、可滚动面积、下方同栏输入框都在容器上，比一比就知道谁是真会话。
 */
export function scoreChatPage(
  probe: ChatDomProbe,
  policy: ChatSitePolicy = loadChatSitePolicy(),
): ChatDetectResult {
  const profile = matchChatSiteProfile(probe.url, policy);
  const base: Omit<ChatDetectResult, "verdict" | "confidence" | "evidence"> = {
    containerId: null,
    containerSelector: null,
    profileId: profile?.id ?? null,
    probeFailed: !probe.ok,
  };

  if (!probe.ok) {
    return {
      ...base,
      verdict: "inconclusive",
      confidence: 0,
      evidence: [`页内采集失败：${probe.reason ?? "未知原因"}`],
    };
  }

  /** 只算「容器相关」的分与证据（站点画像/语义词是页面级常量，不影响挑容器） */
  const scoreOfContainer = (container: ChatContainerProbe): { score: number; evidence: string[] } => {
    const lines: string[] = [];
    let sum = 0;

    /* ② 无障碍语义 */
    if (container.roleLog) {
      sum += ROLE_LOG_BONUS;
      lines.push("容器 role=log（MDN 定义即聊天记录）");
    } else if (container.ariaLive && container.ariaLive !== "off") {
      sum += ARIA_LIVE_BONUS;
      lines.push(`容器 aria-live=${container.ariaLive}`);
    }

    /* ③ 重复子结构（要求签名不唯一：聊天天然是我方/对方两类） */
    if (container.repeatedSignatureRatio >= 0.6 && container.distinctSignatures >= 2 && container.childCount >= 3) {
      sum += REPEAT_STRONG_BONUS;
      lines.push(
        `重复子结构 ${Math.round(container.repeatedSignatureRatio * 100)}%（${container.distinctSignatures} 类签名）`,
      );
    } else if (container.repeatedSignatureRatio >= 0.4 && container.childCount >= 3) {
      sum += REPEAT_WEAK_BONUS;
      lines.push(`弱重复子结构 ${Math.round(container.repeatedSignatureRatio * 100)}%`);
    }

    if (container.directionAlternating) {
      sum += DIRECTION_BONUS;
      lines.push("子节点水平分居两侧（我方/对方）");
    }

    /* ④ 底部输入 + 邻近发送 */
    if (container.belowHasInput) {
      sum += INPUT_BONUS;
      lines.push("会话容器下方存在输入框（同栏）");
    }
    if (container.sendNearby) {
      sum += SEND_BONUS;
      lines.push("输入框邻近存在发送语义按钮");
    }

    /* ⑥ 可滚动 + 面积 */
    if (container.scrollable && container.areaRatio >= 0.15) {
      sum += SCROLL_BONUS;
      lines.push("大面积可滚动容器");
    }
    if (container.textChars >= 200) {
      sum += TEXT_VOLUME_BONUS;
      lines.push(`会话文本量 ${container.textChars} 字`);
    }

    return { score: sum, evidence: lines };
  };

  // 候选之间取最高分；同分保留页内顺序（预排名在前的胜出，行为确定）
  let container: ChatContainerProbe | null = null;
  let containerScore = Number.NEGATIVE_INFINITY;
  let containerEvidence: string[] = ["页面未发现候选会话容器"];
  for (const candidate of probe.containers) {
    const scored = scoreOfContainer(candidate);
    if (scored.score > containerScore) {
      container = candidate;
      containerScore = scored.score;
      containerEvidence = scored.evidence;
    }
  }
  if (!container) {
    containerScore = 0;
    containerEvidence = ["页面未发现候选会话容器"];
  }

  const evidence: string[] = [];
  let score = 0;

  /* ① 显式画像 */
  if (profile) {
    score += PROFILE_BONUS;
    evidence.push(`命中站点画像 ${profile.id}`);
  }

  score += containerScore;
  evidence.push(...containerEvidence);

  /* ⑤ 站点线索 */
  const haystack = normalizeHaystack(`${probe.url} ${probe.title} ${probe.textSample.slice(0, 600)}`);
  const cueHits = allHits(haystack, policy.chatWords, 3);
  if (cueHits.length > 0) {
    score += CUES_BONUS;
    evidence.push(`页面含会话语义词：${cueHits.join("、")}`);
  }
  const inputHintText = probe.inputs.map((i) => `${i.placeholder} ${i.ariaLabel}`).join(" ");
  if (inputHintText.trim() && firstTermHit(normalizeHaystack(inputHintText), policy.inputWords)) {
    score += INPUT_WORDS_BONUS;
    evidence.push("输入框占位符含会话语义");
  }

  const confidence = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  const verdict: ChatPageVerdict =
    confidence >= policy.thresholds.chatPage
      ? "chat_page"
      : confidence <= policy.thresholds.notChatPage
        ? "not_chat_page"
        : "inconclusive";

  return {
    ...base,
    verdict,
    confidence,
    evidence:
      verdict === "not_chat_page"
        ? [...evidence, `总分 ${confidence} 低于阈值 ${policy.thresholds.notChatPage}：当前页面不像聊天页`]
        : evidence,
    containerId: container?.containerId ?? null,
    containerSelector: container?.selector ?? null,
  };
}

function firstTermHit(haystack: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    if (termHit(haystack, term)) return term;
  }
  return null;
}

/** `inconclusive` 值得继续尝试读取（用户已指定联系人时），`not_chat_page` 不值得 */
export function shouldAttemptExtraction(result: ChatDetectResult): boolean {
  return result.verdict !== "not_chat_page";
}

/* ————————————————————————— 「站点完全打开了吗」（三态，可单测） ————————————————————————— */

/**
 * 就绪探测的一次采样（全是机械事实，判断在 {@link decideChatReady}）。
 *
 * 为什么要这道门（§0.5.3 H）：`openContact` 只保证「导航已发出」。托管型聊天应用首屏之后
 * 还要好几秒才渲染出会话容器与输入框；没等就开跑，会读到空会话、把「还没加载」当成
 * 「对方什么都没说」，然后照自己臆想发一条 —— 用户看到的就是「网站还没打开就结束了」。
 */
export interface ChatReadyProbe {
  /** 站点识别的三态结论 */
  verdict: ChatPageVerdict;
  /** 会话容器已定位到（且当前可见） */
  hasContainer: boolean;
  /** 聊天输入框已可用 */
  hasComposer: boolean;
  /** `document.readyState === "complete"` */
  htmlLoaded: boolean;
  /** 连续两次采样的会话规模一致（不在「还在长」的过程中） */
  stable: boolean;
  /** 已等待毫秒数 */
  waitedMs: number;
  /** 等待预算毫秒数 */
  timeoutMs: number;
}

export type ChatReadyState = "ready" | "pending" | "blocked" | "timeout";

/**
 * 「不是聊天页」这条**结论**的最短观察窗（毫秒）。
 *
 * 为什么必须有这道窗（§0.5.3 A）：调用方常在**刚发完导航**的那一刻就采样，此时托管型
 * 聊天应用（SPA 首屏之后才注入会话容器）还在渲染 —— 打分只剩站点画像那一点加分，
 * 于是被判成 `not_chat_page`。那不是「页面不是聊天页」，而是「页面还没跑起来」；
 * 拿它当结论，现场表现就是「打开会话（not_chat_page）→ 一秒后整片结束」。
 *
 * 因此：`not_chat_page` 只有在**页面已加载完**且观察满这个窗口之后才算数；
 * 窗口内一律 `pending`（继续看；真等不到就走 `timeout`，如实说「未就绪」而不是谎报
 * 「不是聊天页」）。
 */
export const CHAT_BLOCK_CONFIRM_MS = 6_000;

export interface ChatReadyDecision {
  state: ChatReadyState;
  /** 人话原因（进日志/视图；不许只给布尔） */
  reason: string;
}

function pendingOrTimeout(
  probe: ChatReadyProbe,
  pendingReason: string,
  timeoutReason: string,
): ChatReadyDecision {
  if (probe.waitedMs >= probe.timeoutMs) {
    return { state: "timeout", reason: `${timeoutReason}（已等 ${Math.round(probe.waitedMs / 1000)}s）` };
  }
  return { state: "pending", reason: pendingReason };
}

/**
 * 判定「站点是否完全打开」。**fail-closed**：分不出来就说 `timeout`（调用方据此不读不说），
 * 绝不把「没跑完的判定」当成「已经就绪」（§0.5.3 A）。
 */
export function decideChatReady(probe: ChatReadyProbe): ChatReadyDecision {
  if (probe.verdict === "not_chat_page") {
    // 先把「还没加载完 / 还没看够」与「真的不是聊天页」分开（§0.5.3 A）
    if (!probe.htmlLoaded) {
      return pendingOrTimeout(probe, "页面尚未完成加载（暂不判定是不是聊天页）", "页面加载未完成");
    }
    if (probe.waitedMs < CHAT_BLOCK_CONFIRM_MS) {
      return pendingOrTimeout(
        probe,
        `疑似不是聊天页，再看 ${Math.max(1, Math.round((CHAT_BLOCK_CONFIRM_MS - probe.waitedMs) / 1000))}s 再判`,
        "页面一直不像聊天页",
      );
    }
    // 明确不是聊天页：等下去也不会变好，交人工（不要让用户对着「重试」空等）
    return { state: "blocked", reason: "站点识别判定当前页面不是聊天页（可能是登录页/首页/错链）" };
  }
  if (!probe.htmlLoaded) {
    return pendingOrTimeout(probe, "页面尚未完成加载", "页面加载未完成");
  }
  if (!probe.hasContainer) {
    return pendingOrTimeout(probe, "等待会话容器出现", "会话容器一直没出现");
  }
  if (!probe.hasComposer) {
    return pendingOrTimeout(probe, "等待聊天输入框出现", "聊天输入框一直没出现");
  }
  if (!probe.stable) {
    return pendingOrTimeout(probe, "页面仍在渲染（会话规模还在变化）", "页面一直在渲染，未能稳定");
  }
  return { state: "ready", reason: "会话容器与输入框就绪，且渲染已稳定" };
}

/* ————————————————————————— 浏览器入口 ————————————————————————— */

export interface DetectChatPageOptions {
  policy?: ChatSitePolicy;
  signal?: AbortSignal;
}

/**
 * 在真实页面上执行一次识别。**不做截图、不做全量观测**（§5 静音运行）。
 */
export async function detectChatPage(
  page: Page,
  options: DetectChatPageOptions = {},
): Promise<ChatDetectResult> {
  const policy = options.policy ?? loadChatSitePolicy();
  if (options.signal?.aborted) {
    return {
      verdict: "inconclusive",
      confidence: 0,
      evidence: ["已取消"],
      containerId: null,
      containerSelector: null,
      profileId: null,
      probeFailed: true,
    };
  }
  let probe: ChatDomProbe;
  try {
    probe = await page.evaluate(probeChatDom, {
      maxContainers: policy.limits.maxContainers,
      maxChildrenPerContainer: policy.limits.maxChildrenPerContainer,
      maxProbeTextChars: policy.limits.maxProbeTextChars,
      textSampleChars: policy.limits.textSampleChars,
    });
  } catch (error) {
    return {
      verdict: "inconclusive",
      confidence: 0,
      evidence: [`页内采集抛错：${error instanceof Error ? error.message : String(error)}`],
      containerId: null,
      containerSelector: null,
      profileId: null,
      probeFailed: true,
    };
  }
  return scoreChatPage(probe, policy);
}
