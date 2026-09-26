@echo off
REM ASCII-only portable launcher. Keep window open on failure.
setlocal
pushd "%~dp0"

echo.
echo ========================================
echo   TianshuTai - Local Fingerprint Browser
echo ========================================
echo.

call "%~dp0check-runtime.bat"
if errorlevel 1 goto fail

set "APP="
if exist "%~dp0TianshuTai.exe" set "APP=%~dp0TianshuTai.exe"
if not defined APP if exist "%~dp0ai-browser.exe" set "APP=%~dp0ai-browser.exe"

if not defined APP (
  echo [ERROR] Main exe not found in this folder.
  echo         Expected: TianshuTai.exe or ai-browser.exe
  goto fail
)

if not exist "%~dp0sidecar\dist\launch.js" (
  echo [ERROR] Missing sidecar\dist\launch.js next to the exe.
  echo         Please run from the extracted TianshuTai folder.
  goto fail
)

echo [INFO] Starting %APP% ...
start "" /D "%~dp0" "%APP%"
if errorlevel 1 (
  echo [ERROR] Failed to start the application.
  goto fail
)
popd
exit /b 0

:fail
echo.
echo [FAIL] Launcher stopped. See messages above.
pause
popd
exit /b 1
