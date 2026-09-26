import type { AgentOutput, AgentSettings, BrowserStateSummary, HistoryItem, PlanItem } from "./views.js";
import { buildSkillsSystemAppendix, ensureSkillsLoaded } from "./skills/index.js";
import { SYSTEM_PROMPT_FLASH, SYSTEM_PROMPT_THINKING } from "./system_prompt_text.js";
import { stripFencedJson } from "../json_extract.js";
import { coercePlanSteps } from "./plan_expects.js";
import { loadCompletionLexicon } from "../core/completion_evidence.js";
import { formatFailureReceipt, type FailureReceiptLike } from "../core/action_feedback.js";

export function loadSystemPrompt(settings: AgentSettings): string {
  const raw = settings.flashMode ? SYSTEM_PROMPT_FLASH : SYSTEM_PROMPT_THINKING;
  // 提示词里的策略数字必须来自运行时同一份词典，避免「文档说 2、代码实际 3」的漂移
  const maxDoneRejections = loadCompletionLexicon()?.maxDoneRejections ?? 2;
  let text = raw
    .replace(/\{max_actions\}/g, String(settings.maxActionsPerStep))
    .replace(/\{max_done_rejections\}/g, String(maxDoneRejections))
    .trim();
  if (!text) {
    throw new Error(
      "Agent 系统提示词为空：请将新版提示词写入 sidecar/src/bu_agent/system_prompt_text.ts（SYSTEM_PROMPT_THINKING）",
    );
  }
  try {
    ensureSkillsLoaded();
    // Flash：仅一行技能索引，避免冲淡极简提示；Thinking：完整目录 + always_on 短摘要
    const appendix = buildSkillsSystemAppendix(undefined, {
      compact: Boolean(settings.flashMode),
    });
    if (appendix.trim()) {
      text = `${text}\n\n${appendix.trim()}`;
    }
  } catch {
    // 技能目录缺失时不阻断 Agent
  }
  return text;
}

function formatPlan(plan: PlanItem[]): string {
  if (!plan.length) return "";
  const lines = plan.map((item, i) => {
    const mark =
      item.status === "done"
        ? "[x]"
        : item.status === "current"
          ? "[>]"
          : item.status === "skipped"
            ? "[-]"
            : "[ ]";
    return `${mark} ${i}. ${item.text}`;
  });
  return `<plan>\n${lines.join("\n")}\n</plan>`;
}

function formatHistory(items: HistoryItem[], compactedMemory?: string | null): string {
  const parts: string[] = [];
  if (compactedMemory?.trim()) {
    parts.push(`<compacted_memory>\n${compactedMemory.trim()}\n</compacted_memory>`);
  }
  for (const item of items) {
    const resultLines = item.actionResults
      .map((r, i) => {
        if (r.error) {
          const failure = r.metadata?.failure as FailureReceiptLike | undefined;
          return `Action ${i + 1}: ERROR ${formatFailureReceipt(r.error, failure)}`;
        }
        if (r.isDone) return `Action ${i + 1}: done success=${r.success} ${r.extractedContent ?? ""}`;
        return `Action ${i + 1}: ${r.extractedContent ?? r.longTermMemory ?? "ok"}`;
      })
      .join("\n");
    parts.push(
      `<step_${item.stepNumber}>
Evaluation of Previous Step: ${item.evaluationPreviousGoal ?? ""}
Memory: ${item.memory ?? ""}
Next Goal: ${item.nextGoal ?? ""}
Action Results:
${resultLines}
</step_${item.stepNumber}>`,
    );
  }
  return parts.join("\n");
}

export interface StateMessageInput {
  userRequest: string;
  history: HistoryItem[];
  compactedMemory?: string | null;
  fileSystemSummary: string;
  todoContents: string;
  plan: PlanItem[];
  browser: BrowserStateSummary;
  readState?: string | null;
  stepNumber: number;
  maxSteps: number;
  includeScreenshot: boolean;
  /** 多帧 vision（优先于 browser.screenshotBase64） */
  visionImages?: string[];
  nudges?: string[];
  /**
   * 用户自定义规则 / 人设 / 附件的 brief（core/task_rules.ts 生成）。
   * 已自带 <user_rules> / <user_persona> / <user_attachments> 标签，直接作为独立小节注入。
   */
  taskBrief?: string;
  /** 用户附件里的图片（dataURL）：只作任务参考资料，禁止当验证码/短信码来源（R2 / B7） */
  taskAttachmentImages?: string[];
}

