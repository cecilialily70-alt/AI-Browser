/**
 * 聊天模式「接线层」回归测试（P2 续：提示词解析 · 阶段判定 · 节奏解析 · 联系人解析）
 *
 * 这些全部是纯函数，不需要浏览器也不需要模型 —— 但正是它们决定「发什么/发不发」，
 * 出错会直接表现为「复读」「机器味」「回访风暴」这些用户看得见的毛病。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatDraftMessages,
  formatChatTodayLabel,
  looksLikeOptOut,
  looksLikeRejection,
  parseChatDraft,
  CHAT_DRAFT_SYSTEM_PROMPT,
} from "../dist/core/web_chat/chat_prompt.js";
import {
  parseCadence,
  parseContactSeeds,
  seedIdentityOf,
  takeoverKeyOf,
  chatSnapshotPath,
  useCurrentWindowMode,
} from "../dist/bu_agent/chat_session.js";
import { threadFlagKeyOf } from "../dist/bu_agent/chat_contacts.js";
import { DEFAULT_CADENCE } from "../dist/core/web_chat/cadence.js";

/* ————————————————————————— 草稿解析 ————————————————————————— */

test("解析标准 JSON 草稿（legacy text）", () => {
  const parsed = parseChatDraft('{"text":"周末你那边也下雨吗？","angle":"天气"}');
  assert.deepEqual(parsed, {
    text: "周末你那边也下雨吗？",
    texts: ["周末你那边也下雨吗？"],
    angle: "天气",
  });
});

test("解析多句 texts[] 草稿", () => {
  const parsed = parseChatDraft(
    '{"texts":["周末你那边也下雨吗？","我这边倒是挺干的"],"angle":"天气"}',
  );
  assert.equal(parsed.text, "周末你那边也下雨吗？");
  assert.deepEqual(parsed.texts, ["周末你那边也下雨吗？", "我这边倒是挺干的"]);
  assert.equal(parsed.angle, "天气");
});

test("texts[] 空元素被丢掉，最多收 3 句（硬顶）", () => {
  const parsed = parseChatDraft(
    '{"texts":["一","","二","三","四","五","六（超限）"],"angle":"列举"}',
  );
  assert.deepEqual(parsed.texts, ["一", "二", "三"]);
  assert.equal(parsed.text, "一");
});

test("texts[] 优先于 legacy text（两者都有时以 texts 为准）", () => {
  const parsed = parseChatDraft('{"texts":["用这条"],"text":"旧字段","angle":"优先"}');
  assert.deepEqual(parsed.texts, ["用这条"]);
  assert.equal(parsed.text, "用这条");
});

test("容忍 markdown 代码块包裹", () => {
  const parsed = parseChatDraft('```json\n{"text":"你说的那家店在哪条街？","angle":"追问地点"}\n```');
  assert.equal(parsed.text, "你说的那家店在哪条街？");
  assert.deepEqual(parsed.texts, ["你说的那家店在哪条街？"]);
  assert.equal(parsed.angle, "追问地点");
});

test("容忍前后夹带说明文字（抠第一个 JSON 对象）", () => {
  const parsed = parseChatDraft('好的，这是回复：{"text":"那我也去试试","angle":"附和"} 希望有用');
  assert.equal(parsed.text, "那我也去试试");
  assert.deepEqual(parsed.texts, ["那我也去试试"]);
});

test("裸文本（明显只有一句话）也接受", () => {
  const parsed = parseChatDraft("你上次说的那个展还在办吗？");
  assert.equal(parsed.text, "你上次说的那个展还在办吗？");
  assert.deepEqual(parsed.texts, ["你上次说的那个展还在办吗？"]);
  assert.equal(parsed.angle, null);
});

test("空/空白/无文本的 JSON → 一律拒绝（绝不发出空消息）", () => {
  assert.equal(parseChatDraft(""), null);
  assert.equal(parseChatDraft("   "), null);
  assert.equal(parseChatDraft('{"text":""}'), null);
  assert.equal(parseChatDraft('{"text":"   "}'), null);
  assert.equal(parseChatDraft('{"texts":[]}'), null);
  assert.equal(parseChatDraft('{"texts":["","  "]}'), null);
  assert.equal(parseChatDraft('{"angle":"只有角度没有正文"}'), null);
});

