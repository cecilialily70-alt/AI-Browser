//! 数据库单写队列（Milestone 1 + 3 + Phase 1 背压）
//!
//! 背景：多开环境下，若允许 Node Sidecar 或前端并发直写 SQLite，
//! 即便已开启 WAL，极端情况下仍可能出现 "database is locked"。
//! 本模块把所有写操作收归到**单个后台线程**串行执行，
//! 通过 `tokio::sync::mpsc` **有界**通道接收写命令，保证「单线程统筹写入」+ 背压防 OOM。
//!
//! 优雅退出：`shutdown()` 先置位拒绝新命令，再发送 `Shutdown` 哨兵，
//! 后台线程按 FIFO 顺序执行完所有存量命令后才退出，`join()` 确保
//! 进程结束前队列中的上报数据不丢失。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{channel, Sender};
use tokio::sync::oneshot;

use crate::db;
use crate::error::AppError;
use crate::{log_error, log_warn};

/// 有界队列容量：高频轨迹上报时触发背压，防止无限制膨胀导致 OOM。
const DB_WRITE_QUEUE_CAPACITY: usize = 10_000;

/// 单条写库命令。
///
/// 注意：Milestone 3 的「环境核心人设落盘」已下线（用户人设改由「规则」窗口维护），
/// DB 列 `profiles.persona_data` 保留为 INFO 残留、不再有写入方 —— 本枚举因此没有
/// `SetProfilePersonaData` 变体，这是**有意**的，不是漏写。
pub enum DbWriteCommand {
    SaveAgentTrajectory {
        domain: String,
        title: String,
        goal: String,
        start_url: String,
        actions: String,
        /// 回传落库后生成的 id（调用方可 await / blocking_recv 取得）
        reply: Option<oneshot::Sender<Result<i64, String>>>,
        /// P4.3：关联 Agent Run（可选）
        run_id: Option<String>,
    },
    /// P4.3：Agent Run 启动行
    UpsertAgentRunStart {
        run_id: String,
        profile_id: String,
        goal: String,
        start_url: String,
        domain: String,
        reply: Option<oneshot::Sender<Result<i64, String>>>,
    },
    /// P4.3：Agent Run 结束摘要
    FinishAgentRun {
        run_id: String,
        profile_id: String,
        goal: String,
        start_url: String,
        domain: String,
        status: String,
        success: Option<bool>,
        summary: String,
        step_count: i64,
        hitl_occurred: bool,
        trajectory_id: Option<i64>,
        thought_summary: String,
        stats: crate::models::AgentRunFinishStats,
        reply: Option<oneshot::Sender<Result<i64, String>>>,
    },
    UpsertAgentControlMemory {
        domain: String,
        intent: String,
        intent_key: String,
        kind: String,
        selector: String,
        text_hint: String,
        x_percent: Option<f64>,
        y_percent: Option<f64>,
        hit_count: Option<i64>,
    },
    /// 优雅退出的哨兵命令（不是人设写入；见枚举上方关于 persona_data 下线的说明）。
    Shutdown,
}

/// 单写队列：持有发送端与后台写线程句柄，支持优雅排空。
pub struct DbWriteQueue {
    sender: Sender<DbWriteCommand>,
    handle: Mutex<Option<std::thread::JoinHandle<()>>>,
    shutting_down: AtomicBool,
}

impl DbWriteQueue {
    /// 创建队列并启动后台写线程（线程创建失败按 AppError 返回，不使用 unwrap/expect）。
    pub fn new(connection: Arc<Mutex<Connection>>) -> Result<Self, AppError> {
        let (sender, mut receiver) = channel::<DbWriteCommand>(DB_WRITE_QUEUE_CAPACITY);
        let handle = std::thread::Builder::new()
            .name("ai-browser-db-writer".to_owned())
            .spawn(move || {
                // 后台写线程：串行消费命令，遇 Shutdown 哨兵才退出。
                while let Some(command) = receiver.blocking_recv() {
                    match command {
                        DbWriteCommand::Shutdown => break,
                        command => execute_write(&connection, command),
                    }
                }
            })
            .map_err(|error| {
                AppError::State(format!("failed to spawn db writer thread: {error}"))
            })?;

        Ok(Self {
            sender,
            handle: Mutex::new(Some(handle)),
            shutting_down: AtomicBool::new(false),
        })
    }

