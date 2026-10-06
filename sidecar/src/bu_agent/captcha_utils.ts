/**
 * 验证码求解器公共工具（sleep / destroyPaths / extractVisionMessageText / 组件就绪等待）。
 *
 * 此前 animated_captcha / slider_captcha / math_image_captcha / point_select
 * 各自重复了这些实现，且 destroyPaths 行为不一致（unlinkSync vs rmSync 递归 vs 非递归）、
 * extractVisionMessageText 签名不一致（对象 vs string）。本模块统一为最通用实现，
 * 保持各调用点语义不变。
 */
import { existsSync, rmSync } from "node:fs";

import type { Page } from "playwright-core";

/** Promise 化的延时 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 批量销毁产物路径（文件或目录）。
 * 统一用 rmSync(recursive, force)：对单文件安全，对目录递归删除。
 * 返回成功删除的数量。
 */
export function destroyPaths(paths: string[]): number {
  let n = 0;
  for (const p of paths) {
    const t = String(p ?? "").trim();
    if (!t || !existsSync(t)) continue;
    try {
      rmSync(t, { recursive: true, force: true });
      n += 1;
    } catch {
      /* ignore */
    }
  }
  return n;
}

/** 验证码页内文案的裁决结果 */
export type CaptchaTextVerdict = "success" | "fail" | "unknown";

const SUCCESS_TEXT_RE =
  /验证成功|校验通过|通过验证|正确答案|提交成功|恭喜|\baccepted\b|\bcorrect\b/i;
/**
 * 失败分两档，避免「题面说明里的裸失败字眼」被当判据：
 * - 强证据：本身即裁决语义（验证失败/输入错误/wrong/invalid…），不受行长限制；
 * - 弱证据：裸「错误/失败/重试」，仅在短句里才算裁决（长句多为操作说明）。
 */
const STRONG_FAILURE_TEXT_RE =
  /验证失败|校验失败|验证码错误|答案错误|输入错误|不正确|\bwrong\b|\bincorrect\b|\bfailed\b|\binvalid\b/i;
const WEAK_FAILURE_TEXT_RE = /错误|失败|再试|重新|重试/;
/** 讲接口怎么返回的教学行：不代表页内真的通过（如「例如返回 {"success":true}」）。 */
const TEACHING_LINE_RE =
  /请使用协议通过|不会在图像识别|接口返回|返回\s*["'{]*\s*\{?\s*success|示例|例如/i;
/** 题面本身提到 success 文案的挑战页，禁止据此判定通过。 */
export const CAPTCHA_CHALLENGE_COPY_RE =
  /请使用协议通过|不会在图像识别|返回\s*["'{]*\s*\{?\s*success|滑块缺口之涟漪/i;
const JSON_SUCCESS_RE = /"success"\s*:\s*true|success\s*[:=：]\s*true/i;
/** 弱证据文案通常短小独立；长句多为题目/说明，不作判据。 */
const VERDICT_MAX_LINE_LEN = 24;
/**
 * 操作说明句：含「将…对齐 / 可重试 / 过程中」等结构的多半是题面提示，
 * 而非裁决结果；裸「失败」出现在这种句子里不得判失败。
 */
const INSTRUCTION_LINE_RE = /将.{0,6}(对齐|拖到|滑到)|可重试|重试按钮|过程中|操作步骤/;

function isVerdictSegment(segment: string): boolean {
  return (
    segment.length <= VERDICT_MAX_LINE_LEN &&
    !/^(请|若|如果|说明|注意|例如|示例)/.test(segment)
  );
}

/**
 * 统一的验证码结果文案裁决（GIF / 滑块 / 点选共用，避免各策略各写一套正则）。
 *
 * 先剔除教学行与操作说明行，再按「句」而非整页匹配：裸「失败/错误」不再触发误判，
 * 单行整页站点也能正常切句。失败优先——拖错后页内常残留旧的成功文案。
 */
export function classifyCaptchaOutcomeText(raw: string): {
  verdict: CaptchaTextVerdict;
  signal: string;
} {
  const text = String(raw ?? "").slice(0, 5000);
  const nonTeaching = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !TEACHING_LINE_RE.test(line));

  const joined = nonTeaching.join("\n");
  const strongFail = joined.match(STRONG_FAILURE_TEXT_RE);
  if (strongFail) return { verdict: "fail", signal: strongFail[0] };

  const weakFail = nonTeaching
    .filter((line) => isVerdictSegment(line) && !INSTRUCTION_LINE_RE.test(line))
    .join("\n")
    .match(WEAK_FAILURE_TEXT_RE);
  if (weakFail) return { verdict: "fail", signal: weakFail[0] };

  const ok = joined.match(SUCCESS_TEXT_RE);
  if (ok) return { verdict: "success", signal: ok[0] };
  // 页面直接回显 JSON 成功体；题面教学句不采信
  if (!CAPTCHA_CHALLENGE_COPY_RE.test(text) && JSON_SUCCESS_RE.test(joined)) {
    return { verdict: "success", signal: "success:true" };
  }
  return { verdict: "unknown", signal: "no_clear_signal" };
}

/**
 * 从 OpenAI 兼容响应里抠文本（含 glm 偶发空 content / reasoning）。
 * 统一返回 { text, finishReason }；调用方按需取 .text。
 */
export function extractVisionMessageText(resp: {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      refusal?: unknown;
    } | null;
    finish_reason?: string | null;
  }>;
}): { text: string; finishReason: string } {
  const choice = resp.choices?.[0];
  const msg = choice?.message;
  const finishReason = String(choice?.finish_reason ?? "");
  if (!msg) return { text: "", finishReason };
  const c = msg.content;
  if (typeof c === "string" && c.trim()) return { text: c.trim(), finishReason };
  if (Array.isArray(c)) {
    const joined = c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const o = p as Record<string, unknown>;
          return String(o.text ?? o.content ?? "");
        }
        return "";
      })
      .join("")
      .trim();
    if (joined) return { text: joined, finishReason };
  }
  const reasoning = msg.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) {
    return { text: reasoning.trim(), finishReason };
  }
  const refusal = msg.refusal;
  if (typeof refusal === "string" && refusal.trim()) {
    return { text: refusal.trim(), finishReason };
  }
  return { text: "", finishReason };
}

