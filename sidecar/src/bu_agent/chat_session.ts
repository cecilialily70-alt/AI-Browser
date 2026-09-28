/**
 * 聊天模式**会话装配**（§4.3：一个环境一个 run 一个 driver）。
 *
 * 职责：把 {@link ChatEngine} 需要的注入依赖，用**真实原语**装起来。
 * 引擎本身完全不认识浏览器/模型/磁盘，这里才认识。
 *
 * 落点纪律：聊天是第四种执行形态，不许塞进 `bu_agent/service.ts` 的主循环；
 * 本文件只做「接线」，不做决策（决策在 engine + 纯函数模块里）。
 */
import { createLlmClient, extractAssistantContent } from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import { resolveGateway } from "../core/action_gateway.js";
import { withLlmRetry } from "../llm_retry.js";
import {
  buildChatDraftMessages,
  looksLikeOptOut,
  looksLikeRejection,
  parseChatDraft,
} from "../core/web_chat/chat_prompt.js";
import {
  contextOf,
  conversationKeyOf,
  ensureChatPage,
  isTextInThread,
  openContact,
  readThread,
  resolveCurrentConversation,
  sendChatText,
  waitForChatReady,
  waitThreadActivity,
  type CurrentConversation,
} from "./chat_actions.js";
import { listPageThreads } from "./chat_contacts.js";
import {
  acceptAngle,
  buildChatSummaryMessages,
  decideCompact,
  mergeSummary,
  parseChatSummary,
  uncoveredMessages,
} from "../core/web_chat/chat_memory.js";
import {
  addAngle,
  addFacts,
  appendOutboxJournal,
  appendThreadMessages,
  emptyVisitState,
  ledgerToMessages,
  readAngles,
  readFacts,
  readOutboxJournal,
  readSummary,
  readThreadMessages,
  readVisitState,
  settleVisitState,
  writeSummary,
  writeVisitState,
  type VisitState,
} from "../core/web_chat/context_store.js";
import { hashText, looksLikeOwnSentText } from "../core/web_chat/outbox.js";
import { snapshotFromMessages } from "../core/web_chat/descriptor/map_rows.js";
import type {
  ConnectorActivityEvent,
  ConnectorMessage,
} from "../core/web_chat/descriptor/types.js";
import { DEFAULT_PACING } from "../core/web_chat/pacing.js";
import { ChatEngine, defaultGateSend, type ChatEngineDeps } from "../core/web_chat/engine.js";
import {
  readSnapshotFile,
  decideResume,
  writeSnapshotAtomic,
  USER_TAKEOVER_REASON,
  type ChatContactState,
  type ChatStateSnapshot,
  type ChatStage,
  type ChatTakeoverMode,
  type SnapshotReadResult,
} from "../core/web_chat/state.js";
import {
  chatSnapshotPath,
  contactFlagsOf,
  isoNow,
  parseCadence,
  parseContactSeeds,
  parseTakeovers,
  seedIdentityOf,
  takeoverOverrideOf,
  useCurrentWindowMode,
  activeRoleOf,
  type ChatContactSeed,
  type ChatSessionConfig,
} from "./chat_session_config.js";
import { createContextLayer } from "./chat_session_context.js";
import { createDescriptorLayer } from "./chat_session_descriptor.js";

export {
  activeRoleOf,
  chatSnapshotPath,
  contactFlagsOf,
  isoNow,
  parseActiveRoleId,
  parseCadence,
  parseContactFlags,
  parseContactSeeds,
  parseRoles,
  parseTakeovers,
  seedIdentityOf,
  takeoverKeyOf,
  takeoverOverrideOf,
  useCurrentWindowMode,
} from "./chat_session_config.js";
export type {
  ChatContactFlags,
  ChatContactSeed,
  ChatRole,
  ChatSessionConfig,
} from "./chat_session_config.js";
import { loadChatSitePolicy, matchChatSiteProfile, type ChatSitePolicy } from "../core/web_chat/site_detect.js";
import { detectRecentUserActivity } from "../core/web_chat/wait.js";
import type { ChatMessage } from "../core/web_chat/conversation_extract.js";
import type { JsonLogger } from "../json-logger.js";
import type { SidecarAiSettings } from "../engine.js";
import type { Browser, Page } from "playwright-core";

/**
 * 角度「还没用尽」的软上限。
 * 这是**每联系人**的复读保护阈值：用掉这么多不同角度后，视为该联系人已充分覆盖，
 * 不再主动找新话题（继续纠缠只会变成骚扰）。真正的停聊判据仍是 stage / stopped。
 */
const ANGLES_SOFT_LIMIT = 50;

/**
 * 记忆压缩时读入的流水条数上限（= `context_store.THREAD_LEDGER_LIMIT`）。
 * 与落盘上限一致即可：读超过落盘上限没有意义。
 */
const THREAD_READ_LIMIT = 400;

/**
 * abort 之后给引擎的收尾宽限：超过这么久还没落地就照样释放页内资源。
 * 理由见 `registerDispose`：页内哨兵是页面级资源，「等一个卡住的引擎」不该让它常驻。
 */
const CHAT_DISPOSE_GRACE_MS = 5_000;

/** 纯等待（可被 abort 打断）：页内事件订阅的 Node 侧一半，**不轮询页面** */
function waitUntilSignalled(
  done: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (done() || signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearInterval(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    // 只读内存里的布尔量（页内事件已经把结果推过来了），不碰 DOM / 不截图
    const timer = setInterval(() => {
      if (done()) finish();
    }, 120);
    signal.addEventListener("abort", finish, { once: true });
    setTimeout(finish, Math.max(200, timeoutMs));
  });
}

/** 会话运行句柄（一个环境同时最多一个） */
export interface ChatSessionHandle {
  engine: ChatEngine;
  controller: AbortController;
  done: Promise<void>;
  /**
   * 这一片绑定的宿主 waitId。**必须留着**：被强制摘除（引擎卡住）时也要发一条
   * 带 waitId 的终态行，否则宿主的 waiter 只能干等超时（「回执悬着」，§0.5.3 E）。
   */
  waitId: string | null;
}

export interface BuildChatSessionInput {
  browser: Browser;
  logger: JsonLogger;
  aiSettings: SidecarAiSettings;
  config: ChatSessionConfig;
  contacts: readonly ChatContactSeed[];
  signal: AbortSignal;
  /** 收尾钩子（可选）：本片结束时释放页面级资源（页内哨兵 / 桥的转发）。 */
  /**
   * 为什么由调用方执行而不是自己监听 abort：abort 只表示「停止意图」，引擎可能还要
   * 走完手上的动作；真正的收尾点在「这一片落地」那一刻（宿主侧 `.finally`）。
   * 引擎内部另有一条**限期兜底**，因为被强制摘除时那一枪可能永远不到。
   */
  registerDispose?: (fn: () => Promise<void>) => void;
}

