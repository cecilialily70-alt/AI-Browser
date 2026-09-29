/**
 * 沙盘字段造数本地兜底回归
 * 运行：npm run build && node --test tests/field-mock.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("localValueForSandboxField：邮箱/姓名/密码有值；OTP 不编造", async () => {
  const { localValueForSandboxField } = await import("../dist/field_mock.js");

  const email = localValueForSandboxField({
    envId: "5",
    key: "xpath=/email",
    label: "電子郵件",
  });
  assert.ok(email && email.includes("@"), email);

  const last = localValueForSandboxField({
    envId: "5",
    key: "xpath=/last",
    label: "姓氏 lastNameInput",
  });
  assert.ok(last && last.length >= 2, last);

  const pwd = localValueForSandboxField({
    envId: "5",
    key: "xpath=/pwd",
    label: "密碼",
  });
  assert.ok(pwd && pwd.length >= 10, pwd);
  assert.match(pwd, /^Aa1!/);

  const otp = localValueForSandboxField({
    envId: "5",
    key: "xpath=/otp",
    label: "验证码 otp",
  });
  assert.equal(otp, null);

  const a = localValueForSandboxField({
    envId: "5",
    key: "k1",
    label: "姓氏",
  });
  const b = localValueForSandboxField({
    envId: "5",
    key: "k1",
    label: "姓氏",
  });
  assert.equal(a, b);
});

test("源码级：模型不吐 JSON 须本地兜底，禁止整表抛 DATA_PLANNER_FAILED", () => {
  const src = readFileSync(join(SIDECAR_ROOT, "src/field_mock.ts"), "utf8");
  assert.ok(src.includes("usedLocalFallback"), "须有本地兜底分支");
  assert.ok(src.includes("模型未返回可用 JSON，已用本地确定性值填充"), "须有可读 summary");
  assert.ok(src.includes("localValueForSandboxField"), "须导出/使用本地单字段造数");
});
