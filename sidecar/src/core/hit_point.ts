/**
 * 精确命中点解析（Intent → DOM 交互靶点）
 *
 * 解决两个通用问题，**不含任何站点文案或站内选择器**：
 *
 * 1) 意图关联：当模型给的元素是「文本/标签/容器」，而真正的交互靶点是它旁边的
 *    `<input type=checkbox|radio>`、`role=checkbox|radio|switch`、或 `label[for]` 指向的控件时，
 *    先做关联查找，把点击落到控件（或其 label / 视觉代理方框）上。
 *    关联依据全部是结构关系：`label.control` / `label[for]` / `aria-labelledby` 反向 /
 *    同一行容器内的控件 / 文本相似度 + 几何邻近度（Dice 系数 + 垂直重叠 + 距离衰减）。
 *
 * 2) 命中自检：对每个候选点用 `elementFromPoint` 校验顶层归属，
 *    并**拒绝落在目标内部嵌套可交互元素上的点**（例：复选框外壳中心压着「隐私声明」超链接）。
 *
 * 返回按分数排序的候选点；调用方可逐点尝试并配合状态回读做验证。
 */
import type { DomScope } from "./dom_scope.js";

import type { ProbeRect } from "./overlay_probe.js";

export interface HitPointRequest {
  /** CSS 选择器（优先） */
  selector?: string;
  /** xpath（无 xpath= 序言写法，如 /html/body/div[1]） */
  xpath?: string;
  /** 期望语义；check 会让方框/左内侧点优先 */
  intent?: "auto" | "click" | "check" | "text";
}

export interface HitPointAnchorInfo {
  tag: string;
  role: string;
  inputType: string | null;
  text: string;
  rect: ProbeRect;
  rendered: boolean;
}

export interface AssociatedControl {
  selector: string;
  xpath: string;
  tag: string;
  role: string;
  inputType: string | null;
  /** 真 input 的勾选态（非 checkbox/radio 为 null） */
  checked: boolean | null;
  visible: boolean;
  rect: ProbeRect | null;
  /** 关联依据：self:* / label.control / label[for] / aria-labelledby-reverse / row-container / ancestor-N */
  reason: string;
  score: number;
}

export interface HitPoint {
  x: number;
  y: number;
  /** 该点最终会激活谁 */
  owner: "associated" | "anchor";
  /** 生成策略：control-center / label-inset / visual-proxy / host-left-inset / left-inset / center / corner / grid */
  strategy: string;
  score: number;
}

export interface RejectedPoint {
  x: number;
  y: number;
  reason: string;
  /** 该点被「别的元素压在上面」而淘汰（遮挡类失败与普通换点是两回事） */
  occluded?: boolean;
}

export interface HitPointResolution {
  ok: boolean;
  anchor: HitPointAnchorInfo | null;
  associated: AssociatedControl | null;
  points: HitPoint[];
  rejected: RejectedPoint[];
  error: string | null;
}

interface RawResolution {
  anchor: HitPointAnchorInfo | null;
  associated: AssociatedControl | null;
  points: HitPoint[];
  rejected: RejectedPoint[];
}

