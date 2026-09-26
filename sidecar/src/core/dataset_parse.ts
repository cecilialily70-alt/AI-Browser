/**
 * 回放数据集（Dataset）解析器 —— Sidecar 侧「同源校验」。
 *
 * 数据集 = 一批行（列名 → 值），供多环境 × 多轮次回放分配使用（执行计划.md §4.3）。
 *
 * 解析纪律（宁可不开跑，也不半解析后用错数据）：
 *   - 解析失败 → 明确报出**第几行第几列**，绝不半解析后放行；
 *   - 列名做归一化（折叠空白、去零宽字符），**值保持原样字符串**（搬运类数据不许被改写）；
 *   - 空行跳过；归一化后重复的列名报错；
 *   - 单值长度上限 4096 字符（与 `/v1/fill` 同口径）、行数上限 2000；
 *   - **R1.3 / R2**：列名命中支付/证件/密钥或一次性凭证词表 → 整份拒绝（数据集会落盘）。
 *
 * 词典来自 `config/*.json`（配置，不是代码）；代码里不含任何站点文案。
 */
import { createHash } from "node:crypto";

import { classifyExternalFillFieldName } from "./external_fill_gate.js";
import { loadHumanCredentialLexicon } from "./human_credential.js";

/** 行数上限（执行计划.md §4.3） */
export const DATASET_MAX_ROWS = 2000;
/** 单值长度上限（与 /v1/fill 同口径） */
export const DATASET_MAX_VALUE_CHARS = 4096;

export type DatasetFormat = "json" | "jsonl" | "csv" | "tsv" | "txt" | "clipboard";

export interface ParsedDataset {
  format: DatasetFormat;
  rows: Array<Record<string, string>>;
  columns: string[];
  /** 内容指纹：防「预览与执行用的不是同一份数据」（§5.4 dataset_hash） */
  hash: string;
  warnings: string[];
}

export type DatasetParseResult =
  | { ok: true; dataset: ParsedDataset }
  | { ok: false; error: string; line?: number; column?: number };

export interface ParseDatasetOptions {
  /** 强制指定格式；缺省时按顺序自动识别 */
  format?: DatasetFormat | null;
  /** 已知来源（clipboard 时用于选择默认格式） */
  source?: "inline" | "file" | "clipboard" | null;
}

const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g;

/** 列名归一化：去零宽字符、折叠空白、去首尾空白（**不改大小写**，值另说） */
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

/** 列名是否被红线拒绝（R1 / R2 / §1.3：数据集会落盘，凭证类列一律拒收） */
export function classifyDatasetColumnName(rawName: string): string | null {
  const name = normalizeColumnName(rawName);
  if (!name) return "存在空列名";
  const verdict = classifyExternalFillFieldName(name);
  if (!verdict.allowed) return verdict.reason;
  if (!verdict.warning) return null;

  // 泛「码」词条（code / otp / 验证码 / pin …）：
  //   · **单独成列**（如 `code`、`otp`、`验证码`）→ 视为凭证列，拒收（§4.6.6 的红条）；
  //   · **嵌在更长标识里**（`postalCode` / `countryCode` / `areaCode`）→ 只是告警，不误杀真实业务列。
  const credential = loadHumanCredentialLexicon();
  const compact = name.toLowerCase().replace(/\s+/g, "");
  const standalone =
    credential?.genericCodeTerms.some((term) => term.replace(/\s+/g, "") === compact) ?? false;
  if (!standalone) return null;

  return `列名「${name}」单独成列且像一次性凭证/兑换码：数据集会落盘，禁止承载这类列（R2 / §1.3）；请改列名`;
}

/**
 * 表头校验：归一化去重 + 红线词表 + 列数上限。返回错误文案（null = 通过）。
 */
