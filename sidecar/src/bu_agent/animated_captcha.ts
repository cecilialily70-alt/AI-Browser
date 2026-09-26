/**
 * 图片字符验证码（策略族 image_text_read）
 * 类型门禁 → 取验证码图 → 按**字节事实**分流：
 *   · GIF 动图：GDI 全帧拆解 → 逐帧时长归一化为权重 → 视觉读码 → 加权共识
 *   · 静态图  ：原图 + OpenCV 去噪/二值化变体 → 视觉读码 → 配对佐证共识
 * 两种子模式共用同一套读码池与共识裁决，只有「取帧」这一步不同。
 * 非图片型（短信/邮箱/语音码）与非本族类型：unsupported，禁止截图 OCR 回退。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Page } from "playwright-core";

import { createModelRouter, isIntentConfigured } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import type { JsonLogger } from "../json-logger.js";
import { stripFencedJson } from "../json_extract.js";
import type { AgentFileSystem } from "./filesystem.js";
import {
  findCaptchaFormHints as findCaptchaFormHintsShared,
  type CaptchaFormHints,
} from "./captcha_form_hints.js";
import {
  extractGifFramesAsJpeg,
  isGifBuffer,
  prepareVisionJpegs,
  upscaleJpeg,
  type GifFrameImage,
} from "./gif_frames.js";
import { parseGifMeta, temporalFrameWeights, hasTemporalSignal } from "./gif_meta.js";
import { openCvDenoise } from "./opencv_preprocess.js";
import { sleep, extractVisionMessageText, classifyCaptchaOutcomeText } from "./captcha_utils.js";
import type { IndexedElementRef } from "./views.js";
import {
  detectCaptchaStrategy,
  SUPPORTED_CAPTCHA_STRATEGIES,
  type CaptchaStrategyId,
} from "./captcha_strategy.js";

/**
 * 族内子模式：由**图字节**决定，不是文案猜测。
 * 对上层如实上报，避免静态图被记成 gif_animated_dwell 而污染日志与排查依据。
 */
export type ImageTextSubMode = "gif_animated_dwell" | "static_image_read";

/** 视觉读码并发上限（异步池，非 OS 线程） */
const CAPTCHA_VISION_CONCURRENCY = 4;

export type { CaptchaStrategyId };

export type { CaptchaFormHints };

export interface ImageTextSolveResult {
  ok: boolean;
  code: string;
  frame: number;
  confidence: number;
  framesCaptured: number;
  formHints: CaptchaFormHints;
  /** 族内子模式（动图/静态图），非族 id；族 id 恒为 image_text_read */
  strategy: ImageTextSubMode | "unsupported";
  supportedStrategies?: string[];
  framePaths?: string[];
  gifPath?: string;
  /** 本轮落盘产物（GIF/帧目录/视觉 JPEG），验证完成后删除 */
  artifactPaths?: string[];
  detail?: string;
}

const MAX_VISION_FRAMES = 12;

export function findCaptchaFormHints(
  selectorMap: Map<number, IndexedElementRef>,
): CaptchaFormHints {
  return findCaptchaFormHintsShared(selectorMap, "image_text");
}

/**
 * 页面内执行：按分数挑出最像验证码图的 <img>。
 * 取值与「换新码」共用同一份打分，避免两处规则漂移导致点到别的图。
 */
function pickCaptchaImageInPage(): {
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const imgs = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
  const scored: Array<{
    src: string;
    score: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  for (const el of imgs) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 16 || r.bottom < 0 || r.top > innerHeight) continue;
    const src = String(el.currentSrc || el.src || "").trim();
    if (!src) continue;
    const alt = `${el.alt || ""} ${el.className || ""} ${el.id || ""}`;
    let score = 0;
    if (/\.gif(\?|$)/i.test(src) || src.startsWith("data:image/gif")) score += 100;
    if (/captcha|verify|code|验证|yanzheng/i.test(alt + src)) score += 40;
    if (r.width >= 80 && r.width <= 400 && r.height >= 24 && r.height <= 120) score += 20;
    scored.push({ src, score, x: r.x, y: r.y, width: r.width, height: r.height });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}

/** 由 src 取回图片字节；data: 内联图直接解码。 */
async function fetchCaptchaMediaBySrc(
  page: Page,
  src: string,
): Promise<{ buf: Buffer; src: string } | null> {
  if (src.startsWith("data:")) {
    const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
    if (!m?.[3]) return null;
    const isB64 = Boolean(m[2]);
    const payload = m[3];
    const buf = isB64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload));
    return { buf, src: "data:inline" };
  }
  const resp = await page.request.get(src, { timeout: 15_000 });
  if (!resp.ok()) return null;
  const buf = Buffer.from(await resp.body());
  return { buf, src };
}

async function locateAndFetchCaptchaMedia(page: Page): Promise<{
  buf: Buffer;
  src: string;
} | null> {
  const info = await page.evaluate(pickCaptchaImageInPage);
  if (!info?.src) return null;
  return fetchCaptchaMediaBySrc(page, info.src);
}

/** 验证码当前指纹：src + 字节哈希。用来判定「换新码」是不是真的换了。 */
async function captchaFingerprint(
  page: Page,
): Promise<{ src: string; hash: string } | null> {
  const media = await locateAndFetchCaptchaMedia(page);
  if (!media) return null;
  return { src: media.src, hash: createHash("sha1").update(media.buf).digest("hex") };
}

/**
 * 读取当前验证码指纹（供调用方判断「这一轮解的图」与「上一次提交的图」是否同一张）。
 * 与 refreshCaptchaMedia 共用同一份取值与哈希口径，避免两处判据漂移。
 */
export function readCaptchaFingerprint(
  page: Page,
): Promise<{ src: string; hash: string } | null> {
  return captchaFingerprint(page);
}

/** 优先按语义点击「刷新/换一张」，找不到才点验证码图本身。 */
const REFRESH_AFFORDANCE_RE =
  /刷新|换一张|换一换|看不清|点击更换|重新获取|重新加载|reload|refresh|renew|another|new\s*code/i;
/** 绝对不能误点的危险文案：换码时点到这些会直接提交/登录。 */
const DANGEROUS_CLICK_RE = /提交|登录|注册|确认|支付|购买|submit|login|sign\s*in|sign\s*up|confirm/i;

async function clickRefreshAffordance(page: Page): Promise<string | null> {
  const info = await page.evaluate(pickCaptchaImageInPage);
  if (!info) return null;
  return page.evaluate(
    ({ rect, refreshPattern, dangerPattern }) => {
      const refreshRe = new RegExp(refreshPattern, "i");
      const dangerRe = new RegExp(dangerPattern, "i");
      const describe = (el: Element): string =>
        [
          el.getAttribute("title"),
          el.getAttribute("aria-label"),
          el.getAttribute("alt"),
          el.textContent,
          el.className,
          el.id,
        ]
          .filter(Boolean)
          .join(" ");
      const near = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const padX = Math.max(60, rect.width);
        const padY = Math.max(40, rect.height);
        return (
          cx >= rect.x - padX &&
          cx <= rect.x + rect.width + padX &&
          cy >= rect.y - padY &&
          cy <= rect.y + rect.height + padY
        );
      };
      const candidates = Array.from(
        document.querySelectorAll("button,a,i,span,div,img"),
      ) as HTMLElement[];
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (!near(el)) continue;
        const label = describe(el);
        if (!refreshRe.test(label)) continue;
        if (dangerRe.test(label)) continue;
        el.click();
        return "label";
      }
      // 兜底：多数站点点验证码图本身就换一张
      const imgs = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
      const target = imgs.find((el) => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.x - rect.x) < 2 && Math.abs(r.y - rect.y) < 2;
      });
      if (target) {
        target.click();
        return "image_click";
      }
      return null;
    },
    {
      rect: { x: info.x, y: info.y, width: info.width, height: info.height },
      refreshPattern: REFRESH_AFFORDANCE_RE.source,
      dangerPattern: DANGEROUS_CLICK_RE.source,
    },
  );
}

const REFRESH_POLL_ROUNDS = 12;
const REFRESH_POLL_INTERVAL_MS = 300;

/**
 * 强制换新验证码，并校验图确实变了。
 *
 * 为什么必须校验：重解一张没换的图只会得到同一个答案、再提交一次同样的错误，
 * 这正是「失败后重试到 3 次 HITL」却毫无进展的原因。指纹（src 或字节）没变
 * 就明确返回失败，让调用方走人工，而不是假装重试过。
 */
export async function refreshCaptchaMedia(
  page: Page,
  logger: JsonLogger,
): Promise<{ refreshed: boolean; reason: string }> {
  const before = await captchaFingerprint(page);
  if (!before) return { refreshed: false, reason: "captcha_not_found" };

  const clicked = await clickRefreshAffordance(page);
  if (!clicked) return { refreshed: false, reason: "no_refresh_control" };

  for (let round = 0; round < REFRESH_POLL_ROUNDS; round++) {
    await sleep(REFRESH_POLL_INTERVAL_MS);
    const now = await captchaFingerprint(page);
    if (now && (now.src !== before.src || now.hash !== before.hash)) {
      logger.agentProgress("已换新验证码（指纹已变化）", {
        phase: "animated_captcha",
        stage: "captcha_refreshed",
        via: clicked,
      });
      return { refreshed: true, reason: `via_${clicked}` };
    }
  }
  logger.agentProgress("点击刷新后验证码未变化，放弃换新", {
    phase: "animated_captcha",
    stage: "captcha_refresh_noop",
    via: clicked,
  });
  return { refreshed: false, reason: "unchanged_after_click" };
}

