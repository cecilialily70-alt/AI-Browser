/**
 * 发现流水线回归测试（P5）
 *
 * 运行：`npm run build && npm run test:chat`
 *
 * 覆盖：
 *   - 采集：结构化事实（**零正文**）、真值构造、拆分取样、失败如实记账、落盘脱敏
 *   - 推断：提示词**绝不含 HTML / 绝不含 heldOut 样本**、输出解析容错与拒绝
 *   - 自检：逐字段核对；**专门抓「有结果但不对」的静默失败**（方向写反 / 取错字段）
 *   - 编排：一轮通过 / 修正回路 / 到顶如实失败 / 模型出错不编草案 / 取消即中止
 *   - 写入自检：发送成功后**读回逐字核对**（回执早于结果的反面）
 *   - 落盘：描述符与元数据分文件（`_` 前缀不进描述符扫描）、存的东西自己能读回、导出为 builtin 候选
 *   - 决策记录：落在环境目录、只落指纹与判定、轮转有上限、坏行不毁整份
 *   - 花费：四栏、读取桶恒 0 token、只显示不停机
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseDescriptor } from "../dist/core/web_chat/descriptor/manifest.js";
import { contentVersionOf } from "../dist/core/web_chat/descriptor/map_rows.js";
import {
  PROBE_NODE_LIMIT,
  captureBundle,
  mapGenericThreads,
  redactCaptureForDisk,
  siteKeyOf,
  splitSamples,
  summarizeCapture,
  toOracleRows,
} from "../dist/core/web_chat/discovery/capture.js";
import {
  buildInferMessages,
  describeOracle,
  describeStructure,
  foldIdShape,
  parseInferResult,
} from "../dist/core/web_chat/discovery/infer.js";
import {
  compareThreads,
  formatVerifyReport,
  verifyDraft,
} from "../dist/core/web_chat/discovery/verify.js";
import {
  exportAsBuiltinCandidate,
  learnDescriptor,
  readLearnedMeta,
  removeLearnedDescriptor,
  saveLearnedDescriptor,
  verifySendRoundtrip,
} from "../dist/core/web_chat/discovery/learn.js";
import {
  appendDecision,
  listDecisionSegments,
  readDecisions,
} from "../dist/core/web_chat/discovery/decision.js";
import {
  addSlice,
  addThread,
  emptyLedger,
  formatMicroUsd,
  normalizeEntries,
  resetSlice,
  spendReport,
  totalsOf,
} from "../dist/core/web_chat/discovery/spend.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "connectors");
const GOOD_DESCRIPTOR = JSON.parse(readFileSync(join(FIXTURES, "sample-im.example.json"), "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "tst-discovery-"));
}

/* ————————————————————————— 夹具：真值行 ————————————————————————— */

/** 真值行（`expect` 与 `verify` 用的字段形状一致；测试里手写，避免依赖采集实现） */
function oracleRow(over = {}) {
  const text = over.text ?? "某句话";
  const direction = over.direction ?? "in";
  const mediaLike = over.mediaLike ?? false;
  return {
    rawId: over.rawId ?? null,
    text,
    hasMedia: mediaLike,
    excluded: over.systemLike === true,
    retracted: false,
    tailIcon: null,
    checkIcon: false,
    cxRatio: over.cxRatio ?? (direction === "out" ? 0.85 : 0.15),
    tokens: over.tokens ?? [],
    seenTs: null,
    identity: null,
    expect: {
      direction,
      contentVersion: contentVersionOf(mediaLike ? "media" : "text", text),
      mediaLike,
      systemLike: over.systemLike === true,
    },
  };
}

/** 一份「应当通过自检」的真值：我方/对方/附件/系统消息各一 */
function goodRows() {
  return [
    oracleRow({ rawId: "false_a1b2c3d4e5", text: "<我方一>", direction: "out" }),
    oracleRow({ rawId: "true_a1b2c3d4e6", text: "<对方一>", direction: "in" }),
    oracleRow({ rawId: "true_a1b2c3d4e7", text: "", direction: "in", mediaLike: true }),
  ];
}

/* ————————————————————————— A. 采集（纯函数） ————————————————————————— */

test("站点键：host 派生，去掉 www 与非法字符，且不含路径/账号", () => {
  assert.equal(siteKeyOf("web.whatsapp.com"), "whatsapp.com");
  assert.equal(siteKeyOf("Web.Telegram.ORG"), "telegram.org");
  assert.equal(siteKeyOf(""), "unknown");
  assert.ok(!siteKeyOf("chat.example.com").includes("/"));
});

