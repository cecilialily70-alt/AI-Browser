/**
 * MACRO_ANALYZE 真相位：独立 Planner LLM（无 browser_state / 无 tools），产出 MacroPlan。
 * 契约真源：`agent_skills/macro-planner/SKILL.md`（勿推翻 §0 / §3 / Schema）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import {
  beginAgentLlmWait,
  createLlmClient,
  extractAssistantContent,
} from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import { readAppEnv } from "../app_env.js";
import type { SidecarAiSettings } from "../engine.js";
import { firstHit, normalizeHaystack } from "../core/text_match.js";
import { getSkillById, ensureSkillsLoaded } from "./skills/runtime.js";
import { extractJsonObject } from "./prompts.js";

/** 与 task_analyze.RuleSeed 对齐的最小字段（避免循环依赖） */
export interface MacroRuleSeed {
  urls: string[];
  siteHint: string | null;
  queryTerms: string[];
  acceptance: string | null;
  suggestedPlan: string[];
}

export type MacroPlanMode = "macro" | "micro_only";

export interface MacroSubtask {
  id: string;
  title: string;
  goal: string;
  entry_hint: string;
  parallel_group: string | null;
  depends_on: string[];
  skills_to_recall: string[];
  artifact_key: string;
  success_criteria: string[];
  on_fail: string;
  estimate_steps: number;
}

export interface MacroSynthesize {
  id: string;
  title?: string;
  format: string;
  dimensions: string[];
  skills_to_recall: string[];
}

export interface MacroPlan {
  mode: MacroPlanMode;
  mission: string;
  acceptance: string;
  assumptions: string[];
  subtasks: MacroSubtask[];
  synthesize: MacroSynthesize | null;
  replan_triggers: string[];
}

export interface MacroGateDecision {
  run: boolean;
  reasons: string[];
  siteCount: number;
  estimateSteps: number;
  lexiconHit: string | null;
}

export interface MacroAnalyzeResult {
  plan: MacroPlan;
  source: "llm" | "rule_fallback";
  /** 投影到执行环的标题计划（plan_update 形态） */
  projectedTitles: string[];
  bootstrapUrl: string | null;
  queryTerms: string[];
}

export interface MacroPlanLexicon {
  strongTriggers: string[];
  weakTriggers: string[];
  platformMarkers: string[];
  minSites: number;
  minEstimateSteps: number;
  stepsPerSite: number;
  synthesizeSteps: number;
}

const FALLBACK_STRONG = [
  "对比",
  "比价",
  "比较",
  "报告",
  "调研",
  "汇总",
  "多站点",
  "跨站",
  "跨平台",
  "三家",
  "两家",
  "几家",
  "几个平台",
  "多家",
  "长任务",
  "compare",
  "report",
  "multi-site",
];

const FALLBACK_WEAK = ["规划", "plan", "拆解", "子任务"];

const FUSE_REPLAN = "步数保险丝到顶仍无进展";

const FALLBACK_PLATFORMS = [
  "淘宝",
  "天猫",
  "京东",
  "拼多多",
  "亚马逊",
  "amazon",
  "知乎",
  "微博",
  "百度",
  "谷歌",
  "必应",
  "google",
  "bing",
  "baidu",
  "taobao",
  "jd",
];

let cachedLexicon: MacroPlanLexicon | null | undefined;

function lexiconCandidates(): string[] {
  const env = readAppEnv("MACRO_PLAN_LEXICON");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/macro_plan_lexicon.json"));
  out.push(join(here, "../../../config/macro_plan_lexicon.json"));
  out.push(join(process.cwd(), "config", "macro_plan_lexicon.json"));
  out.push(join(process.cwd(), "sidecar", "config", "macro_plan_lexicon.json"));
  return out;
}

function sanitizeTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((t) => String(t ?? "").trim())
        .filter((t) => t.length >= 2 && t.length <= 48),
    ),
  );
}

