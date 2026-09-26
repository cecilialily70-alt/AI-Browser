/**
 * OpenCV 图像预处理侧车（独立工具，边界内自包含）。
 *
 * 目的：对「背景/噪点干扰严重」的验证码，在送 VLM 前先用 OpenCV 去噪、增强对比度；
 * 对滑块缺口用 Canny 边缘 + 轮廓几何做结构化定位（背景杂乱时比纯像素列更稳）。
 *
 * 实现：内嵌 Python 源码，首次调用写入临时文件；spawn 子进程走 JSON stdin/stdout。
 * 无 Python 或未装 OpenCV 时，所有公开函数优雅返回 null，绝不抛错、不改动既有逻辑。
 * 按 .cursorrules「严格隔离边界」：本模块只依赖自身，不污染全局命名空间。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonLogger } from "../json-logger.js";

/**
 * Python 源码（内嵌，避免打包时额外搬运脚本文件）。
 * 注意：不得包含反引号与 "${" 序列（Template Literal 安全）。
 */
const PY_SOURCE = String.raw`
import sys, json, base64

def _fail(msg):
    return {"ok": False, "error": str(msg)}

def main():
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:
        sys.stdout.write(json.dumps(_fail("bad_request"), ensure_ascii=False))
        return
    try:
        import cv2
        import numpy as np
    except Exception:
        sys.stdout.write(json.dumps(_fail("opencv_unavailable"), ensure_ascii=False))
        return
    b64 = req.get("image_b64")
    if not b64:
        sys.stdout.write(json.dumps(_fail("missing_image_b64"), ensure_ascii=False))
        return
    try:
        data = np.frombuffer(base64.b64decode(b64), np.uint8)
        img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    except Exception:
        img = None
    if img is None or img.size == 0:
        sys.stdout.write(json.dumps(_fail("undecodable_image"), ensure_ascii=False))
        return
    op = req.get("op")
    params = req.get("params") or {}
    try:
        if op == "denoise":
            result = _denoise(img, params)
        elif op == "slider_gap":
            result = _slider_gap(img, params)
        elif op == "slider_vision":
            result = _slider_vision(img, params)
        else:
            result = _fail("unknown_op")
    except Exception as e:
        result = _fail("op_error:" + str(e))
    sys.stdout.write(json.dumps(result, ensure_ascii=False))

def _encode(img, quality=92):
    import cv2
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")

def _clahe(gray, clip):
    import cv2
    return cv2.createCLAHE(clipLimit=float(clip), tileGridSize=(8, 8)).apply(gray)

def _denoise(img, params):
    import cv2
    k = int(params.get("median_ksize", 3))
    if k % 2 == 0:
        k += 1
    clip = float(params.get("clahe_clip", 2.0))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    den_gray = cv2.medianBlur(gray, max(1, k))
    if params.get("color"):
        # 保色增强：LAB 亮度通道 CLAHE，保留色度。图标/点选类验证码依赖颜色语义，
        # 不能用灰度（会丢颜色）；此处只压噪+提亮度对比。
        den = cv2.medianBlur(img, max(1, k))
        lab = cv2.cvtColor(den, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        l = _clahe(l, clip)
        enhanced = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)
    else:
        enhanced = _clahe(den_gray, clip)
    out = {
        "ok": True,
        "width": int(enhanced.shape[1]),
        "height": int(enhanced.shape[0]),
        "enhanced_b64": _encode(enhanced),
    }
    if params.get("binary"):
        blk = int(params.get("ath_block", 11))
        if blk % 2 == 0:
            blk += 1
        c = int(params.get("ath_c", 2))
        binarized = cv2.adaptiveThreshold(
            den_gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, blk, c
        )
        out["binary_b64"] = _encode(binarized)
    return out

def _slider_vision(bg_img, params):
    """高级滑块视觉识别：Alpha 轮廓提取 + 面积约束 + Hu 矩形状匹配。

    输入：bg_img = 背景大图（含缺口）；params.piece_b64 = 滑块拼图块原图（带 Alpha）。
    输出：缺口左缘 / 宽度 / 匹配得分 / 候选统计。

    —— 双重过滤的防诱饵原理（核心）——
    ① 面积约束（±15%）：风控常在同一张底图上放置「一大一小」两个相似缺口作为诱饵，
       让识别器挑错。以滑块原图 Alpha 通道算出的**真实物理面积**为基准，只保留
       容差内的轮廓；面积不符的诱饵在进入形状匹配之前就被剔除，从源头杜绝误选。
    ② Hu 矩形状匹配（cv2.matchShapes）：Hu 矩是对平移、缩放、旋转均不变的矩特征，
       因此可以无视缺口在底图中的位置与渲染尺寸差异，只比较「形状本身」。
       在通过面积过滤的候选中取距离最小者，即为唯一正确坐标。
       面积过滤负责「排掉尺寸不符的诱饵」，Hu 矩负责「在尺寸相符者中认出形状」，
       两者互补：仅有面积会被同尺寸异形干扰，仅有形状会被缩放后的同形诱饵欺骗。
    """
    import cv2
    import numpy as np

    piece_b64 = params.get("piece_b64")
    if not piece_b64:
        return _fail("missing_piece_b64")
    # 必须用 IMREAD_UNCHANGED 保留 Alpha 通道，否则无法提取精确轮廓与真实物理面积
    try:
        piece = cv2.imdecode(
            np.frombuffer(base64.b64decode(piece_b64), np.uint8), cv2.IMREAD_UNCHANGED
        )
    except Exception:
        piece = None
    if piece is None or piece.size == 0:
        return _fail("undecodable_piece")
    # 无 Alpha 的图片无法做「真实轮廓 + 物理面积」，交由调用方降级到其他通道
    if piece.ndim < 3 or piece.shape[2] < 4:
        return _fail("piece_has_no_alpha")

    alpha = piece[:, :, 3]
    if int(alpha.max()) <= 0:
        return _fail("piece_alpha_empty")
    # 尺度归一化（面积可比性的前提）：拼图块原图常是 2x/3x 高清资源，而背景图是按
    # 显示尺寸送进来的。若直接比较两者轮廓面积，面积约束必然失效。故先把拼图块的
    # Alpha 蒙版缩放到它在页面上的**实际显示尺寸**，使其与背景图处于同一坐标系。
    disp_w = int(params.get("piece_display_w", 0) or 0)
    disp_h = int(params.get("piece_display_h", 0) or 0)
    if disp_w > 0 and disp_h > 0 and (disp_w != alpha.shape[1] or disp_h != alpha.shape[0]):
        alpha = cv2.resize(alpha, (disp_w, disp_h), interpolation=cv2.INTER_AREA)
    # 阈值取 Alpha 峰值的一定比例：既排除全透明背景，又尽量避免把羽化边缘算进轮廓
    thr = max(128, int(int(alpha.max()) * 0.6))
    mask = (alpha >= thr).astype(np.uint8) * 255
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    )
    piece_cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not piece_cnts:
        return _fail("piece_contour_not_found")
    piece_cnt = max(piece_cnts, key=cv2.contourArea)
    target_area = float(cv2.contourArea(piece_cnt))
    if target_area < 16.0:
        return _fail("piece_area_too_small")
    _px, _py, piece_w, piece_h = cv2.boundingRect(piece_cnt)

    gray = cv2.cvtColor(bg_img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    # 多档 Canny 取并集：单档阈值在低对比/渐变底图上容易漏掉缺口边线
    edges = None
    for t1, t2 in ((60, 160), (100, 200), (40, 120)):
        e = cv2.Canny(blur, t1, t2)
        edges = e if edges is None else cv2.bitwise_or(edges, e)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)
    bg_cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

    area_tol = float(params.get("area_tol", 0.15))
    low = target_area * (1.0 - area_tol)
    high = target_area * (1.0 + area_tol)

    cands = []
    area_rejected = 0
    for c in bg_cnts:
        a = float(cv2.contourArea(c))
        if a <= 0:
            continue
        # ① 面积约束：±15% 容差，直接排除「一大一小」诱饵缺口
        if a < low or a > high:
            area_rejected += 1
            continue
        # ② Hu 矩形状相似度：越小越相似，对平移/缩放/旋转不变
        score = float(cv2.matchShapes(piece_cnt, c, cv2.CONTOURS_MATCH_I1, 0.0))
        x, y, cw, ch = cv2.boundingRect(c)
        cands.append((score, x, y, cw, ch, a))

    if not cands:
        return {
            "ok": True,
            "found": False,
            "reason": "no_area_match",
            "target_area": round(target_area, 1),
            "area_rejected": area_rejected,
            "bg_contours": len(bg_cnts),
            "piece_w": int(piece_w),
            "piece_h": int(piece_h),
            "width": int(bg_img.shape[1]),
            "height": int(bg_img.shape[0]),
        }

    cands.sort(key=lambda t: t[0])
    score, x, y, cw, ch, a = cands[0]
    # 次优得分与前一名过于接近 → 判定为歧义，交由调用方结合其他通道裁决
    ambiguous = False
    if len(cands) >= 2:
        gap_score = cands[1][0] - cands[0][0]
        ambiguous = gap_score < max(0.02, cands[0][0] * 0.25)

    return {
        "ok": True,
        "found": True,
        "gap_x": int(x),
        "gap_y": int(y),
        "gap_w": int(cw),
        "gap_h": int(ch),
        "match_score": round(score, 5),
        "piece_w": int(piece_w),
        "piece_h": int(piece_h),
        "target_area": round(target_area, 1),
        "matched_area": round(a, 1),
        "candidates": len(cands),
        "area_rejected": area_rejected,
        "bg_contours": len(bg_cnts),
        "ambiguous": bool(ambiguous),
        "width": int(bg_img.shape[1]),
        "height": int(bg_img.shape[0]),
    }


def _slider_gap(img, params):
    import cv2
    h, w = img.shape[:2]
    clip = float(params.get("clahe_clip", 2.0))
    gray = _clahe(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), clip)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    w_min = w * float(params.get("gap_w_min", 0.06))
    w_max = w * float(params.get("gap_w_max", 0.34))
    h_min = h * float(params.get("gap_h_min", 0.30))
    h_max = h * float(params.get("gap_h_max", 0.90))
    x_min = w * float(params.get("gap_x_min", 0.02))
    x_max = w * float(params.get("gap_x_max", 0.98))

    # 收集所有候选块（拼图块与缺口各成一块），而非只取「最佳」一个。
    # 拼图块(左)与缺口(右)都有明显轮廓（阴影/线框/拼图切线），左块=piece、右块=gap。
    cands = []
    seen = set()
    for t1, t2 in ((100, 200), (70, 150), (50, 120), (80, 180)):
        edges = cv2.Canny(blur, t1, t2)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            x, y, cw, ch = cv2.boundingRect(cnt)
            if cw < w_min or cw > w_max or ch < h_min or ch > h_max:
                continue
            if x < x_min or x > x_max:
                continue
            ratio = cw / max(1.0, float(ch))
            if ratio < 0.18 or ratio > 1.5:
                continue
            area = float(cv2.contourArea(cnt))
            fill = area / max(1.0, float(cw * ch))
            key = (x // 8, cw // 8)
            if key in seen:
                continue
            seen.add(key)
            ly = max(0, y)
            ry = min(h, y + ch)
            left = gray[ly:ry, max(0, x - 12):x]
            right = gray[ly:ry, x + cw:min(w, x + cw + 12)]
            interior = gray[ly:ry, x:x + cw]
            if left.size and right.size:
                bg_mean = (float(left.mean()) + float(right.mean())) / 2.0
            else:
                bg_mean = float(interior.mean())
            contrast = abs(bg_mean - float(interior.mean()))
            cands.append((x, y, cw, ch, area, fill, contrast))

    # 按 x 合并重叠候选，避免同一块因多次阈值被重复计入
    cands.sort(key=lambda c: c[0])
    merged = []
    for c in cands:
        if merged and c[0] < merged[-1][0] + merged[-1][2] * 0.6:
            # 与上一块重叠：保留 fill/contrast 更优者
            if (c[5] + c[6] * 0.01) > (merged[-1][5] + merged[-1][6] * 0.01):
                merged[-1] = c
            continue
        merged.append(c)

    enhanced = _clahe(cv2.medianBlur(gray, 3), clip)
    out = {
        "ok": True,
        "width": w,
        "height": h,
        "enhanced_b64": _encode(enhanced),
    }

    def _to_gap(c):
        x, y, cw, ch, area, fill, contrast = c
        conf = 0.25 + fill * 0.45 + max(0.0, min(1.0, contrast / 40.0)) * 0.2
        if fill < 0.15:
            conf *= 0.5
        conf = max(0.0, min(0.95, conf))
        return {"x": int(x), "w": int(cw), "center": int(round(x + cw / 2.0))}, conf

    if len(merged) == 0:
        out["gap"] = None
        out["piece"] = None
        out["confidence"] = 0.0
        out["method"] = "contour_none"
        return out

    if len(merged) >= 2:
        piece_c = merged[0]
        gap_c = merged[-1]
        gap, conf = _to_gap(gap_c)
        piece, _ = _to_gap(piece_c)
        out["gap"] = gap
        out["piece"] = {"x": piece["x"], "w": piece["w"], "center": piece["center"]}
        out["confidence"] = round(conf + 0.1, 3)
        out["method"] = "contour_pair"
        out["detail"] = "gap_x=%d piece_x=%d" % (gap["x"], piece["x"])
    else:
        gap, conf = _to_gap(merged[0])
        out["gap"] = gap
        out["piece"] = None
        out["confidence"] = round(conf, 3)
        out["method"] = "contour_single"
        out["detail"] = "x=%d w=%d fill=%.2f contrast=%.1f" % (
            gap["x"], gap["w"], merged[0][5], merged[0][6],
        )
    return out

if __name__ == "__main__":
    main()
`;

