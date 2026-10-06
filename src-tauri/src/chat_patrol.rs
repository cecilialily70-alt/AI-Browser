/**
 * 聊天模式的宿主调度器 + 看门狗（P8）。
 *
 * 分工（§4.1 / §7.4 / §11）：
 * - **引擎**（`sidecar/src/core/web_chat/engine.ts`）负责一片之内的全部决策；
 * - **宿主**只做引擎做不了的两件事：① 按时把**到期**的环境拉起来（席位轮转，**不静默丢弃**）；
 *   ② 对**真的卡住**的片做分级恢复（超时 → 优雅中止 → 重启执行进程 → 挂起并如实上报）。
 *
 * 硬约束（改这个文件前先读）：
 * - `chat_mode.enabled=false` 时**不注册定时器**：关掉即 `abort` 调度任务（§0.5.2 / §3.5）。
 * - 拉起只能走 [`crate::rpa_session::run_chat_slice`]（与手动入口**同一条闸门链**），
 *   因此绕不过总开关 / CDP 互斥 / 席位（§7.4 / S5）。
 * - 看门狗读的是**相位之外的可信事实**（片运行时长 + 停止是否生效），
 *   **不拿 `heartbeatAt` 猜死活**——等 LLM 时它同样会被刷新（§0.5.3 H）。
 * - 并发与 Agent 同口径：免费档恒为 1，Pro 也**有硬顶**，不为聊天开无限通道（§1.6 / R7）。
 * - 连续失败到顶就**停自动拉起并说清原因**，不静默重试风暴（§0.5.3 B）。
 */
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::db;
use crate::error::AppError;
use crate::rpa_session::{ChatContactInput, ChatSliceRequest, RpaSessionManager, CHAT_STATE_EVENT};
use crate::AppState;
use crate::{log_info, log_warn};

/// 聊天模式设置键（`global_settings` 里的 JSON 字符串；与前端 `chatModeSettings` 同源）
pub const KEY_CHAT_MODE: &str = "chat_mode";

/// 看门狗 T1 宽限：片时长之外还允许一个最坏联系人的耗时（LLM + 发送 + 等回复），
/// 超过才判「超时卡住」。**不能设太紧**：正常但慢的片会被误杀，代价是白丢一轮。
const WATCHDOG_OVERRUN_GRACE: Duration = Duration::from_secs(180);
/// 看门狗 T2 宽限：优雅中止下发后的落地时间（引擎收 abort 是毫秒级，这里只是保险丝）
const WATCHDOG_STOP_GRACE: Duration = Duration::from_secs(60);
/// 刚拉起的一片在这个窗口内不参与「已完成」对账（会话冷启动本身要几秒）
const SPAWN_GRACE: Duration = Duration::from_secs(20);
/// 同环境连续失败上限：到顶即挂起自动拉起
const MAX_CONSECUTIVE_FAILURES: u32 = 3;
/// 并发上限硬顶：即便 Pro 也不放无限通道
const CHAT_PARALLEL_HARD_MAX: u32 = 4;
/// 单片默认时长（与前端 `DEFAULT_CHAT_MODE_SETTINGS.sliceMs` 一致；合法区间也在那边定义）
const DEFAULT_SLICE_MS: u64 = crate::rpa_session::CHAT_SLICE_DEFAULT_MS;
/// 自适应睡眠的三档节拍（**禁止空转**：没东西可看就多睡，有片在跑才勤看）。
/// 有片在跑 → 快节拍（看门狗要及时发现「卡住」而不只是「超时」）；
/// 有到期/正忙 → **同一档快节拍**：短复查是秒级，60s 常规拍会把「马上续片」拖成「像结束了」；
/// 全空闲 → 长节拍（到期由 `nextWakeAt` 决定）。
const PATROL_TICK_ACTIVE: Duration = Duration::from_secs(20);
/// 保留常量名供测试/注释引用；生产「有 pending」已与 ACTIVE 同级。
const PATROL_TICK: Duration = Duration::from_secs(60);
const PATROL_TICK_IDLE: Duration = Duration::from_secs(180);
/// 「停滞」判定阈值：相位不变 + 单调 `progressCounter` 不涨，超过这么久才算卡住。
/// 慢站点单步（页内等待 / LLM 起草）本来就可能几十秒，阈值太紧会把正常片误判成卡住。
const STALL_LIMIT: Duration = Duration::from_secs(300);
/// 失败后的退避起点 / 上限（5min 起，翻倍递增，封顶 30min）
const RETRY_BACKOFF_BASE: Duration = Duration::from_secs(300);
const RETRY_BACKOFF_MAX: Duration = Duration::from_secs(1800);
/// License 状态的缓存时长（查它要联网；席位口径在 10 分钟内不会变）
const ENTITLEMENT_TTL: Duration = Duration::from_secs(600);

/* ————————————————————————— 调度台账 ————————————————————————— */

#[derive(Debug, Clone)]
struct SliceRecord {
    started_at: Instant,
    /// 这一片自己的时间盒（用于判超时）
    budget: Duration,
    /// 已请求的停止档位：0=未请求 1=已优雅中止 2=已重启执行进程
    stop_level: u8,
    stop_requested_at: Option<Instant>,
    /// 上一次从快照读到的运行态样本（相位 + 单调计数）与取样时刻。
    ///
    /// 判「卡住」必须**读相位 + 单调 `progressCounter`**：只看 `heartbeatAt` 分不清
    /// 「等 LLM 很久」和「真的死了」（等 LLM 时心跳照样在更新）。
    progress_sample: ProgressSample,
    sampled_at: Instant,
    /// 从上次前进到现在，已经停滞了多久（相位在豁免名单里时不累加）
    stagnated: Duration,
}

#[derive(Debug, Clone, Default)]
struct EnvHealth {
    consecutive_failures: u32,
    suspended: bool,
    reason: Option<String>,
    last_error: Option<String>,
    /// 退避窗口：在此之前不再尝试
    next_attempt_at: Option<Instant>,
}

#[derive(Debug)]
struct PatrolInner {
    enabled: AtomicBool,
    stop: AtomicBool,
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    active: Mutex<HashMap<String, SliceRecord>>,
    health: Mutex<HashMap<String, EnvHealth>>,
    /// 用户主动停止过的环境：结算时不记失败（别把「人叫停」算成「引擎坏」）
    user_stop: Mutex<HashSet<String>>,
    /// 上一次上报的队列指纹：只在变化时上报，避免每 60s 刷屏
    last_report: Mutex<Option<String>>,
    /// License 状态缓存（`(is_pro, 取回时间)`）。查 License 要联网，
    /// **绝不能每 tick / 每次视图刷新都查一遍**；拿不到就按最保守的 1 并发。
    entitlement: Mutex<Option<(bool, Instant)>>,
    /// 片结算后立刻把调度从 sleep 里叫醒（否则最多要等一整拍才续片 → 用户以为「自动结束了」）
    wake: Notify,
}

impl Default for PatrolInner {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            handle: Mutex::new(None),
            active: Mutex::new(HashMap::new()),
            health: Mutex::new(HashMap::new()),
            user_stop: Mutex::new(HashSet::new()),
            last_report: Mutex::new(None),
            entitlement: Mutex::new(None),
            wake: Notify::new(),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // 毒化不该让整个调度器停摆：取回内部值继续（护栏是「如实上报」，不是「崩掉」）
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 聊天调度器句柄（Tauri managed state）。克隆只共享 `Arc`，可以随手传。
#[derive(Clone, Default)]
pub struct ChatPatrol {
    inner: Arc<PatrolInner>,
}

impl ChatPatrol {
    /* ————— 生命周期 ————— */

    /// 按设置里的总开关启停调度循环。**关掉即不存在**：不注册定时器、不后台唤醒。
    pub fn apply_enabled(&self, app: &AppHandle, enabled: bool) {
        if enabled {
            // 已开着就别重复起：先占位再起，避免两次并发 apply 起两个循环
            if self.inner.enabled.swap(true, Ordering::SeqCst) {
                return;
            }
            self.inner.stop.store(false, Ordering::SeqCst);
            let patrol = self.clone();
            let app_handle = app.clone();
            let handle = tauri::async_runtime::spawn(async move { patrol.run(app_handle).await });
            *lock(&self.inner.handle) = Some(handle);
            log_info!("[chat_patrol] 调度器已启动");
            return;
        }

        if !self.inner.enabled.swap(false, Ordering::SeqCst) {
            return;
        }
        self.inner.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = lock(&self.inner.handle).take() {
            handle.abort();
        }
        lock(&self.inner.active).clear();
        log_info!("[chat_patrol] 调度器已停止（总开关关闭）");
    }

