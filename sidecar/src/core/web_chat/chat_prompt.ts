/**
 * 聊天模式的提示词（§11 · §5.7）
 *
 * 设计要点：
 * - **只让模型做一件事**：写「这一条」回复。要不要发、发几次、什么时候发，全由确定性代码决定，
 *   不交给模型（否则又变成「催模型收尾」那类老问题）。
 * - **必须吃上下文**：最近对话 + 滚动摘要 + 已知长期事实 + 已用过的角度 + 对方的阶段。
 * - **明确禁止机器痕迹**：不复述已说过的话、不堆客套、不写「作为 AI」、不群发口吻。
 * - **不编造敏感/身份**：OTP、证件、银行卡、假身份一律禁止；商业目标下对方问价时要能给渠道大致价，禁止空推「还没官宣」。
 * - 输出严格 JSON，方便确定性解析；解析失败按失败处理，绝不放行空内容。
 */
import type { ChatMessage } from "./conversation_extract.js";
import type { ChatStage } from "./state.js";

export interface ChatDraftPromptInput {
  /** 站点名（仅用于「这是什么平台」的语气参考，不参与选择器） */
  siteLabel: string;
  contactLabel: string;
  stage: ChatStage;
  /** 会话目标（用户写的目标；例如「推广苹果18」） */
  goal: string;
  /** 由 @规则/@人设 展开后的策略 brief（可空；没有 @ 则不注入） */
  policyBrief?: string | null;
  /** 风格与边界（用户规则；可为空） */
  styleHint: string | null;
  /** 当前选用的角色名（可空） */
  roleName: string | null;
  /** 角色提示词（可空；注入 system） */
  rolePrompt: string | null;
  /** 滚动摘要（长期上下文，可能为空） */
  rollingSummary: string | null;
  /** 已知长期事实（键值对摘要，逐行） */
  longTermFacts: readonly string[];
  /** 已用过的角度（禁止重复） */
  usedAngles: readonly string[];
  /** 最近消息（已按时间正序） */
  recent: readonly ChatMessage[];
  /** 本次是主动开口（对方没未回复）还是回复对方 */
  isFollowUp: boolean;
  /** 开场序号（首次接触为 0）；温热追问时表示已追次数 */
  followUpIndex: number;
  /** opening＝冷开场；due＝温热追问；缺省按 followUpIndex 推断 */
  planReason?: "opening" | "due" | null;
  /** 去重拒绝后的强制重写提示（含「你已说过」的原句） */
  rewriteHint: string | null;
  /** 本轮意图指令（信任攻击/提问等；可空） */
  intentDirective?: string | null;
  /** 本轮 texts 上限（默认 1） */
  maxBubbles?: number;
  /** 当前时刻（ISO）；缺省用本机时间。写入提示词让模型对齐公历，避免「还没发布」这类过时推辞 */
  nowIso?: string | null;
}

/** 把 ISO / Date 收成「今天是 YYYY年M月D日」；解析失败就返回 null（宁可不写也不写错日） */
export function formatChatTodayLabel(nowIso?: string | null): string | null {
  const raw = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : null;
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `今天是 ${y}年${m}月${d}日（以此时刻为准判断产品是否已发布/上市，不要用过时的「还没官宣」搪塞）`;
}

const STAGE_HINT: Readonly<Record<ChatStage, string>> = {
  cold: "刚接触，彼此陌生：先建立真实连接点，别急着推进",
  engaged: "已经聊起来：围绕对方的兴趣继续深挖一个点",
  interested: "对方表现出兴趣：把话题往具体行动上带一点，但别压迫",
  negotiating: "正在谈具体条件：把关键信息问清楚，不替对方做决定",
  converted: "已达成目标：保持自然收尾，可温和巩固",
  rejected: "对方刚表示拒绝或不感兴趣：按角色继续推进，可换角度劝，不要立刻放弃",
  opted_out: "对方提到不想再聊：按角色判断是否委婉收尾或换话题继续；不要机械复读",
  risk: "风控/异常状态：不发消息，交人工",
};

