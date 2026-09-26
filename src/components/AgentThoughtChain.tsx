/**
 * Agent Monitor — 结构化 AI 思考流（Thought Chain）卡片。
 *
 * 渲染层只负责「摆样子」：日志怎么翻译、怎么合并、怎么去噪，全部由
 * `lib/agentMonitorView.ts` 决定。默认「精简」模式（人话 + 合并重复 + 丢弃系统噪音），
 * 可一键切回「完整」原始流水账。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Eraser,
  Eye,
  Globe,
  Hand,
  Layers,
  MousePointerClick,
  Pin,
  PinOff,
  ScanSearch,
  Sparkles,
} from "lucide-react";

import {
  buildAgentMonitorView,
  type AgentMonitorCard,
  type AgentMonitorCardKind,
} from "../lib/agentMonitorView";
import type { TerminalLine } from "../types";

interface AgentThoughtChainProps {
  lines: TerminalLine[];
  className?: string;
  emptyHint?: string;
  title?: string;
  headerActions?: ReactNode;
  onClear?: () => void;
}

type CardKind = Exclude<AgentMonitorCardKind, "step">;

function kindIcon(kind: CardKind, tool?: string) {
  if (kind === "thought") {
    return Brain;
  }
  if (kind === "perceive") {
    return Eye;
  }
  if (kind === "alert") {
    return tool === "handover" ? Hand : AlertTriangle;
  }
  if (kind === "action") {
    if (tool === "navigate") {
      return Globe;
    }
    if (tool === "click" || tool === "fill") {
      return MousePointerClick;
    }
    if (tool === "vision") {
      return ScanSearch;
    }
    return Sparkles;
  }
  if (kind === "success") {
    return CircleCheck;
  }
  if (kind === "error") {
    return CircleX;
  }
  return Sparkles;
}

/** 原始流水账行：完整模式下逐行照抄，不做卡片包装，便于逐行排查。 */
function rawToneClass(tone: AgentMonitorCard["tone"]): string {
  switch (tone) {
    case "error":
      return "text-red-300";
    case "warn":
      return "text-amber-300";
    case "success":
      return "text-emerald-300";
    case "progress":
      return "text-sky-300";
    default:
      return "text-code-muted";
  }
}

function RawLogLine({ card }: { card: AgentMonitorCard }) {
  return (
    <div className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-code-hover/40">
      <span className="shrink-0 font-mono text-[10px] leading-4 text-code-subtle">{card.ts}</span>
      <span
        className={`min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-4 ${rawToneClass(
          card.tone,
        )}`}
      >
        {card.body}
      </span>
    </div>
  );
}

interface CardTheme {
  shell: string;
  accent: string;
  icon: string;
  title: string;
}

/** 日志井恒为深色，卡片主题统一走 globals.css 的 .monitor-* 组件类。
 *  这里写全类名（不做字符串拼接）：拼接出来的类名构建时会被 Tailwind 当成
 *  未使用类清掉，运行时卡片就丢了配色。 */
const CARD_THEMES: Record<CardKind, CardTheme> = {
  thought: {
    shell: "monitor-card--thought",
    accent: "monitor-accent--thought",
    icon: "monitor-icon--thought",
    title: "monitor-title--thought",
  },
  perceive: {
    shell: "monitor-card--perceive",
    accent: "monitor-accent--perceive",
    icon: "monitor-icon--perceive",
    title: "monitor-title--perceive",
  },
  action: {
    shell: "monitor-card--action",
    accent: "monitor-accent--action",
    icon: "monitor-icon--action",
    title: "monitor-title--action",
  },
  alert: {
    shell: "monitor-card--alert",
    accent: "monitor-accent--alert",
    icon: "monitor-icon--alert",
    title: "monitor-title--alert",
  },
  success: {
    shell: "monitor-card--success",
    accent: "monitor-accent--success",
    icon: "monitor-icon--success",
    title: "monitor-title--success",
  },
  error: {
    shell: "monitor-card--error",
    accent: "monitor-accent--error",
    icon: "monitor-icon--error",
    title: "monitor-title--error",
  },
  system: {
    shell: "monitor-card--thought",
    accent: "monitor-accent--thought",
    icon: "monitor-icon--thought",
    title: "monitor-title--thought",
  },
  raw: {
    shell: "monitor-card--thought",
    accent: "monitor-accent--thought",
    icon: "monitor-icon--thought",
    title: "monitor-title--thought",
  },
};

function cardTheme(kind: CardKind): CardTheme {
  return CARD_THEMES[kind] ?? CARD_THEMES.thought;
}

