//! Windows 任务栏 Profile ID 角标：通过 CDP 端口定位浏览器进程，WM_SETICON 替换任务栏图标。
//! 非 Windows 为 no-op；失败仅记日志，不阻断启动。

use std::sync::Mutex;

static ICON_HANDLES: Mutex<Vec<isize>> = Mutex::new(Vec::new());

pub const BADGE_SIZE: usize = 16;

/// 将 `#6366f1` / `6366f1` 解析为 RGB；失败时返回默认靛蓝。
pub fn parse_theme_color_hex(input: Option<&str>) -> (u8, u8, u8) {
    let raw = input.unwrap_or("").trim().trim_start_matches('#');
    if raw.len() != 6 {
        return (99, 102, 241);
    }
    let r = u8::from_str_radix(&raw[0..2], 16).ok();
    let g = u8::from_str_radix(&raw[2..4], 16).ok();
    let b = u8::from_str_radix(&raw[4..6], 16).ok();
    match (r, g, b) {
        (Some(r), Some(g), Some(b)) => (r, g, b),
        _ => (99, 102, 241),
    }
}

/// 任务栏角标文本：仅保留数字，最多 4 位。
pub fn format_badge_label(profile_id: &str) -> String {
    let trimmed = profile_id.trim();
    let digits: String = trimmed.chars().filter(|ch| ch.is_ascii_digit()).collect();
    let label = if digits.is_empty() {
        trimmed.to_owned()
    } else {
        digits
    };
    label.chars().take(4).collect()
}

/// 7x9 rounded digit glyphs for taskbar ID
const DIGIT_GLYPHS: [[u8; 9]; 10] = [
    [
        0b0111110, // 0
        0b1100011,
        0b1100011,
        0b1100011,
        0b1100011,
        0b1100011,
        0b1100011,
        0b1100011,
        0b0111110,
    ],
    [
        0b0011000, // 1
        0b0111000,
        0b0011000,
        0b0011000,
        0b0011000,
        0b0011000,
        0b0011000,
        0b0011000,
        0b1111111,
    ],
    [
        0b0111110, // 2
        0b1100011,
        0b0000011,
        0b0000110,
        0b0001100,
        0b0011000,
        0b0110000,
        0b1100000,
        0b1111111,
    ],
    [
        0b0111110, // 3
        0b1100011,
        0b0000011,
        0b0000110,
        0b0011110,
        0b0000011,
        0b0000011,
        0b1100011,
        0b0111110,
    ],
    [
        0b0000110, // 4
        0b0001110,
        0b0011110,
        0b0110110,
        0b1100110,
        0b1111111,
        0b0000110,
        0b0000110,
        0b0001111,
    ],
    [
        0b1111111, // 5
        0b1100000,
        0b1100000,
        0b1111110,
        0b0000011,
        0b0000011,
        0b0000011,
        0b1100011,
        0b0111110,
    ],
    [
        0b0011110, // 6
        0b0110000,
        0b1100000,
        0b1111110,
        0b1100011,
        0b1100011,
        0b1100011,
        0b1100011,
        0b0111110,
    ],
    [
        0b1111111, // 7
        0b0000011,
        0b0000110,
        0b0001100,
        0b0011000,
        0b0011000,
        0b0110000,
        0b0110000,
        0b0110000,
    ],
    [
        0b0111110, // 8
        0b1100011,
        0b1100011,
        0b1100011,
        0b0111110,
        0b1100011,
        0b1100011,
        0b1100011,
        0b0111110,
    ],
    [
        0b0111110, // 9
        0b1100011,
        0b1100011,
        0b1100011,
        0b0111111,
        0b0000011,
        0b0000011,
        0b0000110,
        0b0111100,
    ],
];

/// Chrome ring + light-blue profile ID.
pub fn render_profile_icon_rgba(label: &str, theme: (u8, u8, u8), size: usize) -> Vec<u8> {
    // 2~3× 足够清晰；过高会拖慢启动且数字易糊没
    let supersample = if size <= 24 { 3 } else { 2 };
    if size == 0 {
        return Vec::new();
    }
    let hd_size = size.saturating_mul(supersample).max(size);
    let hd = render_chrome_profile_icon_hd(label, theme, hd_size);
    if hd_size == size {
        hd
    } else {
        downsample_premultiplied(&hd, hd_size, size)
    }
}

