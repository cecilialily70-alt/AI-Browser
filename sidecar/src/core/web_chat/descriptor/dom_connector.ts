/**
 * 通用 DOM 连接器（`ChatConnector` 的实现 · P1）
 *
 * 把现有三个原语收敛到一个接口后面（**引擎从此不再知道 DOM 形状**，宪法 §0.4）：
 *   - 选站/就绪 → `site_detect.detectChatPage` + `decideChatReady`（无描述符时的通用模式）
 *     或**描述符声明的就绪门禁**（`ready.allOf` / `ready.absent`，更精确）
 *   - 打开会话 → `bu_agent/chat_actions.openContact`
 *   - 读会话   → `conversation_extract.readConversation` → `map_rows.snapshotFromMessages`
 *   - 发送     → `bu_agent/chat_actions.sendChatText`
 *
 * 纪律（改动前先读）：
 *   - **出站只走输入框**（R8 第②条）：本模块只有 `sendChatText` 一条发送路径，
 *     它走的是「真实 composer 写入 → 回读校验 → 真实回车/按钮」。这里**不提供**任何
 *     「调站点内部发送函数」或「自建网络请求」的入口，将来也不许加。
 *   - **没有描述符也能跑**（通用模式）：`descriptor === null` 时行为与今天的代码一致，
 *     所以本模块上线**不改变任何现有行为**；描述符只是让选站/方向更准。
 *   - **拿不到就说拿不到**：`waitReady` 的三态（ready / pending→超时 / blocked）与
 *     `readConversation` 的 `reason` 原样上抛，不做「看起来成功了」的包装。
 */

import type { Page } from "playwright-core";

import {
  hasVisibleSelector,
  openContact,
  readThread as readThreadGeneric,
  sendChatText,
  waitForChatReady,
  type OpenContactResult,
  type ReadThreadOptions,
} from "../../../bu_agent/chat_actions.js";
import { loadChatSitePolicy, type ChatSitePolicy } from "../site_detect.js";
import type { LoadedDescriptor } from "./registry.js";
import type {
  ChatConnector,
  ConnectorActivityEvent,
  ConnectorContact,
  ConnectorKind,
  ConnectorOpenResult,
  ConnectorReadOptions,
  ConnectorReadResult,
  ConnectorReadyResult,
  ConnectorSendResult,
  ConnectorThreadsResult,
} from "./types.js";
import { extractThreads, mapThreads } from "./threads.js";
import { mapRows, snapshotFromMessages } from "./map_rows.js";
import { containerLooksEmpty, extractThreadFacts } from "./facts.js";
import { sendViaComposer } from "./composer.js";
import {
  DEFAULT_HEALTH_POLICY,
  newConnectorHealth,
  recordHealthOutcome,
  type ConnectorHealth,
  type DescriptorHealthKind,
  type HealthPolicy,
} from "./health.js";
import { installChatPageAgent, type ChatPageAgentHandle } from "./page_agent.js";

export interface DomConnectorOptions {
  page: Page;
  /** 为 null 即**通用模式**（今天的启发式读法；行为零变化） */
  descriptor?: LoadedDescriptor | null;
  policy?: ChatSitePolicy;
  /** 就绪预算（缺省沿用 `waitForChatReady` 的 25s） */
  readyTimeoutMs?: number;
  /** 采样间隔（缺省 800ms） */
  readyIntervalMs?: number;
  /**
   * 调用方已经知道的会话容器（例如上一轮就定位到了）：直接注入，免得每次重新定位。
   * 未设置时按联系人各自缓存 `waitReady` / `openThread` 的返回值。
   */
  initialContainerSelector?: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 健康度回写口（描述符熔断/自愈的**唯一**权威在调用方；本模块只上报） */
  onHealth?: (id: string, kind: DescriptorHealthKind, decision: ReturnType<typeof recordHealthOutcome>) => void;
  healthPolicy?: HealthPolicy;
  /** 页内事件订阅（`subscribe`）的开关；缺省开（装着哨兵才有事件） */
  enablePageAgent?: boolean;
}

