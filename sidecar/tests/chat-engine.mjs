/**
 * 聊天模式引擎回归测试（P2：主循环 · 静音 · 幂等发送 · 相位合法性）
 *
 * 引擎的全部依赖都是**注入**的，所以这里用假原语就能把整台状态机跑完整 ——
 * 不需要浏览器、不需要模型、不产生任何真实副作用。
 *
 * 覆盖：
 *   - 静音：**源码级**断言聊天形态不出现截图/全景/SoM/a11y/digest/影子模型（§5）
 *   - 无联系人 → 不调模型、直接让位
 *   - 正常闭环：发送 → 计数 → nextDueAt/nextWakeAt 持久化 → 发件箱置 sent
 *   - **durable-before-return**：出站意图先落盘，再发生真实副作用
 *   - 人工优先：用户在动 → 让位，绝不抢输入
 *   - 去重：连续重复 → 拒绝 3 次后放弃，**绝不硬发**
 *   - 发送后回读未见 → 标 unconfirmed 交人工，**绝不自动重发**
 *   - 红线文本 → 转人工，绝不发出（R1 / R2）
 *   - 续跑对账：pending 且页面已在 → 不重发，标 sent
 *   - 回访未到期 → 不发（避免回访风暴）
 *   - abort → 立刻停，不发送
 *   - 相位转移全程合法（引擎内部 `assertTransition` 会抛）
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { detectRecentUserActivity } from "../dist/core/web_chat/wait.js";
import { ChatEngine, defaultGateSend, isRedlineText } from "../dist/core/web_chat/engine.js";
import { PROGRESS_FLUSH_MS, shouldFlushProgress } from "../dist/core/web_chat/engine.js";
import {
  hashText,
  looksLikeOwnSentText,
  normalizeForEffect,
  stripDecorationTail,
} from "../dist/core/web_chat/outbox.js";
import { unansweredIncoming } from "../dist/core/web_chat/conversation_extract.js";
import { DEFAULT_CADENCE } from "../dist/core/web_chat/cadence.js";
import { CHAT_STATE_SCHEMA_VERSION, USER_TAKEOVER_REASON } from "../dist/core/web_chat/state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_SRC = join(HERE, "..", "src");

const T0 = "2026-09-26T12:00:00.000Z";

function makeContact(over = {}) {
  return {
    key: "env-1|telegram|alice",
    label: "Alice",
    siteKey: "telegram",
    stage: "opening",
    followUpIndex: 0,
    nextDueAt: null,
    lastIncomingHash: null,
    lastSentHash: null,
    stopped: false,
    stopReason: null,
    lease: 1,
    updatedAt: T0,
    ...over,
  };
}

/** 造一台「假浏览器」：记录每一个副作用与调用顺序，供断言检查 */
function makeHarness(over = {}) {
  const calls = [];
  const logs = [];
  const saves = [];
  const sentTexts = [];
  const sentImages = [];
  const handovers = [];

  const cfg = {
    contacts: [makeContact({ lastIncomingHash: "in-1" })],
    messages: [{ id: "m-1", direction: "in", text: "你好，你也是做这个的吗？" }],
    newCount: 1,
    moreAbove: false,
    fallbackPoll: false,
    readOk: true,
    readReason: null,
    containerSelector: ".chat-thread",
    userActive: false,
    drafts: [{ text: "你好，我最近也在看这个方向，感觉挺有意思的。", angle: "a1", costMicroUsd: 120 }],
    visibleResults: [true, true],
    newAngle: true,
    sendOk: true,
    followUp: null,
    sliceMs: 60_000,
    replyWaitMs: 5_000,
    coldReplyWaitMs: 2_000,
    maxTurnsPerContact: 1,
    waitTimeoutMs: 1_000,
    maxContactsPerSlice: 5,
    initialSnapshot: null,
    /** 页面就绪门禁的结果；用用例可按需改成「未就绪 / 明确不是聊天页」 */
    ready: null,
    /** 发出后的事件等待信号序列（第一个用于第 1 轮，之后复用最后一个） */
    waitSignals: ["timeout"],
    ...over,
  };

  let visibleIdx = 0;
  let draftIdx = 0;
  let waitIdx = 0;

  const deps = {
    now: () => T0,

    openContact: async () => {
      calls.push(["openContact"]);
      // 用例可直接指定结果（例如「导航已发出但容器还没定位到」的现场形态）
      if (cfg.openContactResult) return cfg.openContactResult;
      return { ok: true, containerSelector: cfg.containerSelector };
    },

    /**
     * 页面就绪门禁：默认「已就绪」（旧用例的行为不变）；
     * 用例可注入未就绪 / 明确不是聊天页来验证「不读不说、必要时交人工」。
     */
    waitPageReady: async () => {
      calls.push(["waitPageReady"]);
      if (cfg.ready) return cfg.ready;
      return {
        ready: true,
        blocked: false,
        reason: "ready",
        containerSelector: cfg.containerSelector,
      };
    },

    readConversation: async () => {
      calls.push(["readConversation"]);
      if (typeof cfg.onRead === "function") {
        cfg.onRead(calls.filter((c) => c[0] === "readConversation").length, cfg);
      }
      // 方向必须从**结构**里出：`newIncoming` / `newOutgoing` 由「最近 newCount 条」按方向切分，
      // 而不是拿不分方向的计数去猜。用例可用 `cfg.newIncoming` 直接钉死（回归用）。
      const window = cfg.messages.slice(-Math.max(0, cfg.newCount));
      const derivedIncoming = window.filter((m) => m.direction === "in");
      const derivedOutgoing = window.filter((m) => m.direction !== "in");
      return {
        ok: cfg.readOk,
        reason: cfg.readReason,
        containerSelector: cfg.containerSelector,
        messages: cfg.messages,
        newIncoming: cfg.newIncoming ?? derivedIncoming,
        newOutgoing: cfg.newOutgoing ?? derivedOutgoing,
        // 有没有历史基线：默认「有」（老用例的行为不变）；用例可显式关掉来验证「首次读数不判接管」
        baselineKnown: cfg.baselineKnown ?? true,
        edited: cfg.edited ?? [],
        moreAbove: cfg.moreAbove,
        fallbackPoll: cfg.fallbackPoll,
      };
    },

    waitForActivity: async () => {
      calls.push(["waitForActivity"]);
      const signals = Array.isArray(cfg.waitSignals) ? cfg.waitSignals : ["timeout"];
      const signal = signals[Math.min(waitIdx, signals.length - 1)] ?? "timeout";
      waitIdx += 1;
      // 引擎在 mutation 后会重读「相对本轮多出来的对方消息」——夹具必须真的塞进一条，
      // 否则只报 mutation、页面不变 → peek 永远空 → 片内来回测例全挂（与生产「气泡已上屏」对齐）。
      if (signal === "mutation" && cfg.autoInjectOnMutation !== false) {
        const n = (cfg._mutationInjects = (cfg._mutationInjects || 0) + 1);
        cfg.messages = [
          ...cfg.messages,
          { id: `m-mut-${n}`, direction: "in", text: `对方回话 ${n}：收到了，继续聊。` },
        ];
        cfg.newCount = Math.max(1, Number(cfg.newCount) || 0) + 1;
      }
      return { signal, observerAttached: true, elapsedMs: 1000 };
    },

    userActive: async () => {
      calls.push(["userActive"]);
      return { active: cfg.userActive, probeAvailable: true };
    },

    sentHistory: async () => ({ thread: cfg.historyThread ?? [], cross: [] }),

    draft: async (input) => {
      calls.push(["draft", input.rewriteHint, input.incoming.length]);
      if (draftIdx >= cfg.drafts.length) {
        return cfg.drafts[cfg.drafts.length - 1] ?? null;
      }
      const d = cfg.drafts[draftIdx];
      draftIdx += 1;
      return d;
    },

    gateSend: (text) => defaultGateSend(text),

    sendText: async (_contact, text) => {
      calls.push(["sendText", text]);
      sentTexts.push(text);
      if (typeof cfg.afterSend === "function") {
        cfg.afterSend(sentTexts.length, cfg);
      }
      return { ok: cfg.sendOk };
    },

    pickMedia: (input) => {
      calls.push(["pickMedia", input.excerpt]);
      if (typeof cfg.pickMedia === "function") return cfg.pickMedia(input);
      return cfg.mediaPick ?? null;
    },

    sendImage: async (_contact, filePath) => {
      calls.push(["sendImage", filePath]);
      sentImages.push(filePath);
      return { ok: cfg.sendImageOk !== false };
    },

    isVisibleInPage: async () => {
      calls.push(["isVisibleInPage"]);
      const v = cfg.visibleResults[Math.min(visibleIdx, cfg.visibleResults.length - 1)];
      visibleIdx += 1;
      // 用例可传 "throw" 模拟「页面回读探针**没跑成**」——判定失败 ≠ 「页面里没有」（§0.5.3 A）
      if (v === "throw") throw new Error("probe_unavailable");
      return v;
    },

    hasNewAngle: async () => {
      calls.push(["hasNewAngle"]);
      return cfg.newAngle;
    },

    persist: async (input) => {
      calls.push(["persist", input.sentText]);
    },

    // P5 记忆压缩：默认「不压缩」（测试按需打开），并如实记录是否被问到
    compactMemory: async (contact) => {
      calls.push(["compactMemory", contact.key]);
      const injected = cfg.compactMemory;
      if (typeof injected === "function") return injected(contact);
      if (injected) return injected;
      return { compacted: false, reason: "not_needed", factsAdded: 0 };
    },

    listContacts: async () => {
      calls.push(["listContacts"]);
      return cfg.contacts;
    },

    followUpState: async (contact) => {
      calls.push(["followUpState"]);
      if (cfg.followUp) return cfg.followUp;
      return {
        followUpIndex: contact.followUpIndex,
        nextDueAt: contact.nextDueAt,
        lastContactAt: null,
        lastReplyAt: null,
        stopped: contact.stopped,
      };
    },

    nextStage: () => cfg.nextStage ?? "engaged",

    saveSnapshot: async (snapshot) => {
      calls.push(["saveSnapshot", snapshot.engine.phase]);
      saves.push(snapshot);
      return { ok: true, error: null };
    },

    log: (message, data) => {
      logs.push({ message, ...(data ?? {}) });
    },

    handover: async (input) => {
      calls.push(["handover", input.reason]);
      handovers.push(input);
    },

    sliceMs: cfg.sliceMs,
    replyWaitMs: cfg.replyWaitMs,
    coldReplyWaitMs: cfg.coldReplyWaitMs,
    maxTurnsPerContact: cfg.maxTurnsPerContact,
    waitTimeoutMs: cfg.waitTimeoutMs,
    maxContactsPerSlice: cfg.maxContactsPerSlice,
    // 测例默认关掉入站合批静默窗，避免吃掉 waitSignals（生产路径 chat_session 用默认 5s）
    inboundQuietMs: cfg.inboundQuietMs ?? 0,
  };

  const controller = new AbortController();
  const engine = new ChatEngine(
    deps,
    {
      envId: "env-1",
      profileId: 1,
      signal: controller.signal,
      cadence: cfg.cadence,
    },
    cfg.initialSnapshot ?? undefined,
  );

  return {
    engine,
    deps,
    cfg,
    controller,
    calls,
    logs,
    saves,
    sentTexts,
    sentImages,
    handovers,
    indexOf: (name) => calls.findIndex((c) => c[0] === name),
    logsOf: (type) => logs.filter((l) => l.type === type),
  };
}

