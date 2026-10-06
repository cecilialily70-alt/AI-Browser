/**
 * 任务契约 · 会话型（chat）意图回归测试（P9）
 *
 * 这一组锁的是最初的病根：会话目标一开始就停在会话页，契约里却凭空多出一条
 * `navigation` 交付物 —— 它永远是「还差一项」，`done` 被反复驳回，任务原地打转。
 * 三道闸一起修：
 *   ① 意图分类：会话型目标单独成一类（`chat`），且**验收标准不比结果型松**；
 *   ② 契约生成：会话型目标不得产生臆造的 navigation 交付物（除非目标点名要打开某 URL）；
 *   ③ 运行期：`verifyNavigation` 认「起点即目标」，`createDeliverableLedger` 预核销。
 *
 * 运行：`npm run test:chat`（先 `npm run build`，测试直接跑编译产物）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyGoalIntent,
  evaluateCompletion,
  loadCompletionLexicon,
} from "../dist/core/completion_evidence.js";
import {
  buildTaskContract,
  createDeliverableLedger,
  deriveContractFromRules,
  hasConcreteNavigationTarget,
  isUnrequestedDeliverable,
  isUnverifiableNavigation,
  listPendingDeliverables,
} from "../dist/bu_agent/task_contract.js";
import { verifyDeliverable } from "../dist/core/deliverable_verify.js";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEXICON = loadCompletionLexicon();

/** 最小证据台账（只填这些用例真正会读到的字段） */
function ledgerOf(overrides = {}) {
  return {
    startUrl: "https://example.com/",
    startTitle: "",
    facts: [],
    lastMutationStep: -1,
    lastMutationUrl: "",
    lastFillUrl: null,
    prevUrl: "",
    rejections: 0,
    pageDigestChars: 0,
    humanHandoverKeys: new Set(),
    humanInvolved: false,
    humanPaymentConfirmed: false,
    channelEmailOtp: null,
    channelSmsOtp: null,
    ...overrides,
  };
}

function signalsOf(overrides = {}) {
  return { ok: true, strong: [], weak: [], failure: [], prePay: [], paymentClaims: [], chars: 0, ...overrides };
}

function navSpec(hints = []) {
  return { id: "navigation#1", kind: "navigation", text: "打开目标页", hints, required: true };
}

/* ————————————————————————— ① 意图分类 ————————————————————————— */

test("会话型目标被单独识别（且先于结果型，避免「发送」把会话吞成 outcome）", () => {
  assert.equal(classifyGoalIntent("给张三发消息，问问他货发了没", LEXICON), "chat");
  assert.equal(classifyGoalIntent("在这个会话里回他一句", LEXICON), "chat");
  assert.equal(classifyGoalIntent("chat with the seller about the refund", LEXICON), "chat");
  // 含结果动词但本质是会话 → 仍判 chat
  assert.equal(classifyGoalIntent("发消息给张三并回复他的问题", LEXICON), "chat");
});

test("结果型 / 信息型 / 通用型不受影响（不误伤注册与总结）", () => {
  assert.equal(classifyGoalIntent("注册一个新账号", LEXICON), "outcome");
  assert.equal(classifyGoalIntent("帮我创建一个谷歌邮箱账户", LEXICON), "outcome");
  assert.equal(classifyGoalIntent("帮我注册一个谷歌邮箱账户", LEXICON), "outcome");
  assert.equal(classifyGoalIntent("create a gmail account", LEXICON), "outcome");
  assert.equal(classifyGoalIntent("下单买这个杯子", LEXICON), "outcome");
  assert.equal(classifyGoalIntent("帮我总结这个页面的内容", LEXICON), "informational");
  assert.equal(classifyGoalIntent("随便逛逛", LEXICON), "generic");
  assert.equal(classifyGoalIntent("打开百度首页", LEXICON), "generic");
});

/* ————————————————————————— ② 契约生成 ————————————————————————— */

test("会话型目标：未点名 URL 时契约里不留任何导航债务（这是病根本身）", () => {
  const contract = deriveContractFromRules({
    goal: "给张三发消息说你好",
    intent: "chat",
    plan: ["打开会话", "输入消息", "发送"],
  });
  assert.equal(contract.intent, "chat");
  assert.ok(
    contract.deliverables.every((spec) => spec.kind !== "navigation"),
    `会话型目标不该有 navigation 债务，实际：${JSON.stringify(contract.deliverables)}`,
  );
  // 「输入消息」是可核销的（fill_verified 回读），保留下来当硬闸是对的
  assert.ok(contract.deliverables.some((spec) => spec.kind === "field_filled"));
});

