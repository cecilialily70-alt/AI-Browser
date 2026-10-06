/**
 * browser-use 对齐的 Agent 视图类型（天枢台 TypeScript 移植）
 */
import type { AgentElementAffinity } from "../interactive_elements.js";
import type { PlanExpects } from "./plan_expects.js";
import type { TabInfo } from "./browser_state.js";

export type VisionMode = boolean | "auto";

export interface AgentSettings {
  useVision: VisionMode;
  maxFailures: number;
  maxActionsPerStep: number;
  useThinking: boolean;
  flashMode: boolean;
  useJudge: boolean;
  maxHistoryItems: number | null;
  enablePlanning: boolean;
  planningReplanOnStall: number;
  planningExplorationLimit: number;
  loopDetectionEnabled: boolean;
  loopDetectionWindow: number;
  maxClickableElementsLength: number;
  stepTimeoutMs: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  useVision: "auto",
  maxFailures: 5,
  maxActionsPerStep: 5,
  useThinking: true,
  flashMode: false,
  useJudge: true,
  maxHistoryItems: null,
  enablePlanning: true,
  planningReplanOnStall: 3,
  planningExplorationLimit: 5,
  loopDetectionEnabled: true,
  loopDetectionWindow: 20,
  maxClickableElementsLength: 40000,
  stepTimeoutMs: 180_000,
};

export type PlanItemStatus = "pending" | "current" | "done" | "skipped";

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
  /**
   * 该项的期望（世界模型的最小形态，Phase 3.2 起随计划一起落账）。
   *
   * ⚠️ 3.2 只负责**把期望存进账里**，尚不参与任何裁决（3.3 才由 Arbiter 消费）。
   * 缺失是常态（模型没写 / 继承校验判定不可继承），下游必须容忍 undefined。
   */
  expects?: PlanExpects;
}

/**
 * `plan_update` 的结构化单项。
 *
 * 双形态兼容是刻意的：既有提示词让模型输出**字符串数组**，但模型时常自发升级成
 * `[{text, expects}]`。老解析器用 `filter(typeof x === "string")` 会把对象形态**静默吃掉**
 * —— 不报错、不告警，计划直接消失。所以这里在类型层就声明两种形态都合法，
 * 由 `coercePlanSteps` 统一收敛（见 `plan_expects.ts`）。
 */
export interface PlanStep {
  text: string;
  expects?: PlanExpects;
}

export interface AgentAction {
  name: string;
  params: Record<string, unknown>;
}

export interface AgentOutput {
  thinking?: string;
  evaluation_previous_goal?: string;
  memory?: string;
  next_goal?: string;
  current_plan_item?: number | null;
  /** 双形态：字符串（旧）或 `{text, expects}`（新）。解析一律走 `coercePlanSteps`。 */
  plan_update?: Array<string | PlanStep> | null;
  action: AgentAction[];
}

export interface ActionResult {
  isDone?: boolean;
  success?: boolean | null;
  error?: string | null;
  extractedContent?: string | null;
  longTermMemory?: string | null;
  includeExtractedContentOnlyOnce?: boolean;
  metadata?: Record<string, unknown>;
}

export interface HistoryItem {
  stepNumber: number;
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
  actionResults: ActionResult[];
  actions: AgentAction[];
}

export interface JudgementResult {
  verdict: boolean;
  reasoning: string;
  failureReason?: string | null;
  impossibleTask?: boolean;
  reachedCaptcha?: boolean;
}

export interface PageFingerprint {
  url: string;
  elementCount: number;
  textHash: string;
}

export interface BrowserStateSummary {
  url: string;
  title: string;
  tabs: TabInfo[];
  interactiveTree: string;
  elementCount: number;
  selectorMap: Map<number, IndexedElementRef>;
  /** 兼容单图；优先用 screenshotList */
  screenshotBase64?: string | null;
  /** 多帧视口截图（data-url 或 raw base64），detail=low */
  screenshotList?: string[];
  pageInfo?: { pagesAbove: number; pagesBelow: number };
  /** 观察软错误占位 */
  observationError?: string | null;
  /** 观察质量（自愈尝试次数 / 是否降级 / 控件数），供模型判断能否用 index 动作 */
  observationQuality?: {
    ok: boolean;
    degraded: boolean;
    attempts: number;
    elementCount: number;
    mode: "full" | "degraded-text" | "failed";
    reason: string | null;
  } | null;
  /**
   * 确定性页面阅读摘要（SERP/正文脚本抽取，零二次 LLM）。
   * 用于「分析/总结/自然语言理解」验收，避免只靠交互索引瞎猜。
   */
  pageDigest?: string | null;
  /**
   * SoM 编号标记账本：截图上的红色编号与交互元素 index 同源。
   * marked=0 表示本轮截图没有标记（模型不得凭图猜号）。
   */
  somMarks?: {
    marked: number;
    candidates: number;
    reason: string | null;
  } | null;
  /**
   * Phase 4.1a：无障碍树的结构化角色视图（只读透传）。
   *
   * **不参与提示词渲染、不参与编号**：交互元素编号永远只有 index 空间这一个来源。
   * 它只是把「无障碍树认为页面有哪些控件」这一客观事实交给决策层（页面分类、控件核对），
   * 免得下游又去写一套 DOM 正则猜页面类型。
   */
  a11yRoles?: {
    roles: Array<{ role: string; name: string }>;
    roleCounts: Record<string, number>;
    interactiveCount: number;
    indexSpace: number;
  } | null;
  /**
   * 观察期间页面被关闭（第三方授权弹窗自己关掉 / 用户关标签页）。
   * 上层据此切换到存活页面并重新观察，而不是把这个窗口的失效当成任务失败。
   */
  pageClosed?: boolean;
}

export interface IndexedElementRef {
  index: number;
  shortId: string;
  selector: string;
  xpath: string;
  tagName: string;
  inputType: string | null;
  text: string;
  role?: string;
  placeholder?: string;
  name?: string;
  /** 勾选类控件状态（复选框/单选框/开关）；null = 非勾选类或读不到 */
  checked?: boolean | null;
  /** 主文档视口坐标（框架元素的坐标已在观察层换算）；null = 无可信坐标 */
  rect?: { x: number; y: number; w: number; h: number } | null;
  /** 所属嵌套框架 URL；主文档为 null。执行层据此回到那个文档里定位元素 */
  frameUrl?: string | null;
  /** 同行归属裁决结论（观察层写入）；用于点击后给出正确指引，不改变用户选择 */
  affinity?: AgentElementAffinity;
  /**
   * 一次性凭证字段的判定依据（邮箱/短信/验证器动态码）。
   * 非空即代表：值只可能在用户本人手上 —— 执行层与完成度闸门据此强制走人工路径。
   */
  humanOnly?: string | null;
  /** 字段当前是否已有内容（只报有无） */
  filled?: boolean | null;
  /**
   * Milestone 5 / P4.1：自愈指纹（仅 Node 内存，不进 LLM JSON）。
   * stale 时按指纹静默重查；缺失则跳过指纹自愈，走 vision_relocate / 明确失败。
   */
  fingerprint?: import("../element_heal.js").ElementFingerprint;
}
