import { KeyRound, Mail, Shield, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  deleteSecretRef,
  fetchProfiles,
  formatInvokeError,
  putSecretRef,
  secretRefExists,
  setProfileOtpChannel,
  testOtpChannel,
  updateSetting,
} from "../../lib/tauri";
import { createToast } from "../../lib/toast";
import type { ToastMessage } from "../../lib/toast";
import type {
  AppSettings,
  CaptchaServiceConfig,
  ConnectivityStatus,
  OtpChannelConfig,
  OtpChannelType,
  Profile,
  SmsOtpServiceConfig,
} from "../../types";
import {
  captchaApiKeyRefId,
  otpSecretRefId,
  parseCaptchaServiceConfig,
  parseOtpChannelConfig,
  parseSmsOtpServiceConfig,
  serializeCaptchaServiceConfig,
  serializeOtpChannelConfig,
  serializeSmsOtpServiceConfig,
  smsOtpApiKeyRefId,
} from "../../types";
import { ConnectivityIndicator } from "./ConnectivityIndicator";
import { SettingsSection } from "./SettingsSection";

type BindScope = "global" | "profile";

interface CaptchaOtpSettingsTabProps {
  settings: AppSettings;
  saving: boolean;
  onSettingsChange: (next: AppSettings) => void;
  onSavingChange: (saving: boolean) => void;
  onToast: (toast: ToastMessage) => void;
  onError: (message: string) => void;
}

const BUILTIN_CAPTCHA_HINTS = [
  { id: "image_text_read", label: "图形文字码", detail: "本地 OCR / 识图" },
  { id: "slider_gap_drag", label: "滑块缺口", detail: "本地视觉定位拖拽" },
  { id: "point_select_click", label: "点选验证", detail: "本地点选求解" },
  { id: "math_image_solve", label: "算式图", detail: "本地识别计算" },
  { id: "press_hold_captcha", label: "长按按钮", detail: "按住不放 / 无障碍重试" },
] as const;

/** P5.2：与 sidecar/config/tempmail_providers.json 对齐 */
const TEMPMAIL_PROVIDER_OPTIONS = [
  {
    id: "mailslurp",
    label: "MailSlurp",
    requiresApiKey: true,
    inboxHint: "收件箱 UUID 或邮箱地址",
  },
  {
    id: "1secmail",
    label: "1secmail",
    requiresApiKey: false,
    inboxHint: "完整收件地址（如 name@1secmail.com）",
  },
] as const;

const TEMPMAIL_NO_KEY_PLACEHOLDER = "-";

/** P5.3：与 sidecar/config/sms_providers.json 对齐 */
const SMS_PROVIDER_OPTIONS = [
  { id: "sms-activate", label: "SMS-Activate" },
  { id: "five_sim", label: "5sim" },
] as const;

/** P5.6：与 sidecar/config/webmail_providers.json 对齐；默认不选中 */
const WEBMAIL_PROVIDER_OPTIONS = [
  { id: "gmail", label: "Gmail" },
  { id: "qq", label: "QQ 邮箱" },
  { id: "outlook", label: "Outlook" },
] as const;

