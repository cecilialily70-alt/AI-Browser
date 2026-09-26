/**
 * Agent 轨迹步骤 — 与 RpaAction 兼容，并扩展 navigate
 */
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SemanticContext } from "./semantic_sniff.js";
import { JsonLogger } from "./json-logger.js";
import { REDACTED_PLACEHOLDER, isSecretInput } from "./secret_redaction.js";

const logger = new JsonLogger();

export type TrajectoryActionType =
  | "navigate"
  | "fill"
  | "click"
  | "select"
  | "wait"
  | "click_point"
  | "keypress"
  | "scroll"
  /** N5 / N6：运行途中读一次剪贴板（页面通道优先，失败降级系统通道，见 §6.2） */
  | "clipboard_read";

export type { SemanticContext };

/** 动作执行后的页面特征（用于回放特征屏障） */
export interface TrajectoryPostCondition {
  url: string;
  title: string;
}

export interface TrajectoryStep {
  step: number;
  type: TrajectoryActionType;
  /** Playwright 选择器；navigate / keypress / scroll / 纯坐标时可为空 */
  selector: string;
  value?: string;
  dataKey?: string;
  /** 动作发生时的页面 URL（navigate 则为目标 URL） */
  url?: string;
  /** 执行后页面特征（click/navigate 等状态变更步）；旧轨迹可缺省 */
  postCondition?: TrajectoryPostCondition;
  /** 语义嗅探：人类可读 Label + 来源 + inputType */
  semanticContext?: SemanticContext;
  /** 冗余顶层 inputType（与 semanticContext.inputType 对齐，便于沙盘/回放） */
  inputType?: string;
  /** 冗余顶层 label（兼容旧沙盘 derive） */
  label?: string;
  /** 视觉/坐标点击：视口像素坐标（落盘时转为相对坐标） */
  x?: number;
  y?: number;
  /** 录制时视口尺寸，回放按比例缩放坐标 */
  viewport?: { w: number; h: number };
  /** 坐标反推得到的自愈选择器 */
  fallbackSelector?: string;
  /** Omni 网关主选择器（与 selector 对齐，供回放/沙盘） */
  primarySelector?: string;
  /** 坐标保底：优先 unit=relative（视口 0–1）；旧轨迹可能为像素 */
  fallbackCoordinates?: { x: number; y: number; unit?: "relative" | "px" };
  /** 人类可读语义（如「语言切换」），沙盘展示用 */
  semanticLabel?: string;
  /** 敏感字段（密码/验证码等）已脱敏：value 为占位符，回放时不得当真实值回填 */
  redacted?: boolean;
  /** `clipboard_read`：读取通道（页面剪贴板优先 / 系统剪贴板） */
  scope?: "page" | "system";
  /** `clipboard_read`：写入哪个变量（`{{clip.<into>}}`；缺省按顺序号 `{{clip.N}}`） */
  into?: string;
  /** `clipboard_read`（scope=page）：授权域 */
  origin?: string;
  /** `clipboard_read`：读取超时 */
  timeoutMs?: number;
}

export interface AgentTrajectoryPayload {
  domain: string;
  title: string;
  goal: string;
  startUrl: string;
  actions: TrajectoryStep[];
  /** ISO 时间，便于 UI 列表展示 */
  savedAt?: string;
  /** 落盘相对路径或绝对路径 */
  filePath?: string;
}

export interface TrajectoryFileMeta {
  fileName: string;
  filePath: string;
  domain: string;
  title: string;
  goal: string;
  startUrl: string;
  stepCount: number;
  savedAt: string;
  actions: TrajectoryStep[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** sidecar 根目录（src 或 dist 的上一级） */
export const SIDECAR_ROOT = path.resolve(__dirname, "..");
export const TRAJECTORIES_DIR = path.join(SIDECAR_ROOT, "agent_exports", "trajectories");

export function domainFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return host || "unknown";
  } catch {
    return "unknown";
  }
}

export function buildTrajectoryTitle(goal: string, domain: string): string {
  const trimmed = goal.replace(/\s+/g, " ").trim();
  const short = trimmed.length > 36 ? `${trimmed.slice(0, 36)}…` : trimmed;
  return short || `轨迹 · ${domain}`;
}

/** 纯数字 selector = 临时 ID 污染，禁止写入轨迹 */
export function isTempIdSelector(selector: string): boolean {
  return /^\d+$/.test(String(selector ?? "").trim());
}

/**
 * 轨迹落盘/上报前脱敏：密码、验证码等敏感字段的录制值替换为占位符并标记 `redacted`。
 * 幂等——已脱敏条目原样保留；`navigate/wait` 等非填值步骤不受影响（wait 的 value 是毫秒数）。
 */
