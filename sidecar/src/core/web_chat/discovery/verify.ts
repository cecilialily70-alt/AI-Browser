/**
 * 发现流水线 ③ · 机器自检（**0 token**，不设人工确认关卡）
 *
 * 自检要抓的是两件不同的事（计划 §6.0 规则 3）：
 *   1. **报错型失败**：一条都没匹配到、schema 被拒 —— 好抓。
 *   2. **静默失败**：接口「有结果」但内容是错的（把 `true_` 当成我方、取错了字段、
 *      把日期分隔当成消息）。公开基准里这类错误在未见过页面上出现得相当频繁，
 *      **比报错危险得多** —— 因为它看起来一切正常。所以本模块把 `actual` 非空的失败
 *      单列成 `silentFailures`。
 *
 * 逐字段比对，而不是「有没有结果」：`id 集合 / 方向 / 内容版本 / 附件 / 系统消息跳过`。
 * 真值（oracle）来自通用 DOM 读法，与描述符**无关**，因此这不是自我确认。
 *
 * 本模块**纯函数**（不碰 DOM、不碰网络），所以能离线单测、能在 CI 里回归。
 */

import { parseDescriptor } from "../descriptor/manifest.js";
import { contentVersionOf, mapRows } from "../descriptor/map_rows.js";
import type {
  ConnectorMessage,
  ConnectorThreadsResult,
  RowFact,
  SiteDescriptor,
  ThreadFacts,
  ThreadListItem,
} from "../descriptor/types.js";
import type { OracleRow, VerifyCheck, VerifyReport } from "./types.js";

/** 一条描述符读出的消息 vs 真值行的对照（用于给出「期望 / 实际」） */
interface RowPair {
  expected: OracleRow;
  actual: ConnectorMessage | null;
}

function fold(text: string, limit = 40): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** 内容版本在视图里不可读：折叠成短指纹（比对仍是逐字哈希，不是给眼睛看的） */
function shortVersion(version: string): string {
  return version.slice(0, 8);
}

/**
 * 逐行配对。
 *
 * 为什么按**顺序**配而不是按 id 配：id 是不是可靠正是我们要验的东西之一 ——
 * 按顺序配能把「id 认错导致错位」暴露出来，按 id 配反而会把它藏起来。
 *
 * 但顺序必须**对齐尾部**：真值是从页面尾部留出的独立样本（`splitSamples` 从尾部取），
 * 而描述符在整个页面上读出来的消息包含更早的那些 —— 从头对齐会把「尾部样本 vs 头部消息」
 * 逐条比成方向全反（假失败，比漏检更坏：它会让修正回路去改一份本来正确的描述符）。
 */
function pairRows(rows: readonly OracleRow[], messages: readonly ConnectorMessage[]): RowPair[] {
  const kept = rows.filter((row) => !row.expect.systemLike);
  const offset = Math.max(0, messages.length - kept.length);
  const span = Math.max(kept.length, messages.length - offset);
  const pairs: RowPair[] = [];
  for (let i = 0; i < span; i += 1) {
    pairs.push({ expected: kept[i] as OracleRow, actual: messages[offset + i] ?? null });
  }
  return pairs;
}

export interface VerifyDraftInput {
  /**
   * **用这份草案在页面上采出来的事实包**（不是通用读法的那份）。
   *
   * 为什么必须是「草案采的」：`mapRows` 只做「事实 → 消息」的映射，**行选择本身在页内**
   * （`rows.selector`）。所以「选择器根本不存在」这类最致命的失败，只有拿草案采一次才看得见
   * —— 拿通用读法的事实去验，会把「一条都没匹配到」验成「全部通过」（自检变成空转）。
   *
   * 省略时走**离线模式**（见 {@link deriveFactsFromOracle}）：供夹具回归与「无页面重跑自检」用。
   */
  facts?: ThreadFacts;
  /** 通用读法给的**真值行**（独立证据） */
  oracleRows: readonly OracleRow[];
  /** 系统消息跳过项要用的样本（虚拟列表下真值只含可见行，噪声常常在另一批里）；缺省同 `oracleRows` */
  excludeRows?: readonly OracleRow[];
  /** 真值里是不是**只有可见的几条**（虚拟列表）：是的话「条数」只能当 warning，不能当 fatal */
  partialRows?: boolean;
}

