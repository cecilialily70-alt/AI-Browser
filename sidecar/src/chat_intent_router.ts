import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** 参考生产实践：互斥意图 + other 兜底（Vellum / DEV intent-as-tool 模式） */
export type ChatIntent =
  | "general_chat"
  | "advice"
  | "browser_navigate"
  | "browser_inspect"
  | "form_assist"
  | "autonomous_agent";

export interface ChatIntentResult {
  intent: ChatIntent;
  confidence: number;
  reason: string;
}

/** Chat → Agent 桥接标记（前端解析后调用 start_autonomous_agent；禁止在 Chat 内造半套 Agent） */
export const AGENT_BRIDGE_OPEN = "⟦tsi_agent_bridge⟧";
export const AGENT_BRIDGE_CLOSE = "⟦/tsi_agent_bridge⟧";

export interface AgentBridgePayload {
  v: 1;
  action: "start";
  goal: string;
  intent: "autonomous_agent";
}

const ALL_TOOL_NAMES = [
  "get_current_url",
  "get_interactive_elements",
  "get_page_form_schema",
  "navigate_to_url",
] as const;

function lastAssistantMessage(history?: ChatHistoryMessage[]): string | null {
  if (!history?.length) {
    return null;
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!;
    if (item.role === "assistant" && item.content.trim()) {
      return item.content.trim();
    }
  }
  return null;
}

export function isAffirmativeReply(message: string): boolean {
  return /^(是的|是|好(的|吧)?|可以|行|嗯+|对|要|OK|ok|yes|y)[。.!？?~]*$/i.test(message.trim());
}

