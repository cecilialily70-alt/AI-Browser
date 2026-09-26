/**
 * Arbiter 单一裁决树（Phase 3.0 基建 · **尚未接线**）
 *
 * 目标：把散落在主循环里的 nudge 判断收成**一个出口**。以前「要不要收敛到验证码」
 * 「要不要硬停」「要不要重规划」分散在十几处 if/else 与正则里，各自为政、互相冲突。
 * 现在只有这里做裁决。
 *
 * ⚠️ 一条与主计划不同的关键设计（必须说明）：
 *   主计划写的是六级状态机。但现有引擎的 nudge 是**累加**的 —— 同一个页面可以同时给出
 *   「页面含验证码」+「需理解页面」+「这是最后一步」三条引导。若严格按互斥实现，
 *   同页只会剩最高级那条，**提示词被静默改变**，这正是"零行为变更"最怕的事。
 *
 *   因此本文件把两件事拆开：
 *     · `state` —— **互斥**，只用于裁决（升级 consult / 硬停 / 收敛）；
 *     · `nudges` —— **累加**，按既有顺序逐字复刻引导。
 *   这样既得到单一裁决树，又保证提示词一字不变。
 *
 * 纯函数纪律：本文件**不做任何 I/O**（不碰浏览器、不发 LLM、不写日志、不读时间）。
 * 所有事实由调用方组装成 `FactSheet` 传入。因此它可以被 100% 离线单测覆盖。
 */
import type { PageKindVerdict, PageKindCaptchaHint } from "../core/page_kind.js";
import type { ConsultRoute } from "./consult_contract.js";

/** 升级路由只能是闭集里的 plan_conflict（编译期绑定：闭集若删了它会立刻报错） */
type EscalationRoute = Extract<ConsultRoute, "plan_conflict">;

/* ───────────────────────── 状态（互斥） ───────────────────────── */

export type AgentState =
  /** 政策硬闸：不可协商（能力缺失、人工验证码、步数耗尽） */
  | "policy_blocked"
  /** 阻断闸门：当前页有必须先把路让开的东西（验证码 / 遮挡层） */
  | "blocked"
  /** 计划矛盾：页面事实与计划项期望相悖 */
  | "consult_conflict"
  /** 契约推进：还有未核销的必交交付物 */
  | "executing"
  /** 完成判定：证据齐了，该收尾/回答 */
  | "finishing"
  /** 自由探索：交给执行模型 */
  | "exploring";

/* ───────────────────────── 事实（世界模型） ───────────────────────── */

/**
 * 循环/停滞信号。
 *
 * 阈值判定放在本文件（政策单一出口），**启用与否**由调用方按 settings 决定
 * （例如 loopDetectionEnabled 关闭时传 `loopRepeatMax: 0`）。
 */
export interface ArbiterSignals {
  /** 步数已过 75%：只提醒不要提前收尾，不是完成配额 */
  stepBudgetSoftWarn: boolean;
  /** 近期窗口内同一动作的最大重复次数；0 = 未启用循环检测 */
  loopRepeatMax: number;
  /** 页面指纹连续未变化步数 */
  stagnantPages: number;
  /** 探索太久还没建立计划 */
  planMissingTooLong: boolean;
  /** 连续失败次数已达阈值 */
  failuresTooMany: boolean;
}

/**
 * 客观事实集。**只放事实，不放判断**：
 * 每一项都能追溯到"某处观测到了什么"，而不是"某处正则匹配了什么"。
 */
