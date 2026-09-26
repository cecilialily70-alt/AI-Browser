/**
 * 目标动作意图（Task Intent）——「用户到底要搜索，还是只要打开页面」的唯一事实源。
 *
 * 背景（真实事故）：用户目标「打开百度首页」是**纯导航**，期望只打开站点首页就结束。
 * 但 Phase A 的规划模型会把「百度首页」当成检索词回填 query_terms，运行期的确定性加速器
 * （deterministic.tryDeterministicSearchNavigate）见到「有检索词 + 当前在引擎首页」就自动
 * 构造搜索结果 URL 并导航，任务于是从「打开首页」变成「搜索『百度首页』」；站点再弹验证码时，
 * Agent 就会在结果页 URL 上反复空转。
 *
 * 根因不是某个站点，而是**缺少「目标请求了搜索没有」这一事实**。本模块把它单列出来：
 *   - goalRequestsSearch：目标里是否出现搜索动词；
 *   - sanitizeQueryTerms：把「站点名 + 首页/主页」这类伪检索词剥掉，避免下游拿它去搜索。
 *
 * 词表来自外部数据文件（config/task_intent_lexicon.json），代码零站点文案；
 * 文件缺失时退化到内置通用词表，不会因为缺文件而炸掉主流程。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";
import { firstHit, normalizeHaystack } from "./text_match.js";

export interface TaskIntentLexicon {
  searchTerms: string[];
  navigateTerms: string[];
  queryStopwords: string[];
  newTabTerms: string[];
  /** 「泛词」：单独命中不足以判定新标签意图（「把这条数据标个新标签」类歧义） */
  newTabGenericTerms: string[];
  /** 与泛词同现即判疑似误命中的动作词（点击/选择/保存/分类…） */
  newTabAmbiguityTerms: string[];
}

const MAX_TERM_LENGTH = 48;

const FALLBACK_SEARCH_TERMS = [
  "搜索",
  "搜一下",
  "搜一搜",
  "搜尋",
  "查找",
  "查一下",
  "查询",
  "检索",
  "百度一下",
  "谷歌一下",
  "search",
  "look up",
  "lookup",
];

const FALLBACK_NAVIGATE_TERMS = ["打开", "访问", "前往", "导航", "进入", "浏览", "open", "visit", "go to", "navigate"];

const FALLBACK_QUERY_STOPWORDS = [
  "首页",
  "首页面",
  "主页",
  "官网",
  "官方网站",
  "网站",
  "网页",
  "页面",
  "门户",
  "homepage",
  "home page",
  "home",
  "main page",
  "official site",
  "official website",
  "website",
  "web page",
  "portal",
];

const FALLBACK_NEW_TAB_TERMS = [
  "打开新标签",
  "打开新标签页",
  "新开标签",
  "新建标签",
  "新建标签页",
  "在新标签",
  "在新标签中",
  "在新标签里",
  "新标签页",
  "新标签",
  "new tab",
  "newtab",
  "open a new tab",
  "open in a new tab",
  "in a new tab",
  "another tab",
  "second tab",
];

const FALLBACK_NEW_TAB_GENERIC_TERMS = ["新标签", "新标签页", "标签", "new tab", "newtab", "another tab", "second tab"];

const FALLBACK_NEW_TAB_AMBIGUITY_TERMS = [
  "点击",
  "选择",
  "保存",
  "分类",
  "归类",
  "标记",
  "标注",
  "打标签",
  "分组",
  "收藏",
  "筛选",
];

let cached: TaskIntentLexicon | null | undefined;

function lexiconCandidates(): string[] {
  const env = readAppEnv("TASK_INTENT_LEXICON");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/task_intent_lexicon.json"));
  out.push(join(here, "../../../config/task_intent_lexicon.json"));
  out.push(join(process.cwd(), "config", "task_intent_lexicon.json"));
  out.push(join(process.cwd(), "sidecar", "config", "task_intent_lexicon.json"));
  return out;
}

export function resolveTaskIntentLexiconPath(): string | null {
  for (const candidate of lexiconCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* 单个候选路径异常不阻断 */
    }
  }
  return null;
}

function sanitizeTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => normalizeHaystack(item))
        .filter((item) => item.length > 0 && item.length <= MAX_TERM_LENGTH),
    ),
  );
}

export function loadTaskIntentLexicon(): TaskIntentLexicon | null {
  if (cached !== undefined) return cached;
  const path = resolveTaskIntentLexiconPath();
  if (!path) {
    cached = null;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const intents = (parsed.intents ?? {}) as Record<string, Record<string, unknown>>;
    const stopwords = (parsed.queryStopwords ?? {}) as Record<string, unknown>;
    const newTab = intents.newTab ?? {};
    cached = {
      searchTerms: sanitizeTerms(intents.search?.terms),
      navigateTerms: sanitizeTerms(intents.navigate?.terms),
      queryStopwords: sanitizeTerms(stopwords.terms),
      newTabTerms: sanitizeTerms(newTab.terms),
      newTabGenericTerms: sanitizeTerms((newTab.genericTerms as Record<string, unknown> | undefined)?.terms),
      newTabAmbiguityTerms: sanitizeTerms(
        (newTab.ambiguityActionTerms as Record<string, unknown> | undefined)?.terms,
      ),
    };
  } catch {
    cached = null;
  }
  return cached;
}

