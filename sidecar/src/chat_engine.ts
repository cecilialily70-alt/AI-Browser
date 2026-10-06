import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions.mjs";

import { createModelRouter } from "./ai_model_router.js";
import { formatLlmInterruptMessage, isLlmAbortOrTimeoutError } from "./ai_client.js";
import { safeGoto, withActivePageViaCdp } from "./cdp_session.js";
import { extractPageFormSchema } from "./dom_parser.js";
import {
  buildInteractiveElementsToolPayload,
  formatInteractiveElementsFullJson,
  formatInteractiveElementsSummary,
  readInteractiveElementCache,
  snapshotInteractiveElements,
} from "./interactive_elements.js";
import type { SidecarAiSettings } from "./engine.js";
import {
  buildAutonomousAgentBridgeReply,
  buildIntentHint,
  CHAT_ROUTING_FEW_SHOT,
  classifyChatIntent,
  filterToolsForIntent,
  intentTemperature,
  intentToolChoice,
  isAffirmativeReply,
  isAutonomousAgentGoal,
  isCloseTabCommand,
  isCurrentUrlQuestion,
  isGeneralKnowledgeQuestion,
  type ChatHistoryMessage,
} from "./chat_intent_router.js";
import { JsonLogger } from "./json-logger.js";
import {
  isGoogleSorryOrCaptchaUrl,
  performEngineFormSearch,
} from "./search_navigator.js";
import { engineHomepage, defaultEngineId } from "./core/page_policy.js";

export type { ChatHistoryMessage };

const SITE_ALIASES: Record<string, string> = {
  谷歌: engineHomepage("google"),
  google: engineHomepage("google"),
  百度: engineHomepage("baidu"),
  baidu: engineHomepage("baidu"),
  bing: engineHomepage("bing"),
  必应: engineHomepage("bing"),
  duckduckgo: engineHomepage("duckduckgo"),
  youtube: "https://www.youtube.com/",
  油管: "https://www.youtube.com/",
  github: "https://github.com/",
  twitter: "https://x.com/",
  x: "https://x.com/",
};

const CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_current_url",
      description:
        "【只读】获取当前浏览器活动标签页的真实 URL。何时使用：用户问「当前网址/链接/在什么网站」。何时不要用：常识问答、概念解释、用户未提及当前页面。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_interactive_elements",
      description:
        "【只读】扫描当前页面可见交互元素（input/select/textarea/button/link 等），返回含 selector 的精简列表。何时使用：填表模板、字段映射、风控排查、分析页面控件。何时不要用：与页面无关的知识问答。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_form_schema",
      description:
        "【只读】扫描表单控件 id/name/type/label（旧流程）。何时使用：仅需传统表单字段列表。何时不要用：优先 get_interactive_elements；不要做常识问答。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate_to_url",
      description:
        "【写入】在当前浏览器打开网址或谷歌搜索。何时使用：用户明确说「打开/访问/去/搜索 + 目标」，或上一轮你提议搜索/打开且用户肯定。何时不要用：「XX是什么」类知识问题；「给建议/推荐」类咨询；用户未要求打开浏览器。",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "完整 URL、域名（baidu.com）、站点别名（谷歌/百度），或搜索关键词。",
          },
          mode: {
            type: "string",
            enum: ["auto", "url", "search"],
            description:
              "auto=自动；url=强制网址；search=强制 Google 填表搜索（首页输入关键词后点搜索按钮，禁止直接打开 SERP URL）。",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
  },
];

export interface ChatAttachmentPayload {
  kind: "image" | "text" | string;
  name: string;
  mime: string;
  dataUrl?: string | null;
  textContent?: string | null;
}

export interface ChatEngineInput {
  message: string;
  history?: ChatHistoryMessage[];
  cdpPort?: number | null;
  profileId?: string | null;
  userDataDir?: string | null;
  aiSettings: SidecarAiSettings;
  /** 可选：宿主中止信号，传入后立即掐断在途 LLM HTTP */
  signal?: AbortSignal;
  /** Ai Chat 附件（图片 / 文本类）；禁止当 OTP 取码 */
  attachments?: ChatAttachmentPayload[];
  /** 当前环境采集结果摘要（条数/列/预览） */
  scrapeSummary?: string | null;
}

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"] as const;

