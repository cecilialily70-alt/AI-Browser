/**
 * 聊天模式的**页面原语**（§0.4 允许的「底层原语」：`resolveGateway` / CDP page / `readConversation`）。
 *
 * 这里只做确定性的小事，不含任何决策、不含任何模型调用：
 *   1. `ensureChatPage`  —— 复用**已打开的聊天站页**（绝不 newPage）
 *   2. `openContact`     —— 先认当前对话头，已是目标则跳过；否则同窗点列表切换
 *   3. `readThread` / `sendChatText` / `isTextInThread` / `waitThreadActivity`
 *
 * 纪律：不产生截图 / 全景 / SoM / a11y / digest / 影子模型（§5）。
 */
import type { Browser, BrowserContext, Page } from "playwright-core";

import { resolveGateway } from "../core/action_gateway.js";
import {
  normalizeComposerText,
  verifyComposerWrite,
} from "../core/web_chat/descriptor/composer.js";
import {
  builtinConnectorDirs,
  loadDescriptorDirs,
  pickDescriptor,
} from "../core/web_chat/descriptor/registry.js";
import {
  readConversation,
  type ChatMessage,
  type ConversationSnapshot,
} from "../core/web_chat/conversation_extract.js";
import { hashText, looksLikeOwnSentText } from "../core/web_chat/outbox.js";
import { hash32Id } from "../core/hash32.js";
import {
  decideChatReady,
  detectChatPage,
  loadChatSitePolicy,
  matchChatSiteProfile,
  siteKeyOf,
  type ChatPageVerdict,
  type ChatSitePolicy,
} from "../core/web_chat/site_detect.js";
import { contactsMatch, digitsOfContact } from "./contact_identity.js";
import {
  readChatSliceSize,
  waitForChatActivity,
  type ChatActivityResult,
} from "../core/web_chat/wait.js";

export { contactsMatch, digitsOfContact } from "./contact_identity.js";

/** 没有已打开的聊天站页时抛出（调用方应提示用户先打开 WhatsApp / Telegram 等） */
export class NoOpenChatPageError extends Error {
  readonly code = "no_open_chat_page" as const;
  constructor(message = "no_open_chat_page") {
    super(message);
    this.name = "NoOpenChatPageError";
  }
}

/** 描述符缺失时的对话头选择器兜底（WhatsApp / Telegram 常见） */
const DEFAULT_PEER_HEADER_SELECTORS = [
  '#main header [data-testid="conversation-info-header-chat-title"]',
  "#main header span[title]",
  "#main header [title]",
  "#MiddleColumn .peer-title",
  "#MiddleColumn .ChatInfo .title",
  "#column-center .peer-title",
  "#column-center .chat-info .peer-title",
] as const;

/* ————————————————————————— 1. 聊天专用标签 ————————————————————————— */

/** 每个环境一个聊天标签；存在 WeakMap 里，进程重启即重新开一个（不落盘） */
const chatTabs = new WeakMap<BrowserContext, Page>();

/** 页内标记：证明这个标签是我们自己开的，用户标签不会有这个标记 */
const CHAT_TAB_FLAG = "__tst_chat_tab";

export interface EnsureChatPageResult {
  page: Page;
  /** 是否新建了标签（false = 复用/认领了已有的聊天标签） */
  created: boolean;
  /** 认领了一个**上次进程留下的**聊天标签（跨 sidecar 重启的复用，见 {@link findOwnChatTab}） */
  adopted: boolean;
}

/**
 * 给标签打上「这是我们开的」标记。
 *
 * 为什么必须用 `page.addInitScript`（页级初始化脚本）而不是一次 `evaluate`：
 * `evaluate` 写下的标记只活在**当前文档**里，页面一导航（`page.goto` 到某个会话）就没了 ——
 * 于是我们认不出自己的标签。现场后果有两个：
 *   ① `resolveCurrentConversation` 排除不掉自己，可能绑到我们自开的标签上；
 *   ② sidecar 重启后无法认领上次留下的标签，只能**再开一个**（用户看到「每次都开一个新窗口」，
 *      同一账号的标签越堆越多）。
 * 页级 initScript 只对本标签生效（不同于 context 级，不会把用户自己的标签也标记成我们的）。
 */
async function markOwnChatTab(page: Page): Promise<void> {
  await page
    .addInitScript((flag: string) => {
      (window as unknown as Record<string, unknown>)[flag] = true;
    }, CHAT_TAB_FLAG)
    .catch(() => {
      /* 标签可能已销毁：不影响使用，最坏只是认不出它 */
    });
  // initScript 只对**之后**的文档生效，当前这份也顺手打上（新页此刻是 about:blank）
  await page
    .evaluate((flag: string) => {
      (window as unknown as Record<string, unknown>)[flag] = true;
    }, CHAT_TAB_FLAG)
    .catch(() => {
      /* 同上 */
    });
}

/**
 * 在本环境的 context 里找回「我们自己开的、还活着的」聊天标签。
 *
 * 场景（§0.5.3 H「每次都开一个新窗口」）：sidecar 重启（看门狗 T2 / 应用重开 / 手动收工）
 * 后内存缓存（{@link chatTabs}）会丢，但标签还开着。不认它就会**每片新开一个** ——
 * 用户浏览器里堆一排我们开的页，而目标往往都是**同一个账号**里的不同会话。
 * 只认带标记的标签（用户手开的页没有标记），因此绝不会认领用户的窗口。
 */
export async function findOwnChatTab(context: BrowserContext): Promise<Page | null> {
  let pages: Page[];
  try {
    pages = context.pages();
  } catch {
    return null;
  }
  for (const page of pages) {
    try {
      if (page.isClosed()) continue;
    } catch {
      continue;
    }
    if (await isOwnChatTab(page)) return page;
  }
  return null;
}

/**
 * 在本环境里找**已经打开的聊天站点页**（WhatsApp / Telegram 等）。
 *
 * 切换会话只应在同一窗口里点列表项；有站点页却再 `newPage()` 会开出 about:blank，
 * WhatsApp 单窗模型下必然打不开会话（用户现场）。
 */
