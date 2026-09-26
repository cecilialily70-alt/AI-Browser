/**
 * 邮件正文/主题 → OTP 码抽取（配置化正则，无站点发件人硬编码）
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAppEnv } from "../app_env.js";
import type { MailMessage } from "./types.js";

export type EmailOtpPattern = {
  id: string;
  source: "any" | "body" | "subject";
  regex: string;
  group: number;
  priority: number;
};

export type EmailOtpLexicon = {
  codeMinLength: number;
  codeMaxLength: number;
  maxCandidates: number;
  patterns: EmailOtpPattern[];
  subjectBoostTerms: string[];
  fromNoiseTerms: string[];
};

const DEFAULT_LEXICON: EmailOtpLexicon = {
  codeMinLength: 4,
  codeMaxLength: 8,
  maxCandidates: 8,
  patterns: [
    {
      id: "labeled_zh_fallback",
      source: "any",
      regex: "(?:验证码|校验码)[^0-9A-Za-z]{0,16}([0-9A-Za-z]{4,8})",
      group: 1,
      priority: 100,
    },
    {
      id: "digits_isolated_fallback",
      source: "body",
      regex: "(?<![0-9])([0-9]{4,8})(?![0-9])",
      group: 1,
      priority: 20,
    },
  ],
  subjectBoostTerms: ["验证码", "verification", "otp", "code"],
  fromNoiseTerms: ["noreply", "no-reply", "mailer-daemon"],
};

let cached: EmailOtpLexicon | null | undefined;

function lexiconCandidates(): string[] {
  const env = readAppEnv("EMAIL_OTP_LEXICON");
  const out: string[] = [];
  if (env) out.push(env);
  const here = dirname(fileURLToPath(import.meta.url));
  out.push(join(here, "../../config/email_otp_lexicon.json"));
  out.push(join(here, "../../../config/email_otp_lexicon.json"));
  out.push(join(process.cwd(), "config", "email_otp_lexicon.json"));
  out.push(join(process.cwd(), "sidecar", "config", "email_otp_lexicon.json"));
  return out;
}

export function resolveEmailOtpLexiconPath(): string | null {
  for (const candidate of lexiconCandidates()) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/\s+/g, " ").trim().toLowerCase())
        .filter((item) => item.length > 0 && item.length <= 64),
    ),
  );
}

function parsePatterns(raw: unknown): EmailOtpPattern[] {
  if (!Array.isArray(raw)) return [];
  const out: EmailOtpPattern[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const regex = typeof row.regex === "string" ? row.regex : "";
    if (!id || !regex) continue;
    const sourceRaw = String(row.source ?? "any").toLowerCase();
    const source: EmailOtpPattern["source"] =
      sourceRaw === "body" || sourceRaw === "subject" ? sourceRaw : "any";
    const group = Number.isFinite(Number(row.group)) ? Math.max(0, Math.floor(Number(row.group))) : 1;
    const priority = Number.isFinite(Number(row.priority)) ? Number(row.priority) : 0;
    out.push({ id, source, regex, group, priority });
  }
  return out;
}

export function loadEmailOtpLexicon(): EmailOtpLexicon {
  if (cached) return cached;
  const path = resolveEmailOtpLexiconPath();
  if (!path) {
    cached = DEFAULT_LEXICON;
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const policy =
      parsed.policy && typeof parsed.policy === "object"
        ? (parsed.policy as Record<string, unknown>)
        : {};
    const min = Number(policy.codeMinLength);
    const max = Number(policy.codeMaxLength);
    const maxCand = Number(policy.maxCandidates);
    const patterns = parsePatterns(parsed.patterns);
    cached = {
      codeMinLength: Number.isFinite(min) && min >= 3 ? Math.floor(min) : DEFAULT_LEXICON.codeMinLength,
      codeMaxLength: Number.isFinite(max) && max <= 16 ? Math.floor(max) : DEFAULT_LEXICON.codeMaxLength,
      maxCandidates:
        Number.isFinite(maxCand) && maxCand >= 1 ? Math.floor(maxCand) : DEFAULT_LEXICON.maxCandidates,
      patterns: patterns.length > 0 ? patterns : DEFAULT_LEXICON.patterns,
      subjectBoostTerms: asStringArray(parsed.subjectBoostTerms),
      fromNoiseTerms: asStringArray(parsed.fromNoiseTerms),
    };
  } catch {
    cached = DEFAULT_LEXICON;
  }
  return cached;
}

/** 测试用：清空词表缓存 */
export function resetEmailOtpLexiconCache(): void {
  cached = undefined;
}