export function redactTrajectorySecrets(actions: TrajectoryStep[]): TrajectoryStep[] {
  return actions.map((step) => {
    if (step.redacted || step.value == null) {
      return step;
    }
    if (step.type !== "fill" && step.type !== "select") {
      return step;
    }
    const secret = isSecretInput({
      inputType: step.inputType ?? step.semanticContext?.inputType,
      label: step.semanticLabel ?? step.label ?? step.semanticContext?.label,
      selector: step.primarySelector ?? step.selector,
    });
    return secret ? { ...step, value: REDACTED_PLACEHOLDER, redacted: true } : step;
  });
}

function hasFiniteCoords(
  coords?: { x?: number; y?: number } | null,
  x?: number,
  y?: number,
): boolean {
  if (coords && Number.isFinite(coords.x) && Number.isFinite(coords.y)) {
    return true;
  }
  return Number.isFinite(Number(x)) && Number.isFinite(Number(y));
}

/**
 * 落盘前归一化：保证 semanticLabel / inputType 对沙盘可读；不发明假选择器。
 */
export function normalizeTrajectoryStepForPersist(step: TrajectoryStep): TrajectoryStep {
  const semantic = step.semanticContext;
  const labelFromCtx =
    semantic && typeof semantic === "object"
      ? String(semantic.label ?? "").trim()
      : "";
  const inputFromCtx =
    semantic && typeof semantic === "object"
      ? String(semantic.inputType ?? "").trim()
      : "";
  const semanticLabel =
    String(step.semanticLabel ?? "").trim() ||
    String(step.label ?? "").trim() ||
    labelFromCtx ||
    undefined;
  const inputType =
    String(step.inputType ?? "").trim() || inputFromCtx || undefined;
  const primarySelector =
    String(step.primarySelector ?? "").trim() ||
    String(step.selector ?? "").trim() ||
    undefined;
  const next: TrajectoryStep = {
    ...step,
    primarySelector,
    semanticLabel,
    label: semanticLabel ?? step.label,
    inputType: inputType || step.inputType,
  };
  if (
    next.fallbackCoordinates == null &&
    Number.isFinite(Number(next.x)) &&
    Number.isFinite(Number(next.y))
  ) {
    next.fallbackCoordinates = { x: Number(next.x), y: Number(next.y) };
  }
  return next;
}

/**
 * 落库前强校验：拒绝 null / 临时 ID / fill·click·select 空 selector；
 * click 必须具备 primarySelector（或 selector）或 fallbackCoordinates。
 */
export function assertPersistableTrajectorySteps(actions: TrajectoryStep[]): void {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("轨迹为空，拒绝落库");
  }
  for (let index = 0; index < actions.length; index += 1) {
    const step = actions[index] as TrajectoryStep & { selector?: unknown };
    const stepNo = step.step ?? index + 1;
    const type = String(step.type ?? "").trim();
    const raw = step.selector;

    if (raw === null) {
      throw new Error(`step=${stepNo} selector 为 null，拒绝落库`);
    }
    if (raw !== undefined && typeof raw !== "string") {
      throw new Error(`step=${stepNo} selector 类型非法(${typeof raw})，拒绝落库`);
    }
    const selector = typeof raw === "string" ? raw.trim() : "";
    if (isTempIdSelector(selector)) {
      throw new Error(
        `轨迹含临时 ID selector（step=${stepNo} selector=${selector}），拒绝落库`,
      );
    }
    if ((type === "fill" || type === "select") && !selector) {
      throw new Error(`step=${stepNo} ${type} 缺少有效 selector，拒绝落库`);
    }
    if (type === "fill" || type === "select") {
      const label = String(step.semanticLabel ?? step.label ?? "").trim();
      if (!label) {
        // 软警告：不拒绝落库，但沙盘将降级到 selector 片段
        logger.warn("trajectory_missing_semantic_label", { step: stepNo, type });
      }
    }
    if (type === "click") {
      const primary = String(step.primarySelector ?? step.fallbackSelector ?? selector).trim();
      const hasCoords = hasFiniteCoords(step.fallbackCoordinates, step.x, step.y);
      if (!primary && !hasCoords) {
        throw new Error(`step=${stepNo} click 缺少 primarySelector/selector 与坐标，拒绝落库`);
      }
    }
    if (type === "click_point") {
      const fallback = String(step.fallbackSelector ?? step.primarySelector ?? "").trim();
      const hasHeal = Boolean(selector || fallback);
      const hasCoords = hasFiniteCoords(step.fallbackCoordinates, step.x, step.y);
      if (!hasHeal && !hasCoords) {
        throw new Error(
          `step=${stepNo} click_point 缺少 fallbackSelector/selector 与坐标，拒绝落库`,
        );
      }
    }
  }
}