const CHROME_PROFILE_BASE_SIZE: usize = 256;
const CHROME_PROFILE_BASE_RGBA: &[u8] =
    include_bytes!("../icons/chrome_profile_base_256.rgba");
/// 浅蓝高亮数字 + 深蓝描边（任务栏深色底更醒目）
const ID_FILL: (u8, u8, u8) = (220, 240, 255);
const ID_OUTLINE: (u8, u8, u8) = (18, 72, 140);

fn render_chrome_profile_icon_hd(label: &str, _theme: (u8, u8, u8), size: usize) -> Vec<u8> {
    let mut rgba = scale_rgba_box(CHROME_PROFILE_BASE_RGBA, CHROME_PROFILE_BASE_SIZE, size);
    draw_chrome_center_id(&mut rgba, label, size);
    rgba
}

fn scale_rgba_box(src: &[u8], src_size: usize, dst_size: usize) -> Vec<u8> {
    let expected = src_size * src_size * 4;
    if src.len() < expected || dst_size == 0 {
        return vec![0u8; dst_size * dst_size * 4];
    }
    if src_size == dst_size {
        return src[..expected].to_vec();
    }
    if dst_size > src_size {
        let mut tmp = vec![0u8; dst_size * dst_size * 4];
        for y in 0..dst_size {
            let sy = y * src_size / dst_size;
            for x in 0..dst_size {
                let sx = x * src_size / dst_size;
                let si = (sy * src_size + sx) * 4;
                let di = (y * dst_size + x) * 4;
                tmp[di..di + 4].copy_from_slice(&src[si..si + 4]);
            }
        }
        return tmp;
    }
    downsample_premultiplied(&src[..expected], src_size, dst_size)
}

fn draw_chrome_center_id(rgba: &mut [u8], label: &str, size: usize) {
    let Some((points, brush)) = collect_digit_stamps(label, size) else {
        return;
    };
    // 描边略粗、填充实心，提升对比度
    let outline_r = (brush * 0.78).max(1.15);
    let fill_r = (brush * 0.46).max(0.8);

    for (cx, cy) in &points {
        let x0 = ((*cx - outline_r).floor() as i32).max(0) as usize;
        let y0 = ((*cy - outline_r).floor() as i32).max(0) as usize;
        let x1 = ((*cx + outline_r).ceil() as i32).min(size as i32 - 1) as usize;
        let y1 = ((*cy + outline_r).ceil() as i32).min(size as i32 - 1) as usize;
        for y in y0..=y1 {
            for x in x0..=x1 {
                let fx = x as f32 + 0.5;
                let fy = y as f32 + 0.5;
                let dist = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt();
                if dist <= outline_r {
                    let a = (1.0 - dist / outline_r).clamp(0.0, 1.0);
                    blend_pixel(
                        rgba,
                        size,
                        x,
                        y,
                        ID_OUTLINE.0,
                        ID_OUTLINE.1,
                        ID_OUTLINE.2,
                        0.75 + 0.25 * a,
                    );
                }
                if dist <= fill_r {
                    blend_pixel(
                        rgba,
                        size,
                        x,
                        y,
                        ID_FILL.0,
                        ID_FILL.1,
                        ID_FILL.2,
                        0.98,
                    );
                }
            }
        }
    }
}

/// 返回字形圆点中心 + 笔刷半径（≈格子一半，保证笔画连续）
fn collect_digit_stamps(label: &str, size: usize) -> Option<(Vec<(f32, f32)>, f32)> {
    let display: String = format_badge_label(label).chars().take(2).collect();
    if display.is_empty() {
        return None;
    }
    let digit_count = display.chars().count().max(1);
    let w = size as f32;
    let cols = 7.0;
    let rows = 9.0;
    // 相对原先约小 2px（32 任务栏上 ~0.52→0.45）
    let target_h = if digit_count == 1 {
        w * 0.45
    } else {
        w * 0.36
    };
    let scale = (target_h / rows).max(1.0);
    let brush = (scale * 0.56).max(1.05);
    let glyph_w = cols * scale;
    let glyph_h = rows * scale;
    let gap = scale * 0.75;
    let total_w = digit_count as f32 * glyph_w + (digit_count.saturating_sub(1) as f32) * gap;
    let start_x = (w - total_w) * 0.5;
    let start_y = (w - glyph_h) * 0.5;

    let mut points = Vec::new();
    for (index, ch) in display.chars().enumerate() {
        let Some(digit) = ch.to_digit(10).map(|value| value as usize) else {
            continue;
        };
        let glyph = DIGIT_GLYPHS[digit];
        let offset_x = start_x + index as f32 * (glyph_w + gap);
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..7 {
                if (bits >> (6 - col)) & 1 == 0 {
                    continue;
                }
                let cx = offset_x + (col as f32 + 0.5) * scale;
                let cy = start_y + (row as f32 + 0.5) * scale;
                points.push((cx, cy));
            }
        }
    }
    if points.is_empty() {
        None
    } else {
        Some((points, brush))
    }
}

