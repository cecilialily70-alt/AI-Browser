/**
 * Agent Event SSOT / RunBrief / 数量核销 / 脱敏 — Phase 6 验收
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { JsonLogger } = require("../dist/json-logger.js");
const { redactSecrets } = require("../dist/secret_redaction.js");
const { buildRunBrief, EvidenceRing } = require("../dist/bu_agent/run_brief.js");
const { mapEventKindToUiKind, slimAgentEventForHuman } = require("../dist/bu_agent/agent_events.js");
const { ordinalHint } = require("../dist/core/deliverable_verify.js");
const {
  createDeliverableLedger,
  listPendingDeliverables,
} = require("../dist/bu_agent/task_contract.js");
const { verifyDeliverables } = require("../dist/core/deliverable_verify.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_SRC = join(__dirname, "..", "src");

function capture(fn) {
  const original = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test("emitAgentEvent：顶层 type 恒为 agent_state，语义进 eventKind（C7）", () => {
  const logger = new JsonLogger();
  const lines = capture(() =>
    logger.emitAgentEvent({
      eventKind: "step_action",
      msg: "点击提交",
      phase: "act",
      step: 3,
      data: { type: "should_not_become_top_type", selector: "#btn" },
    }),
  );
  const event = lines.find((line) => line.type === "agent_state");
  assert.ok(event, `缺 agent_state：${JSON.stringify(lines)}`);
  assert.equal(event.eventKind, "step_action");
  assert.equal(event.phase, "act");
  assert.equal(event.step, 3);
  assert.equal(event.selector, "#btn");
  assert.equal(lines.some((line) => line.type === "should_not_become_top_type"), false);
  assert.equal(lines.some((line) => line.type === "step_action"), false);
});

test("agentState：data.type 不得顶掉协议 type", () => {
  const logger = new JsonLogger();
  const lines = capture(() =>
    logger.agentState("running", { type: "evil_overwrite", eventKind: "note", msg: "hi", phase: "observe" }),
  );
  const event = lines.find((line) => line.type === "agent_state");
  assert.ok(event);
  assert.equal(event.type, "agent_state");
  assert.equal(event.eventKind, "note");
  assert.equal(event.phase, "observe");
});

test("C5：token/phone 脱敏；tokenCount 等 SAFE 后缀保留", () => {
  const masked = redactSecrets({
    token: "secret-token-value",
    phone: "13800138000",
    mobile: "13900139000",
    tokenCount: 42,
    id_token: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
  });
  assert.equal(masked.token, "***");
  assert.equal(masked.phone, "***");
  assert.equal(masked.mobile, "***");
  assert.equal(masked.tokenCount, 42);
  assert.equal(masked.id_token, "***");
});

test("C6：eventKind 映射到 UI kind，未知回落 undefined", () => {
  assert.equal(mapEventKindToUiKind("step_action"), "action");
  assert.equal(mapEventKindToUiKind("gate_reject"), "alert");
  assert.equal(mapEventKindToUiKind("run_complete"), "success");
  assert.equal(mapEventKindToUiKind("step_action_weird"), undefined);
});

test("人视瘦字段剥 DOM/JSON", () => {
  const slim = slimAgentEventForHuman({
    eventKind: "action_ok",
    phase: "act",
    msg: "ok",
    domBefore: "<div>secret</div>",
    networkJson: [{ body: '{"token":"x"}' }],
    selector: "#a",
  });
  assert.equal(slim.eventKind, "action_ok");
  assert.equal(slim.selector, "#a");
  assert.equal(slim.domBefore, undefined);
  assert.equal(slim.networkJson, undefined);
});

test("RunBrief 六槽含近步网络 JSON（403 保留）", () => {
  const ring = new EvidenceRing();
  ring.push({
    step: 2,
    actionNames: ["click"],
    networkJson: [{ status: 403, body: '{"code":403,"msg":"forbidden"}' }],
    networkCapture: "ok",
    domCapture: "ok",
  });
  const brief = buildRunBrief({
    goal: "注册账号",
    stepNumber: 2,
    maxSteps: 50,
    recentEvidence: ring.list(),
  });
  assert.match(brief, /<run_brief>/);
  assert.match(brief, /slot_a_goal/);
  assert.match(brief, /403/);
  assert.match(brief, /forbidden/);
});

test("extract-N：已 3/5 → pending 差 2；满 5 核销", () => {
  assert.equal(ordinalHint(["前5条", "提取"]), 5);
  const contract = {
    goal: "提取前5条商品",
    intent: "outcome",
    source: "rule",
    deliverables: [
      {
        id: "d1",
        kind: "content_read",
        text: "提取前5条",
        hints: ["前5条", "提取"],
        required: true,
      },
    ],
  };
  const ledger = createDeliverableLedger(contract);
  assert.equal(listPendingDeliverables(ledger).length, 1);

  const evidenceBase = {
    startUrl: "https://x.test",
    startTitle: "",
    facts: [{ kind: "items_extracted", step: 1, url: "https://x.test", detail: "3" }],
    rejections: 0,
    pageDigestChars: 0,
    lastMutationStep: -1,
    lastMutationUrl: "",
    lastFillUrl: null,
    prevUrl: "",
    humanInvolved: false,
    humanPaymentConfirmed: false,
    humanHandoverKeys: new Set(),
    channelEmailOtp: null,
  };
  const mid = verifyDeliverables(contract.deliverables, {
    goal: contract.goal,
    ledger: evidenceBase,
    currentUrl: "https://x.test",
  });
  assert.equal(mid[0].result.ok, null);
  assert.match(mid[0].result.reason, /3\/5|还差 2/);

  evidenceBase.facts.push({ kind: "items_extracted", step: 2, url: "https://x.test", detail: "2" });
  const done = verifyDeliverables(contract.deliverables, {
    goal: contract.goal,
    ledger: evidenceBase,
    currentUrl: "https://x.test",
  });
  assert.equal(done[0].result.ok, true);
  assert.match(done[0].result.reason, /5/);
});

test("ChatFireWall：web_chat 与 chat_*.ts 不得引用 Agent 证据 API", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(join(SIDECAR_SRC, "core", "web_chat"));
  for (const entry of readdirSync(join(SIDECAR_SRC, "bu_agent"), { withFileTypes: true })) {
    if (entry.isFile() && /^chat_.*\.ts$/.test(entry.name)) {
      files.push(join(SIDECAR_SRC, "bu_agent", entry.name));
    }
  }
  const banned = ["action_evidence", "run_brief", "emitAgentEvent", "beginActionEvidence", "buildRunBrief"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const token of banned) {
      assert.ok(
        !source.includes(token),
        `${relative(SIDECAR_SRC, file)} 引用了 Agent 专用 API：${token}`,
      );
    }
  }
});

test("pending 台账辅助：空契约 listPending 为空", () => {
  const ledger = createDeliverableLedger({
    goal: "x",
    intent: "informational",
    source: "rule",
    deliverables: [],
  });
  assert.equal(listPendingDeliverables(ledger).length, 0);
});
