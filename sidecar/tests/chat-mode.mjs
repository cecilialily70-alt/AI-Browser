/**
 * 聊天模式回归测试（P1：通用识别与会话读取）
 *
 * 运行：`npm run test:chat`（先 `npm run build`，测试直接跑编译产物）
 *
 * 覆盖（P1 部分）：
 *   - 站点识别的三态（chat_page / inconclusive / not_chat_page）与「探针失败 ≠ 不像聊天页」
 *   - 分层评分证据可审计、阈值可配、画像加分
 *   - 方向判定：几何为准、token 仅消歧、冲突 → unknown
 *   - 稳定 id 与「原地读最新」去重（不重复计数）
 *   - 虚拟列表回溯「更早」合并顺序与去重
 *   - 诚实性：容器缺失/为空 / 拿不到历史时 `moreAbove=true`，不假装读完
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHAT_BLOCK_CONFIRM_MS,
  FALLBACK_CHAT_SITE_POLICY,
  decideChatReady,
  matchChatSiteProfile,
  scoreChatPage,
  shouldAttemptExtraction,
  siteKeyOf,
} from "../dist/core/web_chat/site_detect.js";
import {
  conversationKeyOf,
  deriveContactLabel,
  ensureChatPage,
  openContact,
  resolveCurrentConversation,
} from "../dist/bu_agent/chat_actions.js";
import {
  mergeLatest,
  mergeOlder,
  messageIdOf,
  resolveDirection,
} from "../dist/core/web_chat/conversation_extract.js";

const POLICY = FALLBACK_CHAT_SITE_POLICY;
const HERE = dirname(fileURLToPath(import.meta.url));

function probeOf(overrides = {}) {
  return {
    ok: true,
    reason: null,
    url: "https://example.com/",
    title: "Example",
    containers: [],
    inputs: [],
    textSample: "",
    viewport: { width: 1280, height: 800 },
    ...overrides,
  };
}

function containerOf(overrides = {}) {
  return {
    containerId: 0,
    selector: ".thread",
    rank: 2,
    roleLog: false,
    ariaLive: null,
    scrollable: false,
    areaRatio: 0.2,
    childCount: 6,
    repeatedSignatureRatio: 0.5,
    distinctSignatures: 2,
    textChars: 100,
    directionAlternating: false,
    belowHasInput: false,
    sendNearby: false,
    ...overrides,
  };
}

/* ————————————————————————— 站点识别 ————————————————————————— */

test("role=log + 重复子结构 + 底部输入 → chat_page", () => {
  const result = scoreChatPage(
    probeOf({
      url: "https://web.telegram.org/k/",
      title: "Telegram",
      containers: [
        containerOf({
          roleLog: true,
          repeatedSignatureRatio: 0.7,
          distinctSignatures: 2,
          directionAlternating: true,
          belowHasInput: true,
          sendNearby: true,
          scrollable: true,
          areaRatio: 0.5,
          textChars: 800,
        }),
      ],
      inputs: [{ tag: "div", role: "textbox", contentEditable: true, placeholder: "Message", ariaLabel: "", yRatio: 0.9 }],
    }),
    POLICY,
  );
  assert.equal(result.verdict, "chat_page");
  assert.ok(result.confidence >= POLICY.thresholds.chatPage);
  assert.ok(result.evidence.some((line) => line.includes("role=log")));
  assert.equal(result.containerSelector, ".thread");
});

test("通用站点（无 role=log）但有重复结构 + 底部输入 + 语义词 → 仍判 chat_page", () => {
  const result = scoreChatPage(
    probeOf({
      url: "https://some-im.example/chat/42",
      title: "Messages",
      containers: [
        containerOf({
          repeatedSignatureRatio: 0.65,
          distinctSignatures: 2,
          directionAlternating: true,
          belowHasInput: true,
          sendNearby: true,
          scrollable: true,
          areaRatio: 0.45,
          textChars: 600,
        }),
      ],
      inputs: [{ tag: "textarea", role: null, contentEditable: false, placeholder: "Type a message", ariaLabel: "", yRatio: 0.92 }],
      textSample: "发送消息 正在输入 已读",
    }),
    POLICY,
  );
  assert.equal(result.verdict, "chat_page");
});