export interface FactSheet {
  url: string;
  title: string;
  pageKind: PageKindVerdict;
  captcha: PageKindCaptchaHint;
  /**
   * 本轮观察是否成功（`pack && !pack.softError`）。
   * 观察失败时**不得**凭结构判定「图标含糊」——那是拿不到证据却下结论。
   */
  observationOk: boolean;
  digestReady: boolean;
  /** 证据层确认「目标检索词确实出现在页面上」 */
  queryMatched: boolean;
  /** 仍未核销的必交交付物数量 */
  pendingDeliverables: number;
  /** 目标本身需要"读懂并告知"（来自 P0 `kind === "understand"`） */
  needsUnderstanding: boolean;
  /** 当前计划项本身是"理解/提取"类 */
  planNeedsUnderstanding: boolean;
  /** 目标在打开/搜索之外还有后续交付动作（来自 P0 `needsFollowup`） */
  hasFollowup: boolean;
  /** 本地核对的期望违反项（空 = 不矛盾） */
  expectsViolations: string[];
  /** 页面入口多为无文字图标（本地分类器产出） */
  iconAmbiguous: boolean;
  /** 页面上"验证答案"类目标控件（存在时才谈验证码收尾） */
  captchaVerifyTarget: { index: number; label: string } | null;
  /**
   * 目标是否要求处理验证码。
   *
   * 这是"目标语义"而非"页面事实"——现阶段由本地词表给出（L4），
   * 将来应改由 P0 意图产出。**必须保留这一项**：既有引擎在"目标提到验证码但页面上
   * 还没找到目标控件"时也会给出通用引导，少了它会静默丢掉一条 nudge。
   */
  captchaIntent: boolean;
  /** 上一轮已填入但尚未验证通过 */
  captchaFilledPending: boolean;
  /** 上一轮工具回执要求"下一轮只 click" */
  captchaToolAsksClick: boolean;
  signals: ArbiterSignals;
}

export interface ArbiterInput {
  facts: FactSheet;
  step: number;
  maxSteps: number;
  /** 能力政策：是否配置了视觉模型 */
  visionConfigured: boolean;
  /** 能力政策：目标是否需要视觉定位（保留本地判定，属基础设施路由，不属语义判断） */
  goalNeedsVisualLocate: boolean;
  /** consult 总线当前是否可用（预算够、未中止）。不可用时矛盾只能落回本地兜底 */
  consultAvailable: boolean;
  captchaMaxFails?: number;
}

export interface ArbiterDecision {
  state: AgentState;
  reason: string;
  nudges: string[];
  /** 硬停：调用方应立即结束任务 */
  halt?: { summary: string; success: boolean };
  /** 升级到 consult（仅计划矛盾用；不可用时为 undefined） */
  escalate?: { route: EscalationRoute; reason: string; violations: string[] };
}

export const DEFAULT_CAPTCHA_MAX_FAILS = 3;

/** 与 service.ts 中同名常量**逐字一致**（由 phase3-arbiter.mjs 的迁移完整性断言看守） */
export const VISION_CAPABILITY_ERROR =
  "当前页面入口多为图标/图片，任务需要视觉定位，但未配置视觉模型（vision）。" +
  "请到「设置 → AI」填写视觉模型后重试。不要用 ask_user 猜测要点哪个图标——下次点任意图片入口同样需要视觉能力。";

/** 循环检测阈值（政策单一出口；调用方只需决定"是否启用"） */
export const LOOP_REPEAT_THRESHOLD = 3;
export const STAGNANT_PAGES_THRESHOLD = 3;

/* ───────────────────────── 引导文本（逐字复刻既有引擎） ───────────────────────── */

const NUDGE_STEP_BUDGET =
  "任务还没做完就继续。结束只由 done 判断：完成且有证据才 success=true，确认做不下去才 success=false。不要因为步数提前收尾。";
const NUDGE_PLAN_MISSING = "探索已足够，请输出 plan_update 建立计划后再推进。";
const NUDGE_FAILURES = "连续失败较多，请修订 plan_update 并换路径。";
export const NUDGE_LAST_STEP =
  "这是防死循环的保险丝，不是完成标准。目标已完成就 done(success=true)；仍未完成就 done(success=false) 并说明卡在哪。";
const NUDGE_INLINE_CAPTCHA =
  "【页面含验证码】本页有验证码控件：处理到它时用 solve_captcha（勿手点/勿猜）；验证未通过前禁止 done(success=true)。不必为它中止其它正常步骤。";
