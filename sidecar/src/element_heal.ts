/**
 * Milestone 5：元素自愈重连（Node-Layer Self-Healing）
 *
 * React/Vue 重渲染会使短 ID 背后的 ElementHandle/selector 失效。
 * 蒸馏阶段把「指纹」存进 element_map；遇 stale 时静默按指纹重查（最多 2 次），
 * 成功则对 LLM 透明，失败再交 vision_relocate / 明确报错（禁止盲点错误 index）。
 */
import type { DomScope } from "./core/dom_scope.js";

export interface ElementFingerprint {
  tagName: string;
  textDigest: string;
  inputType: string | null;
  name?: string;
  placeholder?: string;
  role?: string;
  ariaLabel?: string;
  classHints?: string[];
  xpath?: string;
  selector?: string;
}

/** 静默重查上限（P4.1 / Milestone 5） */
export const ELEMENT_HEAL_MAX_ATTEMPTS = 2;
/** 两次重查之间的短暂等待，给重渲染落稳 */
export const ELEMENT_HEAL_RETRY_WAIT_MS = 120;
/** 唯一命中最低分；低于此分一律不认，避免点错 */
export const ELEMENT_HEAL_MIN_SCORE = 8;
/** 第一名与第二名的最小分差；差距不够视为歧义，宁可不愈 */
export const ELEMENT_HEAL_MIN_SCORE_GAP = 3;

export interface HealLocator {
  selector: string;
  xpath: string;
  tagName: string;
  text: string;
  score: number;
  attempt: number;
}

function digestText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48)
    .toLowerCase();
}

function classHintsFrom(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(/\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 2 && c.length < 40 && !/^[a-f0-9_-]{12,}$/i.test(c))
    .slice(0, 4);
}

export function buildElementFingerprint(input: {
  tagName: string;
  text?: string | null;
  inputType?: string | null;
  name?: string | null;
  placeholder?: string | null;
  role?: string | null;
  ariaLabel?: string | null;
  className?: string | null;
  xpath?: string | null;
  selector?: string | null;
}): ElementFingerprint {
  return {
    tagName: String(input.tagName ?? "").toLowerCase(),
    textDigest: digestText(input.text),
    inputType: input.inputType ? String(input.inputType).toLowerCase() : null,
    name: input.name?.trim() || undefined,
    placeholder: input.placeholder?.trim() || undefined,
    role: input.role?.trim() || undefined,
    ariaLabel: input.ariaLabel?.trim() || undefined,
    classHints: classHintsFrom(input.className),
    xpath: input.xpath?.trim() || undefined,
    selector: input.selector?.trim() || undefined,
  };
}

/** 供单测：候选元素的可比对字段 */
export interface FingerprintCandidate {
  tagName: string;
  inputType?: string | null;
  name?: string | null;
  placeholder?: string | null;
  role?: string | null;
  ariaLabel?: string | null;
  text?: string | null;
  className?: string | null;
  /** 旧 selector/xpath 是否仍能命中该候选（强信号） */
  locatorHit?: boolean;
}

/**
 * 指纹打分（纯函数）：高分 = 更像「同一个控件」。
 * 强身份属性（name / aria / placeholder / 旧 locator）权重大于文案与 class。
 */
export function scoreFingerprintMatch(
  fingerprint: ElementFingerprint,
  candidate: FingerprintCandidate,
): number {
  const tag = String(candidate.tagName ?? "").toLowerCase();
  const expectedTag = String(fingerprint.tagName ?? "").toLowerCase();
  if (!tag || !expectedTag || tag !== expectedTag) return 0;

  let score = 2; // 同标签基础分

  const candType = candidate.inputType ? String(candidate.inputType).toLowerCase() : null;
  if (fingerprint.inputType || candType) {
    if (fingerprint.inputType && candType && fingerprint.inputType === candType) score += 3;
    else if (fingerprint.inputType && candType && fingerprint.inputType !== candType) return 0;
  }

  const exact = (
    expected: string | undefined,
    actual: string | null | undefined,
    weight: number,
  ): number => {
    if (!expected) return 0;
    const a = String(actual ?? "").trim();
    if (!a) return 0;
    return expected === a ? weight : expected.toLowerCase() === a.toLowerCase() ? weight - 1 : 0;
  };

  score += exact(fingerprint.name, candidate.name, 8);
  score += exact(fingerprint.ariaLabel, candidate.ariaLabel, 7);
  score += exact(fingerprint.placeholder, candidate.placeholder, 7);
  score += exact(fingerprint.role, candidate.role, 4);

  if (fingerprint.textDigest) {
    const dig = digestText(candidate.text);
    if (dig && dig === fingerprint.textDigest) score += 5;
    else if (dig && (dig.includes(fingerprint.textDigest) || fingerprint.textDigest.includes(dig))) {
      score += 2;
    }
  }

  const hints = fingerprint.classHints ?? [];
  if (hints.length > 0) {
    const classes = new Set(
      String(candidate.className ?? "")
        .split(/\s+/)
        .map((c) => c.trim())
        .filter(Boolean),
    );
    let hit = 0;
    for (const h of hints) {
      if (classes.has(h)) hit += 1;
    }
    if (hit > 0) score += Math.min(3, hit);
  }

  if (candidate.locatorHit) score += 6;

  return score;
}

