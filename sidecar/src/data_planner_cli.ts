/**
 * 数据规划 / 沙盘字段造数 CLI — 无浏览器，仅需 AI 配置
 * 用法：node dist/data_planner_cli.js --config-file=<json>
 *
 * mode=plan_batch（默认）| mock_fields | replay_plan
 */
import { planBatchReplayData, type PlanBatchDataRequest } from "./data_planner.js";
import {
  mockSandboxEnvFields,
  type MockSandboxEnvFieldsRequest,
  type SandboxMockFieldInput,
} from "./field_mock.js";
import type { SidecarAiSettings } from "./engine.js";
import { installIpcGuards, JsonLogger } from "./json-logger.js";
import { parseGeoContext, parsePersonaData } from "./persona_engine.js";
import { parseDatasetText, type DatasetFormat } from "./core/dataset_parse.js";
import { scanReplayPlanRisks } from "./core/replay_plan_risk.js";
import { findConfigFileArg, readConsumedJsonConfig } from "./utils/temp_config.js";

installIpcGuards();

const logger = new JsonLogger();

interface PlannerCliConfig {
  mode?: "plan_batch" | "mock_fields" | "replay_plan" | "parse_dataset";
  selectors?: string[];
  envIds?: string[];
  userPrompt?: string;
  fileData?: string;
  envId?: string;
  fields?: SandboxMockFieldInput[];
  onlyKeys?: string[];
  geo?: unknown;
  persona?: unknown;
  /** mode=replay_plan：轨迹步（来自 agent_trajectories.actions） */
  actions?: unknown[];
  /** mode=replay_plan：数据集列名 */
  columns?: string[];
  goal?: string;
  aiSettings?: SidecarAiSettings;
  /** mode=parse_dataset：原始数据集文本（外部 API 的 filePath / 内联 JSON 由 Host 转成文本） */
  datasetText?: string;
  datasetFormat?: string | null;
  datasetSource?: "inline" | "file" | "clipboard" | null;
}

async function parseConfig(argv: string[]): Promise<PlannerCliConfig> {
  const path = findConfigFileArg(argv);
  if (!path) {
    throw new Error("missing --config-file=");
  }
  // 配置含 AI API Key：读完立即删除，缩短凭据落盘窗口。
  return readConsumedJsonConfig<PlannerCliConfig>(path);
}

async function runPlanBatch(config: PlannerCliConfig): Promise<void> {
  const { aiSettings, ...rest } = config;
  if (!aiSettings?.apiKey?.trim()) {
    throw new Error("missing aiSettings.apiKey");
  }

  const request: PlanBatchDataRequest = {
    selectors: rest.selectors ?? [],
    envIds: rest.envIds ?? [],
    userPrompt: rest.userPrompt ?? "",
    fileData: rest.fileData,
  };

  logger.status("data_planner_starting", {
    envCount: request.envIds.length,
    selectorCount: request.selectors.length,
    fileChars: request.fileData?.length ?? 0,
  });

  const result = await planBatchReplayData(request, aiSettings);
  logger.result("data_planner_complete", {
    envCount: result.planMatrix.length,
    summary: result.summary.slice(0, 200),
  });
  process.stdout.write(
    `${JSON.stringify({ type: "data_planner_result", summary: result.summary, planMatrix: result.planMatrix })}\n`,
  );
}

