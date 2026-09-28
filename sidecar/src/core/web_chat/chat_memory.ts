/**
 * 聊天记忆（§11 · §10）—— **滚动摘要 + 长期事实 + 角度轮换**
 *
 * 目标只有一个：聊得越久越像「记得这个人」，而不是越聊越抽象、越聊越像套话。
 *
 * ## 为什么需要专门的「防递归退化」规则
 *
 * 朴素做法是把「上一版摘要 + 新消息」再喂给模型总结，反复几轮后摘要会**退化**：
 * 细节被磨平、只剩「双方在友好地交流」这类废话，而且**每一轮都在丢信息**。
 * 本模块用三条硬规则挡住它（都有回归测试锁住）：
 *
 * 1. **必须吃原始消息**：压缩的输入只能是「上一版摘要 + 未被覆盖的**原始消息**」。
 *    如果没有任何未覆盖的原始消息，就**不做压缩**（返回 `no_new_raw`）——
 *    绝不允许「拿摘要总结摘要」。
 * 2. **稳定事实不参与压缩**：长期事实存在独立的 `facts.json`，只追加去重、按条数限量。
 *    摘要被裁剪时事实**一条都不会丢**。信息损失被限制在「过程性叙述」上。
 * 3. **代数上限**：压缩次数到顶后不再继续压缩，只把「已覆盖位置」往前推。
 *    摘要因此**不会无限变长也不会无限退化**。
 *
 * 此外，摘要正文有硬上限，超出时**只裁最旧的部分**（保留最近的关系进展）。
 *
 * 纯函数、无 I/O、无模型调用：提示词与解析在这里，真正的 LLM 调用在宿主接线层。
 */
import type { ChatMessage } from "./conversation_extract.js";
import type { ChatStage } from "./state.js";

/* ————————————————————————— 配置 ————————————————————————— */

export interface ChatMemoryConfig {
  /** 未被摘要覆盖的消息达到这个条数，才值得做一次压缩（太频繁纯粹烧 token） */
  compactAfterMessages: number;
  /** 参与压缩的原始消息条数上限（一次压缩最多回灌这么多条） */
  rawWindowMax: number;
  /** 摘要正文硬上限（字符） */
  summaryMaxChars: number;
  /** 生成新摘要时回灌的旧摘要上限（防止旧摘要本身越来越大） */
  previousSummaryMaxChars: number;
  /** 长期事实最多保留多少条 */
  factsMax: number;
  /** 摘要代数上限：到顶后只推进覆盖位置，不再压缩 */
  maxGenerations: number;
  /** 单条长期事实的最大长度（字符） */
  factMaxChars: number;
}

export const DEFAULT_MEMORY_CONFIG: ChatMemoryConfig = {
  compactAfterMessages: 24,
  rawWindowMax: 60,
  summaryMaxChars: 1400,
  previousSummaryMaxChars: 1200,
  factsMax: 40,
  maxGenerations: 60,
  factMaxChars: 160,
};

/* ————————————————————————— 何时压缩 ————————————————————————— */

export type MemoryCompactReason =
  /** 未被覆盖的原始消息积压到阈值 */
  | "uncovered_backlog"
  /** 没有新的原始消息可总结：不压缩（防「摘要总结摘要」） */
  | "no_new_raw"
  /** 代数已到上限：只推进覆盖位置，不再压缩 */
  | "generation_cap_reached"
  /** 尚未到阈值 */
  | "not_needed";

export interface MemoryCompactDecision {
  needed: boolean;
  reason: MemoryCompactReason;
  /** 本次压缩将覆盖多少条原始消息（needed=false 时为 0） */
  covering: number;
  /** 需要调用模型，还是只需要推进覆盖位置 */
  requiresLlm: boolean;
}

export interface MemoryCompactInput {
  /** 流水里总共有多少条消息 */
  totalMessages: number;
  /** 其中「尚未被摘要覆盖」的有多少条 */
  uncoveredMessages: number;
  /** 已经压缩过几次 */
  generations: number;
  config?: ChatMemoryConfig;
}

