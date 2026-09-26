/**
 * 交付物验证器（Deliverable Verifiers）
 *
 * 职责：判断**某一个交付物**是否已经达成。与 completion_evidence（整体完成度）互补：
 *   - completion_evidence 回答「轨迹里有没有可验证的副作用」；
 *   - 本模块回答「目标要求的第 3 项（比如『下载第二张图片』）到底做完了没有」。
 *
 * 设计原则（与项目宪法一致）：
 *   1. **确定性优先**：能从客观事实（台账事实 / URL / 页面信号 / 落盘产物）判出来，就绝不问模型。
 *      8 个 kind 各有自己的确定性验证器，判定结果明确返回「成立 / 不成立 / 不确定」三态。
 *   2. **不确定才花钱**：只有三态里落到「不确定」且该项必交时，上层才用一次 llm_judge 兜底追问，
 *      且次数受预算限制（见 task_contract 的 judgementsLeft）。
 *   3. **宁可漏判不可错杀**：判不出就返回 null（不确定），把决定权交给证据闸门与模型，
 *      绝不用一个猜出来的「不成立」把正常任务卡死。
 *   4. 零站点文案：只比对 URL、结构化事实与页面信号，不做任何站点特定假设。
 */
import type { EvidenceFact, EvidenceLedger, PageSignals } from "./completion_evidence.js";
import {
  findPaymentClaim,
  goalDemandsHumanPayment,
  goalStopsBeforePay,
  loadCompletionLexicon,
  usableStrongSignals,
  type GoalIntent,
} from "./completion_evidence.js";
import { isContentPageUrl } from "./url_match.js";
import { normalizeHaystack, termHit } from "./text_match.js";
import type { DeliverableKind, DeliverableSpec } from "../bu_agent/task_contract.js";

export type VerifierName = DeliverableKind | "llm_judge";

/** 三态结论：true=确认达成；false=确认未达成；null=判不出来（不猜） */
export type VerifierOk = boolean | null;

export interface VerifierResult {
  ok: VerifierOk;
  verifier: VerifierName;
  /** 人类可读依据（会写进台账、回喂模型、展示给用户） */
  reason: string;
}

  /** 落盘产物（下载/保存类交付物的客观证据） */
export interface ArtifactRecord {
  kind: "download" | "file";
  /** 文件名或路径（能做线索比对） */
  name: string;
  /** 来源 URL（若有） */
  url: string;
  step: number;
  /**
   * 这次保存的是页面上第几个内容资源（从 1 起）。
   * 「下载第二张」只落一个文件时，靠这个序号核销，而不是要求先下满两张。
   */
  ordinal?: number;
}

export interface VerifierContext {
  goal: string;
  ledger: EvidenceLedger;
  currentUrl: string;
  currentTitle?: string;
  /** 当前页文案信号；缺省表示调用方没扫页面（步骤内轻量核销） */
  signals?: PageSignals;
  /** 当前页可交互元素文案（用于 element_state / navigation 的语义比对） */
  visibleLabels?: string[];
  /** 本任务已落盘的产物 */
  artifacts?: ArtifactRecord[];
  /** done 的自述结论（answer_given 用） */
  claim?: string;
  /** 判定「结论是否算实质」的字数门槛 */
  minClaimChars?: number;
  /** 本步动作**开始前**的 URL；未知传 undefined（submitted 用） */
  stepStartUrl?: string;
  /** 本步动作名；缺省表示调用方没提供（submitted 会退化为"判不出来"） */
  stepActionNames?: readonly string[];
  /**
   * 当前页**就是本任务检索词的搜索引擎结果页**。
   * 由主循环每步算出（`page_kind.serpLike` ∩ 页面上出现任务检索词），判据来自
   * `search_engines.json` 配置与任务自己的检索词，不含任何站点文案 —— submitted 用。
   */
  serpForQuery?: boolean;
  /**
   * `visibleLabels` / `currentTitle` 是**哪一页**的观测结果（= 上一轮观察时的 URL）。
   * 与 `currentUrl` 不一致时说明本步动作已经把页面带走了，那些文案属于**旧页面**，
   * 不能再拿来当当前页的证据 —— 用户现场：`navigate about:blank` 之后仍用百度首页的
   * 控件文案命中了「到达结果页」的线索，凭空核销了一项交付物。
   */
  observedUrl?: string;
  /**
   * P0 目标意图（`outcome` / `informational` / `generic`）。
   * 信息型目标的阅读对象就是当前页，navigation 交付物对它没有意义 —— verifyNavigation
   * 据此返回「不确定」而不是「确认未达成」（见 verifyNavigation 注释）。
   * 缺省（老调用路径/单测）视为 generic，行为与改造前一致。
   */
  goalIntent?: GoalIntent;
}

