/**
 * OmniActionGateway — 全态动作网关与闭环执行引擎。
 *
 * 四大流水线（唯一权威入口）：
 * 1. 目标解析与 DOM 攀爬反推
 * 2. 物理执行与抗干扰（focus + force/delay）
 * 3. 全局交接稳定屏障（networkidle + 硬缓冲）
 * 4. 高保真轨迹闭环落盘
 *
 * 禁止站点 Heuristic 状态机绕过本网关直接 page.click / mouse.click。
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { Locator, Page } from "playwright-core";

import {
  NO_OFFSET,
  scopePage,
  toPagePoint,
  type DomScope,
  type FrameOffset,
} from "./dom_scope.js";
import type { JsonLogger } from "../json-logger.js";
import { normalizeFieldValue } from "./fill_verify.js";
import type { TrajectoryPostCondition, TrajectoryStep } from "../trajectory.js";
import { isTempIdSelector } from "../trajectory.js";

/** 网关对外统一轨迹载荷（回放 100% 复现契约） */
export interface OmniActionTrajectory {
  actionType: "navigate" | "click" | "fill" | "scroll";
  /** 攀爬后强特征，或逻辑模型原始选择器 */
  primarySelector: string;
  /**
   * 坐标保底：优先 `unit:"relative"`（视口 0–1 比例），旧轨迹可能为像素。
   * 禁止只存屏幕绝对像素而不带 viewport/relative。
   */
  fallbackCoordinates?: TrajectoryCoord;
  /** 仅 fill */
  value?: string;
  /** 沙盘语义展示 */
  semanticLabel?: string;
  /** fill：冗余 inputType，供沙盘/回放 */
  inputType?: string;
  /**
   * 写入被跳过及其原因。`identical` = 字段内容**已经就是要写的值**，
   * 因此没有清空、也没有重新逐字输入。
   *
   * 为什么必须有这个信号：拟人写入的第一步是「全选 + 删除」，只要目标字段已有内容，
   * 跳过判定失效就会让用户看到「内容被清掉再重新打一遍」。而且重复写入在有副作用的字段
   * （重发验证码、触发校验、清空已输入的下拉选择）上不只是难看，是会改变页面状态的。
   */
  skipped?: "identical";
}

/** 落盘/回放坐标：relative=视口比例；px=像素（旧） */
export type TrajectoryCoord = {
  x: number;
  y: number;
  unit?: "relative" | "px";
};

export interface ResolvedDomTarget {
  primarySelector: string;
  semanticLabel: string;
  tagName: string;
  role: string;
  fallbackCoordinates?: TrajectoryCoord;
}

/**
 * 视口像素 → 相对坐标（0–1）。回放时乘以当前 viewport，避免分辨率/缩放漂移。
 */
export function absoluteToRelativeCoord(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): TrajectoryCoord {
  const w = Math.max(1, viewportWidth);
  const h = Math.max(1, viewportHeight);
  return {
    x: Math.min(1, Math.max(0, x / w)),
    y: Math.min(1, Math.max(0, y / h)),
    unit: "relative",
  };
}

/**
 * 将落盘坐标还原为当前视口像素。
 * - unit=relative，或未标注且 x/y 均落在 [0,1]：按比例
 * - 否则：按录制 viewport 与当前 viewport 做线性缩放（兼容旧绝对像素）
 */
export function resolveCoordToViewportPixels(
  coords: { x: number; y: number; unit?: string },
  viewport: { width: number; height: number },
  recordedViewport?: { w: number; h: number } | null,
): { x: number; y: number } {
  const x = Number(coords.x);
  const y = Number(coords.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { x: NaN, y: NaN };
  }
  const unit = coords.unit;
  const looksRelative =
    unit === "relative" ||
    (unit !== "px" && x >= 0 && x <= 1 && y >= 0 && y <= 1);
  if (looksRelative) {
    return {
      x: Math.round(x * Math.max(1, viewport.width)),
      y: Math.round(y * Math.max(1, viewport.height)),
    };
  }
  const recorded = recordedViewport ?? {
    w: viewport.width,
    h: viewport.height,
  };
  const scaleX = recorded.w > 0 ? viewport.width / recorded.w : 1;
  const scaleY = recorded.h > 0 ? viewport.height / recorded.h : 1;
  return {
    x: Math.round(x * scaleX),
    y: Math.round(y * scaleY),
  };
}

export type OmniGatewayRecorder = (snapshot: Omit<TrajectoryStep, "step">) => void;

