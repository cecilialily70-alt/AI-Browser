@echo off
REM Bundle all local kernels (free + pro) into a package's Browse\ dir.
REM Usage: copy-browse-kernels.bat <dest_root>
REM ASCII-only: kernels are located via chromium-* wildcards (works for Browse\ or any
REM Chinese-named local dir like the dev kernel folder). Soft-fail if none found.
setlocal EnableExtensions EnableDelayedExpansion

set "DEST=%~1"
if "%DEST%"=="" (
  echo [WARN] copy-browse-kernels: missing destination
  exit /b 0
)

set "ROOT=%~dp0.."
if not exist "%DEST%\Browse" mkdir "%DEST%\Browse" >nul 2>&1

set /a COUNT=0

REM 1) kernels directly under project root
for /d %%K in ("%ROOT%\chromium-*") do call :bundle "%%K"

REM 2) kernels one level deep (covers Browse\, 内核\, any local kernel folder)
for /d %%D in ("%ROOT%\*") do (
  for /d %%K in ("%%D\chromium-*") do call :bundle "%%K"
)

if "%COUNT%"=="0" (
  echo [WARN] No chromium-* kernel with chrome.exe found under project root - skip bundling kernels
  exit /b 0
)

echo [OK] Bundled %COUNT% kernel(s) into %DEST%\Browse\
exit /b 0

:bundle
if exist "%~1\chrome.exe" (
  echo [INFO] Bundling kernel: %~nx1
  xcopy /E /I /Y "%~1" "%DEST%\Browse\%~nx1\" >nul
  if not errorlevel 1 set /a COUNT+=1
)
exit /b 0