/**
 * 当前页是不是一个「能承载证据」的页面（空页 / 浏览器内部页不算）。
 * 判据与 `navigate` 的地址校验**共用同一份**：两处判错都会造成事故，
 * 一旦分家就会一处处死、一处放行。
 */
const isRealPage = (ctx: VerifierContext): boolean => isContentPageUrl(ctx.currentUrl ?? "");

function factsOf(ledger: EvidenceLedger, kinds: string[]): EvidenceFact[] {
  return ledger.facts.filter((f) => kinds.includes(f.kind));
}

function lastFact(ledger: EvidenceLedger, kinds: string[]): EvidenceFact | null {
  for (let i = ledger.facts.length - 1; i >= 0; i -= 1) {
    const fact = ledger.facts[i]!;
    if (kinds.includes(fact.kind)) return fact;
  }
  return null;
}

/**
 * 线索是否出现在「当前页可获得的一切文本」里（URL / 标题 / 交互文案 / 页面文案）。
 *
 * 页面已经在本次动作里被带走了（观测 URL ≠ 当前 URL）或当前页根本不是网页时，
 * 只认 URL 自己 —— 旧页面残留的文案不能当作「当前页的证据」。
 */
function hintSeen(hints: string[], ctx: VerifierContext): string | null {
  if (hints.length === 0) return null;
  const fresh =
    isRealPage(ctx) &&
    (!ctx.observedUrl || ctx.observedUrl === ctx.currentUrl);
  const hay = normalizeHaystack(
    [
      ctx.currentUrl,
      ...(fresh ? [ctx.currentTitle ?? "", ...(ctx.visibleLabels ?? [])] : []),
    ].join(" \n "),
  );
  for (const hint of hints) {
    const term = normalizeHaystack(hint);
    if (!term) continue;
    if (termHit(hay, term)) return hint;
  }
  return null;
}

/** 线索是否出现在证据事实的 detail 里（如「写入的字段标签」） */
function hintInFacts(hints: string[], facts: EvidenceFact[]): string | null {
  if (hints.length === 0) return null;
  const hay = normalizeHaystack(facts.map((f) => f.detail).join(" \n "));
  for (const hint of hints) {
    const term = normalizeHaystack(hint);
    if (term && termHit(hay, term)) return hint;
  }
  return null;
}

const leftStartPage = (ctx: VerifierContext): boolean =>
  isRealPage(ctx) &&
  Boolean(ctx.currentUrl && ctx.ledger.startUrl && ctx.currentUrl !== ctx.ledger.startUrl);

function verifyNavigation(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  if (!isRealPage(ctx)) {
    return {
      ok: false,
      verifier: "navigation",
      reason: `当前页不是可加载的网页（${ctx.currentUrl || "空白"}），不能当作「到达目标页」的证据`,
    };
  }
  const nav = lastFact(ctx.ledger, ["navigated"]);
  const moved = leftStartPage(ctx) || Boolean(nav);
  if (!moved) {
    /*
     * 信息型目标（总结/分析/介绍当前页）**从不需要导航** —— 阅读对象就是当前页。
     * 这类任务里出现 navigation 交付物本身就是契约瑕疵（历史事故：模型给一句总结文案
     * 标上 kind=navigation，于是「页面从未离开起始地址」被永久判未达成，done 被反复驳回，
     * 任务原地打转）。此时返回「不确定」而不是「确认未达成」：不猜测、也绝不用它把任务判死；
     * 真正的拦截已由 task_contract 的契约闸门在源头完成。
     */
    if (ctx.goalIntent === "informational") {
      return {
        ok: null,
        verifier: "navigation",
        reason: "信息型目标不要求导航（阅读对象即当前页），不能据此判定该项未达成",
      };
    }
    const seenNow = hintSeen(spec.hints, ctx);
    if (spec.hints.length > 0 && seenNow) {
      return { ok: true, verifier: "navigation", reason: `当前已在目标页（页面命中线索「${seenNow}」）` };
    }
    return { ok: false, verifier: "navigation", reason: "页面从未离开起始地址，未到达目标页" };
  }
  if (spec.hints.length === 0) {
    return { ok: true, verifier: "navigation", reason: `已导航至 ${ctx.currentUrl.slice(0, 80)}` };
  }
  const seen = hintSeen(spec.hints, ctx);
  if (seen) return { ok: true, verifier: "navigation", reason: `已到达目标页（命中线索「${seen}」）` };
  // 跳转过但看不出是否为目标页 → 不猜
  return { ok: null, verifier: "navigation", reason: "页面已跳转，但线索未出现在当前页，无法确认是否为目标页" };
}

