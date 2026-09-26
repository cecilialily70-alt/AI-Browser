use crate::error::AppError;
use tauri::WebviewWindow;

#[cfg(windows)]
pub fn disable_default_browser_ui(window: &WebviewWindow) -> Result<(), AppError> {
    window
        .with_webview(|webview| {
            unsafe {
                if let Ok(core) = webview.controller().CoreWebView2() {
                    if let Ok(settings) = core.Settings() {
                        let _ = settings.SetAreDefaultContextMenusEnabled(false);
                        let _ = settings.SetAreDevToolsEnabled(false);
                    }
                }
            }
        })
        .map_err(|error| AppError::State(error.to_string()))?;

    Ok(())
}

#[cfg(not(windows))]
pub fn disable_default_browser_ui(_window: &WebviewWindow) -> Result<(), AppError> {
    Ok(())
}
