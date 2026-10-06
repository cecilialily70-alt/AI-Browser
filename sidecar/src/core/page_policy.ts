/**
 * 页面政策（Page Policy）——搜索引擎宪法的事实源与判定原语。
 *
 * 背景（真实事故）：Agent 会自己拼接搜索引擎结果页 URL 直达 SERP。这既是**机器特征**
 * （真人从不在地址栏敲 `?wd=`），也是站点风控弹验证码的直接诱因。宪法要求：
 * 需要检索时必须「打开引擎首页 → 在搜索框输入检索词 → 点搜索按钮或 Enter」。
 *
 * 本模块只做**政策判断**（硬编码事实 + 纯函数），不含任何 LLM 判断：
 *   - 引擎数据（首页地址 / 主机匹配 / 结果页形态 / 搜索框与提交控件）全部来自
 *     `config/search_engines.json`，代码层零引擎域名与选择器字面量；
 *   - `classifyNavigationPolicy` 回答「这一步动作想去的地方是不是宪法禁止的直达 SERP」。
 *
 * 与「判断类词表」的区别：引擎集合是**封闭、稳定**的政策事实（不是语义猜测），
 * 因此适合数据驱动 + 硬拦截，而不是交给模型判断。
 *
 * 文件缺失时退化为内置 google 兜底，绝不因缺文件炸掉主流程。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";

export interface SearchEngineSpec {
  id: string;
  /** 引擎首页地址（宪法合法路径的入口） */
  homepage: string;
  /** 主机名匹配（已编译） */
  hostPattern: RegExp | null;
  /** 结果页形态：匹配 `pathname + search`（已编译） */
  serpPatterns: RegExp[];
  /** 首页搜索框选择器（表单搜索用） */
  searchBoxSelectors: string[];
  /** 首页提交控件选择器（表单搜索用） */
  submitSelectors: string[];
  /** 搜索框在无障碍树里的 role（page_kind 分类器用） */
  searchBoxRoles: string[];
}

export interface SearchEnginePolicy {
  defaultEngine: string;
  engines: SearchEngineSpec[];
  /** 查询参数型结果页特征（与引擎主机组合使用才是精确的） */
  querySerpPatterns: RegExp[];
}

/** 本任务的宪法政策状态：由 service 创建并随 ActionContext 下传。 */
export interface TaskPolicyState {
  /**
   * 本任务内是否已在引擎首页的搜索框里输入过检索词。
   * 这是宪法「合法路径」的标志：填过框之后，点击搜索结果/建议链接不再算「直达 SERP」。
   */
  searchBoxFilled: boolean;
}

export function createTaskPolicyState(): TaskPolicyState {
  return { searchBoxFilled: false };
}

const MAX_PATTERN_LENGTH = 200;

function compile(source: unknown): RegExp | null {
  if (typeof source !== "string") return null;
  const pattern = source.trim();
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function compileList(raw: unknown): RegExp[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => compile(item))
    .filter((item): item is RegExp => item !== null);
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_PATTERN_LENGTH);
}

/** 内置兜底：仅在配置文件缺失/损坏时使用（仍是「数据」，不是散落字面量） */
const FALLBACK_ENGINE: SearchEngineSpec = {
  id: "google",
  homepage: "https://www.google.com/",
  hostPattern: /(^|\.)google\.[a-z]{2,}(\.[a-z]{2,})?$/i,
  serpPatterns: [/^\/search/i],
  searchBoxSelectors: ['input[name="q"]'],
  submitSelectors: ['input[type="submit"]'],
  searchBoxRoles: ["textbox"],
};

const FALLBACK_QUERY_SERP = [/[?&](wd|word|q|query|keyword)=/i];

let cached: SearchEnginePolicy | null | undefined;

function policyCandidates(): string[] {
  const env = readAppEnv("SEARCH_ENGINES");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/search_engines.json"));
  out.push(join(here, "../../../config/search_engines.json"));
  out.push(join(process.cwd(), "config", "search_engines.json"));
  out.push(join(process.cwd(), "sidecar", "config", "search_engines.json"));
  return out;
}

