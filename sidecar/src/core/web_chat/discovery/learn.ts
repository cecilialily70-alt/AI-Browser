/**
 * 发现流水线 · 编排（采集 → 推断 → 自检 → 修正 → 保存）
 *
 * 纪律（缺一条就会做出一个「看起来能用」的假货）：
 *   - **采集只做一次**：修正回路复用同一份样本，避免「每轮重新采样 → 每轮验的都是新数据」。
 *   - **自检只用 heldOut**：模型没见过的样本才算独立验证（计划 §6.0 规则 3）。
 *   - **不修补草案**：`parseDescriptor` 拒绝就重试，绝不偷偷补字段（补出来的就是编造）。
 *   - **写入自检单独一档**：读通过 ≠ 写可用。没有显式给出自测对象时**如实标注未做**，
 *     绝不假装「读写都验过了」（诚实边界比好看的结论重要）。
 *   - **不做后台自动重学习**：轮数有上限，到顶就如实报「本站在 X 处无法自动对接」。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";

import { createDomConnector } from "../descriptor/dom_connector.js";
import { extractThreadFacts } from "../descriptor/facts.js";
import { parseDescriptor } from "../descriptor/manifest.js";
import type { ConnectorContact, SiteDescriptor, ThreadListItem } from "../descriptor/types.js";
import { captureBundle, type CaptureBundleOptions } from "./capture.js";
import { inferDescriptor, type InferChatClient } from "./infer.js";
import type { CaptureBundle, DescriptorDraft, VerifyCheck, VerifyReport } from "./types.js";
import { compareThreads, formatVerifyReport, verifyDraft } from "./verify.js";

/** 一轮分析的默认上限：到顶就如实报「调不动了」，不做后台自动重试 */
export const DEFAULT_LEARN_ROUNDS = 2;

export interface LearnProgress {
  round: number;
  stage: "capture" | "infer" | "verify" | "save";
  message: string;
  ok?: boolean;
}

export interface LearnInput {
  page: Page;
  client: InferChatClient;
  /** 推理槽模型名（由调用方经 `createModelRouter` 解析后传进来） */
  model: string;
  siteLabel: string;
  /** 现有的会话列表读取器（站点已有描述符时用；新站点为 null，走通用真值） */
  listThreads?: (() => Promise<ThreadListItem[]>) | null;
  /** 修正回路轮数上限（1 = 不做修正，只试一次） */
  maxRounds?: number;
  capture?: CaptureBundleOptions;
  signal?: AbortSignal;
  onProgress?: (progress: LearnProgress) => void;
  /** 已有的采集包（复用时跳过采集；测试与「只重跑自检」用） */
  reuseCapture?: CaptureBundle | null;
}

export interface LearnAttempt {
  round: number;
  draft: DescriptorDraft | null;
  report: VerifyReport | null;
  threadsChecks: VerifyCheck[];
  feedback: string | null;
}

export interface LearnResult {
  ok: boolean;
  descriptor: SiteDescriptor | null;
  /** 最后一次自检报告（失败时用它驱动修正对话框） */
  report: VerifyReport | null;
  attempts: LearnAttempt[];
  capture: CaptureBundle;
  /** 人话结论（进日志与视图；失败时要说清卡在哪一项） */
  summary: string;
  usage: { promptTokens: number; completionTokens: number; calls: number };
}

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 跑一轮「学习」。**任何一步失败都不静默**：如实写进 `summary` 与 `attempts`。
 */