const NUDGE_CAPTCHA_GENERIC =
  "验证码：本轮唯一动作 solve_captcha（自动分发 GIF/滑块/算式）。失败勿换别名空转；未支持类型勿死磕；禁止刷新。";
const NUDGE_VISION_LOCATE =
  "当前页多为无文字图标：本步优先 ask_vision_locate(query=清晰描述要点的控件形态，click=true)；禁止 ask_user，禁止瞎点 button。";
const NUDGE_UNDERSTAND_NO_DIGEST =
  "需要理解页面但暂无 page_digest：先 search_page 或 extract(query=用户问题)，拿到内容后再 done。";

/* ───────────────────────── 引导构建 ───────────────────────── */

export function signalNudges(
  signals: ArbiterSignals,
  loopRepeatThreshold = LOOP_REPEAT_THRESHOLD,
  stagnantPagesThreshold = STAGNANT_PAGES_THRESHOLD,
): string[] {
  const nudges: string[] = [];
  if (signals.stepBudgetSoftWarn) nudges.push(NUDGE_STEP_BUDGET);
  if (signals.loopRepeatMax >= loopRepeatThreshold) {
    nudges.push(
      `<sys>检测到相似动作在近期窗口内重复 ${signals.loopRepeatMax} 次。请更换策略，勿机械重试同一操作。</sys>`,
    );
  }
  if (signals.stagnantPages >= stagnantPagesThreshold) {
    nudges.push(
      `<sys>页面指纹连续 ${signals.stagnantPages} 步未变化。请尝试滚动、换入口、search_page，或 ask_user/handover。</sys>`,
    );
  }
  if (signals.planMissingTooLong) nudges.push(NUDGE_PLAN_MISSING);
  if (signals.failuresTooMany) nudges.push(NUDGE_FAILURES);
  return nudges;
}

/**
 * 验证码引导（对应既有「目标含验证码」那一段）。
 *
 * 触发条件是**目标意图**而非页面控件（与既有引擎一致）：
 * 目标提到验证码时，即使页面上还没找到目标控件，也要给出通用引导。
 */
function captchaTargetNudges(facts: FactSheet): string[] {
  if (!facts.captchaIntent) return [];
  const target = facts.captchaVerifyTarget;
  if (target && (facts.captchaFilledPending || facts.captchaToolAsksClick)) {
    return [
      `验证码收尾：本步唯一动作 click(index=${target.index})「${target.label}」。禁止再 solve_captcha，禁止空等。`,
    ];
  }
  if (target) {
    return [
      `验证码：优先本轮唯一动作 solve_captcha。若工具失败但已心算答案，下一轮单独 input(答案)+click（勿与 solve_captcha 同轮；browser_state 已有「${target.label}」index=${target.index}）。禁止空等。`,
    ];
  }
  return [NUDGE_CAPTCHA_GENERIC];
}

/** 验证码闸门引导（运行期闸门，与目标措辞无关） */
function captchaGateNudges(facts: FactSheet, captchaMaxFails: number): string[] {
  const captcha = facts.captcha;
  if (!captcha.present) return [];
  if (captcha.interstitial) {
    // ⚠️ 分支顺序**逐字对齐既有引擎**（`strategy` 先于 `nonImage`）。
    // 两者同时为真时，既有引擎给的是 strategy 文案，且运行期「强制 solve_captcha」的闸门
    // 也只在 `!captchaGate.strategy` 时才走转人工 —— 所以 strategy 才是这里的优先事实。
    // 若按 nonImage 优先，会在这种罕见组合下**静默换掉**给模型的引导（行为变更）。
    if (captcha.strategy) {
      return [
        `【验证码闸门】整页就是一道人机验证（${captcha.strategy}）。本步唯一动作必须是 solve_captcha；禁止 navigate/done/重复提交；失败满 ${captchaMaxFails} 次将转人工。`,
      ];
    }
    if (captcha.nonImage) {
      return [
        "【验证码闸门】整页需要短信/邮箱/验证器动态码：邮箱码优先 fetch_email_otp（网页邮箱须显式启用，禁止自己打开邮箱或改指纹）；短信码优先 fetch_sms_otp（须显式启用）；验证器用 ask_user；禁止猜测/编造；禁止 done(success=true)。",
      ];
    }
    return [
      "【验证码闸门】整页像人机验证但类型未支持：优先 solve_captcha 尝试；仍失败请 handover_to_human，禁止刷新/重复 navigate。",
    ];
  }
  return [NUDGE_INLINE_CAPTCHA];
}

