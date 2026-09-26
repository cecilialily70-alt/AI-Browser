use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use std::collections::HashSet;
use std::net::TcpListener;

use rand::Rng;

use crate::error::AppError;
use crate::log_info;
use crate::log_warn;
use crate::models::{BatchCreateProfilesInput, Profile, Proxy};
use crate::proxy::{self, parse_custom_proxy_json, parse_dynamic_api_config, apply_region_to_api_url};

const CDP_PORT_START: u16 = 9222;
const CDP_PORT_END: u16 = 9322;

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL CHECK ("type" IN ('HTTP', 'SOCKS5')),
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    username TEXT,
    password TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
    cdp_port INTEGER CHECK (cdp_port IS NULL OR cdp_port BETWEEN 1 AND 65535),
    status TEXT NOT NULL DEFAULT 'stopped',
    fraud_score INTEGER NOT NULL DEFAULT -1,
    fraud_details TEXT,
    theme_color TEXT NOT NULL DEFAULT '#6366f1',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS global_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_profiles_proxy_id ON profiles(proxy_id);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
"#;

const PROFILE_COLUMNS: &str =
    "id, name, proxy_id, cdp_port, status, fraud_score, fraud_details, theme_color, created_at, custom_proxy, use_geoip, humanize, fingerprint_seed, stealth_preset, interactive_element_extract_enabled, webgl_mode, browser_version, persona_data, startup_urls, agent_panorama_enabled, otp_channel";

pub fn random_fingerprint_seed() -> String {
    rand::rng().random_range(10_000..=99_999).to_string()
}

fn normalize_webgl_mode(raw: &str) -> Result<String, AppError> {
    match raw.trim().to_lowercase().as_str() {
        "local" => Ok("local".to_owned()),
        "random" => Ok("random".to_owned()),
        other => Err(AppError::Validation(format!(
            "webgl_mode must be local or random, got: {other}"
        ))),
    }
}

fn normalize_stealth_preset(raw: &str) -> Result<String, AppError> {
    match raw.trim() {
        "default" | "" => Ok("default".to_owned()),
        "fpjs_bypass" => Ok("fpjs_bypass".to_owned()),
        other => Err(AppError::Validation(format!(
            "unsupported stealth preset: {other}"
        ))),
    }
}

fn normalize_fingerprint_seed(raw: Option<&str>) -> Result<String, AppError> {
    let seed = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(random_fingerprint_seed);

    if seed.parse::<u32>().ok().is_some_and(|value| (10_000..=99_999).contains(&value)) {
        return Ok(seed);
    }

    Err(AppError::Validation(
        "fingerprint seed must be a number between 10000 and 99999".to_owned(),
    ))
}

fn bool_from_sql(value: i64) -> bool {
    value != 0
}

fn bool_to_sql(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

pub fn init_database(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let connection = Connection::open(db_path)?;

    // —— Milestone 1：强制 WAL，解决多开并发写导致的 "database is locked" ——
    // WAL 允许读写并行：多个环境并发上报时，读不阻塞写、写不阻塞读。
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(AppError::Database(format!(
            "failed to enable WAL journal mode, got: {journal_mode}"
        )));
    }
    // synchronous=NORMAL：WAL 下安全且大幅降低写放大；
    // busy_timeout：遇到瞬时写锁时等待重试，而非立刻报锁错误。
    connection.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;")?;

    connection.execute_batch(SCHEMA)?;
    migrate_schema(&connection)?;
    seed_default_settings(&connection)?;
    seed_demo_profiles(&connection)?;
    Ok(connection)
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, AppError> {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, AppError> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
    )?;
    let mut rows = statement.query(params![table])?;
    Ok(rows.next()?.is_some())
}

/// 旧版 DB 在 profiles 中存了 user_agent/timezone/locale/canvas/webgl 等字段（NOT NULL 无 DEFAULT），
/// 与当前 CloakBrowser 启动链冲突且导致 INSERT 失败。检测到 legacy 列时重建为标准 schema。
fn rebuild_legacy_profiles_table(connection: &Connection) -> Result<(), AppError> {
    if !table_exists(connection, "profiles")? {
        return Ok(());
    }
    if !column_exists(connection, "profiles", "user_agent")? {
        return Ok(());
    }

    connection.execute_batch(
        r#"
        CREATE TABLE profiles_canonical (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
            cdp_port INTEGER CHECK (cdp_port IS NULL OR cdp_port BETWEEN 1 AND 65535),
            status TEXT NOT NULL DEFAULT 'stopped',
            fraud_score INTEGER NOT NULL DEFAULT -1,
            fraud_details TEXT,
            theme_color TEXT NOT NULL DEFAULT '#6366f1',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            custom_proxy TEXT,
            use_geoip INTEGER NOT NULL DEFAULT 1,
            humanize INTEGER NOT NULL DEFAULT 1,
            fingerprint_seed TEXT NOT NULL DEFAULT '',
            stealth_preset TEXT NOT NULL DEFAULT 'default',
            interactive_element_extract_enabled INTEGER NOT NULL DEFAULT 1,
            webgl_mode TEXT NOT NULL DEFAULT 'local',
            browser_version TEXT NOT NULL DEFAULT ''
        );

        INSERT INTO profiles_canonical (
            id, name, proxy_id, cdp_port, status, fraud_score, fraud_details, theme_color, created_at,
            custom_proxy, use_geoip, humanize, fingerprint_seed, stealth_preset,
            interactive_element_extract_enabled, webgl_mode, browser_version
        )
        SELECT
            id, name, proxy_id, cdp_port, status, fraud_score, fraud_details, theme_color, created_at,
            custom_proxy, use_geoip, humanize, fingerprint_seed, stealth_preset,
            interactive_element_extract_enabled,
            COALESCE(webgl_mode, 'local'),
            COALESCE(browser_version, '')
        FROM profiles;

        DROP TABLE profiles;
        ALTER TABLE profiles_canonical RENAME TO profiles;

        CREATE INDEX IF NOT EXISTS idx_profiles_proxy_id ON profiles(proxy_id);
        CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
        "#,
    )?;

    log_info!(
        "TianshuTai: rebuilt legacy profiles table (removed user_agent/timezone/locale/canvas/webgl columns)"
    );
    Ok(())
}

fn migrate_schema(connection: &Connection) -> Result<(), AppError> {
    if table_exists(connection, "profiles")? {
        if !column_exists(connection, "profiles", "cdp_port")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN cdp_port INTEGER CHECK (cdp_port IS NULL OR cdp_port BETWEEN 1 AND 65535)",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "fraud_score")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN fraud_score INTEGER NOT NULL DEFAULT -1",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "fraud_details")? {
            connection.execute("ALTER TABLE profiles ADD COLUMN fraud_details TEXT", [])?;
        }
        if !column_exists(connection, "profiles", "created_at")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "theme_color")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN theme_color TEXT NOT NULL DEFAULT '#6366f1'",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "custom_proxy")? {
            connection.execute("ALTER TABLE profiles ADD COLUMN custom_proxy TEXT", [])?;
        }
        if !column_exists(connection, "profiles", "use_geoip")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN use_geoip INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "humanize")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN humanize INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "fingerprint_seed")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN fingerprint_seed TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "stealth_preset")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN stealth_preset TEXT NOT NULL DEFAULT 'default'",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "interactive_element_extract_enabled")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN interactive_element_extract_enabled INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
            if let Ok(Some(value)) = get_setting(connection, "interactive_element_extract_enabled") {
                if value.trim().eq_ignore_ascii_case("true") {
                    connection.execute(
                        "UPDATE profiles SET interactive_element_extract_enabled = 1",
                        [],
                    )?;
                }
            }
        }
        if !column_exists(connection, "profiles", "agent_panorama_enabled")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN agent_panorama_enabled INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "webgl_mode")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN webgl_mode TEXT NOT NULL DEFAULT 'local'",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "browser_version")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN browser_version TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        } else {
            connection.execute(
                "UPDATE profiles SET browser_version = '' WHERE browser_version IS NULL",
                [],
            )?;
        }
        // 清理历史脏数据（如误存「CloakBrowser」），避免启动时报 Invalid browser version pin
        sanitize_invalid_browser_versions(connection)?;
        rebuild_legacy_profiles_table(connection)?;
        // Milestone 3：人设列必须在 legacy rebuild 之后添加，避免重建表时被丢掉
        if !column_exists(connection, "profiles", "persona_data")? {
            connection.execute("ALTER TABLE profiles ADD COLUMN persona_data TEXT", [])?;
        }
        if !column_exists(connection, "profiles", "startup_urls")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN startup_urls TEXT NOT NULL DEFAULT '[]'",
                [],
            )?;
        }
        // P1.1：环境级邮箱 OTP 通道绑定（JSON；密钥走 secret_refs）
        if !column_exists(connection, "profiles", "otp_channel")? {
            connection.execute("ALTER TABLE profiles ADD COLUMN otp_channel TEXT", [])?;
        }
        // 宪法 §1.7：元素提取 / 全景截图默认恒开；存量环境一次性打开（幂等）
        connection.execute(
            "UPDATE profiles SET interactive_element_extract_enabled = 1 WHERE interactive_element_extract_enabled = 0",
            [],
        )?;
        connection.execute(
            "UPDATE profiles SET agent_panorama_enabled = 1 WHERE agent_panorama_enabled = 0 OR agent_panorama_enabled IS NULL",
            [],
        )?;
        backfill_profile_fingerprint_seeds(connection)?;
    }

    migrate_proxies_for_dynamic_api(connection)?;

    if !table_exists(connection, "form_templates")? {
        connection.execute_batch(
            "CREATE TABLE form_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                template_name TEXT NOT NULL,
                actions TEXT NOT NULL,
                auto_apply INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_form_templates_domain ON form_templates(domain);",
        )?;
    }

    if !table_exists(connection, "agent_trajectories")? {
        connection.execute_batch(
            "CREATE TABLE agent_trajectories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                title TEXT NOT NULL,
                goal TEXT NOT NULL DEFAULT '',
                start_url TEXT NOT NULL DEFAULT '',
                actions TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_agent_trajectories_domain ON agent_trajectories(domain);",
        )?;
    }

    // 同站控件 LRU 持久化：仅存脱敏 selector + 意图描述，禁止填表值/密码
    if !table_exists(connection, "agent_control_memory")? {
        connection.execute_batch(
            "CREATE TABLE agent_control_memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                intent TEXT NOT NULL,
                intent_key TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'click',
                selector TEXT NOT NULL DEFAULT '',
                text_hint TEXT NOT NULL DEFAULT '',
                x_percent REAL,
                y_percent REAL,
                hit_count INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(domain, intent_key)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_control_memory_domain
                ON agent_control_memory(domain);",
        )?;
    }

    // P1.1：命名密钥句柄（DPAPI/keyfile 信封）；otp_channel 只存 ref，不存明文
    if !table_exists(connection, "secret_refs")? {
        connection.execute_batch(
            "CREATE TABLE secret_refs (
                ref_id TEXT PRIMARY KEY,
                sealed_value TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'otp',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )?;
    }

    // P4.3：Agent Run History（与录制轨迹解耦；摘要不含 OTP/密钥明文）
    if !table_exists(connection, "agent_runs")? {
        connection.execute_batch(
            "CREATE TABLE agent_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL UNIQUE,
                profile_id TEXT NOT NULL DEFAULT '',
                goal TEXT NOT NULL DEFAULT '',
                start_url TEXT NOT NULL DEFAULT '',
                domain TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'running',
                success INTEGER,
                summary TEXT NOT NULL DEFAULT '',
                step_count INTEGER NOT NULL DEFAULT 0,
                hitl_occurred INTEGER NOT NULL DEFAULT 0,
                trajectory_id INTEGER,
                thought_summary TEXT NOT NULL DEFAULT '[]',
                started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                ended_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_runs_profile ON agent_runs(profile_id);
            CREATE INDEX IF NOT EXISTS idx_agent_runs_domain ON agent_runs(domain);",
        )?;
    }
    if table_exists(connection, "agent_runs")? {
        ensure_agent_run_metric_columns(connection)?;
    }

    if !table_exists(connection, "global_settings")? {
        connection.execute_batch(
            "CREATE TABLE global_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );",
        )?;
        if table_exists(connection, "settings")? {
            connection.execute(
                "INSERT OR IGNORE INTO global_settings (key, value) SELECT key, value FROM settings",
                [],
            )?;
        }
        seed_default_settings(connection)?;
    }

    if table_exists(connection, "proxies")? && !column_exists(connection, "proxies", "type")? {
        if column_exists(connection, "proxies", "protocol")? {
            connection.execute(
                "ALTER TABLE proxies ADD COLUMN \"type\" TEXT NOT NULL DEFAULT 'HTTP'",
                [],
            )?;
            connection.execute(
                "UPDATE proxies SET \"type\" = UPPER(CASE WHEN protocol = 'socks5' THEN 'SOCKS5' ELSE 'HTTP' END)",
                [],
            )?;
        }
    }

    // N12：回放台账（一次任务 + 每一轮执行）。Host 是唯一写入方（宪法 §0.4 / §5.4）。
    // 说明：这是**正确性关键**的写（领取/完成必须原子且不可丢），所以不经可降级的
    // `db_write_queue`（队列满会 Drop），而是与其它命令一样在 `database` 互斥锁内同步执行 ——
    // 那把锁本身就是单写边界。
    if !table_exists(connection, "replay_job")? {
        connection.execute_batch(
            "CREATE TABLE replay_job (
                job_id           TEXT PRIMARY KEY,
                title            TEXT NOT NULL,
                trajectory_id    INTEGER,
                env_ids          TEXT NOT NULL,
                repeat_count     INTEGER NOT NULL,
                total_runs       INTEGER NOT NULL,
                dataset_source   TEXT NOT NULL,
                dataset_ref      TEXT,
                dataset_size     INTEGER NOT NULL,
                dataset_hash     TEXT,
                alloc_mode       TEXT NOT NULL,
                run_seed         INTEGER NOT NULL,
                open_in_new_tab  INTEGER NOT NULL DEFAULT 1,
                plan_id          TEXT,
                plan_hash        TEXT,
                plan_json        TEXT,
                options_json     TEXT NOT NULL,
                status           TEXT NOT NULL,
                created_at       TEXT NOT NULL,
                finished_at      TEXT
            );",
        )?;
    }

    if !table_exists(connection, "replay_run")? {
        connection.execute_batch(
            "CREATE TABLE replay_run (
                job_id           TEXT NOT NULL,
                seq              INTEGER NOT NULL,
                env_id           TEXT NOT NULL,
                run_index        INTEGER NOT NULL,
                record_index     INTEGER,
                attempt          INTEGER NOT NULL DEFAULT 0,
                status           TEXT NOT NULL,
                lease_owner      TEXT,
                lease_token      INTEGER NOT NULL DEFAULT 0,
                lease_expires_at TEXT,
                unique_id        INTEGER,
                skipped          INTEGER NOT NULL DEFAULT 0,
                tab_mode         TEXT,
                tab_close_after  INTEGER,
                started_at       TEXT,
                finished_at      TEXT,
                result_json      TEXT,
                error            TEXT,
                PRIMARY KEY (job_id, seq)
            );
            CREATE INDEX IF NOT EXISTS idx_replay_run_pending ON replay_run(job_id, status, seq);
            CREATE INDEX IF NOT EXISTS idx_replay_run_env ON replay_run(job_id, env_id, seq);",
        )?;
    }

    Ok(())
}

