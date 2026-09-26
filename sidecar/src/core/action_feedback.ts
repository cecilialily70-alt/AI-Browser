/**
 * 动作失败结构化回执 + 失败台账（Action Failure Receipt & Ledger）
 *
 * 解决的问题：工具失败时模型只看到一句自然语言。于是它只能猜「是不是我数错 index 了」，
 * 然后原样重试同一个 index —— 用户报障里「反复点同一个位置」正是这条断链。
 *
 * 本模块做三件事，全部是**结构化信号驱动**，不靠猜：
 *   ① 分类（kind）：失败原因由失败**发生处**显式声明（`failKind`），不在事后用文案正则反推；
 *   ② 回执（hint/retryable）：每类失败给出「值不值得重试 + 下一步该干什么」的通用建议；
 *   ③ 台账（ledger）：按「目标 × 失败因」累计次数，达到上限后在**同一步的返回值里**
 *      直接写明「禁止再试 + 替代路径」，而不是等模型自己从历史里悟。
 *
 * 分类表是数据（`FAILURE_POLICY`），加一类失败只需加一行配置，不改判定逻辑。
 */

export type ActionFailureKind =
  /** 目标定位不到：index 对应的元素不存在 / 选择器已失配 */
  | "target-missing"
  /** 元素还在，但已不是观察时那一个（DOM 重排） */
  | "stale-index"
  /** 有遮挡层压住目标，且自动清障未成功 */
  | "blocked-by-overlay"
  /** 目标所在的嵌套框架已不存在（卸载 / 跳转）或不可进入（跨域） */
  | "frame-missing"
  /** 目标存在但当前不可交互：disabled / readonly / 视觉折叠且无可点代理 */
  | "not-actionable"
  /** 动作执行了但状态没变：勾选未生效 / 写入未回读 */
  | "no-effect"
  /** 页面已跳转或上下文销毁，动作目标已不在当前文档 */
  | "navigation"
  /** 框架层超时 */
  | "timeout"
  /** 人工确认被取消 */
  | "denied-by-user"
  /** 参数缺失或非法 */
  | "invalid-params"
  /**
   * 违反《搜索宪法》（自己拼接或直达搜索引擎结果页）。
   * 这类失败**不该由模型换手法重试** —— 唯一出路是改走真人路径：
   * navigate 引擎首页 → input 检索词 → 点搜索按钮或 Enter。
   */
  | "policy-violation"
  /** 当前观察质量/能力不支持该动作（如降级观察下按 index 交互） */
  | "unsupported"
  /**
   * 目标的值**只可能在用户本人手上**（邮箱/短信/验证器一次性动态码）。
   * 这类失败不该由模型换手法重试 —— 唯一出路是向用户索取或让用户接管。
   */
  | "needs-human"
  /** 工具内部异常（兜底，非预期） */
  | "tool-error";

export interface ActionFailure {
  kind: ActionFailureKind;
  /** 是否值得用**同一动作**重试；false 表示重试只会重复失败 */
  retryable: boolean;
  /** 通用下一步建议（不含任何站点文案） */
  hint: string;
  /** 结构化证据：索引 / 坐标 / 选择器 / 尝试次数等，便于日志与复盘 */
  evidence?: Record<string, unknown>;
}

interface FailurePolicy {
  retryable: boolean;
  /** 同一目标 × 同一失败因连续达到该次数后，禁止再试并给出替代路径 */
  maxAttempts: number;
  hint: string;
  /** 触顶后的替代路径说明（追加在同一动作返回值里，由 formatEscalation 统一加硬约束前缀） */
  escalateHint: string;
}

/**
 * 撞墙后的硬约束前缀。统一成一个固定 token（而不是让模型去比对「禁止原样重点」「放弃该手法」等同义词），
 * 这样 prompt 契约、日志、回执三处只有一个字符串可以对得上。
 */
export const ESCALATION_PREFIX = "禁止再试：";

