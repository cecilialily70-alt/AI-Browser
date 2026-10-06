/**
 * 聊天模式每联系人上下文（P3）回归测试。
 *
 * 锁住三类**真会出事**的行为：
 * 1. 路径段清洗（`../` 逃逸 / 清洗后变空 → 清错目录）；
 * 2. 一次性码**绝不落盘**（R2 / §1.3）；
 * 3. 回访状态与角度/事实的去重与限量（复读、风暴）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  addAngle,
  addFacts,
  appendOutboxJournal,
  appendThreadMessages,
  chatContextRoot,
  contactDir,
  emptyVisitState,
  listContactDirs,
  readAngles,
  readFacts,
  readSummary,
  readThreadMessages,
  readVisitState,
  sanitizeSegment,
  settleVisitState,
  writeVisitState,
} from "../dist/core/web_chat/context_store.js";
import { hasOneTimeCode, redactForStorage } from "../dist/core/web_chat/chat_redaction.js";
import { hashText } from "../dist/core/web_chat/outbox.js";

/** sidecar 源码根：用于「同一口径只能有一套」这类源码级断言 */
const SIDECAR_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "chat-ctx-"));
}

function message(id, direction, text) {
  return { id, direction, text, ts: null, identity: null, stableId: true };
}

/* ———————————————————— 路径段清洗 ———————————————————— */

test("sanitizeSegment 挡住路径逃逸", () => {
  assert.equal(sanitizeSegment("../etc/passwd"), "__etc_passwd");
  assert.equal(sanitizeSegment("a/b\\c"), "a_b_c");
  assert.equal(sanitizeSegment("a:b*c?"), "a_b_c_");
});

test("sanitizeSegment 清洗后变空必须回退（否则会把站点目录当成联系人目录删掉）", () => {
  // 两端空白/点会被首尾裁剪掉 → 空串
  assert.equal(sanitizeSegment(" . ", "unknown-contact"), "unknown-contact");
  assert.equal(sanitizeSegment("   ", "unknown-contact"), "unknown-contact");
  assert.equal(sanitizeSegment("", "unknown-site"), "unknown-site");
  // 连续点会先折叠成下划线，因此不是空串而是 "_"
  assert.equal(sanitizeSegment(".."), "_");
});

test("sanitizeSegment 保留可读的名字（中文/空格/长截断）", () => {
  assert.equal(sanitizeSegment("张三"), "张三");
  assert.equal(sanitizeSegment("Alice Smith"), "Alice Smith");
  assert.equal(sanitizeSegment("x".repeat(200)).length, 96);
});

test("contactDir 永远落在 chat_context 之内", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "../../evil", "../../../etc");
    assert.ok(dir.startsWith(chatContextRoot(root)));
    assert.ok(!dir.includes(".."));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ———————————————————— 脱敏（R2） ———————————————————— */

test("redactForStorage 遮蔽一次性码语境里的数字", () => {
  const out = redactForStorage("你的验证码是 483920，请勿告诉他人");
  assert.ok(!out.includes("483920"));
  assert.ok(out.includes("验证码"));
});

test("redactForStorage 不误伤正常内容（报价/库存）", () => {
  const raw = "这个报价 5999，库存 1200";
  assert.equal(redactForStorage(raw), raw);
  assert.equal(hasOneTimeCode(raw), false);
});

