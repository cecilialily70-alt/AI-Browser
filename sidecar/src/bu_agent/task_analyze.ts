/**
 * Phase A：任务分析（规则 + 短 LLM）
 * 不传 browser_state / 不抽 DOM；产出 plan + 可选 bootstrap navigate。
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  beginAgentLlmWait,
  createLlmClient,
  extractAssistantContent,
} from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import { classifyGoalIntent, loadCompletionLexicon } from "../core/completion_evidence.js";
import { goalRequestsSearch, sanitizeQueryTerms } from "../core/task_intent.js";
import { engineHomepage } from "../core/page_policy.js";
import type { SidecarAiSettings } from "../engine.js";
import { GOAL_INTENT_VALIDATOR, canonicalEngineId, type GoalIntent } from "./consult_contract.js";
import { goalHasFollowupDeliverable } from "./deterministic.js";
import { droppedExpectTokens, sanitizeExpects, type PlanStepLike } from "./plan_expects.js";
import {
  runMacroAnalyze,
  shouldRunMacroAnalyze,
  type MacroPlan,
} from "./macro_analyze.js";
import { extractJsonObject } from "./prompts.js";
import type { AgentAction } from "./views.js";
import { buildTaskContract, classifyDeliverableText, type TaskContract } from "./task_contract.js";

export interface RuleSeed {
  urls: string[];
  siteHint: string | null;
  /** 命中的站点若是一个搜索引擎，给出其政策 id（google/baidu/bing…），否则 null */
  siteEngineId: string | null;
  queryTerms: string[];
  acceptance: string | null;
  suggestedPlan: string[];
  /** 目标是否显式请求了搜索（false = 纯导航/打开类目标） */
  searchRequested: boolean;
  /** 目标是否要求"读懂并告知"（本地信号；3.3 会与 Arbiter 的 P0 意图统一） */
  wantsUnderstanding: boolean;
}

/** P0 意图的来源，便于在真实任务里统计"模型给的对不对" */
export type IntentSource = "llm" | "llm_filled" | "rule";

export interface TaskAnalyzeResult {
  plan: string[];
  /**
   * 计划 + 每项的期望（双形态的统一落盘形态）。
   *
   * 这是 `expects` 的**唯一入口**：改造后 Agent 主路径走强制 function calling，
   * 那条路根本不产出 `plan_update`（见 `agentOutputFromToolCalls`），所以指望模型
   * 在执行中补期望是不现实的 —— 必须在规划相位一次给全。
   */
  planSteps: PlanStepLike[];
  /**
   * 供日志留痕：模型原始 `plan_expects` 里**被本地丢弃**的 token。
   *
   * 期望 token 只接受 `role` / `role:名称`（`a11y_roles.ts` 闭集词表），自由文本会被静默裁剪。
   * 不把原文留在日志里的话，将来期望被大批丢弃时我们只会看到"没有 violation"，
   * 无从发现判据其实已经被清空 —— 静默的失效比报错更难查。
   */
  planExpectsDropped: string[];
  /**
   * P0 结构化意图（与 consult 的 `classify_goal` **同 Schema**）。
   *
   * ⚠️ Phase 3.2 只做**影子产出**：它是"世界模型"的一部分，但**尚未参与任何裁决**
   * （3.3 才交给 Arbiter）。之所以现在就产出，是为了在真实任务里先量出准确率，
   * 而不是等它开始影响决策了才发现判错。
   */
  intent: GoalIntent;
  intentSource: IntentSource;
  bootstrapActions: AgentAction[];
  queryTerms: string[];
  acceptance: string | null;
  /** 目标是否请求了搜索：false 时禁止凭检索词自动构造搜索 URL */
  searchRequested: boolean;
  /** 目标里明确的导航目标 URL（纯导航目标到达即完成） */
  navigationTargets: string[];
  /** 任务契约：目标要求交付什么（逐项可核销），done 闸门按它验收 */
  contract: TaskContract;
  source: "rule+llm" | "rule_only" | "macro_analyze" | "macro_analyze_fallback";
  /**
   * MACRO_ANALYZE 产出的富计划（仅长程任务有值）。
   * 正文落盘 `plan.json`；执行环只消费投影后的 `plan` 标题。
   */
  macroPlan: MacroPlan | null;
  /** 长程门禁原因（日志用）；短任务为空 */
  macroGateReasons: string[];
}

