/**
 * 聊天模式回归测试（§11 去重 / §10 回访节奏）
 *
 * 这两块直接对应最初的故障现象与用户点名要求：
 *   - 「只会重复给每个人发同一句话」→ 去重必须**机器硬拦**，不能只靠提示词
 *   - 「回访不能太频繁」→ 到期/上限/冷却/静默时段/无新角度都必须拦住
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEDUPE_DEFAULT_THRESHOLD,
  MAX_DEDUPE_ATTEMPTS,
  checkDuplicate,
  collectSentTexts,
  normalizeForDedupe,
  shouldGiveUpDraft,
} from "../dist/core/web_chat/dedupe.js";
import {
  DEFAULT_CADENCE,
  LIVE_REPLY_COOL_LADDER_MINUTES,
  LIVE_REPLY_HOT_MINUTES,
  LIVE_REPLY_HOT_STEP_MS,
  LIVE_REPLY_MIN_GAP_MS,
  LIVE_REPLY_RECHECK_MINUTES,
  LIVE_REPLY_WINDOW_MINUTES,
  PENDING_REPLY_LADDER_SECONDS,
  computeNextDueAt,
  followUpSkipLabel,
  intervalHoursFor,
  isColdOpening,
  isWithinQuietHours,
  jitterFactor,
  liveReplyRecheckAt,
  nextQuietEnd,
  nextRoundDueAt,
  planFollowUp,
  repliedSinceLastContact,
  shouldRevive,
} from "../dist/core/web_chat/cadence.js";

const T0 = "2026-09-26T10:00:00.000Z";

function followUpState(overrides = {}) {
  return {
    followUpIndex: 0,
    nextDueAt: T0,
    lastContactAt: null,
    lastReplyAt: null,
    stopped: false,
    ...overrides,
  };
}

/* ————————————————————————— 去重：复读必须被拦 ————————————————————————— */

test("归一化：数字折叠成 #，标点/空白/emoji 不影响判定", () => {
  assert.equal(normalizeForDedupe("价格 100 元！"), normalizeForDedupe("价格200元"));
  assert.equal(normalizeForDedupe("你好😊，在吗？"), normalizeForDedupe("你好 在吗"));
  assert.notEqual(normalizeForDedupe("价格 100 元"), normalizeForDedupe("尺寸 100 厘米"));
});

test("原句照发 → 必被拦（这是最初的故障现象）", () => {
  const sent = "您好，我们是专业代运营，可以帮您提升店铺销量，方便聊聊吗？";
  const decision = checkDuplicate(sent, { thread: [sent], cross: [] });
  assert.equal(decision.duplicate, true);
  assert.ok(decision.matched === sent);
  assert.ok(decision.rewriteHint.includes("你已说过"));
  assert.ok(decision.rewriteHint.includes("换一个"));
});

test("换个数字/标点复述 → 仍被拦（不算新话术）", () => {
  const sent = "这款苹果18手机现在只要5999元，性价比很高";
  const draft = "这款苹果18手机现在只要6999元！性价比很高";
  const decision = checkDuplicate(draft, { thread: [sent], cross: [] });
  assert.equal(decision.duplicate, true);
  assert.ok(decision.similarity >= DEDUPE_DEFAULT_THRESHOLD);
});

test("开头 8 字完全相同 → 拦（即使后半句改了）", () => {
  const sent = "您好我们是专业代运营团队，帮您提升销量";
  const draft = "您好我们是专业代运营团队，请问您有兴趣了解一下吗";
  const decision = checkDuplicate(draft, { thread: [sent], cross: [] });
  assert.equal(decision.duplicate, true);
  assert.equal(decision.reason, "prefix_match");
});

