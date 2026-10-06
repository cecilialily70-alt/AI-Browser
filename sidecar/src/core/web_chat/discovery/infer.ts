/**
 * 发现流水线 ② · 推断（**唯一花 token 的一步**，一次调用）
 *
 * 产物是**描述符草案**（数据），不是代码（R8）。两条纪律：
 *   1. **只喂结构化事实**：提示词里的页面信息全部来自 `CaptureBundle.structure`
 *      （选择器候选 / 属性名 / 形态 / 几何），**绝不喂 HTML、绝不喂消息正文**。
 *   2. **拆分取样**：只用 `oracle.rows.shown` / `oracle.threads.shown` 当线索；
 *      `heldOut` 那批一个字都不给模型 —— 否则自检就变成自我确认（计划 §6.0 规则 3）。
 *
 * 本模块的**纯函数部分**（提示词拼装 / 输出解析 / 草案收敛）全部可离线单测；
 * 只有 `inferDescriptor` 需要 LLM 客户端（走推理槽 `logic`）。
 */

import { extractAssistantContent } from "../../../ai_client.js";
import type { DescriptorDraft, InferOptions, RawStructureProbe } from "./types.js";
import type { CaptureBundle } from "./types.js";

/** 提示词里最多放多少个结构候选（多了会稀释注意力，也会推高成本） */
export const PROMPT_NODE_LIMIT = 60;

/** 系统提示词：把「只许声明、不许脚本」的边界写在最前面（R8） */
export const INFER_SYSTEM_PROMPT = `你是「聊天站点描述符」生成器。你的输出是一份**声明式 JSON**（schema 见下），
它会被一个确定性运行时读来解释某个网页聊天站点。硬约束（违反即作废）：

1. 只能输出**数据**：CSS 选择器、属性名、正则**源码**、固定枚举值、数字、布尔。
   严禁输出任何函数、表达式、模板字符串、脚本、伪代码、注释掉的代码。
2. **不许编造页面里不存在的东西**。你只能使用「页面结构事实」里出现过的
   选择器片段、类名、属性名。看不出来的字段就**留空**（空数组 / null），
   绝不猜测一个「大概是这样」的选择器 —— 猜错会在后面被自检逐字段抓出来。
3. 方向（我方 / 对方）只能来自这三类证据，且必须给出回退顺序：
   id 文本前缀 → 行级方向标记（图标/类名） → 仅我方标记。
   如果没有可靠的方向证据，就把这些字段留空（运行时会判定「分不出方向」并按对方沉默处理）。
4. 发送只允许这两种方式：写输入框（typeKeys / selectAllBeforeInput / insertText / fill / execCommand。
   **优先 typeKeys** = 真实按键逐字输入，最像人，富文本编辑器一律接受；selectAllBeforeInput
   只有在页内确认该 composer 监听 beforeinput 时才用）+ 触发（enterOnce / click / sendThenEnter）。
   **没有**「调用站点内部发送函数」这一项。
5. 输出必须是**一个 JSON 对象**，不要 markdown 包裹，不要解释文字。

schema（只允许这些键；未知键会被校验器整份拒绝）：
{
  "id": string,                      // 站点键，小写字母数字与短横线
  "version": 1,
  "source": "learned",
  "match": { "hostPattern": string, "pathPattern": string|null },
  "ready": { "allOf": string[], "absent": string[] },   // allOf[0] 必须是「会话容器」
  "peer": { "fromAttribute": {"attr":string,"pattern":string|null,"group":number}|null,
            "fallbackAttrs": string[],
            "fallbackHeader": {"selectors":string[],"digitsOnly":boolean}|null },
  "rows": { "selector": string,
            "id": {"attr":string,"accept":string[]}|null,
            "idPrefixDirection": {"out":string,"in":string}|null,
            "thenTailIcons": {"out":string[],"in":string[]}|null,
            "thenCheckIcons": {"out":string[]}|null,
            "exclude": string[], "textSelectors": string[],
            "attachmentSelectors": string[], "quotedReplySelectors": string[],
            "timeSelectors": string[],
            "retractedSelectors": string[], "tokenAttrs": string[],
            "insertedAtTopMeansOlder": boolean },
  "composer": { "selectors": string[],
                "input": {"method":"typeKeys"|"selectAllBeforeInput"|"insertText"|"fill"|"execCommand",
                          "verify":"equals"|"nonempty","retries":number,"failClosed":true},
                "send": {"selectors":string[],"method":"enterOnce"|"click"|"sendThenEnter",
                         "elseClick":boolean} },
  "history": { "scrollRoot": string[], "batchLimit": number, "concurrency": number },
  "threads": { "itemSelectors": string[], "keyAttr": string|null, "hrefAttr": string|null,
               "labelSelectors": string[], "unreadSelectors": string[], "limit": number } | null,
  "presence": { "typing": string[] }
}

同时输出一份「选择理由」数组 notes：[{"field": "...", "reason": "...", "confidence": 0~1}]。
输出形状：{"descriptor": {...}, "notes": [...]}`;

