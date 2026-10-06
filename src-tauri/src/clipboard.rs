//! 系统剪贴板（Host 唯一入口）—— N5 / N6 · §6.1 / §6.2。
//!
//! 为什么必须由 Host 独占：剪贴板是**操作系统级共享资源**，Playwright 的 context 隔离对它无效，
//! 本仓库又是「每个环境一个浏览器进程、共享同一台机器」。多环境同时读会互相串味
//! （A 环境把 B 环境刚写进去的内容填进表单），所以这里做两件事：
//!
//!   ① **全局互斥**：所有读取都要先拿租约（`ClipboardHub::read_text`），读→放，串行化；
//!   ② **快照**：默认模式只读一次并冻结成单行数据集（`remember` / `recall`），
//!      避免「同一份数据被每个浏览器各读一次、读到不同值」。
//!
//! 红线（R2 / §1.3 / §6.4）：
//!   - 内容**不入日志、不入台账**：对外只暴露长度（`describe_for_log`）；
//!   - 判定为一次性凭证的内容**默认拒绝自动填入**（判定在 Sidecar `clipboard_gate.ts`，
//!     走 `human_credential` 同一套词表，不在 Rust 里另写一套）；
//!   - 快照只存内存（有 TTL），进程退出即消失；不写 SQLite、不落文件。

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 单个值上限（与数据集 `/v1/fill` 同口径，§4.3）：超长一律截断，避免把整篇文档灌进表单。
pub const MAX_CLIPBOARD_CHARS: usize = 4096;
/// 快照存活时长：超过即视为过期（不静默复用旧值）。
pub const SNAPSHOT_TTL: Duration = Duration::from_secs(30 * 60);

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// 剪贴板文本归一化：去 NUL、去首尾空白、按字符截断到上限。
///
/// 不做其它「清洗」——剪贴板内容是要原样填进表单的数据，改一个字符就可能填错。
pub fn sanitize_text(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|character| *character != '\0').collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= MAX_CLIPBOARD_CHARS {
        return trimmed.to_owned();
    }
    trimmed.chars().take(MAX_CLIPBOARD_CHARS).collect()
}

/// 仅供日志/上报使用的描述：**只给长度，不给内容**（§6.4「内容不入日志」）。
pub fn describe_for_log(text: &str) -> String {
    format!("剪贴板文本 {} 字符", text.chars().count())
}

/// 读到的剪贴板快照（只存内存；`hash` 是数据集指纹，用来把「预检时读的那份」对回执行阶段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardSnapshot {
    pub hash: String,
    pub text: String,
    pub length: usize,
    pub created_at_ms: u128,
}

impl ClipboardSnapshot {
    fn expired(&self, at_ms: u128) -> bool {
        at_ms.saturating_sub(self.created_at_ms) > SNAPSHOT_TTL.as_millis()
    }

    /// 需要回传内容时也**不带全文进日志**：调用方只应把它当数据用。
    pub fn into_rows(self) -> Vec<serde_json::Value> {
        vec![serde_json::json!({ "text": self.text })]
    }
}

#[derive(Default)]
struct HubInner {
    snapshots: VecDeque<ClipboardSnapshot>,
}

/// 剪贴板 Hub：全局互斥 + 快照（进程内单例，见 `hub()`）。
///
/// 读取是**短、快、阻塞**的系统调用（微秒级），因此这里用 std 互斥锁而不是 async 锁：
/// 唯一入口 `handle_agent_host_request` 是同步上下文，且临界区内**不 await**，
/// 不会出现「持锁跨 await」的死锁风险。
pub struct ClipboardHub {
    /// 全局互斥：读剪贴板必须串行（§6.1）。
    lease: Mutex<()>,
    inner: Mutex<HubInner>,
}

impl Default for ClipboardHub {
    fn default() -> Self {
        Self {
            lease: Mutex::new(()),
            inner: Mutex::new(HubInner::default()),
        }
    }
}

