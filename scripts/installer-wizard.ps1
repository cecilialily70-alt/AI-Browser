#Requires -Version 5.1
<#
.SYNOPSIS
  天枢台安装向导：检查运行环境 → 静默安装缺失组件 → 复制程序文件。
#>
param(
  [string]$PayloadDir = "",
  [string]$DefaultInstallDir = "$env:LOCALAPPDATA\TianshuTai"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "======== $msg ========" -ForegroundColor Cyan
}

function Pause-Next([string]$hint = "按 Enter 继续下一步...") {
  Write-Host ""
  Write-Host $hint -ForegroundColor Yellow
  [void](Read-Host)
}

function Test-Node {
  try {
    $v = & node -v 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { return @{ Ok = $true; Detail = "Node.js $v" } }
  } catch {}
  return @{ Ok = $false; Detail = "未安装 Node.js（Sidecar 必需）" }
}

function Test-WebView2 {
  $paths = @(
    "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application\msedgewebview2.exe",
    "$env:ProgramFiles\Microsoft\EdgeWebView\Application\msedgewebview2.exe"
  )
  foreach ($p in $paths) {
    if (Test-Path $p) { return @{ Ok = $true; Detail = "WebView2 已安装" } }
  }
  $reg = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  if (Test-Path $reg) {
    try {
      $pv = (Get-ItemProperty $reg -ErrorAction Stop).pv
      if ($pv) { return @{ Ok = $true; Detail = "WebView2 $pv" } }
    } catch {}
  }
  return @{ Ok = $false; Detail = "未安装 WebView2 运行库（界面必需）" }
}

function Install-NodeSilent {
  Write-Host "[安装] Node.js LTS（静默）..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189) { return $true } # already installed
  }
  Write-Host "[WARN] winget 安装 Node 失败，请手动安装: https://nodejs.org/" -ForegroundColor Yellow
  return $false
}

function Install-WebView2Silent {
  Write-Host "[安装] WebView2 Runtime（静默）..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install -e --id Microsoft.EdgeWebView2Runtime --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189) { return $true }
  }
  $tmp = Join-Path $env:TEMP "MicrosoftEdgeWebView2Setup.exe"
  try {
    Write-Host "[下载] WebView2 Evergreen Bootstrapper..."
    Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $tmp -UseBasicParsing
    Start-Process -FilePath $tmp -ArgumentList "/silent","/install" -Wait -NoNewWindow
    return $true
  } catch {
    Write-Host "[WARN] WebView2 自动安装失败: $_" -ForegroundColor Yellow
    return $false
  }
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

# ---- resolve payload ----
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $PayloadDir) {
  $cand = @(
    (Join-Path $ScriptRoot "..\payload"),
    (Join-Path $ScriptRoot "..\..\portable"),
    (Join-Path $ScriptRoot "..")
  )
  foreach ($c in $cand) {
    $full = [IO.Path]::GetFullPath($c)
    if ((Test-Path (Join-Path $full "TianshuTai.exe")) -or (Test-Path (Join-Path $full "ai-browser.exe"))) {
      $PayloadDir = $full
      break
    }
  }
}
if (-not $PayloadDir -or -not (Test-Path $PayloadDir)) {
  Write-Host "[ERROR] 找不到安装包 payload（需含 TianshuTai.exe 与 sidecar）" -ForegroundColor Red
  Pause-Next "按 Enter 退出"
  exit 1
}
$PayloadDir = [IO.Path]::GetFullPath($PayloadDir)

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  天枢台 安装向导" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host "安装包内容目录: $PayloadDir"

# ---- Step 0: 使用说明 ----
Write-Step "第 1 步 / 共 4 步：使用说明"
$guide = Join-Path $PayloadDir "使用说明.txt"
if (-not (Test-Path $guide)) { $guide = Join-Path $ScriptRoot "..\使用说明.txt" }
if (Test-Path $guide) {
  Write-Host ""
  Write-Host "—— 功能简介（节选）——" -ForegroundColor Gray
  Get-Content -Path $guide -Encoding UTF8 -TotalCount 60 | ForEach-Object { Write-Host $_ }
  Write-Host "..."
  Write-Host "完整说明见安装后目录中的「使用说明.txt」" -ForegroundColor Gray
} else {
  Write-Host "（未找到使用说明.txt，继续安装）"
}
Pause-Next "阅读完毕后按 Enter 进入环境检查..."

# ---- Step 1: env check ----
Write-Step "第 2 步 / 共 4 步：检查运行环境"
$node = Test-Node
$wv2 = Test-WebView2
$missing = @()

if ($node.Ok) { Write-Host "[OK] $($node.Detail)" -ForegroundColor Green } else {
  Write-Host "[缺少] $($node.Detail)" -ForegroundColor Red
  $missing += "Node.js LTS"
}
if ($wv2.Ok) { Write-Host "[OK] $($wv2.Detail)" -ForegroundColor Green } else {
  Write-Host "[缺少] $($wv2.Detail)" -ForegroundColor Red
  $missing += "WebView2 Runtime"
}

