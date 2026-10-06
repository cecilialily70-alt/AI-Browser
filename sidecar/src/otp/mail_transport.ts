/**
 * 邮件传输：Memory（模拟/测试）+ 最小 IMAP（TLS LOGIN/SELECT/SEARCH/FETCH）
 *
 * 禁止网页邮箱 UI 作为默认路径；本文件不包含任何站点发件人硬编码。
 */
import net from "node:net";
import tls from "node:tls";

import type { MailFetchQuery, MailMessage, MailTransport } from "./types.js";

function includesHint(hay: string, hint?: string): boolean {
  if (!hint) return true;
  const needle = hint.trim().toLowerCase();
  if (!needle) return true;
  return hay.toLowerCase().includes(needle);
}

function filterMessages(messages: MailMessage[], query: MailFetchQuery): MailMessage[] {
  const sinceMs = Date.parse(query.sinceIso) || 0;
  const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
  return messages
    .filter((msg) => {
      const ts = Date.parse(msg.dateIso) || 0;
      if (sinceMs && ts && ts < sinceMs) return false;
      if (!includesHint(msg.from, query.fromHint)) return false;
      if (!includesHint(msg.subject, query.subjectHint)) return false;
      return true;
    })
    .sort((a, b) => (Date.parse(b.dateIso) || 0) - (Date.parse(a.dateIso) || 0))
    .slice(0, limit);
}

export class MemoryMailTransport implements MailTransport {
  private messages: MailMessage[];

  constructor(seed: MailMessage[] = []) {
    this.messages = seed.map((m) => ({ ...m }));
  }

  seed(messages: MailMessage[]): void {
    this.messages = messages.map((m) => ({ ...m }));
  }

  push(message: MailMessage): void {
    this.messages.push({ ...message });
  }

  async fetchMessages(query: MailFetchQuery): Promise<MailMessage[]> {
    return filterMessages(this.messages, query);
  }
}

export function createMemoryMailTransport(seed: MailMessage[] = []): MemoryMailTransport {
  return new MemoryMailTransport(seed);
}

export type ImapTransportOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  folder?: string;
  tls?: boolean;
  /** 单次命令读超时（ms） */
  commandTimeoutMs?: number;
};

class ImapLineClient {
  private socket: net.Socket;
  private buffer = "";
  private tagSeq = 0;
  private readonly commandTimeoutMs: number;

  constructor(socket: net.Socket, commandTimeoutMs: number) {
    this.socket = socket;
    this.commandTimeoutMs = commandTimeoutMs;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
    });
  }

  static async connect(opts: ImapTransportOptions): Promise<ImapLineClient> {
    const useTls = opts.tls !== false;
    const port = opts.port || (useTls ? 993 : 143);
    const commandTimeoutMs = Math.max(3_000, opts.commandTimeoutMs ?? 20_000);

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const onErr = (error: Error) => reject(error);
      if (useTls) {
        const s = tls.connect(
          { host: opts.host, port, servername: opts.host, rejectUnauthorized: true },
          () => {
            s.off("error", onErr);
            resolve(s);
          },
        );
        s.once("error", onErr);
      } else {
        const s = net.connect({ host: opts.host, port }, () => {
          s.off("error", onErr);
          resolve(s);
        });
        s.once("error", onErr);
      }
    });

    const client = new ImapLineClient(socket, commandTimeoutMs);
    await client.readUntil(/^\* OK/im);
    return client;
  }

  private readUntil(pattern: RegExp): Promise<string> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (pattern.test(this.buffer)) {
          const out = this.buffer;
          this.buffer = "";
          resolve(out);
          return;
        }
        if (Date.now() - started > this.commandTimeoutMs) {
          reject(new Error("imap_read_timeout"));
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  async command(payload: string): Promise<string> {
    this.tagSeq += 1;
    const tag = `A${this.tagSeq}`;
    this.socket.write(`${tag} ${payload}\r\n`);
    const re = new RegExp(`^${tag} (OK|NO|BAD)\\b`, "im");
    const raw = await this.readUntil(re);
    if (!new RegExp(`^${tag} OK\\b`, "im").test(raw)) {
      throw new Error(`imap_command_failed:${tag}`);
    }
    return raw;
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      /* ignore */
    }
    this.socket.destroy();
  }
}