export function buildUserStateMessage(input: StateMessageInput): {
  text: string;
  images: string[];
} {
  const today = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];
  sections.push(`<user_request>\n${input.userRequest}\n</user_request>`);
  if (input.taskBrief?.trim()) {
    sections.push(input.taskBrief.trim());
  }
  sections.push(`<agent_history>\n${formatHistory(input.history, input.compactedMemory)}\n</agent_history>`);
  sections.push(
    `<agent_state>
<file_system>
${input.fileSystemSummary}
</file_system>
<todo_contents>
${input.todoContents}
</todo_contents>
${formatPlan(input.plan)}
</agent_state>`,
  );

  const pageInfo = input.browser.pageInfo
    ? `Pages above: ${input.browser.pageInfo.pagesAbove}; Pages below: ${input.browser.pageInfo.pagesBelow}`
    : "";
  const tabs = input.browser.tabs
    .map(
      (t) =>
        `- ${t.id} (*${t.pos || 1})${t.active ? " [active]" : ""}: ${t.title || "(untitled)"} | ${t.url}`,
    )
    .join("\n");
  const tabLegend = input.browser.tabs.length > 1
    ? "# 标签用稳定 id（如 t2）或位置别名（*2）指代；稳定 id 在关掉其它标签后不变。控件索引只属于 [active] 标签页，切到别的标签用 switch(tab_id)（切后重新观察）。\n"
    : "";
  const quality = input.browser.observationQuality;
  const qualityLine = quality
    ? quality.mode === "full"
      ? `Observation: full（控件索引可用${quality.attempts > 1 ? `，自愈重抽后第 ${quality.attempts} 次尝试成功` : ""}）`
      : `Observation: ${quality.mode.toUpperCase()}（**无控件索引**，禁止 index 动作${quality.reason ? `；原因：${quality.reason.slice(0, 120)}` : ""}）`
    : "";
  sections.push(
    `<browser_state>
Current URL: ${input.browser.url}
Title: ${input.browser.title}
${qualityLine ? `${qualityLine}\n` : ""}${pageInfo}
Open Tabs:
${tabs || "(none)"}
${tabLegend}Interactive Elements:
${input.browser.interactiveTree}
</browser_state>`,
  );

  if (input.browser.pageDigest?.trim()) {
    sections.push(
      `<page_digest>\n${input.browser.pageDigest.trim()}\n</page_digest>`,
    );
  }

  const attachmentImages = input.taskAttachmentImages ?? [];

  if (input.includeScreenshot && (input.visionImages?.length || input.browser.screenshotBase64)) {
    const n = input.visionImages?.length || 1;
    const som = input.browser.somMarks;
    const lines = [`（已附 ${n} 帧视口截图；请将其视为视觉真值，勿拼接理解成长条图）`];
    if (som && som.marked > 0) {
      lines.push(
        `截图上的红色方框与编号 = Interactive Elements 里的 index（**同一套编号，不是两套**）。`,
      );
      lines.push(
        `用法：先在图上找到目标编号 N，再执行 click(index=N)。若某个编号的方框明显没框住你要的目标，` +
          `说明你的 index 对错了元素 —— 不要硬点，改按框住的编号来，或先 scroll/read 重新观察。`,
      );
      if (som.reason) {
        lines.push(`注意：本轮编号不完整（${som.reason}）；未出现在截图上的 index 仍可操作，但只能靠文本判断。`);
      }
    } else if (som) {
      lines.push(
        `本轮截图**没有**编号标记（${som.reason ?? "未标注"}）：图上位置与 index 无对应关系，请勿按视觉位置猜 index。`,
      );
    }
    if (attachmentImages.length > 0) {
      lines.push(
        `末尾另有 ${attachmentImages.length} 张「用户附件参考图片」，仅作任务参考资料；` +
          `不要把它们当作短信/邮箱验证码来源（验证码必须走正规通道或请人工提供）。`,
      );
    }
    sections.push(`<browser_vision>\n${lines.join("\n")}\n</browser_vision>`);
  } else if (attachmentImages.length > 0) {
    sections.push(
      `<browser_vision>\n（末尾 ${attachmentImages.length} 张是「用户附件参考图片」，仅作任务参考资料；` +
        `不要把它们当作短信/邮箱验证码来源。）\n</browser_vision>`,
    );
  }

  if (input.browser.observationError) {
    sections.push(
      `<observation_error>\n${input.browser.observationError}\nsuggested_action: reload or go_back\n</observation_error>`,
    );
  }

  if (input.readState?.trim()) {
    sections.push(`<read_state>\n${input.readState.trim()}\n</read_state>`);
  }

  if (input.nudges?.length) {
    for (const n of input.nudges) {
      sections.push(`<sys>\n${n}\n</sys>`);
    }
  }

  sections.push(
    `<step_info>\nStep ${input.stepNumber}\nToday: ${today}\n完成与否由 done 决定，不要因为步数提前结束。\n</step_info>`,
  );

  return {
    text: sections.join("\n\n"),
    images: [
      ...(input.includeScreenshot
        ? input.visionImages?.length
          ? input.visionImages
          : input.browser.screenshotBase64
            ? [input.browser.screenshotBase64]
            : input.browser.screenshotList?.length
              ? input.browser.screenshotList
              : []
        : []),
      ...attachmentImages,
    ],
  };
}

