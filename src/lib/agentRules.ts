/**
 * 「规则」库：用户自定义规则 + 人设（前端侧数据层）。
 *
 * 背景（用户需求）：
 *   - Agent 底部「规则」按钮打开的窗口里，用户可以定义任意多条规则：完成条件 / 中途检查点 /
 *     难点提醒 / 人工介入时机 / 必须点击 / 固定数据。
 *   - 同一窗口内可维护无限多条人设（含国家），**字段级**勾选「固定」直接存在人设自己身上；
 *     人设不绑定环境 —— Agent 任务与轨迹回放都靠 `@人设名` 引用才生效（与规则同口径）。
 *     被勾选「固定」的字段是权威值，未勾选的必填项由 AI 随机生成。
 *
 * 存储：复用 Host 的 global_settings（get_settings / update_setting），JSON 字符串。
 * 环境人设（profiles.persona_data）已下线，用户人设改由这里承载。
 */
import { fetchRawSettingsStrict, updateSetting } from "./tauri";

export const AGENT_RULES_KEY = "agent_rules";
export const AGENT_PERSONAS_KEY = "agent_personas";
/**
 * INFO 残留：规则不再按环境预启用（只在 Agent 输入框 `@规则名` 引用时生效），
 * 因此该键**无写入方、无读取方**；保留常量只为标注 DB 里的历史键，不做迁移。
 */
export const AGENT_RULE_SELECTION_KEY = "agent_rule_selection";

/* ------------------------------------------------------------------ 规则 */

export type AgentRuleKind = "dom" | "vision" | "text";
/** 文本判据的扫描范围（与 sidecar 同口径）：整页（默认）或指定选择器子树内 */
export type AgentRuleMatchScope = "page" | "selector";

/**
 * 参考图 dataURL 上限（与 sidecar `MAX_IMAGE_CHARS` 同口径）。
 * 超过这个长度的图 sidecar 会丢弃 → 规则永远不可能命中；所以前端保存前就要拦住。
 */
export const MAX_IMAGE_CHARS = 1_400_000;

export type AgentRuleRole =
  | "complete"
  | "checkpoint"
  | "hint"
  | "hitl"
  | "must_click"
  | "fixed_data"
  | "flow";

/**
 * 「详细步骤」里的一步：该做什么 + 判据（选择器/文本/参考图）。
 *
 * 只有**带判据**的步骤才会驱动流程推进（机器核对命中才进下一步）；
 * 不带判据的步骤是纯指引，会跟在当前步骤一起交给 Agent，绝不靠 Agent 自述「做完了」。
 */
export interface AgentRuleStep {
  id: string;
  /** 步骤名（列表里显示，例如「打开注册页」） */
  title: string;
  /** 这一步该做什么（自然语言指令） */
  instruction: string;
  kind: AgentRuleKind;
  selector?: string;
  matchText?: string;
  /** 文本判据的扫描范围（默认整页；选 selector 时只在该选择器子树内找文本） */
  matchScope?: AgentRuleMatchScope;
  /** vision：判据参考图（dataURL，已压缩） */
  image?: string;
  visionNote?: string;
}

export interface AgentRule {
  id: string;
  /** 规则标题（列表展示 + 提示词小节名） */
  title: string;
  kind: AgentRuleKind;
  role: AgentRuleRole;
  /** dom：CSS 选择器（只看是否存在/可见，不执行用户 JS） */
  selector?: string;
  /** dom：页面文本包含匹配 */
  matchText?: string;
  /** dom：文本扫描范围（默认整页） */
  matchScope?: AgentRuleMatchScope;
  /** vision：参考图（dataURL，已压缩） */
  image?: string;
  /** vision：与参考图对照的说明 */
  visionNote?: string;
  /** text：自然语言正文（提醒 / 固定数据 / 人工介入说明） */
  text?: string;
  /** role=fixed_data：要钉死的输入框值（配合 selector 使用） */
  fixedValue?: string;
  /** role=flow：分步流程（有序） */
  steps?: AgentRuleStep[];
  /** complete / flow：命中即视为完成（AI 没说完成也收尾） */
  autoComplete?: boolean;
  /** complete / flow：AI 说完成时须硬校验，不通过不放行 */
  strict?: boolean;
  createdAt: number;
}

