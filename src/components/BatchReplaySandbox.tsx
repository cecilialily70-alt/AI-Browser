import {
  AtSign,
  Calendar,
  Copy,
  Hash,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  Phone,
  Sparkles,
  Square,
  Type,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  abortAutonomousAgent,
  buildReplayRunPlan,
  formatInvokeError,
  isBenignAgentStopError,
  mockSandboxFields,
  replayAgentTrajectory,
} from "../lib/tauri";
import type {
  AgentTrajectory,
  PlanBatchDataResult,
  Profile,
  ReplayAllocMode,
  ReplayOnExhausted,
  ReplayPlanEdit,
  ReplayRunPlan,
  SandboxFieldMode,
  SandboxFieldOverride,
  SandboxFormField,
} from "../types";
import { Modal } from "./Modal";
import { ReplayDatasetEditor, type ReplayDatasetDraft } from "./ReplayDatasetEditor";
import { ReplayPlanTable } from "./ReplayPlanTable";
import { MAGIC_VARS } from "../lib/magicVars";
import {
  loadAgentRuleLibrary,
  personaFixedValues,
  personaEffectiveFixedFields,
  personaTemplateValues,
  resolveGoalMentions,
  rulesPayload,
  type AgentPersona,
  type AgentRule,
} from "../lib/agentRules";

interface BatchReplaySandboxProps {
  open: boolean;
  trajectory: AgentTrajectory | null;
  profiles: Profile[];
  busyEnvIds: string[];
  onClose: () => void;
  onError: (message: string) => void;
  onLog: (tone: "info" | "success" | "error" | "warn", text: string) => void;
  onEnvTrajectoryBusy: (profileId: string, busy: boolean) => void;
  /** 并发派发开始（用于列表「执行→停止」与关闭沙盘） */
  onDispatchStart?: (trajectoryId: number) => void;
  /** 并发派发全部结束 */
  onDispatchEnd?: (trajectoryId: number) => void;
}