export function agentOutputJsonSchema(settings: AgentSettings): Record<string, unknown> {
  if (settings.flashMode) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["memory", "action"],
      properties: {
        memory: { type: "string" },
        action: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["evaluation_previous_goal", "memory", "next_goal", "action"],
    properties: {
      thinking: { type: "string" },
      evaluation_previous_goal: { type: "string" },
      memory: { type: "string" },
      next_goal: { type: "string" },
      current_plan_item: { type: ["integer", "null"] },
      plan_update: {
        type: ["array", "null"],
        items: {
          // 双形态：`"打开百度首页"` 或 `{"text":"打开百度首页","expects":{...}}`。
          // 这里是**提示文本**（本函数只用于 json_object 回退路径的 schema 说明），
          // 不是 strict 约束 —— 真正的形状裁决在 coercePlanSteps 里。
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                text: { type: "string" },
                expects: {
                  type: "object",
                  properties: {
                    url_pattern: { type: "string" },
                    must_appear_in_a11y: { type: "array", items: { type: "string" } },
                    must_not_appear: { type: "array", items: { type: "string" } },
                    state_change: { type: "string", enum: ["url_changed", "dom_reloaded", "none"] },
                  },
                },
              },
              required: ["text"],
            },
          ],
        },
      },
      action: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  };
}

