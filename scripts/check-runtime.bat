@echo off
REM ASCII-only. Never put unescaped ( ) inside if () echo lines.
setlocal EnableDelayedExpansion
set "ROOT=%~dp0"
if /I "%~1"=="--quiet" set "QUIET=1"

set "FAILED=0"

call :check_node || set "FAILED=1"
call :check_webview2 || set "FAILED=1"
call :check_sidecar || set "FAILED=1"
call :check_app_exe || set "FAILED=1"
call :warn_cloakbrowser
call :warn_deepseek

if "%FAILED%"=="1" goto fail_out
if not defined QUIET echo [OK] Runtime check passed.
exit /b 0

:fail_out
if not defined QUIET (
  echo.
  echo [FAIL] Runtime not ready. Install missing components above, then retry.
  echo        Dev: run scripts\env-setup.bat to install Node/Rust.
)
exit /b 1

:check_node
where node >nul 2>&1
if errorlevel 1 goto node_missing
for /f "delims=" %%V in ('node -v 2^>nul') do (
  if not defined QUIET echo [OK] Node.js %%V
)
exit /b 0
:node_missing
echo [ERROR] Node.js not found. Sidecar requires Node.
echo         Download: https://nodejs.org/
echo         Or: winget install OpenJS.NodeJS.LTS
exit /b 1

:check_webview2
set "WV2=0"
if exist "%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application\msedgewebview2.exe" set "WV2=1"
if exist "%ProgramFiles%\Microsoft\EdgeWebView\Application\msedgewebview2.exe" set "WV2=1"
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv >nul 2>&1 && set "WV2=1"
if "%WV2%"=="1" goto wv2_ok
echo [ERROR] WebView2 runtime not found - required by Tauri UI.
echo         Download: https://developer.microsoft.com/microsoft-edge/webview2/
echo         Or: winget install Microsoft.EdgeWebView2Runtime
exit /b 1
:wv2_ok
if not defined QUIET echo [OK] WebView2 runtime found.
exit /b 0

:check_sidecar
set "SC=0"
if exist "%ROOT%sidecar\dist\index.js" if exist "%ROOT%sidecar\dist\launch.js" set "SC=1"
if exist "%ROOT%..\sidecar\dist\index.js" if exist "%ROOT%..\sidecar\dist\launch.js" set "SC=1"
if "%SC%"=="0" goto sc_missing_dist
if not exist "%ROOT%sidecar\node_modules" if not exist "%ROOT%..\sidecar\node_modules" goto sc_missing_nm
if not defined QUIET echo [OK] Sidecar runtime files OK.
exit /b 0
:sc_missing_dist
echo [ERROR] Missing sidecar runtime: sidecar\dist\index.js or launch.js
echo         Use the full portable/installer package, not exe alone.
exit /b 1
:sc_missing_nm
echo [ERROR] Missing sidecar\node_modules - Playwright/CloakBrowser deps
echo         Use the full release-dist package; do not copy only the exe.
exit /b 1

:check_app_exe
if exist "%ROOT%TianshuTai.exe" exit /b 0
if exist "%ROOT%ai-browser.exe" exit /b 0
if exist "%ROOT%..\TianshuTai.exe" exit /b 0
if exist "%ROOT%..\ai-browser.exe" exit /b 0
echo [ERROR] Main exe not found: TianshuTai.exe or ai-browser.exe
exit /b 1

:warn_cloakbrowser
set "FOUND=0"
if defined CLOAK_BROWSER_PATH if exist "!CLOAK_BROWSER_PATH!" set "FOUND=1"
if exist "%ProgramFiles%\CloakBrowser\CloakBrowser.exe" set "FOUND=1"
if exist "%LOCALAPPDATA%\CloakBrowser\CloakBrowser.exe" set "FOUND=1"
if "%FOUND%"=="1" goto cloak_ok
echo [WARN] CloakBrowser not detected. Set browser path in app Settings before launching profiles.
exit /b 0
:cloak_ok
if not defined QUIET echo [OK] CloakBrowser detected.
exit /b 0

:warn_deepseek
if defined DEEPSEEK_API_KEY goto ds_ok
echo [WARN] DEEPSEEK_API_KEY not set. AI fill needs it; pure RPA still works.
exit /b 0
:ds_ok
if not defined QUIET echo [OK] DEEPSEEK_API_KEY is set.
exit /b 0
