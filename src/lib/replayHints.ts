/**
 * 轨迹回放难点提示（与 sidecar/src/trajectory.ts 同源口径）。
 * 嵌在 actions JSON 数组首项，DB 无新列时仍可被前端识别。
 */

const REPLAY_HINTS_MARKER = "_replayHints";

export interface TrajectoryReplayHints {
  needsHuman: boolean;
  nonMechanical: boolean;
  reasons: string[];
}

const REASON_LABELS: Record<string, string> = {
  captcha: "验证码",
  otp: "邮箱/短信验证码",
  handover: "人工接管",
  ask_user: "向用户提问",
  download: "下载",
  custom_dropdown: "自定义下拉",
  redacted_fill: "脱敏填值（须数据集/沙盘覆盖）",
  switch_tab: "切标签/弹窗",
};

function reasonLabel(reason: string): string {
  const key = String(reason ?? "").trim();
  return REASON_LABELS[key] || key || "未知难点";
}

function unpackReplayHints(raw: unknown): {
  actions: unknown[];
  hints: TrajectoryReplayHints | null;
} {
  if (!Array.isArray(raw)) {
    return { actions: [], hints: null };
  }
  let hints: TrajectoryReplayHints | null = null;
  const actions: unknown[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>)[REPLAY_HINTS_MARKER] === true
    ) {
      const rec = item as Record<string, unknown>;
      const reasons = Array.isArray(rec.reasons)
        ? rec.reasons.map((r) => String(r)).filter(Boolean)
        : [];
      hints = {
        needsHuman: rec.needsHuman === true,
        nonMechanical: rec.nonMechanical === true,
        reasons,
      };
      continue;
    }
    actions.push(item);
  }
  if (!hints && actions.some((s) => s && typeof s === "object" && (s as { redacted?: boolean }).redacted === true)) {
    hints = {
      needsHuman: true,
      nonMechanical: true,
      reasons: ["redacted_fill"],
    };
  }
  return { actions, hints };
}

export function parseTrajectoryActionsJson(actionsJson: string): {
  actions: unknown[];
  hints: TrajectoryReplayHints | null;
} {
  try {
    return unpackReplayHints(JSON.parse(actionsJson) as unknown);
  } catch {
    return { actions: [], hints: null };
  }
}

/** 沙盘 / 列表黄条文案：有难点才返回，否则 null */
export function replayHardCaseBanner(hints: TrajectoryReplayHints | null | undefined): string | null {
  if (!hints || (!hints.needsHuman && !hints.nonMechanical && hints.reasons.length === 0)) {
    return null;
  }
  const labels = hints.reasons.map(reasonLabel);
  const head = hints.needsHuman
    ? "本轨迹含需人工/非机械难点，不能当纯机械批量零成本复制"
    : "本轨迹含非纯机械步骤，批量回放可能不完整";
  return `${head}：${labels.join("、") || "需人工"}。验证码/OTP 不会自动复现；脱敏字段须覆盖。定位失败时会单步 AI 愈合后再交回机械（不会让 AI 跑完全程）。`;
}
