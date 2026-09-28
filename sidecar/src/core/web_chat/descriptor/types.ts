/**
 * 聊天站点描述符 · 契约（宪法 §0.4 / §1.1 R8 / §4.1 / §4.2 / §0.5.3 J）
 *
 * 核心纪律（改本文件前先读）：
 *   1. **描述符是数据不是代码**：字段只能是「选择器 / 属性名 / 正则源码 / 固定枚举 / 数字 / 布尔」。
 *      没有任何位置可以放函数、表达式或脚本；运行时**零动态求值**（无 `eval` / `new Function`）。
 *   2. **出站只走真实 UI**：文字走输入框；图片走附件按钮 + 系统 file chooser 注入（`setFiles`）。
 *      不允许站点内部发送函数、不允许自建网络请求。
 *   3. **三层优先级**：`learned` > `builtin` > **通用模式**（没有描述符时的启发式读法）。
 *      描述符未命中或被健康熔断 → 回落通用模式，**不是**「什么都做不了」。
 *   4. **DOM 会隔代变异**：`rows.id.accept` 天然是**多形态**数组；`thenTailIcons` / `thenCheckIcons`
 *      是多级回退，不是可选装饰（参考实现只认一代 id 时，新版一条都匹配不到）。
 *
 * 分层：本文件只有**类型与常量**，不含 I/O、不含判断逻辑（判断在 `map_rows.ts` / `health.ts`）。
 */
import type { ChatMessage } from "../conversation_extract.js";

/* ————————————————————————— 固定枚举（唯一允许的「动作」） ————————————————————————— */

/**
 * 写入输入框的方式（枚举；**不是**任意代码）
 *
 * - `typeKeys`：**真实按键逐字输入**（拟人：全选删除 + 逐字按键）。最接近真人，富文本编辑器一律接受；
 *   聊天站点优先用它（`pressSequentially` 有节奏，也不像合成事件那样容易被站点忽略）。
 * - `selectAllBeforeInput`：合成 `beforeinput`（`inputType: insertText`）——Lexical 系富文本的写法；
 *   站点版本一变就可能整个落不进去（此时健康度会提示「请修描述符」，写入链会自动换兜底写法）。
 * - `insertText`：CDP `Input.insertText`（不经按键，直接落选区）。
 * - `fill`：Playwright 的原生 `fill`（contenteditable 走 `execCommand`，**返回值不可信**，最后才试）。
 * - `execCommand`：最老的一条路，仅作兜底。
 */
export const INPUT_METHODS = [
  "typeKeys",
  "selectAllBeforeInput",
  "insertText",
  "fill",
  "execCommand",
] as const;
export type InputMethod = (typeof INPUT_METHODS)[number];

/** 触发发送的方式（枚举；都没有站点内部发送函数这一项，见 R8） */
export const SEND_METHODS = ["enterOnce", "click", "sendThenEnter"] as const;
export type SendMethod = (typeof SEND_METHODS)[number];

/** 写入后的验收口径：`equals` 逐字相等（fail-closed 用），`nonempty` 仅非空（弱，不推荐） */
export const VERIFY_MODES = ["equals", "nonempty"] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

export type DescriptorSourceKind = "builtin" | "learned";

/** 连接器实际使用的来源（含「没有任何描述符」的通用模式） */
export type ConnectorKind = DescriptorSourceKind | "generic";

/* ————————————————————————— 描述符正文（纯声明） ————————————————————————— */

/** 单个字段的读取声明：选择器 / 属性名 / 正则源码 / 枚举 / 数字，仅此四类 */
export interface AttributeSpec {
  /** 属性名（如 `data-id`）；不是选择器 —— 直接 `getAttribute` */
  attr: string;
  /** 正则**源码**（Node 侧编译，长度受限；禁止 flags 注入） */
  pattern: string | null;
  /** 取第几个捕获组（0 = 整个匹配） */
  group: number;
}

export interface MatchSpec {
  /** host 精确匹配用正则源码（`new RegExp(source, "i")`），不做子串误伤 */
  hostPattern: string;
  /** 可选：路径线索，命中才加分（缺省不参与） */
  pathPattern: string | null;
}

/** 就绪门禁：容器必须在、且这些「不该出现的东西」必须不在 */
export interface ReadySpec {
  /**
   * 必须全部可见的选择器；**第 1 条就是「会话容器」**（读会话/量方向都以它为根）。
   *
   * 顺序有意义（不是随手排的）：就绪判定会把**第一条可见的**当作容器 —— 所以
   * 「会话面板」必须排在「侧栏 / 列表」前面，否则会把左侧会话列表当成聊天记录来读。
   * 其余条目是「确实打开了会话」的旁证。
   */
  allOf: string[];
  absent: string[];
}

