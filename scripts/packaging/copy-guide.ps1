# ASCII-safe wrapper: copy Chinese-named user guide into a destination folder.
param(
  [Parameter(Mandatory = $true)]
  [string]$DestDir
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath $DestDir)) {
  New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
}

$guide = Get-ChildItem -LiteralPath $root -File -Filter "*.txt" |
  Where-Object { $_.Name -like "*说明*" -or $_.Name -eq "使用说明.txt" } |
  Select-Object -First 1

if ($null -eq $guide) {
  Write-Host "[WARN] User guide txt not found under project root; skip."
  exit 0
}

Copy-Item -LiteralPath $guide.FullName -Destination (Join-Path $DestDir $guide.Name) -Force
Write-Host "[OK] Copied guide: $($guide.Name)"
exit 0
