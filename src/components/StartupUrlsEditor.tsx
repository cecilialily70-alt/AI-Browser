import { Plus, Trash2 } from "lucide-react";

/** 启动时强制首位打开的首页（不可删除） */
export const FORCED_STARTUP_HOMEPAGE = "https://www.browserscan.net/zh";

export function parseStartupUrlsJson(raw: string | null | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .filter(
        (url) =>
          url.replace(/\/$/, "").toLowerCase() !== FORCED_STARTUP_HOMEPAGE.replace(/\/$/, "").toLowerCase(),
      );
  } catch {
    return [];
  }
}

export function serializeStartupUrls(urls: string[]): string {
  const cleaned = urls
    .map((item) => item.trim())
    .filter(Boolean)
    .filter(
      (url) =>
        url.replace(/\/$/, "").toLowerCase() !== FORCED_STARTUP_HOMEPAGE.replace(/\/$/, "").toLowerCase(),
    );
  return JSON.stringify(cleaned);
}

interface StartupUrlsEditorProps {
  urls: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
}

/**
 * 启动自动开页编辑器：首位锁定 BrowserScan，可追加多个网站。
 */
export function StartupUrlsEditor({ urls, onChange, disabled }: StartupUrlsEditorProps) {
  const updateAt = (index: number, value: string) => {
    const next = [...urls];
    next[index] = value;
    onChange(next);
  };

  const removeAt = (index: number) => {
    onChange(urls.filter((_, i) => i !== index));
  };

  const addRow = () => {
    if (urls.length >= 20) {
      return;
    }
    onChange([...urls, ""]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="field-label mb-0">启动开页</span>
        <button
          type="button"
          className="btn btn-outline btn-compact h-7"
          disabled={disabled || urls.length >= 20}
          onClick={addRow}
        >
          <Plus size={12} />
          添加网址
        </button>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">第 1 页固定为检测页；其余按下方顺序打开</p>
      <div className="space-y-1.5 rounded-md bg-surface-muted p-2.5">
        <div className="flex items-center gap-2">
          <span className="w-6 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">1</span>
          <input
            className="field-input font-mono text-caption"
            value={FORCED_STARTUP_HOMEPAGE}
            readOnly
            disabled
            title="强制首页，不可修改"
          />
          <span className="badge shrink-0">锁定</span>
        </div>
        {urls.map((url, index) => (
          <div key={`startup-extra-${index}`} className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
              {index + 2}
            </span>
            <input
              className="field-input font-mono text-caption"
              value={url}
              disabled={disabled}
              placeholder="https://example.com"
              onChange={(event) => updateAt(index, event.target.value)}
            />
            <button
              type="button"
              className="btn-icon-danger shrink-0"
              disabled={disabled}
              title="移除"
              aria-label="移除网站"
              onClick={() => removeAt(index)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
