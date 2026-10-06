import { listen } from "@tauri-apps/api/event";
import {
  Clock,
  MessageSquare,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_CHAT_MODE_SETTINGS,
  formatChatTargetsText,
  parseChatModeSettings,
  parseChatTargetsText,
  serializeChatModeSettings,
  takeoverKeyOf,
  toChatContactInputs,
  type ChatCadenceSettings,
  type ChatContactFlags,
  type ChatModeSettings,
  type ChatTargetDraft,
} from "../../lib/chatModeSettings";
import {
  loadAgentRuleLibrary,
  taskPolicyPayloadFromGoal,
  buildLaunchPreflight,
  type AgentPersona,
  type AgentPolicyPack,
  type AgentRule,
} from "../../lib/agentRules";
import { GoalMentionPreview } from "../GoalMentionPreview";
import { LaunchPreflightList, settingsHasAiKey } from "../LaunchPreflightList";
import {
  chatListContacts,
  chatPatrolResume,
  chatPatrolState,
  chatStart,
  chatStatus,
  chatStop,
  clearChatPatrolLogs,
  fetchRawSettings,
  formatInvokeError,
  listChatPatrolLogs,
  purgeChatContext,
  updateSetting,
} from "../../lib/tauri";
import { createToast, type ToastMessage } from "../../lib/toast";
import type {
  ChatContactsPayload,
  ChatPatrolReport,
  ChatStateEvent,
  ChatStatusPayload,
  ChatTakeoverMode,
  ChatThreadRow,
  Profile,
} from "../../types";
import { useAppDialog } from "../AppDialogProvider";
import { Modal } from "../Modal";
import { ContactCard, FlagToggle, formatRelative, USER_TAKEOVER_REASON } from "./contactCard";
import { formatChatEvent } from "./chatEventLabels";

/** 引擎相位 → 短中文（原相位只进值守日志） */
const PHASE_LABEL: Record<string, string> = {
  booting: "启动中",
  reading: "读会话",
  deciding: "想怎么回",
  composing: "写草稿",
  sending: "发送中",
  waiting: "等待中",
  paused: "已暂停",
  handover: "待人工",
  yielding: "让位中",
  stopped: "已停",
};

/** 状态带上一行可读的值守节奏摘要（主动追发已下线，只展示静默时段） */
function cadenceSummary(cadence: ChatCadenceSettings): string {
  if (cadence.quietHours) {
    return `夜间静默 ${cadence.quietHours.start}–${cadence.quietHours.end}`;
  }
  return "全天可聊 · 对方没回时只盯守不催";
}

interface ChatModeModalProps {
  open: boolean;
  onClose: () => void;
  profiles: Profile[];
  onError: (message: string) => void;
  onToast: (toast: ToastMessage) => void;
}

/**
 * 「聊天」——聊天模式的**独立视图**（§3.5 / §5.7）。
 *
 * 刻意不是右栏四个工作区之一，也不复用通用监视日志的分组：
 * 聊天是「慢、按天计、按人计」的活，混进 Agent 的逐步日志会让两边都读不清。
 * 这里只显示与聊天有关的事实：联系人阶段、流水、下次回访、被拦草稿、值守日志与清理入口。
 */
