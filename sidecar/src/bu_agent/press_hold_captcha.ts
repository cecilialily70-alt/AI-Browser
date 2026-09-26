/**
 * 长按按钮验证码（策略 press_hold_captcha）—— 微软 / Arkose FunCaptcha「按住不放」等。
 *
 * 主方案：定位验证码挑战区内的长按按钮 → 鼠标移到按钮中心 → 按下左键并保持
 *        （**时长不固定**：由页面反馈决定何时松手，见 holdButton）→ 松开 → 轮询验收。
 * 备用方案：主方案未过时，点无障碍入口 → 在该入口所在框架内点击/长按 → 验收。
 *
 * 设计原则（面向任意站点）：**形状与结构是主判据，文案只是加分项。**
 * 每个站的按钮文案都不一样（「按住」/「長按按鈕」/「Press and hold」/「Hold」…），
 * 所以定位绝不依赖固定文案：在**已判定为长按题**的前提下，
 *   ① 长按按钮 = 宽扁「药丸形」主控件（宽高比大、占框架宽度比例高），文案命中长按语义再加分；
 *   ② 无障碍入口 = 文案含「无障碍/accessib/訪問性/語音/聽覺」语义的小图标（结构上紧随按钮左侧）。
 * 只有「按住不放」这类题型才走本模块；识别到挑战但当前不是长按题时诚实返回 unsupported，
 * 由上层按既有重试/HITL 口径处理（禁止编造坐标、禁止假装通过）。
 */
import type { Page } from "playwright-core";

import { frameViewportBox, toPagePoint } from "../core/dom_scope.js";
import type { JsonLogger } from "../json-logger.js";
import {
  classifyCaptchaOutcomeText,
  sleep,
  CAPTCHA_WIDGET_WAIT_MS,
} from "./captcha_utils.js";

export interface PressHoldSolveResult {
  ok: boolean;
  strategy: "press_hold_captcha" | "unsupported";
  verified: boolean | null;
  verifySignal: string;
  /** 本轮实际按住时长（ms） */
  holdMs: number;
  method: string;
  /** 是否启用了无障碍备用方案 */
  accessibilityUsed: boolean;
  attempts: number;
  detail: string;
}

/**
 * 按住时长**不是固定值**：真实站点进度条快慢不一（实测同族站点 3s~8s 都有）。
 * 因此只设下限与上限，实际松手时机由页面反馈决定：
 *   · 下限：先按住这么久，避免一按就走；
 *   · 上限：防呆保险丝（仍在反馈就继续按，到顶才强制松开）。
 */
const HOLD_MIN_MS = 3000;
const HOLD_MAX_MS = 15_000;
/** 按住期间反馈轮询间隔（一次轮询同时读 token/文案/进度条）。 */
const HOLD_POLL_MS = 400;
/** 松手后的验收轮询：成功确认可能比松手晚几秒（轮询到明确结论或超时）。 */
const VERIFY_BUDGET_MS = 7000;
const VERIFY_POLL_MS = 600;
/**
 * 进度条填满后再多保持一会儿才松手：有的站点在「松手」时结算，
 * 卡在 95% 就松手可能被判中途放弃（等于自己取消）。
 */
const HOLD_COMPLETE_GRACE_MS = 700;
/** 单帧探测超时：某帧 evaluate 卡住不得拖垮整轮求解。 */
const FRAME_PROBE_MS = 2000;
/** 每帧回传的候选元素上限（防止大体量页面的探测负载）。 */
const MAX_PROBE_ELEMENTS = 60;

/**
 * 长按语义（**加分项**，多语言/简称都收；不是门禁）。
 * 覆盖：中文简繁「长按/長按/按住/按著」、英文 press/hold 短语、德/西/法/日/韩常见写法。
 */
const PRESS_COPY_RE =
  /長按|长按|按住|按著|按着|持續按住|持续按住|不放開|不放开|press\s*(and|&)\s*hold|touch\s*(and|&)\s*hold|click\s*(and|&)\s*hold|tap\s*(and|&)\s*hold|hold\s*(down|the\s*button|to\s*(verify|continue|proceed|submit))|gedrückt\s*halten|halten\s*sie|mantener\s*(presionado|pulsado)|maintenez\s*appuy|押し続け|長押し|누르고|길게/i;

/** 无障碍入口语义（多语言；配合「小图标」结构判据使用）。 */
const ACCESSIBILITY_COPY_RE =
  /accessib|無障礙|无障碍|訪問性|访问性|辅助功能|輔助功能|聽覺挑戰|听觉挑战|語音挑戰|语音挑战|音声チャレンジ|audio\s*challenge|sound\s*challenge/i;

/** 无障碍界面里的「主操作」文案（副判据；主判据仍是宽扁主控件）。 */
const ACTION_COPY_RE =
  /verify|验证|驗證|confirm|确认|確認|continue|继续|繼續|submit|提交|next|下一步|start|开始|開始|audio|音声|語音|语音|play|播放|robot|机器人|機器人/i;

/** 挑战容器语义（结构加分：元素处在验证码容器内更可信）。 */
const CHALLENGE_CONTAINER_RE =
  /captcha|challenge|arkose|funcaptcha|fc[-_]|puzzle|verify|verification|gate|press|hold|人机|驗證|验证/i;