/**
 * 该不该压缩（纯决策，不调模型）。
 *
 * 顺序刻意如此：先看**有没有原始消息**（没有就绝不动手），再看代数上限，最后才看积压量。
 */
export function decideCompact(input: MemoryCompactInput): MemoryCompactDecision {
  const config = input.config ?? DEFAULT_MEMORY_CONFIG;
  const uncovered = Math.max(0, Math.trunc(input.uncoveredMessages));
  const generations = Math.max(0, Math.trunc(input.generations));

  if (uncovered <= 0) {
    // 没有新原始消息：**绝不允许**用「摘要的摘要」继续压缩（防递归退化规则 1）
    return { needed: false, reason: "no_new_raw", covering: 0, requiresLlm: false };
  }
  if (generations >= config.maxGenerations) {
    // 代数到顶：只把覆盖位置往前推，让旧消息退出提示窗口，不再压缩（规则 3）
    return {
      needed: true,
      reason: "generation_cap_reached",
      covering: uncovered,
      requiresLlm: false,
    };
  }
  if (uncovered < config.compactAfterMessages) {
    return { needed: false, reason: "not_needed", covering: 0, requiresLlm: false };
  }
  return {
    needed: true,
    reason: "uncovered_backlog",
    covering: Math.min(uncovered, config.rawWindowMax),
    requiresLlm: true,
  };
}

/* ————————————————————————— 摘要提示词 ————————————————————————— */

export const CHAT_SUMMARY_SYSTEM_PROMPT = [
  "你在维护一份「私聊关系的长期记忆」，供之后继续和这个人聊天时参考。",
  "",
  "硬性要求：",
  "1. 只记录**确定发生过**的信息，不许推测、不许脑补、不许把客套话当成事实。",
  "2. 保留具体细节：对方的偏好、经历、时间地点、答应过的事、明确拒绝的事。",
  "3. 丢掉废话与过程：问好、客套、重复寒暄不要写。",
  "4. 篇幅要短：把早期内容压缩，最近的进展保留得多一些。",
  "5. **绝不**记录验证码、密码、银行卡、身份证、令牌等敏感信息（出现就整体略过）。",
  "6. 长期事实用「一行一条」的短句，只写关于**对方**的稳定信息（不是每轮发生了什么）。",
  "",
  "输出严格的 JSON（不要 markdown 代码块）：",
  '{"summary":"关系进展的紧凑摘要（第三人称、按时间顺序）","facts":["关于对方的稳定事实", "..."]}',
].join("\n");

export interface ChatSummaryPromptInput {
  contactLabel: string;
  goal: string;
  /** 会话所处阶段（帮助模型判断该保留什么） */
  stage: ChatStage;
  /** 上一版摘要（可为空） */
  previousSummary: string | null;
  /** 尚未被覆盖的**原始消息**（按时间正序） */
  uncovered: readonly ChatMessage[];
  /** 已登记的长期事实（避免重复登记） */
  knownFacts: readonly string[];
  config?: ChatMemoryConfig;
}

