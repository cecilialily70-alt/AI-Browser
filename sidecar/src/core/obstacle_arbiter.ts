/**
 * 遮挡层仲裁（Obstacle Arbiter）
 *
 * 职责：把 `overlay_probe` 采集到的结构化事实，变成**确定性的清障计划**，
 * 并可选地执行它（点击 → 回读验证 → 兜底）。
 *
 * 打分只用两类信息，均与站点无关：
 *   1. 词典先验（`interaction_lexicon.json`，数据文件，可整体替换/删除）
 *   2. 结构信号（图标按钮 / 角点邻近度 / 面积占比 / dismiss 属性 / 指针手势 …）
 *
 * 同构层防死循环：以 `fingerprint` 为单位记录尝试次数，超过上限后不再自动点击，
 * 转而把「清障失败」的事实交给上层（回灌模型决策）。
 */
import {
  NO_OFFSET,
  scopePage,
  toPagePoint,
  type DomScope,
  type FrameOffset,
} from "./dom_scope.js";
import {
  lexiconGlyphHit,
  lexiconIntentPriority,
  loadInteractionLexicon,
  type ControlIntent,
  type InteractionLexicon,
} from "./interaction_lexicon.js";
import {
  probeOverlays,
  type OverlayControlCandidate,
  type OverlayDescriptor,
  type OverlayProbeResult,
} from "./overlay_probe.js";

/** 每个同构遮挡层的自动清障尝试上限 */
export const MAX_OVERLAY_ATTEMPTS_PER_FINGERPRINT = 2;

export interface TransientDismissResult {
  /** 实际做了什么（人类可读，进 attempts 日志） */
  actions: string[];
  /** 是否真的让一个可编辑控件失去了焦点 */
  released: boolean;
}

/**
 * 释放焦点 / 打发瞬态层。
 *
 * 为什么需要这一招（用户现场）：在引擎搜索框里打完字，站点会挂出一个**自动完成/联想下拉**。
 * 这类层有两个要命特征，让既有清障路径**完全失效**：
 *   ① 层内没有探针认得的可点控件 → `overlay_probe` 的 `hasClickable` 判定把它整个丢掉，
 *      `planObstacleClear` 连计划都生不出来（"未检测到遮挡层"）→ Escape 兜底也不会执行；
 *   ② 它偏偏**盖住了提交按钮**（Google 的 `div.pcTkSc` 就是它的容器）→ 点击被永久判成
 *      `blocked-by-overlay`，而自动清障**一次都没试过**。
 * 真人此时的动作极其朴素：Esc，或者让输入框失焦。这里就把这个动作固化成兜底。
 *
 * 只在**点击已经失败之后**调用（`precise_click` 的遮挡分支）。因此不会打断
 * 「点击联想项」这类正常流程 —— 那种情况下目标本身就在层内，不会被判成被遮挡。
 */
export async function releaseTransientFocus(page: DomScope): Promise<TransientDismissResult> {
  const actions: string[] = [];
  let released = false;
  try {
    const active = (await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const tag = el.tagName.toLowerCase();
      const NON_EDITABLE_INPUTS = ["button", "submit", "reset", "checkbox", "radio", "file", "image"];
      const editable =
        tag === "textarea" ||
        tag === "select" ||
        el.isContentEditable === true ||
        (tag === "input" && !NON_EDITABLE_INPUTS.includes((el as HTMLInputElement).type));
      if (!editable) return null;
      const name = el.getAttribute("name");
      const described = `${tag}${name ? `[name=${name}]` : ""}`;
      el.blur();
      return described;
    })) as string | null;
    if (active) {
      released = true;
      actions.push(`已让输入控件失焦（${active}）`);
    }
  } catch {
    /* 尽力而为：跨域 / 文档已销毁都不该中断点击链 */
  }
  try {
    await scopePage(page).keyboard.press("Escape");
    actions.push("已发送 Escape");
    await page.waitForTimeout(180);
  } catch {
    /* 同上 */
  }
  return { actions, released };
}

const UNMATCHED_BASE = 20;
const INTENT_BASE = 100;
const INTENT_STEP = 10;

