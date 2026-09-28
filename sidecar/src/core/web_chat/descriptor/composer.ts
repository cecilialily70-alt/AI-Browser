/**
 * 出站闸门：**只走输入框 + 写入等值校验 + 只发一次**（R8 第②条 / 坑族 J）
 *
 * 为什么必须是一个独立模块（而不是散在 `chat_actions` 里）：这三条是**红线级**纪律，
 * 要有唯一落点、要能被单测直接锁住：
 *
 *   1. **只走输入框**：本模块只提供「往 composer 写入 → 读回校验 → 真实回车/按钮」这一条路径。
 *      **不提供**「调站点内部发送函数」「自建网络请求」「往 DOM 里插节点假装已发」任何入口，
 *      将来也不许加（R8 明列）。
 *   2. **写入等值校验（fail-closed）**：写进去的字**读回来必须就是我们要发的**。
 *      不相等就**不发**并如实报错 —— 宁可不发，也不把「半截话 / 别人的话 / 上一条残句」发出去。
 *   3. **只发一次**：一次调用最多产生一次「提交」（回车或点按钮）。绝无「重试导致发两遍」。
 *
 * 写入方式**不是一种写死**：描述符声明的写法先试，失败后按可靠度走兜底链（真实按键优先），
 * 每一步都过同一条读回校验 —— 描述符猜错只该让健康度记一笔，不该等于「永远发不出去」。
 * 失败时返回**结构化诊断**（选择器 + 每种写法的读回长度/指纹，**不含正文**），不再让排查靠猜。
 *
 * `execCommand` 的认知修正（坑族 J）：`document.execCommand("insertText")` 的**返回值不可信**
 * （许多设置在富文本里返回 true 却什么都没写）。所以这里**一律读回校验**，不看它的返回值。
 */

import type { Page } from "playwright-core";

import { hash32 } from "../../hash32.js";
import { resolveGateway } from "../../action_gateway.js";
import type { ComposerSpec, InputMethod, SendMethod } from "./types.js";

export interface ComposerSendOptions {
  signal?: AbortSignal;
  /** 日志/轨迹里的语义标签（不能含消息正文；正文一律不进日志） */
  semanticLabel?: string;
  /** 写入后允许站点重渲染的等待（毫秒） */
  settleMs?: number;
}

export interface ComposerSendResult {
  ok: boolean;
  reason?: string;
  /** 写入是否通过校验 */
  verified?: boolean;
  /** 是否真的提交了一次（true 只代表「发出去了」，对方是否收到由上层回读对账） */
  committed?: boolean;
  attempts?: number;
  inputMethod?: InputMethod;
  sendMethod?: SendMethod;
  /**
   * 失败时的**结构化诊断**（供上层落日志排查，**绝不含消息正文**）：
   * 命中的选择器、声明的写法与链上每种写法的结果、每次读回的长度与指纹。
   *
   * 为什么要它（§0.5.3 A「判定失败别谎报」）：`verify_mismatch` 这一条本身说不清是
   * 「选择器选错了元素」还是「站点不吃这种合成写入」—— 只留一个代码，下次还得猜。
   */
  diagnostics?: ComposerDiagnostics;
}

export interface ComposerDiagnostics {
  /** 命中的输入框选择器（DOM 形状，不含用户内容） */
  selector: string;
  /** 描述符声明的写法（权威来源，永远第一个试） */
  declaredMethod: InputMethod;
  /** 真正通过校验的写法（成功时才有） */
  verifiedMethod?: InputMethod | null;
  /** 链上每种写法的读回指纹（长度 + 哈希；**不含正文**） */
  readbacks: Array<{ method: InputMethod; ok: boolean; readLength: number; readHash: string; reason?: string }>;
}

/**
 * 写入后的「等重渲染」预算。
 *
 * 为什么不是 0（写完立刻读）：富文本编辑器（Lexical / Draft.js 之类）的更新是**异步**的，
 * 立刻读只能读到旧值 —— 那会把「正常的写入」误判成校验失败，白丢一次发送机会。
 * 为什么不是更大：读回校验本身就是重试循环（`input.retries`），预算由重试兜住，
 * 单次等太久只会让「真的发不出去」这件事更晚被发现。
 */
