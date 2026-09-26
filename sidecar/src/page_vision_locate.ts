/**
 * 视觉定位：全页/视口截图 → 先描述再给坐标 → 按坐标点击。
 * 对齐「问 AI 要点哪个按钮」的人机协作思路；解决 EN 画在图上、DOM 无文字。
 */
import type { Page } from "playwright-core";

import { createModelRouter } from "./ai_model_router.js";
import type { SidecarAiSettings } from "./engine.js";
import type { JsonLogger } from "./json-logger.js";
import { truncateText } from "./llm_budget.js";
import { extractAssistantContent } from "./ai_client.js";
import { stripFencedJson } from "./json_extract.js";
import { isFillLocaleGoal } from "./fill_locale.js";
import { isLanguageSwitchGoal } from "./language_switch.js";
import { isAgreementOrTermsClickLabel } from "./action_intent.js";
import { captureScreenshot } from "./core/safe_screenshot.js";

export interface VisionLocateResult {
  found: boolean;
  description: string;
  /** 视口百分比 0~100 */
  xPercent: number;
  yPercent: number;
  confidence: number;
  raw?: string;
}

const VISION_SYSTEM_PROMPT =
  "你是网页 UI 视觉定位助手，像回答「要点哪个按钮」一样先看图说话，再给坐标。\n" +
  "必须只输出一个 JSON 对象（不要 Markdown 围栏外的解释），字段：\n" +
  "- found: boolean（截图里能看到合理候选就 true；仅当完全没有相关控件才 false）\n" +
  "- description: 中文，先描述「在哪、什么颜色/形状、上写什么字」（例：右上角红色圆形按钮写着 EN）\n" +
  "- xPercent / yPercent: 0~100，该控件中心相对截图宽/高的百分比\n" +
  "- confidence: 0~1\n" +
  "规则：\n" +
  "1. 语言入口常为右上角小圆钮/地球仪/国旗/EN·中文·HE 等，文字可能画在 PNG 上，仍要点中心。\n" +
  "2. 注册入口常为 Go to register / Register / 注册 链接或按钮。\n" +
  "3. 禁止把背景装饰、大面积空白当目标；优先右上角/表单区主操作。\n" +
  "4. 坐标必须落在控件可见区域内，不要给 0,0 或页面正中敷衍点。";

/**
 * 视觉定位用的视口截图：必须走前台兜底，否则后台标签会因合成被暂停而截出黑屏或直接超时。
 * 定位失败返回 null（由调用方决定降级路径），不抛。
 */