export async function findChatSitePage(
  context: BrowserContext,
  policy: ChatSitePolicy = loadChatSitePolicy(),
): Promise<Page | null> {
  let pages: Page[];
  try {
    pages = context.pages();
  } catch {
    return null;
  }
  let best: Page | null = null;
  for (const page of pages) {
    try {
      if (page.isClosed()) continue;
      const url = page.url();
      if (!url || url === "about:blank" || !/^https?:/i.test(url)) continue;
      if (matchChatSiteProfile(url, policy)) best = page;
    } catch {
      /* 单个页失败继续扫 */
    }
  }
  return best;
}

/**
 * 取得聊天页：只复用已开着的聊天站点窗口，**永不 newPage**。
 *
 * 顺序：进程内缓存 → 自开标记页 → 已打开的聊天站点页 → 抛 {@link NoOpenChatPageError}。
 * 切换联系人只在该窗内点列表（见 {@link openContact}）。
 */
export async function ensureChatPage(context: BrowserContext): Promise<EnsureChatPageResult> {
  const cached = chatTabs.get(context);
  if (cached) {
    try {
      if (!cached.isClosed()) {
        const url = safeUrl(cached);
        if (url && url !== "about:blank") {
          return { page: cached, created: false, adopted: false };
        }
      }
    } catch {
      /* 已销毁，落到下面认领 */
    }
  }

  const own = await findOwnChatTab(context);
  if (own) {
    chatTabs.set(context, own);
    return { page: own, created: false, adopted: true };
  }

  const sitePage = await findChatSitePage(context);
  if (sitePage) {
    chatTabs.set(context, sitePage);
    return { page: sitePage, created: false, adopted: true };
  }

  throw new NoOpenChatPageError(
    "no_open_chat_page: 请先在浏览器里打开目标站点的聊天页面（不会另开新标签）",
  );
}

/** 关掉聊天标签（`chat_stop` 时调用；**只关我们自己开的**，绝不关用户的 WhatsApp/Telegram 窗） */
export async function closeChatPage(context: BrowserContext): Promise<boolean> {
  const page = chatTabs.get(context);
  chatTabs.delete(context);
  if (!page) return false;
  try {
    if (page.isClosed()) return false;
    // 认领的用户聊天站页没有 own 标记 → 只解除绑定，不关页
    if (!(await isOwnChatTab(page))) return false;
    await page.close();
    return true;
  } catch {
    /* ignore */
  }
  return false;
}

/* ————————————————————————— 2. 定位联系人会话 ————————————————————————— */

export interface OpenContactResult {
  ok: boolean;
  reason: string | null;
  containerSelector: string | null;
  /** 是否需要导航（false = 已经在目标会话上） */
  navigated: boolean;
}

/**
 * 打开某个联系人的会话。
 *
 * 产品纪律：
 *   1. 永不 newPage；只在当前聊天窗里点列表切换。
 *   2. 先读对话头：已是目标人 → **跳过点击**。
 *   3. 当前是别人 → 点列表打开目标；点完再读头校验。
 * WhatsApp 无会话直链 → 必须点；有 hash 直链时点击失败再同标签导航兜底。
 */
export async function openContact(
  page: Page,
  contact: { label: string; url: string | null; containerSelector?: string | null },
  policy: ChatSitePolicy = loadChatSitePolicy(),
  signal?: AbortSignal,
): Promise<OpenContactResult> {
  if (signal?.aborted) {
    return { ok: false, reason: "aborted", containerSelector: null, navigated: false };
  }

  const targetLabel = String(contact.label ?? "").trim();
  const targetUrl = String(contact.url ?? "").trim();
  const current = safeUrl(page);

  // ① 已打开且就是目标 → 不点
  const openLabel = await readOpenConversationLabel(page);
  if (targetLabel && openLabel && contactsMatch(openLabel, targetLabel)) {
    const detected = await detectChatPage(page, { policy, signal });
    return {
      ok: true,
      reason: null,
      containerSelector: detected.containerSelector ?? contact.containerSelector ?? null,
      navigated: false,
    };
  }
  if (targetUrl && normalizeUrl(current) === normalizeUrl(targetUrl) && openLabel) {
    // URL 已对齐且有对话头：若还有目标名，必须名字也对得上（SPA 同 URL 不同会话）
    if (!targetLabel || contactsMatch(openLabel, targetLabel)) {
      const detected = await detectChatPage(page, { policy, signal });
      return {
        ok: true,
        reason: null,
        containerSelector: detected.containerSelector ?? contact.containerSelector ?? null,
        navigated: false,
      };
    }
  }

  let navigated = false;
  const preferClick = shouldOpenByListClick(current, targetUrl, targetLabel, policy);

  if (preferClick) {
    const clicked = await clickContactInList(page, targetLabel);
    if (clicked) {
      await settle(page);
      navigated = true;
      const after = await readOpenConversationLabel(page);
      if (targetLabel && after && !contactsMatch(after, targetLabel)) {
        // 点了但头还是别人 → 再试 URL 兜底；否则如实失败
        if (!targetUrl) {
          return {
            ok: false,
            reason: "list_click_opened_wrong_contact",
            containerSelector: null,
            navigated: true,
          };
        }
      } else if (targetLabel && after && contactsMatch(after, targetLabel)) {
        const detected = await detectChatPage(page, { policy, signal });
        return {
          ok: true,
          reason: null,
          containerSelector: detected.containerSelector ?? contact.containerSelector ?? null,
          navigated: true,
        };
      }
    } else if (!targetUrl) {
      return {
        ok: false,
        reason: "contact_url_missing_and_not_found_in_list",
        containerSelector: null,
        navigated: false,
      };
    }
  }


  if (!navigated && targetUrl) {
    if (normalizeUrl(safeUrl(page)) !== normalizeUrl(targetUrl)) {
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        navigated = true;
      } catch (error) {
        if (!(await switchSameDocument(page, safeUrl(page), targetUrl))) {
          return {
            ok: false,
            reason: `navigate_failed:${error instanceof Error ? error.message : String(error)}`,
            containerSelector: null,
            navigated: false,
          };
        }
        navigated = true;
      }
      await settle(page);
    }
  } else if (!navigated && !targetUrl) {
    return {
      ok: false,
      reason: "contact_url_missing_and_not_found_in_list",
      containerSelector: null,
      navigated: false,
    };
  }

  if (signal?.aborted) {
    return { ok: false, reason: "aborted", containerSelector: null, navigated };
  }

  // 有目标名时必须核对对话头：读不到 / 对不上 → 失败（禁止「以为打开了」却发到当前窗里的别人）
  if (targetLabel) {
    const verified = await verifyOpenContact(page, targetLabel, { retries: 5, gapMs: 350 });
    if (!verified.ok) {
      return {
        ok: false,
        reason: verified.reason ?? "opened_contact_mismatch",
        containerSelector: null,
        navigated,
      };
    }
  }

  const detected = await detectChatPage(page, { policy, signal });
  return {
    ok: true,
    reason: null,
    containerSelector: detected.containerSelector ?? contact.containerSelector ?? null,
    navigated,
  };
}