export function isCloseTabCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(close tab|close page)$/i.test(trimmed)) {
    return true;
  }
  return /^(?:关闭|关掉)(?:当前|这个)?(?:标签页?|页面|网页)/i.test(trimmed);
}
export function hasExplicitBrowserNavigateIntent(message: string): boolean {
  const trimmed = message.trim().replace(/[。.!！？?~～]+$/g, "");
  if (!trimmed || trimmed === "打开" || trimmed === "访问") {
    return false;
  }
  if (/^(打开|开启)(浏览器|环境|窗口)$/i.test(trimmed)) {
    return false;
  }
  // 允许「打开百度」「打开 https://…」「打开：淘宝」——分隔符可选
  if (/^(打开|访问|去(?:一下)?|navigate|open|visit)\s*\S+/i.test(trimmed)) {
    return true;
  }
  if (/^直接搜索\s*[：:\s]*/i.test(trimmed)) {
    return true;
  }
  if (/^搜(?:索|一下)\s*[「"'：:\s]?\S+/i.test(trimmed)) {
    return true;
  }
  return /^(打开|访问)(谷歌|google|百度|baidu|必应|bing|youtube)/i.test(trimmed);
}

export function isCurrentUrlQuestion(message: string): boolean {
  return /^(当前网址|当前链接|现在(?:的)?网址|页面网址|get_current_url|current url)/i.test(message.trim());
}

export function isFormAssistQuestion(message: string): boolean {
  const trimmed = message.trim();
  if (isAutonomousAgentGoal(trimmed)) {
    return false;
  }
  return /填表|表单|字段映射|键值对|结账|信用卡|cvv|风控|hidden|token|模板|json.*填|生成.*json/i.test(trimmed);
}

/**
 * 多步自主任务（注册 / 下单 / 订票 / 明确委托 Agent 等）。
 * 纯闲聊、单步打开/搜索、仅要填表 JSON 不得命中。
 */
export function isAutonomousAgentGoal(message: string): boolean {
  const trimmed = message.trim().replace(/[。.!！？?~～]+$/g, "");
  if (!trimmed || trimmed.length < 2) {
    return false;
  }
  // 单步导航优先走 browser_navigate，不升级为 Agent
  if (hasExplicitBrowserNavigateIntent(trimmed) && !/(?:然后|接着|并|且|之后|再).{0,24}(?:注册|下单|购买|登录|填)/i.test(trimmed)) {
    return false;
  }
  // 仅要表单 schema / JSON 模板 → form_assist
  if (/^(?:生成|输出|导出|给我)?(?:一下)?(?:填表|表单)?\s*(?:json|JSON|模板|键值对)/i.test(trimmed)) {
    return false;
  }
  if (/^(?:当前|这个)?(?:页面)?(?:表单|字段)/i.test(trimmed) && !/注册|下单|购买/.test(trimmed)) {
    return false;
  }

  /*
   * 信息型「读当前页」请求（总结这个网站 / 分析当前页面 / 这个站点是做什么的）。
   * Chat 内没有「读页面并归纳」的工具，只有 DOM 扫描类工具；这类请求桥接给 Agent 的
   * page_summary（只读当前页、不导航、不滚动），与「Chat 不半套造 Agent」的纪律一致。
   * 涉及表单/字段/JSON 模板的仍归 form_assist（那是填表能力，不是页面总结）。
   */
  if (
    !/表单|字段|json|模板|键值对|填表/.test(trimmed) &&
    /总结|摘要|概括|分析|介绍|解读|梳理|综述|是什么|做什么|干什么|什么网站|有什么用|靠什么/.test(trimmed) &&
    /网站|站点|页面|网页|官网/.test(trimmed)
  ) {
    return true;
  }

  if (
    /(?:帮我|替我|给我|请|自动)?(?:注册|创建)(?:一下)?(?:这个|该|当前)?(?:网站|站点|页面)?(?:的)?(?:账号|账户|会员|用户)/i.test(
      trimmed,
    ) ||
    /(?:账号|账户|会员).{0,8}(?:注册|创建)/i.test(trimmed) ||
    /sign\s*up|create\s+(?:an?\s+)?account|register\s+(?:an?\s+)?account/i.test(trimmed)
  ) {
    return true;
  }

  if (
    /(?:帮我|替我|请|自动)?(?:登录|登入)(?:一下)?(?:这个|该|当前)?(?:网站|站点|账号|账户)/i.test(trimmed) ||
    /log\s*in\s+to|sign\s*in\s+to/i.test(trimmed)
  ) {
    return true;
  }

  if (
    /(?:帮我|替我|请|自动)?(?:下单|购买|买|加购|加入购物车|订票|预订|预约)/i.test(trimmed) ||
    /(?:place\s+an?\s+order|add\s+to\s+cart|check\s*out|book\s+a)/i.test(trimmed)
  ) {
    return true;
  }

  if (
    /(?:启动|运行|调用)?(?:自主)?\s*agent/i.test(trimmed) ||
    /(?:用|让)agent(?:帮我|去|来)?/i.test(trimmed) ||
    /多步(?:任务|操作|浏览)/i.test(trimmed)
  ) {
    return true;
  }

  if (
    /(?:帮我|替我|请)(?:完成|搞定|处理|走完|跑完).{0,20}(?:注册|登录|下单|购买|结账|验证|流程)/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}

export function buildAutonomousAgentBridgeReply(goal: string): string {
  const payload: AgentBridgePayload = {
    v: 1,
    action: "start",
    goal: goal.replace(/\s+/g, " ").trim(),
    intent: "autonomous_agent",
  };
  return [
    "已识别为多步浏览器任务，正在拉起自主 Agent（与操作栏「启动 Agent」同一通道）。",
    "支付 / 改密等关键步骤仍会停在人工确认，不会无人扣款。",
    "",
    `${AGENT_BRIDGE_OPEN}${JSON.stringify(payload)}${AGENT_BRIDGE_CLOSE}`,
  ].join("\n");
}

export function parseAgentBridgePayload(reply: string): AgentBridgePayload | null {
  const start = reply.indexOf(AGENT_BRIDGE_OPEN);
  const end = reply.indexOf(AGENT_BRIDGE_CLOSE);
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }
  const raw = reply.slice(start + AGENT_BRIDGE_OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<AgentBridgePayload>;
    if (parsed?.v !== 1 || parsed.action !== "start" || parsed.intent !== "autonomous_agent") {
      return null;
    }
    const goal = typeof parsed.goal === "string" ? parsed.goal.replace(/\s+/g, " ").trim() : "";
    if (!goal) {
      return null;
    }
    return { v: 1, action: "start", goal, intent: "autonomous_agent" };
  } catch {
    return null;
  }
}

export function stripAgentBridgeMarker(reply: string): string {
  const start = reply.indexOf(AGENT_BRIDGE_OPEN);
  const end = reply.indexOf(AGENT_BRIDGE_CLOSE);
  if (start < 0 || end < 0 || end <= start) {
    return reply.trim();
  }
  const before = reply.slice(0, start).trim();
  const after = reply.slice(end + AGENT_BRIDGE_CLOSE.length).trim();
  return [before, after].filter(Boolean).join("\n").trim();
}

export function isBrowserInspectQuestion(message: string): boolean {
  const trimmed = message.trim();
  if (isCurrentUrlQuestion(trimmed) || isFormAssistQuestion(trimmed)) {
    return true;
  }
  return /当前页面|页面结构|交互元素|扫描页面|分析页面|什么网站|在哪个网站/i.test(trimmed);
}

export function isAdviceQuestion(message: string): boolean {
  const trimmed = message.trim();
  if (
    hasExplicitBrowserNavigateIntent(trimmed) ||
    isBrowserInspectQuestion(trimmed) ||
    isAutonomousAgentGoal(trimmed)
  ) {
    return false;
  }
  return /建议|推荐|怎么选|如何选择|对比|好不好|靠谱吗|有什么注意|最佳实践/i.test(trimmed);
}

export function isGeneralKnowledgeQuestion(message: string): boolean {
  const trimmed = message.trim();
  if (
    hasExplicitBrowserNavigateIntent(trimmed) ||
    isBrowserInspectQuestion(trimmed) ||
    isAdviceQuestion(trimmed) ||
    isAutonomousAgentGoal(trimmed)
  ) {
    return false;
  }
  if (/^(输出|导出|显示|元素提取|当前网址|当前页面|填表|表单|打开|访问|直接搜索|搜索)/i.test(trimmed)) {
    return false;
  }
  if (isAffirmativeReply(trimmed)) {
    return false;
  }
  return /是什么|什么是|为什么|怎么回事|什么意思|如何|怎么|怎样|介绍|解释|区别|吗[？?]?$|呢[？?]?$|你好|hello|hi/i.test(
    trimmed,
  );
}

/**
 * 级联意图路由（参考 Semantic Router + 规则兜底）：
 * 1. 显式浏览器动作优先
 * 2. 多步自主 Agent（注册/下单等）— 桥接启动，不在 Chat 内执行
 * 3. 页面/填表次之
 * 4. 建议类
 * 5. 常识闲聊
 */
export function classifyChatIntent(
  message: string,
  history?: ChatHistoryMessage[],
): ChatIntentResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: "general_chat", confidence: 0.5, reason: "empty" };
  }

  if (hasExplicitBrowserNavigateIntent(trimmed)) {
    // 「打开 X 并注册」类复合目标升级为 Agent
    if (isAutonomousAgentGoal(trimmed)) {
      return { intent: "autonomous_agent", confidence: 0.92, reason: "navigate_plus_multi_step" };
    }
    return { intent: "browser_navigate", confidence: 0.95, reason: "explicit_navigate_verb" };
  }

  if (isAutonomousAgentGoal(trimmed)) {
    return { intent: "autonomous_agent", confidence: 0.93, reason: "multi_step_agent_keywords" };
  }

  if (isFormAssistQuestion(trimmed)) {
    return { intent: "form_assist", confidence: 0.9, reason: "form_keywords" };
  }

  if (isBrowserInspectQuestion(trimmed)) {
    return { intent: "browser_inspect", confidence: 0.88, reason: "inspect_keywords" };
  }

  if (isAdviceQuestion(trimmed)) {
    return { intent: "advice", confidence: 0.82, reason: "advice_keywords" };
  }

  if (isAffirmativeReply(trimmed)) {
    const last = lastAssistantMessage(history);
    if (last && /(?:拉起|启动).{0,12}(?:自主\s*)?Agent|tsi_agent_bridge|多步浏览器任务/i.test(last)) {
      return { intent: "autonomous_agent", confidence: 0.8, reason: "affirmative_after_agent_offer" };
    }
    if (last && /(?:打开|访问|搜索|搜一下|navigate|元素提取|当前页面)/i.test(last)) {
      return { intent: "browser_navigate", confidence: 0.75, reason: "affirmative_after_browser_offer" };
    }
    return { intent: "general_chat", confidence: 0.7, reason: "affirmative_continue_chat" };
  }

  if (isGeneralKnowledgeQuestion(trimmed)) {
    return { intent: "general_chat", confidence: 0.85, reason: "knowledge_question" };
  }

  if (/打开|访问|网址|url|页面|填表|搜索/i.test(trimmed)) {
    return { intent: "browser_inspect", confidence: 0.55, reason: "weak_browser_signal" };
  }

  return { intent: "general_chat", confidence: 0.6, reason: "default_chat" };
}

