/**
 * 回合意图分类与草稿违规判定（先听后说 · P3）
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTurnIntent,
  draftViolatesIntent,
  intentPromptDirective,
  intentRewriteHint,
  maxBubblesForTurn,
} from "../dist/core/web_chat/turn_intent.js";

test("骗子/机器人质问 → trust_attack", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "你是骗子吗", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "trust_attack");
  assert.ok(intentPromptDirective(intent)?.includes("禁止推销"));
});

test("问价 → price_question；空推没官宣违规；给大致价合规", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "这个多少钱？", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "price_question");
  assert.ok(intentPromptDirective(intent)?.includes("渠道大致价"));
  assert.equal(
    draftViolatesIntent("价格还没正式官宣，我给不了准确数字", intent),
    true,
    "空推没官宣必须判违规",
  );
  assert.equal(
    draftViolatesIntent("我这边大概 6999 起，你要哪种容量？", intent),
    false,
  );
  assert.ok(intentRewriteHint(intent).includes("渠道大致价"));
});

test("纠正「早就发布了」→ fact_correction；死撑旧说法违规", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "现在都9月了苹果早就发布了", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "fact_correction");
  assert.equal(
    draftViolatesIntent("价格还没正式官宣，我给不了准确数字", intent),
    true,
  );
  assert.equal(
    draftViolatesIntent("你说得对，已经出来了，我这边大概 6999 起", intent),
    false,
  );
});

test("普通非询价提问 → direct_question", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "散热怎么样？", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "direct_question");
});

test("信任攻击下推销句违规；澄清句合规", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "你是机器人吗", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "trust_attack");
  assert.equal(draftViolatesIntent("Apple18 散热真的很强，帧率也稳", intent), true);
  assert.equal(draftViolatesIntent("不是骗子，我是真人，刚才没看见消息", intent), false);
});

test("直接提问下纯推销无答违规", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "为什么散热差？", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "direct_question");
  assert.equal(draftViolatesIntent("入手就对了，库存不多包邮", intent), true);
  assert.equal(draftViolatesIntent("因为你说的配置更高，所以贵一点。你更看重哪一块？", intent), false);
});

test("要图 → image_request；纯推销不问图违规；配图说明合规", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "可以给我看看图片吗？", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "image_request");
  const withSku = classifyTurnIntent([
    { id: "1", direction: "in", text: "可以给我看看 Pro Max 深蓝的图片吗", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(withSku.kind, "image_request");
  assert.equal(draftViolatesIntent("入手就对了，库存不多包邮", intent), true);
  assert.equal(draftViolatesIntent("图我现拍给你看，深蓝那台成色很好", intent), false);
});

test("要视频/语音 → voice_video_request；承诺发视频违规；主动说不能发违规；借口合规", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "发个视频给我看看", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "voice_video_request");
  assert.equal(draftViolatesIntent("行，我现在就发视频给你", intent), true);
  assert.equal(draftViolatesIntent("网页上发不了视频，我不会发语音", intent), true);
  assert.equal(draftViolatesIntent("仓库这会儿人不在跟前，我先把实拍图给你看成色", intent), false);
});

test("信任攻击优先于要图", () => {
  const intent = classifyTurnIntent([
    { id: "1", direction: "in", text: "你是骗子吗，还要给我看图", ts: null, identity: null, stableId: false },
  ]);
  assert.equal(intent.kind, "trust_attack");
});

test("气泡上限：默认 1；多问/信任攻击放宽到 2～3", () => {
  const cont = { kind: "continue", excerpt: "" };
  assert.equal(maxBubblesForTurn([], cont), 1);
  assert.equal(
    maxBubblesForTurn(
      [{ id: "1", direction: "in", text: "价格多少？", ts: null, identity: null, stableId: false }],
      { kind: "price_question", excerpt: "价格多少？" },
    ),
    1,
    "单条提问必须只回 1 句，禁止拆成两句倒脚本",
  );
  assert.equal(maxBubblesForTurn([], { kind: "trust_attack", excerpt: "骗子" }), 2);
  assert.equal(maxBubblesForTurn([], { kind: "fact_correction", excerpt: "早就发布了" }), 2);
  const twoQ = [
    { id: "1", direction: "in", text: "a？", ts: null, identity: null, stableId: false },
    { id: "2", direction: "in", text: "b？", ts: null, identity: null, stableId: false },
  ];
  assert.equal(maxBubblesForTurn(twoQ, { kind: "direct_question", excerpt: "a？\nb？" }), 2);
});
