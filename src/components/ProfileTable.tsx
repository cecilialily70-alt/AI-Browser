import {
  Braces,
  Check,
  Download,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Profile, ProfileIpGeo } from "../types";
import { useProfileIpGeo } from "../hooks/useProfileIpGeo";
import { formatProfileIpCell } from "../lib/ipGeo";

interface ProfileTableProps {
  profiles: Profile[];
  selectedIds: string[];
  busyIds: string[];
  ipGeoOverrides?: Map<string, ProfileIpGeo>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onToggleAll: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onEdit: (profile: Profile) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onBatchCreate: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  onBatchStart: () => void;
  onBatchDelete: () => void;
  onExportCookies: (id: string) => void;
  onImportCookies: (id: string, payload: string) => void;
  /** Cookie 文件读取失败（FileReader 出错）时回调，用于把静默失败暴露给用户 */
  onImportCookiesError?: (id: string, reason: string) => void;
  /** 打开元素提取 JSON 测试窗 */
  onOpenExtractDebug?: (id: string) => void;
  /** 全局「关闭指纹伪装」已开启：列表高亮危险 Tag */
  fingerprintSpoofingDisabled?: boolean;
  /** 顶栏操作已上移到 AppLayout 时隐藏本地面板标题条 */
  hideToolbar?: boolean;
}

function statusLabel(status: string): string {
  return status === "running" ? "运行中" : "已停止";
}