export function ChatModeModal({ open, onClose, profiles, onError, onToast }: ChatModeModalProps) {
  const dialog = useAppDialog();
  const [settings, setSettings] = useState<ChatModeSettings>(DEFAULT_CHAT_MODE_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [ruleLibrary, setRuleLibrary] = useState<{
    rules: AgentRule[];
    personas: AgentPersona[];
    packs: AgentPolicyPack[];
  }>({ rules: [], personas: [], packs: [] });
  const [hasAiKey, setHasAiKey] = useState(false);
  /** 「查看中」的环境：右侧的状态 / 联系人 / 日志都跟着它（永远是已勾选的环境之一） */
  const [profileId, setProfileId] = useState<string>("");
  /**
   * 已勾选的环境。多环境时：保存「要聊的人」会**一起写入**这几个环境，
   * 调度器随后按各自的下次回访时间分别拉起。只勾一个就是单环境。
   */
  const [configuredIds, setConfiguredIds] = useState<string[]>([]);
  /** 用户是否亲手动过勾选：动过之后就不再替他自动勾（否则「全部取消」会被刷新悄悄撤销） */
  const envTouchedRef = useRef(false);
  const [targetsText, setTargetsText] = useState("");
  const [status, setStatus] = useState<ChatStatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sliceBusy, setSliceBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [purgingKey, setPurgingKey] = useState<string | null>(null);
  /** 正在写入每联系人开关的联系人（`site|contact`） */
  const [flagsKey, setFlagsKey] = useState<string | null>(null);
  /** 「读取当前页面会话列表」的只读探针结果（null = 还没读过 / 已收起） */
  const [threads, setThreads] = useState<ChatContactsPayload | null>(null);
  const [threadsBusy, setThreadsBusy] = useState(false);
  const [threadPicked, setThreadPicked] = useState<Record<string, boolean>>({});
  /**
   * 列表里每行的「自动聊天」开关（键 = 侧车算好的 `flagKey`，**不是**视图自己拼的）。
   *
   * 为什么键要由侧车给：视图勾选后只回传 `label` / `url`，引擎那侧的键要用
   * `siteKeyOf` + `sanitizeSegment` 才算得出；前端自己拼一套迟早对不上，
   * 表现就是「在列表里关了自动聊天，引擎照样开口」（§0.5.3 H）。
   */
  const [threadFlags, setThreadFlags] = useState<Record<string, ChatContactFlags>>({});
  const [purgeAllBusy, setPurgeAllBusy] = useState(false);
  const [logLines, setLogLines] = useState<Array<{ at: string; text: string; tone: string }>>([]);
  const [patrol, setPatrol] = useState<ChatPatrolReport | null>(null);
  const [resumeBusy, setResumeBusy] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  /** 运行中的环境（可直接值守） */
  const runningProfiles = useMemo(
    () => profiles.filter((profile) => profile.status === "running"),
    [profiles],
  );
  const runningIds = useMemo(
    () => runningProfiles.map((profile) => String(profile.id)),
    [runningProfiles],
  );
  /**
   * 已保存过「要聊的人」、但浏览器停了的环境 —— 仍然列出来，看得见、清得了记忆。
   * 以前只列 running → 关掉浏览器整栏空了，联系人卡片跟着消失（鸡肋）。
   */
  const configuredOfflineProfiles = useMemo(() => {
    return profiles.filter((profile) => {
      if (profile.status === "running") return false;
      const id = String(profile.id);
      const saved = settings.targetsByEnv[id];
      return Array.isArray(saved) && saved.length > 0;
    });
  }, [profiles, settings.targetsByEnv]);
  /**
   * 左栏列表 = 运行中 + 已配置但停了的。
   * 按 id 去重（同名环境也会各自保留一行，右边标 #编号，避免「看起来像重复的同一条」说不清）。
   */
  const listedProfiles = useMemo(() => {
    const seen = new Set<string>();
    const rows: typeof profiles = [];
    for (const profile of [...runningProfiles, ...configuredOfflineProfiles]) {
      const id = String(profile.id);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(profile);
    }
    return rows;
  }, [runningProfiles, configuredOfflineProfiles]);
  /** 同名环境多于一个时，列表里要带上 #id，否则用户以为是重复 BUG */
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of listedProfiles) {
      const name = profile.name.trim() || `环境`;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
    );
  }, [listedProfiles]);
  const envLabel = useCallback(
    (profile: { id: string | number; name: string }) => {
      const name = profile.name.trim() || `环境 #${profile.id}`;
      if (duplicateNames.has(name)) return `${name} · #${profile.id}`;
      return name;
    },
    [duplicateNames],
  );
  const listedIds = useMemo(
    () => listedProfiles.map((profile) => String(profile.id)),
    [listedProfiles],
  );
  /** 勾选且仍在列表里 —— 保存对象 / 查看状态的作用范围（含已停的） */
  const selectedEnvIds = useMemo(
    () => configuredIds.filter((id) => listedIds.includes(id)),
    [configuredIds, listedIds],
  );
  /** 勾选过但既不在运行、也没有保存目标的：配置被清掉或环境被删了 */
  const orphanEnvIds = useMemo(
    () => configuredIds.filter((id) => !listedIds.includes(id)),
    [configuredIds, listedIds],
  );

  const profileName = useCallback(
    (id: string) => profiles.find((profile) => String(profile.id) === id)?.name ?? `环境 #${id}`,
    [profiles],
  );
  const selectedProfile = useMemo(
    () => profiles.find((profile) => String(profile.id) === profileId) ?? null,
    [profiles, profileId],
  );
  const envRow = useCallback(
    (id: string) => patrol?.envs.find((row) => row.profileId === id) ?? null,
    [patrol],
  );

  // ── 打开时载入持久化设置 ────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    envTouchedRef.current = false;
    let cancelled = false;
    (async () => {
      try {
        const raw = await fetchRawSettings();
        if (cancelled) return;
        const parsed = parseChatModeSettings(raw.chat_mode);
        setSettings(parsed.settings);
        setSettingsLoaded(true);
        setHasAiKey(
          settingsHasAiKey({
            ai_provider: raw.ai_provider,
            deepseek_api_key: raw.deepseek_api_key,
            zhipu_api_key: raw.zhipu_api_key,
            custom_api_key: raw.custom_api_key,
          }),
        );
        try {
          const library = await loadAgentRuleLibrary();
          if (!cancelled) {
            setRuleLibrary({ rules: library.rules, personas: library.personas, packs: library.packs });
          }
        } catch {
          /* 规则库读失败时仍可聊天，只是 @ 不会展开 */
        }
        if (parsed.diagnostics.length > 0) {
          // 配置被修正过就**先说**（§0.5.3 B：禁止静默降级）
          onToast(
            createToast("info", `聊天设置已自动修正：${parsed.diagnostics.join("；")}`),
          );
        }
      } catch (error) {
        if (!cancelled) onError(formatInvokeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, onError, onToast]);

  // 勾选集合跟着列表走；关掉浏览器的环境若还留着「要聊的人」仍保留勾选（看得见、管得了）
  useEffect(() => {
    if (!open) return;
    setConfiguredIds((current) => {
      const listed = new Set(listedIds);
      const kept = current.filter((id) => listed.has(id));
      if (kept.length > 0 || envTouchedRef.current) return kept;
      return runningIds.length > 0 ? [runningIds[0]] : listedIds[0] ? [listedIds[0]] : [];
    });
  }, [open, listedIds, runningIds]);

  // 「查看中」落在已勾选的环境里（含已停的：仍可看联系人 / 清记忆）
  useEffect(() => {
    if (!open) return;
    setProfileId((current) =>
      current && selectedEnvIds.includes(current) ? current : selectedEnvIds[0] ?? "",
    );
  }, [open, selectedEnvIds]);

  // 切换「查看中」的环境时，把该环境保存过的对象填回输入框
  // （顺带丢掉上一个环境的会话列表读数：列表是「某个页面此刻的样子」，跨环境复用会张冠李戴）
  useEffect(() => {
    setThreads(null);
    setThreadPicked({});
    setThreadFlags({});
    if (!settingsLoaded || !profileId) return;
    const saved = settings.targetsByEnv[profileId];
    setTargetsText(saved ? formatChatTargetsText(saved) : "");
  }, [settingsLoaded, profileId, settings.targetsByEnv]);

  const refreshStatus = useCallback(async () => {
    if (!profileId) return;
    try {
      const next = await chatStatus(profileId);
      setStatus(next);
      setStatusError(null);
    } catch (error) {
      setStatusError(formatInvokeError(error));
    }
  }, [profileId]);

  useEffect(() => {
    if (!open || !profileId) return;
    setStatus(null);
    void refreshStatus();
    // 值守期间要看到进展；空闲时降频（读的是小文件 + 索引表，不是轮询浏览器）
    const interval = window.setInterval(() => {
      void refreshStatus();
    }, status?.running ? 5_000 : 15_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [open, profileId, refreshStatus, status?.running]);

  const refreshPatrol = useCallback(async () => {
    try {
      setPatrol(await chatPatrolState());
    } catch (error) {
      // 调度器状态读不到不该挡住聊天视图：只在日志区提示，不弹错
      setLogLines((current) => [
        ...current,
        {
          at: new Date().toLocaleTimeString(),
          text: `调度器状态读取失败 · ${formatInvokeError(error)}`,
          tone: "text-warning",
        },
      ]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshPatrol();
    // 调度 tick 是 60s；15s 轮询足够让用户看到「排队 / 受阻 / 挂起」的变化
    const interval = window.setInterval(() => {
      void refreshPatrol();
    }, 15_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [open, refreshPatrol]);

  const handleResume = async (targetProfileId: string) => {
    setResumeBusy(targetProfileId);
    try {
      const next = await chatPatrolResume(targetProfileId);
      setPatrol(next);
      onToast(createToast("success", `已恢复环境 #${targetProfileId} 的自动聊天`));
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setResumeBusy(null);
    }
  };

  useEffect(() => {
    if (!open || !profileId) {
      setLogLines([]);
      return;
    }
    let cancelled = false;
    void listChatPatrolLogs(profileId, 300)
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setLogLines(
          rows
            .map((row) => {
              const formatted = formatChatEvent({ kind: row.kind, msg: row.text });
              if (!formatted.showInLog) {
                return null;
              }
              const atRaw = row.at || row.createdAt;
              let at = atRaw;
              const parsed = Date.parse(atRaw.includes("T") ? atRaw : atRaw.replace(" ", "T"));
              if (!Number.isNaN(parsed)) {
                at = new Date(parsed).toLocaleTimeString();
              }
              return { at, text: formatted.text, tone: formatted.tone || row.tone };
            })
            .filter((row): row is { at: string; text: string; tone: string } => Boolean(row)),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setLogLines([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, profileId]);

  // ── 独立事件流：只收 chat-state（B8 / §5.7）────────────────────────────
  // 只显示「查看中」那个环境：聊天日志要能跟环境对上号，混着所有环境读不出「这一台在干什么」。
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<ChatStateEvent>("chat-state", (event) => {
      const payload = event.payload ?? {};
      const eventProfileId = String(payload.profileId ?? "");
      if (!profileId || (eventProfileId && eventProfileId !== profileId)) {
        return;
      }
      setLogLines((current) => {
        const formatted = formatChatEvent(payload);
        if (!formatted.showInLog) return current;
        const next = [
          ...current,
          { at: new Date().toLocaleTimeString(), text: formatted.text, tone: formatted.tone },
        ];
        return next.length > 300 ? next.slice(-300) : next;
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [open, profileId]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  const persistSettings = async (patch: Partial<ChatModeSettings>, successToast?: string) => {
    const previous = settings;
    let next: ChatModeSettings = { ...settings, ...patch };
    if (patch.goal !== undefined) {
      const policy = taskPolicyPayloadFromGoal(next.goal, ruleLibrary.rules, ruleLibrary.personas, ruleLibrary.packs);
      next = { ...next, taskRules: policy.taskRules, taskPersona: policy.taskPersona };
    }
    setSettings(next);
    try {
      await updateSetting("chat_mode", serializeChatModeSettings(next));
      if (successToast) onToast(createToast("success", successToast));
    } catch (error) {
      // 写盘失败就把界面**退回真实状态**：不能让开关 / 徽章显示一个并不生效的值
      setSettings(previous);
      onError(formatInvokeError(error));
    }
  };

  const targets = useMemo(() => parseChatTargetsText(targetsText), [targetsText]);
  const chatMentions = useMemo(
    () =>
      taskPolicyPayloadFromGoal(settings.goal, ruleLibrary.rules, ruleLibrary.personas, ruleLibrary.packs)
        .mentions,
    [settings.goal, ruleLibrary],
  );
  const chatPreflight = useMemo(
    () =>
      buildLaunchPreflight({
        browserRunning: status?.browserRunning !== false && Boolean(profileId),
        engineBusy: sliceBusy,
        hasAiKey,
        goal: settings.goal,
        mentions: chatMentions,
        requireGoal: false,
        ...(targets.length > 0 || settings.useCurrentWindow ? { chatTargetOk: true } : {}),
      }),
    [
      status?.browserRunning,
      profileId,
      sliceBusy,
      hasAiKey,
      settings.goal,
      settings.useCurrentWindow,
      chatMentions,
      targets.length,
    ],
  );
  const suspendedRows = useMemo(
    () => (patrol?.envs ?? []).filter((row) => row.suspended),
    [patrol],
  );
  /**
   * **设置叠在快照之上**（§3.5）：接管 / 自动聊天以设置为准、立刻反映在卡片上。
   * 正在跑的片仍按片启动时读进引擎的旧值跑完；下一片生效。
   */
  const effectiveContacts = useMemo(() => {
    const rows = status?.contacts ?? [];
    return rows.map((row) => {
      const key = takeoverKeyOf(row.siteKey, row.contactKey);
      const flags = settings.contactFlags[key];
      const takeoverOverride = settings.takeovers[key];
      const takeover = takeoverOverride ?? row.takeover;
      return {
        ...row,
        takeover,
        takeoverReason:
          takeoverOverride && takeoverOverride !== "engine"
            ? USER_TAKEOVER_REASON
            : takeoverOverride === "engine"
              ? null
              : row.takeoverReason,
        autoReply: flags?.autoReply ?? row.autoReply,
        followUp: flags?.followUp ?? row.followUp,
      };
    });
  }, [status, settings.contactFlags, settings.takeovers]);

  const toggleEnv = useCallback(
    (id: string) => {
      envTouchedRef.current = true;
      const has = configuredIds.includes(id);
      const next = has ? configuredIds.filter((item) => item !== id) : [...configuredIds, id];
      setConfiguredIds(next);
      if (!has) {
        // 勾选即把「查看中」切到它：刚点的那个总是此刻想看的
        setProfileId(id);
      } else if (profileId === id) {
        // 取消勾选后，右侧只显示还勾着的环境（不做「查看一个不参与保存的环境」这种含混状态）
        setProfileId(next[0] ?? "");
      }
    },
    [configuredIds, profileId],
  );

  /** 把当前「要聊的人」（含手填原文）写入已勾选的环境 */
  const handleSave = async () => {
    if (selectedEnvIds.length === 0) {
      onError("请先勾选至少一个环境：名单是保存到这些环境上的。");
      return;
    }
    const nextText = formatChatTargetsText(targets);
    // 覆盖别的环境已存的对象要先问一声（不静默改用户配置）
    const overwritten = selectedEnvIds.filter((id) => {
      const saved = settings.targetsByEnv[id];
      if (!saved || saved.length === 0) return false;
      return formatChatTargetsText(saved) !== nextText;
    });
    if (overwritten.length > 0) {
      const ok = await dialog.confirm({
        title: "覆盖已保存的聊天对象",
        description:
          `${overwritten.map(profileName).join("、")} 已经存过另一批对象，保存后会被这 ${targets.length} 位替换` +
          `（已经聊出来的记忆不受影响，只换「要聊谁」）。确定覆盖？`,
        confirmLabel: "覆盖并保存",
      });
      if (!ok) return;
    }
    const targetsByEnv = { ...settings.targetsByEnv };
    for (const id of selectedEnvIds) {
      targetsByEnv[id] = targets;
    }
    setSaving(true);
    try {
      await persistSettings(
        { targetsByEnv },
        `已保存要聊的人 · 写给 ${selectedEnvIds.map(profileName).join("、")}（各 ${targets.length} 位）`,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async () => {
    if (!profileId) {
      onError("请先在左侧勾选一个环境。");
      return;
    }
    if (status && status.browserRunning === false) {
      onError("该环境的浏览器已停：请先在左侧启动环境，再开始聊天。已停时仍可查看与清理联系人记忆。");
      return;
    }
    if (targets.length === 0 && !settings.useCurrentWindow) {
      onError(
        "请先指定要聊的人：在左侧「要聊的人」里点「读取会话列表」勾选并保存；或在「手动填写（高级）」里每行写「昵称 | 会话URL」。",
      );
      return;
    }
    if (targets.length === 0) {
      // 没指定对象时只能靠「当前打开的窗口」，而那条路要求窗口里**已经点开了一个会话**
      const ok = await dialog.confirm({
        title: "还没指定要聊的人",
        description:
          "你没有勾选任何聊天对象。这次会使用你此刻打开的聊天窗口 —— 但那个窗口里必须" +
          "已经点开了一个具体会话（停在会话列表页会直接结束，什么都不会做）。要继续吗？",
        confirmLabel: "用当前窗口继续",
      });
      if (!ok) return;
    }
    setSliceBusy(true);
    try {
      // 目标随环境保存，下次打开自动恢复（也进预检口径：用户看到的就是要执行的）
      await persistSettings({ targetsByEnv: { ...settings.targetsByEnv, [profileId]: targets } });
      const policy = taskPolicyPayloadFromGoal(settings.goal, ruleLibrary.rules, ruleLibrary.personas, ruleLibrary.packs);
      const result = await chatStart({
        profileId,
        contacts: toChatContactInputs(targets),
        // 目标为空时用「当前打开的聊天窗口」：由 Sidecar 运行期判定那确实是聊天页（判不出来就如实失败）
        useCurrentWindow: targets.length === 0,
        goal: settings.goal,
        styleHint: settings.styleHint,
        bannedWords: settings.bannedWords,
        cadence: settings.cadence,
        takeovers: settings.takeovers,
        contactFlags: settings.contactFlags,
        roles: settings.roles,
        activeRoleId: settings.activeRoleId,
        mediaLibraryDir: settings.mediaLibraryDir,
        sliceMs: settings.sliceMs,
        maxContactsPerSlice: settings.maxContactsPerSlice,
        taskRules: policy.taskRules,
        taskPersona: policy.taskPersona,
      });
      const actions = (result.actions ?? {}) as Record<string, unknown>;
      const summary =
        result.state === "complete"
          ? `这一片结束：处理 ${actions.processed ?? 0} 位、发送 ${actions.sent ?? 0} 条、跳过 ${actions.skipped ?? 0} 项`
          : `未跑成：${result.msg || "未知原因"}`;
      onToast(createToast(result.state === "complete" ? "success" : "info", summary));
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setSliceBusy(false);
      await refreshStatus();
      await refreshPatrol();
    }
  };

  const handleStop = async () => {
    if (!profileId) return;
    setStopping(true);
    try {
      await chatStop(profileId, "user_stop");
      onToast(createToast("success", "已请求停止聊天值守"));
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setStopping(false);
      await refreshStatus();
      await refreshPatrol();
    }
  };

  /**
   * 每联系人「自动聊天」开关（`contactFlags`）。`followUp` 字段仍可写入兼容，引擎不读。
   * 正在跑的片是**片启动时**读进引擎的，所以这里只写设置，并如实说明「下一片生效」。
   * **未设置＝开**：两项都开时删掉该键，不把默认值写死进设置。
   */
  const handleToggleFlags = async (
    contact: ChatThreadRow,
    field: "autoReply" | "followUp",
    next: boolean,
  ) => {
    const key = takeoverKeyOf(contact.siteKey, contact.contactKey);
    setFlagsKey(key);
    try {
      const current = settings.contactFlags[key] ?? {};
      const contactFlags = { ...settings.contactFlags };
      const merged: ChatContactFlags = { ...current, [field]: next };
      // 开＝缺省：删掉 true，只保留显式 false
      if (merged.autoReply !== false) delete merged.autoReply;
      else merged.autoReply = false;
      if (merged.followUp !== false) delete merged.followUp;
      else merged.followUp = false;
      if (Object.keys(merged).length === 0) delete contactFlags[key];
      else contactFlags[key] = merged;
      await persistSettings({ contactFlags });
      const label = contact.contactLabel || contact.contactKey;
      const fieldLabel = field === "autoReply" ? "自动聊天" : "主动追发（已下线）";
      onToast(
        createToast(
          "success",
          `「${label}」的${fieldLabel}已${next ? "打开" : "关闭"}` +
            (status?.running ? "（正在跑的片仍按旧值跑完，下一片生效）" : ""),
        ),
      );
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setFlagsKey(null);
    }
  };

  /** 每联系人「引擎值守 / 我接管」（写 `takeovers`；交还时删键＝默认引擎） */
  const handleToggleTakeover = async (contact: ChatThreadRow, next: ChatTakeoverMode) => {
    const key = takeoverKeyOf(contact.siteKey, contact.contactKey);
    setFlagsKey(key);
    try {
      const takeovers = { ...settings.takeovers };
      if (next === "engine") delete takeovers[key];
      else takeovers[key] = next;
      await persistSettings({ takeovers });
      const label = contact.contactLabel || contact.contactKey;
      onToast(
        createToast(
          "success",
          next === "engine"
            ? `「${label}」已交还引擎值守` +
              (status?.running ? "（下一片生效）" : "")
            : `「${label}」已由你接管：引擎只记账、不开口` +
              (status?.running ? "（下一片生效）" : ""),
        ),
      );
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setFlagsKey(null);
    }
  };

  /**
   * 「读取会话列表」——**只读**探针（`chat_list_contacts`）。
   *
   * 读的是「查看中」那个环境此刻打开的聊天页；读不到就如实说原因（读不到 ≠ 列表是空的）。
   * 读回来的东西做两件事：勾选后并入「要聊的人」，以及给每行配「自动聊天」开关。
   *
   * `quiet` = 打开视图时自动读的那一次：失败不弹错（环境可能在跑值守 / 页面还没打开），
   * 只把原因写在面板里；用户手动点按钮时仍然弹提示。
   */
  const handleReadThreads = async (quiet = false) => {
    if (!profileId) return;
    setThreadsBusy(true);
    try {
      const result = await chatListContacts(profileId);
      setThreads(result);
      // 默认全勾：用户点「读取」多半就是想把这一批都用上，取消勾选比逐个勾更省事
      setThreadPicked(Object.fromEntries(result.items.map((item) => [item.key, true])));
      // 开关初值 = **此刻真正生效的值**：设置里写过就用设置里的；设置里没有、但这几位
      // 已经有联系人卡片（跑过片）就用卡片上的有效值；两者都没有＝默认开（缺省＝开）。
      const cards = new Map(
        (status?.contacts ?? []).map((row) => [
          takeoverKeyOf(row.siteKey, row.contactKey),
          row,
        ]),
      );
      const nextFlags: Record<string, ChatContactFlags> = {};
      for (const item of result.items) {
        if (!item.flagKey) continue;
        const saved = settings.contactFlags[item.flagKey];
        const card = cards.get(item.flagKey);
        nextFlags[item.flagKey] = {
          autoReply: saved?.autoReply ?? (card ? card.autoReply !== false : true),
          followUp: saved?.followUp ?? (card ? card.followUp !== false : true),
        };
      }
      setThreadFlags(nextFlags);
      if (quiet) return;
      if (!result.ok) {
        onToast(createToast("info", `没读到会话列表：${result.reason ?? "未知原因"}`));
      } else if (result.items.length === 0) {
        onToast(createToast("info", "读到的列表是空的：这个页面可能还没渲染出会话列表。"));
      }
    } catch (error) {
      const message = formatInvokeError(error);
      if (quiet) {
        // 自动读失败不打扰：把原因摆在面板里（用户想看就看得到），不弹错
        setThreads({
          ok: false,
          reason: message,
          source: "generic",
          siteKey: "",
          pageUrl: null,
          items: [],
        });
      } else {
        onError(message);
      }
    } finally {
      setThreadsBusy(false);
    }
  };

  /**
   * 打开视图 / 换「查看中」的环境时**自动读一次**会话列表。
   *
   * 这就是用户要的「自动获取聊天列表」：不必先猜到有个按钮要点。只读探针，
   * 不点击 / 不导航 / 不滚动；环境正跑着值守时会被宿主拒（quiet 模式下如实写在面板里）。
   */
  const autoReadKeyRef = useRef<string>("");
  useEffect(() => {
    if (!open) {
      autoReadKeyRef.current = "";
      return;
    }
    if (!profileId || !settingsLoaded) return;
    if (autoReadKeyRef.current === profileId) return;
    autoReadKeyRef.current = profileId;
    void handleReadThreads(true);
    // `handleReadThreads` 每次渲染都会重建，但这里靠 `autoReadKeyRef` 保证「每个环境只自动读一次」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profileId, settingsLoaded]);

  /** 列表里一行的开关：只改本地草稿，点「保存为要聊的人」时一起写进设置 */
  const toggleThreadFlag = useCallback(
    (flagKey: string, field: "autoReply" | "followUp", next: boolean) => {
      setThreadFlags((current) => ({
        ...current,
        [flagKey]: { ...current[flagKey], [field]: next },
      }));
    },
    [],
  );

  const allThreadItemsPicked = useMemo(() => {
    if (!threads?.ok || threads.items.length === 0) return false;
    return threads.items.every((item) => threadPicked[item.key] === true);
  }, [threads, threadPicked]);

  const toggleAllThreadPicks = useCallback(() => {
    if (!threads?.items.length) return;
    if (allThreadItemsPicked) {
      setThreadPicked({});
    } else {
      setThreadPicked(Object.fromEntries(threads.items.map((item) => [item.key, true])));
    }
  }, [threads, allThreadItemsPicked]);

  /**
   * 把勾选的会话**保存为「要聊的人」**：立刻写进所选环境的 `targetsByEnv`
   * （已在列表里的按 `URL`/昵称去重，不覆盖用户手写的内容），并把每行的「自动聊天」
   * **立刻写进设置**（`contactFlags`，与联系人卡片同一套键与来源）。
   *
   * 为什么要在这里就落盘（而不是只填进输入框等「保存配置」）：用户的心智是「我勾好了，
   * 就开始聊」——多一步「再点保存」只会让人以为没生效。保存范围就是左侧勾选的环境，
   * 一个都没勾时**直接拒绝**并说清要先勾环境（不静默写进没人知道的地方）。
   *
   * 只写「与默认不同」的偏差（两项都开＝把这条删掉，未设置就是开），没勾选的行**不动**——
   * 取消勾选只表示「这次不作为目标」，不代表要改那位的开关。
   */
  const handleApplyThreads = async () => {
    if (!threads) return;
    if (selectedEnvIds.length === 0) {
      onError("请先在左侧勾选至少一个运行中的环境：要聊的人与开关都是保存到环境上的。");
      return;
    }
    const picked = threads.items.filter((item) => threadPicked[item.key]);
    if (picked.length === 0) {
      onError("请至少勾选一位要聊的人。");
      return;
    }
    const merged: ChatTargetDraft[] = [...targets];
    const seen = new Set(targets.map((target) => target.url || target.label));
    let added = 0;
    for (const item of picked) {
      const identity = item.url || item.label;
      if (seen.has(identity)) continue;
      seen.add(identity);
      merged.push({ label: item.label, url: item.url ?? "" });
      added += 1;
    }
    setTargetsText(formatChatTargetsText(merged));

    const contactFlags: Record<string, ChatContactFlags> = { ...settings.contactFlags };
    let flagChanges = 0;
    for (const item of picked) {
      if (!item.flagKey) continue;
      const want = threadFlags[item.flagKey];
      if (!want) continue;
      const next: ChatContactFlags = {};
      if (want.autoReply === false) next.autoReply = false;
      if (want.followUp === false) next.followUp = false;
      if (JSON.stringify(contactFlags[item.flagKey] ?? {}) === JSON.stringify(next)) continue;
      if (Object.keys(next).length > 0) contactFlags[item.flagKey] = next;
      else delete contactFlags[item.flagKey];
      flagChanges += 1;
    }

    const targetsByEnv = { ...settings.targetsByEnv };
    for (const id of selectedEnvIds) {
      targetsByEnv[id] = merged;
    }
    await persistSettings(
      { targetsByEnv, contactFlags },
      `要聊的人已保存给 ${selectedEnvIds.map(profileName).join("、")}（共 ${merged.length} 位` +
        (added > 0 ? `，新增 ${added} 位` : "") +
        (flagChanges > 0 ? `；${flagChanges} 位的开关也已记住` : "") +
        `）。保存后点右侧「开始聊天」即可`,
    );
    // 列表**留在屏幕上**：用户刚勾完就能看到结果，要改哪里接着改（不必再点一次读取）
  };

  /**
   * 从「要聊的人」里移除一位（徽章上的 ×）：**立刻**落盘，与保存选择同一套范围与口径。
   *
   * 为什么必须有这条出路：列表里的应用是**只增不删**的合并（不静默丢弃用户已存的对象），
   * 没有 × 的话「选错一个人」就只能去折叠的手填框里改 —— 那又是一条死路。
   */
  const removeTarget = async (target: ChatTargetDraft) => {
    if (selectedEnvIds.length === 0) {
      onError("请先在左侧勾选至少一个环境：要聊的人是保存到环境上的。");
      return;
    }
    const identity = target.url || target.label;
    const next = targets.filter((item) => (item.url || item.label) !== identity);
    setTargetsText(formatChatTargetsText(next));
    const targetsByEnv = { ...settings.targetsByEnv };
    for (const id of selectedEnvIds) {
      targetsByEnv[id] = next;
    }
    await persistSettings({ targetsByEnv }, `已把「${target.label}」从要聊的人里移除`);
  };

  const handlePurgeContact = async (contact: ChatThreadRow) => {
    if (!profileId) return;
    if (running) {
      onError("聊天值守正在进行：请先点右上角「停止」，再清理这位联系人的记忆。");
      return;
    }
    const ok = await dialog.confirm({
      title: `清理「${contact.contactLabel || contact.contactKey}」的聊天记忆`,
      description:
        `将删除这位联系人的会话流水（${contact.messageCount} 条）、滚动摘要、已用角度、长期事实与回访计划，` +
        `并从「要聊的人」里移除。聊天将从零开始，且不可恢复。其它联系人与环境配置、Cookie 不受影响。确定继续？`,
      confirmLabel: "删除该联系人",
      tone: "danger",
    });
    if (!ok) return;
    setPurgingKey(takeoverKeyOf(contact.siteKey, contact.contactKey));
    try {
      const report = await purgeChatContext(profileId, {
        siteKey: contact.siteKey,
        contactKey: contact.contactKey,
      });
      // 记忆清掉后，把同一个人从「要聊的人」里摘掉（否则徽章还在，像没删干净）
      const label = String(contact.contactLabel || contact.contactKey || "").trim();
      const nextTargets = targets.filter((item) => {
        const sameLabel = label && item.label === label;
        return !sameLabel;
      });
      if (nextTargets.length !== targets.length) {
        setTargetsText(formatChatTargetsText(nextTargets));
        const targetsByEnv = { ...settings.targetsByEnv };
        for (const id of selectedEnvIds.length > 0 ? selectedEnvIds : [profileId]) {
          targetsByEnv[id] = nextTargets;
        }
        await persistSettings({ targetsByEnv });
      }
      onToast(
        createToast(
          report.removedDirs > 0 ? "success" : "info",
          report.removedDirs > 0
            ? `已删除「${contact.contactLabel || contact.contactKey}」（${report.details.join("；")}）`
            : `没有可清理的内容：${report.details.join("；")}`,
        ),
      );
      await refreshStatus();
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setPurgingKey(null);
    }
  };

  const handlePurgeEnv = async () => {
    if (!profileId) return;
    if (running) {
      onError("聊天值守正在进行：请先点「停止」，再清理本环境记忆。");
      return;
    }
    const label = selectedProfile?.name ?? profileId;
    const total = status?.contacts.length ?? 0;
    const ok = await dialog.confirm({
      title: `清理「${label}」的全部聊天记忆`,
      description:
        `将删除该环境全部 ${total} 位联系人的聊天记忆（会话流水、摘要、已用角度、长期事实、回访计划）。` +
        `这些联系人会从零开始，且不可恢复。环境本身的配置与 Cookie 不受影响。确定继续？`,
      confirmLabel: "删除全部聊天记忆",
      tone: "danger",
    });
    if (!ok) return;
    setPurgeAllBusy(true);
    try {
      const report = await purgeChatContext(profileId);
      onToast(
        createToast("success", `已清理「${label}」的聊天记忆（${report.removedDirs} 个目录）`),
      );
      await refreshStatus();
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setPurgeAllBusy(false);
    }
  };

  const phase = status?.snapshot?.phase ?? "stopped";
  const running = status?.running === true;

  return (
    <Modal
      open={open}
      title="聊天模式"
      description="独立值守窗口（不是右侧 Ai Chat）。左边勾环境与要聊的人，右边看联系人与日志；有消息就回。"
      onClose={onClose}
      widthClass="max-w-6xl"
      badge={<MessageSquare size={16} />}
    >
      {/* ── 状态带：总开关 / 节奏 / 自动聊天 / 角色 ─────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className={`badge ${settings.enabled ? "badge-success" : "badge-warning"}`}>
          总开关{settings.enabled ? "已开" : "关闭"}
        </span>
        <button
          type="button"
          className={`btn btn-compact h-6 ${settings.enabled ? "btn-ghost" : "btn-primary"}`}
          onClick={() =>
            void persistSettings(
              { enabled: !settings.enabled },
              settings.enabled ? "聊天模式已关闭" : "聊天模式已启用",
            )
          }
        >
          <Power size={11} />
          {settings.enabled ? "关闭" : "打开总开关"}
        </button>
        <span
          className="badge"
          title="对方没回时只盯守、不催；夜间静默可在「设置 → 聊天」里改"
        >
          {cadenceSummary(settings.cadence)}
        </span>
        <span className={`badge ${patrol?.enabled ? "badge-success" : "badge"}`}>
          自动聊天 {patrol?.enabled ? "已开" : "未开"}
        </span>
        <label
          className="flex items-center gap-1.5 text-caption text-muted-foreground"
          title="用哪个角色聊天（增删改请到「设置 → 聊天」）"
        >
          <span className="shrink-0">角色</span>
          <select
            className="field-input h-6 min-w-[7rem] py-0 text-caption"
            value={settings.activeRoleId ?? ""}
            onChange={(event) => {
              const next = event.target.value.trim();
              void persistSettings(
                { activeRoleId: next || null },
                next
                  ? `当前角色：${settings.roles.find((role) => role.id === next)?.name ?? next}`
                  : "已取消角色",
              );
            }}
          >
            <option value="">无角色</option>
            {settings.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-compact ml-auto h-6"
          onClick={() => {
            void refreshStatus();
            void refreshPatrol();
          }}
        >
          <RefreshCw size={11} />
          刷新
        </button>
      </div>

      {!settings.enabled ? (
        <p className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-caption leading-5 text-warning ring-1 ring-inset ring-warning/30">
          总开关关闭时不能聊天：手动点「开始聊天」也会被拒绝，也不会到点自动聊。
          要开始，先点上面的「打开总开关」。
        </p>
      ) : null}

      <div className="max-h-[74vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
          {/* ── 左：设定 ──────────────────────────────────────────────── */}
          <div className="space-y-3">
            <section className="well p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="section-title">环境</p>
                <span className="text-caption text-muted-foreground">
                  已选 {selectedEnvIds.length}
                </span>
              </div>
              {listedProfiles.length === 0 ? (
                <p className="text-caption leading-5 text-muted-foreground">
                  还没有可管的环境。请先在左侧启动要用的浏览器；聊过之后即使关掉浏览器，这里也会继续显示，方便清理记忆。
                </p>
              ) : (
                <ul className="space-y-1">
                  {listedProfiles.map((profile) => {
                    const id = String(profile.id);
                    const checked = configuredIds.includes(id);
                    const saved = settings.targetsByEnv[id]?.length ?? 0;
                    const row = envRow(id);
                    const offline = profile.status !== "running";
                    return (
                      <li key={id}>
                        <label
                          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
                            checked ? "row-selected" : "row-selectable"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleEnv(id)}
                          />
                          <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                            {envLabel(profile)}
                          </span>
                          {id === profileId ? <span className="badge badge-primary">查看中</span> : null}
                          {offline ? <span className="badge badge-warning">已停</span> : null}
                          {row?.active ? <span className="badge badge-success">值守中</span> : null}
                          {row?.suspended ? <span className="badge badge-warning">已挂起</span> : null}
                          <span className="badge" title="这个环境已保存的对象数">
                            {saved} 位
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="field-hint mt-2">
                勾选的环境会一起收到下面的「要聊的人」；点某一行即可在右侧查看状态、联系人与日志。
                浏览器已停的环境仍可查看与清理记忆，但不能开始聊天。
                {duplicateNames.size > 0
                  ? " 同名环境已标上编号（#…），方便区分。"
                  : ""}
              </p>
              {orphanEnvIds.length > 0 ? (
                <p className="mt-1.5 rounded bg-warning/10 px-2 py-1.5 text-caption leading-4 text-warning ring-1 ring-inset ring-warning/30">
                  {orphanEnvIds.map(profileName).join("、")} 已不在列表里（环境被删或目标已空），勾选已忽略。
                </p>
              ) : null}
            </section>

            <section className="well p-3">
              <p className="section-title mb-2">值守目标</p>
              <p className="field-hint mb-2">
                可写 @规则名 / @人设名（与 Agent 同一套库）。没写 @ 就不套规则，避免莫名其妙改行为。
              </p>
              <textarea
                className="field-input min-h-[64px] w-full resize-y px-2 py-1.5 text-ui leading-5"
                value={settings.goal}
                disabled={!settingsLoaded}
                placeholder="例如：约线下看展 @客服口吻"
                onChange={(event) => setSettings((current) => ({ ...current, goal: event.target.value }))}
                onBlur={() => void persistSettings({ goal: settings.goal })}
              />
              <div className="mt-1.5">
                <GoalMentionPreview
                  mentions={
                    taskPolicyPayloadFromGoal(
                      settings.goal,
                      ruleLibrary.rules,
                      ruleLibrary.personas,
                      ruleLibrary.packs,
                    ).mentions
                  }
                  emptyHint="当前目标没有有效 @，值守只用下面选的角色说话。"
                />
                <LaunchPreflightList items={chatPreflight.items} />
              </div>
            </section>

            <section className="well p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="section-title">要聊的人</p>
                <span className="text-caption text-muted-foreground">
                  已保存 {targets.length} 位
                </span>
              </div>
              <p className="field-hint mb-2">
                步骤：读取会话列表 → 勾选要聊的人 →「保存为要聊的人」→ 右侧点「开始聊天」。
              </p>

              {/* ── 主路径：读会话列表 → 勾选 → 保存（打开本视图时会自动读一次） ── */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-outline btn-compact h-7"
                  disabled={threadsBusy || !profileId}
                  onClick={() => void handleReadThreads(false)}
                >
                  <Users size={12} />
                  {threadsBusy ? "读取中…" : threads ? "重新读取会话列表" : "读取会话列表"}
                </button>
                <span className="field-hint">
                  {profileId
                    ? "读「查看中」那个环境此刻打开着的聊天页；打开本窗口时会自动读一次。"
                    : "先在左侧勾选一个运行中的环境。"}
                </span>
              </div>
              {threads ? (
                <div className="mt-2 rounded-md bg-card/50 px-2 py-2 ring-1 ring-inset ring-border-strong/30">
                  {!threads.ok ? (
                    <p className="text-caption leading-5 text-warning">
                      读不到会话列表：{threads.reason ?? "未知原因"}
                      （最常见两种：这个环境没有开着聊天页；或它正在跑值守 —— 跑了就等它结束再读）
                    </p>
                  ) : threads.items.length === 0 ? (
                    <p className="text-caption leading-5 text-muted-foreground">
                      列表是空的：页面可能还没渲染出会话列表，等它加载完再读一次。
                    </p>
                  ) : (
                    <>
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <p className="min-w-0 flex-1 text-caption leading-4 text-muted-foreground">
                          来源：
                          {threads.source === "descriptor"
                            ? "站点描述符（可靠）"
                            : "通用启发式（可能读不全，请核对）"}
                          {threads.pageUrl ? ` · ${threads.pageUrl}` : ""}
                        </p>
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact h-6 text-caption"
                          disabled={threads.items.length === 0}
                          onClick={toggleAllThreadPicks}
                        >
                          {allThreadItemsPicked ? "取消全选" : "全选"}
                        </button>
                      </div>
                      <ul className="max-h-[min(28rem,50vh)] min-h-52 space-y-1 overflow-y-auto">
                        {threads.items.map((item) => {
                          const flags = threadFlags[item.flagKey];
                          const autoReply = flags?.autoReply !== false;
                          const picked = threadPicked[item.key] === true;
                          return (
                            <li
                              key={item.key}
                              className={`rounded px-1.5 py-1 ${
                                picked
                                  ? "row-selected"
                                  : "ring-1 ring-inset ring-border-strong/20"
                              }`}
                            >
                              <label className="flex cursor-pointer items-center gap-2 text-caption">
                                <input
                                  type="checkbox"
                                  checked={picked}
                                  onChange={() =>
                                    setThreadPicked((current) => ({
                                      ...current,
                                      [item.key]: !current[item.key],
                                    }))
                                  }
                                />
                                <span className="min-w-0 flex-1 truncate text-foreground">
                                  {item.label}
                                </span>
                                {item.unread ? (
                                  <span className="badge badge-primary">未读</span>
                                ) : null}
                                {item.url ? (
                                  <span className="max-w-[38%] shrink-0 truncate text-[10px] text-muted-foreground/70">
                                    {item.url}
                                  </span>
                                ) : null}
                              </label>
                              <div className="mt-1 flex flex-wrap items-center gap-3 pl-6">
                                <FlagToggle
                                  label="自动聊天"
                                  hint="这位要不要自动聊：开场搭话 + 对方来消息时回话"
                                  checked={autoReply}
                                  disabled={!item.flagKey}
                                  onChange={(next) =>
                                    toggleThreadFlag(item.flagKey, "autoReply", next)
                                  }
                                />
                                {!autoReply ? (
                                  <span className="text-caption leading-4 text-warning">
                                    关着＝引擎不会主动开口
                                  </span>
                                ) : null}
                                {!item.flagKey ? (
                                  <span className="text-caption leading-4 text-warning">
                                    这一行算不出稳定身份，开关用不了（仍可加入对象）
                                  </span>
                                ) : null}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="btn btn-primary btn-compact h-6 text-caption"
                          onClick={() => void handleApplyThreads()}
                        >
                          保存为要聊的人
                        </button>
                        <span className="text-caption text-muted-foreground">
                          已勾{" "}
                          {threads.items.filter((item) => threadPicked[item.key]).length} /{" "}
                          {threads.items.length}
                        </span>
                        <span className="text-caption leading-4 text-muted-foreground">
                          勾选＝要聊这位；点「保存为要聊的人」后立刻写进上方勾选的环境。怎么说话看上方「角色」。
                        </span>
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {/* 已保存的选择：让人一眼看到「引擎到底会跟谁聊」，并可就地移除（×）*/}
              {targets.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1">
                  {targets.slice(0, 24).map((target) => (
                    <li
                      key={target.url || target.label}
                      className="badge flex max-w-full items-center gap-1"
                      title={target.url || target.label}
                    >
                      <span className="max-w-[11rem] truncate">{target.label}</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`把「${target.label}」从要聊的人里移除`}
                        title="从要聊的人里移除这位"
                        onClick={() => void removeTarget(target)}
                      >
                        <X size={10} />
                      </button>
                    </li>
                  ))}
                  {targets.length > 24 ? (
                    <li className="badge">…还有 {targets.length - 24} 位</li>
                  ) : null}
                </ul>
              ) : (
                <p className="field-hint mt-2 leading-4">
                  还没有要聊的人。上面读一次会话列表，勾好要聊的人再点「保存为要聊的人」——
                  引擎只会聊这些明确选中的人，不会自己猜。
                </p>
              )}

              {/* 手填是**高级出口**（会话列表读不出直链时仍能指定） */}
              <details className="mt-2 rounded-lg bg-sunken px-2.5 py-2">
                <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground">
                  手动填写 / 查看原文（高级）
                </summary>
                <textarea
                  className="field-input mt-2 h-24 w-full resize-none font-mono text-caption"
                  placeholder={"每行一位：昵称 | 会话URL\n例如：\n小王 | https://example.com/chat/12345\n# 以 # 开头的行会被忽略"}
                  value={targetsText}
                  onChange={(event) => setTargetsText(event.target.value)}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-outline btn-compact h-7"
                    disabled={saving || selectedEnvIds.length === 0}
                    onClick={() => void handleSave()}
                  >
                    <Save size={13} />
                    {saving ? "保存中…" : "保存手填名单"}
                  </button>
                  <span className="field-hint leading-4">
                    {selectedEnvIds.length === 0
                      ? "先勾选环境再保存。"
                      : `写入 ${selectedEnvIds.map(profileName).join("、")}`}
                  </span>
                </div>
              </details>
              <p className="field-hint mt-2">
                怎么说话：上方选「角色」（增删在「设置 → 聊天」）。电脑休眠或关掉应用/浏览器时无法回复。
              </p>

              {suspendedRows.length > 0 ? (
                <div className="mt-3 space-y-1.5 rounded bg-warning/10 px-2 py-1.5 ring-1 ring-inset ring-warning/30">
                  {suspendedRows.map((row) => (
                    <div key={row.profileId} className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-caption leading-4 text-warning">
                        <strong className="text-foreground">{profileName(row.profileId)}</strong>{" "}
                        自动聊天已暂停：{row.reason ?? row.lastError ?? "连续失败"}
                      </p>
                      <button
                        type="button"
                        className="btn btn-outline btn-compact h-6 shrink-0 text-caption"
                        disabled={resumeBusy === row.profileId}
                        onClick={() => void handleResume(row.profileId)}
                      >
                        <RotateCcw size={11} />
                        {resumeBusy === row.profileId ? "恢复中…" : "恢复"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          </div>

          {/* ── 右：运行与观察（跟着「查看中」的环境）────────────────────── */}
          <div className="space-y-3">
            {!profileId ? (
              <section className="well p-3">
                <p className="text-caption leading-5 text-muted-foreground">
                  左侧还没有勾选任何环境。勾选一个运行中的环境后，这里会显示它的值守控制、联系人与
                  值守日志。
                </p>
              </section>
            ) : (
              <>
                <section className="well p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="section-title">{selectedProfile?.name ?? "环境"}</p>
                    {status === null ? (
                      <span className="badge">读取中…</span>
                    ) : (
                      <>
                        <span className={`badge ${running ? "badge-success" : "badge"}`}>
                          {running ? "值守中" : "空闲"}
                        </span>
                        <span
                          className="badge badge-info"
                          title={phase ? `引擎相位：${phase}` : undefined}
                        >
                          {PHASE_LABEL[phase] ?? phase}
                        </span>
                        <span className="badge" title="浏览器是否在运行">
                          {status.browserRunning ? "浏览器运行中" : "浏览器未启动"}
                        </span>
                        <span className="badge" title={status.snapshot?.nextWakeAt ?? ""}>
                          <Clock size={10} />
                          下次续盯 {formatRelative(status.snapshot?.nextWakeAt)}
                        </span>
                        <span className="badge" title="今日已发送 / 累计">
                          今日 {status.snapshot?.sentToday ?? 0} / 共 {status.snapshot?.sentTotal ?? 0}
                        </span>
                        <span
                          className="badge"
                          title="今天这个环境调了几次模型（配额感来自调用次数）。模型单价随配置变化，视图不折算金额 —— 宁愿少给一个数字，也不给一个错的"
                        >
                          今日模型调用 {status.snapshot?.llmCallsToday ?? 0} 次
                        </span>
                        {status.snapshot?.rejectedToday ? (
                          <span className="badge badge-warning" title="今天被去重 / 红线闸门拦下的草稿条数">
                            今日拦下 {status.snapshot.rejectedToday}
                          </span>
                        ) : null}
                      </>
                    )}
                    <span className="ml-auto flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        className="btn btn-primary btn-compact h-7"
                        disabled={
                          sliceBusy ||
                          stopping ||
                          !settings.enabled ||
                          status?.browserRunning === false ||
                          !chatPreflight.canStart
                        }
                        title={
                          status?.browserRunning === false
                            ? "浏览器已停：请先启动环境再聊天（仍可清理联系人记忆）"
                            : undefined
                        }
                        onClick={() => void handleStart()}
                      >
                        <Play size={13} />
                        {sliceBusy ? "聊天中…" : "开始聊天"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-compact h-7"
                        disabled={stopping || !running}
                        onClick={() => void handleStop()}
                      >
                        <Square size={13} />
                        {stopping ? "停止中…" : "停止"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-compact h-7"
                        disabled={purgeAllBusy || running}
                        title={running ? "值守进行中：请先停止再清理" : "清理本环境全部聊天记忆"}
                        onClick={() => void handlePurgeEnv()}
                      >
                        <Trash2 size={13} />
                        清理本环境记忆
                      </button>
                    </span>
                  </div>
                  {statusError ? (
                    <p className="mt-1.5 text-caption text-destructive">状态读取失败：{statusError}</p>
                  ) : null}
                  <p className="field-hint mt-1.5">
                    一片最长约 {Math.max(1, Math.round(settings.sliceMs / 60_000))}{" "}
                    分钟会让位一次（不是监控结束）；总开关开着时调度器会马上再拉起继续盯。同一环境同一时刻只允许一个任务占用浏览器。
                  </p>
                </section>

                <section className="well p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="section-title">联系人（{effectiveContacts.length}）</p>
                    <span className="text-caption text-muted-foreground">
                      {status?.snapshot?.sentTotal ?? 0} 条已发送 · 共{" "}
                      {status?.snapshot?.contactCount ?? effectiveContacts.length ?? 0} 位
                    </span>
                  </div>
                  <div className="max-h-[34vh] space-y-2 overflow-y-auto pr-1">
                    {status === null ? (
                      <p className="text-caption text-muted-foreground">读取中…</p>
                    ) : effectiveContacts.length === 0 ? (
                      <p className="text-caption leading-5 text-muted-foreground">
                        该环境还没有聊天记忆。先在左侧「要聊的人」里勾选并保存，再点「开始聊天」；
                        第一次聊成功后这里就会出现联系人卡片。
                      </p>
                    ) : (
                      effectiveContacts.map((contact, index) => (
                        <ContactCard
                          key={takeoverKeyOf(contact.siteKey, contact.contactKey)}
                          profileId={profileId}
                          contact={contact}
                          autoLoad={index < 25}
                          busy={purgingKey === takeoverKeyOf(contact.siteKey, contact.contactKey)}
                          purgeBlocked={running}
                          flagsBusy={flagsKey === takeoverKeyOf(contact.siteKey, contact.contactKey)}
                          onPurge={(row) => void handlePurgeContact(row)}
                          onToggleFlags={(row, field, next) =>
                            void handleToggleFlags(row, field, next)
                          }
                          onToggleTakeover={(row, next) => void handleToggleTakeover(row, next)}
                        />
                      ))
                    )}
                  </div>
                </section>

                <section className="well p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="section-title">值守过程日志</p>
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact h-6 text-caption"
                      onClick={() => {
                        setLogLines([]);
                        if (profileId) {
                          void clearChatPatrolLogs(profileId).catch((error) =>
                            onError(formatInvokeError(error)),
                          );
                        }
                      }}
                    >
                      清空
                    </button>
                  </div>
                  <div
                    ref={logRef}
                    className="group-well h-40 overflow-y-auto p-2 font-mono text-[10px] leading-4 ring-1 ring-inset ring-border-strong/25"
                  >
                    {logLines.length === 0 ? (
                      <p className="text-muted-foreground">
                        这是值守过程（读到消息、发送、转人工）。对方说过的话在上面联系人卡片里。
                        关掉再开会从本机恢复。
                      </p>
                    ) : (
                      logLines.map((line, index) => (
                        <p key={index} className={line.tone}>
                          <span className="text-muted-foreground/60">{line.at}</span> {line.text}
                        </p>
                      ))
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