    /// 用户显式点过「开始值守一片」= 明确意图：解除该环境被看门狗挂起的自动值守。
    pub fn clear_suspension(&self, profile_id: &str) {
        let mut health = lock(&self.inner.health);
        if let Some(entry) = health.get_mut(profile_id) {
            if entry.suspended || entry.consecutive_failures > 0 || entry.next_attempt_at.is_some() {
                log_info!("[chat_patrol] 用户手动恢复自动值守：profile={profile_id}");
            }
            entry.suspended = false;
            entry.reason = None;
            entry.consecutive_failures = 0;
            entry.next_attempt_at = None;
        }
    }

    /// 记下「这次是用户主动停的」：结算时不记失败。
    /// 只有**确实有片在跑**时才标记 —— 否则这个宽容标记会留到下一次真正的崩溃上。
    pub fn note_user_stop(&self, profile_id: &str) {
        if !lock(&self.inner.active).contains_key(profile_id) {
            return;
        }
        lock(&self.inner.user_stop).insert(profile_id.to_owned());
    }

    fn take_user_stop(&self, profile_id: &str) -> bool {
        lock(&self.inner.user_stop).remove(profile_id)
    }

    /// 是否 Pro（带 TTL 缓存：查 License 要联网，绝不能每 tick 都查）。
    async fn is_pro(&self, app: &AppHandle) -> Result<bool, AppError> {
        {
            let cache = lock(&self.inner.entitlement);
            if let Some((is_pro, fetched_at)) = *cache {
                if fetched_at.elapsed() < ENTITLEMENT_TTL {
                    return Ok(is_pro);
                }
            }
        }
        let db_state = app.state::<AppState>();
        let is_pro = crate::key_file::resolve_license_entitlement(&db_state)
            .await?
            .is_pro;
        *lock(&self.inner.entitlement) = Some((is_pro, Instant::now()));
        Ok(is_pro)
    }

    /// 实际生效的并发上限：与 Agent 同一口径（免费档恒 1，Pro 有硬顶）。
    /// 拿不到 License 状态时按**最保守的 1**（宁可少跑，也不开不受限通道）。
    async fn effective_parallel_cap(&self, app: &AppHandle, configured: u32) -> usize {
        match self.is_pro(app).await {
            Ok(is_pro) => parallel_cap(is_pro, configured),
            Err(error) => {
                log_warn!("[chat_patrol] License 状态读取失败，按最保守的 1 并发：{error}");
                1
            }
        }
    }

    /* ————— 主循环 ————— */

    async fn run(&self, app: AppHandle) {
        log_info!("[chat_patrol] 循环开始");
        loop {
            if self.inner.stop.load(Ordering::SeqCst) {
                log_info!("[chat_patrol] 循环退出");
                return;
            }
            let pending = self.tick(&app).await;
            // 自适应节拍；片结算会 `wake.notify` 打断睡眠，立刻续调度（连续值守）。
            let sleep = self.next_sleep(pending);
            tokio::select! {
                _ = tokio::time::sleep(sleep) => {}
                _ = self.inner.wake.notified() => {}
            }
        }
    }

    /// 下一次醒来前睡多久。
    fn next_sleep(&self, pending: usize) -> Duration {
        let active = lock(&self.inner.active).len();
        next_tick_delay(active, pending)
    }

    /// 跑一轮：对账 → 看门狗 → 调度。返回「现在就有事可做」的项数（决定下一拍睡多久）。
    async fn tick(&self, app: &AppHandle) -> usize {
        let settings = match read_launch_settings(app) {
            Ok(settings) => settings,
            Err(error) => {
                log_warn!("[chat_patrol] 读取聊天设置失败：{error}");
                return 0;
            }
        };
        if !settings.enabled {
            return 0;
        }

        self.reconcile(app);
        self.watchdog(app).await;
        let pending = self.schedule(app, &settings).await;

        pending
    }

    /// 对账：Host 侧还挂着记录、但该环境已经不忙了 → 这一片确实收工了（清理台账）。
    fn reconcile(&self, app: &AppHandle) {
        let manager = app.state::<RpaSessionManager>();
        let mut stale = Vec::new();
        {
            let active = lock(&self.inner.active);
            for (profile_id, record) in active.iter() {
                if record.started_at.elapsed() < SPAWN_GRACE {
                    continue;
                }
                if manager.is_engine_busy(profile_id) {
                    continue;
                }
                stale.push(profile_id.clone());
            }
        }
        if stale.is_empty() {
            return;
        }
        let mut active = lock(&self.inner.active);
        for profile_id in stale {
            active.remove(&profile_id);
        }
    }

    /// 看门狗分级恢复。
    ///
    /// T1 片超时（`budget + 宽限`）**或停滞**（相位不变 + `progressCounter` 不涨超过阈值，
    /// 且相位不在 `waiting / paused / handover` 豁免名单里）→ `chat_stop` 优雅中止；
    /// T2 优雅中止后仍不落地 → `stop_session` 重启该环境的执行进程（浏览器不动）；
    /// T3 连续失败到顶 → 挂起自动拉起并上报，等人工处理（不静默重试风暴）。
    async fn watchdog(&self, app: &AppHandle) {
        let manager = app.state::<RpaSessionManager>();
        struct Escalation {
            profile_id: String,
            level: u8,
            elapsed_secs: u64,
            /// 为什么被判超时：`overrun`（时间盒用尽）/ `stall`（相位与计数都不动）
            reason: &'static str,
            phase: Option<String>,
        }

        let mut escalations: Vec<Escalation> = Vec::new();
        {
            let mut active = lock(&self.inner.active);
            for (profile_id, record) in active.iter_mut() {
                let elapsed = record.started_at.elapsed();
                if record.stop_level == 0 {
                    // 先按「相位 + 单调计数」更新停滞时长（快照读不到就**不判**，不能凭空定罪）
                    let status = crate::chat_context::read_chat_runtime_status(app, profile_id)
                        .ok()
                        .flatten();
                    let phase = status.as_ref().map(|status| status.phase.clone());
                    if let Some(status) = status.as_ref() {
                        record.stagnated = stall_elapsed(
                            &record.progress_sample,
                            record.stagnated,
                            &ProgressSample {
                                phase: status.phase.clone(),
                                counter: status.progress_counter,
                            },
                            record.sampled_at.elapsed(),
                        );
                        record.progress_sample = ProgressSample {
                            phase: status.phase.clone(),
                            counter: status.progress_counter,
                        };
                        record.sampled_at = Instant::now();
                    }

                    if elapsed > record.budget + WATCHDOG_OVERRUN_GRACE {
                        escalations.push(Escalation {
                            profile_id: profile_id.clone(),
                            level: 1,
                            elapsed_secs: elapsed.as_secs(),
                            reason: "overrun",
                            phase,
                        });
                    } else if record.stagnated >= STALL_LIMIT {
                        escalations.push(Escalation {
                            profile_id: profile_id.clone(),
                            level: 1,
                            elapsed_secs: record.stagnated.as_secs(),
                            reason: "stall",
                            phase,
                        });
                    }
                    continue;
                }
                let stop_overdue = record
                    .stop_requested_at
                    .map(|at| at.elapsed() > WATCHDOG_STOP_GRACE)
                    .unwrap_or(false);
                if record.stop_level == 1 && stop_overdue && manager.is_engine_busy(profile_id) {
                    escalations.push(Escalation {
                        profile_id: profile_id.clone(),
                        level: 2,
                        elapsed_secs: elapsed.as_secs(),
                        reason: "stop_not_landed",
                        phase: None,
                    });
                }
            }
        }

        for escalation in escalations {
            if escalation.level == 1 {
                {
                    let mut active = lock(&self.inner.active);
                    if let Some(record) = active.get_mut(&escalation.profile_id) {
                        record.stop_level = 1;
                        record.stop_requested_at = Some(Instant::now());
                    }
                }
                if let Err(error) = manager.write_session_command(
                    &escalation.profile_id,
                    json!({
                        "command": "chat_stop",
                        "reason": if escalation.reason == "stall" {
                            "watchdog_stall"
                        } else {
                            "watchdog_overrun"
                        },
                    }),
                ) {
                    log_warn!(
                        "[chat_patrol] T1 优雅中止下发失败 profile={}: {error}",
                        escalation.profile_id
                    );
                }
                let detail = if escalation.reason == "stall" {
                    format!(
                        "值守片 {} 秒没有推进（相位 {} 一直没变），已请求优雅中止（看门狗 T1）",
                        escalation.elapsed_secs,
                        escalation.phase.as_deref().unwrap_or("未知"),
                    )
                } else {
                    "值守片超时未收工，已请求优雅中止（看门狗 T1）".to_owned()
                };
                emit_patrol(
                    app,
                    Some(&escalation.profile_id),
                    if escalation.reason == "stall" {
                        "chat_watchdog_stall"
                    } else {
                        "chat_watchdog_stop"
                    },
                    &detail,
                    json!({
                        "level": 1,
                        "reason": escalation.reason,
                        "elapsedSecs": escalation.elapsed_secs,
                        "phase": escalation.phase,
                    }),
                );
                continue;
            }

            // T2：优雅中止没生效 —— 重启该环境的执行进程。
            // `stop_session` 会唤醒所有挂起方，在途的片立刻以 aborted 结算（不会再假死 300s）。
            lock(&self.inner.active).remove(&escalation.profile_id);
            let restart_error = manager.stop_session(&escalation.profile_id).err();
            let detail = match &restart_error {
                Some(error) => format!("优雅中止未生效，重启执行进程也失败：{error}"),
                None => "优雅中止未生效，已重启该环境的执行进程（T2）".to_owned(),
            };
            log_warn!("[chat_patrol] {} profile={}", detail, escalation.profile_id);
            emit_patrol(
                app,
                Some(&escalation.profile_id),
                "chat_watchdog_restart",
                &detail,
                json!({ "level": 2, "elapsedSecs": escalation.elapsed_secs }),
            );
            self.record_failure(&escalation.profile_id, &detail);
        }
    }

