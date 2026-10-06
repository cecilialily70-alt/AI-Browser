/**
 * 遮挡层探针（Popup / Overlay Probe）
 *
 * 纯结构信号识别「浮在内容之上、正在阻挡交互」的层，**不依赖任何站点文案或选择器**：
 *   - 定位方式（fixed / sticky / absolute+z-index / top-layer `dialog[open]` / `[popover]`）
 *   - 对话框语义（role=dialog|alertdialog / aria-modal）
 *   - z-index 相对页面中位数
 *   - 面积覆盖比 + 是否真的挡住了视口中心命中的元素
 *   - 容器内是否存在可点击控件（没有控件的层不构成交互阻挡）
 *
 * 同时给出两类「关闭候选」：
 *   1. 层内可点击控件（含无文案图标钮、aria-label 钮）
 *   2. backdrop 空点：层矩形内、但落在对话框盒子之外的点（点空白关闭，承诺度最低）
 *
 * 排序与判定在 Node 侧完成（obstacle_arbiter.ts），本模块只负责如实采集。
 */
import type { DomScope } from "./dom_scope.js";
import { structureFingerprint } from "./interaction_lexicon.js";

export interface ProbeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type OverlayControlKind = "backdrop" | "control";

export interface OverlayControlCandidate {
  /** 本次探针内的稳定序号（用于回传模型 / 日志） */
  index: number;
  selector: string;
  xpath: string;
  name: string;
  tag: string;
  role: string;
  kind: OverlayControlKind;
  iconOnly: boolean;
  hasAriaLabel: boolean;
  disabled: boolean;
  rect: ProbeRect;
  /** 0..1，越接近对话框角点越大 */
  cornerAffinity: number;
  /** 相对弹层面积（越小越像关闭叉） */
  areaRatio: number;
  /** 结构信号标签，仅用于诊断与打分解释 */
  signals: string[];
}

export interface OverlayDescriptor {
  key: string;
  fingerprint: string;
  skeleton: string;
  label: string;
  tag: string;
  id: string;
  className: string;
  role: string;
  ariaModal: boolean;
  zIndex: number;
  coverRatio: number;
  rect: ProbeRect;
  /** 视口中心命中的元素是否落在本层内（即本层确实在最上面） */
  topmostAtCenter: boolean;
  depth: number;
  controls: OverlayControlCandidate[];
  /** 点空白关闭的候选点（层内、对话框盒子外） */
  backdropPoint: { x: number; y: number } | null;
  /** 对话框盒子（用于判断关闭候选是否在框内） */
  dialogRect: ProbeRect | null;
}

export interface OverlayProbeResult {
  url: string;
  viewport: { width: number; height: number };
  overlays: OverlayDescriptor[];
  error: string | null;
}

