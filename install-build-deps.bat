@echo off
REM UTF-8 console; keep messages ASCII-safe where possible to avoid GBK parse breaks
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

REM Always run from THIS script's directory (project root). Do NOT use "%~dp0.."
cd /d "%~dp0"
if errorlevel 1 (
  echo [FAIL] Cannot cd to project root: %~dp0
  pause
  exit /b 1
)

title TianshuTai - Install Build Dependencies

REM Keep cargo target / npm cache / installer downloads off C: (see scripts\build-paths.bat)
call "scripts\build-paths.bat"

echo.
echo ================================================
echo   TianshuTai - Install Build Deps
echo   Project: %CD%
echo ================================================
echo.

if not exist "package.json" (
  echo [FAIL] package.json not found. Run this bat from the AiBrowser project root.
  pause
  exit /b 1
)
if not exist "scripts\env-setup.bat" (
  echo [FAIL] scripts\env-setup.bat missing.
  pause
  exit /b 1
)

echo [Step 1/5] Detect / install Node.js + Rust + npm packages...
call "scripts\env-setup.bat" BUILD
if errorlevel 1 goto fail

echo.
echo [Step 2/5] Load Visual Studio C++ Build Tools (needed by Tauri/Rust)...
call "scripts\env-setup.bat" VS
REM VS missing is WARN only here; build-app will remind again

echo.
echo [Step 3/5] Install / verify WebView2 runtime...
call "scripts\env-setup.bat" WEBVIEW2
REM non-fatal for packaging host, but end users need it

echo.
echo [Step 4/5] Prepare Sidecar runtime (npm install + tsc)...
call "scripts\prepare-sidecar-runtime.bat"
if errorlevel 1 goto fail

echo.
echo [Step 5/5] Ensure root node_modules has @tauri-apps/cli...
if not exist "node_modules\@tauri-apps\cli" (
  echo [INFO] Installing root npm deps again...
  call npm.cmd install --registry=https://registry.npmmirror.com
  if errorlevel 1 call npm.cmd install
  if errorlevel 1 goto fail
)

echo.
echo ================================================
echo [DONE] Build dependencies are ready.
echo   Next: double-click build-app.bat to package.
echo   Output will be in release-dist\
echo ================================================
echo.
pause
exit /b 0

:fail
echo.
echo [FAIL] Dependency install incomplete. Read errors above, then retry.
echo   Manual installs:
echo     Node LTS : https://nodejs.org/  or  winget install OpenJS.NodeJS.LTS
echo     Rust     : https://rustup.rs/   or  winget install Rustlang.Rustup
echo     VS C++   : https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo     WebView2 : winget install Microsoft.EdgeWebView2Runtime
echo.
pause
exit /b 1