    /// 把**到期**的环境拉起来：按席位轮转，多余的如实排队（禁止静默丢弃）。
    async fn schedule(&self, app: &AppHandle, settings: &LaunchSettings) -> usize {
        let manager = app.state::<RpaSessionManager>();
        let browser_manager = app.state::<crate::browser_manager::BrowserManager>();

        let env_ids = settings.candidate_env_ids(&browser_manager.running_profile_ids());
        let active_ids: std::collections::HashSet<String> = lock(&self.inner.active)
            .keys()
            .cloned()
            .collect();
        let facts: Vec<EnvFacts> = env_ids
            .iter()
            .map(|profile_id| {
                let runtime = crate::chat_context::read_chat_runtime_status(app, profile_id)
                    .ok()
                    .flatten();
                let (suspended, retry_in) = {
                    let health = lock(&self.inner.health);
                    match health.get(profile_id) {
                        Some(entry) => (
                            entry.suspended,
                            entry.next_attempt_at.map(|at| at.saturating_duration_since(Instant::now())),
                        ),
                        None => (false, None),
                    }
                };
                EnvFacts {
                    profile_id: profile_id.clone(),
                    browser_running: browser_manager.is_running(profile_id),
                    engine_busy: manager.is_engine_busy(profile_id),
                    chat_already_running: active_ids.contains(profile_id),
                    suspended,
                    retry_in,
                    next_wake_at_ms: runtime
                        .as_ref()
                        .and_then(|status| status.next_wake_at.as_deref())
                        .and_then(parse_iso_millis),
                }
            })
            .collect();

        let plan = plan_schedule(&facts, now_ms());
        let cap = self
            .effective_parallel_cap(app, settings.max_parallel)
            .await;
        let active_count = lock(&self.inner.active).len();
        let free = cap.saturating_sub(active_count);

        let mut launched = 0usize;
        for (index, profile_id) in plan.due.iter().enumerate() {
            if index >= free {
                break;
            }
            let Some((contacts, use_current_window)) = settings.slice_contacts(profile_id) else {
                continue;
            };
            if self.launch(app, settings, profile_id, contacts, use_current_window) {
                launched += 1;
            }
        }
        let queued = plan.due.len().saturating_sub(launched);

        let fingerprint = format!(
            "due={};queued={};blocked={};suspended={};active={}",
            plan.due.len(),
            queued,
            plan.blocked.len(),
            facts.iter().filter(|fact| fact.suspended).count(),
            active_count,
        );
        let pending = pending_work(plan.due.len(), &plan.blocked, imminent_count(&facts, now_ms()));
        if *lock(&self.inner.last_report) == Some(fingerprint.clone()) {
            return pending;
        }
        *lock(&self.inner.last_report) = Some(fingerprint);

        let blocked_labels: Vec<String> = plan
            .blocked
            .iter()
            .map(|(profile_id, blocker)| format!("#{profile_id} {}", blocker.label()))
            .collect();
        let text = if plan.due.is_empty() && plan.blocked.is_empty() {
            "聊天调度：暂无到期目标".to_owned()
        } else {
            format!(
                "聊天调度：到期 {} · 已拉起 {} · 排队 {} · 受阻 {}{}",
                plan.due.len(),
                launched,
                queued,
                blocked_labels.len(),
                if blocked_labels.is_empty() {
                    String::new()
                } else {
                    format!("（{}）", blocked_labels.join("；"))
                }
            )
        };
        emit_patrol(
            app,
            None,
            "chat_patrol_queue",
            &text,
            json!({
                "due": plan.due.len(),
                "launched": launched,
                "queued": queued,
                "capacity": cap,
                "active": active_count,
                "blocked": blocked_labels,
            }),
        );
        pending
    }

    /// 拉起一片：立刻登记台账（防重复拉起），任务结束后结算成败。
    fn launch(
        &self,
        app: &AppHandle,
        settings: &LaunchSettings,
        profile_id: &str,
        contacts: Vec<ChatContactInput>,
        use_current_window: bool,
    ) -> bool {
        let budget = Duration::from_millis(settings.slice_ms.unwrap_or(DEFAULT_SLICE_MS));
        {
            let mut active = lock(&self.inner.active);
            if active.contains_key(profile_id) {
                return false;
            }
            active.insert(
                profile_id.to_owned(),
                SliceRecord {
                    started_at: Instant::now(),
                    budget,
                    stop_level: 0,
                    stop_requested_at: None,
                    // 首个样本还没读到：`phase` 空 + 计数 0，读不到快照就永远不判停滞
                    progress_sample: ProgressSample::default(),
                    sampled_at: Instant::now(),
                    stagnated: Duration::ZERO,
                },
            );
        }

        let patrol = self.clone();
        let app_handle = app.clone();
        let profile_id_owned = profile_id.to_owned();
        let request = ChatSliceRequest {
            profile_id: profile_id_owned.clone(),
            goal: settings.goal.clone(),
            seeds: crate::rpa_session::normalize_chat_contacts(contacts),
            style_hint: settings.style_hint.clone(),
            banned_words: settings.banned_words.clone(),
            cadence: settings.cadence.clone(),
            pacing: settings.pacing.clone(),
            takeovers: settings.takeovers.clone(),
            contact_flags: settings.contact_flags.clone(),
            roles: settings.roles.clone(),
            active_role_id: settings.active_role_id.clone(),
            media_library_dir: settings.media_library_dir.clone(),
            slice_ms: settings.slice_ms,
            max_contacts_per_slice: settings.max_contacts_per_slice,
            use_current_window,
            task_rules: settings.task_rules.clone(),
            task_persona: settings.task_persona.clone(),
        };

        emit_patrol(
            &app_handle,
            Some(&profile_id_owned),
            "chat_patrol_launch",
            "调度器拉起一片值守",
            json!({ "sliceMs": budget.as_millis() as u64 }),
        );

        tauri::async_runtime::spawn(async move {
            let outcome = crate::rpa_session::run_chat_slice(&app_handle, request).await;
            patrol.settle(&app_handle, &profile_id_owned, outcome);
        });
        true
    }

