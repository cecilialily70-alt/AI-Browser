/**
 * 长按验证码松手判定 — 离线回归
 *
 * 锁住：进度必须在本次按住中涨满；仍提示按住则继续；不到 3 秒不因「看起来满了」松手；
 * 按住前不点按、按住期间不移动指针；按住中途框架消失不当通过。
 *
 * 运行：npm run build && node --test tests/press-hold-captcha.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOLD_COMPLETE_GRACE_MS,
  HOLD_MAX_MS,
  HOLD_MIN_MS,
  decideHoldRelease,
  instructionStillAsksHold,
  noteProgressSample,
} from "../dist/bu_agent/press_hold_captcha.js";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SIDECAR_ROOT, "..");

function readSrc(rel) {
  return readFileSync(join(SIDECAR_ROOT, rel), "utf8");
}

function holdBody() {
  const src = readSrc("src/bu_agent/press_hold_captcha.ts");
  const start = src.indexOf("async function holdButton");
  const end = src.indexOf("async function clickPoint");
  assert.ok(start >= 0 && end > start, "holdButton / clickPoint 边界");
  return src.slice(start, end);
}

test("按钮自己的「按住」标签去掉一次后，不再当成仍在要求", () => {
  assert.equal(instructionStillAsksHold("Press and hold", "Press and hold"), false);
  assert.equal(instructionStillAsksHold("按住", "按住"), false);
  assert.equal(
    instructionStillAsksHold("Press and hold the button. Press and hold", "Press and hold"),
    true,
  );
  assert.equal(instructionStillAsksHold("请按住按钮", "验证"), true);
  assert.equal(instructionStillAsksHold("hello", "Press and hold"), false);
});

test("一开始就满的进度不算本次涨满；先不满再满才算", () => {
  let state = { minRatio: null, filledDuringHold: false };
  state = noteProgressSample(state, 1);
  assert.equal(state.filledDuringHold, false);
  state = noteProgressSample(state, 1);
  assert.equal(state.filledDuringHold, false);

  state = { minRatio: null, filledDuringHold: false };
  state = noteProgressSample(state, 0.1);
  assert.equal(state.filledDuringHold, false);
  state = noteProgressSample(state, 0.96);
  assert.equal(state.filledDuringHold, true);

  state = { minRatio: null, filledDuringHold: false };
  state = noteProgressSample(state, 1);
  state = noteProgressSample(state, 0.2);
  state = noteProgressSample(state, 0.96);
  assert.equal(state.filledDuringHold, true);
  assert.ok(state.minRatio != null && state.minRatio < 0.95);
});

test("松手：成功失败可立即松；不到下限、仍提示按住、装饰条满了，都不松", () => {
  assert.equal(
    decideHoldRelease({
      elapsedMs: 100,
      signal: "success",
      filledDuringHold: false,
      progressStableMs: 0,
      hasProgress: false,
      minRatio: null,
    }),
    "success",
  );
  assert.equal(
    decideHoldRelease({
      elapsedMs: 100,
      signal: "fail",
      filledDuringHold: false,
      progressStableMs: 0,
      hasProgress: false,
      minRatio: null,
    }),
    "fail",
  );
  assert.equal(
    decideHoldRelease({
      elapsedMs: HOLD_MIN_MS - 1,
      signal: "unknown",
      filledDuringHold: true,
      progressStableMs: HOLD_COMPLETE_GRACE_MS,
      hasProgress: true,
      minRatio: 0.2,
    }),
    "keep",
  );
  assert.equal(
    decideHoldRelease({
      elapsedMs: HOLD_MIN_MS,
      signal: "holding",
      filledDuringHold: true,
      progressStableMs: HOLD_COMPLETE_GRACE_MS,
      hasProgress: true,
      minRatio: 0.2,
    }),
    "keep",
  );
  assert.equal(
    decideHoldRelease({
      elapsedMs: HOLD_MIN_MS,
      signal: "unknown",
      filledDuringHold: true,
      progressStableMs: HOLD_COMPLETE_GRACE_MS - 1,
      hasProgress: true,
      minRatio: 0.2,
    }),
    "keep",
  );
  assert.equal(
    decideHoldRelease({
      elapsedMs: HOLD_MIN_MS,
      signal: "unknown",
      filledDuringHold: true,
      progressStableMs: HOLD_COMPLETE_GRACE_MS,
      hasProgress: true,
      minRatio: 0.2,
    }),
    "progress_complete",
  );
});

test("松手：没有进度变化才提前收手；进度还在涨或控件带进度则继续；到上限必松", () => {
  assert.equal(
    decideHoldRelease({
      elapsedMs: HOLD_MIN_MS,
      signal: "unknown",
      filledDuringHold: false,
      progressStableMs: 0,
      hasProgress: false,
      minRatio: null,
    }),
    "no_hold_feedback",
  );
  assert.equal(
    decideHoldRelease({
      elapsedMs: HOLD_MIN_MS,
      signal: "unknown",
      filledDuringHold: false,
      progressStableMs: 0,
      hasProgress: true,
      minRatio: null,
    }),
    "keep",
  );
  assert.equal(
    decideHoldRelease({
      elapsedMs: HOLD_MIN_MS,
      signal: "unknown",
      filledDuringHold: false,
      progressStableMs: 0,
      hasProgress: false,
      minRatio: 0.4,
    }),
    "keep",
  );
  assert.equal(
    decideHoldRelease({
      elapsedMs: HOLD_MAX_MS,
      signal: "holding",
      filledDuringHold: false,
      progressStableMs: 0,
      hasProgress: true,
      minRatio: 0.4,
    }),
    "max_hold",
  );
});

test("源码级：按住前不点按，按下期间不再移动指针", () => {
  const body = holdBody();
  const moves = body.match(/page\.mouse\.move\(/g) || [];
  const downs = body.match(/page\.mouse\.down\(/g) || [];
  const ups = body.match(/page\.mouse\.up\(/g) || [];
  assert.equal(moves.length, 1);
  assert.equal(downs.length, 1);
  assert.equal(ups.length, 1);
  assert.ok(body.indexOf("page.mouse.move") < body.indexOf("page.mouse.down"));
  assert.equal(body.includes("page.mouse.move", body.indexOf("page.mouse.down")), false);
  assert.ok(!body.includes("dismissed"), "按住循环不得把框架消失当通过");
});

test("源码级：定位走开放 shadow，验收认得长按宿主，进度选择器不含裸 bar/fill", () => {
  const src = readSrc("src/bu_agent/press_hold_captcha.ts");
  assert.ok(src.includes("shadowRoot"), "探测须走开放 shadow");
  assert.ok(src.includes("#px-captcha"), "验收须认得长按宿主容器");
  const progressFns = src.slice(src.indexOf("function probeProgressRatio"), src.indexOf("async function readProgressRatio"));
  assert.ok(!progressFns.includes('class*="bar"') && !progressFns.includes('class*="fill"'));
  const rules = readFileSync(join(REPO_ROOT, ".cursorrules"), "utf8");
  assert.ok(rules.includes("本次按住过程中"), "宪法写明进度必须在本次按住中涨满");
});