/**
 * 离线模式：把真值行当成「页面事实」来验草案。
 *
 * 为什么这不是造假：页内事实里那几个**布尔/结构位**本来就是描述符自己算出来的
 * （`hasMedia` 靠 `attachmentSelectors`、`excluded` 靠 `exclude`、`retracted` 靠 `retractedSelectors`），
 * 所以「真值说这里确实有附件 / 确实是系统消息」+「草案有没有声明对应选择器」就能忠实复现页面结果。
 *
 * 诚实边界（写在代码里而不是藏起来）：正文直接取真值行的 `text` —— 因此离线模式验不出
 * 「`textSelectors` 指到了相邻节点」这一种错法，只能在真实页面上跑才看得见；
 * 这也正是 `learnDescriptor` 一律传页面事实包、离线模式只用于夹具回归的原因。
 */
export function deriveFactsFromOracle(
  descriptor: SiteDescriptor,
  oracleRows: readonly OracleRow[],
): ThreadFacts {
  const declaresMedia = descriptor.rows.attachmentSelectors.length > 0;
  const declaresExclude = descriptor.rows.exclude.length > 0;
  const declaresRetract = descriptor.rows.retractedSelectors.length > 0;
  const rows: RowFact[] = oracleRows.map((row) => ({
    rawId: row.rawId,
    text: row.text,
    hasMedia: row.hasMedia && declaresMedia,
    excluded: row.excluded && declaresExclude,
    retracted: row.retracted && declaresRetract,
    tailIcon: row.tailIcon,
    checkIcon: row.checkIcon,
    cxRatio: row.cxRatio,
    tokens: row.tokens,
    seenTs: row.seenTs,
    identity: row.identity,
  }));
  return { ok: true, reason: null, rows, moreAbove: false, fallbackPoll: false };
}

/**
 * 用真值行核对一份草案（纯函数）。
 *
 * 结论口径：`fatal` 的失败才判 `ok:false`（`warning` 只提示，例如虚拟列表导致条数不全）。
 *
 * 第二个参数既可以给 `{ facts, oracleRows }`（页面模式），也可以**直接给真值行数组**
 * （离线模式，等价于 `{ oracleRows: rows }`）—— 夹具回归里后者读起来更干净。
 */
