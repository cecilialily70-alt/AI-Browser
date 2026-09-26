@echo off
chcp 65001 >nul 2>&1
set "MODE=%~1"
if "%MODE%"=="" set "MODE=RUN"

REM VS mode: no setlocal so VsDevCmd PATH persists to parent
if /I "%MODE%"=="VS" goto LOAD_VS

setlocal EnableDelayedExpansion
goto MAIN

REM ===================== subroutines =====================

:REFRESH_PATHS
if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
exit /b 0

:ENSURE_NODE
call :REFRESH_PATHS
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%V in ('node -v 2^>nul') do echo [OK] Node.js %%V
  exit /b 0
)
echo [WARN] Node.js not found. Trying auto-install...
where winget >nul 2>&1
if not errorlevel 1 (
  echo [INFO] winget install OpenJS.NodeJS.LTS ...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  call :REFRESH_PATHS
  where node >nul 2>&1
  if not errorlevel 1 (
    for /f "delims=" %%V in ('node -v 2^>nul') do echo [OK] Node.js %%V via winget
    exit /b 0
  )
)
echo [INFO] Downloading Node.js LTS MSI...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1"
call :REFRESH_PATHS
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%V in ('node -v 2^>nul') do echo [OK] Node.js %%V via MSI
  exit /b 0
)
echo [ERROR] Node.js install failed. https://nodejs.org/  or  winget install OpenJS.NodeJS.LTS
exit /b 1

:ENSURE_RUST
call :REFRESH_PATHS
where cargo >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%V in ('cargo -V 2^>nul') do echo [OK] %%V
  exit /b 0
)
echo [WARN] Rust not found. Trying auto-install...
where winget >nul 2>&1
if not errorlevel 1 (
  echo [INFO] winget install Rustlang.Rustup ...
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
  call :REFRESH_PATHS
  if exist "%USERPROFILE%\.cargo\bin\rustup.exe" call "%USERPROFILE%\.cargo\bin\rustup.exe" default stable >nul 2>&1
  where cargo >nul 2>&1
  if not errorlevel 1 (
    echo [OK] Rust via winget
    exit /b 0
  )
)
echo [INFO] Downloading rustup-init...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-rust.ps1"
call :REFRESH_PATHS
where cargo >nul 2>&1
if not errorlevel 1 (
  echo [OK] Rust via rustup-init
  exit /b 0
)
echo [ERROR] Rust install failed. https://rustup.rs/  or  winget install Rustlang.Rustup
exit /b 1

:ENSURE_VS_TOOLS
set "HAS_VS=0"
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 >nul 2>&1
  if not errorlevel 1 set "HAS_VS=1"
)
if "%HAS_VS%"=="1" (
  echo [OK] Visual Studio C++ tools detected.
  exit /b 0
)
echo [WARN] VS C++ Build Tools missing. Trying winget...
where winget >nul 2>&1
if errorlevel 1 (
  echo [WARN] Install manually: https://visualstudio.microsoft.com/visual-cpp-build-tools/
  exit /b 0
)
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
if errorlevel 1 (
  echo [WARN] Auto-install VS Build Tools failed. Install manually before build-app.bat.
  exit /b 0
)
echo [OK] VS Build Tools install requested.
exit /b 0

:ENSURE_WEBVIEW2
set "WV2=0"
if exist "%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application\msedgewebview2.exe" set "WV2=1"
if exist "%ProgramFiles%\Microsoft\EdgeWebView\Application\msedgewebview2.exe" set "WV2=1"
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv >nul 2>&1 && set "WV2=1"
if "%WV2%"=="1" (
  echo [OK] WebView2 runtime detected.
  exit /b 0
)
echo [WARN] WebView2 not found. Trying winget...
where winget >nul 2>&1
if not errorlevel 1 (
  winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements
)
set "WV2=0"
if exist "%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application\msedgewebview2.exe" set "WV2=1"
if exist "%ProgramFiles%\Microsoft\EdgeWebView\Application\msedgewebview2.exe" set "WV2=1"
if "%WV2%"=="1" (
  echo [OK] WebView2 installed.
  exit /b 0
)
echo [WARN] WebView2 still missing: winget install Microsoft.EdgeWebView2Runtime
exit /b 0

