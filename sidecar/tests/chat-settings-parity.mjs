/**
 * 口径对齐（源码级断言）：**同一个概念不允许有两套数字**。
 *
 * 这一组用例锁的是「设置面板里能填什么」与「引擎真正接受什么」必须是同一套（§0.5.3 C
 * 「两套口径分叉」）。以前踩过的坑：
 *   - `followUpHours` 前端夹 1–1440、侧车连上界都没有 → 设置里显示 1440、引擎按 20000 跑
 *   - `maxPerDay` 前端下限 1 → 文档里写的「0 = 不限」**根本填不出来**
 *   - `useCurrentWindow` 前端默认 true、宿主默认 false → 设置里显示开、实际按关跑
 *
 * 手法：跨语言（TS 前端 / TS 侧车 / Rust 宿主）没有共享模块，所以直接读源码文本抽常量比对 ——
 * 这与仓库既有的「源码级断言锁口径」一致（见 `task-contract.mjs`）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CADENCE_LIMITS, DEFAULT_CADENCE, normalizeQuietHours } from "../dist/core/web_chat/cadence.js";
import {
  CHAT_CONTACTS_PER_SLICE_DEFAULT,
  CHAT_CONTACTS_PER_SLICE_MAX,
  CHAT_PARALLEL_HARD_MAX,
  CHAT_SLICE_MS_DEFAULT,
  CHAT_SLICE_MS_MAX,
  CHAT_SLICE_MS_MIN,
} from "../dist/core/web_chat/slice_limits.js";
import {
  contactFlagsOf,
  parseCadence,
  parseContactFlags,
  parseTakeovers,
  takeoverKeyOf,
  takeoverOverrideOf,
} from "../dist/bu_agent/chat_session.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const frontendSettings = readFileSync(join(ROOT, "src", "lib", "chatModeSettings.ts"), "utf8");
const rpaSession = readFileSync(join(ROOT, "src-tauri", "src", "rpa_session.rs"), "utf8");
const chatPatrol = readFileSync(join(ROOT, "src-tauri", "src", "chat_patrol.rs"), "utf8");
const chatModal = readFileSync(
  join(ROOT, "src", "components", "chat", "ChatModeModal.tsx"),
  "utf8",
);
const chatContextRs = readFileSync(join(ROOT, "src-tauri", "src", "chat_context.rs"), "utf8");
const chatEventLabels = readFileSync(
  join(ROOT, "src", "components", "chat", "chatEventLabels.ts"),
  "utf8",
);

/** 递归收集某个目录下的源码文件 */
function sourceFiles(dir, suffix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path, suffix));
    else if (entry.name.endsWith(suffix)) out.push(path);
  }
  return out;
}

/** 从源码里抽 `名称: [下限, 上限]` 这种字面量数组 */
function limitsFromSource(source, name) {
  const match = new RegExp(`${name}\\s*:\\s*\\[\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*\\]`).exec(source);
  assert.ok(match, `源码里找不到 ${name}`);
  return [Number(match[1]), Number(match[2])];
}

/** 从源码里抽常量声明 `const NAME = 15_000;` / `const NAME: u64 = 15_000;` */
function numberFromSource(source, name) {
  const match = new RegExp(`${name}\\s*(?::\\s*\\w+)?\\s*=\\s*([\\d_]+)`).exec(source);
  assert.ok(match, `源码里找不到常量 ${name}`);
  return Number(match[1].replace(/_/g, ""));
}

/** 从对象字面量里抽数值字段 `sliceMs: 90_000,` */
function fieldFromObject(source, name) {
  const match = new RegExp(`\\b${name}\\s*:\\s*([\\d_]+)`).exec(source);
  assert.ok(match, `对象字面量里找不到字段 ${name}`);
  return Number(match[1].replace(/_/g, ""));
}

/* ————————————————————— 节奏：默认值与区间两侧逐字一致 ————————————————————— */