export interface OmniActionGatewayOptions {
  record?: OmniGatewayRecorder;
  logger?: JsonLogger;
}

/** 单次动作执行选项；record 默认 true（Agent）；fill/RPA 传 false */
export interface OmniActionOptions {
  /** 是否写入轨迹；默认 true */
  record?: boolean;
  skipSettle?: boolean;
  semanticLabel?: string;
  /** fill：拟人逐键输入 */
  humanLike?: boolean;
  /** fill：不清空、在现有内容后追加（仍落盘为 fill，回放会整框重填该 value） */
  append?: boolean;
  distance?: number;
  alreadyNavigated?: boolean;
  timeoutMs?: number;
  /**
   * 元素所在文档；缺省 = 主文档。
   * 选择器在该文档内解析，物理鼠标/键盘仍由 Page 发出（坐标由网关换算）。
   */
  scope?: DomScope;
  /** 嵌套框架相对主文档视口的偏移；`scope` 为框架时必填 */
  offset?: FrameOffset;
}

export type ClickTarget = string | { x: number; y: number } | Locator;
export type FillTarget = string | Locator;

const ACTION_TIMEOUT_MS = 5_000;
const ACTION_DELAY_MS = 50;
const SETTLE_NETWORK_IDLE_MS = 4_000;
const SETTLE_HARD_BUFFER_MS = 1_000;
const KEYSTROKE_DELAY_MS = 50;

type PageSource = Page | (() => Page);

const gatewayAls = new AsyncLocalStorage<OmniActionGateway>();

export function runWithGateway<T>(
  gateway: OmniActionGateway,
  fn: () => Promise<T>,
): Promise<T> {
  return gatewayAls.run(gateway, fn);
}
export function getActiveGateway(): OmniActionGateway | null {
  return gatewayAls.getStore() ?? null;
}
/** Agent 用绑定实例；Fill/RPA 无绑定时创建临时网关（默认不挂 recorder） */
export function resolveGateway(page: Page): OmniActionGateway {
  return getActiveGateway() ?? new OmniActionGateway(page);
}

function sanitizeLabel(value: string, max = 80): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 阶段一：坐标 → DOM 攀爬 → 多维强特征选择器
 * （纯页面内逻辑，零站点硬编码）
 *
 * 坐标为**主文档视口**坐标：嵌套框架时按 `offset` 换算成框架局部坐标再做攀爬，
 * 所以调用方永远只需要一套坐标系。
 */