function validateColumns(rawColumns: string[]): { columns: string[] } | { error: string } {
  const columns: string[] = [];
  const seen = new Map<string, string>();
  for (const raw of rawColumns) {
    const column = normalizeColumnName(raw);
    if (!column) return { error: "存在空列名：请给每列一个名字" };
    const key = column.toLowerCase();
    if (seen.has(key)) {
      return { error: `列名重复：「${column}」与「${seen.get(key)}」归一化后相同` };
    }
    const blocked = classifyDatasetColumnName(column);
    if (blocked) return { error: blocked };
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

/** 内容指纹（确定性）：对 rows 的规范化 JSON 取 sha256 */
export function computeDatasetHash(rows: Array<Record<string, string>>): string {
  const canonical = JSON.stringify(rows.map((row) => {
    const keys = Object.keys(row).sort();
    return keys.map((key) => [key, row[key]]);
  }));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * 从「已经是对象数组」的行构造数据集（内联 JSON / 已解析文件）。
 */
export function datasetFromRows(
  rawRows: unknown[],
  options: { format?: DatasetFormat; source?: "inline" | "file" | "clipboard" } = {},
): DatasetParseResult {
  const format = options.format ?? (options.source === "clipboard" ? "clipboard" : "json");
  const warnings: string[] = [];
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

  const rows: Array<Record<string, string>> = [];
  for (let index = 0; index < objects.length; index += 1) {
    const entry = objects[index]!;
    const row: Record<string, string> = {};
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

  return {
    ok: true,
    dataset: { format, rows, columns, hash: computeDatasetHash(rows), warnings },
  };
}

/** 猜测行内裸值的列名（txt / 单列） */
const SINGLE_COLUMN = "text";

/** 拆分一行 CSV/TSV（支持双引号包裹 + 双引号转义） */
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
 * 与前端 `src/lib/replayDataset.ts` **同源同规则**：两边独立实现，改动必须同步，
 * 否则会出现「前端说能跑、后端拒收」。
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
      row[key] = Array.isArray(value) ? value[index] ?? "" : value;
    }
    rows.push(row);
  }
  return rows;
}

function tryParseJsonObjectRows(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!isPlainObject(parsed)) return null;
  for (const key of ["rows", "data"]) {
    const value = parsed[key];
    if (Array.isArray(value)) return value;
  }
  const values = Object.values(parsed);
  if (values.length === 0) return null;
  if (values.some((value) => Array.isArray(value))) return transposeColumnObject(parsed);
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

/**
 * 解析文本数据集：按 json → json（对象包裹）→ jsonl → csv/tsv → txt 顺序自动识别。
 */
export function parseDatasetText(text: string, options: ParseDatasetOptions = {}): DatasetParseResult {
  const raw = String(text ?? "");
  if (raw.trim().length === 0) {
    return fail("数据集内容为空");
  }

  const physicalLines = raw.split(/\r?\n/);
  const format = options.format ?? null;

  const tryJson = (): DatasetParseResult | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
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
        // 自动识别阶段的判定：**已经出现过 JSON 对象**说明用户确实在给 JSONL，
        // 此时某行坏了 = 数据源坏了 → 报出行号；一行 JSON 对象都没有 → 不是 JSONL，
        // 交给后面的 CSV/TXT（否则纯文本会被误判成「坏的 JSONL」）。
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
    // 把行号补回错误里（datasetFromRows 用的是 entry 序号）
    if (result.line != null && lineNumbers[result.line - 1] != null) {
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
    const header = splitDelimited(dataLines[0]!.text, delimiter === "csv" ? "," : "\t");
    const columnCheck = validateColumns(header);
    if ("error" in columnCheck) return fail(columnCheck.error, dataLines[0]!.line);
    const columns = columnCheck.columns;

    const rows: Array<Record<string, string>> = [];
    for (let index = 1; index < dataLines.length; index += 1) {
      const entry = dataLines[index]!;
      const cells = splitDelimited(entry.text, delimiter === "csv" ? "," : "\t");
      if (cells.length !== columns.length) {
        return fail(
          `第 ${entry.line} 行列数 ${cells.length} 与表头列数 ${columns.length} 不一致`,
          entry.line,
          Math.min(cells.length, columns.length) + 1,
        );
      }
      const row: Record<string, string> = {};
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
    return { ok: true, dataset: { format: delimiter, rows, columns, hash: computeDatasetHash(rows), warnings: [] } };
  };

  const tryTxt = (): DatasetParseResult => {
    const rows: Array<Record<string, string>> = [];
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
        hash: computeDatasetHash(rows),
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

  // 自动识别：json → jsonl → csv/tsv → txt
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

/**
 * 单行数据集（剪贴板快照 / 单值）：列名 `text`（§6.1）。
 */
export function datasetFromSingleText(text: string): DatasetParseResult {
  return parseDatasetText(text, { format: "clipboard", source: "clipboard" });
}
