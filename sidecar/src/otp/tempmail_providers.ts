/**
 * P5.2：临时邮 provider 适配器（配置驱动）
 *
 * - 默认不开启；须通道显式配置 providerId +（多数）inboxAddress
 * - 密钥仅运行时注入；禁止网页邮箱路径
 * - 未知 provider / 缺配置 → 调用方 not_configured → Layer 3 HITL
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";
import {
  hasTempmailProvider,
  registerTempmailProvider,
  setTempmailDefaultsInstaller,
  type TempmailHttp,
  type TempmailProviderAdapter,
} from "./mail_transport.js";
import type { MailFetchQuery, MailMessage } from "./types.js";

export type TempmailProviderMeta = {
  id: string;
  baseUrl: string;
  requiresApiKey: boolean;
  requiresInbox: boolean;
  aliases: string[];
};

type TempmailProvidersFile = {
  providers?: Record<
    string,
    {
      baseUrl?: string;
      requiresApiKey?: boolean;
      requiresInbox?: boolean;
      aliases?: string[];
    }
  >;
};

const BUILTIN_META: TempmailProviderMeta[] = [
  {
    id: "mailslurp",
    baseUrl: "https://api.mailslurp.com",
    requiresApiKey: true,
    requiresInbox: true,
    aliases: ["mail-slurp"],
  },
  {
    id: "1secmail",
    baseUrl: "https://www.1secmail.com/api/v1",
    requiresApiKey: false,
    requiresInbox: true,
    aliases: ["onesecmail", "1sec"],
  },
];

let cachedMeta: TempmailProviderMeta[] | null = null;
let defaultsSeeded = false;

function configCandidates(): string[] {
  const env = readAppEnv("TEMPMAIL_PROVIDERS_CONFIG");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/tempmail_providers.json"));
  out.push(join(here, "../../../config/tempmail_providers.json"));
  out.push(join(process.cwd(), "config", "tempmail_providers.json"));
  out.push(join(process.cwd(), "sidecar", "config", "tempmail_providers.json"));
  return out;
}

export function resolveTempmailProvidersConfigPath(): string | null {
  for (const candidate of configCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function loadProviderMeta(): TempmailProviderMeta[] {
  if (cachedMeta) return cachedMeta;
  const path = resolveTempmailProvidersConfigPath();
  if (!path) {
    cachedMeta = BUILTIN_META.map((m) => ({ ...m, aliases: [...m.aliases] }));
    return cachedMeta;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as TempmailProvidersFile;
    const rows = raw.providers ?? {};
    const out: TempmailProviderMeta[] = [];
    for (const [id, row] of Object.entries(rows)) {
      const needle = String(id ?? "").trim().toLowerCase();
      if (!needle) continue;
      const builtin = BUILTIN_META.find((m) => m.id === needle);
      const baseUrl = String(row.baseUrl ?? builtin?.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!baseUrl) continue;
      const aliases = Array.isArray(row.aliases)
        ? row.aliases.map((a) => String(a ?? "").trim().toLowerCase()).filter(Boolean)
        : [...(builtin?.aliases ?? [])];
      out.push({
        id: needle,
        baseUrl,
        requiresApiKey: row.requiresApiKey === false ? false : (builtin?.requiresApiKey ?? true),
        requiresInbox: row.requiresInbox === false ? false : (builtin?.requiresInbox ?? true),
        aliases,
      });
    }
    cachedMeta = out.length > 0 ? out : BUILTIN_META.map((m) => ({ ...m, aliases: [...m.aliases] }));
  } catch {
    cachedMeta = BUILTIN_META.map((m) => ({ ...m, aliases: [...m.aliases] }));
  }
  return cachedMeta;
}

export function resetTempmailProvidersConfigCache(): void {
  cachedMeta = null;
}

export function listTempmailProviderMeta(): TempmailProviderMeta[] {
  return loadProviderMeta().map((m) => ({ ...m, aliases: [...m.aliases] }));
}

export function listTempmailProviderIds(): string[] {
  ensureDefaultTempmailProviders();
  return listTempmailProviderMeta().map((m) => m.id);
}

export function getTempmailProviderMeta(providerId: string): TempmailProviderMeta | null {
  const needle = String(providerId ?? "").trim().toLowerCase();
  if (!needle) return null;
  return (
    loadProviderMeta().find(
      (m) => m.id === needle || m.aliases.some((a) => a === needle),
    ) ?? null
  );
}

function defaultHttp(): TempmailHttp {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.json(),
      text: async () => res.text(),
    };
  };
}

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

function isUuid(raw: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim());
}

function splitMailbox(address: string): { login: string; domain: string } | null {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const login = trimmed.slice(0, at).trim();
  const domain = trimmed.slice(at + 1).trim();
  if (!login || !domain) return null;
  return { login, domain };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function strField(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function throwHttpError(status: number, detail: string): never {
  if (status === 401 || status === 403) {
    throw new Error(`tempmail_auth_failed:${detail}`);
  }
  throw new Error(`tempmail_http_${status}:${detail}`);
}

export function createMailslurpAdapter(meta: TempmailProviderMeta): TempmailProviderAdapter {
  const baseUrl = meta.baseUrl.replace(/\/+$/, "");

  async function resolveInboxId(
    apiKey: string,
    inboxAddress: string,
    http: TempmailHttp,
  ): Promise<string> {
    const addr = inboxAddress.trim();
    if (isUuid(addr)) return addr;
    const url = `${baseUrl}/inboxes?search=${encodeURIComponent(addr)}&size=5&page=0`;
    const res = await http(url, {
      method: "GET",
      headers: { Accept: "application/json", "x-api-key": apiKey },
    });
    if (!res.ok) {
      throwHttpError(res.status, "mailslurp inbox lookup failed");
    }
    const json = await res.json();
    const root = asRecord(json);
    const content = Array.isArray(json)
      ? json
      : Array.isArray(root?.content)
        ? root.content
        : [];
    for (const item of content) {
      const row = asRecord(item);
      if (!row) continue;
      const email = strField(row, "emailAddress", "email");
      const id = strField(row, "id");
      if (id && (!email || email.toLowerCase() === addr.toLowerCase())) {
        return id;
      }
    }
    throw new Error("tempmail_auth_failed:mailslurp inbox not found");
  }

  return {
    providerId: meta.id,
    aliases: meta.aliases,
    requiresApiKey: true,
    requiresInbox: true,
    async probe({ apiKey, inboxAddress, http }) {
      const client = http ?? defaultHttp();
      if (!String(apiKey ?? "").trim()) {
        return { ok: false, detail: "缺少 MailSlurp API Key" };
      }
      if (!String(inboxAddress ?? "").trim()) {
        return { ok: false, detail: "请填写 MailSlurp 收件箱 UUID 或邮箱地址" };
      }
      try {
        const inboxId = await resolveInboxId(apiKey, inboxAddress!, client);
        const res = await client(`${baseUrl}/inboxes/${encodeURIComponent(inboxId)}`, {
          method: "GET",
          headers: { Accept: "application/json", "x-api-key": apiKey },
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            return { ok: false, detail: "MailSlurp API Key 无效或无权访问" };
          }
          return { ok: false, detail: `MailSlurp 探测失败（HTTP ${res.status}）` };
        }
        return { ok: true };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error ?? "");
        if (msg.includes("tempmail_auth_failed")) {
          return { ok: false, detail: "MailSlurp 认证失败或收件箱不存在" };
        }
        return { ok: false, detail: "MailSlurp 网络或 API 调用失败" };
      }
    },
    async fetchInbox({ apiKey, inboxAddress, query, http }) {
      const client = http ?? defaultHttp();
      if (!String(apiKey ?? "").trim()) {
        throw new Error("tempmail_auth_failed:missing api key");
      }
      if (!String(inboxAddress ?? "").trim()) {
        throw new Error("tempmail_not_configured:missing inbox");
      }
      const inboxId = await resolveInboxId(apiKey, inboxAddress!, client);
      const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
      const params = new URLSearchParams({
        limit: String(limit),
        sort: "DESC",
      });
      if (query.sinceIso) params.set("since", query.sinceIso);
      const listRes = await client(
        `${baseUrl}/inboxes/${encodeURIComponent(inboxId)}/emails?${params.toString()}`,
        {
          method: "GET",
          headers: { Accept: "application/json", "x-api-key": apiKey },
        },
      );
      if (!listRes.ok) {
        throwHttpError(listRes.status, "mailslurp list emails failed");
      }
      const listJson = await listRes.json();
      const previews = Array.isArray(listJson) ? listJson : [];
      const out: MailMessage[] = [];
      for (const preview of previews.slice(0, limit)) {
        const row = asRecord(preview);
        if (!row) continue;
        const emailId = strField(row, "id");
        if (!emailId) continue;
        let text = strField(row, "bodyExcerpt", "subject");
        let from = strField(row, "from");
        let subject = strField(row, "subject");
        let dateIso = strField(row, "createdAt", "receivedAt", "date");
        try {
          const fullRes = await client(`${baseUrl}/emails/${encodeURIComponent(emailId)}`, {
            method: "GET",
            headers: { Accept: "application/json", "x-api-key": apiKey },
          });
          if (fullRes.ok) {
            const full = asRecord(await fullRes.json());
            if (full) {
              text =
                strField(full, "body", "textBody", "bodyExcerpt") ||
                strField(full, "subject") ||
                text;
              from = strField(full, "from") || from;
              subject = strField(full, "subject") || subject;
              dateIso = strField(full, "createdAt", "receivedAt") || dateIso;
            }
          }
        } catch {
          /* 正文拉取失败时仍用预览 */
        }
        const parsedDate = Date.parse(dateIso);
        out.push({
          messageId: emailId,
          from,
          subject,
          dateIso: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : new Date(0).toISOString(),
          text,
        });
      }
      return filterMessages(out, query);
    },
  };
}

