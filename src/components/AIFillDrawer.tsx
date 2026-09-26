import {
  Bot,
  ChevronDown,
  ClipboardList,
  History,
  Paperclip,
  Pause,
  PenLine,
  Play,
  Sparkles,
  Square,
  Wand2,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ATTACHMENT_ACCEPT, ChatAttachmentChips, useChatAttachmentPicker } from "./ChatComposerAttachments";
import { AgentRulesModal } from "./AgentRulesModal";
import {
  RULE_ROLE_OPTIONS,
  loadAgentRuleLibrary,
  personaEffectiveFixedFields,
  personaFixedValues,
  personaTemplateValues,
  resolveGoalMentions,
  rulesPayload,
  type AgentPersona,
  type AgentRule,
} from "../lib/agentRules";

import {
  extractFillDataTextFromReply,
  extractJsonFromAiReply,
  normalizeFillInputForExecution,
} from "../lib/aiReplyJson";
import {
  resolveAgentTargets,
  resolveAgentMaxAllowed,
  normalizeAgentGoalKey,
  parseAgentBridgePayload,
  stripAgentBridgeMarker,
  type AgentRouteMode,
  type AgentSeatPolicy,
} from "../lib/agentGoalRouter";
import { aiBlockedKernelMessage, isAiBlockedForKernel } from "../lib/kernelPolicy";
import { buildChatHistoryFromLines } from "../lib/chat_history";
import { normalizeScrapedRows } from "../lib/csvExport";
import { normalizeDomain } from "../lib/domain";
import { createLogger } from "../lib/logger";
import {
  formatInvokeError,
  getProfilePageUrl,
  checkLicenseEntitlement,
  getCloakBinaryStatus,
  fetchSettings,
  isBenignAgentStopError,
  listAgentTrajectories,
  deleteAgentTrajectory,
  previewAiFill,
  runDirectFill,
  runSmartFill,
  runRpaFill,
  replayAgentTrajectory,
  sendAiChat,
  startAutonomousAgent,
  abortAutonomousAgent,
  pauseAutonomousAgent,
  continueAgentHandover,
} from "../lib/tauri";
import type {
  AgentTrajectory,
  ChatAttachmentPayload,
  CloakBinaryStatus,
  Profile,
  ProfileIpGeo,
  RpaAction,
  RpaRunResult,
  RpaStatePayload,
  TerminalLine,
} from "../types";
import { resolveTaskModel } from "../types";
import { AIChatPanel } from "./AIChatPanel";
import { ScraperDataPanel } from "./ScraperDataPanel";
import { useAppDialog } from "./AppDialogProvider";
import { FillConfirmModal } from "./FillConfirmModal";
import { AgentThoughtChain } from "./AgentThoughtChain";
import { AgentOpenTabsBar, type AgentOpenTabItem } from "./AgentOpenTabsBar";
import { TrajectoryMemoryPanel } from "./TrajectoryMemoryPanel";
import { AgentRunHistoryPanel } from "./AgentRunHistoryPanel";
import { type RpaUiState } from "../lib/rpaState";
import { inferAgentLineKind } from "../lib/agentThoughtChain";
import { useInterventionCenter } from "./InterventionCenterProvider";

const logger = createLogger("AIFillDrawer");

interface AIFillDrawerProps {
  profiles: Profile[];
  selectedIds: string[];
  busyIds?: string[];
  lines: TerminalLine[];
  onLog: (line: TerminalLine) => void;
  onError: (message: string) => void;
  /** 控制浏览器启动（与 Agent 启停分离）；返回 false 表示失败 */
  onStartBrowser?: (profileId: string) => void | Promise<void | boolean>;
  /** 控制浏览器停止 */
  onStopBrowser?: (profileId: string) => void | Promise<void | boolean>;
  /** 按环境缓存的出口 GeoIP（用于「规则」窗口里人设与出口城市的一致性提示） */
  ipGeoOverrides?: Map<string, ProfileIpGeo>;
}

interface QuickCommand {
  id: string;
  label: string;
  prompt: string;
  fillOnly?: boolean;
}

type DrawerTab = "agent" | "ai" | "runs" | "trajectory";

const QUICK_COMMANDS_STORAGE_KEY = "ai-browser-quick-commands";
/** Agent 轨迹录制偏好：默认建议开启（P4.3）；用户显式关闭后记住 */
const AGENT_ENABLE_RECORDING_KEY = "ai-browser-agent-enable-recording";
/** Ai Chat 底栏填表工具：默认折叠，避免挤占对话区 */
const FILL_TOOLS_OPEN_KEY = "ai-browser-fill-tools-open";