/** 验证码尝试上限：与技能手册中的 3 次 HITL 门槛同源。 */
export const CAPTCHA_MAX_ATTEMPTS = 3;
const captchaAttemptsByPage = new WeakMap<Page, number>();

/** 记一次失败尝试，返回累计次数（让上限由代码决定，而不是靠提示词文案）。 */
export function noteCaptchaAttempt(page: Page): number {
  const next = (captchaAttemptsByPage.get(page) ?? 0) + 1;
  captchaAttemptsByPage.set(page, next);
  return next;
}

export function resetCaptchaAttempts(page: Page): void {
  captchaAttemptsByPage.delete(page);
}

/** 当前页已累计的验证码失败次数（无记录则为 0） */
export function getCaptchaAttempts(page: Page): number {
  return captchaAttemptsByPage.get(page) ?? 0;
}

/**
 * 挑选送视觉的帧。
 *
 * 无权重（或权重全等）时**完全走原来的均匀抽样**——这是硬要求：
 * 没有时长信号时不得改变既有行为。
 * 有权重差异时先按权重降序保留高权帧，再用均匀抽样填满名额，
 * 避免「帧数超过上限就把最关键的那帧抽掉」。
 */
/**
 * 从 total 帧中最多保留 maxN 帧，返回**升序**的源帧下标。
 *
 * 有显著时长权重时先取权重最高的若干帧，再用均匀取样补齐（保证覆盖首尾）；
 * 无权重或全部等长时退化为纯均匀取样，行为与不启用权重时完全一致。
 *
 * 抽帧前就要用到它：抽帧是一次固定开销约 870 ms 的独立进程，抽全部再丢弃等于白付进程
 * 启动，还要多解码/编码被丢掉的帧。
 */
export function sampleFrameIndexes(total: number, maxN: number, weights?: number[]): number[] {
  const all = Array.from({ length: Math.max(0, total) }, (_, i) => i);
  if (total <= maxN) return all;
  // maxN<=1 时均匀取样会除以 0；直接退化为取首帧。
  if (maxN <= 1) return [0];

  const uniform = (): number[] => {
    const out: number[] = [];
    const last = total - 1;
    for (let i = 0; i < maxN; i++) {
      const idx = Math.round((i * last) / (maxN - 1));
      if (!out.includes(idx)) out.push(idx);
    }
    return out;
  };

  const distinct =
    weights != null && weights.length === total
      ? new Set(weights.map((weight) => weight.toFixed(6))).size > 1
      : false;
  if (!distinct) return uniform().sort((a, b) => a - b);

  const picked: number[] = [];
  const ranked = all
    .map((index) => ({ index, weight: weights![index]! }))
    .sort((a, b) => b.weight - a.weight);
  for (const item of ranked) {
    if (picked.length >= maxN) break;
    picked.push(item.index);
  }
  for (const index of uniform()) {
    if (picked.length >= maxN) break;
    if (!picked.includes(index)) picked.push(index);
  }
  return picked.sort((a, b) => a - b);
}

/** 验证码字符不定长：常见 3–8，兼容更短/更长，禁止写死位数 */
const CAPTCHA_CODE_RE = /^[A-Za-z0-9]{2,16}$/;

/**
 * 视觉响应 JSON 的字段名。取值解析与「字段名不得当码」的黑名单共用同一份清单：
 * 新增字段只需改这里，解析会认它，黑名单也会自动挡住「模型复述字段名」的误读。
 */
const VISION_CODE_KEYS = ["code", "text", "captcha", "answer", "验证码"] as const;
const VISION_CONFIDENCE_KEYS = [
  "confidence",
  "clarity",
  "accuracy",
  "score",
  "准确率",
  "置信度",
  "清晰度",
] as const;
/**
 * 「可辨字符数」字段名。这一项回答的是「本帧有几个字你能逐个独立确认」，
 * 与 confidence（你对抄写结果有多自信）刻意分成两件事：0~1 的自信分会被模型灌水
 * （实测错误答案自报 1.00），而离散的字符计数难以灌水、且能跨帧比较。
 */
const VISION_LEGIBILITY_KEYS = [
  "legible",
  "legible_count",
  "legiblecount",
  "readable_chars",
  "可辨字符数",
  "可读字符数",
] as const;

/**
 * 禁止当作验证码的字面量：JSON 字段名 + 布尔/空值等。
 *
 * 模型偶尔复述结构而不给值（如 `"code":"confidence"`），若不复核就会把字段名当成
 * 验证码提交。实测日志出现过 `code=confidence` 且它拿到 3 票——比真实答案票数还高，
 * 所以这条复核是「跨帧共识择优」能安全生效的前提。
 */
const NON_CODE_TOKENS: ReadonlySet<string> = new Set<string>(
  [
    ...VISION_CODE_KEYS,
    ...VISION_CONFIDENCE_KEYS,
    ...VISION_LEGIBILITY_KEYS,
    "null",
    "true",
    "false",
    "readable",
    "ok",
    "unreadable",
    "json",
    "frame",
    "user",
    "html",
    "xxxx",
    "string",
    "number",
    "boolean",
  ].map((token) => token.toLowerCase()),
);

/** 按优先级取第一个「有内容」的字段值（`??` 会把空串当命中，这里跳过空串）。 */
function firstFieldValue(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && !value.trim()) continue;
    if (value != null) return value;
  }
  return null;
}

/** 按优先级取第一个可解析的清晰度字段。 */
function firstConfidenceValue(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const parsed = parseConfidenceValue(obj[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

/** 按优先级取第一个「可辨字符数」（非负整数）。不是计数就别猜，返回 null。 */
function firstLegibilityValue(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = obj[key];
    const n = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) continue;
    return Math.floor(n);
  }
  return null;
}

type FrameRead = {
  code: string | null;
  /** 清晰度置信度；缺则 null，禁止用假常数填充 */
  confidence: number | null;
  /** 本帧可逐个独立确认的字符数；缺则 null */
  legibility: number | null;
  readable: boolean;
};

/**
 * 送入视觉池的一张图。同一张源帧会有多个变体（原图/去噪…），
 * 变体之间各自独立读码，是判定「这一帧的读数是否可信」的关键证据。
 */
type VisionFrame = {
  /** 落盘 JPEG 路径 */
  path: string;
  /** 对应的源帧 PNG（读完一并删除） */
  sourcePngPath?: string;
  /** 源帧序号（1-based）：同一源帧的所有变体共享，用于配对佐证 */
  sourceFrame: number;
  /** 变体名：orig | denoise */
  variant: string;
  /**
   * 该源帧的**相对重要度**（1 = 中性）。来自 GIF 逐帧显示时长的归一化权重，
   * 不是「这帧是答案」的布尔断言——每个验证码结构都不同，不准写死。
   * 无时长信息时全为 1，裁诀退化为纯票数。
   */
  weight?: number;
};

/** 本轮读码候选内存：凡识别到码即入，再由 selectCaptureCandidate 做共识裁决 */
type CaptchaCandidate = {
  /** 池内序号（1-based），仅供日志连续展示 */
  frameIndex: number;
  /** 源帧序号（1-based）：配对佐证的依据 */
  sourceFrame: number;
  /** 该源帧的相对重要度（来自 GIF 逐帧显示时长，1 = 中性；无信号时全为 1） */
  weight: number;
  /** 变体名：orig | denoise */
  variant: string;
  code: string;
  /** 模型自报把握。已降级为「仅展示/最后兜底」：实测它与正确性甚至负相关 */
  confidence: number;
  /** json | clarity_ask | prose_clarity | unscored */
  confidenceSource: string;
  /** 本帧可逐个独立确认的字符数；缺则 null */
  legibility: number | null;
  /** 截断后的原文，避免占内存 */
  raw: string;
};

/** 删除单帧落盘文件（读完即毁，释放磁盘）；静默，由调用方打进度 */
function destroyFrameImageFiles(paths: Array<string | undefined | null>): number {
  let removed = 0;
  for (const p of paths) {
    const target = String(p ?? "").trim();
    if (!target || !existsSync(target)) continue;
    try {
      unlinkSync(target);
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

function parseConfidenceValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    let n = v;
    if (n > 1 && n <= 100) n = n / 100;
    if (n >= 0 && n <= 1) return n;
    return null;
  }
  if (typeof v === "string") {
    const t = v.trim().replace(/%$/, "");
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return parseConfidenceValue(n);
  }
  return null;
}

function normalizeCaptchaCode(raw: unknown): string | null {
  const code = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!code || /^null$/i.test(code) || code === "?" || code === "-") return null;
  if (!CAPTCHA_CODE_RE.test(code)) return null;
  // 字段名/字面量不是验证码：模型复述结构时会把 "confidence" 之类当值吐出来
  if (NON_CODE_TOKENS.has(code.toLowerCase())) return null;
  return code;
}

/**
 * 从模型对「本帧画面」的描述推断清晰度（非站点特化、非固定假分）。
 * 只依据雾/糊/清晰等画面描述；不因「不对/再看」等认字犹豫降权（认字犹豫≠画面清晰度）。
 */
function estimateClarityFromProse(text: string): number | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;

  const confM = t.match(
    /(?:confidence|clarity|accuracy|score|准确率|置信度|清晰度)\s*[：:=\-]?\s*(0?\.\d+|1(?:\.0+)?|\d{1,3})%?/i,
  );
  const numbered = confM?.[1] ? parseConfidenceValue(confM[1]) : null;
  if (numbered != null && numbered > 0) return numbered;

  if (/confidence\s*要低|清晰度\s*(要|偏|较)?低|打低分/i.test(t)) return 0.32;

  if (/几乎看不清|完全模糊|无法识别|不可读|太糊/i.test(t)) return 0.18;
  if (/很模糊|非常模糊|雾很重|严重遮挡|雾状/i.test(t)) return 0.28;
  if (/比较模糊|较为模糊|不太清晰|看不准|识别不准/i.test(t)) return 0.36;
  if (/(?<![不])模糊|有雾|看不清/i.test(t)) return 0.38;
  if (/有点模糊|略模糊|稍糊/i.test(t)) return 0.48;

  if (/非常清晰|十分清晰|清晰可见|很清楚|清楚可读/i.test(t)) return 0.9;
  if (/较清晰|比较清晰|能看清|可以读出|能看到/i.test(t)) return 0.72;
  if (/(?<![不])清晰/i.test(t)) return 0.78;

  return null;
}

