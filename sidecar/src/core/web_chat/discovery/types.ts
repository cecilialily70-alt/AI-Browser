/**
 * 发现流水线 · 契约（P5）
 *
 * 一句话边界（改本文件前先读）：
 *   **采集 → 推断 → 机器自检 → 修正**四步里，只有「推断」花 token，其余三步都是确定性代码。
 *   推断的产物是**描述符草案**（数据），绝不是可执行代码（R8）。
 *
 * 三条来自公开基准的硬规则（写死在流程里，不是建议）：
 *   1. **喂结构化事实，绝不喂 HTML**：同一任务下结构化输入 F1 ≈ 0.957，瘦身 HTML F1 ≈ 0.101
 *      （幻觉 91%）。所以 `CaptureBundle.structure` 里没有 HTML，也没有消息正文。
 *   2. **产出「可复现的声明式配置」**，不让模型现场操作页面。
 *   3. **验证必须用模型没见过的样本**，并专门抓「有结果但内容不对」的**静默失败**
 *      （位置型选择器在未见过页面上静默取错字段的比例相当高，比报错危险得多）。
 */

import type { ConnectorMessage, RowFact, ThreadListItem } from "../descriptor/types.js";

/* ————————————————————————— ① 采集（0 token） ————————————————————————— */

/** 一个候选节点的**脱敏形态**（没有任何正文，只有结构与形态） */
export interface ProbeNode {
  /** 稳定路径提示：`标签.稳定类名`（看起来是 hash 的类名已剔除） */
  path: string;
  tag: string;
  role: string | null;
  /** 稳定类名（已剔除 hash 形态；≤6 个） */
  classes: string[];
  /** 白名单属性（`data-*` / `aria-*` / `id` / `title`）；值已截断并做「数字折叠」 */
  attrs: Record<string, string>;
  /** 同级同签名兄弟数量（越大越像「列表行」） */
  siblingRepeat: number;
  /** 子级同签名重复数量（越大越像「容器」） */
  childRepeat: number;
  childCount: number;
  /** 可见文本长度（**只有长度**，不是内容） */
  textLen: number;
  /** 文本形态：latin / cjk / digits / mixed / empty —— 用来判「这里是不是正文」 */
  textShape: string;
  /** 相对视口的几何比例（0~1） */
  rect: { xRatio: number; yRatio: number; wRatio: number; hRatio: number };
  contentEditable: boolean;
  scrollable: boolean;
  isLink: boolean;
  hasMediaTag: boolean;
  clickable: boolean;
}

/** 页内采集的原始产物（**纯结构**，零正文） */
export interface RawStructureProbe {
  ok: boolean;
  reason: string | null;
  viewport: { width: number; height: number };
  nodes: ProbeNode[];
  /** 页面上实际出现过的白名单属性名（供模型知道「有哪些属性可用」） */
  attrs: string[];
  counts: {
    contentEditable: number;
    textarea: number;
    roleLog: number;
    links: number;
    buttons: number;
  };
}

/**
 * 拆分取样：采集到的行/会话分成两份。
 *
 * `shown` 给模型看（用来推断），`heldOut` **绝不给模型看**，只用于自检 —— 依据规则 3：
 * 拿采集时用过的那批样本去验证，是自我确认，验不出「在没见过的页面上静默取错字段」。
 */
export interface CaptureSamples<T> {
  shown: T[];
  heldOut: T[];
}

/**
 * 通用 DOM 读法给出的**真值行**（oracle）。
 *
 * 与 `RowFact` 同形，多加一份「通用模式认为应该是什么」的期望值：
 * 方向来自**几何 + token 启发式**（`resolveDirection`），与本描述符**无关** ——
 * 所以拿它验描述符是独立证据，不是自我确认（规则 3）。
 */
export interface OracleRow extends RowFact {
  expect: {
    /** 几何含糊时是 `unknown`：此时**不**拿它当真相去否定描述符 */
    direction: "in" | "out" | "unknown";
    contentVersion: string;
    /** 通用读法看到「有行但没文字」（附件等） */
    mediaLike: boolean;
    /** 通用读法认为是系统消息/分隔（按文本形态判，不用描述符的 exclude） */
    systemLike: boolean;
  };
}

export interface CaptureBundle {
  schemaVersion: number;
  url: string;
  host: string;
  /** 站点键（host 派生；落盘目录名用，不含用户名/账号） */
  siteKey: string;
  capturedAt: string;
  structure: RawStructureProbe;
  /**
   * 采集时定位到的**会话容器**（通用读法用的那个）。
   *
   * 自检必须用**同一个容器**再采一次（换容器就等于换了页面，验不出「选择器在真实页面上不存在」）。
   */
  container: string | null;
  /**
   * 通用 DOM 读法记下的**真值**（oracle）。
   *
   * 为什么必须有它：没有真值，AI 的猜测无法判定真伪，只能靠人肉试（这是「思路 2 结构上
   * 依赖思路 1」的原因）。
   *
   * 落盘时必须脱敏（正文只留指纹），见 `redactCaptureForDisk`。
   */
  oracle: {
    rows: CaptureSamples<OracleRow>;
    threads: CaptureSamples<ThreadListItem>;
    /** 页内渲染出来的会话总数（用于判「是不是只读到可见的几条」） */
    renderedRowCount: number;
  };
  /** 采集过程中被丢弃的东西（不静默：让用户知道为什么某段没进分析） */
  dropped: string[];
}