export function loadMacroPlanLexicon(): MacroPlanLexicon {
  if (cachedLexicon !== undefined && cachedLexicon !== null) return cachedLexicon;
  for (const path of lexiconCandidates()) {
    try {
      if (!path || !existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const thresholds =
        raw.thresholds && typeof raw.thresholds === "object"
          ? (raw.thresholds as Record<string, unknown>)
          : {};
      const strong = sanitizeTerms(
        (raw.strongTriggers as { terms?: unknown } | undefined)?.terms ?? raw.strongTriggers,
      );
      const weak = sanitizeTerms(
        (raw.weakTriggers as { terms?: unknown } | undefined)?.terms ?? raw.weakTriggers,
      );
      const platforms = sanitizeTerms(
        (raw.platformMarkers as { terms?: unknown } | undefined)?.terms ?? raw.platformMarkers,
      );
      cachedLexicon = {
        strongTriggers: strong.length ? strong : FALLBACK_STRONG,
        weakTriggers: weak.length ? weak : FALLBACK_WEAK,
        platformMarkers: platforms.length ? platforms : FALLBACK_PLATFORMS,
        minSites: Number(thresholds.minSites) || 2,
        minEstimateSteps: Number(thresholds.minEstimateSteps) || 8,
        stepsPerSite: Number(thresholds.stepsPerSite) || 3,
        synthesizeSteps: Number(thresholds.synthesizeSteps) || 2,
      };
      return cachedLexicon;
    } catch {
      /* 单个坏文件不阻断 */
    }
  }
  cachedLexicon = {
    strongTriggers: FALLBACK_STRONG,
    weakTriggers: FALLBACK_WEAK,
    platformMarkers: FALLBACK_PLATFORMS,
    minSites: 2,
    minEstimateSteps: 8,
    stepsPerSite: 3,
    synthesizeSteps: 2,
  };
  return cachedLexicon;
}

/** 统计目标中的独立站点信号（URL host + 平台标记），非站点硬编码选择器 */
export function countSitesInGoal(goal: string, lexicon = loadMacroPlanLexicon()): number {
  const text = String(goal ?? "");
  const hosts = new Set<string>();
  const fullUrlRe = /https?:\/\/[^\s，。；、）)\]」"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = fullUrlRe.exec(text))) {
    try {
      const host = new URL(m[0]!.replace(/[。．，,/;:：]+$/g, "")).hostname.toLowerCase();
      if (host) hosts.add(host.replace(/^www\./, ""));
    } catch {
      /* ignore */
    }
  }

  const hay = normalizeHaystack(text);
  const markers = new Set<string>();
  for (const term of lexicon.platformMarkers) {
    const hit = firstHit(hay, [term]);
    if (hit) markers.add(hit.toLowerCase());
  }
  return Math.max(hosts.size, markers.size);
}

export function estimateMacroSteps(
  goal: string,
  siteCount: number,
  lexicon = loadMacroPlanLexicon(),
  seed?: MacroRuleSeed | null,
): number {
  const fromSeed = seed?.suggestedPlan?.length ?? 0;
  const fromSites =
    Math.max(siteCount, 1) * lexicon.stepsPerSite +
    (siteCount >= 2 || /对比|比价|报告|汇总|compare|report/i.test(goal)
      ? lexicon.synthesizeSteps
      : 0);
  return Math.max(fromSeed, fromSites);
}

/**
 * 长程门禁：≥2 站点 / 预估 ≥8 步 / 对比报告类强触发 /（弱触发且已满足复杂度）。
 * 短任务不进 MACRO_ANALYZE，避免过度拆分。
 */
export function shouldRunMacroAnalyze(
  goal: string,
  seed?: MacroRuleSeed | null,
): MacroGateDecision {
  const lexicon = loadMacroPlanLexicon();
  const text = String(goal ?? "").trim();
  if (!text) return { run: false, reasons: [], siteCount: 0, estimateSteps: 0, lexiconHit: null };

  const siteCount = countSitesInGoal(text, lexicon);
  const estimateSteps = estimateMacroSteps(text, siteCount, lexicon, seed);
  const hay = normalizeHaystack(text);
  const strongHit = firstHit(hay, lexicon.strongTriggers.map((t) => t.toLowerCase()));
  const weakHit = firstHit(hay, lexicon.weakTriggers.map((t) => t.toLowerCase()));

  const reasons: string[] = [];
  if (siteCount >= lexicon.minSites) reasons.push(`sites>=${lexicon.minSites}:${siteCount}`);
  if (estimateSteps >= lexicon.minEstimateSteps) {
    reasons.push(`estimate_steps>=${lexicon.minEstimateSteps}:${estimateSteps}`);
  }
  if (strongHit) reasons.push(`strong:${strongHit}`);
  if (weakHit && (siteCount >= lexicon.minSites || estimateSteps >= lexicon.minEstimateSteps)) {
    reasons.push(`weak:${weakHit}`);
  }

  const run = reasons.length > 0;
  return {
    run,
    reasons,
    siteCount,
    estimateSteps,
    lexiconHit: strongHit ?? (run ? weakHit : null),
  };
}