/** 理解/SERP 引导（对应既有 digest 分支的三选一） */
function understandingNudges(facts: FactSheet): string[] {
  if (facts.digestReady && (facts.needsUnderstanding || facts.planNeedsUnderstanding)) {
    if (facts.hasFollowup && !facts.needsUnderstanding) {
      return [
        "本步需理解页面：可先用 <page_digest> 记下已读到的内容，但**目标还有后续交付动作**（下载/保存/点击栏目/打开第 N 项…），禁止就此 done；先完成那些动作并留下可验证结果。",
      ];
    }
    return [
      "本步需理解/总结/分析：请根据 <page_digest> **用自己的话写结论**（遵守用户字数要求），再单独调用 done(text=结论)。" +
        "禁止把 page_digest /【页面阅读】原文整段贴进 done；禁止空转观察；仅当摘要明显不足时再 extract 一次。",
    ];
  }
  // ⚠️ 这里必须用 `serpLike`（宽松），不能用 `engineSerp`（严格）——
  // 既有引擎用的是 isSearchResultsUrl（宽松并集），换成严格会丢掉未登记引擎的收尾能力。
  if (facts.digestReady && facts.pageKind.serpLike && !facts.needsUnderstanding) {
    if (facts.hasFollowup) {
      return [
        "搜索结果页只是中途站：目标里还有后续交付动作（下载/保存/点击栏目/打开第 N 项/切换频道…），请按当前计划项继续推进，勿在此 done。",
      ];
    }
    return [
      facts.queryMatched
        ? "搜索类目标：结果页已可读（见 page_digest）。请立即 done(success=true)，text 简要确认已搜到关键词即可，勿再分析整页。"
        : "已在搜索结果页：对照 page_digest 确认查询词是否匹配；匹配则 done，不匹配则修正搜索后 done。",
    ];
  }
  if (facts.planNeedsUnderstanding && !facts.digestReady) {
    return [NUDGE_UNDERSTAND_NO_DIGEST];
  }
  return [];
}

/* ───────────────────────── 各闸门判定 ───────────────────────── */

/** L1-a：需要视觉定位但没配视觉模型 —— 能力政策，直接硬停（重试不会变出模型） */
function needsVisionHalt(input: ArbiterInput): boolean {
  const { facts } = input;
  return facts.observationOk && facts.iconAmbiguous && input.goalNeedsVisualLocate && !input.visionConfigured;
}

/** L1-b：整页要求只有用户本人能提供的码 —— OTP 强制人工，属 HITL 政策 */
function isHumanOnlyGate(input: ArbiterInput): boolean {
  const captcha = input.facts.captcha;
  /*
   * ⚠️ `!captcha.strategy` 这个条件**不是可选的**，它必须与既有运行期闸门逐字对齐：
   *   既有闸门的「强制 solve_captcha」分支条件是 `captcha.strategy` 为真；
   *   而「转人工」分支额外要求 `!captcha.strategy`。
   * 也就是说当 OTP 特征与可自动求解策略**同时**出现时，既有引擎选择**自动求解**、不交人。
   * 少了这个条件，接管后会在这种组合上误转人工 —— 把一道本来可解的验证码推给用户，
   * 这是比"多花几次尝试"严重得多的错误。
   */
  return captcha.present && captcha.interstitial && captcha.nonImage && !captcha.strategy;
}