type SiteAlias = { re: RegExp; url: string; label: string; engineId?: string };

/** 搜索引擎首页走 page_policy，不写死在本文件。 */
const SEARCH_ENGINE_ALIASES: SiteAlias[] = [
  { re: /百度|baidu/i, url: engineHomepage("baidu"), label: "百度", engineId: "baidu" },
  { re: /谷歌|google/i, url: engineHomepage("google"), label: "谷歌", engineId: "google" },
  { re: /必应|bing/i, url: engineHomepage("bing"), label: "必应", engineId: "bing" },
];

let cachedSiteHomepages: SiteAlias[] | null = null;

function siteHomepageCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "../../config/macro_plan_lexicon.json"),
    join(here, "../../../config/macro_plan_lexicon.json"),
    join(process.cwd(), "config", "macro_plan_lexicon.json"),
    join(process.cwd(), "sidecar", "config", "macro_plan_lexicon.json"),
  ];
}

/** 站名 → 首页。数据在 macro_plan_lexicon.json 的 siteHomepages，缺文件则不补这些站。 */
function loadConfiguredSiteHomepages(): SiteAlias[] {
  if (cachedSiteHomepages) return cachedSiteHomepages;
  for (const path of siteHomepageCandidates()) {
    try {
      if (!path || !existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        siteHomepages?: { entries?: unknown };
      };
      const entries = raw.siteHomepages?.entries;
      if (!Array.isArray(entries)) continue;
      const out: SiteAlias[] = [];
      for (const item of entries) {
        if (!item || typeof item !== "object") continue;
        const row = item as { label?: unknown; pattern?: unknown; url?: unknown };
        const label = typeof row.label === "string" ? row.label.trim() : "";
        const pattern = typeof row.pattern === "string" ? row.pattern.trim() : "";
        const url = typeof row.url === "string" ? row.url.trim() : "";
        if (!label || !pattern || !/^https?:\/\//i.test(url)) continue;
        try {
          out.push({ re: new RegExp(pattern, "i"), url, label });
        } catch {
          /* 坏正则跳过这一条 */
        }
      }
      cachedSiteHomepages = out;
      return out;
    } catch {
      /* 下一个候选路径 */
    }
  }
  cachedSiteHomepages = [];
  return cachedSiteHomepages;
}

function siteAliases(): SiteAlias[] {
  return [...SEARCH_ENGINE_ALIASES, ...loadConfiguredSiteHomepages()];
}

/** 规则层：URL / 站点 / 检索词 / 默认计划骨架 */
export function ruleSeedFromGoal(goal: string): RuleSeed {
  const text = String(goal ?? "").trim();
  const urls: string[] = [];
  const urlRe = /https?:\/\/[^\s，。；、）)\]」"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text))) {
    urls.push(m[0].replace(/[。．，,/;:：]+$/g, ""));
  }
  // 最长 URL 优先（完整路径压过仅域名）
  urls.sort((a, b) => b.length - a.length);

  let siteHint: string | null = null;
  let siteUrl: string | null = null;
  let siteEngineId: string | null = null;
  for (const alias of siteAliases()) {
    if (alias.re.test(text)) {
      siteHint = alias.label;
      siteUrl = alias.url;
      siteEngineId = alias.engineId ?? null;
      break;
    }
  }
  if (siteUrl && !urls.includes(siteUrl)) {
    urls.push(siteUrl);
  }

  const queryTerms: string[] = [];
  const searchRequested = goalRequestsSearch(text).requested;
  const searchMatch =
    text.match(/(?:搜索|搜一下|查找|查询)\s*[「"']?([^「"'\n，。；]{1,40})/) ||
    text.match(/(?:百度|谷歌|必应)搜索\s*[「"']?([^「"'\n，。；]{1,40})/);
  if (searchRequested && searchMatch?.[1]) {
    queryTerms.push(searchMatch[1].trim().replace(/[然后并]+.*$/, "").trim());
  }

  let acceptance: string | null = null;
  const wantsUnderstanding =
    /总结|摘要|概括|分析|解读|介绍|是谁|是什么|怎么样|告诉我|详情|内容|汇报|提取信息|探讨|讨论|点评|评价|评估|综述|梳理/.test(
      text,
    );
  if (/总结|摘要|概括/.test(text)) {
    acceptance = "根据页面内容用自己的话总结关键信息并 done（遵守字数要求，禁止粘贴 page_digest 原文）";
  } else if (wantsUnderstanding) {
    acceptance = "根据页面阅读写出分析/结论并 done（禁止粘贴 page_digest 原文）";
  }
  if (/第一条|第一条结果|第一条搜索/.test(text)) {
    acceptance = (acceptance ? `${acceptance}；` : "") + "读取并汇报第一条搜索结果";
  }

  // 搜索类目标：合并微步骤，避免「找框/输入/回车/确认」拆成 6+ 步
  const suggestedPlan: string[] = [];
  const isSimpleSearch =
    queryTerms.length > 0 &&
    Boolean(urls[0] || siteHint) &&
    !/(注册|登录|填写|下单|支付|上传|多页|爬取|采集)/.test(text);

  if (isSimpleSearch) {
    suggestedPlan.push(`打开 ${urls[0] || siteHint} 并搜索「${queryTerms[0]}」`);
    if (acceptance) {
      suggestedPlan.push(acceptance);
    } else {
      suggestedPlan.push("确认搜索结果页已打开，根据 page_digest 用自己的话写结论并 done");
    }
    if (!suggestedPlan.some((p) => /done|验收/.test(p))) {
      suggestedPlan.push("对照用户请求验收并调用 done");
    }
  } else {
    if (urls[0] || siteHint) {
      suggestedPlan.push(`打开 ${urls[0] || siteHint}`);
    }
    if (queryTerms.length) {
      suggestedPlan.push(`在搜索框输入「${queryTerms[0]}」并提交`);
      suggestedPlan.push("确认已进入搜索结果页");
    }
    if (acceptance) {
      suggestedPlan.push(acceptance);
    }
    if (!suggestedPlan.length) {
      suggestedPlan.push("理解目标并打开相关页面");
      suggestedPlan.push("定位并完成必要交互");
      suggestedPlan.push("对照用户请求验收并 done");
    } else if (!/done|验收|总结|完成/.test(suggestedPlan[suggestedPlan.length - 1] ?? "")) {
      suggestedPlan.push("对照用户请求验收并调用 done");
    }
  }

  // 目标里写明的后续交付动作（点击栏目 / 下载第 N 项 / 勾选 / 提交…）必须各占一步：
  // 规则层不做站点推断，直接把用户原话里的动作句变成计划项，避免「搜到就算完」。
  for (const clause of String(goal).split(/[，。；；、,;.!?！？\n]+|(?:然后|接着|之后|随后)/)) {
    const text = clause.trim();
    if (text.length < 2) continue;
    const kind = classifyDeliverableText(text);
    if (!kind || kind === "navigation" || kind === "content_read" || kind === "answer_given") continue;
    if (suggestedPlan.some((item) => item.includes(text) || text.includes(item.replace(/^执行[:：]\s*/, "")))) continue;
    suggestedPlan.push(`执行：${text}`);
  }

  const cleanQueryTerms = searchRequested
    ? sanitizeQueryTerms(text, queryTerms, { siteTokens: siteHint ? [siteHint] : [] })
    : [];

  return {
    urls,
    siteHint,
    siteEngineId,
    queryTerms: cleanQueryTerms,
    acceptance,
    suggestedPlan,
    searchRequested,
    wantsUnderstanding,
  };
}

function bootstrapFromRules(seed: RuleSeed): AgentAction[] {
  const url = seed.urls[0];
  if (!url) return [];
  return [{ name: "navigate", params: { url } }];
}

/**
 * 目标是否**点名**要求打开某个 URL/站点。
 *
 * 这是「信息型目标能不能拥有 navigation 交付物」的唯一判据：`总结/分析这个网站` 的阅读对象
 * 就是当前页，目标里没有 URL 也没有站名时，任何 navigation 交付物都是臆造 —— 它会因为
 * 「页面从未离开起始地址」被永久判未达成，把 done 卡死在驳回循环里（见 task_contract）。
 */
function explicitNavigationFromSeed(seed: RuleSeed): boolean {
  return seed.urls.length > 0 || seed.siteHint !== null || seed.searchRequested;
}

/**
 * 规则层意图：LLM 缺失/判坏时的兜底。
 *
 * 判定顺序刻意与 `classify_goal` 的分类口径一致：
 *   search（有检索动作）> understand（要读懂并告知）> navigate（只是打开）> task（多步操作）
 * search 排最前是因为口径里写明"哪怕顺带说打开某引擎首页"也算 search。
 */
export function deriveGoalIntent(goal: string, seed: RuleSeed): GoalIntent {
  const kind: GoalIntent["kind"] = seed.searchRequested
    ? "search"
    : seed.wantsUnderstanding
      ? "understand"
      : seed.urls.length || seed.siteHint
        ? "navigate"
        : "task";
  return {
    kind,
    // 口径：仅当用户在目标里**点名**了搜索引擎时才给 id —— 所以看 siteEngineId 而不是 kind
    engine: seed.siteEngineId,
    query: seed.searchRequested ? (seed.queryTerms[0] ?? null) : null,
    needsFollowup: goalHasFollowupDeliverable(goal),
  };
}

/**
 * 读取模型给的 P0 意图。
 *
 * 关键取舍：**`kind` 绝不兜底**。其余三个字段缺失时用规则层的值补上（并如实标记为 `llm_filled`），
 * 因为补一个 engine=null / needsFollowup=规则值 最多是保守；而 kind 补错会**直接把任务导向错误路径**
 * （把 search 判成 navigate，就会去"打开引擎首页"然后停手）。所以 kind 一旦判坏，整份意图退回规则层。
 *
 * `source` 的口径：`llm` = 模型给全且原样可用；`llm_filled` = 有字段由本地补齐或规范化过；
 * `rule` = 整份退回规则层（模型没给 / kind 判坏）。
 */
export function readGoalIntent(
  raw: unknown,
  rules: GoalIntent,
): { intent: GoalIntent; source: IntentSource } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { intent: rules, source: "rule" };
  }
  const o = raw as Record<string, unknown>;
  let filled = false;
  let engine = o.engine;
  if (engine === undefined) {
    engine = null;
    filled = true;
  }
  // 引擎必须落在政策闭集内：`BAIDU` → `baidu`（规范化），未知引擎 → null（不留假 id）。
  // 只要值与模型给的原文不同，就如实标记 llm_filled —— 我们确实动过这个字段。
  const canonicalEngine = canonicalEngineId(engine);
  if (canonicalEngine !== engine) filled = true;
  engine = canonicalEngine;
  let query = o.query;
  if (query === undefined) {
    query = null;
    filled = true;
  }
  let needsFollowup = o.needsFollowup;
  if (typeof needsFollowup !== "boolean") {
    needsFollowup = rules.needsFollowup;
    filled = true;
  }
  // 唯一裁决者仍是契约生成的校验器（枚举、类型、长度上限全在那边）
  const checked = GOAL_INTENT_VALIDATOR({ kind: o.kind, engine, query, needsFollowup });
  // `ConsultValidation.ok` 不是可辨识联合，TS 收窄不到 value —— 显式判一次非空
  if (!checked.ok || !checked.value) return { intent: rules, source: "rule" };
  return { intent: checked.value, source: filled ? "llm_filled" : "llm" };
}

/**
 * Phase A 入口：规则 +（可选 MACRO_ANALYZE）+ 短 LLM（失败则纯规则兜底）
 *
 * 长程门禁命中时先跑独立 MACRO_ANALYZE（无 browser_state / 无 tools），
 * 再把 MacroPlan 投影为执行环 plan 标题；短任务仍走原扁平 Planner。
 */
export async function analyzeTask(input: {
  goal: string;
  aiSettings: SidecarAiSettings;
  signal?: AbortSignal;
}): Promise<TaskAnalyzeResult> {
  const seed = ruleSeedFromGoal(input.goal);
  const ruleBootstrap = bootstrapFromRules(seed);
  const gate = shouldRunMacroAnalyze(input.goal, seed);

  if (gate.run) {
    const macro = await runMacroAnalyze({
      goal: input.goal,
      aiSettings: input.aiSettings,
      signal: input.signal,
      seed,
    });
    return taskAnalyzeFromMacro(input.goal, seed, macro, gate.reasons, ruleBootstrap);
  }

  try {
    const router = createModelRouter(input.aiSettings);
    const resolved = router.resolve("logic");
    const client = createLlmClient(input.aiSettings);
    const wait = beginAgentLlmWait({
      parentSignal: input.signal,
      timeoutMs: 45_000,
    });

    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `你是任务分析器（独立 Planner 相位：无浏览器、无工具、无 action 契约）。
根据用户自然语言拆解有序执行计划，并把目标编译成**可逐项验收的交付物清单**。
禁止输出页面观察或 DOM，禁止输出工具调用或 action（那是 Execute 相位的契约）。只输出 JSON：
{"plan":["步骤1","步骤2",...],"plan_expects":[{"url_pattern":"baidu.com","state_change":"url_changed"},null,...],"intent":{"kind":"navigate|search|understand|task","engine":"google或null","query":"纯检索词或null","needsFollowup":false},"bootstrap_url":"https://...或空","query_terms":["关键词"],"acceptance":"验收标准","deliverables":[{"text":"交付物原话","kind":"navigation|content_read|field_filled|choice_made|submitted|download|element_state|answer_given","hints":["判定线索"],"required":true}]}
规则：
- **按交付物拆步，不按操作拆步**：每一个 deliverables 至少对应一个 plan 步骤；目标里写明的后续动作一步都不能省（用户说「搜索→点图片栏目→下载第二张图」就是 3 项交付物、至少 3 步）
- 只有「找搜索框 / 输入 / 点按钮 / 等待加载」这类同一动作内部的微操作才合并为一步（用 multi_act）
- 禁止写「观察当前页」「截图」「提取 DOM」作为计划项（运行时会自动观察）
- 简体中文，可执行（打开并搜索→确认结果→验收 done）
- deliverables.kind 只能取上面 8 种之一；hints 填「判定这项是否完成时可对照的线索」（栏目名、序数词、文件名、检索词），不要写站点选择器
- **plan_expects 必须与 plan 等长、逐项对齐**：第 i 项描述"做完 plan[i] 之后页面应该变成什么样"。写不出期望就填 null（宁可为 null，也不要臆造），但能写就写——它是运行时零成本自检的依据。
- plan_expects 字段用法：url_pattern 用**子串或通配符**（如 "baidu.com"、"/user/*/profile"），**不要写正则**；must_appear_in_a11y / must_not_appear 填页面上（不）应出现的 **A11y 控件语义**，只允许两种写法：「role」（如 "textbox"、"button"、"link"、"heading"）或「role:名称」（如 "textbox:搜索"、"button:登录"、"link:下一页"）；state_change 取 url_changed/dom_reloaded/none，**优先 url_changed**（dom_reloaded 运行时无法核实，填了也不会被检查）。
- **must_appear_in_a11y / must_not_appear 里绝对禁止填网页可见文案**：禁止 "搜索结果列表"、"下一页"、"登录按钮" 这类自由文本，也禁止自造 role（如 "search_results"）。这类值匹配不到无障碍树上的 role:名称 标签，会在本地被直接丢弃，等于白写。role 只能取 textbox/searchbox/combobox/button/link/heading/list/listitem/checkbox/radio/switch/tab/menuitem/dialog/img/paragraph/table 等标准无障碍角色名。
- intent 是**全局**目标分类（不是逐项）：navigate=只是打开某站点/页面；search=要检索/查询（哪怕顺带说打开某引擎首页）；understand=交付物是"读懂并告诉我"；task=含填表/登录/注册/下载/下单等多步操作。engine 仅当用户**点名**了搜索引擎时填其 id（google/baidu/bing/duckduckgo），否则 null。query 仅 search 时填**纯检索词**（剥掉站点名、"首页/官网"这类代称），否则 null。needsFollowup=目标除打开/搜索外还有后续动作（点击某项/下载/切栏目…）。
- **纯导航目标**：若目标是「打开/访问某站点首页/主页」而**没有**搜索/查询/查找等检索动词，则 query_terms 必须为 []，计划里**不得出现「搜索…」步骤**——「首页/主页/官网」是页面代称，不是检索词；否则任务会被误做成搜索。
- 若用户只要「打开/搜索」：交付物就是 navigation（到达结果页），不要加「深度分析网页」
- 若用户要「分析/总结/是谁/介绍」：交付物是 answer_given（结论），并在计划中保留一步「根据页面阅读回答并 done」
- **交付物 kind 必须与 text 的语义一致**（系统会按 text 重新裁定 kind）：把一句总结/分析文案标成 navigation 会被判成自相矛盾的脏数据
- **信息型目标（总结/分析/介绍「这个网站/这个页面」）禁止输出 navigation 交付物**：阅读对象就是当前打开的页面，任务不需要、也不应该导航离开。只有当用户**明确给出 URL 或点名站点**（如「打开 https://… 并总结」）时才允许 navigation。契约里混入一条注定无法核销的 navigation，会让 done 被反复驳回、任务原地打转。
- 若用户目标已含完整 https?:// URL（含路径），bootstrap_url 必须原样使用该 URL，禁止截成域名首页或截断路径
- 若目标仅含搜索引擎/站点名而无完整 URL，bootstrap_url 可填首页
- 不要写「观察当前页」作为第一步（除非用户明确要求分析当前已打开页）`,
      },
      {
        role: "user",
        content: `<user_request>${input.goal}</user_request>
<rule_seed>${JSON.stringify(seed)}</rule_seed>
请在 rule_seed 基础上完善 plan 与 deliverables。rule_seed.urls[0] 若已是完整目标 URL，bootstrap_url 必须与之相同（勿改成站点首页）。
注意：rule_seed.suggestedPlan 里已经包含「执行：…」这样的后续动作项，它们来自用户原话，必须全部保留在 plan 与 deliverables 中，不得删减、不得降级为可选。`,
      },
    ];

    try {
      const completion = await client.chat.completions.create(
        {
          model: resolved.model,
          messages,
          temperature: 0.1,
          response_format: { type: "json_object" },
        } as never,
        { signal: wait.signal },
      );
      const content = extractAssistantContent(completion);
      const parsed = extractJsonObject(content) as Record<string, unknown>;
      const planRaw = Array.isArray(parsed.plan) ? parsed.plan : seed.suggestedPlan;
      const searchRequested = seed.searchRequested;
      let plan = compactPlan(
        planRaw.map((p) => String(p ?? "").trim()).filter(Boolean),
        seed,
      );
      // 目标没请求搜索，模型却擅自插入「搜索…」步骤 → 丢掉（否则会把导航任务做成搜索任务）
      let planCameFromLlm = true;
      if (!searchRequested) {
        const dropped = dropUnrequestedSearchSteps(plan, seed);
        // 引用相等 = 没有被整段替换成规则骨架。被替换后索引就不再对应模型的 plan_expects，
        // 此时认领期望会把 A 的期望挂到 B 上 —— 宁可整批丢弃（见下方 expectsAligned）。
        planCameFromLlm = dropped === plan;
        plan = dropped;
      }
      const intentRaw = parsed.intent;
      const ruleIntent = deriveGoalIntent(input.goal, seed);
      const { intent, source: intentSource } = readGoalIntent(intentRaw, ruleIntent);
      const llmBootstrap = String(parsed.bootstrap_url ?? "").trim();
      const bootstrapUrl = pickBootstrapUrl(llmBootstrap, seed.urls);
      const rawQueryTerms = Array.isArray(parsed.query_terms)
        ? parsed.query_terms.map((t) => String(t).trim()).filter(Boolean)
        : seed.queryTerms;
      // 只有目标真的请求了搜索，才接受检索词；并剥掉「站点名+首页」这类伪检索词
      const queryTerms = searchRequested
        ? sanitizeQueryTerms(input.goal, rawQueryTerms, {
            siteTokens: seed.siteHint ? [seed.siteHint] : [],
          })
        : [];
      const acceptance =
        typeof parsed.acceptance === "string" && parsed.acceptance.trim()
          ? parsed.acceptance.trim()
          : seed.acceptance;

      const bootstrapActions: AgentAction[] = bootstrapUrl
        ? [{ name: "navigate", params: { url: normalizeUrl(bootstrapUrl) } }]
        : ruleBootstrap;

      const finalPlan = plan.length ? plan : seed.suggestedPlan;
      const planSteps = attachPlanExpects(finalPlan, parsed.plan_expects, planCameFromLlm && finalPlan === plan);
      return {
        plan: finalPlan,
        planSteps,
        planExpectsDropped: droppedExpectTokens(parsed.plan_expects),
        intent,
        intentSource,
        bootstrapActions,
        queryTerms,
        acceptance,
        searchRequested,
        navigationTargets: seed.urls,
        contract: buildTaskContract({
          goal: input.goal,
          intent: classifyGoalIntent(input.goal, loadCompletionLexicon()),
          raw: parsed.deliverables,
          plan: finalPlan,
          queryTerms,
          explicitNavigation: explicitNavigationFromSeed(seed),
        }),
        source: "rule+llm",
        macroPlan: null,
        macroGateReasons: [],
      };
    } finally {
      wait.stop();
    }
  } catch {
    return {
      plan: seed.suggestedPlan,
      // 规则层不产出期望：它只知道用户原话，不知道页面会变成什么样 —— 凭空造期望
      // 会制造"事实"，而错的期望比没有期望贵得多（3.3 会据此触发付费咨询与误重规划）。
      planSteps: seed.suggestedPlan.map((text) => ({ text })),
      planExpectsDropped: [],
      intent: deriveGoalIntent(input.goal, seed),
      intentSource: "rule",
      bootstrapActions: ruleBootstrap,
      queryTerms: seed.queryTerms,
      acceptance: seed.acceptance,
      searchRequested: seed.searchRequested,
      navigationTargets: seed.urls,
      contract: buildTaskContract({
        goal: input.goal,
        intent: classifyGoalIntent(input.goal, loadCompletionLexicon()),
        raw: null,
        plan: seed.suggestedPlan,
        queryTerms: seed.queryTerms,
        explicitNavigation: explicitNavigationFromSeed(seed),
      }),
      source: "rule_only",
      macroPlan: null,
      macroGateReasons: [],
    };
  }
}

