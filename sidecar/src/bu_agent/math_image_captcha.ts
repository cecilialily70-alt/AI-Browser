/**
 * 静态算式图验证码（策略 math_image_solve）
 * 门禁 → 定位图 → 视觉读表达式 → 白名单求值 → 填入 → 点「验证答案」→ 验收 → 毁图
 */
import type { Page } from "playwright-core";

import type { SidecarAiSettings } from "../engine.js";
import {
  createModelRouter,
  isIntentConfigured,
} from "../ai_model_router.js";
import type { JsonLogger } from "../json-logger.js";
import {
  findCaptchaFormHints,
  formatFormHintFallback,
  type CaptchaFormHints,
} from "./captcha_form_hints.js";
import type { AgentFileSystem } from "./filesystem.js";
import {
  encodeBytesToJpegOnPage,
  fetchImageBuffer,
  freezePageForCapture,
  unfreezePageForCapture,
  waitCaptureSettle,
} from "./point_select/silent_capture.js";
import { openCvDenoise } from "./opencv_preprocess.js";
import { captureScreenshot } from "../core/safe_screenshot.js";
import { sleep, destroyPaths, extractVisionMessageText } from "./captcha_utils.js";
import type { IndexedElementRef } from "./views.js";

export type MathCaptchaStrategyId = "math_image_solve";

export type MathFormHints = CaptchaFormHints;

export type MathSolveResult = {
  ok: boolean;
  strategy: MathCaptchaStrategyId | "unsupported";
  expr: string;
  answer: string;
  confidence: number;
  method: string;
  formHints: MathFormHints;
  artifactPaths: string[];
  detail: string;
};

/** 得数幻觉：模型把计算结果当成算式。合法算式须含运算符或 trig，禁止纯数字。 */
export function isAnswerOnlyExpr(expr: string): boolean {
  const s = String(expr ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/×/g, "*")
    .replace(/÷/g, "/");
  if (!s) return true;
  if (/^(?:sin|cos|tan)\(/i.test(s)) return false;
  if (/[+\-*/()!]/.test(s)) return false;
  return /^-?\d+(?:\.\d+)?$/.test(s);
}

/** 规范化视觉读出的算式（拒绝得数；求值失败则丢弃） */
export function normalizeVisionExpr(raw: string): string | null {
  let expr = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/＊/g, "*")
    .replace(/／/g, "/")
    .replace(/[＝=].*$/, "")
    .replace(/[？?].*$/, "");
  if (!expr) return null;
  if (isAnswerOnlyExpr(expr)) return null;
  const trial = safeEvalMath(expr);
  if (!trial.ok) return null;
  return trial.expr;
}

/** 格式化数值答案：接近整数则整数，否则去尾零 */
export function formatMathAnswer(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) < 1e-12) return "0";
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) < 1e-9) return String(rounded);
  let s = n.toFixed(8).replace(/\.?0+$/, "");
  if (s === "-0") s = "0";
  return s;
}

/**
 * 白名单数学求值：四则、括号、阶乘 !、sin/cos/tan。
 * 三角默认角度制（题面多为 °），但参数含 pi 常量时按弧度计算，
 * 避免 `sin(pi/2)` 被当成 1.57° 算出 0.027。
 * 禁止任意 JS eval / 赋值 / 未知标识符。
 */