export async function resolveTargetFromPoint(
  scope: DomScope,
  x: number,
  y: number,
  options: { offset?: FrameOffset; viewport?: { width: number; height: number } } = {},
): Promise<ResolvedDomTarget> {
  const owner = scopePage(scope);
  const vp = options.viewport ?? owner.viewportSize() ?? { width: 1280, height: 720 };
  const relative = absoluteToRelativeCoord(x, y, vp.width, vp.height);
  const clientX = Math.round(x - (options.offset?.x ?? 0));
  const clientY = Math.round(y - (options.offset?.y ?? 0));
  try {
    const hit = await scope.evaluate(
      ({ clientX: cx, clientY: cy }: { clientX: number; clientY: number }) => {
        const cssEscape = (value: string): string => {
          if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
            return CSS.escape(value);
          }
          return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
        };

        const buildNthPath = (node: Element): string => {
          const parts: string[] = [];
          let cur: Element | null = node;
          while (cur && cur.nodeType === 1 && parts.length < 10) {
            const parent: Element | null = cur.parentElement;
            const tag = cur.tagName.toLowerCase();
            if (!parent || tag === "html") {
              parts.unshift(tag);
              break;
            }
            if (tag === "body") {
              parts.unshift("body");
              break;
            }
            const siblings = Array.from(parent.children).filter(
              (c) => c.tagName === cur!.tagName,
            );
            if (siblings.length <= 1) {
              parts.unshift(tag);
            } else {
              const idx = siblings.indexOf(cur) + 1;
              parts.unshift(`${tag}:nth-of-type(${idx})`);
            }
            cur = parent;
          }
          return parts.join(" > ");
        };

        let el: Element | null = document.elementFromPoint(clientX, clientY);
        if (!el) {
          return null;
        }

        // 向上攀爬寻祖：跳过无意义 span/img 叶子，锚定交互载体
        const interactiveEl =
          (el.closest(
            'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="option"], [tabindex], [onclick]',
          ) as HTMLElement | null) || (el as HTMLElement);

        const aria = (interactiveEl.getAttribute("aria-label") || "").trim();
        const title = (interactiveEl.getAttribute("title") || "").trim();
        const alt = (interactiveEl.getAttribute("alt") || "").trim();
        const name = (interactiveEl.getAttribute("name") || "").trim();
        const text = (interactiveEl.innerText || interactiveEl.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const semanticLabel = (aria || title || alt || text || interactiveEl.tagName).slice(
          0,
          80,
        );

        const id = (interactiveEl.id || "").trim();
        const dataTest =
          (interactiveEl.getAttribute("data-testid") ||
            interactiveEl.getAttribute("data-test") ||
            interactiveEl.getAttribute("data-qa") ||
            "").trim();
        const href = (interactiveEl.getAttribute("href") || "").trim();
        const src =
          ((interactiveEl as HTMLImageElement).currentSrc ||
            interactiveEl.getAttribute("src") ||
            "").trim();
        const role = (interactiveEl.getAttribute("role") || "").trim();
        const tag = interactiveEl.tagName.toLowerCase();

        let primarySelector = "";
        // 优先级：id → aria/name/data-testid → 标签属性 → nth-child 绝对路径
        if (id && !/^\d+$/.test(id)) {
          primarySelector = `#${cssEscape(id)}`;
        } else if (dataTest) {
          primarySelector = `[data-testid="${dataTest.replace(/"/g, '\\"')}"]`;
        } else if (aria) {
          primarySelector = `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        } else if (name && /^(input|select|textarea|button)$/i.test(tag)) {
          primarySelector = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        } else if (tag === "a" && href && !href.startsWith("javascript:")) {
          const shortHref = href.length > 120 ? href.slice(0, 120) : href;
          primarySelector = `a[href="${shortHref.replace(/"/g, '\\"')}"]`;
        } else if (tag === "img" && alt) {
          primarySelector = `img[alt="${alt.replace(/"/g, '\\"')}"]`;
        } else if ((tag === "img" || interactiveEl.querySelector?.("img")) && src) {
          const leaf = src.split("/").pop() || src;
          const token = leaf.slice(0, 48).replace(/"/g, "");
          if (token) {
            primarySelector = `img[src*="${token}"]`;
          }
        }

        // 终极保底：带层级的 nth-of-type 路径（禁止单薄 span）
        if (!primarySelector || primarySelector === "span" || primarySelector === "div") {
          primarySelector = buildNthPath(interactiveEl);
        }

        return {
          primarySelector,
          semanticLabel,
          tagName: tag,
          role,
        };
      },
      { clientX, clientY },
    );

    if (hit?.primarySelector) {
      return {
        primarySelector: String(hit.primarySelector).trim(),
        semanticLabel: sanitizeLabel(hit.semanticLabel) || "（未知控件）",
        tagName: hit.tagName,
        role: hit.role,
        fallbackCoordinates: relative,
      };
    }
  } catch {
    /* fall through */
  }

  return {
    primarySelector: "",
    semanticLabel: "（坐标点击）",
    tagName: "",
    role: "",
    fallbackCoordinates: relative,
  };
}

/** 将网关轨迹映射为现有 TrajectoryStep（兼容落盘 / 回放） */
export function omniTrajectoryToStep(
  payload: OmniActionTrajectory,
  extras?: {
    url?: string;
    postCondition?: TrajectoryPostCondition;
    viewport?: { w: number; h: number };
  },
): Omit<TrajectoryStep, "step"> {
  const semanticLabel =
    sanitizeLabel(payload.semanticLabel || "") ||
    (payload.actionType === "fill"
      ? sanitizeLabel(payload.primarySelector || "") || "（填写）"
      : sanitizeLabel(payload.primarySelector || "") || undefined);
  return {
    type: payload.actionType,
    selector: payload.primarySelector || "",
    primarySelector: payload.primarySelector || undefined,
    fallbackSelector: payload.primarySelector || undefined,
    fallbackCoordinates: payload.fallbackCoordinates,
    x: payload.fallbackCoordinates?.x,
    y: payload.fallbackCoordinates?.y,
    value: payload.value,
    semanticLabel,
    label: semanticLabel,
    inputType: payload.inputType,
    url: extras?.url,
    postCondition: extras?.postCondition,
    viewport: extras?.viewport,
  };
}

export class OmniActionGateway {
  private readonly getPage: () => Page;
  private readonly recordFn?: OmniGatewayRecorder;
  private readonly logger?: JsonLogger;

