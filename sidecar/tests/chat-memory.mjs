/**
 * 聊天长期记忆（P5）回归测试。
 *
 * 重点锁住「**防递归退化**」的三条规则，以及敏感信息不进事实库：
 * 1. 没有未覆盖的原始消息 → 绝不压缩（禁止「摘要总结摘要」）；
 * 2. 长期事实独立存放、只追加去重，摘要被裁剪时事实不丢；
 * 3. 代数到顶后不再压缩，只推进覆盖位置。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MEMORY_CONFIG,
  acceptAngle,
  buildChatSummaryMessages,
  clampSummary,
  decideCompact,
  isAngleReused,
  mergeSummary,
  normalizeAngle,
  parseChatSummary,
  sanitizeFact,
  uncoveredMessages,
} from "../dist/core/web_chat/chat_memory.js";

function message(id, direction, text) {
  return { id, direction, text, ts: null, identity: null, stableId: true };
}

function summaryJson(summary, facts = []) {
  return JSON.stringify({ summary, facts });
}

/* ———————————————————— 何时压缩 ———————————————————— */

test("没有未覆盖的原始消息 → 绝不压缩（防「摘要总结摘要」）", () => {
  const decision = decideCompact({ totalMessages: 500, uncoveredMessages: 0, generations: 3 });
  assert.equal(decision.needed, false);
  assert.equal(decision.reason, "no_new_raw");
  assert.equal(decision.requiresLlm, false);
});

test("未达阈值 → 不压缩", () => {
  const decision = decideCompact({
    totalMessages: 10,
    uncoveredMessages: DEFAULT_MEMORY_CONFIG.compactAfterMessages - 1,
    generations: 0,
  });
  assert.equal(decision.needed, false);
  assert.equal(decision.reason, "not_needed");
});

test("积压到阈值 → 压缩，并给出覆盖条数", () => {
  const decision = decideCompact({
    totalMessages: 100,
    uncoveredMessages: DEFAULT_MEMORY_CONFIG.compactAfterMessages,
    generations: 1,
  });
  assert.equal(decision.needed, true);
  assert.equal(decision.reason, "uncovered_backlog");
  assert.equal(decision.requiresLlm, true);
  assert.equal(decision.covering, DEFAULT_MEMORY_CONFIG.compactAfterMessages);
});

test("积压超过窗口上限时，一次最多覆盖 rawWindowMax 条", () => {
  const decision = decideCompact({
    totalMessages: 9999,
    uncoveredMessages: 9999,
    generations: 0,
  });
  assert.equal(decision.covering, DEFAULT_MEMORY_CONFIG.rawWindowMax);
});

test("代数到顶 → 只推进覆盖位置，不再调用模型", () => {
  const decision = decideCompact({
    totalMessages: 900,
    uncoveredMessages: 40,
    generations: DEFAULT_MEMORY_CONFIG.maxGenerations,
  });
  assert.equal(decision.needed, true);
  assert.equal(decision.reason, "generation_cap_reached");
  assert.equal(decision.requiresLlm, false, "到顶后不得再压（否则摘要无限退化）");
});

test("负数/非法输入按 0 处理（不因脏数据触发压缩）", () => {
  assert.equal(decideCompact({ totalMessages: -5, uncoveredMessages: -1, generations: -3 }).needed, false);
  assert.equal(decideCompact({ totalMessages: 0, uncoveredMessages: 0, generations: 0 }).reason, "no_new_raw");
});

/* ———————————————————— 摘要提示词 ———————————————————— */

test("摘要提示词必须带上原始消息与已知事实（不许只喂旧摘要）", () => {
  const messages = buildChatSummaryMessages({
    contactLabel: "Alice",
    goal: "约线下看展",
    stage: "engaged",
    previousSummary: "之前聊过摄影",
    uncovered: [message("m1", "in", "我最近在学冲浪"), message("m2", "out", "厉害啊")],
    knownFacts: ["喜欢黑白照片"],
  });

  assert.equal(messages[0].role, "system");
  const user = messages[1].content;
  assert.ok(user.includes("我最近在学冲浪"), "必须包含原始消息");
  assert.ok(user.includes("之前聊过摄影"), "必须包含旧摘要");
  assert.ok(user.includes("喜欢黑白照片"), "必须列出已登记事实以防重复登记");
  assert.ok(user.includes("不要重复登记"), "应明确要求不重复登记事实");
});

test("摘要提示词明确禁止记录敏感信息", () => {
  const messages = buildChatSummaryMessages({
    contactLabel: "Bob",
    goal: "",
    stage: "cold",
    previousSummary: null,
    uncovered: [message("m1", "in", "你好")],
    knownFacts: [],
  });
  assert.ok(messages[0].content.includes("验证码"));
  assert.ok(messages[0].content.includes("绝不"));
});

/* ———————————————————— 摘要解析 ———————————————————— */

