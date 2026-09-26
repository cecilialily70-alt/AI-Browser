import { listen } from "@tauri-apps/api/event";
import { Braces, Copy, RefreshCw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { createLogger } from "../lib/logger";
import { formatInvokeError, requestProfileInteractiveExtract } from "../lib/tauri";

const logger = createLogger("ElementExtractDebugPanel");

const PANEL_W = 560;
const PANEL_H = 560;
const PENDING_TIMEOUT_MS = 15_000;

type ExtractTab = "fill" | "agent" | "raw";

type InteractiveExtractEvent = {
  profileId?: string;
  profile_id?: string;
  source?: string;
  url?: string;
  title?: string;
  extractedAt?: string;
  fillCount?: number;
  agentCount?: number;
  fill?: unknown;
  agent?: unknown;
  ts?: string;
};

type ElementExtractDebugPanelProps = {
  profileId: string;
  profileName?: string;
  extractEnabled?: boolean;
  onClose: () => void;
};

function prettyJson(value: unknown): string {
  if (value == null) {
    return "// 暂无数据（等待页面导航/刷新后的内存推送）\n";
  }
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return String(value);
  }
}

function sameProfileId(a: string, b: string): boolean {
  return String(a ?? "").trim() === String(b ?? "").trim();
}

export function ElementExtractDebugPanel({
  profileId,
  profileName,
  extractEnabled,
  onClose,
}: ElementExtractDebugPanelProps) {
  const [tab, setTab] = useState<ExtractTab>("agent");
  const [fill, setFill] = useState<unknown>(null);
  const [agent, setAgent] = useState<unknown>(null);
  const [meta, setMeta] = useState<{
    url: string;
    title: string;
    source: string;
    extractedAt: string;
    fillCount: number;
    agentCount: number;
  }>({
    url: "",
    title: "",
    source: "",
    extractedAt: "",
    fillCount: 0,
    agentCount: 0,
  });
  const [pendingNav, setPendingNav] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pos, setPos] = useState(() => ({
    x: Math.max(12, (typeof window !== "undefined" ? window.innerWidth : 1200) - PANEL_W - 12),
    y: Math.max(12, (typeof window !== "undefined" ? window.innerHeight : 800) - PANEL_H - 12),
  }));
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

  const armPendingTimeout = useCallback(() => {
    clearPendingTimer();
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      setPendingNav(false);
      setError(
        "提取超时未收到推送。请确认：1) 浏览器已启动 2) 已重启环境（加载最新 sidecar/dist）3) 再点刷新。若仍失败请看终端是否有 interactive_extract。",
      );
    }, PENDING_TIMEOUT_MS);
  }, [clearPendingTimer]);

  const clampPos = useCallback((x: number, y: number) => {
    const maxX = Math.max(0, window.innerWidth - 120);
    const maxY = Math.max(0, window.innerHeight - 48);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    };
  }, []);

  const onDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("button")) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        active: true,
        startX: event.clientX,
        startY: event.clientY,
        originX: pos.x,
        originY: pos.y,
      };
    },
    [pos.x, pos.y],
  );

  const onDragPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag?.active) {
        return;
      }
      setPos(
        clampPos(drag.originX + (event.clientX - drag.startX), drag.originY + (event.clientY - drag.startY)),
      );
    },
    [clampPos],
  );

  const onDragPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.active) {
      dragRef.current.active = false;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
  }, []);

  const applyPayload = useCallback(
    (payload: InteractiveExtractEvent) => {
      const eventProfileId = String(payload.profileId ?? payload.profile_id ?? "").trim();
      if (eventProfileId && !sameProfileId(eventProfileId, profileId)) {
        return;
      }
      if (payload.fill !== undefined) {
        setFill(payload.fill);
      }
      if (payload.agent !== undefined) {
        setAgent(payload.agent);
      }
      const agentObj =
        payload.agent && typeof payload.agent === "object"
          ? (payload.agent as { llm_json?: unknown[] })
          : null;
      const agentCount = Number(
        payload.agentCount ?? (Array.isArray(agentObj?.llm_json) ? agentObj.llm_json.length : 0),
      );
      setMeta({
        url: String(payload.url ?? "").trim(),
        title: String(payload.title ?? "").trim(),
        source: String(payload.source ?? "memory").trim() || "memory",
        extractedAt: String(payload.extractedAt ?? payload.ts ?? "").trim(),
        fillCount: Number(payload.fillCount ?? 0),
        agentCount,
      });
      clearPendingTimer();
      setPendingNav(false);
      setError(null);
    },
    [clearPendingTimer, profileId],
  );

  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    void listen<InteractiveExtractEvent>("interactive-extract-updated", (event) => {
      if (!cancelled) {
        applyPayload(event.payload);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistens.push(fn);
      })
      .catch((err) => {
        logger.error("listen extract failed", err);
      });

    void listen<{ profileId?: string; url?: string }>("page-url-changed", (event) => {
      if (cancelled) return;
      const eventProfileId = String(event.payload.profileId ?? "").trim();
      if (eventProfileId && !sameProfileId(eventProfileId, profileId)) return;
      const url = String(event.payload.url ?? "").trim();
      if (!url) return;
      setMeta((prev) => ({
        ...prev,
        url,
        title: "",
        source: "navigating",
      }));
      setPendingNav(true);
      setError(null);
      armPendingTimeout();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistens.push(fn);
      })
      .catch(() => undefined);

    void listen<{ profileId?: string }>("interactive-extract-cleared", (event) => {
      if (cancelled) return;
      const eventProfileId = String(event.payload.profileId ?? "").trim();
      if (eventProfileId && !sameProfileId(eventProfileId, profileId)) return;
      clearPendingTimer();
      setFill(null);
      setAgent(null);
      setPendingNav(false);
      setMeta({
        url: "",
        title: "",
        source: "cleared",
        extractedAt: "",
        fillCount: 0,
        agentCount: 0,
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistens.push(fn);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      clearPendingTimer();
      for (const fn of unlistens) fn();
    };
  }, [applyPayload, armPendingTimeout, clearPendingTimer, profileId]);

  const requestExtractNow = useCallback(async () => {
    setPendingNav(true);
    setError("正在请求立即提取…");
    armPendingTimeout();
    try {
      await requestProfileInteractiveExtract(profileId);
      setError("已请求立即提取：完成后本窗会自动更新（需浏览器正在运行且已加载最新 sidecar/dist）。");
    } catch (err) {
      clearPendingTimer();
      setPendingNav(false);
      setError(formatInvokeError(err));
    }
  }, [armPendingTimeout, clearPendingTimer, profileId]);

  useEffect(() => {
    void requestExtractNow();
  }, [requestExtractNow]);

  const displayJson = useMemo(() => {
    if (tab === "fill") {
      if (fill == null && (meta.fillCount > 0 || meta.agentCount > 0)) {
        return "// 元数据有计数但 fill 体缺失（事件可能被截断或未携带 fill）\n";
      }
      return prettyJson(fill);
    }
    if (tab === "agent") {
      if (agent == null && (meta.fillCount > 0 || meta.agentCount > 0)) {
        return "// 元数据有计数但 agent 体缺失（事件可能被截断或未携带 agent）\n";
      }
      return prettyJson(agent);
    }
    return prettyJson({ meta, fill, agent });
  }, [tab, fill, agent, meta]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      setError(formatInvokeError(err));
    }
  };

  const headerTitle = meta.title || (pendingNav ? "提取中…" : "") || profileName || profileId;

  return (
    <div
      className="fixed z-[80] flex h-[min(70vh,560px)] w-[min(92vw,560px)] flex-col overflow-hidden rounded-xl bg-raised shadow-panel"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="flex cursor-grab items-center gap-2 px-2.5 py-1.5 active:cursor-grabbing select-none"
        title="拖拽移动窗口"
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
        onPointerCancel={onDragPointerUp}
      >
        <Braces size={14} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium">元素提取测试 · {headerTitle}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {meta.url || "等待导航后内存推送…"}
          </div>
        </div>
        <button
          type="button"
          className="icon-button cursor-pointer"
          title="立即提取当前页并推送本窗"
          aria-label="立即提取"
          onClick={() => void requestExtractNow()}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className="icon-button cursor-pointer"
          title="复制当前 JSON"
          aria-label="复制"
          onClick={() => void handleCopy()}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          className="icon-button cursor-pointer"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex items-center gap-1 px-2 py-1 text-[10px]">
        {(
          [
            ["agent", "Agent llm_json"],
            ["fill", "填表提取"],
            ["raw", "完整包"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded px-2 py-0.5 transition-colors ${
              tab === id
                ? "row-selected text-foreground"
                : "row-selectable text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto truncate text-muted-foreground">
          {pendingNav ? "navigating…" : meta.source || "memory"}
          {meta.agentCount || meta.fillCount ? ` · fill=${meta.fillCount} agent=${meta.agentCount}` : ""}
          {copied ? " · 已复制" : ""}
        </span>
      </div>

      {extractEnabled === false ? (
        <div className=" bg-warning/10 px-2.5 py-1 text-[10px] text-warning">
          调试缓存异常时，页面字段列表可能为空，智能填表会受限；导航推送与「立即提取」仍可用。
        </div>
      ) : null}

      {error ? (
        <div className=" bg-destructive/10 px-2.5 py-1 text-[10px] text-destructive">{error}</div>
      ) : null}

      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-sunken p-2 font-mono text-[11px] leading-relaxed text-foreground">
        {pendingNav && !agent && !fill
          ? "// 正在提取…（最长约 15 秒；超时会提示。改源码后须 npm run build sidecar 并重启浏览器）\n"
          : displayJson}
      </pre>
    </div>
  );
}
