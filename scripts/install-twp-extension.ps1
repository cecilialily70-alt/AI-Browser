# Install TWP (Translate Web Pages) into extensions/twp
# Usage (repo root): powershell -ExecutionPolicy Bypass -File scripts\install-twp-extension.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ExtRoot = Join-Path $Root "extensions"
$Target = Join-Path $ExtRoot "twp"
$TempDir = Join-Path $env:TEMP ("ai-browser-twp-" + [guid]::NewGuid().ToString("N"))

Write-Host "[TWP] target: $Target"
New-Item -ItemType Directory -Force -Path $ExtRoot | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

$Failed = $false
try {
  $Api = "https://api.github.com/repos/FilipePS/Traduzir-paginas-web/releases/latest"
  Write-Host "[TWP] fetching release metadata..."
  $Release = Invoke-RestMethod -Uri $Api -Headers @{ "User-Agent" = "TianshuTai-TWP-Installer" }
  $Asset = $Release.assets | Where-Object { $_.name -match "Chromium.*\.crx$" } | Select-Object -First 1
  if (-not $Asset) {
    throw "No Chromium CRX asset found in latest release"
  }

  $CrxPath = Join-Path $TempDir $Asset.name
  Write-Host "[TWP] downloading $($Asset.name) ..."
  Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $CrxPath -UseBasicParsing

  $Bytes = [System.IO.File]::ReadAllBytes($CrxPath)
  $ZipOffset = -1
  $Limit = [Math]::Min($Bytes.Length - 4, 8192)
  for ($i = 0; $i -lt $Limit; $i++) {
    if ($Bytes[$i] -eq 0x50 -and $Bytes[$i + 1] -eq 0x4B -and $Bytes[$i + 2] -eq 0x03 -and $Bytes[$i + 3] -eq 0x04) {
      $ZipOffset = $i
      break
    }
  }
  if ($ZipOffset -lt 0) {
    for ($i = 0; $i -lt ($Bytes.Length - 4); $i++) {
      if ($Bytes[$i] -eq 0x50 -and $Bytes[$i + 1] -eq 0x4B -and $Bytes[$i + 2] -eq 0x03 -and $Bytes[$i + 3] -eq 0x04) {
        $ZipOffset = $i
        break
      }
    }
  }
  if ($ZipOffset -lt 0) {
    throw "Unable to locate ZIP payload inside CRX"
  }

  $ZipPath = Join-Path $TempDir "twp.zip"
  $ZipLen = $Bytes.Length - $ZipOffset
  $ZipBytes = New-Object byte[] $ZipLen
  [Array]::Copy($Bytes, $ZipOffset, $ZipBytes, 0, $ZipLen)
  [System.IO.File]::WriteAllBytes($ZipPath, $ZipBytes)

  $ExtractDir = Join-Path $TempDir "extracted"
  New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
  Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

  $Manifest = Get-ChildItem -Path $ExtractDir -Filter "manifest.json" -Recurse | Select-Object -First 1
  if (-not $Manifest) {
    throw "manifest.json not found after extract"
  }
  $SourceDir = $Manifest.Directory.FullName

  if (Test-Path $Target) {
    Remove-Item -Recurse -Force $Target
  }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Copy-Item -Path (Join-Path $SourceDir "*") -Destination $Target -Recurse -Force

  Write-Host "[OK] TWP installed -> $Target"
  Write-Host "Restart browser profiles to load the extension."
}
catch {
  $Failed = $true
  Write-Host "[ERROR] $($_.Exception.Message)"
}
finally {
  if (Test-Path $TempDir) {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
  }
}

if ($Failed) {
  exit 1
}
exit 0
