/**
 * 点选流水线：主图采帧 → 题干条读序 → 网格 → JSON → 拟人连点 → 验收
 * 铁律：坐标截图只含主画布，题干不并入主图裁剪框。
 */
import type { Page } from "playwright-core";
import type { SidecarAiSettings } from "../../engine.js";
import type { JsonLogger } from "../../json-logger.js";
import type { AgentFileSystem } from "../filesystem.js";
import { overlayGrid, readJpegSize } from "./grid_overlay.js";
import type { GridConfig } from "./grid_overlay.js";
import { openCvDenoise } from "../opencv_preprocess.js";
import { visionInstructionContext } from "./dom_hint.js";
import { humanClickSequence, maybeClickCaptchaConfirm } from "./human_click.js";
import {
  aiPointsToUnits,
  modelPixelToViewport,
  readLiveMediaRect,
} from "./coord_map.js";
import {
  unitsToImagePixels,
  writeDebugClickArtifact,
} from "./debug_click.js";
import { clearPointCropMark, locateAndCaptureCaptcha } from "./locate.js";
import { FAIL_NEXT, type PixelPoint, type PointSelectResult } from "./types.js";
import { attachProtocolObserver, verifyPointSelect } from "./verify.js";
import { sleep, destroyPaths } from "../captcha_utils.js";
import { analyzeClickPoints } from "./vision.js";

/** ≥3 点且 Y 几乎共线 → 典型底部水平瞎扫 */
function looksLikeHorizontalSweep(
  pts: PixelPoint[],
  imageH: number,
): boolean {
  if (pts.length < 3) return false;
  const ys = pts.map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = maxY - minY;
  const nearBottom = minY > imageH * 0.55;
  return span < Math.max(18, imageH * 0.08) && nearBottom;
}

function captureMethodLabel(m?: string): string {
  if (m === "fetch") return "已直接下载原图";
  if (m === "canvas") return "已从页面画布导出";
  if (m === "cdp_fallback") return "用了备用截屏（可能闪一下）";
  return "已取到主图";
}

function formatClickPlan(
  units: Array<{ modelX: number; modelY: number }>,
): string {
  if (units.length === 1) {
    const u = units[0]!;
    return `准备点 1 处：图上大约 (${u.modelX.toFixed(0)}, ${u.modelY.toFixed(0)})`;
  }
  return (
    `准备依次点 ${units.length} 处：` +
    units
      .map((u, i) => `第${i + 1}处(${u.modelX.toFixed(0)},${u.modelY.toFixed(0)})`)
      .join(" → ")
  );
}

function isContextDestroyed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Execution context was destroyed|Target closed|most likely because of a navigation|frame was detached|navigating/i.test(
    msg,
  );
}

/** 网页自己在换题，先等几秒；再等到题干里重新出现汉字顺序 */
async function waitAfterPossibleReload(
  page: Page,
  logger: JsonLogger,
  reason: string,
): Promise<void> {
  logger.agentProgress(`页面好像在自动换验证码，先等它稳定一下…`, {
    phase: "point_select_captcha",
    stage: "reload_buffer",
    reason,
  });
  await sleep(3000);
  await page
    .waitForLoadState("domcontentloaded", { timeout: 8000 })
    .catch(() => null);
  // 等到「---> 汉字」重新出现，避免题干短暂变成 > > > 读不到字序
  const tipOk = await page
    .waitForFunction(
      () => {
        const t = String(document.body?.innerText || "").replace(/\s+/g, " ");
        return /(?:--->|→)\s*[\u4e00-\u9fff]{2,12}/.test(t);
      },
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!tipOk) {
    logger.agentProgress("题干汉字还没出来，再稍等…", {
      phase: "point_select_captcha",
      stage: "wait_tip",
    });
    await sleep(1200);
  } else {
    await sleep(400);
  }
}

const MAX_ROUNDS = 3; // 单次工具调用的内部轮次；外层硬闸另计 3 次工具调用