/** 页面内探针：返回可 JSON 序列化的纯数据 */
function PROBE_OVERLAYS_SCRIPT() {
  /** 注意：全部常量必须定义在函数体内——本函数会被序列化后注入页面执行 */
  const MAX_OVERLAYS = 8;
  const MAX_CONTROLS_PER_OVERLAY = 24;
  const Z_SAMPLE_LIMIT = 500;
  const RENDERED_MIN_AREA = 16;

  function isRendered(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.05) return false;
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height >= RENDERED_MIN_AREA;
  }

  function rectOf(el: Element): { x: number; y: number; w: number; h: number } {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  function cleanText(value: string | null | undefined, max = 60): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function accessibleName(el: HTMLElement): string {
    const aria = cleanText(el.getAttribute("aria-label"));
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => cleanText(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    const title = cleanText(el.getAttribute("title"));
    if (title) return title;
    const alt = cleanText(el.getAttribute("alt"));
    if (alt) return alt;
    const inner = cleanText(el.textContent);
    if (inner) return inner;
    const value = cleanText((el as HTMLInputElement).value);
    if (value) return value;
    return "";
  }

  function cssEscape(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }

  function stableClassToken(el: Element): string {
    const raw = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "";
    const tokens = raw
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && t.length < 40 && !/^[a-f0-9_-]{10,}$/i.test(t) && !/^\d/.test(t));
    return tokens.slice(0, 3).join(".");
  }

  function buildXPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && parts.length < 12) {
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
    if (id && !/^\d+$/.test(id) && document.querySelectorAll(`#${cssEscape(id)}`).length === 1) {
      return `#${cssEscape(id)}`;
    }
    for (const attr of ["data-testid", "data-test", "data-qa", "name", "aria-label"]) {
      const value = cleanText(el.getAttribute(attr), 80);
      if (!value) continue;
      const candidate = `${el.tagName.toLowerCase()}[${attr}="${value.replace(/"/g, '\\"')}"]`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const cls = stableClassToken(el);
    if (cls) {
      const candidate = `${el.tagName.toLowerCase()}.${cls.split(".").join(".")}`;
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        /* ignore */
      }
    }
    return buildXPath(el);
  }

  function skeletonOf(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && depth < 6) {
      const tag = cur.tagName.toLowerCase();
      const role = cur.getAttribute("role") || "";
      const ariaModal = cur.getAttribute("aria-modal") || "";
      parts.push(`${tag}[${role}|${ariaModal}|${stableClassToken(cur)}]`);
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join(">");
  }

  const CLICKABLE_SELECTOR = [
    "button",
    "[role='button']",
    "[role='link']",
    "[role='menuitem']",
    "a[href]",
    "input[type='button']",
    "input[type='submit']",
    "input[type='reset']",
    "summary",
    "[onclick]",
    "[data-dismiss]",
    "[data-close]",
    "[data-action]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const viewportArea = vw * vh;

  // 页面 z-index 中位数：用于判断「浮层的 z-index 是否真的高于普通内容」
  const zSamples: number[] = [];
  const sampled = Array.from(document.querySelectorAll("body *")).slice(0, Z_SAMPLE_LIMIT);
  for (const node of sampled) {
    if (!(node instanceof HTMLElement)) continue;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const z = Number.parseInt(style.zIndex || "", 10);
    if (Number.isFinite(z)) zSamples.push(z);
  }
  zSamples.sort((a, b) => a - b);
  const zMedian = zSamples.length ? zSamples[Math.floor(zSamples.length / 2)]! : 0;

  const centerHit = document.elementFromPoint(Math.round(vw / 2), Math.round(vh / 2));

  interface Raw {
    el: HTMLElement;
    cover: number;
    z: number;
    role: string;
    ariaModal: boolean;
    dialogLike: boolean;
    topmostAtCenter: boolean;
    depth: number;
  }

  const raw: Raw[] = [];

  /** 满页遮罩的判定：内含对话框语义后代，或自身有可见背景（半透明蒙层/背板） */
  function hasOverlayDescendant(el: HTMLElement): boolean {
    return (
      el.querySelector(
        "[role='dialog'],[role='alertdialog'],[aria-modal='true'],dialog[open],[popover]",
      ) !== null
    );
  }

  function hasBackdropPaint(style: CSSStyleDeclaration): boolean {
    const bg = (style.backgroundColor || "").trim();
    let alpha = 0;
    const match = bg.match(/rgba?\(([^)]+)\)/i);
    if (match) {
      const parts = match[1]!.split(",").map((piece) => Number.parseFloat(piece.trim()));
      alpha = parts.length >= 4 ? parts[3]! : 1;
    } else if (bg && bg !== "transparent") {
      alpha = 1;
    }
    if (alpha >= 0.05) return true;
    if (style.backgroundImage && style.backgroundImage !== "none") return true;
    if (style.backdropFilter && style.backdropFilter !== "none") return true;
    return false;
  }

  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (!(el instanceof HTMLElement)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "html" || tag === "body") continue;
    if (!isRendered(el)) continue;

    const style = window.getComputedStyle(el);
    if (style.pointerEvents === "none") continue;

    const rect = el.getBoundingClientRect();
    const cover = (rect.width * rect.height) / viewportArea;

    const pos = style.position;
    const z = Number.parseInt(style.zIndex || "", 10);
    const zIndex = Number.isFinite(z) ? z : 0;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const ariaModal = el.getAttribute("aria-modal") === "true";
    const dialogLike =
      role === "dialog" ||
      role === "alertdialog" ||
      ariaModal ||
      (tag === "dialog" && (el as HTMLDialogElement).open === true);

    const topLayer =
      dialogLike || el.hasAttribute("popover") || el.matches("dialog[open]");
    const floating =
      topLayer || ((pos === "fixed" || pos === "sticky" || pos === "absolute") && zIndex >= 0);

    if (!floating) continue;

    // 壳层排除：几乎铺满整页、又无对话框语义、且完全透明（透明满页容器是布局壳，不是遮罩层）
    if (cover >= 0.97 && !dialogLike && !hasOverlayDescendant(el) && !hasBackdropPaint(style)) {
      continue;
    }
    // 长正文容器排除（内容页不是弹层）
    if (!dialogLike && cleanText(el.textContent, 4001).length > 4000) continue;

    const bigEnough = cover >= 0.03 || (rect.width >= 220 && rect.height >= 120);
    if (!bigEnough) continue;

    const hasClickable = el.querySelector(CLICKABLE_SELECTOR) !== null;
    if (!hasClickable) continue;

    const aboveMedian = zIndex > 0 && zIndex >= zMedian;
    if (!dialogLike && !aboveMedian && cover < 0.2) continue;

    const topmostAtCenter =
      centerHit instanceof Element && (el === centerHit || el.contains(centerHit));

    raw.push({
      el,
      cover,
      z: zIndex,
      role,
      ariaModal,
      dialogLike,
      topmostAtCenter,
      depth: 0,
    });
  }

  // 只保留最内层：若 A 是 B 的祖先，丢弃 A（真正的弹层盒是最内层的那个）
  const innermost = raw.filter(
    (candidate) =>
      !raw.some((other) => other !== candidate && candidate.el.contains(other.el)),
  );

  /**
   * 满页遮罩同样必须保留：目标常常被「对话框盒子之外」的蒙层挡住，
   * 而只报对话框盒子会导致「目标点未被任何层覆盖」的漏判（点击被静默吞掉）。
   */
  const dialogElements = raw.filter((item) => item.dialogLike).map((item) => item.el);
  const backdrops = raw.filter(
    (item) =>
      !item.dialogLike &&
      item.cover >= 0.9 &&
      !innermost.includes(item) &&
      dialogElements.some((dialogEl) => item.el.contains(dialogEl)),
  );
  const ordered = [...innermost, ...backdrops];

  // 层级深度：用于稳定性排序
  for (const item of ordered) {
    let depth = 0;
    let cur: Element | null = item.el.parentElement;
    while (cur) {
      depth += 1;
      cur = cur.parentElement;
    }
    item.depth = depth;
  }

  const sortRank = (item: Raw): number =>
    (item.topmostAtCenter ? 1_000_000 : 0) +
    (item.dialogLike ? 100_000 : 0) +
    Math.round(item.z) * 100 +
    Math.round(item.cover * 100);

  ordered.sort((a, b) => sortRank(b) - sortRank(a));

  const overlays: OverlayDescriptor[] = [];

  for (const item of ordered.slice(0, MAX_OVERLAYS)) {
    const el = item.el;
    const rect = rectOf(el);

    const dialogHit = document.elementFromPoint(
      Math.round(rect.x + rect.w / 2),
      Math.round(rect.y + rect.h / 2),
    );
    const dialogBox =
      (dialogHit instanceof Element &&
        (dialogHit.closest("[role='dialog'],[role='alertdialog'],[aria-modal='true']") ??
          dialogHit)) ||
      null;

    const controls: OverlayControlCandidate[] = [];
    const seenKeys = new Set<string>();

    const pushControl = (node: HTMLElement, kind: OverlayControlKind, extra: string[]): void => {
      if (controls.length >= MAX_CONTROLS_PER_OVERLAY) return;
      if (!isRendered(node)) return;
      if (node instanceof HTMLInputElement && node.disabled) return;
      if (node.getAttribute("aria-disabled") === "true") return;
      const nodeRect = rectOf(node);
      if (kind === "control" && (nodeRect.w < 6 || nodeRect.h < 6)) return;

      const selector = buildSelector(node);
      const key = `${kind}:${selector}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      const name = accessibleName(node);
      const ariaLabel = cleanText(node.getAttribute("aria-label"));
      const style = window.getComputedStyle(node);
      const isPointer = style.cursor === "pointer";
      const hasOnClick = typeof (node as HTMLElement).onclick === "function" || node.hasAttribute("onclick");

      const signals: string[] = [...extra];
      if (ariaLabel) signals.push("aria-label");
      if (isPointer) signals.push("cursor:pointer");
      if (hasOnClick) signals.push("onclick");
      if (node.tagName.toLowerCase() === "button" || node.getAttribute("role") === "button") {
        signals.push("button-semantic");
      }
      if (/svg|path/i.test(`${node.tagName}`) || node.querySelector("svg, path, i, img")) {
        signals.push("glyph-host");
      }
      if (node.matches("[data-dismiss],[data-close]")) signals.push("dismiss-attr");
      if (dialogBox && (node === dialogBox || dialogBox.contains(node))) signals.push("in-dialog");

      // 角邻近度：离最近的对话框角点越近越像关闭钮
      const ref = dialogBox ? rectOf(dialogBox) : rect;
      const cx = nodeRect.x + nodeRect.w / 2;
      const cy = nodeRect.y + nodeRect.h / 2;
      const corners = [
        [ref.x, ref.y],
        [ref.x + ref.w, ref.y],
        [ref.x, ref.y + ref.h],
        [ref.x + ref.w, ref.y + ref.h],
      ];
      let best = Number.POSITIVE_INFINITY;
      for (const [px, py] of corners) {
        const distance = Math.hypot(cx - px!, cy - py!);
        if (distance < best) best = distance;
      }
      const diagonal = Math.max(1, Math.hypot(ref.w, ref.h));
      const cornerAffinity = Math.max(0, Math.min(1, 1 - best / diagonal));

      controls.push({
        index: controls.length,
        selector,
        xpath: buildXPath(node),
        name,
        tag: node.tagName.toLowerCase(),
        role: (node.getAttribute("role") || "").toLowerCase(),
        kind,
        iconOnly: name.length <= 3,
        hasAriaLabel: Boolean(ariaLabel),
        disabled: false,
        rect: nodeRect,
        cornerAffinity: Number(cornerAffinity.toFixed(3)),
        areaRatio: Number(
          Math.min(1, (nodeRect.w * nodeRect.h) / Math.max(1, rect.w * rect.h)).toFixed(4),
        ),
        signals,
      });
    };

    const scoped = Array.from(el.querySelectorAll(CLICKABLE_SELECTOR)).slice(0, 80);
    for (const node of scoped) {
      if (node instanceof HTMLElement) pushControl(node, "control", []);
    }
    if (el.matches(CLICKABLE_SELECTOR)) pushControl(el, "control", ["self-clickable"]);

    // backdrop 空点：层内、对话框盒子外的点（点空白关闭，承诺度最低）
    let backdropPoint: { x: number; y: number } | null = null;
    if (dialogBox && dialogBox !== el) {
      const box = rectOf(dialogBox);
      const candidates = [
        { x: rect.x + 6, y: rect.y + 6 },
        { x: rect.x + rect.w - 6, y: rect.y + 6 },
        { x: rect.x + 6, y: rect.y + rect.h - 6 },
        { x: rect.x + rect.w - 6, y: rect.y + rect.h - 6 },
        { x: rect.x + Math.round(rect.w / 2), y: rect.y + 6 },
        { x: rect.x + Math.round(rect.w / 2), y: rect.y + rect.h - 6 },
      ];
      for (const point of candidates) {
        if (point.x < 1 || point.y < 1 || point.x > vw - 1 || point.y > vh - 1) continue;
        const insideBox =
          point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
        if (insideBox) continue;
        const hit = document.elementFromPoint(point.x, point.y);
        if (!(hit instanceof Element)) continue;
        if (hit !== el && !el.contains(hit)) continue;
        backdropPoint = point;
        break;
      }
    }

    overlays.push({
      key: `o${overlays.length + 1}`,
      fingerprint: "",
      skeleton: skeletonOf(el),
      label:
        cleanText(el.getAttribute("aria-label"), 42) ||
        cleanText(el.getAttribute("role"), 24) ||
        stableClassToken(el) ||
        el.tagName.toLowerCase(),
      tag: el.tagName.toLowerCase(),
      id: cleanText(el.id, 60),
      className: stableClassToken(el),
      role: item.role,
      ariaModal: item.ariaModal,
      zIndex: item.z,
      coverRatio: Number(item.cover.toFixed(4)),
      rect,
      topmostAtCenter: item.topmostAtCenter,
      depth: item.depth,
      controls,
      backdropPoint,
      dialogRect: dialogBox && dialogBox !== el ? rectOf(dialogBox) : null,
    });
  }

  // 附带候选控件所在弹层的相对顺序：topmost 优先
  return {
    url: location.href,
    viewport: { width: vw, height: vh },
    overlays,
    zMedian,
  };
}

/** 运行探针（作用域可以是主文档或嵌套框架）；任何异常都软着陆为空结果，绝不阻断主链路 */
export async function probeOverlays(page: DomScope): Promise<OverlayProbeResult> {
  let url = "";
  let viewport = { width: 0, height: 0 };
  try {
    url = page.url();
    // 嵌套框架没有自己的 viewportSize()：用它的 innerWidth/innerHeight（框架内部的坐标系原点）
    viewport = (await page.evaluate(() => ({
      width: Math.round(window.innerWidth || 0),
      height: Math.round(window.innerHeight || 0),
    }))) as { width: number; height: number };
  } catch {
    /* ignore */
  }
  try {
    const raw = (await page.evaluate(PROBE_OVERLAYS_SCRIPT)) as unknown as {
      overlays: Array<Omit<OverlayDescriptor, "fingerprint">>;
    };
    const overlays = Array.isArray(raw?.overlays) ? raw.overlays : [];
    return {
      url,
      viewport,
      overlays: overlays.map((overlay) => ({
        ...overlay,
        fingerprint: structureFingerprint(overlay.skeleton),
      })) as OverlayDescriptor[],
      error: null,
    };
  } catch (error) {
    return {
      url,
      viewport,
      overlays: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
