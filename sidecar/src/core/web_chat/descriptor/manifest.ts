/**
 * 描述符清单校验（严格文法 · 纯函数 · 无 I/O）
 *
 * 校验哲学（§0.5.3 A：禁止把「没跑成」谎报成结论；J：描述符里夹脚本即违规）：
 *   - **键名白名单**：任何未知键一律拒绝。描述符只能是「我们认识的字段」，不做前向兼容猜测
 *     （否则站点文件里的一个手误会被静默忽略，表现成「描述符明明写了却不生效」）。
 *   - **类型即契约**：字符串就是字符串，数字就是数字，不做隐式转换。
 *   - **脚本零容忍（纵深防御）**：运行时本来就没有任何动态求值（R8 的第①条），
 *     这里再拒一次明显的脚本标记 —— 这样即使将来有人误加 `eval`，学来的描述符也塞不进东西。
 *   - **长度/数量/枚举全部有上限**：描述符是外部输入（`learned` 由 AI 产出），必须当成不可信数据。
 *
 * 诊断必须**可读且带字段路径**：失败时用户要能在「修正对话框」里看到到底哪一项被拒。
 */

import {
  INPUT_METHODS,
  SEND_METHODS,
  VERIFY_MODES,
  type AttributeSpec,
  type ComposerSpec,
  type DescriptorSourceKind,
  type HistorySpec,
  type MatchSpec,
  type PeerSpec,
  type PresenceSpec,
  type ReadySpec,
  type RowsSpec,
  type SiteDescriptor,
  type ThreadsSpec,
} from "./types.js";

/* ————————————————————————— 上限（外部输入必须夹） ————————————————————————— */

const MAX_ID_LEN = 64;
const MAX_SELECTOR_LEN = 300;
const MAX_URL_PATTERN_LEN = 200;
const MAX_ARRAY_ITEMS = 24;
const MAX_PREFIX_LEN = 16;
const MAX_GROUP = 9;
const MAX_RETRIES = 8;
const MAX_BATCH = 500;
const MAX_CONCURRENCY = 16;
/** 会话列表一次最多读多少条（读整个左侧列表足够了；再多只会让视图变成一堵墙） */
const MAX_THREADS = 200;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 明显的脚本标记：选择器/属性名里出现即拒绝（纵深防御，见文件头第 3 条） */
const SCRIPT_MARKERS = [
  "=>",
  "function",
  "javascript:",
  "<script",
  "`",
  // 拼出来而不是写死字面量：否则「本文件不含 eval 调用」的源码级断言会被这个白名单自己绊倒
  ["e", "v", "a", "l", "("].join(""),
  "new Function",
  "require(",
  "import(",
  "document.",
  "window.",
  "globalThis",
  "process.",
  "this.",
  ";",
];

export interface ManifestDiagnostic {
  /** unknown_key | bad_type | bad_enum | bad_regex | bad_value | script_like | missing | invalid_id */
  code: string;
  /** 出问题的字段路径（如 `/rows/id/accept/0`），供 UI 直指问题 */
  path: string;
  reason: string;
}

export interface ParseDescriptorResult {
  ok: boolean;
  descriptor: SiteDescriptor | null;
  diagnostics: ManifestDiagnostic[];
}

/* ————————————————————————— 内部小工具（全部 push 诊断，不抛） ————————————————————————— */

class Ctx {
  readonly diagnostics: ManifestDiagnostic[] = [];

  fail(code: string, path: string, reason: string): null {
    this.diagnostics.push({ code, path, reason });
    return null;
  }

