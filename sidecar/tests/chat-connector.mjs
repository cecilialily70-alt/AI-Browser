/**
 * P2 回归：连接器运行时的三条红线级纪律
 *
 *   1. **出站只走输入框 + 写入等值校验 + 只发一次**（R8 第②条）
 *   2. **页内哨兵只在武装时拦提交，绝不吞用户的回车**（R8 第①③条）
 *   3. **零动态求值、零自建网络请求**（描述符是数据；引擎不许自己发消息）
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runWithGateway } from "../dist/core/action_gateway.js";
import {
  normalizeComposerText,
  planCommitSteps,
  sendViaComposer,
  verifyComposerWrite,
} from "../dist/core/web_chat/descriptor/composer.js";
import {
  CHAT_AGENT_BRIDGE,
  CHAT_SEND_GATE_KEY,
  bootstrapChatAgent,
} from "../dist/core/web_chat/descriptor/page_agent.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTOR_DIST = join(HERE, "..", "dist", "core", "web_chat", "descriptor");

/* ————————————————————————— A. 纯判定（红线逻辑可直接单测） ————————————————————————— */

test("写入校验：读不到一律不算通过（fail-closed，宁可不发）", () => {
  assert.equal(verifyComposerWrite("你好", null, { failClosed: true }).ok, false);
  assert.equal(verifyComposerWrite("你好", null, { failClosed: false }).ok, false);
  assert.equal(
    verifyComposerWrite("你好", null, { failClosed: true }).reason,
    "composer_read_failed",
  );
});

test("写入校验：空白差异不算失败，实质不同绝不放行", () => {
  assert.equal(verifyComposerWrite("你好  世界", " 你好 世界 ", { failClosed: true }).ok, true);
  const bad = verifyComposerWrite("你好", "你好，我想买点别的", { failClosed: true });
  assert.equal(bad.ok, false, "fail-closed 下必须拒绝超集");
  const loose = verifyComposerWrite("你好", "你好，我想买点别的", { failClosed: false });
  assert.equal(loose.ok, true, "放宽模式允许「包含全文」（站点改写周边）");
  assert.equal(loose.downgraded, true);
  const different = verifyComposerWrite("你好", "完全不相干的一句话", { failClosed: false });
  assert.equal(different.ok, false, "放宽也不许发送与原文不同的内容");
});

test("归一化：零宽字符与多空白不影响判定", () => {
  assert.equal(normalizeComposerText("\u200b你好   世界\n"), "你好 世界");
  assert.equal(normalizeComposerText("   "), "");
});

test("提交计划：一次调用最多一次点击、最多一次回车", () => {
  assert.deepEqual(planCommitSteps("enterOnce", false), ["enter"]);
  assert.deepEqual(planCommitSteps("enterOnce", true), ["enter"], "没声明 elseClick 时仍只回车");
  assert.deepEqual(
    planCommitSteps("enterOnce", true, true),
    ["enter", "click"],
    "elseClick：回车没清空再点发送（禁止只打字不发出）",
  );
  assert.deepEqual(planCommitSteps("click", true), ["click"]);
  assert.deepEqual(planCommitSteps("click", false), [], "没按钮可点就如实不提交");
  assert.deepEqual(planCommitSteps("sendThenEnter", true), ["click", "enter"]);
  assert.deepEqual(planCommitSteps("sendThenEnter", false), ["enter"]);
  for (const method of ["enterOnce", "click", "sendThenEnter"]) {
    for (const hasButton of [true, false]) {
      const steps = planCommitSteps(method, hasButton);
      assert.ok(steps.filter((s) => s === "click").length <= 1, `${method} 出现两次点击`);
      assert.ok(steps.filter((s) => s === "enter").length <= 1, `${method} 出现两次回车`);
    }
  }
});

/* ————————————————————————— B. 出站（功能级，假页面 + 假网关） ————————————————————————— */

/**
 * 假 composer 页面。
 *
 * `evaluate` 按**函数源码特征**分派：这是可控的测试替身，不是生产代码路径。
 * 换行/空白的变化会让分流失效 —— 一旦失效，断言会立刻报错（不会静默放过）。
 */
