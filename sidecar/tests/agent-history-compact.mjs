import assert from "node:assert/strict";
import test from "node:test";

import { MessageManager } from "../dist/bu_agent/message_manager.js";
import {
  AGENT_COMPACT_MAX_GENERATIONS,
  formatDroppedHistory,
  mergeExtractiveMemory,
} from "../dist/bu_agent/history_compact.js";
import { DEFAULT_AGENT_SETTINGS } from "../dist/bu_agent/views.js";

function item(step) {
  return {
    stepNumber: step,
    evaluationPreviousGoal: `评${step}`,
    memory: `记${step}`,
    nextGoal: `下${step}`,
    actionResults: [],
    actions: [{ name: "click", params: {} }],
  };
}

test("extractive compact 只吃原始步骤、不拿摘要再总结", () => {
  const first = mergeExtractiveMemory({
    previous: null,
    dropped: [item(1), item(2)],
    generations: 0,
  });
  assert.equal(first.compacted, true);
  assert.ok(first.text.includes("#1"));
  assert.ok(first.text.includes("click"));

  const second = mergeExtractiveMemory({
    previous: first.text,
    dropped: [item(3)],
    generations: first.generations,
  });
  assert.ok(second.text.includes("#1"));
  assert.ok(second.text.includes("#3"));
});

test("代数到顶后不再改 compactedMemory", () => {
  const capped = mergeExtractiveMemory({
    previous: "旧记忆",
    dropped: [item(9)],
    generations: AGENT_COMPACT_MAX_GENERATIONS,
  });
  assert.equal(capped.compacted, false);
  assert.equal(capped.text, "旧记忆");
});

test("MessageManager 热窗口外的步骤进入 compactedMemory", () => {
  const manager = new MessageManager({ ...DEFAULT_AGENT_SETTINGS, maxHistoryItems: 3 });
  for (let i = 0; i < 5; i += 1) {
    manager.appendStep(
      {
        evaluation_previous_goal: `e${i}`,
        memory: `m${i}`,
        next_goal: `n${i}`,
        action: [{ name: "wait", params: {} }],
      },
      [],
    );
  }
  assert.equal(manager.history.length, 3);
  assert.ok(manager.compactedMemory);
  assert.ok(manager.compactedMemory.includes("e0") || manager.compactedMemory.includes("#1"));
  assert.ok(formatDroppedHistory([item(1)]).includes("#1"));
});