const DEFAULT_SETTLE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** 归一化：折叠空白、去首尾。等值校验用它 —— 不能因为「多个空格」把正常的写入判成失败 */
export function normalizeComposerText(raw: string): string {
  return String(raw ?? "")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WriteVerdict {
  /** 写入是否被接受（**未接受就绝不提交**） */
  ok: boolean;
  /** 是否走了「包含全文」的宽松判定（`failClosed=false` 才可能） */
  downgraded: boolean;
  /** 失败原因（`ok=false` 时有值） */
  reason?: string;
}

/**
 * 写入校验的**纯判定**（抽出成纯函数是为了能被直接单测 —— 这是红线级逻辑，不许只靠「看着对」）。
 *
 * 口径：
 *   - 读回为 `null`（读不到）→ **不算通过**（读不到就等于无法确认，fail-closed）。
 *   - 归一化后完全相等 → 通过。
 *   - `failClosed=false` 时允许「包含全文」（站点改写了周边，如把链接变卡片）；
 *     仍然**绝不放行**与原文不同的内容。
 */
export function verifyComposerWrite(
  want: string,
  actual: string | null,
  options: { failClosed: boolean },
): WriteVerdict {
  if (actual === null) return { ok: false, downgraded: false, reason: "composer_read_failed" };
  const target = normalizeComposerText(want);
  const got = normalizeComposerText(actual);
  if (got === target) return { ok: true, downgraded: false };
  if (!options.failClosed && target.length > 0 && got.includes(target)) {
    return { ok: true, downgraded: true };
  }
  return { ok: false, downgraded: false, reason: "verify_mismatch" };
}

/**
 * 「提交阶段」的**纯计划**：一次调用里按顺序尝试，每一步成功（输入框已空）就停。
 *
 * `enterOnce` + `elseClick`：先回车；若输入框仍有字再点发送按钮（描述符声明了 elseClick
 * 却从不点按钮 = 现场「字打进输入框却发不出去」）。
 * `sendThenEnter`：先点按钮，仍有字再补回车。
 * 绝不在输入框已空后再补一枪（禁止双发）。
 */
export type CommitStep = "click" | "enter";

export function planCommitSteps(
  method: SendMethod,
  hasButton: boolean,
  elseClick = false,
): CommitStep[] {
  if (method === "click") return hasButton ? ["click"] : [];
  if (method === "enterOnce") {
    if (elseClick && hasButton) return ["enter", "click"];
    return ["enter"];
  }
  // sendThenEnter：有按钮就「点，然后看情况补回车」；没按钮就只回车
  return hasButton ? ["click", "enter"] : ["enter"];
}

/** 读回输入框当前文本（contenteditable 与原生控件各取各的） */
export async function readComposerValue(page: Page, selector: string): Promise<string | null> {
  try {
    return await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value ?? "";
      // contenteditable：innerText 更接近用户看到的样子（换行等）
      const inner = (el as HTMLElement).innerText ?? el.textContent ?? "";
      return inner;
    }, selector);
  } catch {
    return null;
  }
}

/** 找到第一个「存在且可见」的选择器 */
export async function firstVisibleSelector(page: Page, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) {
    const trimmed = String(selector ?? "").trim();
    if (!trimmed) continue;
    try {
      const visible = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
      }, trimmed);
      if (visible) return trimmed;
    } catch {
      /* 选择器不合法：跳过（校验器应已拦下） */
    }
  }
  return null;
}

/** 清空输入框：写失败时**必须**把半截内容清掉，否则它会被后来的人/轮次当作要发的内容 */
async function clearComposer(page: Page, selector: string): Promise<void> {
  try {
    const gateway = resolveGateway(page);
    await gateway.fill(selector, "", { humanLike: true, semanticLabel: "清空聊天输入框" });
  } catch {
    /* 清不掉也只能如实留下；上层已判失败，不会发送 */
  }
}