export const CHAT_DRAFT_SYSTEM_PROMPT = [
  "你正在替一个真人，在聊天软件里与对方进行一对一私聊。",
  "按下方「角色」说话；没有角色时像真人朋友一样自然。",
  "",
  "硬性要求：",
  "1. 输出 JSON：默认只发 1 句（texts 数组一个元素）。一句说清；没说完下轮再说。只有对方一口气问了多个问题时，才可发 2～3 句。",
  "2. 回话语言必须与对方最近消息一致（对方使用的语言）：对方用英文就全程英文，用中文就全程中文，用其它语种就用该语种；禁止中英夹杂、先英后中。角色提示或任务目标若是另一种文字，只影响人设与事实，不改变回话语种。",
  "3. 口气与书写习惯都要跟对方当地人日常私聊：口语、自然、短句；对方少用句号/破折号你就少用；匹配对方语气松紧与消息长短，不要翻译腔、不要客服稿、不要小作文，也不要无端截断。",
  "4. 必须先回应对方刚说的内容；对方连发多条时合起来理解。有提问或质疑时先答，答完前禁止推销。",
  "5. 严禁复述、改写、换同义词重复你之前已经说过的话。",
  "6. 不要出现机器痕迹：不写「作为AI」「我代表」、不堆感叹号、不用书面语排比与破折号长句、不群发口吻。",
  "7. 不编造敏感与身份：验证码/密码/银行卡/证件/假人设一律禁止。对方纠正你说错的事实时必须先认错接住，禁止死撑旧说法。",
  "8. 商业目标下对方问价格/配置：必须给出你这边的渠道大致价或常见价位区间（可说「大概」「左右」），并顺带问清版本/容量；禁止空推「还没官宣 / 给不了数字 / 等官宣」——若角色或目标已写明价目，以那份为准。",
  "9. 不索要或发送验证码、密码、银行卡、身份证等敏感信息；对方索要时委婉拒绝并转移话题。",
  "10. 不说「已收到」「感谢咨询」这类客服话术。",
  "11. 对方质疑你是骗子/机器人时：只用一句短口语正面澄清，本轮禁止提产品/型号/颜色/成交，禁止长篇自辩。",
  "12. 不替对方做付款/转账决定，不承诺「已帮你付掉」。",
  "13. 对方要图：不要用连环问配置顶替。系统会从图库发图；你只写一句配图说明。库里没有对应图时如实说备图，不要空转问容量。",
  "14. 对方要语音或视频：不要主动说你不会/不能。用一句自然借口带过；可以请对方先看实拍。禁止承诺马上发语音、视频或通话。",
  "15. 对方一阵没回、你主动追问时：像真人角色继续推进（老师会追问、销售会探需求、医生会问症状、朋友会找话说）——用 1 句有由头的问句或轻推，把话题往「本次任务目标」带；禁止空洞「在吗/还在吗/考虑得怎么样」；禁止连发施压；语气贴合角色。",
  "",
  "输出严格的 JSON（不要 markdown 代码块）：",
  '{"texts":["要发送的那一句"],"angle":"切入角度（4~10字）"}',
  "兼容旧格式：也接受 {\"text\":\"单句\",\"angle\":\"...\"}。",
].join("\n");

/** 对方回话应使用的语种（由最近入站消息脚本统计；unknown = 不强锁） */
export type PeerReplyLanguage = "zh" | "en" | "he" | "unknown";

const LANG_LABEL: Readonly<Record<PeerReplyLanguage, string>> = {
  zh: "中文",
  en: "English",
  he: "עברית / Hebrew",
  unknown: "对方当前语种",
};

function countScriptSignals(text: string): { cjk: number; latin: number; hebrew: number } {
  let cjk = 0;
  let latin = 0;
  let hebrew = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (code == null) continue;
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
    else if (code >= 0x0590 && code <= 0x05ff) hebrew += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
  }
  return { cjk, latin, hebrew };
}