/** 判定为「真的长按按钮」的最低分。 */
const MIN_PRESS_SCORE = 45;
/** 判定为「真的无障碍入口」的最低分。 */
const MIN_ACCESSIBILITY_SCORE = 60;
/** 判定为无障碍界面「主操作」的最低分。 */
const MIN_ACTION_SCORE = 30;

type Box = { x: number; y: number; w: number; h: number };

type ProbeElement = Box & {
  tag: string;
  /** 可见文案（截断） */
  label: string;
  /** aria-label / title / id / class / data-testid 拼成的语义串（截断） */
  aria: string;
  /** button / a / input / label 或 role=button */
  buttonish: boolean;
  /** 自身不是按钮但内含按钮（多半是容器，按下会打偏） */
  nested: boolean;
  /** 处在 captcha/challenge 语义容器内 */
  inCaptcha: boolean;
  /** 元素（或其后代）带进度条语义：按住进度可被观测 → 按住时长按反馈自适应 */
  progress: boolean;
};

type FrameProbe = {
  /** 框架文档的 innerWidth / innerHeight（相对宽度判据用） */
  w: number;
  h: number;
  /** 文档可见正文（供「仍在要求长按」判断与日志） */
  text: string;
  elements: ProbeElement[];
};

export type { FrameProbe, ProbeElement };

type Classified = Box & { label: string; score: number; why: string; progress: boolean };

type FrameLocated = {
  press: Classified | null;
  accessibility: Classified | null;
  action: Classified | null;
};

export type { FrameLocated, Classified };

type LocatedButton = Classified & {
  /** 主文档为 ""；嵌套文档为框架 URL（用于之后判定框架是否被拆除） */
  frameUrl: string;
  /** 主文档视口坐标 */
  point: { x: number; y: number };
  /** 该控件（或其后代）带进度条语义：按住时长可按反馈自适应 */
  progress: boolean;
};

/** 仍然要求「按住不放」的题面（失败换题前一直存在，用于决定是否延长按住）。 */
const PRESS_HOLD_COPY_RE = PRESS_COPY_RE;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * 页内探测：回传**候选控件及其几何**，不在页内做任何文案裁决（裁决集中在 Node 侧，
 * 便于统一推理与测试）。自包含（会被序列化进页面上下文执行），不引用模块作用域变量。
 */