test("真值构造：方向靠几何/token，附件靠「有行无文字」，系统消息靠类名（高精度）", () => {
  const rows = toOracleRows([
    { key: "k1", text: "靠左", cxRatio: 0.1, tokens: [], ts: null, identity: null },
    { key: "k2", text: "靠右", cxRatio: 0.9, tokens: [], ts: null, identity: null },
    { key: "k3", text: "居中", cxRatio: 0.5, tokens: [], ts: null, identity: null },
    { key: "k4", text: "", cxRatio: 0.1, tokens: [], ts: null, identity: null },
    { key: "k5", text: "端到端加密", cxRatio: 0.5, tokens: ["system-message"], ts: null, identity: null },
  ]);
  assert.equal(rows[0].expect.direction, "in");
  assert.equal(rows[1].expect.direction, "out");
  assert.equal(rows[2].expect.direction, "unknown", "几何含糊时如实 unknown（不拿去否定描述符）");
  assert.equal(rows[3].expect.mediaLike, true);
  assert.equal(rows[4].expect.systemLike, true);
  // 正常对话里出现「加密」两个字**不该**被判成系统消息（误判会让自检永不收敛）
  const conversational = toOracleRows([
    { key: "k6", text: "我把加密方式发你了", cxRatio: 0.2, tokens: ["bubble"], ts: null, identity: null },
  ]);
  assert.equal(conversational[0].expect.systemLike, false);
});

test("拆分取样：从尾部留出 heldOut，且不会吞掉全部（否则自检无样本可用）", () => {
  const items = [1, 2, 3, 4, 5, 6];
  const { shown, heldOut } = splitSamples(items);
  assert.equal(shown.length + heldOut.length, items.length);
  assert.ok(heldOut.length >= 1, "必须留出独立验证样本");
  assert.ok(shown.length >= 1, "也不能不给模型看任何东西");
  assert.deepEqual(heldOut, [5, 6], "从尾部留（尾部正是最近的会话）");

  assert.deepEqual(splitSamples([1]), { shown: [1], heldOut: [] }, "样本太少时如实不留");
  assert.deepEqual(splitSamples([1, 2]), { shown: [1, 2], heldOut: [] });
});

test("采集包：结构失败/截断/没读到行都要如实记账（不伪装成空会话）", () => {
  const bundle = summarizeCapture({
    url: "https://chat.example.com/c/1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    structure: { ok: false, reason: "boom", viewport: { width: 0, height: 0 }, nodes: [], attrs: [], counts: {} },
    rowItems: [],
    threads: [],
    dropped: ["已有的一条"],
    oracleContainer: null,
  });
  assert.equal(bundle.siteKey, "chat.example.com");
  assert.ok(bundle.dropped.includes("已有的一条"));
  assert.ok(bundle.dropped.some((item) => item.includes("结构探测失败")));
  assert.ok(bundle.dropped.some((item) => item.includes("没读到任何消息行")));
  assert.equal(bundle.oracle.rows.shown.length, 0);
});

test("落盘脱敏：只留指纹与形态，绝不出现消息正文（R2 / §1.3）", () => {
  const secret = "验证码是 483920 请不要告诉别人";
  const bundle = summarizeCapture({
    url: "https://chat.example.com/c/1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    structure: { ok: true, reason: null, viewport: { width: 800, height: 600 }, nodes: [], attrs: [], counts: {} },
    rowItems: [
      { key: "k1", text: secret, cxRatio: 0.2, tokens: [], ts: "09:11", identity: "某人" },
      { key: "k2", text: "第二句", cxRatio: 0.9, tokens: [], ts: null, identity: null },
    ],
    threads: [{ key: "peer-1", label: "某人", url: null, unread: true }],
    oracleContainer: "#panel",
  });
  const redacted = JSON.stringify(redactCaptureForDisk(bundle));
  assert.ok(!redacted.includes("483920"), "一次性码绝不落盘");
  assert.ok(!redacted.includes("验证码是"), "正文绝不落盘");
  assert.ok(!redacted.includes("第二句"), "任何正文都不落盘");
  assert.ok(!redacted.includes("09:11"), "显示时间戳一律不信，也没必要落盘");
  assert.ok(redacted.includes("textHash"), "指纹要留着（否则无法复现自检）");
});

/* ————————————————————————— B. 采集（stub 页面） ————————————————————————— */

/**
 * 夹具行列：**采集真值与页内事实共用同一批**。
 * 不共用的话「真值 vs 草案读出的」会因为两边数据不同而假失败（那验的不是描述符，是夹具）。
 */
const STUB_ROWS = [
  { key: "false_a1", text: "<我方秘密甲>", cxRatio: 0.9, tokens: [] },
  { key: "true_b1", text: "<对方秘密乙>", cxRatio: 0.1, tokens: [] },
  { key: "true_b2", text: "<对方秘密丙>", cxRatio: 0.1, tokens: [] },
  { key: "true_b3", text: "<对方秘密丁>", cxRatio: 0.1, tokens: [] },
];

/** 采集用的短夹具（条数断言要小，所以与学习用的那批分开） */
const CAPTURE_ROWS = [
  { key: "false_a1", text: "<我方>", cxRatio: 0.9, tokens: ["msg"] },
  { key: "true_b2", text: "<对方>", cxRatio: 0.1, tokens: ["msg"] },
];

/** 页面上真正存在的行选择器：把「描述符里的行选择器到底存不存在」交给夹具判定 */
const PAGE_ROW_SELECTOR = GOOD_DESCRIPTOR.rows.selector;

/** 页内事实包（描述符驱动的形态：`key` 即站点 id 原样值） */
function stubFacts(rows) {
  return rows.map((row) => ({
    rawId: row.key,
    text: row.text,
    hasMedia: false,
    excluded: false,
    retracted: false,
    tailIcon: null,
    checkIcon: false,
    cxRatio: row.cxRatio,
    tokens: row.tokens,
    seenTs: null,
    identity: null,
  }));
}

