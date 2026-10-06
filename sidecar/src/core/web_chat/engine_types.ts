/**
 * 聊天引擎的**对外类型**（引擎依赖契约 · 选项 · 运行结果 · 发送闸门判定）。
 *
 * 为什么单独一个文件：`engine.ts` 曾经 1500+ 行，其中近 200 行是纯类型声明，
 * 把相位状态机的读写埋进类型噪音里（§9 代码健康）。这里**只放类型**，不放任何行为；
 * 依赖契约的文档注释跟着类型一起搬过来，避免「契约在 A 文件、实现注释在 B 文件」。
 */
import type { CadenceConfig, FollowUpState } from "./cadence.js";
import type { DedupeHistory } from "./dedupe.js";
import type { PacingConfig } from "./pacing.js";
import type { ChatContactState, ChatStage, ChatStateSnapshot } from "./state.js";
import type { ChatMessage } from "./conversation_extract.js";

/** 发送前闸门判定 */
export type ChatSendGateResult =
  | { allow: true; rewriteText?: string }
  | { allow: false; kind: "redline"; reason: string; needHandover: boolean }
  | { allow: false; kind: "banned"; reason: string };

/** 引擎依赖（全部注入；实现见宿主接线层） */
export interface ChatEngineDeps {
  now: () => string;

  /**
   * 打开/定位该联系人的会话（不劫持用户当前标签）。
   *
   * `ok` 的含义**只有一条**：「导航已发出 / 列表项已点到」，**不表示**页面已经就绪 ——
   * 因此 `containerSelector` 允许为 `null`（首屏还在渲染，容器还没出现）。
   * 把它当成「打不开会话」就会退回到「站点还没打开就结束」那个坑（§0.5.3 A/H）：
   * 容器由下面的就绪门禁在一段公平观察窗内等出来。
   */
  openContact: (contact: ChatContactState) => Promise<{ ok: boolean; containerSelector: string | null; reason?: string }>;
  /**
   * **页面就绪门禁**：站点是否真的打开完了（§0.5.3 H「网站还没打开就结束了」）。
   *
   * 打开会话只说明「导航已发出」，托管型聊天应用（SPA + WebSocket）首屏之后还要好几秒才把
   * 会话容器与输入框渲染出来。没就绪就开始读会话/说话，会读到空会话、把「暂无内容」当成
   * 「对方什么都没说」，然后照着自己的臆想发一条 —— 这正是用户看到的现象。
   *
   * 三态（禁止把「没跑成」谎报成结论）：
   *   - `ready`     ：容器与输入框就绪且渲染稳定，可以读会话；
   *   - `not_ready` ：预算内没等到（如实记原因，本轮**不读不说**，留给下一片）；
   *   - `blocked`   ：明确不是聊天页 / 登录墙 → 交人工（不要假装重试能好）。
   */
  waitPageReady: (contact: ChatContactState) => Promise<{
    ready: boolean;
    blocked: boolean;
    reason: string;
    containerSelector: string | null;
  }>;

  /** 读会话（`descriptor` 层的 `readThread` 注入形态；`newIncoming` 必填，见下） */
  readConversation: (
    contact: ChatContactState,
    options: { loadHistory: boolean; previous: readonly ChatMessage[]; signal: AbortSignal },
  ) => Promise<{
    ok: boolean;
    reason: string | null;
    containerSelector: string | null;
    messages: ChatMessage[];
    /**
     * **新增的对方消息**（结构性事实，不是「有多少新节点」）。
     *
     * 现场 BUG 的根因就在这里：老代码用不分方向的 `newCount` 判「对方回话了没有」，
     * 于是「我们自己刚发出去的那条渲染成新节点」会被当成对方回话 → 对着同一个人再回一次
     * （用户看到「只会重复给每个人发同一句话」）。方向必须是结构的一部分。
     */
    newIncoming: ChatMessage[];
    /** 新增的我方消息（幂等对账用；**绝不**用它判「对方回话了」） */
    newOutgoing: ChatMessage[];
    /**
     * 本次读取**有没有历史基线**（磁盘流水里有这个联系人的已知消息）。
     *
     * 为什么必须知道：没有基线时，**整段会话**（包括用户以前手打的那些出站消息）
     * 都会被算成「新增出站」→ 会被误判成「用户在手动聊」→ 该联系人被永久锁死
     * （§0.5.3 H「首次读数被当成用户接管」）。所以无基线时不判接管，只把这次读数
     * 当成基线记下来，下一片起才有资格判。
     */
    baselineKnown: boolean;
    /** 同一 id 但内容变了（编辑 / 撤回）：更新记忆用，**不是**新消息 */
    edited: ChatMessage[];
    moreAbove: boolean;
    fallbackPoll: boolean;
  }>;