export async function runPointSelectPipeline(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
  pageHint?: string;
  goalHint?: string;
}): Promise<PointSelectResult> {
  const empty = (detail: string): PointSelectResult => ({
    ok: false,
    strategy: "point_select_click",
    points: [],
    viewportPoints: [],
    confidence: 0,
    method: "none",
    verified: null,
    verifySignal: "",
    protocolHints: [],
    artifactPaths: [],
    detail,
  });

  if (input.signal?.aborted) throw new Error("Agent 已中止");

  let lastRaw = "";
  const allArtifacts: string[] = [];
  let consecutiveNavFails = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (input.signal?.aborted) throw new Error("Agent 已中止");

    input.logger.agentProgress(
      `① 第 ${round}/${MAX_ROUNDS} 次尝试：先找到验证码大图并悄悄取下来`,
      { phase: "point_select_captcha", stage: "locate", round },
    );

    let shot;
    try {
      shot = await locateAndCaptureCaptcha(input.page, input.fileSystem);
      consecutiveNavFails = 0;
    } catch (err) {
      if (isContextDestroyed(err) && consecutiveNavFails < 2) {
        consecutiveNavFails += 1;
        await waitAfterPossibleReload(
          input.page,
          input.logger,
          "locate context destroyed",
        );
        round -= 1; // 本轮作废，重试同一 round 计数
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await clearPointCropMark(input.page).catch(() => null);
      return empty(`定位/截图失败：${msg.slice(0, 120)}。${FAIL_NEXT}`);
    }

    if (!shot) {
      await clearPointCropMark(input.page).catch(() => null);
      return empty(`未找到验证码主图区域。${FAIL_NEXT}`);
    }
    if (shot.path) allArtifacts.push(shot.path);
    if (shot.captureMethod === "cdp_fallback") {
      input.logger.agentProgress(
        "取图不太顺利，改用截屏了（屏幕可能会闪一下）",
        {
          phase: "point_select_captcha",
          stage: "capture_fallback",
          captureMethod: "cdp_fallback",
        },
      );
    }

    // Visual Grid：原图叠网格（默认 10×10 A–J/0–9）送 VLM；
    // Prompt 含防干扰负面提示；墨迹吸附用无网格原图 cleanB64
    let visionB64 = shot.b64;
    let altVisionB64: string | null = null;
    const cleanB64 = shot.b64;
    const tipB64 = shot.tipB64;
    let gridInfo: GridConfig | null = null;
    const hintCtx = visionInstructionContext(shot.crop.instruction);
    if (hintCtx.unreliable || shot.crop.instructionUnreliable) {
      shot.crop.instructionUnreliable = true;
    }
    try {
      // 主图叠格用「原图」：旧实现先用 OpenCV 保色增强再叠格，颜色/对比被改写后
      // 图标/汉字点选反而认错目标。OpenCV 应锦上添花，只作原图读不出点时的兜底。
      const gridded = await overlayGrid(input.page, shot.buf);
      visionB64 = gridded.processedImageBase64;
      gridInfo = gridded.gridInfo;
      // 兜底图：OpenCV 保色去噪后叠格，仅在原图视觉读不出点时改用。
      try {
        const denoised = await openCvDenoise({
          buf: shot.buf,
          color: true,
          logger: input.logger,
          signal: input.signal,
        });
        if (denoised) {
          const altGridded = await overlayGrid(input.page, denoised.jpeg);
          if (altGridded.processedImageBase64) {
            altVisionB64 = altGridded.processedImageBase64;
          }
        }
      } catch {
        /* OpenCV 不可用时无兜底图 */
      }
      const sz =
        gridded.imageWidth > 0
          ? { w: gridded.imageWidth, h: gridded.imageHeight }
          : readJpegSize(gridded.buf);
      if (sz && sz.w > 0 && sz.h > 0) {
        shot.crop.imageWidth = sz.w;
        shot.crop.imageHeight = sz.h;
        shot.crop.dpr = sz.w / Math.max(1, shot.crop.width);
      }
      if (input.fileSystem) {
        const gp = input.fileSystem.writeBinaryFile(
          `captcha_point_vgrid_${Date.now()}.jpg`,
          gridded.buf,
        );
        allArtifacts.push(gp);
      }
      const tipBit = tipB64
        ? "；另看了题干小条（只用来认要点谁）"
        : "";
      const tipText = hintCtx.unreliable
        ? "题干文字看不清，主要靠看图"
        : shot.crop.instruction
          ? `题目：${shot.crop.instruction.slice(0, 40)}`
          : "正在看图认目标";
      input.logger.agentProgress(
        `② ${captureMethodLabel(shot.captureMethod)}（${Math.round(shot.crop.width)}×${Math.round(shot.crop.height)}），已叠 Visual Grid 10×10（A–J / 0–9）` +
          tipBit +
          `。${tipText}`,
        {
          phase: "point_select_captcha",
          stage: "crop_vgrid",
          w: shot.crop.width,
          h: shot.crop.height,
          captureMethod: shot.captureMethod ?? null,
          hasTip: Boolean(tipB64),
          hanSeq: hintCtx.hanSequence,
          domUnreliable: !!shot.crop.instructionUnreliable,
        },
      );
    } catch (err) {
      if (isContextDestroyed(err) && consecutiveNavFails < 2) {
        consecutiveNavFails += 1;
        destroyPaths(allArtifacts);
        await waitAfterPossibleReload(
          input.page,
          input.logger,
          "grid overlay nav",
        );
        round -= 1;
        continue;
      }
      if (isContextDestroyed(err)) {
        await clearPointCropMark(input.page).catch(() => null);
        return empty(
          `页面在叠格时反复导航/销毁上下文（已重试 ${consecutiveNavFails} 次）。${FAIL_NEXT}`,
        );
      }
      input.logger.warn("point_select_grid_overlay_fail", {
        reason: err instanceof Error ? err.message : String(err),
      });
      await clearPointCropMark(input.page).catch(() => null);
      return empty(
        `Visual Grid 叠图失败：${err instanceof Error ? err.message.slice(0, 80) : String(err)}。${FAIL_NEXT}`,
      );
    }

    if (!gridInfo) {
      await clearPointCropMark(input.page).catch(() => null);
      return empty(`缺少 GridConfig，无法离散定位。${FAIL_NEXT}`);
    }

    let points = [] as Awaited<ReturnType<typeof analyzeClickPoints>>["points"];
    let confidence = 0;
    try {
      input.logger.agentProgress(
        "③ 正在问视觉模型（强制 JSON · 汉字/图标自适应）…",
        {
          phase: "point_select_captcha",
          stage: "vision",
        },
      );
      for (let attempt = 1; attempt <= 2; attempt++) {
        // 首轮用原图叠格；读不出点再退回 OpenCV 去噪图叠格（锦上添花，不抢主图）。
        const imageB64 = attempt === 1 ? visionB64 : altVisionB64 ?? visionB64;
        const analyzed = await analyzeClickPoints({
          aiSettings: input.aiSettings,
          logger: input.logger,
          signal: input.signal,
          page: input.page,
          imageB64,
          cleanB64,
          tipB64,
          tipIcons: shot.tipIcons,
          crop: shot.crop,
          gridInfo,
          attempt,
        });
        lastRaw = analyzed.rawHead;
        if (analyzed.points.length > 0) {
          if (looksLikeHorizontalSweep(analyzed.points, shot.crop.height)) {
            input.logger.warn("point_select_reject_horizontal_sweep", {
              points: analyzed.points,
              attempt,
            });
            input.logger.agentProgress(
              "AI 好像在图底部乱扫了一排点，不算数，再问一次…",
              {
                phase: "point_select_captcha",
                stage: "vision_reject",
                attempt,
              },
            );
            lastRaw = "horizontal_sweep_rejected";
            if (attempt === 1) {
              await sleep(120);
              continue;
            }
            break;
          }
          points = analyzed.points;
          confidence = analyzed.confidence;
          break;
        }
        if (attempt === 1) {
          input.logger.agentProgress(
            "AI 这轮没给齐有效格号，再认真问一遍…",
            {
              phase: "point_select_captcha",
              stage: "vision_retry",
            },
          );
          await sleep(120);
        }
      }
    } catch (err) {
      destroyPaths(allArtifacts);
      await clearPointCropMark(input.page).catch(() => null);
      const msg = err instanceof Error ? err.message : String(err);
      if (/已中止|未配置视觉/i.test(msg)) return empty(`${msg}。${FAIL_NEXT}`);
      return empty(`视觉分析异常：${msg.slice(0, 120)}。${FAIL_NEXT}`);
    }

    if (!points.length) {
      destroyPaths(allArtifacts);
      await clearPointCropMark(input.page).catch(() => null);
      return empty(
        `AI 没看懂该点哪里（${lastRaw.slice(0, 60) || "无回复"}）。${FAIL_NEXT}`,
      );
    }

    const imgW = Math.max(1, shot.crop.imageWidth ?? shot.crop.width);
    const imgH = Math.max(1, shot.crop.imageHeight ?? shot.crop.height);
    const units = aiPointsToUnits(points, imgW, imgH);

    const livePreview = (await readLiveMediaRect(input.page)) ?? {
      left: shot.crop.startX,
      top: shot.crop.startY,
      width: shot.crop.width,
      height: shot.crop.height,
    };
    const viewportPoints = units.map((u) =>
      modelPixelToViewport(livePreview, u.modelX, u.modelY, imgW, imgH),
    );

    input.logger.agentProgress(
      `④ ${formatClickPlan(units)}；换算到屏幕约 ` +
        viewportPoints
          .map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`)
          .join(" → ") +
        (livePreview.contentInsetX || livePreview.contentInsetY
          ? `（已按内容区校正，避开边框/内边距）`
          : ""),
      {
        phase: "point_select_captcha",
        stage: "plan",
        n: points.length,
        imgW,
        imgH,
        cssW: shot.crop.width,
        cssH: shot.crop.height,
        units,
        viewportPoints,
        liveRect: livePreview,
      },
    );

    const debugPts = unitsToImagePixels(units, imgW, imgH);
    const debugPath = await writeDebugClickArtifact({
      page: input.page,
      logger: input.logger,
      imageB64: visionB64,
      imagePoints: debugPts,
      viewportPoints,
      canvasRect: livePreview,
    });
    if (debugPath) {
      allArtifacts.push(debugPath);
      input.logger.agentProgress(
        `已画好核对图（标记点=打算点的位置），保存在：${debugPath}`,
        {
          phase: "point_select_captcha",
          stage: "debug_click",
          path: debugPath,
        },
      );
    }

    const observer = attachProtocolObserver(input.page);
    let clicked = 0;
    let outcome = { verified: null as boolean | null, signal: "" };
    let finalViewport = viewportPoints;

    try {
      const clickOut = await humanClickSequence({
        page: input.page,
        logger: input.logger,
        units,
        imageWidth: imgW,
        imageHeight: imgH,
        signal: input.signal,
      });
      clicked = clickOut.clicked;
      finalViewport = clickOut.viewportPoints;
      await maybeClickCaptchaConfirm(input.page, input.logger);
      await sleep(1500);
      outcome = await verifyPointSelect(input.page, observer.hits);
    } catch (err) {
      observer.dispose();
      destroyPaths(allArtifacts.filter((p) => !/[/\\]debug_/i.test(p)));
      if (isContextDestroyed(err) && round < MAX_ROUNDS) {
        await waitAfterPossibleReload(
          input.page,
          input.logger,
          "click/verify nav",
        );
        continue;
      }
      await clearPointCropMark(input.page).catch(() => null);
      const msg = err instanceof Error ? err.message : String(err);
      return empty(`点击/验收异常：${msg.slice(0, 120)}。${FAIL_NEXT}`);
    } finally {
      observer.dispose();
    }

    destroyPaths(allArtifacts.filter((p) => !/[/\\]debug_/i.test(p)));
    await clearPointCropMark(input.page).catch(() => null);

    const verifiedText =
      outcome.verified === true
        ? "看起来过了"
        : outcome.verified === false
          ? "没过"
          : "还不确定过没过（页面没给明确结果）";
    input.logger.agentProgress(
      `⑥ 点完了（共 ${clicked} 下）——${verifiedText}` +
        (debugPath ? `。核对图：${debugPath}` : ""),
      {
        phase: "point_select_captcha",
        stage: "done",
        verified: outcome.verified,
        signal: outcome.signal,
        debugPath: debugPath ?? null,
      },
    );

    const result: PointSelectResult = {
      ok: outcome.verified !== false,
      strategy: "point_select_click",
      points,
      viewportPoints: finalViewport,
      confidence,
      method: `visual_grid_10x10_ink n=${clicked} round=${round}`,
      verified: outcome.verified,
      verifySignal: outcome.signal,
      protocolHints: observer.hits.map((h) => `${h.url} :: ${h.preview}`),
      // 核对图是给用户/排障留的证据，必须常驻 sidecar/logs；放进 artifactPaths 会被
      // 外层 cleanupCaptchaArtifacts 在动作结束时删掉（用户随后打开路径即「文件不存在」）。
      artifactPaths: [],
      crop: shot.crop,
      detail:
        outcome.verified === true
          ? "点选通过；可继续任务"
          : outcome.verified === false
            ? `点选失败（${outcome.signal}）；${FAIL_NEXT}`
            : `已拟人点击 ${clicked} 次；请观察是否通过后继续`,
    };

    // 明确失败：页端常自刷，等待新题稳定后再同工具重试（不主动点刷新）
    if (outcome.verified === false && round < MAX_ROUNDS) {
      input.logger.agentProgress(
        "这题没过。等页面自己换新题后再试（我们不会主动点刷新）…",
        {
          phase: "point_select_captcha",
          stage: "retry",
          round,
        },
      );
      await waitAfterPossibleReload(input.page, input.logger, "verified=false");
      continue;
    }

    return result;
  }

  return empty(`点选 ${MAX_ROUNDS} 轮后仍未通过。${FAIL_NEXT}`);
}
