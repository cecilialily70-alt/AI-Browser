/**
 * 精确点击闭环（Precision Click Loop）
 *
 * 把「模型给的元素」翻译成「真正能生效的一次点击」，并在失败时产出**结构化反馈**回灌模型。
 *
 * 闭环顺序（每一层都可跳过、失败即降级）：
 *   ① 意图关联 + 命中自检（`hit_point.ts`）→ 得到排序后的候选点
 *   ② 逐点点击；若目标是勾选类控件，回读勾选态做**结果验证**（不靠工具返回值自证成功）
 *   ③ 真实控件不可点（视觉折叠）时，退化为页面内原生 `el.click()`
 *   ④ 候选点全被遮挡 → 探针 + 词典仲裁清障 → 重新解析 → 再点
 *   ⑤ 仍不成功 → 返回 blocked/feedback，禁止上层「盲点」或「force 点击」掩盖问题
 */
import type { Page } from "playwright-core";

import {
  NO_OFFSET,
  describeMainDocumentCover,
  pointInsideBox,
  scopePage,
  toPagePoint,
  type DomScope,
  type FrameOffset,
} from "./dom_scope.js";
import {
  describeHitPointResolution,
  resolveHitPoints,
  type AssociatedControl,
  type HitPointResolution,
} from "./hit_point.js";
import {
  MAX_OVERLAY_ATTEMPTS_PER_FINGERPRINT,
  applyObstaclePlan,
  releaseTransientFocus,
  resolveObstaclePlan,
} from "./obstacle_arbiter.js";

export type ClickExpectation = "click" | "check" | "uncheck" | "auto";

export interface PreciseClickRequest {
  selector?: string;
  xpath?: string;
  expect?: ClickExpectation;
  /** 语义标签，仅用于日志与反馈 */
  semanticLabel?: string;
  /** 候选点最大尝试次数（默认 3） */
  maxAttempts?: number;
  /**
   * 元素所在文档。缺省 = 主文档。
   * 嵌套框架时，命中点/回读/清障全部在该文档内进行，只有物理点击坐标需要换算到主文档视口。
   */
  scope?: DomScope;
  /** 嵌套框架相对主文档视口的偏移（`scope` 为框架时必填，否则点击会落在错的位置） */
  offset?: FrameOffset;
  /** 嵌套框架的可见盒子（框架局部坐标）；用于排除「已在框架内部滚出可视区」的点 */
  frameVisible?: { w: number; h: number } | null;
  /** 框架盒子在主文档视口里的矩形；用于识别「主文档弹层压住整个 iframe」 */
  frameBox?: { x: number; y: number; w: number; h: number } | null;
}

export interface ClearedOverlayInfo {
  label: string;
  method: string;
  detail: string;
}

export interface PreciseClickResult {
  ok: boolean;
  method:
    | "already-satisfied"
    | "point-click"
    | "native-click"
    | "cleared-then-point"
    | "selector-fallback"
    | "none";
  blocked: boolean;
  clickedPoint: { x: number; y: number } | null;
  associated: AssociatedControl | null;
  checkedBefore: boolean | null;
  checkedAfter: boolean | null;
  clearedOverlay: ClearedOverlayInfo | null;
  attempts: string[];
  feedback: string;
  error: string | null;
}

interface ParsedTarget {
  selector: string;
  xpath: string;
}