:NPM_INSTALL_ROOT
echo [INFO] npm install at project root...
pushd "%~dp0.."
if not exist "package.json" (
  echo [ERROR] package.json not found in %CD%
  popd
  exit /b 1
)
call npm.cmd install --registry=https://registry.npmmirror.com
if errorlevel 1 call npm.cmd install
set "RC=!errorlevel!"
popd
if not "!RC!"=="0" (
  echo [ERROR] npm install failed.
  exit /b 1
)
echo [OK] npm install done.
exit /b 0

:WARN_CLOAK
set "FOUND_CLOAK=0"
if defined CLOAK_BROWSER_PATH if exist "!CLOAK_BROWSER_PATH!" set "FOUND_CLOAK=1"
if exist "%ProgramFiles%\CloakBrowser\CloakBrowser.exe" set "FOUND_CLOAK=1"
if exist "%LOCALAPPDATA%\CloakBrowser\CloakBrowser.exe" set "FOUND_CLOAK=1"
if "%FOUND_CLOAK%"=="1" (echo [OK] CloakBrowser detected.) else (echo [WARN] CloakBrowser not found. Set path in app Settings.)
exit /b 0

:WARN_DEEPSEEK
if defined DEEPSEEK_API_KEY (echo [OK] DEEPSEEK_API_KEY is set.) else (echo [WARN] DEEPSEEK_API_KEY not set. AI fill needs it.)
exit /b 0

REM ===================== main =====================

:MAIN
call :REFRESH_PATHS
echo [ENV] TianshuTai environment check (%MODE%)...
echo [ENV] scripts dir: %~dp0

if /I "%MODE%"=="WEBVIEW2" (
  call :ENSURE_WEBVIEW2
  exit /b %errorlevel%
)

if /I "%MODE%"=="USER" (
  call :ENSURE_NODE
  if errorlevel 1 exit /b 1
  call :ENSURE_WEBVIEW2
  exit /b %errorlevel%
)

if /I "%MODE%"=="RUN" (
  call :ENSURE_NODE
  if errorlevel 1 exit /b 1
  if not exist "%~dp0..\node_modules\@tauri-apps\cli" (
    call :NPM_INSTALL_ROOT
    if errorlevel 1 exit /b 1
  )
  call :WARN_CLOAK
  call :WARN_DEEPSEEK
  echo [ENV] checks passed.
  exit /b 0
)

if /I "%MODE%"=="BUILD" (
  call :ENSURE_NODE
  if errorlevel 1 exit /b 1
  call :ENSURE_RUST
  if errorlevel 1 exit /b 1
  call :ENSURE_VS_TOOLS
  call :NPM_INSTALL_ROOT
  if errorlevel 1 exit /b 1
  call :WARN_CLOAK
  call :WARN_DEEPSEEK
  echo [ENV] checks passed.
  exit /b 0
)

call :WARN_CLOAK
call :WARN_DEEPSEEK
echo [ENV] checks passed.
exit /b 0

:LOAD_VS
set "VSDEVCMD="
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  for /f "usebackq delims=" %%I in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find Common7\Tools\VsDevCmd.bat 2^>nul`) do set "VSDEVCMD=%%I"
)
if defined VSDEVCMD (
  call "%VSDEVCMD%" -arch=amd64 >nul 2>&1
  echo [OK] Visual Studio C++ build environment loaded.
  exit /b 0
)
echo [WARN] Visual Studio C++ Build Tools not found.
echo        winget install Microsoft.VisualStudio.2022.BuildTools
echo        https://visualstudio.microsoft.com/visual-cpp-build-tools/
exit /b 0