test("换角度、带新信息 → 放行", () => {
  const sent = "您好，我们是专业代运营，可以帮您提升店铺销量，方便聊聊吗？";
  const draft = "看到您家主营母婴类目，最近平台在推母婴新客补贴，我们有对应的投放模板，要不要发给您参考？";
  const decision = checkDuplicate(draft, { thread: [sent], cross: [] });
  assert.equal(decision.duplicate, false);
  assert.ok(decision.similarity < DEDUPE_DEFAULT_THRESHOLD);
});

test("跨线程也拦：同一段话术不能群发给所有人", () => {
  const sent = "您好，我们是专业代运营，可以帮您提升店铺销量，方便聊聊吗？";
  const decision = checkDuplicate(sent, { thread: [], cross: [sent] });
  assert.equal(decision.duplicate, true);
});

test("空草稿 → 拦，并给出明确原因（不当成正常消息发出去）", () => {
  const decision = checkDuplicate("   \n  ", { thread: [], cross: [] });
  assert.equal(decision.duplicate, true);
  assert.equal(decision.reason, "empty");
  assert.ok(decision.rewriteHint.includes("草稿为空"));
});

test("短句不同内容不误伤（开头 8 字规则只在双方都够长时生效）", () => {
  const decision = checkDuplicate("在吗", { thread: ["你好"], cross: [] });
  assert.equal(decision.duplicate, false);
});

test("阈值可配：同一段草稿在收紧阈值后从放行变为拦下", () => {
  const sent = "这款手机的屏幕很大，拍照效果也不错，续航也强";
  const draft = "手机的屏幕很大，拍照效果也不错，但续航一般";
  const loose = checkDuplicate(draft, { thread: [sent], cross: [] }, { threshold: 0.99 });
  assert.equal(loose.duplicate, false);
  const strict = checkDuplicate(draft, { thread: [sent], cross: [] }, { threshold: 0.5 });
  assert.equal(strict.duplicate, true);
  assert.equal(strict.reason, "similar");
});

test("开头 8 字规则优先于阈值：改阈值也拦得住「同开头换后半句」", () => {
  const sent = "我们提供代运营服务，可以帮您提升销量";
  const draft = "我们提供代运营服务，另外还能代做客服";
  const veryLoose = checkDuplicate(draft, { thread: [sent], cross: [] }, { threshold: 0.99 });
  assert.equal(veryLoose.duplicate, true);
  assert.equal(veryLoose.reason, "prefix_match");
});

test("连续被拒达上限 → 放弃本轮（绝不硬发）", () => {
  assert.equal(shouldGiveUpDraft(0), false);
  assert.equal(shouldGiveUpDraft(MAX_DEDUPE_ATTEMPTS - 1), false);
  assert.equal(shouldGiveUpDraft(MAX_DEDUPE_ATTEMPTS), true);
  assert.equal(shouldGiveUpDraft(1, 1), true);
});

test("比较集只取我方已发文本（对方的话不参与，避免正常回应被误判）", () => {
  const messages = [
    { direction: "in", text: "你们是做什么的？" },
    { direction: "out", text: "我们做代运营" },
    { direction: "in", text: "好的" },
    { direction: "out", text: "方便聊聊吗" },
  ];
  assert.deepEqual(collectSentTexts(messages, 10), ["我们做代运营", "方便聊聊吗"]);
  assert.deepEqual(collectSentTexts(messages, 1), ["方便聊聊吗"]);
});

/* ————————————————————————— 回访节奏 ————————————————————————— */

test("间隔序列：首次 48h，之后 4 天 / 7 天，用尽后停在最后一个档位", () => {
  assert.equal(intervalHoursFor(0), 48);
  assert.equal(intervalHoursFor(1), 96);
  assert.equal(intervalHoursFor(2), 168);
  assert.equal(intervalHoursFor(3), 168);
  assert.equal(intervalHoursFor(99), 168);
});

