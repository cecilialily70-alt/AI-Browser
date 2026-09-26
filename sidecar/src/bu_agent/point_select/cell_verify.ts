/**
 * 逐格视觉核验：裁格后问 VLM「目标是否在本格」。
 * 汉字认字；图标有题干模板小图时对照模板（勿用 T1 空标签硬核验）。
 */
import type { Page } from "playwright-core";
import type { JsonLogger } from "../../json-logger.js";
import type { GridConfig } from "./grid_overlay.js";
import { cropGridCellJpeg } from "./ink_check.js";

export type CellVerifyPick = { char: string; grid: string };

function parseMatchFlag(raw: string): boolean | null {
  const t = String(raw ?? "");
  const m = /["']?match["']?\s*:\s*(true|false)/i.exec(t);
  if (!m) return null;
  return m[1]!.toLowerCase() === "true";
}

/**
 * 对 sequence 逐格核验；返回未命中的下标。
 * inconclusive：汉字宽松放过；图标有模板时也放过（勿因 T1 空标签误杀）；无模板的严格模式才当失败。
 */
export async function findMismatchedCellIndexes(input: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  model: string;
  page: Page;
  cleanB64: string;
  grid: GridConfig;
  sequence: CellVerifyPick[];
  signal?: AbortSignal;
  logger: JsonLogger;
  /** 图标模式：无模板且解析失败时算未通过 */
  strict?: boolean;
  mode?: "hanzi" | "icon";
  /** 题干完整答案小图（与 sequence 下标对齐） */
  tipIcons?: string[];
}): Promise<number[]> {
  const tipIcons = Array.isArray(input.tipIcons)
    ? input.tipIcons.filter((x) => typeof x === "string" && x.length > 40)
    : [];
  const bad: number[] = [];
  for (let i = 0; i < input.sequence.length; i++) {
    const item = input.sequence[i]!;
    const cropB64 = await cropGridCellJpeg(
      input.page,
      input.cleanB64,
      item.grid,
      input.grid,
    );
    if (!cropB64) {
      bad.push(i);
      continue;
    }

    const tipIcon = tipIcons[i];
    const isHanzi =
      input.mode === "hanzi" ||
      (input.mode !== "icon" && /^[\u4e00-\u9fff]$/u.test(item.char));

    const userContent: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: string } }
    > = [];

    let prompt: string;
    if (isHanzi) {
      prompt = [
        `这是验证码主图裁出的一个网格局部。`,
        `目标汉字：「${item.char}」。`,
        `判断裁剪内是否能看到该汉字的笔画结构（可叠在插画上）。`,
        `忽略贯穿细线、噪点、背景花纹；无字的卡通人物不算。`,
        `禁止think。只输出JSON：{"match":true} 或 {"match":false}`,
      ].join("\n");
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${cropB64}`, detail: "high" },
      });
      userContent.push({ type: "text", text: prompt });
    } else if (tipIcon) {
      prompt = [
        `第一张=题干目标模板（完整答案小图）；第二张=主图某一网格裁剪。`,
        `判断第二张里是否有与第一张【外形轮廓】相近的图标（填色/光晕可不同，只比外形）。`,
        `忽略贯穿细线、噪点、背景花纹与卡通人物。`,
        `禁止think。只输出JSON：{"match":true} 或 {"match":false}`,
      ].join("\n");
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${tipIcon}`, detail: "high" },
      });
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${cropB64}`, detail: "high" },
      });
      userContent.push({ type: "text", text: prompt });
    } else {
      prompt = [
        `这是验证码主图裁出的一个网格局部。`,
        `目标外形标签：「${item.char}」。`,
        `判断裁剪内是否有外形相近的几何图标（按图比较轮廓，勿套固定词表）。`,
        `忽略贯穿细线、噪点、背景花纹与卡通人物。`,
        `禁止think。只输出JSON：{"match":true} 或 {"match":false}`,
      ].join("\n");
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${cropB64}`, detail: "high" },
      });
      userContent.push({ type: "text", text: prompt });
    }

    try {
      const resp = await input.client.chat.completions.create(
        {
          model: input.model,
          temperature: 0,
          max_tokens: 128,
          messages: [
            {
              role: "system",
              content: "JSON only. First char must be {",
            },
            {
              role: "user",
              content: userContent,
            },
          ],
        },
        input.signal ? { signal: input.signal } : undefined,
      );

      const content = resp?.choices?.[0]?.message?.content;
      const raw =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((p: unknown) =>
                  typeof p === "string"
                    ? p
                    : String(
                        (p as { text?: string })?.text ??
                          (p as { content?: string })?.content ??
                          "",
                      ),
                )
                .join("")
            : String(content ?? "");

      const flag = parseMatchFlag(raw);
      // 有题干模板时：无明确 JSON 不当失败（避免 T1 空标签/模型含糊误杀已对齐序列）
      const softInconclusive = Boolean(tipIcon) || isHanzi || !input.strict;
      if (flag === false) {
        input.logger.agentProgress(
          `逐格核验未通过：${item.char}@${item.grid}`,
          {
            phase: "point_select_captcha",
            stage: "cell_verify_miss",
            char: item.char,
            grid: item.grid,
          },
        );
        bad.push(i);
      } else if (flag === null) {
        if (!softInconclusive) {
          input.logger.agentProgress(
            `逐格核验无明确结果（严格模式未通过）：${item.char}@${item.grid}`,
            {
              phase: "point_select_captcha",
              stage: "cell_verify_strict_fail",
              char: item.char,
              grid: item.grid,
            },
          );
          bad.push(i);
        } else {
          input.logger.agentProgress(
            `逐格核验无明确结果，放过 ${item.char}@${item.grid}`,
            {
              phase: "point_select_captcha",
              stage: "cell_verify_inconclusive",
              char: item.char,
              grid: item.grid,
            },
          );
        }
      }
    } catch (err) {
      input.logger.warn("point_select_cell_verify_err", {
        char: item.char,
        grid: item.grid,
        err: err instanceof Error ? err.message.slice(0, 120) : String(err),
      });
    }
  }
  return bad;
}