    /// 结算一片：清台账 + 按**可核对的理由**记成败（不靠自述，也不靠字符串猜中文）。
    fn settle(
        &self,
        app: &AppHandle,
        profile_id: &str,
        outcome: Result<crate::rpa_session::RpaRunResult, AppError>,
    ) {
        lock(&self.inner.active).remove(profile_id);
        let user_stop = self.take_user_stop(profile_id);

        match outcome {
            Ok(result) => {
                let mut stop_reason = result
                    .actions
                    .as_ref()
                    .and_then(|value| {
                        value
                            .get("stopReason")
                            .or_else(|| value.get("stop_reason"))
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("")
                    .to_owned();
                // Sidecar 忙拒绝若只把「正忙」写在 msg 里、没带 stopReason，也必须算可原谅
                // （否则叠片被拒会被记成失败退避，视图出现「#3 失败退避中」吓人）。
                if stop_reason.is_empty()
                    && (result.msg.contains("正忙") || result.msg.contains("engine_busy"))
                {
                    stop_reason = "engine_busy".to_owned();
                }
                let hard = result.state == "failed"
                    || matches!(
                        stop_reason.as_str(),
                        "exception" | "start_failed" | "force_stopped" | "aborted"
                    );
                let excusable = user_stop
                    || matches!(
                        stop_reason.as_str(),
                        "browser_closed" | "seat_lost" | "engine_busy" | "no_targets"
                    );
                if excusable {
                    self.clear_failures(profile_id);
                } else if hard {
                    let reason = if stop_reason == "aborted" {
                        "值守片被中止且未落地（看门狗干预）".to_owned()
                    } else {
                        format!("值守片失败：{}", first_line(&result.msg, "引擎返回失败"))
                    };
                    self.record_failure(profile_id, &reason);
                } else {
                    self.clear_failures(profile_id);
                }
            }
            Err(error) => {
                // 闸门拒绝 / 会话超时：先确认不是「别人正占着」或「本环境聊天已在跑」
                // （正常竞争 / 不叠片 —— 不计失败、不吓人）。台账在 settle 开头已摘，
                // 这里认 Host 互斥忙即可。
                let manager = app.state::<RpaSessionManager>();
                let message = error.to_string();
                if manager.is_engine_busy(profile_id) {
                    log_info!(
                        "[chat_patrol] 跳过拉起（already_running / engine_busy，属正常排队）：{message}"
                    );
                    self.clear_failures(profile_id);
                } else {
                    self.record_failure(profile_id, &format!("拉起值守片失败：{message}"));
                }
            }
        }
        // 片已让位：立刻叫醒调度循环，按 `nextWakeAt` 续盯（不要干等到下一拍才发现「早就能拉」）
        self.inner.wake.notify_waiters();
    }

    fn clear_failures(&self, profile_id: &str) {
        let mut health = lock(&self.inner.health);
        if let Some(entry) = health.get_mut(profile_id) {
            if entry.consecutive_failures > 0 {
                log_info!("[chat_patrol] 值守恢复正常：profile={profile_id}");
            }
            entry.consecutive_failures = 0;
            entry.suspended = false;
            entry.reason = None;
            entry.last_error = None;
            entry.next_attempt_at = None;
        }
    }

    /// 记一次失败并退避；连续失败到顶则**挂起自动拉起**（超限即停，如实上报）。
    fn record_failure(&self, profile_id: &str, reason: &str) {
        let (failures, suspended) = {
            let mut health = lock(&self.inner.health);
            let entry = health.entry(profile_id.to_owned()).or_default();
            entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
            entry.last_error = Some(reason.to_owned());
            let backoff = RETRY_BACKOFF_BASE
                .saturating_mul(1u32 << entry.consecutive_failures.saturating_sub(1).min(3))
                .min(RETRY_BACKOFF_MAX);
            entry.next_attempt_at = Some(Instant::now() + backoff);
            let suspended = entry.consecutive_failures >= MAX_CONSECUTIVE_FAILURES;
            if suspended {
                entry.suspended = true;
                entry.reason = Some(format!(
                    "连续 {MAX_CONSECUTIVE_FAILURES} 次失败：{reason}（已停自动拉起，可在聊天视图手动恢复）"
                ));
            }
            (entry.consecutive_failures, suspended)
        };
        log_warn!(
            "[chat_patrol] profile={profile_id} 失败 {failures} 次：{reason}{}",
            if suspended { "（已挂起自动拉起）" } else { "" }
        );
    }

    /// 供视图读取的调度器快照（不产生副作用）。
    fn report(
        &self,
        app: &AppHandle,
        settings: &LaunchSettings,
        effective_cap: usize,
    ) -> ChatPatrolReport {
        let manager = app.state::<RpaSessionManager>();
        let browser_manager = app.state::<crate::browser_manager::BrowserManager>();

        let mut envs = Vec::new();
        let mut facts = Vec::new();
        let env_ids = settings.candidate_env_ids(&browser_manager.running_profile_ids());
        for profile_id in env_ids.iter() {
            // 只取**会被视图读到**的事实：连续失败数与退避秒数是调度器内部状态，
            // 没人读就不给它们造 DTO 字段（死字段只会让人以为有人在看）。
            let (suspended, reason, last_error, retry_in) = {
                let health = lock(&self.inner.health);
                match health.get(profile_id) {
                    Some(entry) => (
                        entry.suspended,
                        entry.reason.clone(),
                        entry.last_error.clone(),
                        entry
                            .next_attempt_at
                            .map(|at| at.saturating_duration_since(Instant::now())),
                    ),
                    None => (false, None, None, None),
                }
            };
            let runtime = crate::chat_context::read_chat_runtime_status(app, profile_id)
                .ok()
                .flatten();
            facts.push(EnvFacts {
                profile_id: profile_id.clone(),
                browser_running: browser_manager.is_running(profile_id),
                engine_busy: manager.is_engine_busy(profile_id),
                chat_already_running: lock(&self.inner.active).contains_key(profile_id),
                suspended,
                retry_in,
                next_wake_at_ms: runtime
                    .as_ref()
                    .and_then(|status| status.next_wake_at.as_deref())
                    .and_then(parse_iso_millis),
            });
            envs.push(ChatPatrolEnvReport {
                profile_id: profile_id.clone(),
                active: lock(&self.inner.active).contains_key(profile_id),
                suspended,
                reason,
                last_error,
            });
        }

        let plan = plan_schedule(&facts, now_ms());
        let active_count = lock(&self.inner.active).len();
        let queued = plan.due.len().saturating_sub(active_count);
        ChatPatrolReport {
            enabled: settings.enabled,
            parallel_cap: effective_cap,
            active_count,
            due_count: plan.due.len(),
            queued_count: queued,
            blocked_count: plan.blocked.len(),
            last_report: lock(&self.inner.last_report).clone(),
            dropped: Vec::new(),
            envs,
        }
    }
}

/* ————————————————————————— 纯逻辑（可单测） ————————————————————————— */

/// 到期判定的容差：调度 tick 是 60s，别因为几秒误差判成「没到期」。
const DUE_TOLERANCE_MS: i64 = 30_000;
/// 「马上要到期」的判定窗口：`nextWakeAt` 落在这个窗口内 → 提高节拍（见 [`pending_work`]）。
/// 必须 ≥ 短复环节拍（30s）+ 一次 tick 的富余，否则 30 秒的复查仍会被 60 秒节拍拖过去。
const IMMINENT_WAKE_MS: i64 = 60_000;

/// 「马上要到期」（`nextWakeAt` 在 [`IMMINENT_WAKE_MS`] 之内、但还没到）的项数。
///
/// 「从没跑过」（`None`）不算：那是 `plan_schedule` 里**立即到期**的那一类，已计入 `due`。
fn imminent_count(facts: &[EnvFacts], now: i64) -> usize {
    facts
        .iter()
        .filter(|fact| {
            fact.next_wake_at_ms
                .map(|due| due > now + DUE_TOLERANCE_MS && due <= now + IMMINENT_WAKE_MS)
                .unwrap_or(false)
        })
        .count()
}

/// 一次运行态取样：相位 + **单调**计数（`progressCounter`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ProgressSample {
    pub phase: String,
    pub counter: i64,
}

/// 这个相位是不是「本来就在等」——等时间到、等人回话、等人工接管。
/// 这类相位**不计入停滞**，否则正常的长等待会被看门狗杀掉。
pub(crate) fn is_waiting_phase(phase: &str) -> bool {
    matches!(phase, "waiting" | "paused" | "handover")
}

/// 累计停滞时长（纯函数，好单测）。
///
/// - 计数前进（或相位变了）→ **立刻清零**（推进了就说明还活着）；
/// - 相位在豁免名单里 → 不累加（`waiting / paused / handover` 本就在等）；
/// - 其余情况 → 在上次的基础上加「距上次取样的时长」。
pub(crate) fn stall_elapsed(
    previous: &ProgressSample,
    previous_stagnant: Duration,
    current: &ProgressSample,
    elapsed_since_sample: Duration,
) -> Duration {
    if current.counter != previous.counter || current.phase != previous.phase {
        return Duration::ZERO;
    }
    if is_waiting_phase(&current.phase) || is_waiting_phase(&previous.phase) {
        return previous_stagnant;
    }
    previous_stagnant.saturating_add(elapsed_since_sample)
}

/// 自适应节拍：有片在跑或马上有事可做 → 快节拍；全空闲才长睡。
pub(crate) fn next_tick_delay(active: usize, pending: usize) -> Duration {
    if active > 0 || pending > 0 {
        PATROL_TICK_ACTIVE
    } else {
        PATROL_TICK_IDLE
    }
}

/// 「现在就有事可做」的项数：到期要拉起的 + **被别人占着**（正忙 / 本环境已在值守）的 + **马上到期**的。
///
/// 其余受阻（未到点 / 浏览器没开 / 被挂起 / 退避中）都不是「马上要做」，
/// 快速重试没有意义 —— 它们要么由 `nextWakeAt` 驱动，要么等人工恢复。
///
/// 为什么把「马上到期」也算进来：对方回话后的短复查是 **30 秒**级的
/// （`cadence.ts::LIVE_REPLY_HOT_STEP_MS`），若还按 60 秒常规节拍睡，
/// 一条「30 秒后复查」会被拖到最多 90 秒才被拉起 —— 用户看到的就是「人回了它半天不理」。
fn pending_work(due: usize, blocked: &[(String, Blocker)], imminent: usize) -> usize {
    due + imminent
        + blocked
            .iter()
            .filter(|(_, blocker)| {
                matches!(blocker, Blocker::EngineBusy | Blocker::AlreadyRunning)
            })
            .count()
}

#[derive(Debug, Clone)]
struct EnvFacts {
    profile_id: String,
    browser_running: bool,
    engine_busy: bool,
    /// 本调度器台账里该环境已有一片在跑（勿叠片；安静排队）
    chat_already_running: bool,
    suspended: bool,
    retry_in: Option<Duration>,
    /// `None` = 从没跑过（用户已把目标写进设置 = 明确意图）→ 视为**立即到期**
    next_wake_at_ms: Option<i64>,
}

/// 被拒原因（**不静默丢弃**：每条都能在视图里看到）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Blocker {
    NoBrowser,
    EngineBusy,
    /// 本环境聊天值守片已在跑 —— 不是失败，安静排队等它让位
    AlreadyRunning,
    Suspended,
    Backoff,
    NotDue,
}

impl Blocker {
    /// 稳定代号（进指纹 / 测试断言用；人话在 [`Blocker::label`]）
    #[allow(dead_code)]
    fn code(self) -> &'static str {
        match self {
            Blocker::NoBrowser => "browser_not_running",
            Blocker::EngineBusy => "engine_busy",
            Blocker::AlreadyRunning => "already_running",
            Blocker::Suspended => "suspended",
            Blocker::Backoff => "retry_backoff",
            Blocker::NotDue => "not_due",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Blocker::NoBrowser => "浏览器未运行",
            Blocker::EngineBusy => "该环境正忙（Agent / 回放 / 填表）",
            Blocker::AlreadyRunning => "本环境聊天值守进行中（排队，不叠片）",
            Blocker::Suspended => "已被看门狗挂起自动拉起",
            Blocker::Backoff => "失败退避中",
            Blocker::NotDue => "未到回访时间",
        }
    }
}

