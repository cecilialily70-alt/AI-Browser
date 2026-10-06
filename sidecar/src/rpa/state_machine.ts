import type { Page } from "playwright-core";

import type { JsonLogger } from "../json-logger.js";
import { handleRpaRunError, handleRpaStepFailure } from "./error_handler.js";
import { executeRpaAction } from "./step_runner.js";
import type { RpaAction, RpaRunState } from "./types.js";
import { assertPageAlive } from "../fill_interactions.js";
import { pressEnterAfterFillIfEnabled, resolveLastFilledSelector } from "../fill_submit.js";

/** RPA 步骤调度状态机 — 负责动作流推进与暂停/恢复 */
export class RpaStateMachine {
  actions: RpaAction[];
  stepIndex: number;
  data: Record<string, string>;
  paused: boolean;
  manualPause: boolean;
  pressEnterAfterFill: boolean;
  /** false 时连续跑完（轨迹记忆回放）；默认 true 保留点击后人工介入 */
  pauseAfterClick: boolean;

  constructor(
    actions: RpaAction[],
    data: Record<string, string>,
    options?: { pressEnterAfterFill?: boolean; pauseAfterClick?: boolean },
  ) {
    this.actions = actions;
    this.stepIndex = 0;
    this.data = data;
    this.paused = false;
    this.manualPause = false;
    this.pressEnterAfterFill = options?.pressEnterAfterFill ?? false;
    this.pauseAfterClick = options?.pauseAfterClick ?? true;
  }

  appendActions(newActions: RpaAction[]): void {
    const startStep = this.actions.length + 1;
    for (let index = 0; index < newActions.length; index += 1) {
      const action = newActions[index];
      this.actions.push({
        ...action,
        step: startStep + index,
      });
    }
  }

  replaceActions(actions: RpaAction[]): void {
    this.actions = actions.map((action, index) => ({
      ...action,
      step: index + 1,
    }));
    this.stepIndex = 0;
    this.paused = false;
    this.manualPause = false;
  }

  setData(data: Record<string, string>): void {
    this.data = data;
  }

  pauseManual(): void {
    this.manualPause = true;
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.manualPause = false;
  }

  snapshot(): { actions: RpaAction[]; stepIndex: number; state: RpaRunState } {
    let state: RpaRunState = "running";
    if (this.paused) {
      state = "paused";
    } else if (this.stepIndex >= this.actions.length && this.actions.length > 0) {
      state = "complete";
    }
    return {
      actions: this.actions,
      stepIndex: this.stepIndex,
      state,
    };
  }

  async runUntilPause(page: Page, logger: JsonLogger): Promise<void> {
    try {
      this.paused = false;
      this.manualPause = false;

      if (this.actions.length === 0) {
        logger.rpaState("paused", {
          step: 0,
          msg: "动作流为空，请先重新扫描此页或选择模板",
        });
        this.paused = true;
        return;
      }

      while (this.stepIndex < this.actions.length) {
        if (this.manualPause) {
          this.paused = true;
          logger.rpaState("paused", {
            step: this.stepIndex,
            msg: "用户手动暂停",
            actions: this.actions,
          });
          return;
        }

        assertPageAlive(page);
        const action = this.actions[this.stepIndex];
        logger.progress("rpa_step_start", {
          step: action.step,
          type: action.type,
          selector: action.selector,
        });

        try {
          await executeRpaAction(page, action, this.data, logger);
        } catch (error) {
          this.paused = true;
          handleRpaStepFailure(
            logger,
            { stepIndex: this.stepIndex, action, error },
            this.actions,
          );
          return;
        }

        this.stepIndex += 1;
        logger.progress("rpa_step_complete", { step: action.step, type: action.type });

        if (action.type === "click") {
          assertPageAlive(page);
          await page.waitForTimeout(500);
          if (this.pauseAfterClick) {
            this.paused = true;
            logger.rpaState("paused", {
              step: this.stepIndex,
              msg: "等待页面变化或用户干预（点击后已暂停）",
              actions: this.actions,
            });
            return;
          }
        }
      }

      if (this.pressEnterAfterFill) {
        const lastSelector = resolveLastFilledSelector(
          this.actions
            .filter((action) => action.type === "fill" || action.type === "select")
            .map((action) => action.selector),
        );
        await pressEnterAfterFillIfEnabled(page, logger, true, lastSelector);
      }

      logger.rpaState("complete", {
        step: this.stepIndex,
        msg: "动作流执行完毕",
        actions: this.actions,
      });
    } catch (error) {
      this.paused = true;
      handleRpaRunError(logger, this.stepIndex, error, this.actions);
    }
  }
}
