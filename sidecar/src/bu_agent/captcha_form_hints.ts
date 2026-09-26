/**
 * 验证码表单索引：从 selectorMap（与 browser_state [index] 同源）解析输入框/提交按钮。
 * 文本优先匹配，不因 tag/role 过严而漏掉「验证答案（我可以点击！！！）」一类 link。
 */
import type { IndexedElementRef } from "./views.js";

export type CaptchaFormHints = {
  inputIndex: number | null;
  submitIndex: number | null;
  inputLabel: string;
  submitLabel: string;
};

function blobOf(el: IndexedElementRef): string {
  return [el.text, el.placeholder, el.name, el.role, el.tagName, el.inputType ?? ""]
    .filter(Boolean)
    .join(" ");
}

function isInputish(el: IndexedElementRef): boolean {
  return (
    el.tagName === "input" ||
    el.tagName === "textarea" ||
    /textbox|input|searchbox/i.test(el.role ?? "") ||
    el.inputType === "text" ||
    el.inputType === "number" ||
    el.inputType === "search"
  );
}

/**
 * 提交动作的**动词**文案。
 *
 * 关键：`验证` 是动词，`验证码` 是名词。上一版用 /提交|确定|验证/ 直接把
 * 「验证码」这个名词也算成了提交动作，于是**验证码图自己**（text/alt/name 常为
 * 「验证码」）被当成提交按钮，点「提交」实际点在了验证码图上——验证码被刷新、
 * 输入框被清空，表现为「填了却什么都没发生」。名词必须先排除，再谈动作。
 */
const SUBMIT_ACTION_RE = /提交|递交|确定|确认|校验|验证答案|submit|confirm|check\s*answer/i;
/** 含这些词说明是验证码本体/标签，不是提交控件。 */
const CAPTCHA_NOUN_RE = /验证码|captcha|图形码|校验码|看不清|换一张|点击更换/i;
/** 点了会出事的控件：上传参赛代码、登录注册、退出等，绝不能当验证码提交。 */
const DANGEROUS_SUBMIT_RE = /提交参赛|参赛代码|上传|登录|注册|退出|注销|upload|login|sign\s*in|sign\s*up|logout/i;
/** 非交互元素：验证码图几乎总是其中之一，永远不能作为点击目标。 */
const NON_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "img",
  "picture",
  "canvas",
  "svg",
  "iframe",
  "video",
  "audio",
]);

function looksLikeSubmitAction(blob: string): boolean {
  if (isNonSubmitLabel(blob)) return false;
  return SUBMIT_ACTION_RE.test(blob);
}

/** 该文案是否明确指向「不是提交」的东西（验证码本体 / 上传 / 登录）。 */
function isNonSubmitLabel(blob: string): boolean {
  return CAPTCHA_NOUN_RE.test(blob) || DANGEROUS_SUBMIT_RE.test(blob);
}

function isNonInteractive(el: IndexedElementRef): boolean {
  const tag = String(el.tagName ?? "").toLowerCase();
  if (NON_INTERACTIVE_TAGS.has(tag)) return true;
  // 文件上传/图片按钮：点它要么弹文件框，要么提交图片，绝不是验证码提交
  const type = String(el.inputType ?? "").toLowerCase();
  return type === "file" || type === "image";
}

/** 可点控件：必须是真正可交互的元素，且文案是「动作」而非「验证码」这类名词 */
function isClickableSubmitCandidate(el: IndexedElementRef, blob: string): boolean {
  if (isNonInteractive(el)) return false;
  if (isNonSubmitLabel(blob)) return false;
  if (
    el.tagName === "button" ||
    el.tagName === "a" ||
    /button|link|submit/i.test(el.role ?? "")
  ) {
    return true;
  }
  // 文案已写明「验证答案」时，即使是 div/span 也视为可点（挑战站常见）
  if (/验证答案/i.test(blob)) return true;
  return false;
}

/**
 * @param mode math：优先「验证答案」；image_text：验证码输入 + 提交/验证
 *   （image_text 覆盖静态图与动图——两者在表单结构上无区别，只有取帧方式不同）
 */