export async function learnDescriptor(input: LearnInput): Promise<LearnResult> {
  const progress = (p: LearnProgress): void => input.onProgress?.(p);
  const maxRounds = Math.max(1, Math.min(5, input.maxRounds ?? DEFAULT_LEARN_ROUNDS));
  const attempts: LearnAttempt[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let calls = 0;

  progress({ round: 0, stage: "capture", message: "开始采集页面结构事实（不花 token）" });
  const capture = input.reuseCapture ?? (await captureBundle(input.page, input.capture ?? {}));
  const heldOutRows = capture.oracle.rows.heldOut;
  // 样本太少时 heldOut 会为空：那时只能退回 shown，并**如实标注**这不是独立验证
  const verifyRows = heldOutRows.length > 0 ? heldOutRows : capture.oracle.rows.shown;
  const independent = heldOutRows.length > 0;
  progress({
    round: 0,
    stage: "capture",
    message: `采集完成：结构候选 ${capture.structure.nodes.length} 个，行真值 ${capture.oracle.rows.shown.length}+${heldOutRows.length} 条，列表真值 ${capture.oracle.threads.shown.length}+${capture.oracle.threads.heldOut.length} 条`,
    ok: capture.structure.ok,
  });

  let previous: DescriptorDraft | null = null;
  let feedback: string | null = null;
  let lastReport: VerifyReport | null = null;
  let lastThreads: VerifyCheck[] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    if (input.signal?.aborted) {
      return {
        ok: false,
        descriptor: null,
        report: lastReport,
        attempts,
        capture,
        summary: "分析已取消（用户中止或浏览器被关掉），半成品草案不保存",
        usage: { promptTokens, completionTokens, calls },
      };
    }

    progress({ round, stage: "infer", message: previous ? `第 ${round} 轮：按差异调整草案` : "第 1 轮：让模型给一份草案" });
    let draft: DescriptorDraft | null = null;
    try {
      draft = await inferDescriptor({
        client: input.client,
        model: input.model,
        bundle: capture,
        options: {
          siteLabel: input.siteLabel,
          previous,
          feedback,
          signal: input.signal,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ round, draft: null, report: null, threadsChecks: [], feedback: null });
      lastReport = null;
      previous = null;
      feedback = null;
      progress({ round, stage: "infer", message: `模型调用失败：${message}`, ok: false });
      return {
        ok: false,
        descriptor: null,
        report: lastReport,
        attempts,
        capture,
        summary: `分析失败：模型调用出错（${message.slice(0, 160)}）`,
        usage: { promptTokens, completionTokens, calls },
      };
    }
    calls += 1;
    promptTokens += numeric(draft?.usage?.promptTokens);
    completionTokens += numeric(draft?.usage?.completionTokens);
    if (!draft) {
      attempts.push({ round, draft: null, report: null, threadsChecks: [], feedback: null });
      progress({ round, stage: "infer", message: "模型输出无法解析成草案（不编一份顶上）", ok: false });
      return {
        ok: false,
        descriptor: null,
        report: null,
        attempts,
        capture,
        summary: "分析失败：模型没有给出可解析的描述符 JSON（已保留原始输出供排查）",
        usage: { promptTokens, completionTokens, calls },
      };
    }

    progress({
      round,
      stage: "verify",
      message: "机器自检：先在真实页面上按草案采一次事实，再逐字段核对方向 / 正文 / 附件 / 系统消息",
    });
    let threadsChecks: VerifyCheck[] = [];
    let descriptor: SiteDescriptor | null = null;
    let report: VerifyReport;

    const schema = parseDescriptor(draft.descriptor, "learned");
    descriptor = schema.descriptor ?? null;
    if (!schema.ok || !descriptor) {
      // schema 就被拒：不采、不验、不修补 —— 把诊断原样交给修正回路（补出来的就是编造）
      report = verifyDraft(draft.descriptor, { oracleRows: verifyRows, partialRows: true });
    } else {
      /*
       * 关键：**用草案在真实页面上采一次**。
       *
       * 只用真值行验是验不出「选择器在这个页面上根本不存在」的（那会把最致命的失败验成通过），
       * 所以这一趟页面往返不能省；采不到就把 `ok:false` 原样带进自检（不伪装成空会话）。
       */
      const facts = await extractThreadFacts(input.page, {
        containerSelector: capture.container ?? "",
        rows: descriptor.rows,
        signal: input.signal,
      });
      report = verifyDraft(draft.descriptor, {
        facts,
        oracleRows: verifyRows,
        // 系统消息常常落在 shown 那批（虚拟列表只截了可见行），跳过项要用两批合起来判
        excludeRows: [...capture.oracle.rows.shown, ...heldOutRows],
        partialRows: true,
      });
      if (descriptor.threads) {
        threadsChecks = await checkThreadsInPage(input.page, descriptor, capture);
      }
    }

    const threadsFatal = threadsChecks.filter((check) => !check.ok && check.severity === "fatal");
    const merged: VerifyReport = {
      ...report,
      threads: threadsChecks,
      samples: { heldOutRows: verifyRows.length, heldOutThreads: capture.oracle.threads.heldOut.length },
      ok: report.ok && threadsFatal.length === 0,
    };
    const summaryParts = [report.summary];
    if (threadsChecks.length > 0) {
      const failed = threadsChecks.filter((check) => !check.ok);
      summaryParts.push(
        failed.length === 0 ? "会话列表核对通过" : `会话列表有 ${failed.length} 项不符`,
      );
    }
    if (!independent) summaryParts.push("（样本太少，本轮自检用的是给过模型的样本，独立验证力度下降）");
    merged.summary = summaryParts.join("；");

    lastReport = merged;
    lastThreads = threadsChecks;
    const roundFeedback = merged.ok ? null : formatVerifyReport(merged);
    attempts.push({ round, draft, report: merged, threadsChecks, feedback: roundFeedback });
    progress({
      round,
      stage: "verify",
      message: merged.summary,
      ok: merged.ok,
    });

    if (merged.ok && descriptor) {
      return {
        ok: true,
        descriptor,
        report: merged,
        attempts,
        capture,
        summary: `自检通过：${descriptor.id} 可以启用（${round} 轮）`,
        usage: { promptTokens, completionTokens, calls },
      };
    }

    previous = draft;
    feedback = roundFeedback;
  }

  const failing = lastReport ? [...lastReport.checks, ...lastThreads].filter((c) => !c.ok) : [];
  return {
    ok: false,
    descriptor: null,
    report: lastReport,
    attempts,
    capture,
    summary:
      `到 ${maxRounds} 轮仍未通过自检：卡在 ${
        failing.map((c) => c.field).slice(0, 4).join(" / ") || "未知项"
      }。差异已原样保留（视图里逐条列出），可以核对后重学；本站当前仍走通用模式。`,
    usage: { promptTokens, completionTokens, calls },
  };
}

/** 会话列表核对：用草案在**真实页面**上读一次，与真值比（不点击、不导航） */
async function checkThreadsInPage(
  page: Page,
  descriptor: SiteDescriptor,
  capture: CaptureBundle,
): Promise<VerifyCheck[]> {
  const expected = capture.oracle.threads.heldOut.length > 0
    ? capture.oracle.threads.heldOut
    : capture.oracle.threads.shown;
  try {
    const connector = createDomConnector({
      page,
      descriptor: { descriptor, path: "(draft)", source: "learned" },
    });
    const result = await connector.listThreads?.();
    if (!result) {
      return [
        {
          field: "threads.read",
          ok: false,
          severity: "warning",
          expected: "能读到会话列表",
          actual: "草案没有声明 threads，或连接器不支持",
          detail: "没有列表能力时视图会退回手打对象（不降级到不可用）",
        },
      ];
    }
    return compareThreads(result, expected);
  } catch (error) {
    return [
      {
        field: "threads.read",
        ok: false,
        severity: "warning",
        expected: "能读到会话列表",
        actual: `读列表抛错：${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
      },
    ];
  }
}

/* ————————————————————————— 写入自检（读通过 ≠ 写可用） ————————————————————————— */

export interface SendSelfTestInput {
  /** 会话对象：**必须是用户自己的对话/收藏夹**（由调用方显式指定，引擎不猜） */
  contact: ConnectorContact;
  connector: {
    sendText(contact: ConnectorContact, text: string): Promise<{ ok: boolean; reason?: string }>;
    readThread(
      contact: ConnectorContact,
      options: { loadHistory: boolean; previous: never[]; signal: AbortSignal },
    ): Promise<{ ok: boolean; reason: string | null; newOutgoing: { text: string }[] }>;
  };
  /** 一次性标记（进日志与消息体，便于人工排查；**不含任何用户内容**） */
  marker: string;
  signal: AbortSignal;
}

export interface SendSelfTestResult {
  ok: boolean;
  checks: VerifyCheck[];
  summary: string;
}

/**
 * 在**自己的对话/收藏夹**里发一条自检消息，再用读接口读回来逐字核对。
 *
 * 三条纪律：
 *   1. **对象由调用方显式给出**（引擎绝不猜哪个人是「自己」）——猜错就是把测试消息发给真人。
 *   2. 消息体是一句无意义的固定文本 + 标记，**不含任何用户内容**。
 *   3. 读回必须**逐字相等**且方向为 out；不通过就如实失败（不重试第二次，免得刷屏）。
 */
export async function verifySendRoundtrip(input: SendSelfTestInput): Promise<SendSelfTestResult> {
  const checks: VerifyCheck[] = [];
  const text = `接口自检 ${input.marker}`;
  const sent = await input.connector.sendText(input.contact, text);
  checks.push({
    field: "send.write",
    ok: sent.ok,
    severity: "fatal",
    expected: "写入输入框并提交成功",
    actual: sent.ok ? "成功" : `失败：${sent.reason ?? "unknown"}`,
  });
  if (!sent.ok) {
    return { ok: false, checks, summary: `写入自检未通过：${sent.reason ?? "unknown"}` };
  }

  const read = await input.connector.readThread(input.contact, {
    loadHistory: false,
    previous: [],
    signal: input.signal,
  });
  const found = read.ok && read.newOutgoing.some((message) => message.text === text);
  checks.push({
    field: "send.roundtrip",
    ok: found,
    severity: "fatal",
    expected: "读回来能逐字看到这条自检消息（且方向为我方）",
    actual: read.ok ? (found ? "读到" : "没读到（可能没真正发出）") : `读取失败：${read.reason ?? "unknown"}`,
    detail: found ? undefined : "写入成功不等于发出去了 —— 这正是「回执早于结果」要防的",
  });
  return {
    ok: found,
    checks,
    summary: found ? "写入自检通过（发送后读回逐字一致）" : "写入自检未通过（不重试第二次，免得刷屏）",
  };
}

/* ————————————————————————— 落盘（learned 描述符 + 元数据） ————————————————————————— */

/** 元数据单独一份文件：描述符正文必须原样通过校验器，不能塞私有键 */
export interface LearnedMeta {
  siteKey: string;
  siteLabel: string;
  savedAt: string;
  url: string;
  rounds: number;
  readVerified: boolean;
  sendVerified: boolean;
  notes: { field: string; reason: string; confidence: number }[];
  usage: { promptTokens: number; completionTokens: number; calls: number };
  /** 自检摘要（视图直接展示，不必再拼一次） */
  verifySummary: string;
}

export function descriptorFileName(siteKey: string): string {
  return `${siteKey}.json`;
}

export function metaFileName(siteKey: string): string {
  return `_meta-${siteKey}.json`;
}

/**
 * `descriptorFileName` 的**唯一逆运算**：从文件名取回 siteKey（拿不回来就 null）。
 *
 * 为什么要有它：文件名叫 `<siteKey>.json`，而**描述符的 id 可以是别的东西**（两者不保证同名）。
 * 视图要删一个学来的描述符时，删的是**文件名干**，不是 id —— 让视图拿 id 当 key 去删，
 * 只会得到一个看起来像 BUG 的 `not_found`；让视图自己拆文件名，就是「两套命名约定分叉」（坑族 J）。
 * 所以约定放在这里拆好、随总览一起交给视图。
 */
export function siteKeyFromFileName(fileName: string): string | null {
  const raw = String(fileName ?? "").trim();
  // 这个函数的输入是**文件名**（来自目录遍历的单个条目）；给了路径就不是文件名，
  // 与其替调用方猜一段，不如 fail-closed 交回 null（同 `safeSiteKey` 的口径）。
  if (!raw || /[\\/]/.test(raw)) return null;
  if (!raw.toLowerCase().endsWith(".json")) return null;
  return safeSiteKey(raw.slice(0, -".json".length));
}

/**
 * siteKey 只允许作为**文件名干**出现：字母/数字开头，之后允许 `. _ -`，最长 96。
 *
 * 为什么必须挡（fail-closed）：这几个函数是拿 siteKey **拼路径**的，
 * 一个 `../../某文件` 的 key 会让「删一个学来的描述符」变成「删目录外的任意 `.json`」，
 * 或让保存写到环境目录之外。**清洗后为空 / 含分隔符 / 以点开头 → 一律拒绝**，
 * 不静默替换成别的东西（静默替换 = 另一个更难查的错）。
 */
export const SAFE_SITE_KEY = /^[a-z0-9][a-z0-9._-]{0,95}$/i;

/** 合法则返回 trim 后的 key，否则 null（调用方必须是 fail-closed 的那一侧） */
export function safeSiteKey(siteKey: string): string | null {
  const key = String(siteKey ?? "").trim();
  return SAFE_SITE_KEY.test(key) ? key : null;
}

export interface SaveLearnedInput {
  dir: string;
  descriptor: SiteDescriptor;
  meta: LearnedMeta;
}

/** 保存学到的描述符（幂等覆盖；元数据与正文分文件） */
export function saveLearnedDescriptor(input: SaveLearnedInput): { descriptorPath: string; metaPath: string } {
  const siteKey = safeSiteKey(input.meta.siteKey);
  if (!siteKey) {
    // 宁可写不进去，也不写到环境目录之外
    throw new Error(`unsafe_site_key: ${String(input.meta.siteKey ?? "").slice(0, 64)}`);
  }
  mkdirSync(input.dir, { recursive: true });
  const descriptorPath = join(input.dir, descriptorFileName(siteKey));
  const metaPath = join(input.dir, metaFileName(siteKey));
  writeFileSync(descriptorPath, `${JSON.stringify(input.descriptor, null, 2)}\n`, "utf8");
  writeFileSync(metaPath, `${JSON.stringify({ ...input.meta, siteKey }, null, 2)}\n`, "utf8");
  return { descriptorPath, metaPath };
}

export function readLearnedMeta(dir: string, siteKey: string): LearnedMeta | null {
  const key = safeSiteKey(siteKey);
  if (!key) return null;
  const path = join(dir, metaFileName(key));
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LearnedMeta;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 删除学到的描述符（连同元数据）；返回是否真的删到了东西（幂等） */
export function removeLearnedDescriptor(dir: string, siteKey: string): boolean {
  const key = safeSiteKey(siteKey);
  if (!key) return false;
  let removed = false;
  for (const name of [descriptorFileName(key), metaFileName(key)]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed = true;
  }
  return removed;
}

/**
 * 导出为 **builtin 候选**（供复核后随仓库发版 → 计划 §6.3「学习成果回收」）。
 *
 * 只改 `source`（因为加载器按目录决定来源，builtin 目录里的文件必须自称 builtin），
 * 其余一字不动 —— 导出物必须与已验证的那份**逐字一致**，否则导出就没意义了。
 */
export function exportAsBuiltinCandidate(descriptor: SiteDescriptor): string {
  return `${JSON.stringify({ ...descriptor, source: "builtin" }, null, 2)}\n`;
}