  constructor(pageOrGetter: PageSource, options?: OmniActionGatewayOptions) {
    this.getPage = typeof pageOrGetter === "function" ? pageOrGetter : () => pageOrGetter;
    this.recordFn = options?.record;
    this.logger = options?.logger;
  }

  page(): Page {
    return this.getPage();
  }

  /** 阶段四：统一落盘（仅 record!==false 时调用）；残次 click 丢弃 */
  pushTrajectory(payload: OmniActionTrajectory, extras?: {
    url?: string;
    postCondition?: TrajectoryPostCondition;
    viewport?: { w: number; h: number };
  }): void {
    if (payload.actionType === "click") {
      const primary = String(payload.primarySelector ?? "").trim();
      const coords = payload.fallbackCoordinates;
      const hasCoords =
        Boolean(coords) &&
        Number.isFinite(coords!.x) &&
        Number.isFinite(coords!.y);
      if (!primary && !hasCoords) {
        this.logger?.warn("omni_gateway_discard_click_incomplete", {
          actionType: payload.actionType,
          semanticLabel: payload.semanticLabel ?? "",
          url: extras?.url,
        });
        return;
      }
    }

    const normalized: OmniActionTrajectory = {
      ...payload,
      semanticLabel:
        sanitizeLabel(payload.semanticLabel || "") ||
        (payload.actionType === "fill"
          ? sanitizeLabel(payload.primarySelector || "") || "（填写）"
          : payload.semanticLabel),
    };

    const step = omniTrajectoryToStep(normalized, extras);
    const selector = step.selector ?? "";
    if (selector && isTempIdSelector(selector)) {
      this.logger?.warn("omni_gateway_skip_temp_id", {
        actionType: payload.actionType,
        selector,
      });
      return;
    }
    this.recordFn?.(step);
    this.logger?.progress("omni_gateway_action", {
      actionType: payload.actionType,
      primarySelector: payload.primarySelector,
      semanticLabel: step.semanticLabel ?? "",
      inputType: step.inputType ?? "",
      hasCoords: Boolean(payload.fallbackCoordinates),
      url: extras?.url,
    });
  }

  private shouldRecord(options?: OmniActionOptions): boolean {
    return options?.record !== false;
  }

  private commitIfRecording(
    options: OmniActionOptions | undefined,
    payload: OmniActionTrajectory,
    extras?: {
      url?: string;
      postCondition?: TrajectoryPostCondition;
      viewport?: { w: number; h: number };
    },
  ): void {
    if (!this.shouldRecord(options)) {
      return;
    }
    this.pushTrajectory(payload, extras);
  }

  private actionTimeout(options?: OmniActionOptions): number {
    return options?.timeoutMs ?? ACTION_TIMEOUT_MS;
  }