/**
 * 从打分结果里挑唯一赢家：达不到最低分 / 与第二名差距不够 → null（歧义不猜）。
 */
export function pickUniqueFingerprintMatch<T extends { score: number }>(
  ranked: T[],
  options?: { minScore?: number; minGap?: number },
): T | null {
  if (!ranked.length) return null;
  const minScore = options?.minScore ?? ELEMENT_HEAL_MIN_SCORE;
  const minGap = options?.minGap ?? ELEMENT_HEAL_MIN_SCORE_GAP;
  const sorted = [...ranked].sort((a, b) => b.score - a.score);
  const best = sorted[0]!;
  if (best.score < minScore) return null;
  const second = sorted[1];
  if (second && best.score - second.score < minGap) return null;
  return best;
}

type ProbeRow = {
  selector: string;
  xpath: string;
  tagName: string;
  text: string;
  inputType: string | null;
  name: string | null;
  placeholder: string | null;
  role: string | null;
  ariaLabel: string | null;
  className: string | null;
  locatorHit: boolean;
};

/**
 * 页面内：按指纹字段收集候选并重建 selector/xpath。
 * 逻辑与 interactive_elements 的 buildSelector/buildXPath 对齐，但不依赖观察全量抽取。
 */
const PROBE_BY_FINGERPRINT_SCRIPT = (fp: {
  tagName: string;
  inputType: string | null;
  name?: string;
  placeholder?: string;
  role?: string;
  ariaLabel?: string;
  textDigest: string;
  classHints?: string[];
  selector?: string;
  xpath?: string;
}) => {
  const cleanText = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized.slice(0, 80) : null;
  };

  const digestText = (value: string | null | undefined): string =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48)
      .toLowerCase();

  const escapeAttr = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const buildXPath = (element: Element): string => {
    const segments: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      const parentElement: Element | null = current.parentElement;
      if (!parentElement) {
        segments.unshift(tag);
        break;
      }
      const siblings = Array.from(parentElement.children).filter(
        (child) => child.tagName.toLowerCase() === tag,
      );
      const index = siblings.indexOf(current as Element) + 1;
      segments.unshift(`${tag}[${index}]`);
      current = parentElement;
    }
    return `/${segments.join("/")}`;
  };

  const buildSelector = (element: Element): string => {
    const htmlElement = element as HTMLElement;
    const tag = element.tagName.toLowerCase();
    const id = cleanText(htmlElement.id);
    if (id) return `#${CSS.escape(id)}`;
    const name = cleanText(element.getAttribute("name"));
    if (name) return `${tag}[name="${escapeAttr(name)}"]`;
    const placeholder = cleanText(element.getAttribute("placeholder"));
    if (placeholder && (tag === "input" || tag === "textarea")) {
      const candidate = `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      const candidate = `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    return buildXPath(element);
  };

  const resolveByLocator = (): Element | null => {
    let sel = String(fp.selector ?? "").trim();
    let xp = String(fp.xpath ?? "").trim();
    if (sel.startsWith("/") || sel.startsWith("(") || sel.startsWith("./")) {
      xp = xp || sel;
      sel = "";
    }
    if (sel) {
      try {
        const hit = document.querySelector(sel);
        if (hit) return hit;
      } catch {
        /* ignore */
      }
    }
    if (xp) {
      try {
        const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (r.singleNodeValue instanceof Element) return r.singleNodeValue;
      } catch {
        /* ignore */
      }
    }
    return null;
  };

  const isVisible = (element: HTMLElement): boolean => {
    if (element.getAttribute("hidden") !== null) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.05) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  };

  const readText = (el: HTMLElement): string => {
    return (
      cleanText(el.getAttribute("aria-label")) ||
      cleanText(el.getAttribute("placeholder")) ||
      cleanText(el.getAttribute("name")) ||
      cleanText(el.innerText || el.textContent) ||
      ""
    );
  };

  const expectedTag = String(fp.tagName ?? "").toLowerCase();
  if (!expectedTag) return [] as ProbeRow[];

  const locatorEl = resolveByLocator();
  const pool = new Set<Element>();
  if (locatorEl) pool.add(locatorEl);

  // 同标签可见元素；上限防止病态 DOM 扫爆
  for (const node of Array.from(document.querySelectorAll(expectedTag)).slice(0, 400)) {
    if (node instanceof HTMLElement && isVisible(node)) pool.add(node);
  }

  // 若指纹带强属性，再补一轮定向查询（覆盖标签被包一层的情况）
  const attrQueries: string[] = [];
  if (fp.name) attrQueries.push(`[name="${escapeAttr(fp.name)}"]`);
  if (fp.placeholder) attrQueries.push(`[placeholder="${escapeAttr(fp.placeholder)}"]`);
  if (fp.ariaLabel) attrQueries.push(`[aria-label="${escapeAttr(fp.ariaLabel)}"]`);
  for (const q of attrQueries) {
    try {
      for (const node of Array.from(document.querySelectorAll(q)).slice(0, 40)) {
        if (node instanceof HTMLElement && isVisible(node)) pool.add(node);
      }
    } catch {
      /* ignore */
    }
  }

  const rows: ProbeRow[] = [];
  for (const el of pool) {
    if (!(el instanceof HTMLElement)) continue;
    const tagName = el.tagName.toLowerCase();
    if (tagName !== expectedTag) continue;
    const inputType =
      el instanceof HTMLInputElement
        ? (el.getAttribute("type") || "text").toLowerCase()
        : el.getAttribute("type");
    rows.push({
      selector: buildSelector(el),
      xpath: buildXPath(el),
      tagName,
      text: readText(el),
      inputType: inputType ? String(inputType).toLowerCase() : null,
      name: cleanText(el.getAttribute("name")),
      placeholder: cleanText(el.getAttribute("placeholder")),
      role: cleanText(el.getAttribute("role")),
      ariaLabel: cleanText(el.getAttribute("aria-label")),
      className: typeof el.className === "string" ? el.className : null,
      locatorHit: locatorEl === el,
    });
  }
  return rows;
};

