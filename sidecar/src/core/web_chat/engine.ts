/**
 * 聊天模式引擎（§4 · §5 · §6）—— **耐久相位状态机**
 *
 * 这是第四种执行形态（§0.4）。它与 `bu_agent/service.ts` 的 ReAct 步进循环**没有任何关系**：
 *   - 不 import `bu_agent` 的任何循环代码；
 *   - 不借用 `ActionContext` / `EvidenceLedger` / `registerAction`（§7.4：那是 Agent 的账本）；
 *   - 依赖全部**注入**（`ChatEngineDeps`），因此可无浏览器单测，也便于替换原语实现。
 *
 * 三条不变量贯穿全文：
 *   1. **静音**（§5）：不发截图、不做全景/SoM/a11y/控件树/digest/影子模型；等待一律事件驱动。
 *   2. **可停 + 让位**（§4.5）：每个 `await` 之后 `assertNotAborted`；用户有输入即让位（R7）。
 *   3. **副作用前先落盘**（§4.3）：发送前先写 outbox（durable-before-return），续跑先对账。
 */
import {
  DEFAULT_CADENCE,
  DEFAULT_WARM_STEER,
  LIVE_REPLY_WINDOW_MINUTES,
  computeNextWarmDueAt,
  isColdOpening,
  isWithinQuietHours,
  liveReplyRecheckAt,
  nextQuietEnd,
  planWarmSteer,
  type CadenceConfig,
  type FollowUpState,
  type WarmSteerConfig,
} from "./cadence.js";
import {
  draftMatchesPeerLanguage,
  draftMatchesPeerPunctuation,
  inferPeerPunctuationHabit,
  inferPeerReplyLanguage,
  languageRewriteHint,
  punctuationRewriteHint,
} from "./chat_prompt.js";
import { agentDebugLog } from "../../debug_session_log.js";
import { checkDuplicate, shouldGiveUpDraft, type DedupeHistory } from "./dedupe.js";
import {
  beginSend,
  commitSent,
  computeEffectId,
  decideSend,
  findOutboxEntry,
  hashText,
  looksLikeOwnSentText,
  markUnconfirmed,
  upsertOutbox,
} from "./outbox.js";
import {
  advancePhase,
  autoReplyOf,
  bumpProgress,
  createInitialSnapshot,
  dueContacts,
  followUpOf,
  isStoppingStage,
  rollCountersIfNewDay,
  setContacts,
  setNextWakeAt,
  setOutbox,
  upsertContact,
  type ChatContactState,
  type ChatStage,
  type ChatStateSnapshot,
} from "./state.js";
import { canTransition, type ChatPhase } from "./phases.js";
import {
  decidePaymentGate,
  findMatchingPaymentMethod,
  isPaymentAsk,
  isTradeSignal,
  plainPaymentText,
  type ChatPaymentMethod,
} from "./chat_payment.js";
import { hasOneTimeCode, hasPaymentIntent, isRedlineText } from "./chat_redaction.js";
import { DEFAULT_PACING, incomingTextOf, planSendWait, type PacingConfig } from "./pacing.js";
import { unansweredIncoming, type ChatMessage } from "./conversation_extract.js";
import {
  classifyTurnIntent,
  draftViolatesIntent,
  intentPromptDirective,
  intentRewriteHint,
  maxBubblesForTurn,
  trustFallbackText,
  wantsOutboundImage,
  type TurnIntent,
} from "./turn_intent.js";
import type {
  ChatEngineDeps,
  ChatEngineOptions,
  ChatEngineRunResult,
  ChatEngineStopReason,
  ChatSendGateResult,
} from "./engine_types.js";
export type {
  ChatEngineDeps,
  ChatEngineOptions,
  ChatEngineRunResult,
  ChatEngineStopReason,
  ChatSendGateResult,
} from "./engine_types.js";

/**
 * `noteProgress` 的落盘节流：看门狗最快 20s 拍一次（`PATROL_TICK_ACTIVE`），
 * 5s 粒度足够让「计数在动」这件事被看到，又不至于把每个子步骤都写一遍磁盘。
 */
export const PROGRESS_FLUSH_MS = 5_000;

/**
 * `noteProgress` 的落盘节流判据（纯函数，便于单测）。
 *
 * 计数在内存里每一步都涨，但**写盘**按 5s 节流：看门狗读的是文件，
 * 所以「节流也不能太久」——超过 5s 必须落盘，否则看门狗会看不到推进。
 */
export function shouldFlushProgress(lastFlushAt: number, now: number): boolean {
  return now - lastFlushAt >= PROGRESS_FLUSH_MS;
}

/**
 * 单个回合的结果。
 *
 * `continueConversation` 只在「真发出去了**且**对方当场回了话」时为真 ——
 * 这是「发完一条信息就结束了」的修复点，同时也是防刷屏的闸门：
 * 对方没说话就绝不继续找话。
 */
type TurnOutcome =
  | {
      kind: "done";
      contact: ChatContactState;
      delivered: "sent" | "skipped";
      continueConversation: boolean;
    }
  | { kind: "handover" }
  | { kind: "aborted" };

function turnDone(
  contact: ChatContactState,
  delivered: "sent" | "skipped",
  continueConversation = false,
): TurnOutcome {
  return { kind: "done", contact, delivered, continueConversation };
}

/** R2 / R1 词表：这类内容**永不**由聊天模式发出（叠加 §1.6 红线）。口径见 `chat_redaction.ts` */

/**
 * 「短复查已到期但这一片没收掉」时的兜底唤醒间隔（毫秒）——秒级近实时。
 */
const IMMEDIATE_REWAKE_MS = 5_000;
/** browser_closed / 异常退出后的最短续盯间隔，防止秒级空转风暴 */
const ABNORMAL_REWAKE_FLOOR_MS = 20_000;

/**
 * 「只有 nextCheckAt / 空闲」时的兜底唤醒间隔（毫秒）——持续值守，不空转停机。
 */
const DUE_REWAKE_MS = 10_000;

/** 对方连发时的入站合批静默窗（毫秒）：窗内新消息并入同一批再起草 */
const INBOUND_QUIET_MS = 5_000;

/**
 * 聊天发送闸门：一次性码永禁；付款方式只许已配置的纯内容（可 rewrite）；禁用词。
 * 与 Agent 支付红线分开——聊天可以发用户配置好的收款方式，但绝不能编造。
 */
export function defaultGateSend(
  text: string,
  bannedWords: readonly string[] = [],
  paymentMethods: readonly ChatPaymentMethod[] = [],
): ChatSendGateResult {
  const raw = String(text ?? "").trim();
  if (!raw) return { allow: false, kind: "banned", reason: "空内容" };

  if (hasOneTimeCode(raw)) {
    return {
      allow: false,
      kind: "redline",
      reason: "含疑似一次性码：聊天模式不代发验证码（R2）",
      needHandover: false,
    };
  }
  // 证件 / CVV 仍禁（除非整段就是已配置的银行卡付款方式）
  if (/(cvv|安全码|身份证|护照)/i.test(raw)) {
    return {
      allow: false,
      kind: "redline",
      reason: "含证件/安全码语义：聊天模式不得代发",
      needHandover: true,
    };
  }
  const pay = decidePaymentGate(raw, paymentMethods);
  if (pay.kind === "block") {
    return {
      allow: false,
      kind: "redline",
      reason: pay.reason,
      needHandover: pay.needHandover,
    };
  }
  if (pay.kind === "plain_only") {
    return { allow: true, rewriteText: pay.plain };
  }
  // 支付语义词（转账/付款等）仍禁，除非整段就是已配置的纯付款方式
  if (hasPaymentIntent(raw) && !findMatchingPaymentMethod(raw, paymentMethods)) {
    return {
      allow: false,
      kind: "redline",
      reason: "含支付语义：请在聊天设置配置付款方式后只发纯内容，禁止代发转账指令",
      needHandover: true,
    };
  }
  for (const word of bannedWords) {
    if (word && raw.toLowerCase().includes(word.toLowerCase())) {
      return { allow: false, kind: "banned", reason: `命中禁用词：${word}` };
    }
  }
  return { allow: true };
}

/** 每个 `await` 之后的存活检查：可停是硬要求（§4.5） */
export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason;
    throw new ChatAbortedError(typeof reason === "string" ? reason : "aborted");
  }
}

export class ChatAbortedError extends Error {
  constructor(reason: string) {
    super(`chat_aborted: ${reason}`);
    this.name = "ChatAbortedError";
  }
}

/**
 * 引擎单例（一个环境一个引擎；§4.3「一个 run 一个 driver」）。
 *
 * 并发席位由宿主负责（`is_engine_busy` / `chat_patrol` 并发上限 / `engine_mutex`），
 * 引擎内部不再持有任何「租约」—— 假护栏只会让权威口径分叉。
 */
/** 一次会话读取的返回（`ChatEngineDeps.readConversation` 的解析值） */
type ConversationRead = Awaited<ReturnType<ChatEngineDeps["readConversation"]>>;
/** 一次草稿的返回（非空形态） */
type DraftResult = NonNullable<Awaited<ReturnType<ChatEngineDeps["draft"]>>>;

function draftTextsOf(draft: DraftResult | null): string[] {
  if (!draft) return [];
  const fromList = Array.isArray(draft.texts)
    ? draft.texts.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  if (fromList.length > 0) return fromList.slice(0, 3);
  const single = String(draft.text ?? "").trim();
  return single ? [single] : [];
}

/**
 * 单个回合内四个相位之间传递的上下文（纯数据，避免十几个局部变量在方法间来回传）。
 * 刻意用可变对象：各相位方法各自推进自己那一段字段，`runTurn` 只做编排。
 */
interface TurnContext {
  contact: ChatContactState;
  signal: AbortSignal;
  sliceEnd: number;
  turn: number;
  container: string | null;
  read: ConversationRead | null;
  incoming: ChatMessage[];
  hasNewIncoming: boolean;
  /** 上方还有未滚完的历史（本轮禁止冷开场推销） */
  historyIncomplete: boolean;
  stage: ChatStage;
  history: DedupeHistory;
  followUpState: FollowUpState;
  isFollowUp: boolean;
  planReason: string | null;
  intent: TurnIntent | null;
  draft: DraftResult | null;
  mediaPick: { path: string; label: string } | null;
}

export class ChatEngine {
  private snapshot: ChatStateSnapshot;
  private readonly deps: ChatEngineDeps;
  private readonly options: ChatEngineOptions;
  private readonly cadence: CadenceConfig;
  private readonly warmSteer: WarmSteerConfig;
  private readonly pacing: PacingConfig;
  private readonly paymentMethods: readonly ChatPaymentMethod[];
  /** 草稿失败 / 对方仍在等 → 片末强制秒级续盯 */
  private urgentRewake = false;
  /** 上一次把快照写盘的时刻（`noteProgress` 按它节流；相位推进时也刷新） */
  private lastFlushAt = 0;

  constructor(deps: ChatEngineDeps, options: ChatEngineOptions, initial?: ChatStateSnapshot) {
    this.deps = deps;
    this.options = options;
    this.cadence = options.cadence ?? DEFAULT_CADENCE;
    // 温热追问默认开；若设置里把 maxFollowUps 配在 1～5，用作本轮上限
    const maxFromCadence =
      this.cadence.followUpEnabled && this.cadence.maxFollowUps > 0
        ? Math.min(5, this.cadence.maxFollowUps)
        : DEFAULT_WARM_STEER.maxNudges;
    this.warmSteer = { ...DEFAULT_WARM_STEER, maxNudges: maxFromCadence };
    this.pacing = deps.pacing ?? DEFAULT_PACING;
    this.paymentMethods = deps.paymentMethods ?? [];
    this.snapshot =
      initial ?? createInitialSnapshot({ envId: options.envId, profileId: options.profileId, now: deps.now() });
  }

  getSnapshot(): ChatStateSnapshot {
    return this.snapshot;
  }

