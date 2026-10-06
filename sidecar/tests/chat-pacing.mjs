/**
 * 聊天模式回归测试（P2：发送节奏护栏 + 人工接管口径）
 *
 * 这两块对应两个最容易「看起来正常、其实错了」的地方：
 *   - 节奏护栏：算错了不会报错，只会**封号**（或者反过来拖到对方以为你不理人）。
 *     所以它必须是纯函数，抖动必须**可复现**，而且**绝不能产生「今天不能再发了」**。
 *   - 人工接管：解析错了不会报错，只会**引擎去和用户抢着说话**（R7）。
 *     所以非法值必须丢弃并回报，绝不静默当成 `engine`。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PACING,
  incomingTextOf,
  pacingJitter,
  parsePacingConfig,
  planSendWait,
  readDelayMs,
} from "../dist/core/web_chat/pacing.js";
import { CHAT_TAKEOVER_MODES } from "../dist/core/web_chat/state.js";
import { parseTakeovers, takeoverKeyOf, takeoverOverrideOf } from "../dist/bu_agent/chat_session.js";

const T0 = 1_700_000_000_000;

/* ————————————————————————— 抖动：确定性，不是随机 ————————————————————————— */

test("抖动是确定性的：同 key 同 salt 永远同一值", () => {
  assert.equal(pacingJitter("thread-a", "send", 0.2), pacingJitter("thread-a", "send", 0.2));
  // 与 §0.5.3 F「随机当唯一」相反：可复现才能测、才能解释「为什么等了 2.3 秒」
  assert.equal(pacingJitter("t", "s", 0), 1);
});

test("抖动落在 ±ratio 内，且不同线程会散开（避免多环境同刻齐发）", () => {
  const values = ["t1", "t2", "t3", "t4", "t5", "t6"].map((key) => pacingJitter(key, "send", 0.2));
  for (const value of values) {
    assert.ok(value >= 0.8 && value <= 1.2, `越界：${value}`);
  }
  assert.ok(new Set(values).size > 1);
  // ratio 超出 [0, 0.5] 会被夹住，而不是放大抖动
  assert.ok(pacingJitter("t1", "send", 9) >= 0.5);
});

/* ————————————————————————— 阅读延迟：按对方字数 ————————————————————————— */

test("阅读延迟按对方字数增长，并在上限封顶", () => {
  assert.equal(readDelayMs(""), DEFAULT_PACING.readDelayPerCharMs); // 无文本按 1 字，不零延迟
  assert.equal(readDelayMs("你好"), 2 * DEFAULT_PACING.readDelayPerCharMs);
  assert.equal(readDelayMs("x".repeat(500)), DEFAULT_PACING.readDelayMaxMs);
  assert.equal(readDelayMs("你好", { ...DEFAULT_PACING, readDelayPerCharMs: 0 }), 0);
  assert.equal(readDelayMs("你好", { ...DEFAULT_PACING, readDelayMaxMs: 0 }), 0);
});

test("阅读延迟按码点算（emoji 不算两字）", () => {
  const text = "😀😀😀"; // 3 个码点、6 个 UTF-16 单元
  assert.equal(readDelayMs(text, { ...DEFAULT_PACING, readDelayPerCharMs: 100, readDelayMaxMs: 10_000 }), 300);
});

test("incomingTextOf 把多条对方消息拼起来（附件空文本由 readDelayMs 兜底）", () => {
  assert.equal(incomingTextOf([{ text: "A" }, { text: "B" }]), "A\nB");
  assert.equal(incomingTextOf([{ text: "" }, { text: "" }]), "\n");
});

/* ————————————————————————— 等待计划：只算「等多久」，绝不否决 ————————————————————————— */

test("没发过 + 无新输入 → 只按 1 字的阅读延迟等（不产生任何「否决」）", () => {
  const onlyReadDelay = planSendWait({
    threadKey: "t",
    now: T0,
    lastSentAt: null,
    incomingText: "",
    config: { ...DEFAULT_PACING, jitterRatio: 0 },
  });
  assert.deepEqual(onlyReadDelay, {
    waitMs: DEFAULT_PACING.readDelayPerCharMs,
    reason: "read_delay",
    baseMs: DEFAULT_PACING.readDelayPerCharMs,
  });
  assert.deepEqual(
    planSendWait({
      threadKey: "t",
      now: T0,
      lastSentAt: null,
      incomingText: "",
      config: { ...DEFAULT_PACING, readDelayPerCharMs: 0 },
    }),
    { waitMs: 0, reason: "none", baseMs: 0 },
  );
});