/** 将 LLM 返回规范为 AgentOutput；容忍多种常见走形 */
export function normalizeAgentOutput(raw: unknown): AgentOutput {
  if (!raw || typeof raw !== "object") {
    throw new Error("AgentOutput 非法：非对象");
  }
  const o = raw as Record<string, unknown>;

  let actionRaw: unknown = o.action ?? o.actions ?? o.tool_calls;
  // 顶层直接给了单个动作：{"navigate":{"url":"..."}}
  if (actionRaw == null) {
    const known = Object.keys(o).filter((k) =>
      [
        "search",
        "navigate",
        "go_back",
        "wait",
        "click",
        "input",
        "scroll",
        "send_keys",
        "find_text",
        "switch",
        "close",
        "extract",
        "search_page",
        "find_elements",
        "done",
        "scrape_page_data",
        "page_summary",
        "ask_user",
        "handover_to_human",
        "ask_vision_locate",
        "click_viewport",
        "screenshot",
        "write_file",
        "read_file",
        "replace_file",
        "evaluate",
        "upload_file",
        "download",
        "save_as_pdf",
        "dropdown_options",
        "select_dropdown",
        "list_skills",
        "recall_skill",
        "detect_page_blockers",
        "solve_captcha",
        "solve_animated_captcha",
        "solve_slider_captcha",
        "solve_math_captcha",
        "solve_point_select_captcha",
        "fetch_email_otp",
        "fetch_sms_otp",
        "restart_browser",
      ].includes(k),
    );
    if (known.length === 1) {
      actionRaw = [{ [known[0]!]: o[known[0]!] }];
    } else if (known.length > 1) {
      actionRaw = known.map((k) => ({ [k]: o[k] }));
    }
  }

  // Execute 相位兜底：模型把 Planner 载荷（MacroPlan / Phase A plan）当作整段回复时，
  // 桥接为 write_file(plan.json) + plan_update，避免 "action 不得为空" 解析失败。
  if (actionRaw == null) {
    const bridged = bridgePlannerPayload(o);
    if (bridged) return bridged;
  }

  // 单个动作对象而非数组
  if (actionRaw && typeof actionRaw === "object" && !Array.isArray(actionRaw)) {
    actionRaw = [actionRaw];
  }

  if (!Array.isArray(actionRaw) || actionRaw.length === 0) {
    throw new Error("AgentOutput.action 不得为空");
  }

  const action = actionRaw.map((item, i) => normalizeOneAction(item, i));
  return {
    thinking: typeof o.thinking === "string" ? o.thinking : undefined,
    evaluation_previous_goal:
      typeof o.evaluation_previous_goal === "string"
        ? o.evaluation_previous_goal
        : typeof o.evaluation === "string"
          ? o.evaluation
          : undefined,
    memory: typeof o.memory === "string" ? o.memory : undefined,
    next_goal:
      typeof o.next_goal === "string"
        ? o.next_goal
        : typeof o.nextGoal === "string"
          ? o.nextGoal
          : undefined,
    current_plan_item:
      typeof o.current_plan_item === "number"
        ? o.current_plan_item
        : o.current_plan_item === null
          ? null
          : undefined,
    // 双形态统一走 coercePlanSteps。**绝不能再回到 `filter(typeof x === "string")`**：
    // 那会把对象形态静默吃掉（不报错、计划消失），是本项目里最隐蔽的一类失败。
    plan_update: Array.isArray(o.plan_update)
      ? coercePlanSteps(o.plan_update)
      : o.plan_update === null
        ? null
        : undefined,
    action,
  };
}

/**
 * 相位桥接：把 Planner 相位的裸 JSON（MacroPlan / Phase A plan）转换为 Execute 相位的合法输出。
 * Execute 相位铁律是 action 非空；计划正文只能进 write_file(plan.json)，子任务标题投影到 plan_update。
 */
function bridgePlannerPayload(o: Record<string, unknown>): AgentOutput | null {
  const subtasks = Array.isArray(o.subtasks) ? o.subtasks : null;
  const flatPlan = Array.isArray(o.plan)
    ? o.plan.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : null;
  const looksPlanner =
    Boolean(subtasks) ||
    Boolean(flatPlan?.length) ||
    Array.isArray(o.replan_triggers) ||
    (typeof o.mission === "string" && (o.acceptance != null || o.synthesize != null)) ||
    (typeof o.mode === "string" &&
      /^(macro|micro_only)$/i.test(o.mode) &&
      (o.acceptance != null || o.synthesize != null || subtasks != null));
  if (!looksPlanner) return null;

  const titles: string[] = [];
  if (subtasks) {
    for (const st of subtasks) {
      if (typeof st === "string" && st.trim()) {
        titles.push(st.trim());
      } else if (st && typeof st === "object") {
        const t = (st as Record<string, unknown>).title;
        if (typeof t === "string" && t.trim()) titles.push(t.trim());
      }
    }
  }
  if (!titles.length && flatPlan) {
    titles.push(...flatPlan.map((s) => s.trim()));
  }
  const synth = o.synthesize;
  if (synth && typeof synth === "object") {
    const t = (synth as Record<string, unknown>).title;
    titles.push(typeof t === "string" && t.trim() ? t.trim() : "汇总并输出最终报告");
  }

  const planUpdate = titles.length ? titles : null;
  return {
    thinking:
      "检测到本步为 Planner 相位载荷（MacroPlan / Phase A plan）。已按 Execute 相位契约桥接：计划正文落盘 plan.json，子任务标题投影到 plan_update。",
    evaluation_previous_goal: "规划载荷已按 Execute 相位契约转换",
    memory: "MacroPlan 已写入 plan.json；plan_update 已投影子任务标题",
    next_goal: titles[0] ? `推进：${titles[0]}` : "按当前 plan 推进第一个子任务",
    current_plan_item: planUpdate ? 0 : undefined,
    plan_update: planUpdate,
    action: [
      {
        name: "write_file",
        params: {
          file_name: "plan.json",
          content: JSON.stringify(o),
          append: false,
        },
      },
    ],
  };
}