export function resolveSearchEnginePolicyPath(): string | null {
  for (const candidate of policyCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* 单个候选路径异常不阻断 */
    }
  }
  return null;
}

export function loadSearchEnginePolicy(): SearchEnginePolicy | null {
  if (cached !== undefined) return cached;
  const path = resolveSearchEnginePolicyPath();
  if (!path) {
    cached = null;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const rawEngines = Array.isArray(parsed.engines) ? parsed.engines : [];
    const engines: SearchEngineSpec[] = [];
    for (const item of rawEngines) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const id = String(entry.id ?? "").trim().toLowerCase();
      const homepage = String(entry.homepage ?? "").trim();
      if (!id || !homepage) continue;
      engines.push({
        id,
        homepage,
        hostPattern: compile(entry.hostPattern),
        serpPatterns: compileList(entry.serpPatterns),
        searchBoxSelectors: stringList(entry.searchBoxSelectors),
        submitSelectors: stringList(entry.submitSelectors),
        searchBoxRoles: stringList(entry.searchBoxRoles),
      });
    }
    if (engines.length === 0) {
      cached = null;
      return cached;
    }
    const loose = (parsed.legacyLooseSerpPatterns ?? {}) as Record<string, unknown>;
    const loosePatterns = compileList(loose.patterns);
    cached = {
      defaultEngine: String(parsed.default ?? engines[0]!.id).trim().toLowerCase() || engines[0]!.id,
      engines,
      querySerpPatterns: loosePatterns.length ? loosePatterns : FALLBACK_QUERY_SERP,
    };
  } catch {
    cached = null;
  }
  return cached;
}

function allEngines(policy: SearchEnginePolicy | null): SearchEngineSpec[] {
  return policy?.engines.length ? policy.engines : [FALLBACK_ENGINE];
}

function querySerpPatterns(policy: SearchEnginePolicy | null): RegExp[] {
  return policy?.querySerpPatterns.length ? policy.querySerpPatterns : FALLBACK_QUERY_SERP;
}

/** 按 id 取引擎；id 为空或未知时返回默认引擎（政策：未指定则 google） */
export function engineSpec(
  id?: string | null,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): SearchEngineSpec {
  const engines = allEngines(policy);
  const want = String(id ?? "").trim().toLowerCase();
  if (want) {
    const hit = engines.find((engine) => engine.id === want);
    if (hit) return hit;
  }
  const fallbackId = policy?.defaultEngine;
  return engines.find((engine) => engine.id === fallbackId) ?? engines[0]!;
}

/** 默认引擎 id（政策：用户没指明时用配置里的 default，通常 google） */
export function defaultEngineId(policy: SearchEnginePolicy | null = loadSearchEnginePolicy()): string {
  return engineSpec(null, policy).id;
}

/** 引擎首页地址：宪法合法路径的唯一入口 */
export function engineHomepage(
  id?: string | null,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): string {
  return engineSpec(id, policy).homepage;
}

/** 可选引擎 id 列表（Consult 的 engine_fallback 闭集来源） */
export function engineIds(policy: SearchEnginePolicy | null = loadSearchEnginePolicy()): string[] {
  return allEngines(policy).map((engine) => engine.id);
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(String(url ?? "").trim());
  } catch {
    return null;
  }
}

/** 该 URL 属于哪个引擎（按主机匹配）；非引擎站点返回 null */
export function matchEngineByUrl(
  url: string,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): SearchEngineSpec | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname;
  for (const engine of allEngines(policy)) {
    if (engine.hostPattern?.test(host)) return engine;
  }
  return null;
}