export interface VerifyOpenContactResult {
  ok: boolean;
  reason: string | null;
  /** 当前对话头（脱敏排查用；可能为空） */
  openLabel: string | null;
}

/**
 * 核对「当前打开的会话」是否就是目标人（发消息前必跑）。
 * 读不到头或对不上 → fail-closed，绝不往当前窗硬发。
 */
export async function verifyOpenContact(
  page: Page,
  targetLabel: string,
  options: { retries?: number; gapMs?: number } = {},
): Promise<VerifyOpenContactResult> {
  const needle = String(targetLabel ?? "").trim();
  if (!needle) {
    return { ok: true, reason: null, openLabel: null };
  }
  const retries = Math.max(1, Math.min(10, Math.trunc(options.retries ?? 3)));
  const gapMs = Math.max(0, Math.min(2_000, Math.trunc(options.gapMs ?? 300)));
  let openLabel: string | null = null;
  for (let i = 0; i < retries; i += 1) {
    openLabel = await readOpenConversationLabel(page);
    if (openLabel && contactsMatch(openLabel, needle)) {
      return { ok: true, reason: null, openLabel };
    }
    if (openLabel && !contactsMatch(openLabel, needle)) {
      return { ok: false, reason: "wrong_conversation_open", openLabel };
    }
    if (i + 1 < retries && gapMs > 0) {
      await page.waitForTimeout(gapMs).catch(() => undefined);
    }
  }
  return {
    ok: false,
    reason: openLabel ? "wrong_conversation_open" : "conversation_header_missing",
    openLabel,
  };
}

/**
 * 读当前已打开对话的展示名（中间栏标题）。
 * 无对话窗（只有列表）→ null。
 */
export async function readOpenConversationLabel(page: Page): Promise<string | null> {
  const selectors = await peerHeaderSelectorsOf(page);
  if (selectors.length === 0) return null;
  try {
    const label = await page.evaluate((sels: string[]) => {
      for (const sel of sels) {
        let nodes: NodeListOf<Element>;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const el of nodes) {
          const titled = (el.getAttribute("title") || "").trim();
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          const value = titled || text;
          if (value) return value.slice(0, 120);
        }
      }
      return null;
    }, selectors);
    return label && String(label).trim() ? String(label).trim() : null;
  } catch {
    return null;
  }
}

async function peerHeaderSelectorsOf(page: Page): Promise<string[]> {
  const url = safeUrl(page);
  if (url && url !== "about:blank") {
    try {
      const hit = pickDescriptor(cachedBuiltinDescriptors(), url, {});
      const headers = hit?.descriptor.peer?.fallbackHeader?.selectors;
      if (headers && headers.length > 0) return [...headers];
    } catch {
      /* 描述符加载失败 → 用兜底 */
    }
  }
  return [...DEFAULT_PEER_HEADER_SELECTORS];
}

let builtinDescriptorCache: ReturnType<typeof loadDescriptorDirs>["descriptors"] | null = null;
function cachedBuiltinDescriptors() {
  if (!builtinDescriptorCache) {
    builtinDescriptorCache = loadDescriptorDirs({
      builtinDirs: builtinConnectorDirs(),
      learnedDirs: [],
    }).descriptors;
  }
  return builtinDescriptorCache;
}