export function verifyDraft(
  raw: unknown,
  input: VerifyDraftInput | readonly OracleRow[],
): VerifyReport {
  const normalized: VerifyDraftInput = Array.isArray(input)
    ? { oracleRows: input as readonly OracleRow[] }
    : (input as VerifyDraftInput);
  const oracleRows = normalized.oracleRows ?? [];
  const options = { partialRows: normalized.partialRows === true };
  const checks: VerifyCheck[] = [];
  const threads: VerifyCheck[] = [];
  const samples = { heldOutRows: oracleRows.length, heldOutThreads: 0 };

  const parsed = parseDescriptor(raw, "learned");
  const diagnostics = parsed.diagnostics.map((item) => ({ path: item.path, reason: item.reason }));

  checks.push({
    field: "schema",
    ok: parsed.ok,
    severity: "fatal",
    expected: "通过严格校验（键名/枚举/上限/无脚本标记）",
    actual: parsed.ok ? "通过" : `${diagnostics.length} 条诊断`,
    detail: parsed.ok ? undefined : diagnostics.map((d) => `${d.path}: ${d.reason}`).join("；").slice(0, 600),
  });

  if (!parsed.ok || !parsed.descriptor) {
    return {
      ok: false,
      schemaOk: false,
      diagnostics,
      checks,
      silentFailures: [],
      threads,
      samples,
      summary: `描述符草案没通过严格校验（${diagnostics.length} 条），已停在这一步 —— 不修补、不放行`,
    };
  }

  const descriptor: SiteDescriptor = parsed.descriptor;
  const facts: ThreadFacts =
    normalized.facts ?? deriveFactsFromOracle(descriptor, oracleRows);
  const excludeRows = normalized.excludeRows ?? oracleRows;

  /* ⓪ 草案的选择器在这个页面上到底采到了东西没有（这是「一条都没匹配到」的唯一判据） */
  checks.push({
    field: "rows.selector",
    ok: facts.ok,
    severity: "fatal",
    expected: `${descriptor.rows.selector} 能选出本会话的消息行`,
    actual: facts.ok ? `采到 ${facts.rows.length} 行` : `采集失败：${facts.reason ?? "unknown"}`,
    detail: facts.ok
      ? undefined
      : "选择器在这个页面里不存在或不可用 —— 这与「对方没说话」是两件事，别把它当安静",
  });

    const mapped = mapRows(facts.rows, descriptor, []);
  const messages = mapped.messages;

  /* ① 条数（虚拟列表场景只能当 warning —— 那是「读不全」，不是「读错」）
   *
   * 但**一条都没匹配到**是例外：那不是「读不全」，是行选择器在这个页面上根本不存在，
   * 必须 fatal（虚拟列表的说辞不能用来放过一个压根没匹配上的选择器）。
   */
  const expectedKept = oracleRows.filter((row) => !row.expect.systemLike).length;
  const nothingRead = messages.length === 0 && expectedKept > 0;
  checks.push({
    field: "rows.count",
    ok: messages.length === expectedKept,
    severity: nothingRead || !options.partialRows ? "fatal" : "warning",
    expected: `${expectedKept} 条（通用读法读到的非系统消息）`,
    actual: `${messages.length} 条`,
    detail: nothingRead
      ? "一条都没匹配到：rows.selector 在这个页面里不存在（不是「对方没说话」）"
      : undefined,
  });

  /*
   * ② 逐行比对：方向 / 内容版本 / 附件。
   *
   * 一条都没读到时**不逐条比对**：那时候每条都只能报「(缺)」，一堆「缺」会把真正的病因
   * （选择器没匹配到，已由 `rows.selector`/`rows.count` 报出）淹掉，也会被误归成「有结果但不对」
   * 的静默失败。报错型失败就让它保持报错型的样子。
   */
  const pairs = nothingRead ? [] : pairRows(oracleRows, messages);
  const directionFailures: VerifyCheck[] = [];
  const versionFailures: VerifyCheck[] = [];
  const mediaFailures: VerifyCheck[] = [];
  for (const pair of pairs) {
    const { expected, actual } = pair;
    if (!expected) continue;
    const label = expected.rawId ? `id=${fold(expected.rawId, 24)}` : `第 ${pairs.indexOf(pair) + 1} 条`;

    if (!actual) {
      directionFailures.push({
        field: `rows.direction@${label}`,
        ok: false,
        severity: "fatal",
        expected: `一条消息（真值方向 ${expected.expect.direction}）`,
        actual: "(缺)",
        detail: "这一条没被描述符读出来（条数少了一条）",
      });
      continue;
    }

    // 方向：只在真值**明确**时比对；真值自己都不确定（几何含糊）就不拿它否定描述符
    if (expected.expect.direction !== "unknown") {
      const ok = actual.direction === expected.expect.direction;
      if (!ok) {
        directionFailures.push({
          field: `rows.direction@${label}`,
          ok: false,
          severity: "fatal",
          expected: expected.expect.direction,
          actual: actual.direction,
          detail: "方向证据写反了（典型静默失败：有结果，但里外颠倒）",
        });
      }
    }

    // 内容版本：取错字段 / 把日期分隔混进正文都会在这里现形
    const expectedVersion = expected.expect.contentVersion;
    const actualVersion = actual.contentVersion;
    if (actualVersion !== expectedVersion && !expected.expect.mediaLike) {
      versionFailures.push({
        field: `rows.content@${label}`,
        ok: false,
        severity: "fatal",
        expected: `v:${shortVersion(expectedVersion)}（长度 ${expected.text.length}）`,
        actual: `v:${shortVersion(actualVersion)}（长度 ${actual.text.length}）`,
        detail: "正文与真值不一致：多半是 textSelectors 取到了相邻节点的文本（静默取错字段）",
      });
    }

    // 附件：有行无文字必须仍是「收到了这条」
    if (expected.expect.mediaLike && actual.kind !== "media") {
      mediaFailures.push({
        field: `rows.media@${label}`,
        ok: false,
        severity: "fatal",
        expected: "media（有行无文字）",
        actual: actual.kind,
        detail: "附件行没被认出来 —— 会把「对方发来一张图」当成「对方没回」",
      });
    }
  }
  checks.push(...directionFailures, ...versionFailures, ...mediaFailures);

  /* ③ 系统消息必须被跳过（否则会话里会混进「端到端加密」这类噪声） */
  const noise = excludeRows.filter((row) => row.expect.systemLike);
  if (noise.length > 0) {
    const leaked = noise.filter((row) =>
      messages.some((m) => m.contentVersion === contentVersionOf(row.hasMedia ? "media" : "text", row.text)),
    );
    checks.push({
      field: "rows.exclude",
      ok: leaked.length === 0,
      severity: "fatal",
      expected: `${noise.length} 条系统/分隔消息被跳过`,
      actual: leaked.length === 0 ? "全部跳过" : `${leaked.length} 条漏进会话`,
      detail: leaked.length > 0 ? "exclude 里缺少这一版系统消息的选择器" : undefined,
    });
  }
  /* ④ 稳定 id：能拿到站点 id 却全部退化成内容指纹，说明 rows.id 的形态写错了 */
  const withRawId = oracleRows.filter((row) => row.rawId && descriptor.rows.id);
  if (withRawId.length > 0) {
    const stableCount = messages.filter((m) => m.stableId).length;
    checks.push({
      field: "rows.id",
      ok: stableCount > 0,
      severity: "warning",
      expected: "至少一部分消息能用站点自身 id（stableId=true）",
      actual: `${stableCount}/${messages.length} 条稳定`,
      detail:
        stableCount === 0
          ? "rows.id.accept 的形态与页面上的 id 不匹配（会退化成内容指纹，同文重复会被折叠）"
          : undefined,
    });
  }

  const failing = checks.filter((check) => !check.ok);
  const fatal = failing.filter((check) => check.severity === "fatal");
  /*
   * 静默失败 = 「有结果却不对」：这类最危险，单独摆出来驱动修正。
   *
   * 判据是**字段**而不是文案：`schema` / `rows.selector` / `rows.count` 是「压根没跑成」的
   * 报错型失败（它报了错，没骗人），其余致命项（方向 / 正文 / 附件 / 系统消息跳过）才是
   * 有结果但不对。用文案匹配会变成脆弱字符串匹配（§0.5.3 A），字段名才是稳定契约。
   */
  const ERROR_TYPE_FIELDS = new Set(["schema", "rows.selector", "rows.count"]);
  const silentFailures = failing.filter(
    (check) => check.severity === "fatal" && !ERROR_TYPE_FIELDS.has(check.field),
  );

  const summary = buildSummary(descriptor, checks, fatal, silentFailures);

  return {
    ok: fatal.length === 0,
    schemaOk: true,
    diagnostics,
    checks,
    silentFailures,
    threads,
    samples,
    summary,
  };
}