interface RowActionProps {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function RowAction({ label, danger, disabled, onClick, children }: RowActionProps) {
  return (
    <button
      type="button"
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        danger
          ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

interface RowMoreItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: ReactNode;
}

function RowMoreMenu({ items }: { items: RowMoreItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground ${
          open ? "bg-secondary text-foreground" : ""
        }`}
        title="更多操作"
        aria-label="更多操作"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={14} />
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 min-w-[11rem] overflow-hidden rounded-lg bg-raised py-1 shadow-pop animate-fade-in-up">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={item.disabled}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger
                  ? "row-selectable text-destructive hover:bg-destructive/10"
                  : "row-selectable text-foreground"
              }`}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center opacity-70">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProfileTable({
  profiles,
  selectedIds,
  busyIds,
  onToggle,
  onSelect,
  onToggleAll,
  onStart,
  onStop,
  onEdit,
  onDelete,
  onCreate,
  onBatchCreate,
  onOpenSettings,
  onRefresh,
  refreshing = false,
  onBatchStart,
  onBatchDelete,
  onExportCookies,
  onImportCookies,
  onImportCookiesError,
  onOpenExtractDebug,
  ipGeoOverrides,
  fingerprintSpoofingDisabled = false,
  hideToolbar = false,
}: ProfileTableProps) {
  const cookieFileRef = useRef<HTMLInputElement>(null);
  const [importTargetId, setImportTargetId] = useState<string | null>(null);
  const { map: ipGeoMap } = useProfileIpGeo(profiles, ipGeoOverrides);
  const allSelected =
    profiles.length > 0 && profiles.every((profile) => selectedIds.includes(String(profile.id)));
  const runningCount = profiles.filter((profile) => profile.status === "running").length;

  const handleImportClick = (id: string) => {
    setImportTargetId(id);
    cookieFileRef.current?.click();
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-card">
      {fingerprintSpoofingDisabled ? (
        <div
          className="flex shrink-0 items-center gap-2 bg-destructive/10 px-4 py-2 text-caption font-medium text-destructive"
          role="alert"
        >
          <ShieldAlert size={14} className="shrink-0" />
          <span>指纹伪装已全局关闭 · 所有环境将暴露本机真实硬件指纹与真实 IP，用完请立即到设置中恢复。</span>
        </div>
      ) : null}

      {/* 标题 + 主操作（可由 AppLayout 顶栏接管） */}
      {!hideToolbar ? (
        <div className="panel-header">
          <div className="min-w-0">
            <h2 className="panel-title">环境列表</h2>
            <p className="mt-0.5 text-caption text-muted-foreground">
              {profiles.length} 个环境 · {runningCount} 运行中
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <button type="button" className="btn btn-primary" onClick={onCreate} title="新建环境">
              <Plus size={14} />
              新建
            </button>
            <button type="button" className="btn btn-outline" onClick={onBatchCreate} title="批量新建环境">
              <LayoutGrid size={14} />
              批量
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={onOpenSettings}
              title="设置"
              aria-label="设置"
            >
              <Settings size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={onRefresh}
              disabled={refreshing}
              title="刷新"
              aria-label="刷新"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
      ) : null}

      {/* 选中后浮现的批量上下文工具条 */}
      {selectedIds.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between gap-2 bg-primary/10 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="badge badge-primary">已选 {selectedIds.length}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              onClick={onToggleAll}
            >
              <X size={12} />
              清空
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" className="btn btn-outline btn-compact" onClick={onBatchStart}>
              <Play size={12} />
              批量启动
            </button>
            <button type="button" className="btn btn-danger btn-compact" onClick={onBatchDelete}>
              <Trash2 size={12} />
              批量删除
            </button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-10 text-center">
                <button
                  type="button"
                  className={`checkbox ${allSelected ? "checkbox-checked" : ""}`}
                  onClick={onToggleAll}
                  aria-label="全选"
                >
                  {allSelected && <Check size={12} />}
                </button>
              </th>
              <th className="w-12">ID</th>
              <th className="min-w-[9rem]">环境</th>
              <th className="min-w-[10rem] text-center">地区 / 代理</th>
              <th className="w-24 text-center">状态</th>
              <th className="w-[7.5rem] text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            {profiles.length === 0 ? (
              <tr>
                <td colSpan={6} className="border-0 px-4 py-20 text-center">
                  <p className="text-ui text-muted-foreground">还没有环境</p>
                  <p className="mt-1 text-caption text-muted-foreground">
                    新建一个，或使用批量新建导入一份清单
                  </p>
                </td>
              </tr>
            ) : (
              profiles.map((profile) => {
                const id = String(profile.id);
                const selected = selectedIds.includes(id);
                const running = profile.status === "running";
                const busy = busyIds.includes(id);
                const ipCell = formatProfileIpCell(ipGeoMap.get(id), {
                  loading: busy,
                });

                return (
                  <tr key={profile.id} className={selected ? "bg-primary/10" : ""}>
                    <td className="py-2.5 text-center align-middle">
                      <button
                        type="button"
                        className={`checkbox ${selected ? "checkbox-checked" : ""}`}
                        onClick={() => onToggle(id)}
                        aria-label={`选择 ${profile.name}`}
                      >
                        {selected && <Check size={12} />}
                      </button>
                    </td>
                    <td
                      className="cursor-pointer py-2.5 text-left align-middle font-mono text-caption text-muted-foreground"
                      onClick={() => onSelect(id)}
                    >
                      {profile.id}
                    </td>
                    <td
                      className="min-w-[9rem] cursor-pointer py-2 align-middle"
                      onClick={() => onSelect(id)}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/20"
                          style={{ backgroundColor: profile.theme_color }}
                        />
                        <div className="min-w-0">
                          <div className="truncate text-ui font-medium" title={profile.name}>
                            {profile.name}
                          </div>
                          {fingerprintSpoofingDisabled ? (
                            <span className="badge badge-danger mt-1">指纹已关闭</span>
                          ) : null}
                          {profile.cdp_port ? (
                            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                              CDP :{profile.cdp_port}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td
                      className="min-w-[10rem] cursor-pointer py-2.5 text-center align-middle"
                      onClick={() => onSelect(id)}
                    >
                      <div className="mx-auto min-w-0 max-w-full" title={ipCell.title}>
                        <div className="truncate font-mono text-caption text-foreground">
                          {ipCell.primary}
                        </div>
                        {ipCell.secondary ? (
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                            {ipCell.secondary}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td
                      className="cursor-pointer whitespace-nowrap py-2.5 text-center align-middle"
                      onClick={() => onSelect(id)}
                    >
                      <span className="status-pill">
                        <span className={`status-dot ${running ? "status-running" : "status-stopped"}`} />
                        {statusLabel(profile.status)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-center align-middle">
                      <div className="inline-flex items-center justify-center gap-0.5">
                        {running ? (
                          <RowAction label="停止" disabled={busy} onClick={() => onStop(id)}>
                            <Square size={14} />
                          </RowAction>
                        ) : (
                          <RowAction
                            label={busy ? "启动中" : "启动"}
                            disabled={busy}
                            onClick={() => onStart(id)}
                          >
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                          </RowAction>
                        )}
                        <RowAction label="编辑" disabled={busy} onClick={() => onEdit(profile)}>
                          <Pencil size={14} />
                        </RowAction>
                        <RowMoreMenu
                          items={[
                            {
                              label: running ? "导出 Cookie" : "导出 Cookie（需先启动）",
                              disabled: busy || !running,
                              onClick: () => onExportCookies(id),
                              icon: <Download size={12} />,
                            },
                            {
                              label: "导入 Cookie",
                              disabled: busy,
                              onClick: () => handleImportClick(id),
                              icon: <Upload size={12} />,
                            },
                            ...(onOpenExtractDebug
                              ? [
                                  {
                                    label: "元素提取测试窗",
                                    disabled: busy,
                                    onClick: () => onOpenExtractDebug(id),
                                    icon: <Braces size={12} />,
                                  },
                                ]
                              : []),
                            {
                              label: running ? "运行中无法删除" : "删除",
                              danger: true,
                              disabled: busy || running,
                              onClick: () => onDelete(id),
                              icon: <Trash2 size={12} />,
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 表尾汇总栏 */}
      <div className="panel-footer">
        <span>
          {profiles.length} 个环境
          {runningCount > 0 ? ` · ${runningCount} 运行中` : ""}
        </span>
        {selectedIds.length > 0 ? <span>已选 {selectedIds.length}</span> : null}
      </div>

      <input
        ref={cookieFileRef}
        type="file"
        accept=".json,.txt,.cookies,text/plain,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file || !importTargetId) {
            return;
          }
          const reader = new FileReader();
          const targetId = importTargetId;
          reader.onload = () => {
            const text = typeof reader.result === "string" ? reader.result : "";
            onImportCookies(targetId, text);
          };
          // FileReader 失败（权限、文件被占用/删除、磁盘错误）不挂 onerror 时会静默返回，
          // 用户只看到「点了没反应」，误判为按钮失效
          reader.onerror = () => {
            onImportCookiesError?.(targetId, reader.error?.message ?? "unknown");
          };
          reader.readAsText(file);
        }}
      />
    </div>
  );
}