/** 与 `createInitialSnapshot` 等价的最小快照（避免测试依赖其内部形状） */
function seedSnapshot(over = {}) {
  return {
    schemaVersion: CHAT_STATE_SCHEMA_VERSION,
    engine: {
      phase: "stopped",
      since: T0,
      progressCounter: 0,
      nextWakeAt: null,
      campaignEndsAt: null,
      heartbeatAt: null,
    },
    contacts: [],
    outbox: [],
    counters: {
      day: "2026-09-26",
      sentToday: 0,
      sentTotal: 0,
      llmCallsToday: 0,
      costMicroUsd: 0,
    },
    ...over,
  };
}

/* ————————————————————————— 静音（源码级，不是空转断言） ————————————————————————— */

/** 聊天形态的全部源码文件：`core/web_chat/**` 与 `bu_agent/chat_*.ts` */
function chatSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(join(SIDECAR_SRC, "core", "web_chat"));
  for (const entry of readdirSync(join(SIDECAR_SRC, "bu_agent"), { withFileTypes: true })) {
    if (entry.isFile() && /^chat_.*\.ts$/.test(entry.name)) {
      files.push(join(SIDECAR_SRC, "bu_agent", entry.name));
    }
  }
  return files;
}

/**
 * 静音是**结构性的**，不能靠一个空转的运行时断言（§0.5.3 H「假护栏」）。
 *
 * 曾经的 `assertSilent` 传的都是 `chat_*` 名字，永远不在禁用清单里 → 从不触发。
 * 真正的保证是「聊天形态根本不调用观测 API」，所以这里直接扫源码：一旦有人在聊天路径上
 * 引入截图 / 全景 / SoM / a11y 全树 / digest / 影子模型，这条用例立刻红。
 */
test("聊天形态源码级静音：不截图 / 不全景 / 不 SoM / 不 a11y 全树 / 不 digest / 不影子模型", () => {
  const files = chatSourceFiles();
  assert.ok(files.length >= 10, `应扫到聊天形态源码（实际 ${files.length} 个文件）`);
  const banned = [
    ".screenshot(",
    "captureScreenshot",
    "safe_screenshot",
    "prepareObservation",
    "panoramaEnabled",
    "safePageDigest",
    "som_marker",
    "buildSomMarks",
    "page.accessibility",
    "overlay_probe",
    "obstacle_arbiter",
    "interactive_elements",
    // Agent Event SSOT / RunBrief / 动作证据：聊天形态不得引用（ChatFireWall）
    "action_evidence",
    "run_brief",
    "emitAgentEvent",
    "beginActionEvidence",
    "buildRunBrief",
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const token of banned) {
      assert.ok(
        !source.includes(token),
        `${relative(SIDECAR_SRC, file)} 出现被禁的观测调用：${token}`,
      );
    }
  }
});

/* ————————————————————————— 页面就绪门禁 ————————————————————————— */

test("就绪门禁补位：打开会话只发出导航（容器还没定位到）时不算失败（§0.5.3 A）", async () => {
  // 现场形态：`openContact` 刚发完导航，SPA 首屏还没渲染 → 它只能返回 ok 但容器为 null。
  // 这时若判「打不开会话」，整片会一秒收尾（用户看到的就是「瞬间就结束」）。
  const h = makeHarness({ openContactResult: { ok: true, containerSelector: null } });
  const result = await h.engine.run();

  assert.ok(h.indexOf("waitPageReady") >= 0, "容器没定位到不是失败：必须继续走就绪门禁");
  assert.equal(h.logsOf("chat_contact_open").length, 0, "不得谎报「打不开会话」");
  // 就绪门禁（本例已就绪）把容器补上之后，该读就读、该发就发
  assert.ok(h.indexOf("readConversation") >= 0);
  assert.equal(result.sent, 1);
});

test("打开会话确实失败（ok=false）→ 跳过该联系人并如实记原因", async () => {
  const h = makeHarness({
    openContactResult: {
      ok: false,
      containerSelector: null,
      reason: "contact_url_missing_and_not_found_in_list",
    },
  });
  const result = await h.engine.run();

  assert.equal(result.skipped, 1);
  assert.equal(h.indexOf("readConversation"), -1);
  const reported = h.logsOf("chat_contact_open");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].reason, "contact_url_missing_and_not_found_in_list");
  // 容器没定位到 ≠ 打开失败：这两条日志必须互斥，不能混着说
  assert.equal(h.logsOf("chat_page_not_ready").length, 0);
});

test("站点没完全打开：本轮不读不说（不把空会话当「对方没说话」）", async () => {
  const h = makeHarness({
    ready: {
      ready: false,
      blocked: false,
      reason: "会话容器一直没出现（已等 25s）",
      containerSelector: null,
    },
  });
  const result = await h.engine.run();

  assert.equal(result.stopReason, "slice_complete");
  assert.equal(h.logsOf("chat_page_not_ready").length, 1);
  // 没就绪就绝不能读会话、更不能说话（否则「网站还没打开就结束了」会重演）
  assert.equal(h.indexOf("readConversation"), -1);
  assert.equal(h.indexOf("sendText"), -1);
  assert.equal(h.indexOf("draft"), -1);
  // 留到下一片：短复查时间必须写进快照
  const last = h.saves[h.saves.length - 1];
  assert.ok(last.engine.nextWakeAt, "未就绪也要把下次唤醒时间写下来");
});

test("站点明确不是聊天页：交人工，不假装重试能好", async () => {
  const h = makeHarness({
    ready: {
      ready: false,
      blocked: true,
      reason: "站点识别判定当前页面不是聊天页（可能是登录页/首页/错链）",
      containerSelector: null,
    },
  });
  const result = await h.engine.run();

  assert.equal(result.stopReason, "handover");
  assert.equal(h.handovers.length, 1);
  assert.equal(h.indexOf("readConversation"), -1);
  assert.equal(h.indexOf("sendText"), -1);
});

/* ————————————————————————— 一片内来回 ————————————————————————— */

test("一片内来回：对方秒回就顺势接上（不是「发完一条就结束」）", async () => {
  const h = makeHarness({
    maxTurnsPerContact: 3,
    waitSignals: ["mutation", "mutation", "timeout"],
    drafts: [
      { text: "你好呀，最近怎么样？", angle: "a1", costMicroUsd: 10 },
      { text: "那挺好的，回头细聊。", angle: "a2", costMicroUsd: 10 },
      { text: "先不打扰你啦。", angle: "a3", costMicroUsd: 10 },
    ],
  });
  const result = await h.engine.run();

  assert.equal(result.stopReason, "slice_complete");
  assert.equal(h.sentTexts.length, 3, "对方每回一次就接一轮（共 3 轮）");
  assert.equal(new Set(h.sentTexts).size, 3, "每轮都是新内容（不复读）");
});

test("一片内来回有上限：到顶就停，并如实记原因", async () => {
  const h = makeHarness({
    maxTurnsPerContact: 2,
    waitSignals: ["mutation", "mutation", "mutation"],
    drafts: [
      { text: "第一句，先打个招呼。", angle: "a1", costMicroUsd: 10 },
      { text: "第二句，顺着你刚才说的聊。", angle: "a2", costMicroUsd: 10 },
      { text: "第三句，本不该发出去。", angle: "a3", costMicroUsd: 10 },
    ],
  });
  const result = await h.engine.run();

  assert.equal(h.sentTexts.length, 2, "到了回合上限就不再接");
  assert.equal(h.logsOf("chat_turn_limit").length, 1);
  assert.equal(result.stopReason, "slice_complete");
});