function probeDocument(): unknown {
  const clean = (v: unknown, max: number): string =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);

  const innerW = Math.max(1, window.innerWidth || 0);
  const innerH = Math.max(1, window.innerHeight || 0);

  const isClickable = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    const role = clean(el.getAttribute("role"), 24).toLowerCase();
    if (tag === "button" || tag === "a" || tag === "input" || tag === "label" || tag === "summary") {
      return true;
    }
    if (role === "button" || role === "checkbox" || role === "link") return true;
    if (el.hasAttribute("tabindex") || el.hasAttribute("onclick")) return true;
    try {
      return window.getComputedStyle(el).cursor === "pointer";
    } catch {
      return false;
    }
  };

  /** 元素是否处在 captcha/challenge 语义容器内（向上找有限层，避免整树遍历）。 */
  const inChallenge = (el: Element): boolean => {
    let cur: Element | null = el;
    for (let i = 0; i < 6 && cur; i++) {
      const cls =
        typeof (cur as HTMLElement).className === "string" ? (cur as HTMLElement).className : "";
      const blob = `${cur.id || ""} ${cls} ${cur.getAttribute("data-testid") || ""} ${cur.getAttribute("aria-label") || ""}`;
      if (
        /captcha|challenge|arkose|funcaptcha|fc[-_]|puzzle|verify|verification|gate|press|hold|人机|驗證|验证/i.test(
          blob,
        )
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  };

  // 候选来源：① 天然可交互元素；② 形似主按钮/图标的 div/span（class 语义命中）。
  // 不整树扫 div/span（会在大页面上爆炸），只挑语义命中的那一批。
  const nodes: Element[] = [];
  const seen = new Set<Element>();
  const add = (el: Element): void => {
    if (seen.has(el)) return;
    seen.add(el);
    nodes.push(el);
  };
  for (const el of Array.from(
    document.querySelectorAll(
      "button,[role='button'],[role='checkbox'],input[type=button],input[type=submit],input[type=image],label,a[href],summary,[tabindex],[aria-label],[title]",
    ),
  )) {
    add(el);
  }
  for (const el of Array.from(document.querySelectorAll("div,span,svg"))) {
    const cls = `${el.id || ""} ${typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : ""} ${el.getAttribute("data-testid") || ""}`;
    if (/btn|button|captcha|challenge|puzzle|press|hold|verify|arkose|\bfc\b|submit|continue|primary|icon|arrow/i.test(cls)) {
      add(el);
    }
  }

  const elements = [];
  for (const el of nodes.slice(0, 3000)) {
    let r: DOMRect;
    try {
      r = el.getBoundingClientRect();
    } catch {
      continue;
    }
    if (r.width < 10 || r.height < 10) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerH || r.left >= innerW) continue;
    if (!isClickable(el)) continue;

    const tag = el.tagName.toLowerCase();
    const aspect = r.width / Math.max(1, r.height);
    // 形状过滤：只要「宽扁主控件（药丸）」或「小图标」，把噪声挡在回传之外。
    const pillLike = aspect >= 1.6 && r.width >= 90 && r.height <= 160;
    const iconLike = r.width <= 90 && r.height <= 90;
    if (!pillLike && !iconLike) continue;

    const label = clean(el.textContent, 60);
    const aria = clean(
      [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.id,
        el.getAttribute("name"),
        el.getAttribute("data-testid"),
        typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "",
      ].join(" "),
      200,
    );
    // 进度条语义：按住时是否「看得见进度」——决定松手时机能否按反馈自适应。
    const progressSel =
      '[role="progressbar"],[aria-valuenow],[class*="progress"],[class*="Progress"],[class*="fill"],[class*="Fill"],[class*="bar"]';
    let progress = false;
    try {
      progress = el.matches(progressSel) || el.querySelector(progressSel) != null;
    } catch {
      progress = false;
    }
    elements.push({
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      tag,
      label,
      aria,
      buttonish:
        tag === "button" ||
        tag === "a" ||
        tag === "input" ||
        tag === "label" ||
        clean(el.getAttribute("role"), 24).toLowerCase() === "button",
      nested: tag !== "button" && el.querySelector("button,[role='button']") != null,
      inCaptcha: inChallenge(el),
      progress,
    });
  }

  // 优先回传「更像主控件/更像小图标」的候选，控制回传体量。
  elements.sort((a, b) => {
    const rank = (e: { w: number; h: number }): number => {
      const aspect = e.w / Math.max(1, e.h);
      if (aspect >= 1.8 && e.w >= 110) return 0;
      if (e.w <= 90 && e.h <= 90) return 1;
      return 2;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return b.w * b.h - a.w * a.h;
  });

  return {
    w: innerW,
    h: innerH,
    text: String(document.body?.innerText || "").slice(0, 1500),
    elements: elements.slice(0, 60),
  };
}

function overlapRatio(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const smaller = Math.min(a.w * a.h, b.w * b.h) || 1;
  return (x * y) / smaller;
}

/**
 * 单帧裁决：形状/结构为主，文案为辅。
 * 长按按钮 = pill 形主控件（占框架宽度比例高）；无障碍入口 = 含无障碍语义的小图标。
 *
 * 导出给离线回归测试用（`tests/press-hold-locate.mjs`）：裁决逻辑与 DOM 探测分离，
 * 因此可以用「真实站点形状」的合成 fixture 直接验证，不必起浏览器。
 */
export function classifyFrame(probe: FrameProbe): FrameLocated {
  const fw = Math.max(1, probe.w);
  const fh = Math.max(1, probe.h);
  const elems = Array.isArray(probe.elements) ? probe.elements : [];

  let accessibility: Classified | null = null;
  let accScore = -1;
  for (const el of elems) {
    const copy = ACCESSIBILITY_COPY_RE.test(`${el.label} ${el.aria}`);
    if (!copy) continue;
    const aspect = el.w / Math.max(1, el.h);
    let score = 60;
    if (el.w <= 90 && el.h <= 90) score += 15; // 无障碍入口通常是小圆图标
    if (aspect >= 0.5 && aspect <= 2) score += 8;
    if (el.x < fw * 0.35) score += 7; // 常见位置：卡片左下
    if (el.label.length <= 10) score += 3;
    if (!el.buttonish) score -= 5;
    if (score > accScore) {
      accScore = score;
      accessibility = { ...el, score, why: "accessibility-copy" };
    }
  }
  if (accessibility && accessibility.score < MIN_ACCESSIBILITY_SCORE) accessibility = null;

  let press: Classified | null = null;
  let pressScore = -1;
  for (const el of elems) {
    if (accessibility && overlapRatio(el, accessibility) > 0.5) continue;
    const aspect = el.w / Math.max(1, el.h);
    const wideRatio = el.w / fw;
    const copyPress = PRESS_COPY_RE.test(`${el.label} ${el.aria}`);
    const pill = aspect >= 1.8 && el.w >= 100 && el.h >= 20 && el.h <= 160 && wideRatio >= 0.22;
    if (!copyPress && !pill) continue;
    let score = copyPress ? 100 : 30;
    const why = copyPress ? "press-copy" : "pill";
    if (pill) score += 30 + Math.min(18, Math.round(wideRatio * 20));
    if (el.buttonish) score += 8;
    if (el.nested) score -= 10;
    if (el.label && el.label.length <= 16) score += 8;
    if (el.h <= 90) score += 4; // 细长条更像「按住」条
    if (el.y > fh * 0.3) score += 5; // 挑战题面下方
    if (el.inCaptcha) score += 20;
    if (el.progress) score += 10; // 自带进度条：按住时长可按反馈自适应，优先级更高
    if (score > pressScore) {
      pressScore = score;
      press = { ...el, score, why };
    }
  }
  if (press && press.score < MIN_PRESS_SCORE) press = null;

  let action: Classified | null = null;
  let actionScore = -1;
  for (const el of elems) {
    if (accessibility && overlapRatio(el, accessibility) > 0.5) continue;
    const aspect = el.w / Math.max(1, el.h);
    const copy = ACTION_COPY_RE.test(`${el.label} ${el.aria}`);
    const copyPress = PRESS_COPY_RE.test(`${el.label} ${el.aria}`);
    const pill = aspect >= 1.8 && el.w >= 100 && el.h >= 20 && el.h <= 160;
    // 无障碍界面的主操作：文案命中，或宽扁主控件 **且** 处在挑战容器内
    // （无这两条就可能是主文档里的「下一步」，点了会误推进任务）。
    if (!copy && !copyPress && !(pill && el.inCaptcha)) continue;
    let score = copy || copyPress ? 40 : 22;
    if (pill) score += 25 + Math.min(15, Math.round((el.w / fw) * 20));
    if (el.buttonish) score += 6;
    if (el.nested) score -= 10;
    if (el.inCaptcha) score += 15;
    if (score > actionScore) {
      actionScore = score;
      action = { ...el, score, why: copy || copyPress ? "action-copy" : "action-pill" };
    }
  }
  if (action && action.score < MIN_ACTION_SCORE) action = null;

  return { press, accessibility, action };
}

async function readViewport(page: Page): Promise<{ w: number; h: number }> {
  const vp = await page
    .evaluate(() => ({ w: Math.round(window.innerWidth || 0), h: Math.round(window.innerHeight || 0) }))
    .catch(() => null);
  if (vp && vp.w > 0 && vp.h > 0) return vp;
  const size = page.viewportSize();
  return { w: size?.width ?? 1280, h: size?.height ?? 800 };
}

function isPointVisible(point: { x: number; y: number }, vp: { w: number; h: number }): boolean {
  return point.x >= 2 && point.y >= 2 && point.x <= vp.w - 2 && point.y <= vp.h - 2;
}

/**
 * 跨帧定位（主文档 + 所有 iframe，含 Arkose 的嵌套框架）。
 * 坐标一律 DOM 实测：框架局部矩形 + 框架在主文档视口的偏移。
 * `onlyFrameUrl` 指定时只在该框架内找（无障碍入口切换后，界面就在那个框架里，
 * 这样可避免误点到主文档里的「下一步」）。
 */
async function locateButtons(
  page: Page,
  vp: { w: number; h: number },
  opts?: { onlyFrameUrl?: string },
): Promise<{ press: LocatedButton | null; accessibility: LocatedButton | null; action: LocatedButton | null }> {
  let press: LocatedButton | null = null;
  let accessibility: LocatedButton | null = null;
  let action: LocatedButton | null = null;

  for (const frame of page.frames()) {
    const isMain = frame === page.mainFrame();
    const frameUrl = isMain ? "" : frame.url();
    if (opts?.onlyFrameUrl != null && frameUrl !== opts.onlyFrameUrl) continue;

    const probe = await withTimeout(
      frame.evaluate(probeDocument).catch(() => null),
      FRAME_PROBE_MS,
      null,
    ) as FrameProbe | null;
    if (!probe) continue;

    let offset = { x: 0, y: 0 };
    if (!isMain) {
      const fbox = await frameViewportBox(frame).catch(() => null);
      if (!fbox) continue; // 框架盒不可得 → 坐标不可信，宁可不点
      offset = { x: fbox.x, y: fbox.y };
    }

    const cls = classifyFrame(probe);
    const toLocated = (c: Classified): LocatedButton => ({
      label: c.label || c.why,
      why: c.why,
      score: c.score,
      progress: c.progress,
      frameUrl,
      x: Math.round(c.x + offset.x),
      y: Math.round(c.y + offset.y),
      w: c.w,
      h: c.h,
      point: toPagePoint({ x: c.x + c.w / 2, y: c.y + c.h / 2 }, offset),
    });

    if (cls.press) {
      const l = toLocated(cls.press);
      if (isPointVisible(l.point, vp) && (!press || l.score > press.score)) press = l;
    }
    if (cls.accessibility) {
      const l = toLocated(cls.accessibility);
      if (isPointVisible(l.point, vp) && (!accessibility || l.score > accessibility.score)) {
        accessibility = l;
      }
    }
    if (cls.action) {
      const l = toLocated(cls.action);
      if (isPointVisible(l.point, vp) && (!action || l.score > action.score)) action = l;
    }
  }

  return { press, accessibility, action };
}

/** Arkose 通过后会把 token 写进隐藏输入（`fc-token` / `FunCaptcha-Token` 等）。 */
async function readArkoseToken(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      for (const el of inputs) {
        const key = `${el.id} ${el.getAttribute("name") ?? ""} ${el.getAttribute("data-testid") ?? ""}`;
        if (!/(fc[_-]?token|funcaptcha|arkose)/i.test(key) && !(/captcha/i.test(key) && /token/i.test(key))) {
          continue;
        }
        const value = String(el.value ?? "");
        if (value.length >= 20) return value.slice(0, 10);
      }
      return null;
    })
    .catch(() => null);
}

