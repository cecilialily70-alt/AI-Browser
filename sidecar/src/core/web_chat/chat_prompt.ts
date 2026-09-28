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
  /** 开场序号（首次接触为 0） */
  followUpIndex: number;
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
  "2. 用对方使用的语言回话（对方说中文就用中文）。",
  "3. 每句像真人打字：自然、完整；匹配对方消息长短，不要小作文，也不要无端截断。",
  "4. 必须先回应对方刚说的内容；对方连发多条时合起来理解。有提问或质疑时先答，答完前禁止推销。",
  "5. 严禁复述、改写、换同义词重复你之前已经说过的话。",
  "6. 不要出现机器痕迹：不写「作为AI」「我代表」、不堆感叹号、不用书面语排比、不群发口吻。",
  "7. 不编造敏感与身份：验证码/密码/银行卡/证件/假人设一律禁止。对方纠正你说错的事实时必须先认错接住，禁止死撑旧说法。",
  "8. 商业目标下对方问价格/配置：必须给出你这边的渠道大致价或常见价位区间（可说「大概」「左右」），并顺带问清版本/容量；禁止空推「还没官宣 / 给不了数字 / 等官宣」——若角色或目标已写明价目，以那份为准。",
  "9. 不索要或发送验证码、密码、银行卡、身份证等敏感信息；对方索要时委婉拒绝并转移话题。",
  "10. 不说「已收到」「感谢咨询」这类客服话术。",
  "11. 对方质疑你是骗子/机器人时：必须先正面澄清，本轮禁止继续产品话术。",
  "12. 不替对方做付款/转账决定，不承诺「已帮你付掉」。",
  "13. 对方要图：不要用连环问配置顶替。系统会从图库发图；你只写一句配图说明。库里没有对应图时如实说备图，不要空转问容量。",
  "14. 对方要语音或视频：不要主动说你不会/不能。用一句自然借口带过；可以请对方先看实拍。禁止承诺马上发语音、视频或通话。",
  "",
  "输出严格的 JSON（不要 markdown 代码块）：",
  '{"texts":["要发送的那一句"],"angle":"切入角度（4~10字）"}',
  "兼容旧格式：也接受 {\"text\":\"单句\",\"angle\":\"...\"}。",
].join("\n");

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
  const maxBubbles = Math.max(1, Math.min(3, Math.trunc(input.maxBubbles ?? 1)));
  lines.push(`本轮最多发 ${maxBubbles} 句（texts 数组长度 ≤ ${maxBubbles}）。`);
  const hasHistory = input.longTermFacts.length > 0 || input.rollingSummary !== null || input.recent.length > 0;
  lines.push(
    input.isFollowUp
      ? input.followUpIndex === 0
        ? hasHistory
          ? // 会话里已有内容（对方说过、或历史被读进来），但我方还没开过口：
            // 这时候要**顺着已有话题接上**，而不是再来一句「你好」（会像机器人）
            "本次性质：**主动开口**（我方还没发过话，但会话里已有内容）——顺着已有的话题自然接上，不要客套、不要重问已经知道的事"
          : // 开场与「回访」是两回事：把「第 0 次回访」塞给模型，出来的就是客套的「在吗」
            "本次性质：**开场**（你主动发起的第一句，对方还没回过话）——具体、有由头、不客套；不要只说「你好 / 在吗」"
        : `本次性质：**主动回访**（对方还没回话；这是第 ${input.followUpIndex} 次回访）——找一个新的、有由头的话题开口`
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
