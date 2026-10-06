/**
 * 自定义下拉 / 选项点击 / 用户成功后假「失败」标题 — 源码级回归
 *
 * 锁住微软注册 BirthMonth 现场踩坑：
 * 1) option 误关联到 input[type=number] → 假成功
 * 2) select_dropdown 用 filter({ hasText: RegExp }) → Cloak isolated-world 挂
 * 3) 选项 click 不校验 combobox 落值 → 无 choice_changed 空转重规划
 * 4) 「验收评判：通过 · judge 解析失败…」被裸「失败」子串标成失败标题
 * 5) 用户标记成功仍跑 LLM judge
 *
 * 运行：npm run build && node --test tests/dropdown-select.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SIDECAR_ROOT, "..");

function readSrc(rel) {
  return readFileSync(join(SIDECAR_ROOT, rel), "utf8");
}

function readRepo(rel) {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

test("源码级：option/menuitem/listbox li 必须 self:actionable，且排除 number/spinbutton 关联", () => {
  const src = readSrc("src/core/hit_point.ts");
  assert.ok(src.includes("function isListOption"), "必须有 isListOption");
  assert.ok(src.includes("function isNumberLikeControl"), "必须有 isNumberLikeControl");
  assert.ok(src.includes('role === "option" || role === "menuitem"'), "option/menuitem 识别");
  assert.ok(src.includes('reason: "self:actionable"'), "列表选项点自身");
  assert.ok(
    /listOption\s*&&\s*isNumberLikeControl/.test(src) ||
      /if\s*\(\s*listOption\s*&&\s*isNumberLikeControl/.test(src),
    "祖先关联时排除 number/spinbutton",
  );
  assert.ok(src.includes('type === "number"') || src.includes("type=number") || /=== "number"/.test(src));
  assert.ok(src.includes("spinbutton"));
});

test("源码级：select_dropdown 禁止 filter({ hasText: RegExp })，改 evaluateHandle + 真实 click", () => {
  const src = readSrc("src/bu_agent/actions.ts");
  const selectBlock = src.slice(src.indexOf('registerAction("select_dropdown"'));
  const body = selectBlock.slice(0, selectBlock.indexOf('registerAction("screenshot"'));
  assert.ok(!/\.filter\(\s*\{\s*hasText\s*:/.test(body), "禁止 filter({ hasText })");
  assert.ok(!/new RegExp\(/.test(body), "禁止 RegExp has-text 路径");
  assert.ok(body.includes("evaluateHandle"), "必须页内 evaluateHandle 定位选项");
  assert.ok(/optionEl\.click|optionHandle[\s\S]{0,80}\.click/.test(body), "必须 Playwright 真实点击");
  assert.ok(body.includes("dropdownSelectionApplied"), "必须落值 fail-closed");
  assert.ok(body.includes("choiceChanged: true"), "成功须写 choiceChanged");
});

test("源码级：选项 click 后必须 verifyOptionSelectionApplied + choiceChanged", () => {
  const src = readSrc("src/bu_agent/actions.ts");
  assert.ok(src.includes("function verifyOptionSelectionApplied"), "选项落值校验函数");
  assert.ok(src.includes("function resolveOwningComboboxSelector"), "反查所属 combobox");
  assert.ok(src.includes("optionLike"), "click 路径识别选项");
  assert.ok(
    /optionLike[\s\S]{0,400}verifyOptionSelectionApplied/.test(src),
    "选项 click 后走落值校验",
  );
  assert.ok(
    /choiceChanged:\s*true[\s\S]{0,80}choiceLabel/.test(src) ||
      /metadata:\s*\{[\s\S]*choiceChanged:\s*true/.test(src),
    "选项成功须 metadata.choiceChanged",
  );
});

test("源码级：用户标记成功必须跳过 LLM judge", () => {
  const src = readSrc("src/bu_agent/service.ts");
  assert.ok(/用户标记成功/.test(src), "doneSummary 含用户标记成功");
  assert.ok(
    /userMarkedSuccess[\s\S]{0,200}验收评判：跳过（用户标记成功）/.test(src) ||
      /验收评判：跳过（用户标记成功）/.test(src),
    "用户成功路径跳过 judge",
  );
  assert.ok(/reason:\s*"user_success"/.test(src), "跳过原因 user_success");
});

test("源码级：agentThoughtChain 评判行不得裸匹配「失败」子串", () => {
  const src = readRepo("src/lib/agentThoughtChain.ts");
  assert.ok(src.includes("function judgeLineFailed"), "必须有 judgeLineFailed");
  // 旧写法：/未通过|false|失败/i — 禁止再出现把裸「失败」与未通过绑在一起的正则
  assert.ok(
    !/未通过\|false\|失败/.test(src),
    "禁止旧正则 未通过|false|失败（会误伤「解析失败，回退」）",
  );
  assert.ok(/解析失败[，,]\s*回退/.test(src) || src.includes("解析失败"), "须显式放过解析失败回退");
  assert.ok(src.includes("通过"), "须认「通过」为成功");
});

test("行为：验收评判通过·解析失败回退 不得判为 error", async () => {
  // 前端 TS 未进 sidecar dist；用与生产一致的判据在测试内复现（防回归口径）
  function judgeLineFailed(text) {
    const raw = String(text ?? "");
    if (/未通过/.test(raw)) return true;
    if (/通过|跳过/.test(raw) && !/未通过/.test(raw)) return false;
    if (/解析失败[，,]\s*回退/.test(raw)) return false;
    if (/\bfalse\b/i.test(raw) && !/通过/.test(raw)) return true;
    if (/失败/.test(raw)) return !/通过|跳过|回退/.test(raw);
    return false;
  }
  const passParseFail =
    "验收评判：通过 · judge 解析失败，回退到 Agent 自报 success";
  assert.equal(judgeLineFailed(passParseFail), false, "通过+解析失败回退 ≠ 失败");
  assert.equal(judgeLineFailed("验收评判：未通过 · 缺交付物"), true);
  assert.equal(judgeLineFailed("验收评判：跳过（用户标记成功）"), false);
  assert.equal(judgeLineFailed("验收评判：失败"), true);
});