test("会话流水落盘后不含一次性码原文", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "chat.example.com", "alice");
    appendThreadMessages(dir, [
      message("m1", "in", "请把验证码 918273 发我"),
      message("m2", "in", "今天天气不错"),
    ]);
    const text = readFileSync(join(dir, "thread.jsonl"), "utf8");
    assert.ok(!text.includes("918273"), "验证码原文不得落盘");
    assert.ok(text.includes("今天天气不错"), "正常内容应保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ———————————————————— 会话流水 ———————————————————— */

test("appendThreadMessages 按 id 去重（虚拟列表反复读到同一条不重复写）", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "bob");
    appendThreadMessages(dir, [message("m1", "in", "你好")]);
    appendThreadMessages(dir, [message("m1", "in", "你好"), message("m2", "out", "你也好")]);
    const entries = readThreadMessages(dir, 50);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["m1", "m2"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendThreadMessages 丢弃空 id / 空文本", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "bob");
    const result = appendThreadMessages(dir, [
      message("", "in", "无 id"),
      message("m9", "in", "   "),
    ]);
    assert.equal(result.appended, 0);
    assert.equal(result.skipped, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendThreadMessages 的 appendedIn 只算真正新增的收信（计数不虚高）", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "count");
    const read = [
      message("m1", "in", "你好"),
      message("m2", "out", "你也好"),
      message("m3", "in", "在吗"),
    ];
    const first = appendThreadMessages(dir, read);
    assert.equal(first.appendedIn, 2);
    assert.equal(first.appendedOut, 1);

    // 引擎每轮都会把整段会话传进来 —— 第二次必须一条都不算「新增」
    const second = appendThreadMessages(dir, read);
    assert.equal(second.appendedIn, 0);
    assert.equal(second.appendedOut, 0);
    assert.equal(second.appended, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readThreadMessages 对损坏行容错（一行坏不毁整份记忆）", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "bob");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "thread.jsonl"),
      '{"id":"m1","direction":"in","text":"好的","ts":null,"at":"x"}\n{坏行\n',
      "utf8",
    );
    const entries = readThreadMessages(dir, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "好的");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话流水超上限后裁尾，且仍保持 JSONL 格式", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "cap");
    // 分批写入，触发一次裁尾（THREAD_LEDGER_LIMIT = 400）
    for (let batch = 0; batch < 5; batch += 1) {
      const rows = [];
      for (let i = 0; i < 100; i += 1) {
        rows.push(message(`b${batch}-${i}`, "in", `消息 ${batch}-${i}`));
      }
      appendThreadMessages(dir, rows);
    }

    const raw = readFileSync(join(dir, "thread.jsonl"), "utf8");
    assert.ok(!raw.trimStart().startsWith("["), "不得写成 JSON 数组（会与按行读取的统计分叉）");
    for (const line of raw.split("\n")) {
      if (line.trim()) JSON.parse(line); // 每一行都必须是合法 JSON
    }

    const entries = readThreadMessages(dir, 1000);
    assert.equal(entries.length, 400, "超过上限后应裁到上限");
    // 保留的必须是最新的那批
    assert.ok(entries[entries.length - 1].id.startsWith("b4-"));
    const archiveRaw = readFileSync(join(dir, "thread.archive.jsonl"), "utf8");
    const archived = archiveRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    assert.equal(archived.length, 100, "裁掉的热窗口应进归档而不是丢弃");
    assert.ok(JSON.parse(archived[0]).id.startsWith("b0-"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ———————————————————— 回访状态 ———————————————————— */

test("settleVisitState 记录引擎算好的值，不自己重算序号", () => {
  const first = settleVisitState(emptyVisitState("2026-01-01T00:00:00Z"), {
    now: "2026-01-01T00:00:00Z",
    label: "Alice",
    incomingCount: 1,
    sent: true,
    followUpIndex: 3,
    nextDueAt: "2026-01-03T00:00:00Z",
    stage: "engaged",
  });
  assert.equal(first.label, "Alice");
  assert.equal(first.followUpIndex, 3);
  assert.equal(first.nextDueAt, "2026-01-03T00:00:00Z");
  assert.equal(first.firstContactAt, "2026-01-01T00:00:00Z");
  assert.equal(first.lastReplyAt, "2026-01-01T00:00:00Z");
  assert.equal(first.totalIn, 1);
  assert.equal(first.totalOut, 1);

  // 第二次：没有新收信、序号由引擎给 4
  const second = settleVisitState(first, {
    now: "2026-01-03T00:00:00Z",
    incomingCount: 0,
    sent: true,
    followUpIndex: 4,
    nextDueAt: "2026-01-07T00:00:00Z",
    stage: "engaged",
  });
  assert.equal(second.followUpIndex, 4);
  assert.equal(second.firstContactAt, "2026-01-01T00:00:00Z", "首次接触时间不可被覆盖");
  assert.equal(second.lastReplyAt, "2026-01-01T00:00:00Z", "没有回话就不该刷新回话时间");
  assert.equal(second.totalOut, 2);
});

test("settleVisitState 保留 label 与停止原因", () => {
  const state = settleVisitState(emptyVisitState("2026-02-01T00:00:00Z"), {
    now: "2026-02-01T00:00:00Z",
    label: "Bob",
    incomingCount: 0,
    sent: false,
    followUpIndex: 0,
    nextDueAt: null,
    stage: "opted_out",
    stopped: true,
    stopReason: "opted_out",
  });
  assert.equal(state.stopped, true);
  assert.equal(state.stopReason, "opted_out");
  assert.equal(state.label, "Bob");
  assert.equal(state.nextDueAt, null);
});

test("visit.json 损坏/缺字段时按空态补齐而不是整份丢弃", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "carol");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "visit.json"), '{"followUpIndex":2,"stage":"engaged"}', "utf8");
    const visit = readVisitState(dir);
    assert.equal(visit.followUpIndex, 2);
    assert.equal(visit.stopped, false);
    assert.equal(visit.label, "");

    writeFileSync(join(dir, "visit.json"), "{坏", "utf8");
    assert.equal(readVisitState(dir), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeVisitState → readVisitState 往返一致", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "dave");
    const state = { ...emptyVisitState("2026-03-01T00:00:00Z"), label: "Dave", followUpIndex: 1 };
    assert.equal(writeVisitState(dir, state).ok, true);
    assert.deepEqual(readVisitState(dir), state);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ———————————————————— 角度 / 事实 / 摘要 ———————————————————— */

test("addAngle 去重并保留插入顺序", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "eve");
    addAngle(dir, "问展览时间");
    addAngle(dir, "问展览时间");
    addAngle(dir, "聊天气");
    assert.deepEqual(readAngles(dir), ["问展览时间", "聊天气"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addFacts 脱敏 + 去重", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "eve");
    addFacts(dir, ["喜欢咖啡", "喜欢咖啡", "验证码 123456"]);
    const facts = readFacts(dir);
    assert.deepEqual(facts, ["喜欢咖啡", "验证码 [已脱敏]"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSummary 缺失时返回 null（由上层按首次接触处理）", () => {
  const root = tempRoot();
  try {
    assert.equal(readSummary(contactDir(root, "s.example.com", "eve")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendOutboxJournal 只落指纹不落原文", () => {
  const root = tempRoot();
  try {
    const dir = contactDir(root, "s.example.com", "frank");
    appendOutboxJournal(dir, {
      effectId: "e1",
      threadKey: "frank",
      textHash: "h1",
      status: "sent",
      attempts: 1,
      at: "2026-04-01T00:00:00Z",
      note: "开场",
    });
    const raw = readFileSync(join(dir, "outbox.jsonl"), "utf8");
    assert.ok(raw.includes("h1"));
    assert.ok(!raw.includes("你好")); // 原文本绝不出现在审计流水里
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ———————————————————— 枚举 / 统计 / 清理 ———————————————————— */

test("listContactDirs 跳过 state.json 等非目录", () => {
  const root = tempRoot();
  try {
    mkdirSync(chatContextRoot(root), { recursive: true });
    writeFileSync(join(chatContextRoot(root), "state.json"), "{}", "utf8");
    // 目录只有真被写入才会出现（contactDir 只算路径）
    appendThreadMessages(contactDir(root, "s.example.com", "gina"), [message("m1", "in", "hi")]);
    const refs = listContactDirs(root);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].contactKey, "gina");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chatContextRoot 缺少 userDataDir 时抛错（不猜目录）", () => {
  assert.throws(() => chatContextRoot(""), /chat_context_root_required/);
});

/* ———————————————————— 指纹口径只能有一套（假护栏的教训） ———————————————————— */

test("发件箱流水落的是 hashText 指纹（与引擎比对/去重同一套，不许再分叉）", async () => {
  // 现场事故（§0.5.3 H）：流水里写的是另一套指纹（`fingerprint` = trim+lowercase），
  // 而引擎判「这条是不是我发的」用的是 `hashText` —— 两套永远对不上，于是
  // 「我方确实发过」的耐久证据形同虚设：快照一丢就把自己发的那条当成陌生人 →
  // 判用户接管 → 该联系人永久停手。这条从源码上锁死「装配层用哪一套」。
  const source = readFileSync(join(SIDECAR_SRC, "bu_agent", "chat_session.ts"), "utf8");
  assert.ok(
    source.includes("textHash: sentHash"),
    "appendOutboxJournal 必须落 hashText 算出的指纹（sentHash），不得引用第二套指纹函数",
  );
  assert.ok(
    !source.includes('from "../core/web_chat/chat_redaction.js";'),
    "装配层不得再引入 chat_redaction 的 fingerprint（那是另一套口径）",
  );
  assert.ok(source.includes("const sentHash = hashText(persistInput.sentText)"));
  // 真的落盘一次，确认读回来就是我方指纹
  const root = tempRoot();
  try {
    const dir = contactDir(root, "telegram", "anne");
    const sentHash = hashText("你好，平时还要玩哪个游戏？02:20 02:20");
    appendOutboxJournal(dir, {
      effectId: sentHash,
      threadKey: "telegram|anne",
      textHash: sentHash,
      status: "sent",
      attempts: 1,
      at: "2026-09-27T18:20:56.646Z",
      note: null,
    });
    const raw = readFileSync(join(dir, "outbox.jsonl"), "utf8");
    assert.ok(raw.includes(sentHash), "流水里的指纹必须与引擎口径一致");
    assert.equal(sentHash, hashText("你好，平时还要玩哪个游戏？"), "页面装饰不改变指纹");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