function loadFillToolsOpen(): boolean {
  try {
    return localStorage.getItem(FILL_TOOLS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

const BUILTIN_QUICK_COMMANDS: QuickCommand[] = [
  {
    id: "page-summary",
    label: "总结当前页",
    prompt:
      "总结当前打开的页面：站点定位、主要功能与栏目、页面内容要点、值得注意的信息。只读当前页，不要导航离开，也不要打开新标签。",
  },
  {
    id: "form-json-template",
    label: "提取表单 JSON",
    prompt:
      "请调用 get_interactive_elements 工具扫描当前页面的交互元素。将所有可填写的 input/select/textarea 整理成一个标准的 JSON 填表键值对模板发给我。所有的 value 请留空，只需确保 key (name/id 属性) 与页面绝对一致。",
  },
  {
    id: "form-fraud-audit",
    label: "风控字段排查",
    prompt:
      '请调用 get_page_form_schema 工具扫描当前页面表单，帮我进行自动化填表的风控排查。列出所有 type="hidden" 的隐藏字段，并告诉我哪些字段是必须由浏览器 JavaScript 动态生成的（比如带有 token、hash、signature 字眼的字段，或工具返回 likelyDynamic 为 true 的字段），千万不要把这些字段加到你给我的常规 JSON 填表模板里，防止触发机器校验。',
  },
];

function pickFillProfileId(profiles: Profile[], selectedIds: string[]): string | null {
  const runningSelected = selectedIds.find((id) => {
    const profile = profiles.find((item) => String(item.id) === id);
    return profile?.status === "running";
  });
  if (runningSelected) {
    return runningSelected;
  }
  const firstRunning = profiles.find((profile) => profile.status === "running");
  return firstRunning ? String(firstRunning.id) : (selectedIds[0] ?? null);
}

function loadAgentEnableRecording(): boolean {
  try {
    const raw = localStorage.getItem(AGENT_ENABLE_RECORDING_KEY);
    // P4.3：未设置时默认建议开启；显式 "false" 才关闭
    if (raw === null) {
      return true;
    }
    return raw === "true";
  } catch {
    return true;
  }
}

function persistAgentEnableRecording(enabled: boolean): void {
  try {
    localStorage.setItem(AGENT_ENABLE_RECORDING_KEY, enabled ? "true" : "false");
  } catch {
    /* ignore quota / private mode */
  }
}

function loadCustomQuickCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(QUICK_COMMANDS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as QuickCommand[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item) =>
        typeof item.id === "string" &&
        typeof item.label === "string" &&
        typeof item.prompt === "string" &&
        item.label.trim() &&
        item.prompt.trim(),
    );
  } catch {
    return [];
  }
}

function saveCustomQuickCommands(commands: QuickCommand[]) {
  try {
    localStorage.setItem(QUICK_COMMANDS_STORAGE_KEY, JSON.stringify(commands));
  } catch {
    /* ignore quota / private mode */
  }
}

function formatPreviewJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function buildDirectPreviewJson(rawInput: string): string {
  const extracted = extractJsonFromAiReply(rawInput);
  if (extracted) {
    return JSON.stringify(extracted, null, 2);
  }
  return rawInput.trim();
}

/** @ 引用的查询串长度上限：超过就当成普通文本，不再弹候选 */
const MENTION_QUERY_MAX = 40;

/**
 * 光标前最近的 `@` 起始位置。
 * 只要 `@` 与光标之间没有空白，**任何位置**都算引用（开头、句中、连续多个都行）；
 * 已经敲了空格说明这个引用写完了，返回 null。
 */
function findMentionAnchor(value: string, caret: number): number {
  const pos = Math.max(0, Math.min(caret, value.length));
  const at = value.lastIndexOf("@", pos - 1);
  if (at < 0) {
    return -1;
  }
  const between = value.slice(at + 1, pos);
  if (/\s/.test(between) || between.length > MENTION_QUERY_MAX) {
    return -1;
  }
  return at;
}

/** 当前正在输入的 @ 查询串；不在引用态时返回 null */
function activeMentionQuery(value: string, caret: number): string | null {
  const at = findMentionAnchor(value, caret);
  return at < 0 ? null : value.slice(at + 1, Math.min(caret, value.length));
}

export function AIFillDrawer({
  profiles,
  selectedIds,
  busyIds = [],
  lines,
  onLog,
  onError,
  onStartBrowser,
  onStopBrowser,
  ipGeoOverrides,
}: AIFillDrawerProps) {
  const { prompt, confirm } = useAppDialog();
  const { registerAgentGoals, pulseInbox } = useInterventionCenter();
  const [activeTab, setActiveTab] = useState<DrawerTab>("agent");
  /** Tab 输入与提交态隔离，避免交叉污染 */
  const [aiRawInput, setAiRawInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [agentGoal, setAgentGoal] = useState("");
  /** Agent 输入框附件（与 Ai Chat 同一套：图片→vision、文本→摘要；禁止当 OTP 取码依据） */
  const [agentAttachments, setAgentAttachments] = useState<ChatAttachmentPayload[]>([]);
  /** 「规则」窗口开关 + 规则库快照（供底部按钮显示本次 @引用 条数、启动时成快照下发） */
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ruleLibrary, setRuleLibrary] = useState<{
    rules: AgentRule[];
    personas: AgentPersona[];
  }>({ rules: [], personas: [] });
  /** 是否落盘执行轨迹（沙盘回放）；默认关，偏好记入 localStorage */
  const [enableRecording, setEnableRecording] = useState(loadAgentEnableRecording);
  const [fillToolsOpen, setFillToolsOpen] = useState(loadFillToolsOpen);
  /** 按环境隔离的 Agent 监控日志，切换左侧环境时无缝切换 */
  const [agentLinesByEnv, setAgentLinesByEnv] = useState<Record<string, TerminalLine[]>>({});
  /** 按环境隔离的爬虫采集结果 */
  const [scrapedDataByEnv, setScrapedDataByEnv] = useState<
    Record<
      string,
      {
        rows: Array<Record<string, unknown>>;
        mode?: string;
        url?: string;
        count?: number;
        localPath?: string;
      }
    >
  >({});
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [directFillSubmitting, setDirectFillSubmitting] = useState(false);
  const [smartFillSubmitting, setSmartFillSubmitting] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const [customCommands, setCustomCommands] = useState<QuickCommand[]>(() => loadCustomQuickCommands());
  const [skipHybrid, setSkipHybrid] = useState(false);
  const [forceHumanConfirm, setForceHumanConfirm] = useState(true);
  const [pressEnterAfterFill, setPressEnterAfterFill] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmJson, setConfirmJson] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [currentDomain, setCurrentDomain] = useState("");
  /** 填表动作流（混合填表可选）；Ai Chat 不再挂 RPA 模板 UI，默认空 */
  const [currentActions, setCurrentActions] = useState<RpaAction[]>([]);
  const [, setRpaState] = useState<RpaUiState>("idle");
  const [, setRpaMessage] = useState("");
  const [chatAttachments, setChatAttachments] = useState<ChatAttachmentPayload[]>([]);
  const [agentBusyEnvIds, setAgentBusyEnvIds] = useState<string[]>([]);
  /** P4.5：agent-state paused 的环境（用户暂停或 HITL 挂起） */
  const [agentPausedEnvIds, setAgentPausedEnvIds] = useState<string[]>([]);
  /** P4.4：按环境隔离的 Open Tabs 只读快照 */
  const [openTabsByEnv, setOpenTabsByEnv] = useState<Record<string, AgentOpenTabItem[]>>({});
  const [rpaBusyEnvIds, setRpaBusyEnvIds] = useState<string[]>([]);
  const [trajectories, setTrajectories] = useState<AgentTrajectory[]>([]);
  const [selectedTrajectoryId, setSelectedTrajectoryId] = useState<number | null>(null);
  const [trajectoryBusyEnvIds, setTrajectoryBusyEnvIds] = useState<string[]>([]);
  const [executingTrajectoryId, setExecutingTrajectoryId] = useState<number | null>(null);
  const [runHistoryRefreshToken, setRunHistoryRefreshToken] = useState(0);
  /** 回放专用日志（与 Agent Monitor 分流） */
  const [replayLinesByEnv, setReplayLinesByEnv] = useState<Record<string, TerminalLine[]>>({});
  /** 多环境回放时合并展示的环境（派发结束后仍保留，直到清空日志） */
  const [replayWatchEnvIds, setReplayWatchEnvIds] = useState<string[]>([]);
  const trajectoryBusyEnvIdsRef = useRef<string[]>([]);
  /** Current Agent fan-out batch (broadcast / named). */
  const [agentBatchIds, setAgentBatchIds] = useState<string[]>([]);
  const [, setAgentRouteMode] = useState<AgentRouteMode | "idle">("idle");
  const [agentGoalByEnv, setAgentGoalByEnv] = useState<Record<string, string>>({});
  const [agentSeatPolicy, setAgentSeatPolicy] = useState<AgentSeatPolicy>({ isPro: false, seatLimit: 1 });
  const [agentSeatsSummary, setAgentSeatsSummary] = useState("");
  const quickMenuRef = useRef<HTMLDivElement>(null);
  const agentGoalByEnvRef = useRef<Record<string, string>>({});
  /** Chat 桥接启动的 Agent：终态时回写一条结论到对话 */
  const chatBridgedAgentsRef = useRef<Map<string, string>>(new Map());
  const startAgentWithGoalRef = useRef<
    (goal: string, options?: { fromChat?: boolean; attachments?: ChatAttachmentPayload[] }) => Promise<void>
  >(async () => undefined);
  /** 与 rpaBusyEnvIds 同步，供「绑定环境切换」时无依赖地读取最新忙闲 */
  const rpaBusyEnvIdsRef = useRef<string[]>([]);

  const targetProfileId = useMemo(() => pickFillProfileId(profiles, selectedIds), [profiles, selectedIds]);

  const targetProfile = useMemo(
    () => profiles.find((profile) => String(profile.id) === targetProfileId) ?? null,
    [profiles, targetProfileId],
  );

  /** Agent 输入框附件选择（与 Ai Chat 共用同一实现） */
  const agentAttach = useChatAttachmentPicker({
    attachments: agentAttachments,
    onAttachmentsChange: setAgentAttachments,
    onAttachError: onError,
  });

  const refreshRuleLibrary = useCallback(async () => {
    try {
      const library = await loadAgentRuleLibrary();
      setRuleLibrary({
        rules: library.rules,
        personas: library.personas,
      });
    } catch (error) {
      logger.error("loadAgentRuleLibrary failed", error);
    }
  }, []);

  useEffect(() => {
    void refreshRuleLibrary();
  }, [refreshRuleLibrary]);

  /**
   * 「规则」按钮角标：只统计**本次输入框里 @引用**到的规则数。
   * 规则不再按环境预启用（无 @ 时 Agent 完全不查规则库），因此不能虚报「已启用 N 条」。
   */
  const mentionedRuleCount = useMemo(
    () => resolveGoalMentions(agentGoal, ruleLibrary.rules, ruleLibrary.personas).rules.length,
    [agentGoal, ruleLibrary],
  );

  /* ------------------------------------------------ Agent 输入框 @ 引用 */
  const agentGoalRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  interface AgentMentionItem {
    key: string;
    kind: "persona" | "rule";
    id: string;
    name: string;
    hint: string;
  }

  /** @ 候选项：人设 + 规则条件（按输入过滤，最多 8 条） */
  const mentionItems = useMemo<AgentMentionItem[]>(() => {
    if (mentionQuery === null) {
      return [];
    }
    const query = mentionQuery.trim().toLowerCase();
    const personas: AgentMentionItem[] = ruleLibrary.personas.map((persona) => ({
      key: `persona:${persona.id}`,
      kind: "persona",
      id: persona.id,
      name: persona.label,
      hint: "人设",
    }));
    const rules: AgentMentionItem[] = ruleLibrary.rules.map((rule) => ({
      key: `rule:${rule.id}`,
      kind: "rule",
      id: rule.id,
      name: rule.title,
      hint: RULE_ROLE_OPTIONS.find((option) => option.value === rule.role)?.label ?? "规则",
    }));
    const pool = [...personas, ...rules].filter((item) =>
      query ? item.name.toLowerCase().includes(query) : true,
    );
    return pool.slice(0, 8);
  }, [mentionQuery, ruleLibrary]);

  const anyAgentBusy = agentBusyEnvIds.length > 0;
  const anyAgentPaused = agentPausedEnvIds.some((id) => agentBusyEnvIds.includes(id));
  const agentBusy = Boolean(targetProfileId && agentBusyEnvIds.includes(targetProfileId));
  const rpaBusy = Boolean(targetProfileId && rpaBusyEnvIds.includes(targetProfileId));
  const trajectoryBusy = Boolean(targetProfileId && trajectoryBusyEnvIds.includes(targetProfileId));
  /** 与 Sidecar 引擎互斥对齐：Agent / RPA 填表 / 轨迹回放 */
  const envExecuting = agentBusy || rpaBusy || trajectoryBusy;
  const envBusyReason = agentBusy
    ? "Agent 运行中"
    : trajectoryBusy
      ? "轨迹回放中"
      : rpaBusy
        ? "RPA 填表中"
        : "";
  const runningProfileIds = useMemo(
    () => profiles.filter((profile) => profile.status === "running").map((profile) => String(profile.id)),
    [profiles],
  );
  const selectedRunningIds = useMemo(
    () => selectedIds.filter((id) => runningProfileIds.includes(id)),
    [runningProfileIds, selectedIds],
  );

  const refreshAgentSeatPolicy = useCallback(async () => {
    try {
      const [entitlement, settings] = await Promise.all([checkLicenseEntitlement(), fetchSettings()]);
      let status: CloakBinaryStatus | null = null;
      try {
        status = await getCloakBinaryStatus(settings.cloak_license_key);
      } catch {
        status = null;
      }
      const isPro = Boolean(
        (entitlement.isPro && entitlement.isValid) ||
          status?.tier === "pro" ||
          (status?.licenseValid &&
            String(status.licensePlan ?? "")
              .toLowerCase()
              .includes("pro")),
      );
      const seatLimit =
        typeof status?.sessionSeatsLimit === "number" && status.sessionSeatsLimit > 0
          ? status.sessionSeatsLimit
          : isPro
            ? null
            : 1;
      const policy: AgentSeatPolicy = { isPro, seatLimit };
      setAgentSeatPolicy(policy);
      // 不把 CloakBrowser 内核会话 active/limit 标成「AI席位」（易被理解成不能多开浏览器）
      const aiCap = resolveAgentMaxAllowed(policy);
      if (!isPro) {
        setAgentSeatsSummary("AI并行≤1 · 内核免费档并发=1");
      } else if (aiCap != null) {
        setAgentSeatsSummary(`AI并行≤${aiCap} · 内核并发≤${aiCap}`);
      } else {
        setAgentSeatsSummary("Pro · AI/内核并发跟席位");
      }
      return policy;
    } catch {
      const fallback: AgentSeatPolicy = { isPro: false, seatLimit: 1 };
      setAgentSeatPolicy(fallback);
      setAgentSeatsSummary("AI并行≤1 · 内核免费档并发=1");
      return fallback;
    }
  }, []);

  useEffect(() => {
    void refreshAgentSeatPolicy();
  }, [refreshAgentSeatPolicy]);

  const allBusyEnvIds = useMemo(() => {
    const set = new Set<string>([...agentBusyEnvIds, ...rpaBusyEnvIds, ...trajectoryBusyEnvIds]);
    return [...set];
  }, [agentBusyEnvIds, rpaBusyEnvIds, trajectoryBusyEnvIds]);

  const browserTargetIds = useMemo(
    () => (selectedIds.length > 0 ? selectedIds : targetProfileId ? [targetProfileId] : []),
    [selectedIds, targetProfileId],
  );
  const selectedStoppedCount = useMemo(
    () =>
      browserTargetIds.filter((id) => {
        const profile = profiles.find((item) => String(item.id) === id);
        return profile != null && profile.status !== "running";
      }).length,
    [browserTargetIds, profiles],
  );
  const selectedRunningCount = useMemo(
    () =>
      browserTargetIds.filter((id) => {
        const profile = profiles.find((item) => String(item.id) === id);
        return profile?.status === "running";
      }).length,
    [browserTargetIds, profiles],
  );
  const browserTargetsBusy = useMemo(
    () => browserTargetIds.some((id) => busyIds.includes(id)),
    [browserTargetIds, busyIds],
  );

  /** 宪法 §3.4 / §5.4：元素提取运行时恒开；智能填表只要求环境在跑 */
  const smartFillEnabled = targetProfile?.status === "running";

  useEffect(() => {
    rpaBusyEnvIdsRef.current = rpaBusyEnvIds;
  }, [rpaBusyEnvIds]);

  /**
   * 绑定环境切换后，上一环境的 RPA 会话状态不再适用：
   * 监听器对非目标环境的事件有意直接 return，若不重置会让新环境顶着旧环境的
   * 「待接管 / 失败」角标。新环境若正在跑 RPA，则如实回填为执行中。
   */
  const rpaBoundProfileRef = useRef<string | null>(null);
  useEffect(() => {
    if (rpaBoundProfileRef.current === targetProfileId) {
      return;
    }
    rpaBoundProfileRef.current = targetProfileId;
    setRpaMessage("");
    setRpaState(targetProfileId && rpaBusyEnvIdsRef.current.includes(targetProfileId) ? "running" : "idle");
  }, [targetProfileId]);

  const quickCommands = useMemo(() => [...BUILTIN_QUICK_COMMANDS, ...customCommands], [customCommands]);

  const pushLine = useCallback(
    (tone: TerminalLine["tone"], text: string, role?: TerminalLine["role"]) => {
      onLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toLocaleTimeString(),
        tone,
        text,
        role,
      });
    },
    [onLog],
  );

  /**
   * @ 引用后的副作用（C2）：**不再静默改库**。
   * 只给用户一句回执；人设只在本次任务的载荷里生效，不改动任何环境的默认人设
   * （要固定给某个环境用，请到「规则」窗口里明确指定）。
   */
  const applyMentionSideEffect = useCallback(
    (item: AgentMentionItem) => {
      if (item.kind === "rule") {
        pushLine("info", `本次任务将引用规则「${item.name}」`);
        return;
      }
      pushLine("info", `本次任务将使用人设「${item.name}」（只影响本次任务，不改动环境人设）`);
    },
    [pushLine],
  );

  const insertMention = useCallback(
    (item: AgentMentionItem) => {
      const node = agentGoalRef.current;
      const text = agentGoal;
      const caret = node?.selectionStart ?? text.length;
      const at = findMentionAnchor(text, caret);
      // 锚点存在就替换正在输入的 `@查询`；否则就地插入（支持连续 @ 多个）
      const start = at >= 0 ? at : caret;
      const insert = `@${item.name} `;
      const nextText = `${text.slice(0, start)}${insert}${text.slice(caret)}`;
      const nextCaret = start + insert.length;
      setAgentGoal(nextText);
      setMentionQuery(null);
      setMentionIndex(0);
      applyMentionSideEffect(item);
      requestAnimationFrame(() => {
        const target = agentGoalRef.current;
        if (target) {
          target.focus();
          target.setSelectionRange(nextCaret, nextCaret);
        }
      });
    },
    [agentGoal, applyMentionSideEffect],
  );

  /** 输入变化：任意位置的 @ 都能触发（不要求 @ 在开头、不要求前面有空格） */
  const handleAgentGoalChange = useCallback((value: string, caret: number | null) => {
    setAgentGoal(value);
    setMentionQuery(activeMentionQuery(value, caret ?? value.length));
  }, []);

  /** 光标移动（点击 / 方向键）后按新位置重算引用态：把光标放回未写完的 @ 后仍能继续选 */
  const syncMentionFromCaret = useCallback((node: HTMLTextAreaElement | null) => {
    if (!node) {
      return;
    }
    setMentionQuery(activeMentionQuery(node.value, node.selectionStart));
  }, []);

  /** 任务文本里当前已 @ 到的条目（可多个），用于给用户一个可视回执 */
  const agentMentionSummary = useMemo(() => {
    const { rules, persona } = resolveGoalMentions(agentGoal, ruleLibrary.rules, ruleLibrary.personas);
    const parts = [
      persona ? `人设「${persona.label}」` : null,
      ...rules.map((rule) => `条件「${rule.title}」`),
    ].filter((item): item is string => item != null);
    return parts.join(" · ");
  }, [agentGoal, ruleLibrary]);

  const agentLines = useMemo(() => {
    const ids =
      agentBatchIds.length > 0
        ? agentBatchIds
        : anyAgentBusy
          ? agentBusyEnvIds
          : targetProfileId
            ? [targetProfileId]
            : [];
    if (ids.length === 0) {
      return [];
    }
    if (ids.length === 1) {
      return agentLinesByEnv[ids[0]] ?? [];
    }
    const merged: TerminalLine[] = [];
    for (const id of ids) {
      for (const line of agentLinesByEnv[id] ?? []) {
        const prefix = `#${id} · `;
        merged.push({
          ...line,
          text: line.text.startsWith(prefix) ? line.text : `${prefix}${line.text}`,
        });
      }
    }
    return merged.sort((left, right) => left.id.localeCompare(right.id));
  }, [agentBatchIds, agentBusyEnvIds, agentLinesByEnv, anyAgentBusy, targetProfileId]);
  const scrapedData = targetProfileId ? (scrapedDataByEnv[targetProfileId] ?? null) : null;
  const openTabs = targetProfileId ? (openTabsByEnv[targetProfileId] ?? []) : [];
  const showOpenTabsBar = Boolean(targetProfileId && (agentBusy || openTabs.length > 0));

  useEffect(() => {
    agentGoalByEnvRef.current = agentGoalByEnv;
  }, [agentGoalByEnv]);

  useEffect(() => {
    trajectoryBusyEnvIdsRef.current = trajectoryBusyEnvIds;
  }, [trajectoryBusyEnvIds]);

  const pushAgentLineFor = useCallback(
    (
      profileId: string,
      tone: TerminalLine["tone"],
      text: string,
      extra?: Pick<TerminalLine, "kind" | "meta">,
    ) => {
      if (!profileId) {
        return;
      }
      setAgentLinesByEnv((current) => ({
        ...current,
        [profileId]: [
          ...(current[profileId] ?? []),
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ts: new Date().toLocaleTimeString(),
            tone,
            text,
            kind: extra?.kind,
            meta: extra?.meta,
          },
        ].slice(-400),
      }));
    },
    [],
  );

  const pushReplayLineFor = useCallback((profileId: string, tone: TerminalLine["tone"], text: string) => {
    if (!profileId) {
      return;
    }
    const cleaned = String(text ?? "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .trim();
    if (!cleaned) {
      return;
    }
    setReplayLinesByEnv((current) => ({
      ...current,
      [profileId]: [
        ...(current[profileId] ?? []),
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ts: new Date().toLocaleTimeString(),
          tone,
          text: cleaned,
        },
      ].slice(-400),
    }));
  }, []);

  const pushAgentLine = useCallback(
    (tone: TerminalLine["tone"], text: string) => {
      if (!targetProfileId) {
        return;
      }
      pushAgentLineFor(targetProfileId, tone, text);
    },
    [pushAgentLineFor, targetProfileId],
  );

  const pushReplayLine = useCallback(
    (tone: TerminalLine["tone"], text: string) => {
      if (!targetProfileId) {
        return;
      }
      pushReplayLineFor(targetProfileId, tone, text);
    },
    [pushReplayLineFor, targetProfileId],
  );

  const replayLines = useMemo(() => {
    const ids = [
      ...new Set([
        ...(targetProfileId ? [targetProfileId] : []),
        ...trajectoryBusyEnvIds,
        ...replayWatchEnvIds,
      ]),
    ];
    if (ids.length === 0) {
      return [];
    }
    if (ids.length === 1) {
      return replayLinesByEnv[ids[0]] ?? [];
    }
    const merged: TerminalLine[] = [];
    for (const id of ids) {
      for (const line of replayLinesByEnv[id] ?? []) {
        const prefix = `[#${id}] `;
        merged.push({
          ...line,
          text: line.text.startsWith(prefix) ? line.text : `${prefix}${line.text}`,
        });
      }
    }
    return merged.sort((left, right) => left.id.localeCompare(right.id));
  }, [replayLinesByEnv, replayWatchEnvIds, targetProfileId, trajectoryBusyEnvIds]);

  const setEnvAgentBusy = useCallback((profileId: string, busy: boolean) => {
    setAgentBusyEnvIds((current) => {
      if (busy) {
        return current.includes(profileId) ? current : [...current, profileId];
      }
      return current.filter((id) => id !== profileId);
    });
  }, []);

  const setEnvTrajectoryBusy = useCallback((profileId: string, busy: boolean) => {
    setTrajectoryBusyEnvIds((current) => {
      if (busy) {
        return current.includes(profileId) ? current : [...current, profileId];
      }
      return current.filter((id) => id !== profileId);
    });
    if (busy) {
      setReplayWatchEnvIds((current) => (current.includes(profileId) ? current : [...current, profileId]));
    }
  }, []);

  const setEnvRpaBusy = useCallback((profileId: string, busy: boolean) => {
    setRpaBusyEnvIds((current) => {
      if (busy) {
        return current.includes(profileId) ? current : [...current, profileId];
      }
      return current.filter((id) => id !== profileId);
    });
  }, []);

  const clearEnvExecutionBusy = useCallback(
    (profileId: string) => {
      setEnvAgentBusy(profileId, false);
      setEnvRpaBusy(profileId, false);
      setEnvTrajectoryBusy(profileId, false);
      if (targetProfileId === profileId) {
        setExecutingTrajectoryId(null);
      }
    },
    [setEnvAgentBusy, setEnvRpaBusy, setEnvTrajectoryBusy, targetProfileId],
  );

  const refreshTrajectories = useCallback(async () => {
    try {
      // 全局资产库：不按当前站过滤；同站置顶仅在面板内排序
      const result = await listAgentTrajectories("");
      const rows = result.rows;
      setTrajectories(rows);
      setSelectedTrajectoryId((current) =>
        current != null && rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? null),
      );
      // 文件层不可读时列表会「看起来变空」，必须显式说明是降级而非数据丢失
      if (result.file_error) {
        pushLine("warn", `轨迹文件目录读取失败，已降级为仅数据库记录: ${result.file_error}`);
      }
    } catch (error) {
      onError(formatInvokeError(error));
    }
  }, [onError, pushLine]);

  const applyDomainFromUrl = useCallback(async (url: string) => {
    const domain = normalizeDomain(url);
    if (!domain) {
      return;
    }
    setCurrentDomain(domain);
  }, []);

  useEffect(() => {
    if (!targetProfileId) {
      return;
    }
    if (targetProfile?.status !== "running") {
      clearEnvExecutionBusy(targetProfileId);
    }
  }, [clearEnvExecutionBusy, targetProfile?.status, targetProfileId]);

  useEffect(() => {
    if (!targetProfileId || targetProfile?.status !== "running") {
      setCurrentDomain("");
      return;
    }

    let isCancelled = false;
    let unlistenFn: (() => void) | undefined;

    void getProfilePageUrl(targetProfileId)
      .then((url) => {
        if (!isCancelled && url.trim()) {
          void applyDomainFromUrl(url).catch((error) => {
            logger.error("applyDomainFromUrl failed", error);
          });
        }
      })
      .catch((error) => {
        logger.error("getProfilePageUrl failed", error);
      });

    void listen<{ profileId?: string; profile_id?: string; url?: string }>("page-url-changed", (event) => {
      const eventProfileId = String(event.payload.profileId ?? event.payload.profile_id ?? "").trim();
      // 严防串号：无 profileId 或与当前 Tab 不符一律忽略
      if (!eventProfileId || eventProfileId !== targetProfileId) {
        return;
      }
      const url = event.payload.url?.trim();
      if (url) {
        void applyDomainFromUrl(url).catch((error) => {
          logger.error("applyDomainFromUrl failed", error);
        });
      }
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch((error) => {
        logger.error("listen page-url-changed failed", error);
      });

    return () => {
      isCancelled = true;
      unlistenFn?.();
    };
  }, [applyDomainFromUrl, targetProfile?.status, targetProfileId]);

  useEffect(() => {
    void refreshTrajectories();
  }, [refreshTrajectories]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<{
      profileId?: string;
      id?: number;
      domain?: string;
      title?: string;
    }>("agent-trajectory-saved", (event) => {
      const eventProfileId = String(event.payload.profileId ?? "").trim();
      // 严防串号：禁止回退到当前 Tab 的 targetProfileId
      if (!eventProfileId) {
        logger.warn("agent-trajectory-saved missing profileId, ignored");
        return;
      }
      const title = event.payload.title ?? "未命名";
      const domain = event.payload.domain ?? "";
      pushAgentLineFor(
        eventProfileId,
        "success",
        `轨迹已记忆：${title}${domain ? `（${domain}）` : ""} · 已写入「轨迹记忆」，可单开回放 / 沙盘`,
      );
      if (typeof event.payload.id === "number" && Number.isFinite(event.payload.id)) {
        setSelectedTrajectoryId(event.payload.id);
      }
      // 同域资产跨环境共享：任意环境落盘后刷新当前列表
      void refreshTrajectories().catch((error) => {
        logger.error("refreshTrajectories failed", error);
      });
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        logger.error("listen agent-trajectory-saved failed", error);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [pushAgentLineFor, refreshTrajectories]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<{
      profileId?: string;
      status?: string;
      goal?: string;
      phase?: string;
    }>("agent-run-saved", (event) => {
      const status = String(event.payload.status ?? "");
      const phase = String(event.payload.phase ?? "");
      if (
        phase === "agent_run_finish" ||
        status === "complete" ||
        status === "failed" ||
        status === "aborted"
      ) {
        setRunHistoryRefreshToken((n) => n + 1);
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        logger.error("listen agent-run-saved failed", error);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unlistenFn: (() => void) | undefined;

    void listen<RpaStatePayload>("rpa-state", (event) => {
      const eventProfileId = String(
        event.payload.profile_id ?? (event.payload as { profileId?: string }).profileId ?? "",
      ).trim();
      if (!eventProfileId) {
        logger.warn("rpa-state missing profileId, ignored");
        return;
      }

      const state = String(event.payload.state ?? "").toLowerCase();
      const terminal =
        state === "complete" ||
        state === "paused" ||
        state === "failed" ||
        state === "aborted" ||
        state === "stopped" ||
        state === "error";

      // 始终按 profile 跟踪 RPA 忙闲（与引擎互斥对齐），不依赖当前 Tab
      if (state === "running") {
        setEnvRpaBusy(eventProfileId, true);
      } else if (terminal) {
        setEnvRpaBusy(eventProfileId, false);
      }

      if (targetProfileId && eventProfileId !== targetProfileId) {
        return;
      }

      if (state === "complete") {
        setRpaState("complete");
        setRpaMessage(event.payload.msg ?? "");
      } else if (state === "paused") {
        setRpaState("paused");
        setRpaMessage(event.payload.msg ?? "");
      } else if (state === "running") {
        setRpaState("running");
      } else if (terminal) {
        // failed / error 如实展示为失败态；aborted / stopped 属浏览器关闭等环境级结束，回落 idle
        setRpaState(state === "failed" || state === "error" ? "failed" : "idle");
        setRpaMessage(event.payload.msg ?? "");
      }

      if (event.payload.msg && !terminal) {
        setRpaMessage(event.payload.msg);
      }
      if (event.payload.actions && Array.isArray(event.payload.actions)) {
        setCurrentActions(event.payload.actions);
      }
      const busyReject = typeof event.payload.msg === "string" && event.payload.msg.includes("当前环境正忙");
      if (
        event.payload.msg &&
        (busyReject ||
          state === "failed" ||
          state === "aborted" ||
          (state === "paused" && event.payload.msg.includes("失败")))
      ) {
        pushLine("error", event.payload.msg);
        if (busyReject || state === "failed" || state === "aborted") {
          onError(event.payload.msg);
        }
      }
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch((error) => {
        logger.error("listen rpa-state failed", error);
      });

    return () => {
      isCancelled = true;
      unlistenFn?.();
    };
  }, [onError, pushLine, setEnvRpaBusy, targetProfileId]);

  useEffect(() => {
    let isCancelled = false;
    const unlistenFns: Array<() => void> = [];

    // P4.2：HITL UI 仅 Intervention Center；抽屉只记日志 + 深链高亮，禁止第二套确认框
    const noteInbox = (profileId: string, tool: "confirm" | "ask" | "handover", detail?: string) => {
      pulseInbox();
      const label =
        tool === "confirm" ? "等待人工确认" : tool === "ask" ? "等待人工补充信息" : "等待人工接管";
      pushAgentLineFor(
        profileId,
        "warn",
        `${label}（请到左下角「介入收件箱」处理）${detail ? `\n${detail}` : ""}`,
        {
          kind: "alert",
          meta: { tool, detail: detail || undefined },
        },
      );
    };

    void listen<{
      profileId?: string;
      requestId?: string;
      reason?: string;
    }>("agent-confirm-required", (event) => {
      const profileId = String(event.payload.profileId ?? "").trim();
      const requestId = String(event.payload.requestId ?? "").trim();
      if (!profileId || !requestId) {
        logger.warn("agent-confirm-required missing profileId/requestId, ignored");
        return;
      }
      noteInbox(profileId, "confirm", event.payload.reason);
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-confirm-required failed", error);
      });

    void listen<{
      profileId?: string;
      requestId?: string;
      question?: string;
    }>("agent-ask-user", (event) => {
      const profileId = String(event.payload.profileId ?? "").trim();
      const requestId = String(event.payload.requestId ?? "").trim();
      if (!profileId || !requestId) {
        logger.warn("agent-ask-user missing profileId/requestId, ignored");
        return;
      }
      noteInbox(profileId, "ask", event.payload.question);
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-ask-user failed", error);
      });

    void listen<{
      profileId?: string;
      requestId?: string;
      reason?: string;
    }>("agent-handover-required", (event) => {
      const profileId = String(event.payload.profileId ?? "").trim();
      const requestId = String(event.payload.requestId ?? "").trim();
      if (!profileId || !requestId) {
        logger.warn("agent-handover-required missing profileId/requestId, ignored");
        return;
      }
      noteInbox(profileId, "handover", event.payload.reason);
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-handover-required failed", error);
      });

    void listen<{
      profileId?: string;
      tabs?: Array<{
        id?: string;
        url?: string;
        title?: string;
        active?: boolean;
      }>;
    }>("agent-open-tabs", (event) => {
      const eventProfileId = String(event.payload.profileId ?? "").trim();
      if (!eventProfileId) {
        logger.warn("agent-open-tabs missing profileId, ignored");
        return;
      }
      const tabs: AgentOpenTabItem[] = (event.payload.tabs ?? [])
        .map((raw) => {
          const id = String(raw?.id ?? "").trim();
          if (!id) return null;
          return {
            id,
            url: String(raw?.url ?? ""),
            title: String(raw?.title ?? ""),
            active: raw?.active === true,
          };
        })
        .filter((item): item is AgentOpenTabItem => Boolean(item));
      setOpenTabsByEnv((current) => ({
        ...current,
        [eventProfileId]: tabs,
      }));
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-open-tabs failed", error);
      });

    void listen<{
      profileId?: string;
      state?: string;
      msg?: string;
      step?: number;
      engine?: string;
      /** 终态交付物正文（信息型任务的结论就写在这里） */
      summary?: string;
    }>("agent-state", (event) => {
      const eventProfileId = String(event.payload.profileId ?? "").trim();
      // 严防串号：禁止回退到当前 Tab
      if (!eventProfileId) {
        logger.warn("agent-state missing profileId, ignored");
        return;
      }
      const state = event.payload.state ?? "";
      const msg = event.payload.msg ?? "";
      const engine = String(event.payload.engine ?? "");
      const isTrajectory =
        engine === "trajectory_replay" || trajectoryBusyEnvIdsRef.current.includes(eventProfileId);

      if (state === "running") {
        if (isTrajectory) {
          setEnvTrajectoryBusy(eventProfileId, true);
        } else {
          setEnvAgentBusy(eventProfileId, true);
          setAgentPausedEnvIds((current) =>
            current.includes(eventProfileId) ? current.filter((id) => id !== eventProfileId) : current,
          );
        }
      }
      if (state === "paused" && !isTrajectory) {
        setEnvAgentBusy(eventProfileId, true);
        setAgentPausedEnvIds((current) =>
          current.includes(eventProfileId) ? current : [...current, eventProfileId],
        );
      }
      if (state === "complete" || state === "failed" || state === "aborted" || state === "stopped") {
        if (isTrajectory) {
          setEnvTrajectoryBusy(eventProfileId, false);
          setExecutingTrajectoryId(null);
        } else {
          setEnvAgentBusy(eventProfileId, false);
          setAgentPausedEnvIds((current) => current.filter((id) => id !== eventProfileId));
          // P4.4：任务结束清空该环境的 Open Tabs 快照
          setOpenTabsByEnv((current) => {
            if (!(eventProfileId in current)) {
              return current;
            }
            const next = { ...current };
            delete next[eventProfileId];
            return next;
          });
        }
      }
      if (msg) {
        const benignStop = (state === "failed" || state === "aborted") && isBenignAgentStopError(msg);
        const tone: TerminalLine["tone"] = benignStop
          ? "info"
          : state === "failed" || state === "aborted"
            ? "error"
            : state === "complete"
              ? "success"
              : "info";
        const text = benignStop
          ? isTrajectory
            ? `回放已手动停止：${msg}`
            : `Agent 已手动停止：${msg}`
          : msg;
        if (isTrajectory) {
          pushReplayLineFor(eventProfileId, tone, text);
        } else {
          const kindExtra = inferAgentLineKind(text, tone, state);
          pushAgentLineFor(eventProfileId, tone, text, kindExtra);
        }
      }

      // P2.1：Chat 桥接的 Agent 完成后回一条结论到对话区
      if (
        !isTrajectory &&
        (state === "complete" || state === "failed" || state === "aborted" || state === "stopped") &&
        chatBridgedAgentsRef.current.has(eventProfileId)
      ) {
        const bridgedGoal = chatBridgedAgentsRef.current.get(eventProfileId) ?? "";
        chatBridgedAgentsRef.current.delete(eventProfileId);
        const conclusion = String(event.payload.summary ?? "").trim();
        const tone =
          state === "complete" ? "success" : state === "failed" || state === "aborted" ? "error" : "info";
        // 成功且有交付物正文时，直接把结论回给用户（信息型任务的正文就是交付物），
        // 不再只丢一句「详情见 Agent 监视器」让用户自己去翻日志。
        const summary =
          state === "complete" && conclusion
            ? conclusion
            : state === "complete"
              ? `Agent 已完成（#${eventProfileId}）${bridgedGoal ? `：${bridgedGoal.slice(0, 60)}${bridgedGoal.length > 60 ? "…" : ""}` : ""}。详情见 Agent 监视器。`
              : `Agent 已结束（#${eventProfileId} · ${state}）${msg ? `：${msg.slice(0, 120)}` : ""}。详情见 Agent 监视器。`;
        pushLine(tone, summary, "assistant");
      }
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-state failed", error);
      });

    return () => {
      isCancelled = true;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, [pulseInbox, pushAgentLineFor, pushLine, pushReplayLineFor, setEnvAgentBusy, setEnvTrajectoryBusy]);

  // Always listen — drawer may be closed / on another tab when scrape finishes.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listen<{
      profileId?: string;
      data?: unknown;
      mode?: string;
      url?: string;
      count?: number;
      append?: boolean;
      localPath?: string;
    }>("scraper-data-collected", (event) => {
      const eventProfileId = String(event.payload.profileId ?? "").trim();
      if (!eventProfileId) {
        logger.warn("scraper-data-collected missing profileId, ignored");
        return;
      }
      const rows = normalizeScrapedRows(event.payload.data);
      const append = Boolean(event.payload.append);
      setScrapedDataByEnv((current) => {
        const prev = current[eventProfileId];
        const mergedRows = append && prev?.rows?.length ? [...prev.rows, ...rows] : rows;
        return {
          ...current,
          [eventProfileId]: {
            rows: mergedRows,
            mode: event.payload.mode ?? prev?.mode,
            url: event.payload.url ?? prev?.url,
            count: mergedRows.length,
            localPath: event.payload.localPath ?? prev?.localPath,
          },
        };
      });
      pushAgentLineFor(
        eventProfileId,
        "success",
        append
          ? `追加采集 ${rows.length} 条（合计已更新）`
          : event.payload.localPath
            ? `文件已保存：${event.payload.localPath}`
            : `已采集 ${event.payload.count ?? rows.length} 条数据${event.payload.mode ? ` · ${event.payload.mode}` : ""}`,
      );
      // 宪法 §5.3：采集结果在 Ai Chat 可见；勿强制拽回 Agent Tab
      setActiveTab((current) => (current === "trajectory" ? current : "ai"));
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        logger.error("listen scraper-data-collected failed", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [pushAgentLineFor]);

  useEffect(() => {
    if (!quickMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(event.target as Node)) {
        setQuickMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [quickMenuOpen]);

  const applyAiReplyToFormData = useCallback(
    (reply: string) => {
      const fillText = extractFillDataTextFromReply(reply);
      if (fillText) {
        setAiRawInput(fillText);
        setFillToolsOpen(true);
        try {
          localStorage.setItem(FILL_TOOLS_OPEN_KEY, "1");
        } catch {
          // ignore
        }
        pushLine("success", "已提取 JSON 并写入「填表数据」");
        return true;
      }
      const extracted = extractJsonFromAiReply(reply);
      if (!extracted) {
        return false;
      }
      setAiRawInput(JSON.stringify(extracted, null, 2));
      setFillToolsOpen(true);
      try {
        localStorage.setItem(FILL_TOOLS_OPEN_KEY, "1");
      } catch {
        // ignore
      }
      pushLine("success", "已提取 JSON 并写入「填表数据」");
      return true;
    },
    [pushLine],
  );

  const buildScrapeSummaryForChat = useCallback((): string | null => {
    if (!scrapedData || scrapedData.rows.length === 0) {
      return null;
    }
    const rows = scrapedData.rows.slice(0, 8);
    const keys = Array.from(
      rows.reduce((set, row) => {
        for (const key of Object.keys(row)) {
          set.add(key);
        }
        return set;
      }, new Set<string>()),
    ).slice(0, 12);
    const preview = rows.map((row) => {
      const slim: Record<string, unknown> = {};
      for (const key of keys) {
        const value = row[key];
        if (value == null) {
          continue;
        }
        const asText = typeof value === "string" ? value : JSON.stringify(value);
        slim[key] = asText.length > 80 ? `${asText.slice(0, 80)}…` : asText;
      }
      return slim;
    });
    return [
      `条数=${scrapedData.count ?? scrapedData.rows.length}`,
      scrapedData.mode ? `mode=${scrapedData.mode}` : null,
      scrapedData.url ? `url=${scrapedData.url}` : null,
      `列=${keys.join(",") || "(无)"}`,
      `预览JSON=${JSON.stringify(preview)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }, [scrapedData]);

  const runChatPrompt = useCallback(
    async (text: string, attachments: ChatAttachmentPayload[] = []) => {
      const trimmed = text.trim();
      if ((!trimmed && attachments.length === 0) || chatLoading) {
        return;
      }

      setChatLoading(true);
      onError("");
      const history = buildChatHistoryFromLines(lines);
      const attachLabel =
        attachments.length > 0 ? `（附件 ${attachments.map((item) => item.name).join("、")}）` : "";
      pushLine("info", `${trimmed || "（仅附件）"}${attachLabel}`, "user");

      try {
        const reply = await sendAiChat(
          trimmed || "请结合附件与当前上下文回答。",
          targetProfileId ?? undefined,
          history,
          {
            attachments,
            scrapeSummary: buildScrapeSummaryForChat() ?? undefined,
          },
        );
        const bridge = parseAgentBridgePayload(reply);
        const display = stripAgentBridgeMarker(reply) || reply;
        pushLine("success", display, "assistant");
        if (!bridge) {
          applyAiReplyToFormData(reply);
        } else {
          // 桥接到 Agent 时把本次聊天的附件一并转交：否则聊天模型看过图，Agent 上下文里却没有。
          await startAgentWithGoalRef.current(bridge.goal, {
            fromChat: true,
            attachments,
          });
        }
      } catch (error) {
        const message = formatInvokeError(error);
        pushLine("error", `对话失败: ${message}`, "assistant");
        onError(message);
      } finally {
        setChatLoading(false);
        setChatAttachments([]);
      }
    },
    [
      applyAiReplyToFormData,
      buildScrapeSummaryForChat,
      chatLoading,
      lines,
      onError,
      pushLine,
      targetProfileId,
    ],
  );

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text && chatAttachments.length === 0) {
      return;
    }
    const pending = chatAttachments;
    setChatInput("");
    setChatAttachments([]);
    await runChatPrompt(text, pending);
  };

  const handleStartBrowser = async () => {
    const targetIds = selectedIds.length > 0 ? selectedIds : targetProfileId ? [targetProfileId] : [];
    if (targetIds.length === 0) {
      onError("请先在左侧选择一个或多个环境");
      return;
    }
    if (!onStartBrowser) {
      onError("浏览器启动接口未接入");
      return;
    }

    const toStart = targetIds.filter((id) => {
      const profile = profiles.find((item) => String(item.id) === id);
      return profile != null && profile.status !== "running";
    });
    if (toStart.length === 0) {
      onError("所选环境均已在运行");
      return;
    }

    onError("");
    let okCount = 0;
    let failCount = 0;
    for (const id of toStart) {
      pushAgentLineFor(id, "info", `▶ 启动浏览器 · 环境 #${id}`);
      try {
        const ok = await onStartBrowser(id);
        if (ok === false) {
          failCount += 1;
          pushAgentLineFor(id, "error", `启动浏览器失败 · #${id}`);
          continue;
        }
        okCount += 1;
        pushAgentLineFor(id, "success", `浏览器已启动 · #${id}`);
      } catch (error) {
        failCount += 1;
        const message = formatInvokeError(error);
        pushAgentLineFor(id, "error", `启动浏览器失败：${message}`);
        onError(message);
      }
    }
    if (toStart.length > 1) {
      pushAgentLine(
        failCount > 0 ? "warn" : "success",
        `批量启动结束 · 成功 ${okCount} · 失败 ${failCount} · 共 ${toStart.length}`,
      );
    }
  };

  const handleStopBrowser = async () => {
    const targetIds = selectedIds.length > 0 ? selectedIds : targetProfileId ? [targetProfileId] : [];
    if (targetIds.length === 0) {
      onError("请先在左侧选择一个或多个环境");
      return;
    }
    if (!onStopBrowser) {
      onError("浏览器停止接口未接入");
      return;
    }

    const toStop = targetIds.filter((id) => {
      const profile = profiles.find((item) => String(item.id) === id);
      return profile?.status === "running";
    });
    if (toStop.length === 0) {
      onError("所选环境均未运行");
      return;
    }

    if (agentBusy && targetProfileId && toStop.includes(targetProfileId)) {
      await handleAbortAgent();
    }

    onError("");
    let okCount = 0;
    let failCount = 0;
    for (const id of toStop) {
      pushAgentLineFor(id, "info", `▶ 停止浏览器 · 环境 #${id}`);
      try {
        const ok = await onStopBrowser(id);
        clearEnvExecutionBusy(id);
        if (ok === false) {
          failCount += 1;
          pushAgentLineFor(id, "error", `停止浏览器失败 · #${id}`);
          continue;
        }
        okCount += 1;
        pushAgentLineFor(id, "info", `浏览器已停止 · #${id}`);
      } catch (error) {
        clearEnvExecutionBusy(id);
        failCount += 1;
        const message = formatInvokeError(error);
        if (isBenignAgentStopError(error) || isBenignAgentStopError(message)) {
          okCount += 1;
          failCount -= 1;
          pushAgentLineFor(id, "info", `浏览器已停止 · #${id}`);
          onError("");
        } else {
          pushAgentLineFor(id, "error", `停止浏览器失败：${message}`);
          onError(message);
        }
      }
    }
    if (toStop.length > 1) {
      pushAgentLine(
        failCount > 0 ? "warn" : "info",
        `批量停止结束 · 成功 ${okCount} · 失败 ${failCount} · 共 ${toStop.length}`,
      );
    }
  };

  const startAgentWithGoal = useCallback(
    async (goalInput: string, options?: { fromChat?: boolean; attachments?: ChatAttachmentPayload[] }) => {
      const pendingAttachments = options?.attachments ?? [];
      const goal = goalInput.replace(/\s+/g, " ").trim();
      if (!goal && pendingAttachments.length === 0) {
        onError("请填写 Agent 目标（例如：打开百度并搜索天气；或 #2 开百度 #5 开谷歌）");
        return;
      }
      // 只有附件没写目标时，用一句兜底目标驱动任务；正文里附件会一并交给模型
      const effectiveGoal = goal || "请根据所附图片/文件与当前页面完成相应操作，并在结束时说明结果。";

      const policy = await refreshAgentSeatPolicy();
      const routed = resolveAgentTargets({
        goal: effectiveGoal,
        selectedIds,
        runningIds: runningProfileIds,
        policy,
      });
      if (routed.error) {
        onError(routed.error);
        return;
      }

      // Free Key + 151-pro fingerprint pin：跳过不可 AI 的环境
      const allowedAssignments = routed.assignments.filter((item) => {
        const profile = profiles.find((p) => String(p.id) === item.profileId);
        if (isAiBlockedForKernel(policy.isPro, profile?.browser_version)) {
          pushLine("warn", `#${item.profileId} ${aiBlockedKernelMessage(profile?.browser_version)}`);
          return false;
        }
        return true;
      });
      if (allowedAssignments.length === 0) {
        onError(
          routed.assignments.length > 0
            ? aiBlockedKernelMessage(
                profiles.find((p) => String(p.id) === routed.assignments[0]?.profileId)?.browser_version,
              )
            : "没有可启动 Agent 的环境",
        );
        return;
      }

      const targets = allowedAssignments.filter(
        (item) =>
          !agentBusyEnvIds.includes(item.profileId) &&
          !trajectoryBusyEnvIds.includes(item.profileId) &&
          !rpaBusyEnvIds.includes(item.profileId),
      );
      if (targets.length === 0) {
        onError("目标环境均正忙（Agent / 填表 / 轨迹回放），请先停止后再启动 Agent");
        return;
      }

      if (!options?.fromChat) {
        setAgentGoal("");
        setAgentAttachments([]);
        setMentionQuery(null);
      }
      onError("");
      setAgentRouteMode(routed.mode);
      setAgentBatchIds(targets.map((item) => item.profileId));

      const goalMap: Record<string, string> = { ...agentGoalByEnv };
      for (const item of targets) {
        goalMap[item.profileId] = normalizeAgentGoalKey(item.goal);
      }
      setAgentGoalByEnv(goalMap);
      agentGoalByEnvRef.current = goalMap;
      registerAgentGoals(goalMap);

      if (options?.fromChat) {
        for (const item of targets) {
          chatBridgedAgentsRef.current.set(item.profileId, item.goal);
        }
      }

      if (routed.skippedNotRunning.length > 0) {
        pushLine("warn", `已忽略未打开环境：#${routed.skippedNotRunning.join("、#")}`);
      }
      if (routed.skippedOverCap.length > 0) {
        const capLabel = !policy.isPro
          ? "免费版 AI 限 1 个免费核"
          : `AI 席位上限 ${routed.maxAllowed ?? "?"}`;
        pushLine("warn", `${capLabel}（打开浏览器不限），已跳过：#${routed.skippedOverCap.join("、#")}`);
      }

      const modeLabel = routed.mode === "broadcast" ? "广播" : "分派";
      const sourceLabel = options?.fromChat ? "（由 Chat 桥接）" : "";
      pushLine(
        "info",
        `▶ Agent ${modeLabel}${sourceLabel} ${targets.length} 个环境：#${targets.map((item) => item.profileId).join("、#")}${
          agentSeatsSummary ? ` · ${agentSeatsSummary}` : ""
        }${routed.maxAllowed != null ? ` · 上限 ${routed.maxAllowed}` : ""}`,
      );
      if (enableRecording) {
        pushLine("info", "轨迹录制已开启：成功结束后写入「轨迹记忆」；运行摘要始终保存");
      } else {
        pushLine("info", "未勾选「录制轨迹」：不写回放轨迹，但仍会保存运行摘要");
      }

      // 规则与人设**都只**来自 @引用：没有 @ 时不下发 taskRules、也不套人设。
      const mentions = resolveGoalMentions(effectiveGoal, ruleLibrary.rules, ruleLibrary.personas);
      const rulesForTask = mentions.rules;
      // C1：同一起点命中多条时取最长的那个，但要明确告诉用户存在歧义。
      for (const ambiguity of mentions.ambiguities) {
        pushLine(
          "warn",
          `「${ambiguity.mention}」有歧义：还匹配到 ${ambiguity.candidates
            .filter((name) => !ambiguity.picked.includes(name))
            .join("、")}；已按最长名称「${ambiguity.picked.join("、")}」生效`,
        );
      }
      // @点名人设 = 本次任务所有目标统一使用；固定字段直接读人设自身（勾选过按勾选，否则默认固定已填字段）。
      const mentionedPersona = mentions.persona
        ? {
            persona: mentions.persona,
            fields: personaEffectiveFixedFields(mentions.persona),
          }
        : null;

      if (rulesForTask.length > 0) {
        pushLine(
          "info",
          `本次引用规则 ${rulesForTask.length} 条：${rulesForTask
            .map((rule) => rule.title)
            .slice(0, 6)
            .join("、")}${rulesForTask.length > 6 ? "…" : ""}`,
        );
      }
      if (mentionedPersona) {
        const fixedKeys = Object.keys(personaFixedValues(mentionedPersona.persona, mentionedPersona.fields));
        pushLine(
          "info",
          `@ 点名人设「${mentionedPersona.persona.label}」${
            fixedKeys.length > 0 ? ` · 固定字段：${fixedKeys.join("、")}` : " · 未固定字段（仅作参考）"
          }；本次任务的 ${targets.length} 个环境统一使用它，未固定的必填项由 AI 随机生成`,
        );
      } else if (ruleLibrary.personas.length > 0) {
        // 人设只在被 @引用 时生效（与规则一致），不绑定环境、也不自动套用。
        pushLine(
          "info",
          "本次任务没有 @人设：不套用人设（必填项由 AI 现生成）；要用请在输入框写 @人设名",
        );
      }
      // 人设只在 @引用 时随任务下传（@ 是唯一开关）；不再按环境解析自动套用。
      const taskPersonaPayload = mentionedPersona
        ? {
            label: mentionedPersona.persona.label,
            fields: mentionedPersona.fields,
            fixed: personaFixedValues(mentionedPersona.persona, mentionedPersona.fields),
          }
        : null;
      if (pendingAttachments.length > 0 && !options?.fromChat) {
        pushLine(
          "info",
          `已附加 ${pendingAttachments.length} 个文件：${pendingAttachments
            .map((item) => item.name)
            .join("、")}`,
        );
      }

      const settingsSnap = await fetchSettings().catch(() => null);
      const thinkingModel = settingsSnap != null ? resolveTaskModel(settingsSnap, "agent") : "";

      for (const item of targets) {
        setEnvAgentBusy(item.profileId, true);
        pushAgentLineFor(
          item.profileId,
          "info",
          `▶ 启动 Agent：${item.goal.slice(0, 80)}${item.goal.length > 80 ? "…" : ""}`,
          { kind: "system" },
        );
        pushAgentLineFor(
          item.profileId,
          "info",
          thinkingModel
            ? `已提交任务分析（模型 ${thinkingModel}）· 等待 sidecar 阶段回传…`
            : "已提交任务分析 · 等待 sidecar 阶段回传…",
          { kind: "thought" },
        );
      }

      const settled = await Promise.allSettled(
        targets.map(async (item) => {
          try {
            const result = await startAutonomousAgent(
              item.profileId,
              item.goal,
              undefined,
              "balanced",
              enableRecording,
              {
                attachments: pendingAttachments,
                taskRules: rulesPayload(rulesForTask),
                // 人设只在 @引用 时下传；@ 是唯一开关（缺省 null = 由 AI 现生成）。
                taskPersona: taskPersonaPayload,
              },
            );
            const msg = result.msg || result.state;
            // 终态文案已由 agent-state 推入 Monitor，此处仅汇总 ok，避免重复红字（含浏览器关闭/异常退出）
            if ((result.state === "failed" || result.state === "aborted") && isBenignAgentStopError(msg)) {
              return { profileId: item.profileId, ok: true, msg };
            }
            if (result.state === "complete") {
              return { profileId: item.profileId, ok: true, msg };
            }
            if (result.state === "failed" || result.state === "aborted") {
              return { profileId: item.profileId, ok: false, msg };
            }
            pushAgentLineFor(item.profileId, "error", msg);
            return { profileId: item.profileId, ok: false, msg };
          } catch (error) {
            const message = formatInvokeError(error);
            if (isBenignAgentStopError(error) || isBenignAgentStopError(message)) {
              pushAgentLineFor(item.profileId, "info", `Agent 已手动停止：${message}`);
              return { profileId: item.profileId, ok: true, msg: message };
            }
            pushAgentLineFor(item.profileId, "error", `发生错误：${message}`);
            return { profileId: item.profileId, ok: false, msg: message };
          } finally {
            setEnvAgentBusy(item.profileId, false);
          }
        }),
      );

      let failCount = 0;
      for (const item of settled) {
        if (item.status === "rejected") {
          failCount += 1;
          continue;
        }
        if (!item.value.ok) {
          failCount += 1;
        }
      }
      if (targets.length > 1) {
        pushLine(
          failCount > 0 ? "warn" : "success",
          `Agent ${modeLabel}结束 · 成功 ${targets.length - failCount} · 失败 ${failCount} · 共 ${targets.length}`,
        );
      }
      if (failCount > 0 && targets.length === 1) {
        const first = settled[0];
        if (first?.status === "fulfilled" && first.value.msg) {
          // 浏览器关闭 / Sidecar 退出等终态已由 rpa-state 推送；此处仅补非会话清理类错误
          const msg = first.value.msg;
          if (
            !msg.includes("浏览器已关闭") &&
            !msg.includes("Sidecar 进程异常退出") &&
            !msg.includes("会话已清理")
          ) {
            onError(msg);
          }
        }
      }

      setAgentBusyEnvIds((current) => {
        if (current.length === 0) {
          setAgentRouteMode("idle");
        }
        return current;
      });
    },
    [
      agentBusyEnvIds,
      agentGoalByEnv,
      agentSeatsSummary,
      enableRecording,
      onError,
      profiles,
      pushAgentLineFor,
      pushLine,
      registerAgentGoals,
      refreshAgentSeatPolicy,
      rpaBusyEnvIds,
      ruleLibrary,
      runningProfileIds,
      selectedIds,
      setEnvAgentBusy,
      trajectoryBusyEnvIds,
    ],
  );

  startAgentWithGoalRef.current = startAgentWithGoal;

  const handleStartAgent = async () => {
    await startAgentWithGoal(agentGoal, { attachments: agentAttachments });
  };

  const handleAbortAgent = async () => {
    const ids =
      agentBusyEnvIds.length > 0
        ? agentBusyEnvIds
        : agentBatchIds.length > 0
          ? agentBatchIds
          : targetProfileId
            ? [targetProfileId]
            : [];
    if (ids.length === 0) {
      return;
    }
    let failMessage = "";
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await abortAutonomousAgent(id);
          setEnvAgentBusy(id, false);
          pushAgentLineFor(id, "info", "Agent 已手动停止");
        } catch (error) {
          const message = formatInvokeError(error);
          if (isBenignAgentStopError(error) || isBenignAgentStopError(message)) {
            setEnvAgentBusy(id, false);
            pushAgentLineFor(id, "info", `Agent 已手动停止：${message}`);
          } else {
            failMessage = message;
            pushAgentLineFor(id, "error", `停止失败：${message}`);
          }
        }
      }),
    );
    setAgentPausedEnvIds([]);
    setAgentRouteMode("idle");
    if (failMessage) {
      onError(failMessage);
    } else {
      onError("");
    }
  };

  /** P4.5：暂停全部忙碌 Agent（软闸，不中止） */
  const handlePauseAgent = async () => {
    const ids = agentBusyEnvIds.filter((id) => !agentPausedEnvIds.includes(id));
    if (ids.length === 0) {
      return;
    }
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await pauseAutonomousAgent(id);
          pushAgentLineFor(id, "info", "已请求暂停 · 当前步结束后挂起");
        } catch (error) {
          pushAgentLineFor(id, "error", `暂停失败：${formatInvokeError(error)}`);
        }
      }),
    );
  };

  /** P4.5：继续全部已暂停 Agent（复用 handover resume / task_pause_lock） */
  const handleResumeAgent = async () => {
    const ids =
      agentPausedEnvIds.length > 0 ? agentPausedEnvIds : agentBusyEnvIds.length > 0 ? agentBusyEnvIds : [];
    if (ids.length === 0) {
      return;
    }
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await continueAgentHandover(id);
          pushAgentLineFor(id, "info", "已请求继续 · 将从观察步恢复");
        } catch (error) {
          pushAgentLineFor(id, "error", `继续失败：${formatInvokeError(error)}`);
        }
      }),
    );
  };

  const handleQuickCommand = async (command: QuickCommand) => {
    setQuickMenuOpen(false);
    if (command.fillOnly) {
      setChatInput(command.prompt);
      pushLine("info", `已填入「${command.label}」，请编辑后手动发送`);
      return;
    }
    setChatInput("");
    await runChatPrompt(command.prompt);
  };

  const handleSaveCustomCommand = async () => {
    const commandPrompt = chatInput.trim();
    if (!commandPrompt) {
      onError("请先在输入框中填写要保存的快捷命令内容");
      return;
    }

    const label = await prompt({
      title: "增加快捷命令",
      description: "请输入快捷命令名称，将显示在快捷命令菜单中。",
      defaultValue: "自定义命令",
      placeholder: "例如：提取表单 JSON",
      confirmLabel: "增加",
    });
    if (!label?.trim()) {
      return;
    }

    const next: QuickCommand = {
      id: `custom-${Date.now()}`,
      label: label.trim(),
      prompt: commandPrompt,
    };
    const updated = [...customCommands, next];
    setCustomCommands(updated);
    saveCustomQuickCommands(updated);
    setQuickMenuOpen(false);
    pushLine("success", `已增加快捷命令「${next.label}」`);
  };

  const handleDeleteCustomCommand = async (command: QuickCommand) => {
    if (!command.id.startsWith("custom-")) {
      onError("内置快捷命令不可删除");
      return;
    }
    const confirmed = await confirm({
      title: "删除快捷命令",
      description: `确定删除「${command.label}」？此操作不可撤销。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    const updated = customCommands.filter((item) => item.id !== command.id);
    setCustomCommands(updated);
    saveCustomQuickCommands(updated);
    pushLine("info", `已删除快捷命令「${command.label}」`);
  };

  const openAgentForRecording = useCallback(() => {
    if (!enableRecording) {
      setEnableRecording(true);
      persistAgentEnableRecording(true);
      pushLine("info", "已自动勾选「录制轨迹」：下次成功结束后将写入轨迹记忆");
    }
    setActiveTab("agent");
  }, [enableRecording, pushLine]);

  /** 把 sidecar/Rust 返回的终态落到 UI（暂停 / 完成 / 失败三态由 state 字段直接决定） */
  const applyRpaResult = useCallback((result: RpaRunResult) => {
    const nextState: RpaUiState =
      result.state === "complete" ? "complete" : result.state === "failed" ? "failed" : "paused";
    setRpaState(nextState);
    setRpaMessage(result.msg);
    if (Array.isArray(result.actions)) {
      setCurrentActions(result.actions as RpaAction[]);
    }
  }, []);

  const executeRpa = useCallback(
    async (confirmedProfile?: string) => {
      if (!targetProfileId) {
        onError("请先选择或启动一个运行中的环境");
        return;
      }
      if (agentBusyEnvIds.includes(targetProfileId) || trajectoryBusyEnvIds.includes(targetProfileId)) {
        onError("当前环境正忙，请先停止 Agent/回放后再填表");
        return;
      }
      if (rpaBusyEnvIds.includes(targetProfileId)) {
        onError("当前环境正在填表，请稍后再试");
        return;
      }
      const fillInput = aiRawInput;
      if (!fillInput.trim()) {
        onError("请粘贴填表数据");
        return;
      }

      const normalizedFill = normalizeFillInputForExecution(fillInput);
      const fillPayload = normalizedFill.rpaActions.length > 0 ? normalizedFill.payload : fillInput;

      setAiSubmitting(true);
      setEnvRpaBusy(targetProfileId, true);
      setRpaState("running");
      setRpaMessage("");
      onError("");

      pushLine("info", skipHybrid ? "▶ 纯执行模式填表中…" : "▶ AI 填表执行中…");

      try {
        let actionsToSend: RpaAction[] | undefined;
        if (skipHybrid && currentActions.length > 0) {
          actionsToSend = currentActions;
        } else if (skipHybrid && normalizedFill.rpaActions.length > 0) {
          actionsToSend = normalizedFill.rpaActions as RpaAction[];
        }

        const result = await runRpaFill(targetProfileId, fillPayload, {
          actions: actionsToSend,
          confirmedProfile,
          skipHybrid,
          pressEnterAfterFill,
        });

        applyRpaResult(result);
        pushLine(
          result.state === "complete" ? "success" : result.msg.includes("失败") ? "error" : "info",
          `${result.msg} (step=${result.step})`,
        );
      } catch (error) {
        const message = formatInvokeError(error);
        setRpaState("failed");
        setRpaMessage(message);
        pushLine("error", message);
        onError(message);
      } finally {
        setAiSubmitting(false);
        setEnvRpaBusy(targetProfileId, false);
      }
    },
    [
      agentBusyEnvIds,
      aiRawInput,
      applyRpaResult,
      currentActions,
      onError,
      pressEnterAfterFill,
      pushLine,
      rpaBusyEnvIds,
      setEnvRpaBusy,
      skipHybrid,
      targetProfileId,
      trajectoryBusyEnvIds,
    ],
  );

  const handleDirectFill = async () => {
    if (!targetProfileId) {
      onError("请先选择或启动一个运行中的环境");
      return;
    }
    if (envExecuting) {
      onError(`当前环境正忙（${envBusyReason}），请先停止当前任务后再填表`);
      return;
    }
    if (!aiRawInput.trim()) {
      onError("请填写填表数据");
      return;
    }
    if (isAiBlockedForKernel(agentSeatPolicy.isPro, targetProfile?.browser_version)) {
      onError(aiBlockedKernelMessage(targetProfile?.browser_version));
      return;
    }

    setDirectFillSubmitting(true);
    setEnvRpaBusy(targetProfileId, true);
    onError("");
    pushLine("info", "▶ 直接填表：按 name/id/label 启发式映射当前页面字段…");

    try {
      await runDirectFill(targetProfileId, aiRawInput, pressEnterAfterFill);
      pushLine("success", "直接填表已完成，请在浏览器中核对填写结果");
    } catch (error) {
      const message = formatInvokeError(error);
      pushLine("error", `直接填表失败: ${message}`);
      onError(message);
    } finally {
      setDirectFillSubmitting(false);
      setEnvRpaBusy(targetProfileId, false);
    }
  };

  const handleSmartFill = async () => {
    const naturalLanguage = chatInput.trim();
    if (!smartFillEnabled || !targetProfileId) {
      onError("请先启动环境后再使用智能填表");
      return;
    }
    if (envExecuting) {
      onError(`当前环境正忙（${envBusyReason}），请先停止当前任务后再填表`);
      return;
    }
    if (!naturalLanguage) {
      onError("请在上方输入框用自然语言描述要填写的内容（如卡号、地址、姓名等）");
      return;
    }
    if (isAiBlockedForKernel(agentSeatPolicy.isPro, targetProfile?.browser_version)) {
      onError(aiBlockedKernelMessage(targetProfile?.browser_version));
      return;
    }

    setSmartFillSubmitting(true);
    setEnvRpaBusy(targetProfileId, true);
    onError("");
    pushLine(
      "info",
      `▶ 智能填表：解析「${naturalLanguage.slice(0, 48)}${naturalLanguage.length > 48 ? "…" : ""}」并填表…`,
    );

    try {
      const exportJson = await runSmartFill(
        targetProfileId,
        naturalLanguage,
        aiRawInput.trim() || undefined,
        pressEnterAfterFill,
      );
      // 智能填表已成功：解析导出 JSON 仅用于回填编辑框，格式异常不应回滚成功状态
      try {
        setAiRawInput(JSON.stringify(JSON.parse(exportJson), null, 2));
      } catch {
        setAiRawInput(exportJson);
      }
      setChatInput("");
      pushLine("success", "智能填已完成，已更新「填表数据」中的元素 JSON");
    } catch (error) {
      const message = formatInvokeError(error);
      pushLine("error", `智能填表失败: ${message}`);
      onError(message);
    } finally {
      setSmartFillSubmitting(false);
      setEnvRpaBusy(targetProfileId, false);
    }
  };

  const handleAiRun = async () => {
    if (!targetProfileId) {
      onError("请先选择或启动一个运行中的环境");
      return;
    }
    if (envExecuting) {
      onError(`当前环境正忙（${envBusyReason}），请先停止当前任务后再填表`);
      return;
    }
    if (!aiRawInput.trim()) {
      onError("请粘贴填表数据");
      return;
    }

    // 人工确认开关必须真正生效：关闭后不再弹预览窗，直接执行。
    // 混合推演（skipHybrid=false）仍会在 sidecar 内完成，只是跳过人工核对 JSON。
    if (!forceHumanConfirm) {
      await executeRpa(undefined);
      return;
    }

    setPreviewLoading(true);
    onError("");
    pushLine("info", skipHybrid ? "▶ 准备填表预览（跳过混合推演）…" : "▶ 正在混合推演填表数据…");

    try {
      const preview = skipHybrid
        ? buildDirectPreviewJson(aiRawInput)
        : formatPreviewJson(await previewAiFill(targetProfileId, aiRawInput));
      setConfirmJson(preview);
      setConfirmOpen(true);
      pushLine("success", "已生成预览，请在确认弹窗中核对 JSON");
    } catch (error) {
      const message = formatInvokeError(error);
      pushLine("error", `预览失败: ${message}`);
      onError(message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleConfirmFill = async () => {
    if (!confirmJson.trim()) {
      onError("确认填表数据不能为空");
      return;
    }
    setConfirmOpen(false);
    await executeRpa(confirmJson);
  };

  const handleDeleteTrajectory = async (trajectory: AgentTrajectory) => {
    try {
      await deleteAgentTrajectory(trajectory.id, trajectory.file_path);
      pushAgentLine(
        "success",
        `已删除轨迹：${trajectory.title || trajectory.file_name || `#${trajectory.id}`}`,
      );
      await refreshTrajectories();
    } catch (error) {
      onError(formatInvokeError(error));
    }
  };

  const handleExecuteTrajectory = async (trajectory: AgentTrajectory) => {
    if (!targetProfileId) {
      onError("请先选择或启动一个运行中的环境");
      return;
    }

    let actions: unknown[] = [];
    try {
      const parsed = JSON.parse(trajectory.actions) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) {
        onError("该轨迹没有可执行步骤");
        return;
      }
      actions = parsed;
    } catch {
      onError("轨迹动作 JSON 解析失败");
      return;
    }

    if (envExecuting) {
      onError(`当前环境正忙（${envBusyReason}），请先停止当前任务后再回放`);
      return;
    }

    setEnvTrajectoryBusy(targetProfileId, true);
    setExecutingTrajectoryId(trajectory.id);
    onError("");
    pushReplayLine(
      "info",
      `▶ 轨迹回放「${trajectory.title}」· ${actions.length} 步（脚本优先，需分析时再 AI 交付）`,
    );

    // 回放目标里的 `@人设 / @规则`（与 Agent 输入框、多环境沙盘同一套解析与口径）
    const replayGoal = trajectory.goal || trajectory.title;
    const replayMentions = resolveGoalMentions(replayGoal, ruleLibrary.rules, ruleLibrary.personas);
    const replayPersona = replayMentions.persona;
    if (replayMentions.rules.length > 0) {
      pushReplayLine(
        "info",
        `目标引用了规则：${replayMentions.rules.map((rule) => `@${rule.title}`).join("、")} · 机械步跑完后按规则硬校验`,
      );
    }
    if (replayPersona) {
      pushReplayLine("info", `目标引用了人设「@${replayPersona.label}」：{{persona.*}} 用它`);
    }

    try {
      const result = await replayAgentTrajectory(targetProfileId, {
        filePath: trajectory.file_path,
        actions: trajectory.file_path ? null : actions,
        title: trajectory.title,
        goal: replayGoal,
        taskRules: replayMentions.rules.length > 0 ? rulesPayload(replayMentions.rules) : null,
        taskPersona: replayPersona
          ? {
              label: replayPersona.label,
              fixed: personaFixedValues(
                replayPersona,
                personaEffectiveFixedFields(replayPersona),
              ),
            }
          : null,
        personaData: replayPersona ? personaTemplateValues(replayPersona) : null,
      });
      const ok = result.state === "complete";
      const benign = result.state === "failed" && isBenignAgentStopError(result.msg || "");
      // 进度与终态由 agent-state → 回放日志；此处仅补 Banner
      if (!ok && !benign) {
        onError(result.msg || "轨迹回放失败");
      }
    } catch (error) {
      const message = formatInvokeError(error);
      if (isBenignAgentStopError(error) || isBenignAgentStopError(message)) {
        pushReplayLine("info", `回放已停止：${message}`);
      } else {
        pushReplayLine("error", `回放失败：${message}`);
        onError(message);
      }
    } finally {
      setEnvTrajectoryBusy(targetProfileId, false);
      setExecutingTrajectoryId(null);
    }
  };

  const handleStopTrajectory = async () => {
    const targets =
      trajectoryBusyEnvIds.length > 0 ? [...trajectoryBusyEnvIds] : targetProfileId ? [targetProfileId] : [];
    if (targets.length === 0) {
      setExecutingTrajectoryId(null);
      return;
    }
    pushReplayLine("info", targets.length > 1 ? `正在停止回放 · ${targets.length} 个环境…` : "正在停止回放…");
    try {
      await Promise.allSettled(
        targets.map(async (id) => {
          try {
            await abortAutonomousAgent(id);
          } catch (error) {
            const message = formatInvokeError(error);
            if (!isBenignAgentStopError(error) && !isBenignAgentStopError(message)) {
              pushReplayLine("error", `环境 #${id} 停止回放失败：${message}`);
            }
          }
        }),
      );
    } finally {
      // 停止后立即清 busy，避免 abort 未 unwind 时按钮永久灰掉
      for (const id of targets) {
        setEnvTrajectoryBusy(id, false);
      }
      setExecutingTrajectoryId(null);
    }
  };

  return (
    <aside className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-card">
      {/* 工作区分段导航 */}
      <div className="shrink-0 px-2 py-2">
        <div className="segmented" role="tablist" aria-label="工作区">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "agent"}
            className={`segmented-item ${activeTab === "agent" ? "segmented-item-active" : ""}`}
            onClick={() => setActiveTab("agent")}
            title="浏览器 Agent"
          >
            <Bot size={13} />
            <span className="truncate">Agent</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "ai"}
            className={`segmented-item ${activeTab === "ai" ? "segmented-item-active" : ""}`}
            onClick={() => setActiveTab("ai")}
            title="Ai Chat"
          >
            <Sparkles size={13} />
            <span className="truncate">Ai Chat</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "runs"}
            className={`segmented-item ${activeTab === "runs" ? "segmented-item-active" : ""}`}
            onClick={() => setActiveTab("runs")}
            title="运行历史"
          >
            <ClipboardList size={13} />
            <span className="truncate">运行历史</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "trajectory"}
            className={`segmented-item ${activeTab === "trajectory" ? "segmented-item-active" : ""}`}
            onClick={() => setActiveTab("trajectory")}
            title="轨迹记忆"
          >
            <History size={13} />
            <span className="truncate">轨迹记忆</span>
          </button>
        </div>
      </div>

      {activeTab === "agent" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-2">
            <AgentOpenTabsBar
              profileId={targetProfileId}
              tabs={openTabs}
              visible={showOpenTabsBar}
              onError={onError}
            />
            <AgentThoughtChain
              lines={agentLines}
              title="监视日志"
              emptyHint="启动后，思考与步骤会出现在这里"
              className="min-h-0 flex-1"
              onClear={() => {
                if (!targetProfileId) {
                  return;
                }
                setAgentLinesByEnv((current) => ({ ...current, [targetProfileId]: [] }));
              }}
              headerActions={
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1 rounded bg-code-hover px-1.5 text-[10px] font-medium text-code-text transition-colors hover:text-code-text disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={
                      browserTargetIds.length === 0 || selectedStoppedCount === 0 || browserTargetsBusy
                    }
                    title={
                      browserTargetIds.length === 0
                        ? "请先选择环境"
                        : selectedStoppedCount === 0
                          ? "所选环境均已在运行"
                          : selectedStoppedCount > 1
                            ? `启动已选中的 ${selectedStoppedCount} 个未运行环境`
                            : "启动当前环境浏览器"
                    }
                    onClick={() => void handleStartBrowser()}
                  >
                    <Play size={10} />
                    {browserTargetsBusy && selectedStoppedCount > 0
                      ? "启动中"
                      : selectedStoppedCount > 1
                        ? `启动(${selectedStoppedCount})`
                        : "启动"}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1 rounded bg-code-hover px-1.5 text-[10px] font-medium text-code-text transition-colors hover:text-code-text disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={
                      browserTargetIds.length === 0 || selectedRunningCount === 0 || browserTargetsBusy
                    }
                    title={
                      selectedRunningCount === 0
                        ? "所选环境均未运行"
                        : selectedRunningCount > 1
                          ? `停止已选中的 ${selectedRunningCount} 个运行中环境`
                          : "停止当前环境浏览器"
                    }
                    onClick={() => void handleStopBrowser()}
                  >
                    <Square size={10} />
                    {browserTargetsBusy && selectedRunningCount > 0
                      ? "停止中"
                      : selectedRunningCount > 1
                        ? `停止(${selectedRunningCount})`
                        : "停止"}
                  </button>
                </div>
              }
            />
          </div>

          <div className="workbench-footer">
            {/* Agent 输入框与 Ai Chat 不同：Agent 运行中仍允许继续编辑目标/附件（下次启动生效），
                因此附件条与纸夹按钮不随聊天/填表忙碌禁用，这是有意为之，不是遗漏 disabled。 */}
            <ChatAttachmentChips attachments={agentAttachments} onChange={setAgentAttachments} />
            <div className="relative px-2.5 pt-2">
              {mentionQuery !== null ? (
                <div className="absolute bottom-full left-2.5 right-2.5 z-30 mb-1 max-h-56 overflow-y-auto rounded-lg bg-raised p-1 shadow-pop">
                  <p className="px-2 py-1 text-[10px] text-muted-foreground">
                    {mentionItems.length > 0 ? "规则 / 人设" : "没有匹配项"}
                  </p>
                  {mentionItems.map((item, index) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] ${
                        index === mentionIndex
                          ? "row-selected text-foreground"
                          : "row-selectable text-muted-foreground"
                      }`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(item)}
                    >
                      <span className="min-w-0 truncate">@{item.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={agentGoalRef}
                className="field-input max-h-[120px] min-h-[58px] w-full resize-y px-3 py-2 pr-12 text-ui leading-5"
                value={agentGoal}
                onChange={(event) => handleAgentGoalChange(event.target.value, event.target.selectionStart)}
                onPaste={agentAttach.onPaste}
                onClick={(event) => syncMentionFromCaret(event.currentTarget)}
                onSelect={(event) => syncMentionFromCaret(event.currentTarget)}
                onBlur={() => setMentionQuery(null)}
                onKeyDown={(event) => {
                  // 中文输入法候选框的 Enter / 方向键不能被抢：正在组词时一律放行给 IME
                  if (event.nativeEvent.isComposing) {
                    return;
                  }
                  if (mentionQuery !== null && mentionItems.length > 0 && !event.ctrlKey && !event.metaKey) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setMentionIndex((current) => (current + 1) % mentionItems.length);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setMentionIndex((current) => (current - 1 + mentionItems.length) % mentionItems.length);
                      return;
                    }
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      insertMention(mentionItems[mentionIndex] ?? mentionItems[0]);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setMentionQuery(null);
                      return;
                    }
                  }
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    if (
                      (agentGoal.trim() || agentAttachments.length > 0) &&
                      (selectedRunningIds.some((id) => !agentBusyEnvIds.includes(id)) ||
                        /(?:环境\s*#?\s*|#)\d+/i.test(agentGoal))
                    ) {
                      void handleStartAgent();
                    }
                  }
                }}
                disabled={false}
                placeholder="描述任务目标…"
                rows={2}
              />
              <div className="absolute bottom-2 right-3.5 flex items-center gap-1">
                <input
                  ref={agentAttach.fileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  accept={ATTACHMENT_ACCEPT}
                  onChange={agentAttach.onFilePicked}
                />
                <button
                  type="button"
                  className="btn btn-outline px-2 py-1 text-[11px]"
                  title="添加图片或文本附件"
                  onClick={() => agentAttach.fileInputRef.current?.click()}
                >
                  <Paperclip size={12} />
                </button>
              </div>
            </div>

            {agentMentionSummary ? (
              <div className="px-2.5 pt-1.5">
                <span className="context-badge truncate">已引用 · {agentMentionSummary}</span>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2 pt-2">
              <button
                type="button"
                className="btn btn-primary h-8 shrink-0 px-3.5 text-ui"
                disabled={
                  (!agentGoal.trim() && agentAttachments.length === 0) ||
                  (selectedRunningIds.length === 0 && !/(?:环境\s*#?\s*|#)\d+/i.test(agentGoal.trim()))
                }
                title={
                  selectedIds.length === 0 && !/(?:环境\s*#?\s*|#)\d+/i.test(agentGoal.trim())
                    ? "请先在左侧勾选环境"
                    : selectedRunningIds.length === 0 && !/(?:环境\s*#?\s*|#)\d+/i.test(agentGoal.trim())
                      ? "所选环境尚未启动"
                      : "启动"
                }
                onClick={() => void handleStartAgent()}
              >
                <Bot size={13} />
                {anyAgentBusy ? "运行中…" : "启动"}
              </button>
              {anyAgentBusy ? (
                <>
                  {!anyAgentPaused ? (
                    <button
                      type="button"
                      className="btn btn-outline h-8 shrink-0 px-3 text-ui"
                      onClick={() => void handlePauseAgent()}
                      title="暂停全部运行中的 Agent（当前步结束后挂起）"
                    >
                      <Pause size={13} />
                      暂停
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-outline h-8 shrink-0 px-3 text-ui"
                      onClick={() => void handleResumeAgent()}
                      title="继续全部已暂停的 Agent"
                    >
                      <Play size={13} />
                      继续
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-outline h-8 shrink-0 px-3 text-ui"
                    onClick={() => void handleAbortAgent()}
                  >
                    中止
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="btn btn-outline h-8 shrink-0 px-3 text-ui"
                title={targetProfileId ? "完成条件、提醒、人工介入与规则库人设" : "请先在左侧选择一个环境"}
                onClick={() => {
                  void refreshRuleLibrary();
                  setRulesOpen(true);
                }}
              >
                <ClipboardList size={13} />
                规则
                {mentionedRuleCount > 0 ? ` (${mentionedRuleCount})` : ""}
              </button>
              {agentSeatsSummary ? <span className="badge">{agentSeatsSummary}</span> : null}
              <label
                className="ml-auto inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground"
                title="成功结束时写入轨迹库供回放"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded accent-primary"
                  checked={enableRecording}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setEnableRecording(next);
                    persistAgentEnableRecording(next);
                  }}
                />
                录制轨迹
              </label>
            </div>
          </div>

          <AgentRulesModal
            open={rulesOpen}
            onClose={() => setRulesOpen(false)}
            profileId={targetProfileId}
            profiles={profiles}
            ipGeo={targetProfileId ? (ipGeoOverrides?.get(targetProfileId) ?? null) : null}
            onToastError={(message) => pushLine("error", message)}
            onToastSuccess={(message) => pushLine("success", message)}
            onLibraryChange={() => void refreshRuleLibrary()}
          />
        </div>
      ) : null}

      {activeTab === "ai" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
            {scrapedData && scrapedData.rows.length > 0 ? (
              <ScraperDataPanel
                data={scrapedData.rows}
                profileId={targetProfileId ?? ""}
                meta={{
                  mode: scrapedData.mode,
                  url: scrapedData.url,
                  count: scrapedData.count,
                  localPath: scrapedData.localPath,
                }}
                onToastError={onError}
                onToastSuccess={(message) => pushLine("success", message)}
                onClear={() => {
                  if (!targetProfileId) {
                    return;
                  }
                  setScrapedDataByEnv((current) => {
                    const next = { ...current };
                    delete next[targetProfileId];
                    return next;
                  });
                }}
              />
            ) : null}
            <AIChatPanel
              lines={lines}
              chatInput={chatInput}
              chatLoading={chatLoading}
              chatDisabled={aiSubmitting || previewLoading || directFillSubmitting || smartFillSubmitting}
              quickMenuOpen={quickMenuOpen}
              quickCommands={quickCommands}
              quickMenuRef={quickMenuRef}
              emptyHint="向 AI 提问，或分析上方采集结果"
              attachments={chatAttachments}
              onAttachmentsChange={setChatAttachments}
              onAttachError={(message) => onError(message)}
              onChatInputChange={setChatInput}
              onSend={() => void handleSendChat()}
              onQuickMenuToggle={() => setQuickMenuOpen((current) => !current)}
              onQuickCommand={(command) => void handleQuickCommand(command)}
              onSaveCustomCommand={() => void handleSaveCustomCommand()}
              onDeleteCustomCommand={(command) => void handleDeleteCustomCommand(command)}
            />
          </div>

          <div className="workbench-footer">
            <button
              type="button"
              className="row-selectable flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors"
              onClick={() => {
                setFillToolsOpen((current) => {
                  const next = !current;
                  try {
                    localStorage.setItem(FILL_TOOLS_OPEN_KEY, next ? "1" : "0");
                  } catch {
                    // ignore
                  }
                  return next;
                });
              }}
              aria-expanded={fillToolsOpen}
            >
              <span className="text-[11px] font-medium text-foreground">填表工具</span>
              {fillToolsOpen ? null : (
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  展开
                  <ChevronDown size={13} />
                </span>
              )}
              {fillToolsOpen ? <ChevronDown size={13} className="rotate-180 text-muted-foreground" /> : null}
            </button>
            {fillToolsOpen ? (
              <div className="space-y-2 px-2.5 pb-2.5 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="label-caps">填表数据</span>
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <label
                      className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground"
                      title="跳过 AI 混合推演"
                    >
                      <button
                        type="button"
                        role="switch"
                        aria-checked={skipHybrid}
                        disabled={previewLoading || aiSubmitting}
                        className={`ui-switch ${skipHybrid ? "ui-switch-on" : ""}`}
                        onClick={() => setSkipHybrid((current) => !current)}
                      >
                        <span
                          className={`ui-switch-knob ${skipHybrid ? "translate-x-3.5" : "translate-x-0.5"}`}
                        />
                      </button>
                      跳过推演
                    </label>
                    <label
                      className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground"
                      title="执行填表前先核对 JSON"
                    >
                      <button
                        type="button"
                        role="switch"
                        aria-checked={forceHumanConfirm}
                        disabled={previewLoading || aiSubmitting}
                        className={`ui-switch ${forceHumanConfirm ? "ui-switch-on" : ""}`}
                        onClick={() => setForceHumanConfirm((current) => !current)}
                      >
                        <span
                          className={`ui-switch-knob ${
                            forceHumanConfirm ? "translate-x-3.5" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                      填前确认
                    </label>
                    <label
                      className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground"
                      title="填表后按回车"
                    >
                      <button
                        type="button"
                        role="switch"
                        aria-checked={pressEnterAfterFill}
                        disabled={
                          previewLoading || aiSubmitting || directFillSubmitting || smartFillSubmitting
                        }
                        className={`ui-switch ${pressEnterAfterFill ? "ui-switch-on" : ""}`}
                        onClick={() => setPressEnterAfterFill((current) => !current)}
                      >
                        <span
                          className={`ui-switch-knob ${
                            pressEnterAfterFill ? "translate-x-3.5" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                      填完回车
                    </label>
                  </div>
                </div>
                <textarea
                  className="field-input max-h-[100px] min-h-[52px] w-full resize-y px-3 py-2 font-mono text-caption leading-5"
                  value={aiRawInput}
                  onChange={(event) => setAiRawInput(event.target.value)}
                  placeholder="粘贴 JSON 或 YAML"
                />
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    className="btn btn-outline w-full py-2 text-ui"
                    disabled={
                      envExecuting ||
                      directFillSubmitting ||
                      aiSubmitting ||
                      previewLoading ||
                      smartFillSubmitting
                    }
                    onClick={() => void handleDirectFill()}
                    title={envExecuting ? `当前环境正忙（${envBusyReason}）` : "按 JSON 键名直接映射填表"}
                  >
                    <PenLine size={14} />
                    {directFillSubmitting ? "填表中…" : "直接填"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline w-full py-2 text-ui"
                    disabled={
                      envExecuting ||
                      !smartFillEnabled ||
                      smartFillSubmitting ||
                      aiSubmitting ||
                      previewLoading ||
                      directFillSubmitting ||
                      chatLoading
                    }
                    onClick={() => void handleSmartFill()}
                    title={
                      envExecuting
                        ? `当前环境正忙（${envBusyReason}）`
                        : smartFillEnabled
                          ? "按自然语言与页面元素智能补全并填表"
                          : "需先启动环境"
                    }
                  >
                    <Wand2 size={14} />
                    {smartFillSubmitting ? "智能填中…" : "智能填"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary w-full py-2 text-ui"
                    disabled={
                      envExecuting ||
                      aiSubmitting ||
                      previewLoading ||
                      directFillSubmitting ||
                      smartFillSubmitting
                    }
                    title={envExecuting ? `当前环境正忙（${envBusyReason}）` : "推演后填写"}
                    onClick={() => void handleAiRun()}
                  >
                    <Sparkles size={14} />
                    {previewLoading ? "推演中…" : aiSubmitting ? "执行中…" : "混合填"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <FillConfirmModal
            open={confirmOpen}
            loading={aiSubmitting}
            previewJson={confirmJson}
            onPreviewJsonChange={setConfirmJson}
            onConfirm={() => void handleConfirmFill()}
            onClose={() => {
              if (!aiSubmitting) {
                setConfirmOpen(false);
              }
            }}
          />
        </div>
      ) : null}

      {activeTab === "runs" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
          <AgentRunHistoryPanel
            refreshToken={runHistoryRefreshToken}
            onError={onError}
            onOpenTrajectory={(trajectoryId) => {
              setSelectedTrajectoryId(trajectoryId);
              setActiveTab("trajectory");
            }}
          />
        </div>
      ) : null}

      {activeTab === "trajectory" ? (
        <TrajectoryMemoryPanel
          currentDomain={currentDomain}
          boundProfileId={targetProfileId}
          trajectories={trajectories}
          selectedId={selectedTrajectoryId}
          busy={trajectoryBusy}
          envExecuting={envExecuting}
          busyReason={envBusyReason}
          executingId={executingTrajectoryId}
          profiles={profiles}
          busyEnvIds={allBusyEnvIds}
          recordingEnabled={enableRecording}
          monitorLines={replayLines}
          onClearMonitor={() => {
            setReplayWatchEnvIds([]);
            setReplayLinesByEnv({});
          }}
          onSelect={setSelectedTrajectoryId}
          onRefresh={() => void refreshTrajectories()}
          onDelete={(row) => void handleDeleteTrajectory(row)}
          onExecute={(row) => void handleExecuteTrajectory(row)}
          onStop={() => void handleStopTrajectory()}
          onExecutingIdChange={setExecutingTrajectoryId}
          onClearExecutingId={(trajectoryId) => {
            setExecutingTrajectoryId((current) => (current === trajectoryId ? null : current));
          }}
          onOpenAgentForRecording={openAgentForRecording}
          onError={onError}
          onLog={(tone, text) => pushReplayLine(tone, text)}
          onEnvTrajectoryBusy={setEnvTrajectoryBusy}
        />
      ) : null}
    </aside>
  );
}
