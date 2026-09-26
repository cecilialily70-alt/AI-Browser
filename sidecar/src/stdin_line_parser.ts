/**
 * 公共 stdin 行缓冲解析器（index.ts / launch.ts 共用）。
 *
 * 累积 chunk → 按 \n 切分 → 保留未完整行到 buffer → 逐行 trim → 回调非空行。
 * 仅负责「行切分」这一纯解析职责；JSON 解析与命令分派由各调用方 onLine 回调自行处理，
 * 保证 index 与 launch 各自不同的分派语义不变。
 */
export function attachStdinLineParser(onLine: (line: string) => void): void {
  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      onLine(trimmed);
    }
  });
}
