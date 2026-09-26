import type { Page } from "playwright-core";
import { ActionResult, BrowserStateSummary, IndexedElementRef } from "./views.js";
import type { AgentFileSystem } from "./filesystem.js";
import type { JsonLogger } from "../json-logger.js";
import type { SidecarAiSettings } from "../engine.js";
import type { EvidenceLedger } from "../core/completion_evidence.js";
import type { ArtifactRecord } from "../core/deliverable_verify.js";
import type { DeliverableLedger } from "./task_contract.js";
import type { FailureLedger } from "../core/action_feedback.js";
import type { TaskPolicyState } from "../core/page_policy.js";
import { PLAN_TOOL_NAME } from "./plan_expects.js";

export const TERMINATES_SEQUENCE = new Set([
  "navigate",
  "go_back",
  "switch",
  "close",
  "evaluate",
  "done",
  "handover_to_human",
  "solve_captcha",
  "solve_animated_captcha",
  "solve_slider_captcha",
  "solve_math_captcha",
  "solve_point_select_captcha",
  "restart_browser",
  "ask_user",
  "fetch_email_otp",
  "fetch_sms_otp",
  "screenshot",
]);

export interface ActionContext {
  page: Page;
  logger: JsonLogger;
  aiSettings: SidecarAiSettings;
  browserState: BrowserStateSummary;
  fileSystem: AgentFileSystem;
  profileId?: string;
  goal: string;
  /** 本步序号（主循环注入）；单测直调 action 时可缺省。 */
  step?: number;
  /** 用户停止 Agent 时 abort；长耗时动作须轮询 */
  signal?: AbortSignal;
  requestConfirm: (args: {
    requestId: string;
    url: string;
    reason: string;
    actions: Array<{ kind: "fill" | "click"; id: string; text: string; value?: string }>;
    ai_copy?: import("../core/hitl_copy.js").HitlAiCopy;
  }) => Promise<{ approved: boolean; fillOverrides?: Record<string, string> }>;
  askUser: (
    requestId: string,
    question: string,
    meta?: { ai_copy?: import("../core/hitl_copy.js").HitlAiCopy; url?: string },
  ) => Promise<string>;
  requestHandover: (args: {
    requestId: string;
    reason: string;
    url: string;
    ai_copy?: import("../core/hitl_copy.js").HitlAiCopy;
  }) => Promise<void>;
  setIncludeScreenshotNext: (v: boolean) => void;
  /** 新标签 / 切标签后切换 Agent 活动页（网关 getter 同步） */
  setActivePage?: (page: Page) => void;
  /**
   * 取「绑定到指定标签页」的网关（跨标签读写用）。
   * 传当前活动页时等价于主网关；传别的页时返回一个**不跟随 active 页**的网关，
   * 于是动作能在目标标签上落地而不必先 switch（switch 会换掉观察作用域）。
   * 缺省（单测直调 action）时退回 `resolveGateway(page)`。
   */
  gatewayFor?: (page: Page) => import("../core/action_gateway.js").OmniActionGateway;
  /**
   * 向**宿主**请求动作（新建/删除环境）。
   *
   * 环境是宿主的资产（DB + 进程生命周期），Sidecar 无权直接改；这里只发意图，
   * 由宿主复用既有 db 逻辑执行并把结果回给 Sidecar。缺省（单测直调 / 老宿主）时
   * 动作必须**明确失败**，绝不假装成功（否则模型会继续往不存在的环境里操作）。
   */
  hostRequest?: (request: {
    kind: "create_environment" | "delete_environment";
    payload: Record<string, unknown>;
  }) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>;
  resolveElement: (index: number) => IndexedElementRef | null;
  /** 完成度证据台账：运行期共享，done 时用于验收（缺证据则驳回） */
  evidence?: EvidenceLedger;
  /**
   * 任务契约台账：目标要求交付哪些东西、各项核销到哪一步。
   * 缺省（老调用路径/单测直调 action）时 done 只走证据闸门，行为与改造前一致。
   */
  deliverables?: DeliverableLedger;
  /** 本任务已落盘的产物（下载/另存），download 类交付物的客观证据 */
  artifacts?: ArtifactRecord[];
  /** 失败台账：按「目标 × 失败因」累计，用于同一步内直接禁止重复撞墙 */
  failures?: FailureLedger;
  /**
   * 本任务的宪法政策状态（由 service 创建、随上下文下传）。
   * 缺省（单测直调 action）时视为「尚未在引擎搜索框输入过检索词」——保守判定，不影响既有行为。
   */
  taskPolicy?: TaskPolicyState;
  /**
   * 视觉重定位预算（每步重置）。index 失效时用它换一次「靠视觉找回目标」的机会，
   * 用尽即回到普通失败路径 —— 预算的意义是「救一次」，不是「无限重试」。
   */
  relocationBudget?: { left: number };
  /** 最近一次给模型的截图是否发生在「最近一次状态变更动作」之后（用于「看过了」的弱证据） */
  screenshotAfterMutation?: () => boolean;
  /**
   * 本步页面事实（由 service 每步算一次后下传）。
   * `serpForQuery` = 当前页就是本任务检索词的搜索引擎结果页 —— done 闸门核销
   * submitted 类交付物时用它做**最直接**的判据（不需要任何 URL 差分推演）。
   * 缺省（单测直调 action）视为 false，不影响既有行为。
   */
  pageFacts?: { serpForQuery: boolean };
  /**
   * P1.2：邮箱 OTP 通道绑定（Host 注入；密钥只以 ref 出现）。
   * 缺省 = 未配置 → fetch_email_otp 走 Layer 3 HITL。
   */
  otpChannel?: unknown;
  /** P1.2：按 secretRef / apiKeyRef 解析明文（Host 会话注入；禁止落盘） */
  resolveOtpSecret?: (ref: string) => Promise<string | null> | string | null;
  /** P1.2：测试注入邮件传输（生产勿设） */
  otpMailTransport?: import("../otp/types.js").MailTransport;
  /** P5.3：短信接码服务（Host 注入；enabled 默认关） */
  smsOtpService?: unknown;
  /** P5.3：按 apiKeyRef 解析明文（会话内存；禁止落盘） */
  resolveSmsOtpSecret?: (ref: string) => Promise<string | null> | string | null;
  /** P5.1：第三方 captcha_service（Host 注入；enabled 默认关） */
  captchaService?: unknown;
  /** P5.1：按 apiKeyRef 解析明文（会话内存；禁止落盘） */
  resolveCaptchaSecret?: (ref: string) => Promise<string | null> | string | null;
  /**
   * 用户自定义规则运行态（前端「规则」窗口 → Host → Sidecar）。
   * 缺省 = 用户没配规则 → done 闸门与主循环巡检都跳过，行为与改造前一致。
   */
  taskRules?: import("../core/task_rules.js").TaskRulesRuntime | null;
}

