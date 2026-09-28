/**
 * 页内常驻哨兵（P2）—— 事件驱动等待与出站闸门的**页内**一半（R8 第①③条）
 *
 * 为什么要有它（替代「Node 侧轮询/截图」）：
 *   - **等待必须是页内事件驱动**：`MutationObserver` 一有动静就推给 Node，Node 侧不必
 *     每秒去查询 DOM（那正是「拿轮询当等待手段」，§0.5.3 H）。
 *   - **出站闸门需要页内才能拦得住**：站点自己也会监听 Enter/点按钮。只有当我们的
 *     拦截器在**捕获阶段**挂在 document 上，才能在站点自己的处理器之前把「内容对不上」的
 *     这一次提交取消掉（`stopPropagation` + `preventDefault`）。
 *   - **绝不吞用户的按键**：闸门**只在引擎显式武装时**（`armSendGate`）才生效；
 *     未武装时它对键盘事件**一个字节都不碰** —— 用户在聊天框里敲回车永远照常发送。
 *     武装时也**只拦输入框内的回车 / 与输入框同栏的发送按钮**，不拦页内别处的 Enter。
 *
 * 生命周期纪律（坑族 J「成对销毁」）：`installChatPageAgent` 返回的句柄**必须**被释放。
 * 释放即解除 observer/listener 并把页内标记置为 disposed（此后页内不再推送，避免
 * 「引擎已经收工了，页里还在往一个不存在的回调里灌事件」）。
 */

import type { Page } from "playwright-core";

import type { SiteDescriptor } from "./types.js";

/** Node 侧注册的桥名（页内通过它把事件推回来） */
export const CHAT_AGENT_BRIDGE = "__tstChatAgentEmit";
/** 页内安装标记（重复安装是幂等的；也用于宿主辨认「这是我们装的」） */
const INSTALL_FLAG = "__tstChatAgentInstalled";
/** 出站闸门在页内的名字（Node 侧改写它来武装/解除） */
export const CHAT_SEND_GATE_KEY = "__tstChatSendGate";

export interface ChatAgentEvent {
  kind: "new_message" | "typing" | "read_receipt" | "gate_blocked" | "observer_fallback";
  /** 有新消息时带方向：`in` 才算「对方回话」（R8 第①③条，方向是结构的一部分） */
  direction: "in" | "out" | null;
  /** 被闸门拦下的原因（`gate_blocked` 时有值；**不含消息正文**） */
  reason?: string;
  /** 我方观测时间（毫秒）；**不是**页面显示的时间戳（那个一律不信） */
  at: number;
}

/** 送进页面的配置（**纯数据**：选择器 / 属性名 / 前缀字面量；没有任何函数/表达式） */
export interface ChatPageAgentConfig {
  containerSelector: string;
  rowsSelector: string;
  idAttr: string | null;
  idPrefixDirection: { out: string; in: string } | null;
  tailOut: string[];
  tailIn: string[];
  retracted: string[];
  typing: string[];
  /** 事件合并窗口：静默这么久才推一次（避免一次渲染推几十条） */
  quietMs: number;
}

export function agentConfigOf(descriptor: SiteDescriptor, containerSelector: string): ChatPageAgentConfig {
  const rows = descriptor.rows;
  return {
    containerSelector: String(containerSelector ?? "").trim(),
    rowsSelector: rows.selector,
    idAttr: rows.id?.attr ?? null,
    idPrefixDirection: rows.idPrefixDirection ?? null,
    tailOut: rows.thenTailIcons?.out ?? [],
    tailIn: rows.thenTailIcons?.in ?? [],
    retracted: rows.retractedSelectors ?? [],
    typing: descriptor.presence.typing ?? [],
    quietMs: 150,
  };
}

/* eslint-disable complexity */
/**
 * **页内**引导脚本（自包含；Playwright 序列化后送进页面）。
 *
 * 只做三件事：合并 DOM 动静 → 判方向 → 推事件；武装时拦「内容对不上的提交」。
 * 它**不读**任何用户内容送回 Node（只回 `kind` / `direction` / `reason` / `at`）。
 */
