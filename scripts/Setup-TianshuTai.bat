@echo off
REM Launches the PowerShell installer wizard. Keep this file ASCII-only.
setlocal
pushd "%~dp0"

echo.
echo ================================================
echo   TianshuTai Installer Wizard
echo ================================================
echo.

set "PAYLOAD=%~dp0payload"
if not exist "%PAYLOAD%\TianshuTai.exe" if not exist "%PAYLOAD%\ai-browser.exe" (
  if exist "%~dp0..\portable\TianshuTai.exe" set "PAYLOAD=%~dp0..\portable"
  if exist "%~dp0..\portable\ai-browser.exe" set "PAYLOAD=%~dp0..\portable"
)

if not exist "%~dp0scripts\installer-wizard.ps1" (
  echo [ERROR] Missing scripts\installer-wizard.ps1
  pause
  popd
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\installer-wizard.ps1" -PayloadDir "%PAYLOAD%"
set "ERR=%ERRORLEVEL%"
popd
if not "%ERR%"=="0" (
  echo.
  echo [ERROR] Installer finished with code %ERR%
  pause
)
exit /b %ERR%
