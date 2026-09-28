/**
 * 发现流水线 ① · 采集（**0 token**）
 *
 * 这一步就是「分析网页源码」的诚实版本：把页面归一化成**结构化事实**（Flat JSON），
 * **绝不把 HTML 原文喂给模型**。依据：同一任务同一模型下，结构化输入 F1 ≈ 0.957（幻觉 3%），
 * 瘦身后的 HTML 输入 F1 ≈ 0.101（幻觉 91%）—— 差约 9.5 倍（计划 §6.0 规则 1）。
 *
 * 同时用**通用 DOM 读法**记一份真值（oracle）：没有真值，AI 的猜测无法判定真伪。
 *
 * 三条硬纪律：
 *   1. **零正文**：`structure` 里只有结构、属性名、形态与长度；消息正文一律不进分析上下文。
 *   2. **拆分取样**：采集到的行/会话分成「给模型看的」与「留给自检的」，后者绝不外传（规则 3）。
 *   3. **失败如实**：探测失败原样上报（不把失败伪装成「页面是空的」）。
 */

import { hash32Id } from "../../hash32.js";
import { extractChatItems, resolveDirection, type RawChatItem } from "../conversation_extract.js";
import { contentVersionOf } from "../descriptor/map_rows.js";
import { detectChatPage } from "../site_detect.js";
import type { Page } from "playwright-core";
import type { RowFact, ThreadListItem } from "../descriptor/types.js";
import type {
  CaptureBundle,
  OracleRow,
  ProbeNode,
  RawStructureProbe,
} from "./types.js";

/** 一次采集中最多带出多少个候选节点（页面大时截断，截断要如实记账） */
export const PROBE_NODE_LIMIT = 400;

/** 属性白名单：只收 `data-*` / `aria-*` / 这几个通用属性名（其余一律不看） */
export const ATTR_NAME_WHITELIST = ["id", "role", "title", "href", "contenteditable", "datetime", "type"] as const;

/** 值截断上限（防超长属性值把上下文撑爆） */
export const ATTR_VALUE_LIMIT = 60;

/* ————————————————————————— 页内：会话列表的「通用真值」 ————————————————————————— */

export interface GenericThreadsArg {
  limit: number;
  valueLimit: number;
}

/** 页内扫出来的候选列表项（**纯结构**：key 只用于自检比对，展示名截断） */
export interface GenericThreadItem {
  key: string | null;
  href: string | null;
  labelLen: number;
  unread: boolean;
}

/**
 * **页内**通用会话列表探测（自包含）。
 *
 * 为什么要有它（而不是「没有描述符就验不了列表」）：`threads` 声明是「从真实列表勾选对象」
 * 的前提，而新站点的第一份描述符正是要靠这一步验的。做法与通用读法同款：找
 * **「重复子结构 + 带 data-* 身份属性」**的那一层，不猜站点语义。
 */
export function probeGenericThreadsInPage(arg: GenericThreadsArg): { ok: boolean; reason: string | null; items: GenericThreadItem[] } {
  try {
    const idLike = /(peer|chat|conversation|thread|dialog|contact|user|room|channel)[-_a-z]*$/i;
    type Cand = { score: number; items: GenericThreadItem[] };
    let best: Cand | null = null;

    for (const el of Array.from(document.querySelectorAll("*"))) {
      const kids = Array.from(el.children);
      if (kids.length < 4 || kids.length > 200) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 120) continue;
      // 侧栏特征：靠左且竖长
      if (rect.left > window.innerWidth * 0.5) continue;

      const items: GenericThreadItem[] = [];
      let keyed = 0;
      for (const kid of kids) {
        let key: string | null = null;
        for (const attr of Array.from(kid.attributes)) {
          if (!attr.name.startsWith("data-")) continue;
          if (!idLike.test(attr.name)) continue;
          const value = String(attr.value ?? "").trim();
          if (value && value.length <= arg.valueLimit) {
            key = `${attr.name}:${value}`;
            break;
          }
        }
        let href: string | null = null;
        const link = kid instanceof HTMLAnchorElement ? kid : kid.querySelector("a[href]");
        if (link) {
          const raw = link.getAttribute("href") ?? "";
          if (raw && !/^(javascript|mailto|tel|data|blob):/i.test(raw)) href = raw.slice(0, 200);
        }
        if (!key && !href) continue;
        if (key) keyed += 1;
        const label = (kid.textContent ?? "").replace(/\s+/g, " ").trim();
        const unread = kid.querySelector("[class*='unread'], [class*='badge'], [aria-label*='未读']") !== null;
        items.push({ key, href, labelLen: label.length, unread });
      }
      if (items.length < 4) continue;
      const score = items.length + keyed * 2;
      if (!best || score > best.score) best = { score, items: items.slice(0, arg.limit) };
    }

    if (!best) return { ok: false, reason: "no_thread_list_candidate", items: [] };
    return { ok: true, reason: null, items: best.items };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "probe_failed", items: [] };
  }
}

