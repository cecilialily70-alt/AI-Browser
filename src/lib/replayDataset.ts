/**
 * 回放数据集（Dataset）—— 前端解析 / 生成 / 字段映射。
 *
 * 与 Sidecar 侧 `core/dataset_parse.ts` **同源同规则**（两边独立实现，因为前端与 sidecar 是
 * 两个 TS 工程）；任何规则改动必须两边同步，否则会出现「前端说能跑、后端拒收」。
 *
 * 与后端的唯一差别：前端**不计算 hash** —— 内容指纹由 Host/`/v1/replay/plan` 权威计算并回传，
 * 避免「前端自算的 hash」与「服务端重算的 hash」两套真相（§4.6.7 明确要求不要自己拼 hash）。
 *
 * 另：**红线校验（列名命中凭证词表 → 拒收）只在服务端做**（`core/dataset_parse.ts`），
 * 前端不做凭证判定 —— 否则同一份数据会出现「前端说能跑、后端拒收」两套结论。
 */
import type { SandboxFormField } from "../types";

export const DATASET_MAX_ROWS = 2000;
export const DATASET_MAX_VALUE_CHARS = 4096;

export type DatasetFormat = "json" | "jsonl" | "csv" | "tsv" | "txt" | "clipboard";

export interface DatasetRow {
  [column: string]: string;
}

export interface ParsedDataset {
  format: DatasetFormat;
  rows: DatasetRow[];
  columns: string[];
  warnings: string[];
}

export type DatasetParseResult =
  | { ok: true; dataset: ParsedDataset }
  | { ok: false; error: string; line?: number; column?: number };

export interface ParseDatasetOptions {
  format?: DatasetFormat | null;
  source?: "inline" | "file" | "clipboard" | null;
}

const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g;
/** 单列数据集（TXT / 剪贴板）的默认列名 */
export const DATASET_TEXT_COLUMN = "text";
const SINGLE_COLUMN = DATASET_TEXT_COLUMN;

