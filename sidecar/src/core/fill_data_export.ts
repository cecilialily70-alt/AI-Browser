/**
 * 填表数据落盘到「数据目录」（scraper download track）。
 *
 * 用途：用户事后能打开目录，看到这次任务实际填了邮箱 / 密码 / 账户 / 日期等。
 * 红线：OTP / TOTP / CVV / 卡号等一次性或支付凭证**不落盘**（R1/R2 / §1.3）。
 * 邮箱、密码、手机号、普通账户字段按用户要求写入本地数据目录（仅本机审计，不进日志明文）。
 */
import { writeFileSync } from "node:fs";

import { getUniqueResolvedDownloadPath, getResolvedDownloadPath } from "../utils/file_manager.js";

export type FillDataSource =
  | "agent_input"
  | "agent_select"
  | "fill_engine"
  | "replay_fill"
  | "replay_select"
  | "replay_data"
  | "replay_persona";

export type FillDataEntry = {
  label: string;
  value: string;
  fieldType?: string | null;
  url: string;
  at: string;
  source: FillDataSource;
  index?: number;
  /** 回放步号（仅 replay_*） */
  step?: number;
};

export type FillDataRecordInput = {
  label: string;
  value: string;
  fieldType?: string | null;
  url?: string;
  source: FillDataSource;
  index?: number;
  step?: number;
  /** human_only 原因：用于识别 OTP 类字段并跳过落盘 */
  humanOnly?: string | null;
};

export type FillDataLedger = {
  /** 记录一次成功填写；同名字段后写覆盖先写 */
  record: (input: FillDataRecordInput) => string | null;
  /** 附加本轮上下文（数据集行 / 人设 / 轮次），下次 persist 时写入同一文件 */
  setMeta: (meta: FillDataMeta) => void;
  /** 当前落盘路径（尚未写过则为 null） */
  path: () => string | null;
  /** 已记录字段数（不含被跳过的 OTP/支付项） */
  size: () => number;
};

export type FillDataMeta = {
  kind?: "agent" | "replay";
  round?: number;
  goal?: string;
  /** 本轮数据集行（{{data.*}}） */
  dataRow?: Record<string, string>;
  /** 本轮人设字段（{{persona.*}}） */
  persona?: Record<string, string>;
};

type FillDataFileBody = {
  version: 1;
  kind: "fill_record" | "replay_fill_record";
  profileId: string;
  runId: string;
  updatedAt: string;
  url: string;
  fields: FillDataEntry[];
  /** 便于人眼扫：label → 最新值 */
  byLabel: Record<string, string>;
  meta?: FillDataMeta;
};

type FillDataLogger = {
  scraperDataCollected: (data: unknown[], extra?: Record<string, unknown>) => void;
  agentProgress?: (msg: string, data?: Record<string, unknown>) => void;
  warn?: (msg: string, data?: Record<string, unknown>) => void;
};

/** OTP / 支付凭证：禁止写入数据目录（与轨迹脱敏同口径，宁可不记也不落明文） */
export function shouldOmitFromFillExport(input: {
  label?: string | null;
  fieldType?: string | null;
  humanOnly?: string | null;
  value?: string | null;
}): boolean {
  const blob = [input.label, input.fieldType, input.humanOnly]
    .map((v) => String(v ?? ""))
    .join(" ");
  if (
    /otp|totp|one[_\s-]?time|验证码|短信码|邮箱码|动态码|口令码|cvv|cvc|card[_\s-]?number|卡号|信用卡|借记卡|银行卡/i.test(
      blob,
    )
  ) {
    return true;
  }
  // human_only 明确标了短信/邮箱一次性码
  if (input.humanOnly && /sms|email.?otp|totp|authenticator|验证码/i.test(String(input.humanOnly))) {
    return true;
  }
  return false;
}

function sanitizeLabelKey(label: string): string {
  const trimmed = String(label ?? "").replace(/\s+/g, " ").trim();
  return trimmed.slice(0, 120) || "（未命名字段）";
}

function buildFileName(runId: string, prefix = "fill-record"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const id = String(runId || "run")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 40);
  return `${prefix}-${stamp}-${id}.json`;
}