fn backfill_profile_fingerprint_seeds(connection: &Connection) -> Result<(), AppError> {
    let mut statement =
        connection.prepare("SELECT id FROM profiles WHERE fingerprint_seed IS NULL OR fingerprint_seed = ''")?;
    let ids = statement
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for id in ids {
        connection.execute(
            "UPDATE profiles SET fingerprint_seed = ?1 WHERE id = ?2",
            params![random_fingerprint_seed(), id],
        )?;
    }
    Ok(())
}

fn migrate_proxies_for_dynamic_api(connection: &Connection) -> Result<(), AppError> {
    if !table_exists(connection, "proxies")? {
        return Ok(());
    }
    if column_exists(connection, "proxies", "api_config")? {
        return Ok(());
    }

    connection.execute_batch(
        "CREATE TABLE proxies_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            \"type\" TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL CHECK (port BETWEEN 0 AND 65535),
            username TEXT,
            password TEXT,
            api_config TEXT
        );
        INSERT INTO proxies_migrated (id, \"type\", host, port, username, password, api_config)
            SELECT id, \"type\", host, port, username, password, NULL FROM proxies;
        DROP TABLE proxies;
        ALTER TABLE proxies_migrated RENAME TO proxies;",
    )?;
    Ok(())
}

/// 演示环境仅在全新区库首次初始化时注入一次；此后用户删除即永久删除，不再复活。
/// 用 global_settings 里的标记位来区分「全新库」与「用户主动清空后的库」，
/// 避免 profiles 表一空就反复重灌演示环境（删了又自动出现）。
const DEMO_PROFILES_SEEDED_KEY: &str = "demo_profiles_seeded";

pub fn seed_demo_profiles(connection: &Connection) -> Result<(), AppError> {
    if get_setting(connection, DEMO_PROFILES_SEEDED_KEY)?.as_deref() == Some("1") {
        return Ok(());
    }

    let count: i64 = connection.query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))?;
    if count == 0 {
        connection.execute(
            "INSERT INTO proxies (\"type\", host, port, username, password) VALUES ('HTTP', '127.0.0.1', 7890, NULL, NULL)",
            [],
        )?;
        let proxy_id = connection.last_insert_rowid();

        let demo_profiles: [(&str, Option<i64>); 3] = [
            ("Checkout-US-01", Some(proxy_id)),
            ("Social-EU-02", Some(proxy_id)),
            ("Ads-APAC-03", None),
        ];

        for (name, proxy) in demo_profiles {
            connection.execute(
                "INSERT INTO profiles (name, proxy_id, status, fraud_score, browser_version) VALUES (?1, ?2, 'stopped', -1, '')",
                params![name, proxy],
            )?;
        }
    }

    // 无论本次是否注入，都落下「已处理」标记，保证后续用户删除不会被重灌。
    connection.execute(
        "INSERT INTO global_settings (key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![DEMO_PROFILES_SEEDED_KEY],
    )?;
    Ok(())
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        proxy_id: row.get(2)?,
        cdp_port: row.get(3)?,
        status: row.get(4)?,
        fraud_score: row.get(5)?,
        fraud_details: row.get(6)?,
        theme_color: row.get(7)?,
        created_at: row.get(8)?,
        custom_proxy: row.get(9)?,
        use_geoip: bool_from_sql(row.get(10)?),
        humanize: bool_from_sql(row.get(11)?),
        fingerprint_seed: row.get(12)?,
        stealth_preset: row.get(13)?,
        interactive_element_extract_enabled: bool_from_sql(row.get(14)?),
        webgl_mode: row.get(15)?,
        browser_version: row
            .get::<_, Option<String>>(16)?
            .unwrap_or_default(),
        persona_data: row.get::<_, Option<String>>(17).ok().flatten(),
        startup_urls: row
            .get::<_, Option<String>>(18)?
            .unwrap_or_else(|| "[]".to_owned()),
        agent_panorama_enabled: bool_from_sql(row.get::<_, i64>(19).unwrap_or(0)),
        otp_channel: row.get::<_, Option<String>>(20).ok().flatten(),
    })
}

pub fn list_profiles(connection: &Connection) -> Result<Vec<Profile>, AppError> {
    // 环境列表按 ID 升序：从上往下由小到大；补位/新建环境落在其 ID 对应位置。
    let sql = format!("SELECT {PROFILE_COLUMNS} FROM profiles ORDER BY id ASC");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], profile_from_row)?;

    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(row?);
    }
    Ok(profiles)
}

pub fn get_profile(connection: &Connection, id: i64) -> Result<Profile, AppError> {
    let sql = format!("SELECT {PROFILE_COLUMNS} FROM profiles WHERE id = ?1");
    connection
        .query_row(&sql, params![id], profile_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("profile {id}")))
}

fn proxy_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Proxy> {
    Ok(Proxy {
        id: row.get(0)?,
        proxy_type: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        password: reveal_stored_secret(row.get(5)?),
        api_config: reveal_stored_secret(row.get(6)?),
    })
}

/// 解密存储值；历史明文原样返回；密文不可恢复时降级为 None（视作「无凭据」）。
fn reveal_stored_secret(raw: Option<String>) -> Option<String> {
    let value = raw?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    crate::secret_store::reveal(trimmed)
}

/// 读取路径上的懒迁移：把仍是明文的旧行加密回写，避免一次性重写整表。
fn reencrypt_plaintext_proxy_secrets(connection: &Connection) -> Result<(), AppError> {
    // 作用域隔离：先收集待回写行并释放 statement，再执行 UPDATE（避免同时持有读游标与写连接）
    let pending: Vec<(i64, String, Option<String>)> = {
        let mut statement = connection.prepare("SELECT id, password, api_config FROM proxies")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;

        let mut pending = Vec::new();
        for row in rows {
            let (id, password, api_config) = row?;
            let sealed_password = crate::secret_store::protect_if_plaintext(password.as_deref());
            let sealed_config = crate::secret_store::protect_if_plaintext(api_config.as_deref());
            if sealed_password.is_none() && sealed_config.is_none() {
                continue;
            }
            pending.push((
                id,
                sealed_password.unwrap_or_else(|| password.unwrap_or_default()),
                sealed_config.or(api_config),
            ));
        }
        pending
    };

    for (id, password, api_config) in pending {
        connection.execute(
            "UPDATE proxies SET password = ?1, api_config = ?2 WHERE id = ?3",
            params![password, api_config, id],
        )?;
    }
    Ok(())
}

const PROXY_COLUMNS: &str = "id, \"type\", host, port, username, password, api_config";

pub fn get_proxy(connection: &Connection, id: i64) -> Result<Proxy, AppError> {
    reencrypt_plaintext_proxy_secrets(connection)?;
    fetch_proxy(connection, id)
}

/// 单行读取（不做懒迁移）。写路径必须走这里：批量插入时逐行迁移会造成 O(n²) 全表扫描。
fn fetch_proxy(connection: &Connection, id: i64) -> Result<Proxy, AppError> {
    let sql = format!("SELECT {PROXY_COLUMNS} FROM proxies WHERE id = ?1");
    connection
        .query_row(&sql, params![id], proxy_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("proxy {id}")))
}