test("抖动是确定性的：同线程同序号永远同一值，且落在 ±ratio 内", () => {
  const a = jitterFactor("thread-a", 1, 0.1);
  const b = jitterFactor("thread-a", 1, 0.1);
  assert.equal(a, b);
  assert.ok(a >= 0.9 && a <= 1.1);
  // 不同线程会散开（避免多环境同刻齐发）
  const factors = new Set(["t1", "t2", "t3", "t4", "t5"].map((k) => jitterFactor(k, 1, 0.1)));
  assert.ok(factors.size > 1);
  assert.equal(jitterFactor("thread-a", 1, 0), 1);
});

test("computeNextDueAt 落在合理区间（48h ± 10%）", () => {
  const due = new Date(computeNextDueAt("thread-a", 0, DEFAULT_CADENCE, T0)).getTime();
  const hours = (due - new Date(T0).getTime()) / 3600000;
  assert.ok(hours >= 43.2 && hours <= 52.8, `实际 ${hours}`);
});

test("到期 + 有新角度 → 才发；这是唯一会产生发送的路径", () => {
  // 默认节奏里回访产品已关闭；这里显式打开，才测「到期就发」这条纯函数路径
  const enabled = {
    ...DEFAULT_CADENCE,
    followUpEnabled: true,
    maxFollowUps: 4,
    maxPerDay: 20,
    quietHours: null,
  };
  const plan = planFollowUp(followUpState(), enabled, T0, {
    newAngleAvailable: true,
    sentToday: 0,
  });
  assert.deepEqual(plan, { action: "send", reason: "due", intervalHours: 48 });
});

test("未到期不发", () => {
  const enabled = {
    ...DEFAULT_CADENCE,
    followUpEnabled: true,
    maxFollowUps: 4,
    quietHours: null,
  };
  const state = followUpState({ nextDueAt: "2026-09-27T10:00:00.000Z" });
  assert.deepEqual(planFollowUp(state, enabled, T0, { newAngleAvailable: true, sentToday: 0 }), {
    action: "skip",
    reason: "not_due",
  });
});

test("对方回过话 → 永不回访（任何回复即停）", () => {
  const enabled = {
    ...DEFAULT_CADENCE,
    followUpEnabled: true,
    maxFollowUps: 4,
    quietHours: null,
  };
  assert.equal(repliedSinceLastContact(followUpState({ lastContactAt: T0, lastReplyAt: T0 })), false);
  assert.equal(
    repliedSinceLastContact(followUpState({ lastContactAt: T0, lastReplyAt: "2026-09-26T12:00:00.000Z" })),
    true,
  );
  assert.deepEqual(
    planFollowUp(followUpState({ lastContactAt: T0, lastReplyAt: "2026-09-26T12:00:00.000Z" }), enabled, T0, {
      newAngleAvailable: true,
      sentToday: 0,
    }),
    { action: "skip", reason: "replied" },
  );
});

test("已停止 / 未启用 / 轮次用尽 → 各自如实给原因", () => {
  const enabled = {
    ...DEFAULT_CADENCE,
    followUpEnabled: true,
    maxFollowUps: 4,
    quietHours: null,
  };
  assert.deepEqual(planFollowUp(followUpState({ stopped: true }), enabled, T0, {
    newAngleAvailable: true,
    sentToday: 0,
  }), { action: "skip", reason: "stopped" });
  assert.deepEqual(
    planFollowUp(followUpState(), { ...enabled, followUpEnabled: false }, T0, {
      newAngleAvailable: true,
      sentToday: 0,
    }),
    { action: "skip", reason: "disabled" },
  );
  assert.deepEqual(
    planFollowUp(followUpState({ followUpIndex: enabled.maxFollowUps }), enabled, T0, {
      newAngleAvailable: true,
      sentToday: 0,
    }),
    { action: "skip", reason: "round_exhausted" },
  );
});

test("没有新角度 → 本轮不发（禁止「在吗」式空访）", () => {
  const enabled = {
    ...DEFAULT_CADENCE,
    followUpEnabled: true,
    maxFollowUps: 4,
    quietHours: null,
  };
  assert.deepEqual(planFollowUp(followUpState(), enabled, T0, { newAngleAvailable: false, sentToday: 0 }), {
    action: "skip",
    reason: "no_new_angle",
  });
});