export interface PeerSpec {
  /** 从消息行属性里正则取对端身份，例如 `(\d{6,})@(c\.us|g\.us)` 取第 1 组 */
  fromAttribute: AttributeSpec | null;
  /** 属性名兜底（按顺序试；只取原样值，不做正则） */
  fallbackAttrs: string[];
  /** 最后兜底：会话头部的可见文本（`digitsOnly` 时只接受纯数字段） */
  fallbackHeader: { selectors: string[]; digitsOnly: boolean } | null;
}

export interface RowsSpec {
  /** 消息行选择器 */
  selector: string;
  /** 站点自身的稳定 id（属性 + 接受形态）；`accept` 是**多形态**数组 */
  id: { attr: string; accept: string[] } | null;
  /** 从 id 文本前缀判方向（`false_` = 我方）：参考实现里最可靠的一手证据 */
  idPrefixDirection: { out: string; in: string } | null;
  /** 二级回退：行级方向标记（气泡尾巴图标；也可写「仅出向/仅入向」的类名，如 `.is-out` / `.is-in`） */
  thenTailIcons: { out: string[]; in: string[] } | null;
  /** 三级回退：**只够判「我方」**的行级标记（勾号图标，或站点自己的出向类名） */
  thenCheckIcons: { out: string[] } | null;
  /** 系统消息 / 日期分隔 / 端到端加密提示 —— 命中的行整条跳过 */
  exclude: string[];
  /** 正文候选选择器（按顺序取第一个非空） */
  textSelectors: string[];
  /**
   * 非文字内容（图片 / 语音 / 文件 / 视频）选择器。
   * 命中的行没有文本但**仍然算「对方回话」**（只记「回了」+ 类型，绝不取内容、绝不用于取码）。
   */
  attachmentSelectors: string[];
  /** 引用回复块：从正文里**排除**（否则被引原文会混进正文，重复计数并污染上下文） */
  quotedReplySelectors: string[];
  /**
   * 时间戳 / 已读勾这类**页面装饰**：从正文里排除。
   *
   * 为什么必须能声明（§0.5.3 H「自己发的消息被当成陌生人」）：很多站点把「显示时间」
   * 渲染在正文容器**内部**（Telegram Web K 的 `.message` 里就嵌着 `.time`），
   * 于是读出来的正文变成 `…聊聊吧。02:20 02:20` —— 指纹与原文对不上、
   * 去重与记忆被时间戳污染，最严重的是**我们认不出自己刚发的那条**，
   * 把它当成「不是我发的出站消息」→ 判定用户接管 → 永久停手。
   * 缺省空数组：老描述符行为不变。
   */
  timeSelectors: string[];
  /** 撤回标记（撤回后 id 仍在、文本为空 —— 不能继续拿旧文本当记忆） */
  retractedSelectors: string[];
  /** 在 `selector` 行内额外收集的 class token 来源（缺省用行自身 class） */
  tokenAttrs: string[];
  /** 该站的虚拟列表是否「插到顶部 = 更早」（影响历史合并方向） */
  insertedAtTopMeansOlder: boolean;
}

/**
 * 发图附件声明（纯选择器；缺省 null = 该站不能发图，回落 unsupported_attach）。
 *
 * 运行时走 Playwright filechooser / `setInputFiles`，不调站点内部上传 API。
 */
export interface ComposerAttachSpec {
  /** 回形针 / 附件按钮 */
  buttonSelectors: string[];
  /** 点开后若还要选「照片或视频」；可空 */
  menuItemSelectors: string[];
  /** 已挂载的 `input[type=file]`（动态创建时以 filechooser 为主，本项作兜底） */
  fileInputSelectors: string[];
  /** 选文件后预览层出现（可空：没有预览就直接点发送） */
  previewReadySelectors: string[];
  /** 预览层上的确认发送；可空则回落 `composer.send.selectors` */
  confirmSendSelectors: string[];
}

export interface ComposerSpec {
  selectors: string[];
  input: { method: InputMethod; verify: VerifyMode; retries: number; failClosed: boolean };
  send: { selectors: string[]; method: SendMethod; elseClick: boolean };
  /** null = 未声明发图能力 */
  attach: ComposerAttachSpec | null;
}

export interface HistorySpec {
  scrollRoot: string[];
  batchLimit: number;
  concurrency: number;
}

export interface PresenceSpec {
  typing: string[];
}

/**
 * 会话列表（「要聊的对象」勾选）的声明。
 *
 * 用途：视图里让用户**从页面上真实的会话列表**里勾人选谁聊，而不是让他手打昵称
 * （手打的昵称要在页面上按文本点，名字差一个字就点不中）。
 *
 * 纪律：本块**只用于读**（采集候选），绝不出现任何「点击/导航」语义 —— 采完列表由
 * `openContact` 决定怎么打开（有直链走直链，没有才按文本点列表项）。
 */