#[derive(Debug, Default)]
struct SchedulePlan {
    /// 可拉起的 profileId（按到期时间升序，稳定次序 → 席位轮转可复现）
    due: Vec<String>,
    blocked: Vec<(String, Blocker)>,
}

fn plan_schedule(facts: &[EnvFacts], now: i64) -> SchedulePlan {
    let mut plan = SchedulePlan::default();
    for fact in facts {
        let blocker = if fact.suspended {
            Some(Blocker::Suspended)
        } else if fact
            .retry_in
            .map(|remaining| !remaining.is_zero())
            .unwrap_or(false)
        {
            Some(Blocker::Backoff)
        } else if !fact.browser_running {
            Some(Blocker::NoBrowser)
        } else if fact.chat_already_running {
            // 本环境聊天片已在跑：安静排队，不要再叠启动（P6）
            Some(Blocker::AlreadyRunning)
        } else if fact.engine_busy {
            Some(Blocker::EngineBusy)
        } else if fact
            .next_wake_at_ms
            .map(|due| due > now + DUE_TOLERANCE_MS)
            .unwrap_or(false)
        {
            Some(Blocker::NotDue)
        } else {
            None
        };
        match blocker {
            Some(blocker) => plan.blocked.push((fact.profile_id.clone(), blocker)),
            None => plan.due.push(fact.profile_id.clone()),
        }
    }
    plan.due.sort_by_key(|profile_id| {
        let due = facts
            .iter()
            .find(|fact| &fact.profile_id == profile_id)
            .and_then(|fact| fact.next_wake_at_ms)
            .unwrap_or(i64::MIN);
        (due, profile_id.clone())
    });
    plan.blocked.sort_by(|a, b| a.0.cmp(&b.0));
    plan
}

/// 并发席位口径：与 Agent 的 `resolveAgentMaxAllowed` 同一条纪律 ——
/// 免费档恒为 1；Pro 按用户配置但**仍有硬顶**（不为聊天开无限通道）。
fn parallel_cap(is_pro: bool, configured: u32) -> usize {
    if !is_pro {
        return 1;
    }
    configured.clamp(1, CHAT_PARALLEL_HARD_MAX) as usize
}

fn first_line(text: &str, fallback: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        fallback.to_owned()
    } else {
        line.chars().take(200).collect()
    }
}

/* ————————————————————————— 设置读取（只转发，不替用户判定） ————————————————————————— */

/// 调度拉起一片只需要这几个字段；其余一律交给 Sidecar 的权威解析器（避免两套默认值打架）。
#[derive(Debug, Default)]
struct LaunchSettings {
    enabled: bool,
    goal: String,
    style_hint: Option<String>,
    banned_words: Vec<String>,
    cadence: Option<Value>,
    /// 发送节奏护栏（原样转发；合法区间由 Sidecar 的权威解析器决定）
    pacing: Option<Value>,
    /// 人工优先：用户在设置里为**单个联系人**选定的模式（原样转发，Sidecar 权威解析）
    takeovers: Option<Value>,
    /// 每联系人开关（自动聊天；followUp 仅兼容转发）原样转发；缺省＝开的口径只在 Sidecar 一处
    contact_flags: Option<Value>,
    /// 聊天角色库（原样转发；合法性由 Sidecar 权威解析）
    roles: Option<Value>,
    /// 当前选用的角色 id（原样转发；空＝无角色）
    active_role_id: Option<String>,
    /// 自定义发图图库目录（原样转发；空＝软件自带）
    media_library_dir: Option<String>,
    slice_ms: Option<u64>,
    max_contacts_per_slice: Option<u32>,
    max_parallel: u32,
    targets: Vec<(String, Vec<ChatContactInput>)>,
    /// 「没指定对象 → 用**当前打开的**聊天窗口」。开了之后，**正在跑的浏览器**也会被纳入候选，
    /// 否则「没写目标的环境」永远不会被调度到（那用户就永远等不到）。
    use_current_window: bool,
    task_rules: Option<Value>,
    task_persona: Option<Value>,
    /// 被丢弃的目标（必须在视图可见，不许静默降级）
    dropped: Vec<String>,
}

impl LaunchSettings {
    fn from_value(value: &Value) -> Self {
        let mut targets: Vec<(String, Vec<ChatContactInput>)> = Vec::new();
        let mut dropped: Vec<String> = Vec::new();
        if let Some(map) = value.get("targetsByEnv").and_then(Value::as_object) {
            for (profile_id, rows) in map {
                let profile_id = profile_id.trim();
                if profile_id.is_empty() {
                    continue;
                }
                let Some(rows) = rows.as_array() else {
                    dropped.push(format!("环境 #{profile_id} 的目标不是列表，已忽略"));
                    continue;
                };
                let mut contacts = Vec::new();
                for row in rows {
                    match serde_json::from_value::<ChatContactInput>(row.clone()) {
                        Ok(contact) => contacts.push(contact),
                        Err(error) => {
                            dropped.push(format!("环境 #{profile_id} 有目标无法解析：{error}"))
                        }
                    }
                }
                if !contacts.is_empty() {
                    targets.push((profile_id.to_owned(), contacts));
                }
            }
        }
        targets.sort_by(|a, b| a.0.cmp(&b.0));
        Self {
            enabled: value.get("enabled").and_then(truthy).unwrap_or(false),
            goal: str_value(value, "goal").unwrap_or_default(),
            style_hint: str_value(value, "styleHint"),
            banned_words: value
                .get("bannedWords")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            cadence: value.get("cadence").filter(|entry| entry.is_object()).cloned(),
            pacing: value.get("pacing").filter(|entry| entry.is_object()).cloned(),
            takeovers: value.get("takeovers").filter(|entry| entry.is_object()).cloned(),
            contact_flags: value.get("contactFlags").filter(|entry| entry.is_object()).cloned(),
            roles: value.get("roles").filter(|entry| entry.is_array()).cloned(),
            active_role_id: str_value(value, "activeRoleId"),
            media_library_dir: str_value(value, "mediaLibraryDir"),
            slice_ms: u64_value(value, "sliceMs").map(|entry| {
                entry.clamp(
                    crate::rpa_session::CHAT_SLICE_MIN_MS,
                    crate::rpa_session::CHAT_SLICE_MAX_MS,
                )
            }),
            max_contacts_per_slice: u64_value(value, "maxContactsPerSlice")
                .map(|entry| entry.clamp(1, 50) as u32),
            max_parallel: u64_value(value, "maxParallelSlices")
                .map(|entry| entry as u32)
                .unwrap_or(1)
                .clamp(1, CHAT_PARALLEL_HARD_MAX),
            // 默认开：与设置「聊天 → 聊天对象」的默认口径一致（前端 `useCurrentWindow: true`）。
            // 这里若默认 false，就成了「设置里显示开、自动值守按关跑」的第二套口径（§0.5.3 C）。
            use_current_window: value
                .get("useCurrentWindow")
                .and_then(truthy)
                .unwrap_or(true),
            task_rules: value.get("taskRules").filter(|entry| entry.is_array()).cloned(),
            task_persona: value.get("taskPersona").filter(|entry| entry.is_object()).cloned(),
            targets,
            dropped,
        }
    }