function stubPage({ withContainer = true, rows = CAPTURE_ROWS } = {}) {
  return {
    url: () => "https://chat.example.com/c/1",
    evaluate: async (fn, arg) => {
      switch (fn.name) {
        case "probeStructureInPage":
          return {
            ok: true,
            reason: null,
            viewport: { width: 1280, height: 800 },
            nodes: [
              {
                path: "div.msg-list",
                tag: "div",
                role: "log",
                classes: ["msg-list"],
                attrs: { "data-testid": "panel" },
                siblingRepeat: 1,
                childRepeat: 12,
                childCount: 12,
                textLen: 120,
                textShape: "cjk",
                rect: { xRatio: 0.3, yRatio: 0.1, wRatio: 0.7, hRatio: 0.8 },
                contentEditable: false,
                scrollable: true,
                isLink: false,
                hasMediaTag: false,
                clickable: false,
              },
            ],
            attrs: ["data-testid", "data-id"],
            counts: { contentEditable: 1, textarea: 0, roleLog: 1, links: 3, buttons: 2 },
          };
        case "probeChatDom":
          return {
            ok: true,
            reason: null,
            url: "https://chat.example.com/c/1",
            title: "聊天",
            // 「定位不到容器」= 页内探测**没有候选**（真实页内函数要求候选至少 3 个子节点，
            // 所以不可能回传一个 0 子节点的候选容器 —— 夹具要照这个事实来）
            containers: withContainer
              ? [
                  {
                    containerId: 1,
                    selector: "#panel",
                    rank: 100,
                    roleLog: true,
                    ariaLive: null,
                    scrollable: true,
                    areaRatio: 0.6,
                    childCount: 12,
                    repeatedSignatureRatio: 0.85,
                    distinctSignatures: 3,
                    textChars: 800,
                    directionAlternating: true,
                    belowHasInput: true,
                    sendNearby: true,
                  },
                ]
              : [],
            inputs: [{ tag: "div", role: "textbox", contentEditable: true, placeholder: "输入消息", ariaLabel: "", yRatio: 0.94 }],
            textSample: "聊天 消息 会话",
            viewport: { width: 1280, height: 800 },
          };
        case "extractChatItems":
          return {
            ok: true,
            reason: null,
            items: rows,
            scrollTop: 0,
            scrollHeight: 100,
            clientHeight: 100,
            atBottom: true,
          };
        case "extractFactsInPage":
          // 页内事实由**描述符的行选择器**决定：选择器在这个页面上不存在 → 一行都采不到
          if (arg?.rows?.selector !== PAGE_ROW_SELECTOR) {
            return { ok: true, reason: null, rows: [], moreAbove: false, fallbackPoll: false };
          }
          return { ok: true, reason: null, rows: stubFacts(rows), moreAbove: false, fallbackPoll: false };
        case "probeGenericThreadsInPage":
          return {
            ok: true,
            reason: null,
            items: [
              { key: "data-peer-id:1", href: null, labelLen: 3, unread: false },
              { key: "data-peer-id:2", href: "/c/2", labelLen: 4, unread: true },
            ],
          };
        default:
          return null;
      }
    },
  };
}

test("采集打通：结构 + 真值 + 列表真值 + 拆分（结构里没有任何正文）", async () => {
  const bundle = await captureBundle(stubPage());
  assert.equal(bundle.siteKey, "chat.example.com");
  assert.equal(bundle.structure.nodes.length, 1);
  assert.ok(!JSON.stringify(bundle.structure).includes("某句话"), "结构事实里不许有正文");
  assert.equal(bundle.oracle.rows.shown.length + bundle.oracle.rows.heldOut.length, 2);
  assert.equal(bundle.oracle.threads.shown.length + bundle.oracle.threads.heldOut.length, 2);
  assert.equal(bundle.oracle.threads.shown[0].key, "data-peer-id:1");
  assert.equal(bundle.oracle.threads.shown[1].url, "https://chat.example.com/c/2", "相对直链补成绝对地址");
});

test("采集：定位不到容器时如实记账，不假装「页面是空的」", async () => {
  const bundle = await captureBundle(stubPage({ withContainer: false }));
  assert.equal(bundle.oracle.rows.shown.length, 0);
  assert.ok(bundle.dropped.some((item) => item.includes("没定位到会话容器") || item.includes("没读到任何消息行")));
});

test("通用列表候选 → 列表项：相对地址补全、无身份不收、危险协议不收", () => {
  const items = mapGenericThreads(
    [
      { key: null, href: "/c/1", labelLen: 3, unread: false },
      { key: "data-peer-id:2", href: null, labelLen: 3, unread: true },
      { key: null, href: null, labelLen: 3, unread: false },
      { key: "data-peer-id:3", href: "javascript:void(0)", labelLen: 3, unread: false },
    ],
    "https://chat.example.com/",
  );
  assert.equal(items.length, 3, "没有身份的那条不收");
  assert.equal(items[0].url, "https://chat.example.com/c/1");
  assert.equal(items[0].key, "https://chat.example.com/c/1", "没有站点身份时用绝对地址当 key");
  assert.equal(items[1].unread, true);
  assert.equal(items[2].url, null, "javascript: 不进 url（否则会被拿去导航）");
  assert.equal(new Set(items.map((item) => item.key)).size, items.length);
});

