/**
 * 点选 / 顺序点击验证码（策略 point_select_click）
 * 裁剪验证区 → 多模态 JSON 坐标 → 拟人贝塞尔点击 → 验收
 */
export type { PointSelectResult, CaptchaCrop, PixelPoint } from "./point_select/types.js";
export {
  parseClickPointsJson,
  extractCoordinates,
  extractCoordinateJsonCandidates,
} from "./point_select/vision.js";
export {
  isDomInstructionUnreliable,
  visionInstructionContext,
  extractHanClickSequence,
} from "./point_select/dom_hint.js";
export { runPointSelectPipeline as solvePointSelectCaptcha } from "./point_select/pipeline.js";
