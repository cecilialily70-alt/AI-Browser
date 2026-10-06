/**
 * 聊天付款闸门：只许已配置纯内容，禁止编造
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  decidePaymentGate,
  extractPaymentMethodsFromGoal,
  isPlainPaymentText,
  plainPaymentText,
} from "../dist/core/web_chat/chat_payment.js";
import { defaultGateSend } from "../dist/core/web_chat/engine.js";

const ADDR = "TG4d2pVco1AagGg5oW1tLotFDF2r41SC1q";
const METHOD = {
  id: "usdt_trc20_main",
  kind: "usdt_trc20",
  label: "USDT-TRC20",
  value: ADDR,
};

test("目标里的钱包地址可提取为配置", () => {
  const found = extractPaymentMethodsFromGoal(`推销手机 ${ADDR}`);
  assert.equal(found.length, 1);
  assert.equal(found[0].value, ADDR);
});

test("未配置时含钱包载荷 → 拦截", () => {
  const gate = decidePaymentGate(`תעביר לכתובת ${ADDR}`, []);
  assert.equal(gate.kind, "block");
});

test("已配置但夹废话 → plain_only", () => {
  const gate = decidePaymentGate(`תעביר 1000 USDT לכתובת ${ADDR} ואני מסדר`, [METHOD]);
  assert.equal(gate.kind, "plain_only");
  assert.equal(gate.plain, ADDR);
});

test("纯地址可通过", () => {
  assert.equal(isPlainPaymentText(ADDR, METHOD), true);
  assert.equal(decidePaymentGate(ADDR, [METHOD]).kind, "ok");
  assert.equal(plainPaymentText(METHOD), ADDR);
});

test("defaultGateSend 会把夹话改成纯付款", () => {
  const result = defaultGateSend(`haha send to ${ADDR} ok?`, [], [METHOD]);
  assert.equal(result.allow, true);
  assert.equal(result.rewriteText, ADDR);
});
