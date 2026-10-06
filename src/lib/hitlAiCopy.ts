/** P1.4：HITL 情境文案（Sidecar 生成，Host 透传） */
export interface HitlAiCopy {
  title: string;
  body: string;
  primaryButton: string;
  source?: "llm" | "template" | string;
  actionType?: string;
}

export function normalizeHitlAiCopy(raw: unknown): HitlAiCopy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const title = String(o.title ?? "").trim();
  const body = String(o.body ?? "").trim();
  const primaryButton = String(o.primaryButton ?? o.primary_button ?? "").trim();
  if (!title || !body || !primaryButton) return undefined;
  return {
    title,
    body,
    primaryButton,
    source: typeof o.source === "string" ? o.source : undefined,
    actionType: typeof o.actionType === "string" ? o.actionType : undefined,
  };
}
