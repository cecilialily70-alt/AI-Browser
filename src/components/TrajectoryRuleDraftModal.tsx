import { useEffect, useMemo, useState } from "react";

import {
  RULE_KIND_OPTIONS,
  RULE_ROLE_OPTIONS,
  type AgentRule,
} from "../lib/agentRules";
import { Modal } from "./Modal";

function roleLabel(role: AgentRule["role"]): string {
  return RULE_ROLE_OPTIONS.find((item) => item.value === role)?.label ?? role;
}

function kindLabel(kind: AgentRule["kind"]): string {
  return RULE_KIND_OPTIONS.find((item) => item.value === kind)?.label ?? kind;
}

export interface TrajectoryRuleDraftModalProps {
  open: boolean;
  trajectoryTitle?: string;
  drafts: AgentRule[];
  saving?: boolean;
  onClose: () => void;
  onSave: (selected: AgentRule[]) => void | Promise<void>;
}

export function TrajectoryRuleDraftModal({
  open,
  trajectoryTitle,
  drafts,
  saving = false,
  onClose,
  onSave,
}: TrajectoryRuleDraftModalProps) {
  const draftIds = useMemo(() => drafts.map((item) => item.id), [drafts]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(draftIds));

  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(draftIds));
    }
  }, [open, draftIds]);

  const toggle = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedCount = drafts.filter((item) => selectedIds.has(item.id)).length;

  return (
    <Modal
      open={open}
      title="从轨迹生成规则草稿"
      description={
        trajectoryTitle
          ? `「${trajectoryTitle}」：勾选要写入规则库的条目，取消则不会改动现有规则。`
          : "勾选要写入规则库的条目，取消则不会改动现有规则。"
      }
      onClose={() => {
        if (!saving) {
          onClose();
        }
      }}
      widthClass="max-w-lg"
    >
      <div className="space-y-3">
        {drafts.length === 0 ? (
          <p className="text-[11px] leading-5 text-muted-foreground">
            未能从该轨迹提取可保存的规则草稿（可能步骤过少或命中敏感字段过滤）。
          </p>
        ) : (
          <ul className="max-h-[320px] space-y-2 overflow-y-auto rounded-md border border-border bg-sunken p-2">
            {drafts.map((draft) => {
              const checked = selectedIds.has(draft.id);
              return (
                <li key={draft.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/60">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={checked}
                      disabled={saving}
                      onChange={() => toggle(draft.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] font-medium text-foreground">{draft.title}</span>
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        {roleLabel(draft.role)} · {kindLabel(draft.kind)}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn-outline px-4" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary px-4"
            disabled={saving || selectedCount === 0}
            onClick={() => {
              const selected = drafts.filter((item) => selectedIds.has(item.id));
              void onSave(selected);
            }}
          >
            {saving ? "保存中…" : `保存 ${selectedCount} 条到规则库`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
