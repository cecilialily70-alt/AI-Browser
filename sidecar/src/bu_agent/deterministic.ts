/**
 * 确定性加速器（Deterministic Accelerator）
 *
 * 背景（真实事故）：用户目标「打开百度搜索刘亦菲，然后点击打开图片栏，下载第二张图片」，
 * 运行时在第 2 步命中「本地 SERP 已匹配查询词」就直接跳过模型 `done` —— 目标里的后续交付动作
 * （点图片栏、下载第二张）被整体忽略，任务被自己的加速器判成「完成」，随后 judge 说未通过，
 * 但循环已经结束，无法重来。
 *
 * 于是把原先散在 service.ts 里的两条「跳过模型」路径收敛到本模块，并加一道**交付动作前提**：
 *   只有当目标**除了打开/搜索之外没有其它交付动作**时，才允许本地判完成；
 *   一旦目标里出现下载/点击/切换/第 N 项…这类后续动作，决策权必须交回模型
 *   （多花一次模型调用，换「不丢交付物」）。
 *
 * 交付动作词表来自外部数据文件（config/deliverable_lexicon.json），代码里不含任何站点文案；
 * 词表缺失时退化为「不识别后续动作」的旧行为，不会因为缺文件而炸掉主流程。
 *
 * 另一条修复（计划与执行解耦）：跳过模型时不再把计划晾在原地 —— 加速器会直接给出
 * 本次动作让计划推进到哪一项（`current_plan_item`），由 MessageManager 统一应用，
 * 避免「计划永远停在第一项」。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";
import { classifyGoalIntent, loadCompletionLexicon } from "../core/completion_evidence.js";
import { engineHomepage, isEngineHomepageUrl, matchEngineByUrl } from "../core/page_policy.js";
import { detectSerp } from "../core/page_kind.js";
import { goalRequestsSearch } from "../core/task_intent.js";
import { firstReachedTarget } from "../core/url_match.js";
import type { AgentOutput, PlanItem } from "./views.js";

export interface DeterministicInput {
  goal: string;
  queryTerms: string[];
  /** 当前计划（用于推进计划项；空数组表示不推进） */
  plan: PlanItem[];
  pageUrl: string;
  pageDigest?: string | null;
  goalNeedsUnderstanding: boolean;
  planNeedsUnderstanding: boolean;
  elementCount: number;
  /** 目标里明确的导航目标 URL（纯导航目标到达即完成）；缺省时不启用导航收尾 */
  navigationTargets?: string[];
  /** P0 判定的搜索引擎 id（缺省 = 配置里的默认引擎，通常是 google） */
  engineId?: string | null;
}

const MAX_TERM_LENGTH = 48;

let cached: string[] | null | undefined;

function lexiconCandidates(): string[] {
  const env = readAppEnv("DELIVERABLE_LEXICON");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/deliverable_lexicon.json"));
  out.push(join(here, "../../../config/deliverable_lexicon.json"));
  out.push(join(process.cwd(), "config", "deliverable_lexicon.json"));
  out.push(join(process.cwd(), "sidecar", "config", "deliverable_lexicon.json"));
  return out;
}

export function resolveDeliverableLexiconPath(): string | null {
  for (const candidate of lexiconCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* 单个候选路径异常不阻断 */
    }
  }
  return null;
}