function normalizeOneAction(item: unknown, i: number): { name: string; params: Record<string, unknown> } {
  if (!item || typeof item !== "object") {
    throw new Error(`action[${i}] 非法`);
  }
  const obj = item as Record<string, unknown>;

  // {name, params} / {tool, arguments} / {function:{name,arguments}}
  if (typeof obj.name === "string") {
    const params =
      obj.params && typeof obj.params === "object"
        ? (obj.params as Record<string, unknown>)
        : obj.arguments && typeof obj.arguments === "object"
          ? (obj.arguments as Record<string, unknown>)
          : typeof obj.arguments === "string"
            ? (JSON.parse(obj.arguments) as Record<string, unknown>)
            : {};
    return { name: obj.name, params: coerceParams(params) };
  }
  if (obj.function && typeof obj.function === "object") {
    const fn = obj.function as Record<string, unknown>;
    const name = String(fn.name ?? "");
    let params: Record<string, unknown> = {};
    if (typeof fn.arguments === "string") {
      try {
        params = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        params = {};
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      params = fn.arguments as Record<string, unknown>;
    }
    if (!name) throw new Error(`action[${i}] 缺少 function.name`);
    return { name, params: coerceParams(params) };
  }

  const entries = Object.entries(obj).filter(([k]) => k !== "thinking" && k !== "memory");
  if (entries.length === 0) {
    throw new Error(`action[${i}] 空对象`);
  }
  // 优先取唯一动作键；若多键且含 index/text 等，可能是扁平参数（少见）
  if (entries.length === 1) {
    const [name, params] = entries[0]!;
    return {
      name,
      params:
        params && typeof params === "object"
          ? coerceParams(params as Record<string, unknown>)
          : params == null
            ? {}
            : { value: params },
    };
  }

  // {"action":"navigate","url":"..."} 扁平写法
  if (typeof obj.action === "string") {
    const name = obj.action;
    const params = { ...obj };
    delete params.action;
    return { name, params: coerceParams(params) };
  }

  throw new Error(`action[${i}] 无法识别：${JSON.stringify(obj).slice(0, 200)}`);
}

function coerceParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const key of ["index", "seconds", "pages", "max_results", "xPercent", "yPercent", "coordinate_x", "coordinate_y"]) {
    if (typeof out[key] === "string" && out[key] !== "" && !Number.isNaN(Number(out[key]))) {
      out[key] = Number(out[key]);
    }
  }
  return out;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("无法从模型输出中解析 JSON 对象");
  const body = stripFencedJson(trimmed);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("无法从模型输出中解析 JSON 对象");
  }
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

/** 从 OpenAI tool_calls 转为 AgentOutput */
export function agentOutputFromToolCalls(
  toolCalls: Array<{ function?: { name?: string; arguments?: string } }>,
  content?: string | null,
): AgentOutput {
  if (!toolCalls.length) {
    throw new Error("tool_calls 为空");
  }
  const action = toolCalls.map((tc, i) => {
    const name = tc.function?.name?.trim();
    if (!name) throw new Error(`tool_calls[${i}] 缺少 name`);
    let params: Record<string, unknown> = {};
    const rawArgs = tc.function?.arguments ?? "{}";
    try {
      params = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      params = {};
    }
    return { name, params: coerceParams(params) };
  });
  return {
    thinking: content?.trim() || undefined,
    memory: content?.trim()?.slice(0, 300) || undefined,
    next_goal: action[0] ? `执行 ${action.map((a) => a.name).join(" → ")}` : undefined,
    evaluation_previous_goal: "继续推进任务",
    action,
  };
}
