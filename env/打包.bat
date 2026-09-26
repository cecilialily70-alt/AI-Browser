@echo off
REM ============================================================
REM  TianshuTai Env Installer - one click exe builder
REM  Keep this file ASCII-only (cmd breaks on UTF-8 chinese).
REM  Output: chinese-named single exe, no console window
REM ============================================================
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title TianshuTai Env Installer - Build EXE

echo ================================================
echo   Build  TianshuTai Env Installer  EXE
echo   Folder: %~dp0
echo ================================================
echo.

REM ---- 1. locate the single python source in this folder ----
set "SRC="
set /a PYN=0
for %%F in ("%~dp0*.py") do (
  if exist "%%~fF" (
    set "SRC=%%~fF"
    set /a PYN+=1
  )
)
if not defined SRC (
  echo [FAIL] No .py source found in this folder.
  goto end
)
if %PYN% GTR 1 (
  echo [FAIL] More than one .py file found. Keep only one .py in this folder.
  goto end
)
echo [INFO] Source : %SRC%

REM ---- 2. locate python ----
set "PY="
where py >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>&1
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo [FAIL] Python 3 not found. Install it first: https://www.python.org/downloads/
  goto end
)
echo [INFO] Python : %PY%

REM ---- 3. make sure PyInstaller is available ----
set "PI_OK=0"
%PY% -m PyInstaller --version >nul 2>&1
if not errorlevel 1 set "PI_OK=1"
if "%PI_OK%"=="0" (
  echo [INFO] Installing PyInstaller, please wait ...
  %PY% -m pip install --upgrade pip --quiet
  %PY% -m pip install --upgrade pyinstaller
  %PY% -m PyInstaller --version >nul 2>&1
  if errorlevel 1 (
    echo [INFO] Retry with mirror ...
    %PY% -m pip install --upgrade pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple
    %PY% -m PyInstaller --version >nul 2>&1
  )
)
%PY% -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
  echo [FAIL] PyInstaller is not available. Check network, then run this file again.
  goto end
)
for /f "delims=" %%V in ('%PY% -m PyInstaller --version 2^>nul') do echo [INFO] PyInstaller: %%V

REM ---- 4. build ----
echo.
echo [INFO] Building exe, this may take 1-3 minutes ...
echo.
%PY% "%SRC%" --build
if errorlevel 1 (
  echo.
  echo [FAIL] Build failed. Read the messages above.
  goto end
)

echo.
echo ================================================
echo [DONE] EXE ready in this folder.
echo        Name: TianshuTai-Env-Setup exe ^(chinese name^)
echo.
echo Usage: copy the exe into the TianshuTai folder
echo        and let users double-click it.
echo ================================================

:end
echo.
pause
exit /b 0