interface DomConnectorState {
  /** 已定位到的会话容器（按联系人缓存，避免每次重定位） */
  containers: Map<string, string>;
  agent: ChatPageAgentHandle | null;
  events: ConnectorActivityEvent[];
  /** 页内哨兵不可用（安装失败 / 页面不支持）：如实降级为「无事件」而不是假装安静 */
  agentAvailable: boolean;
  fallbackPoll: boolean;
}

function contactKey(contact: ConnectorContact): string {
  return `${contact.label}\u0000${contact.url ?? ""}`;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/** 容器内「可见子节点数 + 文本长度」——用于就绪稳定性判定（两次一致才算稳） */
async function sliceSize(page: Page, selector: string): Promise<string | null> {
  try {
    return await page.evaluate((sel: string) => {
      const root = document.querySelector(sel);
      if (!root) return null;
      let visible = 0;
      for (const child of Array.from(root.children)) {
        const rect = (child as HTMLElement).getBoundingClientRect();
        if (rect.width >= 2 && rect.height >= 2) visible += 1;
      }
      return `${visible}:${(root.textContent ?? "").length}`;
    }, selector);
  } catch {
    return null;
  }
}

/**
 * 描述符声明的就绪门禁。
 *
 * 比通用模式多两件事：① `absent`（例如二维码登录页）出现即**明确未就绪**，
 * ② 输入框按站点自己的选择器找（通用模式靠「页面下半部的可编辑元素」猜）。
 */
async function descriptorReady(
  page: Page,
  descriptor: LoadedDescriptor,
  options: DomConnectorOptions,
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<ConnectorReadyResult> {
  const spec = descriptor.descriptor.ready;
  const composerSelectors = descriptor.descriptor.composer.selectors;
  const interval = Math.max(200, options.readyIntervalMs ?? 800);
  let lastSize: string | null = null;
  let containerSelector: string | null = null;
  let composerSeen = false;

  while (now() < deadline) {
    const loaded = await page
      .evaluate(() => document.readyState === "complete")
      .catch(() => false);

    let containerFound = false;
    for (const selector of spec.allOf) {
      if (await hasVisibleSelector(page, selector)) {
        containerFound = true;
        containerSelector = containerSelector ?? selector;
      } else {
        containerFound = false;
        break;
      }
    }

    let blockedBy = "";
    for (const selector of spec.absent) {
      if (await hasVisibleSelector(page, selector)) {
        blockedBy = selector;
        break;
      }
    }

    let composerFound = false;
    for (const selector of composerSelectors) {
      if (await hasVisibleSelector(page, selector)) {
        composerFound = true;
        break;
      }
    }
    if (composerFound) composerSeen = true;

    if (containerFound && containerSelector) {
      const size = await sliceSize(page, containerSelector);
      const stable = size !== null && size === lastSize;
      lastSize = size;
      if (loaded && composerFound && stable) {
        return {
          ready: true,
          blocked: false,
          reason: `描述符 ${descriptor.descriptor.id}：容器/输入框就绪且渲染已稳定`,
          containerSelector,
        };
      }
    } else {
      lastSize = null;
    }

    if (blockedBy) {
      // 登录墙 / 二维码这类「等下去也不会好」的情形：交人工，别让用户对着重试空等
      return {
        ready: false,
        blocked: true,
        reason: `${blockedBy} 仍可见（登录页/二维码等），等下去不会变好`,
        containerSelector,
      };
    }
    if (composerSeen && !composerFound) {
      // 输入框曾经在、现在没了：可能被重渲染替换，重置稳定性，继续等（不谎报就绪）
      lastSize = null;
    }

    await sleep(interval);
  }

  return {
    ready: false,
    blocked: false,
    reason: `描述符 ${descriptor.descriptor.id}：等待就绪超时（容器 ${spec.allOf.length} 条 / 输入框 ${composerSelectors.length} 条）`,
    containerSelector,
  };
}

export function createDomConnector(options: DomConnectorOptions): ChatConnector {
  const page = options.page;
  const policy = options.policy ?? loadChatSitePolicy();
  const descriptor = options.descriptor ?? null;
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const readyTimeoutMs = Math.max(1000, options.readyTimeoutMs ?? 25_000);
  const state: DomConnectorState = {
    containers: new Map(),
    agent: null,
    events: [],
    agentAvailable: false,
    fallbackPoll: false,
  };
  const listeners = new Set<(event: ConnectorActivityEvent) => void>();
  /** 本连接器的健康度（**唯一权威**；只经 `reportHealth` 推进，别处不许再算一遍） */
  let health: ConnectorHealth | null = descriptor ? newConnectorHealth(descriptor.descriptor.id) : null;

  const kind: ConnectorKind = descriptor ? descriptor.source : "generic";

  const reportHealth = (item: LoadedDescriptor, outcome: "ok" | "shape_mismatch" | "error", reason: string | null): void => {
    if (!options.onHealth) return;
    if (!health) health = newConnectorHealth(item.descriptor.id);
    const decision = recordHealthOutcome(
      health,
      { kind: outcome, ...(reason ? { reason } : {}) },
      new Date(now()).toISOString(),
      item.source,
      options.healthPolicy ?? DEFAULT_HEALTH_POLICY,
    );
    health = decision.health;
    options.onHealth(item.descriptor.id, item.source, decision);
  };

  /** 装页内哨兵（幂等；装不上就**如实降级**，不静默说「没有事件」） */
  const ensureAgent = async (containerSelector: string): Promise<boolean> => {
    if (!descriptor) return false;
    if (options.enablePageAgent === false) return false;
    if (state.agent) return true;
    try {
      state.agent = await installChatPageAgent(page, {
        descriptor: descriptor.descriptor,
        containerSelector,
        onEvent: (event) => {
          const mapped: ConnectorActivityEvent = { kind: event.kind, direction: event.direction };
          for (const listener of listeners) {
            try {
              listener(mapped);
            } catch {
              /* 单个订阅者出错不该拖垮其它订阅者 */
            }
          }
          if (listeners.size === 0) state.events.push(mapped);
        },
      });
      state.agentAvailable = true;
      return true;
    } catch {
      state.agentAvailable = false;
      state.fallbackPoll = true;
      return false;
    }
  };

  const seeded = String(options.initialContainerSelector ?? "").trim() || null;

  const containerOf = (contact: ConnectorContact): string | null =>
    state.containers.get(contactKey(contact)) ?? seeded;

  return {
    id: descriptor?.descriptor.id ?? "generic-dom",
    kind,
    descriptorVersion: descriptor?.descriptor.version ?? null,
    hostPattern: descriptor?.descriptor.match.hostPattern ?? null,

    async waitReady(contact: ConnectorContact): Promise<ConnectorReadyResult> {
      const known = containerOf(contact);
      if (descriptor) {
        const result = await descriptorReady(
          page,
          descriptor,
          options,
          now() + readyTimeoutMs,
          now,
          sleep,
        );
        if (result.containerSelector) state.containers.set(contactKey(contact), result.containerSelector);
        return result;
      }
      const result = await waitForChatReady(page, {
        policy,
        timeoutMs: readyTimeoutMs,
        intervalMs: options.readyIntervalMs,
        containerSelector: known,
      });
      if (result.containerSelector) state.containers.set(contactKey(contact), result.containerSelector);
      return {
        ready: result.ready,
        blocked: result.blocked,
        reason: result.reason,
        containerSelector: result.containerSelector,
      };
    },

    async openThread(contact: ConnectorContact): Promise<ConnectorOpenResult> {
      let result: OpenContactResult;
      try {
        result = await openContact(
          page,
          { label: contact.label, url: contact.url, containerSelector: containerOf(contact) },
          policy,
        );
      } catch (error) {
        return {
          ok: false,
          containerSelector: null,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.containerSelector) state.containers.set(contactKey(contact), result.containerSelector);
      return {
        ok: result.ok,
        containerSelector: result.containerSelector,
        reason: result.reason ?? undefined,
      };
    },

    async readThread(contact: ConnectorContact, opts: ConnectorReadOptions): Promise<ConnectorReadResult> {
      const container = containerOf(contact);
      if (!container) {
        return emptyRead("container_missing");
      }

      // 描述符模式：走**事实包**（能看见附件 / 撤回 / 引用剔除），比通用读取器准。
      // 需要历史时先用通用读取器驱动滚动（滚动是 DOM 侧动作，与事实提取不冲突），
      // 再把**同一批 DOM** 抽一次事实 —— 这样历史与类型两者都有。
      if (descriptor) {
        if (opts.loadHistory) {
          await readThreadGeneric(page, {
            containerSelector: container,
            loadHistory: true,
            previous: [],
            policy,
            signal: opts.signal,
          }).catch(() => undefined);
        }
        const facts = await extractThreadFacts(page, {
          containerSelector: container,
          rows: descriptor.descriptor.rows,
          signal: opts.signal,
        });
        if (!facts.ok) {
          // 采不到事实：**分两种情况**——真的空会话 vs 描述符形状不匹配（§0.5.3 A）
          const empty = await containerLooksEmpty(page, container);
          const outcome = empty ? "ok" : "shape_mismatch";
          reportHealth(descriptor, outcome, `事实采集失败：${facts.reason ?? "unknown"}`);
          if (!empty) {
            // 形状不匹配：**不假装「对方没说话」**，如实报错让上层走熔断/交人工
            return emptyRead(`descriptor_shape_mismatch:${facts.reason ?? "unknown"}`);
          }
          return { ...emptyRead(null), ok: true, moreAbove: facts.moreAbove };
        }
        if (facts.rows.length === 0) {
          const empty = await containerLooksEmpty(page, container);
          if (!empty) {
            reportHealth(descriptor, "shape_mismatch", "容器有内容却一行都没匹配到（描述符可能已过时）");
            return emptyRead("descriptor_rows_not_matched");
          }
        }
        reportHealth(descriptor, "ok", null);
        const mapped = mapRows(facts.rows, descriptor.descriptor, opts.previous, policy);
        return {
          ok: true,
          reason: null,
          messages: mapped.messages,
          newIncoming: mapped.newIncoming,
          newOutgoing: mapped.newOutgoing,
          edited: mapped.edited,
          moreAbove: facts.moreAbove,
          fallbackPoll: facts.fallbackPoll || state.fallbackPoll,
        };
      }

      // 通用模式：行为与改造前**完全一致**
      const readOptions: ReadThreadOptions = {
        containerSelector: container,
        loadHistory: opts.loadHistory,
        previous: opts.previous,
        policy,
        signal: opts.signal,
      };
      const snapshot = await readThreadGeneric(page, readOptions);
      const mapped = snapshotFromMessages(snapshot.messages, null, opts.previous);

      return {
        ok: snapshot.ok,
        reason: snapshot.reason,
        messages: mapped.messages,
        newIncoming: mapped.newIncoming,
        newOutgoing: mapped.newOutgoing,
        edited: mapped.edited,
        moreAbove: snapshot.moreAbove,
        fallbackPoll: snapshot.fallbackPoll,
      };
    },

    async sendText(contact: ConnectorContact, text: string): Promise<ConnectorSendResult> {
      const container = containerOf(contact);
      if (!container) return { ok: false, reason: "container_missing" };

      if (descriptor && descriptor.descriptor.composer.selectors.length > 0) {
        // 出站闸门：先武装（页内据此拦「内容对不上的提交」），提交后**必须**解除
        const armed = await ensureAgent(container);
        if (armed) await state.agent?.armSendGate(text);
        try {
          const result = await sendViaComposer(page, descriptor.descriptor.composer, text, {
            semanticLabel: "聊天发送",
          });
          reportHealth(descriptor, result.ok ? "ok" : "error", result.reason ?? null);
          return {
            ok: result.ok,
            reason: result.reason,
            // 诊断原样上抛（装配层落日志）：写入方式链上每一步的结果都在里面，
            // 描述符写错时能直接看出「哪种写法真的写进去了」，不必再猜（§0.5.3 A）。
            diagnostics: result.diagnostics as unknown as Record<string, unknown> | undefined,
          };
        } finally {
          if (armed) await state.agent?.releaseSendGate();
        }
      }

      const result = await sendChatText(page, container, text, policy);
      return { ok: result.ok, reason: result.reason };
    },

    async subscribe(
      _contact: ConnectorContact,
      onEvent: (event: ConnectorActivityEvent) => void,
    ): Promise<(() => void) | null> {
      const container = containerOf(_contact);
      if (!descriptor || !container) return null;
      const ok = await ensureAgent(container);
      if (!ok) return null;
      // 订阅即消费：把排队的页内事件按顺序交给调用方，之后新事件直接转发
      const queued = state.events.splice(0, state.events.length);
      for (const event of queued) onEvent(event);
      listeners.add(onEvent);
      return () => {
        listeners.delete(onEvent);
      };
    },

    presence: async () => {
      // 页内事件里已经带过 typing；没有哨兵时如实返回 unknown（不猜）
      const typing = state.events.some((event) => event.kind === "typing");
      return { typing, unread: null };
    },

    /**
     * 读会话列表（「要聊的对象」勾选用）。
     *
     * **只读**：不点击、不导航、不滚动（列表本来就在左侧栏里）。读不到与「列表是空的」严格分开：
     *   - 页内结构不匹配 → `ok:false` + 描述符 `shape_mismatch`（进熔断，回落通用模式）；
     *   - 真的没有候选 → `ok:true, items:[]`（这是事实，不是失败）。
     */
    async listThreads(opts): Promise<ConnectorThreadsResult> {
      const spec = descriptor?.descriptor.threads ?? null;
      const limit = spec?.limit ?? 50;
      const probe = await extractThreads(page, { spec, limit, signal: opts?.signal });
      let baseUrl = "";
      try {
        baseUrl = page.url();
      } catch {
        baseUrl = "";
      }
      if (!probe.ok) {
        if (descriptor && probe.source === "descriptor") {
          reportHealth(descriptor, "shape_mismatch", `会话列表采集失败：${probe.reason ?? "unknown"}`);
        }
        return { ok: false, reason: probe.reason ?? "threads_unavailable", items: [], source: probe.source };
      }
      const items = mapThreads(probe.items, { baseUrl, limit });
      if (items.length === 0 && probe.items.length > 0) {
        // 采到了行却一条都不可用：这是**形状不匹配**，不是「你没有会话」
        if (descriptor) reportHealth(descriptor, "shape_mismatch", "采到会话行但一条都没有可用展示名");
        return { ok: false, reason: "threads_items_unusable", items: [], source: probe.source };
      }
      if (descriptor) reportHealth(descriptor, "ok", null);
      return { ok: true, reason: null, items, source: probe.source };
    },

    /**
     * 成对销毁：先摘订阅（此后不再分发），再让页内哨兵自己下线。
     *
     * 顺序不能反：先销毁页内再摘订阅，会有一小段「页内还在推、Node 侧还在转」的窗口。
     * 幂等（`state.agent` 清空后再调就是纯空转），失败**不抛**（收尾路径不允许因为
     * 清理失败而把整片的终态行吞掉）。
     */
    async dispose(): Promise<void> {
      listeners.clear();
      state.events.length = 0;
      const agent = state.agent;
      state.agent = null;
      state.agentAvailable = false;
      state.containers.clear();
      if (agent) await agent.dispose().catch(() => undefined);
    },
  };
}

/** 空读取的唯一样子（避免每个失败分支各写一份、字段漏掉） */
function emptyRead(reason: string | null): ConnectorReadResult {
  return {
    ok: false,
    reason,
    messages: [],
    newIncoming: [],
    newOutgoing: [],
    edited: [],
    moreAbove: false,
    fallbackPoll: false,
  };
}
