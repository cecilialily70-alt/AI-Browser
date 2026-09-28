/**
 * 聊天站点描述符回归测试（P1）
 *
 * 运行：`npm run build && npm run test:chat`
 *
 * 覆盖：
 *   - 严格校验：键名白名单 / 枚举 / 上限 / **拒绝脚本标记** / 正则必须能编译 / source 由目录决定
 *   - **三个结构性 BUG 的回归锁**：
 *       ① 我方消息绝不算「对方回话」（`newIncoming` 只收方向 in）
 *       ② 附件/语音（有行无文本）也算「对方回了」，但**不取内容**
 *       ③ 站点显示时间戳一律不信（顺序只由行序决定）
 *   - 编辑 / 撤回 / 排除 / 无稳定 id 的去重口径
 *   - 熔断：learned 可自动停用并回落，builtin 只报错；成功清零
 *   - 选站优先级：learned > builtin > 通用模式（都被停用/都不命中 → null = 通用模式）
 *   - 加载诊断：坏文件只报错不拖垮其它描述符；目录缺失如实上报
 *   - R4 源码级断言：聊天核心与描述符层**零站点字面量**、**零动态求值**
 *   - 通用模式：`dom_connector` 不依赖描述符也能读，且方向仍进 `newIncoming`/`newOutgoing`
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileDescriptorPattern,
  descriptorMatchesUrl,
  parseDescriptor,
} from "../dist/core/web_chat/descriptor/manifest.js";
import {
  contentVersionOf,
  diffSnapshot,
  hasDirectionEvidence,
  hasIncomingReply,
  isAcceptableRowId,
  mapRows,
  snapshotFromMessages,
  splitRowKey,
  upgradeDirections,
} from "../dist/core/web_chat/descriptor/map_rows.js";
import {
  isConnectorUsable,
  newConnectorHealth,
  recordHealthOutcome,
  reenableConnector,
} from "../dist/core/web_chat/descriptor/health.js";
import {
  listDescriptorItems,
  loadDescriptorDirs,
  parseDescriptorEntries,
  pickDescriptor,
} from "../dist/core/web_chat/descriptor/registry.js";
import { mapThreads } from "../dist/core/web_chat/descriptor/threads.js";
import { createDomConnector } from "../dist/core/web_chat/descriptor/dom_connector.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const BUILTIN_DIR = join(FIXTURES, "connectors");
const BAD_DIR = join(BUILTIN_DIR, "bad");
const LEARNED_DIR = join(FIXTURES, "connectors-learned");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validDescriptor() {
  return JSON.parse(readFileSync(join(BUILTIN_DIR, "sample-im.example.json"), "utf8"));
}

/* ————————————————————————— A. 严格校验 ————————————————————————— */

test("合法描述符：解析成功，且 source 由加载方决定（不信任文件里的 source）", () => {
  const result = parseDescriptor(validDescriptor(), "builtin");
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.descriptor.id, "sample-im");
  assert.equal(result.descriptor.source, "builtin");
  assert.equal(result.descriptor.rows.idPrefixDirection.out, "false_");
  assert.equal(result.descriptor.composer.input.method, "selectAllBeforeInput");
  assert.equal(result.descriptor.composer.input.failClosed, true);
});

test("未知字段一律拒绝，且诊断带字段路径（手误不被静默忽略）", () => {
  const broken = readFileSync(join(BAD_DIR, "broken-unknown-key.json"), "utf8");
  const result = parseDescriptor(JSON.parse(broken), "builtin");
  assert.equal(result.ok, false);
  const codes = result.diagnostics.map((d) => `${d.code}@${d.path}`);
  assert.ok(codes.includes("unknown_key@/note"), codes.join(","));
  assert.ok(codes.includes("unknown_key@/rows/postProcess"), codes.join(","));
});

test("含脚本标记的字符串一律拒绝（R8 第①条：描述符只许声明，不许脚本）", () => {
  const cases = ["() => document.body", "javascript:void(0)", "`x`", "eval(1)", "new Function('a')", "a;b"];
  for (const evil of cases) {
    const descriptor = validDescriptor();
    descriptor.rows.textSelectors = [evil];
    const result = parseDescriptor(descriptor, "builtin");
    assert.equal(result.ok, false, `应当拒绝：${evil}`);
    assert.ok(result.diagnostics.some((d) => d.code === "script_like" || d.code === "bad_value"));
  }
});

test("枚举之外的「动作」被拒绝（没有站点内部发送函数这一项）", () => {
  const descriptor = validDescriptor();
  descriptor.composer.send.method = "callInternalSendFn";
  const result = parseDescriptor(descriptor, "builtin");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "bad_enum" && d.path === "/composer/send/method"));

  const descriptor2 = validDescriptor();
  descriptor2.composer.input.method = "runScript";
  assert.equal(parseDescriptor(descriptor2, "builtin").ok, false);
});

test("failClosed 必须为 true（写入校验失败即取消发送，R8 第④条）", () => {
  const descriptor = validDescriptor();
  descriptor.composer.input.failClosed = false;
  const result = parseDescriptor(descriptor, "builtin");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.path === "/composer/input/failClosed"));
});

test("正则必须能编译；非法正则被拒（不做「先收下再说」）", () => {
  const descriptor = validDescriptor();
  descriptor.rows.id.accept = ["^(?:true|false_"];
  const result = parseDescriptor(descriptor, "builtin");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "bad_regex"));

  assert.equal(compileDescriptorPattern("^(?:true|false_"), null);
  assert.ok(compileDescriptorPattern("^false_\\d+$"));
});

test("上限：超长字符串与超量数组被拒（描述符是外部输入）", () => {
  const longString = "x".repeat(400);
  const descriptor = validDescriptor();
  descriptor.rows.textSelectors = [longString];
  assert.equal(parseDescriptor(descriptor, "builtin").ok, false);

  const descriptor2 = validDescriptor();
  descriptor2.rows.exclude = Array.from({ length: 30 }, (_, i) => `#e${i}`);
  assert.equal(parseDescriptor(descriptor2, "builtin").ok, false);
});

test("id 形态与 out/in 前缀自检", () => {
  const badId = validDescriptor();
  badId.id = "Sample IM";
  assert.equal(parseDescriptor(badId, "builtin").ok, false);

  const samePrefix = validDescriptor();
  samePrefix.rows.idPrefixDirection = { out: "x_", in: "x_" };
  const result = parseDescriptor(samePrefix, "builtin");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.path === "/rows/idPrefixDirection"));
});

