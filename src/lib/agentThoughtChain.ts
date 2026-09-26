/**
 * Agent Monitor — 将单调日志归类为思考流卡片类型
 */
import type { TerminalLine } from "../types";

export type AgentThoughtKind = "thought" | "perceive" | "action" | "alert" | "success" | "error" | "system";

export interface ClassifiedAgentLine {
  kind: AgentThoughtKind;
  /** 卡片标题（短） */
  title: string;
  /** 主文案 */
  body: string;
  /** 折叠区内的完整推理/细节（思考卡） */
  detail?: string;
  tool?: string;
  target?: string;
}

const ANALYZE_RE =
  /任务分析|分析任务|计划已就绪|任务分析完成|已提交任务分析|Analyze|bootstrap_plan|plan_seed/i;
const THOUGHT_RE =
  /思考[：:]|思考中|上步反思|下一步目标|等待模型|未调工具|大脑规划|大脑重规划|计划就绪|判断大脑|工作记忆|同站记忆|选模|模型池|进程提示|bu_agent_thinking|bu_agent_step|evaluation|next_goal|memory|等待 sidecar/i;
/** 强思考信号：整段就是模型推理/目标，命中即定 thought，不再让动作词抢走归类 */
const STRONG_THOUGHT_RE = /^(?:思考|上步反思|下一步目标|大脑规划|大脑重规划)[：:]/;
const PERCEIVE_RE =
  /观察页面|提取完成|感知|开眼|页面阅读|可见感知|page_perceive|control_memory|结构指纹|截图|browser_state|interactive/i;
const ACTION_RE =
  /正在打开|已打开|自动驾驶打开|导航到|引导打开|正在执行第|回放第|点击|填写|填表|滚动|视觉定位|旁路|goto|navigate|fill|click|scrape|下载|抓取|multi_act|input|extract|search_page|done|执行动作|动作结果|已召回技能|召回技能/i;
const ALERT_RE =
  /人工接管|等待人工|等待人工补充|请确认|确认队列|人工确认|用户取消|已继续|请提供|协同|置顶浏览器|handover|agent_confirm_required|handover_required|agent_ask_user/i;
const JUDGE_RE = /bu_agent_judge|验收评判/i;

/**
 * 去掉【…】标注块：标注属于元数据，不参与**动作词**判定。
 * 否则「【页面阅读·…·无需滚动】」里的「滚动」会把一次页面阅读误判成滚动动作。
 * 注意只用于动作判定：类型信号（如「页面阅读」本身）仍要从全文里读。
 */
