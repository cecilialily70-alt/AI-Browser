/**
 * 点选验证码类型（策略 point_select_click）
 * 流水线：裁剪验证区 → 多模态 JSON 坐标 → 拟人点击 → 验收
 */
export type PointSelectStrategyId = "point_select_click";

export type CaptchaCrop = {
  /** 裁剪区左上角相对视口 CSS 像素（= screenshot clip 原点） */
  startX: number;
  startY: number;
  /** CSS 逻辑宽高（点击映射用，与 clip 一致） */
  width: number;
  height: number;
  instruction: string;
  /** DOM 题干不可靠（图标丢失等）时为 true：禁止喂给视觉作先验 */
  instructionUnreliable?: boolean;
  /** 送视觉的位图宽高（可能因 DPR 大于 CSS） */
  imageWidth?: number;
  imageHeight?: number;
  /** imageWidth / width；缺省按二者推算，至少为 1 */
  dpr?: number;
};

export type PixelPoint = { x: number; y: number };

export type PointSelectResult = {
  ok: boolean;
  strategy: PointSelectStrategyId | "unsupported";
  points: PixelPoint[];
  /** 视口绝对点击点（含 jitter 前规划） */
  viewportPoints: PixelPoint[];
  confidence: number;
  method: string;
  verified: boolean | null;
  verifySignal: string;
  protocolHints: string[];
  artifactPaths: string[];
  crop?: CaptchaCrop;
  detail: string;
};

export const FAIL_NEXT =
  "勿刷新；未满 3 次可再 solve_captcha；满 3 次 handover_to_human，禁止 ask_user 代点。";
