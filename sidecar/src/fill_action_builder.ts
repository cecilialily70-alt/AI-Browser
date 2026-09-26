import type { FillAction, FillProfile } from "./engine.js";
import type { RpaAction } from "./rpa/types.js";
import type { VisibleUsableElementRow } from "./interactive_elements.js";

export function rowToFillAction(row: VisibleUsableElementRow, value = ""): FillAction {
  return {
    field: row.key,
    selector: row.selector,
    xpath: row.xpath,
    action: row.action === "click" ? "click" : row.action === "select" ? "select" : "fill",
    value,
  };
}

export function buildFillActionsFromRows(
  rows: VisibleUsableElementRow[],
  profile: FillProfile = {},
  options?: { fillableOnly?: boolean },
): FillAction[] {
  const fillableOnly = options?.fillableOnly ?? false;
  const actions: FillAction[] = [];
  for (const row of rows) {
    if (fillableOnly && row.category !== "fillable") {
      continue;
    }
    if (row.category === "link" || row.category === "other") {
      continue;
    }
    actions.push(rowToFillAction(row, profile[row.key] ?? row.value ?? ""));
  }
  return actions;
}

export function mergeProfileIntoFillActions(
  actions: FillAction[],
  profile: FillProfile,
): FillAction[] {
  return actions.map((action) => ({
    ...action,
    value: profile[action.field] ?? action.value ?? "",
  }));
}

export function fillActionsToRpaActions(actions: FillAction[]): RpaAction[] {
  const rpaActions: RpaAction[] = [];
  for (const action of actions) {
    const selector = action.selector?.trim() || action.xpath?.trim();
    if (!selector || !action.field) {
      continue;
    }
    const normalizedSelector = selector.startsWith("xpath=") || selector.startsWith("/")
      ? selector.startsWith("xpath=")
        ? selector
        : `xpath=${selector}`
      : selector;
    const type =
      action.action === "select" ? "select" : action.action === "click" ? "click" : "fill";
    rpaActions.push({
      step: rpaActions.length + 1,
      type,
      selector: normalizedSelector,
      dataKey: action.field,
      value: action.value,
    });
  }
  return rpaActions;
}