export interface ThreadsSpec {
  /**
   * 会话列表项选择器（按顺序试**第一个能选出东西的**）。
   *
   * 允许写多条是因为同一个站的列表有两代结构（例如 WebK 的 `.chatlist-chat` 与
   * 旧版的 `[data-peer-id]`）—— 一条都匹配不到时如实报「没读到列表」，不假装空列表。
   */
  itemSelectors: string[];
  /** 稳定身份属性名（如 `data-peer-id`）；取不到就退回 href / 展示名指纹 */
  keyAttr: string | null;
  /** 会话直链所在属性名（缺省 `href`；取不到即 `url=null`，由调用方按展示名在列表里点） */
  hrefAttr: string | null;
  /** 展示名候选（在项内按顺序取第一个非空文本；都没有就用整项文本前 80 字） */
  labelSelectors: string[];
  /** 未读标记（命中即 `unread=true`；读不到就当 `false`，**不猜**数字） */
  unreadSelectors: string[];
  /** 一次最多读多少条（上限由校验器夹住） */
  limit: number;
}

export interface SiteDescriptor {
  id: string;
  version: number;
  source: DescriptorSourceKind;
  match: MatchSpec;
  ready: ReadySpec;
  peer: PeerSpec;
  rows: RowsSpec;
  composer: ComposerSpec;
  history: HistorySpec;
  /** 会话列表采集声明；`null` = 不声明（视图里走通用启发式，或干脆不提供勾选） */
  threads: ThreadsSpec | null;
  presence: PresenceSpec;
}

/* ————————————————————————— 页内采集出的「结构化事实」 ————————————————————————— */

/**
 * 一行消息的**机械事实**（页内采集产物）。
 *
 * 这是描述符运行时的输入，也是**离线夹具的形态**（见 `sidecar/tests/fixtures/`）：
 * 夹具存的是这种扁平 JSON，**不是 HTML 原文** —— 依据：LLM 吃结构化事实 F1 ≈ 0.957，
 * 吃瘦身 HTML F1 ≈ 0.101（坑族 J「把 HTML 原文喂给模型」）。夹具因此可脱敏、零账号、零网络。
 */
export interface RowFact {
  /** 站点自身 id 原样值（`rows.id.attr` 的取值），无则 null */
  rawId: string | null;
  /** 正文（已剔除引用块与时间噪声、按 `textSelectors` 拼接）；可能为空（附件行） */
  text: string;
  /** 命中 `attachmentSelectors`：有内容但不是文字 */
  hasMedia: boolean;
  /** 命中 `exclude`：系统消息 / 日期分隔，整条跳过 */
  excluded: boolean;
  /** 命中 `retractedSelectors`：撤回 */
  retracted: boolean;
  /**
   * 二级方向回退：命中 `thenTailIcons.out` / `.in`（气泡尾巴图标）。
   * 图标由**页内**按描述符选择器判成这个三态，Node 侧纯函数不再碰 DOM。
   */
  tailIcon: "out" | "in" | null;
  /** 三级方向回退：命中 `thenCheckIcons.out`（勾号图标，只够判「我方」） */
  checkIcon: boolean;
  /** 行中心相对容器宽度的比例（0 左 / 1 右） */
  cxRatio: number;
  /** 行内小写 class token（去重、限量） */
  tokens: string[];
  /** 站点**显示**的时间戳原样值 —— **一律不信**（只留痕，绝不参与回访计算） */
  seenTs: string | null;
  /** 行内可见的身份线索（群聊用；1:1 多为 null） */
  identity: string | null;
}

/** 一次页内采集的完整事实包 */
export interface ThreadFacts {
  ok: boolean;
  reason: string | null;
  rows: RowFact[];
  /** 容器上方仍有未读到的历史（**绝不假装读完**） */
  moreAbove: boolean;
  /** 是否退化成页内轮询兜底（不静默降级，如实标注） */
  fallbackPoll: boolean;
}

/* ————————————————————————— 消息（比 ChatMessage 多「类型/内容版本」） ————————————————————————— */

/** 消息类型：文本 / 非文字内容 / 已撤回 */
export type ConnectorMessageKind = "text" | "media" | "retracted";

export interface ConnectorMessage extends ChatMessage {
  kind: ConnectorMessageKind;
  /**
   * 内容版本（文本指纹）。同一 id 文本变化 = 编辑 → 版本变、id 不变。
   * 去重口径：**id 为主键 + 内容版本**（不把编辑漏掉，也不把编辑当新消息）。
   */
  contentVersion: string;
}

/* ————————————————————————— 连接器接口（引擎唯一可见的面） ————————————————————————— */

export interface ConnectorContact {
  label: string;
  url: string | null;
}

export interface ConnectorReadyResult {
  ready: boolean;
  blocked: boolean;
  reason: string;
  containerSelector: string | null;
}