export const RULE_ROLE_OPTIONS: Array<{ value: AgentRuleRole; label: string; hint: string }> = [
  {
    value: "complete",
    label: "完成条件",
    hint: "机器核对命中即代表任务达成；可开「严格核对」（AI 说完成时必须核对通过）与「命中即完成」",
  },
  {
    value: "flow",
    label: "详细步骤",
    hint: "按顺序写多步（每步可配选择器/文本/参考图）；系统按判据机器核对、自动推进到当前步骤",
  },
  { value: "checkpoint", label: "中途检查点", hint: "命中只记进度，不会结束任务" },
  { value: "hint", label: "难点提醒", hint: "例如：这一步会出现滑块验证码 / 需人工短信码" },
  {
    value: "hitl",
    label: "人工介入时机",
    hint: "条件命中时会真的弹出人工确认（介入中心）；选「拒绝」会中止本次任务",
  },
  {
    value: "must_click",
    label: "必须点击",
    hint: "系统核对点击台账：这个元素没被真正点过就不许收尾（需填选择器或文本）",
  },
  {
    value: "fixed_data",
    label: "固定数据",
    hint: "钉死某个输入框的值：被改写就不许收尾（需填选择器 + 要固定的值）",
  },
];

export const RULE_KIND_OPTIONS: Array<{ value: AgentRuleKind; label: string; hint: string }> = [
  { value: "dom", label: "代码 / 选择器", hint: "CSS 选择器或页面文本；只做存在性校验，不执行脚本" },
  { value: "vision", label: "界面图片", hint: "上传目标界面截图，由视觉模型比对" },
  { value: "text", label: "自然语言", hint: "直接用文字描述" },
];

/* ------------------------------------------------------------------ 人设 */

export type AgentPersonaField =
  | "fullName"
  | "gender"
  | "birthday"
  | "email"
  | "phone"
  | "postalCode"
  | "street"
  | "city"
  | "region"
  | "country";

export interface AgentPersona {
  id: string;
  /** 条目名，便于在列表里识别（Agent 输入框用 `@条目名` 引用） */
  label: string;
  fullName: string;
  gender: string;
  birthday: string;
  email: string;
  phone: string;
  postalCode: string;
  street: string;
  city: string;
  region: string;
  country: string;
  /**
   * 勾选「固定」的字段：被 @引用 时是**权威值**，AI 不得改写。
   * 直接存在人设自己身上（不再按环境存一份 selection）。
   */
  fixedFields: AgentPersonaField[];
  /**
   * 用户是否**动手配置过**「固定」勾选。
   * false（从未配过）= 默认固定「已填写的字段」，让 @引用 的人设是确定身份；
   * true = 完全以 `fixedFields` 为准（允许用户明确「一个都不固定」）。
   */
  fixedFieldsConfigured: boolean;
  createdAt: number;
}

export const PERSONA_FIELD_OPTIONS: Array<{
  value: AgentPersonaField;
  label: string;
  placeholder?: string;
}> = [
  { value: "fullName", label: "姓名", placeholder: "与目标地区常见姓名一致" },
  { value: "gender", label: "性别" },
  { value: "birthday", label: "生日", placeholder: "yyyy/mm/dd" },
  { value: "email", label: "邮箱", placeholder: "name@example.com" },
  { value: "phone", label: "电话", placeholder: "+1 415…" },
  { value: "postalCode", label: "邮编" },
  { value: "street", label: "街道地址", placeholder: "与代理出口城市一致" },
  { value: "city", label: "城市" },
  { value: "region", label: "省/州" },
  { value: "country", label: "国家", placeholder: "如 United States / 美国" },
];

/**
 * INFO 残留：`agent_persona_selection`（profile → 人设 + 固定字段）已下线。
 *
 * 现在固定字段直接存在人设自己身上（`AgentPersona.fixedFields`），人设也不再有
 * 「指定给某个环境」的概念 —— Agent 任务与回放都靠 `@条目名` 引用。
 * 常量只用于**一次性迁移**（把旧的按环境固定字段并进人设，再把旧键清空）。
 */