/** 把 MACRO_ANALYZE 结果投影为执行环可用的 TaskAnalyzeResult */
function taskAnalyzeFromMacro(
  goal: string,
  seed: RuleSeed,
  macro: Awaited<ReturnType<typeof runMacroAnalyze>>,
  gateReasons: string[],
  ruleBootstrap: AgentAction[],
): TaskAnalyzeResult {
  const finalPlan =
    macro.projectedTitles.length > 0 ? macro.projectedTitles : seed.suggestedPlan;
  const bootstrapUrl = macro.bootstrapUrl
    ? pickBootstrapUrl(macro.bootstrapUrl, seed.urls)
    : pickBootstrapUrl("", seed.urls);
  const bootstrapActions: AgentAction[] = bootstrapUrl
    ? [{ name: "navigate", params: { url: normalizeUrl(bootstrapUrl) } }]
    : ruleBootstrap;
  const searchRequested = seed.searchRequested;
  const queryTerms = searchRequested
    ? sanitizeQueryTerms(goal, macro.queryTerms.length ? macro.queryTerms : seed.queryTerms, {
        siteTokens: seed.siteHint ? [seed.siteHint] : [],
      })
    : [];
  const acceptance = macro.plan.acceptance || seed.acceptance;
  const intent = deriveGoalIntent(goal, seed);

  return {
    plan: finalPlan,
    planSteps: finalPlan.map((text) => ({ text })),
    planExpectsDropped: [],
    intent,
    intentSource: "rule",
    bootstrapActions,
    queryTerms,
    acceptance,
    searchRequested,
    navigationTargets: seed.urls,
    contract: buildTaskContract({
      goal,
      intent: classifyGoalIntent(goal, loadCompletionLexicon()),
      raw: null,
      plan: finalPlan,
      queryTerms,
      explicitNavigation: explicitNavigationFromSeed(seed),
    }),
    source: macro.source === "llm" ? "macro_analyze" : "macro_analyze_fallback",
    macroPlan: macro.plan,
    macroGateReasons: gateReasons,
  };
}

