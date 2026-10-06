/**
 * 意图→目标关联仲裁（Intent → Target Affinity）
 *
 * 与 `hit_point.ts` 的分工（两者不是重复，是不同时刻的不同问题）：
 *   · `hit_point.ts` = **点击时刻**：模型已选了 index，把这个 index 的落点修正到真正生效的位置；
 *   · 本模块        = **观察时刻**：模型还没选，先把「这一行里到底谁才是该点的目标」写进元素列表。
 *
 * 典型事故（用户报障原型，结构完全通用）：
 *   一行里同时存在「我已经阅读并同意《隐私声明》」的**外链**和三态**复选框**。
 *   模型用户目标语义是「同意」，于是选中文案最贴近的 `<a>隐私声明</a>` →
 *   点击链路对 `<a>` 走 `self:actionable` 不做关联 → 页面跳转，注册流程崩掉。
 *
 * 本模块在观察层做两件事，全部基于**结构关系 + 几何 + 文本相似度**，零站点文案、零站内选择器：
 *   ① 关联（link）：为「同行文案/外链」标注它真正该点的控件（含可点坐标），列表里一眼可见；
 *   ② 救回（rescue）：控件被视觉折叠（`opacity:0` / 1×1 真框 + 自绘方框）时，
 *      正常提取会把它当不可见元素丢掉 —— 这里用视觉代理方框/宿主标签把它重新暴露成可交互条目，
 *      让模型有机会拿到它的 index，而不是被迫只能点到旁边的链接文字。
 *
 * 判定依据（写入 `reason`，便于日志与回归）：
 *   `label.control` / `label[for]` / `aria-labelledby-reverse` / `shared-label` / `row-container` / `ancestor-N`
 */

import type { Page } from "playwright-core";

export interface AffinityRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 观察层交给关联探测的「参照元素」：可能是外链、按钮、或一段行内文案 */
export interface AffinityPeer {
  /** 提取阶段的原始短 id（形如 e7），用于回填 */
  id: string;
  selector: string;
  xpath: string;
  /** 蒸馏类型：link / button / other / textbox … */
  type: string;
  text: string;
  rect?: AffinityRect | null;
}

export interface AffinityControl {
  selector: string;
  xpath: string;
  tag: string;
  role: string;
  inputType: string | null;
  /** 勾选态；非三态控件为 null */
  checked: boolean | null;
  /** 控件自身的可访问名（裸复选框通常为空 → 必须靠 rowText 补全身份） */
  label: string;
  /** 控件所在整行的可见文案，用于给控件补全可引用身份 */
  rowText: string;
  /** 控件真实几何；视觉折叠时可能为 0 宽高 */
  rect: AffinityRect | null;
  /** 可点区域：真实控件 / 视觉代理方框 / 宿主标签；供 SoM 与坐标兜底 */
  clickRect: AffinityRect | null;
  visible: boolean;
  /** 关联依据 */
  reason: string;
  score: number;
}

export interface AffinityLink {
  /** 参照元素的原始短 id */
  peerId: string;
  /** 该参照元素点击后会离开当前文档（`<a href>` 且非锚点） */
  navigates: boolean;
  control: AffinityControl;
}

export interface AffinityReport {
  links: AffinityLink[];
  stats: {
    peers: number;
    links: number;
    ms: number;
  };
}

export interface AffinityProbeOptions {
  maxDepth: number;
  maxScan: number;
  minScore: number;
  /** 页面内探测时间预算（ms） */
  budgetMs: number;
}

const EMPTY_REPORT: AffinityReport = {
  links: [],
  stats: { peers: 0, links: 0, ms: 0 },
};

export function emptyAffinityReport(): AffinityReport {
  return { links: [], stats: { ...EMPTY_REPORT.stats } };
}

/**
 * 页面内关联探测脚本。
 *
 * 注意：本函数会被**序列化后注入页面执行**，所有常量与依赖必须写在函数体内，
 * 不得引用模块作用域的任何标识符（历史事故：模块级常量在页面里 ReferenceError，
 * 被 try/catch 吞成空结果 → 静默失效）。
 */
