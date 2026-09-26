/**
 * 验证码策略：唯一事实源（single source of truth）。
 *
 * 此前 `animated_captcha.ts` 与 `captcha_dispatch.ts` 各有一份 `detectCaptchaStrategy`，
 * 且前者只认 `gif_animated_dwell` 一个 id —— 两处判据必然漂移，`forceStrategy` 也因此失效
 * （强制指定任何非 GIF 策略都会被门禁判为 null）。现在合并到本模块，两边只做导入。
 *
 * 术语：
 * - **策略族 (strategy)**：对外可路由的验证码类别。
 * - **子模式 (sub-mode)**：同一个族内部的处理分支，由**字节事实**决定而非文案猜测。
 *   例如 `image_text_read` 族内部按 `isGifBuffer` 分流为动图（逐帧时长加权）与静态图（变体池）。
 *   文案只能说明「要读图里的字符」，说明不了「这张图是不是动的」——所以不给它猜的机会。
 */
export type CaptchaStrategyId =
  | "image_text_read"
  | "slider_gap_drag"
  | "math_image_solve"
  | "point_select_click"
  /** 长按类（Arkose FunCaptcha「按住不放」）：必须整体按住数秒，点一下必失败 */
  | "press_hold_captcha"
  /** P5.1：Turnstile / reCAPTCHA / hCaptcha → 第三方 solver；未配置则升 HITL */
  | "token_challenge_remote";

export const SUPPORTED_CAPTCHA_STRATEGIES: ReadonlyArray<{
  id: CaptchaStrategyId;
  title: string;
  signals: string;
}> = [
  {
    id: "image_text_read",
    title: "图片字符识别（静态图 / GIF 动图 / 迷雾 / 停留最长）",
    signals: "请输入图片中的验证码、看不清换一张、停留时间最长、迷雾动图、gif",
  },
  {
    id: "slider_gap_drag",
    title: "滑块缺口拖拽",
    signals: "请按住滑块、缺口、缓慢拖动",
  },
  {
    id: "math_image_solve",
    title: "静态算式图计算",
    signals: "验证答案、计算的结果、算式",
  },
  {
    id: "point_select_click",
    title: "点选 / 顺序点击",
    signals: "请依次点击、按顺序点击、请点击",
  },
  {
    id: "press_hold_captcha",
    title: "长按按钮（Arkose FunCaptcha / 按住不放）",
    signals: "长按按钮、長按按鈕、按住不放、press and hold、arkose、funcaptcha",
  },
  {
    id: "token_challenge_remote",
    title: "Token 挑战（Turnstile / reCAPTCHA / hCaptcha · 第三方）",
    signals: "turnstile、cf-challenge、recaptcha、hcaptcha、checking your browser",
  },
];

/**
 * Token 类人机挑战：无本地图可 OCR，须第三方或 HITL。
 * 必须排在 image_text 语义兜底之前，否则「Just a moment」会被误路由到读图。
 */
const TOKEN_CHALLENGE_RE =
  /turnstile|cf-?turnstile|cf[- ]?challenge|challenges\.cloudflare|cloudflare.*(?:challenge|security)|checking\s*your\s*browser|just\s*a\s*moment|g-?recaptcha|recaptcha|grecaptcha|h-?captcha|hcaptcha/i;

/**
 * 非图片型验证码：短信 / 邮箱 / 语音 / 动态口令。
 * 这些同样是「请输入验证码」，但图里没有可读字符——必须挡在 `image_text_read` 之外，
 * 否则会去页面上找一张图来读，空转 3 次后交人。它们走 `ask_user` 问用户要码。
 */
const NON_IMAGE_CAPTCHA_RE =
  /短信|手机号|手机验证|邮箱|邮件|语音|验证器|动态口令|一次性密码|otp|one[-\s]?time|\bsms\b|e-?mail\s*(code|verification)|authenticator/i;

/** 图片字符验证码的强信号：明确指向「看图中的字符」。 */
const IMAGE_TEXT_SIGNAL_RE =
  /请输入(图片|图中|下图|图示)|图片中的(验证码|字符)|图中的(字符|验证码)|下图|画面中的|看不清|看不清楚|换一张|换一换|点击更换|字符验证码|字母验证码|数字验证码|图形验证码|captcha\s*image|image\s*captcha|characters?\s*(you\s*see|shown|below|above)|code\s*(shown|below|above)|distorted|扭曲|变形|噪点|干扰线|杂色|模糊/i;

