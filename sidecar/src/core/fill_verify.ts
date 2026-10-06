/**
 * 填写结果验证（Fill Verify）
 *
 * 为什么需要：Agent 的 `input` 工具此前只要 Playwright 不抛错就回报「已输入」，
 * 于是模型拿到假成功、反复重填、或以空框状态去提交。这里补上「回读真值」这一环：
 *
 *   填写前读一次 → 按语义推算期望值（clear=覆盖 / append=追加）→ 填写后回读比对
 *   - 期望非空但实际为空  → **硬失败**（正是用户报障的那个场景：工具说成功、框还是空的）
 *   - 非空但不完全一致    → **软告警**（站点可能做格式化/截断/联想重写，不能一律判死）
 *
 * 回读覆盖 input / textarea / contenteditable / select，且不依赖任何站点选择器。
 */
import type { DomScope } from "./dom_scope.js";

export interface FieldSnapshot {
  found: boolean;
  tag: string;
  /** input 的 type；非 input 为 null */
  type: string | null;
  role: string;
  value: string;
  /** contenteditable 元素的文本内容 */
  isContentEditable: boolean;
  /** 只读/禁用字段：填写不会生效，值得单独提示 */
  readOnly: boolean;
  disabled: boolean;
  /** combobox / 联想输入：站点可能在输入后重写文本，比对失败仅告警 */
  autocomplete: boolean;
  maxLength: number | null;
  /** 该字段是否由框架托管（React/Vue 受控输入） */
  frameworkManaged: boolean;
}

export type FillVerdict = "ok" | "empty" | "mismatch" | "unknown";

export interface FillVerification {
  verdict: FillVerdict;
  /** 期望值（按 append/clear 语义推算） */
  expected: string;
  /** 回读到的实际值 */
  actual: string;
  /** 填写前的原值 */
  before: string;
  field: FieldSnapshot | null;
  note: string;
}

const READ_FIELD_SCRIPT = (target: { selector: string; xpath: string }) => {
  const resolve = (): Element | null => {
    let sel = target.selector;
    let xp = target.xpath;
    if (sel.startsWith("/") || sel.startsWith("(") || sel.startsWith("./")) {
      xp = xp || sel;
      sel = "";
    }
    if (sel) {
      try {
        const hit = document.querySelector(sel);
        if (hit) return hit;
      } catch {
        /* 非法 CSS → 退 xpath */
      }
    }
    if (xp) {
      try {
        const r = document.evaluate(
          xp,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        if (r.singleNodeValue instanceof Element) return r.singleNodeValue;
      } catch {
        /* ignore */
      }
    }
    return null;
  };

  const el = resolve();
  if (!el) {
    return {
      found: false,
      tag: "",
      type: null,
      role: "",
      value: "",
      isContentEditable: false,
      readOnly: false,
      disabled: false,
      autocomplete: false,
      maxLength: null,
      frameworkManaged: false,
    };
  }

  const htmlEl = el as HTMLElement;
  let value = "";
  let type: string | null = null;
  let readOnly = false;
  let disabled = false;
  let maxLength: number | null = null;
  const isContentEditable = htmlEl.isContentEditable;
  const role = (el.getAttribute("role") || "").toLowerCase();
  const autocomplete = role === "combobox" || el.getAttribute("aria-autocomplete") != null;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    value = el.value;
    readOnly = el.readOnly;
    disabled = el.disabled;
    maxLength = el.maxLength >= 0 ? el.maxLength : null;
    if (el instanceof HTMLInputElement) type = el.type || "text";
  } else if (el instanceof HTMLSelectElement) {
    value = el.value;
    disabled = el.disabled;
    type = "select";
  } else if (isContentEditable) {
    value = htmlEl.innerText || htmlEl.textContent || "";
  } else {
    const inner = el.querySelector("input,textarea,select");
    if (inner instanceof HTMLInputElement || inner instanceof HTMLTextAreaElement) {
      value = inner.value;
      readOnly = inner.readOnly;
      disabled = inner.disabled;
      maxLength = inner.maxLength >= 0 ? inner.maxLength : null;
      if (inner instanceof HTMLInputElement) type = inner.type || "text";
    }
  }

  // 受控输入识别：框架会在 value 上装 accessor（React 的 valueTracker 类做法）
  let frameworkManaged = false;
  try {
    const proto =
      el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : null;
    if (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      frameworkManaged = Boolean(descriptor && typeof descriptor.set === "function");
    }
  } catch {
    frameworkManaged = false;
  }

  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    type,
    role,
    value,
    isContentEditable,
    readOnly,
    disabled,
    autocomplete,
    maxLength,
    frameworkManaged,
  };
};

/** 读取字段当前真值；任何异常都软着陆为 null。作用域可以是主文档或嵌套框架 */
export async function readFieldSnapshot(
  page: DomScope,
  target: { selector?: string; xpath?: string },
): Promise<FieldSnapshot | null> {
  const selector = String(target.selector ?? "").trim();
  const xpath = String(target.xpath ?? "").trim();
  if (!selector && !xpath) return null;
  try {
    return (await page.evaluate(READ_FIELD_SCRIPT, { selector, xpath })) as FieldSnapshot;
  } catch {
    return null;
  }
}

