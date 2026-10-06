import { Bot, ExternalLink, Library, Plus, PlugZap, Trash2, Zap } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { openExternalUrl } from "../../lib/appLinks";
import { formatInvokeError, persistAiSettings, testAiConnection } from "../../lib/tauri";
import type { AppSettings, ConnectivityStatus } from "../../types";
import {
  AI_PROVIDER_PRESETS,
  aiApiKeyFieldForProvider,
  aiChatModelFieldForProvider,
  buildModelCatalog,
  getAiApiKeyForSettings,
  normalizeAiProviderId,
  parseAiExtraModels,
  parseAiTaskModels,
  serializeAiExtraModels,
  serializeAiTaskModels,
  type AiExtraModel,
  type AiProviderId,
  type AiTaskModelMap,
  type AiTaskRole,
} from "../../types";
import { createToast } from "../../lib/toast";
import type { ToastMessage } from "../../lib/toast";
import { ConnectivityIndicator } from "./ConnectivityIndicator";
import { SettingsSection } from "./SettingsSection";

interface AiSettingsTabProps {
  settings: AppSettings;
  aiStatus: ConnectivityStatus;
  saving: boolean;
  onSettingsChange: (next: AppSettings) => void;
  onAiStatusChange: (status: ConnectivityStatus) => void;
  onSavingChange: (saving: boolean) => void;
  onToast: (toast: ToastMessage) => void;
  onError: (message: string) => void;
  registerFlushSave?: (flush: () => Promise<void>) => void;
}

const TASK_ROLES: Array<{
  role: AiTaskRole;
  label: string;
  hint: string;
  autoVision: boolean;
}> = [
  { role: "chat", label: "极速", hint: "聊天 / 抽取 / 汇报", autoVision: false },
  { role: "agent", label: "深度", hint: "Agent 工具决策 / 规划", autoVision: false },
  { role: "vision", label: "视觉", hint: "开眼 / 坐标识别", autoVision: true },
];

