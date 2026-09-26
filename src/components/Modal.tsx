import { X } from "lucide-react";
import type { PointerEvent, ReactNode } from "react";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
  layer?: "normal" | "elevated";
  /** 标题左侧的图标/徽标位（可选，用于强化窗口身份） */
  badge?: ReactNode;
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  widthClass = "max-w-lg",
  layer = "normal",
  badge,
}: ModalProps) {
  if (!open) {
    return null;
  }

  const overlayClass = layer === "elevated" ? "modal-overlay modal-overlay-elevated" : "modal-overlay";

  const handleOverlayPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  };

  const handlePanelPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleCloseClick = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div className={overlayClass} onPointerDown={handleOverlayPointerDown}>
      <div
        className={`modal-panel ${widthClass} animate-fade-in-up`}
        onPointerDown={handlePanelPointerDown}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-3.5">
          <div className="flex min-w-0 items-start gap-2.5">
            {badge ? <span className="mt-0.5 shrink-0 text-primary">{badge}</span> : null}
            <div className="min-w-0">
              <h2 className="text-ui-lg font-semibold tracking-tight text-foreground">{title}</h2>
              {description ? <p className="mt-1 text-caption text-muted-foreground">{description}</p> : null}
            </div>
          </div>
          <button
            type="button"
            className="icon-button shrink-0"
            onPointerDown={handleCloseClick}
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