function buildSummary(
  descriptor: SiteDescriptor,
  checks: readonly VerifyCheck[],
  fatal: readonly VerifyCheck[],
  silent: readonly VerifyCheck[],
): string {
  if (fatal.length === 0) {
    return `自检通过：${descriptor.id} 读对了 ${checks.length} 项（含方向与正文逐字段核对）`;
  }
  const head = `自检未通过：${fatal.length} 项不符`;
  const silentNote = silent.length > 0 ? `，其中 ${silent.length} 项是「有结果但不对」的静默失败` : "";
  return `${head}${silentNote}（${fatal.map((c) => c.field).slice(0, 4).join(" / ")}）`;
}

/* ————————————————————————— 会话列表（勾选对象）核对 ————————————————————————— */

/**
 * 用真值列表核对描述符读出来的列表（纯函数）。
 *
 * 口径：**描述符读到的候选必须是真值的子集**（不能凭空多出「页面上没有的人」）；
 * 真值里靠通用启发式才拿到的那部分允许缺失（通用读法本身也可能漏），所以
 * 「漏了」只记 warning —— 但「多出/认错人」是 fatal（用户会勾到一个不存在的人）。
 */
export function compareThreads(
  actual: ConnectorThreadsResult,
  expected: readonly ThreadListItem[],
): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  if (!actual.ok) {
    checks.push({
      field: "threads.read",
      ok: false,
      severity: "fatal",
      expected: "能读到会话列表",
      actual: `读失败：${actual.reason ?? "unknown"}`,
      detail: "读不到列表与「列表是空的」是两件事：前者是描述符没选对节点",
    });
    return checks;
  }
  if (expected.length === 0) {
    checks.push({
      field: "threads.oracle",
      ok: true,
      severity: "warning",
      expected: "通用读法能给一份列表真值",
      actual: "通用读法读不到列表（本项跳过，不当作通过也不当作失败）",
      detail: "会话列表自检被跳过：没有真值就没法判定，宁可如实说明，也不假装验过",
    });
    return checks;
  }

  const expectedKeys = new Set(expected.map((item) => item.key));
  const actualKeys = new Set(actual.items.map((item) => item.key));
  const extra = actual.items.filter((item) => !expectedKeys.has(item.key));
  const missing = expected.filter((item) => !actualKeys.has(item.key));

  checks.push({
    field: "threads.keys",
    ok: extra.length === 0,
    severity: "fatal",
    expected: `${expected.length} 条（真值）`,
    actual: `${actual.items.length} 条`,
    detail:
      extra.length > 0
        ? `读出了真值里没有的 ${extra.length} 条（含 1 条的 key=${fold(extra[0]?.key ?? "", 32)}）：会把不是会话的节点当成联系人`
        : undefined,
  });
  checks.push({
    field: "threads.coverage",
    ok: missing.length === 0,
    severity: "warning",
    expected: `覆盖真值全部 ${expected.length} 条`,
    actual: `覆盖 ${expected.length - missing.length} 条`,
    detail: missing.length > 0 ? `漏了 ${missing.length} 条（用户会看不到这些人）` : undefined,
  });
  return checks;
}

/** 把自检报告折叠成「喂回模型的差异」（只给具体差异，不说「再试一次」） */
export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [report.summary];
  if (!report.schemaOk) {
    for (const item of report.diagnostics.slice(0, 20)) {
      lines.push(`- [schema] ${item.path}: ${item.reason}`);
    }
    return lines.join("\n");
  }
  const failing = [...report.checks, ...report.threads].filter((check) => !check.ok);
  for (const check of failing.slice(0, 24)) {
    lines.push(
      `- [${check.severity}] ${check.field}: 期望=${check.expected} 实际=${check.actual}${
        check.detail ? `；${check.detail}` : ""
      }`,
    );
  }
  if (report.silentFailures.length > 0) {
    lines.push(`注意：以上有 ${report.silentFailures.length} 项属于「有结果但不对」，请优先修这一类。`);
  }
  return lines.join("\n");
}
