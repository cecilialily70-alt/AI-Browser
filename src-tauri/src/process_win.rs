use std::process::{Child, Command};

use crate::error::AppError;

/// Windows：隐藏子进程控制台黑框（node.exe 等 console 子系统）。
/// 非 Windows 平台为 no-op，不影响 stdin/stdout/stderr 管道。
pub fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// CREATE_NO_WINDOW — 不创建控制台窗口
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Sidecar 启动前统一配置：隐藏黑框 + Unix 独立进程组（供 killpg 级联回收）。
pub fn prepare_sidecar_command(command: &mut Command) {
    hide_console_window(command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 子进程成为新进程组组长，kill_process_tree 可用 killpg 清整组
        command.process_group(0);
    }
}

/// 将已 spawn 的子进程登记到「主进程消亡即级联回收」生命周期中。
/// Windows：AssignProcessToJobObject(KILL_ON_JOB_CLOSE)；Unix：进程组已在 prepare 时设置。
pub fn register_child_for_lifecycle(child: &Child) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        assign_to_kill_on_close_job(child)
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        Ok(())
    }
}

/// 强制结束进程及其子进程（Windows: taskkill /T；Unix: killpg SIGTERM→SIGKILL）。
pub fn kill_process_tree(pid: u32) -> Result<(), AppError> {
    if pid == 0 {
        return Ok(());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|error| AppError::Launcher(format!("taskkill failed: {error}")))?;

        match status.code() {
            Some(0) | Some(128) | Some(255) => Ok(()),
            Some(code) => Err(AppError::Launcher(format!(
                "taskkill exited with code {code} for pid {pid}"
            ))),
            None => Ok(()),
        }
    }

    #[cfg(unix)]
    {
        kill_unix_process_group(pid)
    }

    #[cfg(all(not(windows), not(unix)))]
    {
        Err(AppError::Launcher(format!(
            "kill_process_tree unsupported on this platform for pid {pid}"
        )))
    }
}

#[cfg(unix)]
fn kill_unix_process_group(pid: u32) -> Result<(), AppError> {
    use std::time::Duration;

    let pgid = pid as i32;
    // 先 SIGTERM 整组，短暂等待后 SIGKILL 兜底
    let term_rc = unsafe { libc::killpg(pgid, libc::SIGTERM) };
    if term_rc != 0 {
        let errno = std::io::Error::last_os_error();
        // ESRCH：进程组已不存在，视为成功
        if errno.raw_os_error() != Some(libc::ESRCH) {
            // 回退：至少杀组长
            let _ = unsafe { libc::kill(pgid, libc::SIGTERM) };
        }
    }

    std::thread::sleep(Duration::from_millis(500));

    let still_alive = unsafe { libc::killpg(pgid, 0) } == 0;
    if still_alive {
        let kill_rc = unsafe { libc::killpg(pgid, libc::SIGKILL) };
        if kill_rc != 0 {
            let errno = std::io::Error::last_os_error();
            if errno.raw_os_error() != Some(libc::ESRCH) {
                let _ = unsafe { libc::kill(pgid, libc::SIGKILL) };
            }
        }
    }

    Ok(())
}

/// 有上限地等待子进程自然退出；超时则强制回收进程树。
///
/// 返回 `Some(status)` 表示在 `timeout` 内自然退出，`None` 表示超时后被强制回收。
///
/// 存在的意义：无上限的 `Child::wait()` 会让上层的超时守卫彻底失效——子进程一旦在
/// CDP 上挂死，等待方（乃至 Tokio 工作线程）会被永久占住，在 UI 上表现为
/// 「操作永久转圈」且没有任何错误回传。
pub fn wait_child_with_deadline(
    child: &mut Child,
    timeout: std::time::Duration,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(Some(status)),
            None => {
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }

    // 超时：按进程树整体回收，避免 Node 已退出但 Chromium 子进程残留
    let _ = kill_process_tree(child.id());
    let _ = child.kill();
    // 收尸，避免僵尸进程；已被杀掉的进程这里会立即返回
    let _ = child.wait();
    Ok(None)
}