/** 列名归一化：去零宽字符、折叠空白、去首尾空白（与 Sidecar 一致） */
export function normalizeColumnName(raw: string): string {
  return String(raw ?? "")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

function fail(error: string, line?: number, column?: number): DatasetParseResult {
  return { ok: false, error, ...(line != null ? { line } : {}), ...(column != null ? { column } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateColumns(rawColumns: string[]): { columns: string[] } | { error: string } {
  const columns: string[] = [];
  const seen = new Map<string, string>();
  for (const raw of rawColumns) {
    const column = normalizeColumnName(raw);
    if (!column) return { error: "存在空列名：请给每列一个名字" };
    const key = column.toLowerCase();
    if (seen.has(key)) return { error: `列名重复：「${column}」与「${seen.get(key)}」归一化后相同` };
    seen.set(key, column);
    columns.push(column);
  }
  if (columns.length === 0) return { error: "数据集没有任何列" };
  return { columns };
}

function validateRowCount(count: number): string | null {
  if (count === 0) return "数据集没有任何数据行";
  if (count > DATASET_MAX_ROWS) return `数据行数 ${count} 超过上限 ${DATASET_MAX_ROWS}`;
  return null;
}

function checkValueLength(value: string, rowLabel: string, column: string): string | null {
  if (value.length > DATASET_MAX_VALUE_CHARS) {
    return `${rowLabel}的列「${column}」值长度 ${value.length} 超过上限 ${DATASET_MAX_VALUE_CHARS}`;
  }
  return null;
}

export function datasetFromRows(
  rawRows: unknown[],
  options: { format?: DatasetFormat } = {},
): DatasetParseResult {
  const objects: Array<Record<string, unknown>> = [];
  for (let index = 0; index < rawRows.length; index += 1) {
    const entry = rawRows[index];
    if (!isPlainObject(entry)) {
      return fail(`第 ${index + 1} 行不是对象（需要 {"列名": "值"} 形式）`, index + 1);
    }
    objects.push(entry);
  }

  const rawColumns: string[] = [];
  for (const entry of objects) {
    for (const key of Object.keys(entry)) {
      if (!rawColumns.includes(key)) rawColumns.push(key);
    }
  }

  const columnCheck = validateColumns(rawColumns);
  if ("error" in columnCheck) return fail(columnCheck.error);
  const columns = columnCheck.columns;

  const rows: DatasetRow[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    const entry = objects[index]!;
    const row: DatasetRow = {};
    for (const rawKey of Object.keys(entry)) {
      const column = normalizeColumnName(rawKey);
      const value = entry[rawKey];
      const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
      const tooLong = checkValueLength(text, `第 ${index + 1} 行`, column);
      if (tooLong) return fail(tooLong, index + 1, columns.indexOf(column) + 1);
      row[column] = text;
    }
    for (const column of columns) {
      if (!(column in row)) row[column] = "";
    }
    rows.push(row);
  }

  const countError = validateRowCount(rows.length);
  if (countError) return fail(countError);

  return { ok: true, dataset: { format: options.format ?? "json", rows, columns, warnings: [] } };
}

function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * 列式 JSON → 行式：`{ "name": ["刘亦菲","张三"], "city": ["北京","上海"] }` 转置成两行。
 *
 * 多变量且「每个变量一列值」是最贴近「定义变量」直觉的写法，所以支持这种入口；
 * 列长不一致时短的补空串，行数按最长列（**不静默丢数据**，多余部分原样保留）。
 */
function transposeColumnObject(record: Record<string, unknown>): unknown[] {
  const keys = Object.keys(record);
  const length = keys.reduce((max, key) => {
    const value = record[key];
    return Array.isArray(value) ? Math.max(max, value.length) : max;
  }, 0);
  const rows: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const row: Record<string, unknown> = {};
    for (const key of keys) {
      const value = record[key];
      row[key] = Array.isArray(value) ? (value[index] ?? "") : value;
    }
    rows.push(row);
  }
  return rows;
}

function tryParseJsonObjectRows(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!isPlainObject(parsed)) return null;
  // `{ "rows": [...] }` / `{ "data": [...] }` 优先（显式命名，不参与下面的猜测）
  for (const key of ["rows", "data"]) {
    const value = parsed[key];
    if (Array.isArray(value)) return value;
  }
  const values = Object.values(parsed);
  if (values.length === 0) return null;
  // 列式：任一列是数组 → 按列转置成多行（多变量多轮）
  if (values.some((value) => Array.isArray(value))) return transposeColumnObject(parsed);
  // 单对象且值都是标量 → 一行（`{"name":"刘亦菲"}` 定义一组变量、跑一轮）
  if (values.every((value) => value == null || typeof value !== "object")) return [parsed];
  return null;
}

function isDelimited(text: string): "csv" | "tsv" | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const tabCount = (lines[0]!.match(/\t/g) ?? []).length;
  const commaCount = (lines[0]!.match(/,/g) ?? []).length;
  if (tabCount > 0 && tabCount >= commaCount) return "tsv";
  if (commaCount > 0) return "csv";
  return null;
}

/** 解析文本数据集：json → jsonl → csv/tsv → txt（与 Sidecar 同序） */
export function parseDatasetText(text: string, options: ParseDatasetOptions = {}): DatasetParseResult {
  const raw = String(text ?? "");
  if (raw.trim().length === 0) return fail("数据集内容为空");

  const physicalLines = raw.split(/\r?\n/);
  const format = options.format ?? null;

  const tryJson = (): DatasetParseResult | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const rows = tryParseJsonObjectRows(parsed);
    if (!rows) return null;
    return datasetFromRows(rows, { format: "json" });
  };

  const tryJsonl = (strict: boolean): DatasetParseResult | null => {
    const entries: unknown[] = [];
    const lineNumbers: number[] = [];
    let objectCount = 0;
    for (let index = 0; index < physicalLines.length; index += 1) {
      const line = physicalLines[index]!;
      if (line.trim() === "") continue;
      try {
        const value = JSON.parse(line);
        entries.push(value);
        if (isPlainObject(value)) objectCount += 1;
        lineNumbers.push(index + 1);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 已出现过 JSON 对象 ⇒ 用户确实在给 JSONL，某行坏了就报出行号；
        // 一行 JSON 对象都没有 ⇒ 不是 JSONL，交给后面的 CSV/TXT。
        if (strict || objectCount > 0) {
          return fail(`第 ${index + 1} 行不是合法 JSON：${detail}`, index + 1);
        }
        return null;
      }
    }
    if (entries.length === 0) return null;
    if (!entries.every((entry) => isPlainObject(entry))) return null;
    const result = datasetFromRows(entries, { format: "jsonl" });
    if (result.ok) return result;
    if (!result.ok && result.line != null && lineNumbers[result.line - 1] != null) {
      return { ...result, line: lineNumbers[result.line - 1] };
    }
    return result;
  };

  const tryDelimited = (delimiter: "csv" | "tsv"): DatasetParseResult | null => {
    const dataLines: Array<{ text: string; line: number }> = [];
    for (let index = 0; index < physicalLines.length; index += 1) {
      const line = physicalLines[index]!;
      if (line.trim() === "") continue;
      dataLines.push({ text: line, line: index + 1 });
    }
    if (dataLines.length < 2) return null;
    const separator = delimiter === "csv" ? "," : "\t";
    const header = splitDelimited(dataLines[0]!.text, separator);
    const columnCheck = validateColumns(header);
    if ("error" in columnCheck) return fail(columnCheck.error, dataLines[0]!.line);
    const columns = columnCheck.columns;

    const rows: DatasetRow[] = [];
    for (let index = 1; index < dataLines.length; index += 1) {
      const entry = dataLines[index]!;
      const cells = splitDelimited(entry.text, separator);
      if (cells.length !== columns.length) {
        return fail(
          `第 ${entry.line} 行列数 ${cells.length} 与表头列数 ${columns.length} 不一致`,
          entry.line,
          Math.min(cells.length, columns.length) + 1,
        );
      }
      const row: DatasetRow = {};
      for (let c = 0; c < columns.length; c += 1) {
        const value = cells[c] ?? "";
        const tooLong = checkValueLength(value, `第 ${entry.line} 行`, columns[c]!);
        if (tooLong) return fail(tooLong, entry.line, c + 1);
        row[columns[c]!] = value;
      }
      rows.push(row);
    }
    const countError = validateRowCount(rows.length);
    if (countError) return fail(countError);
    return { ok: true, dataset: { format: delimiter, rows, columns, warnings: [] } };
  };

  const tryTxt = (): DatasetParseResult => {
    const rows: DatasetRow[] = [];
    for (let index = 0; index < physicalLines.length; index += 1) {
      const line = physicalLines[index]!;
      if (line.trim() === "") continue;
      const tooLong = checkValueLength(line, `第 ${index + 1} 行`, SINGLE_COLUMN);
      if (tooLong) return fail(tooLong, index + 1, 1);
      rows.push({ [SINGLE_COLUMN]: line });
    }
    const countError = validateRowCount(rows.length);
    if (countError) return fail(countError);
    return {
      ok: true,
      dataset: {
        format: options.source === "clipboard" ? "clipboard" : "txt",
        rows,
        columns: [SINGLE_COLUMN],
        warnings: [],
      },
    };
  };

  switch (format) {
    case "json":
      return (
        tryJson() ??
        fail(
          '不是合法的 JSON 数据集（需要 [{"列":"值"}]、{"rows":[…] }、单对象 {"列":"值"} 或列式 {"列":["值1","值2"]}）',
        )
      );
    case "jsonl":
      return tryJsonl(true) ?? fail("不是合法的 JSONL（每行一个 JSON 对象，且至少两行）");
    case "csv":
      return tryDelimited("csv") ?? fail("CSV 至少需要表头 + 1 行数据，且列数一致");
    case "tsv":
      return tryDelimited("tsv") ?? fail("TSV 至少需要表头 + 1 行数据，且列数一致");
    case "txt":
      return tryTxt();
    case "clipboard":
      return tryTxt();
    default:
      break;
  }

  const json = tryJson();
  if (json) return json;
  const jsonl = tryJsonl(false);
  if (jsonl) return jsonl;
  const delimited = isDelimited(raw);
  if (delimited) {
    const result = tryDelimited(delimited);
    if (result) return result;
  }
  return tryTxt();
}