export function safeEvalMath(
  raw: string,
): { ok: true; value: string; numeric: number; expr: string } | { ok: false; reason: string } {
  let s = String(raw ?? "")
    .trim()
    .replace(/＝/g, "=")
    .replace(/[？?].*$/u, "")
    .replace(/=\s*$/u, "")
    .replace(/\s+/g, "");
  if (!s) return { ok: false, reason: "empty_expr" };

  s = s
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/＊/g, "*")
    .replace(/／/g, "/")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/［/g, "(")
    .replace(/］/g, ")")
    .replace(/π/gi, "PI");

  // 全角数字
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));

  if (s.length > 96) return { ok: false, reason: "expr_too_long" };
  if (!/^[\d.+\-*/()!°,a-zA-Z]+$/.test(s)) {
    return { ok: false, reason: "illegal_chars" };
  }

  type Tok =
    | { t: "num"; v: number; deg?: boolean }
    | { t: "op"; v: string }
    | { t: "lp" }
    | { t: "rp" }
    | { t: "bang" }
    | { t: "fn"; v: "sin" | "cos" | "tan" }
    | { t: "const"; v: number };

  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "(") {
      toks.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rp" });
      i++;
      continue;
    }
    if (c === "!") {
      toks.push({ t: "bang" });
      i++;
      continue;
    }
    if ("+-*/".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "°") {
      return { ok: false, reason: "orphan_degree" };
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
      const numStr = s.slice(i, j);
      let deg = false;
      if (s[j] === "°") {
        deg = true;
        j++;
      }
      if ((numStr.match(/\./g) || []).length > 1) {
        return { ok: false, reason: "bad_number" };
      }
      const v = Number(numStr);
      if (!Number.isFinite(v)) return { ok: false, reason: "bad_number" };
      toks.push(deg ? { t: "num", v, deg: true } : { t: "num", v });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z]/.test(s[j]!)) j++;
      const name = s.slice(i, j).toLowerCase();
      if (name === "pi") {
        toks.push({ t: "const", v: Math.PI });
        i = j;
        continue;
      }
      if (name === "sin" || name === "cos" || name === "tan") {
        toks.push({ t: "fn", v: name });
        i = j;
        continue;
      }
      return { ok: false, reason: `unknown_id:${name}` };
    }
    return { ok: false, reason: `bad_char:${c}` };
  }

  const fact = (n: number): number => {
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 20) {
      throw new Error("bad_factorial");
    }
    let r = 1;
    for (let k = 2; k <= n; k++) r *= k;
    return r;
  };

  // 三角参数单位判定：解析参数时记录是否出现 pi 常量 / ° 标记。
  let argSawPi = false;
  let argSawDegree = false;

  // 带 ° 的数字必须落在某个 trig 调用参数内（禁止裸 180°）
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k]!;
    if (tk.t !== "num" || !tk.deg) continue;
    let depth = 0;
    let insideTrig = false;
    for (let p = k - 1; p >= 0; p--) {
      const prev = toks[p]!;
      if (prev.t === "rp") depth++;
      else if (prev.t === "lp") {
        if (depth === 0) {
          insideTrig = toks[p - 1]?.t === "fn";
          break;
        }
        depth--;
      }
    }
    if (!insideTrig) return { ok: false, reason: "degree_outside_trig" };
  }

  let pos = 0;
  const peek = () => toks[pos];
  const take = () => toks[pos++];

  function parseExpr(): number {
    let left = parseTerm();
    while (peek()?.t === "op" && (peek() as { v: string }).v && "+-".includes((peek() as { v: string }).v)) {
      const op = (take() as { v: string }).v;
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseUnary();
    while (peek()?.t === "op" && (peek() as { v: string }).v && "*/".includes((peek() as { v: string }).v)) {
      const op = (take() as { v: string }).v;
      const right = parseUnary();
      if (op === "/") {
        if (Math.abs(right) < 1e-15) throw new Error("div_zero");
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }

  function parseUnary(): number {
    if (peek()?.t === "op" && ((peek() as { v: string }).v === "+" || (peek() as { v: string }).v === "-")) {
      const op = (take() as { v: string }).v;
      const v = parseUnary();
      return op === "-" ? -v : v;
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = peek();
    if (!t) throw new Error("unexpected_eof");
    let v: number;
    if (t.t === "fn") {
      take();
      if (peek()?.t !== "lp") throw new Error("fn_need_paren");
      take();
      // 保存/恢复外层标志：嵌套调用（如 sin(cos(30))）的单位判定必须各自独立。
      const savedPi = argSawPi;
      const savedDegree = argSawDegree;
      argSawPi = false;
      argSawDegree = false;
      const arg = parseExpr();
      const usedPi = argSawPi;
      const usedDegree = argSawDegree;
      argSawPi = savedPi;
      argSawDegree = savedDegree;
      if (peek()?.t !== "rp") throw new Error("fn_need_rp");
      take();
      // 有 pi 常量且未显式标 °：按弧度；否则沿用角度制（题面默认）。
      const rad = usedPi && !usedDegree ? arg : (arg * Math.PI) / 180;
      if (t.v === "sin") v = Math.sin(rad);
      else if (t.v === "cos") v = Math.cos(rad);
      else {
        const c = Math.cos(rad);
        if (Math.abs(c) < 1e-12) throw new Error("tan_undefined");
        v = Math.sin(rad) / c;
      }
    } else if (t.t === "lp") {
      take();
      v = parseExpr();
      if (peek()?.t !== "rp") throw new Error("need_rp");
      take();
    } else if (t.t === "num" || t.t === "const") {
      take();
      v = t.v;
      if (t.t === "const") argSawPi = true;
      else if (t.deg) argSawDegree = true;
    } else {
      throw new Error("bad_primary");
    }
    while (peek()?.t === "bang") {
      take();
      v = fact(v);
    }
    return v;
  }

  try {
    const numeric = parseExpr();
    if (pos !== toks.length) return { ok: false, reason: "trailing_tokens" };
    if (!Number.isFinite(numeric)) return { ok: false, reason: "non_finite" };
    return { ok: true, value: formatMathAnswer(numeric), numeric, expr: s };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.slice(0, 48) };
  }
}

/** 优先「验证答案」，排除「提交参赛代码」；与 browser_state [index] 同源 */
export function findMathCaptchaFormHints(
  selectorMap: Map<number, IndexedElementRef>,
): MathFormHints {
  return findCaptchaFormHints(selectorMap, "math");
}

async function locateMathImage(page: Page): Promise<{
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
} | null> {
  return page.evaluate(() => {
    const ATTR = "data-cf-math-captcha";
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));

    const verifyEl = Array.from(document.querySelectorAll("a,button,[role='button']")).find((e) =>
      /验证答案/i.test(e.textContent || ""),
    );
    const inputEl = Array.from(document.querySelectorAll("input")).find((e) => {
      const t = (e as HTMLInputElement).type || "text";
      return t === "text" || t === "number" || t === "search" || t === "";
    });
    const hintEl = Array.from(document.querySelectorAll("p,div,span,label,li")).find((e) => {
      const tx = (e.textContent || "").trim();
      return tx.length > 4 && tx.length < 120 && /输入计算|计算的结果|验证答案/i.test(tx);
    });
    const vr = verifyEl?.getBoundingClientRect();
    const ir = inputEl?.getBoundingClientRect();
    const hr = hintEl?.getBoundingClientRect();
    const anchorTop = Math.min(
      vr?.top ?? Infinity,
      ir?.top ?? Infinity,
      hr?.top ?? Infinity,
    );
    const anchorCx =
      (ir ? ir.left + ir.width / 2 : null) ??
      (vr ? vr.left + vr.width / 2 : null) ??
      (hr ? hr.left + hr.width / 2 : null);

    type Cand = {
      el: HTMLElement;
      x: number;
      y: number;
      w: number;
      h: number;
      src: string;
      area: number;
      above: boolean;
      score: number;
    };
    const medias = Array.from(document.querySelectorAll("img,canvas")) as HTMLElement[];
    const cands: Cand[] = [];

    for (const el of medias) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;

      const src =
        el instanceof HTMLImageElement
          ? String(el.currentSrc || el.src || "").trim()
          : "canvas";
      if (!src) continue;
      if (/\.gif(\?|$)/i.test(src) || src.startsWith("data:image/gif")) continue;

      const above =
        Number.isFinite(anchorTop) && r.bottom <= (anchorTop as number) + 24;
      cands.push({
        el,
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        src: src.slice(0, 240),
        area: r.width * r.height,
        above,
        score: 0,
      });
    }

    if (cands.length === 0) return null;

    // 相对尺度：相对「表单上方候选」最大面积；打压装饰条（如 154×50）
    const aboveAreas = cands.filter((c) => c.above).map((c) => c.area);
    const peerMax = Math.max(
      0,
      ...(aboveAreas.length ? aboveAreas : cands.map((c) => c.area)),
    );

    for (const c of cands) {
      const alt =
        c.el instanceof HTMLImageElement
          ? `${c.el.alt || ""} ${c.el.className || ""} ${c.el.id || ""} ${c.src}`
          : `${c.el.className || ""} ${c.el.id || ""}`;

      let score = Math.log2(Math.max(2, c.area)) * 3;
      if (/captcha|verify|math|calc|yanzheng|验证|算式|题目|match|topic/i.test(alt)) {
        score += 50;
      }
      if (c.above) {
        const gap = Math.max(0, (anchorTop as number) - (c.y + c.h));
        score += 90;
        score += Math.max(0, 40 - gap / 10);
      } else if (Number.isFinite(anchorTop)) {
        score -= 70;
      }
      if (anchorCx != null) {
        const cx = c.x + c.w / 2;
        score += Math.max(0, 30 - Math.abs(cx - anchorCx) / 20);
      }
      // 相对惩罚：远小于同区最大图 → 装饰/图标
      if (peerMax > 0 && c.area < peerMax * 0.4) score -= 120;
      if (peerMax > 0 && c.area < peerMax * 0.25) score -= 80;
      // 极扁条（logo/banner）相对惩罚
      if (c.w > 0 && c.h > 0 && c.w / c.h >= 2.8 && c.h < peerMax ** 0.5 * 0.35) {
        score -= 60;
      }
      c.score = score;
    }

    cands.sort((a, b) => b.score - a.score || b.area - a.area);
    const best = cands[0];
    if (!best) return null;
    best.el.setAttribute(ATTR, "1");

    // 若仍偏小：扩展为「题图 ∪ 题干/输入/验证」整卡，避免只裁装饰条
    let x = best.x;
    let y = best.y;
    let right = best.x + best.w;
    let bottom = best.y + best.h;
    const expand =
      peerMax > 0 && best.area < peerMax * 0.5
        ? true
        : best.area < Math.max(...cands.map((c) => c.area)) * 0.45;
    if (expand) {
      for (const box of [ir, vr, hr]) {
        if (!box || box.width < 1) continue;
        x = Math.min(x, box.x);
        y = Math.min(y, box.y);
        right = Math.max(right, box.x + box.width);
        bottom = Math.max(bottom, box.y + box.height);
      }
      // 再并入上方最大近邻图
      const bigger = cands
        .filter((c) => c.above && c.area >= best.area)
        .sort((a, b) => b.area - a.area)[0];
      if (bigger) {
        x = Math.min(x, bigger.x);
        y = Math.min(y, bigger.y);
        right = Math.max(right, bigger.x + bigger.w);
        bottom = Math.max(bottom, bigger.y + bigger.h);
      }
    }
    const pad = 6;
    return {
      x: Math.max(0, x - pad),
      y: Math.max(0, y - pad),
      w: Math.max(1, right - x + pad * 2),
      h: Math.max(1, bottom - y + pad * 2),
      src: best.src,
    };
  });
}