test("多行解释性输出不被当成消息（防止把小作文发出去）", () => {
  assert.equal(parseChatDraft("好的，我来写一条：\n第一条是问候\n第二条是提问"), null);
});

test("markdown/JSON 畸形 → 不猜，返回 null", () => {
  assert.equal(parseChatDraft("```json\n{ broken json \n```"), null);
  assert.equal(parseChatDraft("{"), null);
});

test("text 键可用 message 别名", () => {
  const parsed = parseChatDraft('{"message":"明天几点出发？"}');
  assert.equal(parsed.text, "明天几点出发？");
  assert.deepEqual(parsed.texts, ["明天几点出发？"]);
});

/* ————————————————————————— 提示词构建 ————————————————————————— */

test("系统提示词明确禁止机器痕迹、复读、敏感信息；问价须报价；默认单句、先答后推", () => {
  for (const must of [
    "对方使用的语言",
    "严禁复述",
    "作为AI",
    "不编造敏感",
    "验证码",
    '"texts"',
    "骗子/机器人",
    "一句说清",
    "渠道大致价",
    "还没官宣",
  ]) {
    assert.ok(CHAT_DRAFT_SYSTEM_PROMPT.includes(must), `系统提示词缺少约束：${must}`);
  }
  assert.ok(
    CHAT_DRAFT_SYSTEM_PROMPT.includes("默认只发 1 句") || CHAT_DRAFT_SYSTEM_PROMPT.includes("最多发"),
    "必须默认单句、收紧多句",
  );
  assert.ok(!/必须说完|禁止截断/.test(CHAT_DRAFT_SYSTEM_PROMPT), "不得压迫模型倒完脚本");
  assert.ok(
    !/不确定的价格、承诺、身份、时间地点一律不写/.test(CHAT_DRAFT_SYSTEM_PROMPT),
    "不得再把「价格一律不写」写成硬禁（会逼模型永远不报价）",
  );
});

test("maxBubbles=1 时 texts 超限被截断；硬顶最多 3 句", () => {
  const one = parseChatDraft('{"texts":["一","二","三","四"],"angle":"x"}', 1);
  assert.deepEqual(one.texts, ["一"]);
  const three = parseChatDraft('{"texts":["一","二","三","四"],"angle":"x"}', 3);
  assert.deepEqual(three.texts, ["一", "二", "三"]);
  const hard = parseChatDraft('{"texts":["一","二","三","四","五","六"],"angle":"x"}');
  assert.deepEqual(hard.texts, ["一", "二", "三"]);
});

test("意图指令与气泡上限写入 user 提示", () => {
  const messages = buildChatDraftMessages({
    siteLabel: "telegram",
    contactLabel: "Anne",
    stage: "engaged",
    goal: "推广",
    styleHint: null,
    roleName: null,
    rolePrompt: null,
    rollingSummary: null,
    longTermFacts: [],
    usedAngles: [],
    recent: [{ id: "1", direction: "in", text: "你是骗子吗", ts: null, identity: null, stableId: false }],
    isFollowUp: false,
    followUpIndex: 0,
    rewriteHint: null,
    intentDirective: "对方在质疑你是骗子/机器人：必须先正面回应",
    maxBubbles: 2,
    nowIso: "2026-09-28T10:00:00.000Z",
  });
  const user = messages[1].content;
  assert.ok(user.includes("本轮硬性意图"));
  assert.ok(user.includes("骗子/机器人"));
  assert.ok(user.includes("本轮最多发 2 句"));
  assert.ok(user.includes("今天是"), "必须写入今日日期，避免模型用过时「还没官宣」搪塞");
  assert.ok(formatChatTodayLabel("2026-09-28T10:00:00.000Z")?.includes("2026年"));
});