/** 同站点切换优先点列表；about:blank 上点不到，交给导航。 */
function shouldOpenByListClick(
  currentUrl: string,
  targetUrl: string,
  label: string,
  policy: ChatSitePolicy,
): boolean {
  if (!String(label ?? "").trim()) return false;
  if (!targetUrl) return true;
  try {
    const current = String(currentUrl ?? "").trim();
    if (!current || current === "about:blank") return false;
    const cur = new URL(current);
    const tgt = new URL(targetUrl);
    if (cur.origin !== tgt.origin) return false;
    if (matchChatSiteProfile(current, policy) || matchChatSiteProfile(targetUrl, policy)) {
      return true;
    }
    return normalizeUrl(current) === normalizeUrl(targetUrl);
  } catch {
    return true;
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/** URL 归一化比较：忽略末尾斜杠与常见无关查询参数差异 */
/**
 * URL 归一化比较：忽略末尾斜杠差异，**但绝不丢 hash**。
 *
 * 为什么 hash 必须参与比较（现场坑，§0.5.3 H）：同一账号里的不同会话在 SPA 上常常
 * **只有 hash 不同**（`web.telegram.org/k/#@Alyssa` vs `#@Bob`，即用户说的「联系都是
 * 一个账户里面的」）。丢了 hash 这两者就相等 → `openContact` 会**跳过导航**，
 * 于是我们以为切到了 Bob，实际上还在 Alyssa 的会话里 —— 读错人、**发错人**。
 * 保留 hash 后，这类切换会走一次同文档导航（hashchange），SPA 自己就会切会话。
 */
function normalizeUrl(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}${
      url.hash && url.hash !== "#" ? url.hash : ""
    }`;
  } catch {
    return text.replace(/\/+$/, "");
  }
}

async function settle(page: Page): Promise<void> {
  // 短等待让 SPA 完成首屏渲染；不做轮询轰炸，超时就继续（后面读取会如实报告）
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
}

/**
 * 同一个文档内的会话切换（只差 hash 的 URL）——交给页面自己路由。
 *
 * 只做一件事：把目标 URL 的 hash 交给 `location`。语义与「用户点了会话列表里的那一行」
 * **完全相同**（站点本来就靠 hashchange 切会话），不是注入绕过脚本、也不改指纹。
 * 失败返回 false，由调用方按 `navigate_failed` 如实上报（不假装切成功）。
 */
async function switchSameDocument(page: Page, current: string, target: string): Promise<boolean> {
  try {
    const from = new URL(current);
    const to = new URL(target);
    if (from.origin !== to.origin || from.pathname !== to.pathname || !to.hash) return false;
    await page.evaluate((hash: string) => {
      window.location.hash = hash;
    }, to.hash);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在会话列表里点选联系人。
 *
 * WhatsApp Web 列表项是 `#pane-side [data-testid="cell-frame-container"]`（哈希 class、无 a[href]），
 * 旧通用选择器扫不到 → `contact_url_missing_and_not_found_in_list`（现场日志 H2）。
 * 优先用描述符同款选择器，并按 title / 电话数字匹配；点最外层列表行，不点侧栏图标。
 */
async function clickContactInList(page: Page, label: string): Promise<boolean> {
  const needle = String(label ?? "").trim();
  if (!needle) return false;
  const digits = digitsOfContact(needle);

  type PickProbe = {
    selector: string | null;
    candidateCount: number;
    scoped: boolean;
    sampleTitleLen: number;
  };

  const probe = await page
    .evaluate(
      (arg: { target: string; digits: string }): PickProbe => {
        const { target, digits: digitNeedle } = arg;
        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.1;
        };
        const digitsOf = (raw: string): string => String(raw ?? "").replace(/\D+/g, "");
        const matchesHay = (hay: string): boolean => {
          if (!hay) return false;
          if (hay.includes(target)) return true;
          // 电话：忽略空格/破折号差异（+852 9705 4887 vs +85297054887）
          if (digitNeedle.length >= 6) {
            const hd = digitsOf(hay);
            if (
              hd.length >= 6 &&
              (hd === digitNeedle || hd.endsWith(digitNeedle) || digitNeedle.endsWith(hd))
            ) {
              return true;
            }
          }
          return false;
        };
        const titleOf = (el: Element): string => {
          const node =
            el.querySelector(
              '[data-testid="cell-frame-title"] span[title], [data-testid="cell-frame-title"] [title], span[title]',
            ) ?? el;
          const titled = (node.getAttribute("title") || "").trim();
          if (titled) return titled;
          const aria = (el.getAttribute("aria-label") || "").trim();
          if (aria) return aria.split("\n")[0]!.trim().slice(0, 120);
          return "";
        };
        const rowOf = (el: Element): HTMLElement => {
          let cur: Element | null = el;
          for (let i = 0; i < 8 && cur; i += 1) {
            if (
              cur instanceof HTMLElement &&
              (cur.matches(
                '[data-testid="cell-frame-container"], [role="listitem"], [role="row"], div[data-testid^="list-item-"], a[href]',
              ) ||
                cur.getAttribute("role") === "listitem")
            ) {
              return cur;
            }
            cur = cur.parentElement;
          }
          return el instanceof HTMLElement ? el : (el.parentElement as HTMLElement);
        };

        // 与 whatsapp-web.json threads.itemSelectors 对齐，再加通用回落
        const itemSelectors = [
          '#pane-side [data-testid="cell-frame-container"]',
          '#pane-side [role="listitem"]',
          '#pane-side div[data-testid^="list-item-"]',
          '#pane-side [role="row"]',
          '[data-testid="cell-frame-container"]',
          '[role="listitem"]',
          '[role="option"]',
          'div[data-testid^="list-item-"]',
          'a[href]',
          'li',
          '[data-id]',
        ];

        const pane = document.querySelector("#pane-side");
        const roots: Array<{ root: ParentNode; scoped: boolean }> = pane
          ? [
              { root: pane, scoped: true },
              { root: document, scoped: false },
            ]
          : [{ root: document, scoped: false }];

        for (const { root, scoped } of roots) {
          const seen = new Set<Element>();
          const candidates: Array<{ el: HTMLElement; score: number; titleLen: number }> = [];
          for (const sel of itemSelectors) {
            let nodes: Element[] = [];
            try {
              nodes = Array.from(root.querySelectorAll(sel));
            } catch {
              continue;
            }
            for (const node of nodes) {
              if (seen.has(node)) continue;
              seen.add(node);
              if (!isVisible(node)) continue;
              const title = titleOf(node);
              const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
              // 整栏拼接的超长 text 只靠 title/短文本匹配，避免误点父容器
              const shortText = text.length > 0 && text.length <= 96 ? text : "";
              if (!matchesHay(title) && !matchesHay(shortText)) continue;
              const row = rowOf(node);
              if (!row || !isVisible(row)) continue;
              const score = (title && matchesHay(title) ? 0 : 10) + Math.min(text.length, 200);
              candidates.push({ el: row, score, titleLen: title.length });
            }
          }
          if (candidates.length === 0) continue;
          candidates.sort((a, b) => a.score - b.score || a.titleLen - b.titleLen);
          const best = candidates[0]!.el;
          const attr = "data-tst-chat-pick";
          const mark = `p${Date.now().toString(36)}`;
          best.setAttribute(attr, mark);
          return {
            selector: `[${attr}="${mark}"]`,
            candidateCount: candidates.length,
            scoped,
            sampleTitleLen: candidates[0]!.titleLen,
          };
        }
        return { selector: null, candidateCount: 0, scoped: Boolean(pane), sampleTitleLen: 0 };
      },
      { target: needle, digits },
    )
    .catch((): PickProbe | null => null);

  // 兼容旧假页面（测试返回纯字符串选择器）
  const selector =
    typeof probe === "string"
      ? probe
      : probe && typeof probe === "object"
        ? probe.selector
        : null;

  if (!selector) return false;

  try {
    await resolveGateway(page).click(selector, {
      semanticLabel: `打开会话：${needle}`,
      skipSettle: true,
    });
    return true;
  } catch {
    try {
      await page.click(selector, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}
/* ————————————————————————— 3. 读取会话 ————————————————————————— */

export interface ReadThreadOptions {
  containerSelector: string;
  /** 主动回溯历史（静音优先，默认关） */
  loadHistory?: boolean;
  previous?: readonly ChatMessage[];
  policy?: ChatSitePolicy;
  signal?: AbortSignal;
  onScrollRound?: (round: number, added: number) => void;
}

/** 读取会话（薄封装：把真实读取器收敛到一处，便于测试替身） */
export async function readThread(
  page: Page,
  options: ReadThreadOptions,
): Promise<ConversationSnapshot> {
  return readConversation(page, {
    containerSelector: options.containerSelector,
    loadHistory: options.loadHistory ?? false,
    previous: options.previous ?? [],
    policy: options.policy,
    signal: options.signal,
    onScrollRound: options.onScrollRound,
  });
}

/* ————————————————————————— 4. 回读：这条内容在不在会话里 ————————————————————————— */

/**
 * 页面回读：某条内容（按 `hashText` 指纹）是否已出现在会话里。
 *
 * 不能只扫最深叶子：Telegram 等会把一句拆成多 span，叶子指纹永远对不上全文，
 * 现场就是「气泡已在、却判未发出、弹人工框、对方回了也不理」。
 * 多层文本 + 归一化包含（`looksLikeOwnSentText`）作兜底；仍对不上才算未见。
 */
export async function isTextInThread(
  page: Page,
  containerSelector: string,
  textHash: string,
  originalText?: string,
): Promise<boolean> {
  const container = String(containerSelector ?? "").trim();
  if (!container || !textHash) return false;

  let candidates: string[];
  try {
    candidates = await page.evaluate((selector: string) => {
      const root = document.querySelector(selector);
      if (!root) return [];
      const out: string[] = [];
      const push = (raw: string | null | undefined): void => {
        const text = String(raw ?? "").trim();
        if (text.length >= 2) out.push(text);
      };
      root
        .querySelectorAll(
          ".bubble .message, .bubble .text-content, .message, .text-content, [data-mid]",
        )
        .forEach((el) => push((el as HTMLElement).innerText || el.textContent));
      const walk = (node: Element, depth: number): void => {
        if (depth > 10) return;
        const text = ((node as HTMLElement).innerText || node.textContent || "").trim();
        if (text.length >= 8 && text.length <= 4000) out.push(text);
        for (const child of Array.from(node.children)) walk(child, depth + 1);
      };
      walk(root, 0);
      const seen = new Set<string>();
      const unique: string[] = [];
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const item = out[i]!;
        if (seen.has(item)) continue;
        seen.add(item);
        unique.push(item);
        if (unique.length >= 500) break;
      }
      return unique.reverse();
    }, container);
  } catch {
    return false;
  }

  if (candidates.some((text) => hashText(text) === textHash)) return true;
  const own = String(originalText ?? "").trim();
  if (own.length < 8) return false;
  if (looksLikeOwnSentText(candidates.join("\n"), [own]) !== null) return true;
  return candidates.some((text) => looksLikeOwnSentText(text, [own]) !== null);
}

/* ————————————————————————— 5. 发送（拟人 + 回读确认） ————————————————————————— */

interface ComposerLocation {
  inputSelector: string | null;
  sendSelector: string | null;
  /** 输入框是不是 contenteditable（决定走 fill 还是键盘输入） */
  editable: boolean;
}

/**
 * 定位输入框与发送按钮。
 *
 * 通用策略（不写死任何站点）：
 * - 输入框：页面下半部、可见、可编辑，优先 `contenteditable`，其次 textarea/input；
 *   用政策词表里的 `inputWords` 与常见占位词提升命中率。
 * - 发送按钮：输入框**附近**（同一容器或紧邻兄弟）且文本/aria-label 命中 `sendWords`
 *   或含 send 语义的图标按钮。
 * 找不到发送按钮不算失败（很多站点 Enter 即发送），返回 null 由下发走 Enter。
 */
async function locateComposer(
  page: Page,
  containerSelector: string,
  policy: ChatSitePolicy,
): Promise<ComposerLocation> {
  const inputWords = policy.inputWords.length > 0 ? policy.inputWords : [];
  const sendWords = policy.sendWords.length > 0 ? policy.sendWords : [];

  const result = await page
    .evaluate(
      (arg: { container: string; inputWords: string[]; sendWords: string[] }) => {
        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) return false;
          const style = window.getComputedStyle(el);
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity) > 0.1 &&
            el.getAttribute("aria-hidden") !== "true"
          );
        };
        const editableOf = (el: Element): boolean =>
          el instanceof HTMLElement && (el.isContentEditable || el.getAttribute("role") === "textbox");

        // —— 输入框 ——
        const root = document.querySelector(arg.container);
        const scope: ParentNode = root ?? document;
        const inputCandidates: Array<{ el: HTMLElement; score: number }> = [];
        const inputs = scope.querySelectorAll<HTMLElement>(
          'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]',
        );
        const viewportH = window.innerHeight || 800;
        for (const el of inputs) {
          if (!isVisible(el)) continue;
          const rect = el.getBoundingClientRect();
          // 聊天输入框总在页面下半部
          if (rect.top < viewportH * 0.35) continue;
          const hint = `${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${
            el.getAttribute("data-placeholder") ?? ""
          }`.toLowerCase();
          let score = rect.top / viewportH; // 越靠下越像
          if (editableOf(el)) score += 0.5;
          for (const word of arg.inputWords) {
            if (word && hint.includes(word.toLowerCase())) score += 1.2;
          }
          if (hint.includes("message") || hint.includes("消息") || hint.includes("输入") || hint.includes("type a")) {
            score += 0.8;
          }
          inputCandidates.push({ el, score });
        }
        inputCandidates.sort((a, b) => b.score - a.score);
        const inputEl = inputCandidates[0]?.el ?? null;

        if (!inputEl) return { inputSelector: null, sendSelector: null, editable: false };

        inputEl.setAttribute("data-tst-chat-input", "1");
        const editable = editableOf(inputEl);

        // —— 发送按钮（只在输入框附近找） ——
        const inputRect = inputEl.getBoundingClientRect();
        const isNear = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          const dy = Math.abs(rect.top - inputRect.top);
          const near = dy < Math.max(120, inputRect.height * 4);
          const horizontal = rect.left > inputRect.left - 40;
          return near && horizontal;
        };
        const describe = (el: Element): string =>
          `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.getAttribute(
            "data-testid",
          ) ?? ""} ${el.getAttribute("class") ?? ""} ${el.textContent ?? ""}`.toLowerCase();

        const sendCandidates: HTMLElement[] = [];
        const buttons = document.querySelectorAll<HTMLElement>('button, [role="button"], a[role="button"]');
        for (const el of buttons) {
          if (!isVisible(el)) continue;
          if (!isNear(el)) continue;
          const desc = describe(el);
          if (!desc.trim()) continue;
          let hit = false;
          for (const word of arg.sendWords) {
            if (word && desc.includes(word.toLowerCase())) {
              hit = true;
              break;
            }
          }
          if (!hit && (desc.includes("send") || desc.includes("发送"))) hit = true;
          if (!hit) continue;
          // 排除「发送文件/表情/图片」这类非纯发送按钮的干扰：优先含 send/发送 文本者
          sendCandidates.push(el);
        }
        let sendEl: HTMLElement | null = null;
        if (sendCandidates.length > 0) {
          sendCandidates.sort((a, b) => {
            const rank = (el: HTMLElement): number => {
              const desc = describe(el);
              const rect = el.getBoundingClientRect();
              let score = 0;
              if (/(^|\s)(send|发送)(\s|$)/.test(desc)) score += 2;
              if (rect.top >= inputRect.top - 10) score += 1;
              if (el.tagName === "BUTTON") score += 0.5;
              return score;
            };
            return rank(b) - rank(a);
          });
          sendEl = sendCandidates[0];
          sendEl.setAttribute("data-tst-chat-send", "1");
        }

        return {
          inputSelector: '[data-tst-chat-input="1"]',
          sendSelector: sendEl ? '[data-tst-chat-send="1"]' : null,
          editable,
        };
      },
      { container: containerSelector, inputWords, sendWords },
    )
    .catch(() => ({ inputSelector: null, sendSelector: null, editable: false }));

  return result;
}