test("对方没回话：等一个短预算就收（不硬找话说、也不空转）", async () => {
  const h = makeHarness({ maxTurnsPerContact: 3, waitSignals: ["timeout"] });
  const result = await h.engine.run();

  assert.equal(h.sentTexts.length, 1);
  assert.equal(h.logsOf("chat_turn_limit").length, 0);
  assert.equal(result.stopReason, "slice_complete");
  // 「对方还没回话 → 过一会儿再看一眼」的复查时间必须落盘（否则重启就变 48h 后才看）
  const last = h.saves[h.saves.length - 1];
  assert.ok(last.engine.nextWakeAt);
});

test("发出后**持续**守着会话：一次观察超时不算「没人回」，续挂观察直到预算用完", async () => {
  // 现场：冷开场只等 6 秒就收片 → 对方 20 秒后回的话没人接（用户原话「发一句话就结束了」）。
  // 现在预算是一次性给的（剩余片时长），单次观察超时要**续挂**，而不是直接放弃。
  const h = makeHarness({
    maxTurnsPerContact: 2,
    coldReplyWaitMs: 3_000,
    waitTimeoutMs: 1_000,
    waitSignals: ["timeout", "timeout", "mutation"],
    drafts: [
      { text: "第一句，先打个招呼。", angle: "a1", costMicroUsd: 10 },
      { text: "第二句，接住你刚说的。", angle: "a2", costMicroUsd: 10 },
    ],
  });
  await h.engine.run();

  const waits = h.calls.filter((c) => c[0] === "waitForActivity").length;
  assert.ok(waits >= 3, `应当续挂观察直到总预算用完（实际挂了 ${waits} 次）`);
  assert.equal(h.sentTexts.length, 2, "续挂期间真回了话就顺势接上");
});

test("片末恰好错过对方那句：下次唤醒必须是「马上」，绝不掉到 48 小时后的回访", async () => {
  // 现场形态：我方发出后对方立刻回话，但那句落在「片内观察结束」与「片末结算」之间。
  // 老口径会直接放弃盯守 → 下一次唤醒是 48 小时后的回访（「人明明回了它两天不理」）。
  const h = makeHarness({
    now: () => T0,
    followUp: {
      followUpIndex: 0,
      nextDueAt: "2026-09-28T09:00:00.000Z", // 回访到期远在 48 小时后
      lastContactAt: new Date(new Date(T0).getTime() - 42_000).toISOString(),
      lastReplyAt: new Date(new Date(T0).getTime() - 2_000).toISOString(),
      stopped: false,
    },
  });
  await h.engine.run();

  const last = h.saves[h.saves.length - 1];
  const wake = new Date(last.engine.nextWakeAt).getTime();
  const nowMs = new Date(T0).getTime();
  assert.ok(
    wake - nowMs <= 60_000,
    `对方回过话却没接上时必须马上再来（实际 ${(wake - nowMs) / 1000} 秒后）`,
  );
  assert.equal(
    last.contacts[0].nextCheckAt && new Date(last.contacts[0].nextCheckAt).getTime() <= nowMs + 60_000,
    true,
    "联系人身上的短复查时间也必须落在「马上」",
  );
});

/* ————————————————————————— 记忆维护 ————————————————————————— */

test("每轮结束都会递一次记忆压缩机会，且落在 persist 之后", async () => {
  const h = makeHarness();
  await h.engine.run();

  assert.ok(h.indexOf("persist") >= 0, "应先落库");
  assert.ok(h.indexOf("compactMemory") >= 0, "应递记忆压缩机会");
  assert.ok(
    h.indexOf("compactMemory") > h.indexOf("persist"),
    "记忆压缩必须在落库之后（先有流水，才谈得上总结）",
  );
});

test("记忆压缩成功时如实记 chat_memory_compacted 与新增事实数", async () => {
  const h = makeHarness({
    compactMemory: { compacted: true, reason: "uncovered_backlog", factsAdded: 2 },
  });
  await h.engine.run();

  const logs = h.logsOf("chat_memory_compacted");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].reason, "uncovered_backlog");
  assert.equal(logs[0].factsAdded, 2);
});

test("记忆压缩失败不打断这一轮（消息照发），但必须留痕", async () => {
  const h = makeHarness({
    compactMemory: () => {
      throw new Error("memory_backend_down");
    },
  });
  const result = await h.engine.run();

  assert.equal(result.sent, 1, "记忆维护失败不该影响发送");
  const failures = h.logsOf("chat_memory_failed");
  assert.equal(failures.length, 1);
  assert.ok(String(failures[0].error).includes("memory_backend_down"));
});

test("未压缩时不产生 chat_memory_compacted 噪音", async () => {
  const h = makeHarness();
  await h.engine.run();
  assert.equal(h.logsOf("chat_memory_compacted").length, 0);
});

/* ————————————————————————— 空转 ————————————————————————— */

test("没有联系人 → 不调模型、不读页面，如实说「没有要聊的对象」", async () => {
  const h = makeHarness({ contacts: [] });
  const result = await h.engine.run();

  // 空名单是**可解释的收尾**：既不是失败（宿主不因此挂起自动值守），也不是「干完活」。
  // 用户现场正是这里被并进 `slice_complete` →「开始值守一秒结束」且没有任何说明（§0.5.3 H）。
  assert.equal(result.stopReason, "no_targets");
  assert.ok(result.note && result.note.length > 0, "必须给出「现在该做什么」的人话提示");
  assert.equal(result.processed, 0);
  assert.equal(h.indexOf("draft"), -1);
  assert.equal(h.indexOf("readConversation"), -1);
});

test("abort 立即停止，不发送", async () => {
  const h = makeHarness();
  h.controller.abort("user_stop");
  const result = await h.engine.run();

  assert.equal(result.stopReason, "aborted");
  assert.equal(h.indexOf("sendText"), -1);
});

/* ————————————————————————— 正常闭环 ————————————————————————— */

test("有未读 → 发送 → 计数与持久化正确", async () => {
  const h = makeHarness();
  const result = await h.engine.run();

  assert.equal(h.sentTexts.length, 1);

  const last = result.snapshot;
  assert.equal(last.counters.sentTotal, 1);
  assert.equal(last.counters.sentToday, 1);

  // 发出后排温热追问（分钟级），不再排 48h 销售回访
  const contact = last.contacts.find((c) => c.key === "env-1|telegram|alice");
  assert.ok(contact, "联系人状态应写回快照");
  assert.ok(contact.nextDueAt, "发出后应排下次主动追问时间");
  const dueMs = new Date(contact.nextDueAt).getTime() - new Date(T0).getTime();
  assert.ok(dueMs > 60_000 && dueMs < 10 * 60_000, `温热追问应在数分钟内，实际 ${dueMs}ms`);
  assert.equal(contact.lastIncomingHash, null, "未读标记应被消费，避免反复触发");

  // 下次唤醒时间必须写进快照（这是 Host 调度器排班的依据）
  assert.ok(last.engine.nextWakeAt, "nextWakeAt 必须被持久化");
  assert.equal(last.engine.phase, "waiting", "片末应进入 idle 相位");

  // 发件箱终态为 sent
  assert.equal(last.outbox.length, 1);
  assert.equal(last.outbox[0].status, "sent");

  assert.ok(h.logsOf("chat_send").some((l) => l.message?.includes?.("已发出")));
});

test("durable-before-return：出站意图先落盘，再发生真实副作用", async () => {
  const h = makeHarness();
  await h.engine.run();

  const sendIdx = h.indexOf("sendText");
  assert.ok(sendIdx > 0, "应发生发送");

  // 发送之前必须至少有一次 saveSnapshot，且那一刻 outbox 里已有 pending 项
  let sawPendingBeforeSend = false;
  for (const snapshot of h.saves) {
    if (snapshot.outbox.some((e) => e.status === "pending")) {
      sawPendingBeforeSend = true;
      break;
    }
  }
  assert.ok(sawPendingBeforeSend, "发送前必须先落盘 pending 意图");

  const firstSaveIdx = h.indexOf("saveSnapshot");
  assert.ok(firstSaveIdx < sendIdx, "落盘必须早于发送");
});

test("人工优先：用户在动 → 让位且绝不抢输入", async () => {
  const h = makeHarness({ userActive: true });
  const result = await h.engine.run();

  assert.equal(h.indexOf("sendText"), -1);
  assert.equal(h.indexOf("openContact"), -1, "用户在用页面时连打开会话都不该做");
  assert.ok(h.logsOf("chat_patrol_yield").some((l) => l.reason === "user_active"));
});

/* ————————————————————————— 去重 ————————————————————————— */

test("草稿连续重复 → 拒绝 3 次后放弃，绝不硬发", async () => {
  const repeated = "你好，我最近也在看这个方向，感觉挺有意思的。";
  const h = makeHarness({
    historyThread: [repeated],
    drafts: [
      { text: repeated, angle: "a1", costMicroUsd: 100 },
      { text: repeated, angle: "a2", costMicroUsd: 100 },
      { text: repeated, angle: "a3", costMicroUsd: 100 },
    ],
  });

  const result = await h.engine.run();

  assert.equal(h.indexOf("sendText"), -1, "重复内容一律不发出");
  assert.equal(result.sent, 0);

  const attempts = h.calls.filter((c) => c[0] === "draft").length;
  assert.equal(attempts, 3, "应重写 3 次");

  // 第 2、3 次必须带上「你已说过」的重写提示
  const hints = h.calls.filter((c) => c[0] === "draft").map((c) => c[1]);
  assert.equal(hints[0], null);
  assert.ok(hints[1] && hints[1].length > 0, "重写必须带提示");
  assert.ok(hints[2] && hints[2].length > 0, "重写必须带提示");

  assert.ok(h.logsOf("chat_draft_rejected").some((l) => l.reason === "give_up"));
});