/** 归一化比对：容忍空白差异与站点自动格式化（空格/全角空格/零宽字符） */
export function normalizeForCompare(value: string): string {
  return String(value ?? "")
    .replace(/[\s\u3000\u200b]+/g, "")
    .trim();
}

/**
 * 字段值归一化（幂等判定 / 回读比对共用同一把尺子）。
 * 单独导出是为了让「写入前幂等跳过」与「写入后回读」判断一致 ——
 * 两处用不同尺子会出现「跳过判定说一样、回读判定说不一样」的自相矛盾。
 */
export const normalizeFieldValue = normalizeForCompare;

/** 按 append / clear 语义推算期望值 */
export function expectedFillValue(before: string, text: string, append: boolean): string {
  if (!append) return text;
  return `${before ?? ""}${text}`;
}

export interface VerifyFillOptions {
  /** 填写前的快照（用于推算 append 期望值）；未提供则视为空 */
  before?: FieldSnapshot | null;
  /** 追加模式 */
  append: boolean;
  /** 期望写入的文本 */
  text: string;
}

/**
 * 填写结果验证。
 * 语义：`empty` 是硬错误（假成功），`mismatch` 只告警（站点可能改写/截断）。
 */
export function verifyFill(
  after: FieldSnapshot | null,
  options: VerifyFillOptions,
): FillVerification {
  const before = options.before?.value ?? "";
  const actual = after?.value ?? "";
  const expected = expectedFillValue(before, options.text, options.append);

  if (!after || !after.found) {
    return {
      verdict: "unknown",
      expected,
      actual,
      before,
      field: after,
      note: "字段回读失败（元素可能已被页面卸载或替换），无法确认写入结果",
    };
  }

  const expectNorm = normalizeForCompare(expected);
  const actualNorm = normalizeForCompare(actual);

  if (after.readOnly || after.disabled) {
    return {
      verdict: "mismatch",
      expected,
      actual,
      before,
      field: after,
      note: `字段为${after.readOnly ? "只读" : "禁用"}状态，写入不会生效`,
    };
  }

  // 期望有内容、实际为空 → 假成功（用户报障的正是这种情况）
  if (expectNorm.length > 0 && actualNorm.length === 0) {
    return {
      verdict: "empty",
      expected,
      actual,
      before,
      field: after,
      note: after.frameworkManaged
        ? "写入未生效（框架托管输入可能忽略普通 fill，可改试用键盘逐字输入后再点开下拉）"
        : "写入未生效（受控组件、焦点被弹层吞掉、或该字段并非真正可编辑都可能如此）",
    };
  }

  if (expectNorm === actualNorm) {
    return { verdict: "ok", expected, actual, before, field: after, note: "" };
  }

  if (after.autocomplete) {
    return {
      verdict: "ok",
      expected,
      actual,
      before,
      field: after,
      note: "联想输入字段，站点可能重写文本",
    };
  }

  if (after.maxLength != null && actual.length >= after.maxLength) {
    return {
      verdict: "mismatch",
      expected,
      actual,
      before,
      field: after,
      note: `文本被 maxlength=${after.maxLength} 截断`,
    };
  }

  return {
    verdict: "mismatch",
    expected,
    actual,
    before,
    field: after,
    note: `与期望「${trimForNote(expected)}」不一致`,
  };
}

function trimForNote(value: string): string {
  const text = String(value ?? "");
  const masked = maskSensitive(text);
  return masked.length > 40 ? `${masked.slice(0, 40)}…` : masked;
}

/**
 * 「写到一半被清掉」判定：站点在输入过程中清空/替换了字段，剩下的字符只是期望值的**尾部**。
 *
 * 为什么必须单独识别：这类结果此前只算 mismatch（软告警，站点格式化也是 mismatch），
 * 于是「实际值 = 期望值的后缀」这种**明确的数据丢失**会被当成正常写入放行 ——
 * 用户看到的就是「输入框被清空后又打了一段」，而模型以为自己已经填对了。
 * 判据只用「后缀关系」这一条结构事实，不引入任何站点文案。
 */
export function isTruncatedTailLoss(expected: string, actual: string): boolean {
  const e = normalizeForCompare(expected);
  const a = normalizeForCompare(actual);
  if (!e || !a) return false;
  if (a.length >= e.length) return false;
  return e.endsWith(a);
}

/**
 * 日志/回灌文本里的敏感值脱敏：密码类字段只报长度。
 * 注意：模型需要看到「填了没有」，但不需要看到明文密码。
 */
export function maskSensitive(value: string, type?: string | null): string {
  const text = String(value ?? "");
  if (!text) return "";
  const sensitive = /password|passwd|pwd|otp|totp|card|cvv|cvc|secret|token/i.test(String(type ?? ""));
  if (!sensitive) return text;
  return `•••（${text.length} 字符）`;
}

/** 生成给模型看的一句话结论（含真实回读值，密码类脱敏） */
export function describeFillVerification(
  verification: FillVerification,
  type?: string | null,
): string {
  const actual = maskSensitive(verification.actual, type);
  if (verification.verdict === "ok") {
    return verification.note ? `${actual}（${verification.note}）` : actual;
  }
  if (verification.verdict === "empty") {
    return `字段仍为空 — ${verification.note}`;
  }
  if (verification.verdict === "mismatch") {
    return `实际「${actual}」 — ${verification.note}`;
  }
  return verification.note;
}
