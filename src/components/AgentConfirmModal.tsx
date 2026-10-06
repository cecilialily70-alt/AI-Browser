import { Modal } from "./Modal";
import type { HitlAiCopy } from "../lib/hitlAiCopy";

export interface AgentConfirmActionRow {
  kind: "fill" | "click" | string;
  id: string;
  text: string;
  value?: string;
}

interface AgentConfirmModalProps {
  open: boolean;
  loading: boolean;
  url: string;
  reason?: string;
  aiCopy?: HitlAiCopy | null;
  actions: AgentConfirmActionRow[];
  fillValues: Record<string, string>;
  onFillValueChange: (id: string, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AgentConfirmModal({
  open,
  loading,
  url,
  reason,
  aiCopy,
  actions,
  fillValues,
  onFillValueChange,
  onConfirm,
  onCancel,
}: AgentConfirmModalProps) {
  const fillCount = actions.filter((action) => action.kind === "fill").length;
  const fallbackTitle =
    fillCount >= 2 ? `人工确认 · 批量填表（${fillCount} 个字段）` : "人工确认 · Agent 拟执行动作";
  const title = aiCopy?.title?.trim() || fallbackTitle;
  const description =
    aiCopy?.body?.trim() ||
    (fillCount >= 2
      ? "请一次性核对并修改所有字段，确认后整批写入浏览器（不会再逐个弹窗）。"
      : "确认无误后再写入浏览器；可修改填写值。取消将回传给 Agent。");
  const confirmLabel = aiCopy?.primaryButton?.trim() || "确认并执行";
  return (
    <Modal open={open} title={title} description={description} onClose={onCancel} widthClass="max-w-2xl">
      <div className="space-y-3">
        {url ? (
          <p className="truncate font-mono text-[10px] text-muted-foreground" title={url}>
            {url}
          </p>
        ) : null}
        {reason && aiCopy ? <p className="text-caption text-muted-foreground">技术意图 · {reason}</p> : null}
        {reason && !aiCopy ? <p className="text-ui text-foreground">{reason}</p> : null}

        <div className="max-h-[360px] space-y-2 overflow-y-auto rounded-lg bg-surface-muted p-2">
          {actions.map((action) => (
            <div key={`${action.kind}-${action.id}`} className="rounded-md bg-card px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
                <span>
                  {action.kind === "click" ? "点击" : "填写"} · {action.id}
                </span>
                <span className="truncate font-medium text-foreground">{action.text}</span>
              </div>
              {action.kind === "fill" ? (
                <input
                  className="field-input mt-1.5 w-full font-mono text-caption"
                  value={fillValues[action.id] ?? action.value ?? ""}
                  onChange={(event) => onFillValueChange(action.id, event.target.value)}
                  disabled={loading}
                />
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn-outline px-4" onClick={onCancel} disabled={loading}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary px-4"
            onClick={onConfirm}
            disabled={loading || actions.length === 0}
          >
            {loading ? "提交中…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
