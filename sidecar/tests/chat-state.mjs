/**
 * 聊天模式回归测试（P2 纯核心：相位状态机 · 耐久快照 · 幂等发件箱）
 *
 * 覆盖（P2 部分，全部可无浏览器验证）：
 *   - 相位转移守卫（合法/非法/紧急出口/终态）
 *   - 看门狗相关性（空闲相位不计时、等 LLM 相位放宽）
 *   - 快照版本不兼容 → 拒绝续跑；损坏 → 明确报错
 *   - 原子写：tmp 不残留、可回读
 *   - `progressCounter` 单调（看门狗判活的唯一权威信号）
 *   - 到期扫描确定性（零 LLM）
 *   - **幂等发送**：sent 不重发 / pending 回读对账 / 只允许一次重试 / unconfirmed 交人工
 *   - `effectId` 跨进程稳定（同轮同文本必同 id，不同轮不同 id）
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  advancePhase,
  bumpProgress,
  createInitialSnapshot,
  dayKeyOf,
  decideResume,
  dueContacts,
  getContact,
  isStoppingStage,
  parseSnapshot,
  readSnapshotFile,
  rollCountersIfNewDay,
  setNextWakeAt,
  upsertContact,
  writeSnapshotAtomic,
  CHAT_STATE_SCHEMA_VERSION,
} from "../dist/core/web_chat/state.js";
import {
  canTransition,
  isIdlePhase,
  isLlmPhase,
  isTerminalPhase,
  isWatchdogRelevant,
  phaseLabel,
} from "../dist/core/web_chat/phases.js";
import {
  beginSend,
  commitSent,
  computeEffectId,
  decideSend,
  findOutboxEntry,
  hashText,
  isEffectVisibleInPage,
  markUnconfirmed,
  normalizeForEffect,
  reconcileOutbox,
  trimOutbox,
  upsertOutbox,
  MAX_SEND_ATTEMPTS,
} from "../dist/core/web_chat/outbox.js";

const T0 = "2026-09-26T10:00:00.000Z";
const T1 = "2026-09-26T11:00:00.000Z";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "chat-state-"));
}

function contactOf(overrides = {}) {
  return {
    key: "c1",
    label: "Alyssa",
    siteKey: "web.telegram.org",
    stage: "engaged",
    followUpIndex: 1,
    nextDueAt: T0,
    lastIncomingHash: null,
    lastSentHash: null,
    stopped: false,
    stopReason: null,
    lease: 0,
    updatedAt: T0,
    ...overrides,
  };
}

/* ————————————————————————— 相位守卫 ————————————————————————— */

test("相位转移：合法路径放行，跳跃被拒", () => {
  assert.equal(canTransition("booting", "scanning"), true);
  assert.equal(canTransition("scanning", "reading"), true);
  assert.equal(canTransition("reading", "deciding"), true);
  assert.equal(canTransition("drafting", "verifying"), true);
  assert.equal(canTransition("sending", "recording"), true);
  assert.equal(canTransition("recording", "yielding"), true);
  // 跳跃：没读就发
  assert.equal(canTransition("booting", "sending"), false);
  assert.equal(canTransition("scanning", "drafting"), false);
  // 同相位幂等重入
  assert.equal(canTransition("waiting", "waiting"), true);
});

test("相位转移：紧急出口与终态", () => {
  assert.equal(canTransition("drafting", "handover"), true);
  assert.equal(canTransition("sending", "stopped"), true);
  assert.equal(canTransition("stopped", "scanning"), false);
  assert.equal(canTransition("stopped", "handover"), false);
  assert.equal(isTerminalPhase("stopped"), true);
});

test("看门狗相关性：空闲相位不计时，等 LLM 相位放宽", () => {
  for (const phase of ["waiting", "paused", "handover"]) {
    assert.equal(isIdlePhase(phase), true);
    assert.equal(isWatchdogRelevant(phase), false);
  }
  assert.equal(isWatchdogRelevant("stopped"), false);
  for (const phase of ["deciding", "drafting"]) assert.equal(isLlmPhase(phase), true);
  assert.equal(isWatchdogRelevant("drafting"), true);
  assert.equal(isWatchdogRelevant("sending"), true);
});

test("每个相位都有中文标签（日志/视图不需要自己拼）", () => {
  assert.equal(phaseLabel("waiting"), "事件等待");
  assert.equal(phaseLabel("drafting"), "生成草稿");
});

