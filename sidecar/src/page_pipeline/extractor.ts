/**
 * Extractor：索引 DOM 蒸馏 + CDP 无障碍树兜底摘要。
 */
import type { CDPSession, Page } from "playwright-core";

import { extractAgentInteractiveTree } from "../interactive_elements.js";
import {
  applyDistillToExtract,
  computeStructureHash,
  type DistilledExtract,
} from "../page_distill.js";
import type { AgentSenseMode } from "../llm_budget.js";
import { buildAffinityIndex, buildAffinityPeers, emptyAffinityReport, resolveAffinities } from "../core/target_affinity.js";
import { PAGE_PIPELINE_CONFIG } from "./config.js";

/** 无障碍树里的一个节点（结构化，供决策层做页面分类用） */
export interface A11yRoleNode {
  role: string;
  name: string;
}

/**
 * 无障碍树的**结构化**视图（Phase 4.1a：只读透传，不改主观察树）。
 *
 * 与 `a11ySummary` 的关系：同一次 `Accessibility.getFullAXTree` 调用产出两者 ——
 * 文本摘要给人/模型看，结构化视图给**代码**看（页面分类、控件存在性核对）。
 * 刻意**不带任何编号**：交互元素的编号只能有一个来源（观察层的 index 空间），
 * a11y 若自带序号就会出现「a11y 一套号、DOM 一套号」的经典错位。
 */
export interface A11yStructure {
  roles: A11yRoleNode[];
  /** role → 节点数（页面分类最省事的输入） */
  roleCounts: Record<string, number>;
  /** 交互类节点总数（button/link/textbox/…）：用于与 index 空间规模做粗核对 */
  interactiveCount: number;
  /** 采集时的 index 空间规模（同一轮观察里模型能点的元素数） */
  indexSpace: number;
}

/** 交互类 role：与 a11ySummary 的过滤规则同源，保证两路输出看到的是同一批节点 */
const A11Y_INTERACTIVE_RE =
  /button|link|textbox|search|checkbox|radio|combobox|heading|dialog|menuitem|tab|switch/i;

const A11Y_ROLE_LIST_MAX = 120;
const A11Y_ROLE_NAME_CHARS = 80;

export interface ExtractObservationResult {
  extract: DistilledExtract;
  structureHash: string;
  a11ySummary: string | null;
  /** Phase 4.1a：无障碍树的结构化视图（只读；不进模型提示词，不参与决策） */
  a11yStructure: A11yStructure | null;
  /** 采集元素矩形时的视口尺寸（CSS px）；供 SoM 标记排序使用 */
  viewport: { width: number; height: number } | null;
  /** 意图→目标关联仲裁统计（供日志解释「这轮纠正了多少条同行歧义」） */
  affinity: { peers: number; links: number; rescued: number; reasons: Record<string, number> } | null;
  error: string | null;
}

