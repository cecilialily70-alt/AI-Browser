import { beginAgentLlmWait, createLlmClient } from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import { extractJsonObject } from "./prompts.js";
import type { HistoryItem, JudgementResult } from "./views.js";

const JUDGE_TIMEOUT_MS = 12_000;

export async function judgeTrace(input: {
  goal: string;
  history: HistoryItem[];
  finalText: string;
  successClaimed: boolean;
  aiSettings: SidecarAiSettings;
}): Promise<JudgementResult> {
  const client = createLlmClient(input.aiSettings);
  // 统一意图路由：不写死模型 ID；两档文本皆空时抛明确配置错误
  const model = createModelRouter(input.aiSettings).resolve("fast_text").model;
  const steps = input.history
    .slice(-8)
    .map(
      (h) =>
        `Step ${h.stepNumber}: eval=${h.evaluationPreviousGoal ?? ""} memory=${h.memory ?? ""} actions=${h.actions
          .map((a) => a.name)
          .join(",")} results=${h.actionResults
          .map((r) => r.error || r.extractedContent || "")
          .join(" | ")
          .slice(0, 240)}`,
    )
    .join("\n");

  const wait = beginAgentLlmWait({ timeoutMs: JUDGE_TIMEOUT_MS });
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content: `你是任务完成度评判器。根据轨迹判断 Agent 是否真正完成用户目标。
只输出 JSON：{"verdict":true/false,"reasoning":"...","failure_reason":null或字符串,"impossible_task":false,"reached_captcha":false}
禁止用训练知识补全页面事实。简短 reasoning（≤80 字）。`,
          },
          {
            role: "user",
            content: `用户目标：${input.goal}
Agent 声称 success=${input.successClaimed}
最终文本：${input.finalText.slice(0, 2000)}
轨迹：
${steps}`,
          },
        ],
      } as never,
      { signal: wait.signal },
    );
    const raw = completion.choices[0]?.message?.content ?? "{}";
    try {
      const obj = extractJsonObject(raw) as Record<string, unknown>;
      return {
        verdict: Boolean(obj.verdict),
        reasoning: String(obj.reasoning ?? ""),
        failureReason: obj.failure_reason == null ? null : String(obj.failure_reason),
        impossibleTask: Boolean(obj.impossible_task),
        reachedCaptcha: Boolean(obj.reached_captcha),
      };
    } catch {
      return {
        verdict: input.successClaimed,
        reasoning: "judge 解析失败，回退到 Agent 自报 success",
        failureReason: null,
      };
    }
  } finally {
    wait.stop();
  }
}

