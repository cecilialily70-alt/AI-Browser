/**
 * 「规则」窗口：Agent 底部的规则按钮打开的弹窗，分「规则」与「人设」两栏。
 *
 * 规则：完成条件 / 中途检查点 / 难点提醒 / 人工介入时机 / 必须点击 / 固定数据 / 详细步骤。
 *   规则**不**按环境预启用：唯一生效方式是 Agent 输入框里的 `@规则名` 引用；
 *   没有 @ 时 Agent 完全不查规则库（列表勾选框只服务「批量删除」）。
 *   完成条件支持严格校验（done 时必须核对通过）与命中即完成。
 * 人设：无限多条（含国家）。人设**不绑定环境**——Agent 任务与轨迹回放都只在
 *   输入框 / 目标里被 `@人设名` 引用时才生效（与规则一致）。
 *   每条人设自己按**字段级**勾选要固定为权威值的字段（「全选固定 / 取消全部固定」一次搞定所有字段）；
 *   未勾选的必填项由 AI 随机生成。
 *   名称不允许重复：新建自动带序号，手动改成重名会提示并自动改名。
 *
 * 安全：规则里的「代码」只支持 CSS 选择器与文本匹配，**不执行用户提供的任何 JS**；
 * 参考图只用于视觉比对，禁止当验证码/OTP 取码依据（R2 / B7）。
 */
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import {
  RULE_KIND_OPTIONS,
  RULE_ROLE_OPTIONS,
  PERSONA_FIELD_OPTIONS,
  MAX_IMAGE_CHARS,
  type AgentPersona,
  type AgentPersonaField,
  type AgentRule,
  type AgentRuleKind,
  type AgentRuleMatchScope,
  type AgentRuleRole,
  createAgentPersona,
  createAgentRule,
  createAgentRuleStep,
  clearLegacyPersonaSelection,
  loadAgentRuleLibrary,
  makeUniqueName,
  personaEffectiveFixedFields,
  ruleDiagnostics,
  ruleIsMachineCheckable,
  saveAgentPersonas,
  saveAgentRules,
  stepIsMachineCheckable,
  type AgentRuleStep,
} from "../lib/agentRules";
import { detectPersonaGeoConflicts, formatGeoHintLabel, type PersonaGeoHint } from "../lib/personaGeo";
import type { Profile, ProfileIpGeo } from "../types";
import { Modal } from "./Modal";
import { useAppDialog } from "./AppDialogProvider";

/** 规则/流程步骤的参考图上限与压缩参数：兼顾提示词体积与识别清晰度 */
const MAX_REFERENCE_IMAGE_BYTES = 4 * 1024 * 1024;
const REFERENCE_IMAGE_MAX_EDGE = 1024;

/** 参考图压缩：控制在提示词体积与识别清晰度之间取平衡，并保证最终不超 sidecar 上限 */
async function prepareReferenceImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error("decode failed"));
      node.src = dataUrl;
    });
    const baseScale = Math.min(1, REFERENCE_IMAGE_MAX_EDGE / Math.max(image.width || 1, image.height || 1));
    if (baseScale >= 1 && dataUrl.length <= MAX_IMAGE_CHARS) {
      return dataUrl;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      return dataUrl;
    }
    const render = (scale: number, quality: number): string => {
      canvas.width = Math.max(1, Math.round((image.width || 1) * scale));
      canvas.height = Math.max(1, Math.round((image.height || 1) * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality);
    };
    // A8：逐步降质 / 降尺寸，直到低于上限（否则 sidecar 会丢弃这张图，规则永远不命中）。
    let scale = baseScale;
    let quality = 0.72;
    let out = render(scale, quality);
    for (let i = 0; i < 12 && out.length > MAX_IMAGE_CHARS && quality > 0.32; i += 1) {
      quality = Math.max(0.32, quality - 0.1);
      out = render(scale, quality);
    }
    for (let i = 0; i < 12 && out.length > MAX_IMAGE_CHARS && scale > 0.25; i += 1) {
      scale = Math.max(0.25, scale * 0.75);
      out = render(scale, quality);
    }
    return out;
  } catch {
    return dataUrl;
  }
}

interface FlowStepEditorProps {
  step: AgentRuleStep;
  index: number;
  total: number;
  onChange: (patch: Partial<AgentRuleStep>, commit?: boolean) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onToastError: (message: string) => void;
}

/**
 * 「详细步骤」里单步的编辑器。
 *
 * 判据（选择器/文本/参考图）是**流程推进的唯一依据**：只有带判据的步骤才会被机器核对，
 * 命中后自动进入下一步；选了「界面图片」但没上传图会被降级成纯指引（前端提示 + 引擎侧同口径）。
 */