test("去重后给出新说法 → 正常发出", async () => {
  const repeated = "你好，我最近也在看这个方向，感觉挺有意思的。";
  const h = makeHarness({
    historyThread: [repeated],
    drafts: [
      { text: repeated, angle: "a1", costMicroUsd: 100 },
      { text: "换个说法：这周我约了个线下交流会，你要不要一起？", angle: "a2", costMicroUsd: 100 },
    ],
  });

  const result = await h.engine.run();
  assert.equal(result.sent, 1);
  assert.equal(h.sentTexts.length, 1);
  assert.ok(h.sentTexts[0].includes("线下交流会"));
});

/* ————————————————————————— 幂等发送 ————————————————————————— */

test("发送后回读未见但输入已提交 → 按已发送继续，不弹人工、不重发", async () => {
  const h = makeHarness({ visibleResults: [true, false, false, false, false] });
  const result = await h.engine.run();

  assert.equal(h.sentTexts.length, 1, "只尝试一次");
  assert.equal(result.sent, 1, "输入框已清空路径按已发送计");
  assert.equal(h.handovers.length, 0, "不得再弹人工框堵死续聊");

  const entry = result.snapshot.outbox[0];
  assert.equal(entry.status, "sent");
  assert.ok(
    h.logsOf("chat_send_soft_confirm").length >= 1,
    "必须留下软确认日志（回读未命中但继续）",
  );
});

test("续跑对账：pending 且页面已在 → 不重发，标 sent", async () => {
  const text = "先前那条半发的消息";
  // 让该联系人没有未读、也未到期 → 本轮不会有任何新的发送，
  // 这样 `sent` 计数就只会反映「对账不是发送」这一条不变量。
  const contact = makeContact({ lastIncomingHash: null, nextDueAt: "2026-10-01T00:00:00.000Z" });
  const seeded = seedSnapshot({
    contacts: [contact],
    outbox: [
      {
        effectId: "eff-old",
        threadKey: contact.key,
        textHash: hashText(text),
        status: "pending",
        attempts: 1,
        createdAt: T0,
        lastAttemptAt: T0,
        sentAt: null,
        note: null,
      },
    ],
  });

  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seeded,
    followUp: {
      followUpIndex: 0,
      nextDueAt: "2026-10-01T00:00:00.000Z",
      lastContactAt: T0,
      lastReplyAt: null,
      stopped: false,
    },
    // 页面回读为「已存在」→ 对账即可定案
    visibleResults: [true, true],
  });

  const result = await h.engine.run();

  const reconciled = result.snapshot.outbox.find((e) => e.effectId === "eff-old");
  assert.ok(reconciled, "对账条目不应消失");
  assert.equal(reconciled.status, "sent", "对账后应定案为已发出");
  assert.ok(h.logsOf("chat_outbox_reconcile").length >= 1);

  // 对账不是「发送」：不该为它增加发送计数
  assert.equal(result.sent, 0);
  assert.equal(h.indexOf("sendText"), -1, "对账绝不触发重发");
});

test("续跑对账：pending 但页面未见 → 保持 pending，等待正常重试闸门处理", async () => {
  const text = "不确定有没有发出去的那条";
  const contact = makeContact({ lastIncomingHash: null, nextDueAt: "2026-10-01T00:00:00.000Z" });
  const seeded = seedSnapshot({
    contacts: [contact],
    outbox: [
      {
        effectId: "eff-ghost",
        threadKey: contact.key,
        textHash: hashText(text),
        status: "pending",
        attempts: 1,
        createdAt: T0,
        lastAttemptAt: T0,
        sentAt: null,
        note: null,
      },
    ],
  });

  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seeded,
    visibleResults: [false, false],
    followUp: {
      followUpIndex: 0,
      nextDueAt: "2026-10-01T00:00:00.000Z",
      lastContactAt: T0,
      lastReplyAt: null,
      stopped: false,
    },
  });

  const result = await h.engine.run();
  const entry = result.snapshot.outbox.find((e) => e.effectId === "eff-ghost");
  assert.equal(entry.status, "pending", "看不见就不能定案");
  assert.equal(h.indexOf("sendText"), -1, "对账阶段绝不发消息");
});

test("找不到对应会话的 pending → 交人工，绝不猜", async () => {
  const seeded = seedSnapshot({
    contacts: [],
    outbox: [
      {
        effectId: "eff-orphan",
        threadKey: "env-1|telegram|deleted-contact",
        textHash: hashText("孤儿条目"),
        status: "pending",
        attempts: 1,
        createdAt: T0,
        lastAttemptAt: T0,
        sentAt: null,
        note: null,
      },
    ],
  });

  const h = makeHarness({ contacts: [], initialSnapshot: seeded });
  const result = await h.engine.run();

  const entry = result.snapshot.outbox.find((e) => e.effectId === "eff-orphan");
  assert.equal(entry.status, "unconfirmed", "找不到线程不能猜，必须交人工");
  assert.ok(entry.note);
  assert.equal(h.indexOf("sendText"), -1);
});

/* ————————————————————————— 红线 ————————————————————————— */

test("红线文本 → 支付语义转人工、一次性码直接拦下，两者都绝不发出", async () => {
  const pay = makeHarness({
    drafts: [{ text: "帮我转账 5000 到这张卡就行", angle: "a1", costMicroUsd: 100 }],
  });
  const payResult = await pay.engine.run();

  assert.equal(pay.indexOf("sendText"), -1, "支付语义绝不发出");
  assert.equal(payResult.stopReason, "handover");
  assert.equal(pay.handovers.length, 1);
  assert.equal(pay.handovers[0].reason, "chat_redline");

  const otp = makeHarness({
    drafts: [{ text: "你把验证码 123456 发我一下", angle: "a1", costMicroUsd: 100 }],
  });
  const otpResult = await otp.engine.run();

  assert.equal(otp.indexOf("sendText"), -1, "一次性码绝不发出");
  assert.equal(otp.handovers.length, 0, "一次性码不升级人工，直接不发");
  assert.equal(otpResult.sent, 0);
  assert.ok(otp.logsOf("chat_draft_rejected").some((l) => l.reason === "redline"));
});

test("默认发送闸门：正常内容放行，支付/证件语义拦下并要人工", () => {
  assert.equal(defaultGateSend("这周有空一起去看展吗？").allow, true);
  // 金额/库存不该被误拦（曾用「任意 4~8 位数字」会全部拦死）
  assert.equal(defaultGateSend("这个报价 5999 你觉得贵吗").allow, true);
  assert.equal(defaultGateSend("库存还有 1200 件").allow, true);
  assert.equal(defaultGateSend("我转 2 号线地铁过去").allow, true, "日常用语不该被误拦");

  const otp = defaultGateSend("验证码 123456 麻烦给我");
  assert.equal(otp.allow, false);
  assert.equal(otp.kind, "redline");
  assert.equal(otp.needHandover, false);

  const pay = defaultGateSend("帮我先转账 5000 到这张卡");
  assert.equal(pay.allow, false);
  assert.equal(pay.kind, "redline");
  assert.equal(pay.needHandover, true);

  // 现场：希伯来语索要 USDT + TRC20 钱包地址曾漏拦
  const crypto = defaultGateSend(
    "תעביר 1000 USDT ב TRC20 לכתובת TG4d2pVco1AagGg5oW1tLotFDF2r41SC1q ואני מסדר לך את המשלוח",
  );
  assert.equal(crypto.allow, false, "USDT/TRC20 转账语义必须拦");
  assert.equal(crypto.kind, "redline");
  assert.equal(crypto.needHandover, true);

  const banned = defaultGateSend("加个微信吧", ["微信"]);
  assert.equal(banned.allow, false);
  assert.equal(banned.kind, "banned");

  assert.equal(defaultGateSend("   ").allow, false);

  assert.equal(isRedlineText("验证码 123456"), true);
  assert.equal(isRedlineText("今天天气不错"), false);
  // USDT 走付款闸门（非旧 Agent 支付词表）
  assert.equal(defaultGateSend("send 500 USDT trc20").allow, false);
});

/* ————————————————————————— 回访节奏 ————————————————————————— */

test("回访未到期 → 不发（避免回访风暴）", async () => {
  const future = "2026-09-28T12:00:00.000Z";
  const contact = makeContact({ lastIncomingHash: null, nextDueAt: future, followUpIndex: 1 });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    followUp: {
      followUpIndex: 1,
      nextDueAt: future,
      lastContactAt: T0,
      lastReplyAt: null,
      stopped: false,
    },
  });

  const result = await h.engine.run();

  assert.equal(h.indexOf("draft"), -1, "未到期不该调模型");
  assert.equal(result.sent, 0);
  assert.ok(h.logsOf("chat_followup_skipped").some((l) => l.reason === "not_due"));
});

