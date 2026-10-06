/** 轻量 JPEG SOF 宽高解析 */
export function readJpegSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const h = (buf[i + 5]! << 8) | buf[i + 6]!;
      const w = (buf[i + 7]! << 8) | buf[i + 8]!;
      if (w > 0 && h > 0) return { w, h };
    }
    i += 2 + len;
  }
  return null;
}
