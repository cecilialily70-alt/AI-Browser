/**
 * 站点学习（发现流水线）的**会话装配层**（P5）
 *
 * 分层（§0.4 / 落点纪律）：
 *   - 决策与判定全在 `core/web_chat/discovery/`（纯函数 + 0 token 自检）；
 *   - 本模块只做**确定性接线**：取页面 → 解析推理槽 → 跑管线 → 落盘 → 如实汇报。
 *
 * 四条纪律（缺一条就会做出一个「看起来能用」的假货）：
 *   1. **绝不动用户的标签**：只在「我们自己的聊天标签」里工作；要导航也只导航自己的标签。
 *      拿不到可用页面就**如实失败**，不猜、不劫持（§1.6 / R7）。
 *   2. **拿不到 userDataDir 就不保存**：学习成果必须落在该环境**自己的**目录里（随环境删除一并清掉），
 *      没有目录宁可只返回草案，也不写到一个「看起来合理」的全局路径（坑族 J）。
 *   3. **写入自检单独一档**：读通过 ≠ 写可用。没有显式给出自测对象时如实标注「未做」，
 *      绝不假装「读写都验过了」——诚实的边界比好看的结论重要。
 *   4. **花费如实入账**：一次学习的 token 花在 `infer` 桶；拿不到单价就**不猜价格**（记 0 并说明），
 *      不假装没花钱。
 */

import { createLlmClient } from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import { withLlmRetry } from "../llm_retry.js";
import { appendDecision } from "../core/web_chat/discovery/decision.js";
import type { InferChatClient } from "../core/web_chat/discovery/infer.js";
import {
  learnDescriptor,
  readLearnedMeta,
  removeLearnedDescriptor,
  safeSiteKey,
  saveLearnedDescriptor,
  siteKeyFromFileName,
  verifySendRoundtrip,
} from "../core/web_chat/discovery/learn.js";
import type { LearnedMeta } from "../core/web_chat/discovery/learn.js";
import { addSlice, emptyLedger, totalsOf } from "../core/web_chat/discovery/spend.js";
import type {
  DecisionOutcome,
  SpendLedger,
  VerifyCheck,
  VerifyReport,
} from "../core/web_chat/discovery/types.js";
import { createDomConnector } from "../core/web_chat/descriptor/dom_connector.js";
import type { ConnectorHealth } from "../core/web_chat/descriptor/health.js";
import {
  builtinConnectorDirs,
  connectorDirsPresent,
  listDescriptorItems,
  loadDescriptorDirs,
  resolveLearnedConnectorDir,
} from "../core/web_chat/descriptor/registry.js";
import type { DescriptorDiagnostic, DescriptorListItem } from "../core/web_chat/descriptor/registry.js";
import type { ConnectorContact, SiteDescriptor } from "../core/web_chat/descriptor/types.js";
import { contextOf, ensureChatPage, resolveCurrentConversation } from "./chat_actions.js";
import type { SidecarAiSettings } from "../engine.js";
import type { JsonLogger } from "../json-logger.js";
import type { Browser, Page } from "playwright-core";
import { basename, join } from "node:path";

/** 报告里最多带回来的差异条数（够用户看清卡在哪；全量在日志里） */
export const REPORT_DIFF_LIMIT = 24;

export type LearnOutcomeKind = "saved" | "no_dir" | "rejected" | "cancelled" | "failed";