/** 写入（四种枚举方法之一）——**不做校验**，校验统一在下面 */
async function writeComposer(
  page: Page,
  selector: string,
  method: InputMethod,
  text: string,
  options: ComposerSendOptions,
): Promise<void> {
  const gateway = resolveGateway(page);
  switch (method) {
    case "typeKeys": {
      // **真实按键逐字输入**（最像人、富文本编辑器一律接受）：
      // 全选删除（清掉可能残留的上一句）+ 按节奏逐字打字，完全走真实键事件。
      // 与「合成 beforeinput」相比，它不依赖站点是否监听 `beforeinput` —— 站点改版也照样能用。
      await gateway.fill(selector, text, {
        humanLike: true,
        semanticLabel: options.semanticLabel ?? "聊天输入",
      });
      return;
    }
    case "selectAllBeforeInput": {
      // 富文本 composer（Lexical 系）的**唯一**可靠写法（与保真参考实现一致）：
      //   ① 全选现有内容（Range，而不是 execCommand 的 selectAll）
      //   ② 派发 `beforeinput`（`inputType: "insertText"` + `data` 全文），让编辑器自己替换
      // 为什么不是逐字输入 / execCommand：超过两个字符时编辑器会直接忽略写入，
      // 而 `execCommand` **依然返回 true** —— 「以为写进去了」是最危险的假信号（坑族 J）。
      // 派发失败（不是 contenteditable、页面结构不认识）才退回网关的拟人写入；
      // 两条路都**不看返回值**，由下面的读回等值校验说了算（R8 第④条）。
      const dispatched = await page
        .evaluate(
          (arg: { sel: string; value: string }) => {
            const el = document.querySelector(arg.sel) as HTMLElement | null;
            if (!el) return false;
            try {
              el.focus();
              const selection = window.getSelection();
              if (!selection) return false;
              const range = document.createRange();
              range.selectNodeContents(el);
              selection.removeAllRanges();
              selection.addRange(range);
              el.dispatchEvent(
                new InputEvent("beforeinput", {
                  bubbles: true,
                  cancelable: true,
                  inputType: "insertText",
                  data: arg.value,
                }),
              );
              return true;
            } catch {
              return false;
            }
          },
          { sel: selector, value: text },
        )
        .catch(() => false);
      if (!dispatched) {
        await gateway.fill(selector, text, {
          humanLike: true,
          semanticLabel: options.semanticLabel ?? "聊天输入",
        });
      }
      return;
    }
    case "fill": {
      // Playwright 原生 `fill`（contenteditable 走 `execCommand`）：**返回值不可信**，
      // 且站点可能整个忽略合成写入 —— 所以排在真实按键之后，只作兜底。
      await gateway.fill(selector, text, { semanticLabel: options.semanticLabel ?? "聊天输入" });
      return;
    }
    case "insertText": {
      // CDP insertText：不经按键，直接落到选区（对某些富文本更稳）
      await page.locator(selector).first().focus();
      await page.keyboard.insertText(text);
      return;
    }
    case "execCommand": {
      // 返回值**不可信**（坑族 J）：true 也可能什么都没写 —— 所以调用方一定要读回校验
      await page.evaluate(
        (arg: { sel: string; value: string }) => {
          const el = document.querySelector(arg.sel) as HTMLElement | null;
          if (!el) return;
          el.focus();
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand("insertText", false, arg.value);
        },
        { sel: selector, value: text },
      );
      return;
    }
    default: {
      // 枚举是封闭集合；走到这里说明描述符被篡改了 —— 直接拒绝，不做「猜一个」
      throw new Error(`unsupported_input_method:${String(method)}`);
    }
  }
}

/** 触发提交。每一步后看输入框：已空＝发出；仍有字才试下一步。全部试完仍有字＝失败。 */
async function commitSend(
  page: Page,
  inputSelector: string,
  method: SendMethod,
  spec: ComposerSpec,
  options: ComposerSendOptions,
): Promise<boolean> {
  const gateway = resolveGateway(page);
  const buttonSelector =
    (await firstVisibleSelector(page, spec.send.selectors)) ??
    (spec.send.elseClick ? await nearbySendButton(page, inputSelector) : null);
  const steps = planCommitSteps(method, Boolean(buttonSelector), Boolean(spec.send.elseClick));
  if (steps.length === 0) return false;

  for (const step of steps) {
    if (step === "click") {
      if (!buttonSelector) continue;
      await gateway.click(buttonSelector, { semanticLabel: options.semanticLabel ?? "点击发送" });
      await sleep(DEFAULT_SETTLE_MS);
      if (!normalizeComposerText((await readComposerValue(page, inputSelector)) ?? "")) {
        return true;
      }
      continue;
    }
    await page.locator(inputSelector).first().focus();
    await page.keyboard.press("Enter");
    await sleep(DEFAULT_SETTLE_MS);
    // 回车后输入框空了才算发出；仍有字说明站点没认这次回车（继续 elseClick / 下一步）
    if (!normalizeComposerText((await readComposerValue(page, inputSelector)) ?? "")) {
      return true;
    }
  }
  // 字还在输入框里 = 没发出去（用户现场：草稿停在底栏）
  return false;
}

