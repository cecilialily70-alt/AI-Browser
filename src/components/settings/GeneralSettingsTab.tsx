import {
  Cpu,
  Download,
  FileKey,
  FileUp,
  FolderOpen,
  Plug,
  Power,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Stethoscope,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  cleanupCloakBinary,
  clearCloakLicenseKey,
  diagnoseCloakBinary,
  downloadCloakBinary,
  fetchSettings,
  formatInvokeError,
  getCloakBinaryStatus,
  getExternalDataApiState,
  importKeyFile,
  listLocalKernels,
  pickDirectory,
  pickKeyFile,
  purgeAutomationCache,
  regenerateExternalDataApiToken,
  setCloakLicenseKey,
  setExternalDataApiEnabled,
  setExternalDataApiCapability,
  stopAllProfiles,
  testCloakPath,
  testKeyFile,
  updateCloakBinary,
  updateSetting,
  type ExternalDataApiState,
} from "../../lib/tauri";
import type { AppSettings, CloakBinaryStatus, ConnectivityStatus, LocalKernel } from "../../types";
import { createToast } from "../../lib/toast";
import type { ToastMessage } from "../../lib/toast";
import { useAppDialog } from "../AppDialogProvider";
import { ConnectivityIndicator } from "./ConnectivityIndicator";
import { SettingsSection } from "./SettingsSection";
import { KernelVersionSelect } from "../KernelVersionSelect";
import { FREE_CHROMIUM_VERSION } from "../../lib/kernelPolicy";

const BROWSER_VERSION_PIN_RE = /^\d+(?:\.\d+){3,4}$/;

function normalizeKernelPin(raw: string | null | undefined): string {
  return String(raw ?? "").trim();
}