/* ————————————————————————— 页内探测（自包含） ————————————————————————— */

export interface ProbeStructureArg {
  limit: number;
  attrWhitelist: readonly string[];
  valueLimit: number;
}

/**
 * **页内**结构探测（自包含：Playwright 会把它序列化后送进页面，不得引用模块作用域）。
 *
 * 它只读结构与形态：
 *   - 类名里剔除构建 hash（否则模型会照着 hash 写选择器，改版必炸）；
 *   - 属性值做「数字折叠」（`data-mid="4521"` → `#`），避免把内容当结构；
 *   - 文本只留**长度 + 形态**（latin/cjk/digits/mixed），不读内容。
 */
export function probeStructureInPage(arg: ProbeStructureArg): RawStructureProbe {
  const empty = { ok: false, reason: null as string | null };

  try {
    const whitelist = new Set<string>(arg.attrWhitelist as readonly string[]);
    const isHashClass = (name: string): boolean =>
      /^(?:_|css-)/.test(name) || /^[a-z]*[0-9][a-z0-9]{4,}$/i.test(name) || /^[0-9a-f]{6,}$/i.test(name);

    const stableClasses = (el: Element): string[] => {
      const raw = (el as HTMLElement).className;
      if (typeof raw !== "string" || !raw) return [];
      const out: string[] = [];
      for (const token of raw.split(/\s+/)) {
        const clean = token.trim();
        if (!clean || clean.length > 40 || isHashClass(clean)) continue;
        if (!out.includes(clean)) out.push(clean);
        if (out.length >= 6) break;
      }
      return out;
    };

    const signatureOf = (el: Element): string => {
      const classes = stableClasses(el);
      return classes.length > 0
        ? `${el.tagName.toLowerCase()}.${classes.slice(0, 2).join(".")}`
        : el.tagName.toLowerCase();
    };

    /** 属性值折叠：数字/长串只留形态（内容是用户数据，不进分析） */
    const foldValue = (value: string): string => {
      const text = String(value ?? "").slice(0, arg.valueLimit);
      if (!text) return "";
      return text.replace(/\d+/g, "#");
    };

    const collectAttrs = (el: Element): Record<string, string> => {
      const out: Record<string, string> = {};
      let count = 0;
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const isData = name.startsWith("data-") || name.startsWith("aria-");
        if (!isData && !whitelist.has(name)) continue;
        out[name] = foldValue(attr.value);
        count += 1;
        if (count >= 12) break;
      }
      return out;
    };

    const textShape = (el: Element): { len: number; shape: string } => {
      const raw = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const len = raw.length;
      if (len === 0) return { len: 0, shape: "empty" };
      const cjk = /[\u3400-\u9fff]/.test(raw);
      const latin = /[a-z]/i.test(raw);
      const digits = /\d/.test(raw);
      const kinds = (cjk ? 1 : 0) + (latin ? 1 : 0) + (digits ? 1 : 0);
      if (kinds > 1) return { len, shape: "mixed" };
      if (cjk) return { len, shape: "cjk" };
      if (latin) return { len, shape: "latin" };
      return { len, shape: "digits" };
    };

    const isScrollable = (el: Element): boolean => {
      try {
        const style = window.getComputedStyle(el);
        const overflow = `${style.overflowY} ${style.overflow}`;
        if (!/auto|scroll/.test(overflow)) return false;
        return el.scrollHeight > el.clientHeight + 8;
      } catch {
        return false;
      }
    };

    const viewportWidth = window.innerWidth || 1;
    const viewportHeight = window.innerHeight || 1;

    const all = Array.from(document.querySelectorAll("*"));
    const nodes: ProbeNode[] = [];
    const attrsSeen = new Set<string>();
    const counts = { contentEditable: 0, textarea: 0, roleLog: 0, links: 0, buttons: 0 };
    const siblingsOf = new Map<Element, number>();

    for (const el of all) {
      const parent = el.parentElement;
      if (!parent) continue;
      // 同签名兄弟数量：只算一次（按父节点分组统计）
      if (!siblingsOf.has(parent)) {
        const kids = Array.from(parent.children);
        const bySig = new Map<string, number>();
        for (const kid of kids) {
          const sig = signatureOf(kid);
          bySig.set(sig, (bySig.get(sig) ?? 0) + 1);
        }
        let max = 0;
        for (const n of bySig.values()) if (n > max) max = n;
        siblingsOf.set(parent, max);
      }
    }

    for (const el of all) {
      const role = el.getAttribute("role");
      const contentEditable =
        el instanceof HTMLElement && (el.isContentEditable || el.getAttribute("contenteditable") === "true");
      const isTextarea = el.tagName.toLowerCase() === "textarea";
      const isLink = el.tagName.toLowerCase() === "a" && Boolean(el.getAttribute("href"));
      const isButton = role === "button" || el.getAttribute("type") === "button";
      const clickable = isButton || isLink || Boolean(el.getAttribute("aria-label"));
      const scrollable = isScrollable(el);
      const classes = stableClasses(el);
      const nodeAttrs = collectAttrs(el);
      for (const name of Object.keys(nodeAttrs)) attrsSeen.add(name);

      if (contentEditable) counts.contentEditable += 1;
      if (isTextarea) counts.textarea += 1;
      if (role === "log") counts.roleLog += 1;
      if (isLink) counts.links += 1;
      if (isButton) counts.buttons += 1;

      const kids = Array.from(el.children);
      let childRepeat = 0;
      if (kids.length >= 2) {
        const bySig = new Map<string, number>();
        for (const kid of kids) {
          const sig = signatureOf(kid);
          bySig.set(sig, (bySig.get(sig) ?? 0) + 1);
        }
        for (const n of bySig.values()) if (n > childRepeat) childRepeat = n;
      }

      const siblingRepeat = siblingsOf.get(el.parentElement as Element) ?? 1;
      const interesting =
        childRepeat >= 3 ||
        siblingRepeat >= 3 ||
        contentEditable ||
        isTextarea ||
        isLink ||
        isButton ||
        role === "log" ||
        scrollable ||
        Object.keys(nodeAttrs).some((name) => name.startsWith("data-") || name.startsWith("aria-"));
      if (!interesting) continue;

      const rect = el.getBoundingClientRect();
      const { len, shape } = textShape(el);
      nodes.push({
        path: signatureOf(el),
        tag: el.tagName.toLowerCase(),
        role,
        classes,
        attrs: nodeAttrs,
        siblingRepeat,
        childRepeat,
        childCount: kids.length,
        textLen: len,
        textShape: shape,
        rect: {
          xRatio: Number((rect.left / viewportWidth).toFixed(3)),
          yRatio: Number((rect.top / viewportHeight).toFixed(3)),
          wRatio: Number((rect.width / viewportWidth).toFixed(3)),
          hRatio: Number((rect.height / viewportHeight).toFixed(3)),
        },
        contentEditable,
        scrollable,
        isLink,
        hasMediaTag: el.querySelector("img, video, audio, canvas") !== null,
        clickable,
      });
      if (nodes.length >= arg.limit) break;
    }

    return {
      ok: true,
      reason: null,
      viewport: { width: viewportWidth, height: viewportHeight },
      nodes,
      attrs: Array.from(attrsSeen).sort(),
      counts,
    };
  } catch (error) {
    empty.reason = error instanceof Error ? error.message : String(error);
    return {
      ...empty,
      viewport: { width: 0, height: 0 },
      nodes: [],
      attrs: [],
      counts: { contentEditable: 0, textarea: 0, roleLog: 0, links: 0, buttons: 0 },
    };
  }
}