/** 修正回路的附加指令（把上一轮**具体差异**回喂，而不是笼统说「再试一次」） */
export const ADJUST_INSTRUCTION = `下面是上一次尝试的草案与机器自检**逐条差异**。请只改必须改的地方：
- 每一条差异都给了「期望值 / 实际值」，请针对它调整对应的选择器或方向规则；
- 如果差异说明「一条都没匹配到」，说明你选的选择器在这个页面里不存在，请改选结构事实里真实出现过的；
- 如果差异说明「方向相反」，方向规则的映射写反了，请交换 out/in（不要删掉回退链）；
- 依然不许编造结构事实里没有的选择器。`;

/* ————————————————————————— 纯函数：提示词 ————————————————————————— */

/** 结构事实 → 一段紧凑、可读、**零正文**的文本（这是模型唯一能看到的页面信息） */
export function describeStructure(structure: RawStructureProbe, limit = PROMPT_NODE_LIMIT): string {
  if (!structure.ok) return `（结构探测失败：${structure.reason ?? "unknown"}）`;
  const lines: string[] = [];
  lines.push(
    `视口 ${structure.viewport.width}x${structure.viewport.height}；` +
      `contenteditable ${structure.counts.contentEditable} 个 / textarea ${structure.counts.textarea} 个 / ` +
      `role=log ${structure.counts.roleLog} 个 / 链接 ${structure.counts.links} 个 / 按钮 ${structure.counts.buttons} 个`,
  );
  lines.push(`页面出现过的白名单属性：${structure.attrs.slice(0, 40).join(", ") || "（无）"}`);
  lines.push("候选节点（按出现顺序；hint 列给出可直接用作选择器的片段）：");
  for (const node of structure.nodes.slice(0, limit)) {
    const attrs = Object.entries(node.attrs)
      .map(([name, value]) => `${name}="${value}"`)
      .join(" ");
    const flags: string[] = [];
    if (node.childRepeat >= 3) flags.push(`容器(重复子结构 x${node.childRepeat})`);
    if (node.siblingRepeat >= 3) flags.push(`列表行(同签兄弟 x${node.siblingRepeat})`);
    if (node.contentEditable) flags.push("可编辑");
    if (node.scrollable) flags.push("可滚动");
    if (node.isLink) flags.push("链接");
    if (node.clickable) flags.push("可点击");
    if (node.hasMediaTag) flags.push("含媒体标签");
    if (node.role) flags.push(`role=${node.role}`);
    lines.push(
      `- ${node.path} | 子 ${node.childCount} | 文本 ${node.textLen}(${node.textShape}) | ` +
        `几何 x${node.rect.xRatio} y${node.rect.yRatio} w${node.rect.wRatio} h${node.rect.hRatio} | ` +
        `${flags.join(",") || "-"} | ${attrs || "（无属性）"}`,
    );
  }
  return lines.join("\n");
}

/** 真值线索：**只给 shown 那批**（heldOut 一个字都不给模型） */
export function describeOracle(bundle: CaptureBundle, limit = 24): string {
  const rows = bundle.oracle.rows.shown.slice(-limit);
  const threads = bundle.oracle.threads.shown.slice(0, limit);
  const lines: string[] = [];
  lines.push(`通用读法（与描述符无关的启发式）读到的消息行 ${bundle.oracle.renderedRowCount} 条，其中：`);
  for (const row of rows) {
    const attrs: string[] = [];
    if (row.rawId) attrs.push(`id原型=${foldIdShape(row.rawId)}`);
    attrs.push(`方向证据=${row.expect.direction}`);
    if (row.expect.mediaLike) attrs.push("有行无文字(附件?)");
    if (row.expect.systemLike) attrs.push("像系统消息");
    attrs.push(`几何=${row.cxRatio.toFixed(2)}`);
    if (row.tokens.length > 0) attrs.push(`class=${row.tokens.slice(0, 4).join("/")}`);
    lines.push(`- ${attrs.join(" ")}`);
  }
  lines.push(`会话列表候选 ${threads.length} 条（key 形态 / 是否有直链 / 是否未读）：`);
  for (const item of threads) {
    lines.push(
      `- key=${item.key.length > 40 ? `${item.key.slice(0, 40)}…` : item.key} ` +
        `直链=${item.url ? "有" : "无"} 未读=${item.unread ? "是" : "否"}`,
    );
  }
  return lines.join("\n");
}