/** 引擎主机的裸域名 token（homepage 反推，用于扫脚本文本） */
function engineHostToken(engine: SearchEngineSpec): string | null {
  try {
    const host = new URL(engine.homepage).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/**
 * 引擎站点上的结果页（含路径型与查询参数型）。
 * 两个条件同时成立才算：主机属于该引擎 + 路径/查询呈现结果页形态。
 * 主机这一半是关键 —— 它把「任意站点的 ?q= 页面」排除在外，避免误拦无关页面。
 */
export function matchesEngineSerpNavigation(
  url: string,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const engine = matchEngineByUrl(url, policy);
  if (!engine) return false;
  const target = `${parsed.pathname}${parsed.search}`;
  if (engine.serpPatterns.some((pattern) => pattern.test(target))) return true;
  return querySerpPatterns(policy).some((pattern) => pattern.test(target));
}

/** 改造前的宽松结果页特征（只读识别兼容用；不适用于导航裁决） */
export function matchesLooseSerpUrl(
  url: string,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): boolean {
  const raw = String(url ?? "").trim();
  if (!raw) return false;
  return querySerpPatterns(policy).some((pattern) => pattern.test(raw)) ||
    /\/s(\?|\/)|tn=news|\/sf\/vsearch/i.test(raw);
}

/**
 * 是否停在引擎首页（确定性导航的「已在首页就别再导航」判据）
 */
export function isEngineHomepageUrl(
  url: string,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (!matchEngineByUrl(url, policy)) return false;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path !== "") return false;
  return !matchesEngineSerpNavigation(url, policy);
}

export interface EngineSearchAffordanceInput {
  url: string;
  /** 动作类型：只有 fill / click 可豁免（select/evaluate 不享受） */
  kind: string;
  /** 控件的无障碍 role（观察层的 element.role） */
  role?: string | null;
  inputType?: string | null;
  /** 控件的 HTML name 与观察层选择器文本：用于对齐配置声明的提交控件身份 */
  name?: string | null;
  selector?: string | null;
}

/**
 * 从 CSS 选择器里抽出可判等的**身份 token**（`name="btnK"` / `#sb_form_go`）。
 * 刻意只取 name/id/aria-label 这类身份属性：
 * 类名（`.search-btn`）太通用，拿它判等会把无关控件也算进来。
 */
function selectorIdentityTokens(selectors: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const raw of selectors) {
    for (const m of String(raw).matchAll(/(?:name|id|aria-label)\s*[*^$|~]?=\s*"([^"]+)"/g)) {
      const value = m[1].trim().toLowerCase();
      if (value) tokens.add(value);
    }
    for (const m of String(raw).matchAll(/#([A-Za-z0-9_-]+)/g)) {
      tokens.add(m[1].toLowerCase());
    }
  }
  return [...tokens];
}

/**
 * 「引擎首页的搜索动作」豁免判据（《搜索宪法》配套的政策事实）。
 *
 * 背景（用户现场）：在 google 首页点「Google 搜尋」弹出了人工确认框 —— 因为该控件的
 * 可访问名里带 `submit`（`<input type="submit">` 的类型名被拼进了标签），命中了 HITL
 * 词典里的敏感词。但**在引擎首页做搜索是只读检索意图**：它不改变远端任何状态、不可逆性为零。
 * 把它当"敏感提交"拦截，等于每次搜索都打断用户，与用户目标直接冲突。
 *
 * 因此这里给出一条**政策级豁免**（不是放宽词典，而是承认"搜索不是提交"这一事实）。
 * 判据全部来自 `search_engines.json`，代码里没有任何引擎域名或选择器字面量：
 *   · 必须停在引擎**首页**（`isEngineHomepageUrl`）—— 结果页/其它站点上的按钮不在豁免范围；
 *   · 动作是 `fill`（往搜索框填词）或 `click`（点搜索框或提交控件）；
 *   · 控件是配置声明的搜索框 role，或配置声明的提交控件（`type=submit/search`，或命中选择器身份）。
 *
 * 返回 null = 不豁免（判定交回 HITL 词典）；返回字符串 = 豁免理由（进日志，可审计）。
 * ⚠️ 本函数**不负责** critical 级别的否决：调用方必须在 critical 判定之后才使用它 ——
 * 「不可逆动作任何情况下都要确认」是词典里的硬约束，豁免不能绕过它。
 */
