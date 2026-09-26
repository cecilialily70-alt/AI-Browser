/**
 * 零成本 page_kind 分类器（Phase 3.0 基建 · **尚未接线**）
 *
 * 定位：`page_policy.ts` 是**政策事实**（引擎在哪、什么算结果页 —— 不可协商的数据）。
 * 本文件是**本地判断**：把「URL 政策事实 + A11y 角色多重集 + 验证码信号」映射成一个
 * 页面类型结论。两者物理隔离，正是宪法第 0 条 "Policy vs. Judgment" 的落地。
 *
 * 为什么不并进 page_policy.ts：政策数据一旦掺入启发式，就会出现
 * 「同一个文件里既有不容置疑的引擎事实、又有可错的分类经验」——改分类时容易误伤政策。
 *
 * 产出字段**刻意与 `consult_contract.ts` 的 `classify_page` 结果逐字一致**：
 * 本地分不出来时可直接升级为 `askJson("classify_page")`，返回值**无需任何转换**即插即用。
 * 这是"一 Schema、两生产者"的关键 —— 本地与 LLM 的答案是同一种东西，只是贵贱不同。
 *
 * 成本纪律：本文件的全部计算都是纯内存操作，**永不发起任何网络请求**。
 */
import {
  isEngineHomepageUrl,
  loadSearchEnginePolicy,
  matchesEngineSerpNavigation,
  matchesLooseSerpUrl,
  matchEngineByUrl,
  type SearchEnginePolicy,
  type SearchEngineSpec,
} from "./page_policy.js";

/** 与 `ConsultResultMap["classify_page"]["kind"]` 逐字一致（刻意如此，见文件头） */
export type PageKind = "engine_home" | "engine_serp" | "captcha_gate" | "form" | "content" | "other";

/**
 * A11y 输入的最小结构契约。
 *
 * 刻意**不 import** `page_pipeline/extractor.js` 的 `A11yStructure`：`core/` 是被依赖的底层，
 * 让它反向依赖 `page_pipeline/` 会形成分层倒置。这里只声明"我需要什么形状"，
 * `A11yStructure` 因结构兼容而可直接传入（比耦合更强健）。
 */
export interface PageKindA11yInput {
  roles?: ReadonlyArray<{ role: string; name: string }>;
  roleCounts?: Readonly<Record<string, number>>;
  interactiveCount?: number;
}

/** 验证码信号（由既有 `detectCaptchaGate` 产出，本文件不重复实现检测逻辑） */
export interface PageKindCaptchaHint {
  present: boolean;
  interstitial: boolean;
  /** 非图片型（短信/邮箱/验证器动态码）：值只在用户本人手上 */
  nonImage: boolean;
  strategy: string | null;
}

export interface PageKindInput {
  url: string;
  title?: string;
  a11y?: PageKindA11yInput | null;
  captcha?: PageKindCaptchaHint | null;
  /** 观察层给的「存在阻断性遮挡」事实（与验证码是两件事：遮挡层下面是正常业务页） */
  hasBlockingOverlay?: boolean;
  policy?: SearchEnginePolicy | null;
}

export interface PageKindVerdict {
  kind: PageKind;
  engine: string | null;
  hasSearchBox: boolean;
  hasBlockingOverlay: boolean;
  /** 0~1。低于 `PAGE_KIND_CONSULT_THRESHOLD` 时值得花钱问 consult */
  confidence: number;
  /** 判定依据，逐条可审计（排查误判时看这里，不必猜） */
  evidence: string[];
  /**
   * 严格判定：主机属于已知引擎 **且** 路径/查询呈结果页形态。
   * 宪法与「结果页收尾」用它 —— 必须是引擎锚定的，不能靠宽松特征。
   */
  engineSerp: boolean;
  /**
   * 宽松判定：严格判定 ∪ 未登记引擎的历史特征（`?q=` / `/s?` / `tn=news` …）。
   * 「结果页已可读」这类**容错**判断用它。与 strict 分离是刻意的：
   * 宪法必须严格（宁可漏判也不误拦），收尾可以宽松（宁可多收也不空转）。
   */
  serpLike: boolean;
}

/** 低于此置信度 → 建议升级到 `askJson("classify_page")`（是否升级由 Arbiter 决定） */
export const PAGE_KIND_CONSULT_THRESHOLD = 0.75;

/**
 * URL 级结果页判定（**不需要任何页面结构**，因此可被纯 URL 调用方复用）。
 *
 * 为什么要单独抽出来：改造前 `isSearchResultsUrl` 是散落在 `deterministic.ts` 的第二个真值来源，
 * 与 `page_policy` 里的定义重复维护。现在把它收进 page_kind 这唯一出口，
 * 让"这是不是结果页"只有一个答案，`classifyPageKind` 自己也复用它（DRY）。
 *
 * 两个字段**刻意分离**，调用方必须自己选：
 *   · `engineSerp`（严格）—— 主机属于已知引擎 + 路径/查询呈结果页形态。宪法用；
 *   · `serpLike`（宽松）—— 严格 ∪ 未登记引擎的历史特征。**收尾容错**用。
 * 用错方向的代价不对称：宪法用宽松会误拦正常页面；收尾用严格会丢掉未登记引擎的收尾能力（空转）。
 */
