/**
 * RunBrief — Agent 六槽态势投影（仅进 buildUserStateMessage，不进 system / 聊天）。
 */
import { redactSecrets, redactSecretText } from "../secret_redaction.js";
import type { DeliverableLedger } from "./task_contract.js";
import { listPendingDeliverables, formatDeliverableLines } from "./task_contract.js";

const NEAR_STEPS_FULL = 2;
const SLOT_MAX = 1_800;

export interface RunBriefStepEvidence {
  step: number;
  actionNames?: string[];
  verifyVerdict?: string;
  summary?: string;
  domBefore?: string;
  domAfter?: string;
  networkJson?: unknown;
  domCapture?: string;
  networkCapture?: string;
}

export interface RunBriefInput {
  goal: string;
  stepNumber: number;
  maxSteps: number;
  ledger?: DeliverableLedger | null;
  /** 近步证据（新→旧或旧→新均可；内部按 step 排序） */
  recentEvidence?: RunBriefStepEvidence[];
  navVerdict?: string | null;
  pageFitsGoal?: string | null;
  verifyOk?: boolean | null;
  shouldDo?: string[];
  mustNot?: string[];
  stopWhenMet?: string | null;
  goalShape?: string | null;
}

function clip(text: string, max = SLOT_MAX): string {
  const t = redactSecretText(String(text ?? "").trim());
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function slotA(input: RunBriefInput): string {
  const lines = [
    `目标：${clip(input.goal, 400)}`,
    input.goalShape ? `形态：${clip(input.goalShape, 120)}` : "",
    input.stopWhenMet ? `达成即停：${clip(input.stopWhenMet, 200)}` : "",
    `步数：${input.stepNumber}/${input.maxSteps}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function slotB(input: RunBriefInput): string {
  const ledger = input.ledger;
  if (!ledger) return "（无交付物台账）";
  const pending = listPendingDeliverables(ledger);
  const total = ledger.records.size;
  const done = total - pending.length;
  const lines = [`进度：已核销 ${done}/${total}；待办 ${pending.length}`];
  if (pending.length) {
    lines.push(...formatDeliverableLines(ledger).slice(0, 8));
  }
  return lines.join("\n");
}

function slotC(input: RunBriefInput): string {
  const recent = [...(input.recentEvidence ?? [])].sort((a, b) => b.step - a.step);
  if (!recent.length) return "（本 run 尚无动作回执）";
  return recent
    .slice(0, 4)
    .map((e) => {
      const names = (e.actionNames ?? []).join(",") || "?";
      const v = e.verifyVerdict ? ` verify=${e.verifyVerdict}` : "";
      return `step ${e.step}: ${names}${v}${e.summary ? ` · ${clip(e.summary, 160)}` : ""}`;
    })
    .join("\n");
}

function slotD(input: RunBriefInput): string {
  const lines: string[] = [];
  if (input.pageFitsGoal) lines.push(`pageFitsGoal: ${clip(input.pageFitsGoal, 200)}`);
  if (input.navVerdict) lines.push(`navVerdict: ${clip(input.navVerdict, 200)}`);
  const recent = [...(input.recentEvidence ?? [])].sort((a, b) => b.step - a.step);
  const currentStep = input.stepNumber;
  for (const e of recent.slice(0, 6)) {
    const near = currentStep - e.step <= NEAR_STEPS_FULL;
    if (near) {
      if (e.domBefore) lines.push(`[step ${e.step} domBefore]\n${clip(e.domBefore, 600)}`);
      if (e.domAfter) lines.push(`[step ${e.step} domAfter]\n${clip(e.domAfter, 600)}`);
      if (e.networkJson) {
        const raw = typeof e.networkJson === "string" ? e.networkJson : JSON.stringify(e.networkJson);
        lines.push(`[step ${e.step} network]\n${clip(raw, 600)}`);
      }
    } else {
      lines.push(
        `step ${e.step} 摘要: capture=${e.domCapture ?? "?"}/${e.networkCapture ?? "?"} ${(e.summary ?? "").slice(0, 80)}`,
      );
    }
  }
  return lines.length ? lines.join("\n") : "（暂无深度观察）";
}

function slotE(input: RunBriefInput): string {
  const parts: string[] = [];
  if (input.verifyOk === true) parts.push("verifyOk=true");
  if (input.verifyOk === false) parts.push("verifyOk=false");
  const recent = input.recentEvidence ?? [];
  for (const e of recent.slice(-3)) {
    if (e.verifyVerdict) parts.push(`step ${e.step} ${e.verifyVerdict}`);
  }
  return parts.length ? parts.join("\n") : "（暂无强硬回读证据）";
}

function slotF(input: RunBriefInput): string {
  const should = (input.shouldDo ?? []).map((s) => `应做：${clip(s, 120)}`);
  const mustNot = (input.mustNot ?? [
    "禁止无人支付/自动扣款",
    "禁止编造 OTP/验证码 token",
    "禁止为过检测改指纹",
  ]).map((s) => `禁止：${clip(s, 120)}`);
  return [...should, ...mustNot].join("\n");
}

/** 组装六槽 RunBrief XML 段；出口再脱敏 */
export function buildRunBrief(input: RunBriefInput): string {
  const body = [
    "<run_brief>",
    "<slot_a_goal>",
    slotA(input),
    "</slot_a_goal>",
    "<slot_b_ledger>",
    slotB(input),
    "</slot_b_ledger>",
    "<slot_c_actions>",
    slotC(input),
    "</slot_c_actions>",
    "<slot_d_observe>",
    slotD(input),
    "</slot_d_observe>",
    "<slot_e_evidence>",
    slotE(input),
    "</slot_e_evidence>",
    "<slot_f_rails>",
    slotF(input),
    "</slot_f_rails>",
    "</run_brief>",
  ].join("\n");
  // 出口再脱敏：对象路径 + 行级文本形态
  void redactSecrets({ brief: body });
  return body
    .split("\n")
    .map((line) => redactSecretText(line))
    .join("\n");
}

/** 内存 ring：保留近步证据供 Brief 使用 */
export class EvidenceRing {
  private items: RunBriefStepEvidence[] = [];
  private readonly maxItems: number;

  constructor(maxItems = 12) {
    this.maxItems = maxItems;
  }

  push(item: RunBriefStepEvidence): void {
    this.items.push(item);
    if (this.items.length > this.maxItems) {
      this.items = this.items.slice(-this.maxItems);
    }
  }

  list(): RunBriefStepEvidence[] {
    return [...this.items];
  }
}
