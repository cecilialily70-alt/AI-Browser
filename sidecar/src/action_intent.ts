/**
 * 动作意图层：根据目标 + 控件类型，决定「该填还是该点」。
 * 规则优先于 LLM 空想，减少空转思考。
 */

/** 主 CTA（提交/注册）——命中则绝不当成协议链接 */
export function isPrimarySubmitClickLabel(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) {
    return false;
  }
  return /立即注册|马上注册|提交注册|注册账号|sign\s*up(\s*now)?|create\s*account|register(\s*now)?|join(\s*now)?|登录|登入|提交|下一步|confirm|pay\s*now|checkout|אישור|המשך|לתשלום|סיום|שלח|הירשמ|הרשמ/i.test(
    t,
  );
}

/**
 * 点击目标是否像「协议/条款/隐私」文档链（非主提交钮）。
 * 覆盖 EN agreement/treaty/terms、中文协议/条款、希伯来 תקנון 等；禁止站点特例。
 */
export function isAgreementOrTermsClickLabel(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) {
    return false;
  }
  // 主 CTA 优先：即使文案里碰巧含 agree，也不当协议链
  if (isPrimarySubmitClickLabel(t)) {
    return false;
  }
  // 纯复选框确认短句（无文档名）允许点，用于勾选同意
  if (
    /^(i\s*(know\s+and\s+)?agree|agree|同意|我同意|已阅读并同意|אני\s*מסכים|מאשר)$/i.test(t) &&
    !/agreement|treaty|terms|privacy|policy|协议|条款|条约|תקנון|הסכם/i.test(t)
  ) {
    return false;
  }
  return /\bagreement\b|\btreat(?:y|ies)\b|\bterms(?:\s+of\s+(?:service|use|use\s+and\s+service))?\b|\bprivacy(?:\s+policy)?\b|\bpolicy\b|\beula\b|\btos\b|disclaimer|协议|条款|条约|开户协议|用户协议|服务协议|隐私(?:政策|权)?|知晓并同意|已阅读并同意|תקנון|פרטיות|תנאי\s*שימוש|הסכם/i.test(
    t,
  );
}