export interface SendChatTextResult {
  ok: boolean;
  reason?: string;
  /** 是否点了发送按钮（false = 走了 Enter） */
  usedSendButton?: boolean;
  /** 出站闸门的结构化诊断（走描述符时才有；**不含消息正文**，仅供落日志排查） */
  diagnostics?: Record<string, unknown>;
}

/**
 * 拟人输入并发送。
 *
 * 流程：定位输入框 → 拟人逐字输入 → （有按钮则点按钮，否则 Enter）→ 返回。
 * **不回读**：回读由上层 engine 统一做（它是幂等判定的一部分，不该藏在原语里）。
 */
export async function sendChatText(
  page: Page,
  containerSelector: string,
  text: string,
  policy: ChatSitePolicy = loadChatSitePolicy(),
): Promise<SendChatTextResult> {
  const content = String(text ?? "").trim();
  if (!content) {
    return { ok: false, reason: "empty_text" };
  }

  const composer = await locateComposer(page, containerSelector, policy);
  if (!composer.inputSelector) {
    return { ok: false, reason: "composer_not_found" };
  }

  try {
    const gateway = resolveGateway(page);
    // `humanLike` 缺省/true 走 Locator.fill，节奏交给 CloakBrowser 包装层
    await gateway.fill(composer.inputSelector, content, {
      humanLike: true,
      semanticLabel: "聊天输入",
    });

    // 与描述符出站同一条 fail-closed 等值校验（§R8）：读回对不上 → 清空、绝不提交
    const landed = await readComposerText(page, composer.inputSelector);
    const verdict = verifyComposerWrite(content, landed, { failClosed: true });
    if (!verdict.ok) {
      try {
        await gateway.fill(composer.inputSelector, "", { semanticLabel: "清空未校验草稿" });
      } catch {
        /* 清不掉也照样取消发送 */
      }
      return {
        ok: false,
        reason: `verify_mismatch:${verdict.reason ?? "equals"}`,
      };
    }
    // 空白归一化后仍须非空（防站点只留下装饰）
    if (!normalizeComposerText(landed).trim()) {
      return { ok: false, reason: "input_not_landed" };
    }

    if (composer.sendSelector) {
      try {
        await gateway.click(composer.sendSelector, { semanticLabel: "点击发送" });
        return { ok: true, usedSendButton: true };
      } catch {
        // 按钮点了没成功：退回 Enter（很多站点两者都支持）
      }
    }

    await page.keyboard.press("Enter");
    return { ok: true, usedSendButton: false };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 读回输入框当前文本（用于确认「字真的进去了」） */
export async function readComposerText(page: Page, inputSelector: string): Promise<string> {
  try {
    return await page.evaluate((selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return "";
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return el.value ?? "";
      }
      return (el.textContent ?? "").trim();
    }, inputSelector);
  } catch {
    return "";
  }
}

/* ————————————————————————— 6. 事件驱动等待 ————————————————————————— */

export interface WaitThreadOptions {
  containerSelector: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/**
 * 等待会话出现动静（页内 `MutationObserver`，非轮询）。
 * 返回**醒来的原因**，由调用方如实落日志（含 `chat_wait_fallback_poll`）。
 */
export async function waitThreadActivity(
  page: Page,
  options: WaitThreadOptions,
): Promise<ChatActivityResult> {
  const baseline = (await readChatSliceSize(page, options.containerSelector)) ?? {
    childCount: 0,
    textLength: 0,
  };
  return waitForChatActivity(page, {
    selector: options.containerSelector,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    baseline,
  });
}

/** 便捷：从 Browser 拿一个 context（聊天标签挂在它下面） */
export function contextOf(browser: Browser): BrowserContext {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error("no_browser_context");
  }
  return contexts[0];
}

/* ————————————————————————— 7. 页面就绪门禁（站点完全打开了吗） ————————————————————————— */

export interface WaitChatReadyOptions {
  policy?: ChatSitePolicy;
  /** 总预算（默认 {@link DEFAULT_CHAT_READY_TIMEOUT_MS}） */
  timeoutMs?: number;
  /** 未就绪时的采样间隔（默认 800ms） */
  intervalMs?: number;
  /**
   * 重新做「全量页内探测」的间隔（默认 {@link DEFAULT_CHAT_REPROBE_MS}）。
   *
   * 为什么必须重探：首屏还在渲染时那次探测「没找到容器 / 不像聊天页」的结论**不能永久沿用**，
   * 否则站点几秒后就绪了，门禁却一直抱着旧结论在等一个不会来的东西，最后只能超时
   * （现场：刚导航完就 `not_chat_page`，整片瞬间结束）。拿到会话容器后即停止重探。
   */
  reprobeMs?: number;
  signal?: AbortSignal;
  /** 已知容器（有就不必再等识别结果） */
  containerSelector?: string | null;
}

export interface ChatReadyResult {
  ready: boolean;
  /** 明确不是聊天页 → 调用方应当交人工而不是悄悄重试 */
  blocked: boolean;
  reason: string;
  containerSelector: string | null;
  waitedMs: number;
  evidence: string[];
}

/** 就绪预算：SPA 聊天应用首屏常要 5–15s；给 25s 上限，超时即如实放弃（不硬等） */
export const DEFAULT_CHAT_READY_TIMEOUT_MS = 25_000;

/** 重探间隔（见 {@link WaitChatReadyOptions.reprobeMs}）：3s 一次全量探测，拿到容器即停 */
export const DEFAULT_CHAT_REPROBE_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** 某选择器当前是否可见（一次页内测量；不可见/不存在都算 false） */
export async function hasVisibleSelector(page: Page, selector: string): Promise<boolean> {
  const target = String(selector ?? "").trim();
  if (!target) return false;
  try {
    return await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    }, target);
  } catch {
    return false;
  }
}