function makeComposerPage(options = {}) {
  const state = {
    composer: options.value ?? "",
    visible: options.visible ?? true,
    readNull: options.readNull ?? false,
    onFill: options.onFill ?? ((text) => text),
    onEnter: options.onEnter ?? null,
  };
  const calls = { fill: [], click: [], enter: 0, focus: 0, insertText: [] };
  const gateway = {
    async fill(selector, text) {
      calls.fill.push([selector, text]);
      // 清空是「真的清空」，不走 onFill 的改写（否则清不掉会掩盖真实行为）
      state.composer = text === "" ? "" : state.onFill(text, state.composer);
    },
    async click(selector) {
      calls.click.push(selector);
      if (options.clickClearsComposer !== false) state.composer = "";
    },
  };
  const page = {
    url: () => "https://sample-im.example/k/",
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("innerText")) return state.readNull ? null : state.composer;
      if (src.includes("getComputedStyle")) return state.visible;
      return null;
    },
    locator() {
      return {
        first: () => ({
          focus: async () => {
            calls.focus += 1;
          },
        }),
      };
    },
    keyboard: {
      async press(key) {
        if (key !== "Enter") return;
        calls.enter += 1;
        state.composer = state.onEnter ? state.onEnter(state.composer) : "";
      },
      async insertText(text) {
        calls.insertText.push(text);
        state.composer = state.onFill(text, state.composer);
      },
    },
  };
  return { page, gateway, calls, composerText: () => state.composer };
}

function specFor(over = {}) {
  return {
    selectors: over.selectors ?? ["#composer"],
    input: {
      method: "selectAllBeforeInput",
      verify: "equals",
      retries: 0,
      failClosed: true,
      ...(over.input ?? {}),
    },
    send: { selectors: [], method: "enterOnce", elseClick: false, ...(over.send ?? {}) },
  };
}

async function send(env, spec, text, options = {}) {
  return runWithGateway(env.gateway, () => sendViaComposer(env.page, spec, text, options));
}

test("出站：写入成功则只提交一次（不回第二条）", async () => {
  const env = makeComposerPage();
  const result = await send(env, specFor(), "你好，最近在忙什么？");
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(result.verified, true);
  assert.equal(env.calls.enter, 1, "恰好一次回车");
  assert.equal(env.calls.click.length, 0, "没有发送按钮时不该点击");
});

test("出站 fail-closed：写入内容对不上就取消，绝不提交", async () => {
  const env = makeComposerPage({ onFill: () => "被打断的半截内容" });
  const result = await send(env, specFor(), "你好");
  assert.equal(result.ok, false);
  assert.ok(String(result.reason).startsWith("verify_mismatch"), `原因应说明校验失败：${result.reason}`);
  assert.equal(env.calls.enter, 0, "校验失败绝不许提交");
  assert.equal(env.calls.click.length, 0);
  assert.equal(env.composerText(), "", "失败后必须清空输入框（不留半截话给下一轮/用户）");
});

test("出站：写入读不回来 → 一律不发（读不到 ≠ 写成功）", async () => {
  const env = makeComposerPage({ readNull: true });
  const result = await send(env, specFor({ input: { retries: 2 } }), "你好");
  assert.equal(result.ok, false);
  assert.ok(String(result.reason).includes("composer_read_failed"), String(result.reason));
  assert.equal(env.calls.enter, 0);
});

test("出站：第一次写入不完整、第二次成功 → 只提交一次", async () => {
  let attempt = 0;
  const env = makeComposerPage({
    onFill: (text) => {
      attempt += 1;
      return attempt === 1 ? "半" : text;
    },
  });
  const result = await send(env, specFor({ input: { retries: 1 } }), "你好，最近在忙什么？");
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(env.calls.enter, 1);
});

test("出站：输入框找不到 → 如实失败，不做任何提交", async () => {
  const env = makeComposerPage();
  const result = await send(env, specFor({ selectors: [] }), "你好");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "composer_not_found");
  assert.equal(env.calls.enter, 0);
  assert.equal(env.calls.click.length, 0);
});

test("出站：execCommand 的返回值不可信 —— 什么都没写就必须失败", async () => {
  // 坑族 J：`document.execCommand("insertText")` 返回 true 却什么都没写是常态
  const env = makeComposerPage({ onFill: () => "" });
  const result = await send(env, specFor({ input: { method: "execCommand" } }), "你好");
  assert.equal(result.ok, false);
  assert.equal(env.calls.enter, 0, "不许因为「execCommand 说成功了」就提交");
});

