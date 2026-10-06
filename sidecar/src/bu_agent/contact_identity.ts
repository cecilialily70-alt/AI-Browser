/**
 * 联系人身份比对（纯函数）：电话号去标点、昵称大小写不敏感。
 * 用于「当前对话窗是否已是目标人」——一致则跳过列表点击。
 */

/** 抽出电话号数字（无数字则空串） */
export function digitsOfContact(raw: string): string {
  return String(raw ?? "").replace(/\D+/g, "");
}

/**
 * 判断两个展示名/号码是否同一人。
 *
 * - 全文忽略大小写相等
 * - 双方都有 ≥6 位数字时比数字（含国家码后缀兼容：`8522656565` vs `+852 2656 5655`）
 * - 否则看归一化文本互相包含
 */
export function contactsMatch(a: string, b: string): boolean {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return false;

  const ln = left.toLowerCase().replace(/\s+/g, " ");
  const rn = right.toLowerCase().replace(/\s+/g, " ");
  if (ln === rn) return true;

  const ld = digitsOfContact(left);
  const rd = digitsOfContact(right);
  if (ld.length >= 6 && rd.length >= 6) {
    if (ld === rd) return true;
    if (ld.endsWith(rd) || rd.endsWith(ld)) return true;
  }

  if (ln.includes(rn) || rn.includes(ln)) return true;
  return false;
}
