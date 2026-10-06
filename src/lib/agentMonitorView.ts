/**
 * Agent Monitor 视图层：把原始 agent-state 流水账压成「人话卡片」。
 *
 * 产品诉求（Agent Monitor 日志显示优化）：
 *  1. 说人话 —— 内部工具名 / 协议字段 / 机器缩写一律翻译成中文动作描述；
 *  2. 去噪音 —— 纯进程调度日志（并发槽、临时图销毁…）直接丢弃，只汇报条数；
 *  3. 合并重复 —— 同一「步骤」内结构性相同的日志合并为一张卡，带 ×N 与可展开明细；
 *  4. 分段 —— 「第 N/M 步」变成分隔标题，长流程一眼看出推进到哪一步。
 *
 * 铁律：本文件只做「通用机器腔 → 通用人话」的映射与聚合，不得出现任何具体网站、
 * 业务文案或选择器的硬编码；新增站点无需改动此处。
 */
import type { TerminalLine } from "../types";
import { classifyAgentMonitorLine, type AgentThoughtKind } from "./agentThoughtChain";

export type AgentMonitorCardKind = AgentThoughtKind | "step" | "raw";

export interface AgentMonitorItem {
  id: string;
  ts: string;
  /** 翻译成人话后的文本 */
  text: string;
  /** 原始文本（展开明细时对照用） */
  raw: string;
}

export interface AgentMonitorCard {
  id: string;
  kind: AgentMonitorCardKind;
  /** 原始日志行的语气；仅 "raw" 卡片用于着色 */
  tone?: TerminalLine["tone"];
  title: string;
  body: string;
  detail?: string;
  tool?: string;
  target?: string;
  /** 合并过程中收集到的所有目标（内部使用，最终汇总到 target） */
  targets?: string[];
  /** 首条时间 */
  ts: string;
  /** 末条时间（未合并时与 ts 相同） */
  lastTs: string;
  /** 合并条数 */
  count: number;
  items: AgentMonitorItem[];
}

export interface AgentMonitorView {
  cards: AgentMonitorCard[];
  /** 被丢弃的纯系统噪音条数 */
  droppedNoise: number;
  /** 原始日志总条数 */
  totalLines: number;
}

const THOUGHT_BODY_CHARS = 90;
const CARD_BODY_CHARS = 220;
/** 超过卡片篇幅的正文按「交付物」处理：逐字展开，不套日志人话化（会改坏正文） */
const VERBATIM_BODY_MIN_CHARS = 240;
const MAX_TARGET_CHIPS = 3;

/* ------------------------------------------------------------------ *
 * 一、机器腔 → 人话
 * ------------------------------------------------------------------ */

const CIRCLED_NUMERALS = "①②③④⑤⑥⑦⑧⑨⑩";

