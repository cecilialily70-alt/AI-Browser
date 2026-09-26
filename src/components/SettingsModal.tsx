import { Bot, KeyRound, SlidersHorizontal, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchProxies, fetchSettings, formatInvokeError } from "../lib/tauri";
import type { AppSettings, ConnectivityStatus, Proxy } from "../types";
import { Modal } from "./Modal";
import { AiSettingsTab } from "./settings/AiSettingsTab";
import { CaptchaOtpSettingsTab } from "./settings/CaptchaOtpSettingsTab";
import { GeneralSettingsTab } from "./settings/GeneralSettingsTab";
import { ProxyPoolTab } from "./settings/ProxyPoolTab";
import type { ToastMessage } from "../lib/toast";

type SettingsTab = "ai" | "captcha_otp" | "general" | "proxies";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  onToast: (message: ToastMessage) => void;
  onEntitlementChange: () => void;
}

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Bot; hint: string }> = [
  { id: "ai", label: "AI", icon: Bot, hint: "模型与接口" },
  { id: "captcha_otp", label: "验证码与邮箱", icon: KeyRound, hint: "邮箱·短信·图形码" },
  { id: "general", label: "浏览器", icon: SlidersHorizontal, hint: "内核与下载" },
  { id: "proxies", label: "代理", icon: Server, hint: "代理列表" },
];

export function SettingsModal({ open, onClose, onError, onToast, onEntitlementChange }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("ai");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<ConnectivityStatus>("idle");
  const [keyStatus, setKeyStatus] = useState<ConnectivityStatus>("idle");
  const onErrorRef = useRef(onError);
  const aiFlushSaveRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [nextSettings, nextProxies] = await Promise.all([fetchSettings(), fetchProxies()]);
      setSettings(nextSettings);
      setProxies(nextProxies);
      setLoadError(null);
      onErrorRef.current("");
    } catch (error) {
      // 失败必须显式暴露：settings 仍为 null，而 null 同时是「加载中」的渲染依据，
      // 只挂 onError 横幅会让面板永久停在「加载设置中...」且没有任何重试入口
      const message = formatInvokeError(error);
      setLoadError(message);
      onErrorRef.current(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setAiStatus("idle");
      setKeyStatus("idle");
      void load();
    }
  }, [open, load]);

  const handleDone = async () => {
    try {
      if (aiFlushSaveRef.current) {
        await aiFlushSaveRef.current();
      }
    } catch {
      // 错误已在子组件 toast；仍允许关闭以免卡死
    }
    onClose();
  };

  return (
    <Modal open={open} title="设置" onClose={() => void handleDone()} widthClass="max-w-4xl">
      <div className="segmented mb-4">
        {TABS.map(({ id, label, icon: Icon, hint }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              title={hint}
              className={`segmented-item sm:justify-start sm:px-3 ${active ? "segmented-item-active" : ""}`}
              onClick={() => setTab(id)}
            >
              <Icon size={14} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {!settings ? (
          loadError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="text-ui text-destructive">设置加载失败 · {loadError}</p>
              <button
                type="button"
                className="btn btn-outline h-7 px-3 text-caption"
                disabled={loading}
                onClick={() => void load()}
              >
                {loading ? "重试中…" : "重试"}
              </button>
            </div>
          ) : (
            <div className="py-8 text-center text-ui text-muted-foreground">加载设置中…</div>
          )
        ) : tab === "ai" ? (
          <AiSettingsTab
            settings={settings}
            aiStatus={aiStatus}
            saving={saving}
            onSettingsChange={setSettings}
            onAiStatusChange={setAiStatus}
            onSavingChange={setSaving}
            onToast={onToast}
            onError={onError}
            registerFlushSave={(flush) => {
              aiFlushSaveRef.current = flush;
            }}
          />
        ) : tab === "captcha_otp" ? (
          <CaptchaOtpSettingsTab
            settings={settings}
            saving={saving}
            onSettingsChange={setSettings}
            onSavingChange={setSaving}
            onToast={onToast}
            onError={onError}
          />
        ) : tab === "general" ? (
          <GeneralSettingsTab
            settings={settings}
            keyStatus={keyStatus}
            saving={saving}
            onSettingsChange={setSettings}
            onKeyStatusChange={setKeyStatus}
            onSavingChange={setSaving}
            onToast={onToast}
            onError={onError}
            onEntitlementChange={onEntitlementChange}
          />
        ) : (
          <ProxyPoolTab proxies={proxies} onReload={load} onToast={onToast} onError={onError} />
        )}
      </div>

      <div className="mt-5 flex justify-end pt-4">
        <button
          type="button"
          className="btn btn-primary"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleDone();
          }}
        >
          完成
        </button>
      </div>
    </Modal>
  );
}
