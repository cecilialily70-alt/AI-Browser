/**
 * Overlay 策略：结构脱敏指纹 + 复发预算（禁止文案 hash 被倒计时击穿）。
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright-core";

import { PAGE_PIPELINE_CONFIG } from "./config.js";

export interface OverlayHint {
  present: boolean;
  fingerprint: string | null;
  label: string | null;
  recurrenceCount: number;
  stopChasing: boolean;
  note: string;
}

interface OverlaySessionState {
  /** fingerprint → { count, lastAt } */
  seen: Map<string, { count: number; lastAt: number }>;
}

const sessions = new Map<string, OverlaySessionState>();

function sessionOf(profileId: string): OverlaySessionState {
  const key = profileId || "default";
  let s = sessions.get(key);
  if (!s) {
    s = { seen: new Map() };
    sessions.set(key, s);
  }
  return s;
}

/** 剥离动态文案后的结构骨架哈希 */
function structureFingerprint(skeleton: string): string {
  return createHash("sha1").update(skeleton || "none").digest("hex").slice(0, 16);
}

/**
 * 在页内扫描疑似遮罩，返回结构指纹（不含倒计时/在线人数等动态文本）。
 */
export async function detectOverlayHint(
  page: Page,
  profileId: string,
): Promise<OverlayHint> {
  let raw: { skeleton: string; label: string } | null = null;
  try {
    raw = await page.evaluate(() => {
      const MASK_RE =
        /mask|modal|overlay|dialog|popup|toast|cookie|consent|newsletter|subscribe|backdrop|drawer|广告|弹窗|隐私|同意/i;
      const DYNAMIC_RE =
        /\d{1,2}:\d{2}(?::\d{2})?|\d+\s*(人|在线|秒|分|时|天|%|折)|just\s*now|remaining|countdown/gi;

      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const candidates: Array<{ el: Element; score: number; label: string }> = [];

      const all = document.querySelectorAll("body *");
      for (const el of Array.from(all)) {
        if (!(el instanceof HTMLElement)) {
          continue;
        }
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          continue;
        }
        const pos = style.position;
        if (pos !== "fixed" && pos !== "absolute" && pos !== "sticky") {
          continue;
        }
        const rect = el.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        const cover = area / (vw * vh);
        if (cover < 0.18 && area < 40_000) {
          continue;
        }
        const cls = String(el.className || "");
        const id = String(el.id || "");
        const role = el.getAttribute("role") || "";
        const text = (el.innerText || "").slice(0, 120);
        const blob = `${cls} ${id} ${role} ${text}`;
        if (!MASK_RE.test(blob) && cover < 0.35) {
          continue;
        }
        const z = Number.parseInt(style.zIndex || "0", 10) || 0;
        const score = cover * 10 + (z > 10 ? 2 : 0) + (MASK_RE.test(blob) ? 3 : 0);
        const label = (text.replace(DYNAMIC_RE, "#").replace(/\s+/g, " ").trim() || role || cls)
          .slice(0, 48);
        candidates.push({ el, score, label });
      }

      candidates.sort((a, b) => b.score - a.score);
      const top = candidates[0];
      if (!top) {
        return null;
      }

      // 结构骨架：标签路径 + 稳定 class token（去掉 hash 类名）+ role/aria
      const parts: string[] = [];
      let cur: Element | null = top.el;
      let depth = 0;
      while (cur && depth < 6) {
        const tag = cur.tagName.toLowerCase();
        const role = cur.getAttribute("role") || "";
        const aria = cur.getAttribute("aria-modal") || cur.getAttribute("aria-label") || "";
        const stableClass = String(cur.className || "")
          .split(/\s+/)
          .filter(
            (c) =>
              c &&
              c.length < 40 &&
              !/^[a-f0-9_-]{10,}$/i.test(c) &&
              !/^\d/.test(c),
          )
          .slice(0, 3)
          .join(".");
        parts.push(`${tag}[${role}|${aria.slice(0, 20)}|${stableClass}]`);
        cur = cur.parentElement;
        depth += 1;
      }
      return { skeleton: parts.join(">"), label: top.label };
    });
  } catch {
    raw = null;
  }

  if (!raw?.skeleton) {
    return {
      present: false,
      fingerprint: null,
      label: null,
      recurrenceCount: 0,
      stopChasing: false,
      note: "未检测到明显遮罩",
    };
  }

  const fingerprint = structureFingerprint(raw.skeleton);
  const state = sessionOf(profileId);
  const now = Date.now();
  const prev = state.seen.get(fingerprint);
  let count = 1;
  if (prev && now - prev.lastAt <= PAGE_PIPELINE_CONFIG.overlayRecurrenceWindowMs) {
    count = prev.count + 1;
  }
  state.seen.set(fingerprint, { count, lastAt: now });

  // 清理过期
  for (const [fp, row] of state.seen) {
    if (now - row.lastAt > PAGE_PIPELINE_CONFIG.overlayRecurrenceWindowMs * 2) {
      state.seen.delete(fp);
    }
  }

  const stopChasing = count >= PAGE_PIPELINE_CONFIG.overlayRecurrenceStopAt;
  return {
    present: true,
    fingerprint,
    label: raw.label || null,
    recurrenceCount: count,
    stopChasing,
    note: stopChasing
      ? `遮罩「${raw.label}」短窗内第 ${count} 次出现：停止追逐，勿死磕关闭`
      : `检测到遮罩「${raw.label}」(结构指纹 ${fingerprint.slice(0, 8)}… · 第 ${count} 次)`,
  };
}

export function formatOverlayNudge(hint: OverlayHint): string | null {
  if (!hint.present) {
    return null;
  }
  if (hint.stopChasing) {
    return (
      "系统：同一广告/订阅弹层在短时间内反复出现。禁止继续死磕关闭；" +
      "可 wait、滚动主内容、换入口，或 handover_to_human。"
    );
  }
  return (
    "系统：页面存在弹层/遮罩。请优先处理关闭/同意/拒绝等控件，再继续主任务；" +
    "视觉截图为真值。"
  );
}