    /// 供本地 IPC 服务 / 其他模块克隆使用的发送端。
    pub fn sender(&self) -> Sender<DbWriteCommand> {
        self.sender.clone()
    }

    /// 非阻塞入队（`try_send`）；队列满时按指令优先级降级，绝不 Panic / 阻塞调用方。
    /// - 核心（`Shutdown`）：记严重错误并 `Err`
    /// - 非核心（轨迹 / 控件记忆）：Drop + Warn，轨迹若有 reply 则回传 Err 防 await 挂死
    pub fn enqueue(&self, command: DbWriteCommand) -> Result<(), AppError> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(AppError::State(
                "db write queue is shutting down; report rejected".to_owned(),
            ));
        }
        match self.sender.try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Closed(_)) => Err(AppError::State(
                "db write queue channel closed".to_owned(),
            )),
            Err(TrySendError::Full(command)) => handle_queue_full(command),
        }
    }

    /// 优雅退出：拒绝新命令 → 发送 Shutdown → join 后台线程，
    /// 保证存量命令全部落库后才返回（进程结束不丢上报数据）。
    pub fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        // Shutdown 必须送达写线程；队列满时仅在退出路径短暂 blocking_send（不 Panic）
        match self.sender.try_send(DbWriteCommand::Shutdown) {
            Ok(()) => {}
            Err(TrySendError::Full(cmd)) => {
                log_error!(
                    "TianshuTai CRITICAL: db write queue full during shutdown; blocking to deliver Shutdown"
                );
                let _ = self.sender.blocking_send(cmd);
            }
            Err(TrySendError::Closed(_)) => {}
        }
        if let Ok(mut guard) = self.handle.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }
}

/// 队列满时的背压降级：核心指令报严重错误，非核心 Drop + Warn。
fn handle_queue_full(command: DbWriteCommand) -> Result<(), AppError> {
    match command {
        DbWriteCommand::Shutdown => {
            log_error!("TianshuTai CRITICAL: db write queue full; Shutdown enqueue rejected");
            Err(AppError::State(
                "db write queue full; Shutdown rejected".to_owned(),
            ))
        }
        DbWriteCommand::SaveAgentTrajectory {
            domain,
            reply,
            ..
        } => {
            log_warn!(
                "TianshuTai WARN: db write queue full; dropping trajectory domain={domain}"
            );
            if let Some(tx) = reply {
                let _ = tx.send(Err(
                    "db write queue full; trajectory dropped".to_owned(),
                ));
            }
            Ok(())
        }
        DbWriteCommand::UpsertAgentRunStart { run_id, reply, .. }
        | DbWriteCommand::FinishAgentRun { run_id, reply, .. } => {
            log_warn!(
                "TianshuTai WARN: db write queue full; dropping agent run run_id={run_id}"
            );
            if let Some(tx) = reply {
                let _ = tx.send(Err(
                    "db write queue full; agent run dropped".to_owned(),
                ));
            }
            Ok(())
        }
        DbWriteCommand::UpsertAgentControlMemory { domain, .. } => {
            log_warn!(
                "TianshuTai WARN: db write queue full; dropping control memory domain={domain}"
            );
            Ok(())
        }
    }
}

