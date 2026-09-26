/**
 * 验证码策略分发：按 `captcha_strategy.ts` 判出的策略族路由到对应求解器。
 *
 * 本文件**不再持有判据**——策略识别、强制策略白名单、对外 id 清单全部来自
 * `captcha_strategy.ts`（唯一事实源）。此前这里与 `animated_captcha.ts` 各存一份，
 * 两处判据必然漂移，导致 `forceStrategy` 对非 GIF 策略形同虚设。
 */
import type { Page } from "playwright-core";

import type { SidecarAiSettings } from "../engine.js";
import type { JsonLogger } from "../json-logger.js";
import {
  solveImageTextCaptcha,
  cleanupCaptchaArtifacts,
  type ImageTextSolveResult,
} from "./animated_captcha.js";
import {
  detectCaptchaStrategy,
  SUPPORTED_CAPTCHA_STRATEGIES,
  type CaptchaStrategyId,
} from "./captcha_strategy.js";
import {
  solveTokenChallengeRemote,
  type RemoteSolveResult,
  type SecretResolver,
} from "./captcha_remote.js";
import type { AgentFileSystem } from "./filesystem.js";
import {
  hasVisibleCaptchaWidget,
  waitForCaptchaWidget,
  CAPTCHA_WIDGET_WAIT_MS,
} from "./captcha_utils.js";
import {
  solveMathImageCaptcha,
  type MathSolveResult,
} from "./math_image_captcha.js";
import {
  solvePointSelectCaptcha,
  type PointSelectResult,
} from "./point_select_captcha.js";
import {
  solvePressHoldCaptcha,
  type PressHoldSolveResult,
} from "./press_hold_captcha.js";
import {
  solveSliderCaptcha,
  type SliderSolveResult,
} from "./slider_captcha.js";
import type { IndexedElementRef } from "./views.js";

export {
  detectCaptchaStrategy,
  SUPPORTED_CAPTCHA_STRATEGIES,
  type CaptchaStrategyId,
};

export type UnifiedCaptchaResult =
  | {
      kind: "imageText";
      strategy: "image_text_read";
      imageText: ImageTextSolveResult;
    }
  | {
      kind: "slider";
      strategy: "slider_gap_drag";
      slider: SliderSolveResult;
    }
  | {
      kind: "math";
      strategy: "math_image_solve";
      math: MathSolveResult;
    }
  | {
      kind: "point";
      strategy: "point_select_click";
      point: PointSelectResult;
    }
  | {
      kind: "pressHold";
      strategy: "press_hold_captcha";
      pressHold: PressHoldSolveResult;
    }
  | {
      kind: "remote";
      strategy: "token_challenge_remote";
      remote: RemoteSolveResult;
    }
  | {
      kind: "unsupported";
      strategy: "unsupported";
      detail: string;
      supportedStrategies: string[];
    };

/**
 * 收集「验证码语义」文案：主文档 + 可脚本化的 iframe（含 Arkose / reCAPTCHA 等把题面
 * 放在 iframe 里的情况）。此前只读主文档，导致 iframe 内的长按题（题面在框架里）判不出类型。
 * 有超时与数量上限，跨域/卡住的框架直接跳过。
 */
async function collectCaptchaPageText(page: Page): Promise<string> {
  const withTimeout = async <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const parts: string[] = [];
  const main = await withTimeout(
    page.evaluate(() => String(document.body?.innerText || "").slice(0, 2500)).catch(() => ""),
    1500,
    "",
  );
  if (main) parts.push(main);

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    if (url && url !== "about:blank") parts.push(url);
    const text = await withTimeout(
      frame.evaluate(() => String(document.body?.innerText || "").slice(0, 1200)).catch(() => ""),
      1200,
      "",
    );
    if (text) parts.push(text);
    if (parts.join("\n").length > 6000) break;
  }
  return parts.join("\n").slice(0, 6000);
}