/* ————————————————————————— C. 推断（纯函数） ————————————————————————— */

const STRUCTURE_STUB = {
  ok: true,
  reason: null,
  viewport: { width: 1280, height: 800 },
  nodes: [
    {
      path: "div.msg-list",
      tag: "div",
      role: null,
      classes: ["msg-list"],
      attrs: { "data-id": "#" },
      siblingRepeat: 1,
      childRepeat: 12,
      childCount: 12,
      textLen: 120,
      textShape: "cjk",
      rect: { xRatio: 0.3, yRatio: 0.1, wRatio: 0.7, hRatio: 0.8 },
      contentEditable: false,
      scrollable: true,
      isLink: false,
      hasMediaTag: false,
      clickable: false,
    },
  ],
  attrs: ["data-id"],
  counts: { contentEditable: 1, textarea: 0, roleLog: 1, links: 3, buttons: 2 },
};

function bundleStub() {
  return summarizeCapture({
    url: "https://chat.example.com/c/1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    structure: STRUCTURE_STUB,
    rowItems: STUB_ROWS,
    threads: [
      { key: "peer-1", label: "某人", url: null, unread: true },
      { key: "peer-2", label: "另一个人", url: null, unread: false },
    ],
    oracleContainer: "#panel",
  });
}

test("结构描述：给模型的只有结构/形态/几何，没有正文", () => {
  const text = describeStructure(STRUCTURE_STUB);
  assert.ok(text.includes("div.msg-list"));
  assert.ok(text.includes("文本 120(cjk)"), "只给长度与形态");
  assert.ok(!text.includes("<div"), "不许出现 HTML");
});

test("提示词：绝不含 HTML、绝不含 heldOut 样本、修正回路会带上具体差异", () => {
  const bundle = bundleStub();
  assert.ok(bundle.oracle.rows.heldOut.length > 0, "夹具要保证有独立样本");
  const messages = buildInferMessages(bundle, { siteLabel: "示例站" });
  const text = messages.map((m) => m.content).join("\n");

  assert.ok(!/<(?:div|span|section|main)\b/i.test(text), "提示词里不许出现 HTML 标签");
  assert.ok(!text.includes("textContent"), "不许让模型去想 DOM API");
  for (const row of bundle.oracle.rows.heldOut) {
    assert.ok(!text.includes(row.rawId), `heldOut 样本 ${row.rawId} 不许进提示词（否则自检就是自我确认）`);
  }
  for (const row of bundle.oracle.rows.shown) {
    assert.ok(!text.includes(row.text), "正文一律不进提示词");
  }

  const adjusted = buildInferMessages(bundle, {
    siteLabel: "示例站",
    previous: { descriptor: GOOD_DESCRIPTOR, notes: [], usage: null, raw: "" },
    feedback: "- [fatal] rows.direction@id=false_#: 期望=in 实际=out",
    userNote: "这里不是发送按钮",
  });
  const adjustedText = adjusted.map((m) => m.content).join("\n");
  assert.ok(adjustedText.includes("rows.direction@id=false_#"), "上一轮差异必须原样回喂");
  assert.ok(adjustedText.includes("这里不是发送按钮"), "用户补充必须带上");
  assert.ok(adjustedText.includes("方向相反"), "修正指令要点明典型错法");
});

test("id 原型：数字折成 #（形态可学、内容不外传）", () => {
  assert.equal(foldIdShape("true_1234567890@c.us_ABCDEF"), "true_#@c.us_ABCDEF");
  assert.ok(foldIdShape("x".repeat(200)).length <= 60);
});

test("输出解析：容错只在外壳，正文不做任何修补", () => {
  const good = parseInferResult('```json\n{"descriptor":{"id":"x"},"notes":[{"field":"match.hostPattern","reason":"url","confidence":2}]}\n```');
  assert.ok(good);
  assert.equal(good.descriptor.id, "x");
  assert.equal(good.notes[0].confidence, 1, "越界置信度收窄");

  const noisy = parseInferResult('好的，这是草案：{"descriptor":{"id":"y"}} 以上就是全部');
  assert.equal(noisy.descriptor.id, "y");

  assert.equal(parseInferResult(""), null);
  assert.equal(parseInferResult("完全不是 JSON"), null);
  assert.equal(parseInferResult('{"notes":[]}'), null, "没有 descriptor 就是没有（不凭空造一份）");
  assert.equal(parseInferResult('{"descriptor":[]}'), null);
  assert.equal(parseInferResult('{"descriptor":"字符串"}'), null);
  assert.equal(parseInferResult('{"descriptor":{"id":"x"}, "notes":"不是数组"}').notes.length, 0);
});

/* ————————————————————————— D. 自检 ————————————————————————— */

test("自检通过：我方/对方/附件逐字段都对", () => {
  const report = verifyDraft(GOOD_DESCRIPTOR, goodRows());
  assert.equal(report.ok, true, report.summary);
  assert.equal(report.schemaOk, true);
  assert.equal(report.silentFailures.length, 0);
  assert.equal(report.samples.heldOutRows, 3);
  assert.ok(report.summary.includes("自检通过"));
});