function asStringArray(raw: unknown, max = 24): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 0)
    .slice(0, max);
}

function normalizeOnFail(raw: unknown): string {
  const s = String(raw ?? "replan").trim().toLowerCase();
  if (["retry_once", "skip_and_note", "replan", "hitl"].includes(s)) return s;
  return "replan";
}

function normalizeEntryHint(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function looksLikeUrl(hint: string): boolean {
  const t = hint.trim();
  if (/^https?:\/\//i.test(t)) return true;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return true;
  return false;
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(t)) return `https://${t}`;
  return t;
}

/** 校验并规范化 MacroPlan；不合格返回 null */
export function parseMacroPlan(raw: unknown): MacroPlan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const modeRaw = String(o.mode ?? "macro").trim().toLowerCase();
  const mode: MacroPlanMode = modeRaw === "micro_only" ? "micro_only" : "macro";
  const mission = String(o.mission ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  const acceptance = String(o.acceptance ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  const assumptions = asStringArray(o.assumptions, 12);
  const replan_triggers = asStringArray(o.replan_triggers, 12);

  const subtasksRaw = Array.isArray(o.subtasks) ? o.subtasks : [];
  const subtasks: MacroSubtask[] = [];
  for (let i = 0; i < subtasksRaw.length && subtasks.length < 12; i += 1) {
    const st = subtasksRaw[i];
    if (typeof st === "string" && st.trim()) {
      const title = st.trim().slice(0, 120);
      subtasks.push({
        id: `st_${subtasks.length + 1}`,
        title,
        goal: title,
        entry_hint: "",
        parallel_group: null,
        depends_on: [],
        skills_to_recall: [],
        artifact_key: `artifact_${subtasks.length + 1}`,
        success_criteria: ["完成该子任务目标"],
        on_fail: "replan",
        estimate_steps: 3,
      });
      continue;
    }
    if (!st || typeof st !== "object") continue;
    const s = st as Record<string, unknown>;
    const title = String(s.title ?? s.goal ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) continue;
    const id = String(s.id ?? `st_${subtasks.length + 1}`)
      .trim()
      .slice(0, 40) || `st_${subtasks.length + 1}`;
    const artifact =
      String(s.artifact_key ?? `artifact_${subtasks.length + 1}`)
        .trim()
        .replace(/\s+/g, "_")
        .slice(0, 64) || `artifact_${subtasks.length + 1}`;
    subtasks.push({
      id,
      title,
      goal: String(s.goal ?? title).replace(/\s+/g, " ").trim().slice(0, 400),
      entry_hint: normalizeEntryHint(s.entry_hint),
      parallel_group:
        s.parallel_group == null || s.parallel_group === ""
          ? null
          : String(s.parallel_group).trim().slice(0, 40),
      depends_on: asStringArray(s.depends_on, 8),
      skills_to_recall: asStringArray(s.skills_to_recall, 8),
      artifact_key: artifact,
      success_criteria: asStringArray(s.success_criteria, 8).length
        ? asStringArray(s.success_criteria, 8)
        : ["完成该子任务目标"],
      on_fail: normalizeOnFail(s.on_fail),
      estimate_steps: Math.min(
        20,
        Math.max(1, Number(s.estimate_steps) || 3),
      ),
    });
  }

  let synthesize: MacroSynthesize | null = null;
  if (o.synthesize && typeof o.synthesize === "object" && !Array.isArray(o.synthesize)) {
    const syn = o.synthesize as Record<string, unknown>;
    synthesize = {
      id: String(syn.id ?? "st_final").trim().slice(0, 40) || "st_final",
      title:
        typeof syn.title === "string" && syn.title.trim()
          ? syn.title.trim().slice(0, 120)
          : undefined,
      format: String(syn.format ?? "markdown_table").trim().slice(0, 40) || "markdown_table",
      dimensions: asStringArray(syn.dimensions, 12),
      skills_to_recall: asStringArray(syn.skills_to_recall, 8),
    };
  }

  // 验收：macro 必须有 subtasks；micro_only 可短
  if (mode === "macro" && subtasks.length < 2 && !synthesize) return null;
  if (subtasks.length === 0 && mode === "micro_only") {
    // 允许极短：用 mission 撑一条
    if (!mission && !acceptance) return null;
    subtasks.push({
      id: "st_1",
      title: mission || acceptance || "完成用户目标",
      goal: mission || acceptance || "完成用户目标",
      entry_hint: "",
      parallel_group: null,
      depends_on: [],
      skills_to_recall: [],
      artifact_key: "main",
      success_criteria: [acceptance || "对照用户请求验收并 done"],
      on_fail: "replan",
      estimate_steps: 2,
    });
  }
  if (subtasks.length === 0) return null;

  return {
    mode,
    mission: mission || subtasks[0]!.title,
    acceptance: acceptance || "对照用户请求验收并 done",
    assumptions,
    subtasks,
    synthesize: mode === "micro_only" ? synthesize : synthesize,
    replan_triggers: replan_triggers.length
      ? replan_triggers
      : ["连续采集失败", "关键字段全空", FUSE_REPLAN],
  };
}

/** 子任务标题投影（含 synthesize）；micro_only 不过度拆分 */
export function projectMacroPlanTitles(plan: MacroPlan): string[] {
  const titles = plan.subtasks.map((s) => s.title).filter(Boolean);
  if (plan.mode === "micro_only") {
    return titles.slice(0, 3);
  }
  if (plan.synthesize) {
    const synTitle =
      plan.synthesize.title?.trim() ||
      `汇总并输出最终报告（${plan.synthesize.format || "markdown_table"}）`;
    if (!titles.some((t) => /汇总|报告|对比|synthesize/i.test(t))) {
      titles.push(synTitle);
    }
  }
  return titles.slice(0, 12);
}

export function pickMacroBootstrapUrl(plan: MacroPlan, seedUrls: string[] = []): string | null {
  for (const st of plan.subtasks) {
    const hint = st.entry_hint.trim();
    if (looksLikeUrl(hint)) return normalizeUrl(hint.split(/\s+/)[0]!);
  }
  const seed = String(seedUrls[0] ?? "").trim();
  return seed ? normalizeUrl(seed) : null;
}

export function extractQueryTermsFromMacro(plan: MacroPlan, max = 6): string[] {
  const terms: string[] = [];
  const re = /[「"']([^「"'」]{1,40})[」"']|搜索[「"']?([^「"'\n，。；]{1,40})/;
  for (const st of plan.subtasks) {
    const blob = `${st.goal} ${st.entry_hint} ${st.title}`;
    const m = blob.match(re);
    const term = (m?.[1] || m?.[2] || "").trim();
    if (term && !terms.includes(term)) terms.push(term);
    if (terms.length >= max) break;
  }
  return terms;
}

/** 从 macro-planner SKILL 抽取 §3 Planner 系统提示；失败则用内置兜底（与 Skill 对齐） */
export function loadMacroPlannerSystemPrompt(): string {
  try {
    ensureSkillsLoaded();
    const skill = getSkillById("macro-planner");
    const body = skill?.body ?? "";
    const fence = body.match(/```text\r?\n([\s\S]*?)```/);
    if (fence?.[1]?.trim()) {
      return `${fence[1].trim()}

【输出 Schema 提醒】仅一个 JSON 对象，字段：mode, mission, acceptance, assumptions, subtasks[], synthesize, replan_triggers。
subtasks 每项含：id, title, goal, entry_hint, parallel_group, depends_on, skills_to_recall, artifact_key, success_criteria, on_fail, estimate_steps。
对比/多站类必须 mode="macro" 且拆成多站点 SubTask + synthesize；过简目标才 mode="micro_only"。`;
    }
  } catch {
    /* fall through */
  }
  return `你是天枢台的宏观任务规划器（Macro Planner）。
你处于独立的 Planner 相位：没有浏览器、没有工具目录、没有 action 契约。
你不操作浏览器，不调用底层点击/填写 API。你只产出结构化执行计划。

【职责】
1. 把 <user_request> 拆成有序 SubTask（建议 3–12 项），每项必须是「单站点或单交付」可执行单元。
2. 为每个 SubTask 标注：goal、entry_hint、success_criteria、skills_to_recall、depends_on、artifact_key。
3. 识别并行机会（parallel_group）。
4. 定义最终 SYNTHESIZE 子任务。
5. 若目标过简（1–3 步能完成）：输出短计划并设 mode="micro_only"，勿过度拆分。

【输出】仅输出一个 JSON 对象（不要 Markdown 围栏），含 mode/mission/acceptance/assumptions/subtasks/synthesize/replan_triggers。`;
}

/** 规则兜底：门禁已命中但 LLM 失败时，用站点/强触发拼一份可用 MacroPlan */
export function buildRuleFallbackMacroPlan(goal: string, seed?: MacroRuleSeed | null): MacroPlan {
  const lexicon = loadMacroPlanLexicon();
  const siteCount = countSitesInGoal(goal, lexicon);
  const markers: string[] = [];
  const hay = normalizeHaystack(goal);
  for (const term of lexicon.platformMarkers) {
    if (firstHit(hay, [term]) && !markers.includes(term)) markers.push(term);
  }
  const platforms = markers.length >= 2 ? markers.slice(0, 6) : markers;
  const subtasks: MacroSubtask[] = [];

  if (platforms.length >= 2) {
    for (let i = 0; i < platforms.length; i += 1) {
      const name = platforms[i]!;
      subtasks.push({
        id: `st_${i + 1}`,
        title: `在${name}采集目标信息`,
        goal: `在${name}打开相关页面，采集与用户目标相关的关键字段，写入 facts.jsonl`,
        entry_hint: name,
        parallel_group: "collect",
        depends_on: [],
        skills_to_recall: ["navigation-search", "extraction-scrape", "context-management"],
        artifact_key: `site_${i + 1}`,
        success_criteria: [`已打开${name}目标页`, "关键字段写入 facts.jsonl"],
        on_fail: "replan",
        estimate_steps: 4,
      });
    }
  } else if (seed?.suggestedPlan?.length) {
    for (let i = 0; i < Math.min(seed.suggestedPlan.length, 8); i += 1) {
      const title = seed.suggestedPlan[i]!;
      subtasks.push({
        id: `st_${i + 1}`,
        title,
        goal: title,
        entry_hint: seed.urls[0] ?? seed.siteHint ?? "",
        parallel_group: null,
        depends_on: i > 0 ? [`st_${i}`] : [],
        skills_to_recall: ["context-management"],
        artifact_key: `step_${i + 1}`,
        success_criteria: ["完成本步目标"],
        on_fail: "replan",
        estimate_steps: 3,
      });
    }
  } else {
    subtasks.push({
      id: "st_1",
      title: "理解目标并打开相关页面",
      goal: goal.slice(0, 200),
      entry_hint: seed?.urls[0] ?? "",
      parallel_group: null,
      depends_on: [],
      skills_to_recall: ["navigation-search"],
      artifact_key: "main",
      success_criteria: ["进入相关页面"],
      on_fail: "replan",
      estimate_steps: 3,
    });
    subtasks.push({
      id: "st_2",
      title: "采集并落盘关键事实",
      goal: "采集关键字段并写入 facts.jsonl",
      entry_hint: "",
      parallel_group: null,
      depends_on: ["st_1"],
      skills_to_recall: ["extraction-scrape", "context-management"],
      artifact_key: "facts",
      success_criteria: ["facts.jsonl 已写入"],
      on_fail: "replan",
      estimate_steps: 4,
    });
  }

  const needSynth =
    siteCount >= 2 ||
    platforms.length >= 2 ||
    Boolean(
      firstHit(
        normalizeHaystack(goal),
        lexicon.strongTriggers.map((t) => t.toLowerCase()),
      ),
    );

  return {
    mode: needSynth && subtasks.length >= 2 ? "macro" : "micro_only",
    mission: goal.replace(/\s+/g, " ").trim().slice(0, 200),
    acceptance: seed?.acceptance ?? "完成采集/对比并输出可检查结论后 done",
    assumptions: [],
    subtasks,
    synthesize: needSynth
      ? {
          id: "st_final",
          title: "汇总对比并输出报告",
          format: "markdown_table",
          dimensions: ["价格", "关键差异", "来源"],
          skills_to_recall: ["multi-site-compare", "context-management"],
        }
      : null,
    replan_triggers: ["连续两站采集失败", "关键字段全空", FUSE_REPLAN],
  };
}

export function formatMacroTodoMarkdown(plan: MacroPlan, currentIndex = 0): string {
  const lines = ["# todo", "", `## ${plan.mission}`, ""];
  const titles = projectMacroPlanTitles(plan);
  titles.forEach((title, i) => {
    const mark = i < currentIndex ? "x" : i === currentIndex ? " " : " ";
    const tag = i === currentIndex ? " ← current" : i < currentIndex ? " ✓" : "";
    lines.push(`- [${mark}] ${title}${tag}`);
  });
  if (plan.acceptance) {
    lines.push("", `> acceptance: ${plan.acceptance}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 独立 MACRO_ANALYZE 调用（无 browser_state / 无 tools）。
 * 失败时返回规则兜底 MacroPlan（门禁已命中时仍要有结构化 SubTask）。
 */
export async function runMacroAnalyze(input: {
  goal: string;
  aiSettings: SidecarAiSettings;
  signal?: AbortSignal;
  seed?: MacroRuleSeed | null;
}): Promise<MacroAnalyzeResult> {
  const seed = input.seed ?? null;
  const system = loadMacroPlannerSystemPrompt();
  const user = `<user_request>${input.goal}</user_request>
<rule_seed>${JSON.stringify({
    urls: seed?.urls ?? [],
    siteHint: seed?.siteHint ?? null,
    queryTerms: seed?.queryTerms ?? [],
    acceptance: seed?.acceptance ?? null,
    suggestedPlan: seed?.suggestedPlan ?? [],
  })}</rule_seed>
请输出 MacroPlan JSON。若目标是对比/比价/多站点汇总：必须 mode="macro"，按站点拆 SubTask，并含 synthesize。
若目标 1–3 步即可完成：mode="micro_only"，勿过度拆分。`;

  try {
    const router = createModelRouter(input.aiSettings);
    const resolved = router.resolve("logic");
    const client = createLlmClient(input.aiSettings);
    const wait = beginAgentLlmWait({
      parentSignal: input.signal,
      timeoutMs: 55_000,
    });
    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
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
      const parsed = extractJsonObject(content);
      const plan = parseMacroPlan(parsed);
      if (plan) {
        return finalizeMacroResult(plan, seed, "llm");
      }
    } finally {
      wait.stop();
    }
  } catch {
    /* fall through to rule fallback */
  }

  const fallback = buildRuleFallbackMacroPlan(input.goal, seed);
  return finalizeMacroResult(fallback, seed, "rule_fallback");
}

function finalizeMacroResult(
  plan: MacroPlan,
  seed: MacroRuleSeed | null,
  source: "llm" | "rule_fallback",
): MacroAnalyzeResult {
  // 短任务被误拆：若 LLM 给了 macro 但只有 1 个子任务且无 synthesize，压成 micro_only
  if (plan.mode === "macro" && plan.subtasks.length <= 1 && !plan.synthesize) {
    plan = { ...plan, mode: "micro_only" };
  }
  return {
    plan,
    source,
    projectedTitles: projectMacroPlanTitles(plan),
    bootstrapUrl: pickMacroBootstrapUrl(plan, seed?.urls ?? []),
    queryTerms: extractQueryTermsFromMacro(plan),
  };
}