/**
 * 解析视觉响应：只取 code + 置信度 confidence + 可辨字符数 legibility。
 * - 无码 / 不可读 → code=null
 * - 有码无 confidence → confidence=null（后续用追问/口语清晰度补齐，有码必入内存）
 * - 不定长；不针对某一站点/某一张图特化
 */
function parseFrameRead(raw: string): FrameRead {
  const text = String(raw ?? "").trim();
  if (!text) return { code: null, confidence: null, legibility: null, readable: false };

  if (
    /视频解析|不支持.*图|不支持.*视频/i.test(text) &&
    !/[A-Za-z0-9]{2,}/.test(text)
  ) {
    return { code: null, confidence: null, legibility: null, readable: false };
  }

  const body = stripFencedJson(text);

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
      if (obj.readable === false || obj.ok === false || obj.unreadable === true) {
        const c0 = normalizeCaptchaCode(obj.code);
        if (!c0) return { code: null, confidence: null, legibility: null, readable: false };
      }
      const code = normalizeCaptchaCode(firstFieldValue(obj, VISION_CODE_KEYS));
      const confidence = firstConfidenceValue(obj, VISION_CONFIDENCE_KEYS);
      const legibility = firstLegibilityValue(obj, VISION_LEGIBILITY_KEYS);
      if (!code) {
        return { code: null, confidence: null, legibility: null, readable: false };
      }
      // 自相矛盾：给了码却自报「一个字符都没确认」→ 这条读数是噪点，不能进池投票
      if (legibility === 0) {
        return { code: null, confidence: null, legibility: null, readable: false };
      }
      return {
        code,
        confidence,
        // 只认「不超过码长」的计数：多报的整数是模型在凑数，不可信
        legibility: legibility != null && legibility <= code.length ? legibility : null,
        readable: confidence == null ? true : confidence > 0,
      };
    } catch {
      /* fall through */
    }
  }

  return extractCodeWithoutInventedConfidence(body);
}

/**
 * 自由文本仅提取「看见的码」；置信度若文中有数字则带上，否则留给清晰度推断。
 * 支持引号包裹、分隔符拼字符（位数不定：2～16）。
 */
function extractCodeWithoutInventedConfidence(body: string): FrameRead {
  const votes = new Map<string, number>();
  const bump = (raw: string, weight: number) => {
    const c = normalizeCaptchaCode(raw);
    if (!c) return;
    votes.set(c, (votes.get(c) ?? 0) + weight);
  };

  for (const m of body.matchAll(/[「“"'`]([A-Za-z0-9]{2,16})[」”"'`]/g)) {
    bump(m[1]!, 4);
  }
  for (const m of body.matchAll(
    /(?:code|captcha|验证码|可能是|看起来是|看起来像是|像是|应该是|字符是|实际是)\s*[：:=\-]?\s*[「“"'`]?([A-Za-z0-9]{2,16})/gi,
  )) {
    bump(m[1]!, 3);
  }
  // 不定长：A、B、C… / A, B, C… → 拼接（2～16 字符）
  for (const m of body.matchAll(
    /\b([A-Za-z0-9](?:\s*[、,，]\s*[A-Za-z0-9]){1,15})\b/g,
  )) {
    bump(m[1]!.replace(/\s*[、,，]\s*/g, ""), 3);
  }

  const confidence = estimateClarityFromProse(body);
  const legibility = estimateLegibilityFromProse(body);

  if (votes.size === 0) {
    return { code: null, confidence, legibility, readable: false };
  }

  let best = "";
  let bestN = 0;
  for (const [c, n] of votes) {
    if (n > bestN || (n === bestN && c.length >= best.length)) {
      best = c;
      bestN = n;
    }
  }
  return {
    code: best || null,
    confidence,
    legibility: legibility != null && best && legibility <= best.length ? legibility : null,
    readable: Boolean(best),
  };
}

/** 从自由文本里捞「可辨字符数」；捞不到就返回 null，绝不编造。 */
function estimateLegibilityFromProse(text: string): number | null {
  const keys = VISION_LEGIBILITY_KEYS.join("|");
  const m = String(text ?? "").match(new RegExp(`(?:${keys})\\s*[：:=\\-]?\\s*(\\d{1,2})`, "i"));
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 仅追问清晰度；JSON 失败则从口语清晰度描述推断 */
async function askClarityConfidence(input: {
  client: VisionClient;
  model: string;
  imagePart: {
    type: "image_url";
    image_url: { url: string; detail: "high" };
  };
  code: string;
  signal?: AbortSignal;
}): Promise<{ confidence: number | null; raw: string }> {
  const resp = await input.client.chat.completions.create(
    {
      model: input.model,
      temperature: 0,
      max_tokens: 60,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `验证码已定为「${input.code}」。不要重读字符。` +
                "只根据本帧雾/糊/遮挡程度打清晰度 0~1。" +
                '只输出：{"confidence":0.72} 这种一行 JSON，禁止思考过程。',
            },
            input.imagePart,
          ],
        },
      ],
    },
    input.signal ? { signal: input.signal } : undefined,
  );
  const raw = extractVisionMessageText(resp).text;
  const read = parseFrameRead(raw);
  if (read.confidence != null && read.confidence > 0) {
    return { confidence: read.confidence, raw };
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const c =
        parseConfidenceValue(obj.confidence) ?? parseConfidenceValue(obj.clarity);
      if (c != null && c > 0) return { confidence: c, raw };
    } catch {
      /* prose */
    }
  }
  const fromProse = estimateClarityFromProse(raw);
  return { confidence: fromProse, raw };
}

/** 删除本轮验证码落盘文件（GIF / frames / vision） */
export function cleanupCaptchaArtifacts(
  paths: string[] | undefined,
  logger: JsonLogger,
): void {
  if (!paths?.length) return;
  let removed = 0;
  for (const p of paths) {
    const target = String(p ?? "").trim();
    if (!target || !existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("captcha_artifact_cleanup_failed", {
        path: target.slice(0, 200),
        error: msg.slice(0, 160),
      });
    }
  }
  if (removed > 0) {
    logger.agentProgress(`已清理验证码临时文件 ${removed} 项（防重复使用旧图）`, {
      phase: "animated_captcha",
      stage: "cleanup",
      removed,
    });
  }
}

type VisionClient = {
  chat: {
    completions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (
        body: any,
        options?: { signal?: AbortSignal },
      ) => Promise<{
        choices?: Array<{
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
            refusal?: unknown;
          } | null;
          finish_reason?: string | null;
        }>;
      }>;
    };
  };
};

/**
 * 读不出码时的最后一招：把该帧放大后重读一次。
 *
 * 只在**已经连续读不出**之后调用。放大是像素复制，不增加任何信息，唯一作用是绕过
 * 「上游对过小图回空内容」这一具体故障；把它放进常规流程会让每帧都白付约 10 倍
 * base64 体积与 16 倍去噪像素（见 gif_frames.prepareVisionJpegs）。
 * @returns 重读结果；放大或重读失败返回 null，调用方按原逻辑排除该帧
 */
