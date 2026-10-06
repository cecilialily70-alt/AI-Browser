/**
 * 跨任务同站控件记忆 — Domain 级 LRU
 * 原则：只存脱敏 selector / 意图描述 / 可选视口坐标；绝不存填表值或密码。
 * Token 策略：开局命中 → 注入短 id 高优提示，减少探索轮次与视觉调用。
 */

export type ControlMemoryKind = "fill" | "click" | "vision";

export interface ControlMemoryEntry {
  domain: string;
  /** 自然语言意图，如「搜索输入框」「登录按钮」「语言球 EN」 */
  intent: string;
  /** 归一化查找键 */
  intentKey: string;
  kind: ControlMemoryKind;
  /** 脱敏后的稳定 selector（禁止临时短 id） */
  selector: string;
  /** 可见文案提示（用于对齐本轮短 id） */
  textHint: string;
  xPercent?: number;
  yPercent?: number;
  hitCount: number;
  updatedAt: string;
}

export function normalizeDomain(urlOrHost: string): string {
  const raw = String(urlOrHost ?? "").trim();
  if (!raw) {
    return "";
  }
  try {
    const host = raw.includes("://") ? new URL(raw).hostname : raw;
    return host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw.replace(/^www\./i, "").toLowerCase();
  }
}

export function parseControlMemorySeed(raw: unknown): ControlMemoryEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ControlMemoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    out.push({
      domain: String(row.domain ?? ""),
      intent: String(row.intent ?? ""),
      intentKey: String(row.intentKey ?? row.intent_key ?? ""),
      kind: (String(row.kind ?? "click") as ControlMemoryKind) || "click",
      selector: String(row.selector ?? ""),
      textHint: String(row.textHint ?? row.text_hint ?? ""),
      xPercent:
        row.xPercent != null
          ? Number(row.xPercent)
          : row.x_percent != null
            ? Number(row.x_percent)
            : undefined,
      yPercent:
        row.yPercent != null
          ? Number(row.yPercent)
          : row.y_percent != null
            ? Number(row.y_percent)
            : undefined,
      hitCount: Number(row.hitCount ?? row.hit_count ?? 1) || 1,
      updatedAt: String(row.updatedAt ?? row.updated_at ?? ""),
    });
  }
  return out;
}