test("出站 insertText：写入经 CDP 落字后同样要读回校验", async () => {
  const env = makeComposerPage();
  const result = await send(env, specFor({ input: { method: "insertText" } }), "在的");
  assert.equal(result.ok, true);
  assert.equal(env.calls.insertText.length, 1);
  assert.equal(env.calls.enter, 1);
});

test("出站 sendThenEnter：按钮已经把它发出去了就不再补回车（绝不发第二条）", async () => {
  const withButton = makeComposerPage();
  const first = await send(
    withButton,
    specFor({ send: { selectors: ["#send"], method: "sendThenEnter" } }),
    "你好",
  );
  assert.equal(first.ok, true);
  assert.equal(withButton.calls.click.length, 1);
  assert.equal(withButton.calls.enter, 0, "点完已清空 → 不许再补回车");

  const stuck = makeComposerPage({ clickClearsComposer: false });
  const second = await send(
    stuck,
    specFor({ send: { selectors: ["#send"], method: "sendThenEnter" } }),
    "你好",
  );
  assert.equal(second.ok, true);
  assert.equal(stuck.calls.click.length, 1, "仍然只点一次");
  assert.equal(stuck.calls.enter, 1, "真有残留才补一次回车");
});

/* ————— 写入方式的兜底链（§0.5.3 J）：描述符猜错 ≠ 永远发不出去，但每一步都要读回校验 ————— */

test("声明的写法写不进去 → 自动换兜底写法，仍然只提交一次", async () => {
  // 现场：Telegram K 描述符声明 `selectAllBeforeInput`，合成 beforeinput 落不进去 →
  // 旧实现直接判「发送未确认」，用户看到的就是「引擎死活不发消息」。
  // 这里让**第一次写入**落错字、之后（兜底的真实按键）落对 —— 正是现场的形状。
  let fills = 0;
  const env = makeComposerPage({
    onFill: (text) => {
      fills += 1;
      return fills === 1 ? "半截内容" : text;
    },
  });
  let writeEvaluates = 0;
  const originalEvaluate = env.page.evaluate;
  env.page.evaluate = async (fn, arg) => {
    const src = String(fn);
    if (!src.includes("innerText") && !src.includes("getComputedStyle")) writeEvaluates += 1;
    return originalEvaluate.call(env.page, fn, arg);
  };

  const result = await send(env, specFor({ input: { retries: 0 } }), "你好，最近在忙什么？");

  assert.equal(result.ok, true, `兜底写法应当能写进去：${result.reason}`);
  assert.equal(env.calls.enter, 1, "只许一次回车");
  assert.equal(writeEvaluates, 1, "合成写法只试一次（不是无限重试）");
  assert.equal(result.inputMethod, "typeKeys", "记录真正写进去的那一种写法");
  assert.equal(result.diagnostics?.declaredMethod, "selectAllBeforeInput");
  assert.equal(result.diagnostics?.verifiedMethod, "typeKeys");
  assert.ok(result.diagnostics.readbacks.length >= 2, "每种写法的读回都要留痕");
  assert.ok(
    result.diagnostics.readbacks.some((r) => r.ok === false) &&
      result.diagnostics.readbacks.some((r) => r.ok === true),
  );
});

test("诊断只留长度与指纹，绝不把消息正文写进日志字段", async () => {
  const secret = "这是不该出现在日志里的正文";
  const env = makeComposerPage({ onFill: () => "完全不相干的内容" });
  const result = await send(env, specFor({ input: { retries: 0 } }), secret);
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result.diagnostics ?? {});
  assert.ok(!serialized.includes(secret), "诊断里不许出现正文");
  assert.ok(!serialized.includes("完全不相干"), "也不许出现读回来的别人内容");
  assert.ok(serialized.includes("readLength"), "只留长度与指纹供排查");
});