export function intentToolChoice(intent: ChatIntent): "none" | "auto" {
  if (intent === "general_chat" || intent === "advice" || intent === "autonomous_agent") {
    return "none";
  }
  return "auto";
}

export function intentTemperature(intent: ChatIntent): number {
  if (intent === "general_chat" || intent === "advice") {
    return 0.55;
  }
  if (intent === "form_assist") {
    return 0.25;
  }
  if (intent === "autonomous_agent") {
    return 0.2;
  }
  return 0.35;
}

export function filterToolsForIntent(
  tools: ChatCompletionTool[],
  intent: ChatIntent,
): ChatCompletionTool[] {
  const allow = new Set<string>();
  switch (intent) {
    case "browser_navigate":
      allow.add("navigate_to_url");
      break;
    case "browser_inspect":
      allow.add("get_current_url");
      allow.add("get_interactive_elements");
      allow.add("get_page_form_schema");
      break;
    case "form_assist":
      for (const name of ALL_TOOL_NAMES) {
        if (name !== "navigate_to_url") {
          allow.add(name);
        }
      }
      break;
    case "autonomous_agent":
      // 禁止在 Chat 内半套造 Agent：不开放任何浏览器工具
      return [];
    default:
      return [];
  }
  return tools.filter((tool) => {
    if (tool.type !== "function") {
      return false;
    }
    return allow.has(tool.function.name);
  });
}

