/**
 * 应用外链锚点（官网 / 帮助中心）。
 *
 * 产品名与两个入口先在这里占位：等官网上线后，只需把 `APP_HOME_URL` /
 * `APP_HELP_URL` 填成真实地址，顶栏的品牌按钮与「帮助」按钮就会自动生效，
 * 不需要再改 UI。
 */
import { invoke } from "@tauri-apps/api/core";

export type AppLinkKind = "home" | "help";

export const APP_NAME = "天枢台";

/** 主页（官网）。留空 = 尚未对接。 */
export const APP_HOME_URL = "";

/** 帮助中心。留空 = 尚未对接。 */
export const APP_HELP_URL = "";

/** 官网未就绪时给用户的一句提示（不导向任何站内说明页） */
export const APP_LINK_PENDING_HINT = "官网尚未上线，敬请期待";

export function appLinkUrl(kind: AppLinkKind): string {
  const raw = kind === "home" ? APP_HOME_URL : APP_HELP_URL;
  return raw.trim();
}

export function hasAppLink(kind: AppLinkKind): boolean {
  return appLinkUrl(kind).length > 0;
}

/**
 * 打开外链。未配置地址时返回 false，调用方据此给一句轻提示。
 *
 * Tauri 的 WebView 没有新窗口处理器 —— `window.open` / `<a target="_blank">`
 * 在应用里点了没反应。所以统一交给宿主用系统默认浏览器打开
 * （`open_external_url` 只放行 http/https）。
 */
export async function openExternalUrl(url: string): Promise<void> {
  await invoke("open_external_url", { url });
}

export async function openAppLink(kind: AppLinkKind): Promise<boolean> {
  const url = appLinkUrl(kind);
  if (!url) {
    return false;
  }
  try {
    await openExternalUrl(url);
    return true;
  } catch {
    return false;
  }
}
