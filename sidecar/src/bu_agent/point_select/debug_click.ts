/**
 * 可视化调试打点：鲜红实心圆落盘 logs/debug_*.png
 * 在 about:blank 副页绘制，避免验证码页 context 销毁导致丢图。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import type { JsonLogger } from "../../json-logger.js";
import type { PixelPoint } from "./types.js";
import type { MediaRect, UnitPoint } from "./coord_map.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const POINT_SELECT_LOGS_DIR = resolve(HERE, "../../../logs");

export function unitsToImagePixels(
  units: UnitPoint[],
  imageW: number,
  imageH: number,
): PixelPoint[] {
  const w = Math.max(1, imageW);
  const h = Math.max(1, imageH);
  return units.map((u) => ({
    x: Math.min(w - 1, Math.max(0, u.modelX ?? u.u * w)),
    y: Math.min(h - 1, Math.max(0, u.modelY ?? u.v * h)),
  }));
}
export async function writeDebugClickArtifact(input: {
  page: Page;
  logger?: JsonLogger;
  imageB64: string;
  imagePoints: PixelPoint[];
  viewportPoints?: PixelPoint[];
  canvasRect?: MediaRect | null;
  stamp?: string;
}): Promise<string | null> {
  const stamp = input.stamp ?? String(Date.now());
  try {
    mkdirSync(POINT_SELECT_LOGS_DIR, { recursive: true });
  } catch {
    /* ignore */
  }

  const outPath = join(POINT_SELECT_LOGS_DIR, `debug_${stamp}.png`);
  const metaPath = join(POINT_SELECT_LOGS_DIR, `debug_${stamp}.json`);

  // 先写 JSON，保证至少有核对数据
  try {
    writeFileSync(
      metaPath,
      JSON.stringify(
        {
          stamp,
          canvasRect: input.canvasRect ?? null,
          imagePoints: input.imagePoints,
          viewportPoints: input.viewportPoints ?? [],
          path: outPath,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* ignore */
  }

  const rect = input.canvasRect;
  for (let i = 0; i < input.imagePoints.length; i++) {
    const mp = input.imagePoints[i]!;
    const vp = input.viewportPoints?.[i];
    const line =
      `[核对] 图左上角在屏幕 (${rect?.left != null ? Math.round(rect.left) : "?"}, ${rect?.top != null ? Math.round(rect.top) : "?"})；` +
      `AI 说点图内 (${Math.round(mp.x)}, ${Math.round(mp.y)})；` +
      `鼠标实际要点 (${vp?.x != null ? Math.round(vp.x) : "?"}, ${vp?.y != null ? Math.round(vp.y) : "?"})`;
    input.logger?.agentProgress(line, {
      phase: "point_select_captcha",
      stage: "debug_coord",
      i: i + 1,
      modelX: mp.x,
      modelY: mp.y,
      finalX: vp?.x,
      finalY: vp?.y,
    });
  }

  // 同页离屏画图，不碰验证码 DOM、不 newPage
  try {
    const pngB64 = await input.page.evaluate(
      async ({
        b64,
        pts,
      }: {
        b64: string;
        pts: Array<{ x: number; y: number }>;
      }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);
        const w = bitmap.width;
        const h = bitmap.height;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) {
          bitmap.close();
          throw new Error("no ctx");
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();

        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]!;
          const x = Math.round(p.x);
          const y = Math.round(p.y);
          ctx.beginPath();
          ctx.fillStyle = "rgba(255,0,0,0.95)";
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.strokeStyle = "rgba(255,255,0,0.95)";
          ctx.lineWidth = 2;
          ctx.arc(x, y, 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = "#fff";
          ctx.font = "bold 14px monospace";
          ctx.fillText(String(i + 1), x + 12, y - 8);
          ctx.fillStyle = "#ff0";
          ctx.font = "12px monospace";
          ctx.fillText(`(${x},${y})`, x + 12, y + 8);
        }
        return canvas.toDataURL("image/png").split(",")[1]!;
      },
      { b64: input.imageB64, pts: input.imagePoints },
    );
    writeFileSync(outPath, Buffer.from(pngB64, "base64"));
    return outPath;
  } catch (err) {
    input.logger?.warn("point_select_debug_png_fail", {
      reason: err instanceof Error ? err.message : String(err),
      metaPath,
    });
    return metaPath;
  }
}