function getLocalDateTimeContext(timeZone = "Asia/Shanghai"): {
  formatted: string;
  weekdayCn: string;
  isoDate: string;
} {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayKey = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  const weekdayCn = WEEKDAY_CN[weekdayMap[dayKey] ?? 0] ?? "日";
  const isoDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { formatted, weekdayCn, isoDate };
}

function buildSystemPromptContent(
  profileId?: string | null,
  cdpPort?: number | null,
  intentHint?: string,
  scrapeSummary?: string | null,
): string {
  const { formatted } = getLocalDateTimeContext();
  const profileHint = profileId ? `当前环境 ID: ${profileId}。` : "未绑定具体环境。";
  const cdpHint = cdpPort
    ? `浏览器 CDP 端口: ${cdpPort}。`
    : "浏览器未启动；涉及页面/导航的工具调用会提示先启动环境。";
  const scrapeHint = scrapeSummary?.trim()
    ? `\n【当前采集数据摘要·可据此分析问答·勿编造未出现的行】\n${scrapeSummary.trim().slice(0, 6000)}`
    : "";

  return [
    "你是天枢台本地指纹浏览器的 AI 助手。自我介绍时使用「天枢台助手」。",
    "你必须 100% 使用中文回复，语气简洁，禁止每轮重复罗列能力清单。",
    `当前本地时间（北京时间）：${formatted}。问日期/星期/几点时直接据此回答。`,
    "",
    CHAT_ROUTING_FEW_SHOT,
    "",
    intentHint ?? "",
    "",
    "【核心原则】",
    "- 与浏览器无关 → 直接用知识回答（tool_choice 为空）。",
    "- 需要真实页面数据 → 必须先调只读工具，禁止编造 URL/字段。",
    "- 需要打开/搜索 → 必须 navigate_to_url，禁止只口头答应。",
    "- 用户说「启动/开启/运行浏览器或环境」→ 由宿主程序启动浏览器，禁止让用户手动点操作栏或口头假装已启动。",
    "- 用户说「停止/关闭/退出浏览器或环境」→ 由宿主程序停止浏览器，禁止口头假装已停止。",
    "- 用户说「关闭当前标签/页面」→ 通过 CDP 关闭活动标签，禁止让用户手动关。",
    "- 给建议 → 可以纯文字；用户明确要求再扫描页面。",
    "- 用户附件中的短信/邮箱截图 → 禁止据此自动填写验证码或编造 token；请提示走人工确认通道。",
    "",
    "填表 JSON：key 必须与页面 name/id 一致；排除 hidden/likelyDynamic/token 类字段。",
    profileHint,
    cdpHint,
    scrapeHint,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function buildUserMessageContent(
  message: string,
  attachments?: ChatAttachmentPayload[],
): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  const textParts: string[] = [message.trim() || "请结合附件回答。"];
  const images: string[] = [];
  for (const item of attachments ?? []) {
    if (item.kind === "text" && item.textContent?.trim()) {
      textParts.push(
        `\n【附件文本·${item.name}】\n${item.textContent.trim().slice(0, 60_000)}`,
      );
    } else if (item.kind === "image" && item.dataUrl?.startsWith("data:image/")) {
      images.push(item.dataUrl);
      textParts.push(`\n（已附图片：${item.name}）`);
    } else if (item.name) {
      textParts.push(`\n（已附文件：${item.name}，类型 ${item.mime || "unknown"}）`);
    }
  }
  const text = textParts.join("\n").trim();
  if (images.length === 0) {
    return text;
  }
  return [
    { type: "text", text },
    ...images.slice(0, 4).map((url) => ({
      type: "image_url" as const,
      image_url: { url },
    })),
  ];
}

function buildChatMessages(
  input: ChatEngineInput,
  intentHint?: string,
  historyLimit = 20,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildSystemPromptContent(
        input.profileId,
        input.cdpPort,
        intentHint,
        input.scrapeSummary,
      ),
    },
  ];

  for (const item of (input.history ?? []).slice(-historyLimit)) {
    const role = item.role === "assistant" ? "assistant" : "user";
    const content = item.content.trim();
    if (!content) {
      continue;
    }
    messages.push({ role, content });
  }

  messages.push({
    role: "user",
    content: buildUserMessageContent(input.message, input.attachments),
  });
  return messages;
}

