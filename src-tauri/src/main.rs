// 发布构建：主程序不挂控制台黑框（debug 仍保留便于排查）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ai_browser_lib::run();
}