export function findCaptchaFormHints(
  selectorMap: Map<number, IndexedElementRef>,
  mode: "math" | "image_text" = "image_text",
): CaptchaFormHints {
  let inputIndex: number | null = null;
  let submitIndex: number | null = null;
  let inputLabel = "";
  let submitLabel = "";

  // 1) 提交：文本「验证答案」绝对优先（不依赖 buttonish）
  for (const [idx, el] of selectorMap) {
    const blob = blobOf(el);
    if (/验证答案/i.test(blob) && !/提交参赛/i.test(blob) && isClickableSubmitCandidate(el, blob)) {
      submitIndex = idx;
      submitLabel = blob;
      break;
    }
  }

  // 2) 回退：动作动词（排除验证码名词 / 上传 / 登录）
  if (submitIndex == null) {
    for (const [idx, el] of selectorMap) {
      const blob = blobOf(el);
      if (!isClickableSubmitCandidate(el, blob)) continue;
      if (mode === "math") {
        if (/验证|verify|check\s*answer/i.test(blob) && /答案|answer|结果|result/i.test(blob)) {
          submitIndex = idx;
          submitLabel = blob;
          break;
        }
      } else if (looksLikeSubmitAction(blob)) {
        submitIndex = idx;
        submitLabel = blob;
        break;
      }
    }
  }

  // 3) 输入框
  const inputRe =
    mode === "math"
      ? /计算|结果|答案|answer|result|math|验证码|captcha/i
      : /验证码|captcha|code|校验/i;

  for (const [idx, el] of selectorMap) {
    if (!isInputish(el)) continue;
    if (el.inputType === "hidden" || el.inputType === "password") continue;
    const blob = blobOf(el);
    if (mode === "image_text" && /短信|邮箱|otp|totp/i.test(blob)) continue;
    if (inputRe.test(blob)) {
      inputIndex = idx;
      inputLabel = blob;
      break;
    }
  }
  if (inputIndex == null) {
    // 兜底：仅当页面只有一个可见文本输入框时才敢用，避免把搜索框/用户名当验证码框填错。
    const candidates: Array<{ index: number; el: IndexedElementRef }> = [];
    for (const [idx, el] of selectorMap) {
      if (!isInputish(el)) continue;
      if (el.inputType === "hidden" || el.inputType === "password") continue;
      if (mode === "image_text" && /短信|邮箱|otp|totp/i.test(blobOf(el))) continue;
      candidates.push({ index: idx, el });
      if (candidates.length > 1) break;
    }
    if (candidates.length === 1) {
      const { index, el } = candidates[0]!;
      inputIndex = index;
      inputLabel = el.placeholder || el.name || el.tagName;
    }
  }

  // 4) 提交仍空：首个真正的 button（勿抢上传/参赛/登录）
  if (submitIndex == null) {
    for (const [idx, el] of selectorMap) {
      const blob = blobOf(el);
      if (!isClickableSubmitCandidate(el, blob)) continue;
      if (el.tagName === "button" || /button|submit/i.test(el.role ?? "")) {
        submitIndex = idx;
        submitLabel = blob || el.tagName;
        break;
      }
    }
  }

  return { inputIndex, submitIndex, inputLabel, submitLabel };
}
/** 在 selectorMap 中按文案找可点 index（供 nudge / input 回执） */
export function findIndexByTextHint(
  selectorMap: Map<number, IndexedElementRef>,
  pattern: RegExp,
  exclude?: RegExp,
): { index: number; label: string } | null {
  for (const [idx, el] of selectorMap) {
    const blob = blobOf(el);
    if (exclude && exclude.test(blob)) continue;
    if (pattern.test(blob) && isClickableSubmitCandidate(el, blob)) {
      return { index: idx, label: (el.text || blob).slice(0, 80) };
    }
  }
  return null;
}

export function formatFormHintFallback(hints: CaptchaFormHints): string {
  const parts: string[] = [];
  if (hints.inputIndex != null) parts.push(`输入框 index=${hints.inputIndex}`);
  if (hints.submitIndex != null) {
    parts.push(
      `验证/提交 index=${hints.submitIndex}` +
        (hints.submitLabel ? `「${hints.submitLabel.slice(0, 40)}」` : ""),
    );
  }
  if (parts.length === 0) return "";
  return (
    `browser_state 已有：${parts.join("；")}。` +
    `若已能心算答案，下一轮 multi_act：input(答案) + click(提交 index)；禁止空等；勿再死磕同一读图。`
  );
}