export const AGENT_PERSONA_SELECTION_KEY = "agent_persona_selection";

type LegacySelectionMap<T> = Record<string, T>;

/* ----------------------------------------------------------- 读取 / 写入 */

async function readRawSettings(): Promise<Record<string, string>> {
  // rules/personas/selection 都是 fetchSettings() 不认识的键 → 必须取原始设置。
  // 用严格版：读取失败要**抛错**（上层据此禁止保存），不能静默当空库后把既有库覆盖掉。
  return fetchRawSettingsStrict();
}

function parseJsonArray<T>(raw: string | undefined): T[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(raw: string | undefined): LegacySelectionMap<T> {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as LegacySelectionMap<T>;
  } catch {
    return {};
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 重名不允许：返回一个不与 `existing` 冲突的名字。
 * 「新人设」→「新人设 (2)」→「新人设 (3)」…；空名兜底为「未命名」。
 */
export function makeUniqueName(desired: string, existing: string[]): string {
  const base = desired.trim() || "未命名";
  const taken = new Set(existing.map((item) => item.trim()).filter(Boolean));
  if (!taken.has(base)) {
    return base;
  }
  let index = 2;
  while (taken.has(`${base} (${index})`)) {
    index += 1;
  }
  return `${base} (${index})`;
}

export function createAgentRule(role: AgentRuleRole = "complete", existingTitles: string[] = []): AgentRule {
  const preset = RULE_ROLE_OPTIONS.find((item) => item.value === role);
  return {
    id: newId("rule"),
    // 重名不允许：连点「新增规则」时自动带序号，不会出现两条同名条目。
    title: makeUniqueName(preset?.label ?? "新规则", existingTitles),
    kind: "text",
    role,
    text: "",
    // role=flow：默认给一步空步骤，用户直接填「该做什么」即可。
    ...(role === "flow" ? { steps: [createAgentRuleStep([])] } : {}),
    // 新建默认是「自然语言」，无法被机器核对 —— 因此默认**不**勾严格校验/命中即完成，
    // 否则一条空规则就会把 done 永久堵死（见 sidecar core/task_rules.ts 的机器可核对判据）。
    autoComplete: false,
    strict: false,
    createdAt: Date.now(),
  };
}

/** 流程里的新步骤（默认「自然语言」= 纯指引；选了选择器/图片才成为推进判据） */
export function createAgentRuleStep(existingTitles: string[]): AgentRuleStep {
  return {
    id: newId("step"),
    title: makeUniqueName("新步骤", existingTitles),
    instruction: "",
    kind: "text",
  };
}

/** 步骤是否带「机器可核对」的判据（只有这类步骤会驱动流程推进） */
export function stepIsMachineCheckable(step: AgentRuleStep): boolean {
  return (
    (step.kind === "dom" && Boolean(step.selector?.trim() || step.matchText?.trim())) ||
    (step.kind === "vision" && Boolean(step.image))
  );
}

/** 规则整体是否可被机器核对（role=flow 看步骤里有没有判据） */
export function ruleIsMachineCheckable(
  rule: Pick<AgentRule, "kind" | "role" | "selector" | "matchText" | "image" | "steps">,
): boolean {
  if (rule.role === "flow") {
    return (rule.steps ?? []).some(stepIsMachineCheckable);
  }
  return (
    (rule.kind === "dom" && Boolean(rule.selector?.trim() || rule.matchText?.trim())) ||
    (rule.kind === "vision" && Boolean(rule.image))
  );
}

export function createAgentPersona(existingLabels: string[] = []): AgentPersona {
  return {
    id: newId("persona"),
    label: makeUniqueName("新人设", existingLabels),
    fullName: "",
    gender: "",
    birthday: "",
    email: "",
    phone: "",
    postalCode: "",
    street: "",
    city: "",
    region: "",
    country: "",
    fixedFields: [],
    fixedFieldsConfigured: false,
    createdAt: Date.now(),
  };
}

const MAX_STEPS_PER_RULE = 20;

/** 图片 dataURL 是否可用（前缀正确且不超 sidecar 上限） */
export function isUsableImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/") && value.length <= MAX_IMAGE_CHARS;
}

function normalizeRuleStep(raw: unknown, index: number): AgentRuleStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const str = (key: string): string => String(record[key] ?? "").trim();
  const kind = RULE_KIND_OPTIONS.some((item) => item.value === record.kind)
    ? (record.kind as AgentRuleKind)
    : "text";
  const step: AgentRuleStep = {
    id: str("id") || `step-${index}`,
    title: str("title") || `第 ${index + 1} 步`,
    instruction: str("instruction").slice(0, 1500),
    kind,
    selector: kind === "dom" ? str("selector").slice(0, 400) || undefined : undefined,
    matchText: kind === "dom" ? str("matchText").slice(0, 300) || undefined : undefined,
    matchScope: kind === "dom" && record.matchScope === "selector" ? "selector" : undefined,
    image: kind === "vision" && isUsableImageDataUrl(record.image) ? record.image : undefined,
    visionNote: kind === "vision" ? str("visionNote").slice(0, 1500) || undefined : undefined,
  };
  // 判据不完整（选了图片却没上传）→ 降级为纯指引；避免留一个永远无法命中的判据卡住推进。
  if (!stepIsMachineCheckable(step)) {
    return { id: step.id, title: step.title, instruction: step.instruction, kind: "text" };
  }
  return step;
}