interface PythonRuntime {
  cmd: string;
  args: string[];
}

const PYTHON_CANDIDATES: PythonRuntime[] = [
  { cmd: "python", args: [] },
  { cmd: "py", args: ["-3"] },
  { cmd: "python3", args: [] },
];

const RUNTIME_MISSING = "python_or_opencv_missing";

interface RuntimeState {
  available: boolean;
  cmd: string;
  args: string[];
  reason: string;
}

let runtime: RuntimeState | null = null;
let scriptPath: string | null = null;
let warnedRuntimeMissing = false;

function spawnProcess(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs: number; maxOutputBytes: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let oversized = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("opencv_proc_timeout"));
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length + d.length > opts.maxOutputBytes) {
        oversized = true;
        child.kill();
        return;
      }
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.stdin.on("error", () => {
      /* 子进程提前退出时的 EPIPE，忽略；由 close/error 统一收口 */
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (oversized) {
        reject(new Error("opencv_output_too_large"));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`opencv_proc_exit_${code}`));
    });
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

function ensureScriptFile(): string {
  if (scriptPath && existsSync(scriptPath)) return scriptPath;
  const dir = mkdtempSync(join(tmpdir(), "cf-opencv-"));
  scriptPath = join(dir, "opencv_preprocess.py");
  writeFileSync(scriptPath, PY_SOURCE, "utf8");
  return scriptPath;
}

