/**
 * 动态重规划（Dynamic Replan）
 *
 * 背景：执行环以前只会把「上一步失败了」原样塞回模型，计划本身从不改。
 * 于是模型在错误的计划上原地打转 —— 用户日志里「到了搜索结果页就反复 done」就是这样：
 * 计划停在「完成」，失败回执只说「缺证据」，它就再 done 一次。
 *
 * 这里在「连续没有可验证进展」时，单独问一次 Planner（不是执行模型）：
 * 把目标、还没核销的交付物、刚刚的错误、当前页面、以及工具能干什么，一起交出去，
 * 要回一份**只覆盖未完成部分**的新计划。执行环下一轮按新计划走。
 *
 * 预算（与用户约定一致，可用环境变量覆盖）：
 *   - 连续 stallSteps（默认 2）步没有进展才触发，单次失败仍交给失败回执自纠；
 *   - 每任务最多 maxReplans（默认 4）次；
 *   - 单次提问最多 roundsPerReplan（默认 3）轮，解析失败才重问，问到合法计划即停；
 *   - 预算用尽后若仍然连续无进展，**停任务并诚实失败**，不再空转到步数上限。
 *
 * needs-human 不触发重规划：那是「值只在用户手上」，换计划也变不出验证码。
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import { beginAgentLlmWait, createLlmClient, extractAssistantContent } from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import { readAppEnv } from "../app_env.js";
import type { SidecarAiSettings } from "../engine.js";
import type { EvidenceKind } from "../core/completion_evidence.js";
import { extractJsonObject } from "./prompts.js";
import {
  deriveContractFromRules,
  type DeliverableLedger,
} from "./task_contract.js";
import type { PlanItem } from "./views.js";

export interface ReplanBudget {
  /** 每任务最多重规划几次 */
  maxReplans: number;
  /** 单次重规划里，模型答非所问时最多再问几轮 */
  roundsPerReplan: number;
  /** 连续多少步没有可验证进展才触发 */
  stallSteps: number;
}

export interface ReplanTracker {
  used: number;
  consecutiveNoProgress: number;
  lastUrl: string;
  /** -1 = 还没见过任何一步 */
  lastPending: number;
  lastProgressFacts: number;
}

export interface StepSignal {
  url: string;
  /** 仍未核销的必交交付物数量 */
  pending: number;
  /** 可验证进展类事实的累计条数（跳转/回读/勾选/下载/提取） */
  progressFacts: number;
  hadError: boolean;
  /** 本步失败是「必须问人」，不是计划错了 */
  needsHuman: boolean;
}

export interface StepReplanDecision {
  progressed: boolean;
  replan: boolean;
  /** 预算用尽且仍无进展：应停任务，不要再空转 */
  stop: boolean;
  reason: string;
}

const PROGRESS_KINDS = new Set<EvidenceKind>([
  "navigated",
  "navigation_reached",
  "fill_verified",
  "choice_changed",
  "overlay_cleared",
  "content_extracted",
  "file_downloaded",
]);

/** 重规划时给 Planner 的工具清单：只讲「能干什么」，不讲参数细节（那是执行相位的契约） */
export const REPLAN_TOOL_BRIEF = [
  "navigate(url)：打开网址",
  "检索：没有 search 工具。先 navigate 到搜索引擎首页，再 input(index, text) 写入检索词，最后 click 搜索按钮或 send_keys Enter。禁止直接构造 /search?q= 这类结果页地址（会被宪法拦下）",
  "click(index)：点击观察清单里的编号；勾选会回读是否生效",
  "input(index, text)：写入输入框并回读；已填对的不要重写",
  "send_keys(keys)：按键，例如 Enter / Escape",
  "scroll / find_text：把目标滚进视口",
  "switch(tab_id) / close(tab_id)：新开的标签页必须先 switch 过去",
  "search_page / extract：在页内找文本或抽取内容",
  "screenshot / ask_vision_locate(query)：DOM 没有可读文案时靠截图定位",
  "solve_captcha：图形验证码 / 滑块 / 算式 / 点选。也可用 solve_slider_captcha / solve_math_captcha / solve_point_select_captcha / solve_animated_captcha，失败后不要换别名顶次数",
  "restart_browser：关掉当前环境浏览器并用同一端口重新打开。页面会清空，之后必须重新导航",
  "download(ordinal|index|url)：把第 N 张内容图或指定资源保存到下载目录，不要只点击就算下载完成",
  "ask_user / handover_to_human：密码、TOTP、任务没提及的银行卡——任务里已给出的值禁止问人；邮箱码优先 fetch_email_otp；短信码优先 fetch_sms_otp（须显式启用）",
  "fetch_email_otp：已配置 IMAP/临时邮，或设置中显式启用网页邮箱时取邮箱验证码并填入；失败再 ask_user。网页邮箱不是默认路径。禁止自己打开邮箱登录、禁止改指纹、禁止用于短信/TOTP/图形验证码",
  "fetch_sms_otp：已显式启用接码平台时取短信验证码并填入；失败再 ask_user。禁止用于邮箱/TOTP/图形验证码",
  "done(text, success)：全部必交交付物核销之后才允许 success=true",
].join("\n");

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function loadReplanBudget(): ReplanBudget {
  return {
    maxReplans: clampInt(readAppEnv("REPLAN_MAX"), 4, 0, 12),
    roundsPerReplan: clampInt(readAppEnv("REPLAN_ROUNDS"), 3, 1, 6),
    stallSteps: clampInt(readAppEnv("REPLAN_STALL"), 2, 1, 6),
  };
}