test("advancePhase 断言转移合法并单调递增 progressCounter", () => {
  let snapshot = createInitialSnapshot({ envId: "1", profileId: 7, now: T0 });
  assert.equal(snapshot.engine.phase, "booting");
  snapshot = advancePhase(snapshot, "scanning", T0);
  snapshot = advancePhase(snapshot, "reading", T0);
  assert.equal(snapshot.engine.progressCounter, 2);
  assert.throws(() => advancePhase(snapshot, "sending", T0), /chat_phase_transition_illegal/);
});

test("bumpProgress 是唯一的心跳信号（单调递增）", () => {
  let snapshot = createInitialSnapshot({ envId: "1", profileId: null, now: T0 });
  const before = snapshot.engine.progressCounter;
  snapshot = bumpProgress(snapshot, T1);
  snapshot = bumpProgress(snapshot, T1);
  assert.equal(snapshot.engine.progressCounter, before + 2);
  assert.equal(snapshot.engine.phase, "booting");
  assert.equal(snapshot.engine.heartbeatAt, T1);
});

/* ————————————————————————— 快照版本化与原子写 ————————————————————————— */

test("版本不兼容 → 拒绝续跑并给出恢复提示", () => {
  const raw = { ...createInitialSnapshot({ envId: "1", profileId: null, now: T0 }), schemaVersion: 999 };
  const result = parseSnapshot(raw);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "version_mismatch");
  assert.ok(result.detail.includes("清理该环境的聊天上下文"));
});

test("缺少 schemaVersion / 未知相位 / 空 key → 一律拒绝（不做尽力修补）", () => {
  assert.equal(parseSnapshot({ engine: {} }).ok, false);
  const base = createInitialSnapshot({ envId: "1", profileId: null, now: T0 });
  assert.equal(parseSnapshot({ ...base, engine: { ...base.engine, phase: "teleporting" } }).ok, false);
  assert.equal(parseSnapshot({ ...base, contacts: [{ key: "" }] }).ok, false);
  assert.equal(parseSnapshot({ ...base, outbox: [{ effectId: "" }] }).ok, false);
  assert.equal(parseSnapshot({ ...base, outbox: [{ effectId: "x", status: "maybe" }] }).ok, false);
});