async function rereadFrameEnlarged(input: {
  client: VisionClient;
  model: string;
  jpegPath: string;
  frameIndex: number;
  total: number;
  systemPrompt: string;
  pageHint?: string;
  logger: JsonLogger;
  signal?: AbortSignal;
}): Promise<{ read: FrameRead; raw: string; finishReason: string } | null> {
  // 放大产物放独立目录，读完整目录销毁，不掺进主 artifact 清理链
  const enlargedDir = join(dirname(input.jpegPath), `enlarged_${input.frameIndex}`);
  try {
    const enlarged = await upscaleJpeg(input.jpegPath, enlargedDir);
    input.logger.agentProgress(`第 ${input.frameIndex} 帧仍未读出，放大后重读（兜底）…`, {
      phase: "animated_captcha",
      stage: "frame_enlarge_retry",
      frame: input.frameIndex,
    });
    const resp = await input.client.chat.completions.create(
      {
        model: input.model,
        temperature: 0,
        max_tokens: 120,
        messages: [
          { role: "system", content: input.systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `第 ${input.frameIndex}/${input.total} 帧（已放大）。只输出一行 JSON：` +
                  `code（不定长）+ legible（整数）+ confidence。` +
                  (input.pageHint ? ` 页面提示：${input.pageHint.slice(0, 120)}` : ""),
              },
              {
                type: "image_url" as const,
                image_url: {
                  url: `data:image/jpeg;base64,${readFileSync(enlarged).toString("base64")}`,
                  detail: "high" as const,
                },
              },
            ],
          },
        ],
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    const extracted = extractVisionMessageText(resp);
    return {
      read: parseFrameRead(extracted.text),
      raw: extracted.text,
      finishReason: extracted.finishReason,
    };
  } catch (err) {
    if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
      throw new Error("Agent 已中止");
    }
    input.logger.debug("frame_enlarge_retry_failed", {
      frame: input.frameIndex,
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return null;
  } finally {
    try {
      rmSync(enlargedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 单帧读码（可在并发池中运行）。结束后销毁本帧 JPEG/PNG 与 base64，释放槽位。
 */
async function readOneCaptchaFrame(input: {
  client: VisionClient;
  model: string;
  /** 池内序号（1-based），仅用于日志 */
  frameIndex: number;
  total: number;
  /** 本次要读的图（含源帧身份，供事后配对佐证） */
  frame: VisionFrame;
  logger: JsonLogger;
  pageHint?: string;
  signal?: AbortSignal;
  systemPrompt: string;
}): Promise<CaptchaCandidate | null> {
  const i = input.frameIndex;
  const n = input.total;
  const jpegPath = input.frame.path;
  const sourcePngPath = input.frame.sourcePngPath;
  let b64: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let imagePart: any = null;

  try {
    if (input.signal?.aborted) {
      throw new Error("Agent 已中止");
    }

    b64 = readFileSync(jpegPath).toString("base64");
    input.logger.agentProgress(`读码第 ${i}/${n} 帧…（并发池）`, {
      phase: "animated_captcha",
      stage: "read_frame",
      frame: i,
      sourceFrame: input.frame.sourceFrame,
    });

    let raw = "";
    let finishReason = "";
    let read: FrameRead = { code: null, confidence: null, legibility: null, readable: false };
    let confidenceSource = "none";
    imagePart = {
      type: "image_url" as const,
      image_url: {
        url: `data:image/jpeg;base64,${b64}`,
        detail: "high" as const,
      },
    };
    // base64 已挂到 imagePart，尽早松开独立引用
    b64 = null;

    try {
      const resp = await input.client.chat.completions.create(
        {
          model: input.model,
          temperature: 0.05,
          max_tokens: 220,
          messages: [
            { role: "system", content: input.systemPrompt },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    `第 ${i}/${n} 帧。只输出一行 JSON：code（不定长）+ legible（整数）+ confidence。` +
                    (input.pageHint ? ` 页面提示：${input.pageHint.slice(0, 120)}` : ""),
                },
                imagePart,
              ],
            },
          ],
        },
        input.signal ? { signal: input.signal } : undefined,
      );
      const extracted = extractVisionMessageText(resp);
      raw = extracted.text;
      finishReason = extracted.finishReason;
      read = parseFrameRead(raw);
      if (read.confidence != null && read.confidence > 0) confidenceSource = "json";
    } catch (err) {
      if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
        throw new Error("Agent 已中止");
      }
      const msg = err instanceof Error ? err.message : String(err);
      input.logger.agentProgress(`第 ${i} 帧请求失败，排除：${msg.slice(0, 120)}`, {
        phase: "animated_captcha",
        stage: "frame_excluded",
        frame: i,
      });
      return null;
    }

    if (!read.code && !input.signal?.aborted) {
      try {
        input.logger.agentProgress(`第 ${i} 帧未读出码，短提示重试…`, {
          phase: "animated_captcha",
          stage: "frame_retry",
          frame: i,
        });
        const retry = await input.client.chat.completions.create(
          {
            model: input.model,
            temperature: 0,
            max_tokens: 120,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      "只输出一行 JSON，禁止思考。位数不定。" +
                      '{"code":"所见字符","legible":可逐个确认的字符数,"confidence":0.0}' +
                      ' 或 {"code":null,"legible":0,"confidence":0,"readable":false}',
                  },
                  imagePart,
                ],
              },
            ],
          },
          input.signal ? { signal: input.signal } : undefined,
        );
        const extracted2 = extractVisionMessageText(retry);
        if (extracted2.text) {
          raw = extracted2.text;
          finishReason = extracted2.finishReason;
          read = parseFrameRead(raw);
          if (read.confidence != null && read.confidence > 0) confidenceSource = "json";
        }
      } catch (err) {
        if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
          throw new Error("Agent 已中止");
        }
      }
    }

    // 短提示重试也读不出：可能是上游对过小图回空内容，此时才动用放大兜底。
    if (!read.code && !input.signal?.aborted) {
      const enlarged = await rereadFrameEnlarged({
        client: input.client,
        model: input.model,
        jpegPath,
        frameIndex: i,
        total: n,
        systemPrompt: input.systemPrompt,
        pageHint: input.pageHint,
        logger: input.logger,
        signal: input.signal,
      });
      if (enlarged?.read.code) {
        raw = enlarged.raw;
        finishReason = enlarged.finishReason;
        read = enlarged.read;
        if (read.confidence != null && read.confidence > 0) confidenceSource = "json";
      }
    }

    if (!read.code) {
      input.logger.agentProgress(
        `第 ${i} 帧未读出码，排除：${raw.slice(0, 140) || `(空响应 finish=${finishReason || "?"})`}`,
        {
          phase: "animated_captcha",
          stage: "frame_excluded",
          frame: i,
          preview: raw.slice(0, 280),
          finishReason,
        },
      );
      return null;
    }

    const code = read.code;
    let confidence = read.confidence;

    if (confidence == null || confidence <= 0) {
      const fromProse = estimateClarityFromProse(raw);
      if (fromProse != null && fromProse > 0) {
        confidence = fromProse;
        confidenceSource = "prose_clarity";
      }
    }

    if ((confidence == null || confidence <= 0) && !input.signal?.aborted) {
      try {
        input.logger.agentProgress(`第 ${i} 帧已读到 ${code}，追问清晰度…`, {
          phase: "animated_captcha",
          stage: "ask_clarity",
          frame: i,
          code,
        });
        const asked = await askClarityConfidence({
          client: input.client,
          model: input.model,
          imagePart,
          code,
          signal: input.signal,
        });
        if (asked.raw) raw = `${raw}\n---\n${asked.raw}`;
        if (asked.confidence != null && asked.confidence > 0) {
          confidence = asked.confidence;
          confidenceSource = "clarity_ask";
        }
      } catch (err) {
        if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
          throw new Error("Agent 已中止");
        }
      }
    }

    if (confidence == null || confidence <= 0) {
      confidence = 0.55;
      confidenceSource = "unscored";
    }

    return {
      frameIndex: i,
      sourceFrame: input.frame.sourceFrame,
      variant: input.frame.variant,
      weight: input.frame.weight ?? 1,
      code,
      confidence: Math.min(1, confidence),
      confidenceSource,
      legibility: read.legibility,
      raw: raw.slice(0, 400),
    };
  } finally {
    // 结果已返回（或失败）：销毁图片引用与落盘文件，释放本路「线程」资源
    imagePart = null;
    b64 = null;
    const removed = destroyFrameImageFiles([jpegPath, sourcePngPath]);
    input.logger.agentProgress(
      `第 ${i} 帧任务结束，已销毁图片 ${removed} 个并释放并发槽`,
      {
        phase: "animated_captcha",
        stage: "frame_slot_released",
        frame: i,
        removed,
      },
    );
  }
}

/** 自报分的来源可信度：模型直接给 > 追问得到 > 从描述推断。只用于组内挑代表。 */
const CONFIDENCE_SOURCE_RANK: Readonly<Record<string, number>> = {
  json: 0,
  clarity_ask: 1,
  prose_clarity: 2,
};

/**
 * 分组用的相似判定：大小写折叠后编辑距离 ≤1。
 *
 * 为什么必须容错：OCR 对同一张图的两次读会出现大小写抖动（`BXEq` vs `BxEq`）
 * 或一字之差（`py6y8` vs `py68`、`iIn6` vs `iing6`）。上一版用精确字符串做分组键，
 * 结果正确码被拆成两个各 1 票的组，投票制直接失效。
 * 折叠只用于「比较」，绝不用于提交——验证码区分大小写，提交值另行逐位重建。
 */
function foldForCompare(code: string): string {
  return code.toLowerCase();
}

function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return diff === 1;
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let si = 0;
  let li = 0;
  let skipped = false;
  while (si < shorter.length && li < longer.length) {
    if (shorter[si] === longer[li]) {
      si += 1;
      li += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    li += 1;
  }
  return true;
}

/** 组内裁决用的目标质量：可辨字符占比越高越可信。 */
function legibilityRatio(candidate: CaptchaCandidate): number {
  if (candidate.legibility == null) return -1;
  return candidate.legibility / Math.max(1, candidate.code.length);
}

export interface ConsensusGroup {
  /** 提交值：按逐位多数重建，保留大小写 */
  code: string;
  /** 组内读数条数（含同一源帧的多个变体） */
  votes: number;
  /** 去重后的源帧号 */
  sourceFrames: number[];
  /** 有几个源帧做到了「原图与变体独立读、结果逐字符完全相同」——最强证据 */
  exactPairs: number;
  /** 有几个源帧做到了「字母全同、双方自证全部字符，仅大小写分歧」——次级证据 */
  softPairs: number;
  /** 声称「每个字符都独立确认」的读数条数：仅参与排序，不作为定案依据 */
  selfConfirmed: number;
  /** 组内质量最高的一条 */
  best: CaptchaCandidate;
  /**
   * 组内加权票数：Σ(成员权重)。权重来自 GIF 逐帧显示时长（无信号时全为 1，
   * 此时本值恒等于 votes）。用连续权重而不是「停留帧」布尔标记，
   * 是为了不对任何验证码的具体结构做假设——只让数据自己说话。
   */
  weightSum: number;
  /** 代表串存在大小写分歧（提交有风险，需二次精读） */
  caseAmbiguous: boolean;
  /**
   * 组内出现过的全部读数（去重、按质量排序）。
   * 用途是观测与度量：真值有时落在同组的**另一个变体读法**上（实测运行2：
   * 原图读 `HHNR`、去噪图读 `HKNR`，真值是后者），只有看到成员列表才能算出
   * 「真值是否落在最高票组内」这个单发命中指标。
   */
  memberCodes: string[];
}

