/**
 * URL 目标匹配（Node 侧共享原语）
 *
 * 判断「当前页面是否已经到达目标 URL」。用于纯导航目标（「打开 X」）的本地收尾：
 * 运行期拿目标 URL 与当前 URL 做**结构比对**，而不是字符串相等 ——
 *   - `www.` 前缀、http/https、结尾斜杠、查询参数（如 `?tn=...`）都不应影响判定；
 *   - 目标带路径时要求路径前缀一致（`/topic/2` 不应匹配 `/topic/2/other` 之外的无关页，
 *     但应匹配 `/topic/2`）；目标是站点根时只认根路径（不能在 `/s?wd=` 搜索结果页上算达标）。
 */
function hostOf(u: URL): string {
  return u.host.toLowerCase().replace(/^www\./, "");
}

function normalizePath(pathname: string): string {
  const p = String(pathname ?? "").replace(/\/+$/, "");
  return p || "/";
}

/**
 * 不是「能承载内容的页面」的协议：浏览器内部页、空白页、内联脚本与二进制文档。
 *
 * 为什么单独拎出来共享：同一个事实被两处需要，而两处判错都会造成真实事故 ——
 *   · `navigate` 动作：把 `about:blank` 当成地址发出去（用户现场：模型在引擎首页卡住时
 *     突然「重置页面」，白烧一步）；
 *   · 交付物核销：把空白页当成「到达目标页」的证据（同一次现场里，navigation 交付物
 *     就靠这个凭空核销了）。
 * 刻意用**黑名单**而不是 `http(s)` 白名单：本地 `file://` 夹具、`blob:` 文档都是真实页面，
 * 白名单会把它们一起误杀（单测里先炸过一次）。
 */
const NON_CONTENT_SCHEMES = new Set([
  "about",
  "chrome",
  "chrome-error",
  "devtools",
  "edge",
  "javascript",
  "data",
  "view-source",
]);

/** 这个地址是否是一个「能承载内容的页面」（空 / 浏览器内部页 / data: / javascript: 不是） */
export function isContentPageUrl(url: string): boolean {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) return false;
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  return !(scheme && NON_CONTENT_SCHEMES.has(scheme));
}

/** 当前 URL 是否到达目标 URL（同站 + 路径前缀一致） */
export function urlMatchesTarget(currentUrl: string, targetUrl: string): boolean {
  const current = String(currentUrl ?? "").trim();
  const target = String(targetUrl ?? "").trim();
  if (!current || !target) return false;
  let c: URL;
  let t: URL;
  try {
    c = new URL(current);
    t = new URL(target);
  } catch {
    return false;
  }
  if (c.protocol !== t.protocol) {
    // http 目标允许被 https 满足（站点常自动升级），反之不放行
    if (!(t.protocol === "http:" && c.protocol === "https:")) return false;
  }
  if (hostOf(c) !== hostOf(t)) return false;
  const targetPath = normalizePath(t.pathname);
  const currentPath = normalizePath(c.pathname);
  if (targetPath === "/") return currentPath === "/";
  return currentPath === targetPath || currentPath.startsWith(`${targetPath}/`);
}

/** 从一组目标里找出第一个已被当前页满足的目标 */
export function firstReachedTarget(currentUrl: string, targets: readonly string[]): string | null {
  for (const target of targets) {
    if (urlMatchesTarget(currentUrl, target)) return target;
  }
  return null;
}
