/**
 * 聊天/Agent 输入框共用的附件能力（Ai Chat 与浏览器 Agent 同一套）。
 *
 * 抽出的原因（§9 DRY）：附件选择、体积/类型校验、粘贴、附件条 UI 原本只长在 AIChatPanel 里，
 * Agent 输入框要同样的能力；两处各写一份必然漂移。
 *
 * 红线：附件图片只用于 vision/摘要，**禁止**当短信/邮箱 OTP 取码依据（B7 / R2）。
 */
import { X } from "lucide-react";
import { useRef, type ChangeEvent, type ClipboardEvent } from "react";

import type { ChatAttachmentPayload } from "../types";

export const MAX_ATTACHMENTS = 6;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_BYTES = 120 * 1024;

const TEXT_EXTS = new Set(["txt", "md", "csv", "json", "yaml", "yml", "tsv", "log", "xml", "html", "htm"]);

export const ATTACHMENT_ACCEPT =
  "image/*,.txt,.md,.csv,.json,.yaml,.yml,.tsv,.log,.xml,.html,.htm,text/plain,application/json";

function fileExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(file);
  });
}

/**
 * 读取并校验文件，返回**追加后**的完整附件列表。
 * 超限/不支持的文件会被跳过并逐条回调原因，不会影响已选中的附件。
 */
export async function appendChatAttachments(
  files: FileList | File[],
  current: ChatAttachmentPayload[],
  onError?: (message: string) => void,
): Promise<ChatAttachmentPayload[]> {
  const list = Array.from(files);
  if (list.length === 0) {
    return current;
  }
  const next = [...current];
  for (const file of list) {
    if (next.length >= MAX_ATTACHMENTS) {
      onError?.(`最多附带 ${MAX_ATTACHMENTS} 个文件`);
      break;
    }
    const mime = file.type || "application/octet-stream";
    const isImage = mime.startsWith("image/");
    const isText =
      mime.startsWith("text/") ||
      TEXT_EXTS.has(fileExt(file.name)) ||
      mime === "application/json" ||
      mime === "application/xml";
    if (!isImage && !isText) {
      onError?.(`暂不支持解析「${file.name}」（请用图片或文本类文件）`);
      continue;
    }
    if (isImage && file.size > MAX_IMAGE_BYTES) {
      onError?.(`图片「${file.name}」超过 2MB`);
      continue;
    }
    if (isText && file.size > MAX_TEXT_BYTES) {
      onError?.(`文本「${file.name}」超过 120KB`);
      continue;
    }
    try {
      if (isImage) {
        const dataUrl = await readFileAsDataUrl(file);
        next.push({ kind: "image", name: file.name, mime, dataUrl });
      } else {
        const textContent = await readFileAsText(file);
        next.push({
          kind: "text",
          name: file.name,
          mime,
          textContent: textContent.slice(0, 80_000),
        });
      }
    } catch {
      onError?.(`读取「${file.name}」失败`);
    }
  }
  return next;
}

/** 输入框附件条：模型/Agent 共用同一外观与移除交互 */
export function ChatAttachmentChips({
  attachments,
  disabled = false,
  onChange,
}: {
  attachments: ChatAttachmentPayload[];
  disabled?: boolean;
  onChange?: (next: ChatAttachmentPayload[]) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1.5 px-2 py-1.5">
      {attachments.map((item, index) => (
        <span
          key={`${item.name}-${index}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-sunken px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title={item.name}
        >
          {item.kind === "image" && item.dataUrl ? (
            <img src={item.dataUrl} alt="" className="h-5 w-5 rounded object-cover" />
          ) : null}
          <span className="truncate">{item.name}</span>
          <button
            type="button"
            className="rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
            disabled={disabled || !onChange}
            onClick={() => onChange?.(attachments.filter((_, i) => i !== index))}
            aria-label={`移除 ${item.name}`}
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * 附件选择器：返回隐藏 file input 的 ref 与现成的 onChange / onPaste 处理器。
 * 调用方只负责把 attachments 与 onAttachmentsChange 传进来。
 */
export function useChatAttachmentPicker(input: {
  attachments: ChatAttachmentPayload[];
  onAttachmentsChange?: (next: ChatAttachmentPayload[]) => void;
  onAttachError?: (message: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { attachments, onAttachmentsChange, onAttachError } = input;

  const pushAttachments = async (files: FileList | File[]) => {
    if (!onAttachmentsChange) {
      return;
    }
    const next = await appendChatAttachments(files, attachments, onAttachError);
    if (next !== attachments) {
      onAttachmentsChange(next);
    }
  };

  const onFilePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    event.target.value = "";
    if (files) {
      void pushAttachments(files);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items?.length) {
      return;
    }
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      void pushAttachments(files);
    }
  };

  return { fileInputRef, onFilePicked, onPaste };
}