/// 一次性 CLI 子进程的捕获结果。
pub struct ChildOutput {
    /// `None` 表示超时后被强制回收（未自然退出）
    pub status: Option<std::process::ExitStatus>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ChildOutput {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// 采集流结束时允许的额外宽限。
///
/// 子进程已退出时读端通常立即 EOF；但 Node 派生的孙进程可能继承并**继续持有** stdout
/// 写端，使 `read_to_end` 迟迟不返回。宁可丢失这段尾部输出，也不能把调用方永久挂住。
const STREAM_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// 有上限地执行一次性 CLI 子进程并捕获其输出。
///
/// 与 [`std::process::Command::output`] 的区别：后者**没有任何时间上限**——脚本一旦在
/// 网络或 CDP 上挂死，等待方会被永久占住，在 UI 上表现为「操作永久转圈」且收不到任何
/// 错误。本函数强制在 `timeout` 后回收整棵进程树，并把 `status = None` 回传给调用方，
/// 让上层能如实报告超时。
///
/// 采用「读线程 + 通道 + 宽限窗口」而非直接 join：即使孙进程霸占管道不关闭，
/// 采集也会在有界时间内返回有损结果，绝不阻塞调用方。
pub fn run_child_with_deadline(
    command: &mut Command,
    timeout: std::time::Duration,
) -> std::io::Result<ChildOutput> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::mpsc;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;

    let (stdout_tx, stdout_rx) = mpsc::channel::<Vec<u8>>();
    let (stderr_tx, stderr_rx) = mpsc::channel::<Vec<u8>>();
    if let Some(mut pipe) = child.stdout.take() {
        // 句柄直接丢弃（detach）：本函数只保证「有界返回」，不等待读线程收尾
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            let _ = stdout_tx.send(buffer);
        });
    } else {
        let _ = stdout_tx.send(Vec::new());
    }
    if let Some(mut pipe) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            let _ = stderr_tx.send(buffer);
        });
    } else {
        let _ = stderr_tx.send(Vec::new());
    }

    let status = wait_child_with_deadline(&mut child, timeout)?;
    // 超时分支已强制回收进程树，读端随之 EOF；宽限窗口只为兜住异常的管道持有者
    let stdout = stdout_rx.recv_timeout(STREAM_DRAIN_GRACE).unwrap_or_default();
    let stderr = stderr_rx.recv_timeout(STREAM_DRAIN_GRACE).unwrap_or_default();

    Ok(ChildOutput {
        status,
        stdout,
        stderr,
    })
}

/// 把超时（`ChildOutput.status == None`）翻译成统一的用户可读文本。
///
/// 只返回文本、不绑定错误类型：调用方分属 `Launcher`（内核）与 `Llm`（AI）等不同语义。
pub fn timeout_message(label: &str, timeout: std::time::Duration) -> String {
    format!(
        "{label} 超过 {} 秒未返回，已强制终止（可重试；若持续出现请检查网络或内核状态）",
        timeout.as_secs()
    )
}

#[cfg(windows)]
mod job_object {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    use crate::error::AppError;

    /// 进程级 Job 句柄（保持打开；主进程退出时内核关闭 → 级联杀光 Job 内进程树）。
    static APP_JOB_HANDLE: OnceLock<isize> = OnceLock::new();

    fn ensure_app_job() -> Result<HANDLE, AppError> {
        if let Some(raw) = APP_JOB_HANDLE.get() {
            return Ok(HANDLE(*raw as *mut std::ffi::c_void));
        }

        unsafe {
            let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).map_err(|error| {
                AppError::Launcher(format!("CreateJobObjectW failed: {error}"))
            })?;

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
            )
            .map_err(|error| {
                AppError::Launcher(format!("SetInformationJobObject failed: {error}"))
            })?;

            let raw = job.0 as isize;
            // 若竞态下已有其它线程先写入，丢弃本线程新建的句柄，改用已登记句柄
            if APP_JOB_HANDLE.set(raw).is_err() {
                let _ = windows::Win32::Foundation::CloseHandle(job);
                if let Some(existing) = APP_JOB_HANDLE.get() {
                    return Ok(HANDLE(*existing as *mut std::ffi::c_void));
                }
            }

