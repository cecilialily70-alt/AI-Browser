/**
 * 从 Markdown 代码围栏中提取内容（无围栏时返回原文 trim）。
 * 统一正则：容忍 ```json 大小写、围栏与闭合 ``` 前后的空白。
 * 与各处内联 `/```(?:json)?\s*([\s\S]*?)\s*```/i` 在 trim 后结果一致。
 */
export function stripFencedJson(text: string): string {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * 从 LLM 回复或原始文本中提取 JSON 对象。
 */
export function parseJsonObjectFromText(raw: string): Record<string, string> {
  const candidate = stripFencedJson(raw);
  const parsed = JSON.parse(candidate) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}
