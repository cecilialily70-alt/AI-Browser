@echo off
REM ===========================================================================
REM TianshuTai - shared build/output locations.
REM Goal: keep ALL heavy build artifacts and downloads OFF the system drive (C:).
REM
REM Called with "call" and deliberately WITHOUT setlocal, so the variables below
REM persist into the caller's scope (start-app.bat / build-app.bat / ...).
REM
REM Single knob: set TIANSHUTAI_BUILD_ROOT before calling to move everything.
REM The derived variables are set unconditionally on purpose - an inherited
REM CARGO_TARGET_DIR / NPM_CONFIG_CACHE must NOT be able to drag builds back to C:.
REM ===========================================================================

REM Build root sits NEXT TO the project folder: <drive>\Browser -> <drive>\temp
REM (drive-agnostic: moving the repo keeps every build artifact on the same disk)
if not defined TIANSHUTAI_BUILD_ROOT set "TIANSHUTAI_BUILD_ROOT=%~dp0..\..\temp"

REM Rust/Tauri target dir. cargo AND the tauri CLI both honor CARGO_TARGET_DIR.
REM This is the big one: a release target tree is ~9 GB.
set "CARGO_TARGET_DIR=%TIANSHUTAI_BUILD_ROOT%\ai-browser-target"
if not exist "%CARGO_TARGET_DIR%" mkdir "%CARGO_TARGET_DIR%" >nul 2>&1

REM npm cache (otherwise %LOCALAPPDATA%\npm-cache, i.e. C:)
set "NPM_CONFIG_CACHE=%TIANSHUTAI_BUILD_ROOT%\npm-cache"
if not exist "%NPM_CONFIG_CACHE%" mkdir "%NPM_CONFIG_CACHE%" >nul 2>&1

REM Download staging for the env installers (Node / Rust payloads)
set "TIANSHUTAI_DL_DIR=%TIANSHUTAI_BUILD_ROOT%\downloads"
if not exist "%TIANSHUTAI_DL_DIR%" mkdir "%TIANSHUTAI_DL_DIR%" >nul 2>&1

REM Scratch dir for toolchain temp files (NSIS staging, linker scratch, ...).
REM Scoped to this build session only - the machine-wide %TEMP% is untouched.
set "TIANSHUTAI_SCRATCH=%TIANSHUTAI_BUILD_ROOT%\scratch"
if not exist "%TIANSHUTAI_SCRATCH%" mkdir "%TIANSHUTAI_SCRATCH%" >nul 2>&1
if exist "%TIANSHUTAI_SCRATCH%" (
  set "TEMP=%TIANSHUTAI_SCRATCH%"
  set "TMP=%TIANSHUTAI_SCRATCH%"
)

exit /b 0