/** 从一段文本推断主导语种（纯脚本统计，不猜语义） */
export function scoreTextLanguage(text: string): PeerReplyLanguage {
  const { cjk, latin, hebrew } = countScriptSignals(text);
  const total = cjk + latin + hebrew;
  if (total < 3) return "unknown";
  if (hebrew >= cjk && hebrew >= latin && hebrew / total >= 0.25) return "he";
  if (cjk >= latin && cjk / total >= 0.2) return "zh";
  if (latin >= cjk && latin / total >= 0.35) return "en";
  if (cjk > latin && cjk > hebrew) return "zh";
  if (hebrew > latin) return "he";
  if (latin > 0) return "en";
  return "unknown";
}

/**
 * 从最近对话推断**本轮回话语种**：优先看对方最近入站；没有入站时看整段最近文本。
 * 对方用英文时绝不能回中文（现场：询价英文 → 机器人回中文）。
 */
export function inferPeerReplyLanguage(recent: readonly ChatMessage[]): PeerReplyLanguage {
  const inbound = recent
    .filter((message) => message.direction === "in")
    .slice(-8)
    .map((message) => String(message.text ?? "").trim())
    .filter(Boolean);
  if (inbound.length > 0) return scoreTextLanguage(inbound.join("\n"));
  const any = recent
    .slice(-12)
    .map((message) => String(message.text ?? "").trim())
    .filter(Boolean);
  if (any.length === 0) return "unknown";
  return scoreTextLanguage(any.join("\n"));
}

/** 草稿是否与对方语种一致；unknown / 极短草稿不拦 */
export function draftMatchesPeerLanguage(
  texts: readonly string[],
  lang: PeerReplyLanguage,
): boolean {
  if (lang === "unknown") return true;
  const joined = texts.map((item) => String(item ?? "").trim()).filter(Boolean).join("\n");
  if (!joined) return true;
  const detected = scoreTextLanguage(joined);
  if (detected === "unknown") return true;
  return detected === lang;
}

export function languageRewriteHint(lang: PeerReplyLanguage): string {
  if (lang === "en") {
    return "上一版草稿语种不对：对方在用英文。请用自然的日常英文重写整段 texts，禁止出现中文句子或中英夹杂。";
  }
  if (lang === "zh") {
    return "上一版草稿语种不对：对方在用中文。请用自然的中文口语重写整段 texts，禁止整段改成英文。";
  }
  if (lang === "he") {
    return "上一版草稿语种不对：对方在用希伯来语。请用希伯来语日常短口语重写整段 texts，少用句号与破折号。";
  }
  return "上一版草稿语种与对方不一致：请改用对方最近消息的同一种语言重写。";
}

function languageLockLine(lang: PeerReplyLanguage): string | null {
  if (lang === "unknown") return null;
  if (lang === "en") {
    return `⚠ 回话语种锁定：English。本轮 texts 必须全部是英文日常口语（像当地人私聊），禁止中文句子或中英夹杂。角色/任务若是中文，只当事实参考，仍用英文说。`;
  }
  if (lang === "zh") {
    return `⚠ 回话语种锁定：中文。本轮 texts 必须全部是中文日常口语，不要整段改成英文。`;
  }
  if (lang === "he") {
    return `⚠ 回话语种锁定：${LANG_LABEL.he}。本轮 texts 必须全部用该语种日常短口语（像以色列人私聊打字），少用句号、逗号排比与破折号 —，不要翻译腔长句。`;
  }
  return null;
}

/** 对方私聊标点习惯：sparse = 几乎不用句号/破折号（以色列私聊现场） */
export type PeerPunctuationHabit = "sparse" | "normal" | "unknown";

const PUNCT_COMPLAINT_RE =
  /(סימני\s*פיסוק|punctuation|不用标点|不加句号|不打句号|不使用标点|不用句号)/i;

