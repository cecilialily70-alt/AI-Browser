import type { FillAction, FillProfile } from "./engine.js";
import type { InteractiveElementSnapshot } from "./interactive_elements.js";
import {
  buildFillActionsFromRows,
  mergeProfileIntoFillActions,
} from "./fill_action_builder.js";
import {
  buildSlimFillExportJson,
  type VisibleUsableElementRow,
} from "./interactive_elements.js";

export const FILL_EXPORT_VERSION = 2 as const;

export interface FillReadyExport {
  version: typeof FILL_EXPORT_VERSION;
  url: string;
  extractedAt: string;
  summary?: {
    total?: number;
    visibleUnique?: number;
    hiddenOrInvisible?: number;
    fillableCount?: number;
    buttonCount?: number;
    linkCount?: number;
    otherCount?: number;
    exportedCount?: number;
    fillable?: number;
    buttons?: number;
    skippedHidden?: number;
  };
  /** 填表键值（key = name/id/selector），可直接传给填表引擎 */
  fillProfile: Record<string, string>;
  /** 与 fillProfile 相同，兼容旧导出 */
  fillTemplate?: Record<string, string>;
  elements?: VisibleUsableElementRow[];
  /** 含 selector 的预构建动作，填值后可直接执行 */
  fillActions: FillAction[];
  /** v2 精简字段元数据（label/tag/type），便于 LLM 映射 */
  fields?: Array<{
    key: string;
    label: string | null;
    tag: string;
    type: string | null;
    action: "fill" | "select" | "click";
  }>;
}

export interface ParsedFillInput {
  profile: FillProfile;
  actions: FillAction[] | null;
  exportPayload: FillReadyExport | null;
}

function normalizeProfile(value: unknown): FillProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const profile: FillProfile = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }
    profile[key] = String(entry);
  }
  return profile;
}

function parseKeyValueLines(raw: string): FillProfile {
  const profile: FillProfile = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([^:=\t]+)\s*[:=\t]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key && value) {
      profile[key] = value;
    }
  }
  return profile;
}

/** 由元素快照生成可直接填表的 v2 导出结构（仅可填字段） */
export function buildFillReadyExportJson(snapshot: InteractiveElementSnapshot): FillReadyExport {
  return buildSlimFillExportJson(snapshot);
}

function parseFillActionRows(value: unknown): FillAction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const actions: FillAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const field = String(row.field ?? row.key ?? "").trim();
    const selector = String(row.selector ?? "").trim();
    if (!field || !selector) {
      continue;
    }
    const actionRaw = String(row.action ?? "fill").trim().toLowerCase();
    const action =
      actionRaw === "select" || actionRaw === "click" || actionRaw === "check"
        ? actionRaw
        : "fill";
    actions.push({
      field,
      selector,
      xpath: row.xpath ? String(row.xpath) : undefined,
      action,
      value: row.value !== undefined && row.value !== null ? String(row.value) : undefined,
    });
  }
  return actions;
}

function upgradeLegacyExport(obj: Record<string, unknown>): FillReadyExport | null {
  if (!Array.isArray(obj.elements)) {
    return null;
  }
  const elements = obj.elements as VisibleUsableElementRow[];
  if (elements.length === 0 || typeof elements[0] !== "object") {
    return null;
  }
  const fillProfile = normalizeProfile(obj.fillProfile ?? obj.fillTemplate ?? {});
  const fillActions = parseFillActionRows(obj.fillActions);
  const resolvedActions =
    fillActions.length > 0
      ? fillActions
      : buildFillActionsFromRows(elements, fillProfile, { fillableOnly: true });

  return {
    version: FILL_EXPORT_VERSION,
    url: String(obj.url ?? ""),
    extractedAt: String(obj.extractedAt ?? ""),
    summary: (obj.summary as FillReadyExport["summary"]) ?? {
      total: elements.length,
      visibleUnique: elements.length,
      hiddenOrInvisible: 0,
      fillableCount: elements.filter((row) => row.category === "fillable").length,
      buttonCount: 0,
      linkCount: 0,
      otherCount: 0,
      exportedCount: elements.length,
    },
    fillProfile,
    fillTemplate: fillProfile,
    elements,
    fillActions: resolvedActions,
  };
}

/** 解析「原始填表数据」：支持 v2 导出、v1 导出、纯键值 JSON、key: value 行 */
export function parseFillInput(raw: string): ParsedFillInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { profile: {}, actions: null, exportPayload: null };
  }

  if (!trimmed.startsWith("{")) {
    return { profile: parseKeyValueLines(trimmed), actions: null, exportPayload: null };
  }

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { profile: {}, actions: null, exportPayload: null };
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return { profile: parseKeyValueLines(trimmed), actions: null, exportPayload: null };
  }

  if (parsed.version === 2 && Array.isArray(parsed.fillActions)) {
    const fillProfile = normalizeProfile(parsed.fillProfile ?? parsed.fillTemplate);
    const fillActions = parseFillActionRows(parsed.fillActions);
    const mergedActions = mergeProfileIntoFillActions(fillActions, fillProfile);
    const exportPayload: FillReadyExport = {
      version: FILL_EXPORT_VERSION,
      url: String(parsed.url ?? ""),
      extractedAt: String(parsed.extractedAt ?? ""),
      summary: (parsed.summary as FillReadyExport["summary"]) ?? undefined,
      fillProfile,
      fillTemplate: fillProfile,
      fields: Array.isArray(parsed.fields)
        ? (parsed.fields as FillReadyExport["fields"])
        : undefined,
      fillActions: mergedActions,
    };
    return { profile: fillProfile, actions: mergedActions, exportPayload };
  }

  const exportPayload = upgradeLegacyExport(parsed);
  if (exportPayload) {
    const profile = { ...exportPayload.fillProfile, ...normalizeProfile(parsed.fillProfile ?? parsed.fillTemplate) };
    const actions = mergeProfileIntoFillActions(exportPayload.fillActions, profile);
    return { profile, actions, exportPayload: { ...exportPayload, fillProfile: profile, fillTemplate: profile } };
  }

  const flat = normalizeProfile(parsed);
  const hasMetaKeys = ["elements", "fillActions", "fillTemplate", "fillProfile", "fields", "url", "summary"].some(
    (key) => key in parsed,
  );
  if (!hasMetaKeys) {
    return { profile: flat, actions: null, exportPayload: null };
  }

  return { profile: flat, actions: null, exportPayload: null };
}

export function applyProfileToExport(
  exportPayload: FillReadyExport,
  profile: FillProfile,
): FillReadyExport {
  const mergedProfile = { ...exportPayload.fillProfile, ...profile };
  return {
    ...exportPayload,
    fillProfile: mergedProfile,
    fillTemplate: mergedProfile,
    fillActions: mergeProfileIntoFillActions(exportPayload.fillActions, mergedProfile),
    ...(exportPayload.elements
      ? {
          elements: exportPayload.elements.map((row) => ({
            ...row,
            value: mergedProfile[row.key] ?? row.value ?? "",
          })),
        }
      : {}),
  };
}
