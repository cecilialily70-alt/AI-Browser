import { runChatEngine, type ChatEngineInput } from "./chat_engine.js";
import { installIpcGuards, JsonLogger } from "./json-logger.js";
import { findConfigFileArg, readConsumedJsonConfig } from "./utils/temp_config.js";

installIpcGuards();

const logger = new JsonLogger();

async function parseChatConfig(argv: string[]): Promise<ChatEngineInput> {
  const path = findConfigFileArg(argv);
  if (!path) {
    throw new Error("missing --config-file=");
  }
  // 配置含 AI API Key：读完立即删除，缩短凭据落盘窗口。
  return readConsumedJsonConfig<ChatEngineInput>(path);
}

async function main(): Promise<void> {
  try {
    const input = await parseChatConfig(process.argv.slice(2));
    logger.status("chat_starting", {
      profileId: input.profileId ?? null,
      cdpPort: input.cdpPort ?? null,
    });

    const reply = await runChatEngine(input, logger);

    logger.result("chat_complete", { reply });
    process.stdout.write(`${JSON.stringify({ type: "chat_reply", reply })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("chat_failed", { error: message });
    process.stdout.write(
      `${JSON.stringify({ type: "error", code: "CHAT_FAILED", message })}\n`,
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("unhandled_chat_error", { error: message });
  process.stdout.write(
    `${JSON.stringify({ type: "error", code: "CHAT_FAILED", message })}\n`,
  );
  process.exit(1);
});