export function engineSearchExemption(
  input: EngineSearchAffordanceInput,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): string | null {
  const kind = String(input.kind ?? "").trim().toLowerCase();
  if (kind !== "fill" && kind !== "click") return null;
  if (!isEngineHomepageUrl(input.url, policy)) return null;
  const engine = matchEngineByUrl(input.url, policy);
  if (!engine) return null;

  const role = String(input.role ?? "").trim().toLowerCase();
  const type = String(input.inputType ?? "").trim().toLowerCase();
  const boxRoles = engine.searchBoxRoles.map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (role && boxRoles.includes(role)) {
    return `在 ${engine.id} 首页的搜索框（role=${role}）上${kind === "fill" ? "输入" : "点击"}属只读检索意图`;
  }
  // 往输入框填词只豁免搜索框本身：引擎首页上别的输入框（账号等）照旧判定
  if (kind === "fill") return null;

  if (type === "submit" || type === "search") {
    return `${engine.id} 首页的表单提交控件（type=${type}）就是搜索按钮，属只读检索意图`;
  }
  const identityHay = `${input.name ?? ""} ${input.selector ?? ""}`.trim().toLowerCase();
  if (identityHay) {
    const hit = selectorIdentityTokens(engine.submitSelectors).find((token) =>
      identityHay.includes(token),
    );
    if (hit) {
      return `${engine.id} 首页的搜索提交控件（命中配置身份「${hit}」）属只读检索意图`;
    }
  }
  return null;
}

/** 该 URL 是否出现在文本里（用户目标原文豁免：用户自己给的地址不算机器构造） */export function urlAppearsInText(text: string | null | undefined, url: string): boolean {
  const hay = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!hay) return false;
  const raw = String(url ?? "").trim().toLowerCase();
  if (!raw) return false;
  const variants = new Set<string>();
  for (const candidate of [
    raw,
    raw.replace(/^https?:\/\//, ""),
    raw.replace(/^https?:\/\/www\./, ""),
  ]) {
    const normalized = candidate.replace(/\/+$/, "").replace(/\s+/g, "");
    if (normalized.length >= 8) variants.add(normalized);
  }
  for (const variant of variants) {
    if (hay.includes(variant)) return true;
  }
  return false;
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s"'`)\]}]+/gi;
const QUOTED_LITERAL_RE = /'([^'\n]{1,300})'|"([^"\n]{1,300})"/g;