async function probePython(rt: PythonRuntime): Promise<boolean> {
  try {
    await spawnProcess(rt.cmd, [...rt.args, "-c", "import cv2, numpy"], {
      timeoutMs: 8_000,
      maxOutputBytes: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureRuntime(): Promise<RuntimeState> {
  if (runtime) return runtime;
  for (const rt of PYTHON_CANDIDATES) {
    if (await probePython(rt)) {
      runtime = { available: true, cmd: rt.cmd, args: rt.args, reason: "" };
      return runtime;
    }
  }
  runtime = { available: false, cmd: "", args: [], reason: RUNTIME_MISSING };
  return runtime;
}

async function tryRunOpenCv(
  req: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  const rt = await ensureRuntime();
  if (!rt.available) return { ok: false, reason: rt.reason };
  const py = ensureScriptFile();
  try {
    const { stdout } = await spawnProcess(rt.cmd, [...rt.args, py], {
      input: JSON.stringify(req),
      timeoutMs,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return { ok: true, data: parsed };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "opencv_proc_error";
    return { ok: false, reason };
  }
}

function b64ToBuffer(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function noteFailure(logger: JsonLogger | undefined, reason: string): void {
  if (reason === RUNTIME_MISSING) {
    if (warnedRuntimeMissing) return;
    warnedRuntimeMissing = true;
    logger?.warn("opencv_unavailable", {
      reason: "未检测到 Python+OpenCV（cv2/numpy），验证码预处理降级为原图识别",
    });
    return;
  }
  logger?.debug("opencv_op_failed", { reason: reason.slice(0, 160) });
}

export interface OpenCvDenoiseResult {
  jpeg: Buffer;
  binary?: Buffer;
  width: number;
  height: number;
}

export interface OpenCvSliderGapResult {
  gapX: number;
  gapW: number;
  gapCenter: number;
  pieceX?: number;
  pieceW?: number;
  pieceCenter?: number;
  imageWidth: number;
  imageHeight: number;
  confidence: number;
  method: string;
  detail?: string;
  enhanced?: Buffer;
}

/** 高级视觉识别结果：Alpha 轮廓 + 面积约束 + Hu 矩形状匹配（抗诱饵缺口）。 */
export interface OpenCvSliderVisionResult {
  /** 是否在背景中匹配到符合面积与形状的缺口 */
  found: boolean;
  /** 缺口左缘（背景图像素坐标） */
  gapX: number;
  gapY: number;
  gapW: number;
  gapH: number;
  /** Hu 矩形状距离：越小越相似（0 为完全一致） */
  matchScore: number;
  pieceW: number;
  pieceH: number;
  /** 滑块原图 Alpha 轮廓的真实物理面积（面积约束基准） */
  targetArea: number;
  /** 命中轮廓的面积（应落在 targetArea 的 ±15% 内） */
  matchedArea: number;
  /** 通过面积过滤的候选数 */
  candidates: number;
  /** 被面积约束剔除的轮廓数（其中含诱饵缺口） */
  areaRejected: number;
  /** 背景中检出的全部轮廓数 */
  bgContours: number;
  /** 候选间得分过于接近，结论存在歧义 */
  ambiguous: boolean;
  imageWidth: number;
  imageHeight: number;
  /** found=false 时的原因标识 */
  reason?: string;
}

/** 高级滑块视觉识别：Alpha 轮廓 + 面积约束 + Hu 矩形状匹配。 */
export async function openCvSliderVision(input: {
  /** 背景大图（含缺口） */
  bgBuf: Buffer;
  /** 滑块拼图块原图，必须带 Alpha 通道（PNG） */
  pieceBuf: Buffer;
  /** 拼图块的页面显示尺寸（CSS px），用于把高清原图缩放到与背景同尺度 */
  pieceDisplayW?: number;
  pieceDisplayH?: number;
  /** 面积容差，默认 0.15（±15%） */
  areaTol?: number;
  logger?: JsonLogger;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OpenCvSliderVisionResult | null> {
  if (input.signal?.aborted) return null;
  const outcome = await tryRunOpenCv(
    {
      op: "slider_vision",
      image_b64: input.bgBuf.toString("base64"),
      params: {
        piece_b64: input.pieceBuf.toString("base64"),
        ...(input.pieceDisplayW != null && input.pieceDisplayW > 0
          ? { piece_display_w: Math.round(input.pieceDisplayW) }
          : {}),
        ...(input.pieceDisplayH != null && input.pieceDisplayH > 0
          ? { piece_display_h: Math.round(input.pieceDisplayH) }
          : {}),
        ...(input.areaTol != null ? { area_tol: input.areaTol } : {}),
      },
    },
    input.timeoutMs ?? 20_000,
  );
  if (!outcome.ok) {
    noteFailure(input.logger, outcome.reason);
    return null;
  }
  const res = outcome.data;
  // 无 Alpha / 无轮廓等属于「本页面不适用该通道」，不是故障：静默返回 null 由调用方降级
  if (res.ok !== true) {
    input.logger?.debug("opencv_slider_vision_rejected", {
      reason: String(res.error ?? "unknown").slice(0, 120),
    });
    return null;
  }
  const found = res.found === true;
  return {
    found,
    gapX: Math.max(0, Math.floor(Number(res.gap_x) || 0)),
    gapY: Math.max(0, Math.floor(Number(res.gap_y) || 0)),
    gapW: Math.max(0, Math.floor(Number(res.gap_w) || 0)),
    gapH: Math.max(0, Math.floor(Number(res.gap_h) || 0)),
    matchScore: Number(res.match_score) || 0,
    pieceW: Math.max(0, Math.floor(Number(res.piece_w) || 0)),
    pieceH: Math.max(0, Math.floor(Number(res.piece_h) || 0)),
    targetArea: Number(res.target_area) || 0,
    matchedArea: Number(res.matched_area) || 0,
    candidates: Math.max(0, Math.floor(Number(res.candidates) || 0)),
    areaRejected: Math.max(0, Math.floor(Number(res.area_rejected) || 0)),
    bgContours: Math.max(0, Math.floor(Number(res.bg_contours) || 0)),
    ambiguous: res.ambiguous === true,
    imageWidth: Math.max(0, Math.floor(Number(res.width) || 0)),
    imageHeight: Math.max(0, Math.floor(Number(res.height) || 0)),
    ...(typeof res.reason === "string" ? { reason: res.reason } : {}),
  };
}

/** 去噪 + 对比度增强（送 VLM 前的通用预处理）。 */
export async function openCvDenoise(input: {
  buf: Buffer;
  mode?: "text" | "slider" | "auto";
  binary?: boolean;
  /** 保色增强：图标/点选类验证码依赖颜色语义，用此模式只压噪+提亮度对比，不转灰度。 */
  color?: boolean;
  logger?: JsonLogger;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OpenCvDenoiseResult | null> {
  if (input.signal?.aborted) return null;
  const outcome = await tryRunOpenCv(
    {
      op: "denoise",
      image_b64: input.buf.toString("base64"),
      params: {
        mode: input.mode ?? "auto",
        binary: input.binary === true,
        color: input.color === true,
      },
    },
    input.timeoutMs ?? 20_000,
  );
  if (!outcome.ok) {
    noteFailure(input.logger, outcome.reason);
    return null;
  }
  const res = outcome.data;
  if (res.ok !== true) {
    input.logger?.debug("opencv_denoise_rejected", { reason: String(res.error ?? "unknown").slice(0, 120) });
    return null;
  }
  const jpeg = b64ToBuffer(res.enhanced_b64);
  if (!jpeg) return null;
  const binary = b64ToBuffer(res.binary_b64);
  return {
    jpeg,
    ...(binary ? { binary } : {}),
    width: Number(res.width) || 0,
    height: Number(res.height) || 0,
  };
}

/** 滑块缺口结构化定位（Canny + 轮廓几何）。返回 enhanced 供视觉交叉校验。 */
export async function openCvSliderGap(input: {
  buf: Buffer;
  logger?: JsonLogger;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OpenCvSliderGapResult | null> {
  if (input.signal?.aborted) return null;
  const outcome = await tryRunOpenCv(
    { op: "slider_gap", image_b64: input.buf.toString("base64"), params: {} },
    input.timeoutMs ?? 20_000,
  );
  if (!outcome.ok) {
    noteFailure(input.logger, outcome.reason);
    return null;
  }
  const res = outcome.data;
  if (res.ok !== true) {
    input.logger?.debug("opencv_slider_gap_rejected", { reason: String(res.error ?? "unknown").slice(0, 120) });
    return null;
  }
  const gap = res.gap as { x?: unknown; w?: unknown; center?: unknown } | null | undefined;
  const piece = res.piece as { x?: unknown; w?: unknown; center?: unknown } | null | undefined;
  const enhanced = b64ToBuffer(res.enhanced_b64);
  const imageWidth = Number(res.width) || 0;
  const imageHeight = Number(res.height) || 0;
  const pieceX = piece && Number(piece.x) > 0 ? Math.floor(Number(piece.x)) : undefined;
  const pieceW = piece ? Math.floor(Number(piece.w) || 0) : undefined;
  const pieceCenter = piece ? Math.floor(Number(piece.center) || 0) : undefined;
  return {
    gapX: gap && Number(gap.x) > 0 ? Math.floor(Number(gap.x)) : 0,
    gapW: gap ? Math.floor(Number(gap.w) || 0) : 0,
    gapCenter: gap ? Math.floor(Number(gap.center) || 0) : 0,
    ...(pieceX != null ? { pieceX } : {}),
    ...(pieceW != null && pieceW > 0 ? { pieceW } : {}),
    ...(pieceCenter != null && pieceCenter > 0 ? { pieceCenter } : {}),
    imageWidth,
    imageHeight,
    confidence: Number(res.confidence) || 0,
    method: String(res.method ?? "contour"),
    ...(typeof res.detail === "string" ? { detail: res.detail } : {}),
    ...(enhanced ? { enhanced } : {}),
  };
}