test("已达当日上限 → 不发", () => {
  const capped = {
    ...DEFAULT_CADENCE,
    followUpEnabled: true,
    maxFollowUps: 4,
    maxPerDay: 5,
    quietHours: null,
  };
  assert.deepEqual(
    planFollowUp(followUpState(), capped, T0, { newAngleAvailable: true, sentToday: capped.maxPerDay }),
    { action: "skip", reason: "daily_cap" },
  );
});

test("静默时段不发（显式配置 22:00–08:00，支持跨零点；默认 quietHours=null 不拦）", () => {
  const quiet = { start: "22:00", end: "08:00" };
  const night = "2026-09-26T23:30:00";
  const morning = "2026-09-26T07:30:00";
  const noon = "2026-09-26T12:00:00";
  assert.equal(isWithinQuietHours(night, quiet), true);
  assert.equal(isWithinQuietHours(morning, quiet), true);
  assert.equal(isWithinQuietHours(noon, quiet), false);
  assert.equal(isWithinQuietHours(noon, null), false);
  assert.equal(isWithinQuietHours(noon, { start: "12:00", end: "12:00" }), false);
  // 默认不设静默 → 夜里也不拦
  assert.equal(isWithinQuietHours(night, DEFAULT_CADENCE.quietHours), false);

  const enabled = {
    ...DEFAULT_CADENCE,
    followUpEnabled: true,
    maxFollowUps: 4,
    quietHours: quiet,
  };
  const dueState = followUpState({ nextDueAt: new Date(night).toISOString() });
  assert.deepEqual(
    planFollowUp(dueState, enabled, night, { newAngleAvailable: true, sentToday: 0 }),
    { action: "skip", reason: "quiet_hours" },
  );
});

test("静默时段能被推迟到天亮（调度器据此设 nextWakeAt）", () => {
  const quiet = { start: "22:00", end: "08:00" };
  const night = new Date("2026-09-26T23:30:00");
  const end = nextQuietEnd(night.toISOString(), quiet);
  assert.ok(end);
  const endDate = new Date(end);
  assert.equal(endDate.getHours(), 8);
  assert.equal(endDate.getMinutes(), 0);
  assert.ok(endDate.getTime() > night.getTime());
  // 不在静默时段就不需要推迟；默认 null 也不推
  assert.equal(nextQuietEnd(new Date("2026-09-26T12:00:00").toISOString(), quiet), null);
  assert.equal(nextQuietEnd(night.toISOString(), null), null);
});

test("一轮结束后的冷却与长期静默重启门槛", () => {
  const roundDue = new Date(nextRoundDueAt(DEFAULT_CADENCE, T0)).getTime();
  const days = (roundDue - new Date(T0).getTime()) / 86400000;
  assert.equal(Math.round(days), DEFAULT_CADENCE.followUpCoolDownDays);

  assert.equal(shouldRevive(T0, DEFAULT_CADENCE, "2026-10-01T10:00:00.000Z"), false);
  assert.equal(shouldRevive(T0, DEFAULT_CADENCE, "2027-01-01T10:00:00.000Z"), true);
  assert.equal(shouldRevive(null, DEFAULT_CADENCE, "2027-01-01T10:00:00.000Z"), false);
});

test("默认 maxFollowUps=0 → 永不回访（0 >= 0 直接判轮次用尽，不是无限追）", () => {
  // 即便显式打开回访开关，默认额度仍是 0 → 立刻 round_exhausted
  const zero = { ...DEFAULT_CADENCE, followUpEnabled: true, maxFollowUps: 0, quietHours: null };
  assert.deepEqual(planFollowUp(followUpState(), zero, T0, { newAngleAvailable: true, sentToday: 0 }), {
    action: "skip",
    reason: "round_exhausted",
  });
});

