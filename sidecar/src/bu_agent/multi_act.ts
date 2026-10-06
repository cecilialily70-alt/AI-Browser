import type { ActionContext } from "./registry.js";
import { TERMINATES_SEQUENCE, getActionHandler } from "./registry.js";
import type { ActionResult, AgentAction } from "./views.js";
import { classifyThrownError, defineFailure, failureTargetKey } from "../core/action_feedback.js";
import { PAGE_PIPELINE_CONFIG } from "../page_pipeline/config.js";
import {
  VISUAL_FINGERPRINT_CONFIG,
  captureVisualFingerprint,
  describeVisualDiff,
  observeVisualChangeWithin,
} from "../core/visual_fingerprint.js";

/**
 * 需要「动作后像素核对」的动作。
 * 入选标准：**没有可靠的 DOM 结果验证**。input 有回读比对、勾选类点击有勾选态自检，
 * 都不需要再拍照；而普通点击 / 下拉选择在 DOM 上可能什么都不改（画布、自定义控件、
 * 被静默吞掉的事件），画面变化是唯一能拿到的事实。
 */
const VISUAL_VERIFY_ACTIONS = new Set(["click", "select_dropdown"]);

/**
 * 目标是否自带「决定性 DOM 回读」——勾选类控件点完能直接读到新勾选态，
 * 比像素更精确也免费。这类目标跳过核对（`visualVerifySkipStateful` 可关）。
 * 判据用观察层已读到的 `checked`：能读到状态 = 状态可被回读。
 */
function hasReliableDomVerdict(ctx: ActionContext, params: Record<string, unknown>): boolean {
  const index = params?.index;
  if (typeof index !== "number") return false;
  const el = ctx.resolveElement(index);
  if (!el) return false;
  return typeof el.checked === "boolean";
}

/** 页面可能已被关掉/跳转，取 URL 本身也可能抛 —— 归因不能反过来炸掉主流程 */
function safeUrl(page: ActionContext["page"]): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

/**
 * 同轮多动作执行。
 * solve_captcha 及别名必须独占本轮。
 */