/** 候选质量排序（组内挑 best 用）：只认客观可比项，自报把握放最后。 */
function compareCandidateQuality(a: CaptchaCandidate, b: CaptchaCandidate): number {
  const lr = legibilityRatio(b) - legibilityRatio(a);
  if (lr !== 0) return lr;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const rd =
    (CONFIDENCE_SOURCE_RANK[a.confidenceSource] ?? 3) -
    (CONFIDENCE_SOURCE_RANK[b.confidenceSource] ?? 3);
  if (rd !== 0) return rd;
  return a.frameIndex - b.frameIndex;
}

/**
 * 按「逐位多数」重建组代表串。
 *
 * 只采信与组内最优读数相似（大小写折叠后编辑距离 ≤1）的成员：分组用的是传递合并，
 * 一条中间读数可能把两个本来无关的读数串进同一组，若不加这道闸，无关成员会篡改
 * 逐位多数、污染最终提交值。
 *
 * 长度分歧时以出现次数最多的长度为准；票数持平则取全局众数长度。
 * 任一位置出现同字母的大小写分歧 → caseAmbiguous（验证码区分大小写，不能替用户猜）。
 */
function buildRepresentative(
  members: CaptchaCandidate[],
  modalLength: number,
  anchor: CaptchaCandidate,
): { code: string; caseAmbiguous: boolean } {
  const anchorFolded = foldForCompare(anchor.code);
  const coherent = members.filter((member) =>
    withinEditDistance1(anchorFolded, foldForCompare(member.code)),
  );

  const lengthCount = new Map<number, number>();
  for (const member of coherent) {
    lengthCount.set(member.code.length, (lengthCount.get(member.code.length) ?? 0) + 1);
  }
  let targetLength = modalLength;
  let targetVotes = -1;
  for (const [len, count] of lengthCount) {
    const takesIt =
      count > targetVotes || (count === targetVotes && len === modalLength);
    if (takesIt) {
      targetLength = len;
      targetVotes = count;
    }
  }

  const lane = coherent.filter((member) => member.code.length === targetLength);
  if (lane.length === 0) {
    return { code: anchor.code, caseAmbiguous: false };
  }

  let code = "";
  let caseAmbiguous = false;
  for (let pos = 0; pos < targetLength; pos++) {
    const exact = new Map<string, number>();
    const folded = new Map<string, number>();
    for (const member of lane) {
      const ch = member.code[pos]!;
      exact.set(ch, (exact.get(ch) ?? 0) + 1);
      const lower = ch.toLowerCase();
      folded.set(lower, (folded.get(lower) ?? 0) + 1);
    }
    let winnerChar = "";
    let winnerExact = -1;
    for (const [ch, count] of exact) {
      if (count > winnerExact) {
        winnerChar = ch;
        winnerExact = count;
      }
    }
    const foldedVotes = folded.get(winnerChar.toLowerCase()) ?? 0;
    if (foldedVotes > winnerExact) caseAmbiguous = true;
    code += winnerChar;
  }
  return { code, caseAmbiguous };
}

/** 把相似读数并成组（编辑距离 ≤1 传递合并）。 */
function groupCandidates(candidates: CaptchaCandidate[]): CaptchaCandidate[][] {
  const folded = candidates.map((candidate) => foldForCompare(candidate.code));
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== root) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (!withinEditDistance1(folded[i]!, folded[j]!)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    }
  }
  const buckets = new Map<number, CaptchaCandidate[]>();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    const bucket = buckets.get(root);
    if (bucket) {
      bucket.push(candidate);
    } else {
      buckets.set(root, [candidate]);
    }
  });
  return [...buckets.values()];
}

/** 全局众数长度：同一道验证码位数固定，长度分布本身就是一条证据。 */
function modalCodeLength(candidates: CaptchaCandidate[]): number {
  const counts = new Map<number, number>();
  for (const candidate of candidates) {
    counts.set(candidate.code.length, (counts.get(candidate.code.length) ?? 0) + 1);
  }
  let bestLength = candidates[0]!.code.length;
  let bestCount = -1;
  for (const [len, count] of counts) {
    if (count > bestCount || (count === bestCount && len > bestLength)) {
      bestLength = len;
      bestCount = count;
    }
  }
  return bestLength;
}

/**
 * 裁决键（从强到弱）：
 *   1) weightSum     —— 加权票数（权重来自逐帧显示时长；无信号时恒等于 votes）
 *   2) exactPairs     —— 原图与变体独立读出逐字符完全相同的码
 *   3) softPairs      —— 字母全同 + 双方自证全部字符，仅大小写分歧
 *   4) selfConfirmed  —— 声称每个字符都独立确认的读数条数（离散计数，难灌水）
 *   5) 独立源帧数
 *   6) 读数条数
 *   7) 长度等于众数长度
 *   8) 可辨字符占比
 * confidence 仅用于组内挑代表与最后兜底，不参与组间排序。
 *
 * 为什么 weightSum 排第一：权重代表「这帧被设计成要你看见」，佐证代表「这条读数自洽」。
 * 模糊诱饵帧也能自洽（原图与去噪图可以把同一坨垃圾读成同一个串），
 * 所以诱饵上的佐证并不构成「这是答案」的证据；两者的可信层级不同。
 * 用**相对**比较（float 安全 epsilon）而不是绝对差值：时长完全一致时权重精确相等，
 * 不会因浮点误差翻转；时长真有差异时才生效。
 */
function compareGroups(a: ConsensusGroup, b: ConsensusGroup, modalLength: number): number {
  const weightGap = b.weightSum - a.weightSum;
  if (Math.abs(weightGap) > 1e-9 * Math.max(1, Math.abs(a.weightSum), Math.abs(b.weightSum))) {
    return weightGap;
  }
  if (b.exactPairs !== a.exactPairs) return b.exactPairs - a.exactPairs;
  if (b.softPairs !== a.softPairs) return b.softPairs - a.softPairs;
  if (b.selfConfirmed !== a.selfConfirmed) return b.selfConfirmed - a.selfConfirmed;
  if (b.sourceFrames.length !== a.sourceFrames.length) {
    return b.sourceFrames.length - a.sourceFrames.length;
  }
  if (b.votes !== a.votes) return b.votes - a.votes;
  const aLen = a.code.length === modalLength ? 1 : 0;
  const bLen = b.code.length === modalLength ? 1 : 0;
  if (bLen !== aLen) return bLen - aLen;
  const lr = legibilityRatio(b.best) - legibilityRatio(a.best);
  if (lr !== 0) return lr;
  return compareCandidateQuality(a.best, b.best);
}

/**
 * 自报分兜底可用的最小领先幅度。
 *
 * 自报分单独不可信（两大事故里错误答案都拿了全场最高分），但在「已通过配对佐证 +
 * 票数」的前提下，若第一名领先第二名达到这个幅度，说明它不只是掷硬币。
 * 0.10 是「10 个百分点」这一档可感知差异，不是拟合出来的数。
 */
const CONFIDENCE_FALLBACK_MARGIN = 0.1;

/**
 * 第一名是否在「可信键」上真正压过第二名。
 *
 * 可信键：真实佐证 → 自证读数 → 独立源帧数 → 读数条数 → 长度等于众数长度 → 可辨字符占比。
 * 这些键全平就只剩被降级的自报分——差值不够大时属于掷硬币，宁可弃权。
 */
function hasDecisiveMargin(
  top: ConsensusGroup,
  runnerUp: ConsensusGroup,
  modalLength: number,
): boolean {
  const weightGap = top.weightSum - runnerUp.weightSum;
  if (Math.abs(weightGap) > 1e-9 * Math.max(1, Math.abs(top.weightSum), Math.abs(runnerUp.weightSum))) {
    return true;
  }
  if (top.exactPairs !== runnerUp.exactPairs) return true;
  if (top.softPairs !== runnerUp.softPairs) return true;
  if (top.selfConfirmed !== runnerUp.selfConfirmed) return true;
  if (top.sourceFrames.length !== runnerUp.sourceFrames.length) return true;
  if (top.votes !== runnerUp.votes) return true;
  if ((top.code.length === modalLength) !== (runnerUp.code.length === modalLength)) return true;
  if (legibilityRatio(top.best) !== legibilityRatio(runnerUp.best)) return true;
  // 浮点比较：0.9 - 0.8 在 IEEE754 下是 0.09999999999999998，直接比会误判为「不够」
  return top.best.confidence - runnerUp.best.confidence >= CONFIDENCE_FALLBACK_MARGIN - 1e-9;
}

export interface CaptureDecision {
  /** 最优候选；仅当整个读码池为空时为 null */
  group: ConsensusGroup | null;
  /** 全部候选组，按证据强度排序（用于日志与 fixture 观测） */
  groups: ConsensusGroup[];
  /**
   * 「证据薄弱」：前两名在全部客观键上并列，只剩已被降级的自我评估分可区分。
   * **仅用于日志与观测，不再改变行为。**
   *
   * 原设计在这里弃权并要求换新验证码，但实测该页点「刷新」后图不变
   * （`unchanged_after_click`），弃权等于 0% 成功率——连续两次运行里，
   * 弃权都被调用方的兜底分支覆盖，净信息产出为 0。
   * 真正的命中率瓶颈是**读数产出率**（输的那轮 16 帧只读出 5 个码），
   * 以及**逐字符证据**，不是「要不要弃权」。
   */
  weak: boolean;
}