test("所有跳过原因都有中文说明（视图与日志不各写一套）", () => {
  for (const reason of [
    "disabled",
    "chat_off",
    "contact_off",
    "stopped",
    "replied",
    "not_due",
    "round_exhausted",
    "no_new_angle",
    "daily_cap",
    "quiet_hours",
  ]) {
    assert.ok(followUpSkipLabel(reason).length > 0);
  }
  assert.equal(followUpSkipLabel("no_new_angle"), "没有新角度，本轮不发");
});

/* —————— 「首次开场」与「回访」是两回事（§0.5.3 H：选了人却永远不说话的真坑） —————— */

test("isColdOpening 只认「从没主动发过话」，且与 nextDueAt 无关", () => {
  // 从没发过话：不管 nextDueAt 是空、是过去、还是未来，都算「首次开场」
  assert.equal(isColdOpening(followUpState({ lastContactAt: null })), true);
  assert.equal(isColdOpening(followUpState({ lastContactAt: null, nextDueAt: T0 })), true);
  assert.equal(
    isColdOpening(followUpState({ lastContactAt: null, nextDueAt: "2026-10-31T00:00:00.000Z" })),
    true,
  );
  // 已经发过话（有耐久事实）或已经耗掉一次主动发话记录 → 不是开场
  assert.equal(isColdOpening(followUpState({ lastContactAt: T0 })), false);
  assert.equal(isColdOpening(followUpState({ followUpIndex: 1 })), false);
});

test("关掉「定时回访」不影响开场判定（开场走的是另一条路）", () => {
  // `planFollowUp` 说「不追」是它对**追**的判定；开场由引擎用 isColdOpening 单独放行。
  // 这里锁住「两者语义不同」这一条，防止以后又把它们并回一条通道。
  const cold = followUpState({ lastContactAt: null });
  assert.equal(isColdOpening(cold), true);
  assert.deepEqual(
    planFollowUp(cold, { ...DEFAULT_CADENCE, followUpEnabled: false }, T0, {
      newAngleAvailable: true,
      sentToday: 0,
      contactFollowUpOff: true,
    }),
    { action: "skip", reason: "disabled" },
  );
});

test("每联系人关掉回访 → 追的时候如实说 contact_off（原因不静默）", () => {
  const enabled = {
    ...DEFAULT_CADENCE,
    followUpEnabled: true,
    maxFollowUps: 4,
    quietHours: null,
  };
  assert.deepEqual(
    planFollowUp(followUpState({ lastContactAt: T0, nextDueAt: T0 }), enabled, T0, {
      newAngleAvailable: true,
      sentToday: 0,
      contactFollowUpOff: true,
    }),
    { action: "skip", reason: "contact_off" },
  );
  assert.match(followUpSkipLabel("contact_off"), /不主动追/);
  assert.match(followUpSkipLabel("chat_off"), /自动聊天/);
});

/* ————————————————————————— 短复查：热窗口固定节拍 + 冷阶段递增阶梯（§0.5.3 H） ————————————————————————— */