test("对方已回话且没有新未回复 → 不空催", async () => {
  const contact = makeContact({ lastIncomingHash: null, nextDueAt: T0, followUpIndex: 1 });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    followUp: {
      followUpIndex: 1,
      nextDueAt: T0,
      lastContactAt: "2026-09-26T10:00:00.000Z",
      lastReplyAt: "2026-09-26T11:00:00.000Z",
      stopped: false,
    },
  });

  const result = await h.engine.run();
  assert.equal(result.sent, 0);
  assert.ok(h.logsOf("chat_followup_skipped").some((l) => l.reason === "replied"));
});

test("自己刚发出的消息渲染成新节点 → 绝不当成对方回话（方向是结构的一部分）", async () => {
  // 现场症状「只会给每个人重复发同一句话」的根因：老代码用不分方向的 newCount 判「对方回话了没有」，
  // 于是我们自己刚发出去的那条被渲染成新节点，也被当成「对方回话」→ 又回一次 → 复读。
  const contact = makeContact({ lastIncomingHash: "in-1", followUpIndex: 1 });
  const h = makeHarness({
    contacts: [contact],
    messages: [
      { id: "m-1", direction: "in", text: "你好，你也是做这个的吗？" },
      { id: "m-2", direction: "out", text: "是我，刚看到你的消息。" },
    ],
    newCount: 1,
    newIncoming: [],
    newOutgoing: [{ id: "m-2", direction: "out", text: "是我，刚看到你的消息。" }],
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    followUp: {
      followUpIndex: 1,
      nextDueAt: "2026-09-28T12:00:00.000Z",
      lastContactAt: T0,
      lastReplyAt: null,
      stopped: false,
    },
  });

  const result = await h.engine.run();
  assert.equal(h.indexOf("draft"), -1, "对方没说话就不该再调模型起草（那就是自问自答式复读）");
  assert.equal(h.indexOf("sendText"), -1);
  assert.equal(result.sent, 0);
});

test("退订/拒绝态度只记日志，不停手、仍按角色继续回", async () => {
  const h = makeHarness({ nextStage: "opted_out" });
  const result = await h.engine.run();

  assert.ok(h.logsOf("chat_opted_out").length === 1, "态度偏拒绝要留痕");
  assert.equal(result.sent, 1, "不停手：对方说了话仍要回");
  const contact = result.snapshot.contacts.find((c) => c.key === "env-1|telegram|alice");
  assert.notEqual(contact?.stopped, true, "退订不再永久停手");
  assert.notEqual(contact?.stopReason, "opted_out");
});

/* ————————————————————————— 读取降级必须可见 ————————————————————————— */

test("读取退回兜底轮询 → 如实标注，不静默降级", async () => {
  const h = makeHarness({ fallbackPoll: true });
  await h.engine.run();
  assert.ok(h.logsOf("chat_wait_fallback_poll").length >= 1);
});

test("上方仍有未读到历史 → 如实标注 moreAbove", async () => {
  const h = makeHarness({ moreAbove: true });
  await h.engine.run();
  assert.ok(h.logsOf("chat_read").some((l) => l.moreAbove === true));
});

test("读取失败 → 跳过且不调模型", async () => {
  const h = makeHarness({ readOk: false, readReason: "container_missing" });
  await h.engine.run();
  assert.equal(h.indexOf("draft"), -1);
  assert.equal(h.indexOf("sendText"), -1);
  assert.ok(h.logsOf("chat_read").some((l) => l.reason === "container_missing"));
});

/* ————————————————————————— 相位与并发 ————————————————————————— */

test("多联系人逐个处理，相位转移全程合法（内部 assertTransition 不抛）", async () => {
  const a = makeContact({ key: "env-1|telegram|alice", lastIncomingHash: "i-a" });
  const b = makeContact({ key: "env-1|telegram|bob", lastIncomingHash: "i-b", label: "Bob" });
  const h = makeHarness({ contacts: [a, b], drafts: [{ text: "第一条不同的开场白", angle: "a1", costMicroUsd: 1 }] });

  const result = await h.engine.run();

  assert.equal(result.processed, 2);
  assert.equal(result.snapshot.contactCount ?? result.snapshot.contacts.length, 2);

  // 相位序列必须始终是合法转移；出现非法转移时 advancePhase 会抛并被引擎吞成 browser_closed
  assert.notEqual(result.stopReason, "browser_closed", "相位转移非法会让引擎异常退出");
  assert.equal(result.snapshot.engine.phase, "waiting");
});

test("能从自己写下的持久化快照续跑（waiting / stopped 都要能起新片）", async () => {
  // 这条曾经是真坑：引擎把片末相位写成 waiting，下一片却想进 booting，
  // 而 waiting → booting 不在转移表里，于是每片都异常退出、永远跑不起来。
  for (const phase of ["waiting", "paused", "handover", "stopped", "scanning", "recording"]) {
    const contact = makeContact({ lastIncomingHash: "in-1" });
    const seeded = seedSnapshot({ contacts: [contact] });
    seeded.engine = { ...seeded.engine, phase };

    const h = makeHarness({ initialSnapshot: seeded });
    const result = await h.engine.run();

    assert.notEqual(
      result.stopReason,
      "browser_closed",
      `从 ${phase} 起片莫名异常退出：${JSON.stringify(h.logsOf("chat_state_update"))}`,
    );
    assert.equal(result.sent, 1, `从 ${phase} 起片应当照常工作`);
  }
});

test("对方回话后追问序号归零，并重排温热追问", async () => {
  // 场景：已经追问过几次，对方终于回话 → 我们回复后序号归零，再排下次轻推
  const contact = makeContact({ lastIncomingHash: "in-9", followUpIndex: 3 });
  const h = makeHarness({
    contacts: [contact],
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    messages: [{ id: "m-9", direction: "in", text: "在的，你说" }],
    newCount: 1,
    followUp: {
      followUpIndex: 3,
      nextDueAt: T0,
      lastContactAt: "2026-09-20T00:00:00.000Z",
      lastReplyAt: "2026-09-25T00:00:00.000Z",
      stopped: false,
    },
  });

  const result = await h.engine.run();
  assert.equal(result.sent, 1, "对方回话后应当正常回复");

  const updated = result.snapshot.contacts.find((c) => c.key === contact.key);
  assert.equal(updated.followUpIndex, 0, "回话后追问序号必须归零");
  assert.ok(updated.nextDueAt, "回话后应重排温热追问，不冷场");
});

test("生产环境 detectRecentUserActivity 探针不可用时不阻拦引擎", async () => {
  const fakePage = {
    evaluate: async () => ({ lastActivityAt: 0, probeAvailable: false, active: false }),
  };
  const result = await detectRecentUserActivity(fakePage, 20_000);
  assert.equal(result.active, false);
  assert.equal(result.probeAvailable, false);
});

test("探针读取失败 → 安全降级为不阻拦", async () => {
  const fakePage = {
    evaluate: async () => {
      throw new Error("page closed");
    },
  };
  const result = await detectRecentUserActivity(fakePage, 20_000);
  assert.deepEqual(result, { active: false, lastActivityAt: 0, probeAvailable: false });
});

/* ————————————————————————— 片内进展（看门狗判「卡死」的依据） ————————————————————————— */

test("片内子步骤必须推进 progressCounter（相位不变也要让宿主看见「在动」）", async () => {
  const h = makeHarness();
  const result = await h.engine.run();

  // 相位推进的次数（每次 `enter` 记一行）
  const phaseSteps = h.logsOf("chat_phase").length;
  assert.ok(phaseSteps > 0, "这一轮应当有相位推进");

  // 若只有相位推进在记账，计数最多等于相位步数；子步骤（读 / 等 LLM / 等回复 / 发送回读）
  // 也必须各自 bump —— 否则一个「相位不变但正在等 LLM」的正常片会被看门狗当成卡死杀掉。
  assert.ok(
    result.snapshot.engine.progressCounter > phaseSteps,
    `子步骤没有推进计数：counter=${result.snapshot.engine.progressCounter} 相位步数=${phaseSteps}`,
  );
});

test("片内快照落盘按 5s 节流：既不丢推进，也不把磁盘当计数器", async () => {
  // 节流判据本身是纯函数（可单测），越界必须放行
  assert.equal(shouldFlushProgress(0, PROGRESS_FLUSH_MS - 1), false);
  assert.equal(shouldFlushProgress(0, PROGRESS_FLUSH_MS), true);
  // 真实一片里至少要有落盘（终态那次必须写）
  const h = makeHarness();
  await h.engine.run();
  assert.ok(h.saves.length > 0, "片末必须落盘快照");
  const last = h.saves[h.saves.length - 1];
  assert.equal(
    last.engine.progressCounter,
    h.saves.map((s) => s.engine.progressCounter).reduce((a, b) => Math.max(a, b), 0),
    "计数必须单调不减（看门狗按「不前进」判卡死）",
  );
});

/* ————————————————————————— 接管：单一事实源 ————————————————————————— */

test("快照里残留 takeover=human 不再永久锁死（接管产品面已删）", async () => {
  // 以前：takeover:human 会在片首整批过滤掉 → 「开始值守 → 一秒结束」。
  // 现在：接管控件已移除，残留字段被忽略，有未读就照常回。
  const contact = makeContact({
    lastIncomingHash: "in-1",
    takeover: "human",
    takeoverReason: USER_TAKEOVER_REASON,
  });
  const h = makeHarness({
    contacts: [contact],
    initialSnapshot: seedSnapshot({ contacts: [] }),
  });
  const result = await h.engine.run();

  assert.equal(result.sent, 1, "残留接管标记不得挡回复");
  assert.equal(h.logsOf("chat_takeover_skipped").length, 0, "不再按接管跳过");
});