async function readTexts(page: Page, frameUrls: string[]): Promise<string> {
  const parts: string[] = [];
  const main = await withTimeout(
    page.evaluate(() => String(document.body?.innerText || "").slice(0, 3000)).catch(() => ""),
    1500,
    "",
  );
  if (main) parts.push(main);

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    const wanted =
      frameUrls.includes(url) || /arkose|funcaptcha|\bfc\b|captcha|challenge|verify/i.test(url);
    if (!wanted) continue;
    const t = await withTimeout(
      frame.evaluate(() => String(document.body?.innerText || "").slice(0, 2000)).catch(() => ""),
      1200,
      "",
    );
    if (t) parts.push(t);
    if (parts.join("\n").length > 6000) break;
  }
  return parts.join("\n").slice(0, 6000);
}

/** 承载按钮的 iframe 已从页面消失（用于中途结束按住循环；最终裁决见 readOutcome）。 */
function isFrameGone(page: Page, frameUrl: string): boolean {
  if (!frameUrl) return false;
  try {
    return !page.frames().some((f) => f.url() === frameUrl);
  } catch {
    return false;
  }
}

/**
 * 「挑战已拆除」的严格判据：承载题的框架已消失，**且**页面里再也看不到可见的验证容器，
 * 也看不到仍在要求长按的题面。
 *
 * 为什么不能只看「框架消失」：Arkose 失败换题时会重建嵌套框架（URL 变、旧 URL 消失），
 * 只看消失会把「失败换新题」误判成「通过」。必须同时确认没有残留的可见验证容器。
 *
 * 主文档承载的题（frameUrl = ""）没有「框架消失」信号，改为仅凭「题面 + 可见容器」判定。
 */
