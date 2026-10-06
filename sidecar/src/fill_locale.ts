/**
 * 填表资料语种（Fill Locale）——与「切网站 UI 语言」严格分离。
 *
 * 用户说「用希伯来语填写 / 使用英文随机资料」= 生成该语种/地区的表单值，
 * 不是去点语言菜单把界面切成希伯来语/英文。
 *
 * 举一反三：he / en / zh / ar / ja / ko … 同一套语义，禁止再为单语种加旁路。
 */

/** 语种名提及（ alone ≠ 切语言） */
export const LANGUAGE_NAME_RE =
  /hebrew|希伯来|希伯來|עברית|english|英语|英文|中文|简体|繁體|繁体|chinese|arabic|阿拉伯|العرب|日本語|日语|日文|japanese|한국어|韩语|韩文|korean|法语|法文|french|德语|德文|german|西班牙语|spanish|俄语|俄文|russian|泰语|thai|越南语|vietnamese|葡萄牙|portuguese|意大利语|italian/i;

/**
 * 明确「切换网站/界面语言」的动词框架。
 * 只有命中这类才走切语言脚本；「使用X语填写」不得命中。
 */
export const LANGUAGE_SWITCH_VERB_RE =
  /(?:切换|改换|更换).{0,6}(?:语言|語|语种|locale|language)|(?:语言|語|语种|locale|language).{0,8}(?:切换|改成|换成|调成|设置|设成|设为|改为)|设成|设置成|设为|改成.{0,6}(?:语|文|hebrew|english|中文|arabic)|换成.{0,6}(?:语|文|hebrew|english|中文)|调成.{0,6}(?:语|文)|切到.{0,6}(?:语|文)|界面.{0,10}(?:英|中|希伯来|hebrew|arabic|日|韩)|网站.{0,10}(?:改成|换成|设成|设为).{0,8}(?:语|文|hebrew|english)|网页.{0,10}(?:改成|换成|设成)|switch\s+(?:the\s+)?(?:site\s+)?language|change\s+(?:the\s+)?language|set\s+(?:the\s+)?language\s+to|language\s+to\s+/i;

/** 「用某语种写资料」框架（填资料，不切 UI） */
export const FILL_LOCALE_FRAME_RE =
  /(?:使用|用|以|按|用上).{0,10}(?:希伯来|希伯來|hebrew|עברית|英文|英语|english|中文|简体|繁體|阿拉伯|arabic|日语|日文|韩语|韩文).{0,16}(?:填|写|资料|信息|姓名|地址|电话|随机|表单|注册)|(?:希伯来|希伯來|hebrew|עברית|英文|英语|english|中文|阿拉伯|arabic).{0,8}(?:资料|姓名|地址|随机填|填写)|(?:in|with)\s+(?:hebrew|english|chinese|arabic|japanese|korean).{0,12}(?:fill|name|address|data|form|random)|(?:hebrew|english|chinese|arabic)\s+(?:name|address|data|fill|form)/i;

const FILL_INTENT_RE =
  /填|写|资料|信息|表单|注册|登录|随机|结账|checkout|register|login|sign\s*up|sign\s*in|姓名|地址|电话|手机|email|邮箱/i;

/** 目标是否在要求「按某语种生成填表资料」（而非切 UI） */
export function isFillLocaleGoal(goal: string): boolean {
  const g = String(goal ?? "");
  if (!g.trim()) {
    return false;
  }
  if (FILL_LOCALE_FRAME_RE.test(g)) {
    return true;
  }
  // 有填表意图 + 语种名 + 没有切语言动词 → 视为填资料语种
  if (FILL_INTENT_RE.test(g) && LANGUAGE_NAME_RE.test(g) && !LANGUAGE_SWITCH_VERB_RE.test(g)) {
    return true;
  }
  return false;
}