fn occupied_cdp_ports(connection: &Connection) -> Result<HashSet<u16>, AppError> {
    let mut statement =
        connection.prepare("SELECT cdp_port FROM profiles WHERE cdp_port IS NOT NULL")?;
    let rows = statement.query_map([], |row| row.get::<_, i64>(0))?;

    let mut occupied = HashSet::new();
    for row in rows {
        let port = row?;
        if (CDP_PORT_START as i64..=CDP_PORT_END as i64).contains(&port) {
            occupied.insert(port as u16);
        }
    }
    Ok(occupied)
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn allocate_cdp_port(connection: &Connection) -> Result<u16, AppError> {
    let occupied = occupied_cdp_ports(connection)?;

    for port in CDP_PORT_START..=CDP_PORT_END {
        if !occupied.contains(&port) && is_port_available(port) {
            return Ok(port);
        }
    }

    Err(AppError::CdpPortsExhausted {
        start: CDP_PORT_START,
        end: CDP_PORT_END,
    })
}

/// 分配 CDP 端口并立刻写入 SQLite，防止并发 `start_profile` 在 `set_profile_running`
/// 之前互相抢到同一端口（会导致连错浏览器 / 代理表现交叉污染）。
pub fn allocate_and_reserve_cdp_port(
    connection: &Connection,
    profile_id: i64,
) -> Result<u16, AppError> {
    let port = allocate_cdp_port(connection)?;
    let affected = connection.execute(
        "UPDATE profiles SET cdp_port = ?1 WHERE id = ?2",
        params![port as i64, profile_id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {profile_id}")));
    }
    Ok(port)
}

/// 启动失败时释放尚未标记为 running 的端口预留。
pub fn release_cdp_port_reservation(
    connection: &Connection,
    profile_id: i64,
) -> Result<(), AppError> {
    connection.execute(
        "UPDATE profiles SET cdp_port = NULL WHERE id = ?1 AND status != 'running'",
        params![profile_id],
    )?;
    Ok(())
}

pub fn set_profile_running(
    connection: &Connection,
    id: i64,
    cdp_port: u16,
) -> Result<Profile, AppError> {
    let affected = connection.execute(
        "UPDATE profiles SET cdp_port = ?1, status = 'running' WHERE id = ?2",
        params![cdp_port as i64, id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

pub fn set_profile_stopped(connection: &Connection, id: i64) -> Result<Profile, AppError> {
    let affected = connection.execute(
        "UPDATE profiles SET status = 'stopped', cdp_port = NULL WHERE id = ?1",
        params![id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

/// 应用重启后 DashMap 为空，SQLite 中残留的 running 状态与实际进程不一致，需重置。
/// 同时清理「启动中崩溃」留下的 cdp_port 预留（status 仍为 stopped）。
pub fn reset_stale_running_profiles(connection: &Connection) -> Result<u64, AppError> {
    let affected_running = connection.execute(
        "UPDATE profiles SET status = 'stopped', cdp_port = NULL WHERE status = 'running'",
        [],
    )?;
    let affected_orphan = connection.execute(
        "UPDATE profiles SET cdp_port = NULL WHERE status != 'running' AND cdp_port IS NOT NULL",
        [],
    )?;
    Ok(affected_running as u64 + affected_orphan as u64)
}

pub fn list_proxies(connection: &Connection) -> Result<Vec<Proxy>, AppError> {
    reencrypt_plaintext_proxy_secrets(connection)?;
    let sql = format!("SELECT {PROXY_COLUMNS} FROM proxies ORDER BY id DESC");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], proxy_from_row)?;
    let mut proxies = Vec::new();
    for row in rows {
        proxies.push(row?);
    }
    Ok(proxies)
}

pub fn insert_proxy(
    connection: &Connection,
    proxy_type: &str,
    host: &str,
    port: i64,
    username: Option<&str>,
    password: Option<&str>,
    api_config: Option<&str>,
) -> Result<Proxy, AppError> {
    let normalized = proxy::normalize_proxy_type(proxy_type);
    // 落库前加密敏感列：password（静态代理账密）与 api_config（动态 API 端点常内嵌 token）
    let sealed_password = crate::secret_store::protect(password.unwrap_or_default())?;
    let sealed_config = match api_config {
        Some(config) => crate::secret_store::protect(config)?,
        None => None,
    };
    if normalized == "DYNAMIC_API" {
        let config = api_config.ok_or_else(|| {
            AppError::Validation("dynamic API proxy requires api_config".to_owned())
        })?;
        parse_dynamic_api_config(config)?;
        connection.execute(
            "INSERT INTO proxies (\"type\", host, port, username, password, api_config) VALUES ('DYNAMIC_API', 'api', 1, NULL, NULL, ?1)",
            params![sealed_config.as_deref()],
        )?;
        return fetch_proxy(connection, connection.last_insert_rowid());
    }

    if host.trim().is_empty() {
        return Err(AppError::Validation("proxy host cannot be empty".to_owned()));
    }
    if !(1..=65535).contains(&port) {
        return Err(AppError::Validation("proxy port out of range".to_owned()));
    }

    connection.execute(
        "INSERT INTO proxies (\"type\", host, port, username, password, api_config) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            normalized,
            host.trim(),
            port,
            username,
            sealed_password.as_deref(),
            sealed_config.as_deref()
        ],
    )?;
    fetch_proxy(connection, connection.last_insert_rowid())
}

pub fn insert_dynamic_api_proxy(
    connection: &Connection,
    api_url: &str,
    protocol: &str,
    region: &str,
    label: Option<&str>,
) -> Result<Proxy, AppError> {
    let api_url = apply_region_to_api_url(api_url, region);
    let config = serde_json::json!({
        "api_url": api_url,
        "protocol": proxy::normalize_proxy_type(protocol),
        "region": region.trim().to_ascii_lowercase(),
        "label": label.unwrap_or("API 动态提取"),
    });
    let config_text = serde_json::to_string(&config)
        .map_err(|error| AppError::Validation(error.to_string()))?;
    insert_proxy(
        connection,
        "DYNAMIC_API",
        "api",
        1,
        None,
        None,
        Some(&config_text),
    )
}

fn normalize_profile_proxy_fields(
    proxy_id: Option<i64>,
    custom_proxy: Option<&str>,
    connection: &Connection,
) -> Result<(Option<i64>, Option<String>), AppError> {
    let custom = custom_proxy.map(str::trim).filter(|value| !value.is_empty());
    if let Some(raw) = custom {
        let resolved = parse_custom_proxy_json(raw)?;
        let stored = resolved.to_custom_json()?;
        if let Some(id) = proxy_id {
            get_proxy(connection, id)?;
        }
        return Ok((None, Some(stored)));
    }

    if let Some(id) = proxy_id {
        get_proxy(connection, id)?;
        return Ok((Some(id), None));
    }

    Ok((None, None))
}

/// CloakBrowser VERSION_PIN_RE: /^[0-9]+(?:\.[0-9]+){3,4}$/
pub(crate) fn is_valid_browser_version_pin(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if !(4..=5).contains(&parts.len()) {
        return false;
    }
    parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn sanitize_invalid_browser_versions(connection: &Connection) -> Result<(), AppError> {
    if !column_exists(connection, "profiles", "browser_version")? {
        return Ok(());
    }
    let mut statement = connection.prepare("SELECT id, browser_version FROM profiles")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut invalid_ids: Vec<i64> = Vec::new();
    for row in rows {
        let (id, version) = row?;
        let trimmed = version.trim();
        if !trimmed.is_empty() && !is_valid_browser_version_pin(trimmed) {
            invalid_ids.push(id);
        }
    }
    for id in invalid_ids {
        connection.execute(
            "UPDATE profiles SET browser_version = '' WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

fn normalize_browser_version(raw: Option<&str>) -> Result<String, AppError> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.len() > 32 {
        return Err(AppError::Validation(
            "browser_version must be at most 32 characters".to_owned(),
        ));
    }
    if !is_valid_browser_version_pin(trimmed) {
        return Err(AppError::Validation(
            "browser_version must be a full Chromium pin (4~5 numeric segments), e.g. 146.0.7680.177.5"
                .to_owned(),
        ));
    }
    Ok(trimmed.to_owned())
}

/// 规范化额外启动网址 JSON：过滤空项、补 https、去重、上限 20；不含强制首位 BrowserScan。
pub fn normalize_startup_urls_json(raw: Option<&str>) -> Result<String, AppError> {
    const MAX: usize = 20;
    let text = raw.map(str::trim).filter(|v| !v.is_empty()).unwrap_or("[]");
    let parsed: serde_json::Value = serde_json::from_str(text).map_err(|_| {
        AppError::Validation("startup_urls must be a JSON array of URLs".to_owned())
    })?;
    let Some(items) = parsed.as_array() else {
        return Err(AppError::Validation(
            "startup_urls must be a JSON array of URLs".to_owned(),
        ));
    };

    let forced = "https://www.browserscan.net/zh";
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    seen.insert(forced.to_ascii_lowercase());

    for item in items {
        let candidate = match item {
            serde_json::Value::String(s) => s.trim().to_owned(),
            other => other.to_string().trim_matches('"').trim().to_owned(),
        };
        if candidate.is_empty() {
            continue;
        }
        let normalized = normalize_startup_url_item(&candidate)?;
        let key = normalized.to_ascii_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(normalized);
        if out.len() >= MAX {
            break;
        }
    }

    serde_json::to_string(&out).map_err(|error| {
        AppError::Validation(format!("failed to serialize startup_urls: {error}"))
    })
}

fn normalize_startup_url_item(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("startup url cannot be empty".to_owned()));
    }
    if trimmed.len() > 2048 {
        return Err(AppError::Validation(
            "startup url is too long (max 2048)".to_owned(),
        ));
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(AppError::Validation(format!(
            "invalid startup url (contains whitespace): {trimmed}"
        )));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let lower = with_scheme.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(AppError::Validation(
            "startup url must be http or https".to_owned(),
        ));
    }
    // 粗校验：scheme 后至少有主机字符
    let rest = with_scheme
        .split_once("://")
        .map(|(_, host)| host)
        .unwrap_or("");
    if rest.is_empty() || rest.starts_with('/') {
        return Err(AppError::Validation(format!(
            "invalid startup url: {trimmed}"
        )));
    }
    Ok(with_scheme)
}

/// 找出最小可用 profile id：只填补「占用区间内部」被删除留下的空洞。
/// 以当前最小 id 为起点，绝不回填到更早的空位（否则删过 1、2 号后会一直复用 1，
/// 用户期望的是「删除 4 号 → 下一个补回 4 号」）。区间内无空洞时返回 max+1；空表返回 1。
/// 显式指定 id 插入不会触碰 sqlite_sequence 的高水位，删除后可复用空闲 id。
fn next_available_profile_id(connection: &Connection) -> Result<i64, AppError> {
    let mut stmt = connection.prepare("SELECT id FROM profiles ORDER BY id ASC")?;
    let mut rows = stmt.query([])?;
    let mut expected: i64 = 0;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        if id < 1 {
            continue;
        }
        if expected == 0 {
            expected = id;
        }
        if id > expected {
            break;
        }
        expected = id + 1;
    }
    Ok(if expected == 0 { 1 } else { expected })
}

pub fn create_profile(
    connection: &Connection,
    name: &str,
    theme_color: &str,
    proxy_id: Option<i64>,
    custom_proxy: Option<&str>,
    use_geoip: bool,
    humanize: bool,
    fingerprint_seed: Option<&str>,
    stealth_preset: &str,
    webgl_mode: &str,
    browser_version: Option<&str>,
    startup_urls: Option<&str>,
) -> Result<Profile, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("profile name cannot be empty".to_owned()));
    }

    let (proxy_id, custom_proxy) =
        normalize_profile_proxy_fields(proxy_id, custom_proxy, connection)?;
    let fingerprint_seed = normalize_fingerprint_seed(fingerprint_seed)?;
    let stealth_preset = normalize_stealth_preset(stealth_preset)?;
    let webgl_mode = normalize_webgl_mode(webgl_mode)?;
    let browser_version = normalize_browser_version(browser_version)?;
    let startup_urls = normalize_startup_urls_json(startup_urls)?;

    let id = next_available_profile_id(connection)?;
    connection.execute(
        "INSERT INTO profiles (id, name, proxy_id, custom_proxy, theme_color, status, fraud_score, use_geoip, humanize, fingerprint_seed, stealth_preset, webgl_mode, browser_version, startup_urls, interactive_element_extract_enabled, agent_panorama_enabled)
         VALUES (?1, ?2, ?3, ?4, ?5, 'stopped', -1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, 1)",
        params![
            id,
            trimmed,
            proxy_id,
            custom_proxy,
            theme_color,
            bool_to_sql(use_geoip),
            bool_to_sql(humanize),
            fingerprint_seed,
            stealth_preset,
            webgl_mode,
            browser_version,
            startup_urls,
        ],
    )?;
    get_profile(connection, id)
}

pub fn batch_create_profiles(
    connection: &Connection,
    input: &BatchCreateProfilesInput,
) -> Result<Vec<Profile>, AppError> {
    let trimmed_prefix = input.prefix.trim();
    if trimmed_prefix.is_empty() {
        return Err(AppError::Validation("batch prefix cannot be empty".to_owned()));
    }
    if input.count == 0 || input.count > 100 {
        return Err(AppError::Validation("batch count must be between 1 and 100".to_owned()));
    }

    let strategy = input
        .proxy_strategy
        .as_deref()
        .unwrap_or_else(|| {
            if input.proxy_id.is_some() {
                "pool_shared"
            } else {
                "none"
            }
        });

    let theme_color = input.theme_color.as_deref().unwrap_or("#6366f1");
    let webgl_mode = normalize_webgl_mode(&input.webgl_mode)?;
    let stealth_preset = normalize_stealth_preset(&input.stealth_preset)?;
    let startup_urls = normalize_startup_urls_json(input.startup_urls.as_deref())?;
    let browser_version = normalize_browser_version(input.browser_version.as_deref())?;
    let pool_proxies = list_proxies(connection)?;
    let mut rng = rand::rng();

    let mut created = Vec::with_capacity(input.count as usize);
    for index in 1..=input.count {
        let name = format!("{trimmed_prefix}-{index:02}");
        let (proxy_id, custom_proxy) = match strategy {
            "none" => (None, None),
            "pool_shared" => {
                let proxy_id = input.proxy_id.ok_or_else(|| {
                    AppError::Validation("pool_shared strategy requires proxy_id".to_owned())
                })?;
                get_proxy(connection, proxy_id)?;
                (Some(proxy_id), None)
            }
            "pool_random" => {
                let mut static_proxies: Vec<Proxy> = pool_proxies
                    .iter()
                    .filter(|proxy| proxy.proxy_type.to_ascii_uppercase() != "DYNAMIC_API")
                    .cloned()
                    .collect();
                if let Some(proxy_id) = input.proxy_id {
                    static_proxies.retain(|proxy| proxy.id == proxy_id);
                }
                if static_proxies.is_empty() {
                    return Err(AppError::Validation(
                        "proxy pool has no static proxies for random assignment".to_owned(),
                    ));
                }
                let picked = &static_proxies[rng.random_range(0..static_proxies.len())];
                (Some(picked.id), None)
            }
            "sequential_ports" => {
                let host = input
                    .sequential_host
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("127.0.0.1");
                let start_port = input.sequential_start_port.unwrap_or(5500);
                let port = start_port.saturating_add(index - 1);
                if port > 65535 {
                    return Err(AppError::Validation(
                        "sequential port overflow beyond 65535".to_owned(),
                    ));
                }
                let proxy_type = input
                    .sequential_proxy_type
                    .as_deref()
                    .unwrap_or("HTTP");
                let resolved = proxy::ResolvedProxy {
                    scheme: proxy::normalize_scheme(proxy_type),
                    host: host.to_owned(),
                    port: port as u16,
                    username: None,
                    password: None,
                };
                (None, Some(resolved.to_custom_json()?))
            }
            other => {
                return Err(AppError::Validation(format!(
                    "unsupported proxy strategy: {other}"
                )));
            }
        };

        let id = next_available_profile_id(connection)?;
        connection.execute(
            "INSERT INTO profiles (id, name, proxy_id, custom_proxy, theme_color, status, fraud_score, use_geoip, humanize, fingerprint_seed, stealth_preset, webgl_mode, browser_version, startup_urls)
             VALUES (?1, ?2, ?3, ?4, ?5, 'stopped', -1, 1, 1, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                name,
                proxy_id,
                custom_proxy,
                theme_color,
                random_fingerprint_seed(),
                stealth_preset,
                webgl_mode,
                browser_version,
                startup_urls,
            ],
        )?;
        created.push(get_profile(connection, id)?);
    }

    Ok(created)
}

pub fn update_profile(
    connection: &Connection,
    id: i64,
    name: &str,
    theme_color: &str,
    proxy_id: Option<i64>,
    custom_proxy: Option<&str>,
    use_geoip: bool,
    humanize: bool,
    fingerprint_seed: Option<&str>,
    stealth_preset: &str,
    webgl_mode: &str,
    browser_version: Option<&str>,
    startup_urls: Option<&str>,
) -> Result<Profile, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("profile name cannot be empty".to_owned()));
    }

    let existing = get_profile(connection, id)?;
    let (proxy_id, custom_proxy) =
        normalize_profile_proxy_fields(proxy_id, custom_proxy, connection)?;
    let fingerprint_seed = normalize_fingerprint_seed(
        fingerprint_seed.or(Some(existing.fingerprint_seed.as_str())),
    )?;
    let stealth_preset = normalize_stealth_preset(stealth_preset)?;
    let webgl_mode = normalize_webgl_mode(webgl_mode)?;
    let browser_version = normalize_browser_version(
        browser_version.or(Some(existing.browser_version.as_str())),
    )?;
    let startup_urls = normalize_startup_urls_json(
        startup_urls.or(Some(existing.startup_urls.as_str())),
    )?;

    let affected = connection.execute(
        "UPDATE profiles SET name = ?1, theme_color = ?2, proxy_id = ?3, custom_proxy = ?4,
         use_geoip = ?5, humanize = ?6, fingerprint_seed = ?7, stealth_preset = ?8, webgl_mode = ?9,
         browser_version = ?10, startup_urls = ?11 WHERE id = ?12",
        params![
            trimmed,
            theme_color,
            proxy_id,
            custom_proxy,
            bool_to_sql(use_geoip),
            bool_to_sql(humanize),
            fingerprint_seed,
            stealth_preset,
            webgl_mode,
            browser_version,
            startup_urls,
            id,
        ],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

pub fn set_profile_interactive_extract(
    connection: &Connection,
    id: i64,
    enabled: bool,
) -> Result<Profile, AppError> {
    let affected = connection.execute(
        "UPDATE profiles SET interactive_element_extract_enabled = ?1 WHERE id = ?2",
        params![bool_to_sql(enabled), id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

pub fn set_profile_agent_panorama(
    connection: &Connection,
    id: i64,
    enabled: bool,
) -> Result<Profile, AppError> {
    let affected = connection.execute(
        "UPDATE profiles SET agent_panorama_enabled = ?1 WHERE id = ?2",
        params![bool_to_sql(enabled), id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

pub fn delete_profile(connection: &Connection, id: i64) -> Result<(), AppError> {
    let profile = get_profile(connection, id)?;
    if profile.status == "running" {
        return Err(AppError::Validation(
            "cannot delete a running profile; stop it first".to_owned(),
        ));
    }
    let affected = connection.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    Ok(())
}

const ALLOWED_SETTING_KEYS: &[&str] = &[
    "deepseek_api_key",
    "zhipu_api_key",
    "custom_api_key",
    "ai_provider",
    "deepseek_base_url",
    "deepseek_chat_model",
    "zhipu_chat_model",
    "custom_chat_model",
    "ai_extra_models",
    "ai_task_models",
    "cloak_path",
    "cloak_license_key",
    "key_file_path",
    "kernel_paths",
    "browser_download_dir",
    "scraper_download_dir",
    "license_through_proxy",
    "allow_third_party_cookies",
    "fingerprint_off",
    "agent_sense_mode",
    "default_browser_version",
    "otp_channel",
    "captcha_service",
    "sms_otp_service",
    // 「规则」库：用户自定义规则 + 人设 + 每环境勾选
    "agent_rules",
    "agent_personas",
    "agent_rule_selection",
    "agent_persona_selection",
];

pub fn seed_default_settings(connection: &Connection) -> Result<(), AppError> {
    let defaults = [
        ("deepseek_api_key", ""),
        ("zhipu_api_key", ""),
        ("custom_api_key", ""),
        ("ai_provider", "deepseek"),
        ("deepseek_base_url", "https://api.deepseek.com"),
        // 模型 ID 不预置：服务商迭代太快，写死必然过期。空值时侧车会明确要求先去
        // 「设置 → AI 设置 → 模型库」添加模型，而不是拿着过期 ID 发请求。
        ("deepseek_chat_model", ""),
        ("zhipu_chat_model", ""),
        ("custom_chat_model", ""),
        ("ai_extra_models", "[]"),
        ("ai_task_models", "{}"),
        ("cloak_path", ""),
        ("cloak_license_key", ""),
        ("key_file_path", ""),
        ("kernel_paths", "{}"),
        ("browser_download_dir", ""),
        ("scraper_download_dir", ""),
        ("license_through_proxy", "false"),
        ("allow_third_party_cookies", "false"),
        ("fingerprint_off", "false"),
        ("agent_sense_mode", "balanced"),
        ("default_browser_version", ""),
        ("otp_channel", ""),
        ("captcha_service", ""),
        ("sms_otp_service", ""),
        ("agent_rules", "[]"),
        ("agent_personas", "[]"),
        ("agent_rule_selection", "{}"),
        ("agent_persona_selection", "{}"),
    ];
    for (key, value) in defaults {
        connection.execute(
            "INSERT OR IGNORE INTO global_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    Ok(())
}

pub fn list_settings(connection: &Connection) -> Result<std::collections::HashMap<String, String>, AppError> {
    let mut statement =
        connection.prepare("SELECT key, value FROM global_settings ORDER BY key ASC")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (key, value) = row?;
        map.insert(key, value);
    }
    Ok(map)
}

pub fn get_setting(connection: &Connection, key: &str) -> Result<Option<String>, AppError> {
    let mut statement = connection.prepare("SELECT value FROM global_settings WHERE key = ?1")?;
    let value = statement
        .query_row(params![key], |row| row.get::<_, String>(0))
        .optional()?;
    Ok(value)
}

/// 读取布尔语义的全局设置（存储为 "true"/"1" 视为开启，其余视为关闭）。
pub fn get_bool_setting(connection: &Connection, key: &str) -> Result<bool, AppError> {
    let value = get_setting(connection, key)?;
    Ok(value
        .map(|raw| {
            let trimmed = raw.trim();
            trimmed == "true" || trimmed == "1" || trimmed.eq_ignore_ascii_case("on")
        })
        .unwrap_or(false))
}

pub fn set_setting(connection: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    if !ALLOWED_SETTING_KEYS.contains(&key) {
        return Err(AppError::Validation(format!("unsupported setting key: {key}")));
    }
    let stored = if key == "otp_channel" {
        normalize_otp_channel_json(value)?
    } else if key == "captcha_service" {
        normalize_captcha_service_json(value)?
    } else if key == "sms_otp_service" {
        normalize_sms_otp_service_json(value)?
    } else {
        value.to_owned()
    };
    connection.execute(
        "INSERT INTO global_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, stored],
    )?;
    Ok(())
}

/**
 * 从「规则」库解析本环境启用的人设（供回放 `{{persona.*}}` 使用）。
 *
 * 口径（宪法 §1.4 / §3.4 更新后）：
 *   - 环境人设（profiles.persona_data）已下线，用户人设统一存在 global_settings.agent_personas；
 *   - agent_persona_selection 记录每个环境启用了哪条人设（字段级固定只影响自动填表）；
 *   - 回放占位符用**整套字段**，不受「固定字段」勾选限制。
 *
 * 返回 None = 本环境未指定人设，回放时保持占位符原样。
 */
pub fn resolve_agent_persona_for_profile(
    connection: &Connection,
    profile_id: &str,
) -> Result<Option<serde_json::Value>, AppError> {
    let key = profile_id.trim();
    if key.is_empty() {
        return Ok(None);
    }
    let Some(selection_raw) = get_setting(connection, "agent_persona_selection")? else {
        return Ok(None);
    };
    let selection = match serde_json::from_str::<serde_json::Value>(&selection_raw) {
        Ok(value) => value,
        Err(error) => {
            // 不静默：人设选择损坏时如无痕降级，用户会以为「已配好却没生效」。
            log_warn!("agent_persona_selection 解析失败，按未指定人设处理：{error}");
            return Ok(None);
        }
    };
    let Some(persona_id) = selection
        .get(key)
        .and_then(|entry| entry.get("personaId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let Some(personas_raw) = get_setting(connection, "agent_personas")? else {
        return Ok(None);
    };
    let personas = match serde_json::from_str::<serde_json::Value>(&personas_raw) {
        Ok(value) => value,
        Err(error) => {
            log_warn!("agent_personas 解析失败，按未指定人设处理：{error}");
            return Ok(None);
        }
    };
    let Some(persona) = personas
        .as_array()
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.get("id")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    == Some(persona_id)
            })
        })
    else {
        return Ok(None);
    };

    let text_of = |field: &str| -> Option<String> {
        persona
            .get(field)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let full_name = text_of("fullName");
    let mut out = serde_json::Map::new();
    if let Some(name) = full_name.clone() {
        // {{persona.name}} 与 {{persona.fullName}} 两个别名都保留
        out.insert("name".to_owned(), serde_json::Value::String(name.clone()));
        out.insert("fullName".to_owned(), serde_json::Value::String(name));
    }
    for (field, target) in [
        ("gender", "gender"),
        ("birthday", "birthday"),
        ("email", "email"),
        ("phone", "phone"),
        ("postalCode", "postalCode"),
        ("street", "street"),
        ("city", "city"),
        ("region", "region"),
        ("country", "country"),
    ] {
        if let Some(value) = text_of(field) {
            out.insert(target.to_owned(), serde_json::Value::String(value));
        }
    }
    if out.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::Value::Object(out)))
}

pub fn batch_add_proxies(
    connection: &Connection,
    proxies: &[crate::models::AddProxyInput],
) -> Result<usize, AppError> {
    if proxies.is_empty() {
        return Err(AppError::Validation("proxy batch cannot be empty".to_owned()));
    }

    let transaction = connection.unchecked_transaction()?;
    let mut inserted = 0usize;
    for proxy in proxies {
        insert_proxy(
            &transaction,
            &proxy.proxy_type,
            &proxy.host,
            proxy.port,
            proxy.username.as_deref(),
            proxy.password.as_deref(),
            proxy.api_config.as_deref(),
        )?;
        inserted += 1;
    }
    transaction.commit()?;
    Ok(inserted)
}

pub fn batch_delete_proxies(connection: &Connection, ids: &[i64]) -> Result<usize, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation(
            "proxy batch delete requires at least one id".to_owned(),
        ));
    }

    let transaction = connection.unchecked_transaction()?;
    let mut deleted = 0usize;
    for id in ids {
        let affected = transaction.execute("DELETE FROM proxies WHERE id = ?1", params![id])?;
        deleted += affected;
    }
    transaction.commit()?;
    Ok(deleted)
}

pub fn save_form_template(
    connection: &Connection,
    domain: &str,
    template_name: &str,
    actions: &str,
    auto_apply: bool,
) -> Result<i64, AppError> {
    let domain = domain.trim();
    let template_name = template_name.trim();
    if domain.is_empty() {
        return Err(AppError::Validation("template domain cannot be empty".to_owned()));
    }
    if template_name.is_empty() {
        return Err(AppError::Validation("template name cannot be empty".to_owned()));
    }
    if actions.trim().is_empty() {
        return Err(AppError::Validation("template actions cannot be empty".to_owned()));
    }

    connection.execute(
        "INSERT INTO form_templates (domain, template_name, actions, auto_apply)
         VALUES (?1, ?2, ?3, ?4)",
        params![domain, template_name, actions, auto_apply as i64],
    )?;
    Ok(connection.last_insert_rowid())
}

pub fn get_form_templates_by_domain(
    connection: &Connection,
    domain: &str,
) -> Result<Vec<crate::models::FormTemplate>, AppError> {
    let domain = domain.trim();
    let mut statement = connection.prepare(
        "SELECT id, domain, template_name, actions, auto_apply, created_at
         FROM form_templates
         WHERE domain = ?1 OR domain LIKE '%' || ?1
         ORDER BY auto_apply DESC, created_at DESC",
    )?;
    let rows = statement
        .query_map(params![domain], |row| {
            Ok(crate::models::FormTemplate {
                id: row.get(0)?,
                domain: row.get(1)?,
                template_name: row.get(2)?,
                actions: row.get(3)?,
                auto_apply: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_all_form_templates(
    connection: &Connection,
) -> Result<Vec<crate::models::FormTemplate>, AppError> {
    let mut statement = connection.prepare(
        "SELECT id, domain, template_name, actions, auto_apply, created_at
         FROM form_templates
         ORDER BY created_at DESC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(crate::models::FormTemplate {
                id: row.get(0)?,
                domain: row.get(1)?,
                template_name: row.get(2)?,
                actions: row.get(3)?,
                auto_apply: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_form_template(connection: &Connection, id: i64) -> Result<(), AppError> {
    let affected = connection.execute("DELETE FROM form_templates WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("form template {id} not found")));
    }
    Ok(())
}

pub fn toggle_form_template_auto_apply(
    connection: &Connection,
    id: i64,
    auto_apply: bool,
) -> Result<(), AppError> {
    let affected = connection.execute(
        "UPDATE form_templates SET auto_apply = ?1 WHERE id = ?2",
        params![auto_apply as i64, id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("form template {id} not found")));
    }
    Ok(())
}

pub fn save_agent_trajectory(
    connection: &Connection,
    domain: &str,
    title: &str,
    goal: &str,
    start_url: &str,
    actions: &str,
) -> Result<i64, AppError> {
    let domain = domain.trim();
    let title = title.trim();
    if domain.is_empty() {
        return Err(AppError::Validation("trajectory domain cannot be empty".to_owned()));
    }
    if title.is_empty() {
        return Err(AppError::Validation("trajectory title cannot be empty".to_owned()));
    }
    if actions.trim().is_empty() {
        return Err(AppError::Validation("trajectory actions cannot be empty".to_owned()));
    }

    connection.execute(
        "INSERT INTO agent_trajectories (domain, title, goal, start_url, actions)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![domain, title, goal, start_url.trim(), actions],
    )?;
    Ok(connection.last_insert_rowid())
}

/// 按 id 取单条轨迹（回放预检单需要 actions 做 critical 扫描；找不到即 NotFound）
pub fn get_agent_trajectory(
    connection: &Connection,
    id: i64,
) -> Result<crate::models::AgentTrajectory, AppError> {
    let mut statement = connection.prepare(
        "SELECT id, domain, title, goal, start_url, actions, created_at
           FROM agent_trajectories WHERE id = ?1",
    )?;
    let mut rows = statement.query_map(params![id], |row| {
        Ok(crate::models::AgentTrajectory {
            id: row.get(0)?,
            domain: row.get(1)?,
            title: row.get(2)?,
            goal: row.get(3)?,
            start_url: row.get(4)?,
            actions: row.get(5)?,
            created_at: row.get(6)?,
            file_path: None,
            file_name: None,
            step_count: None,
            source: Some("db".to_owned()),
        })
    })?;
    match rows.next() {
        Some(row) => Ok(row?),
        None => Err(AppError::NotFound(format!("agent trajectory {id} not found"))),
    }
}

pub fn list_agent_trajectories(
    connection: &Connection,    domain: &str,
) -> Result<Vec<crate::models::AgentTrajectory>, AppError> {
    let domain = domain.trim();
    if domain.is_empty() {
        let mut statement = connection.prepare(
            "SELECT id, domain, title, goal, start_url, actions, created_at
             FROM agent_trajectories
             ORDER BY created_at DESC",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(crate::models::AgentTrajectory {
                    id: row.get(0)?,
                    domain: row.get(1)?,
                    title: row.get(2)?,
                    goal: row.get(3)?,
                    start_url: row.get(4)?,
                    actions: row.get(5)?,
                    created_at: row.get(6)?,
                    file_path: None,
                    file_name: None,
                    step_count: None,
                    source: Some("db".to_owned()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(rows);
    }

    let mut statement = connection.prepare(
        "SELECT id, domain, title, goal, start_url, actions, created_at
         FROM agent_trajectories
         WHERE domain = ?1 OR domain LIKE '%' || ?1 OR ?1 LIKE '%' || domain
         ORDER BY created_at DESC",
    )?;
    let rows = statement
        .query_map(params![domain], |row| {
            Ok(crate::models::AgentTrajectory {
                id: row.get(0)?,
                domain: row.get(1)?,
                title: row.get(2)?,
                goal: row.get(3)?,
                start_url: row.get(4)?,
                actions: row.get(5)?,
                created_at: row.get(6)?,
                file_path: None,
                file_name: None,
                step_count: None,
                source: Some("db".to_owned()),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_agent_trajectory(connection: &Connection, id: i64) -> Result<(), AppError> {
    let affected = connection.execute("DELETE FROM agent_trajectories WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("agent trajectory {id} not found")));
    }
    Ok(())
}

/// P4.3：Agent 起止落库（run_id 幂等 upsert）
const AGENT_RUN_COLUMNS: &str = "id, run_id, profile_id, goal, start_url, domain, status, success, \
summary, step_count, hitl_occurred, trajectory_id, thought_summary, \
started_at, ended_at, created_at, \
prompt_tokens, completion_tokens, total_tokens, estimated_cost_micro_usd, \
llm_calls, llm_model, cost_used_default_rate, failure_class, failure_counts";

fn ensure_agent_run_metric_columns(connection: &Connection) -> Result<(), AppError> {
    const COLUMNS: &[(&str, &str)] = &[
        ("prompt_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("completion_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("total_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("estimated_cost_micro_usd", "INTEGER NOT NULL DEFAULT 0"),
        ("llm_calls", "INTEGER NOT NULL DEFAULT 0"),
        ("llm_model", "TEXT NOT NULL DEFAULT ''"),
        ("cost_used_default_rate", "INTEGER NOT NULL DEFAULT 0"),
        ("failure_class", "TEXT NOT NULL DEFAULT ''"),
        ("failure_counts", "TEXT NOT NULL DEFAULT '{}'"),
    ];
    for (name, ddl) in COLUMNS {
        if !column_exists(connection, "agent_runs", name)? {
            connection.execute(
                &format!("ALTER TABLE agent_runs ADD COLUMN {name} {ddl}"),
                [],
            )?;
        }
    }
    Ok(())
}

pub fn upsert_agent_run_start(
    connection: &Connection,
    run_id: &str,
    profile_id: &str,
    goal: &str,
    start_url: &str,
    domain: &str,
) -> Result<i64, AppError> {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return Err(AppError::Validation("agent run_id cannot be empty".to_owned()));
    }
    connection.execute(
        "INSERT INTO agent_runs (run_id, profile_id, goal, start_url, domain, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'running')
         ON CONFLICT(run_id) DO UPDATE SET
           profile_id = excluded.profile_id,
           goal = excluded.goal,
           start_url = excluded.start_url,
           domain = excluded.domain,
           status = CASE
             WHEN agent_runs.status = 'running' THEN 'running'
             ELSE agent_runs.status
           END",
        params![
            run_id,
            profile_id.trim(),
            goal.trim(),
            start_url.trim(),
            domain.trim()
        ],
    )?;
    let id: i64 = connection.query_row(
        "SELECT id FROM agent_runs WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    Ok(id)
}

pub fn finish_agent_run(
    connection: &Connection,
    run_id: &str,
    profile_id: &str,
    goal: &str,
    start_url: &str,
    domain: &str,
    status: &str,
    success: Option<bool>,
    summary: &str,
    step_count: i64,
    hitl_occurred: bool,
    trajectory_id: Option<i64>,
    thought_summary: &str,
    stats: &crate::models::AgentRunFinishStats,
) -> Result<i64, AppError> {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return Err(AppError::Validation("agent run_id cannot be empty".to_owned()));
    }
    let status = match status.trim() {
        "complete" | "failed" | "aborted" => status.trim(),
        _ => {
            if success == Some(true) {
                "complete"
            } else {
                "failed"
            }
        }
    };
    let success_i: Option<i64> = success.map(|v| if v { 1 } else { 0 });
    let hitl_i: i64 = if hitl_occurred { 1 } else { 0 };
    let thought = if thought_summary.trim().is_empty() {
        "[]"
    } else {
        thought_summary
    };

    // 先确保行存在（finish 先于 start 到达时也能落库）
    connection.execute(
        "INSERT INTO agent_runs (run_id, profile_id, goal, start_url, domain, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'running')
         ON CONFLICT(run_id) DO NOTHING",
        params![
            run_id,
            profile_id.trim(),
            goal.trim(),
            start_url.trim(),
            domain.trim()
        ],
    )?;

    connection.execute(
        "UPDATE agent_runs SET
           profile_id = CASE WHEN ?2 = '' THEN profile_id ELSE ?2 END,
           goal = CASE WHEN ?3 = '' THEN goal ELSE ?3 END,
           start_url = CASE WHEN ?4 = '' THEN start_url ELSE ?4 END,
           domain = CASE WHEN ?5 = '' THEN domain ELSE ?5 END,
           status = ?6,
           success = ?7,
           summary = ?8,
           step_count = ?9,
           hitl_occurred = ?10,
           trajectory_id = COALESCE(?11, trajectory_id),
           thought_summary = ?12,
           ended_at = CURRENT_TIMESTAMP,
           prompt_tokens = ?13,
           completion_tokens = ?14,
           total_tokens = ?15,
           estimated_cost_micro_usd = ?16,
           llm_calls = ?17,
           llm_model = ?18,
           cost_used_default_rate = ?19,
           failure_class = ?20,
           failure_counts = ?21
         WHERE run_id = ?1",
        params![
            run_id,
            profile_id.trim(),
            goal.trim(),
            start_url.trim(),
            domain.trim(),
            status,
            success_i,
            summary.trim(),
            step_count.max(0),
            hitl_i,
            trajectory_id,
            thought,
            stats.prompt_tokens.max(0),
            stats.completion_tokens.max(0),
            stats.total_tokens.max(0),
            stats.estimated_cost_micro_usd.max(0),
            stats.llm_calls.max(0),
            stats.llm_model.trim(),
            if stats.cost_used_default_rate { 1 } else { 0 },
            stats.failure_class.trim(),
            if stats.failure_counts.trim().is_empty() {
                "{}"
            } else {
                stats.failure_counts.as_str()
            }
        ],
    )?;
    let id: i64 = connection.query_row(
        "SELECT id FROM agent_runs WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    Ok(id)
}

/// 轨迹落库后按 run_id 回填 trajectory_id（与录制解耦时的关联）
pub fn link_agent_run_trajectory(
    connection: &Connection,
    run_id: &str,
    trajectory_id: i64,
) -> Result<(), AppError> {
    let run_id = run_id.trim();
    if run_id.is_empty() || trajectory_id <= 0 {
        return Ok(());
    }
    connection.execute(
        "UPDATE agent_runs SET trajectory_id = ?2 WHERE run_id = ?1",
        params![run_id, trajectory_id],
    )?;
    Ok(())
}

pub fn list_agent_runs(
    connection: &Connection,
    query: &str,
    limit: i64,
) -> Result<Vec<crate::models::AgentRun>, AppError> {
    let limit = limit.clamp(1, 500);
    let q = query.trim();
    if q.is_empty() {
        let sql = format!(
            "SELECT {AGENT_RUN_COLUMNS}
             FROM agent_runs
             ORDER BY COALESCE(ended_at, started_at, created_at) DESC
             LIMIT ?1"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement
            .query_map(params![limit], map_agent_run_row)?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(rows);
    }
    let like = format!("%{}%", q);
    let sql = format!(
        "SELECT {AGENT_RUN_COLUMNS}
         FROM agent_runs
         WHERE goal LIKE ?1
            OR domain LIKE ?1
            OR profile_id LIKE ?1
            OR summary LIKE ?1
            OR run_id LIKE ?1
            OR status LIKE ?1
            OR failure_class LIKE ?1
            OR llm_model LIKE ?1
         ORDER BY COALESCE(ended_at, started_at, created_at) DESC
         LIMIT ?2"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map(params![like, limit], map_agent_run_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_agent_run(connection: &Connection, id: i64) -> Result<crate::models::AgentRun, AppError> {
    let sql = format!("SELECT {AGENT_RUN_COLUMNS} FROM agent_runs WHERE id = ?1");
    connection
        .query_row(&sql, params![id], map_agent_run_row)
        .map_err(|_| AppError::NotFound(format!("agent run {id} not found")))
}

pub fn delete_agent_run(connection: &Connection, id: i64) -> Result<(), AppError> {
    let affected = connection.execute("DELETE FROM agent_runs WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("agent run {id} not found")));
    }
    Ok(())
}

pub fn batch_delete_agent_runs(connection: &Connection, ids: &[i64]) -> Result<usize, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation(
            "agent run batch delete requires at least one id".to_owned(),
        ));
    }

    let transaction = connection.unchecked_transaction()?;
    let mut deleted = 0usize;
    for id in ids {
        let affected = transaction.execute("DELETE FROM agent_runs WHERE id = ?1", params![id])?;
        deleted += affected;
    }
    transaction.commit()?;
    Ok(deleted)
}

fn map_agent_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::models::AgentRun> {
    let success_i: Option<i64> = row.get(7)?;
    let hitl_i: i64 = row.get(10)?;
    Ok(crate::models::AgentRun {
        id: row.get(0)?,
        run_id: row.get(1)?,
        profile_id: row.get(2)?,
        goal: row.get(3)?,
        start_url: row.get(4)?,
        domain: row.get(5)?,
        status: row.get(6)?,
        success: success_i.map(|v| v != 0),
        summary: row.get(8)?,
        step_count: row.get(9)?,
        hitl_occurred: hitl_i != 0,
        trajectory_id: row.get(11)?,
        thought_summary: row.get(12)?,
        started_at: row.get(13)?,
        ended_at: row.get(14)?,
        created_at: row.get(15)?,
        prompt_tokens: row.get(16)?,
        completion_tokens: row.get(17)?,
        total_tokens: row.get(18)?,
        estimated_cost_micro_usd: row.get(19)?,
        llm_calls: row.get(20)?,
        llm_model: row.get(21)?,
        cost_used_default_rate: row.get::<_, i64>(22)? != 0,
        failure_class: row.get(23)?,
        failure_counts: row.get(24)?,
    })
}

/// P5.4：运行历史看板合计。费用是配置单价估算，不是账单。
pub fn summarize_agent_run_board(
    connection: &Connection,
) -> Result<crate::models::AgentRunBoard, AppError> {
    let (
        run_count,
        finished_count,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        estimated_cost_micro_usd,
        default_rate_runs,
    ): (i64, i64, i64, i64, i64, i64, i64) = connection.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN status != 'running' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(prompt_tokens), 0),
                COALESCE(SUM(completion_tokens), 0),
                COALESCE(SUM(total_tokens), 0),
                COALESCE(SUM(estimated_cost_micro_usd), 0),
                COALESCE(SUM(cost_used_default_rate), 0)
         FROM agent_runs",
        [],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        },
    )?;

    let mut class_stmt = connection.prepare(
        "SELECT failure_class, COUNT(*)
         FROM agent_runs
         WHERE status != 'running'
           AND failure_class != ''
           AND failure_class != 'none'
         GROUP BY failure_class
         ORDER BY COUNT(*) DESC
         LIMIT 12",
    )?;
    let class_rows = class_stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut classes = serde_json::Map::new();
    for (key, count) in class_rows {
        if count > 0 {
            classes.insert(key, serde_json::json!(count));
        }
    }

    let mut event_stmt = connection.prepare(
        "SELECT failure_counts FROM agent_runs
         WHERE failure_counts != '' AND failure_counts != '{}'",
    )?;
    let event_rows = event_stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut events: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for raw in event_rows {
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        for (key, value) in map {
            let Some(n) = value.as_i64() else {
                continue;
            };
            if n <= 0 {
                continue;
            }
            let slot = events.entry(key).or_insert(0);
            *slot = slot.saturating_add(n);
        }
    }
    let mut ranked: Vec<(String, i64)> = events.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(12);
    let mut event_json = serde_json::Map::new();
    for (key, count) in ranked {
        event_json.insert(key, serde_json::json!(count));
    }

    Ok(crate::models::AgentRunBoard {
        run_count,
        finished_count,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        estimated_cost_micro_usd,
        cost_used_default_rate: default_rate_runs > 0,
        failure_classes: serde_json::Value::Object(classes).to_string(),
        failure_events: serde_json::Value::Object(event_json).to_string(),
    })
}

/// 按内容清理影子副本（Agent 成功时常同时写文件 + SQLite）
pub fn delete_agent_trajectories_matching(
    connection: &Connection,
    domain: &str,
    title: &str,
    goal: &str,
) -> Result<usize, AppError> {
    let domain = domain.trim();
    let title = title.trim();
    let goal = goal.trim();
    if domain.is_empty() || title.is_empty() {
        return Ok(0);
    }
    let affected = if goal.is_empty() {
        connection.execute(
            "DELETE FROM agent_trajectories WHERE domain = ?1 AND title = ?2",
            params![domain, title],
        )?
    } else {
        connection.execute(
            "DELETE FROM agent_trajectories
             WHERE domain = ?1 AND title = ?2 AND (goal = ?3 OR goal = '' OR ?3 = '')",
            params![domain, title, goal],
        )?
    };
    Ok(affected)
}

const CONTROL_MEMORY_PER_DOMAIN_CAP: usize = 50;

fn sanitize_control_selector(raw: &str) -> String {
    let selector = raw.trim();
    if selector.is_empty() {
        return String::new();
    }
    // 拒绝纯数字临时短 id
    if selector.chars().all(|ch| ch.is_ascii_digit()) {
        return String::new();
    }
    if regex_is_sensitive_selector(selector) {
        return String::new();
    }
    selector.chars().take(240).collect()
}

fn regex_is_sensitive_selector(selector: &str) -> bool {
    let lower = selector.to_ascii_lowercase();
    lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("token")
        || lower.contains("csrf")
        || lower.contains("authorization")
        || lower.contains("api_key")
        || lower.contains("apikey")
}

fn sanitize_control_intent(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}

fn normalize_intent_key(raw: &str) -> String {
    sanitize_control_intent(raw).to_ascii_lowercase()
}

/// Upsert 同站控件记忆（LRU：同 key 刷新 hit_count；每域名最多 50 条）
pub fn upsert_agent_control_memory(
    connection: &Connection,
    domain: &str,
    intent: &str,
    intent_key: &str,
    kind: &str,
    selector: &str,
    text_hint: &str,
    x_percent: Option<f64>,
    y_percent: Option<f64>,
    hit_count: Option<i64>,
) -> Result<i64, AppError> {
    let domain = domain.trim().trim_start_matches("www.").to_ascii_lowercase();
    let intent = sanitize_control_intent(intent);
    let intent_key = {
        let key = intent_key.trim();
        if key.is_empty() {
            normalize_intent_key(&intent)
        } else {
            normalize_intent_key(key)
        }
    };
    let selector = sanitize_control_selector(selector);
    let text_hint: String = text_hint.trim().chars().take(48).collect();
    let kind = match kind.trim().to_ascii_lowercase().as_str() {
        "fill" => "fill",
        "vision" => "vision",
        _ => "click",
    };

    if domain.is_empty() || intent_key.is_empty() {
        return Err(AppError::Validation(
            "control memory domain/intent cannot be empty".to_owned(),
        ));
    }
    if selector.is_empty() && x_percent.is_none() && y_percent.is_none() {
        return Err(AppError::Validation(
            "control memory requires selector or coordinates".to_owned(),
        ));
    }

    let now = chrono_like_now();
    let incoming_hits = hit_count.unwrap_or(1).max(1);

    connection.execute(
        "INSERT INTO agent_control_memory
            (domain, intent, intent_key, kind, selector, text_hint, x_percent, y_percent, hit_count, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(domain, intent_key) DO UPDATE SET
            intent = excluded.intent,
            kind = excluded.kind,
            selector = CASE WHEN excluded.selector = '' THEN agent_control_memory.selector ELSE excluded.selector END,
            text_hint = CASE WHEN excluded.text_hint = '' THEN agent_control_memory.text_hint ELSE excluded.text_hint END,
            x_percent = COALESCE(excluded.x_percent, agent_control_memory.x_percent),
            y_percent = COALESCE(excluded.y_percent, agent_control_memory.y_percent),
            hit_count = agent_control_memory.hit_count + 1,
            updated_at = excluded.updated_at",
        params![
            domain,
            intent,
            intent_key,
            kind,
            selector,
            text_hint,
            x_percent,
            y_percent,
            incoming_hits,
            now,
        ],
    )?;

    // 每域名 LRU 裁剪：保留 updated_at 最新的 50 条
    connection.execute(
        "DELETE FROM agent_control_memory
         WHERE domain = ?1
           AND id NOT IN (
             SELECT id FROM agent_control_memory
             WHERE domain = ?1
             ORDER BY updated_at DESC, id DESC
             LIMIT ?2
           )",
        params![domain, CONTROL_MEMORY_PER_DOMAIN_CAP as i64],
    )?;

    let id: i64 = connection.query_row(
        "SELECT id FROM agent_control_memory WHERE domain = ?1 AND intent_key = ?2",
        params![domain, intent_key],
        |row| row.get(0),
    )?;
    Ok(id)
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // ISO-ish without chrono crate dependency
    format!("{secs}")
}

pub fn list_agent_control_memory(
    connection: &Connection,
    domain: &str,
) -> Result<Vec<crate::models::AgentControlMemory>, AppError> {
    let domain = domain.trim().trim_start_matches("www.").to_ascii_lowercase();
    if domain.is_empty() {
        let mut statement = connection.prepare(
            "SELECT id, domain, intent, intent_key, kind, selector, text_hint,
                    x_percent, y_percent, hit_count, updated_at
             FROM agent_control_memory
             ORDER BY updated_at DESC, id DESC
             LIMIT 500",
        )?;
        let rows = statement
            .query_map([], map_control_memory_row)?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(rows);
    }

    let mut statement = connection.prepare(
        "SELECT id, domain, intent, intent_key, kind, selector, text_hint,
                x_percent, y_percent, hit_count, updated_at
         FROM agent_control_memory
         WHERE domain = ?1
         ORDER BY updated_at DESC, id DESC
         LIMIT 50",
    )?;
    let rows = statement
        .query_map(params![domain], map_control_memory_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_control_memory_row(
    row: &rusqlite::Row<'_>,
) -> Result<crate::models::AgentControlMemory, rusqlite::Error> {
    Ok(crate::models::AgentControlMemory {
        id: row.get(0)?,
        domain: row.get(1)?,
        intent: row.get(2)?,
        intent_key: row.get(3)?,
        kind: row.get(4)?,
        selector: row.get(5)?,
        text_hint: row.get(6)?,
        x_percent: row.get(7)?,
        y_percent: row.get(8)?,
        hit_count: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn clear_agent_control_memory(
    connection: &Connection,
    domain: &str,
) -> Result<usize, AppError> {
    let domain = domain.trim().trim_start_matches("www.").to_ascii_lowercase();
    if domain.is_empty() {
        let affected = connection.execute("DELETE FROM agent_control_memory", [])?;
        return Ok(affected);
    }
    let affected = connection.execute(
        "DELETE FROM agent_control_memory WHERE domain = ?1",
        params![domain],
    )?;
    Ok(affected)
}

/// 环境人设写入 / 读取已下线：用户人设改由「规则」窗口维护
/// （`global_settings.agent_personas` + `agent_persona_selection`，见
/// [`resolve_agent_persona_for_profile`]）。`profiles.persona_data` 列保留为 INFO 残留，无写入方。
///
/// P1.3 / P5.1：第三方验证码服务配置（禁止明文 apiKey；solver 见 captcha_remote）
pub fn normalize_captcha_service_json(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|error| AppError::Validation(format!("captcha_service must be JSON: {error}")))?;
    let obj = parsed.as_object().ok_or_else(|| {
        AppError::Validation("captcha_service must be a JSON object".to_owned())
    })?;
    for forbidden in ["password", "apiKey", "api_key", "secret", "token"] {
        if obj.contains_key(forbidden) {
            return Err(AppError::Validation(format!(
                "captcha_service must not embed plaintext field '{forbidden}'; use apiKeyRef"
            )));
        }
    }
    let type_raw = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .trim()
        .to_ascii_lowercase();
    if type_raw == "none" || type_raw.is_empty() {
        return Ok(r#"{"type":"none","enabled":false}"#.to_owned());
    }
    if type_raw != "third_party" {
        return Err(AppError::Validation(format!(
            "unsupported captcha_service type: {type_raw}"
        )));
    }
    let provider = obj
        .get("providerId")
        .or_else(|| obj.get("provider_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let api_key_ref = obj
        .get("apiKeyRef")
        .or_else(|| obj.get("api_key_ref"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if provider.is_empty() {
        return Err(AppError::Validation(
            "third_party captcha_service requires providerId".to_owned(),
        ));
    }
    if api_key_ref.is_empty() {
        return Err(AppError::Validation(
            "third_party captcha_service requires apiKeyRef".to_owned(),
        ));
    }
    let _ = validate_secret_ref_id(api_key_ref)?;
    serde_json::to_string(&parsed).map_err(|error| AppError::Serialization(error.to_string()))
}

/// P5.3：短信接码服务配置（默认关；禁止明文 apiKey）
pub fn normalize_sms_otp_service_json(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|error| AppError::Validation(format!("sms_otp_service must be JSON: {error}")))?;
    let obj = parsed.as_object().ok_or_else(|| {
        AppError::Validation("sms_otp_service must be a JSON object".to_owned())
    })?;
    for forbidden in ["password", "apiKey", "api_key", "secret", "token"] {
        if obj.contains_key(forbidden) {
            return Err(AppError::Validation(format!(
                "sms_otp_service must not embed plaintext field '{forbidden}'; use apiKeyRef"
            )));
        }
    }
    let type_raw = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .trim()
        .to_ascii_lowercase();
    if type_raw == "none" || type_raw.is_empty() {
        return Ok(r#"{"type":"none","enabled":false}"#.to_owned());
    }
    if type_raw != "third_party" {
        return Err(AppError::Validation(format!(
            "unsupported sms_otp_service type: {type_raw}"
        )));
    }
    let provider = obj
        .get("providerId")
        .or_else(|| obj.get("provider_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let api_key_ref = obj
        .get("apiKeyRef")
        .or_else(|| obj.get("api_key_ref"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if provider.is_empty() {
        return Err(AppError::Validation(
            "third_party sms_otp_service requires providerId".to_owned(),
        ));
    }
    if api_key_ref.is_empty() {
        return Err(AppError::Validation(
            "third_party sms_otp_service requires apiKeyRef".to_owned(),
        ));
    }
    let _ = validate_secret_ref_id(api_key_ref)?;
    serde_json::to_string(&parsed).map_err(|error| AppError::Serialization(error.to_string()))
}

/// P1.1 / P5.6：规范化 otp_channel JSON（禁止明文 password/apiKey；未显式启用的网页邮箱拒绝）
pub fn normalize_otp_channel_json(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|error| AppError::Validation(format!("otp_channel must be JSON: {error}")))?;
    let obj = parsed.as_object().ok_or_else(|| {
        AppError::Validation("otp_channel must be a JSON object".to_owned())
    })?;
    let type_raw = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .trim()
        .to_ascii_lowercase();
    if matches!(
        type_raw.as_str(),
        "webmail" | "webmail_ui" | "browser_mailbox"
    ) {
        return Err(AppError::Validation(
            "otp_channel must not use webmail UI as default path".to_owned(),
        ));
    }
    // 拒绝把明文密钥塞进绑定 JSON（必须走 secret_refs）
    for forbidden in ["password", "apiKey", "api_key", "secret", "token"] {
        if obj.contains_key(forbidden) {
            return Err(AppError::Validation(format!(
                "otp_channel must not embed plaintext field '{forbidden}'; use secretRef/apiKeyRef"
            )));
        }
    }
    if type_raw == "none" || type_raw.is_empty() {
        return Ok(r#"{"type":"none"}"#.to_owned());
    }
    if type_raw == "imap" {
        let host = obj.get("host").and_then(|v| v.as_str()).unwrap_or("").trim();
        let user = obj.get("user").and_then(|v| v.as_str()).unwrap_or("").trim();
        let secret_ref = obj
            .get("secretRef")
            .or_else(|| obj.get("secret_ref"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let port = obj.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
        if host.is_empty() || user.is_empty() || secret_ref.is_empty() || !(1..=65535).contains(&port)
        {
            return Err(AppError::Validation(
                "imap otp_channel requires host, port, user, secretRef".to_owned(),
            ));
        }
    } else if type_raw == "tempmail_provider" || type_raw == "tempmail" {
        let provider = obj
            .get("providerId")
            .or_else(|| obj.get("provider_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let api_key_ref = obj
            .get("apiKeyRef")
            .or_else(|| obj.get("api_key_ref"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if provider.is_empty() || api_key_ref.is_empty() {
            return Err(AppError::Validation(
                "tempmail otp_channel requires providerId and apiKeyRef".to_owned(),
            ));
        }
    } else if type_raw == "webmail_adapter" {
        let enabled = obj
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !enabled {
            return Err(AppError::Validation(
                "webmail_adapter requires explicit enabled=true; webmail is not the default OTP path"
                    .to_owned(),
            ));
        }
        let provider = obj
            .get("providerId")
            .or_else(|| obj.get("provider_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !matches!(provider.as_str(), "gmail" | "qq" | "outlook") {
            return Err(AppError::Validation(
                "webmail_adapter providerId must be gmail, qq, or outlook".to_owned(),
            ));
        }
    } else {
        return Err(AppError::Validation(format!(
            "unsupported otp_channel type: {type_raw}"
        )));
    }
    serde_json::to_string(&parsed).map_err(|error| AppError::Serialization(error.to_string()))
}

fn validate_secret_ref_id(ref_id: &str) -> Result<String, AppError> {
    let trimmed = ref_id.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err(AppError::Validation(
            "secret ref_id must be 1..=128 chars".to_owned(),
        ));
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == ':')
    {
        return Err(AppError::Validation(
            "secret ref_id contains invalid characters".to_owned(),
        ));
    }
    Ok(trimmed.to_owned())
}

/// P1.1：写入命名密钥（DPAPI/keyfile 信封）；永不在返回值中带回明文
pub fn put_secret_ref(
    connection: &Connection,
    ref_id: &str,
    plaintext: &str,
    kind: &str,
) -> Result<(), AppError> {
    let id = validate_secret_ref_id(ref_id)?;
    let plain = plaintext.trim();
    if plain.is_empty() {
        return Err(AppError::Validation(
            "secret plaintext cannot be empty".to_owned(),
        ));
    }
    let sealed = crate::secret_store::protect(plain)?.ok_or_else(|| {
        AppError::Validation("secret plaintext cannot be empty".to_owned())
    })?;
    let kind_norm = {
        let t = kind.trim();
        if t.is_empty() {
            "otp"
        } else {
            t
        }
    };
    connection.execute(
        "INSERT INTO secret_refs (ref_id, sealed_value, kind, updated_at)
         VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
         ON CONFLICT(ref_id) DO UPDATE SET
           sealed_value = excluded.sealed_value,
           kind = excluded.kind,
           updated_at = CURRENT_TIMESTAMP",
        params![id, sealed, kind_norm],
    )?;
    Ok(())
}

pub fn delete_secret_ref(connection: &Connection, ref_id: &str) -> Result<bool, AppError> {
    let id = validate_secret_ref_id(ref_id)?;
    let affected = connection.execute("DELETE FROM secret_refs WHERE ref_id = ?1", params![id])?;
    Ok(affected > 0)
}

/// 运行时解密；密文不可恢复 → None（调用方视作未配置）
pub fn reveal_secret_ref(connection: &Connection, ref_id: &str) -> Result<Option<String>, AppError> {
    let id = validate_secret_ref_id(ref_id)?;
    let mut statement =
        connection.prepare("SELECT sealed_value FROM secret_refs WHERE ref_id = ?1")?;
    let sealed: Option<String> = statement
        .query_row(params![id], |row| row.get(0))
        .optional()?;
    Ok(sealed.and_then(|raw| reveal_stored_secret(Some(raw))))
}

pub fn secret_ref_exists(connection: &Connection, ref_id: &str) -> Result<bool, AppError> {
    let id = validate_secret_ref_id(ref_id)?;
    let mut statement =
        connection.prepare("SELECT 1 FROM secret_refs WHERE ref_id = ?1 LIMIT 1")?;
    let found = statement
        .query_row(params![id], |_row| Ok(()))
        .optional()?;
    Ok(found.is_some())
}

/// 环境级绑定；空字符串清除
pub fn set_profile_otp_channel(
    connection: &Connection,
    profile_id: i64,
    channel_json: &str,
) -> Result<Profile, AppError> {
    let stored = normalize_otp_channel_json(channel_json)?;
    let value: Option<&str> = if stored.is_empty() {
        None
    } else {
        Some(stored.as_str())
    };
    let affected = connection.execute(
        "UPDATE profiles SET otp_channel = ?1 WHERE id = ?2",
        params![value, profile_id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {profile_id}")));
    }
    get_profile(connection, profile_id)
}

/// 解析生效通道：环境绑定优先，否则全局 settings.otp_channel
pub fn resolve_otp_channel_json(
    connection: &Connection,
    profile_id: Option<i64>,
) -> Result<String, AppError> {
    if let Some(id) = profile_id {
        if let Some(raw) = get_profile(connection, id)?
            .otp_channel
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
        {
            return Ok(normalize_otp_channel_json(&raw)?);
        }
    }
    let global = get_setting(connection, "otp_channel")?
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    if global.is_empty() {
        return Ok(r#"{"type":"none"}"#.to_owned());
    }
    normalize_otp_channel_json(&global)
}

/// P1.2：按通道 JSON 中的 secretRef / apiKeyRef 解出明文，供 Agent 会话内存注入。
/// 仅返回能成功解密的句柄；失败项跳过（Sidecar 侧会得到 auth_failed）。
pub fn reveal_otp_channel_secrets(
    connection: &Connection,
    channel: &serde_json::Value,
) -> Option<serde_json::Value> {
    let obj = channel.as_object()?;
    let type_raw = obj
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("none")
        .trim()
        .to_ascii_lowercase();
    if type_raw == "none" || type_raw.is_empty() {
        return None;
    }
    let mut map = serde_json::Map::new();
    let refs: Vec<String> = match type_raw.as_str() {
        "imap" => obj
            .get("secretRef")
            .or_else(|| obj.get("secret_ref"))
            .and_then(serde_json::Value::as_str)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .into_iter()
            .collect(),
        "tempmail_provider" | "tempmail" => obj
            .get("apiKeyRef")
            .or_else(|| obj.get("api_key_ref"))
            .and_then(serde_json::Value::as_str)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .into_iter()
            .collect(),
        _ => Vec::new(),
    };
    for ref_id in refs {
        if let Ok(Some(plain)) = reveal_secret_ref(connection, &ref_id) {
            if !plain.is_empty() {
                map.insert(ref_id, serde_json::Value::String(plain));
            }
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(map))
    }
}

/// P5.1：读取全局 captcha_service JSON（规范化；空 → none）
pub fn resolve_captcha_service_json(connection: &Connection) -> Result<String, AppError> {
    let global = get_setting(connection, "captcha_service")?
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    if global.is_empty() {
        return Ok(r#"{"type":"none","enabled":false}"#.to_owned());
    }
    normalize_captcha_service_json(&global)
}

/// P5.1：按 captcha_service.apiKeyRef 解出明文，供 Agent 会话内存注入。
pub fn reveal_captcha_service_secrets(
    connection: &Connection,
    service: &serde_json::Value,
) -> Option<serde_json::Value> {
    let obj = service.as_object()?;
    let type_raw = obj
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("none")
        .trim()
        .to_ascii_lowercase();
    if type_raw != "third_party" {
        return None;
    }
    let enabled = obj
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return None;
    }
    let api_key_ref = obj
        .get("apiKeyRef")
        .or_else(|| obj.get("api_key_ref"))
        .and_then(serde_json::Value::as_str)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())?;
    let mut map = serde_json::Map::new();
    if let Ok(Some(plain)) = reveal_secret_ref(connection, &api_key_ref) {
        if !plain.is_empty() {
            map.insert(api_key_ref, serde_json::Value::String(plain));
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(map))
    }
}

/// P5.3：读取全局 sms_otp_service JSON（规范化；空 → none/enabled=false）
pub fn resolve_sms_otp_service_json(connection: &Connection) -> Result<String, AppError> {
    let global = get_setting(connection, "sms_otp_service")?
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    if global.is_empty() {
        return Ok(r#"{"type":"none","enabled":false}"#.to_owned());
    }
    normalize_sms_otp_service_json(&global)
}

/// P5.3：按 sms_otp_service.apiKeyRef 解出明文（仅 enabled=true 时注入）
pub fn reveal_sms_otp_service_secrets(
    connection: &Connection,
    service: &serde_json::Value,
) -> Option<serde_json::Value> {
    let obj = service.as_object()?;
    let type_raw = obj
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("none")
        .trim()
        .to_ascii_lowercase();
    if type_raw != "third_party" {
        return None;
    }
    let enabled = obj
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return None;
    }
    let api_key_ref = obj
        .get("apiKeyRef")
        .or_else(|| obj.get("api_key_ref"))
        .and_then(serde_json::Value::as_str)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())?;
    let mut map = serde_json::Map::new();
    if let Ok(Some(plain)) = reveal_secret_ref(connection, &api_key_ref) {
        if !plain.is_empty() {
            map.insert(api_key_ref, serde_json::Value::String(plain));
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(map))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn_with_ids(ids: &[i64]) -> Connection {
        let connection = Connection::open_in_memory().expect("open memory db");
        connection
            .execute_batch("CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT)")
            .expect("create profiles");
        for id in ids {
            connection
                .execute("INSERT INTO profiles (id) VALUES (?1)", params![id])
                .expect("insert id");
        }
        connection
    }

    #[test]
    fn reuses_deleted_slot_inside_occupied_range() {
        // 原有 3,4,5,6，删除 4 → 下一个补回 4
        assert_eq!(next_available_profile_id(&conn_with_ids(&[3, 5, 6])).unwrap(), 4);
        assert_eq!(
            next_available_profile_id(&conn_with_ids(&[1, 2, 3, 5, 6])).unwrap(),
            4
        );
        // 空洞在下限之上优先复用，不回填到更早的空位
        assert_eq!(next_available_profile_id(&conn_with_ids(&[3, 4, 6])).unwrap(), 5);
    }

    #[test]
    fn appends_after_max_when_no_hole() {
        assert_eq!(next_available_profile_id(&conn_with_ids(&[1, 2, 3])).unwrap(), 4);
        assert_eq!(
            next_available_profile_id(&conn_with_ids(&[3, 4, 5, 6])).unwrap(),
            7
        );
    }

    #[test]
    fn empty_table_starts_at_one() {
        assert_eq!(next_available_profile_id(&conn_with_ids(&[])).unwrap(), 1);
    }

    #[test]
    fn repeated_allocation_fills_multiple_holes_in_order() {
        let connection = conn_with_ids(&[1, 3, 4, 7]);
        assert_eq!(next_available_profile_id(&connection).unwrap(), 2);
        connection
            .execute("INSERT INTO profiles (id) VALUES (2)", [])
            .unwrap();
        assert_eq!(next_available_profile_id(&connection).unwrap(), 5);
        connection
            .execute("INSERT INTO profiles (id) VALUES (5)", [])
            .unwrap();
        assert_eq!(next_available_profile_id(&connection).unwrap(), 6);
    }

    /// 仅建 proxies 表（跳过全量 schema），用于凭据加密的读写往返验证。
    fn conn_with_proxies() -> Connection {
        let connection = Connection::open_in_memory().expect("open memory db");
        connection
            .execute_batch(
                "CREATE TABLE proxies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    \"type\" TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    username TEXT,
                    password TEXT,
                    api_config TEXT
                )",
            )
            .expect("create proxies");
        connection
    }

    fn raw_secret(connection: &Connection, id: i64, column: &str) -> Option<String> {
        let sql = format!("SELECT {column} FROM proxies WHERE id = ?1");
        connection
            .query_row(&sql, params![id], |row| row.get::<_, Option<String>>(0))
            .expect("read raw column")
    }

    #[test]
    fn proxy_credentials_never_hit_disk_in_plaintext() {
        let connection = conn_with_proxies();
        let proxy = insert_proxy(
            &connection,
            "HTTP",
            "1.2.3.4",
            8080,
            Some("user"),
            Some("s3cr3t-pass"),
            None,
        )
        .expect("insert proxy");

        // 存储层必须是信封，且不包含明文
        let stored = raw_secret(&connection, proxy.id, "password").expect("stored password");
        assert!(crate::secret_store::is_protected(&stored), "not encrypted: {stored}");
        assert!(!stored.contains("s3cr3t"), "plaintext leaked into db: {stored}");

        // 读取层自动解密，调用方无感
        assert_eq!(proxy.password.as_deref(), Some("s3cr3t-pass"));
        let fetched = get_proxy(&connection, proxy.id).expect("get proxy");
        assert_eq!(fetched.password.as_deref(), Some("s3cr3t-pass"));
        let listed = list_proxies(&connection).expect("list proxies");
        assert_eq!(listed[0].password.as_deref(), Some("s3cr3t-pass"));
    }

    #[test]
    fn dynamic_api_config_is_encrypted_and_still_parsable() {
        let connection = conn_with_proxies();
        let config = r#"{"api_url":"https://api.example.com/get?key=EMBEDDED_TOKEN","protocol":"http","region":"US"}"#;
        let proxy = insert_proxy(&connection, "DYNAMIC_API", "api", 1, None, None, Some(config))
            .expect("insert dynamic proxy");

        let stored = raw_secret(&connection, proxy.id, "api_config").expect("stored config");
        assert!(crate::secret_store::is_protected(&stored), "not encrypted: {stored}");
        assert!(!stored.contains("EMBEDDED_TOKEN"), "token leaked into db: {stored}");

        // 解密后的 JSON 必须仍能被业务解析（否则动态代理会静默失效）
        let decrypted = proxy.api_config.expect("decrypted config");
        let parsed = parse_dynamic_api_config(&decrypted).expect("parse decrypted config");
        assert_eq!(parsed.protocol, "http");
        assert_eq!(parsed.region, "US");
        assert!(parsed.api_url.contains("EMBEDDED_TOKEN"));
    }

    #[test]
    fn legacy_plaintext_credentials_are_lazily_migrated() {
        let connection = conn_with_proxies();
        // 模拟旧版本直接写入的明文行（不走 insert_proxy）
        connection
            .execute(
                "INSERT INTO proxies (\"type\", host, port, username, password, api_config)
                 VALUES ('HTTP', '5.6.7.8', 1080, 'legacy', 'legacy-pass', NULL)",
                [],
            )
            .expect("insert legacy row");

        // 迁移前确实仍是明文
        let before = raw_secret(&connection, 1, "password").expect("raw");
        assert!(!crate::secret_store::is_protected(&before));

        // 任一次读取即触发懒迁移
        let listed = list_proxies(&connection).expect("list proxies");
        assert_eq!(listed[0].password.as_deref(), Some("legacy-pass"));

        let after = raw_secret(&connection, 1, "password").expect("raw");
        assert!(
            crate::secret_store::is_protected(&after),
            "legacy plaintext was not migrated: {after}"
        );
        assert_eq!(
            crate::secret_store::reveal(&after).as_deref(),
            Some("legacy-pass"),
            "migrated value must decrypt back to the original"
        );
    }

    #[test]
    fn migration_is_idempotent_and_never_double_encrypts() {
        let connection = conn_with_proxies();
        insert_proxy(&connection, "HTTP", "9.9.9.9", 3128, None, Some("pw-once"), None)
            .expect("insert");
        let first = raw_secret(&connection, 1, "password").expect("raw");

        // 反复读取不得二次套娃
        list_proxies(&connection).unwrap();
        list_proxies(&connection).unwrap();
        let second = raw_secret(&connection, 1, "password").expect("raw");
        assert_eq!(first, second);
        assert_eq!(crate::secret_store::reveal(&second).as_deref(), Some("pw-once"));
    }

    #[test]
    fn empty_credentials_stay_null_instead_of_enveloped() {
        let connection = conn_with_proxies();
        let proxy = insert_proxy(&connection, "HTTP", "1.1.1.1", 80, Some("u"), None, None)
            .expect("insert");
        assert!(raw_secret(&connection, proxy.id, "password").is_none());
        assert!(proxy.password.is_none());
    }

    #[test]
    fn agent_run_board_keeps_tokens_and_drops_secrets() {
        let dir = std::env::temp_dir().join(format!(
            "tianshutai-p54-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("tmpdir");
        let connection = init_database(&dir.join("t.db")).expect("init");
        ensure_agent_run_metric_columns(&connection).expect("migrate twice");
        let stats = crate::models::AgentRunFinishStats::from_event(&serde_json::json!({
            "promptTokens": 1000,
            "completionTokens": 200,
            "totalTokens": 1200,
            "estimatedCostMicroUsd": 450,
            "llmCalls": 2,
            "llmModel": "sk-abcdefghijklmnopqrstuvwxyz",
            "costUsedDefaultRate": true,
            "failureClass": "timeout",
            "failureCounts": {
                "timeout": 2,
                "847291": 9,
                "otp": 1,
                "code847291": 3,
                "needs-human": "998877"
            }
        }));
        assert!(
            !stats.failure_counts.contains("847291"),
            "{}",
            stats.failure_counts
        );
        assert!(!stats.failure_counts.contains("998877"));
        assert!(!stats.llm_model.to_ascii_lowercase().contains("sk-"));
        assert_eq!(stats.failure_class, "timeout");
        assert!(stats.failure_counts.contains("\"timeout\""));
        let id = finish_agent_run(
            &connection,
            "run-p54",
            "3",
            "打开示例",
            "https://example.com",
            "example.com",
            "failed",
            Some(false),
            "失败",
            4,
            false,
            None,
            "[]",
            &stats,
        )
        .expect("finish");
        let row = get_agent_run(&connection, id).expect("get");
        assert_eq!(row.total_tokens, 1200);
        assert_eq!(row.prompt_tokens, 1000);
        assert_eq!(row.completion_tokens, 200);
        assert_eq!(row.estimated_cost_micro_usd, 450);
        assert!(row.cost_used_default_rate);
        assert!(row.llm_model.is_empty());
        assert!(!row.failure_counts.contains("847291"));
        let board = summarize_agent_run_board(&connection).expect("board");
        assert_eq!(board.run_count, 1);
        assert_eq!(board.finished_count, 1);
        assert_eq!(board.total_tokens, 1200);
        assert_eq!(board.estimated_cost_micro_usd, 450);
        assert!(board.cost_used_default_rate);
        assert!(board.failure_classes.contains("timeout"));
        assert!(board.failure_events.contains("timeout"));
        assert!(!board.failure_events.contains("847291"));
        drop(connection);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 仅建 global_settings 表（跳过全量 schema），用于「规则库人设解析」的读路径验证。
    fn conn_with_settings() -> Connection {
        let connection = Connection::open_in_memory().expect("open memory db");
        connection
            .execute_batch(
                "CREATE TABLE global_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )",
            )
            .expect("create global_settings");
        connection
    }

    const TEST_PERSONA_ID: &str = "p-1";

    /// 写入一套「规则」库人设 + 给环境 7 指定它。
    fn seed_rule_library_persona(connection: &Connection) {
        set_setting(
            connection,
            "agent_personas",
            &format!(
                r#"[{{"id":"{TEST_PERSONA_ID}","label":"美国买家","fullName":"John Q. Public","email":"q@example.com","city":"San Francisco","postalCode":"94107"}}]"#
            ),
        )
        .expect("seed personas");
        set_setting(
            connection,
            "agent_persona_selection",
            &format!(r#"{{"7":{{"personaId":"{TEST_PERSONA_ID}","fields":["fullName"]}}}}"#),
        )
        .expect("seed selection");
    }

    #[test]
    fn setting_whitelist_covers_rule_library_keys() {
        let connection = conn_with_settings();
        for key in ["agent_rules", "agent_personas", "agent_persona_selection"] {
            set_setting(&connection, key, "[]").expect("whitelisted key must be writable");
        }
        // 未登记的 key 一律拒绝：设置项不能由前端随意新增
        assert!(set_setting(&connection, "not_a_real_setting", "x").is_err());
    }

    /// 人设来自「规则」库（整套字段），与已下线的 `profiles.persona_data` 无关。
    #[test]
    fn persona_resolution_uses_rule_library() {
        let connection = conn_with_settings();
        // 未指定人设 → None（回放保持占位符原样，不编造）
        assert!(resolve_agent_persona_for_profile(&connection, "7")
            .expect("resolve")
            .is_none());

        seed_rule_library_persona(&connection);
        let persona = resolve_agent_persona_for_profile(&connection, "7")
            .expect("resolve")
            .expect("persona must be resolved");

        // {{persona.name}} 与 {{persona.fullName}} 两个别名都要有
        assert_eq!(persona.get("name").and_then(|v| v.as_str()), Some("John Q. Public"));
        assert_eq!(
            persona.get("fullName").and_then(|v| v.as_str()),
            Some("John Q. Public")
        );
        // 回放用**整套字段**，不受「固定字段」勾选限制（只勾了 fullName，city 仍要可用）
        assert_eq!(persona.get("city").and_then(|v| v.as_str()), Some("San Francisco"));
        assert_eq!(persona.get("email").and_then(|v| v.as_str()), Some("q@example.com"));

        // 别的环境没指定 → None；空 id 安全返回 None
        assert!(resolve_agent_persona_for_profile(&connection, "8")
            .expect("resolve")
            .is_none());
        assert!(resolve_agent_persona_for_profile(&connection, "   ")
            .expect("resolve")
            .is_none());
    }

    /// 人设选择记录损坏 / 指向不存在的人设时：不 panic、不静默猜到别人身上，按「未指定」处理。
    #[test]
    fn persona_resolution_fails_closed_on_broken_selection() {
        let connection = conn_with_settings();
        seed_rule_library_persona(&connection);

        set_setting(&connection, "agent_persona_selection", "{not json").expect("write broken");
        assert!(resolve_agent_persona_for_profile(&connection, "7")
            .expect("resolve")
            .is_none());

        set_setting(
            &connection,
            "agent_persona_selection",
            r#"{"7":{"personaId":"missing-persona"}}"#,
        )
        .expect("write dangling");
        assert!(resolve_agent_persona_for_profile(&connection, "7")
            .expect("resolve")
            .is_none());

        // 人设库本身损坏也一样按未指定处理
        set_setting(&connection, "agent_persona_selection", &format!(r#"{{"7":{{"personaId":"{TEST_PERSONA_ID}"}}}}"#))
            .expect("write good selection");
        set_setting(&connection, "agent_personas", "{not json").expect("write broken personas");
        assert!(resolve_agent_persona_for_profile(&connection, "7")
            .expect("resolve")
            .is_none());
    }
}