export function createReplanTracker(): ReplanTracker {
  return {
    used: 0,
    consecutiveNoProgress: 0,
    lastUrl: "",
    lastPending: -1,
    lastProgressFacts: 0,
  };
}

export function countProgressFacts(facts: Array<{ kind: string }>): number {
  return facts.reduce((n, fact) => n + (PROGRESS_KINDS.has(fact.kind as EvidenceKind) ? 1 : 0), 0);
}

function remember(tracker: ReplanTracker, signal: StepSignal): void {
  tracker.lastUrl = signal.url;
  tracker.lastPending = signal.pending;
  tracker.lastProgressFacts = signal.progressFacts;
}

/**
 * 纯判定：这一步算不算进展，要不要重规划，要不要停。
 * 会改 tracker（计数与基线），不发任何请求。
 */
export function observeStepForReplan(
  tracker: ReplanTracker,
  signal: StepSignal,
  budget: ReplanBudget = loadReplanBudget(),
): StepReplanDecision {
  if (signal.needsHuman) {
    remember(tracker, signal);
    return { progressed: false, replan: false, stop: false, reason: "needs-human" };
  }

  // 第一步只记账：事实条数从 0 涨到「页面本来就有的那些」不算进展，否则基线步永远被当成推进。
  if (tracker.lastPending < 0) {
    remember(tracker, signal);
    if (!signal.hadError) {
      return { progressed: false, replan: false, stop: false, reason: "baseline" };
    }
    tracker.consecutiveNoProgress = 1;
    return { progressed: false, replan: false, stop: false, reason: "stall-accumulating" };
  }

  const pendingDown = signal.pending < tracker.lastPending;
  const urlMoved = Boolean(tracker.lastUrl) && signal.url !== tracker.lastUrl;
  const factsUp = signal.progressFacts > tracker.lastProgressFacts;
  // 地址变了就是进展：同一步里别的工具失败（例如下拉报错）不能把这次跳转抹掉。
  // 被拒绝的非法地址不会改 URL，所以不会被算成进展。
  const progressed = pendingDown || urlMoved || (factsUp && !signal.hadError);
  remember(tracker, signal);

  if (progressed) {
    tracker.consecutiveNoProgress = 0;
    return { progressed: true, replan: false, stop: false, reason: "progress" };
  }

  tracker.consecutiveNoProgress += 1;
  if (tracker.consecutiveNoProgress < budget.stallSteps) {
    return { progressed: false, replan: false, stop: false, reason: "stall-accumulating" };
  }
  if (signal.pending === 0 && !signal.hadError) {
    tracker.consecutiveNoProgress = 0;
    return { progressed: false, replan: false, stop: false, reason: "nothing-pending" };
  }
  if (tracker.used >= budget.maxReplans || budget.maxReplans === 0) {
    return { progressed: false, replan: false, stop: true, reason: "budget-exhausted" };
  }
  return { progressed: false, replan: true, stop: false, reason: "stalled" };
}

/** 一次重规划消耗一次预算，并把停滞计数清零（新计划要重新证明自己） */
export function markReplanUsed(tracker: ReplanTracker): void {
  tracker.used += 1;
  tracker.consecutiveNoProgress = 0;
}

export interface ReplanReply {
  plan: string[];
  reason: string;
}

/** 解析 Planner 回复。不是合法计划就返回 null，让上层再问一轮。 */
export function parseReplanReply(content: string): ReplanReply | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = extractJsonObject(content) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) return null;
  const raw = Array.isArray(parsed.plan) ? parsed.plan : [];
  const plan = raw
    .map((item) => String(item ?? "").replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 1)
    .filter((item) => !/^(观察|截图|提取\s*DOM|等待页面|感知页面)/.test(item))
    .slice(0, 12);
  if (plan.length === 0) return null;
  return { plan, reason: String(parsed.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 240) };
}

export interface ReplanBriefInput {
  goal: string;
  plan: PlanItem[];
  pendingLines: string[];
  /**
   * **已核销**的交付物行。
   *
   * 为什么必须喂给重规划器（用户现场）：改造前它只看到"尚未核销"，于是当某项因为**核销判据出故障**
   * 而挂着时，它会理直气壮地把那件事**从头再做一遍** —— 现场就写出了「首页→输入→提交」，
   * 把已经到达的结果页丢掉、navigate 回引擎首页重新搜索。
   * 喂入已核销项，它才知道"哪些事已经被承认，不要再做"。
   */
  satisfiedLines: string[];
  errors: string[];
  url: string;
  title?: string;
  digest?: string;
}