/** 版本号逐段数值比较，供 `.sort()` 使用：新的排在前面。 */
function newerVersionFirst(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function assertKernelPinOrEmpty(pin: string): void {
  if (!pin) {
    return;
  }
  if (!BROWSER_VERSION_PIN_RE.test(pin)) {
    throw new Error(
      `内核版本无效「${pin}」。请填写完整 Chromium pin（4~5 段），例如 ${FREE_CHROMIUM_VERSION}`,
    );
  }
}
interface GeneralSettingsTabProps {
  settings: AppSettings;
  keyStatus: ConnectivityStatus;
  saving: boolean;
  onSettingsChange: (next: AppSettings) => void;
  onKeyStatusChange: (status: ConnectivityStatus) => void;
  onSavingChange: (saving: boolean) => void;
  onToast: (toast: ToastMessage) => void;
  onError: (message: string) => void;
  onEntitlementChange: () => void;
}

/** 邮箱粘贴常带空格（`cb_ xxx yyy`），落库前统一去掉。 */
function normalizeCloakLicenseKey(raw: string): string {
  return raw.replace(/\s+/g, "").trim();
}

function isSessionSeatsFull(status: CloakBinaryStatus | null): boolean {
  const active = status?.sessionSeatsActive;
  const limit = status?.sessionSeatsLimit;
  return typeof active === "number" && typeof limit === "number" && limit > 0 && active >= limit;
}

/** 全局兼容/调试旗标开关行：标题 + 说明 + ui-switch。 */
function FlagToggle({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md bg-sunken px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <div className="text-caption font-medium text-foreground">{label}</div>
        {hint ? <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`ui-switch shrink-0 ${checked ? "ui-switch-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className={`ui-switch-knob ${checked ? "translate-x-3.5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

export function GeneralSettingsTab({
  settings,
  keyStatus,
  saving,
  onSettingsChange,
  onKeyStatusChange,
  onSavingChange,
  onToast,
  onError,
  onEntitlementChange,
}: GeneralSettingsTabProps) {
  const { confirm } = useAppDialog();
  const [binaryStatus, setBinaryStatus] = useState<CloakBinaryStatus | null>(null);
  const [binaryError, setBinaryError] = useState<string | null>(null);
  const [localKernels, setLocalKernels] = useState<LocalKernel[]>([]);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [binaryBusy, setBinaryBusy] = useState(false);
  const [diagnoseBusy, setDiagnoseBusy] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [licenseKeyDraft, setLicenseKeyDraft] = useState(settings.cloak_license_key);
  const [dataApi, setDataApi] = useState<ExternalDataApiState | null>(null);
  const [dataApiBusy, setDataApiBusy] = useState(false);
  const [dataApiTokenVisible, setDataApiTokenVisible] = useState(false);

  // 外部数据 API 状态每次进入设置都拉一次（可能在别处被改过）
  useEffect(() => {
    void (async () => {
      try {
        setDataApi(await getExternalDataApiState());
      } catch {
        setDataApi(null);
      }
    })();
  }, []);

  const applyDataApiResult = (patch: Partial<ExternalDataApiState>) => {
    setDataApi((previous) => (previous ? { ...previous, ...patch } : previous));
  };

  const handleToggleDataApi = async (next: boolean) => {
    setDataApiBusy(true);
    try {
      const result = await setExternalDataApiEnabled(next);
      applyDataApiResult(result);
      onToast(
        createToast("success", next ? "外部数据 API 已开启（仅本机可访问，需令牌）" : "外部数据 API 已关闭"),
      );
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setDataApiBusy(false);
    }
  };

  const handleRegenerateDataApiToken = async () => {
    const ok = await confirm({
      title: "重新生成外部数据 API 令牌",
      description: "旧令牌会立即失效，正在使用它的程序必须先更新令牌才能继续传数据。",
      confirmLabel: "重新生成",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) {
      return;
    }
    setDataApiBusy(true);
    try {
      const result = await regenerateExternalDataApiToken();
      applyDataApiResult(result);
      setDataApiTokenVisible(true);
      onToast(createToast("success", "令牌已重新生成"));
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setDataApiBusy(false);
    }
  };

  const handleToggleDataApiCapability = async (capability: "replay" | "clipboard", next: boolean) => {
    setDataApiBusy(true);
    try {
      await setExternalDataApiCapability(capability, next);
      setDataApi((previous) =>
        previous
          ? {
              ...previous,
              capabilities: {
                replay: previous.capabilities?.replay ?? false,
                clipboard: previous.capabilities?.clipboard ?? false,
                [capability]: next,
              },
            }
          : previous,
      );
      onToast(
        createToast(
          "success",
          capability === "replay"
            ? next
              ? "回放接口已开启（仍走同一条回放链路与支付/凭证闸门）"
              : "回放接口已关闭"
            : next
              ? "剪贴板读取已开启（一次性凭证仍默认拒绝自动填入）"
              : "剪贴板读取已关闭",
        ),
      );
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setDataApiBusy(false);
    }
  };

  const handleCopy = async (value: string, successToast: string) => {
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      onToast(createToast("success", successToast));
    } catch {
      onError("复制失败，请手动选中文本复制");
    }
  };

  // 设置被外部刷新（保存后 re-hydrate / 切换标签页）时同步草稿
  useEffect(() => {
    setLicenseKeyDraft(settings.cloak_license_key);
  }, [settings.cloak_license_key]);

  const hasLicenseKey = Boolean(normalizeCloakLicenseKey(settings.cloak_license_key));

  const refreshLocalKernels = async () => {
    try {
      setLocalKernels(await listLocalKernels());
    } catch {
      setLocalKernels([]);
    }
  };

  const applyBinaryResult = async (
    status: CloakBinaryStatus,
    successToast: string,
    baseSettings: AppSettings = settings,
  ) => {
    setBinaryStatus(status);
    await refreshLocalKernels();
    const chromePath = status.binaryPath?.trim();
    if (chromePath) {
      const nextSettings = { ...baseSettings, cloak_path: chromePath };
      onSettingsChange(nextSettings);
      try {
        await updateSetting("cloak_path", chromePath);
        await testCloakPath(chromePath);
      } catch {
        // 校验失败不阻断：路径已落库，启动时会按同一套解析逻辑重新判定
      }
    }
    onToast(createToast("success", successToast));
    if (status.licenseFallbackReason?.trim()) {
      onToast(createToast("info", status.licenseFallbackReason));
    }
    onError("");
  };

  const refreshBinaryStatus = async (licenseKey?: string, browserVersion?: string) => {
    try {
      const key = licenseKey ?? settings.cloak_license_key;
      const pin =
        browserVersion !== undefined
          ? normalizeKernelPin(browserVersion)
          : normalizeKernelPin(settings.default_browser_version);
      const status = await getCloakBinaryStatus(key, pin || undefined);
      setBinaryStatus(status);
      setBinaryError(null);
      return status;
    } catch (error) {
      // 不能把失败折叠成 null：null 同时是「加载中」的渲染依据，
      // 会让卡片永久停在「读取中…」，用户无法区分等待与失败
      setBinaryStatus(null);
      setBinaryError(formatInvokeError(error));
      return null;
    }
  };

  useEffect(() => {
    void refreshBinaryStatus();
    void (async () => {
      try {
        setLocalKernels(await listLocalKernels());
      } catch {
        setLocalKernels([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveLicenseKey = async () => {
    const normalized = normalizeCloakLicenseKey(licenseKeyDraft);
    if (!normalized) {
      onToast(createToast("error", "请粘贴 CloakBrowser 邮件中的 cb_ 开头 License Key"));
      return;
    }
    onSavingChange(true);
    onKeyStatusChange("testing");
    try {
      const result = await setCloakLicenseKey(normalized);
      const nextSettings = await fetchSettings();
      onSettingsChange(nextSettings);
      setLicenseKeyDraft(nextSettings.cloak_license_key);
      onKeyStatusChange(result.isValid ? "success" : "error");
      onToast(createToast(result.isValid ? "success" : "error", result.message));
      onError(result.isValid ? "" : result.message);
      onEntitlementChange();
      await refreshBinaryStatus(nextSettings.cloak_license_key);
    } catch (error) {
      onKeyStatusChange("error");
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleClearLicenseKey = async () => {
    onSavingChange(true);
    try {
      const result = await clearCloakLicenseKey();
      const nextSettings = await fetchSettings();
      onSettingsChange(nextSettings);
      setLicenseKeyDraft("");
      onKeyStatusChange("idle");
      onToast(createToast("success", result.message));
      onError("");
      onEntitlementChange();
      await refreshBinaryStatus("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  /**
   * 从 `.tsk` 文件导入授权。
   * `importKeyFile` 已把 key 落库，因此必须重新拉一次 settings 让输入框与服务端一致，
   * 否则界面会停留在旧密钥上，用户再次点保存会用旧值覆盖刚导入的授权。
   */
  const handleImportKeyFile = async () => {
    let picked: string | null = null;
    try {
      picked = await pickKeyFile();
    } catch (error) {
      onToast(createToast("error", formatInvokeError(error)));
      return;
    }
    if (!picked?.trim()) {
      return;
    }

    onSavingChange(true);
    onKeyStatusChange("testing");
    try {
      const result = await importKeyFile(picked.trim());
      const nextSettings = await fetchSettings();
      onSettingsChange(nextSettings);
      setLicenseKeyDraft(nextSettings.cloak_license_key);
      onKeyStatusChange(result.isValid ? "success" : "error");
      onToast(createToast(result.isValid ? "success" : "error", result.message));
      onError(result.isValid ? "" : result.message);
      onEntitlementChange();
      await refreshBinaryStatus(nextSettings.cloak_license_key);
    } catch (error) {
      onKeyStatusChange("error");
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  /** 只校验不落库：用于确认文件是否有效，或比较两个 Key 文件而不改变当前授权 */
  const handleTestKeyFile = async () => {
    let picked: string | null = null;
    try {
      picked = await pickKeyFile();
    } catch (error) {
      onToast(createToast("error", formatInvokeError(error)));
      return;
    }
    if (!picked?.trim()) {
      return;
    }

    onSavingChange(true);
    onKeyStatusChange("testing");
    try {
      const result = await testKeyFile(picked.trim());
      onKeyStatusChange(result.isValid ? "success" : "error");
      onToast(createToast(result.isValid ? "success" : "info", result.message));
      // 仅验证不写库，因此不动 settings / keyDraft / binaryStatus
    } catch (error) {
      onKeyStatusChange("error");
      onToast(createToast("error", formatInvokeError(error)));
    } finally {
      onSavingChange(false);
    }
  };

  const handleKillAllRunningBrowsers = async () => {
    const seatsHint =
      binaryStatus?.sessionSeatsActive != null && binaryStatus?.sessionSeatsLimit != null
        ? `（当前授权席位 ${binaryStatus.sessionSeatsActive}/${binaryStatus.sessionSeatsLimit}）`
        : "";
    const ok = await confirm({
      title: "结束全部浏览器",
      description:
        `将结束本机所有天枢台环境浏览器${seatsHint}，并停止相关 Agent。` +
        "席位通常会很快释放；若仍显示占满，请点「检查更新」。是否继续？",
      confirmLabel: "结束全部",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) {
      return;
    }
    setKillBusy(true);
    onSavingChange(true);
    try {
      const stopped = await stopAllProfiles();
      // 给授权端一点时间回收席位后再查
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const status = await refreshBinaryStatus();
      const seats =
        status?.sessionSeatsActive != null && status?.sessionSeatsLimit != null
          ? ` · 席位 ${status.sessionSeatsActive}/${status.sessionSeatsLimit}`
          : "";
      onToast(
        createToast(
          "success",
          stopped > 0
            ? `已结束 ${stopped} 个浏览器进程${seats}`
            : `未发现本地运行中进程（若席位仍满，请再点检查更新或稍候）${seats}`,
        ),
      );
      onError("");
      onEntitlementChange();
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setKillBusy(false);
      onSavingChange(false);
    }
  };

  const handleDownloadBinary = async () => {
    setBinaryBusy(true);
    onSavingChange(true);
    try {
      const pin = normalizeKernelPin(settings.default_browser_version);
      assertKernelPinOrEmpty(pin);
      // 先落盘默认 pin，避免「输入了却仍按最新下载」
      await updateSetting("default_browser_version", pin);
      const latest = await fetchSettings();
      onSettingsChange({
        ...latest,
        default_browser_version: pin,
      });

      // Default download directory is current directory + Kernel
      const downloadDir = "Kernel";

      const status = await downloadCloakBinary(latest.cloak_license_key, pin || undefined, downloadDir);
      const tip =
        status.message?.trim() ||
        (pin
          ? `内核已按固定版本就绪：${status.version || pin}`
          : status.version
            ? `内核已就绪（最新）：${status.version}`
            : "内核下载完成");
      await applyBinaryResult(status, tip, {
        ...latest,
        default_browser_version: pin,
      });
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setBinaryBusy(false);
      onSavingChange(false);
    }
  };

  const handleUpdateBinary = async () => {
    setBinaryBusy(true);
    onSavingChange(true);
    try {
      const pin = normalizeKernelPin(settings.default_browser_version);
      assertKernelPinOrEmpty(pin);
      await updateSetting("default_browser_version", pin);
      const latest = await fetchSettings();
      onSettingsChange({
        ...latest,
        default_browser_version: pin,
      });

      // Determine download directory - default to current directory + Kernel
      const kernelDir = "Kernel";
      let downloadDir = kernelDir;

      const status = await updateCloakBinary(latest.cloak_license_key, pin || undefined, downloadDir);
      const tip =
        status.message?.trim() ||
        (pin
          ? status.version
            ? `已确保固定版本 ${status.version}（未跳到最新）`
            : `已按固定版本 ensure：${pin}`
          : status.updated
            ? `已更新到 ${status.updatedTo || status.version || "新版本"}`
            : `已是最新${status.version ? `（${status.version}）` : ""}`);
      await applyBinaryResult(status, tip, {
        ...latest,
        default_browser_version: pin,
      });
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setBinaryBusy(false);
      onSavingChange(false);
    }
  };

  const handleCleanupBinary = async () => {
    setBinaryBusy(true);
    onSavingChange(true);
    try {
      const pin = normalizeKernelPin(settings.default_browser_version);
      assertKernelPinOrEmpty(pin);
      const latest = await fetchSettings();
      onSettingsChange(latest);

      // Determine download directory - default to current directory + Kernel
      const kernelDir = "Kernel";
      let downloadDir = kernelDir;

      const status = await cleanupCloakBinary(latest.cloak_license_key, pin || undefined, downloadDir);
      setBinaryStatus(status);
      await refreshLocalKernels();
      if (status.binaryPath?.trim()) {
        const nextSettings = { ...latest, cloak_path: status.binaryPath.trim() };
        onSettingsChange(nextSettings);
        await updateSetting("cloak_path", status.binaryPath.trim());
      }
      onToast(createToast("success", `已清理 ${status.removedCount ?? 0} 个旧内核目录`));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setBinaryBusy(false);
      onSavingChange(false);
    }
  };

  const handlePurgeAutomationCache = async () => {
    const confirmed = await confirm({
      title: "清理自动化缓存",
      description:
        "将删除：爬虫/Agent 下载的图片与验证码帧、以及已从环境列表删除但仍残留的 profile 目录与下载子目录。仍在列表中的环境配置不会删除。确定继续？",
      confirmLabel: "清理",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    setCacheBusy(true);
    onSavingChange(true);
    try {
      const report = await purgeAutomationCache();
      const mb = (report.freedBytes / (1024 * 1024)).toFixed(2);
      onToast(
        createToast(
          "success",
          `已清理目录 ${report.removedDirs}、文件 ${report.removedFiles}（约 ${mb} MB）`,
        ),
      );
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setCacheBusy(false);
      onSavingChange(false);
    }
  };

  const handleDiagnoseBinary = async () => {
    setDiagnoseBusy(true);
    onSavingChange(true);
    try {
      const pin = normalizeKernelPin(settings.default_browser_version);
      assertKernelPinOrEmpty(pin);
      const latest = await fetchSettings();
      onSettingsChange(latest);

      // Determine download directory - default to current directory + Kernel
      const kernelDir = "Kernel";
      let downloadDir = kernelDir;

      const status = await diagnoseCloakBinary(latest.cloak_license_key, pin || undefined, downloadDir);
      setBinaryStatus(status);
      const summary = status.diagnosticSummary?.trim() || "诊断完成";
      onToast(createToast(status.diagnosticOk === false ? "error" : "success", summary));
      onError(status.diagnosticOk === false ? summary : "");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setDiagnoseBusy(false);
      onSavingChange(false);
    }
  };

  const handleSave = async () => {
    onSavingChange(true);
    try {
      await updateSetting("cloak_path", settings.cloak_path);
      // kernel_paths 的编辑入口已下线，但老用户此前配置的版本映射仍被 sidecar 优先使用（跳过下载），
      // 因此这里继续原样回写，避免一次保存把既有配置清空。
      await updateSetting("kernel_paths", settings.kernel_paths || "{}");
      await updateSetting("browser_download_dir", settings.browser_download_dir.trim());
      await updateSetting("scraper_download_dir", settings.scraper_download_dir.trim());
      await updateSetting("license_through_proxy", settings.license_through_proxy ? "true" : "false");
      await updateSetting("allow_third_party_cookies", settings.allow_third_party_cookies ? "true" : "false");
      await updateSetting("fingerprint_off", settings.fingerprint_off ? "true" : "false");
      await updateSetting("default_browser_version", (settings.default_browser_version ?? "").trim());
      // Re-hydrate from SQLite so UI matches what was actually persisted
      const latest = await fetchSettings();
      onSettingsChange(latest);
      onToast(createToast("success", "常规设置已保存"));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handlePickDownloadDir = async (key: "browser_download_dir" | "scraper_download_dir") => {
    try {
      const title = key === "browser_download_dir" ? "选择常规浏览器下载目录" : "选择爬虫抓取下载目录";
      const picked = await pickDirectory(title);
      if (!picked?.trim()) {
        return;
      }
      onSettingsChange({ ...settings, [key]: picked.trim() });
    } catch (error) {
      onToast(createToast("error", formatInvokeError(error)));
    }
  };

  // 与 sidecar 的内核解析优先级保持一致，推算本次启动实际会用的内核：
  // 指定 pin → 该版本的本地运行目录内核；「自动版本」→ 最新的本地免费系内核。
  const pinnedVersion = normalizeKernelPin(settings.default_browser_version);
  const effectiveLocalKernel = (() => {
    const bundled = localKernels.filter((kernel) => kernel.source === "bundled");
    if (pinnedVersion) {
      return bundled.find((kernel) => kernel.version === pinnedVersion) ?? null;
    }
    return (
      bundled
        .filter((kernel) => kernel.tier !== "pro")
        .sort((a, b) => newerVersionFirst(a.version, b.version))[0] ?? null
    );
  })();

  const binarySummary = (() => {
    if (binaryError) {
      return `读取失败：${binaryError}`;
    }
    if (!binaryStatus) {
      return "读取中…";
    }
    const parts: string[] = [];
    if (effectiveLocalKernel) {
      const tier = effectiveLocalKernel.tier === "pro" ? "Pro" : "免费";
      parts.push(`已就绪 · 本地运行目录内核 ${tier} ${effectiveLocalKernel.version}`);
    } else if (binaryStatus.installed) {
      parts.push(`已安装 ${binaryStatus.version ?? "未知"} · ${binaryStatus.tier ?? "free"}`);
      if (binaryStatus.wrapperVersion) {
        parts.push(`封装 ${binaryStatus.wrapperVersion}`);
      }
      if (binaryStatus.releaseChannel) {
        parts.push(binaryStatus.releaseChannel);
      }
    } else {
      parts.push("未安装，点击「下载内核」");
    }
    if (binaryStatus.sessionSeatsActive != null && binaryStatus.sessionSeatsLimit != null) {
      parts.push(`席位 ${binaryStatus.sessionSeatsActive}/${binaryStatus.sessionSeatsLimit}`);
    }
    if ((binaryStatus.unusedCount ?? 0) > 0) {
      parts.push(`可清理 ${binaryStatus.unusedCount} 个旧版`);
    }
    return parts.join(" · ");
  })();

  const kernelSectionDescription = (() => {
    if (effectiveLocalKernel) {
      return `已检测到本地内核 ${effectiveLocalKernel.version}，启动时优先使用，无需下载。`;
    }
    if (binaryStatus?.tier === "pro") {
      return "当前已启用 Pro 内核，可下载并使用最新版本（Stable Pro 151）。";
    }
    if (hasLicenseKey && binaryStatus?.licenseValid === false) {
      return "已保存 License Key，但在线验证未通过（无效/过期/网络不可达）。可开启下方「授权检查走代理」后重试。";
    }
    if (hasLicenseKey) {
      return "License 已保存。若仍显示免费版，请点「检查更新」拉取 Pro 内核。";
    }
    return "未配置 License 时将使用免费版；也可粘贴 Pro 邮件中的密钥以启用 Pro 内核。";
  })();

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={<Cpu size={15} className="text-primary" />}
        title="浏览器内核"
        description={kernelSectionDescription}
      >
        <div className="flex items-center gap-2">
          <p className="text-caption text-muted-foreground">{binarySummary}</p>
          {binaryError ? (
            <button
              type="button"
              className="btn btn-outline h-6 px-2 text-[11px]"
              onClick={() => void refreshBinaryStatus()}
            >
              重试
            </button>
          ) : null}
        </div>
        {isSessionSeatsFull(binaryStatus) ? (
          <div className="space-y-2 rounded-md bg-destructive/10 px-2.5 py-2">
            <p className="text-[11px] leading-4 text-destructive">
              内核会话席位已占满（{binaryStatus?.sessionSeatsActive}/{binaryStatus?.sessionSeatsLimit}
              ）。可结束全部浏览器进程，或稍后再试。
            </p>
            <button
              type="button"
              className="btn btn-outline text-destructive hover:bg-destructive/10"
              disabled={saving || binaryBusy || diagnoseBusy || killBusy}
              onClick={() => void handleKillAllRunningBrowsers()}
            >
              <Power size={14} className={killBusy ? "animate-pulse" : ""} />
              {killBusy ? "结束中…" : "结束全部浏览器"}
            </button>
          </div>
        ) : null}
        {binaryStatus?.tier === "free" ? (
          <p className="rounded-md bg-warning/10 px-2.5 py-1.5 text-[11px] leading-4 text-warning">
            免费版：可同时开 1 个指纹窗；AI / 填表亦限 1 路。多开请升级 Pro。
            {binaryStatus.proLatestVersion ? ` 最新 Pro：${binaryStatus.proLatestVersion}。` : ""}
          </p>
        ) : null}
        {binaryStatus?.tier === "pro" ? (
          <p className="rounded-md bg-sunken px-2.5 py-1.5 text-[11px] leading-4 text-muted-foreground">
            Pro：指纹窗与 AI 并行均不超过授权席位。可用本机内核或在线更新。
          </p>
        ) : null}
        <div className="rounded-md bg-sunken px-3 py-2.5">
          <p className="mb-2 text-caption font-medium text-foreground">默认版本</p>
          <KernelVersionSelect
            value={settings.default_browser_version ?? ""}
            onChange={(next) => onSettingsChange({ ...settings, default_browser_version: next })}
            disabled={saving}
            localKernels={localKernels}
          />
          <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
            选择启动时使用的内核；自定义版本请填写完整版本号。
          </p>
        </div>

        <div className="rounded-md bg-sunken px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-caption font-medium text-foreground">本机已安装</p>
            <button
              type="button"
              className="btn btn-outline btn-compact h-7"
              disabled={saving}
              onClick={() => void refreshLocalKernels()}
            >
              <Search size={13} />
              刷新列表
            </button>
          </div>
          {localKernels.length === 0 ? (
            <p className="text-[11px] leading-4 text-muted-foreground">
              未检测到本机内核。放入运行目录的 Kernel 文件夹后点「刷新列表」。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {localKernels.map((kernel) => {
                const active = (settings.default_browser_version ?? "").trim() === kernel.version;
                return (
                  <li
                    key={`${kernel.source}:${kernel.dirName}`}
                    className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 ${
                      active ? "bg-primary/10" : "bg-surface-muted"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[11px] font-medium">
                        {kernel.tier === "pro" ? "Pro" : "免费"} {kernel.version}
                        <span className="ml-1.5 text-muted-foreground">
                          {kernel.source === "bundled" ? "本机" : "已下载"}
                        </span>
                      </div>
                      <div
                        className="truncate font-mono text-[10px] text-muted-foreground"
                        title={kernel.chromePath}
                      >
                        {kernel.chromePath}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline h-6 shrink-0 px-2 text-[11px]"
                      disabled={saving || active}
                      onClick={() =>
                        onSettingsChange({
                          ...settings,
                          default_browser_version: kernel.version,
                          cloak_path: kernel.chromePath,
                        })
                      }
                    >
                      {active ? "使用中" : "设为默认"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-outline"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleDownloadBinary()}
          >
            <Download size={14} className={binaryBusy ? "animate-pulse" : ""} />
            {binaryBusy ? "处理中…" : "下载"}
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleUpdateBinary()}
          >
            <RefreshCw size={14} className={binaryBusy ? "animate-spin" : ""} />
            检查更新
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleCleanupBinary()}
          >
            <Trash2 size={14} />
            清理旧版
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleDiagnoseBinary()}
            title="检查内核、License、席位等依赖"
          >
            <Stethoscope size={14} className={diagnoseBusy ? "animate-pulse" : ""} />
            {diagnoseBusy ? "诊断中…" : "诊断"}
          </button>
          <button
            className="btn btn-outline text-destructive hover:bg-destructive/10"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleKillAllRunningBrowsers()}
            title="结束全部环境浏览器进程，用于释放席位"
          >
            <Power size={14} className={killBusy ? "animate-pulse" : ""} />
            {killBusy ? "结束中…" : "结束全部浏览器"}
          </button>
        </div>
        {Array.isArray(binaryStatus?.checks) && binaryStatus.checks.length > 0 ? (
          <ul className="space-y-1.5 rounded-md bg-sunken px-2.5 py-2">
            {binaryStatus.checks.map((check) => (
              <li key={check.id} className="text-[11px] leading-4">
                <span className={check.ok ? "text-success" : "text-destructive"}>
                  {check.ok ? "✓" : "✗"} {check.title}
                </span>
                <span className="mt-0.5 block text-muted-foreground">{check.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsSection>

      <SettingsSection icon={<FileKey size={15} className="text-primary" />} title="浏览器内核密钥">
        <label className="field-label">
          <input
            className="field-input font-mono text-xs"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={licenseKeyDraft}
            onChange={(event) => setLicenseKeyDraft(event.target.value)}
            placeholder="cb_xxxxxxxx（从订阅邮件复制，空格可忽略）"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectivityIndicator status={keyStatus} />
          <button
            className="btn btn-primary"
            disabled={saving || keyStatus === "testing" || !normalizeCloakLicenseKey(licenseKeyDraft)}
            onClick={() => void handleSaveLicenseKey()}
          >
            <Zap size={14} className={keyStatus === "testing" ? "animate-pulse" : ""} />
            {keyStatus === "testing" ? "验证中..." : "保存并验证"}
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || keyStatus === "testing"}
            onClick={() => void handleImportKeyFile()}
            title="选择 CloakBrowser 下发的 .tsk Key 文件，解密后写入并在线校验"
          >
            <FileUp size={14} />
            导入 Key 文件
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || keyStatus === "testing"}
            onClick={() => void handleTestKeyFile()}
            title="只校验 .tsk 文件是否有效，不改变当前授权"
          >
            仅验证文件
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || !hasLicenseKey}
            onClick={() => void handleClearLicenseKey()}
          >
            <Trash2 size={14} />
            清除 License
          </button>
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {hasLicenseKey
            ? "已配置授权；可用 cb_ 密钥覆盖，或导入 .tsk 文件替换。"
            : "可粘贴邮件中的 cb_ 密钥，也可直接导入 CloakBrowser 下发的 .tsk Key 文件。"}
        </p>
      </SettingsSection>

      <SettingsSection icon={<Download size={15} className="text-primary" />} title="存储与下载">
        <label className="field-label">
          常规浏览器下载目录
          <div className="mt-1 flex gap-2">
            <input
              className="field-input font-mono text-xs flex-1"
              value={settings.browser_download_dir}
              onChange={(event) =>
                onSettingsChange({ ...settings, browser_download_dir: event.target.value })
              }
              placeholder="默认：应用数据/downloads/browser"
            />
            <button
              type="button"
              className="btn btn-outline shrink-0"
              disabled={saving}
              onClick={() => void handlePickDownloadDir("browser_download_dir")}
            >
              <FolderOpen size={14} />
              浏览
            </button>
          </div>
        </label>
        <label className="field-label">
          爬虫数据抓取目录
          <div className="mt-1 flex gap-2">
            <input
              className="field-input font-mono text-xs flex-1"
              value={settings.scraper_download_dir}
              onChange={(event) =>
                onSettingsChange({ ...settings, scraper_download_dir: event.target.value })
              }
              placeholder="默认：应用数据/downloads/scraper"
            />
            <button
              type="button"
              className="btn btn-outline shrink-0"
              disabled={saving}
              onClick={() => void handlePickDownloadDir("scraper_download_dir")}
            >
              <FolderOpen size={14} />
              浏览
            </button>
          </div>
        </label>
        <div className="mt-3 rounded-md bg-sunken p-3">
          <div className="text-ui font-medium text-foreground">缓存清理</div>
          <button
            type="button"
            className="btn btn-outline mt-2"
            disabled={saving || cacheBusy}
            onClick={() => void handlePurgeAutomationCache()}
          >
            <Trash2 size={14} className={cacheBusy ? "animate-pulse" : ""} />
            {cacheBusy ? "清理中…" : "清理缓存"}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<Plug size={15} className="text-primary" />}
        title="外部数据 API（Python / JSON）"
        description="把你程序里的数据传进来填表。只收「字段名 → 值」，不收命令、脚本或浏览器动作；默认关闭。"
      >
        <FlagToggle
          checked={dataApi?.enabled ?? false}
          disabled={dataApiBusy || !dataApi}
          onChange={(next) => void handleToggleDataApi(next)}
          label="启用外部数据 API"
          hint="仅监听本机回环地址（127.0.0.1 随机端口），局域网 / 外网不可达；需要下方令牌才能调用。"
        />
        {dataApi?.enabled ? (
          <div className="mt-3 space-y-3 rounded-md bg-sunken p-3">
            {!dataApi.running ? (
              <p className="text-[11px] leading-4 text-warning">
                设置已开启但服务未在监听（端口绑定失败或刚被改动）。关掉再打开一次可重建监听。
              </p>
            ) : null}
            <div>
              <div className="text-[11px] font-medium text-foreground">服务地址</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-surface-muted px-2 py-1 font-mono text-[11px] text-foreground">
                  {dataApi.baseUrl ?? "未在监听"}
                </code>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={!dataApi.baseUrl}
                  onClick={() => void handleCopy(dataApi.baseUrl ?? "", "服务地址已复制")}
                >
                  复制
                </button>
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-foreground">访问令牌</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-surface-muted px-2 py-1 font-mono text-[11px] text-foreground">
                  {dataApiTokenVisible
                    ? dataApi.token || "（未生成）"
                    : dataApi.token
                      ? "•".repeat(Math.min(24, dataApi.token.length))
                      : "（未生成）"}
                </code>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={!dataApi.token}
                  onClick={() => setDataApiTokenVisible((previous) => !previous)}
                >
                  {dataApiTokenVisible ? "隐藏" : "显示"}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={!dataApi.token}
                  onClick={() => void handleCopy(dataApi.token, "令牌已复制")}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={dataApiBusy}
                  onClick={() => void handleRegenerateDataApiToken()}
                >
                  重新生成
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-foreground">能力开关（各自独立、默认关）</div>
              <FlagToggle
                checked={dataApi.capabilities?.replay ?? false}
                disabled={dataApiBusy}
                onChange={(next) => void handleToggleDataApiCapability("replay", next)}
                label="回放接口（/v1/replay 族）"
                hint="允许外部程序先干跑出预检单、再按 planHash 触发记忆回放。仍走同一条回放链路与支付/凭证闸门，预检单不能用来预授权支付。"
              />
              <FlagToggle
                checked={dataApi.capabilities?.clipboard ?? false}
                disabled={dataApiBusy}
                onChange={(next) => void handleToggleDataApiCapability("clipboard", next)}
                label="剪贴板读取（/v1/clipboard）"
                hint="允许读取本机系统剪贴板内容作为回放数据源。内容不入日志、不入台账；判定为一次性凭证时默认拒绝自动填入。"
              />
            </div>
            <div className="space-y-1 text-[11px] leading-4 text-muted-foreground">
              <p>
                接口：<code>GET /v1/health</code>（探活，免令牌）、<code>GET /v1/meta</code>
                （环境列表与限额）、
                <code>POST /v1/fill</code>（传数据填表）；开启回放能力后另有
                <code>POST /v1/replay/plan</code>（干跑预检单）、<code>POST /v1/replay</code>（按 planHash
                执行）、
                <code>GET /v1/replay/&#123;jobId&#125;</code>（进度）、
                <code>POST /v1/replay/&#123;jobId&#125;/cancel</code>（取消）。
              </p>
              <p>
                单次最多 {dataApi.limits?.maxFields ?? 64} 个字段、单值{" "}
                {dataApi.limits?.maxValueChars ?? 4096} 字符；
                目标环境必须处于运行中。支付/证件/密钥类字段与邮箱·短信·验证器一次性凭证字段会被整套拒绝。
              </p>
              <p>
                详细对接方式（含 Python 示例）见仓库文档 <code>{dataApi.docsPath}</code>。
              </p>
            </div>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        icon={<SlidersHorizontal size={15} className="text-primary" />}
        title="高级 · 兼容与调试"
        description="按需旗标；默认全部关闭，仅在特定场景临时开启，保存后对新建环境生效。"
      >
        <FlagToggle
          checked={settings.license_through_proxy}
          onChange={(next) => onSettingsChange({ ...settings, license_through_proxy: next })}
          label="授权检查走代理"
          hint="企业网 / 受限网络直连授权服务器失败导致环境启动几秒后秒退时开启"
        />
        <FlagToggle
          checked={settings.allow_third_party_cookies}
          onChange={(next) => onSettingsChange({ ...settings, allow_third_party_cookies: next })}
          label="允许第三方 Cookie"
          hint="登录 / 支付 / reCAPTCHA v3 / SSO 等嵌入式验证一直无法完成时按需开启"
        />
        <FlagToggle
          checked={settings.fingerprint_off}
          onChange={(next) => {
            void (async () => {
              if (next && !settings.fingerprint_off) {
                const ok = await confirm({
                  title: "极度危险：关闭全部指纹伪装",
                  description:
                    "暴露本机真实硬件指纹与 IP / WebRTC 出口，极易导致账号风控与封禁。仅限本地调试，生产多开环境严禁开启。",
                  confirmLabel: "我已知晓风险，仍要开启",
                  cancelLabel: "取消，保持伪装",
                  tone: "danger",
                });
                if (!ok) {
                  return;
                }
              }
              onSettingsChange({ ...settings, fingerprint_off: next });
            })();
          }}
          label="关闭指纹伪装（Windows 调试）"
          hint="开启后环境列表将高亮「危险：指纹已关闭」。诊断网站异常时临时关闭 spoofing；用完请立即关闭并保存。"
        />
      </SettingsSection>

      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
          保存常规设置
        </button>
      </div>
    </div>
  );
}