test("文件里的 source 与来源目录不一致即拒绝（learned 不能自称 builtin）", () => {
  const claimed = validDescriptor();
  claimed.source = "learned";
  const result = parseDescriptor(claimed, "builtin");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.path === "/source"));
});

test("hostPattern 精确匹配：不做子串误伤", () => {
  const { descriptor } = parseDescriptor(validDescriptor(), "builtin");
  assert.equal(descriptorMatchesUrl(descriptor, "https://sample-im.example/chat/1"), true);
  assert.equal(descriptorMatchesUrl(descriptor, "https://app.sample-im.example/chat/1"), true);
  assert.equal(descriptorMatchesUrl(descriptor, "https://sample-im.example.evil.com/"), false);
  assert.equal(descriptorMatchesUrl(descriptor, "not a url"), false);
});

test("pathPattern 写了就要求命中（写而不生效比没写更坏）", () => {
  const raw = validDescriptor();
  raw.match.pathPattern = "^/k/";
  const { descriptor } = parseDescriptor(raw, "builtin");
  assert.equal(descriptorMatchesUrl(descriptor, "https://sample-im.example/k/#1"), true);
  assert.equal(descriptorMatchesUrl(descriptor, "https://sample-im.example/a/#1"), false);
});

/* ————————————————————————— B. 三个结构性 BUG 的回归锁 ————————————————————————— */

const FACTS = JSON.parse(readFileSync(join(BUILTIN_DIR, "facts", "sample-im.rows.json"), "utf8"));
const DESCRIPTOR = parseDescriptor(validDescriptor(), "builtin").descriptor;

test("① 我方消息绝不算「对方回话」：newIncoming 只收方向 in 的新消息", () => {
  const result = mapRows(FACTS.rows, DESCRIPTOR, []);
  assert.ok(result.newIncoming.length >= 1);
  for (const message of result.newIncoming) assert.equal(message.direction, "in");
  // 我方那条必须出现在 newOutgoing，而不是 newIncoming（现场 BUG：自己回自己）
  assert.ok(result.newOutgoing.some((m) => m.id === "k:data-id:false_1a2b3c4d5e6f"));
  assert.ok(!result.newIncoming.some((m) => m.id === "k:data-id:false_1a2b3c4d5e6f"));
  assert.equal(hasIncomingReply(result), true);
});

test("② 附件/语音（有行无文本）也算「对方回了」，且**不取内容**", () => {
  const result = mapRows(FACTS.rows, DESCRIPTOR, []);
  const media = result.newIncoming.find((m) => m.kind === "media");
  assert.ok(media, "附件行必须算作 incoming（否则会把「回了图」记成「没回」去催）");
  assert.equal(media.text, "");
  assert.equal(media.id, "k:data-id:true_001122334455");
});

test("③ 站点显示时间戳一律不信：顺序只由行序决定", () => {
  const rows = [
    { ...FACTS.rows[1], rawId: "true_a1", text: "第一条", seenTs: "23:59" },
    { ...FACTS.rows[0], rawId: "false_b2", text: "第二条", seenTs: "00:01" },
  ];
  const result = mapRows(rows, DESCRIPTOR, []);
  assert.deepEqual(
    result.messages.map((m) => m.text),
    ["第一条", "第二条"],
  );
  // 时间戳只留痕，且绝不参与回访计算（回访用我方观测时间）
  assert.equal(result.messages[0].ts, "23:59");
});

test("排除行整条跳过（系统消息 / 日期分隔 / 端到端加密提示）", () => {
  const result = mapRows(FACTS.rows, DESCRIPTOR, []);
  assert.ok(!result.messages.some((m) => m.text.includes("系统消息")));
});

test("撤回：不进 incoming/outgoing，但已知 id 时进 edited（不能继续拿旧文本当记忆）", () => {
  const retractedRow = FACTS.rows[4]; // retracted: true
  assert.equal(retractedRow.retracted, true);
  const previous = mapRows(
    [{ ...retractedRow, retracted: false, text: "撤回前的内容" }],
    DESCRIPTOR,
    [],
  ).messages;
  const result = mapRows([retractedRow], DESCRIPTOR, previous);
  assert.equal(result.newIncoming.length, 0);
  assert.equal(result.newOutgoing.length, 0);
  assert.equal(result.edited.length, 1);
  assert.equal(result.edited[0].kind, "retracted");
  assert.equal(result.edited[0].text, "");
});

test("编辑：id 不变、内容版本变 → 进 edited，不算新消息", () => {
  const stableId = "true_abcdef123456";
  const before = mapRows([{ ...FACTS.rows[1], rawId: stableId, text: "原话" }], DESCRIPTOR, []).messages;
  const after = mapRows([{ ...FACTS.rows[1], rawId: stableId, text: "改过的话" }], DESCRIPTOR, before);
  assert.equal(after.newIncoming.length, 0);
  assert.equal(after.newOutgoing.length, 0);
  assert.equal(after.edited.length, 1);
  assert.notEqual(before[0].contentVersion, after.edited[0].contentVersion);
  assert.equal(before[0].id, after.edited[0].id);
});

test("方向 unknown 不进 incoming（fail-closed：分不出来就不当回话）", () => {
  // 无前缀、无图标、几何居中且 token 无方向语义 → unknown
  const rows = [{ ...FACTS.rows[1], rawId: null, tailIcon: null, checkIcon: false, cxRatio: 0.5, tokens: [] }];
  const result = mapRows(rows, DESCRIPTOR, []);
  assert.equal(result.messages[0].direction, "unknown");
  assert.equal(result.newIncoming.length, 0);
  assert.equal(hasIncomingReply(result), false);
});

test("方向回退顺序：前缀 → 尾巴图标 → 勾号图标 → 几何", () => {
  const prefixWins = mapRows(
    [{ ...FACTS.rows[1], rawId: "false_ff", tailIcon: "in", checkIcon: false, cxRatio: 0.1 }],
    DESCRIPTOR,
    [],
  );
  assert.equal(prefixWins.messages[0].direction, "out");

  const tailNext = mapRows(
    [{ ...FACTS.rows[1], rawId: null, tailIcon: "in", checkIcon: false, cxRatio: 0.9 }],
    DESCRIPTOR,
    [],
  );
  assert.equal(tailNext.messages[0].direction, "in");

  const checkNext = mapRows(
    [{ ...FACTS.rows[1], rawId: null, tailIcon: null, checkIcon: true, cxRatio: 0.1 }],
    DESCRIPTOR,
    [],
  );
  assert.equal(checkNext.messages[0].direction, "out");

  const geometryLast = mapRows(
    [{ ...FACTS.rows[1], rawId: null, tailIcon: null, checkIcon: false, cxRatio: 0.95, tokens: [] }],
    DESCRIPTOR,
    [],
  );
  assert.equal(geometryLast.messages[0].direction, "out");
});