function normalizeRule(raw: unknown): AgentRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = String(record.id ?? "").trim();
  if (!id) {
    return null;
  }
  const role = RULE_ROLE_OPTIONS.some((item) => item.value === record.role)
    ? (record.role as AgentRuleRole)
    : "hint";
  const kind = RULE_KIND_OPTIONS.some((item) => item.value === record.kind)
    ? (record.kind as AgentRuleKind)
    : "text";
  const str = (key: string): string | undefined => {
    const value = String(record[key] ?? "").trim();
    return value ? value : undefined;
  };
  const clip = (value: string | undefined, max: number): string | undefined =>
    value ? value.slice(0, max) : undefined;
  // C4：按 kind 丢弃无关判据（与 sidecar 同口径的硬上限），避免旧字段残留泄漏进提示词。
  // must_click / fixed_data 的定位判据按「选择器类」保留（它们的角色本身就要求选择器/文本）。
  const needsLocator = role === "must_click" || role === "fixed_data";
  const keepDom = kind === "dom" || needsLocator;
  const keepVision = kind === "vision";
  const selector = keepDom ? clip(str("selector"), 400) : undefined;
  const matchText = keepDom ? clip(str("matchText"), 300) : undefined;
  const matchScope =
    keepDom && record.matchScope === "selector" ? ("selector" as AgentRuleMatchScope) : undefined;
  const text = clip(str("text"), 1500);
  // A8：参考图超限即视为「没有图」，并在诊断里显式提示（不静默留下一条永不命中的规则）。
  const image = keepVision && isUsableImageDataUrl(record.image) ? record.image : undefined;
  const visionNote = keepVision ? clip(str("visionNote"), 1500) : undefined;
  const fixedValue = role === "fixed_data" ? clip(str("fixedValue"), 400) : undefined;
  const steps =
    role === "flow"
      ? (Array.isArray(record.steps) ? record.steps : [])
          .slice(0, MAX_STEPS_PER_RULE)
          .map((item, index) => normalizeRuleStep(item, index))
          .filter((step): step is AgentRuleStep => step != null)
      : undefined;
  // 只有「机器可核对」（DOM 有选择器/文本，或视觉有参考图）的完成条件才允许严格校验/命中即完成；
  // 历史脏数据里 text+strict 的组合会永久堵死 done，这里加载时就纠正掉。
  const checkable = ruleIsMachineCheckable({ kind, role, selector, matchText, image, steps });
  return {
    id,
    title: str("title") ?? "未命名规则",
    kind,
    role,
    selector,
    matchText,
    matchScope,
    // 参考图可能很长，不做 trim 截断（dataURL 必须完整），只判空
    image,
    visionNote,
    text,
    fixedValue,
    steps,
    autoComplete: record.autoComplete === true && checkable,
    strict: record.strict === true && checkable,
    createdAt: Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : Date.now(),
  };
}

