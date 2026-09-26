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
$msi = Join-Path $dlDir "nodejs-lts.msi"

$uris = @(
  "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi",
  "https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-x64.msi"
)
$ok = $false
foreach ($uri in $uris) {
  try {
    Write-Host "[INFO] Download $uri"
    Write-Host "[INFO] Target   $msi"
    Invoke-WebRequest -Uri $uri -OutFile $msi -UseBasicParsing
    $ok = $true
    break
  } catch {
    Write-Host "[WARN] download failed: $($_.Exception.Message)"
  }
}
if (-not $ok) { exit 1 }
Write-Host "[INFO] msiexec quiet install..."
$p = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
exit $p.ExitCode