/// Premultiplied alpha box downsample for cleaner edges
fn downsample_premultiplied(src: &[u8], src_size: usize, dst_size: usize) -> Vec<u8> {
    let mut dst = vec![0u8; dst_size * dst_size * 4];
    if src_size == 0 || dst_size == 0 {
        return dst;
    }
    let scale = src_size as f32 / dst_size as f32;
    for dy in 0..dst_size {
        for dx in 0..dst_size {
            let mut r = 0.0f32;
            let mut g = 0.0f32;
            let mut b = 0.0f32;
            let mut a = 0.0f32;
            let mut count = 0.0f32;
            let x0 = (dx as f32 * scale) as usize;
            let y0 = (dy as f32 * scale) as usize;
            let x1 = (((dx + 1) as f32) * scale).ceil() as usize;
            let y1 = (((dy + 1) as f32) * scale).ceil() as usize;
            for sy in y0..y1.min(src_size) {
                for sx in x0..x1.min(src_size) {
                    let idx = (sy * src_size + sx) * 4;
                    let pa = src[idx + 3] as f32 / 255.0;
                    r += src[idx] as f32 * pa;
                    g += src[idx + 1] as f32 * pa;
                    b += src[idx + 2] as f32 * pa;
                    a += pa;
                    count += 1.0;
                }
            }
            if count > 0.0 {
                let idx = (dy * dst_size + dx) * 4;
                let avg_a = a / count;
                if avg_a > 0.001 {
                    dst[idx] = (r / count / avg_a).round().clamp(0.0, 255.0) as u8;
                    dst[idx + 1] = (g / count / avg_a).round().clamp(0.0, 255.0) as u8;
                    dst[idx + 2] = (b / count / avg_a).round().clamp(0.0, 255.0) as u8;
                    dst[idx + 3] = (avg_a * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
    dst
}

fn blend_pixel(rgba: &mut [u8], size: usize, x: usize, y: usize, r: u8, g: u8, b: u8, alpha: f32) {
    if x >= size || y >= size {
        return;
    }
    let idx = (y * size + x) * 4;
    let a = alpha.clamp(0.0, 1.0);
    let inv = 1.0 - a;
    rgba[idx] = (rgba[idx] as f32 * inv + r as f32 * a).round() as u8;
    rgba[idx + 1] = (rgba[idx + 1] as f32 * inv + g as f32 * a).round() as u8;
    rgba[idx + 2] = (rgba[idx + 2] as f32 * inv + b as f32 * a).round() as u8;
    rgba[idx + 3] = (rgba[idx + 3] as f32 * inv + 255.0 * a).round() as u8;
}

/// 按 user-data-dir 批量回收的结果。
///
/// 必须区分「没匹配到进程」与「匹配到了但回收失败」：前者是预期终态（浏览器早已退出），
/// 后者才是真残留。把两者压成一个数字，上层就只能把「什么事都没有」也报成「可能残留」，
/// 于是真实告警被噪声淹没。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KillBrowsersOutcome {
    /// 命令行匹配到该 user-data-dir 的进程数
    pub matched: usize,
    /// 其中被成功回收的进程数
    pub killed: usize,
}

#[cfg(windows)]
mod windows_impl {
    use super::{
        format_badge_label, parse_theme_color_hex, render_profile_icon_rgba, ICON_HANDLES,
        KillBrowsersOutcome,
    };
    use std::collections::HashSet;
    use std::ffi::c_void;
    use std::process::Command;
    use std::thread;
    use std::time::Duration;
    use windows::Win32::Foundation::{BOOL, FALSE, HWND, LPARAM, TRUE, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, RGBQUAD,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, CreateIconIndirect, GetClassNameW, GetForegroundWindow,
        GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, SendMessageW,
        SetForegroundWindow, ShowWindow, HICON, ICONINFO, ICON_BIG, ICON_SMALL, SW_RESTORE,
        SW_SHOW, WM_SETICON,
    };

    const ICON_SIZES: [i32; 2] = [32, 16];

    fn apply_window_icons(hwnd: HWND, label: &str, theme_color: Option<&str>) -> Result<(), String> {
        let bg = parse_theme_color_hex(theme_color);

        for size in ICON_SIZES {
            let rgba = render_profile_icon_rgba(label, bg, size as usize);
            let hicon = unsafe { rgba_to_hicon(&rgba, size)? };
            remember_icon(hicon);
            let icon_kind = if size >= 32 { ICON_BIG } else { ICON_SMALL };
            unsafe {
                SendMessageW(hwnd, WM_SETICON, WPARAM(icon_kind as usize), LPARAM(hicon.0 as isize));
            }
        }

        // Overlay 用纯数字小标太慢且易盖住主图标；主图标已含 ID，跳过 SetOverlayIcon
        Ok(())
    }

    pub fn apply_profile_taskbar_badge(
        cdp_port: u16,
        profile_id: &str,
        theme_color: Option<&str>,
        user_data_dir: Option<&str>,
        max_attempts: u32,
    ) -> Result<(), String> {
        let label = format_badge_label(profile_id);
        if label.is_empty() {
            return Err("badge label is empty".to_owned());
        }
        if cdp_port == 0 {
            return Err("invalid cdp port".to_owned());
        }

        let wait_attempts = max_attempts.min(16).max(1);
        let mut cached_pid: Option<u32> = None;
        let mut last_error = String::from("window not found");

        // 阶段1：尽快找到窗口并设图标（优先 netstat，避免反复 PowerShell）
        for _attempt in 1..=wait_attempts {
            let root_pid = match cached_pid.or_else(|| resolve_browser_pid(cdp_port, user_data_dir)) {
                Some(pid) => {
                    cached_pid = Some(pid);
                    pid
                }
                None => {
                    thread::sleep(Duration::from_millis(120));
                    continue;
                }
            };

            if let Some(hwnd) = find_main_chromium_window(root_pid) {
                match apply_window_icons(hwnd, &label, theme_color) {
                    Ok(()) => {
                        crate::log_info!(
                            "[taskbar_badge] ok profile={label} cdp_port={cdp_port} pid={root_pid}"
                        );
                        // 阶段2：轻量重刷 3 次（缓存 PID，防 Chromium 重置）
                        for _ in 0..3 {
                            thread::sleep(Duration::from_millis(180));
                            if let Some(hwnd) = find_main_chromium_window(root_pid) {
                                let _ = apply_window_icons(hwnd, &label, theme_color);
                            }
                        }
                        return Ok(());
                    }
                    Err(error) => {
                        last_error = error;
                    }
                }
            }
            thread::sleep(Duration::from_millis(120));
        }

        Err(format!(
            "taskbar badge failed for profile={label} cdp_port={cdp_port} after {wait_attempts} attempts: {last_error}"
        ))
    }

    pub fn find_pid_listening_on_port(port: u16) -> Option<u32> {
        let output = Command::new("netstat").args(["-ano"]).output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let needle = format!(":{port}");
        for line in text.lines() {
            let upper = line.to_uppercase();
            if !upper.contains("LISTENING") {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 {
                continue;
            }
            // TCP  127.0.0.1:9223  0.0.0.0:0  LISTENING  12345
            let local_addr = parts[1];
            if !local_addr.contains(&needle) {
                continue;
            }
            if let Ok(pid) = parts[parts.len() - 1].parse::<u32>() {
                if pid > 0 {
                    return Some(pid);
                }
            }
        }
        None
    }

    fn find_chrome_pid_by_profile(user_data_dir: &str, cdp_port: u16) -> Option<u32> {
        let dir_key = user_data_dir.replace('/', "\\").to_lowercase();
        let port_key = format!("remote-debugging-port={cdp_port}");

        // 优先 PowerShell/CIM（现代 Windows 上 wmic 常被禁用）
        if let Some(pid) = find_pid_via_powershell(&dir_key, &port_key) {
            return Some(pid);
        }

        let output = Command::new("cmd")
            .args([
                "/C",
                "wmic",
                "process",
                "where",
                "name='chrome.exe'",
                "get",
                "ProcessId,CommandLine",
                "/format:list",
            ])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).to_lowercase();

        let mut cmdline = String::new();
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("commandline=") {
                cmdline = rest.to_owned();
            } else if let Some(rest) = line.strip_prefix("processid=") {
                if cmdline.contains(&dir_key) && cmdline.contains(&port_key) {
                    if let Ok(pid) = rest.trim().parse::<u32>() {
                        if pid > 0 {
                            return Some(pid);
                        }
                    }
                }
                cmdline.clear();
            }
        }
        None
    }

    fn find_pid_via_powershell(dir_key: &str, port_key: &str) -> Option<u32> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let port_esc = port_key.replace('\'', "''");
        let dir_esc = dir_key.replace('\'', "''");
        // 一次查出带调试端口的进程；优先匹配 user-data-dir
        let script = format!(
            "$port='*{port}*'; $dir='*{dir}*'; \
             Get-CimInstance Win32_Process | Where-Object {{ \
               $_.CommandLine -and ($_.CommandLine -like $port) \
             }} | ForEach-Object {{ \
               $cl=$_.CommandLine.ToLower(); \
               if ($cl -like $dir) {{ $_.ProcessId; break }} \
               else {{ $_.ProcessId }} \
             }}",
            port = port_esc,
            dir = dir_esc,
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .find(|pid| *pid > 0)
    }

    fn resolve_browser_pid(cdp_port: u16, user_data_dir: Option<&str>) -> Option<u32> {
        // netstat 最快；多数场景端口唯一即可
        if let Some(pid) = find_pid_listening_on_port(cdp_port) {
            return Some(pid);
        }
        if let Some(dir) = user_data_dir.filter(|value| !value.is_empty()) {
            return find_chrome_pid_by_profile(dir, cdp_port);
        }
        None
    }

    fn kill_pid_tree(pid: u32) -> Result<(), String> {
        if pid == 0 {
            return Ok(());
        }
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|error| format!("taskkill failed: {error}"))?;
        match status.code() {
            Some(0) | Some(128) | Some(255) => Ok(()),
            Some(code) => Err(format!("taskkill exited with code {code} for pid {pid}")),
            None => Ok(()),
        }
    }

    /// 按 CDP 端口 / userDataDir 定位并强制关闭 CloakBrowser Chromium 进程树。
    pub fn kill_browser_for_profile(cdp_port: u16, user_data_dir: Option<&str>) -> Result<(), String> {
        let root_pid = resolve_browser_pid(cdp_port, user_data_dir)
            .ok_or_else(|| format!("browser process not found for cdp port {cdp_port}"))?;
        kill_pid_tree(root_pid)
    }

    /// 仅按 user-data-dir 匹配命令行，杀掉所有相关 chrome 进程（无 CDP 时的幽灵席位）。
    pub fn kill_browsers_matching_user_data_dir(user_data_dir: &str) -> KillBrowsersOutcome {
        let dir_key = user_data_dir.replace('/', "\\").to_lowercase();
        if dir_key.trim().is_empty() {
            return KillBrowsersOutcome::default();
        }
        let pids = find_chrome_pids_by_cmdline_substring(&dir_key);
        let mut outcome = KillBrowsersOutcome {
            matched: pids.len(),
            killed: 0,
        };
        for pid in pids {
            if kill_pid_tree(pid).is_ok() {
                outcome.killed += 1;
            }
        }
        outcome
    }

    /// 杀掉 profiles 根目录下所有 fingerprint 浏览器（含 DB 未标记 running 的孤儿）。
    pub fn kill_all_browsers_under_profiles_root(profiles_root: &str) -> usize {
        let root_key = profiles_root.replace('/', "\\").to_lowercase();
        if root_key.trim().is_empty() {
            return 0;
        }
        // 仅匹配本应用 browser-profiles，避免误杀用户其它 Chrome
        if !root_key.contains("browser-profiles") {
            return 0;
        }
        let pids = find_chrome_pids_by_cmdline_substring(&root_key);
        let mut killed = 0usize;
        for pid in pids {
            if kill_pid_tree(pid).is_ok() {
                killed += 1;
            }
        }
        killed
    }

    fn find_chrome_pids_by_cmdline_substring(dir_key: &str) -> Vec<u32> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let dir_esc = dir_key.replace('\'', "''");
        let script = format!(
            "$dir='*{dir}*'; \
             Get-CimInstance Win32_Process | Where-Object {{ \
               $_.Name -match 'chrome|chromium' -and $_.CommandLine -and ($_.CommandLine.ToLower() -like $dir) \
             }} | ForEach-Object {{ $_.ProcessId }}",
            dir = dir_esc,
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(output) = output else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        let mut seen = HashSet::new();
        let mut pids = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Ok(pid) = line.trim().parse::<u32>() {
                if pid > 0 && seen.insert(pid) {
                    pids.push(pid);
                }
            }
        }
        pids
    }

    fn collect_process_tree(root_pid: u32) -> HashSet<u32> {
        let mut result = HashSet::from([root_pid]);
        let mut children: Vec<u32> = vec![root_pid];

        unsafe {
            let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                Ok(value) => value,
                Err(_) => return result,
            };

            let mut entries: Vec<(u32, u32)> = Vec::new();
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(snapshot);

            let mut changed = true;
            while changed {
                changed = false;
                for (pid, ppid) in &entries {
                    if result.contains(ppid) && result.insert(*pid) {
                        children.push(*pid);
                        changed = true;
                    }
                }
            }
        }

        result
    }

    struct FindWindowState {
        allowed_pids: HashSet<u32>,
        best_hwnd: HWND,
        best_title_len: i32,
    }

    unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut FindWindowState);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if !state.allowed_pids.contains(&pid) {
            return TRUE;
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }

        let mut class_name = [0u16; 64];
        let class_len = GetClassNameW(hwnd, &mut class_name);
        if class_len == 0 {
            return TRUE;
        }
        let class_str = String::from_utf16_lossy(&class_name[..class_len as usize]);
        // CloakBrowser / Chromium 主窗体
        if class_str != "Chrome_WidgetWin_1" && class_str != "Chrome_WidgetWin_0" {
            return TRUE;
        }

        // 排除无标题的中间层窗口；优先标题最长的可见窗
        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return TRUE;
        }
        if title_len > state.best_title_len {
            state.best_title_len = title_len;
            state.best_hwnd = hwnd;
        }
        TRUE
    }

    fn find_main_chromium_window(root_pid: u32) -> Option<HWND> {
        let allowed_pids = collect_process_tree(root_pid);
        let mut state = FindWindowState {
            allowed_pids,
            best_hwnd: HWND::default(),
            best_title_len: -1,
        };
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::EnumWindows(
                Some(enum_window_proc),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        if state.best_hwnd.is_invalid() {
            None
        } else {
            Some(state.best_hwnd)
        }
    }

    /// 尝试让窗口取得系统焦点；必要时借用前台线程的输入队列。
    ///
    /// Windows 默认禁止后台进程抢占前台（防焦点窃取），此时 `SetForegroundWindow` 会
    /// **静默失败**。业界唯一可靠的解锁方式是把本线程输入队列临时挂到当前前台线程上
    /// （`AttachThreadInput`），完成后必须成对解挂，否则输入队列会一直串联。
    fn activate_window(hwnd: HWND) {
        unsafe {
            if SetForegroundWindow(hwnd).as_bool() {
                return;
            }
            let foreground = GetForegroundWindow();
            if foreground.is_invalid() {
                // 无前台窗口时不存在输入队列归属问题，重试即可
                let _ = SetForegroundWindow(hwnd);
                return;
            }
            let current_thread = GetCurrentThreadId();
            let foreground_thread = GetWindowThreadProcessId(foreground, None);
            if foreground_thread == 0 || foreground_thread == current_thread {
                let _ = SetForegroundWindow(hwnd);
                return;
            }
            let attached = AttachThreadInput(current_thread, foreground_thread, TRUE).as_bool();
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            if attached {
                let _ = AttachThreadInput(current_thread, foreground_thread, FALSE);
            }
        }
    }

    /// Bring the profile's Chromium window to the foreground (for Agent confirm / handover).
    ///
    /// 返回前用 `GetForegroundWindow` **实测**确认，而不是信任 `SetForegroundWindow` 的
    /// 返回值：后者成功也不代表窗口真的成了系统前台。确认失败时返回 Err，让「去处理」
    /// 按钮能如实报错，而不是让用户对着没反应的界面反复点击。
    pub fn focus_browser_by_cdp_port(cdp_port: u16) -> Result<(), String> {
        if cdp_port == 0 {
            return Err("cdp port is 0".to_owned());
        }
        let pid = find_pid_listening_on_port(cdp_port)
            .ok_or_else(|| format!("no browser process listening on cdp port {cdp_port}"))?;
        let hwnd = find_main_chromium_window(pid)
            .ok_or_else(|| format!("no visible Chrome window for pid={pid} port={cdp_port}"))?;
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = BringWindowToTop(hwnd);
        }
        activate_window(hwnd);

        let foreground = unsafe { GetForegroundWindow() };
        if foreground == hwnd {
            return Ok(());
        }
        // 已收敛到该环境进程树里的另一个窗口（如独立 DevTools）同样算「已带到前台」
        if !foreground.is_invalid() {
            let mut foreground_pid = 0u32;
            unsafe { GetWindowThreadProcessId(foreground, Some(&mut foreground_pid)) };
            if foreground_pid == pid {
                return Ok(());
            }
        }
        Err(format!(
            "窗口已抬起但未取得系统焦点（pid={pid} port={cdp_port}）：可能被其它前台窗口或系统前台策略阻止"
        ))
    }

    unsafe fn rgba_to_hicon(rgba: &[u8], size: i32) -> Result<HICON, String> {
        let hdc_screen = windows::Win32::Graphics::Gdi::GetDC(HWND::default());
        if hdc_screen.is_invalid() {
            return Err("GetDC failed".to_owned());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            bmiColors: [RGBQUAD::default(); 1],
        };

        let mut bits: *mut c_void = std::ptr::null_mut();
        let hbm_color = CreateDIBSection(
            hdc_screen,
            &bmi,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )
        .map_err(|error| format!("CreateDIBSection failed: {error}"))?;

        // AND mask：1=透明 0=不透明。旧代码填 0xFF 会导致整图标不可见。
        let pixel_count = (size * size) as usize;
        let mask_len = ((size * size + 7) / 8) as usize;
        let mut mask_bits = vec![0u8; mask_len];

        if !bits.is_null() {
            let dst = std::slice::from_raw_parts_mut(bits as *mut u8, pixel_count * 4);
            for (index, chunk) in rgba.chunks_exact(4).enumerate() {
                let offset = index * 4;
                // Windows DIB 为 BGRA
                dst[offset] = chunk[2];
                dst[offset + 1] = chunk[1];
                dst[offset + 2] = chunk[0];
                dst[offset + 3] = chunk[3];
                // 低 alpha 在 AND mask 标为透明（兼容忽略 alpha 的路径）
                if chunk[3] < 16 {
                    let bit = index;
                    mask_bits[bit / 8] |= 0x80u8 >> (bit % 8);
                }
            }
        }

        let hdc = CreateCompatibleDC(hdc_screen);
        let _ = SelectObject(hdc, hbm_color);

        let hbm_mask = CreateBitmap(size, size, 1, 1, Some(mask_bits.as_ptr() as *const _));
        if hbm_mask.is_invalid() {
            let _ = DeleteObject(hbm_color);
            let _ = DeleteDC(hdc);
            let _ = windows::Win32::Graphics::Gdi::ReleaseDC(HWND::default(), hdc_screen);
            return Err("CreateBitmap mask failed".to_owned());
        }

        // fIcon=TRUE：必须是图标；旧代码 BOOL(0) 会建成光标，任务栏不生效
        let icon_info = ICONINFO {
            fIcon: TRUE,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: hbm_mask,
            hbmColor: hbm_color,
        };

        let hicon = CreateIconIndirect(&icon_info)
            .map_err(|error| format!("CreateIconIndirect failed: {error}"))?;

        let _ = DeleteObject(hbm_color);
        let _ = DeleteObject(hbm_mask);
        let _ = DeleteDC(hdc);
        let _ = windows::Win32::Graphics::Gdi::ReleaseDC(HWND::default(), hdc_screen);

        Ok(hicon)
    }

    fn remember_icon(hicon: HICON) {
        if let Ok(mut icons) = ICON_HANDLES.lock() {
            icons.push(hicon.0 as isize);
        }
    }

    pub fn apply_badge_with_retry(
        pid: u32,
        label: &str,
        theme_color: Option<&str>,
        max_attempts: u32,
    ) -> Result<(), String> {
        let label = format_badge_label(label);
        if label.is_empty() {
            return Err("badge label is empty".to_owned());
        }
        for _attempt in 1..=max_attempts {
            if let Some(hwnd) = find_main_chromium_window(pid) {
                if apply_window_icons(hwnd, &label, theme_color).is_ok() {
                    return Ok(());
                }
            }
            thread::sleep(Duration::from_millis(200));
        }
        Err(format!("taskbar badge failed for pid={pid}"))
    }
}