test("刚发完不久 → 等到最小间隔（取较大者，不是相加）", () => {
  const config = { ...DEFAULT_PACING, readDelayPerCharMs: 0, jitterRatio: 0 };
  const wait = planSendWait({
    threadKey: "t",
    now: T0 + 500,
    lastSentAt: T0,
    incomingText: "随便说点什么",
    config,
  });
  assert.equal(wait.reason, "min_interval");
  assert.equal(wait.baseMs, config.minSendIntervalMs - 500);
  assert.equal(wait.waitMs, config.minSendIntervalMs - 500);
});

test("收到长文但刚发完 → 取较大者：不会把两个延迟相加翻倍", () => {
  const config = { ...DEFAULT_PACING, jitterRatio: 0, minSendIntervalMs: 5_000 };
  const wait = planSendWait({
    threadKey: "t",
    now: T0,
    lastSentAt: T0 - 1_000,
    incomingText: "x".repeat(1_000), // 阅读延迟被 max 封顶 4000
    config,
  });
  assert.equal(wait.baseMs, 4_000); // 不是 4000 + 4000
  assert.equal(wait.reason, "read_delay");
});

test("间隔已过 → 只按阅读延迟等", () => {
  const config = { ...DEFAULT_PACING, jitterRatio: 0 };
  const wait = planSendWait({
    threadKey: "t",
    now: T0 + 60_000,
    lastSentAt: T0,
    incomingText: "你好",
    config,
  });
  assert.equal(wait.reason, "read_delay");
  assert.equal(wait.waitMs, config.readDelayPerCharMs * 2);
});

test("minSendIntervalMs=0 → 不再有硬间隔（仍保留阅读延迟）", () => {
  const config = { ...DEFAULT_PACING, minSendIntervalMs: 0, jitterRatio: 0 };
  const wait = planSendWait({ threadKey: "t", now: T0, lastSentAt: T0, incomingText: "你好", config });
  assert.equal(wait.reason, "read_delay");
});

test("抖动只影响最终值，baseMs 仍是配置口径（排查时看得出「等这么久」是谁造成的）", () => {
  const config = { ...DEFAULT_PACING, minSendIntervalMs: 10_000, readDelayPerCharMs: 0 };
  const wait = planSendWait({ threadKey: "t", now: T0, lastSentAt: T0, incomingText: "x", config });
  assert.equal(wait.baseMs, 10_000);
  assert.notEqual(wait.waitMs, 10_000);
  assert.ok(wait.waitMs >= 8_000 && wait.waitMs <= 12_000, `实际 ${wait.waitMs}`);
});

/* ————————————————————————— 配置解析：不静默降级 ————————————————————————— */

test("空配置 → 全默认，且不产生诊断（缺省是正常情况，不是错误）", () => {
  const diagnostics = [];
  assert.deepEqual(parsePacingConfig(undefined, diagnostics), DEFAULT_PACING);
  assert.deepEqual(parsePacingConfig(null, diagnostics), DEFAULT_PACING);
  assert.deepEqual(parsePacingConfig("垃圾", diagnostics), DEFAULT_PACING);
  assert.deepEqual(diagnostics, []);
});

test("越界收窄并写诊断（不许静默改用户配置）", () => {
  const diagnostics = [];
  const config = parsePacingConfig({ minSendIntervalMs: 999_999, jitterRatio: 5 }, diagnostics);
  assert.equal(config.minSendIntervalMs, 60_000);
  assert.equal(config.jitterRatio, 0.5);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics[0].includes("同线程最小发送间隔"));
});

test("非数字写诊断并回落默认", () => {
  const diagnostics = [];
  const config = parsePacingConfig({ readDelayPerCharMs: "abc" }, diagnostics);
  assert.equal(config.readDelayPerCharMs, DEFAULT_PACING.readDelayPerCharMs);
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0].includes("阅读延迟"));
});

test("0 是实义值（关掉某条护栏），不是缺失回落默认", () => {
  const diagnostics = [];
  const config = parsePacingConfig({ minSendIntervalMs: 0, readDelayPerCharMs: 0, readDelayMaxMs: 0, jitterRatio: 0 }, diagnostics);
  assert.deepEqual(config, { minSendIntervalMs: 0, readDelayPerCharMs: 0, readDelayMaxMs: 0, jitterRatio: 0 });
  assert.deepEqual(diagnostics, []);
});