            Ok(HANDLE(raw as *mut std::ffi::c_void))
        }
    }

    pub fn assign_to_kill_on_close_job(child: &Child) -> Result<(), AppError> {
        let job = ensure_app_job()?;
        let process = HANDLE(child.as_raw_handle() as *mut std::ffi::c_void);
        unsafe {
            AssignProcessToJobObject(job, process).map_err(|error| {
                AppError::Launcher(format!(
                    "AssignProcessToJobObject failed (pid={}): {error}",
                    child.id()
                ))
            })?;
        }
        Ok(())
    }
}

#[cfg(windows)]
use job_object::assign_to_kill_on_close_job;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// 复现生产场景用的子进程：`node` 是本项目的硬依赖（所有 CLI 都由它拉起），
    /// 因此这里直接用它构造「永不退出」与「大流量输出」两类真实进程。
    fn node_command(script: &str) -> Command {
        let mut command = Command::new("node");
        command.arg("-e").arg(script);
        command
    }

    /// 环境缺 node 时跳过：本组用例针对进程回收语义，不针对 node 的存在性。
    fn try_run(
        command: &mut Command,
        timeout: Duration,
    ) -> Option<ChildOutput> {
        match run_child_with_deadline(command, timeout) {
            Ok(output) => Some(output),
            Err(_) => None,
        }
    }

    /// 核心契约：挂死的子进程必须在有界时间内被判定为超时并回收。
    ///
    /// 这正是 `Command::output()` 做不到的事——它会一直等下去，把上层超时守卫全部架空。
    #[test]
    fn hanging_child_is_reaped_within_deadline() {
        let mut command = node_command("setTimeout(() => {}, 60_000);");
        let started = Instant::now();
        let Some(output) = try_run(&mut command, Duration::from_millis(800)) else {
            return; // 无 node，跳过
        };
        let elapsed = started.elapsed();

        assert!(
            output.status.is_none(),
            "超时被强制回收时必须回传 status=None，否则上层无法如实上报超时"
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "必须在有界时间内返回，实际耗时 {elapsed:?}"
        );
    }

    /// 正常退出路径：状态与双流都要如实捕获，不能被超时逻辑污染。
    #[test]
    fn fast_child_reports_status_and_both_streams() {
        let mut command = node_command("process.stdout.write('out'); process.stderr.write('err');");
        let Some(output) = try_run(&mut command, Duration::from_secs(30)) else {
            return;
        };
        assert_eq!(
            output.status.and_then(|status| status.code()),
            Some(0),
            "正常退出应拿到真实退出码"
        );
        assert_eq!(output.stdout_text(), "out");
        assert_eq!(output.stderr_text(), "err");
    }

    /// 大流量输出必须被完整捕获。
    ///
    /// 200KB 远超 OS 管道缓冲：若不用独立读线程并发抽水，子进程写满管道后会阻塞、
    /// 等待方再等子进程退出 —— 双方互等，死锁。这是 `output()` 内部同样要处理的经典坑。
    #[test]
    fn output_larger_than_pipe_buffer_is_drained_fully() {
        let mut command = node_command("process.stdout.write('x'.repeat(200_000));");
        let Some(output) = try_run(&mut command, Duration::from_secs(60)) else {
            return;
        };
        assert!(
            output.status.map(|status| status.success()).unwrap_or(false),
            "子进程应正常退出而不是被超时回收（超时说明发生了管道死锁）"
        );
        assert_eq!(output.stdout.len(), 200_000, "大输出不得被截断");
    }

    /// 超时文案要给出可读的秒数，且不绑定具体错误类型（各调用方语义不同）。
    #[test]
    fn timeout_message_is_human_readable() {
        let message = timeout_message("AI 对话", Duration::from_secs(180));
        assert!(message.contains("180"), "必须写明上限秒数: {message}");
        assert!(message.contains("AI 对话"), "必须写明是哪条链路: {message}");
    }
}