  private async save(): Promise<void> {
    this.snapshot = rollCountersIfNewDay(this.snapshot, this.deps.now());
    this.lastFlushAt = Date.now();
    const result = await this.deps.saveSnapshot(this.snapshot);
    if (!result.ok) {
      // 落盘失败必须可见（durable-before-return 不能静默失败）
      this.deps.log("快照落盘失败", { phase: this.snapshot.engine.phase, error: result.error });
    }
  }

  /**
   * **片内子步骤进展**（§4.4）：同一个相位里也会走很久（等 LLM、逐条读、等对方回话、记忆压缩），
   * 只靠相位推进的话，看门狗会看到「相位不变 + 计数不涨」——**把正常但慢的片误判成卡死**。
   *
   * 所以每个子步骤边界都要 bump 单调计数；落盘按 {@link PROGRESS_FLUSH_MS} 节流，
   * 既不漏掉推进（看门狗最快 20s 一拍，5s 粒度足够），也不把磁盘当计数器用。
   */
  private async noteProgress(): Promise<void> {
    this.snapshot = bumpProgress(this.snapshot, this.deps.now());
    if (!shouldFlushProgress(this.lastFlushAt, Date.now())) return;
    await this.save();
  }

  /** 相位推进的唯一入口：断言转移合法 + bump progressCounter + 落快照 */
  private async enter(
    phase: ChatPhase,
    patch: Parameters<typeof advancePhase>[3] = {},
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const from = this.snapshot.engine.phase;
    this.snapshot = advancePhase(this.snapshot, phase, this.deps.now(), patch);
    await this.save();
    this.deps.log(`相位 ${from} → ${phase}`, {
      type: "chat_phase",
      phase,
      from,
      threadKey: null,
      ...extra,
    });
  }

  /* ————————————————————————— 主循环 ————————————————————————— */

  /**
   * 跑一个值守片。
   *
   * **入睡不是引擎的事**：`nextWakeAt` 是调度状态（§4.2），Host 调度器据此决定何时再拉起本引擎。
   * 所以这里既没有 `setTimeout` 长睡，也没有任何轮询——一个片内只做「扫描 → 处理 → 让位」，
   * 干完就退出并把下次唤醒时间写进快照。这样「睡着时零模型调用、零截图、零 CDP」是结构性成立的，
   * 而不是靠自觉（§5 / §6）。
   */
  async run(): Promise<ChatEngineRunResult> {
    const signal = this.options.signal;
    const sliceEnd = Date.now() + Math.max(1000, this.deps.sliceMs);
    const handled = new Set<string>();
    let processed = 0;
    let sent = 0;
    let skipped = 0;
    let stopReason: ChatEngineStopReason = "slice_complete";

    try {
      await this.enter("booting");

      // 并发席位**不在这里**：占用与上限由宿主一处负责（`is_engine_busy` + `chat_patrol`
      // 并发上限 + `engine_mutex`）。引擎里再放一套「假席位」只会让「谁是权威」分叉，
      // 所以直接进入正题。
      //
      // 1) 续跑第一步：**先对账 outbox**（先确认没有半发状态），再继续（§4.4）
      await this.reconcileOutbox();
      assertNotAborted(signal);

      // 2) 扫描 → 逐个处理 → 干完即让位
      await this.enter("scanning");
      const queue = await this.buildQueue(handled);
      assertNotAborted(signal);

      // **没对象可聊 ≠ 失败，也 ≠ 干完活**：如实说清「这次没活干 + 现在该做什么」。
      // 用户现场就是这一条被并进 `slice_complete`（宿主还把它算成一次失败），
      // 于是「开始值守 → 一秒结束」且没有任何可操作的说明。
      if (queue.length === 0) {
        const note = this.rosterNoteOf();
        this.deps.log("本次没有要聊的对象，未开始任何动作", {
          type: "chat_no_targets",
          phase: "scanning",
          threadKey: null,
          reason: "empty_roster",
          hint: note,
        });
        return await this.finish("no_targets", processed, sent, skipped, note);
      }

      // 接管产品面已删除（R7）：不再按 takeover 过滤联系人。
      // 用户正在打字仍由片内 `userActive` 让位，但不永久锁死。
      const eligible = queue;

      if (eligible.length === 0) {
        return await this.finish("slice_complete", processed, sent, skipped);
      }

      for (const contact of eligible) {
        if (signal.aborted) {
          stopReason = "aborted";
          break;
        }
        if (Date.now() >= sliceEnd) {
          stopReason = "slice_elapsed";
          break;
        }
        handled.add(contact.key);

        // 每个联系人重新进 `scanning`：`recording → reading` 不是合法转移，
        // 状态机要求经扫描相位再进入下一个线程（这样也顺便保证「逐个、不并行」）
        await this.enter("scanning");

        const outcome = await this.handleContact(contact, signal, sliceEnd);
        processed += 1;
        if (outcome === "sent") sent += 1;
        if (outcome === "skipped") skipped += 1;
        if (outcome === "handover") {
          stopReason = "handover";
          break;
        }
        if (outcome === "aborted") {
          stopReason = "aborted";
          break;
        }
      }

      if (signal.aborted && stopReason !== "handover") {
        stopReason = "aborted";
      }
    } catch (error) {
      if (error instanceof ChatAbortedError) {
        stopReason = "aborted";
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log("引擎异常退出", { phase: this.snapshot.engine.phase, error: message });
        stopReason = "browser_closed";
      }
    }

    return await this.finish(stopReason, processed, sent, skipped);
  }

  /** 让位：进入 idle 相位 + 写下次唤醒时间（Host 调度器据此排班；§4.1） */
  private async finish(
    stopReason: ChatEngineStopReason,
    processed: number,
    sent: number,
    skipped: number,
    note: string | null = null,
  ): Promise<ChatEngineRunResult> {
    const current = this.snapshot.engine.phase;
    // 让位的落点总是 `waiting`（idle：等 Host 调度器下一次唤醒）。
    // 不用 `yielding`：那表示「拿到席位后中途让出」，而并发席位由宿主一处负责，
    // 引擎不再产出这种语义（`seat_lost` 只作历史快照的兼容读，见 `ChatEngineStopReason`）。
    const terminal: ChatPhase = stopReason === "handover" ? "handover" : "waiting";
    if (current !== "stopped" && canTransition(current, terminal)) {
      this.snapshot = advancePhase(this.snapshot, terminal, this.deps.now());
    }
    // 片末先刷新「短复查」时间，再据此算下次唤醒 —— 顺序不能反（否则唤醒时间算的还是旧值）
    await this.refreshReplyWatch();
    this.snapshot = setNextWakeAt(this.snapshot, this.computeNextWakeAt(stopReason));
    await this.save();
    // #region agent log
    agentDebugLog("H-wake", "engine.ts:finish", "slice yield wake plan", {
      stopReason,
      urgentRewake: this.urgentRewake,
      nextWakeAt: this.snapshot.engine.nextWakeAt,
      paymentMethods: this.paymentMethods.length,
      processed,
      sent,
      skipped,
      nextChecks: this.snapshot.contacts.map((c) => ({
        k: c.key.slice(0, 24),
        nextCheckAt: c.nextCheckAt,
        trade: c.suspectedTradeCount ?? 0,
      })),
    });
    // #endregion
    this.deps.log(`值守片让位：${stopReason}（总开关开着会自动续盯，不是监控结束）`, {
      type: "chat_patrol_yield",
      phase: this.snapshot.engine.phase,
      stopReason,
      processed,
      sent,
      skipped,
      nextWakeAt: this.snapshot.engine.nextWakeAt,
      // 片终态带上人话原因：宿主把它透传进终态 `msg`，视图直接展示给用户
      // （`no_targets` 这类「什么都没做」的结束，没有这句话用户无从下手）
      msg: note ?? null,
    });
    return { stopReason, snapshot: this.snapshot, processed, sent, skipped, note };
  }

  /**
   * 名单为空时的原因（问装配层，引擎不猜）。
   * 读不到就回一句通用的「该做什么」，绝不返回空让用户对着「结束」发愣。
   */
  private rosterNoteOf(): string {
    try {
      const note = this.deps.rosterNote?.();
      if (note && String(note).trim()) return String(note).trim();
    } catch {
      /* 取不到原因不是错误：回通用说明 */
    }
    return "本次没有可聊对象：请在「聊天」视图点「读取当前页面会话列表」并勾选要聊的人，或打开一个聊天窗口后重试。";
  }

  /**
   * 下次该在什么时候被唤醒：取所有未停止联系人的 `nextDueAt`（回访到期）与
   * `nextCheckAt`（短复查：我方刚发完、看对方回不回）的**最早**者。
   *
   * 静默时段只推迟**主动回访**（`nextDueAt`），**绝不**推迟正在进行的对话短复查：
   * 对方刚回话、我们却因为「现在是静默时段」把几分钟后的复查推到明天早上 ——
   * 用户看到的就是「对方秒回没人接」。
   */
  private computeNextWakeAt(stopReason?: ChatEngineStopReason): string {
    // **只用注入时钟**（`deps.now`）：排班是纯粹的耐久状态计算，不该偷偷读墙钟 ——
    // 两套时钟混用会让「刚排好 30 秒后的复查」被真墙钟当成「已过期」再推一轮（也会让测试不可复现）。
    const nowIso = this.deps.now();
    const nowMs = new Date(nowIso).getTime();
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const isLive = (c: ChatContactState): boolean => !c.stopped && !isStoppingStage(c.stage);
    const dues = this.snapshot.contacts
      .filter((c) => isLive(c) && c.nextDueAt)
      .map((c) => new Date(c.nextDueAt as string).getTime())
      .filter((t) => Number.isFinite(t));
    const checks = this.snapshot.contacts
      .filter((c) => isLive(c) && c.nextCheckAt)
      .map((c) => new Date(c.nextCheckAt as string).getTime())
      .filter((t) => Number.isFinite(t));

    const quietEnd = nextQuietEnd(this.deps.now(), this.cadence.quietHours);
    const quietEndMs = quietEnd ? new Date(quietEnd).getTime() : null;

    let dueWake = dues.length > 0 ? Math.min(...dues) : Number.POSITIVE_INFINITY;
    if (quietEndMs !== null && Number.isFinite(dueWake)) dueWake = Math.max(dueWake, quietEndMs);
    const checkWake = checks.length > 0 ? Math.min(...checks) : Number.POSITIVE_INFINITY;

    let wakeAt =
      Number.isFinite(dueWake) || Number.isFinite(checkWake)
        ? Math.min(dueWake, checkWake)
        : now + DUE_REWAKE_MS;
    // 有待发多句：立刻续片把话说完
    const hasPending = this.snapshot.contacts.some(
      (c) => isLive(c) && Array.isArray(c.pendingTexts) && c.pendingTexts.length > 0,
    );
    if (hasPending) wakeAt = Math.min(wakeAt, now + IMMEDIATE_REWAKE_MS);
    if (this.urgentRewake) wakeAt = Math.min(wakeAt, now + IMMEDIATE_REWAKE_MS);
    if (wakeAt <= now) {
      // 已到期但本轮没处理完 → 秒级再来（持续值守，不空转停机）
      const checkOverdue = Number.isFinite(checkWake) && checkWake <= now;
      wakeAt = now + (checkOverdue || hasPending || this.urgentRewake ? IMMEDIATE_REWAKE_MS : DUE_REWAKE_MS);
    }
    // 异常退出：抬高地板，避免 Host 30s 容差把 5–10s 续盯当成「已到期」秒级空转
    if (stopReason === "browser_closed") {
      wakeAt = Math.max(wakeAt, now + ABNORMAL_REWAKE_FLOOR_MS);
    }
    return new Date(wakeAt).toISOString();
  }

