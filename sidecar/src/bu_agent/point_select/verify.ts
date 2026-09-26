/**
 * 协议观察器工厂 + 点选验收。
 *
 * createProtocolObserver 是通用实现：监听 XHR 响应，URL 命中 urlPattern 或
 * content-type 为 json/text 时，检查 body 是否含 success 信号。
 * 各策略传入各自的 URL 正则（slider: slide|gap|ripple；point: click|point）。
 */
import type { Page } from "playwright-core";

export type ProtocolHit = { url: string; preview: string };

export function createProtocolObserver(
  page: Page,
  urlPattern: RegExp,
): {
  hits: ProtocolHit[];
  dispose: () => void;
} {
  const hits: ProtocolHit[] = [];
  const onResp = async (res: {
    url: () => string;
    headers: () => Record<string, string>;
    text: () => Promise<string>;
    status: () => number;
  }) => {
    try {
      const url = res.url();
      // 必须 URL 命中验证码相关路径，禁止把站内任意 JSON success:true 当成过验证
      if (!urlPattern.test(url)) {
        return;
      }
      const ct = String(res.headers()["content-type"] ?? "");
      if (!/json|text|javascript/i.test(ct) && !/captcha|verify|challenge/i.test(url)) {
        return;
      }
      if (res.status() >= 400) return;
      const body = (await res.text()).slice(0, 500);
      if (/success\s*[:=]\s*true|"success"\s*:\s*true|验证成功|通过验证/i.test(body)) {
        hits.push({ url: url.slice(0, 200), preview: body.slice(0, 240) });
      }
    } catch {
      /* ignore */
    }
  };
  page.on("response", onResp);
  return {
    hits,
    dispose: () => {
      page.off("response", onResp);
    },
  };
}

/** 点选默认 URL 正则（去掉 token：CSRF/session token 易误匹配非验证码请求） */
const POINT_SELECT_URL_PATTERN = /captcha|verify|click|check|point|challenge/i;

/** 点选协议观察器（createProtocolObserver 的薄包装） */
export function attachProtocolObserver(page: Page): {
  hits: ProtocolHit[];
  dispose: () => void;
} {
  return createProtocolObserver(page, POINT_SELECT_URL_PATTERN);
}

export async function verifyPointSelect(
  page: Page,
  protocolHits: ProtocolHit[],
): Promise<{ verified: boolean | null; signal: string }> {
  if (protocolHits.length > 0) {
    return { verified: true, signal: `protocol:${protocolHits[0]!.preview.slice(0, 80)}` };
  }

  const pageOk = await page
    .evaluate(() => {
      const t = String(document.body?.innerText || "");
      if (/success\s*[:=]\s*true|验证成功|通过验证|恭喜/i.test(t)) return "page_success";
      if (/验证失败|校验失败|点击错误/i.test(t)) return "page_fail";
      // 题干仍在 → 未过
      if (/请点击\s*[「"“]|请依次|按顺序点击/.test(t)) return "still_prompt";
      return "unknown";
    })
    .catch(() => "unknown");

  if (pageOk === "page_success") return { verified: true, signal: pageOk };
  if (pageOk === "page_fail") return { verified: false, signal: pageOk };
  // 题干常在动画/确认前仍保留 → 视为未决，避免过早判失败触发无效重试
  if (pageOk === "still_prompt") return { verified: null, signal: pageOk };
  return { verified: null, signal: pageOk };
}