export interface RankedOverlayControl {
  index: number;
  selector: string;
  xpath: string;
  name: string;
  tag: string;
  role: string;
  /** 词典判定的语义意图；null 表示词典未命中（不致命，仅降权） */
  intent: ControlIntent | null;
  /** 命中 glyph（✕ / × / x 等） */
  glyph: boolean;
  iconOnly: boolean;
  x: number;
  y: number;
  score: number;
  signals: string[];
}

export type ObstacleFallback =
  | { kind: "click_point"; x: number; y: number; reason: string }
  | { kind: "press"; key: string; reason: string };

export interface ObstacleClearPlan {
  fingerprint: string;
  overlayKey: string;
  label: string;
  coverRatio: number;
  topmostAtCenter: boolean;
  /** 首选点击控件；null 表示层内没有可用控件，只能靠兜底动作 */
  control: RankedOverlayControl | null;
  /** 兜底动作（按序尝试） */
  fallbacks: ObstacleFallback[];
  /** 诊断说明，用于日志与回灌模型 */
  reason: string;
  /** 该同构层此前已被自动尝试的次数 */
  previousAttempts: number;
}

export interface ObstaclePlanResolution {
  plan: ObstacleClearPlan | null;
  overlay: OverlayDescriptor | null;
  probe: OverlayProbeResult;
  reason: string;
}

export interface ObstacleApplyResult {
  ok: boolean;
  /** control-click / backdrop-click / escape / none */
  method: string;
  actor: string;
  detail: string;
}

const attemptRegistry = new Map<string, number>();

function attemptKey(url: string, fingerprint: string): string {
  return `${url}::${fingerprint || "unknown"}`;
}

export function overlayAttemptCount(url: string, fingerprint: string): number {
  return attemptRegistry.get(attemptKey(url, fingerprint)) ?? 0;
}

export function noteOverlayAttempt(url: string, fingerprint: string): number {
  const key = attemptKey(url, fingerprint);
  const next = (attemptRegistry.get(key) ?? 0) + 1;
  attemptRegistry.set(key, next);
  return next;
}

export function resetOverlayAttempts(): void {
  attemptRegistry.clear();
}

/** 点是否落在层矩形内（向内收 2px，避免边界抖动误判） */
export function overlayBlocksPoint(overlay: OverlayDescriptor, x: number, y: number): boolean {
  const r = overlay.rect;
  return x >= r.x + 2 && x <= r.x + r.w - 2 && y >= r.y + 2 && y <= r.y + r.h - 2;
}

/**
 * 按「清障有效性」给层内控件打分排序。
 * 语义先验（close → defer → reject → accept → submit）优先，结构信号用于打破平局。
 */