/// 后台写线程的实际执行体。
fn execute_write(connection: &Arc<Mutex<Connection>>, command: DbWriteCommand) {
    match command {
        DbWriteCommand::SaveAgentTrajectory {
            domain,
            title,
            goal,
            start_url,
            actions,
            reply,
            run_id,
        } => {
            let result = write_agent_trajectory(
                connection,
                &domain,
                &title,
                &goal,
                &start_url,
                &actions,
                run_id.as_deref(),
            );
            if let Some(tx) = reply {
                let _ = tx.send(result);
            }
        }
        DbWriteCommand::UpsertAgentRunStart {
            run_id,
            profile_id,
            goal,
            start_url,
            domain,
            reply,
        } => {
            let result = write_agent_run_start(
                connection,
                &run_id,
                &profile_id,
                &goal,
                &start_url,
                &domain,
            );
            if let Some(tx) = reply {
                let _ = tx.send(result);
            }
        }
        DbWriteCommand::FinishAgentRun {
            run_id,
            profile_id,
            goal,
            start_url,
            domain,
            status,
            success,
            summary,
            step_count,
            hitl_occurred,
            trajectory_id,
            thought_summary,
            stats,
            reply,
        } => {
            let result = write_agent_run_finish(
                connection,
                &run_id,
                &profile_id,
                &goal,
                &start_url,
                &domain,
                &status,
                success,
                &summary,
                step_count,
                hitl_occurred,
                trajectory_id,
                &thought_summary,
                &stats,
            );
            if let Some(tx) = reply {
                let _ = tx.send(result);
            }
        }
        DbWriteCommand::UpsertAgentControlMemory {
            domain,
            intent,
            intent_key,
            kind,
            selector,
            text_hint,
            x_percent,
            y_percent,
            hit_count,
        } => {
            if let Err(error) = write_control_memory(
                connection,
                &domain,
                &intent,
                &intent_key,
                &kind,
                &selector,
                &text_hint,
                x_percent,
                y_percent,
                hit_count,
            ) {
                log_error!("TianshuTai: upsert agent control memory failed: {error}");
            }
        }
        DbWriteCommand::Shutdown => {}
    }
}

fn write_agent_trajectory(
    connection: &Arc<Mutex<Connection>>,
    domain: &str,
    title: &str,
    goal: &str,
    start_url: &str,
    actions: &str,
    run_id: Option<&str>,
) -> Result<i64, String> {
    let guard = connection
        .lock()
        .map_err(|_| "database lock poisoned".to_owned())?;
    let id = db::save_agent_trajectory(&guard, domain, title, goal, start_url, actions)
        .map_err(|error| error.to_string())?;
    if let Some(rid) = run_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Err(error) = db::link_agent_run_trajectory(&guard, rid, id) {
            log_warn!("TianshuTai: link agent run trajectory failed: {error}");
        }
    }
    Ok(id)
}

fn write_agent_run_start(
    connection: &Arc<Mutex<Connection>>,
    run_id: &str,
    profile_id: &str,
    goal: &str,
    start_url: &str,
    domain: &str,
) -> Result<i64, String> {
    let guard = connection
        .lock()
        .map_err(|_| "database lock poisoned".to_owned())?;
    db::upsert_agent_run_start(&guard, run_id, profile_id, goal, start_url, domain)
        .map_err(|error| error.to_string())
}

fn write_agent_run_finish(
    connection: &Arc<Mutex<Connection>>,
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
) -> Result<i64, String> {
    let guard = connection
        .lock()
        .map_err(|_| "database lock poisoned".to_owned())?;
    db::finish_agent_run(
        &guard,
        run_id,
        profile_id,
        goal,
        start_url,
        domain,
        status,
        success,
        summary,
        step_count,
        hitl_occurred,
        trajectory_id,
        thought_summary,
        stats,
    )
    .map_err(|error| error.to_string())
}

fn write_control_memory(
    connection: &Arc<Mutex<Connection>>,
    domain: &str,
    intent: &str,
    intent_key: &str,
    kind: &str,
    selector: &str,
    text_hint: &str,
    x_percent: Option<f64>,
    y_percent: Option<f64>,
    hit_count: Option<i64>,
) -> Result<i64, String> {
    let guard = connection
        .lock()
        .map_err(|_| "database lock poisoned".to_owned())?;
    db::upsert_agent_control_memory(
        &guard,
        domain,
        intent,
        intent_key,
        kind,
        selector,
        text_hint,
        x_percent,
        y_percent,
        hit_count,
    )
    .map_err(|error| error.to_string())
}
