import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/** 指纹浏览器默认首页 / 新标签目标 */
export const DEFAULT_HOMEPAGE_URL = "https://www.browserscan.net/zh";

const GOOGLE_SEARCH_URL =
  "https://www.google.com/search?q={searchTerms}&ie={inputEncoding}";
const GOOGLE_SUGGEST_URL =
  "https://www.google.com/complete/search?client=chrome&q={searchTerms}";
const GOOGLE_FAVICON_URL = "https://www.google.com/favicon.ico";
const GOOGLE_IMAGE_URL = "https://www.google.com/searchbyimage/upload";
const GOOGLE_ALTERNATE_URLS = JSON.stringify([
  "https://www.google.com/#q={searchTerms}",
  "https://www.google.com/search?q={searchTerms}",
]);
/** CloakBrowser / ungoogled 系把 prepopulate_id=1 换成「No Search」 */
const NO_SEARCH_URL = "http://{searchTerms}";
const GOOGLE_SYNC_GUID = "485bf7d3-0215-45af-87dc-538868000001";

/**
 * 上次进程被强杀时 Chromium 会在 Preferences 中留下 exit_type=Crashed，
 * 导致每次启动弹出 “Restore pages?” 且自动化环境下 Restore 无效。
 * 同时把默认搜索从内核自带的「No Search」(http://{searchTerms}) 换成 Google，
 * 否则地址栏输入「翻译」会变成导航 http://翻译。
 */
export async function sanitizeProfileExitState(userDataDir: string): Promise<void> {
  await ensureDefaultSearchAndExitState(path.join(userDataDir, "Default", "Preferences"));
  await ensureGoogleDefaultSearchInWebData(path.join(userDataDir, "Default", "Web Data"));
  await sanitizeLocalStateFile(path.join(userDataDir, "Local State"));
}

function buildGoogleSearchProviderData(): Record<string, unknown> {
  return {
    template_url_data: {
      short_name: "Google",
      keyword: "google.com",
      favicon_url: GOOGLE_FAVICON_URL,
      url: GOOGLE_SEARCH_URL,
      suggestions_url: GOOGLE_SUGGEST_URL,
      image_url: GOOGLE_IMAGE_URL,
      new_tab_url: DEFAULT_HOMEPAGE_URL,
      contextual_search_url: "",
      image_url_post_params: "",
      search_url_post_params: "",
      suggestions_url_post_params: "",
      alternate_urls: [
        "https://www.google.com/#q={searchTerms}",
        "https://www.google.com/search?q={searchTerms}",
      ],
      input_encodings: ["UTF-8"],
      prepopulate_id: 1,
      created_by_policy: true,
      safe_for_autoreplace: false,
      date_created: "0",
      last_modified: "0",
      sync_guid: GOOGLE_SYNC_GUID,
      id: 1,
    },
  };
}

function ensureObjectRecord(
  parent: Record<string, unknown>,
  key: string,
): { record: Record<string, unknown>; changed: boolean } {
  const current = parent[key];
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return { record: current as Record<string, unknown>, changed: false };
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return { record: created, changed: true };
}

/**
 * CloakBrowser 把 Google 预置位换成「No Search」(url=http://{searchTerms})。
 * Preferences 注入会被 Secure Preferences HMAC 清掉，必须改 Web Data keywords。
 * safe_for_autoreplace=0，避免下次启动又被内置表盖回 No Search。
 */