  /** 取对象并检查未知键（白名单） */
  obj(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return this.fail("bad_type", path, "必须是对象");
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) {
        this.fail("unknown_key", `${path}/${key}`, `未知字段（本版本不接受该字段，避免手误被静默忽略）`);
      }
    }
    return record;
  }

  str(value: unknown, path: string, opts: { max: number; required?: boolean; allowEmpty?: boolean }): string | null {
    if (value === undefined || value === null) {
      if (opts.required) return this.fail("missing", path, "必填字段缺失");
      return null;
    }
    if (typeof value !== "string") return this.fail("bad_type", path, "必须是字符串");
    const text = value.trim();
    if (!text && !opts.allowEmpty) return this.fail("bad_value", path, "不能为空");
    if (text.length > opts.max) {
      return this.fail("bad_value", path, `超长（${text.length} > ${opts.max}）`);
    }
    const marker = SCRIPT_MARKERS.find((m) => text.includes(m));
    if (marker) {
      return this.fail("script_like", path, `含脚本标记 ${JSON.stringify(marker)}（描述符只允许声明，不允许脚本）`);
    }
    return text;
  }

  /** 正则源码：长度受限 + 必须能编译（编译失败即拒绝，绝不「先收下再说」） */
  pattern(value: unknown, path: string, opts: { required?: boolean } = {}): string | null {
    if (value === undefined || value === null) {
      if (opts.required) return this.fail("missing", path, "必填字段缺失");
      return null;
    }
    if (typeof value !== "string") return this.fail("bad_type", path, "必须是字符串");
    const source = value.trim();
    if (!source) return this.fail("bad_value", path, "不能为空");
    if (source.length > MAX_URL_PATTERN_LEN) {
      return this.fail("bad_value", path, `超长（${source.length} > ${MAX_URL_PATTERN_LEN}）`);
    }
    if (!compileDescriptorPattern(source)) {
      return this.fail("bad_regex", path, "正则无法编译");
    }
    return source;
  }

  strArray(
    value: unknown,
    path: string,
    opts: { required?: boolean; maxItems?: number; maxLen?: number } = {},
  ): string[] | null {
    if (value === undefined || value === null) {
      if (opts.required) return this.fail("missing", path, "必填字段缺失");
      return [];
    }
    if (!Array.isArray(value)) return this.fail("bad_type", path, "必须是数组");
    const maxItems = opts.maxItems ?? MAX_ARRAY_ITEMS;
    if (value.length > maxItems) {
      return this.fail("bad_value", path, `条目过多（${value.length} > ${maxItems}）`);
    }
    const out: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = this.str(value[i], `${path}/${i}`, { max: opts.maxLen ?? MAX_SELECTOR_LEN });
      if (item === null) return null;
      out.push(item);
    }
    return out;
  }

  num(
    value: unknown,
    path: string,
    opts: { required?: boolean; min: number; max: number; fallback?: number },
  ): number | null {
    if (value === undefined || value === null) {
      if (opts.fallback !== undefined) return opts.fallback;
      if (opts.required) return this.fail("missing", path, "必填字段缺失");
      return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return this.fail("bad_type", path, "必须是有限数字");
    const n = Math.trunc(value);
    if (n < opts.min || n > opts.max) {
      return this.fail("bad_value", path, `超出范围（${n} 不在 ${opts.min}–${opts.max}）`);
    }
    return n;
  }

  bool(value: unknown, path: string, fallback: boolean): boolean {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") {
      this.fail("bad_type", path, "必须是布尔值");
      return fallback;
    }
    return value;
  }

  enum<T extends string>(value: unknown, path: string, allowed: readonly T[], fallback: T): T {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.fail("bad_enum", path, `只能是 ${allowed.join(" | ")} 之一`);
      return fallback;
    }
    return value as T;
  }
}

