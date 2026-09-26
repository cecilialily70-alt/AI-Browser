$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Download staging: same location as build-paths.bat uses, so payloads stay on the
# project drive instead of C:. Falls back to %TEMP% only if that drive is unusable.
$dlDir = $env:TIANSHUTAI_DL_DIR
if (-not $dlDir) {
  $repoRoot = Split-Path -Parent $PSScriptRoot          # <drive>\Browser
  $dlDir = Join-Path (Split-Path -Parent $repoRoot) "temp\downloads"
}
try {
  New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
} catch {
  $dlDir = $env:TEMP
}
$exe = Join-Path $dlDir "rustup-init.exe"

$uris = @(
  "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe",
  "https://mirrors.ustc.edu.cn/rust-static/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
)
$ok = $false
foreach ($uri in $uris) {
  try {
    Write-Host "[INFO] Download $uri"
    Write-Host "[INFO] Target   $exe"
    Invoke-WebRequest -Uri $uri -OutFile $exe -UseBasicParsing
    $ok = $true
    break
  } catch {
    Write-Host "[WARN] download failed: $($_.Exception.Message)"
  }
}
if (-not $ok) { exit 1 }
Write-Host "[INFO] rustup-init -y ..."
& $exe -y --default-toolchain stable --profile minimal
exit $LASTEXITCODE