export async function captureViewportJpegBase64(page: Page): Promise<string | null> {
  try {
    const buffer = await captureScreenshot(page, { type: "jpeg", quality: 62, fullPage: false });
    return Buffer.from(buffer).toString("base64");
  } catch {
    return null;
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** 兼容 0~1 小数或 0~100 百分比 */
function normalizeAxis(raw: number): number | null {
  if (!Number.isFinite(raw)) {
    return null;
  }
  if (raw >= 0 && raw <= 1) {
    return clampPercent(raw * 100);
  }
  return clampPercent(raw);
}

function parseVisionLocateJson(raw: string): VisionLocateResult | null {
  const text = String(raw ?? "").trim();
  const body = stripFencedJson(text);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const x = normalizeAxis(Number(obj.xPercent ?? obj.x ?? obj.cx ?? obj.left));
    const y = normalizeAxis(Number(obj.yPercent ?? obj.y ?? obj.cy ?? obj.top));
    if (x == null || y == null) {
      return null;
    }
    const description =
      String(obj.description ?? obj.label ?? obj.answer ?? "").trim() || "（无描述）";
    let found = obj.found !== false;
    // 描述已点出 EN/语言球等时，禁止无脑 found=false
    if (
      !found &&
      /右上|圆形|圆钮|地球|语言|language|\ben\b|中文|国旗|register|注册/i.test(description)
    ) {
      found = true;
    }
    // 明显敷衍坐标（正中/原点）且描述空泛 → 当作失败
    const vagueCenter = Math.abs(x - 50) < 3 && Math.abs(y - 50) < 3;
    const origin = x < 2 && y < 2;
    if (found && (origin || (vagueCenter && description.length < 8))) {
      return {
        found: false,
        description: `${description}（坐标疑似敷衍）`,
        xPercent: x,
        yPercent: y,
        confidence: 0.2,
        raw: truncateText(text, 400),
      };
    }
    return {
      found,
      description,
      xPercent: x,
      yPercent: y,
      confidence: Math.min(1, Math.max(0, Number(obj.confidence ?? 0.75) || 0.75)),
      raw: truncateText(text, 400),
    };
  } catch {
    return null;
  }
}

/** 把口语 query 扩成「先描述再给坐标」的完整提问 */
export function enrichVisionLocateQuestion(rawQuestion: string, goal: string): string {
  const goalText = String(goal ?? "").trim();
  const q = String(rawQuestion ?? "").trim() || buildVisionLocateQuestion(goalText);
  const blob = `${q}\n${goalText}`;
  const wantsLang = /语言|中文|english|\ben\b|\bzh\b|hebrew|עבר|locale|language|語系/i.test(blob);
  const wantsRegister = /注册|register|sign\s*up|去注册|go to register/i.test(blob);
  const wantsLogin = /登录|登陆|login|sign\s*in/i.test(blob);
  const wantsSupport = /客服|support|headset|咨询/i.test(blob);

  const hints: string[] = [];
  if (wantsLang) {
    hints.push(
      "语言入口线索：右上角红色/彩色圆形按钮上的 EN、地球仪、国旗、Language/中文/HE；字可能画在图片上。",
    );
  }
  if (wantsRegister) {
    hints.push("注册入口线索：Go to register / Register / 注册 / 去注册 文字链接或按钮。");
  }
  if (wantsLogin) {
    hints.push("登录入口线索：Login / 登录 主按钮（通常大红/主色）。");
  }
  if (wantsSupport) {
    hints.push("客服入口线索：右上角耳机/头像小图标。");
  }
  if (hints.length === 0) {
    hints.push("优先标出与任务最相关、可点击的控件中心。");
  }

  return [
    `【用户问题】${q}`,
    goalText ? `【总任务】${goalText.slice(0, 120)}` : "",
    "【回答方式】先用中文描述你看到的目标（位置+颜色形状+文字），再给中心点百分比坐标。",
    "【线索】" + hints.join(" "),
    "【输出】仅 JSON：found, description, xPercent, yPercent, confidence",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 按任务问视觉模型：控件在截图什么位置（百分比坐标）。
 */
export async function askVisionWhereOnScreenshot(input: {
  screenshotBase64: string;
  question: string;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  goal?: string;
}): Promise<VisionLocateResult | null> {
  const key = input.aiSettings.apiKey?.trim();
  if (!key) {
    return null;
  }
  const { route, client } = createModelRouter(input.aiSettings).forIntent(
    "vision",
    "视觉定位：截图坐标识别",
  );
  const model = route.model;
  const enriched = enrichVisionLocateQuestion(input.question, input.goal ?? "");
  input.logger.agentState("running", {
    step: 0,
    msg: `视觉定位中… · ${model}`,
  });
  input.logger.progress("vision_locate_ask", {
    intent: route.intent,
    model,
    question: enriched.slice(0, 160),
  });

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.05,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: VISION_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: enriched,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${input.screenshotBase64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
    });

    const content = extractAssistantContent(response);
    const parsed = parseVisionLocateJson(content);
    if (!parsed) {
      input.logger.warn("vision_locate_parse_failed", { preview: content.slice(0, 240) });
      return null;
    }
    input.logger.progress("vision_locate_result", {
      found: parsed.found,
      xPercent: parsed.xPercent,
      yPercent: parsed.yPercent,
      confidence: parsed.confidence,
      description: parsed.description,
    });
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Visual model not configured")) {
      input.logger.error("vision_locate_hard_block", { error: message });
      throw error instanceof Error ? error : new Error(message);
    }
    input.logger.warn("vision_locate_failed", { error: message });
    return null;
  }
}

export async function clickViewportPercent(
  page: Page,
  xPercent: number,
  yPercent: number,
  options?: { semanticLabel?: string; skipSettle?: boolean },
): Promise<{ x: number; y: number; semanticLabel?: string; fallbackSelector?: string }> {
  const box = page.viewportSize() ?? { width: 1280, height: 720 };
  const x = Math.round((Math.min(100, Math.max(0, xPercent)) / 100) * box.width);
  const y = Math.round((Math.min(100, Math.max(0, yPercent)) / 100) * box.height);
  const { gatewayPointClick } = await import("./core/action_gateway.js");
  const hit = await gatewayPointClick(page, x, y, {
    semanticLabel: options?.semanticLabel,
    skipSettle: options?.skipSettle ?? true,
  });
  return {
    // 对外仍报本次点击的视口像素；落盘由网关写成 relative
    x,
    y,
    semanticLabel: hit.semanticLabel,
    fallbackSelector: hit.primarySelector,
  };
}

