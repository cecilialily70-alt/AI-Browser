/**
 * 图库匹配：归一化、文件夹优先、无重合则 null、同分路径字典序稳定。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, normalize as pathNormalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadMediaLibrary,
  matchMedia,
  mediaTokens,
  normalizeMediaKey,
  normalizeMediaLibraryDir,
  scanMediaLibrary,
} from "../dist/core/web_chat/media_library.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "fixtures", "_chat-media-tmp");

/** 1×1 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function asset(over) {
  return {
    path: "/lib/b.jpg",
    folder: "iPhone_18_Pro_Max",
    fileStem: "深蓝_正面",
    label: "iPhone_18_Pro_Max/深蓝_正面",
    ...over,
  };
}

test("normalizeMediaKey 去空白标点并小写", () => {
  assert.equal(normalizeMediaKey("Pro Max 深蓝"), "promax深蓝");
  assert.equal(normalizeMediaKey("desert_gold-front"), "desertgoldfront");
});

test("mediaTokens 抽出拉丁词与汉字 2-gram", () => {
  const tokens = mediaTokens("我要看 Pro Max 深蓝色");
  assert.ok(tokens.includes("pro"));
  assert.ok(tokens.includes("max"));
  assert.ok(tokens.includes("深蓝") || tokens.includes("深蓝色"));
});

test("文件夹命中权重大于文件名；无重合返回 null", () => {
  const proMaxBlue = asset({ path: "/z/pro-max-blue.jpg" });
  const proGold = asset({
    path: "/a/pro-gold.jpg",
    folder: "iPhone_18_Pro",
    fileStem: "desert_gold",
    label: "iPhone_18_Pro/desert_gold",
  });
  const picked = matchMedia("给我看看 Pro Max 深蓝实拍", [proGold, proMaxBlue]);
  assert.equal(picked?.path, "/z/pro-max-blue.jpg");
  assert.equal(matchMedia("随便聊聊天气", [proMaxBlue]), null);
  assert.equal(matchMedia("我要图片", [proMaxBlue]), null, "只有「图片」没有货名不得猜一张");
});

test("同分取路径字典序第一张", () => {
  const a = asset({ path: "/lib/a.jpg", fileStem: "深蓝_背面" });
  const b = asset({ path: "/lib/b.jpg", fileStem: "深蓝_正面" });
  const picked = matchMedia("Pro Max 深蓝", [b, a]);
  assert.equal(picked?.path, "/lib/a.jpg");
});

test("scanMediaLibrary 认文件夹+中英文文件名，跳过 README", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "iPhone_18_Pro_Max"), { recursive: true });
  writeFileSync(join(TMP, "iPhone_18_Pro_Max", "深蓝_正面.png"), PNG);
  writeFileSync(join(TMP, "README.md"), "skip");
  writeFileSync(join(TMP, "root_shot.jpg"), PNG);
  const scanned = scanMediaLibrary(TMP);
  assert.equal(scanned.length, 2);
  assert.ok(scanned.some((row) => row.folder === "iPhone_18_Pro_Max" && row.fileStem === "深蓝_正面"));
  assert.ok(scanned.some((row) => row.folder === "" && row.fileStem === "root_shot"));
  const hit = matchMedia("Pro Max 深蓝", scanned);
  assert.equal(hit?.fileStem, "深蓝_正面");
  assert.equal(scanMediaLibrary(join(TMP, "missing-dir")).length, 0);
  assert.equal(loadMediaLibrary(TMP).length, 2);
  assert.equal(loadMediaLibrary(join(TMP, "missing-dir")).length, 0);
  // 自定义路径写了却不存在 → 空库，不静默回落到内置 chat_media
  const builtin = loadMediaLibrary(null);
  const missingCustom = loadMediaLibrary(join(TMP, "definitely-missing-xyz"));
  assert.equal(missingCustom.length, 0);
  assert.ok(Array.isArray(builtin));
  rmSync(TMP, { recursive: true, force: true });
});

test("normalizeMediaLibraryDir：空串 / 空字节 → null；合法路径原样保留", () => {
  assert.equal(normalizeMediaLibraryDir(""), null);
  assert.equal(normalizeMediaLibraryDir("   "), null);
  assert.equal(normalizeMediaLibraryDir("a\0b"), null);
  assert.equal(normalizeMediaLibraryDir("  /photos/goods  "), pathNormalize("/photos/goods"));
});
