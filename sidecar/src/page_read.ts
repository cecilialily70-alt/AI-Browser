/**
 * 确定性页面阅读 — 脚本抽 SERP/正文，不依赖滚动或二次 LLM 选选择器。
 * 先进实践：SERP 用 DOM 结构化抽取（knowledge/AI 卡 + organic），再交给 LLM 分析交付。
 * 交接前必须已做网络/DOM 沉淀；本模块负责剔除 script/style 等干扰，只交干净可见文本。
 */
import type { Page } from "playwright-core";

export interface SerpOrganicItem {
  rank: number;
  title: string;
  url: string;
  snippet: string;
}

export interface PageReadingResult {
  kind: "serp" | "article" | "generic";
  engine?: "baidu" | "google" | "bing" | "other";
  url: string;
  query?: string;
  /** 置顶知识卡 / AI 简介（用户视觉上的「第一条」常指这个） */
  featured: { title: string; summary: string; source: string } | null;
  organic: SerpOrganicItem[];
  /** 建议优先汇报的对象 */
  recommendedFirst: {
    type: "featured" | "organic";
    title: string;
    summary: string;
    url?: string;
  } | null;
  /** 非 SERP 时的可见主文摘要 */
  visibleText?: string;
}

function detectEngine(url: string): PageReadingResult["engine"] {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("baidu.com")) {
      return "baidu";
    }
    if (host.includes("google.")) {
      return "google";
    }
    if (host.includes("bing.com")) {
      return "bing";
    }
  } catch {
    /* ignore */
  }
  return "other";
}

/** 首页顶栏 / 空翻译卡等：绝不能当「第一条结果」 */
export function isSerpNavChromeNoise(text: string): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) {
    return true;
  }
  if (
    /百度首页.*设置.*登录|按回车键发起搜索|网页\s*图片\s*新闻\s*视频|贴吧\s*文库|hao123|更多产品|百度一下/i.test(
      t,
    )
  ) {
    return true;
  }
  // 标题像「翻译」但正文全是导航
  if (/^翻译$|^词典$|^热搜$/.test(t.slice(0, 8)) && /设置|登录|网页|图片|新闻/.test(t)) {
    return true;
  }
  return false;
}

/** 置顶卡是否具备可交付实质内容 */
export function isMeaningfulFeaturedCard(card: {
  title?: string;
  summary?: string;
} | null): boolean {
  if (!card) {
    return false;
  }
  const blob = `${card.title ?? ""} ${card.summary ?? ""}`;
  if (isSerpNavChromeNoise(blob)) {
    return false;
  }
  const summary = String(card.summary ?? "").trim();
  if (summary.length < 40) {
    return false;
  }
  // 空翻译/工具卡：几乎没有释义句子
  if (/^翻译/i.test(String(card.title ?? "")) && summary.length < 120 && /设置|登录|网页/.test(summary)) {
    return false;
  }
  return true;
}

function isSerpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname;
    if (host.includes("baidu.com") && (path.startsWith("/s") || u.searchParams.has("wd"))) {
      return true;
    }
    if (host.includes("google.") && (path.startsWith("/search") || u.searchParams.has("q"))) {
      return true;
    }
    if (host.includes("bing.com") && (path.startsWith("/search") || u.searchParams.has("q"))) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 在页面上下文抽取搜索结果 / 可见正文（不滚动）。
 * 文本路径严格过滤 script/style/noscript/svg/iframe 与隐藏节点。
 */
/**
 * 净化可见正文：剔除骨架脚本/样式/隐藏节点，只返回真人能看见的文字。
 *
 * 为什么必须**共用一份**实现：`extract` 动作曾经自己手搓一套 `clone.body.innerText` ——
 * 克隆出来的节点脱离了文档，按规范 `innerText` 会退化成 `textContent`，
 * 于是把 `<style>` 里的 CSS 当正文喂给了模型（用户现场：百度结果页 extract 只回
 * 「大片 CSS/样式代码」，模型据此怀疑第一条结果、连烧两步，最后完成度询问还给不出结论）。
 * 这里只有一份实现，页面阅读与 extract 两条路径共用，谁也不许再自己搓。
 */