test("自检抓静默失败①：方向写反（有结果，但里外颠倒）", () => {
  const flipped = clone(GOOD_DESCRIPTOR);
  flipped.rows.idPrefixDirection = { out: "true_", in: "false_" };
  const report = verifyDraft(flipped, goodRows());
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.field.startsWith("rows.direction@") && !check.ok));
  assert.ok(report.silentFailures.length > 0, "这类必须被单列为静默失败");
  assert.ok(report.silentFailures.every((check) => check.actual && check.expected));
});

test("自检抓静默失败②：正文取错（内容版本不一致）", () => {
  const wrongText = clone(GOOD_DESCRIPTOR);
  // 去掉 id 前缀方向，让方向靠几何兜住；再把文本选择器换成一个「取到别处」的候选
  const rows = goodRows();
  const report = verifyDraft(wrongText, [
    { ...rows[0], text: "<我方一>", expect: { ...rows[0].expect, contentVersion: contentVersionOf("text", "完全不同的另一句") } },
  ]);
  assert.equal(report.ok, false);
  const content = report.checks.find((check) => check.field.startsWith("rows.content@"));
  assert.ok(content && !content.ok);
  assert.ok(content.expected.startsWith("v:"), "要给指纹而不是让人对着哈希猜");
  assert.ok(report.silentFailures.some((check) => check.field.startsWith("rows.content@")));
});

test("自检抓静默失败③：附件行没被认出来（会把「发来一张图」当成「对方没回」）", () => {
  const noMedia = clone(GOOD_DESCRIPTOR);
  noMedia.rows.attachmentSelectors = [];
  const rows = [oracleRow({ rawId: "true_a1b2c3d4e7", text: "", direction: "in", mediaLike: true })];
  const report = verifyDraft(noMedia, rows);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.field.startsWith("rows.media@") && !check.ok));
});

test("自检：系统消息必须被跳过（漏进会话即 fatal）", () => {
  const rows = [
    ...goodRows(),
    oracleRow({ rawId: "true_a1b2c3d4e9", text: "端到端加密通知", direction: "in", systemLike: true, tokens: ["system-message"] }),
  ];
  const leaking = clone(GOOD_DESCRIPTOR);
  leaking.rows.exclude = [];
  const bad = verifyDraft(leaking, rows);
  assert.equal(bad.ok, false);
  const check = bad.checks.find((item) => item.field === "rows.exclude");
  assert.ok(check && !check.ok);
  assert.ok(check.actual.includes("漏进会话"));

  const good = verifyDraft(GOOD_DESCRIPTOR, rows);
  assert.ok(good.checks.find((item) => item.field === "rows.exclude")?.ok);
});

test("自检：一条都没匹配到是 fatal，但**不算静默失败**（它报了错，没骗人）", () => {
  const broken = clone(GOOD_DESCRIPTOR);
  broken.rows.selector = "#nope .nope";
  // 「一条都没匹配到」只有拿草案在真实页面上采一次才看得见：这里如实给一份**采集失败**的事实包
  const report = verifyDraft(broken, {
    facts: { ok: false, reason: "rows_not_matched", rows: [], moreAbove: false, fallbackPoll: false },
    oracleRows: goodRows(),
  });
  assert.equal(report.ok, false);
  const count = report.checks.find((check) => check.field === "rows.count");
  assert.ok(count && !count.ok);
  assert.ok(count.detail.includes("不是「对方没说话」"), "要把「选择器失效」与「空会话」分开说");
  assert.equal(report.silentFailures.length, 0, "报错型失败不算静默失败");
});

test("自检：schema 被拒就停在这一步（不修补、不继续）", () => {
  const report = verifyDraft({ id: "x", 乱写的键: 1 }, goodRows());
  assert.equal(report.ok, false);
  assert.equal(report.schemaOk, false);
  assert.ok(report.diagnostics.length > 0);
  assert.ok(report.summary.includes("没通过严格校验"));
  assert.equal(report.silentFailures.length, 0);
});

test("自检报告折叠成差异时，每条都带期望与实际（否则用户没法判断哪里错）", () => {
  const flipped = clone(GOOD_DESCRIPTOR);
  flipped.rows.idPrefixDirection = { out: "true_", in: "false_" };
  const text = formatVerifyReport(verifyDraft(flipped, goodRows()));
  assert.ok(text.includes("期望="));
  assert.ok(text.includes("实际="));
});