function verifyContentRead(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const fact = lastFact(ctx.ledger, ["content_extracted", "page_digest"]);
  if (fact) return { ok: true, verifier: "content_read", reason: `已取得页面内容（第 ${fact.step} 步：${fact.detail || "读取成功"}）` };
  if (ctx.ledger.pageDigestChars > 0) {
    return { ok: true, verifier: "content_read", reason: `已获得页面阅读摘要（${ctx.ledger.pageDigestChars} 字）` };
  }
  const seen = hintSeen(spec.hints, ctx);
  if (seen) return { ok: true, verifier: "content_read", reason: `当前页命中线索「${seen}」（内容就在眼前）` };
  return { ok: null, verifier: "content_read", reason: "轨迹里没有读取/提取页面内容的事实" };
}

function verifyFieldFilled(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const fills = factsOf(ctx.ledger, ["fill_verified"]);
  if (fills.length === 0) {
    return { ok: null, verifier: "field_filled", reason: "轨迹里没有「写入并回读确认」的事实" };
  }
  if (spec.hints.length === 0) {
    return { ok: true, verifier: "field_filled", reason: `字段写入已回读确认（第 ${fills[0]!.step} 步）` };
  }
  const hit = hintInFacts(spec.hints, fills);
  if (hit) return { ok: true, verifier: "field_filled", reason: `目标字段「${hit}」写入并回读确认` };
  return { ok: null, verifier: "field_filled", reason: "有字段写入事实，但无法确认写的是本项要求的字段" };
}

function verifyChoiceMade(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const fact = lastFact(ctx.ledger, ["choice_changed"]);
  if (fact) return { ok: true, verifier: "choice_made", reason: `勾选状态已发生可验证变化（${fact.detail}）` };
  return { ok: null, verifier: "choice_made", reason: "轨迹里没有勾选/单选状态变化的证据" };
}

/**
 * 加购 / 到达收银台 / 待支付。
 * 只核销「停在支付前」。页面上的「已下单 / 已付款」不能拿来勾掉这一项。
 */
function verifyPrepayReached(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const lexicon = loadCompletionLexicon();
  const demand = goalDemandsHumanPayment(ctx.goal, lexicon);
  if (demand && ctx.ledger.humanPaymentConfirmed !== true) {
    return {
      ok: false,
      verifier: "prepay_reached",
      reason: `目标含「${demand}」，未人工确认支付，不能把加购或收银台核销成已付款`,
    };
  }
  const claimHit = findPaymentClaim(ctx.claim ?? "", lexicon);
  if (claimHit && ctx.ledger.humanPaymentConfirmed !== true) {
    return {
      ok: false,
      verifier: "prepay_reached",
      reason: `结论使用「${claimHit}」冒充完成；合法证据是已加购 / 已达收银台 / 待支付`,
    };
  }
  const prePay = ctx.signals?.prePay ?? [];
  if (prePay.length > 0 && goalStopsBeforePay(`${ctx.goal} ${spec.text}`, lexicon)) {
    return {
      ok: true,
      verifier: "prepay_reached",
      reason: `已停在支付前（${prePay.join(" / ")}），不是已付款`,
    };
  }
  return { ok: null, verifier: "prepay_reached", reason: "尚未看到已加购 / 已达收银台 / 待支付的页面证据" };
}

/**
 * 「会提交表单」的动作。
 *
 * 刻意**不含** `navigate` / `go_back`：它们是"我要去某个地址"，语义上永远不是提交。
 * 改造前的判据只是"URL 变了"，于是一次纯导航就能把 `submitted` 交付物凭空勾掉
 * （用户现场：重规划后 navigate 回引擎首页，反而核销了"已提交搜索"）。
 */
const SUBMIT_ACTIONS = new Set(["send_keys", "click"]);