/** 提问正文：只放客观事实，Planner 据此改「还没做完的部分」 */
export function buildReplanBrief(input: ReplanBriefInput): string {
  const planLines = input.plan.length
    ? input.plan.map((item) => `- [${item.status}] ${item.text}`).join("\n")
    : "（还没有计划）";
  const pending = input.pendingLines.length ? input.pendingLines.join("\n") : "（没有未核销的必交项）";
  const satisfied = input.satisfiedLines.length ? input.satisfiedLines.join("\n") : "（还没有已核销项）";
  const errors = input.errors.length ? input.errors.map((line) => `- ${line}`).join("\n") : "（本步没有结构化错误）";
  return [
    `<用户目标>${input.goal}</用户目标>`,
    `<当前计划>\n${planLines}\n</当前计划>`,
    `<尚未核销的交付物>\n${pending}\n</尚未核销的交付物>`,
    `<已核销的交付物（已经认定完成，禁止重做）>\n${satisfied}\n</已核销的交付物>`,
    `<刚刚的失败>\n${errors}\n</刚刚的失败>`,
    `<当前页面>${input.title ? `${input.title} · ` : ""}${input.url}</当前页面>`,
    input.digest ? `<页面可见内容>\n${input.digest.slice(0, 800)}\n</页面可见内容>` : "",
    `<可用工具>\n${REPLAN_TOOL_BRIEF}\n</可用工具>`,
  ]
    .filter(Boolean)
    .join("\n");
}

const REPLAN_SYSTEM = `你是任务重规划器。执行已经卡住，请只根据给定事实重写**还没完成的步骤**。
只输出 JSON：{"plan":["步骤1","步骤2"],"reason":"一句话说明旧计划为什么走不通"}
规则：
- plan 只写还没做完的事，不要把已经 [done] 的步骤再写一遍；
- **已核销的交付物禁止重做**：它的结果已经达成，不得再写让它"重新发生一次"的步骤；
- **禁止回退**：不要写「打开某首页重新搜索」「重新进入某页」这类把已经走到的状态丢掉的步骤 ——
  例如当前已经在搜索结果页，就不要 navigate 回引擎首页再输一遍检索词；
- 每一项未核销的交付物至少对应一个步骤，一项都不能省；
- 若某项未核销是因为"已经做了但没被记录"，请写**补证/确认**类的步骤（读取当前页、截图、提取内容），
  而不是把那件事重新做一遍；
- 步骤要能对应到「可用工具」里的能力（点击编号、写入、切标签、看图定位、下载落盘、问用户要其本人才能知道的值）；
- 禁止写「观察页面 / 截图 / 提取 DOM」当步骤（运行时会自动观察）；
- 禁止把「到达搜索结果页」写成完成，只要还有未核销交付物；
- 刚刚失败的手法不要原样再来一次：换入口、换工具、或先清掉挡住目标的东西；
- 简体中文，最多 8 步。`;

export interface RequestReplanInput extends ReplanBriefInput {
  aiSettings: SidecarAiSettings;
  signal?: AbortSignal;
  rounds: number;
}

/**
 * 向 Planner 要一份新计划。最多 rounds 轮；任何一轮给出合法 plan 即返回。
 * 全部失败返回 null（调用方仍应记一次预算，避免同一卡点无限重问）。
 */
export async function requestReplan(input: RequestReplanInput): Promise<ReplanReply | null> {
  const rounds = Math.max(1, input.rounds);
  let lastError = "无输出";
  for (let round = 1; round <= rounds; round += 1) {
    let wait: ReturnType<typeof beginAgentLlmWait> | null = null;
    try {
      const router = createModelRouter(input.aiSettings);
      const resolved = router.resolve("logic");
      const client = createLlmClient(input.aiSettings);
      wait = beginAgentLlmWait({ parentSignal: input.signal, timeoutMs: 40_000 });
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: REPLAN_SYSTEM },
        {
          role: "user",
          content:
            buildReplanBrief(input) +
            (round > 1 ? `\n上一轮输出无法解析（${lastError}）。请只输出上述 JSON，plan 必须是非空字符串数组。` : ""),
        },
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
      const parsed = parseReplanReply(extractAssistantContent(completion));
      if (parsed) return parsed;
      lastError = "plan 为空或不是字符串数组";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      wait?.stop();
    }
  }
  return null;
}

/**
 * 新计划里若出现契约还没有的交付物类型，补进台账（已核销的项不动）。
 * 返回新增 id，便于日志。
 */
export function absorbPlanDeliverables(ledger: DeliverableLedger, plan: string[]): string[] {
  const extra = deriveContractFromRules({
    goal: ledger.contract.goal,
    intent: ledger.contract.intent,
    plan,
    queryTerms: [],
  });
  const added: string[] = [];
  for (const spec of extra.deliverables) {
    if (ledger.contract.deliverables.some((item) => item.kind === spec.kind)) continue;
    const id = `${spec.kind}#${ledger.contract.deliverables.length + 1}`;
    ledger.contract.deliverables.push({ ...spec, id });
    ledger.records.set(id, { id, status: "pending", evidence: "", step: -1, blocks: 0 });
    added.push(id);
  }
  return added;
}