/** evaluate 脚本是否会真的发生导航（只读脚本不受宪法影响，不能误拦） */
function scriptNavigates(script: string): boolean {
  return /location\s*(\.href)?\s*=|location\.(assign|replace)\s*\(|window\.open\s*\(/i.test(script);
}

function quotedLiterals(script: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  QUOTED_LITERAL_RE.lastIndex = 0;
  while ((match = QUOTED_LITERAL_RE.exec(script))) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (value) out.push(value);
  }
  return out;
}

/** 相对路径形态的结果页（脚本里 `'/search?q=' + x` 这类构造） */
function looksLikeEngineSerpPath(text: string, policy: SearchEnginePolicy | null): boolean {
  const candidate = String(text ?? "").trim();
  if (!candidate.startsWith("/")) return false;
  return allEngines(policy).some((engine) =>
    engine.serpPatterns.some((pattern) => pattern.test(candidate)),
  );
}

function scriptMentionsEngineSerp(script: string, policy: SearchEnginePolicy | null): boolean {
  const hay = script.toLowerCase();
  for (const engine of allEngines(policy)) {
    const token = engineHostToken(engine);
    if (!token || !hay.includes(token)) continue;
    if (engine.serpPatterns.some((pattern) => pattern.test(script))) return true;
    if (querySerpPatterns(policy).some((pattern) => pattern.test(script))) return true;
  }
  return false;
}

export interface NavigationPolicyInput {
  /** 动作名：navigate / click / evaluate … */
  actionName: string;
  /** 动作要去的目的地：navigate 的 url，或 click 命中的元素 href */
  targetUrl?: string | null;
  /** evaluate 的脚本文本 */
  scriptText?: string | null;
  /**
   * 当前页面地址。用于判定「相对路径构造」是否构成宪法违规：
   * 只有在**引擎页面上**拼 `/search?q=` 才是绕过填表的 SERP 构造；
   * 在别的站点上，`/search-results` 这类相对路径是再正常不过的站内地址，不能拦。
   */
  pageUrl?: string | null;
  /** 用户原始目标（豁免依据，必须是目标原文，不采信模型当轮自述） */
  goalText?: string | null;
  /** 本任务内是否已在引擎搜索框输入过检索词 */
  searchBoxFilled?: boolean;
}

export interface NavigationPolicyVerdict {
  allowed: boolean;
  /** 面向模型的拒绝原因（含正确姿势指引）；allowed=true 时为空 */
  reason: string;
  /** 命中的引擎 id（日志用） */
  engineId: string | null;
  /** 被拦下的地址 */
  blockedUrl: string | null;
}

const ALLOWED: NavigationPolicyVerdict = {
  allowed: true,
  reason: "",
  engineId: null,
  blockedUrl: null,
};

const CONSTITUTION_PATH_HINT =
  "需要检索时必须走真人路径 —— 先 navigate 到引擎首页，用 input 在搜索框里输入检索词，" +
  "再点击页面上的搜索按钮或 send_keys(Enter)；禁止自己拼接 ?q= / ?wd= 这类结果页地址。";

function violation(url: string, engineId: string | null, detail: string): NavigationPolicyVerdict {
  return {
    allowed: false,
    reason: `宪法禁止直达搜索引擎结果页${detail ? `（${detail}）` : ""}：${url}。${CONSTITUTION_PATH_HINT}`,
    engineId,
    blockedUrl: url,
  };
}

/**
 * 宪法裁决：这一步动作想去的地址，是不是「机器构造的直达 SERP」。
 *
 * 判据是**输入**（要去哪），不是**结果**（最终 URL 长什么样）——
 * 宪法合法路径（首页填表提交）本身也会到达 SERP，按结果判会把合法路径一起拦死。
 *
 * 豁免：
 *   - 用户在目标原文里给出的地址（不是机器构造的）；
 *   - 已在引擎首页输入过检索词之后，点击页面上的结果/建议链接（真人也是这么点的）。
 */
export function classifyNavigationPolicy(
  input: NavigationPolicyInput,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): NavigationPolicyVerdict {
  const goal = input.goalText ?? "";
  const target = String(input.targetUrl ?? "").trim();

  if (target && matchesEngineSerpNavigation(target, policy)) {
    if (urlAppearsInText(goal, target)) return ALLOWED;
    // 已经按宪法填过搜索框：之后的点击（结果项/搜索建议）是真人行为，放行
    if (input.actionName === "click" && input.searchBoxFilled) return ALLOWED;
    return violation(target, matchEngineByUrl(target, policy)?.id ?? null, `动作 ${input.actionName}`);
  }

  const script = String(input.scriptText ?? "");
  if (input.actionName === "evaluate" && script && scriptNavigates(script)) {
    const onEnginePage = matchEngineByUrl(String(input.pageUrl ?? ""), policy) !== null;
    const candidates = [...(script.match(URL_IN_TEXT_RE) ?? []), ...quotedLiterals(script)];
    for (const candidate of candidates) {
      if (urlAppearsInText(goal, candidate)) continue;
      const absolute = matchesEngineSerpNavigation(candidate, policy);
      // 相对路径只在引擎页面上才算「绕过填表构造 SERP」；别的站点的 /search-x 是正常地址
      const relative = onEnginePage && looksLikeEngineSerpPath(candidate, policy);
      if (absolute || relative) {
        return violation(candidate, matchEngineByUrl(candidate, policy)?.id ?? null, "evaluate 内导航");
      }
    }
    if (onEnginePage && scriptMentionsEngineSerp(script, policy)) {
      return violation("(脚本内构造的引擎结果页地址)", null, "evaluate 内导航");
    }
  }

  return ALLOWED;
}
