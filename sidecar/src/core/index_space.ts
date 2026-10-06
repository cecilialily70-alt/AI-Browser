/**
 * 索引空间（Index Space）—— 「模型看到的 [index]」的唯一定义处。
 *
 * 为什么单独成模块：控件索引是 Agent 与世界之间的**唯一寻址方式**，
 * 但它此前只在 `browser_state` 的循环里隐式定义（按 llm_json 顺序从 1 编号，
 * element_map 里查不到的跳过）。任何需要「换一套观察结果、却必须沿用同一编号约定」
 * 的地方（例如视觉重定位后刷新索引空间）一旦自己重写一遍编号，
 * 就会出现「回执里的新编号」和「模型手里的编号」错位的隐蔽事故。
 * 因此编号规则只允许有一份实现。
 */
import type { AgentElementRef, AgentLlmElement } from "../interactive_elements.js";

export interface IndexedElement {
  /** 模型看到的 [index]（1 起；与 SoM 截图上的编号同源） */
  index: number;
  /** 抽取层的短 id（如 "e7" 或 "7"） */
  shortId: string;
  llm: AgentLlmElement;
  ref: AgentElementRef;
}

export interface IndexSource {
  llm_json: AgentLlmElement[];
  element_map: Map<string, AgentElementRef>;
}

/**
 * 把一份抽取结果编号进模型索引空间。
 * 规则：按 llm_json 顺序从 1 起递增；element_map 里没有对应 ref 的元素**不占号**（与 browser_state 一致）。
 */
export function indexElements(source: IndexSource): Map<number, IndexedElement> {
  const out = new Map<number, IndexedElement>();
  let index = 1;
  for (const llm of source.llm_json) {
    const ref = source.element_map.get(llm.id);
    if (!ref) continue;
    out.set(index, { index, shortId: llm.id, llm, ref });
    index += 1;
  }
  return out;
}

/**
 * 索引空间的紧凑清单（视觉重定位的候选集）。
 * 候选必须来自「真正画进 SoM 截图的编号」——由 `vision_relocate` 依据标注结果构造。
 */
export interface IndexedElementBrief {
  index: number;
  label: string;
}