test("会话列表核对：多出（认错人）是 fatal；漏了是 warning；没真值就如实跳过", () => {
  const expected = [
    { key: "peer-1", label: "某人", url: null, unread: false },
    { key: "peer-2", label: "另一个人", url: null, unread: false },
  ];
  const extra = compareThreads(
    { ok: true, reason: null, source: "descriptor", items: [...expected, { key: "peer-3", label: "路人", url: null, unread: false }] },
    expected,
  );
  assert.ok(extra.some((check) => check.field === "threads.keys" && !check.ok && check.severity === "fatal"));

  const missing = compareThreads({ ok: true, reason: null, source: "descriptor", items: [expected[0]] }, expected);
  const coverage = missing.find((check) => check.field === "threads.coverage");
  assert.ok(coverage && !coverage.ok);
  assert.equal(coverage.severity, "warning", "漏了只提示：通用读法本身也可能漏");

  const failed = compareThreads({ ok: false, reason: "container_missing", source: "descriptor", items: [] }, expected);
  assert.ok(failed.some((check) => check.field === "threads.read" && !check.ok && check.severity === "fatal"));

  const noOracle = compareThreads({ ok: true, reason: null, source: "descriptor", items: [] }, []);
  const skipped = noOracle.find((check) => check.field === "threads.oracle");
  assert.ok(skipped && skipped.ok, "没真值时如实说明跳过，不假装验过");
  assert.ok(skipped.actual.includes("跳过"));
});

/* ————————————————————————— E. 编排 ————————————————————————— */

/** 假模型客户端：按轮次返回预设输出（可断言「模型看到了什么」） */
function stubClient(outputs, { onCall } = {}) {
  let index = 0;
  return {
    seen: [],
    chat: {
      completions: {
        create: async (body) => {
          index += 1;
          onCall?.(body, index);
          const output = outputs[Math.min(index - 1, outputs.length - 1)];
          if (typeof output === "function") return output(body);
          return { choices: [{ message: { content: output } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
        },
      },
    },
  };
}

function learnInput(over = {}) {
  return {
    // 页面事实与 `bundleStub()` 的真值必须是同一批（否则验的是夹具差异，不是描述符）
    page: stubPage({ rows: STUB_ROWS }),
    client: over.client ?? stubClient([JSON.stringify({ descriptor: GOOD_DESCRIPTOR })]),
    model: "logic-model",
    siteLabel: "示例站",
    reuseCapture: bundleStub(),
    maxRounds: 2,
    ...over,
  };
}

test("编排：一轮通过就收工，并把描述符返回给调用方", async () => {
  const result = await learnDescriptor(learnInput());
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.descriptor.id, "sample-im");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.usage.calls, 1);
  assert.ok(result.summary.includes("可以启用"));
});

test("编排：第一轮方向反了 → 把具体差异回喂，第二轮修好", async () => {
  const flipped = clone(GOOD_DESCRIPTOR);
  flipped.rows.idPrefixDirection = { out: "true_", in: "false_" };
  const seenPrompts = [];
  const client = stubClient(
    [JSON.stringify({ descriptor: flipped }), JSON.stringify({ descriptor: GOOD_DESCRIPTOR })],
    { onCall: (body) => seenPrompts.push(body.messages.map((m) => m.content).join("\n")) },
  );
  const result = await learnDescriptor(learnInput({ client }));
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.attempts.length, 2, "必须走修正回路");
  assert.ok(result.attempts[0].feedback?.includes("rows.direction@"), "第一轮的差异要能驱动修正");
  assert.ok(seenPrompts[1].includes("rows.direction@"), "第二轮提示词里必须带上具体差异");
  assert.equal(result.usage.calls, 2);
});

test("编排：到顶仍不过 → 如实报卡在哪，且不给出描述符", async () => {
  const broken = clone(GOOD_DESCRIPTOR);
  broken.rows.selector = "#nope";
  const result = await learnDescriptor(learnInput({ client: stubClient([JSON.stringify({ descriptor: broken })]) }));
  assert.equal(result.ok, false);
  assert.equal(result.descriptor, null);
  assert.equal(result.attempts.length, 2, "轮数上限是 2");
  assert.ok(result.summary.includes("未通过自检"));
  assert.ok(result.summary.includes("通用模式"), "要说明本站当前仍走通用模式");
});

test("编排：模型输出解析不了 → 如实失败，不编一份草案顶上", async () => {
  const result = await learnDescriptor(learnInput({ client: stubClient(["我拒绝输出 JSON"]) }));
  assert.equal(result.ok, false);
  assert.equal(result.descriptor, null);
  assert.equal(result.attempts.length, 1);
  assert.ok(result.summary.includes("没有给出可解析"));
});

test("编排：模型调用抛错 → 如实报错，不留半成品", async () => {
  const client = stubClient([
    () => {
      throw new Error("upstream 500");
    },
  ]);
  const result = await learnDescriptor(learnInput({ client }));
  assert.equal(result.ok, false);
  assert.ok(result.summary.includes("模型调用出错"));
  assert.ok(result.summary.includes("upstream 500"));
});

test("编排：中途取消 → 立即停手，且不保存半成品", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await learnDescriptor(learnInput({ signal: controller.signal }));
  assert.equal(result.ok, false);
  assert.equal(result.descriptor, null);
  assert.ok(result.summary.includes("已取消"));
  assert.equal(result.usage.calls, 0, "取消后一次模型调用都不该发生");
});

test("编排：草案没写 threads 就不去读页面列表（新站点也能学）", async () => {
  assert.equal(GOOD_DESCRIPTOR.threads, undefined);
  const result = await learnDescriptor(learnInput());
  assert.equal(result.ok, true);
  assert.equal(result.report.threads.length, 0);
});