async function isChallengeCleared(
  page: Page,
  frameUrls: string[],
  text: string,
): Promise<boolean> {
  /*
   * 主文档承载的题（frameUrl = ""）没有「框架被拆」这个信号：isFrameGone("") 恒为 false。
   * 对这类情况不能用「框架消失」当必要前提，否则永远拿不到 challenge_dismissed；
   * 改为只看「题面不再要求按住 + 页面里没有可见的验证容器」。
   */
  const coversMainDocument = frameUrls.some((u) => !u);
  const anyFrameGone = frameUrls.some((u) => isFrameGone(page, u));
  if (!coversMainDocument && !anyFrameGone) return false;
  if (PRESS_HOLD_COPY_RE.test(text)) return false;
  const stillHasChallenge = await page
    .evaluate(() => {
      const sel =
        "#arkose,#fc-iframe,iframe[src*='arkose'],iframe[src*='funcaptcha'],iframe[src*='recaptcha'],iframe[src*='hcaptcha'],iframe[src*='turnstile']";
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = window.getComputedStyle(el as HTMLElement);
        if (
          r.width > 4 &&
          r.height > 4 &&
          st.display !== "none" &&
          st.visibility !== "hidden" &&
          Number(st.opacity || "1") > 0.05
        ) {
          return true;
        }
      }
      return false;
    })
    .catch(() => true); // 读不到就不敢宣称通过
  return !stillHasChallenge;
}

/**
 * 页内探测：挑战区内的进度条是否已填满（按住时进度 = 松手时机）。
 * 只看结构（aria-valuenow / 宽度占比 / transform scaleX），不看站点文案。
 */
function probeProgressComplete(): string {
  const nodes = document.querySelectorAll(
    '[role="progressbar"],[aria-valuenow],[class*="progress"],[class*="Progress"],[class*="fill"],[class*="Fill"],[class*="bar"]',
  );
  for (const el of Array.from(nodes)) {
    const now = el.getAttribute("aria-valuenow");
    if (now != null && Number(now) >= 99) return "complete";

    let r: DOMRect;
    try {
      r = el.getBoundingClientRect();
    } catch {
      continue;
    }
    if (r.width < 4) continue;
    const parent = el.parentElement;
    if (parent) {
      const pr = parent.getBoundingClientRect();
      if (pr.width > 8 && r.width / pr.width >= 0.95) return "complete";
    }
    const tr = window.getComputedStyle(el).transform;
    const m = tr && tr.startsWith("matrix") ? tr.match(/matrix\(([^)]+)\)/) : null;
    if (m) {
      const sx = Number(m[1].split(",")[0]);
      if (Number.isFinite(sx) && sx >= 0.95) return "complete";
    }
  }
  return "unknown";
}

/** 进度条是否已填满（在承载按钮的框架内看）。 */
async function readProgressState(page: Page, frameUrls: string[]): Promise<"complete" | "unknown"> {
  for (const frame of page.frames()) {
    const url = frame === page.mainFrame() ? "" : frame.url();
    if (frameUrls.length > 0 && !frameUrls.includes(url)) continue;
    const state = await withTimeout(
      frame.evaluate(probeProgressComplete).catch(() => "unknown"),
      800,
      "unknown",
    );
    if (state === "complete") return "complete";
  }
  return "unknown";
}

/**
 * 按住期间的**一次**综合反馈（token / 文案 / 进度条各读一次，避免多轮 evaluate）。
 * `progress` 决定「能否按反馈延长按住」，`signal` 决定是否立即松手。
 */
async function readHoldFeedback(input: {
  page: Page;
  frameUrls: string[];
}): Promise<{
  signal: "success" | "fail" | "dismissed" | "holding" | "unknown";
  progress: "complete" | "unknown";
}> {
  if (await readArkoseToken(input.page)) return { signal: "success", progress: "unknown" };
  if (input.frameUrls.some((u) => isFrameGone(input.page, u))) {
    return { signal: "dismissed", progress: "unknown" };
  }
  const text = await readTexts(input.page, input.frameUrls);
  const { verdict } = classifyCaptchaOutcomeText(text);
  if (verdict === "success") return { signal: "success", progress: "unknown" };
  if (verdict === "fail") return { signal: "fail", progress: "unknown" };
  const progress = await readProgressState(input.page, input.frameUrls);
  return { signal: PRESS_HOLD_COPY_RE.test(text) ? "holding" : "unknown", progress };
}