test("首次读取没有历史基线 → 只建立基线，不判用户接管", async () => {
  // 现场症状：联系人被永久锁死（引擎再也不理）。根因是首次读数把整段历史都算成「新增出站」，
  // 用户以前手打的正常消息被误判成「用户在接管」。
  const contact = makeContact({ lastIncomingHash: "in-1" });
  const h = makeHarness({
    contacts: [contact],
    messages: [
      { id: "m-1", direction: "out", text: "这是用户以前手打的历史消息" },
      { id: "m-2", direction: "in", text: "在吗" },
    ],
    newCount: 2,
    baselineKnown: false,
  });
  const result = await h.engine.run();

  assert.equal(h.logsOf("chat_takeover_baseline_unknown").length, 1, "没有基线这件事要留痕");
  assert.equal(h.logsOf("chat_takeover_detected").length, 0, "没有基线就不许判接管");
  const stored = result.snapshot.contacts.find((c) => c.key === contact.key);
  assert.notEqual(stored?.takeover, "human");
  assert.equal(result.sent, 1, "照常回复（不该因为一条历史出站消息就永久锁死）");
});

test("有历史基线且出现陌生出站消息 → 只记诊断，不停手、照常回复", async () => {
  const contact = makeContact({ lastIncomingHash: "in-1" });
  const h = makeHarness({
    contacts: [contact],
    messages: [
      { id: "m-1", direction: "out", text: "用户刚手打的一句（发件箱里没有）" },
      { id: "m-2", direction: "in", text: "好的" },
    ],
    newCount: 2,
    baselineKnown: true,
  });
  const result = await h.engine.run();

  assert.equal(h.logsOf("chat_takeover_detected").length, 1, "陌生出站要留诊断");
  assert.equal(result.sent, 1, "不再永久锁死：对方说了话仍要回");
  const stored = result.snapshot.contacts.find((c) => c.key === contact.key);
  assert.notEqual(stored?.takeover, "human", "不得把联系人写成永久接管");
});

/* ————————————————————————— 页面装饰（时间戳/已读勾）不得污染判定 ————————————————————————— */

test("去装饰：尾部时间/已读勾被剥掉，正文本身不动（单次时间不误伤）", () => {
  // 现场原文（Telegram Web K 把显示时间渲染进正文容器）：
  assert.equal(stripDecorationTail("你好✓✓16:57✓✓16:57"), "你好");
  assert.equal(stripDecorationTail("给我看看价格表00:1300:13"), "给我看看价格表");
  // 正文里本来就有时间（只出现一次）→ 不许削
  assert.equal(stripDecorationTail("明天 10:30 见"), "明天 10:30 见");
  // 指纹同一套口径：正文 + 装饰 与 纯正文 必须得到同一个指纹
  assert.equal(hashText("…聊聊吧。02:20 02:20"), hashText("…聊聊吧。"));
  assert.equal(normalizeForEffect("你好 02:20 02:20"), normalizeForEffect("你好"));
});

test("宽松比对：页面正文带装饰时仍认得出「这是我发的」（短文本不参与包含比对）", () => {
  const own = ["你好，平时还要玩哪个游戏？有哪些特别想玩的？选一个我陪你聊聊吧。"];
  assert.ok(looksLikeOwnSentText("你好，平时还要玩哪个游戏？有哪些特别想玩的？选一个我陪你聊聊吧。02:20 02:20", own));
  assert.equal(looksLikeOwnSentText("王者荣耀02:21 02:21", own), null, "对方那句不能算成我方发过");
  assert.equal(looksLikeOwnSentText("你好呀", own, 8), null, "短文本的包含关系没有区分度，不参与比对");
});

test("我们自己刚发的那条（页面带时间戳）→ 绝不判用户接管，且照常回复对方", async () => {
  // 现场（§0.5.3 H）：02:20:56 发出 → 02:24 下一片读到它时指纹对不上 →
  // `检测到你接管 · 引擎停手` → 该联系人**永久不再回复**。用户观感就是
  // 「只会发送一条信息，后面就算对方回复了机器人也不会自动回复」。
  const contact = makeContact({ lastIncomingHash: null, followUpIndex: 0 });
  const sent = "你好，平时还要玩哪个游戏？有哪些特别想玩的？选一个我陪你聊聊吧。";
  const h = makeHarness({
    contacts: [contact],
    messages: [
      { id: "k:data-mid:13", direction: "out", text: `${sent}02:2002:20` },
      { id: "k:data-mid:14", direction: "in", text: "王者荣耀02:2102:21" },
    ],
    newCount: 2,
    baselineKnown: true,
    // 我方发过的那句（装配层从发件箱 / 已发缓存读来的原文）
    historyThread: [sent],
    drafts: [{ text: "王者荣耀我也玩过一阵，你主玩哪个位置？", angle: "聊游戏", costMicroUsd: 1 }],
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    followUp: { followUpIndex: 0, nextDueAt: null, lastContactAt: "2026-09-26T10:00:00.000Z", lastReplyAt: null, stopped: false },
  });

  const result = await h.engine.run();

  assert.equal(h.logsOf("chat_takeover_detected").length, 0, "自己发的那条绝不能被当成「用户接管」");
  const stored = result.snapshot.contacts.find((c) => c.key === contact.key);
  assert.notEqual(stored?.takeover, "human", "不能把联系人永久锁死");
  assert.equal(result.sent, 1, "对方说了话就必须回");
});

test("上一片读到却没回成的对方消息 → 下一片（含重启）照样回复", async () => {
  // 用户原话：「重启机器后检查聊天记录还是上次那些，不会自动回复」。
  // 这些消息早已在台账里（`newIncoming` 为空），只认「新增」的实现让它们永远没人回。
  const contact = makeContact({ lastIncomingHash: null, followUpIndex: 0 });
  const h = makeHarness({
    contacts: [contact],
    messages: [
      { id: "m-1", direction: "out", text: "你好，平时喜欢玩什么？" },
      { id: "m-2", direction: "in", text: "在吗" },
      { id: "m-3", direction: "in", text: "我喜欢打游戏" },
      { id: "m-4", direction: "in", text: "王者荣耀" },
    ],
    newCount: 0,
    newIncoming: [],
    baselineKnown: true,
    historyThread: ["你好，平时喜欢玩什么？"],
    drafts: [{ text: "王者荣耀挺火的，你一般什么时候玩？", angle: "聊游戏", costMicroUsd: 1 }],
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    followUp: { followUpIndex: 0, nextDueAt: null, lastContactAt: "2026-09-26T10:00:00.000Z", lastReplyAt: null, stopped: false },
  });

  const result = await h.engine.run();

  assert.equal(result.sent, 1, "对方在等回话就必须回，与「本片是否新增」无关");
  assert.ok(h.logsOf("chat_read").some((l) => l.unanswered === 3), "把「还有没回的消息」如实记下来");
  // 对方连发的三条要**一起**交给模型（总结成一条回复），不是只回最后一句
  const draftCall = h.calls.find((c) => c[0] === "draft");
  assert.equal(draftCall?.[2], 3, "未回复的对方消息必须整批进提示词");
});

test("对方撤回不算「在等回话」（不与撤回行较劲）", () => {
  const messages = [
    { id: "m-1", direction: "out", text: "在吗" },
    { id: "m-2", direction: "in", text: "", kind: "retracted" },
  ];
  assert.deepEqual(unansweredIncoming(messages).map((m) => m.id), []);
});

test("对方发的是图/语音（文本为空）也算「在等回话」（只回话、不取内容）", () => {
  const messages = [
    { id: "m-1", direction: "out", text: "发我看看" },
    { id: "m-2", direction: "in", text: "", kind: "media" },
  ];
  assert.deepEqual(unansweredIncoming(messages).map((m) => m.id), ["m-2"]);
});

test("方向没判出来的行，只要内容是我方发过的 → 也算「我方发过话」，不反复回", () => {
  // 一次方向误判不该变成「每片都回同一句」（R7 刷屏）。内容判定交给调用方（引擎的 `isOwnSentText`）。
  const messages = [
    { id: "m-1", direction: "in", text: "在吗" },
    { id: "m-2", direction: "unknown", text: "在的，刚忙完" },
  ];
  const isOwnText = (text) => text === "在的，刚忙完";
  assert.deepEqual(unansweredIncoming(messages, { isOwnText }).map((m) => m.id), []);
  // 同样的位置若**不是**我方发的（系统提示之类），不能因此吞掉对方那条
  assert.deepEqual(unansweredIncoming(messages).map((m) => m.id), ["m-1"]);
});

test("方向误判：对方气泡被标成 out、但我方证据对不上 → 仍算未回复", () => {
  const isOwnText = (text) => text === "我方已发过这句";
  const messages = [
    { id: "m-0", direction: "out", text: "我方已发过这句" },
    { id: "m-1", direction: "out", text: "אתה נוכל" },
  ];
  assert.deepEqual(
    unansweredIncoming(messages, { isOwnText, reinterpretMislabeledOut: true }).map((m) => m.id),
    ["m-1"],
  );
  // 没有发件证据时绝不反转（避免冷会话把历史出站全当成对方）
  assert.deepEqual(
    unansweredIncoming(messages, { isOwnText, reinterpretMislabeledOut: false }).map((m) => m.id),
    [],
  );
});