function verifySubmitted(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const signals = ctx.signals;
  const lexicon = loadCompletionLexicon();
  const strong = signals ? usableStrongSignals(signals, lexicon) : [];
  if (strong.length > 0) {
    return { ok: true, verifier: "submitted", reason: `页面出现完成提示：${strong.join(" / ")}` };
  }
  const failed = signals?.failure ?? [];
  if (failed.length > 0) {
    return { ok: false, verifier: "submitted", reason: `页面存在失败/校验提示：${failed.join(" / ")}` };
  }

  /*
   * 确定性判据：**在刚填过表单的那个页面上做了提交型动作，并且确实离开了那一页**。
   *
   * 三个条件缺一不可：
   *   ① 本步含提交型动作（send_keys / click）—— 或本步是**纯观察**步（提交的落地可能在下一步才可见）；
   *   ② `lastFillUrl === stepStartUrl`：被离开的那一页**就是**刚填过表的页面。
   *      这条是防误认的关键：少了它，任何一次普通点击（搜索结果 → 词条页）都会被当成"提交"。
   *   ③ 页面确实离开了该地址。
   *
   * 为什么不用「URL 变过就算」：改造前就是这么写的，方向是反的 ——
   * 同批动作里的跳转会把基准擦掉（真提交永不成立），之后一次无关 navigate 又让它莫名成立。
   */
  const names = ctx.stepActionNames;

  /*
   * 最直接的证据：**人已经站在「本次检索词的结果页」上** —— 这正是 submitted 类交付物
   * （"在 X 搜索 Y 并到达结果页"）要的状态，不需要任何 URL 差分推演。
   *
   * 为什么必须放在推演之前：推演依赖「本步动作 + 基准页」，而提交的落地常晚于动作本身
   * （用户现场：百度首页 input 后提交动作报 stale-index，结果页却在十几秒后才出现 →
   * 推演既拿不到提交动作、又拿不到回读基准，交付物永远核销不了，
   * 于是 done 闸门判「未完成」→ 重写剩余计划 → 把已到达的结果页丢掉回首页重搜）。
   */
  if (ctx.serpForQuery) {
    return { ok: true, verifier: "submitted", reason: "当前页已是本次检索词的搜索引擎结果页" };
  }

  if (!names) {
    return { ok: null, verifier: "submitted", reason: "调用方未提供本步动作，无法判断是否发生过提交" };
  }
  const stepStart = ctx.stepStartUrl;
  const fillUrl = ctx.ledger.lastFillUrl;
  if (!stepStart || !fillUrl) {
    return { ok: null, verifier: "submitted", reason: "没有「填写时所在页面」的基准，无法确认提交已生效" };
  }
  const didSubmit = names.some((name) => SUBMIT_ACTIONS.has(name));
  const observationOnly = names.length === 0;
  const leftTheFilledPage = Boolean(ctx.currentUrl && ctx.currentUrl !== stepStart);
  if (fillUrl === stepStart && (didSubmit || observationOnly) && leftTheFilledPage) {
    return {
      ok: true,
      verifier: "submitted",
      reason: `提交后已离开表单页（${stepStart.slice(0, 60)} → ${ctx.currentUrl.slice(0, 60)}）`,
    };
  }
  return { ok: null, verifier: "submitted", reason: "没有提交成功的外部迹象（页面未跳转、无成功提示）" };
}

/** 从线索里取出序数要求（第2张 / 第 2 项 / 前三条 → 2 或 3） */
const ORDINAL_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

export function ordinalHint(hints: string[]): number | null {
  for (const hint of hints) {
    const match = String(hint).match(/第\s*([一二两三四五六七八九十\d]+)|前\s*([一二两三四五六七八九十\d]+)/);
    const raw = match?.[1] ?? match?.[2] ?? "";
    if (!raw) continue;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n > 0) return n;
      continue;
    }
    if (ORDINAL_DIGITS[raw]) return ORDINAL_DIGITS[raw]!;
  }
  return null;
}

function verifyDownload(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const artifacts = (ctx.artifacts ?? []).filter((a) => a.kind === "download");
  const fact = lastFact(ctx.ledger, ["file_downloaded"]);
  if (artifacts.length === 0 && !fact) {
    return { ok: false, verifier: "download", reason: "本次任务没有任何文件下载/落盘记录" };
  }
  const names = artifacts.map((a) => a.name).join(" \n ") + (fact ? ` \n ${fact.detail}` : "");
  const ordinal = ordinalHint(spec.hints);
  if (ordinal != null && artifacts.some((item) => item.ordinal === ordinal)) {
    const named = artifacts.find((item) => item.ordinal === ordinal);
    return {
      ok: true,
      verifier: "download",
      reason: `已落盘第 ${ordinal} 项：${(named?.name ?? "").slice(0, 80)}`,
    };
  }
  // 没有序号标记时，退回「数量够了」（一次下多张也能满足「第 N 张」）
  if (ordinal != null && artifacts.length >= ordinal) {
    return { ok: true, verifier: "download", reason: `已落盘 ${artifacts.length} 个文件，满足「第 ${ordinal} 个」的要求` };
  }
  if (spec.hints.length === 0) {
    const shown = names.trim().slice(0, 80);
    return { ok: true, verifier: "download", reason: `已产出文件：${shown}` };
  }
  const hay = normalizeHaystack(names);
  const hit = spec.hints.find((hint) => {
    const term = normalizeHaystack(hint);
    return term ? termHit(hay, term) : false;
  });
  if (hit) return { ok: true, verifier: "download", reason: `已下载目标文件（文件名/来源命中线索「${hit}」）` };
  // 下载过别的东西不等于交付了这一项：没有数量或命名证据时判为不确定，交给上层兜底判定
  return { ok: null, verifier: "download", reason: `有下载记录，但无法确认是本项要求的对象：${names.trim().slice(0, 80)}` };
}