export async function readPurifiedVisibleText(page: Page, maxChars = 3500): Promise<string> {
  return (await page.evaluate((limit) => {
    const SKIP_TAGS = new Set([
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "SVG",
      "IFRAME",
      "LINK",
      "META",
      "HEAD",
      "TEMPLATE",
    ]);
    const root =
      document.querySelector("article, main, #content_left, #content, .content") || document.body;
    if (!root) {
      return "";
    }
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (SKIP_TAGS.has(el.tagName)) {
          return;
        }
        try {
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0
          ) {
            return;
          }
        } catch {
          /* ignore */
        }
        if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) {
          return;
        }
        for (const child of Array.from(el.childNodes)) {
          walk(child);
        }
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const t = String(node.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (t) {
          parts.push(t);
        }
      }
    };
    walk(root);
    return parts.join(" ").slice(0, limit);
  }, Math.max(200, Math.floor(maxChars)))) as string;
}

export async function extractPageReading(
  page: Page,
  options?: {
    /**
     * 顺带取一份「净化可见正文」（仅在显式要求时才算：结果页阅读本身不需要它，
     * 但 `extract` 这类需要正文兜底的动作要）。缺省不算，零额外开销。
     */
    visibleTextMaxChars?: number;
  },
): Promise<PageReadingResult> {
  const url = page.url();
  const engine = detectEngine(url);
  const serp = isSerpUrl(url);

  if (serp) {
    const data = await page.evaluate(() => {
      const SKIP_TAGS = new Set([
        "SCRIPT",
        "STYLE",
        "NOSCRIPT",
        "SVG",
        "IFRAME",
        "LINK",
        "META",
        "HEAD",
        "TEMPLATE",
      ]);

      const clean = (value: string | null | undefined) =>
        String(value ?? "")
          .replace(/\s+/g, " ")
          .trim();

      /** 可见纯文本：剔除骨架脚本/样式与隐藏元素，避免把 JS/CSS 交给 AI */
      const visibleTextOf = (root: Element | null | undefined, maxLen = 900): string => {
        if (!root) {
          return "";
        }
        const parts: string[] = [];
        const walk = (node: Node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            if (SKIP_TAGS.has(el.tagName)) {
              return;
            }
            try {
              const style = window.getComputedStyle(el);
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                Number(style.opacity) === 0
              ) {
                return;
              }
            } catch {
              /* ignore */
            }
            if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) {
              return;
            }
            for (const child of Array.from(el.childNodes)) {
              walk(child);
            }
            return;
          }
          if (node.nodeType === Node.TEXT_NODE) {
            const t = clean(node.textContent);
            if (t) {
              parts.push(t);
            }
          }
        };
        walk(root);
        return parts.join(" ").slice(0, maxLen);
      };

      const query =
        clean(
          (
            document.querySelector(
              "#kw, #chat-textarea, textarea[name='wd'], input[name='wd'], textarea[name='q'], input[name='q']",
            ) as HTMLInputElement | HTMLTextAreaElement | null
          )?.value,
        ) ||
        clean(
          new URLSearchParams(location.search).get("wd") ||
            new URLSearchParams(location.search).get("q"),
        );

      // —— Featured / Knowledge / AI 卡（百度常见置顶）——
      let featured: { title: string; summary: string; source: string } | null = null;
      const featuredCandidates: Array<{ el: Element; source: string }> = [];
      const pushFeat = (sel: string, source: string) => {
        document.querySelectorAll(sel).forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 80 || rect.height < 40) {
            return;
          }
          if (rect.top > 900) {
            return;
          }
          featuredCandidates.push({ el, source });
        });
      };
      pushFeat("[class*='op-'], [class*='c-border'][tpl], .c-container[tpl='recommend_list']", "baidu_op");
      pushFeat("#content_left > div[class*='result-op'], #content_left > .c-container.result-op", "baidu_result_op");
      pushFeat("[class*='cos-'], [data-module='ai'], [class*='ai-']", "baidu_ai");
      pushFeat("#rhs, #kp-wp-tab-overview, .knowledge-panel, [data-attrid='title']", "google_kg");

      for (const item of featuredCandidates) {
        const text = visibleTextOf(item.el, 900);
        if (text.length < 40) {
          continue;
        }
        if (/百度热搜|相关搜索|大家还在搜/.test(text) && text.length < 120) {
          continue;
        }
        // 首页导航残影 / 空翻译卡
        if (
          /百度首页.*设置.*登录|按回车键发起搜索|网页\s*图片\s*新闻\s*视频|贴吧\s*文库|hao123/i.test(
            text,
          )
        ) {
          continue;
        }
        // 过滤明显的脚本残影
        if (/function\s*\(|userAgent|webkit|<\/?[a-z]+/i.test(text.slice(0, 200))) {
          continue;
        }
        const titleEl =
          item.el.querySelector("h2, h3, .c-title, [class*='title']") || item.el.querySelector("a");
        const title = clean(visibleTextOf(titleEl, 120)) || text.slice(0, 40);
        if (/^翻译$|^词典$/.test(title) && /设置|登录|网页|图片/.test(text)) {
          continue;
        }
        featured = { title, summary: text.slice(0, 600), source: item.source };
        break;
      }

      // —— Organic 自然结果 ——
      const organic: Array<{ rank: number; title: string; url: string; snippet: string }> = [];
      const seen = new Set<string>();

      const considerContainer = (container: Element) => {
        if (organic.length >= 8) {
          return;
        }
        const h3 =
          container.querySelector("h3 a") ||
          container.querySelector("h3") ||
          container.querySelector("a[href*='http']");
        if (!h3) {
          return;
        }
        const title = clean(visibleTextOf(h3, 160));
        if (!title || title.length < 2) {
          return;
        }
        const anchor = (h3.closest("a") ||
          (h3.tagName === "A" ? h3 : container.querySelector("a"))) as HTMLAnchorElement | null;
        let href = clean(anchor?.href);
        if (!href || href.startsWith("javascript:")) {
          return;
        }
        if (/相关搜索|换一换|百度热搜|登录|设置/.test(title)) {
          return;
        }
        const key = `${title}::${href.slice(0, 80)}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        const snippetEl =
          container.querySelector(
            ".c-abstract, .c-span9, [class*='content-right'], [class*='abstract'], .st, .VwiC3b",
          ) || container;
        const snippet = clean(visibleTextOf(snippetEl, 220)).replace(title, "").slice(0, 220);
        organic.push({
          rank: organic.length + 1,
          title,
          url: href,
          snippet,
        });
      };

      const containers = document.querySelectorAll(
        "#content_left .result, #content_left .c-container, #content_left > div, #rso .g, #b_results > li.b_algo, #b_results .b_algo",
      );
      containers.forEach((node) => {
        const cls = `${node.className || ""}`;
        if (
          /result-op|c-border/.test(cls) &&
          featured &&
          visibleTextOf(node, 80) === featured.summary.slice(0, 80)
        ) {
          return;
        }
        considerContainer(node);
      });

      if (organic.length === 0) {
        document.querySelectorAll("#search a h3, #rso h3").forEach((h3) => {
          const a = h3.closest("a");
          if (!a) {
            return;
          }
          const title = clean(visibleTextOf(h3, 160));
          const href = clean(a.href);
          if (!title || !href || seen.has(title)) {
            return;
          }
          seen.add(title);
          organic.push({
            rank: organic.length + 1,
            title,
            url: href,
            snippet: "",
          });
        });
      }

      if (!featured) {
        const left = document.querySelector("#content_left, #rso, #b_results");
        if (left) {
          const kids = Array.from(left.children).slice(0, 6);
          for (const kid of kids) {
            const text = visibleTextOf(kid, 900);
            if (text.length < 80) {
              continue;
            }
            if (/function\s*\(|userAgent|webkit/i.test(text.slice(0, 200))) {
              continue;
            }
            if (
              /百度首页.*设置.*登录|按回车键发起搜索|网页\s*图片\s*新闻\s*视频/i.test(text)
            ) {
              continue;
            }
            const hasOrganicTitle = Boolean(kid.querySelector("h3"));
            if (
              !hasOrganicTitle ||
              /百度百科|演员|歌手|导演|简介|早年经历|演艺经历/.test(text.slice(0, 200))
            ) {
              const titleEl = kid.querySelector("h2, h3, .c-title, [class*='title']");
              const title = clean(visibleTextOf(titleEl, 120)) || text.slice(0, 48);
              if (/^翻译$|^词典$/.test(title) && /设置|登录|网页/.test(text)) {
                continue;
              }
              featured = {
                title,
                summary: text.slice(0, 600),
                source: "serp_top_block",
              };
              break;
            }
          }
        }
      }

      return { query, featured, organic };
    });

    const featuredRaw = data.featured;
    const organic = (data.organic ?? []).filter(
      (item) => !isSerpNavChromeNoise(`${item.title} ${item.snippet}`),
    );
    const featured =
      featuredRaw && isMeaningfulFeaturedCard(featuredRaw) ? featuredRaw : null;
    let recommendedFirst: PageReadingResult["recommendedFirst"] = null;
    // 优先自然结果，避免空工具卡冒充「第一条」
    if (organic[0]) {
      recommendedFirst = {
        type: "organic",
        title: organic[0].title,
        summary: organic[0].snippet || organic[0].title,
        url: organic[0].url,
      };
    } else if (featured) {
      recommendedFirst = {
        type: "featured",
        title: featured.title,
        summary: featured.summary,
      };
    }

    return {
      kind: "serp",
      engine: engine ?? "other",
      url,
      query: data.query || undefined,
      featured,
      organic,
      recommendedFirst,
      // 只有调用方点名要正文时才多算一次（阅读摘要不需要它）
      visibleText: options?.visibleTextMaxChars
        ? await readPurifiedVisibleText(page, options.visibleTextMaxChars)
        : undefined,
    };
  }

  // 非 SERP：净化后的可见主文（剔除 script/style/svg/iframe/隐藏节点）
  const visibleText = await readPurifiedVisibleText(page, 3500);

  return {
    kind: "generic",
    engine: engine ?? "other",
    url,
    featured: null,
    organic: [],
    recommendedFirst: visibleText
      ? {
          type: "featured",
          title: "页面可见正文",
          summary: visibleText.slice(0, 800),
        }
      : null,
    visibleText,
  };
}

/**
 * 压成给 LLM 的短中文块（省 token）。
 *
 * `includeRules=false` = **取正文用途**（extract 动作）：去掉给 Agent 的收尾指令（那是对计划
 * 说的，不是对正文说的），并把可见正文放宽 —— 提取类查询往往要页面上更靠后的内容。
 */
export function formatPageReadingForLlm(
  reading: PageReadingResult,
  options?: { includeRules?: boolean },
): string {
  const forExtract = options?.includeRules === false;
  const lines: string[] = ["【页面阅读·脚本抽取·净化可见文本·无需滚动】"];
  lines.push(`类型=${reading.kind}${reading.engine ? ` · 引擎=${reading.engine}` : ""}`);
  if (reading.query) {
    lines.push(`查询词=${reading.query}`);
  }
  if (reading.featured) {
    lines.push(
      `置顶卡/知识卡（用户首先看到的内容，优先当作「第一条」）：${reading.featured.title}`,
      `摘要：${reading.featured.summary.slice(0, 500)}`,
    );
  }
  if (reading.organic.length > 0) {
    lines.push("自然结果列表：");
    for (const item of reading.organic.slice(0, 5)) {
      lines.push(
        `${item.rank}. ${item.title}${item.snippet ? ` — ${item.snippet.slice(0, 120)}` : ""}`,
      );
    }
  }
  if (reading.recommendedFirst) {
    lines.push(
      `【建议第一条】type=${reading.recommendedFirst.type} · ${reading.recommendedFirst.title}`,
      `内容：${reading.recommendedFirst.summary.slice(0, 400)}`,
    );
  }
  if (reading.visibleText && (reading.kind !== "serp" || forExtract)) {
    lines.push(`可见正文：${reading.visibleText.slice(0, forExtract ? 6000 : 1200)}`);
  }
  if (!forExtract) {
    lines.push(
      "规则：用户要「第一条结果/分析后发给我」时，直接基于本块分析并 finish_task(summary=答案)；禁止 agent_scroll 找正文。",
    );
  }
  return lines.join("\n");
}