test("id 形态过滤：不在 accept 里的 id 退回内容指纹（stableId=false）", () => {
  const rows = [
    { ...FACTS.rows[1], rawId: "不是被接受形态" },
    { ...FACTS.rows[1], rawId: "true_abcdef123456", text: "同文" },
    { ...FACTS.rows[1], rawId: "true_abcdef123456", text: "同文" },
  ];
  const result = mapRows(rows, DESCRIPTOR, []);
  assert.equal(result.messages[0].stableId, false);
  assert.ok(result.messages[0].id.startsWith("t:"));
  // 同一 id 的行在一轮里只计一次（幂等），不会变成两条
  assert.equal(result.messages.length, 2);
  assert.equal(isAcceptableRowId(DESCRIPTOR, "true_abcdef123456"), true);
  assert.equal(isAcceptableRowId(DESCRIPTOR, "不是被接受形态"), false);
  assert.deepEqual(splitRowKey("data-id:false_1"), { attr: "data-id", value: "false_1" });
  assert.equal(splitRowKey("no-colon"), null);
});

test("幂等：同一快照连读两次，新增/编辑全为空（不会重复计数）", () => {
  const first = mapRows(FACTS.rows, DESCRIPTOR, []);
  const second = mapRows(FACTS.rows, DESCRIPTOR, first.messages);
  assert.equal(second.newIncoming.length, 0);
  assert.equal(second.newOutgoing.length, 0);
  assert.equal(second.edited.length, 0);
  assert.equal(hasIncomingReply(second), false);
});

test("无方向手段的描述符必须被前置拦下（hasDirectionEvidence=false）", () => {
  const raw = validDescriptor();
  raw.rows.idPrefixDirection = null;
  raw.rows.thenTailIcons = null;
  raw.rows.thenCheckIcons = null;
  const { descriptor } = parseDescriptor(raw, "builtin");
  assert.equal(hasDirectionEvidence(descriptor), false);
  assert.equal(hasDirectionEvidence(DESCRIPTOR), true);
});

test("diffSnapshot 与 mapRows 共用同一套口径（不做第二份）", () => {
  const result = mapRows(FACTS.rows, DESCRIPTOR, []);
  const diff = diffSnapshot(result.messages, []);
  assert.deepEqual(
    diff.newIncoming.map((m) => m.id),
    result.newIncoming.map((m) => m.id),
  );
  assert.equal(contentVersionOf("text", "abc"), contentVersionOf("text", "abc"));
});

test("通用读取器快照：用描述符的 id 前缀把方向钉准（不需要 DOM）", () => {
  const messages = [
    { id: "k:data-id:false_zzz", direction: "in", text: "<我方>", ts: null, identity: null, stableId: true },
    { id: "k:data-id:true_yyy", direction: "out", text: "<对方>", ts: null, identity: null, stableId: true },
    { id: "t:other", direction: "in", text: "<无稳定 id>", ts: null, identity: null, stableId: false },
  ];
  const upgraded = upgradeDirections(messages, DESCRIPTOR);
  assert.equal(upgraded[0].direction, "out");
  assert.equal(upgraded[1].direction, "in");
  assert.equal(upgraded[2].direction, "in");

  const result = snapshotFromMessages(messages, DESCRIPTOR, []);
  assert.equal(result.newIncoming.length, 2);
  assert.equal(result.newOutgoing.length, 1);
  // 没有描述符时不升级方向（通用模式行为不变）
  const plain = snapshotFromMessages(messages, null, []);
  assert.equal(plain.newIncoming.length, 2);
  assert.equal(plain.messages[0].direction, "in");
});

/* ————————————————————————— D. 熔断 ————————————————————————— */

test("learned：形状不匹配先试一次结构重映射，仍失败即停用", () => {
  let health = newConnectorHealth("x");
  const first = recordHealthOutcome(health, { kind: "shape_mismatch" }, "t1", "learned");
  assert.equal(first.action, "remap");
  assert.equal(first.health.disabled, false);
  health = first.health;

  const second = recordHealthOutcome(health, { kind: "shape_mismatch" }, "t2", "learned");
  assert.equal(second.action, "disabled");
  assert.equal(second.health.disabled, true);
  assert.equal(isConnectorUsable(second.health), false);
  assert.match(second.reason, /回落通用模式/);
});

test("learned：普通错误连续 3 次才停用，成功即清零", () => {
  let health = newConnectorHealth("x");
  for (let i = 1; i <= 2; i += 1) {
    const decision = recordHealthOutcome(health, { kind: "error", reason: "boom" }, `t${i}`, "learned");
    assert.equal(decision.action, "ok");
    health = decision.health;
  }
  health = recordHealthOutcome(health, { kind: "ok" }, "t3", "learned").health;
  assert.equal(health.consecutiveFailures, 0);

  for (let i = 0; i < 2; i += 1) {
    health = recordHealthOutcome(health, { kind: "error", reason: "boom" }, `t${i}`, "learned").health;
  }
  const last = recordHealthOutcome(health, { kind: "error", reason: "boom" }, "t9", "learned");
  assert.equal(last.action, "disabled");
});

test("builtin：只报错、绝不自动停用（人手写的文件不该被运行时悄悄关掉）", () => {
  let health = newConnectorHealth("b");
  for (let i = 0; i < 5; i += 1) {
    const decision = recordHealthOutcome(health, { kind: "shape_mismatch", reason: "改版了" }, `t${i}`, "builtin");
    assert.equal(decision.action, "ok");
    assert.equal(decision.health.disabled, false);
    assert.match(decision.reason, /请修描述符/);
    health = decision.health;
  }
});

test("重新启用：清停用标记与疲劳，但保留累计计数", () => {
  let health = recordHealthOutcome(newConnectorHealth("x"), { kind: "shape_mismatch" }, "t", "learned").health;
  health = recordHealthOutcome(health, { kind: "shape_mismatch" }, "t2", "learned").health;
  assert.equal(health.disabled, true);

  const revived = reenableConnector(health);
  assert.equal(revived.disabled, false);
  assert.equal(revived.consecutiveFailures, 0);
  assert.equal(revived.totalFail, 2);
});

