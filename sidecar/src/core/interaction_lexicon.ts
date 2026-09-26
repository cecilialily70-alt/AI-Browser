/**
 * 交互词典（纯数据驱动的排序先验）。
 *
 * 设计红线：
 * - 本模块只负责把「外部 JSON 数据」加载成打分先验，**代码层不出现任何站点文案**。
 * - 词典缺失（文件被删 / 用户替换 / 解析失败）时返回 null，所有调用方必须能降级为
 *   「结构信号 + 命中验证」的词典无关路径 —— 功能不退化，只是排序先验变弱。
 * - 路径可用环境变量整体替换（见 app_env 的 TIANSHUTAI_/CLOAKFORGE_ 前缀兼容）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";

/** 承诺度由低到高：关闭 < 稍后 < 拒绝 < 接受 < 提交 */
export type ControlIntent = "close" | "defer" | "reject" | "accept" | "submit" | "other";

export interface InteractionLexicon {
  intentPriority: Record<ControlIntent, number>;
  /** category → 词条（小写子串匹配） */
  terms: Record<string, string[]>;
  /** 字形型关闭钮（如叉号）—— 同样来自数据，不在代码里写死 */
  glyphs: string[];
}

/** 政策常量（非站点文案）：未命中词典时的兜底优先级 */
const DEFAULT_PRIORITY: Record<ControlIntent, number> = {
  close: 0,
  defer: 1,
  reject: 2,
  accept: 3,
  submit: 4,
  other: 5,
};

const MAX_TERM_LENGTH = 48;

let cached: InteractionLexicon | null | undefined;

function resolvedLexiconCandidates(): string[] {
  const env = readAppEnv("INTERACTION_LEXICON");
  const out: string[] = [];
  if (env) out.push(env);
  // dist/core 与 src/core 共用同一相对深度：../../config
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/interaction_lexicon.json"));
  out.push(join(here, "../../../config/interaction_lexicon.json"));
  out.push(join(process.cwd(), "config", "interaction_lexicon.json"));
  out.push(join(process.cwd(), "sidecar", "config", "interaction_lexicon.json"));
  return out;
}

export function resolveInteractionLexiconPath(): string | null {
  for (const candidate of resolvedLexiconCandidates()) {
    try {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    } catch {
      /* 单个候选路径异常不阻断 */
    }
  }
  return null;
}

function sanitizeTerms(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [category, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const terms = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.replace(/\s+/g, " ").trim().toLowerCase())
      .filter((item) => item.length > 0 && item.length <= MAX_TERM_LENGTH);
    if (terms.length) out[category] = Array.from(new Set(terms));
  }
  return out;
}

function sanitizePriority(raw: unknown): Record<ControlIntent, number> {
  const merged: Record<ControlIntent, number> = { ...DEFAULT_PRIORITY };
  if (!raw || typeof raw !== "object") return merged;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && key in merged) {
      merged[key as ControlIntent] = value;
    }
  }
  return merged;
}

/** 加载词典；无可用文件 / 解析失败 → null（调用方必须降级） */
export function loadInteractionLexicon(): InteractionLexicon | null {
  if (cached !== undefined) return cached;
  const path = resolveInteractionLexiconPath();
  if (!path) {
    cached = null;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    cached = {
      intentPriority: sanitizePriority(parsed.intentPriority),
      terms: sanitizeTerms(parsed.terms),
      glyphs: Array.isArray(parsed.glyphs)
        ? parsed.glyphs
            .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
            .map((g) => g.trim())
        : [],
    };
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * 词典先验：返回该控件文案对应的最低承诺度优先级；未命中返回 null。
 * 注意：只喂「控件自身的可访问名」，不要喂整层弹窗文本，否则会误命中。
 */
export function lexiconIntentPriority(
  controlName: string,
  lexicon: InteractionLexicon | null,
): number | null {
  if (!lexicon) return null;
  const hay = controlName.replace(/\s+/g, " ").trim().toLowerCase();
  if (!hay) return null;
  let best: number | null = null;
  for (const [category, terms] of Object.entries(lexicon.terms)) {
    const priority = lexicon.intentPriority[category as ControlIntent] ?? DEFAULT_PRIORITY.other;
    for (const term of terms) {
      if (!term) continue;
      if (hay === term || hay.includes(term)) {
        if (best === null || priority < best) best = priority;
        break;
      }
    }
  }
  return best;
}

/** 字形命中（叉号类关闭钮）；词典缺失时恒为 false */
export function lexiconGlyphHit(
  controlName: string,
  lexicon: InteractionLexicon | null,
): boolean {
  if (!lexicon?.glyphs.length) return false;
  const name = controlName.replace(/\s+/g, "").trim();
  if (!name || name.length > 3) return false;
  return lexicon.glyphs.some((glyph) => glyph === name);
}

/** 结构骨架哈希：用于遮罩复发去重（剥离动态文案，防止倒计时击穿） */
export function structureFingerprint(skeleton: string): string {
  return createHash("sha1").update(skeleton || "none").digest("hex").slice(0, 16);
}