test("会话型目标：点了名要打开某 URL → navigation 保留（能靠起点即目标核销）", () => {
  const contract = deriveContractFromRules({
    goal: "打开 https://chat.example.com/u/1 给张三发消息说你好",
    intent: "chat",
    plan: ["打开会话页"],
    explicitNavigation: true,
  });
  assert.deepEqual(
    contract.deliverables.map((spec) => spec.kind),
    ["navigation"],
  );
});

test("same goal / informational 仍照旧丢弃臆造的 navigation（不回归）", () => {
  const contract = deriveContractFromRules({
    goal: "帮我总结这个网站",
    intent: "informational",
    plan: ["打开网站", "阅读并总结"],
  });
  assert.ok(contract.deliverables.every((spec) => spec.kind !== "navigation"));
});

test("结果型目标照旧得到 navigation 交付物（不是一刀切砍掉）", () => {
  const contract = deriveContractFromRules({
    goal: "打开 https://example.com/apply 并提交申请",
    intent: "outcome",
    plan: ["打开申请页", "提交申请"],
    explicitNavigation: true,
  });
  assert.ok(contract.deliverables.some((spec) => spec.kind === "navigation" || spec.kind === "submitted"));
});

test("模型给的 delivery 里混进 navigation：会话型目标下被结构闸门拦掉", () => {
  const contract = buildTaskContract({
    goal: "给张三发消息",
    intent: "chat",
    raw: [
      { kind: "navigation", text: "打开会话页" },
      { kind: "field_filled", text: "输入消息内容" },
    ],
  });
  assert.ok(contract.deliverables.every((spec) => spec.kind !== "navigation"));
});

test("isUnrequestedDeliverable：navigation 对会话型目标同样是「目标未要求」", () => {
  assert.equal(isUnrequestedDeliverable(navSpec(["会话"]), "chat"), true);
  assert.equal(isUnrequestedDeliverable(navSpec(["会话"]), "informational"), true);
  assert.equal(isUnrequestedDeliverable(navSpec(["会话"]), "outcome"), false);
});

/* ————————————————————————— ③ 起点即目标 ————————————————————————— */

test("verifyNavigation：起点即目标 → 当场成立（不再判「未离开起始地址」）", () => {
  const ledger = ledgerOf({ startUrl: "https://chat.example.com/u/1" });
  const result = verifyDeliverable(navSpec(["chat.example.com/u/1"]), {
    goal: "给张三发消息",
    ledger,
    currentUrl: "https://chat.example.com/u/1",
    goalIntent: "chat",
  });
  assert.equal(result.ok, true);
  assert.ok(result.reason.includes("起点即目标页"), result.reason);
});

test("verifyNavigation：会话型目标 + 无跳转 → 不确定，绝不判死", () => {
  const ledger = ledgerOf({ startUrl: "https://chat.example.com/u/1" });
  const result = verifyDeliverable(navSpec([]), {
    goal: "给张三发消息",
    ledger,
    currentUrl: "https://chat.example.com/u/1",
    goalIntent: "chat",
  });
  assert.equal(result.ok, null);
  assert.ok(result.reason.includes("会话型目标不要求导航"), result.reason);
});

test("verifyNavigation：结果型目标 + 从未跳转 → 仍然如实否认（不放宽）", () => {
  const ledger = ledgerOf({ startUrl: "https://example.com/" });
  const result = verifyDeliverable(navSpec(["申请页"]), {
    goal: "提交申请",
    ledger,
    currentUrl: "https://example.com/",
    goalIntent: "outcome",
  });
  assert.equal(result.ok, false);
});

test("createDeliverableLedger：起始地址已命中线索 → navigation 项预核销，不留永远差一项", () => {
  const contract = {
    goal: "在 https://example.com/apply 提交申请",
    intent: "outcome",
    deliverables: [navSpec(["example.com/apply"])],
    source: "rule",
  };
  const ledger = createDeliverableLedger(contract, "https://example.com/apply");
  assert.equal(listPendingDeliverables(ledger).length, 0);
  const record = ledger.records.get("navigation#1");
  assert.equal(record.status, "satisfied");
  assert.ok(record.evidence.includes("起点即目标页"), record.evidence);
});