function clampCode(raw: string, lexicon: EmailOtpLexicon): string | null {
  const code = String(raw ?? "").trim();
  if (code.length < lexicon.codeMinLength || code.length > lexicon.codeMaxLength) return null;
  if (!/^[0-9A-Za-z]+$/.test(code)) return null;
  // 拒绝疑似卡号/长数字串被截断误抽
  if (/^\d{13,}$/.test(code)) return null;
  return code;
}

type Candidate = { code: string; score: number; patternId: string };

function collectFromText(
  text: string,
  source: "body" | "subject",
  lexicon: EmailOtpLexicon,
  out: Candidate[],
): void {
  for (const pattern of lexicon.patterns) {
    if (pattern.source !== "any" && pattern.source !== source) continue;
    let re: RegExp;
    try {
      re = new RegExp(pattern.regex, "gi");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    let guard = 0;
    while ((match = re.exec(text)) && guard < 32) {
      guard += 1;
      const group = match[pattern.group] ?? match[1] ?? match[0];
      const code = clampCode(group, lexicon);
      if (!code) continue;
      out.push({ code, score: pattern.priority, patternId: pattern.id });
      if (out.length >= lexicon.maxCandidates * 3) return;
    }
  }
}

function hintBoost(value: string, hint: string | undefined): number {
  if (!hint) return 0;
  const hay = value.toLowerCase();
  const needle = hint.trim().toLowerCase();
  if (!needle) return 0;
  return hay.includes(needle) ? 25 : 0;
}

/**
 * 从单封邮件抽取最可能的 OTP。失败返回 null（由通道层映射为 parse_failed）。
 * 绝不抛出；调用方负责不把 code 写入日志/轨迹。
 */
export function extractOtpFromMessage(
  message: MailMessage,
  options?: { fromHint?: string; subjectHint?: string; lexicon?: EmailOtpLexicon },
): { code: string; patternId: string } | null {
  const lexicon = options?.lexicon ?? loadEmailOtpLexicon();
  const candidates: Candidate[] = [];
  collectFromText(String(message.subject ?? ""), "subject", lexicon, candidates);
  collectFromText(String(message.text ?? ""), "body", lexicon, candidates);
  if (candidates.length === 0) return null;

  const subjectLower = String(message.subject ?? "").toLowerCase();
  const fromLower = String(message.from ?? "").toLowerCase();
  const subjectBoost = lexicon.subjectBoostTerms.some((term) => subjectLower.includes(term)) ? 15 : 0;
  const fromNoise = lexicon.fromNoiseTerms.some((term) => fromLower.includes(term)) ? 0 : 5;

  for (const item of candidates) {
    item.score += subjectBoost + fromNoise;
    item.score += hintBoost(message.from, options?.fromHint);
    item.score += hintBoost(message.subject, options?.subjectHint);
    // 纯数字略加分（邮箱 OTP 多数为数字）
    if (/^\d+$/.test(item.code)) item.score += 5;
  }

  candidates.sort((a, b) => b.score - a.score || a.code.length - b.code.length);
  const best = candidates[0];
  if (!best) return null;
  return { code: best.code, patternId: best.patternId };
}

/**
 * 在多封候选邮件中选最新且可解析的一封。
 * messages 应按时间倒序或任意顺序；本函数按 dateIso 再排一次。
 */
export function extractOtpFromMessages(
  messages: MailMessage[],
  options?: { fromHint?: string; subjectHint?: string; lexicon?: EmailOtpLexicon },
): { code: string; messageId: string; patternId: string } | null {
  const sorted = [...messages].sort((a, b) => {
    const ta = Date.parse(a.dateIso) || 0;
    const tb = Date.parse(b.dateIso) || 0;
    return tb - ta;
  });
  for (const message of sorted) {
    const hit = extractOtpFromMessage(message, options);
    if (hit) {
      return { code: hit.code, messageId: message.messageId, patternId: hit.patternId };
    }
  }
  return null;
}