test("方向误判：我方气泡被标成 in → 按出站截断，不反复回", () => {
  const isOwnText = (text) => text === "סבבה זה שמור אצלי";
  const messages = [
    { id: "m-1", direction: "in", text: "אתה רובוט" },
    { id: "m-2", direction: "in", text: "סבבה זה שמור אצלי" },
  ];
  assert.deepEqual(unansweredIncoming(messages, { isOwnText }).map((m) => m.id), []);
});

/* ————————————————————————— 回访产品已删：不追发，只盯守 ————————————————————————— */

/** 静默时段永不生效的节奏（否则断言会随测试机器时区变红） */
const NO_QUIET = { start: "00:00", end: "00:00" };

test("没有未回复且本轮追问次数已用尽 → 不追", async () => {
  const contact = makeContact({ lastIncomingHash: null });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    cadence: { ...DEFAULT_CADENCE, quietHours: NO_QUIET },
    followUp: {
      followUpIndex: 4,
      nextDueAt: "2026-09-25T00:00:00.000Z",
      lastContactAt: "2026-09-20T00:00:00.000Z",
      lastReplyAt: null,
      stopped: false,
    },
  });
  const result = await h.engine.run();

  assert.equal(h.indexOf("sendText"), -1, "次数用尽不追");
  assert.equal(h.indexOf("draft"), -1, "不该白调模型");
  assert.ok(h.logsOf("chat_followup_skipped").some((l) => l.reason === "round_exhausted"));
  assert.equal(result.sent, 0);
});

test("长期静默也不会因「重启一轮」再追（回访通道已删）", async () => {
  const contact = makeContact({ lastIncomingHash: null });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    cadence: { ...DEFAULT_CADENCE, quietHours: NO_QUIET },
    followUp: {
      followUpIndex: 4,
      nextDueAt: "2026-09-25T00:00:00.000Z",
      lastContactAt: "2026-01-01T00:00:00.000Z",
      lastReplyAt: null,
      stopped: false,
    },
  });
  const result = await h.engine.run();

  assert.equal(h.logsOf("chat_followup_revived").length, 0, "不再走回访重启");
  assert.equal(result.sent, 0, "超窗外 / 次数用尽不硬追");
  assert.ok(
    h.logsOf("chat_followup_skipped").some(
      (l) => l.reason === "not_due" || l.reason === "round_exhausted",
    ),
  );
});

/* ————— 首次开场 vs 回访：两条路不能混（§0.5.3 H「选了人却永远不说话」的真坑） ————— */

test("冷联系人 + 关掉「主动追问」→ 仍然发出开场（选了人就必须会开口）", async () => {
  // 开场只认 autoReply；关掉「主动追问」只影响对方沉默后的轻推，不影响首次搭话。
  const contact = makeContact({ followUp: false, lastIncomingHash: null });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
  });

  const result = await h.engine.run();

  assert.equal(result.sent, 1, "开场不是追问：关掉主动追问也要开口");
  assert.equal(h.logsOf("chat_followup_skipped").length, 0, "不该再出现「本轮不发」");
  const updated = result.snapshot.contacts.find((c) => c.key === contact.key);
  assert.equal(updated?.followUpIndex, 0, "关掉追问则发出后不排下次追问序号");
  assert.equal(updated?.nextDueAt, null, "关掉追问则不排下次到期");
  assert.ok(updated?.lastIncomingHash === null, "本轮无未读，发完也要保持已消费");
});

test("冷联系人 + 全局关掉回访 → 开场照发（全局开关也只管「追」，且默认已关）", async () => {
  const contact = makeContact({ lastIncomingHash: null });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    cadence: { ...DEFAULT_CADENCE, followUpEnabled: false, quietHours: NO_QUIET },
  });

  const result = await h.engine.run();

  assert.equal(result.sent, 1, "全局关回访不影响开场");
});

test("已经发过话 + 关掉主动追问 → 不催", async () => {
  const contact = makeContact({ followUp: false, followUpIndex: 1 });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    cadence: { ...DEFAULT_CADENCE, quietHours: NO_QUIET },
    followUp: {
      followUpIndex: 1,
      nextDueAt: T0,
      lastContactAt: "2026-09-20T00:00:00.000Z",
      lastReplyAt: null,
      stopped: false,
    },
  });

  const result = await h.engine.run();

  assert.equal(result.sent, 0, "关掉主动追问 → 不催");
  assert.equal(h.indexOf("draft"), -1, "不该白调模型");
  assert.ok(h.logsOf("chat_followup_skipped").some((l) => l.reason === "contact_off"));
});

test("已经发过话 + 到点 → 主动追问一句", async () => {
  const contact = makeContact({ lastIncomingHash: null, followUpIndex: 0 });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
    cadence: { ...DEFAULT_CADENCE, quietHours: NO_QUIET },
    followUp: {
      followUpIndex: 0,
      nextDueAt: T0,
      lastContactAt: "2026-09-26T11:50:00.000Z",
      lastReplyAt: null,
      stopped: false,
    },
    drafts: [{ text: "那个酒红 512 你还看着吗", angle: "追问库存", costMicroUsd: 1 }],
  });

  const result = await h.engine.run();

  assert.equal(result.sent, 1, "到点应主动追问");
  assert.ok(h.logsOf("chat_followup_sent").some((l) => l.reason === "due"));
  const updated = result.snapshot.contacts.find((c) => c.key === contact.key);
  assert.equal(updated?.followUpIndex, 1);
  assert.ok(updated?.nextDueAt, "应排下次追问时间");
});

test("关掉「自动聊天」→ 不开口，并给出可照做的说明（不静默、不白调模型）", async () => {
  const contact = makeContact({ autoReply: false, followUp: false, lastIncomingHash: null });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    initialSnapshot: seedSnapshot({ contacts: [contact] }),
  });

  const result = await h.engine.run();

  assert.equal(result.sent, 0);
  assert.equal(h.indexOf("draft"), -1, "判定不发就不该调模型");
  const skipped = h.logsOf("chat_followup_skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "chat_off");
  assert.match(String(skipped[0].message ?? ""), /自动聊天/, "必须说清「去哪里打开什么」");
});

/* ————————————————————————— fail-closed：探针没跑成 ≠ 没发过 ————————————————————————— */

test("页面回读探针失败（有半发记录）→ 绝不重发：标 unconfirmed 交人工", async () => {
  // 「探测没跑成」与「页面里确实没有」是两件事。前者若当成「没发过」，崩溃窗口里那条
  // pending 就会被重发 —— 那就是对同一个人刷屏（R7）。这里锁住 fail-closed。
  const prime = makeHarness();
  const primed = await prime.engine.run();
  const entry = primed.snapshot.outbox[0];
  assert.ok(entry, "预热运行应当留下一条发件箱记录");
  assert.equal(entry.status, "sent");

  const contact = makeContact({ lastIncomingHash: "in-1" });
  const h = makeHarness({
    contacts: [contact],
    // 与预热同一片：「同轮次 + 同文本」→ 同一个 effectId（幂等键就是这么算的）
    initialSnapshot: seedSnapshot({
      contacts: [contact],
      outbox: [
        {
          effectId: entry.effectId,
          threadKey: entry.threadKey,
          textHash: entry.textHash,
          status: "pending",
          attempts: 1,
          createdAt: T0,
          lastAttemptAt: T0,
          sentAt: null,
          note: null,
        },
      ],
    }),
    visibleResults: ["throw"], // 对账探针一开始就没跑成
  });
  const result = await h.engine.run();

  assert.equal(h.indexOf("sendText"), -1, "探针失败绝不能当成「没发过」而重发");
  const after = result.snapshot.outbox.find((e) => e.effectId === entry.effectId);
  assert.equal(after?.status, "unconfirmed", "歧义即停：标 unconfirmed");
  assert.equal(h.handovers[0]?.reason, "chat_send_unconfirmed");
  assert.ok(
    h.logsOf("chat_send_unconfirmed").some((l) => l.reason === "probe_failed"),
    "必须如实说明「探针失败」而不是「发送失败」",
  );
});

/* ————————————————————————— 先听后说（盖话打断 · 意图闸 · 历史未读完） ————————————————————————— */

test("多句连发中途对方追问 → 剩余句作废（禁止盖话）", async () => {
  const h = makeHarness({
    // 两条独立提问 → maxBubbles≥2，才能走出「连发中途打断」路径
    messages: [
      { id: "m-1", direction: "in", text: "散热怎么样？" },
      { id: "m-1b", direction: "in", text: "帧率稳吗？" },
    ],
    newCount: 2,
    drafts: [
      {
        text: "散热其实不错，风冷就够日常用",
        texts: [
          "散热其实不错，风冷就够日常用",
          "帧率其实也还稳，刷短视频没问题",
          "你更在意哪一块？",
        ],
        angle: "散热",
        costMicroUsd: 10,
      },
    ],
    afterSend: (sentCount, cfg) => {
      if (sentCount !== 1) return;
      // 发完第 1 句后对方立刻质问 —— 后续句必须停
      cfg.messages = [
        { id: "m-1", direction: "in", text: "散热怎么样？" },
        { id: "m-1b", direction: "in", text: "帧率稳吗？" },
        { id: "m-out-1", direction: "out", text: "散热其实不错，风冷就够日常用" },
        { id: "m-2", direction: "in", text: "你是骗子吗" },
      ];
      cfg.newCount = 4;
    },
    maxTurnsPerContact: 1,
    sliceMs: 120_000,
    replyWaitMs: 50,
    coldReplyWaitMs: 50,
  });

  await h.engine.run();

  assert.equal(h.sentTexts.length, 1, "对方追问后不得继续倒脚本");
  assert.equal(h.sentTexts[0], "散热其实不错，风冷就够日常用");
  assert.ok(
    h.logsOf("chat_send_interrupted").some((l) => (l.remaining ?? 0) >= 1),
    "必须留下连发打断日志",
  );
});

