/**
 * GIF 元数据解析（独立工具，边界内自包含，不依赖图片库）。
 *
 * 存在的理由：动图验证码的题面常写「停留时间最长」（猿人学「迷雾动图之真相」即此类）。
 * GIF 的 Graphic Control Extension 里每帧都带显示时长，这层信息本身是**客观元数据**，
 * 比让视觉模型「猜哪个字更清楚」可靠得多——模型分不清「我真看见了」和「我在脑补」。
 *
 * 但**绝不能把「最长帧就是答案」当成真理**：每个验证码都不一样，
 * 有的全部 100ms（无区分度）、有的带 ±10ms 编码抖动（不是信号）、
 * 有的换一套完全不同的题型。所以这里只做一件事：
 * **把时长换算成每帧的相对权重交给裁决层，由裁决层按权重计票**。
 * 不判断谁「是答案」，不设任何绝对阈值。
 */

/** 单帧元数据。`delayMs` 为该帧的显示时长（GCE delay × 10）。 */
export interface GifFrameMeta {
  index: number;
  delayMs: number;
  disposal: number;
  transparent: boolean;
  /** 该帧在逻辑屏中的绘制矩形（含偏移与尺寸） */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** GIF 解析结果。解析失败时 `frames` 为空数组，调用方退回原有策略。 */
export interface GifMeta {
  width: number;
  height: number;
  frames: GifFrameMeta[];
}

function readSubBlocksEnd(buf: Buffer, start: number): number {
  let pos = start;
  while (pos < buf.length) {
    const size = buf[pos]!;
    if (size === 0) return pos + 1;
    pos += 1 + size;
  }
  return pos;
}

/**
 * 解析 GIF 逐帧 delay / disposal / 绘制矩形。
 *
 * 只走块结构（0x21 扩展 / 0x2C 图像描述符 / 0x3B 结束），不碰 LZW 像素数据，
 * 因此不受调色板与压缩差异影响。任何结构异常都返回空 `frames`，绝不抛错——
 * 调用方据此优雅退回原策略（与 opencv_preprocess 的降级约定一致）。
 */
export function parseGifMeta(buf: Buffer): GifMeta {
  const empty: GifMeta = { width: 0, height: 0, frames: [] };
  if (buf.length < 13) return empty;
  if (buf.subarray(0, 3).toString("ascii") !== "GIF") return empty;

  try {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    const packed = buf[10]!;
    const gctEntries = packed & 0x80 ? 2 ** ((packed & 0x07) + 1) : 0;

    let pos = 13 + gctEntries * 3;
    const frames: GifFrameMeta[] = [];
    // 上一帧的 GCE：按规范 GCE 必须紧邻其图像描述符，沿用「最近一个」符合实际编码
    let pending: { delayMs: number; disposal: number; transparent: boolean } | null = null;

    while (pos < buf.length) {
      const block = buf[pos]!;

      if (block === 0x3b) break; // Trailer

      if (block === 0x21) {
        const label = buf[pos + 1];
        const cursor = pos + 2;
        const headerSize = buf[cursor]!;
        const header = buf.subarray(cursor + 1, cursor + 1 + headerSize);
        if (label === 0xf9 && header.length >= 4) {
          const flags = header[0]!;
          pending = {
            delayMs: header.readUInt16LE(1) * 10,
            disposal: (flags >> 2) & 0x07,
            transparent: Boolean(flags & 0x01),
          };
        }
        pos = readSubBlocksEnd(buf, cursor + 1 + headerSize);
        continue;
      }

      if (block === 0x2c) {
        const left = buf.readUInt16LE(pos + 1);
        const top = buf.readUInt16LE(pos + 3);
        const fw = buf.readUInt16LE(pos + 5);
        const fh = buf.readUInt16LE(pos + 7);
        const ipacked = buf[pos + 9]!;
        const lctEntries = ipacked & 0x80 ? 2 ** ((ipacked & 0x07) + 1) : 0;
        // 图像描述符(10) + 局部色表 + LZW 最小码长(1) + 数据子块
        const dataStart = pos + 10 + lctEntries * 3 + 1;
        frames.push({
          index: frames.length,
          delayMs: pending?.delayMs ?? 0,
          disposal: pending?.disposal ?? 0,
          transparent: pending?.transparent ?? false,
          left,
          top,
          width: fw,
          height: fh,
        });
        pending = null;
        pos = readSubBlocksEnd(buf, dataStart);
        continue;
      }

      break; // 未知块：停止解析，保留已得结果
    }

    return { width, height, frames };
  } catch {
    return empty;
  }
}

/**
 * 逐帧「时间权重」= `delay_i / Σdelay × 帧数`。**无任何阈值。**
 *
 * 为什么这样归一化（三条性质都是刻意设计的，不是凑出来的）：
 *
 * 1. **等长 ⇒ 每帧权重恰好 = 1.0**。于是按权重计票与按票数计票完全等价，
 *    裁决行为与引入本函数之前**逐字节一致**。这是最重要的安全性质：
 *    没有时长信息时，本函数不得改变任何既有行为。
 *
 * 2. **抖动自抑**。编码器 ±5ms 的随机抖动只会带来 ~1% 的权重差，属 float 噪音级；
 *    而真实设计意图（`300 vs 100×5`）会带来 3 倍差，自然放大。
 *    不需要人去规定「多少毫秒算长」——阈值本身就是对验证码结构的写死。
 *
 * 3. **总时长为 0 时退化为等权**。有站点用 delay=0 表示「不等」，那帧权重为 0
 *    （闪烁帧确实不该是答案）；若所有帧都是 0，则回到性质 1，等权处理。
 */
export function temporalFrameWeights(meta: GifMeta): number[] {
  const count = meta.frames.length;
  if (count === 0) return [];
  const total = meta.frames.reduce((sum, frame) => sum + Math.max(0, frame.delayMs), 0);
  if (total <= 0) return new Array<number>(count).fill(1);
  return meta.frames.map((frame) => (Math.max(0, frame.delayMs) / total) * count);
}

/**
 * 时长是否提供了**可用的区分度**。仅用于日志与「抽样时是否优先保留高权帧」。
 * 判据是权重的相对离散度（float 安全阈值），不是任何绝对毫秒数。
 */
export function hasTemporalSignal(meta: GifMeta): boolean {
  const weights = temporalFrameWeights(meta);
  if (weights.length === 0) return false;
  const first = weights[0]!;
  return weights.some((weight) => Math.abs(weight - first) > 1e-9);
}