if ($missing.Count -eq 0) {
  Write-Host ""
  Write-Host "环境已就绪，无需额外安装组件。" -ForegroundColor Green
  Pause-Next
} else {
  Write-Host ""
  Write-Host "检测到缺少：" -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host "  - $_" }
  Write-Host ""
  Write-Host "点击下一步将尝试「静默安装」上述组件（可能需要管理员权限 / 联网）。" -ForegroundColor Yellow
  Pause-Next "按 Enter 开始静默安装..."

  Write-Step "正在静默安装缺失组件"
  if ($missing -contains "Node.js LTS") {
    [void](Install-NodeSilent)
    Refresh-Path
  }
  if ($missing -contains "WebView2 Runtime") {
    [void](Install-WebView2Silent)
  }
  Refresh-Path

  Write-Host ""
  Write-Host "—— 安装后复查 ——"
  $node2 = Test-Node
  $wv22 = Test-WebView2
  $still = @()
  if ($node2.Ok) { Write-Host "[OK] $($node2.Detail)" -ForegroundColor Green } else {
    Write-Host "[仍缺少] $($node2.Detail)" -ForegroundColor Red; $still += "Node.js"
  }
  if ($wv22.Ok) { Write-Host "[OK] $($wv22.Detail)" -ForegroundColor Green } else {
    Write-Host "[仍缺少] $($wv22.Detail)" -ForegroundColor Red; $still += "WebView2"
  }
  if ($still.Count -gt 0) {
    Write-Host ""
    Write-Host "部分组件未能自动安装，请手动安装后重新运行本向导。" -ForegroundColor Yellow
    Write-Host "  Node.js: https://nodejs.org/"
    Write-Host "  WebView2: https://developer.microsoft.com/microsoft-edge/webview2/"
    Pause-Next "可仍继续复制程序文件。按 Enter 继续（或 Ctrl+C 退出）..."
  } else {
    Pause-Next "组件已就绪。按 Enter 选择安装目录..."
  }
}

# ---- Step 2: copy files ----
Write-Step "第 3 步 / 共 4 步：安装程序文件"
Write-Host "默认安装目录: $DefaultInstallDir"
$custom = Read-Host "直接回车使用默认目录，或输入新路径"
if ($custom.Trim()) { $DefaultInstallDir = $custom.Trim() }
$InstallDir = [IO.Path]::GetFullPath($DefaultInstallDir)

Write-Host "安装到: $InstallDir"
if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

Write-Host "[复制] 正在复制文件（含 sidecar，可能需 1～3 分钟）..."
# robocopy: 0-7 often success
& robocopy $PayloadDir $InstallDir /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) {
  Write-Host "[ERROR] 复制失败 robocopy exit=$rc" -ForegroundColor Red
  Pause-Next "按 Enter 退出"
  exit 1
}

# ensure guide present
$srcGuide = Join-Path $PayloadDir "使用说明.txt"
if (Test-Path $srcGuide) {
  Copy-Item $srcGuide (Join-Path $InstallDir "使用说明.txt") -Force
}

# Start script
$startBat = @"
@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
if exist "TianshuTai.exe" (start "" /D "%~dp0" "TianshuTai.exe" & exit /b 0)
if exist "ai-browser.exe" (start "" /D "%~dp0" "ai-browser.exe" & exit /b 0)
echo [ERROR] 未找到主程序
pause
"@
Set-Content -Path (Join-Path $InstallDir "启动天枢台.bat") -Value $startBat -Encoding ASCII

# Desktop shortcut
try {
  $exe = Join-Path $InstallDir "TianshuTai.exe"
  if (-not (Test-Path $exe)) { $exe = Join-Path $InstallDir "ai-browser.exe" }
  if (Test-Path $exe) {
    $ws = New-Object -ComObject WScript.Shell
    $lnkPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "天枢台.lnk"
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $InstallDir
    $lnk.Description = "天枢台"
    $ico = Join-Path $InstallDir "icon.ico"
    if (Test-Path $ico) { $lnk.IconLocation = $ico }
    $lnk.Save()
    Write-Host "[OK] 已创建桌面快捷方式" -ForegroundColor Green
  }
} catch {
  Write-Host "[WARN] 快捷方式创建失败: $_" -ForegroundColor Yellow
}

# ---- Step 3: done ----
Write-Step "第 4 步 / 共 4 步：安装完成"
Write-Host "程序目录: $InstallDir" -ForegroundColor Green
Write-Host "可运行「启动天枢台.bat」或桌面快捷方式。"
Write-Host "首次使用请打开应用内「设置」，配置 CloakBrowser 路径与 AI 密钥。"
Write-Host "使用说明: $InstallDir\使用说明.txt"
Write-Host ""
$launch = Read-Host "输入 Y 立即启动天枢台，其它键退出"
if ($launch -eq "Y" -or $launch -eq "y") {
  $exe = Join-Path $InstallDir "TianshuTai.exe"
  if (-not (Test-Path $exe)) { $exe = Join-Path $InstallDir "ai-browser.exe" }
  if (Test-Path $exe) {
    Start-Process -FilePath $exe -WorkingDirectory $InstallDir
  }
}
Write-Host "安装向导结束。"
exit 0
