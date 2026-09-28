/**
 * 「读当前浏览器里那个聊天页的**会话列表**」（视图里勾选聊天对象的唯一入口）。
 *
 * 为什么单独一个模块：这是一次性的**只读**采读（不建会话、不落盘、不进引擎循环），
 * 与 `chat_actions.ts` 的页面原语、`chat_session.ts` 的耐久装配都不同类。放在这里，
 * 视图的「读取会话列表」按钮与将来的其它只读探针可以共用同一段「找页 → 采列表」的逻辑。
 *
 * 三条硬纪律（§0.5.3 A / H）：
 *   1. **只读**：不点击、不导航、不新开标签、不改 URL、不滚动（页内函数也没有这些动作）。
 *   2. **只说事实不说谎**：读不到就 `ok:false` + 人话原因，**绝不**把空列表说成「你没有会话」，
 *      也绝不把任意页面的链接当联系人（只认「有描述符 / 命中聊天站点画像 / 判定为聊天页」的页面）。
 *   3. **如实标注来源**：`source: "descriptor"`（站点声明的准）/ `"generic"`（通用启发式，是猜的），
 *      视图据此提示用户。
 */
import { existsSync } from "node:fs";

import type { Browser } from "playwright-core";

import {
  resolveCurrentConversation,
  type CurrentConversation,
} from "./chat_actions.js";
import {
  parseContactSeeds,
  seedIdentityOf,
  takeoverKeyOf,
} from "./chat_session_config.js";
import {
  builtinConnectorDirs,
  loadDescriptorDirs,
  pickDescriptor,
  resolveLearnedConnectorDir,
  type LoadedDescriptor,
} from "../core/web_chat/descriptor/registry.js";
import {
  extractThreads,
  mapThreads,
  THREAD_CANDIDATE_LIMIT,
} from "../core/web_chat/descriptor/threads.js";
import type { ThreadsSpec } from "../core/web_chat/descriptor/types.js";
import { contactDir } from "../core/web_chat/context_store.js";
import { sanitizeForLedger } from "../core/web_chat/chat_redaction.js";
import { loadChatSitePolicy, matchChatSiteProfile } from "../core/web_chat/site_detect.js";

export interface PageThreadItem {
  /** 稳定身份（站点属性 > 会话绝对地址 > 展示名指纹；展示名会变，不当主键） */
  key: string;
  label: string;
  /** 会话直链（很多站点的列表项没有 href；没有就用展示名在列表里点开） */
  url: string | null;
  /** 只报「有没有未读」，**不猜数字** */
  unread: boolean;
  /**
   * 这位联系人写进设置表时该用的键（`chat_mode.contactFlags` / `takeovers`，
   * 与 `takeoverKeyOf` 同一套拼法）。
   *
   * 为什么由侧车算而不是让视图自己拼：视图勾选后只会把 `label` / `url` 发回来
   * （`toChatContactInputs`），引擎那侧的键要用 `siteKeyOf` + `sanitizeSegment` 才算得出来 ——
   * 前端没有这两个函数（也不该有第二份实现）。键由权威一侧算好随列表回传，
   * 「在列表里关掉自动回复」才会真的作用到同一个人身上（§0.5.3 H）。
   * 算不出身份时为空串，视图**据此禁用**该行的开关（不写一个对不上的键）。
   */
  flagKey: string;
}

export interface PageThreadsResult {
  ok: boolean;
  /** 人话原因（`ok:false` 时必有；`ok:true` 时为 null） */
  reason: string | null;
  source: "descriptor" | "generic";
  /** 站点键（用于把勾选结果写成「本站点」的目标；读不到页面时为 `unknown`） */
  siteKey: string;
  /** 读的是哪个页面 —— 让用户能核对「读的是不是那个窗口」，也让误读一眼可见 */
  pageUrl: string | null;
  items: PageThreadItem[];
}

/**
 * 「会话列表里的一行」→ 引擎运行期会用的**设置表键**（视图写 `contactFlags` / `takeovers` 用）。
 *
 * 单独导出而非内联的两个理由：
 *   1. 身份算错 = 「在列表里关了自动回复，引擎照样开口」——这类错最容易发生也最难发现，必须能单测；
 *   2. 视图勾选后只回传 `{label, url}`（`toChatContactInputs`），所以这里就用引擎自己的
 *      `parseContactSeeds` + `seedIdentityOf` 走同一条路，两边不可能算出两个键（§0.5.3 H）。
 *
 * 算不出身份时返回空串：视图据此**禁用**这一行的开关，而不是写一个对不上的键。
 */