  /** 事件等待（`wait.waitForChatActivity` 的注入形态） */
  waitForActivity: (
    containerSelector: string,
    options: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<{ signal: string; observerAttached: boolean; elapsedMs: number }>;

  /** 是否检测到用户最近有输入（人工优先） */
  userActive: () => Promise<{ active: boolean; probeAvailable: boolean }>;

  /** 读取我方已发文本（用于去重比较集：同线程 + 跨线程） */
  sentHistory: (contact: ChatContactState) => Promise<DedupeHistory>;

  /**
   * 读取「**我方确实发过**」的文本指纹（耐久证据，可选）。
   *
   * 判定「用户接管」时只认快照里的 `outbox` 是不够的：快照会丢（换环境 / 快照被判不合用 /
   * 用户只清了联系人目录），而 `outbox.jsonl` 流水不会。少了这道证据，**我们自己以前发过的
   * 那条**就会被当成陌生人出站消息 → 该联系人被永久标成「已由用户接管」（§0.5.3 H）。
   * 未实现时按空集合处理（行为与本能力引入前逐字相同）。
   */
  knownSentHashes?: (contact: ChatContactState) => Promise<readonly string[]>;

  /** 生成草稿（唯一允许 LLM 的相位） */
  draft: (input: {
    contact: ChatContactState;
    stage: ChatStage;
    incoming: readonly ChatMessage[];
    history: DedupeHistory;
    rewriteHint: string | null;
    isFollowUp: boolean;
    /** opening＝冷开场；due＝温热追问 */
    planReason?: "opening" | "due" | null;
    /** 本轮意图硬指令（信任攻击/提问等；可空） */
    intentDirective?: string | null;
    /** 本轮 texts 上限（默认 1） */
    maxBubbles?: number;
    signal: AbortSignal;
  }) => Promise<{
    text: string;
    /** 多句连发；缺省时引擎只用 text 一句 */
    texts?: string[];
    angle: string | null;
    costMicroUsd: number;
  } | null>;

  /** 发送前的红线/禁用词闸门（R1 / R2 / 词表） */
  gateSend: (text: string) => ChatSendGateResult;

  /** 拟人输入 + 发送（`action_gateway` 注入形态）；`diagnostics` 只用于落日志排查（不含正文） */
  sendText: (
    contact: ChatContactState,
    text: string,
  ) => Promise<{ ok: boolean; reason?: string; diagnostics?: Record<string, unknown> }>;

  /**
   * 从图库选一张（确定性；未实现 = 本环境没有发图能力）。
   * 返回 null 表示话术对不上任何文件，不得猜一张。
   */
  pickMedia?: (input: { excerpt: string }) => { path: string; label: string } | null;

  /** 经附件 UI 发出本地图片；未实现时引擎只走文字 */
  sendImage?: (
    contact: ChatContactState,
    filePath: string,
  ) => Promise<{ ok: boolean; reason?: string; diagnostics?: Record<string, unknown> }>;

  /** 页面回读：该内容是否已出现在会话里（`originalText` 供归一化包含兜底） */
  isVisibleInPage: (
    contact: ChatContactState,
    textHash: string,
    originalText?: string,
  ) => Promise<boolean>;

  /** 判定本轮是否有「新角度」可用（禁止空访） */
  hasNewAngle: (contact: ChatContactState, incoming: readonly ChatMessage[]) => Promise<boolean>;

  /** 落库：更新摘要 / 角度 / 流水（`context_store` 注入形态） */
  persist: (input: {
    contact: ChatContactState;
    newMessages: readonly ChatMessage[];
    sentText: string | null;
    angle: string | null;
    stage: ChatStage;
    error?: string | null;
  }) => Promise<void>;

  /**
   * 记忆压缩（滚动摘要 + 长期事实，见 `chat_memory.ts`）。
   *
   * 引擎只负责在每轮结束时**递一次机会**；要不要压缩、压多少，由纯函数 `decideCompact`
   * 按「未覆盖原始消息条数 / 代数」决定。返回结果用于如实日志，**失败不抛出**——
   * 记忆维护失败不该把这一轮聊天打断（但必须可见，不许静默）。
   */
  compactMemory: (contact: ChatContactState) => Promise<{
    compacted: boolean;
    reason: string;
    factsAdded: number;
  }>;

  /**
   * 本次值守片要检查的联系人名单（由宿主给出：**用户勾选的目标** + 已登记线程）。
   *
   * 名单的权威在用户（设置里的目标 / 勾选的会话），引擎**不自己维护名单**、更不许把
   * 快照里的旧联系人拉回来凑数：那会让「用户没勾任何人」变成「照旧挨个去聊」，
   * 也会让一条过期的接管标记把整片在 1 秒内结束（用户看到的就是「瞬间就结束」）。
   * 名单为空时引擎如实报 `no_targets`（**不是**失败，见 `ChatEngineStopReason`）。
   */
  listContacts: () => Promise<ChatContactState[]>;

  /**
   * 名单为空时的**人话原因**（可选）：直接回给用户「现在该做什么」。
   *
   * 没有它，`no_targets` 只能干说「本次没有对象可聊」——用户对着这句无从下手
   * （是没勾选？还是窗口没打开？）。原因由装配层如实提供（它才知道是哪一种），
   * 引擎只负责透传（不在引擎里猜）。
   */
  rosterNote?: () => string | null;

  /**
   * 读取该联系人的回访状态（宿主从 `visit.json` 提供）。
   * 刻意不靠 `contact.updatedAt` 猜「上次联系时间」——猜错会导致回访风暴或永不再访。
   */
  followUpState: (contact: ChatContactState) => Promise<FollowUpState>;

  /** 阶段推进（根据对方话语与自身判断决定新阶段） */
  nextStage: (contact: ChatContactState, incoming: readonly ChatMessage[]) => ChatStage;

  /** 快照落盘（原子写；返回失败必须被看见） */
  saveSnapshot: (snapshot: ChatStateSnapshot) => Promise<{ ok: boolean; error: string | null }>;

  /** 日志（`logger.chatProgress` 注入形态） */
  log: (message: string, data?: Record<string, unknown>) => void;

  /** 转人工（HITL 唯一收件箱）。返回 true = 用户在收件箱接回，可继续本片 */
  handover: (input: { contact: ChatContactState | null; reason: string; detail?: string }) => Promise<boolean | void>;

  /**
   * @ 规则巡逻（入站 / 待发草稿 + 可选 DOM）。未注入 = 本环境无 taskRules。
   */
  taskRulesPatrol?: (input: {
    contact: ChatContactState;
    textCorpus: string;
    includeDom: boolean;
    turn: number;
    signal: AbortSignal;
    when: "inbound" | "draft";
  }) => Promise<
    import("../task_rules.js").ChatTaskRulePatrolResult | null
  >;

  /** 本轮值守片时长（到点让出席位） */
  sliceMs: number;
  /** 事件等待硬超时 */
  waitTimeoutMs: number;
  /** 单轮内最多处理几个联系人 */
  maxContactsPerSlice: number;
  /**
   * 发出后等待**即时回复**的上限（人味：给对方一点回应时间，不睡死）。
   * 用于「我方是回复对方」的场景 —— 这时对话是热的，值得多等一会儿。
   */
  replyWaitMs: number;
  /**
   * 冷开场（回访/首次开口）后等回复的上限。
   * 刻意很短：没人会在几秒内回一条冷开场，等太久只是白占片时长。
   */
  coldReplyWaitMs: number;
  /**
   * 一位联系人在**一片内**最多聊几个来回。
   *
   * 这是防刷屏的硬闸（R7）：对方秒回时我们能顺势接两三轮（对话才像对话），
   * 但绝不能在一片里和一个人无限对喷。回合数只是上限，真正的停止条件是对方不再回话。
   */
  maxTurnsPerContact: number;
  /**
   * 入站合批静默窗（毫秒）：读到未回复后再等这么久，窗内新消息并入同一批再起草。
   * 缺省 5s；测例可置 0 关掉（避免吃掉 waitSignals）。
   */
  inboundQuietMs?: number;
  /**
   * 发送节奏护栏（同线程最小间隔 + 阅读延迟 + 确定性抖动）。
   *
   * **只为防封号，不为省钱、且不含任何每日上限**：它只决定「该等多久再发」，
   * 从不产生「今天不能发了」这种结论（唯一的每日口径是跨线程 `maxPerDay`，
   * 配成 `0` 即「不限」）。
   */
  pacing?: PacingConfig;
  /**
   * 已配置的付款方式（USDT/银行卡等）。空 = 对方要付款方式时交人工配置。
   * 聊天模式只许发这里的纯内容，禁止编造支付通道。
   */
  paymentMethods?: readonly import("./chat_payment.js").ChatPaymentMethod[];
}

export interface ChatEngineOptions {
  envId: string;
  profileId: number | null;
  cadence?: CadenceConfig;
  /** 引擎自己的取消控制器（不复用全局 pause 标志，避免与 Agent 抢消费） */
  signal: AbortSignal;
}

export type ChatEngineStopReason =
  | "aborted"
  /** 兼容读：历史快照/老日志里出现过；引擎**不再产出**（并发席位由宿主负责） */
  | "seat_lost"
  | "slice_elapsed"
  | "browser_closed"
  | "handover"
  /**
   * **本次没有可聊对象**（用户没勾选任何联系人 / 也没打开聊天窗口）。
   *
   * 为什么不并进 `slice_complete`：两者对宿主与用户的意义**完全不同** ——
   * `slice_complete` 是「干完活正常收工」，`no_targets` 是「这次没活可干」。
   * 混在一起时，宿主把它算成一次「失败」（挂起自动拉起），用户只看到「值守开始 1 秒后结束」
   * 而没有任何可操作的说明（现场就是这个）。它必须：① 带人话原因（`ChatEngineRunResult.note`）；
   * ② 在宿主侧是 **excusable**（不进失败计数、不挂起）。
   */
  | "no_targets"
  | "slice_complete";

export interface ChatEngineRunResult {
  stopReason: ChatEngineStopReason;
  snapshot: ChatStateSnapshot;
  processed: number;
  sent: number;
  skipped: number;
  /**
   * 给用户看的一句话（可空）。目前用于 `no_targets`：说清「为什么没对象可聊 + 现在该做什么」，
   * 由装配层提供原因（引擎自己不猜），Host 透传进片终态的 `msg`，视图据此弹提示。
   */
  note?: string | null;
}