async function htmlLoaded(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => document.readyState === "complete");
  } catch {
    return false;
  }
}

/**
 * 等站点**完全打开**：容器 + 输入框就绪，且渲染已稳定（连续两次规模一致）。
 *
 * 实现取舍（与 §5「不拿轮询当等待手段」不冲突）：
 *   - 首屏用 Playwright 自己的 `load` 事件（站点真实的加载完成信号）；
 *     **刻意不用 `networkidle`** —— 聊天站点常驻 WebSocket，那基本永远不会到。
 *   - 页内全量探测（`detectChatPage`）**只在还没拿到会话容器时**重复，
 *     且按 {@link DEFAULT_CHAT_REPROBE_MS} 节流（它遍历整棵 DOM，较重）；
 *     一旦容器定位到并判成聊天页，就只用「容器是否可见 / 输入框是否就绪 / 规模是否稳定」
 *     三个轻量量。**不能只探一次**：首屏还没渲染时那次「没找到容器」的结论会僵在那里，
 *     站点明明几秒后就绪了也只能超时。
 *   - 稳定性：两次采样一致才算稳（避免把「还在渲染」当成读完了）。
 * 判定本身是纯函数 {@link decideChatReady}，这里只负责采样与节奏。
 */
export async function waitForChatReady(
  page: Page,
  options: WaitChatReadyOptions = {},
): Promise<ChatReadyResult> {
  const policy = options.policy ?? loadChatSitePolicy();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_CHAT_READY_TIMEOUT_MS);
  const intervalMs = Math.max(200, options.intervalMs ?? 800);
  const started = Date.now();
  const deadline = started + timeoutMs;

  const finish = (
    state: "ready" | "blocked" | "timeout" | "pending",
    reason: string,
    selector: string | null,
    evidence: string[],
  ): ChatReadyResult => ({
    ready: state === "ready",
    blocked: state === "blocked",
    reason,
    containerSelector: selector,
    waitedMs: Date.now() - started,
    evidence,
  });

  try {
    // 首屏：`load` 是站点自己的「加载完成」信号（超时不算失败，后面还有就绪判定兜底）
    await page.waitForLoadState("load", { timeout: Math.min(10_000, timeoutMs) }).catch(() => undefined);
  } catch {
    /* 页面可能已关闭：交给下面的探针如实报告 */
  }

  let selector = String(options.containerSelector ?? "").trim() || null;
  let verdict: ChatPageVerdict = "inconclusive";
  let evidence: string[] = [];
  let lastProbeAt = 0;
  let previousSize: { childCount: number; textLength: number } | null = null;
  const reprobeMs = Math.max(1000, options.reprobeMs ?? DEFAULT_CHAT_REPROBE_MS);

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return finish("pending", "已取消", selector, evidence);

    // 还没探过 → 立刻探；**还没拿到容器或还没判成聊天页** → 按间隔重探（首屏渲染完再判，
    // 而不是抱着第一次那点「还没渲染」的结论等下去）；拿到容器 + 判定为聊天页后即停止重探。
    const needProbe = lastProbeAt === 0 || !selector || verdict !== "chat_page";
    if (needProbe && Date.now() - lastProbeAt >= (lastProbeAt === 0 ? 0 : reprobeMs)) {
      const detected = await detectChatPage(page, { policy, signal: options.signal });
      lastProbeAt = Date.now();
      verdict = detected.verdict;
      evidence = detected.evidence;
      if (detected.containerSelector && !selector) selector = detected.containerSelector;
    }

    const loaded = await htmlLoaded(page);
    const containerVisible = selector ? await hasVisibleSelector(page, selector) : false;
    let composerReady = false;
    if (containerVisible && selector) {
      const composer = await locateComposer(page, selector, policy);
      composerReady = Boolean(composer.inputSelector);
    }

    let stable = false;
    if (containerVisible && selector) {
      const size = await readChatSliceSize(page, selector);
      stable =
        Boolean(size) &&
        Boolean(previousSize) &&
        size!.childCount === previousSize!.childCount &&
        size!.textLength === previousSize!.textLength;
      previousSize = size ?? null;
    } else {
      previousSize = null;
    }

    const decision = decideChatReady({
      verdict,
      hasContainer: containerVisible,
      hasComposer: composerReady,
      htmlLoaded: loaded,
      stable,
      waitedMs: Date.now() - started,
      timeoutMs,
    });

    if (decision.state === "ready") return finish("ready", decision.reason, selector, evidence);
    if (decision.state === "blocked") return finish("blocked", decision.reason, selector, evidence);
    if (decision.state === "timeout") return finish("timeout", decision.reason, selector, evidence);

    await sleep(intervalMs);
  }

  return finish("timeout", `等待站点加载完成超时（${Math.round(timeoutMs / 1000)}s）`, selector, evidence);
}