export function threadFlagKeyOf(
  item: { label: string; url: string | null },
  hasLegacyDir?: (siteKey: string, contactKey: string) => boolean,
): string {
  const seed = parseContactSeeds([{ label: item.label, url: item.url }])[0] ?? null;
  if (!seed) return "";
  return takeoverKeyOf(seedIdentityOf(seed, seed.key, hasLegacyDir).seed);
}

export interface ListPageThreadsOptions {
  /**
   * 该环境的 userDataDir（`browser-profiles/profile-{id}`）。
   * 只用于「旧目录沿用」判定（站点键从 `unknown` 改成派生值后不能把同一个人当新对象）。
   */
  userDataDir: string | null;
  /** 一次最多读多少条（上限由页内夹住） */
  limit?: number;
  signal?: AbortSignal;
  /** 采读过程的结构化留痕（诊断用；**绝不**包含消息正文） */
  onDiagnostic?: (code: string, detail: string) => void;
}

function safeUrlOf(page: { url: () => string }): string | null {
  try {
    const url = page.url();
    return /^https?:/i.test(url) ? url : null;
  } catch {
    return null;
  }
}

interface Candidate {
  page: CurrentConversation["page"];
  url: string;
  spec: ThreadsSpec | null;
  /** 排序用：描述符声明了 threads 的最准；命中聊天站点画像次之；只有描述符命中再次之 */
  rank: number;
  /** 来源标注（页面级判定给 generic；有 threads 声明给 descriptor） */
  source: "descriptor" | "generic";
  siteKey: string;
}

/**
 * 挑一个「值得读」的聊天页，并采一次会话列表。
 *
 * 候选排序（谁最像「用户要看的那张列表」）：
 *   ① 页面命中描述符**且描述符声明了 `threads`**（站点自己说了怎么读，最准）
 *   ② 页面命中聊天站点画像（`chat_sites.json`）
 *   ③ 页面命中任意描述符（已知聊天站，但没声明 threads → 走通用启发式）
 *   ④ 兜底：`resolveCurrentConversation` 判定的那个聊天页（覆盖没画像没描述符的站点）
 *
 * 一个候选都没采到时**如实失败**，把「扫过几个页面、各自为什么没读到」写进原因。
 */