  /**
   * 刷新「短复查」时间（片末统一做一次）。
   *
   * 权威来自**耐久事实** `lastContactAt` / `lastReplyAt`（`visit.json`，不是内存）：
   *   - 我方最后说话 → 热窗口 60 分钟内每 5 秒看一眼；此后按冷阶梯 `[1,2,5,10,15]` 分钟越来越稀；
   *   - **对方刚回话、我方还没接上**（片末恰好错过那句）→ 短阶梯追上去，绝不掉到 48 小时后的回访；
   *   - 超出窗口（24 小时）→ 清掉（回归正常回访节奏，绝不无限空转）。
   *
   * 这就是「发完一条就结束」的修复：发出去之后不是等 48 小时，而是**一直在听** ——
   * 但**只是来看**，没有新消息就不发（不催、不刷屏）。
   */
  private async refreshReplyWatch(): Promise<void> {
    if (this.snapshot.contacts.length === 0) return;
    const now = this.deps.now();
    let changed = false;
    const next = [...this.snapshot.contacts];
    for (let index = 0; index < next.length; index += 1) {
      const contact = next[index]!;
      if (contact.stopped || isStoppingStage(contact.stage)) {
        if (contact.nextCheckAt) {
          next[index] = { ...contact, nextCheckAt: null };
          changed = true;
        }
        continue;
      }
      let state: FollowUpState | null = null;
      try {
        state = await this.deps.followUpState(contact);
      } catch {
        state = null; // 读不到就**不猜**：清掉复查（宁可晚点回访，也不空转）
      }
      const at = state
        ? liveReplyRecheckAt({
            nowIso: now,
            lastContactAt: state.lastContactAt,
            lastReplyAt: state.lastReplyAt,
            windowMinutes: LIVE_REPLY_WINDOW_MINUTES,
          })
        : null;
      // 本片已排的更早复查（如草稿失败后的 3s）优先，不被阶梯抬晚
      let merged = at;
      if (contact.nextCheckAt && at) {
        const existingMs = new Date(contact.nextCheckAt).getTime();
        const atMs = new Date(at).getTime();
        if (Number.isFinite(existingMs) && Number.isFinite(atMs) && existingMs < atMs) {
          merged = contact.nextCheckAt;
        }
      } else if (contact.nextCheckAt && !at) {
        merged = contact.nextCheckAt;
      }
      if ((contact.nextCheckAt ?? null) !== merged) {
        next[index] = { ...contact, nextCheckAt: merged };
        changed = true;
        if (merged) {
          const updated = next[index]!;
          this.deps.log("已排短复查：片让位后会继续盯（有新话再回，没话不发）", {
            type: "chat_reply_watch",
            phase: this.snapshot.engine.phase,
            threadKey: updated.key,
            nextCheckAt: merged,
          });
        }
      }
    }
    if (changed) {
      this.snapshot = setContacts(this.snapshot, next);
      await this.save();
    }
  }

  /* ————————————————————————— 队列 ————————————————————————— */

  /** 建立本轮队列：到期回访 > 有未读 > 其余（首次接触）；已被本轮处理过的不再入队 */
  private async buildQueue(handled: ReadonlySet<string>): Promise<ChatContactState[]> {
    let roster: ChatContactState[] = [];
    try {
      roster = await this.deps.listContacts();
    } catch {
      roster = [];
    }

    // **名单的权威只有一处：用户勾选的目标**（设置里的 `targetsByEnv` / 当前打开的会话）。
    //
    // 这里曾经把快照里的旧联系人也并进来（理由：快照是耐久态、名单可能尚未回写）——
    // 结果是「用户把目标清空了，引擎照旧挨个去聊」，而且快照里一条过期的
    // `takeover: "human"`（自动检测误判留下的）会把整片在 1 秒内结束掉，
    // 用户只看到「开始值守 → 因接管跳过 → 值守片结束」（现场就是这个）。
    // 名单为空就**如实说没对象**（`no_targets`），绝不拿旧名单凑数。
    const all = roster.filter((c) => !c.stopped && !isStoppingStage(c.stage));
    const byKey = new Map(all.map((c) => [c.key, c]));

    // 「到期回访」的**排序依据**取自快照（`dueContacts` 是确定性的），但**联系人本体**一律用
    // 名单里的那一份：名单才是权威（它带着用户刚改的开关 / 接管状态），快照只用来排先后。
    const dueKeys = dueContacts(this.snapshot, this.deps.now(), this.deps.maxContactsPerSlice)
      .filter((c) => !c.stopped && !isStoppingStage(c.stage))
      .map((c) => c.key)
      .filter((key) => byKey.has(key));
    // 短复查到点的排在最前：我方刚发完、对方可能回了话 —— 这类最该先看一眼
    const nowMs = Date.now();
    const pending = all.filter((c) => Array.isArray(c.pendingTexts) && c.pendingTexts.length > 0);
    const watchDue = all.filter(
      (c) => c.nextCheckAt && Number.isFinite(new Date(c.nextCheckAt).getTime()) && new Date(c.nextCheckAt).getTime() <= nowMs,
    );
    const unread = all.filter((c) => Boolean(c.lastIncomingHash));

    const seen = new Set<string>();
    const queue: ChatContactState[] = [];
    const push = (contact: ChatContactState | undefined): void => {
      if (!contact || seen.has(contact.key) || handled.has(contact.key)) return;
      seen.add(contact.key);
      queue.push(contact);
    };
    for (const contact of pending) push(contact);
    for (const contact of watchDue) push(contact);
    for (const key of dueKeys) push(byKey.get(key));
    for (const contact of unread) push(contact);
    for (const contact of all) push(contact);

    return queue.slice(0, this.deps.maxContactsPerSlice);
  }

  /* ————————————————————————— 单个联系人一轮闭环 ————————————————————————— */