function imapDate(sinceIso: string): string | null {
  const ms = Date.parse(sinceIso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mon = months[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mon}-${yyyy}`;
}

function decodeImapQuotes(raw: string): string {
  return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function parseFetchBlocks(raw: string): MailMessage[] {
  const out: MailMessage[] = [];
  // 粗解析：* <seq> FETCH ( ... BODY[TEXT] {n}\r\n<body> ... )
  const re =
    /\* \d+ FETCH \([\s\S]*?(?:BODY(?:\.PEEK)?\[(?:TEXT|1)\])(?:\s*\{(\d+)\}\r?\n([\s\S]*?))?(?:\s*"[^"]*")?[\s\S]*?\)/gi;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = re.exec(raw)) && idx < 40) {
    idx += 1;
    const body = match[2] ?? "";
    const block = match[0];
    const subjectMatch = /SUBJECT\s+"((?:\\.|[^"\\])*)"/i.exec(block);
    const fromMatch = /FROM\s+\(\s*"((?:\\.|[^"\\])*)"/i.exec(block) || /FROM\s+"((?:\\.|[^"\\])*)"/i.exec(block);
    const dateMatch = /INTERNALDATE\s+"((?:\\.|[^"\\])*)"/i.exec(block);
    const idMatch = /(?:BODY\[HEADER\.FIELDS \(MESSAGE-ID\)\]|MESSAGE-ID)\s+"?<([^>"\s]+)"?>?/i.exec(block);
    const subject = subjectMatch ? decodeImapQuotes(subjectMatch[1]) : "";
    const from = fromMatch ? decodeImapQuotes(fromMatch[1]) : "";
    const dateIso = dateMatch ? new Date(decodeImapQuotes(dateMatch[1])).toISOString() : new Date(0).toISOString();
    const messageId = idMatch?.[1] ?? `imap-${idx}-${Date.parse(dateIso) || idx}`;
    out.push({
      messageId,
      from,
      subject,
      dateIso: Number.isFinite(Date.parse(dateIso)) ? dateIso : new Date(0).toISOString(),
      text: body.replace(/\r\n/g, "\n").trim(),
    });
  }
  // 退化：若 ENVELOPE 解析失败但有 BODY 文本块
  if (out.length === 0) {
    const lit = /BODY(?:\.PEEK)?\[(?:TEXT|1)\]\s*\{(\d+)\}\r?\n([\s\S]*?)(?=\n\)|\n\* |\nA\d+ )/i.exec(raw);
    if (lit?.[2]) {
      out.push({
        messageId: `imap-body-${Date.now()}`,
        from: "",
        subject: "",
        dateIso: new Date().toISOString(),
        text: lit[2].replace(/\r\n/g, "\n").trim(),
      });
    }
  }
  return out;
}

export class ImapMailTransport implements MailTransport {
  private readonly opts: ImapTransportOptions;

  constructor(opts: ImapTransportOptions) {
    this.opts = opts;
  }

  async fetchMessages(query: MailFetchQuery): Promise<MailMessage[]> {
    const folder = (query.folder || this.opts.folder || "INBOX").trim() || "INBOX";
    const client = await ImapLineClient.connect(this.opts);
    try {
      // 转义：拒绝含引号的用户名/密码，避免注入；真实密码绝不入日志
      if (/[\r\n"]/.test(this.opts.user) || /[\r\n"]/.test(this.opts.password)) {
        throw new Error("imap_auth_unsafe_chars");
      }
      await client.command(`LOGIN "${this.opts.user}" "${this.opts.password}"`);
      await client.command(`SELECT "${folder.replace(/"/g, "")}"`);
      const since = imapDate(query.sinceIso);
      const searchRaw = since
        ? await client.command(`SEARCH SINCE ${since}`)
        : await client.command("SEARCH ALL");
      const searchLine = searchRaw
        .split(/\r?\n/)
        .find((line) => /^\* SEARCH\b/i.test(line)) ?? "";
      const seqs = Array.from(searchLine.matchAll(/\b(\d+)\b/g))
        .map((m) => m[1])
        .filter((id) => Number(id) > 0)
        .slice(-20);
      if (seqs.length === 0) return [];
      const set = seqs.join(",");
      const fetchRaw = await client.command(
        `FETCH ${set} (INTERNALDATE ENVELOPE BODY.PEEK[TEXT])`,
      );
      return filterMessages(parseFetchBlocks(fetchRaw), query);
    } finally {
      await client.logout();
    }
  }
}