/* ————————————————————————— E. 注册表与选站 ————————————————————————— */

test("选站优先级：learned > builtin；同源取版本高者", () => {
  const builtin = { source: "builtin", path: "b.json", descriptor: { ...DESCRIPTOR, source: "builtin", version: 1 } };
  const learned = { source: "learned", path: "l.json", descriptor: { ...DESCRIPTOR, source: "learned", version: 2 } };
  const url = "https://sample-im.example/k/";

  assert.equal(pickDescriptor([builtin], url).source, "builtin");
  assert.equal(pickDescriptor([builtin, learned], url).source, "learned");

  const higher = { source: "builtin", path: "b2.json", descriptor: { ...DESCRIPTOR, version: 9 } };
  assert.equal(pickDescriptor([builtin, higher], url).path, "b2.json");

  assert.equal(pickDescriptor([builtin], "https://other.example/"), null);
});

test("被熔断的描述符不被选中 → 返回 null 即「回落通用模式」", () => {
  const builtin = { source: "builtin", path: "b.json", descriptor: { ...DESCRIPTOR, source: "builtin" } };
  const url = "https://sample-im.example/k/";
  const health = { ...newConnectorHealth("sample-im"), disabled: true };
  assert.equal(pickDescriptor([builtin], url, { healthOf: () => health }), null);
  assert.ok(pickDescriptor([builtin], url, { healthOf: () => ({ ...health, disabled: false }) }));
});

test("加载：learned 覆盖同 id 的 builtin（并留诊断，不静默）", () => {
  const result = loadDescriptorDirs({ builtinDirs: [BUILTIN_DIR], learnedDirs: [LEARNED_DIR] });
  assert.equal(result.descriptors.length, 1);
  const only = result.descriptors[0];
  assert.equal(only.source, "learned");
  assert.equal(only.descriptor.version, 2);
  assert.ok(result.diagnostics.some((d) => d.code === "learned_overrides_builtin"));
});

test("加载：同源同 id 重复 → 报错并保留先出现者", () => {
  const entries = [
    { source: "builtin", path: "a.json", raw: validDescriptor() },
    { source: "builtin", path: "b.json", raw: validDescriptor() },
  ];
  const result = parseDescriptorEntries(entries);
  assert.equal(result.descriptors.length, 1);
  assert.ok(result.diagnostics.some((d) => d.code === "duplicate_id"));
});

test("加载：坏文件只报错不拖垮其它描述符，且目录缺失如实上报（不静默）", () => {
  const bad = loadDescriptorDirs({ builtinDirs: [BAD_DIR], learnedDirs: [] });
  assert.equal(bad.descriptors.length, 0);
  assert.equal(bad.diagnostics.filter((d) => d.code === "script_like").length, 1);
  assert.equal(bad.diagnostics.filter((d) => d.code === "unknown_key").length, 2);

  const missing = loadDescriptorDirs({ builtinDirs: [join(FIXTURES, "nope")], learnedDirs: [] });
  assert.equal(missing.descriptors.length, 0);
  assert.ok(missing.diagnostics.some((d) => d.code === "dir_missing"));
});

test("列表项如实标注来源/版本/能力（降级要能看出来）", () => {
  const { descriptors } = loadDescriptorDirs({ builtinDirs: [BUILTIN_DIR], learnedDirs: [] });
  const items = listDescriptorItems(descriptors, () => ({ ...newConnectorHealth("sample-im"), disabled: true }));
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "builtin");
  assert.equal(items[0].hostPattern, "(^|\\.)sample-im\\.example$");
  assert.equal(items[0].capabilities.send, true);
  assert.equal(items[0].capabilities.history, true);
  assert.equal(items[0].health.disabled, true);
  // P1 还没有页内事件订阅，如实标 false（不许假装有）
  assert.equal(items[0].capabilities.subscribe, false);
});

/* ————————————————————————— F. R4 源码级断言 ————————————————————————— */

function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walkJs(path));
    else if (name.endsWith(".js")) out.push(path);
  }
  return out;
}

test("R4：聊天核心与描述符层零站点字面量（加站点=加描述符，不是改代码）", () => {
  const distRoot = join(HERE, "..", "dist", "core", "web_chat");
  const files = walkJs(distRoot);
  assert.ok(files.length >= 8, "应当能扫到编译后的聊天核心文件");

  // 用带边界的正则：短域名（t.me）会误伤 `snapshot.messages` 这类标识符
  const siteLiterals = [
    /web\.telegram\.org/,
    /whatsapp/,
    /(^|[^\w.])t\.me([^\w]|$)/,
    /messenger\.com/,
    /discord\.com/,
    /line\.me/,
    /zalo\.me/,
    /wechat/,
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const pattern of siteLiterals) {
      assert.ok(!pattern.test(text), `${file} 含站点字面量 ${pattern}（应下沉到描述符 JSON）`);
    }
  }
});

test("R8：描述符层零动态求值（没有 eval / new Function）", () => {
  const descriptorDist = join(HERE, "..", "dist", "core", "web_chat", "descriptor");
  for (const file of walkJs(descriptorDist)) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/\beval\s*\(/.test(text), `${file} 出现 eval（R8 明令禁止）`);
    assert.ok(!/new\s+Function\s*\(/.test(text), `${file} 出现 new Function（R8 明令禁止）`);
  }
});

test("R8③：页内哨兵的销毁钩子必须真的有调用方（装备了没人调 = 假护栏）", () => {
  // 现场教训：装配层声明了 `registerDispose`，宿主 `chat_start` 却没传 ——
  // 结果是「观察器/监听器成对销毁」只剩 abort 后的 5s 兜底，正常收尾时会**留在用户的标签里**。
  const indexDist = readFileSync(join(HERE, "..", "dist", "index.js"), "utf8");
  assert.ok(
    indexDist.includes("registerDispose"),
    "宿主侧 chat_start 必须把 registerDispose 传进 buildChatSession（否则页内哨兵不释放）",
  );
  const sessionSrc = readFileSync(join(HERE, "..", "src", "bu_agent", "chat_session.ts"), "utf8");
  assert.ok(
    sessionSrc.includes("registerDispose?.(disposeConnector)"),
    "会话装配层必须把销毁钩子登记给调用方（成对销毁）",
  );
});