function normalizePersona(raw: unknown): AgentPersona | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = String(record.id ?? "").trim();
  if (!id) {
    return null;
  }
  const str = (key: string): string => String(record[key] ?? "").trim();
  // 固定字段直接存人设自己；旧数据没有这个键 → 交给 loadAgentRuleLibrary 从 legacy selection 迁移。
  const fixedFields = Array.isArray(record.fixedFields)
    ? record.fixedFields
        .map((item) => String(item))
        .filter((item): item is AgentPersonaField =>
          PERSONA_FIELD_OPTIONS.some((option) => option.value === item),
        )
        .filter((item, index, list) => list.indexOf(item) === index)
    : null;
  return {
    id,
    label: str("label") || "未命名人设",
    fullName: str("fullName"),
    gender: str("gender"),
    birthday: str("birthday"),
    email: str("email"),
    phone: str("phone"),
    postalCode: str("postalCode"),
    street: str("street"),
    city: str("city"),
    region: str("region"),
    country: str("country"),
    fixedFields: fixedFields ?? [],
    // 旧数据只要带过 `fixedFields` 键就算「配过」；其余默认 false（走「已填字段默认固定」）。
    fixedFieldsConfigured:
      typeof record.fixedFieldsConfigured === "boolean"
        ? record.fixedFieldsConfigured
        : fixedFields != null,
    createdAt: Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : Date.now(),
  };
}

/**
 * 旧数据一次性迁移：把 `agent_persona_selection`（按环境记的固定字段）
 * 并进对应人设的 `fixedFields`（并集），并告知调用方把旧键清空。
 *
 * 只在人设**没有** `fixedFields` 键时迁移（尊重用户后来手动改的勾选，不覆盖）。
 */
function migrateLegacySelection(
  personas: AgentPersona[],
  rawPersonas: unknown[],
  legacy: LegacySelectionMap<{ personaId?: unknown; fields?: unknown }>,
): { personas: AgentPersona[]; migrated: boolean } {
  const hasExplicit = new Set<string>();
  for (const raw of rawPersonas) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    if (id && Array.isArray(record.fixedFields)) {
      hasExplicit.add(id);
    }
  }
  const merged = new Map<string, Set<AgentPersonaField>>();
  for (const value of Object.values(legacy)) {
    if (!value || typeof value !== "object") continue;
    const personaId = String(value.personaId ?? "").trim();
    if (!personaId || hasExplicit.has(personaId)) continue;
    const fields = Array.isArray(value.fields)
      ? value.fields
          .map((item) => String(item))
          .filter((item): item is AgentPersonaField =>
            PERSONA_FIELD_OPTIONS.some((option) => option.value === item),
          )
      : [];
    if (fields.length === 0) continue;
    const bucket = merged.get(personaId) ?? new Set<AgentPersonaField>();
    for (const field of fields) bucket.add(field);
    merged.set(personaId, bucket);
  }
  if (merged.size === 0) {
    return { personas, migrated: false };
  }
  return {
    migrated: true,
    personas: personas.map((persona) => {
      const bucket = merged.get(persona.id);
      if (!bucket || bucket.size === 0) return persona;
      return { ...persona, fixedFields: [...bucket], fixedFieldsConfigured: true };
    }),
  };
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export interface AgentRuleLibrary {
  rules: AgentRule[];
  personas: AgentPersona[];
  /**
   * 旧 `agent_persona_selection` 里还有可迁移的固定字段 → 调用方应把迁移后的人设与
   * 「清空后的旧键」落库一次（一次性迁移，之后恒为 false）。
   */
  legacySelectionMigrated: boolean;
}

/** 前端侧同源诊断：与 sidecar 的 diagnostics 口径一致，用于「先说后跑」的黄条提示 */
export type AgentRuleDiagnosticCode =
  | "rule_dropped"
  | "rule_duplicate"
  | "cap_truncated"
  | "image_rejected"
  | "flag_downgraded"
  | "step_cap_reached"
  | "persona_empty"
  | "condition_incomplete";