function stripAnnotations(text: string): string {
  return text
    .replace(/【[^】]*】/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 技能手册 / 教条正文：文中会提到 ask_user，但不是真实 HITL */
function isSkillOrManualDump(text: string): boolean {
  return /#\s*Skill:|已召回技能|##\s*何时用|本轮唯一动作|格号\s*[-→>]|网格化定位|禁止\s*`?ask_user|禁止ask_user/i.test(
    text,
  );
}

/** 真实「等待补充」信号（排除「禁止 ask_user 代点」一类教条） */
function isRealHitlAsk(text: string): boolean {
  if (isSkillOrManualDump(text)) return false;
  if (/禁止.{0,16}ask_user|勿用\s*ask_user|不要用\s*ask_user|勿\s*ask_user/i.test(text)) {
    return false;
  }
  return (
    /agent_ask_user|等待人工补充|补充信息|请输入收到的|用户回答\s*[：:]/i.test(text) ||
    (/请提供/.test(text) && !/动作结果/.test(text))
  );
}

/** 从动作文案里抽目标（「点击「搜索」」/ 打开百度） */
function extractActionTarget(text: string): string | undefined {
  const quoted = text.match(/[「"']([^」"']{1,40})[」"']/);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const open = text.match(/(?:打开|导航|前往)\s*[「"]?([^\s「」"']{2,40})/);
  if (open?.[1]) {
    return open[1].replace(/[。.…]+$/, "");
  }
  return undefined;
}

function extractToolHint(text: string): string | undefined {
  if (/任务分析|分析任务|计划就绪|任务分析完成/i.test(text)) {
    return "analyze";
  }
  // 「启动：…打开…」是目标复述，不是 navigate 动作
  if (/^▶\s*启动[：:]/.test(text) || /^启动 Agent/.test(text)) {
    return undefined;
  }
  if (/导航|打开|goto|navigate|引导打开/i.test(text)) {
    return "navigate";
  }
  if (/填写|填表|fill/i.test(text)) {
    return "fill";
  }
  if (/点击|click/i.test(text)) {
    return "click";
  }
  if (/视觉|vision|开眼/i.test(text)) {
    return "vision";
  }
  if (/滚动|scroll/i.test(text)) {
    return "scroll";
  }
  if (/抓取|下载|scrape/i.test(text)) {
    return "scrape";
  }
  if (/接管|handover/i.test(text)) {
    return "handover";
  }
  if (/确认|confirm/i.test(text)) {
    return "confirm";
  }
  return undefined;
}

/**
 * 将一条 Monitor 日志归类为思考流卡片。
 * 优先使用 line.kind；否则按文案启发式识别。
 */
export function classifyAgentMonitorLine(line: TerminalLine): ClassifiedAgentLine {
  const text = String(line.text ?? "").trim();
  /** 动作判定用文案：标注块里的动词不算动作 */
  const actionProbe = stripAnnotations(text);
  const explicit = line.kind;
  const preview = (limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

  // 任务分析优先于「启动含打开→误标导航」
  if ((explicit === "thought" && ANALYZE_RE.test(text)) || (!explicit && ANALYZE_RE.test(text))) {
    return {
      kind: "thought",
      title: "任务分析",
      body: preview(72),
      detail: text,
      tool: "analyze",
    };
  }

  if (
    explicit === "thought" ||
    STRONG_THOUGHT_RE.test(text) ||
    (!explicit && THOUGHT_RE.test(text) && !ALERT_RE.test(text))
  ) {
    const isPlanning = /计划就绪|大脑规划|重规划|任务分析/.test(text);
    const isWaitingLlm = /等待模型/.test(text);
    return {
      kind: "thought",
      title: isPlanning ? "任务分析" : isWaitingLlm ? "等待模型" : "AI 思考",
      body: preview(72),
      detail: text,
      tool: extractToolHint(text),
    };
  }

  // 自动验收评判 ≠ 人工协同
  if (JUDGE_RE.test(text)) {
    const failed = /未通过|false|失败/i.test(text);
    return {
      kind: failed ? "error" : "success",
      title: "验收评判",
      body: preview(120),
      tool: "judge",
    };
  }

  if (explicit === "perceive" || (!explicit && PERCEIVE_RE.test(text) && !ACTION_RE.test(actionProbe))) {
    return {
      kind: "perceive",
      title: "页面感知",
      body: preview(160),
      tool: "perceive",
    };
  }

  // 技能召回 / 手册正文：一律当动作，勿因文中「ask_user」标成「等待补充」
  if (!explicit && isSkillOrManualDump(text)) {
    return {
      kind: "action",
      title: /召回技能|#\s*Skill:/i.test(text) ? "召回技能" : "执行动作",
      body: preview(120),
      tool: "skill",
    };
  }

  if (
    explicit === "alert" ||
    (!explicit && ((ALERT_RE.test(text) && !isSkillOrManualDump(text)) || line.tone === "warn"))
  ) {
    const toolHint = line.meta?.tool ?? extractToolHint(text);
    const isHandover = toolHint === "handover" || /接管|handover/i.test(text);
    // 勿用「验证码」单独标 ask：普通思考提到验证码不是 HITL 弹窗
    const isConfirm =
      toolHint === "confirm" ||
      /agent_confirm_required|确认队列|用户取消点击确认|用户取消填写确认/i.test(text);
    const isAsk = toolHint === "ask" || isRealHitlAsk(text);
    // warn 但非真实 HITL（如普通告警文案）且非接管/确认 → 降级为系统，避免误标「需人工」
    if (!explicit && line.tone === "warn" && !isHandover && !isConfirm && !isAsk && !ALERT_RE.test(text)) {
      return {
        kind: "system",
        title: "提示",
        body: preview(160),
        tool: toolHint,
      };
    }
    return {
      kind: "alert",
      title: isHandover ? "人工接管" : isConfirm ? "人工确认" : isAsk ? "等待补充" : "需要协同",
      body: preview(200),
      detail: line.meta?.detail,
      tool: isHandover ? "handover" : isConfirm ? "confirm" : isAsk ? "ask" : toolHint,
      target: line.meta?.target ?? extractActionTarget(text),
    };
  }

  if (explicit === "action" || (!explicit && ACTION_RE.test(actionProbe))) {
    const tool = line.meta?.tool ?? extractToolHint(actionProbe);
    const target = line.meta?.target ?? extractActionTarget(text);
    let title = "执行动作";
    if (/^动作结果/.test(text)) {
      title = "动作结果";
    } else if (tool === "navigate") {
      title = "打开页面";
    } else if (tool === "fill") {
      title = "填写表单";
    } else if (tool === "click") {
      title = "点击控件";
    } else if (tool === "vision") {
      title = "视觉定位";
    } else if (tool === "scrape") {
      title = "数据采集";
    }
    return {
      kind: "action",
      title,
      body: preview(200),
      tool,
      target,
    };
  }

  if (explicit === "success" || line.tone === "success") {
    return {
      kind: "success",
      title: "完成",
      body: preview(200),
    };
  }

  if (explicit === "error" || line.tone === "error") {
    return {
      kind: "error",
      title: "失败",
      body: preview(200),
    };
  }

  return {
    kind: "system",
    title: "系统",
    body: preview(200),
  };
}

/** agent-state 推送时的轻量 kind 标注（文案分类器仍可兜底） */
export function inferAgentLineKind(
  text: string,
  tone: TerminalLine["tone"],
  state?: string,
): Pick<TerminalLine, "kind" | "meta"> | undefined {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return undefined;
  }
  const actionProbe = stripAnnotations(raw);
  if (tone === "error" || state === "failed") {
    return { kind: "error" };
  }
  if (tone === "success" || state === "complete") {
    return { kind: "success" };
  }
  if (isSkillOrManualDump(raw)) {
    return {
      kind: "action",
      meta: { tool: "skill", detail: raw },
    };
  }
  if (STRONG_THOUGHT_RE.test(raw)) {
    return { kind: "thought", meta: { detail: raw } };
  }
  if (ALERT_RE.test(raw) || isRealHitlAsk(raw)) {
    return {
      kind: "alert",
      meta: { tool: extractToolHint(raw), detail: raw },
    };
  }
  if (ANALYZE_RE.test(raw)) {
    return { kind: "thought", meta: { tool: "analyze", detail: raw } };
  }
  if (JUDGE_RE.test(raw)) {
    const failed = /未通过|false|失败/i.test(raw);
    return { kind: failed ? "error" : "success", meta: { tool: "judge" } };
  }
  if (THOUGHT_RE.test(raw) && !ACTION_RE.test(actionProbe)) {
    return { kind: "thought", meta: { detail: raw } };
  }
  if (PERCEIVE_RE.test(raw) && !ACTION_RE.test(actionProbe)) {
    return { kind: "perceive" };
  }
  if (ACTION_RE.test(actionProbe)) {
    return {
      kind: "action",
      meta: {
        tool: extractToolHint(actionProbe),
        target: extractActionTarget(raw),
      },
    };
  }
  return undefined;
}