/* ————————————————————————— 8. 当前打开的会话（未指定对象时的兜底） ————————————————————————— */

export interface CurrentConversation {
  page: Page;
  url: string;
  title: string;
  /** 展示名（只用于日志/卡片；**身份**用 `conversationKeyOf` 算，别用展示名当 key） */
  label: string;
  labelSource: "title" | "url" | "fallback";
  siteKey: string;
  containerSelector: string;
  confidence: number;
  /**
   * 退回用的：没有用户自己的聊天窗口可用，于是用了**我们自己上次留下的**聊天标签
   * （调用方应如实记一笔，别让用户以为「没窗口」）。
   */
  ownTab?: boolean;
}

export type ResolveCurrentConversationResult =
  | { ok: true; conversation: CurrentConversation }
  | { ok: false; reason: string };

const FALLBACK_LABEL = "当前会话";

/** 主域里的「站点词」：web.telegram.org → telegram（用于识别「标题只是站点名」） */
function hostTokenOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host
      .split(".")
      .filter(
        (part) =>
          part.length > 2 &&
          !["www", "web", "com", "org", "net", "io", "app", "cn", "co", "me"].includes(part),
      );
    return parts[parts.length - 1] ?? "";
  } catch {
    return "";
  }
}

function lastSegmentOf(url: string): string {
  const text = String(url ?? "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const fromHash = parsed.hash.replace(/^#\/?/, "").split(/[/?]/).pop() ?? "";
    const candidate = fromHash || parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(candidate).replace(/^[@#]/, "").trim();
  } catch {
    return "";
  }
}

/**
 * 从页面标题 + URL 推断一个**展示名**（纯函数）。
 *
 * 关键取舍：标题经常就是站点名（例如「Telegram」），那就不是联系人名 —— 这种情况退回 URL 末段；
 * 实在没有就用「当前会话」。**不要**把展示名当身份键（它会变），身份用 {@link conversationKeyOf}。
 */
export function deriveContactLabel(
  rawTitle: string,
  url: string,
): { label: string; source: "title" | "url" | "fallback" } {
  const normalize = (value: string): string =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  const title = String(rawTitle ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const head = title.split(/[\|·—–]|\s[-–—:：]\s/)[0]?.trim() ?? "";
  const candidate = (head || title).trim();
  const hostToken = normalize(hostTokenOf(url));
  const normalized = normalize(candidate);
  const looksGeneric =
    !normalized ||
    normalized.length < 2 ||
    normalized === hostToken ||
    (hostToken.length > 0 && normalized === `web${hostToken}`);

  if (!looksGeneric) return { label: candidate.slice(0, 60), source: "title" };
  const tail = lastSegmentOf(url);
  if (tail) return { label: tail.slice(0, 60), source: "url" };
  return { label: FALLBACK_LABEL, source: "fallback" };
}

/**
 * 会话的**稳定身份键**：`{siteKey}|u:{hash(URL)}`。
 *
 * 为什么不用展示名当 key：标题会变（未读计数、站点改名、语言），一变就换目录 ——
 * 同一个人被当成新对象重新开场（R7：这是刷屏事故）。URL 才是会话的稳定标识。
 */
export function conversationKeyOf(siteKey: string, url: string): string {
  const normalized = (() => {
    const text = String(url ?? "").trim();
    try {
      const parsed = new URL(text);
      parsed.hash = parsed.hash; // 保留 hash：很多站点把会话 id 放在 hash 里
      return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}${parsed.hash}`;
    } catch {
      return text.replace(/\/+$/, "");
    }
  })();
  return `${String(siteKey ?? "").trim() || "unknown"}|u:${hash32Id(normalized)}`;
}

/**
 * 在**用户此刻打开的标签**里找当前会话（「没指定对象就用当前打开的聊天窗口」）。
 *
 * 纪律：
 *   - 只看**已经打开的标签**，**不新开、不导航、不改 URL**（用户的窗口原样保留）；
 *   - 只在**明确像聊天页**（三态判定 `chat_page`）的标签里选，选不出就如实失败（不猜）；
 *   - **优先用户自己的标签**；实在没有，才退回「我们自己上次留下、现在正开着的聊天标签」
 *     —— 用户看到的就是那个聊天窗口，明明开着却报「没有可用窗口」才是真的费解
 *     （退回时 `ownTab: true`，调用方会如实记一笔，不静默）。
 */
export async function resolveCurrentConversation(
  browser: Browser,
  options: { policy?: ChatSitePolicy; exclude?: Page | null; signal?: AbortSignal } = {},
): Promise<ResolveCurrentConversationResult> {
  const policy = options.policy ?? loadChatSitePolicy();
  const candidates: Array<CurrentConversation & { order: number }> = [];
  const own: Array<CurrentConversation & { order: number }> = [];
  let order = 0;

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      order += 1;
      if (options.signal?.aborted) return { ok: false, reason: "aborted" };
      if (options.exclude && page === options.exclude) continue;
      try {
        if (page.isClosed()) continue;
      } catch {
        continue;
      }
      const currentUrl = safeUrl(page);
      if (!currentUrl || currentUrl === "about:blank") continue;
      const mine = await isOwnChatTab(page);

      const detected = await detectChatPage(page, { policy, signal: options.signal });
      if (detected.verdict !== "chat_page" || !detected.containerSelector) continue;

      const meta = await readPageMeta(page);
      const { label, source } = deriveContactLabel(meta.title, meta.url || currentUrl);
      const item: CurrentConversation & { order: number } = {
        page,
        url: meta.url || currentUrl,
        title: meta.title,
        label,
        labelSource: source,
        siteKey: siteKeyOf(meta.url || currentUrl, detected.profileId),
        containerSelector: detected.containerSelector,
        confidence: detected.confidence,
        order,
      };
      if (mine) own.push(item);
      else candidates.push(item);
    }
  }

  const pool = candidates.length > 0 ? candidates : own;
  if (pool.length === 0) {
    return { ok: false, reason: "no_open_chat_window" };
  }
  // 置信度高的优先；同分取**更靠后打开**的（最近打开的那个更像用户此刻在看的）
  pool.sort((a, b) => (b.confidence - a.confidence) || (b.order - a.order));
  const best = pool[0]!;
  const { order: _order, ...conversation } = best;
  return { ok: true, conversation: { ...conversation, ownTab: candidates.length === 0 } };
}

/**
 * 这个标签是不是**我们自己开的**聊天专用标签。
 *
 * `ensureChatPage` 会给自开的标签打 `window.__tst_chat_tab = true`；用户手动开的标签没有这个标记。
 * 「用当前打开的聊天窗口」时必须靠它把自开标签排除掉，否则会绑定到自己刚开的空标签上。
 */
async function isOwnChatTab(page: Page): Promise<boolean> {
  try {
    return await page.evaluate((flag: string) => {
      const value = (window as unknown as Record<string, unknown>)[flag];
      return value === true;
    }, CHAT_TAB_FLAG);
  } catch {
    // 读不到（跨域/未挂载）就当**不是**自己的：宁可多试，也不要因为探针失败而误判「没有可用窗口」
    return false;
  }
}

/** 读回页面标题与最终 URL（导航后 URL 可能已被 SPA 改写） */
async function readPageMeta(page: Page): Promise<{ title: string; url: string }> {
  try {
    return await page.evaluate(() => ({
      title: String(document.title ?? ""),
      url: String(document.location?.href ?? ""),
    }));
  } catch {
    return { title: "", url: safeUrl(page) };
  }
}