export async function extractAndDistill(
  page: Page,
  opts?: {
    goal?: string;
    senseMode?: AgentSenseMode;
    includeScreenshot?: boolean;
    signal?: AbortSignal;
  },
): Promise<ExtractObservationResult> {
  if (opts?.signal?.aborted) {
    throw new Error("提取已中止");
  }

  try {
    const extractMs = PAGE_PIPELINE_CONFIG.extractTimeoutMs ?? 12_000;
    const raw = await Promise.race([
      extractAgentInteractiveTree(page, {
        includeScreenshot: opts?.includeScreenshot === true,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`extract_timeout_${extractMs}ms`)), extractMs);
      }),
    ]);
    const viewport = await page
      .evaluate(() => ({
        width: window.innerWidth || 1280,
        height: window.innerHeight || 800,
      }))
      .catch(() => ({ width: 1280, height: 800 }));

    // 意图→目标关联仲裁：在蒸馏前先裁决「同行文案/外链」与「勾选控件」的归属，
    // 让列表直接把「真正该点的 index」交给模型，而不是等它在点击时刻再被纠正。
    const affinityReport = PAGE_PIPELINE_CONFIG.affinityArbitration
      ? await resolveAffinities(
          page,
          buildAffinityPeers(raw.llm_json, raw.element_map, PAGE_PIPELINE_CONFIG.affinityMaxPeers, viewport),
          {
            maxDepth: PAGE_PIPELINE_CONFIG.affinityMaxDepth,
            maxScan: PAGE_PIPELINE_CONFIG.affinityMaxScan,
            minScore: PAGE_PIPELINE_CONFIG.affinityMinScore,
            budgetMs: PAGE_PIPELINE_CONFIG.affinityProbeBudgetMs,
          },
        )
      : emptyAffinityReport();
    const affinityIndex = buildAffinityIndex(affinityReport, raw.element_map);

    const distilled = applyDistillToExtract(raw, opts?.senseMode ?? "balanced", {
      goal: opts?.goal,
      viewport,
      affinity: affinityIndex,
    });

    const a11y = await Promise.race([
      fetchA11yStructure(page, distilled.element_map.size),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 2_000);
      }),
    ]).catch(() => null);

    return {
      extract: distilled,
      structureHash: distilled.structureHash || computeStructureHash(distilled.llm_json),
      a11ySummary: a11y?.summary ?? null,
      a11yStructure: a11y?.structure ?? null,
      viewport,
      affinity: affinityIndex
        ? {
            peers: affinityIndex.byPeer.size,
            links: affinityReport.stats.links,
            rescued: affinityIndex.rescued.length,
            reasons: affinityIndex.reasons,
          }
        : null,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      extract: {
        url: page.url(),
        extractedAt: new Date().toISOString(),
        llm_json: [],
        element_map: new Map(),
        skipped: 0,
        structureHash: "error",
        truncated: 0,
        denoise: { input: 0, output: 0, dropped: 0, drops: {}, demoted: 0 },
      },
      structureHash: "error",
      a11ySummary: null,
      a11yStructure: null,
      viewport: null,
      affinity: null,
      error: message,
    };
  }
}

/**
 * 一次 CDP 调用同时产出两路 a11y 输出：
 *   - `summary`：压缩文本（既有行为，逐字不变，仍进模型提示词）；
 *   - `structure`：结构化 role/name（Phase 4.1a 只读透传，不进提示词）。
 *
 * 两路用同一次 `Accessibility.getFullAXTree`、同一套过滤规则 —— 不做第二次抽取，
 * 也就不存在「文本摘要与结构化视图描述的不是同一个页面」这种漂移。
 */
async function fetchA11yStructure(
  page: Page,
  indexSpace: number,
): Promise<{ summary: string | null; structure: A11yStructure | null } | null> {
  let client: CDPSession | null = null;
  try {
    client = await page.context().newCDPSession(page);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (client as any).send("Accessibility.getFullAXTree")) as {
      nodes?: Array<{
        ignored?: boolean;
        role?: { value?: string };
        name?: { value?: string };
        description?: { value?: string };
      }>;
    };
    const nodes = result?.nodes ?? [];
    const lines: string[] = [];
    const roles: A11yRoleNode[] = [];
    const roleCounts: Record<string, number> = {};
    let interactiveCount = 0;
    for (const n of nodes) {
      if (n.ignored) {
        continue;
      }
      const role = String(n.role?.value ?? "").trim();
      const name = String(n.name?.value ?? n.description?.value ?? "").trim();
      if (!role && !name) {
        continue;
      }
      if (!A11Y_INTERACTIVE_RE.test(role) && name.length < 2) {
        continue;
      }
      lines.push(`${role || "node"}: ${name.slice(0, A11Y_ROLE_NAME_CHARS)}`);
      const key = role || "node";
      roleCounts[key] = (roleCounts[key] ?? 0) + 1;
      if (A11Y_INTERACTIVE_RE.test(role)) interactiveCount += 1;
      if (roles.length < A11Y_ROLE_LIST_MAX) {
        roles.push({ role: key, name: name.slice(0, A11Y_ROLE_NAME_CHARS) });
      }
      if (lines.join("\n").length > PAGE_PIPELINE_CONFIG.a11yMaxChars) {
        break;
      }
    }
    const text = lines.slice(0, 120).join("\n");
    return {
      summary: text.trim() ? text : null,
      structure:
        roles.length > 0 || interactiveCount > 0
          ? { roles, roleCounts, interactiveCount, indexSpace }
          : null,
    };
  } catch {
    return null;
  } finally {
    if (client) {
      try {
        await client.detach();
      } catch {
        /* ignore */
      }
    }
  }
}

/** 结构相似度（基于 hash 相等或 Jaccard on tokenized hash pairs —— 简化：相等=1，否则用 llm 长度比） */
export function structureSimilarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  // 短 hash 不相等即认为变化显著（structureHash 已是骨架摘要）
  return 0;
}
