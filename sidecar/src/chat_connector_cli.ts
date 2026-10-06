/**
 * 站点描述符 CLI — **无浏览器、无 AI**（纯文件系统 + 权威解析器）
 *
 * 用法：`node dist/chat_connector_cli.js --config-file=<json>`
 * 配置：`{ mode: "report" | "delete", userDataDir: string|null, siteKey?: string }`
 *
 * 为什么要这条一次性 CLI，而不是让宿主自己读目录：
 * 描述符的**合法性**只有一套权威判定（`core/web_chat/descriptor/registry.ts` 的 schema 校验器）
 * 与一套命名约定（`discovery/learn.ts` 的 `descriptorFileName` / `metaFileName`）。
 * 宿主要么照抄一套（两边口径必然分裂，坑族 J「前后端两套解析器分叉」），要么来这里问一次。
 *
 * 纪律（与 `data_planner_cli` 同）：**只读 + 删自己学来的那两个文件**，不碰内置目录、不联网、不开浏览器。
 */
import { installIpcGuards } from "./json-logger.js";
import {
  listConnectorItemsDetailed,
  removeLearnedSite,
} from "./bu_agent/chat_learn.js";
import { findConfigFileArg, readConsumedJsonConfig } from "./utils/temp_config.js";

installIpcGuards();

interface ConnectorCliConfig {
  mode?: "report" | "delete";
  userDataDir?: string | null;
  siteKey?: string;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const path = findConfigFileArg(process.argv.slice(2));
  if (!path) {
    emit({ type: "error", message: "missing --config-file=" });
    process.exitCode = 2;
    return;
  }
  const config = await readConsumedJsonConfig<ConnectorCliConfig>(path);
  const userDataDir = typeof config.userDataDir === "string" ? config.userDataDir : null;

  if (config.mode === "delete") {
    const result = removeLearnedSite(userDataDir, String(config.siteKey ?? ""));
    emit({ type: "connector_delete", ...result });
    return;
  }

  const report = listConnectorItemsDetailed(userDataDir);
  emit({
    type: "connector_report",
    ok: true,
    items: report.items,
    diagnostics: report.diagnostics,
    builtinPresent: report.builtinPresent,
    learnedDir: report.learnedDir,
    learnedDirReady: report.learnedDirReady,
  });
}

main().catch((error: unknown) => {
  emit({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
