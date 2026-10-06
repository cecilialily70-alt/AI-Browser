/**
 * 聊天模式协议事件锁（P7）。
 *
 * 为什么必须锁死（§0.5.3 E「协议事件被日志壳包住」）：`chatProgress` 是 Sidecar → 宿主 →
 * 前端「聊天」视图的唯一通道。Rust 侧靠**精确匹配**顶层 `type === "chat_state"` 转发；
 * 一旦有人把调用方传进来的语义 `type`（`chat_read` / `chat_send` …）重新铺到顶层，
 * Rust 就再也收不到聊天事件，而「什么都不发生」这种故障最难查。
 * 同理 `waitId` 必须原样带出 —— 它是「这一片收工了」的唯一唤醒凭据。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { JsonLogger } = require("../dist/json-logger.js");

/** 捕获 stdout 上的一行 JSON（`process.stdout.write` 是唯一出口） */
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

test("chatProgress 顶层 type 恒为 chat_state，语义 type 折叠进 kind", () => {
  const logger = new JsonLogger();
  const lines = capture(() =>
    logger.chatProgress("读到 3 条新消息", {
      type: "chat_read",
      phase: "reading",
      threadKey: "site|alice",
      moreAbove: true,
    }),
  );

  // 第一行是通用 progress（终端排查用），第二行才是协议事件
  const event = lines.find((line) => line.type === "chat_state");
  assert.ok(event, `没有 chat_state 事件，实际输出：${JSON.stringify(lines)}`);
  assert.equal(event.kind, "chat_read");
  assert.equal(event.phase, "reading");
  assert.equal(event.threadKey, "site|alice");
  assert.equal(event.moreAbove, true);
  assert.equal(event.msg, "读到 3 条新消息");
  // 绝不能出现把 kind 顶到 type 的情况（否则 Rust 精确匹配失效）
  assert.equal(lines.some((line) => line.type === "chat_read"), false);
});

test("chatProgress 带出 waitId（收尾唤醒凭据）与 profileId", () => {
  const logger = new JsonLogger();
  const lines = capture(() =>
    logger.chatProgress("聊天值守结束：slice_done", {
      type: "chat_state",
      phase: "idle",
      stopReason: "slice_done",
      profileId: "7",
      waitId: "w-123-9",
      processed: 2,
      sent: 1,
    }),
  );

  const event = lines.find((line) => line.type === "chat_state");
  assert.ok(event);
  assert.equal(event.kind, "chat_state");
  assert.equal(event.waitId, "w-123-9");
  assert.equal(event.profileId, "7");
  assert.equal(event.stopReason, "slice_done");
  assert.equal(event.processed, 2);
});

test("chatProgress 缺 type 时给中性 kind，不让 kind 变成 undefined", () => {
  const logger = new JsonLogger();
  const lines = capture(() => logger.chatProgress("普通聊天记录"));
  const event = lines.find((line) => line.type === "chat_state");
  assert.ok(event);
  assert.equal(event.kind, "chat_note");
});

test("chatProgress 空文案不产出任何事件（避免刷空行）", () => {
  const logger = new JsonLogger();
  const lines = capture(() => logger.chatProgress("   ", { type: "chat_read" }));
  assert.equal(lines.length, 0);
});