/** 输入框附近找发送按钮（`send.elseClick` 用；仍要求可见 + 文本/aria 命中发送语义） */
async function nearbySendButton(page: Page, inputSelector: string): Promise<string | null> {
  try {
    return await page.evaluate((sel: string) => {
      const input = document.querySelector(sel) as HTMLElement | null;
      if (!input) return null;
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
      };
      const inputRect = input.getBoundingClientRect();
      const describe = (el: Element): string =>
        `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${
          el.getAttribute("data-testid") ?? ""
        } ${el.textContent ?? ""}`.toLowerCase();
      let index = 0;
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="button"], [type="submit"]'),
      )) {
        index += 1;
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (Math.abs(rect.top - inputRect.top) > Math.max(120, inputRect.height * 4)) continue;
        const desc = describe(el);
        if (!/(send|发送)/.test(desc)) continue;
        el.setAttribute("data-tst-chat-send-fallback", String(index));
        return `[data-tst-chat-send-fallback="${index}"]`;
      }
      return null;
    }, inputSelector);
  } catch {
    return null;
  }
}

/**
 * 出站：写入 → 读回等值校验 → 提交（**最多一次**）。
 *
 * fail-closed 语义（描述符的 `composer.input.failClosed`）：
 *   - `true`（推荐）：等值校验不过 → **取消发送并清空输入框**，如实返回原因。
 *   - `false`：允许退一步用「输入框**包含**全文」判定（应对站点把链接/表情重写的场景），
 *     仍然**绝不**发送与原文不同的内容，也**绝不**在写入失败时提交。
 */
export async function sendViaComposer(
  page: Page,
  spec: ComposerSpec,
  text: string,
  options: ComposerSendOptions = {},
): Promise<ComposerSendResult> {
  const content = String(text ?? "").trim();
  if (!content) return { ok: false, reason: "empty_text" };

  const inputSelector = await firstVisibleSelector(page, spec.selectors);
  if (!inputSelector) return { ok: false, reason: "composer_not_found" };

  const retries = Math.max(0, Math.min(3, spec.input.retries));
  const settle = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
  let attempts = 0;
  const methods = methodOrder(spec.input.method);
  const readbacks: ComposerDiagnostics["readbacks"] = [];
  // 声明的写法失败的**原因**要单独留下：健康度要据此提示「请修描述符」，
  // 而链上后面的写法（本就是为了兜住描述符写错）失败不该顶掉这条诊断。
  let declaredReason: string | null = null;
  let lastReason = "verify_failed";
  let verifiedMethod: InputMethod | null = null;

  for (const method of methods) {
    if (verifiedMethod) break;
    // 声明的写法按 `retries` 重试（站点偶发抖动）；**兜底写法各只试一次** ——
    // 同一种写法的第二次重试几乎必然同样失败，继续试只是浪费（而且 `typeKeys` 是逐字按键，很慢）。
    const perMethod = method === spec.input.method ? retries + 1 : 1;
    for (let round = 0; round < perMethod; round += 1) {
      if (options.signal?.aborted) {
        return { ok: false, reason: "aborted", attempts, diagnostics: diag() };
      }
      attempts += 1;
      // 逐键输入绝不能把换行当字符打进去：`\n` 会被站点当成「回车发送」→ 半截话先飞出去（违背「只发一次」）
      const typed = typedTextFor(method, content);
      try {
        await writeComposer(page, inputSelector, method, typed, options);
      } catch (error) {
        // 写入本身失败：清干净（半截内容会被后来的人/轮次当作要发的内容）
        await clearComposer(page, inputSelector);
        const reason = `write_failed:${error instanceof Error ? error.message : String(error)}`;
        readbacks.push({ method, ok: false, readLength: 0, readHash: "", reason });
        lastReason = reason;
        if (method === spec.input.method) declaredReason = reason;
        continue;
      }

      if (settle > 0) await sleep(settle);
      const actual = await readComposerValue(page, inputSelector);
      const verdict = verifyComposerWrite(content, actual, { failClosed: spec.input.failClosed });
      readbacks.push({
        method,
        ok: verdict.ok,
        readLength: String(actual ?? "").length,
        readHash: fingerprint(actual),
        reason: verdict.ok ? undefined : verdict.reason,
      });
      if (verdict.ok) {
        verifiedMethod = method;
        break;
      }
      // 校验不过就**清空**再换下一种写法：留着半截内容会让下一种写法的读回判定不可信
      await clearComposer(page, inputSelector);
      const reason = `${verdict.reason ?? "verify_failed"}:${spec.input.verify}`;
      lastReason = reason;
      if (method === spec.input.method && declaredReason === null) declaredReason = reason;
    }
  }

  function diag(): ComposerDiagnostics {
    return { selector: inputSelector ?? "", declaredMethod: spec.input.method, verifiedMethod, readbacks };
  }

  if (!verifiedMethod) {
    return {
      ok: false,
      // 声明的写法没通过 → 报它的原因（健康度据此指向描述符）；声明写法通过后又被兜底顶掉不可能发生
      reason: declaredReason ?? lastReason,
      verified: false,
      attempts,
      diagnostics: diag(),
    };
  }

  // 提交前最后一道：内容仍然是我们要发的那句（防「写入后站点自己改了」）
  const beforeSend = verifyComposerWrite(content, await readComposerValue(page, inputSelector), {
    failClosed: true,
  });
  if (!beforeSend.ok) {
    await clearComposer(page, inputSelector);
    return {
      ok: false,
      reason: "verify_lost_before_send",
      verified: true,
      attempts,
      inputMethod: verifiedMethod,
      diagnostics: diag(),
    };
  }

  let committed = false;
  try {
    committed = await commitSend(page, inputSelector, spec.send.method, spec, options);
  } catch (error) {
    return {
      ok: false,
      reason: `send_failed:${error instanceof Error ? error.message : String(error)}`,
      verified: true,
      committed: false,
      attempts,
      inputMethod: verifiedMethod,
      sendMethod: spec.send.method,
      diagnostics: diag(),
    };
  }
  if (!committed) {
    // 字还在框里：清掉半截草稿，避免下一轮读回当真、用户也以为「发出去了」
    await clearComposer(page, inputSelector);
    return {
      ok: false,
      reason: "send_not_cleared",
      verified: true,
      committed: false,
      attempts,
      inputMethod: verifiedMethod,
      sendMethod: spec.send.method,
      diagnostics: diag(),
    };
  }

  return {
    ok: true,
    verified: true,
    committed: true,
    attempts,
    inputMethod: verifiedMethod,
    sendMethod: spec.send.method,
    diagnostics: diag(),
  };
}

