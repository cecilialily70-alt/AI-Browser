// @ts-nocheck
/**
 * 点选视觉（API 请求层）：Visual Grid 离散格号 + 本地墨迹/色块质心
 * 汉字：glyph 墨迹；图标：本地色块普查 + 色度增强送模
 */
import type { Page } from "playwright-core";
import type { SidecarAiSettings } from "../../engine.js";
import { createModelRouter, isIntentConfigured } from "../../ai_model_router.js";
import type { JsonLogger } from "../../json-logger.js";
import type { CaptchaCrop, PixelPoint } from "./types.js";
import { extractHanClickSequence, visionInstructionContext } from "./dom_hint.js";
import {
  type GridConfig,
  gridIdToCenter,
  neighborGridIds,
  parseGridId,
  overlayGrid,
} from "./grid_overlay.js";
import { refineInkCentroid, inkHalfForCell } from "./ink_check.js";
import { detectMarkBoxes, overlayMarkBoxes } from "./mark_boxes.js";
import { findMismatchedCellIndexes } from "./cell_verify.js";
import {
  detectChromaBlobGrids,
  enhanceChromaContrast,
  rankGridsByTipSilhouette,
} from "./icon_vision.js";
/**
 * 负面提示（防干扰）——贯穿细线、噪点、背景花纹叠在目标上。
 * 注入所有视觉 Prompt，降低 VLM 把干扰当笔画/把噪点当图形的概率。
 */
