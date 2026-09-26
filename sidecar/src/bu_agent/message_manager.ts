import { createHash } from "node:crypto";
import {
  LOOP_REPEAT_THRESHOLD,
  STAGNANT_PAGES_THRESHOLD,
  signalNudges,
  type ArbiterSignals,
} from "./arbiter.js";
import { coercePlanSteps, inheritPlanExpects, type PlanExpects } from "./plan_expects.js";
import type {
  ActionResult,
  AgentAction,
  AgentOutput,
  AgentSettings,
  HistoryItem,
  PageFingerprint,
  PlanItem,
  PlanStep,
} from "./views.js";

export class MessageManager {
  history: HistoryItem[] = [];
  compactedMemory: string | null = null;
  plan: PlanItem[] = [];
  readStateBuffer: string | null = null;
  private recentActionHashes: string[] = [];
  private consecutiveStagnantPages = 0;
  private lastFingerprint: PageFingerprint | null = null;
  private consecutiveFailures = 0;
  private stepsWithoutPlan = 0;

  constructor(private readonly settings: AgentSettings) {}

  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  appendStep(output: AgentOutput, results: ActionResult[]): void {
    this.history.push({
      stepNumber: this.history.length + 1,
      evaluationPreviousGoal: output.evaluation_previous_goal,
      memory: output.memory,
      nextGoal: output.next_goal,
      actionResults: results,
      actions: output.action,
    });
    if (this.settings.maxHistoryItems && this.history.length > this.settings.maxHistoryItems) {
      this.history = this.history.slice(-this.settings.maxHistoryItems);
    }
    this.collectReadState(results);
    this.applyPlanUpdate(output);
  }

  private collectReadState(results: ActionResult[]): void {
    const chunks: string[] = [];
    for (const r of results) {
      if (r.includeExtractedContentOnlyOnce && r.extractedContent) {
        chunks.push(r.extractedContent);
      }
    }
    this.readStateBuffer = chunks.length ? chunks.join("\n\n") : null;
  }

  consumeReadState(): string | null {
    const v = this.readStateBuffer;
    this.readStateBuffer = null;
    return v;
  }

  applyPlanUpdate(output: AgentOutput): void {
    if (!this.settings.enablePlanning || this.settings.flashMode) return;
    // 双形态解析：字符串与 `{text, expects}` 都接受。这里以前是 `map((text, i) => ({text, ...}))`，
    // 对象形态会在**更上游**（prompts 的 filter）就被静默丢掉，所以本函数从未见过 expects。
    const steps = coercePlanSteps(output.plan_update);
    if (steps.length) {
      // 落盘期望前的**唯一**安全规则：带文本校验的同 index 继承。
      // plan_update 是整表替换，模型可能重排/合并计划；纯 index 继承会把「打开登录页」的期望
      // 挂到「下载附件」上 —— 不报错，只会让 3.3 的 Arbiter 在错误事实上判矛盾。
      // 宁可安全退化为"无期望"，也绝不继承错的（见 plan_expects.expectationInheritanceAllowed）。
      const resolved = inheritPlanExpects(this.plan, steps);
      this.plan = resolved.map((step, i) => ({
        text: step.text,
        status:
          typeof output.current_plan_item === "number" && output.current_plan_item === i
            ? ("current" as const)
            : ("pending" as const),
        ...(step.expects ? { expects: step.expects } : {}),
      }));
      this.stepsWithoutPlan = 0;
      return;
    }
    if (typeof output.current_plan_item === "number" && this.plan.length) {
      const idx = output.current_plan_item;
      // 只改状态、不动业务字段：`...item` 展开保证 expects 在推进过程中不丢
      this.plan = this.plan.map((item, i) => {
        if (i < idx) return { ...item, status: item.status === "skipped" ? item.status : "done" };
        if (i === idx) return { ...item, status: "current" };
        return { ...item, status: item.status === "current" ? "pending" : item.status };
      });
    }
    if (!this.plan.length) this.stepsWithoutPlan += 1;
  }

  /**
   * Phase A：用任务分析结果播种计划。
   *
   * 接受双形态：`["打开A","搜索B"]` 或 `[{text, expects}, ...]`。
   * 字符串形态的转换与改造前**逐字等价**（同样 trim、同样丢空白项，
   * 连数字/布尔这类原始值也照样转成字符串保留），避免"顺手收紧"改变既有行为。
   */
  seedPlan(steps: Array<string | PlanStep>, currentIndex = 0): void {
    if (!this.settings.enablePlanning || this.settings.flashMode) return;
    const cleaned = coercePlanSteps(steps);
    if (!cleaned.length) return;
    const idx = Math.max(0, Math.min(currentIndex, cleaned.length - 1));
    this.plan = cleaned.map((step, i) => ({
      text: step.text,
      status: i < idx ? ("done" as const) : i === idx ? ("current" as const) : ("pending" as const),
      ...(step.expects ? { expects: step.expects } : {}),
    }));
    this.stepsWithoutPlan = 0;
  }