/** 计划硬上限；上限只用来防脏数据灌爆提示词，不决定任务复杂度（多交付目标必须留够步数） */
const PLAN_HARD_CAP = 12;

/** 计划项是否是「搜索」动作：目标没请求搜索时，这类项一律是模型的臆造，必须丢掉 */
const SEARCH_STEP_RE = /搜索|搜一下|搜一搜|搜尋|查找|查询|检索|檢索|\bsearch\b|look\s*up|query/i;

function dropUnrequestedSearchSteps(plan: string[], seed: RuleSeed): string[] {
  const filtered = plan.filter((item) => !SEARCH_STEP_RE.test(item));
  return filtered.length ? filtered : seed.suggestedPlan;
}

/** 后续交付动词：命中说明这条计划项是「交付动作」，压缩时不许被丢掉 */
const DELIVER_ACTION_RE = /执行[:：]|下载|保存|导出|勾选|提交|上传|点击|点开|进入|切换|翻页|下一|填写|填入/;

function compactPlan(plan: string[], seed: RuleSeed): string[] {
  const cleaned = plan
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^(观察|截图|提取\s*DOM|等待页面|感知页面)/i.test(p));

  // 只在「模型把后续交付动作整段吃掉」时才用规则骨架兜底：
  // 否则一律以模型计划为准（模型更懂上下文），避免旧实现那种「简单搜索强制压到 5 步」把交付动作砍掉。
  const seedDeliverActions = seed.suggestedPlan.filter((p) => DELIVER_ACTION_RE.test(p)).length;
  const keptDeliverActions = cleaned.filter((p) => DELIVER_ACTION_RE.test(p)).length;
  if (
    seedDeliverActions > 0 &&
    keptDeliverActions < seedDeliverActions &&
    cleaned.length <= PLAN_HARD_CAP
  ) {
    return seed.suggestedPlan.slice(0, PLAN_HARD_CAP);
  }

  return cleaned.slice(0, PLAN_HARD_CAP);
}

