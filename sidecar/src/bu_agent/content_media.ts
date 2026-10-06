/**
 * 页面上的「内容图」清单（给 download 动作挑第 N 张）。
 *
 * 只按尺寸和资源地址过滤：太小的图标、1×1 统计像素、blob 地址都不算内容图。
 * 不含任何站点选择器或文案。顺序是文档顺序，第 1 张 = 下标 0。
 */
import type { Page } from "playwright-core";

/** 短边低于这个像素的图不当作「要下载的内容图」（图标 / 统计像素） */
export const CONTENT_MEDIA_MIN_PX = 64;

export async function listContentMediaUrls(page: Page, minPx = CONTENT_MEDIA_MIN_PX): Promise<string[]> {
  return page.evaluate((min) => {
    const urls: string[] = [];
    const nodes = document.querySelectorAll("img, a");
    nodes.forEach((node) => {
      const el = node as HTMLElement;
      const box = el.getBoundingClientRect();
      const image = el as HTMLImageElement;
      const width = image.naturalWidth || box.width;
      const height = image.naturalHeight || box.height;
      if (width < min || height < min) return;
      let url = "";
      if (el.tagName === "IMG") {
        url = image.currentSrc || image.getAttribute("src") || image.getAttribute("data-src") || "";
      } else {
        const href = (el as HTMLAnchorElement).href || "";
        if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)(\?|#|$)/i.test(href)) url = href;
      }
      url = String(url || "").trim();
      if (!url || /^blob:/i.test(url)) return;
      if (urls.includes(url)) return;
      urls.push(url);
    });
    return urls.slice(0, 40);
  }, minPx);
}
