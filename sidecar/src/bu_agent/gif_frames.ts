/**
 * Windows GDI+ GIF 全帧拆解与「帧图 → 视觉可用 JPEG」转码（对齐 bat：System.Drawing SelectActiveFrame）
 * 仅 Win32；CREATE_NO_WINDOW / windowsHide 隐藏黑框。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isGifBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x39 || buf[4] === 0x37) &&
    buf[5] === 0x61
  );
}

/**
 * 是否为真实 JPEG 字节（SOI + 段起始 0xFF）。
 * 存在的原因：落盘扩展名不可信——下载到的原图可能是 PNG/WebP，而视觉请求声明的
 * mime 是硬编码的 image/jpeg，故只能按**字节**判定是否需要转码。
 */
export function isJpegBuffer(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** 传给 PowerShell 的帧清单文件名（临时文件，函数自行清理）。 */
const FRAME_LIST_FILE = "_frame_list.txt";
const JPEG_QUALITY = 92;

/**
 * 「白底压平 + 存为 JPEG」的脚本片段。
 * GDI+ 存 JPEG 必须显式给出 codec 与质量，否则会退回默认编码器；抽帧与转码两条路径
 * 都要用，抽成一处以免两份脚本各自漂移（DRY）。
 */
function jpegEncodePsLines(bmpVar: string, destVar: string): string[] {
  return [
    "$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    "$ep=New-Object System.Drawing.Imaging.EncoderParameters(1)",
    `$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${JPEG_QUALITY})`,
    `${bmpVar}.Save(${destVar}, $codec, $ep)`,
  ];
}

/** 抽帧产物：JPEG 路径 + 它在 GIF 中的源帧下标（0-based）。 */
export interface GifFrameImage {
  path: string;
  sourceIndex: number;
}

/**
 * 按需拆解 GIF 帧并**直接输出 JPEG**，全程只用一次 PowerShell 进程。
 *
 * 为什么把抽帧与转码合并：Windows 上每次 PowerShell 启动固定约 870 ms，而单帧解码+编码
 * 只需约 13 ms —— 拆成两次调用等于把最贵的那部分付两遍。
 *
 * 为什么必须压白底：GIF 帧带透明，透明区直接存 JPEG 会变黑，读码必废。
 * 为什么不做放大：放大是像素复制、不增加信息，且上游按 detail:"high" 会自行缩放到同一
 * 尺寸，放大前后进入模型的分辨率完全相同（见 prepareVisionJpegs）。
 *
 * 产物以**源帧下标**命名（`frame_<src>.jpg`）：即使请求的下标越界被跳过，调用方也能
 * 精确还原「哪个文件来自哪一源帧」，而不是靠两个数组下标对齐。
 *
 * @param frameIndexes 只导出这些 0-based 源帧下标；省略或为空则导出全部帧
 * @returns 按源帧下标升序排列的帧图列表
 */
export async function extractGifFramesAsJpeg(
  gifAbsPath: string,
  outDirAbs: string,
  frameIndexes?: number[],
  opts?: { timeoutMs?: number },
): Promise<GifFrameImage[]> {
  if (process.platform !== "win32") {
    throw new Error("GIF 拆帧仅支持 Windows（System.Drawing）");
  }
  if (!existsSync(gifAbsPath)) {
    throw new Error(`GIF 文件不存在: ${gifAbsPath}`);
  }
  mkdirSync(outDirAbs, { recursive: true });

  const timeoutMs = Math.min(60_000, Math.max(5_000, opts?.timeoutMs ?? 30_000));
  // 单引号包裹路径、内部单引号加倍；下标整数化后再拼，避免拼出非法脚本
  const gifPs = gifAbsPath.replace(/'/g, "''");
  const outPs = outDirAbs.replace(/'/g, "''");
  const keepPs = frameIndexes?.length
    ? `@(${frameIndexes.map((i) => Math.max(0, Math.floor(i))).join(",")})`
    : "@()";
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$gif='${gifPs}'`,
    `$out='${outPs}'`,
    `$keep=${keepPs}`,
    "if(!(Test-Path -LiteralPath $out)){ New-Item -ItemType Directory -Path $out | Out-Null }",
    "Get-ChildItem -LiteralPath $out -Filter 'frame_*.jpg' -ErrorAction SilentlyContinue | Remove-Item -Force",
    "$img=[System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $gif).Path)",
    "try {",
    "  $dim=New-Object System.Drawing.Imaging.FrameDimension($img.FrameDimensionsList[0])",
    "  $cnt=$img.GetFrameCount($dim)",
    // PowerShell 的 0..-1 会得到 @(0,-1)，故先挡掉空 GIF
    "  if($keep.Count -eq 0 -and $cnt -gt 0){ $keep=@(0..($cnt-1)) }",
    "  foreach($t in $keep){",
    "    if($t -lt 0 -or $t -ge $cnt){ continue }",
    "    $img.SelectActiveFrame($dim, $t) | Out-Null",
    "    $bmp=New-Object System.Drawing.Bitmap $img.Width, $img.Height",
    "    $g=[System.Drawing.Graphics]::FromImage($bmp)",
    "    $g.Clear([System.Drawing.Color]::White)",
    "    $g.DrawImageUnscaled($img, 0, 0)",
    "    $g.Dispose()",
    "    $dest=Join-Path $out ('frame_'+$t.ToString('0000')+'.jpg')",
    ...jpegEncodePsLines("$bmp", "$dest").map((line) => `    ${line}`),
    "    $bmp.Dispose()",
    "  }",
    "  Write-Output $cnt",
    "} finally { $img.Dispose() }",
  ].join("; ");

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GIF 拆帧失败: ${msg.slice(0, 400)}`);
  }

  // 文件名里自带源帧下标，故按解析出的下标数值排序，而不是靠字符串排序
  // （字符串排序在帧数跨到 5 位时会错序；虽然下游只认 sourceIndex，但顺序仍应确定）
  const images = readdirSync(outDirAbs)
    .filter((n) => /^frame_\d+\.jpg$/i.test(n))
    .map((n) => ({
      path: join(outDirAbs, n),
      sourceIndex: Number(n.slice("frame_".length, -".jpg".length)),
    }))
    .filter((image) => Number.isInteger(image.sourceIndex) && image.sourceIndex >= 0)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);
  if (images.length === 0) {
    throw new Error("GIF 拆帧完成但未生成 frame_*.jpg");
  }
  return images;
}