export function createOneSecmailAdapter(meta: TempmailProviderMeta): TempmailProviderAdapter {
  const baseUrl = meta.baseUrl.replace(/\/+$/, "");

  return {
    providerId: meta.id,
    aliases: meta.aliases,
    requiresApiKey: false,
    requiresInbox: true,
    async probe({ inboxAddress, http }) {
      const client = http ?? defaultHttp();
      const parts = splitMailbox(String(inboxAddress ?? ""));
      if (!parts) {
        return { ok: false, detail: "请填写完整收件地址（login@domain）" };
      }
      try {
        const url = `${baseUrl}/?action=getMessages&login=${encodeURIComponent(parts.login)}&domain=${encodeURIComponent(parts.domain)}`;
        const res = await client(url, { method: "GET", headers: { Accept: "application/json" } });
        if (!res.ok) {
          return { ok: false, detail: `1secmail 探测失败（HTTP ${res.status}）` };
        }
        // 空收件箱也算连通成功（返回 []）
        await res.json().catch(() => []);
        return { ok: true };
      } catch {
        return { ok: false, detail: "1secmail 网络或 API 调用失败" };
      }
    },
    async fetchInbox({ inboxAddress, query, http }) {
      const client = http ?? defaultHttp();
      const parts = splitMailbox(String(inboxAddress ?? ""));
      if (!parts) {
        throw new Error("tempmail_not_configured:missing inbox");
      }
      const listUrl = `${baseUrl}/?action=getMessages&login=${encodeURIComponent(parts.login)}&domain=${encodeURIComponent(parts.domain)}`;
      const listRes = await client(listUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!listRes.ok) {
        throwHttpError(listRes.status, "1secmail list failed");
      }
      const listJson = await listRes.json();
      const previews = Array.isArray(listJson) ? listJson : [];
      const limit = Math.max(1, Math.min(query.limit ?? 20, 50));
      const out: MailMessage[] = [];
      for (const preview of previews.slice(0, limit)) {
        const row = asRecord(preview);
        if (!row) continue;
        const id = strField(row, "id");
        if (!id) continue;
        const readUrl = `${baseUrl}/?action=readMessage&login=${encodeURIComponent(parts.login)}&domain=${encodeURIComponent(parts.domain)}&id=${encodeURIComponent(id)}`;
        let text = strField(row, "subject");
        let from = strField(row, "from");
        let subject = strField(row, "subject");
        let dateIso = strField(row, "date");
        try {
          const fullRes = await client(readUrl, {
            method: "GET",
            headers: { Accept: "application/json" },
          });
          if (fullRes.ok) {
            const full = asRecord(await fullRes.json());
            if (full) {
              text =
                strField(full, "textBody", "body") ||
                strField(full, "htmlBody") ||
                subject ||
                text;
              from = strField(full, "from") || from;
              subject = strField(full, "subject") || subject;
              dateIso = strField(full, "date") || dateIso;
            }
          }
        } catch {
          /* keep preview */
        }
        const parsedDate = Date.parse(dateIso);
        out.push({
          messageId: `1secmail-${id}`,
          from,
          subject,
          dateIso: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : new Date(0).toISOString(),
          text: text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        });
      }
      return filterMessages(out, query);
    },
  };
}

function buildAdapter(meta: TempmailProviderMeta): TempmailProviderAdapter | null {
  if (meta.id === "mailslurp") return createMailslurpAdapter(meta);
  if (meta.id === "1secmail") return createOneSecmailAdapter(meta);
  // 配置里出现未知 id 但无实现：跳过（不伪装成功）
  return null;
}

/**
 * 注册内置临时邮适配器（仅补齐缺失项；已手动 register 的不被覆盖）。
 */
export function ensureDefaultTempmailProviders(): void {
  for (const meta of loadProviderMeta()) {
    if (hasTempmailProvider(meta.id)) continue;
    const adapter = buildAdapter(meta);
    if (adapter) registerTempmailProvider(adapter);
  }
  defaultsSeeded = true;
}

/** 测试用：允许 clear 后再种子 */
export function resetTempmailProviderDefaultsFlag(): void {
  defaultsSeeded = false;
}

// 安装到 mail_transport 注册表（运行时 getTempmailProvider 触发）
setTempmailDefaultsInstaller(() => {
  ensureDefaultTempmailProviders();
});