    fn contacts_for(&self, profile_id: &str) -> Option<Vec<ChatContactInput>> {
        self.targets
            .iter()
            .find(|(candidate, _)| candidate == profile_id)
            .map(|(_, contacts)| contacts.clone())
    }

    /// 本片要聊的对象 + 是否走「用当前打开的窗口」。
    ///
    /// 优先级：显式目标 > （开了开关时）空名单 + 当前窗口；两者都没有 → `None`（不启动）。
    fn slice_contacts(&self, profile_id: &str) -> Option<(Vec<ChatContactInput>, bool)> {
        if let Some(contacts) = self.contacts_for(profile_id) {
            return Some((contacts, false));
        }
        if self.use_current_window {
            return Some((Vec::new(), true));
        }
        None
    }

    /// 候选环境 = 显式写了目标的环境 ∪（开了「用当前窗口」时）所有正在跑的环境。
    fn candidate_env_ids(&self, running: &[String]) -> Vec<String> {
        let mut ids: Vec<String> = self.targets.iter().map(|(id, _)| id.clone()).collect();
        if self.use_current_window {
            for id in running {
                if !ids.iter().any(|candidate| candidate == id) {
                    ids.push(id.clone());
                }
            }
        }
        ids.sort();
        ids
    }
}

fn read_launch_settings(app: &AppHandle) -> Result<LaunchSettings, AppError> {
    let db_state = app.state::<AppState>();
    let raw = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        db::get_setting(&connection, KEY_CHAT_MODE)?.unwrap_or_default()
    };
    let value = serde_json::from_str::<Value>(raw.trim()).unwrap_or(Value::Null);
    Ok(LaunchSettings::from_value(&value))
}

/// 只读总开关。**唯一**的总开关解析口：启动路径、命令路径、调度器都走这里
/// （避免「前端写一套、Rust 再各读一套」的口径分裂，§0.5.3 F）。
pub fn chat_mode_enabled(app: &AppHandle) -> Result<bool, AppError> {
    Ok(read_launch_settings(app)?.enabled)
}

/// 三态读取布尔：**只有真正的 `true` / `false` 才表态**，其余一律 `None`（交给调用方用默认值）。
///
/// 旧实现把字符串/数字都「归一化」成布尔（`"1"` / `"yes"` → 真，其它 → 假）。听起来保守，
/// 但它让**拼错的值静默表达了一个态度**：`useCurrentWindow: "flase"` 会被读成「关」，
/// 于是「设置里显示开、自动值守按关跑」，而设置里根本看不出哪里错了（§0.5.3 C）。
/// 现在只有真正的布尔能表态，别的值一律回落到默认口径。
fn truthy(value: &Value) -> Option<bool> {
    value.as_bool()
}

fn str_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn u64_value(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn emit_patrol(
    app: &AppHandle,
    profile_id: Option<&str>,
    kind: &str,
    message: &str,
    extra: Value,
) {
    let mut payload = json!({ "kind": kind, "msg": message, "source": "host_patrol" });
    if let Some(profile_id) = profile_id {
        payload["profileId"] = json!(profile_id);
    }
    if let Some(object) = extra.as_object() {
        for (key, value) in object {
            payload[key] = value.clone();
        }
    }
    // 走**同一条** `chat-state` 事件（B8 / §5.7）：视图只需一个订阅，
    // 但调度器发的是 Host 事实，绝不冒充 Sidecar 的进度行。
    let _ = app.emit(CHAT_STATE_EVENT, payload.clone());
    crate::rpa_session::enqueue_chat_patrol_log(app, profile_id.unwrap_or(""), &payload);
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis() as i64)
        .unwrap_or(0)
}

