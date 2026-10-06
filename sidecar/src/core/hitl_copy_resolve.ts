/**
 * P1.4 辅助：组装事实包并生成 ai_copy（纯 core，不依赖 bu_agent）。
 */
import {
  buildHitlCopyFactPack,
  generateHitlCopy,
  type HitlAiCopy,
  type HitlFailureReason,
  type HitlUserAction,
} from "./hitl_copy.js";
import { findPendingHumanCredentials } from "./human_credential.js";
import type { SidecarAiSettings } from "../engine.js";

export async function resolveHitlAiCopy(input: {
  channel: "ask" | "handover" | "confirm";
  goal: string;
  url: string;
  pageTitle?: string;
  pageKind?: string;
  /** 观察层元素（含 humanOnly）；缺省则无 pending 字段 */
  elements?: Iterable<{
    index: number;
    humanOnly?: string | null;
    filled?: boolean | null;
    text?: string;
    placeholder?: string;
    name?: string;
  }>;
  captchaAttempts?: number | null;
  confirmLevel?: string | null;
  rawHint?: string;
  userAction?: HitlUserAction;
  failureReason?: HitlFailureReason;
  aiSettings: SidecarAiSettings;
  signal?: AbortSignal;
}): Promise<HitlAiCopy> {
  const pending = input.elements
    ? findPendingHumanCredentials(input.elements)
    : [];
  const facts = buildHitlCopyFactPack({
    channel: input.channel,
    goal: input.goal,
    url: input.url,
    pageTitle: input.pageTitle,
    pageKind: input.pageKind,
    pendingCredentialFields: pending.map((p) => p.label),
    pendingCredentialKinds: pending.map((p) => p.kind),
    captchaAttempts: input.captchaAttempts ?? null,
    confirmLevel: input.confirmLevel,
    rawHint: input.rawHint,
    userAction: input.userAction,
    failureReason: input.failureReason,
  });
  return generateHitlCopy({
    facts,
    aiSettings: input.aiSettings,
    signal: input.signal,
  });
}

/** 从 selectorMap 抽元素迭代器（调用方传入 Map） */
export function elementsFromSelectorMap(
  selectorMap: Map<
    number,
    {
      humanOnly?: string | null;
      filled?: boolean | null;
      text?: string;
      placeholder?: string;
      name?: string;
    }
  > | null | undefined,
): Array<{
  index: number;
  humanOnly?: string | null;
  filled?: boolean | null;
  text?: string;
  placeholder?: string;
  name?: string;
}> {
  if (!selectorMap) return [];
  return [...selectorMap.entries()].map(([index, el]) => ({
    index,
    humanOnly: el.humanOnly,
    filled: el.filled,
    text: el.text,
    placeholder: el.placeholder,
    name: el.name,
  }));
}