/**
 * 把模型给的 `plan_expects`（与 plan 等长、逐项对齐）绑到计划项上。
 *
 * `aligned` 为假时**整批丢弃**：只要最终计划不是模型自己那份（空了 → 退回规则骨架，
 * 或整段被 dropUnrequestedSearchSteps 替换），索引就不再对应，此时认领期望等于
 * 把 A 的期望挂到 B 上 —— 正是 3.0 里定下的"宁可无期望，绝不给状态机喂错误事实"。
 */
export function attachPlanExpects(
  plan: string[],
  rawExpects: unknown,
  aligned: boolean,
): PlanStepLike[] {
  if (!aligned || !Array.isArray(rawExpects) || rawExpects.length !== plan.length) {
    return plan.map((text) => ({ text }));
  }
  return plan.map((text, i) => {
    const expects = sanitizeExpects(rawExpects[i]);
    return expects ? { text, expects } : { text };
  });
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(t)) return `https://${t}`;
  return t;
}

/**
 * 选择 bootstrap URL：用户目标里已写出的完整 URL 优先于 LLM 截断的首页。
 * 修复：goal 含 topic/2 完整路径，但 LLM 只回 origin → Agent 停在首页。
 */
export function pickBootstrapUrl(llmUrl: string, seedUrls: string[]): string {
  const seed = String(seedUrls[0] ?? "").trim();
  const llm = String(llmUrl ?? "").trim();
  if (!llm && !seed) return "";
  if (!llm) return seed;
  if (!seed) return normalizeUrl(llm);

  const seedNorm = normalizeUrl(seed);
  const llmNorm = normalizeUrl(llm);

  // seed 以 llm 为前缀且更长 → LLM 截断（含 match20 / 仅域名）
  if (seedNorm.toLowerCase().startsWith(llmNorm.toLowerCase()) && seedNorm.length > llmNorm.length) {
    return seedNorm;
  }

  try {
    const s = new URL(seedNorm);
    const l = new URL(llmNorm);
    if (s.origin === l.origin) {
      const seedPath = s.pathname.replace(/\/$/, "") || "/";
      const llmPath = l.pathname.replace(/\/$/, "") || "/";
      // LLM 回首页或更短路径，seed 更具体
      if (llmPath === "/" && seedPath !== "/") return seedNorm;
      if (seedPath.startsWith(llmPath) && seedPath.length > llmPath.length) return seedNorm;
      // 同 origin 时：目标原文 URL 优先
      if (/^https?:\/\//i.test(seed)) return seedNorm;
    }
  } catch {
    /* ignore */
  }

  // 目标含显式 https URL 时，默认信任规则抽取
  if (/^https?:\/\//i.test(seed)) return seedNorm;
  return llmNorm;
}

/** 当前 plan 项是否需要页面观察（交互/验收） */
export function planItemNeedsObservation(planText: string | undefined | null): boolean {
  const t = String(planText ?? "").trim();
  if (!t) return true;
  // 纯打开/导航且无其它交互词 → 可不观察（bootstrap 已处理）
  if (
    /^(打开|导航|前往|访问)/.test(t) &&
    !/(输入|点击|搜索框|按钮|填写|总结|提取|结果|验收)/.test(t)
  ) {
    return false;
  }
  return true;
}