function extractPendingSearchQuery(assistantText: string): string | null {
  const patterns = [
    /搜索(?:一下)?[「"']([^」"'?？]+)[」"']/,
    /帮你搜索[「"']([^」"']+)[」"']/,
    /搜索(?:一下)?[：:]\s*([^\n?？]+)/,
  ];
  for (const pattern of patterns) {
    const matched = assistantText.match(pattern);
    const query = matched?.[1]?.trim();
    if (query) {
      return query.replace(/[吗呢吧？?]+$/g, "").trim();
    }
  }
  if (/搜索|搜一下/.test(assistantText) && /星期几|周几|今天/.test(assistantText)) {
    return "今天是星期几";
  }
  return null;
}

function extractPendingOpenTarget(assistantText: string): string | null {
  const matched = assistantText.match(/(?:打开|访问)[「"']([^」"']+)[」"']/);
  return matched?.[1]?.trim() ?? null;
}

/** 从上一轮助手桥接文案或用户原目标中恢复 Agent goal */
function extractPendingAgentGoal(history?: ChatHistoryMessage[]): string | null {
  if (!history?.length) {
    return null;
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!;
    if (item.role === "user" && item.content.trim()) {
      const text = item.content.trim();
      // 跳过纯肯定词，继续找更早的用户目标
      if (isAffirmativeReply(text)) {
        continue;
      }
      return text;
    }
  }
  return null;
}

async function tryDirectDateTimeResponse(message: string): Promise<string | null> {
  const trimmed = message.trim();
  if (
    !/(星期几|周几|今天几号|今天.*日期|几点了|现在.*时间|what day|what date|today)/i.test(trimmed)
  ) {
    return null;
  }
  const { formatted, weekdayCn } = getLocalDateTimeContext();
  if (/星期几|周几|what day/i.test(trimmed)) {
    return `今天是星期${weekdayCn}。\n\n${formatted}（北京时间）`;
  }
  if (/几点|时间|what time/i.test(trimmed)) {
    return `现在是 ${formatted}（北京时间）。`;
  }
  return `今天是 ${formatted}（北京时间），星期${weekdayCn}。`;
}

async function tryDirectNavigateCommand(
  message: string,
  input: ChatEngineInput,
  logger: JsonLogger,
): Promise<string | null> {
  if (isGeneralKnowledgeQuestion(message)) {
    return null;
  }

  const parsed = parseDirectNavigateCommand(message);
  if (!parsed) {
    return null;
  }

  const { kind, target } = parsed;
  if (!input.cdpPort) {
    return `需要先启动该环境浏览器，我才能帮你${kind === "search" ? "搜索" : "打开"}「${target}」。`;
  }

  const mode: "auto" | "search" = kind === "search" ? "search" : "auto";
  try {
    const result = await navigateToUrlViaCdp(input.cdpPort, target, mode, logger);
    return formatNavigateUserReply(kind === "search" ? "search" : "open", target, result);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return `导航失败：${err}`;
  }
}

