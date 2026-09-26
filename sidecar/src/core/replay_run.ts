/**
 * 回放「轮次身份」与模板上下文（§5.7 / §7.6）。
 *
 * 唯一性只能由分配器保证，不能靠随机 —— 所以轮次身份（seq / index / envId / jobId /
 * uniqueId）由 Host 台账分配、随命令下发；本模块只负责解析、归一化与回退，
 * 并把 `{{run.*}}` / `{{data.*}}` / `{{clip.N}}` 的上下文组装出来供 `interpolateTemplate` 使用。
 *
 * 缺省回退：没有台账（P2 阶段）时用 `round` 填 `seq`/`index`，保证「每轮不同」；
 * 但 `uniqueId` 缺失时**不编造** —— 宁可让 `{{run.uniqueId}}` 插成空串，也不给一个假的唯一序号。
 */
import { readAppEnv, ENV_PROFILE_ID } from "../app_env.js";

export interface ReplayRunIdentity {
  /** 全局序号（0 基） */
  seq: number | null;
  /** 该环境内第几次（0 基） */
  index: number | null;
  envId: string;
  jobId: string;
  /** 分配器发的唯一整数（缺失即 null，不编造） */
  uniqueId: number | null;
  /** 唯一整数转 8 位十六进制 */
  uniqueHex: string | null;
  /** 生成型数据根种子（必须可记录，便于复现诊断） */
  runSeed: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

function toStr(value: unknown): string {
  return value == null ? "" : String(value);
}

export interface ParseRunIdentityFallback {
  /** 本轮序号（0 基）：无台账时的 seq/index 回退 */
  round?: number;
  envId?: string;
  jobId?: string;
  runSeed?: number | null;
}

/** 解析 Host 下发的 `runContext`（`run` 子对象）；缺省按 round 回退。 */
export function parseReplayRunIdentity(
  raw: unknown,
  fallback: ParseRunIdentityFallback = {},
): ReplayRunIdentity {
  const context = asRecord(raw);
  const run = asRecord(context?.run) ?? context ?? {};
  const round = fallback.round ?? 0;
  const envId = toStr(run.envId ?? run.env_id ?? fallback.envId ?? readAppEnv(ENV_PROFILE_ID) ?? "");
  const uniqueId = toInt(run.uniqueId ?? run.unique_id);
  return {
    seq: toInt(run.seq) ?? round,
    index: toInt(run.index ?? run.runIndex ?? run.run_index) ?? round,
    envId,
    jobId: toStr(run.jobId ?? run.job_id ?? fallback.jobId ?? ""),
    uniqueId,
    uniqueHex: uniqueId == null ? null : uniqueId.toString(16).padStart(8, "0"),
    runSeed: toInt(run.runSeed ?? run.run_seed) ?? fallback.runSeed ?? null,
  };
}

export interface ReplayTemplateExtraInput {
  run: ReplayRunIdentity;
  /** 当前轮分配到的数据行（列名 → 值） */
  data?: Record<string, string> | null;
  /**
   * 运行途中读取的剪贴板内容：数字键为顺序号（`{{clip.0}}`），具名键来自步骤的 `into`。
   * 兼容旧调用传入的数组形态。
   */
  clip?: Record<string, string> | string[] | null;
}

/**
 * 组装 `interpolateTemplate` 的 extra 上下文。
 *
 * 语义选择：`null` 值插成空串（lookupPath 对 null 返回 ""），**不会**抛错 ——
 * 因为「数据源没这一列」是预览阶段就该报黄条的情形，不该在填表时炸掉整条回放。
 */
export function buildReplayTemplateExtra(input: ReplayTemplateExtraInput): Record<string, unknown> {
  const { run } = input;
  return {
    run: {
      seq: run.seq ?? "",
      index: run.index ?? "",
      envId: run.envId,
      jobId: run.jobId,
      uniqueId: run.uniqueId ?? "",
      uniqueHex: run.uniqueHex ?? "",
      runSeed: run.runSeed ?? "",
    },
    data: input.data ?? {},
    clip: input.clip ?? {},
  };
}
