/**
 * 回放 AI 步愈合：准入闸 / 配置解析 / 禁止多步
 * 运行：npm run build && node --test tests/replay-ai-heal.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parseReplayAiHealConfig 默认启用且夹取预算", async () => {
  const { parseReplayAiHealConfig } = await import("../dist/replay_ai_heal.js");
  const d = parseReplayAiHealConfig({});
  assert.equal(d.enabled, true);
  assert.equal(d.maxPerRun, 3);
  assert.equal(d.allowDismissBlocker, true);
  assert.equal(parseReplayAiHealConfig({ enabled: false }).enabled, false);
  assert.equal(parseReplayAiHealConfig({ maxPerRun: 99 }).maxPerRun, 10);
  assert.equal(parseReplayAiHealConfig({ maxPerRun: -1 }).maxPerRun, 0);
});

test("classifyHealEligibility：红线拒绝、定位类放行", async () => {
  const { classifyHealEligibility } = await import("../dist/replay_ai_heal.js");
  assert.equal(
    classifyHealEligibility({
      stepType: "click",
      label: "下一步",
      failReason: "selector 超时",
    }).ok,
    true,
  );
  assert.equal(
    classifyHealEligibility({
      stepType: "click",
      label: "15日 div option",
      failReason: "文案愈合未命中",
    }).ok,
    true,
  );
  assert.equal(
    classifyHealEligibility({
      stepType: "click",
      label: "支付",
      failReason: "x",
    }).ok,
    false,
  );
  assert.equal(
    classifyHealEligibility({
      stepType: "fill",
      label: "密码",
      failReason: "空",
      redacted: true,
    }).ok,
    false,
  );
  assert.equal(
    classifyHealEligibility({
      stepType: "navigate",
      label: "打开",
      failReason: "x",
    }).ok,
    false,
  );
});

test("ReplayAiHealBudget 用尽后 canUse=false", async () => {
  const { ReplayAiHealBudget } = await import("../dist/replay_ai_heal.js");
  const b = new ReplayAiHealBudget(2);
  assert.equal(b.canUse(), true);
  b.consume();
  b.consume();
  assert.equal(b.canUse(), false);
  assert.equal(b.remaining(), 0);
});

test("源码级：回放循环动态 import 愈合；禁止 Agent 主循环；对接契约", () => {
  const healSrc = readFileSync(join(SIDECAR_ROOT, "src/replay_ai_heal.ts"), "utf8");
  const replaySrc = readFileSync(join(SIDECAR_ROOT, "src/replay_engine.ts"), "utf8");
  assert.ok(healSrc.includes("attemptReplayAiHeal"), "须有愈合入口");
  assert.ok(!healSrc.includes("AgentLoopDeps"), "禁止借 Agent 循环");
  assert.ok(!healSrc.includes("registerAction"), "禁止借 registerAction");
  assert.ok(replaySrc.includes("replay_ai_heal.js"), "须动态 import 避免环依赖");
  assert.ok(replaySrc.includes("tryAiHealStep"), "click/fill 须接愈合");
  assert.ok(replaySrc.includes("请重录该段轨迹"), "多步对不齐须引导重录");
  assert.ok(/aiHeal\s*\?/.test(replaySrc), "Options 须有 aiHeal");
});

test("源码级：Host 设置键 replay_ai_heal 已白名单+种子", () => {
  const dbSrc = readFileSync(join(SIDECAR_ROOT, "../src-tauri/src/db.rs"), "utf8");
  assert.ok(dbSrc.includes('"replay_ai_heal"'), "ALLOWED 须含 replay_ai_heal");
  assert.ok(/seed_default_settings[\s\S]*replay_ai_heal/.test(dbSrc), "须种子默认值");
});
