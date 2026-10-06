/**
 * 通用切语言：确定性脚本优先（无站点硬编码）。
 * 流水线：感知命中文案 → 目标语短码 → 语言入口探针 →（耗尽后才交给 LLM/视觉）
 *
 * 重要：仅「切换网站 UI 语言」走本模块。
 * 「用希伯来语/英文填写资料」属于 fill_locale，禁止误判为切语言。
 */

import {
  FILL_LOCALE_FRAME_RE,
  isFillLocaleGoal,
  LANGUAGE_NAME_RE,
  LANGUAGE_SWITCH_VERB_RE,
} from "./fill_locale.js";
/**
 * 是否要求切换网站/界面语言。
 * 「使用X语随机资料填写」等填资料语种目标必须返回 false。
 */
export function isLanguageSwitchGoal(goal: string): boolean {
  const g = String(goal ?? "");
  if (!g.trim()) {
    return false;
  }
  // 填资料语种优先：用/使用/以 X 语填写 → 绝不切 UI
  if (isFillLocaleGoal(g) && !LANGUAGE_SWITCH_VERB_RE.test(g)) {
    return false;
  }
  if (FILL_LOCALE_FRAME_RE.test(g) && !LANGUAGE_SWITCH_VERB_RE.test(g)) {
    return false;
  }
  if (LANGUAGE_SWITCH_VERB_RE.test(g)) {
    return true;
  }
  // 短指令：「切语言」「换语言」
  if (/^(?:请)?(?:帮我)?(?:切|换|改)(?:一下)?语言/i.test(g.trim())) {
    return true;
  }
  // 「把页面弄成英文」类且无填表意图
  if (
    LANGUAGE_NAME_RE.test(g) &&
    /(?:页面|界面|网站|网页|站点).{0,12}(?:英|中|希伯来|hebrew|arabic|日|韩|文|语)/i.test(g) &&
    !/(?:填|资料|随机|注册|登录|表单)/i.test(g)
  ) {
    return true;
  }
  return false;
}