export type ActionHandler = (
  params: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<ActionResult>;

const handlers = new Map<string, ActionHandler>();

export function registerAction(name: string, handler: ActionHandler): void {
  handlers.set(name, handler);
}

export function getActionHandler(name: string): ActionHandler | undefined {
  return handlers.get(name);
}

export function listRegisteredActions(): string[] {
  return [...handlers.keys()].sort();
}

/**
 * 宪法封禁动作：**保留 handler**（模型万一手滑发出时能给出精确的 `policy-violation` 指引，
 * 而不是含糊的「未知动作」），但**不进工具清单** —— 模型看不见它，也就不会去用。
 * 详见 core/page_policy.ts 与《搜索宪法》。
 */
export const POLICY_BLOCKED_ACTIONS = new Set(["search"]);

/** 暴露给模型的工具清单（封禁动作已剔除） */
export function listExposedActions(): string[] {
  return listRegisteredActions().filter((name) => !POLICY_BLOCKED_ACTIONS.has(name));
}

export function assertRequiredActions(): void {
  const required = [
    "navigate",
    "click",
    "input",
    "scroll",
    "wait",
    "done",
    "extract",
    "search_page",
    "find_elements",
    "scrape_page_data",
    "page_summary",
    "ask_user",
    "handover_to_human",
    "ask_vision_locate",
    "click_viewport",
    "list_skills",
    "recall_skill",
    "detect_page_blockers",
    "solve_captcha",
    "solve_animated_captcha",
    "solve_slider_captcha",
    "solve_math_captcha",
    "solve_point_select_captcha",
    "fetch_email_otp",
    "fetch_sms_otp",
    "restart_browser",
    // 环境管理：宿主可能不支持（缺省时如实失败），但 handler 必须存在
    "create_environment",
    "delete_environment",
    // 计划修正工具：不改浏览器，只改"账本"（由 service 在执行前拦截，写入 output.plan_update）
    PLAN_TOOL_NAME,
  ];
  const missing = required.filter((n) => !handlers.has(n));
  if (missing.length) {
    throw new Error(`BU Agent 缺少必选动作: ${missing.join(", ")}`);
  }
}
