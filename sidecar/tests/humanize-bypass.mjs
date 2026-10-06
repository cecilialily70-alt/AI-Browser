/**
 * CloakBrowser Humanizer 路径回归：只断言「不绕开包装层 / 不双套拟人」。
 * 不跑真实浏览器、不注册购物。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function readSrc(rel) {
  return readFileSync(join(SRC, rel), "utf8");
}

test("CDP 补丁走官方 patchBrowser + resolveConfig(careful)，与启动共用 HUMAN_CONFIG", () => {
  const extra = readSrc("cloakbrowser_extra.ts");
  assert.match(extra, /patchBrowser/);
  assert.match(extra, /resolveConfig/);
  assert.match(extra, /HUMAN_PRESET = "careful"/);
  assert.match(extra, /export const HUMAN_CONFIG/);
  assert.match(extra, /HUMAN_NO_MISTYPE/);
  assert.doesNotMatch(extra, /mistype_chance:\s*0\.[1-9]/);

  const launcher = readSrc("browser_launcher.ts");
  assert.match(launcher, /humanPreset: HUMAN_PRESET/);
  assert.match(launcher, /humanConfig: \{ \.\.\.HUMAN_CONFIG \}/);
});

test("用户手势滚动禁止 evaluate(scrollTo/scrollBy)；一次 mouse.wheel", () => {
  const gateway = readSrc("core/action_gateway.ts");
  assert.match(gateway, /page\.mouse\.wheel/);
  assert.doesNotMatch(gateway, /window\.scrollTo/);
  assert.doesNotMatch(gateway, /window\.scrollBy/);

  const replay = readSrc("replay_engine.ts");
  assert.match(replay, /resolveGateway\(page\)\.scroll/);
  assert.doesNotMatch(replay, /window\.scrollTo/);
  assert.doesNotMatch(replay, /window\.scrollBy/);
});

test("拟人 fill 不叠固定 delay 逐键；OTP 可直填且 mistype_chance=0", () => {
  const gateway = readSrc("core/action_gateway.ts");
  assert.match(gateway, /function fillInstant/);
  assert.match(gateway, /HUMAN_NO_MISTYPE/);
  assert.match(gateway, /options\?\.humanLike !== false/);
  assert.doesNotMatch(gateway, /delay:\s*KEYSTROKE_DELAY_MS/);
  assert.doesNotMatch(gateway, /delay:\s*50/);
  assert.match(gateway, /locator\.fill\(value/);

  const actions = readSrc("bu_agent/actions.ts");
  assert.match(actions, /humanLike:\s*false/);
  assert.doesNotMatch(actions, /pressSequentially\(value, \{ delay:/);
});

test("聊天描述符 fill/insertText/execCommand 回退保留；typeKeys 走拟人 fill", () => {
  const composer = readSrc("core/web_chat/descriptor/composer.ts");
  assert.match(composer, /case "insertText"/);
  assert.match(composer, /case "execCommand"/);
  assert.match(composer, /humanLike: false/);
  assert.match(composer, /humanLike: true/);
});

test("验证码确认与折叠控件：Locator 点击优先，页面内 element.click 仅兜底", () => {
  const confirm = readSrc("bu_agent/point_select/human_click.ts");
  assert.match(confirm, /locator\.click/);
  assert.doesNotMatch(confirm, /\(el as HTMLElement\)\.click\(\)/);

  const precise = readSrc("core/precise_click.ts");
  assert.match(precise, /locator\.click\(\{ timeout: 2_000 \}\)/);
  assert.match(precise, /targetEl\.click\(\)/);
});