/**
 * 将帧图统一成「真实 JPEG」，**分辨率保持不变**。
 *
 * 为什么必须转码：读码请求的 data URL 硬编码 `image/jpeg`（见 readOneCaptchaFrame），
 * 若字节本身是 PNG，上游解码失败会回**空内容**而不是报错——这才是历史上「小图读不出」
 * 的真正成因，与尺寸无关。顺带把 GIF 帧的透明区压到白底，否则透明区转 JPEG 会变黑，
 * 读码必废。
 *
 * 为什么不再固定放大：NearestNeighbor 只是把每个像素复制成方块，**不增加任何信息**；
 * 且上游按 detail:"high" 自行缩放到同一尺寸，放大前后进入模型的分辨率完全相同，
 * 代价却是全帧 base64 体积约 ×10。真正的兜底改为「读不出时才放大」，见 upscaleJpeg。
 *
 * 已是 JPEG 的输入直接透传：不重新编解码，省掉一次进程启动和一次有损压缩。
 * @returns jpeg 绝对路径列表，与 inputPaths 一一对应
 */
export async function prepareVisionJpegs(
  inputPaths: string[],
  outDirAbs: string,
  opts?: { timeoutMs?: number },
): Promise<string[]> {
  if (inputPaths.length === 0) return [];
  const needEncode = inputPaths.filter((path) => !looksLikeJpeg(path));
  if (needEncode.length === 0) return [...inputPaths];

  const converted = await encodeFramesViaGdi(needEncode, outDirAbs, 1, opts?.timeoutMs);
  if (converted.length !== needEncode.length) {
    throw new Error(`帧转码数量不匹配: 输入 ${needEncode.length} → 输出 ${converted.length}`);
  }
  // 同一份输入可能被多个槽位引用，故按来源建映射回填，而不是靠下标对齐
  const encodedBySource = new Map(needEncode.map((src, i) => [src, converted[i]!]));
  return inputPaths.map((path) => encodedBySource.get(path) ?? path);
}

