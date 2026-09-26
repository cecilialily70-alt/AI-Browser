@echo off
REM ASCII-only batch to avoid cmd parenthesis / UTF-8 parse breakage.
setlocal EnableExtensions
pushd "%~dp0"

title TianshuTai - Portable Release Build

set "RELEASE_DIR=%CD%\release-dist"
set "PORTABLE_DIR=%RELEASE_DIR%\portable"

REM All build artifacts live next to the project drive, never on C:.
call "scripts\build-paths.bat"
if errorlevel 1 goto fail

if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%" >nul 2>&1
mkdir "%PORTABLE_DIR%" >nul 2>&1

echo.
echo ================================================
echo   TianshuTai - One-click Portable Package
echo   Output : %PORTABLE_DIR%
echo ================================================
echo.

if not exist "package.json" (
  echo [FAIL] Run build-app.bat from project root.
  goto fail
)

echo [Step 1/7] Check / install build environment...
call "scripts\env-setup.bat" BUILD
if errorlevel 1 goto fail
call "scripts\env-setup.bat" VS

echo.
echo [Step 2/7] Prepare Sidecar runtime...
call "scripts\prepare-sidecar-runtime.bat"
if errorlevel 1 goto fail

echo.
echo [Step 3/7] Frontend production build...
call npm.cmd run build
if errorlevel 1 goto frontend_fail

echo.
echo [Step 4/7] Tauri release build. This may take 5-15 minutes...
REM Frontend was already built in Step 3; tauri.conf beforeBuildCommand is null.
REM Raise Node heap so tauri CLI / esbuild workers do not hit commit-limit OOM.
set "NODE_OPTIONS=--max-old-space-size=4096"
set "CARGO_TARGET_DIR=%CARGO_TARGET_DIR%"
call npm.cmd run tauri -- build
if errorlevel 1 goto tauri_fail

echo.
echo [Step 5/7] Assemble PORTABLE package...
set "EXE_SRC="
if exist "%CARGO_TARGET_DIR%\release\ai-browser.exe" set "EXE_SRC=%CARGO_TARGET_DIR%\release\ai-browser.exe"
if not defined EXE_SRC if exist "src-tauri\target\release\ai-browser.exe" set "EXE_SRC=src-tauri\target\release\ai-browser.exe"

REM productName may produce a Unicode exe name; probe via dir /b
if not defined EXE_SRC (
  for /f "delims=" %%F in ('dir /b "%CARGO_TARGET_DIR%\release\*.exe" 2^>nul') do (
    if /I not "%%F"=="ai-browser_lib.exe" if not defined EXE_SRC set "EXE_SRC=%CARGO_TARGET_DIR%\release\%%F"
  )
)
if not defined EXE_SRC (
  for /f "delims=" %%F in ('dir /b "src-tauri\target\release\*.exe" 2^>nul') do (
    if /I not "%%F"=="ai-browser_lib.exe" if not defined EXE_SRC set "EXE_SRC=src-tauri\target\release\%%F"
  )
)

if not defined EXE_SRC (
  echo [ERROR] Main exe not found after Tauri build.
  goto fail
)

echo [INFO] Using exe: %EXE_SRC%
copy /Y "%EXE_SRC%" "%PORTABLE_DIR%\ai-browser.exe" >nul
copy /Y "%EXE_SRC%" "%PORTABLE_DIR%\TianshuTai.exe" >nul
echo [OK] Main exe copied to portable\

call "scripts\copy-sidecar-bundle.bat" "%PORTABLE_DIR%"
if errorlevel 1 goto fail

if exist "extensions" (
  xcopy /E /I /Y "extensions" "%PORTABLE_DIR%\extensions\" >nul
  echo [OK] extensions copied
)

REM Bundle ALL offline kernels (free 146 + pro 151) from local runtime dir (Browse or dev kernel folder)
call "scripts\copy-browse-kernels.bat" "%PORTABLE_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\packaging\copy-guide.ps1" "%PORTABLE_DIR%"
if exist "src-tauri\icons\icon.ico" copy /Y "src-tauri\icons\icon.ico" "%PORTABLE_DIR%\" >nul

copy /Y "scripts\check-runtime.bat" "%PORTABLE_DIR%\" >nul
copy /Y "scripts\release-launcher.bat" "%PORTABLE_DIR%\Start-TianshuTai.bat" >nul
if not exist "%PORTABLE_DIR%\scripts" mkdir "%PORTABLE_DIR%\scripts" >nul 2>&1
if exist "scripts\install-twp-extension.ps1" copy /Y "scripts\install-twp-extension.ps1" "%PORTABLE_DIR%\scripts\" >nul
copy /Y "scripts\packaging\README-portable.txt" "%PORTABLE_DIR%\README.txt" >nul
echo [OK] Portable package assembled: %PORTABLE_DIR%

REM ---------------------------------------------------------------------------
REM Completeness gate. The sidecar silently degrades when runtime data folders
REM are missing: without sidecar\config the HITL risk lexicon falls back to the
REM English-only minimal set, and without sidecar\agent_skills every skill lookup
REM fails. Both produced a package that LOOKED fine and shipped broken, so the
REM build must fail loudly instead of writing a partial portable folder.
REM ---------------------------------------------------------------------------
echo.
echo [Step 6/7] Verify portable package completeness...
set "PKG_FAIL=0"