export async function solveCaptcha(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  selectorMap: Map<number, IndexedElementRef>;
  pageHint?: string;
  goalHint?: string;
  forceStrategy?: string;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
  /** P5.1：第三方 captcha_service（Host 注入） */
  captchaService?: unknown;
  /** P5.1：按 apiKeyRef 解析明文 */
  resolveCaptchaSecret?: SecretResolver;
}): Promise<UnifiedCaptchaResult> {
  let pageText = await collectCaptchaPageText(input.page);
  let strategy = detectCaptchaStrategy({
    pageText,
    pageUrl: input.page.url(),
    goalHint: `${input.goalHint ?? ""} ${input.pageHint ?? ""}`,
    forceStrategy: input.forceStrategy,
  });

  const supported = SUPPORTED_CAPTCHA_STRATEGIES.map((s) => s.id);

  /**
   * 有些站点的验证组件是**异步挂载**的：页面上先出现「请证明您是人类」的文案/骨架，
   * 几秒后才注入 Arkose / reCAPTCHA 的 iframe 与按钮。此时若直接求解，各策略都会
   * 立刻「找不到目标」并失败，连错 3 次就会误触 HITL（线上已踩：微软注册页在
   * 组件就绪前的几次 solve_captcha 全部判 unsupported）。
   *
   * 因此：只要当前看不到任何可见的验证组件，且策略提示「需要组件」，就先等待其渲染
   * （默认最多 30s，组件一出现立即继续），等待后重新读取页面并重判策略。
   */
  let waitBudgetMs = CAPTCHA_WIDGET_WAIT_MS;
  /**
   * 需要「等组件渲染」的情形：
   * - 已判出依赖注入组件的策略（滑块/点选/Token/长按）；
   * - 还没判出策略，但页面确有验证语义（题面先出现、组件未注入 → 类型也判不出来）。
   * 图片字符/算式靠页面里的图，不做等待（图上本来就有内容，等只会白等）。
   */
  const hasCaptchaSignal = /captcha|验证码|验证|人机|challenge|人類|驗證/i.test(pageText);
  const widgetPending =
    (strategy === null && hasCaptchaSignal) ||
    strategy === "slider_gap_drag" ||
    strategy === "point_select_click" ||
    strategy === "token_challenge_remote" ||
    strategy === "press_hold_captcha";
  if (widgetPending && !(await hasVisibleCaptchaWidget(input.page))) {
    input.logger.agentProgress(
      `验证界面已出现但验证组件尚未渲染，等待最多 ${Math.round(CAPTCHA_WIDGET_WAIT_MS / 1000)}s（组件一出现即继续）…`,
      { phase: "captcha_dispatch", stage: "wait_widget" },
    );
    const waited = await waitForCaptchaWidget(input.page, {
      timeoutMs: CAPTCHA_WIDGET_WAIT_MS,
      signal: input.signal,
      onTick: (elapsedMs) =>
        input.logger.agentProgress(
          `仍在等待验证组件渲染…已 ${Math.floor(elapsedMs / 1000)}s`,
          { phase: "captcha_dispatch", stage: "wait_widget", waitedMs: elapsedMs },
        ),
    });
    waitBudgetMs = Math.max(0, CAPTCHA_WIDGET_WAIT_MS - waited.waitedMs);
    input.logger.agentProgress(
      waited.ready
        ? `验证组件已渲染（等待 ${(waited.waitedMs / 1000).toFixed(1)}s），继续求解`
        : `已等待 ${Math.round(waited.waitedMs / 1000)}s 仍未见到验证组件，按当前页面继续`,
      { phase: "captcha_dispatch", stage: "wait_widget_done", ready: waited.ready, waitedMs: waited.waitedMs },
    );
    if (waited.ready) {
      pageText = await collectCaptchaPageText(input.page);
      strategy = detectCaptchaStrategy({
        pageText,
        pageUrl: input.page.url(),
        goalHint: `${input.goalHint ?? ""} ${input.pageHint ?? ""}`,
        forceStrategy: input.forceStrategy,
      });
    }
  }

  if (!strategy) {
    const hasCaptchaSignal = /captcha|验证码|人机验证|challenge/i.test(pageText);
    const hint = hasCaptchaSignal
      ? "检测到验证码信号但无法确定具体类型。可用 forceStrategy 强制指定：" +
        `${supported.join(" / ")}。`
      : "未检测到验证码信号，请确认当前页面确实存在验证码。";
    return {
      kind: "unsupported",
      strategy: "unsupported",
      supportedStrategies: supported,
      detail: `unsupported: ${hint} 已支持：${supported.join(", ")}。请勿对未支持类型反复重试本工具。`,
    };
  }

  if (strategy === "press_hold_captcha") {
    input.logger.agentProgress("类型门禁：press_hold_captcha", {
      phase: "captcha_dispatch",
      strategy,
    });
    const pressHold = await solvePressHoldCaptcha({
      page: input.page,
      logger: input.logger,
      signal: input.signal,
      waitBudgetMs: waitBudgetMs,
    });
    return { kind: "pressHold", strategy: "press_hold_captcha", pressHold };
  }

  if (strategy === "token_challenge_remote") {
    input.logger.agentProgress("类型门禁：token_challenge_remote", {
      phase: "captcha_dispatch",
      strategy,
    });
    const remote = await solveTokenChallengeRemote({
      page: input.page,
      captchaService: input.captchaService,
      resolveSecret: input.resolveCaptchaSecret,
      logger: input.logger,
      signal: input.signal,
    });
    return { kind: "remote", strategy: "token_challenge_remote", remote };
  }

  if (strategy === "slider_gap_drag") {
    input.logger.agentProgress("类型门禁：slider_gap_drag", {
      phase: "captcha_dispatch",
      strategy,
    });
    const slider = await solveSliderCaptcha({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      pageHint: input.pageHint,
      goalHint: input.goalHint,
    });
    return { kind: "slider", strategy: "slider_gap_drag", slider };
  }

  if (strategy === "math_image_solve") {
    input.logger.agentProgress("类型门禁：math_image_solve", {
      phase: "captcha_dispatch",
      strategy,
    });
    const math = await solveMathImageCaptcha({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      selectorMap: input.selectorMap,
      pageHint: input.pageHint,
      goalHint: input.goalHint,
      fileSystem: input.fileSystem,
      signal: input.signal,
    });
    return { kind: "math", strategy: "math_image_solve", math };
  }

  if (strategy === "point_select_click") {
    input.logger.agentProgress("类型门禁：point_select_click", {
      phase: "captcha_dispatch",
      strategy,
    });
    const point = await solvePointSelectCaptcha({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      pageHint: input.pageHint,
      goalHint: input.goalHint,
    });
    return { kind: "point", strategy: "point_select_click", point };
  }

  input.logger.agentProgress("类型门禁：image_text_read", {
    phase: "captcha_dispatch",
    strategy,
  });
  const imageText = await solveImageTextCaptcha({
    ...input,
    forceStrategy: "image_text_read",
  });
  return { kind: "imageText", strategy: "image_text_read", imageText };
}

export { cleanupCaptchaArtifacts };
