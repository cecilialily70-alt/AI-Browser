/**
 * 落盘产物台账（Artifacts）
 *
 * 「下载第二张图片」这类交付物，唯一的客观证据是**文件真的落在了磁盘上**。
 * 浏览器侧（download_autosave）已经负责把下载接管到用户目录；这里只做记账：
 * 把每个 download 事件变成一条结构化产物记录 + 一条证据事实，
 * 供交付物验证器（core/deliverable_verify.ts 的 download 验证器）核销。
 *
 * 为什么要独立一层：下载是**浏览器事件**，不是 Agent 动作的返回值 ——
 * 模型点了图片、下载在后台完成，动作结果里什么都没有。不记账就只能靠模型自述。
 *
 * 约束：只监听不干预（不 saveAs、不取消、不消费事件），失败一律静默降级 —— 记账绝不阻断任务。
 */
import type { BrowserContext, Page } from "playwright-core";

import type { EvidenceLedger } from "./completion_evidence.js";
import type { ArtifactRecord } from "./deliverable_verify.js";

export interface ArtifactTrackerOptions {
  ledger: EvidenceLedger;
  /** 下载事件归属的步号（由运行期提供；未知时返回 -1） */
  currentStep: () => number;
  /** 单个下载事件等待「落盘路径」的时长（超时即只记文件名） */
  pathTimeoutMs?: number;
  logger?: { agentProgress?: (message: string, data?: Record<string, unknown>) => void };
}

const attached = new WeakSet<BrowserContext>();

/**
 * 在一个浏览器上下文上安装下载记账（幂等：同一 context 只装一次）。
 * 覆盖当前页与之后新开的页 —— 图片下载常常发生在点开的大图页/新标签里。
 */
export function attachArtifactTracker(
  context: BrowserContext,
  artifacts: ArtifactRecord[],
  options: ArtifactTrackerOptions,
): void {
  if (attached.has(context)) return;
  attached.add(context);
  const timeoutMs = options.pathTimeoutMs ?? 3_000;

  const watch = (page: Page): void => {
    page.on("download", (download) => {
      void (async () => {
        const suggested = String(download.suggestedFilename?.() ?? "").trim();
        const url = String(download.url?.() ?? "");
        let savedPath: string | null = null;
        try {
          savedPath = (await withTimeout(download.path(), timeoutMs)) ?? null;
        } catch {
          savedPath = null;
        }
        const step = options.currentStep();
        const record: ArtifactRecord = {
          kind: "download",
          name: savedPath || suggested || url.slice(0, 120),
          url,
          step,
        };
        artifacts.push(record);
        options.ledger.facts.push({
          kind: "file_downloaded",
          step,
          url: "",
          detail: record.name.slice(0, 160),
        });
        options.logger?.agentProgress?.(`已落盘文件：${record.name.slice(0, 120)}`, {
          phase: "artifact",
          source: url.slice(0, 120),
        });
      })().catch(() => undefined);
    });
  };

  for (const page of context.pages()) watch(page);
  context.on("page", (page) => watch(page));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}