function FlowStepEditor({
  step,
  index,
  total,
  onChange,
  onRemove,
  onMove,
  onToastError,
}: FlowStepEditorProps) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const checkable = stepIsMachineCheckable(step);

  const onPickImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
      onToastError("参考图不要超过 4MB");
      return;
    }
    setBusy(true);
    try {
      const image = await prepareReferenceImage(file);
      if (image.length > MAX_IMAGE_CHARS) {
        onToastError(`参考图压缩后仍超过 ${Math.round(MAX_IMAGE_CHARS / 1000)}KB，请换一张更小的图`);
        return;
      }
      onChange({ kind: "vision", image }, true);
    } catch {
      onToastError("读取参考图失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group-well space-y-2 rounded-lg p-2">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {index + 1}/{total}
        </span>
        <input
          className="field-input h-7 flex-1 text-[11px]"
          value={step.title}
          onChange={(event) => onChange({ title: event.target.value })}
          onBlur={() => onChange({}, true)}
          placeholder="步骤名（如：打开注册页）"
        />
        <button
          type="button"
          className="icon-button h-6 w-6"
          title="上移"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp size={11} />
        </button>
        <button
          type="button"
          className="icon-button h-6 w-6"
          title="下移"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={11} />
        </button>
        <button
          type="button"
          className="icon-button h-6 w-6 hover:text-destructive"
          title="删除该步骤"
          onClick={onRemove}
        >
          <Trash2 size={11} />
        </button>
      </div>

      <textarea
        className="field-input min-h-[46px] resize-y text-[11px]"
        value={step.instruction}
        onChange={(event) => onChange({ instruction: event.target.value })}
        onBlur={() => onChange({}, true)}
        placeholder="这一步做什么（如：填邮箱、勾选条款后下一步）"
      />

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="field-input h-7 w-auto min-w-[7.5rem] text-[11px]"
          value={step.kind}
          onChange={(event) => {
            const kind = event.target.value as AgentRuleKind;
            // C4：切 kind 时清掉其它 kind 的判据，避免旧字段残留泄漏进提示词。
            if (kind === "text") {
              onChange({
                kind,
                selector: undefined,
                matchText: undefined,
                matchScope: undefined,
                image: undefined,
                visionNote: undefined,
              });
            } else if (kind === "dom") {
              onChange({ kind, image: undefined, visionNote: undefined });
            } else {
              onChange({ kind, selector: undefined, matchText: undefined, matchScope: undefined });
            }
          }}
        >
          {RULE_KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {step.kind === "vision" ? (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/*"
              onChange={(event) => void onPickImage(event)}
            />
            <button
              type="button"
              className="btn btn-outline btn-compact h-7"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus size={11} />
              {busy ? "处理中…" : step.image ? "换一张" : "上传判据图"}
            </button>
            {step.image ? (
              <img src={step.image} alt="步骤判据参考图" className="max-h-16 rounded-md object-contain" />
            ) : null}
            <input
              className="field-input h-7 flex-1 text-[11px]"
              value={step.visionNote ?? ""}
              onChange={(event) => onChange({ visionNote: event.target.value })}
              onBlur={() => onChange({}, true)}
              placeholder="界面判据（如：出现注册成功对勾）"
            />
          </>
        ) : null}
      </div>

      {step.kind === "dom" ? (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <input
              className="field-input h-7 font-mono text-[11px]"
              value={step.selector ?? ""}
              onChange={(event) => onChange({ selector: event.target.value })}
              onBlur={() => onChange({}, true)}
              placeholder="#register-success"
            />
            <input
              className="field-input h-7 text-[11px]"
              value={step.matchText ?? ""}
              onChange={(event) => onChange({ matchText: event.target.value })}
              onBlur={() => onChange({}, true)}
              placeholder="页面包含文本（如：注册成功）"
            />
          </div>
          {step.selector && step.matchText ? (
            <select
              className="field-input h-7 w-auto min-w-[11rem] text-[11px]"
              value={step.matchScope === "selector" ? "selector" : "page"}
              onChange={(event) => onChange({ matchScope: event.target.value as AgentRuleMatchScope }, true)}
            >
              <option value="page">文本在整页里找</option>
              <option value="selector">文本只在选择器子树里找</option>
            </select>
          ) : null}
        </div>
      ) : null}

      <p className="text-[10px] leading-4 text-muted-foreground">
        {checkable
          ? "该步骤由系统机器核对（选择器/文本/参考图），命中后自动进入下一步。"
          : "无判据：该步骤只作指引，会并入当前步骤交给 Agent；不会被自动判定为已完成。"}
      </p>
    </div>
  );
}

interface AgentRulesModalProps {
  open: boolean;
  onClose: () => void;
  profileId: string | null;
  profiles: Profile[];
  ipGeo?: ProfileIpGeo | null;
  onToastError: (message: string) => void;
  onToastSuccess: (message: string) => void;
  onLibraryChange?: () => void;
}

type LibraryTab = "rules" | "personas";

export function AgentRulesModal({
  open,
  onClose,
  profileId,
  profiles,
  ipGeo,
  onToastError,
  onToastSuccess,
  onLibraryChange,
}: AgentRulesModalProps) {
  const { confirm } = useAppDialog();
  const [tab, setTab] = useState<LibraryTab>("rules");
  const [rules, setRules] = useState<AgentRule[]>([]);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [deleteMode, setDeleteMode] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  /**
   * 规则/人设的最新快照：`patchRule` 走 ref 而不是闭包里的 state，
   * 否则「await 上传参考图期间用户又改了别的字段」会被点击那一刻的旧快照整体回滚。
   */
  const rulesRef = useRef<AgentRule[]>([]);
  const personasRef = useRef<AgentPersona[]>([]);
  /** 读到过规则库才允许卸载兜底落库：避免「读取失败 → 空列表 → 反而把库覆盖成空」。 */
  const libraryLoadedRef = useRef(false);

  const activeProfileId = profileId ?? null;
  const activeProfile = useMemo(
    () => profiles.find((item) => String(item.id) === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  /** 重名不允许：列表里如有同名条目，保留首条、其余自动带序号 */
  const dedupeRuleTitles = useCallback((list: AgentRule[]): AgentRule[] => {
    const seen: string[] = [];
    return list.map((rule) => {
      const unique = makeUniqueName(rule.title, seen);
      seen.push(unique);
      return unique === rule.title ? rule : { ...rule, title: unique };
    });
  }, []);

  const dedupePersonaLabels = useCallback((list: AgentPersona[]): AgentPersona[] => {
    const seen: string[] = [];
    return list.map((persona) => {
      const unique = makeUniqueName(persona.label, seen);
      seen.push(unique);
      return unique === persona.label ? persona : { ...persona, label: unique };
    });
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    libraryLoadedRef.current = false;
    try {
      const library = await loadAgentRuleLibrary();
      rulesRef.current = library.rules;
      personasRef.current = library.personas;
      setRules(library.rules);
      setPersonas(library.personas);
      // 一次性迁移：旧「按环境指定的固定字段」已并进人设自身；把旧键清空（此后无人再读它）。
      if (library.legacySelectionMigrated) {
        await saveAgentPersonas(library.personas).catch(() => undefined);
        await clearLegacyPersonaSelection().catch(() => undefined);
      }
      setSelectedRuleId((current) =>
        current && library.rules.some((item) => item.id === current)
          ? current
          : (library.rules[0]?.id ?? null),
      );
      setSelectedPersonaId((current) =>
        current && library.personas.some((item) => item.id === current)
          ? current
          : (library.personas[0]?.id ?? null),
      );
      libraryLoadedRef.current = true;
    } catch (error) {
      onToastError(`读取规则库失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [onToastError]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDeleteMode(false);
    setPendingDelete([]);
    void reload();
  }, [open, reload]);

  // 卸载兜底：切右栏 Tab 等「非 handleClose」的卸载会销毁本组件，未失焦的编辑必须保住。
  // 只有在成功读到过规则库时才写回，防止读失败拿到空列表反把库覆盖成空。
  useEffect(() => {
    return () => {
      if (!libraryLoadedRef.current) return;
      void saveAgentRules(dedupeRuleTitles(rulesRef.current)).catch(() => undefined);
      void saveAgentPersonas(dedupePersonaLabels(personasRef.current)).catch(() => undefined);
    };
  }, [dedupeRuleTitles, dedupePersonaLabels]);

  const selectedRule = useMemo(
    () => rules.find((item) => item.id === selectedRuleId) ?? null,
    [rules, selectedRuleId],
  );
  const selectedPersona = useMemo(
    () => personas.find((item) => item.id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId],
  );

  /** A5：同源诊断（不会生效 / 已被降级 / 超限）——在规则页顶部黄条「先说后跑」。 */
  const diagnostics = useMemo(() => ruleDiagnostics(rules), [rules]);

  const geoConflicts = useMemo(
    () =>
      selectedPersona
        ? detectPersonaGeoConflicts(selectedPersona, (ipGeo ?? null) as PersonaGeoHint | null)
        : [],
    [selectedPersona, ipGeo],
  );

  /** 重名不允许：失焦时把重名条目自动改成唯一名（保留用户输入，只是加序号） */
  const uniquifyRuleTitle = useCallback((ruleId: string): string | null => {
    const rule = rulesRef.current.find((item) => item.id === ruleId);
    if (!rule) {
      return null;
    }
    const others = rulesRef.current.filter((item) => item.id !== ruleId).map((item) => item.title);
    const unique = makeUniqueName(rule.title, others);
    return unique === rule.title ? null : unique;
  }, []);

  const uniquifyPersonaLabel = useCallback((personaId: string): string | null => {
    const persona = personasRef.current.find((item) => item.id === personaId);
    if (!persona) {
      return null;
    }
    const others = personasRef.current.filter((item) => item.id !== personaId).map((item) => item.label);
    const unique = makeUniqueName(persona.label, others);
    return unique === persona.label ? null : unique;
  }, []);

  const persistRules = useCallback(
    async (next: AgentRule[]) => {
      rulesRef.current = next;
      setRules(next);
      try {
        await saveAgentRules(next);
      } catch (error) {
        // C6：保存失败必须显式告知，绝不「看起来保存了」。
        onToastError(`保存规则失败：${String(error)}`);
        return;
      }
      onLibraryChange?.();
    },
    [onLibraryChange, onToastError],
  );

  const persistPersonas = useCallback(
    async (next: AgentPersona[]) => {
      personasRef.current = next;
      setPersonas(next);
      try {
        await saveAgentPersonas(next);
      } catch (error) {
        onToastError(`保存人设失败：${String(error)}`);
        return;
      }
      onLibraryChange?.();
    },
    [onLibraryChange, onToastError],
  );

  /** 字段「固定」直接写进人设自身（不再有「先指定给环境」这一步） */
  const setPersonaFixedFields = useCallback(
    async (personaId: string, fields: AgentPersonaField[]) => {
      const persona = personasRef.current.find((item) => item.id === personaId);
      if (!persona) {
        return;
      }
      const next = personasRef.current.map((item) =>
        item.id === personaId ? { ...item, fixedFields: fields, fixedFieldsConfigured: true } : item,
      );
      await persistPersonas(next);
    },
    [persistPersonas],
  );

  const togglePersonaField = useCallback(
    async (field: AgentPersonaField) => {
      const persona = personasRef.current.find((item) => item.id === selectedPersonaId);
      if (!persona) {
        return;
      }
      // 从未勾过「固定」的人设，界面上显示的是「已填字段默认固定」——
      // 第一次点击以这份可见状态为准做增/删，避免用户看到勾着却点不动。
      const current = personaEffectiveFixedFields(persona);
      const fixedNow = current.includes(field);
      await setPersonaFixedFields(
        persona.id,
        fixedNow ? current.filter((item) => item !== field) : [...current, field],
      );
    },
    [selectedPersonaId, setPersonaFixedFields],
  );

  /** 人设字段「固定」全选 / 取消全选 */
  const toggleAllPersonaFields = useCallback(
    async (fix: boolean) => {
      if (!selectedPersonaId) {
        return;
      }
      const allFields = PERSONA_FIELD_OPTIONS.map((option) => option.value);
      await setPersonaFixedFields(selectedPersonaId, fix ? [...allFields] : []);
    },
    [selectedPersonaId, setPersonaFixedFields],
  );

  /*
   * 编辑节奏：与设置页一致 —— 文本框改动只进本地 state，**失焦时**才落库，
   * 避免每敲一个字就写一次 SQLite + 通知外层刷新（那是明显的卡顿源）。
   * 下拉/开关这类离散改动立即落库，因为它们没有「半成品」状态。
   */
  const patchRule = useCallback(
    (patch: Partial<AgentRule>, options?: { commit?: boolean }) => {
      const id = selectedRuleId;
      if (!id) {
        return;
      }
      let clearedFlags = false;
      // 基于 ref 的最新快照派生，避免异步窗口期（如参考图上传）用旧闭包整体回滚。
      const next = rulesRef.current.map((item) => {
        if (item.id !== id) {
          return item;
        }
        const merged: AgentRule = { ...item, ...patch };
        // C5：判据失效时**当场**取消严格核对 / 命中即完成，而不是等下次重载静默变 false。
        if ((merged.strict === true || merged.autoComplete === true) && !ruleIsMachineCheckable(merged)) {
          clearedFlags = true;
          merged.strict = false;
          merged.autoComplete = false;
        }
        return merged;
      });
      if (options?.commit) {
        void persistRules(next);
        if (clearedFlags) {
          onToastError("判据已清空：严格核对 / 命中即完成已自动取消（没有判据就不会拦住 done）");
        }
      } else {
        rulesRef.current = next;
        setRules(next);
      }
    },
    [selectedRuleId, persistRules, onToastError],
  );

  /* ---- 「详细步骤」：步骤增删改（顺序即执行顺序，全部走 patchRule 保持同一份快照） ---- */

  const writeSteps = useCallback(
    (mutate: (steps: AgentRuleStep[]) => AgentRuleStep[], commit = true) => {
      const rule = rulesRef.current.find((item) => item.id === selectedRuleId);
      if (!rule) {
        return;
      }
      patchRule({ steps: mutate(rule.steps ?? []) }, { commit });
    },
    [selectedRuleId, patchRule],
  );

  const addFlowStep = useCallback(() => {
    writeSteps((steps) => [...steps, createAgentRuleStep(steps.map((item) => item.title))].slice(0, 20));
  }, [writeSteps]);

  const patchFlowStep = useCallback(
    (stepId: string, patch: Partial<AgentRuleStep>, commit = false) => {
      writeSteps((steps) => steps.map((item) => (item.id === stepId ? { ...item, ...patch } : item)), commit);
    },
    [writeSteps],
  );

  const removeFlowStep = useCallback(
    (stepId: string) => {
      writeSteps((steps) => steps.filter((item) => item.id !== stepId));
    },
    [writeSteps],
  );

  const moveFlowStep = useCallback(
    (stepId: string, delta: number) => {
      writeSteps((steps) => {
        const index = steps.findIndex((item) => item.id === stepId);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= steps.length) {
          return steps;
        }
        const next = [...steps];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved!);
        return next;
      });
    },
    [writeSteps],
  );

  const patchPersona = useCallback(
    (patch: Partial<AgentPersona>, options?: { commit?: boolean }) => {
      const id = selectedPersonaId;
      if (!id) {
        return;
      }
      const next = personasRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item));
      if (options?.commit) {
        void persistPersonas(next);
      } else {
        personasRef.current = next;
        setPersonas(next);
      }
    },
    [selectedPersonaId, persistPersonas],
  );

  const commitEdits = useCallback(() => {
    void persistRules(dedupeRuleTitles(rulesRef.current));
    void persistPersonas(dedupePersonaLabels(personasRef.current));
  }, [dedupeRuleTitles, dedupePersonaLabels, persistRules, persistPersonas]);

  // 关闭前补一次落库：直接点「关闭」时输入框的 onBlur 不保证先触发，不能丢编辑
  const handleClose = useCallback(() => {
    commitEdits();
    onClose();
  }, [commitEdits, onClose]);

  const handleAddRule = useCallback(() => {
    // 默认名自动去重：连点两次也不会出现两条同名「完成条件」。
    const created = createAgentRule(
      "complete",
      rules.map((item) => item.title),
    );
    void persistRules([created, ...rules]);
    setSelectedRuleId(created.id);
    setTab("rules");
    setDeleteMode(false);
  }, [rules, persistRules]);

  const handleAddPersona = useCallback(() => {
    const created = createAgentPersona(personas.map((item) => item.label));
    void persistPersonas([created, ...personas]);
    setSelectedPersonaId(created.id);
    setTab("personas");
    setDeleteMode(false);
  }, [personas, persistPersonas]);

  /** 批量删除模式的「全选 / 全部取消」 */
  const toggleSelectAllForDelete = useCallback(() => {
    const ids = tab === "rules" ? rules.map((item) => item.id) : personas.map((item) => item.id);
    setPendingDelete((current) => (current.length === ids.length ? [] : ids));
  }, [tab, rules, personas]);

  /** 重名不允许：名称失焦时自动改成唯一名并提示（保留用户输入，只加序号） */
  const handleRuleTitleBlur = useCallback(() => {
    const id = selectedRuleId;
    if (id) {
      const unique = uniquifyRuleTitle(id);
      if (unique) {
        patchRule({ title: unique }, { commit: true });
        onToastError(`规则名重复，已自动改为「${unique}」`);
        return;
      }
    }
    commitEdits();
  }, [selectedRuleId, uniquifyRuleTitle, patchRule, commitEdits, onToastError]);

  const handlePersonaLabelBlur = useCallback(() => {
    const id = selectedPersonaId;
    if (id) {
      const unique = uniquifyPersonaLabel(id);
      if (unique) {
        patchPersona({ label: unique }, { commit: true });
        onToastError(`人设名重复，已自动改为「${unique}」`);
        return;
      }
    }
    commitEdits();
  }, [selectedPersonaId, uniquifyPersonaLabel, patchPersona, commitEdits, onToastError]);

  const handleDeleteRule = useCallback(
    async (rule: AgentRule) => {
      const ok = await confirm({
        title: "删除规则",
        description: `确定删除「${rule.title}」？此操作不可撤销。`,
        confirmLabel: "删除",
        tone: "danger",
      });
      if (!ok) {
        return;
      }
      const next = rules.filter((item) => item.id !== rule.id);
      await persistRules(next);
      setSelectedRuleId(next[0]?.id ?? null);
      onToastSuccess(`已删除规则「${rule.title}」`);
    },
    [confirm, rules, persistRules, onToastSuccess],
  );

  const handleBatchDelete = useCallback(async () => {
    if (pendingDelete.length === 0) {
      onToastError("请先勾选要删除的条目");
      return;
    }
    const ok = await confirm({
      title: tab === "rules" ? "批量删除规则" : "批量删除人设",
      description: `确定删除选中的 ${pendingDelete.length} 项？此操作不可撤销。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) {
      return;
    }
    const remove = new Set(pendingDelete);
    if (tab === "rules") {
      const next = rules.filter((item) => !remove.has(item.id));
      await persistRules(next);
      setSelectedRuleId(next[0]?.id ?? null);
    } else {
      const next = personas.filter((item) => !remove.has(item.id));
      await persistPersonas(next);
      setSelectedPersonaId(next[0]?.id ?? null);
    }
    setPendingDelete([]);
    setDeleteMode(false);
    onToastSuccess(`已删除 ${remove.size} 项`);
  }, [
    pendingDelete,
    tab,
    confirm,
    rules,
    personas,
    persistRules,
    persistPersonas,
    onToastSuccess,
    onToastError,
  ]);

  const onReferencePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
      onToastError("参考图不要超过 4MB");
      return;
    }
    setImageBusy(true);
    try {
      const image = await prepareReferenceImage(file);
      if (image.length > MAX_IMAGE_CHARS) {
        onToastError(
          `参考图压缩后仍超过 ${Math.round(MAX_IMAGE_CHARS / 1000)}KB，请换一张更小的图（超限的图引擎会丢弃，规则永远不命中）`,
        );
        return;
      }
      patchRule({ kind: "vision", image }, { commit: true });
    } catch {
      onToastError("读取参考图失败");
    } finally {
      setImageBusy(false);
    }
  };

  const envLabel = activeProfile
    ? `环境 #${activeProfile.id}${activeProfile.name ? ` · ${activeProfile.name}` : ""}`
    : "未选择环境";

  return (
    <Modal
      open={open}
      title="规则"
      description={`${envLabel} · 规则与人设都仅在 Agent 输入框 / 回放目标里 @引用 时生效`}
      onClose={handleClose}
      widthClass="max-w-4xl"
    >
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-2 pb-2">
          <div className="segmented w-auto">
            <button
              type="button"
              className={`segmented-item ${tab === "rules" ? "segmented-item-active" : ""}`}
              onClick={() => {
                commitEdits();
                setTab("rules");
                setDeleteMode(false);
                setPendingDelete([]);
              }}
            >
              规则 ({rules.length})
            </button>
            <button
              type="button"
              className={`segmented-item ${tab === "personas" ? "segmented-item-active" : ""}`}
              onClick={() => {
                commitEdits();
                setTab("personas");
                setDeleteMode(false);
                setPendingDelete([]);
              }}
            >
              人设 ({personas.length})
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="btn btn-outline btn-compact h-7"
              onClick={() => {
                setDeleteMode((current) => !current);
                setPendingDelete([]);
              }}
            >
              {deleteMode ? "退出批量删除" : "批量删除"}
            </button>
            {deleteMode ? (
              <button
                type="button"
                className="btn btn-danger btn-compact h-7"
                onClick={() => void handleBatchDelete()}
              >
                <Trash2 size={11} />
                删除所选 ({pendingDelete.length})
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-compact h-7"
                onClick={tab === "rules" ? handleAddRule : handleAddPersona}
              >
                <Plus size={11} />
                {tab === "rules" ? "新增规则" : "新增人设"}
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <p className="py-6 text-center text-caption text-muted-foreground">读取中…</p>
        ) : tab === "rules" ? (
          <div className="flex min-h-0 flex-col gap-2">
            {diagnostics.length > 0 ? (
              <div className="rounded-md bg-warning/10 p-2">
                <p className="text-[10px] font-medium text-warning">以下规则不会按预期生效（先修好再跑）</p>
                <ul className="mt-1 space-y-0.5">
                  {diagnostics.map((item, index) => (
                    <li
                      key={`${item.code}-${item.ruleId ?? index}`}
                      className="text-[10px] leading-4 text-warning"
                    >
                      {item.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="grid min-h-[320px] grid-cols-1 gap-3 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
              <div className="well flex max-h-[420px] flex-col overflow-hidden">
                <div className="group-well flex shrink-0 items-center justify-between gap-2 rounded-b-none px-2 py-1">
                  {deleteMode ? (
                    <label
                      className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] text-muted-foreground"
                      title="选中全部规则用于批量删除"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded accent-primary"
                        checked={rules.length > 0 && pendingDelete.length === rules.length}
                        onChange={toggleSelectAllForDelete}
                      />
                      全选待删
                    </label>
                  ) : (
                    <span
                      className="text-[10px] text-muted-foreground"
                      title="规则只在 Agent 输入框 @引用 时生效"
                    >
                      @引用 生效
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    {deleteMode ? `已选 ${pendingDelete.length}` : `共 ${rules.length} 条`}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {rules.length === 0 ? (
                    <p className="p-3 text-[11px] text-muted-foreground">
                      还没有规则。点「新增规则」开始，例如「完成条件：出现 提交成功 文案」。
                    </p>
                  ) : (
                    rules.map((rule) => {
                      const roleLabel =
                        RULE_ROLE_OPTIONS.find((item) => item.value === rule.role)?.label ?? rule.role;
                      return (
                        <div
                          key={rule.id}
                          className={`flex items-start gap-2 px-2 py-1.5 ${
                            selectedRuleId === rule.id ? "row-selected" : "row-selectable"
                          }`}
                        >
                          {deleteMode ? (
                            <input
                              type="checkbox"
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded accent-destructive"
                              checked={pendingDelete.includes(rule.id)}
                              onChange={(event) =>
                                setPendingDelete((current) =>
                                  event.target.checked
                                    ? [...current, rule.id]
                                    : current.filter((id) => id !== rule.id),
                                )
                              }
                            />
                          ) : null}
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => setSelectedRuleId(rule.id)}
                          >
                            <span className="block truncate text-caption text-foreground">{rule.title}</span>
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {roleLabel}
                              {rule.role === "flow"
                                ? ` · ${(rule.steps ?? []).length} 步（${(rule.steps ?? []).filter(stepIsMachineCheckable).length} 步可判定）`
                                : rule.kind === "vision"
                                  ? " · 图片"
                                  : ""}
                              {rule.strict ? " · 严格" : ""}
                              {rule.autoComplete ? " · 命中即完成" : ""}
                            </span>
                          </button>
                          {!deleteMode ? (
                            <button
                              type="button"
                              className="p-0.5 text-muted-foreground hover:text-destructive"
                              title="删除该规则"
                              onClick={() => void handleDeleteRule(rule)}
                            >
                              <Trash2 size={12} />
                            </button>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="min-h-0 overflow-y-auto rounded-md p-3">
                {!selectedRule ? (
                  <p className="text-[11px] text-muted-foreground">选择左侧一条规则开始编辑。</p>
                ) : (
                  <div className="space-y-3">
                    <label className="field-label">
                      规则名称
                      <input
                        className="field-input"
                        value={selectedRule.title}
                        onChange={(event) => patchRule({ title: event.target.value })}
                        onBlur={handleRuleTitleBlur}
                        placeholder="如：出现「提交成功」"
                      />
                    </label>

                    {/* C8：可发现性 —— 规则唯一生效方式是任务里的 @引用 */}
                    <p className="text-[10px] leading-4 text-muted-foreground">
                      生效方式：
                      <span className="font-mono text-foreground">
                        @{selectedRule.title.trim() || "规则名"}
                      </span>
                    </p>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <label className="field-label">
                        作用
                        <select
                          className="field-input"
                          value={selectedRule.role}
                          onChange={(event) => {
                            const role = event.target.value as AgentRuleRole;
                            const keepFlags = role === "complete" || role === "flow";
                            patchRule(
                              {
                                role,
                                autoComplete: keepFlags ? selectedRule.autoComplete : false,
                                strict: keepFlags ? selectedRule.strict : false,
                                // 切到「详细步骤」时至少给一步，避免一片空面板
                                ...(role === "flow" && (selectedRule.steps ?? []).length === 0
                                  ? { steps: [createAgentRuleStep([])] }
                                  : {}),
                                // 「必须点击 / 固定数据」靠选择器/文本核对 → 自动切到「代码 / 选择器」
                                ...(role === "must_click" || role === "fixed_data"
                                  ? { kind: "dom" as AgentRuleKind }
                                  : {}),
                              },
                              { commit: true },
                            );
                          }}
                        >
                          {RULE_ROLE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedRule.role !== "flow" ? (
                        <label className="field-label">
                          判定方式
                          <select
                            className="field-input"
                            value={selectedRule.kind}
                            onChange={(event) => {
                              const kind = event.target.value as AgentRuleKind;
                              // C4：切 kind 时清掉其它 kind 的判据，避免旧字段残留泄漏进提示词。
                              const cleanup: Partial<AgentRule> =
                                kind === "text"
                                  ? {
                                      selector: undefined,
                                      matchText: undefined,
                                      matchScope: undefined,
                                      image: undefined,
                                      visionNote: undefined,
                                    }
                                  : kind === "dom"
                                    ? { image: undefined, visionNote: undefined }
                                    : { selector: undefined, matchText: undefined, matchScope: undefined };
                              patchRule(
                                {
                                  kind,
                                  ...cleanup,
                                  // 切到「自然语言」即无法机器核对：强制关掉严格/命中即完成，避免永久堵死 done。
                                  ...(kind === "text" ? { strict: false, autoComplete: false } : {}),
                                },
                                { commit: true },
                              );
                            }}
                          >
                            {RULE_KIND_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </div>

                    <p className="text-[10px] leading-4 text-muted-foreground">
                      {RULE_ROLE_OPTIONS.find((item) => item.value === selectedRule.role)?.hint}
                      {selectedRule.role === "flow"
                        ? ""
                        : ` · ${RULE_KIND_OPTIONS.find((item) => item.value === selectedRule.kind)?.hint}`}
                    </p>

                    {selectedRule.role === "flow" ? (
                      <div className="well space-y-2 rounded-lg p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-muted-foreground">
                            {(selectedRule.steps ?? []).length} 步 · 带判据的步骤由系统机器核对并自动推进
                          </span>
                          <button
                            type="button"
                            className="btn btn-outline btn-compact h-7"
                            onClick={addFlowStep}
                          >
                            <Plus size={11} />
                            新增步骤
                          </button>
                        </div>
                        {(selectedRule.steps ?? []).length === 0 ? (
                          <p className="text-[10px] leading-4 text-muted-foreground">
                            还没有步骤。点「新增步骤」，写清这一步要做什么；想让系统自动判断这一步到没到，
                            再给它一个判据（选择器 / 页面文本 / 界面图片）。
                          </p>
                        ) : null}
                        {(selectedRule.steps ?? []).map((step, index) => (
                          <FlowStepEditor
                            key={step.id}
                            step={step}
                            index={index}
                            total={(selectedRule.steps ?? []).length}
                            onChange={(patch, commit) => patchFlowStep(step.id, patch, commit === true)}
                            onRemove={() => removeFlowStep(step.id)}
                            onMove={(delta) => moveFlowStep(step.id, delta)}
                            onToastError={onToastError}
                          />
                        ))}
                      </div>
                    ) : null}

                    {selectedRule.role !== "flow" &&
                    (selectedRule.kind === "dom" ||
                      selectedRule.role === "must_click" ||
                      selectedRule.role === "fixed_data") ? (
                      <div className="space-y-3">
                        <label className="field-label">
                          CSS 选择器
                          <input
                            className="field-input font-mono"
                            value={selectedRule.selector ?? ""}
                            onChange={(event) => patchRule({ selector: event.target.value })}
                            onBlur={() => commitEdits()}
                            placeholder="#order-success 或 .toast-success"
                          />
                        </label>
                        <label className="field-label">
                          页面文本包含
                          <input
                            className="field-input"
                            value={selectedRule.matchText ?? ""}
                            onChange={(event) => patchRule({ matchText: event.target.value })}
                            onBlur={() => commitEdits()}
                            placeholder="例如：提交成功 / 已注册"
                          />
                        </label>
                        {selectedRule.selector && selectedRule.matchText ? (
                          <label className="field-label">
                            文本查找范围
                            <select
                              className="field-input"
                              value={selectedRule.matchScope === "selector" ? "selector" : "page"}
                              onChange={(event) =>
                                patchRule(
                                  { matchScope: event.target.value as AgentRuleMatchScope },
                                  { commit: true },
                                )
                              }
                            >
                              <option value="page">整页里找（默认）</option>
                              <option value="selector">只在上面这个选择器的子树里找</option>
                            </select>
                          </label>
                        ) : null}
                        {selectedRule.role === "fixed_data" ? (
                          <label className="field-label">
                            要固定的值
                            <input
                              className="field-input"
                              value={selectedRule.fixedValue ?? ""}
                              onChange={(event) => patchRule({ fixedValue: event.target.value })}
                              onBlur={() => commitEdits()}
                              placeholder="例如：us-buyer@example.com"
                            />
                          </label>
                        ) : null}
                        {selectedRule.role === "must_click" ? (
                          <p className="text-[10px] leading-4 text-muted-foreground">
                            系统会核对点击台账：这个选择器（或文本）指向的元素没被真正点过，就不许结束任务。
                          </p>
                        ) : null}
                        {selectedRule.role === "fixed_data" ? (
                          <p className="text-[10px] leading-4 text-muted-foreground">
                            系统会逐字段核对：上面选择器指向的输入框被改成别的值，就不许结束任务。
                          </p>
                        ) : null}
                        {selectedRule.role !== "must_click" && selectedRule.role !== "fixed_data" ? (
                          <p className="text-[10px] leading-4 text-muted-foreground">
                            只做选择器与文本的存在性校验，不会执行你填写的任何脚本。
                          </p>
                        ) : null}
                        {selectedRule.role === "fixed_data" &&
                        (!selectedRule.selector || !selectedRule.fixedValue) ? (
                          <p className="text-[10px] leading-4 text-destructive">
                            缺少{!selectedRule.selector ? "选择器" : "要固定的值"}，这条不会生效。
                          </p>
                        ) : null}
                        {selectedRule.role === "must_click" &&
                        !selectedRule.selector &&
                        !selectedRule.matchText ? (
                          <p className="text-[10px] leading-4 text-destructive">
                            没有填选择器或文本，无法核对是否点过，这条不会生效。
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {selectedRule.role !== "flow" && selectedRule.kind === "vision" ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            ref={imageInputRef}
                            type="file"
                            className="hidden"
                            accept="image/*"
                            onChange={(event) => void onReferencePicked(event)}
                          />
                          <button
                            type="button"
                            className="btn btn-outline btn-compact h-7"
                            disabled={imageBusy}
                            onClick={() => imageInputRef.current?.click()}
                          >
                            <ImagePlus size={11} />
                            {imageBusy ? "处理中…" : "上传界面图片"}
                          </button>
                          {selectedRule.image ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact h-7"
                              onClick={() => patchRule({ image: undefined }, { commit: true })}
                            >
                              移除图片
                            </button>
                          ) : null}
                        </div>
                        {selectedRule.image ? (
                          <img
                            src={selectedRule.image}
                            alt="规则参考图"
                            className="max-h-40 rounded-md object-contain"
                          />
                        ) : (
                          <p className="text-[10px] text-muted-foreground">
                            上传目标界面截图（可只截需要出现的那部分界面）
                          </p>
                        )}
                        <label className="field-label">
                          对照说明
                          <input
                            className="field-input"
                            value={selectedRule.visionNote ?? ""}
                            onChange={(event) => patchRule({ visionNote: event.target.value })}
                            onBlur={() => commitEdits()}
                            placeholder="如：出现订单成功对勾"
                          />
                        </label>
                      </div>
                    ) : null}

                    <label className="field-label">
                      {selectedRule.role === "flow" ? "流程总说明" : "补充说明 / 正文"}
                      <textarea
                        className="field-input min-h-[70px] resize-y"
                        value={selectedRule.text ?? ""}
                        onChange={(event) => patchRule({ text: event.target.value })}
                        onBlur={() => commitEdits()}
                        placeholder={
                          selectedRule.role === "flow"
                            ? "整套流程的目标与前提，例如：帮我注册一个谷歌账户，全程用英语界面"
                            : selectedRule.kind === "text"
                              ? "用自然语言描述，例如：这一步会遇到滑块验证码，失败三次就请人工接管"
                              : "可选的补充说明"
                        }
                      />
                    </label>

                    {selectedRule.role === "complete" || selectedRule.role === "flow" ? (
                      <div className="well space-y-2 rounded-lg p-2">
                        {(() => {
                          const checkable = ruleIsMachineCheckable(selectedRule);
                          const isFlow = selectedRule.role === "flow";
                          const flowSteps = selectedRule.steps ?? [];
                          const checkableCount = flowSteps.filter(stepIsMachineCheckable).length;
                          return (
                            <>
                              {!checkable ? (
                                <p className="text-[10px] leading-4 text-muted-foreground">
                                  {isFlow
                                    ? "这套流程还没有任何「判据」：请给至少一步配上选择器 / 页面文本 / 界面图片，系统才能核对并推进。"
                                    : "这条完成条件没有任何可核对的判据，不会拦住 done。请改选「代码 / 选择器」并填写选择器或文本，或改选「界面图片」并上传参考图，才能开启严格核对 / 命中即完成。"}
                                </p>
                              ) : null}
                              {isFlow && checkable ? (
                                <p className="text-[10px] leading-4 text-muted-foreground">
                                  共 {flowSteps.length} 步，其中 {checkableCount}{" "}
                                  步带判据（无判据的步骤只作指引）。
                                  下面两项针对**整套流程**：所有带判据的步骤都命中才算达成。
                                </p>
                              ) : null}
                              <label
                                className={`flex items-center gap-2 text-[11px] text-muted-foreground ${
                                  checkable ? "cursor-pointer" : "cursor-not-allowed"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded accent-primary"
                                  checked={selectedRule.strict === true}
                                  disabled={!checkable}
                                  onChange={(event) =>
                                    patchRule({ strict: event.target.checked }, { commit: true })
                                  }
                                />
                                AI 说完成时必须核对通过，否则不算完成
                              </label>
                              <label
                                className={`flex items-center gap-2 text-[11px] text-muted-foreground ${
                                  checkable ? "cursor-pointer" : "cursor-not-allowed"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded accent-primary"
                                  checked={selectedRule.autoComplete === true}
                                  disabled={!checkable}
                                  onChange={(event) =>
                                    patchRule({ autoComplete: event.target.checked }, { commit: true })
                                  }
                                />
                                {isFlow
                                  ? "整套步骤都命中即视为完成（AI 没说完成也收尾）"
                                  : "条件命中即视为完成（AI 没说完成也收尾）"}
                              </label>
                            </>
                          );
                        })()}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid min-h-[320px] grid-cols-1 gap-3 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
            <div className="well flex max-h-[420px] flex-col overflow-hidden">
              <div className="group-well flex shrink-0 items-center justify-between gap-2 rounded-b-none px-2 py-1">
                {deleteMode ? (
                  <label
                    className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] text-muted-foreground"
                    title="选中全部人设用于批量删除"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded accent-primary"
                      checked={personas.length > 0 && pendingDelete.length === personas.length}
                      onChange={toggleSelectAllForDelete}
                    />
                    全选待删
                  </label>
                ) : (
                  <span
                    className="text-[10px] text-muted-foreground"
                    title="人设不绑定环境：在 Agent 输入框或回放目标里写 @人设名 才生效；固定字段直接勾在右侧字段表里"
                  >
                    在目标里写 @人设名 生效
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {deleteMode ? `已选 ${pendingDelete.length}` : `共 ${personas.length} 条`}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {personas.length === 0 ? (
                  <p className="p-3 text-[11px] text-muted-foreground">
                    还没有人设。点「新增人设」创建并填写字段，再按需勾选要「固定」的字段；Agent 任务与回放里写 @人设名 才生效。
                  </p>
                ) : (
                  personas.map((persona) => {
                    return (
                      <div
                        key={persona.id}
                        className={`flex items-start gap-2 px-2 py-1.5 ${
                          selectedPersonaId === persona.id ? "row-selected" : "row-selectable"
                        }`}
                      >
                        {deleteMode ? (
                          <input
                            type="checkbox"
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded accent-destructive"
                            checked={pendingDelete.includes(persona.id)}
                            onChange={(event) =>
                              setPendingDelete((current) =>
                                event.target.checked
                                  ? [...current, persona.id]
                                  : current.filter((id) => id !== persona.id),
                              )
                            }
                          />
                        ) : null}
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setSelectedPersonaId(persona.id)}
                        >
                          <span className="block truncate text-caption text-foreground">{persona.label}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {[persona.fullName, persona.city, persona.country]
                              .map((item) => String(item ?? "").trim())
                              .filter(Boolean)
                              .join(" · ") || "未填写"}
                          </span>
                        </button>
                        {!deleteMode ? (
                          <button
                            type="button"
                            className="p-0.5 text-muted-foreground hover:text-destructive"
                            title="删除该人设"
                            onClick={() => {
                              void (async () => {
                                const ok = await confirm({
                                  title: "删除人设",
                                  description: `确定删除「${persona.label}」？`,
                                  confirmLabel: "删除",
                                  tone: "danger",
                                });
                                if (!ok) {
                                  return;
                                }
                                const next = personas.filter((item) => item.id !== persona.id);
                                await persistPersonas(next);
                                setSelectedPersonaId(next[0]?.id ?? null);
                              })();
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto rounded-md p-3">
              {!selectedPersona ? (
                <p className="text-[11px] text-muted-foreground">选择左侧一条人设开始编辑。</p>
              ) : (
                <div className="space-y-3">
                  <label className="field-label">
                    条目名称
                    <input
                      className="field-input"
                      value={selectedPersona.label}
                      onChange={(event) => patchPersona({ label: event.target.value })}
                      onBlur={handlePersonaLabelBlur}
                      placeholder="例如：美国-中年男A"
                    />
                  </label>

                  <div className="rounded-md bg-surface-muted p-2">
                    <p className="text-[10px] leading-4 text-muted-foreground">
                      代理出口 · {formatGeoHintLabel((ipGeo ?? null) as PersonaGeoHint | null)}
                    </p>
                    {geoConflicts.length > 0 ? (
                      <ul className="mt-1 space-y-0.5">
                        {geoConflicts.map((conflict) => (
                          <li key={conflict.field} className="text-[10px] leading-4 text-destructive">
                            {conflict.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] leading-4 text-muted-foreground">
                      固定字段：勾选的在本任务 / 回放被 @引用 时是权威值
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className="btn btn-outline h-6 px-2 text-[10px]"
                        title="把下面所有字段都勾为「固定」"
                        onClick={() => void toggleAllPersonaFields(true)}
                      >
                        全选固定
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline h-6 px-2 text-[10px]"
                        title="取消所有「固定」勾选"
                        onClick={() => void toggleAllPersonaFields(false)}
                      >
                        取消全部固定
                      </button>
                    </div>
                  </div>

                  {/* 单行字段表：字段名 · 值（就是输入框）· 固定。
                      不靠分割线分读，靠「输入框有实底 + 行距 + 固定态淡底」分读。 */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2.5 px-2 text-[10px] text-muted-foreground">
                      <span className="w-14 shrink-0">字段</span>
                      <span className="min-w-0 flex-1">值</span>
                      <span className="w-12 shrink-0 text-center">固定</span>
                    </div>
                    {PERSONA_FIELD_OPTIONS.map((option) => {
                      const fixed = personaEffectiveFixedFields(selectedPersona).includes(option.value);
                      const fieldKey = option.value as keyof AgentPersona;
                      const value = String(selectedPersona[fieldKey] ?? "");
                      return (
                        <div
                          key={option.value}
                          className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 ${
                            fixed
                              ? "bg-primary/10 ring-1 ring-inset ring-primary/35"
                              : "row-selectable"
                          }`}
                        >
                          <span className="w-14 shrink-0 text-caption text-muted-foreground">
                            {option.label}
                          </span>
                          {option.value === "gender" ? (
                            <select
                              className="field-input h-8 min-w-0 flex-1"
                              value={value}
                              onChange={(event) =>
                                patchPersona({ gender: event.target.value }, { commit: true })
                              }
                            >
                              <option value="">未指定</option>
                              <option value="male">男</option>
                              <option value="female">女</option>
                              <option value="other">其他</option>
                            </select>
                          ) : (
                            <input
                              className="field-input h-8 min-w-0 flex-1"
                              value={value}
                              placeholder={option.placeholder}
                              autoComplete="off"
                              onChange={(event) =>
                                patchPersona({ [fieldKey]: event.target.value } as Partial<AgentPersona>)
                              }
                              onBlur={() => commitEdits()}
                            />
                          )}
                          {option.value === "gender" ? (
                            <span className="w-12 shrink-0" aria-hidden="true" />
                          ) : (
                            <label
                              className="flex w-12 shrink-0 cursor-pointer select-none items-center justify-center gap-1 text-[11px] text-muted-foreground"
                              title="勾选后该字段在 @引用 时固定为这里的值，AI 不得改写"
                            >
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 rounded accent-primary"
                                checked={fixed}
                                onChange={() => void togglePersonaField(option.value)}
                              />
                            </label>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <p className="text-[10px] leading-4 text-muted-foreground">
                    任务 / 回放里 @引用 这套人设后，勾选「固定」的字段是权威值，AI 不得改写；未勾选的必填项由
                    AI 随机生成，地址与电话仍须与代理出口同城。没有 @ 时这套人设不会自动生效。
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2">
          <p className="truncate text-[10px] leading-4 text-muted-foreground">
            {rules.length} 条规则 · {personas.length} 套人设 · 都在输入框 / 回放目标里 @引用 才生效
          </p>
          <button type="button" className="btn btn-outline btn-compact h-7" onClick={handleClose}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}