test("createDeliverableLedger：起始地址不匹配 → 保持待办（不能凭空核销）", () => {
  const contract = {
    goal: "打开 https://example.com/apply 并提交",
    intent: "outcome",
    deliverables: [navSpec(["example.com/apply"])],
    source: "rule",
  };
  const ledger = createDeliverableLedger(contract, "https://example.com/");
  assert.equal(listPendingDeliverables(ledger).length, 1);
});

test("createDeliverableLedger：不传 startUrl 时行为与改造前一致", () => {
  const contract = {
    goal: "打开目标页",
    intent: "outcome",
    deliverables: [navSpec(["example.com/apply"])],
    source: "rule",
  };
  const ledger = createDeliverableLedger(contract);
  assert.equal(listPendingDeliverables(ledger).length, 1);
});

/* ————————————————————————— ④ 验收标准不比结果型松 ————————————————————————— */

test("evaluateCompletion：会话型任务只在输入框敲字（无发送证据）→ 依然不放行", () => {
  const verdict = evaluateCompletion({
    ledger: ledgerOf({
      facts: [{ kind: "fill_verified", step: 1, detail: "输入框已写入" }],
      lastMutationStep: 1,
      lastMutationUrl: "https://chat.example.com/u/1",
    }),
    lexicon: LEXICON,
    goal: "给张三发消息说你好",
    claim: "已经把消息内容填进了输入框",
    signals: signalsOf(),
    currentUrl: "https://chat.example.com/u/1",
    screenshotRecent: false,
  });
  assert.equal(verdict.acceptable, false, verdict.supports.join(" / "));
  assert.equal(verdict.goalIntent, "chat");
  assert.ok(verdict.guidance.includes("会话型"), verdict.guidance);
});

test("evaluateCompletion：出现发送成功提示 → 放行", () => {
  const verdict = evaluateCompletion({
    ledger: ledgerOf({
      facts: [{ kind: "fill_verified", step: 1, detail: "输入框已写入" }],
      lastMutationStep: 1,
      lastMutationUrl: "https://chat.example.com/u/1",
    }),
    lexicon: LEXICON,
    goal: "给张三发消息说你好",
    claim: "消息已发送，会话里出现我方那一条",
    signals: signalsOf({ strong: ["已发送"], chars: 120 }),
    currentUrl: "https://chat.example.com/u/1",
    screenshotRecent: false,
  });
  assert.equal(verdict.acceptable, true);
});

test("evaluateCompletion：会话页有失败提示且无成功迹 → 不放行", () => {
  const verdict = evaluateCompletion({
    ledger: ledgerOf({
      facts: [{ kind: "fill_verified", step: 1, detail: "输入框已写入" }],
      lastMutationStep: 1,
      lastMutationUrl: "https://chat.example.com/u/1",
    }),
    lexicon: LEXICON,
    goal: "给张三发消息说你好",
    claim: "已经发送",
    signals: signalsOf({ failure: ["发送失败"] }),
    currentUrl: "https://chat.example.com/u/1",
    screenshotRecent: false,
  });
  assert.equal(verdict.acceptable, false);
});

test("lexicon 里 chat 词表确实被加载（不是靠内置兜底）", () => {
  assert.ok(LEXICON);
  assert.ok(Array.isArray(LEXICON.chatTerms) && LEXICON.chatTerms.length > 0);
});

/* ————————————————————————— ⑤ 说不出目的地的导航不立债务 ————————————————————————— */
/* 这一组对应真实现场（P9 之后仍复现的那一例）：
 *   目标「向Anne 推广苹果18手机」→ 契约里凭空多出
 *   [navigation#1] 打开可联系 Anne 的页面/应用（如聊天、邮件等沟通渠道）
 *   而浏览器本来就停在会话页 → verifyNavigation 判「页面从未离开起始地址」→ done 被无限驳回。
 * 根因：这条交付物的线索里只剩「打开」这个纯导航动词 —— 它从来没说清要去哪。 */

