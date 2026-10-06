import type { RpaAction, RpaActionType } from "./types.js";

/** 解析 RPA 模板动作数组，向下兼容标准 JSON 模板 */
export function parseRpaActions(value: unknown): RpaAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const actions: RpaAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = String(record.type ?? "").trim() as RpaActionType;
    const selector = String(record.selector ?? "").trim();
    if (!selector || !["fill", "click", "select", "wait"].includes(type)) {
      continue;
    }
    actions.push({
      step: Number(record.step ?? actions.length + 1),
      type,
      selector,
      dataKey: record.dataKey ? String(record.dataKey) : undefined,
      value: record.value ? String(record.value) : undefined,
    });
  }

  return actions.map((action, index) => ({
    ...action,
    step: index + 1,
  }));
}

/** 解析 RPA 数据字典 */
export function parseRpaData(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const data: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }
    data[key] = String(entry);
  }
  return data;
}