test("R8：会话列表采集层是纯读（不许出现点击 / 导航 / 滚屏）", () => {
  // 会话列表只用来「给用户勾选对象」，采集本身必须**零副作用**：
  // 一次误点就等于替用户打开了别人的会话（进未读、发已读回执），后续还可能被当成「用户意图」。
  const text = readFileSync(
    join(HERE, "..", "dist", "core", "web_chat", "descriptor", "threads.js"),
    "utf8",
  );
  for (const banned of [
    ".click(",
    ".goto(",
    ".hover(",
    ".type(",
    ".defineSelector(",
    ".fill(",
    ".press(",
    "scrollIntoView",
    "scrollTo",
    "scrollBy",
  ]) {
    assert.ok(!text.includes(banned), `threads.ts 出现 ${banned}（会话列表采集必须是纯读）`);
  }
  assert.ok(text.includes("evaluate"), "采集只能走只读求值");
});

test("通用模式兜底配置仍在（回落必须有处可落）", () => {
  const policy = JSON.parse(
    readFileSync(join(HERE, "..", "config", "chat_sites.json"), "utf8"),
  );
  assert.ok(Array.isArray(policy.sites));
  assert.ok(policy.defaults && policy.defaults.thresholds);
});

/* ————————————————————————— G. 通用模式连接器（无描述符也能跑） ————————————————————————— */

function fakePage({ url = "https://sample-im.example/k/", items = [], facts = null } = {}) {
  return {
    url: () => url,
    async evaluate(fn, arg) {
      // ① 描述符模式的页内事实采集（入参带 containerSelector）
      if (arg && typeof arg === "object" && "containerSelector" in arg) {
        if (facts) return facts;
        // 没给事实夹具时：**如实报「容器里没东西」**，而不是假装采到空列表
        return { ok: true, reason: null, rows: [], moreAbove: false, fallbackPoll: false };
      }
      // ② 通用模式的会话读取（`readConversation` 唯一的页内调用，入参带 selector）
      if (arg && typeof arg === "object" && "selector" in arg) {
        return {
          ok: true,
          reason: items.length === 0 ? "empty" : null,
          items,
          scrollTop: 0,
          scrollHeight: 400,
          clientHeight: 400,
          atBottom: true,
        };
      }
      return null;
    },
  };
}

test("通用模式：没有描述符也能读，方向仍进 newIncoming / newOutgoing（结构性修掉「自己回自己」）", async () => {
  const page = fakePage({
    items: [
      { key: "data-id:false_aaa", text: "<我方刚发的>", cxRatio: 0.9, tokens: [], ts: null, identity: null },
      { key: "data-id:true_bbb", text: "<对方回话>", cxRatio: 0.1, tokens: [], ts: null, identity: null },
    ],
  });
  const connector = createDomConnector({ page, descriptor: null, initialContainerSelector: "#thread" });
  assert.equal(connector.kind, "generic");
  assert.equal(connector.id, "generic-dom");
  assert.equal(connector.descriptorVersion, null);

  const contact = { label: "某人", url: null };
  const first = await connector.readThread(contact, {
    loadHistory: false,
    previous: [],
    signal: new AbortController().signal,
  });
  assert.equal(first.ok, true);
  assert.equal(first.messages.length, 2);
  assert.equal(first.newOutgoing.length, 1);
  assert.equal(first.newIncoming.length, 1);
  assert.equal(first.newIncoming[0].text, "<对方回话>");

  const second = await connector.readThread(contact, {
    loadHistory: false,
    previous: first.messages,
    signal: new AbortController().signal,
  });
  assert.equal(second.newIncoming.length, 0);
  assert.equal(second.newOutgoing.length, 0);
});

test("描述符模式：用 id 前缀把方向钉准（几何判错也不怕），且能看见附件/撤回", async () => {
  // 描述符存在时读的是**事实包**（比通用读取器多看见附件/撤回/引用剔除）
  const page = fakePage({
    facts: {
      ok: true,
      reason: null,
      moreAbove: false,
      fallbackPoll: false,
      rows: [
        // 几何看起来像对方（靠左），但 id 前缀 `false_` 说明是我方 —— 前缀必须赢
        {
          rawId: "false_ccc111222333",
          text: "<我方>",
          hasMedia: false,
          excluded: false,
          retracted: false,
          tailIcon: null,
          checkIcon: false,
          cxRatio: 0.1,
          tokens: ["msg-row"],
          seenTs: "12:31",
          identity: null,
        },
        // 对方发来的**图片**：没有文字，但**仍然是「对方回话」**
        {
          rawId: "true_ddd444555666",
          text: "",
          hasMedia: true,
          excluded: false,
          retracted: false,
          tailIcon: null,
          checkIcon: false,
          cxRatio: 0.12,
          tokens: ["msg-row"],
          seenTs: "12:32",
          identity: null,
        },
        // 撤回：id 还在，但**不算**「对方说了新话」
        {
          rawId: "true_eee777888999",
          text: "",
          hasMedia: false,
          excluded: false,
          retracted: true,
          tailIcon: null,
          checkIcon: false,
          cxRatio: 0.14,
          tokens: ["msg-row"],
          seenTs: "12:33",
          identity: null,
        },
      ],
    },
  });
  const connector = createDomConnector({
    page,
    descriptor: { source: "builtin", path: "fixture", descriptor: DESCRIPTOR },
    initialContainerSelector: "#thread",
  });
  assert.equal(connector.kind, "builtin");
  assert.equal(connector.descriptorVersion, 1);

  const result = await connector.readThread(
    { label: "某人", url: null },
    { loadHistory: false, previous: [], signal: new AbortController().signal },
  );
  assert.equal(result.ok, true);
  assert.equal(result.newOutgoing.length, 1, "id 前缀 false_ = 我方（几何靠左也改不了）");
  assert.equal(result.newIncoming.length, 1, "附件行（无文字）仍算对方回话");
  assert.equal(result.newIncoming[0].kind, "media");
  const retracted = result.messages.find((m) => m.kind === "retracted");
  assert.ok(retracted, "撤回行要看得见（只是不进 incoming）");
  assert.ok(!result.newIncoming.includes(retracted), "撤回不是「对方说了新话」");
});