/// 解析 JS `toISOString()` 形态的时间（`2026-09-26T14:26:00.000Z`，含 `±HH:MM` 偏移）。
///
/// 只做这一件事：调度器要拿它跟「现在」比大小 —— **不引入时区库，也不猜格式**，
/// 看不懂就返回 `None`（调用方按「从没跑过」处理，宁可早唤醒一次也不锁死）。
fn parse_iso_millis(raw: &str) -> Option<i64> {
    let text = raw.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut rest = text.get(19..)?.trim();
    let mut millis: i64 = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits: String = fraction.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        let padded = format!("{digits:0<3}");
        millis = padded.get(0..3)?.parse().ok()?;
        rest = &fraction[digits.len()..];
    }
    let rest = rest.trim();
    let offset_minutes: i64 = if rest.is_empty() || rest.eq_ignore_ascii_case("z") {
        0
    } else {
        let sign = match rest.as_bytes().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let body = rest.get(1..)?;
        let (hours, minutes) = match body.split_once(':') {
            Some((hours, minutes)) => (hours.parse::<i64>().ok()?, minutes.parse::<i64>().ok()?),
            None if body.len() == 4 => (
                body.get(0..2)?.parse::<i64>().ok()?,
                body.get(2..4)?.parse::<i64>().ok()?,
            ),
            None if body.len() == 2 => (body.parse::<i64>().ok()?, 0),
            None => return None,
        };
        sign * (hours * 60 + minutes)
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

/// Howard Hinnant 的 days_from_civil（1970-01-01 起的天数；对闰年 / 世纪年都正确）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/* ————————————————————————— 视图读取 ————————————————————————— */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPatrolEnvReport {
    pub profile_id: String,
    pub active: bool,
    pub suspended: bool,
    pub reason: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPatrolReport {
    pub enabled: bool,
    pub parallel_cap: usize,
    pub active_count: usize,
    pub due_count: usize,
    pub queued_count: usize,
    pub blocked_count: usize,
    pub last_report: Option<String>,
    /// 被丢弃的目标（**先说后跑**：配置有问题要让用户看见）
    pub dropped: Vec<String>,
    pub envs: Vec<ChatPatrolEnvReport>,
}

/// 视图读取调度器状态（含被挂起的自动值守，供「恢复」按钮使用）。
#[tauri::command]
pub async fn chat_patrol_state(
    app: AppHandle,
    patrol: tauri::State<'_, ChatPatrol>,
) -> Result<ChatPatrolReport, AppError> {
    let patrol = patrol.inner().clone();
    let settings = read_launch_settings(&app)?;
    let effective_cap = patrol
        .effective_parallel_cap(&app, settings.max_parallel)
        .await;
    let mut report = patrol.report(&app, &settings, effective_cap);
    report.dropped = settings.dropped;
    Ok(report)
}

/// 人工恢复某环境被挂起的自动值守（用户明确点「恢复」= 明确意图）。
#[tauri::command]
pub async fn chat_patrol_resume(
    app: AppHandle,
    patrol: tauri::State<'_, ChatPatrol>,
    profile_id: String,
) -> Result<ChatPatrolReport, AppError> {
    crate::profile_id::parse_profile_id(&profile_id)?;
    let patrol = patrol.inner().clone();
    patrol.clear_suspension(&profile_id);
    let settings = read_launch_settings(&app)?;
    let effective_cap = patrol
        .effective_parallel_cap(&app, settings.max_parallel)
        .await;
    let mut report = patrol.report(&app, &settings, effective_cap);
    report.dropped = settings.dropped;
    let _ = app.emit(
        CHAT_STATE_EVENT,
        json!({
            "profileId": profile_id,
            "kind": "chat_patrol_resumed",
            "msg": "已恢复该环境的自动值守",
            "source": "host_patrol",
        }),
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(rows: &[(&str, bool, bool, bool, &str)]) -> Vec<EnvFacts> {
        rows.iter()
            .map(|(profile_id, browser_running, engine_busy, suspended, next_wake_at)| EnvFacts {
                profile_id: (*profile_id).to_owned(),
                browser_running: *browser_running,
                engine_busy: *engine_busy,
                chat_already_running: false,
                suspended: *suspended,
                retry_in: None,
                next_wake_at_ms: if next_wake_at.is_empty() {
                    None
                } else {
                    parse_iso_millis(next_wake_at)
                },
            })
            .collect()
    }

    #[test]
    fn parses_js_iso_timestamps() {
        assert_eq!(parse_iso_millis("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_millis("2026-09-26T14:26:00.000Z"),
            Some(1_790_432_760_000)
        );
        // 无毫秒 / 无 Z 也认
        assert_eq!(
            parse_iso_millis("2026-09-26T14:26:00"),
            Some(1_790_432_760_000)
        );
        // 时区偏移必须被折成 UTC
        assert_eq!(
            parse_iso_millis("2026-09-26T22:26:00+08:00"),
            Some(1_790_432_760_000)
        );
        // 闰日
        assert_eq!(
            parse_iso_millis("2024-02-29T00:00:00.000Z"),
            Some(1_709_164_800_000)
        );
    }

    #[test]
    fn rejects_garbage_timestamps() {
        assert_eq!(parse_iso_millis(""), None);
        assert_eq!(parse_iso_millis("not-a-time"), None);
        assert_eq!(parse_iso_millis("2026-13-01T00:00:00.000Z"), None);
        assert_eq!(parse_iso_millis("2026-09-26T25:00:00.000Z"), None);
    }

    #[test]
    fn free_tier_is_capped_at_one_and_pro_has_a_hard_ceiling() {
        assert_eq!(parallel_cap(false, 8), 1);
        assert_eq!(parallel_cap(true, 1), 1);
        assert_eq!(parallel_cap(true, 3), 3);
        assert_eq!(parallel_cap(true, 99), CHAT_PARALLEL_HARD_MAX as usize);
        assert_eq!(parallel_cap(true, 0), 1);
    }

    #[test]
    fn never_ran_environment_is_due_immediately() {
        let rows = facts(&[("1", true, false, false, "")]);
        let plan = plan_schedule(&rows, 1_790_000_000_000);
        assert_eq!(plan.due, vec!["1".to_owned()]);
        assert!(plan.blocked.is_empty());
    }

    #[test]
    fn blockers_are_reported_never_silently_dropped() {
        let rows = facts(&[
            ("1", false, false, false, ""),
            ("2", true, true, false, ""),
            ("3", true, false, true, ""),
            ("4", true, false, false, "2030-01-01T00:00:00.000Z"),
        ]);
        let plan = plan_schedule(&rows, 1_790_000_000_000);
        assert!(plan.due.is_empty());
        let by_id: HashMap<&str, Blocker> = plan
            .blocked
            .iter()
            .map(|(profile_id, blocker)| (profile_id.as_str(), *blocker))
            .collect();
        assert_eq!(by_id["1"], Blocker::NoBrowser);
        assert_eq!(by_id["2"], Blocker::EngineBusy);
        assert_eq!(by_id["3"], Blocker::Suspended);
        assert_eq!(by_id["4"], Blocker::NotDue);
        assert_eq!(by_id["1"].code(), "browser_not_running");
    }

    #[test]
    fn already_running_blocks_quietly_without_stacking() {
        let mut rows = facts(&[("7", true, false, false, "")]);
        rows[0].chat_already_running = true;
        let plan = plan_schedule(&rows, 1_790_000_000_000);
        assert!(plan.due.is_empty());
        assert_eq!(plan.blocked.len(), 1);
        assert_eq!(plan.blocked[0].1, Blocker::AlreadyRunning);
        assert_eq!(plan.blocked[0].1.code(), "already_running");
        // already_running 也算 pending（要勤看等它让位），但不吓人
        assert_eq!(pending_work(0, &plan.blocked, 0), 1);
        // 若同时标了 engine_busy，仍以 already_running 优先（本环境聊天片）
        rows[0].engine_busy = true;
        let plan2 = plan_schedule(&rows, 1_790_000_000_000);
        assert_eq!(plan2.blocked[0].1, Blocker::AlreadyRunning);
    }

    #[test]
    fn backoff_wins_over_due_time() {
        let mut rows = facts(&[("1", true, false, false, "")]);
        rows[0].retry_in = Some(Duration::from_secs(120));
        let plan = plan_schedule(&rows, 1_790_000_000_000);
        assert!(plan.due.is_empty());
        assert_eq!(plan.blocked[0].1, Blocker::Backoff);
    }

    #[test]
    fn due_is_ordered_by_deadline_then_id() {
        let now = parse_iso_millis("2026-09-26T14:26:00.000Z").unwrap();
        let rows = facts(&[
            ("9", true, false, false, "2026-09-25T00:00:00.000Z"),
            ("3", true, false, false, "2026-09-20T00:00:00.000Z"),
            ("7", true, false, false, "2026-09-25T00:00:00.000Z"),
            ("1", true, false, false, ""),
        ]);
        let plan = plan_schedule(&rows, now);
        assert_eq!(
            plan.due,
            vec![
                "1".to_owned(),
                "3".to_owned(),
                "7".to_owned(),
                "9".to_owned()
            ]
        );
    }

    #[test]
    fn launch_settings_reads_forwarded_fields_only() {
        let value = json!({
            "enabled": true,
            "goal": "  约看展  ",
            "styleHint": "轻松",
            "bannedWords": [" 借钱 ", "", "广告"],
            "sliceMs": 9_999_999,
            "maxContactsPerSlice": 0,
            "maxParallelSlices": 99,
            "cadence": { "followUpHours": 48 },
            "contactFlags": { "wa|Anne": { "autoReply": false, "followUp": true } },
            "roles": [{ "id": "r1", "name": "顾问", "prompt": "简短专业" }],
            "activeRoleId": "r1",
            "mediaLibraryDir": "  D:\\\\Photos\\\\chat_media  ",
            "targetsByEnv": {
                "7": [{ "label": "小明", "url": "" }],
                "8": [{ "label": "小红" }, "garbage"]
            }
        });
        let settings = LaunchSettings::from_value(&value);
        assert!(settings.enabled);
        assert_eq!(settings.goal, "约看展");
        assert_eq!(settings.style_hint.as_deref(), Some("轻松"));
        assert_eq!(settings.banned_words, vec!["借钱", "广告"]);
        // 夹到合法区间：**不静默丢弃**，但也不接受越界值（上限 30 分钟）
        assert_eq!(settings.slice_ms, Some(crate::rpa_session::CHAT_SLICE_MAX_MS));
        assert_eq!(settings.max_contacts_per_slice, Some(1));
        assert_eq!(settings.max_parallel, CHAT_PARALLEL_HARD_MAX);
        assert!(settings.cadence.is_some());
        assert_eq!(settings.active_role_id.as_deref(), Some("r1"));
        assert_eq!(
            settings.media_library_dir.as_deref(),
            Some(r"D:\\Photos\\chat_media")
        );
        assert_eq!(
            settings
                .roles
                .as_ref()
                .and_then(|roles| roles.pointer("/0/name"))
                .and_then(Value::as_str),
            Some("顾问")
        );
        // 每联系人开关只做「是不是对象」的转发判断，内容原样交给 Sidecar 的权威解析器
        assert_eq!(
            settings
                .contact_flags
                .as_ref()
                .and_then(|flags| flags.pointer("/wa|Anne/autoReply"))
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(settings.targets.len(), 2);
        assert_eq!(settings.contacts_for("7").unwrap()[0].label, "小明");
        // 坏目标必须进 dropped（供视图展示），不能装作没发生
        assert_eq!(settings.dropped.len(), 1);
    }

    #[test]
    fn launch_settings_defaults_are_closed() {
        let settings = LaunchSettings::from_value(&Value::Null);
        assert!(!settings.enabled);
        assert!(settings.targets.is_empty());
        assert_eq!(settings.max_parallel, 1);
        assert!(settings.slice_ms.is_none());
        // 默认开「用当前窗口」：这是设置面板的默认值（§3.5「聊天对象」默认开），
        // 宿主若按关跑，用户会看到「设置里是开的、自动值守却不生效」。
        // 它只在**没有显式目标**时生效，且引擎只认「已开着且判定为聊天页」的标签。
        assert!(settings.use_current_window);
    }

    /// 只有真正的布尔能表态：拼错的值**回落默认**，而不是静默变成「关」（§0.5.3 C）。
    ///
    /// 现场：`useCurrentWindow` 默认开，若把 `"flase"` 这类值读成「关」，就会同时出现
    /// 「设置里显示开」与「自动值守按关跑」两个口径 —— 用户完全看不出哪里错了。
    #[test]
    fn booleans_need_a_real_boolean() {
        assert_eq!(truthy(&json!(true)), Some(true));
        assert_eq!(truthy(&json!(false)), Some(false));
        for malformed in [json!("true"), json!("false"), json!(1), json!(0), json!(null)] {
            assert_eq!(truthy(&malformed), None, "非真正布尔一律不表态：{malformed}");
        }

        // 拼错 → 回落默认（开），而不是变成关
        let typo = json!({ "useCurrentWindow": "flase" });
        assert!(LaunchSettings::from_value(&typo).use_current_window);
        // 明确写 false → 按 false
        let off = json!({ "useCurrentWindow": false });
        assert!(!LaunchSettings::from_value(&off).use_current_window);
        // 总开关同理：拼错 → 默认关（保守侧），真 true 才是开
        assert!(!LaunchSettings::from_value(&json!({ "enabled": "yes" })).enabled);
        assert!(LaunchSettings::from_value(&json!({ "enabled": true })).enabled);
    }

    #[test]
    fn current_window_covers_environments_without_targets() {
        let value = json!({
            "enabled": true,
            "useCurrentWindow": true,
            "targetsByEnv": { "7": [{ "label": "小明", "url": "" }] }
        });
        let settings = LaunchSettings::from_value(&value);
        assert!(settings.use_current_window);

        // 有显式目标 → 用目标，且**不带**当前窗口标志（不绑到用户标签上）
        let (contacts, uses_window) = settings.slice_contacts("7").expect("显式目标");
        assert_eq!(contacts.len(), 1);
        assert!(!uses_window);

        // 没有目标但在跑 → 空名单 + 当前窗口（由 Sidecar 运行期判定那确实是聊天页）
        let (contacts, uses_window) = settings.slice_contacts("9").expect("当前窗口");
        assert!(contacts.is_empty());
        assert!(uses_window);

        // 候选环境 = 写了目标的 ∪ 正在跑的
        let ids = settings.candidate_env_ids(&["9".to_owned(), "12".to_owned()]);
        assert_eq!(ids, vec!["12".to_owned(), "7".to_owned(), "9".to_owned()]);
    }

    #[test]
    fn closed_switch_refuses_targetless_environments() {
        let value = json!({
            "enabled": true,
            "useCurrentWindow": false,
            "targetsByEnv": { "7": [{ "label": "小明", "url": "" }] }
        });
        let settings = LaunchSettings::from_value(&value);
        // 关掉后：没有目标的环境不会被拉起（不会悄悄去绑用户的标签）
        assert!(settings.slice_contacts("9").is_none());
        assert_eq!(settings.candidate_env_ids(&["9".to_owned()]), vec!["7".to_owned()]);
    }

    /* ————— 看门狗停滞判定：读相位 + 单调计数，等待相位不计时 ————— */

    fn sample(phase: &str, counter: i64) -> ProgressSample {
        ProgressSample {
            phase: phase.to_owned(),
            counter,
        }
    }

    #[test]
    fn progress_resets_the_stall_clock() {
        let previous = sample("sending", 7);
        // 计数前进 → 立刻清零（慢也要能看到「在动」）
        assert_eq!(
            stall_elapsed(
                &previous,
                Duration::from_secs(280),
                &sample("sending", 8),
                Duration::from_secs(20),
            ),
            Duration::ZERO
        );
        // 相位变化也算推进（换阶段本身就是进展）
        assert_eq!(
            stall_elapsed(
                &previous,
                Duration::from_secs(280),
                &sample("reading", 7),
                Duration::from_secs(20),
            ),
            Duration::ZERO
        );
    }

    #[test]
    fn waiting_phases_are_never_counted_as_stalled() {
        // 在 `waiting` 里等一整天也是正常的（等回访时间到 / 等人工接管），不许被看门狗杀掉
        let mut stagnant = Duration::ZERO;
        for _ in 0..10 {
            stagnant = stall_elapsed(
                &sample("waiting", 3),
                stagnant,
                &sample("waiting", 3),
                Duration::from_secs(20),
            );
        }
        assert_eq!(stagnant, Duration::ZERO);

        // paused / handover 同理
        assert_eq!(
            stall_elapsed(
                &sample("handover", 1),
                Duration::from_secs(600),
                &sample("handover", 1),
                Duration::from_secs(20),
            ),
            Duration::from_secs(600)
        );
    }

    #[test]
    fn unchanged_phase_and_counter_accumulates_until_the_limit() {
        let mut stagnant = Duration::ZERO;
        let mut ticks = 0;
        while stagnant < STALL_LIMIT {
            stagnant = stall_elapsed(
                &sample("thinking", 4),
                stagnant,
                &sample("thinking", 4),
                PATROL_TICK_ACTIVE,
            );
            ticks += 1;
            assert!(ticks < 100, "必须收敛（否则就是恒不为停的死循环）");
        }
        // 20s 一拍 → 300s 阈值在 15 拍后触发
        assert_eq!(ticks, 15);
    }

    #[test]
    fn backsliding_counter_still_counts_as_progress() {
        // 进程重启后计数会从头来 —— 变小也是「有动静」，不是「卡住」
        assert_eq!(
            stall_elapsed(
                &sample("thinking", 9),
                Duration::from_secs(120),
                &sample("thinking", 0),
                Duration::from_secs(20),
            ),
            Duration::ZERO
        );
    }

    /* ————— 自适应睡眠 ————— */

    #[test]
    fn tick_is_fast_while_a_slice_runs_and_idle_when_nothing_is_due() {
        // 有片在跑 → 快节拍（看门狗及时发现「卡住」，而不是等到超时）
        assert_eq!(next_tick_delay(1, 0), PATROL_TICK_ACTIVE);
        // 有到期 / 正忙要等它让位 → **同样快节拍**（连续值守短复查是秒级）
        assert_eq!(next_tick_delay(0, 1), PATROL_TICK_ACTIVE);
        // 全空闲 → 长节拍（禁止空转）
        assert_eq!(next_tick_delay(0, 0), PATROL_TICK_IDLE);
        assert!(PATROL_TICK_ACTIVE < PATROL_TICK);
        assert!(PATROL_TICK < PATROL_TICK_IDLE);
    }

    #[test]
    fn pending_work_only_counts_actionable_blockers() {
        let blocked = vec![
            ("2".to_owned(), Blocker::EngineBusy),
            ("3".to_owned(), Blocker::NotDue),
            ("4".to_owned(), Blocker::Suspended),
            ("5".to_owned(), Blocker::NoBrowser),
            ("6".to_owned(), Blocker::Backoff),
        ];
        // 「别人正占着」马上就会让位 → 要勤看；其余都要等外部条件，勤看纯属空转
        assert_eq!(pending_work(0, &blocked, 0), 1);
        assert_eq!(pending_work(2, &blocked, 0), 3);
        assert_eq!(pending_work(0, &[], 0), 0);
        // 「马上到期」（对方刚回话、30 秒后复查）也算「马上要做」→ 提高节拍
        assert_eq!(pending_work(0, &blocked, 2), 3);
    }

    #[test]
    fn imminent_wakes_exclude_due_and_far_future() {
        let now = parse_iso_millis("2026-09-26T14:26:00.000Z").unwrap();
        let fact = |offset_ms: i64| EnvFacts {
            profile_id: "1".to_owned(),
            browser_running: true,
            engine_busy: false,
            chat_already_running: false,
            suspended: false,
            retry_in: None,
            next_wake_at_ms: Some(now + offset_ms),
        };
        // 已经到期（在容差内）→ 由 `due` 计数（`plan_schedule` 会立刻拉起），不重复算
        assert_eq!(imminent_count(&[fact(30_000)], now), 0);
        // 45 秒后的短复查 → 落在「马上到期」窗口 → 提高节拍（否则 60 秒 tick 会把它拖过点）
        assert_eq!(imminent_count(&[fact(45_000)], now), 1);
        // 一小时后的回访 → 按常规/长节拍睡，勤看纯属空转
        assert_eq!(imminent_count(&[fact(3_600_000)], now), 0);
        // 从没跑过 → 属于 `due`，不算 imminent
        let mut never = fact(0);
        never.next_wake_at_ms = None;
        assert_eq!(imminent_count(&[never], now), 0);
        assert_eq!(imminent_count(&[fact(45_000), fact(3_600_000)], now), 1);
    }
}