impl ClipboardHub {
    /// 全局互斥下读一次系统剪贴板。**空内容也算失败**（禁止把空值当数据填进去）。
    pub fn read_text(&self) -> Result<String, AppError> {
        self.read_text_with(read_system_text)
    }

    /// 可注入读取器的版本（单测用：真读 Win32 剪贴板无法在 CI 里构造）。
    pub fn read_text_with<F>(&self, reader: F) -> Result<String, AppError>
    where
        F: FnOnce() -> Result<String, AppError>,
    {
        // `_lease` 一直持有到函数结束：读 → 放锁，中途不允许其它环境插进来
        let _lease = self
            .lease
            .lock()
            .map_err(|_| AppError::State("剪贴板互斥锁不可用".to_owned()))?;
        let text = sanitize_text(&reader()?);
        if text.is_empty() {
            return Err(AppError::Validation(
                "剪贴板为空：请先复制内容再运行（不允许把空值当数据填入）".to_owned(),
            ));
        }
        crate::log_debug!("[clipboard] read ok · {}", describe_for_log(&text));
        Ok(text)
    }

    /// 记住一份快照（按数据集指纹索引）。同一指纹覆盖，避免重复堆积。
    pub fn remember(&self, hash: &str, text: &str) {
        let hash = hash.trim();
        if hash.is_empty() {
            return;
        }
        let sanitized = sanitize_text(text);
        let at_ms = now_ms();
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.snapshots.retain(|item| item.hash != hash);
        inner.snapshots.push_back(ClipboardSnapshot {
            hash: hash.to_owned(),
            length: sanitized.chars().count(),
            text: sanitized,
            created_at_ms: at_ms,
        });
        while inner.snapshots.len() > 16 {
            inner.snapshots.pop_front();
        }
    }

    /// 取回快照（**不消费**）。
    ///
    /// 为什么不消费：一张预检单会被**多个环境**读取（每个环境一次 `replay_agent_trajectory`），
    /// 消费掉会让第二个环境直接报「快照已失效」。一致性由 `dataset_hash` 保证
    /// （内容变了 hash 就变，执行阶段会因此拒绝启动），不需要靠消费来防「看着 A 跑着 B」。
    /// 过期由 TTL 兜底（`SNAPSHOT_TTL`）。
    pub fn recall(&self, hash: &str) -> Option<ClipboardSnapshot> {
        let hash = hash.trim();
        if hash.is_empty() {
            return None;
        }
        let at_ms = now_ms();
        let Ok(mut inner) = self.inner.lock() else {
            return None;
        };
        inner.snapshots.retain(|item| !item.expired(at_ms));
        inner
            .snapshots
            .iter()
            .find(|item| item.hash == hash)
            .cloned()
    }

    /// 只看一眼（不消费），用于「预检单是否还有效」这类判断。
    pub fn peek(&self, hash: &str) -> Option<usize> {
        let hash = hash.trim();
        if hash.is_empty() {
            return None;
        }
        let at_ms = now_ms();
        let Ok(mut inner) = self.inner.lock() else {
            return None;
        };
        inner.snapshots.retain(|item| !item.expired(at_ms));
        inner
            .snapshots
            .iter()
            .find(|item| item.hash == hash)
            .map(|item| item.length)
    }

    pub fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshots.clear();
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().map(|inner| inner.snapshots.len()).unwrap_or(0)
    }
}

/// 进程内单例：宿主所有剪贴板读取共用同一把锁与同一份快照（§6.1）。
pub fn hub() -> &'static ClipboardHub {
    static HUB: OnceLock<ClipboardHub> = OnceLock::new();
    HUB.get_or_init(ClipboardHub::default)
}

