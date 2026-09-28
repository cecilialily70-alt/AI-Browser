/**
 * 回合意图分类（先听后说）—— 纯规则、零 LLM。
 *
 * 发送前先看对方未回复在说什么：信任攻击 / 问价 / 纠错 / 直接提问必须先答，
 * 禁止同一轮继续倒产品脚本（Anne「你是骗子吗」却回 Apple18 散热的现场；
 * 「价格多少」却回「还没官宣给不了」也算没答）。
 */
import type { ChatMessage } from "./conversation_extract.js";

export type TurnIntentKind =
  | "trust_attack"
  | "price_question"
  | "fact_correction"
  | "direct_question"
  | "objection"
  | "continue";

export interface TurnIntent {
  kind: TurnIntentKind;
  /** 合并后的对方原文（截断），供提示词与诊断 */
  excerpt: string;
}

const TRUST_ATTACK_RE =
  /(骗子|诈骗|骗钱|托儿|托吗|是不是机器人|你是机器人|ai\b|chatgpt|gpt|假人|营销号|广告|scam|fraud|bot\b|robot|are you (a )?bot|are you (an )?ai)/i;

/** 对方在问价（商业目标下必须给大致价，不许空推「没官宣」） */
const PRICE_ASK_RE =
  /(价格|多少钱|报价|售价|什么价|贵不贵|怎么卖|贵多少|怎么定价|价位|price\b|how much|\bcost\b)/i;

/** 对方在纠正我方说错的事实（发布日、是否上市等） */
const FACT_CORRECTION_RE =
  /(早就|已经发布|都发布了|你说错|说错了|不对吧|明明|官宣了|发售了|上市了|不是没|你搞错|别装不知道|都出来了|都上了)/i;

const DIRECT_QUESTION_RE =
  /(吗\s*[?？]?|[?？]|为什么|怎么|怎样|何处|哪里|哪个|多少|几个|谁|何时|什么时候|what|why|how|when|where|who|which|\bis\b|\bare\b)/i;

const OBJECTION_RE =
  /(没兴趣|用不上|不需要|不考虑|算了|太贵|贵了|别烦|不要再|不聊|滚|no thanks|not interested|too expensive)/i;

/** 推销/产品推进口吻（在信任攻击或未答问题时出现即违规） */
const PITCH_RE =
  /(苹果\s*\d+|iphone|散热|帧率|测评|实测|入手|下单|优惠|性价比|配置|推荐你|一定要|错过|库存|发货|包邮)/i;

/** 像在正面回应信任质问 */
const TRUST_ANSWER_RE =
  /(不是骗子|不是机器人|真人|我是人|真实|误会|为什么这么问|你放心|不是托)/i;

/** 像在正面回应问题（含问号回问或直接答） */
const ANSWERISH_RE = /(因为|所以|其实|我这边|你说的|关于你问|问的是|[?？])/;

/** 问价时用「还没官宣 / 给不了」搪塞 = 没答 */
const PRICE_HEDGE_RE =
  /(还没(正式)?官宣|给不了|没法报|不确定.*价|等(着)?官宣|暂时(还)?不知道|没有(准确)?(的)?(价格|数字)|我这边也不清楚价|不便透露价)/i;

/** 像在给价或至少落到可交易信息（数字 / 区间 / 问配置） */
const PRICE_ANSWER_RE =
  /(\d{3,}|\d+\s*万|￥|\$|元|块|大概|左右|区间|起|配置|容量|版本|渠道)/;

/** 像在承认纠错 */
const CORRECTION_ACK_RE =
  /(你说得对|确实|是我记错|记错了|我搞错|搞错了|抱歉|不好意思|对你说的|已经发布|已经上市)/i;