export interface AgentRuleDiagnostic {
  code: AgentRuleDiagnosticCode;
  ruleId?: string;
  message: string;
}

/** 与 sidecar MAX_TOTAL_STEPS 同口径：全部流程展开后可核对的步骤总数上限 */
export const MAX_TOTAL_FLOW_STEPS = 120;

/**
 * 体检规则库：任何「不会生效 / 已被降级 / 超限丢弃」都返回一条可读诊断。
 * 这是规则窗口黄条与保存前校验的共同数据源（同一条规则只报一次最关键的问题）。
 */
export function ruleDiagnostics(rules: AgentRule[]): AgentRuleDiagnostic[] {
  const out: AgentRuleDiagnostic[] = [];
  const seen = new Set<string>();
  let totalFlowSteps = 0;
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      out.push({
        code: "rule_duplicate",
        ruleId: rule.id,
        message: `规则「${rule.title}」的 id 重复，后面这条不会生效。`,
      });
      continue;
    }
    seen.add(rule.id);
    const checkable = ruleIsMachineCheckable(rule);
    if ((rule.autoComplete === true || rule.strict === true) && !checkable) {
      out.push({
        code: "flag_downgraded",
        ruleId: rule.id,
        message: `规则「${rule.title}」开了严格核对 / 命中即完成，但没有可核对的判据，不会拦住 done。`,
      });
    }
    if (rule.kind === "vision" && !rule.image) {
      out.push({
        code: "image_rejected",
        ruleId: rule.id,
        message: `规则「${rule.title}」选了界面图片，但没有可用参考图（或图片超过 ${Math.round(
          MAX_IMAGE_CHARS / 1000,
        )}KB），不会命中。`,
      });
    }
    if (rule.role === "fixed_data" && (!rule.selector || !rule.fixedValue)) {
      out.push({
        code: "condition_incomplete",
        ruleId: rule.id,
        message: `固定数据「${rule.title}」缺少${!rule.selector ? "选择器" : "要固定的值"}，不会生效。`,
      });
    }
    if (rule.role === "must_click" && !rule.selector && !rule.matchText) {
      out.push({
        code: "condition_incomplete",
        ruleId: rule.id,
        message: `必须点击「${rule.title}」没有填选择器或文本，无法核对是否点过，不会生效。`,
      });
    }
    if (rule.role === "flow") {
      const steps = rule.steps ?? [];
      if (steps.length > MAX_STEPS_PER_RULE) {
        out.push({
          code: "step_cap_reached",
          ruleId: rule.id,
          message: `流程「${rule.title}」超过 ${MAX_STEPS_PER_RULE} 步，超出的步骤不会生效。`,
        });
      }
      let truncated = false;
      for (const step of steps) {
        if (!stepIsMachineCheckable(step)) continue;
        if (totalFlowSteps >= MAX_TOTAL_FLOW_STEPS) {
          truncated = true;
          break;
        }
        totalFlowSteps += 1;
      }
      if (truncated) {
        out.push({
          code: "step_cap_reached",
          ruleId: rule.id,
          message: `全部流程的可核对步骤超过 ${MAX_TOTAL_FLOW_STEPS} 步上限，流程「${rule.title}」后面的步骤不会纳入核对。`,
        });
      }
    }
  }
  return out;
}

export async function loadAgentRuleLibrary(): Promise<AgentRuleLibrary> {
  const raw = await readRawSettings();
  // C6：读取去重（同一 id 只保留首条），避免历史脏数据在列表里出现两条。
  const rules = dedupeById(
    parseJsonArray<unknown>(raw[AGENT_RULES_KEY])
      .map(normalizeRule)
      .filter((item): item is AgentRule => item != null),
  );
  const rawPersonas = parseJsonArray<unknown>(raw[AGENT_PERSONAS_KEY]);
  const dedupedPersonas = dedupeById(
    rawPersonas
      .map(normalizePersona)
      .filter((item): item is AgentPersona => item != null),
  );
  // 一次性迁移：旧「按环境指定的人设 + 固定字段」并进人设自身；旧键由调用方清空。
  // `agent_rule_selection` 早已下线（规则只在输入框 @引用 时生效），这里不再读取。
  const legacySelection = parseJsonObject<{
    personaId?: unknown;
    fields?: unknown;
  }>(raw[AGENT_PERSONA_SELECTION_KEY]);
  const migrated = migrateLegacySelection(dedupedPersonas, rawPersonas, legacySelection);
  return {
    rules,
    personas: migrated.personas,
    legacySelectionMigrated: migrated.migrated,
  };
}