/** 根据用户目标生成「问视觉」的中文问题 */
export function buildVisionLocateQuestion(goal: string): string {
  const g = String(goal ?? "");
  const fillLocaleOnly = isFillLocaleGoal(g) && !isLanguageSwitchGoal(g);
  const wantsFill = /填|注册|登录|表单|资料|结账|checkout|register|sign\s*up/i.test(g);
  const wantsLangSwitch = isLanguageSwitchGoal(g);

  if (fillLocaleOnly || (wantsFill && !wantsLangSwitch)) {
    return "请标出当前表单中第一个待填输入框，或「确认/提交」按钮的中心位置。禁止定位语言菜单。";
  }
  if (wantsLangSwitch && !wantsFill) {
    return (
      "修改语言应该点击哪个按钮？" +
      "请寻找右上角红色圆形 EN、地球仪、国旗或 Language/中文 入口。" +
      "若语言菜单已展开，请直接标出目标语言那一行的中心点。"
    );
  }
  // 口语「切换到中文 / 改成英文」即使未命中严格切语言判定，也走语言球问法
  if (/切换?.{0,6}(中文|英文|英语|hebrew|语言)|改成?(中文|英文)|语言/.test(g) && !wantsFill) {
    return (
      "修改语言应该点击哪个按钮？" +
      "请指出右上角带 EN 字样的圆形按钮，或地球仪/国旗语言入口的中心。"
    );
  }
  if (wantsLangSwitch && wantsFill) {
    return (
      "若语言菜单已开请标目标语；否则标右上角语言入口（红色 EN 圆钮/地球仪）。" +
      "不要在已是表单页时反复乱点装饰图。"
    );
  }
  if (/登录|login|sign\s*in/i.test(g)) {
    return "哪个是登录按钮或登录入口？请标出中心位置。";
  }
  if (/注册|register|sign\s*up/i.test(g)) {
    return "哪个是「Go to register / 注册」入口？请标出中心位置。";
  }
  if (/客服|support|headset/i.test(g)) {
    return "哪个是客服/支持入口（常为右上角耳机或头像图标）？请标出中心位置。";
  }
  if (/填|表单|资料|结账|checkout/i.test(g)) {
    return "请标出当前表单中第一个待填输入框，或「确认/提交」按钮的中心位置。";
  }
  if (/搜索|search|提交|submit/i.test(g)) {
    return "哪个是搜索框或提交/搜索按钮？请标出与当前任务最相关控件的中心位置。";
  }
  return `根据任务「${g.slice(0, 80)}」，截图里最该点击的控件在哪里？请先描述再标中心位置。`;
}

function isWeakLocate(locate: VisionLocateResult | null | undefined): boolean {
  if (!locate) return true;
  if (!locate.found) return true;
  if (locate.confidence < 0.55) return true;
  // 拒绝「整页中心糊点」：高置信也要求不落在正中 ±8% 除非描述明确说中央
  const cx = locate.xPercent;
  const cy = locate.yPercent;
  const nearCenter = Math.abs(cx - 50) <= 8 && Math.abs(cy - 50) <= 8;
  const saysCenter = /正中|中央|中间|center/i.test(locate.description || "");
  if (nearCenter && !saysCenter && locate.confidence < 0.85) return true;
  // 拒绝贴边糊点（常为误标）
  if (cx < 1.5 || cx > 98.5 || cy < 1.5 || cy > 98.5) return true;
  return false;
}

/**
 * 截图问 AI →（可选）点击坐标。语言类失败时自动换更明确的追问重试一次。
 */