function StepDivider({ card }: { card: AgentMonitorCard }) {
  return (
    <div className="flex items-center gap-2 pt-1.5 pb-0.5">
      <span className="h-px flex-1 bg-code-border/60" />
      <span className="shrink-0 rounded bg-code-hover/60 px-1.5 py-px font-mono text-[10px] tracking-wide text-code-text">
        {card.title}
      </span>
      <span className="max-w-[45%] truncate text-[10px] text-code-muted">{card.body}</span>
      <span className="h-px flex-1 bg-code-border/60" />
      <span className="shrink-0 font-mono text-[10px] text-code-subtle">
        {card.count > 0 ? `${card.count} 条` : card.ts}
      </span>
    </div>
  );
}

function MonitorCard({ card }: { card: AgentMonitorCard }) {
  const [open, setOpen] = useState(false);
  const kind = card.kind as CardKind;
  const theme = cardTheme(kind);
  const Icon = kindIcon(kind, card.tool);
  const merged = card.count > 1;
  const expandable = merged || Boolean(card.detail);
  const range = card.lastTs && card.lastTs !== card.ts ? `${card.ts} → ${card.lastTs}` : card.ts;

  return (
    <div className={`monitor-card ${theme.shell}`}>
      <div className={`absolute inset-y-0 left-0 w-0.5 ${theme.accent}`} />
      <div className="flex items-start gap-2 px-2.5 py-2 pl-3">
        <Icon size={13} className={`mt-0.5 shrink-0 ${theme.icon}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`text-[10px] font-medium tracking-wide ${theme.title}`}>{card.title}</span>
            {kind === "alert" ? (
              <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] text-amber-200">需人工</span>
            ) : null}
            {card.target ? (
              <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] text-emerald-200">
                {card.target}
              </span>
            ) : null}
            {merged ? (
              <span
                className="rounded bg-code-hover px-1.5 py-px font-mono text-[9px] text-code-text"
                title={`同类日志已合并 ${card.count} 条`}
              >
                ×{card.count}
              </span>
            ) : null}
            <span className="font-mono text-[10px] text-code-subtle">[{range}]</span>
            {expandable ? (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-0.5 rounded px-1 text-[10px] text-code-subtle transition-colors hover:bg-code-hover hover:text-code-text"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
              >
                {open ? "收起" : merged ? "看明细" : "详情"}
                <ChevronDown size={11} className={`transition-transform ${open ? "rotate-180" : ""}`} />
              </button>
            ) : null}
          </div>
          <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-4 text-code-text">
            {card.body}
          </div>
          {open ? (
            <div className="mt-1.5 space-y-1 rounded bg-code-bg px-2 py-1.5">
              {merged
                ? card.items.map((item) => (
                    <div key={item.id} className="flex gap-2 text-[10px] leading-4">
                      <span className="shrink-0 font-mono text-code-subtle">{item.ts}</span>
                      <span className="min-w-0 flex-1 break-words text-code-muted">{item.text}</span>
                    </div>
                  ))
                : null}
              {card.detail ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-code-subtle">
                  {card.detail}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AgentThoughtChain({
  lines,
  className = "",
  emptyHint = "启动后，思考与步骤会出现在这里",
  title = "监视日志",
  headerActions,
  onClear,
}: AgentThoughtChainProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [compact, setCompact] = useState(true);

  const view = useMemo(() => buildAgentMonitorView(lines, { compact }), [lines, compact]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || !autoScroll) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [view, autoScroll]);

  const handleCopy = async () => {
    const text = view.cards
      .map((card) => {
        if (card.kind === "step") {
          return `—— ${card.title} · ${card.body} ——`;
        }
        if (card.kind === "raw") {
          return `[${card.ts}] ${card.body}`;
        }
        return `[${card.ts}] ${card.title}${card.count > 1 ? ` ×${card.count}` : ""}：${card.body}`;
      })
      .join("\n");
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
          <button
            type="button"
            className={`inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] transition-colors ${
              compact
                ? "bg-code-hover text-code-text"
                : "text-code-subtle hover:bg-code-hover/60 hover:text-code-text"
            }`}
            onClick={() => setCompact((value) => !value)}
            title={compact ? "显示完整日志" : "只看要点"}
            aria-label="简洁显示"
          >
            <Layers size={12} />
            {compact ? "简洁" : "完整"}
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-code-subtle transition-colors hover:bg-code-hover hover:text-code-text"
            onClick={() => void handleCopy()}
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

      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {view.cards.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-code-subtle">{emptyHint}</div>
        ) : (
          <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-0.5"}`}>
            {view.cards.map((card) =>
              card.kind === "step" ? (
                <StepDivider key={card.id} card={card} />
              ) : card.kind === "raw" ? (
                <RawLogLine key={card.id} card={card} />
              ) : (
                <MonitorCard key={card.id} card={card} />
              ),
            )}
          </div>
        )}
      </div>

      {compact && view.droppedNoise > 0 ? (
        <div className="shrink-0 px-3 py-1 font-mono text-[10px] text-code-subtle">
          已折叠 {view.droppedNoise} 条系统调度日志 · 原始 {view.totalLines} 条
        </div>
      ) : null}
    </div>
  );
}
