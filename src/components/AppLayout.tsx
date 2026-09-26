import { listen } from "@tauri-apps/api/event";
import { HelpCircle, LayoutGrid, Moon, Plus, RefreshCw, Settings, Sun, TriangleAlert, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { APP_LINK_PENDING_HINT, APP_NAME, hasAppLink, openAppLink } from "../lib/appLinks";
import { useTheme } from "../lib/theme";

import {
  batchDeleteProfiles,
  checkLicenseEntitlement,
  deleteProfile,
  exportProfileCookies,
  fetchProfiles,
  fetchSettings,
  formatInvokeError,
  importProfileCookies,
  startProfile,
  stopProfile,
} from "../lib/tauri";
import { saveTextToDownloadDir } from "../lib/nativeFsExport";
import type { Profile, ProfileIpGeo, SidecarLogPayload, TerminalLine } from "../types";
import { AIFillDrawer } from "./AIFillDrawer";
import { useAppDialog } from "./AppDialogProvider";
import { BatchCreateModal } from "./BatchCreateModal";
import { ElementExtractDebugPanel } from "./ElementExtractDebugPanel";
import { useGlobalBanner } from "./GlobalBannerProvider";
import { ProfileFormModal } from "./ProfileFormModal";
import { ProfileTable } from "./ProfileTable";
import { SettingsModal } from "./SettingsModal";
import { WindowControls } from "./WindowControls";
import { type ToastMessage } from "../lib/toast";

/** 右栏默认宽度：约窗宽 42%，左右更均衡；可拖动，并记住偏好 */
const RIGHT_PANEL_WIDTH_KEY = "tianshutai-right-panel-width";
const RIGHT_PANEL_DEFAULT = 520;
const RIGHT_PANEL_MIN = 380;
const LEFT_PANEL_MIN = 420;

function readStoredRightWidth(): number {
  try {
    const raw = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= RIGHT_PANEL_MIN) {
      return Math.round(raw);
    }
  } catch {
    // ignore
  }
  return RIGHT_PANEL_DEFAULT;
}

function clampRightWidth(next: number, viewportWidth: number): number {
  const maxRight = Math.max(RIGHT_PANEL_MIN, viewportWidth - LEFT_PANEL_MIN);
  return Math.round(Math.min(maxRight, Math.max(RIGHT_PANEL_MIN, next)));
}

function makeLine(tone: TerminalLine["tone"], text: string): TerminalLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toLocaleTimeString(),
    tone,
    text,
  };
}

function toneFromSidecarPayload(payload: SidecarLogPayload): TerminalLine["tone"] {
  const parsed = payload.parsed;
  if (!parsed) {
    return "info";
  }

  if (parsed.type === "progress") {
    return "progress";
  }
  if (parsed.kind === "error" || parsed.level === "error") {
    return "error";
  }
  if (parsed.kind === "result" || parsed.ok === true) {
    return "success";
  }
  if (parsed.kind === "log" && parsed.level === "warn") {
    return "warn";
  }
  return "info";
}

function textFromSidecarPayload(payload: SidecarLogPayload): string | null {
  const parsed = payload.parsed;
  if (parsed?.type === "page_url" || parsed?.type === "interactive_extract") {
    return null;
  }

  if (parsed?.type === "progress" && typeof parsed.field === "string") {
    const stage = typeof parsed.stage === "string" ? parsed.stage : "update";
    const ok = parsed.ok;
    const suffix = ok === true ? "ok" : ok === false ? `fail(${String(parsed.error ?? "error")})` : stage;
    return `${parsed.field} · ${suffix}`;
  }

  if (typeof parsed?.message === "string") {
    return parsed.message;
  }

  return payload.line;
}

function humanizeLaunchError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("session seat") ||
    lower.includes("concurrent session") ||
    lower.includes("session limit") ||
    message.includes("席位") ||
    /exit(?:\s*code)?\s*[:\s]*76\b/.test(lower)
  ) {
    return "CloakBrowser 内核会话席位已满：官方免费档仅允许 1 个并发指纹窗。请先停止已开环境或升级 Pro；幽灵占用可强杀后重试。";
  }
  return message;
}