export function parseCompletionAsk(raw: string): { outcome: "yes" | "no" | "unknown"; reason: string } {
  const verdictOf = (value: unknown): "yes" | "no" | null => {
    if (value === true || value === "yes" || value === "true" || value === "是") return "yes";
    if (value === false || value === "no" || value === "false" || value === "否") return "no";
    return null;
  };
  try {
    const obj = extractJsonObject(raw) as Record<string, unknown>;
    const reason = String(obj.reason ?? obj.reasoning ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    return { outcome: verdictOf(obj.completed ?? obj.verdict ?? obj.answer) ?? "unknown", reason };
  } catch {
    /*
     * JSON 没解析出来（最常见的成因是**回复被 max_tokens 截断**：中文 reason 写长一点，
     * 300 token 就不够，JSON 尾巴被切掉）。用户现场：百度那次收尾拿了 `unknown`，
     * 而 unknown 会放过一个**没有被独立确认过**的收官。
     * 这里的挽救只针对**我们自己在提示词里规定的字段名**做取值，不是猜语义：
     * 能取到明确的 yes/no 就用它，取不到才如实回 unknown。
     */
    const salvaged = verdictOf(
      raw.match(/"(?:completed|verdict|answer)"\s*:\s*"?\s*(yes|no|true|false|是|否)/i)?.[1] ??
        undefined,
    );
    if (salvaged) {
      return { outcome: salvaged, reason: "（回复被截断，已按开头明确的判定取值）" };
    }
    return { outcome: "unknown", reason: "" };
  }
}

export interface CompletionAskDecision {
  /** 接受本次 done 收尾 */
  accept: boolean;
  /** 判定未完成且还有重规划预算 */
  replan: boolean;
  /** 判定未完成且预算已用尽：诚实失败，不再空转 */
  stop: boolean;
}

/**
 * 完成度询问的下一步。
 * unknown（解析失败 / 超时）不推翻已经通过的确定性闸门，避免一次模型故障卡死任务。
 */
export function decideCompletionAsk(input: {
  outcome: "yes" | "no" | "unknown";
  replansUsed: number;
  maxReplans: number;
}): CompletionAskDecision {
  if (input.outcome !== "no") {
    return { accept: true, replan: false, stop: false };
  }
  if (input.replansUsed < input.maxReplans) {
    return { accept: false, replan: true, stop: false };
  }
  return { accept: false, replan: false, stop: true };
}

export async function judgeTaskComplete(input: {
  goal: string;
  claim: string;
  url: string;
  pending: string[];
  artifacts: string[];
  facts: string[];
  aiSettings: SidecarAiSettings;
  signal?: AbortSignal;
}): Promise<{ outcome: "yes" | "no" | "unknown"; reason: string }> {
  const client = createLlmClient(input.aiSettings);
  // 统一意图路由：不写死模型 ID；两档文本皆空时抛明确配置错误
  const model = createModelRouter(input.aiSettings).resolve("fast_text").model;
  const wait = beginAgentLlmWait({ parentSignal: input.signal, timeoutMs: JUDGE_TIMEOUT_MS });
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        // 中文 reason 写长一点 300 token 就会被截断（= 整个 JSON 作废 → unknown）。
        // 给足余量，并在提示词里把长度上限写死，两头都收紧。
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `你是独立的任务完成度询问员。执行模型刚声称做完了，你只根据给定事实判断用户目标是否真的完成。
只输出 JSON：{"completed":"yes"|"no","reason":"一句话（不超过 50 字）"}
规则：
- 未核销交付物清单不为空 → 必须 no（清单以系统台账为准；若自述里已有实质总结而清单仍列「总结/回答」类项，以清单为准——说明尚未被系统核销）；
- 目标要求下载/保存文件，但落盘列表为空 → 必须 no；
- 目标要求点击/切换栏目，事实里看不到对应页面变化 → no；
- 禁止用常识或训练知识补全页面上没发生的事；
- 禁止建议或认可「在地址栏拼搜索结果 URL」当完成路径；
- 事实已经覆盖目标里的每一项，且未核销清单为空 → yes。`,
          },
          {
            role: "user",
            content: [
              `用户目标：${input.goal}`,
              `执行模型的完成自述：${input.claim.slice(0, 800)}`,
              `当前地址：${input.url}`,
              `未核销交付物：${input.pending.length ? input.pending.join("；") : "（无）"}`,
              `已落盘文件：${input.artifacts.length ? input.artifacts.join("；") : "（无）"}`,
              `已发生事实：\n${input.facts.slice(-16).join("\n") || "（无）"}`,
            ].join("\n"),
          },
        ],
      } as never,
      { signal: wait.signal },
    );
    const raw = completion.choices[0]?.message?.content ?? "{}";
    return parseCompletionAsk(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: "unknown", reason: `询问失败，按确定性闸门放行：${message}`.slice(0, 240) };
  } finally {
    wait.stop();
  }
}

/** 干净短轨迹且已自报成功：跳过二次评判，省一轮 LLM */
export function shouldSkipJudge(input: {
  successClaimed: boolean;
  history: HistoryItem[];
  goal: string;
  finalText?: string;
}): boolean {
  if (!input.successClaimed) return false;
  if (input.history.length > 6) return false;
  const hasError = input.history.some((h) =>
    h.actionResults.some((r) => Boolean(r.error)),
  );
  if (hasError) return false;
  // 已有实质交付 / 短成功轨迹：再跑评判只拖慢收尾
  return true;
}