export function buildChatSummaryMessages(input: ChatSummaryPromptInput): Array<{
  role: "system" | "user";
  content: string;
}> {
  const config = input.config ?? DEFAULT_MEMORY_CONFIG;
  const lines: string[] = [];

  lines.push(`对方昵称：${input.contactLabel}`);
  lines.push(`关系阶段：${input.stage}`);
  lines.push(`聊天目标：${input.goal || "（未指定）"}`);

  if (input.previousSummary) {
    lines.push("");
    lines.push("上一版摘要（在它基础上补充，不要丢掉仍然有效的旧信息）：");
    lines.push(input.previousSummary.slice(0, config.previousSummaryMaxChars));
  }

  if (input.knownFacts.length > 0) {
    lines.push("");
    lines.push("已经登记过的长期事实（**不要重复登记**）：");
    for (const fact of input.knownFacts.slice(-config.factsMax)) {
      lines.push(`- ${fact}`);
    }
  }

  lines.push("");
  if (input.uncovered.length > 0) {
    lines.push("需要被纳入摘要的新对话（按时间从早到晚）：");
    for (const message of input.uncovered.slice(-config.rawWindowMax)) {
      const text = message.text.replace(/\s+/g, " ").trim().slice(0, 400);
      if (!text) continue;
      lines.push(`${message.direction === "out" ? "我" : "对方"}：${text}`);
    }
  } else {
    // 走不到这里（调用前必须保证有未覆盖消息），防御性兜底
    lines.push("需要被纳入摘要的新对话：（无）");
  }

  lines.push("");
  lines.push("现在只输出那个 JSON：");

  return [
    { role: "system", content: CHAT_SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ];
}

/* ————————————————————————— 解析与合并 ————————————————————————— */

export interface ParsedChatSummary {
  summary: string;
  facts: string[];
}

/** 容错解析摘要输出（容忍 markdown 包裹/裸文本）；解析不出来返回 null，绝不放行空内容 */
export function parseChatSummary(raw: string): ParsedChatSummary | null {
  const content = String(raw ?? "").trim();
  if (!content) return null;

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? content).trim();

  const tryParse = (text: string): ParsedChatSummary | null => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const summary = String(parsed.summary ?? parsed.text ?? "").trim();
      if (!summary) return null;
      const rawFacts = Array.isArray(parsed.facts) ? parsed.facts : [];
      return { summary, facts: rawFacts.map((item) => String(item ?? "").trim()).filter(Boolean) };
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
  return null;
}

/** 摘要正文裁剪：**只裁最旧的部分**（保留最近的关系进展） */
export function clampSummary(text: string, maxChars = DEFAULT_MEMORY_CONFIG.summaryMaxChars): string {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  // 从尾部回取，并在句子边界处起头（避免半句）
  const tail = normalized.slice(-maxChars);
  const boundary = tail.search(/[。！？.!?\n]/);
  const trimmed = boundary >= 0 ? tail.slice(boundary + 1) : tail;
  return trimmed.trim();
}

export interface MemoryMergeResult {
  /** 新的摘要正文 */
  summary: string;
  /** 新摘要覆盖到哪条消息 id 之前（含） */
  coveredUpToId: string | null;
  /** 新的代数 */
  generations: number;
  /** 本次新登记的长期事实（已过滤） */
  newFacts: string[];
}

/**
 * 合并出新的摘要状态（纯函数，**不在本层写盘**）。
 *
 * `coveredUpToId` 只能**前进**：模型偶尔回吐旧位置也不会让已覆盖内容重新变成未覆盖
 * （否则同一批消息会被反复总结，摘要被反复磨平）。
 */
export function mergeSummary(input: {
  previousSummary: string | null;
  /** 上一版覆盖到的消息 id（用于「只能前进」判定） */
  previousCoveredUpToId: string | null;
  /** 已经压缩过几次（本次合并后 +1） */
  previousGenerations: number;
  generated: ParsedChatSummary;
  /** 本次纳入摘要的原始消息（按时间正序）；取最后一条的 id 作为新覆盖点 */
  covered: readonly ChatMessage[];
  /** 该联系人流水里的**全部**消息 id（按时间正序），用于校验覆盖点确实存在 */
  allMessageIds?: readonly string[];
  knownFacts: readonly string[];
  config?: ChatMemoryConfig;
}): MemoryMergeResult {
  const config = input.config ?? DEFAULT_MEMORY_CONFIG;

  const summary = clampSummary(input.generated.summary, config.summaryMaxChars);

  const lastCovered = input.covered[input.covered.length - 1]?.id ?? null;
  const previousIndex = input.previousCoveredUpToId
    ? (input.allMessageIds ?? []).indexOf(input.previousCoveredUpToId)
    : -1;
  const nextIndex = lastCovered ? (input.allMessageIds ?? []).indexOf(lastCovered) : -1;

  let coveredUpToId = input.previousCoveredUpToId;
  if (lastCovered && nextIndex >= 0 && nextIndex > previousIndex) {
    coveredUpToId = lastCovered;
  } else if (lastCovered && input.allMessageIds === undefined) {
    // 没给全量 id 列表时无法比较，直接采用（调用方保证正序）
    coveredUpToId = lastCovered;
  }

  const known = new Set(input.knownFacts.map((fact) => fact.trim()).filter(Boolean));
  const newFacts: string[] = [];
  for (const fact of input.generated.facts) {
    const cleaned = sanitizeFact(fact, config);
    if (!cleaned || known.has(cleaned)) continue;
    known.add(cleaned);
    newFacts.push(cleaned);
  }

  return {
    summary,
    coveredUpToId,
    generations: Math.max(0, Math.trunc(input.previousGenerations)) + 1,
    newFacts,
  };
}