export function AppLayout() {
  const { confirm } = useAppDialog();
  const { notice: bannerNotice, showError, showNotice, clearError } = useGlobalBanner();
  const { theme, toggleTheme } = useTheme();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showProBadge, setShowProBadge] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [batchCreateOpen, setBatchCreateOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [ipGeoOverrides, setIpGeoOverrides] = useState<Map<string, ProfileIpGeo>>(() => new Map());
  /** 全局调试旗标：关闭指纹伪装时环境列表高亮警示 */
  const [fingerprintSpoofingDisabled, setFingerprintSpoofingDisabled] = useState(false);
  const [extractDebugProfileId, setExtractDebugProfileId] = useState<string | null>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(readStoredRightWidth);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const refreshFingerprintFlag = useCallback(async () => {
    try {
      const next = await fetchSettings();
      setFingerprintSpoofingDisabled(Boolean(next.fingerprint_off));
    } catch {
      // 设置读取失败不阻断主界面
    }
  }, []);

  useEffect(() => {
    void refreshFingerprintFlag();
  }, [refreshFingerprintFlag]);

  useEffect(() => {
    if (!settingsOpen) {
      void refreshFingerprintFlag();
    }
  }, [settingsOpen, refreshFingerprintFlag]);

  const mergeIpGeoOverride = useCallback((entry: ProfileIpGeo) => {
    const profileId = entry.profile_id?.trim();
    if (!profileId) {
      return;
    }
    setIpGeoOverrides((current) => {
      const next = new Map(current);
      next.set(profileId, entry);
      return next;
    });
  }, []);

  /** 兼容子组件 onError(string)：空串清栏，否则写入红色通知 */
  const handleBannerError = useCallback(
    (message: string) => {
      if (!message.trim()) {
        clearError();
        return;
      }
      showError(message);
    },
    [clearError, showError],
  );

  const showToast = useCallback(
    (message: ToastMessage) => {
      showNotice(message.tone, message.text);
    },
    [showNotice],
  );

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  /**
   * 官网 / 帮助中心入口。地址目前是占位（见 lib/appLinks.ts），未对接时
   * 只给一句轻提示，不打开任何站内说明页。
   */
  const handleAppLink = useCallback(
    (kind: "home" | "help") => {
      const label = kind === "home" ? "官网（主页）" : "帮助中心";
      void openAppLink(kind).then((opened) => {
        if (!opened) {
          showNotice("info", `${label}尚未对接 · ${APP_LINK_PENDING_HINT}`);
        }
      });
    },
    [showNotice],
  );

  const refreshEntitlement = useCallback(async () => {
    try {
      const entitlement = await checkLicenseEntitlement();
      setShowProBadge(entitlement.isPro && entitlement.isValid);
    } catch {
      setShowProBadge(false);
    }
  }, []);

  useEffect(() => {
    void refreshEntitlement();
  }, [refreshEntitlement]);

  const pushTerminalLine = useCallback((line: TerminalLine) => {
    setTerminalLines((current) => [...current, line].slice(-400));
  }, []);

  const refreshProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchProfiles();
      setProfiles(next);
      clearError();
    } catch (error) {
      showError(formatInvokeError(error));
    } finally {
      setLoading(false);
    }
  }, [clearError, showError]);

  // closeSettings 依赖 refreshProfiles / refreshEntitlement — 修正闭包
  const closeSettingsStable = useCallback(() => {
    setSettingsOpen(false);
    void refreshEntitlement();
    void refreshProfiles();
  }, [refreshEntitlement, refreshProfiles]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  useEffect(() => {
    let isCancelled = false;
    const unlistenFns: Array<() => void> = [];

    const track = (promise: Promise<() => void>) => {
      void promise.then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      });
    };

    track(
      listen<SidecarLogPayload>("sidecar-log", (event) => {
        const text = textFromSidecarPayload(event.payload);
        if (!text) {
          return;
        }
        pushTerminalLine(makeLine(toneFromSidecarPayload(event.payload), text));
      }),
    );

    track(
      listen<ProfileIpGeo>("profile-ip-geo-updated", (event) => {
        mergeIpGeoOverride(event.payload);
      }),
    );

    track(
      listen<{
        profileId?: string;
        profile_id?: string;
        status?: string;
        cdpPort?: number;
        cdp_port?: number;
      }>("browser-status", (event) => {
        const payload = event.payload;
        const profileId = payload.profileId ?? payload.profile_id ?? "?";
        const status = payload.status ?? "unknown";
        const cdpPort = payload.cdpPort ?? payload.cdp_port;
        pushTerminalLine(
          makeLine(
            status === "running" ? "success" : "info",
            `[browser] profile=${profileId} status=${status}${cdpPort ? ` cdp=${cdpPort}` : ""}`,
          ),
        );
        if (profileId !== "?") {
          setProfiles((current) =>
            current.map((profile) =>
              String(profile.id) === profileId
                ? {
                    ...profile,
                    status: status === "running" || status === "stopped" ? status : profile.status,
                    cdp_port: status === "stopped" ? null : (cdpPort ?? profile.cdp_port),
                  }
                : profile,
            ),
          );
        }
        void refreshProfiles();
      }),
    );

    return () => {
      isCancelled = true;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, [mergeIpGeoOverride, pushTerminalLine, refreshProfiles]);

  const withBusy = async (id: string, task: () => Promise<void>, errorPrefix?: string): Promise<boolean> => {
    setBusyIds((current) => [...current, id]);
    clearError();
    try {
      await task();
      await refreshProfiles();
      return true;
    } catch (error) {
      const message = formatInvokeError(error);
      const readable = errorPrefix ? `${errorPrefix}: ${message}` : message;
      showError(readable);
      return false;
    } finally {
      setBusyIds((current) => current.filter((item) => item !== id));
    }
  };

  const handleToggle = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  // 单击行（非勾选框区域）→ 单选：仅选中该环境
  const handleSelect = (id: string) => {
    setSelectedIds([id]);
  };

  const handleToggleAll = () => {
    if (profiles.length === 0) {
      return;
    }
    const allIds = profiles.map((profile) => String(profile.id));
    setSelectedIds((current) => (current.length === allIds.length ? [] : allIds));
  };

  const handleStart = (id: string) =>
    withBusy(
      id,
      async () => {
        try {
          const result = await startProfile(id);
          if (result.ip_geo) {
            mergeIpGeoOverride(result.ip_geo);
          }
          pushTerminalLine(makeLine("success", `[start] profile=${id} cdp=${result.cdp_port}`));
        } catch (error) {
          throw new Error(humanizeLaunchError(formatInvokeError(error)));
        }
      },
      "启动失败",
    );

  const handleStop = (id: string) =>
    withBusy(
      id,
      async () => {
        await stopProfile(id);
        pushTerminalLine(makeLine("info", `[stop] profile=${id}`));
      },
      "停止失败",
    );

  const handleDelete = async (id: string) => {
    const confirmed = await confirm({
      title: "删除环境",
      description: "确定删除该环境？此操作不可撤销。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    void withBusy(id, async () => {
      await deleteProfile(id);
      setSelectedIds((current) => current.filter((item) => item !== id));
      pushTerminalLine(makeLine("warn", `[delete] profile=${id}`));
    });
  };

  const handleBatchStart = async () => {
    clearError();
    for (const id of selectedIds) {
      const profile = profiles.find((item) => String(item.id) === id);
      if (profile?.status === "running") {
        continue;
      }
      await handleStart(id);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) {
      return;
    }
    const confirmed = await confirm({
      title: "批量删除环境",
      description: `确定删除已选的 ${selectedIds.length} 个环境？此操作不可撤销。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }

    clearError();
    try {
      const result = await batchDeleteProfiles(selectedIds);
      setSelectedIds((current) => current.filter((id) => !result.deleted_ids.includes(id)));
      for (const id of result.deleted_ids) {
        pushTerminalLine(makeLine("warn", `[delete] profile=${id}`));
      }
      await refreshProfiles();
      if (result.skipped_running_ids.length > 0) {
        showError(
          `已删除 ${result.deleted_ids.length} 个环境；以下运行中环境已跳过：${result.skipped_running_ids.join(", ")}`,
        );
      }
    } catch (error) {
      showError(formatInvokeError(error));
    }
  };

  const handleExportCookies = async (id: string) => {
    clearError();
    try {
      const result = await exportProfileCookies(id, "json");
      const savedPath = await saveTextToDownloadDir({
        content: result.content,
        filename: `profile-${id}-cookies.json`,
        profileId: id,
        track: "browser",
        openAfter: true,
      });
      pushTerminalLine(
        makeLine("success", `[cookies] 已导出 ${result.count} 条 · profile=${id} · ${savedPath}`),
      );
    } catch (error) {
      showError(formatInvokeError(error));
    }
  };

  const handleImportCookiesError = (id: string, reason: string) => {
    showError(`Cookie 文件读取失败（${reason}）· profile=${id}`);
  };

  const handleImportCookies = async (id: string, payload: string) => {
    clearError();
    try {
      const result = await importProfileCookies(id, payload);
      if (result.appliedNow) {
        pushTerminalLine(makeLine("success", `[cookies] 已即时导入 ${result.count} 条 · profile=${id}`));
      } else {
        pushTerminalLine(
          makeLine("warn", `[cookies] 已暂存 ${result.count} 条，下次启动环境时自动注入 · profile=${id}`),
        );
      }
    } catch (error) {
      showError(formatInvokeError(error));
    }
  };

  const runningCount = useMemo(
    () => profiles.filter((profile) => profile.status === "running").length,
    [profiles],
  );

  useEffect(() => {
    const clampToViewport = () => {
      setRightPanelWidth((current) => clampRightWidth(current, window.innerWidth));
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
    } catch {
      // ignore
    }
  }, [rightPanelWidth]);

  const onSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    splitDragRef.current = { startX: event.clientX, startWidth: rightPanelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onSplitPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDragRef.current;
    if (!drag) {
      return;
    }
    // 向左拖 = 右栏变宽
    const delta = drag.startX - event.clientX;
    setRightPanelWidth(clampRightWidth(drag.startWidth + delta, window.innerWidth));
  };

  const onSplitPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (splitDragRef.current) {
      splitDragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
  };

  return (
    <div className="flex h-screen w-full min-w-0 flex-col overflow-hidden bg-background">
      {/* 顶栏：品牌（可点进主页）+ 运行概览 + 全局动作。无边框窗口：顶栏同时是标题栏，可拖动 */}
      <header
        data-tauri-drag-region
        className="flex h-12 shrink-0 select-none items-center gap-3 bg-card px-3"
      >
        <button
          type="button"
          className="group -ml-1 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-secondary"
          onClick={() => handleAppLink("home")}
          title={hasAppLink("home") ? "进入主页" : "主页（官网）尚未对接"}
        >
          <span
            aria-hidden="true"
            className="h-5 w-5 shrink-0 rounded-md bg-gradient-to-br from-primary to-info shadow-[0_4px_12px_hsl(var(--primary)/0.35)]"
          />
          <span className="truncate text-ui-lg font-semibold tracking-tight">{APP_NAME}</span>
          {showProBadge ? <span className="badge badge-primary shrink-0">Pro</span> : null}
        </button>

        <span
          className={`status-pill ${runningCount > 0 ? "bg-success/10 text-success" : ""}`}
          title="运行中 / 环境总数"
        >
          <span className={`status-dot ${runningCount > 0 ? "status-running" : "status-stopped"}`} />
          {runningCount} / {profiles.length} 运行
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn btn-primary btn-compact h-7"
            onClick={() => setCreateOpen(true)}
            title="新建环境"
          >
            <Plus size={13} />
            新建
          </button>
          <button
            type="button"
            className="btn btn-outline btn-compact h-7"
            onClick={() => setBatchCreateOpen(true)}
            title="批量新建环境"
          >
            <LayoutGrid size={13} />
            批量
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void refreshProfiles()}
            disabled={loading}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>

          <span className="w-1.5 shrink-0" aria-hidden="true" />

          <button
            type="button"
            className="icon-button"
            onClick={() => handleAppLink("help")}
            title={hasAppLink("help") ? "帮助中心" : "帮助中心尚未对接"}
            aria-label="帮助"
          >
            <HelpCircle size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={toggleTheme}
            title={theme === "dark" ? "切换到浅色" : "切换到深色"}
            aria-label="切换主题"
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button type="button" className="icon-button" onClick={openSettings} title="设置" aria-label="设置">
            <Settings size={14} />
          </button>

          {/* 无边框窗口：自绘最小化 / 最大化 / 关闭（关闭仍走退出确认） */}
          <span className="w-1.5 shrink-0" aria-hidden="true" />
          <WindowControls />
        </div>
      </header>

      {bannerNotice ? (
        <div
          className={`banner shrink-0 ${
            bannerNotice.tone === "success"
              ? " bg-success/10 text-success"
              : bannerNotice.tone === "info"
                ? " bg-primary/10 text-foreground"
                : ""
          }`}
          role="status"
        >
          <span className="flex min-w-0 items-center gap-2">
            <TriangleAlert size={14} className="shrink-0" />
            <span className="whitespace-pre-wrap break-words">{bannerNotice.text}</span>
          </span>
          <button
            type="button"
            className={`icon-button shrink-0 ${
              bannerNotice.tone === "error" ? "text-destructive" : "text-muted-foreground"
            }`}
            onClick={clearError}
            aria-label="关闭提示"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左列：环境工作台（画布底色，靠与右栏的明暗差分层） */}
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
            <span className="label-caps">环境</span>
            <span className="text-[10px] text-muted-foreground">{profiles.length} 个环境</span>
          </div>

          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ProfileTable
              profiles={profiles}
              selectedIds={selectedIds}
              busyIds={busyIds}
              ipGeoOverrides={ipGeoOverrides}
              onToggle={handleToggle}
              onSelect={handleSelect}
              onToggleAll={handleToggleAll}
              onStart={handleStart}
              onStop={handleStop}
              onEdit={setEditingProfile}
              onDelete={handleDelete}
              onCreate={() => setCreateOpen(true)}
              onBatchCreate={() => setBatchCreateOpen(true)}
              onOpenSettings={openSettings}
              onRefresh={() => void refreshProfiles()}
              refreshing={loading}
              hideToolbar
              onBatchStart={() => void handleBatchStart()}
              onBatchDelete={() => void handleBatchDelete()}
              onExportCookies={(id) => void handleExportCookies(id)}
              onImportCookies={(id, payload) => void handleImportCookies(id, payload)}
              onImportCookiesError={handleImportCookiesError}
              onOpenExtractDebug={(id) => setExtractDebugProfileId(id)}
              fingerprintSpoofingDisabled={fingerprintSpoofingDisabled}
            />
          </main>
        </div>

        {/* 可拖动分隔：左右比例随窗口缩放，也可手动调 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整左右栏宽度"
          title="拖动调整左右栏宽度"
          className="group relative z-10 flex w-px shrink-0 cursor-col-resize items-stretch bg-transparent transition-colors hover:bg-primary/60 active:bg-primary"
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={onSplitPointerUp}
          onPointerCancel={onSplitPointerUp}
        >
          <span className="pointer-events-none absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>

        {/* 右列：默认约 520px，窗口缩小时自动收紧。面板底色比左列亮一档，无边框即可分层 */}
        <div
          className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-card"
          style={{ width: rightPanelWidth }}
        >
          <AIFillDrawer
            profiles={profiles}
            selectedIds={selectedIds}
            busyIds={busyIds}
            lines={terminalLines}
            onLog={pushTerminalLine}
            onError={handleBannerError}
            onStartBrowser={handleStart}
            onStopBrowser={handleStop}
            ipGeoOverrides={ipGeoOverrides}
          />
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={closeSettingsStable}
        onError={handleBannerError}
        onToast={showToast}
        onEntitlementChange={() => void refreshEntitlement()}
      />

      <ProfileFormModal
        open={createOpen}
        mode="create"
        isProLicense={showProBadge}
        onClose={() => setCreateOpen(false)}
        onSuccess={() => void refreshProfiles()}
        onError={handleBannerError}
      />

      <ProfileFormModal
        open={editingProfile != null}
        mode="edit"
        profile={editingProfile}
        onClose={() => setEditingProfile(null)}
        onSuccess={() => void refreshProfiles()}
        onError={handleBannerError}
      />

      <BatchCreateModal
        open={batchCreateOpen}
        isProLicense={showProBadge}
        onClose={() => setBatchCreateOpen(false)}
        onSuccess={() => void refreshProfiles()}
        onError={handleBannerError}
      />

      {extractDebugProfileId ? (
        <ElementExtractDebugPanel
          profileId={extractDebugProfileId}
          profileName={profiles.find((p) => String(p.id) === extractDebugProfileId)?.name}
          extractEnabled={true}
          onClose={() => setExtractDebugProfileId(null)}
        />
      ) : null}
    </div>
  );
}