/** 动图特有信号：命中即属于本族的动图分支（权重来自逐帧时长）。 */
const ANIMATED_SIGNAL_RE =
  /停留时间最长|迷雾|动图验证|动图|animated\s*captcha|\bgif\b|gif\s*验证/i;

/**
 * 页面出现验证码语义（用于「同页消歧」与兜底，不允许单独决定策略）。
 */
const CAPTCHA_SEMANTICS_RE =
  /captcha|验证码|验证|人机|challenge|verify\s*you\s*are\s*human|滑块|滑动|点选|动图|迷雾|驗證碼|人機|人類|機器人|您是人/i;

/**
 * 长按类验证码信号（强）：明确是「按住按钮/不放」的指令 —— 含按钮字样或验证语境，
 * 单独出现即可成立。多语言：中简繁、英、日、韩常见写法。
 */
const PRESS_HOLD_STRONG_RE =
  /长按(按钮|按鈕|按键|按鍵|不放|此处|此處|这里|這裡)|長按(按鈕|按鍵|不放|此處|這裡)|按住(按钮|按鈕|不放|別放|别放)|按著(按鈕|不放)|长按验证|長按驗證|press\s*(and|&)\s*hold|touch\s*(and|&)\s*hold|click\s*(and|&)\s*hold|tap\s*(and|&)\s*hold|hold\s*(the\s*)?(button|down\s*to|to\s*(verify|continue|proceed))|押し続け|長押し|누르고\s*있|길게\s*누르/i;

/**
 * 长按类验证码信号（弱）：只有「按住 / hold」这类短指令词。
 * 文案差异极大的站点也常这么写，但它单独出现**不足以**判定为验证码
 * （普通页面里「按住 Shift 键」也会命中），必须与验证码语义或 Arkose 容器共存。
 */
const PRESS_HOLD_WEAK_RE =
  /按住|按著|長按|长按|\bhold\b|押し続け|長押し|누르고|길게\s*누르/i;

/**
 * Arkose Labs / FunCaptcha 容器与资源标识（iframe src/id、脚本域名、页面参数都会带）。
 * Arkose 当前主流挑战就是「按住不放」，识别到它即优先交给长按求解器；
 * 若不是长按题型，求解器会诚实地返回 unsupported（按形状在挑战区内找宽扁主控件），
 * 而不是空转或凭空猜坐标。
 */
const ARKOSE_RE = /arkose|funcaptcha|fc-iframe|arkoselabs|arkose-labs/i;

/** 滑块语义：「按住滑块」里的「按住」不是长按题，必须让滑块族优先。 */
const SLIDER_ISH_RE =
  /请按住滑块|按住滑块|拖动滑块|缓慢拖动到合适位置|缺口|slider\s*gap|slide\s*captcha/i;

/** 长按题型与验证码语义必须共存的判定（见 PRESS_HOLD_WEAK_RE 注释） */
function looksPressHoldChallenge(blob: string): boolean {
  // Arkose 容器是长按题最强的结构证据（与页面文案无关）。
  if (ARKOSE_RE.test(blob)) return true;
  if (PRESS_HOLD_STRONG_RE.test(blob)) return true;
  // 弱信号必须与验证码语义共存，且不能被滑块题面（「按住滑块」）抢走。
  if (SLIDER_ISH_RE.test(blob)) return false;
  return PRESS_HOLD_WEAK_RE.test(blob) && CAPTCHA_SEMANTICS_RE.test(blob);
}