export interface SerpSignal {
  engineId: string | null;
  engineSerp: boolean;
  serpLike: boolean;
}

export function detectSerp(
  url: string,
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): SerpSignal {
  const raw = String(url ?? "").trim();
  if (!raw) return { engineId: null, engineSerp: false, serpLike: false };
  const engine = matchEngineByUrl(raw, policy);
  const engineSerp = matchesEngineSerpNavigation(raw, policy);
  return {
    engineId: engine?.id ?? null,
    engineSerp,
    serpLike: engineSerp || matchesLooseSerpUrl(raw, policy),
  };
}

/** 搜索框语义（A11y name 匹配用）：只认高确定度的词，避免把登录框当搜索框 */
const SEARCH_NAME_RE = /搜索|检索|search|поиск|検索|검색|buscar|suchen|recherche/i;

const TEXT_FIELD_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"] as const;
const SUBMIT_HINT_RE =
  /登录|注册|提交|保存|发送|搜索|查询|继续|下一步|确定|确认|sign\s*in|log\s*in|login|register|submit|save|send|search|continue|next|confirm|create\s*account/i;
const PASSWORD_HINT_RE = /密码|口令|password|passcode/i;

/** `form` 判据：至少 2 个文本类输入，且存在提交语义或密码字段 */
const FORM_MIN_TEXT_FIELDS = 2;
/** `content` 判据：有标题 + 足够多的链接，且几乎没有输入框 */
const CONTENT_MIN_LINKS = 3;

function normalizeRole(role: string): string {
  return String(role ?? "").trim().toLowerCase();
}

interface A11yView {
  counts: Map<string, number>;
  /** role:小写 → 该 role 下的 name 列表（用于语义匹配） */
  namesByRole: Map<string, string[]>;
  interactiveCount: number;
  available: boolean;
}

