/**
 * P4.4 — Agent 控制台 Tab 感知：把 listTabs 快照压成可 IPC 的轻量结构。
 * 只读展示用；切标签仍由 Agent 的 switch 动作完成，禁止把站点选择器写进此处。
 */

export interface OpenTabSnapshot {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface OpenTabsReportInput {
  tabs: Array<{
    id?: string;
    url?: string;
    title?: string;
    active?: boolean;
  }>;
  profileId?: string;
  step?: number;
}

const DEFAULT_MAX_TABS = 24;
const DEFAULT_MAX_URL = 180;
const DEFAULT_MAX_TITLE = 64;

function truncate(raw: string, max: number): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 规范化标签列表：去空 id、裁切字数、上限条数；active 至多标一个（优先已标者）。 */
export function sanitizeOpenTabs(
  tabs: OpenTabsReportInput["tabs"],
  opts?: { maxTabs?: number; maxUrl?: number; maxTitle?: number },
): OpenTabSnapshot[] {
  const maxTabs = opts?.maxTabs ?? DEFAULT_MAX_TABS;
  const maxUrl = opts?.maxUrl ?? DEFAULT_MAX_URL;
  const maxTitle = opts?.maxTitle ?? DEFAULT_MAX_TITLE;
  const out: OpenTabSnapshot[] = [];
  let activeSeen = false;
  for (const raw of tabs ?? []) {
    if (out.length >= maxTabs) break;
    const id = String(raw?.id ?? "").trim();
    if (!id) continue;
    let active = raw?.active === true;
    if (active && activeSeen) active = false;
    if (active) activeSeen = true;
    out.push({
      id,
      url: truncate(String(raw?.url ?? ""), maxUrl),
      title: truncate(String(raw?.title ?? ""), maxTitle),
      active,
    });
  }
  if (!activeSeen && out.length > 0) {
    out[0]!.active = true;
  }
  return out;
}

/** 供 JsonLogger.openTabs / 回归断言的 stdout payload（不含 type/ts，由 logger 补）。 */
export function buildOpenTabsPayload(input: OpenTabsReportInput): {
  phase: "open_tabs";
  tabs: OpenTabSnapshot[];
  profileId?: string;
  step?: number;
} {
  const tabs = sanitizeOpenTabs(input.tabs);
  const profileId =
    typeof input.profileId === "string" && input.profileId.trim()
      ? input.profileId.trim()
      : undefined;
  const step =
    typeof input.step === "number" && Number.isFinite(input.step)
      ? Math.max(0, Math.floor(input.step))
      : undefined;
  return {
    phase: "open_tabs",
    tabs,
    ...(profileId ? { profileId } : {}),
    ...(step !== undefined ? { step } : {}),
  };
}

export function formatOpenTabsHint(tabCount: number): string {
  if (tabCount <= 1) {
    return "控件索引仅属于当前页；新标签出现后由 Agent 使用 switch(tab_id) 切换。";
  }
  return `共 ${tabCount} 个标签（只读）。切换由 Agent 执行 switch(tab_id)；此处可「切到环境前台」查看浏览器。`;
}
