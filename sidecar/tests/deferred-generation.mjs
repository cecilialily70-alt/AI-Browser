/**
 * 沙盘 JIT / 确定性本地兜底回归
 * 运行：npm run build && node --test tests/deferred-generation.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

test("buildDeterministicLocalValue：邮箱用 uniqueId，用户名用 user 前缀", async () => {
  const {
    buildDeterministicLocalValue,
    isEmailOrUsernameField,
    isMustUserProvideField,
  } = await import("../dist/deferred_generation.js");

  assert.equal(isEmailOrUsernameField("電子郵件", "email"), true);
  assert.equal(isEmailOrUsernameField("username", "text"), true);
  assert.equal(isMustUserProvideField("密码", "password"), true);
  assert.equal(isMustUserProvideField("验证码", "text"), true);
  assert.equal(isMustUserProvideField("電子郵件", "email"), false);

  const email = buildDeterministicLocalValue("電子郵件 email", "email", {
    run: { uniqueId: 42, seq: 0, envId: "7", runSeed: 1 },
  });
  assert.equal(email, "replay42@example.com");

  const user = buildDeterministicLocalValue("用户名 username", "text", {
    run: { uniqueId: 99, seq: 1, envId: "3", runSeed: 1 },
  });
  assert.equal(user, "user99");

  assert.equal(
    buildDeterministicLocalValue("密码", "password", {
      run: { uniqueId: 1, seq: 0, envId: "1", runSeed: 1 },
    }),
    null,
  );
  assert.equal(
    buildDeterministicLocalValue("验证码 otp", "text", {
      run: { uniqueId: 1, seq: 0, envId: "1", runSeed: 1 },
    }),
    null,
  );
});

test("buildDeterministicReplayPassword：复杂度与可复现", async () => {
  const {
    buildDeterministicReplayPassword,
    isReplayablePasswordField,
    isOneTimeOrPaymentSecretField,
  } = await import("../dist/deferred_generation.js");
  assert.equal(isReplayablePasswordField("密碼", "password"), true);
  assert.equal(isOneTimeOrPaymentSecretField("驗證碼", "text"), true);
  assert.equal(isOneTimeOrPaymentSecretField("密碼", "password"), false);
  const a = buildDeterministicReplayPassword({ run: { uniqueId: "99", runSeed: 1 } });
  const b = buildDeterministicReplayPassword({ run: { uniqueId: "99", runSeed: 1 } });
  assert.equal(a, b);
  assert.ok(a.length >= 10, a);
  assert.match(a, /^Aa1!/);
});

test("buildDeterministicLocalValue：无 uniqueId 时用 seed 派生，仍非空", async () => {
  const { buildDeterministicLocalValue } = await import("../dist/deferred_generation.js");
  const value = buildDeterministicLocalValue("email", "email", {
    run: { uniqueId: null, seq: 2, envId: "abc123", runSeed: 12345, index: 2 },
  });
  assert.ok(value && value.endsWith("@example.com"), value);
  assert.match(value, /^replay\d+@example\.com$/);
});

test("buildDeterministicLocalValue：姓氏/名字本地兜底，优先人设", async () => {
  const {
    buildDeterministicLocalValue,
    isPersonNameField,
    personNameKind,
  } = await import("../dist/deferred_generation.js");

  assert.equal(isPersonNameField("姓氏 lastNameInput", "text"), true);
  assert.equal(isPersonNameField("名字", "text"), true);
  assert.equal(isPersonNameField("用户名 username", "text"), false);
  assert.equal(personNameKind("姓氏 lastNameInput input text", "text"), "last");
  assert.equal(personNameKind("名字 firstNameInput", "text"), "first");

  const last = buildDeterministicLocalValue("姓氏 lastNameInput input text", "text", {
    run: { uniqueId: 7, seq: 0, envId: "5", runSeed: 99, index: 0 },
  });
  const last2 = buildDeterministicLocalValue("姓氏 lastNameInput input text", "text", {
    run: { uniqueId: 7, seq: 0, envId: "5", runSeed: 99, index: 0 },
  });
  assert.ok(last && last.length >= 2, last);
  assert.equal(last, last2);

  const first = buildDeterministicLocalValue("名字", "text", {
    run: { uniqueId: 7, seq: 0, envId: "5", runSeed: 99, index: 0 },
  });
  assert.ok(first && first.length >= 2, first);
  assert.notEqual(first, last);

  const fromPersona = buildDeterministicLocalValue(
    "姓氏",
    "text",
    { run: { uniqueId: 1, seq: 0, envId: "1", runSeed: 1, index: 0 } },
    { lastName: "Wong", firstName: "Kai" },
  );
  assert.equal(fromPersona, "Wong");

  const given = buildDeterministicLocalValue(
    "名字",
    "text",
    { run: { uniqueId: 1, seq: 0, envId: "1", runSeed: 1, index: 0 } },
    { lastName: "Wong", firstName: "Kai" },
  );
  assert.equal(given, "Kai");
});

test("源码级：JIT 空值须本地兜底或可操作报错，禁止神秘 JIT 造数返回空值", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "src/deferred_generation.ts"), "utf8");
  assert.ok(!src.includes("JIT 造数返回空值"), "不得再抛神秘 JIT 造数返回空值");
  assert.ok(src.includes("sandbox_jit_local_fallback"), "空值须记本地兜底");
  assert.ok(src.includes("buildDeterministicLocalValue"), "须有确定性本地值");
  assert.ok(src.includes("请在沙盘填固定值"), "敏感空值须可操作提示");
});
