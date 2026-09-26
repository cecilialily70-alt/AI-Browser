/**
 * DOM 题干可靠性：内联图标会变成 textContent 里的 "> > >"，属 DOM 毒化
 */

/** 汉字 / 有意义英文目标词 */
const SUBSTANTIVE =
  /[\u4e00-\u9fff]|triangle|circle|star|icon|sphere|column|left|right/i;

/** 仅剩分隔符、括号、空白时视为毒化 */
const POISON_ONLY = /^[\s\[\]【】:：\-—>~＞→←↑↓•·|\\/0-9]*$/;

/**
 * DOM textContent 是否缺少实质目标（图标丢失只剩 > > >）
 */
export function isDomInstructionUnreliable(instruction: string): boolean {
  const t = String(instruction ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true;
  if (/请按顺序|请依次|请点击|依次按照/i.test(t) && !SUBSTANTIVE.test(t)) {
    return true;
  }
  const stripped = t
    .replace(/请按顺序点击|请依次按照顺序点击|请依次点击|请点击|依次点击/gi, "")
    .replace(/[\[\]【】:：]/g, "")
    .trim();
  if (!stripped) return true;
  if (POISON_ONLY.test(stripped)) return true;
  const hanCount = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const gtCount = (t.match(/[>＞]/g) || []).length;
  if (gtCount >= 2 && hanCount <= 2) return true;
  return false;
}

/**
 * 从题干抽出汉字点击顺序，如「---> 是时年有」→ ["是","时","年","有"]
 */
export function extractHanClickSequence(instruction: string): string[] {
  const t = String(instruction ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return [];

  const patterns = [
    /(?:--->|——>|→|➡|➜)\s*([一-龥]{2,12})/,
    /顺序点击[^一-龥]{0,24}([一-龥]{2,12})/,
    /依次(?:按照顺序)?点击[^一-龥]{0,24}([一-龥]{2,12})/,
    /请点击[^一-龥]{0,8}([一-龥]{2,12})\s*[】\]]?\s*$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1] && m[1].length >= 2) {
      return Array.from(m[1]);
    }
  }
  return [];
}

/** 仅当可靠时才允许作为弱提示；否则返回空（截图为真相） */
export function visionInstructionContext(instruction: string): {
  unreliable: boolean;
  hintForVision: string;
  logLabel: string;
  hanSequence: string[];
} {
  const raw = String(instruction ?? "").replace(/\s+/g, " ").trim();
  const hanSequence = extractHanClickSequence(raw);
  const unreliable = isDomInstructionUnreliable(raw);

  if (hanSequence.length >= 2) {
    return {
      unreliable: false,
      hintForVision: `必须按顺序点击这些汉字（共${hanSequence.length}个）：${hanSequence.join(" → ")}`,
      logLabel: `按序点字：${hanSequence.join("")}`,
      hanSequence,
    };
  }

  if (unreliable) {
    return {
      unreliable: true,
      hintForVision: "",
      logLabel: raw
        ? `题目文字乱了「${raw.slice(0, 28)}」，改看图认`
        : "页面上没读到清楚题目，改看图认",
      hanSequence: [],
    };
  }
  return {
    unreliable: false,
    hintForVision: `DOM 弱提示（仅供参考，以图为准）：${raw.slice(0, 80)}`,
    logLabel: raw.slice(0, 36),
    hanSequence: [],
  };
}