export function AiSettingsTab({
  settings,
  aiStatus,
  saving,
  onSettingsChange,
  onAiStatusChange,
  onSavingChange,
  onToast,
  onError,
  registerFlushSave,
}: AiSettingsTabProps) {
  const [persistHint, setPersistHint] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [newModelVision, setNewModelVision] = useState(false);
  const [newModelDisableThinking, setNewModelDisableThinking] = useState(true);
  const keySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const providerId = normalizeAiProviderId(settings.ai_provider, settings.deepseek_base_url);
  const provider = AI_PROVIDER_PRESETS.find((item) => item.id === providerId) ?? AI_PROVIDER_PRESETS[2];
  const apiKeyField = aiApiKeyFieldForProvider(providerId);
  const activeApiKey = settings[apiKeyField];

  /** 模型库 = 用户自建（不再有预置清单） */
  const library = useMemo(
    () => buildModelCatalog(providerId, settings.ai_extra_models ?? "[]"),
    [providerId, settings.ai_extra_models],
  );

  /**
   * 任务槽直接读存储值，不做「沿用文本档」的展示兜底 ——
   * 展示兜底会让「视觉档空着」看起来像配过了。留空时在下面明确提示会沿用文本档。
   */
  const storedRow = parseAiTaskModels(settings.ai_task_models)[providerId];
  const taskValues: AiTaskModelMap = storedRow ?? { chat: "", agent: "", vision: "" };

  const saveNow = async (next: AppSettings, opts?: { quiet?: boolean }) => {
    try {
      await persistAiSettings(next);
      if (!opts?.quiet) {
        setPersistHint("已自动保存");
      }
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
      setPersistHint("");
      throw error;
    }
  };

  useEffect(() => {
    registerFlushSave?.(() => saveNow(settingsRef.current, { quiet: true }));
    return () => registerFlushSave?.(() => Promise.resolve());
  }, [registerFlushSave]);

  useEffect(() => {
    return () => {
      if (keySaveTimer.current) {
        clearTimeout(keySaveTimer.current);
      }
    };
  }, []);

  const apply = (partial: Partial<AppSettings>): AppSettings => {
    const next = { ...settings, ...partial };
    onSettingsChange(next);
    onAiStatusChange("idle");
    return next;
  };

  const applyAndSave = async (partial: Partial<AppSettings>) => {
    const next = apply(partial);
    onSavingChange(true);
    try {
      await saveNow(next);
    } finally {
      onSavingChange(false);
    }
  };

  const handleProviderChange = (nextId: AiProviderId) => {
    const next = AI_PROVIDER_PRESETS.find((item) => item.id === nextId);
    if (!next) {
      return;
    }
    const patch: Partial<AppSettings> = { ai_provider: nextId };
    if (nextId === "deepseek" || nextId === "zhipu") {
      patch.deepseek_base_url = next.baseUrl;
    }
    // 不再为服务商预填任何模型：该服务商没配过，就去模型库里选一个
    void applyAndSave(patch);
  };

  /** 写任务槽；若这个 ID 还不在库里，顺手入库（视觉档自动带 vision）。 */
  const commitTaskModel = (role: AiTaskRole, raw: string) => {
    const model = raw.trim();
    const patch: Partial<AppSettings> = {};
    let addedToLibrary = false;
    if (model) {
      const extras = parseAiExtraModels(settings.ai_extra_models);
      const known = extras.some((item) => item.value.toLowerCase() === model.toLowerCase());
      if (!known) {
        extras.push({
          value: model,
          label: model,
          hint: "用户添加",
          vision: role === "vision",
          provider: providerId,
          custom: true,
        });
        patch.ai_extra_models = serializeAiExtraModels(extras);
        addedToLibrary = true;
      }
    }
    patch.ai_task_models = upsertTaskRow(settings.ai_task_models, providerId, role, model);
    if (role === "chat") {
      (patch as Record<string, string>)[aiChatModelFieldForProvider(providerId)] = model;
    }
    void applyAndSave(patch).then(() => {
      if (addedToLibrary) {
        onToast(createToast("success", `已把 ${model} 加入模型库`));
      }
    });
  };

  const handleAddModel = () => {
    const id = newModelId.trim();
    if (!id) {
      onToast(createToast("error", "请输入模型 ID（以服务商文档为准）"));
      return;
    }
    const extras = parseAiExtraModels(settings.ai_extra_models);
    if (extras.some((item) => item.value.toLowerCase() === id.toLowerCase())) {
      onToast(createToast("error", "该模型已在模型库里"));
      return;
    }
    extras.push({
      value: id,
      label: id,
      hint: "用户添加",
      vision: newModelVision,
      disableThinkingForForcedTools: newModelDisableThinking,
      provider: providerId,
      custom: true,
    });
    setNewModelId("");
    setNewModelVision(false);
    setNewModelDisableThinking(true);
    void applyAndSave({ ai_extra_models: serializeAiExtraModels(extras) }).then(() => {
      onToast(createToast("success", `已添加模型 ${id}`));
    });
  };

  const handleToggleModelFlag = (item: AiExtraModel, patch: Partial<AiExtraModel>) => {
    const extras = parseAiExtraModels(settings.ai_extra_models).map((entry) =>
      entry.value.toLowerCase() === item.value.toLowerCase() &&
      (entry.provider || "") === (item.provider || "")
        ? { ...entry, ...patch }
        : entry,
    );
    void applyAndSave({ ai_extra_models: serializeAiExtraModels(extras) });
  };

  /** 删除模型，并清掉指向它的任务槽，避免留下「下拉里查不到的模型」。 */
  const handleRemoveModel = (item: AiExtraModel) => {
    const key = item.value.toLowerCase();
    const extras = parseAiExtraModels(settings.ai_extra_models).filter(
      (entry) =>
        !(entry.value.toLowerCase() === key && (entry.provider || "") === (item.provider || "")),
    );
    const patch: Partial<AppSettings> = { ai_extra_models: serializeAiExtraModels(extras) };

    const map = parseAiTaskModels(settings.ai_task_models);
    const row = map[providerId];
    if (row) {
      const nextRow: AiTaskModelMap = { ...row };
      let changed = false;
      for (const role of ["chat", "agent", "vision"] as AiTaskRole[]) {
        if (String(nextRow[role] ?? "").toLowerCase() === key) {
          nextRow[role] = "";
          changed = true;
        }
      }
      if (changed) {
        map[providerId] = nextRow;
        patch.ai_task_models = serializeAiTaskModels(map);
        if (!nextRow.chat) {
          (patch as Record<string, string>)[aiChatModelFieldForProvider(providerId)] = "";
        }
      }
    }
    void applyAndSave(patch);
  };

  const handleBaseUrlChange = (value: string) => {
    apply({
      deepseek_base_url: value,
      ai_provider: providerId === "custom" ? "custom" : detectProviderKeepCustom(value, providerId),
    });
  };

  const handleApiKeyChange = (value: string) => {
    apply({ [apiKeyField]: value } as Partial<AppSettings>);
    if (keySaveTimer.current) {
      clearTimeout(keySaveTimer.current);
    }
    keySaveTimer.current = setTimeout(() => {
      void saveNow(settingsRef.current).catch(() => undefined);
    }, 400);
  };

  const handleOpenDocs = () => {
    const url = provider.docsUrl;
    if (!url) {
      return;
    }
    void openExternalUrl(url).catch(() => {
      onToast(createToast("error", "打不开浏览器，请手动访问服务商文档"));
    });
  };

  const handleTest = async () => {
    onSavingChange(true);
    onAiStatusChange("testing");
    onError("");
    try {
      await saveNow(settings, { quiet: true });
      const key = getAiApiKeyForSettings(settings);
      await testAiConnection(settings.deepseek_base_url, key);
      onAiStatusChange("success");
      onToast(createToast("success", "AI 连接测试成功"));
    } catch (error) {
      onAiStatusChange("error");
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleSave = async () => {
    onSavingChange(true);
    try {
      await saveNow(settings);
      onToast(createToast("success", "设置已保存"));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const keyPlaceholder =
    providerId === "zhipu"
      ? "智谱开放平台 API Key"
      : providerId === "custom"
        ? "自定义端点 API Key"
        : "sk-...";

  const missingTextModel = !taskValues.chat && !taskValues.agent;

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={<PlugZap size={15} className="text-primary" />}
        title="API 连接"
        description="换服务商会立刻保存；每个服务商的密钥分开存放。"
      >
        <label className="field-label">
          服务商
          <select
            className="field-input"
            value={providerId}
            onChange={(event) => handleProviderChange(event.target.value as AiProviderId)}
          >
            {AI_PROVIDER_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {provider.docsUrl ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 self-start text-caption text-primary-text hover:underline"
            onClick={handleOpenDocs}
          >
            <ExternalLink size={12} />
            模型说明
          </button>
        ) : null}
        <label className="field-label">
          API Base URL
          <input
            className="field-input"
            value={settings.deepseek_base_url}
            onChange={(event) => handleBaseUrlChange(event.target.value)}
            onBlur={() => void saveNow(settingsRef.current, { quiet: true })}
            placeholder={
              providerId === "zhipu" ? "https://open.bigmodel.cn/api/paas/v4" : "https://api.deepseek.com"
            }
          />
        </label>
        <label className="field-label">
          API Key（{provider.label}）
          <input
            className="field-input"
            type="password"
            name={`ai-api-key-${providerId}`}
            autoComplete="off"
            value={activeApiKey}
            onChange={(event) => handleApiKeyChange(event.target.value)}
            placeholder={keyPlaceholder}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectivityIndicator status={aiStatus} />
          <button
            className="btn btn-outline"
            disabled={saving || aiStatus === "testing"}
            onClick={() => void handleTest()}
          >
            <Zap size={14} className={aiStatus === "testing" ? "animate-pulse" : ""} />
            {aiStatus === "testing" ? "测试中..." : "测试连接"}
          </button>
          {persistHint ? <span className="text-[11px] text-success">{persistHint}</span> : null}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<Library size={15} className="text-primary" />}
        title="模型库"
        description="模型 ID 更新很快，这里不预置任何模型 —— 照服务商文档把要用的 ID 填进来即可。"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="field-label min-w-[12rem] flex-1">
            模型 ID
            <input
              className="field-input font-mono text-xs"
              value={newModelId}
              onChange={(event) => setNewModelId(event.target.value)}
              placeholder="服务商文档里的模型 ID"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddModel();
                }
              }}
            />
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-caption text-muted-foreground">
            <input
              type="checkbox"
              checked={newModelVision}
              onChange={(event) => setNewModelVision(event.target.checked)}
            />
            支持视觉
          </label>
          <label
            className="flex items-center gap-1.5 pb-2 text-caption text-muted-foreground"
            title="这类模型默认开启思考，与 Agent 的强制工具调用互斥；勾上后会自动补 thinking.disabled"
          >
            <input
              type="checkbox"
              checked={newModelDisableThinking}
              onChange={(event) => setNewModelDisableThinking(event.target.checked)}
            />
            强制调用时禁用思考
          </label>
          <button type="button" className="btn btn-outline mb-0.5" disabled={saving} onClick={handleAddModel}>
            <Plus size={14} />
            添加
          </button>
        </div>
        {library.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {library.map((item) => (
              <li
                key={`${item.provider ?? ""}-${item.value}`}
                className="flex items-center justify-between gap-2 rounded-md bg-sunken px-2.5 py-2 text-caption ring-1 ring-inset ring-field/40"
              >
                <span className="min-w-0 truncate font-mono">{item.value}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded accent-primary"
                      checked={Boolean(item.vision)}
                      onChange={() =>
                        handleToggleModelFlag(item, { vision: !item.vision })
                      }
                    />
                    视觉
                  </label>
                  <label
                    className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground"
                    title="默认开思考的模型：Agent 强制工具调用时会补 thinking.disabled，否则会 400"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded accent-primary"
                      checked={Boolean(item.disableThinkingForForcedTools)}
                      onChange={() =>
                        handleToggleModelFlag(item, {
                          disableThinkingForForcedTools: !item.disableThinkingForForcedTools,
                        })
                      }
                    />
                    禁用思考
                  </label>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    title="从模型库删除"
                    onClick={() => handleRemoveModel(item)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md bg-sunken px-2.5 py-2 text-[11px] text-muted-foreground">
            模型库还是空的。先在上面填一个模型 ID 添加进来，再到下面「按任务选用模型」里选中。
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        icon={<Bot size={15} className="text-primary" />}
        title="按任务选用模型"
        description="三个档位都从模型库里选；也可以直接把新的模型 ID 粘进来，失焦后自动入库。"
      >
        {missingTextModel ? (
          <p className="rounded-md bg-warning/15 px-2.5 py-2 text-caption text-warning">
            还没有可用的文本模型，Agent 与聊天都跑不起来。请先在上面的模型库里添加模型。
          </p>
        ) : null}
        {TASK_ROLES.map((item) => (
          <ModelCombobox
            key={item.role}
            label={item.label}
            hint={item.hint}
            value={taskValues[item.role] ?? ""}
            catalog={library}
            autoVision={item.autoVision}
            onCommit={(model) => commitTaskModel(item.role, model)}
          />
        ))}
        <p className="text-[11px] text-muted-foreground">
          某个档位留空时：视觉会沿用文本档；极速与深度会互相补位。三档都没有模型时，相关任务会直接提示先配置。
        </p>
      </SettingsSection>

      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
          保存设置
        </button>
      </div>
    </div>
  );
}

/** 任务槽写入：只改当前服务商那一行，其余原样保留 */
function upsertTaskRow(
  taskModelsRaw: string | undefined,
  providerId: AiProviderId,
  role: AiTaskRole,
  model: string,
): string {
  const map = parseAiTaskModels(taskModelsRaw);
  const current = map[providerId] ?? { chat: "", agent: "", vision: "" };
  map[providerId] = { ...current, [role]: model.trim() };
  return serializeAiTaskModels(map);
}

/**
 * 模型输入框：可从模型库挑，也可直接粘一个新 ID。
 * 用原生 `datalist` 做建议列表，不引第三方下拉组件。
 */
function ModelCombobox({
  label,
  hint,
  value,
  catalog,
  autoVision,
  onCommit,
}: {
  label: string;
  hint: string;
  value: string;
  catalog: AiExtraModel[];
  autoVision?: boolean;
  onCommit: (model: string) => void;
}) {
  const listId = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const options = useMemo(() => {
    const list = [...catalog];
    if (autoVision) {
      list.sort((a, b) => Number(Boolean(b.vision)) - Number(Boolean(a.vision)));
    }
    return list;
  }, [catalog, autoVision]);

  const commit = (raw: string) => {
    const next = raw.trim();
    if (next === value.trim()) {
      return;
    }
    onCommit(next);
  };

  return (
    <label className="field-label">
      <span className="flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className="text-[10px] font-normal text-muted-foreground">{hint}</span>
      </span>
      <input
        className="field-input font-mono text-xs"
        list={listId}
        value={draft}
        placeholder={catalog.length > 0 ? "从模型库选择，或填入新 ID" : "先到模型库添加模型"}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(draft);
          }
        }}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={`${option.provider ?? ""}-${option.value}`} value={option.value}>
            {[option.hint, option.vision ? "视觉" : ""].filter(Boolean).join(" · ")}
          </option>
        ))}
      </datalist>
    </label>
  );
}

function detectProviderKeepCustom(baseUrl: string, current: AiProviderId): AiProviderId {
  if (current === "custom") {
    return "custom";
  }
  return normalizeAiProviderId(undefined, baseUrl);
}
