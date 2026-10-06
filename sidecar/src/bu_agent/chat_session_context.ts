/**
 * 每联系人上下文层（`chat_context/{site}/{contact}/` 的读写接线，§4.4）。
 *
 * 为什么单独一个模块：这一段是「聊天记得住对方说过什么」的唯一来源，规则很集中 ——
 *   - 根目录是 `<userDataDir>/chat_context`（**每环境一份**，环境删掉记忆一并清掉，不串号）；
 *   - 没有 `userDataDir` 时退化为「无记忆模式」：能跑，但不回访、不记历史，且**必须记日志**
 *     （不谎报、不伪造记忆）；
 *   - 「本会话已发过什么」从磁盘冷启动（磁盘是权威，缓存只是加速）；
 *   - 回访事实（`visit.json`）是**耐久权威**，快照里缺字段时用它补（§0.5.3 H）。
 *
 * 本层只做机械读写，不做任何决策（要不要发、发几次都在引擎 + 纯函数模块里）。
 */
import type { JsonLogger } from "../json-logger.js";
import { existsSync } from "node:fs";
import {
  contactDir,
  listContactDirs,
  readThreadMessages,
  readVisitState,
  sanitizeSegment,
  type VisitState,
} from "../core/web_chat/context_store.js";
import type { ChatContactState } from "../core/web_chat/state.js";

export interface ContextLayerInput {
  logger: JsonLogger;
  /** 该环境的 userDataDir（`browser-profiles/profile-{id}`）；缺失即无记忆模式 */
  userDataDir: string | null;
}

export interface ContextLayer {
  /** 上下文根；`null` = 无记忆模式 */
  root: string | null;
  /** 联系人 → 其上下文目录（无 userDataDir 时为 null） */
  dirOf: (contact: { key: string; siteKey: string }) => string | null;
  /** 上下文内的排序键（与目录名一致，用于跨联系人对比） */
  cacheKeyOf: (contact: { key: string; siteKey: string }) => string;
  /**
   * 该联系人在**旧站点键**（`unknown`）下是否已经有对话记忆。
   *
   * 用途只有一个：站点键从「一律 `unknown`」改成「从 URL 派生」之后，**老用户的目录还在
   * `unknown/<联系人>/`**。若直接按新键找目录，等于把已聊过的记忆丢掉 —— 同一个人会被当
   * 新对象**重新开场**（R7 里最典型的刷屏事故）。所以调用方在派生站点键之前先问一句：
   * 旧目录在不在？在就沿用旧键（读旧写旧），并记一条日志说明。
   */
  hasContactDir: (siteKey: string, contactKey: string) => boolean;
  loadSentCache: () => Map<string, string[]>;
  rememberSent: (contact: { key: string; siteKey: string }, text: string) => void;
  /** 某联系人的耐久回访事实（`visit.json`）；没有目录 / 没有文件 → `null`（不猜） */
  visitOf: (contact: { key: string; siteKey: string }) => VisitState | null;
  hydrateFromVisit: (
    state: ChatContactState,
    visit: VisitState | null,
  ) => Partial<ChatContactState>;
}

export function createContextLayer(input: ContextLayerInput): ContextLayer {
  const { logger } = input;

  /**
   * 每联系人上下文根（`<userDataDir>/chat_context`）。
   *
   * 缺失即退化为「无记忆模式」：能跑，但不回访、不记住对方说过什么。
   * 这是**可接受的降级**（不谎报、不伪造记忆），但要写进日志让人看得见。
   */
  const root = String(input.userDataDir ?? "").trim() || null;
  if (!root) {
    logger.chatProgress("未拿到 userDataDir：聊天将在无记忆模式下运行", {
      type: "chat_context_unavailable",
      phase: "booting",
      threadKey: null,
    });
  }

  /** 联系人 → 其上下文目录（无 userDataDir 时为 null） */
  const dirOf = (contact: { key: string; siteKey: string }): string | null =>
    root ? contactDir(root, contact.siteKey, contact.key) : null;

  /** 上下文内的排序键（与目录名一致，用于跨联系人对比） */
  const cacheKeyOf = (contact: { key: string; siteKey: string }): string =>
    `${sanitizeSegment(contact.siteKey)}|${sanitizeSegment(contact.key)}`;

  /**
   * 「本会话已发过什么」的缓存：**从磁盘冷启动**，避免每次生成草稿都全量读盘。
   * 磁盘才是权威（重启后仍能避免复读同一句开场白），缓存只是加速。
   */
  let sentCache: Map<string, string[]> | null = null;
  const loadSentCache = (): Map<string, string[]> => {
    if (sentCache) return sentCache;
    const map = new Map<string, string[]>();
    if (root) {
      for (const ref of listContactDirs(root)) {
        const outbound = readThreadMessages(ref.dir, 200)
          .filter((entry) => entry.direction === "out")
          .map((entry) => entry.text);
        map.set(`${ref.siteKey}|${ref.contactKey}`, outbound.slice(-50));
      }
    }
    sentCache = map;
    return map;
  };

  const rememberSent = (contact: { key: string; siteKey: string }, text: string): void => {
    const map = loadSentCache();
    const key = cacheKeyOf(contact);
    map.set(key, [...(map.get(key) ?? []), text].slice(-50));
  };

  /** 该联系人在某个站点键下是否已经有上下文目录（用于「旧 `unknown/` 目录沿用」判定） */
  const hasContactDir = (siteKey: string, contactKey: string): boolean => {
    if (!root) return false;
    try {
      return existsSync(contactDir(root, siteKey, contactKey));
    } catch {
      // 目录名清洗异常 / 权限问题不是「有记忆」的证据 —— 宁可当没有（派生新键），
      // 也不能因为一次异常就谎报「旧目录在」而锁死在旧键上。
      return false;
    }
  };

  /** 某联系人的耐久回访事实（`visit.json`）；没有上下文目录 / 没有文件 → `null`（不猜） */
  const visitOf = (contact: { key: string; siteKey: string }): VisitState | null => {
    const dir = dirOf(contact);
    return dir ? readVisitState(dir) : null;
  };

  /**
   * 用磁盘上的回访事实**补**快照联系人（只补空缺，不覆盖已算好的新值）。
   *
   * 为什么必须补：`dueContacts` / `computeNextWakeAt` 只读快照字段。快照里没有这个联系人
   * （键变过 / 刚清过上下文 / 老快照）时 `nextDueAt` 就是 null → 下次唤醒退化成
   * `followUpHours`（默认 48 小时）→ 用户看到「发完一条就结束了」（§0.5.3 H）。
   * 权威始终在 `visit.json`，快照只是索引。
   */
  const hydrateFromVisit = (
    state: ChatContactState,
    visit: VisitState | null,
  ): Partial<ChatContactState> => {
    if (!visit) return {};
    const patch: Partial<ChatContactState> = {};
    if (!state.nextDueAt && visit.nextDueAt) patch.nextDueAt = visit.nextDueAt;
    if (!state.followUpIndex && visit.followUpIndex > 0) patch.followUpIndex = visit.followUpIndex;
    if (!state.stopped && visit.stopped) {
      patch.stopped = true;
      patch.stopReason = state.stopReason ?? visit.stopReason;
    }
    if ((visit.suspectedTradeCount ?? 0) > (state.suspectedTradeCount ?? 0)) {
      patch.suspectedTradeCount = visit.suspectedTradeCount;
    }
    return patch;
  };

  return {
    root,
    dirOf,
    cacheKeyOf,
    hasContactDir,
    loadSentCache,
    rememberSent,
    visitOf,
    hydrateFromVisit,
  };
}