export function buildIntentHint(intent: ChatIntentResult): string {
  const lines: Record<ChatIntent, string> = {
    general_chat: "【本轮意图】常识/闲聊 — 直接用中文回答，禁止调用任何工具。",
    advice: "【本轮意图】咨询建议 — 先给清晰建议与步骤；除非用户明确要求扫描页面，否则禁止调用工具。",
    browser_navigate: "【本轮意图】浏览器导航 — 必须调用 navigate_to_url 实际打开/搜索，禁止只口头答应。",
    browser_inspect: "【本轮意图】页面读取 — 必须调用 get_current_url 或 get_interactive_elements 获取真实数据后再答。",
    form_assist: "【本轮意图】填表辅助 — 必须先 get_interactive_elements（优先）扫描页面，再生成 JSON 键值对；禁止编造字段。",
    autonomous_agent:
      "【本轮意图】多步自主 Agent — 禁止在本对话内逐步点击/填表；宿主将拉起完整 Agent。仅用一句话确认已识别任务。",
  };
  return `${lines[intent.intent]}\n（判定：${intent.reason}，置信 ${Math.round(intent.confidence * 100)}%）`;
}

export const CHAT_ROUTING_FEW_SHOT = [
  "【路由示例 — 模仿此边界】",
  "用户: React 是什么 → 直接解释，不调工具",
  "用户: SEO 和 SEM 区别 → 直接对比解释，不调工具",
  "用户: 填表有什么建议 → 文字给建议；若需字段清单再问是否扫描页面",
  "用户: 打开百度 → navigate_to_url(target=百度, mode=auto)",
  "用户: 搜索 CloakBrowser 文档 → navigate_to_url(mode=search)",
  "用户: 当前网址 → get_current_url",
  "用户: 生成填表 JSON 模板 → get_interactive_elements 后输出 key 与页面一致的 JSON",
  "用户: 帮我注册这个网站账号 → 桥接启动自主 Agent（禁止在 Chat 内逐步操作）",
  "用户: 帮我下单买这件商品 → 桥接启动自主 Agent（支付前停）",
  "用户: 总结这个网站 / 分析当前页面 → 桥接启动自主 Agent（page_summary 只读当前页，不导航）",
].join("\n");