test("节奏默认值：前端 DEFAULT_CHAT_CADENCE 与侧车 DEFAULT_CADENCE 逐字一致", () => {
  const block = /DEFAULT_CHAT_CADENCE[^{]*\{([\s\S]*?)\n\};/.exec(frontendSettings);
  assert.ok(block, "找不到前端 DEFAULT_CHAT_CADENCE 字面量");
  const body = block[1];
  const field = (name) => {
    const match = new RegExp(`\\b${name}:\\s*([\\d.]+)`).exec(body);
    assert.ok(match, `前端默认值缺少 ${name}`);
    return Number(match[1]);
  };

  assert.equal(field("followUpHours"), DEFAULT_CADENCE.followUpHours);
  assert.equal(field("maxFollowUps"), DEFAULT_CADENCE.maxFollowUps);
  assert.equal(field("followUpCoolDownDays"), DEFAULT_CADENCE.followUpCoolDownDays);
  assert.equal(field("followUpRevivalDays"), DEFAULT_CADENCE.followUpRevivalDays);
  assert.equal(field("maxPerDay"), DEFAULT_CADENCE.maxPerDay);
  assert.equal(field("jitterRatio"), DEFAULT_CADENCE.jitterRatio);

  const backoff = /followUpBackoffHours:\s*\[([^\]]*)\]/.exec(body);
  assert.ok(backoff, "前端默认值缺少 followUpBackoffHours");
  assert.deepEqual(
    backoff[1].split(",").map((entry) => Number(entry.trim())),
    DEFAULT_CADENCE.followUpBackoffHours,
  );

  // 回访产品默认关闭：两侧 followUpEnabled=false、quietHours=null
  assert.ok(/followUpEnabled:\s*false/.test(body), "前端默认必须关掉定时回访");
  assert.equal(DEFAULT_CADENCE.followUpEnabled, false);
  assert.ok(/quietHours:\s*null/.test(body), "前端默认 quietHours 必须是 null");
  assert.equal(DEFAULT_CADENCE.quietHours, null);
  assert.equal(DEFAULT_CADENCE.maxFollowUps, 0);
  assert.equal(DEFAULT_CADENCE.maxPerDay, 0);
});

test("节奏区间：前端 CADENCE_LIMITS 与侧车 CADENCE_LIMITS 逐个字段相同", () => {
  for (const key of Object.keys(CADENCE_LIMITS)) {
    assert.deepEqual(
      limitsFromSource(frontendSettings, key),
      [...CADENCE_LIMITS[key]],
      `CADENCE_LIMITS.${key} 两侧不一致（设置里能填的和引擎接受的不是一回事）`,
    );
  }
});

test("节奏区间真的生效：越界被夹住，0 的实义值不被默认值顶掉", () => {
  const cadence = parseCadence({
    followUpHours: 99_999,
    maxFollowUps: 0,
    followUpCoolDownDays: 0,
    followUpRevivalDays: 0,
    maxPerDay: 0,
    jitterRatio: 5,
  });
  assert.equal(cadence.followUpHours, CADENCE_LIMITS.followUpHours[1]);
  assert.equal(cadence.maxFollowUps, 0, "maxFollowUps=0 是实义值（不追发）");
  assert.equal(cadence.followUpCoolDownDays, 0, "冷却 0 是实义值（不冷却）");
  // 0 低于下限 1 → 夹到 1（不是回落默认 90，也不是原样 0）
  assert.equal(cadence.followUpRevivalDays, CADENCE_LIMITS.followUpRevivalDays[0]);
  assert.equal(cadence.maxPerDay, 0, "maxPerDay=0 = 不限，必须真的传下去");
  assert.equal(cadence.jitterRatio, CADENCE_LIMITS.jitterRatio[1]);
});

test("非法静默时段不会被原样喂给引擎（两侧同一套文法）", () => {
  assert.deepEqual(normalizeQuietHours({ start: "9:05", end: "08:00" }), {
    start: "09:05",
    end: "08:00",
  });
  assert.equal(normalizeQuietHours({ start: "25:00", end: "08:00" }), undefined);
  assert.equal(normalizeQuietHours({ start: "abc", end: "08:00" }), undefined);
  assert.equal(normalizeQuietHours({ start: "22:00" }), undefined);
  assert.equal(normalizeQuietHours(null), null);
  assert.equal(normalizeQuietHours(undefined), undefined);

  // 侧车：非法 → 回落默认（现在默认是 null）；显式 null → 真的不设静默
  assert.equal(parseCadence({ quietHours: { start: "25:00", end: "99:99" } }).quietHours, DEFAULT_CADENCE.quietHours);
  assert.equal(parseCadence({ quietHours: null }).quietHours, null);
  // 前端源码里必须存在同名同义的纯函数（两侧共用一个口径，不是各写一份）
  assert.ok(/export function normalizeQuietHours/.test(frontendSettings));
});