function readA11y(input: PageKindA11yInput | null | undefined): A11yView {
  const counts = new Map<string, number>();
  const namesByRole = new Map<string, string[]>();
  let interactiveCount = 0;

  if (input) {
    for (const [role, count] of Object.entries(input.roleCounts ?? {})) {
      const key = normalizeRole(role);
      if (!key) continue;
      const n = Number(count);
      if (!Number.isFinite(n) || n <= 0) continue;
      counts.set(key, (counts.get(key) ?? 0) + Math.trunc(n));
    }
    for (const node of input.roles ?? []) {
      const key = normalizeRole(node?.role);
      const name = String(node?.name ?? "").replace(/\s+/g, " ").trim();
      if (!key || !name) continue;
      const list = namesByRole.get(key);
      if (list) {
        if (list.length < 40) list.push(name);
      } else {
        namesByRole.set(key, [name]);
      }
      // roleCounts 缺失时用节点自身兜底计数，避免"有 roles 无 counts"时误判为无控件
      if (!input.roleCounts) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (typeof input.interactiveCount === "number" && Number.isFinite(input.interactiveCount)) {
      interactiveCount = Math.max(0, Math.trunc(input.interactiveCount));
    }
  }

  const available = counts.size > 0 || namesByRole.size > 0;
  return { counts, namesByRole, interactiveCount, available };
}

function roleCount(view: A11yView, role: string): number {
  return view.counts.get(role) ?? 0;
}

function hasAnyRole(view: A11yView, roles: readonly string[]): boolean {
  return roles.some((role) => roleCount(view, role) > 0);
}

function anyNameMatches(view: A11yView, roles: readonly string[], pattern: RegExp): boolean {
  for (const role of roles) {
    for (const name of view.namesByRole.get(role) ?? []) {
      if (pattern.test(name)) return true;
    }
  }
  // 任何 role 下出现提交/密码语义也算（部分站点的按钮 role 不规范）
  for (const names of view.namesByRole.values()) {
    for (const name of names) {
      if (pattern.test(name)) return true;
    }
  }
  return false;
}

/** 搜索框判定：优先用引擎自己的 `searchBoxRoles`（政策数据），再退到通用语义 */function detectSearchBox(view: A11yView, engine: SearchEngineSpec | null): { hit: boolean; evidence: string | null } {
  const engineRoles = (engine?.searchBoxRoles ?? []).map(normalizeRole).filter(Boolean);
  const hitEngineRole = engineRoles.find((role) => roleCount(view, role) > 0);
  if (hitEngineRole) {
    return { hit: true, evidence: `a11y 含引擎搜索框 role=${hitEngineRole}` };
  }
  if (roleCount(view, "searchbox") > 0 || roleCount(view, "search") > 0) {
    return { hit: true, evidence: "a11y 含 searchbox/search role" };
  }
  const namedRoles = [...TEXT_FIELD_ROLES, "button"];
  if (anyNameMatches(view, namedRoles, SEARCH_NAME_RE)) {
    return { hit: true, evidence: "a11y 含搜索语义控件名" };
  }
  return { hit: false, evidence: null };
}

/**
 * 主分类。（纯函数：同输入必得同输出，无 I/O、无时间、无随机。）
 *
 * 判定优先级：captcha_gate → engine_serp → engine_home → form → content → other。
 * 验证码排在最前是刻意的：整页验证码时，**当下唯一有意义的动作是过验证**，
 * 此时把它归类为「这是 google 结果页」虽然也算对，但对决策毫无帮助。
 */
export function classifyPageKind(
  input: PageKindInput,
  /**
   * 必须默认 `loadSearchEnginePolicy()` 而不是 `null` ——
   * `page_policy` 内部把 `null` 解释为"用内置 `FALLBACK_ENGINE`"，
   * 传 null 会静默丢掉配置里的 baidu/bing/duckduckgo，导致那些引擎的结果页认不出来。
   */
  policy: SearchEnginePolicy | null = loadSearchEnginePolicy(),
): PageKindVerdict {
  const url = String(input.url ?? "").trim();
  const a11y = readA11y(input.a11y);
  const engine = url ? matchEngineByUrl(url, policy) : null;
  const engineId = engine?.id ?? null;
  const { engineSerp, serpLike } = detectSerp(url, policy);
  const engineHome = Boolean(url) && isEngineHomepageUrl(url, policy);
  const captcha = input.captcha ?? null;
  const hasBlockingOverlay = Boolean(input.hasBlockingOverlay);

  const searchBox = detectSearchBox(a11y, engine);
  const textFields = TEXT_FIELD_ROLES.reduce((sum, role) => sum + roleCount(a11y, role), 0);
  const linkCount = roleCount(a11y, "link");
  const headingCount = roleCount(a11y, "heading");
  const submitHit = anyNameMatches(a11y, ["button", "link"], SUBMIT_HINT_RE);
  const passwordHit = anyNameMatches(a11y, TEXT_FIELD_ROLES as readonly string[], PASSWORD_HINT_RE);

  const base = { engine: engineId, hasSearchBox: searchBox.hit, hasBlockingOverlay, engineSerp, serpLike };

  /* ——— 1. 验证码闸门 ——— */
  if (captcha?.present && captcha.interstitial) {
    const detail = captcha.nonImage ? "非图片型（值只在用户手上）" : captcha.strategy ? `可自动求解=${captcha.strategy}` : "类型未支持";
    return {
      ...base,
      kind: "captcha_gate",
      confidence: captcha.nonImage ? 0.9 : captcha.strategy ? 0.92 : 0.85,
      evidence: [`整页人机验证（${detail}）`],
    };
  }

  /* ——— 2. 引擎结果页（严格 → 宽松） ——— */
  if (engineSerp) {
    return {
      ...base,
      kind: "engine_serp",
      confidence: 0.98,
      evidence: [`URL 命中引擎 ${engineId} 的结果页形态`],
    };
  }

  /* ——— 3. 引擎首页 ——— */
  if (engineHome) {
    const evidence = [`URL 是引擎 ${engineId} 的根路径`];
    if (searchBox.evidence) evidence.push(searchBox.evidence);
    return {
      ...base,
      kind: "engine_home",
      // 有搜索框佐证才给高置信；只有 URL 佐证时稍低，但仍高于阈值（URL 是强证据）
      confidence: searchBox.hit ? 0.97 : 0.9,
      evidence,
    };
  }

  /* ——— 4. 表单页 ——— */
  if (a11y.available && textFields >= FORM_MIN_TEXT_FIELDS && (submitHit || passwordHit)) {
    const evidence = [`a11y 文本类输入 ${textFields} 个`];
    if (submitHit) evidence.push("存在提交语义控件");
    if (passwordHit) evidence.push("存在密码字段");
    return {
      ...base,
      kind: "form",
      confidence: passwordHit && submitHit ? 0.85 : 0.78,
      evidence,
    };
  }

  /* ——— 5. 内容页 ——— */
  if (a11y.available && headingCount >= 1 && linkCount >= CONTENT_MIN_LINKS && textFields === 0) {
    return {
      ...base,
      kind: "content",
      confidence: 0.72,
      evidence: [`a11y 标题 ${headingCount} + 链接 ${linkCount}，且无输入框`],
    };
  }

  /* ——— 6. 其它（低置信 → 值得问 consult） ——— */
  const evidence: string[] = [];
  if (!a11y.available) {
    evidence.push("A11y 结构缺失，无法凭结构判定");
  } else {
    evidence.push(
      `a11y 未构成已知形态（输入 ${textFields} · 链接 ${linkCount} · 标题 ${headingCount}）`,
    );
  }
  if (serpLike && !engineSerp) {
    evidence.push("URL 带未登记引擎的结果页特征（宽松判定，不足以当严格结果页）");
  }
  return {
    ...base,
    kind: "other",
    // 结构缺失时给最低置信 —— 这正是应该花钱问 consult 的场景
    confidence: a11y.available ? 0.4 : 0.3,
    evidence,
  };
}

/** 该结论是否值得花钱问 consult（纯判定，不做请求） */
export function pageKindNeedsConsult(verdict: PageKindVerdict): boolean {
  return verdict.confidence < PAGE_KIND_CONSULT_THRESHOLD;
}
