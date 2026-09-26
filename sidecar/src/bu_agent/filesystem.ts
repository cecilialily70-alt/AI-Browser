import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent 工作区文件系统（对齐 browser-use todo.md / results.md）
 * 路径：agent_fs/{profileId}/
 */
export class AgentFileSystem {
  readonly root: string;

  constructor(baseDir: string, profileId: string) {
    this.root = join(baseDir, "agent_fs", profileId || "default");
    mkdirSync(this.root, { recursive: true });
    const todo = join(this.root, "todo.md");
    if (!existsSync(todo)) {
      writeFileSync(todo, "# todo\n\n", "utf8");
    }
  }

  summary(maxPreview = 2000): string {
    const names = ["todo.md", "results.md", "plan.json"];
    const lines: string[] = [`root: ${this.root}`];
    for (const name of names) {
      const p = join(this.root, name);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      const preview = raw.length > maxPreview ? `${raw.slice(0, maxPreview)}\n…(truncated)` : raw;
      lines.push(`--- ${name} ---\n${preview}`);
    }
    return lines.join("\n");
  }

  readTodo(): string {
    const p = join(this.root, "todo.md");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  writeFile(fileName: string, content: string, append = false): string {
    const safe = sanitizeName(fileName);
    const p = join(this.root, safe);
    if (append && existsSync(p)) {
      writeFileSync(p, readFileSync(p, "utf8") + content, "utf8");
    } else {
      writeFileSync(p, content, "utf8");
    }
    return p;
  }

  /** 二进制落盘（PNG/JPEG/PDF）。禁止把 base64 文本当图片写入。 */
  writeBinaryFile(fileName: string, data: Buffer | Uint8Array): string {
    const safe = sanitizeName(fileName);
    const p = join(this.root, safe);
    writeFileSync(p, Buffer.from(data));
    return p;
  }

  /** base64 → 二进制文件；若已是 data URL 先剥前缀 */
  writeBase64File(fileName: string, base64OrDataUrl: string): string {
    const raw = String(base64OrDataUrl ?? "").trim();
    const b64 = raw.includes("base64,") ? raw.split("base64,").pop()! : raw;
    return this.writeBinaryFile(fileName, Buffer.from(b64, "base64"));
  }

  replaceFile(fileName: string, oldStr: string, newStr: string): string {
    const safe = sanitizeName(fileName);
    const p = join(this.root, safe);
    if (!existsSync(p)) throw new Error(`文件不存在: ${safe}`);
    const raw = readFileSync(p, "utf8");
    if (!raw.includes(oldStr)) throw new Error(`未找到替换片段: ${oldStr.slice(0, 80)}`);
    writeFileSync(p, raw.replace(oldStr, newStr), "utf8");
    return p;
  }

  readFile(fileName: string, maxChars = 8000): string {
    const safe = sanitizeName(fileName);
    const p = join(this.root, safe);
    if (!existsSync(p)) throw new Error(`文件不存在: ${safe}`);
    const raw = readFileSync(p, "utf8");
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…(truncated)` : raw;
  }

  resolve(fileName: string): string {
    return join(this.root, sanitizeName(fileName));
  }
}

function sanitizeName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "file.txt";
  if (!base || base === "." || base === "..") throw new Error("非法文件名");
  return base;
}