export async function multiAct(
  actions: AgentAction[],
  ctx: ActionContext,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const startUrl = ctx.page.url();
  /** 本步剩余的核对次数（每步重置）：把「每一步都白拍几张」的固定开销压成上限 */
  let visualVerifyLeft = Math.max(0, Math.floor(PAGE_PIPELINE_CONFIG.visualVerifyMaxPerStep));

  let queue = actions;
  const CAPTCHA_ACTIONS = new Set([
    "solve_captcha",
    "solve_animated_captcha",
    "solve_slider_captcha",
    "solve_math_captcha",
    "solve_point_select_captcha",
  ]);
  const captchaSolve = actions.filter((a) => CAPTCHA_ACTIONS.has(a.name));
  if (captchaSolve.length > 0) {
    if (actions.length > 1) {
      ctx.logger.agentProgress(
        `本轮仅执行 ${captchaSolve[0]!.name}（已丢弃同轮其它动作）`,
        {
          phase: "captcha",
          dropped: actions.filter((a) => !CAPTCHA_ACTIONS.has(a.name)).map((a) => a.name),
        },
      );
    }
    queue = captchaSolve.slice(0, 1);
  }

  for (let i = 0; i < queue.length; i++) {
    if (ctx.signal?.aborted) {
      results.push({
        success: false,
        error: "Agent 已中止",
      });
      break;
    }
    const action = queue[i]!;
    const handler = getActionHandler(action.name);
    if (!handler) {
      results.push({
        success: false,
        error: `未知动作: ${action.name}`,
      });
      break;
    }

    let result: ActionResult;
    // 动作前指纹：只在「DOM 验证薄弱 + 本步还有额度 + 没跳过 + 本步还没跳转」时抓。
    // 四道闸门都是成本闸门，判定顺序按「最便宜的先判」排，且都不抓图。
    const wantVisual =
      PAGE_PIPELINE_CONFIG.visualVerify &&
      visualVerifyLeft > 0 &&
      VISUAL_VERIFY_ACTIONS.has(action.name) &&
      !(PAGE_PIPELINE_CONFIG.visualVerifySkipStateful && hasReliableDomVerdict(ctx, action.params)) &&
      safeUrl(ctx.page) === startUrl;
    if (wantVisual) visualVerifyLeft -= 1;
    const visualBefore = wantVisual
      ? await captureVisualFingerprint(ctx.page, { signal: ctx.signal })
      : null;
    try {
      result = await handler(action.params, ctx);
    } catch (err) {
      // 处理器「抛」出来的异常也必须进同一套回执体系，否则模型看到的又是一句无法归因的自然语言
      // （例如分不清「页面已跳转」和「我参数传错了」，只能原样重试）。
      const kind = classifyThrownError(err, { urlBefore: startUrl, urlNow: safeUrl(ctx.page) });
      const failure = defineFailure(kind);
      const rawIndex = action.params?.index;
      const targetKey =
        typeof rawIndex === "number" ? failureTargetKey("index", rawIndex) : undefined;
      const record = targetKey
        ? ctx.failures?.record({ targetKey, actionName: action.name, kind })
        : null;
      const text = err instanceof Error ? err.message : String(err);
      ctx.logger.agentProgress(`动作「${action.name}」抛出未捕获异常[${kind}]：${text}`, {
        phase: "action_thrown",
        kind,
        retryable: failure.retryable,
        attempts: record?.attempts ?? 1,
        escalated: record?.escalate ?? false,
      });
      result = {
        success: false,
        error: record?.escalate ? `${text}${record.escalateHint}` : text,
        metadata: { failure: record?.failure ?? failure },
      };
    }

    // 动作后像素核对：把「这一下到底有没有让画面动」变成模型能读到的事实。
    // 仅当动作自报成功时才做（失败自有归因，说明里已写清原因）。
    if (visualBefore && result.success && !result.error) {
      if (safeUrl(ctx.page) !== startUrl) {
        // 已经跳走了：跳转本身就是最强的结果证据，没必要再抓图（导航中的截图还会拖住主流程）
        result = {
          ...result,
          metadata: { ...(result.metadata ?? {}), visual: { navigated: true, changed: true } },
        };
      } else {
        // 命中点邻域不计入判定：指针停在目标上造成的 hover 高亮/焦点环是真实像素变化，
        // 但完全不能证明「点击生效了」，必须排除，否则「什么都没发生」这个信号永远发不出来。
        const hit = result.metadata?.hitPoint as { x?: number; y?: number } | null | undefined;
        const radius = VISUAL_FINGERPRINT_CONFIG.ignoreAroundHitPx;
        const ignore =
          hit && typeof hit.x === "number" && typeof hit.y === "number"
            ? { x: hit.x - radius, y: hit.y - radius, w: radius * 2, h: radius * 2 }
            : null;
        const visual = await observeVisualChangeWithin(ctx.page, visualBefore, {
          maxWaitMs: VISUAL_FINGERPRINT_CONFIG.postActionWaitMs,
          signal: ctx.signal,
          ignore,
        });
        // 竞态兜底：点击触发的跳转可能正好在抓图期间提交（上下文被销毁 → 抓图失败，
        // 或抓到的其实是新页面）。所以抓图之后必须**再确认一次 URL**：
        //   - 抓图失败 + 已跳转 → 如实记成 navigated（不是「没有证据」）
        //   - 已跳转 → 不再输出「画面已响应」（那是新旧两个文档的差异，会误导成「点击生效」）
        const navigated = safeUrl(ctx.page) !== startUrl;
        if (!visual && navigated) {
          result = {
            ...result,
            metadata: {
              ...(result.metadata ?? {}),
              visual: { navigated: true, changed: true },
            },
          };
        } else if (visual) {
          const verifiedByDom =
            typeof result.metadata?.checkedAfter === "boolean" ||
            typeof result.metadata?.fillVerify === "string";
          result = {
            ...result,
            metadata: {
              ...(result.metadata ?? {}),
              visual: {
                changed: visual.changed,
                visible: visual.visible,
                changedRatio: Number(visual.changedRatio.toFixed(4)),
                waitedMs: visual.waitedMs,
                navigated,
              },
            },
          };
          if (!navigated && !visual.changed && !verifiedByDom) {
            // 「点完什么都没发生」是死循环的头号来源：必须在同一步说清，
            // 并且明确禁止「原样再点一次」——否则模型只会换个措辞重试同一个 index。
            ctx.logger.agentProgress?.(`像素核对未见变化：${describeVisualDiff(visual)}`, {
              phase: "visual_verify",
              changed: false,
              waitedMs: visual.waitedMs,
              polls: visual.polls,
              action: action.name,
            });
            const note =
              `（像素核对：动作后 ${Math.round(visual.waitedMs / 100) / 10}s 内画面无可见变化，` +
              `也无跳转/勾选态变化 —— 这一下很可能没有生效。不要原样重点同一个 index：` +
              `先重新观察确认目标是否还在、是否被弹层挡住，再决定换点击方式或改用其它入口。）`;
            result = {
              ...result,
              extractedContent: `${result.extractedContent ?? ""}${note}`,
              longTermMemory: `${result.longTermMemory ?? ""}${note}`,
            };
          } else if (!navigated && visual.visible && !verifiedByDom) {
            // 正反馈只给「量级足够」的变化：DOM 毫无变化时，这是这一下生效的客观证据。
            // hover/焦点级的细微变化一律沉默 —— 宁可不说，也不能说错。
            ctx.logger.agentProgress?.(`像素核对见可见变化：${describeVisualDiff(visual)}`, {
              phase: "visual_verify",
              changed: true,
              visible: true,
              waitedMs: visual.waitedMs,
              action: action.name,
            });
            const note = "（像素核对：画面已响应）";
            result = {
              ...result,
              extractedContent: `${result.extractedContent ?? ""}${note}`,
              longTermMemory: `${result.longTermMemory ?? ""}${note}`,
            };
          }
        }
      }
    }
    results.push(result);

    if (result.isDone) break;
    if (result.error) break;
    if (TERMINATES_SEQUENCE.has(action.name)) break;

    // 点击后若已换页，本轮的后续 index 必然过期：立即停止，交由下一轮重新观察
    // （其余动作的过期风险由 actions 层的 index 新鲜度闸门兜底，避免误伤 SPA 仅改 URL 的场景）
    const urlNow = ctx.page.url();
    if (urlNow !== startUrl && action.name === "click") {
      break;
    }
  }

  return results;
}