/**
 * 界面已进入「请完成验证」但验证组件尚未渲染，是本仓库线上踩过的坑：
 * 题面/骨架先出现，Arkose / reCAPTCHA 这类 iframe 与按钮要等几秒才注入。
 * 此时立刻求解，各策略都会「找不到目标」→ 连续失败 → 误触 HITL。
 *
 * 判定「组件是否已渲染」一律用**结构**证据（可见的验证容器 / 框架 / 图片），
 * 不依赖站点文案。
 */
export const CAPTCHA_WIDGET_WAIT_MS = 30_000;

/** 页内探测：是否存在**可见**的验证码组件（自包含，可被序列化进页面执行）。 */
export function captchaWidgetProbe(): boolean {
  const visible = (el: Element): boolean => {
    let r: DOMRect;
    try {
      r = el.getBoundingClientRect();
    } catch {
      return false;
    }
    if (r.width < 16 || r.height < 12) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.visibility === "collapse") {
      return false;
    }
    if (Number(st.opacity || "1") <= 0.05) return false;
    return true;
  };

  const selectors = [
    "#arkose",
    "#fc-iframe",
    "#captcha",
    "#captchaImg",
    "#verifyImg",
    "iframe[src*='arkose']",
    "iframe[src*='funcaptcha']",
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='turnstile']",
    "iframe[src*='captcha']",
    "iframe[src*='challenge']",
    "iframe[id*='captcha']",
    "iframe[id*='arkose']",
    "iframe[id*='fc-']",
    "iframe[name*='captcha']",
    "[class*='captcha']",
    "[id*='captcha']",
    "[class*='geetest']",
    "[class*='turnstile']",
    "[class*='hcaptcha']",
    "[class*='recaptcha']",
    "[class*='arkose']",
    "[class*='funcaptcha']",
    "[class*='slider-verify']",
    "[class*='verify-slider']",
    "[class*='verify-img']",
    "[class*='verifyimg']",
    "img[src*='captcha']",
    "img[src*='verify']",
    "img[alt*='captcha']",
    "img[alt*='验证']",
    "img[alt*='驗證']",
  ];

  for (const sel of selectors) {
    let list: Element[];
    try {
      list = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of list) {
      if (visible(el)) return true;
    }
  }
  return false;
}

/** 页面上此刻是否存在可见的验证组件。 */
export async function hasVisibleCaptchaWidget(page: Page): Promise<boolean> {
  return page.evaluate(captchaWidgetProbe).catch(() => true); // 读不到就不敢声称「没有」→ 不等待
}

/**
 * 轮询等待验证组件渲染出来（组件一出现立即返回，不必等满）。
 * 注意：只应在「此刻看不到任何组件」时调用，否则纯属浪费。
 */
export async function waitForCaptchaWidget(
  page: Page,
  opts: {
    timeoutMs: number;
    pollMs?: number;
    signal?: AbortSignal;
    /** 每约 5s 回调一次，供上层写进度日志 */
    onTick?: (elapsedMs: number) => void;
  },
): Promise<{ ready: boolean; waitedMs: number }> {
  const pollMs = Math.max(200, opts.pollMs ?? 1000);
  const started = Date.now();
  let nextTickAt = 5000;

  for (;;) {
    if (opts.signal?.aborted) throw new Error("Agent 已中止");
    if (await hasVisibleCaptchaWidget(page)) {
      return { ready: true, waitedMs: Date.now() - started };
    }
    const elapsed = Date.now() - started;
    if (elapsed >= opts.timeoutMs) return { ready: false, waitedMs: elapsed };
    if (opts.onTick && elapsed >= nextTickAt) {
      opts.onTick(elapsed);
      nextTickAt += 5000;
    }
    await sleep(Math.min(pollMs, Math.max(50, opts.timeoutMs - elapsed)));
  }
}