/** L1-c：步数保险丝到了 —— 停止空转。本步仍由模型决定成功或失败 */
function isStepBudgetExhausted(input: ArbiterInput): boolean {
  return input.step >= input.maxSteps;
}

/** L2：是否处于阻断闸门 */
function isBlocked(input: ArbiterInput): boolean {
  const captcha = input.facts.captcha;
  if (captcha.present) return true;
  return input.facts.pageKind.hasBlockingOverlay;
}

/* ───────────────────────── 主裁决 ───────────────────────── */

/**
 * 单一裁决：先定 `state`（互斥，按优先级取第一个命中），再按**既有顺序**累加 `nudges`。
 *
 * 优先级：政策硬闸 > 阻断闸门 > 计划矛盾 > 契约推进 > 完成判定 > 自由探索。
 * 这个顺序表达的是"谁先被解决"：政策不可协商，拥堵要先让路，
 * 计划错了要先改计划，都对了才谈推进与收尾。
 */
export function arbitrate(input: ArbiterInput): ArbiterDecision {
  const { facts } = input;
  const captchaMaxFails = input.captchaMaxFails ?? DEFAULT_CAPTCHA_MAX_FAILS;

  /* ——— 先算 nudges（累加，顺序 = 既有引擎顺序） ——— */
  const nudges: string[] = [
    ...signalNudges(facts.signals),
    ...captchaTargetNudges(facts),
    ...captchaGateNudges(facts, captchaMaxFails),
  ];
  // 图标含糊 + 有视觉能力 → 引导走视觉定位；无能力的情况在 L1 已硬停
  if (facts.observationOk && facts.iconAmbiguous && input.goalNeedsVisualLocate && input.visionConfigured) {
    nudges.push(NUDGE_VISION_LOCATE);
  }
  nudges.push(...understandingNudges(facts));
  if (isStepBudgetExhausted(input)) nudges.push(NUDGE_LAST_STEP);

  /* ——— 再定 state（互斥） ——— */
  const violations = facts.expectsViolations;

  let state: AgentState;
  let reason: string;
  let halt: ArbiterDecision["halt"];
  let escalate: ArbiterDecision["escalate"];

  if (needsVisionHalt(input)) {
    state = "policy_blocked";
    reason = "需要视觉定位但未配置视觉模型（能力政策）";
    halt = { summary: VISION_CAPABILITY_ERROR, success: false };
  } else if (isHumanOnlyGate(input)) {
    state = "policy_blocked";
    reason = "整页要求本人专有验证码，机器不可能获得（HITL 政策：转人工）";
  } else if (isStepBudgetExhausted(input)) {
    state = "policy_blocked";
    reason = `步数保险丝到了（step=${input.step} / maxSteps=${input.maxSteps}），本步仍由模型决定成功或失败`;
  } else if (isBlocked(input)) {
    state = "blocked";
    reason = facts.pageKind.hasBlockingOverlay
      ? "存在阻断性遮挡层（由清障路径处理）"
      : facts.captcha.interstitial
        ? "整页人机验证闸门"
        : "页内含验证码控件";
  } else if (violations.length > 0) {
    state = "consult_conflict";
    reason = `计划项期望未满足：${violations[0]}`;
    if (input.consultAvailable) {
      escalate = { route: "plan_conflict", reason, violations };
    }
  } else if (facts.pendingDeliverables > 0) {
    state = "executing";
    reason = `仍有 ${facts.pendingDeliverables} 项必交交付物未核销`;
  } else if (
    (facts.digestReady && (facts.needsUnderstanding || facts.planNeedsUnderstanding)) ||
    (facts.digestReady && facts.pageKind.serpLike)
  ) {
    state = "finishing";
    reason = facts.needsUnderstanding || facts.planNeedsUnderstanding ? "已具备可读内容，可作答收尾" : "结果页已可读，可收尾";
  } else {
    state = "exploring";
    reason = "无需干预，交执行模型决策";
  }

  return { state, reason, nudges, ...(halt ? { halt } : {}), ...(escalate ? { escalate } : {}) };
}
