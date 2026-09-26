import { useEffect, useMemo, useRef, useState } from "react";

import {
  batchCreateProfiles,
  fetchProxies,
  fetchSettings,
  formatInvokeError,
  listLocalKernels,
  proxyLabel,
} from "../lib/tauri";
import { pickRecommendedLocalKernel } from "../lib/kernelPolicy";
import type { LocalKernel, Proxy, ProxyStrategy, StealthPreset, WebglMode } from "../types";
import { STEALTH_PRESET_OPTIONS, THEME_COLORS, WEBGL_MODE_OPTIONS } from "../types";
import { KernelVersionSelect } from "./KernelVersionSelect";
import { Modal } from "./Modal";
import { serializeStartupUrls, StartupUrlsEditor } from "./StartupUrlsEditor";

interface BatchCreateModalProps {
  open: boolean;
  /** 当前 License 是否 Pro；用于批量新建时按档位自动推荐本机内核 */
  isProLicense?: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

export function BatchCreateModal({
  open,
  isProLicense = false,
  onClose,
  onSuccess,
  onError,
}: BatchCreateModalProps) {
  const [prefix, setPrefix] = useState("Profile");
  const [count, setCount] = useState(5);
  const [themeColor, setThemeColor] = useState<string>(THEME_COLORS[0]);
  const [proxyStrategy, setProxyStrategy] = useState<ProxyStrategy>("none");
  const [proxyId, setProxyId] = useState<string>("");
  const [sequentialHost, setSequentialHost] = useState("127.0.0.1");
  const [sequentialStartPort, setSequentialStartPort] = useState(5500);
  const [sequentialProxyType, setSequentialProxyType] = useState<"HTTP" | "SOCKS5">("HTTP");
  const [webglMode, setWebglMode] = useState<WebglMode>("local");
  const [stealthPreset, setStealthPreset] = useState<StealthPreset>("default");
  const [startupUrls, setStartupUrls] = useState<string[]>([]);
  const [browserVersion, setBrowserVersion] = useState("");
  const [settingsDefaultVersion, setSettingsDefaultVersion] = useState("");
  const [localKernels, setLocalKernels] = useState<LocalKernel[]>([]);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [saving, setSaving] = useState(false);
  /** 用户是否手动改过内核下拉；改过就不再被自动推荐覆盖 */
  const kernelTouchedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    kernelTouchedRef.current = false;
    setBrowserVersion("");
    setSettingsDefaultVersion("");
    void fetchProxies()
      .then(setProxies)
      .catch((error) => onError(formatInvokeError(error)));
    void listLocalKernels()
      .then(setLocalKernels)
      .catch(() => setLocalKernels([]));
    void fetchSettings()
      .then((settings) => {
        const def = (settings.default_browser_version ?? "").trim();
        if (/^\d+(?:\.\d+){3,4}$/.test(def) || def === "") {
          setSettingsDefaultVersion(def);
        }
      })
      .catch(() => undefined);
  }, [open, onError]);

  /**
   * 批量新建：按 License 档位自动推荐本机已有的内核。
   * Pro → 本机最新内核；免费 → 本机最新免费核（付费核会被 AI 闸门拦下）。
   * 本机没有可用内核时回落到设置里的默认版本（可为空 = 自动，联网取最新）。
   * 用户手动改过下拉后不再覆盖。
   */
  useEffect(() => {
    if (!open || kernelTouchedRef.current) {
      return;
    }
    const recommended = pickRecommendedLocalKernel(isProLicense, localKernels);
    setBrowserVersion(recommended ? recommended.version : settingsDefaultVersion);
  }, [open, isProLicense, localKernels, settingsDefaultVersion]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setStartupUrls([]);
  }, [open]);

  const sequentialPreview = useMemo(() => {
    if (proxyStrategy !== "sequential_ports") {
      return [];
    }
    return Array.from({ length: Math.min(count, 5) }, (_, index) => {
      const port = sequentialStartPort + index;
      return `${sequentialHost}:${port}`;
    });
  }, [proxyStrategy, count, sequentialHost, sequentialStartPort]);

  const handleSubmit = async () => {
    if (!prefix.trim()) {
      onError("前缀名不能为空");
      return;
    }
    if (!Number.isFinite(count) || count < 1 || count > 100) {
      onError("生成数量必须是 1-100 之间的整数");
      return;
    }
    if (proxyStrategy === "pool_shared" && !proxyId) {
      onError("共享代理策略需要选择一个代理池条目");
      return;
    }
    if (
      proxyStrategy === "sequential_ports" &&
      (!Number.isFinite(sequentialStartPort) || sequentialStartPort <= 0 || sequentialStartPort > 65535)
    ) {
      onError("起始端口必须是 1-65535 之间的整数");
      return;
    }

    setSaving(true);
    try {
      await batchCreateProfiles({
        prefix: prefix.trim(),
        count,
        theme_color: themeColor,
        proxy_strategy: proxyStrategy,
        proxy_id: proxyStrategy === "pool_shared" && proxyId ? Number(proxyId) : null,
        sequential_host: proxyStrategy === "sequential_ports" ? sequentialHost.trim() : undefined,
        sequential_start_port: proxyStrategy === "sequential_ports" ? sequentialStartPort : undefined,
        sequential_proxy_type: proxyStrategy === "sequential_ports" ? sequentialProxyType : undefined,
        webgl_mode: webglMode,
        stealth_preset: stealthPreset,
        startup_urls: serializeStartupUrls(startupUrls),
        browser_version: browserVersion.trim() || undefined,
      });
      onError("");
      onSuccess();
      onClose();
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setSaving(false);
    }
  };

  // 按 License 档位自动推荐的本机内核（用于显示「已自动选择」说明）。
  const recommendedKernel = pickRecommendedLocalKernel(isProLicense, localKernels);
  const showingRecommended = Boolean(
    recommendedKernel && browserVersion.trim() === recommendedKernel.version,
  );

  return (
    <Modal
      open={open}
      title="批量新建"
      description="前缀 + 序号一次建多个；本批共用开页与代理设置"
      onClose={onClose}
      widthClass="max-w-4xl"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="field-label">
              名称前缀
              <input
                className="field-input"
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="TikTok_US"
              />
            </label>
            <label className="field-label">
              数量（1–100）
              <input
                className="field-input"
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) {
                    setCount(Math.trunc(next));
                  }
                }}
              />
            </label>
          </div>

          <div className="space-y-2">
            <span className="field-label">列表色标</span>
            <div className="flex flex-wrap gap-2">
              {THEME_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`h-8 w-8 rounded-full border-2 transition-transform ${
                    themeColor === color ? "scale-110 border-foreground" : "border-transparent"
                  }`}
                  style={{ backgroundColor: color }}
                  onClick={() => setThemeColor(color)}
                  aria-label={`选择主题色 ${color}`}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <span className="field-label">WebGL 指纹</span>
            <div className="segmented">
              {WEBGL_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`segmented-item ${webglMode === option.value ? "segmented-item-active" : ""}`}
                  onClick={() => setWebglMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {WEBGL_MODE_OPTIONS.find((option) => option.value === webglMode)?.hint}
            </p>
          </div>

          <KernelVersionSelect
            value={browserVersion}
            showFreeKeyHint={!isProLicense}
            onChange={(next) => {
              kernelTouchedRef.current = true;
              setBrowserVersion(next);
            }}
            localKernels={localKernels}
          />
          {showingRecommended ? (
            <p className="-mt-1 text-[11px] leading-4 text-muted-foreground">
              已按 {isProLicense ? "Pro" : "免费"} License 自动选择本机已有内核
              {isProLicense ? "（最新）" : "（免费核）"}；可手动更改。
            </p>
          ) : null}

          <label className="field-label">
            防护预设
            <select
              className="field-input"
              value={stealthPreset}
              onChange={(event) => setStealthPreset(event.target.value as StealthPreset)}
            >
              {STEALTH_PRESET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="-mt-2 text-[11px] text-muted-foreground">
            {STEALTH_PRESET_OPTIONS.find((option) => option.value === stealthPreset)?.hint}
          </p>
        </div>

        <div className="space-y-4">
          <StartupUrlsEditor urls={startupUrls} onChange={setStartupUrls} disabled={saving} />

          <div className="space-y-2">
            <span className="field-label">代理分配策略</span>
            <div className="segmented flex-wrap sm:flex-nowrap">
              {(
                [
                  ["none", "不使用代理"],
                  ["pool_random", "代理池 · 随机"],
                  ["pool_shared", "代理池 · 共用"],
                  ["sequential_ports", "本机端口递增"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`segmented-item ${proxyStrategy === id ? "segmented-item-active" : ""}`}
                  onClick={() => setProxyStrategy(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {proxyStrategy === "pool_shared" || proxyStrategy === "pool_random" ? (
            <label className="field-label">
              {proxyStrategy === "pool_random" ? "随机来源代理池" : "共享代理"}
              <select
                className="field-input"
                value={proxyId}
                onChange={(event) => setProxyId(event.target.value)}
              >
                <option value="">
                  {proxyStrategy === "pool_random" ? "从全部静态代理中随机" : "请选择代理"}
                </option>
                {proxies
                  .filter((proxy) => proxy.type !== "DYNAMIC_API")
                  .map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      #{proxy.id} · {proxyLabel(proxy)}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}

          {proxyStrategy === "sequential_ports" ? (
            <div className="grid grid-cols-2 gap-3 rounded-md bg-surface-muted p-3">
              <label className="field-label col-span-2">
                代理协议
                <select
                  className="field-input"
                  value={sequentialProxyType}
                  onChange={(event) => setSequentialProxyType(event.target.value as "HTTP" | "SOCKS5")}
                >
                  <option value="HTTP">HTTP</option>
                  <option value="SOCKS5">SOCKS5</option>
                </select>
              </label>
              <label className="field-label">
                主机 IP
                <input
                  className="field-input"
                  value={sequentialHost}
                  onChange={(event) => setSequentialHost(event.target.value)}
                />
              </label>
              <label className="field-label">
                起始端口
                <input
                  className="field-input"
                  type="number"
                  value={sequentialStartPort}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) {
                      setSequentialStartPort(Math.trunc(next));
                    }
                  }}
                />
              </label>
              <p className="col-span-2 text-[11px] text-muted-foreground">
                预览 · {sequentialPreview.join(" · ")}
                {count > 5 ? ` … 共 ${count} 个` : ""}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2 pt-4">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving}
          onClick={() => void handleSubmit()}
        >
          批量创建
        </button>
      </div>
    </Modal>
  );
}