/** 读文件头 3 字节判断是否已是 JPEG；文件缺失/损坏时按「需要转码」处理。 */
function looksLikeJpeg(path: string): boolean {
  try {
    return isJpegBuffer(readFileSync(path).subarray(0, 3));
  } catch {
    return false;
  }
}

/**
 * 读码连续失败后的兜底：把单帧放大再试一次。
 *
 * 放大不增加信息，唯一作用是绕过「上游对过小图回空内容」这一具体故障，因此只在
 * 已经读不出之后调用——正常帧不该为它付出时间与 token。
 * @returns 放大后的 JPEG 路径；失败时抛错，由调用方降级为「排除该帧」
 */
export async function upscaleJpeg(
  jpegAbsPath: string,
  outDirAbs: string,
  scale = 4,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const [enlarged] = await encodeFramesViaGdi([jpegAbsPath], outDirAbs, scale, opts?.timeoutMs);
  if (!enlarged) throw new Error("帧放大未生成 JPEG");
  return enlarged;
}

/**
 * 单次 PowerShell 进程批量转码为 JPEG（可选整数倍放大，一律白底压平）。
 * 常规转码与失败后放大共用本函数，避免两处 GDI 脚本各自漂移（DRY）。
 * @returns 绝对路径列表，与 inputs 顺序一一对应
 */
async function encodeFramesViaGdi(
  inputs: string[],
  outDirAbs: string,
  scale: number,
  timeoutMs?: number,
): Promise<string[]> {
  if (inputs.length === 0) return [];
  if (process.platform !== "win32") {
    throw new Error("帧图转码仅支持 Windows（System.Drawing）");
  }
  mkdirSync(outDirAbs, { recursive: true });
  const limitMs = Math.min(60_000, Math.max(5_000, timeoutMs ?? 20_000));
  const scaleN = Math.min(8, Math.max(1, Math.floor(scale)));
  const listPath = join(outDirAbs, FRAME_LIST_FILE);
  writeFileSync(listPath, inputs.join("\n"), "utf8");

  const listPs = listPath.replace(/'/g, "''");
  const outPs = outDirAbs.replace(/'/g, "''");
  // 1:1 走 DrawImageUnscaled：DrawImage 在等尺寸下也可能重采样，只有它保证逐像素复制
  const drawLine =
    scaleN === 1
      ? "    $g.DrawImageUnscaled($img, 0, 0)"
      : "    $g.DrawImage($img, 0, 0, $w, $h)";
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$list='${listPs}'`,
    `$out='${outPs}'`,
    `$scale=${scaleN}`,
    "$i=0",
    "Get-Content -LiteralPath $list | ForEach-Object {",
    "  $src=$_.Trim()",
    "  if(-not $src){ return }",
    "  $img=[System.Drawing.Image]::FromFile($src)",
    "  try {",
    "    $w=$img.Width * $scale",
    "    $h=$img.Height * $scale",
    "    $bmp=New-Object System.Drawing.Bitmap $w, $h",
    "    $g=[System.Drawing.Graphics]::FromImage($bmp)",
    "    $g.Clear([System.Drawing.Color]::White)",
    drawLine,
    "    $g.Dispose()",
    "    $dest=Join-Path $out ('vision_'+$i.ToString('000')+'.jpg')",
    ...jpegEncodePsLines("$bmp", "$dest").map((line) => `    ${line}`),
    "    $bmp.Dispose()",
    "    $i++",
    "  } finally { $img.Dispose() }",
    "}",
    "Write-Output $i",
  ].join("; ");

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: limitMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`帧图转码失败: ${msg.slice(0, 400)}`);
  } finally {
    // 清单只是给 PowerShell 传参用的临时文件，不留给调用方清理（避免跨层耦合）
    try {
      rmSync(listPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  const names = readdirSync(outDirAbs)
    .filter((n) => /^vision_\d{3}\.jpg$/i.test(n))
    .sort();
  if (names.length === 0) {
    throw new Error("帧图转码完成但未生成 vision_*.jpg");
  }
  return names.map((n) => join(outDirAbs, n));
}