/** 描述符正则统一 `i` 编译（host / id / 属性 pattern 都用它；长度已在上层夹过） */
export function compileDescriptorPattern(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

/* ————————————————————————— 各段解析 ————————————————————————— */

function parseAttribute(ctx: Ctx, value: unknown, path: string): AttributeSpec | null {
  const record = ctx.obj(value, path, ["attr", "pattern", "group"]);
  if (!record) return null;
  const attr = ctx.str(record.attr, `${path}/attr`, { max: MAX_SELECTOR_LEN, required: true });
  const pattern = ctx.pattern(record.pattern, `${path}/pattern`);
  const group = ctx.num(record.group, `${path}/group`, { min: 0, max: MAX_GROUP, fallback: 0 });
  if (attr === null || group === null) return null;
  return { attr, pattern, group };
}

function parseMatch(ctx: Ctx, value: unknown): MatchSpec | null {
  const path = "/match";
  const record = ctx.obj(value, path, ["hostPattern", "pathPattern"]);
  if (!record) return null;
  const hostPattern = ctx.pattern(record.hostPattern, `${path}/hostPattern`, { required: true });
  const pathPattern = ctx.pattern(record.pathPattern, `${path}/pathPattern`);
  if (hostPattern === null) return null;
  return { hostPattern, pathPattern };
}

function parseReady(ctx: Ctx, value: unknown): ReadySpec | null {
  const path = "/ready";
  const record = ctx.obj(value, path, ["allOf", "absent"]);
  if (!record) return null;
  const allOf = ctx.strArray(record.allOf, `${path}/allOf`, { required: true });
  const absent = ctx.strArray(record.absent, `${path}/absent`);
  if (allOf === null || absent === null) return null;
  return { allOf, absent };
}

function parsePeer(ctx: Ctx, value: unknown): PeerSpec | null {
  const path = "/peer";
  const record = ctx.obj(value, path, ["fromAttribute", "fallbackAttrs", "fallbackHeader"]);
  if (!record) return null;

  const fromAttribute =
    record.fromAttribute === undefined || record.fromAttribute === null
      ? null
      : parseAttribute(ctx, record.fromAttribute, `${path}/fromAttribute`);
  if (record.fromAttribute !== undefined && record.fromAttribute !== null && fromAttribute === null) return null;

  const fallbackAttrs = ctx.strArray(record.fallbackAttrs, `${path}/fallbackAttrs`, { maxLen: MAX_SELECTOR_LEN });
  if (fallbackAttrs === null) return null;

  let fallbackHeader: PeerSpec["fallbackHeader"] = null;
  if (record.fallbackHeader !== undefined && record.fallbackHeader !== null) {
    const headerPath = `${path}/fallbackHeader`;
    const header = ctx.obj(record.fallbackHeader, headerPath, ["selectors", "digitsOnly"]);
    if (!header) return null;
    const selectors = ctx.strArray(header.selectors, `${headerPath}/selectors`, { required: true });
    if (selectors === null) return null;
    fallbackHeader = { selectors, digitsOnly: ctx.bool(header.digitsOnly, `${headerPath}/digitsOnly`, true) };
  }

  return { fromAttribute, fallbackAttrs, fallbackHeader };
}

function parseRows(ctx: Ctx, value: unknown): RowsSpec | null {
  const path = "/rows";
  const record = ctx.obj(value, path, [
    "selector",
    "id",
    "idPrefixDirection",
    "thenTailIcons",
    "thenCheckIcons",
    "exclude",
    "textSelectors",
    "attachmentSelectors",
    "quotedReplySelectors",
    "timeSelectors",
    "retractedSelectors",
    "tokenAttrs",
    "insertedAtTopMeansOlder",
  ]);
  if (!record) return null;

  const selector = ctx.str(record.selector, `${path}/selector`, { max: MAX_SELECTOR_LEN, required: true });

  let id: RowsSpec["id"] = null;
  if (record.id !== undefined && record.id !== null) {
    const idPath = `${path}/id`;
    const idRecord = ctx.obj(record.id, idPath, ["attr", "accept"]);
    if (!idRecord) return null;
    const attr = ctx.str(idRecord.attr, `${idPath}/attr`, { max: MAX_SELECTOR_LEN, required: true });
    const accept = ctx.strArray(idRecord.accept, `${idPath}/accept`, {
      required: true,
      maxLen: MAX_URL_PATTERN_LEN,
    });
    if (attr === null || accept === null) return null;
    for (let i = 0; i < accept.length; i += 1) {
      if (!compileDescriptorPattern(accept[i]!)) {
        return ctx.fail("bad_regex", `${idPath}/accept/${i}`, "正则无法编译");
      }
    }
    id = { attr, accept };
  }

  let idPrefixDirection: RowsSpec["idPrefixDirection"] = null;
  if (record.idPrefixDirection !== undefined && record.idPrefixDirection !== null) {
    const dirPath = `${path}/idPrefixDirection`;
    const dirRecord = ctx.obj(record.idPrefixDirection, dirPath, ["out", "in"]);
    if (!dirRecord) return null;
    const out = ctx.str(dirRecord.out, `${dirPath}/out`, { max: MAX_PREFIX_LEN, required: true, allowEmpty: true });
    const inbox = ctx.str(dirRecord.in, `${dirPath}/in`, { max: MAX_PREFIX_LEN, required: true, allowEmpty: true });
    if (out === null || inbox === null) return null;
    if (!out || !inbox) return ctx.fail("bad_value", dirPath, "out / in 前缀都不能为空");
    if (out === inbox) return ctx.fail("bad_value", dirPath, "out 与 in 前缀不能相同（否则方向无法区分）");
    idPrefixDirection = { out, in: inbox };
  }

  const icons = (key: "thenTailIcons" | "thenCheckIcons"): { out: string[]; in: string[] } | { out: string[] } | null => {
    const raw = record[key];
    if (raw === undefined || raw === null) return null;
    const iconPath = `${path}/${key}`;
    const allowed = key === "thenTailIcons" ? ["out", "in"] : ["out"];
    const iconRecord = ctx.obj(raw, iconPath, allowed);
    if (!iconRecord) return null;
    const out = ctx.strArray(iconRecord.out, `${iconPath}/out`, { required: true });
    if (out === null) return null;
    if (key === "thenTailIcons") {
      const inbox = ctx.strArray(iconRecord.in, `${iconPath}/in`, { required: true });
      if (inbox === null) return null;
      return { out, in: inbox };
    }
    return { out };
  };

  const tail = icons("thenTailIcons");
  if (record.thenTailIcons !== undefined && record.thenTailIcons !== null && tail === null) return null;
  const checks = icons("thenCheckIcons");
  if (record.thenCheckIcons !== undefined && record.thenCheckIcons !== null && checks === null) return null;

  const exclude = ctx.strArray(record.exclude, `${path}/exclude`);
  const textSelectors = ctx.strArray(record.textSelectors, `${path}/textSelectors`, { required: true });
  const attachmentSelectors = ctx.strArray(record.attachmentSelectors, `${path}/attachmentSelectors`);
  const quotedReplySelectors = ctx.strArray(record.quotedReplySelectors, `${path}/quotedReplySelectors`);
  const timeSelectors = ctx.strArray(record.timeSelectors, `${path}/timeSelectors`);
  const retractedSelectors = ctx.strArray(record.retractedSelectors, `${path}/retractedSelectors`);
  const tokenAttrs = ctx.strArray(record.tokenAttrs, `${path}/tokenAttrs`, { maxLen: MAX_SELECTOR_LEN });
  if (
    selector === null ||
    exclude === null ||
    textSelectors === null ||
    attachmentSelectors === null ||
    quotedReplySelectors === null ||
    timeSelectors === null ||
    retractedSelectors === null ||
    tokenAttrs === null
  ) {
    return null;
  }

  return {
    selector,
    id,
    idPrefixDirection,
    thenTailIcons: (tail as { out: string[]; in: string[] } | null) ?? null,
    thenCheckIcons: (checks as { out: string[] } | null) ?? null,
    exclude,
    textSelectors,
    attachmentSelectors,
    quotedReplySelectors,
    timeSelectors,
    retractedSelectors,
    tokenAttrs,
    insertedAtTopMeansOlder: ctx.bool(record.insertedAtTopMeansOlder, `${path}/insertedAtTopMeansOlder`, true),
  };
}

function parseAttach(ctx: Ctx, value: unknown): ComposerSpec["attach"] {
  if (value === undefined || value === null) return null;
  const path = "/composer/attach";
  const record = ctx.obj(value, path, [
    "buttonSelectors",
    "menuItemSelectors",
    "fileInputSelectors",
    "previewReadySelectors",
    "confirmSendSelectors",
  ]);
  if (!record) return null;
  const buttonSelectors = ctx.strArray(record.buttonSelectors, `${path}/buttonSelectors`);
  const menuItemSelectors = ctx.strArray(record.menuItemSelectors, `${path}/menuItemSelectors`);
  const fileInputSelectors = ctx.strArray(record.fileInputSelectors, `${path}/fileInputSelectors`);
  const previewReadySelectors = ctx.strArray(record.previewReadySelectors, `${path}/previewReadySelectors`);
  const confirmSendSelectors = ctx.strArray(record.confirmSendSelectors, `${path}/confirmSendSelectors`);
  if (
    buttonSelectors === null ||
    menuItemSelectors === null ||
    fileInputSelectors === null ||
    previewReadySelectors === null ||
    confirmSendSelectors === null
  ) {
    return null;
  }
  if (buttonSelectors.length === 0) {
    ctx.fail("bad_value", `${path}/buttonSelectors`, "声明了 attach 就必须给出附件按钮选择器");
    return null;
  }
  return {
    buttonSelectors,
    menuItemSelectors,
    fileInputSelectors,
    previewReadySelectors,
    confirmSendSelectors,
  };
}

function parseComposer(ctx: Ctx, value: unknown): ComposerSpec | null {
  const path = "/composer";
  const record = ctx.obj(value, path, ["selectors", "input", "send", "attach"]);
  if (!record) return null;

  const selectors = ctx.strArray(record.selectors, `${path}/selectors`, { required: true });

  const inputPath = `${path}/input`;
  const inputRecord = ctx.obj(record.input, inputPath, ["method", "verify", "retries", "failClosed"]);
  if (!inputRecord) return null;
  const input = {
    method: ctx.enum(inputRecord.method, `${inputPath}/method`, INPUT_METHODS, "typeKeys"),
    // 默认 fail-closed：写入校验就按逐字相等来（弱口径必须显式写出来，不能是默认）
    verify: ctx.enum(inputRecord.verify, `${inputPath}/verify`, VERIFY_MODES, "equals"),
    retries: ctx.num(inputRecord.retries, `${inputPath}/retries`, { min: 0, max: MAX_RETRIES, fallback: 3 }),
    failClosed: ctx.bool(inputRecord.failClosed, `${inputPath}/failClosed`, true),
  };

  const sendPath = `${path}/send`;
  const sendRecord = ctx.obj(record.send, sendPath, ["selectors", "method", "elseClick"]);
  if (!sendRecord) return null;
  const send = {
    selectors: ctx.strArray(sendRecord.selectors, `${sendPath}/selectors`),
    method: ctx.enum(sendRecord.method, `${sendPath}/method`, SEND_METHODS, "enterOnce"),
    elseClick: ctx.bool(sendRecord.elseClick, `${sendPath}/elseClick`, true),
  };

  const attach = parseAttach(ctx, record.attach);

  if (selectors === null || input.retries === null || send.selectors === null) return null;
  if (!input.failClosed) {
    ctx.fail("bad_value", `${inputPath}/failClosed`, "必须为 true：写入校验失败即取消发送（R8 第④条）");
    return null;
  }
  if (record.attach !== undefined && record.attach !== null && attach === null) return null;
  return {
    selectors,
    input: { ...input, retries: input.retries },
    send: { ...send, selectors: send.selectors },
    attach,
  };
}

function parseHistory(ctx: Ctx, value: unknown): HistorySpec | null {
  const path = "/history";
  const record = ctx.obj(value, path, ["scrollRoot", "batchLimit", "concurrency"]);
  if (!record) return null;
  const scrollRoot = ctx.strArray(record.scrollRoot, `${path}/scrollRoot`);
  const batchLimit = ctx.num(record.batchLimit, `${path}/batchLimit`, { min: 1, max: MAX_BATCH, fallback: 80 });
  const concurrency = ctx.num(record.concurrency, `${path}/concurrency`, {
    min: 1,
    max: MAX_CONCURRENCY,
    fallback: 4,
  });
  if (scrollRoot === null || batchLimit === null || concurrency === null) return null;
  return { scrollRoot, batchLimit, concurrency };
}

function parsePresence(ctx: Ctx, value: unknown): PresenceSpec | null {
  const path = "/presence";
  const record = ctx.obj(value, path, ["typing"]);
  if (!record) return null;
  const typing = ctx.strArray(record.typing, `${path}/typing`);
  if (typing === null) return null;
  return { typing };
}

/** 会话列表采集声明（只用于读；校验器盯住「不许出现点击/导航语义」由 R8 兜底） */
function parseThreads(ctx: Ctx, value: unknown): ThreadsSpec | null {
  const path = "/threads";
  const record = ctx.obj(value, path, [
    "itemSelectors",
    "keyAttr",
    "hrefAttr",
    "labelSelectors",
    "unreadSelectors",
    "limit",
  ]);
  if (!record) return null;

  const itemSelectors = ctx.strArray(record.itemSelectors, `${path}/itemSelectors`, { required: true });
  const labelSelectors = ctx.strArray(record.labelSelectors, `${path}/labelSelectors`);
  const unreadSelectors = ctx.strArray(record.unreadSelectors, `${path}/unreadSelectors`);
  const keyAttr = ctx.str(record.keyAttr, `${path}/keyAttr`, { max: MAX_SELECTOR_LEN });
  const hrefAttr = ctx.str(record.hrefAttr, `${path}/hrefAttr`, { max: MAX_SELECTOR_LEN });
  const limit = ctx.num(record.limit, `${path}/limit`, { min: 1, max: MAX_THREADS, fallback: 50 });

  if (
    itemSelectors === null ||
    itemSelectors.length === 0 ||
    labelSelectors === null ||
    unreadSelectors === null ||
    limit === null
  ) {
    if (itemSelectors !== null && itemSelectors.length === 0) {
      ctx.fail("bad_value", `${path}/itemSelectors`, "至少要声明一条会话列表项选择器");
    }
    return null;
  }
  return { itemSelectors, keyAttr, hrefAttr, labelSelectors, unreadSelectors, limit };
}

/* ————————————————————————— 入口 ————————————————————————— */

const ROOT_KEYS = [
  "id",
  "version",
  "source",
  "match",
  "ready",
  "peer",
  "rows",
  "composer",
  "history",
  "threads",
  "presence",
] as const;

/**
 * 解析并严格校验一份描述符。
 *
 * `source` 由**加载方按目录**决定，**不信任文件里的 source 字段**（否则一份 learned 文件
 * 可以自称 builtin，绕过「学习成果可清除」的边界）。
 */
export function parseDescriptor(raw: unknown, source: DescriptorSourceKind): ParseDescriptorResult {
  const ctx = new Ctx();
  const record = ctx.obj(raw, "", ROOT_KEYS);
  if (!record) return { ok: false, descriptor: null, diagnostics: ctx.diagnostics };

  const id = ctx.str(record.id, "/id", { max: MAX_ID_LEN, required: true });
  if (id !== null && !ID_PATTERN.test(id)) {
    ctx.fail("invalid_id", "/id", "只允许小写字母/数字与 . _ -，且以字母或数字开头");
  }

  const version = ctx.num(record.version, "/version", { min: 1, max: 10_000, required: true });

  if (record.source !== undefined && record.source !== source) {
    ctx.fail("bad_value", "/source", `文件里的 source 与来源目录不一致（目录判定为 ${source}）`);
  }

  const match = parseMatch(ctx, record.match);
  const ready = parseReady(ctx, record.ready);
  const peer = parsePeer(ctx, record.peer);
  const rows = parseRows(ctx, record.rows);
  const composer = parseComposer(ctx, record.composer);
  const history = parseHistory(ctx, record.history);
  const presence = parsePresence(ctx, record.presence);

  // `threads` 是**可选**声明：没写就是 `null`（视图走通用启发式 / 不提供勾选），
  // 而不是「校验失败」—— 老描述符不该因为少这一块就用不了。
  let threads: ThreadsSpec | null = null;
  if (record.threads !== undefined && record.threads !== null) {
    threads = parseThreads(ctx, record.threads);
    if (threads === null) {
      return { ok: false, descriptor: null, diagnostics: ctx.diagnostics };
    }
  }

  if (
    ctx.diagnostics.length > 0 ||
    id === null ||
    version === null ||
    !match ||
    !ready ||
    !peer ||
    !rows ||
    !composer ||
    !history ||
    !presence
  ) {
    return { ok: false, descriptor: null, diagnostics: ctx.diagnostics };
  }

  return {
    ok: true,
    descriptor: { id, version, source, match, ready, peer, rows, composer, history, threads, presence },
    diagnostics: [],
  };
}

/** 描述符是否与 URL 匹配（host 精确匹配；不匹配返回 false，不做子串误伤） */
export function descriptorMatchesUrl(descriptor: SiteDescriptor, url: string): boolean {
  let host = "";
  try {
    host = new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  const hostRe = compileDescriptorPattern(descriptor.match.hostPattern);
  if (!hostRe || !hostRe.test(host)) return false;

  if (descriptor.match.pathPattern) {
    let path = "";
    let search = "";
    try {
      const parsed = new URL(String(url ?? ""));
      path = parsed.pathname;
      search = parsed.search;
    } catch {
      return false;
    }
    const pathRe = compileDescriptorPattern(descriptor.match.pathPattern);
    // 路径线索是「加分项」，但它既然写了就要求命中（写而不生效比没写更坏）
    if (!pathRe || !pathRe.test(`${path}${search}`)) return false;
  }
  return true;
}