function sanitizeStringMap(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue;
    const label = sanitizeLabelKey(key);
    const text = String(value);
    if (!text.trim()) continue;
    if (shouldOmitFromFillExport({ label, value: text })) continue;
    out[label] = text;
  }
  return out;
}

/**
 * 一次 Agent / 填表 / 回放会话共用一个账本：边填边覆写同一份 JSON，方便打开目录就看到「填了什么」。
 */
export function createFillDataLedger(opts: {
  profileId: string;
  runId: string;
  logger: FillDataLogger;
  /** 文件名前缀；回放用 `replay-fill` */
  filePrefix?: string;
  /** 初始元数据（回放轮次 / 数据集行等） */
  meta?: FillDataMeta;
}): FillDataLedger {
  const profileId = String(opts.profileId || "unknown").trim() || "unknown";
  const runId = String(opts.runId || "run").trim() || "run";
  const filePrefix = String(opts.filePrefix ?? "fill-record").trim() || "fill-record";
  const entries = new Map<string, FillDataEntry>();
  let filePath: string | null = null;
  let announced = false;
  let meta: FillDataMeta | undefined = opts.meta
    ? {
        ...opts.meta,
        dataRow: sanitizeStringMap(opts.meta.dataRow as Record<string, unknown> | undefined),
        persona: sanitizeStringMap(opts.meta.persona as Record<string, unknown> | undefined),
      }
    : undefined;

  const persist = (): string | null => {
    const hasMetaMaps =
      (meta?.dataRow && Object.keys(meta.dataRow).length > 0) ||
      (meta?.persona && Object.keys(meta.persona).length > 0);
    if (entries.size === 0 && !hasMetaMaps) {
      return null;
    }
    try {
      if (!filePath) {
        // 首次落盘用唯一名；之后覆写同一文件（同一次任务一份记录）
        filePath = getUniqueResolvedDownloadPath(
          "scraper",
          profileId,
          buildFileName(runId, filePrefix),
        );
      } else {
        // 确保父目录仍在（用户中途清过缓存也不炸）
        getResolvedDownloadPath("scraper", profileId);
      }
      const fields = [...entries.values()];
      const byLabel: Record<string, string> = {};
      for (const entry of fields) {
        byLabel[entry.label] = entry.value;
      }
      // 数据集行 / 人设也并进 byLabel，方便一眼扫完本轮用了什么
      if (meta?.dataRow) {
        for (const [key, value] of Object.entries(meta.dataRow)) {
          if (!(key in byLabel)) byLabel[`data.${key}`] = value;
        }
      }
      if (meta?.persona) {
        for (const [key, value] of Object.entries(meta.persona)) {
          if (!(key in byLabel) && !(`data.${key}` in byLabel)) {
            byLabel[`persona.${key}`] = value;
          }
        }
      }
      const lastUrl = fields[fields.length - 1]?.url ?? "";
      const isReplay = meta?.kind === "replay" || filePrefix.startsWith("replay");
      const body: FillDataFileBody = {
        version: 1,
        kind: isReplay ? "replay_fill_record" : "fill_record",
        profileId,
        runId,
        updatedAt: new Date().toISOString(),
        url: lastUrl,
        fields,
        byLabel,
        ...(meta ? { meta } : {}),
      };
      writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");

      // UI：以文件行出现在 Ai Chat 采集面板；值不走事件明文（密码键会被日志脱敏抹掉）
      opts.logger.scraperDataCollected(
        [
          {
            kind: isReplay ? "replay_fill_record" : "fill_record",
            localPath: filePath,
            label: isReplay ? "回放填表记录" : "填表记录",
            fieldCount: fields.length,
            updatedAt: body.updatedAt,
            ...(typeof meta?.round === "number" ? { round: meta.round } : {}),
          },
        ],
        {
          profileId,
          mode: isReplay ? "replay_fill_record" : "fill_record",
          url: lastUrl.slice(0, 500),
          count: 1,
          localPath: filePath,
          append: false,
        },
      );

      if (!announced) {
        announced = true;
        opts.logger.agentProgress?.(
          isReplay
            ? `回放数据已写入数据目录：${filePath}`
            : `填表数据已写入数据目录：${filePath}`,
          {
            phase: "fill_data_export",
            fieldCount: fields.length,
            ...(typeof meta?.round === "number" ? { round: meta.round } : {}),
          },
        );
      }
      return filePath;
    } catch (error) {
      opts.logger.warn?.("fill_data_export_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const ledger: FillDataLedger = {
    record(input) {
      const value = String(input.value ?? "");
      if (!value.trim()) {
        return null;
      }
      if (
        shouldOmitFromFillExport({
          label: input.label,
          fieldType: input.fieldType,
          humanOnly: input.humanOnly,
          value,
        })
      ) {
        return null;
      }
      const label = sanitizeLabelKey(input.label);
      entries.set(label, {
        label,
        value,
        fieldType: input.fieldType ?? null,
        url: String(input.url ?? "").slice(0, 500),
        at: new Date().toISOString(),
        source: input.source,
        ...(typeof input.index === "number" && Number.isFinite(input.index)
          ? { index: input.index }
          : {}),
        ...(typeof input.step === "number" && Number.isFinite(input.step)
          ? { step: input.step }
          : {}),
      });
      return persist();
    },
    setMeta(next) {
      meta = {
        ...meta,
        ...next,
        dataRow: next.dataRow
          ? sanitizeStringMap(next.dataRow as Record<string, unknown>)
          : meta?.dataRow,
        persona: next.persona
          ? sanitizeStringMap(next.persona as Record<string, unknown>)
          : meta?.persona,
      };
      // 只有元数据、还没填过字段时也先落一版，方便用户开跑就能看到本轮数据行
      persist();
    },
    path: () => filePath,
    size: () => entries.size,
  };

  // 开跑即有数据集行 / 人设时先落一版，不用等第一笔填写
  if (
    (meta?.dataRow && Object.keys(meta.dataRow).length > 0) ||
    (meta?.persona && Object.keys(meta.persona).length > 0)
  ) {
    persist();
  }

  return ledger;
}

/**
 * 填表引擎一次性导出：把已成功写入的字段键值落到数据目录。
 * （智能填表 / 直接填表 / 混合填表共用）
 */
export function exportFillProfileToDataDir(input: {
  profileId: string;
  profile: Record<string, string>;
  url?: string;
  logger: FillDataLogger;
  source?: FillDataSource;
}): string | null {
  const profileId = String(input.profileId || "unknown").trim() || "unknown";
  const entries: FillDataEntry[] = [];
  const at = new Date().toISOString();
  const url = String(input.url ?? "").slice(0, 500);
  for (const [rawLabel, rawValue] of Object.entries(input.profile ?? {})) {
    const label = sanitizeLabelKey(rawLabel);
    const value = String(rawValue ?? "");
    if (!value.trim()) continue;
    if (shouldOmitFromFillExport({ label, value })) continue;
    entries.push({
      label,
      value,
      url,
      at,
      source: input.source ?? "fill_engine",
    });
  }
  if (entries.length === 0) {
    return null;
  }
  try {
    const filePath = getUniqueResolvedDownloadPath(
      "scraper",
      profileId,
      buildFileName(`fill-${Date.now()}`),
    );
    const byLabel: Record<string, string> = {};
    for (const entry of entries) {
      byLabel[entry.label] = entry.value;
    }
    const body: FillDataFileBody = {
      version: 1,
      kind: "fill_record",
      profileId,
      runId: `fill-${Date.now()}`,
      updatedAt: at,
      url,
      fields: entries,
      byLabel,
    };
    writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    input.logger.scraperDataCollected(
      [
        {
          kind: "fill_record",
          localPath: filePath,
          label: "填表记录",
          fieldCount: entries.length,
          updatedAt: at,
        },
      ],
      {
        profileId,
        mode: "fill_record",
        url,
        count: 1,
        localPath: filePath,
        append: false,
      },
    );
    input.logger.agentProgress?.(`填表数据已写入数据目录：${filePath}`, {
      phase: "fill_data_export",
      fieldCount: entries.length,
    });
    return filePath;
  } catch (error) {
    input.logger.warn?.("fill_data_export_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