async function readOutcome(
  page: Page,
  frameUrls: string[],
): Promise<{ verified: boolean | null; signal: string }> {
  if (await readArkoseToken(page)) return { verified: true, signal: "token_present" };
  const text = await readTexts(page, frameUrls);
  const { verdict, signal } = classifyCaptchaOutcomeText(text);
  if (verdict === "success") return { verified: true, signal: `page_success:${signal}` };
  if (verdict === "fail") return { verified: false, signal: `page_fail:${signal}` };
  if (await isChallengeCleared(page, frameUrls, text)) {
    return { verified: true, signal: "challenge_dismissed" };
  }
  if (PRESS_HOLD_COPY_RE.test(text)) return { verified: null, signal: "still_press_hold" };
  return { verified: null, signal: "no_clear_signal" };
}

/**
 * 松手后的验收：成功确认可能比松手晚几秒（有的站点要等 token 回填/框架拆除）。
 * 因此**轮询**到明确结论（通过/失败）或预算耗尽，而不是固定睡一觉就下结论。
 */
async function verifyWithPolling(input: {
  page: Page;
  frameUrls: string[];
  budgetMs?: number;
}): Promise<{ verified: boolean | null; signal: string }> {
  const budget = input.budgetMs ?? VERIFY_BUDGET_MS;
  const started = Date.now();
  let last = await readOutcome(input.page, input.frameUrls);
  while (last.verified === null && Date.now() - started < budget) {
    await sleep(VERIFY_POLL_MS);
    last = await readOutcome(input.page, input.frameUrls);
  }
  return last;
}

/**
 * 按下并保持 —— **时长不固定**，由页面反馈驱动：
 *   · 出现成功/失败/框架拆除信号 → 立即松手；
 *   · 进度条已填满 → 立即松手（真实站点松手即提交）；
 *   · 页面仍提示「长按」或控件带进度条可观测 → 继续按住（上限 HOLD_MAX_MS 保险丝）；
 *   · 既无「仍要按住」的反馈、也无进度条可观测（可能误判控件）→ 按住下限后收手。
 * 必须保证任何异常路径都松开鼠标，否则残留 pressed 会污染后续所有动作。
 */
async function holdButton(input: {
  page: Page;
  point: { x: number; y: number };
  frameUrls: string[];
  /** 目标控件是否带进度条语义（决定能否按反馈延长按住） */
  hasProgress: boolean;
  signal?: AbortSignal;
}): Promise<{ holdMs: number; signal: string; releaseReason: string }> {
  const { page } = input;
  await page.mouse.move(input.point.x, input.point.y);
  await sleep(120 + Math.floor(Math.random() * 80));
  const started = Date.now();
  await page.mouse.down();

  let signal = "unknown";
  let releaseReason = "max_hold";
  let progressDoneAt: number | null = null;
  try {
    for (;;) {
      if (input.signal?.aborted) {
        releaseReason = "aborted";
        throw new Error("Agent 已中止");
      }
      const elapsed = Date.now() - started;
      if (elapsed >= HOLD_MAX_MS) {
        releaseReason = "max_hold";
        break;
      }
      await sleep(HOLD_POLL_MS);
      const feedback = await readHoldFeedback({ page, frameUrls: input.frameUrls });
      signal = feedback.signal;
      if (signal === "success" || signal === "fail" || signal === "dismissed") {
        releaseReason = signal;
        break;
      }
      if (feedback.progress === "complete") {
        // 进度条满了也再多保持一瞬（松手时刻常是站点结算时刻），期间若出成功信号则立即松手。
        progressDoneAt = progressDoneAt ?? Date.now();
        if (Date.now() - progressDoneAt >= HOLD_COMPLETE_GRACE_MS) {
          releaseReason = "progress_complete";
          break;
        }
      } else {
        progressDoneAt = null;
      }
      const elapsedNow = Date.now() - started;
      if (elapsedNow >= HOLD_MIN_MS && signal !== "holding" && !input.hasProgress) {
        // 页面没有再要求按住、也没有进度可观测：可能在误判的控件上长按，见好就收。
        releaseReason = "no_hold_feedback";
        break;
      }
    }
  } finally {
    await page.mouse.up().catch(() => undefined);
  }
  return { holdMs: Date.now() - started, signal, releaseReason };
}

async function clickPoint(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await sleep(60 + Math.floor(Math.random() * 60));
  await page.mouse.down();
  await sleep(80 + Math.floor(Math.random() * 70));
  await page.mouse.up();
}

type LocatedBundle = {
  press: LocatedButton | null;
  accessibility: LocatedButton | null;
  action: LocatedButton | null;
};

/**
 * 轮询等待目标控件出现（验证组件 / 无障碍界面都是异步渲染的）。
 * 目标一出现立即返回，不必等满；超时则回传最后一次探测结果。
 */