/* ————————————————————————— 长期事实 ————————————————————————— */

/** 敏感信息绝不允许进长期事实（叠加 R2 / §1.3） */
const FACT_FORBIDDEN_RE =
  /(验证码|校验码|动态码|短信码|一次性密码|口令|密码|卡号|身份证|护照|cvv|安全码|token|otp|pin\b)/i;

/**
 * 清洗单条长期事实：**过滤敏感信息**（整条丢弃，不脱敏后保留——事实本该是可读的短句，
 * 含敏感词的条目几乎肯定是误抽），限长、去空白。
 */
export function sanitizeFact(fact: string, config = DEFAULT_MEMORY_CONFIG): string | null {
  const raw = String(fact ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (FACT_FORBIDDEN_RE.test(raw)) return null;
  // 明显是「过程叙述」而不是「稳定事实」的条目丢掉，避免事实库退化成流水
  if (raw.length < 2) return null;
  // 只保留短句：太长的一律截断（事实应当是「一行一条」）
  const clipped = raw.slice(0, config.factMaxChars).trim();
  // 结尾的句号/逗号去掉，便于去重比较
  return clipped.replace(/[。，,.;；]+$/, "").trim() || null;
}

/* ————————————————————————— 角度轮换 ————————————————————————— */

/**
 * 归一化角度文本：去掉标点、空白、常见前缀。
 * 目的是让「问天气」「问 天气。」「关于天气」被认成同一个角度，避免复读判定失效。
 */
export function normalizeAngle(angle: string): string {
  return String(angle ?? "")
    .replace(/^(关于|聊|问|说|谈)/, "")
    .replace(/[\s，,。.、；;：:！!？?"'“”()（）]/g, "")
    .trim();
}

/** 该角度是否已经用过（用于丢弃模型回吐的重复角度，防止角度库被污染） */
export function isAngleReused(angle: string, used: readonly string[]): boolean {
  const target = normalizeAngle(angle);
  if (!target) return true; // 空角度视为「无新意」
  return used.some((item) => {
    const existing = normalizeAngle(item);
    if (!existing) return false;
    return existing === target || existing.includes(target) || target.includes(existing);
  });
}

/**
 * 入库前处理模型给的角度：**重复的角度不入库**（返回 null）。
 *
 * 为什么不让它进：一旦重复角度被记进 `angles.json`，之后两轮都会被它「占位」，
 * 去重提示里也会出现重复项，越用越乱。宁可只丢角度、不丢这条消息。
 */
export function acceptAngle(angle: string | null | undefined, used: readonly string[]): string | null {
  const raw = String(angle ?? "").trim();
  if (!raw) return null;
  if (isAngleReused(raw, used)) return null;
  return raw.slice(0, 40);
}

/* ————————————————————————— 未覆盖消息切片 ————————————————————————— */

/**
 * 取出「尚未被摘要覆盖」的原始消息。
 *
 * `coveredUpToId` 不在列表里时（历史被裁尾过）**保守地认为全部未覆盖**——
 * 宁可多总结一次，也不能假装读过（那会让摘要悄悄缺一段）。
 */
export function uncoveredMessages(
  all: readonly ChatMessage[],
  coveredUpToId: string | null,
  limit = DEFAULT_MEMORY_CONFIG.rawWindowMax,
): ChatMessage[] {
  if (!coveredUpToId) return all.slice(-limit);
  const index = all.findIndex((message) => message.id === coveredUpToId);
  if (index < 0) return all.slice(-limit);
  return all.slice(index + 1).slice(-limit);
}
