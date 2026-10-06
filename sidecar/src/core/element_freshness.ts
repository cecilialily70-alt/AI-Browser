/**
 * 索引新鲜度校验（Stale Index Guard）
 *
 * 背景：模型只能引用 `<browser_state>` 里的 `[index]`，而 index ↔ 元素 的映射是**某一时刻**的快照。
 * 页面一旦变化（导航、弹层插入、列表重排、框架重渲染、上一步动作已改结构），旧 index 就可能：
 *   - 指向不存在的元素（点击静默失败）；
 *   - 指向**另一个**元素（点错，危险性最高：例如把「关闭」点成「提交」）。
 *
 * 这里在动作执行前做一次廉价校验：按记录的选择器/xpath 重新定位，比对「是否还在文档里 / 标签类型是否一致 / 文案是否漂移」。
 *   - 消失 或 标签类型改变 → **硬失败**，提示模型重新观察，绝不带病执行；
 *   - 仅文案漂移           → 放行但附告警（按钮文案本就可能随状态变化）。
 */
import { diceSimilarity, normalizeForSimilarity } from "./text_match.js";
import type { DomScope } from "./dom_scope.js";

export type FreshnessVerdict = "fresh" | "missing" | "tag-changed" | "text-drift";

export interface FreshnessReport {
  verdict: FreshnessVerdict;
  /** 当前实际标签（小写）；定位失败为空串 */
  actualTag: string;
  /** 当前实际可访问名/文本（截断） */
  actualText: string;
  /** 是否仍在文档中且已连接（未被框架卸载） */
  connected: boolean;
  /** 给模型看的一句话说明；fresh 时为空 */
  note: string;
}

const PROBE_ELEMENT_SCRIPT = (target: { selector: string; xpath: string }) => {
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
    return { found: false, tag: "", text: "", connected: false };
  }
  const htmlEl = el as HTMLElement;
  const text =
    (el.getAttribute("aria-label") || "").trim() ||
    (htmlEl.innerText || htmlEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) ||
    (htmlEl.getAttribute("placeholder") || "").trim();
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    text,
    connected: htmlEl.isConnected,
  };
};

/** 文本漂移容忍阈值：低于它才告警（按钮文案轻微变化属正常） */
const TEXT_DRIFT_THRESHOLD = 0.34;

export interface FreshnessExpectation {
  tagName?: string;
  text?: string;
  placeholder?: string;
  /** 语义标签（用于漂移比对，优先于 text） */
  semanticLabel?: string;
}

/**
 * 校验一个 index 是否仍然指向同一个元素（作用域可以是主文档或嵌套框架）。
 * 任何异常都软着陆为 `fresh`（校验本身不得成为新的失败源）。
 */
export async function checkElementFreshness(
  page: DomScope,
  target: { selector?: string; xpath?: string },
  expectation: FreshnessExpectation,
): Promise<FreshnessReport> {
  const selector = String(target.selector ?? "").trim();
  const xpath = String(target.xpath ?? "").trim();
  if (!selector && !xpath) {
    return { verdict: "fresh", actualTag: "", actualText: "", connected: false, note: "" };
  }

  let probed: { found: boolean; tag: string; text: string; connected: boolean };
  try {
    probed = (await page.evaluate(PROBE_ELEMENT_SCRIPT, { selector, xpath })) as typeof probed;
  } catch {
    return { verdict: "fresh", actualTag: "", actualText: "", connected: false, note: "" };
  }

  if (!probed?.found || !probed.connected) {
    return {
      verdict: "missing",
      actualTag: probed?.tag ?? "",
      actualText: probed?.text ?? "",
      connected: false,
      note: "该 index 指向的元素已不存在（页面已变化），索引已过期，请重新观察页面后按新 index 操作",
    };
  }

  const expectedTag = String(expectation.tagName ?? "").toLowerCase();
  const actualTag = String(probed.tag ?? "").toLowerCase();
  // iframe / canvas / img 等占位型索引不参与标签比对
  const tagComparable =
    expectedTag.length > 0 &&
    !["iframe", "canvas", "img", "unknown"].includes(expectedTag) &&
    !["iframe", "canvas", "img"].includes(actualTag);
  if (tagComparable && expectedTag !== actualTag) {
    return {
      verdict: "tag-changed",
      actualTag,
      actualText: probed.text,
      connected: true,
      note: `该 index 现在指向 <${actualTag}>，与观察时的 <${expectedTag}> 不同（DOM 已重排），索引已过期，请重新观察后再操作`,
    };
  }

  const expectedText = normalizeForSimilarity(
    expectation.semanticLabel || expectation.text || expectation.placeholder || "",
  );
  const actualText = normalizeForSimilarity(probed.text);
  // 表单字段的「文案」是标签而非元素内容（观察侧合成标签 vs DOM 占位符天然不同），不参与漂移比对
  const textComparable = !["input", "select", "textarea", "option"].includes(actualTag);
  if (textComparable && expectedText && actualText) {
    const similarity = diceSimilarity(expectedText, actualText);
    if (similarity < TEXT_DRIFT_THRESHOLD) {
      return {
        verdict: "text-drift",
        actualTag,
        actualText: probed.text,
        connected: true,
        note: `元素文案已变化（观察时「${expectation.semanticLabel || expectation.text}」，现在「${probed.text}」），已按当前状态继续`,
      };
    }
  }

  return { verdict: "fresh", actualTag, actualText: probed.text, connected: true, note: "" };
}
