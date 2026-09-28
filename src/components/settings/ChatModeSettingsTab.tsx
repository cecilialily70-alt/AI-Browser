import { Clock, EyeOff, MessageSquare, MessagesSquare, Plus, Save, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";

import {
  CHAT_CONTACTS_PER_SLICE_MAX,
  CHAT_PARALLEL_MAX,
  CHAT_ROLE_NAME_MAX,
  CHAT_ROLE_PROMPT_MAX,
  CHAT_ROLES_MAX,
  CHAT_SLICE_MS_MAX,
  CHAT_SLICE_MS_MIN,
  DEFAULT_CHAT_MODE_SETTINGS,
  DEFAULT_QUIET_HOURS,
  createChatRole,
  parseChatModeSettings,
  serializeChatModeSettings,
  type ChatModeSettings,
  type ChatRole,
} from "../../lib/chatModeSettings";
import { createToast } from "../../lib/toast";
import type { ToastMessage } from "../../lib/toast";
import { fetchRawSettings, formatInvokeError, updateSetting } from "../../lib/tauri";
import { ChatSiteSupportSection } from "./ChatSiteSupportSection";
import { SettingsSection } from "./SettingsSection";

interface ChatModeSettingsTabProps {
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onToast: (toast: ToastMessage) => void;
  onError: (message: string) => void;
}

/** 一行开关（标题 + 说明 + ui-switch） */
function ToggleRow({
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
  hint: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md bg-card/50 px-3 py-2 ring-1 ring-inset ring-border-strong/30">
      <div className="min-w-0 space-y-0.5">
        <p className="text-ui text-foreground">{label}</p>
        <p className="text-caption leading-4 text-muted-foreground">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`ui-switch mt-0.5 ${checked ? "ui-switch-on" : ""} ${disabled ? "opacity-50" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span
          className="ui-switch-knob"
          style={{ transform: checked ? "translateX(0.75rem)" : "translateX(0.125rem)" }}
        />
      </button>
    </div>
  );
}

function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md bg-card/50 px-3 py-2 ring-1 ring-inset ring-border-strong/30">
      <span className="min-w-0 space-y-0.5">
        <span className="block text-ui text-foreground">{label}</span>
        <span className="block text-caption leading-4 text-muted-foreground">{hint}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <input
          type="number"
          className="field-input h-7 w-20 text-right"
          value={Number.isFinite(value) ? value : min}
          min={min}
          max={max}
          step={step ?? 1}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) {
              return;
            }
            onChange(Math.min(max, Math.max(min, next)));
          }}
        />
        {suffix ? <span className="text-caption text-muted-foreground">{suffix}</span> : null}
      </span>
    </label>
  );
}

/**
 * 「聊天设置」——聊天模式（独立产品面）的用户可调项与**静音审计**。
 *
 * 为什么单开一页（§3.5 / §5.7）：
 * - 聊天模式与 Agent / 回放共用 CDP 互斥、却有自己的节奏与红线，混在「浏览器」页里
 *   会让用户找不到「它到底什么时候会动」。
 * - §5.7 要求「设置里的静音项必须可见可审计」：这里用**只读清单**明确列出它不做的事
 *   （不截图、不读验证码、不发支付），用户能自己确认，而不是听谁保证。
 */
export function ChatModeSettingsTab({
  saving,
  onSavingChange,
  onToast,
  onError,
}: ChatModeSettingsTabProps) {
  const [settings, setSettings] = useState<ChatModeSettings>(DEFAULT_CHAT_MODE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  /** 设置页只做增删改：点名单展开这一条编辑；用哪个角色在「聊天」窗口选 */
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [rolesDirty, setRolesDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await fetchRawSettings();
        if (cancelled) return;
        const parsed = parseChatModeSettings(raw.chat_mode);
        setSettings(parsed.settings);
        setDiagnostics(parsed.diagnostics);
      } catch (error) {
        if (!cancelled) {
          onError(formatInvokeError(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const persist = async (next: ChatModeSettings, successToast?: string) => {
    // 乐观更新 + **失败回滚**：`updateSetting` 会把 key 丢给 Host 校验，写盘失败（例如
    // 设置键没进白名单）时若只弹个错、界面还留着新值，用户会以为「已经生效了」——
    // 与「聊天」视图的行为一致（`ChatModeModal.persistSettings` 就是这么做的，§0.5.3 C）。
    const previous = settings;
    setSettings(next);
    onSavingChange(true);
    try {
      await updateSetting("chat_mode", serializeChatModeSettings(next));
      if (successToast) {
        onToast(createToast("success", successToast));
      }
    } catch (error) {
      setSettings(previous);
      onError(formatInvokeError(error));
    } finally {
      onSavingChange(false);
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-ui text-muted-foreground">加载聊天设置中…</div>;
  }

  return (
    <div className="space-y-4">
      {diagnostics.length > 0 ? (
        <div className="rounded-md bg-warning/10 px-3 py-2 text-caption leading-5 text-warning ring-1 ring-inset ring-warning/30">
          <p className="font-medium">这份聊天设置里有几项被修正过，请确认：</p>
          <ul className="mt-1 list-inside list-disc">
            {diagnostics.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <SettingsSection
        icon={<MessagesSquare size={16} />}
        title="聊天模式总开关"
        description="默认关闭。关闭时不会注册定时器、也不会自动拉起值守。日常开关也可在顶栏「聊天模式」视图的状态带上操作。"
      >
        <ToggleRow
          checked={settings.enabled}
          disabled={saving}
          label="启用聊天模式"
          hint="这是「允许使用」的闸门；真正开聊仍要在「聊天模式」视图里点「开始值守一片」。"
          onChange={(next) =>
            void persist(
              { ...settings, enabled: next },
              next ? "聊天模式已启用（仍需显式开始值守）" : "聊天模式已关闭",
            )
          }
        />
      </SettingsSection>

      <SettingsSection
        icon={<MessagesSquare size={16} />}
        title="聊天对象"
        description="指定要聊谁。没指定时，聊天模式直接用你此刻打开的那个聊天窗口。"
      >
        <ToggleRow
          checked={settings.useCurrentWindow}
          disabled={saving}
          label="未指定对象时，使用当前打开的聊天窗口"
          hint="默认开启。只在「要聊的对象」留空时生效：引擎绑到你当时开着的那个聊天标签上，只读会话、只往输入框里打字；不新开标签、不导航、不关你的窗口。判不出那是聊天页就如实失败，不会乱猜。"
          onChange={(next) =>
            void persist(
              { ...settings, useCurrentWindow: next },
              next
                ? "已开启：目标留空时用当前打开的聊天窗口"
                : "已关闭：没有目标就不会启动聊天",
            )
          }
        />
      </SettingsSection>

      <SettingsSection
        icon={<Clock size={16} />}
        title="值守节奏"
        description="对方没回时只盯守、不催（主动追发已下线）。可设夜间静默；对方来消息仍可按「自动聊天」回话。"
      >
        <p className="text-caption text-muted-foreground">
          引擎行为：开场与回话走联系人卡片上的「自动聊天」；发出后靠短复查接对方下一句；不会隔几天再主动追一句。
        </p>
        <ToggleRow
          checked={settings.cadence.quietHours != null}
          disabled={saving}
          label="夜间静默"
          hint={`开启后默认 ${DEFAULT_QUIET_HOURS.start}–${DEFAULT_QUIET_HOURS.end} 不主动开口（对方来消息仍可回）。`}
          onChange={(next) =>
            void persist(
              {
                ...settings,
                cadence: {
                  ...settings.cadence,
                  quietHours: next ? { ...DEFAULT_QUIET_HOURS } : null,
                },
              },
              next ? "已开启夜间静默" : "已关闭夜间静默",
            )
          }
        />
      </SettingsSection>

      <SettingsSection
        icon={<MessagesSquare size={16} />}
        title="单次值守"
        description="一次值守跑多久、最多处理几位联系人。总开关开着时会持续盯守：有消息立刻回，片与片之间秒级续上。"
      >
        <NumberRow
          label="单次值守时长"
          hint={`到点就收尾并让位；下一片会马上再来。想多轮来回更久就调大（约 ${Math.round(settings.sliceMs / 60_000)} 分钟）。`}
          value={Math.round(settings.sliceMs / 60_000)}
          min={Math.ceil(CHAT_SLICE_MS_MIN / 60_000)}
          max={Math.floor(CHAT_SLICE_MS_MAX / 60_000)}
          step={1}
          suffix="分钟"
          disabled={saving}
          onChange={(minutes) =>
            void persist({
              ...settings,
              sliceMs: Math.min(
                CHAT_SLICE_MS_MAX,
                Math.max(CHAT_SLICE_MS_MIN, Math.round(minutes) * 60_000),
              ),
            })
          }
        />
        <NumberRow
          label="单次处理联系人上限"
          hint="一次值守里最多翻几位联系人的会话。"
          value={settings.maxContactsPerSlice}
          min={1}
          max={CHAT_CONTACTS_PER_SLICE_MAX}
          suffix="位"
          disabled={saving}
          onChange={(next) => void persist({ ...settings, maxContactsPerSlice: next })}
        />
      </SettingsSection>

      <SettingsSection
        icon={<MessageSquare size={16} />}
        title="自动值守"
        description="打开总开关后，本应用会持续把在跑的环境拉起来值守；有消息就回，跑完马上再来。电脑休眠，或关掉本应用 / 浏览器时无法回复。"
      >
        <NumberRow
          label="同时值守的环境数"
          hint={
            "到期的环境多于这个数时会排队（排队数量会显示在「聊天模式」视图里，不会被丢掉）。" +
            "免费档恒为 1；Pro 最高 " +
            CHAT_PARALLEL_MAX +
            "（与浏览器 Agent 同一套席位，不会为聊天开不受限通道）。"
          }
          value={settings.maxParallelSlices}
          min={1}
          max={CHAT_PARALLEL_MAX}
          suffix="个"
          disabled={saving}
          onChange={(next) => void persist({ ...settings, maxParallelSlices: next })}
        />
        <details className="rounded-md bg-card/50 px-3 py-2 text-caption leading-5 text-muted-foreground ring-1 ring-inset ring-border-strong/30">
          <summary className="cursor-pointer select-none font-medium text-foreground">
            自动值守会怎么保底（点开看）
          </summary>
          <ul className="mt-2 space-y-1.5">
            <li>
              总开关<strong className="text-foreground">关掉即不存在</strong>：不会注册定时器、不会后台唤醒。
            </li>
            <li>
              同一环境与浏览器 Agent / 回放 / 填表<strong className="text-foreground">互斥</strong>：别人在用就等，不会并行踩同一台浏览器。
            </li>
            <li>
              一次值守卡住会<strong className="text-foreground">分级恢复</strong>（先优雅停下，再重启该环境的执行程序）；连续失败 3 次即停自动拉起，需要你手动恢复。
            </li>
            <li>
              <strong className="text-foreground">物理边界</strong>：电脑休眠，或关掉本应用 / 对应浏览器时无法回复。
            </li>
          </ul>
        </details>
      </SettingsSection>

      <SettingsSection
        icon={<UserRound size={16} />}
        title="聊天角色"
        description="在这里增加、修改、删除角色。用哪个角色去聊，请到顶栏「聊天」窗口顶部的「角色」下拉框选择。"
      >
        {settings.roles.length === 0 ? (
          <p className="text-caption leading-5 text-muted-foreground">
            还没有角色。点「添加角色」写名称和提示词，再点「保存」。不添加也可以直接聊。
          </p>
        ) : (
          <ul className="divide-y divide-border-strong/20 overflow-hidden rounded-md ring-1 ring-inset ring-border-strong/30">
            {settings.roles.map((role) => {
              const selected = editingRoleId === role.id;
              return (
                <li key={role.id} className={selected ? "bg-primary/5" : "bg-card/50"}>
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate text-left text-ui ${
                        selected ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                      disabled={saving}
                      onClick={() => setEditingRoleId(selected ? null : role.id)}
                      title={selected ? "收起编辑" : "展开编辑"}
                    >
                      {role.name.trim() || "未命名角色"}
                    </button>
                    <button
                      type="button"
                      className="btn-icon-danger shrink-0"
                      title="删除这个角色"
                      aria-label="删除这个角色"
                      disabled={saving}
                      onClick={() => {
                        const roles = settings.roles.filter((entry) => entry.id !== role.id);
                        const activeRoleId =
                          settings.activeRoleId === role.id ? null : settings.activeRoleId;
                        if (editingRoleId === role.id) setEditingRoleId(null);
                        setRolesDirty(false);
                        void persist({ ...settings, roles, activeRoleId }, "已删除角色");
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {(() => {
          const editing = settings.roles.find((role) => role.id === editingRoleId) ?? null;
          if (!editing) return null;
          return (
            <div className="space-y-1.5 rounded-md bg-card/50 px-3 py-2 ring-1 ring-inset ring-primary/30">
              <p className="text-caption text-muted-foreground">正在编辑</p>
              <input
                className="field-input h-7 w-full"
                maxLength={CHAT_ROLE_NAME_MAX}
                disabled={saving}
                value={editing.name}
                placeholder="角色名称"
                onChange={(event) => {
                  const name = event.target.value.slice(0, CHAT_ROLE_NAME_MAX);
                  const roles = settings.roles.map((entry) =>
                    entry.id === editing.id ? { ...entry, name } : entry,
                  );
                  setSettings({ ...settings, roles });
                  setRolesDirty(true);
                }}
              />
              <textarea
                className="field-input min-h-[7rem] w-full resize-y text-caption leading-5"
                maxLength={CHAT_ROLE_PROMPT_MAX}
                disabled={saving}
                value={editing.prompt}
                placeholder="角色提示词：怎么说话、身份边界、绝不说的话…"
                onChange={(event) => {
                  const prompt = event.target.value.slice(0, CHAT_ROLE_PROMPT_MAX);
                  const roles = settings.roles.map((entry) =>
                    entry.id === editing.id ? { ...entry, prompt } : entry,
                  );
                  setSettings({ ...settings, roles });
                  setRolesDirty(true);
                }}
              />
              <p className="text-caption text-muted-foreground">
                {editing.prompt.length}/{CHAT_ROLE_PROMPT_MAX}
              </p>
            </div>
          );
        })()}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-outline btn-compact h-7"
            disabled={saving || settings.roles.length >= CHAT_ROLES_MAX}
            onClick={() => {
              const role: ChatRole = createChatRole();
              setSettings({
                ...settings,
                roles: [...settings.roles, role],
              });
              setEditingRoleId(role.id);
              setRolesDirty(true);
            }}
          >
            <Plus size={13} />
            添加角色
          </button>
          <button
            type="button"
            className="btn btn-primary btn-compact h-7"
            disabled={saving || !rolesDirty}
            onClick={() => {
              const roles = settings.roles.map((role) => ({
                ...role,
                name: role.name.trim() || "未命名角色",
              }));
              setRolesDirty(false);
              void persist({ ...settings, roles }, "角色已保存");
            }}
          >
            <Save size={13} />
            保存
          </button>
          <span className="text-caption text-muted-foreground">
            {settings.roles.length}/{CHAT_ROLES_MAX}
            {rolesDirty ? " · 有未保存的修改" : ""}
          </span>
        </div>
      </SettingsSection>

      <ChatSiteSupportSection saving={saving} onToast={onToast} onError={onError} />

      <SettingsSection
        icon={<EyeOff size={16} />}
        title="静音与红线（只读 · 可审计）"
        description="这些是聊天模式的硬约束，不提供开关。列在这里是让你能自己确认它到底会做什么、不会做什么。"
      >
        <ul className="space-y-1.5 text-caption leading-5 text-muted-foreground">
          <li className="flex gap-2">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
            <span>
              <strong className="text-foreground">全程不截图</strong>：聊天值守不拍全景、不拍截图，
              日志里也不会出现控件编号或验证码求解细节。
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
            <span>
              <strong className="text-foreground">不读验证码 / 不取短信码</strong>：聊天只处理会话文本；
              一次性验证码永不进入聊天草稿，也不会写进聊天记忆（写盘前会脱敏成 <code>[已脱敏]</code>）。
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
            <span>
              <strong className="text-foreground">不发支付 / 不转账</strong>：一旦对话里出现付款、转账、
              改密等意图，聊天会停下并交给人工确认，绝不自己动手。
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
            <span>
              <strong className="text-foreground">有消息即回 · 可连发</strong>：总开关开着时持续盯守，
              对方一说话就回；需要多句就把话说完。拒绝也不因红线停手（支付/验证码语义仍交人工）。
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
            <span>
              <strong className="text-foreground">与其它任务互斥</strong>：同一环境的 Agent / 轨迹回放 /
              填表与聊天共用一把锁，不会同时踩同一个浏览器。
            </span>
          </li>
        </ul>
        <p className="text-caption leading-5 text-muted-foreground">
          聊天记忆的清理入口在「浏览器」设置页的「聊天上下文」分区（可整环境或按环境清理）；
          单个联系人的清理在「聊天模式」视图的每张联系人卡片上。
        </p>
      </SettingsSection>
    </div>
  );
}