export function bootstrapChatAgent(arg: {
  emitName: string;
  gateKey: string;
  flag: string;
  config: ChatPageAgentConfig;
}): void {
  const win = window as unknown as Record<string, unknown>;
  if (win[arg.flag] === true) return;
  win[arg.flag] = true;
  const config = arg.config;
  const emit = (event: { kind: string; direction: string | null; reason?: string }): void => {
    if (win[arg.flag] !== true) return; // 已 dispose：不再推送
    const sink = win[arg.emitName] as ((payload: unknown) => void) | undefined;
    if (typeof sink !== "function") return;
    try {
      sink({ ...event, at: Date.now() });
    } catch {
      /* 桥断了就丢掉，不抛 */
    }
  };

  const normalize = (raw: string): string => String(raw ?? "").replace(/\s+/g, " ").trim();

  const container = (): Element | null => {
    if (!config.containerSelector) return null;
    try {
      return document.querySelector(config.containerSelector);
    } catch {
      return null;
    }
  };

  const composerEl = (): Element | null => {
    const root = container() ?? document;
    try {
      return root.querySelector(
        'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]',
      );
    } catch {
      return null;
    }
  };

  const composerText = (): string => {
    const el = composerEl();
    if (!el) return "";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return normalize(el.value ?? "");
    }
    return normalize((el as HTMLElement).innerText ?? el.textContent ?? "");
  };

  /** 事件是否落在输入框上（闸门只绑 composer，不吞页内别处的回车 / 点击） */
  const eventInComposer = (target: EventTarget | null): boolean => {
    const el = composerEl();
    // 页内脚本不能依赖宿主的 `Node` 全局（测试替身也可能没有）；用 nodeType 判定
    if (!el || !target || typeof target !== "object") return false;
    const node = target as { nodeType?: number; parentElement?: Element | null };
    if (typeof node.nodeType !== "number") return false;
    const asEl =
      node.nodeType === 1
        ? (target as Element)
        : node.nodeType === 3
          ? node.parentElement
          : null;
    if (!asEl) return false;
    return el === asEl || el.contains(asEl);
  };

  /** 发送按钮是否与输入框同栏（共同祖先），避免武装时误拦页内其它「发送」 */
  const sendNearComposer = (target: Element): boolean => {
    const el = composerEl();
    if (!el) return false;
    if (el.contains(target)) return true;
    let node: Element | null = target;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      if (node.contains(el)) return true;
      node = node.parentElement;
    }
    return false;
  };

  /** 一行节点是什么方向（id 前缀优先，其次尾巴图标） */
  const directionOf = (row: Element): "in" | "out" | null => {
    const prefix = config.idPrefixDirection;
    if (prefix && config.idAttr) {
      const raw = row.getAttribute(config.idAttr) ?? "";
      if (raw) {
        if (raw.indexOf(prefix.out) === 0) return "out";
        if (raw.indexOf(prefix.in) === 0) return "in";
      }
    }
    const hasAny = (selectors: string[]): boolean => {
      for (const selector of selectors) {
        try {
          if (row.matches(selector) || row.querySelector(selector)) return true;
        } catch {
          /* 选择器不合法：跳过（校验器应已拦下） */
        }
      }
      return false;
    };
    if (config.tailOut.length > 0 && hasAny(config.tailOut)) return "out";
    if (config.tailIn.length > 0 && hasAny(config.tailIn)) return "in";
    return null;
  };

  const isRetracted = (row: Element): boolean => {
    for (const selector of config.retracted) {
      try {
        if (row.matches(selector) || row.querySelector(selector)) return true;
      } catch {
        /* 同上 */
      }
    }
    return false;
  };

  let pendingNew: string | null = null;
  let pendingTyping = false;
  let timer: number | null = null;

  const flush = (): void => {
    timer = null;
    if (pendingNew !== null) {
      const direction = pendingNew;
      pendingNew = null;
      emit({ kind: "new_message", direction });
    }
    if (pendingTyping) {
      pendingTyping = false;
      emit({ kind: "typing", direction: null });
    }
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(flush, Math.max(30, config.quietMs));
  };

  const inspect = (node: Node): void => {
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!element) return;
    const scope = container();
    if (scope && !scope.contains(element)) return;
    // 正在输入
    for (const selector of config.typing) {
      try {
        if (element.matches(selector) || element.querySelector(selector)) {
          pendingTyping = true;
          break;
        }
      } catch {
        /* 同上 */
      }
    }
    // 新消息：只看「行」级节点；撤回不算「对方说了新话」
    try {
      if (element.matches(config.rowsSelector)) {
        if (!isRetracted(element)) pendingNew = directionOf(element) ?? "unknown";
        return;
      }
      if (element.querySelector(config.rowsSelector)) {
        pendingNew = pendingNew ?? "unknown";
        return;
      }
    } catch {
      /* 同上 */
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        inspect(record.target);
        continue;
      }
      for (const node of Array.from(record.addedNodes)) inspect(node);
    }
    schedule();
  });

  try {
    observer.observe(document.documentElement ?? document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch {
    // 观察不到就如实降级（Node 侧据此回落到兜底轮询，不静默）
    emit({ kind: "observer_fallback", direction: null, reason: "observe_failed" });
  }

  /** 出站闸门：**只在武装时**生效（未武装时完全不碰键盘/点击） */
  const gateAllows = (): boolean => {
    const gate = win[arg.gateKey] as { text?: string; armedAt?: number } | null | undefined;
    if (!gate || !gate.text) return true; // 没武装 → 一律放行（用户的回车照常）
    const armed = normalize(String(gate.text));
    const actual = composerText();
    if (actual === armed || (actual.length > 0 && actual.indexOf(armed) >= 0)) return true;
    emit({ kind: "gate_blocked", direction: null, reason: "composer_mismatch" });
    return false;
  };

  document.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      // 未落在输入框上的回车一律放行（R8：闸门只绑 composer）
      if (!eventInComposer(event.target)) return;
      if (!gateAllows()) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  document.addEventListener(
    "click",
    (event: MouseEvent) => {
      // 只拦「提交按钮」这一类点击；普通点击（表情、附件）不碰
      const target = event.target as Element | null;
      if (!target) return;
      const gate = win[arg.gateKey] as { armedAt?: number } | null | undefined;
      if (!gate || !gate.armedAt) return;
      if (!sendNearComposer(target)) return;
      const label = `${target.getAttribute?.("aria-label") ?? ""} ${
        target.getAttribute?.("title") ?? ""
      } ${target.getAttribute?.("data-testid") ?? ""} ${target.textContent ?? ""}`.toLowerCase();
      if (!/(send|发送)/.test(label)) return;
      if (!gateAllows()) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  // 让 Node 侧知道「页内哨兵已装好」（不是「页面就绪」——那个另有门禁）
  emit({ kind: "observer_fallback", direction: null, reason: "installed" });
}

export interface ChatPageAgentHandle {
  readonly descriptorId: string;
  readonly containerSelector: string;
  /** 武装出站闸门：此后页内会拦「输入框内容 ≠ 这条文本」的提交 */
  armSendGate(text: string): Promise<void>;
  /** 解除闸门（必须与 arm 成对；未解除会让后续提交一直被校验） */
  releaseSendGate(): Promise<void>;
  /** 成对销毁：解除 observer/listener/桥 */
  dispose(): Promise<void>;
}

export interface InstallChatPageAgentOptions {
  descriptor: SiteDescriptor;
  containerSelector: string;
  onEvent: (event: ChatAgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * 安装页内哨兵。
 *
 * 三处安装保证「导航前后都活着」：
 *   1. `exposeFunction`（桥本身在新文档里自动重建）；
 *   2. `addInitScript`（此后每次导航自动重新装）；
 *   3. 立即 `evaluate` 一次（当前已加载的文档，`addInitScript` 覆盖不到）。
 */
/**
 * Node 侧桥的**每页面注册表**。
 *
 * 为什么必须每页面只注册一次：`page.exposeFunction` 对同一个名字**重复注册会抛错**
 * （Playwright 侧 "already registered"）。而「用户当前打开的窗口」这条路径上，
 * 同一个页面会被**多片值守**反复用到 —— 第二次注册一抛错，哨兵就整条装不上，
 * 表现是「页内事件订阅静默失效」（坑族 H「静默降级」）。所以桥只注册一次，
 * 之后由**可变的分发表**把事件转给当前这一片的回调（`dispose` 即摘掉自己的回调）。
 *
 * 用 `WeakMap` 而不是 Set：页面被关掉之后条目随 GC 消失，不留全局清单。
 */
const pageBridges = new WeakMap<Page, Set<(event: ChatAgentEvent) => void>>();

function parseAgentEvent(payload: unknown): ChatAgentEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as { kind?: unknown; direction?: unknown; reason?: unknown; at?: unknown };
  const kind = String(raw.kind ?? "");
  if (
    kind !== "new_message" &&
    kind !== "typing" &&
    kind !== "read_receipt" &&
    kind !== "gate_blocked" &&
    kind !== "observer_fallback"
  ) {
    return null;
  }
  if (kind === "observer_fallback" && raw.reason === "installed") return null; // 安装确认不进事件流
  return {
    kind,
    direction: raw.direction === "in" || raw.direction === "out" ? raw.direction : null,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    at: typeof raw.at === "number" ? raw.at : Date.now(),
  };
}

/** 取（或建）该页面的桥；**一个页面一个桥**，回调集合可变 */
async function ensurePageBridge(page: Page): Promise<Set<(event: ChatAgentEvent) => void>> {
  const existing = pageBridges.get(page);
  if (existing) return existing;
  const listeners = new Set<(event: ChatAgentEvent) => void>();
  pageBridges.set(page, listeners);
  await page.exposeFunction(CHAT_AGENT_BRIDGE, (payload: unknown) => {
    const event = parseAgentEvent(payload);
    if (!event) return;
    // 快照后分发：某个订阅者在回调里摘掉自己不该影响其余订阅者
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch {
        /* 单个订阅者出错拖垮分发是更坏的结果：这里吞掉，由订阅者自己留痕 */
      }
    }
  });
  return listeners;
}

export async function installChatPageAgent(
  page: Page,
  options: InstallChatPageAgentOptions,
): Promise<ChatPageAgentHandle> {
  const config = agentConfigOf(options.descriptor, options.containerSelector);
  const handle = { disposed: false };

  const listeners = await ensurePageBridge(page);
  const deliver = (event: ChatAgentEvent): void => {
    if (handle.disposed) return;
    options.onEvent(event);
  };
  listeners.add(deliver);

  const bootstrapArg = {
    emitName: CHAT_AGENT_BRIDGE,
    gateKey: CHAT_SEND_GATE_KEY,
    flag: INSTALL_FLAG,
    config,
  };
  await page.addInitScript(bootstrapChatAgent, bootstrapArg);
  try {
    await page.evaluate(bootstrapChatAgent, bootstrapArg);
  } catch {
    // 当前文档还没就绪也不能算失败（`addInitScript` 会在下次导航兜住）；如实继续
  }

  return {
    descriptorId: options.descriptor.id,
    containerSelector: config.containerSelector,

    async armSendGate(text: string): Promise<void> {
      await page
        .evaluate(
          (arg: { key: string; value: { text: string; armedAt: number } }) => {
            (window as unknown as Record<string, unknown>)[arg.key] = arg.value;
          },
          { key: CHAT_SEND_GATE_KEY, value: { text: String(text ?? ""), armedAt: Date.now() } },
        )
        .catch(() => undefined);
    },

    async releaseSendGate(): Promise<void> {
      await page
        .evaluate((key: string) => {
          (window as unknown as Record<string, unknown>)[key] = null;
        }, CHAT_SEND_GATE_KEY)
        .catch(() => undefined);
    },

    async dispose(): Promise<void> {
      handle.disposed = true;
      // 页内先停（此后不再推送），再让 Node 侧放手 —— 顺序反了会有「推给已销毁句柄」的窗口
      await page
        .evaluate(
          (arg: { flag: string; gateKey: string }) => {
            (window as unknown as Record<string, unknown>)[arg.flag] = "disposed";
            (window as unknown as Record<string, unknown>)[arg.gateKey] = null;
          },
          { flag: INSTALL_FLAG, gateKey: CHAT_SEND_GATE_KEY },
        )
        .catch(() => undefined);
    },
  };
}