function countPunctSignals(text: string): { letters: number; terminals: number; emDashes: number } {
  let letters = 0;
  let terminals = 0;
  let emDashes = 0;
  for (const ch of String(text ?? "")) {
    if (/\p{L}/u.test(ch)) letters += 1;
    else if (/[.!?。！？…]/.test(ch)) terminals += 1;
    else if (ch === "—" || ch === "–") emDashes += 1;
  }
  return { letters, terminals, emDashes };
}

/**
 * 从对方最近入站推断标点习惯。
 * 对方明确吐槽标点，或入站几乎无句号 → sparse。
 */
export function inferPeerPunctuationHabit(recent: readonly ChatMessage[]): PeerPunctuationHabit {
  const inbound = recent
    .filter((message) => message.direction === "in")
    .slice(-8)
    .map((message) => String(message.text ?? "").trim())
    .filter(Boolean);
  if (inbound.length === 0) return "unknown";
  if (inbound.some((text) => PUNCT_COMPLAINT_RE.test(text))) return "sparse";
  let letters = 0;
  let terminals = 0;
  let emDashes = 0;
  for (const text of inbound) {
    const signals = countPunctSignals(text);
    letters += signals.letters;
    terminals += signals.terminals;
    emDashes += signals.emDashes;
  }
  if (letters < 10) return "unknown";
  if (emDashes === 0 && terminals / letters <= 0.025) return "sparse";
  return "normal";
}

/** sparse 习惯下：禁止破折号/分号，句号最多 0～1（长句不允许句号） */
export function draftMatchesPeerPunctuation(
  texts: readonly string[],
  habit: PeerPunctuationHabit,
): boolean {
  if (habit !== "sparse") return true;
  const joined = texts.map((item) => String(item ?? "").trim()).filter(Boolean).join("\n");
  if (!joined) return true;
  if (/[—–;；]/.test(joined)) return false;
  const periods = (joined.match(/[.。]/g) ?? []).length;
  if (periods >= 2) return false;
  const letters = [...joined].filter((ch) => /\p{L}/u.test(ch)).length;
  if (letters >= 18 && periods >= 1) return false;
  return true;
}

export function punctuationRewriteHint(habit: PeerPunctuationHabit): string {
  if (habit === "sparse") {
    return "上一版草稿标点太书面：对方私聊几乎不用句号/破折号。请用短口语重写，尽量不加句号与 —，像当地人打字。";
  }
  return "上一版草稿口气太书面，请改成更口语的短句。";
}

function punctuationLockLine(
  habit: PeerPunctuationHabit,
  lang: PeerReplyLanguage,
): string | null {
  if (habit === "sparse") {
    return "⚠ 书写习惯锁定：对方私聊几乎不用句号/破折号。本轮 texts 必须短口语、少标点（尽量不加句号与 —），禁止书面排比与小作文。";
  }
  if (lang === "he") {
    return "⚠ 希伯来语私聊：短口语优先，少用句号与破折号；对方怎么打字你就怎么打。";
  }
  return null;
}

function directionLabel(direction: ChatMessage["direction"]): string {
  return direction === "out" ? "我" : "对方";
}