/** 页面内解析脚本（自包含，无外部依赖） */
function RESOLVE_HIT_POINTS_SCRIPT(request: {
  selector: string;
  xpath: string;
  intent: string;
}) {
  /** 注意：全部常量必须定义在函数体内——本函数会被序列化后注入页面执行 */
  const MAX_POINTS = 8;
  const MAX_REJECTED = 6;
  const FORM_CONTROL_SELECTOR = "input,select,textarea";
  const CHOICE_SELECTOR =
    "input[type='checkbox'],input[type='radio'],[role='checkbox'],[role='radio'],[role='switch']";
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='tab']",
    "[role='menuitem']",
    "[contenteditable='true']",
  ].join(",");

  function rectOf(el: Element): ProbeRect {
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

  function normalize(value: string): string {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[\s\u3000]+/g, "")
      .replace(/[，。、；：！？,.;:!?"'`()[\]{}<>《》「」『』]/g, "")
      .slice(0, 60);
  }

  /** 二元组 Dice 相似度：语言无关，不需要任何词典 */
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

  function styleOf(el: Element): CSSStyleDeclaration {
    return window.getComputedStyle(el);
  }

  function isRendered(el: Element): boolean {
    const style = styleOf(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }

  function describe(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const id = cleanText(el.id, 24);
    const cls =
      typeof (el as HTMLElement).className === "string"
        ? cleanText((el as HTMLElement).className, 32)
        : "";
    const name = cleanText(el.getAttribute("aria-label"), 24);
    return `${tag}${id ? `#${id}` : ""}${cls ? `.${cls.split(/\s+/).slice(0, 2).join(".")}` : ""}${
      name ? `「${name}」` : ""
    }`;
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
    const tag = el.tagName.toLowerCase();
    const type = cleanText(el.getAttribute("type"), 24);
    if (type && (tag === "input" || tag === "button")) {
      const candidate = `${tag}[type="${type}"]`;
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
    const inner = cleanText(el.textContent, 60);
    if (inner) return inner;
    return "";
  }

  function resolveAnchor(): Element | null {
    if (request.selector) {
      try {
        const hit = document.querySelector(request.selector);
        if (hit) return hit;
      } catch {
        /* 非法 CSS 选择器 → 继续尝试 xpath */
      }
    }
    if (request.xpath) {
      try {
        const result = document.evaluate(
          request.xpath,
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

  function labelForControl(control: Element): HTMLLabelElement | null {
    if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
    ) {
      const labels = control.labels;
      if (labels && labels.length) return labels[0] ?? null;
    }
    const id = cleanText(control.id, 80);
    if (id) {
      try {
        const linked = document.querySelector(`label[for="${cssEscape(id)}"]`);
        if (linked instanceof HTMLLabelElement) return linked;
      } catch {
        /* ignore */
      }
    }
    const wrapping = control.closest("label");
    return wrapping instanceof HTMLLabelElement ? wrapping : null;
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

  interface Candidate {
    el: Element;
    reason: string;
    score: number;
  }

  /**
   * 意图关联查找：从「文本/容器元素」找真正的交互靶点。
   * 全部为结构依据，不依赖任何站点文案。
   */
  function findAssociated(anchor: Element): Candidate | null {
    const candidates: Candidate[] = [];
    const isChoice = anchor.matches(CHOICE_SELECTOR);
    const isFormControl = anchor.matches(FORM_CONTROL_SELECTOR);
    const contentEditable = anchor.getAttribute("contenteditable") === "true";

    if (isChoice) return { el: anchor, reason: "self:choice", score: 1 };
    if (isFormControl || contentEditable) {
      return { el: anchor, reason: "self:form-control", score: 0.95 };
    }
    if (anchor.matches("a[href],button") || anchor.getAttribute("role") === "button") {
      return { el: anchor, reason: "self:actionable", score: 0.9 };
    }

    // ① label 关联（最可靠）
    const wrappingLabel = anchor.closest("label");
    if (wrappingLabel instanceof HTMLLabelElement) {
      const control =
        (wrappingLabel as HTMLLabelElement & { control?: Element | null }).control ??
        (wrappingLabel.htmlFor ? document.getElementById(wrappingLabel.htmlFor) : null);
      if (control && control !== anchor) {
        candidates.push({ el: control, reason: "label.control", score: 0.98 });
      }
    }
    if (anchor.id) {
      try {
        const linked = document.querySelector(`label[for="${cssEscape(anchor.id)}"]`);
        if (linked instanceof HTMLLabelElement) {
          const control = linked.htmlFor ? document.getElementById(linked.htmlFor) : null;
          if (control && control !== anchor) {
            candidates.push({ el: control, reason: "label[for]", score: 0.96 });
          }
        }
      } catch {
        /* ignore */
      }
    }

    // ② aria-labelledby 反向引用：谁把 anchor 当作自己的标签
    if (anchor.id) {
      for (const el of Array.from(
        document.querySelectorAll(`${FORM_CONTROL_SELECTOR},${CHOICE_SELECTOR}`),
      ).slice(0, 400)) {
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy && labelledBy.split(/\s+/).includes(anchor.id)) {
          candidates.push({ el, reason: "aria-labelledby-reverse", score: 0.92 });
        }
      }
    }

    // ③ 同一「行容器」内的控件：文本相似 + 垂直重叠 + 距离衰减
    const anchorText = normalize(anchor.textContent ?? "");
    const anchorRect = anchor.getBoundingClientRect();
    const anchorDiagonal = Math.max(1, Math.hypot(anchorRect.width, anchorRect.height));
    let container: Element | null = anchor.parentElement;
    for (let depth = 0; container && depth < 4; depth += 1) {
      const scoped = Array.from(
        container.querySelectorAll(`${CHOICE_SELECTOR},${FORM_CONTROL_SELECTOR}`),
      ).slice(0, 60);
      for (const el of scoped) {
        if (el === anchor) continue;
        if (styleOf(el).display === "none") continue;

        const elName = normalize(accessibleName(el));
        const overlap = verticalOverlap(el, anchor);
        const elRect = el.getBoundingClientRect();
        const distance = Math.hypot(
          elRect.left + elRect.width / 2 - (anchorRect.left + anchorRect.width / 2),
          elRect.top + elRect.height / 2 - (anchorRect.top + anchorRect.height / 2),
        );
        const proximity = 1 - Math.min(1, distance / Math.max(1, anchorDiagonal * 3));

        let score = 0.34;
        if (anchorText && elName) score += 0.32 * dice(anchorText, elName);
        score += 0.22 * overlap;
        score += 0.18 * proximity;
        if (el.matches(CHOICE_SELECTOR)) score += 0.14;
        score -= depth * 0.04;

        candidates.push({
          el,
          reason: depth === 0 ? "row-container" : `ancestor-${depth}`,
          score: Number(score.toFixed(3)),
        });
      }
      container = container.parentElement;
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]!;
    return best.score >= 0.5 ? best : null;
  }

  /**
   * 勾选方框检测：在目标内部找「真正画出来的那个小方框」。
   * 纯几何 + 语义无关：小尺寸、近方形、无文案、位于目标左侧/左上、与关联控件重叠。
   * 这一步直接解决「点文本中心压到内嵌链接」的问题——方框在左端，链接在中间。
   */
  function findChoiceBox(anchor: Element, associated: Element | null): Element | null {
    const anchorRect = anchor.getBoundingClientRect();
    const ref =
      associated && associated !== anchor && isRendered(associated) ? associated : null;
    if (ref) {
      const rr = ref.getBoundingClientRect();
      if (
        rr.width >= 6 &&
        rr.height >= 6 &&
        rr.width <= 32 &&
        rr.height <= 32 &&
        Math.abs(rr.width - rr.height) <= 8
      ) {
        return ref;
      }
    }
    const associatedRect = associated?.getBoundingClientRect() ?? null;
    let best: { el: Element; score: number } | null = null;
    const scope = Array.from(
      anchor.querySelectorAll("input,svg,span,div,i,em,b,label,use,path,img"),
    ).slice(0, 140);
    for (const node of scope) {
      if (!isRendered(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 6 || rect.height < 6 || rect.width > 32 || rect.height > 32) continue;
      if (Math.abs(rect.width - rect.height) > 8) continue;
      if (cleanText(node.textContent, 4).length > 1) continue;
      const leftish = rect.left - anchorRect.left <= anchorRect.width * 0.5;
      const toppish = rect.top - anchorRect.top <= anchorRect.height * 0.6;
      if (!leftish || !toppish) continue;

      const squareness = 1 - Math.abs(rect.width - rect.height) / 32;
      const distance = Math.hypot(rect.left - anchorRect.left, rect.top - anchorRect.top);
      const proximity = 1 - Math.min(1, distance / Math.max(1, anchorRect.width));
      let overlapBonus = 0;
      if (associatedRect) {
        const interW = Math.min(rect.right, associatedRect.right) - Math.max(rect.left, associatedRect.left);
        const interH = Math.min(rect.bottom, associatedRect.bottom) - Math.max(rect.top, associatedRect.top);
        if (interW > 0 && interH > 0) overlapBonus = 0.3;
      }
      const score = squareness * 0.4 + proximity * 0.4 + overlapBonus;
      if (!best || score > best.score) best = { el: node, score };
    }
    return best && best.score >= 0.5 ? best.el : null;
  }

  /** 视觉代理方框：同行内小尺寸、近方形、无文案、与控件重叠的兄弟节点（自定义复选框画法） */
  function findVisualProxy(control: Element): Element | null {
    const controlRect = control.getBoundingClientRect();
    const container = control.parentElement;
    if (!container) return null;
    let best: { el: Element; score: number } | null = null;
    for (const sibling of Array.from(container.children).slice(0, 20)) {
      if (sibling === control) continue;
      if (!isRendered(sibling)) continue;
      const rect = sibling.getBoundingClientRect();
      if (rect.width > 44 || rect.height > 44 || rect.width < 6 || rect.height < 6) continue;
      if (cleanText(sibling.textContent, 8).length > 3) continue;
      const squareish = 1 - Math.min(1, Math.abs(rect.width - rect.height) / Math.max(1, rect.width));
      const overlap = verticalOverlap(sibling, control);
      const inside =
        rect.left >= controlRect.left - 6 &&
        rect.right <= controlRect.right + 6 &&
        rect.top >= controlRect.top - 6 &&
        rect.bottom <= controlRect.bottom + 6;
      const score = squareish * 0.5 + overlap * 0.4 + (inside ? 0.6 : 0);
      if (!best || score > best.score) best = { el: sibling, score };
    }
    return best && best.score >= 0.6 ? best.el : null;
  }

  function isRelatedTo(node: Element, anchor: Element, associated: Element | null): boolean {
    if (node === anchor || anchor.contains(node) || node.contains(anchor)) return true;
    if (!associated) return false;
    return (
      node === associated ||
      associated.contains(node) ||
      node.contains(associated) ||
      node.closest(INTERACTIVE_SELECTOR) === associated
    );
  }

  const rejected: RejectedPoint[] = [];
  const points: HitPoint[] = [];
  /** 勾选类语义下才启用「落点不得命中内嵌可交互元素」的严格判定，避免对普通按钮误伤 */
  let strictNesting = false;

  function reject(x: number, y: number, reason: string, occluded = false): void {
    if (rejected.length < MAX_REJECTED) {
      // `occluded` 是结构化标记（不是给人看的文案）：执行层据此区分
      // 「有别的元素压在上面」（必须先清障）和「这个点本身不适合点」（换点即可）。
      rejected.push({ x: Math.round(x), y: Math.round(y), reason, ...(occluded ? { occluded: true } : {}) });
    }
  }

  function pushPoint(
    x: number,
    y: number,
    strategy: string,
    score: number,
    anchor: Element,
    associated: Element | null,
  ): void {
    if (points.length >= MAX_POINTS) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1) {
      reject(x, y, "越出视口");
      return;
    }
    const top = document.elementFromPoint(Math.round(x), Math.round(y));
    if (!top) {
      reject(x, y, "elementFromPoint 无元素");
      return;
    }
    const style = styleOf(top);
    if (
      style.visibility === "hidden" ||
      Number(style.opacity) === 0 ||
      style.pointerEvents === "none"
    ) {
      reject(x, y, `顶层不可点（${describe(top)}）`);
      return;
    }
    if (!isRelatedTo(top, anchor, associated)) {
      reject(x, y, `被遮挡：顶层是 ${describe(top)}`, true);
      return;
    }
    // ★ 核心：勾选语义下，落点不得命中「目标内部无关的嵌套可交互元素」
    //（例：复选框外壳中心压着「隐私声明」超链接，点它会跳走而不是勾选）
    const nested = top.closest(INTERACTIVE_SELECTOR);
    if (strictNesting && nested && nested !== anchor && nested !== associated && anchor.contains(nested)) {
      reject(x, y, `落点命中内嵌可交互元素 ${describe(nested)}`);
      return;
    }
    const owner: HitPoint["owner"] =
      associated &&
      (top === associated ||
        associated.contains(top) ||
        top.closest(INTERACTIVE_SELECTOR) === associated)
        ? "associated"
        : "anchor";
    points.push({
      x: Math.round(x),
      y: Math.round(y),
      owner,
      strategy,
      score: Number(score.toFixed(3)),
    });
  }

  const anchor = resolveAnchor();
  if (!anchor) {
    return { anchor: null, associated: null, points: [], rejected: [] } as RawResolution;
  }

  const associatedCandidate = findAssociated(anchor);
  const associatedEl = associatedCandidate?.el ?? null;
  const anchorRect = rectOf(anchor);

  const anchorInfo: HitPointAnchorInfo = {
    tag: anchor.tagName.toLowerCase(),
    role: (anchor.getAttribute("role") || "").toLowerCase(),
    inputType: cleanText(anchor.getAttribute("type"), 24) || null,
    text: cleanText(accessibleName(anchor), 80),
    rect: anchorRect,
    rendered: isRendered(anchor),
  };

  let associatedInfo: AssociatedControl | null = null;
  if (associatedEl && associatedEl !== anchor) {
    const elRect = associatedEl.getBoundingClientRect();
    const ariaChecked = associatedEl.getAttribute("aria-checked");
    associatedInfo = {
      selector: buildSelector(associatedEl),
      xpath: buildXPath(associatedEl),
      tag: associatedEl.tagName.toLowerCase(),
      role: (associatedEl.getAttribute("role") || "").toLowerCase(),
      inputType: cleanText(associatedEl.getAttribute("type"), 24) || null,
      checked:
        associatedEl instanceof HTMLInputElement &&
        (associatedEl.type === "checkbox" || associatedEl.type === "radio")
          ? associatedEl.checked
          : ariaChecked === "true"
            ? true
            : ariaChecked === "false"
              ? false
              : null,
      visible: isRendered(associatedEl),
      rect: elRect.width || elRect.height ? rectOf(associatedEl) : null,
      reason: associatedCandidate!.reason,
      score: associatedCandidate!.score,
    };
  }

  const preferChoice =
    request.intent === "check" ||
    (associatedEl != null && associatedEl.matches(CHOICE_SELECTOR)) ||
    anchor.matches(CHOICE_SELECTOR);
  strictNesting = preferChoice;

  // —— 勾选方框优先：直接命中小方框中心，天然绕开内嵌链接 ——
  if (preferChoice) {
    const box = findChoiceBox(anchor, associatedEl);
    if (box) {
      const br = box.getBoundingClientRect();
      pushPoint(
        br.left + br.width / 2,
        br.top + br.height / 2,
        "choice-box",
        1.05,
        anchor,
        associatedEl,
      );
    }
  }

  // —— 关联控件优先：点控件本体 / 它的 label / 视觉代理方框 ——
  if (associatedEl && associatedEl !== anchor) {
    const elRect = associatedEl.getBoundingClientRect();
    if (isRendered(associatedEl)) {
      pushPoint(
        elRect.left + elRect.width / 2,
        elRect.top + elRect.height / 2,
        "control-center",
        1,
        anchor,
        associatedEl,
      );
    } else {
      // 真实控件被视觉折叠：改用它的 label / 代理方框 / 宿主容器
      const host = associatedEl.closest("label") ?? associatedEl.parentElement;
      if (host && isRendered(host)) {
        const hr = host.getBoundingClientRect();
        if (preferChoice) {
          pushPoint(
            hr.left + Math.min(14, hr.width / 4),
            hr.top + hr.height / 2,
            "host-left-inset",
            0.9,
            anchor,
            associatedEl,
          );
        }
        pushPoint(hr.left + hr.width / 2, hr.top + hr.height / 2, "host-center", 0.6, anchor, associatedEl);
      }
      const proxy = findVisualProxy(associatedEl);
      if (proxy) {
        const pr = proxy.getBoundingClientRect();
        pushPoint(
          pr.left + pr.width / 2,
          pr.top + pr.height / 2,
          "visual-proxy",
          0.88,
          anchor,
          associatedEl,
        );
      }
    }
    const label = labelForControl(associatedEl);
    if (label && label !== anchor && isRendered(label)) {
      const lr = label.getBoundingClientRect();
      if (preferChoice) {
        pushPoint(
          lr.left + Math.min(14, lr.width / 4),
          lr.top + lr.height / 2,
          "label-left-inset",
          0.86,
          anchor,
          associatedEl,
        );
      } else {
        pushPoint(lr.left + lr.width / 2, lr.top + lr.height / 2, "label-center", 0.72, anchor, associatedEl);
      }
    }
  }

  // —— 目标元素自身：网格候选点，逐点做命中自检 ——
  const probes: Array<{ strategy: string; fx: number; fy: number; weight: number }> = [];
  if (preferChoice) {
    probes.push({ strategy: "left-inset", fx: 0.12, fy: 0.5, weight: 0.84 });
  }
  probes.push({ strategy: "center", fx: 0.5, fy: 0.5, weight: 0.55 });
  probes.push({ strategy: "top-left", fx: 0.25, fy: 0.25, weight: 0.4 });
  probes.push({ strategy: "top-right", fx: 0.75, fy: 0.25, weight: 0.36 });
  probes.push({ strategy: "bottom-left", fx: 0.25, fy: 0.75, weight: 0.34 });
  probes.push({ strategy: "bottom-right", fx: 0.75, fy: 0.75, weight: 0.32 });
  for (const fy of [0.2, 0.5, 0.8]) {
    for (const fx of [0.08, 0.92]) {
      probes.push({ strategy: "edge-grid", fx, fy, weight: 0.3 });
    }
  }

  for (const probe of probes) {
    if (points.length >= MAX_POINTS) break;
    pushPoint(
      anchorRect.x + anchorRect.w * probe.fx,
      anchorRect.y + anchorRect.h * probe.fy,
      probe.strategy,
      probe.weight,
      anchor,
      associatedEl,
    );
  }

  points.sort((a, b) => b.score - a.score);

  return {
    anchor: anchorInfo,
    associated: associatedInfo,
    points: points.slice(0, MAX_POINTS),
    rejected,
  } as RawResolution;
}

/** 解析命中点（作用域可以是主文档或嵌套框架）；任何异常都软着陆为「无候选点」，绝不阻断主链路 */
export async function resolveHitPoints(
  page: DomScope,
  request: HitPointRequest,
): Promise<HitPointResolution> {
  const selector = String(request.selector ?? "").trim();
  const xpath = String(request.xpath ?? "").trim();
  if (!selector && !xpath) {
    return {
      ok: false,
      anchor: null,
      associated: null,
      points: [],
      rejected: [],
      error: "缺少 selector / xpath",
    };
  }
  try {
    const raw = (await page.evaluate(RESOLVE_HIT_POINTS_SCRIPT, {
      selector: selector.startsWith("/") ? "" : selector,
      xpath: xpath || (selector.startsWith("/") ? selector : ""),
      intent: request.intent ?? "auto",
    })) as RawResolution;
    const points = Array.isArray(raw?.points) ? raw.points : [];
    return {
      ok: Boolean(raw?.anchor) && points.length > 0,
      anchor: raw?.anchor ?? null,
      associated: raw?.associated ?? null,
      points,
      rejected: Array.isArray(raw?.rejected) ? raw.rejected : [],
      error: raw?.anchor ? null : "未解析到目标元素（选择器可能已失效）",
    };
  } catch (error) {
    return {
      ok: false,
      anchor: null,
      associated: null,
      points: [],
      rejected: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 供日志 / 回灌模型的一句话说明：为什么改点了别的元素、哪些点被排除 */
export function describeHitPointResolution(resolution: HitPointResolution): string {
  if (!resolution.ok) {
    const first = resolution.rejected[0];
    return `命中点解析失败：${resolution.error ?? "无可用候选点"}${
      first ? `；已排除 ${resolution.rejected.length} 个点（例：${first.reason}）` : ""
    }`;
  }
  const point = resolution.points[0]!;
  const associated = resolution.associated;
  const via =
    associated && !associated.reason.startsWith("self:")
      ? `；意图关联到 <${associated.tag}${associated.inputType ? ` type=${associated.inputType}` : ""}>（依据 ${associated.reason}）`
      : "";
  return `命中点 (${point.x},${point.y}) · 策略 ${point.strategy} · 归属 ${point.owner}${via}`;
}