test("普通内容页 → not_chat_page（且给出低分理由）", () => {
  const result = scoreChatPage(
    probeOf({
      url: "https://news.example/article/1",
      title: "某篇文章",
      containers: [containerOf({ repeatedSignatureRatio: 0.25, distinctSignatures: 4, textChars: 300 })],
      textSample: "本文介绍了……",
    }),
    POLICY,
  );
  assert.equal(result.verdict, "not_chat_page");
  assert.ok(result.evidence.some((line) => line.includes("不像聊天页")));
});

test("证据不足（有会话列表但找不到输入框）→ inconclusive，且允许继续尝试读取", () => {
  const result = scoreChatPage(
    probeOf({
      url: "https://forum.example/t/1",
      title: "Thread",
      containers: [
        containerOf({ repeatedSignatureRatio: 0.6, distinctSignatures: 3, directionAlternating: true, textChars: 900 }),
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, "inconclusive");
  assert.equal(shouldAttemptExtraction(result), true);
});

test("探针失败 → inconclusive 且 probeFailed=true（绝不谎报成 not_chat_page）", () => {
  const result = scoreChatPage(probeOf({ ok: false, reason: "page crashed" }), POLICY);
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.probeFailed, true);
  assert.ok(result.evidence.some((line) => line.includes("page crashed")));
  assert.equal(shouldAttemptExtraction(result), true);
});

test("not_chat_page 不值得继续尝试读取", () => {
  const result = scoreChatPage(
    probeOf({ url: "https://news.example/", title: "News", containers: [], textSample: "" }),
    POLICY,
  );
  assert.equal(result.verdict, "not_chat_page");
  assert.equal(shouldAttemptExtraction(result), false);
});

test("阈值可配：抬高阈值后同样的页面降级为 inconclusive", () => {
  const container = containerOf({
    repeatedSignatureRatio: 0.65,
    distinctSignatures: 2,
    directionAlternating: true,
    belowHasInput: true,
    sendNearby: true,
    scrollable: true,
    areaRatio: 0.45,
    textChars: 600,
  });
  const probe = probeOf({
    url: "https://some-im.example/chat/42",
    title: "Messages",
    containers: [container],
    textSample: "发送消息",
  });
  assert.equal(scoreChatPage(probe, POLICY).verdict, "chat_page");
  const strict = { ...POLICY, thresholds: { chatPage: 0.98, notChatPage: 0.3 } };
  assert.equal(scoreChatPage(probe, strict).verdict, "inconclusive");
});

test("左侧会话列表不会被当成会话正文：候选容器之间取最高分（§0.5.3 H）", () => {
  // 现场（Telegram Web）：页内机械预排名把左侧列表排在第一位（重复子结构 92% + 文本量大），
  // 只认 containers[0] 就会把**整份联系人名单**读成「对方发来的一条消息」，
  // 引擎于是回一句「你这条像误粘了通讯录」。判断必须在候选之间比一遍。
  const sidebar = containerOf({
    containerId: 0,
    selector: "#page-chats",
    rank: 3.1,
    repeatedSignatureRatio: 0.92,
    distinctSignatures: 4,
    directionAlternating: false,
    // 与输入框不同栏 → 页内就不该算「下方有输入框」（同栏重叠阈值已被收紧）
    belowHasInput: false,
    sendNearby: false,
    scrollable: true,
    areaRatio: 0.26,
    childCount: 40,
    textChars: 3000,
  });
  const conversation = containerOf({
    containerId: 1,
    selector: "#column-center",
    rank: 1.4,
    repeatedSignatureRatio: 0.9,
    distinctSignatures: 2,
    directionAlternating: true,
    belowHasInput: true,
    sendNearby: true,
    scrollable: true,
    areaRatio: 0.5,
    childCount: 12,
    textChars: 420,
  });
  const result = scoreChatPage(
    probeOf({
      url: "https://web.telegram.org/k/",
      title: "Telegram",
      containers: [sidebar, conversation],
      inputs: [{ tag: "div", role: "textbox", contentEditable: true, placeholder: "Message", ariaLabel: "", yRatio: 0.92 }],
      textSample: "消息 会话 发送",
    }),
    POLICY,
  );
  assert.equal(result.verdict, "chat_page");
  assert.equal(result.containerSelector, "#column-center");
  assert.equal(result.containerId, 1);
  // 反面锁：预排名第一的仍是被误认的那一栏，取最高分才躲得开
  assert.equal(result.containerSelector === sidebar.selector, false);
});

test("站点画像按 host 精确命中（不做子串误伤）", () => {
  const policy = {
    ...POLICY,
    sites: [
      {
        id: "telegram-web",
        hostPattern: /(^|\.)web\.telegram\.org$/i,
        outTokens: ["is-out"],
        inTokens: ["is-in"],
      },
    ],
  };
  assert.equal(matchChatSiteProfile("https://web.telegram.org/k/", policy)?.id, "telegram-web");
  assert.equal(matchChatSiteProfile("https://notweb.telegram.org.evil.com/", policy), null);
  assert.equal(matchChatSiteProfile("not a url", policy), null);
});

/* ————————————————————————— 方向判定 ————————————————————————— */

test("方向：几何优先，token 只消歧", () => {
  assert.equal(resolveDirection({ cxRatio: 0.9, tokens: [] }, POLICY), "out");
  assert.equal(resolveDirection({ cxRatio: 0.1, tokens: [] }, POLICY), "in");
  assert.equal(resolveDirection({ cxRatio: 0.9, tokens: ["message-in"] }, POLICY), "unknown");
  assert.equal(resolveDirection({ cxRatio: 0.5, tokens: ["message-out"] }, POLICY), "out");
  assert.equal(resolveDirection({ cxRatio: 0.5, tokens: ["message-in"] }, POLICY), "in");
  assert.equal(resolveDirection({ cxRatio: 0.5, tokens: ["bubble"] }, POLICY), "unknown");
});

test("方向：token 大小写无关，且画像 token 覆盖默认词表", () => {
  assert.equal(resolveDirection({ cxRatio: 0.5, tokens: ["Message-Out"] }, POLICY), "out");
  assert.equal(
    resolveDirection({ cxRatio: 0.5, tokens: ["is-out"] }, POLICY, ["is-out"], ["is-in"]),
    "out",
  );
  // 画像只给了 is-out/is-in，则默认词表里的 message-out 不再参与消歧
  assert.equal(resolveDirection({ cxRatio: 0.5, tokens: ["message-out"] }, POLICY, ["is-out"], ["is-in"]), "unknown");
});

/* ————————————————————————— 稳定 id 与去重 ————————————————————————— */

function raw(overrides = {}) {
  return {
    key: null,
    text: "你好",
    cxRatio: 0.9,
    tokens: [],
    ts: null,
    identity: null,
    ...overrides,
  };
}

test("稳定 id：有站点 key 用 key；没有则用内容指纹并标 stableId=false", () => {
  const withKey = messageIdOf(raw({ key: "data-id:42" }), "out");
  assert.equal(withKey.stableId, true);
  assert.equal(withKey.id, "k:data-id:42");

  const withoutKey = messageIdOf(raw({ text: "同样的句子" }), "out");
  assert.equal(withoutKey.stableId, false);
  assert.equal(messageIdOf(raw({ text: "同样的句子" }), "out").id, withoutKey.id);
  assert.notEqual(messageIdOf(raw({ text: "同样的句子" }), "in").id, withoutKey.id);
});

test("原地读最新：重复快照不重复计数", () => {
  const items = [raw({ key: "data-id:1", text: "A", cxRatio: 0.9 }), raw({ key: "data-id:2", text: "B", cxRatio: 0.1 })];
  const first = mergeLatest([], items, POLICY);
  assert.equal(first.messages.length, 2);
  assert.equal(first.newCount, 2);
  assert.equal(first.messages[0].direction, "out");
  assert.equal(first.messages[1].direction, "in");

  const second = mergeLatest(first.messages, items, POLICY);
  assert.equal(second.messages.length, 2);
  assert.equal(second.newCount, 0);

  const third = mergeLatest(first.messages, [...items, raw({ key: "data-id:3", text: "C" })], POLICY);
  assert.equal(third.messages.length, 3);
  assert.equal(third.newCount, 1);
});

test("虚拟列表回溯：更早的条目拼在前面，且按 id 去重", () => {
  const latest = mergeLatest(
    [],
    [raw({ key: "data-id:10", text: "最近一条", cxRatio: 0.9 })],
    POLICY,
  ).messages;

  const olderItems = [
    raw({ key: "data-id:8", text: "更早 A", cxRatio: 0.1 }),
    raw({ key: "data-id:9", text: "更早 B", cxRatio: 0.9 }),
    raw({ key: "data-id:10", text: "最近一条", cxRatio: 0.9 }), // 与已有重叠
  ];
  const merged = mergeOlder(latest, olderItems, POLICY);
  assert.deepEqual(
    merged.messages.map((m) => m.id),
    ["k:data-id:8", "k:data-id:9", "k:data-id:10"],
  );
  assert.equal(merged.newCount, 2);
  assert.equal(merged.messages[0].text, "更早 A");
});

test("重复滚动同一段历史不会膨胀（幂等）", () => {
  const latest = mergeLatest([], [raw({ key: "data-id:5", text: "X" })], POLICY).messages;
  const older = [raw({ key: "data-id:4", text: "Y" }), raw({ key: "data-id:5", text: "X" })];
  const once = mergeOlder(latest, older, POLICY);
  const twice = mergeOlder(once.messages, older, POLICY);
  assert.equal(twice.messages.length, 2);
  assert.equal(twice.newCount, 0);
});

test("无 key 的同文重复会被折叠（如实标 stableId=false 的已知代价）", () => {
  const items = [raw({ text: "在吗", cxRatio: 0.9 }), raw({ text: "在吗", cxRatio: 0.9 })];
  const merged = mergeLatest([], items, POLICY);
  assert.equal(merged.messages.length, 1);
  assert.equal(merged.messages[0].stableId, false);
});

/* ————————————————————————— 页面就绪门禁（站点完全打开了吗） ————————————————————————— */

test("就绪判定：四要素齐了才 ready（缺一个都不许开聊）", () => {
  const base = {
    verdict: "chat_page",
    hasContainer: true,
    hasComposer: true,
    htmlLoaded: true,
    stable: true,
    waitedMs: 1000,
    timeoutMs: 25_000,
  };
  assert.equal(decideChatReady(base).state, "ready");
  assert.equal(decideChatReady({ ...base, htmlLoaded: false }).state, "pending");
  assert.equal(decideChatReady({ ...base, hasContainer: false }).state, "pending");
  assert.equal(decideChatReady({ ...base, hasComposer: false }).state, "pending");
  // 「还在渲染」不算就绪：否则会把渲染中的半截会话当读完（用户问题 2 的根因）
  assert.equal(decideChatReady({ ...base, stable: false }).state, "pending");
});

test("就绪判定：等超时 → timeout（fail-closed，不谎报就绪）", () => {
  const stuck = {
    verdict: "chat_page",
    hasContainer: true,
    hasComposer: false,
    htmlLoaded: true,
    stable: false,
    waitedMs: 25_000,
    timeoutMs: 25_000,
  };
  const decision = decideChatReady(stuck);
  assert.equal(decision.state, "timeout");
  assert.match(decision.reason, /25s/);
});

test("就绪判定：明确不是聊天页 → blocked（但必须先过「公平观察窗」，不许刚导航完就下结论）", () => {
  const afterWindow = {
    verdict: "not_chat_page",
    hasContainer: false,
    hasComposer: false,
    htmlLoaded: true,
    stable: false,
    waitedMs: CHAT_BLOCK_CONFIRM_MS,
    timeoutMs: 25_000,
  };
  assert.equal(decideChatReady(afterWindow).state, "blocked");
  // blocked 优先于其它一切：登录页等下去也不会自己变成聊天页
  assert.equal(
    decideChatReady({ ...afterWindow, hasContainer: true, hasComposer: true, stable: true }).state,
    "blocked",
  );

  // 现场坑（§0.5.3 A）：刚发完导航的那一瞬，SPA 首屏还在渲染 → 打分低 → not_chat_page。
  // 那是「还没跑成」，不是结论；拿它当结论就会「打开会话（not_chat_page）→ 一秒后整片结束」。
  assert.equal(decideChatReady({ ...afterWindow, waitedMs: 0 }).state, "pending");
  assert.equal(decideChatReady({ ...afterWindow, waitedMs: 900 }).state, "pending");
  // 页面都还没加载完就更不许下结论
  assert.equal(decideChatReady({ ...afterWindow, waitedMs: 0, htmlLoaded: false }).state, "pending");
  // 一直没加载完 → 到点如实报 timeout（未就绪），而不是谎报「不是聊天页」
  assert.equal(
    decideChatReady({ ...afterWindow, htmlLoaded: false, waitedMs: 25_000 }).state,
    "timeout",
  );
});

/* ————————————————————————— 未指定对象 → 用当前打开的窗口 ————————————————————————— */

test("展示名：标题只是站点名时退回 URL 末段（不把站点名当人名）", () => {
  assert.equal(deriveContactLabel("Telegram", "https://web.telegram.org/k/#@Alyssa").label, "Alyssa");
  assert.equal(deriveContactLabel("Telegram", "https://web.telegram.org/k/#@Alyssa").source, "url");
  assert.equal(deriveContactLabel("小王 - Telegram", "https://web.telegram.org/k/#@x").label, "小王");
  assert.equal(deriveContactLabel("", "").source, "fallback");
});

test("会话身份键由 URL 派生（标题变了也不会换目录）", () => {
  const a = conversationKeyOf("telegram-web", "https://web.telegram.org/k/#@Alyssa?unread=9");
  const b = conversationKeyOf("telegram-web", "https://web.telegram.org/k/#@Alyssa");
  // query 参与、标题不参与：同一会话的两次「看起来不同」的调用必须稳定
  assert.match(a, /^telegram-web\|u:/);
  assert.notEqual(a, b);
  assert.equal(
    conversationKeyOf("telegram-web", "https://web.telegram.org/k/#@Alyssa"),
    conversationKeyOf("telegram-web", "https://web.telegram.org/k/#@Alyssa"),
  );
});

test("当前会话解析：只认已打开的聊天页，并优先用户自己的标签（我们自己开的排在后面）", async () => {
  const opened = fakeChatPage({
    url: "https://web.telegram.org/k/#@Alyssa",
    title: "Alyssa",
    containerSelector: "#chat",
    chatPage: true,
  });
  const own = fakeChatPage({
    url: "https://web.telegram.org/k/",
    title: "Telegram",
    containerSelector: "#chat",
    chatPage: true,
    own: true,
  });
  const browser = fakeBrowser([own, opened]);
  const found = await resolveCurrentConversation(browser, { policy: POLICY });
  assert.equal(found.ok, true);
  // 用户那张被选中，而不是我们自己开的
  assert.equal(found.conversation.url, "https://web.telegram.org/k/#@Alyssa");
  assert.equal(found.conversation.label, "Alyssa");
  assert.notEqual(found.conversation.ownTab, true);
});

test("当前会话解析：没有别的窗口可用时退回我们自己留下的聊天标签（如实标注，不谎报「没窗口」）", async () => {
  // 现场：上一片留下的聊天标签就开在用户眼前，目标留空说「用当前窗口」——
  // 若把它硬排除掉，用户看到的就是「明明开着窗口却报没有可用窗口」。
  const own = fakeChatPage({
    url: "https://web.telegram.org/k/#@Alyssa",
    title: "Alyssa",
    containerSelector: "#chat",
    chatPage: true,
    own: true,
  });
  const browser = fakeBrowser([own]);
  const found = await resolveCurrentConversation(browser, { policy: POLICY });
  assert.equal(found.ok, true);
  assert.equal(found.conversation.ownTab, true);
  // 「用当前窗口」这条路径永远不新开、不导航（用户的窗口原样保留）
  assert.equal(own.navigations, 0);
  assert.equal(own.newTabs, 0);
});

test("当前会话解析：没有可用的聊天页就如实失败（不猜、不新开）", async () => {
  const blank = fakeChatPage({ url: "https://example.com/", title: "Example", chatPage: false });
  const browser = fakeBrowser([blank]);
  const found = await resolveCurrentConversation(browser, { policy: POLICY });
  assert.equal(found.ok, false);
  assert.equal(found.reason, "no_open_chat_window");
  assert.equal(blank.navigations, 0);
  assert.equal(blank.newTabs, 0);
});

function fakeBrowser(pages) {
  return {
    contexts: () => [{ pages: () => pages }],
  };
}

/** 假 context：只有 `pages()` / `newPage()`（`ensureChatPage` 真正用到的那两个） */
function fakeContext(pages, onNewPage) {
  return {
    pages: () => pages,
    opened: 0,
    async newPage() {
      this.opened += 1;
      const page = onNewPage ? onNewPage() : fakeChatPage({ url: "about:blank", title: "" });
      pages.push(page);
      return page;
    },
  };
}

test("聊天标签：同一片内复用（不每片一开）", async () => {
  const context = fakeContext([]);
  const first = await ensureChatPage(context);
  assert.equal(first.created, true);
  assert.equal(context.opened, 1);

  const second = await ensureChatPage(context);
  assert.equal(second.created, false);
  assert.equal(second.adopted, false);
  assert.equal(second.page, first.page);
  // 进程内缓存命中：**不再新开**（同一个账号的多个会话共用这一个标签）
  assert.equal(context.opened, 1);
});

test("聊天标签：sidecar 重启后认领上次留下的标签（否则每片都新开一个窗口）", async () => {
  // 现场：缓存（WeakMap）随进程消失，但标签还开着 —— 不认它就会**每片新开一个**，
  // 而目标往往是同一个账号里的不同会话，于是用户浏览器里堆一排我们开的页。
  const leftover = fakeChatPage({
    url: "https://web.telegram.org/k/#@Alyssa",
    title: "Alyssa",
    own: true,
  });
  const context = fakeContext([leftover]);
  const result = await ensureChatPage(context);
  assert.equal(result.adopted, true);
  assert.equal(result.created, false);
  assert.equal(result.page, leftover);
  assert.equal(context.opened, 0);
});

test("聊天标签：认领只认带标记的标签，绝不劫持用户的窗口", async () => {
  const userTab = fakeChatPage({
    url: "https://web.telegram.org/k/#@Alyssa",
    title: "Alyssa",
    own: false,
  });
  const context = fakeContext([userTab]);
  const result = await ensureChatPage(context);
  assert.equal(result.created, true);
  assert.equal(result.adopted, false);
  assert.equal(context.opened, 1, "用户自己的标签不能被当成聊天专用标签");
});

test("聊天标签的标记用 page.addInitScript（导航后仍认得出自己）", async () => {
  // `evaluate` 打的标记只活在当前文档，`page.goto` 到某个会话就没了 ——
  // 于是「排除自开标签」「跨进程认领」双双失效（现场就是「每次都开一个新窗口」）。
  const context = fakeContext([]);
  const { page } = await ensureChatPage(context);
  assert.ok(page.initScripts >= 1, "必须用页级 addInitScript 打标记（只对本标签生效）");
});

/* ————————————————————————— 同一账号多会话：必须真的切过去 ————————————————————————— */

test("打开会话：同一账号里两个会话只有 hash 不同 → 必须导航（否则发错人）", async () => {
  // 现场最危险的一条（§0.5.3 H）：`#@Alyssa` 与 `#@Bob` 的 origin/path 完全一样，
  // 归一化时若丢掉 hash 就会判「已经在目标会话上」而**跳过导航** ——
  // 我们以为在跟 Bob 说话，实际还在 Alyssa 的会话里读、甚至发。
  const page = fakeChatPage({
    url: "https://web.telegram.org/k/#@Alyssa",
    title: "Alyssa",
    chatPage: true,
  });
  const result = await openContact(page, { label: "Bob", url: "https://web.telegram.org/k/#@Bob" });
  assert.equal(result.ok, true);
  assert.equal(result.navigated, true);
  assert.equal(page.navigations, 1);
  assert.equal(page.currentUrl, "https://web.telegram.org/k/#@Bob");
});

test("打开会话：确实已经在目标会话上时不重复导航（只差末尾斜杠不算切换）", async () => {
  const page = fakeChatPage({
    url: "https://web.telegram.org/k/#@Bob",
    title: "Bob",
    chatPage: true,
  });
  const result = await openContact(page, { label: "Bob", url: "https://web.telegram.org/k#@Bob" });
  assert.equal(result.ok, true);
  assert.equal(result.navigated, false);
  assert.equal(page.navigations, 0);
});

/**
 * 假页面：只实现 `resolveCurrentConversation` / `ensureChatPage` 真正用到的那几个方法
 * （`isClosed` / `evaluate` / `url` / `addInitScript`），并记录有没有被导航或开新标签。
 */
function fakeChatPage({ url, title, containerSelector = "#chat", chatPage = true, own = false }) {
  return {
    navigations: 0,
    newTabs: 0,
    initScripts: 0,
    label: url,
    currentUrl: url,
    isClosed: () => false,
    url() {
      return this.currentUrl;
    },
    async goto(target) {
      this.navigations += 1;
      this.currentUrl = target;
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async addInitScript() {
      this.initScripts += 1;
    },
    async evaluate(fn, arg) {
      if (typeof arg === "string" && arg === "__tst_chat_tab") return own;
      if (typeof fn === "function" && fn.name === "readPageMeta") return undefined;
      // probeChatDom：返回一份最小但结构完整的探针结果
      if (arg && typeof arg === "object" && "maxContainers" in arg) {
        return chatPage
          ? {
              ok: true,
              reason: null,
              url,
              title,
              containers: [
                {
                  containerId: 1,
                  selector: containerSelector,
                  rank: 1,
                  roleLog: false,
                  ariaLive: null,
                  scrollable: true,
                  areaRatio: 0.5,
                  childCount: 8,
                  repeatedSignatureRatio: 0.8,
                  distinctSignatures: 4,
                  textChars: 200,
                  directionAlternating: true,
                  belowHasInput: true,
                  sendNearby: true,
                },
              ],
              inputs: [
                {
                  tag: "textarea",
                  role: null,
                  contentEditable: false,
                  placeholder: "Message",
                  ariaLabel: "",
                  yRatio: 0.9,
                },
              ],
              textSample: "hello there",
              viewport: { width: 1280, height: 800 },
            }
          : {
              ok: true,
              reason: null,
              url,
              title,
              containers: [],
              inputs: [],
              textSample: "welcome",
              viewport: { width: 1280, height: 800 },
            };
      }
      // readPageMeta 的页内函数没有入参：直接回标题/URL
      if (arg === undefined) return { title, url };
      return null;
    },
  };
}

/* ————————————————————————— 源级防退化 ————————————————————————— */

test("源级：页内「下方有输入框」必须要求同栏水平重叠（不许退回 40px 判据）", () => {
  // 页内函数会被序列化执行，所以阈值只能写在页内；这条源码级断言防止它被无声改回去。
  const src = readFileSync(join(HERE, "..", "src", "core", "web_chat", "site_detect.ts"), "utf8");
  assert.ok(src.includes("COMPOSER_OVERLAP_MIN"), "页内判据必须用同栏重叠阈值");
  assert.ok(
    src.includes("overlapRatio(r) >= COMPOSER_OVERLAP_MIN"),
    "「下方有输入框」必须过同栏重叠门槛，否则左侧列表栏也会算成会话容器",
  );
  // 旧判据（左右各放宽 40px）不得以「下方有输入框」的名义回来
  assert.equal(
    /r\.left < rect\.right \+ 40 && r\.right > rect\.left - 40/.test(src),
    false,
    "旧的 40px 判据会把列表栏判成会话容器（§0.5.3 H）",
  );
  // 容器相关的分要在候选之间比一遍，不能只认 containers[0]
  const scoreSrc = src.slice(src.indexOf("export function scoreChatPage"), src.indexOf("function firstTermHit"));
  assert.ok(scoreSrc.includes("for (const candidate of probe.containers)"), "容器候选必须逐一打分取最高");
});

test("站点键派生：有画像用画像，没画像从 URL 派生，取不到才回 unknown（不编假站点键）", () => {
  // 画像 id 优先（配置里声明的站点身份最稳）
  assert.equal(siteKeyOf("https://web.whatsapp.com/", "whatsapp.com"), "whatsapp.com");
  // `unknown` 画像 = 没有画像，必须继续派生（否则又回到「同一昵称撞进同一目录」）
  assert.equal(siteKeyOf("https://web.whatsapp.com/", "unknown"), "whatsapp");
  assert.equal(siteKeyOf("https://chat.example.co.uk/x/1", null), "example");
  // 到处都取不到 → 老实回 unknown，不编一个假站点键
  assert.equal(siteKeyOf("not-a-url", null), "unknown");
  assert.equal(siteKeyOf("http://localhost:3000/", null), "unknown");
  assert.equal(siteKeyOf("", "unknown"), "unknown");
  // 纯函数：同输入必得同输出（目录选一次就永远同一个）
  assert.equal(siteKeyOf("https://t.me/abc", "unknown"), siteKeyOf("https://t.me/abc", "unknown"));
  // 结果必须是目录段（不含 `/`，能直接当路径用）
  assert.equal(siteKeyOf("https://sub.chat.example.com/a", null).includes("/"), false);
});