test("parseChatSummary 解析标准 JSON", () => {
  const parsed = parseChatSummary(summaryJson("聊到在学冲浪", ["住在青岛"]));
  assert.equal(parsed.summary, "聊到在学冲浪");
  assert.deepEqual(parsed.facts, ["住在青岛"]);
});

test("parseChatSummary 容忍 markdown 包裹与前后废话", () => {
  const fenced = parseChatSummary("```json\n" + summaryJson("摘要内容") + "\n```");
  assert.equal(fenced.summary, "摘要内容");
  const chatty = parseChatSummary("好的，这是结果：" + summaryJson("摘要内容"));
  assert.equal(chatty.summary, "摘要内容");
});

test("parseChatSummary 空摘要返回 null（绝不放行空内容）", () => {
  assert.equal(parseChatSummary(""), null);
  assert.equal(parseChatSummary("{}"), null);
  assert.equal(parseChatSummary("这不是 JSON"), null);
  assert.equal(parseChatSummary(summaryJson("   ")), null);
});

/* ———————————————————— 合并与覆盖点 ———————————————————— */

test("mergeSummary 覆盖率只前进，不被旧位置回退", () => {
  const all = ["m1", "m2", "m3", "m4", "m5"];
  const merged = mergeSummary({
    previousSummary: "旧摘要",
    previousCoveredUpToId: "m4",
    previousGenerations: 2,
    generated: { summary: "新摘要", facts: [] },
    // 模型这轮只覆盖了更早的两条（异常回吐）
    covered: [message("m2", "in", "x"), message("m3", "in", "y")],
    allMessageIds: all,
    knownFacts: [],
  });
  assert.equal(merged.coveredUpToId, "m4", "覆盖点不得回退（否则会反复总结同一批消息）");
  assert.equal(merged.generations, 3);
});

test("mergeSummary 覆盖率正常前进", () => {
  const all = ["m1", "m2", "m3", "m4", "m5"];
  const merged = mergeSummary({
    previousSummary: "旧摘要",
    previousCoveredUpToId: "m2",
    previousGenerations: 0,
    generated: { summary: "新摘要", facts: [] },
    covered: [message("m3", "in", "x"), message("m4", "in", "y")],
    allMessageIds: all,
    knownFacts: [],
  });
  assert.equal(merged.coveredUpToId, "m4");
  assert.equal(merged.generations, 1);
});

test("mergeSummary 只在拿到全量 id 列表时才做前进判定（否则直接采用）", () => {
  const merged = mergeSummary({
    previousSummary: null,
    previousCoveredUpToId: "m9",
    previousGenerations: 0,
    generated: { summary: "摘要", facts: [] },
    covered: [message("m1", "in", "x")],
    knownFacts: [],
  });
  assert.equal(merged.coveredUpToId, "m1");
});

/* ———————————————————— 长期事实 ———————————————————— */

test("长期事实去重且过滤敏感信息（不脱敏保留，整条丢弃）", () => {
  const merged = mergeSummary({
    previousSummary: null,
    previousCoveredUpToId: null,
    previousGenerations: 0,
    generated: {
      summary: "摘要",
      facts: ["喜欢咖啡", "喜欢咖啡", "他的验证码是 483920", "密码是 abc123", "住在成都"],
    },
    covered: [message("m1", "in", "x")],
    knownFacts: ["住在成都"], // 已登记 → 不重复
    allMessageIds: ["m1"],
  });
  assert.deepEqual(merged.newFacts, ["喜欢咖啡"], "只登记没过的新事实，敏感条目整条丢弃");
});

test("sanitizeFact 过滤敏感词与空内容，去掉结尾标点", () => {
  assert.equal(sanitizeFact("喜欢咖啡。"), "喜欢咖啡");
  assert.equal(sanitizeFact("   "), null);
  assert.equal(sanitizeFact("x"), null, "单字不成事实");
  assert.equal(sanitizeFact("银行卡号 6222"), null);
  assert.equal(sanitizeFact("otp 是 1234"), null);
  assert.equal(sanitizeFact("常去健身房"), "常去健身房");
});

test("sanitizeFact 超长事实被截断（事实应一行一条）", () => {
  const long = "很".repeat(500);
  const cleaned = sanitizeFact(long, { ...DEFAULT_MEMORY_CONFIG, factMaxChars: 20 });
  assert.equal(cleaned.length, 20);
});

test("mergeSummary 不重复登记已知事实", () => {
  const merged = mergeSummary({
    previousSummary: null,
    previousCoveredUpToId: null,
    previousGenerations: 0,
    generated: { summary: "摘要", facts: ["甲乙丙丁"] },
    covered: [message("m1", "in", "x")],
    knownFacts: ["甲乙丙丁"],
    allMessageIds: ["m1"],
  });
  assert.deepEqual(merged.newFacts, []);
});

