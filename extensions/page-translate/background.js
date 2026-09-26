/**
 * 天枢台内置翻译扩展（MV2）
 * - 右键：翻译选中文字 / 翻译整页
 * - 工具栏：打开 Google 翻译当前页
 * 不依赖 CloakBrowser 已裁掉的原生 Google Translate 服务。
 */

var TARGET_LANG = "zh-CN";

function translateUrlForText(text) {
  return (
    "https://translate.google.com/?sl=auto&tl=" +
    encodeURIComponent(TARGET_LANG) +
    "&text=" +
    encodeURIComponent(text) +
    "&op=translate"
  );
}

function translateUrlForPage(pageUrl) {
  return (
    "https://translate.google.com/translate?sl=auto&tl=" +
    encodeURIComponent(TARGET_LANG) +
    "&u=" +
    encodeURIComponent(pageUrl)
  );
}

function openTranslateTab(url) {
  chrome.tabs.create({ url: url, active: true });
}

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: "cf-translate-selection",
      title: "翻译选中文字",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "cf-translate-page",
      title: "翻译整个页面",
      contexts: ["page", "frame"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === "cf-translate-selection") {
    var text = (info.selectionText || "").trim();
    if (!text) {
      return;
    }
    openTranslateTab(translateUrlForText(text));
    return;
  }

  if (info.menuItemId === "cf-translate-page") {
    var pageUrl = info.pageUrl || (tab && tab.url) || "";
    if (!pageUrl || pageUrl.indexOf("http") !== 0) {
      return;
    }
    openTranslateTab(translateUrlForPage(pageUrl));
  }
});

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || message.type !== "translate-active-tab") {
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    var pageUrl = (tab && tab.url) || "";
    if (!pageUrl || pageUrl.indexOf("http") !== 0) {
      sendResponse({ ok: false, error: "当前标签页无法翻译" });
      return;
    }
    openTranslateTab(translateUrlForPage(pageUrl));
    sendResponse({ ok: true });
  });
  return true;
});