/**
 * 装配一台可运行的聊天引擎。
 *
 * 这里刻意**不吞异常**也不做「尽力而为」：任何一步失败都以明确的 `false/reason`
 * 或抛错返回，由引擎按自己的相位规则处理（跳过 / 让位 / 转人工）。
 */
export function buildChatSession(input: BuildChatSessionInput): ChatEngine {
  const { browser, logger, config, contacts, signal } = input;
  const policy: ChatSitePolicy = loadChatSitePolicy();

  /**
   * 读快照：没有 userDataDir（`chatSnapshotPath` 返回 null）时**明确拒绝读**。
   * 拒绝的理由不是「读不到」，而是「不该读」——相对路径谁都能撞上（§0.5.3 H）。
   */
  const readSnapshot = (): SnapshotReadResult =>
    config.snapshotFile
      ? readSnapshotFile(config.snapshotFile)
      : {
          ok: false,
          reason: "no_snapshot_path",
          detail: "本片没有 userDataDir：快照不读不写，按无记忆模式运行",
        };

  /**
   * 从**自己上一次写下的快照**续跑（§4.2 耐久续跑 / §0.5.3 H）。
   *
   * 为什么必须读回来（不读回来有三个真实后果，全都踩过）：
   *   ① `reconcileOutbox` 永远无事可做 —— 崩溃窗口那半条消息再也对不上账；
   *   ② 会话里**我方上一次发出的**消息看起来就「不是引擎发的」，被 `detectStrangerOutgoing`
   *      误判成「用户接管」，那位联系人从此被永久停手（现场：Anne 被标成「已由用户接管」）；
   *   ③ 「每日上限」等计数每片归零，等于不存在。
   * 读不到 / 不属于本环境就从零开始，但**如实记一笔**（不许静默重置）。
   */
  const resume = decideResume(readSnapshot(), {
    envId: config.envId,
    profileId: config.profileId,
  });
  if (resume.ok) {
    logger.chatProgress(
      `接着上次继续聊（今天已发 ${resume.snapshot.counters.sentToday} 条）`,
      {
        type: "chat_state_resumed",
        phase: "booting",
        threadKey: null,
        outbox: resume.snapshot.outbox.length,
        contacts: resume.snapshot.contacts.length,
        sentToday: resume.snapshot.counters.sentToday,
      },
    );
  } else if (resume.reason !== "missing") {
    logger.chatProgress(`未能恢复上次值守状态（${resume.reason}）：本片从零开始`, {
      type: "chat_state_resume_skipped",
      phase: "booting",
      threadKey: null,
      reason: resume.reason,
      detail: resume.detail,
    });
  }

  let page: Page | null = null;
  let containerSelector: string | null = null;

  /**
   * 站点描述符 / 连接器层（**可选的加速器**，不是必需品）：
   * 命中时用它把「方向 / 就绪 / 送信」钉得更准；没有命中就回落通用模式，
   * 功能**一个都不少**（宪法 §0.4 / R8：通用模式是兜底，永不删）。
   *
   * 懒加载 / 健康度熔断 / 建复用连接器那些机械动作都在 `chat_session_descriptor.ts`；
   * 这里只把它接到「当前页 / 当前容器 / 当前目标」这三个会被重新赋值的可变量上。
   */
  const descriptorLayer = createDescriptorLayer({
    logger,
    userDataDir: config.userDataDir,
    policy,
    contacts,
    getPage: () => page,
    getContainerSelector: () => containerSelector,
    getCurrentTarget: () => currentTarget,
  });
  const { descriptorFor, connectorFor, connectorContactOf } = descriptorLayer;
  const disposeConnector = descriptorLayer.disposeConnector;

  input.registerDispose?.(disposeConnector);
  // 限期兜底：被强制摘除（引擎卡在 LLM / 页内等待）时宿主侧的收尾可能永远不到，
  // 但页内哨兵是**页面级**资源，不能留在一个可能不属于我们的标签里。
  signal.addEventListener(
    "abort",
    () => {
      setTimeout(() => {
        void disposeConnector();
      }, CHAT_DISPOSE_GRACE_MS);
    },
    { once: true },
  );

  /**
   * 「用当前打开的聊天窗口」时绑定的那个会话（延迟解析一次；标签被关掉就重新找）。
   * 只在一张**已经开着**的聊天标签上工作：不新开、不导航、不关标签。
   */
  let currentConversation: CurrentConversation | null = null;
  /** 同上，转成引擎认识的「对象」（身份键 / 展示名 / 会话直链） */
  let currentTarget: ChatContactSeed | null = null;
  /**
   * 本片**解析后**的目标名单（身份已定稿的那一份）。
   *
   * 为什么必须留一份解析结果：身份定稿时站点键会从 `unknown` 派生（`settleSeedSiteKey`），
   * 键因此与 Host 传来的原始键**不再是同一个串**。`openContact` 若拿定稿键去原始名单里找，
   * 永远找不到 → 目标自带的会话直链被丢掉，退化成一堆「按昵称去列表里点」，
   * 点不中就报「打不开会话」（现场就是这么变成「什么都没发生」的）。
   */
  let resolvedSeeds: ChatContactSeed[] = [];
  /** 已确认「站点完全打开」过的联系人：一片内多轮不必重复等同一个门禁 */
  const readyKeys = new Set<string>();
  /**
   * 名单为空时的**人话原因**（引擎的 `no_targets` 会把它回给用户）。
   *
   * 为什么必须在装配层记：只有这里知道为空的是**哪一种**（没勾选 / 窗口没开 / 站点开着但没点开会话），
   * 引擎不许猜。没有这句话，用户看到的就是「开始值守 → 一秒结束」而无从下手。
   */
  let rosterNote: string | null = null;

  /** 每联系人上下文层（`chat_context/{site}/{contact}/`；无 userDataDir 即无记忆模式） */
  const contextLayer = createContextLayer({ logger, userDataDir: config.userDataDir });
  const { dirOf, cacheKeyOf, hasContactDir, loadSentCache, rememberSent, visitOf, hydrateFromVisit } =
    contextLayer;

  const bannedWords = [...config.bannedWords];

  /**
   * 「绑用户当前窗口、只读不导航」是否生效。
   *
   * **只对「没指定对象」成立**（§1.6 / R7，设置项原话就是「未指定对象时使用当前打开的窗口」）：
   * 用户写了要聊的人之后必须能打开过去，否则页面停在会话列表时整片只会「一秒结束」。
   * 判定收敛在 `chat_session_config.useCurrentWindowMode` 一处（纯函数，可单测）。
   */
  const useCurrentWindowOnly = useCurrentWindowMode(config.useCurrentWindow, contacts.length);

  /**
   * 已打开的标签里有没有「认得出来的聊天站点」——**只看 URL 层面**（站点画像 / 描述符命中），
   * 不看有没有点开会话，也不做任何页内探针。只用于把「没窗口」与「窗口开着但没点开会话」
   * 这两件事分开说（§0.5.3 H）。探不到就当「没有」：它只影响提示语，不影响判定。
   */
  const hasOpenChatSitePage = async (target: Browser): Promise<boolean> => {
    try {
      for (const context of target.contexts()) {
        for (const open of context.pages()) {
          let url = "";
          try {
            if (open.isClosed()) continue;
            url = open.url();
          } catch {
            continue;
          }
          if (!url || url === "about:blank") continue;
          if (matchChatSiteProfile(url, policy) || descriptorFor(url)) return true;
        }
      }
    } catch {
      /* 探不到就当没有 */
    }
    return false;
  };

  const ensurePage = async (): Promise<{ ok: boolean; page: Page | null }> => {
    if (page) {
      try {
        if (!page.isClosed()) return { ok: true, page };
      } catch {
        /* 已销毁，重开 */
      }
    }
    try {
      const context = contextOf(browser);
      if (useCurrentWindowOnly) {
        // 「没指定对象就用**当前打开的**聊天窗口」：只认已经开着的标签，
        // **不新开、不导航、不关标签** —— 用户的窗口必须原样保留（§1.6 / R7）。
        if (currentConversation) {
          try {
            if (!currentConversation.page.isClosed()) {
              page = currentConversation.page;
              return { ok: true, page };
            }
          } catch {
            /* 已销毁，重新找 */
          }
          currentConversation = null;
        }
        const found = await resolveCurrentConversation(browser, { policy, signal });
        if (!found.ok) {
          // 「找不到聊天窗口」有**两种完全不同**的现场，必须分开说：
          //   ① 真的没有开着的聊天页；
          //   ② 站点开着、只是**没点开具体会话**（聊天应用首屏就是列表）。
          // 分开说才不会让用户对着「没有窗口」这句去反复开窗口（§0.5.3 H）。
          const siteOpenButNoConversation = await hasOpenChatSitePage(browser);
          rosterNote = siteOpenButNoConversation
            ? "当前打开的聊天站点里还没有点开具体会话：请在「聊天」视图的「要聊的人」里点「读取会话列表」，勾选要聊的人并保存（之后引擎会自己逐个打开会话）。"
            : "没找到已打开的聊天窗口：请在浏览器里打开目标站点的聊天页面，或在「聊天」视图的「要聊的人」里勾选要聊的对象。";
          logger.chatProgress(
            siteOpenButNoConversation ? "当前聊天站点没点开会话" : "没找到已打开的聊天窗口",
            {
              type: "chat_state_update",
              phase: "booting",
              threadKey: null,
              reason: siteOpenButNoConversation ? "chat_site_without_conversation" : found.reason,
            },
          );
          return { ok: false, page: null };
        }
        currentConversation = found.conversation;
        page = found.conversation.page;
        containerSelector = found.conversation.containerSelector;
        logger.chatProgress(
          found.conversation.ownTab
            ? `绑定当前打开的聊天窗口：${found.conversation.label}（没有别的窗口可用，用的是上次值守留下的聊天标签；只读会话、只在输入框打字）`
            : `绑定当前打开的聊天窗口：${found.conversation.label}`,
          {
            type: "chat_tab",
            phase: "booting",
            threadKey: null,
            url: found.conversation.url,
            reason: found.conversation.ownTab ? "own_tab_fallback" : "user_window",
          },
        );
        return { ok: true, page };
      }
      const result = await ensureChatPage(context);
      page = result.page;
      if (result.adopted) {
        // 跨进程复用（sidecar 重启后认领上次那个标签）：说清楚，免得用户以为「又开了一个」——
        // 同一个账号的多个会话共用这一个标签，按会话导航切换，不再堆窗口。
        logger.chatProgress("复用上次值守留下的聊天标签（同一个账号的会话都在这个标签里切换）", {
          type: "chat_tab",
          phase: "booting",
          threadKey: null,
          reason: "adopted_existing_tab",
        });
      }
      if (result.created) {
        // 说清**为什么**要自开标签：写了目标时目标优先（不动用户正在看的标签）。
        // 用户现场正是这一条让人困惑 —— 「我明明开着聊天窗口，为什么又开一个」，
        // 所以日志里必须把原因写出来，而不是只报「已开聊天专用标签」（§5.7 让用户能审计）。
        const viaTargets = contacts.length > 0;
        logger.chatProgress(
          viaTargets
            ? `另开了一个聊天页去聊：${contacts
                .map((item) => item.label)
                .slice(0, 3)
                .join("、")}（不打扰你正在看的页面）`
            : "另开了一个聊天页（当前没有可用窗口）",
          {
            type: "chat_tab",
            phase: "booting",
            threadKey: null,
            reason: viaTargets ? "explicit_targets" : "no_open_window",
          },
        );
      }
      return { ok: true, page };
    } catch (error) {
      logger.chatProgress("无法取得聊天标签", {
        type: "chat_state_update",
        phase: "booting",
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, page: null };
    }
  };

  /**
   * 站点键修正（§0.5.3 H「`unknown` 站点键」）：
   *
   * 以前站点键一律写死 `unknown` → 同一昵称在两个站点撞进同一个目录（`unknown/Anne`），
   * 两段对话的记忆互相覆盖，而且永远匹配不上站点画像。现在 `unknown` 时**从 URL 派生**。
   *
   * 实际的派生逻辑不在这里：`chat_session_config.ts::seedIdentityOf` 是**唯一一处**
   * （视图从会话列表勾人时写的设置键也用它算，两边不可能分叉）。这里只负责日志与磁盘判定。
   *
   * 派生会让**老用户的目录**（`unknown/<联系人>/`）对不上 → 同一个人被当新对象重新开场
   * （R7 刷屏事故）。所以先把真实 `hasContactDir` 注入进去：旧目录在就**沿用 `unknown` 与旧键**
   * （读旧写旧）并如实记一条日志，绝不静默换目录。
   */
  const settleSeedSiteKey = (seed: ChatContactSeed, legacyKey = seed.key): ChatContactSeed => {
    // 身份的派生**只有一处**（`seedIdentityOf`）：引擎与「读取会话列表」探针共用它，
    // 于是设置表里的键（列表里勾选时写下的）与引擎查表的键不可能分叉。
    const settled = seedIdentityOf(seed, legacyKey, (siteKey, contactKey) =>
      hasContactDir(siteKey, contactKey),
    );
    if (!settled.legacyUsed) return settled.seed;
    logger.chatProgress(
      `沿用旧上下文目录（${"unknown"}/${legacyKey}）：站点键本可派生为「${settled.derivedSiteKey}」，但换目录会丢掉已聊记忆`,
      {
        type: "chat_context_legacy_dir",
        phase: "booting",
        threadKey: legacyKey,
        derivedSiteKey: settled.derivedSiteKey,
      },
    );
    return settled.seed;
  };

  /**
   * 本片要聊的对象（名单的权威入口）。
   *
   * 两条来源：
   *   ① Host 给的显式名单（用户写了「昵称 | 会话URL」）——原样用，不猜；
   *   ② **用户没指定** + 显式「用当前打开的聊天窗口」→ 绑定此刻打开的那个会话
   *      （`conversationKeyOf` 用 URL 算稳定身份；标题只当展示名，不参与身份，避免
   *      未读计数/改名让同一个人被当成新对象重新开场）；
   * 两者都没有 → 空名单（引擎如实拒绝启动，不猜对象）。
   */
  const resolveTargets = async (): Promise<ChatContactSeed[]> => {
    if (contacts.length > 0) {
      rosterNote = null;
      // 解析结果留一份给 `openContact`（身份定稿后键会变，见 `resolvedSeeds` 的注释）
      resolvedSeeds = contacts.map((seed) => settleSeedSiteKey(seed));
      return resolvedSeeds;
    }
    if (!useCurrentWindowOnly) {
      // 没有目标、也没开「用当前窗口」：如实说清该怎么办（引擎会把它回给用户）
      rosterNote = "本次没有可聊对象：请在「聊天」视图的「要聊的人」里点「读取会话列表」，勾选要聊的人再保存。";
      return [];
    }
    if (currentTarget) {
      rosterNote = null;
      return [currentTarget];
    }
    const ready = await ensurePage();
    if (!ready.ok || !ready.page || !currentConversation) return [];
    const conversation = currentConversation;
    const base: ChatContactSeed = {
      key: conversationKeyOf(conversation.siteKey, conversation.url),
      label: conversation.label,
      siteKey: conversation.siteKey,
      url: conversation.url,
    };
    // 「当前窗口」这条路的旧键是 `conversationKeyOf("unknown", url)`（换的是键前缀，
    // URL 哈希不变），所以旧目录要按**同一个 URL 的旧键**去找，不能拿新键去撞。
    currentTarget = settleSeedSiteKey(base, conversationKeyOf("unknown", conversation.url));
    rosterNote = null;
    resolvedSeeds = [currentTarget];
    logger.chatProgress(`使用当前打开的会话：${currentTarget.label}（名称来源：${conversation.labelSource}）`, {
      type: "chat_target_resolved",
      phase: "booting",
      threadKey: currentTarget.key,
    });
    return [currentTarget];
  };

  const deps: ChatEngineDeps = {
    now: isoNow,

    listContacts: async () => {
      // 名单 = 用户勾选的目标 ∪ 会话列表里新发现的（尤其未读）。
      // 显式目标优先；自动发现的新人只追加、不覆盖用户关掉的人。
      const seeds = await resolveTargets();
      const existing = readSnapshot();
      const known =
        existing.ok ? new Map(existing.snapshot.contacts.map((c) => [c.key, c])) : new Map();

      const mergedSeeds: ChatContactSeed[] = [...seeds];
      const seenKeys = new Set(seeds.map((s) => s.key));
      try {
        const discovered = await listPageThreads(browser, {
          userDataDir: config.userDataDir,
          limit: Math.max(config.maxContactsPerSlice * 2, 20),
          signal,
        });
        if (discovered.ok && discovered.items.length > 0) {
          // 未读优先并入，再并入其余新人
          const ordered = [
            ...discovered.items.filter((item) => item.unread),
            ...discovered.items.filter((item) => !item.unread),
          ];
          let added = 0;
          for (const item of ordered) {
            if (mergedSeeds.length >= config.maxContactsPerSlice) break;
            const base: ChatContactSeed = {
              key: item.key || `${discovered.siteKey}|${item.label}`,
              label: item.label,
              siteKey: discovered.siteKey || "unknown",
              url: item.url || null,
            };
            const seed = seedIdentityOf(base).seed;
            if (seenKeys.has(seed.key)) continue;
            seenKeys.add(seed.key);
            mergedSeeds.push(seed);
            added += 1;
          }
          if (added > 0) {
            rosterNote = null;
            logger.chatProgress(`从会话列表自动加入 ${added} 人（优先未读）`, {
              type: "chat_contacts_discovered",
              phase: "scanning",
              added,
              source: discovered.source,
            });
          }
        }
      } catch (error) {
        logger.chatProgress(
          `自动扫描会话列表失败（本轮只用已保存名单）：${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 200),
          { type: "chat_contacts_discover_failed", phase: "scanning" },
        );
      }

      resolvedSeeds = mergedSeeds;

      return mergedSeeds.map((seed) => {
        const prior = known.get(seed.key);
        const override = takeoverOverrideOf(config.takeovers, seed);
        const flags = contactFlagsOf(config.contactFlags, seed);
        const priorWasUserSet = prior?.takeoverReason === USER_TAKEOVER_REASON;
        const fresh: ChatContactState = {
          key: seed.key,
          label: seed.label,
          siteKey: seed.siteKey,
          stage: "cold" as ChatStage,
          followUpIndex: 0,
          nextDueAt: null,
          lastIncomingHash: null,
          lastSentHash: null,
          stopped: false,
          stopReason: null,
          lease: 1,
          updatedAt: isoNow(),
        };
        const base: ChatContactState = prior
          ? {
              ...prior,
              label: seed.label,
              siteKey: seed.siteKey,
              ...(priorWasUserSet && !override
                ? { takeover: "engine" as ChatTakeoverMode, takeoverReason: null }
                : {}),
            }
          : fresh;
        const hydrated: ChatContactState = {
          ...base,
          ...hydrateFromVisit(base, visitOf(seed)),
          autoReply: flags?.autoReply ?? true,
          followUp: flags?.followUp ?? true,
          pendingTexts: Array.isArray(prior?.pendingTexts) ? [...prior!.pendingTexts!] : [],
        };
        if (!override) return hydrated;
        return {
          ...hydrated,
          takeover: override,
          takeoverReason: override === "engine" ? null : USER_TAKEOVER_REASON,
        };
      });
    },

    followUpState: async (contact) => {
      // 权威来自 `visit.json`（耐久）；快照字段只作兜底。
      // 「重启不风暴」就靠这里的 nextDueAt 来自磁盘而不是内存。
      const dir = dirOf(contact);
      const visit = dir ? readVisitState(dir) : null;
      if (!visit) {
        return {
          followUpIndex: contact.followUpIndex,
          nextDueAt: contact.nextDueAt,
          lastContactAt: null,
          lastReplyAt: null,
          stopped: contact.stopped,
        };
      }
      return {
        followUpIndex: visit.followUpIndex,
        nextDueAt: visit.nextDueAt,
        lastContactAt: visit.lastContactAt,
        lastReplyAt: visit.lastReplyAt,
        stopped: visit.stopped,
      };
    },

    openContact: async (contact) => {
      const ready = await ensurePage();
      if (!ready.ok || !ready.page) {
        return { ok: false, containerSelector: null, reason: "no_chat_tab" };
      }
      if (useCurrentWindowOnly) {
        // 用户当前的窗口：**只确认容器还在，绝不导航**（导航会把用户正在做的事冲掉）
        if (!containerSelector) {
          return { ok: false, containerSelector: null, reason: "container_missing" };
        }
        return { ok: true, containerSelector };
      }
      const seed =
        resolvedSeeds.find((c) => c.key === contact.key) ??
        contacts.find((c) => c.key === contact.key) ??
        (currentTarget?.key === contact.key ? currentTarget : null);
      const result = await openContact(
        ready.page,
        {
          label: contact.label,
          url: seed?.url ?? null,
          containerSelector,
        },
        policy,
        signal,
      );
      if (result.containerSelector) containerSelector = result.containerSelector;
      return {
        ok: result.ok,
        containerSelector: result.containerSelector,
        reason: result.reason ?? undefined,
      };
    },

    /**
     * **页面就绪门禁**（用户问题 2）：站点完全打开之前，不读会话、不说话。
     *
     * 已就绪过的联系人直接放行（一片内多轮不必重复等）；其余走 {@link waitForChatReady}
     * 的三态判定（ready / 未就绪 / 明确不是聊天页）。
     */
    waitPageReady: async (contact) => {
      if (readyKeys.has(contact.key) && containerSelector) {
        return { ready: true, blocked: false, reason: "already_ready", containerSelector };
      }
      if (!page) {
        return { ready: false, blocked: false, reason: "no_chat_tab", containerSelector: null };
      }
      // 描述符命中 → 用站点自己的就绪门禁（容器 + 输入框 + 渲染稳定），
      // 比通用模式的「页面下半部有没有可编辑元素」更准；没命中一律走通用门禁（行为不变）。
      const active = connectorFor(contact);
      const gate = active
        ? await active.waitReady(connectorContactOf(contact))
        : await waitForChatReady(page, { policy, signal, containerSelector });
      if (gate.containerSelector) containerSelector = gate.containerSelector;
      if (gate.ready) readyKeys.add(contact.key);
      return {
        ready: gate.ready,
        blocked: gate.blocked,
        reason: gate.reason,
        containerSelector: gate.containerSelector,
      };
    },

    readConversation: async (contact, options) => {
      if (!page || !containerSelector) {
        return {
          ok: false,
          reason: "no_page_or_container",
          containerSelector: null,
          messages: [],
          newIncoming: [],
          newOutgoing: [],
          baselineKnown: false,
          edited: [],
          moreAbove: false,
          fallbackPoll: false,
        };
      }
      // `previous` = 已知会话（磁盘流水）。引擎传空数组时用落盘台账补齐：
      // 这样「对方是不是真说了新话」（`newIncoming`）跨片、跨重启都一致，
      // 而不会因为「本片刚起、内存里没有上次读到的消息」把整段历史都当成新的。
      const dir = dirOf(contact);
      let previous = options.previous;
      if (previous.length === 0 && dir) {
        const known = readThreadMessages(dir, 200);
        if (known.length > 0) previous = ledgerToMessages(known);
      }
      // 描述符命中 → 走**事实包**（附件 / 撤回 / 引用剔除都看得见，方向按站点 id 钉准）；
      // 没命中 → 通用读取器（只抽文本，行为与改造前逐字相同）。
      const active = connectorFor(contact);
      const viaConnector = active
        ? await active.readThread(connectorContactOf(contact), {
            loadHistory: options.loadHistory,
            previous: previous as readonly ConnectorMessage[],
            signal: options.signal,
          })
        : null;
      const snapshot = viaConnector
        ? {
            ok: viaConnector.ok,
            reason: viaConnector.reason,
            containerSelector,
            messages: viaConnector.messages,
            moreAbove: viaConnector.moreAbove,
            fallbackPoll: viaConnector.fallbackPoll,
          }
        : await readThread(page, {
            containerSelector,
            loadHistory: options.loadHistory,
            previous,
            policy,
            signal: options.signal,
          });
      if (snapshot.ok) {
        // 会话流水落盘（已脱敏）：这是「记得对方说过什么」的唯一来源
        if (dir && snapshot.messages.length > 0) {
          const written = appendThreadMessages(dir, snapshot.messages);
          if (!written.ok) {
            logger.chatProgress("会话流水落盘失败", {
              type: "chat_context_write_failed",
              phase: "reading",
              threadKey: contact.key,
              error: written.error,
            });
          }
        }
        const texts = snapshot.messages.filter((m) => m.direction === "out").map((m) => m.text);
        for (const text of texts) {
          rememberSent(contact, text);
        }
      }

      // **方向是结构的一部分**：这里产出 `newIncoming` / `newOutgoing`，不再让上层拿
      // 不分方向的 `newCount` 去猜「对方回话了没有」（那会把我们自己刚发的消息当成对方回话）。
      // 命中描述符就用它把方向钉得更准（id 前缀是最可靠的一手证据），否则回落通用启发式。
      const url = (() => {
        try {
          return page.url();
        } catch {
          return null;
        }
      })();
      // 连接器已经按同一套 diff 口径算过方向（**不做第二份**）；通用模式才在这里升级方向。
      const mapped = viaConnector
        ? {
            newIncoming: viaConnector.newIncoming,
            newOutgoing: viaConnector.newOutgoing,
            edited: viaConnector.edited,
          }
        : snapshotFromMessages(snapshot.messages, descriptorFor(url)?.descriptor ?? null, previous);

      return {
        ok: snapshot.ok,
        reason: snapshot.reason,
        containerSelector: snapshot.containerSelector,
        messages: snapshot.messages,
        newIncoming: mapped.newIncoming,
        newOutgoing: mapped.newOutgoing,
        // 有台账（磁盘流水）才算「有基线」：没有基线时上面算出的 `newIncoming/newOutgoing`
        // 其实是「整段会话」，拿它判接管会把用户以前手打的消息误当成「他刚接管」（§0.5.3 H）。
        baselineKnown: previous.length > 0,
        edited: mapped.edited,
        moreAbove: snapshot.moreAbove,
        fallbackPoll: snapshot.fallbackPoll,
      };
    },

    waitForActivity: async (selector, options) => {
      if (!page) {
        return { signal: "page_closed", observerAttached: false, elapsedMs: 0 };
      }
      // 描述符命中且有页内哨兵 → 订阅页内事件（零轮询、零截图）；
      // 订阅不上（通用模式 / 哨兵安装失败）→ 回落同一条兜底路径，并**如实标注**降级。
      // 这里**不再重新解析**连接器：引擎的调用顺序（就绪 → 读 → 发 → 等）保证了
      // 此刻的连接器与本轮联系人就是刚用过的那一对；解析不出来就走兜底路径。
      const active = descriptorLayer.getConnector();
      const contact = descriptorLayer.getLastConnectorContact();
      if (active?.subscribe && contact) {
        const events: ConnectorActivityEvent[] = [];
        const started = Date.now();
        const unsubscribe = await active.subscribe(contact, (event) => {
          events.push(event);
        });
        if (unsubscribe) {
          try {
            await waitUntilSignalled(() => events.length > 0, options.timeoutMs, options.signal);
          } finally {
            unsubscribe();
          }
          return {
            // 只有「页内真的有动静」才算命中（与兜底路径同一个判据：`mutation`）
            signal: options.signal.aborted ? "aborted" : events.length > 0 ? "mutation" : "timeout",
            observerAttached: true,
            elapsedMs: Date.now() - started,
          };
        }
      }
      const result = await waitThreadActivity(page, {
        containerSelector: selector,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      return {
        signal: result.signal,
        observerAttached: result.observerAttached,
        elapsedMs: result.elapsedMs,
      };
    },

    userActive: async () => {
      if (!page) return { active: false, probeAvailable: false };
      return detectRecentUserActivity(page, 20_000);
    },

    sentHistory: async (contact) => {
      const map = loadSentCache();
      const thread = map.get(cacheKeyOf(contact)) ?? [];
      const own = cacheKeyOf(contact);
      const cross: string[] = [];
      for (const [key, texts] of map) {
        if (key === own) continue;
        cross.push(...texts);
      }
      return { thread: thread.slice(-20), cross: cross.slice(-50) };
    },

    /**
     * 「我方确实发过」的**耐久证据**：该联系人目录里的 `outbox.jsonl`（只落指纹，不落原文）。
     *
     * 为什么不能只认快照的 `outbox`（§0.5.3 H）：用户现场正是「快照里的发件箱 0 条，
     * 但流水里有我们以前发的那条」→ 引擎把**自己发的**当成陌生人出站消息 → 该联系人被标成
     * 「已由用户接管」并永久停手（日志：`因接管跳过`）。流水是追加写的、不参与快照裁剪，
     * 正是这种「快照丢了但确实发过」场景的唯一证据。
     */
    knownSentHashes: async (contact) => {
      const dir = dirOf(contact);
      if (!dir) return [];
      return readOutboxJournal(dir)
        .filter((entry) => entry.status === "sent")
        .map((entry) => entry.textHash)
        .filter((hash) => typeof hash === "string" && hash.length > 0);
    },

    /** 名单为空时的原因（引擎的 `no_targets` 原样回给用户） */
    rosterNote: () => rosterNote,

    draft: async (draftInput) => {
      const router = createModelRouter(input.aiSettings);
      const client = createLlmClient(input.aiSettings);
      const resolved = router.resolve("fast_text", "聊天草稿：极速文本档");

      const dir = dirOf(draftInput.contact);
      const summary = dir ? readSummary(dir) : null;

      const activeRole = activeRoleOf(config);
      const maxBubbles = Math.max(1, Math.min(3, Math.trunc(draftInput.maxBubbles ?? 1)));
      const messages = buildChatDraftMessages({
        siteLabel: draftInput.contact.siteKey,
        contactLabel: draftInput.contact.label,
        stage: draftInput.stage,
        goal: config.goal,
        styleHint: config.styleHint,
        roleName: activeRole?.name ?? null,
        rolePrompt: activeRole?.prompt ?? null,
        rollingSummary: summary?.text ?? null,
        longTermFacts: dir ? readFacts(dir) : [],
        usedAngles: dir ? readAngles(dir) : [],
        recent: draftInput.incoming,
        isFollowUp: draftInput.isFollowUp,
        followUpIndex: draftInput.contact.followUpIndex,
        rewriteHint: draftInput.rewriteHint,
        intentDirective: draftInput.intentDirective ?? null,
        maxBubbles,
        nowIso: isoNow(),
      });

      const completion = await withLlmRetry(
        () =>
          client.chat.completions.create(
            {
              model: resolved.model,
              messages: messages as never,
              temperature: 0.9,
            },
            { signal: draftInput.signal },
          ),
        {
          signal: draftInput.signal,
          onRetry: ({ attempt, delayMs, error }) => {
            logger.chatProgress(
              `草稿请求瞬时故障，退避重试 #${attempt}（${delayMs}ms）：${
                error instanceof Error ? error.message : String(error)
              }`.slice(0, 200),
              { type: "chat_draft_retry", phase: "drafting", threadKey: draftInput.contact.key },
            );
          },
        },
      );

      const parsed = parseChatDraft(extractAssistantContent(completion), maxBubbles);
      if (!parsed) {
        logger.chatProgress("草稿输出无法解析，本轮不发", {
          type: "chat_draft_rejected",
          phase: "drafting",
          threadKey: draftInput.contact.key,
          reason: "unparsable",
        });
        return null;
      }

      return {
        text: parsed.text,
        texts: parsed.texts,
        angle: parsed.angle,
        costMicroUsd: 0,
      };
    },

    gateSend: (text) => defaultGateSend(text, bannedWords),

    sendText: async (contact, text) => {
      if (!page || !containerSelector) {
        return { ok: false, reason: "no_page_or_container" };
      }
      const active = connectorFor(contact);
      const result = active
        ? await active.sendText(connectorContactOf(contact), text)
        : await sendChatText(page, containerSelector, text, policy);
      if (result.ok) {
        rememberSent(contact, text);
        logger.chatProgress("已提交输入并发送", {
          type: "chat_send_submitted",
          phase: "sending",
          threadKey: contact.key,
          usedSendButton: "usedSendButton" in result && result.usedSendButton === true,
          connectorKind: active?.kind ?? "generic",
        });
        // 写入**靠兜底链**才成功、或链上试过不止一种写法 → 如实记一笔：
        // 描述符声明的写法与这个站点版本不合，健康度提示的「请修描述符」就指这里（不静默）。
        const diag = result.diagnostics as { declaredMethod?: string; verifiedMethod?: string; selector?: string } | undefined;
        if (diag?.verifiedMethod && diag.declaredMethod && diag.verifiedMethod !== diag.declaredMethod) {
          logger.chatProgress(
            `描述符声明的写入方式（${diag.declaredMethod}）没写进去，已用兜底写法（${diag.verifiedMethod}）写入成功：请修描述符`,
            {
              type: "chat_composer_method_fallback",
              phase: "sending",
              threadKey: contact.key,
              reason: `declared=${diag.declaredMethod}`,
              selector: diag.selector ?? null,
            },
          );
        }
      }
      return { ok: result.ok, reason: result.reason, diagnostics: result.diagnostics };
    },

    isVisibleInPage: async (contact, textHash, originalText) => {
      if (!page || !containerSelector) return false;
      if (await isTextInThread(page, containerSelector, textHash, originalText)) return true;
      // 兜底对账：站点把消息体拆进不同节点（表情 alt、链接预览）时，逐节点文本可能对不上指纹。
      // 这时**再读一次会话**，用「读出来的消息文本」重算指纹比对；
      // 仍然是「完全相等才算命中」（不模糊、不子串），宁可标 unconfirmed 交人工，也不误报已发出。
      try {
        const known = dirOf(contact);
        const snapshot = await readThread(page, {
          containerSelector,
          loadHistory: false,
          previous: known ? ledgerToMessages(readThreadMessages(known, 200)) : [],
          policy,
          signal,
        });
        if (!snapshot.ok) return false;
        if (snapshot.messages.some((m) => m.direction === "out" && hashText(m.text) === textHash)) {
          return true;
        }
        const own = String(originalText ?? "").trim();
        if (own.length < 8) return false;
        return snapshot.messages.some(
          (m) => m.direction === "out" && looksLikeOwnSentText(m.text, [own]) !== null,
        );
      } catch {
        return false;
      }
    },

    hasNewAngle: async (contact) => {
      // 「有角度可用」= 还没把角度用尽。判据来自磁盘（跨重启一致），不是内存。
      if (contact.stopped) return false;
      const dir = dirOf(contact);
      const used = dir ? readAngles(dir) : [];
      return used.length < ANGLES_SOFT_LIMIT;
    },

    /**
     * 记忆压缩：滚动摘要 + 长期事实（P5）。
     *
     * 严格按 `chat_memory.decideCompact` 的判定走，**不与引擎抢决策权**：
     * - 没有未覆盖的原始消息 → 什么都不做（防「摘要总结摘要」，规则 1）；
     * - 代数到顶 → 只推进覆盖位置，不再压缩（规则 3）；
     * - 到阈值才真的调模型。
     */
    compactMemory: async (contact) => {
      const dir = dirOf(contact);
      if (!dir) return { compacted: false, reason: "no_context_dir", factsAdded: 0 };

      const ledger = readThreadMessages(dir, THREAD_READ_LIMIT);
      const allMessages = ledgerToMessages(ledger);
      const summary = readSummary(dir);
      const existingFacts = readFacts(dir);

      const uncovered = uncoveredMessages(allMessages, summary?.coveredUpToId ?? null);
      const decision = decideCompact({
        totalMessages: allMessages.length,
        uncoveredMessages: uncovered.length,
        generations: summary?.generations ?? 0,
      });
      if (!decision.needed) {
        return { compacted: false, reason: decision.reason, factsAdded: 0 };
      }

      const coveragePoint = uncovered[uncovered.length - 1]?.id ?? summary?.coveredUpToId ?? null;

      // 代数到顶：不再压缩，只把覆盖位置往前推（摘要正文保持不变）
      if (!decision.requiresLlm) {
        const written = writeSummary(dir, {
          text: summary?.text ?? "",
          coveredUpToId: coveragePoint,
          generations: summary?.generations ?? 0,
          updatedAt: isoNow(),
        });
        if (!written.ok) {
          // 写盘失败必须**抛出去**：引擎会记 `chat_memory_failed`。
          // 若只返回 `compacted: false`，引擎就不会记任何东西 —— 那是静默失败（§0.5.3 B）。
          throw new Error(`summary_write_failed: ${written.error ?? "unknown"}`);
        }
        return { compacted: true, reason: decision.reason, factsAdded: 0 };
      }

      const router = createModelRouter(input.aiSettings);
      const client = createLlmClient(input.aiSettings);
      const resolved = router.resolve("fast_text", "聊天记忆压缩：极速文本档");

      const messages = buildChatSummaryMessages({
        contactLabel: contact.label,
        goal: config.goal,
        stage: contact.stage,
        previousSummary: summary?.text ?? null,
        uncovered,
        knownFacts: existingFacts,
      });

      const completion = await withLlmRetry(
        () =>
          client.chat.completions.create(
            { model: resolved.model, messages: messages as never, temperature: 0.3 },
            { signal },
          ),
        {
          signal,
          onRetry: ({ attempt, delayMs, error }) => {
            logger.chatProgress(
              `记忆压缩瞬时故障，退避重试 #${attempt}（${delayMs}ms）：${
                error instanceof Error ? error.message : String(error)
              }`.slice(0, 200),
              { type: "chat_memory_retry", phase: "recording", threadKey: contact.key },
            );
          },
        },
      );

      const parsed = parseChatSummary(extractAssistantContent(completion));
      if (!parsed) {
        logger.chatProgress("记忆压缩输出无法解析，本轮不更新摘要", {
          type: "chat_memory_failed",
          phase: "recording",
          threadKey: contact.key,
          error: "unparsable",
        });
        return { compacted: false, reason: "unparsable", factsAdded: 0 };
      }

      const merged = mergeSummary({
        previousSummary: summary?.text ?? null,
        previousCoveredUpToId: summary?.coveredUpToId ?? null,
        previousGenerations: summary?.generations ?? 0,
        generated: parsed,
        covered: uncovered,
        allMessageIds: allMessages.map((message) => message.id),
        knownFacts: existingFacts,
      });

      const written = writeSummary(dir, {
        text: merged.summary,
        coveredUpToId: merged.coveredUpToId,
        generations: merged.generations,
        updatedAt: isoNow(),
      });
      if (!written.ok) {
        throw new Error(`summary_write_failed: ${written.error ?? "unknown"}`);
      }
      const facts = merged.newFacts.length > 0 ? addFacts(dir, merged.newFacts) : existingFacts;

      return {
        compacted: true,
        reason: decision.reason,
        factsAdded: Math.max(0, facts.length - existingFacts.length),
      };
    },

    persist: async (persistInput) => {
      const contact = persistInput.contact;
      const dir = dirOf(contact);
      const now = isoNow();

      if (!dir) {
        // 无上下文目录：不写盘，但也不假装成功（日志里看得见）
        logger.chatProgress("跳过上下文落盘（无 userDataDir）", {
          type: "chat_context_write_failed",
          phase: "recording",
          threadKey: contact.key,
          error: "no_user_data_dir",
        });
        return;
      }

      // 1) 新消息进流水（脱敏 + 去重）。`appendedIn` 是**真正新增**的收信条数，
      // 不能用 `newMessages.length`：引擎每轮会把读到的整段会话传进来，用长度会让计数虚高。
      let newIncoming = 0;
      if (persistInput.newMessages.length > 0) {
        const written = appendThreadMessages(dir, persistInput.newMessages, now);
        newIncoming = written.appendedIn;
        if (!written.ok) {
          logger.chatProgress("会话流水落盘失败", {
            type: "chat_context_write_failed",
            phase: "recording",
            threadKey: contact.key,
            error: written.error,
          });
        }
      }

      // 2) 用过的角度（禁止复读）。**重复角度不入库**：一旦污染角度库，
      //    之后每轮的去重提示都会带重复项，越用越乱（宁可只丢角度，不丢消息）。
      const acceptedAngle = acceptAngle(persistInput.angle, readAngles(dir));
      if (acceptedAngle) {
        addAngle(dir, acceptedAngle);
      }

      // 3) 回访状态：序号与下次唤醒时间取引擎算好的权威值（不在本层重算）
      const prior = readVisitState(dir) ?? emptyVisitState(now);
      const settled = settleVisitState(prior, {
        now,
        label: contact.label,
        incomingCount: newIncoming,
        sent: Boolean(persistInput.sentText),
        followUpIndex: contact.followUpIndex,
        nextDueAt: contact.nextDueAt,
        stage: persistInput.stage,
        stopped: contact.stopped,
        stopReason: contact.stopReason,
      });
      const visitWrite = writeVisitState(dir, settled);
      if (!visitWrite.ok) {
        logger.chatProgress("回访状态落盘失败", {
          type: "chat_context_write_failed",
          phase: "recording",
          threadKey: contact.key,
          error: visitWrite.error,
        });
      }

      // 4) 发件审计流水（与快照里的 outbox 互为印证；只落指纹不落原文）
      //    **指纹必须是 `hashText`**（与引擎比对 / 去重 / 快照 outbox 同一套）。
      //    曾经这里用的是另一套（`fingerprint` = trim+lowercase）：两套永远对不上，
      //    于是这道「耐久证据」形同虚设 —— 快照一丢就把我们自己发的那条当成陌生人 →
      //    判用户接管 → 永久停手（§0.5.3 H「假护栏」）。
      if (persistInput.sentText) {
        const sentHash = hashText(persistInput.sentText);
        appendOutboxJournal(dir, {
          effectId: sentHash,
          threadKey: contact.key,
          textHash: sentHash,
          status: "sent",
          attempts: 1,
          at: now,
          note: persistInput.angle ?? null,
        });
      }

      logger.chatProgress("已更新联系人上下文", {
        type: "chat_persist",
        phase: "recording",
        threadKey: contact.key,
        stage: persistInput.stage,
        sent: Boolean(persistInput.sentText),
        incoming: newIncoming,
      });
    },

    nextStage: (contact, incoming) => {
      const latest = incoming[incoming.length - 1]?.text ?? "";
      if (latest && looksLikeOptOut(latest)) return "opted_out";
      if (latest && looksLikeRejection(latest)) return "rejected";
      if (incoming.length > 0) return contact.stage === "cold" ? "engaged" : contact.stage;
      return contact.stage;
    },

    saveSnapshot: async (snapshot) => {
      if (!config.snapshotFile) {
        // 无记忆模式：**不写**（也不写相对路径，那等于写到别人的状态文件上）
        logger.chatProgress("未拿到 userDataDir：快照不落盘（本片不记忆）", {
          type: "chat_state_update",
          phase: snapshot.engine.phase,
          error: "no_snapshot_path",
        });
        return { ok: false, error: "no_snapshot_path" };
      }
      const result = writeSnapshotAtomic(config.snapshotFile, snapshot);
      if (!result.ok) {
        logger.chatProgress("聊天快照落盘失败", {
          type: "chat_state_update",
          phase: snapshot.engine.phase,
          error: result.error,
        });
      }
      return result;
    },

    log: (message, data) => {
      logger.chatProgress(message, data);
    },

    handover: async ({ contact, reason, detail }) => {
      logger.chatProgress(`需要人工处理：${reason}`, {
        type: "chat_handover",
        phase: "handover",
        threadKey: contact?.key ?? null,
        reason,
        detail: detail ?? null,
      });
      logger.agentAskUser({
        requestId: `chat-${contact?.key ?? "unknown"}-${Date.now()}`,
        question: `聊天模式需要你确认：${detail ?? reason}`,
        kind: "chat_handover",
        threadKey: contact?.key ?? null,
      });
    },

    sliceMs: config.sliceMs,
    waitTimeoutMs: 30_000,
    maxContactsPerSlice: config.maxContactsPerSlice,
    /**
     * 发出后守在会话里等对方**即时**回复的上限（`MutationObserver`，零轮询零截图）。
     *
     * 实际预算 = **剩余片时长**（见 `engine.ts` 的 `deliverAndRecord`），本值只是上限：
     *   - `replyWaitMs`（**热对话**：对方刚回过话，就是一场进行中的对话）＝ 10 分钟 ——
     *     与热窗口（`LIVE_REPLY_HOT_MINUTES`）同宽，等价于「守到片时长用完」；
     *     用户把「单次值守」调长，它就一直听。
     *   - `coldReplyWaitMs`（**冷开场**：给一个从没回过话的人搭话）＝ 90 秒 ——
     *     够正常人回一句，又不把整片耗在一个不搭理你的人身上（后面还有别的联系人要处理）。
     *
     * 旧值（45s / 6s）就是「发完一条就结束了」的直接原因：6 秒内没人回就收片，
     * 对方 20 秒后回的话只能等下一片 —— 而下一片过去要等 1 分钟起（现在热窗口内是 30 秒）。
     */
    replyWaitMs: 600_000,
    coldReplyWaitMs: 90_000,
    /**
     * 一片内同一联系人最多来回几轮；到上限就停（对方的下一句留给下一片，绝不硬找话说）。
     * 6 轮：够一场真实的来回（问→答→追问→答…），又不会一个人把整片聊成刷屏。
     */
    maxTurnsPerContact: 6,
    /** 节奏护栏（只为防封号；不含任何每日上限） */
    pacing: config.pacing ?? DEFAULT_PACING,
  };

  return new ChatEngine(
    deps,
    {
      envId: config.envId,
      profileId: config.profileId,
      cadence: config.cadence,
      signal,
    },
    // 读得到就接着上次跑：发件箱（幂等 / 对账）、计数（每日上限）、联系人阶段与回访时间
    resume.ok ? resume.snapshot : undefined,
  );
}