/** 「① xxx」「②b xxx」「③′ xxx」→「1. xxx」 */
function humanizeStepMarker(text: string): string {
  const match = text.match(/^([①②③④⑤⑥⑦⑧⑨⑩])([a-z′']?)\s*/);
  if (!match) {
    return text;
  }
  const index = CIRCLED_NUMERALS.indexOf(match[1]) + 1;
  return `${index}${match[2]}. ${text.slice(match[0].length)}`;
}

const FRAME_TIMING_RE = /逐帧时长\s*([\d/]+)\s*ms\s*→\s*权重\s*[\d./]+（按权重计票）/;

/**
 * 逐帧停留时长是「找停留最久的字符」类验证码的关键证据，
 * 原文把整串权重数组也打了出来（纯噪音），这里只保留「哪一帧停留最久」这个结论。
 */
function humanizeFrameTiming(text: string): string {
  return text.replace(FRAME_TIMING_RE, (_match, rawList: string) => {
    const durations = rawList
      .split("/")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));
    if (durations.length === 0) {
      return "逐帧停留时长已记录（按停留时长加权计票）";
    }
    let longest = 0;
    durations.forEach((value, index) => {
      if (value > durations[longest]) {
        longest = index;
      }
    });
    const preview = durations.slice(0, 6).join("/");
    const ellipsis = durations.length > 6 ? "/…" : "";
    return `逐帧停留时长 ${preview}${ellipsis}ms（共 ${durations.length} 帧，第 ${
      longest + 1
    } 帧停留最久 → 按停留时长加权计票）`;
  });
}

/** 单帧读码结果：剥掉 len/可辨/自报/json 这类机器字段。 */
function humanizeFrameResult(text: string): string {
  return (
    text
      .replace(/^第 (\d+) 帧任务结束，.*$/g, "")
      // LLM 原始输出动辄上百字，只留结论
      .replace(/^第 (\d+) 帧(?:未读出码|请求失败)，排除：[\s\S]*$/g, "第 $1 帧看不清，跳过")
      .replace(/^第 (\d+) 帧未读出码，短提示重试…$/g, "第 $1 帧看不清，换个提示再读")
      .replace(/^第 (\d+) 帧仍未读出，放大后重读（兜底）…$/g, "第 $1 帧仍看不清，放大后再读")
      .replace(/^第 (\d+) 帧已读到 (\S+)，追问清晰度…$/g, "第 $1 帧读到 $2，再确认一次")
      .replace(
        /^第 (\d+) 帧\(源帧\d+\/([\w-]+)\/权重([\d.]+)\)入内存：code=(\S+)（len=(\d+)）可辨=(\S+) 自报=([\d.]+)\((\w+)\) · 内存 (\d+) 条$/,
        (
          _match,
          frame: string,
          variant: string,
          weight: string,
          code: string,
          len: string,
          legible: string,
          confidence: string,
          _via: string,
          total: string,
        ) =>
          `第 ${frame} 帧结果：${code} · 长度 ${len} · 清晰 ${legible} 字 · 自评 ${confidence} · ${
            variant === "denoise" ? "去噪版" : "原图"
          } · 权重 ${weight} · 已收集 ${total} 条`,
      )
  );
}

/** 滑块定位/测量的机器字段 → 人话。 */
function humanizeSliderGeometry(text: string): string {
  return text
    .replace(
      /^已定位底图 ([\d×]+) · 轨道宽 (\d+) · 手柄\(([\d,]+)\) · 拼图块 DOM 未定位$/,
      "底图 $1 · 轨道宽 $2 · 手柄 ($3) · 拼图块未定位",
    )
    .replace(
      /^OpenCV 缺口：gapX=([\d.]+) pieceX=- conf=([\d.]+) \S+$/,
      "识别缺口：位置 $1px · 拼图块未定位 · 置信度 $2",
    )
    .replace(
      /^候选缺口：\[pixel=([\d.]+)@([\d.]+) opencv=([\d.]+)@([\d.]+)\] piece=([\d.]+)\((\w+)\)$/,
      "候选缺口：像素识别 $1（$2）· 图像识别 $3（$4）· 拼图块 $5px（$6）",
    )
    .replace(
      /^候选缺口：\[pixel=([\d.]+)@([\d.]+) opencv=([\d.]+)@([\d.]+)\] piece=0\(none\)$/,
      "候选缺口：像素识别 $1（$2）· 图像识别 $3（$4）· 拼图块未定位",
    )
    .replace(
      /缺口 ([\d.]+)px · 拼图块 (?:([\d.]+)px|未定位) · 自洽拖距 ([\d.]+)px → 拖距 ([\d.]+)px \/ 可用 (\d+) · (\S+) · conf=([\d.]+)/,
      (
        _match,
        gap: string,
        piece: string | undefined,
        selfDistance: string,
        drag: string,
        available: string,
        method: string,
        confidence: string,
      ) =>
        `缺口 ${gap}px · 拼图块 ${
          piece && Number(piece) > 0 ? `${piece}px` : "未定位"
        } · 推算要拖 ${selfDistance}px → 实际拖 ${drag}px（最长可拖 ${available}px）· ${method} · 置信度 ${confidence}`,
    );
}

/** 「【页面阅读·脚本抽取·净化可见文本·无需滚动】」→「【页面阅读】」 */
function collapseBracketTags(text: string): string {
  return text.replace(/【([^】]+)】/g, (_match, inner: string) => {
    const segments = inner.split(/[·•|]/).map((part) => part.trim());
    return `【${segments[0] || inner}】`;
  });
}

/** 「滑块验证失败（验证失败）」这类尾括号复读直接去掉。 */
function dedupeRedundantTail(text: string): string {
  return text.replace(/（([^（）]{2,20})）\s*$/g, (match, inner: string) => {
    const head = text.slice(0, text.length - match.length);
    return head.endsWith(inner) ? "" : match;
  });
}

/** 中文之间的空格（多由替换英文标识符产生）一并去掉，句子才顺。 */
function collapseCjkSpacing(text: string): string {
  return text
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, "$1")
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[，。！？；：、）】])/g, "$1")
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[（])/g, "$1");
}