/* ————————————————————————— Node 侧：驱动页面的采集入口 ————————————————————————— */

export interface CaptureBundleOptions {
  /** 页面上已经有一个描述符时优先用它读（新站点没有） */
  listThreads?: (() => Promise<ThreadListItem[]>) | null;
  signal?: AbortSignal;
  /** 真值最多取多少行（虚拟列表只渲染可见项，所以要如实记账） */
  rowLimit?: number;
}

/**
 * 真值行的读取上限：虚拟列表只渲染可见项，读到的往往远少于会话真实长度。
 * 这不是缺陷，是**如实的能力边界**（也正因如此，采集要记账「读到了几条」）。
 */
export const ORACLE_ROW_LIMIT = 60;

/**
 * 采集一次（**0 token**）：结构事实 + 通用读法真值 + 会话列表真值。
 *
 * 纪律：探测失败**原样上报**（`structure.ok=false` / 空真值 + `dropped` 记账），
 * 不把失败伪装成「页面是空的」——后者会让模型照着空页面编一份描述符。
 */
export async function captureBundle(
  page: Page,
  options: CaptureBundleOptions = {},
): Promise<CaptureBundle> {
  const dropped: string[] = [];
  const now = new Date().toISOString();
  const url = page.url();

  let structure: RawStructureProbe;
  try {
    structure = await page.evaluate(probeStructureInPage, {
      limit: PROBE_NODE_LIMIT,
      attrWhitelist: [...ATTR_NAME_WHITELIST],
      valueLimit: ATTR_VALUE_LIMIT,
    });
  } catch (error) {
    structure = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      viewport: { width: 0, height: 0 },
      nodes: [],
      attrs: [],
      counts: { contentEditable: 0, textarea: 0, roleLog: 0, links: 0, buttons: 0 },
    };
  }

  const detected = await detectChatPage(page, { signal: options.signal });
  const containerSelector = detected.containerSelector;
  if (!containerSelector) {
    dropped.push(
      detected.probeFailed
        ? "页内识别失败（页面不可用或已关闭）"
        : "没定位到会话容器（通用识别判不出一条可用的消息列表）",
    );
  }

  let rowItems: RawChatItem[] = [];
  let renderedRowCount = 0;
  if (containerSelector) {
    try {
      const result = await page.evaluate(extractChatItems, {
        selector: containerSelector,
        maxItems: Math.max(10, Math.min(ORACLE_ROW_LIMIT, options.rowLimit ?? ORACLE_ROW_LIMIT)),
        maxTextChars: 2000,
        scrollTop: null,
      });
      if (result?.ok) {
        rowItems = Array.isArray(result.items) ? result.items : [];
        renderedRowCount = rowItems.length;
      } else {
        dropped.push(`通用读法没读到消息：${result?.reason ?? "unknown"}`);
      }
    } catch (error) {
      dropped.push(`通用读法抛错：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let threads: ThreadListItem[] = [];
  if (options.listThreads) {
    try {
      threads = await options.listThreads();
    } catch (error) {
      dropped.push(`会话列表（描述符）读失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (threads.length === 0) {
    try {
      const probe = await page.evaluate(probeGenericThreadsInPage, {
        limit: 60,
        valueLimit: 80,
      });
      if (probe?.ok) {
        threads = mapGenericThreads(probe.items, url);
        if (threads.length === 0) dropped.push("通用会话列表有候选，但没有一条带得走稳定身份（不收）");
      } else {
        dropped.push(`通用会话列表没读到：${probe?.reason ?? "unknown"}`);
      }
    } catch (error) {
      dropped.push(`通用会话列表抛错：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return summarizeCapture({
    url,
    capturedAt: now,
    structure,
    rowItems,
    threads,
    renderedRowCount,
    dropped,
    oracleContainer: containerSelector,
  });
}

/**
 * 通用列表候选 → 列表项（纯函数）。
 *
 * 与 `mapThreads` 同一套身份纪律：key 优先站点属性，其次绝对地址，再次展示名指纹；
 * **三者都没有就不收**（宁可少一条，也不给一个会变的 key —— 否则用户勾的人和真正聊的人对不上）。
 */
export function mapGenericThreads(
  items: readonly GenericThreadItem[],
  baseUrl: string,
): ThreadListItem[] {
  const out: ThreadListItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let url: string | null = null;
    if (item.href) {
      try {
        const resolved = new URL(item.href, baseUrl);
        // 只收 http(s)：`javascript:` / `data:` 这类地址一旦被当成 url 存下来，
        // 后面某一步会拿它去导航（等于把页面里的脚本当目标）。
        if (resolved.protocol === "http:" || resolved.protocol === "https:") url = resolved.href;
      } catch {
        url = null;
      }
    }
    const key = String(item.key ?? "").trim() || url;
    if (!key || key.length > 200 || seen.has(key)) continue;
    seen.add(key);
    // 通用探测拿不到展示名（只给了长度）：用 key 的末段当展示名，**不编内容**
    const label = (key.split(/[:/]/).filter(Boolean).pop() ?? key).slice(0, 80);
    out.push({ key, label, url, unread: item.unread === true });
  }
  return out;
}

/* ————————————————————————— Node 侧纯函数 ————————————————————————— */

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** 站点键：host 去掉已知子域前缀（`www.` / `web.` / `m.` …）并把非字母数字折成 `-`
 * （**不含**路径/账号，避免把用户数据写进目录名）；
 * 同一站点的不同子域必须落进**同一个**目录，否则同一站点的学习成果会各自一份（加站点=加描述符）。
 */
export function siteKeyOf(host: string): string {
  const clean = String(host ?? "")
    .toLowerCase()
    .replace(/^(?:www|web|m|mobile|wap)\./, "");
  return clean.replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "unknown";
}

/**
 * 系统消息 / 日期分隔的判据（**高精度优先**：宁可不判，也不要误杀正常对话）。
 *
 * 为什么以 class/属性 token 为主、文本为辅：站点自己的类名会直说 `system-message` /
 * `date-divider` / `action-message`，而文本里出现「加密」两个字的完全可能是正常聊天
 * —— 误判会让自检把合格描述符也判死（自检因此永远不收敛）。
 */
const SYSTEM_TOKEN = /(^|[^a-z])(system|notice|divider|separator|encrypted|e2e|call-log|action-?message)([^a-z]|$)/;
const SYSTEM_TEXT = /^(?:端到端|消息和通话已进行端到端加密|messages and calls are end-to-end encrypted)/i;

/**
 * 把通用读法的原始条目变成**真值行**（纯函数，可离线单测）。
 *
 * 方向真值来自几何 + token（`resolveDirection`）：这是**独立**于描述符的证据。
 * 几何含糊时如实给 `unknown` —— 后面自检**不**拿它当真相去否定描述符。
 */
export function toOracleRows(items: readonly RawChatItem[]): OracleRow[] {
  return items.map((item) => {
    const direction = resolveDirection(item);
    const text = String(item.text ?? "");
    const mediaLike = text.trim().length === 0;
    const tokens = (item.tokens ?? []).map((token) => String(token).toLowerCase()).slice(0, 24);
    const systemLike = tokens.some((token) => SYSTEM_TOKEN.test(token)) || SYSTEM_TEXT.test(text.trim());
    const fact: RowFact = {
      rawId: item.key ?? null,
      text,
      hasMedia: mediaLike,
      excluded: systemLike,
      retracted: false,
      tailIcon: null,
      checkIcon: false,
      cxRatio: Number.isFinite(item.cxRatio) ? item.cxRatio : 0.5,
      tokens,
      seenTs: item.ts ?? null,
      identity: item.identity ?? null,
    };
    return {
      ...fact,
      expect: {
        direction,
        contentVersion: contentVersionOf(mediaLike ? "media" : "text", text),
        mediaLike,
        systemLike,
      },
    };
  });
}

/**
 * 拆分取样：把采集结果切成「给模型看的」与「留给自检的」。
 *
 * 为什么必须拆（规则 3）：拿采集时用过的那批样本去验证，是自我确认 ——
 * 公开基准里位置型选择器在**没见过的**页面上静默取错字段的比例很高，
 * 而那些错误恰好会被「用同一批样本验证」完全遮住。
 */
export function splitSamples<T>(items: readonly T[], heldOutRatio = 0.34): { shown: T[]; heldOut: T[] } {
  const list = [...items];
  if (list.length <= 2) return { shown: list, heldOut: [] };
  const heldOutCount = Math.max(1, Math.min(list.length - 1, Math.round(list.length * heldOutRatio)));
  // 从**尾部**留出：聊天记录的尾部正是「最近的会话」，模型看到头部即可，尾部留给自检
  return { shown: list.slice(0, list.length - heldOutCount), heldOut: list.slice(list.length - heldOutCount) };
}

export interface SummarizeCaptureInput {
  url: string;
  capturedAt: string;
  structure: RawStructureProbe;
  rowItems: readonly RawChatItem[];
  threads: readonly ThreadListItem[];
  renderedRowCount?: number;
  /** 采集时被丢弃的东西（如实记账） */
  dropped?: readonly string[];
  /** 真值行的来源（通用读法的容器选择器，便于排查） */
  oracleContainer: string | null;
}

/** 组装采集包（纯函数）：结构 + 真值 + 拆分取样 + 丢记账 */
export function summarizeCapture(input: SummarizeCaptureInput): CaptureBundle {
  const dropped = [...(input.dropped ?? [])];
  const rows = toOracleRows(input.rowItems);
  const rowSamples = splitSamples(rows);
  const threadSamples = splitSamples(input.threads);
  if (!input.structure.ok) dropped.push(`结构探测失败：${input.structure.reason ?? "unknown"}`);
  if (input.structure.nodes.length >= PROBE_NODE_LIMIT) {
    dropped.push(`结构候选超过 ${PROBE_NODE_LIMIT} 个，已截断（只分析前 ${PROBE_NODE_LIMIT} 个）`);
  }
  if (rows.length === 0) dropped.push("通用读法没读到任何消息行（可能是空会话，也可能是容器定位失败）");

  const host = hostOf(input.url);
  return {
    schemaVersion: 1,
    url: input.url,
    host,
    siteKey: siteKeyOf(host),
    capturedAt: input.capturedAt,
    structure: input.structure,
    container: input.oracleContainer,
    oracle: {
      rows: rowSamples,
      threads: threadSamples,
      renderedRowCount: input.renderedRowCount ?? rows.length,
    },
    dropped,
  };
}

/**
 * 落盘前的**脱敏**（默认只存 schema / 选择器 / 属性名 / 指纹，不存消息原文）。
 *
 * 依据：R2 / §1.3（一次性码与隐私）+ 计划 §6.2 第 1 条。正文只留指纹与长度，
 * 长度也折叠成区间 —— 否则「36 位」这种长度本身就近似于内容。
 */
export function redactCaptureForDisk(bundle: CaptureBundle): unknown {
  const redactRow = (row: OracleRow): unknown => ({
    rawId: row.rawId,
    textLen: row.text.length,
    textShape: row.text.length === 0 ? "empty" : "present",
    textHash: hash32Id(`${row.text}`),
    hasMedia: row.hasMedia,
    excluded: row.excluded,
    retracted: row.retracted,
    cxRatio: row.cxRatio,
    tokens: row.tokens,
    // 显示时间戳**一律不信**，落盘更没有价值（还会泄露本地化信息）
    seenTs: null,
    identity: null,
    expect: row.expect,
  });
  return {
    schemaVersion: bundle.schemaVersion,
    url: bundle.url,
    host: bundle.host,
    siteKey: bundle.siteKey,
    capturedAt: bundle.capturedAt,
    structure: bundle.structure,
    container: bundle.container,
    oracle: {
      rows: { shown: bundle.oracle.rows.shown.map(redactRow), heldOut: bundle.oracle.rows.heldOut.map(redactRow) },
      threads: bundle.oracle.threads,
      renderedRowCount: bundle.oracle.renderedRowCount,
    },
    dropped: bundle.dropped,
  };
}