test("提示词带入上下文：事实、摘要、已用角度、角色、重写提示", () => {
  const messages = buildChatDraftMessages({
    siteLabel: "telegram",
    contactLabel: "阿澈",
    stage: "engaged",
    goal: "约线下看展",
    styleHint: "轻松口语，别太热情",
    roleName: "摄影搭子",
    rolePrompt: "像懂胶片的朋友那样聊，别推销",
    rollingSummary: "之前聊过摄影和露营",
    longTermFacts: ["对方在杭州", "喜欢胶片相机"],
    usedAngles: ["天气", "摄影"],
    recent: [
      { id: "1", direction: "out", text: "你用的什么相机？", ts: null, identity: null, stableId: false },
      { id: "2", direction: "in", text: "尼康 FM2，最近在拍胶片", ts: null, identity: null, stableId: false },
    ],
    isFollowUp: false,
    followUpIndex: 0,
    rewriteHint: null,
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");

  const user = messages[1].content;
  assert.ok(user.includes("阿澈"));
  assert.ok(user.includes("约线下看展"));
  assert.ok(user.includes("轻松口语"));
  assert.ok(user.includes("摄影搭子"), "必须带上角色名");
  assert.ok(user.includes("像懂胶片的朋友那样聊"), "必须带上角色提示词");
  assert.ok(user.includes("之前聊过摄影和露营"));
  assert.ok(user.includes("对方在杭州"));
  assert.ok(user.includes("天气、摄影"));
  assert.ok(user.includes("我：你用的什么相机？"));
  assert.ok(user.includes("对方：尼康 FM2"));
  assert.ok(user.includes("回复对方"), "必须标明本次性质是回复");
});

test("主动开口轮次必须显式标注", () => {
  const messages = buildChatDraftMessages({
    siteLabel: "telegram",
    contactLabel: "阿澈",
    stage: "engaged",
    goal: "保持联系",
    styleHint: null,
    roleName: null,
    rolePrompt: null,
    rollingSummary: null,
    longTermFacts: [],
    usedAngles: [],
    recent: [],
    isFollowUp: true,
    followUpIndex: 2,
    rewriteHint: null,
  });
  const user = messages[1].content;
  assert.ok(user.includes("主动回访"));
  assert.ok(user.includes("第 2 次回访"));
  assert.ok(user.includes("第一次接触"), "无历史时必须如实说明是首次接触");
});

test("对方一口气发多条 → 提示词明确要求合起来理解（用 texts 接住）", () => {
  const messages = buildChatDraftMessages({
    siteLabel: "telegram",
    contactLabel: "阿澈",
    stage: "engaged",
    goal: "保持联系",
    styleHint: null,
    roleName: null,
    rolePrompt: null,
    rollingSummary: null,
    longTermFacts: [],
    usedAngles: [],
    recent: [
      { id: "m-2", direction: "in", text: "在吗", ts: null, identity: null, stableId: true },
      { id: "m-3", direction: "in", text: "我喜欢打游戏", ts: null, identity: null, stableId: true },
      { id: "m-4", direction: "in", text: "王者荣耀", ts: null, identity: null, stableId: true },
    ],
    isFollowUp: false,
    followUpIndex: 0,
    rewriteHint: null,
  });
  const user = messages[1].content;
  assert.ok(user.includes("连续发了 3 条"), "必须知道对方是**连着**说的");
  assert.ok(user.includes("合起来理解"), "要的是合起来理解，不是逐条回应");
  assert.ok(user.includes("texts"), "必须引导用 texts 多句接住");
});

test("只回一条对方消息时不出现「合并」提示（避免无端引导）", () => {
  const messages = buildChatDraftMessages({
    siteLabel: "telegram",
    contactLabel: "阿澈",
    stage: "engaged",
    goal: "保持联系",
    styleHint: null,
    roleName: null,
    rolePrompt: null,
    rollingSummary: null,
    longTermFacts: [],
    usedAngles: [],
    recent: [{ id: "m-2", direction: "in", text: "在吗", ts: null, identity: null, stableId: true }],
    isFollowUp: false,
    followUpIndex: 0,
    rewriteHint: null,
  });
  assert.ok(!messages[1].content.includes("连续发了"));
});

test("重写提示会原样回传给模型", () => {
  const messages = buildChatDraftMessages({
    siteLabel: "telegram",
    contactLabel: "阿澈",
    stage: "engaged",
    goal: "保持联系",
    styleHint: null,
    roleName: null,
    rolePrompt: null,
    rollingSummary: null,
    longTermFacts: [],
    usedAngles: [],
    recent: [],
    isFollowUp: true,
    followUpIndex: 1,
    rewriteHint: "你之前已经说过：「你好，我最近也在看这个方向」",
  });
  assert.ok(messages[1].content.includes("重复已说过的话"));
  assert.ok(messages[1].content.includes("你好，我最近也在看这个方向"));
});

/* ————————————————————————— 退订 / 拒绝判定 ————————————————————————— */

test("明确退订会被识别（停止回访）", () => {
  for (const text of [
    "别给我发了",
    "不要再联系我了",
    "请停止发消息",
    "我要拉黑你",
    "退订",
    "别烦我",
    "stop messaging me",
    "leave me alone",
    "unsubscribe",
  ]) {
    assert.equal(looksLikeOptOut(text), true, `应识别为退订：${text}`);
  }
});

test("普通冷淡/拒绝不算退订（不能误杀正常对话）", () => {
  for (const text of ["好的", "哈哈", "再说吧", "我在忙", "今天天气不错", "这个多少钱"]) {
    assert.equal(looksLikeOptOut(text), false, `不该当退订：${text}`);
  }
});

test("明确反感识别为 rejected（降级但不停止）", () => {
  for (const text of ["我没兴趣", "用不上，谢谢", "不需要", "not interested"]) {
    assert.equal(looksLikeRejection(text), true, `应识别为拒绝：${text}`);
  }
  assert.equal(looksLikeRejection("有兴趣，聊聊看"), false);
});

test("退订优先于拒绝（退订同时含拒绝表述时以退订为准）", () => {
  const text = "没兴趣，别再联系我了";
  assert.equal(looksLikeOptOut(text), true);
  assert.equal(looksLikeRejection(text), true);
});

/* ————————————————————————— 节奏解析 ————————————————————————— */

test("缺省/非法节奏配置 → 回落到默认（不产生回访风暴）", () => {
  assert.deepEqual(parseCadence(null), DEFAULT_CADENCE);
  assert.deepEqual(parseCadence(undefined), DEFAULT_CADENCE);
  assert.deepEqual(parseCadence("nonsense"), DEFAULT_CADENCE);
  assert.deepEqual(parseCadence({}), DEFAULT_CADENCE);
});

test("默认节奏：回访产品关闭（followUpEnabled=false · maxFollowUps=0 · quietHours=null）", () => {
  assert.equal(DEFAULT_CADENCE.followUpEnabled, false);
  assert.equal(DEFAULT_CADENCE.maxFollowUps, 0);
  assert.equal(DEFAULT_CADENCE.maxPerDay, 0);
  assert.equal(DEFAULT_CADENCE.quietHours, null);
});

test("合法节奏配置被采纳", () => {
  const cadence = parseCadence({
    followUpEnabled: true,
    followUpHours: 24,
    followUpBackoffHours: [48, 120],
    maxFollowUps: 2,
    maxPerDay: 10,
    jitterRatio: 0.2,
    quietHours: { start: "23:00", end: "07:00" },
  });
  assert.equal(cadence.followUpEnabled, true);
  assert.equal(cadence.followUpHours, 24);
  assert.deepEqual(cadence.followUpBackoffHours, [48, 120]);
  assert.equal(cadence.maxFollowUps, 2);
  assert.equal(cadence.maxPerDay, 10);
  assert.equal(cadence.jitterRatio, 0.2);
  assert.deepEqual(cadence.quietHours, { start: "23:00", end: "07:00" });
});

test("非法数值不进入生效配置（NaN/缺失回落默认，越界夹到区间边界）", () => {
  const cadence = parseCadence({
    followUpHours: Number.NaN,
    maxPerDay: Number.NaN,
    followUpBackoffHours: [0, -1],
  });
  // 非数字 = 读不懂 → 回落默认（不猜一个用户没写过的值）
  assert.equal(cadence.followUpHours, DEFAULT_CADENCE.followUpHours);
  assert.equal(cadence.maxPerDay, DEFAULT_CADENCE.maxPerDay);
  assert.deepEqual(cadence.followUpBackoffHours, DEFAULT_CADENCE.followUpBackoffHours);
});

test("越界值夹到区间边界：与设置面板同一套区间（不是回落默认，也不静默丢掉）", () => {
  // 前端 `clampNumber` 对 0 小时的处置就是「收窄到下限 1」；侧车必须同结论，
  // 否则用户看到的是「1 小时」，引擎跑的是「2 天」（§0.5.3 C 两套口径）。
  assert.equal(parseCadence({ followUpHours: 0 }).followUpHours, 1);
  assert.equal(parseCadence({ followUpHours: 99_999 }).followUpHours, 1440);
  assert.equal(parseCadence({ followUpRevivalDays: 0 }).followUpRevivalDays, 1);
  assert.equal(parseCadence({ maxFollowUps: 999 }).maxFollowUps, 60);
  assert.equal(parseCadence({ maxPerDay: 99_999 }).maxPerDay, 2000);
  assert.equal(parseCadence({ followUpCoolDownDays: 99_999 }).followUpCoolDownDays, 365);
});

test("jitterRatio 被夹在 0~0.5（防抖到失控）", () => {
  assert.equal(parseCadence({ jitterRatio: 9 }).jitterRatio, 0.5);
  assert.equal(parseCadence({ jitterRatio: -3 }).jitterRatio, 0);
});

test("0 是实义值：不追发 / 不冷却 / 不限 必须被采纳，不得回落默认（与设置面板 min=0 对齐）", () => {
  const cadence = parseCadence({ maxFollowUps: 0, followUpCoolDownDays: 0, maxPerDay: 0 });
  assert.equal(cadence.maxFollowUps, 0);
  assert.equal(cadence.followUpCoolDownDays, 0);
  // 文档里写的「0 = 不限」必须真的可达（以前前端下限是 1，这个值根本填不出来）
  assert.equal(cadence.maxPerDay, 0);
  // 缺失 / null 才回落默认；负数属于越界，夹到下限 0
  assert.equal(parseCadence({ maxFollowUps: null }).maxFollowUps, DEFAULT_CADENCE.maxFollowUps);
  assert.equal(parseCadence({ maxFollowUps: -1 }).maxFollowUps, 0);
  assert.equal(parseCadence({ followUpCoolDownDays: -1 }).followUpCoolDownDays, 0);
});

test("quietHours 可显式关掉", () => {
  assert.equal(parseCadence({ quietHours: null }).quietHours, null);
});

/* ————————————————————————— 联系人解析 ————————————————————————— */

test("缺省/非法联系人 → 空数组（不猜要跟谁聊）", () => {
  assert.deepEqual(parseContactSeeds(null), []);
  assert.deepEqual(parseContactSeeds(undefined), []);
  assert.deepEqual(parseContactSeeds("nonsense"), []);
  assert.deepEqual(parseContactSeeds([null, 1, "x"]), []);
  assert.deepEqual(parseContactSeeds([{ url: "https://x.com/1" }]), [], "只有 url 没有昵称/key 不算指定");
});

test("合法联系人被解析，key/url/站点齐全", () => {
  const seeds = parseContactSeeds([
    { key: "tg|alice", label: "Alice", siteKey: "telegram", url: "https://web.telegram.org/a/#1" },
    { name: "Bob", chat_url: "https://wa.me/2" },
  ]);
  assert.equal(seeds.length, 2);
  assert.equal(seeds[0].key, "tg|alice");
  assert.equal(seeds[0].label, "Alice");
  assert.equal(seeds[0].url, "https://web.telegram.org/a/#1");

  // 没给 key 时用「站点|昵称」兜底；没给站点时标 unknown，绝不空着
  assert.equal(seeds[1].key, "unknown|Bob");
  assert.equal(seeds[1].label, "Bob");
  assert.equal(seeds[1].siteKey, "unknown");
  assert.equal(seeds[1].url, "https://wa.me/2");
});

test("联系人身份的派生只有一处：引擎与「读取会话列表」算出的是同一个键", () => {
  // 视图从列表勾人后只会回传 {label, url} —— 身份必须按引擎那条路反推，
  // 否则「在列表里关掉自动回复」写进的键与引擎查表的键对不上（§0.5.3 H）。
  const seed = parseContactSeeds([{ label: "Anne", url: "https://web.telegram.org/k/#@anne" }])[0];
  const settled = seedIdentityOf(seed, seed.key, () => false).seed;
  assert.equal(settled.siteKey, "telegram");
  assert.equal(settled.key, "telegram|Anne");
  assert.equal(takeoverKeyOf(settled), "telegram|telegram_Anne", "设置表里的键就是这个");

  // 老用户的旧上下文目录还在 → 沿用 unknown 与旧键（换目录会把同一个人当新对象重新开场）
  const legacy = seedIdentityOf(seed, seed.key, () => true);
  assert.equal(legacy.legacyUsed, true);
  assert.equal(legacy.seed.siteKey, "unknown");
  assert.equal(legacy.seed.key, "unknown|Anne");
  assert.equal(takeoverKeyOf(legacy.seed), "unknown|unknown_Anne");

  // 没有 URL 时不编站点键（宁可回到老口径，也不造一个假站点）
  const noUrl = parseContactSeeds([{ label: "Bob" }])[0];
  const noUrlSettled = seedIdentityOf(noUrl);
  assert.equal(noUrlSettled.seed.siteKey, "unknown");
  assert.equal(takeoverKeyOf(noUrlSettled.seed), "unknown|unknown_Bob");

  // Host 已经给了站点键（非 unknown）时不再改写：只换前缀，别的字节一个不动
  const explicit = parseContactSeeds([{ label: "Bob", siteKey: "wa", url: "https://wa.me/2" }])[0];
  assert.equal(seedIdentityOf(explicit).seed.key, "wa|Bob");
});

test("「读取会话列表」算出的设置表键 = 引擎查表的键（开关点了才真的生效）", () => {
  // 视图只会把 label / url 发回来，所以探针必须按同一条路反推身份
  const url = "https://web.telegram.org/k/#@anne";
  assert.equal(threadFlagKeyOf({ label: "Anne", url }, () => false), "telegram|telegram_Anne");
  // 旧目录在 → 沿用 unknown 与旧键（换目录会把同一个人当新对象重新开场）
  assert.equal(threadFlagKeyOf({ label: "Anne", url }, () => true), "unknown|unknown_Anne");
  // 列表项没有直链时不编站点键（引擎那边也一样）
  assert.equal(threadFlagKeyOf({ label: "Bob", url: null }), "unknown|unknown_Bob");
  // 只有 URL 没有标签 → 拿不出身份（视图据此禁用该行开关，而不是写一个对不上的键）
  assert.equal(threadFlagKeyOf({ label: "", url: null }), "");
});

test("「绑当前窗口、只读不导航」只对没指定对象成立（有目标就必须能打开过去）", () => {
  // 设置项原话就是「**未指定对象时**使用当前打开的窗口」：没指定 → 绑当前窗口
  assert.equal(useCurrentWindowMode(true, 0), true);
  // 指定了要聊的人 → 目标就是目的地，必须走聊天专用标签并由引擎导航过去。
  // 否则页面停在会话列表（Telegram 首屏）时既开不了会话、又不自开标签，整片只会「一秒结束」。
  assert.equal(useCurrentWindowMode(true, 1), false);
  assert.equal(useCurrentWindowMode(true, 8), false);
  // 用户本来就关了这条兜底 → 无论如何都不绑
  assert.equal(useCurrentWindowMode(false, 0), false);
});

test("快照路径按环境目录隔离（多环境不互相覆盖）", () => {
  // 隔离来自 userDataDir 本身（每个环境一个 profile-{id} 目录），不再多套一层 env-{id}
  const a = chatSnapshotPath("C:/data/browser-profiles/profile-1", "1");
  const b = chatSnapshotPath("C:/data/browser-profiles/profile-2", "2");
  assert.notEqual(a, b);
  assert.ok(a && a.endsWith("state.json"));

  // 同一环境重复调用必须稳定（否则看门狗会读到空快照）
  assert.equal(a, chatSnapshotPath("C:/data/browser-profiles/profile-1", "1"));
  assert.ok(a.includes("chat_context"));

  // 没有 userDataDir → **null**（不是相对路径）：相对路径相对的是 Sidecar 启动目录，
  // 既不是任何真实位置，也会被下一个「也无 userDataDir」的环境共用 → 读到别人的状态（§0.5.3 H）。
  assert.equal(chatSnapshotPath(null, "env-3"), null);
  assert.equal(chatSnapshotPath("", ""), null);
});