async function waitForTarget(input: {
  page: Page;
  vp: { w: number; h: number };
  logger: JsonLogger;
  signal?: AbortSignal;
  budgetMs: number;
  onlyFrameUrl?: string;
  /** 主方案等长按按钮或无障碍入口；无障碍界面等长按按钮或主操作。 */
  want: "press_or_accessibility" | "press_or_action";
}): Promise<{ located: LocatedBundle; waitedMs: number; up: boolean }> {
  const started = Date.now();
  let located: LocatedBundle = { press: null, accessibility: null, action: null };
  let nextTickAt = 5000;
  let lastError: unknown = null;

  for (;;) {
    if (input.signal?.aborted) throw new Error("Agent 已中止");
    try {
      located = await locateButtons(
        input.page,
        input.vp,
        input.onlyFrameUrl ? { onlyFrameUrl: input.onlyFrameUrl } : undefined,
      );
    } catch (err) {
      // 框架正在重建时读取会抛错，属正常现象：记下但不中断等待。
      lastError = err;
      located = { press: null, accessibility: null, action: null };
    }
    const up =
      input.want === "press_or_accessibility"
        ? located.press != null || located.accessibility != null
        : located.press != null || located.action != null;
    if (up) return { located, waitedMs: Date.now() - started, up: true };

    const elapsed = Date.now() - started;
    if (elapsed >= input.budgetMs) return { located, waitedMs: elapsed, up: false };
    if (elapsed >= nextTickAt) {
      input.logger.agentProgress(`仍在等待验证组件渲染…已 ${Math.floor(elapsed / 1000)}s`, {
        phase: "press_hold_captcha",
        stage: "wait_target_tick",
        waitedMs: elapsed,
        lastError: lastError instanceof Error ? lastError.message.slice(0, 120) : undefined,
      });
      nextTickAt += 5000;
    }
    await sleep(Math.min(1000, Math.max(50, input.budgetMs - elapsed)));
  }
}