export function formatEscalation(policy: FailurePolicy): string {
  return `${ESCALATION_PREFIX}${policy.escalateHint}`;
}

/**
 * 失败因 → 处置策略（数据驱动）。
 * `hint` 面向模型下一轮怎么走；`escalateHint` 面向「已经撞墙」时的强制改道。
 */
export const FAILURE_POLICY: Record<ActionFailureKind, FailurePolicy> = {
  "target-missing": {
    retryable: false,
    maxAttempts: 2,
    hint: "该 index 对应的元素已不在页面结构里。请重新观察页面后用新的 index，不要重试同一个数字。",
    escalateHint:
      "该 index 已连续定位失败：本轮禁止再对它做任何动作，改用新观察到的 index 或换入口。",
  },
  "stale-index": {
    retryable: false,
    maxAttempts: 2,
    hint: "页面结构已变化，旧 index 指到了别的元素。请重新观察页面后按新 index 操作。",
    escalateHint: "旧 index 已连续失效：禁止再引用它，先重新观察页面。",
  },
  "blocked-by-overlay": {
    retryable: true,
    maxAttempts: 3,
    hint: "目标被遮挡层压住且自动清障未成功。请先处理遮挡层本身（关闭/接受/拒绝入口），或换一个入口。",
    escalateHint:
      "同一目标已被遮挡层拦截多次：禁止原样重点同一个 index。本轮改为处理弹层（点其中的关闭/拒绝/接受入口）或改走其它入口，必要时 handover。",
  },
  "not-actionable": {
    retryable: false,
    maxAttempts: 2,
    hint: "该控件当前不可交互（禁用/只读/视觉折叠）。请找一个可交互的等价入口，或先让它进入可交互状态。",
    escalateHint: "该控件连续不可交互：本轮禁止再尝试，换等价入口。",
  },
  "frame-missing": {
    retryable: false,
    maxAttempts: 2,
    hint: "该 index 属于一个已失效的嵌套框架（或跨域不可进入）。请重新观察页面后按新 index 操作；跨域框架内的控件只能靠视觉定位或 handover。",
    escalateHint: "该框架连续不可用：本轮禁止再对该框架内的 index 做任何动作，先重新观察或用视觉/人工路径绕过。",
  },
  "no-effect": {
    retryable: true,
    maxAttempts: 3,
    hint: "动作执行了但状态没有变化。请先确认目标当前状态，再考虑换目标或先满足其前置条件。",
    escalateHint:
      "同一目标已连续出现「执行了但没生效」：禁止用同一手法重试。改用其它手法（如先聚焦再操作）或换目标，必要时 handover。",
  },
  navigation: {
    retryable: false,
    maxAttempts: 1,
    hint: "页面已跳转，动作目标不在当前文档。请按新页面的 index 继续。",
    escalateHint: "页面已跳转：旧 index 全部作废，请重新观察。",
  },
  timeout: {
    retryable: true,
    maxAttempts: 2,
    hint: "框架层等待超时。可先 wait 或滚动让目标稳定，再决定是否重试；若页面仍在加载，先重新观察。",
    escalateHint: "同一目标连续超时：放弃该手法，改用其它入口或路径。",
  },
  "denied-by-user": {
    retryable: false,
    maxAttempts: 1,
    hint: "用户取消了这一步。除非用户后续明确要求，不要重复触发同一确认。",
    escalateHint: "用户已取消该动作：本轮禁止再次触发同一确认。",
  },
  "invalid-params": {
    retryable: false,
    maxAttempts: 1,
    hint: "参数缺失或非法。请按工具目录补齐必填参数后再调用。",
    escalateHint: "参数问题不是重试能解决的：请修正参数。",
  },
  "policy-violation": {
    retryable: false,
    maxAttempts: 1,
    hint: "违反《搜索宪法》：禁止自己拼接或直达搜索引擎结果页。要检索就走真人路径 —— navigate 引擎首页（用户没指定就用 google.com），用 input 在搜索框里输入检索词，再点击搜索按钮或 send_keys(Enter)。",
    escalateHint:
      "宪法禁止直达结果页：禁止再尝试该地址或同类拼接。改走「引擎首页 → input 检索词 → 点搜索按钮/Enter」。",
  },
  unsupported: {
    retryable: false,
    maxAttempts: 1,
    hint: "当前观察质量不支持该动作。请按观察质量提示换用允许的手段（如等下一轮重观察）。",
    escalateHint: "本轮观察质量不支持按 index 交互：禁止重试，改走可用手段。",
  },
  "needs-human": {
    retryable: false,
    maxAttempts: 1,
    hint: "一次性凭证：邮箱码优先 fetch_email_otp（IMAP/临时邮，或设置中显式启用的网页邮箱；网页邮箱非默认）；短信码优先 fetch_sms_otp（须显式启用）；验证器必须 ask_user 或 handover。禁止猜测/编造/跳过，禁止改指纹。",
    escalateHint:
      "该字段不能由 AI 编造：邮箱码用 fetch_email_otp 或 ask_user；短信码用 fetch_sms_otp（已启用）或 ask_user；验证器用 ask_user / handover。",
  },
  "tool-error": {
    retryable: true,
    maxAttempts: 2,
    hint: "工具内部异常。可先把页面状态重新观察一遍再决定下一步。",
    escalateHint: "同一步骤内工具连续异常：换一条路径，必要时 handover。",
  },
};

