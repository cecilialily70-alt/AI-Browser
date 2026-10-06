import type { FormSchemaField, PageFormSchema } from "./dom_parser.js";
import type { RpaAction } from "./rpa_engine.js";

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildFieldSelector(field: FormSchemaField): string | null {
  const id = field.id?.trim();
  if (id) {
    return `[id="${escapeAttributeValue(id)}"]`;
  }

  const name = field.name?.trim();
  if (name) {
    return `[name="${escapeAttributeValue(name)}"]`;
  }

  return null;
}

function resolveDataKey(
  field: FormSchemaField,
  fallbackIndex: number,
  profile?: Record<string, string>,
): string {
  const profileKeys = profile ? Object.keys(profile) : [];
  const profileValues = new Set(
    profile ? Object.values(profile).map((value) => value.trim()).filter(Boolean) : [],
  );

  const name = field.name?.trim();
  const id = field.id?.trim();
  const label = field.label?.trim();

  if (name && profileKeys.includes(name)) {
    return name;
  }
  if (id && profileKeys.includes(id)) {
    return id;
  }

  if (name && profileValues.has(name)) {
    const matchedKey = profileKeys.find((key) => profile?.[key]?.trim() === name);
    if (matchedKey) {
      return matchedKey;
    }
  }

  if (label) {
    const labelKey = profileKeys.find(
      (key) => key.toLowerCase() === label.toLowerCase() || label.toLowerCase().includes(key.toLowerCase()),
    );
    if (labelKey) {
      return labelKey;
    }
  }

  if (name && !profileValues.has(name)) {
    return name;
  }
  if (id && !profileValues.has(id)) {
    return id;
  }

  return `field_${fallbackIndex}`;
}

export function schemaToRpaActions(
  schema: PageFormSchema,
  startStep = 1,
  profile?: Record<string, string>,
): RpaAction[] {
  const actions: RpaAction[] = [];
  let step = startStep;

  for (const field of schema.fields) {
    if (field.hidden || field.likelyDynamic || !field.visible) {
      continue;
    }

    const selector = buildFieldSelector(field);
    if (!selector) {
      continue;
    }

    const dataKey = resolveDataKey(field, step, profile);
    if (field.tag === "select") {
      actions.push({
        step,
        type: "select",
        selector,
        dataKey,
      });
    } else if (field.type === "checkbox" || field.type === "radio") {
      actions.push({
        step,
        type: "click",
        selector,
        dataKey,
      });
    } else {
      actions.push({
        step,
        type: "fill",
        selector,
        dataKey,
      });
    }
    step += 1;
  }

  return actions;
}