function incomingTextOf(messages: readonly ChatMessage[]): string {
  return messages
    .filter((message) => message.direction === "in")
    .map((message) => String(message.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

export function classifyTurnIntent(messages: readonly ChatMessage[]): TurnIntent {
  const excerpt = incomingTextOf(messages).slice(0, 500);
  if (!excerpt) return { kind: "continue", excerpt: "" };
  if (TRUST_ATTACK_RE.test(excerpt)) return { kind: "trust_attack", excerpt };
  // 纠错优先于泛化提问：对方先戳穿「还没发布」时，本轮必须认错接住
  if (FACT_CORRECTION_RE.test(excerpt)) return { kind: "fact_correction", excerpt };
  if (PRICE_ASK_RE.test(excerpt)) return { kind: "price_question", excerpt };
  if (OBJECTION_RE.test(excerpt) && !DIRECT_QUESTION_RE.test(excerpt)) {
    return { kind: "objection", excerpt };
  }
  if (DIRECT_QUESTION_RE.test(excerpt)) return { kind: "direct_question", excerpt };
  return { kind: "continue", excerpt };
}

/**
 * 草稿是否违背本轮意图：信任攻击/问价/纠错/直接提问时，倒产品却不答 = 违规。
 */
export function draftViolatesIntent(text: string, intent: TurnIntent): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return true;
  if (intent.kind === "trust_attack") {
    if (TRUST_ANSWER_RE.test(raw)) return false;
    // 含推销且没有正面澄清 → 违规
    if (PITCH_RE.test(raw)) return true;
    // 完全不沾信任话题、却像在继续剧本
    if (!TRUST_ATTACK_RE.test(raw) && PITCH_RE.test(raw)) return true;
    if (!TRUST_ANSWER_RE.test(raw) && !/(不是|真人|误会|为什么问)/.test(raw) && PITCH_RE.test(raw)) {
      return true;
    }
    // 信任攻击下纯推销（无澄清词）
    return PITCH_RE.test(raw) && !TRUST_ANSWER_RE.test(raw);
  }
  if (intent.kind === "price_question") {
    // 空推「没官宣 / 给不了」且没有任何价位信息 → 违规（现场：Anne 问价却永远不报）
    if (PRICE_HEDGE_RE.test(raw) && !PRICE_ANSWER_RE.test(raw)) return true;
    if (PITCH_RE.test(raw) && !PRICE_ANSWER_RE.test(raw) && !ANSWERISH_RE.test(raw)) return true;
    return false;
  }
  if (intent.kind === "fact_correction") {
    // 死撑旧说法、或再次用「还没官宣」搪塞 → 违规
    if (PRICE_HEDGE_RE.test(raw) && !CORRECTION_ACK_RE.test(raw)) return true;
    if (!CORRECTION_ACK_RE.test(raw) && PITCH_RE.test(raw) && !ANSWERISH_RE.test(raw)) return true;
    return false;
  }
  if (intent.kind === "direct_question") {
    if (PITCH_RE.test(raw) && !ANSWERISH_RE.test(raw) && !DIRECT_QUESTION_RE.test(raw)) {
      return true;
    }
  }
  return false;
}

/** 本轮最多几句气泡：默认 1；对方一口气多条未回复才放宽到 2～3；信任攻击/纠错最多 2 */
export function maxBubblesForTurn(
  incoming: readonly ChatMessage[],
  intent: TurnIntent,
): number {
  if (intent.kind === "trust_attack" || intent.kind === "fact_correction") return 2;
  const inCount = incoming.filter((message) => message.direction === "in").length;
  // 单条提问/闲聊 → 只回 1 句（「价格多少」被拆成两句推销 = 不连贯）
  if (inCount >= 2) return Math.min(3, inCount);
  return 1;
}

/** 意图约束写进提示词的短指令 */
export function intentPromptDirective(intent: TurnIntent): string | null {
  switch (intent.kind) {
    case "trust_attack":
      return "对方在质疑你是骗子/机器人/托：必须先正面回应这个质疑（澄清你是真人、解释误会），本轮禁止推销产品或继续上一套话术。";
    case "price_question":
      return "对方在问价格：必须给出你这边的渠道大致价或常见价位区间（可说大概/左右），并问清要哪个版本/容量；禁止只说「还没官宣 / 给不了数字」。";
    case "fact_correction":
      return "对方在纠正你之前说错的事实：先承认对方说得对，按对方的说法接住；若同时在问价，就给出渠道大致价。禁止再坚持「还没发布 / 没官宣」。";
    case "direct_question":
      return "对方有明确问题：先回答问题；答完前不要新开推销角度。";
    case "objection":
      return "对方表示没兴趣或异议：先承认对方的态度，再决定是否换角度；不要假装没看见继续倒脚本。";
    default:
      return null;
  }
}

/** 去重/意图违规后的强制重写提示 */
export function intentRewriteHint(intent: TurnIntent): string {
  if (intent.kind === "trust_attack") {
    return `上一版草稿没有正面回答对方的信任质疑（「${intent.excerpt.slice(0, 80)}」）。请先澄清你不是骗子/机器人，不要提产品。`;
  }
  if (intent.kind === "price_question") {
    return `上一版草稿没有报出价格（「${intent.excerpt.slice(0, 80)}」）。请给出渠道大致价或价位区间，并问清版本/容量；不要再说「还没官宣 / 给不了」。`;
  }
  if (intent.kind === "fact_correction") {
    return `上一版草稿没有接住对方的纠正（「${intent.excerpt.slice(0, 80)}」）。请先承认说错了，再按对方说法继续；若问价就报大致价。`;
  }
  if (intent.kind === "direct_question") {
    return `上一版草稿没有回答对方的问题（「${intent.excerpt.slice(0, 80)}」）。请先答问题，不要继续推销。`;
  }
  return "上一版草稿偏题，请紧扣对方刚说的话重写。";
}