/** 剥离模型可能夹带的 JSON，禁止用其中字段参与求值 */
function stripJsonForPlainText(raw: string): string {
  let t = String(raw ?? "").trim();
  if (!t) return "";
  t = t.replace(/```[\s\S]*?```/g, " ");
  for (let i = 0; i < 8; i++) {
    const next = t.replace(/\{[^{}]*\}/g, " ");
    if (next === t) break;
    t = next;
  }
  if (/^\s*\{[\s\S]*\}\s*$/.test(t)) return "";
  return t.replace(/\s+/g, " ").trim();
}

/** 从纯文本提取算式（不读 JSON 字段） */
export function salvageMathExpr(raw: string): string | null {
  const t = stripJsonForPlainText(raw)
    .replace(/＝/g, "=")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/＊/g, "*");
  if (!t) return null;

  const patterns = [
    /(?:算式|表达式)\s*[:=：]\s*([^\n]{1,64})/i,
    /\b((?:sin|cos|tan)\s*\(\s*-?\d+(?:\.\d+)?\s*°?\s*\))/i,
    /(-?\d+(?:\.\d+)?!)/,
    /(-?\d+(?:\.\d+)?\s*[+\-*/]\s*-?\d+(?:\.\d+)?(?:\s*[+\-*/]\s*-?\d+(?:\.\d+)?)*)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) {
      const expr = m[1]
        .trim()
        .replace(/\s+/g, "")
        .replace(/[＝=].*$/, "")
        .replace(/[？?].*$/, "");
      const n = normalizeVisionExpr(expr);
      if (n) return n;
    }
  }
  const line = t.split(/\n/)[0]?.trim() ?? "";
  if (/^[\d.+\-*/()!°,a-zA-Z×÷＊／\s]+$/.test(line) && /\d/.test(line)) {
    const expr = line
      .replace(/\s+/g, "")
      .replace(/[＝=].*$/, "")
      .replace(/[？?].*$/, "");
    return normalizeVisionExpr(expr);
  }
  return null;
}