export interface ConnectorOpenResult {
  ok: boolean;
  containerSelector: string | null;
  reason?: string;
}

export interface ConnectorReadResult {
  ok: boolean;
  reason: string | null;
  messages: ConnectorMessage[];
  /** **结构性**修正「我方消息被当成对方回话」：只统计方向为 in 的新消息 */
  newIncoming: ConnectorMessage[];
  /** 新增的我方消息（用于幂等对账，不再靠不分方向的 `newCount`） */
  newOutgoing: ConnectorMessage[];
  /** 同一 id 但内容变了（编辑）—— 需要更新记忆，但**不是**新消息 */
  edited: ConnectorMessage[];
  moreAbove: boolean;
  fallbackPoll: boolean;
}

export interface ConnectorSendResult {
  ok: boolean;
  reason?: string;
  remoteId?: string;
  /**
   * 失败/成功时的**结构化诊断**（选择器、写法链与读回指纹；**绝不含消息正文**）。
   * 只用于落日志排查 —— 「只留一个 verify_mismatch 代码」等于下次还得猜（§0.5.3 A）。
   */
  diagnostics?: Record<string, unknown>;
}

export interface ConnectorReadOptions {
  loadHistory: boolean;
  previous: readonly ConnectorMessage[];
  signal: AbortSignal;
}

/**
 * 会话列表项（**采集产物**，不是消息）。
 *
 * `key` 是稳定身份：优先站点自己的属性（如 `data-peer-id`），否则由 href 派生，
 * 再否则由展示名指纹派生 —— 三者都拿不到就**不收这一条**（宁可少一条，也不给一个会变的 key，
 * 否则用户勾的人和真正聊的人会对不上）。
 */
export interface ThreadListItem {
  key: string;
  label: string;
  /** 会话直链（可空：很多站点的列表项没有 href，打开只能靠按展示名点列表） */
  url: string | null;
  /** 未读标记（只报「有没有未读」，**不猜数字**） */
  unread: boolean;
}

export interface ConnectorThreadsResult {
  ok: boolean;
  reason: string | null;
  items: ThreadListItem[];
  /** 候选来自描述符声明还是通用启发式（视图要能如实标注，别把猜的当准的） */
  source: "descriptor" | "generic";
}

export interface ConnectorActivityEvent {
  /** new_message | typing | read_receipt | unknown */
  kind: string;
  /** 有新消息时带上方向，便于直接判「是不是对方回话」 */
  direction: "in" | "out" | null;
}

/**
 * 引擎唯一依赖的接口（**引擎不再知道 DOM 形状**）。
 *
 * 现有 `ChatEngineDeps` 里的 `containerSelector` 这类 DOM 概念**不下沉到引擎**：
 * 由本接口在描述符层消化掉。
 */
export interface ChatConnector {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly descriptorVersion: number | null;
  readonly hostPattern: string | null;

  waitReady(contact: ConnectorContact): Promise<ConnectorReadyResult>;
  openThread(contact: ConnectorContact): Promise<ConnectorOpenResult>;
  readThread(contact: ConnectorContact, options: ConnectorReadOptions): Promise<ConnectorReadResult>;
  sendText(contact: ConnectorContact, text: string): Promise<ConnectorSendResult>;
  /**
   * 发一张本地图片（可选）。未实现或描述符没有 `composer.attach` 时
   * 返回 `ok:false, reason: unsupported_attach`。
   */
  sendImage?(contact: ConnectorContact, filePath: string): Promise<ConnectorSendResult>;
  /** 页内事件推送（首选；替代轮询）。通用模式返回 null，由调用方走兜底轮询 */
  subscribe?: (
    contact: ConnectorContact,
    onEvent: (event: ConnectorActivityEvent) => void,
  ) => Promise<(() => void) | null>;
  presence?: (contact: ConnectorContact) => Promise<{ typing: boolean; unread: number | null }>;
  /**
   * 读**会话列表**（「要聊的对象」勾选用）。
   *
   * 纪律：**只读、不点击、不导航、不滚动**。读不到就如实 `ok:false`（不说「列表是空的」）——
   * 空列表与读不到是两件事（坑族 A：判定失败不得谎报为未命中）。
   */
  listThreads?: (options?: { signal?: AbortSignal }) => Promise<ConnectorThreadsResult>;
  /**
   * **成对销毁**（坑族 H）：释放页内哨兵（observer / 桥的转发）与全部订阅。
   *
   * 调用方**必须**在一次值守收尾时调用一次：页内 `MutationObserver` 与
   * `exposeFunction` 是**页面级**资源，不释放就会留在用户的标签里（尤其「用当前打开的
   * 窗口」这条路径，那个页面不属于我们）。幂等：重复调用无副作用。
   */
  dispose?(): Promise<void>;
}
