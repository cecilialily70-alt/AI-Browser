/**
 * 录制 / 回放优化回归（计划 P0–P2）
 *
 * 运行：先 `npm run build`，再 `node --test tests/trajectory-replay.mjs`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("源码级：preciseClick 成功路径必须 recordClick（录制完整性）", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/bu_agent/actions.ts"), "utf8");
  assert.ok(src.includes("录制完整性：preciseClick"), "必须有落盘注释锚点");
  assert.ok(
    /precise\.ok[\s\S]{0,2500}gw\.recordClick\(/.test(src),
    "precise.ok 分支须调用 gw.recordClick",
  );
});

test("源码级：验证码/OTP/接管须 noteRecordingHardCase，并落 solve_captcha 步", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/bu_agent/actions.ts"), "utf8");
  for (const reason of ["captcha", "otp", "ask_user", "handover", "custom_dropdown", "download"]) {
    assert.ok(
      src.includes(`noteRecordingHardCase(ctx, "${reason}")`),
      `必须标记难点 ${reason}`,
    );
  }
  assert.ok(src.includes('type: "solve_captcha"'), "验证码须落盘 solve_captcha 步");
  assert.ok(src.includes('type: "wait_for_page"'), "切标签须落盘 wait_for_page");
  assert.ok(src.includes('type: "download"'), "下载须落盘 download 步");
});

test("源码级：自定义下拉须录「打开」点击（B3）", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/bu_agent/actions.ts"), "utf8");
  assert.ok(src.includes("打开下拉"), "须录打开下拉");
  assert.ok(src.includes("下拉选项·"), "须录选项点击");
});

test("源码级：回放脱敏 fail-closed + fill 稳态回读 + hash 保留", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/replay_engine.ts"), "utf8");
  assert.ok(src.includes("buildDeterministicReplayPassword"), "注册密码可确定性兜底");
  assert.ok(src.includes("OTP/验证码禁止自动编造"), "OTP 脱敏无覆盖须硬失败");
  assert.ok(src.includes("verifyFill"), "回放 fill 须稳态回读");
  assert.ok(src.includes("postConditionUrlNeedle"), "须有 URL 针");
  assert.ok(src.includes("solve_captcha"), "须有验证码桥");
  assert.ok(src.includes("wait_for_page"), "须有等页面");
  assert.ok(src.includes("本轨迹含下载步"), "下载 fail-closed");
});

test("源码级：支付收尾闸在回放路径（R1）", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/index.ts"), "utf8");
  assert.ok(src.includes("goalDemandsHumanPayment"), "回放须拦「付掉」类目标");
  assert.ok(src.includes("replay_payment_credential_gate"), "须有 phase 留痕");
});

test("源码级：回放人机验证收尾闸 + 长按 verified 须为 true", () => {
  const indexSrc = readFileSync(join(SIDECAR_ROOT, "src/index.ts"), "utf8");
  assert.ok(indexSrc.includes("probeBlockingCaptchaOnPage"), "回放收尾须探测人机验证页");
  assert.ok(indexSrc.includes("replay_captcha_gate"), "须有 phase 留痕");

  const replaySrc = readFileSync(join(SIDECAR_ROOT, "src/replay_engine.ts"), "utf8");
  assert.ok(
    replaySrc.includes("CAPTCHA_MAX_ATTEMPTS"),
    "回放验证码须按 Agent 同口径有限次重试",
  );
  assert.ok(
    replaySrc.includes("验证码重试"),
    "重试须留用户可见进度",
  );
  assert.ok(
    replaySrc.includes("pressHold.verified === true") ||
      replaySrc.includes("unified.pressHold.verified === true"),
    "长按须 verified===true 才算过",
  );
  assert.ok(
    replaySrc.includes("slider.verified === true") ||
      replaySrc.includes("unified.slider.verified === true"),
    "滑块同口径",
  );

  const strategySrc = readFileSync(
    join(SIDECAR_ROOT, "src/bu_agent/captcha_strategy.ts"),
    "utf8",
  );
  assert.ok(strategySrc.includes("證明您是人類"), "须认微软繁中人机题面");

  const pressSrc = readFileSync(
    join(SIDECAR_ROOT, "src/bu_agent/press_hold_captcha.ts"),
    "utf8",
  );
  assert.ok(pressSrc.includes("anyCopyPress"), "有「按住」文案时不得用装饰 pill 抢按钮");
  assert.ok(pressSrc.includes("retry_hold"), "单次求解内须可追加长按");
});

test("源码级：用户标记成功 agent_success / 回放 user_success 终点", () => {
  const indexSrc = readFileSync(join(SIDECAR_ROOT, "src/index.ts"), "utf8");
  assert.ok(indexSrc.includes('"agent_success"'), "IMMEDIATE 须含 agent_success");
  assert.ok(indexSrc.includes('command === "agent_success"'), "须处理 agent_success 命令");

  const replaySrc = readFileSync(join(SIDECAR_ROOT, "src/replay_engine.ts"), "utf8");
  assert.ok(replaySrc.includes('case "user_success"'), "回放须认 user_success 终点");
  assert.ok(replaySrc.includes("回放在此结束"), "user_success 须正常结束回放");

  const trajSrc = readFileSync(join(SIDECAR_ROOT, "src/trajectory.ts"), "utf8");
  assert.ok(trajSrc.includes('"user_success"'), "轨迹类型须含 user_success");
});

test("pack/unpack ReplayHints + 旧轨迹脱敏启发式", async () => {
  const {
    packActionsWithReplayHints,
    unpackActionsWithReplayHints,
    buildReplayHintsFromReasons,
    REPLAY_HINTS_MARKER,
  } = await import("../dist/trajectory.js");
  const hints = buildReplayHintsFromReasons(["captcha", "otp"]);
  assert.equal(hints.needsHuman, true);
  assert.equal(hints.nonMechanical, true);
  const packed = packActionsWithReplayHints(
    [{ step: 1, type: "fill", selector: "#a", value: "x" }],
    hints,
  );
  assert.equal(packed[0][REPLAY_HINTS_MARKER], true);
  const unpacked = unpackActionsWithReplayHints(packed);
  assert.equal(unpacked.hints?.needsHuman, true);
  assert.deepEqual(unpacked.hints?.reasons, ["captcha", "otp"]);
  assert.equal(unpacked.actions.length, 1);

  const legacy = unpackActionsWithReplayHints([
    { step: 1, type: "fill", selector: "#pwd", value: "***", redacted: true },
  ]);
  assert.equal(legacy.hints?.needsHuman, true);
  assert.ok(legacy.hints?.reasons.includes("redacted_fill"));
});

test("postConditionUrlNeedle 保留 hash（SPA 会话切换）", async () => {
  const { postConditionUrlNeedle } = await import("../dist/replay_engine.js");
  const needle = postConditionUrlNeedle("https://web.telegram.org/k/#@Alice");
  assert.ok(needle.includes("#@Alice") || needle.includes("%40Alice") || needle.includes("@Alice"), needle);
  assert.ok(!needle.endsWith("/k"), "不得剥掉 hash 后只剩路径");
});

test("resolveReplayFillValueDeferred：脱敏 OTP 无覆盖仍抛错；注册密码可确定性兜底", async () => {
  const { resolveReplayFillValueDeferred } = await import("../dist/replay_engine.js");
  const { buildDeterministicReplayPassword } = await import("../dist/deferred_generation.js");
  await assert.rejects(
    () =>
      resolveReplayFillValueDeferred(
        "#otp",
        { step: 1, type: "fill", selector: "#otp", value: "***", redacted: true, label: "验证码" },
        {},
      ),
    /脱敏|OTP|验证码/,
  );
  const pwd = await resolveReplayFillValueDeferred(
    "#pwd",
    {
      step: 6,
      type: "fill",
      selector: "#pwd",
      value: "***",
      redacted: true,
      label: "密碼",
      inputType: "password",
    },
    {
      resolveContext: {
        logger: { progress() {}, agentProgress() {} },
        templateExtra: { run: { uniqueId: "42", seq: 0, runSeed: 1 } },
      },
    },
  );
  assert.equal(pwd, buildDeterministicReplayPassword({ run: { uniqueId: "42", seq: 0, runSeed: 1 } }));
  assert.match(pwd, /[A-Z]/);
  assert.match(pwd, /[a-z]/);
  assert.match(pwd, /\d/);
  assert.match(pwd, /[!@#$%^&*]/);
});

test("filterPersistableTrajectorySteps：丢弃临时 ID / 残缺 click，保留 user_success", async () => {
  const {
    filterPersistableTrajectorySteps,
    assertPersistableTrajectorySteps,
  } = await import("../dist/trajectory.js");

  const mixed = [
    { step: 1, type: "navigate", selector: "", url: "https://example.com" },
    { step: 2, type: "click", selector: "42" }, // 临时 ID
    { step: 3, type: "fill", selector: "", value: "x" }, // 空 selector
    { step: 4, type: "click", selector: "", primarySelector: "" }, // 无锚点
    { step: 5, type: "click", selector: "#ok", label: "确认" },
    { step: 6, type: "user_success", selector: "", label: "用户标记成功" },
  ];
  const { actions, dropped } = filterPersistableTrajectorySteps(mixed);
  assert.ok(dropped.length >= 3, `应丢弃坏步，实际 dropped=${dropped.length}`);
  assert.equal(actions.some((a) => a.type === "user_success"), true);
  assert.equal(actions.some((a) => a.selector === "42"), false);
  assert.equal(actions.some((a) => a.type === "navigate"), true);
  assert.equal(actions.some((a) => a.selector === "#ok"), true);
  // 重编号连续
  assert.deepEqual(
    actions.map((a) => a.step),
    actions.map((_, i) => i + 1),
  );
  assert.doesNotThrow(() => assertPersistableTrajectorySteps(actions));
});

test("clickLabelHealCandidates：剥掉 elementLabelBlob 尾部 role/tag 噪声", async () => {
  const { clickLabelHealCandidates, toPlaywrightSelector } = await import(
    "../dist/replay_engine.js"
  );
  const cands = clickLabelHealCandidates("lamchunho09281 button button");
  assert.equal(cands[0], "lamchunho09281");
  assert.ok(cands.includes("lamchunho09281 button button"));
  assert.deepEqual(clickLabelHealCandidates("（点击）"), []);
  assert.deepEqual(clickLabelHealCandidates(""), []);
  // 绝对 xpath 不得被当成临时 ID；须带 xpath= 前缀
  const xp = "/html/body[1]/div[2]/button[1]";
  assert.equal(toPlaywrightSelector(xp), `xpath=${xp}`);
  assert.equal(toPlaywrightSelector(`xpath=${xp}`), `xpath=${xp}`);
});

test("looksLikeDynamicSuggestionLabel + findNextFillSelectStep：建议邮箱 / 后续填写探测", async () => {
  const {
    looksLikeDynamicSuggestionLabel,
    findNextFillSelectStep,
    clickLabelHealCandidates,
    looksLikeDropdownOptionLabel,
  } = await import("../dist/replay_engine.js");
  assert.equal(looksLikeDynamicSuggestionLabel("lamchunho09281 button button"), true);
  assert.equal(looksLikeDynamicSuggestionLabel("下一步"), false);
  assert.equal(looksLikeDynamicSuggestionLabel("Next"), false);
  assert.equal(looksLikeDynamicSuggestionLabel("（点击）"), false);
  assert.equal(clickLabelHealCandidates("lamchunho09281 button button")[0], "lamchunho09281");

  const dayCands = clickLabelHealCandidates("15日 div option");
  assert.equal(dayCands[0], "15日");
  assert.ok(dayCands.includes("15"), "须含纯数字候选（页上常无「日」）");
  assert.equal(looksLikeDropdownOptionLabel("15日 div option"), true);
  assert.equal(looksLikeDropdownOptionLabel("六月 option"), true);
  assert.equal(looksLikeDropdownOptionLabel("下一步"), false);

  const steps = [
    { step: 1, type: "click", selector: "xpath=//button[1]", semanticLabel: "下一步" },
    { step: 2, type: "click", selector: "xpath=//button[2]", semanticLabel: "lamchunho09281 button button" },
    { step: 3, type: "click", selector: "xpath=//button[3]", semanticLabel: "下一步" },
    {
      step: 4,
      type: "fill",
      selector: "xpath=//input[@type='password']",
      semanticLabel: "密碼",
      value: "x",
    },
  ];
  const next = findNextFillSelectStep(steps, 1);
  assert.ok(next);
  assert.equal(next.index, 3);
  assert.equal(next.label, "密碼");
  assert.equal(findNextFillSelectStep(steps, 4), null);
});

test("源码级：click 临时 ID 可走文案愈合；错误须说明原因；recordClick 须落相对坐标", () => {
  const replaySrc = readFileSync(join(SIDECAR_ROOT, "src/replay_engine.ts"), "utf8");
  assert.ok(replaySrc.includes("clickLabelHealCandidates"), "须有文案愈合候选");
  assert.ok(replaySrc.includes("shouldSkipOptionalClick"), "须跳过已越过的中间 click");
  assert.ok(replaySrc.includes("tryClickDynamicSuggestion"), "须能改点动态建议项");
  assert.ok(replaySrc.includes("tryClickListOptionByLabel"), "须能按文案点下拉选项");
  assert.ok(replaySrc.includes("looksLikeDropdownOptionLabel"), "须识别选项类标签");
  assert.ok(
    /type !== "click" && type !== "click_point"/.test(replaySrc),
    "临时 ID 不得在 click 分支前硬抛",
  );
  assert.ok(
    replaySrc.includes("click 缺少可用 selector 与坐标（"),
    "错误须带不可用原因",
  );
  const actionsSrc = readFileSync(join(SIDECAR_ROOT, "src/bu_agent/actions.ts"), "utf8");
  assert.ok(actionsSrc.includes("relativeCoordsForRecord"), "preciseClick 落盘须补相对坐标");
  assert.ok(
    /relativeCoordsForRecord[\s\S]{0,200}gw\.recordClick/.test(actionsSrc),
    "recordClick 须走 relativeCoordsForRecord",
  );
});

test("源码级：录制收尾过滤坏步 + 仅 enableRecording 落库 + user_success 补全", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/bu_agent/service.ts"), "utf8");
  assert.ok(src.includes("filterPersistableTrajectorySteps"), "须过滤不可落库步");
  assert.ok(src.includes("userMarkedSuccess"), "须有用户标记成功标志");
  assert.ok(/if\s*\(\s*enableRecording\s*\)/.test(src), "落库须闸在 enableRecording");
  assert.ok(
    src.includes('!recordedSteps.some((s) => s.type === "user_success")'),
    "用户成功须补 user_success",
  );
  assert.ok(src.includes("deps.logger.agentTrajectory"), "须发 agentTrajectory 事件");
  // 禁止在未勾选录制时强制写盘
  assert.ok(
    !/if\s*\(\s*!enableRecording[\s\S]{0,80}persistTrajectoryToDisk/.test(src),
    "禁止 enableRecording=false 时强制 persist",
  );
});

test("源码级：预检单对文件轨迹跳过 get_agent_trajectory（id≤0 / actions / filePath）", () => {
  const repoRoot = join(SIDECAR_ROOT, "..");
  const src = readFileSync(join(repoRoot, "src-tauri/src/replay_plan.rs"), "utf8");
  assert.ok(src.includes("should_skip_trajectory_db"), "须有跳过库查找判定");
  assert.ok(src.includes("id <= 0"), "负/零 id 须跳过库");
  assert.ok(src.includes("has_actions") || src.includes("!entries.is_empty()"), "非空 actions 须跳过库");
  assert.ok(src.includes("file_path") && src.includes("alias = \"file_path\""), "须接受 filePath/file_path");
  assert.ok(src.includes("load_trajectory_file"), "缺 actions 时须从磁盘加载");
  // 禁止：只要有 Some(id) 就无条件 get_agent_trajectory（文件轨迹 NotFound 根因）
  assert.ok(
    !/if let Some\(id\) = request\.trajectory_id \{[\s\S]{0,200}get_agent_trajectory/.test(src),
    "禁止对任意 Some(trajectory_id) 无条件查库",
  );
});