test("往返一致：写盘后可原样读回", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "state.json");
    let snapshot = createInitialSnapshot({ envId: "42", profileId: 3, now: T0 });
    snapshot = upsertContact(snapshot, contactOf());
    snapshot = setNextWakeAt(snapshot, T1);
    const write = writeSnapshotAtomic(file, snapshot);
    assert.equal(write.ok, true);

    const read = readSnapshotFile(file);
    assert.equal(read.ok, true);
    assert.equal(read.snapshot.envId, "42");
    assert.equal(read.snapshot.engine.nextWakeAt, T1);
    assert.equal(getContact(read.snapshot, "c1").label, "Alyssa");
    // tmp 不残留（残留的 tmp 说明上次写盘半途而废）
    assert.deepEqual(readdirSync(dir), ["state.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏 JSON 与缺失文件给出不同原因（不互相冒充）", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "state.json");
    assert.equal(readSnapshotFile(file).reason, "missing");
    writeFileSync(file, "{ not json", "utf8");
    assert.equal(readSnapshotFile(file).reason, "corrupt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("续跑校验：快照不属于本环境 → 拒绝续跑（宁可从头，也不把别人的状态套上来）", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "state.json");
    writeSnapshotAtomic(file, createInitialSnapshot({ envId: "2", profileId: 2, now: T0 }));

    const read = readSnapshotFile(file);
    assert.equal(read.ok, true);
    // 环境一致 → 可以续跑（发件箱与计数都会被带回来）
    assert.equal(decideResume(read, { envId: "2", profileId: 2 }).ok, true);

    const mismatch = decideResume(read, { envId: "7", profileId: 7 });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, "env_mismatch");
    assert.ok(mismatch.detail.includes("2") && mismatch.detail.includes("7"));

    // 读不到就照样是「读不到」，不能被续跑校验改写成别的结论
    assert.equal(decideResume(readSnapshotFile(join(dir, "none.json")), { envId: "2", profileId: 2 }).reason, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("原子写会覆盖旧文件（不追加、不留半截）", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "state.json");
    writeSnapshotAtomic(file, createInitialSnapshot({ envId: "1", profileId: null, now: T0 }));
    writeSnapshotAtomic(file, createInitialSnapshot({ envId: "2", profileId: null, now: T1 }));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.envId, "2");
    assert.equal(parsed.schemaVersion, CHAT_STATE_SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ————————————————————————— 到期扫描与计数 ————————————————————————— */

test("到期扫描：确定性排序、跳过已停与 risk 终止阶段", () => {
  let snapshot = createInitialSnapshot({ envId: "1", profileId: null, now: T0 });
  snapshot = upsertContact(snapshot, contactOf({ key: "b", nextDueAt: T0, followUpIndex: 1 }));
  snapshot = upsertContact(snapshot, contactOf({ key: "a", nextDueAt: T0, followUpIndex: 0 }));
  snapshot = upsertContact(snapshot, contactOf({ key: "c", nextDueAt: "2026-09-27T00:00:00.000Z" }));
  snapshot = upsertContact(snapshot, contactOf({ key: "d", stopped: true }));
  // opted_out / rejected / converted 不再停手（R7）；只有 risk 进终止阶段
  snapshot = upsertContact(snapshot, contactOf({ key: "e", stage: "opted_out", nextDueAt: T0, followUpIndex: 2 }));
  snapshot = upsertContact(snapshot, contactOf({ key: "g", stage: "risk", nextDueAt: T0 }));
  snapshot = upsertContact(snapshot, contactOf({ key: "f", nextDueAt: null }));

  const due = dueContacts(snapshot, T1);
  assert.deepEqual(due.map((c) => c.key), ["a", "b", "e"]);
  // 同输入同顺序（可审计、可复现）
  assert.deepEqual(
    dueContacts(snapshot, T1).map((c) => c.key),
    ["a", "b", "e"],
  );
  assert.deepEqual(dueContacts(snapshot, T1, 1).map((c) => c.key), ["a"]);
});

test("终止阶段判定：仅 risk 停手（拒绝/退订/已转化不再永不回访）", () => {
  assert.equal(isStoppingStage("risk"), true);
  for (const stage of ["converted", "rejected", "opted_out", "engaged", "negotiating"]) {
    assert.equal(isStoppingStage(stage), false);
  }
});

test("跨天只归零今日计数，不动累计值", () => {
  let snapshot = createInitialSnapshot({ envId: "1", profileId: null, now: T0 });
  snapshot = { ...snapshot, counters: { ...snapshot.counters, sentToday: 5, sentTotal: 12 } };
  assert.equal(rollCountersIfNewDay(snapshot, T1).counters.sentToday, 5);
  const next = rollCountersIfNewDay(snapshot, "2026-09-27T01:00:00.000Z");
  assert.equal(next.counters.sentToday, 0);
  assert.equal(next.counters.sentTotal, 12);
  assert.equal(dayKeyOf("2026-09-27T01:00:00.000Z"), "2026-09-27");
});

/* ————————————————————————— 幂等发送（最关键） ————————————————————————— */

test("effectId 跨进程稳定：同轮同文本必同 id，不同轮/不同线程必不同", () => {
  const a = computeEffectId("thread-1", 3, "你好，方便聊聊吗？");
  const b = computeEffectId("thread-1", 3, "你好 方便聊聊吗");
  const c = computeEffectId("thread-1", 4, "你好，方便聊聊吗？");
  const d = computeEffectId("thread-2", 3, "你好，方便聊聊吗？");
  assert.equal(a, b, "归一化后应得到同一个幂等键（重试必须复用同一个）");
  assert.notEqual(a, c, "同一文本在新轮次是合法的新发送，应有新 id");
  assert.notEqual(a, d, "不同线程必须不同");
});

test("归一化与指纹：标点/空白/emoji 不影响判定，实质不同则不同", () => {
  assert.equal(normalizeForEffect("你好，在吗？😊"), normalizeForEffect(" 你好 在吗 "));
  assert.equal(hashText("价格 100 元"), hashText("价格100元"));
  assert.notEqual(hashText("价格 100 元"), hashText("价格 200 元"));
});

test("decideSend：sent 绝不重发", () => {
  const entry = commitSent(
    beginSend("e1", "thread-1", "你好", T0),
    T0,
  );
  assert.deepEqual(decideSend(entry, { seenInPage: false }), { action: "skip", reason: "already_sent" });
  assert.deepEqual(decideSend(entry, { seenInPage: true }), { action: "skip", reason: "already_sent" });
});

test("decideSend：崩溃窗口——pending 且页面已存在 → 认定已发出，不重发", () => {
  const entry = beginSend("e1", "thread-1", "你好，方便聊聊吗", T0);
  assert.equal(entry.status, "pending");
  assert.equal(entry.attempts, 1);
  assert.deepEqual(decideSend(entry, { seenInPage: true }), {
    action: "settle_sent",
    reason: "reconciled_present",
  });
});

test("decideSend：pending 且页面看不到 → 只允许一次重试，之后交人工", () => {
  const first = beginSend("e1", "thread-1", "你好", T0);
  const retry = decideSend(first, { seenInPage: false });
  assert.equal(retry.action, "send");
  assert.equal(retry.reason, "retry");
  assert.equal(retry.attempts, MAX_SEND_ATTEMPTS);

  const second = beginSend("e1", "thread-1", "你好", T1, first);
  assert.equal(second.attempts, MAX_SEND_ATTEMPTS);
  assert.deepEqual(decideSend(second, { seenInPage: false }), {
    action: "hand_off",
    reason: "retry_exhausted",
  });
});

test("decideSend：unconfirmed 绝不自动重发（歧义即停）", () => {
  const entry = markUnconfirmed(beginSend("e1", "thread-1", "你好", T0), T1, "页面未见");
  assert.deepEqual(decideSend(entry, { seenInPage: false }), { action: "hand_off", reason: "unconfirmed" });
  // 即便页面后来出现了，也只当「已发出」，不重发
  assert.deepEqual(decideSend(entry, { seenInPage: true }), { action: "hand_off", reason: "unconfirmed" });
});

test("decideSend：全新消息走 send/new", () => {
  assert.deepEqual(decideSend(null, { seenInPage: false }), { action: "send", reason: "new", attempts: 1 });
});

test("beginSend 保留首次创建时间，重试只更新 lastAttemptAt", () => {
  const first = beginSend("e1", "thread-1", "你好", T0);
  const second = beginSend("e1", "thread-1", "你好", T1, first);
  assert.equal(second.createdAt, T0);
  assert.equal(second.lastAttemptAt, T1);
  assert.equal(second.status, "pending");
  assert.equal(second.sentAt, null);
});

test("upsertOutbox 同 id 只保留一条；findOutboxEntry 命中", () => {
  let outbox = [];
  outbox = upsertOutbox(outbox, beginSend("e1", "t", "A", T0));
  outbox = upsertOutbox(outbox, beginSend("e2", "t", "B", T0));
  outbox = upsertOutbox(outbox, commitSent(beginSend("e1", "t", "A", T0), T1));
  assert.equal(outbox.length, 2);
  assert.equal(findOutboxEntry(outbox, "e1").status, "sent");
  assert.equal(findOutboxEntry(outbox, "nope"), null);
});

test("trimOutbox 只保留最近 N 条", () => {
  const entries = Array.from({ length: 5 }, (_, i) => beginSend(`e${i}`, "t", `m${i}`, T0));
  assert.deepEqual(trimOutbox(entries, 2).map((e) => e.effectId), ["e3", "e4"]);
  assert.equal(trimOutbox(entries, 99).length, 5);
});

test("页面回读对账：归一化后精确匹配才算「已发出」", () => {
  const entry = beginSend("e1", "t", "你好，方便聊聊吗？", T0);
  assert.equal(isEffectVisibleInPage(entry, ["你好， 方便聊聊吗？", "别的消息"]), true);
  assert.equal(isEffectVisibleInPage(entry, ["你好方便聊聊吗"]), true);
  assert.equal(isEffectVisibleInPage(entry, ["方便的，你说"]), false);
});

test("reconcileOutbox：续跑第一步只对账、不发消息，并把歧义交人工", () => {
  const outbox = [
    commitSent(beginSend("sent1", "t", "早已发出", T0), T0),
    beginSend("pending1", "t", "页面能看到我", T0),
    beginSend("pending2", "t", "页面看不到我", T0),
    markUnconfirmed(beginSend("unc1", "t", "不知道发出去没", T0), T1, "超时"),
  ];
  const result = reconcileOutbox(outbox, ["页面能看到我"], T1);

  assert.deepEqual(result.settled.map((e) => e.effectId), ["pending1"]);
  assert.deepEqual(result.handOff.map((e) => e.effectId), ["unc1"]);
  const byId = Object.fromEntries(result.outbox.map((e) => [e.effectId, e.status]));
  assert.equal(byId.sent1, "sent");
  assert.equal(byId.pending1, "sent", "对账后应落成 sent，避免下次再发");
  assert.equal(byId.pending2, "pending", "仍可走一次重试");
  assert.equal(byId.unc1, "unconfirmed", "不可被改回 pending");
  // 对账是纯函数，不改动入参
  assert.equal(outbox.length, 4);
});