#[cfg(windows)]
pub use windows_impl::{
    apply_badge_with_retry, apply_profile_taskbar_badge, find_pid_listening_on_port,
    focus_browser_by_cdp_port, kill_all_browsers_under_profiles_root, kill_browser_for_profile,
    kill_browsers_matching_user_data_dir,
};

#[cfg(not(windows))]
pub fn kill_browser_for_profile(_cdp_port: u16, _user_data_dir: Option<&str>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn kill_browsers_matching_user_data_dir(_user_data_dir: &str) -> KillBrowsersOutcome {
    KillBrowsersOutcome::default()
}

#[cfg(not(windows))]
pub fn kill_all_browsers_under_profiles_root(_profiles_root: &str) -> usize {
    0
}

#[cfg(not(windows))]
pub fn apply_profile_taskbar_badge(
    _cdp_port: u16,
    _profile_id: &str,
    _theme_color: Option<&str>,
    _user_data_dir: Option<&str>,
    _max_attempts: u32,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn apply_badge_with_retry(
    _pid: u32,
    _label: &str,
    _theme_color: Option<&str>,
    _max_attempts: u32,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn find_pid_listening_on_port(_port: u16) -> Option<u32> {
    None
}

#[cfg(not(windows))]
pub fn focus_browser_by_cdp_port(_cdp_port: u16) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{format_badge_label, parse_theme_color_hex, render_profile_icon_rgba, BADGE_SIZE};

    #[test]
    fn format_badge_label_keeps_digits_only() {
        assert_eq!(format_badge_label("profile-12"), "12");
        assert_eq!(format_badge_label("  3 "), "3");
    }

    #[test]
    fn parse_theme_color_hex_parses_hash_color() {
        assert_eq!(parse_theme_color_hex(Some("#ff0000")), (255, 0, 0));
        assert_eq!(parse_theme_color_hex(Some("6366f1")), (99, 102, 241));
    }

    #[test]
    fn render_profile_icon_rgba_has_expected_size() {
        let rgba = render_profile_icon_rgba("2", (99, 102, 241), BADGE_SIZE);
        assert_eq!(rgba.len(), 16 * 16 * 4);
        assert!(rgba.chunks(4).any(|pixel| pixel[3] > 0));
        // 16×16 下扫中心邻域，取最亮通道（浅蓝数字）
        let mut bright = 0u8;
        for dy in -3i32..=3 {
            for dx in -3i32..=3 {
                let x = (BADGE_SIZE as i32 / 2 + dx).clamp(0, BADGE_SIZE as i32 - 1) as usize;
                let y = (BADGE_SIZE as i32 / 2 + dy).clamp(0, BADGE_SIZE as i32 - 1) as usize;
                let i = (y * BADGE_SIZE + x) * 4;
                if rgba[i + 3] < 40 {
                    continue;
                }
                bright = bright
                    .max(rgba[i])
                    .max(rgba[i + 1])
                    .max(rgba[i + 2]);
            }
        }
        assert!(bright >= 160, "hero digit should be bright near center, got {bright}");
    }
}