/// 读取系统剪贴板文本（Windows：CF_UNICODETEXT）。
#[cfg(windows)]
pub fn read_system_text() -> Result<String, AppError> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    /// CF_UNICODETEXT —— 剪贴板格式常量固定为 13（Win32 定义，非法值不会变）。
    const CF_UNICODETEXT: u32 = 13;

    unsafe {
        OpenClipboard(None).map_err(|error| {
            AppError::State(format!(
                "打不开系统剪贴板（可能被其它程序占用）：{error}"
            ))
        })?;
        // 保证异常路径也放锁：CloseClipboard 必须执行
        let result = (|| -> Result<String, AppError> {
            if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
                return Ok(String::new());
            }
            let handle = GetClipboardData(CF_UNICODETEXT)
                .map_err(|error| AppError::State(format!("读取剪贴板失败：{error}")))?;
            if handle.0.is_null() {
                return Ok(String::new());
            }
            let global = HGLOBAL(handle.0);
            let pointer = GlobalLock(global) as *const u16;
            if pointer.is_null() {
                return Ok(String::new());
            }
            let byte_len = GlobalSize(global);
            let units = byte_len / std::mem::size_of::<u16>();
            let slice = std::slice::from_raw_parts(pointer, units);
            let end = slice
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(slice.len());
            let text = String::from_utf16_lossy(&slice[..end]);
            let _ = GlobalUnlock(global);
            Ok(text)
        })();
        let _ = CloseClipboard();
        result
    }
}

#[cfg(not(windows))]
pub fn read_system_text() -> Result<String, AppError> {
    Err(AppError::State(
        "系统剪贴板读取暂只支持 Windows；请改用「数据集」数据源".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn hub_for_test() -> ClipboardHub {
        ClipboardHub::default()
    }

    #[test]
    fn sanitize_strips_nul_and_caps_length() {
        assert_eq!(sanitize_text("  abc\u{0}def  "), "abcdef");
        let long = "字".repeat(MAX_CLIPBOARD_CHARS + 50);
        assert_eq!(sanitize_text(&long).chars().count(), MAX_CLIPBOARD_CHARS);
    }

    #[test]
    fn describe_never_leaks_content() {
        let secret = "482913";
        let described = describe_for_log(secret);
        assert!(!described.contains(secret), "日志描述不得含剪贴板内容");
        assert!(described.contains('6'));
    }

    #[test]
    fn reads_are_serialized_by_global_lease() {
        let hub = Arc::new(hub_for_test());
        let concurrent = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for index in 0..6 {
            let hub = hub.clone();
            let concurrent = concurrent.clone();
            let max_concurrent = max_concurrent.clone();
            threads.push(std::thread::spawn(move || {
                hub.read_text_with(|| {
                    let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                    max_concurrent.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(10));
                    concurrent.fetch_sub(1, Ordering::SeqCst);
                    Ok(format!("value-{index}"))
                })
                .expect("read")
            }));
        }
        for thread in threads {
            thread.join().expect("thread");
        }
        assert_eq!(
            max_concurrent.load(Ordering::SeqCst),
            1,
            "剪贴板是 OS 级共享资源：读取必须全局串行（§6.1）"
        );
    }

    #[test]
    fn empty_clipboard_is_a_failure_not_an_empty_value() {
        let hub = hub_for_test();
        let error = hub
            .read_text_with(|| Ok("   \u{0} ".to_owned()))
            .expect_err("空内容必须报错");
        assert!(error.reason().contains("剪贴板为空"));
    }

        #[test]
        fn snapshot_is_recalled_repeatedly_and_expires() {
            let hub = hub_for_test();
            hub.remember("sha256:abc", "订单号 A-1");
            assert_eq!(hub.peek("sha256:abc"), Some("订单号 A-1".chars().count()));
            let first = hub.recall("sha256:abc").expect("快照存在");
            assert_eq!(first.text, "订单号 A-1");
            // 多环境各读一次：**不能**因为第一个环境读过就让第二个环境拿不到
            let second = hub.recall("sha256:abc").expect("同一指纹可被多个环境读取");
            assert_eq!(second.text, "订单号 A-1");
            assert_eq!(hub.len(), 1);
        }

    #[test]
    fn snapshot_rows_use_the_text_column() {
        let rows = ClipboardSnapshot {
            hash: "sha256:x".to_owned(),
            text: "hello".to_owned(),
            length: 5,
            created_at_ms: now_ms(),
        }
        .into_rows();
        assert_eq!(rows[0]["text"], serde_json::json!("hello"));
    }
}
