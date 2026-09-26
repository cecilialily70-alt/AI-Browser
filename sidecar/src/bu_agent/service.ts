/**
 * browser-use 风格自主 Agent 主循环（天枢台实现）
 * 仅 CDP 附着已启动 CloakBrowser；不改环境配置。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import {
  agentForcedToolRequestPatch,
  beginAgentLlmWait,
  createLlmClient,
  extractAssistantContent,
} from "../ai_client.js";
import {
  createModelRouter,
  isIntentConfigured,
} from "../ai_model_router.js";
import { withLlmRetry } from "../llm_retry.js";
import { OmniActionGateway, runWithGateway, type OmniActionGatewayOptions } from "../core/action_gateway.js";
import {
  buildGeoPersonaContextBlock,
  parseGeoContext,
} from "../persona_engine.js";
import {
  emitInteractiveExtractDebug,
  snapshotInteractiveElements,
} from "../interactive_elements.js";
import {
  assertObservationReady,
  buildObservationNudges,
  disposeObservation,
  materializeShotDataUrls,
  PAGE_PIPELINE_CONFIG,
  prepareObservationResilient,
  type ObservationPack,
  type ObservationQuality,
} from "../page_pipeline/index.js";
import type { JsonLogger } from "../json-logger.js";
import type { SidecarAiSettings } from "../engine.js";
import { findIndexByTextHint } from "./captcha_form_hints.js";
import {
  assertPersistableTrajectorySteps,
  buildTrajectoryPayload,
  domainFromUrl,
  persistTrajectoryToDisk,
  type TrajectoryStep,
} from "../trajectory.js";
import {
  AGENT_RUN_SUMMARY_MAX,
  appendThoughtLine,
  buildAgentRunFinishPayload,
  buildAgentRunStartPayload,
  createAgentRunId,
  type AgentRunThoughtLine,
} from "./agent_run_history.js";
import { createRunCostMeter, withRunCostScope, type RunCostMeter } from "./run_cost.js";
import { ensureActionsRegistered } from "./actions.js";
import { assertRequiredActions } from "./registry.js";
import {
  blocksRuleAutoComplete,
  createEvidenceLedger,
  loadCompletionLexicon,
  markNavigationReached,
  recordStepEvidence,
} from "../core/completion_evidence.js";
import { findPendingHumanCredentials } from "../core/human_credential.js";
import {
  attachmentImageParts,
  attachmentTextBlock,
  buildAttachmentsBrief,
  buildTaskRulesBrief,
  createTaskRulesRuntime,
  evaluateTaskRules,
  guardUserConstraints,
  shouldFireTaskRuleHitl,
  type TaskRule,
  type TaskRuleConstraintViolation,
} from "../core/task_rules.js";
import { goalRequestsSearch } from "../core/task_intent.js";
import { describeNewTabIntent, detectNewTabIntent } from "../core/new_tab_intent.js";
import { firstReachedTarget } from "../core/url_match.js";
import { createFailureLedger, failureTargetKey } from "../core/action_feedback.js";
import { createTaskPolicyState } from "../core/page_policy.js";
import { detectCaptchaGate } from "./captcha_strategy.js";
import { VISION_RELOCATE_MAX_PER_STEP } from "./actions.js";
import {
  buildBrowserStateWithShortIdDiff,
  countLivePages,
  describeOpenedTabs,
  listTabs,
  type TabInfo,
} from "./browser_state.js";
import { buildOpenTabsPayload } from "./open_tabs_report.js";
import { AgentFileSystem } from "./filesystem.js";
import { decideCompletionAsk, judgeTaskComplete, judgeTrace, shouldSkipJudge } from "./judge.js";
import { MessageManager } from "./message_manager.js";
import { multiAct } from "./multi_act.js";
import {
  agentOutputFromToolCalls,
  agentOutputJsonSchema,
  buildUserStateMessage,
  extractJsonObject,
  loadSystemPrompt,
  normalizeAgentOutput,
} from "./prompts.js";
import { analyzeTask, planItemNeedsObservation } from "./task_analyze.js";
import {
  formatMacroTodoMarkdown,
  projectMacroPlanTitles,
  type MacroPlan,
} from "./macro_analyze.js";
import {
  createDeliverableLedger,
  formatDeliverableLines,
  listDeliverables,
  listPendingDeliverables,
  markDeliverableSatisfied,
  type DeliverableLedger,
} from "./task_contract.js";
import { verifyDeliverables } from "../core/deliverable_verify.js";
import type { ArtifactRecord } from "../core/deliverable_verify.js";
import type { EvidenceLedger } from "../core/completion_evidence.js";
import { attachArtifactTracker } from "../core/artifact_tracker.js";
import {
  absorbPlanDeliverables,
  countProgressFacts,
  createReplanTracker,
  loadReplanBudget,
  markReplanUsed,
  observeStepForReplan,
  requestReplan,
} from "./replan.js";
import {
  goalHasFollowupDeliverable,
  queryMatchedOnPage,
  tryDeterministicDone,
  tryDeterministicEngineHome,
  tryDeterministicNavigationDone,
} from "./deterministic.js";
import { classifyPageKind } from "../core/page_kind.js";
import { elementsFromSelectorMap, resolveHitlAiCopy } from "../core/hitl_copy_resolve.js";
import { getCaptchaAttempts } from "./animated_captcha.js";
import { a11yLabelsFrom, checkExpects, decideExpectsSoftGate, scanPlanCommands } from "./plan_expects.js";
import { arbitrate, NUDGE_LAST_STEP } from "./arbiter.js";
import {
  arbiterConsultFailedHitlNudge,
  arbiterEscalateHitlNudge,
  isArbiterAuthoritative,
  loadArbiterPolicy,
} from "./arbiter_policy.js";
import {
  consultBudgetReady,
  consultClearNudge,
  consultPlanConflict,
  consultRevisionNudge,
  createRunConsultBudget,
} from "./consult_escalate.js";
import { loadExpectsSoftGatePolicy } from "./expects_soft_gate_policy.js";
import {
  extractPageReading,
  formatPageReadingForLlm,
} from "../page_read.js";
import { buildSkillMatchNudges, ensureSkillsLoaded } from "./skills/index.js";
import { buildRegistryOpenAiTools } from "./tool_schemas.js";
import {
  DEFAULT_AGENT_SETTINGS,
  type AgentOutput,
  type AgentSettings,
  type BrowserStateSummary,
} from "./views.js";

export interface AgentConfirmActionPreview {
  kind: "fill" | "click";
  id: string;
  text: string;
  value?: string;
  selectorHint?: string;
}

export interface AgentConfirmRequest {
  requestId: string;
  url: string;
  reason?: string;
  actions: AgentConfirmActionPreview[];
  /** P1.4：AI 情境文案（模板兜底保证非空） */
  ai_copy?: import("../core/hitl_copy.js").HitlAiCopy;
}

export interface AgentConfirmResponse {
  approved: boolean;
  fillOverrides?: Record<string, string>;
}

export interface AgentHandoverRequest {
  requestId: string;
  url: string;
  reason: string;
  /** P1.4：AI 情境文案 */
  ai_copy?: import("../core/hitl_copy.js").HitlAiCopy;
}

export interface AgentLoopDeps {
  logger: JsonLogger;
  aiSettings: SidecarAiSettings;
  goal: string;
  maxRounds?: number;
  senseMode?: string;
  profileId?: string;
  /** 环境 userDataDir：用于落盘 agent llm_json 供测试窗读取 */
  userDataDir?: string | null;
  /** UI 开关：Agent 全景多帧截图 */
  panoramaEnabled?: boolean;
  enableRecording?: boolean;
  controlMemorySeed?: unknown[];
  geoContext?: unknown;
  /** P1.2：邮箱 OTP 通道绑定（Host 注入） */
  otpChannel?: unknown;
  /** P1.2：按 secretRef 解析明文（会话内存；禁止落盘） */
  resolveOtpSecret?: (ref: string) => Promise<string | null> | string | null;
  /** P1.2：测试注入邮件传输 */
  otpMailTransport?: import("../otp/types.js").MailTransport;
  /** P5.3：短信接码服务（Host 注入；enabled 默认关） */
  smsOtpService?: unknown;
  /** P5.3：按 apiKeyRef 解析明文（会话内存；禁止落盘） */
  resolveSmsOtpSecret?: (ref: string) => Promise<string | null> | string | null;
  /** P5.1：第三方 captcha_service（Host 注入） */
  captchaService?: unknown;
  /** P5.1：按 apiKeyRef 解析明文（会话内存；禁止落盘） */
  resolveCaptchaSecret?: (ref: string) => Promise<string | null> | string | null;
  /**
   * 用户自定义规则（「规则」窗口）：完成条件 / 检查点 / 提醒 / 人工介入 / 必须点击 / 固定数据。
   * 缺省 = 用户没配规则，行为与改造前完全一致。
   */
  taskRules?: unknown;
  /** 本环境启用的人设（固定字段为权威值；未固定字段由 AI 现生成） */
  taskPersona?: unknown;
  /** Agent 输入框附件（图片→vision、文本→摘要；禁止当 OTP 取码依据） */
  attachments?: unknown;
  requestConfirm: (request: AgentConfirmRequest) => Promise<AgentConfirmResponse>;
  askUser: (
    requestId: string,
    question: string,
    meta?: { ai_copy?: import("../core/hitl_copy.js").HitlAiCopy; url?: string },
  ) => Promise<string>;
  requestHandover: (request: AgentHandoverRequest) => Promise<void>;
  /**
   * P4.5：用户暂停闸门（复用 task_pause_lock）。
   * 返回 true 表示刚恢复 —— 调用方须跳过 multi_act 并强制观察步。
   */
  awaitUserPauseGate?: () => Promise<boolean>;
  /**
   * 向宿主请求动作（新建/删除环境）。缺省 = 宿主不支持，对应工具会如实失败。
   * 配额（每次任务最多建 3 删 2）夹在本文件里，避免模型失败重试刷爆用户环境列表。
   */
  requestHostRequest?: (request: {
    kind: "create_environment" | "delete_environment";
    payload: Record<string, unknown>;
  }) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  rounds: number;
  trajectory?: TrajectoryStep[];
  domain?: string;
  startUrl?: string;
}

/** P4.2：HITL 事件复用观察截图（过大则跳过，避免撑爆 stdout） */
function pickHitlScreenshot(
  state?: Pick<BrowserStateSummary, "screenshotBase64" | "screenshotList"> | null,
): string | undefined {
  const raw =
    (typeof state?.screenshotBase64 === "string" && state.screenshotBase64.trim()) ||
    (typeof state?.screenshotList?.[0] === "string" && state.screenshotList[0].trim()) ||
    "";
  if (!raw || raw.length > 180_000) {
    return undefined;
  }
  return raw;
}

export async function runBuAutonomousAgentLoop(
  page: Page,
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
  const meter = createRunCostMeter();
  return withRunCostScope(meter, () => runBuAutonomousAgentLoopInner(page, deps, meter));
}