async function visionReadExpr(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
  box: { x: number; y: number; w: number; h: number; src?: string };
  attempt: number;
}): Promise<{ expr: string; confidence: number; path?: string } | null> {
  if (!isIntentConfigured(createModelRouter(input.aiSettings).pool, "vision")) {
    throw new Error("未配置视觉模型（vision），无法读取算式图");
  }
  const pad = input.attempt > 1 ? 6 : 2;
  const clip = {
    x: Math.max(0, Math.floor(input.box.x - pad)),
    y: Math.max(0, Math.floor(input.box.y - pad)),
    width: Math.max(1, Math.floor(input.box.w + pad * 2)),
    height: Math.max(1, Math.floor(input.box.h + pad * 2)),
  };
  await freezePageForCapture(input.page);
  let buf: Buffer | undefined;
  let captureMethod = "screenshot";
  try {
    await waitCaptureSettle();
    // 优先静默拉原图（防截屏闪屏）；失败再 screenshot 兜底
    const src = String(input.box.src || "").trim();
    if (src && src !== "canvas" && !/^data:image\/gif/i.test(src)) {
      try {
        const raw = await fetchImageBuffer(input.page, src);
        if (raw && raw.length > 80) {
          const jpeg = await encodeBytesToJpegOnPage(
            input.page,
            raw,
            Math.round(input.box.w),
            Math.round(input.box.h),
          );
          if (jpeg?.b64) {
            buf = Buffer.from(jpeg.b64, "base64");
            captureMethod = "fetch";
          }
        }
      } catch {
        /* fall through */
      }
    }
    if (!buf) {
      buf = await captureScreenshot(input.page, {
        type: "jpeg",
        quality: 95,
        clip,
        scale: "css",
        animations: "disabled",
        caret: "hide",
      });
      captureMethod = "screenshot";
    }
  } finally {
    await unfreezePageForCapture(input.page);
  }
  if (!buf) return null;
  input.logger.agentProgress(`算式采帧：${captureMethod}`, {
    phase: "math_image_captcha",
    stage: "capture",
    method: captureMethod,
  });
  let path: string | undefined;
  if (input.fileSystem) {
    path = input.fileSystem.writeBinaryFile(
      `captcha_math_${Date.now()}_a${input.attempt}.jpg`,
      buf,
    );
  }
  // OpenCV 去噪只作「锦上添花」：优先用原图读题；原图读不出再试去噪图。
  // 旧实现直接用去噪图替换原图，算式的运算符/数字结构易被增强灰度破坏，
  // 导致原本能过的算式反而读错。去噪图应作为兜底，而非主图。
  const denoised = await openCvDenoise({
    buf,
    mode: "text",
    binary: false,
    logger: input.logger,
    signal: input.signal,
  });
  const variants: Buffer[] = [buf];
  if (denoised && denoised.jpeg.length > 0) variants.push(denoised.jpeg);

  const router = createModelRouter(input.aiSettings);
  const { route, client } = router.forIntent("vision", "算式验证码读题");
  const promptText =
    "这是数学计算验证码图片。逐字读出图中算式原文。" +
    "只输出算式一行纯文本。" +
    "必须含运算符或函数名。" +
    "禁止输出得数。" +
    "禁止 JSON。" +
    "禁止解释与思考过程。";

  const readFrom = async (
    candidate: Buffer,
  ): Promise<{ expr: string; confidence: number } | null> => {
    const b64 = candidate.toString("base64");
    try {
      const resp = await client.chat.completions.create(
        {
          model: route.model,
          temperature: 0,
          max_tokens: 80,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: promptText },
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
                },
              ],
            },
          ],
        },
        input.signal ? { signal: input.signal } : undefined,
      );
      const raw = extractVisionMessageText(resp).text;
      const plain = stripJsonForPlainText(raw);
      if (/[{\[]/.test(raw) && !plain) {
        input.logger.warn("math_vision_json_rejected", {
          attempt: input.attempt,
          rawHead: raw.slice(0, 120),
        });
        return null;
      }
      const fromPlain = normalizeVisionExpr(plain);
      const salvaged = fromPlain ?? salvageMathExpr(plain || raw);
      if (!salvaged) {
        input.logger.warn("math_vision_reject_expr", {
          attempt: input.attempt,
          rawHead: raw.slice(0, 160),
          plainHead: plain.slice(0, 80),
        });
        return null;
      }
      return { expr: salvaged, confidence: 0.8 };
    } catch (err) {
      if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
        throw new Error("Agent 已中止");
      }
      input.logger.warn("math_vision_read_failed", {
        error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
      });
      return null;
    }
  };

  for (const candidate of variants) {
    const result = await readFrom(candidate);
    if (result) return { ...result, path };
  }
  return path ? { expr: "", confidence: 0, path } : null;
}