  /**
   * 重规划：已完成的步骤保留，未完成的整段换成新计划。
   * 不整表替换 —— 否则模型会把已经做完的「打开/搜索」再做一遍。
   */
  replaceRemainingPlan(steps: Array<string | PlanStep>): void {
    if (!this.settings.enablePlanning || this.settings.flashMode) return;
    // 重规划同样双形态：重规划器给的期望与已播下的期望一样要落账，
    // 否则一旦重规划，整条期望链就断了（3.3 的 Arbiter 会在重规划后失明）。
    const cleaned = coercePlanSteps(steps);
    if (!cleaned.length) return;
    const done = this.plan.filter((item) => item.status === "done");
    this.plan = [
      ...done,
      ...cleaned.map((step, i) => ({
        text: step.text,
        status: (i === 0 ? "current" : "pending") as PlanItem["status"],
        ...(step.expects ? { expects: step.expects } : {}),
      })),
    ];
    this.stepsWithoutPlan = 0;
  }

  currentPlanText(): string | null {
    const cur = this.plan.find((p) => p.status === "current");
    return cur?.text ?? this.plan[0]?.text ?? null;
  }

  /**
   * 当前计划项的期望（影子核对 / 3.3 的 Arbiter 用）。
   * 与 `currentPlanText` 用**同一条**查找规则，避免"文本取一项、期望取另一项"的错位。
   */
  currentPlanExpects(): PlanExpects | undefined {
    const cur = this.plan.find((p) => p.status === "current") ?? this.plan[0];
    return cur?.expects;
  }

  recordActions(actions: AgentAction[]): void {
    for (const a of actions) {
      const h = hashAction(a.name, a.params);
      this.recentActionHashes.push(h);
      const win = this.settings.loopDetectionWindow;
      if (this.recentActionHashes.length > win) {
        this.recentActionHashes = this.recentActionHashes.slice(-win);
      }
    }
  }

  recordPage(url: string, domText: string, elementCount: number): void {
    const textHash = createHash("sha256").update(domText).digest("hex").slice(0, 16);
    const fp: PageFingerprint = { url, elementCount, textHash };
    if (
      this.lastFingerprint &&
      this.lastFingerprint.url === fp.url &&
      this.lastFingerprint.textHash === fp.textHash &&
      this.lastFingerprint.elementCount === fp.elementCount
    ) {
      this.consecutiveStagnantPages += 1;
    } else {
      this.consecutiveStagnantPages = 0;
    }
    this.lastFingerprint = fp;
  }

  /**
   * 循环/停滞信号（**只报事实**）。
   *
   * 阈值判定不在这里 —— 阈值是政策，单一出口在 `arbiter.ts`（`LOOP_REPEAT_THRESHOLD` /
   * `STAGNANT_PAGES_THRESHOLD`）。本方法只回答"当前窗口内最大重复几次""连续停滞几步"，
   * 于是 `buildNudges`（既有引导）与 Arbiter 的决策**读的是同一份事实**，不会各算一套。
   *
   * ⚠️ 一处必须保持的既有语义：`loopDetectionEnabled` 关闭时，既有实现是**提前 return**，
   * 因此"循环/停滞/缺计划/失败过多"四条引导全都不会出现。这里把这种情形显式表达为
   * "后四项信号一律为空"，让两个消费者天然一致（而不是靠各自记得判断这个开关）。
   */
  arbiterSignals(stepNumber: number, maxSteps: number): ArbiterSignals {
    const stepBudgetSoftWarn = stepNumber >= Math.floor(maxSteps * 0.75);
    if (!this.settings.loopDetectionEnabled) {
      return {
        stepBudgetSoftWarn,
        loopRepeatMax: 0,
        stagnantPages: 0,
        planMissingTooLong: false,
        failuresTooMany: false,
      };
    }
    const counts = new Map<string, number>();
    for (const h of this.recentActionHashes) {
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    let loopRepeatMax = 0;
    for (const c of counts.values()) loopRepeatMax = Math.max(loopRepeatMax, c);
    return {
      stepBudgetSoftWarn,
      loopRepeatMax,
      stagnantPages: this.consecutiveStagnantPages,
      planMissingTooLong:
        this.settings.enablePlanning &&
        this.settings.planningExplorationLimit > 0 &&
        this.stepsWithoutPlan >= this.settings.planningExplorationLimit &&
        !this.plan.length,
      failuresTooMany:
        this.settings.planningReplanOnStall > 0 &&
        this.consecutiveFailures >= this.settings.planningReplanOnStall,
    };
  }

  /**
   * 步数 / 循环 / 停滞引导。文案单一出口在 `arbiter.ts` 的 `signalNudges`，
   * 这里只提供信号，避免两处各写一句以后漂掉。
   */
  buildNudges(stepNumber: number, maxSteps: number): string[] {
    const signals = this.arbiterSignals(stepNumber, maxSteps);
    return signalNudges(signals, LOOP_REPEAT_THRESHOLD, STAGNANT_PAGES_THRESHOLD);
  }
}

function hashAction(name: string, params: Record<string, unknown>): string {
  const normalized = JSON.stringify({ name, params });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}
