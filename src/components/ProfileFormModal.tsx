import { ChevronDown, Dices, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  formatProxyForTest,
  formatProxyLine,
  parseProxyString,
  parseStoredCustomProxy,
  type ParsedProxy,
} from "../lib/proxy";
import {
  createProfile,
  fetchProxies,
  fetchSettings,
  formatInvokeError,
  listLocalKernels,
  proxyLabel,
  testProxyConnection,
  updateProfile,
} from "../lib/tauri";
import type { LocalKernel, Profile, ProfileProxyMode, Proxy, StealthPreset, WebglMode } from "../types";
import { randomFingerprintSeed, STEALTH_PRESET_OPTIONS, THEME_COLORS, WEBGL_MODE_OPTIONS } from "../types";
import { pickRecommendedLocalKernel } from "../lib/kernelPolicy";
import { KernelVersionSelect } from "./KernelVersionSelect";
import { Modal } from "./Modal";
import { parseStartupUrlsJson, serializeStartupUrls, StartupUrlsEditor } from "./StartupUrlsEditor";

interface ProfileFormModalProps {
  open: boolean;
  mode: "create" | "edit";
  profile?: Profile | null;
  /** 当前 License 是否 Pro；用于新建时按档位自动推荐本机内核 */
  isProLicense?: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

export function ProfileFormModal({
  open,
  mode,
  profile,
  isProLicense = false,
  onClose,
  onSuccess,
  onError,
}: ProfileFormModalProps) {
  const [name, setName] = useState("");
  const [themeColor, setThemeColor] = useState<string>(THEME_COLORS[0]);
  const [proxyMode, setProxyMode] = useState<ProfileProxyMode>("none");
  const [proxyId, setProxyId] = useState<string>("");
  const [customProxyInput, setCustomProxyInput] = useState("");
  const [parsedCustomProxy, setParsedCustomProxy] = useState<ParsedProxy | null>(null);
  const [proxyTested, setProxyTested] = useState(false);
  const [testingProxy, setTestingProxy] = useState(false);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fingerprintSeed, setFingerprintSeed] = useState(() => randomFingerprintSeed());
  const [stealthPreset, setStealthPreset] = useState<StealthPreset>("default");
  const [webglMode, setWebglMode] = useState<WebglMode>("local");
  const [browserVersion, setBrowserVersion] = useState("");
  const [settingsDefaultVersion, setSettingsDefaultVersion] = useState("");
  const [startupUrls, setStartupUrls] = useState<string[]>([]);
  const [localKernels, setLocalKernels] = useState<LocalKernel[]>([]);
  /** 用户是否手动改过内核下拉；改过就不再被自动推荐覆盖 */
  const kernelTouchedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    void fetchProxies()
      .then(setProxies)
      .catch((error) => onError(formatInvokeError(error)));
    void listLocalKernels()
      .then(setLocalKernels)
      .catch(() => setLocalKernels([]));
  }, [open, onError]);

  useEffect(() => {
    if (!open) {
      return;
    }
    kernelTouchedRef.current = false;
    if (mode === "edit" && profile) {
      setName(profile.name);
      setThemeColor(profile.theme_color || THEME_COLORS[0]);
      if (profile.custom_proxy?.trim()) {
        const parsed = parseStoredCustomProxy(profile.custom_proxy);
        setProxyMode("custom");
        setParsedCustomProxy(parsed);
        setCustomProxyInput(parsed ? formatProxyLine(parsed) : profile.custom_proxy);
        setProxyId("");
      } else if (profile.proxy_id != null) {
        setProxyMode("pool");
        setProxyId(String(profile.proxy_id));
        setCustomProxyInput("");
        setParsedCustomProxy(null);
      } else {
        setProxyMode("none");
        setProxyId("");
        setCustomProxyInput("");
        setParsedCustomProxy(null);
      }
      setProxyTested(true);
      setFingerprintSeed(profile.fingerprint_seed || randomFingerprintSeed());
      setStealthPreset(profile.stealth_preset ?? "default");
      setWebglMode(profile.webgl_mode ?? "local");
      setBrowserVersion(
        /^\d+(?:\.\d+){3,4}$/.test((profile.browser_version ?? "").trim())
          ? (profile.browser_version ?? "").trim()
          : "",
      );
      setStartupUrls(parseStartupUrlsJson(profile.startup_urls));
      setAdvancedOpen(true);
    } else {
      setName("");
      setThemeColor(THEME_COLORS[0]);
      setProxyMode("none");
      setProxyId("");
      setCustomProxyInput("");
      setParsedCustomProxy(null);
      setProxyTested(false);
      setFingerprintSeed(randomFingerprintSeed());
      setStealthPreset("default");
      setWebglMode("local");
      setBrowserVersion("");
      setSettingsDefaultVersion("");
      setStartupUrls([]);
      setAdvancedOpen(false);
      void fetchSettings()
        .then((settings) => {
          const def = (settings.default_browser_version ?? "").trim();
          if (/^\d+(?:\.\d+){3,4}$/.test(def) || def === "") {
            setSettingsDefaultVersion(def);
          }
        })
        .catch(() => undefined);
    }
  }, [open, mode, profile]);

  /**
   * 新建窗口：按 License 档位自动推荐本机已有的内核。
   * Pro → 本机最新内核；免费 → 本机最新免费核（付费核会被 AI 闸门拦下）。
   * 本机没有可用内核时回落到设置里的默认版本（可为空 = 自动，联网取最新）。
   * 用户手动改过下拉后不再覆盖。
   */
  useEffect(() => {
    if (!open || mode !== "create" || kernelTouchedRef.current) {
      return;
    }
    const recommended = pickRecommendedLocalKernel(isProLicense, localKernels);
    setBrowserVersion(recommended ? recommended.version : settingsDefaultVersion);
  }, [open, mode, isProLicense, localKernels, settingsDefaultVersion]);

  const syncParsedProxy = (raw: string): ParsedProxy | null => {
    const parsed = parseProxyString(raw);
    setParsedCustomProxy(parsed);
    setProxyTested(false);
    return parsed;
  };

  const handleCustomProxyChange = (value: string) => {
    setCustomProxyInput(value);
    setParsedCustomProxy(null);
    setProxyTested(false);
  };

  const handleCustomProxyBlur = () => {
    if (!customProxyInput.trim()) {
      setParsedCustomProxy(null);
      return;
    }
    syncParsedProxy(customProxyInput);
  };

  const handleTestProxy = async () => {
    const parsed = parsedCustomProxy ?? syncParsedProxy(customProxyInput);
    if (!parsed) {
      onError("代理格式无效，请使用 host:port 或 host:port:user:pass");
      return;
    }
    setTestingProxy(true);
    try {
      await testProxyConnection(formatProxyForTest(parsed));
      setProxyTested(true);
      onError("");
    } catch (error) {
      setProxyTested(false);
      onError(formatInvokeError(error));
    } finally {
      setTestingProxy(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      onError("环境名称不能为空");
      return;
    }

    const seed = fingerprintSeed.trim();
    if (!/^\d{5}$/.test(seed) || Number(seed) < 10000 || Number(seed) > 99999) {
      onError("指纹种子必须是 10000-99999 之间的数字");
      return;
    }

    let customProxyPayload: string | null = null;
    if (proxyMode === "custom") {
      const parsed = parsedCustomProxy ?? parseProxyString(customProxyInput);
      if (!parsed) {
        onError("代理格式无效，请使用 host:port 或 host:port:user:pass");
        return;
      }
      if (!proxyTested) {
        onError("请先测试自定义代理连通性后再保存");
        return;
      }
      customProxyPayload = formatProxyLine(parsed);
    }

    const version = browserVersion.trim();
    if (version && !/^\d+(?:\.\d+){3,4}$/.test(version)) {
      onError("Chromium 版本 Pin 须为完整 4~5 段数字，例如 146.0.7680.177.5（留空=最新版）");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        theme_color: themeColor,
        proxy_id: proxyMode === "pool" && proxyId ? Number(proxyId) : null,
        custom_proxy: customProxyPayload,
        use_geoip: true,
        humanize: true,
        fingerprint_seed: seed,
        stealth_preset: stealthPreset,
        webgl_mode: webglMode,
        browser_version: version,
        startup_urls: serializeStartupUrls(startupUrls),
      };

      if (mode === "edit" && profile) {
        await updateProfile({ id: profile.id, ...payload });
      } else {
        await createProfile(payload);
      }
      onError("");
      onSuccess();
      onClose();
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setSaving(false);
    }
  };

  // 新建时按 License 档位自动推荐的本机内核（用于显示「已自动选择」说明）。
  const recommendedKernel = mode === "create" ? pickRecommendedLocalKernel(isProLicense, localKernels) : null;
  const showingRecommended = Boolean(
    recommendedKernel && browserVersion.trim() === recommendedKernel.version,
  );

  return (
    <Modal
      open={open}
      title={mode === "edit" ? "编辑环境" : "新建环境"}
      description="代理、指纹与启动页"
      onClose={onClose}
      widthClass="max-w-4xl"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <label className="field-label">
            环境名称
            <input
              className="field-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="TikTok_US_01"
            />
          </label>

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
            <span className="field-label">绑定代理</span>
            <div className="segmented">
              {(
                [
                  ["none", "不使用"],
                  ["pool", "代理池"],
                  ["custom", "自定义"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`segmented-item ${proxyMode === id ? "segmented-item-active" : ""}`}
                  onClick={() => {
                    setProxyMode(id);
                    setProxyTested(id !== "custom");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {proxyMode === "pool" ? (
              <select
                className="field-input"
                value={proxyId}
                onChange={(event) => setProxyId(event.target.value)}
              >
                <option value="">请选择代理池条目</option>
                {proxies.map((proxy) => (
                  <option key={proxy.id} value={proxy.id}>
                    #{proxy.id} · {proxyLabel(proxy)}
                  </option>
                ))}
              </select>
            ) : null}

            {proxyMode === "custom" ? (
              <div className="space-y-2">
                <input
                  className="field-input font-mono text-caption"
                  value={customProxyInput}
                  onChange={(event) => handleCustomProxyChange(event.target.value)}
                  onBlur={handleCustomProxyBlur}
                  placeholder="例如: us.novproxy.io:1000:user:pass"
                />
                {parsedCustomProxy ? (
                  <p className="text-[11px] text-muted-foreground">
                    已解析 → {parsedCustomProxy.type} {parsedCustomProxy.host}:{parsedCustomProxy.port}
                    {parsedCustomProxy.username ? ` (${parsedCustomProxy.username})` : ""}
                  </p>
                ) : customProxyInput.trim() ? (
                  <p className="text-[11px] text-destructive">格式无法识别</p>
                ) : null}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={testingProxy || !customProxyInput.trim()}
                    onClick={() => void handleTestProxy()}
                  >
                    <Zap size={14} className={testingProxy ? "animate-pulse" : ""} />
                    {testingProxy ? "测试中…" : "测试代理"}
                  </button>
                  <span className="text-[11px] text-muted-foreground">
                    {proxyTested ? "已通过连通性测试" : "保存前必须测试通过"}
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          <StartupUrlsEditor urls={startupUrls} onChange={setStartupUrls} disabled={saving} />
        </div>

        <div className="space-y-4">
          <div className="rounded-md bg-surface-muted px-3 py-3">
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
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                已按 {isProLicense ? "Pro" : "免费"} License 自动选择本机已有内核
                {isProLicense ? "（最新）" : "（免费核）"}；可手动更改。
              </p>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-md bg-surface-muted">
            <button
              type="button"
              className="row-selectable flex w-full items-center justify-between px-3 py-2.5 text-left text-ui font-medium transition-colors"
              onClick={() => setAdvancedOpen((current) => !current)}
            >
              <span>高级指纹与行为设置</span>
              <ChevronDown size={16} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
            </button>
            {advancedOpen ? (
              <div className="space-y-4 px-3 py-3">
                <div className="space-y-2">
                  <label className="field-label">
                    指纹种子 (Seed)
                    <div className="flex gap-2">
                      <input
                        className="field-input font-mono text-caption"
                        value={fingerprintSeed}
                        onChange={(event) =>
                          setFingerprintSeed(event.target.value.replace(/\D/g, "").slice(0, 5))
                        }
                        placeholder="10000-99999"
                      />
                      <button
                        type="button"
                        className="btn btn-outline shrink-0 px-3"
                        onClick={() => setFingerprintSeed(randomFingerprintSeed())}
                        title="随机生成"
                      >
                        <Dices size={14} />
                        随机生成
                      </button>
                    </div>
                  </label>
                </div>

                <p className="rounded-md bg-surface-muted px-3 py-2 text-[11px] leading-4 text-muted-foreground">
                  GeoIP 时区同步与拟人化输入已由启动器强制开启（geoip /
                  humanize），不可关闭，避免时区泄漏与自动化痕迹。
                </p>

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
                <p className="text-[11px] text-muted-foreground">
                  {STEALTH_PRESET_OPTIONS.find((option) => option.value === stealthPreset)?.hint}
                </p>

                <div className="space-y-2">
                  <span className="field-label">WebGL 指纹</span>
                  <div className="segmented">
                    {WEBGL_MODE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`segmented-item ${
                          webglMode === option.value ? "segmented-item-active" : ""
                        }`}
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
              </div>
            ) : (
              <p className=" px-3 py-2 text-[11px] text-muted-foreground">
                展开配置指纹种子、防护预设与 WebGL
              </p>
            )}
          </div>
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
          {mode === "edit" ? "保存修改" : "创建环境"}
        </button>
      </div>
    </Modal>
  );
}