/* ————————————————————— 切片与并发：三端同一套数字 ————————————————————— */

test("切片常量：前端 / 侧车 / 宿主三端一致", () => {
  assert.equal(numberFromSource(frontendSettings, "CHAT_SLICE_MS_MIN"), CHAT_SLICE_MS_MIN);
  assert.equal(numberFromSource(frontendSettings, "CHAT_SLICE_MS_MAX"), CHAT_SLICE_MS_MAX);
  assert.equal(
    numberFromSource(frontendSettings, "CHAT_CONTACTS_PER_SLICE_MAX"),
    CHAT_CONTACTS_PER_SLICE_MAX,
  );
  assert.equal(numberFromSource(frontendSettings, "CHAT_PARALLEL_MAX"), CHAT_PARALLEL_HARD_MAX);

  assert.equal(numberFromSource(rpaSession, "CHAT_SLICE_MIN_MS"), CHAT_SLICE_MS_MIN);
  assert.equal(numberFromSource(rpaSession, "CHAT_SLICE_DEFAULT_MS"), CHAT_SLICE_MS_DEFAULT);
  assert.equal(numberFromSource(rpaSession, "CHAT_SLICE_MAX_MS"), CHAT_SLICE_MS_MAX);
  assert.equal(numberFromSource(chatPatrol, "CHAT_PARALLEL_HARD_MAX"), CHAT_PARALLEL_HARD_MAX);

  // 设置面板的默认值也要跟侧车默认值一致（否则「不改设置」就是两套起跑线）
  const defaults = /DEFAULT_CHAT_MODE_SETTINGS[^{]*\{([\s\S]*?)\n\};/.exec(frontendSettings);
  assert.ok(defaults, "找不到前端 DEFAULT_CHAT_MODE_SETTINGS 字面量");
  assert.equal(
    fieldFromObject(defaults[1], "maxContactsPerSlice"),
    CHAT_CONTACTS_PER_SLICE_DEFAULT,
  );
  assert.equal(fieldFromObject(defaults[1], "sliceMs"), CHAT_SLICE_MS_DEFAULT);
});

test("useCurrentWindow 默认开：前端 / 宿主两处口径一致", () => {
  const defaults = /DEFAULT_CHAT_MODE_SETTINGS[^{]*\{([\s\S]*?)\n\};/.exec(frontendSettings);
  assert.ok(defaults);
  assert.ok(/useCurrentWindow:\s*true/.test(defaults[1]), "前端默认值必须是开");
  // 前端解析：只有显式 false 才算关
  assert.ok(/source\.useCurrentWindow\s*!==\s*false/.test(frontendSettings));

  // 宿主两处入口都必须默认开（手动起一片 + 自动值守）
  assert.ok(
    /use_current_window:\s*use_current_window\.unwrap_or\(true\)/.test(rpaSession),
    "rpa_session::chat_start 的默认值必须是开",
  );
  assert.ok(
    /use_current_window:\s*value[\s\S]{0,240}?\.unwrap_or\(true\)/.test(chatPatrol),
    "chat_patrol::LaunchSettings 的默认值必须是开",
  );
});

/* ————————————————————— 接管键：一个概念一套拼法 ————————————————————— */

test("接管键：前端 / 侧车 / 宿主三处同一套（否则点了「引擎值守」毫无反应）", () => {
  // 侧车是权威实现：站点目录段 + 联系人目录段（清洗后）
  assert.equal(takeoverKeyOf({ key: "unknown|Anne", siteKey: "unknown" }), "unknown|unknown_Anne");

  // 前端同一个拼法
  assert.ok(
    /export function takeoverKeyOf\(siteKey: string, contactKey: string\): string \{[\s\S]{0,80}?return `\$\{siteKey\}\|\$\{contactKey\}`;/.test(
      frontendSettings,
    ),
    "前端 takeoverKeyOf 的拼法必须与侧车一致",
  );
  // 视图只许调这个函数，不许自己拼键（拼法会漂）
  assert.ok(chatModal.includes("takeoverKeyOf("), "视图必须用 takeoverKeyOf");
  assert.ok(
    !/\$\{contact\.siteKey\}\|\$\{contact\.contactKey\}/.test(chatModal),
    "视图里不许再出现手拼的接管键",
  );

  // 宿主 overlay：快照的原始键必须清洗成目录段才可能与索引表的行对上
  assert.ok(
    /let Some\(key\) = str_at\(row, "\/key"\)/.test(chatContextRs) &&
      /thread_key_of\(str_at\(row, "\/siteKey"\)\.as_deref\(\), &key\)/.test(chatContextRs),
    "chat_context::read_chat_takeovers 必须走 thread_key_of 清洗",
  );
  assert.ok(
    /by_key\.get\(&key\)/.test(chatContextRs),
    "overlay 必须按（站点, 联系人）配对查表，不许只按联系人目录名",
  );
});

/* ————————————————————— 每联系人开关：与接管同一套键、同一份来源 ————————————————————— */

test("每联系人开关：与接管键同源（否则卡片上的开关点了对不上那位联系人）", () => {
  const seed = { key: "unknown|Anne", siteKey: "unknown" };
  const key = takeoverKeyOf(seed); // unknown|unknown_Anne

  const flags = parseContactFlags(
    {
      [key]: { autoReply: false, followUp: true },
      "unknown|Anne": { followUp: false }, // 迁移读：老设置里可能存的是会话键那一版
      "unknown|Bob": { autoReply: "yes" }, // 坏值 → 整条丢弃
      "unknown|Carol": {}, // 全空 → 等于没设置
    },
    [],
  );
  assert.deepEqual(Object.keys(flags).sort(), ["unknown|Anne", key].sort());
  assert.deepEqual(flags[key], { autoReply: false, followUp: true });

  // 查表：规范键优先，缺了才回落到迁移读；两者都没有就是「没设置」（＝默认开）
  assert.deepEqual(contactFlagsOf(flags, seed), { autoReply: false, followUp: true });
  assert.deepEqual(contactFlagsOf(flags, { key: "unknown|Anne", siteKey: "unknown" }), {
    autoReply: false,
    followUp: true,
  });
  assert.equal(contactFlagsOf(flags, { key: "unknown|Dave", siteKey: "unknown" }), undefined);
  assert.equal(contactFlagsOf(undefined, seed), undefined);

  // 坏值不许静默消失（必须回报，否则用户以为关掉了自动回复、其实还在发）
  const diagnostics = [];
  parseContactFlags({ "unknown|Bob": { autoReply: "yes" } }, diagnostics);
  assert.deepEqual(diagnostics, ["contact_flags_invalid:unknown|Bob:autoReply"]);

  // 与接管同一套键空间：两边对同一个 seed 必须查到同一条记录
  const takeovers = parseTakeovers({ [key]: "human" }, []);
  assert.equal(takeoverOverrideOf(takeovers, seed), "human");
  assert.equal(takeoverOverrideOf(takeovers, { key: "unknown|Anne", siteKey: "unknown" }), "human");
});

test("每联系人开关与全局开关都真的接到引擎上（不是画了一个没人读的开关）", () => {
  // ① 视图把两个开关的当前值随片一起发给引擎（否则引擎只能看到默认值）
  assert.ok(
    /contactFlags:\s*settings\.contactFlags/.test(chatModal),
    "ChatModeModal 必须把 contactFlags 随 chatStart 一起发下去",
  );
  // ② 状态带角色选择器写的是 activeRoleId（同一个 chat_mode 设置键，不是第二套控制）
  assert.ok(
    /activeRoleId:\s*next\s*\|\|\s*null/.test(chatModal) ||
      /activeRoleId:\s*.+\|\|\s*null/.test(chatModal),
    "视图的状态带必须能写 activeRoleId",
  );
  assert.ok(
    /roles:\s*settings\.roles/.test(chatModal) && /activeRoleId:\s*settings\.activeRoleId/.test(chatModal),
    "ChatModeModal 必须把 roles / activeRoleId 随 chatStart 一起发下去",
  );
  assert.ok(
    /taskRules:\s*policy\.taskRules/.test(chatModal) && /taskPersona:\s*policy\.taskPersona/.test(chatModal),
    "ChatModeModal 必须把 @ 展开后的 taskRules / taskPersona 随 chatStart 发下去",
  );
  assert.ok(
    /task_rules/.test(readFileSync(join(ROOT, "src-tauri", "src", "rpa_session.rs"), "utf8")),
    "Host chat_start 必须能转发 task_rules",
  );
  assert.ok(
    /task_rules/.test(readFileSync(join(ROOT, "src-tauri", "src", "chat_patrol.rs"), "utf8")),
    "调度器必须从 chat_mode 读 taskRules 并转发",
  );
  assert.ok(
    /mediaLibraryDir/.test(frontendSettings) && /mediaLibraryDir:\s*""/.test(frontendSettings),
    "前端默认图库目录必须是空串（= 软件自带）",
  );
  assert.ok(
    /media_library_dir/.test(readFileSync(join(ROOT, "src-tauri", "src", "rpa_session.rs"), "utf8")),
    "Host chat_start 必须能转发 media_library_dir",
  );
  assert.ok(
    /mediaLibraryDir/.test(readFileSync(join(ROOT, "src-tauri", "src", "chat_patrol.rs"), "utf8")),
    "调度器必须从 chat_mode 读 mediaLibraryDir 并转发",
  );
  // ③ 「读取当前页面会话列表」真的调只读探针，而不是本地编一份
  assert.ok(/chatListContacts\(/.test(chatModal), "视图必须调 chatListContacts 读会话列表");

  // ③b 列表里每行的开关用的是**侧车算好的键**（前端没有 siteKeyOf / sanitizeSegment，
  //     自己拼迟早对不上 → 「在列表里关了自动回复，引擎照样开口」，§0.5.3 H）
  assert.ok(/item\.flagKey/.test(chatModal), "视图必须用侧车回传的 flagKey 写开关");
  assert.ok(/from "\.\/contactCard"/.test(chatModal) && /FlagToggle/.test(chatModal), "列表里必须有每行开关");
  const chatContacts = readFileSync(
    join(ROOT, "sidecar", "src", "bu_agent", "chat_contacts.ts"),
    "utf8",
  );
  assert.ok(
    /seedIdentityOf\(/.test(chatContacts) && /takeoverKeyOf\(/.test(chatContacts),
    "读会话列表必须走与引擎同一套身份派生（seedIdentityOf + takeoverKeyOf）",
  );
  assert.ok(
    /flagKey: item\.flagKey/.test(readFileSync(join(ROOT, "sidecar", "src", "index.ts"), "utf8")),
    "chat_contacts_list 必须把 flagKey 回传给视图",
  );

  // ④ 侧车：引擎确实按 autoReply 分支；角色经装配层注入草稿提示词
  const engine = readFileSync(join(ROOT, "sidecar", "src", "core", "web_chat", "engine.ts"), "utf8");
  const chatSessionSrc = readFileSync(
    join(ROOT, "sidecar", "src", "bu_agent", "chat_session.ts"),
    "utf8",
  );
  assert.ok(/autoReplyOf\(ctx\.contact\)/.test(engine), "引擎必须按 autoReply 开关决定回不回");
  assert.ok(/activeRoleOf\(config\)/.test(chatSessionSrc), "草稿装配必须读出当前角色");
  assert.ok(
    /roleName:\s*activeRole\?\.name/.test(chatSessionSrc) &&
      /rolePrompt:\s*activeRole\?\.prompt/.test(chatSessionSrc),
    "草稿提示词必须带上 roleName / rolePrompt",
  );

  // ⑤ 设置的改动必须**立刻在卡片上看得见**：卡片的自动聊天开关以前只显示引擎快照，
  //    而设置是「片启动时」才读进引擎的 —— 点了按钮界面一动不动，用户判定「点了没用」（现场）。
  assert.ok(
    /const effectiveContacts = useMemo/.test(chatModal) &&
      /settings\.contactFlags\[key\]/.test(chatModal),
    "联系人卡片必须把 contactFlags 叠到快照上（设置是「做什么」的可见权威）",
  );
  assert.ok(
    /effectiveContacts\.map\(/.test(chatModal),
    "右侧联系人列表必须渲染叠加后的卡片",
  );

  // ⑥ 会话列表**自动**读一次（用户要的就是「自动获取聊天列表」，不是先猜到有个按钮）
  assert.ok(
    /void handleReadThreads\(true\)/.test(chatModal),
    "打开视图时必须自动读一次会话列表（quiet）",
  );

  // ⑦ 侧车：「绑当前窗口、只读不导航」只对**没指定对象**成立（设置项原话就是「未指定对象时」）。
  //    有显式目标时必须能打开过去，否则页面停在会话列表（Telegram 首屏）时整片只会「一秒结束」。
  const session = readFileSync(join(ROOT, "sidecar", "src", "bu_agent", "chat_session.ts"), "utf8");
  assert.ok(
    /useCurrentWindowMode\(config\.useCurrentWindow, contacts\.length\)/.test(session),
    "chat_session 必须按「有没有显式目标」决定是否绑用户当前窗口",
  );
  assert.ok(
    !/if \(config\.useCurrentWindow\)/.test(session),
    "不许再直接按设置项分支（那样有目标时也只会绑当前窗口、开不了会话）",
  );
  // ⑧ 身份定稿后键会变：`openContact` 必须用**解析后**的名单找直链，否则 URL 被丢掉
  assert.ok(
    /resolvedSeeds\.find\(\(c\) => c\.key === contact\.key\)/.test(session),
    "openContact 必须在解析后的名单里找目标（否则会话直链丢失、退化成按昵称点列表）",
  );
});

/* ————————————————————— 事件标签：一张完备的表，不做子串猜测 ————————————————————— */

/**
 * 这三个是**协议事件**（宿主/前端按顶层 `type` 分发），不是聊天日志的 kind：
 *   - `chat_status`：`logger.result("chat_status", …)` 的应答（不是进度行）
 *   - `chat_reply`：Ai Chat（`chat.ts`）的输出，属于另一个模块
 *   - `chat_contacts_list`：只读探针「读会话列表」的应答（宿主单独一条分发分支，
 *     不进值守日志流）
 * 它们**不**该进标签表 —— 但为了让「发射方 ⊆ 标签表」这条断言能覆盖全仓，
 * 这里显式列出并另加一条断言确认它们确实还是协议事件（防止这个豁免烂掉）。
 */
const PROTOCOL_EVENT_TYPES = new Set(["chat_status", "chat_reply", "chat_contacts_list"]);

test("事件标签表完备：侧车/宿主发射的每个 kind 都有中文标签（新事件忘了登记就红）", () => {
  const block = /CHAT_EVENT_STYLES[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(chatEventLabels);
  assert.ok(block, "找不到 CHAT_EVENT_STYLES 表");
  const labelled = new Set(
    [...block[1].matchAll(/^\s*(chat_[a-z_]+):\s*\{/gm)].map((match) => match[1]),
  );
  assert.ok(labelled.size >= 40, `标签表条目太少（${labelled.size}）`);

  const emitted = new Set();

  // ① 侧车：`type` / `kind` 字段里的 kind
  for (const file of sourceFiles(join(ROOT, "sidecar", "src"), ".ts")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["']?(?:type|kind)["']?\s*:\s*"(chat_[a-z_]+)"/g)) {
      if (!PROTOCOL_EVENT_TYPES.has(match[1])) emitted.add(match[1]);
    }
  }
  // 日志壳的兜底 kind（`json-logger.ts` 在没给 kind 时用它，也必须能显示成中文）
  assert.ok(
    /"chat_note"/.test(readFileSync(join(ROOT, "sidecar", "src", "json-logger.ts"), "utf8")),
    "日志壳的兜底 kind 变了，请同步本测试与标签表",
  );
  emitted.add("chat_note");

  // ② 宿主：只认真正发事件的两处写法（`emit_patrol(...)` 的 kind 参数、补发的 `"kind": "…"`）
  for (const name of ["chat_patrol.rs", "rpa_session.rs"]) {
    const source = readFileSync(join(ROOT, "src-tauri", "src", name), "utf8");
    for (const call of source.matchAll(/emit_patrol\(([\s\S]*?)\);/g)) {
      for (const kind of call[1].matchAll(/"(chat_[a-z_]+)"/g)) emitted.add(kind[1]);
    }
    for (const match of source.matchAll(/"kind"\s*:\s*"(chat_[a-z_]+)"/g)) emitted.add(match[1]);
  }

  for (const kind of emitted) {
    assert.ok(labelled.has(kind), `发射了 ${kind}，但标签表里没有它（用户会看到 snake_case）`);
  }
  // 反向：表里不许留「从来没发过」的死标签（以前就有 `chat_read_conversation` 这种）
  for (const kind of labelled) {
    assert.ok(emitted.has(kind), `标签表里的 ${kind} 没有任何发射方，属于死标签`);
  }

  // 豁免项必须仍然是协议事件，否则这个例外会慢慢变成「什么都往里塞」
  const jsonLogger = readFileSync(join(ROOT, "sidecar", "src", "json-logger.ts"), "utf8");
  assert.ok(
    /chatStatus\(status: string[\s\S]{0,160}?type: "chat_status"/.test(jsonLogger),
    "chat_status 不再是协议状态行，请从豁免里删掉",
  );
  assert.ok(
    /type: "chat_reply"/.test(readFileSync(join(ROOT, "sidecar", "src", "chat.ts"), "utf8")),
    "chat_reply 不再是 Ai Chat 的协议事件了，请从豁免里删掉",
  );
  assert.ok(
    /type: "chat_contacts_list"/.test(readFileSync(join(ROOT, "sidecar", "src", "index.ts"), "utf8")),
    "chat_contacts_list 不再是只读探针的协议应答了，请从豁免里删掉",
  );

  // 色调跟着 kind 走，不许有子串判据（§0.5.3 A）
  assert.ok(
    !/includes\("failed"\)|includes\("rejected"\)|includes\("watchdog"\)/.test(chatEventLabels),
    "事件色调不许再用子串猜测",
  );

  // 值守日志面板：相位机内部流转 / 调度叠片拉起 不得刷给普通人（showInLog: false）
  for (const quiet of [
    "chat_phase",
    "chat_send_submitted",
    "chat_persist",
    "chat_descriptor_selected",
    "chat_patrol_launch",
  ]) {
    const row = new RegExp(`${quiet}:\\s*\\{[\\s\\S]*?showInLog:\\s*false`).exec(chatEventLabels);
    assert.ok(row, `${quiet} 必须标 showInLog: false，否则值守日志又会刷相位/描述符术语`);
  }
  assert.ok(
    /stopReason\s*===\s*"engine_busy"/.test(chatEventLabels),
    "叠片正忙拒绝必须按 stopReason=engine_busy 隐藏，不许靠中文子串猜",
  );
});

test("角色库上限：前端与侧车逐字一致", () => {
  const sidecarConfig = readFileSync(
    join(ROOT, "sidecar", "src", "bu_agent", "chat_session_config.ts"),
    "utf8",
  );
  for (const name of ["CHAT_ROLES_MAX", "CHAT_ROLE_NAME_MAX", "CHAT_ROLE_PROMPT_MAX"]) {
    assert.equal(
      numberFromSource(frontendSettings, name),
      numberFromSource(sidecarConfig, name),
      `${name} 两侧不一致`,
    );
  }
  assert.ok(/roles:\s*\[\]/.test(frontendSettings), "默认角色库必须是空数组");
  assert.ok(/activeRoleId:\s*null/.test(frontendSettings), "默认当前角色必须是 null");
  assert.ok(/export function parseRoles\(/.test(sidecarConfig), "侧车必须有 parseRoles");
  assert.ok(/export function parseActiveRoleId\(/.test(sidecarConfig), "侧车必须有 parseActiveRoleId");
  assert.ok(/roles:\s*settings\.roles\.clone\(\)/.test(chatPatrol), "调度器必须原样转发 roles");
  assert.ok(/"roles"/.test(rpaSession) && /active_role_id/.test(rpaSession), "Host 必须转发角色字段");
});