/* ———————————————————— 摘要裁剪 ———————————————————— */

test("clampSummary 只裁最旧的部分，且在句子边界起头（不出现半句）", () => {
  // 用互不相同的句子，才能真检验「有没有从半句中间切开」
  const sentences = Array.from({ length: 40 }, (_, i) => `第${i}句说的是某件事。`);
  const long = sentences.join("");
  const clamped = clampSummary(long, 60);

  assert.ok(clamped.length <= 60, `裁剪后应不超上限，实际 ${clamped.length}`);
  assert.ok(long.endsWith(clamped), "必须是原文的一个后缀（保留最近进展）");
  assert.ok(clamped.includes("第39句"), "最近的内容必须保留");

  // 后缀起点的前一个字符必须是句末标点 → 说明是整句起头，不是半句
  const startIndex = long.length - clamped.length;
  if (startIndex > 0) {
    assert.ok(
      /[。！？.!?\n]/.test(long[startIndex - 1]),
      `应从句子边界起头，实际前一字符：${JSON.stringify(long[startIndex - 1])}`,
    );
  }
  // 且结果本身以句末标点结尾
  assert.ok(/[。！？.!?]$/.test(clamped));
});

test("clampSummary 短文本原样返回，并去掉多余空白", () => {
  assert.equal(clampSummary("  你好  世界  "), "你好  世界");
});

/* ———————————————————— 角度轮换 ———————————————————— */

test("normalizeAngle 让不同写法的同一角度可比较", () => {
  assert.equal(normalizeAngle("问天气"), normalizeAngle("关于 天气。"));
  assert.equal(normalizeAngle("聊展览"), normalizeAngle("聊展览！"));
});

test("isAngleReused 能识别换词/包含关系", () => {
  assert.equal(isAngleReused("问天气", ["问 天气"]), true);
  assert.equal(isAngleReused("天气", ["聊天气"]), true);
  assert.equal(isAngleReused("运动", ["聊天气", "聊摄影"]), false);
});

test("acceptAngle 丢弃重复角度（宁丢角度不丢消息）", () => {
  assert.equal(acceptAngle("问天气", ["问天气"]), null);
  assert.equal(acceptAngle("", []), null);
  assert.equal(acceptAngle(null, []), null);
  assert.equal(acceptAngle("聊冲浪", ["聊天气"]), "聊冲浪");
});

test("acceptAngle 限制角度长度", () => {
  const long = "很".repeat(100);
  assert.equal(acceptAngle(long, []).length, 40);
});

/* ———————————————————— 未覆盖切片 ———————————————————— */

test("uncoveredMessages 从覆盖点之后取，且不超过窗口上限", () => {
  const all = Array.from({ length: 100 }, (_, i) => message(`m${i}`, "in", `消息${i}`));
  const rest = uncoveredMessages(all, "m49", 10);
  assert.equal(rest.length, 10);
  assert.equal(rest[0].id, "m90");
  assert.equal(rest[rest.length - 1].id, "m99");
});

test("uncoveredMessages 找不到覆盖点（历史被裁尾）时保守认为全部未覆盖", () => {
  const all = Array.from({ length: 5 }, (_, i) => message(`m${i}`, "in", `消息${i}`));
  const rest = uncoveredMessages(all, "已被裁掉的旧id", 10);
  assert.equal(rest.length, 5, "宁可多总结一次，也不能假装读过");
});

test("uncoveredMessages 无覆盖点时取尾部窗口", () => {
  const all = Array.from({ length: 100 }, (_, i) => message(`m${i}`, "in", `消息${i}`));
  const rest = uncoveredMessages(all, null, 5);
  assert.equal(rest.length, 5);
  assert.equal(rest[4].id, "m99");
});

test("端到端形状：流水 30 条 → 决策要压缩 → 合并后覆盖点推进且登记新事实", () => {
  // 模拟一轮：流水 30 条 → 决策该压 → 模型产出 → 合并
  const all = Array.from({ length: 30 }, (_, i) =>
    message(`m${i}`, i % 2 === 0 ? "in" : "out", `第${i}句`),
  );
  const uncovered = uncoveredMessages(all, null, DEFAULT_MEMORY_CONFIG.rawWindowMax);
  const decision = decideCompact({
    totalMessages: all.length,
    uncoveredMessages: uncovered.length,
    generations: 0,
  });
  assert.equal(decision.requiresLlm, true);

  const merged = mergeSummary({
    previousSummary: null,
    previousCoveredUpToId: null,
    previousGenerations: 0,
    generated: parseChatSummary(summaryJson("谈过冲浪", ["住青岛"])),
    covered: uncovered,
    allMessageIds: all.map((m) => m.id),
    knownFacts: [],
  });
  assert.equal(merged.coveredUpToId, "m29");
  assert.deepEqual(merged.newFacts, ["住青岛"]);
});