interface ChoiceSnapshot {
  checked: boolean | null;
  ariaChecked: string | null;
  className: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function parseTarget(selector?: string, xpath?: string): ParsedTarget {
  let sel = String(selector ?? "").trim();
  let xp = String(xpath ?? "").trim();
  if (sel.startsWith("xpath=")) {
    xp = xp || sel.slice("xpath=".length);
    sel = "";
  } else if (sel.startsWith("css=")) {
    sel = sel.slice("css=".length);
  }
  if (xp.startsWith("xpath=")) xp = xp.slice("xpath=".length);
  if (sel && (sel.startsWith("/") || sel.startsWith("(") || sel.startsWith("./"))) {
    xp = xp || sel;
    sel = "";
  }
  return { selector: sel, xpath: xp };
}

function isChoiceControl(control: AssociatedControl | null): boolean {
  if (!control) return false;
  if (control.inputType === "checkbox" || control.inputType === "radio") return true;
  return control.role === "checkbox" || control.role === "radio" || control.role === "switch";
}

/** 该点击是否属于「勾选语义」，需要做勾选态验证 */
function needsChoiceVerification(
  expectation: ClickExpectation,
  resolution: HitPointResolution,
): boolean {
  if (expectation === "check" || expectation === "uncheck") return true;
  if (isChoiceControl(resolution.associated)) return true;
  const role = resolution.anchor?.role ?? "";
  return (
    role === "checkbox" ||
    role === "radio" ||
    role === "switch" ||
    resolution.anchor?.inputType === "checkbox" ||
    resolution.anchor?.inputType === "radio"
  );
}

export async function readChoiceSnapshot(
  page: DomScope,
  target: ParsedTarget,
): Promise<ChoiceSnapshot | null> {
  try {
    return (await page.evaluate((t: ParsedTarget) => {
      const resolve = (sel: string, xp: string): Element | null => {
        if (sel.startsWith("/") || sel.startsWith("(") || sel.startsWith("./")) {
          xp = xp || sel;
          sel = "";
        }
        if (sel) {
          try {
            const hit = document.querySelector(sel);
            if (hit) return hit;
          } catch {
            /* ignore */
          }
        }
        if (xp) {
          try {
            const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (r.singleNodeValue instanceof Element) return r.singleNodeValue;
          } catch {
            /* ignore */
          }
        }
        return null;
      };
      const el = resolve(t.selector, t.xpath);
      if (!el) return null;
      const input =
        el instanceof HTMLInputElement
          ? el
          : (el.querySelector("input[type='checkbox'],input[type='radio']") as HTMLInputElement | null);
      const ariaHolder = el.getAttribute("aria-checked") != null ? el : el.querySelector("[aria-checked]");
      const ariaChecked = ariaHolder?.getAttribute("aria-checked") ?? null;
      return {
        checked: input ? input.checked : null,
        ariaChecked,
        className: typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "",
      };
    }, target)) as ChoiceSnapshot | null;
  } catch {
    return null;
  }
}

function snapshotState(snapshot: ChoiceSnapshot | null): boolean | null {
  if (!snapshot) return null;
  if (snapshot.checked != null) return snapshot.checked;
  if (snapshot.ariaChecked === "true") return true;
  if (snapshot.ariaChecked === "false") return false;
  return null;
}

function snapshotChanged(before: ChoiceSnapshot | null, after: ChoiceSnapshot | null): boolean {
  if (!before || !after) return false;
  const beforeState = snapshotState(before);
  const afterState = snapshotState(after);
  if (beforeState != null && afterState != null && beforeState !== afterState) return true;
  if (before.className !== after.className) return true;
  if (before.ariaChecked !== after.ariaChecked) return true;
  return false;
}

/** 物理点击（主文档视口坐标）：`mouse` 只存在于 Page 上，因此这里必须由调用方换算好坐标 */
async function clickPagePoint(owner: Page, x: number, y: number): Promise<void> {
  try {
    await owner.mouse.click(x, y);
  } catch {
    await owner.mouse.move(x, y);
    await owner.mouse.click(x, y);
  }
}

/** 页面内原生激活（针对视觉折叠、鼠标点不到的控件），在元素自己的文档里执行 */
async function nativeActivate(page: DomScope, target: ParsedTarget): Promise<boolean> {
  try {
    return Boolean(
      await page.evaluate((t: ParsedTarget) => {
        const resolve = (): Element | null => {
          let sel = t.selector;
          let xp = t.xpath;
          if (sel.startsWith("/") || sel.startsWith("(") || sel.startsWith("./")) {
            xp = xp || sel;
            sel = "";
          }
          if (sel) {
            try {
              const hit = document.querySelector(sel);
              if (hit) return hit;
            } catch {
              /* ignore */
            }
          }
          if (xp) {
            try {
              const r = document.evaluate(
                xp,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null,
              );
              if (r.singleNodeValue instanceof Element) return r.singleNodeValue;
            } catch {
              /* ignore */
            }
          }
          return null;
        };
        const root = resolve();
        if (!root) return false;
        const target =
          root instanceof HTMLInputElement
            ? root
            : ((root.querySelector("input[type='checkbox'],input[type='radio']") as HTMLElement | null) ??
              (root as HTMLElement));
        if (typeof target.click !== "function") return false;
        target.focus?.({ preventScroll: true });
        target.click();
        return true;
      }, target),
    );
  } catch {
    return false;
  }
}

interface CandidateOutcome {
  ok: boolean;
  method: PreciseClickResult["method"];
  clickedPoint: { x: number; y: number } | null;
  checkedAfter: boolean | null;
  attempts: string[];
}

/** 一次点击的执行上下文：文档作用域 + 物理坐标换算所需的框架偏移 */
interface ClickExecution {
  /** 元素所在文档（命中点/回读/原生激活都在这里） */
  scope: DomScope;
  /** 承载鼠标与键盘的主文档 */
  owner: Page;
  /** 嵌套框架相对主文档视口的偏移 */
  offset: FrameOffset;
  /** 嵌套框架的可见盒子；主文档为 null（不做这类过滤） */
  frameVisible: { w: number; h: number } | null;
}

async function tryCandidatePoints(
  exec: ClickExecution,
  resolution: HitPointResolution,
  options: {
    verifyChoice: boolean;
    anchorTarget: ParsedTarget;
    maxAttempts: number;
  },
): Promise<CandidateOutcome> {
  const attempts: string[] = [];
  const points = resolution.points.slice(0, Math.max(1, options.maxAttempts));
  for (const point of points) {
    // 嵌套框架自身的滚动会让元素跑到框架可视区之外：那里的点加上偏移后属于主文档的其它内容，
    // 点下去会打到别的东西上（而框架内部的自检毫无察觉）。这类点必须直接排除。
    if (exec.frameVisible && !pointInsideBox(point, exec.frameVisible)) {
      attempts.push(`点 (${point.x},${point.y})[${point.strategy}] 在框架可视区之外，跳过`);
      continue;
    }
    const physical = toPagePoint(point, exec.offset);
    const before = options.verifyChoice
      ? await readChoiceSnapshot(exec.scope, options.anchorTarget)
      : null;
    try {
      await clickPagePoint(exec.owner, physical.x, physical.y);
    } catch (error) {
      attempts.push(
        `点 (${physical.x},${physical.y})[${point.strategy}] 抛错：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (!options.verifyChoice) {
      return {
        ok: true,
        method: "point-click",
        clickedPoint: physical,
        checkedAfter: null,
        attempts,
      };
    }
    const beforeState = before ? snapshotState(before) : null;
    const verifiable =
      Boolean(before) &&
      (beforeState !== null ||
        (before!.className ?? "").length > 0 ||
        before!.ariaChecked !== null);
    if (!verifiable) {
      // 控件没有任何可读状态（既非 input 也无 aria-checked / class 变化）→ 视为已点击，不做伪验证
      return {
        ok: true,
        method: "point-click",
        clickedPoint: physical,
        checkedAfter: null,
        attempts: [...attempts, `点 (${physical.x},${physical.y})[${point.strategy}] 已执行（勾选态不可读，跳过验证）`],
      };
    }
    await exec.scope.waitForTimeout(180);
    const after = await readChoiceSnapshot(exec.scope, options.anchorTarget);
    const state = snapshotState(after);
    if (before && after && snapshotChanged(before, after)) {
      return {
        ok: true,
        method: "point-click",
        clickedPoint: physical,
        checkedAfter: state,
        attempts,
      };
    }
    attempts.push(
      `点 (${physical.x},${physical.y})[${point.strategy}] 未生效（勾选态 ${snapshotState(before)} → ${state}）`,
    );
  }
  return { ok: false, method: "none", clickedPoint: null, checkedAfter: null, attempts };
}

/**
 * 精确点击主入口。
 * `blocked=true` 表示失败原因是遮挡/无法定位，上层**不得**再用 force 点击掩盖。
 */
export async function preciseClick(
  page: Page,
  request: PreciseClickRequest,
): Promise<PreciseClickResult> {
  const expectation: ClickExpectation = request.expect ?? "auto";
  const anchorTarget = parseTarget(request.selector, request.xpath);
  const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempts: string[] = [];
  let clearedOverlay: ClearedOverlayInfo | null = null;

  // 跨文档执行上下文：文档作用域负责「在哪执行」，偏移负责「点在哪」
  const scope: DomScope = request.scope ?? page;
  const offset = request.offset ?? NO_OFFSET;
  const inFrame = scope !== page;
  const exec: ClickExecution = {
    scope,
    owner: scopePage(scope),
    offset,
    frameVisible: inFrame ? (request.frameVisible ?? null) : null,
  };
  if (inFrame) {
    attempts.push(`作用域：嵌套框架（偏移 ${offset.x},${offset.y}）`);
  }

  if (!anchorTarget.selector && !anchorTarget.xpath) {
    return {
      ok: false,
      method: "none",
      blocked: false,
      clickedPoint: null,
      associated: null,
      checkedBefore: null,
      checkedAfter: null,
      clearedOverlay: null,
      attempts,
      feedback: "精确点击缺少 selector / xpath",
      error: "缺少选择器",
    };
  }

  /**
   * 清障：在指定文档里仲裁出一个遮挡层并尝试清除。
   * 失败只记录不抛 —— 清障是「尽力而为」的增强路径，不能因为它自身出错就中断点击链。
   */
  const clearIn = async (
    clearScope: DomScope,
    clearOffset: FrameOffset,
    point: { x: number; y: number } | null,
    where: string,
  ): Promise<ClearedOverlayInfo | null> => {
    const obstacle = await resolveObstaclePlan(clearScope, point);
    if (!obstacle.plan) {
      if (obstacle.reason && obstacle.reason !== "未检测到遮挡层") {
        attempts.push(`${where}未找到可用清障计划：${obstacle.reason}`);
      }
      return null;
    }
    const applied = await applyObstaclePlan(clearScope, obstacle.plan, point, clearOffset);
    attempts.push(
      `${where}清障尝试「${obstacle.plan.control?.name ?? obstacle.plan.label}」：${
        applied.ok ? `成功（${applied.method}）` : `失败（${applied.detail}）`
      }`,
    );
    if (!applied.ok) {
      if (obstacle.plan.previousAttempts >= MAX_OVERLAY_ATTEMPTS_PER_FINGERPRINT - 1) {
        attempts.push(
          `同构遮挡层（指纹 ${obstacle.plan.fingerprint}）自动清障已达上限，停止重试，避免死循环`,
        );
      }
      return null;
    }
    return {
      label: obstacle.plan.control?.name ?? obstacle.plan.label,
      method: applied.method,
      detail: applied.detail,
    };
  };

  // 嵌套框架在点击前必须先把它自己的滚动状态调整好，否则「命中点」会落在框架可视区之外
  if (inFrame && exec.frameVisible) {
    try {
      const scrollTarget = anchorTarget.xpath ? `xpath=${anchorTarget.xpath}` : anchorTarget.selector;
      await exec.scope
        .locator(scrollTarget)
        .first()
        .scrollIntoViewIfNeeded({ timeout: 2_000 })
        .catch(() => undefined);
    } catch {
      /* 滚动失败不影响后续降级路径 */
    }
  }

  const resolve = (): Promise<HitPointResolution> =>
    resolveHitPoints(scope, {
      selector: anchorTarget.selector,
      xpath: anchorTarget.xpath,
      intent: expectation === "check" || expectation === "uncheck" ? "check" : "auto",
    });

  let resolution = await resolve();
  const verifyChoice = needsChoiceVerification(expectation, resolution);
  const choiceTarget: ParsedTarget = isChoiceControl(resolution.associated)
    ? parseTarget(resolution.associated!.selector, resolution.associated!.xpath)
    : anchorTarget;

  const initialSnapshot = verifyChoice ? await readChoiceSnapshot(scope, choiceTarget) : null;
  const initialState = snapshotState(initialSnapshot);
  const checkedBefore = initialState;

  /** 用来探挡的「代表点」，坐标属于元素所在的文档；点已经滚出框架可视区时返回 null（换算到主文档会指向别的内容） */
  const coverPointOf = (res: HitPointResolution): { x: number; y: number } | null => {
    const point =
      res.points[0] ??
      (res.anchor
        ? {
            x: res.anchor.rect.x + Math.round(res.anchor.rect.w / 2),
            y: res.anchor.rect.y + Math.round(res.anchor.rect.h / 2),
          }
        : (res.rejected[0] ?? null));
    if (!point) return null;
    if (exec.frameVisible && !pointInsideBox(point, exec.frameVisible)) return null;
    return { x: point.x, y: point.y };
  };

  /** 主文档弹层是否压住了这个框架（框架内部的自检看不见它） */
  const probeMainCover = async (res: HitPointResolution): Promise<string | null> => {
    if (!inFrame || !request.frameBox) return null;
    const point = coverPointOf(res);
    if (!point) return null;
    return describeMainDocumentCover(exec.owner, toPagePoint(point, offset), request.frameBox);
  };

  /** 目标在**自己的文档内**被完全压住：一个候选点都没剩下，全因遮挡淘汰 */
  const fullyCovered = (res: HitPointResolution): boolean =>
    res.points.length === 0 && res.rejected.some((rejection) => rejection.occluded === true);

  /**
   * 当前是否存在真实阻挡（跨文档的都算）。存在时**禁止**用原生 el.click() 兜底：
   * 那会绕过弹层把「页面仍被挡住」报成成功，让模型带着错误认知继续往下走。
   */
  const blockingCover = async (res: HitPointResolution): Promise<string | null> => {
    const main = await probeMainCover(res);
    if (main) return `主文档弹层「${main}」`;
    return fullyCovered(res) ? "元素在自己所在文档内被遮挡层完全覆盖" : null;
  };

  if (verifyChoice && initialState != null) {
    const alreadySatisfied =
      (expectation === "check" && initialState === true) ||
      (expectation === "uncheck" && initialState === false);
    if (alreadySatisfied) {
      return {
        ok: true,
        method: "already-satisfied",
        blocked: false,
        clickedPoint: null,
        associated: resolution.associated,
        checkedBefore,
        checkedAfter: initialState,
        clearedOverlay: null,
        attempts: [`勾选态已满足（${initialState}）`],
        feedback: `目标已是期望状态（${initialState ? "已勾选" : "未勾选"}），无需点击`,
        error: null,
      };
    }
  }

  // ② 预检：已知物理点击会打在弹层上时（主文档弹层整层压住框架），先清障。
  //    清不掉就直接给出 blocked 回执 —— 绝不允许「盲点」（可能误触弹层上的无关控件），
  //    也不允许「原生激活绕过」（弹层还在，后续流程照样走不通，却会谎报成功）。
  let mainCover: string | null = await probeMainCover(resolution);
  if (mainCover) {
    const point = coverPointOf(resolution);
    const clearedMain = point
      ? await clearIn(page, NO_OFFSET, toPagePoint(point, offset), "主文档")
      : null;
    if (clearedMain) clearedOverlay = clearedMain;
    mainCover = await probeMainCover(resolution);
    if (mainCover) {
      return {
        ok: false,
        method: "none",
        blocked: true,
        clickedPoint: null,
        associated: resolution.associated,
        checkedBefore,
        checkedAfter: verifyChoice ? initialState : null,
        clearedOverlay,
        attempts,
        feedback: `目标在嵌套框架内，但主文档弹层「${mainCover}」整层压住了该框架，自动清障未成功。请先关闭/清除当前页面弹层，再重新观察后重试本目标`,
        error: `主文档遮挡层拦截：${mainCover}`,
      };
    }
  }

  let outcome = await tryCandidatePoints(exec, resolution, {
    verifyChoice,
    anchorTarget: choiceTarget,
    maxAttempts,
  });
  attempts.push(...outcome.attempts);

  /**
   * ③ 真实控件点不到（视觉折叠 / 只有程序化点击才响应）→ 页面内原生 el.click()。
   * 只在**没有真实阻挡**时允许；清障成功之后的兜底调用会重新评估，所以不必在这里预先放宽。
   */
  const tryNativeActivate = async (res: HitPointResolution): Promise<void> => {
    if (!verifyChoice) return;
    const cover = await blockingCover(res);
    if (cover) {
      attempts.push(`跳过原生 el.click()：存在真实阻挡（${cover}），不能绕过弹层假报成功`);
      return;
    }
    if (!(await nativeActivate(scope, choiceTarget))) return;
    await scope.waitForTimeout(180);
    const after = await readChoiceSnapshot(scope, choiceTarget);
    if (!initialState || snapshotChanged(initialSnapshot, after)) {
      outcome = {
        ok: true,
        method: "native-click",
        clickedPoint: null,
        checkedAfter: snapshotState(after),
        attempts: [],
      };
      attempts.push("原生 el.click() 生效");
    } else {
      attempts.push(`原生 el.click() 未改变勾选态（${snapshotState(after)}）`);
    }
  };

  if (!outcome.ok) await tryNativeActivate(resolution);

  // ④ 遮挡 → 清障 → 重新解析 → 再点
  //
  // 两个层都要查，缺一不可：
  //   - 元素所在文档的遮挡层（框架内的 Cookie 条 / 弹窗）→ 在**那个文档**里清
  //   - 主文档的遮挡层（压在整个 iframe 上的横幅）→ 框架内部的自检完全看不见它，只能在主文档里清
  if (!outcome.ok) {
    const blockedPoint = coverPointOf(resolution);
    // 预检只覆盖「点之前就已经被压住」的情况；弹层完全可能在这一次点击之后才弹出来
    mainCover = mainCover ?? (await probeMainCover(resolution));
    if (mainCover) {
      const mainPoint = blockedPoint ? toPagePoint(blockedPoint, offset) : null;
      const clearedMain = await clearIn(page, NO_OFFSET, mainPoint, "主文档");
      if (clearedMain) {
        clearedOverlay = clearedMain;
        mainCover = await probeMainCover(resolution);
      }
      if (mainCover) attempts.push(`主文档弹层「${mainCover}」仍压住该框架`);
    }
    if (!mainCover) {
      const clearedHere = await clearIn(scope, offset, blockedPoint, inFrame ? "框架" : "");
      if (clearedHere) {
        clearedOverlay = clearedHere;
        resolution = await resolve();
        outcome = await tryCandidatePoints(exec, resolution, {
          verifyChoice,
          anchorTarget: choiceTarget,
          maxAttempts,
        });
        attempts.push(...outcome.attempts);
        if (outcome.ok) {
          outcome = { ...outcome, method: "cleared-then-point" };
        } else {
          // 清障之后再评估一次原生兜底：此时若已无真实阻挡，它就是合法的降级路径
          await tryNativeActivate(resolution);
        }
      } else {
        /*
         * 清障拿不到计划（典型：输入框联想下拉 —— 层内没有探针认得的可点控件，
         * 仲裁根本看不到它）或清障失败 → 试一次**释放焦点**。
         *
         * 这类层是我们自己打字唤起的瞬态层：让输入框失焦或发 Escape 就会消失，
         * 而它偏偏盖住提交按钮（Google `div.pcTkSc`、百度联想框都是这个形态）。
         * 不做这一步，`blocked-by-overlay` 会是一个「一次清障都没试过」的死结论。
         */
        const dismissed = await releaseTransientFocus(scope);
        if (dismissed.released || dismissed.actions.length > 0) {
          resolution = await resolve();
          outcome = await tryCandidatePoints(exec, resolution, {
            verifyChoice,
            anchorTarget: choiceTarget,
            maxAttempts,
          });
          if (outcome.ok) {
            outcome = { ...outcome, method: "cleared-then-point" };
            clearedOverlay = {
              label: "输入框联想层（失焦后消失）",
              method: "focus-release",
              detail: dismissed.actions.join(" → "),
            };
            attempts.push(`释放焦点后目标已可点：${dismissed.actions.join(" → ")}`);
          } else {
            attempts.push(
              `释放焦点未生效（${dismissed.actions.join(" → ") || "无可失焦控件"}）：${outcome.attempts.join("；") || "候选点仍被遮挡"}`,
            );
          }
        }
      }
    }
  }

  // 只有「确实定位到了目标、但点击被压住」才算遮挡类失败；
  // 连目标都解析不到（选择器失配 / DOM 已变）不算遮挡，交由上层走兜底路径
  const blocked =
    !outcome.ok &&
    resolution.anchor != null &&
    (clearedOverlay != null || mainCover != null || fullyCovered(resolution));

  if (outcome.ok) {
    const afterState = verifyChoice ? await readChoiceSnapshot(scope, choiceTarget) : null;
    return {
      ok: true,
      method: outcome.method,
      blocked: false,
      clickedPoint: outcome.clickedPoint,
      associated: resolution.associated,
      checkedBefore,
      checkedAfter: outcome.checkedAfter ?? snapshotState(afterState),
      clearedOverlay,
      attempts,
      feedback: [
        describeHitPointResolution(resolution),
        clearedOverlay ? `已先清除遮挡「${clearedOverlay.label}」（${clearedOverlay.method}）` : "",
        verifyChoice ? `勾选态 ${checkedBefore} → ${outcome.checkedAfter ?? snapshotState(afterState)}` : "",
      ]
        .filter(Boolean)
        .join("；"),
      error: null,
    };
  }

  const rejectionHint = resolution.rejected.length
    ? `候选点被排除：${resolution.rejected
        .slice(0, 3)
        .map((r) => `(${r.x},${r.y}) ${r.reason}`)
        .join("；")}`
    : "无候选点";
  const coverHint = mainCover ? `；主文档遮挡层「${mainCover}」压住该框架` : "";

  return {
    ok: false,
    method: "none",
    blocked,
    clickedPoint: null,
    associated: resolution.associated,
    checkedBefore,
    checkedAfter: verifyChoice ? snapshotState(await readChoiceSnapshot(scope, choiceTarget)) : null,
    clearedOverlay,
    attempts,
    feedback: blocked
      ? `点击被遮挡层拦截且自动清障未成功：${rejectionHint}${coverHint}。建议先关闭/清除当前页面弹层后再重试本目标`
      : `未能定位可点击点：${resolution.error ?? "未知原因"}；${rejectionHint}${coverHint}`,
    error: resolution.error ?? "无可点击点",
  };
}
