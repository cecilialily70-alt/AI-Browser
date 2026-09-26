/**
 * 交付物兜底判定（llm_judge）
 *
 * 定位：**最后一道确认**，不是第一道。确定性验证器（core/deliverable_verify.ts）能给结论时
 * 绝不走这里；只有当某一项「必交交付物」既没被确认、也没被否认（不确定）时，才花一次模型调用
 * 去问一个**闭合问题**：「按当前可见事实，这一项算完成了吗？」
 *
 * 为什么需要它：像「点开图片栏目」「下载第二张图片」这类交付物，确定性验证器只能看出
 * 「页面变了、有下载记录」，但看不出「变的就是它」。与其猜，不如让模型基于**当前页事实 + 台账**
 * 做一次判定 —— 这正是用户要的「让 Agent 会问 AI」，而且问的是可回答的闭合问题，不是幻觉空间。
 *
 * 约束：
 *   - 预算硬上限（默认 3 次/任务，可用 DELIVERABLE_LLM_JUDGEMENTS 覆盖），花完即退回「按未完成处理」；
 *   - 只回答 yes/no，输出必须是 JSON；解析失败一律按「无法确认」处理（不惩罚任务）；
 *   - 提示词只给客观事实（URL、台账事实、页面摘要、可见文案），不给站点专属假设。
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import { beginAgentLlmWait, createLlmClient, extractAssistantContent } from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import { extractJsonObject } from "../bu_agent/prompts.js";

export interface JudgeDeliverableInput {
  /** 交付物描述（用户/计划原话） */
  deliverable: string;
  kind: string;
  hints: string[];
  goal: string;
  currentUrl: string;
  /** 已核销/已发生的事实（人类可读，逐行） */
  factLines: string[];
  /** 当前页可见文案摘要（截断） */
  pageDigest?: string;
  /** 模型的 done 自述 */
  claim: string;
  aiSettings: SidecarAiSettings;
  signal?: AbortSignal;
}

export type JudgeOutcome = "yes" | "no" | "unknown";

export interface JudgeResult {
  outcome: JudgeOutcome;
  reason: string;
}

interface ParsedJudge {
  outcome: JudgeOutcome;
  reason: string;
}

/** 解析严格三态：只有明确的 yes/no 才被采纳，其余一律 unknown（宁可放过不可错杀） */
export function parseJudgeReply(content: string): ParsedJudge {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = extractJsonObject(content) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const verdictRaw = parsed
    ? String(parsed.completed ?? parsed.verdict ?? parsed.answer ?? "").trim().toLowerCase()
    : "";
  const reason = parsed ? String(parsed.reason ?? "").trim() : "";
  if (verdictRaw === "yes" || verdictRaw === "true" || verdictRaw === "是") {
    return { outcome: "yes", reason };
  }
  if (verdictRaw === "no" || verdictRaw === "false" || verdictRaw === "否") {
    return { outcome: "no", reason };
  }
  return { outcome: "unknown", reason };
}

export async function judgeDeliverable(input: JudgeDeliverableInput): Promise<JudgeResult> {
  let wait: ReturnType<typeof beginAgentLlmWait> | null = null;
  try {
    const router = createModelRouter(input.aiSettings);
    const resolved = router.resolve("logic");
    const client = createLlmClient(input.aiSettings);
    wait = beginAgentLlmWait({ parentSignal: input.signal, timeoutMs: 30_000 });
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `你是任务交付物验收员。只做一件事：判断**这一项交付物**是否已经真的完成。
只输出 JSON：{"completed":"yes|no","reason":"一句话依据"}
判定规则：
- 只依据给定的事实与当前页面信息，禁止推测、禁止脑补未发生的动作；
- 事实里看不到该项要求的痕迹 → 回答 no，并说明「没有任何迹象」；
- 事实里能看到该项要求的痕迹（在 URL / 页面文案 / 已发生事实里） → 回答 yes；
- 唯一答案：yes 或 no，不要写 unknown，不要解释多余内容。`,
      },
      {
        role: "user",
        content:
          `<任务目标>${input.goal}</task_goal>\n` +
          `<待验收交付物>${input.deliverable}（类型 ${input.kind}；判定线索：${
            input.hints.join(" / ") || "无"
          }）</待验收交付物>\n` +
          `<当前地址>${input.currentUrl}</current_address>\n` +
          `<已发生的事实>\n${input.factLines.slice(0, 20).join("\n") || "（暂无）"}\n</facts>\n` +
          (input.pageDigest ? `<当前页面可见内容>\n${input.pageDigest.slice(0, 1200)}\n</page_visible>\n` : "") +
          `<模型的完成自述>${input.claim.slice(0, 500)}</claim>\n` +
          `这一项交付物完成了吗？`,
      },
    ];
    const completion = await client.chat.completions.create(
      {
        model: resolved.model,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
      } as never,
      { signal: wait.signal },
    );
    const parsed = parseJudgeReply(extractAssistantContent(completion));
    return { outcome: parsed.outcome, reason: parsed.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: "unknown", reason: `判定调用失败（按无法确认处理）：${message}` };
  } finally {
    wait?.stop();
  }
}
