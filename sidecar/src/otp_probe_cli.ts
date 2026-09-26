/**
 * 邮箱 OTP 通道连通性 CLI（P1.3 设置页测试连接）
 *
 * 用法: node dist/otp_probe_cli.js --config-file=<path>
 * 配置 JSON（临时文件，Host Drop 即删）:
 *   { channel, draftSecret?, secretsByRef? }
 *
 * 仅 stdout JSON 行；禁止打印密钥或验证码。
 */
import { readFile, unlink } from "node:fs/promises";

import { installIpcGuards } from "./json-logger.js";
import { probeOtpChannel } from "./otp/probe.js";

installIpcGuards();

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readArg(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  if (hit) {
    return hit.slice(prefix.length);
  }
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const configPath = readArg(process.argv.slice(2), "config-file");
  if (!configPath) {
    emit({ type: "error", message: "missing --config-file" });
    process.exitCode = 1;
    return;
  }

  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? "");
    emit({ type: "error", message: `failed to read config: ${detail}` });
    process.exitCode = 1;
    return;
  } finally {
    await unlink(configPath).catch(() => undefined);
  }

  let parsed: {
    channel?: unknown;
    draftSecret?: string | null;
    secretsByRef?: Record<string, string> | null;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    emit({ type: "error", message: "invalid config JSON" });
    process.exitCode = 1;
    return;
  }

  try {
    const result = await probeOtpChannel({
      channel: parsed.channel,
      draftSecret: parsed.draftSecret,
      secretsByRef: parsed.secretsByRef,
    });
    emit({
      type: "otp_probe_result",
      ok: result.ok,
      reason: result.reason,
      message: result.message,
    });
    process.exitCode = result.ok ? 0 : 2;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? "");
    emit({ type: "error", message: `otp probe failed: ${detail}` });
    process.exitCode = 1;
  }
}

void main();