test("热窗口内固定 5 秒节拍：对方秒回也接得上，且绝不给过去的时刻", () => {
  const last = new Date(T0).getTime();
  assert.equal(LIVE_REPLY_HOT_STEP_MS, 5_000);
  assert.ok(LIVE_REPLY_HOT_STEP_MS <= 60_000, "热窗口节奏必须比宿主调度节拍还短才有意义");
  assert.ok(LIVE_REPLY_HOT_MINUTES >= 10, "热窗口至少覆盖片内来回");

  // 已过去 0 / 2 秒 → 都排到 +5 秒刻度上（锚在 lastContactAt，确定性）
  for (const seconds of [0, 2]) {
    const nowIso = new Date(last + seconds * 1000).toISOString();
    const at = liveReplyRecheckAt({ nowIso, lastContactAt: T0, lastReplyAt: null });
    assert.equal(new Date(at).getTime(), last + LIVE_REPLY_HOT_STEP_MS, `第 ${seconds} 秒应排到 +5 秒刻度`);
  }
  for (const seconds of [0, 2, 4, 7]) {
    const nowMs = last + seconds * 1000;
    const at = liveReplyRecheckAt({
      nowIso: new Date(nowMs).toISOString(),
      lastContactAt: T0,
      lastReplyAt: null,
    });
    const gap = new Date(at).getTime() - nowMs;
    assert.ok(gap > 0, "必须排在未来（排到过去＝立刻空转一轮）");
    assert.ok(
      gap <= LIVE_REPLY_HOT_STEP_MS + LIVE_REPLY_MIN_GAP_MS,
      `热窗口内最多 ${(LIVE_REPLY_HOT_STEP_MS + LIVE_REPLY_MIN_GAP_MS) / 1000} 秒就该来看一眼（实际 ${gap}ms）`,
    );
  }
  // 已过去 12 秒（片跑久了）→ 补到下一个尚未走到的刻度，绝不给一个过去的时刻
  const at12 = liveReplyRecheckAt({
    nowIso: new Date(last + 12_000).toISOString(),
    lastContactAt: T0,
    lastReplyAt: null,
  });
  const at12ms = new Date(at12).getTime();
  assert.equal(at12ms, last + 15_000);
  assert.ok(at12ms - (last + 12_000) >= LIVE_REPLY_MIN_GAP_MS, "与「现在」至少留一个最小间隔");

  // 热窗口边界仍在热窗口内
  const hotEdge = liveReplyRecheckAt({
    nowIso: new Date(last + (LIVE_REPLY_HOT_MINUTES * 60 - 1) * 1000).toISOString(),
    lastContactAt: T0,
    lastReplyAt: null,
  });
  assert.ok(hotEdge, "热窗口边界内必须继续盯");
});

test("冷阶段用递增阶梯：越等越稀，绝不空转风暴", () => {
  const last = new Date(T0).getTime();
  const ladder = [...LIVE_REPLY_COOL_LADDER_MINUTES];
  assert.deepEqual(ladder, [1, 2, 5, 10, 15]);
  // 阶梯严格递增（不让复查越来越密，那是空转风暴）
  for (let i = 1; i < ladder.length; i += 1) assert.ok(ladder[i] > ladder[i - 1]);
  assert.equal(LIVE_REPLY_RECHECK_MINUTES, ladder[ladder.length - 1]);

  // 热窗口关掉后，冷阶梯从 lastContactAt 起算
  const samples = [
    { minutes: 0.5, expectedRung: 1 },
    { minutes: 1.5, expectedRung: 2 },
    { minutes: 3, expectedRung: 5 },
    { minutes: 7, expectedRung: 10 },
    { minutes: 12, expectedRung: 15 },
  ];
  for (const { minutes, expectedRung } of samples) {
    const nowIso = new Date(last + minutes * 60_000).toISOString();
    const at = liveReplyRecheckAt({
      nowIso,
      lastContactAt: T0,
      lastReplyAt: null,
      hotMinutes: 0,
    });
    assert.ok(at, `第 ${minutes} 分钟应仍在窗口内`);
    assert.equal(
      new Date(at).getTime(),
      last + expectedRung * 60_000,
      `第 ${minutes} 分钟应排到第 ${expectedRung} 分钟档`,
    );
  }
});