test("通用模式：容器未知时如实失败（不新开、不猜）", async () => {
  const connector = createDomConnector({ page: fakePage(), descriptor: null });
  const result = await connector.readThread(
    { label: "某人", url: null },
    { loadHistory: false, previous: [], signal: new AbortController().signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "container_missing");
});

/* ————————————————————————— I. 内置描述符：whatsapp-web（保真基准） ————————————————————————— */

const REAL_CONNECTORS_DIR = join(HERE, "..", "connectors");
const REAL_LOAD = loadDescriptorDirs({ builtinDirs: [REAL_CONNECTORS_DIR], learnedDirs: [] });
const WHATSAPP = REAL_LOAD.descriptors.find((item) => item.descriptor.id === "whatsapp-web") ?? null;
const WHATSAPP_DESCRIPTOR = WHATSAPP ? WHATSAPP.descriptor : null;
const WHATSAPP_FACTS = JSON.parse(
  readFileSync(join(BUILTIN_DIR, "facts", "whatsapp-web.rows.json"), "utf8"),
);
const WHATSAPP_URL = "https://web.whatsapp.com/send?phone=15551230001";

test("真实内置描述符（sidecar/connectors/）零诊断，whatsapp-web 在列", () => {
  assert.deepEqual(REAL_LOAD.diagnostics, [], "内置描述符必须全部通过严格校验（否则静默降级成通用模式）");
  assert.ok(WHATSAPP, "sidecar/connectors/whatsapp-web.json 必须存在且可用");
  assert.equal(WHATSAPP.source, "builtin");
  assert.equal(WHATSAPP_DESCRIPTOR.version, 1);
});

test("whatsapp-web：host 精确匹配（不做子串误伤），二维码/登录页快速失败", () => {
  assert.equal(pickDescriptor(REAL_LOAD.descriptors, WHATSAPP_URL).descriptor.id, "whatsapp-web");
  assert.equal(pickDescriptor(REAL_LOAD.descriptors, "https://web.whatsapp.com/").descriptor.id, "whatsapp-web");
  assert.equal(pickDescriptor(REAL_LOAD.descriptors, "https://whatsapp.com/"), null);
  assert.equal(pickDescriptor(REAL_LOAD.descriptors, "https://faq.whatsapp.com/web"), null);
  assert.equal(pickDescriptor(REAL_LOAD.descriptors, "https://web.whatsapp.com.evil.example/"), null);

  // 就绪判定的第一条是**会话容器**（顺序有意义：否则会把左侧会话列表当成聊天记录来读）
  assert.equal(WHATSAPP_DESCRIPTOR.ready.allOf[0], "#main");
  assert.ok(WHATSAPP_DESCRIPTOR.ready.allOf.includes("#pane-side"), "登录态旁证必须在 allOf 里");
  assert.ok(
    WHATSAPP_DESCRIPTOR.ready.absent.some((selector) => /Scan/.test(selector)),
    "二维码画布必须在 absent（扫码头等下去不会变好）",
  );
  assert.ok(
    WHATSAPP_DESCRIPTOR.ready.absent.some((selector) => selector.includes("qrcode")),
    "二维码容器必须在 absent",
  );
});

test("whatsapp-web：两代 id 形态都接受，其它形态退回内容指纹", () => {
  const descriptor = WHATSAPP_DESCRIPTOR;
  assert.equal(isAcceptableRowId(descriptor, "false_15551230001@c.us_3EB0A1B2C3D4E5F6A7B8"), true);
  assert.equal(isAcceptableRowId(descriptor, "true_120363012345678901@g.us_3EB0B2C3D4E5F6A7B8C9"), true);
  assert.equal(isAcceptableRowId(descriptor, "3EB0C767D0E0F3B1A2C4D5E6F7081920"), true);
  assert.equal(isAcceptableRowId(descriptor, "msg-temp-1"), false);
  assert.equal(hasDirectionEvidence(descriptor), true);
});

test("whatsapp-web：方向回退顺序 = id 前缀 → 尾巴图标 → 勾号图标 → 几何", () => {
  const descriptor = WHATSAPP_DESCRIPTOR;

  // ① 旧代前缀压过图标与几何（靠左、带对方尾巴、带勾号，都改不了「我方」）
  const legacyOut = { ...WHATSAPP_FACTS.rows[0], tailIcon: "in", checkIcon: true, cxRatio: 0.05 };
  assert.ok(WHATSAPP_FACTS.rows[0].cxRatio < 0.42, "夹具刻意把这一步的几何放在「对方侧」");
  assert.equal(mapRows([legacyOut], descriptor, []).messages[0].direction, "out");
  const legacyIn = { ...WHATSAPP_FACTS.rows[1], tailIcon: "out", checkIcon: true, cxRatio: 0.95 };
  assert.equal(mapRows([legacyIn], descriptor, []).messages[0].direction, "in");

  const group = mapRows([WHATSAPP_FACTS.rows[1]], descriptor, []);
  assert.equal(group.messages[0].direction, "in", "群 JID（@g.us）同样被接受");
  assert.equal(group.messages[0].identity, "群成员昵称");

  // ② 新代裸 id 没有前缀：靠尾巴图标 / 勾号图标
  const checkOut = WHATSAPP_FACTS.rows[2];
  assert.equal(mapRows([checkOut], descriptor, []).messages[0].direction, "out", "勾号 = 我方");
  const tailIn = WHATSAPP_FACTS.rows[3];
  assert.equal(mapRows([tailIn], descriptor, []).messages[0].direction, "in", "尾巴 = 对方");

  // ③ 两代都没有方向证据 → unknown（fail-closed：分不出方向就不当回话）
  const unknown = mapRows([WHATSAPP_FACTS.rows[7]], descriptor, []);
  assert.equal(unknown.messages[0].direction, "unknown");
  assert.equal(unknown.newIncoming.length, 0);
  assert.equal(unknown.newOutgoing.length, 0);
});

test("whatsapp-web：附件行算「对方回了」但不取内容；撤回/系统消息都不算新话", () => {
  const descriptor = WHATSAPP_DESCRIPTOR;

  const media = mapRows([WHATSAPP_FACTS.rows[4]], descriptor, []);
  assert.equal(media.newIncoming.length, 1, "对方发来一张图不能被记成「没回」");
  assert.equal(media.messages[0].kind, "media");
  assert.equal(media.messages[0].text, "", "附件只记「有内容」，绝不取内容（B7/R2）");

  const retracted = WHATSAPP_FACTS.rows[5];
  const before = mapRows([{ ...retracted, retracted: false, text: "<撤回前的原话>" }], descriptor, []).messages;
  const after = mapRows([retracted], descriptor, before);
  assert.equal(after.newIncoming.length, 0);
  assert.equal(after.newOutgoing.length, 0);
  assert.equal(after.edited.length, 1, "撤回是状态变化（要更新记忆），不是新消息");
  assert.equal(after.edited[0].kind, "retracted");

  const all = mapRows(WHATSAPP_FACTS.rows, descriptor, []);
  assert.ok(!all.messages.some((m) => m.text.includes("系统消息")), "系统消息整条跳过");
});

test("whatsapp-web：整包映射口径 + 幂等（同一快照连读两次不新增）", () => {
  const first = mapRows(WHATSAPP_FACTS.rows, WHATSAPP_DESCRIPTOR, []);
  assert.equal(first.newOutgoing.length, 2, "我方：旧代前缀 1 条 + 新代勾号 1 条");
  assert.equal(first.newIncoming.length, 4, "对方：旧代群 1 + 新代尾巴 2（含附件）+ 无稳定 id 1");
  assert.equal(first.messages.filter((m) => m.direction === "unknown").length, 1);
  assert.equal(hasIncomingReply(first), true);

  const fingerprint = first.messages.find((m) => m.text.includes("无稳定 id"));
  assert.ok(fingerprint, "无稳定 id 的那条仍要进会话（只是 id 不可靠）");
  assert.equal(fingerprint.stableId, false);
  assert.ok(fingerprint.id.startsWith("t:"));

  const second = mapRows(WHATSAPP_FACTS.rows, WHATSAPP_DESCRIPTOR, first.messages);
  assert.equal(second.newIncoming.length, 0);
  assert.equal(second.newOutgoing.length, 0);
  assert.equal(second.edited.length, 0);
});

test("whatsapp-web：出站只走输入框（等值校验 fail-closed），且候选不许落到搜索框", () => {
  const composer = WHATSAPP_DESCRIPTOR.composer;
  assert.equal(composer.input.method, "selectAllBeforeInput", "Lexical composer 的可靠写法");
  assert.equal(composer.input.verify, "equals");
  assert.equal(composer.input.failClosed, true);
  assert.equal(composer.send.method, "enterOnce");
  assert.equal(composer.send.elseClick, true);

  for (const selector of composer.selectors) {
    assert.ok(
      selector.startsWith("#main"),
      `${selector} 必须以 #main 为界 —— 免得把消息打进左上角的搜索框`,
    );
  }
  assert.equal(
    WHATSAPP_DESCRIPTOR.presence.typing.length,
    0,
    "保真基准里没有 typing 判据：不许凭空编一个选择器（编了就可能是假的）",
  );
  assert.equal(
    WHATSAPP_DESCRIPTOR.rows.insertedAtTopMeansOlder,
    false,
    "WhatsApp 新消息追加在底部（写错会让历史合并方向弄反）",
  );
});

test("whatsapp 夹具必须覆盖两代 id 与关键行形态（否则测不出方向回退）", () => {
  const rawIds = WHATSAPP_FACTS.rows.map((row) => row.rawId).filter((value) => typeof value === "string");
  assert.ok(rawIds.some((id) => /^(?:true|false)_/.test(id)), "缺少旧代前缀 id（false_/true_ + JID）");
  assert.ok(rawIds.some((id) => /^[0-9A-F]{12,}$/.test(id)), "缺少新代裸 hex id（只能靠图标判方向）");
  assert.ok(WHATSAPP_FACTS.rows.some((row) => row.hasMedia), "缺少附件行");
  assert.ok(WHATSAPP_FACTS.rows.some((row) => row.retracted), "缺少撤回行");
  assert.ok(WHATSAPP_FACTS.rows.some((row) => row.excluded), "缺少系统消息行");
  assert.ok(
    WHATSAPP_FACTS.rows.some((row) => row.rawId === null || !/^(?:true|false)_/.test(row.rawId)),
    "缺少「无可用站点 id」行（内容指纹兜底路径）",
  );
});

/* ————————————————————————— J. 多站点内置描述符（表格驱动：加站点不改测试骨架） ————————————————————————— */

const FACT_FIXTURE_DIR = join(BUILTIN_DIR, "facts");
const THREADS_FIXTURE_DIR = join(BUILTIN_DIR, "threads");

/**
 * 加一个站点 = 加一行（+ 两份夹具），**不要**在这里写站点专属逻辑。
 *
 * `counts` 是「这一份夹具按这一份描述符读出来应当是什么」的口径锁：
 * 方向靠 id / 图标 / 几何回退，附件算回话，撤回与系统消息不算。
 */
const SITE_CASES = [
  {
    id: "whatsapp-web",
    url: "https://web.whatsapp.com/",
    /** 这些地址**不该**被选中（别的站或裸域名 → 通用模式） */
    notThis: ["https://whatsapp.com/", "https://web.whatsapp.com.evil.example/"],
    counts: { out: 2, in: 4, unknown: 1, media: 1, retracted: 1 },
    threads: { total: 3, withUrl: 0, unread: 1 },
  },
  {
    id: "telegram-web-k",
    url: "https://web.telegram.org/k/#-1001234567890",
    notThis: [
      "https://web.telegram.org/",
      "https://web.telegram.org/z/",
      "https://web.telegram.org/a/",
    ],
    counts: { out: 1, in: 2, unknown: 1, media: 1, retracted: 1 },
    threads: { total: 4, withUrl: 3, unread: 1 },
  },
  {
    id: "telegram-web-a",
    url: "https://web.telegram.org/a/",
    notThis: [
      "https://web.telegram.org/",
      "https://web.telegram.org/z/",
      "https://web.telegram.org/k/",
    ],
    counts: { out: 1, in: 2, unknown: 1, media: 1, retracted: 1 },
    threads: { total: 3, withUrl: 0, unread: 1 },
  },
];

function descriptorOf(id) {
  const loaded = REAL_LOAD.descriptors.find((item) => item.descriptor.id === id);
  assert.ok(loaded, `内置描述符 ${id} 必须存在且通过严格校验`);
  return loaded;
}

for (const site of SITE_CASES) {
  test(`内置描述符 ${site.id}：命中该站、不误伤别站、方向手段齐备`, () => {
    const loaded = descriptorOf(site.id);
    assert.equal(pickDescriptor(REAL_LOAD.descriptors, site.url).descriptor.id, site.id);
    for (const url of site.notThis) {
      const picked = pickDescriptor(REAL_LOAD.descriptors, url);
      assert.notEqual(picked?.descriptor.id, site.id, `${url} 不该命中 ${site.id}`);
    }
    assert.equal(
      pickDescriptor(REAL_LOAD.descriptors, "https://web.telegram.org/"),
      null,
      "legacy WebZ 没有描述符 → 如实回落通用模式（不硬撑）",
    );
    assert.ok(loaded.descriptor.ready.allOf.length >= 2, "就绪门禁至少要「会话容器 + 登录态旁证」");
    assert.ok(hasDirectionEvidence(loaded.descriptor), "必须有方向手段，否则永远判不出「对方回话」");
    assert.ok(loaded.descriptor.rows.id, "必须声明稳定 id 形态（否则只能靠内容指纹）");
  });

  test(`内置描述符 ${site.id}：夹具口径一致（我方/对方/附件/撤回）`, () => {
    const loaded = descriptorOf(site.id);
    const facts = JSON.parse(readFileSync(join(FACT_FIXTURE_DIR, `${site.id}.rows.json`), "utf8"));
    const mapped = mapRows(facts.rows, loaded.descriptor, []);
    assert.equal(mapped.newOutgoing.length, site.counts.out, "我方消息数");
    assert.equal(mapped.newIncoming.length, site.counts.in, "对方回话数（附件行也算）");
    assert.equal(mapped.messages.filter((m) => m.direction === "unknown").length, site.counts.unknown);
    assert.equal(mapped.messages.filter((m) => m.kind === "media").length, site.counts.media);
    assert.equal(mapped.messages.filter((m) => m.kind === "retracted").length, site.counts.retracted);
    assert.ok(
      !mapped.messages.some((m) => m.text.includes("服务消息") || m.text.includes("系统消息")),
      "被 exclude 的行整条跳过",
    );
    assert.equal(
      mapped.newIncoming.filter((m) => m.kind === "retracted").length,
      0,
      "撤回不是「对方说了新话」",
    );

    // 幂等：同一份夹具连读两次不新增（跨片、跨重启的对账基础）
    const second = mapRows(facts.rows, loaded.descriptor, mapped.messages);
    assert.equal(second.newIncoming.length, 0);
    assert.equal(second.newOutgoing.length, 0);
  });

  test(`会话列表 ${site.id}：候选 → 视图项（绝对地址 / 去重 / 身份稳定）`, () => {
    const loaded = descriptorOf(site.id);
    assert.ok(loaded.descriptor.threads, `${site.id} 必须声明 threads（否则视图只能走通用启发式）`);
    const probe = JSON.parse(readFileSync(join(THREADS_FIXTURE_DIR, `${site.id}.threads.json`), "utf8"));
    assert.equal(probe.source, "descriptor");
    const items = mapThreads(probe.items, {
      baseUrl: probe.baseUrl,
      limit: loaded.descriptor.threads.limit,
    });
    assert.equal(items.length, site.threads.total);
    assert.equal(items.filter((item) => item.url !== null).length, site.threads.withUrl);
    assert.equal(items.filter((item) => item.unread).length, site.threads.unread);
    assert.equal(new Set(items.map((item) => item.key)).size, items.length, "key 必须唯一（勾选与身份一一对应）");

    for (const item of items) {
      assert.ok(item.key && item.label, "key / label 都不能空");
      assert.ok(!/\s{2,}/.test(item.label), "展示名要归一化空白");
      if (item.url) {
        assert.ok(item.url.startsWith(probe.baseUrl), `${item.url} 必须是绝对地址`);
        assert.ok(!/^(javascript|mailto|tel|data|blob):/i.test(item.url), "危险协议不许进 url");
      }
    }
  });
}

test("会话列表：没写 threads 的站点如实报「没有声明」，而不是编一份选择器", () => {
  const withoutThreads = parseDescriptor(validDescriptor(), "builtin").descriptor;
  assert.equal(withoutThreads.threads, null);
  const items = listDescriptorItems(
    [{ source: "builtin", path: "x", descriptor: withoutThreads }],
    () => null,
  );
  assert.equal(items[0].capabilities.threads, false);
});

test("会话列表声明：未知字段 / 空选择器 / 越界 limit 一律拒绝（手误不被静默忽略）", () => {
  const base = () => ({
    itemSelectors: ["#list .row"],
    keyAttr: "data-peer-id",
    hrefAttr: null,
    labelSelectors: [".title"],
    unreadSelectors: [".unread"],
    limit: 50,
  });

  const unknownKey = validDescriptor();
  unknownKey.threads = { ...base(), magic: true };
  const unknownResult = parseDescriptor(unknownKey, "builtin");
  assert.equal(unknownResult.ok, false);
  assert.ok(unknownResult.diagnostics.some((d) => d.path === "/threads/magic"));

  const empty = validDescriptor();
  empty.threads = { ...base(), itemSelectors: [] };
  assert.equal(parseDescriptor(empty, "builtin").ok, false);

  const tooBig = validDescriptor();
  tooBig.threads = { ...base(), limit: 10_000 };
  assert.equal(parseDescriptor(tooBig, "builtin").ok, false);

  const ok = validDescriptor();
  ok.threads = base();
  const okResult = parseDescriptor(ok, "builtin");
  assert.equal(okResult.ok, true, JSON.stringify(okResult.diagnostics));
  assert.equal(okResult.descriptor.threads.limit, 50);
});

/* ————————————————————————— H. 夹具自检（夹具不许悄悄漂移） ————————————————————————— */

test("事实包夹具的字段名必须与 RowFact 契约一致（写错名字不会被静默忽略）", () => {
  const allowed = new Set([
    "rawId",
    "text",
    "hasMedia",
    "excluded",
    "retracted",
    "tailIcon",
    "checkIcon",
    "cxRatio",
    "tokens",
    "seenTs",
    "identity",
  ]);
  const files = readdirSync(join(BUILTIN_DIR, "facts")).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 2, "至少要有通用夹具与内置描述符夹具各一份");
  for (const name of files) {
    const pack = JSON.parse(readFileSync(join(BUILTIN_DIR, "facts", name), "utf8"));
    assert.ok(Array.isArray(pack.rows) && pack.rows.length >= 6, `${name} 应当覆盖多种行形态`);
    assert.equal(typeof pack.moreAbove, "boolean");
    assert.equal(typeof pack.fallbackPoll, "boolean");
    for (const [index, row] of pack.rows.entries()) {
      for (const key of Object.keys(row)) {
        assert.ok(allowed.has(key), `${name} rows[${index}] 出现未知字段 ${key}（契约里没有这个字段）`);
      }
      for (const key of allowed) {
        assert.ok(key in row, `${name} rows[${index}] 缺少字段 ${key}`);
      }
    }
  }
});