function PROBE_AFFINITY_SCRIPT(input: {
  peers: Array<{ id: string; selector: string; xpath: string; type: string; text: string }>;
  maxDepth: number;
  maxScan: number;
  minScore: number;
  /** 页面内探测时间预算（ms）：超预算立即收尾，避免重型页面把观察卡死 */
  budgetMs: number;
}) {
  type Rect = { x: number; y: number; w: number; h: number };

  const startedAt = Date.now();
  const overBudget = (): boolean => Date.now() - startedAt > input.budgetMs;

  const CHOICE_SELECTOR =
    "input[type='checkbox'],input[type='radio'],[role='checkbox'],[role='radio'],[role='switch']";
  /** 行容器宽度不得超过视口这个比例（否则是整页容器，不是「一行」） */
  const ROW_MAX_WIDTH_RATIO = 0.6;
  /** 控件自身宽度上限：超过这个尺寸的多半不是勾选框 */
  const CONTROL_MAX_WIDTH = 64;
  /** 视觉代理方框的尺寸上限 */
  const PROXY_MAX_EDGE = 48;
  /** 同行允许的最大水平间隙 */
  const ROW_MAX_GAP = 64;

  function cleanText(value: string | null | undefined, max = 80): string {
    return String(value ?? "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function normalize(value: string): string {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[\s\u3000]+/g, "")
      .replace(/[，。、；：！？,.;:!?"'`()[\]{}<>《》「」『』|~^*]/g, "")
      .slice(0, 80);
  }

  /** 二元组 Dice：语言无关，不需要任何词典 */
  function dice(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = (s: string): Map<string, number> => {
      const out = new Map<string, number>();
      for (let i = 0; i < s.length - 1; i += 1) {
        const g = s.slice(i, i + 2);
        out.set(g, (out.get(g) ?? 0) + 1);
      }
      return out;
    };
    const ga = grams(a);
    const gb = grams(b);
    let overlap = 0;
    for (const [g, count] of ga) {
      const other = gb.get(g);
      if (other) overlap += Math.min(count, other);
    }
    return (2 * overlap) / (a.length - 1 + b.length - 1);
  }

  function rectOf(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function degenerate(rect: Rect | null): boolean {
    return !rect || rect.w < 2 || rect.h < 2;
  }

  function isRendered(el: Element): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.05) return false;
    return !degenerate(rectOf(el));
  }

  /** 页面内可见但可能被视觉折叠：只看布局是否占位（opacity/尺寸都可能是 0） */
  function isLaidOut(el: Element): boolean {
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function cssEscape(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }

  function buildXPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && parts.length < 14) {
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(siblings.length <= 1 ? tag : `${tag}[${siblings.indexOf(cur) + 1}]`);
      cur = parent;
    }
    return `/${parts.join("/")}`;
  }

  function buildSelector(el: Element): string {
    const htmlEl = el as HTMLElement;
    const id = cleanText(htmlEl.id, 80);
    if (id && !/^\d+$/.test(id)) {
      try {
        if (document.querySelectorAll(`#${cssEscape(id)}`).length === 1) return `#${cssEscape(id)}`;
      } catch {
        /* ignore */
      }
    }
    for (const attr of ["data-testid", "data-test", "data-qa", "name", "aria-label"]) {
      const value = cleanText(el.getAttribute(attr), 80);
      if (!value) continue;
      const candidate = `${el.tagName.toLowerCase()}[${attr}="${value.replace(/"/g, '\\"')}"]`;
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        /* ignore */
      }
    }
    const type = cleanText(el.getAttribute("type"), 24);
    if (type) {
      const candidate = `${el.tagName.toLowerCase()}[type="${type}"]`;
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        /* ignore */
      }
    }
    return buildXPath(el);
  }

  /** 可访问名（结构化顺序，与 ARIA 一致） */
  function accessibleName(el: Element): string {
    const aria = cleanText(el.getAttribute("aria-label"), 60);
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => cleanText(document.getElementById(id)?.textContent, 60))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      const labels = el.labels;
      if (labels && labels.length) {
        const text = cleanText(
          Array.from(labels)
            .map((l) => l.textContent)
            .join(" "),
          60,
        );
        if (text) return text;
      }
    }
    const title = cleanText(el.getAttribute("title"), 60);
    if (title) return title;
    return "";
  }

  function checkedState(el: Element): boolean | null {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      return el.checked;
    }
    const aria = el.getAttribute("aria-checked");
    if (aria === "true") return true;
    if (aria === "false") return false;
    if (el.getAttribute("role") === "switch") {
      const cls = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "";
      if (/unchecked|off\b/i.test(cls)) return false;
      if (/checked|on\b/i.test(cls)) return true;
    }
    return null;
  }

  /** 控件所在的「整行文案」：优先包裹 label，其次最近的短文本祖先（给裸控件补身份用） */
  function rowTextOf(el: Element): string {
    const label = el.closest("label");
    if (label) {
      const text = cleanText(label.textContent, 120);
      if (text.length >= 2) return text;
    }
    let cur: Element | null = el.parentElement;
    for (let depth = 0; cur && depth < 3; depth += 1) {
      const text = cleanText(cur.textContent, 120);
      if (text.length >= 2) {
        const rect = rectOf(cur);
        if (rect.w <= window.innerWidth * ROW_MAX_WIDTH_RATIO && rect.h <= 240) return text;
      }
      cur = cur.parentElement;
    }
    return "";
  }

  /** 视觉代孕矩形：真实几何不可用时，退到自绘方框 / 包裹 label / 小宿主容器 */
  function clickRectOf(control: Element): Rect | null {
    const real = rectOf(control);
    if (!degenerate(real)) return real;

    const host = control.parentElement;
    if (host) {
      let best: { rect: Rect; score: number } | null = null;
      for (const sibling of Array.from(host.children).slice(0, 24)) {
        if (sibling === control || !isRendered(sibling)) continue;
        const rect = rectOf(sibling);
        if (rect.w > PROXY_MAX_EDGE || rect.h > PROXY_MAX_EDGE) continue;
        if (rect.w < 6 || rect.h < 6) continue;
        if (cleanText(sibling.textContent, 8).length > 3) continue;
        const squareish = 1 - Math.min(1, Math.abs(rect.w - rect.h) / Math.max(1, rect.w));
        const score = squareish + (rect.w <= 28 ? 0.4 : 0);
        if (!best || score > best.score) best = { rect, score };
      }
      if (best) return best.rect;
    }

    const label = control.closest("label");
    if (label && isRendered(label)) return rectOf(label);

    if (host && isRendered(host)) {
      const rect = rectOf(host);
      if (rect.w <= CONTROL_MAX_WIDTH * 3 && rect.h <= 96) return rect;
    }
    return null;
  }

  function verticalOverlap(a: Element, b: Element): number {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const top = Math.max(ra.top, rb.top);
    const bottom = Math.min(ra.bottom, rb.bottom);
    const overlap = Math.max(0, bottom - top);
    const base = Math.max(1, Math.min(ra.height, rb.height));
    return Math.max(0, Math.min(1, overlap / base));
  }

  /** 两个矩形之间的水平间隙（重叠为 0） */
  function horizontalGapRect(a: Rect, b: { left: number; right: number }): number {
    const aRight = a.x + a.w;
    if (aRight < b.left) return b.left - aRight;
    if (b.right < a.x) return a.x - b.right;
    return 0;
  }

  function resolvePeer(peer: { selector: string; xpath: string }): Element | null {
    const selector = String(peer.selector ?? "").trim();
    const xpath = String(peer.xpath ?? "").trim();
    if (selector) {
      try {
        const hit = document.querySelector(selector);
        if (hit) return hit;
      } catch {
        /* 非法 CSS → 退 xpath */
      }
    }
    if (xpath) {
      try {
        const result = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        const node = result.singleNodeValue;
        if (node instanceof Element) return node;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /** 参照元素点击后是否会离开当前文档（通用事实推断，不依赖任何站点域名） */
  function navigatesAway(el: Element): boolean {
    if (!(el instanceof HTMLAnchorElement)) return false;
    const href = cleanText(el.getAttribute("href"), 400);
    if (!href) return false;
    if (href.startsWith("#")) return false;
    if (/^javascript:/i.test(href)) return false;
    try {
      const target = new URL(el.href, location.href);
      if (target.origin !== location.origin) return true;
      // 同源但改了 path/query：同样是离开当前表单上下文
      return target.pathname !== location.pathname || target.search !== location.search;
    } catch {
      return false;
    }
  }

  interface Candidate {
    el: Element;
    reason: string;
    structure: number;
    depth: number;
  }

  /** 结构化关联候选：只做「谁的标签是这个参照元素」这类硬关系 */
  function structuralCandidates(peer: Element): Candidate[] {
    const out: Candidate[] = [];
    const push = (el: Element | null, reason: string, structure: number, depth: number) => {
      if (!el || el === peer) return;
      if (!out.some((c) => c.el === el)) out.push({ el, reason, structure, depth });
    };

    const wrapping = peer.closest("label");
    if (wrapping instanceof HTMLLabelElement) {
      const control =
        (wrapping as HTMLLabelElement & { control?: Element | null }).control ??
        (wrapping.htmlFor ? document.getElementById(wrapping.htmlFor) : null);
      if (control && control.matches(CHOICE_SELECTOR)) {
        push(control, "shared-label", 0.34, 0);
      }
    }

    if (peer.id) {
      try {
        for (const linked of Array.from(document.querySelectorAll("label[for]"))) {
          if (linked.getAttribute("for") !== peer.id) continue;
          const control = document.getElementById(peer.id);
          if (control && control.matches(CHOICE_SELECTOR)) {
            push(control, "label[for]", 0.36, 0);
          }
        }
      } catch {
        /* ignore */
      }
      // aria-labelledby 反向：谁把参照元素当自己的标签
      let container: Element | null = peer.parentElement;
      for (let depth = 0; container && depth < input.maxDepth; depth += 1) {
        for (const el of Array.from(container.querySelectorAll(CHOICE_SELECTOR)).slice(0, input.maxScan)) {
          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy && labelledBy.split(/\s+/).includes(peer.id)) {
            push(el, "aria-labelledby-reverse", 0.4, depth);
          }
        }
        container = container.parentElement;
      }
    }
    return out;
  }

  /** 行容器候选：同一「视觉一行」内的勾选控件（文本相似 + 垂直重叠 + 水平邻近） */
  function rowCandidates(peer: Element): Candidate[] {
    const out: Candidate[] = [];
    const peerRect = peer.getBoundingClientRect();
    const peerText = normalize(cleanText(peer.textContent, 80));
    const peerDiagonal = Math.max(1, Math.hypot(peerRect.width, peerRect.height));
    let container: Element | null = peer.parentElement;
    for (let depth = 0; container && depth < input.maxDepth; depth += 1) {
      if (overBudget()) break;
      const containerRect = container.getBoundingClientRect();
      if (containerRect.width > window.innerWidth * ROW_MAX_WIDTH_RATIO) break;
      for (const el of Array.from(
        container.querySelectorAll(CHOICE_SELECTOR),
      ).slice(0, input.maxScan)) {
        if (el === peer) continue;
        if (!isLaidOut(el)) continue;
        const controlRect = el.getBoundingClientRect();
        const visual = clickRectOf(el);
        const visualRect = visual ?? { x: Math.round(controlRect.left), y: Math.round(controlRect.top), w: Math.round(controlRect.width), h: Math.round(controlRect.height) };
        if (visualRect.w > CONTROL_MAX_WIDTH) continue;
        if (containerRect.height > Math.max(24, 3 * Math.max(peerRect.height, visualRect.h))) break;

        const overlap = verticalOverlap(el, peer);
        const centerDelta = Math.abs(
          visualRect.y + visualRect.h / 2 - (peerRect.top + peerRect.height / 2),
        );
        const sameLine = overlap >= 0.5 || centerDelta <= Math.max(10, peerRect.height * 0.6);
        if (!sameLine) continue;
        const gap = horizontalGapRect(visualRect, peerRect);
        if (gap > ROW_MAX_GAP) continue;

        const distance = Math.hypot(
          visualRect.x + visualRect.w / 2 - (peerRect.left + peerRect.width / 2),
          visualRect.y + visualRect.h / 2 - (peerRect.top + peerRect.height / 2),
        );
        const proximity = 1 - Math.min(1, distance / Math.max(1, peerDiagonal * 3));
        const nameText = normalize(accessibleName(el) || cleanText(el.textContent, 60));
        const rowText = normalize(rowTextOf(el));
        const textAffinity = Math.max(
          peerText && nameText ? dice(peerText, nameText) : 0,
          peerText && rowText ? dice(peerText, rowText) : 0,
        );
        const score = 0.3 + 0.25 * textAffinity + 0.2 * overlap + 0.15 * proximity;
        out.push({ el, reason: depth === 0 ? "row-container" : `ancestor-${depth}`, structure: score - 0.3, depth });
      }
      container = container.parentElement;
    }
    return out;
  }

  interface LinkOut {
    peerId: string;
    navigates: boolean;
    control: {
      selector: string;
      xpath: string;
      tag: string;
      role: string;
      inputType: string | null;
      checked: boolean | null;
      label: string;
      rowText: string;
      rect: Rect | null;
      clickRect: Rect | null;
      visible: boolean;
      reason: string;
      score: number;
    };
  }

  const links: LinkOut[] = [];

  for (const peer of input.peers) {
    if (overBudget()) break;
    const el = resolvePeer(peer);
    if (!el) continue;
    if (el.matches(CHOICE_SELECTOR)) continue;
    if (!isLaidOut(el)) continue;

    const peerRect = el.getBoundingClientRect();
    const peerDiagonal = Math.max(1, Math.hypot(peerRect.width, peerRect.height));
    const peerText = normalize(cleanText(el.textContent, 80));

    const candidates = [...structuralCandidates(el), ...rowCandidates(el)];
    let best: { candidate: Candidate; score: number } | null = null;
    for (const candidate of candidates) {
      const controlRectRaw = candidate.el.getBoundingClientRect();
      const visual = clickRectOf(candidate.el);
      const visualRect =
        visual ??
        {
          x: Math.round(controlRectRaw.left),
          y: Math.round(controlRectRaw.top),
          w: Math.round(controlRectRaw.width),
          h: Math.round(controlRectRaw.height),
        };
      const overlap = verticalOverlap(candidate.el, el);
      const distance = Math.hypot(
        visualRect.x + visualRect.w / 2 - (peerRect.left + peerRect.width / 2),
        visualRect.y + visualRect.h / 2 - (peerRect.top + peerRect.height / 2),
      );
      const proximity = 1 - Math.min(1, distance / Math.max(1, peerDiagonal * 3));
      const nameText = normalize(accessibleName(candidate.el));
      const textAffinity = peerText && nameText ? dice(peerText, nameText) : 0;
      const score =
        0.3 +
        candidate.structure +
        0.25 * textAffinity +
        0.2 * overlap +
        0.15 * proximity -
        candidate.depth * 0.03;
      if (!best || score > best.score) best = { candidate, score };
    }
    if (!best || best.score < input.minScore) continue;

    const control = best.candidate.el;
    const controlRect = rectOf(control);
    const payload = {
      selector: buildSelector(control),
      xpath: buildXPath(control),
      tag: control.tagName.toLowerCase(),
      role: (control.getAttribute("role") ?? "").toLowerCase(),
      inputType: cleanText(control.getAttribute("type"), 24) || null,
      checked: checkedState(control),
      label: cleanText(accessibleName(control) || control.getAttribute("name"), 60),
      rowText: rowTextOf(control),
      rect: degenerate(controlRect) ? null : controlRect,
      clickRect: clickRectOf(control),
      visible: isRendered(control),
      reason: best.candidate.reason,
      score: Number(best.score.toFixed(3)),
    };

    links.push({ peerId: peer.id, navigates: navigatesAway(el), control: payload });
  }

  return { links };
}

/** 执行页面内关联探测；任何异常都软着陆成空报告，绝不阻断观察主链路 */
export async function resolveAffinities(
  page: Page,
  peers: AffinityPeer[],
  options: AffinityProbeOptions,
): Promise<AffinityReport> {
  if (!peers.length) return emptyAffinityReport();
  const started = Date.now();
  const payload = {
    peers: peers.map((p) => ({
      id: p.id,
      selector: p.selector,
      xpath: p.xpath,
      type: p.type,
      text: p.text,
    })),
    maxDepth: Math.max(1, options.maxDepth),
    maxScan: Math.max(4, options.maxScan),
    minScore: options.minScore,
    budgetMs: Math.max(50, options.budgetMs),
  };
  try {
    const raw = (await page.evaluate(PROBE_AFFINITY_SCRIPT, payload)) as {
      links?: AffinityLink[];
    } | null;
    const links = Array.isArray(raw?.links) ? (raw!.links as AffinityLink[]) : [];
    return {
      links,
      stats: { peers: peers.length, links: links.length, ms: Date.now() - started },
    };
  } catch {
    return { ...emptyAffinityReport(), stats: { peers: peers.length, links: 0, ms: Date.now() - started } };
  }
}

/** 需要参与关联探测的参照元素类型：会「抢走」勾选意图的文案型/动作型条目 */
const PEER_TYPES = new Set(["link", "button", "other"]);

/**
 * 从提取结果里挑选参照元素：只需要「有文案、且不是表单控件」的条目。
 * 上限截断按「视口内优先」排序，避免重型页面上探测成本失控。
 */
export function buildAffinityPeers(
  llmJson: Array<{ id: string; type: string; text?: string }>,
  elementMap: Map<
    string,
    {
      selector: string;
      xpath: string;
      tagName?: string;
      rect?: AffinityRect | null;
      frameUrl?: string | null;
    }
  >,
  limit: number,
  viewport?: { width: number; height: number } | null,
): AffinityPeer[] {
  const scored: Array<{ peer: AffinityPeer; rank: number }> = [];
  for (const el of llmJson) {
    const type = String(el.type ?? "").toLowerCase();
    if (!PEER_TYPES.has(type)) continue;
    const text = String(el.text ?? "").trim();
    if (text.length < 2) continue;
    const ref = elementMap.get(el.id);
    if (!ref) continue;
    // 嵌套框架元素的选择器只在它自己的文档里有效，而关联探查跑在主文档：
    // 拿它去做主文档查找会命中同名的无关元素，从而给出**错误**的归属裁决。
    // 宁可不裁决，也不能给错 —— 框架内的关联留到「按文档分组探查」再补。
    if (ref.frameUrl) continue;
    const rect = ref.rect ?? null;
    let rank = type === "link" ? 0 : type === "button" ? 1 : 2;
    if (rect && viewport && viewport.width > 0 && viewport.height > 0) {
      const onScreen =
        rect.x + rect.w > 0 && rect.y + rect.h > 0 && rect.x < viewport.width && rect.y < viewport.height;
      if (!onScreen) rank += 4;
    }
    scored.push({
      peer: {
        id: el.id,
        selector: ref.selector,
        xpath: ref.xpath ?? "",
        type,
        text,
        rect,
      },
      rank,
    });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, Math.max(0, limit)).map((row) => row.peer);
}

export interface AffinityIndex {
  byPeer: Map<string, AffinityLink>;
  /** 提取阶段漏掉、需在观察层补回的勾选控件 */
  rescued: AffinityControl[];
  /** 关联依据直方图，便于日志解释「凭什么这么判」 */
  reasons: Record<string, number>;
}

function isChoiceControl(control: AffinityControl): boolean {
  if (control.inputType === "checkbox" || control.inputType === "radio") return true;
  return control.role === "checkbox" || control.role === "radio" || control.role === "switch";
}

function rectCenter(rect: AffinityRect | null): { x: number; y: number } | null {
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/**
 * 把页面探针结果整理成可直接消费的索引：
 *   · `byPeer` 供观察层给「同行文案」补一句「你真正该点的是 [N]」；
 *   · `rescued` 是提取阶段漏掉的勾选控件（视觉折叠：`opacity:0` 真框 + 自绘方框），
 *     必须在观察层补成独立条目，否则模型只能点到旁边的链接文字 —— 这正是用户报障的形态。
 *
 * 判定「漏掉」时不只看 selector/xpath 字符串：提取层可能用另一套选择器描述了同一视觉目标，
 * 因此再加一道「视觉中心重合」判据，避免同一目标被重复暴露成两条 index。
 */
export function buildAffinityIndex(
  report: AffinityReport,
  elementMap: Map<string, { selector?: string; xpath?: string; tagName?: string; rect?: AffinityRect | null }>,
): AffinityIndex {
  const byPeer = new Map<string, AffinityLink>();
  const reasons: Record<string, number> = {};
  const knownSelectors = new Set<string>();
  const knownXpaths = new Set<string>();
  const knownCenters: Array<{ x: number; y: number }> = [];
  for (const ref of elementMap.values()) {
    if (ref.selector) knownSelectors.add(ref.selector);
    if (ref.xpath) knownXpaths.add(ref.xpath);
    const center = rectCenter(ref.rect ?? null);
    if (center) knownCenters.push(center);
  }

  const rescued: AffinityControl[] = [];
  const rescuedSeen = new Set<string>();
  for (const link of report.links) {
    if (!link?.control) continue;
    byPeer.set(link.peerId, link);
    reasons[link.control.reason] = (reasons[link.control.reason] ?? 0) + 1;

    if (!isChoiceControl(link.control)) continue;
    if (knownSelectors.has(link.control.selector)) continue;
    if (link.control.xpath && knownXpaths.has(link.control.xpath)) continue;
    const center = rectCenter(link.control.clickRect) ?? rectCenter(link.control.rect);
    if (
      center &&
      knownCenters.some((known) => Math.abs(known.x - center.x) <= 4 && Math.abs(known.y - center.y) <= 4)
    ) {
      continue;
    }
    const key = link.control.xpath || link.control.selector;
    if (!key || rescuedSeen.has(key)) continue;
    rescuedSeen.add(key);
    rescued.push(link.control);
  }

  return { byPeer, rescued, reasons };
}

/** 同伴条目的纠偏指引所需的最小信息（与 `AgentElementAffinity` 结构兼容） */
export interface CompanionHintInput {
  affinity?: {
    kind: "choice-control" | "choice-companion";
    targetId?: string;
    targetText?: string;
    navigates?: boolean;
    reason: string;
  } | null;
}

/**
 * 同伴条目的纠偏指引：模型点到的是同行文案/外链（而不是控件本身）时，
 * 在动作结果里点名真正该点的 index —— 只做提示，绝不劫持用户的选择。
 */
export function describeCompanionHint(el: CompanionHintInput): string {
  const affinity = el?.affinity;
  if (!affinity || affinity.kind !== "choice-companion" || !affinity.targetId) return "";
  const what = affinity.navigates ? "同行外链（点击会离开当前页面）" : "同行文案";
  const target = affinity.targetText
    ? `[${affinity.targetId}]「${affinity.targetText}」`
    : `[${affinity.targetId}]`;
  return `；注意：本条只是${what}，若要完成勾选/同意，请改点 ${target}`;
}

