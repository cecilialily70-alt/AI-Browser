@echo off
setlocal EnableDelayedExpansion
pushd "%~dp0..\sidecar"

echo [Sidecar] preparing runtime (install + build)...

if not exist "package.json" (
  echo [ERROR] sidecar\package.json not found.
  popd
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] sidecar npm install...
  call npm.cmd install --registry=https://registry.npmmirror.com
  if errorlevel 1 (
    echo [WARN] mirror failed, retry default registry...
    call npm.cmd install
  )
  if errorlevel 1 (
    echo [ERROR] sidecar npm install failed.
    popd
    exit /b 1
  )
) else (
  echo [OK] sidecar node_modules exists, skip install.
)

echo [INFO] sidecar tsc build...
call npm.cmd run build
if errorlevel 1 (
  echo [ERROR] sidecar build failed.
  popd
  exit /b 1
)

set "MISSING=0"
if not exist "dist\index.js" set "MISSING=1" & echo [ERROR] missing dist\index.js
if not exist "dist\launch.js" set "MISSING=1" & echo [ERROR] missing dist\launch.js
if not exist "dist\chat.js" set "MISSING=1" & echo [ERROR] missing dist\chat.js
if not exist "dist\binary_cli.js" set "MISSING=1" & echo [ERROR] missing dist\binary_cli.js
if not exist "node_modules\playwright-core" set "MISSING=1" & echo [ERROR] missing playwright-core
if not exist "node_modules\cloakbrowser" set "MISSING=1" & echo [ERROR] missing cloakbrowser

if "%MISSING%"=="1" (
  popd
  exit /b 1
)

echo [OK] sidecar runtime ready.
popd
exit /b 0