/** 组装一条失败回执：策略查表 + 显式证据 */
export function defineFailure(
  kind: ActionFailureKind,
  evidence?: Record<string, unknown>,
): ActionFailure {
  const policy = FAILURE_POLICY[kind] ?? FAILURE_POLICY["tool-error"];
  return {
    kind,
    retryable: policy.retryable,
    hint: policy.hint,
    ...(evidence && Object.keys(evidence).length ? { evidence } : {}),
  };
}

/**
 * 框架层异常 → 失败因。
 *
 * 这里只对**框架**（Playwright）抛出的异常做兜底分类，不解析本模块自己的文案：
 * 框架错误天然没有稳定的错误码可用，只能靠 `error.name` 与「页面是否已跳转」这两个标准信号。
 * 已知失败因一律由失败发生处显式声明（见 `failKind`），不走本函数。
 */
export function classifyThrownError(
  error: unknown,
  context: { urlBefore?: string; urlNow?: string } = {},
): ActionFailureKind {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return "timeout";
  // 上下文销毁 / 页面跳转：目标已不在当前文档
  if (context.urlBefore && context.urlNow && context.urlBefore !== context.urlNow) {
    return "navigation";
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/Execution context was destroyed|Target closed|frame was detached/i.test(message)) {
    return "navigation";
  }
  if (/strict mode violation|not a valid selector|Unexpected token/i.test(message)) {
    return "invalid-params";
  }
  return "tool-error";
}

export interface FailureLedgerEntry {
  targetKey: string;
  actionName: string;
  kind: ActionFailureKind;
  attempts: number;
}

export interface RecordFailureResult {
  attempts: number;
  /** 是否已达上限：调用方应把 `escalateHint` 直接写进同一动作的返回值 */
  escalate: boolean;
  hint: string;
  escalateHint: string;
  failure: ActionFailure;
}

/**
 * 失败台账：按「目标 × 失败因」累计次数。
 *
 * 与既有的「连续失败计数 / 重复动作哈希」是互补关系：
 * 那两个看的是**动作形状**，这里看的是**目标与原因** —— 才能区分
 * 「同一个 index 被各种弹层拦了三次」（策略问题）与「同一 index 压根不存在」（观察过期）。
 */
export class FailureLedger {
  private entries = new Map<string, FailureLedgerEntry>();
  private kindByTarget = new Map<string, ActionFailureKind>();
  /**
   * 本轮累计次数（只含 kind → 次数）。
   * `reset` / `settle` 只清「禁止再试」账，不清这份累计，供结束时的失败分类看板。
   */
  private runCounts = new Map<ActionFailureKind, number>();