/**
 * 共识裁决：分组 → 按证据强度排序 → 永远给出最优候选。
 *
 * 排序键依次为：逐字符佐证 → 大小写次级佐证 → 自证全部字符的读数条数
 * → 独立源帧数 → 读数条数 → 长度等于众数长度 → 可辨字符占比。
 * 自我评估分（confidence）只在上述全平时做最后兜底。
 *
 * 为什么不弃权：见 `CaptureDecision.weak` 的说明。
 */
export function selectCaptureCandidate(memory: CaptchaCandidate[]): CaptureDecision {
  if (memory.length === 0) return { group: null, groups: [], weak: false };

  const modalLength = modalCodeLength(memory);
  const groups = groupCandidates(memory)
    .map((members) => {
      const sorted = [...members].sort(compareCandidateQuality);
      const representative = buildRepresentative(members, modalLength, sorted[0]!);
      const corroboration = countCorroboration(members);
      return {
        code: representative.code,
        votes: members.length,
        sourceFrames: [...new Set(members.map((member) => member.sourceFrame))],
        exactPairs: corroboration.exactPairs,
        softPairs: corroboration.softPairs,
        selfConfirmed: countSelfConfirmed(members),
        best: sorted[0]!,
        caseAmbiguous: representative.caseAmbiguous,
        memberCodes: [...new Set(sorted.map((member) => member.code))],
        weightSum: members.reduce((sum, member) => sum + member.weight, 0),
      } satisfies ConsensusGroup;
    })
    .sort((a, b) => compareGroups(a, b, modalLength));

  const top = groups[0]!;
  const runnerUp = groups[1];
  return {
    group: top,
    groups,
    weak: runnerUp != null && !hasDecisiveMargin(top, runnerUp, modalLength),
  };
}

/**
 * 佐证分级（同一源帧的 ≥2 个变体互相印证的强度）。
 *
 * `exactPairs` —— 逐字符完全相同（含大小写）。最强，无可争议。
 *
 * `softPairs` —— 折叠后字母全同、**且两个变体都自报「每个字符都独立确认」**，仅大小写分歧。
 *   为什么必须承认这一档：大小写摇摆与字母分歧是两回事。
 *   - 字母分歧（`UaRU` vs `UoRU`、`hgas` vs `hga5`）是**真正的识别分歧**，不能当证据；
 *   - 而两个独立预处理变体字母全同、双方都自报逐个确认过、只有大小写不一致，
 *     是模型在大小写规范化上的抖动，不是「看不清」。实测一例 7 源帧：
 *     `9XMY`(自证4) 与 `9xMY`(自证4) 是唯一互相印证的读数，其余三对都是字母分歧；
 *     若把这一档也拒掉，就等于把唯一可信的答案也扔了。
 *   之所以要求「双方自证全部字符」，是因为自报的字符计数是离散量、难以灌水，
 *   而大小写折叠本身是可以被噪声伪造的（事故2 的 `BXEq`/`BxEq` 折叠后相等，
 *   但两次读数都没敢报字符数→自证=0→本档不成立，仍然被拒）。
 */
function countCorroboration(members: CaptchaCandidate[]): {
  exactPairs: number;
  softPairs: number;
} {
  const bySource = new Map<number, CaptchaCandidate[]>();
  for (const member of members) {
    const list = bySource.get(member.sourceFrame);
    if (list) {
      list.push(member);
    } else {
      bySource.set(member.sourceFrame, [member]);
    }
  }

  let exactPairs = 0;
  let softPairs = 0;
  for (const list of bySource.values()) {
    const exactKeys = new Map<string, Set<string>>();
    for (const member of list) {
      const variants = exactKeys.get(member.code);
      if (variants) {
        variants.add(member.variant);
      } else {
        exactKeys.set(member.code, new Set([member.variant]));
      }
    }
    for (const variants of exactKeys.values()) {
      if (variants.size >= 2) exactPairs += 1;
    }

    const foldedKeys = new Map<string, CaptchaCandidate[]>();
    for (const member of list) {
      const key = foldForCompare(member.code);
      const bucket = foldedKeys.get(key);
      if (bucket) {
        bucket.push(member);
      } else {
        foldedKeys.set(key, [member]);
      }
    }
    for (const bucket of foldedKeys.values()) {
      // 已经计入 exactPairs 的不重复计数
      if (new Set(bucket.map((member) => member.code)).size < 2) continue;
      if (new Set(bucket.map((member) => member.variant)).size < 2) continue;
      const bothSelfConfirmed = bucket.every(
        (member) => member.legibility != null && member.legibility >= member.code.length,
      );
      if (bothSelfConfirmed) softPairs += 1;
    }
  }
  return { exactPairs, softPairs };
}

/** 声称「每个字符都独立确认过」的读数条数（模型自报的离散计数，不是感觉分）。 */
function countSelfConfirmed(members: CaptchaCandidate[]): number {
  return members.filter(
    (member) => member.legibility != null && member.legibility >= member.code.length,
  ).length;
}

/** 把裁决结果里的候选组压成一行，供进度日志展示。 */
function describeGroups(groups: ConsensusGroup[], limit = 8): string {
  return groups
    .slice(0, limit)
    .map(
      (group) =>
        `${group.code}×${group.votes}(源帧${group.sourceFrames.length}/佐证${group.exactPairs}/次级${group.softPairs}/自证${group.selfConfirmed})`,
    )
    .join(", ");
}

/**
 * 并发池读码（默认 4 路）→ 入内存 → 共识裁决。
 * 每帧结束后销毁该帧图片并释放池槽，不长期占资源。
 */
async function askVisionPerFrameCode(input: {
  client: VisionClient;
  model: string;
  /** 读码池：同一源帧的多个变体各自独立读，供配对佐证 */
  frames: VisionFrame[];
  logger: JsonLogger;
  pageHint?: string;
  signal?: AbortSignal;
}): Promise<CaptureDecision> {
  const n = input.frames.length;
  const concurrency = Math.min(CAPTCHA_VISION_CONCURRENCY, Math.max(1, n));
  input.logger.agentProgress(
    `验证码识别中…（并发 ${concurrency} · ${n} 帧 · ${input.model}）`,
    {
      phase: "animated_captcha",
      mode: "per_frame_memory_pool",
      frames: n,
      concurrency,
      model: input.model,
    },
  );

  const memory: CaptchaCandidate[] = [];
  const systemPrompt =
    "通用验证码读码。禁止思考过程、禁止解释。" +
    "位数不固定：原样抄写所见字符，禁止假设位数。" +
    "legible = 本帧你能逐个独立确认的字符个数（整数，不是感觉分）：全糊=0，看清 n 个就写 n。" +
    "confidence = 你对「抄写正确」的把握（0~1），与 legible 是两件事。" +
    '可读：{"code":"所见字符","legible":4,"confidence":0.85,"readable":true}；' +
    '看不清：{"code":null,"legible":0,"confidence":0,"readable":false}。' +
    "第一行起只能是一个 JSON。";

  let cursor = 0;
  let fatal: Error | null = null;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (input.signal?.aborted || fatal) {
        throw new Error("Agent 已中止");
      }
      const idx = cursor;
      cursor += 1;
      if (idx >= n) return;

      const frame = input.frames[idx]!;
      try {
        const hit = await readOneCaptchaFrame({
          client: input.client,
          model: input.model,
          frameIndex: idx + 1,
          total: n,
          frame,
          logger: input.logger,
          pageHint: input.pageHint,
          signal: input.signal,
          systemPrompt,
        });
        if (hit) {
          // 自相矛盾：给了码却自报「一个字符都没确认」→ 这条读数是噪点，不进池投票。
          // 解析层已拦一次，这里再拦一次，保证「池里不存在可辨=0 的读数」是硬不变式。
          if (hit.legibility === 0) {
            input.logger.agentProgress(
              `第 ${hit.frameIndex} 帧读数自相矛盾（code=${hit.code} 却自报可辨=0），排除`,
              {
                phase: "animated_captcha",
                stage: "frame_excluded",
                frame: hit.frameIndex,
                code: hit.code,
              },
            );
            continue;
          }
          memory.push(hit);
          input.logger.agentProgress(
            `第 ${hit.frameIndex} 帧(源帧${hit.sourceFrame}/${hit.variant}${hit.weight !== 1 ? `/权重${hit.weight.toFixed(2)}` : ""})入内存：code=${hit.code}（len=${hit.code.length}）` +
              `可辨=${hit.legibility == null ? "?" : hit.legibility} 自报=${hit.confidence.toFixed(2)}(${hit.confidenceSource}) · 内存 ${memory.length} 条`,
            {
              phase: "animated_captcha",
              stage: "memory_push",
              frame: hit.frameIndex,
              sourceFrame: hit.sourceFrame,
              variant: hit.variant,
              weight: hit.weight,
              code: hit.code,
              codeLen: hit.code.length,
              legibility: hit.legibility,
              confidence: hit.confidence,
              confidenceSource: hit.confidenceSource,
              memorySize: memory.length,
            },
          );
        }
      } catch (err) {
        if (
          input.signal?.aborted ||
          (err instanceof Error && /已中止|abort/i.test(err.message))
        ) {
          fatal = err instanceof Error ? err : new Error("Agent 已中止");
          throw fatal;
        }
        const msg = err instanceof Error ? err.message : String(err);
        input.logger.agentProgress(`第 ${idx + 1} 帧异常，排除：${msg.slice(0, 120)}`, {
          phase: "animated_captcha",
          stage: "frame_excluded",
          frame: idx + 1,
        });
        // 异常路径仍尝试毁图（readOne 的 finally 通常已执行；此处兜底）
        destroyFrameImageFiles([frame.path, frame.sourcePngPath]);
      }
    }
  });

  const settled = await Promise.allSettled(workers);
  if (fatal || input.signal?.aborted) {
    // 中止：销毁尚未处理完的残留帧图
    for (const frame of input.frames) {
      destroyFrameImageFiles([frame.path, frame.sourcePngPath]);
    }
    throw new Error("Agent 已中止");
  }
  for (const s of settled) {
    if (s.status === "rejected") {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      if (/已中止|abort/i.test(msg)) throw new Error("Agent 已中止");
    }
  }

  const decision = selectCaptureCandidate(memory);
  if (!decision.group) {
    input.logger.agentProgress("候选内存为空：全部帧均未读出验证码", {
      phase: "animated_captcha",
      stage: "memory_empty",
    });
    return decision;
  }

  const { group, groups } = decision;
  const summary =
    `code=${group.code}（逐字符佐证 ${group.exactPairs} / 大小写次级 ${group.softPairs} / 自证 ${group.selfConfirmed} / 源帧 ${group.sourceFrames.length} 个 / 共 ${group.votes} 条` +
    `${group.caseAmbiguous ? " / 大小写有分歧" : ""}）`;
  input.logger.agentProgress(
    `候选定案：${summary}` +
      (decision.weak ? "（证据薄弱：前两名客观键并列，仅靠自我评估分区分）" : "") +
      (groups.length > 1 ? `；候选 ${describeGroups(groups)}` : ""),
    {
      phase: "animated_captcha",
      stage: "capture_selected",
      weakEvidence: decision.weak,
      code: group.code,
      exactPairs: group.exactPairs,
      softPairs: group.softPairs,
      selfConfirmed: group.selfConfirmed,
      sourceFrames: group.sourceFrames.length,
      votes: group.votes,
      caseAmbiguous: group.caseAmbiguous,
      bestFrame: group.best.frameIndex,
      memorySize: memory.length,
      candidateGroups: groups.slice(0, 8).map((item) => ({
        code: item.code,
        votes: item.votes,
        sourceFrames: item.sourceFrames.length,
        exactPairs: item.exactPairs,
        softPairs: item.softPairs,
        selfConfirmed: item.selfConfirmed,
        weightSum: item.weightSum,
        memberCodes: item.memberCodes,
        legibility: item.best.legibility,
        confidence: item.best.confidence,
      })),
    },
  );

  return decision;
}