async function probeCandidates(
  scope: DomScope,
  fingerprint: ElementFingerprint,
): Promise<ProbeRow[]> {
  try {
    const rows = (await scope.evaluate(PROBE_BY_FINGERPRINT_SCRIPT, {
      tagName: fingerprint.tagName,
      inputType: fingerprint.inputType,
      name: fingerprint.name,
      placeholder: fingerprint.placeholder,
      role: fingerprint.role,
      ariaLabel: fingerprint.ariaLabel,
      textDigest: fingerprint.textDigest,
      classHints: fingerprint.classHints,
      selector: fingerprint.selector,
      xpath: fingerprint.xpath,
    })) as ProbeRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * 单次按指纹在文档内重查；歧义或低分返回 null（绝不猜错 index）。
 */
export async function findByFingerprint(
  scope: DomScope,
  fingerprint: ElementFingerprint,
): Promise<Omit<HealLocator, "attempt"> | null> {
  if (!fingerprint?.tagName) return null;
  const rows = await probeCandidates(scope, fingerprint);
  const ranked = rows.map((row) => ({
    ...row,
    score: scoreFingerprintMatch(fingerprint, {
      tagName: row.tagName,
      inputType: row.inputType,
      name: row.name,
      placeholder: row.placeholder,
      role: row.role,
      ariaLabel: row.ariaLabel,
      text: row.text,
      className: row.className,
      locatorHit: row.locatorHit,
    }),
  }));
  const best = pickUniqueFingerprintMatch(ranked);
  if (!best) return null;
  if (!best.selector && !best.xpath) return null;
  return {
    selector: best.selector,
    xpath: best.xpath,
    tagName: best.tagName,
    text: best.text,
    score: best.score,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * stale 时静默按指纹重查：最多 `maxAttempts` 次，间隔短等待。
 * 成功返回新 locator；耗尽仍找不到 → null（交给 vision_relocate / 明确失败）。
 */
export async function healByFingerprint(
  scope: DomScope,
  fingerprint: ElementFingerprint,
  options?: { maxAttempts?: number; waitMs?: number },
): Promise<HealLocator | null> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? ELEMENT_HEAL_MAX_ATTEMPTS);
  const waitMs = options?.waitMs ?? ELEMENT_HEAL_RETRY_WAIT_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const hit = await findByFingerprint(scope, fingerprint);
    if (hit) {
      return { ...hit, attempt };
    }
    if (attempt < maxAttempts && waitMs > 0) {
      await sleep(waitMs);
    }
  }
  return null;
}
