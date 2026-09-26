import { ChevronDown, Paperclip, Plus, Send, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, type Ref } from "react";

import type { ChatAttachmentPayload, TerminalLine } from "../types";
import { ATTACHMENT_ACCEPT, ChatAttachmentChips, useChatAttachmentPicker } from "./ChatComposerAttachments";

interface QuickCommand {
  id: string;
  label: string;
  prompt: string;
  fillOnly?: boolean;
}

function stripChatPrefix(text: string): string {
  return text.replace(/^\[(你|AI)\]\s*/, "");
}

function isCustomQuickCommand(command: QuickCommand): boolean {
  return command.id.startsWith("custom-");
}

interface AIChatPanelProps {
  lines: TerminalLine[];
  chatInput: string;
  chatLoading: boolean;
  /** 填表进行中时禁用聊天，避免与智能填表抢输入框 */
  chatDisabled?: boolean;
  quickMenuOpen: boolean;
  quickCommands: QuickCommand[];
  quickMenuRef: Ref<HTMLDivElement>;
  emptyHint?: string;
  attachments?: ChatAttachmentPayload[];
  onAttachmentsChange?: (next: ChatAttachmentPayload[]) => void;
  onChatInputChange: (value: string) => void;
  onSend: () => void;
  onQuickMenuToggle: () => void;
  onQuickCommand: (command: QuickCommand) => void;
  onSaveCustomCommand: () => void;
  onDeleteCustomCommand: (command: QuickCommand) => void;
  onAttachError?: (message: string) => void;
}

function ChatBubble({ line }: { line: TerminalLine }) {
  const isUser = line.role === "user" || line.text.startsWith("[你]");
  const body = stripChatPrefix(line.text);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[86%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-primary-foreground shadow-inset">
          <div className="mb-1 font-mono text-[10px] text-primary-foreground">{line.ts}</div>
          <div className="whitespace-pre-wrap break-words text-ui leading-5">{body}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-lg rounded-bl-sm bg-raised px-3 py-2 text-foreground">
        <div className="mb-1 font-mono text-[10px] text-muted-foreground">{line.ts}</div>
        <div className="whitespace-pre-wrap break-words text-ui leading-5">{body}</div>
      </div>
    </div>
  );
}

export function AIChatPanel({
  lines,
  chatInput,
  chatLoading,
  chatDisabled = false,
  quickMenuOpen,
  quickCommands,
  quickMenuRef,
  emptyHint = "向 AI 提问，支持多轮上下文…",
  attachments = [],
  onAttachmentsChange,
  onChatInputChange,
  onSend,
  onQuickMenuToggle,
  onQuickCommand,
  onSaveCustomCommand,
  onDeleteCustomCommand,
  onAttachError,
}: AIChatPanelProps) {
  const historyRef = useRef<HTMLDivElement>(null);
  const inputLocked = chatLoading || chatDisabled;

  const { fileInputRef, onFilePicked, onPaste } = useChatAttachmentPicker({
    attachments,
    onAttachmentsChange,
    onAttachError,
  });

  const chatLines = useMemo(
    () =>
      lines.filter(
        (line) =>
          line.role === "user" ||
          line.role === "assistant" ||
          line.text.startsWith("[你]") ||
          line.text.startsWith("[AI]"),
      ),
    [lines],
  );

  useEffect(() => {
    const node = historyRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [chatLines, chatLoading]);

  return (
    <div className="panel">
      <div ref={historyRef} className="min-h-0 flex-1 overflow-y-auto bg-sunken p-3">
        {chatLines.length === 0 ? (
          <p className="text-caption text-muted-foreground">{emptyHint}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {chatLines.map((line) => (
              <ChatBubble key={line.id} line={line} />
            ))}
            {chatLoading ? (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg rounded-bl-sm bg-raised px-3 py-2 text-muted-foreground">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  <span className="text-caption">正在思考…</span>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <ChatAttachmentChips attachments={attachments} disabled={inputLocked} onChange={onAttachmentsChange} />

      <div className="relative shrink-0 bg-surface-muted">
        <textarea
          className="field-input max-h-28 min-h-[54px] w-full resize-none px-3 py-2 pr-28 text-ui leading-5 disabled:opacity-60"
          value={chatInput}
          onChange={(event) => onChatInputChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!inputLocked) {
                onSend();
              }
            }
          }}
          placeholder={chatDisabled ? "填表进行中，请稍候…" : "输入消息…"}
          disabled={inputLocked}
          rows={2}
        />
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            accept={ATTACHMENT_ACCEPT}
            onChange={onFilePicked}
          />
          <button
            type="button"
            className="btn btn-outline px-2 py-1 text-[11px]"
            disabled={inputLocked || !onAttachmentsChange}
            title="添加图片或文本附件"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={12} />
          </button>
          <div className="relative" ref={quickMenuRef}>
            <button
              type="button"
              className="btn btn-outline px-2 py-1 text-[11px]"
              onClick={onQuickMenuToggle}
              disabled={inputLocked}
              title="快捷命令"
            >
              <Zap size={12} />
              <ChevronDown size={11} className={quickMenuOpen ? "rotate-180" : ""} />
            </button>
            {quickMenuOpen ? (
              <div className="absolute bottom-full right-0 z-20 mb-1 w-56 overflow-hidden rounded-lg bg-raised shadow-pop animate-fade-in-up">
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="label-caps">快捷命令</span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary-text hover:bg-primary/10"
                    onClick={onSaveCustomCommand}
                    title="把当前输入框内容存为快捷命令"
                  >
                    <Plus size={11} />
                    增加
                  </button>
                </div>
                <div className="max-h-52 overflow-y-auto py-1">
                  {quickCommands.length === 0 ? (
                    <p className="px-3 py-2 text-caption text-muted-foreground">暂无快捷命令</p>
                  ) : (
                    quickCommands.map((command) => {
                      const custom = isCustomQuickCommand(command);
                      return (
                        <div key={command.id} className="group flex items-stretch hover:bg-secondary">
                          <button
                            type="button"
                            className="min-w-0 flex-1 px-3 py-2 text-left text-ui"
                            onClick={() => onQuickCommand(command)}
                            title={command.prompt}
                          >
                            <span className="block truncate">{command.label}</span>
                            {custom ? (
                              <span className="mt-0.5 block text-[10px] text-muted-foreground">自定义</span>
                            ) : null}
                          </button>
                          {custom ? (
                            <button
                              type="button"
                              className="px-2 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                              title="删除快捷命令"
                              onClick={() => onDeleteCustomCommand(command)}
                            >
                              <Trash2 size={12} />
                            </button>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-primary px-2 py-1 text-[11px]"
            disabled={inputLocked || (!chatInput.trim() && attachments.length === 0)}
            onClick={onSend}
            title="发送"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