export function createImapMailTransport(opts: ImapTransportOptions): ImapMailTransport {
  return new ImapMailTransport(opts);
}

/**
 * P1.3：设置页「测试连接」——仅 LOGIN/LOGOUT，不取信、不落码。
 * 错误文案不含密码；命令失败统一归为 auth_failed / network。
 */
export async function probeImapLogin(
  opts: ImapTransportOptions,
): Promise<{ ok: true } | { ok: false; reason: "auth_failed" | "network"; detail: string }> {
  let client: ImapLineClient | null = null;
  try {
    if (/[\r\n"]/.test(opts.user) || /[\r\n"]/.test(opts.password)) {
      return { ok: false, reason: "auth_failed", detail: "用户名或密码含不安全字符" };
    }
    client = await ImapLineClient.connect({
      ...opts,
      commandTimeoutMs: Math.max(3_000, opts.commandTimeoutMs ?? 15_000),
    });
    await client.command(`LOGIN "${opts.user}" "${opts.password}"`);
    return { ok: true };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error ?? "");
    const lower = raw.toLowerCase();
    if (
      lower.includes("imap_command_failed") ||
      lower.includes("auth") ||
      lower.includes("login") ||
      lower.includes("imap_auth")
    ) {
      return { ok: false, reason: "auth_failed", detail: "IMAP 登录失败（账号或密码错误）" };
    }
    return {
      ok: false,
      reason: "network",
      detail: lower.includes("timeout")
        ? "连接超时，请检查主机/端口/TLS"
        : "无法连接 IMAP 服务器，请检查主机与网络",
    };
  } finally {
    if (client) {
      await client.logout().catch(() => undefined);
    }
  }
}

/** 可注入 HTTP（单测 mock；生产用全局 fetch） */
export type TempmailHttp = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/**
 * 临时邮适配器注册表（无默认网页邮箱）；未注册 provider → not_configured。
 * P5.2：内置服务商由 tempmail_providers.ensureDefaultTempmailProviders 种子。
 */
export type TempmailProviderAdapter = {
  providerId: string;
  aliases?: string[];
  /** 默认 true；false 时允许空 apiKey（仍须显式配置通道） */
  requiresApiKey?: boolean;
  /** 显式 true 时取信须 inboxAddress；未声明则不强制（兼容自定义适配器） */
  requiresInbox?: boolean;
  fetchInbox: (input: {
    apiKey: string;
    inboxAddress?: string;
    query: MailFetchQuery;
    http?: TempmailHttp;
  }) => Promise<MailMessage[]>;
  /** 可选连通性探测（不取码） */
  probe?: (input: {
    apiKey: string;
    inboxAddress?: string;
    http?: TempmailHttp;
  }) => Promise<{ ok: true } | { ok: false; detail: string }>;
};

const tempmailAdapters = new Map<string, TempmailProviderAdapter>();
let tempmailDefaultsInstaller: (() => void) | null = null;
let tempmailDefaultsInstalled = false;

/** 由 tempmail_providers 安装；避免循环依赖在顶层拉取适配器实现 */
export function setTempmailDefaultsInstaller(installer: (() => void) | null): void {
  tempmailDefaultsInstaller = installer;
}

export function registerTempmailProvider(adapter: TempmailProviderAdapter): void {
  const id = String(adapter.providerId ?? "").trim().toLowerCase();
  if (!id) return;
  tempmailAdapters.set(id, { ...adapter, providerId: id });
  for (const alias of adapter.aliases ?? []) {
    const key = String(alias ?? "").trim().toLowerCase();
    if (key && key !== id) {
      tempmailAdapters.set(key, { ...adapter, providerId: id });
    }
  }
}

export function getTempmailProvider(providerId: string): TempmailProviderAdapter | null {
  if (!tempmailDefaultsInstalled && tempmailDefaultsInstaller) {
    tempmailDefaultsInstalled = true;
    tempmailDefaultsInstaller();
  }
  return tempmailAdapters.get(String(providerId ?? "").trim().toLowerCase()) ?? null;
}

/** 不触发默认种子；供 ensureDefault 跳过已注册项 */
export function hasTempmailProvider(providerId: string): boolean {
  return tempmailAdapters.has(String(providerId ?? "").trim().toLowerCase());
}

export function clearTempmailProviders(): void {
  tempmailAdapters.clear();
  tempmailDefaultsInstalled = false;
}
