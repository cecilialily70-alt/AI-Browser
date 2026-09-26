import type { Page } from "playwright-core";

export interface FormSchemaField {
  id: string | null;
  name: string | null;
  type: string;
  label: string | null;
  tag: "input" | "select" | "textarea";
  hidden: boolean;
  visible: boolean;
  /** name/id 含 token、hash、signature 等字眼，通常由 JS 动态写入，不应放入常规填表模板 */
  likelyDynamic: boolean;
}

export interface PageFormSchema {
  url: string;
  fields: FormSchemaField[];
}

const EXTRACT_FORM_SCHEMA_SCRIPT = () => {
  function cleanText(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
  }

  function resolveLabel(element: HTMLElement): string | null {
    const chunks: string[] = [];

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const labels = element.labels;
      if (labels) {
        for (const label of Array.from(labels)) {
          const text = cleanText(label.textContent);
          if (text) {
            chunks.push(text);
          }
        }
      }
    }

    const elementId = element.id.trim();
    if (elementId) {
      const linkedLabel = document.querySelector(`label[for="${CSS.escape(elementId)}"]`);
      const linkedText = cleanText(linkedLabel?.textContent ?? null);
      if (linkedText) {
        chunks.push(linkedText);
      }
    }

    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      chunks.push(ariaLabel);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        const text = cleanText(node?.textContent ?? null);
        if (text) {
          chunks.push(text);
        }
      }
    }

    const parentLabel = element.closest("label");
    if (parentLabel) {
      const text = cleanText(parentLabel.textContent);
      if (text) {
        chunks.push(text);
      }
    }

    const deduped = Array.from(new Set(chunks));
    return deduped.length > 0 ? deduped.join(" | ") : null;
  }

  function isVisible(element: HTMLElement): boolean {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isLikelyDynamicField(id: string | null, name: string | null): boolean {
    const combined = `${id ?? ""} ${name ?? ""}`.toLowerCase();
    return /(?:^|[_-])(token|hash|signature|nonce|captcha|csrf|authenticity)(?:$|[_-])/.test(
      combined,
    );
  }

  const results: Array<{
    id: string | null;
    name: string | null;
    type: string;
    label: string | null;
    tag: "input" | "select" | "textarea";
    hidden: boolean;
    visible: boolean;
    likelyDynamic: boolean;
  }> = [];

  const elements = Array.from(document.querySelectorAll("input, select, textarea"));

  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") {
      continue;
    }

    let type: string;
    if (element instanceof HTMLInputElement) {
      type = element.type || "text";
    } else if (element instanceof HTMLSelectElement) {
      type = element.multiple ? "select-multiple" : "select-one";
    } else {
      type = "textarea";
    }

    const htmlElement = element as HTMLElement;
    const id = cleanText(element.id) ?? null;
    const name = cleanText(element.getAttribute("name")) ?? null;
    const hidden = type === "hidden" || element.getAttribute("type") === "hidden";
    const visible = isVisible(htmlElement);

    results.push({
      id,
      name,
      type,
      label: resolveLabel(htmlElement),
      tag,
      hidden,
      visible,
      likelyDynamic: isLikelyDynamicField(id, name),
    });
  }

  return results;
};

export async function extractPageFormSchema(page: Page): Promise<PageFormSchema> {
  const fields: FormSchemaField[] = [];

  for (const frame of page.frames()) {
    const frameFields = await frame.evaluate(EXTRACT_FORM_SCHEMA_SCRIPT);
    fields.push(...frameFields);
  }

  return {
    url: page.url(),
    fields,
  };
}