function searchTerms(lexicon: TaskIntentLexicon | null): string[] {
  return lexicon?.searchTerms.length ? lexicon.searchTerms : FALLBACK_SEARCH_TERMS;
}

function navigateTerms(lexicon: TaskIntentLexicon | null): string[] {
  return lexicon?.navigateTerms.length ? lexicon.navigateTerms : FALLBACK_NAVIGATE_TERMS;
}

function stopwords(lexicon: TaskIntentLexicon | null): string[] {
  return lexicon?.queryStopwords.length ? lexicon.queryStopwords : FALLBACK_QUERY_STOPWORDS;
}

export interface IntentHit {
  requested: boolean;
  /** 命中的词条（便于日志解释「为什么这样判」） */
  matched: string | null;
}

/** 目标是否显式请求了搜索（决定能否用检索词自动构造搜索 URL） */
export function goalRequestsSearch(goal: string, lexicon: TaskIntentLexicon | null = loadTaskIntentLexicon()): IntentHit {
  const hay = normalizeHaystack(goal);
  if (!hay) return { requested: false, matched: null };
  const hit = firstHit(hay, searchTerms(lexicon));
  return { requested: Boolean(hit), matched: hit };
}

/** 目标是否显式请求了导航（仅用于日志/扩展） */
export function goalRequestsNavigation(goal: string, lexicon: TaskIntentLexicon | null = loadTaskIntentLexicon()): IntentHit {
  const hay = normalizeHaystack(goal);
  if (!hay) return { requested: false, matched: null };
  const hit = firstHit(hay, navigateTerms(lexicon));
  return { requested: Boolean(hit), matched: hit };
}

export function newTabTerms(lexicon: TaskIntentLexicon | null): string[] {
  return lexicon?.newTabTerms.length ? lexicon.newTabTerms : FALLBACK_NEW_TAB_TERMS;
}

export function newTabGenericTerms(lexicon: TaskIntentLexicon | null): string[] {
  return lexicon?.newTabGenericTerms.length ? lexicon.newTabGenericTerms : FALLBACK_NEW_TAB_GENERIC_TERMS;
}

export function newTabAmbiguityTerms(lexicon: TaskIntentLexicon | null): string[] {
  return lexicon?.newTabAmbiguityTerms.length ? lexicon.newTabAmbiguityTerms : FALLBACK_NEW_TAB_AMBIGUITY_TERMS;
}

/** 目标是否显式请求了「在新标签中操作」（词表命中；歧义判定在 new_tab_intent.ts） */
export function goalRequestsNewTab(goal: string, lexicon: TaskIntentLexicon | null = loadTaskIntentLexicon()): IntentHit {
  const hay = normalizeHaystack(goal);
  if (!hay) return { requested: false, matched: null };
  const hit = firstHit(hay, newTabTerms(lexicon));
  return { requested: Boolean(hit), matched: hit };
}

export interface SanitizeQueryOptions {
  /** 站点别名（如「百度」）：剥离后只剩它的检索词是伪检索词，必须丢弃 */
  siteTokens?: string[];
}

const EDGE_PUNCT_RE = /^[\s·\-—_、,，。.]+|[\s·\-—_、,，。.]+$/g;

/**
 * 净化检索词：
 *   ① 反复剥离尾部的页面代称（「百度首页」→「百度」，「xx官网首页」→「xx」）；
 *   ② 剥离后为空、或只剩站点名的，判为伪检索词丢弃（这正是「打开百度首页」被误做成搜索的元凶）。
 * 只做通用语言处理，不依赖任何站点结构；也**不**剥离词首的站点名 ——
 * 「百度地图」是一个合法检索词，剥掉「百度」会把它改坏。
 */
export function sanitizeQueryTerms(
  goal: string,
  terms: readonly unknown[],
  options: SanitizeQueryOptions = {},
  lexicon: TaskIntentLexicon | null = loadTaskIntentLexicon(),
): string[] {
  void goal;
  const words = stopwords(lexicon);
  const sites = new Set((options.siteTokens ?? []).map((t) => normalizeHaystack(t)).filter(Boolean));
  const out: string[] = [];

  for (const raw of terms) {
    let text = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    // ① 反复剥离尾部页面代称
    let changed = true;
    while (changed) {
      changed = false;
      const low = normalizeHaystack(text);
      for (const word of words) {
        if (low.length > word.length && low.endsWith(word)) {
          text = text.slice(0, text.length - word.length).replace(EDGE_PUNCT_RE, "").trim();
          changed = true;
          break;
        }
      }
    }
    if (!text) continue;

    // ② 剥离后仍是站点名/空 → 伪检索词（「百度首页」剥成「百度」）
    const low = normalizeHaystack(text);
    if (sites.has(low)) continue;
    if (low.length < 1) continue;

    out.push(text.trim());
  }

  return Array.from(new Set(out));
}