/** 后续交付动作词表；文件缺失/损坏返回 null（调用方按「不识别」处理） */
export function loadDeliverableLexicon(): string[] | null {
  if (cached !== undefined) return cached;
  const path = resolveDeliverableLexiconPath();
  if (!path) {
    cached = null;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const terms = (parsed.terms ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(terms.followup) ? terms.followup : [];
    cached = Array.from(
      new Set(
        raw
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.replace(/\s+/g, " ").trim().toLowerCase())
          .filter((item) => item.length > 0 && item.length <= MAX_TERM_LENGTH),
      ),
    );
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * 目标是否含「打开/搜索之外」的交付动作。
 * 命中即代表：不能靠本地观察判完成，必须让模型看着页面继续推进。
 */
export function goalHasFollowupDeliverable(goal: string): boolean {
  const terms = loadDeliverableLexicon();
  if (!terms || terms.length === 0) return false;
  const hay = String(goal ?? "").toLowerCase();
  if (!hay.trim()) return false;
  return terms.some((term) => hay.includes(term));
}

/**
 * 是否停在搜索引擎结果页（宽松判定）。
 *
 * 唯一真值来源是 `core/page_kind.ts` 的 `detectSerp`：引擎主机、结果页形态、宽松特征
 * 全部收敛在那份政策数据里，本文件不再维护第二套引擎域名/路径正则（改造前这里有一份）。
 *
 * 刻意用 `serpLike`（宽松）而不是 `engineSerp`（严格）：本函数服务于**确定性加速器**的
 * 前置条件（"已经在结果页就不要再导航/可以本地收尾"），语义是**容错**的 ——
 * 用严格判定会丢掉未登记引擎的结果页，让那些任务失去本地收尾能力而空转。
 */
export function isSearchResultsUrl(url: string): boolean {
  return detectSerp(String(url ?? "")).serpLike;
}

export function queryMatchedOnPage(
  queryTerms: string[],
  digest: string,
  pageUrl: string,
): boolean {
  if (!queryTerms.length) return true;
  let decoded = pageUrl;
  try {
    decoded = decodeURIComponent(pageUrl);
  } catch {
    /* keep raw */
  }
  const hay = `${digest}\n${pageUrl}\n${decoded}`;
  return queryTerms.some(
    (q) =>
      Boolean(q) &&
      (hay.includes(q) ||
        pageUrl.includes(encodeURIComponent(q)) ||
        decoded.includes(q)),
  );
}

/**
 * 引擎首页地址（宪法合法路径的唯一入口）。
 *
 * 改造前这里是 `buildSearchUrlForQuery`：直接拼出 `?q=` / `?wd=` 的结果页地址并直达。
 * 那是**机器特征**（真人不在地址栏敲查询参数），也是站点风控弹验证码的直接诱因。
 * 现在只允许回到首页 —— 检索词的输入与提交是模型在页面上做的事（见《搜索宪法》）。
 */
function buildEngineHomepage(engineId?: string | null): string {
  return engineHomepage(engineId ?? null);
}

/**
 * 零成本把 Agent 送到搜索引擎首页（不调模型，也不拼检索词）。
 *
 * 前提（缺一不可，防止把别的任务做坏）：
 *   - 目标确实请求了搜索（纯导航目标不走这里）；
 *   - 目标没有「打开/搜索之外」的交付动作；
 *   - 当前已经在一个引擎页或空白页（不劫持无关页面的导航）；
 *   - **当前不在引擎首页**（否则每轮都会重复导航同一个地址 —— 死循环）；
 *   - 当前不在结果页（结果页是合法的后续观察点，不该被送回首页）。
 *
 * 注意：本动作**不推进计划项**。"到达首页" ≠ "检索完成"，输入检索词与提交才是模型的事；
 * 提前把计划项标成完成会让后续步骤直接跳过搜索（改造前正是靠拼 URL 才敢推进计划项）。
 */
export function tryDeterministicEngineHome(input: DeterministicInput): AgentOutput | null {
  if (!goalRequestsSearch(input.goal).requested) return null;
  if (goalHasFollowupDeliverable(input.goal)) return null;
  if (isSearchResultsUrl(input.pageUrl)) return null;
  if (isEngineHomepageUrl(input.pageUrl)) return null;

  const onEnginePage = matchEngineByUrl(input.pageUrl) !== null || /about:blank|^$/i.test(input.pageUrl);
  if (!onEnginePage) return null;

  const url = buildEngineHomepage(input.engineId);
  return {
    thinking: `本地直达引擎首页（跳过模型；控件=${input.elementCount}）· 检索词由模型在页面搜索框输入`,
    evaluation_previous_goal: "deterministic_engine_home",
    memory: `导航至引擎首页：${url}`,
    next_goal: "在引擎首页搜索框输入检索词并提交",
    action: [{ name: "navigate", params: { url } }],
  };
}

/**
 * 本地观察已足够验收时跳过远端 LLM。
 * - 普通搜索：SERP 匹配即可 done
 * - 总结/分析/探讨：不本地 done。page_digest 只作阅读材料，由模型写结论后再 done。
 *
 * **前提**：目标没有「打开/搜索之外」的交付动作。若有（下载/点栏目/第 N 项…），
 * 一律返回 null，把决策权交回模型 —— 加速器只对「搜到了就算完」的任务负责。
 */
export function tryDeterministicDone(input: DeterministicInput): AgentOutput | null {
  if (!isSearchResultsUrl(input.pageUrl)) {
    return null;
  }
  if (goalHasFollowupDeliverable(input.goal)) {
    return null;
  }
  const digest = String(input.pageDigest ?? "").trim();
  const qOk = queryMatchedOnPage(input.queryTerms, digest, input.pageUrl);
  if (!qOk) return null;

  const q = input.queryTerms[0] || "目标关键词";
  const needsSummary =
    input.goalNeedsUnderstanding || input.planNeedsUnderstanding;
  // 用户要结论：禁止把 page_digest 原文 dump 进 done，交回模型写答案。
  if (needsSummary) {
    return null;
  }

  // 全部交付物都在这一步达成 → 计划整体收尾（plan.length 大于最后一项下标，即可全标 done）
  const finishedPlanItem = input.plan.length;

  if (!digest && input.elementCount < 3) return null;

  const text = digest
    ? `已打开「${q}」相关搜索/资讯结果页，页面可读。\n${digest.slice(0, 600)}`
    : `已到达「${q}」搜索结果页：${input.pageUrl.slice(0, 160)}`;

  return {
    thinking: "本地 SERP/资讯页已匹配查询词，跳过模型直接 done",
    evaluation_previous_goal: "deterministic_serp_done",
    memory: text.slice(0, 240),
    next_goal: "完成",
    action: [{ name: "done", params: { text, success: true } }],
    current_plan_item: finishedPlanItem,
  };
}

/**
 * 纯导航目标（「打开 X」「访问 X」）到达目标 URL → 本地收尾，不再交给模型自由发挥。
 *
 * 这是用户报障的直接修复：目标「打开百度首页」在 bootstrap 打开首页后就该结束，
 * 但此前没有「到达即完成」的判据，模型/加速器会把任务继续做成搜索。判定前提：
 *   - 目标**没有**请求搜索（否则走搜索路径）；
 *   - 目标**没有**后续交付动作（下载/点击栏目/第 N 项…）；
 *   - 目标**不需要**理解页面（总结/分析…）；
 *   - 当前 URL 与目标 URL 结构匹配（见 core/url_match）。
 * 命中即 done，且把整条计划收尾。
 */
export function tryDeterministicNavigationDone(input: DeterministicInput): AgentOutput | null {
  const targets = input.navigationTargets ?? [];
  if (targets.length === 0) return null;
  if (goalHasFollowupDeliverable(input.goal)) return null;
  if (input.goalNeedsUnderstanding) return null;
  if (goalRequestsSearch(input.goal).requested) return null;
  // 结果型/信息型目标（注册、登录、提交、总结…）不是「打开页面就完事」，一律交回模型，
  // 不能因为当前 URL 恰好等于导航目标就提前收尾。
  if (classifyGoalIntent(input.goal, loadCompletionLexicon()) !== "generic") return null;
  const reached = firstReachedTarget(input.pageUrl, targets);
  if (!reached) return null;
  const text = `已打开目标页面：${reached}`;
  return {
    thinking: "目标为纯导航（打开/访问），当前 URL 已到达目标 → 本地收尾（跳过模型）",
    evaluation_previous_goal: "deterministic_navigation_done",
    memory: text,
    next_goal: "完成",
    action: [{ name: "done", params: { text, success: true } }],
    current_plan_item: input.plan.length,
  };
}