async function runBuAutonomousAgentLoopInner(
  page: Page,
  deps: AgentLoopDeps,
  runCost: RunCostMeter,
): Promise<AgentLoopResult> {
  ensureActionsRegistered();
  assertRequiredActions();
  ensureSkillsLoaded();

  let settings: AgentSettings = {
    ...DEFAULT_AGENT_SETTINGS,
    maxActionsPerStep: 5,
    useVision: "auto",
    useThinking: true,
    flashMode: false,
    useJudge: true,
  };

  const maxSteps = Math.max(1, Math.min(400, deps.maxRounds ?? 200));
  /**
   * 用户自定义规则运行态（命中记录 / 命中即完成 / 视觉预算）。
   * 归一化在这里做一次：后续主循环巡检与 done 闸门共用同一份运行态。
   */
  const taskRules = createTaskRulesRuntime({
    taskRules: deps.taskRules,
    taskPersona: deps.taskPersona,
    attachments: deps.attachments,
  });
  if (taskRules) {
    // C9：只统计**用户真正写的**规则（flow 派生出的步骤规则不算「用户规则条数」）。
    const userRules = taskRules.rules.filter((rule) => !rule.flowStep);
    deps.logger.agentProgress(
      `已载入用户规则 ${userRules.length} 条` +
        `${taskRules.flows.length > 0 ? ` · 详细步骤 ${taskRules.flows.length} 套` : ""}` +
        `${taskRules.persona ? " · 指定人设" : ""}` +
        `${taskRules.attachments.length > 0 ? ` · 附件 ${taskRules.attachments.length} 个` : ""}`,
      {
        phase: "task_rules_loaded",
        rules: userRules.map((rule) => `${rule.role}:${rule.kind}:${rule.title}`),
        flows: taskRules.flows.map(
          (flow) => `${flow.rule.title}(${flow.stepRuleIds.length}/${flow.steps.length} 步可判定)`,
        ),
        fixedFields: taskRules.persona ? Object.keys(taskRules.persona.fixed) : [],
        diagnostics: taskRules.diagnostics.length,
      },
    );
    // A5：任何静默降级/丢弃/截断都在这里显式落日志，不装没事。
    if (taskRules.diagnostics.length > 0) {
      deps.logger.agentProgress(
        `用户规则有 ${taskRules.diagnostics.length} 条配置提示：${taskRules.diagnostics
          .map((item) => item.message)
          .join("；")
          .slice(0, 400)}`,
        { phase: "task_rules_diagnostics", diagnostics: taskRules.diagnostics },
      );
    }
  }
  /**
   * 宿主请求（新建/删除环境）的**每次任务配额**。
   *
   * 为什么要在主循环这里夹一道：环境是用户的长期资产，模型在失败重试时很容易
   * 反复「新建环境试试」「删掉再来」；配额是防抖保险丝，用尽即如实失败，
   * 让模型转人工/换策略，而不是静默刷屏（§1.5 步数保险丝同源思路）。
   */
  const MAX_ENVIRONMENT_CREATES = 3;
  const MAX_ENVIRONMENT_DELETES = 2;
  let environmentCreates = 0;
  let environmentDeletes = 0;
  const requestHost = deps.requestHostRequest;
  const hostRequest: import("./registry.js").ActionContext["hostRequest"] = requestHost
    ? async (request) => {
        if (request.kind === "create_environment") {
          if (environmentCreates >= MAX_ENVIRONMENT_CREATES) {
            return {
              ok: false,
              error: `本次任务最多新建 ${MAX_ENVIRONMENT_CREATES} 个环境（已用 ${environmentCreates} 个），请复用现有环境或让用户手动新建`,
            };
          }
          const result = await requestHost(request);
          if (result.ok) environmentCreates += 1;
          return result;
        }
        if (request.kind === "delete_environment") {
          if (environmentDeletes >= MAX_ENVIRONMENT_DELETES) {
            return {
              ok: false,
              error: `本次任务最多删除 ${MAX_ENVIRONMENT_DELETES} 个环境（已用 ${environmentDeletes} 个）`,
            };
          }
          const result = await requestHost(request);
          if (result.ok) environmentDeletes += 1;
          return result;
        }
        return { ok: false, error: `不支持的宿主请求：${request.kind}` };
      }
    : undefined;

  /**
   * 规则 brief **每步重算**：`<user_flow>` 小节里的「当前步骤」由机器核对结果决定，
   * 命中一步就自然推进到下一步；若只算一次，模型会一直停在第 1 步的指引上。
   */
  const buildTaskBriefForStep = (): string =>
    taskRules
      ? [buildTaskRulesBrief(taskRules), buildAttachmentsBrief(taskRules)].filter(Boolean).join("\n")
      : "";
  const taskAttachmentImages = attachmentImageParts(taskRules).map((part) => part.image_url.url);
  const taskAttachmentText = attachmentTextBlock(taskRules);
  /**
   * 附件图只在前若干步随消息投递：图片是 dataURL，每步重复塞进 messages 会让 token/延迟
   * 随步数线性放大（最坏每步 ~12MB）。前几步足够模型建立参照，之后靠 history 文本延续。
   */
  const ATTACHMENT_IMAGE_STEPS = 3;
  const startUrl = page.url();
  const profileId = deps.profileId || "default";
  const fsRoot = join(homedir(), ".ai-browser");
  const fileSystem = new AgentFileSystem(fsRoot, profileId);
  const messageManager = new MessageManager(settings);
  const enableRecording = deps.enableRecording === true;
  /** 勾选「录制执行轨迹」时由网关收集；成功后落库 + 推送轨迹记忆 */
  const recordedSteps: Omit<TrajectoryStep, "step">[] = [];
  /** P4.3：与录制解耦的 Run History（起止强制落摘要） */
  const agentRunId = createAgentRunId();
  const thoughtLines: AgentRunThoughtLine[] = [];
  let hitlOccurred = false;
  let savedTrajectoryId: number | null = null;
  const markHitl = (): void => {
    hitlOccurred = true;
  };
  const noteThought = (message: string): void => {
    appendThoughtLine(thoughtLines, message);
  };
  /** 必须用 getter：new_tab / switch 后跟活动页，禁止钉死初始 page */
  let activePage = page;
  const gatewayOptions: OmniActionGatewayOptions = {
    logger: deps.logger,
    record: enableRecording
      ? (snapshot) => {
          recordedSteps.push(snapshot);
        }
      : undefined,
  };
  const gateway = new OmniActionGateway(() => activePage, gatewayOptions);

  /**
   * 按标签定向执行的网关：给「在**别的**标签上读写」的动作（read_tab / fill_from_tab）用。
   * 与主网关共享同一 recorder / logger，但**绑定具体 Page**、不跟随 active 页 ——
   * 这样「取标签1的数据填到标签3」不需要先 switch（switch 会换掉观察作用域）。
   */
  const pageScopedGateways = new Map<Page, OmniActionGateway>();
  const gatewayForPage = (target: Page): OmniActionGateway => {
    if (target === activePage) {
      return gateway;
    }
    const cached = pageScopedGateways.get(target);
    if (cached) {
      return cached;
    }
    const created = new OmniActionGateway(target, gatewayOptions);
    pageScopedGateways.set(target, created);
    return created;
  };

  let includeScreenshotNext = false;
  let previousObservation: ObservationPack | null = null;
  const panoramaEnabled = deps.panoramaEnabled === true;
  if (panoramaEnabled) {
    settings = { ...settings, useVision: true };
    includeScreenshotNext = true;
  }
  let previousShortIds: Set<string> | null = null;
  let previousUrl: string | null = null;
  let browserState: BrowserStateSummary | null = null;
  let doneSummary = "";
  let doneSuccess = false;
  let finished = false;
  /** 完成度证据台账：done 验收的客观依据（缺证据则驳回 done，让模型继续） */
  const evidenceLedger = await createEvidenceLedger(activePage);
  /** 失败台账：按「目标 × 失败因」累计，撞墙后在同一步直接禁止重复 */
  const failureLedger = createFailureLedger();
  /** 宪法政策状态（跨步共享）：本任务是否已在引擎首页搜索框输入过检索词 */
  const taskPolicy = createTaskPolicyState();
  /** 最近一次「观测里含截图」的步号：用于判断模型是否在最近一次状态变更之后真的看过结果 */
  let lastVisionObservationStep = -1;
  /** 上一步新开标签页的提示（下一步随 nudge 注入后即清除，不长期刷屏） */
  let popupNudges: string[] = [];
  /**
   * Arbiter 裁决累计（P0.1：可权威；shadow 档仍只记日志）。
   *
   * `wouldHalt/wouldEscalate` 说明**会改变行为**的步数（权威模式下实际已改变）。
   * `understandingDisagreements` 说明 P0 意图与既有正则分歧多少。
   */
  const arbiterShadow = {
    steps: 0,
    stepsWithAdds: 0,
    wouldHalt: 0,
    wouldEscalate: 0,
    conflicts: 0,
    understandingDisagreements: 0,
    /** 分歧样本（最多 5 条，带两侧取值与来源）：汇总日志里直接给出归因线索 */
    understandingSamples: [] as string[],
    failures: 0,
    states: {} as Record<string, number>,
  };
  const arbiterPolicy = loadArbiterPolicy();
  const arbiterMode = arbiterPolicy.mode;
  /** P5.5：本任务的 Consult 额度。耗尽后计划矛盾回落 HITL，不再询问。 */
  const consultBudget = createRunConsultBudget();
  /** 权威模式下：本步跳过 LLM/动作（硬闸 halt 已结束任务时不用；escalate 强制 replan 后用） */
  let arbiterSkipLlm = false;
  // 验证码硬闸：连续 solve_captcha 失败达到上限即强制交人，杜绝「验证码已过/未过但无限重试」。
  let consecutiveCaptchaFails = 0;
  /** 无明确成败信号（verified=null）的连续次数；同样封顶，避免「无信号」无限空转。 */
  let ambiguousCaptchaAttempts = 0;
  /** 计数所属页面：换页视为新验证码场景，重新计数，避免不同题的未决被累加成 HITL。 */
  let captchaAttemptUrl: string | null = null;
  /** 已被支付/凭证红线拦下的「命中即完成」规则：只记一次日志，避免每步刷屏。 */
  const blockedAutoCompleteLogged = new Set<string>();
  /** 已就「无法判定（inconclusive）」记过日志的规则 id：只记一次，避免每步刷屏。 */
  const loggedInconclusive = new Set<string>();
  /**
   * B3：规则里的「人工介入时机」命中时，走**同一个**介入中心请求确认（§5.6 单一收件箱）。
   * 同意 = 继续；拒绝 = 调用方中止本次任务并交回模型/人工。每规则只弹一次（hitlFired 去重）。
   */
  const confirmTaskRuleHitl = async (
    rule: TaskRule,
    detail: string,
    state: BrowserStateSummary | null,
  ): Promise<boolean> => {
    markHitl();
    const request: AgentConfirmRequest = {
      requestId: `task-rule-hitl-${rule.id}-${Date.now()}`,
      url: activePage.url(),
      reason: `用户规则「${rule.title}」要求人工确认：${detail}`,
      actions: [],
    };
    const ai_copy =
      request.ai_copy ??
      (await resolveHitlAiCopy({
        channel: "confirm",
        goal: deps.goal,
        url: request.url,
        pageTitle: state?.title,
        elements: elementsFromSelectorMap(state?.selectorMap),
        captchaAttempts: getCaptchaAttempts(activePage),
        rawHint: request.reason,
        aiSettings: deps.aiSettings,
        signal: deps.signal,
      }));
    const enriched: AgentConfirmRequest = { ...request, ai_copy };
    const shot = pickHitlScreenshot(state);
    deps.logger.agentConfirmRequired({
      requestId: enriched.requestId,
      url: enriched.url,
      reason: enriched.reason,
      actions: enriched.actions,
      ai_copy,
      profileId,
      phase: "task_rule_hitl",
      ...(shot ? { screenshotBase64: shot } : {}),
    });
    try {
      const decision = await deps.requestConfirm(enriched);
      return decision.approved;
    } catch {
      // 弹窗失败一律视为未确认（fail-closed），绝不假装用户同意了。
      return false;
    }
  };
  const CAPTCHA_MAX_FAILS = 3;
  const CAPTCHA_MAX_AMBIGUOUS = 4;
  /**
   * 验证码闸门：运行期按「当前页是否是人机验证页」独立判定（与用户目标怎么写无关）。
   * 命中即拦截本步的 navigate/done 等动作并强制走 solve_captcha —— 这正是「遇到验证码就自动
   * 识别并路由」的兜底；连续多步都过不去则转人工。
   */
  let captchaGateStreak = 0;
  /** 无法自动求解的人机验证连续存在多少步（达到上限即交人） */
  const CAPTCHA_GATE_MAX = 3;
  /** 纯导航目标「到达即完成」的证据只记一次 */
  let navigationReachedRecorded = false;

  const CAPTCHA_ACTION_NAMES = new Set([
    "solve_captcha",
    "solve_animated_captcha",
    "solve_slider_captcha",
    "solve_math_captcha",
    "solve_point_select_captcha",
  ]);

  deps.logger.agentState("running", { profileId });
  deps.logger.agentRun(
    buildAgentRunStartPayload({
      runId: agentRunId,
      profileId,
      goal: deps.goal,
      startUrl,
      domain: domainFromUrl(startUrl),
    }) as unknown as Record<string, unknown>,
  );
  noteThought("Agent 已启动（Analyze → Bootstrap → Execute）");

  let runHistoryClosed = false;
  const emitRunFinish = (input: {
    success: boolean;
    summary: string;
    status?: "complete" | "failed" | "aborted";
  }): void => {
    if (runHistoryClosed) {
      return;
    }
    runHistoryClosed = true;
    if (evidenceLedger.humanInvolved) {
      hitlOccurred = true;
    }
    const endDomain = domainFromUrl(
      (() => {
        try {
          return activePage.url() || startUrl;
        } catch {
          return startUrl;
        }
      })(),
    );
    deps.logger.agentRun(
      buildAgentRunFinishPayload({
        runId: agentRunId,
        profileId,
        goal: deps.goal,
        startUrl,
        domain: endDomain,
        success: input.success,
        status: input.status,
        summary: input.summary,
        stepCount: currentStepForArtifacts,
        hitlOccurred,
        trajectoryId: savedTrajectoryId,
        thoughtSummary: thoughtLines,
        ...runCost.snapshot(),
        failureCounts: failureLedger.runFailureCounts(),
      }) as unknown as Record<string, unknown>,
    );
  };
  const onAgentAbort = (): void => {
    noteThought("Agent 已中止");
    emitRunFinish({
      success: false,
      summary: doneSummary || "Agent 已中止",
      status: "aborted",
    });
  };
  deps.signal?.addEventListener("abort", onAgentAbort, { once: true });

  deps.logger.agentProgress("Agent 已启动（Analyze → Bootstrap → Execute）", {
    goal: deps.goal,
    maxSteps,
    enableRecording,
    arbiterMode,
    runId: agentRunId,
  });
  if (enableRecording) {
    deps.logger.agentProgress("轨迹录制已开启：成功结束后写入「轨迹记忆」", {
      phase: "record",
    });
  }

  // 人设不从环境读取：每次填表按 GeoIP 现生成
  const geoPersonaBlock = buildGeoPersonaContextBlock(parseGeoContext(deps.geoContext), null);
  const systemPrompt = `${loadSystemPrompt(settings)}\n\n${geoPersonaBlock}`.trim();
  const router = createModelRouter(deps.aiSettings);
  let lastHadError = false;
  let lastElementCount = 0;
  let forceObserveNext = true;
  /*
   * 期望核对节流（Phase 3.2 → P0.2 soft-gate）。
   *
   * 期望的口径是「**做完 plan[i] 之后**页面应该变成什么样」，所以核对对象是"上一步动作的结果"。
   * · 只在「上一步真的执行过动作」之后核对（避免第 1 步无事可核的假违例）；
   * · **通过**的期望签名写入 expectsChecked，不再重复核；
   * · **未通过**的允许在后续有动作的步骤上再核，以便 soft-gate 累计连续违反次数。
   */
  let lastStepExecutedActions = false;
  const expectsChecked = new Set<string>();
  let expectsViolationStreakKey = "";
  let expectsViolationStreakCount = 0;
  /** soft-gate 强制 replan 后本步跳过 LLM/原动作序列 */
  let expectsSkipLlm = false;
  const expectsSoftGatePolicy = loadExpectsSoftGatePolicy();
  /** 「本地 SERP 就绪但因目标还有后续交付动作而未收尾」只报一次，避免刷屏 */
  let deterministicDoneBlockedLogged = false;
  /** 下载事件归属步号（产物台账用；Phase C 之前视为 0 = 引导阶段） */
  let currentStepForArtifacts = 0;
  /** 重规划：连续无进展才问 Planner，预算用尽则停，不空转到步数上限 */
  const replanTracker = createReplanTracker();
  const replanBudget = loadReplanBudget();
  let replanNotice = "";
  /** 收尾前已经问过完成度：循环结束后不再二次评判 */
  let completionAsked = false;

  const bindActivePage = (p: Page): void => {
    if (p === activePage) return;
    activePage = p;
    // 换标签页 = 换文档：上一页的 index 空间整体失效。必须强制重新观察，
    // 否则模型的 index 会在错误的文档里解析（跨文档最隐蔽的一次误点）。
    forceObserveNext = true;
    failureLedger.reset();
  };

  // 任务级「在新标签中操作」意图（词表驱动；不写死站点文案）。
  // 显式参数优先级最高；回放侧的新标签由回放自己的选项决定，不走这里。
  const newTabIntent = detectNewTabIntent(deps.goal);
  if (newTabIntent.enabled || newTabIntent.reason === "ambiguity_skipped") {
    deps.logger.agentProgress(`新标签意图：${describeNewTabIntent(newTabIntent)}`, {
      phase: "task_shape",
      openInNewTab: newTabIntent.enabled,
      newTabMatched: newTabIntent.matched,
      newTabReason: newTabIntent.reason,
    });
  }
  const newTabHint = newTabIntent.enabled
    ? "\n（本轮目标要求「在新标签中操作」：你的第一个动作应是 navigate(url, new_tab=true) 打开目标站，然后在新标签里干活；不要复用当前标签。）"
    : "";

  await runWithGateway(gateway, async () => {
    // ——— Phase A：任务分析（不抽 DOM；长程走 MACRO_ANALYZE）———
    deps.logger.agentProgress("任务分析中…（拆解自然语言计划，不观察页面）", {
      phase: "analyze",
    });
    const analyzed = await analyzeTask({
      goal: deps.goal,
      aiSettings: deps.aiSettings,
      signal: deps.signal,
    });
    // 播种带期望的计划（Phase 3.2）：期望只落账、不裁决 —— 3.3 才由 Arbiter 消费
    messageManager.seedPlan(analyzed.planSteps, 0);
    const expectedSteps = analyzed.planSteps.filter((step) => step.expects).length;
    const deliverableLedger = createDeliverableLedger(analyzed.contract);
    const artifacts: ArtifactRecord[] = [];
    /** MACRO_ANALYZE 富计划：SubTask 切换时刷新 todo；REPLAN 时同步 plan.json */
    let activeMacroPlan: MacroPlan | null = analyzed.macroPlan;
    let lastMacroPlanIndex = 0;

    const persistMacroArtifacts = (plan: MacroPlan, currentIndex = 0, note?: string) => {
      try {
        const payload =
          note != null
            ? { ...plan, _runtime: { projected: projectMacroPlanTitles(plan), note } }
            : plan;
        fileSystem.writeFile("plan.json", `${JSON.stringify(payload, null, 2)}\n`, false);
        fileSystem.writeFile("todo.md", formatMacroTodoMarkdown(plan, currentIndex), false);
      } catch (error) {
        deps.logger.warn?.("macro_plan_persist_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    if (activeMacroPlan) {
      persistMacroArtifacts(activeMacroPlan, 0);
      deps.logger.agentProgress(
        `MACRO_ANALYZE 完成 · mode=${activeMacroPlan.mode} · ${activeMacroPlan.subtasks.length} 子任务 · ${analyzed.source}`,
        {
          phase: "macro_analyze",
          mode: activeMacroPlan.mode,
          subtasks: activeMacroPlan.subtasks.map((s) => s.title),
          synthesize: activeMacroPlan.synthesize?.format ?? null,
          gate: analyzed.macroGateReasons,
          projected: analyzed.plan,
        },
      );
    }

    deps.logger.agentProgress(
      `任务分析完成 · ${analyzed.plan.length} 步计划 · ${analyzed.contract.deliverables.length} 项交付物（${analyzed.source}）`,
      {
        phase: "analyze",
        plan: analyzed.plan,
        planExpects: expectedSteps,
        // 被本地丢弃的期望 token（自由文本/假 role）。留痕是为了让"判据被清空"这件事可见。
        planExpectsDropped: analyzed.planExpectsDropped,
        // P0 意图目前是**影子产出**（不参与裁决）。写进日志是为了能在真实任务里
        // 统计"模型判得准不准"，而不是等 3.3 拿它改决策了才发现判错。
        intent: analyzed.intent,
        intentSource: analyzed.intentSource,
        intentAgreesWithRules:
          (analyzed.intent.kind === "search") === analyzed.searchRequested,
        bootstrap: analyzed.bootstrapActions.map((a) => a.name),
        queryTerms: analyzed.queryTerms,
        acceptance: analyzed.acceptance,
        contract: analyzed.contract.deliverables.map((d) => `${d.id}:${d.kind}`),
        contractSource: analyzed.contract.source,
        macroMode: activeMacroPlan?.mode ?? null,
      },
    );

    // ——— Phase B：引导导航（零全量提取）———
    if (analyzed.bootstrapActions.length > 0) {
      const bootUrl = String(analyzed.bootstrapActions[0]?.params?.url ?? "");
      deps.logger.agentProgress(
        bootUrl ? `引导打开：${bootUrl}` : "引导执行 bootstrap 动作…",
        { phase: "bootstrap", actions: analyzed.bootstrapActions.map((a) => a.name) },
      );
      // P1 · 新标签意图：命中时把首个 navigate 改成 new_tab=true 一步完成
      //（避免先开空标签再导航）；多出来的标签由既有 tab_registry 分配稳定 id。
      const bootstrapActions = analyzed.bootstrapActions.map((action, index) =>
        newTabIntent.enabled && index === 0 && action.name === "navigate"
          ? { ...action, params: { ...action.params, new_tab: true } }
          : action,
      );
      // P4.5：暂停后不继续 multi_act；继续后从观察步恢复
      if (deps.awaitUserPauseGate && (await deps.awaitUserPauseGate())) {
        forceObserveNext = true;
      } else {
        activePage = pickLivePage(activePage);
        const bootState = await minimalBrowserState(activePage);
        const bootResults = await multiAct(bootstrapActions, {
          page: activePage,
          logger: deps.logger,
          aiSettings: deps.aiSettings,
          browserState: bootState,
          fileSystem,
          profileId,
          goal: deps.goal,
          taskPolicy,
          otpChannel: deps.otpChannel,
          resolveOtpSecret: deps.resolveOtpSecret,
          otpMailTransport: deps.otpMailTransport,
          smsOtpService: deps.smsOtpService,
          resolveSmsOtpSecret: deps.resolveSmsOtpSecret,
          captchaService: deps.captchaService,
          resolveCaptchaSecret: deps.resolveCaptchaSecret,
          requestConfirm: async (req) => {
            markHitl();
            const ai_copy =
              req.ai_copy ??
              (await resolveHitlAiCopy({
                channel: "confirm",
                goal: deps.goal,
                url: req.url,
                pageTitle: bootState.title,
                elements: elementsFromSelectorMap(bootState.selectorMap),
                captchaAttempts: getCaptchaAttempts(activePage),
                rawHint: req.reason,
                aiSettings: deps.aiSettings,
                signal: deps.signal,
              }));
            const enriched = { ...req, ai_copy };
            const shot = pickHitlScreenshot(bootState);
            deps.logger.agentConfirmRequired({
              requestId: enriched.requestId,
              url: enriched.url,
              reason: enriched.reason,
              actions: enriched.actions,
              ai_copy,
              profileId,
              phase: "hitl_ai_copy",
              ...(shot ? { screenshotBase64: shot } : {}),
            });
            return deps.requestConfirm(enriched);
          },
          askUser: async (requestId, question, meta) => {
            markHitl();
            noteThought(`HITL ask_user：${String(question ?? "").slice(0, 120)}`);
            return deps.askUser(requestId, question, meta);
          },
          requestHandover: async (req) => {
            markHitl();
            noteThought(`HITL handover：${String(req.reason ?? "").slice(0, 120)}`);
            const ai_copy =
              req.ai_copy ??
              (await resolveHitlAiCopy({
                channel: "handover",
                goal: deps.goal,
                url: req.url,
                pageTitle: bootState.title,
                elements: elementsFromSelectorMap(bootState.selectorMap),
                captchaAttempts: getCaptchaAttempts(activePage),
                rawHint: req.reason,
                aiSettings: deps.aiSettings,
                signal: deps.signal,
              }));
            const enriched = { ...req, ai_copy };
            const shot = pickHitlScreenshot(bootState);
            deps.logger.agentHandoverRequired({
              requestId: enriched.requestId,
              url: enriched.url,
              reason: enriched.reason,
              ai_copy,
              profileId,
              phase: "hitl_ai_copy",
              ...(shot ? { screenshotBase64: shot } : {}),
            });
            await deps.requestHandover(enriched);
          },
          setIncludeScreenshotNext: (v) => {
            includeScreenshotNext = v;
          },
          setActivePage: bindActivePage,
          gatewayFor: gatewayForPage,
          hostRequest,
          resolveElement: () => null,
        });
        activePage = pickLivePage(activePage);
        await activePage.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => undefined);
        await activePage.waitForTimeout(300).catch(() => undefined);
        const bootErr = bootResults.some((r) => r.error);
        lastHadError = bootErr;
        if (!bootErr && messageManager.plan.length > 1) {
          // 打开类首步已完成 → 推进到下一项
          messageManager.applyPlanUpdate({
            action: [],
            current_plan_item: 1,
          });
        }
        forceObserveNext = true;
        // 引导导航也是一次「状态变更」：必须记入证据台账的基准点，
        // 否则「模型一步没做就自称完成」会被误判成「页面已跳转」。
        recordStepEvidence(evidenceLedger, {
          step: 0,
          actionNames: analyzed.bootstrapActions.map((a) => a.name),
          results: bootResults.map((r) => ({
            error: r.error ?? null,
            metadata: (r.metadata ?? null) as Record<string, unknown> | null,
            extractedContent: r.extractedContent ?? null,
          })),
          url: activePage.url(),
          screenshotTaken: false,
          pageDigestChars: 0,
        });
      }
    }

    // 落盘产物记账：下载是浏览器事件，不是动作返回值 —— 不装监听就只能靠模型自述「我下载了」。
    try {
      attachArtifactTracker(activePage.context(), artifacts, {
        ledger: evidenceLedger,
        currentStep: () => currentStepForArtifacts,
        logger: deps.logger,
      });
    } catch (error) {
      deps.logger.warn?.("artifact_tracker_attach_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // ——— Phase C：按计划执行（按需观察）———
    const reviseRemainingPlan = async (errors: string[], headline: string): Promise<boolean> => {
      const pendingLines = listPendingDeliverables(deliverableLedger).map(
        (item) => `[${item.spec.id}] ${item.spec.kind} ${item.spec.text}`,
      );
      // 已核销项必须一起喂进去：重规划器看不到它们时，会把"已完成但没被记录"的事**从头再做一遍**
      // （用户现场：写出「首页→输入→提交」，把已到达的结果页丢掉、回引擎首页重搜）。
      const satisfiedLines = listDeliverables(deliverableLedger)
        .filter((item) => item.record.status === "satisfied")
        .map(
          (item) =>
            `[${item.spec.id}] ${item.spec.kind} ${item.spec.text}（核销依据：${String(item.record.evidence ?? "").slice(0, 120)}）`,
        );
      deps.logger.agentProgress(headline, { phase: "replan" });
      const revised = await requestReplan({
        goal: deps.goal,
        plan: messageManager.plan,
        pendingLines,
        satisfiedLines,
        errors: errors.slice(0, 4),
        url: activePage.url(),
        title: browserState?.title,
        digest: browserState?.pageDigest ?? undefined,
        aiSettings: deps.aiSettings,
        signal: deps.signal,
        rounds: replanBudget.roundsPerReplan,
      });
      markReplanUsed(replanTracker);
      evidenceLedger.rejections = 0;
      deliverableLedger.rejections = 0;
      messageManager.recordSuccess();
      if (!revised) {
        replanNotice = "重规划没有得到可用计划。请换一条路径推进未完成的交付物，不要重复刚才的失败手法，也不要直接 done。";
        deps.logger.agentProgress("重规划未得到可用计划（本轮预算已消耗）", { phase: "replan" });
        return false;
      }
      messageManager.replaceRemainingPlan(revised.plan);
      const added = absorbPlanDeliverables(deliverableLedger, revised.plan);
      const nextItem = messageManager.currentPlanText() ?? revised.plan[0] ?? "";
      if (activeMacroPlan) {
        // REPLAN：保留富字段，用新标题重投影剩余子任务视图并刷新 todo / plan.json
        const doneCount = messageManager.plan.filter((p) => p.status === "done").length;
        activeMacroPlan = {
          ...activeMacroPlan,
          mode: "macro",
          subtasks: revised.plan.map((title, i) => ({
            id: `st_replan_${i + 1}`,
            title,
            goal: title,
            entry_hint: "",
            parallel_group: null,
            depends_on: i > 0 ? [`st_replan_${i}`] : [],
            skills_to_recall: ["context-management"],
            artifact_key: `replan_${i + 1}`,
            success_criteria: ["完成本步目标"],
            on_fail: "replan",
            estimate_steps: 3,
          })),
          synthesize: activeMacroPlan.synthesize,
          replan_triggers: activeMacroPlan.replan_triggers,
        };
        lastMacroPlanIndex = 0;
        persistMacroArtifacts(
          activeMacroPlan,
          0,
          `replan:${revised.reason || "stalled"}; prior_done=${doneCount}`,
        );
      }
      replanNotice =
        `计划已按失败重写${revised.reason ? `（${revised.reason}）` : ""}。` +
        `下一步只执行当前计划项「${nextItem}」。禁止重复刚才失败的手法；交付物未核销前禁止 done。`;
      deps.logger.agentProgress(`重规划完成 · ${revised.plan.length} 步`, {
        phase: "replan",
        plan: revised.plan,
        reason: revised.reason,
        addedDeliverables: added,
      });
      forceObserveNext = true;
      return true;
    };

    for (let step = 1; step <= maxSteps; step++) {
      if (deps.signal?.aborted) {
        throw new Error("Agent 已中止");
      }
      // P4.5：步间暂停 — 恢复后强制观察，不带着旧动作盲跑
      if (deps.awaitUserPauseGate && (await deps.awaitUserPauseGate())) {
        forceObserveNext = true;
      }
      currentStepForArtifacts = step;
      arbiterSkipLlm = false;
      expectsSkipLlm = false;

      activePage = pickLivePage(activePage);
      const planText = messageManager.currentPlanText();
      const needObserve =
        forceObserveNext ||
        lastHadError ||
        lastElementCount === 0 ||
        planItemNeedsObservation(planText) ||
        includeScreenshotNext ||
        panoramaEnabled;

      disposeObservation(previousObservation);
      previousObservation = null;

      let pack: ObservationPack | null = null;
      let observationQuality: ObservationQuality | null = null;
      let visionImages: string[] = [];

      if (needObserve) {
        deps.logger.agentProgress(`第 ${step}/${maxSteps} 步：观察页面…`, {
          url: activePage.url(),
          planItem: planText,
        });
        const requestedShot = includeScreenshotNext;
        // 自愈观察：抽取不可用 → 阶梯重抽 → 仍不可用则降级（正文/补救截图），全程受预算约束
        const resilient = await prepareObservationResilient(activePage, {
          goal: deps.goal,
          profileId,
          panoramaEnabled,
          forceViewportShot: requestedShot && !panoramaEnabled,
          senseMode: "balanced",
          signal: deps.signal,
          previous: null,
          onHealAttempt: (attempts, reason, waitMs) => {
            deps.logger.agentProgress(
              `第 ${step} 步：观察自愈重抽 ${attempts + 1}/${PAGE_PIPELINE_CONFIG.observeMaxAttempts}（${reason.slice(0, 80)}）`,
              { step, attempt: attempts, waitMs, phase: "observe_heal" },
            );
          },
        });
        pack = resilient.pack;
        observationQuality = resilient.quality;
        previousObservation = pack;
        assertObservationReady(pack);
        if (observationQuality.attempts > 1) {
          deps.logger.agentProgress(
            observationQuality.ok
              ? `第 ${step} 步：观察自愈成功（第 ${observationQuality.attempts} 次尝试，${observationQuality.elementCount} 控件）`
              : `第 ${step} 步：观察降级（尝试 ${observationQuality.attempts} 次）：${observationQuality.reason?.slice(0, 120) ?? ""}`,
            { step, phase: "observe_heal", quality: observationQuality },
          );
        }

        // Agent 显式要图却拍不到 → 立即失败，禁止静默「截图关闭」空转
        if (
          requestedShot &&
          !panoramaEnabled &&
          (!pack.shots || pack.shots.length === 0)
        ) {
          const reason = pack.error?.trim()
            ? `截图失败：${pack.error}`
            : SCREENSHOT_CAPABILITY_ERROR;
          deps.logger.agentProgress(`截图能力不可用：${reason}`, {
            step,
            phase: "screenshot_gate",
          });
          doneSummary = reason;
          finished = true;
          doneSuccess = false;
          includeScreenshotNext = false;
          break;
        }

        let fillSnap = null as Awaited<ReturnType<typeof snapshotInteractiveElements>> | null;
        try {
          fillSnap = await Promise.race([
            snapshotInteractiveElements(activePage, null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
          ]);
        } catch {
          fillSnap = null;
        }

        void emitInteractiveExtractDebug(deps.logger, {
          profileId,
          source: "agent_loop",
          fill: fillSnap,
          agent: {
            url: pack.url,
            extractedAt: pack.extractedAt,
            llm_json: pack.llm_json,
            element_map: pack.element_map,
            skipped: 0,
          },
          userDataDir: null,
          title: pack.title,
        }).catch(() => undefined);

      deps.logger.agentProgress(
        pack.softError
          ? `第 ${step} 步：观察软着陆 — ${pack.error ?? "unknown"}`
          : `第 ${step} 步：提取完成 · ${pack.llm_json.length} 控件 · ${pack.readyNote}`,
        {
          step,
          url: pack.url,
          elements: pack.llm_json.length,
          readyNote: pack.readyNote,
          softError: pack.softError,
          error: pack.error,
        },
      );

        // 全景开 或 Agent 本步请求了 screenshot：都必须把图挂给决策模型
        const shouldAttachShots =
          !pack.softError &&
          (panoramaEnabled || includeScreenshotNext) &&
          Boolean(pack.shots?.length);
        visionImages = shouldAttachShots ? materializeShotDataUrls(pack) : [];
        if (includeScreenshotNext) {
          includeScreenshotNext = false;
        }

        browserState = await buildBrowserStateWithShortIdDiff(
          activePage,
          {
            url: pack.url,
            extractedAt: pack.extractedAt,
            llm_json: pack.llm_json,
            element_map: pack.element_map,
            skipped: 0,
            screenshotBase64: visionImages[0] ?? null,
          },
          previousShortIds,
          previousUrl,
          settings.maxClickableElementsLength,
        );
        browserState.screenshotList = visionImages;
        browserState.observationError = pack.softError ? pack.error : null;

        // 观察途中页面被关掉（第三方授权弹窗办完事自己关闭 / 用户关标签页）：
        // 这是**环境变了**，不是任务失败。丢掉这一轮的观察，切到还活着的页面重新观察，
        // 下一步再决策 —— 绝不能把整个任务死在一个已经消失的窗口上。
        if (browserState.pageClosed) {
          activePage = pickLivePage(activePage);
          bindActivePage(activePage);
          previousShortIds = null;
          previousUrl = null;
          failureLedger.reset();
          forceObserveNext = true;
          deps.logger.agentProgress(
            `第 ${step} 步：观察途中页面被关闭 → 已切到存活页面并重新观察（${activePage.url()}）`,
            { step, phase: "page-closed" },
          );
          continue;
        }
        // 观察质量直接进决策上下文：降级时模型必须知道「本轮没有控件索引」
        browserState.observationQuality = observationQuality;
        // SoM：告诉模型截图上的编号是否可用，避免它对着无标记的图凭感觉点
        browserState.somMarks = pack.somMarks;
        // Phase 4.1a：结构化 a11y 角色只读透传（不进提示词、不参与编号；供页面分类使用）
        browserState.a11yRoles = pack.a11yStructure
          ? {
              roles: pack.a11yStructure.roles,
              roleCounts: pack.a11yStructure.roleCounts,
              interactiveCount: pack.a11yStructure.interactiveCount,
              indexSpace: pack.a11yStructure.indexSpace,
            }
          : null;
        if (pack.degradedText?.trim()) {
          browserState.interactiveTree =
            `${browserState.interactiveTree}\n\n# degraded_observation\n` +
            "控件索引不可用，以下为页面正文（禁止用 index 动作）：\n" +
            pack.degradedText.slice(0, PAGE_PIPELINE_CONFIG.degradedTextChars);
        }
        if (pack.a11ySummary?.trim()) {
          browserState.interactiveTree = `${browserState.interactiveTree}\n\n# a11y_summary\n${pack.a11ySummary.slice(0, 4000)}`;
        }
        lastElementCount = browserState.elementCount;
        forceObserveNext = false;
      } else {
        deps.logger.agentProgress(
          `第 ${step}/${maxSteps} 步：按计划推进（跳过重观察）· ${planText ?? ""}`,
          { url: activePage.url(), skippedObserve: true },
        );
        browserState = await minimalBrowserState(activePage);
        browserState.interactiveTree =
          `${browserState.interactiveTree}\n\n# note\n本步按计划跳过全量 DOM 提取；若需点击/输入请先 screenshot 或下一轮将强制观察。`;
        lastElementCount = 0;
        forceObserveNext = true;
      }

      if (!browserState) {
        throw new Error("browserState 未初始化");
      }

      // P4.4：控制台 Tab 感知（只读 open tabs + active）
      try {
        deps.logger.openTabs(
          buildOpenTabsPayload({
            tabs: browserState.tabs ?? [],
            profileId,
            step,
          }),
        );
      } catch {
        /* 上报失败不影响主循环 */
      }

      // 确定性页面阅读：给「分析/总结/自然语言验收」可引用的正文，不依赖二次 extract LLM
      browserState.pageDigest = await safePageDigest(activePage);
      if (browserState.pageDigest) {
        deps.logger.agentProgress(
          `第 ${step} 步：页面阅读就绪 · ${browserState.pageDigest.slice(0, 80).replace(/\s+/g, " ")}…`,
          { step, hasPageDigest: true },
        );
      }

      // 人机验证闸门：用本轮已收集的页面文案/控件/URL 独立判定（零额外 DOM 抽取）。
      // 「整页就是一道验证题」（interstitial）时跳过确定性收尾，并在下面把本步动作收敛到 solve_captcha；
      // 普通表单里嵌着的验证码控件只提示、不接管，避免把多步任务做废。
      const captchaGate = detectCaptchaGate({
        pageText: `${browserState.title ?? ""}\n${browserState.interactiveTree ?? ""}\n${browserState.pageDigest ?? ""}`.slice(
          0,
          12_000,
        ),
        pageUrl: browserState.url,
        goalHint: deps.goal,
        controlLabels: [...(browserState.selectorMap?.values() ?? [])].map((el) =>
          `${el.text ?? ""} ${el.placeholder ?? ""} ${el.name ?? ""}`.trim(),
        ),
        elementCount: browserState.elementCount,
        title: browserState.title,
      });
      if (captchaGate.present) {
        captchaGateStreak += 1;
        deps.logger.agentProgress(
          `第 ${step} 步：检测到人机验证（${
            captchaGate.strategy
              ? `可自动求解：${captchaGate.strategy}`
              : captchaGate.nonImage
                ? "非图片型：需人工提供验证码"
                : "类型未支持"
          }${captchaGate.interstitial ? " · 整页闸门" : " · 页内控件"}）· 连续第 ${captchaGateStreak} 步`,
          {
            step,
            phase: "captcha_gate",
            strategy: captchaGate.strategy,
            nonImage: captchaGate.nonImage,
            interstitial: captchaGate.interstitial,
            matched: captchaGate.matched,
          },
        );
      } else {
        captchaGateStreak = 0;
      }

      previousShortIds = new Set(
        [...browserState.selectorMap.values()].map((e) => e.shortId),
      );
      // 期望影子核对需要"上一步的 URL"，而下面这行会立刻把它覆盖成当前 URL —— 先留一份。
      // （state_change=url_changed 若拿当前 URL 去比，会永远判成"没变化"——这正是错误事实。）
      const urlBeforeObserve = previousUrl;
      // 换页 = 索引纪元更替：旧的失败账目不再适用于新页面的 index 空间
      if (previousUrl != null && previousUrl !== browserState.url) {
        failureLedger.reset();
      }
      previousUrl = browserState.url;
      messageManager.recordPage(
        browserState.url,
        browserState.interactiveTree,
        browserState.elementCount,
      );

      const nudges = [
        ...messageManager.buildNudges(step, maxSteps),
        ...(pack ? buildObservationNudges(pack) : []),
        // 失败台账：只报已经撞墙的目标，避免把普通失败也刷成噪音
        ...failureLedger.renderHints(),
        // 上一步新开的标签页（只注入一轮）：新页不会自己进观察范围
        ...popupNudges,
      ];
      popupNudges = [];
      if (analyzed.queryTerms.length) {
        nudges.push(
          `检索词提示：${analyzed.queryTerms.join("、")}（输入时优先用此词，勿改写）`,
        );
      }
      if (analyzed.acceptance) {
        nudges.push(`验收标准：${analyzed.acceptance}`);
      }
      if (replanNotice) {
        nudges.push(replanNotice);
        replanNotice = "";
      }
      // 契约台账：把「还差哪几项」摆在模型眼前（全绿后自动消失，不占上下文）
      nudges.push(...pendingContractLines(deliverableLedger));
      if (planText && /输入|搜索框|找/.test(planText)) {
        nudges.push(
          `当前计划项是「${planText}」：优先 input/click，禁止无必要的重新 navigate。`,
        );
      }
      if (/注册|register|sign\s*up/i.test(deps.goal)) {
        nudges.push(
          "目标含注册：先 recall_skill(\"account-lifecycle\") 按阶段图推进；若 browser_state 已有「Go to register / Register / 注册」控件，直接 click 其 index；禁止无谓 search_page。邮箱 OTP 优先 fetch_email_otp（网页邮箱须设置显式启用，禁止自己打开邮箱或改指纹），短信 OTP 优先 fetch_sms_otp（须显式启用），TOTP 必须 ask_user。",
        );
      }
      if (
        /加购|加入购物车|购物|下单|结算|结账|购买|收银台|add\s*to\s*cart|\bcart\b|checkout|purchase|\bbuy\b/i.test(
          deps.goal,
        )
      ) {
        nudges.push(
          "目标含购物/加购/结算：先 recall_skill(\"commerce-checkout\") 按阶段图推进至 stop_before_pay；合法终态 awaiting_human_payment（待人工支付）。禁止自动提交支付/扣款；目标含「付掉/支付成功」时无人工确认前不得 done(success=true) 冒充已付款。",
        );
      }
      if (
        /订票|预订|预约|机票|航班|酒店|旅客|乘客|火车票|高铁|车次|booking|book\s*flight|\bhotel\b|travel|passenger|traveler|itinerary|train\s*ticket/i.test(
          deps.goal,
        )
      ) {
        nudges.push(
          "目标含订票/预订：先 recall_skill(\"travel-booking\") 按阶段图推进至 stop_before_pay；乘客资料按本次 Geo 现生成，证件号缺了再 ask_user；合法终态 awaiting_human_payment（待人工支付）。禁止自动提交支付/扣款；目标含「付掉/支付成功」时无人工确认前不得 done(success=true) 冒充已付款。",
        );
      }
      if (/中文|语言|english|\ben\b|\bzh\b|hebrew|עבר|locale|語系/i.test(deps.goal)) {
        nudges.push(
          "UI 语言/图标入口：若 index 文案模糊（button/icon/language），必须 ask_vision_locate(query=要点哪个形态)，禁止 ask_user 猜图标；无视觉模型时系统会直接报错停机。",
        );
      }
      // 验证码意图组事实：既有逻辑在本块内使用；提出到外层是为了让 Arbiter 影子裁决
      // 也能读到（Arbiter 的 `captchaIntent/captchaVerifyTarget/...` 三项事实就是它们）。
      let captchaIntent = false;
      let captchaVerifyTarget: { index: number; label: string } | null = null;
      let captchaFilledPending = false;
      let captchaToolAsksClick = false;
      if (/验证码|captcha|人机验证|match2025|猿人学|停留时间最长|迷雾|动图|滑块|缺口|验证答案|算式|依次点击|按顺序点击|点选/i.test(deps.goal)) {
        captchaIntent = true;
        const verifyHit = findIndexByTextHint(
          browserState.selectorMap,
          /验证答案/i,
          /提交参赛/i,
        );
        const last = messageManager.history[messageManager.history.length - 1];
        const lastBlob = (last?.actionResults ?? [])
          .map((r) => `${r.extractedContent ?? ""} ${r.longTermMemory ?? ""} ${r.error ?? ""}`)
          .join(" ");
        const filledPending =
          /已输入|filled|填入|已填/i.test(lastBlob) &&
          !/verified|验证通过|已点击.*验证答案/i.test(lastBlob);
        const toolAsksClick = /click\(index=\d+\)|下一轮仅 click/i.test(lastBlob);
        captchaVerifyTarget = verifyHit;
        captchaFilledPending = filledPending;
        captchaToolAsksClick = toolAsksClick;

        if ((filledPending || toolAsksClick) && verifyHit) {
          nudges.push(
            `验证码收尾：本步唯一动作 click(index=${verifyHit.index})「${verifyHit.label}」。禁止再 solve_captcha，禁止空等。`,
          );
        } else if (verifyHit) {
          nudges.push(
            `验证码：优先本轮唯一动作 solve_captcha。若工具失败但已心算答案，下一轮单独 input(答案)+click（勿与 solve_captcha 同轮；browser_state 已有「${verifyHit.label}」index=${verifyHit.index}）。禁止空等。`,
          );
        } else {
          nudges.push(
            "验证码：本轮唯一动作 solve_captcha（自动分发 GIF/滑块/算式）。失败勿换别名空转；未支持类型勿死磕；禁止刷新。",
          );
        }
      }

      // 运行期闸门（与目标措辞无关）：检测到验证码就把决策收敛到验证码路径
      if (captchaGate.interstitial) {
        nudges.push(
          captchaGate.strategy
            ? `【验证码闸门】整页就是一道人机验证（${captchaGate.strategy}）。本步唯一动作必须是 solve_captcha；禁止 navigate/done/重复提交；失败满 ${CAPTCHA_MAX_FAILS} 次将转人工。`
            : captchaGate.nonImage
              ? "【验证码闸门】整页需要短信/邮箱/验证器动态码：邮箱码优先 fetch_email_otp（网页邮箱须显式启用，禁止自己打开邮箱或改指纹）；短信码优先 fetch_sms_otp（须显式启用）；验证器用 ask_user；禁止猜测/编造；禁止 done(success=true)。"
              : "【验证码闸门】整页像人机验证但类型未支持：优先 solve_captcha 尝试；仍失败请 handover_to_human，禁止刷新/重复 navigate。",
        );
      } else if (captchaGate.present) {
        nudges.push(
          "【页面含验证码】本页有验证码控件：处理到它时用 solve_captcha（勿手点/勿猜）；验证未通过前禁止 done(success=true)。不必为它中止其它正常步骤。",
        );
      }

      // 图标/图片目标：DOM 文本含糊且任务需要点图 → 无视觉模型则硬停（语言球/点某图通用）
      if (
        pack &&
        !pack.softError &&
        pageLooksIconAmbiguous(pack.llm_json) &&
        goalNeedsVisualLocate(deps.goal) &&
        !isIntentConfigured(router.pool, "vision")
      ) {
        deps.logger.agentProgress(VISION_CAPABILITY_ERROR, {
          step,
          phase: "vision_gate",
          elements: pack.llm_json.length,
        });
        doneSummary = VISION_CAPABILITY_ERROR;
        finished = true;
        doneSuccess = false;
        break;
      }
      if (
        pack &&
        !pack.softError &&
        pageLooksIconAmbiguous(pack.llm_json) &&
        goalNeedsVisualLocate(deps.goal) &&
        isIntentConfigured(router.pool, "vision")
      ) {
        nudges.push(
          "当前页多为无文字图标：本步优先 ask_vision_locate(query=清晰描述要点的控件形态，click=true)；禁止 ask_user，禁止瞎点 button。",
        );
      }

      const goalNeedsUnderstanding = goalNeedsPageUnderstanding(deps.goal);
      const planNeedsUnderstanding = planItemNeedsPageUnderstanding(planText);
      const digestReady = Boolean(browserState.pageDigest?.trim());
      const pageUrl = browserState.url;
      const digest = browserState.pageDigest ?? "";
      // 本步只算一次：既是既有的 qOk 判据，也是 Arbiter 影子裁决的一项事实
      const queryMatched = queryMatchedOnPage(analyzed.queryTerms, digest, pageUrl);
      // 每步只算一次页面类型（纯内存、零成本），供本步所有「结果页」判断共用。
      // 三处调用以前各自调用 isSearchResultsUrl（同一事实算三遍）；收敛成一份判决后，
      // 将来给 page_kind 补 A11y/遮挡证据时，三处会自动一起受益。
      // 注意 serpLike 是**宽松**判定，与既有 isSearchResultsUrl 逐字等价（严格化会丢收尾能力）。
      // hasBlockingOverlay 暂不传：观察层当前还没有「遮挡」这一事实，编不出来就不编，留给 3.3 的 Arbiter 接线。
      const pageKind = classifyPageKind({
        url: pageUrl,
        title: browserState.title,
        a11y: browserState.a11yRoles,
        captcha: captchaGate,
      });
      const onSerp = pageKind.serpLike;

      // ——— P0.2：Plan Expects soft-gate ———
      // 核对对象是「**上一步动作**把页面变成了什么样」（期望的口径是"做完 plan[i] 之后"）。
      // 首次违反：强 nudge；连续 N 次同一违反签名：强制 replan，禁止继续原动作。
      // 简单 SERP（isSimpleAgentTask）永不因 soft-gate 强制 replan（验收：不被误杀）。
      const shadowExpects = messageManager.currentPlanExpects();
      // 期望核对结果同时供 soft-gate 与 Arbiter（`expectsViolations`）使用。
      const expectsSignature = shadowExpects
        ? `${planText ?? ""}\u0000${JSON.stringify(shadowExpects)}`
        : "";
      // 直接内联条件（而不是先算一个布尔量）是为了让 TS 能收窄 shadowExpects 的类型
      const shadowCheck =
        shadowExpects && lastStepExecutedActions && !expectsChecked.has(expectsSignature)
          ? checkExpects(shadowExpects, {
              url: pageUrl,
              prevUrl: urlBeforeObserve,
              a11yLabels: a11yLabelsFrom(browserState.a11yRoles?.roles),
            })
          : null;
      // 通过的期望锁定；未通过的不进 Set，以便后续步骤累计 soft-gate 连续违反
      if (shadowCheck?.ok) {
        expectsChecked.add(expectsSignature);
        expectsViolationStreakKey = "";
        expectsViolationStreakCount = 0;
      }
      let expectsViolations = shadowCheck?.violations ?? [];
      if (shadowCheck && !shadowCheck.ok) {
        const softGate = decideExpectsSoftGate({
          ok: false,
          violations: shadowCheck.violations,
          streakKey: expectsViolationStreakKey,
          streakCount: expectsViolationStreakCount,
          threshold: expectsSoftGatePolicy.consecutiveViolationsToReplan,
          replanAllowed: !isSimpleAgentTask(deps.goal, analyzed.queryTerms),
        });
        expectsViolationStreakKey = softGate.nextStreakKey;
        expectsViolationStreakCount = softGate.nextStreakCount;
        if (softGate.nudge && !nudges.includes(softGate.nudge)) {
          nudges.push(softGate.nudge);
        }
        deps.logger.agentProgress(
          softGate.action === "replan"
            ? `第 ${step} 步：期望 soft-gate 强制重规划（连续 ${softGate.nextStreakCount} 次）· ${shadowCheck.violations.join("；")}`
            : `第 ${step} 步：期望 soft-gate 未通过（第 ${softGate.nextStreakCount} 次，强引导）· ${shadowCheck.violations.join("；")}`,
          {
            step,
            phase: "expects_soft_gate",
            action: softGate.action,
            streak: softGate.nextStreakCount,
            threshold: expectsSoftGatePolicy.consecutiveViolationsToReplan,
            violations: shadowCheck.violations,
            skipped: shadowCheck.skipped,
            planItem: planText ?? null,
            simpleTaskExempt: isSimpleAgentTask(deps.goal, analyzed.queryTerms),
          },
        );
        if (softGate.action === "replan") {
          const replanned = await reviseRemainingPlan(
            shadowCheck.violations,
            `期望 soft-gate：连续 ${softGate.nextStreakCount} 次违反，强制重规划`,
          );
          expectsSkipLlm = true;
          // 已由 soft-gate 处理：清空喂给 Arbiter 的违反，避免同一步双重 replan
          expectsViolations = [];
          expectsViolationStreakKey = "";
          expectsViolationStreakCount = 0;
          deps.logger.agentProgress(
            replanned
              ? `期望 soft-gate：已重规划，跳过本步原动作序列`
              : `期望 soft-gate：重规划未果，仍跳过本步原动作并保留引导`,
            { step, phase: "expects_soft_gate", replanned, forceReplan: true },
          );
        }
      }

      const goalHasFollowup = goalHasFollowupDeliverable(deps.goal);

      /*
       * 「本任务是否需要读懂并告知」——**布尔维度**，不是单值分类。
       *
       * 改造前这里绑的是 P0 的单值分类（`analyzed.intent.kind === "understand"`），二者量纲不同：
       * P0 kind 回答"这个目标**主要**在干什么"，而「打开谷歌搜索刘亦菲**并总结第一条结果」这类
       * 复合目标在它眼里只有一个答案 —— search，于是"理解"那一半被整段丢掉：
       * 用户现场 7/7 步都在报这个分歧，且 Arbiter 给出的引导里列的全是不相关的"下载/切栏目"动作。
       *
       * 契约比单值 kind 更接近事实：只要有一项**必交**交付物是 content_read / answer_given，
       * 这个任务就必须"读懂并告知"。所以取并集 —— P0 ∪ 契约（都是已产出的结构化事实，零额外成本）。
       */
      // answer_given / content_read 即便 required=false 也算「要写结论」——
      // 否则「搜索 + 总结」会被判成纯搜索，本地把 page_digest 原文 dump 进 done。
      const needsUnderstanding =
        analyzed.intent.kind === "understand" ||
        analyzed.contract.deliverables.some(
          (item) => item.kind === "content_read" || item.kind === "answer_given",
        ) ||
        goalNeedsUnderstanding;

      // 纯导航目标到达目标 URL：先落客观证据（done 验收用，去重一次），再由下面的确定性收尾结束任务
      if (!navigationReachedRecorded && analyzed.navigationTargets.length > 0) {
        const reached = firstReachedTarget(pageUrl, analyzed.navigationTargets);
        if (reached && !goalRequestsSearch(deps.goal).requested && !goalHasFollowup && !goalNeedsUnderstanding) {
          navigationReachedRecorded = markNavigationReached(evidenceLedger, {
            step,
            url: pageUrl,
            detail: reached,
          });
          if (navigationReachedRecorded) {
            deps.logger.agentProgress(`纯导航目标已到达：${reached}`, {
              step,
              phase: "navigation_reached",
            });
          }
        }
      }
      if (digestReady && (needsUnderstanding || planNeedsUnderstanding)) {
        if (goalHasFollowup && !goalNeedsPageUnderstanding(deps.goal) && !planNeedsUnderstanding) {
          nudges.push(
            "本步需理解页面：可先用 <page_digest> 记下已读到的内容，但**目标还有后续交付动作**（下载/保存/点击栏目/打开第 N 项…），禁止就此 done；先完成那些动作并留下可验证结果。",
          );
        } else {
          nudges.push(
            "本步需理解/总结/分析：请根据 <page_digest> **用自己的话写结论**（遵守用户字数要求），再单独调用 done(text=结论)。" +
              "禁止把 page_digest /【页面阅读】原文整段贴进 done；禁止空转观察；仅当摘要明显不足时再 extract 一次。",
          );
        }
      } else if (digestReady && onSerp && !needsUnderstanding) {
        nudges.push(
          goalHasFollowup
            ? "搜索结果页只是中途站：目标里还有后续交付动作（下载/保存/点击栏目/打开第 N 项/切换频道…），请按当前计划项继续推进，勿在此 done。"
            : queryMatched
              ? "搜索类目标：结果页已可读（见 page_digest）。请立即 done(success=true)，text 简要确认已搜到关键词即可，勿再分析整页。"
              : "已在搜索结果页：对照 page_digest 确认查询词是否匹配；匹配则 done，不匹配则修正搜索后 done。",
        );
      } else if (planNeedsUnderstanding && !digestReady) {
        nudges.push(
          "需要理解页面但暂无 page_digest：先 search_page 或 extract(query=用户问题)，拿到内容后再 done。",
        );
      }

      if (step === maxSteps) {
        nudges.push(NUDGE_LAST_STEP);
      }

      nudges.push(
        ...buildSkillMatchNudges({
          goal: deps.goal,
          url: browserState.url,
          pageText: `${browserState.pageDigest ?? ""}\n${browserState.interactiveTree ?? ""}`.slice(
            0,
            4000,
          ),
        }),
      );

      // ——— P0.1：Arbiter 权威裁决（shadow / guide / hard，见 arbiter_policy.json）———
      // shadow：只记日志、不阻断（与升级前一致，fail-open）。
      // guide（默认）：注入 nudges；halt/escalate 生效。
      // hard：同 guide，且 halt/escalate 时跳过本步危险动作（不跑 LLM），进 replan/HITL；打 arbiter_active。
      try {
        // `usablePack` 让 TS 能收窄类型（布尔量无法穿过 `Boolean(...)` 传递收窄）
        const usablePack = pack && !pack.softError ? pack : null;
        const observationOk = usablePack !== null;
        // P5.5：权威档且额度未尽、未中止才咨询。影子档 / 预算耗尽仍走 HITL，禁止静默。
        const consultAvailable =
          isArbiterAuthoritative(arbiterMode) &&
          consultBudgetReady(consultBudget, Boolean(deps.signal?.aborted));
        const decision = arbitrate({
          facts: {
            url: pageUrl,
            title: browserState.title,
            pageKind,
            captcha: captchaGate,
            observationOk,
            digestReady,
            queryMatched,
            pendingDeliverables: listPendingDeliverables(deliverableLedger).length,
            // 官方事实取 P0 意图（3.2 产出）。legacy 正则值另外记进日志 —— 两者是否一致，
            // 正是"能不能接管"的核心证据（接管后这一项就由 P0 决定）。
            needsUnderstanding,
            planNeedsUnderstanding,
            hasFollowup: goalHasFollowup,
            expectsViolations,
            iconAmbiguous: usablePack ? pageLooksIconAmbiguous(usablePack.llm_json) : false,
            captchaVerifyTarget,
            captchaIntent,
            captchaFilledPending,
            captchaToolAsksClick,
            signals: messageManager.arbiterSignals(step, maxSteps),
          },
          step,
          maxSteps,
          visionConfigured: isIntentConfigured(router.pool, "vision"),
          goalNeedsVisualLocate: goalNeedsVisualLocate(deps.goal),
          consultAvailable,
          captchaMaxFails: CAPTCHA_MAX_FAILS,
        });
        const adds = decision.nudges.filter((n) => !nudges.includes(n));
        // consult 未就绪时 escalate 为空，但 consult_conflict 仍算「会改行为」的升级意图
        const escalateIntent =
          Boolean(decision.escalate) || (decision.state === "consult_conflict" && !consultAvailable);
        arbiterShadow.steps += 1;
        arbiterShadow.states[decision.state] = (arbiterShadow.states[decision.state] ?? 0) + 1;
        if (adds.length) arbiterShadow.stepsWithAdds += 1;
        if (decision.halt) arbiterShadow.wouldHalt += 1;
        if (escalateIntent) arbiterShadow.wouldEscalate += 1;
        if (decision.state === "consult_conflict") arbiterShadow.conflicts += 1;
        /*
         * P0 ∪ 契约 与既有正则在"是否需理解页面"上的分歧。
         *
         * 改造前这里比的是 P0 的**单值分类**，与正则的**布尔维度**量纲不同 ——
         * 「先搜索再总结第一条」必然一个说 search、一个说 true，于是 7/7 步全报"分歧"，
         * 而那个数字根本不能当"P0 判错率"用（真问题被这个噪声盖住了）。
         * 现在两侧都是布尔维度（P0 ∪ 契约 vs 正则），这个计数才真正可比。
         */
        if (needsUnderstanding !== goalNeedsUnderstanding) {
          arbiterShadow.understandingDisagreements += 1;
          if (arbiterShadow.understandingSamples.length < 5) {
            arbiterShadow.understandingSamples.push(
              `#${step} P0∪契约(understood=${needsUnderstanding},kind=${analyzed.intent.kind},followup=${analyzed.intent.needsFollowup},src=${analyzed.intentSource}) vs 正则(understood=${goalNeedsUnderstanding},followup=${goalHasFollowup})`,
            );
          }
          deps.logger.agentProgress(
            `理解维度分歧 #${step}：P0∪契约 needsUnderstanding=${needsUnderstanding}（kind=${analyzed.intent.kind}，followup=${analyzed.intent.needsFollowup}，来源 ${analyzed.intentSource}）· 正则 needsUnderstanding=${goalNeedsUnderstanding}（followup=${goalHasFollowup}）`,
            {
              step,
              phase: "arbiter_shadow_understanding",
              p0Kind: analyzed.intent.kind,
              p0NeedsFollowup: analyzed.intent.needsFollowup,
              p0Source: analyzed.intentSource,
              unionNeedsUnderstanding: needsUnderstanding,
              ruleNeedsUnderstanding: goalNeedsUnderstanding,
              ruleHasFollowup: goalHasFollowup,
              planNeedsUnderstanding,
              // 两侧同为布尔维度（P0∪契约 vs 正则），这个分歧才是真正可归因的差异
              semantics: "union_of_judgment_vs_regex",
            },
          );
        }
        const logPhase =
          arbiterMode === "hard"
            ? "arbiter_active"
            : arbiterMode === "guide"
              ? "arbiter_guide"
              : "arbiter_shadow";
        if (adds.length || decision.halt || escalateIntent) {
          deps.logger.agentProgress(`Arbiter 裁决（${arbiterMode}）：${decision.state} · ${decision.reason}`, {
            step,
            phase: logPhase,
            mode: arbiterMode,
            state: decision.state,
            reason: decision.reason,
            adds,
            wouldHalt: Boolean(decision.halt),
            wouldEscalate: escalateIntent,
            // 接管后 needsUnderstanding 由 P0 ∪ 契约 决定，所以它和正则的差值是关键证据
            understandingUnion: needsUnderstanding,
            understandingP0Kind: analyzed.intent.kind,
            understandingRegex: goalNeedsUnderstanding,
            intentSource: analyzed.intentSource,
            expectsViolations: expectsViolations.length,
          });
        }

        if (isArbiterAuthoritative(arbiterMode)) {
          if (adds.length) nudges.push(...adds);

          if (decision.halt) {
            const haltKey = failureTargetKey("action", `arbiter-halt:${decision.reason.slice(0, 80)}`);
            const haltRecord = failureLedger.record({
              targetKey: haltKey,
              actionName: "arbiter_halt",
              kind: "unsupported",
              evidence: { reason: decision.reason, mode: arbiterMode },
            });
            doneSummary = decision.halt.summary;
            if (haltRecord.escalate) {
              doneSummary = `${doneSummary}\n${haltRecord.escalateHint}`;
            }
            finished = true;
            doneSuccess = decision.halt.success;
            deps.logger.agentProgress(`Arbiter 硬停生效（${arbiterMode}）：${decision.reason}`, {
              step,
              phase: arbiterMode === "hard" ? "arbiter_active" : "arbiter_guide",
              halt: true,
              ledgerAttempts: haltRecord.attempts,
            });
            // 硬闸：本步不再执行任何危险 action
            break;
          }

          // Expects 本步已强制 replan 时不叠一次 Consult（下一步矛盾仍会再问或回落 HITL）。
          if (escalateIntent && !expectsSkipLlm) {
            const violations = decision.escalate?.violations ?? expectsViolations;
            const canConsult = consultAvailable && decision.escalate?.route === "plan_conflict";
            const consulted = canConsult
              ? await consultPlanConflict(
                  {
                    goal: deps.goal,
                    step: messageManager.currentPlanText() ?? "",
                    url: pageUrl,
                    facts: violations.length ? violations : [decision.reason],
                  },
                  {
                    aiSettings: deps.aiSettings,
                    logger: deps.logger,
                    signal: deps.signal,
                    budget: consultBudget,
                  },
                )
              : null;

            if (consulted?.ok && !consulted.conflict) {
              const clearNudge = consultClearNudge(consulted.reason);
              if (!nudges.includes(clearNudge)) nudges.push(clearNudge);
              deps.logger.agentProgress("Consult 核对：计划与页面事实无实质冲突", {
                step,
                phase: "consult_plan_conflict",
                conflict: false,
                fallback: false,
              });
            } else {
              const revised = consulted?.ok && consulted.conflict ? consulted : null;
              if (revised) {
                const revNudge = consultRevisionNudge(revised.revisedStep, revised.reason);
                if (!nudges.includes(revNudge)) nudges.push(revNudge);
                deps.logger.agentProgress(
                  `Consult 计划矛盾：改为「${revised.revisedStep}」`.slice(0, 200),
                  {
                    step,
                    phase: "consult_plan_conflict",
                    conflict: true,
                    fallback: false,
                  },
                );
              } else {
                const hitlNudge = consulted
                  ? arbiterConsultFailedHitlNudge(decision.reason, violations)
                  : arbiterEscalateHitlNudge(decision.reason, violations);
                if (!nudges.includes(hitlNudge)) nudges.push(hitlNudge);
                deps.logger.agentProgress(
                  consulted
                    ? `Consult 失败，回落 HITL · ${consulted.reason}`.slice(0, 200)
                    : "Consult 未就绪，计划矛盾回落 HITL",
                  {
                    step,
                    phase: "consult_plan_conflict",
                    fallback: "hitl",
                    reason: consulted && !consulted.ok ? consulted.reason.slice(0, 180) : "unavailable",
                  },
                );
              }

              const escKey = failureTargetKey("action", `arbiter-escalate:${decision.reason.slice(0, 80)}`);
              const escRecord = failureLedger.record({
                targetKey: escKey,
                actionName: "arbiter_escalate",
                kind: "no-effect",
                evidence: { reason: decision.reason, violations, mode: arbiterMode },
              });

              if (arbiterMode === "hard") {
                const replanned = await reviseRemainingPlan(
                  revised
                    ? [revised.revisedStep, ...violations].slice(0, 4)
                    : violations.length
                      ? violations
                      : [decision.reason],
                  revised
                    ? `Consult 判定计划矛盾，按修订步重规划 · ${revised.reason}`
                    : `Arbiter 硬闸：计划矛盾，强制重规划 · ${decision.reason}`,
                );
                if (revised && !replanned) {
                  const failedNudge = arbiterConsultFailedHitlNudge(decision.reason, violations);
                  if (!nudges.includes(failedNudge)) nudges.push(failedNudge);
                  deps.logger.agentProgress("Consult 修订后重规划未果，回落 HITL", {
                    step,
                    phase: "consult_plan_conflict",
                    fallback: "hitl",
                    reason: "replan_failed",
                  });
                }
                arbiterSkipLlm = true;
                deps.logger.agentProgress(
                  replanned
                    ? `Arbiter 硬闸：已重规划，跳过本步动作`
                    : `Arbiter 硬闸：重规划未果，跳过本步动作并保留 HITL 引导`,
                  {
                    step,
                    phase: "arbiter_active",
                    escalate: true,
                    replanned,
                    ledgerAttempts: escRecord.attempts,
                  },
                );
              } else if (escRecord.escalate) {
                nudges.push(
                  `<sys>Arbiter：同一计划矛盾已累计 ${escRecord.attempts} 次。${escRecord.escalateHint} 优先 ask_user 或 handover_to_human。</sys>`,
                );
              }
            }
          }
        }
      } catch (err) {
        arbiterShadow.failures += 1;
        // shadow 必须 fail-open；权威模式同样不因裁决器异常拖垮任务
        deps.logger.agentProgress(
          `Arbiter 裁决异常（已忽略，不影响任务）· ${
            err instanceof Error ? err.message : String(err)
          }`.slice(0, 200),
          { step, phase: arbiterMode === "shadow" ? "arbiter_shadow" : "arbiter_guide", error: true },
        );
      }

      if (arbiterSkipLlm || expectsSkipLlm) {
        forceObserveNext = true;
        lastStepExecutedActions = false;
        lastHadError = false;
        continue;
      }

      const personaHint = taskRules?.persona
        ? "\n（本任务已指定人设：被固定的字段必须原样使用、不得改写；其余必填项现生成，与 GeoIP 同城。资料语种≠UI 语言。）"
        : deps.geoContext
          ? "\n（环境已注入 GeoIP。填表资料按本次种子现生成，与 GeoIP 同城；不要复用以往姓名。资料语种≠UI 语言。）"
          : "\n（填表资料每次现生成，不要复用以往姓名。资料语种≠UI 语言。）";

      const wantVision = visionImages.length > 0;
      if (wantVision) lastVisionObservationStep = step;
      const userMsg = buildUserStateMessage({
        userRequest:
          deps.goal + personaHint + newTabHint + (taskAttachmentText ? `\n\n${taskAttachmentText}` : ""),
        history: messageManager.history,
        compactedMemory: messageManager.compactedMemory,
        fileSystemSummary: fileSystem.summary(),
        todoContents: fileSystem.readTodo(),
        plan: messageManager.plan,
        browser: browserState,
        readState: messageManager.consumeReadState(),
        stepNumber: step,
        maxSteps,
        includeScreenshot: wantVision,
        visionImages,
        nudges,
        taskBrief: buildTaskBriefForStep(),
        taskAttachmentImages:
          step <= ATTACHMENT_IMAGE_STEPS ? taskAttachmentImages : [],
      });

      deps.logger.agentProgress(
        `第 ${step} 步：可见可交互元素 ${browserState.elementCount} 个 | ${browserState.url}`,
        {
          step,
          elements: browserState.elementCount,
        },
      );

      // 本地已够时跳过远端模型：① SERP 总结/验收 ② 空控件时直达搜索 URL
      // 前提：目标确实只有「打开/搜索」这一件事（含后续交付动作时不跳过，见 deterministic.ts）
      const autoDone = captchaGate.interstitial
        ? null
        : tryDeterministicDone({
            goal: deps.goal,
            queryTerms: analyzed.queryTerms,
            plan: messageManager.plan,
            pageUrl,
            pageDigest: browserState.pageDigest,
            goalNeedsUnderstanding,
            planNeedsUnderstanding,
            elementCount: browserState.elementCount,
            navigationTargets: analyzed.navigationTargets,
          });
      if (
        !autoDone &&
        !deterministicDoneBlockedLogged &&
        pageKind.serpLike &&
        (goalNeedsUnderstanding || planNeedsUnderstanding)
      ) {
        deterministicDoneBlockedLogged = true;
        deps.logger.agentProgress(
          "本地 SERP 就绪，但目标要总结/分析/探讨 → 不本地粘贴页面原文，交回模型写结论",
          { step, skippedLocalDone: true, reason: "goal_needs_understanding" },
        );
      } else if (
        !autoDone &&
        !deterministicDoneBlockedLogged &&
        pageKind.serpLike &&
        goalHasFollowupDeliverable(deps.goal)
      ) {
        // 只报一次：让用户看得见「为什么这次没有本地收尾」——目标里还有后续交付动作
        deterministicDoneBlockedLogged = true;
        deps.logger.agentProgress(
          "本地 SERP 就绪，但目标还有打开/搜索之外的交付动作 → 不本地收尾，交回模型继续推进",
          { step, skippedLocalDone: true, reason: "goal_has_followup_deliverable" },
        );
      }
      const autoNavDone =
        !autoDone && !captchaGate.interstitial
          ? tryDeterministicNavigationDone({
              goal: deps.goal,
              queryTerms: analyzed.queryTerms,
              plan: messageManager.plan,
              pageUrl,
              pageDigest: browserState.pageDigest,
              goalNeedsUnderstanding,
              planNeedsUnderstanding,
              elementCount: browserState.elementCount,
              navigationTargets: analyzed.navigationTargets,
            })
          : null;
      const autoSearch =
        !autoDone && !autoNavDone && !captchaGate.interstitial
          ? tryDeterministicEngineHome({
              goal: deps.goal,
              queryTerms: analyzed.queryTerms,
              plan: messageManager.plan,
              pageUrl,
              pageDigest: browserState.pageDigest,
              goalNeedsUnderstanding,
              planNeedsUnderstanding,
              elementCount: browserState.elementCount,
              navigationTargets: analyzed.navigationTargets,
            })
          : null;

      let output: AgentOutput;
      if (autoDone) {
        deps.logger.agentProgress(
          `第 ${step} 步：本地已验收（跳过模型）· ${autoDone.memory?.slice(0, 80) ?? "done"}`,
          { step, skippedLlm: true, reason: "deterministic_serp_done" },
        );
        output = autoDone;
        if (pack) {
          disposeObservation(pack);
          previousObservation = null;
        }
      } else if (autoNavDone) {
        deps.logger.agentProgress(
          `第 ${step} 步：纯导航目标已到达，本地收尾（跳过模型）· ${pageUrl}`,
          { step, skippedLlm: true, reason: "deterministic_navigation_done" },
        );
        output = autoNavDone;
        if (pack) {
          disposeObservation(pack);
          previousObservation = null;
        }
      } else if (autoSearch) {
        deps.logger.agentProgress(
          `第 ${step} 步：本地直达搜索（跳过模型）· ${analyzed.queryTerms[0] ?? ""}`,
          { step, skippedLlm: true, reason: "deterministic_search_navigate" },
        );
        output = autoSearch;
        if (pack) {
          disposeObservation(pack);
          previousObservation = null;
        }
      } else {
        const messages: ChatCompletionMessageParam[] = [
          { role: "system", content: systemPrompt },
          buildLlmUserContent(userMsg.text, userMsg.images),
        ];
        const digestReadyForFast =
          Boolean(browserState.pageDigest?.trim()) &&
          pageKind.serpLike &&
          queryMatchedOnPage(
            analyzed.queryTerms,
            browserState.pageDigest ?? "",
            pageUrl,
          );
        const simpleTask =
          isSimpleAgentTask(deps.goal, analyzed.queryTerms) || digestReadyForFast;
        try {
          deps.logger.agentProgress(
            `第 ${step} 步：等待模型决策…（${simpleTask ? "快模" : "逻辑模"}·全部工具）`,
            { step, simpleTask },
          );
          if (pack) assertObservationReady(pack);
          output = await callAgentLlm({
            deps,
            router,
            messages,
            settings,
            signal: deps.signal,
            intent: simpleTask && !wantVision ? "fast_text" : "logic",
            onWaitTick: (elapsedMs) => {
              deps.logger.agentProgress(
                `第 ${step} 步：仍在等待模型…已 ${Math.round(elapsedMs / 1000)}s`,
                { step, elapsedMs },
              );
            },
          });
        } catch (err) {
          messageManager.recordFailure();
          lastHadError = true;
          forceObserveNext = true;
          const msg = err instanceof Error ? err.message : String(err);
          deps.logger.agentProgress(`第 ${step} 步：模型输出解析失败 — ${msg}`, {
            error: msg,
          });
          if (messageManager.consecutiveFailureCount >= settings.maxFailures) {
            doneSummary = `LLM 连续失败: ${msg}`;
            finished = true;
            doneSuccess = false;
            break;
          }
          continue;
        } finally {
          if (pack) {
            disposeObservation(pack);
            previousObservation = null;
          }
        }
      }

      if (output.thinking) {
        deps.logger.agentProgress(`思考：${output.thinking.slice(0, 240)}`, {
          thinking: output.thinking.slice(0, 500),
        });
      }
      if (output.next_goal) {
        deps.logger.agentProgress(`下一步目标：${output.next_goal}`, {});
      }

      let actions = output.action.slice(0, settings.maxActionsPerStep);
      if (actions.some((a) => a.name === "done") && actions.length > 1) {
        const onlyDone = actions.filter((a) => a.name === "done");
        actions.length = 0;
        actions.push(...onlyDone.slice(0, 1));
      }

      // 计划修正拦截（Phase 3.2）：`update_plan` 不改浏览器，只改"账本"。
      // 在这里把它转写成 `output.plan_update` / `output.current_plan_item`，
      // 于是落账仍然只有 MessageManager.applyPlanUpdate **一条**写路径（不新增第二个写者）。
      // 必须放在验证码闸门之前：闸门会把本步动作整段替换成 solve_captcha，
      // 若放在它后面，一次正在求解验证码的步骤里给出的计划修正会被无声吞掉。
      const planScan = scanPlanCommands(actions);
      if (planScan.command || planScan.errors.length) {
        if (planScan.command) {
          const { steps, currentIndex } = planScan.command;
          const withExpects = steps.filter((step) => step.expects).length;
          // 注意：**不推进** current_plan_item 之外的状态 —— plan_update 是整表替换，
          // applyPlanUpdate 会按 currentIndex 重算全部状态（与模型直接发 plan_update 完全同路）。
          output = {
            ...output,
            plan_update: steps,
            ...(currentIndex == null ? {} : { current_plan_item: currentIndex }),
          };
          deps.logger.agentProgress(
            `模型修正计划：${steps.length} 项（${withExpects} 项带期望）` +
              (currentIndex == null ? "" : `，当前项 #${currentIndex}`),
            {
              step,
              phase: "plan",
              steps: steps.map((s) => s.text),
              expects: withExpects,
              currentIndex,
              // 被本地丢弃的期望 token（自由文本/假 role）：留痕，避免"判据被清空"这件事静默消失
              expectsDropped: planScan.dropped,
            },
          );
          // 计划刚被改写，下一步必须**重新看真实页面**再动手：
          // 否则模型可能拿着改写前的观察结果去执行改写后的计划项（对着旧 index 点新目标）。
          forceObserveNext = true;
        }
        for (const err of planScan.errors) {
          // 读不通就**明确回敬**：半份计划比没有计划更危险（会让已完成步骤被重做），所以整份拒绝
          deps.logger.agentProgress(`计划修正被拒绝：${err}`, { step, phase: "plan", rejected: true });
        }
      }

      // 验证码闸门拦截：整页就是一道人机验证时，navigate / done / 重复提交都不可能成功 ——
      // 运行期直接把本步收敛为 solve_captcha（可自动求解时）；无法求解则显式转人工。
      // 这与用户目标措辞无关，因此任何任务遇到验证码都走同一条路。
      if (captchaGate.interstitial) {
        const alreadySolving = actions.some(
          (a) => CAPTCHA_ACTION_NAMES.has(a.name) || a.name === "handover_to_human" || a.name === "ask_user",
        );
        const honestFailure = actions.some((a) => a.name === "done" && a.params?.success === false);
        if (!alreadySolving && !honestFailure && captchaGate.strategy) {
          deps.logger.agentProgress(
            `验证码闸门：拦截本步动作（${actions.map((a) => a.name).join(" → ") || "空"}），强制 solve_captcha`,
            { step, phase: "captcha_gate", blocked: actions.map((a) => a.name) },
          );
          actions = [{ name: "solve_captcha", params: {} }];
          output = { ...output, action: actions };
          forceObserveNext = true;
        } else if (!alreadySolving && !honestFailure && !captchaGate.strategy && captchaGateStreak >= CAPTCHA_GATE_MAX) {
          const reason = captchaGate.nonImage
            ? `页面需要人工验证码（短信/邮箱/验证器动态码），连续 ${captchaGateStreak} 步未取得，需人工处理`
            : `当前页面的人机验证类型无法自动求解（连续 ${captchaGateStreak} 步），需人工处理`;
          deps.logger.agentProgress(`验证码闸门转人工：${reason}`, {
            step,
            phase: "captcha_gate",
            streak: captchaGateStreak,
            nonImage: captchaGate.nonImage,
          });
          try {
            const gateUrl = activePage.url();
            const ai_copy = await resolveHitlAiCopy({
              channel: "handover",
              goal: deps.goal,
              url: gateUrl,
              pageTitle: browserState?.title,
              pageKind: pageKind?.kind,
              elements: elementsFromSelectorMap(browserState?.selectorMap),
              captchaAttempts: getCaptchaAttempts(activePage),
              rawHint: reason,
              userAction: captchaGate.nonImage ? "enter_code" : "complete_challenge",
              failureReason: captchaGate.nonImage ? "otp_human_required" : "captcha_attempts_exhausted",
              aiSettings: deps.aiSettings,
              signal: deps.signal,
            });
            const handoverReq = {
              requestId: `captcha-gate-${profileId}-${Date.now()}`,
              url: gateUrl,
              reason,
              ai_copy,
            };
            deps.logger.agentHandoverRequired({
              ...handoverReq,
              profileId,
              phase: "hitl_ai_copy",
            });
            await deps.requestHandover(handoverReq);
          } catch {
            /* 交人失败则直接以失败收尾，避免死循环 */
          }
          doneSummary = `${reason}，已转人工。`;
          doneSuccess = false;
          finished = true;
          break;
        }
      }

      // 软门禁：应交互却乱 navigate → 保留但追加 nudge 记入下一步（本步仍执行，由模型自纠）
      if (
        planText &&
        /输入|搜索框|找|点击/.test(planText) &&
        actions.every((a) => a.name === "navigate")
      ) {
        deps.logger.agentProgress(
          `计划纠偏提示：当前项「${planText}」却全是 navigate，建议改为找框/输入`,
          { planItem: planText },
        );
        forceObserveNext = true;
      }

      deps.logger.agentProgress(
        `执行动作：${actions.map((a) => a.name).join(" → ") || "(空)"}`,
        { actions: actions.map((a) => a.name) },
      );

      // P4.5：暂停后不继续 multi_act；继续后从观察步恢复（丢弃本步已决策动作）
      if (deps.awaitUserPauseGate && (await deps.awaitUserPauseGate())) {
        forceObserveNext = true;
        continue;
      }

      /*
       * 本步动作**开始前**的 URL。
       *
       * 记账里有两处需要它当基准，而它们都只能在动作**之前**取值：
       *   · 「填写发生在哪一页」（lastFillUrl）—— 用动作后的 URL 会让同批跳转自我抵消；
       *   · 「本步是否把页面带离了原地址」（submitted 判据）。
       * 注意必须在 multiAct 之前取：这是本步唯一还能观察到"动作前"的时刻。
       */
      const stepStartUrl = activePage.url();

      messageManager.recordActions(actions);

      // 多标签页预检：点击/提交常把流程丢进新标签（第三方登录、支付、验证码）。
      // id 是按「页序号」生成的，新页永远追加在末尾，所以只比较数量即可拿到新增标签。
      const tabCountBefore = countLivePages(activePage);

      const results = await multiAct(actions, {
        page: activePage,
        logger: deps.logger,
        aiSettings: deps.aiSettings,
        browserState,
        fileSystem,
        profileId,
        goal: deps.goal,
        step,
        requestConfirm: async (req) => {
          markHitl();
          const ai_copy =
            req.ai_copy ??
            (await resolveHitlAiCopy({
              channel: "confirm",
              goal: deps.goal,
              url: req.url,
              pageTitle: browserState?.title,
              pageKind: pageKind.kind,
              elements: elementsFromSelectorMap(browserState?.selectorMap),
              captchaAttempts: getCaptchaAttempts(activePage),
              rawHint: req.reason,
              aiSettings: deps.aiSettings,
              signal: deps.signal,
            }));
          const enriched = { ...req, ai_copy };
          const shot = pickHitlScreenshot(browserState);
          deps.logger.agentConfirmRequired({
            requestId: enriched.requestId,
            url: enriched.url,
            reason: enriched.reason,
            actions: enriched.actions,
            ai_copy,
            profileId,
            phase: "hitl_ai_copy",
            ...(shot ? { screenshotBase64: shot } : {}),
          });
          return deps.requestConfirm(enriched);
        },
        askUser: async (requestId, question, meta) => {
          markHitl();
          noteThought(`HITL ask_user：${String(question ?? "").slice(0, 120)}`);
          return deps.askUser(requestId, question, meta);
        },
        requestHandover: async (req) => {
          markHitl();
          noteThought(`HITL handover：${String(req.reason ?? "").slice(0, 120)}`);
          const ai_copy =
            req.ai_copy ??
            (await resolveHitlAiCopy({
              channel: "handover",
              goal: deps.goal,
              url: req.url,
              pageTitle: browserState?.title,
              pageKind: pageKind.kind,
              elements: elementsFromSelectorMap(browserState?.selectorMap),
              captchaAttempts: getCaptchaAttempts(activePage),
              rawHint: req.reason,
              aiSettings: deps.aiSettings,
              signal: deps.signal,
            }));
          const enriched = { ...req, ai_copy };
          const shot = pickHitlScreenshot(browserState);
          deps.logger.agentHandoverRequired({
            requestId: enriched.requestId,
            url: enriched.url,
            reason: enriched.reason,
            ai_copy,
            profileId,
            phase: "hitl_ai_copy",
            ...(shot ? { screenshotBase64: shot } : {}),
          });
          await deps.requestHandover(enriched);
        },
        setIncludeScreenshotNext: (v) => {
          includeScreenshotNext = v;
        },
        setActivePage: bindActivePage,
        gatewayFor: gatewayForPage,
        hostRequest,
        resolveElement: (index) => browserState?.selectorMap.get(index) ?? null,
        signal: deps.signal,
        evidence: evidenceLedger,
        deliverables: deliverableLedger,
        artifacts,
        failures: failureLedger,
        taskPolicy,
        otpChannel: deps.otpChannel,
        resolveOtpSecret: deps.resolveOtpSecret,
        otpMailTransport: deps.otpMailTransport,
        smsOtpService: deps.smsOtpService,
        resolveSmsOtpSecret: deps.resolveSmsOtpSecret,
        captchaService: deps.captchaService,
        resolveCaptchaSecret: deps.resolveCaptchaSecret,
        // 用户自定义规则运行态：done 闸门（actions.done）与主循环巡检共用同一份命中记录
        taskRules,
        // 本步页面事实：当前页是否就是任务检索词的结果页（done 闸门的 submitted 核销要用）
        pageFacts: { serpForQuery: pageKind.serpLike && queryMatched },
        // 每步一次的「视觉找回」预算：index 失效时用来把目标从画面上找回来，用尽即回到普通失败
        relocationBudget: { left: VISION_RELOCATE_MAX_PER_STEP },
        screenshotAfterMutation: () =>
          lastVisionObservationStep >= 0 && lastVisionObservationStep > evidenceLedger.lastMutationStep,
      });

      for (const r of results) {
        if (r.error) {
          deps.logger.agentProgress(`动作失败：${r.error}`, { error: r.error });
        } else if (r.extractedContent) {
          // UI 进度只展示短摘要：技能全文 / 长 dump 进 read_state，勿把「禁止 ask_user」等教条刷成「等待补充」
          const dump = r.extractedContent;
          const mem = (r.longTermMemory || "").trim();
          const progressBody =
            mem &&
            dump.length > 240 &&
            mem.length < dump.length &&
            (mem.length <= 240 || /^#\s*Skill:|^\{/.test(dump.trim()))
              ? mem
              : dump;
          // done 的正文就是交付物：监视器卡片可折叠，但必须拿到全文，不能被 200 字砍掉尾巴
          if (r.isDone) {
            deps.logger.agentProgress(`动作结果：${progressBody}`, { preserveFull: true });
          } else {
            deps.logger.agentProgress(`动作结果：${progressBody.slice(0, 200)}`, {});
          }
        }
      }

      messageManager.appendStep(output, results);
      if (activeMacroPlan) {
        const curIdx = messageManager.plan.findIndex((p) => p.status === "current");
        const idx = curIdx >= 0 ? curIdx : 0;
        if (idx !== lastMacroPlanIndex) {
          lastMacroPlanIndex = idx;
          persistMacroArtifacts(activeMacroPlan, idx, `subtask_switch:${idx}`);
          deps.logger.agentProgress(
            `SubTask 切换 → #${idx + 1} ${messageManager.currentPlanText() ?? ""}`.slice(0, 160),
            { step, phase: "checkpoint", planIndex: idx },
          );
        }
      }
      bindActivePage(pickLivePage(activePage));

      // 新增标签页必须显式告知：新页不会自己进观察范围，模型会在旧页上反复空转。
      popupNudges = await describeOpenedTabs(activePage, tabCountBefore);

      // 完成度证据记账：只记录「可验证的副作用」，供 done 验收使用
      recordStepEvidence(evidenceLedger, {
        step,
        actionNames: actions.map((a) => a.name),
        results: results.map((r) => ({
          error: r.error ?? null,
          metadata: (r.metadata ?? null) as Record<string, unknown> | null,
          extractedContent: r.extractedContent ?? null,
        })),
        url: activePage.url(),
        // 提交类核销的基准：必须在动作前取（见 stepStartUrl 的注释）
        stepStartUrl,
        // 观测里的截图必须发生在「最近一次状态变更之前」才算「看过结果」
        screenshotTaken:
          lastVisionObservationStep >= 0 && lastVisionObservationStep > evidenceLedger.lastMutationStep,
        pageDigestChars: browserState?.pageDigest?.length ?? 0,
      });

      // 契约逐项核销：每步都用**确定性验证器**过一遍剩余交付物，
      // 已完成的当场勾掉（下一轮提示词里的清单会同步变短），done 时只剩真正没做的项。
      recordDeliverableProgress({
        ledger: deliverableLedger,
        evidence: evidenceLedger,
        artifacts,
        step,
        goal: deps.goal,
        url: activePage.url(),
        stepStartUrl,
        stepActionNames: actions.map((a) => a.name),
        // 当前页就是本次检索词的结果页（主循环本步已算出的两项事实，零成本）
        serpForQuery: pageKind.serpLike && queryMatched,
        // 这些「可见文案」是**上一轮观察**的产物；页面若已被本步动作带走，它们就属于旧页面
        observedUrl: pageUrl,
        title: browserState?.title,
        visibleLabels: [...(browserState?.selectorMap?.values() ?? [])]
          .map((el) => String(el.text ?? "").trim())
          .filter(Boolean)
          .slice(0, 120),
        logger: deps.logger,
      });

      // 用户自定义规则巡检：DOM 规则每步核对；命中「完成条件 + 命中即完成」时主动收尾。
      // 图片类规则按预算抽样（每任务默认 8 次），避免把模型调用烧穿；
      // done 时另有独立硬校验（见 actions 的 done 闸门），两处共用同一份命中记录。
      if (taskRules) {
        try {
          const stepRules = await evaluateTaskRules(taskRules, {
            page: activePage,
            aiSettings: deps.aiSettings,
            step,
            signal: deps.signal,
            allowVision:
              taskRules.visionBudget > 0 &&
              taskRules.rules.some((rule) => rule.kind === "vision"),
          });
          for (const hit of stepRules.newlyHit) {
            deps.logger.agentProgress(
              `规则命中 · ${hit.rule.title}：${hit.detail}`.slice(0, 200),
              {
                step,
                phase: "task_rule_hit",
                ruleId: hit.rule.id,
                ruleRole: hit.rule.role,
              },
            );
            // B3：人工介入时机命中 → 真的弹介入中心确认（每规则一次，同意继续 / 拒绝中止）。
            if (hit.rule.role === "hitl" && shouldFireTaskRuleHitl(taskRules, hit.rule.id)) {
              const approved = await confirmTaskRuleHitl(hit.rule, hit.detail, browserState);
              deps.logger.agentProgress(
                `人工介入规则「${hit.rule.title}」${approved ? "已确认，继续" : "被拒绝，中止本次任务"}：${hit.detail}`.slice(
                  0,
                  220,
                ),
                { step, phase: "task_rule_hitl", ruleId: hit.rule.id, approved },
              );
              if (!approved) {
                doneSuccess = false;
                doneSummary = `用户规则「${hit.rule.title}」要求人工确认，但被拒绝，已中止任务。`;
                finished = true;
                break;
              }
            }
          }
          // A2：把「无法判定」的完成条件/步骤判据显式记下来（不谎报为「未出现」），每规则只记一次。
          for (const [ruleId, reason] of stepRules.inconclusive) {
            if (loggedInconclusive.has(ruleId)) continue;
            const rule = taskRules.rules.find((item) => item.id === ruleId);
            if (!rule || (rule.role !== "complete" && rule.flowStep == null)) continue;
            loggedInconclusive.add(ruleId);
            deps.logger.agentProgress(
              `规则「${rule.title}」本轮无法判定（不谎报为未命中）：${reason}`.slice(0, 220),
              { step, phase: "task_rule_inconclusive", ruleId },
            );
          }
          if (!finished && stepRules.autoCompleted) {
            const { rule, detail } = stepRules.autoCompleted;
            /*
             * 红线闸门（R1 / 一次性凭证）：用户规则命中**不能**绕过支付与凭证判据。
             * 典型反例：用户把「出现『下单成功』」写成命中即完成的规则 —— 那只是「已下单」，
             * 不是「已付款」。被拦下时不收尾，任务继续走正常流程（模型会 ask_user / handover）。
             *
             * A7：元素快照缺失 = 无法确认页面上是否还有空的一次性凭证 → 按 fail-closed 处理
             * （宁可拦下收尾，也不把「看不到」当成「没有」）。
             */
            const credentialSnapshot = browserState?.selectorMap
              ? [...browserState.selectorMap.values()]
              : null;
            const credentialProbeFailed = credentialSnapshot == null;
            const hasPendingCredential = credentialProbeFailed
              ? true
              : findPendingHumanCredentials(credentialSnapshot).length > 0;
            if (credentialProbeFailed) {
              deps.logger.agentProgress(
                "无法读取页面元素快照，不能确认是否还有待填的一次性凭证 —— 按 fail-closed 拦下自动收尾",
                { step, phase: "task_rule_credential_probe_failed", ruleId: rule.id },
              );
            }
            const blocked = blocksRuleAutoComplete({
              goal: deps.goal,
              lexicon: loadCompletionLexicon(),
              humanPaymentConfirmed: evidenceLedger.humanPaymentConfirmed === true,
              hasPendingCredential,
            });
            if (blocked) {
              // 命中记录保留（不再重复判定），但不收尾：把决定权交回模型与人工。
              // 这里只是清掉「本轮收尾意图」，命中记录仍在 —— 后续步骤若红线解除（如人工确认支付）
              // 会由 evaluateTaskRules 从 hits 重新推导 autoCompleted，不会永久失效。
              taskRules.completedByRule = null;
              if (!blockedAutoCompleteLogged.has(rule.id)) {
                blockedAutoCompleteLogged.add(rule.id);
                deps.logger.agentProgress(
                  `规则「${rule.title}」已命中，但不允许自动收尾：${blocked}`.slice(0, 220),
                  { step, phase: "task_rule_complete_blocked", ruleId: rule.id },
                );
              }
            } else {
              /*
               * A1：红线通过后，**还要过同一份用户硬约束**（strict 完成条件 / must_click 点击台账 /
               * fixed_data 钉值）。否则用户配「规则 A 命中即完成 + 规则 B 必须严格核对」时，
               * A 一命中就收尾、B 从未核对 —— 这是「做完的一方自己判定成功」。
               */
              let violation: TaskRuleConstraintViolation | null = null;
              try {
                violation = await guardUserConstraints(taskRules, {
                  page: activePage,
                  aiSettings: deps.aiSettings,
                  step,
                  signal: deps.signal,
                  allowVision: true,
                });
              } catch (error) {
                // 核对本身失败 → 视为不满足（fail-closed），绝不因异常放行收尾。
                violation = {
                  reason: `用户硬约束核对失败：${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  ruleIds: [],
                  inconclusiveRuleIds: [],
                  kinds: { strict: false, mustClick: false, fixedData: false, truncatedFlow: false },
                };
              }
              if (violation) {
                taskRules.completedByRule = null;
                if (!blockedAutoCompleteLogged.has(rule.id)) {
                  blockedAutoCompleteLogged.add(rule.id);
                  deps.logger.agentProgress(
                    `规则「${rule.title}」已命中，但不允许自动收尾：${violation.reason}`.slice(0, 240),
                    {
                      step,
                      phase: "task_rule_complete_blocked",
                      ruleId: rule.id,
                      ruleIds: violation.ruleIds,
                      inconclusiveRuleIds: violation.inconclusiveRuleIds,
                      kinds: violation.kinds,
                    },
                  );
                  if (violation.inconclusiveRuleIds.length > 0) {
                    deps.logger.agentProgress(
                      "用户规则中有条件无法判定（inconclusive），已按 fail-closed 拦下自动收尾",
                      {
                        step,
                        phase: "task_rule_inconclusive",
                        ruleIds: violation.inconclusiveRuleIds,
                      },
                    );
                  }
                }
              } else {
                doneSuccess = true;
                doneSummary = `用户完成条件已命中：${rule.title}（${detail}）`;
                finished = true;
                deps.logger.agentProgress(doneSummary, {
                  step,
                  phase: "task_rule_complete",
                  ruleId: rule.id,
                });
              }
            }
          }
        } catch (error) {
          deps.logger.agentProgress(
            `规则巡检异常（已忽略，不影响任务）：${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 200),
            { step, phase: "task_rule_check", error: true },
          );
        }
        if (finished) break;
      }

      const hasError = results.some((r) => r.error);
      // 视觉重定位在动作内部刷新过索引空间（旧编号整体作废）：
      // 与「换页 = 换文档」同理，必须强制下一步重新观察，否则模型手里的旧编号会与新映射错位。
      const indexSpaceRefreshed = results.some(
        (r) => (r.metadata as { indexSpaceRefreshed?: boolean } | undefined)?.indexSpaceRefreshed === true,
      );
      lastHadError = hasError;
      // 供下一步骤的期望核对判断「上一步到底有没有真的动过页面」（见 expectsChecked 的声明处）
      lastStepExecutedActions = results.length > 0;
      if (hasError) {
        messageManager.recordFailure();
        forceObserveNext = true;
      } else {
        if (indexSpaceRefreshed) {
          deps.logger.agentProgress(
            "索引空间已刷新（视觉重定位）：下一步将重新观察后重建编号",
            { phase: "vision_relocate" },
          );
          forceObserveNext = true;
          // 换了索引空间 = 换了寻址方言：旧编号的失败账目不再属于新编号指向的元素
          // （例如「index 12 点了三次都撞墙」在新编号里可能是完全另一个控件）
          failureLedger.reset();
        }
        messageManager.recordSuccess();
      }

      // 验证码硬闸：据 solve_captcha 的 machine-readable 元数据计连续失败次数。
      // verified=true 重置；verified=false（含工具硬失败 metadata）满 3 次 → HITL；
      // verified=null（未决）另计，满 4 次同样交人，避免「无信号」被无限重试。
      const captchaResults = results.filter((r) => {
        const m = r.metadata?.captcha as { verified?: boolean | null } | undefined;
        return m != null;
      });
      if (captchaResults.length > 0) {
        const pageUrl = activePage.url();
        if (captchaAttemptUrl != null && captchaAttemptUrl !== pageUrl) {
          consecutiveCaptchaFails = 0;
          ambiguousCaptchaAttempts = 0;
        }
        captchaAttemptUrl = pageUrl;

        const anyPassed = captchaResults.some(
          (r) => (r.metadata?.captcha as { verified?: boolean | null }).verified === true,
        );
        const anyHardFail = captchaResults.some(
          (r) => (r.metadata?.captcha as { verified?: boolean | null }).verified === false,
        );
        /** P5.1：第三方未配置/未知 provider → 立即 Layer 3，勿空转满阈值 */
        const remoteNeedsHitlNow = captchaResults.some((r) => {
          const signal = String(
            (r.metadata?.captcha as { signal?: string } | undefined)?.signal ?? "",
          );
          return signal === "remote_not_configured";
        });
        if (anyPassed) {
          consecutiveCaptchaFails = 0;
          ambiguousCaptchaAttempts = 0;
        } else if (anyHardFail) {
          consecutiveCaptchaFails += 1;
          ambiguousCaptchaAttempts = 0;
        } else {
          ambiguousCaptchaAttempts += 1;
        }

        const hitHardLimit =
          remoteNeedsHitlNow || consecutiveCaptchaFails >= CAPTCHA_MAX_FAILS;
        const hitAmbiguousLimit = ambiguousCaptchaAttempts >= CAPTCHA_MAX_AMBIGUOUS;
        if (hitHardLimit || hitAmbiguousLimit) {
          const reason = remoteNeedsHitlNow
            ? "第三方验证码服务未配置或不可用，需人工完成挑战"
            : hitHardLimit
              ? `验证码连续失败 ${consecutiveCaptchaFails} 次，需人工处理`
              : `验证码连续 ${ambiguousCaptchaAttempts} 次无法判定结果，需人工处理`;
          deps.logger.agentProgress(`验证码硬闸触发：${reason}`, {
            phase: "captcha_gate",
            consecutiveCaptchaFails,
            ambiguousCaptchaAttempts,
            remoteNeedsHitlNow,
          });
          try {
            const gateUrl = activePage.url();
            const ai_copy = await resolveHitlAiCopy({
              channel: "handover",
              goal: deps.goal,
              url: gateUrl,
              pageTitle: browserState?.title,
              pageKind: pageKind?.kind,
              elements: elementsFromSelectorMap(browserState?.selectorMap),
              captchaAttempts: Math.max(
                consecutiveCaptchaFails,
                ambiguousCaptchaAttempts,
                getCaptchaAttempts(activePage),
              ),
              rawHint: reason,
              userAction: "complete_challenge",
              failureReason: hitHardLimit
                ? "captcha_attempts_exhausted"
                : "captcha_ambiguous",
              aiSettings: deps.aiSettings,
              signal: deps.signal,
            });
            const handoverReq = {
              requestId: `captcha-gate-${profileId}-${Date.now()}`,
              url: gateUrl,
              reason,
              ai_copy,
            };
            deps.logger.agentHandoverRequired({
              ...handoverReq,
              profileId,
              phase: "hitl_ai_copy",
            });
            await deps.requestHandover(handoverReq);
          } catch {
            /* 交人失败则直接以失败收尾，避免死循环 */
          }
          doneSummary = `${reason}，已转人工。`;
          doneSuccess = false;
          finished = true;
          break;
        }
      }

      // 导航类动作后必须观察（search 已按宪法封禁，不再列入）
      if (actions.some((a) => a.name === "navigate" || a.name === "go_back")) {
        forceObserveNext = true;
      }

      // 重规划：连续无进展才问 Planner。needs-human 不进这里（换计划变不出验证码）。
      // 「未验证放行但仍有交付物」也算没进展 —— 否则第 3 次 done 会把没做完的任务收掉。
      const pendingNow = listPendingDeliverables(deliverableLedger);
      const doneResult = results.find((r) => r.isDone);
      // 模型明确承认做不到：这是合法收尾，不拿去重规划（重规划是为了「还没试过的路」，不是为了推翻诚实失败）
      if (doneResult?.success === false) {
        doneSummary = doneResult.extractedContent || output.memory || "任务未完成";
        doneSuccess = false;
        finished = true;
        break;
      }
      const forcedIncomplete =
        Boolean(doneResult) &&
        pendingNow.length > 0 &&
        /未验证|未核销交付物/.test(String(doneResult?.extractedContent ?? ""));
      const needsHuman = results.some((result) => {
        const failure = (result.metadata as { failure?: { kind?: string } } | undefined)?.failure;
        return failure?.kind === "needs-human";
      });
      // 自定义下拉、点「继续」这类动作经常先改画面、地址晚一拍才变。
      // 只在即将被当成停滞时多等一下跳转，避免页面已经前进仍记成没进展。
      const mutationNames = new Set(["click", "evaluate", "send_keys", "select_dropdown", "go_back"]);
      const mutationSucceeded = results.some(
        (result, index) => !result.error && mutationNames.has(String(actions[index]?.name ?? "")),
      );
      if (
        mutationSucceeded &&
        replanTracker.consecutiveNoProgress >= Math.max(0, replanBudget.stallSteps - 1)
      ) {
        const beforeUrl = activePage.url();
        try {
          await activePage.waitForURL((next) => next.toString() !== beforeUrl, { timeout: 1_200 });
        } catch {
          /* 仍停在原地址 */
        }
      }
      const replanDecision = observeStepForReplan(
        replanTracker,
        {
          url: activePage.url(),
          pending: pendingNow.length,
          progressFacts: countProgressFacts(evidenceLedger.facts),
          hadError: hasError || forcedIncomplete,
          needsHuman,
        },
        replanBudget,
      );

      if (replanDecision.stop) {
        const missing = pendingNow.map((item) => item.spec.text).join("；") || "无";
        doneSummary = `连续 ${replanTracker.consecutiveNoProgress} 步没有可验证进展，重规划已用完 ${replanTracker.used}/${replanBudget.maxReplans} 次，停止空转。未完成：${missing}`;
        doneSuccess = false;
        finished = true;
        deps.logger.agentProgress(doneSummary, { phase: "replan", stop: true, reason: replanDecision.reason });
        break;
      }

      if (replanDecision.replan) {
        const errors = results
          .map((result) => String(result.error ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        await reviseRemainingPlan(
          errors,
          `连续 ${replanBudget.stallSteps} 步无进展 → 重写剩余计划（第 ${replanTracker.used + 1}/${replanBudget.maxReplans} 次）`,
        );
      }

      if (doneResult && !forcedIncomplete && !replanDecision.replan) {
        const pendingLeft = listPendingDeliverables(deliverableLedger);
        const asked = await judgeTaskComplete({
          goal: deps.goal,
          claim: String(doneResult.extractedContent ?? output.memory ?? ""),
          url: activePage.url(),
          pending: pendingLeft.map((item) => item.spec.text),
          artifacts: artifacts.map((item) => item.name),
          facts: evidenceLedger.facts.slice(-16).map((fact) => `${fact.kind}: ${fact.detail || "-"}`),
          aiSettings: deps.aiSettings,
          signal: deps.signal,
        });
        completionAsked = true;
        const askDecision = decideCompletionAsk({
          outcome: asked.outcome,
          replansUsed: replanTracker.used,
          maxReplans: replanBudget.maxReplans,
        });
        deps.logger.agentProgress(`完成度询问：${asked.outcome}${asked.reason ? ` · ${asked.reason.slice(0, 140)}` : ""}`, {
          phase: "completion_ask",
          outcome: asked.outcome,
        });
        if (askDecision.replan) {
          await reviseRemainingPlan(
            [`完成度询问判定未完成：${asked.reason || "目标里还有未完成项"}`],
            `完成度询问未通过 → 重写剩余计划（第 ${replanTracker.used + 1}/${replanBudget.maxReplans} 次）`,
          );
        } else if (askDecision.stop) {
          doneSummary = `完成度询问未通过，且重规划已用完 ${replanTracker.used}/${replanBudget.maxReplans} 次：${asked.reason || "目标未完成"}`;
          doneSuccess = false;
          finished = true;
          break;
        } else {
          doneSummary = doneResult.extractedContent || output.memory || "任务结束";
          if (asked.reason) doneSummary = `${doneSummary}\n[完成度询问] ${asked.reason}`;
          doneSuccess = true;
          finished = true;
          break;
        }
      }
      if (forcedIncomplete && !replanNotice) {
        replanNotice = "done 被标成未验证，但交付物还没核销。不要再 done，先完成清单里剩下的项。";
        deps.logger.agentProgress("done 未验证且交付物未齐 → 不收尾，继续执行", {
          phase: "replan",
          pending: pendingNow.map((item) => item.spec.id),
        });
      }
    }
  });

  if (!finished) {
    doneSummary = doneSummary || "达到最大步数，任务未显式 done";
    doneSuccess = false;
  }

  if (settings.useJudge && messageManager.history.length > 0 && !completionAsked) {
    if (
      shouldSkipJudge({
        successClaimed: doneSuccess,
        history: messageManager.history,
        goal: deps.goal,
        finalText: doneSummary,
      })
    ) {
      deps.logger.agentProgress("验收评判：跳过（短轨迹已成功）", {
        phase: "judge",
        skipped: true,
      });
    } else {
      try {
        deps.logger.agentProgress("验收评判中…", { phase: "judge" });
        const judgement = await judgeTrace({
          goal: deps.goal,
          history: messageManager.history,
          finalText: doneSummary,
          successClaimed: doneSuccess,
          aiSettings: deps.aiSettings,
        });
        const passed = judgement.verdict !== false;
        deps.logger.agentProgress(
          passed
            ? `验收评判：通过 · ${(judgement.reasoning || "").slice(0, 120)}`
            : `验收评判：未通过 · ${(judgement.reasoning || judgement.failureReason || "").slice(0, 160)}`,
          {
            phase: "judge",
            verdict: passed,
          },
        );
        if (doneSuccess && judgement.verdict === false) {
          doneSuccess = false;
          doneSummary = `${doneSummary}\n[judge] ${judgement.reasoning}`;
        }
      } catch (err) {
        deps.logger.agentProgress(
          `验收评判：跳过（超时或失败）· ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            200,
          ),
          { phase: "judge", error: true },
        );
      }
    }
  }

  // 勾选录制且任务成功：经 agentTrajectory → Rust 落库 → 前端「轨迹记忆」
  if (enableRecording) {
    if (!doneSuccess) {
      deps.logger.agentProgress("任务未成功，未写入轨迹记忆", {
        phase: "record",
        skipped: true,
      });
    } else if (recordedSteps.length === 0) {
      deps.logger.agentProgress(
        "录制已开启但无可用步骤（可能均为临时 ID 选择器被过滤）",
        { phase: "record", skipped: true },
      );
    } else {
      try {
        const actions: TrajectoryStep[] = recordedSteps.map((s, i) => ({
          ...s,
          step: i + 1,
        }));
        assertPersistableTrajectorySteps(actions);
        const domainHint =
          actions.find((a) => a.type === "navigate" && a.url)?.url ||
          actions.find((a) => a.url)?.url ||
          startUrl;
        const payload = buildTrajectoryPayload({
          goal: deps.goal,
          startUrl: startUrl || domainHint,
          actions,
          domain: domainFromUrl(domainHint),
        });
        // 先磁盘（强校验）再 DB/事件，避免库里留下不可回放脏数据
        let filePath: string | undefined;
        try {
          filePath = await persistTrajectoryToDisk(payload);
        } catch (diskErr) {
          deps.logger.agentProgress(
            `轨迹磁盘写入失败，仍尝试落库：${
              diskErr instanceof Error ? diskErr.message : String(diskErr)
            }`.slice(0, 180),
            { phase: "record", warn: true },
          );
        }
        deps.logger.agentTrajectory({
          ...payload,
          profileId,
          runId: agentRunId,
          ...(filePath ? { filePath } : {}),
        });
        deps.logger.agentProgress(
          `轨迹已录制 ${actions.length} 步 · ${payload.title}`,
          {
            phase: "record",
            domain: payload.domain,
            steps: actions.length,
            filePath: filePath ?? null,
          },
        );
        noteThought(`轨迹已录制 ${actions.length} 步`);
      } catch (err) {
        deps.logger.agentProgress(
          `轨迹落库失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
          { phase: "record", error: true },
        );
      }
    }
  }

  // 任务结束：Arbiter 累计汇总（shadow 相位名保留便于回归对比）
  if (arbiterShadow.steps > 0) {
    const summaryPhase =
      arbiterMode === "shadow" ? "arbiter_shadow_summary" : "arbiter_summary";
    deps.logger.agentProgress(
      `Arbiter 汇总（${arbiterMode}）：覆盖 ${arbiterShadow.steps} 步 · 会改行为的步数：硬停 ${arbiterShadow.wouldHalt} / 咨询 ${arbiterShadow.wouldEscalate} · 新增引导 ${arbiterShadow.stepsWithAdds} 步 · 理解维度分歧 ${arbiterShadow.understandingDisagreements} 步`,
      {
        phase: summaryPhase,
        mode: arbiterMode,
        ...arbiterShadow,
      },
    );
  }

  if (evidenceLedger.humanInvolved) {
    hitlOccurred = true;
  }
  noteThought(
    doneSuccess
      ? `任务完成：${doneSummary.slice(0, 160)}`
      : `任务结束（未成功）：${doneSummary.slice(0, 160)}`,
  );
  // P4.3：与录制解耦 — 无论是否勾选录制，均强制写入 Run History 摘要
  emitRunFinish({
    success: doneSuccess,
    summary: doneSummary,
  });
  deps.signal?.removeEventListener("abort", onAgentAbort);

  deps.logger.agentState(doneSuccess ? "complete" : "failed", {
    profileId,
    // 终态小结是交付物本身（信息型任务尤其如此），按交付物上限给全，勿按进度行的 500 字砍
    summary: doneSummary.slice(0, AGENT_RUN_SUMMARY_MAX),
    runId: agentRunId,
  });

  return {
    success: doneSuccess,
    summary: doneSummary,
    rounds: messageManager.history.length,
    domain: domainFromUrl(
      (() => {
        try {
          return page.url() || startUrl;
        } catch {
          return startUrl;
        }
      })(),
    ),
    startUrl,
  };
}

/**
 * 全部页面已关闭 / 上下文销毁：Agent 无法继续操作页面。
 * 作为可预期的终止信号抛出，由外层收敛为一次清晰的失败上报；
 * 不再回退返回已关闭的 seed，避免后续 page API 触发难定位的 TargetClosedError。
 */
export class AllPagesClosedError extends Error {
  constructor(message = "所有浏览器页面均已关闭，Agent 终止") {
    super(message);
    this.name = "AllPagesClosedError";
  }
}

export interface DeliverableProgressInput {
  ledger: DeliverableLedger;
  evidence: EvidenceLedger;
  artifacts: ArtifactRecord[];
  step: number;
  goal: string;
  url: string;
  /** 本步动作开始前的 URL（submitted 判据的必需事实） */
  stepStartUrl?: string;
  /** 本步动作名（submitted 判据用它识别"这步到底有没有做过提交"） */
  stepActionNames?: string[];
  /** 当前页是否就是本次检索词的结果页（主循环已算出的事实，submitted 判据） */
  serpForQuery?: boolean;
  /** 上面那些「可见文案」取自哪一页（= 上一轮观察时的 URL）；与当前 URL 不同即视为过期 */
  observedUrl?: string;
  title?: string;
  visibleLabels?: string[];
  logger: JsonLogger;
}

/**
 * 逐步核销契约交付物（只做确定性判定，不花钱）。
 *
 * 为什么要每步核销而不是只在 done 时算：模型需要一个**会变短的清单**。
 * 若清单永远停在初始状态，模型无法判断自己刚做的动作有没有被承认，
 * 就会反复重做同一步（用户报障的「卡在结果页反复 done」正是这种失明的表现）。
 */
export function recordDeliverableProgress(input: DeliverableProgressInput): void {
  const pending = listPendingDeliverables(input.ledger);
  if (pending.length === 0) return;
  const verdicts = verifyDeliverables(
    pending.map((item) => item.spec),
    {
      goal: input.goal,
      ledger: input.evidence,
      currentUrl: input.url,
      currentTitle: input.title,
      visibleLabels: input.visibleLabels,
      artifacts: input.artifacts,
      stepStartUrl: input.stepStartUrl,
      stepActionNames: input.stepActionNames,
      serpForQuery: input.serpForQuery,
      observedUrl: input.observedUrl,
    },
  );
  for (const verdict of verdicts) {
    if (verdict.result.ok !== true) continue;
    const evidence = `${verdict.result.verifier}：${verdict.result.reason}`;
    if (markDeliverableSatisfied(input.ledger, verdict.spec.id, evidence, input.step)) {
      input.logger.agentProgress(`交付物已核销：[${verdict.spec.id}] ${verdict.spec.text}`, {
        phase: "deliverable",
        verifier: verdict.result.verifier,
        reason: verdict.result.reason.slice(0, 160),
      });
    }
  }
}

/**
 * 契约渲染成提示词行：模型每步都能看到「还差哪几项」。
 * 只在有未核销项时注入，避免清单全绿后继续占用上下文。
 */
export function pendingContractLines(ledger: DeliverableLedger): string[] {
  const pending = listPendingDeliverables(ledger);
  if (pending.length === 0) return [];
  return [
    `【交付物台账】还差 ${pending.length} 项（done 会逐项核销，缺项会被驳回）：`,
    ...formatDeliverableLines(ledger),
  ];
}

/**
 * 跟随当前存活页：seed 仍在存活集合中则原样返回，否则取最近打开的一个。
 * 无任何存活页时抛出 {@link AllPagesClosedError}。
 */
function pickLivePage(seed: Page): Page {
  let pages: Page[];
  try {
    pages = seed.context().pages().filter((p) => {
      try {
        return !p.isClosed();
      } catch {
        return false;
      }
    });
  } catch {
    throw new AllPagesClosedError("浏览器上下文已销毁，Agent 终止");
  }
  if (pages.length === 0) {
    throw new AllPagesClosedError();
  }
  return pages.includes(seed) ? seed : pages[pages.length - 1]!;
}

/** 轻量 browser_state：仅 URL/标题，不抽 DOM（bootstrap / 跳过观察） */
async function minimalBrowserState(page: Page): Promise<BrowserStateSummary> {
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }
  const tabs: TabInfo[] = [];
  try {
    tabs.push(...(await listTabs(page)));
  } catch {
    /* ignore */
  }
  return {
    url: page.url(),
    title,
    tabs,
    interactiveTree: "(observation skipped — URL-only state)",
    elementCount: 0,
    selectorMap: new Map(),
    screenshotBase64: null,
    observationError: null,
    pageDigest: null,
  };
}

function goalNeedsPageUnderstanding(goal: string): boolean {
  return /总结|摘要|概括|分析|解读|介绍|是谁|是什么|怎么样|告诉我|详情|内容|汇报|提取信息|读一下|看看|探讨|讨论|点评|评价|评估|综述|梳理|对比一下|讲讲|说说/.test(
    String(goal ?? ""),
  );
}

/** Agent 请求截图却无法落地时的用户可见错误（非站点特例） */
const SCREENSHOT_CAPABILITY_ERROR =
  "需要截图才能继续（图标/图片入口无法仅靠 DOM 文案定位），但当前无法获取页面截图。" +
  "请确认浏览器窗口可用后重试；若仍失败，请到设置中开启 Agent 截图相关能力并配置可用的视觉模型。";

/** 需要视觉定位但未配置 vision 槽 */
const VISION_CAPABILITY_ERROR =
  "当前页面入口多为图标/图片，任务需要视觉定位，但未配置视觉模型（vision）。" +
  "请到「设置 → AI」填写视觉模型后重试。不要用 ask_user 猜测要点哪个图标——下次点任意图片入口同样需要视觉能力。";

function goalNeedsVisualLocate(goal: string): boolean {
  const g = String(goal ?? "");
  return /语言|locale|hebrew|עבר|english|\ben\b|中文|繁體|简体|語系|图标|圖片|图片|截图|点.*图|点击.*图|切换.*语|设置成|改成.*语/i.test(
    g,
  );
}

function pageLooksIconAmbiguous(
  elements: Array<{ text?: string; name?: string; type?: string }>,
): boolean {
  if (!elements.length) return false;
  let vague = 0;
  for (const el of elements) {
    const t = String(el.text || el.name || el.type || "")
      .replace(/\s+/g, " ")
      .trim();
    if (
      !t ||
      t.length <= 2 ||
      /^(button|icon|link|img|image|language|support|icon:)/i.test(t)
    ) {
      vague += 1;
    }
  }
  return vague >= 3 && vague / elements.length >= 0.45;
}

function planItemNeedsPageUnderstanding(planText: string | undefined | null): boolean {
  return /总结|摘要|概括|分析|解读|介绍|提取|阅读|详情|验收|回答|汇报|探讨|讨论|点评|评价|评估|综述|梳理/.test(
    String(planText ?? ""),
  );
}

/** 简单打开/搜索类任务：可用快模。工具列表始终是全部已注册动作。 */
function isSimpleAgentTask(goal: string, queryTerms: string[]): boolean {
  if (/填表|注册|登录|下单|支付|上传|复杂|验证码|captcha|人机验证|match2025|猿人学/i.test(goal)) {
    return false;
  }
  // 要写结论的任务不走「搜到就完」快路径
  if (goalNeedsPageUnderstanding(goal)) return false;
  if (queryTerms.length > 0 && /搜索|百度|谷歌|必应/.test(goal)) return true;
  if (queryTerms.length > 0) return true;
  return /搜索|打开|百度|谷歌|必应|访问|前往/.test(goal) && goal.length < 80;
}

async function safePageDigest(page: Page): Promise<string | null> {
  try {
    const reading = await Promise.race([
      extractPageReading(page),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500)),
    ]);
    if (!reading) return null;
    const text = formatPageReadingForLlm(reading).trim();
    return text ? text.slice(0, 3500) : null;
  } catch {
    return null;
  }
}

function buildLlmUserContent(
  text: string,
  images: string[],
): ChatCompletionMessageParam {
  if (!images.length) {
    return { role: "user", content: text };
  }
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((b64) => ({
        type: "image_url" as const,
        image_url: {
          url: b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`,
          detail: "low" as const,
        },
      })),
    ],
  };
}

async function callAgentLlm(input: {
  deps: AgentLoopDeps;
  router: ReturnType<typeof createModelRouter>;
  messages: ChatCompletionMessageParam[];
  settings: AgentSettings;
  signal?: AbortSignal;
  intent?: "fast_text" | "logic";
  onWaitTick?: (elapsedMs: number) => void;
}): Promise<AgentOutput> {
  const intent = input.intent ?? "logic";
  const resolved = input.router.resolve(intent);
  const model = resolved.model;
  const client = createLlmClient(input.deps.aiSettings);
  const tools = buildRegistryOpenAiTools();

  const wait = beginAgentLlmWait({
    parentSignal: input.signal,
    timeoutMs: intent === "fast_text" ? 35_000 : 60_000,
    tickMs: 5_000,
    onTick: input.onWaitTick,
  });

  /** 统一出口：对 429/5xx/网络抖动做指数退避重试，确定性错误与 abort 立即上抛。 */
  const createCompletion = (body: Record<string, unknown>) =>
    withLlmRetry(
      () => client.chat.completions.create(body as never, { signal: wait.signal }),
      {
        signal: wait.signal,
        onRetry: ({ attempt, delayMs, error }) => {
          input.deps.logger.agentProgress(
            `LLM 瞬时故障，退避重试 #${attempt}（${delayMs}ms）：${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 200),
            { phase: "llm", retry: true, attempt },
          );
        },
      },
    );
  try {
    // 主路径：强制 function calling（与旧天枢台一致，国产模型最稳）
    try {
      const completion = await createCompletion({
        model,
        messages: input.messages,
        tools,
        tool_choice: "required",
        temperature: 0.2,
        ...agentForcedToolRequestPatch(model, input.deps.aiSettings.agentModelDisableThinking),
      });
      const msg = completion.choices[0]?.message;
      const toolCalls = msg?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        return agentOutputFromToolCalls(
          toolCalls.map((tc) => ({
            function: {
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            },
          })),
          typeof msg?.content === "string" ? msg.content : null,
        );
      }
      if (msg?.content) {
        return normalizeAgentOutput(extractJsonObject(String(msg.content)));
      }
      throw new Error("模型未返回 tool_calls 也未返回 JSON");
    } catch (firstErr) {
      // 回退：json_object + 宽松解析 + 一次修复重试
      const schema = agentOutputJsonSchema(input.settings);
      const completion = await createCompletion({
        model,
        messages: [
          ...input.messages,
          {
            role: "system",
            content: `必须输出 JSON，含非空 action 数组。示例：{"memory":"...","next_goal":"...","action":[{"navigate":{"url":"https://example.com"}}]}。若想表达计划，只能把计划正文放进 write_file(plan.json) 的 content，或用 plan_update 字符串数组投影标题；禁止把规划 JSON（subtasks/plan 等）整体当作 action 或整段回复。Schema 意图：${JSON.stringify(schema)}`,
          },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });
      const content = extractAssistantContent(completion);
      try {
        return normalizeAgentOutput(extractJsonObject(content));
      } catch (parseErr) {
        const repair = await createCompletion({
          model,
          messages: [
            {
              role: "system",
              content:
                "把下面内容改成合法 JSON AgentOutput，action 必须是非空数组，每项形如 {\"navigate\":{\"url\":\"...\"}}。若原文是计划（含 subtasks/plan/synthesize），把它放进 action=[{\"write_file\":{\"file_name\":\"plan.json\",\"content\":\"<原文>\"}}]，并用 plan_update 列出子任务标题；不得把计划 JSON 当 action。只输出 JSON。",
            },
            {
              role: "user",
              content: `原始输出：\n${content}\n\n解析错误：${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n首次错误：${firstErr instanceof Error ? firstErr.message : String(firstErr)}`,
            },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        });
        const repaired = extractAssistantContent(repair);
        return normalizeAgentOutput(extractJsonObject(repaired));
      }
    }
  } finally {
    wait.stop();
  }
}
