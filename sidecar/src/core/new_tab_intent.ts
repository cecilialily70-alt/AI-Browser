/**
 * 「在新标签中操作」任务级意图 —— 词表驱动，零站点文案。
 *
 * 与 `task_intent.ts` 的 search/navigate 同源：词表来自 `config/task_intent_lexicon.json` 的
 * `intents.newTab`，匹配语义复用 `core/text_match.ts`（CJK 子串 / 拉丁词边界）。
 *
 * 判定层级（自上而下，见 执行计划.md §3.2）：
 *   1. 显式参数（`navigate(new_tab=true)` / 回放 `openInNewTab` / 外部 API `options.openInNewTab`）——最高；
 *   2. 目标文本命中词表；
 *   3. 缺省：Agent 保持现状（不强制新标签）；回放 = 新标签（由回放侧显式传参）。
 *
 * 歧义保护（执行计划.md §3.4）：「新标签」也可能是「把这条数据标个新标签」。因此
 * **只有命中词全部落在泛词内、且目标同时出现「点击 / 选择 / 保存 / 分类」类动作词时**，
 * 才判为疑似误命中、**不启用**新标签意图（保守），并写明原因。
 * 命中强短语（如「在新标签中打开」）时不受该保守规则影响 —— 那正是真实的新标签诉求。
 */
import {
  loadTaskIntentLexicon,
  newTabAmbiguityTerms,
  newTabGenericTerms,
  newTabTerms,
  goalRequestsNewTab,
  type TaskIntentLexicon,
} from "./task_intent.js";
import { allHits } from "./text_match.js";

export interface NewTabIntentResult {
  /** 是否应当「新开标签并把活动页绑定到它」 */
  enabled: boolean;
  /** 命中的词条（便于日志解释「为什么这样判」） */
  matched: string | null;
  /** 机器可读原因：explicit | goal_hit | ambiguity_skipped | none */
  reason: "explicit" | "goal_hit" | "ambiguity_skipped" | "none";
}

export interface DetectNewTabOptions {
  /**
   * 显式参数（优先级 1）。`true`/`false` 直接定论；`null`/`undefined` 表示未指定，
   * 回落到目标文本词表判定。
   */
  explicit?: boolean | null;
  lexicon?: TaskIntentLexicon | null;
}

/** 目标级判定：是否要求「在新标签中操作」。 */
export function detectNewTabIntent(goal: string, options: DetectNewTabOptions = {}): NewTabIntentResult {
  if (options.explicit === true) return { enabled: true, matched: null, reason: "explicit" };
  if (options.explicit === false) return { enabled: false, matched: null, reason: "explicit" };

  const lexicon = options.lexicon ?? loadTaskIntentLexicon();
  const hit = goalRequestsNewTab(goal, lexicon);
  if (!hit.requested || !hit.matched) return { enabled: false, matched: null, reason: "none" };

  // 歧义保护：命中词全是泛词，且目标含「打标签」类动作词 → 疑似误命中。
  const allHitsList = allHits(goal, newTabTerms(lexicon), 8);
  const generic = new Set(newTabGenericTerms(lexicon));
  const hits = allHitsList.length > 0 ? allHitsList : [hit.matched];
  const onlyGeneric = hits.every((term) => generic.has(term));
  if (onlyGeneric) {
    const ambiguityHit = allHits(goal, newTabAmbiguityTerms(lexicon), 1)[0] ?? null;
    if (ambiguityHit) {
      return { enabled: false, matched: hit.matched, reason: "ambiguity_skipped" };
    }
  }

  return { enabled: true, matched: hit.matched, reason: "goal_hit" };
}

/** 一句话解释（仅用于日志；不含站点文案） */
export function describeNewTabIntent(result: NewTabIntentResult): string {
  switch (result.reason) {
    case "explicit":
      return "显式参数要求在新标签中操作";
    case "goal_hit":
      return `目标命中新标签词条「${result.matched ?? ""}」→ 新开标签并绑定活动页`;
    case "ambiguity_skipped":
      return `疑似误命中（泛词「${result.matched ?? ""}」+ 打标签类动作词），不启用新标签`;
    default:
      return "目标未要求新标签";
  }
}
