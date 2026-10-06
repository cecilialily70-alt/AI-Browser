import type { GoalMentions } from "../lib/agentRules";
import { describeGoalMentions } from "../lib/agentRules";

/**
 * 启动前「这次 @ 会生效什么」。没有 @ 不渲染（默认不套规则）。
 */
export function GoalMentionPreview({
  mentions,
  emptyHint,
}: {
  mentions: GoalMentions;
  emptyHint?: string;
}) {
  const hasAt =
    mentions.rules.length > 0 ||
    Boolean(mentions.persona) ||
    (mentions.packs?.length ?? 0) > 0 ||
    mentions.unknown.length > 0 ||
    mentions.ambiguities.length > 0 ||
    (mentions.packWarnings?.length ?? 0) > 0;
  const { summary, warnings } = describeGoalMentions(mentions);
  if (!hasAt) {
    return emptyHint ? (
      <p className="text-[10px] leading-4 text-muted-foreground">{emptyHint}</p>
    ) : null;
  }
  return (
    <div className="space-y-1">
      {summary ? (
        <p className="text-[11px] leading-4 text-foreground">
          <span className="context-badge">本次 @ 生效</span> {summary}
        </p>
      ) : null}
      {warnings.map((warning) => (
        <p key={warning} className="text-[10px] leading-4 text-warning">
          {warning}
        </p>
      ))}
    </div>
  );
}
