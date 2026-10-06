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
  isSearchResultsArrival,
  isSearchSubmitDeliverable,
  strongElementStateHints,
} from "../dist/bu_agent/task_contract.js";
import { absorbPlanDeliverables } from "../dist/bu_agent/replan.js";
import { verifyDeliverable } from "../dist/core/deliverable_verify.js";
import { pageIsSerpForQuery } from "../dist/bu_agent/deterministic.js";

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

test("搜索+总结：进入结果页并入 submitted，不另立 element_state 债", () => {
  const contract = deriveContractFromRules({
    goal: "搜索李世民然后总结第一条结果",
    intent: "informational",
    plan: ["在搜索框输入「李世民」并提交", "确认已进入搜索结果页", "总结第一条结果"],
    queryTerms: ["李世民"],
  });
  assert.equal(contract.deliverables.filter((spec) => spec.kind === "element_state").length, 0);
  assert.equal(contract.deliverables.filter((spec) => spec.kind === "submitted").length, 1);
  assert.ok(contract.deliverables.some((spec) => spec.kind === "answer_given"));
});

test("模型把进入结果页标成 element_state：合并进 submitted，不留第三笔债", () => {
  const contract = buildTaskContract({
    goal: "搜索李世民然后总结第一条结果",
    intent: "informational",
    raw: [
      { text: "搜索李世民并进入搜索结果页", kind: "navigation", required: true, hints: ["进入", "结果页"] },
      { text: "读取并汇报第一条搜索结果", kind: "answer_given", required: true },
      { text: "打开搜索引擎首页，在搜索框中输入「李世民」并提交搜索", kind: "submitted", required: true },
    ],
  });
  assert.deepEqual(
    contract.deliverables.map((spec) => spec.kind),
    ["submitted", "answer_given"],
  );
});

test("verifyElementState：已在检索词 SERP 上则核销进入结果页", () => {
  assert.equal(isSearchResultsArrival("搜索李世民并进入搜索结果页", ["进入", "结果页"]), true);
  assert.equal(isSearchResultsArrival("在联系人列表找到 Anne 并进入对话", ["进入"]), false);
  const result = verifyDeliverable(
    {
      id: "element_state#1",
      kind: "element_state",
      text: "搜索李世民并进入搜索结果页",
      hints: ["进入", "结果页"],
      required: true,
    },
    {
      goal: "搜索李世民然后总结第一条结果",
      ledger: ledgerOf({
        startUrl: "https://www.baidu.com/",
        facts: [{ kind: "navigated", step: 2, url: "https://www.baidu.com/s?wd=x", detail: "url changed" }],
        lastMutationStep: 2,
      }),
      currentUrl: "https://www.baidu.com/s?wd=%E6%9D%8E%E4%B8%96%E6%B0%91",
      serpForQuery: true,
    },
  );
  assert.equal(result.ok, true, result.reason);
});

test("pageIsSerpForQuery：动作后地址已是编码检索词的结果页（观察时的 pageFacts 会过期）", () => {
  assert.equal(
    pageIsSerpForQuery("https://www.baidu.com/s?ie=utf-8&wd=%E6%9D%8E%E4%B8%96%E6%B0%91", ["李世民"]),
    true,
  );
  assert.equal(pageIsSerpForQuery("https://www.baidu.com/", ["李世民"]), false);
});