function sanitizeFilePart(value: string, maxLen = 48): string {
  const cleaned = value
    .replace(/\s+/g, "_")
    .replace(/[^\w.\u4e00-\u9fff-]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const sliced = cleaned.slice(0, maxLen);
  return sliced || "untitled";
}

/** 文件名：域名_意图摘要_时间戳.json */
export function buildTrajectoryFilename(domain: string, goal: string, at = new Date()): string {
  const ts = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const domainPart = sanitizeFilePart(domain, 40);
  const goalPart = sanitizeFilePart(goal.replace(/\s+/g, "_"), 36);
  return `${domainPart}_${goalPart}_${ts}.json`;
}

export function buildTrajectoryPayload(input: {
  goal: string;
  startUrl: string;
  actions: TrajectoryStep[];
  domain?: string;
}): AgentTrajectoryPayload {
  const domain = input.domain ?? domainFromUrl(input.startUrl);
  return {
    domain,
    title: buildTrajectoryTitle(input.goal, domain),
    goal: input.goal,
    startUrl: input.startUrl,
    // 出口统一脱敏：磁盘文件与 IPC/DB 上报复用同一份 actions，避免两处漂移
    actions: redactTrajectorySecrets(input.actions),
    savedAt: new Date().toISOString(),
  };
}

/**
 * 将成功轨迹持久化到 agent_exports/trajectories/
 * 调用方须先判断 enableRecording；本函数不做业务开关，仅写盘。
 * @returns 写入的绝对路径
 */
export async function persistTrajectoryToDisk(
  payload: AgentTrajectoryPayload,
): Promise<string> {
  const actions = payload.actions.map((step) => normalizeTrajectoryStepForPersist(step));
  assertPersistableTrajectorySteps(actions);

  await mkdir(TRAJECTORIES_DIR, { recursive: true });
  const filename = buildTrajectoryFilename(payload.domain, payload.goal || payload.title);
  const filePath = path.join(TRAJECTORIES_DIR, filename);
  const body: AgentTrajectoryPayload = {
    ...payload,
    actions,
    savedAt: payload.savedAt ?? new Date().toISOString(),
    filePath,
  };
  await writeFile(filePath, JSON.stringify(body, null, 2), "utf8");
  return filePath;
}

export async function listPersistedTrajectories(
  domainFilter?: string,
): Promise<TrajectoryFileMeta[]> {
  await mkdir(TRAJECTORIES_DIR, { recursive: true });
  let entries: string[] = [];
  try {
    entries = await readdir(TRAJECTORIES_DIR);
  } catch {
    return [];
  }

  const filter = (domainFilter ?? "").trim().toLowerCase().replace(/^www\./, "");
  const items: TrajectoryFileMeta[] = [];

  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".json")) {
      continue;
    }
    const filePath = path.join(TRAJECTORIES_DIR, name);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as AgentTrajectoryPayload;
      const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      const domain = String(parsed.domain ?? domainFromUrl(parsed.startUrl ?? "")).trim();
      if (filter && domain.toLowerCase().replace(/^www\./, "") !== filter) {
        continue;
      }
      items.push({
        fileName: name,
        filePath,
        domain: domain || "unknown",
        title: String(parsed.title ?? buildTrajectoryTitle(parsed.goal ?? "", domain)),
        goal: String(parsed.goal ?? ""),
        startUrl: String(parsed.startUrl ?? ""),
        stepCount: actions.length,
        savedAt: String(parsed.savedAt ?? ""),
        actions,
      });
    } catch {
      // 跳过损坏文件
    }
  }

  items.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return items;
}

/** 解析并校验路径必须落在轨迹目录内（含目录本身），否则拒绝读写/删除。 */
function resolveInsideTrajectories(filePath: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(TRAJECTORIES_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("拒绝访问轨迹目录以外的文件");
  }
  return resolved;
}

export async function loadTrajectoryFromFile(filePath: string): Promise<AgentTrajectoryPayload> {
  const resolved = resolveInsideTrajectories(filePath);
  const raw = await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as AgentTrajectoryPayload;
  if (!Array.isArray(parsed.actions)) {
    throw new Error(`轨迹文件缺少 actions: ${resolved}`);
  }
  return parsed;
}

export async function deletePersistedTrajectory(filePath: string): Promise<void> {
  await unlink(resolveInsideTrajectories(filePath));
}