function parseTrajectoryActions(trajectory: AgentTrajectory): unknown[] {
  try {
    const parsed = JSON.parse(trajectory.actions) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shortSelector(selector: string, max = 28): string {
  if (selector.length <= max) {
    return selector;
  }
  return `${selector.slice(0, max - 1)}…`;
}

function deriveFieldLabel(step: Record<string, unknown>, selector: string): string {
  // 1) 网关落盘的 semanticLabel（最高优先级）
  const semanticLabel = String(step.semanticLabel ?? "").trim();
  if (semanticLabel) {
    return semanticLabel;
  }
  // 2) 兼容顶层 label
  const topLabel = String(step.label ?? "").trim();
  if (topLabel) {
    return topLabel;
  }
  // 3) semanticContext.label
  const semantic = step.semanticContext;
  if (semantic && typeof semantic === "object") {
    const label = String((semantic as { label?: unknown }).label ?? "").trim();
    if (label) {
      return label;
    }
  }
  // 4) placeholder / aria-label 等可读降级
  for (const key of ["name", "text", "placeholder", "ariaLabel", "aria-label", "dataKey", "intent", "hint"]) {
    const value = String(step[key] ?? "").trim();
    if (value) {
      return value;
    }
  }
  const nameMatch = selector.match(/name\s*=\s*['"]([^'"]+)['"]/i);
  if (nameMatch?.[1]) {
    return nameMatch[1];
  }
  const placeholderMatch = selector.match(/placeholder\s*=\s*['"]([^'"]+)['"]/i);
  if (placeholderMatch?.[1]) {
    return placeholderMatch[1];
  }
  const ariaMatch = selector.match(/aria-label\s*=\s*['"]([^'"]+)['"]/i);
  if (ariaMatch?.[1]) {
    return ariaMatch[1];
  }
  const idMatch = selector.match(/#([A-Za-z_][\w-]*)/);
  if (idMatch?.[1]) {
    return idMatch[1];
  }
  return shortSelector(selector);
}

function deriveInputType(step: Record<string, unknown>): string | undefined {
  const top = String(step.inputType ?? "").trim();
  if (top) {
    return top.toLowerCase();
  }
  const semantic = step.semanticContext;
  if (semantic && typeof semantic === "object") {
    const typed = String((semantic as { inputType?: unknown }).inputType ?? "").trim();
    if (typed) {
      return typed.toLowerCase();
    }
  }
  return undefined;
}

function deriveSemanticSource(step: Record<string, unknown>): string | undefined {
  const semantic = step.semanticContext;
  if (semantic && typeof semantic === "object") {
    const source = String((semantic as { source?: unknown }).source ?? "").trim();
    return source || undefined;
  }
  return undefined;
}

function pushField(
  out: SandboxFormField[],
  seen: Set<string>,
  key: string,
  label: string,
  recordedValue: string,
  inputType?: string,
  semanticSource?: string,
): void {
  const selector = key.trim();
  if (!selector || seen.has(selector)) {
    return;
  }
  seen.add(selector);
  out.push({
    key: selector,
    label: label.trim() || shortSelector(selector),
    recordedValue: recordedValue.trim(),
    inputType,
    semanticSource,
  });
}

export function extractSandboxFieldsFromActions(actions: unknown[]): SandboxFormField[] {
  const seen = new Set<string>();
  const out: SandboxFormField[] = [];

  for (const raw of actions) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const step = raw as Record<string, unknown>;
    const type = String(step.type ?? step.action ?? step.kind ?? "")
      .trim()
      .toLowerCase();

    if (type === "agent_batch_fill") {
      const fields = Array.isArray(step.fields) ? step.fields : [];
      for (const entry of fields) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const field = entry as Record<string, unknown>;
        const selector = String(field.selector ?? field.key ?? field.short_id ?? "").trim();
        if (!selector) {
          continue;
        }
        pushField(
          out,
          seen,
          selector,
          deriveFieldLabel(field, selector),
          String(field.value ?? ""),
          deriveInputType(field),
          deriveSemanticSource(field),
        );
      }
      continue;
    }

    if (type !== "fill" && type !== "select") {
      continue;
    }
    const selector = String(step.selector ?? "").trim();
    if (!selector) {
      continue;
    }
    pushField(
      out,
      seen,
      selector,
      deriveFieldLabel(step, selector),
      String(step.value ?? step.data ?? ""),
      deriveInputType(step),
      deriveSemanticSource(step),
    );
  }

  return out;
}

function defaultOverride(field: SandboxFormField, mode: SandboxFieldMode = "fixed"): SandboxFieldOverride {
  return {
    mode,
    value: mode === "fixed" ? field.recordedValue : "",
    label: field.label,
    inputType: field.inputType,
  };
}

function emptyOverrides(
  fields: SandboxFormField[],
  mode: SandboxFieldMode = "fixed",
): Record<string, SandboxFieldOverride> {
  const overrides: Record<string, SandboxFieldOverride> = {};
  for (const field of fields) {
    overrides[field.key] = defaultOverride(field, mode);
  }
  return overrides;
}

function buildInitialPlan(envIds: string[], fields: SandboxFormField[]): PlanBatchDataResult {
  return {
    summary: `语义字段 ${fields.length} 个 · 固定值支持 {{变量}} · AI 盲盒运行时 JIT 生成`,
    planMatrix: envIds.map((envId) => ({
      envId: String(envId),
      valueOverrides: Object.fromEntries(fields.map((field) => [field.key, field.recordedValue])),
      fieldOverrides: emptyOverrides(fields, "fixed"),
    })),
  };
}

/**
 * 把目标文本里「录制时的旧值」换成运行时的新值，避免 AI 交付仍按旧目标判错。
 *
 * 两种替换来源（优先级：数据集 > 沙盘固定值）：
 *   - 字段映射到数据集列 → 写成 `{{data.<列>}}`，由 Host **逐轮**用当前行的值展开
 *     （所以每一轮的目标都跟着本轮的变量值变，而不是全轮用同一个词）。
 *   - 沙盘固定值覆盖 → 直接写死成该值。
 *   - AI 盲盒字段的值是**运行时指令**、不是最终值，写进目标会把指令当事实，跳过不换。
 */
function buildReplayGoalTemplate(
  goal: string,
  fields: SandboxFormField[],
  overrides: Record<string, SandboxFieldOverride>,
  datasetMap: Record<string, string> | null,
): string {
  let next = String(goal ?? "").trim();
  if (!next) {
    return next;
  }
  for (const field of fields) {
    const recorded = String(field.recordedValue ?? "").trim();
    if (!recorded) {
      continue;
    }
    const column = datasetMap?.[field.key];
    const override = overrides[field.key];
    let replacement = "";
    if (column) {
      replacement = `{{data.${column}}}`;
    } else if (override?.mode === "ai_prompt") {
      continue;
    } else {
      replacement = String(override?.value ?? "").trim();
    }
    if (!replacement || replacement === recorded) {
      continue;
    }
    if (next.includes(recorded)) {
      next = next.split(recorded).join(replacement);
    }
  }
  return next;
}

/**
 * 有上限的并发派发（N13 ④「并发上限」）。
 *
 * 为什么放在前端：每个环境一条独立命令、Host 侧每环境串行（台账领取已保证），
 * 所以「同时在跑几个环境」由派发方控制即可，不需要在 Host 里造一个跨命令的全局信号量。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length || 1));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        try {
          results[index] = { ok: true, value: await worker(items[index]!) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    }),
  );
  return results;
}

function TypeIcon({ inputType }: { inputType?: string }) {
  const type = (inputType ?? "text").toLowerCase();
  const props = { size: 12 as const, className: "shrink-0 text-muted-foreground" };
  if (type === "email") {
    return <Mail {...props} />;
  }
  if (type === "tel" || type === "phone") {
    return <Phone {...props} />;
  }
  if (type === "password") {
    return <Lock {...props} />;
  }
  if (type === "url") {
    return <Link2 {...props} />;
  }
  if (type === "number" || type === "numeric") {
    return <Hash {...props} />;
  }
  if (type === "date" || type === "datetime-local") {
    return <Calendar {...props} />;
  }
  if (type.includes("mail")) {
    return <AtSign {...props} />;
  }
  return <Type {...props} />;
}

function MagicVariableInput({
  value,
  disabled,
  placeholder,
  aiMode,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  placeholder?: string;
  aiMode?: boolean;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const suggestions = useMemo(() => {
    const q = filter.toLowerCase();
    return MAGIC_VARS.filter(
      (item) => !q || item.token.toLowerCase().includes(q) || item.label.includes(filter),
    );
  }, [filter]);

  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/\{\{([\w.]*)$/);
    if (!match) {
      setOpen(false);
      setFilter("");
      return;
    }
    setFilter(match[1] ?? "");
    setOpen(true);
    setActiveIndex(0);
  };

  const insertToken = (token: string) => {
    const el = inputRef.current;
    if (!el) {
      onChange(`${value}{{${token}}}`);
      setOpen(false);
      return;
    }
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const replaced = before.replace(/\{\{[\w.]*$/, `{{${token}}}`);
    const next = `${replaced}${after}`;
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      const pos = replaced.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertToken(suggestions[activeIndex]?.token ?? suggestions[0].token);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        className={`field-input h-8 w-full px-2.5 py-1 text-caption ${
          aiMode ? " bg-warning/10 text-foreground" : ""
        }`}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          if (!aiMode) {
            detectMention(next, event.target.selectionStart ?? next.length);
          } else {
            setOpen(false);
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
      />
      {open && !aiMode && suggestions.length > 0 ? (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-40 overflow-auto rounded-lg bg-raised shadow-pop">
          {suggestions.map((item, index) => (
            <button
              key={item.token}
              type="button"
              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                index === activeIndex ? "row-selected text-primary-text" : "row-selectable"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                insertToken(item.token);
              }}
            >
              <span className="font-mono">{`{{${item.token}}}`}</span>
              <span className="text-muted-foreground">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 轨迹反推动态表单沙盘：双模（固定值 / AI 盲盒）+ 魔法变量 + 延迟生成
 */
export function BatchReplaySandbox({
  open,
  trajectory,
  profiles,
  busyEnvIds,
  onClose,
  onError,
  onLog,
  onEnvTrajectoryBusy,
  onDispatchStart,
  onDispatchEnd,
}: BatchReplaySandboxProps) {
  const abortRequestedRef = useRef(false);
  const activeEnvIdsRef = useRef<string[]>([]);
  const trajectoryIdRef = useRef<number | null>(null);
  const goalInputRef = useRef<HTMLTextAreaElement | null>(null);

  const [selectedEnvIds, setSelectedEnvIds] = useState<string[]>([]);
  const [activeEnvId, setActiveEnvId] = useState<string>("");
  const [dispatching, setDispatching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [plan, setPlan] = useState<PlanBatchDataResult | null>(null);
  /** 沙盘内轻提示（字段同步 / 全局工具栏） */
  const [toastText, setToastText] = useState<string | null>(null);
  const [mocking, setMocking] = useState(false);
  /** N7 · 每环境运行次数（每轮在新标签里跑；默认 1，上限 100） */
  const [repeatCount, setRepeatCount] = useState(1);
  /** N10/N11 · 数据集（多行数据源）；P4 的预检单与多轮分配以它为输入 */
  const [datasetDraft, setDatasetDraft] = useState<ReplayDatasetDraft | null>(null);
  /**
   * N5 / N6 · 数据源：`dataset` = 粘贴多行数据；`clipboard` = 开局读一次系统剪贴板
   * （单行数据集，列名 `text`；内容只留在宿主内存，不入库不入日志）。
   */
  const [dataSource, setDataSource] = useState<"dataset" | "clipboard">("dataset");
  /** 剪贴板数据源的字段映射（字段 key → 列名 `text`） */
  const [clipboardMap, setClipboardMap] = useState<Record<string, string>>({});
  /** §6.4：一次性凭证默认拒绝自动填入；勾选 = 用户明示「这是我自己复制的码」 */
  const [clipboardTreatAsHuman, setClipboardTreatAsHuman] = useState(false);
  /** N12 · 分配策略与「数据行不够时怎么办」（必须显式选择，不许静默） */
  const [allocMode, setAllocMode] = useState<ReplayAllocMode>("seq_interleave");
  const [onExhausted, setOnExhausted] = useState<ReplayOnExhausted>("error");
  /** N13 · 并发上限 / 失败即停 */
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [stopOnFirstFailure, setStopOnFirstFailure] = useState(false);
  /** N13 · 预检单 + 行级修改 + 是否有参数变化导致它失效 */
  const [runPlan, setRunPlan] = useState<ReplayRunPlan | null>(null);
  const [planEdits, setPlanEdits] = useState<ReplayPlanEdit[]>([]);
  const [planning, setPlanning] = useState(false);
  const [planStale, setPlanStale] = useState(false);
  /** 规则库快照（回放目标里 `@人设 / @规则` 的引用来源；与 Agent 输入框同一套库） */
  const [ruleLibrary, setRuleLibrary] = useState<{ rules: AgentRule[]; personas: AgentPersona[] }>({
    rules: [],
    personas: [],
  });
  /** `@` 引用选择器开合 */
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  /**
   * 回放目标 / 指令：默认沿用录制目标，可改词、可写 `@人设名` / `@规则名`。
   * 数据集字段仍由 `{{data.<列>}}` 逐轮替换（见 `buildReplayGoalTemplate`）。
   */
  const [goalOverride, setGoalOverride] = useState("");

  const runningProfiles = useMemo(
    () => profiles.filter((profile) => profile.status === "running"),
    [profiles],
  );

  const fields = useMemo(() => {
    if (!trajectory) {
      return [];
    }
    return extractSandboxFieldsFromActions(parseTrajectoryActions(trajectory));
  }, [trajectory]);

  /** 本轮回放使用的目标模板：用户可编辑；默认录制目标 */
  const baseGoalText = useMemo(
    () => (goalOverride.trim() || trajectory?.goal || trajectory?.title || "").trim(),
    [goalOverride, trajectory],
  );

  /** 目标里的 `@人设名` / `@规则名`（与 Agent 输入框同一套解析：最长匹配 + 边界判定） */
  const goalMentions = useMemo(
    () => resolveGoalMentions(baseGoalText, ruleLibrary.rules, ruleLibrary.personas),
    [baseGoalText, ruleLibrary],
  );

  /** 把 `@名称` 插到目标文本光标处（没有光标就追加；前后补空格保证被解析成引用） */
  const insertMention = (label: string) => {
    const token = `@${label}`;
    const el = goalInputRef.current;
    if (!el) {
      setGoalOverride((prev) => `${prev && !/\s$/.test(prev) ? " " : ""}${token} `);
      setMentionMenuOpen(false);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const inserted = `${prefix}${token} `;
    setGoalOverride(`${before}${inserted}${after}`);
    setMentionMenuOpen(false);
    requestAnimationFrame(() => {
      el.focus();
      const pos = before.length + inserted.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const busySet = useMemo(() => new Set(busyEnvIds.map(String)), [busyEnvIds]);

  /** 预检单表格用的环境状态（运行中绿点 / 未运行红点） */
  const planEnvInfo = useMemo(
    () =>
      Object.fromEntries(
        profiles.map((profile) => [
          String(profile.id),
          { name: profile.name ?? "", running: profile.status === "running" },
        ]),
      ),
    [profiles],
  );

  const activeRow = useMemo(() => {
    if (!plan || !activeEnvId) {
      return null;
    }
    const id = String(activeEnvId);
    return plan.planMatrix.find((row) => String(row.envId) === id) ?? null;
  }, [plan, activeEnvId]);

  const wasOpenRef = useRef(false);

  // 关闭时清空选择，避免「回放后再开沙盘」仍带着空 plan / 跳过重选
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      trajectoryIdRef.current = null;
      setSelectedEnvIds([]);
      setActiveEnvId("");
      setPlan(null);
      setToastText(null);
      setRepeatCount(1);
      setDatasetDraft(null);
      setDataSource("dataset");
      setClipboardMap({});
      setClipboardTreatAsHuman(false);
      setRunPlan(null);
      setPlanEdits([]);
      setPlanStale(false);
      setMentionMenuOpen(false);
    }
  }, [open]);

  // 打开沙盘时读一次规则库（@人设 / @规则 的候选与解析来源）
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const library = await loadAgentRuleLibrary();
        if (!cancelled) {
          setRuleLibrary({ rules: library.rules, personas: library.personas });
        }
      } catch (error) {
        onLog("warn", `读取规则库失败（本轮不能 @人设 / @规则）：${formatInvokeError(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, onLog]);

  // 换轨迹时把目标重置为录制目标（用户改过的文本不跨轨迹沿用）
  useEffect(() => {
    setGoalOverride(trajectory ? trajectory.goal || trajectory.title : "");
    setMentionMenuOpen(false);
  }, [trajectory]);

  /**
   * N13-b · 参数一变，已有预检单立刻失效（按钮回到「待确认」）。
   *
   * 依赖里**故意不放 `runPlan`**：这条规则管的是「参数 → 失效」，
   * 而重算成功后由 `runPlanRequest` 自己把 `planStale` 复位。
   */
  useEffect(() => {
    if (runPlan) {
      setPlanStale(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedEnvIds,
    repeatCount,
    datasetDraft,
    dataSource,
    clipboardMap,
    clipboardTreatAsHuman,
    allocMode,
    onExhausted,
    maxConcurrency,
    stopOnFirstFailure,
    baseGoalText,
  ]);

  useEffect(() => {
    if (!open || !trajectory) {
      return;
    }
    const runningIds = profiles
      .filter((profile) => profile.status === "running")
      .map((profile) => String(profile.id));
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;
    const trajectoryChanged = trajectoryIdRef.current !== trajectory.id;
    if (trajectoryChanged) {
      trajectoryIdRef.current = trajectory.id;
      abortRequestedRef.current = false;
      activeEnvIdsRef.current = [];
      setStopping(false);
    }

    if (justOpened || trajectoryChanged) {
      // 每次打开或换轨迹：默认勾选全部运行中环境（修「未选择环境」）
      setSelectedEnvIds(runningIds);
      const extracted = extractSandboxFieldsFromActions(parseTrajectoryActions(trajectory));
      setPlan(runningIds.length > 0 && extracted.length > 0 ? buildInitialPlan(runningIds, extracted) : null);
      setActiveEnvId(runningIds[0] ?? "");
      return;
    }

    // 沙盘保持打开时 profiles 刷新：丢掉已停环境，勿整表重置用户勾选
    setSelectedEnvIds((prev) => {
      const valid = prev.filter((id) => runningIds.includes(id));
      return valid.length > 0 ? valid : runningIds;
    });
  }, [open, trajectory, profiles]);

  useEffect(() => {
    if (!toastText) {
      return;
    }
    const timer = window.setTimeout(() => setToastText(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toastText]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (fields.length === 0) {
      setPlan(null);
      setActiveEnvId("");
      return;
    }
    if (selectedEnvIds.length === 0) {
      setPlan(null);
      setActiveEnvId("");
      return;
    }
    setPlan((current) => {
      const byEnv = new Map((current?.planMatrix ?? []).map((row) => [String(row.envId), row] as const));
      return {
        summary:
          current?.summary ?? `语义字段 ${fields.length} 个 · 固定值支持 {{变量}} · AI 盲盒运行时 JIT 生成`,
        planMatrix: selectedEnvIds.map((envId) => {
          const id = String(envId);
          const existing = byEnv.get(id);
          if (existing?.fieldOverrides) {
            return {
              envId: id,
              valueOverrides: existing.valueOverrides ?? {},
              fieldOverrides: {
                ...emptyOverrides(fields, "fixed"),
                ...existing.fieldOverrides,
              },
            };
          }
          return {
            envId: id,
            valueOverrides: Object.fromEntries(fields.map((field) => [field.key, field.recordedValue])),
            fieldOverrides: emptyOverrides(fields, "fixed"),
          };
        }),
      };
    });
    setActiveEnvId((current) => (selectedEnvIds.includes(current) ? current : (selectedEnvIds[0] ?? "")));
  }, [open, selectedEnvIds, fields]);

  const toggleEnv = (id: string) => {
    setSelectedEnvIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const showToast = (text: string) => {
    setToastText(text);
  };

  const patchOverride = (envId: string, fieldKey: string, patch: Partial<SandboxFieldOverride>) => {
    setPlan((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        planMatrix: current.planMatrix.map((row) => {
          if (row.envId !== envId) {
            return row;
          }
          const field = fields.find((item) => item.key === fieldKey);
          const prev =
            row.fieldOverrides?.[fieldKey] ??
            defaultOverride(
              field ?? {
                key: fieldKey,
                label: fieldKey,
                recordedValue: "",
              },
            );
          const next: SandboxFieldOverride = {
            ...prev,
            ...patch,
            label: patch.label ?? prev.label ?? field?.label,
            inputType: patch.inputType ?? prev.inputType ?? field?.inputType,
          };
          return {
            ...row,
            fieldOverrides: { ...(row.fieldOverrides ?? {}), [fieldKey]: next },
            valueOverrides: {
              ...(row.valueOverrides ?? {}),
              [fieldKey]: next.value,
            },
          };
        }),
      };
    });
  };

  /**
   * 字段级同步：把当前 Tab 该字段的 value + mode 深拷贝到所有已勾选环境。
   */
  const applyFieldToAllSelected = (fieldKey: string) => {
    if (!plan || !activeEnvId) {
      return;
    }
    if (selectedEnvIds.length <= 1) {
      showToast("当前仅勾选一个环境，无需同步");
      return;
    }
    const sourceRow = plan.planMatrix.find((row) => row.envId === activeEnvId);
    const field = fields.find((item) => item.key === fieldKey);
    const source = sourceRow?.fieldOverrides?.[fieldKey] ?? (field ? defaultOverride(field, "fixed") : null);
    if (!source) {
      return;
    }
    const snapshot: SandboxFieldOverride = {
      mode: source.mode,
      value: source.value,
      label: source.label ?? field?.label,
      inputType: source.inputType ?? field?.inputType,
    };
    const selectedSet = new Set(selectedEnvIds);
    setPlan((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        planMatrix: current.planMatrix.map((row) => {
          if (!selectedSet.has(row.envId)) {
            return row;
          }
          return {
            ...row,
            fieldOverrides: {
              ...(row.fieldOverrides ?? {}),
              [fieldKey]: { ...snapshot },
            },
            valueOverrides: {
              ...(row.valueOverrides ?? {}),
              [fieldKey]: snapshot.value,
            },
          };
        }),
      };
    });
    showToast("该字段已同步至所有选中的环境");
  };

  /** 全局工具栏：穿透所有已勾选环境（planMatrix 内选中行） */
  const setAllModes = (mode: SandboxFieldMode) => {
    const selectedSet = new Set(selectedEnvIds);
    setPlan((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        summary:
          mode === "ai_prompt"
            ? "全部字段已开启 AI 盲盒（运行时 JIT · fast_text）· 已应用到所有选中环境"
            : "全部字段已设为固定值（支持 {{persona.*}} / {{geoip.*}}）· 已应用到所有选中环境",
        planMatrix: current.planMatrix.map((row) => {
          if (!selectedSet.has(row.envId)) {
            return row;
          }
          const fieldOverrides: Record<string, SandboxFieldOverride> = {};
          for (const field of fields) {
            const prev = row.fieldOverrides?.[field.key];
            fieldOverrides[field.key] = {
              mode,
              value:
                mode === "ai_prompt"
                  ? prev?.mode === "ai_prompt"
                    ? prev.value
                    : ""
                  : prev?.value || field.recordedValue,
              label: field.label,
              inputType: field.inputType,
            };
          }
          return {
            ...row,
            fieldOverrides,
            valueOverrides: Object.fromEntries(
              Object.entries(fieldOverrides).map(([key, spec]) => [key, spec.value]),
            ),
          };
        }),
      };
    });
    showToast(
      mode === "ai_prompt"
        ? `已为 ${selectedEnvIds.length} 个选中环境开启 AI 盲盒`
        : `已为 ${selectedEnvIds.length} 个选中环境设为固定值`,
    );
  };

  /**
   * 沙盘字段级 AI 造数。
   *
   * 只作用于固定值字段：AI 盲盒字段的值框存的是**运行时指令**，由填表前 JIT 消费；
   * 若用这里产出的具体值覆盖它，两种生成机制会互相打架。
   * currentValue 会原样传给模型作为「灵感」—— 空值即盲盒，也可填「生成 44 开头的手机号」这类指令。
   */
  const handleMockFields = async (onlyKeys?: string[]) => {
    if (!plan) {
      onError("请先生成沙盘数据");
      return;
    }
    if (fields.length === 0) {
      onError("该轨迹没有 fill / agent_batch_fill 字段");
      return;
    }

    const targetEnvIds = onlyKeys ? (activeEnvId ? [activeEnvId] : []) : selectedEnvIds;
    if (targetEnvIds.length === 0) {
      onError("请先勾选要造数的环境");
      return;
    }

    const onlySet = onlyKeys ? new Set(onlyKeys) : null;
    if (onlySet && onlySet.size === 0) {
      onError("请先选择要造数的字段");
      return;
    }
    // 逐个环境在下方判定可造数字段；此处只拦「全库都没有可造数字段」的情况
    if (onlySet && activeRow) {
      const allBlindBox = [...onlySet].every((key) => activeRow.fieldOverrides?.[key]?.mode === "ai_prompt");
      if (allBlindBox) {
        onError("所选字段均为 AI 盲盒，已由运行时生成，无需造数");
        return;
      }
    }

    setMocking(true);
    showToast(`正在为 ${targetEnvIds.length} 个环境生成字段值…`);

    const results = await Promise.allSettled(
      targetEnvIds.map(async (envId) => {
        const row = plan.planMatrix.find((item) => item.envId === envId);
        const payloadFields = fields
          .filter((field) => (onlySet ? onlySet.has(field.key) : true))
          .filter((field) => row?.fieldOverrides?.[field.key]?.mode !== "ai_prompt")
          .map((field) => {
            const override = row?.fieldOverrides?.[field.key];
            return {
              key: field.key,
              label: field.label,
              currentValue: override?.value ?? field.recordedValue,
            };
          });
        if (payloadFields.length === 0) {
          return { envId, skipped: true, empty: 0, summary: "" };
        }

        const result = await mockSandboxFields({
          envId,
          fields: payloadFields,
          // 显式限定范围：后端对未返回的 key 会置空，不能让它误伤被过滤掉的盲盒字段
          onlyKeys: payloadFields.map((field) => field.key),
          // 目标里 @人设 时，造数用同一套身份（整套字段），别再造一个跟目标对不上的人
          persona: goalMentions.persona ? personaTemplateValues(goalMentions.persona) : null,
        });

        // 必须在 setPlan 之外统计：updater 由 React 异步调用，闭包内的累加读不到
        const empty = payloadFields.filter(
          (field) => !String(result.valueOverrides[field.key] ?? "").trim(),
        ).length;

        setPlan((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            planMatrix: current.planMatrix.map((item) => {
              if (item.envId !== envId) {
                return item;
              }
              const fieldOverrides: Record<string, SandboxFieldOverride> = {
                ...(item.fieldOverrides ?? {}),
              };
              const valueOverrides = { ...(item.valueOverrides ?? {}) };
              for (const field of payloadFields) {
                const nextValue = result.valueOverrides[field.key];
                if (typeof nextValue !== "string") {
                  continue;
                }
                const prev = fieldOverrides[field.key];
                const source = fields.find((item) => item.key === field.key);
                fieldOverrides[field.key] = {
                  mode: "fixed",
                  value: nextValue,
                  label: prev?.label ?? field.label,
                  inputType: prev?.inputType ?? source?.inputType,
                };
                valueOverrides[field.key] = nextValue;
              }
              return { ...item, fieldOverrides, valueOverrides };
            }),
          };
        });

        return { envId, skipped: false, empty, summary: result.summary };
      }),
    );

    const fulfilled = results.filter((item) => item.status === "fulfilled").map((item) => item.value);
    const failures = results.filter((item) => item.status === "rejected");
    setMocking(false);

    const done = fulfilled.filter((item) => !item.skipped);
    const emptyTotal = done.reduce((sum, item) => sum + item.empty, 0);
    const skipped = fulfilled.filter((item) => item.skipped).length;

    if (done.length > 0) {
      const parts = [`已为 ${done.length} 个环境生成字段值`];
      if (skipped > 0) {
        parts.push(`${skipped} 个环境无可造数字段已跳过`);
      }
      if (emptyTotal > 0) {
        parts.push(`${emptyTotal} 个字段模型未返回，已置空待重试`);
      }
      showToast(parts.join(" · "));
      onLog("success", done[0].summary || parts.join(" · "));
    }

    if (failures.length > 0) {
      const first = failures[0] as PromiseRejectedResult;
      const message = formatInvokeError(first.reason);
      onError(`造数失败（${failures.length}/${targetEnvIds.length} 个环境）：${message}`);
      onLog("error", `AI 造数失败：${message}`);
    }
  };

  /**
   * N13 · 生成 / 重算预检单。
   *
   * **干跑**：Host 只做「分配 + 字段映射 + 词表风险判定」，不启动任何页面。
   * 任何参数或行级修改都会走这里重新拿 `planHash` —— 不允许「改了但 hash 还是旧的」。
   */
  const runPlanRequest = async (edits: ReplayPlanEdit[]) => {
    if (!trajectory) {
      return;
    }
    setPlanning(true);
    try {
      const usableDraft =
        datasetDraft && !datasetDraft.error && datasetDraft.rows.length > 0 ? datasetDraft : null;
      const useClipboard = dataSource === "clipboard";
      const next = await buildReplayRunPlan({
        trajectoryId: trajectory.id,
        trajectoryTitle: trajectory.title,
        actions: parseTrajectoryActions(trajectory),
        goal: baseGoalText,
        profileIds: selectedEnvIds.map(String),
        repeatCount,
        dataset: useClipboard
          ? // 剪贴板：内容由宿主读（Host 唯一入口），前端只声明来源
            { source: "clipboard", columns: [], rows: [] }
          : {
              source: usableDraft ? "inline" : "none",
              columns: usableDraft?.columns ?? [],
              rows: usableDraft?.rows ?? [],
            },
        fieldMap: useClipboard ? clipboardMap : (usableDraft?.columnMap ?? {}),
        allocation: {
          mode: usableDraft || useClipboard ? allocMode : "generate",
          onExhausted,
        },
        openInNewTab: true,
        closeAfter: false,
        stopOnFirstFailure,
        runTimeoutMs: 600_000,
        maxConcurrency,
        staggerMs: 300,
        edits,
      });
      // 丢弃指向已不存在轮次的手工修改（换了环境 / 次数后用不上）
      const alive = new Set(next.rows.map((row) => row.seq));
      const keptEdits = edits.filter((edit) => alive.has(edit.seq));
      setRunPlan(next);
      setPlanEdits(keptEdits);
      setPlanStale(false);
    } catch (error) {
      setRunPlan(null);
      onError(`生成预检单失败：${formatInvokeError(error)}`);
    } finally {
      setPlanning(false);
    }
  };

  /** 合并一行的手工修改：同 seq 覆盖，其余保留 */
  const handlePlanEdit = (edit: ReplayPlanEdit) => {
    const next = planEdits.filter((item) => item.seq !== edit.seq);
    next.push(edit);
    void runPlanRequest(next);
  };

  const handleStopDispatch = async () => {
    if (!dispatching || stopping) {
      return;
    }
    abortRequestedRef.current = true;
    setStopping(true);
    const targets = [...activeEnvIdsRef.current];
    onLog("info", `正在停止多环境回放 · ${targets.length} 个环境…`);
    await Promise.allSettled(
      targets.map(async (envId) => {
        try {
          await abortAutonomousAgent(envId);
        } catch (error) {
          if (!isBenignAgentStopError(error)) {
            onLog("warn", `环境 #${envId} 停止指令：${formatInvokeError(error)}`);
          }
        }
      }),
    );
  };

  const handleDispatch = async () => {
    if (!trajectory || !plan || plan.planMatrix.length === 0) {
      onError("请先勾选环境并确认字段值");
      return;
    }
    if (fields.length === 0) {
      onError("该轨迹没有 fill / agent_batch_fill 字段");
      return;
    }
    if (!runPlan) {
      onError("请先生成预检单（执行计划确认表）");
      return;
    }
    if (planStale) {
      onError("参数已变化，请重新生成预检单后再启动");
      return;
    }
    if (!runPlan.ok) {
      onError("预检单含红条，禁止启动");
      return;
    }
    if (dispatching) {
      return;
    }

    const trajectoryId = trajectory.id;
    const preBusy = new Set(busyEnvIds.map(String));
    abortRequestedRef.current = false;
    activeEnvIdsRef.current = [];
    setDispatching(true);
    setStopping(false);
    onError("");
    onDispatchStart?.(trajectoryId);
    // 启动后立刻关沙盘，回放进度看列表「停止」与回放日志
    onClose();
    onLog(
      "info",
      `▶ 按预检单启动「${trajectory.title}」· ${runPlan.totals.envs} 环境 × ${runPlan.totals.repeatCount} 轮 = ${runPlan.totals.totalRuns} 次（并发 ${runPlan.totals.maxConcurrency}）`,
    );

    // 目标里的 `@人设 / @规则`（与 Agent 输入框同口径）：@ 是回放里人设/规则生效的唯一开关。
    const mentionedPersona = goalMentions.persona;
    const taskRulesPayload =
      goalMentions.rules.length > 0 ? rulesPayload(goalMentions.rules) : null;
    const taskPersonaPayload = mentionedPersona
      ? {
          label: mentionedPersona.label,
          fixed: personaFixedValues(mentionedPersona, personaEffectiveFixedFields(mentionedPersona)),
        }
      : null;
    const personaDataPayload = mentionedPersona ? personaTemplateValues(mentionedPersona) : null;
    for (const ambiguity of goalMentions.ambiguities) {
      onLog(
        "warn",
        `目标里「${ambiguity.mention}」有歧义：还匹配到 ${ambiguity.candidates
          .filter((name) => !ambiguity.picked.includes(name))
          .join("、")}；已按最长名称「${ambiguity.picked.join("、")}」生效`,
      );
    }
    if (taskRulesPayload) {
      onLog(
        "info",
        `目标引用了 ${taskRulesPayload.length} 条规则：${goalMentions.rules
          .map((rule) => `@${rule.title}`)
          .slice(0, 6)
          .join("、")}${goalMentions.rules.length > 6 ? "…" : ""} · 跑完机械步后会按规则硬校验`,
      );
    }
    if (mentionedPersona) {
      onLog(
        "info",
        `目标引用了人设「@${mentionedPersona.label}」· {{persona.*}} 用它的整套字段${
          Object.keys(taskPersonaPayload?.fixed ?? {}).length > 0
            ? `，固定字段：${Object.keys(taskPersonaPayload?.fixed ?? {}).join("、")}`
            : "（未固定字段）"
        }`,
      );
    }

    const actions = parseTrajectoryActions(trajectory);
    // 执行名单＝预检单里的环境（逐行一致；不在这里重新分配）
    const envIds: string[] = [];
    for (const row of runPlan.rows) {
      if (!envIds.includes(row.envId)) {
        envIds.push(row.envId);
      }
    }
    const datasetRows =
      runPlan.dataset.source === "inline" && datasetDraft && !datasetDraft.error ? datasetDraft.rows : null;
    // 剪贴板数据源：内容只在宿主内存快照里（§6.4），这里不带任何值，只带运行策略
    const fieldMap =
      runPlan.dataset.source === "clipboard"
        ? clipboardMap
        : runPlan.dataset.source === "inline" && datasetDraft && !datasetDraft.error
          ? datasetDraft.columnMap
          : null;

    try {
      const settled = await mapWithConcurrency(envIds, runPlan.totals.maxConcurrency, async (envId) => {
        const profile = profiles.find((item) => String(item.id) === envId);
        if (!profile || profile.status !== "running") {
          onLog("warn", `环境 #${envId} 未运行，已跳过`);
          return { envId, skipped: true as const, stopped: false, ok: false };
        }
        if (preBusy.has(envId)) {
          onLog("warn", `环境 #${envId} 正忙，已跳过`);
          return { envId, skipped: true as const, stopped: false, ok: false };
        }
        if (abortRequestedRef.current) {
          return { envId, skipped: true as const, stopped: true, ok: false };
        }

        activeEnvIdsRef.current = [...activeEnvIdsRef.current, envId];
        onEnvTrajectoryBusy(envId, true);
        try {
          const sandboxRow = plan.planMatrix.find((row) => row.envId === envId);
          const fieldOverrides = sandboxRow?.fieldOverrides ?? emptyOverrides(fields, "fixed");
          // 目标模板：映射到数据集的字段写成 {{data.<列>}}，由 Host 逐轮展开（每轮目标跟着变量变）。
          // 剪贴板源不参与：内容只该进表单，不该被写进目标文本（§6.4 少一个泄漏面）。
          const goalFieldMap = runPlan.dataset.source === "inline" ? fieldMap : null;
          const effectiveGoal = buildReplayGoalTemplate(baseGoalText, fields, fieldOverrides, goalFieldMap);
          const result = await replayAgentTrajectory(envId, {
            filePath: trajectory.file_path,
            actions: trajectory.file_path ? null : actions,
            title: `${trajectory.title} · #${envId}`,
            goal: effectiveGoal,
            valueOverrides: fieldOverrides,
            repeatCount,
            openInNewTab: runPlan.openInNewTab,
            closePreviousTab: runPlan.closeAfter,
            // N13：预检单 + 数据行 + 字段映射 → Host 按表执行（先校验 planHash）
            plan: runPlan,
            planHash: runPlan.planHash,
            datasetRows,
            fieldMap,
            // N5 / N6：剪贴板策略（`treatAsHuman` 是「一次性凭证是否放行」的唯一开关）
            clipboard: {
              mode: "snapshot",
              treatAsHuman: clipboardTreatAsHuman,
            },
            // 目标里的 `@人设 / @规则`：人设供 `{{persona.*}}` 与权威固定字段；规则在收尾时硬校验
            taskRules: taskRulesPayload,
            taskPersona: taskPersonaPayload,
            personaData: personaDataPayload,
          });
          const msg = result.msg || "";
          const stopped =
            abortRequestedRef.current || (result.state === "failed" && isBenignAgentStopError(msg));
          const ok = result.state === "complete";
          if (stopped) {
            onLog("info", `环境 #${envId} 回放已停止`);
            return { envId, skipped: false as const, stopped: true, ok: false };
          }
          onLog(
            ok ? "success" : "error",
            ok
              ? `环境 #${envId} 回放成功：${msg || `共 ${result.step} 步`}`
              : `环境 #${envId} 回放结束：${msg || result.state}`,
          );
          return { envId, skipped: false as const, stopped: false, ok };
        } catch (error) {
          const message = formatInvokeError(error);
          if (isBenignAgentStopError(error) || isBenignAgentStopError(message) || abortRequestedRef.current) {
            onLog("info", `环境 #${envId} 回放已停止`);
            return { envId, skipped: false as const, stopped: true, ok: false };
          }
          onLog("error", `环境 #${envId} 回放失败：${message}`);
          throw error;
        } finally {
          onEnvTrajectoryBusy(envId, false);
          activeEnvIdsRef.current = activeEnvIdsRef.current.filter((id) => id !== envId);
        }
      });

      let okCount = 0;
      let skipCount = 0;
      let failCount = 0;
      let stopCount = 0;
      for (const item of settled) {
        if (!item || !item.ok) {
          failCount += 1;
          onLog("error", `派发异常：${formatInvokeError(item?.error ?? "未知错误")}`);
          continue;
        }
        if (item.value.skipped) {
          if (item.value.stopped) {
            stopCount += 1;
          } else {
            skipCount += 1;
          }
        } else if (item.value.stopped) {
          stopCount += 1;
        } else if (item.value.ok) {
          okCount += 1;
        } else {
          failCount += 1;
        }
      }

      onLog(
        failCount > 0 ? "warn" : "success",
        `并发派发结束 · 成功 ${okCount} · 跳过 ${skipCount} · 停止 ${stopCount} · 失败 ${failCount}`,
      );
    } finally {
      abortRequestedRef.current = false;
      activeEnvIdsRef.current = [];
      setStopping(false);
      setDispatching(false);
      onDispatchEnd?.(trajectoryId);
    }
  };

  if (!trajectory) {
    return null;
  }

  const locked = dispatching;

  return (
    <Modal
      open={open}
      title="多环境数据沙盘"
      description={`轨迹：${trajectory.title} · ${fields.length} 个语义字段`}
      onClose={() => {
        if (!locked) {
          onClose();
        }
      }}
      widthClass="max-w-3xl"
      layer="elevated"
    >
      <div className="relative flex max-h-[78vh] flex-col gap-3 overflow-hidden">
        {toastText ? (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-0 z-[60] -translate-x-1/2 rounded-md bg-raised px-3 py-1.5 text-[11px] font-medium text-foreground shadow-pop"
          >
            {toastText}
          </div>
        ) : null}
        <div className="shrink-0 space-y-2">
          <label className="field-label">目标环境 · 运行中</label>
          {runningProfiles.length === 0 ? (
            <p className="text-caption text-muted-foreground">暂无运行中的环境，请先在左侧启动浏览器。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {runningProfiles.map((profile) => {
                const id = String(profile.id);
                const checked = selectedEnvIds.includes(id);
                const busy = busySet.has(id);
                return (
                  <label
                    key={id}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
                      checked ? "row-selected text-primary-text" : "row-selectable text-muted-foreground"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={() => toggleEnv(id)}
                    />
                    #{id}
                    {profile.name ? ` · ${profile.name}` : ""}
                    {busy ? " · 忙" : ""}
                  </label>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-muted-foreground">
            <label className="flex items-center gap-1.5">
              运行次数
              <input
                type="number"
                min={1}
                max={100}
                value={repeatCount}
                disabled={locked}
                onChange={(event) =>
                  setRepeatCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
                }
                className="field-input h-6 w-16 px-1.5 py-0 text-[11px] tabular-nums"
              />
            </label>
            <span>
              共 {selectedEnvIds.length * repeatCount} 次 · 每轮在新标签中操作（不超过 20 个回放标签）
            </span>
          </div>
        </div>

        <div className="shrink-0 rounded-lg bg-sunken px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              回放目标 / 指令
            </span>
            <div className="relative">
              <button
                type="button"
                className="btn btn-outline h-6 gap-1 px-2 text-[10px]"
                disabled={locked}
                title="把规则库里的人设 / 规则以 @名称 插进目标：@人设 决定 {{persona.*}} 与固定字段，@规则 在收尾时按规则硬校验"
                onClick={() => setMentionMenuOpen((current) => !current)}
              >
                <AtSign size={11} />
                @ 人设 / 规则
              </button>
              {mentionMenuOpen ? (
                <div className="absolute right-0 z-[70] mt-1 max-h-60 w-64 overflow-y-auto rounded-md border border-border bg-raised p-1 shadow-pop">
                  {ruleLibrary.personas.length === 0 && ruleLibrary.rules.length === 0 ? (
                    <p className="px-2 py-1.5 text-[10px] text-muted-foreground">
                      规则库是空的：先在 Agent 底部「规则」窗口里建人设 / 规则。
                    </p>
                  ) : (
                    <>
                      {ruleLibrary.personas.length > 0 ? (
                        <p className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          人设
                        </p>
                      ) : null}
                      {ruleLibrary.personas.map((persona) => (
                        <button
                          key={persona.id}
                          type="button"
                          className="row-selectable block w-full truncate rounded px-2 py-1 text-left text-[11px]"
                          onClick={() => insertMention(persona.label)}
                        >
                          @{persona.label}
                        </button>
                      ))}
                      {ruleLibrary.rules.length > 0 ? (
                        <p className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          规则
                        </p>
                      ) : null}
                      {ruleLibrary.rules.map((rule) => (
                        <button
                          key={rule.id}
                          type="button"
                          className="row-selectable block w-full truncate rounded px-2 py-1 text-left text-[11px]"
                          onClick={() => insertMention(rule.title)}
                        >
                          @{rule.title}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          <textarea
            ref={goalInputRef}
            className="field-input mt-1 min-h-[52px] w-full resize-y px-2 py-1.5 text-[11px] leading-5"
            value={goalOverride}
            disabled={locked}
            placeholder="回放目标（默认沿用录制目标）；可写 @人设名 / @规则名，字段值用 {{data.<列名>}}"
            onChange={(event) => setGoalOverride(event.target.value)}
          />
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            {goalMentions.persona
              ? `本次 @人设「${goalMentions.persona.label}」：{{persona.*}} 用它，固定字段是权威值。`
              : "没有 @人设：{{persona.*}} 保持原样不展开。"}
            {goalMentions.rules.length > 0
              ? ` 本次 @规则 ${goalMentions.rules.length} 条：机械步跑完后按规则硬校验（严格完成条件 / 必须点击 / 固定数据），没满足不算成功。`
              : " 没有 @规则：不额外校验。"}
          </p>
        </div>

        <details className="shrink-0 rounded-lg bg-sunken px-3 py-2">
          <summary className="cursor-pointer select-none text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            数据源（多轮分配与预检单的输入）
            {dataSource === "clipboard"
              ? " · 剪贴板快照"
              : datasetDraft && !datasetDraft.error && datasetDraft.rows.length > 0
                ? ` · 已载入 ${datasetDraft.rows.length} 行`
                : ""}
          </summary>
          <div className="space-y-2 pt-2">
            <div className="flex flex-wrap gap-3 text-[11px] text-foreground">
              {(
                [
                  ["dataset", "数据集（粘贴 JSON / CSV / 每行一条）"],
                  ["clipboard", "剪贴板快照（开局读一次系统剪贴板）"],
                ] as Array<["dataset" | "clipboard", string]>
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="replay-data-source"
                    checked={dataSource === value}
                    disabled={locked}
                    onChange={() => setDataSource(value)}
                  />
                  {label}
                </label>
              ))}
            </div>

            {dataSource === "dataset" ? (
              <ReplayDatasetEditor
                fields={fields}
                draft={datasetDraft}
                onChange={setDatasetDraft}
                requiredRows={selectedEnvIds.length * repeatCount}
                disabled={locked}
              />
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] leading-5 text-muted-foreground">
                  开局读一次系统剪贴板并冻结为单行数据集（列名{" "}
                  <code className="rounded bg-secondary/60 px-1">text</code>
                  ）。内容只留内存，不入库、不入日志。
                </p>
                {fields.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-[10px] font-medium text-muted-foreground">
                      字段映射（把剪贴板内容填到哪个字段）
                    </p>
                    {fields.map((field) => (
                      <label key={field.key} className="flex items-center gap-2 text-[10px]">
                        <span className="w-24 shrink-0 truncate text-foreground" title={field.key}>
                          {field.label}
                        </span>
                        <input
                          type="checkbox"
                          disabled={locked}
                          checked={clipboardMap[field.key] === "text"}
                          onChange={(event) =>
                            setClipboardMap((current) => {
                              const next = { ...current };
                              if (event.target.checked) next[field.key] = "text";
                              else delete next[field.key];
                              return next;
                            })
                          }
                        />
                        填入剪贴板内容
                      </label>
                    ))}
                  </div>
                ) : null}
                <label className="flex items-start gap-1.5 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={locked}
                    checked={clipboardTreatAsHuman}
                    onChange={(event) => setClipboardTreatAsHuman(event.target.checked)}
                  />
                  <span>
                    剪贴板视为人工提供（R2）
                    <span className="block text-[10px] leading-4 text-muted-foreground">
                      默认关闭：纯数字短码 / 命中验证码词条的内容一律拒绝自动填入。
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* ⑥ 分配策略（§8.2）：决定「数据怎么分」，与 ⑤ 一起构成预检单的输入 */}
          <div className="mt-3 space-y-1.5 pt-2">
            <p className="text-[11px] font-medium text-muted-foreground">分配策略</p>
            <div className="flex flex-wrap gap-3 text-[11px] text-foreground">
              {(
                [
                  ["seq_interleave", "按序平分（同时开跑的浏览器拿相邻行）"],
                  ["seq_block", "每台连续区块"],
                  ["claim", "先到先领"],
                  ["cycle", "循环取用"],
                  ["generate", "全部生成"],
                ] as Array<[ReplayAllocMode, string]>
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="replay-alloc-mode"
                    checked={allocMode === value}
                    disabled={locked}
                    onChange={() => setAllocMode(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] text-foreground">
              <span className="text-muted-foreground">数据行不够时：</span>
              {(
                [
                  ["error", "报错不开跑（默认）"],
                  ["cycle", "循环取用"],
                  ["generate", "生成补齐"],
                ] as Array<[ReplayOnExhausted, string]>
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="replay-on-exhausted"
                    checked={onExhausted === value}
                    disabled={locked}
                    onChange={() => setOnExhausted(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-foreground">
              <label className="flex items-center gap-1.5">
                并发上限
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={maxConcurrency}
                  disabled={locked}
                  onChange={(event) =>
                    setMaxConcurrency(Math.max(1, Math.min(16, Number(event.target.value) || 1)))
                  }
                  className="field-input h-6 w-14 px-1.5 py-0 text-[11px] tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={stopOnFirstFailure}
                  disabled={locked}
                  onChange={(event) => setStopOnFirstFailure(event.target.checked)}
                />
                该环境某轮失败即停（不影响其它环境）
              </label>
            </div>
          </div>
        </details>

        {selectedEnvIds.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 pb-2">
            {selectedEnvIds.map((id) => {
              const active = id === activeEnvId;
              return (
                <button
                  key={id}
                  type="button"
                  disabled={locked}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "row-selected text-primary-text"
                      : "row-selectable text-muted-foreground"
                  }`}
                  onClick={() => setActiveEnvId(id)}
                >
                  环境 #{id}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* ⑦ 执行计划确认表（§4.6）：唯一能被「确认并启动」采信的东西 */}
        <div className="shrink-0 space-y-2 rounded-lg bg-sunken px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="field-label">执行计划确认表（预检单）</span>
            <button
              type="button"
              className="btn btn-outline btn-compact h-7"
              disabled={locked || planning || selectedEnvIds.length === 0 || fields.length === 0}
              onClick={() => void runPlanRequest(planEdits)}
              title="干跑：只算分配与风险，不启动任何页面"
            >
              {planning ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />}
              {planning ? "生成中…" : runPlan ? "重新生成" : "生成预检单"}
            </button>
          </div>
          {runPlan ? (
            <>
              {planStale ? (
                <p className="rounded-md bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                  参数已变化：当前预检单已失效（`planHash` 不再匹配）。请点「重新生成预检单」后再启动。
                </p>
              ) : null}
              <ReplayPlanTable
                plan={runPlan}
                planning={planning}
                disabled={locked}
                onEdit={handlePlanEdit}
                onReset={() => void runPlanRequest([])}
                envInfo={planEnvInfo}
              />
            </>
          ) : (
            <p className="text-[11px] leading-5 text-muted-foreground">
              点「生成预检单」先看逐行计划（每个环境第几轮用哪一行数据、会开多少标签、轨迹里有没有支付类步骤）。
              生成前不会启动任何页面。
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-outline"
            disabled={locked || fields.length === 0}
            onClick={() => setAllModes("fixed")}
          >
            全部设为固定值
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={locked || fields.length === 0}
            onClick={() => setAllModes("ai_prompt")}
          >
            <Wand2 size={13} />
            全部开启 AI 盲盒
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={locked || mocking || selectedEnvIds.length === 0 || fields.length === 0}
            onClick={() => void handleMockFields()}
            title="立即为选中环境的固定值字段生成具体值（AI 盲盒字段由运行时生成，会自动跳过）"
          >
            {mocking ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {mocking ? "造数中…" : "AI 造数"}
          </button>
          {dispatching ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={stopping}
              onClick={() => void handleStopDispatch()}
            >
              {stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />}
              {stopping ? "停止中…" : "停止派发"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                locked ||
                !plan ||
                plan.planMatrix.length === 0 ||
                fields.length === 0 ||
                !runPlan ||
                !runPlan.ok ||
                planStale ||
                planning
              }
              title={
                !runPlan
                  ? "请先生成预检单"
                  : planStale
                    ? "参数已变化，请重新生成预检单"
                    : !runPlan.ok
                      ? "预检单含红条，禁止启动"
                      : `将按预检单执行 ${runPlan.totals.totalRuns} 次（planHash ${runPlan.planHash.slice(0, 12)}…）`
              }
              onClick={() => void handleDispatch()}
            >
              确认并启动
            </button>
          )}
        </div>

        {fields.length === 0 ? (
          <p className="text-[11px] leading-5 text-muted-foreground">
            该轨迹没有 fill / select / agent_batch_fill 步骤。请用 Agent 重新录制（新录制会写入
            semanticContext）。
          </p>
        ) : !activeEnvId || !activeRow ? (
          <p className="text-[11px] leading-5 text-muted-foreground">
            请勾选至少一个运行中的环境以编辑字段。
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-sunken">
            <div className="flex shrink-0 items-center justify-between gap-2 bg-surface-muted px-3 py-2 text-[11px] text-muted-foreground">
              <span className="truncate">
                {plan?.summary} · 编辑 <span className="font-medium text-foreground">#{activeEnvId}</span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{`{{geoip.city}}`}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
              {fields.map((field) => {
                const override = activeRow.fieldOverrides?.[field.key] ?? defaultOverride(field, "fixed");
                const aiMode = override.mode === "ai_prompt";
                return (
                  <div
                    key={field.key}
                    className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(8rem,10.5rem)_minmax(0,1fr)_auto_auto_auto]"
                  >
                    <div className="flex min-w-0 items-start gap-1.5" title={field.key}>
                      <TypeIcon inputType={field.inputType ?? override.inputType} />
                      <div className="min-w-0">
                        <div className="truncate text-caption font-medium text-foreground">{field.label}</div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {field.inputType ? `${field.inputType} · ` : ""}
                          {field.semanticSource ? `${field.semanticSource} · ` : ""}
                          {shortSelector(field.key, 22)}
                        </div>
                      </div>
                    </div>
                    <MagicVariableInput
                      value={override.value}
                      disabled={locked}
                      aiMode={aiMode}
                      placeholder={
                        aiMode ? "AI 生成指令（可留空）" : `固定值 / {{persona.name}} / {{geoip.city}}`
                      }
                      onChange={(next) => patchOverride(activeEnvId, field.key, { value: next })}
                    />
                    <label
                      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] transition-colors ${
                        aiMode
                          ? "bg-warning/10 text-warning ring-1 ring-inset ring-warning/40"
                          : "row-selectable text-muted-foreground"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={aiMode}
                        disabled={locked}
                        onChange={(event) =>
                          patchOverride(activeEnvId, field.key, {
                            mode: event.target.checked ? "ai_prompt" : "fixed",
                            value: event.target.checked
                              ? override.mode === "ai_prompt"
                                ? override.value
                                : ""
                              : override.value || field.recordedValue,
                          })
                        }
                      />
                      AI 自动生成
                    </label>
                    <button
                      type="button"
                      className="btn btn-outline h-8 shrink-0 gap-1 px-2 text-[10px] text-muted-foreground hover:text-primary-text"
                      disabled={locked || mocking || !activeEnvId || aiMode}
                      title={
                        aiMode
                          ? "AI 盲盒字段由填表前运行时生成，无需此处造数"
                          : "只用当前输入框内容为灵感，重新生成本字段的值"
                      }
                      aria-label="重新生成本字段的值"
                      onClick={() => void handleMockFields([field.key])}
                    >
                      {mocking ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                      <span className="hidden sm:inline">重新生成</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline h-8 shrink-0 gap-1 px-2 text-[10px] text-muted-foreground hover:text-primary-text"
                      disabled={locked || selectedEnvIds.length <= 1}
                      title="将当前字段的值与模式同步到所有已勾选环境"
                      aria-label="应用到全部选中环境"
                      onClick={() => applyFieldToAllSelected(field.key)}
                    >
                      <Copy size={12} />
                      <span className="hidden sm:inline">应用到全部</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