/** 有序词表：先长后短、先专有后通用，避免互相误伤。 */
const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // —— 步骤前缀：卡片本身已经在分段标题下，正文再复读一次就是噪音 ——
  [/^第 \d+ 步[：:]\s*/g, ""],

  // —— 帧导出链路（必须在 JPEG/GDI 之类缩写被泛化之前处理）——
  [/拆帧转\s*(?:JPEG|图片)（导出 (\d+)\/\d+ 帧）/g, "拆成 $1 帧图片"],
  [/已导出 (\d+) 帧\s*(?:JPEG|图片)（[^）]*）/g, "拆成 $1 帧图片"],
  [/已生成去噪帧变体 (\d+) 个并入读码池/g, "又生成 $1 张去噪版，一起送识别"],
  [/验证码识别中…（并发 (\d+) · (\d+) 帧 · [^）]*）/g, "同时识别 $1 张 · 共 $2 帧"],
  [/；候选 [\s\S]*$/g, ""],
  [/\(最清晰帧 (\d+)\)/g, "（第 $1 帧）"],

  // —— 验证码子步骤的结论字段 ——
  [/\bverified\s*[:=]\s*false/gi, "验证未通过"],
  [/\bverified\s*[:=]\s*true/gi, "验证通过"],
  [/\bverified\s*[:=]\s*null/gi, "验证结果不明确"],
  [/\bsignal\s*[:=]\s*no_clear_signal/gi, "（页面无明确反馈）"],
  [/\bsignal\s*[:=]\s*(?:验证失败|false)/gi, "（页面未接受）"],
  [/\bsignal\s*[:=]\s*true/gi, "（页面已接受）"],
  [/\bsignal\s*[:=]\s*\S+/gi, ""],
  [/\bsuccess\s*[:=]\s*true/gi, "成功"],
  [/\bsuccess\s*[:=]\s*false/gi, "失败"],
  [/\bconf\s*[:=]\s*([\d.]+)/gi, "置信度 $1"],
  [/\bdragDistance\s*[:=]\s*([\d.]+)/gi, "拖动距离 $1px"],
  [/\bgapX\s*[:=]\s*([\d.]+)/gi, "缺口位置 $1px"],
  [/\bdrag\s*[:=]\s*([\d.]+)/gi, "拖动距离 $1px"],
  [/\bpieceX\s*[:=]\s*-/gi, "拼图块未定位"],
  [/\bpiece\s*[:=]\s*([\d.]+)/gi, "拼图块 $1px"],
  [/\blen\s*[:=]\s*(\d+)/gi, "长度 $1"],
  [/可辨\s*[:=]\s*(\S+)/g, "清晰 $1 字"],
  [/自报\s*[:=]\s*([\d.]+)/g, "自评 $1"],
  [/\bcode\s*[:=]\s*/gi, ""],
  [/·\s*内存 (\d+) 条/g, "· 已收集 $1 条"],

  // —— 内部工具 / 模型 / 模块名，一律不露面 ——
  [/（模型\s*[\w.-]+）/g, "（AI 模型）"],
  [/\b(?:deepseek|gpt|claude|gemini|qwen|glm|moonshot|kimi)[-\w.]*/gi, "AI 模型"],
  [/solve_captcha/gi, "处理验证码"],
  [/recall_skill/gi, "查阅技能手册"],
  [/ask_user/gi, "询问用户"],
  [/(?:已召回技能|已载入技能|召回技能)\s*[:：]?\s*[\w-]*/g, "已查阅技能手册"],
  // 只翻译独立出现的 sidecar 一词；被 \ 或 / 包夹时是路径片段，翻译会毁掉可打开的路径
  [/(?<![\\/\w.-])sidecar(?![\\/\w.-])/gi, "后台服务"],
  [/\bHITL\b/g, "人工接管"],
  [/\bforceStrategy\b/g, "指定验证类型"],
  [/\bbrowser_state\b|\bpage_digest\b|\bpage_perceive\b/g, "页面快照"],
  [/\bRequest was aborted\.?/gi, "请求被中断"],
  [/\bOpenCV\b/g, "图像识别"],
  [/\bfuse:[\w+]+/gi, "交叉校验"],
  [/\bpixel\b/gi, "像素识别"],
  [/\bcanvas\b/gi, "画布"],
  [/\bGIF验证码识别\(帧(\d+)\)/g, "动图验证码识别（第 $1 帧）"],
  [/\bGIF\b/gi, "动图"],
  [/\bJPEG\b/gi, "图片"],

  // —— 验证码类型 id ——
  [/slider_gap_drag/g, "滑块缺口拖拽"],
  [/image_text_read/g, "图片字符识别"],
  [/math_image_solve/g, "算式图计算"],
  [/point_select_click/g, "点选点击"],
  [/press_hold_no_accessibility/g, "长按（无无障碍入口）"],
  [/press_hold_ok/g, "长按通过"],
  [/press_hold_fail/g, "长按失败"],
  [/press_hold_done/g, "长按已执行"],
  [/press_hold_captcha/g, "长按按钮"],
  [/press_hold/g, "长按验证"],

  // —— 流程 / 状态措辞 ——
  [/类型门禁通过：/g, "已确认验证类型："],
  [/类型门禁：/g, "验证类型："],
  [/第 (\d+) 帧请求失败，排除：[\s\S]*/g, "第 $1 帧读取失败，跳过"],
  [/\bAnalyze\b\s*→\s*\bBootstrap\b\s*→\s*\bExecute\b/gi, "分析 → 准备 → 执行"],
  [/（rule\+llm）/gi, "（规则 + 模型）"],
  [/验收#(\d+)/g, "第 $1 次校验"],
  [/验收(\d+)/g, "第 $1 次校验"],
  [/验收/g, "校验"],
  [/拟人拖拽重试#(\d+)/g, "第 $1 次重新拖动"],
  [/拟人拖拽/g, "模拟人手拖动"],
  [/DOM 未完全静默（已达 (\d+)ms 上限）/g, "页面仍在变化（已等 $1ms 上限）"],
  [/DOM 静默 (\d+)ms/g, "页面已稳定 $1ms"],
  [/截图关闭/g, "未截图"],
  [/Agent 快速就绪/g, "就绪很快"],
  [/可见可交互元素 (\d+) 个/g, "可操作元素 $1 个"],
  [/· (\d+) 控件 ·/g, "· 控件 $1 个 ·"],
  [/（逻辑模）/g, "（深度思考模式）"],
  [/（快模\+精简工具）/g, "（快速模式）"],
  [/已手动停止：用户中止\s*Agent/g, "已手动停止（用户主动中止）"],
  [/^Agent\s+/g, ""],
  [/页面阅读就绪/g, "页面已读"],
  [/引擎=other/g, "渲染：其他"],
  [/类型=generic/g, "页面类型：通用"],
  [/type=featured/g, "推荐项"],
  [/页面可见正文 内容：/g, "正文："],

  // —— 收尾清理：多余分隔符 / 空括号 / 连续空白 ——
  [/（\s*）/g, ""],
  [/\s*·\s*·\s*/g, " · "],
  [/\s{2,}/g, " "],
];

/**
 * 翻译前先把绝对路径整段抽离，避免词表（sidecar/canvas/JPEG…）误伤文件路径。
 * 日志里给用户的落盘路径必须原样可点开，任何「机器腔 → 人话」的替换都不许碰它。
 */
const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`（）()【】<>|]+/g;

function protectPaths(text: string): {
  text: string;
  restore: (value: string) => string;
} {
  const tokens: string[] = [];
  const masked = text.replace(PATH_TOKEN_RE, (match) => {
    const index = tokens.push(match) - 1;
    return `\u0001${index}\u0001`;
  });
  return {
    text: masked,
    restore: (value: string) =>
      value.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => tokens[Number(index)] ?? ""),
  };
}

export function humanizeAgentText(text: string): string {
  const source = String(text ?? "").trim();
  if (!source) {
    return "";
  }
  const { text: masked, restore } = protectPaths(source);
  let output = humanizeStepMarker(masked);
  output = humanizeFrameTiming(output);
  output = humanizeFrameResult(output);
  output = humanizeSliderGeometry(output);
  output = collapseBracketTags(output);
  for (const [pattern, replacement] of TEXT_RULES) {
    output = output.replace(pattern, replacement);
  }
  output = dedupeRedundantTail(output);
  output = collapseCjkSpacing(output);
  output = restore(output);
  return output.replace(/^[\s·,，;；]+|[\s·,，;；]+$/g, "").trim() || source;
}

/* ------------------------------------------------------------------ *
 * 二、纯系统噪音（不进 Monitor，只计数）
 * ------------------------------------------------------------------ */

const NOISE_RULES: ReadonlyArray<RegExp> = [
  /^第 \d+ 帧任务结束，已销毁图片 \d+ 个并释放并发槽$/,
  /^读码第 \d+\/\d+ 帧…（并发池）$/,
  /^已销毁滑块临时图 \d+ 个$/,
  /^已销毁图片 \d+ 个/,
  /^已清理验证码临时文件 \d+ 项/,
  /^抽样 \d+\/\d+ 帧后送视觉$/,
  /^验证码识别中…（并发/,
  /^算式采帧：/,
];

function isSystemNoise(text: string, line: TerminalLine): boolean {
  // 失败/警告一律保留：报错永远不是噪音
  if (line.tone === "error" || line.tone === "warn" || line.kind === "error") {
    return false;
  }
  return NOISE_RULES.some((pattern) => pattern.test(text));
}

/* ------------------------------------------------------------------ *
 * 三、合并与标题
 * ------------------------------------------------------------------ */

const STEP_RE = /^第\s*(\d+)\s*\/\s*(\d+)\s*步[：:]\s*(.*)$/;

/**
 * 「连续同阶段」可合并类型：思考/分析类进度（已提交任务分析 → 任务分析中 → 任务分析完成）
 * 是同一阶段的推进，正文不同但用户只想看当前进展，故压成一张卡（正文取最新，历史进明细）。
 * 感知/动作/告警一律不参与，保持各自的独立语义。
 */
const STAGE_MERGE_KINDS: ReadonlySet<AgentThoughtKind> = new Set(["thought"]);

/**
 * 合并签名：只保留中文骨架，数字/字母/符号一律抹平。
 * 这样「第 1 帧结果：5rNu…」与「第 3 帧结果：4G8l…」会落进同一张卡，
 * 而中文语义不同（如「点击搜索」vs「点击登录」）的日志不会被误合并。
 */
function signatureOf(kind: string, title: string, tool: string | undefined, text: string): string {
  const skeleton = text
    .replace(/[^\u4e00-\u9fff]+/g, "#")
    .replace(/#{2,}/g, "#")
    .replace(/^#|#$/g, "");
  return `${kind}|${title.replace(/\d+/g, "N")}|${tool ?? ""}|${skeleton}`;
}

/** 生成标题时要切断的分隔符：越过它就说明已经进入「值」而不是「标签」了。 */
const TITLE_SEPARATORS = /[…·,，。;；|（）()【】[\]]/;

/**
 * 序号类标签里的数字抹成 N（「第 1 帧结果」→「第 N 帧结果」），
 * 让同一系列的卡片读数一致；普通带数量的标签保留真实数字，避免出现看不懂的 N。
 */
function maskOrdinal(label: string): string {
  return /^第/.test(label) ? label.replace(/\d+/g, "N") : label;
}

/** 机器标签 → 卡片标题：「第 1 帧结果：…」→「第 N 帧结果」；否则取第一个短语。 */
function deriveSystemTitle(text: string): string | undefined {
  const withoutMarker = text
    .replace(/^\d+[a-z]?\.\s*/, "")
    .replace(/^第\s*\d+\s*\/?\s*\d*\s*步[：:]\s*/, "")
    .trim();

  const colonLabel = withoutMarker.match(/^([^：:]{2,14})[：:]/);
  if (
    colonLabel &&
    /[\u4e00-\u9fff]/.test(colonLabel[1]) &&
    // 「第 1 步」这类纯序号不配当标题
    !/^第\s*\d+\s*步?$/.test(colonLabel[1].trim())
  ) {
    return maskOrdinal(colonLabel[1].trim());
  }

  const head = withoutMarker.split(TITLE_SEPARATORS)[0].trim();
  const cleaned = head
    .replace(/^[A-Za-z][A-Za-z0-9_.-]*\s*/, "")
    .replace(/[\sN\d.×xX*/+-]*[A-Za-z]+[\sN\d.×xX*/+-]*$/, "")
    .replace(/[\sN\d.×xX*/+-]+$/, "")
    .trim();
  return /[\u4e00-\u9fff]{2,}/.test(cleaned) ? maskOrdinal(cleaned.slice(0, 12)) : undefined;
}

function clampBody(text: string, kind: AgentMonitorCardKind): string {
  const limit = kind === "thought" ? THOUGHT_BODY_CHARS : CARD_BODY_CHARS;
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 卡片标题已在标题栏展示，正文里再复读一次就删掉。 */
function stripTitlePrefix(text: string, title: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/N/g, "\\d+");
  const pattern = new RegExp(
    `^(?:(?:第\\s*\\d+\\s*步|\\d+[a-z]?\\.)\\s*[：:]?\\s*)?${escaped}[：:…\\s，,（(]\\s*`,
  );
  let stripped = text
    .replace(pattern, "")
    .replace(/^[|｜·、,，:：\s]+/, "")
    .trim();
  // 标题里带开括号、正文里留下落单的闭括号时补一刀，避免出现「…中止）」
  if (countChar(stripped, "）") > countChar(stripped, "（")) {
    stripped = stripped.replace(/）\s*$/, "").trim();
  }
  return stripped || text;
}

function countChar(text: string, char: string): number {
  return text.split(char).length - 1;
}

function toItem(line: TerminalLine, humanized: string): AgentMonitorItem {
  return { id: line.id, ts: line.ts, text: humanized, raw: String(line.text ?? "") };
}

function finalizeTargets(cards: AgentMonitorCard[]): void {
  for (const card of cards) {
    const targets = card.targets ?? [];
    if (targets.length === 0) continue;
    card.target =
      targets.slice(0, MAX_TARGET_CHIPS).join(" / ") +
      (targets.length > MAX_TARGET_CHIPS ? ` 等 ${targets.length} 个` : "");
  }
}

/* ------------------------------------------------------------------ *
 * 四、主入口
 * ------------------------------------------------------------------ */

export function buildAgentMonitorView(
  lines: TerminalLine[],
  options: { compact?: boolean } = {},
): AgentMonitorView {
  const compact = options.compact ?? true;
  const totalLines = lines.length;

  if (!compact) {
    return { cards: buildVerboseCards(lines), droppedNoise: 0, totalLines };
  }

  const cards: AgentMonitorCard[] = [];
  let droppedNoise = 0;
  /** 当前「第 N 步」作用域内的签名索引；跨步不合并，避免把两次独立尝试混成一条。 */
  let scopeIndex = new Map<string, AgentMonitorCard>();
  let currentStep: AgentMonitorCard | undefined;
  let currentStepCount = 0;

  const closeScope = () => {
    if (currentStep) {
      currentStep.count = currentStepCount;
    }
    scopeIndex = new Map<string, AgentMonitorCard>();
    currentStepCount = 0;
  };

  for (const line of lines) {
    const raw = String(line.text ?? "");
    if (!raw.trim()) continue;

    const step = raw.trim().match(STEP_RE);
    if (step) {
      closeScope();
      const stepCard = makeStepCard(line, step[1], step[2], step[3]);
      cards.push(stepCard);
      currentStep = stepCard;
      continue;
    }

    if (isSystemNoise(raw, line)) {
      droppedNoise += 1;
      continue;
    }

    // 长正文（超出卡片篇幅）多半是交付物正文，如 done 的结论 / 页面总结。
    // 人话化规则是为短进度行写的，套到长正文上会改写甚至整段吞掉（例如「；候选 …」规则），
    // 交付物必须逐字呈现，因此长正文跳过翻译，只由 clampBody 折叠展示。
    const verbatim = raw.length > VERBATIM_BODY_MIN_CHARS;
    const humanized = verbatim ? raw : humanizeAgentText(raw);
    if (!humanized) {
      droppedNoise += 1;
      continue;
    }

    const classified = classifyAgentMonitorLine({ ...line, text: humanized });
    const derivedTitle = classified.kind === "system" ? deriveSystemTitle(humanized) : undefined;
    const title = derivedTitle ?? classified.title;
    const clamped = clampBody(humanized, classified.kind);
    const body = stripTitlePrefix(clamped, title);
    const target = classified.target ?? extractInlineTarget(humanized);
    const detail = clamped.length < humanized.length ? humanized : classified.detail;
    // 连续同阶段合并：上一条也是同类「思考/分析」进度时，并入上一张卡。
    // cards 末位即「上一条可见卡」；中间夹了动作/感知/分段卡就自然断开，保证只合并相邻同类。
    const previous = cards[cards.length - 1];
    if (previous && previous.kind === classified.kind && STAGE_MERGE_KINDS.has(classified.kind)) {
      previous.count += 1;
      previous.lastTs = line.ts;
      // 阶段卡展示「当前进展」，因此正文与详情取最新一条，历史全部留在明细里
      previous.body = body;
      previous.detail = detail;
      previous.items.push(toItem(line, humanized));
      if (target) {
        (previous.targets ??= []).push(target);
        previous.target ??= target;
      }
      currentStepCount += 1;
      continue;
    }

    const signature = signatureOf(classified.kind, title, classified.tool, body);
    const existing = scopeIndex.get(signature);

    if (existing) {
      existing.count += 1;
      existing.lastTs = line.ts;
      existing.items.push(toItem(line, humanized));
      if (target) {
        (existing.targets ??= []).push(target);
      }
      currentStepCount += 1;
      continue;
    }

    const card: AgentMonitorCard = {
      id: line.id,
      kind: classified.kind,
      title,
      body,
      // 正文被截断时，把完整人话留在展开区，确保关键信息不丢
      detail,
      tool: classified.tool,
      target,
      targets: target ? [target] : [],
      ts: line.ts,
      lastTs: line.ts,
      count: 1,
      items: [toItem(line, humanized)],
    };
    scopeIndex.set(signature, card);
    cards.push(card);
    currentStepCount += 1;
  }

  closeScope();
  finalizeTargets(cards);

  return { cards, droppedNoise, totalLines };
}

function makeStepCard(line: TerminalLine, index: string, total: string, body: string): AgentMonitorCard {
  const label = body
    .replace(/[：:]\s*$/, "")
    .replace(/…+$/, "")
    .trim();
  return {
    id: line.id,
    kind: "step",
    title: `第 ${index}/${total} 步`,
    body: humanizeAgentText(label) || "继续执行",
    ts: line.ts,
    lastTs: line.ts,
    count: 0,
    items: [toItem(line, label)],
  };
}

/**
 * 完整模式：还原**原始流水账** —— 逐行照抄，不翻译、不合并、不丢弃任何一条，
 * 只保留「第 N/M 步」分段标题，便于逐行排查问题。
 *
 * 注意：这里刻意**不再做卡片归类**。否则完整模式与精简模式会渲染出几乎相同的
 * 卡片（同样的人话标题 + 相近正文），用户切换后看不出区别。原始行必须原样呈现。
 */
function buildVerboseCards(lines: TerminalLine[]): AgentMonitorCard[] {
  const cards: AgentMonitorCard[] = [];
  for (const line of lines) {
    const raw = String(line.text ?? "").trim();
    if (!raw) continue;
    const step = raw.match(STEP_RE);
    if (step) {
      cards.push(makeStepCard(line, step[1], step[2], step[3]));
      continue;
    }
    cards.push({
      id: line.id,
      kind: "raw",
      tone: line.tone,
      title: "",
      body: raw,
      ts: line.ts,
      lastTs: line.ts,
      count: 1,
      items: [toItem(line, raw)],
    });
  }
  return cards;
}

/** 从「点击「搜索」」这类文案里补一个目标标签（分类器的前端兜底）。 */
function extractInlineTarget(text: string): string | undefined {
  const quoted = text.match(/[「"']([^」"']{1,40})[」"']/);
  return quoted?.[1];
}