function ensureGoogleDefaultSearchInWebData(webDataPath: string): void {
  if (!existsSync(webDataPath)) return;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(webDataPath);
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='keywords' LIMIT 1",
      )
      .get() as { name?: string } | undefined;
    if (!table?.name) return;

    const rows = db
      .prepare(
        "SELECT id, url, keyword, short_name, safe_for_autoreplace FROM keywords WHERE prepopulate_id = 1 OR keyword = 'nosearch' OR url = ?",
      )
      .all(NO_SEARCH_URL) as Array<{
      id: number;
      url: string;
      keyword: string;
      short_name: string;
      safe_for_autoreplace: number;
    }>;

    const needsPatch =
      rows.length === 0 ||
      rows.some(
        (row) =>
          row.url === NO_SEARCH_URL ||
          row.keyword === "nosearch" ||
          !String(row.url).includes("google.com/search") ||
          Number(row.safe_for_autoreplace) !== 0,
      );

    // 已是 Google 且不会被 autoreplace：仍确保至少有一条可作默认
    if (!needsPatch) {
      const googleOk = db
        .prepare(
          "SELECT id FROM keywords WHERE url LIKE '%google.com/search%' AND prepopulate_id = 1 LIMIT 1",
        )
        .get();
      if (googleOk) return;
    }

    const update = db.prepare(`
      UPDATE keywords SET
        short_name = 'Google',
        keyword = 'google.com',
        favicon_url = ?,
        url = ?,
        suggest_url = ?,
        image_url = ?,
        alternate_urls = ?,
        new_tab_url = ?,
        input_encodings = 'UTF-8',
        safe_for_autoreplace = 0,
        created_by_policy = 1,
        enforced_by_policy = 0,
        is_active = 1,
        url_hash = NULL,
        last_modified = 0
      WHERE id = ?
    `);

    if (rows.length > 0) {
      for (const row of rows) {
        update.run(
          GOOGLE_FAVICON_URL,
          GOOGLE_SEARCH_URL,
          GOOGLE_SUGGEST_URL,
          GOOGLE_IMAGE_URL,
          GOOGLE_ALTERNATE_URLS,
          DEFAULT_HOMEPAGE_URL,
          row.id,
        );
      }
      return;
    }

    // 无 prepopulate_id=1 行时插入一条 Google，占默认位
    db.prepare(`
      INSERT INTO keywords (
        short_name, keyword, favicon_url, url, safe_for_autoreplace,
        originating_url, date_created, usage_count, input_encodings,
        suggest_url, prepopulate_id, created_by_policy, last_modified,
        sync_guid, alternate_urls, image_url, search_url_post_params,
        suggest_url_post_params, image_url_post_params, new_tab_url,
        last_visited, created_from_play_api, is_active, starter_pack_id,
        enforced_by_policy, featured_by_policy, url_hash
      ) VALUES (
        'Google', 'google.com', ?, ?, 0,
        '', 0, 0, 'UTF-8',
        ?, 1, 1, 0,
        ?, ?, ?, '',
        '', '', ?,
        0, 0, 1, 0,
        0, 0, NULL
      )
    `).run(
      GOOGLE_FAVICON_URL,
      GOOGLE_SEARCH_URL,
      GOOGLE_SUGGEST_URL,
      GOOGLE_SYNC_GUID,
      GOOGLE_ALTERNATE_URLS,
      GOOGLE_IMAGE_URL,
      DEFAULT_HOMEPAGE_URL,
    );
  } catch {
    // Web Data 被占用或结构变化时不阻断启动
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

async function ensureDefaultSearchAndExitState(prefsPath: string): Promise<void> {
  try {
    await mkdir(path.dirname(prefsPath), { recursive: true });

    let prefs: Record<string, unknown> = {};
    try {
      const raw = await readFile(prefsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        prefs = parsed as Record<string, unknown>;
      }
    } catch {
      // 首次启动：Preferences 尚不存在，写入完整默认值
    }

    let changed = false;

    const profile = prefs.profile;
    if (typeof profile === "object" && profile !== null && !Array.isArray(profile)) {
      const profileRecord = profile as Record<string, unknown>;
      const exitType = String(profileRecord.exit_type ?? "");
      if (exitType && exitType !== "Normal") {
        profileRecord.exit_type = "Normal";
        changed = true;
      }
    } else {
      prefs.profile = { exit_type: "Normal" };
      changed = true;
    }

    // Preferences 注入：首次启动 / HMAC 未锁时有效；主路径仍以 Web Data 为准
    const nextSearchData = buildGoogleSearchProviderData();
    const prevSearchData = prefs.default_search_provider_data;
    const prevUrl =
      typeof prevSearchData === "object" &&
      prevSearchData !== null &&
      !Array.isArray(prevSearchData) &&
      typeof (prevSearchData as Record<string, unknown>).template_url_data === "object"
        ? String(
            (
              (prevSearchData as Record<string, unknown>).template_url_data as Record<
                string,
                unknown
              >
            ).url ?? "",
          )
        : "";
    if (!prevUrl.includes("google.com/search")) {
      prefs.default_search_provider_data = nextSearchData;
      changed = true;
    } else {
      const template = (prevSearchData as Record<string, unknown>).template_url_data as Record<
        string,
        unknown
      >;
      if (template.new_tab_url !== DEFAULT_HOMEPAGE_URL) {
        template.new_tab_url = DEFAULT_HOMEPAGE_URL;
        changed = true;
      }
      if (template.safe_for_autoreplace !== false) {
        template.safe_for_autoreplace = false;
        changed = true;
      }
    }

    const provider = prefs.default_search_provider;
    if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
      prefs.default_search_provider = { enabled: true };
      changed = true;
    } else if ((provider as Record<string, unknown>).enabled !== true) {
      (provider as Record<string, unknown>).enabled = true;
      changed = true;
    }

    const search = prefs.search;
    if (typeof search !== "object" || search === null || Array.isArray(search)) {
      prefs.search = { suggest_enabled: true };
      changed = true;
    } else if ((search as Record<string, unknown>).suggest_enabled !== true) {
      (search as Record<string, unknown>).suggest_enabled = true;
      changed = true;
    }

    if (prefs.homepage !== DEFAULT_HOMEPAGE_URL) {
      prefs.homepage = DEFAULT_HOMEPAGE_URL;
      changed = true;
    }
    if (prefs.homepage_is_newtabpage !== false) {
      prefs.homepage_is_newtabpage = false;
      changed = true;
    }

    const browserEns = ensureObjectRecord(prefs, "browser");
    changed = changed || browserEns.changed;
    if (browserEns.record.show_home_button !== true) {
      browserEns.record.show_home_button = true;
      changed = true;
    }

    const sessionEns = ensureObjectRecord(prefs, "session");
    changed = changed || sessionEns.changed;
    if (sessionEns.record.restore_on_startup !== 4) {
      sessionEns.record.restore_on_startup = 4;
      changed = true;
    }
    const startupUrls = sessionEns.record.startup_urls;
    const urlsOk =
      Array.isArray(startupUrls) &&
      startupUrls.length === 1 &&
      String(startupUrls[0]) === DEFAULT_HOMEPAGE_URL;
    if (!urlsOk) {
      sessionEns.record.startup_urls = [DEFAULT_HOMEPAGE_URL];
      changed = true;
    }

    if (changed) {
      await writeFile(prefsPath, JSON.stringify(prefs));
    }
  } catch {
    // Preferences 读写失败时不阻断启动
  }
}

async function sanitizeLocalStateFile(localStatePath: string): Promise<void> {
  try {
    const raw = await readFile(localStatePath, "utf8");
    const state = JSON.parse(raw) as Record<string, unknown>;
    let changed = false;

    if (state.exited_cleanly === false) {
      state.exited_cleanly = true;
      changed = true;
    }

    if (changed) {
      await writeFile(localStatePath, JSON.stringify(state));
    }
  } catch {
    // 忽略
  }
}
