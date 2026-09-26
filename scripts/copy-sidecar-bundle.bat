@echo off
setlocal EnableDelayedExpansion
set "SRC=%~dp0..\sidecar"
set "DEST=%~1"
if "%DEST%"=="" (
  echo [ERROR] usage: copy-sidecar-bundle.bat ^<target-dir^>
  exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1
set "TARGET=%DEST%\sidecar"
if exist "%TARGET%" rmdir /s /q "%TARGET%" >nul 2>&1
mkdir "%TARGET%" >nul 2>&1

echo [Pack] copying sidecar dist...
xcopy /E /I /Y "%SRC%\dist" "%TARGET%\dist\" >nul
if errorlevel 1 (
  echo [ERROR] failed to copy sidecar\dist
  exit /b 1
)

echo [Pack] copying sidecar node_modules (may take a minute)...
xcopy /E /I /Y "%SRC%\node_modules" "%TARGET%\node_modules\" >nul
if errorlevel 1 (
  echo [ERROR] failed to copy sidecar\node_modules
  exit /b 1
)

copy /Y "%SRC%\package.json" "%TARGET%\" >nul
if exist "%SRC%\package-lock.json" copy /Y "%SRC%\package-lock.json" "%TARGET%\" >nul

REM Runtime data folders: without these the sidecar silently degrades.
REM - config\        : lexicons/policies (HITL risk, deliverable, hits, OTP providers...)
REM - agent_skills\ : local skill packs (account-lifecycle, commerce-checkout...)
echo [Pack] copying sidecar config...
xcopy /E /I /Y "%SRC%\config" "%TARGET%\config\" >nul
if errorlevel 1 (
  echo [ERROR] failed to copy sidecar\config
  exit /b 1
)

echo [Pack] copying sidecar agent_skills...
xcopy /E /I /Y "%SRC%\agent_skills" "%TARGET%\agent_skills\" >nul
if errorlevel 1 (
  echo [ERROR] failed to copy sidecar\agent_skills
  exit /b 1
)

echo [OK] sidecar bundle copied to %TARGET%
exit /b 0