test("空字符串按缺失处理（表单里清空输入不等于「设成 NaN」）", () => {
  const diagnostics = [];
  const config = parsePacingConfig({ minSendIntervalMs: "" }, diagnostics);
  assert.equal(config.minSendIntervalMs, DEFAULT_PACING.minSendIntervalMs);
  assert.deepEqual(diagnostics, []);
});

/* ————————————————————————— 人工接管：非法值绝不静默当 engine ————————————————————————— */

test("接管模式就是三态（与前端 CHAT_TAKEOVER_MODES 逐字一致）", () => {
  assert.deepEqual([...CHAT_TAKEOVER_MODES], ["engine", "human", "paused"]);
});

test("parseTakeovers：合法值原样保留", () => {
  const diagnostics = [];
  const parsed = parseTakeovers({ "wa|u:abc": "human", "tg|u:xyz": "paused", "wa|u:keep": "engine" }, diagnostics);
  assert.deepEqual(parsed, { "wa|u:abc": "human", "tg|u:xyz": "paused", "wa|u:keep": "engine" });
  assert.deepEqual(diagnostics, []);
});

test("parseTakeovers：非法值丢弃并回报（绝不静默当成 engine —— 那会让引擎继续开口）", () => {
  const diagnostics = [];
  const parsed = parseTakeovers({ "wa|u:abc": "takeover", "wa|u:def": 7, "wa|u:ghi": "" }, diagnostics);
  assert.deepEqual(parsed, {});
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics[0].startsWith("takeover_invalid:wa|u:abc"));
});

test("parseTakeovers：空 key 跳过；整个载荷不是对象 → 空表（不是抛错）", () => {
  const diagnostics = [];
  assert.deepEqual(parseTakeovers({ "": "human" }, diagnostics), {});
  assert.deepEqual(parseTakeovers(null, diagnostics), {});
  assert.deepEqual(parseTakeovers([], diagnostics), {});
  assert.deepEqual(parseTakeovers("patch", diagnostics), {});
  assert.deepEqual(diagnostics, []);
});

/* ————————————————————————— 人工优先覆盖的查表 ————————————————————————— */

test("覆盖查表：规范键 = 站点 + 联系人目录段（与视图/索引表同一套清洗）", () => {
  const seed = { key: "unknown|Anne", label: "Anne", siteKey: "unknown" };
  // 视图写的就是这个键（`takeoverKeyOf`），无歧义、不会跨站点撞名
  assert.equal(takeoverKeyOf(seed), "unknown|unknown_Anne");
  assert.equal(takeoverOverrideOf({ "unknown|unknown_Anne": "engine" }, seed), "engine");
  assert.equal(takeoverOverrideOf({ "unknown|unknown_Anne": "paused" }, seed), "paused");
  // 唯一的迁移读：引擎的会话键（老设置里可能存过这一种）
  assert.equal(takeoverOverrideOf({ "unknown|Anne": "human" }, seed), "human");
});

test("覆盖查表：不再认「猜出来」的写法（昵称会改会重名，目录名跨站点会撞）", () => {
  const seed = { key: "unknown|Anne", label: "Anne", siteKey: "unknown" };
  // 只写目录名 / 站点+昵称：都不再当作接管，否则可能把接管错记到另一个人头上
  assert.equal(takeoverOverrideOf({ unknown_Anne: "paused" }, seed), undefined);
  assert.equal(takeoverOverrideOf({ "unknown|Anne Smith": "paused" }, seed), undefined);
});

test("覆盖查表：没写 / 非法值都不当成覆盖（缺省仍是快照里的自动判定）", () => {
  const seed = { key: "unknown|Anne", label: "Anne", siteKey: "unknown" };
  assert.equal(takeoverOverrideOf(undefined, seed), undefined);
  assert.equal(takeoverOverrideOf({}, seed), undefined);
  assert.equal(takeoverOverrideOf({ unknown_Anne: "bogus" }, seed), undefined);
  assert.equal(takeoverOverrideOf({ other: "human" }, seed), undefined);
});

test("覆盖查表：同名的两个站点各锁各的（键里带站点，不互相串）", () => {
  const tg = { key: "unknown|Anne", label: "Anne", siteKey: "unknown" };
  const wa = { key: "wa|Anne", label: "Anne", siteKey: "wa" };
  const table = { "unknown|unknown_Anne": "paused" };
  assert.equal(takeoverOverrideOf(table, tg), "paused");
  assert.equal(takeoverOverrideOf(table, wa), undefined);
});