test("待发队列续发前发现对方新话 → 作废待发、优先回话", async () => {
  const contact = makeContact({
    lastIncomingHash: null,
    followUpIndex: 0,
    pendingTexts: ["续发句A散热", "续发句B帧率"],
  });
  const h = makeHarness({
    contacts: [contact],
    // 首轮读：无未回复 → 冷开场想开口；drafting 前 peek 时注入信任质问
    messages: [],
    newCount: 0,
    onRead: (n, cfg) => {
      if (n < 2) return;
      cfg.messages = [{ id: "m-q", direction: "in", text: "回答我 是不是骗子" }];
      cfg.newCount = 1;
      cfg.newIncoming = [{ id: "m-q", direction: "in", text: "回答我 是不是骗子" }];
    },
    drafts: [
      {
        text: "不是骗子，我是真人，刚才没看见",
        texts: ["不是骗子，我是真人，刚才没看见"],
        angle: "澄清",
        costMicroUsd: 5,
      },
    ],
    followUp: {
      followUpIndex: 0,
      nextDueAt: null,
      lastContactAt: null,
      lastReplyAt: null,
      stopped: false,
    },
    maxTurnsPerContact: 1,
    replyWaitMs: 50,
    coldReplyWaitMs: 50,
  });

  const result = await h.engine.run();

  assert.ok(
    h.logsOf("chat_send_interrupted").some((l) => String(l.message ?? "").includes("待发")),
    "有新未回复时必须作废待发",
  );
  assert.equal(h.sentTexts.length, 1);
  assert.match(h.sentTexts[0], /不是骗子|真人/);
  assert.ok(!h.sentTexts.some((t) => /散热|帧率/.test(t)), "不得把待发推销句发出去");
  const after = result.snapshot.contacts.find((c) => c.key === contact.key);
  assert.ok(!(after?.pendingTexts?.length > 0), "pending 必须清空");
});

test("moreAbove=true 且冷开场 → 禁止推销开场", async () => {
  const contact = makeContact({ lastIncomingHash: null, followUpIndex: 0 });
  const h = makeHarness({
    contacts: [contact],
    messages: [],
    newCount: 0,
    moreAbove: true,
    followUp: {
      followUpIndex: 0,
      nextDueAt: null,
      lastContactAt: null,
      lastReplyAt: null,
      stopped: false,
    },
    drafts: [{ text: "你好，看看 Apple18？", angle: "开场", costMicroUsd: 1 }],
  });

  await h.engine.run();

  assert.equal(h.indexOf("sendText"), -1, "历史未读完不得开场推销");
  assert.equal(h.indexOf("draft"), -1, "不应进入起草");
  const skipped = h.logsOf("chat_followup_skipped");
  assert.ok(
    skipped.some((l) => l.reason === "history_incomplete"),
    "必须记 history_incomplete",
  );
});

test("对方问「你是骗子吗」+ 推销草稿 → 意图闸拦下，改发短澄清兜底", async () => {
  const h = makeHarness({
    messages: [{ id: "m-1", direction: "in", text: "你是骗子吗" }],
    newCount: 1,
    drafts: [
      {
        text: "Apple18 散热帧率都很好，错过就没了",
        texts: ["Apple18 散热帧率都很好，错过就没了"],
        angle: "散热",
        costMicroUsd: 8,
      },
    ],
    maxTurnsPerContact: 1,
    replyWaitMs: 50,
  });

  await h.engine.run();

  assert.equal(h.sentTexts.length, 1, "信任质疑不能沉默");
  assert.match(h.sentTexts[0], /不是骗子|不是机器人|真人/);
  assert.ok(!/散热|帧率|Apple18/.test(h.sentTexts[0]), "不得发出产品句");
  const rejected = h.logsOf("chat_draft_rejected");
  assert.ok(
    rejected.some((l) => l.reason === "intent_mismatch" || l.reason === "intent_give_up"),
    "必须留下意图违规日志",
  );
  assert.ok(h.logsOf("chat_trust_fallback").length >= 1, "应走短澄清兜底");
});

test("对方问骗子 + 正面澄清草稿 → 允许发出", async () => {
  const h = makeHarness({
    messages: [{ id: "m-1", direction: "in", text: "你是机器人吗" }],
    newCount: 1,
    drafts: [
      {
        text: "不是机器人，我是真人，刚才在忙没及时回你",
        texts: ["不是机器人，我是真人，刚才在忙没及时回你"],
        angle: "澄清",
        costMicroUsd: 4,
      },
    ],
    maxTurnsPerContact: 1,
    replyWaitMs: 50,
    coldReplyWaitMs: 50,
  });

  await h.engine.run();

  assert.equal(h.sentTexts.length, 1);
  assert.match(h.sentTexts[0], /不是机器人|真人/);
});

test("发完后观察器没报、重读发现对方已回 → 片内续聊（连贯）", async () => {
  // 现场：等 MutationObserver 空等片结束，对方气泡其实已在 —— 「人回了它不理」。
  const h = makeHarness({
    messages: [{ id: "m-1", direction: "in", text: "价格多少？" }],
    newCount: 1,
    drafts: [
      {
        text: "价格还没正式官宣，我给不了准确数字",
        texts: ["价格还没正式官宣，我给不了准确数字"],
        angle: "答价",
        costMicroUsd: 5,
      },
      {
        text: "朋友先拿到的多半是样机或渠道机，你问他们到手价多少？",
        texts: ["朋友先拿到的多半是样机或渠道机，你问他们到手价多少？"],
        angle: "追问",
        costMicroUsd: 5,
      },
    ],
    // 观察器一直超时；靠 wait 里的定期重读发现对方已回
    waitSignals: ["timeout", "timeout", "timeout", "timeout"],
    afterSend: (sentCount, cfg) => {
      if (sentCount !== 1) return;
      cfg.messages = [
        { id: "m-1", direction: "in", text: "价格多少？" },
        { id: "m-out", direction: "out", text: "价格还没正式官宣，我给不了准确数字" },
        { id: "m-2", direction: "in", text: "但是我有一些朋友已经拿到了手" },
      ];
      cfg.newCount = 3;
    },
    maxTurnsPerContact: 2,
    replyWaitMs: 10_000,
    waitTimeoutMs: 2_000,
    sliceMs: 60_000,
    inboundQuietMs: 0,
  });

  await h.engine.run();

  assert.ok(h.sentTexts.length >= 2, "对方回话后必须片内再回一轮");
  assert.match(h.sentTexts[1] ?? "", /朋友|样机|到手/);
  assert.ok(
    h.logsOf("chat_wait").some((l) => String(l.signaledBy ?? "").startsWith("reread")),
    "必须走重读兜底（不能只靠观察器）",
  );
});

test("要图且图库命中 → 发图，不空转问配置", async () => {
  const pick = { path: "/lib/iPhone_18_Pro_Max/深蓝_正面.png", label: "iPhone_18_Pro_Max/深蓝_正面" };
  const h = makeHarness({
    messages: [{ id: "m-1", direction: "in", text: "可以给我看看 Pro Max 深蓝的图片吗" }],
    newCount: 1,
    mediaPick: pick,
    drafts: [{ text: "图我现拍给你看，深蓝成色可以", angle: "实拍", costMicroUsd: 1 }],
  });
  const result = await h.engine.run();
  assert.ok(h.sentImages.includes(pick.path), "必须发出匹配到的那张图");
  assert.notEqual(h.indexOf("sendImage"), -1);
  assert.ok(result.sent >= 1);
  assert.ok(h.logsOf("chat_image_sent").length >= 1);
});

test("要图但图库没有对应文件 → 不发图", async () => {
  const h = makeHarness({
    messages: [{ id: "m-1", direction: "in", text: "给我看看图片" }],
    newCount: 1,
    mediaPick: null,
    drafts: [{ text: "这款现成图我这边还没备上，你先说下要哪个颜色", angle: "备图", costMicroUsd: 1 }],
  });
  await h.engine.run();
  assert.equal(h.sentImages.length, 0);
  assert.ok(h.logsOf("chat_image_missing").length >= 1);
  assert.ok(h.sentTexts.length >= 1);
});

test("要视频且图库命中 → 发图且不承诺视频", async () => {
  const pick = { path: "/lib/iPhone_18_Pro_Max/深蓝_正面.png", label: "iPhone_18_Pro_Max/深蓝_正面" };
  const h = makeHarness({
    messages: [{ id: "m-1", direction: "in", text: "发个视频给我看看成色" }],
    newCount: 1,
    mediaPick: pick,
    drafts: [{ text: "仓库这会儿人不在跟前，我先把实拍图给你看成色", angle: "转图", costMicroUsd: 1 }],
  });
  await h.engine.run();
  assert.ok(h.sentImages.includes(pick.path));
  assert.ok(h.logsOf("chat_media_refused").length >= 1);
  assert.equal(
    h.sentTexts.some((t) => /发视频|我不能发|不会发语音/.test(t)),
    false,
  );
});