export function CaptchaOtpSettingsTab({
  settings,
  saving,
  onSettingsChange,
  onSavingChange,
  onToast,
  onError,
}: CaptchaOtpSettingsTabProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [scope, setScope] = useState<BindScope>("global");
  const [profileId, setProfileId] = useState<string>("");
  const [channelType, setChannelType] = useState<OtpChannelType>("none");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapUser, setImapUser] = useState("");
  const [imapFolder, setImapFolder] = useState("INBOX");
  const [imapTls, setImapTls] = useState(true);
  const [tempProviderId, setTempProviderId] = useState<string>("mailslurp");
  const [tempInbox, setTempInbox] = useState("");
  const [draftSecret, setDraftSecret] = useState("");
  const [secretSaved, setSecretSaved] = useState(false);
  const [otpStatus, setOtpStatus] = useState<ConnectivityStatus>("idle");
  const [otpFeedback, setOtpFeedback] = useState("");

  const [captchaEnabled, setCaptchaEnabled] = useState(false);
  const [captchaProviderId, setCaptchaProviderId] = useState("");
  const [captchaDraftKey, setCaptchaDraftKey] = useState("");
  const [captchaKeySaved, setCaptchaKeySaved] = useState(false);

  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsProviderId, setSmsProviderId] = useState<string>("sms-activate");
  const [smsActivationId, setSmsActivationId] = useState("");
  const [smsDraftKey, setSmsDraftKey] = useState("");
  const [smsKeySaved, setSmsKeySaved] = useState(false);
  const [webmailProviderId, setWebmailProviderId] = useState<string>("gmail");
  const [webmailOptIn, setWebmailOptIn] = useState(false);

  const tempProviderMeta = useMemo(
    () =>
      TEMPMAIL_PROVIDER_OPTIONS.find((item) => item.id === tempProviderId) ?? TEMPMAIL_PROVIDER_OPTIONS[0],
    [tempProviderId],
  );
  const activeSecretRef = useMemo(() => {
    if (channelType === "none" || channelType === "webmail_adapter") return "";
    const scopeKey = scope === "global" ? "global" : Number(profileId);
    if (scope === "profile" && (!profileId || !Number.isFinite(scopeKey))) return "";
    const kind = channelType === "imap" ? "imap" : "tempmail";
    return otpSecretRefId(scope === "global" ? "global" : Number(profileId), kind);
  }, [channelType, scope, profileId]);

  const loadChannelIntoForm = (raw: string) => {
    const channel = parseOtpChannelConfig(raw);
    setChannelType(channel.type);
    setDraftSecret("");
    setOtpStatus("idle");
    setOtpFeedback("");
    setWebmailOptIn(false);
    if (channel.type === "imap") {
      setImapHost(channel.host);
      setImapPort(String(channel.port || 993));
      setImapUser(channel.user);
      setImapFolder(channel.folder || "INBOX");
      setImapTls(channel.tls !== false);
    } else if (channel.type === "tempmail_provider") {
      const known = TEMPMAIL_PROVIDER_OPTIONS.some((item) => item.id === channel.providerId);
      setTempProviderId(known ? channel.providerId : channel.providerId || "mailslurp");
      setTempInbox(channel.inboxAddress || "");
    } else if (channel.type === "webmail_adapter") {
      setWebmailProviderId(channel.providerId);
      setWebmailOptIn(true);
    }
  };

  const refreshSecretFlag = async (refId: string) => {
    if (!refId) {
      setSecretSaved(false);
      return;
    }
    try {
      setSecretSaved(await secretRefExists(refId));
    } catch {
      setSecretSaved(false);
    }
  };

  useEffect(() => {
    void fetchProfiles()
      .then((list) => {
        setProfiles(list);
        setProfileId((current) => {
          if (current || list.length === 0) return current;
          return String(list[0].id);
        });
      })
      .catch((error) => onError(formatInvokeError(error)));
  }, [onError]);

  useEffect(() => {
    const captcha = parseCaptchaServiceConfig(settings.captcha_service);
    if (captcha.type === "third_party") {
      setCaptchaEnabled(captcha.enabled);
      setCaptchaProviderId(captcha.providerId);
    } else {
      setCaptchaEnabled(false);
      setCaptchaProviderId("");
    }
    void secretRefExists(captchaApiKeyRefId())
      .then(setCaptchaKeySaved)
      .catch(() => setCaptchaKeySaved(false));

    const sms = parseSmsOtpServiceConfig(settings.sms_otp_service);
    if (sms.type === "third_party") {
      setSmsEnabled(sms.enabled === true);
      setSmsProviderId(sms.providerId || "sms-activate");
      setSmsActivationId(sms.activationId ?? "");
    } else {
      setSmsEnabled(false);
      setSmsProviderId("sms-activate");
      setSmsActivationId("");
    }
    setSmsDraftKey("");
    void secretRefExists(smsOtpApiKeyRefId())
      .then(setSmsKeySaved)
      .catch(() => setSmsKeySaved(false));
  }, [settings.captcha_service, settings.sms_otp_service]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        if (scope === "global") {
          if (!cancelled) loadChannelIntoForm(settings.otp_channel ?? "");
          return;
        }
        if (!profileId) {
          if (!cancelled) loadChannelIntoForm("");
          return;
        }
        // 仅加载环境自身绑定；无则空表单（避免把全局误显示成环境配置）
        const profile = profiles.find((item) => String(item.id) === profileId);
        if (!cancelled) loadChannelIntoForm(profile?.otp_channel ?? "");
      } catch (error) {
        if (!cancelled) onError(formatInvokeError(error));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [scope, profileId, settings.otp_channel, profiles, onError]);

  useEffect(() => {
    void refreshSecretFlag(activeSecretRef);
  }, [activeSecretRef]);

  const buildChannel = (): OtpChannelConfig | null => {
    if (channelType === "none") {
      return { type: "none" };
    }
    if (channelType === "webmail_adapter") {
      if (!webmailOptIn) {
        onToast(createToast("error", "网页邮箱不是默认取码路径，请先勾选「显式启用」"));
        return null;
      }
      const providerId = webmailProviderId.trim().toLowerCase();
      if (!WEBMAIL_PROVIDER_OPTIONS.some((item) => item.id === providerId)) {
        onToast(createToast("error", "请选择 Gmail、QQ 邮箱或 Outlook"));
        return null;
      }
      return { type: "webmail_adapter", enabled: true, providerId };
    }
    if (!activeSecretRef) {
      onToast(createToast("error", "请先选择绑定环境"));
      return null;
    }
    if (channelType === "imap") {
      const port = Number(imapPort);
      if (!imapHost.trim() || !imapUser.trim() || !Number.isFinite(port) || port < 1 || port > 65535) {
        onToast(createToast("error", "请填写完整的 IMAP 主机、端口与用户名"));
        return null;
      }
      return {
        type: "imap",
        host: imapHost.trim(),
        port: Math.floor(port),
        user: imapUser.trim(),
        secretRef: activeSecretRef,
        folder: imapFolder.trim() || "INBOX",
        tls: imapTls,
      };
    }
    if (!tempProviderId.trim()) {
      onToast(createToast("error", "请选择临时邮服务商"));
      return null;
    }
    if (!tempInbox.trim()) {
      onToast(createToast("error", "请填写临时邮收件地址"));
      return null;
    }
    return {
      type: "tempmail_provider",
      providerId: tempProviderId.trim(),
      apiKeyRef: activeSecretRef,
      inboxAddress: tempInbox.trim(),
    };
  };

  const persistChannel = async (channel: OtpChannelConfig) => {
    const json = channel.type === "none" ? "" : serializeOtpChannelConfig(channel);
    if (scope === "global") {
      await updateSetting("otp_channel", json || serializeOtpChannelConfig({ type: "none" }));
      onSettingsChange({
        ...settings,
        otp_channel: json || serializeOtpChannelConfig({ type: "none" }),
      });
      return;
    }
    if (!profileId) {
      throw new Error("请选择环境");
    }
    const updated = await setProfileOtpChannel(profileId, json);
    setProfiles((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  };

  const handleSaveChannel = async () => {
    const channel = buildChannel();
    if (!channel) return;
    const tempNeedsKey =
      channel.type === "tempmail_provider"
        ? (TEMPMAIL_PROVIDER_OPTIONS.find((item) => item.id === channel.providerId)?.requiresApiKey ?? true)
        : channel.type === "imap";
    const skipSecret = channel.type === "none" || channel.type === "webmail_adapter";
    if (!skipSecret && draftSecret.trim()) {
      try {
        await putSecretRef(activeSecretRef, draftSecret.trim(), "otp");
        setSecretSaved(true);
        setDraftSecret("");
      } catch (error) {
        const message = formatInvokeError(error);
        onToast(createToast("error", message));
        onError(message);
        return;
      }
    } else if (channel.type === "tempmail_provider" && !tempNeedsKey && !secretSaved && !draftSecret.trim()) {
      try {
        await putSecretRef(activeSecretRef, TEMPMAIL_NO_KEY_PLACEHOLDER, "otp");
        setSecretSaved(true);
      } catch (error) {
        const message = formatInvokeError(error);
        onToast(createToast("error", message));
        onError(message);
        return;
      }
    } else if (!skipSecret && !secretSaved && !draftSecret.trim()) {
      onToast(
        createToast(
          "error",
          channel.type === "tempmail_provider" && !tempNeedsKey
            ? "保存失败：无法写入占位密钥句柄"
            : "请先填写并保存邮箱密码 / API Key",
        ),
      );
      return;
    }

    onSavingChange(true);
    try {
      await persistChannel(channel);
      onToast(createToast("success", channel.type === "none" ? "已清除通道配置" : "邮箱通道已保存"));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleClearChannel = async () => {
    onSavingChange(true);
    try {
      const refsToDelete = [
        scope === "global"
          ? otpSecretRefId("global", "imap")
          : profileId
            ? otpSecretRefId(Number(profileId), "imap")
            : "",
        scope === "global"
          ? otpSecretRefId("global", "tempmail")
          : profileId
            ? otpSecretRefId(Number(profileId), "tempmail")
            : "",
      ].filter(Boolean);
      for (const refId of refsToDelete) {
        await deleteSecretRef(refId).catch(() => false);
      }
      await persistChannel({ type: "none" });
      setChannelType("none");
      setDraftSecret("");
      setSecretSaved(false);
      setOtpStatus("idle");
      setOtpFeedback("");
      onToast(createToast("success", "已清除通道配置与密钥句柄"));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleTestChannel = async () => {
    const channel = buildChannel();
    if (!channel || channel.type === "none") {
      onToast(createToast("error", "请先选择并填写通道后再测试"));
      return;
    }
    const tempNeedsKey =
      channel.type === "tempmail_provider"
        ? (TEMPMAIL_PROVIDER_OPTIONS.find((item) => item.id === channel.providerId)?.requiresApiKey ?? true)
        : channel.type === "imap";
    if (tempNeedsKey && !draftSecret.trim() && !secretSaved) {
      onToast(createToast("error", "请先填写密钥或保存通道后再测试"));
      return;
    }
    onSavingChange(true);
    setOtpStatus("testing");
    setOtpFeedback("");
    try {
      const result = await testOtpChannel(
        serializeOtpChannelConfig(channel),
        channel.type === "webmail_adapter"
          ? null
          : draftSecret.trim() || (tempNeedsKey ? null : TEMPMAIL_NO_KEY_PLACEHOLDER),
      );
      if (result.ok) {
        setOtpStatus("success");
        setOtpFeedback(result.message);
        onToast(createToast("success", result.message));
        onError("");
      } else {
        setOtpStatus("error");
        setOtpFeedback(result.message);
        onToast(createToast("error", result.message));
        onError(result.message);
      }
    } catch (error) {
      const message = formatInvokeError(error);
      setOtpStatus("error");
      setOtpFeedback(message);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleSaveCaptcha = async () => {
    onSavingChange(true);
    try {
      let next: CaptchaServiceConfig;
      if (!captchaEnabled) {
        next = { type: "none", enabled: false };
      } else {
        const providerId = captchaProviderId.trim();
        if (!providerId) {
          onToast(createToast("error", "请填写第三方验证码服务商 ID"));
          onSavingChange(false);
          return;
        }
        const apiKeyRef = captchaApiKeyRefId();
        if (captchaDraftKey.trim()) {
          await putSecretRef(apiKeyRef, captchaDraftKey.trim(), "captcha");
          setCaptchaKeySaved(true);
          setCaptchaDraftKey("");
        } else if (!captchaKeySaved) {
          onToast(createToast("error", "请先填写第三方服务 API Key"));
          onSavingChange(false);
          return;
        }
        next = {
          type: "third_party",
          enabled: true,
          providerId,
          apiKeyRef,
        };
      }
      const json = serializeCaptchaServiceConfig(next);
      await updateSetting("captcha_service", json);
      onSettingsChange({ ...settings, captcha_service: json });
      onToast(
        createToast(
          "success",
          next.type === "none"
            ? "已关闭第三方验证码服务"
            : "已保存第三方验证码服务（Turnstile/reCAPTCHA 等将优先委托求解）",
        ),
      );
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleClearCaptcha = async () => {
    onSavingChange(true);
    try {
      await deleteSecretRef(captchaApiKeyRefId()).catch(() => false);
      const json = serializeCaptchaServiceConfig({ type: "none", enabled: false });
      await updateSetting("captcha_service", json);
      onSettingsChange({ ...settings, captcha_service: json });
      setCaptchaEnabled(false);
      setCaptchaProviderId("");
      setCaptchaDraftKey("");
      setCaptchaKeySaved(false);
      onToast(createToast("success", "已清除第三方验证码占位配置"));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleSaveSms = async () => {
    onSavingChange(true);
    try {
      let next: SmsOtpServiceConfig;
      if (!smsEnabled) {
        next = { type: "none", enabled: false };
      } else {
        const providerId = smsProviderId.trim();
        if (!providerId) {
          onToast(createToast("error", "请选择短信接码服务商"));
          onSavingChange(false);
          return;
        }
        const activationId = smsActivationId.trim();
        if (!activationId) {
          onToast(createToast("error", "请填写接码订单 / 激活 ID"));
          onSavingChange(false);
          return;
        }
        const apiKeyRef = smsOtpApiKeyRefId();
        if (smsDraftKey.trim()) {
          await putSecretRef(apiKeyRef, smsDraftKey.trim(), "sms");
          setSmsKeySaved(true);
          setSmsDraftKey("");
        } else if (!smsKeySaved) {
          onToast(createToast("error", "请先填写接码平台 API Key"));
          onSavingChange(false);
          return;
        }
        next = {
          type: "third_party",
          enabled: true,
          providerId,
          apiKeyRef,
          activationId,
        };
      }
      const json = serializeSmsOtpServiceConfig(next);
      await updateSetting("sms_otp_service", json);
      onSettingsChange({ ...settings, sms_otp_service: json });
      onToast(
        createToast(
          "success",
          next.type === "none" || !next.enabled
            ? "已关闭短信接码平台（默认关）"
            : "已启用短信接码平台（失败将升人工确认）",
        ),
      );
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleClearSms = async () => {
    onSavingChange(true);
    try {
      await deleteSecretRef(smsOtpApiKeyRefId()).catch(() => false);
      const json = serializeSmsOtpServiceConfig({ type: "none", enabled: false });
      await updateSetting("sms_otp_service", json);
      onSettingsChange({ ...settings, sms_otp_service: json });
      setSmsEnabled(false);
      setSmsProviderId("sms-activate");
      setSmsActivationId("");
      setSmsDraftKey("");
      setSmsKeySaved(false);
      onToast(createToast("success", "已清除短信接码配置（恢复默认关闭）"));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={<Mail size={15} className="text-primary" />}
        title="邮箱验证码通道"
        description="默认用邮箱协议或临时邮箱取验证码；密钥安全保存。网页邮箱需勾选后才启用；失败会请您手动输入。"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            生效范围
            <select
              className="field-input"
              value={scope}
              onChange={(event) => setScope(event.target.value as BindScope)}
            >
              <option value="global">全局默认</option>
              <option value="profile">指定环境（优先于全局）</option>
            </select>
          </label>
          {scope === "profile" ? (
            <label className="field-label">
              环境
              <select
                className="field-input"
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              >
                {profiles.length === 0 ? (
                  <option value="">暂无环境</option>
                ) : (
                  profiles.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      #{item.id} {item.name}
                    </option>
                  ))
                )}
              </select>
            </label>
          ) : (
            <div className="flex items-end pb-2 text-[11px] text-muted-foreground">
              有环境专属配置时优先用环境，否则用全局
            </div>
          )}
        </div>

        <label className="field-label">
          通道类型
          <select
            className="field-input"
            value={channelType}
            onChange={(event) => {
              const next = event.target.value as OtpChannelType;
              setChannelType(next);
              setDraftSecret("");
              setOtpStatus("idle");
              setOtpFeedback("");
              if (next === "webmail_adapter") setWebmailOptIn(false);
            }}
          >
            <option value="none">未配置 · 需要时请您输入</option>
            <option value="imap">IMAP 邮箱</option>
            <option value="tempmail_provider">临时邮 API</option>
            <option value="webmail_adapter">网页邮箱（高级，非默认）</option>
          </select>
        </label>

        {channelType === "imap" ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field-label">
                IMAP 主机
                <input
                  className="field-input"
                  value={imapHost}
                  onChange={(event) => setImapHost(event.target.value)}
                  placeholder="imap.example.com"
                  autoComplete="off"
                />
              </label>
              <label className="field-label">
                端口
                <input
                  className="field-input"
                  value={imapPort}
                  onChange={(event) => setImapPort(event.target.value)}
                  placeholder="993"
                  autoComplete="off"
                />
              </label>
            </div>
            <label className="field-label">
              用户名 / 邮箱
              <input
                className="field-input"
                value={imapUser}
                onChange={(event) => setImapUser(event.target.value)}
                placeholder="you@example.com"
                autoComplete="off"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field-label">
                文件夹
                <input
                  className="field-input"
                  value={imapFolder}
                  onChange={(event) => setImapFolder(event.target.value)}
                  placeholder="INBOX"
                  autoComplete="off"
                />
              </label>
              <label className="flex items-center gap-2 pt-6 text-caption text-muted-foreground">
                <input
                  type="checkbox"
                  checked={imapTls}
                  onChange={(event) => setImapTls(event.target.checked)}
                />
                使用 TLS（推荐 993）
              </label>
            </div>
            <label className="field-label">
              邮箱密码 / 应用专用密码
              <input
                className="field-input"
                type="password"
                value={draftSecret}
                onChange={(event) => setDraftSecret(event.target.value)}
                placeholder={secretSaved ? "已保存（留空则保留原密钥）" : "密钥安全保存，不写入配置"}
                autoComplete="new-password"
              />
            </label>
          </div>
        ) : null}

        {channelType === "tempmail_provider" ? (
          <div className="space-y-3">
            <label className="field-label">
              服务商
              <select
                className="field-input"
                value={tempProviderId}
                onChange={(event) => {
                  setTempProviderId(event.target.value);
                  setDraftSecret("");
                  setOtpStatus("idle");
                  setOtpFeedback("");
                }}
              >
                {TEMPMAIL_PROVIDER_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                    {item.requiresApiKey ? "" : "（免 API Key）"}
                  </option>
                ))}
                {!TEMPMAIL_PROVIDER_OPTIONS.some((item) => item.id === tempProviderId) && tempProviderId ? (
                  <option value={tempProviderId}>{tempProviderId}（未接线）</option>
                ) : null}
              </select>
            </label>
            <label className="field-label">
              收件地址 / 收件箱 ID
              <input
                className="field-input"
                value={tempInbox}
                onChange={(event) => setTempInbox(event.target.value)}
                placeholder={tempProviderMeta.inboxHint}
                autoComplete="off"
              />
            </label>
            {tempProviderMeta.requiresApiKey ? (
              <label className="field-label">
                API Key
                <input
                  className="field-input"
                  type="password"
                  value={draftSecret}
                  onChange={(event) => setDraftSecret(event.target.value)}
                  placeholder={secretSaved ? "已保存（留空则保留原密钥）" : "密钥安全保存，不写入配置"}
                  autoComplete="new-password"
                />
              </label>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                本服务商无需 API Key；仍须显式选择通道并填写收件地址（默认不会自动开临时邮）。
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              已接线：MailSlurp、1secmail。未知服务商或未配置时 Agent 会升人工确认。网页邮箱不是默认取码路径。
            </p>
          </div>
        ) : null}

        {channelType === "webmail_adapter" ? (
          <div className="space-y-3">
            <p className="text-caption leading-5 text-muted-foreground">
              高级选项，默认关闭。启用后 Agent
              会临时打开该邮箱网页，只读正文验证码后关掉该标签；未登录、超时或读不到码时交由您本人填写。不会保存邮箱密码，也不会为登录改动浏览器指纹。
            </p>
            <label className="flex items-center gap-2 text-caption text-foreground">
              <input
                type="checkbox"
                checked={webmailOptIn}
                onChange={(event) => setWebmailOptIn(event.target.checked)}
              />
              显式启用网页邮箱取码（非默认）
            </label>
            {webmailOptIn ? (
              <label className="field-label">
                邮箱网页
                <select
                  className="field-input"
                  value={webmailProviderId}
                  onChange={(event) => {
                    setWebmailProviderId(event.target.value);
                    setOtpStatus("idle");
                    setOtpFeedback("");
                  }}
                >
                  {WEBMAIL_PROVIDER_OPTIONS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}

        {channelType !== "none" && activeSecretRef ? (
          <p className="text-[11px] text-muted-foreground">
            密钥句柄：<span className="font-mono">{activeSecretRef}</span>
            {secretSaved ? " · 已存档" : " · 尚未存档"}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <ConnectivityIndicator status={otpStatus} />
          <button
            type="button"
            className="btn btn-outline"
            disabled={saving || channelType === "none" || otpStatus === "testing"}
            onClick={() => void handleTestChannel()}
          >
            <Zap size={14} className={otpStatus === "testing" ? "animate-pulse" : ""} />
            {otpStatus === "testing" ? "测试中..." : "测试连接"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void handleSaveChannel()}
          >
            <KeyRound size={14} />
            保存
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={saving}
            onClick={() => void handleClearChannel()}
          >
            <Trash2 size={14} />
            清除
          </button>
        </div>
        {otpFeedback ? (
          <p
            className={`text-caption ${
              otpStatus === "success"
                ? "text-success"
                : otpStatus === "error"
                  ? "text-destructive"
                  : "text-muted-foreground"
            }`}
          >
            {otpFeedback}
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        icon={<KeyRound size={15} className="text-primary" />}
        title="短信接码平台"
        description="短信接码默认关闭。开启后可自动取短信码；失败或超时会请您确认。身份验证器（动态口令）不会自动读取。"
      >
        <p className="text-caption leading-5 text-muted-foreground">
          须勾选启用并填写服务商、订单 ID 与 API
          Key（密钥安全保存）。支付、转账等敏感操作不会自动完成，需您确认。
        </p>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={smsEnabled}
            onChange={(event) => setSmsEnabled(event.target.checked)}
          />
          启用短信接码（默认关）
        </label>
        {smsEnabled ? (
          <div className="space-y-3">
            <label className="field-label">
              服务商
              <select
                className="field-input"
                value={smsProviderId}
                onChange={(event) => setSmsProviderId(event.target.value)}
              >
                {SMS_PROVIDER_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              激活 / 订单 ID
              <input
                className="field-input"
                value={smsActivationId}
                onChange={(event) => setSmsActivationId(event.target.value)}
                placeholder="接码平台返回的订单 ID"
                autoComplete="off"
              />
            </label>
            <label className="field-label">
              API Key
              <input
                className="field-input"
                type="password"
                value={smsDraftKey}
                onChange={(event) => setSmsDraftKey(event.target.value)}
                placeholder={smsKeySaved ? "已保存（留空则保留原密钥）" : "密钥安全保存，不写入配置文件"}
                autoComplete="new-password"
              />
            </label>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void handleSaveSms()}
          >
            保存
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={saving}
            onClick={() => void handleClearSms()}
          >
            <Trash2 size={14} />
            清除
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<Shield size={15} className="text-primary" />}
        title="图形验证码"
        description="常见图形码可自动处理；网站人机验证可接第三方。未配置或失败时请您手动完成。"
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {BUILTIN_CAPTCHA_HINTS.map((item) => (
            <li key={item.id} className="rounded-md bg-sunken px-2.5 py-2 text-caption">
              <span className="font-medium text-foreground">{item.label}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
        <p className="text-caption leading-5 text-muted-foreground">
          Cloudflare Turnstile、reCAPTCHA、hCaptcha：启用下方服务商后由 Agent
          委托求解；未配置、超时或失败会升人工确认（HITL）。短信码须显式启用接码平台；TOTP 永不自动猜码。
        </p>

        <label className="flex items-center gap-2 text-caption text-foreground">
          <input
            type="checkbox"
            checked={captchaEnabled}
            onChange={(event) => setCaptchaEnabled(event.target.checked)}
          />
          启用第三方验证码服务
        </label>
        {captchaEnabled ? (
          <div className="space-y-3">
            <label className="field-label">
              服务商 ID
              <input
                className="field-input"
                value={captchaProviderId}
                onChange={(event) => setCaptchaProviderId(event.target.value)}
                placeholder="2captcha 或 capsolver"
                autoComplete="off"
              />
            </label>
            <label className="field-label">
              API Key
              <input
                className="field-input"
                type="password"
                value={captchaDraftKey}
                onChange={(event) => setCaptchaDraftKey(event.target.value)}
                placeholder={captchaKeySaved ? "已保存（留空则保留原密钥）" : "密钥安全保存，不写入配置文件"}
                autoComplete="new-password"
              />
            </label>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void handleSaveCaptcha()}
          >
            保存
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={saving}
            onClick={() => void handleClearCaptcha()}
          >
            <Trash2 size={14} />
            清除
          </button>
        </div>
      </SettingsSection>
    </div>
  );
}