export async function solveMathImageCaptcha(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  selectorMap: Map<number, IndexedElementRef>;
  pageHint?: string;
  goalHint?: string;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
}): Promise<MathSolveResult> {
  if (input.signal?.aborted) throw new Error("Agent 已中止");

  const formHints = findMathCaptchaFormHints(input.selectorMap);
  const artifactPaths: string[] = [];
  const empty = (): MathSolveResult => ({
    ok: false,
    strategy: "math_image_solve",
    expr: "",
    answer: "",
    confidence: 0,
    method: "none",
    formHints,
    artifactPaths,
    detail: "未能完成算式验证码",
  });

  input.logger.agentProgress("① 类型门禁：math_image_solve → 定位算式图…", {
    phase: "math_image_captcha",
    stage: "locate",
  });

  const box = await locateMathImage(input.page);
  if (!box) {
    const r = empty();
    const hint = formatFormHintFallback(formHints);
    r.detail =
      "未找到算式验证码图片（非 GIF）。勿刷新，可重试；满 3 次 HITL。" +
      (hint ? ` ${hint}` : "");
    return r;
  }

  input.logger.agentProgress(
    `② 已定位算式图 ${Math.round(box.w)}×${Math.round(box.h)} → 视觉读表达式…`,
    { phase: "math_image_captcha", stage: "vision", w: box.w, h: box.h },
  );

  let bestExpr = "";
  let bestConf = 0;
  let method = "vision";

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (input.signal?.aborted) throw new Error("Agent 已中止");
    const vis = await visionReadExpr({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      box,
      attempt,
    });
    if (vis?.path) artifactPaths.push(vis.path);
    if (vis?.expr) {
      if (isAnswerOnlyExpr(vis.expr)) {
        input.logger.warn("math_vision_prompt_poison", {
          expr: vis.expr.slice(0, 64),
          attempt,

        });
        continue;
      }
      if (vis.confidence >= bestConf) {
        bestExpr = vis.expr;
        bestConf = vis.confidence;
      }
    }
    if (bestExpr && bestConf >= 0.55) {
      const trial = safeEvalMath(bestExpr);
      if (trial.ok) break;
    }
    if (attempt === 1) await sleep(200);
  }

  // 若两轮未读出有效算式，再强制第三轮
  if ((!bestExpr || isAnswerOnlyExpr(bestExpr)) && !input.signal?.aborted) {
    const vis = await visionReadExpr({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      box,
      attempt: 3,
    });
    if (vis?.path) artifactPaths.push(vis.path);
    if (vis?.expr && !isAnswerOnlyExpr(vis.expr)) {
      bestExpr = vis.expr;
      bestConf = vis.confidence;
    }
  }

  if (!bestExpr || bestConf < 0.35) {
    const removed = destroyPaths(artifactPaths);
    artifactPaths.length = 0;
    const r = empty();
    r.method = "vision_fail";
    r.confidence = bestConf;
    const hint = formatFormHintFallback(formHints);
    r.detail =
      `视觉未能读出算式（已毁临时图 ${removed}）。勿刷新。` +
      (hint
        ? ` ${hint}`
        : " 可重试 solve_captcha；满 3 次 HITL。");
    return r;
  }

  const evaluated = safeEvalMath(bestExpr);
  if (!evaluated.ok) {
    const removed = destroyPaths(artifactPaths);
    artifactPaths.length = 0;
    const r = empty();
    r.expr = bestExpr;
    r.confidence = bestConf;
    r.method = `eval_fail:${evaluated.reason}`;
    const hint = formatFormHintFallback(formHints);
    r.detail =
      `读到「${bestExpr}」但无法安全求值（${evaluated.reason}）。已毁图 ${removed}。勿刷新。` +
      (hint ? ` ${hint}` : "");
    return r;
  }

  method = `vision+safeEval conf=${bestConf.toFixed(2)}`;
  input.logger.agentProgress(
    `③ 表达式「${evaluated.expr}」→ 答案「${evaluated.value}」· ${method}`,
    {
      phase: "math_image_captcha",
      stage: "eval",
      expr: evaluated.expr,
      answer: evaluated.value,
      confidence: bestConf,
    },
  );

  return {
    ok: true,
    strategy: "math_image_solve",
    expr: evaluated.expr,
    answer: evaluated.value,
    confidence: bestConf,
    method,
    formHints,
    artifactPaths,
    detail: `expr=${evaluated.expr} answer=${evaluated.value}`,
  };
}
