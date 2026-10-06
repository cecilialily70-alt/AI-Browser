/**
 * 文本匹配原语（Node 侧共享）
 *
 * 供风险词典、索引新鲜度、完成度证据等模块复用，避免各写一份相似度/词条匹配逻辑。
 *
 * 关于拉丁词条的词边界：`send` 不应命中 `sender`、`pay` 不应命中 `paypal-free`，
 * 但 CJK 没有词边界，必须用子串匹配 —— 这里按词条字符集自动选择策略。
 */

/** 归一化：折叠空白、去零宽字符、转小写（词典与页面文本共用同一套归一化） */
export function normalizeHaystack(value: string): string {
  return String(value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\s\u3000]+/g, " ")
    .trim()
    .toLowerCase();
}

/** 用于相似度比对：进一步去掉所有空白与常见标点，避免排版差异影响判定 */
export function normalizeForSimilarity(value: string): string {
  return normalizeHaystack(value)
    .replace(/[，。、；：！？,.;:!?"'`()[\]{}<>《》「」『』|~^*]/g, "")
    .slice(0, 80);
}

/** 单个词条是否命中 */
export function termHit(haystack: string, term: string): boolean {
  if (!haystack || !term) return false;
  const isWordLike = /^[a-z0-9][a-z0-9 ._/-]*$/.test(term);
  if (!isWordLike) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/** 返回第一个命中的词条（便于日志解释「为什么」） */
export function firstHit(haystack: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    if (termHit(haystack, term)) return term;
  }
  return null;
}

/** 收集全部命中词条（用于证据说明） */
export function allHits(haystack: string, terms: readonly string[], limit = 5): string[] {
  const out: string[] = [];
  for (const term of terms) {
    if (out.length >= limit) break;
    if (termHit(haystack, term)) out.push(term);
  }
  return out;
}

/** 二元组 Dice 相似度：语言无关，无需任何词典 */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, count] of ga) {
    const other = gb.get(g);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}