export function detectCaptchaStrategy(input: {
  pageText: string;
  pageUrl: string;
  goalHint?: string;
  forceStrategy?: string;
}): CaptchaStrategyId | null {
  const force = String(input.forceStrategy ?? "").trim();
  if (force) {
    if (force === "image_text_read") return "image_text_read";
    // 兼容旧 id：动图是这个族的一个子模式，强制指定时归一化到族
    if (force === "gif_animated_dwell") return "image_text_read";
    if (
      force === "slider_gap_drag" ||
      force === "math_image_solve" ||
      force === "point_select_click" ||
      force === "press_hold_captcha" ||
      force === "token_challenge_remote"
    ) {
      return force;
    }
    // 友好别名 → 统一族 id
    if (/^(turnstile|recaptcha|hcaptcha|cf[_-]?turnstile)$/i.test(force)) {
      return "token_challenge_remote";
    }
    if (/^(arkose|funcaptcha|fc|press[_-]?hold|press-hold|long[_-]?press)$/i.test(force)) {
      return "press_hold_captcha";
    }
    return null;
  }

  // 优先看页面（URL+可见文案）；goalHint 仅作弱回退，并剥掉 topic/N 避免串题误路由
  const pageBlob = `${input.pageText}\n${input.pageUrl}`;
  const goalSafe = String(input.goalHint ?? "")
    .replace(/match2025\/topic\/\d+/gi, "")
    .replace(/\btopic\/\d+\b/gi, "");

  const pick = (blob: string): CaptchaStrategyId | null => {
    // 长按类（Arkose FunCaptcha 等）：最特殊、点一下就必失败，必须最先判出。
    if (looksPressHoldChallenge(blob)) {
      return "press_hold_captcha";
    }

    if (
      /滑块缺口|请按住滑块|缓慢拖动到合适位置|缺口之涟漪|slider\s*gap|slide\s*captcha/i.test(
        blob,
      ) ||
      (/滑块|拼图缺口|拖动滑块/i.test(blob) &&
        !/停留时间最长|迷雾动图|\.gif|验证答案|依次点击|按顺序点击/i.test(blob))
    ) {
      return "slider_gap_drag";
    }

    if (
      /验证答案|计算的结果|输入计算|算式验证|数学验证码/i.test(blob) ||
      (/提交参赛代码/i.test(blob) && /验证答案|计算/i.test(blob))
    ) {
      if (!/请按住滑块|停留时间最长|迷雾动图|依次点击|按顺序点击|请点击[「"“]/i.test(blob)) {
        return "math_image_solve";
      }
    }

    if (
      /点击变换|请依次|按顺序点击|依次按照顺序点击|请点击[「"“]/i.test(blob) ||
      (/请点击/i.test(blob) && /球体|左侧|右侧|上方|下方|图标|字符|三角|柱体/i.test(blob))
    ) {
      if (!/请按住滑块|停留时间最长|验证答案|计算的结果/i.test(blob)) {
        return "point_select_click";
      }
    }

    // Token 挑战（Turnstile 等）优先于读图兜底，避免「Just a moment」被当成图片字符。
    if (TOKEN_CHALLENGE_RE.test(blob)) {
      return "token_challenge_remote";
    }

    // 图片字符族（最后落位，故滑块/点选/算式/token 永远优先，不会被抢路由）。
    if (NON_IMAGE_CAPTCHA_RE.test(blob)) return null;

    if (ANIMATED_SIGNAL_RE.test(blob)) return "image_text_read";

    if (
      IMAGE_TEXT_SIGNAL_RE.test(blob) &&
      !/请按住滑块|缓慢拖动|依次点击|按顺序点击|验证答案|计算的结果/i.test(blob)
    ) {
      return "image_text_read";
    }

    // 兜底：页面确有验证码语义、且已被上面的强特征类型排除 → 按图片字符族处理。
    // 这里不敢再放宽：`CAPTCHA_SEMANTICS_RE` 必须命中，纯粹靠 URL 或 goal 一律不路由。
    if (
      CAPTCHA_SEMANTICS_RE.test(blob) &&
      !TOKEN_CHALLENGE_RE.test(blob) &&
      !/请按住滑块|缓慢拖动|依次点击|按顺序点击|验证答案|计算的结果|点击变换/i.test(blob)
    ) {
      return "image_text_read";
    }

    return null;
  };

  const fromPage = pick(pageBlob);
  if (fromPage) return fromPage;

  // goal 仅作「同页消歧」补充，绝不单独决定策略：页面本身必须已有验证码语义，
  // 否则会把上一任务残留的滑块/点选目标词套到当前无验证码的页面上，路由到错误策略并空转。
  const pageLooksLikeCaptcha =
    /captcha|验证码|驗證碼|验证|驗證|人机|人機|人類|機器人|challenge|verify\s*you\s*are\s*human|滑块|滑动|点选|动图|迷雾|按住/i.test(
      pageBlob,
    );
  return pageLooksLikeCaptcha ? pick(`${pageBlob}\n${goalSafe}`) : null;
}

/**
 * 人机验证闸门信号：页面是不是「必须先过验证码才能继续」的闸门。
 *
 * 与 `detectCaptchaStrategy` 的区别：后者只回答「用哪个求解器」，本函数回答
 * 「当前页是不是一道闸门」——运行期据此**拦截 navigate/done 等动作并强制走验证码路径**，
 * 与用户目标怎么写无关（用户不会在目标里写「遇到验证码就解」）。
 *
 * 精度优先：只有当页面出现明确的验证码语义时才判 present，绝不用裸 URL 或裸「验证」触发，
 * 避免把普通页面误当成闸门而劫持任务。
 */
const CAPTCHA_GATE_RE =
  /captcha|验证码|人机验证|安全验证|安全校验|滑块验证|点选验证|拖动滑块|按住滑块|按顺序点击|请依次点击|完成验证|验证失败|环境异常|访问验证|长按(按钮|按鈕)|長按(按鈕|按鍵)|按住(按钮|按鈕|不放|別放|别放)|按著不放|press\s*(and|&)\s*hold|touch\s*(and|&)\s*hold|arkose|funcaptcha|fc-iframe|verify\s*you\s*are\s*human|are\s*you\s*a\s*robot|checking\s*your\s*browser|just\s*a\s*moment|cf[- ]?challenge/i;

export interface CaptchaGateSignal {
  /** 当前页是否出现人机验证语义 */
  present: boolean;
  /** 可路由的求解策略；null = 页面像验证码但当前无法自动求解 */
  strategy: CaptchaStrategyId | null;
  /** 非图片型（短信/邮箱/验证器动态码）：只能问用户要码，不能自动求解 */
  nonImage: boolean;
  /** 命中的信号原文（日志/提示用） */
  matched: string | null;
  /**
   * 是否「整页验证闸门」（interstitial）：整页就是一道必须通过的验证题。
   * 只有它为 true 时运行期才会**强制**把动作收敛到 solve_captcha ——
   * 普通表单里嵌着一个验证码控件不算闸门（那种页面还有一堆别的事要做，
   * 强行接管会把整个任务做废）。
   */
  interstitial: boolean;
}

/** 独立验证页通常控件极少（输入框 + 提交 + 刷新）；超过这个数就不像「整页就一道题」 */
const INTERSTITIAL_MAX_ELEMENTS = 12;

/** 与验证无关但也不需要「其它业务内容」的通用控件词：它们不降低「整页就是验证」的置信度 */
const NEUTRAL_CONTROL_RE =
  /提交|确定|确认|继续|下一步|下一页|关闭|取消|刷新|重试|换一张|换一换|返回|跳过|我已知晓|我知道了|submit|confirm|continue|next|close|cancel|refresh|reload|retry|back|skip|dismiss|ok/i;

/**
 * 独立验证页判据：标题/URL 本身即验证页，或页面控件里**除了验证类与通用按钮之外再无其它业务内容**。
 * 这条比「控件数量阈值」可靠得多 —— 一个注册表单里有邮箱/密码/手机号/勾选框等一堆无关控件，
 * 即便数量不多也不会被判成验证闸门，从而不会被运行期强行接管。
 */
function looksStandaloneGate(controlLabels: string[] | undefined, elementCount: number | undefined): boolean {
  if (!controlLabels || controlLabels.length === 0) {
    return elementCount === undefined ? true : elementCount <= INTERSTITIAL_MAX_ELEMENTS;
  }
  let others = 0;
  for (const raw of controlLabels) {
    const label = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (label.length <= 1) continue;
    if (CAPTCHA_GATE_RE.test(label)) continue;
    if (NEUTRAL_CONTROL_RE.test(label)) continue;
    others += 1;
    if (others > 2) return false;
  }
  return others <= 2;
}

export function detectCaptchaGate(input: {
  pageText: string;
  pageUrl: string;
  goalHint?: string;
  /** 当前可交互元素文案：判断是否「整页验证」的关键信号 */
  controlLabels?: string[];
  elementCount?: number;
  title?: string;
}): CaptchaGateSignal {
  const blob = `${input.pageText}\n${input.pageUrl}`;
  const matched = blob.match(CAPTCHA_GATE_RE)?.[0] ?? null;
  const strategy = detectCaptchaStrategy(input);
  const present = Boolean(strategy) || matched != null;
  if (!present) {
    return { present: false, strategy: null, nonImage: false, matched: null, interstitial: false };
  }
  const nonImage = NON_IMAGE_CAPTCHA_RE.test(blob) && CAPTCHA_SEMANTICS_RE.test(blob);
  const titleBlob = `${input.title ?? ""}\n${input.pageUrl}`;
  const titleLooksGate = CAPTCHA_GATE_RE.test(titleBlob);
  return {
    present: true,
    strategy,
    nonImage,
    matched,
    interstitial: titleLooksGate || looksStandaloneGate(input.controlLabels, input.elementCount),
  };
}