/* ------------------------------------------------------------------ *
 * 「生成 JSON」：从当前轨迹反推字段，生成骨架（自带唯一序号占位）
 * ------------------------------------------------------------------ */

/** 取选择器里最有信息量的标识（`#email` → `email`、`input[name=phone]` → `phone`） */
function selectorHint(key: string): string {
  const raw = String(key ?? "").trim();
  if (!raw) return "";
  const attr = /\[(?:name|id|placeholder)=["']?([^"'\]]+)/i.exec(raw);
  if (attr?.[1]) return attr[1];
  const idOrClass = /[#.]([A-Za-z_][\w-]*)/.exec(raw);
  if (idOrClass?.[1]) return idOrClass[1];
  return raw.replace(/^xpath=/, "").slice(0, 24);
}

/** 安全转成可用作 JSON 键的列名 */
function toColumnName(value: string, index: number): string {
  const cleaned = normalizeColumnName(value)
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || `field${index + 1}`;
}

/**
 * 生成 JSON 骨架：每行都用 `{{run.uniqueId}}` 兜住唯一性（§5.7「推荐用法」）。
 * 这是**护栏**，不靠模型自觉 —— 即使下游生成能力再飘，唯一性由序号保证。
 */
export function generateDatasetSkeleton(fields: SandboxFormField[], count = 5): string {
  const safeCount = Math.max(1, Math.min(Math.trunc(count) || 1, DATASET_MAX_ROWS));
  const used = new Set<string>();
  const columns = fields.map((field, index) => {
    const base = toColumnName(selectorHint(field.key) || field.label || `field${index + 1}`, index);
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return name;
  });
  const rows = Array.from({ length: safeCount }, (_row, rowIndex) => {
    const entry: Record<string, string> = {};
    columns.forEach((column) => {
      entry[column] = `{{run.seq}}-${rowIndex + 1}-${column}`;
    });
    return entry;
  });
  return JSON.stringify(rows, null, 2);
}

/* ------------------------------------------------------------------ *
 * 字段映射：数据集列 → 轨迹字段（自动匹配 + 手动覆盖）
 * ------------------------------------------------------------------ */

function normalizeForMatch(value: string): string {
  return String(value ?? "")
    .replace(/[\s\u3000_-]+/g, "")
    .toLowerCase();
}

/** 二元组 Dice 相似度（与 Sidecar `core/text_match.ts` 同一算法） */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, count] of ga) {
    const other = gb.get(g);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

const AUTO_MATCH_MIN_SCORE = 0.5;
/**
 * 自动映射：列名与字段的可引用文案做归一化精确/包含匹配，退路用 Dice 相似度。
 * 返回 `{ 字段 key: 列名 }`；未匹配的字段不出现在结果里（UI 提示「未映射」）。
 *
 * `rows` 可选：给了就在**列名匹配之前**先跑一轮「录制值命中」——
 * 用户上传的往往就是当初录制的那份值（如「刘亦菲」），列名叫什么都能一眼绑对。
 */
export function autoMapColumns(
  columns: string[],
  fields: SandboxFormField[],
  rows?: DatasetRow[],
): Record<string, string> {
  const remaining = new Set(columns);
  const out: Record<string, string> = {};

  const candidatesFor = (field: SandboxFormField): string[] =>
    [field.label, selectorHint(field.key), field.key.replace(/^xpath=/, "")].filter(Boolean);

  // 第零轮：录制值直接命中（最强信号，优先于任何列名猜测）
  if (rows && rows.length > 0) {
    for (const field of fields) {
      const recorded = String(field.recordedValue ?? "").trim();
      if (recorded.length < 2) continue;
      const column = [...remaining].find((item) =>
        rows.some((row) => String(row[item] ?? "").trim() === recorded),
      );
      if (column) {
        out[field.key] = column;
        remaining.delete(column);
      }
    }
  }

  // 第一轮：精确匹配（归一化后相等）
  for (const field of fields) {
    for (const candidate of candidatesFor(field)) {
      const target = normalizeForMatch(candidate);
      const column = [...remaining].find((item) => normalizeForMatch(item) === target);
      if (column) {
        out[field.key] = column;
        remaining.delete(column);
        break;
      }
    }
  }
  // 第二轮：包含匹配
  for (const field of fields) {
    if (out[field.key]) continue;
    for (const candidate of candidatesFor(field)) {
      const target = normalizeForMatch(candidate);
      if (target.length < 2) continue;
      const column = [...remaining].find((item) => {
        const norm = normalizeForMatch(item);
        return norm.includes(target) || target.includes(norm);
      });
      if (column) {
        out[field.key] = column;
        remaining.delete(column);
        break;
      }
    }
  }
  // 第三轮：相似度
  for (const field of fields) {
    if (out[field.key]) continue;
    let best: { column: string; score: number } | null = null;
    for (const candidate of candidatesFor(field)) {
      const target = normalizeForMatch(candidate);
      if (!target) continue;
      for (const column of remaining) {
        const score = diceSimilarity(target, normalizeForMatch(column));
        if (score >= AUTO_MATCH_MIN_SCORE && (!best || score > best.score)) {
          best = { column, score };
        }
      }
    }
    if (best) {
      out[field.key] = best.column;
      remaining.delete(best.column);
    }
  }

  // 兜底：只有一列、也只有一个字段 —— 无论列名叫什么（TXT 默认是 `text`）都直接绑上。
  // 这是「上传一份单变量数据就能跑」的关键：不然用户还得手点一次映射。
  if (columns.length === 1 && fields.length === 1 && !out[fields[0]!.key]) {
    out[fields[0]!.key] = columns[0]!;
  }
  return out;
}

/** 把行序列化成 JSON 文本（表格手动编辑后用；保持「文本域 = 所见即所得」） */
export function serializeDatasetRows(rows: DatasetRow[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * 重命名列（改「变量名」）：同时改写每一行的键与字段映射，避免出现「列名改了、值丢了」。
 * 同名或空名直接返回原值（由调用方提示），不静默改坏数据。
 */
export function renameDatasetColumn(
  draft: Pick<ParsedDataset, "rows" | "columns">,
  columnMap: Record<string, string>,
  from: string,
  to: string,
): { rows: DatasetRow[]; columns: string[]; columnMap: Record<string, string> } | null {
  const next = normalizeColumnName(to);
  if (!next || next === from) return null;
  if (draft.columns.some((column) => column !== from && column.toLowerCase() === next.toLowerCase())) {
    return null;
  }
  const rows = draft.rows.map((row) => {
    const out: DatasetRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === from) out[next] = value;
      else out[key] = value;
    }
    return out;
  });
  const columnMap2 = { ...columnMap };
  for (const [fieldKey, column] of Object.entries(columnMap2)) {
    if (column === from) columnMap2[fieldKey] = next;
  }
  return {
    rows,
    columns: draft.columns.map((column) => (column === from ? next : column)),
    columnMap: columnMap2,
  };
}

/** 图表用的可读预览：`email=user0@b.com · name=测试0` */
export function previewRow(row: DatasetRow, columns: string[], maxColumns = 2): string {
  return columns
    .slice(0, maxColumns)
    .map((column) => `${column}=${String(row[column] ?? "")}`)
    .join(" · ");
}