export interface ChatLearnInput {
  browser: Browser;
  logger: JsonLogger;
  aiSettings: SidecarAiSettings;
  /** 环境自己的数据目录（学习成果写进 `connectors/_learned`）；拿不到就**不落盘** */
  userDataDir: string | null;
  /** 要学的站点地址；不给就用**当前打开的**聊天窗口（只认已经开着的聊天页） */
  url?: string | null;
  siteLabel?: string | null;
  /** 用哪个槽分析（默认推理槽；测试可指定） */
  slot?: "logic" | "fast_text";
  maxRounds?: number;
  /** 写入自检的对象（必须是用户自己的会话/收藏夹；不给就不做，并如实标注未做） */
  selfTestContact?: ConnectorContact | null;
  signal: AbortSignal;
  onProgress?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface ChatLearnResult {
  ok: boolean;
  outcome: LearnOutcomeKind;
  summary: string;
  siteKey: string | null;
  descriptorId: string | null;
  savedPaths: { descriptorPath: string; metaPath: string } | null;
  /** 自检逐条差异（视图的「修正」对话框直接用这个，不必再拼一次） */
  checks: VerifyCheck[];
  schemaDiagnostics: { path: string; reason: string }[];
  attempts: number;
  readVerified: boolean;
  sendVerified: boolean;
  sendChecks: VerifyCheck[];
  usage: { calls: number; promptTokens: number; completionTokens: number; costMicroUsd: number };
  /** 该环境的决策记录目录（只记判定与指纹，不含任何正文） */
  decisionDir: string | null;
  /** 人审摘要：只含选择器/枚举，不含脚本 */
  preview: ChatDescriptorPreview | null;
}

export interface ChatDescriptorPreview {
  id: string;
  hostPattern: string;
  readySelectors: string[];
  rowSelector: string;
  composerSelectors: string[];
  inputMethod: string;
  sendMethod: string;
  canAttach: boolean;
}

function emptyResult(): ChatLearnResult {
  return {
    ok: false,
    outcome: "failed",
    summary: "未开始",
    siteKey: null,
    descriptorId: null,
    savedPaths: null,
    checks: [],
    schemaDiagnostics: [],
    attempts: 0,
    readVerified: false,
    sendVerified: false,
    sendChecks: [],
    usage: { calls: 0, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 },
    decisionDir: null,
    preview: null,
  };
}

function descriptorPreview(descriptor: SiteDescriptor): ChatDescriptorPreview {
  return {
    id: descriptor.id,
    hostPattern: String(descriptor.match?.hostPattern ?? "").slice(0, 200),
    readySelectors: (descriptor.ready?.allOf ?? []).slice(0, 8).map((item) => String(item).slice(0, 160)),
    rowSelector: String(descriptor.rows?.selector ?? "").slice(0, 200),
    composerSelectors: (descriptor.composer?.selectors ?? [])
      .slice(0, 8)
      .map((item) => String(item).slice(0, 160)),
    inputMethod: String(descriptor.composer?.input?.method ?? ""),
    sendMethod: String(descriptor.composer?.send?.method ?? ""),
    canAttach: Boolean(descriptor.composer?.attach),
  };
}

/** 失败清单：报错型（schema/选择器/条数）与静默失败（方向/内容/附件）都要露出来 */
function failingChecks(report: VerifyReport | null): VerifyCheck[] {
  if (!report) return [];
  return [...report.checks, ...report.silentFailures, ...report.threads]
    .filter((check) => !check.ok)
    .slice(0, REPORT_DIFF_LIMIT);
}

/**
 * 取得**可以安全操作**的页面。
 *
 * 两条来源，都不猜：
 *   ① 给了 `url` → 在**我们自己的**聊天标签里打开它（新开的是我们的标签，不劫持用户的）；
 *   ② 没给 → 只认此刻已经开着、且判定为聊天页的那个标签（只读它，不导航）。
 */
async function resolveLearnPage(
  input: ChatLearnInput,
): Promise<{ ok: true; page: Page; url: string } | { ok: false; reason: string }> {
  const url = String(input.url ?? "").trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "bad_url" };
    try {
      const { page } = await ensureChatPage(contextOf(input.browser));
      if (input.signal.aborted) return { ok: false, reason: "aborted" };
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return { ok: true, page, url: page.url() };
    } catch (error) {
      return {
        ok: false,
        reason: `open_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const found = await resolveCurrentConversation(input.browser, { signal: input.signal });
  if (!found.ok) return { ok: false, reason: found.reason };
  return { ok: true, page: found.conversation.page, url: found.conversation.url };
}

/** 学习一个站点：采集 → 推断 → 自检（可修正）→ 落盘。任何一步失败都如实汇报。 */
export async function learnSite(input: ChatLearnInput): Promise<ChatLearnResult> {
  const logger = input.logger;
  const emit = (message: string, extra?: Record<string, unknown>): void => {
    logger.chatProgress(message, { type: "chat_learn", ...(extra ?? {}) });
    input.onProgress?.(message, extra);
  };

  const pageResult = await resolveLearnPage(input);
  if (!pageResult.ok) {
    const summary = pageResult.reason.startsWith("open_failed")
      ? `学习失败：打不开目标页（${pageResult.reason.slice("open_failed:".length).slice(0, 160)}）`
      : pageResult.reason === "bad_url"
        ? "学习失败：地址不是 http(s) 链接"
        : pageResult.reason === "aborted"
          ? "学习已取消"
          : "学习失败：没找到可用的聊天页面（请先打开要学习的站点，或直接给出地址）";
    emit(summary, { reason: pageResult.reason, ok: false });
    return { ...emptyResult(), summary, outcome: pageResult.reason === "aborted" ? "cancelled" : "failed" };
  }

  const page = pageResult.page;
  const learnedDir = resolveLearnedConnectorDir(input.userDataDir);
  // 决策记录落在该环境自己的目录里（随环境删除一并清掉），**不**写进描述符目录
  const decisionDir = input.userDataDir ? join(input.userDataDir, "connectors", "_decisions") : null;
  const siteLabel = String(input.siteLabel ?? "").trim() || pageResult.url;

  const router = createModelRouter(input.aiSettings);
  const slot = input.slot === "fast_text" ? "fast_text" : "logic";
  const resolved = router.resolve(slot, slot === "logic" ? "站点学习：推理" : "站点学习：极速文本");
  const client = createLlmClient(input.aiSettings);

  /** 只暴露 `chat.completions.create`（发现管线不认 OpenAI SDK 的具体类型） */
  const inferClient: InferChatClient = {
    chat: {
      completions: {
        create: (body, options) =>
          withLlmRetry(() => client.chat.completions.create(body as never, { signal: options?.signal }), {
            signal: options?.signal ?? input.signal,
          }),
      },
    },
  };

  emit(`开始学习：${pageResult.url}`, { url: pageResult.url, slot });

  const recordDecision = (kind: "learn" | "verify" | "save", outcome: DecisionOutcome, reason: string): void => {
    if (!decisionDir) return;
    try {
      appendDecision(decisionDir, { at: new Date().toISOString(), kind, outcome, reason: reason.slice(0, 400) });
    } catch {
      // 决策记录失败不该改变学习结论；但**不静默**：日志里仍会留下这一行
      emit("决策记录写入失败（学习结论不受影响）", { reason: "decision_write_failed" });
    }
  };

  const result = await learnDescriptor({
    page,
    client: inferClient,
    model: resolved.model,
    siteLabel,
    maxRounds: input.maxRounds,
    signal: input.signal,
    onProgress: (progress) => {
      emit(`${progress.stage}｜${progress.message}`, {
        stage: progress.stage,
        round: progress.round,
        ...(progress.ok === undefined ? {} : { ok: progress.ok }),
      });
    },
  });

  const siteKey = result.capture.siteKey;
  const ledger: SpendLedger = addSlice(emptyLedger(), "infer", {
    calls: result.usage.calls,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    // 单价因模型而异：**不猜**价格（猜出来的数字比没有数字更坏），只记 0 并让视图说明
    costMicroUsd: 0,
  });
  const usage = { ...result.usage, costMicroUsd: totalsOf(ledger.slice).costMicroUsd };
  const checks = failingChecks(result.report);
  const schemaDiagnostics = result.report?.diagnostics ?? [];

  if (!result.ok || !result.descriptor) {
    const cancelled = input.signal.aborted;
    const summary = result.summary || "学习失败：没有拿到可用的描述符";
    emit(summary, { ok: false, checks: checks.length });
    recordDecision("learn", cancelled ? "skipped" : "rejected", summary);
    return {
      ...emptyResult(),
      outcome: cancelled ? "cancelled" : "rejected",
      summary,
      siteKey,
      checks,
      schemaDiagnostics,
      attempts: result.attempts.length,
      usage,
      decisionDir,
    };
  }

  /* ——— 写入自检（读通过 ≠ 写可用） ——— */
  let sendChecks: VerifyCheck[] = [];
  let sendVerified = false;
  const selfTestContact = input.selfTestContact ?? null;
  if (!selfTestContact) {
    emit("自检只验了「读」：没有给出写入自测对象，写入通路未验证（如实标注，不假装验过）", {
      reason: "send_self_test_skipped",
    });
  } else {
    try {
      // 写入自检走**同一份描述符**的连接器（不另写一套发送逻辑）
      const connector = createDomConnector({
        page,
        descriptor: { descriptor: result.descriptor, path: "(learned)", source: "learned" },
      });
      const roundtrip = await verifySendRoundtrip({
        contact: selfTestContact,
        connector,
        marker: Date.now().toString(36),
        signal: input.signal,
      });
      sendChecks = roundtrip.checks;
      sendVerified = roundtrip.ok;
      emit(roundtrip.summary, { reason: "send_self_test", ok: roundtrip.ok });
      recordDecision("verify", roundtrip.ok ? "sent" : "rejected", roundtrip.summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendChecks = [
        {
          field: "send.write",
          ok: false,
          severity: "fatal",
          expected: "能在自己的会话里跑一次写入自检",
          actual: `抛错：${message}`.slice(0, 200),
        },
      ];
      emit(`写入自检抛错：${message.slice(0, 200)}（不重试，避免刷屏）`, { reason: "send_self_test_failed", ok: false });
    }
  }

  /* ——— 落盘（没有目录就**只返回草案**，绝不写到一个猜出来的路径） ——— */
  if (!learnedDir) {
    const summary = "读自检通过，但没有可写的学习目录：草案未保存（缺少该环境的数据目录）";
    emit(summary, { ok: false, reason: "no_learned_dir" });
    recordDecision("learn", "skipped", summary);
    return {
      ...emptyResult(),
      outcome: "no_dir",
      summary,
      siteKey,
      descriptorId: result.descriptor.id,
      checks,
      attempts: result.attempts.length,
      readVerified: true,
      sendVerified,
      sendChecks,
      usage,
      decisionDir,
      preview: descriptorPreview(result.descriptor),
    };
  }

  const saved = saveLearnedDescriptor({
    dir: learnedDir,
    descriptor: result.descriptor,
    meta: {
      siteKey,
      siteLabel,
      savedAt: new Date().toISOString(),
      url: pageResult.url,
      rounds: result.attempts.length,
      readVerified: true,
      sendVerified,
      notes: result.attempts.at(-1)?.draft?.notes ?? [],
      usage: result.usage,
      verifySummary: result.report?.summary ?? result.summary,
    },
  });
  const summary = sendVerified
    ? `学习完成并已保存：${result.descriptor.id}（读、写都验过）`
    : `学习完成并已保存：${result.descriptor.id}（读已验过；写入未验证，如实标注）`;
  emit(summary, { ok: true, descriptorId: result.descriptor.id });
  recordDecision("save", "learn", summary);

  return {
    ok: true,
    outcome: "saved",
    summary,
    siteKey,
    descriptorId: result.descriptor.id,
    savedPaths: saved,
    checks,
    schemaDiagnostics,
    attempts: result.attempts.length,
    readVerified: true,
    sendVerified,
    sendChecks,
    usage,
    decisionDir,
    preview: descriptorPreview(result.descriptor),
  };
}

/* ————————————————————————— 站点支持总览（只读） ————————————————————————— */

export interface ConnectorStatusItem extends DescriptorListItem {
  /** 这个描述符是不是学来的（内置 vs 学习成果，视图要能一眼分清） */
  learned: boolean;
}

export interface ConnectorStatusResult {
  items: ConnectorStatusItem[];
  diagnostics: DescriptorDiagnostic[];
  builtinPresent: boolean;
  learnedDir: string | null;
  learnedDirReady: boolean;
}

/**
 * 列出当前可用的描述符（builtin + learned）与诊断（**内部实现**）。
 *
 * 只读、0 token。由 `listConnectorItemsDetailed` 调用，再经一次性 CLI 交给宿主/视图，
 * 回答「这个站现在到底能不能用、是内置还是学来的、为什么被熔断」。
 *
 * 两条诚实边界：
 *   - 内置目录全部缺失时**如实上报**（这是打包漏拷的信号，坑族 G），但不再把「某个候选目录不在」
 *     当成一条条错误 —— 候选目录本来就允许不存在。
 *   - 健康状态由调用方注入（熔断状态活在运行期，不在磁盘上）；不注入就如实显示为「无熔断记录」。
 */
function listConnectorStatus(
  userDataDir: string | null,
  healthOf: (id: string) => ConnectorHealth | null = () => null,
  learnedDirOverride?: string | null,
): ConnectorStatusResult {
  const builtinDirs = builtinConnectorDirs();
  const learnedDir = learnedDirOverride ?? resolveLearnedConnectorDir(userDataDir);
  const builtinPresent = connectorDirsPresent(builtinDirs);

  let loaded: ReturnType<typeof loadDescriptorDirs> = { descriptors: [], diagnostics: [] };
  try {
    loaded = loadDescriptorDirs({ builtinDirs, learnedDirs: learnedDir ? [learnedDir] : [] });
  } catch (error) {
    loaded = {
      descriptors: [],
      diagnostics: [
        {
          code: "load_failed",
          path: learnedDir ?? "",
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const diagnostics: DescriptorDiagnostic[] = loaded.diagnostics.filter((item) => {
    // 候选内置目录不存在是正常情况（不逐条报错）；但「一个内置目录都没有」单列在 builtinPresent
    if (item.code === "dir_missing" && builtinDirs.includes(item.path)) return false;
    return true;
  });
  if (!builtinPresent) {
    diagnostics.unshift({
      code: "builtin_dir_missing",
      path: builtinDirs[0] ?? "",
      reason: "一个内置描述符目录都不存在：打包时可能漏拷了 sidecar/connectors",
    });
  }

  const items: ConnectorStatusItem[] = listDescriptorItems(loaded.descriptors, healthOf).map((item) => ({
    ...item,
    learned: item.source === "learned",
  }));

  return {
    items,
    diagnostics,
    builtinPresent,
    learnedDir,
    learnedDirReady: learnedDir ? connectorDirsPresent([learnedDir]) : false,
  };
}

export interface ConnectorItemDetail extends ConnectorStatusItem {
  /**
   * 学来的描述符对应的**文件名干**（`删除` 要用它，不是 id）。
   *
   * 只对学来的项有值：文件名叫 `<siteKey>.json`，而描述符 id 可以是别的东西
   * （`whatsapp-web` 的文件名是 `whatsapp.com.json`）。约定由 `discovery/learn.ts` 一处拆好，
   * 视图**照抄**即可，不自己拆文件名（坑族 J：两套命名约定必然分叉）。
   */
  siteKey: string | null;
  /** 学来的描述符带上它的元数据（什么时候学的、读写各验过没有、自检结论） */
  meta: LearnedMeta | null;
}

export interface ConnectorItemsDetail {
  items: ConnectorItemDetail[];
  diagnostics: DescriptorDiagnostic[];
  builtinPresent: boolean;
  learnedDir: string | null;
  learnedDirReady: boolean;
}

/**
 * 站点支持明细（一次性 CLI 与命令都用这一份，**宿主不重写解析**）。
 *
 * 学来的项额外带上 `_meta-<siteKey>.json`：视图要能回答「这个站是学来的吗、读写了验过没、
 * 上一次自检结论是什么」。元数据读不到就如实 `null`（不编）。
 */
export function listConnectorItemsDetailed(userDataDir: string | null): ConnectorItemsDetail {
  const status = listConnectorStatus(userDataDir);
  const dir = status.learnedDir;
  const items: ConnectorItemDetail[] = status.items.map((item) => {
    // 学来的项：文件名干就是它的 siteKey（约定只在 learn.ts 里拆一次）
    const siteKey = item.learned ? siteKeyFromFileName(basename(item.path)) : null;
    let meta: LearnedMeta | null = null;
    if (item.learned && dir && siteKey) {
      try {
        meta = readLearnedMeta(dir, siteKey);
      } catch {
        meta = null;
      }
    }
    return { ...item, siteKey, meta };
  });
  return {
    items,
    diagnostics: status.diagnostics,
    builtinPresent: status.builtinPresent,
    learnedDir: status.learnedDir,
    learnedDirReady: status.learnedDirReady,
  };
}

export interface RemoveLearnedResult {
  ok: boolean;
  siteKey: string;
  reason: string | null;
  dir: string | null;
}

/**
 * 删除一个**学来的**描述符（含它的元数据）。
 *
 * 三条边界：① 没有目录 = 没东西可删（如实失败，不给假成功）；② 命名约定只在
 * `discovery/learn.ts` 一处（这里不自己拼文件名）；③ 内置描述符删不掉（升级会覆盖，删了也没意义）。
 */
export function removeLearnedSite(userDataDir: string | null, siteKeyRaw: string): RemoveLearnedResult {
  const siteKey = String(siteKeyRaw ?? "").trim();
  if (!siteKey) return { ok: false, siteKey, reason: "missing_site_key", dir: null };
  // fail-closed：siteKey 会参与拼路径，形状不对一律拒绝（不静默改名、不猜）
  if (!safeSiteKey(siteKey)) return { ok: false, siteKey, reason: "unsafe_site_key", dir: null };
  const dir = resolveLearnedConnectorDir(userDataDir);
  if (!dir) return { ok: false, siteKey, reason: "no_user_data_dir", dir: null };
  const removed = removeLearnedDescriptor(dir, siteKey);
  return { ok: removed, siteKey, reason: removed ? null : "not_found", dir };
}
