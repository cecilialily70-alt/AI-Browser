import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Eraser,
  Info,
  List,
  Pin,
  PinOff,
  TriangleAlert,
} from "lucide-react";

import type { TerminalLine } from "../types";

interface TerminalLogProps {
  lines: TerminalLine[];
  className?: string;
  contentClassName?: string;
  emptyHint?: string;
  title?: string;
  /** 监控台标题栏右侧操作区（如浏览器启停） */
  headerActions?: ReactNode;
  /** 可选：清空当前日志 */
  onClear?: () => void;
}

type ToneFilter = "all" | TerminalLine["tone"];

const TONE_FILTERS: Array<{
  key: ToneFilter;
  label: string;
  icon: typeof Info;
  toneClass: string;
}> = [
  { key: "all", label: "全部", icon: List, toneClass: "text-code-text" },
  { key: "info", label: "信息", icon: Info, toneClass: "text-sky-400" },
  { key: "success", label: "成功", icon: CircleCheck, toneClass: "text-emerald-400" },
  { key: "warn", label: "警告", icon: TriangleAlert, toneClass: "text-amber-300" },
  { key: "error", label: "错误", icon: CircleX, toneClass: "text-red-400" },
];

function resolveLineRole(line: TerminalLine): TerminalLine["role"] {
  if (line.role) {
    return line.role;
  }
  if (line.text.startsWith("[你]")) {
    return "user";
  }
  if (line.text.startsWith("[AI]")) {
    return "assistant";
  }
  return "system";
}

function stripChatPrefix(text: string): string {
  return text.replace(/^\[(你|AI)\]\s*/, "");
}

function systemToneClass(tone: TerminalLine["tone"]): string {
  switch (tone) {
    case "error":
      return "text-red-400";
    case "warn":
      return "text-amber-300";
    case "success":
      return "text-emerald-400";
    case "progress":
      return "text-sky-400";
    default:
      return "text-code-text";
  }
}

export function TerminalLog({
  lines,
  className = "",
  contentClassName = "",
  emptyHint = "暂无日志",
  title = "Sidecar Stream",
  headerActions,
  onClear,
}: TerminalLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<ToneFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const visibleLines = useMemo(
    () => (filter === "all" ? lines : lines.filter((line) => line.tone === filter)),
    [lines, filter],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node || !autoScroll) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [visibleLines, autoScroll]);

  const handleCopy = async () => {
    const text = visibleLines.map((line) => `[${line.ts}] ${stripChatPrefix(line.text)}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默忽略
    }
  };

  return (
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-code-bg ${className}`}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-code-muted">{title}</span>
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="flex items-center gap-0.5">
            {TONE_FILTERS.map((item) => {
              const Icon = item.icon;
              const active = filter === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
                    active
                      ? "bg-code-hover text-code-text"
                      : `${item.toneClass} hover:bg-code-hover/60 hover:text-code-text`
                  }`}
                  onClick={() => setFilter(item.key)}
                  title={item.label}
                  aria-label={item.label}
                >
                  <Icon size={13} />
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-code-subtle transition-colors hover:bg-code-hover hover:text-code-text"
            onClick={handleCopy}
            title="复制日志"
            aria-label="复制日志"
          >
            {copied ? <Check size={13} /> : <ClipboardCopy size={13} />}
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-code-subtle transition-colors hover:bg-code-hover hover:text-code-text"
            onClick={() => setAutoScroll((current) => !current)}
            title={autoScroll ? "关闭自动滚动" : "开启自动滚动"}
            aria-label="自动滚动"
          >
            {autoScroll ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          {onClear ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-code-subtle transition-colors hover:bg-code-hover hover:text-code-text"
              onClick={onClear}
              title="清空日志"
              aria-label="清空日志"
            >
              <Eraser size={13} />
            </button>
          ) : null}
          {headerActions ? (
            <div className="flex shrink-0 items-center gap-1 pl-1.5">{headerActions}</div>
          ) : null}
        </div>
      </div>
      <div
        ref={containerRef}
        className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5 ${contentClassName}`}
      >
        {visibleLines.length === 0 ? (
          <div className="text-code-subtle">{emptyHint}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleLines.map((line) => {
              const role = resolveLineRole(line);
              const body = stripChatPrefix(line.text);

              if (role === "user") {
                return (
                  <div key={line.id} className="flex justify-end">
                    <div className="max-w-[88%] rounded-lg rounded-br-sm bg-code-hover px-2.5 py-2 text-right text-code-text">
                      <div className="mb-0.5 text-[10px] text-code-muted">[{line.ts}] 你</div>
                      <div className="whitespace-pre-wrap break-words text-xs leading-5">{body}</div>
                    </div>
                  </div>
                );
              }

              if (role === "assistant") {
                return (
                  <div key={line.id} className="flex justify-start">
                    <div className="max-w-[92%] rounded-lg rounded-bl-sm bg-code-hover/60 px-2.5 py-2 text-code-text">
                      <div className="mb-0.5 text-[10px] text-code-muted">[{line.ts}] AI</div>
                      <div className="whitespace-pre-wrap break-words text-xs leading-5">{body}</div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={line.id} className="whitespace-pre-wrap break-all">
                  <span className="text-code-subtle">[{line.ts}] </span>
                  <span className={systemToneClass(line.tone)}>{line.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