test("判据：线索里只剩纯导航动词 → 没有可核对的目的地", () => {
  assert.equal(hasConcreteNavigationTarget(["打开"]), false);
  assert.equal(hasConcreteNavigationTarget(["visit"]), false);
  assert.equal(hasConcreteNavigationTarget([]), false);
  // 有具体目标（站点名 / 路径 / 栏目名）→ 可核对
  assert.equal(hasConcreteNavigationTarget(["打开", "图片"]), true);
  assert.equal(hasConcreteNavigationTarget(["https://example.com/apply"]), true);
});

test("契约生成：说不出去哪的 navigation 一律不收（规则路径）", () => {
  const contract = deriveContractFromRules({
    goal: "向Anne 推广苹果18手机",
    intent: "generic",
    plan: ["打开可联系 Anne 的页面/应用（如聊天、邮件等沟通渠道）", "发送推广消息"],
  });
  assert.ok(
    contract.deliverables.every((spec) => spec.kind !== "navigation"),
    `不该立导航债务，实际：${JSON.stringify(contract.deliverables)}`,
  );
});

test("契约生成：模型给的「打开可联系X的页面」同样被结构闸门拦掉（这是现场那条）", () => {
  const contract = buildTaskContract({
    goal: "向Anne 推广苹果18手机",
    intent: "generic",
    raw: [
      { kind: "navigation", text: "打开可联系 Anne 的页面/应用（如聊天、邮件等沟通渠道）" },
      { kind: "element_state", text: "在联系人列表或会话列表中找到 Anne 并进入对话" },
    ],
  });
  assert.deepEqual(
    contract.deliverables.map((spec) => spec.kind),
    ["element_state"],
  );
});

test("契约生成：有具体目的地的 navigation 照旧保留（不是一刀切）", () => {
  const contract = buildTaskContract({
    goal: "打开 https://example.com/apply 并提交申请",
    intent: "outcome",
    raw: [{ kind: "navigation", text: "打开 https://example.com/apply 申请页", hints: ["example.com/apply"] }],
  });
  assert.ok(contract.deliverables.some((spec) => spec.kind === "navigation"));
});

test("运行期判据：isUnverifiableNavigation 只认「navigation + 说不出目的地」", () => {
  assert.equal(isUnverifiableNavigation(navSpec(["打开"])), true);
  assert.equal(isUnverifiableNavigation(navSpec(["example.com/apply"])), false);
  assert.equal(
    isUnverifiableNavigation({ id: "element_state#1", kind: "element_state", text: "找 Anne", hints: ["打开"], required: true }),
    false,
  );
});

/* ————————————————————————— 自定义下拉 / 纯导航误杀（注册现场） ————————————————————————— */

test("源码级：listbox/menu 容器不得吞掉内部 option（否则月份选项没有独立 index）", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/interactive_elements.ts"), "utf8");
  assert.ok(src.includes('role === "listbox" || role === "menu"'), "必须显式排除 listbox/menu 容器");
  assert.ok(src.includes("existing.contains(element)"), "overlapsCollected 仍在（容器先入账就会吞子项）");
});

test("源码级：select_dropdown 必须真实点击并校验落值（禁止合成事件假成功）", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/bu_agent/actions.ts"), "utf8");
  assert.ok(src.includes("readComboboxShownValue"), "必须有落值回读");
  assert.ok(src.includes("dropdownSelectionApplied"), "必须有落值校验");
  assert.ok(!/hit\.dispatchEvent\(new MouseEvent\("mousedown"/.test(src), "禁止再用合成 mousedown 当主路径");
  const selectBlock = src.slice(src.indexOf('registerAction("select_dropdown"'));
  const body = selectBlock.slice(0, selectBlock.indexOf('registerAction("screenshot"'));
  assert.ok(!/\.filter\(\s*\{\s*hasText\s*:/.test(body), "禁止 filter hasText（Cloak isolated-world）");
  assert.ok(body.includes("evaluateHandle"), "必须 evaluateHandle 定位选项");
  assert.ok(/optionEl\.click/.test(body), "必须走 Playwright 真实点击");
});

test("源码级：task 意图 / needsFollowup 时禁止纯导航本地收尾", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/bu_agent/service.ts"), "utf8");
  assert.ok(src.includes("!analyzed.intent.needsFollowup"), "needsFollowup 必须挡住本地导航收尾");
  assert.ok(src.includes('analyzed.intent.kind !== "task"'), "task 意图必须挡住本地导航收尾");
});