  /** 阶段三：全局交接稳定屏障 */
  async settleBarrier(page: Page = this.page()): Promise<void> {
    await page
      .waitForLoadState("networkidle", { timeout: SETTLE_NETWORK_IDLE_MS })
      .catch(() => undefined);
    try {
      await page.waitForTimeout(SETTLE_HARD_BUFFER_MS);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_HARD_BUFFER_MS));
    }
  }

  async capturePostCondition(page: Page = this.page()): Promise<TrajectoryPostCondition> {
    const url = page.url();
    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "";
    }
    return { url, title };
  }

  /**
   * 阶段一辅助：选择器目标也可再校验语义标签。
   * `scope` 决定选择器在哪个文档里解析；`offset` 用于把页面级坐标回算成框架局部坐标做攀爬。
   */
  async enrichSelectorTarget(
    selector: string,
    hintLabel?: string,
    scope: DomScope = this.page(),
    offset: FrameOffset = NO_OFFSET,
    viewport?: { width: number; height: number },
  ): Promise<ResolvedDomTarget> {
    const page = this.page();
    const primarySelector = selector.trim();
    let semanticLabel = sanitizeLabel(hintLabel || "");
    let fallbackCoordinates: TrajectoryCoord | undefined;
    const vp = viewport ?? page.viewportSize() ?? { width: 1280, height: 720 };
    if (primarySelector) {
      try {
        const loc = scope.locator(primarySelector).first();
        if (!semanticLabel) {
          const raw =
            (await loc.getAttribute("aria-label").catch(() => null)) ||
            (await loc.innerText().catch(() => "")) ||
            "";
          semanticLabel = sanitizeLabel(raw) || primarySelector;
        }
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width >= 0 && box.height >= 0) {
          fallbackCoordinates = absoluteToRelativeCoord(
            box.x + box.width / 2,
            box.y + box.height / 2,
            vp.width,
            vp.height,
          );
        }
      } catch {
        semanticLabel = semanticLabel || primarySelector;
      }
    }
    return {
      primarySelector,
      semanticLabel: semanticLabel || primarySelector || "（点击）",
      tagName: "",
      role: "",
      fallbackCoordinates,
    };
  }

  private async resolveClickTarget(
    target: ClickTarget,
    hintLabel: string | undefined,
    scope: DomScope,
    offset: FrameOffset,
    viewport: { width: number; height: number },
  ): Promise<ResolvedDomTarget> {
    if (typeof target === "string") {
      return this.enrichSelectorTarget(target, hintLabel, scope, offset, viewport);
    }
    if ("x" in target && "y" in target) {
      const resolved = await resolveTargetFromPoint(scope, target.x, target.y, {
        offset,
        viewport,
      });
      if (hintLabel) {
        resolved.semanticLabel = sanitizeLabel(hintLabel) || resolved.semanticLabel;
      }
      return resolved;
    }
    // Locator：取中心点再攀爬，避免脆弱的临时句柄
    const box = await target.boundingBox().catch(() => null);
    if (box) {
      const resolved = await resolveTargetFromPoint(
        scope,
        box.x + box.width / 2,
        box.y + box.height / 2,
        { offset, viewport },
      );
      if (hintLabel) {
        resolved.semanticLabel = sanitizeLabel(hintLabel) || resolved.semanticLabel;
      }
      return resolved;
    }
    return {
      primarySelector: "",
      semanticLabel: sanitizeLabel(hintLabel || "") || "（点击）",
      tagName: "",
      role: "",
    };
  }

  /**
   * 阶段二：强制聚焦 + force/delay 抗干扰点击
   * `scope` 决定选择器在哪个文档里解析；坐标路径的 `fallbackCoordinates` 已是主文档视口相对坐标。
   */
  private async physicalClick(
    resolved: ResolvedDomTarget,
    scope: DomScope = this.page(),
    offset: FrameOffset = NO_OFFSET,
  ): Promise<void> {
    const page = this.page();
    const selector = resolved.primarySelector;
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };

    if (selector && !isTempIdSelector(selector)) {
      const locator = scope.locator(selector).first();
      const attached = await locator.count().catch(() => 0);
      if (attached > 0) {
        await locator.focus({ timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
        try {
          await locator.click({
            force: true,
            delay: ACTION_DELAY_MS,
            timeout: ACTION_TIMEOUT_MS,
          });
          return;
        } catch {
          /* fall through to coordinates */
        }
      }
    }

    const coords = resolved.fallbackCoordinates;
    if (coords) {
      const pixel = resolveCoordToViewportPixels(coords, vp);
      if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) {
        throw new Error("OmniActionGateway.click：坐标无效");
      }
      // 坐标路径：先尝试 focus 攀爬元素，再 mouse.click
      // `pixel` 是主文档视口坐标；框架内部的 `elementFromPoint` 需要框架局部坐标，故按 offset 回算
      const localX = pixel.x - offset.x;
      const localY = pixel.y - offset.y;
      await scope
        .evaluate(
          ({ clientX, clientY }: { clientX: number; clientY: number }) => {
            const el = document.elementFromPoint(clientX, clientY);
            const target =
              (el?.closest(
                'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [tabindex]',
              ) as HTMLElement | null) || (el as HTMLElement | null);
            try {
              target?.focus?.({ preventScroll: true });
            } catch {
              /* ignore */
            }
          },
          { clientX: localX, clientY: localY },
        )
        .catch(() => undefined);
      try {
        await page.mouse.click(pixel.x, pixel.y, { delay: ACTION_DELAY_MS });
      } catch {
        await page.mouse.click(pixel.x, pixel.y);
      }
      return;
    }

    throw new Error("OmniActionGateway.click：无法解析可执行目标（无 selector / 坐标）");
  }

  /** 点击流水线：解析 → 执行 → 屏障 →（可选）落盘 */
  async click(
    target: ClickTarget,
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    const page = this.page();
    const box = page.viewportSize() ?? { width: 1280, height: 720 };
    const timeout = this.actionTimeout(options);
    // 元素所在文档：主文档 = page；嵌套框架 = frame（选择器在框架内解析）
    const scope = options?.scope ?? page;
    const offset = options?.offset ?? NO_OFFSET;

    // Locator：优先直点（抗干扰），再反推语义供落盘
    if (typeof target !== "string" && !("x" in target)) {
      const locator = target.first();
      await locator.focus({ timeout }).catch(() => undefined);
      try {
        await locator.click({ force: true, delay: ACTION_DELAY_MS, timeout });
      } catch {
        await locator.click({ force: true, timeout }).catch(() => undefined);
      }
      const hitBox = await locator.boundingBox().catch(() => null);
      let resolved: ResolvedDomTarget = {
        primarySelector: "",
        semanticLabel: sanitizeLabel(options?.semanticLabel || "") || "（点击）",
        tagName: "",
        role: "",
      };
      if (hitBox) {
        resolved = await resolveTargetFromPoint(
          scope,
          hitBox.x + hitBox.width / 2,
          hitBox.y + hitBox.height / 2,
          { offset, viewport: box },
        );
        if (!resolved.fallbackCoordinates) {
          resolved.fallbackCoordinates = absoluteToRelativeCoord(
            hitBox.x + hitBox.width / 2,
            hitBox.y + hitBox.height / 2,
            box.width,
            box.height,
          );
        }
        if (options?.semanticLabel) {
          resolved.semanticLabel =
            sanitizeLabel(options.semanticLabel) || resolved.semanticLabel;
        }
      }
      const payload: OmniActionTrajectory = {
        actionType: "click",
        primarySelector: resolved.primarySelector,
        fallbackCoordinates: resolved.fallbackCoordinates,
        semanticLabel: resolved.semanticLabel,
      };
      const postCondition = await this.capturePostCondition(page);
      if (!options?.skipSettle) {
        await this.settleBarrier(page);
      }
      this.commitIfRecording(options, payload, {
        url: page.url(),
        postCondition,
        viewport: { w: box.width, h: box.height },
      });
      return payload;
    }

    const resolved = await this.resolveClickTarget(target, options?.semanticLabel, scope, offset, box);
    await this.physicalClick(resolved, scope, offset);

    // 字符串/xpath 点击：若攀爬未带坐标，用当前 selector 中心补相对坐标
    if (!resolved.fallbackCoordinates && resolved.primarySelector) {
      const loc = scope.locator(resolved.primarySelector).first();
      const hitBox = await loc.boundingBox().catch(() => null);
      if (hitBox) {
        resolved.fallbackCoordinates = absoluteToRelativeCoord(
          hitBox.x + hitBox.width / 2,
          hitBox.y + hitBox.height / 2,
          box.width,
          box.height,
        );
      }
    }

    const payload: OmniActionTrajectory = {
      actionType: "click",
      primarySelector: resolved.primarySelector,
      fallbackCoordinates: resolved.fallbackCoordinates,
      semanticLabel: resolved.semanticLabel,
    };

    const postCondition = await this.capturePostCondition(page);
    if (!options?.skipSettle) {
      await this.settleBarrier(page);
    }
    this.commitIfRecording(options, payload, {
      url: page.url(),
      postCondition,
      viewport: { w: box.width, h: box.height },
    });
    return payload;
  }

  /** 视觉坐标点击（语义反推 + 可选落盘） */
  async pointClick(
    x: number,
    y: number,
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    return this.click({ x, y }, options);
  }

  /** 填写流水线 */
  async fill(
    target: FillTarget,
    value: string,
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    const page = this.page();
    const timeout = this.actionTimeout(options);
    const scope = options?.scope ?? page;
    const offset = options?.offset ?? NO_OFFSET;
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    let primarySelector = "";
    let semanticLabel = sanitizeLabel(options?.semanticLabel || "");
    let locator: Locator;

    if (typeof target === "string") {
      primarySelector = target.trim();
      locator = scope.locator(primarySelector).first();
    } else {
      locator = target.first();
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        const resolved = await resolveTargetFromPoint(
          scope,
          box.x + box.width / 2,
          box.y + box.height / 2,
          { offset, viewport },
        );
        primarySelector = resolved.primarySelector;
        semanticLabel = semanticLabel || resolved.semanticLabel;
      }
    }

    await locator.focus({ timeout }).catch(() => undefined);
    const humanLike = options?.humanLike === true;
    const append = options?.append === true;
    // 幂等前置：目标字段里**已经就是**要写的值 → 什么都不做。
    // 「全选+删除+逐字重打」是可见的（内容被清掉再打一遍），在重发验证码/触发校验类字段上
    // 更是实打实的副作用。模型重复发同一个 input 时不应该被惩罚成一次清空重写。
    if (!append && value.length > 0) {
      const current = await locator.inputValue({ timeout: 1_000 }).catch(() => null);
      if (current != null && normalizeFieldValue(current) === normalizeFieldValue(value)) {
        if (!semanticLabel) semanticLabel = primarySelector || "（填写）";
        const skippedPayload: OmniActionTrajectory = {
          actionType: "fill",
          primarySelector,
          value,
          semanticLabel,
          skipped: "identical",
        };
        if (!options?.skipSettle) {
          await this.settleBarrier(page);
        }
        this.commitIfRecording(options, skippedPayload, { url: page.url() });
        return skippedPayload;
      }
    }
    if (append) {
      await locator.click({ timeout }).catch(() => undefined);
      // 追加语义必须落在文本末尾：点击落点决定光标位置，不修正会插到中间
      await locator.press("End", { timeout }).catch(() => undefined);
      if (value.length > 0) {
        await locator.pressSequentially(value, {
          delay: KEYSTROKE_DELAY_MS,
          timeout: Math.max(timeout, value.length * (KEYSTROKE_DELAY_MS + 10) + 1500),
        });
      }
    } else if (humanLike) {
      await locator.press("Control+a", { timeout }).catch(() => undefined);
      await locator.press("Backspace", { timeout }).catch(() => undefined);
      if (value.length > 0) {
        await locator.focus({ timeout }).catch(() => undefined);
        await locator.pressSequentially(value, {
          delay: KEYSTROKE_DELAY_MS,
          timeout: Math.max(timeout, value.length * (KEYSTROKE_DELAY_MS + 10) + 1500),
        });
      }
    } else {
      await locator
        .fill(value, { force: true, timeout })
        .catch(async () => {
          await locator.fill("").catch(() => undefined);
          await locator.pressSequentially(value, {
            delay: ACTION_DELAY_MS,
            timeout,
          });
        });
    }

    if (!semanticLabel) {
      semanticLabel = primarySelector || "（填写）";
    }

    const payload: OmniActionTrajectory = {
      actionType: "fill",
      primarySelector,
      value,
      semanticLabel,
    };

    if (!options?.skipSettle) {
      await this.settleBarrier(page);
    }
    this.commitIfRecording(options, payload, { url: page.url() });
    return payload;
  }

  /** 滚动流水线 */
  async scroll(
    direction: "up" | "down" | "bottom",
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    const page = this.page();
    const distance = Math.min(Math.max(Number(options?.distance) || 600, 50), 4000);
    await page.evaluate(
      ({ direction: dir, distance: dist }) => {
        if (dir === "bottom") {
          window.scrollTo(0, document.documentElement.scrollHeight);
          return;
        }
        window.scrollBy(0, dir === "up" ? -dist : dist);
      },
      { direction, distance },
    );

    const payload: OmniActionTrajectory = {
      actionType: "scroll",
      primarySelector: "",
      value: direction,
      semanticLabel: `滚动 ${direction}`,
    };

    if (!options?.skipSettle) {
      await this.settleBarrier(page);
    }
    this.commitIfRecording(options, payload, { url: page.url() });
    return payload;
  }

  /** 导航落盘（实际 goto 可由调用方完成，或走本方法） */
  async navigate(
    url: string,
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    const page = this.page();
    if (!options?.alreadyNavigated) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    }
    const finalUrl = page.url() || url;
    if (!options?.skipSettle) {
      await this.settleBarrier(page);
    }
    const postCondition = await this.capturePostCondition(page);
    const payload: OmniActionTrajectory = {
      actionType: "navigate",
      primarySelector: "",
      value: finalUrl,
      semanticLabel: finalUrl,
    };
    this.commitIfRecording(options, payload, {
      url: finalUrl,
      postCondition,
    });
    return payload;
  }

  /** 兼容：仅录导航（goto 已在外部完成） */
  recordNavigate(finalUrl: string, postCondition?: TrajectoryPostCondition): void {
    this.pushTrajectory(
      {
        actionType: "navigate",
        primarySelector: "",
        value: finalUrl,
        semanticLabel: finalUrl,
      },
      { url: finalUrl, postCondition },
    );
  }

  /** 复杂自愈填表后的强制落盘（物理已在外部经网关或需补录） */
  recordFill(partial: {
    selector: string;
    value: string;
    label?: string;
  }): void {
    this.pushTrajectory(
      {
        actionType: "fill",
        primarySelector: partial.selector,
        value: partial.value,
        semanticLabel: partial.label,
      },
      { url: this.page().url() },
    );
  }

  recordClick(partial: {
    selector: string;
    label?: string;
    coords?: { x: number; y: number };
    postCondition?: TrajectoryPostCondition;
  }): void {
    this.pushTrajectory(
      {
        actionType: "click",
        primarySelector: partial.selector,
        fallbackCoordinates: partial.coords,
        semanticLabel: partial.label,
      },
      { url: this.page().url(), postCondition: partial.postCondition },
    );
  }

  /** 扩展类型（wait / keypress / select）直接写入 recorder */
  recordStep(step: Omit<TrajectoryStep, "step">): void {
    const selector = String(step.selector ?? "").trim();
    if (selector && isTempIdSelector(selector)) {
      this.logger?.warn("omni_gateway_skip_temp_id", {
        actionType: step.type,
        selector,
      });
      return;
    }
    this.recordFn?.(step);
  }

  /** 浏览器后退，落盘为 navigate→最终 URL（回放可 safeGoto） */
  async goBack(options?: OmniActionOptions): Promise<OmniActionTrajectory> {
    const page = this.page();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    if (!options?.skipSettle) {
      await this.settleBarrier(page);
    }
    const finalUrl = page.url();
    const postCondition = await this.capturePostCondition(page);
    const payload: OmniActionTrajectory = {
      actionType: "navigate",
      primarySelector: "",
      value: finalUrl,
      semanticLabel: `后退→${finalUrl}`,
    };
    this.commitIfRecording(options, payload, { url: finalUrl, postCondition });
    return payload;
  }

  /** 等待并落盘 wait（value=毫秒） */
  async wait(seconds: number, options?: OmniActionOptions): Promise<void> {
    const sec = Math.min(30, Math.max(0.5, seconds));
    const ms = Math.round(sec * 1000);
    await new Promise((r) => setTimeout(r, ms));
    if (this.shouldRecord(options)) {
      this.recordStep({
        type: "wait",
        selector: "",
        value: String(ms),
        url: this.page().url(),
      });
    }
  }

  /** 下拉选择并落盘 select */
  async selectOption(
    selector: string,
    value: string,
    options?: OmniActionOptions,
  ): Promise<void> {
    const page = this.page();
    const scope = options?.scope ?? page;
    const primary = selector.trim();
    if (!primary) {
      throw new Error("selectOption 需要 selector");
    }
    if (isTempIdSelector(primary)) {
      throw new Error(`拒绝临时 ID selector: ${primary}`);
    }
    const loc = scope.locator(primary).first();
    await loc.selectOption({ label: value }).catch(async () => {
      await loc.selectOption({ value });
    });
    if (!options?.skipSettle) {
      await this.settleBarrier(page);
    }
    if (this.shouldRecord(options)) {
      const label = sanitizeLabel(options?.semanticLabel || value) || value;
      this.recordStep({
        type: "select",
        selector: primary,
        value,
        semanticLabel: label,
        label,
        url: page.url(),
      });
    }
  }

  /** 兼容旧 OmniActionExecutor 方法名 */
  async executePointClick(
    x: number,
    y: number,
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    return this.pointClick(x, y, options);
  }

  async executeLocatorClick(
    target: ClickTarget,
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    return this.click(target, options);
  }

  async executeLocatorFill(
    target: FillTarget,
    value: string,
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    return this.fill(target, value, options);
  }

  async executeScroll(
    direction: "up" | "down" | "bottom",
    options?: OmniActionOptions,
  ): Promise<OmniActionTrajectory> {
    return this.scroll(direction, options);
  }

  /** 按键经网关执行并落盘 keypress（回放引擎支持） */
  async executeKeyPress(key: string, options?: OmniActionOptions): Promise<void> {
    const pressed = String(key || "").trim() || "Enter";
    await this.page().keyboard.press(pressed);
    if (!options?.skipSettle) {
      await this.settleBarrier();
    }
    if (this.shouldRecord(options)) {
      this.recordStep({
        type: "keypress",
        selector: "",
        value: pressed,
        url: this.page().url(),
      });
    }
  }
}

/** 便捷：无绑定会话时临时走网关坐标点击 */
export async function gatewayPointClick(
  page: Page,
  x: number,
  y: number,
  options?: OmniActionOptions,
): Promise<OmniActionTrajectory> {
  const active = getActiveGateway();
  if (active) {
    return active.pointClick(x, y, options);
  }
  const ephemeral = new OmniActionGateway(page);
  return ephemeral.pointClick(x, y, options);
}