export async function listPageThreads(
  browser: Browser,
  options: ListPageThreadsOptions,
): Promise<PageThreadsResult> {
  const policy = loadChatSitePolicy();
  const limit = Math.max(
    1,
    Math.min(THREAD_CANDIDATE_LIMIT, options.limit ?? THREAD_CANDIDATE_LIMIT),
  );
  /**
   * 「这位联系人在旧站点键下有没有对话记忆」——只用于把身份算准（旧目录沿用），
   * 判定口径与 `chat_session_context.ts::hasContactDir` **逐字相同**（同一套 `contactDir` 清洗）。
   * 没有 userDataDir（无记忆模式）时不做判定：那时引擎也不会找旧目录。
   */
  const legacyDirIn = (() => {
    const root = String(options.userDataDir ?? "").trim();
    if (!root) return undefined;
    return (siteKey: string, contactKey: string): boolean => {
      try {
        return existsSync(contactDir(root, siteKey, contactKey));
      } catch {
        // 目录名清洗异常 / 权限问题**不是**「旧目录在」的证据 —— 宁可当没有（派生新键），
        // 也不能因为一次异常就谎报「旧目录在」而把身份锁死在旧键上。
        return false;
      }
    };
  })();

  let descriptors: LoadedDescriptor[] = [];
  try {
    const learnedDir = resolveLearnedConnectorDir(options.userDataDir);
    const loaded = loadDescriptorDirs({
      builtinDirs: builtinConnectorDirs(),
      learnedDirs: learnedDir ? [learnedDir] : [],
    });
    descriptors = loaded.descriptors;
    for (const item of loaded.diagnostics) {
      // 诊断如实上报（缺目录 / 坏文件都不是「什么都没发生」）
      options.onDiagnostic?.(item.code, item.reason);
    }
  } catch (error) {
    options.onDiagnostic?.(
      "descriptor_load_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const candidates: Candidate[] = [];
  const seen = new Set<unknown>();
  const push = (candidate: Candidate): void => {
    if (seen.has(candidate.page)) return;
    seen.add(candidate.page);
    candidates.push(candidate);
  };

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (options.signal?.aborted) return empty("aborted", "unknown", null);
      const url = safeUrlOf(page);
      if (!url) continue;
      let closed = false;
      try {
        closed = page.isClosed();
      } catch {
        closed = true;
      }
      if (closed) continue;

      const loaded = pickDescriptor(descriptors, url, {});
      const spec = loaded?.descriptor.threads ?? null;
      const profile = matchChatSiteProfile(url, policy);
      if (!spec && !profile && !loaded) continue; // 认不出来的页面一律不读（不把任意链接当联系人）
      push({
        page,
        url,
        spec,
        rank: spec ? 3 : profile ? 2 : 1,
        source: spec ? "descriptor" : "generic",
        siteKey: loaded?.descriptor.id ?? profile?.id ?? "unknown",
      });
    }
  }

  // 兜底：没画像也没描述符的真·聊天页（完整的聊天页判定会更贵，只在需要时做一次）
  if (candidates.length === 0) {
    const resolved = await resolveCurrentConversation(browser, {
      policy,
      signal: options.signal,
    });
    if (resolved.ok) {
      push({
        page: resolved.conversation.page,
        url: resolved.conversation.url,
        spec: pickDescriptor(descriptors, resolved.conversation.url, {})?.descriptor.threads ?? null,
        rank: 0,
        source: "generic",
        siteKey: resolved.conversation.siteKey,
      });
    }
  }

  if (candidates.length === 0) {
    return empty(
      "no_open_chat_window",
      "unknown",
      null,
      "没有找到认得出来的聊天页面：请先把要读的聊天站点打开到这个环境里",
    );
  }

  candidates.sort((a, b) => b.rank - a.rank);
  const failures: string[] = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) return empty("aborted", candidate.siteKey, candidate.url);
    const probe = await extractThreads(candidate.page, {
      spec: candidate.spec,
      limit,
      signal: options.signal,
    });
    if (!probe.ok) {
      // 「没跑成」不等于「列表是空的」：如实记原因，继续看下一个候选
      failures.push(`${candidate.siteKey}：${probe.reason ?? "读不到"}`);
      continue;
    }
    const items = mapThreads(probe.items, { baseUrl: candidate.url, limit });
    if (items.length === 0 && probe.items.length > 0) {
      // 采到了行却一条都不可用 → 形状不匹配（不是「你没有会话」）
      failures.push(`${candidate.siteKey}：采到 ${probe.items.length} 行但都取不到稳定身份`);
      continue;
    }
    return {
      ok: true,
      reason: null,
      source: probe.source === "descriptor" ? "descriptor" : candidate.source,
      siteKey: candidate.siteKey,
      pageUrl: candidate.url,
      items: items.map((item) => {
        // 视图拿到的标签 == 视图会发回来的目标标签：先过统一脱敏（§1.3「一次性码用完即弃」），
        // 拿不到标签时退回 URL / 线程键（`mapThreads` 已保证非空，这里只是兜底）。
        // `|` 会被换成空格：目标在视图里是「昵称 | 会话URL」的文本格式，昵称里带 `|`
        // 会让「列表里看到的名字」与「真正发出去的目标名」不是同一个（身份就会对不上）。
        const label =
          sanitizeForLedger(item.label, 80).replace(/\|/g, " ").trim() ||
          item.url ||
          item.key;
        return {
          key: item.key,
          label,
          url: item.url,
          unread: item.unread,
          flagKey: threadFlagKeyOf({ label, url: item.url }, legacyDirIn),
        };
      }),
    };
  }

  return empty(
    "threads_unavailable",
    candidates[0]!.siteKey,
    candidates[0]!.url,
    failures.length > 0
      ? `读不到会话列表：${failures.join("；")}`
      : "读不到会话列表（页面结构与预期不符）",
  );
}

function empty(
  reason: string,
  siteKey: string,
  pageUrl: string | null,
  detail?: string,
): PageThreadsResult {
  return {
    ok: false,
    reason: detail ?? reason,
    source: "generic",
    siteKey,
    pageUrl,
    items: [],
  };
}
