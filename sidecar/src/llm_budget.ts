/**
 * LLM token budget helpers — shared truncation / compact JSON / thought strip.
 */

export type AgentSenseMode = "economy" | "balanced" | "classic";

export const AGENT_LLM_JSON_CAP: Record<AgentSenseMode, number> = {
  economy: 48,
  balanced: 64,
  classic: 80,
};

export const PLANNER_MAX_FILE_CHARS = 20_000;
export const AUTO_SELECTOR_HTML_DEFAULT = 12_000;
export const AUTO_SELECTOR_HTML_MAX = 20_000;
export const CHAT_FILLABLE_CAP = 40;
export const FILL_MAP_MAX_TOKENS = 2048;
export const SELECTOR_INFER_MAX_TOKENS = 1200;

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