function verifyElementState(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const seen = hintSeen(spec.hints, ctx);
  if (seen) return { ok: true, verifier: "element_state", reason: `当前页已处于该项要求的状态（命中线索「${seen}」）` };
  const fact = lastFact(ctx.ledger, ["navigated", "choice_changed", "overlay_cleared"]);
  if (fact) {
    return {
      ok: null,
      verifier: "element_state",
      reason: `页面发生过变化（第 ${fact.step} 步 ${fact.kind}），但看不到该项线索，无法确认目标栏目已打开`,
    };
  }
  // 只要发生过「会改变页面状态」的动作，就不能断言「没打开」——可能是同页切换、异步渲染。
  // 判不出来就交上层兜底（llm_judge），不在这里用猜测把任务打回。
  if (ctx.ledger.lastMutationStep >= 0) {
    return {
      ok: null,
      verifier: "element_state",
      reason: `第 ${ctx.ledger.lastMutationStep} 步执行过状态变更动作，但当前页看不到该项线索，无法确认`,
    };
  }
  return { ok: false, verifier: "element_state", reason: "页面没有任何状态变化，目标栏目/状态未被打开" };
}

function verifyAnswerGiven(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const claim = String(ctx.claim ?? "").trim();
  const min = ctx.minClaimChars ?? 30;
  // 把页面阅读脚本原文整段贴进 done = 没写结论
  if (/【页面阅读】/.test(claim) || /类型\s*=\s*serp\s*·\s*引擎\s*=/.test(claim)) {
    return {
      ok: false,
      verifier: "answer_given",
      reason: "结论像是把页面阅读原文整段粘贴进来了；请用自己的话写总结/分析后再 done",
    };
  }
  if (claim.length >= min) {
    return { ok: true, verifier: "answer_given", reason: `结论正文 ${claim.length} 字（≥ ${min} 字门槛）` };
  }
  return { ok: false, verifier: "answer_given", reason: `结论正文过短（${claim.length} < ${min} 字），没有实质交付` };
}

const VERIFIERS: Record<DeliverableKind, (spec: DeliverableSpec, ctx: VerifierContext) => VerifierResult> = {
  navigation: verifyNavigation,
  content_read: verifyContentRead,
  field_filled: verifyFieldFilled,
  choice_made: verifyChoiceMade,
  prepay_reached: verifyPrepayReached,
  submitted: verifySubmitted,
  download: verifyDownload,
  element_state: verifyElementState,
  answer_given: verifyAnswerGiven,
};

/** 单个交付物的确定性判定（绝不呼叫模型） */
export function verifyDeliverable(spec: DeliverableSpec, ctx: VerifierContext): VerifierResult {
  const verifier = VERIFIERS[spec.kind];
  if (!verifier) {
    return { ok: null, verifier: spec.kind, reason: `未实现 ${spec.kind} 的验证器（先当作不确定处理）` };
  }
  try {
    return verifier(spec, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: null, verifier: spec.kind, reason: `验证器异常（不阻断任务）：${message}` };
  }
}

export interface BatchVerdict {
  spec: DeliverableSpec;
  result: VerifierResult;
}

/** 批量判定；只对 required 项做（可选项不作为闸门，仅记账） */
export function verifyDeliverables(specs: DeliverableSpec[], ctx: VerifierContext): BatchVerdict[] {
  return specs.map((spec) => ({ spec, result: verifyDeliverable(spec, ctx) }));
}

/** 是否有任何一项被**确定性否认**（确认未达成）—— 这是 done 闸门最有力的信息 */
export function deniedVerdicts(verdicts: BatchVerdict[]): BatchVerdict[] {
  return verdicts.filter((v) => v.result.ok === false);
}

/** 不确定项：确定性判不出来，可交给 llm_judge 兜底 */
export function uncertainVerdicts(verdicts: BatchVerdict[]): BatchVerdict[] {
  return verdicts.filter((v) => v.result.ok === null);
}