export async function checkCaptchaOutcome(page: Page): Promise<{
  verified: boolean | null;
  signal: string;
}> {
  await sleep(900);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    const text = await page.evaluate(() => String(document.body?.innerText || "").slice(0, 4000));
    const { verdict, signal } = classifyCaptchaOutcomeText(text);
    if (verdict === "success") return { verified: true, signal };
    if (verdict === "fail") return { verified: false, signal };
    return { verified: null, signal };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Execution context was destroyed|Target closed|navigat/i.test(msg)) {
      return { verified: null, signal: "nav_or_context_destroyed" };
    }
    throw err;
  }
}

/**
 * 非 GIF 静态验证码图（干扰多）回退：OpenCV 去噪（增强 + 二值化两个变体）→ 放大 →
 * 复用单帧读码池择优。不新增视觉调用路径，优雅降级到原图。
 */
async function solveStaticImageCaptcha(input: {
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  pageHint?: string;
  fileSystem: AgentFileSystem;
  signal?: AbortSignal;
  media: { buf: Buffer; src: string };
  supported: string[];
  formHints: CaptchaFormHints;
  stamp: string;
}): Promise<ImageTextSolveResult> {
  const artifactPaths: string[] = [];

  input.logger.agentProgress("②s 静态验证码图（非 GIF）：OpenCV 去噪后单帧读码…", {
    phase: "animated_captcha",
    stage: "static_denoise",
    src: input.media.src.slice(0, 120),
  });

  // 原图优先 + OpenCV 增强/二值化变体，一起入读码池择优。
  // 原图必须始终在池内（OpenCV 锦上添花，不得替换原图，否则原本能过的静态图反被去噪图带偏）。
  const variants: Buffer[] = [input.media.buf];
  const denoised = await openCvDenoise({
    buf: input.media.buf,
    mode: "text",
    binary: true,
    logger: input.logger,
    signal: input.signal,
  });
  if (denoised) {
    variants.push(denoised.jpeg);
    if (denoised.binary) variants.push(denoised.binary);
  }

  const variantPaths = variants.map((b, i) =>
    input.fileSystem.writeBinaryFile(`captcha_static_${input.stamp}_v${i}.jpg`, b),
  );
  artifactPaths.push(...variantPaths);

  const visionDir = join(input.fileSystem.root, `captcha_static_vision_${input.stamp}`);
  let visionPaths: string[];
  try {
    // OpenCV 变体本就是 JPEG，会原样透传；只有下载来的原图（可能是 PNG/WebP）需要转码。
    // 全部透传时不会创建 visionDir，故按存在与否登记清理项。
    visionPaths = await prepareVisionJpegs(variantPaths, visionDir);
    if (existsSync(visionDir)) artifactPaths.push(visionDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 1,
      formHints: input.formHints,
      strategy: "static_image_read",
      supportedStrategies: input.supported,
      artifactPaths,
      detail: `静态图转码失败: ${msg}`,
    };
  }

  const router = createModelRouter(input.aiSettings);
  if (!isIntentConfigured(router.pool, "vision")) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 1,
      formHints: input.formHints,
      strategy: "static_image_read",
      supportedStrategies: input.supported,
      artifactPaths,
      detail: "视觉模型未配置",
    };
  }

  const { route, client } = router.forIntent("vision", "静态验证码识别");
  try {
    // 静态图无源帧概念：所有变体视为同一源帧的不同读法，正好构成配对佐证。
    const frames: VisionFrame[] = visionPaths.map((path, index) => ({
      path,
      sourcePngPath: variantPaths[index],
      sourceFrame: 1,
      variant: `static_v${index}`,
    }));
    const asked = await askVisionPerFrameCode({
      client: client as unknown as VisionClient,
      model: route.model,
      frames,
      logger: input.logger,
      pageHint: input.pageHint,
      signal: input.signal,
    });
    if (!asked.group) {
      return {
        ok: false,
        code: "",
        frame: 0,
        confidence: 0,
        framesCaptured: 1,
        formHints: input.formHints,
        strategy: "static_image_read",
        supportedStrategies: input.supported,
        artifactPaths,
        detail: "静态图未读出验证码。勿刷新，可再调本工具；满3次 HITL。",
      };
    }
    const group = asked.group;
    return {
      ok: true,
      code: group.code,
      frame: group.best.frameIndex,
      confidence: group.best.confidence,
      framesCaptured: 1,
      formHints: input.formHints,
      strategy: "static_image_read",
      artifactPaths,
      detail: `mode=static_noise frame=${group.best.frameIndex} conf=${group.best.confidence} exact=${group.exactPairs}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (input.signal?.aborted || /已中止|abort/i.test(msg)) {
      throw new Error("Agent 已中止");
    }
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 1,
      formHints: input.formHints,
      strategy: "static_image_read",
      supportedStrategies: input.supported,
      artifactPaths,
      detail: msg,
    };
  }
}

export async function solveImageTextCaptcha(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  selectorMap: Map<number, IndexedElementRef>;
  pageHint?: string;
  goalHint?: string;
  forceStrategy?: string;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
}): Promise<ImageTextSolveResult> {
  if (input.signal?.aborted) {
    throw new Error("Agent 已中止");
  }
  const supported = SUPPORTED_CAPTCHA_STRATEGIES.map((s) => s.id);
  const emptyHints = findCaptchaFormHints(input.selectorMap);

  const pageText = await input.page
    .evaluate(() => String(document.body?.innerText || "").slice(0, 2500))
    .catch(() => "");
  const strategy = detectCaptchaStrategy({
    pageText,
    pageUrl: input.page.url(),
    goalHint: `${input.goalHint ?? ""} ${input.pageHint ?? ""}`,
    forceStrategy: input.forceStrategy,
  });

  // 本函数只负责「读图中字符」族。分发层已按其策略路由到这里，这里再验一次是防御：
  // 直接调用（或 forceStrategy 指向别的族）时不得越界去处理滑块/算式/点选。
  if (strategy !== "image_text_read") {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy: "unsupported",
      supportedStrategies: supported,
      detail:
        "unsupported: 本路径只处理图片字符验证码（静态图 / GIF 动图）。" +
        "滑块 / 算式 / 点选由 solve_captcha 的路由分发处理，请勿用本工具重试别的类型。",
    };
  }

  input.logger.agentProgress("① 类型门禁通过：image_text_read → 取验证码图…", {
    phase: "animated_captcha",
    stage: "fetch_gif",
  });

  const media = await locateAndFetchCaptchaMedia(input.page);
  if (!media) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy: "unsupported",
      supportedStrategies: supported,
      detail: "not_gif: 未定位到验证码图片媒体，本策略不可用。",
    };
  }

  // 非 GIF：可能只是干扰很多的静态图，走 OpenCV 去噪 + 单帧读码回退
  if (!isGifBuffer(media.buf)) {
    if (!input.fileSystem) {
      return {
        ok: false,
        code: "",
        frame: 0,
        confidence: 0,
        framesCaptured: 0,
        formHints: emptyHints,
        strategy: "static_image_read",
        detail: "not_gif: 定位到的验证码媒体不是 GIF，且缺少工作区无法回退静态读码",
      };
    }
    const stampStatic = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    return solveStaticImageCaptcha({
      aiSettings: input.aiSettings,
      logger: input.logger,
      pageHint: input.pageHint,
      fileSystem: input.fileSystem,
      signal: input.signal,
      media,
      supported,
      formHints: findCaptchaFormHints(input.selectorMap),
      stamp: stampStatic,
    });
  }

  if (!input.fileSystem) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy: "gif_animated_dwell",
      detail: "缺少 Agent 工作区，无法落盘 GIF/帧",
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const gifPath = input.fileSystem.writeBinaryFile(`captcha_raw_${stamp}.gif`, media.buf);
  const framesDir = join(input.fileSystem.root, `captcha_frames_${stamp}`);
  mkdirSync(framesDir, { recursive: true });
  const artifactPaths: string[] = [gifPath, framesDir];

  // ②c 解析 GIF 逐帧显示时长 → 每帧相对权重。
  // 「停留时间最长」这类题面说明的是**设计者意图**，但每个验证码都不同：有的全部等长、
  // 有的带编码抖动。所以这里不判断「哪帧是答案」，只输出连续权重，等长时恒为 1（行为不变）。
  const gifMeta = parseGifMeta(media.buf);
  const frameWeights = temporalFrameWeights(gifMeta);
  const temporalSignal = hasTemporalSignal(gifMeta);
  if (temporalSignal) {
    input.logger.agentProgress(
      `②c GIF 逐帧时长 ${gifMeta.frames.map((frame) => frame.delayMs).join("/")}ms → 权重 ` +
        `${frameWeights.map((weight) => weight.toFixed(2)).join("/")}（按权重计票）`,
      {
        phase: "animated_captcha",
        stage: "gif_temporal_weights",
        delays: gifMeta.frames.map((frame) => frame.delayMs),
        weights: frameWeights,
      },
    );
  } else if (gifMeta.frames.length > 0) {
    input.logger.agentProgress(
      `②c GIF 逐帧时长无区分度（${gifMeta.frames[0]?.delayMs ?? 0}ms × ${gifMeta.frames.length}）→ 等权计票`,
      {
        phase: "animated_captcha",
        stage: "gif_temporal_uniform",
        delayMs: gifMeta.frames[0]?.delayMs ?? 0,
        frames: gifMeta.frames.length,
      },
    );
  }

  // 抽样必须早于抽帧：抽帧是一次固定开销约 870 ms 的独立进程，抽全部再丢弃等于把最贵的
  // 部分白付一遍，还要多解码/编码那些会被丢掉的帧。帧数取自纯内存解析的 GIF 元数据，
  // 不依赖抽帧结果。元数据不可用（畸形 GIF）时帧数未知，只能先全量导出再补一次均匀抽样
  // ——宁可多解几帧，也不能因为解析失败而漏帧。
  const knownFrameCount = gifMeta.frames.length;
  const sampledIndexes =
    knownFrameCount > 0
      ? sampleFrameIndexes(
          knownFrameCount,
          MAX_VISION_FRAMES,
          temporalSignal ? frameWeights : undefined,
        )
      : undefined;

  input.logger.agentProgress(
    sampledIndexes
      ? `② 拆帧转 JPEG（导出 ${sampledIndexes.length}/${knownFrameCount} 帧）…`
      : "② 拆帧转 JPEG（帧数未知，全量导出）…",
    {
      phase: "animated_captcha",
      stage: "gif_extract_jpeg",
      gifPath,
      src: media.src.slice(0, 120),
    },
  );

  if (input.signal?.aborted) {
    throw new Error("Agent 已中止");
  }

  let frameImages: GifFrameImage[];
  try {
    frameImages = await extractGifFramesAsJpeg(gifPath, framesDir, sampledIndexes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy: "gif_animated_dwell",
      gifPath,
      detail: msg,
    };
  }

  const formHints = findCaptchaFormHints(input.selectorMap);
  input.logger.agentProgress(`② 已导出 ${frameImages.length} 帧 JPEG（单次 GDI 进程）`, {
    phase: "animated_captcha",
    frames: frameImages.length,
    singleFrame: frameImages.length === 1,
    sourceIndexes: frameImages.map((frame) => frame.sourceIndex),
  });

  // 只有「帧数未知」才可能超限：补一次均匀抽样，并销毁多余的帧
  const sampledFrames =
    frameImages.length > MAX_VISION_FRAMES
      ? sampleFrameIndexes(frameImages.length, MAX_VISION_FRAMES).map((i) => frameImages[i]!)
      : frameImages;
  if (sampledFrames.length < frameImages.length) {
    const keptPaths = new Set(sampledFrames.map((frame) => frame.path));
    const dropped = destroyFrameImageFiles(
      frameImages.filter((frame) => !keptPaths.has(frame.path)).map((frame) => frame.path),
    );
    input.logger.agentProgress(`抽样 ${sampledFrames.length}/${frameImages.length} 帧后送视觉`, {
      phase: "animated_captcha",
      sampled: sampledFrames.length,
      total: frameImages.length,
      dropped,
      weightPrioritized: temporalSignal,
    });
  }

  // 读码池：先原图，后去噪变体。每个条目显式携带「源帧 + 变体」身份，
  // 配对佐证与文件清理都基于显式身份，而不是靠两个数组下标对齐——下标一错则全错。
  const pool: VisionFrame[] = sampledFrames.map((frame) => ({
    path: frame.path,
    sourceFrame: frame.sourceIndex + 1,
    variant: "orig",
    weight: frameWeights[frame.sourceIndex] ?? 1,
  }));
  const framePaths = sampledFrames.map((frame) => frame.path);

  // OpenCV 去噪增强：为每个帧生成去噪变体并入读码池，让视觉在「原帧 vs 去噪帧」间择优。
  // 雾/糊/噪点重的 GIF 上去噪帧更易读码；彩色清晰帧仍保留原样，不会丢失信息。
  try {
    const denoisedFrames: VisionFrame[] = [];
    for (const frame of sampledFrames) {
      if (input.signal?.aborted) break;
      const denoised = await openCvDenoise({
        buf: readFileSync(frame.path),
        mode: "text",
        logger: input.logger,
        signal: input.signal,
      });
      if (!denoised) continue;
      // 按源帧下标命名：去噪变体与源帧同号，配对佐证直接用这个身份对齐
      const out = join(framesDir, `denoised_${String(frame.sourceIndex).padStart(4, "0")}.jpg`);
      writeFileSync(out, denoised.jpeg);
      denoisedFrames.push({
        path: out,
        sourceFrame: frame.sourceIndex + 1,
        variant: "denoise",
        weight: frameWeights[frame.sourceIndex] ?? 1,
      });
      artifactPaths.push(out);
    }
    if (denoisedFrames.length > 0) {
      pool.push(...denoisedFrames);
      input.logger.agentProgress(`已生成去噪帧变体 ${denoisedFrames.length} 个并入读码池`, {
        phase: "animated_captcha",
        stage: "opencv_denoise_frames",
        n: denoisedFrames.length,
      });
    }
  } catch (err) {
    input.logger.debug("opencv_gif_denoise_fail", {
      reason: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    });
  }

  const router = createModelRouter(input.aiSettings);
  if (!isIntentConfigured(router.pool, "vision")) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: framePaths.length,
      formHints,
      strategy: "gif_animated_dwell",
      gifPath,
      framePaths,
      detail: "视觉模型未配置",
    };
  }

  const { route, client } = router.forIntent("vision", "GIF验证码识别");
  try {
    const asked = await askVisionPerFrameCode({
      client: client as unknown as VisionClient,
      model: route.model,
      frames: pool,
      logger: input.logger,
      pageHint: input.pageHint,
      signal: input.signal,
    });
    if (!asked.group) {
      return {
        ok: false,
        code: "",
        frame: 0,
        confidence: 0,
        framesCaptured: framePaths.length,
        formHints,
        strategy: "gif_animated_dwell",
        gifPath,
        framePaths,
        artifactPaths,
        detail:
          "候选内存为空：全部帧均未读出验证码。勿刷新，可再调本工具；满3次 HITL。",
      };
    }
    const group = asked.group;
    return {
      ok: true,
      code: group.code,
      frame: group.best.frameIndex,
      confidence: group.best.confidence,
      framesCaptured: framePaths.length,
      formHints,
      strategy: "gif_animated_dwell",
      gifPath,
      framePaths,
      artifactPaths,
      detail:
        `mode=per_frame_code frame=${group.best.frameIndex} conf=${group.best.confidence} ` +
        `exact=${group.exactPairs} soft=${group.softPairs} self=${group.selfConfirmed} ` +
        `sources=${group.sourceFrames.length} votes=${group.votes}` +
        `${group.caseAmbiguous ? " case_ambiguous" : ""}` +
        `${asked.weak ? " weak_evidence" : ""}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (input.signal?.aborted || /已中止|abort/i.test(msg)) {
      throw new Error("Agent 已中止");
    }
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: framePaths.length,
      formHints,
      strategy: "gif_animated_dwell",
      gifPath,
      framePaths,
      artifactPaths,
      detail: msg,
    };
  }
}