/**
 * 写入策略的**兜底链**（§0.5.3 J）：描述符声明的写法永远第一个试，之后按可靠度依次再试。
 *
 * 为什么必须有一条链（而不是「描述符写错就永远发不出去」）：写入方式与**站点版本**强相关 ——
 * 同一个 Telegram 的「K 版」与「A 版」对合成 `beforeinput` 的接受度就不同；而**真实按键
 * （`typeKeys`）永远是最接近人的那条路**。描述符猜错了只该让健康度记一笔「请修描述符」，
 * 不该等于「这个人永远收不到消息」。
 *
 * 纪律不变：每一种写法**都过同一条读回等值校验**，任何一步不相等都不提交（fail-closed）。
 */
const INPUT_METHOD_RELIABILITY: readonly InputMethod[] = [
  "typeKeys",
  "selectAllBeforeInput",
  "insertText",
  "fill",
  "execCommand",
];

export function methodOrder(declared: InputMethod): InputMethod[] {
  return [declared, ...INPUT_METHOD_RELIABILITY.filter((method) => method !== declared)];
}

/**
 * 逐键输入前把换行折成空格。
 *
 * `pressSequentially` 会把 `\n` 当成**真实回车**打进去，而聊天站点的回车就是「发送」——
 * 那会在半句话上先发一条出去（直接违背「一次调用最多一次提交」）。折行只影响**按键路径**：
 * 读回校验本来就折叠空白，所以「多行草稿」在按键路径上按单行发出，语义不丢。
 */
function typedTextFor(method: InputMethod, content: string): string {
  if (method !== "typeKeys") return content;
  return content.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** 读回的**指纹**（长度 + 哈希）：诊断里只说「读到了多少」，绝不落正文 */
function fingerprint(raw: string | null): string {
  if (raw === null) return "null";
  const normalized = normalizeComposerText(raw);
  return `h${hash32(normalized)}`;
}