export async function solvePressHoldCaptcha(input: {
  page: Page;
  logger: JsonLogger;
  signal?: AbortSignal;
  /**
   * 允许等待组件渲染的预算（ms）。由调用方按「已经等过多久」扣减，
   * 避免分发层与本模块各等 30s。默认一个完整预算。
   */
  waitBudgetMs?: number;
}): Promise<PressHoldSolveResult> {
  if (input.signal?.aborted) throw new Error("Agent 已中止");

  const unsupported = (detail: string): PressHoldSolveResult => ({
    ok: false,
    strategy: "unsupported",
    verified: null,
    verifySignal: "",
    holdMs: 0,
    method: "none",
    accessibilityUsed: false,
    attempts: 0,
    detail,
  });

  const vp = await readViewport(input.page);
  input.logger.agentProgress("① 长按策略：定位长按按钮（形状优先，文案辅助）…", {
    phase: "press_hold_captcha",
    stage: "locate",
  });

  let located = await locateButtons(input.page, vp);
  let waitedMs = 0;

  /**
   * 验证组件是异步挂载的：题面先出现，按钮几秒后才注入（微软 / Arkose 实测如此）。
   * 组件没就绪就判失败，会让上层连续 3 次「找不到按钮」→ 误触 HITL。
   * 因此按剩余预算轮询等待，按钮或无障碍入口一出现立即继续。
   */
  const budget = Math.max(0, Math.round(input.waitBudgetMs ?? CAPTCHA_WIDGET_WAIT_MS));
  if (!located.press && !located.accessibility && budget > 0) {
    input.logger.agentProgress(
      `暂未见长按按钮（验证组件可能仍在渲染），等待最多 ${Math.round(budget / 1000)}s…`,
      { phase: "press_hold_captcha", stage: "wait_target" },
    );
    const waited = await waitForTarget({
      page: input.page,
      vp,
      logger: input.logger,
      signal: input.signal,
      budgetMs: budget,
      want: "press_or_accessibility",
    });
    located = waited.located;
    waitedMs = waited.waitedMs;
    input.logger.agentProgress(
      waited.up
        ? `验证组件已就绪（等待 ${(waitedMs / 1000).toFixed(1)}s）：` +
            (located.press ? `长按按钮 [${located.press.why}]「${located.press.label}」` : "仅有无障碍入口")
        : `已等待 ${Math.floor(waitedMs / 1000)}s 仍未见到长按按钮`,
      { phase: "press_hold_captcha", stage: "wait_target_done", ready: waited.up, waitedMs },
    );
  }

  // 既没有长按按钮、也没有无障碍入口 → 诚实返回 unsupported，交由重试/HITL，绝不乱点。
  if (!located.press && !located.accessibility) {
    return unsupported(
      `unsupported: 本页未找到「按住不放」的宽扁长按按钮（已等待 ${Math.floor(waitedMs / 1000)}s 等待组件渲染；` +
        "若挑战已切到图片/点选等其它题型，请改用对应策略；禁止凭空猜坐标）。",
    );
  }

  if (located.press) {
    input.logger.agentProgress(
      `已定位长按按钮 [${located.press.why}]「${located.press.label}」@(${located.press.point.x},${located.press.point.y})` +
        ` ${located.press.w}×${located.press.h} score=${located.press.score}` +
        (located.press.frameUrl ? " · 位于嵌套框架" : ""),
      { phase: "press_hold_captcha", stage: "located", why: located.press.why, score: located.press.score },
    );
  }

  let attempts = 0;
  let accessibilityUsed = false;
  let method = "press_hold";
  let holdMs = 0;
  let outcome: { verified: boolean | null; signal: string } = {
    verified: null,
    signal: "no_clear_signal",
  };

  // ——— 第一阶段：直接长按（只有找到长按按钮时才有这一步） ———
  if (located.press) {
    attempts += 1;
    const held = await holdButton({
      page: input.page,
      point: located.press.point,
      frameUrls: [located.press.frameUrl],
      hasProgress: located.press.progress,
      signal: input.signal,
    });
    holdMs = Math.round(held.holdMs);
    input.logger.agentProgress(
      `② 已按住 ${(held.holdMs / 1000).toFixed(1)}s 后松开（${held.releaseReason}` +
        `${located.press.progress ? " · 可观测进度" : ""}），等待验收…`,
      {
        phase: "press_hold_captcha",
        stage: "released",
        holdMs: held.holdMs,
        holdSignal: held.signal,
        releaseReason: held.releaseReason,
      },
    );
    outcome = await verifyWithPolling({ page: input.page, frameUrls: [located.press.frameUrl] });
    input.logger.agentProgress(
      `③ 验收#1：verified=${String(outcome.verified)} signal=${outcome.signal}`,
      { phase: "press_hold_captcha", stage: "verify", attempt: 1, verified: outcome.verified },
    );
  } else {
    // 只有无障碍入口（题面可能只有音频/无障碍分支）→ 直接走备用方案。
    method = "accessibility_only";
    input.logger.agentProgress("未发现长按按钮，但存在无障碍入口 → 直接走无障碍备用方案", {
      phase: "press_hold_captcha",
      stage: "accessibility_only",
    });
  }

  // ——— 第二阶段：无障碍模式重试 ———
  if (outcome.verified !== true) {
    if (!located.accessibility) {
      input.logger.agentProgress("未找到无障碍入口，跳过备用方案", {
        phase: "press_hold_captcha",
        stage: "accessibility_missing",
      });
      if (method === "press_hold") method = "press_hold_no_accessibility";
    } else {
      accessibilityUsed = true;
      attempts += 1;
      const accFrameUrl = located.accessibility.frameUrl;
      input.logger.agentProgress(
        `④ 点无障碍入口「${located.accessibility.label}」@(${located.accessibility.point.x},${located.accessibility.point.y})`,
        { phase: "press_hold_captcha", stage: "accessibility_click" },
      );
      await clickPoint(input.page, located.accessibility.point);
      await sleep(1200);

      // 无障碍界面就在刚点的那个框架里 → 只在该框架内找目标，避免误点主文档的「下一步」。
      const scope = accFrameUrl ? { onlyFrameUrl: accFrameUrl } : undefined;
      let after = await locateButtons(input.page, vp, scope);
      // 无障碍界面同样是异步渲染的：等它出现长按按钮或主操作（受剩余预算约束）。
      const accBudget = Math.max(0, budget - waitedMs);
      if (!after.press && !after.action && accBudget > 500) {
        const w = await waitForTarget({
          page: input.page,
          vp,
          logger: input.logger,
          signal: input.signal,
          budgetMs: Math.min(accBudget, 12_000),
          onlyFrameUrl: accFrameUrl || undefined,
          want: "press_or_action",
        });
        after = w.located;
        waitedMs += w.waitedMs;
      }
      const next = after.press ?? null;
      if (next) {
        method = "accessibility_press_hold";
        const held = await holdButton({
          page: input.page,
          point: next.point,
          frameUrls: [next.frameUrl],
          hasProgress: next.progress,
          signal: input.signal,
        });
        holdMs = Math.round(held.holdMs);
        input.logger.agentProgress(
          `⑤ 无障碍界面长按按钮 [${next.why}]「${next.label}」：按住 ${(held.holdMs / 1000).toFixed(1)}s（${held.releaseReason}）`,
          { phase: "press_hold_captcha", stage: "accessibility_hold", holdMs: held.holdMs, why: next.why },
        );
        outcome = await verifyWithPolling({ page: input.page, frameUrls: [next.frameUrl] });
      } else if (after.action) {
        method = "accessibility_click";
        input.logger.agentProgress(
          `⑤ 无障碍界面点主操作 [${after.action.why}]「${after.action.label}」`,
          { phase: "press_hold_captcha", stage: "accessibility_action", why: after.action.why },
        );
        await clickPoint(input.page, after.action.point);
        outcome = await verifyWithPolling({
          page: input.page,
          frameUrls: [after.action.frameUrl, accFrameUrl].filter(Boolean),
        });
      } else {
        method = "accessibility_no_target";
        outcome = { verified: null, signal: "accessibility_no_target" };
      }
      input.logger.agentProgress(
        `⑥ 验收#2：verified=${String(outcome.verified)} signal=${outcome.signal}`,
        { phase: "press_hold_captcha", stage: "verify", attempt: 2, verified: outcome.verified },
      );
    }
  }

  const verified = outcome.verified;
  const waitNote = waitedMs >= 1000 ? `；组件加载等待 ${(waitedMs / 1000).toFixed(1)}s` : "";

  const detail =
    verified === true
      ? `press_hold_ok hold=${(holdMs / 1000).toFixed(1)}s ${method}${waitNote}`
      : verified === false
        ? `press_hold_fail：${outcome.signal}；captcha_attempt+1；勿刷新，未满 3 次可重试，满 3 次 HITL。`
        : `press_hold_done hold=${(holdMs / 1000).toFixed(1)}s；无明确页内信号（${outcome.signal}）` +
          (accessibilityUsed ? "；已尝试无障碍备用方案" : "；无可用无障碍入口") +
          waitNote;

  return {
    ok: verified !== false,
    strategy: "press_hold_captcha",
    verified,
    verifySignal: outcome.signal,
    holdMs,
    method,
    accessibilityUsed,
    attempts,
    detail,
  };
}
