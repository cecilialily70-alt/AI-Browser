import { ExternalLink, Layers } from "lucide-react";
import { useState } from "react";

import { bringProfileToFront, formatInvokeError } from "../lib/tauri";

export interface AgentOpenTabItem {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

interface AgentOpenTabsBarProps {
  profileId: string | null;
  tabs: AgentOpenTabItem[];
  /** Agent 正在跑时展示；无 tabs 时也可显示空态提示 */
  visible: boolean;
  onError?: (message: string) => void;
}

function displayLabel(tab: AgentOpenTabItem): string {
  const title = tab.title.trim();
  if (title) return title;
  const url = tab.url.trim();
  if (!url) return `(标签 ${tab.id})`;
  try {
    const host = new URL(url).hostname;
    return host || url;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * P4.4：Agent 控制台 Open Tabs 只读条。
 * 不提供切标签（由 Agent switch）；提供「切到环境前台」。
 */
export function AgentOpenTabsBar({ profileId, tabs, visible, onError }: AgentOpenTabsBarProps) {
  const [bringing, setBringing] = useState(false);

  if (!visible) {
    return null;
  }

  const handleBringFront = async () => {
    if (!profileId || bringing) return;
    setBringing(true);
    try {
      await bringProfileToFront(profileId);
    } catch (error) {
      onError?.(formatInvokeError(error));
    } finally {
      setBringing(false);
    }
  };

  return (
    <div className="shrink-0 rounded-lg bg-sunken px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <Layers size={11} className="shrink-0" />
          <span className="truncate">Tabs{tabs.length > 0 ? ` ${tabs.length}` : ""}</span>
        </div>
        <button
          type="button"
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-secondary px-1.5 text-[10px] font-medium text-foreground transition-colors hover:bg-secondary/70 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!profileId || bringing}
          title="唤起该环境浏览器窗口到前台"
          onClick={() => void handleBringFront()}
        >
          <ExternalLink size={10} />
          {bringing ? "唤起中" : "切到前台"}
        </button>
      </div>

      {tabs.length === 0 ? (
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">等待 Agent 上报标签页…</p>
      ) : (
        <ul className="mt-1 flex max-h-20 flex-col gap-0.5 overflow-y-auto">
          {tabs.map((tab) => (
            <li
              key={tab.id}
              className={`flex items-start gap-1.5 rounded px-1 py-0.5 text-[10px] leading-4 ${
                tab.active ? "bg-primary/15 text-primary-text" : "text-muted-foreground"
              }`}
              title={tab.url || tab.title || tab.id}
            >
              <span className="shrink-0 font-mono opacity-80">{tab.id}</span>
              {tab.active ? (
                <span className="shrink-0 rounded bg-primary/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary-text">
                  active
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{displayLabel(tab)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