test("点图/下载第二张不得收成「到达结果页」submitted，也不得因站在 SERP 被核销", () => {
  const planText =
    "在当前已打开的 Google 图片结果页（udm=2）上，用 scroll 把图片网格滚入视口，找到第二张缩略图对应的可点击编号后用 click 点击第二张图片";
  assert.equal(isSearchResultsArrival(planText), false);
  const contract = buildTaskContract({
    goal: "点击图片并下载第二张图片",
    intent: "generic",
    raw: [
      { text: "点击图片栏目", kind: "element_state" },
      { text: "下载第二张图片", kind: "download" },
    ],
    plan: ["点击图片", "下载第二张图片"],
  });
  const ledger = createDeliverableLedger(contract);
  assert.deepEqual(
    absorbPlanDeliverables(ledger, [planText, "下载第二张图片"]),
    [],
  );
  // 重规划「确认进入结果页」也不得偷加 submitted（目标从未要求搜索提交债）
  assert.deepEqual(absorbPlanDeliverables(ledger, ["确认已进入搜索结果页", "下载第二张图片"]), []);
  const settled = verifyDeliverable(
    { id: "submitted#9", kind: "submitted", text: planText, hints: ["结果页"], required: true },
    {
      goal: "点击图片并下载第二张图片",
      ledger: ledgerOf({ startUrl: "https://www.google.com/search?q=x" }),
      currentUrl: "https://www.google.com/search?q=%E6%9D%A8%E5%B9%82&udm=2",
      serpForQuery: true,
    },
  );
  assert.notEqual(settled.ok, true, settled.reason);
});

test("submitted SERP 捷径只服务搜索到达债，注册提交不得因停在谷歌结果页被核销", () => {
  assert.equal(isSearchSubmitDeliverable("搜索王健林并进入搜索结果页"), true);
  assert.equal(isSearchSubmitDeliverable("提交注册表单", ["提交", "注册"]), false);
  const register = verifyDeliverable(
    { id: "submitted#1", kind: "submitted", text: "提交注册表单", hints: ["提交", "注册"], required: true },
    {
      goal: "注册一个账号",
      ledger: ledgerOf({ startUrl: "https://www.google.com/" }),
      currentUrl: "https://www.google.com/search?q=register",
      serpForQuery: true,
      visibleLabels: ["注册", "登录"],
    },
  );
  assert.notEqual(register.ok, true, register.reason);
  const search = verifyDeliverable(
    {
      id: "submitted#1",
      kind: "submitted",
      text: "搜索王健林并进入搜索结果页",
      hints: ["搜索结果页", "王健林"],
      required: true,
    },
    {
      goal: "搜索王健林然后总结第一条结果",
      ledger: ledgerOf({ startUrl: "https://www.google.com/" }),
      currentUrl: "https://www.google.com/search?q=%E7%8E%8B%E5%81%A5%E6%9E%97",
      serpForQuery: true,
    },
  );
  assert.equal(search.ok, true, search.reason);
});

test("下载类目标：模型塞「确认进入结果页」不得进入契约", () => {
  const contract = buildTaskContract({
    goal: "点击图片并下载第二张图片",
    intent: "generic",
    raw: [
      { text: "点击图片栏目", kind: "element_state" },
      { text: "下载第二张图片", kind: "download" },
      { text: "确认已进入搜索结果页", kind: "navigation", required: true },
    ],
  });
  assert.equal(contract.deliverables.some((spec) => spec.kind === "submitted"), false);
  assert.deepEqual(
    contract.deliverables.map((spec) => spec.kind),
    ["element_state", "download"],
  );
});

test("element_state：顶栏频道名「图片」不足以核销「点击图片栏目」", () => {
  assert.deepEqual(strongElementStateHints(["图片", "点击"]), []);
  const result = verifyDeliverable(
    {
      id: "element_state#1",
      kind: "element_state",
      text: "点击图片栏目",
      hints: ["图片", "点击"],
      required: true,
    },
    {
      goal: "点击图片并下载第二张图片",
      ledger: ledgerOf({
        startUrl: "https://www.google.com/search?q=x",
        facts: [{ kind: "navigated", step: 1, url: "https://www.google.com/search?q=x", detail: "" }],
        lastMutationStep: 1,
      }),
      currentUrl: "https://www.google.com/search?q=x",
      serpForQuery: true,
      visibleLabels: ["全部", "图片", "视频", "新闻", "购物"],
    },
  );
  assert.notEqual(result.ok, true, result.reason);
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
