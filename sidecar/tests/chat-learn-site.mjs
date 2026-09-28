/**
 * P5 回归：站点学习（发现流水线）的**接线层**三条硬纪律
 *
 * 这一层是「学完的东西到底落在哪、能不能删、会不会删错」的边界，单测纯函数是覆盖不到的：
 *   1. **学来的描述符落在该环境自己的目录里**（随环境删除一并清掉）；没有目录就不落盘；
 *   2. **siteKey 参与拼路径 → fail-closed**：`../` 这类形状一律拒绝，绝不删到目录外的文件；
 *   3. **协议与打包契约**：学习进度行不带 `waitId`（否则宿主的片内进度会被当成「已收工」），
 *      终态行必带 `waitId`；学习登记进同一把互斥且 `chat_stop` 能停下它；
 *      宿主不重写描述符解析；便携包必须带上 `sidecar/connectors`（缺了站点静默退回通用读法）。
 *
 * 纯文件系统 + 静态契约，**0 token、不开浏览器**。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listConnectorItemsDetailed, removeLearnedSite } from "../dist/bu_agent/chat_learn.js";
import { parseDescriptor } from "../dist/core/web_chat/descriptor/manifest.js";
import { resolveLearnedConnectorDir } from "../dist/core/web_chat/descriptor/registry.js";
import {
  descriptorFileName,
  metaFileName,
  safeSiteKey,
  saveLearnedDescriptor,
  siteKeyFromFileName,
} from "../dist/core/web_chat/discovery/learn.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const FIXTURE = join(HERE, "fixtures", "connectors-learned", "sample-im.example.json");

/** 临时环境目录（用完必删，免得污染下一次运行） */
function withTempEnv(run) {
  const dir = mkdtempSync(join(tmpdir(), "chat-learn-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 复用已有夹具（一份合法的 learned 描述符），不另造样本 */
function parsedFixture(overrides = {}) {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const parsed = parseDescriptor({ ...raw, ...overrides }, "learned");
  assert.equal(
    parsed.ok,
    true,
    `夹具本身必须合法：${parsed.diagnostics.map((item) => item.reason).join(" / ")}`,
  );
  return parsed.descriptor;
}

function metaOf(siteKey) {
  return {
    siteKey,
    siteLabel: "sample-im",
    savedAt: "2026-09-27T00:00:00.000Z",
    url: "https://sample-im.example/chat",
    rounds: 2,
    readVerified: true,
    sendVerified: false,
    notes: [],
    usage: { promptTokens: 1200, completionTokens: 300, calls: 2 },
    verifySummary: "读自检通过（写入未验证）",
  };
}

/* ————————————————————————— A. siteKey 形状闸门（fail-closed） ————————————————————————— */

test("safeSiteKey：合法站点键放行；含分隔符 / 以点开头 / 空白 / 超长一律拒绝", () => {
  assert.equal(safeSiteKey("sample-im.example"), "sample-im.example");
  assert.equal(safeSiteKey("  whatsapp.com  "), "whatsapp.com", "trim 后合法就放行");
  assert.equal(safeSiteKey("../../evil"), null, "含分隔符必须拒绝（会拼出目录外路径）");
  assert.equal(safeSiteKey("..\\evil"), null, "Windows 分隔符同样拒绝");
  assert.equal(safeSiteKey(".hidden"), null, "以点开头拒绝（与 `_` 前缀约定混在一起会漏文件）");
  assert.equal(safeSiteKey(""), null);
  assert.equal(safeSiteKey("空格 名字"), null);
  assert.equal(safeSiteKey("a".repeat(97)), null, "超长拒绝（文件名上限）");
});

test("siteKeyFromFileName：是 descriptorFileName 的逆，拿不回来就 null（不猜）", () => {
  assert.equal(siteKeyFromFileName(descriptorFileName("whatsapp.com")), "whatsapp.com");
  assert.equal(siteKeyFromFileName("telegram.org.json"), "telegram.org");
  assert.equal(siteKeyFromFileName("_meta-whatsapp.com.json"), null, "元数据文件不是描述符");
  assert.equal(siteKeyFromFileName("no-extension"), null);
  assert.equal(siteKeyFromFileName("C:\\x\\_learned\\telegram.org.json"), null, "给的是路径不是文件名 → 不猜");
  assert.equal(siteKeyFromFileName("../evil.json"), null, "含分隔符一律拿不回来");
  assert.equal(siteKeyFromFileName(".hidden.json"), null, "以点开头不是合法站点键");
});

/* ————————————————————————— B. 落点 / 总览 / 删除 ————————————————————————— */

test("没学过任何站点：如实标注「目录还不存在」，不谎报「读到了空目录」", () => {
  withTempEnv((userDataDir) => {
    const report = listConnectorItemsDetailed(userDataDir);
    assert.equal(report.learnedDir, resolveLearnedConnectorDir(userDataDir));
    assert.equal(report.learnedDirReady, false, "还没学过 → 学习目录不该被假装成已有");
    assert.equal(report.builtinPresent, true, "仓库里带着内置描述符（sidecar/connectors）");
    assert.equal(report.items.filter((item) => item.learned).length, 0, "没有任何 learned 项");
    assert.equal(
      report.items.some((item) => item.id === "sample-im"),
      false,
      "样本 IM 只在夹具里，不在内置目录里",
    );
  });
});

test("学完一个站点：学来的项带元数据，读/写校验状态如实（不把「读通过」说成「读写都通过」）", () => {
  withTempEnv((userDataDir) => {
    const dir = resolveLearnedConnectorDir(userDataDir);
    assert.ok(dir, "有 userDataDir 就必须解析出学习目录");
    const saved = saveLearnedDescriptor({
      dir,
      descriptor: parsedFixture(),
      meta: metaOf("sample-im.example"),
    });
    assert.equal(saved.descriptorPath, join(dir, descriptorFileName("sample-im.example")));
    assert.equal(saved.metaPath, join(dir, metaFileName("sample-im.example")));
    assert.ok(existsSync(saved.descriptorPath) && existsSync(saved.metaPath));

    const report = listConnectorItemsDetailed(userDataDir);
    assert.equal(report.learnedDirReady, true);
    const learned = report.items.filter((item) => item.learned);
    assert.equal(learned.length, 1);
    assert.equal(learned[0].id, "sample-im");
    assert.equal(
      learned[0].siteKey,
      "sample-im.example",
      "删除要用文件名干（不是 id）：约定由 Sidecar 一处拆好下发，前端不自己拆路径",
    );
    assert.equal(learned[0].meta?.siteKey, "sample-im.example");
    assert.equal(learned[0].meta?.readVerified, true);
    assert.equal(learned[0].meta?.sendVerified, false, "写入没验就如实 false");
    // 内置项没有「文件名干」这个概念（它们不该被删除入口碰到）
    assert.ok(
      report.items.filter((item) => !item.learned).every((item) => item.siteKey === null),
      "内置描述符的 siteKey 一律 null",
    );
    // 元数据文件不进描述符扫描（否则会被当成描述符去校验、报一条假错误）
    assert.equal(
      report.diagnostics.some((item) => item.path.includes("_meta-")),
      false,
      "`_meta-` 前缀文件不参与描述符加载",
    );
  });
});

test("学习成果优先于内置：同 id 时 learned 覆盖 builtin，并留下一条诊断", () => {
  withTempEnv((userDataDir) => {
    const dir = resolveLearnedConnectorDir(userDataDir);
    saveLearnedDescriptor({
      dir,
      descriptor: parsedFixture({
        id: "whatsapp-web",
        match: { hostPattern: "(^|\\.)whatsapp\\.com$", pathPattern: null },
      }),
      meta: metaOf("whatsapp.com"),
    });

    const report = listConnectorItemsDetailed(userDataDir);
    const whatsapp = report.items.filter((item) => item.id === "whatsapp-web");
    assert.equal(whatsapp.length, 1, "覆盖后只剩一份（不是内置学来各一份）");
    assert.equal(whatsapp[0].source, "learned");
    assert.equal(whatsapp[0].meta?.siteKey, "whatsapp.com");
    assert.ok(
      report.diagnostics.some((item) => item.code === "learned_overrides_builtin"),
      "覆盖要留痕（否则用户以为内置那份还在被使用）",
    );
  });
});

test("删除学来的站点：正文与元数据一起删；再删如实报 not_found（不谎报成功）", () => {
  withTempEnv((userDataDir) => {
    const dir = resolveLearnedConnectorDir(userDataDir);
    const saved = saveLearnedDescriptor({
      dir,
      descriptor: parsedFixture(),
      meta: metaOf("sample-im.example"),
    });

    const first = removeLearnedSite(userDataDir, "sample-im.example");
    assert.equal(first.ok, true);
    assert.equal(first.reason, null);
    assert.equal(existsSync(saved.descriptorPath), false);
    assert.equal(existsSync(saved.metaPath), false, "元数据也要一起删（否则留下孤儿 meta 文件）");

    const second = removeLearnedSite(userDataDir, "sample-im.example");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "not_found");
    assert.equal(existsSync(dir), true, "删的是描述符，不是整个学习目录（目录留给下一份成果）");
  });
});

test("删除的三类失败边界：缺目录 / 缺 key / 不安全 key 都 fail-closed", () => {
  assert.equal(removeLearnedSite(null, "sample-im.example").reason, "no_user_data_dir");
  assert.equal(removeLearnedSite("E:\\tmp", "   ").reason, "missing_site_key");
  assert.equal(removeLearnedSite("E:\\tmp", "../../evil").reason, "unsafe_site_key");
});

test("路径逃逸的 key 真的动不了目录外的文件（不是「只报个错」）", () => {
  withTempEnv((userDataDir) => {
    const outside = join(userDataDir, "victim.json");
    writeFileSync(outside, "{}", "utf8");
    const result = removeLearnedSite(userDataDir, "../victim");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsafe_site_key");
    assert.equal(existsSync(outside), true, "目录外的文件必须原封不动");
  });
});

test("保存时 siteKey 形状不对：直接抛错，绝不写到目录外", () => {
  withTempEnv((userDataDir) => {
    const dir = resolveLearnedConnectorDir(userDataDir);
    assert.throws(
      () =>
        saveLearnedDescriptor({
          dir,
          descriptor: parsedFixture(),
          meta: metaOf("../escape"),
        }),
      /unsafe_site_key/,
    );
  });
});

/* ————————————————————————— C. 协议与打包契约（静态锁） ————————————————————————— */

function readSource(relative) {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

test("学习进度行不带 waitId；每一条终态出口都带 waitId（§0.5.3 E：回执不许悬着）", () => {
  const learn = readSource("sidecar/src/bu_agent/chat_learn.ts");
  const index = readSource("sidecar/src/index.ts");

  const progressEmit = learn.slice(
    learn.indexOf("const emit = (message: string"),
    learn.indexOf("const pageResult"),
  );
  assert.ok(progressEmit.includes('type: "chat_learn"'), "片内进度用 chat_learn 这个语义 kind");
  assert.equal(
    progressEmit.includes("waitId"),
    false,
    "片内进度带 waitId 会让宿主把「刚开始」当成「已经收工」",
  );

  // 逐条取出「从 chat_learn_done 到它那一行的收尾」的片段（按 `});` 切），要求每条都带 waitId
  const doneBlocks = [];
  let cursor = index.indexOf('type: "chat_learn_done"');
  while (cursor >= 0) {
    const end = index.indexOf("});", cursor);
    assert.ok(end > cursor, "chat_learn_done 必须是一个完整的对象字面量");
    doneBlocks.push(index.slice(cursor, end + 3));
    cursor = index.indexOf('type: "chat_learn_done"', end);
  }
  assert.ok(doneBlocks.length >= 4, "互斥拒绝 / 缺目录 / 正常终态 / 异常终态（+ 启动失败）都要有终态行");
  for (const block of doneBlocks) {
    assert.ok(
      block.includes("waitId"),
      "每个 chat_learn_done 出口都必须带 waitId，否则宿主只能干等超时",
    );
  }
});

test("学习登记进同一把互斥，且 chat_stop 能把它一起停下（不许假停止）", () => {
  const index = readSource("sidecar/src/index.ts");
  assert.ok(index.includes("chatLearning"), "学习必须有独立句柄（否则停不掉）");
  assert.ok(/learning\.controller\.abort/.test(index), "chat_stop 必须把中止信号透传下去");
  assert.ok(
    index.includes("chatRunning = true") && index.includes("chatRunning = false"),
    "学习也要登记 / 摘除忙标记（S5：同一环境不许并行踩 CDP）",
  );
  assert.ok(index.includes('"chat_learn_site"'), "学习由独立命令触发（不是聊天值守的一部分）");
});

test("宿主不重写描述符解析：总览与删除都经一次性 CLI，不自己拼文件名", () => {
  const host = readSource("src-tauri/src/chat_connector.rs");
  assert.ok(host.includes("chat_connector_cli.js"), "总览/删除必须走 Sidecar 的权威解析器");
  assert.equal(
    /hostPattern|descriptorFileName/.test(host),
    false,
    "宿主不许自己解析描述符 / 拼文件名（两套口径必然分叉）",
  );
  const cli = readSource("sidecar/src/chat_connector_cli.ts");
  assert.ok(cli.includes("listConnectorItemsDetailed"));
  assert.ok(cli.includes("removeLearnedSite"));
  assert.ok(cli.includes("readConsumedJsonConfig"), "一次性配置读完即焚（缩短路径等信息落盘窗口）");
  assert.ok(cli.includes("installIpcGuards"), "一次性 CLI 也要装 IPC 护栏（与其它 CLI 同口径）");
});

test("打包必须带上 sidecar/connectors（缺了就是「所有站点静默退回通用读法」）", () => {
  const copy = readSource("scripts/copy-sidecar-bundle.bat");
  assert.ok(copy.includes("%SRC%\\connectors"), "便携包必须拷 connectors");
  const build = readSource("build-app.bat");
  assert.ok(build.includes("sidecar\\connectors"), "完整性闸门必须检查 connectors");
  assert.ok(build.includes("whatsapp-web.json"), "至少抽查一份内置描述符（保真基准）");
});