  private static key(targetKey: string, kind: ActionFailureKind): string {
    return `${targetKey}::${kind}`;
  }

  record(input: {
    targetKey: string;
    actionName: string;
    kind: ActionFailureKind;
    evidence?: Record<string, unknown>;
  }): RecordFailureResult {
    const key = FailureLedger.key(input.targetKey, input.kind);
    const previous = this.entries.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    this.entries.set(key, {
      targetKey: input.targetKey,
      actionName: input.actionName,
      kind: input.kind,
      attempts,
    });
    this.kindByTarget.set(input.targetKey, input.kind);
    this.runCounts.set(input.kind, (this.runCounts.get(input.kind) ?? 0) + 1);
    const policy = FAILURE_POLICY[input.kind] ?? FAILURE_POLICY["tool-error"];
    return {
      attempts,
      escalate: attempts >= policy.maxAttempts,
      hint: policy.hint,
      escalateHint: formatEscalation(policy),
      failure: defineFailure(input.kind, { ...input.evidence, attempts }),
    };
  }

  /**
   * 目标动作成功：只清该目标的「禁止再试」记录，其它目标仍有效。
   * 本轮累计次数保留（成功前发生过的失败仍计入分类）。
   */
  settle(targetKey: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${targetKey}::`)) this.entries.delete(key);
    }
    this.kindByTarget.delete(targetKey);
  }

  /** 目标已切换（页面导航等）：「禁止再试」账作废；本轮累计次数保留 */
  reset(): void {
    this.entries.clear();
    this.kindByTarget.clear();
  }

  /** 本轮动作失败次数。不含目标、选择器或任何凭证。 */
  runFailureCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [kind, count] of this.runCounts) {
      if (count > 0) out[kind] = count;
    }
    return out;
  }

  /** 供 prompt 注入的「禁止重复」提示；只输出已经撞墙的目标，避免噪音 */
  renderHints(limit = 4): string[] {
    const escalated = [...this.entries.values()]
      .filter((entry) => entry.attempts >= (FAILURE_POLICY[entry.kind]?.maxAttempts ?? 2))
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, Math.max(0, limit));
    return escalated.map((entry) => {
      const policy = FAILURE_POLICY[entry.kind];
      return `<sys>失败台账：${entry.targetKey} 的「${entry.actionName}」已因「${entry.kind}」失败 ${entry.attempts} 次。${formatEscalation(policy)}</sys>`;
    });
  }

  /** 已撞墙的目标键，供上层决定是否升级为人工接管 */
  escalatedTargets(): string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.attempts >= (FAILURE_POLICY[entry.kind]?.maxAttempts ?? 2))
      .map((entry) => entry.targetKey);
  }

  snapshot(): FailureLedgerEntry[] {
    return [...this.entries.values()];
  }
}

export function createFailureLedger(): FailureLedger {
  return new FailureLedger();
}

/**
 * 失败台账的目标键：同一控件的不同动作（click / input / select_dropdown）必须落到同一个键，
 * 否则「点不动 → 改填 → 也填不进去」会被记成两条无关的账，防死循环直接失效。
 */
export function failureTargetKey(
  kind: "index" | "point" | "selector" | "action",
  value: string | number | { x: number; y: number },
): string {
  if (kind === "point" && typeof value === "object") return `点(${value.x},${value.y})`;
  return `${kind}:${String(value)}`;
}

/** 失败回执渲染成一行（历史/日志共用同一套措辞，避免两处说法不一致） */
export interface FailureReceiptLike {
  kind?: string;
  retryable?: boolean;
}

export function formatFailureReceipt(error: string, failure?: FailureReceiptLike | null): string {
  if (!failure?.kind) return error;
  return `[${failure.kind}${failure.retryable ? " retryable" : " no-retry"}] ${error}`;
}