/* ————————————————————————— ② 推断（一次 LLM） ————————————————————————— */

/** 模型对某个字段选择的说明（视图展示「它凭什么这么选」，便于用户用修正框指挥重试） */
export interface DraftNote {
  field: string;
  reason: string;
  confidence: number;
}

export interface DescriptorDraft {
  /** 草案正文（**未**通过严格校验；由 `parseDescriptor` 决定收不收） */
  descriptor: unknown;
  notes: DraftNote[];
  /** 这一轮的分析花费（token 数由 LLM 回执给出；拿不到就 null，不假装 0） */
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
  raw: string;
}

export interface InferOptions {
  /** 站点标签（人话，进提示词） */
  siteLabel: string;
  /** 上一轮的草案（修正回路用；首轮为 null） */
  previous?: DescriptorDraft | null;
  /** 上一轮自检失败的**具体差异**（修正回路用；首轮为 null） */
  feedback?: string | null;
  /** 用户用自己的话补充的「这里不对」 */
  userNote?: string | null;
  signal?: AbortSignal;
}

/* ————————————————————————— ③ 机器自检（0 token） ————————————————————————— */

export type VerifySeverity = "fatal" | "warning";

/** 一条逐字段核对结果（**必须带期望值与实际值**，否则用户无法判断到底哪里错了） */
export interface VerifyCheck {
  /** 检查项标识（稳定英文，视图与日志都用它） */
  field: string;
  ok: boolean;
  severity: VerifySeverity;
  expected: string;
  actual: string;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  /** 草案能否通过严格校验（schema 层：键名 / 枚举 / 长度 / 脚本标记） */
  schemaOk: boolean;
  diagnostics: { path: string; reason: string }[];
  checks: VerifyCheck[];
  /**
   * **静默失败**：接口「有结果」但内容是错的（例如把 `true_` 当成了我方）。
   * 比报错危险得多，所以单列一栏。
   */
  silentFailures: VerifyCheck[];
  /** 会话列表（勾选对象）核对 */
  threads: VerifyCheck[];
  /** 这一轮自检用了多少条样本（模型没见过的部分） */
  samples: { heldOutRows: number; heldOutThreads: number };
  /** 人话结论（进修正对话框与日志） */
  summary: string;
}

/** 自检用的「真值」（来自 `CaptureBundle.oracle`，与描述符无关） */
export interface VerifyOracle {
  rows: OracleRow[];
  threads: ThreadListItem[];
}

/** 自检时描述符读出的一条（用于逐字段比对，不依赖 DOM） */
export interface VerifiedReadResult {
  ok: boolean;
  reason: string | null;
  messages: ConnectorMessage[];
  newIncoming: ConnectorMessage[];
  newOutgoing: ConnectorMessage[];
  edited: ConnectorMessage[];
  moreAbove: boolean;
}

/* ————————————————————————— ④ 决策记录（decision.jsonl） ————————————————————————— */

export type DecisionOutcome = "sent" | "skipped" | "rejected" | "handover" | "learn";

export interface DecisionRecord {
  at: string;
  /** 决策类型：草稿 / 分析 / 自检 / 保存 */
  kind: "draft" | "learn" | "verify" | "save" | "adjust";
  threadKey?: string | null;
  outcome: DecisionOutcome;
  /** 为什么是这个结果（人话；被拒时必须写清原因，否则「它当时为什么这么说」无法复盘） */
  reason: string | null;
  /** 这一轮看到的 inbound id 集合（不该落正文） */
  inboundIds?: string[];
  /** 用到的摘要代数 / 角度（不含内容） */
  summaryGeneration?: number | null;
  angle?: string | null;
  /** 花费（微美元；拿不到就 null） */
  costMicroUsd?: number | null;
}

/* ————————————————————————— 花费（只显示，不自动停机） ————————————————————————— */

/** 四个桶：读取永远 0 token；其余三个各自计价（宪法 §3.5 / 计划 §7） */
export type SpendBucket = "read" | "draft" | "memory" | "infer";

export interface SpendEntry {
  bucket: SpendBucket;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
}

export interface SpendLedger {
  /** 今日（按本地日期切） */
  today: SpendEntry[];
  /** 本次值守 */
  slice: SpendEntry[];
  /** 按联系人（key → 桶） */
  byThread: Record<string, SpendEntry[]>;
}