/** 解析「打开/访问/搜索」口令；分隔符可选，支持「打开百度」「打开https://a.com」 */
function parseDirectNavigateCommand(
  message: string,
): { kind: "open" | "search"; target: string } | null {
  const trimmed = message.trim().replace(/[。.!！？?~～]+$/g, "");
  if (!trimmed) {
    return null;
  }

  // 启动环境口令，不是打开网页
  if (/^(?:打开|开启|运行)(?:浏览器|环境|窗口)?$/i.test(trimmed)) {
    return null;
  }
  if (/^(?:start)(?:\s+browser|\s+profile)?$/i.test(trimmed)) {
    return null;
  }

  const stripWrap = (value: string): string =>
    value
      .trim()
      .replace(/^[「"'【\[]+/, "")
      .replace(/[」"'】\]]+$/, "")
      .trim();

  const searchMatch =
    trimmed.match(/^(?:直接搜索|搜索|搜一下)\s*[：:]*\s*(.+)$/i) ??
    trimmed.match(/^搜\s*[：:]\s*(.+)$/i);
  if (searchMatch?.[1]) {
    const target = stripWrap(searchMatch[1]);
    if (target) {
      return { kind: "search", target };
    }
  }

  const openMatch =
    trimmed.match(/^(?:打开|访问|去一下|去)\s*[：:]*\s*(.+)$/i) ??
    trimmed.match(/^(?:open|visit|navigate(?:\s+to)?)\s+(.+)$/i);
  if (openMatch?.[1]) {
    const target = stripWrap(openMatch[1]);
    if (!target || /^(浏览器|环境|窗口|browser|profile)$/i.test(target)) {
      return null;
    }
    return { kind: "open", target };
  }

  return null;
}

function lastAssistantOfferedBrowserAction(assistantText: string): boolean {
  const text = assistantText.trim();
  if (!/(?:需要我|是否|要不要|帮你|要我)/.test(text)) {
    return false;
  }
  return /(?:打开|访问|搜索|搜一下|navigate|元素提取|当前页面|当前网址|get_current_url)/i.test(text);
}

async function tryDirectAffirmativeResponse(
  input: ChatEngineInput,
  logger: JsonLogger,
): Promise<string | null> {
  if (!isAffirmativeReply(input.message)) {
    return null;
  }

  const history = input.history ?? [];
  const lastAssistant = [...history].reverse().find((item) => item.role === "assistant");
  if (!lastAssistant?.content.trim() || !lastAssistantOfferedBrowserAction(lastAssistant.content)) {
    return null;
  }

  const searchQuery = extractPendingSearchQuery(lastAssistant.content);
  const openTarget = extractPendingOpenTarget(lastAssistant.content);
  const navigateTarget = searchQuery ?? openTarget;
  if (!navigateTarget) {
    return null;
  }

  if (!input.cdpPort) {
    return `好的。请先启动该环境浏览器，我才能帮你${searchQuery ? "搜索" : "打开"}「${navigateTarget}」。`;
  }

  const mode: "auto" | "search" = searchQuery ? "search" : "auto";
  try {
    const result = await navigateToUrlViaCdp(input.cdpPort, navigateTarget, mode, logger);
    logger.progress("direct_affirmative_navigate", { target: navigateTarget, mode, finalUrl: result.finalUrl });
    return formatNavigateUserReply(searchQuery ? "search" : "open", navigateTarget, result);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return `操作失败：${err}`;
  }
}

interface NavigationPlan {
  gotoUrl: string;
  searchQuery: string | null;
  /** 检索用的引擎 id；null = 用政策默认引擎 */
  engine: string | null;
}

/** 解析导航意图：关键词固定走引擎首页填表搜索，禁止构造 SERP URL */
function resolveNavigationPlan(
  rawTarget: string,
  mode: "auto" | "url" | "search",
  engineId: string | null = null,
): NavigationPlan {
  const trimmed = rawTarget.trim();
  // 政策：没指明引擎时用配置里的默认引擎（通常 google）；地址同样来自配置，不写死字面量
  const defaultHome = engineHomepage(engineId);
  if (!trimmed) {
    return { gotoUrl: defaultHome, searchQuery: null, engine: engineId };
  }

  if (mode === "search") {
    return { gotoUrl: defaultHome, searchQuery: trimmed, engine: engineId };
  }

  const alias = SITE_ALIASES[trimmed] ?? SITE_ALIASES[trimmed.toLowerCase()];
  if (alias && mode !== "url") {
    return { gotoUrl: alias, searchQuery: null, engine: engineId };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { gotoUrl: trimmed, searchQuery: null, engine: engineId };
  }

  if (
    mode === "url" ||
    /^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#].*)?$/i.test(trimmed) ||
    /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(trimmed)
  ) {
    return { gotoUrl: `https://${trimmed.replace(/^\/+/, "")}`, searchQuery: null, engine: engineId };
  }

  return { gotoUrl: defaultHome, searchQuery: trimmed, engine: engineId };
}
export async function getCurrentUrlViaCdp(cdpPort: number, logger: JsonLogger): Promise<string> {
  return withActivePageViaCdp(cdpPort, logger, "正在通过 CDP 连接浏览器获取 URL...", async (page) =>
    page.url(),
  );
}

export async function closeActiveTabViaCdp(cdpPort: number, logger: JsonLogger): Promise<string> {
  return withActivePageViaCdp(cdpPort, logger, "正在关闭当前活动标签页...", async (page) => {
    const closedUrl = page.url();
    await page.close();
    return closedUrl;
  });
}

export async function getInteractiveElementsViaCdp(
  cdpPort: number,
  logger: JsonLogger,
  userDataDir?: string | null,
) {
  return withActivePageViaCdp(
    cdpPort,
    logger,
    "正在通过 CDP 扫描页面交互元素...",
    async (page) => {
      const cached = userDataDir ? await readInteractiveElementCache(userDataDir, page.url()) : null;
      if (cached) {
        return cached;
      }
      return snapshotInteractiveElements(page, userDataDir ?? undefined);
    },
  );
}

export async function getPageFormSchemaViaCdp(cdpPort: number, logger: JsonLogger) {
  return withActivePageViaCdp(
    cdpPort,
    logger,
    "正在通过 CDP 扫描页面表单结构...",
    async (page) => extractPageFormSchema(page),
  );
}

export interface NavigateCdpResult {
  url: string;
  finalUrl: string;
  /** 实际使用的搜索引擎 id（来自政策数据） */
  searchEngine?: string;
  googleSorry?: boolean;
}

export async function navigateToUrlViaCdp(
  cdpPort: number,
  target: string,
  mode: "auto" | "url" | "search",
  logger: JsonLogger,
): Promise<NavigateCdpResult> {
  const plan = resolveNavigationPlan(target, mode);

  return withActivePageViaCdp(
    cdpPort,
    logger,
    plan.searchQuery
      ? `正在 ${plan.engine ?? defaultEngineId()} 首页填表搜索「${plan.searchQuery}」...`
      : `正在导航到 ${plan.gotoUrl} ...`,
    async (page) => {
      if (plan.searchQuery) {
        try {
          const searchResult = await performEngineFormSearch(page, plan.searchQuery, plan.engine, logger);
          return {
            url: searchResult.startUrl,
            finalUrl: searchResult.finalUrl,
            searchEngine: searchResult.engine,
            googleSorry: searchResult.googleSorry,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`引擎首页填表搜索失败: ${message}`);
        }
      }

      try {
        await safeGoto(page, plan.gotoUrl);
        return { url: plan.gotoUrl, finalUrl: page.url() };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `打开网址失败（domcontentloaded 超时或网络不可达，上限 ${15_000}ms）: ${plan.gotoUrl} — ${message}`,
        );
      }
    },
  );
}

function formatNavigateUserReply(
  action: "search" | "open",
  target: string,
  result: NavigateCdpResult,
): string {
  if (action === "search") {
    if (isGoogleSorryOrCaptchaUrl(result.finalUrl)) {
      return [
        `已在 Google 尝试填表搜索「${target}」，但触发了验证拦截页（/sorry/）。`,
        "",
        "这多为代理 IP 信誉问题。建议：换住宅/移动代理，或在浏览器内手动完成验证码后重试。",
        "搜索固定使用 Google 首页填表，不会直接打开带参数的搜索链接。",
      ].join("\n");
    }
    return [
      `已在 Google 通过填表搜索「${target}」。`,
      "搜索引擎：Google（首页输入 + 表单提交）",
      "结果页已加载，可在浏览器中查看。",
    ].join("\n");
  }

  if (isGoogleSorryOrCaptchaUrl(result.finalUrl)) {
    return [
      `已打开「${target}」，但当前为 Google 验证拦截页。`,
      `当前地址：${result.finalUrl}`,
      "建议换代理或在浏览器内手动完成验证。",
    ].join("\n");
  }

  if (result.finalUrl && result.finalUrl !== result.url) {
    return `已打开「${target}」→ ${result.finalUrl}`;
  }
  return `已打开「${target}」${result.finalUrl ? `（${result.finalUrl}）` : ""}`;
}

async function executeToolCall(
  toolCall: ChatCompletionMessageToolCall,
  input: ChatEngineInput,
  logger: JsonLogger,
): Promise<string> {
  if (toolCall.type !== "function") {
    return JSON.stringify({ error: `unsupported tool type: ${toolCall.type}` });
  }

  if (!input.cdpPort) {
    return JSON.stringify({
      error: "无法获取：环境浏览器未启动，请先启动环境后再询问当前页面信息",
    });
  }

  const toolName = toolCall.function.name;

  if (toolName === "get_current_url") {
    try {
      const currentUrl = await getCurrentUrlViaCdp(input.cdpPort, logger);
      return JSON.stringify({ url: currentUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("cdp_get_url_failed", { error: message, cdpPort: input.cdpPort });
      return JSON.stringify({ url: `无法获取：CDP 连接失败 (${message})` });
    }
  }

  if (toolName === "get_interactive_elements") {
    try {
      const snapshot = await getInteractiveElementsViaCdp(
        input.cdpPort,
        logger,
        input.userDataDir ?? null,
      );
      return JSON.stringify(buildInteractiveElementsToolPayload(snapshot));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("cdp_get_interactive_elements_failed", { error: message, cdpPort: input.cdpPort });
      return JSON.stringify({ error: `无法扫描交互元素：CDP 连接失败 (${message})` });
    }
  }

  if (toolName === "get_page_form_schema") {
    try {
      const schema = await getPageFormSchemaViaCdp(input.cdpPort, logger);
      return JSON.stringify(schema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("cdp_get_form_schema_failed", { error: message, cdpPort: input.cdpPort });
      return JSON.stringify({ error: `无法扫描表单：CDP 连接失败 (${message})` });
    }
  }

  if (toolName === "navigate_to_url") {
    try {
      let args: { target?: string; mode?: string } = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}") as {
          target?: string;
          mode?: string;
        };
      } catch {
        args = {};
      }
      const target = String(args.target ?? "").trim();
      if (!target) {
        return JSON.stringify({ error: "缺少 target 参数" });
      }
      const modeRaw = String(args.mode ?? "auto").trim().toLowerCase();
      const mode: "auto" | "url" | "search" =
        modeRaw === "url" || modeRaw === "search" ? modeRaw : "auto";
      const result = await navigateToUrlViaCdp(input.cdpPort, target, mode, logger);
      logger.progress("chat_navigate_done", {
        target,
        mode,
        url: result.url,
        finalUrl: result.finalUrl,
      });
      return JSON.stringify({
        ok: true,
        requested: target,
        navigatedTo: result.url,
        finalUrl: result.finalUrl,
        searchEngine: result.searchEngine ?? null,
        googleSorryBlocked: isGoogleSorryOrCaptchaUrl(result.finalUrl),
        hint: isGoogleSorryOrCaptchaUrl(result.finalUrl)
          ? "Google 返回 /sorry/ 验证拦截页，多为代理 IP 信誉问题；搜索固定走 Google 填表"
          : result.searchEngine
            ? "已通过 Google 首页填表完成搜索"
            : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("cdp_navigate_failed", { error: message, cdpPort: input.cdpPort });
      return JSON.stringify({ error: `导航失败：${message}` });
    }
  }

  return JSON.stringify({ error: `unknown tool: ${toolName}` });
}

/** 口令归一化：去空白、json 大小写统一 */
function normalizeElementExtractCommand(raw: string): string {
  return raw.trim().replace(/\s+/g, "").replace(/json/gi, "json").toLowerCase();
}

/** 输出摘要：输出元素 = 输出元素提取 */
const ELEMENT_SUMMARY_ALIASES = new Set([
  "输出元素",
  "输出元素提取",
  "输出提取",
  "元素提取",
  "显示元素提取",
  "元素提取结果",
]);

/** 导出 JSON 写入填表框：输出 / 导出 / 提取 / 直接导出 等 */
const ELEMENT_EXPORT_JSON_ALIASES = new Set([
  "输出",
  "导出",
  "提取",
  "直接导出",
  "紧接着导出",
  "导出元素提取",
  "导出元素提取json",
  "导出可见元素",
  "导出可见元素json",
  "元素提取完整json",
  "完整元素提取",
  "元素提取全量",
  "写入原始填表",
]);

/** 用户明确要求输出元素提取结果时，不调用 LLM，直接走 CDP/缓存 */
const INTERACTIVE_ELEMENTS_DIRECT_PATTERNS: RegExp[] = [
  /get[_\s-]*interactive[_\s-]*elements/i,
];

function isInteractiveElementsFullJsonRequest(message: string): boolean {
  const normalized = normalizeElementExtractCommand(message);
  if (!normalized) {
    return false;
  }
  return ELEMENT_EXPORT_JSON_ALIASES.has(normalized);
}

function isInteractiveElementsDirectRequest(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  if (isInteractiveElementsFullJsonRequest(trimmed)) {
    return false;
  }
  const normalized = normalizeElementExtractCommand(trimmed);
  if (ELEMENT_SUMMARY_ALIASES.has(normalized)) {
    return true;
  }
  return INTERACTIVE_ELEMENTS_DIRECT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function formatInteractiveElementsDirectReply(
  snapshot: Awaited<ReturnType<typeof getInteractiveElementsViaCdp>>,
  fullJson: boolean,
): string {
  if (fullJson) {
    return formatInteractiveElementsFullJson(snapshot);
  }
  return formatInteractiveElementsSummary(snapshot);
}

async function tryDirectCloseTabResponse(
  input: ChatEngineInput,
  logger: JsonLogger,
): Promise<string | null> {
  if (!isCloseTabCommand(input.message)) {
    return null;
  }
  if (!input.cdpPort) {
    return "无法关闭标签页：请先启动该环境浏览器。";
  }
  try {
    const closedUrl = await closeActiveTabViaCdp(input.cdpPort, logger);
    logger.progress("direct_close_tab", { closedUrl, cdpPort: input.cdpPort });
    return closedUrl.trim()
      ? `已关闭当前标签页：${closedUrl}`
      : "已关闭当前标签页。";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `关闭标签页失败：${message}`;
  }
}

async function tryDirectCurrentUrlResponse(
  input: ChatEngineInput,
  logger: JsonLogger,
): Promise<string | null> {
  if (!isCurrentUrlQuestion(input.message)) {
    return null;
  }
  if (!input.cdpPort) {
    return "无法获取当前网址：请先启动该环境浏览器。";
  }
  try {
    const url = await getCurrentUrlViaCdp(input.cdpPort, logger);
    return `当前页面 URL：\n${url}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `无法获取当前网址：${message}`;
  }
}

async function tryDirectInteractiveElementsResponse(
  input: ChatEngineInput,
  logger: JsonLogger,
): Promise<string | null> {
  if (!isInteractiveElementsDirectRequest(input.message) && !isInteractiveElementsFullJsonRequest(input.message)) {
    return null;
  }

  const fullJson = isInteractiveElementsFullJsonRequest(input.message);

  logger.progress("direct_interactive_elements", {
    profileId: input.profileId ?? null,
    message: input.message.trim(),
    fullJson,
  });

  if (!input.cdpPort) {
    return "无法输出元素提取：浏览器未运行或未暴露 CDP 端口。请先启动该环境。";
  }

  try {
    const snapshot = await getInteractiveElementsViaCdp(
      input.cdpPort,
      logger,
      input.userDataDir ?? null,
    );
    return formatInteractiveElementsDirectReply(snapshot, fullJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("direct_interactive_elements_failed", {
      error: message,
      cdpPort: input.cdpPort,
    });
    return `无法输出元素提取：CDP 连接失败（${message}）`;
  }
}

export async function runChatEngine(input: ChatEngineInput, logger: JsonLogger): Promise<string> {
  const directElements = await tryDirectInteractiveElementsResponse(input, logger);
  if (directElements !== null) {
    return directElements;
  }

  const directCloseTab = await tryDirectCloseTabResponse(input, logger);
  if (directCloseTab !== null) {
    return directCloseTab;
  }

  const directUrl = await tryDirectCurrentUrlResponse(input, logger);
  if (directUrl !== null) {
    return directUrl;
  }

  const directDateTime = await tryDirectDateTimeResponse(input.message);
  if (directDateTime !== null) {
    return directDateTime;
  }

  // 多步 Agent 目标优先于「打开/搜索」直通，避免只导航不执行后续注册/下单
  const preIntent = classifyChatIntent(input.message, input.history);
  if (preIntent.intent === "autonomous_agent" || isAutonomousAgentGoal(input.message)) {
    logger.progress("chat_intent_classified", {
      intent: "autonomous_agent",
      confidence: preIntent.intent === "autonomous_agent" ? preIntent.confidence : 0.9,
      reason: preIntent.intent === "autonomous_agent" ? preIntent.reason : "multi_step_before_navigate",
      profileId: input.profileId ?? null,
    });
    const goal =
      preIntent.reason === "affirmative_after_agent_offer"
        ? extractPendingAgentGoal(input.history) ?? input.message.trim()
        : input.message.trim();
    logger.progress("chat_agent_bridge", {
      goal: goal.slice(0, 200),
      reason: preIntent.reason,
      profileId: input.profileId ?? null,
    });
    return buildAutonomousAgentBridgeReply(goal);
  }

  const directNavigate = await tryDirectNavigateCommand(input.message, input, logger);
  if (directNavigate !== null) {
    return directNavigate;
  }

  const directAffirmative = await tryDirectAffirmativeResponse(input, logger);
  if (directAffirmative !== null) {
    return directAffirmative;
  }

  const intent = classifyChatIntent(input.message, input.history);
  logger.progress("chat_intent_classified", {
    intent: intent.intent,
    confidence: intent.confidence,
    reason: intent.reason,
    profileId: input.profileId ?? null,
  });

  // 有图走视觉槽；否则侧边聊天走 fast_text
  const hasImages = (input.attachments ?? []).some(
    (item) => item.kind === "image" && Boolean(item.dataUrl?.startsWith("data:image/")),
  );
  const { route, client } = createModelRouter(input.aiSettings).forIntent(
    hasImages ? "vision" : "fast_text",
    hasImages ? "侧边聊天：视觉模型（含附件图）" : "侧边聊天：极速文本模型",
  );
  const model = route.model;
  const intentHint = buildIntentHint(intent);
  const historyLimit =
    intent.intent === "general_chat" || intent.intent === "advice" ? 8 : 20;
  const messages = buildChatMessages(input, intentHint, historyLimit);
  const tools = filterToolsForIntent(CHAT_TOOLS, intent.intent);
  const toolChoice = intentToolChoice(intent.intent);
  const temperature = intentTemperature(intent.intent);

  logger.progress("chat_request_start", {
    model,
    profileId: input.profileId ?? null,
    historyCount: input.history?.length ?? 0,
    intent: intent.intent,
    toolCount: tools.length,
  });

  const MAX_TOOL_ROUNDS = 3;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (input.signal?.aborted) {
      return formatLlmInterruptMessage(new Error("aborted"));
    }
    let response;
    try {
      response = await client.chat.completions.create(
        {
          model,
          messages,
          ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
          temperature,
        },
        { signal: input.signal },
      );
    } catch (error) {
      if (isLlmAbortOrTimeoutError(error)) {
        const summary = formatLlmInterruptMessage(error);
        logger.warn("chat_llm_interrupted", { round: round + 1, error: summary });
        return summary;
      }
      throw error;
    }

    const assistantMessage = response.choices[0]?.message;
    if (!assistantMessage) {
      throw new Error("LLM 返回空响应");
    }

    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls?.length) {
      const content = assistantMessage.content?.trim();
      if (!content) {
        throw new Error("LLM 返回空内容");
      }
      return content;
    }

    messages.push(assistantMessage);

    for (const toolCall of toolCalls) {
      const toolResult = await executeToolCall(toolCall, input, logger);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }

    logger.progress("chat_tool_round_done", {
      round: round + 1,
      toolCallCount: toolCalls.length,
    });

    if (round === MAX_TOOL_ROUNDS - 1) {
      break;
    }
  }

  logger.progress("chat_followup_start", { reason: "max_tool_rounds_or_final_synthesis" });

  let finalResponse;
  try {
    finalResponse = await client.chat.completions.create(
      {
        model,
        messages,
        temperature,
      },
      { signal: input.signal },
    );
  } catch (error) {
    if (isLlmAbortOrTimeoutError(error)) {
      const summary = formatLlmInterruptMessage(error);
      logger.warn("chat_llm_interrupted", { phase: "final", error: summary });
      return summary;
    }
    throw error;
  }

  const finalContent = finalResponse.choices[0]?.message?.content?.trim();
  if (!finalContent) {
    throw new Error("LLM 最终回复为空");
  }

  return finalContent;
}
