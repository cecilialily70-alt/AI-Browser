/**
 * 联系人身份比对纯函数测试
 */
import assert from "node:assert/strict";
import test from "node:test";

import { contactsMatch, digitsOfContact } from "../dist/bu_agent/contact_identity.js";

test("digitsOfContact 抽出数字", () => {
  assert.equal(digitsOfContact("+852 2656 565"), "8522656565");
  assert.equal(digitsOfContact("Anne"), "");
});

test("contactsMatch：电话号格式变体视为同一人", () => {
  assert.equal(contactsMatch("8522656565", "+852 2656 565"), true);
  assert.equal(contactsMatch("8522656565", "852-2656-565"), true);
  assert.equal(contactsMatch("8522656565", "85265681111"), false);
});

test("contactsMatch：昵称大小写不敏感", () => {
  assert.equal(contactsMatch("Bob", "bob"), true);
  assert.equal(contactsMatch("Alice", "Bob"), false);
});
