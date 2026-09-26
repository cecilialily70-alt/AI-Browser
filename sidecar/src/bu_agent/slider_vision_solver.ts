/**
 * SliderVisionSolver —— 滑块视觉求解器（纯视觉，零浏览器依赖）。
 *
 * 设计边界（.cursorrules §4）：本类只做「图像 → 位移」的换算，不碰 DOM、不碰鼠标、
 * 不关心页面。浏览器侧只负责把两张图喂进来、把返回的位移拖出去，双方通过
 * SliderVisionInput / SliderVisionResult 契约通信，可独立单测与替换。
 *
 * 识别原理（抗诱饵缺口）：
 *   以滑块原图的 Alpha 通道提取真实物理轮廓与面积 → 对背景做 GaussianBlur + Canny
 *   提取全部轮廓 → ① 面积约束 ±15% 剔除「一大一小」诱饵缺口 → ② Hu 矩形状匹配
 *   (cv2.matchShapes) 在尺寸相符的候选中锁定形状最相似者。详见 opencv_preprocess.ts
 *   中 _slider_vision 的注释。
 */
import type { JsonLogger } from "../json-logger.js";
import { openCvSliderVision, type OpenCvSliderVisionResult } from "./opencv_preprocess.js";

/** Hu 矩距离达到该值时置信度归零（matchShapes I1 的经验上限） */
const MATCH_SCORE_CEILING = 0.6;
/** 歧义（次优得分过于接近）时的置信度折损 */
const AMBIGUOUS_CONFIDENCE_PENALTY = 0.35;

export interface SliderVisionInput {
  /** 背景大图（含缺口）字节 */
  bgImage: Buffer;
  /** 滑块拼图块原图字节，需带 Alpha 通道（PNG） */
  pieceImage: Buffer;
  /**
   * 拼图块左缘在当前底图中的位置（底图图像像素）。
   * 滑块拼图的拖拽距离 = 缺口左缘 − 拼图块左缘；未知时按 0（贴左缘）处理。
   */
  pieceAnchorX?: number;
  /** 拼图块的页面显示尺寸（CSS px）：用于把高清原图缩放到与背景同尺度 */
  pieceDisplayW?: number;
  pieceDisplayH?: number;
  /** 面积容差，默认 0.15（±15%） */
  areaTolerance?: number;
  signal?: AbortSignal;
}

export interface SliderVisionResult {
  ok: boolean;
  /** 缺口左缘（底图图像像素坐标） */
  gapLeft: number;
  /** 目标拖拽位移（底图图像像素）：缺口左缘 − 拼图块左缘 */
  dragDistance: number;
  gapWidth: number;
  /** 匹配置信度 0~1 */
  confidence: number;
  method: string;
  /** 候选间得分过于接近，建议结合其他通道交叉验证 */
  ambiguous: boolean;
  /** 失败/降级原因（ok=false 时给出） */
  reason?: string;
  detail: string;
  diagnostics: OpenCvSliderVisionResult | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 由 Hu 矩距离折算置信度。
 * matchShapes(I1) 返回 0 表示形状完全一致，越大越不像；采用线性衰减并对
 * 歧义结果打折，使其在与其他通道融合时不会被当成高置信证据。
 */
function confidenceFromScore(matchScore: number, ambiguous: boolean): number {
  const base = clamp(0.95 - (matchScore / MATCH_SCORE_CEILING) * 0.85, 0.1, 0.95);
  return ambiguous ? Math.max(0.1, base - AMBIGUOUS_CONFIDENCE_PENALTY) : base;
}

export class SliderVisionSolver {
  constructor(private readonly logger?: JsonLogger) {}

  /**
   * 唯一对外接口：喂两张图，得到目标 X 轴位移。
   * 任何异常（OpenCV 不可用 / 图片解码失败 / 无 Alpha / 未匹配到轮廓）都以
   * ok=false 返回，绝不抛出，交由调用方降级到其他识别通道。
   */
  async solve(input: SliderVisionInput): Promise<SliderVisionResult> {
    const empty = (
      reason: string,
      detail: string,
      diagnostics: OpenCvSliderVisionResult | null = null,
    ): SliderVisionResult => ({
      ok: false,
      gapLeft: 0,
      dragDistance: 0,
      gapWidth: 0,
      confidence: 0,
      method: "slider_vision",
      ambiguous: false,
      reason,
      detail,
      diagnostics,
    });

    if (input.signal?.aborted) throw new Error("Agent 已中止");
    if (!input.bgImage?.length) return empty("missing_bg_image", "缺少背景图");
    if (!input.pieceImage?.length) return empty("missing_piece_image", "缺少拼图块图");

    let res: OpenCvSliderVisionResult | null = null;
    try {
      res = await openCvSliderVision({
        bgBuf: input.bgImage,
        pieceBuf: input.pieceImage,
        ...(input.pieceDisplayW != null && input.pieceDisplayW > 0
          ? { pieceDisplayW: input.pieceDisplayW }
          : {}),
        ...(input.pieceDisplayH != null && input.pieceDisplayH > 0
          ? { pieceDisplayH: input.pieceDisplayH }
          : {}),
        ...(input.areaTolerance != null ? { areaTol: input.areaTolerance } : {}),
        ...(this.logger ? { logger: this.logger } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      if (input.signal?.aborted) throw new Error("Agent 已中止");
      this.logger?.warn("slider_vision_failed", {
        error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
      });
      return empty("solver_error", "视觉求解器调用异常");
    }

    // OpenCV/Python 不可用或无 Alpha 通道：属于「本页面不适用」，静默降级
    if (!res) return empty("vision_unavailable", "OpenCV 不可用或图片无 Alpha 通道");

    if (!res.found) {
      return empty(
        res.reason ?? "no_match",
        `未匹配到符合面积约束的缺口（背景轮廓 ${res.bgContours}，面积不符 ${res.areaRejected}）`,
        res,
      );
    }

    const anchor = Math.max(0, input.pieceAnchorX ?? 0);
    const dragDistance = res.gapX - anchor;
    // 缺口位于拼图块左侧 → 与「拖拽距离恒为正」相悖，属误匹配
    if (dragDistance <= 0) {
      return empty(
        "drag_not_positive",
        `缺口 ${res.gapX}px 未位于拼图块 ${anchor}px 右侧，判为误匹配`,
        res,
      );
    }

    const confidence = confidenceFromScore(res.matchScore, res.ambiguous);
    const detail =
      `缺口 ${res.gapX}px（宽 ${res.gapW}）· 拼图块 ${anchor}px · 位移 ${dragDistance}px · ` +
      `Hu 距 ${res.matchScore.toFixed(4)} · 候选 ${res.candidates}/剔除 ${res.areaRejected} · ` +
      `面积 ${res.matchedArea}/${res.targetArea} · conf=${confidence.toFixed(2)}`;

    return {
      ok: true,
      gapLeft: res.gapX,
      dragDistance,
      gapWidth: res.gapW,
      confidence,
      method: "slider_vision_alpha_humoments",
      ambiguous: res.ambiguous,
      detail,
      diagnostics: res,
    };
  }
}