test("逐键输入不得把换行打成回车（半截话先飞出去＝两次提交）", async () => {
  const env = makeComposerPage();
  const result = await send(env, specFor({ input: { method: "typeKeys", retries: 0 } }), "第一行\n第二行");
  assert.equal(result.ok, true, String(result.reason));
  assert.equal(env.calls.fill.length, 1);
  assert.ok(!env.calls.fill[0][1].includes("\n"), "按键路径的文本必须没有换行");
  assert.equal(result.inputMethod, "typeKeys");
  assert.equal(env.calls.enter, 1, "只有提交那一次回车");
});

test("所有写法都不通过 → 报**声明写法**的原因（健康度据此提示修描述符）", async () => {
  const env = makeComposerPage({ onFill: () => "" });
  const result = await send(env, specFor({ input: { retries: 0 } }), "你好");
  assert.equal(result.ok, false);
  assert.ok(String(result.reason).startsWith("verify_mismatch"), String(result.reason));
  assert.equal(result.diagnostics?.declaredMethod, "selectAllBeforeInput");
  assert.equal(result.diagnostics?.verifiedMethod, null);
  assert.equal(env.calls.enter, 0, "从头到尾一次都没提交");
});

/* ————————————————————————— C. 页内哨兵（真跑引导脚本） ————————————————————————— */

class FakeElement {
  constructor({ attrs = {}, text = "", innerText = null, value = null, selectorMap = {} } = {}) {
    this.attrs = attrs;
    this.text = text;
    this.innerTextValue = innerText;
    this.value = value;
    this.selectorMap = selectorMap;
    this.matchesList = [];
    this.descendants = [];
  }

  get nodeType() {
    return 1;
  }

  get parentElement() {
    return null;
  }

  get textContent() {
    return this.text;
  }

  get innerText() {
    return this.innerTextValue ?? this.text;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  matches(selector) {
    return this.matchesList.includes(selector);
  }

  querySelector(selector) {
    return this.selectorMap[selector] ?? null;
  }

  contains(el) {
    return el === this || this.descendants.includes(el);
  }
}

/** 造一个「页内存根」：window / document / MutationObserver，跑完必须还原 */
function withFakePage(run) {
  const handlers = new Map();
  const emitted = [];
  const composer = new FakeElement({ text: "你好", value: "你好" });
  const container = new FakeElement({
    selectorMap: {
      'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]':
        composer,
    },
  });

  const documentStub = {
    documentElement: {},
    querySelector: (selector) => (selector === "#thread" ? container : null),
    addEventListener: (type, handler) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
  };

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
  };

  class FakeObserver {
    observe() {}
    disconnect() {}
  }

  globalThis.window = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    [CHAT_AGENT_BRIDGE]: (payload) => emitted.push(payload),
  };
  globalThis.document = documentStub;
  globalThis.MutationObserver = FakeObserver;
  globalThis.HTMLInputElement = class {};
  globalThis.HTMLTextAreaElement = class {};

  const config = {
    containerSelector: "#thread",
    rowsSelector: '[data-testid="msg-row"]',
    idAttr: "data-id",
    idPrefixDirection: { out: "false_", in: "true_" },
    tailOut: [],
    tailIn: [],
    retracted: ['[data-testid="recalled-message"]'],
    typing: ['[data-testid="typing"]'],
    quietMs: 30,
  };

  const keydown = (event) => {
    for (const handler of handlers.get("keydown") ?? []) handler(event);
  };

  const restore = () => {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.MutationObserver = previous.MutationObserver;
    globalThis.HTMLInputElement = previous.HTMLInputElement;
    globalThis.HTMLTextAreaElement = previous.HTMLTextAreaElement;
  };

  const context = {
    bootstrap: () =>
      bootstrapChatAgent({
        emitName: CHAT_AGENT_BRIDGE,
        gateKey: CHAT_SEND_GATE_KEY,
        flag: "__tstChatAgentInstalled",
        config,
      }),
    emitted,
    composer,
    keydown,
    setGate: (value) => {
      globalThis.window[CHAT_SEND_GATE_KEY] = value;
    },
    setComposer: (text) => {
      composer.value = text;
      composer.text = text;
    },
    dispose: () => {
      globalThis.window.__tstChatAgentInstalled = "disposed";
    },
    listenersFor: (type) => (handlers.get(type) ?? []).length,
  };

  try {
    // 断言在体外做（页面替身在体内用完即还原，避免污染其它用例）
    return run(context);
  } finally {
    restore();
  }
}