call :REQ_FILE "%PORTABLE_DIR%\TianshuTai.exe" "Main exe"
call :REQ_FILE "%PORTABLE_DIR%\Start-TianshuTai.bat" "Portable launcher"
call :REQ_FILE "%PORTABLE_DIR%\check-runtime.bat" "Runtime check script"
call :REQ_FILE "%PORTABLE_DIR%\sidecar\dist\index.js" "Sidecar entry"
call :REQ_FILE "%PORTABLE_DIR%\sidecar\dist\launch.js" "Sidecar launch script"
call :REQ_FILE "%PORTABLE_DIR%\sidecar\dist\chat.js" "Sidecar chat entry"
call :REQ_FILE "%PORTABLE_DIR%\sidecar\dist\binary_cli.js" "Sidecar kernel CLI"
call :REQ_FILE "%PORTABLE_DIR%\sidecar\package.json" "Sidecar package.json"
call :REQ_DIR "%PORTABLE_DIR%\sidecar\node_modules\playwright-core" "Sidecar dependency playwright-core"
call :REQ_DIR "%PORTABLE_DIR%\sidecar\node_modules\cloakbrowser" "Sidecar dependency cloakbrowser"
call :REQ_GLOB "%PORTABLE_DIR%\sidecar\config" "*.json" "Sidecar config lexicons/policies -- missing means HITL and deliverable gates silently degrade"
call :REQ_RECURSE "%PORTABLE_DIR%\sidecar\config" "action_risk_lexicon.json" "HITL risk lexicon -- missing falls back to an English-only word list"
call :REQ_RECURSE "%PORTABLE_DIR%\sidecar\config" "human_credential_lexicon.json" "human credential lexicon -- missing makes the external data API stop refusing OTP fields"
call :REQ_RECURSE "%PORTABLE_DIR%\sidecar\agent_skills" "SKILL.md" "Sidecar agent skill packs -- missing means the Agent reports unknown skill_id"
call :REQ_FILE "%PORTABLE_DIR%\sidecar\agent_skills\press-hold-captcha\SKILL.md" "press-hold captcha skill pack -- required by the long-press solver's skill index"

call :WARN_DIR "%PORTABLE_DIR%\extensions" "browser extensions"
call :WARN_GLOB "%PORTABLE_DIR%\Browse" "chromium-*" "local kernels under Browse"

if not "%PKG_FAIL%"=="0" (
  echo.
  echo [ERROR] Portable package is INCOMPLETE -- see [MISSING] lines above.
  echo         Fix the packaging step, then rebuild. Do not ship this build.
  goto fail
)
echo [OK] Portable package verified.

echo.
echo [Step 7/7] Write root README...
copy /Y "scripts\packaging\README-root.txt" "%RELEASE_DIR%\README.txt" >nul

echo.
echo ================================================
echo [DONE] Portable package ready
echo   Folder : %PORTABLE_DIR%
echo   Run    : Start-TianshuTai.bat
echo   Zip the portable folder for distribution.
echo ================================================
echo.

popd
pause
exit /b 0

:frontend_fail
echo [ERROR] Frontend build failed.
goto fail

:tauri_fail
echo [ERROR] Tauri/Rust build failed.
echo [TIP] Install VS C++ Build Tools
echo [TIP] Prefer ASCII project path like D:\AiBrowser
echo [TIP] Check cargo/npm network
goto fail

:fail
popd
pause
exit /b 1

REM ===================== packaging self-check helpers =====================
REM Plain subroutines: no setlocal, so PKG_FAIL survives back to the caller.
REM Keep every echo line free of parentheses - cmd parses broken blocks otherwise.

:REQ_FILE
if exist "%~1" exit /b 0
echo [MISSING] %~2 -- expected file: %~1
set "PKG_FAIL=1"
exit /b 0

:REQ_DIR
if exist "%~1" exit /b 0
echo [MISSING] %~2 -- expected folder: %~1
set "PKG_FAIL=1"
exit /b 0

:REQ_GLOB
if exist "%~1\%~2" exit /b 0
echo [MISSING] %~3 -- expected %~2 under: %~1
set "PKG_FAIL=1"
exit /b 0

REM Recursive lookup: skill packs live at agent_skills\<id>\SKILL.md, so a flat
REM "if exist" on the folder itself would always miss them.
:REQ_RECURSE
where /r "%~1" "%~2" >nul 2>&1
if not errorlevel 1 exit /b 0
echo [MISSING] %~3 -- no %~2 found under: %~1
set "PKG_FAIL=1"
exit /b 0

:WARN_DIR
if exist "%~1" exit /b 0
echo [WARN] %~2 not bundled -- %~1
exit /b 0

:WARN_GLOB
if exist "%~1\%~2" exit /b 0
echo [WARN] %~3 not bundled -- no %~2 under %~1
exit /b 0