export async function saveAgentRules(rules: AgentRule[]): Promise<void> {
  await updateSetting(AGENT_RULES_KEY, JSON.stringify(rules));
}

export async function saveAgentPersonas(personas: AgentPersona[]): Promise<void> {
  await updateSetting(AGENT_PERSONAS_KEY, JSON.stringify(personas));
}

/** 迁移收尾：把已下线的旧键清空（此后 Host / 回放不再读到任何按环境指定的人设） */
export async function clearLegacyPersonaSelection(): Promise<void> {
  await updateSetting(AGENT_PERSONA_SELECTION_KEY, "{}");
}

/* --------------------------------------------------------------- 解析勾选 */

/** 人设里「非空且被勾选」的字段值 → 传给 sidecar 的权威固定值 */
export function personaFixedValues(
  persona: AgentPersona,
  fields: AgentPersonaField[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = String(persona[field] ?? "").trim();
    if (value) {
      out[field] = value;
    }
  }
  return out;
}

/** 传给 sidecar 的规则载荷（去掉纯 UI 字段，保持体积可控） */
export function rulesPayload(rules: AgentRule[]): Array<Record<string, unknown>> {
  return rules.map((rule) => ({
    id: rule.id,
    title: rule.title,
    kind: rule.kind,
    role: rule.role,
    selector: rule.selector ?? null,
    matchText: rule.matchText ?? null,
    matchScope: rule.matchScope ?? null,
    image: rule.image ?? null,
    visionNote: rule.visionNote ?? null,
    text: rule.text ?? null,
    fixedValue: rule.fixedValue ?? null,
    // role=flow：步骤顺序即数组顺序（sidecar 按顺序判定推进）
    steps:
      rule.role === "flow"
        ? (rule.steps ?? []).map((step) => ({
            id: step.id,
            title: step.title,
            instruction: step.instruction,
            kind: step.kind,
            selector: step.selector ?? null,
            matchText: step.matchText ?? null,
            matchScope: step.matchScope ?? null,
            image: step.image ?? null,
            visionNote: step.visionNote ?? null,
          }))
        : null,
    autoComplete: rule.autoComplete === true,
    strict: rule.strict === true,
  }));
}

/* ------------------------------------------------------- 人设 / @ 引用 */

/** 人设里已填了值的字段（用户没勾任何「固定」时的默认固定集，避免 AI 另造身份） */
export function filledPersonaFields(persona: AgentPersona): AgentPersonaField[] {
  return PERSONA_FIELD_OPTIONS.map((option) => option.value).filter((field) =>
    Boolean(String(persona[field] ?? "").trim()),
  );
}

/**
 * 传给任务/回放的「固定字段」：用户配过「固定」就用勾选集；从未配过则默认固定已填写的字段。
 * 目的：@引用 一套人设时它就是一个确定的身份，而不是又被 AI 另造一套。
 */
export function personaEffectiveFixedFields(persona: AgentPersona): AgentPersonaField[] {
  return persona.fixedFieldsConfigured ? persona.fixedFields : filledPersonaFields(persona);
}

/** 「@人设名」在文本里的引用载荷：label + 固定字段 + 字段值（Agent 与回放共用同一口径） */
export function personaPayload(persona: AgentPersona): {
  label: string;
  fields: AgentPersonaField[];
  fixed: Record<string, string>;
} {
  const fields = personaEffectiveFixedFields(persona);
  return {
    label: persona.label,
    fields,
    fixed: personaFixedValues(persona, fields),
  };
}

/**
 * 「@人设名」展开给回放 `{{persona.*}}` 的**整套字段**模板值（不受「固定字段」勾选限制）。
 * 与 Host 旧口径保持同名别名：`name` 与 `fullName` 同时给。
 */
