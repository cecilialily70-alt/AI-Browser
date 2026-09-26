import { Modal } from "./Modal";

interface FillConfirmModalProps {
  open: boolean;
  loading: boolean;
  previewJson: string;
  onPreviewJsonChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function FillConfirmModal({
  open,
  loading,
  previewJson,
  onPreviewJsonChange,
  onConfirm,
  onClose,
}: FillConfirmModalProps) {
  return (
    <Modal
      open={open}
      title="人工确认 · 填表数据预览"
      description="确认无误后再写入浏览器；可直接编辑下方 JSON。"
      onClose={onClose}
      widthClass="max-w-2xl"
    >
      <div className="space-y-4">
        <textarea
          className="field-input min-h-[280px] w-full resize-y px-3 py-2 font-mono text-caption leading-5"
          value={previewJson}
          onChange={(event) => onPreviewJsonChange(event.target.value)}
          disabled={loading}
          spellCheck={false}
        />
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn-outline px-4" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary px-4"
            onClick={onConfirm}
            disabled={loading || !previewJson.trim()}
          >
            {loading ? "提交中…" : "确认并开始填表"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