test("冷阶段阶梯走完后按末档重复，且绝不越过 24 小时窗口", () => {
  const last = new Date(T0).getTime();
  assert.equal(LIVE_REPLY_WINDOW_MINUTES, 1440);
  const windowEnd = last + LIVE_REPLY_WINDOW_MINUTES * 60_000;
  const tail = LIVE_REPLY_RECHECK_MINUTES;

  // 已过去远超末档 → 下一次是「现在 + 末档」，而不是立刻或永远不来
  const nowPast = last + (tail + 5) * 60_000;
  const at = liveReplyRecheckAt({
    nowIso: new Date(nowPast).toISOString(),
    lastContactAt: T0,
    lastReplyAt: null,
    hotMinutes: 0,
  });
  assert.equal(new Date(at).getTime(), nowPast + tail * 60_000);
  assert.ok(new Date(at).getTime() <= windowEnd);

  // 靠近窗口末端：末档会被窗口末端夹住（绝不排到窗口之后去空转）
  const nearEnd = new Date(windowEnd - 10 * 60_000).toISOString();
  const at2 = liveReplyRecheckAt({
    nowIso: nearEnd,
    lastContactAt: T0,
    lastReplyAt: null,
    hotMinutes: 0,
  });
  assert.equal(new Date(at2).getTime(), windowEnd);
});

test("对方刚回话、我方还没接上 → 短阶梯追上去（绝不掉到 48 小时后的回访）", () => {
  const last = new Date(T0).getTime();
  const ladder = [...PENDING_REPLY_LADDER_SECONDS];
  assert.deepEqual(ladder, [15, 30, 60, 120, 300]);

  // 对方在我方发出后 40 秒回话
  const replyAt = new Date(last + 40_000).toISOString();
  // 片末结算时「现在」= 发出后 42 秒 → 下一个刻度 = 对方回话时间 + 15 秒
  const at = liveReplyRecheckAt({
    nowIso: new Date(last + 42_000).toISOString(),
    lastContactAt: T0,
    lastReplyAt: replyAt,
  });
  assert.equal(new Date(at).getTime(), last + 40_000 + 15_000);
  assert.ok(new Date(at).getTime() > last + 42_000, "必须排在未来（否则立刻空转）");

  // 追了 6 分钟还接不上 → 落到冷阶段阶梯，绝不返回 null
  const late = liveReplyRecheckAt({
    nowIso: new Date(last + 40_000 + 6 * 60_000).toISOString(),
    lastContactAt: T0,
    lastReplyAt: replyAt,
  });
  assert.ok(late, "追不上也必须继续盯（不许把对方那句丢到 48 小时后）");
  const lateMs = new Date(late).getTime();
  assert.ok(lateMs > last + 40_000 + 6 * 60_000, "必须排在未来");
  assert.ok(lateMs <= last + LIVE_REPLY_WINDOW_MINUTES * 60_000, "仍受窗口约束");
});

test("窗口之外 / 对方已回话且已接上 / 没有发出过 → 不再复查", () => {
  const last = new Date(T0).getTime();
  const beyond = new Date(last + (LIVE_REPLY_WINDOW_MINUTES + 1) * 60_000).toISOString();
  assert.equal(liveReplyRecheckAt({ nowIso: beyond, lastContactAt: T0, lastReplyAt: null }), null);
  // 对方回过话、我方又接上了（lastContactAt 更新到更晚）→ 走热窗口节拍，不再是「对方在等我」
  const at = liveReplyRecheckAt({
    nowIso: new Date(last + 2_000).toISOString(),
    lastContactAt: T0,
    lastReplyAt: new Date(last - 60_000).toISOString(),
  });
  assert.equal(new Date(at).getTime(), last + LIVE_REPLY_HOT_STEP_MS, "对方早先回过、我方已接上 → 按热窗口节拍");
  // 我方还没发过 → 没什么可等的
  assert.equal(liveReplyRecheckAt({ nowIso: T0, lastContactAt: null, lastReplyAt: null }), null);
  // 窗口已用尽（最后一条复查恰好落在窗口末端之后）
  assert.equal(
    liveReplyRecheckAt({
      nowIso: new Date(last + 60_000).toISOString(),
      lastContactAt: T0,
      lastReplyAt: null,
      windowMinutes: 0.5,
    }),
    null,
  );
});