/** id 原型：把数字折成 `#`（形态可学，内容不外传） */
export function foldIdShape(rawId: string): string {
  return String(rawId ?? "").replace(/\d+/g, "#").slice(0, 60);
}

export function buildInferMessages(
  bundle: CaptureBundle,
  options: InferOptions,
): { role: "system" | "user"; content: string }[] {
  const user: string[] = [];
  user.push(`站点地址：${bundle.url}`);
  user.push(`站点键建议：${bundle.siteKey}`);
  user.push("");
  user.push("## 页面结构事实（**没有 HTML，也没有消息正文**）");
  user.push(describeStructure(bundle.structure));
  user.push("");
  user.push("## 通用读法给的线索（供你校正方向与行形态）");
  user.push(describeOracle(bundle));
  const dropped = bundle.dropped.length > 0 ? bundle.dropped : [];
  if (dropped.length > 0) {
    user.push("");
    user.push("## 采集期发现的问题（会影响可用性，请据此保守选择）");
    for (const item of dropped) user.push(`- ${item}`);
  }

  if (options.previous) {
    user.push("");
    user.push("## 上一轮草案（需要在此基础上修正）");
    user.push(JSON.stringify(options.previous.descriptor));
    if (options.feedback) {
      user.push("");
      user.push(ADJUST_INSTRUCTION);
      user.push(options.feedback);
    }
    if (options.userNote) {
      user.push("");
      user.push(`## 用户补充（优先满足）\n${options.userNote}`);
    }
  }

  return [
    { role: "system", content: INFER_SYSTEM_PROMPT },
    { role: "user", content: user.join("\n") },
  ];
}

/* ————————————————————————— 纯函数：输出解析 ————————————————————————— */

/** 从模型输出里抠出 JSON 对象（容忍 markdown 包裹与前后废话；抠不出来就如实返回 null） */
export function extractJsonObject(raw: string): unknown | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() || text;
  try {
    return JSON.parse(body);
  } catch {
    /* 继续用括号配对兜底 */
  }
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseNotes(raw: unknown): DescriptorDraft["notes"] {
  if (!Array.isArray(raw)) return [];
  const out: DescriptorDraft["notes"] = [];
  for (const item of raw.slice(0, 60)) {
    if (!item || typeof item !== "object") continue;
    const record = item as { field?: unknown; reason?: unknown; confidence?: unknown };
    const field = String(record.field ?? "").trim();
    if (!field) continue;
    const confidence = Number(record.confidence);
    out.push({
      field: field.slice(0, 80),
      reason: String(record.reason ?? "").trim().slice(0, 300),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    });
  }
  return out;
}

/**
 * 解析模型输出 → 草案。
 *
 * 宽容只体现在**外壳**（markdown / 前后废话 / notes 越界），
 * **描述符正文本身不做任何修补** —— 补出来的字段就是编造（`parseDescriptor` 会如实拒绝，
 * 这正是我们要的：宁可失败重试，也不放一份「我们偷偷补过」的描述符过关）。
 */
export function parseInferResult(raw: string): DescriptorDraft | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { descriptor?: unknown; notes?: unknown };
  const descriptor = record.descriptor;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return null;
  return {
    descriptor,
    notes: parseNotes(record.notes),
    usage: null,
    raw,
  };
}

/* ————————————————————————— LLM 调用（推理槽） ————————————————————————— */

/** 只要能 `create` 的客户端即可（真实实现是 OpenAI 兼容 client，测试里给假客户端） */
export interface InferChatClient {
  chat: {
    completions: {
      create: (
        body: { model: string; messages: { role: string; content: string }[]; temperature?: number },
        options?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    };
  };
}

export interface InferDescriptorInput {
  client: InferChatClient;
  model: string;
  bundle: CaptureBundle;
  options: InferOptions;
}

/** 一次 LLM 调用 → 草案（拿不到可解析输出就返回 null，由调用方如实报错，不编一份草案） */
export async function inferDescriptor(input: InferDescriptorInput): Promise<DescriptorDraft | null> {
  const messages = buildInferMessages(input.bundle, input.options);
  const completion = await input.client.chat.completions.create(
    { model: input.model, messages, temperature: 0.2 },
    { signal: input.options.signal },
  );
  const draft = parseInferResult(extractAssistantContent(completion));
  if (!draft) return null;
  const usage = (completion as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
  return {
    ...draft,
    usage: usage
      ? {
          promptTokens: Number.isFinite(usage.prompt_tokens) ? Number(usage.prompt_tokens) : null,
          completionTokens: Number.isFinite(usage.completion_tokens) ? Number(usage.completion_tokens) : null,
        }
      : null,
  };
}
