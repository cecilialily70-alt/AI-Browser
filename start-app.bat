@echo off
setlocal EnableDelayedExpansion
pushd "%~dp0"

REM Keep the cargo/target tree + npm cache off C: (see scripts\build-paths.bat)
call "scripts\build-paths.bat"
if errorlevel 1 goto fail

call "scripts\env-setup.bat" RUN
if errorlevel 1 goto fail

echo.
echo [TianshuTai] Sidecar setup...
if not exist "sidecar\node_modules" goto sidecar_install
goto sidecar_build_check

:sidecar_install
echo [INFO] sidecar npm install...
pushd sidecar
call npm.cmd install
if errorlevel 1 goto sidecar_install_fail
popd

:sidecar_build_check
if exist "sidecar\dist\index.js" if exist "sidecar\dist\launch.js" if exist "sidecar\dist\chat.js" goto tauri_dev
echo [INFO] sidecar build...
pushd sidecar
call npm.cmd run build
if errorlevel 1 goto sidecar_build_fail
popd

:tauri_dev
echo.
echo [TianshuTai] freeing port 5173 if occupied...
for /f "tokens=5" %%P in ('netstat -aon ^| findstr ":5173" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >nul 2>&1
)
timeout /t 2 /nobreak >nul
if exist "node_modules\.vite" (
  echo [INFO] clearing vite dep cache...
  rmdir /s /q "node_modules\.vite" >nul 2>&1
)
echo.
echo [TianshuTai] starting tauri dev (auto rebuilds rust + hot reload)...
call "scripts\env-setup.bat" VS
set "CARGO_TARGET_DIR=%CARGO_TARGET_DIR%"
call npm.cmd run tauri -- dev
if errorlevel 1 goto tauri_fail

popd
exit /b 0

:sidecar_install_fail
popd
echo [ERROR] sidecar npm install failed. Run manually: cd sidecar ^&^& npm install
goto fail

:sidecar_build_fail
popd
echo [ERROR] sidecar build failed.
goto fail

:tauri_fail
echo [ERROR] tauri dev failed.
echo [TIP] If project path contains non-ASCII chars, copy to an ASCII path (e.g. D:\AiBrowser) and retry.
goto fail

:fail
popd
pause
exit /b 1