export function rankOverlayControls(
  overlay: OverlayDescriptor,
  lexicon: InteractionLexicon | null,
): RankedOverlayControl[] {
  const ranked: RankedOverlayControl[] = [];

  for (const control of overlay.controls) {
    if (control.disabled) continue;
    if (control.kind !== "control") continue;
    const priority = lexiconIntentPriority(control.name, lexicon);
    const glyph = lexiconGlyphHit(control.name, lexicon);
    const signals = control.signals ?? [];

    let score = priority === null ? UNMATCHED_BASE : INTENT_BASE - priority * INTENT_STEP;
    if (glyph) score += 25;
    if (signals.includes("dismiss-attr")) score += 30;
    if (signals.includes("glyph-host")) score += 6;
    if (signals.includes("button-semantic")) score += 3;
    if (signals.includes("cursor:pointer")) score += 2;
    if (control.iconOnly) score += 8;
    if (control.hasAriaLabel) score += 4;
    score += control.cornerAffinity * 12;
    score += (1 - Math.min(1, control.areaRatio)) * 8;
    if (priority === null && control.name.length > 24) score -= 12;

    ranked.push({
      index: control.index,
      selector: control.selector,
      xpath: control.xpath,
      name: control.name || control.tag,
      tag: control.tag,
      role: control.role,
      intent: priority === null ? null : priorityToIntent(priority, lexicon),
      glyph,
      iconOnly: control.iconOnly,
      x: Math.round(control.rect.x + control.rect.w / 2),
      y: Math.round(control.rect.y + control.rect.h / 2),
      score: Number(score.toFixed(2)),
      signals,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function priorityToIntent(
  priority: number,
  lexicon: InteractionLexicon | null,
): ControlIntent | null {
  if (!lexicon) return null;
  for (const [category, value] of Object.entries(lexicon.intentPriority)) {
    if (value === priority) return category as ControlIntent;
  }
  return null;
}

/** 矩形是否包含点 */
function rectContains(rect: { x: number; y: number; w: number; h: number } | null, x: number, y: number): boolean {
  if (!rect) return false;
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/** 点是否落在该层自身的某个控件上（说明目标就是层内内容，不构成遮挡） */
function pointOnOwnControl(overlay: OverlayDescriptor, x: number, y: number): boolean {
  return (overlay.controls ?? []).some(
    (control) =>
      control.kind === "control" &&
      x >= control.rect.x &&
      x <= control.rect.x + control.rect.w &&
      y >= control.rect.y &&
      y <= control.rect.y + control.rect.h,
  );
}

/** 为某个被遮挡的点生成清障计划（不再自动点击已超限的同构层） */
export function planObstacleClear(
  probe: OverlayProbeResult,
  point: { x: number; y: number } | null,
  lexicon: InteractionLexicon | null = loadInteractionLexicon(),
): ObstaclePlanResolution {
  const overlays = Array.isArray(probe?.overlays) ? probe.overlays : [];
  if (!overlays.length) {
    return { plan: null, overlay: null, probe, reason: "未检测到遮挡层" };
  }

  // 无坐标 = 通用预检：直接在最上层里找清障控件
  let pool = overlays;

  if (point) {
    const covering = overlays.filter((overlay) => overlayBlocksPoint(overlay, point.x, point.y));
    if (!covering.length) {
      return { plan: null, overlay: null, probe, reason: "目标点未被任何层覆盖，无需清障" };
    }
    // 点位落在层内对话框 / 层内控件上 → 那是「交互目标本身」，不是遮挡，绝不能关掉它
    const actionable = covering.filter(
      (overlay) =>
        !rectContains(overlay.dialogRect, point.x, point.y) &&
        !pointOnOwnControl(overlay, point.x, point.y),
    );
    if (!actionable.length) {
      return {
        plan: null,
        overlay: covering[0] ?? null,
        probe,
        reason: "目标点位于弹层内部内容上，属于正常交互目标，不做清障",
      };
    }
    pool = actionable;
  }

  let best: { plan: ObstacleClearPlan; overlay: OverlayDescriptor } | null = null;
  let exhaustedBest: { plan: ObstacleClearPlan; overlay: OverlayDescriptor } | null = null;

  for (const overlay of pool) {
    const ranked = rankOverlayControls(overlay, lexicon);
    const control = ranked[0] ?? null;
    const previousAttempts = overlayAttemptCount(probe.url, overlay.fingerprint);

    const fallbacks: ObstacleFallback[] = [];
    if (overlay.backdropPoint) {
      fallbacks.push({
        kind: "click_point",
        x: overlay.backdropPoint.x,
        y: overlay.backdropPoint.y,
        reason: "点击层内空白区域（对话框之外）",
      });
    }
    fallbacks.push({ kind: "press", key: "Escape", reason: "发送 Escape 关闭对话框" });

    const plan: ObstacleClearPlan = {
      fingerprint: overlay.fingerprint,
      overlayKey: overlay.key,
      label: overlay.label || overlay.className || overlay.tag,
      coverRatio: overlay.coverRatio,
      topmostAtCenter: overlay.topmostAtCenter,
      control,
      fallbacks,
      reason: control
        ? `层内控件按词典+结构排序，首选「${control.name}」${
            control.intent ? `（意图 ${control.intent}）` : "（词典未命中，靠结构信号）"
          }，得分 ${control.score}`
        : "层内无可点击控件，仅剩 backdrop / Escape 兜底",
      previousAttempts,
    };

    const rankScore =
      (overlay.topmostAtCenter ? 1_000_000 : 0) +
      Math.round(overlay.coverRatio * 10_000) +
      (control ? control.score : 0);

    if (previousAttempts >= MAX_OVERLAY_ATTEMPTS_PER_FINGERPRINT) {
      if (!exhaustedBest || rankScore > exhaustedScore(exhaustedBest)) {
        exhaustedBest = { plan, overlay };
      }
      continue;
    }
    if (!best || rankScore > exhaustedScore(best)) {
      best = { plan, overlay };
    }
  }

  if (best) {
    return { plan: best.plan, overlay: best.overlay, probe, reason: best.plan.reason };
  }
  if (exhaustedBest) {
    return {
      plan: exhaustedBest.plan,
      overlay: exhaustedBest.overlay,
      probe,
      reason: `同一结构（指纹 ${exhaustedBest.plan.fingerprint}）已自动尝试 ${exhaustedBest.plan.previousAttempts} 次仍未消除，建议交由决策模型处理`,
    };
  }
  return { plan: null, overlay: null, probe, reason: "未检测到遮挡层" };
}

function exhaustedScore(entry: { plan: ObstacleClearPlan }): number {
  return Math.round(entry.plan.coverRatio * 10_000) + (entry.plan.control?.score ?? 0);
}

/** 采集 + 仲裁：给定被遮挡的点，返回可执行清障计划 */
export async function resolveObstaclePlan(
  page: DomScope,
  point: { x: number; y: number } | null,
  lexicon: InteractionLexicon | null = loadInteractionLexicon(),
): Promise<ObstaclePlanResolution> {
  const probe = await probeOverlays(page);
  return planObstacleClear(probe, point, lexicon);
}

interface ClearCheck {
  fingerprint: string;
  point: { x: number; y: number } | null;
}

async function isOverlayCleared(page: DomScope, check: ClearCheck): Promise<boolean> {
  const probe = await probeOverlays(page);
  const sameFingerprint = probe.overlays.filter(
    (overlay) => overlay.fingerprint === check.fingerprint,
  );
  if (sameFingerprint.length) return false;
  if (check.point) {
    return !probe.overlays.some((overlay) => overlayBlocksPoint(overlay, check.point!.x, check.point!.y));
  }
  return probe.overlays.length === 0;
}

/**
 * 执行清障计划：控件点击 → backdrop → Escape，每步都回读验证。
 * `offset` 是嵌套框架相对主文档视口的偏移：计划里的控件坐标是**框架局部**坐标，
 * 而物理鼠标点击只认主文档视口坐标 —— 换算只在这一处发生。
 *
 * 返回真实生效的方式；全部失败时 `ok=false`，由上层决定回灌模型还是转人工。
 */
export async function applyObstaclePlan(
  page: DomScope,
  plan: ObstacleClearPlan,
  point: { x: number; y: number } | null,
  offset: FrameOffset = NO_OFFSET,
): Promise<ObstacleApplyResult> {
  const attempts: string[] = [];
  const actor = plan.control?.name ?? plan.label;
  const owner = scopePage(page);

  if (plan.previousAttempts >= MAX_OVERLAY_ATTEMPTS_PER_FINGERPRINT) {
    return {
      ok: false,
      method: "none",
      actor,
      detail: `同构遮挡层（指纹 ${plan.fingerprint}）已自动清障 ${plan.previousAttempts} 次仍未消除，停止自动重试以避免死循环`,
    };
  }

  const verify = async (method: string, actorName: string): Promise<ObstacleApplyResult | null> => {
    await page.waitForTimeout(220);
    if (await isOverlayCleared(page, { fingerprint: plan.fingerprint, point })) {
      noteOverlayAttempt(page.url(), plan.fingerprint);
      return { ok: true, method, actor, detail: attempts.join(" → ") };
    }
    attempts.push(`${method}(${actorName}) 未生效`);
    return null;
  };

  if (plan.control) {
    try {
      const target = toPagePoint({ x: plan.control.x, y: plan.control.y }, offset);
      await owner.mouse.click(target.x, target.y);
      const done = await verify("control-click", plan.control.name);
      if (done) return done;
    } catch (error) {
      attempts.push(`control-click 抛错：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const fallback of plan.fallbacks) {
    try {
      if (fallback.kind === "click_point") {
        const target = toPagePoint({ x: fallback.x, y: fallback.y }, offset);
        await owner.mouse.click(target.x, target.y);
        const done = await verify("backdrop-click", `${fallback.x},${fallback.y}`);
        if (done) return done;
      } else {
        await owner.keyboard.press(fallback.key);
        const done = await verify("escape", fallback.key);
        if (done) return done;
      }
    } catch (error) {
      attempts.push(
        `${fallback.kind} 抛错：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  noteOverlayAttempt(page.url(), plan.fingerprint);
  return {
    ok: false,
    method: "none",
    actor: plan.control?.name ?? plan.label,
    detail: attempts.join(" → ") || "无可用清障动作",
  };
}