export function personaTemplateValues(persona: AgentPersona): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    const text = String(value ?? "").trim();
    if (text) out[key] = text;
  };
  put("name", persona.fullName);
  put("fullName", persona.fullName);
  for (const field of [
    "gender",
    "birthday",
    "email",
    "phone",
    "postalCode",
    "street",
    "city",
    "region",
    "country",
  ] as AgentPersonaField[]) {
    put(field, persona[field]);
  }
  return out;
}

export interface GoalMentions {
  rules: AgentRule[];
  persona: AgentPersona | null;
  /** `@` 引用有歧义（同一位置命中多条）：已取最长，并在这里留痕给 UI 提示 */
  ambiguities: GoalMentionAmbiguity[];
}

export interface GoalMentionAmbiguity {
  /** 被引用的原文片段（取最长的那个） */
  mention: string;
  /** 该位置所有候选名称 */
  candidates: string[];
  /** 实际生效的名称 */
  picked: string[];
}

/** `@名称` 之后的字符必须是这些之一（空白 / 中英标点 / 行尾）才算引用命中 */
const MENTION_TAIL_BOUNDARY = /[\s，。、,.;；:：!！?？)）\]】}>》」』"'”’/\\|+*~`\-—_=#·]/;

function isMentionBoundary(char: string): boolean {
  return char === "" || MENTION_TAIL_BOUNDARY.test(char);
}

/**
 * 解析任务文本里的 `@名称` 引用（人设 / 规则条件）。
 *
 * 与旧实现的区别（C1）：
 *   - **词边界**：`@注册` 不再命中「注册成功」（`@注册成功` 后紧跟「成」，不是边界）；
 *   - **最长优先**：同一起点命中多条时取最长的名称，并记录歧义；
 *   - 只做字符串匹配，不执行任何用户输入。
 */
export function resolveGoalMentions(
  goal: string,
  rules: AgentRule[],
  personas: AgentPersona[],
): GoalMentions {
  const text = goal ?? "";
  if (!text.includes("@")) {
    return { rules: [], persona: null, ambiguities: [] };
  }
  type Candidate = { name: string; kind: "rule" | "persona" };
  const candidates: Candidate[] = [
    ...rules
      .filter((rule) => rule.title.trim())
      .map((rule) => ({ name: rule.title.trim(), kind: "rule" as const })),
    ...personas
      .filter((persona) => persona.label.trim())
      .map((persona) => ({ name: persona.label.trim(), kind: "persona" as const })),
  ].sort((a, b) => b.name.length - a.name.length);

  const matchedRules: AgentRule[] = [];
  const ambiguities: GoalMentionAmbiguity[] = [];
  let matchedPersona: AgentPersona | null = null;
  const assigned = new Set<string>();

  for (let pos = 0; pos < text.length; pos += 1) {
    if (text[pos] !== "@") continue;
    const rest = text.slice(pos + 1);
    const hits = candidates.filter(
      (candidate) => rest.startsWith(candidate.name) && isMentionBoundary(rest.charAt(candidate.name.length)),
    );
    if (hits.length === 0) continue;
    const longest = hits[0]!.name.length;
    const picked = hits.filter((candidate) => candidate.name.length === longest);
    if (new Set(hits.map((hit) => hit.name)).size > 1) {
      ambiguities.push({
        mention: `@${picked[0]!.name}`,
        candidates: [...new Set(hits.map((hit) => hit.name))],
        picked: picked.map((hit) => hit.name),
      });
    }
    for (const candidate of picked) {
      if (candidate.kind === "rule") {
        const rule = rules.find((item) => item.title.trim() === candidate.name);
        if (rule && !assigned.has(`rule:${rule.id}`)) {
          assigned.add(`rule:${rule.id}`);
          matchedRules.push(rule);
        }
      } else if (!matchedPersona) {
        const persona = personas.find((item) => item.label.trim() === candidate.name) ?? null;
        if (persona) matchedPersona = persona;
      }
    }
  }
  return { rules: matchedRules, persona: matchedPersona, ambiguities };
}
