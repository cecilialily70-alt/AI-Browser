/**
 * 轨迹语义嗅探 — Label / inputType 结构化落盘，供沙盘展示与 JIT 造数约束
 *
 * 优先级（严格）：
 * 1. aria-label
 * 2. placeholder
 * 3. <label for="..."> / element.labels 的 innerText
 * 4. 相邻前置文本节点
 * 5. input type（email/tel/…）保底
 */
export type SemanticLabelSource =
  | "aria-label"
  | "placeholder"
  | "label-for"
  | "adjacent-text"
  | "input-type"
  | "agent-text"
  | "name"
  | "unknown";

export interface SemanticContext {
  /** 人类可读字段名 */
  label: string;
  /** 标签来源 */
  source: SemanticLabelSource;
  /** HTML input type / select / textarea */
  inputType?: string;
}

export interface SemanticSniffRaw {
  ariaLabel?: string | null;
  placeholder?: string | null;
  labelFor?: string | null;
  adjacentText?: string | null;
  inputType?: string | null;
  name?: string | null;
  agentText?: string | null;
}

function cleanLabel(value: unknown, max = 80): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 由已提取的属性按规格优先级组装 semanticContext（Node 侧） */
export function buildSemanticContextFromRaw(raw: SemanticSniffRaw): SemanticContext {
  const inputType = cleanLabel(raw.inputType, 32).toLowerCase() || undefined;

  const aria = cleanLabel(raw.ariaLabel);
  if (aria) {
    return { label: aria, source: "aria-label", inputType };
  }

  const placeholder = cleanLabel(raw.placeholder);
  if (placeholder) {
    return { label: placeholder, source: "placeholder", inputType };
  }

  const labelFor = cleanLabel(raw.labelFor);
  if (labelFor) {
    return { label: labelFor, source: "label-for", inputType };
  }

  const adjacent = cleanLabel(raw.adjacentText);
  if (adjacent) {
    return { label: adjacent, source: "adjacent-text", inputType };
  }

  const name = cleanLabel(raw.name);
  if (name) {
    return { label: name, source: "name", inputType };
  }

  const agentText = cleanLabel(raw.agentText);
  if (agentText) {
    return { label: agentText, source: "agent-text", inputType };
  }

  if (inputType) {
    return { label: inputType, source: "input-type", inputType };
  }

  return { label: "字段", source: "unknown", inputType };
}
/** inputType → JIT Prompt 格式铁律 */
export function formatConstraintForInputType(inputType: string | null | undefined): string {
  const type = String(inputType ?? "")
    .trim()
    .toLowerCase();
  switch (type) {
    case "email":
      return "你必须只输出一个合法邮箱地址，绝对禁止包含说明性文字、引号或 Markdown。";
    case "tel":
    case "phone":
      return "你必须只输出电话号码（可含国家区号与空格/短横线），绝对禁止包含说明性文字。";
    case "number":
    case "numeric":
      return "你必须只输出纯数字，绝对禁止包含说明性文字、单位或符号（小数点除外）。";
    case "url":
      return "你必须只输出一个 URL，绝对禁止包含说明性文字。";
    case "date":
      return "你必须只输出日期（优先 YYYY-MM-DD），绝对禁止包含说明性文字。";
    case "password":
      return "你必须只输出密码字符串本身，绝对禁止包含说明性文字。";
    case "checkbox":
    case "radio":
      return "你必须只输出 yes/no 或选项值，绝对禁止包含说明性文字。";
    default:
      return "你必须只输出最终填入值本身，绝对禁止包含说明性文字、引号或 Markdown。";
  }
}