export function buildChatDraftMessages(input: ChatDraftPromptInput): Array<{
  role: "system" | "user";
  content: string;
}> {
  const lines: string[] = [];

  const today = formatChatTodayLabel(input.nowIso);
  if (today) lines.push(today);
  lines.push(`平台：${input.siteLabel || "未知聊天平台"}`);
  lines.push(`对方昵称：${input.contactLabel}`);
  lines.push(`关系阶段：${input.stage}（${STAGE_HINT[input.stage] ?? ""}）`);
  lines.push(`本次任务目标：${input.goal || "（未指定，目标是与对方自然地建立并保持联系）"}`);
  if (input.policyBrief) {
    lines.push("");
    lines.push(input.policyBrief.slice(0, 6_000));
  }
  if (input.roleName || input.rolePrompt) {
    lines.push("");
    lines.push(`当前角色：${input.roleName || "（未命名）"}`);
    if (input.rolePrompt) {
      lines.push("角色要求（必须遵守，优先于下方风格提示）：");
      lines.push(input.rolePrompt.slice(0, 4_000));
    }
  }
  if (input.styleHint) {
    lines.push(`说话风格与边界：${input.styleHint}`);
  }
  if (input.intentDirective) {
    lines.push("");
    lines.push(`⚠ 本轮硬性意图：${input.intentDirective}`);
  }
  const peerLang = inferPeerReplyLanguage(input.recent);
  const langLock = languageLockLine(peerLang);
  if (langLock) {
    lines.push("");
    lines.push(langLock);
  }
  const peerPunct = inferPeerPunctuationHabit(input.recent);
  const punctLock = punctuationLockLine(peerPunct, peerLang);
  if (punctLock) {
    lines.push("");
    lines.push(punctLock);
  }
  const maxBubbles = Math.max(1, Math.min(3, Math.trunc(input.maxBubbles ?? 1)));
  lines.push(`本轮最多发 ${maxBubbles} 句（texts 数组长度 ≤ ${maxBubbles}）。`);
  const hasHistory = input.longTermFacts.length > 0 || input.rollingSummary !== null || input.recent.length > 0;
  const nudgeOrdinal = Math.max(1, Math.trunc(input.followUpIndex) + 1);
  const isWarmSteer = input.isFollowUp && input.planReason === "due";
  lines.push(
    input.isFollowUp
      ? isWarmSteer
        ? [
            `本次性质：**主动追问 / 不冷场**（对方一阵没回；这是第 ${nudgeOrdinal} 次轻推）。`,
            "按当前角色继续推进：老师会启发提问，销售会探清需求与顾虑，医生会追问症状细节，朋友会找自然话题——都要往「本次任务目标」轻轻带，不要空洞催「在吗」。",
            "只发 1 句：有由头、可回答、换新角度；不要复读上一句，不要连发施压。",
          ].join("")
        : input.followUpIndex === 0
          ? hasHistory
            ? "本次性质：**主动开口**（我方还没发过话，但会话里已有内容）——顺着已有的话题自然接上，不要客套、不要重问已经知道的事"
            : "本次性质：**开场**（你主动发起的第一句，对方还没回过话）——具体、有由头、不客套；不要只说「你好 / 在吗」"
          : [
              `本次性质：**主动追问 / 不冷场**（对方一阵没回；这是第 ${input.followUpIndex} 次轻推）。`,
              "按当前角色继续推进，把话题往「本次任务目标」轻轻带；只发 1 句有由头的问句，禁止空洞「在吗」。",
            ].join("")
      : "本次性质：**回复对方**（对方刚发了消息）",
  );

  if (input.longTermFacts.length > 0) {
    lines.push("");
    lines.push("已知关于对方的长期事实（必须保持一致，不要问已经知道的）：");
    for (const fact of input.longTermFacts.slice(0, 20)) {
      lines.push(`- ${fact}`);
    }
  }

  if (input.rollingSummary) {
    lines.push("");
    lines.push("更早的对话摘要（供理解关系进展，不要直接复述）：");
    lines.push(input.rollingSummary.slice(0, 1500));
  }

  if (input.usedAngles.length > 0) {
    lines.push("");
    lines.push(`你之前已经用过的切入角度（**必须换新的**）：${input.usedAngles.slice(-12).join("、")}`);
  }

  lines.push("");
  if (input.recent.length > 0) {
    const answerable = input.recent.filter((message) => message.direction === "in").length;
    if (!input.isFollowUp && answerable > 1) {
      lines.push(
        `注意：对方连续发了 ${answerable} 条消息，请把它们**合起来理解**，用不超过 ${maxBubbles} 句接住（不要机械逐条复读，也不要无视提问去推销）。`,
      );
    }
    lines.push("最近的对话（按时间从早到晚）：");
    for (const message of input.recent.slice(-30)) {
      const text = message.text.replace(/\s+/g, " ").trim().slice(0, 300);
      if (!text) continue;
      lines.push(`${directionLabel(message.direction)}：${text}`);
    }
  } else {
    lines.push("最近的对话：（这是第一次接触，还没有任何对话记录）");
  }

  if (input.rewriteHint) {
    lines.push("");
    lines.push("⚠ 上一版草稿被判定为「重复已说过的话」而拒绝：");
    lines.push(input.rewriteHint);
    lines.push("请换一个完全不同的说法与角度重写。");
  }

  lines.push("");
  lines.push(`现在输出 JSON（texts 最多 ${maxBubbles} 句；一句说清优先）：`);

  return [
    { role: "system", content: CHAT_DRAFT_SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ];
}

export interface ParsedChatDraft {
  /** 兼容旧调用方：等于 texts[0] */
  text: string;
  /** 多句连发（1～5）；引擎按序发出，片预算不够则进待发队列 */
  texts: string[];
  angle: string | null;
}

const MAX_DRAFT_BUBBLES_HARD = 3;

function normalizeDraftTexts(parsed: Record<string, unknown>, maxBubbles = MAX_DRAFT_BUBBLES_HARD): string[] | null {
  const cap = Math.max(1, Math.min(MAX_DRAFT_BUBBLES_HARD, Math.trunc(maxBubbles)));
  const bubbles: string[] = [];
  if (Array.isArray(parsed.texts)) {
    for (const item of parsed.texts) {
      const text = String(item ?? "").trim();
      if (text) bubbles.push(text);
      if (bubbles.length >= cap) break;
    }
  }
  if (bubbles.length === 0) {
    const single = String(parsed.text ?? parsed.message ?? "").trim();
    if (single) bubbles.push(single);
  }
  return bubbles.length > 0 ? bubbles.slice(0, cap) : null;
}

/**
 * 解析草稿输出。容忍模型套了 markdown 代码块或前后说话，但**不接受空文本**。
 * `maxBubbles` 默认 3（硬顶）；引擎侧会再按本轮意图收紧。
 */
export function parseChatDraft(raw: string, maxBubbles = MAX_DRAFT_BUBBLES_HARD): ParsedChatDraft | null {
  const content = String(raw ?? "").trim();
  if (!content) return null;

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? content).trim();

  const tryParse = (text: string): ParsedChatDraft | null => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const texts = normalizeDraftTexts(parsed, maxBubbles);
      if (!texts) return null;
      const angle = String(parsed.angle ?? "").trim();
      return { text: texts[0]!, texts, angle: angle || null };
    } catch {
      return null;
    }
  };

  const direct = tryParse(candidate);
  if (direct) return direct;

  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const sliced = tryParse(candidate.slice(first, last + 1));
    if (sliced) return sliced;
  }

  if (!candidate.includes("{") && candidate.length <= 200) {
    const cleaned = candidate.replace(/^["'“”]|["'“”]$/g, "").trim();
    if (cleaned && !/\n/.test(cleaned) && !/^(好的|以下是|这是|建议)/.test(cleaned)) {
      return { text: cleaned, texts: [cleaned], angle: null };
    }
  }

  return null;
}

/**
 * 判定对方是否在**明确拒绝/退订**（决定是否停止回访）。
 * 只认明确表述；冷淡或已读不回**不算**退订（那只是 `rejected`/未回应）。
 */
const OPT_OUT_RE =
  /(别(再)?(给我)?(发|联系|打扰)|不要(再)?(发|联系|打扰|骚扰)|(请)?(停止|别再)(联系|发消息)|拉黑|举报你|投诉你|退订|不需要了|别烦我|who are you|stop messaging|do not (contact|message)|leave me alone|unsubscribe)/i;

export function looksLikeOptOut(text: string): boolean {
  return OPT_OUT_RE.test(String(text ?? ""));
}

/** 判定对方是否表现出明确反感（阶段降级为 rejected，但未要求停止联系） */
const REJECT_RE = /(没兴趣|用不上|不需要|不考虑|算了|不合适|no thanks|not interested|no need)/i;

export function looksLikeRejection(text: string): boolean {
  return REJECT_RE.test(String(text ?? ""));
}
