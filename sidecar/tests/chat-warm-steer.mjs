/**
 * 温热追问（不冷场）：对方沉默时按分钟级节奏轻推
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WARM_STEER,
  computeNextWarmDueAt,
  planWarmSteer,
  warmSteerMinutesFor,
} from "../dist/core/web_chat/cadence.js";

const T0 = "2026-09-26T12:00:00.000Z";
const T_PLUS_4M = "2026-09-26T12:04:00.000Z";

function state(over = {}) {
  return {
    followUpIndex: 0,
    nextDueAt: null,
    lastContactAt: T0,
    lastReplyAt: null,
    stopped: false,
    ...over,
  };
}

test("温热间隔：首追 3 分钟，其后按阶梯", () => {
  assert.equal(warmSteerMinutesFor(0), 3);
  assert.equal(warmSteerMinutesFor(1), 8);
  assert.equal(warmSteerMinutesFor(2), 15);
});

test("对方沉默且已过首追间隔 → 该追问", () => {
  const plan = planWarmSteer(state(), DEFAULT_WARM_STEER, T_PLUS_4M, {
    sentToday: 0,
    maxPerDay: 0,
  });
  assert.equal(plan.action, "send");
  assert.equal(plan.reason, "due");
});

test("未到首追间隔 → 不追", () => {
  const plan = planWarmSteer(state(), DEFAULT_WARM_STEER, "2026-09-26T12:01:00.000Z", {
    sentToday: 0,
    maxPerDay: 0,
  });
  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "not_due");
});

test("对方已回话 → 不空催", () => {
  const plan = planWarmSteer(
    state({ lastReplyAt: "2026-09-26T12:02:00.000Z" }),
    DEFAULT_WARM_STEER,
    T_PLUS_4M,
    { sentToday: 0, maxPerDay: 0 },
  );
  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "replied");
});

test("一轮追问次数用尽 → round_exhausted", () => {
  const plan = planWarmSteer(
    state({ followUpIndex: DEFAULT_WARM_STEER.maxNudges, nextDueAt: T0 }),
    DEFAULT_WARM_STEER,
    T_PLUS_4M,
    { sentToday: 0, maxPerDay: 0 },
  );
  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "round_exhausted");
});

test("联系人关掉主动追问 → contact_off", () => {
  const plan = planWarmSteer(state({ nextDueAt: T0 }), DEFAULT_WARM_STEER, T_PLUS_4M, {
    sentToday: 0,
    maxPerDay: 0,
    contactFollowUpOff: true,
  });
  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "contact_off");
});

test("下次到期带确定性抖动且在未来", () => {
  const due = computeNextWarmDueAt("thread-a", 0, DEFAULT_WARM_STEER, T0);
  const ms = new Date(due).getTime() - new Date(T0).getTime();
  assert.ok(ms >= 2.5 * 60_000 && ms <= 4 * 60_000, `due offset ms=${ms}`);
});