function enterEvent(target = null) {
  return {
    key: "Enter",
    shiftKey: false,
    target,
    prevented: false,
    stopped: false,
    immediate: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    stopImmediatePropagation() {
      this.immediate = true;
    },
  };
}

test("页内哨兵：没武装闸门时绝不吞用户的回车", () => {
  const result = withFakePage((ctx) => {
    ctx.bootstrap();
    const event = enterEvent(ctx.composer);
    ctx.keydown(event);
    return { prevented: event.prevented };
  });
  assert.equal(result.prevented, false, "用户自己敲回车必须照常发送（R8 第①条）");
});

test("页内哨兵：武装后内容一致 → 放行；内容对不上 → 拦下并上报", () => {
  const armed = withFakePage((ctx) => {
    ctx.bootstrap();
    ctx.setGate({ text: "你好", armedAt: Date.now() });
    const event = enterEvent(ctx.composer);
    ctx.keydown(event);
    return { prevented: event.prevented };
  });
  assert.equal(armed.prevented, false, "内容一致就是我们要发的那句，放行");

  const mismatched = withFakePage((ctx) => {
    ctx.bootstrap();
    ctx.setGate({ text: "你好，这是新版本", armedAt: Date.now() });
    ctx.setComposer("你好");
    const event = enterEvent(ctx.composer);
    ctx.keydown(event);
    return { prevented: event.prevented, emitted: [...ctx.emitted] };
  });
  assert.equal(mismatched.prevented, true, "输入框内容对不上就必须拦下这一次提交");
  assert.ok(
    mismatched.emitted.some((e) => e.kind === "gate_blocked" && e.reason === "composer_mismatch"),
    "拦下必须如实上报（不静默）",
  );
});

test("页内哨兵：武装时页内别处的回车一律放行（闸门只绑 composer）", () => {
  const result = withFakePage((ctx) => {
    ctx.bootstrap();
    ctx.setGate({ text: "你好，这是新版本", armedAt: Date.now() });
    ctx.setComposer("你好");
    const elsewhere = { nodeType: 1, contains() { return false; } };
    const event = enterEvent(elsewhere);
    ctx.keydown(event);
    return { prevented: event.prevented };
  });
  assert.equal(result.prevented, false, "非输入框回车不得被吞");
});

test("页内哨兵：重复安装是幂等的（不会叠加监听器）", () => {
  const result = withFakePage((ctx) => {
    ctx.bootstrap();
    const once = ctx.listenersFor("keydown");
    ctx.bootstrap();
    return { once, twice: ctx.listenersFor("keydown") };
  });
  assert.equal(result.once, 1);
  assert.equal(result.twice, 1, "第二遍安装必须直接返回，不能重复挂钩子");
});

test("页内哨兵：置为 disposed 后不再推送事件", () => {
  const result = withFakePage((ctx) => {
    ctx.bootstrap();
    const before = ctx.emitted.length;
    ctx.dispose();
    ctx.setGate({ text: "对不上", armedAt: Date.now() });
    ctx.setComposer("别的内容");
    ctx.keydown(enterEvent(ctx.composer));
    return { before, after: ctx.emitted.length };
  });
  assert.equal(result.after, result.before, "收工后页内不许再往桥里灌事件（成对销毁）");
});

/* ————————————————————————— D. 源码级纪律（R8） ————————————————————————— */

test("R8：出站与页内哨兵都不得自建网络请求（只走输入框）", () => {
  for (const name of ["composer.js", "page_agent.js", "facts.js", "dom_connector.js"]) {
    const text = readFileSync(join(DESCRIPTOR_DIST, name), "utf8");
    for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /new\s+WebSocket/]) {
      assert.ok(!pattern.test(text), `${name} 出现自建网络请求 ${pattern}（R8 明令禁止）`);
    }
  }
});

test("R8：页内哨兵的桥名与闸门名是稳定契约（宿主/测试都按它对接）", () => {
  assert.equal(CHAT_AGENT_BRIDGE, "__tstChatAgentEmit");
  assert.equal(CHAT_SEND_GATE_KEY, "__tstChatSendGate");
});