  /**
   * 每轮闭环（§11，固定顺序，不靠模型自觉）：
   * 要不要回 → 读懂内容 → 是否回访 → 生成 → 去重 → 闸门 → 发送 → 回读确认 → 落库。
   */
  /**
   * 一位联系人在**一片内**的闭环：允许来回几轮（上限 `maxTurnsPerContact`）。
   *
   * 为什么要多轮：旧实现「发完一条就 return」，对方的秒回没人接 —— 用户看到的就是
   * 「发完一条信息就结束了」。现在：发出 → 等一小会儿 → 真回了就顺势接一轮；
   * 没回 / 到片末 / 到回合上限就停（绝不硬找话说，R7）。
   */
  private async handleContact(
    contactInput: ChatContactState,
    signal: AbortSignal,
    sliceEnd: number,
  ): Promise<"sent" | "skipped" | "handover" | "aborted"> {
    const maxTurns = Math.max(1, Math.trunc(this.deps.maxTurnsPerContact || 1));
    let contact = contactInput;
    let overall: "sent" | "skipped" = "skipped";

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const outcome = await this.runTurn(contact, signal, sliceEnd, turn);
      if (outcome.kind === "handover") return "handover";
      if (outcome.kind === "aborted") return "aborted";
      contact = outcome.contact;
      if (outcome.delivered === "sent") overall = "sent";
      if (!outcome.continueConversation) break;
      if (Date.now() >= sliceEnd) {
        // 片时长预算已用尽：对方刚说的这句留给下一片接（下一片的短复查几分钟内就会来）
        this.deps.log("片时长已到，对方的下一句留到下一片", {
          type: "chat_turn_limit",
          phase: this.snapshot.engine.phase,
          threadKey: contact.key,
          turns: turn,
          reason: "slice_elapsed",
        });
        break;
      }
      if (turn >= maxTurns) {
        this.deps.log(`一片内已来回 ${maxTurns} 轮，对方再回话就等下一片`, {
          type: "chat_turn_limit",
          phase: this.snapshot.engine.phase,
          threadKey: contact.key,
          turns: maxTurns,
        });
      }
    }
    return overall;
  }

  /**
   * 单个回合（§11，固定顺序，不靠模型自觉）：
   * 要不要回 → 读懂内容 → 是否回访 → 生成 → 去重 → 闸门 → 发送 → 回读确认 → 落库。
   */
  private async runTurn(
    contactInput: ChatContactState,
    signal: AbortSignal,
    sliceEnd: number,
    turn: number,
  ): Promise<TurnOutcome> {
    const ctx: TurnContext = {
      contact: contactInput,
      signal,
      sliceEnd,
      turn,
      container: null,
      read: null,
      incoming: [],
      hasNewIncoming: false,
      historyIncomplete: false,
      stage: contactInput.stage,
      history: { thread: [], cross: [] },
      followUpState: { followUpIndex: 0, nextDueAt: null, lastContactAt: null, lastReplyAt: null, stopped: false },
      isFollowUp: false,
      planReason: null,
      intent: null,
      draft: null,
      mediaPick: null,
    };

    try {
      const opened = await this.openAndRead(ctx);
      if (opened) return opened;
      const decided = await this.decideWhetherToSpeak(ctx);
      if (decided) return decided;
      const gated = await this.draftAndGate(ctx);
      if (gated) return gated;
      return await this.deliverAndRecord(ctx);
    } catch (error) {
      if (error instanceof ChatAbortedError) return { kind: "aborted" };
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("处理联系人时异常", {
        type: "chat_state_update",
        phase: this.snapshot.engine.phase,
        threadKey: ctx.contact.key,
        error: message,
      });
      return turnDone(ctx.contact, "skipped");
    }
  }

  /**
   * 相位 1 · 打开并读懂会话（人工优先 → 就绪门禁 → 读取 → 接管/退订判定 → 取回访状态）。
   *
   * 返回 `null` 表示「可以继续往下走」；返回 `TurnOutcome` 表示这一轮到此为止
   * （让位 / 跳过 / 交人工）。刻意不做任何「要不要说话」的判断 —— 那是下一个相位。
   */
  private async runTaskRulesPatrol(
    ctx: TurnContext,
    input: { textCorpus: string; includeDom: boolean; when: "inbound" | "draft" },
  ): Promise<TurnOutcome | null> {
    const patrol = this.deps.taskRulesPatrol;
    if (!patrol) return null;
    const phase = input.when === "inbound" ? "reading" : "verifying";
    try {
      const outcome = await patrol({
        contact: ctx.contact,
        textCorpus: input.textCorpus,
        includeDom: input.includeDom,
        turn: ctx.turn,
        signal: ctx.signal,
        when: input.when,
      });
      if (!outcome) return null;
      for (const event of outcome.events) {
        if (event.type === "chat_task_rule_hit") {
          this.deps.log(`@规则命中：${event.detail}`.slice(0, 200), {
            type: "chat_task_rule_hit",
            phase,
            threadKey: ctx.contact.key,
            ruleId: event.ruleId,
            ruleRole: event.ruleRole,
          });
        } else {
          this.deps.log(`@规则无法判定：${event.detail}`.slice(0, 200), {
            type: "chat_task_rule_inconclusive",
            phase,
            threadKey: ctx.contact.key,
            ruleId: event.ruleId,
          });
        }
      }
      if (outcome.kind === "handover") {
        await this.deps.handover({
          contact: ctx.contact,
          reason: outcome.reason,
          detail: outcome.detail,
        });
        return { kind: "handover" };
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`@规则核对异常：${message}`.slice(0, 200), {
        type: "chat_task_rule_inconclusive",
        phase,
        threadKey: ctx.contact.key,
        ruleId: "probe",
      });
      await this.deps.handover({
        contact: ctx.contact,
        reason: "chat_task_rule_inconclusive",
        detail: message,
      });
      return { kind: "handover" };
    }
  }

  private async openAndRead(ctx: TurnContext): Promise<TurnOutcome | null> {
    const contact = ctx.contact;
    const { signal } = ctx;

    // 人工优先：用户正在动 → 立刻让位（R7：绝不与用户抢输入）
    await this.noteProgress();
    const activity = await this.deps.userActive();
    assertNotAborted(signal);
    if (activity.active) {
      this.deps.log("检测到用户输入，本轮让位", {
        type: "chat_patrol_yield",
        phase: "yielding",
        threadKey: contact.key,
        reason: "user_active",
      });
      // 主程序仍开着：让位后秒级续盯，别掉进「未到回访时间」长睡
      this.urgentRewake = true;
      return turnDone(contact, "skipped");
    }

    // 打开会话（不劫持用户当前标签）
    await this.enter("reading", {}, { threadKey: contact.key });
    const opened = await this.deps.openContact(contact);
    assertNotAborted(signal);
    if (!opened.ok) {
      const openReason = opened.reason ?? "container_missing";
      this.deps.log(`打不开会话，跳过该联系人（${openReason}）`, {
        type: "chat_contact_open",
        phase: "reading",
        threadKey: contact.key,
        reason: openReason,
      });
      return turnDone(contact, "skipped");
    }
    // 注意：**容器可能还没定位到**（首屏还在渲染）。这不是失败 —— 就绪门禁会在一段公平的
    // 观察窗内把它等出来；把「还没渲染」当「打不开」正是「站点还没打开就结束」那个坑
    // （§0.5.3 A/H），现场表现是整片一秒就收尾。

    // **页面就绪门禁**：站点没打开完就不读、不说（§0.5.3 H「网站还没打开就结束了」）。
    // 打开会话只说明导航已发出；托管型聊天应用首屏之后还要几秒才渲染出会话容器与输入框。
    const ready = await this.deps.waitPageReady(contact);
    assertNotAborted(signal);
    await this.noteProgress();
    ctx.container = ready.containerSelector ?? opened.containerSelector;
    if (!ready.ready) {
      this.deps.log("站点尚未完全打开：本轮不读不说", {
        type: "chat_page_not_ready",
        phase: "reading",
        threadKey: contact.key,
        reason: ready.reason,
        blocked: ready.blocked,
      });
      if (ready.blocked) {
        const resumed = await this.deps.handover({ contact, reason: "chat_page_not_ready", detail: ready.reason });
        if (resumed) return turnDone(contact, "skipped");
        return { kind: "handover" };
      }
      return turnDone(contact, "skipped");
    }
    if (ctx.turn === 1) {
      this.deps.log("页面打开好了，开始看聊天", {
        type: "chat_page_ready",
        phase: "reading",
        threadKey: contact.key,
        containerSelector: ctx.container,
      });
    }

    // 读取会话（静音：不截图、不观测）。首轮尽量滚历史，避免 moreAbove 时瞎推销。
    const read = await this.deps.readConversation(contact, {
      loadHistory: ctx.turn === 1,
      previous: [],
      signal,
    });
    assertNotAborted(signal);
    await this.noteProgress();
    ctx.read = read;

    if (read.fallbackPoll) {
      // 不静默降级（§0.5.3）
      this.deps.log("事件观察不可用，已退回兜底轮询", {
        type: "chat_wait_fallback_poll",
        phase: "reading",
        threadKey: contact.key,
      });
    }
    if (!read.ok) {
      this.deps.log("会话读取未成功", {
        type: "chat_read",
        phase: "reading",
        threadKey: contact.key,
        reason: read.reason,
      });
      return turnDone(contact, "skipped");
    }
    ctx.historyIncomplete = Boolean(read.moreAbove);
    if (read.moreAbove) {
      // 拿不到的历史要如实说，绝不假装读完（§0.5.3 H）
      this.deps.log("还在往上翻更早的聊天记录", {
        type: "chat_read",
        phase: "reading",
        threadKey: contact.key,
        moreAbove: true,
        historyIncomplete: true,
      });
    }

    ctx.history = await this.deps.sentHistory(contact);
    assertNotAborted(signal);
    // 「对方还在等回话」由**会话顺序**推导（尾部那一段对方消息），而不是只认「本片新增」：
    // 上一片已读到、却没回成的消息（中断 / 停手 / 判成接管 / 片预算用尽）在下一片不再是
    // 「新增」，只认新增会让它们**永远没人回**（重启后尤其明显）。
    // `newIncoming` 仍保留在读数里供诊断对账，但**不再**是「要不要回」的判据。
    // `isOwnText`：方向没判出来的行，只要内容就是我们发过的（快照/流水指纹或已发原文），
    // 也算「我方发过话」—— 一次方向误判不该变成反复回同一句话（R7）。
    const ownThread = ctx.history?.thread ?? [];
    ctx.incoming = unansweredIncoming(read.messages, {
      isOwnText: (text) => this.isOwnSentText(text, contact, ownThread),
      // 已有发件证据时才纠「假 out」（否则冷会话会把历史出站全当成对方）
      reinterpretMislabeledOut: ownThread.length > 0,
    });
    ctx.hasNewIncoming = ctx.incoming.length > 0;
    // #region agent log
    {
      const tail = read.messages.slice(-6).map((m) => ({
        d: m.direction,
        h: String(m.text ?? "").slice(0, 40),
      }));
      agentDebugLog("H6", "engine.ts:readContact", "unanswered after read", {
        unanswered: ctx.incoming.length,
        msgCount: read.messages.length,
        ownEvidence: ownThread.length,
        tail,
      });
    }
    // #endregion
    if (ctx.hasNewIncoming && read.newIncoming.length === 0) {
      // 不静默：这批消息**不是本片新增**（上一片读到过、却没回成），照样要回 —— 说清楚
      this.deps.log("对方有消息还没回，接着回", {
        type: "chat_read",
        phase: "reading",
        threadKey: contact.key,
        unanswered: ctx.incoming.length,
      });
    }
    ctx.stage = this.deps.nextStage(contact, ctx.incoming);

    // **用户接管检测**（人工优先的一等控制）：会话里出现了「不是我方发件箱里那条」的
    // 出站消息 = 用户自己在跟这个人说话。这时引擎必须**立刻停手**，否则同一句话会被
    // 两个人各发一次（既是刷屏，也是抢话）。判不出来（附件/撤回/无文本）就**不当接管**：
    // 宁可漏判一次，也不因为一条空文本就把用户的联系人永久标成「已接管」。
    //
    // 首次读取（没有历史基线）**一律不判**：那时整段历史都会算成「新增出站」，
    // 用户以前手打的正常消息会被误判成接管 → 该联系人被永久锁死（§0.5.3 H）。
    // 本轮的读数会作为基线落进流水，下一次起才有资格判。
    if (!read.baselineKnown) {
      this.deps.log("首次读取该会话（没有历史基线）：本轮只建立基线，不判用户接管", {
        type: "chat_takeover_baseline_unknown",
        phase: "reading",
        threadKey: contact.key,
        outgoingSeen: read.newOutgoing.length,
        incomingSeen: read.newIncoming.length,
      });
    }
    // 「我方确实发过」的两道证据（**顺序不能反**：先拿到我方原文，再做接管判定）：
    //   1. 快照 `outbox` 的文本指纹 + 流水的耐久指纹（零 I/O 快路径 + 跨重启复核）；
    //   2. **我方已发原文**（`sentHistory`，上面已经取过）：站点把时间戳/已读勾混进正文时，
    //      指纹永远对不上，只有「归一化后的包含关系」还能认出自己发的那条
    //      （现场：`…聊聊吧。02:20 02:20`）。少了第 2 道，我们自己刚发的话就会被判成
    //      「不是我发的出站消息」→ 用户接管 → 永久停手。
    const ownTexts = ctx.history.thread;
    const suspected = this.detectStrangerOutgoing(contact, read.newOutgoing, {
      baselineKnown: read.baselineKnown,
      ownTexts,
    });
    let stranger = suspected;
    if (suspected && this.deps.knownSentHashes) {
      try {
        const durable = await this.deps.knownSentHashes(contact);
        stranger = this.detectStrangerOutgoing(contact, read.newOutgoing, {
          baselineKnown: read.baselineKnown,
          extraHashes: durable,
          ownTexts,
        });
      } catch {
        // 读不到证据就**不追加证据**（不是「没发过」）：判定仍按原来的保守口径走
        stranger = suspected;
      }
      assertNotAborted(signal);
    }
    // 「陌生人出站」不再永久标接管（产品面已删）。只记一条诊断，继续聊。
    if (stranger) {
      this.deps.log("会话里出现非发件箱出站消息（已忽略，不再锁死联系人）", {
        type: "chat_takeover_detected",
        phase: "reading",
        threadKey: contact.key,
        messageId: stranger.id,
        durableChecked: Boolean(suspected && this.deps.knownSentHashes),
        hint: "接管控件已移除：引擎会继续按角色回复",
      });
    }

    // 拒绝/退订不再停手（R7）：态度只进提示词上下文，由角色决定怎么继续。
    if (ctx.stage === "opted_out" || ctx.stage === "rejected") {
      this.deps.log("对方态度偏拒绝/退订：按角色继续推进（不停手）", {
        type: "chat_opted_out",
        phase: "reading",
        threadKey: contact.key,
        stage: ctx.stage,
      });
    }

    assertNotAborted(signal);

    if (ctx.incoming.length > 0) {
      const inboundCorpus = ctx.incoming
        .map((message) => String(message.text ?? ""))
        .filter((text) => text.trim())
        .join("\n");
      const ruled = await this.runTaskRulesPatrol(ctx, {
        textCorpus: inboundCorpus,
        includeDom: true,
        when: "inbound",
      });
      if (ruled) return ruled;
    }

    ctx.followUpState = await this.deps.followUpState(ctx.contact);
    assertNotAborted(signal);
    await this.noteProgress();
    return null;
  }

  /**
   * 相位 2 · 判断要不要说话（对方有新增消息 → 回；否则按回访节奏决定）。
   *
   * 返回 `null` 表示「该说，继续起草」。
   */
  private async decideWhetherToSpeak(ctx: TurnContext): Promise<TurnOutcome | null> {
    const { signal } = ctx;

    await this.enter("deciding", {}, { threadKey: ctx.contact.key });
    // 每联系人开关（§5.7）：用户关掉了「自动聊天」→ 对方来消息也**只读不回**
    // （仍要消费未读标记，否则同一个未读每轮都把该联系人推回队列，空转）。
    if (ctx.hasNewIncoming && !autoReplyOf(ctx.contact)) {
      this.deps.log("该联系人已关闭「自动聊天」：只读不回", {
        type: "chat_auto_reply_off",
        phase: "deciding",
        threadKey: ctx.contact.key,
      });
      ctx.contact = this.consumeIncoming(ctx.contact);
      this.snapshot = upsertContact(this.snapshot, ctx.contact);
      await this.save();
      return turnDone(ctx.contact, "skipped");
    }
    if (ctx.hasNewIncoming) {
      // P2：对方连发时等一小段静默窗，合批后再起草（避免拆条追问被拆着回 / 漏看）
      await this.collectInboundBurst(ctx);
      ctx.intent = classifyTurnIntent(ctx.incoming);
      return null;
    }

    assertNotAborted(signal);

    // 冷开场：从没聊过 → 只要「自动聊天」开着就主动开口。
    // P5：历史未读完时禁止推销开场（只许接最新可见未回复，上面已处理）。
    if (isColdOpening(ctx.followUpState) && !ctx.contact.stopped) {
      if (ctx.historyIncomplete) {
        this.deps.log("历史未读完：本轮不开场推销，继续盯守", {
          type: "chat_followup_skipped",
          phase: "deciding",
          threadKey: ctx.contact.key,
          reason: "history_incomplete",
        });
        ctx.contact = this.consumeIncoming(ctx.contact);
        this.snapshot = upsertContact(this.snapshot, ctx.contact);
        await this.save();
        return turnDone(ctx.contact, "skipped");
      }
      if (!autoReplyOf(ctx.contact)) {
        this.deps.log(
          "本轮不发：该联系人已关闭「自动聊天」——在右侧联系人卡片上打开后，下次值守就会开口",
          {
            type: "chat_followup_skipped",
            phase: "deciding",
            threadKey: ctx.contact.key,
            reason: "chat_off",
          },
        );
        ctx.contact = this.consumeIncoming(ctx.contact);
        this.snapshot = upsertContact(this.snapshot, ctx.contact);
        await this.save();
        if (!ctx.read?.baselineKnown) {
          await this.deps.persist({
            contact: ctx.contact,
            newMessages: ctx.read?.messages ?? [],
            sentText: null,
            angle: null,
            stage: ctx.stage,
            error: null,
          });
        }
        return turnDone(ctx.contact, "skipped");
      }
      ctx.isFollowUp = true;
      ctx.planReason = "opening";
      ctx.intent = { kind: "continue", excerpt: "" };
      return null;
    }

    // 温热追问：对方沉默时不冷场，按角色/目标轻推（分钟级，一轮最多几句）
    if (isWithinQuietHours(this.deps.now(), this.cadence.quietHours)) {
      this.deps.log("对方没有未回复消息：静默时段内不主动追问", {
        type: "chat_followup_skipped",
        phase: "deciding",
        threadKey: ctx.contact.key,
        reason: "quiet_hours",
      });
    } else {
      const warm = planWarmSteer(ctx.followUpState, this.warmSteer, this.deps.now(), {
        sentToday: this.snapshot.counters.sentToday,
        maxPerDay: this.cadence.maxPerDay,
        chatOff: !autoReplyOf(ctx.contact),
        contactFollowUpOff: !followUpOf(ctx.contact),
      });
      if (warm.action === "send") {
        ctx.isFollowUp = true;
        ctx.planReason = "due";
        ctx.intent = { kind: "continue", excerpt: "" };
        this.deps.log(
          `对方一阵没回：准备主动追问（第 ${ctx.followUpState.followUpIndex + 1}/${this.warmSteer.maxNudges} 次）`,
          {
            type: "chat_note",
            phase: "deciding",
            threadKey: ctx.contact.key,
            reason: "due",
            followUpIndex: ctx.followUpState.followUpIndex,
          },
        );
        return null;
      }
      this.deps.log(
        warm.reason === "round_exhausted"
          ? "本轮主动追问次数已用尽：继续盯守，有新话再回"
          : warm.reason === "replied"
            ? "对方已接过话：等新消息再回，不空催"
            : warm.reason === "contact_off"
              ? "该联系人已关「主动追问」：只回话不催"
              : "对方没有未回复消息：继续盯守，到点再追问",
        {
          type: "chat_followup_skipped",
          phase: "deciding",
          threadKey: ctx.contact.key,
          reason: warm.reason,
        },
      );
    }
    ctx.contact = this.consumeIncoming(ctx.contact);
    this.snapshot = upsertContact(this.snapshot, ctx.contact);
    await this.save();
    if (!ctx.read?.baselineKnown) {
      await this.deps.persist({
        contact: ctx.contact,
        newMessages: ctx.read?.messages ?? [],
        sentText: null,
        angle: null,
        stage: ctx.stage,
        error: null,
      });
    }
    return turnDone(ctx.contact, "skipped");
  }

  /**
   * 相位 3 · 起草并通过闸门（唯一允许 LLM 的相位）。
   *
   * 返回 `null` 表示「草稿通过，可以去发」。
   */
  private async draftAndGate(ctx: TurnContext): Promise<TurnOutcome | null> {
    const { signal } = ctx;

    // 跨片待发：仅当对方没有新未回复时才续发；有新话就作废待发、优先回话（P1）。
    const pending = (ctx.contact.pendingTexts ?? []).map((t) => String(t).trim()).filter(Boolean);
    let drainPending = pending.length > 0 && !ctx.hasNewIncoming;
    if (drainPending) {
      const novel = await this.peekNovelUnanswered(ctx);
      if (novel.length > 0) {
        drainPending = false;
        ctx.incoming = [...ctx.incoming, ...novel];
        ctx.hasNewIncoming = true;
        ctx.isFollowUp = false;
        ctx.intent = classifyTurnIntent(ctx.incoming);
        this.deps.log("待发队列作废：对方有新未回复，先回话", {
          type: "chat_send_interrupted",
          phase: "drafting",
          threadKey: ctx.contact.key,
          discarded: pending.length,
          novel: novel.length,
        });
      }
    }

    if (drainPending) {
      await this.enter("drafting", {}, { threadKey: ctx.contact.key });
      ctx.draft = { text: pending[0]!, texts: pending, angle: null, costMicroUsd: 0 };
      ctx.contact = { ...ctx.contact, pendingTexts: [] };
      this.snapshot = upsertContact(this.snapshot, ctx.contact);
      await this.save();
      this.deps.log(`续发待发队列 ${pending.length} 句`, {
        type: "chat_pending_drain",
        phase: "drafting",
        threadKey: ctx.contact.key,
        count: pending.length,
      });
    } else {
      if (pending.length > 0) {
        ctx.contact = { ...ctx.contact, pendingTexts: [] };
        this.snapshot = upsertContact(this.snapshot, ctx.contact);
        await this.save();
      }
      if (!ctx.intent) {
        ctx.intent = ctx.hasNewIncoming
          ? classifyTurnIntent(ctx.incoming)
          : { kind: "continue", excerpt: "" };
      }
      // 疑似交易记账（对方要付款方式 / 成交语境）
      const inboundBlob = incomingTextOf(ctx.incoming);
      if (isPaymentAsk(inboundBlob) || isTradeSignal(inboundBlob)) {
        const nextCount = Math.max(0, Number(ctx.contact.suspectedTradeCount ?? 0)) + 1;
        ctx.contact = { ...ctx.contact, suspectedTradeCount: nextCount };
        this.snapshot = upsertContact(this.snapshot, ctx.contact);
        await this.save();
        this.deps.log(`疑似交易：${nextCount}`, {
          type: "chat_trade_signal",
          phase: "drafting",
          threadKey: ctx.contact.key,
          suspectedTradeCount: nextCount,
        });
      }
      // 付款方式：确定性只发已配置纯内容，不经模型编造
      if (ctx.intent.kind === "payment_ask") {
        await this.enter("drafting", {}, { threadKey: ctx.contact.key });
        const method = this.paymentMethods[0];
        if (!method) {
          this.deps.log("对方要付款方式，但未配置：交人工设置", {
            type: "chat_payment_unconfigured",
            phase: "drafting",
            threadKey: ctx.contact.key,
          });
          this.urgentRewake = true;
          await this.deps.handover({
            contact: ctx.contact,
            reason: "chat_payment_unconfigured",
            detail: "请在聊天设置填写 USDT/银行卡等付款方式后再继续",
          });
          return { kind: "handover" };
        }
        const plain = plainPaymentText(method);
        ctx.draft = { text: plain, texts: [plain], angle: "付款方式", costMicroUsd: 0 };
        this.deps.log("已配置付款方式：本轮只发纯付款内容", {
          type: "chat_payment_plain",
          phase: "drafting",
          threadKey: ctx.contact.key,
          label: method.label,
        });
      } else {
        if (wantsOutboundImage(ctx.intent) && this.deps.pickMedia) {
          ctx.mediaPick = this.deps.pickMedia({ excerpt: ctx.intent.excerpt }) ?? null;
          if (ctx.intent.kind === "image_request" && !ctx.mediaPick) {
            this.deps.log("图库没有对应图片，改用文字说明备图情况", {
              type: "chat_image_missing",
              phase: "drafting",
              threadKey: ctx.contact.key,
            });
          }
          if (ctx.intent.kind === "voice_video_request") {
            this.deps.log(
              ctx.mediaPick
                ? "对方要语音/视频：先发实拍、不承诺音视频"
                : "对方要语音/视频：用文字借口带过，不主动提能力缺陷",
              {
                type: "chat_media_refused",
                phase: "drafting",
                threadKey: ctx.contact.key,
                hasImage: Boolean(ctx.mediaPick),
              },
            );
          }
        }
        await this.enter("drafting", {}, { threadKey: ctx.contact.key });
        const draft = await this.generateDraft(
          ctx.contact,
          ctx.stage,
          ctx.incoming,
          ctx.history,
          ctx.isFollowUp,
          ctx.intent,
          signal,
          ctx.planReason === "opening" || ctx.planReason === "due" ? ctx.planReason : null,
        );
        assertNotAborted(signal);
        if (!draft) {
          if (ctx.mediaPick && this.deps.sendImage) {
            ctx.draft = { text: "", texts: [], angle: null, costMicroUsd: 0 };
          } else if (ctx.intent.kind === "trust_attack") {
            // 信任质疑绝不能沉默：模型连拒后发确定性短澄清，再由节奏护栏犹豫一下
            const peerLang = inferPeerReplyLanguage(ctx.incoming);
            const plain = trustFallbackText(peerLang);
            ctx.draft = { text: plain, texts: [plain], angle: "信任澄清", costMicroUsd: 0 };
            this.deps.log("信任质疑草稿失败：改用短澄清兜底", {
              type: "chat_trust_fallback",
              phase: "drafting",
              threadKey: ctx.contact.key,
              peerLang,
            });
            // #region agent log
            agentDebugLog("H-trust", "engine.ts:draftTurn", "trust fallback used", {
              peerLang,
              textHead: plain.slice(0, 60),
            });
            // #endregion
          } else {
            this.deps.log("草稿未能通过去重，本轮不发", {
              type: "chat_draft_rejected",
              phase: "drafting",
              threadKey: ctx.contact.key,
              reason: "no_passing_draft",
            });
            // 没发出去：保留未回复，秒级续盯（不要 consume 后假装已处理）
            this.urgentRewake = true;
            const soon = new Date(Date.now() + 3_000).toISOString();
            ctx.contact = { ...ctx.contact, nextCheckAt: soon };
            this.snapshot = upsertContact(this.snapshot, ctx.contact);
            await this.save();
            return turnDone(ctx.contact, "skipped");
          }
        } else {
          ctx.draft = draft;
        }
      }
    }

    // 闸门（红线 → 禁用词 → 意图 → 去重）：整批发之前先把每一句过一遍；任一红线即停。
    await this.enter("verifying", {}, { threadKey: ctx.contact.key });
    let texts = draftTextsOf(ctx.draft);
    const intent = ctx.intent ?? { kind: "continue" as const, excerpt: "" };
    const rewritten: string[] = [];
    for (const text of texts) {
      const gate = this.deps.gateSend(text);
      if (!gate.allow) {
        this.deps.log(`发送被拦：${gate.reason}`, {
          type: "chat_draft_rejected",
          phase: "verifying",
          threadKey: ctx.contact.key,
          reason: gate.kind,
          detail: gate.reason,
        });
        if (gate.kind === "redline" && gate.needHandover) {
          this.urgentRewake = true;
          await this.deps.handover({ contact: ctx.contact, reason: "chat_redline", detail: gate.reason });
          return { kind: "handover" };
        }
        this.urgentRewake = true;
        return turnDone(ctx.contact, "skipped");
      }
      const outbound = gate.rewriteText?.trim() || text;
      if (gate.rewriteText?.trim()) {
        this.deps.log("付款方式夹废话：已改成只发纯付款内容", {
          type: "chat_payment_stripped",
          phase: "verifying",
          threadKey: ctx.contact.key,
        });
      }
      if (draftViolatesIntent(outbound, intent)) {
        if (ctx.mediaPick && this.deps.sendImage) {
          ctx.draft = { text: "", texts: [], angle: ctx.draft?.angle ?? null, costMicroUsd: ctx.draft?.costMicroUsd ?? 0 };
          rewritten.length = 0;
          break;
        }
        this.deps.log("发送被拦：草稿未回应对方意图（疑似继续推销）", {
          type: "chat_draft_rejected",
          phase: "verifying",
          threadKey: ctx.contact.key,
          reason: "intent_mismatch",
          intent: intent.kind,
        });
        this.urgentRewake = true;
        return turnDone(ctx.contact, "skipped");
      }
      rewritten.push(outbound);
    }
    if (rewritten.length > 0) {
      texts = rewritten;
      ctx.draft = {
        text: rewritten[0]!,
        texts: rewritten,
        angle: ctx.draft?.angle ?? null,
        costMicroUsd: ctx.draft?.costMicroUsd ?? 0,
      };
    }

    const draftCorpus = texts.join("\n");
    const ruled = await this.runTaskRulesPatrol(ctx, {
      textCorpus: draftCorpus,
      includeDom: true,
      when: "draft",
    });
    if (ruled) return ruled;

    return null;
  }

  /**
   * 相位 4 · 发出并记账（多句连发 → 落库 → 记忆 → 计数 → 短等回复）。
   * 回信路径零节奏等待；片预算不够则把剩余句写入 `pendingTexts` 跨片续发。
   */
  private async deliverAndRecord(ctx: TurnContext): Promise<TurnOutcome> {
    const { signal } = ctx;
    const draft = ctx.draft;
    const queue = draftTextsOf(draft);
    if (!ctx.mediaPick && queue.length === 0) return turnDone(ctx.contact, "skipped");

    let lastDelivered: "sent" | "skipped" | "handover" | "aborted" = "skipped";
    let sentCount = 0;
    const sentJoined: string[] = [];

    if (ctx.mediaPick && this.deps.sendImage) {
      const delivered = await this.deliverImage(ctx.contact, ctx.mediaPick, ctx.stage, signal);
      lastDelivered = delivered;
      if (delivered === "handover") return { kind: "handover" };
      if (delivered === "aborted") return { kind: "aborted" };
      if (delivered === "sent") {
        sentCount += 1;
        sentJoined.push(`[图片:${ctx.mediaPick.label}]`);
      }
    }

    for (let i = 0; i < queue.length; i += 1) {
      assertNotAborted(signal);
      // 片预算将尽：留下剩余句，下一片优先续发（禁止话说一半就丢掉）
      if (i > 0 && ctx.sliceEnd - Date.now() < 8_000) {
        const rest = queue.slice(i);
        ctx.contact = {
          ...ctx.contact,
          pendingTexts: rest,
          stage: ctx.stage,
          followUpIndex: 0,
          nextDueAt: null,
        };
        this.snapshot = upsertContact(this.snapshot, ctx.contact);
        await this.save();
        this.deps.log(`片预算将尽：${rest.length} 句留到下一片续发`, {
          type: "chat_pending_saved",
          phase: "sending",
          threadKey: ctx.contact.key,
          remaining: rest.length,
        });
        break;
      }

      // 多句连发中途：对方若已追问，立刻停发剩余句，回去读再说（禁止盖话）
      if (i > 0) {
        const novel = await this.peekNovelUnanswered(ctx);
        if (novel.length > 0) {
          this.deps.log("连发中途对方有新话：停下剩余句，先回对方", {
            type: "chat_send_interrupted",
            phase: "sending",
            threadKey: ctx.contact.key,
            remaining: queue.length - i,
            novel: novel.length,
          });
          ctx.contact = { ...ctx.contact, pendingTexts: [] };
          this.snapshot = upsertContact(this.snapshot, ctx.contact);
          await this.save();
          break;
        }
      }

      const text = queue[i]!;
      // 人味犹豫：阅读延迟 + 同线程最小间隔（信任质疑再多想一会儿）
      const lastSentMs = ctx.contact.updatedAt ? new Date(ctx.contact.updatedAt).getTime() : null;
      const waitPlan = planSendWait({
        threadKey: ctx.contact.key,
        now: Date.now(),
        lastSentAt: Number.isFinite(lastSentMs) ? lastSentMs : null,
        incomingText: incomingTextOf(ctx.incoming),
        config: this.pacing,
      });
      let waitMs = waitPlan.waitMs;
      if (ctx.intent?.kind === "trust_attack" || ctx.intent?.kind === "direct_question") {
        waitMs = Math.max(waitMs, 2_500);
      }
      if (waitMs > 0) {
        this.deps.log(`发送前犹豫 ${Math.round(waitMs / 100) / 10}s（${waitPlan.reason}）`, {
          type: "chat_send_pacing",
          phase: "sending",
          threadKey: ctx.contact.key,
          waitMs,
          reason: waitPlan.reason,
        });
        // #region agent log
        agentDebugLog("H-pace", "engine.ts:deliverAndRecord", "send pacing wait", {
          waitMs,
          reason: waitPlan.reason,
          intent: ctx.intent?.kind ?? null,
        });
        // #endregion
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
        assertNotAborted(signal);
      }
      const delivered = await this.deliver(
        ctx.contact,
        text,
        ctx.stage,
        i === 0 ? draft?.angle ?? null : null,
        ctx.incoming,
        signal,
      );
      lastDelivered = delivered;
      if (delivered === "handover") return { kind: "handover" };
      if (delivered === "aborted") return { kind: "aborted" };
      if (delivered === "sent") {
        sentCount += 1;
        sentJoined.push(text);
      }
    }

    // 发出后排温热追问：回话/开场 → 从 0 起算下次；本次本就是追问 → 序号 +1
    const nowIso = this.deps.now();
    let nextFollowUpIndex = 0;
    let nextDueAt: string | null = null;
    if (sentCount > 0 && this.warmSteer.enabled && this.warmSteer.maxNudges > 0 && followUpOf(ctx.contact)) {
      if (ctx.planReason === "due") {
        nextFollowUpIndex = Math.min(
          this.warmSteer.maxNudges,
          Math.max(0, ctx.followUpState.followUpIndex) + 1,
        );
      } else {
        nextFollowUpIndex = 0;
      }
      if (nextFollowUpIndex < this.warmSteer.maxNudges) {
        nextDueAt = computeNextWarmDueAt(
          ctx.contact.key,
          nextFollowUpIndex,
          this.warmSteer,
          nowIso,
        );
      }
    }

    ctx.contact = this.consumeIncoming({
      ...ctx.contact,
      stage: ctx.stage,
      followUpIndex: nextFollowUpIndex,
      nextDueAt,
      ...(ctx.contact.pendingTexts?.length ? {} : { pendingTexts: [] }),
    });
    this.snapshot = upsertContact(this.snapshot, ctx.contact);
    await this.enter("recording", {}, { threadKey: ctx.contact.key });

    await this.deps.persist({
      contact: ctx.contact,
      newMessages: ctx.read?.messages ?? [],
      sentText: sentJoined.length > 0 ? sentJoined.join("\n") : null,
      angle: draft?.angle ?? null,
      stage: ctx.stage,
      error: lastDelivered === "sent" || sentCount > 0 ? null : "send_not_confirmed",
    });
    assertNotAborted(signal);

    try {
      await this.noteProgress();
      const memory = await this.deps.compactMemory(ctx.contact);
      if (memory.compacted) {
        this.deps.log("已刷新长期记忆", {
          type: "chat_memory_compacted",
          phase: "recording",
          threadKey: ctx.contact.key,
          reason: memory.reason,
          factsAdded: memory.factsAdded,
        });
      }
    } catch (error) {
      this.deps.log("记忆压缩失败（本轮不受影响）", {
        type: "chat_memory_failed",
        phase: "recording",
        threadKey: ctx.contact.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    assertNotAborted(signal);

    if (sentCount > 0) {
      this.snapshot = {
        ...this.snapshot,
        counters: {
          ...this.snapshot.counters,
          sentToday: this.snapshot.counters.sentToday + sentCount,
          sentTotal: this.snapshot.counters.sentTotal + sentCount,
          llmCallsToday: this.snapshot.counters.llmCallsToday + 1,
          costMicroUsd:
            this.snapshot.counters.costMicroUsd + Math.max(0, Math.round(draft?.costMicroUsd ?? 0)),
        },
      };
      await this.save();

      if (ctx.planReason === "opening") {
        this.deps.log("开场消息已发出", {
          type: "chat_followup_sent",
          phase: "recording",
          threadKey: ctx.contact.key,
          reason: ctx.planReason,
          bubbles: sentCount,
          nextDueAt,
        });
      } else if (ctx.planReason === "due") {
        this.deps.log("主动追问已发出", {
          type: "chat_followup_sent",
          phase: "recording",
          threadKey: ctx.contact.key,
          reason: ctx.planReason,
          bubbles: sentCount,
          followUpIndex: nextFollowUpIndex,
          nextDueAt,
        });
      }

      const cap = ctx.hasNewIncoming ? this.deps.replyWaitMs : this.deps.coldReplyWaitMs;
      const watchMs = Math.min(Math.max(0, ctx.sliceEnd - Date.now()), cap);
      // 发完先轻量重读：连发期间对方已经回了的话，MutationObserver 等不到「已经发生的变化」
      // —— 空等把片耗尽后用户看到「自动结束了」；有未回复就立刻续轮。
      const alreadyReplied = await this.peekNovelUnanswered(ctx);
      if (alreadyReplied.length > 0) {
        // 必须先进入 waiting：片内续轮从 reading 起，而 recording→reading 不在转移表里
        // （实测：重读命中后下一轮抛 chat_phase_transition_illegal，只发一条就断）
        await this.enter("waiting", {}, { threadKey: ctx.contact.key, turn: ctx.turn });
        this.deps.log("发出后发现对方已有未回复：跳过空等，顺势再读", {
          type: "chat_wait",
          phase: "waiting",
          threadKey: ctx.contact.key,
          signaledBy: "reread",
          unanswered: alreadyReplied.length,
        });
        return turnDone(ctx.contact, "sent", Date.now() < ctx.sliceEnd);
      }
      const replied = await this.waitBrieflyForReply(ctx, watchMs);
      assertNotAborted(signal);
      if (replied) {
        return turnDone(ctx.contact, "sent", Date.now() < ctx.sliceEnd);
      }
    }

    // handover / aborted 已在上面提前 return；这里只剩 sent / skipped
    return turnDone(ctx.contact, lastDelivered === "sent" ? "sent" : "skipped");
  }

  /** 读完即消费未读标记：不消费会导致同一未读把该联系人反复推回队列（空转） */
  private consumeIncoming(contact: ChatContactState): ChatContactState {
    return { ...contact, lastIncomingHash: null, updatedAt: this.deps.now() };
  }

  /**
   * 轻量重读：找出相对本轮 `ctx.incoming` **多出来的**未回复对方消息。
   * 用于连发中途打断、以及发完后避免「对方已经回了还空等 MutationObserver」。
   */
  private async peekNovelUnanswered(ctx: TurnContext): Promise<ChatMessage[]> {
    try {
      const read = await this.deps.readConversation(ctx.contact, {
        loadHistory: false,
        previous: ctx.read?.messages ?? [],
        signal: ctx.signal,
      });
      if (!read.ok) return [];
      const ownThread = ctx.history?.thread ?? [];
      const unanswered = unansweredIncoming(read.messages, {
        isOwnText: (text) => this.isOwnSentText(text, ctx.contact, ownThread),
        reinterpretMislabeledOut: ownThread.length > 0,
      });
      const known = new Set(ctx.incoming.map((message) => message.id).filter(Boolean));
      return unanswered.filter((message) => {
        if (!message.id) return true;
        return !known.has(message.id);
      });
    } catch {
      return [];
    }
  }

  /**
   * 找「不是我方发件箱发出的」出站消息（诊断用；不再永久锁死联系人）。
   *
   * 判据刻意保守，四条同时成立才算：
   *   0. **有历史基线**（`readConversation` 返回的 `baselineKnown`）：第一次读这个会话时，
   *      整段历史都会被算成「新增出站」，其中用户以前手打的消息与我们的发件箱对不上
   *      → 旧逻辑会把联系人永久锁死。无基线就不判。
   *   1. 方向必须是 `out`；
   *   2. 必须是**有文本**的正常消息；
   *   3. 内容不在「我方发过的集合」里（快照 fingerprint / 流水耐久指纹 / 原文包含比对）。
   */
  private detectStrangerOutgoing(
    contact: ChatContactState,
    newOutgoing: readonly ChatMessage[],
    opts: { baselineKnown: boolean; extraHashes?: readonly string[]; ownTexts?: readonly string[] },
  ): ChatMessage | null {
    if (!opts.baselineKnown) return null;
    if (newOutgoing.length === 0) return null;
    const message = newOutgoing[newOutgoing.length - 1]!;
    const kind = message.kind ?? "text";
    if (kind !== "text") return null;
    const text = String(message.text ?? "").trim();
    if (!text) return null;
    if (this.isOwnSentText(text, contact, opts.ownTexts ?? [], opts.extraHashes)) return null;
    return message;
  }

  /**
   * 这段文本是不是**我方发过的**（快照指纹 / 流水指纹 / 已发原文，三道任一命中即算）。
   *
   * 为什么不能只比指纹：站点把显示时间 / 已读勾混进正文（`…聊聊吧。02:20 02:20`），
   * 页面文本与草稿原文的指纹**永远不可能相等** —— 现场后果就是「自己刚发的那条被当成陌生人」，
   * 该联系人被判成「用户接管」并永久停手（§0.5.3 H）。
   */
  private isOwnSentText(
    text: string,
    contact: ChatContactState,
    ownTexts: readonly string[],
    extraHashes?: readonly string[],
  ): boolean {
    const ours = new Set(
      this.snapshot.outbox.filter((entry) => entry.threadKey === contact.key).map((entry) => entry.textHash),
    );
    for (const hash of extraHashes ?? []) ours.add(hash);
    if (ours.has(hashText(text))) return true;
    return looksLikeOwnSentText(text, ownTexts) !== null;
  }

  /**
   * 发出后守着**即时回复**（页内 MutationObserver + 定期轻量重读）。
   *
   * 为什么不能只靠观察器：Telegram 等站点对方气泡有时已经上屏、或渲染路径不触发
   * 我们绑的容器 mutation → 空等把片耗尽，用户看到「人明明回了它不理」（连贯性断掉）。
   * 观察器仍是首选（零轮询）；每隔一小段超时再 `peekNovelUnanswered` 兜底。
   */
  private async waitBrieflyForReply(ctx: TurnContext, waitMs: number): Promise<boolean> {
    const containerSelector = ctx.container;
    if (!containerSelector) return false;
    const deadline = Math.min(Date.now() + Math.max(0, waitMs), ctx.sliceEnd);
    if (deadline - Date.now() <= 1000) {
      // 预算极短：仍做一次终态重读，避免「差一秒就看到」却直接放弃
      const lastChance = await this.peekNovelUnanswered(ctx);
      return lastChance.length > 0;
    }

    await this.enter("waiting", {}, { threadKey: ctx.contact.key, turn: ctx.turn });
    /** 单次观察最长；到点无 mutation 就重读一次（秒级，不是狂轮询） */
    const peekChunkMs = Math.min(3_000, this.deps.waitTimeoutMs);

    while (Date.now() < deadline) {
      assertNotAborted(ctx.signal);
      const budget = Math.min(deadline - Date.now(), peekChunkMs);
      if (budget < 250) break;
      const result = await this.deps.waitForActivity(containerSelector, {
        timeoutMs: budget,
        signal: ctx.signal,
      });
      assertNotAborted(ctx.signal);
      await this.noteProgress();

      if (result.signal === "mutation") {
        // 可能是自己气泡晚渲染：只认「相对本轮多出来的对方未回复」
        const novel = await this.peekNovelUnanswered(ctx);
        if (novel.length > 0) {
          this.deps.log("对方回了，继续聊", {
            type: "chat_wait",
            phase: "waiting",
            threadKey: ctx.contact.key,
            signaledBy: "mutation",
            elapsedMs: result.elapsedMs,
            unanswered: novel.length,
          });
          return true;
        }
        // 噪音 mutation：继续等
        continue;
      }

      if (!result.observerAttached) {
        this.deps.log("事件观察不可用，等待未能事件驱动", {
          type: "chat_wait_fallback_poll",
          phase: "waiting",
          threadKey: ctx.contact.key,
        });
        // 观察挂不上也不装死：立刻重读一次再退出
        const novel = await this.peekNovelUnanswered(ctx);
        return novel.length > 0;
      }

      // 本段观察超时：轻量重读（对方气泡可能已在、观察器没报）
      const novel = await this.peekNovelUnanswered(ctx);
      if (novel.length > 0) {
        this.deps.log("对方回了，继续聊", {
          type: "chat_wait",
          phase: "waiting",
          threadKey: ctx.contact.key,
          signaledBy: "reread",
          unanswered: novel.length,
        });
        return true;
      }
    }

    const lastChance = await this.peekNovelUnanswered(ctx);
    if (lastChance.length > 0) {
      this.deps.log("对方回了，继续聊", {
        type: "chat_wait",
        phase: "waiting",
        threadKey: ctx.contact.key,
        signaledBy: "reread_final",
        unanswered: lastChance.length,
      });
      return true;
    }
    return false;
  }

  /**
   * P2 · 入站合批：发现未回复后再等一小段静默窗，窗内新消息并入同一批再起草。
   * 页内 MutationObserver 驱动，零轮询零截图。
   */
  private async collectInboundBurst(ctx: TurnContext): Promise<void> {
    if (!ctx.container) return;
    const configured =
      typeof this.deps.inboundQuietMs === "number" && Number.isFinite(this.deps.inboundQuietMs)
        ? Math.max(0, Math.trunc(this.deps.inboundQuietMs))
        : INBOUND_QUIET_MS;
    const quietMs = Math.min(configured, Math.max(0, ctx.sliceEnd - Date.now() - 2_000));
    if (quietMs < 500) return;

    const deadline = Date.now() + quietMs;
    while (Date.now() < deadline) {
      assertNotAborted(ctx.signal);
      const budget = Math.min(deadline - Date.now(), this.deps.waitTimeoutMs);
      if (budget < 250) break;
      const result = await this.deps.waitForActivity(ctx.container, {
        timeoutMs: budget,
        signal: ctx.signal,
      });
      assertNotAborted(ctx.signal);
      if (result.signal !== "mutation") {
        // 静默窗到点且无新动静 → 合批结束
        break;
      }
      const novel = await this.peekNovelUnanswered(ctx);
      if (novel.length === 0) continue;
      ctx.incoming = [...ctx.incoming, ...novel];
      ctx.hasNewIncoming = true;
      this.deps.log("入站合批：静默窗内又收到对方消息", {
        type: "chat_inbound_burst",
        phase: "deciding",
        threadKey: ctx.contact.key,
        added: novel.length,
        total: ctx.incoming.length,
      });
    }
  }

  /** 生成草稿：去重/意图被拒时强制重写；连续被拒即放弃（绝不硬发） */
  private async generateDraft(
    contact: ChatContactState,
    stage: ChatStage,
    incoming: readonly ChatMessage[],
    history: DedupeHistory,
    isFollowUp: boolean,
    intent: TurnIntent,
    signal: AbortSignal,
    planReason: "opening" | "due" | null = null,
  ): Promise<DraftResult | null> {
    // 温热追问只许 1 句，避免冷场时连发施压
    const maxBubbles = planReason === "due" ? 1 : maxBubblesForTurn(incoming, intent);
    const intentDirective = intentPromptDirective(intent);
    const peerLang = inferPeerReplyLanguage(incoming);
    const peerPunct = inferPeerPunctuationHabit(incoming);
    // #region agent log
    agentDebugLog("H1-H5", "engine.ts:draftOnce", "draft gates input", {
      intent: intent.kind,
      maxBubbles,
      peerLang,
      peerPunct,
      planReason,
      excerptHead: String(intent.excerpt ?? "").slice(0, 80),
    });
    // #endregion
    let rewriteHint: string | null = null;
    let attempts = 0;
    let totalCost = 0;

    while (attempts < 3 && !signal.aborted) {
      attempts += 1;
      await this.noteProgress();
      const draft = await this.deps.draft({
        contact,
        stage,
        incoming,
        history,
        rewriteHint,
        isFollowUp,
        planReason,
        intentDirective,
        maxBubbles,
        signal,
      });
      assertNotAborted(signal);

      if (!draft) {
        if (rewriteHint) continue;
        return null;
      }
      totalCost += Math.max(0, draft.costMicroUsd);
      // 引擎侧再收紧气泡数（模型偶发超发）
      const rawTexts = draftTextsOf(draft).slice(0, maxBubbles);
      if (rawTexts.length === 0) {
        if (rewriteHint) continue;
        return null;
      }

      // #region agent log
      agentDebugLog("H1-H5", "engine.ts:draftOnce:candidate", "draft candidate before gates", {
        attempts,
        intent: intent.kind,
        peerLang,
        peerPunct,
        textHeads: rawTexts.map((t) => String(t).slice(0, 60)),
        periodCount: (rawTexts.join("\n").match(/[.。]/g) ?? []).length,
        hasEmDash: /[—–]/.test(rawTexts.join("\n")),
      });
      // #endregion

      // 意图硬闸：信任攻击/提问下仍倒产品 → 强制重写（最多 2 次意图重写，计入总 attempts）
      let intentBlocked = false;
      for (const piece of rawTexts) {
        if (draftViolatesIntent(piece, intent)) {
          intentBlocked = true;
          break;
        }
      }
      if (intentBlocked) {
        // #region agent log
        agentDebugLog("H1-H2", "engine.ts:draftOnce:intent_reject", "rejected by intent gate", {
          attempts,
          intent: intent.kind,
          textHeads: rawTexts.map((t) => String(t).slice(0, 60)),
        });
        // #endregion
        this.deps.log(`草稿未回应对方意图（第 ${attempts} 次），强制重写`, {
          type: "chat_draft_rejected",
          phase: "drafting",
          threadKey: contact.key,
          reason: "intent_mismatch",
          intent: intent.kind,
        });
        if (shouldGiveUpDraft(attempts)) {
          this.deps.log("意图重写仍偏题，放弃本轮（不发产品句）", {
            type: "chat_draft_rejected",
            phase: "drafting",
            threadKey: contact.key,
            reason: "intent_give_up",
            attempts,
          });
          return null;
        }
        rewriteHint = intentRewriteHint(intent);
        continue;
      }

      // 语种硬闸：对方英文却回中文（现场）→ 强制重写，绝不发出错语种
      if (!draftMatchesPeerLanguage(rawTexts, peerLang)) {
        this.deps.log(`草稿语种与对方不一致（第 ${attempts} 次），强制重写`, {
          type: "chat_draft_rejected",
          phase: "drafting",
          threadKey: contact.key,
          reason: "language_mismatch",
          peerLang,
        });
        if (shouldGiveUpDraft(attempts)) {
          this.deps.log("语种重写仍不一致，放弃本轮（不发错语种）", {
            type: "chat_draft_rejected",
            phase: "drafting",
            threadKey: contact.key,
            reason: "language_give_up",
            attempts,
            peerLang,
          });
          return null;
        }
        rewriteHint = languageRewriteHint(peerLang);
        continue;
      }

      // 标点习惯硬闸：对方少标点却写成书面长句 → 强制重写
      if (!draftMatchesPeerPunctuation(rawTexts, peerPunct)) {
        // #region agent log
        agentDebugLog("H3-H4", "engine.ts:draftOnce:punct_reject", "rejected by punctuation gate", {
          attempts,
          peerPunct,
          textHeads: rawTexts.map((t) => String(t).slice(0, 60)),
          periodCount: (rawTexts.join("\n").match(/[.。]/g) ?? []).length,
        });
        // #endregion
        this.deps.log(`草稿标点习惯与对方不一致（第 ${attempts} 次），强制重写`, {
          type: "chat_draft_rejected",
          phase: "drafting",
          threadKey: contact.key,
          reason: "punctuation_mismatch",
          peerPunct,
        });
        if (shouldGiveUpDraft(attempts)) {
          this.deps.log("标点重写仍过书面，放弃本轮", {
            type: "chat_draft_rejected",
            phase: "drafting",
            threadKey: contact.key,
            reason: "punctuation_give_up",
            attempts,
            peerPunct,
          });
          return null;
        }
        rewriteHint = punctuationRewriteHint(peerPunct);
        continue;
      }

      // 去重按整批拼接判一次；任一句撞历史也算重复
      const joined = rawTexts.join("\n");
      const decision = checkDuplicate(joined, history);
      if (!decision.duplicate) {
        let blocked = false;
        for (const piece of rawTexts) {
          if (checkDuplicate(piece, history).duplicate) {
            blocked = true;
            break;
          }
        }
        if (!blocked) {
          // #region agent log
          agentDebugLog("H1-H5", "engine.ts:draftOnce:accept", "draft accepted after gates", {
            attempts,
            intent: intent.kind,
            peerLang,
            peerPunct,
            textHeads: rawTexts.map((t) => String(t).slice(0, 60)),
            periodCount: (rawTexts.join("\n").match(/[.。]/g) ?? []).length,
          });
          // #endregion
          return {
            text: rawTexts[0]!,
            texts: rawTexts,
            angle: draft.angle,
            costMicroUsd: totalCost,
          };
        }
      }

      this.deps.log(`草稿被去重拦下（第 ${attempts} 次）：${decision.reason}`, {
        type: "chat_draft_rejected",
        phase: "drafting",
        threadKey: contact.key,
        reason: decision.reason,
        similarity: decision.similarity,
        matched: decision.matched,
      });

      if (shouldGiveUpDraft(attempts)) {
        this.deps.log("连续重复，放弃本轮（绝不硬发）", {
          type: "chat_draft_rejected",
          phase: "drafting",
          threadKey: contact.key,
          reason: "give_up",
          attempts,
        });
        return null;
      }
      rewriteHint = decision.rewriteHint;
    }

    return null;
  }

  /**
   * 发图：幂等 + sendImage 自身 fail-closed 回读。
   */
  private async deliverImage(
    contact: ChatContactState,
    pick: { path: string; label: string },
    _stage: ChatStage,
    signal: AbortSignal,
  ): Promise<"sent" | "skipped" | "handover" | "aborted"> {
    if (!this.deps.sendImage) return "skipped";
    const marker = `[图片:${pick.label}]`;
    const turnSeq = this.snapshot.engine.progressCounter + 1;
    const threadKey = contact.key;
    const effectId = computeEffectId(threadKey, turnSeq, marker);
    const existing = findOutboxEntry(this.snapshot.outbox, effectId);
    const decision = decideSend(existing, { seenInPage: false });
    if (decision.action === "skip" || decision.action === "settle_sent") {
      this.deps.log("该图片已记过账，不重发", {
        type: "chat_outbox_reconcile",
        phase: "sending",
        threadKey,
        effectId,
      });
      return "skipped";
    }
    if (decision.action === "hand_off") {
      this.deps.log("该图片发送结果无法确认，交人工（不重发）", {
        type: "chat_send_unconfirmed",
        phase: "sending",
        threadKey,
        effectId,
      });
      const resumed = await this.deps.handover({ contact, reason: "chat_send_unconfirmed", detail: decision.reason });
      if (resumed) return "skipped";
      return "handover";
    }

    const pending = beginSend(effectId, threadKey, marker, this.deps.now(), existing);
    this.snapshot = setOutbox(this.snapshot, upsertOutbox(this.snapshot.outbox, pending));
    await this.save();
    await this.enter("sending", {}, { threadKey, effectId });

    const result = await this.deps.sendImage(contact, pick.path);
    assertNotAborted(signal);
    await this.noteProgress();

    if (!result.ok) {
      this.snapshot = setOutbox(
        this.snapshot,
        upsertOutbox(this.snapshot.outbox, markUnconfirmed(pending, this.deps.now(), result.reason ?? "发图失败")),
      );
      await this.save();
      this.deps.log("发图未成功，已标 unconfirmed（不自动重发）", {
        type: "chat_send_unconfirmed",
        phase: "sending",
        threadKey,
        effectId,
        reason: result.reason ?? "send_image_failed",
        diagnostics: result.diagnostics ?? null,
      });
      return "skipped";
    }

    this.snapshot = setOutbox(
      this.snapshot,
      upsertOutbox(this.snapshot.outbox, commitSent(pending, this.deps.now())),
    );
    await this.save();
    this.deps.log(`已发出图片「${pick.label}」`, {
      type: "chat_image_sent",
      phase: "sending",
      threadKey,
      effectId,
      label: pick.label,
    });
    return "sent";
  }

  /**
   * 发送：幂等 + 回读确认（§4.3）。
   * `unconfirmed` 一律交人工，**绝不自动重发**。
   */
  private async deliver(
    contact: ChatContactState,
    text: string,
    stage: ChatStage,
    angle: string | null,
    incoming: readonly ChatMessage[],
    signal: AbortSignal,
  ): Promise<"sent" | "skipped" | "handover" | "aborted"> {
    const turnSeq = this.snapshot.engine.progressCounter + 1;
    const threadKey = contact.key;
    const effectId = computeEffectId(threadKey, turnSeq, text);
    const textHash = hashText(text);
    const existing = findOutboxEntry(this.snapshot.outbox, effectId);

    // 页面回读对账：该内容是否已经在会话里（两边统一用 textHash 比对，别拿原文对指纹）
    let seenInPage = false;
    let probeOk = true;
    try {
      seenInPage = await this.deps.isVisibleInPage(contact, textHash);
    } catch {
      // 「探测没跑成」与「页面里确实没有」是两件事（§0.5.3 A）：前者必须 fail-closed，
      // 否则崩溃窗口里那条 pending 会被当成「没发过」直接重发 —— 那就是刷屏（R7）。
      probeOk = false;
    }
    assertNotAborted(signal);

    const decision = decideSend(existing, { seenInPage });
    // fail-closed：判定没跑成时，只要结论是「发」，就一律转人工（不猜、不重发）。
    // 只有「此前确实记过这条要发」（existing）才会走到这里 —— 新内容不依赖这个探针。
    if (!probeOk && existing && decision.action === "send") {
      this.snapshot = setOutbox(
        this.snapshot,
        upsertOutbox(
          this.snapshot.outbox,
          markUnconfirmed(existing, this.deps.now(), "页面回读探针失败，无法确认是否已发出"),
        ),
      );
      await this.save();
      this.deps.log("页面回读探针失败：按未确认处理，交人工（绝不重发）", {
        type: "chat_send_unconfirmed",
        phase: "sending",
        threadKey,
        effectId,
        reason: "probe_failed",
      });
      const resumed = await this.deps.handover({
        contact,
        reason: "chat_send_unconfirmed",
        detail: "页面回读探针失败：这条消息可能已经发出，请人工确认后再决定是否需要再发",
      });
      if (resumed) return "skipped";
      return "handover";
    }
    if (decision.action === "skip") {
      this.deps.log("该内容此前已发出，跳过（幂等）", {
        type: "chat_send",
        phase: "sending",
        threadKey,
        effectId,
        reason: decision.reason,
      });
      return "skipped";
    }
    if (decision.action === "settle_sent") {
      // 对账结论是「其实已发出」——本轮没有产生新发送，因此不计入 sent 计数
      if (existing) {
        this.snapshot = setOutbox(
          this.snapshot,
          upsertOutbox(this.snapshot.outbox, commitSent(existing, this.deps.now())),
        );
        await this.save();
      }
      this.deps.log("对账确认该内容已发出，不重发", {
        type: "chat_outbox_reconcile",
        phase: "sending",
        threadKey,
        effectId,
      });
      return "skipped";
    }
    if (decision.action === "hand_off") {
      if (existing) {
        this.snapshot = setOutbox(
          this.snapshot,
          upsertOutbox(
            this.snapshot.outbox,
            markUnconfirmed(existing, this.deps.now(), "发送结果无法确认，交人工"),
          ),
        );
        await this.save();
      }
      this.deps.log("发送结果无法确认，交人工处理（不自动重发）", {
        type: "chat_send_unconfirmed",
        phase: "sending",
        threadKey,
        effectId,
        reason: decision.reason,
      });
      const resumed = await this.deps.handover({ contact, reason: "chat_send_unconfirmed", detail: decision.reason });
      if (resumed) return "skipped";
      return "handover";
    }

    // durable-before-return：先写 outbox 再产生副作用
    const pending = beginSend(effectId, threadKey, text, this.deps.now(), existing);
    this.snapshot = setOutbox(this.snapshot, upsertOutbox(this.snapshot.outbox, pending));
    await this.save();

    await this.enter("sending", {}, { threadKey, effectId });

    const result = await this.deps.sendText(contact, text);
    assertNotAborted(signal);
    await this.noteProgress();

    if (!result.ok) {
      this.snapshot = setOutbox(
        this.snapshot,
        upsertOutbox(
          this.snapshot.outbox,
          markUnconfirmed(pending, this.deps.now(), result.reason ?? "发送失败"),
        ),
      );
      await this.save();
      this.deps.log("发送未成功，已标 unconfirmed 交人工", {
        type: "chat_send_unconfirmed",
        phase: "sending",
        threadKey,
        effectId,
        reason: result.reason ?? "send_failed",
        // 结构化诊断原样落日志：哪条选择器、哪种写法写进去了、读回多少（**不含正文**）。
        // 只留一个 `verify_mismatch` 代码，下次排查还得从零猜（§0.5.3 A）。
        diagnostics: result.diagnostics ?? null,
      });
      return "skipped";
    }

    // 回读确认：页面上能看到才算硬确认；气泡异步上屏时多试几次
    let confirmed = false;
    let confirmProbeOk = true;
    const visibilityDelaysMs = [0, 500, 1200, 2200];
    for (const delayMs of visibilityDelaysMs) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      assertNotAborted(signal);
      try {
        confirmed = await this.deps.isVisibleInPage(contact, textHash, text);
      } catch {
        confirmProbeOk = false;
        confirmed = false;
      }
      if (confirmed) break;
    }
    assertNotAborted(signal);
    await this.noteProgress();

    if (!confirmed) {
      // sendText 已 ok：输入框写过且提交后已清空 —— 这是「发出去了」的强信号。
      // 页面回读对不上多半是虚拟列表/拆节点指纹，不是没发出。
      // 再弹人工会堵死整片（现场：字已在气泡里，对方回了也不理）。
      // 记警告、按已发送落账；绝不重发（与 unconfirmed 同纪律）。
      this.snapshot = setOutbox(
        this.snapshot,
        upsertOutbox(this.snapshot.outbox, commitSent(pending, this.deps.now())),
      );
      await this.save();
      this.deps.log(
        confirmProbeOk
          ? "发送后页面回读未命中，输入框已清空：按已发送继续（不弹人工、不重发）"
          : "发送后回读探针失败，输入框已清空：按已发送继续（不弹人工、不重发）",
        {
          type: "chat_send_soft_confirm",
          phase: "sending",
          threadKey,
          effectId,
          reason: confirmProbeOk ? "not_visible_after_send" : "probe_failed_after_send",
        },
      );
      return "sent";
    }

    this.snapshot = setOutbox(
      this.snapshot,
      upsertOutbox(this.snapshot.outbox, commitSent(pending, this.deps.now())),
    );
    await this.save();
    this.deps.log("消息已发出", {
      type: "chat_send",
      phase: "sending",
      threadKey,
      effectId,
      stage,
      angle,
      textPreview: text.slice(0, 80),
      incomingCount: incoming.length,
    });
    return "sent";
  }

  /** 续跑第一步：只对账，不发消息（§4.4） */
  private async reconcileOutbox(): Promise<void> {
    const pendingEntries = this.snapshot.outbox.filter((entry) => entry.status === "pending");
    if (pendingEntries.length === 0) return;

    let changed = false;
    for (const entry of pendingEntries) {
      const contact = this.snapshot.contacts.find((c) => c.key === entry.threadKey);
      if (!contact) {
        // 找不到线程：按 unconfirmed 交人工，而不是猜（歧义即停）
        this.snapshot = setOutbox(
          this.snapshot,
          upsertOutbox(
            this.snapshot.outbox,
            markUnconfirmed(entry, this.deps.now(), "找不到对应会话，无法回读对账"),
          ),
        );
        changed = true;
        this.deps.log("对账：找不到对应会话，交人工", {
          type: "chat_outbox_reconcile",
          phase: "booting",
          threadKey: entry.threadKey,
          effectId: entry.effectId,
          outcome: "hand_off",
        });
        continue;
      }
      let visible = false;
      try {
        visible = await this.deps.isVisibleInPage(contact, entry.textHash);
      } catch {
        visible = false;
      }
      if (visible) {
        const committed = commitSent(entry, this.deps.now());
        this.snapshot = setOutbox(this.snapshot, upsertOutbox(this.snapshot.outbox, committed));
        changed = true;
        this.deps.log("对账：该内容其实已发出，不重发", {
          type: "chat_outbox_reconcile",
          phase: "booting",
          threadKey: entry.threadKey,
          effectId: entry.effectId,
          outcome: "settled_sent",
        });
      }
    }
    if (changed) await this.save();
  }

  /** 上次读取到的消息基线（现由宿主 `context_store` 持久化，引擎侧只给空基线） */
  private lastMessagesOf(_threadKey: string): readonly ChatMessage[] {
    return [];
  }
}

/**
 * 便于运行时判定某文本是否触碰红线，供宿主接线层复用。
 * 实现见 `chat_redaction.ts`（与落盘脱敏、发送闸门同一套口径，禁止各写一份）。
 */
export { isRedlineText } from "./chat_redaction.js";
