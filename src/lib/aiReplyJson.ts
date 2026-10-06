export function extractJsonFromAiReply(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidates = [fenced?.[1]?.trim(), trimmed].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/** 从 AI 回复或 sidecar 导出中提取可写入「原始填表数据」的 JSON 文本 */
export function formatFillDataForTextarea(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

export function extractFillDataTextFromReply(text: string): string | null {
  const parsed = extractJsonFromAiReply(text);
  if (!parsed) {
    return null;
  }
  return formatFillDataForTextarea(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 将 v2 元素导出 JSON 规范化为填表/RPA 可用的 payload */
export function normalizeFillInputForExecution(raw: string): {
  payload: string;
  profile: Record<string, string>;
  rpaActions: Array<{
    step: number;
    type: "fill" | "click" | "select" | "wait";
    selector: string;
    dataKey?: string;
    value?: string;
  }>;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { payload: trimmed, profile: {}, rpaActions: [] };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (isRecord(value)) {
      parsed = value;
    }
  } catch {
    return { payload: trimmed, profile: {}, rpaActions: [] };
  }

  if (!parsed) {
    return { payload: trimmed, profile: {}, rpaActions: [] };
  }

  const fillProfileSource = parsed.fillProfile ?? parsed.fillTemplate;
  if (isRecord(fillProfileSource) || Array.isArray(parsed.fillActions) || Array.isArray(parsed.elements)) {
    const profile: Record<string, string> = {};
    if (isRecord(fillProfileSource)) {
      for (const [key, entry] of Object.entries(fillProfileSource)) {
        if (entry !== undefined && entry !== null) {
          profile[key] = String(entry);
        }
      }
    }

    const rpaActions: Array<{
      step: number;
      type: "fill" | "click" | "select" | "wait";
      selector: string;
      dataKey?: string;
      value?: string;
    }> = [];

    const fillActions = Array.isArray(parsed.fillActions) ? parsed.fillActions : [];
    for (const entry of fillActions) {
      if (!isRecord(entry)) {
        continue;
      }
      const selector = String(entry.selector ?? "").trim();
      const field = String(entry.field ?? entry.key ?? "").trim();
      if (!selector || !field) {
        continue;
      }
      const actionRaw = String(entry.action ?? "fill")
        .trim()
        .toLowerCase();
      const type =
        actionRaw === "select" || actionRaw === "click" || actionRaw === "wait" ? actionRaw : "fill";
      rpaActions.push({
        step: rpaActions.length + 1,
        type,
        selector,
        dataKey: field,
        value: entry.value !== undefined && entry.value !== null ? String(entry.value) : profile[field],
      });
    }

    return {
      payload: formatFillDataForTextarea(parsed),
      profile,
      rpaActions,
    };
  }

  const flatProfile: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (entry !== undefined && entry !== null && typeof entry !== "object") {
      flatProfile[key] = String(entry);
    }
  }

  return {
    payload: formatFillDataForTextarea(parsed),
    profile: flatProfile,
    rpaActions: [],
  };
}

/** 将 @人设 固定字段并入填表载荷（前端合并，Host/Sidecar 无需改协议） */
export function mergePersonaFixedIntoFillInput(
  rawInput: string,
  personaFixed: Record<string, string>,
): string {
  const fixedKeys = Object.keys(personaFixed).filter((key) => String(personaFixed[key] ?? "").trim());
  if (fixedKeys.length === 0) {
    return rawInput;
  }
  const fixed: Record<string, string> = {};
  for (const key of fixedKeys) {
    fixed[key] = String(personaFixed[key]).trim();
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return formatFillDataForTextarea(fixed);
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (isRecord(value)) {
      parsed = value;
    }
  } catch {
    parsed = null;
  }

  if (parsed) {
    const hasV2 =
      parsed.version === 2 ||
      Array.isArray(parsed.fillActions) ||
      isRecord(parsed.fillProfile) ||
      isRecord(parsed.fillTemplate);
    if (hasV2) {
      const fillProfileSource = parsed.fillProfile ?? parsed.fillTemplate;
      const baseProfile: Record<string, string> = {};
      if (isRecord(fillProfileSource)) {
        for (const [key, entry] of Object.entries(fillProfileSource)) {
          if (entry !== undefined && entry !== null) {
            baseProfile[key] = String(entry);
          }
        }
      }
      const mergedProfile = { ...baseProfile, ...fixed };
      const next: Record<string, unknown> = {
        ...parsed,
        fillProfile: mergedProfile,
        fillTemplate: mergedProfile,
      };
      if (Array.isArray(parsed.fillActions)) {
        next.fillActions = parsed.fillActions.map((entry) => {
          if (!isRecord(entry)) {
            return entry;
          }
          const field = String(entry.field ?? entry.key ?? "").trim();
          if (!field || !mergedProfile[field]) {
            return entry;
          }
          return { ...entry, value: mergedProfile[field] };
        });
      }
      return formatFillDataForTextarea(next);
    }

    const flat: Record<string, unknown> = { ...parsed, ...fixed };
    return formatFillDataForTextarea(flat);
  }

  const { profile } = normalizeFillInputForExecution(trimmed);
  const merged = { ...profile, ...fixed };
  return Object.entries(merged)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}