async function runMockFields(config: PlannerCliConfig): Promise<void> {
  const { aiSettings } = config;
  if (!aiSettings?.apiKey?.trim()) {
    throw new Error("missing aiSettings.apiKey");
  }

  const request: MockSandboxEnvFieldsRequest = {
    envId: String(config.envId ?? "").trim(),
    fields: Array.isArray(config.fields) ? config.fields : [],
    onlyKeys: config.onlyKeys,
    geo: parseGeoContext(config.geo),
    persona: parsePersonaData(config.persona),
  };

  logger.status("field_mock_starting", {
    envId: request.envId,
    fieldCount: request.fields.length,
    onlyKeys: request.onlyKeys?.length ?? 0,
    hasGeo: Boolean(request.geo),
    hasPersona: Boolean(request.persona),
  });

  const result = await mockSandboxEnvFields(request, aiSettings);
  logger.result("field_mock_complete", {
    envId: result.envId,
    keys: Object.keys(result.valueOverrides).length,
    summary: result.summary.slice(0, 200),
  });
  process.stdout.write(
    `${JSON.stringify({
      type: "field_mock_result",
      envId: result.envId,
      valueOverrides: result.valueOverrides,
      summary: result.summary,
    })}\n`,
  );
}

/**
 * 预检单风险扫描（§4.6.6）：无浏览器、无 LLM，纯词典判定。
 * 入参 `actions` = 轨迹步数组、`columns` = 数据集列名。
 */
async function runReplayPlan(config: PlannerCliConfig): Promise<void> {
  const actionCount = Array.isArray(config.actions) ? config.actions.length : 0;
  const report = scanReplayPlanRisks({
    actions: config.actions ?? [],
    columns: config.columns ?? [],
    goal: config.goal ?? "",
  });
  logger.status("replay_plan_starting", {
    actionCount,
    columnCount: config.columns?.length ?? 0,
  });
  process.stdout.write(
    `${JSON.stringify({
      type: "replay_plan_result",
      criticalSteps: report.criticalSteps,
      columnRefusals: report.columnRefusals,
      columnWarnings: report.columnWarnings,
    })}\n`,
  );
}

/**
 * 数据集解析（§7.6）：外部 API 的 `dataset` 由 Host 读成原始文本后交给这里，
 * **共用 Sidecar 的唯一解析器**（`core/dataset_parse.ts`）——列名红线、行/列定位、
 * `dataset_hash` 不在 Host 里再写一套（否则两边口径必然分裂）。
 */
async function runParseDataset(config: PlannerCliConfig): Promise<void> {
  const format = (config.datasetFormat ?? null) as DatasetFormat | null;
  const source = config.datasetSource ?? "inline";
  const result = parseDatasetText(config.datasetText ?? "", { format, source });
  logger.status("dataset_parse_starting", {
    format: format ?? "auto",
    source,
    textChars: (config.datasetText ?? "").length,
  });
  if (!result.ok) {
    // 数据错误不是崩溃：如实回执（含行/列），由宿主变成预检单上的红条
    process.stdout.write(
      `${JSON.stringify({
        type: "dataset_parse_result",
        ok: false,
        error: result.error,
        line: result.line ?? null,
        column: result.column ?? null,
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      type: "dataset_parse_result",
      ok: true,
      format: result.dataset.format,
      columns: result.dataset.columns,
      rows: result.dataset.rows,
      hash: result.dataset.hash,
      warnings: result.dataset.warnings,
    })}\n`,
  );
}

async function main(): Promise<void> {
  try {
    // 临时配置已在 parseConfig 内读后即焚，此处无需再清理。
    const config = await parseConfig(process.argv.slice(2));
    const mode =
      config.mode === "mock_fields"
        ? "mock_fields"
        : config.mode === "replay_plan"
          ? "replay_plan"
          : config.mode === "parse_dataset"
            ? "parse_dataset"
            : "plan_batch";
    if (mode === "mock_fields") {
      await runMockFields(config);
    } else if (mode === "replay_plan") {
      await runReplayPlan(config);
    } else if (mode === "parse_dataset") {
      await runParseDataset(config);
    } else {
      await runPlanBatch(config);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("data_planner_failed", { error: message });
    process.stdout.write(
      `${JSON.stringify({ type: "error", code: "DATA_PLANNER_FAILED", message })}\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("unhandled_data_planner_error", { error: message });
  process.stdout.write(
    `${JSON.stringify({ type: "error", code: "DATA_PLANNER_FAILED", message })}\n`,
  );
  process.exit(1);
});