export const ANTI_INTERFERENCE_RULE = [
    "【防干扰·负面提示】请忽略：贯穿字符/图形的细长干扰线、散点噪点、与主体结构无关的背景花纹与水印。",
    "只关注最粗的、具有实际语义的实心笔画或几何图形主体；细线穿过字心时仍以字的整体结构定格，不要跟线走。",
].join("");
/** 网格输出硬规则：禁止像素坐标，只回报格号 */
export const GRID_OUTPUT_RULE = [
    "【网格输出】不要返回具体像素坐标 (x,y)。",
    "请判断目标核心部分落在哪个网格，直接返回格号（如 C4）。格号=列字母(A–J)+行号(0–9)。",
].join("");
function pieceToText(p) {
    if (typeof p === "string")
        return p;
    if (p && typeof p === "object") {
        const o = p;
        return String(o.text ?? o.content ?? "");
    }
    return "";
}
function extractVisionText(resp) {
    const msg = resp.choices?.[0]?.message;
    if (!msg)
        return "";
    let content = "";
    const c = msg.content;
    if (typeof c === "string" && c.trim())
        content = c.trim();
    else if (Array.isArray(c))
        content = c.map(pieceToText).join("").trim();
    const reasoning = typeof msg.reasoning_content === "string"
        ? msg.reasoning_content.trim()
        : "";
    const hasJson = (s) => /\{\s*["']?sequence["']?\s*:/i.test(s) ||
        /\{\s*["']?detected_text_grids["']?\s*:/i.test(s) ||
        /\{\s*["']?grid["']?\s*:/i.test(s) ||
        /\[\s*\{[\s\S]*["']?grid["']?\s*:/i.test(s) ||
        /["']?grid["']?\s*:\s*["']?[A-Ja-j][0-9]/.test(s);
    // 内容已有 JSON → 优先；否则合并 reasoning，便于从 think 里抢救格号
    if (content && hasJson(content))
        return content;
    if (reasoning && hasJson(reasoning) && !hasJson(content)) {
        return content
            ? `${content}\n${reasoning}`
            : reasoning;
    }
    if (content && reasoning) {
        return `${reasoning}\n${content}`;
    }
    if (content)
        return content;
    return reasoning;
}
/** 去掉 think 块后取正文；未闭合时也尝试截掉开头的 think */
function afterThink(raw) {
    const lower = raw.toLowerCase();
    const closeIdx = lower.lastIndexOf("</think>");
    if (closeIdx >= 0)
        return raw.slice(closeIdx + "</think>".length);
    // 未闭合 <think>…：若后面碰巧有 { 从第一个 { 起
    const open = lower.indexOf("<think>");
    if (open >= 0) {
        const afterOpen = raw.slice(open + 7);
        const brace = afterOpen.indexOf("{");
        if (brace >= 0)
            return afterOpen.slice(brace);
        return afterOpen;
    }
    return raw;
}
function tryParseJsonBlob(s) {
    const t = s.trim();
    if (!t)
        return null;
    try {
        return JSON.parse(t);
    }
    catch {
        /* */
    }
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
        try {
            return JSON.parse(fenced[1].trim());
        }
        catch {
            /* */
        }
    }
    for (const chunk of extractBalancedJsonObjects(t)) {
        try {
            return JSON.parse(chunk);
        }
        catch {
            /* */
        }
    }
    const arr = t.match(/\[[\s\S]*\]/);
    if (arr?.[0]) {
        try {
            return JSON.parse(arr[0]);
        }
        catch {
            /* */
        }
    }
    return null;
}
/** 提取文本中平衡的 {...} 片段（抗截断/夹杂口语） */
function extractBalancedJsonObjects(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== "{")
            continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let j = i; j < s.length; j++) {
            const ch = s[j];
            if (inStr) {
                if (esc)
                    esc = false;
                else if (ch === "\\")
                    esc = true;
                else if (ch === '"')
                    inStr = false;
                continue;
            }
            if (ch === '"') {
                inStr = true;
                continue;
            }
            if (ch === "{")
                depth += 1;
            else if (ch === "}") {
                depth -= 1;
                if (depth === 0) {
                    out.push(s.slice(i, j + 1));
                    break;
                }
            }
        }
    }
    return out.sort((a, b) => b.length - a.length);
}
/**
 * JSON 失败时的正则抢救：含英文 think「也 at C3」口语
 */
function salvageSequenceFromText(raw, grid, preferChars) {
    const out = [];
    const seen = new Set();
    const push = (ch, gridRaw) => {
        const id = parseGridId(gridRaw, grid);
        if (!id)
            return;
        const char = String(ch || "").trim() || "?";
        if (!char || char === "?")
            return;
        const key = `${char}@${id.id}`;
        if (seen.has(key))
            return;
        // 同一字只保留第一次（避免 think 里反复猜测）
        if ([...seen].some((k) => k.startsWith(`${char}@`)))
            return;
        seen.add(key);
        out.push({ char, grid: id.id });
    };
    const reObj = /["']?char["']?\s*:\s*["']([^"']{1,8})["']\s*,\s*["']?grid["']?\s*:\s*["']([A-Ja-j][0-9])["']/gi;
    let m;
    while ((m = reObj.exec(raw)) !== null) {
        push(m[1], m[2]);
    }
    const reObj2 = /["']?grid["']?\s*:\s*["']([A-Ja-j][0-9])["']\s*,\s*["']?char["']?\s*:\s*["']([^"']{1,8})["']/gi;
    while ((m = reObj2.exec(raw)) !== null) {
        push(m[2], m[1]);
    }
    const reAt = /[「『]?([\u4e00-\u9fff1-9])[」』]?\s*[@＠]\s*([A-Ja-j][0-9])/g;
    while ((m = reAt.exec(raw)) !== null) {
        push(m[1], m[2]);
    }
    // 英文/中文口语：也 at C3 / 也 in cell C3 / character 也 → C3 / 也：C3
    const reProse = /(?:character|char|汉字|字|目标)?\s*[「"']?([\u4e00-\u9fff]|[1-9])[」"']?\s*(?:is\s+)?(?:at|in|on|→|->|：|:|位于|在)\s*(?:grid|cell|格)?\s*([A-Ja-j][0-9])/gi;
    while ((m = reProse.exec(raw)) !== null) {
        push(m[1], m[2]);
    }
    const reProse2 = /([A-Ja-j][0-9])\s*(?:is\s+|→|->|:|：)?\s*[「"']?([\u4e00-\u9fff]|[1-9])[」"']?/g;
    while ((m = reProse2.exec(raw)) !== null) {
        push(m[2], m[1]);
    }
    // 题干字已知：按字在原文附近找格号
    if (preferChars?.length) {
        for (const ch of preferChars) {
            if (out.some((p) => p.char === ch))
                continue;
            const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const near = new RegExp(`${esc}[^A-Ja-j]{0,24}([A-Ja-j][0-9])|([A-Ja-j][0-9])[^\\u4e00-\\u9fff]{0,24}${esc}`, "i");
            const hm = near.exec(raw);
            if (hm)
                push(ch, hm[1] || hm[2] || "");
        }
    }
    if (preferChars && preferChars.length >= 2) {
        const byChar = new Map();
        for (const p of out) {
            if (!byChar.has(p.char))
                byChar.set(p.char, p.grid);
        }
        const ordered = [];
        for (const ch of preferChars) {
            const g = byChar.get(ch);
            if (g)
                ordered.push({ char: ch, grid: g });
        }
        if (ordered.length >= Math.min(2, preferChars.length)) {
            // 齐了就返回；齐不全也返回已有（调用方再补）
            if (ordered.length === preferChars.length)
                return ordered;
            if (ordered.length > out.filter((p) => preferChars.includes(p.char)).length) {
                return ordered;
            }
            return ordered.length ? ordered : out.slice(0, 8);
        }
    }
    return out.slice(0, 8);
}
function salvageDetectedGridsFromText(raw, grid) {
    const out = [];
    const seen = new Set();
    const re = /detected_text_grids["']?\s*:\s*\[([^\]]*)\]/i.exec(raw) ||
        /text_grids["']?\s*:\s*\[([^\]]*)\]/i.exec(raw);
    const blob = re?.[1] ?? raw;
    const idRe = /[A-Ja-j][0-9]/g;
    let m;
    while ((m = idRe.exec(blob)) !== null) {
        const id = parseGridId(m[0], grid);
        if (!id || seen.has(id.id))
            continue;
        seen.add(id.id);
        out.push(id.id);
        if (out.length >= 12)
            break;
    }
    return out;
}
function collectDetectedGrids(parsed, grid) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return [];
    const o = parsed;
    const raw = o.detected_text_grids ?? o.detectedTextGrids ?? o.text_grids ?? o.candidates;
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const seen = new Set();
    for (const it of raw) {
        const id = parseGridId(String(it ?? ""), grid);
        if (!id || seen.has(id.id))
            continue;
        seen.add(id.id);
        out.push(id.id);
    }
    return out;
}
function collectGridSequence(parsed, grid) {
    const out = [];
    const take = (o) => {
        const gridRaw = String(o.grid ?? o.cell ?? o.gridId ?? o.id ?? "").trim();
        const parsedId = parseGridId(gridRaw, grid);
        if (!parsedId)
            return;
        const ch = String(o.char ?? o.target ?? o.label ?? "").trim() || "?";
        out.push({ char: ch, grid: parsedId.id });
    };
    if (Array.isArray(parsed)) {
        for (const it of parsed) {
            if (it && typeof it === "object")
                take(it);
        }
        return out.slice(0, 8);
    }
    if (parsed && typeof parsed === "object") {
        const o = parsed;
        for (const key of ["sequence", "clicks", "targets", "points", "results"]) {
            const arr = o[key];
            if (!Array.isArray(arr))
                continue;
            for (const it of arr) {
                if (it && typeof it === "object")
                    take(it);
            }
        }
        if (!out.length && (o.grid != null || o.cell != null)) {
            take(o);
        }
    }
    return out.slice(0, 8);
}
export function extractGridVisionResult(rawText, grid, logger, preferChars) {
    const raw = String(rawText ?? "");
    if (!raw.trim()) {
        logger?.warn("point_select_grid_extract_empty", { reason: "raw 为空" });
        return null;
    }
    const body = afterThink(raw).trim() || raw.trim();
    for (const src of [body, raw]) {
        const parsed = tryParseJsonBlob(src);
        if (parsed == null)
            continue;
        const sequence = collectGridSequence(parsed, grid);
        const detectedTextGrids = collectDetectedGrids(parsed, grid);
        if (sequence.length) {
            return { detectedTextGrids, sequence };
        }
    }
    // 正则抢救：正文 + 完整 think（模型常把格号写在推理里）
    for (const src of [body, raw]) {
        const salvaged = salvageSequenceFromText(src, grid, preferChars);
        if (salvaged.length) {
            logger?.warn("point_select_grid_salvaged", {
                n: salvaged.length,
                head: src.slice(0, 160),
            });
            return {
                detectedTextGrids: salvageDetectedGridsFromText(src, grid),
                sequence: salvaged,
            };
        }
    }
    logger?.warn("point_select_grid_extract_fail", {
        reason: "未解析到 sequence[].grid",
        head: body.slice(0, 280),
    });
    return null;
}
export function extractCoordinates(_rawText, _imageW, _imageH, logger) {
    logger?.warn("point_select_pixel_extract_deprecated", {
        reason: "已改 Visual Grid，不再解析 pixel_coordinate",
    });
    return null;
}
export function parseClickPointsJson(raw, imageW, imageH, logger) {
    return extractCoordinates(raw, imageW, imageH, logger) ?? [];
}
export function extractCoordinateJsonCandidates(rawText) {
    const body = afterThink(String(rawText ?? ""));
    const m = body.match(/\{[\s\S]*\}/) || body.match(/\[[\s\S]*\]/);
    return m?.[0] ? [m[0]] : [];
}
/**
 * 方案 B：Stage1 只普查候选格；Stage2 再独占绑定题干顺序。
 */
function buildSurveyPrompt(input) {
    const ban = input.bannedGrids.length
        ? `已知空白/干扰格勿报: ${input.bannedGrids.join(",")}`
        : "";
    if (input.mode === "hanzi") {
        return [
            `图已叠${input.grid.cols}x${input.grid.rows}格(${input.grid.colLabels[0]}-${input.grid.colLabels[input.grid.cols - 1]} / 0-${input.grid.rows - 1})，宽${input.grid.imageWidth}高${input.grid.imageHeight}。`,
            ANTI_INTERFERENCE_RULE,
            GRID_OUTPUT_RULE,
            "任务【仅普查】：找出所有真实汉字笔画所在格（通常3~6个）。",
            "忽略无字的卡通人物/头盔/服装；若字写在插画上，该字格仍要报。",
            "底纹不是字。",
            ban,
            "禁止think。只输出JSON：",
            `{"detected_text_grids":["C3","E7","F5","H4"]}`,
            `至少报${input.expectMin}个互不相同的格号。不要输出 sequence。不要输出像素坐标。`,
        ]
            .filter(Boolean)
            .join("\n");
    }
    return [
        `图已叠${input.grid.cols}x${input.grid.rows}格(${input.grid.colLabels[0]}-${input.grid.colLabels[input.grid.cols - 1]} / 0-${input.grid.rows - 1})，宽${input.grid.imageWidth}高${input.grid.imageHeight}。`,
        ANTI_INTERFERENCE_RULE,
        GRID_OUTPUT_RULE,
        "任务【仅普查】：找出画面上所有独立几何图标/形状中心所在格（不同外形各报一格）。",
        "半透明/低对比也要报。忽略卡通人物与细线噪点。每个图标只报一格。",
        "题干条只用于稍后排序；本步只普查外形斑点所在格，不要读顺序。",
        "不要套用任何固定形状词表。",
        ban,
        "禁止think。只输出JSON：",
        `{"detected_text_grids":["B2","D2","E7"]}`,
        "不要输出像素坐标。",
    ]
        .filter(Boolean)
        .join("\n");
}
function buildBindPrompt(input) {
    const labels = input.labels;
    const pool = input.pool.join(",");
    const ban = input.bannedGrids.length
        ? `禁用: ${input.bannedGrids.join(",")}`
        : "";
    if (input.mode === "hanzi") {
        const dupHint = labels.some((c, i) => labels.indexOf(c) !== i)
            ? "题干有重复字：每个重复字必须绑定不同格（例如两个「不」→两个不同格）。"
            : "";
        const seqEx = labels
            .map((ch) => `{"char":"${ch}","grid":"${input.pool[0] || "C3"}"}`)
            .join(",");
        return [
            ANTI_INTERFERENCE_RULE,
            GRID_OUTPUT_RULE,
            `候选字斑池（只能从中选）: [${pool}]`,
            `按序绑定: ${labels.join(" → ")}（共${labels.length}）。`,
            "硬规则：每个目标占用不同格；不同字禁止同格；重复字也禁止同格。",
            dupHint,
            "卡通无字部位不要选；叠在插画上的字可选其笔画格。",
            ban,
            "禁止think。只输出JSON：",
            `{"sequence":[${seqEx}]}`,
            "grid 必须来自候选池且互不重复。禁止像素坐标。",
        ]
            .filter(Boolean)
            .join("\n");
    }
    const seqEx = labels
        .map((ch, i) => `{"char":"${ch}","grid":"${input.pool[i] || input.pool[0] || "B2"}"}`)
        .join(",");
    return [
        ANTI_INTERFERENCE_RULE,
        GRID_OUTPUT_RULE,
        `候选图标格池: [${pool}]`,
        `按题干条从左到右顺序绑定 ${labels.length} 个目标（char用${labels.join(",")}）。`,
        "每格只能用一次。忽略卡通。",
        ban,
        "禁止think。只输出JSON：",
        `{"sequence":[${seqEx}]}`,
        "禁止像素坐标。",
    ]
        .filter(Boolean)
        .join("\n");
}
function buildPerTargetPrompt(input) {
    const ban = input.banned.length ? `禁用: ${input.banned.join(",")}` : "";
    const pool = input.pool && input.pool.length
        ? `只能从候选池选: [${input.pool.join(",")}]`
        : "";
    if (input.mode === "hanzi") {
        return [
            ANTI_INTERFERENCE_RULE,
            GRID_OUTPUT_RULE,
            `只找汉字「${input.label}」（第${input.index}/${input.total}处；若题干有多个相同字，找尚未占用的那一处）。`,
            "字可在插画上；无字卡通勿点。",
            pool,
            ban,
            "禁止think。只输出JSON: " + `{"char":"${input.label}","grid":"C3"}`,
        ]
            .filter(Boolean)
            .join("\n");
    }
    return [
        ANTI_INTERFERENCE_RULE,
        GRID_OUTPUT_RULE,
        `找题干第${input.index}/${input.total}枚目标图标（见第一张模板小图）。`,
        "在主图候选格中找与模板【外形轮廓】最像的一格。忽略卡通人物。",
        pool,
        ban,
        "禁止think。只输出JSON: " + `{"char":"${input.label}","grid":"C3"}`,
    ]
        .filter(Boolean)
        .join("\n");
}
function isReasoningOnlyNoGrids(raw) {
    const hasGridAssign = /["']?grid["']?\s*:\s*["']?[A-Ja-j][0-9]/.test(raw);
    const hasAt = /[\u4e00-\u9fffA-Za-z0-9]\s*[@＠]\s*[A-Ja-j][0-9]/.test(raw);
    const hasProseGrid = /(?:at|in|on|位于|在)\s*(?:grid|cell|格)?\s*[A-Ja-j][0-9]/i.test(raw) ||
        /[A-Ja-j][0-9]\s*(?:is|->|→)/i.test(raw);
    const hasDetectedArr = /detected_text_grids["']?\s*:\s*\[[^\]]*["']?[A-Ja-j][0-9]/i.test(raw);
    if (hasGridAssign || hasAt || hasProseGrid || hasDetectedArr)
        return false;
    return (/<think>|我们需要|需要回答|Need (?:to )?answer|必须只输出|工业级|分析图片|solve CAPTCHA|Let me (?:identify|analyze|locate)/i.test(raw) || raw.trim().length < 8);
}
/** 独占门禁：任意两步不得同格（含重复字） */
function assertExclusiveGrids(seq) {
    const seen = new Map();
    const conflictIdx = [];
    for (let i = 0; i < seq.length; i++) {
        const g = seq[i]?.grid;
        if (!g) {
            conflictIdx.push(i);
            continue;
        }
        const prev = seen.get(g);
        if (prev != null) {
            conflictIdx.push(i);
            if (!conflictIdx.includes(prev))
                conflictIdx.push(prev);
        }
        else {
            seen.set(g, i);
        }
    }
    if (conflictIdx.length) {
        return {
            ok: false,
            reason: `格号冲突（同格被多次占用）: ${[...new Set(conflictIdx)]
                .map((i) => `${seq[i]?.char}@${seq[i]?.grid}`)
                .join(",")}`,
            conflictIdx: [...new Set(conflictIdx)].sort((a, b) => a - b),
        };
    }
    return { ok: true, reason: "", conflictIdx: [] };
}
function extractDetectedOnly(raw, grid) {
    const body = afterThink(raw).trim() || raw.trim();
    for (const src of [body, raw]) {
        const parsed = tryParseJsonBlob(src);
        if (parsed) {
            const d = collectDetectedGrids(parsed, grid);
            if (d.length)
                return d;
        }
        const salvaged = salvageDetectedGridsFromText(src, grid);
        if (salvaged.length)
            return salvaged;
    }
    return [];
}
async function callVisionGridOnce(input) {
    const runOnce = async (forceJson) => {
        const baseReq = {
            model: input.model,
            temperature: 0,
            // 思考模型会先烧 think token；500 会导致截断无 JSON
            max_tokens: 2048,
            messages: [
                {
                    role: "system",
                    content: "Output one JSON object only. No <think>, no analysis. First character must be {. Never return pixel (x,y). Only grid ids like C4. Ignore thin crossing lines, speckles, background patterns; focus on solid strokes/shapes.",
                },
                { role: "user", content: input.content },
            ],
        };
        if (forceJson) {
            baseReq.response_format = { type: "json_object" };
        }
        try {
            return await input.client.chat.completions.create(baseReq, input.signal ? { signal: input.signal } : undefined);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (forceJson && /response_format|json_object|not support/i.test(msg)) {
                delete baseReq.response_format;
                return await input.client.chat.completions.create(baseReq, input.signal ? { signal: input.signal } : undefined);
            }
            throw err;
        }
    };
    let resp = await runOnce(input.forceJson !== false);
    let raw = extractVisionText(resp);
    // parseGrid=false：SoM 选号只回序号，不做格号解析、也不因「无格号」触发重问
    const parseGrid = input.parseGrid !== false;
    let result = parseGrid
        ? extractGridVisionResult(raw, input.grid, input.logger, input.preferChars)
        : null;
    // 纯 think / 空 JSON：去掉 json_object 再逼一次
    if (parseGrid && (!result?.sequence.length || isReasoningOnlyNoGrids(raw)) &&
        input.forceJson !== false) {
        input.logger.warn("point_select_vision_retry_no_json_format", {
            head: raw.slice(0, 120),
        });
        const nudge = [
            ...input.content,
            {
                type: "text",
                text: 'STOP thinking. Reply with JSON only, e.g. {"sequence":[{"char":"也","grid":"C3"}]}',
            },
        ];
        const baseReq = {
            model: input.model,
            temperature: 0,
            max_tokens: 2048,
            messages: [
                {
                    role: "system",
                    content: "JSON only. No think tags.",
                },
                { role: "user", content: nudge },
            ],
        };
        resp = await input.client.chat.completions.create(baseReq, input.signal ? { signal: input.signal } : undefined);
        raw = extractVisionText(resp);
        result = extractGridVisionResult(raw, input.grid, input.logger, input.preferChars);
    }
    return { result, rawHead: raw.slice(0, 320), rawFull: raw };
}
function buildVisionUserContent(input) {
    // 图在前：减少模型复述长指令
    const content = [
        {
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${input.imageB64}`,
                detail: "high",
            },
        },
        { type: "text", text: input.prompt },
    ];
    if (input.tipB64) {
        content.push({
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${input.tipB64}`,
                detail: "high",
            },
        });
        content.push({
            type: "text",
            text: "上图=主图；本题干条=第二张图（只读顺序，勿对题干条报格）。",
        });
    }
    return content;
}
/** 仅题干条一张图：读从左到右顺序 */
function buildTipOnlyContent(prompt, tipB64) {
    return [
        {
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${tipB64}`,
                detail: "high",
            },
        },
        { type: "text", text: prompt },
    ];
}
/** 题干条 LTR：仅无逐枚模板小图时的弱回退；优先模板对照 */
function buildTipOrderPrompt() {
    return [
        "这张图是验证码的题干条。请先判断它属于哪一类：",
        "A) 一行并排的若干【目标图标】本身 → kind=icons",
        "B) 一句【说明文字】，用自然语言描述要点什么 → kind=text",
        ANTI_INTERFERENCE_RULE,
        "若是 A：按【从左到右】为每个目标写一句外形描述（按图实写，勿套词表）。",
        "若是 B：逐字照抄图上文字（instruction），并判断这句话要求点击【几个】目标（count）。",
        "关键：说明文字里提到的物体可能只是【参照物】。例如「点红色三角形左边的圆形」，",
        "文字提到了红色三角形，但要点的只有圆形 —— count 只数【要求点击】的目标个数，",
        "绝不可把参照物算成目标。",
        "禁止think。只输出JSON，二选一：",
        '{"kind":"icons","targets":[{"shape":"描述甲"},{"shape":"描述乙"}]}',
        '{"kind":"text","instruction":"照抄的题目文字","count":1}',
    ].join("\n");
}

/**
 * 题干条读取结果。
 * kind=icons 时 targets 是逐个目标外形；kind=text 时 targets 必须为空
 * （文字型题干的「目标是什么」要留给语义推理，绝不在此处编造目标清单）。
 */
type TipReading = {
    kind: "icons" | "text" | "unknown";
    targets: string[];
    instruction: string;
    /** 文字型题干要求点击的目标个数；0 = 未知 */
    count: number;
};

const EMPTY_TIP_READING: TipReading = {
    kind: "unknown",
    targets: [],
    instruction: "",
    count: 0,
};

export function extractTipReading(raw) {
    const body = afterThink(String(raw ?? "")).trim();
    for (const src of [body, String(raw ?? "")]) {
        const parsed = tryParseJsonBlob(src);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            continue;
        const o = parsed;
        const kind = String(o.kind ?? o.type ?? o.mode ?? "").trim().toLowerCase();
        const instruction = String(o.instruction ?? o.text ?? o.desc ?? o.prompt ?? "")
            .replace(/\s+/g, " ")
            .trim();
        const countRaw = Number(o.count);
        const count = Number.isFinite(countRaw) && countRaw >= 1 && countRaw <= 8
            ? Math.floor(countRaw)
            : 0;
        if (kind === "text" || (instruction && !Array.isArray(o.targets))) {
            return { kind: "text", targets: [], instruction, count };
        }
        const targets = extractTipTargets(src);
        if (targets.length)
            return { kind: "icons", targets, instruction, count: 0 };
        if (kind === "icons")
            return { ...EMPTY_TIP_READING, kind: "unknown" };
    }
    return EMPTY_TIP_READING;
}

function isPlaceholderShapeLabel(label) {
    const s = String(label ?? "").trim();
    if (!s)
        return true;
    if (/^<?外形\d+>?$/u.test(s))
        return true;
    if (/^[Tt]\d+$/.test(s))
        return false;
    if (/^描述[甲乙丙丁戊己庚辛]$/u.test(s))
        return true;
    if (/^<.*>$/.test(s))
        return true;
    return false;
}

/** 丢掉标签尾缀噪声，只留外形描述 */
function stripIconColorNoise(label) {
    let s = String(label ?? "").trim();
    if (!s)
        return "";
    s = s.replace(/[·・•].+$/, "").trim();
    s = s
        .replace(
            /(?:淡|深|亮|暗)?(?:粉红|玫红|洋红|黄绿|褐绿|青绿|橙黄|紫红|天蓝|灰蓝|灰紫|绿|红|粉|紫|蓝|黄|褐|橙|黑|白|青|灰|金|银|棕)+$/u,
            "",
        )
        .trim();
    if (/^(?:淡|深|亮|暗)?(?:粉红|玫红|灰蓝|黄绿|褐绿|绿|红|粉|紫|蓝|黄|褐|橙|黑|白|青|灰)$/u.test(s)) {
        return "";
    }
    if (isPlaceholderShapeLabel(s))
        return "";
    return s;
}

/** 图标标签：只用形状 */
function formatIconTargetLabel(shape, _color) {
    return stripIconColorNoise(shape);
}

function extractTipTargets(raw) {
    const body = afterThink(raw).trim() || raw.trim();
    for (const src of [body, raw]) {
        const parsed = tryParseJsonBlob(src);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const o = parsed;
            const arr = o.targets ?? o.order ?? o.icons ?? o.items;
            if (Array.isArray(arr)) {
                const out = [];
                for (const it of arr) {
                    if (it && typeof it === "object") {
                        const shape = String(it.shape ?? it.form ?? it.kind ?? "").trim();
                        const legacy = String(it.desc ?? it.text ?? it.label ?? "").trim();
                        const label = formatIconTargetLabel(shape || legacy);
                        if (label)
                            out.push(label);
                    }
                    else {
                        const s = stripIconColorNoise(String(it ?? "").trim());
                        if (s)
                            out.push(s);
                    }
                }
                if (out.length)
                    return out;
            }
            const count = Number(o.count);
            if (Number.isFinite(count) && count >= 2 && count <= 8) {
                return Array.from({ length: Math.floor(count) }, (_, i) => `T${i + 1}`);
            }
        }
    }
    return [];
}

/** 主图 + 多枚题干模板小图：按模板外形匹配格号 */
function buildTemplateMatchContent(input) {
    const pool = input.pool.join(",");
    const ban = input.bannedGrids.length
        ? `禁用格: ${input.bannedGrids.join(",")}`
        : "";
    const content = [];
    for (let i = 0; i < input.tipIcons.length; i++) {
        content.push({
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${input.tipIcons[i]}`,
                detail: "high",
            },
        });
        content.push({
            type: "text",
            text: `以上=题干第${i + 1}枚目标模板（从左到右第${i + 1}个，完整答案小图）。`,
        });
    }
    content.push({
        type: "image_url",
        image_url: {
            url: `data:image/jpeg;base64,${input.imageB64}`,
            detail: "high",
        },
    });
    content.push({
        type: "text",
        text: [
            `最后一张=主图，已叠${input.grid.cols}x${input.grid.rows}格(${input.grid.colLabels[0]}-${input.grid.colLabels[input.grid.cols - 1]} / 0-${input.grid.rows - 1})。`,
            ANTI_INTERFERENCE_RULE,
            GRID_OUTPUT_RULE,
            `候选格池（只能从中选）: [${pool}]`,
            `共${input.tipIcons.length}枚模板。按模板顺序，在主图中找外形轮廓最像的格（填色深浅可不同，只比外形）。`,
            "忽略卡通人物。每格只能用一次。禁止think。只输出JSON：",
            `{"match":[{"target":0,"grid":"C7"},{"target":1,"grid":"F2"},{"target":2,"grid":"G1"}]}`,
            "target=模板下标(0起)。禁止像素坐标。",
            ban,
        ]
            .filter(Boolean)
            .join("\n"),
    });
    return content;
}

/** 无模板时的弱匹配（整条 tip） */
function buildIconMatchPrompt(input) {
    const pool = input.pool.join(",");
    const ban = input.bannedGrids.length
        ? `禁用格: ${input.bannedGrids.join(",")}`
        : "";
    return [
        `主图已叠${input.grid.cols}x${input.grid.rows}格(${input.grid.colLabels[0]}-${input.grid.colLabels[input.grid.cols - 1]} / 0-${input.grid.rows - 1})，宽${input.grid.imageWidth}高${input.grid.imageHeight}。`,
        ANTI_INTERFERENCE_RULE,
        GRID_OUTPUT_RULE,
        `候选图标格池（只能从中选）: [${pool}]`,
        "第二张图是题干条：按【从左到右】把每个图标外形映射到主图格号。",
        "【硬规则】对照题干条里每个图标的外形轮廓，在候选格中找外形最像的。",
        "按图实比，不要套用固定形状词表。忽略卡通人物。每格只能用一次。",
        ban,
        "禁止think。只输出JSON：",
        `{"match":[{"target":0,"grid":"C7"},{"target":1,"grid":"F2"},{"target":2,"grid":"G1"}]}`,
        "target 是题干下标(0起)。禁止像素坐标。",
    ]
        .filter(Boolean)
        .join("\n");
}
function extractIconMatch(raw, grid) {
    const body = afterThink(raw).trim() || raw.trim();
    for (const src of [body, raw]) {
        const parsed = tryParseJsonBlob(src);
        if (!parsed)
            continue;
        const arr = Array.isArray(parsed)
            ? parsed
            : parsed.match ??
                parsed.sequence;
        if (!Array.isArray(arr))
            continue;
        const out = [];
        for (const it of arr) {
            if (!it || typeof it !== "object")
                continue;
            const o = it;
            const id = parseGridId(String(o.grid ?? o.cell ?? ""), grid);
            if (!id)
                continue;
            const target = Number(o.target ?? o.index ?? 0);
            out.push({ target: Number.isFinite(target) ? target : 0, grid: id.id });
        }
        if (out.length)
            return out;
    }
    return [];
}
/** 顺序核验：题干条 vs 拟点击序列是否 LTR 一致 */
function buildOrderVerifyPrompt(input) {
    const orderLine = input.targets
        .map((t, i) => `${i + 1}. ${t}`)
        .join(" → ");
    const clickLine = input.seqGrids
        .map((g, i) => `第${i + 1}个点 ${g}`)
        .join("；");
    return [
        "第一张图=主图(已叠格)，第二张图=题干条。",
        `题干条从左到右的目标顺序是：${orderLine}`,
        `我当前打算按此顺序点击主图格号：${clickLine}`,
        "请核对：这些格的图标【外形轮廓】是否与题干条从左到右一致。",
        "只比外形（尖角/放射/几何轮廓），不要比其它属性。",
        '若一致只输出 {"order_ok":true}。',
        '若不一致输出 {"order_ok":false,"fixed":[{"target":0,"grid":"D2"},...]}，target 为目标下标(0起)，grid 为正确格号。',
        "禁止think。",
    ].join("\n");
}
function extractOrderVerify(raw, grid) {
    const body = afterThink(raw).trim() || raw.trim();
    for (const src of [body, raw]) {
        const parsed = tryParseJsonBlob(src);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            continue;
        const o = parsed;
        const hasFlag = o.order_ok != null || o.orderOk != null || o.ok != null;
        if (!hasFlag)
            continue;
        const orderOk = o.order_ok === true || o.orderOk === true || o.ok === true;
        const fixed = [];
        const farr = o.fixed ?? o.sequence ?? o.match;
        if (Array.isArray(farr)) {
            for (const it of farr) {
                if (!it || typeof it !== "object")
                    continue;
                const io = it;
                const id = parseGridId(String(io.grid ?? io.cell ?? ""), grid);
                if (!id)
                    continue;
                const target = Number(io.target ?? io.index ?? 0);
                fixed.push({ target: Number.isFinite(target) ? target : 0, grid: id.id });
            }
        }
        return { orderOk, parsed: true, fixed };
    }
    return { orderOk: false, parsed: false, fixed: [] };
}
/** 只读题干条 LTR 顺序；读不到则回退通用序号（后续核验兜底） */
async function readTipReading(input) {
    if (!input.tipB64) {
        // 无题干条小图：不编造目标清单（旧代码在此凭空返回 ["1","2","3"]，
        // 会把 expectN 钉死成 3，文字型题干必然点错）
        return EMPTY_TIP_READING;
    }
    for (let i = 0; i < 2; i++) {
        const resp = await callVisionGridOnce({
            client: input.client,
            model: input.model,
            content: buildTipOnlyContent(buildTipOrderPrompt(), input.tipB64),
            signal: input.signal,
            grid: input.grid,
            logger: input.logger,
        });
        const reading = extractTipReading(resp.rawFull);
        if (reading.kind === "icons" && reading.targets.length >= 2) {
            input.logger.agentProgress(`题干条读序：${reading.targets.join(" → ")}`, {
                phase: "point_select_captcha",
                stage: "icon_tip_order",
                targets: reading.targets,
            });
            return reading;
        }
        if (reading.kind === "text" && (reading.instruction || reading.count > 0)) {
            input.logger.agentProgress(`题干条是说明文字，改按语义定位：${reading.instruction.slice(0, 40)}（要点 ${reading.count || "?"} 个）`, {
                phase: "point_select_captcha",
                stage: "icon_tip_text",
                instruction: reading.instruction,
                count: reading.count,
            });
            return reading;
        }
    }
    input.logger.agentProgress("题干条未能判读，交回主流程按语义定位", {
        phase: "point_select_captcha",
        stage: "icon_tip_order_fallback",
    });
    return EMPTY_TIP_READING;
}
/** 图标：模板小图优先 → 轮廓 Dice → VLM 模板对照 → 逐枚兜底 */
async function bindIconSequence(input) {
    const n = input.targets.length;
    const tipIcons = Array.isArray(input.tipIcons) ? input.tipIcons.filter(Boolean) : [];
    const assemble = (matches) => {
        const seq = [];
        const used = new Set();
        for (let i = 0; i < n; i++) {
            const m = matches.find((mm) => mm.target === i);
            if (!m || input.banned.has(m.grid) || used.has(m.grid))
                return null;
            seq.push({ char: input.targets[i], grid: m.grid });
            used.add(m.grid);
        }
        return seq.length === n ? seq : null;
    };
    const doLocalTemplate = async () => {
        if (!input.page || tipIcons.length < n)
            return null;
        const matches = [];
        const used = new Set();
        for (let i = 0; i < n; i++) {
            const ranked = await rankGridsByTipSilhouette(
                input.page,
                input.cleanB64 || input.imageB64,
                tipIcons[i],
                input.grid,
                input.pool.filter((g) => !input.banned.has(g) && !used.has(g)),
            );
            const best = ranked.find((r) => r.score >= 0.22);
            if (!best)
                return null;
            matches.push({ target: i, grid: best.grid });
            used.add(best.grid);
            input.logger.agentProgress(
                `模板轮廓匹配 T${i + 1}→${best.grid}（score=${best.score.toFixed(2)}）`,
                {
                    phase: "point_select_captcha",
                    stage: "tip_silhouette",
                    target: i,
                    grid: best.grid,
                    score: best.score,
                },
            );
        }
        return assemble(matches);
    };
    const doMatch = async () => {
        if (tipIcons.length >= n) {
            const match = await callVisionGridOnce({
                client: input.client,
                model: input.model,
                content: buildTemplateMatchContent({
                    tipIcons: tipIcons.slice(0, n),
                    imageB64: input.imageB64,
                    grid: input.grid,
                    pool: input.pool,
                    bannedGrids: [...input.banned],
                }),
                signal: input.signal,
                grid: input.grid,
                logger: input.logger,
            });
            return extractIconMatch(match.rawFull, input.grid);
        }
        const match = await callVisionGridOnce({
            client: input.client,
            model: input.model,
            content: buildVisionUserContent({
                prompt: buildIconMatchPrompt({
                    grid: input.grid,
                    pool: input.pool,
                    targets: input.targets,
                    bannedGrids: [...input.banned],
                }),
                imageB64: input.imageB64,
                tipB64: input.tipB64,
            }),
            signal: input.signal,
            grid: input.grid,
            logger: input.logger,
        });
        return extractIconMatch(match.rawFull, input.grid);
    };
    const doVerify = async (seq) => {
        const v = await callVisionGridOnce({
            client: input.client,
            model: input.model,
            content: tipIcons.length >= n
                ? buildTemplateMatchContent({
                    tipIcons: tipIcons.slice(0, n),
                    imageB64: input.imageB64,
                    grid: input.grid,
                    pool: seq.map((s) => s.grid),
                    bannedGrids: [],
                }).concat([
                    {
                        type: "text",
                        text: `请核对拟点击顺序 ${seq.map((s) => s.grid).join("→")} 是否与模板1..${n}外形一致。一致输出 {"order_ok":true}，否则 {"order_ok":false,"fixed":[...]}。禁止think。`,
                    },
                ])
                : buildVisionUserContent({
                    prompt: buildOrderVerifyPrompt({
                        targets: input.targets,
                        seqGrids: seq.map((s) => s.grid),
                    }),
                    imageB64: input.imageB64,
                    tipB64: input.tipB64,
                }),
            signal: input.signal,
            grid: input.grid,
            logger: input.logger,
        });
        return extractOrderVerify(v.rawFull, input.grid);
    };

    // 1) 有题干模板：优先 VLM 多图对照（轮廓 Dice 易错配顺序，仅作回退）
    let seq = null;
    if (tipIcons.length >= n) {
        const matches = await doMatch();
        seq = assemble(matches);
        if (seq) {
            input.logger.agentProgress("题干模板 VLM 对照匹配成功", {
                phase: "point_select_captcha",
                stage: "tip_vlm_ok",
                seq: seq.map((s) => `${s.char}@${s.grid}`),
            });
        }
    }
    if (!seq) {
        seq = await doLocalTemplate();
        if (seq) {
            input.logger.agentProgress("题干模板轮廓本地匹配（回退）", {
                phase: "point_select_captcha",
                stage: "tip_silhouette_fallback",
                seq: seq.map((s) => `${s.char}@${s.grid}`),
            });
        }
    }
    if (!seq) {
        let matches = tipIcons.length >= n ? [] : await doMatch();
        if (!tipIcons.length)
            seq = assemble(matches);
        if (!seq) {
            input.logger.agentProgress("图标批量匹配失败，改逐个定位…", {
                phase: "point_select_captcha",
                stage: "icon_match_fallback",
            });
            const per = await locateCharsOneByOne({
                client: input.client,
                model: input.model,
                imageB64: input.imageB64,
                cleanB64: input.cleanB64 || input.imageB64,
                tipB64: input.tipB64,
                tipIcons,
                page: input.page,
                grid: input.grid,
                labels: input.targets,
                mode: "icon",
                banned: input.banned,
                pool: input.pool,
                signal: input.signal,
                logger: input.logger,
                preferVlm: true,
            });
            if (!per || per.sequence.length !== n)
                return null;
            seq = per.sequence;
        }
        if (input.pool.slice(0, n).join(",") === seq.map((s) => s.grid).join(",")) {
            input.logger.agentProgress("图标绑定疑似贴候选池前缀，重匹配一次…", {
                phase: "point_select_captcha",
                stage: "icon_pool_prefix",
            });
            matches = await doMatch();
            const retried = assemble(matches);
            if (retried)
                seq = retried;
        }
    }

    let v = await doVerify(seq);
    if (!v.parsed) {
        input.logger.agentProgress("顺序核验模型未给明确判定，接受匹配结果", {
            phase: "point_select_captcha",
            stage: "icon_verify_inconclusive",
        });
        return seq;
    }
    if (v.orderOk)
        return seq;
    const fixedSeq = assemble(v.fixed);
    if (fixedSeq) {
        const v2 = await doVerify(fixedSeq);
        if (!v2.parsed || v2.orderOk)
            return fixedSeq;
    }
    const per = await locateCharsOneByOne({
        client: input.client,
        model: input.model,
        imageB64: input.imageB64,
        cleanB64: input.cleanB64 || input.imageB64,
        tipB64: input.tipB64,
        tipIcons,
        page: input.page,
        grid: input.grid,
        labels: input.targets,
        mode: "icon",
        banned: input.banned,
        pool: input.pool,
        signal: input.signal,
        logger: input.logger,
        preferVlm: true,
    });
    if (!per || per.sequence.length !== n)
        return null;
    v = await doVerify(per.sequence);
    if (!v.parsed || v.orderOk)
        return per.sequence;
    return null;
}
/** 独占绑定失败时：对冲突/缺项逐个问格号（强制避开已占用） */
async function locateCharsOneByOne(input) {
    if (input.labels.length < 1)
        return null;
    const tipIcons = Array.isArray(input.tipIcons) ? input.tipIcons.filter(Boolean) : [];
    const sequence = [];
    const detected = [];
    const used = new Set();
    for (let i = 0; i < input.labels.length; i++) {
        const label = input.labels[i];
        const bannedList = [...input.banned, ...used];
        const remainPool = (input.pool || []).filter((g) => !bannedList.includes(g));
        const tipIcon = tipIcons[i];
        const preferVlm = input.preferVlm !== false;
        // 有模板：默认先 VLM 对照；轮廓 Dice 仅作回退（易错配顺序）
        const trySilhouette = async () => {
            if (!(input.mode === "icon" && tipIcon && input.page))
                return null;
            const ranked = await rankGridsByTipSilhouette(
                input.page,
                input.cleanB64 || input.imageB64,
                tipIcon,
                input.grid,
                remainPool.length ? remainPool : input.pool || [],
            );
            const best = ranked.find((r) => r.score >= 0.22 && !used.has(r.grid));
            return best || null;
        };
        if (!preferVlm) {
            const best = await trySilhouette();
            if (best) {
                input.logger.agentProgress(
                    `③′ 模板轮廓定位 T${i + 1}→${best.grid}（score=${best.score.toFixed(2)}）`,
                    {
                        phase: "point_select_captcha",
                        stage: "vision_per_char_silhouette",
                        index: i + 1,
                        grid: best.grid,
                        score: best.score,
                    },
                );
                sequence.push({ char: label, grid: best.grid });
                detected.push(best.grid);
                used.add(best.grid);
                continue;
            }
        }
        const prompt = buildPerTargetPrompt({
            label,
            index: i + 1,
            total: input.labels.length,
            mode: input.mode,
            banned: bannedList,
            pool: remainPool.length ? remainPool : input.pool,
        });
        input.logger.agentProgress(`③′ 独占定位「${label}」（${i + 1}/${input.labels.length}）…`, {
            phase: "point_select_captcha",
            stage: "vision_per_char",
            char: label,
            index: i + 1,
        });
        const content = tipIcon
            ? [
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${tipIcon}`,
                        detail: "high",
                    },
                },
                {
                    type: "text",
                    text: `以上=题干第${i + 1}枚目标模板。下面主图中找外形最像的格。`,
                },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${input.imageB64}`,
                        detail: "high",
                    },
                },
                { type: "text", text: prompt },
            ]
            : buildVisionUserContent({
                prompt,
                imageB64: input.imageB64,
                tipB64: input.tipB64,
            });
        const one = await callVisionGridOnce({
            client: input.client,
            model: input.model,
            content,
            signal: input.signal,
            grid: input.grid,
            logger: input.logger,
            preferChars: [label],
        });
        let pick = one.result?.sequence.find((s) => s.char === label) ??
            one.result?.sequence[0];
        if (!pick) {
            const salvaged = salvageSequenceFromText(one.rawFull, input.grid, [
                label,
            ]);
            pick = salvaged.find((s) => s.char === label) ?? salvaged[0];
        }
        if (!pick) {
            const lone = /["']?grid["']?\s*:\s*["']([A-Ja-j][0-9])["']/.exec(one.rawFull);
            if (lone?.[1]) {
                const id = parseGridId(lone[1], input.grid);
                if (id)
                    pick = { char: label, grid: id.id };
            }
        }
        if (!pick ||
            input.banned.has(pick.grid) ||
            used.has(pick.grid) ||
            (remainPool.length > 0 && !remainPool.includes(pick.grid))) {
            // VLM 失败再试轮廓
            const best = await trySilhouette();
            if (best) {
                input.logger.agentProgress(
                    `③′ VLM 未中，轮廓回退 T${i + 1}→${best.grid}（score=${best.score.toFixed(2)}）`,
                    {
                        phase: "point_select_captcha",
                        stage: "vision_per_char_silhouette_fallback",
                        index: i + 1,
                        grid: best.grid,
                        score: best.score,
                    },
                );
                sequence.push({ char: label, grid: best.grid });
                detected.push(best.grid);
                used.add(best.grid);
                continue;
            }
            input.logger.agentProgress(`「${label}」独占定位失败`, {
                phase: "point_select_captcha",
                stage: "vision_per_char_fail",
                char: label,
                raw: one.rawHead.slice(0, 120),
            });
            return null;
        }
        sequence.push({ char: label, grid: pick.grid });
        detected.push(pick.grid);
        used.add(pick.grid);
    }
    return { detectedTextGrids: detected, sequence };
}
async function filterPoolByInk(input) {
    const ok = [];
    const banned = [];
    const kind = input.mode === "icon" ? "shape" : "glyph";
    for (const g of input.pool) {
        const center = gridIdToCenter(g, input.grid);
        if (!center) {
            banned.push(g);
            continue;
        }
        const refined = await refineInkCentroid(input.page, input.cleanB64, center, inkHalfForCell(input.grid.cellWidth, input.grid.cellHeight), kind);
        if (refined.blank || refined.lineNoiseLikely) {
          banned.push(g);
          if (refined.lineNoiseLikely) {
                input.logger.agentProgress(`普查过滤：${g} 疑似线噪无主体`, {
                    phase: "point_select_captcha",
                    stage: "survey_line_noise",
                    grid: g,
                    mode: input.mode,
                });
            }
            continue;
        }
        // 仅汉字模式拒暖色插画；图标目标本身常是红/橙/黄，绝不能当插画杀掉
        if (input.mode === "hanzi" && refined.illustrationLikely) {
            banned.push(g);
            input.logger.agentProgress(`普查过滤：${g} 疑似无字插画`, {
                phase: "point_select_captcha",
                stage: "survey_filter",
                grid: g,
            });
            continue;
        }
        ok.push(g);
    }
    return { ok, banned };
}
async function healBlankWithNeighbors(input) {
    const points = input.points.slice();
    const sequence = input.sequence.map((s) => ({ ...s }));
    const stillBlank = [];
    const poolPrefer = new Set(input.detectedPool);
    const kind = input.mode === "icon" ? "shape" : "glyph";
    const occupied = new Set(sequence.map((s, idx) => (input.blankIdx.includes(idx) ? "" : s.grid)).filter(Boolean));
    for (const i of input.blankIdx) {
        const item = sequence[i];
        if (!item) {
            stillBlank.push(i);
            continue;
        }
        input.banned.add(item.grid);
        const neigh = neighborGridIds(item.grid, input.grid, 2);
        const candidates = neigh
            .filter((g) => !input.banned.has(g) && !occupied.has(g))
            .sort((a, b) => {
            const ap = poolPrefer.has(a) ? 0 : 1;
            const bp = poolPrefer.has(b) ? 0 : 1;
            return ap - bp;
        });
        let healed = false;
        for (const cand of candidates) {
            const center = gridIdToCenter(cand, input.grid);
            if (!center)
                continue;
            const refined = await refineInkCentroid(input.page, input.cleanB64, center, inkHalfForCell(input.grid.cellWidth, input.grid.cellHeight), kind);
            if (refined.blank ||
                refined.lineNoiseLikely ||
                (input.mode === "hanzi" && refined.illustrationLikely)) {
                input.banned.add(cand);
                continue;
            }
            sequence[i] = { char: item.char, grid: cand };
            points[i] = refined.point;
            occupied.add(cand);
            healed = true;
            input.logger.agentProgress(`「${item.char}」自愈：${item.grid}(空) → ${cand} 吸附 (${Math.round(refined.point.x)},${Math.round(refined.point.y)})`, {
                phase: "point_select_captcha",
                stage: "grid_heal",
                from: item.grid,
                to: cand,
                char: item.char,
            });
            break;
        }
        if (!healed)
            stillBlank.push(i);
    }
    return { points, blankIdx: stillBlank, sequence };
}
async function mapSequenceToPixels(input) {
    const points = [];
    const blankIdx = [];
    const kind = input.mode === "icon" ? "shape" : "glyph";
    for (let i = 0; i < input.sequence.length; i++) {
        const item = input.sequence[i];
        if (input.banned.has(item.grid)) {
            input.logger.agentProgress(`格 ${item.grid}「${item.char}」已在禁用表，跳过盲点`, {
                phase: "point_select_captcha",
                stage: "grid_banned",
                grid: item.grid,
                char: item.char,
            });
            blankIdx.push(i);
            points.push({ x: 0, y: 0 });
            continue;
        }
        const center = gridIdToCenter(item.grid, input.grid);
        if (!center) {
            input.logger.warn("point_select_bad_grid_id", {
                grid: item.grid,
                char: item.char,
            });
            input.banned.add(item.grid);
            blankIdx.push(i);
            points.push({ x: 0, y: 0 });
            continue;
        }
        input.logger.agentProgress(`格号 ${item.grid}「${item.char}」→ 格心 (${Math.round(center.x)},${Math.round(center.y)})，${input.mode === "icon" ? "色块" : "墨迹"}吸附中…`, {
            phase: "point_select_captcha",
            stage: "grid_ink",
            grid: item.grid,
            char: item.char,
            mode: input.mode,
        });
        const refined = await refineInkCentroid(input.page, input.cleanB64, center, inkHalfForCell(input.grid.cellWidth, input.grid.cellHeight), kind);
        // 汉字：暖色插画禁用；图标：暖色就是目标，不禁
        if (input.mode === "hanzi" && refined.illustrationLikely) {
            input.logger.agentProgress(`格 ${item.grid}「${item.char}」疑似插画暖色块，当作干扰禁用`, {
                phase: "point_select_captcha",
                stage: "grid_illustration",
                grid: item.grid,
                char: item.char,
            });
            input.banned.add(item.grid);
            blankIdx.push(i);
            points.push(center);
            continue;
        }
        if (refined.blank || refined.lineNoiseLikely) {
            input.logger.agentProgress(`格 ${item.grid}「${item.char}」局部无有效主体（空白/线噪），不盲点`, {
                phase: "point_select_captcha",
                stage: "grid_blank",
                grid: item.grid,
                char: item.char,
                lineNoise: Boolean(refined.lineNoiseLikely),
            });
            input.banned.add(item.grid);
            blankIdx.push(i);
            points.push(center);
            continue;
        }
        points.push(refined.point);
        input.logger.agentProgress(`「${item.char}」${item.grid} 吸附后 (${Math.round(refined.point.x)},${Math.round(refined.point.y)}) Δ(${refined.dx.toFixed(1)},${refined.dy.toFixed(1)})`, {
            phase: "point_select_captcha",
            stage: "grid_refine_ok",
            char: item.char,
            grid: item.grid,
        });
    }
    return { points, blankIdx };
}
/** Stage2.5：逐格核验失败项从剩余池独占重绑；仍失败返回 null */
async function rebindAfterCellMismatch(input) {
    const { mismatchIdx, sequence, labels, pool, banned } = input;
    for (const i of mismatchIdx) {
        if (sequence[i])
            banned.add(sequence[i].grid);
    }
    const occupied = new Set(sequence.filter((_, i) => !mismatchIdx.includes(i)).map((s) => s.grid));
    const fixLabels = mismatchIdx.map((i) => labels[i] ?? sequence[i].char);
    const per = await locateCharsOneByOne({
        client: input.client,
        model: input.model,
        imageB64: input.imageB64,
        cleanB64: input.cleanB64,
        tipB64: input.tipB64,
        tipIcons: input.tipIcons,
        page: input.page,
        grid: input.grid,
        labels: fixLabels,
        mode: input.mode,
        banned: new Set([...banned, ...occupied]),
        pool: pool.filter((g) => !occupied.has(g) && !banned.has(g)),
        signal: input.signal,
        logger: input.logger,
        preferVlm: true,
    });
    if (!per || per.sequence.length !== fixLabels.length)
        return null;
    let pi = 0;
    const next = sequence.slice();
    for (const i of mismatchIdx) {
        next[i] = {
            char: labels[i] ?? fixLabels[pi],
            grid: per.sequence[pi].grid,
        };
        pi += 1;
    }
    const rebuilt = next.map((s, i) => ({
        char: labels[i] ?? s.char,
        grid: s.grid,
    }));
    if (!assertExclusiveGrids(rebuilt).ok)
        return null;
    const mismatch2 = await findMismatchedCellIndexes({
        client: input.client,
        model: input.model,
        page: input.page,
        cleanB64: input.cleanB64,
        grid: input.grid,
        sequence: rebuilt,
        signal: input.signal,
        logger: input.logger,
        strict: input.mode === "icon" && !(input.tipIcons && input.tipIcons.length),
        mode: input.mode,
        tipIcons: input.tipIcons,
    });
    if (mismatch2.length) {
        for (const i of mismatch2) {
            if (rebuilt[i])
                banned.add(rebuilt[i].grid);
        }
        input.logger.agentProgress(`重绑后逐格仍未通过，本轮作废`, {
            phase: "point_select_captcha",
            stage: "cell_verify_fail",
            mismatch2,
        });
        return null;
    }
    return rebuilt;
}
/**
 * SoM 选号 Prompt：把定位变成**闭集分类**（在已编号的框里选），
 * 而不是让模型做像素/比例回归 —— 这是动态标记成功率高的根本原因。
 *
 * 语义要点：题目可能直接描述目标，也可能用「另一个物体」当参照物
 * （如「A 左边的 B」「不是 A 的那个」）。参照物本身不是答案。
 * 这里只做通用约束，不硬编码任何方位词/颜色词/名词。
 */
export type MarkSelectPromptInput = {
    labels: string[];
    markCount: number;
    mode: "hanzi" | "icon";
    /** 题干原文（DOM 或题干条读出）；有则优先按它推理 */
    instruction?: string;
    /** 已知要点个数；0 = 未知，由模型自报 */
    expectN?: number;
};

export function buildMarkSelectPrompt(input: MarkSelectPromptInput): string {
    const lines: string[] = [
        `图上有 ${input.markCount} 个用红框圈出并标注了序号的目标候选（序号 1 到 ${input.markCount}）。`,
        ANTI_INTERFERENCE_RULE,
    ];
    if (input.instruction) {
        lines.push(`题目原文：「${input.instruction}」`);
        lines.push("请严格按题目原文的语义判断要点哪一个（些），而不是按字面最像的那个。");
    }
    if (input.mode === "hanzi") {
        lines.push(`题目要求依次点击这些汉字：${input.labels.join(" → ")}（共 ${input.labels.length} 个）。`);
        lines.push("请为每个汉字找出它所在的那个红框序号。");
    }
    else if (input.labels.length) {
        lines.push(`题干的答案图标（按从左到右顺序）为：${input.labels.join(" → ")}。`);
        lines.push("请为每一个找出图中外形轮廓与之最接近的红框序号。");
    }
    else {
        lines.push("请自己读懂题目，判断要点几个目标、分别对应哪个红框序号。");
    }
    if (input.labels.length || input.mode === "hanzi") {
        lines.push(`硬规则：每个序号只能用一次；序号必须落在 1 到 ${input.markCount} 之间。`);
    }
    lines.push("语义硬规则：题目中若用某个物体来定位目标（例如描述它与另一个物体的相对位置、");
    lines.push("大小、颜色或先后关系），那个被用来定位的物体是【参照物】，【不是】要点击的目标。");
    lines.push("只点击题目【要求点击】的对象；参照物一律不点。\n");
    const want = input.expectN && input.expectN > 0
        ? input.expectN
        : input.labels.length || 0;
    lines.push("禁止输出坐标、禁止输出解释过程、禁止think。只输出JSON：");
    if (want > 0) {
        lines.push(`{"order":[${Array.from({ length: want }, (_, i) => i + 1).join(",")}],"count":${want},"why":["每个序号对应的是什么，各不超过12字"]}`);
        lines.push(`order 数组长度必须等于 ${want}，数组顺序＝点击顺序。`);
    }
    else {
        lines.push('{"order":[1,2],"count":2,"why":["第一个是什么","第二个是什么"]}');
        lines.push("count＝题目要求点击的目标个数；order 数组长度必须等于 count，数组顺序＝点击顺序。");
    }
    return lines.filter(Boolean).join("\n");
}

const MARK_ORDER_KEYS = ["order", "sequence", "clicks", "indices", "indexes", "marks", "targets", "results"];
const MARK_INDEX_KEYS = ["mark", "index", "idx", "id", "no", "n", "seq", "order", "grid"];

/** 从任意形状的 JSON 里抽出序号数组（容忍 [1,2] / {"order":[1,2]} / [{mark:1},…]） */
function collectMarkOrder(parsed: unknown, markCount: number): number[] {
    const readOne = (item: unknown): number => {
        if (typeof item === "number")
            return item;
        if (typeof item === "string")
            return Number(item.replace(/[^\d]/g, ""));
        if (item && typeof item === "object") {
            const o = item as Record<string, unknown>;
            for (const k of MARK_INDEX_KEYS) {
                const v = o[k];
                if (v == null)
                    continue;
                const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d]/g, ""));
                if (Number.isFinite(n))
                    return n;
            }
        }
        return Number.NaN;
    };
    const fromArray = (arr: unknown[]): number[] => sanitizeMarkOrder(arr.map(readOne), markCount);
    if (Array.isArray(parsed)) {
        const direct = fromArray(parsed);
        if (direct.length)
            return direct;
    }
    if (parsed && typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        for (const key of MARK_ORDER_KEYS) {
            const arr = o[key];
            if (!Array.isArray(arr))
                continue;
            const got = fromArray(arr);
            if (got.length)
                return got;
        }
    }
    return [];
}

/** 去重、纠序、越界丢弃；保留首次出现顺序（＝点击顺序） */
export function sanitizeMarkOrder(nums: number[], markCount: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const n of nums) {
        if (!Number.isInteger(n) || n < 1 || n > markCount || seen.has(n))
            continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

export function extractMarkOrder(rawText: string, markCount: number): number[] {
    const raw = String(rawText ?? "");
    if (!raw.trim())
        return [];
    const body = afterThink(raw).trim() || raw.trim();
    for (const src of [body, raw]) {
        const parsed = tryParseJsonBlob(src);
        if (parsed == null)
            continue;
        const got = collectMarkOrder(parsed, markCount);
        if (got.length)
            return got;
    }
    // 正则抢救：模型偶尔把 order 夹在口语/think 里
    const re = /["']?(?:order|sequence|indices|indexes|marks|clicks)["']?\s*:\s*\[([^\]]*)\]/i;
    for (const src of [body, raw]) {
        const m = re.exec(src);
        if (!m?.[1])
            continue;
        const nums = [...m[1].matchAll(/\d+/g)].map((x) => Number(x[0]));
        const got = sanitizeMarkOrder(nums, markCount);
        if (got.length)
            return got;
    }
    return [];
}

/** 模型自报的目标个数（0 = 未自报）。用于个数未知时的自洽校验 */
export function extractMarkCount(rawText: string): number {
    const raw = String(rawText ?? "");
    if (!raw.trim())
        return 0;
    const body = afterThink(raw).trim() || raw.trim();
    for (const src of [body, raw]) {
        const parsed = tryParseJsonBlob(src);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            continue;
        const o = parsed as Record<string, unknown>;
        const n = Number(o.count ?? o.total ?? o.targetCount ?? o.n);
        if (Number.isInteger(n) && n >= 1 && n <= 8)
            return n;
    }
    return 0;
}

/** 取出模型自述的简短依据（仅用于日志/排障，不参与判定） */
function extractMarkWhy(rawText: string): string[] {
    const raw = String(rawText ?? "");
    if (!raw.trim())
        return [];
    const body = afterThink(raw).trim() || raw.trim();
    for (const src of [body, raw]) {
        const parsed = tryParseJsonBlob(src);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            continue;
        const o = parsed as Record<string, unknown>;
        const arr = o.why ?? o.reason ?? o.reasons;
        if (!Array.isArray(arr))
            continue;
        const out = arr
            .map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 24))
            .filter(Boolean);
        if (out.length)
            return out.slice(0, 8);
    }
    return [];
}

/**
 * 策略 B：SoM 动态标记定位。
 * 候选框不足、标记图失败或选号不达标 → 返回 null，由调用方回退固定网格（绝不猜、不补齐）。
 */
async function tryMarkLocalization(input: {
    client: unknown;
    model: string;
    page: Page;
    cleanB64: string;
    /** 送模的底图（图标模式用色度增强版，让淡色目标可见）；尺寸与框一致 */
    markSourceB64: string;
    mode: "hanzi" | "icon";
    labels: string[];
    /** 已知要点个数；0 = 未知（文字型题干，由模型自报） */
    expectN: number;
    /** 题干原文（DOM 或题干条读出），文字型题干的语义依据 */
    instruction?: string;
    /** 题干条小图（题干文字可能在图上，DOM 读不到时靠它） */
    tipB64?: string;
    /** 逐枚答案小图（图标模板）；有则可直接对照，不必靠文字推断 */
    tipIconB64s?: string[];
    imageWidth?: number;
    imageHeight?: number;
    signal?: AbortSignal;
    logger: JsonLogger;
}): Promise<{ points: PixelPoint[]; rawHead: string; confidence: number } | null> {
    const { logger } = input;
    const wantKnown = input.expectN > 0;
    const minBoxes = Math.max(2, wantKnown ? input.expectN : 2);
    const boxes = await detectMarkBoxes({
        page: input.page,
        cleanB64: input.cleanB64,
        kind: input.mode === "hanzi" ? "glyph" : "shape",
        width: input.imageWidth,
        height: input.imageHeight,
    });
    if (boxes.length < minBoxes) {
        logger.agentProgress(`动态标记候选不足（${boxes.length} 框 / 需 ${minBoxes}），回退固定网格…`, {
            phase: "point_select_captcha",
            stage: "som_insufficient",
            boxes: boxes.length,
            need: minBoxes,
        });
        return null;
    }
    const marked = await overlayMarkBoxes({
        page: input.page,
        imageBuf: Buffer.from(input.markSourceB64, "base64"),
        boxes,
    });
    if (!marked) {
        logger.agentProgress("动态标记图生成失败，回退固定网格…", {
            phase: "point_select_captcha",
            stage: "som_overlay_fail",
        });
        return null;
    }
    logger.agentProgress(`SoM 动态标记：已框出 ${boxes.length} 个候选并编号，送模型选号…`, {
        phase: "point_select_captcha",
        stage: "som_marks",
        boxes: boxes.length,
        ids: boxes.map((b) => b.id),
    });
    const basePrompt = buildMarkSelectPrompt({
        labels: input.labels,
        markCount: boxes.length,
        mode: input.mode,
        instruction: input.instruction,
        expectN: input.expectN,
    });
    const acceptLen = (n: number, declared: number) => {
        if (wantKnown)
            return n === input.expectN;
        // 个数未知（文字型题干）：优先按模型自报的 count 自洽校验，避免少点导致必失败
        if (declared > 0)
            return n === declared;
        return n >= 1 && n <= boxes.length;
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
        const content: Array<Record<string, unknown>> = [
            {
                type: "image_url",
                image_url: {
                    url: `data:image/jpeg;base64,${marked.b64}`,
                    detail: "high",
                },
            },
            { type: "text", text: attempt === 1 ? basePrompt : buildMarkRetryPrompt(input, boxes.length) },
        ];
        // 题干条：DOM 未读到题目文字时，题干文字很可能就在这张小图上
        if (!input.instruction && input.tipB64) {
            content.push({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${input.tipB64}`, detail: "high" },
            });
            content.push({
                type: "text",
                text: "上图=主图（已编号）；这张=题干条，题目文字可能写在里面，请一并读取。",
            });
        }
        // 逐枚答案小图：可直接对照，比靠文字推断更稳
        const tipIcons = (input.tipIconB64s ?? []).filter(Boolean);
        if (tipIcons.length) {
            content.push({
                type: "text",
                text: `下面 ${tipIcons.length} 张是【要点击的答案】小图，按从左到右的顺序；请为每一张找出主图里对应的红框序号。`,
            });
            for (const b64 of tipIcons) {
                content.push({
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
                });
            }
        }
        const resp = await callVisionGridOnce({
            client: input.client,
            model: input.model,
            content,
            signal: input.signal,
            grid: null,
            logger: input.logger,
            parseGrid: false,
        });
        const order = extractMarkOrder(resp.rawFull, boxes.length);
        const declaredCount = extractMarkCount(resp.rawFull);
        if (acceptLen(order.length, declaredCount)) {
            const picked = order.map((n) => boxes[n - 1]!);
            const points = picked.map((b) => ({ x: b.cx, y: b.cy }));
            const why = extractMarkWhy(resp.rawFull);
            logger.agentProgress(`SoM 选号：${order.join(" → ")} → 框心 ` +
                points.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(" → ") +
                (why.length ? `｜判断依据：${why.join("；")}` : ""), {
                phase: "point_select_captcha",
                stage: "som_pick",
                order,
                why,
                points,
                confidence: wantKnown ? 0.93 : 0.8,
            });
            return { points, rawHead: `som ${order.join(",")}`, confidence: wantKnown ? 0.93 : 0.8 };
        }
        logger.agentProgress(`SoM 选号个数不符（${wantKnown ? `要 ${input.expectN}` : declaredCount > 0 ? `自报 ${declaredCount}` : "题干未定"}、得 ${order.length} 个），纠偏重问…`, {
            phase: "point_select_captcha",
            stage: "som_pick_retry",
            attempt,
            got: order.length,
            need: wantKnown ? input.expectN : declaredCount,
            head: resp.rawHead.slice(0, 80).replace(/\s+/g, " "),
        });
    }
    logger.agentProgress("SoM 两轮选号均未达标，回退固定网格…", {
        phase: "point_select_captcha",
        stage: "som_fail",
    });
    return null;
}

/**
 * 个数不符时的纠偏提示：直接把「参照物不是目标」讲透。
 * 旧实现只丢一句「未达标」，模型会反复把参照物当成答案。
 */
function buildMarkRetryPrompt(
    input: { labels: string[]; expectN: number; instruction?: string; mode: "hanzi" | "icon" },
    markCount: number,
): string {
    const lines: string[] = [
        "上一次输出不符合要求。请重新读题后只输出JSON。",
    ];
    if (input.instruction) {
        lines.push(`题目原文：「${input.instruction}」`);
    }
    if (input.expectN > 0) {
        lines.push(`题目只要点击 ${input.expectN} 个目标，请给出恰好 ${input.expectN} 个序号。`);
    }
    else {
        lines.push("请先确定题目要求点击几个目标，再给出相同个数的序号。");
    }
    lines.push("自检：题目里被用来【定位】目标的那个物体是参照物，不是答案。");
    lines.push("例如「点 A 左边的 B」，答案是 B 所在的序号，绝不是 A。");
    lines.push("自检：每个序号只能出现一次，且必须在 1 到 " + markCount + " 之间。");
    lines.push('只输出：{"order":[序号...],"count":个数,"why":["..."]}');
    return lines.join("\n");
}

/**
 * 方案 B：Stage1 普查字斑/图标 → 墨迹过滤 → Stage2 独占绑定 → 吸附点击。
 * localize="som"（默认）时先走动态标记；不达标自动回退固定网格。
 */
export async function analyzeClickPoints(input) {
    const router = createModelRouter(input.aiSettings);
    if (!isIntentConfigured(router.pool, "vision")) {
        throw new Error("未配置视觉模型（vision），无法分析点选");
    }
    if (!input.page) {
        throw new Error("Visual Grid 需要 page 做墨迹吸附");
    }
    const { route, client } = router.forIntent("vision", "点选格号");
    const grid = input.gridInfo;
    const cleanB64 = input.cleanB64 || input.imageB64;
    const ctx = visionInstructionContext(input.crop.instruction);
    const hanSeq = ctx.hanSequence.length >= 2
        ? ctx.hanSequence
        : extractHanClickSequence(input.crop.instruction);
    const mode = hanSeq.length >= 2
        ? "hanzi"
        : ctx.unreliable || input.crop.instructionUnreliable || !hanSeq.length
            ? "icon"
            : "hanzi";
    // 汉字：走 glyph 普查+墨迹+独占绑定（与图标模板路径互斥，勿混用 tipIcons）
    // 图标：tipIcons 模板对照 / 色块；不改汉字分支
    // 图标：对比度增强后叠格送 VLM；点击仍用 cleanB64
    let visionImageB64 = input.imageB64;
    let blobCenters = new Map();
    // SoM 送模底图：图标用色度增强版（淡色半透明目标对纯 VLM 几乎不可见），汉字用原图
    let iconEnhancedB64: string | null = null;
    if (mode === "icon") {
        const enhanced = await enhanceChromaContrast(input.page, cleanB64, 2.6);
        if (enhanced) {
            iconEnhancedB64 = enhanced;
            try {
                const gridded = await overlayGrid(input.page, Buffer.from(enhanced, "base64"));
                visionImageB64 = gridded.processedImageBase64;
                input.logger.agentProgress("图标识图：已对比度增强并重叠 Visual Grid", {
                    phase: "point_select_captcha",
                    stage: "icon_enhance",
                });
            }
            catch {
                visionImageB64 = enhanced;
            }
        }
    }
    // DOM 题干原文。不可靠（内联图标只剩 "> > >"）时置空，绝不把被毒化的文本喂给模型。
    const domInstruction = ctx.unreliable || input.crop.instructionUnreliable
        ? ""
        : String(input.crop.instruction ?? "").replace(/\s+/g, " ").trim();
    // 用于语义推理的题目原文：DOM 优先（权威），否则沿用题干条读出的文字
    let instructionText = mode === "hanzi" ? domInstruction : "";
    let labels;
    let expectN;
    let tipIcons = [];
    if (mode === "hanzi") {
        labels = hanSeq;
        expectN = labels.length;
        input.logger.agentProgress(`题目要按顺序点：${labels.join(" → ")}（共 ${labels.length} · Stage1普查→Stage2独占）`, { phase: "point_select_captcha", stage: "han_sequence", seq: labels });
    }
    else {
        tipIcons = Array.isArray(input.tipIcons)
            ? input.tipIcons.filter((x) => typeof x === "string" && x.length > 80)
            : [];
        if (tipIcons.length >= 2) {
            labels = tipIcons.map((_, i) => `T${i + 1}`);
            expectN = labels.length;
            input.logger.agentProgress(
                `图标点选 · 已取题干完整答案小图 ${tipIcons.length} 枚（LTR 模板对照）`,
                {
                    phase: "point_select_captcha",
                    stage: "icon_mode_templates",
                    n: tipIcons.length,
                },
            );
        }
        else {
            const reading = await readTipReading({
                client,
                model: route.model,
                tipB64: input.tipB64,
                signal: input.signal,
                logger: input.logger,
                grid,
            });
            // DOM 拿到可靠题目文字时，它比「题干条读出的外形清单」更权威：
            // 即使题干条判读失败（unknown），也按语义定位 —— 绝不编造目标清单。
            // 旧实现在此把题干里提到的物体当成目标清单（参照物也算目标），
            // 导致「点A左边的B」会去点 A；目标清单只能由题目原文决定。
            const semantic = reading.kind === "text" ||
                (reading.kind === "unknown" && Boolean(domInstruction));
            if (semantic) {
                instructionText = domInstruction || reading.instruction;
                labels = [];
                expectN = reading.count > 0 ? reading.count : 0;
                input.logger.agentProgress(
                    `图标点选 · 文字型题干，按语义定位：${instructionText.slice(0, 48)}` +
                    `（要点 ${expectN || "?"} 个 · 题干条判读=${reading.kind}）`,
                    {
                        phase: "point_select_captcha",
                        stage: "icon_mode_semantic",
                        instruction: instructionText,
                        count: expectN,
                        tipKind: reading.kind,
                    },
                );
            }
            else {
                labels = reading.targets.filter((t) => !isPlaceholderShapeLabel(t));
                if (labels.length < 2) {
                    labels = ["T1", "T2", "T3"];
                }
                expectN = labels.length;
                instructionText = domInstruction;
                input.logger.agentProgress(
                    `图标点选 · 无逐枚模板，弱回退读序（目标：${labels.join(" / ")}）`,
                    {
                        phase: "point_select_captcha",
                        stage: "icon_mode",
                        tip: Boolean(input.tipB64),
                        n: expectN,
                    },
                );
            }
        }
        // 挂到 input 供 bind 使用
        input._tipIconsResolved = tipIcons;
    }

    // —— 策略 B：SoM 动态标记定位（默认启用；候选不足/选号失败自动回退固定网格）——
    if ((input.localize ?? "som") === "som") {
        const som = await tryMarkLocalization({
            client,
            model: route.model,
            page: input.page,
            cleanB64,
            markSourceB64: mode === "icon" ? iconEnhancedB64 ?? cleanB64 : cleanB64,
            mode,
            labels,
            expectN,
            instruction: instructionText,
            tipB64: input.tipB64,
            // 逐枚答案小图只在「标签就是答案」时才有对照意义
            tipIconB64s: labels.length >= 2 && labels.every((t) => /^T\d+$/.test(t))
                ? tipIcons
                : [],
            imageWidth: grid?.imageWidth,
            imageHeight: grid?.imageHeight,
            signal: input.signal,
            logger: input.logger,
        });
        if (som)
            return som;
    }

    const bannedGrids = new Set();
    let rawHead = "";
    let lastPool = [];
    for (let tryN = 1; tryN <= 3; tryN++) {
        input.logger.agentProgress(`③a Stage1 普查候选格（第${tryN}轮）…`, {
            phase: "point_select_captcha",
            stage: "survey",
            tryN,
        });
        let pool = [];
        if (mode === "icon") {
            const blobs = await detectChromaBlobGrids(input.page, cleanB64, grid);
            blobCenters = new Map(blobs.map((b) => [b.grid, { x: b.cx, y: b.cy }]));
            pool = blobs.map((b) => b.grid).filter((g) => !bannedGrids.has(g));
            input.logger.agentProgress(`本地色块候选：${pool.join(",") || "无"}（n=${blobs.length}）`, {
                phase: "point_select_captcha",
                stage: "chroma_blobs",
                pool,
                blobs: blobs.map((b) => ({ g: b.grid, a: b.area, c: Math.round(b.meanChroma) })),
            });
            // 色块常因底纹漏检：始终用 VLM 普查补漏（不依赖色块是否够数）
            const survey = await callVisionGridOnce({
                client,
                model: route.model,
                content: buildVisionUserContent({
                    prompt: buildSurveyPrompt({
                        grid,
                        mode,
                        expectMin: expectN > 0 ? expectN : 3,
                        bannedGrids: [...bannedGrids],
                    }),
                    imageB64: visionImageB64,
                    tipB64: input.tipB64,
                }),
                signal: input.signal,
                grid,
                logger: input.logger,
            });
            rawHead = survey.rawHead;
            let vlmPool = extractDetectedOnly(survey.rawFull, grid);
            if (!vlmPool.length && survey.result?.detectedTextGrids.length) {
                vlmPool = survey.result.detectedTextGrids;
            }
            for (const g of vlmPool) {
                if (!pool.includes(g) && !bannedGrids.has(g))
                    pool.push(g);
            }
            lastPool = pool;
            if (pool.length < Math.min(expectN, 2)) {
                input.logger.agentProgress(`Stage1 色块候选不足（${pool.length}），重试…`, { phase: "point_select_captcha", stage: "survey_filtered_short", tryN });
                continue;
            }
            input.logger.agentProgress(`Stage1 候选池：${pool.join(",")}（本地色块优先）`, { phase: "point_select_captcha", stage: "survey_ok", pool });
        }
        else {
            const survey = await callVisionGridOnce({
                client,
                model: route.model,
                content: buildVisionUserContent({
                    prompt: buildSurveyPrompt({
                        grid,
                        mode,
                        expectMin: expectN > 0 ? expectN : 3,
                        bannedGrids: [...bannedGrids],
                    }),
                    imageB64: visionImageB64,
                    tipB64: undefined,
                }),
                signal: input.signal,
                grid,
                logger: input.logger,
            });
            rawHead = survey.rawHead;
            pool = extractDetectedOnly(survey.rawFull, grid);
            if (!pool.length && survey.result?.detectedTextGrids.length) {
                pool = survey.result.detectedTextGrids;
            }
            if (survey.result?.sequence.length) {
                for (const s of survey.result.sequence) {
                    if (!pool.includes(s.grid) && !bannedGrids.has(s.grid))
                        pool.push(s.grid);
                }
            }
            pool = [...new Set(pool.filter((g) => !bannedGrids.has(g)))];
            if (pool.length < (expectN > 0 ? expectN : 2)) {
                input.logger.agentProgress(`Stage1 候选不足（${pool.length}），重试普查… raw=${survey.rawHead.slice(0, 60).replace(/\s+/g, " ")}`, { phase: "point_select_captcha", stage: "survey_short", tryN });
                continue;
            }
            const filtered = await filterPoolByInk({
                page: input.page,
                cleanB64,
                grid,
                pool,
                logger: input.logger,
                mode,
            });
            for (const b of filtered.banned)
                bannedGrids.add(b);
            pool = filtered.ok;
            lastPool = pool;
            if (pool.length < (expectN > 0 ? Math.min(expectN, 3) : 2)) {
                input.logger.agentProgress(`Stage1 墨迹过滤后候选不足（${pool.length}）`, { phase: "point_select_captcha", stage: "survey_filtered_short", tryN });
                continue;
            }
            input.logger.agentProgress(`Stage1 候选池：${pool.join(",")}（已滤空白/无字插画）`, { phase: "point_select_captcha", stage: "survey_ok", pool });
        }
        // ——— Stage 2: 绑定 ———
        let sequence;
        if (mode === "icon") {
            input.logger.agentProgress(`③b Stage2 图标匹配+核验题干顺序…`, {
                phase: "point_select_captcha",
                stage: "icon_bind",
                tryN,
            });
            const bound = await bindIconSequence({
                client,
                model: route.model,
                imageB64: visionImageB64,
                cleanB64,
                tipB64: input.tipB64,
                tipIcons: input._tipIconsResolved || input.tipIcons || [],
                page: input.page,
                grid,
                pool,
                targets: labels,
                banned: bannedGrids,
                signal: input.signal,
                logger: input.logger,
            });
            if (!bound) {
                input.logger.agentProgress("图标绑定/核验未通过，重试整轮…", {
                    phase: "point_select_captcha",
                    stage: "icon_bind_fail",
                    tryN,
                });
                continue;
            }
            sequence = bound;
            rawHead = `icon ${bound.map((s) => `${s.char}@${s.grid}`).join(" → ")}`;
        }
        else {
            input.logger.agentProgress(`③b Stage2 独占绑定题干顺序…`, {
                phase: "point_select_captcha",
                stage: "bind",
                tryN,
            });
            const bind = await callVisionGridOnce({
                client,
                model: route.model,
                content: buildVisionUserContent({
                    prompt: buildBindPrompt({
                        grid,
                        mode,
                        labels,
                        pool,
                        bannedGrids: [...bannedGrids],
                    }),
                    imageB64: visionImageB64,
                    tipB64: input.tipB64,
                }),
                signal: input.signal,
                grid,
                logger: input.logger,
                preferChars: labels,
            });
            rawHead = bind.rawHead;
            sequence = bind.result?.sequence ?? [];
            // 纠正 char 与题干对齐（模型偶发错字）
            if (sequence.length === labels.length) {
                sequence = sequence.map((s, i) => ({
                    char: labels[i],
                    grid: s.grid,
                }));
            }
            // 长度不够：用独占逐个从池中补齐（整序，不接受脏部分点击）
            if (sequence.length !== expectN) {
                input.logger.agentProgress(`Stage2 数量不对（要${expectN}得${sequence.length}），改池内独占逐个绑定…`, { phase: "point_select_captcha", stage: "bind_recount", tryN });
                const per = await locateCharsOneByOne({
                    client,
                    model: route.model,
                    imageB64: visionImageB64,
                    tipB64: input.tipB64,
                    grid,
                    labels,
                    mode,
                    banned: bannedGrids,
                    pool,
                    signal: input.signal,
                    logger: input.logger,
                });
                if (!per || per.sequence.length !== expectN) {
                    continue;
                }
                sequence = per.sequence;
            }
            // 格必须在候选池内
            const outside = sequence
                .map((s, i) => (pool.includes(s.grid) ? -1 : i))
                .filter((i) => i >= 0);
            if (outside.length) {
                input.logger.agentProgress(`Stage2 有格不在候选池，重绑冲突项…`, { phase: "point_select_captcha", stage: "bind_outside", outside });
                const occupied = new Set(sequence.filter((_, i) => !outside.includes(i)).map((s) => s.grid));
                const fixLabels = outside.map((i) => sequence[i].char);
                const per = await locateCharsOneByOne({
                    client,
                    model: route.model,
                    imageB64: visionImageB64,
                    tipB64: input.tipB64,
                    grid,
                    labels: fixLabels,
                    mode,
                    banned: new Set([...bannedGrids, ...occupied]),
                    pool: pool.filter((g) => !occupied.has(g)),
                    signal: input.signal,
                    logger: input.logger,
                });
                if (!per || per.sequence.length !== fixLabels.length) {
                    continue;
                }
                let pi = 0;
                sequence = sequence.map((s, i) => outside.includes(i) ? per.sequence[pi++] : s);
            }
            // 独占门禁
            let gate = assertExclusiveGrids(sequence);
            if (!gate.ok) {
                input.logger.agentProgress(`独占门禁失败：${gate.reason}，重绑冲突项…`, {
                    phase: "point_select_captcha",
                    stage: "bind_conflict",
                    conflicts: gate.conflictIdx,
                });
                const occupied = new Set(sequence
                    .filter((_, i) => !gate.conflictIdx.includes(i))
                    .map((s) => s.grid));
                // 冲突项全部重绑（含首次占用者），避免「不/中」同钉 C3
                const fixIdx = gate.conflictIdx;
                const fixLabels = fixIdx.map((i) => labels[i] ?? sequence[i].char);
                const per = await locateCharsOneByOne({
                    client,
                    model: route.model,
                    imageB64: visionImageB64,
                    tipB64: input.tipB64,
                    grid,
                    labels: fixLabels,
                    mode,
                    banned: new Set([...bannedGrids, ...occupied]),
                    pool: pool.filter((g) => !occupied.has(g)),
                    signal: input.signal,
                    logger: input.logger,
                });
                if (!per || per.sequence.length !== fixLabels.length) {
                    for (const i of fixIdx) {
                        if (sequence[i])
                            bannedGrids.add(sequence[i].grid);
                    }
                    continue;
                }
                let pi = 0;
                const next = sequence.slice();
                for (const i of fixIdx) {
                    next[i] = { char: labels[i] ?? fixLabels[pi], grid: per.sequence[pi].grid };
                    pi += 1;
                }
                // 对齐 labels
                sequence = next.map((s, i) => ({
                    char: labels[i] ?? s.char,
                    grid: s.grid,
                }));
                gate = assertExclusiveGrids(sequence);
                if (!gate.ok) {
                    input.logger.agentProgress(`重绑后仍冲突，本轮作废`, {
                        phase: "point_select_captcha",
                        stage: "bind_conflict_fail",
                    });
                    continue;
                }
            }
        }
        input.logger.agentProgress(`Stage2 序列：${sequence.map((s) => `${s.char}@${s.grid}`).join(" → ")}`, { phase: "point_select_captcha", stage: "bind_ok", sequence, pool });
        // ——— Stage2.5: 逐格视觉核验（防邻格空点/绑错） ———
        input.logger.agentProgress(`③c 逐格核验目标是否在格内…`, {
            phase: "point_select_captcha",
            stage: "cell_verify",
            tryN,
        });
        const tipIconsForVerify =
            mode === "icon" ? input._tipIconsResolved || input.tipIcons || [] : [];
        const mismatchIdx = await findMismatchedCellIndexes({
            client,
            model: route.model,
            page: input.page,
            cleanB64: mode === "icon" ? visionImageB64 : cleanB64,
            grid,
            sequence,
            signal: input.signal,
            logger: input.logger,
            strict: mode === "icon" && tipIconsForVerify.length < sequence.length,
            mode,
            tipIcons: tipIconsForVerify,
        });
        if (mismatchIdx.length) {
            input.logger.agentProgress(`逐格核验未通过 ${mismatchIdx.length} 处，池内重绑…`, {
                phase: "point_select_captcha",
                stage: "cell_verify_rebind",
                mismatchIdx,
            });
            const rebound = await rebindAfterCellMismatch({
                client,
                model: route.model,
                imageB64: visionImageB64,
                tipB64: input.tipB64,
                tipIcons: tipIconsForVerify,
                page: input.page,
                cleanB64: mode === "icon" ? visionImageB64 : cleanB64,
                grid,
                sequence,
                labels,
                mode,
                mismatchIdx,
                pool,
                banned: bannedGrids,
                signal: input.signal,
                logger: input.logger,
            });
            if (!rebound)
                continue;
            sequence = rebound;
            input.logger.agentProgress(`逐格核验通过：${sequence.map((s) => `${s.char}@${s.grid}`).join(" → ")}`, { phase: "point_select_captcha", stage: "cell_verify_ok", sequence });
        }
        let mapped = await mapSequenceToPixels({
            page: input.page,
            cleanB64,
            grid,
            sequence,
            banned: bannedGrids,
            logger: input.logger,
            mode,
        });
        if (mapped.blankIdx.length) {
            const healed = await healBlankWithNeighbors({
                page: input.page,
                cleanB64,
                grid,
                sequence,
                points: mapped.points,
                blankIdx: mapped.blankIdx,
                banned: bannedGrids,
                detectedPool: pool,
                logger: input.logger,
                mode,
            });
            sequence = healed.sequence;
            mapped = { points: healed.points, blankIdx: healed.blankIdx };
            const gate2 = assertExclusiveGrids(sequence);
            if (!gate2.ok || mapped.blankIdx.length) {
                for (const i of mapped.blankIdx) {
                    if (sequence[i])
                        bannedGrids.add(sequence[i].grid);
                }
                input.logger.agentProgress(`吸附后仍有空白/冲突，重试整轮…`, {
                    phase: "point_select_captcha",
                    stage: "ink_retry",
                    tryN,
                });
                continue;
            }
        }
        // 终检独占
        const finalGate = assertExclusiveGrids(sequence);
        if (!finalGate.ok) {
            continue;
        }
        // 图标：优先用本地色块质心（比格心+噪声吸附更准）
        if (mode === "icon" && blobCenters.size) {
            mapped.points = mapped.points.map((p, i) => {
                const g = sequence[i]?.grid;
                const c = g ? blobCenters.get(g) : null;
                return c ? { x: c.x, y: c.y } : p;
            });
        }
        return {
            points: mapped.points,
            rawHead,
            confidence: pool.length >= labels.length ? 0.94 : 0.88,
        };
    }
    input.logger.warn("point_select_grid_failed", {
        attempt: input.attempt,
        rawHead,
        lastPool,
        banned: [...bannedGrids],
    });
    return { points: [], rawHead, confidence: 0 };
}