export async function visionLocateAndClick(input: {
  page: Page;
  goal: string;
  question?: string;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  autoClick?: boolean;
}): Promise<{ ok: boolean; detail: string; locate?: VisionLocateResult; clicked?: boolean }> {
  const shot = await captureViewportJpegBase64(input.page);
  if (!shot) {
    return {
      ok: false,
      detail:
        "截图失败，无法视觉定位。请确认浏览器窗口可用，并在设置中开启截图/配置视觉模型后重试。",
    };
  }
  const question = input.question?.trim() || buildVisionLocateQuestion(input.goal);
  let locate = await askVisionWhereOnScreenshot({
    screenshotBase64: shot,
    question,
    goal: input.goal,
    aiSettings: input.aiSettings,
    logger: input.logger,
  });

  // 语言任务弱结果：用聊天同款问法再问一次
  const langish = /语言|中文|english|\ben\b|hebrew|עבר|locale|語系|切换/i.test(
    `${input.goal} ${question}`,
  );
  if (isWeakLocate(locate) && langish) {
    input.logger.agentProgress("视觉定位偏低，换「改语言点哪个」问法重试…", {
      phase: "vision_retry",
    });
    locate = await askVisionWhereOnScreenshot({
      screenshotBase64: shot,
      question:
        "修改语言应该点击哪个按钮？请指出页面右上角带 EN 字样的圆形按钮或地球仪/国旗语言入口的中心。",
      goal: input.goal,
      aiSettings: input.aiSettings,
      logger: input.logger,
    });
  }

  if (isWeakLocate(locate)) {
    return {
      ok: false,
      detail: locate
        ? `视觉未高置信定位：${locate.description}`
        : "视觉模型未返回有效坐标",
      locate: locate ?? undefined,
      clicked: false,
    };
  }

  const hit = locate!;
  if (input.autoClick === false) {
    return {
      ok: true,
      detail: `视觉已定位「${hit.description}」@(${hit.xPercent}%,${hit.yPercent}%)，等待 click_viewport`,
      locate: hit,
      clicked: false,
    };
  }
  if (isAgreementOrTermsClickLabel(hit.description)) {
    return {
      ok: false,
      detail:
        `视觉定位到协议/条款「${hit.description}」，拒绝自动点击。请改问主提交/注册按钮位置；协议请勾选复选框。`,
      locate: hit,
      clicked: false,
    };
  }
  const box = input.page.viewportSize() ?? { width: 1280, height: 720 };
  const x = Math.round((Math.min(100, Math.max(0, hit.xPercent)) / 100) * box.width);
  const y = Math.round((Math.min(100, Math.max(0, hit.yPercent)) / 100) * box.height);
  const { assertPointClickable } = await import("./click_guard.js");
  const guard = await assertPointClickable(input.page, x, y, {
    text: hit.description.slice(0, 40),
  });
  if (!guard.ok) {
    return {
      ok: false,
      detail: guard.reason,
      locate: hit,
      clicked: false,
    };
  }
  const point = await clickViewportPercent(input.page, hit.xPercent, hit.yPercent, {
    semanticLabel: hit.description,
    skipSettle: true,
  });
  return {
    ok: true,
    detail:
      `视觉定位点击「${hit.description}」@(${point.x},${point.y}) ≈(${hit.xPercent}%,${hit.yPercent}%)` +
      (point.fallbackSelector ? ` · ${point.fallbackSelector}` : ""),
    locate: hit,
    clicked: true,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 闭集选择（P2 视觉重定位的「问法」）
 *
 * 与上面的「自由坐标」问答的关键区别：**答案必须落在给定的候选编号里**。
 * 自由坐标上限是模型的坐标系（截图 → 百分比 → 像素 → 命中测试），每一步都能偏；
 * 闭集选择的答案是一个我们自己编号的真实 DOM 元素，再走一遍正常点击链路
 * （新鲜度、遮挡仲裁、命中测试、状态回读全都还在）。
 * 用「候选清单」当围栏，本质上是把「坐标偏移」问题换成了「分类」问题 —— 后者可靠得多。
 * ──────────────────────────────────────────────────────────────────────────── */

export interface VisionPickResult {
  found: boolean;
  /** 必须命中候选清单里的编号；未命中一律视为未找到 */
  index: number | null;
  description: string;
  confidence: number;
  raw?: string;
}

const PICK_SYSTEM_PROMPT =
  "你是网页 UI 视觉匹配助手。用户会给你一个「要找的目标」和一份带编号的候选清单，" +
  "清单编号就是截图里红色方框旁的数字。\n" +
  "只输出一个 JSON 对象（不要 Markdown 围栏外的解释）：\n" +
  '{"found": true|false, "index": 候选编号或 null, "description": "它在哪里、长什么样（中文）", "confidence": 0~1}\n' +
  "规则：\n" +
  "1. 只能从候选清单里挑编号，绝不允许编造清单外的数字。\n" +
  "2. 只有当某候选与「要找的目标」**是同一个东西**时才给它的编号；看不出或不确定就 found=false。\n" +
  "3. **类型必须一致**：要找的是勾选框（checkbox/radio/开关）时，只能选勾选框；" +
  "文字链接、说明文案、条款外链都不算，哪怕文字一模一样。要找的是按钮/链接时同理。\n" +
  "4. 描述里要写清「在哪（方位）、长什么样（形状/颜色/内部文字）」，便于人工复核。\n" +
  "5. 不要因为编号最大/居中/最显眼就选它 —— 选的是**同一个目标**，不是最显眼的目标。";

/** 从模型回答里取编号：容忍 "7" / "index 7" / "[7]" / 7 等形式 */
function pickIndexValue(obj: Record<string, unknown>): number | null {
  const raw = obj.index ?? obj.id ?? obj.mark ?? obj.number ?? obj.answer;
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  const text = String(raw).trim();
  const m = text.match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * 解析闭集回答。`valid` 是候选编号全集 —— 不在其中的编号一律作废（返回 found=false）。
 */
export function parseVisionPickJson(raw: string, valid: Set<number>): VisionPickResult | null {
  const text = String(raw ?? "").trim();
  const body = stripFencedJson(text);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const description = String(obj.description ?? obj.label ?? obj.answer ?? "").trim() || "（无描述）";
    const confidence = Math.min(1, Math.max(0, Number(obj.confidence ?? 0.7) || 0.7));
    const index = pickIndexValue(obj);
    const found = obj.found !== false;
    if (!found || index == null || !valid.has(index)) {
      return {
        found: false,
        index: null,
        description,
        confidence: found && index != null ? Math.min(confidence, 0.3) : confidence,
        raw: truncateText(text, 400),
      };
    }
    return { found: true, index, description, confidence, raw: truncateText(text, 400) };
  } catch {
    return null;
  }
}

/** 闭集提问：目标 + 候选清单（编号与 SoM 截图上的红框编号严格同源） */
export function buildVisionPickQuestion(input: {
  targetText: string;
  targetKind?: string | null;
  candidates: Array<{ index: number; label: string }>;
  goal?: string;
  previousIndex?: number | null;
}): string {
  const kind = String(input.targetKind ?? "").trim();
  const list = input.candidates
    .map((c) => `[${c.index}] ${c.label.slice(0, 60)}`)
    .slice(0, 80)
    .join("\n");
  const goal = String(input.goal ?? "").trim();
  return [
    "页面已经变化，旧编号失效了。请在下述候选里找出「要找的目标」的编号。",
    "",
    `【要找的目标】${input.targetText.slice(0, 80)}${kind ? `（控件类型：${kind}）` : ""}`,
    input.previousIndex != null ? `【旧编号（已失效，不要回答它）】${input.previousIndex}` : "",
    goal ? `【当前任务】${goal.slice(0, 120)}` : "",
    "",
    "【候选清单】（编号 = 截图红框上的数字）",
    list || "(空)",
    "",
    "只回答清单里存在的编号；找不到就 found=false。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 闭集候选挑选：返回的编号一定在候选清单内，否则视为未找到 */
export async function askVisionPickIndex(input: {
  screenshotBase64: string;
  question: string;
  candidates: Array<{ index: number; label: string }>;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
}): Promise<VisionPickResult | null> {
  const key = input.aiSettings.apiKey?.trim();
  if (!key) return null;
  const valid = new Set(input.candidates.map((c) => c.index));
  if (valid.size === 0) return null;
  const { route, client } = createModelRouter(input.aiSettings).forIntent(
    "vision",
    "视觉重定位：候选编号匹配",
  );
  const model = route.model;
  input.logger.progress("vision_pick_ask", {
    intent: route.intent,
    model,
    candidates: valid.size,
    question: input.question.slice(0, 160),
  });
  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: "system", content: PICK_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: input.question },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${input.screenshotBase64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
    });
    const content = extractAssistantContent(response);
    const parsed = parseVisionPickJson(content, valid);
    if (!parsed) {
      input.logger.warn("vision_pick_parse_failed", { preview: content.slice(0, 240) });
      return null;
    }
    input.logger.progress("vision_pick_result", {
      found: parsed.found,
      index: parsed.index,
      confidence: parsed.confidence,
      description: parsed.description,
    });
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logger.warn("vision_pick_failed", { error: message });
    return null;
  }
}