/* ————————————————————————— F. 写入自检 ————————————————————————— */

test("写入自检：发送成功且读回逐字一致才算通过", async () => {
  const result = await verifySendRoundtrip({
    contact: { label: "我自己", url: null },
    marker: "abc123",
    signal: new AbortController().signal,
    connector: {
      sendText: async () => ({ ok: true }),
      readThread: async (_contact, options) => {
        void options;
        return {
          ok: true,
          reason: null,
          newOutgoing: [{ text: "接口自检 abc123" }],
        };
      },
    },
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.checks.length, 2);
});

test("写入自检：写入成功但读不回来 → 判失败，且**不重试第二次**", async () => {
  let sends = 0;
  const result = await verifySendRoundtrip({
    contact: { label: "我自己", url: null },
    marker: "abc123",
    signal: new AbortController().signal,
    connector: {
      sendText: async () => {
        sends += 1;
        return { ok: true };
      },
      readThread: async () => ({ ok: true, reason: null, newOutgoing: [] }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(sends, 1, "不通过就停手，绝不重复发送（会刷屏）");
  const roundtrip = result.checks.find((check) => check.field === "send.roundtrip");
  assert.ok(roundtrip && !roundtrip.ok);
  assert.ok(roundtrip.detail.includes("回执早于结果"));
});

test("写入自检：写入就失败 → 连读都不读（不浪费一次读取）", async () => {
  let reads = 0;
  const result = await verifySendRoundtrip({
    contact: { label: "我自己", url: null },
    marker: "abc123",
    signal: new AbortController().signal,
    connector: {
      sendText: async () => ({ ok: false, reason: "composer_missing" }),
      readThread: async () => {
        reads += 1;
        return { ok: true, reason: null, newOutgoing: [] };
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(reads, 0);
  assert.equal(result.checks.length, 1);
  assert.ok(result.summary.includes("composer_missing"));
});

/* ————————————————————————— G. 落盘 ————————————————————————— */

const META_STUB = {
  siteKey: "chat.example.com",
  siteLabel: "示例站",
  savedAt: "2026-01-01T00:00:00.000Z",
  url: "https://chat.example.com/c/1",
  rounds: 1,
  readVerified: true,
  sendVerified: false,
  notes: [],
  usage: { promptTokens: 100, completionTokens: 20, calls: 1 },
  verifySummary: "自检通过",
};

test("保存学到的描述符：正文与元数据分文件，且存的东西自己能原样读回", () => {
  const dir = tempDir();
  try {
    const parsed = parseDescriptor(GOOD_DESCRIPTOR, "learned");
    assert.equal(parsed.ok, true);
    const saved = saveLearnedDescriptor({ dir, descriptor: parsed.descriptor, meta: META_STUB });
    assert.ok(saved.descriptorPath.endsWith("chat.example.com.json"));
    assert.ok(saved.metaPath.includes("_meta-"));

    // 目录里只有正文文件会被当成描述符（`_` 前缀的元数据不进扫描）
    const names = readdirSync(dir);
    assert.equal(names.length, 2);
    assert.equal(names.filter((name) => !name.startsWith("_")).length, 1);

    const reread = JSON.parse(readFileSync(saved.descriptorPath, "utf8"));
    assert.equal(parseDescriptor(reread, "learned").ok, true, "我们自己写出去的文件必须自己能读回");
    assert.equal(readLearnedMeta(dir, "chat.example.com").rounds, 1);
    assert.equal(readLearnedMeta(dir, "nope.example"), null, "没学过的站点读不到就如实给 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("删除学到的描述符：连元数据一起删，且幂等", () => {
  const dir = tempDir();
  try {
    const parsed = parseDescriptor(GOOD_DESCRIPTOR, "learned");
    saveLearnedDescriptor({ dir, descriptor: parsed.descriptor, meta: META_STUB });
    assert.equal(removeLearnedDescriptor(dir, "chat.example.com"), true);
    assert.equal(readdirSync(dir).length, 0);
    assert.equal(removeLearnedDescriptor(dir, "chat.example.com"), false, "再删一次不报错也不谎报成功");
    assert.equal(readLearnedMeta(dir, "chat.example.com"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导出为 builtin 候选：只把 source 改成 builtin，其余逐字不变", () => {
  const parsed = parseDescriptor(GOOD_DESCRIPTOR, "learned");
  const exported = JSON.parse(exportAsBuiltinCandidate(parsed.descriptor));
  assert.equal(exported.source, "builtin");
  assert.equal(parseDescriptor(exported, "builtin").ok, true, "导出物必须能通过 builtin 校验");
  const { source: _ignored, ...rest } = exported;
  const { source: _orig, ...original } = parsed.descriptor;
  assert.deepEqual(rest, original, "除 source 外一字不改（否则导出的不是验过的那一份）");
});

/* ————————————————————————— H. 决策记录 ————————————————————————— */

test("决策记录：落在给定目录（环境内）、只落指纹与判定、不落正文", () => {
  const dir = tempDir();
  try {
    appendDecision(dir, {
      at: "2026-01-01T00:00:00.000Z",
      kind: "draft",
      threadKey: "whatsapp-web:peer-1",
      outcome: "rejected",
      reason: "复读：与已发第 2 条相似度 0.91",
      inboundIds: ["true_b1", "true_b2"],
      summaryGeneration: 3,
      angle: null,
    });
    const records = readDecisions(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "rejected");
    assert.deepEqual(records[0].inboundIds, ["true_b1", "true_b2"]);
    assert.equal(records[0].angle, undefined, "未定义字段不落 null 之外的噪音");

    const raw = readFileSync(join(dir, "decision.jsonl"), "utf8");
    assert.ok(!raw.includes("undefined"));
    assert.ok(raw.endsWith("\n"), "JSONL 每行一条，最后也要有换行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("决策记录：轮转有上限（不会无限膨胀），坏行不毁整份", () => {
  const dir = tempDir();
  try {
    // 阈值调小以触发轮转
    for (let i = 0; i < 5; i += 1) {
      appendDecision(
        dir,
        { at: `2026-01-01T00:00:0${i}.000Z`, kind: "learn", outcome: "learn", reason: `第 ${i} 轮` },
        200,
      );
    }
    const segments = listDecisionSegments(dir);
    assert.ok(segments.includes("decision.jsonl"));
    assert.ok(segments.length <= 3, `分片数要有上限，实际 ${segments.join(",")}`);

    // 塞一行坏数据：读回仍要拿到可用记录
    const path = join(dir, "decision.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}{ 这不是 JSON }\n`, "utf8");
    const records = readDecisions(dir, 50);
    assert.ok(records.length > 0, "坏行不该让整份决策记录不可读");
    assert.ok(records.every((record) => typeof record.kind === "string"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ————————————————————————— I. 花费账本 ————————————————————————— */

test("花费账本：四栏齐全、读取桶恒 0 token、切片与按联系人各自记账", () => {
  let ledger = emptyLedger();
  ledger = addSlice(ledger, "read", { calls: 12, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 });
  ledger = addSlice(ledger, "draft", { calls: 1, promptTokens: 900, completionTokens: 60, costMicroUsd: 1200 });
  ledger = addThread(ledger, "peer-1", "memory", { calls: 1, promptTokens: 300, completionTokens: 40, costMicroUsd: 400 });

  const rows = spendReport(ledger.slice);
  assert.equal(rows.length, 4, "四栏永远都在");
  assert.equal(rows.find((row) => row.bucket === "read").promptTokens, 0);
  assert.equal(rows.find((row) => row.bucket === "draft").calls, 1);

  const totals = totalsOf(ledger.slice);
  assert.equal(totals.costMicroUsd, 1200);
  assert.equal(ledger.byThread["peer-1"][0].bucket, "memory");
  assert.equal(normalizeEntries(ledger.byThread["peer-1"]).length, 4);

  const reset = resetSlice(ledger);
  assert.equal(reset.slice.length, 0);
  assert.equal(reset.byThread["peer-1"][0].calls, 1, "清本次值守不动按联系人");
});

test("花费显示：微美元格式化到人话，且只有一个实现", () => {
  assert.ok(formatMicroUsd(1200).startsWith("$0.00"));
  assert.equal(formatMicroUsd(1_500_000), "$1.5000");
  assert.equal(formatMicroUsd(Number.NaN), "$0.000000");
});

/* ————————————————————————— J. 结构自检（坑族 G/J） ————————————————————————— */

test("采集层不含站点字面量、不做动态求值，也不含点击/导航（发现流水线同样只读）", () => {
  const dist = join(HERE, "..", "dist", "core", "web_chat", "discovery");
  const siteLiterals = [/whatsapp/, /web\.telegram\.org/, /messenger\.com/, /discord\.com/];
  for (const name of readdirSync(dist).filter((item) => item.endsWith(".js"))) {
    const text = readFileSync(join(dist, name), "utf8");
    const lower = text.toLowerCase();
    for (const pattern of siteLiterals) {
      assert.ok(!pattern.test(lower), `${name} 含站点字面量 ${pattern}（加站点=加描述符，不是改代码）`);
    }
    assert.ok(!/\beval\s*\(/.test(text), `${name} 出现 eval（R8 明令禁止）`);
    assert.ok(!/new\s+Function\s*\(/.test(text), `${name} 出现 new Function（R8 明令禁止）`);
  }
  // 采集只读：结构探测里不许出现点击/导航/输入
  const capture = readFileSync(join(dist, "capture.js"), "utf8");
  for (const banned of [".click(", ".goto(", ".fill(", ".press(", "scrollIntoView"]) {
    assert.ok(!capture.includes(banned), `capture.js 出现 ${banned}（采集必须是纯读）`);
  }
  assert.ok(capture.includes("PROBE_NODE_LIMIT"), "候选上限必须存在（否则会把整页塞给模型）");
  assert.ok(PROBE_NODE_LIMIT <= 1000, "候选上限要克制：多了既贵又稀释注意力");
});

test("页面探测函数的候选上限与白名单是常量，且提示词只放其中一部分", () => {
  const text = describeStructure({ ...STRUCTURE_STUB, nodes: new Array(200).fill(STRUCTURE_STUB.nodes[0]) });
  const lines = text.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(lines.length <= 60, `提示词最多放 60 个候选，实际 ${lines.length}`);
});
