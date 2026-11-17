# install-desktop.ps1: install or update the Diazo desktop app on Windows.
#
#   irm https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-desktop.ps1 | iex
#
# Downloads Diazo_<version>_x64-setup.exe of a desktop-v<version> release of
# BRYANN2K/diazo (the version from the desktop-updates feed, or -Version),
# checks it against the release's SHA256SUMS and runs it silently (/S). The
# app then updates itself from the same releases.
#
# Under `irm | iex` parameters cannot be passed; set the matching environment
# variable first instead:
#   $env:DOOP_DESKTOP_VERSION='0.15.0'; irm ... | iex
#   $env:DOOP_DESKTOP_SERVER='https://diazo.example.com'; irm ... | iex
#   $env:DOOP_DESKTOP_UNINSTALL='1'; irm ... | iex
#
# Settings (parameters, or the DOOP_DESKTOP_* environment variables):
#   -Version X.Y.Z      install that release instead of the latest one
#   -Server <url>       also write the app's server choice (server.json) after
#                       checking the server answers, as a remote install does
#   -Force              reinstall even when this version is already installed
#   -Uninstall          remove the app (sign-in, server choice and data stay)
#   -DryRun             print what would be done, change nothing
#   DOOP_DESKTOP_REPO (BRYANN2K/diazo), DOOP_DESKTOP_RELEASES (base URL of the
#   release downloads), DOOP_DESKTOP_DIR (the app's install folder, passed to
#   the setup as /D=; by default the folder the uninstall registry key names,
#   or %LOCALAPPDATA%\Diazo on a first install)

[CmdletBinding()]
param(
  [string]$Version = $env:DOOP_DESKTOP_VERSION,
  [string]$Server = $env:DOOP_DESKTOP_SERVER,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Repo = if ($env:DOOP_DESKTOP_REPO) { $env:DOOP_DESKTOP_REPO } else { 'BRYANN2K/diazo' }
$Releases = if ($env:DOOP_DESKTOP_RELEASES) { $env:DOOP_DESKTOP_RELEASES } else { "https://github.com/$Repo/releases/download" }
$BundleId = 'dev.bryann2k.diazo'
$AppData = Join-Path $env:APPDATA $BundleId
# Tauri's per-user NSIS puts the app in %LOCALAPPDATA%\<productName> and writes
# its folder to the Uninstall key's InstallLocation
$UninstallKeys = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Diazo',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Diazo'
)
$RefusedHosts = @('doop.design', 'www.doop.design')

function Say($Message) { Write-Host "diazo: $Message" }
# Throw, never `exit`: under `irm | iex` an exit would close the person's
# PowerShell window. The one top-level catch prints the message.
function Die($Message) { throw $Message }

# ------------------------------------------------------------- the address
# The typed address as the origin it names, checked as the app's server.rs
# checks it: https, or plain http on this computer only; never the original
# doop service.
function Normalize-Server([string]$Address) {
  $Address = $Address.Trim()
  if ($Address -eq '') { Die 'Enter the address of a Diazo server.' }
  if ($Address -notmatch '://') { $Address = "https://$Address" }
  $uri = $null
  if (-not [uri]::TryCreate($Address, [System.UriKind]::Absolute, [ref]$uri)) {
    Die "`"$Address`" is not a web address."
  }
  if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') {
    Die 'The address must start with https:// or http://.'
  }
  if ($uri.Host -eq '') { Die "`"$Address`" is not a web address." }
  if ($uri.UserInfo -ne '') { Die 'The address must not contain a user name or password.' }
  $host_ = $uri.Host.ToLowerInvariant()
  # [uri] keeps an IPv6 literal's brackets; the bare host is what is checked
  $bare = $host_.TrimStart('[').TrimEnd(']')
  # the host goes raw into server.json: a domain name or an IPv6 literal,
  # nothing else
  if ($host_ -match ':|\[') {
    if ($bare -notmatch '^[0-9a-f:.]+$') { Die "`"$Address`" is not a valid host name." }
  } elseif ($host_ -notmatch '^[a-z0-9.-]+$') { Die "`"$Address`" is not a valid host name." }
  # What server.rs's `secure` accepts for plain http: `localhost`, or an IP
  # literal that parses as loopback — 127.0.0.0/8 or ::1. A name like
  # 127.example.com is a name, not the address.
  $ip = $null
  $loopback = $host_ -eq 'localhost' -or
    ([System.Net.IPAddress]::TryParse($bare, [ref]$ip) -and [System.Net.IPAddress]::IsLoopback($ip))
  if ($uri.Scheme -ne 'https' -and -not $loopback) {
    Die "$($uri.Scheme)://$host_ is not secure. Use an https:// address; plain http:// only works for a server on this computer."
  }
  if ($RefusedHosts -contains $bare) {
    Die "$bare is the original doop service, not a Diazo server. Use the doop app for it."
  }
  $shown = if ($bare -match ':') { "[$bare]" } else { $host_ }
  $origin = "$($uri.Scheme)://$shown"
  if (-not $uri.IsDefaultPort) { $origin = "$($origin):$($uri.Port)" }
  return $origin
}

# Every Diazo server answers this public route, so a typo or another site is
# caught before server.json is written. As server.rs does: redirects are
# followed, and the origin that actually answered — checked again the same
# way — is the one returned.
function Probe-Server([string]$Origin) {
  try {
    $response = Invoke-WebRequest -Uri "$Origin/api/locale-config" -TimeoutSec 8 -UseBasicParsing
  } catch {
    Die "No Diazo server answered at $Origin. Check the address and try again."
  }
  $body = $null
  try { $body = $response.Content | ConvertFrom-Json } catch { $body = $null }
  if (-not ($body -and ($body.defaultLocale -is [string]))) {
    Die "No Diazo server answered at $Origin. Check the address and try again."
  }
  # where the request actually landed: ResponseUri on PowerShell 5.1,
  # RequestMessage.RequestUri on PowerShell 7
  $answered = $null
  if ($response.BaseResponse.ResponseUri) {
    $answered = $response.BaseResponse.ResponseUri.AbsoluteUri
  } elseif ($response.BaseResponse.RequestMessage) {
    $answered = $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
  }
  if (-not $answered) { $answered = "$Origin/api/locale-config" }
  return (Normalize-Server $answered)
}

# Points the app at $Origin (the data folder's server.json, read at launch).
function Choose-Server([string]$Origin) {
  New-Item -ItemType Directory -Force -Path $AppData | Out-Null
  $file = Join-Path $AppData 'server.json'
  $current = $null
  if (Test-Path $file) {
    try { $current = (Get-Content $file -Raw | ConvertFrom-Json).url } catch { $current = $null }
  }
  if ($current -eq $Origin) {
    Say "the app already opens $Origin"
    return
  }
  @{ url = $Origin } | ConvertTo-Json -Compress | Set-Content -Path "$file.tmp" -Encoding ascii
  Move-Item -Force "$file.tmp" $file
  Say "the app opens $Origin"
}

# ------------------------------------------------------------- the release
function Latest-Version {
  $feed = "$Releases/desktop-updates/latest.json"
  try { $latest = Invoke-RestMethod -Uri $feed } catch { Die "could not read $feed (offline, or no desktop release yet)" }
  if ($latest.version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') {
    Die "the update feed names no usable version ($feed)"
  }
  return $latest.version
}

function Download-Checked([string]$Asset, [string]$Target) {
  $base = "$Releases/desktop-v$Version"
  Say "downloading Diazo $Version"
  try {
    Invoke-WebRequest -Uri "$base/$Asset" -OutFile $Target -UseBasicParsing
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile "$Target.sums" -UseBasicParsing
  } catch {
    Die "could not download $base/$Asset (is desktop-v$Version released?)"
  }
  $expected = $null
  foreach ($line in Get-Content "$Target.sums") {
    if ($line -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($Asset))$") { $expected = $Matches[1]; break }
  }
  if (-not $expected) { Die "SHA256SUMS does not list $Asset" }
  $actual = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Die "checksum mismatch for $Asset (expected $expected, got $actual); nothing was installed"
  }
  Say 'checksum verified'
}

# ------------------------------------------------------------- the app
# The folder the app is installed in, or will be: DOOP_DESKTOP_DIR, else the
# uninstall key's InstallLocation (quoted in the registry), else the Tauri
# per-user default %LOCALAPPDATA%\Diazo.
function Find-InstallDir {
  if ($env:DOOP_DESKTOP_DIR) { return $env:DOOP_DESKTOP_DIR }
  foreach ($key in $UninstallKeys) {
    $item = Get-ItemProperty $key -ErrorAction SilentlyContinue
    if ($item -and $item.InstallLocation) { return $item.InstallLocation.Trim('"') }
  }
  return (Join-Path $env:LOCALAPPDATA 'Diazo')
}

function Installed-Version {
  $exe = Join-Path $InstallDir 'doop-desktop.exe'
  if (Test-Path $exe) {
    return (Get-Item $exe).VersionInfo.ProductVersion
  }
  return $null
}

function Quit-App {
  $running = Get-Process -Name 'doop-desktop' -ErrorAction SilentlyContinue
  if ($running) {
    Say 'quitting Diazo'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
}

$wantUninstall = $Uninstall -or $env:DOOP_DESKTOP_UNINSTALL
$wantDryRun = $DryRun -or $env:DOOP_DESKTOP_DRY_RUN

$work = $null
try {
  $InstallDir = Find-InstallDir

  if ($wantUninstall) {
    Quit-App
    $uninstaller = Get-ChildItem $InstallDir -Filter '*ninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($uninstaller) {
      if ($wantDryRun) { Say "[dry run] would run $($uninstaller.FullName) /S" }
      else {
        Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait
        Say 'removed the Diazo app'
      }
    } else {
      Say 'Diazo is not installed (remove it from Settings - Apps if it is listed there)'
    }
    Say "kept $AppData (delete it to forget the sign-in and the chosen server)"
    return
  }

  if (-not $Version) { $Version = Latest-Version }
  if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { Die "not a release version: '$Version' (expected X.Y.Z)" }
  $asset = "Diazo_${Version}_x64-setup.exe"
  $origin = $null
  if ($Server) {
    $origin = Normalize-Server $Server
    # the app already opens this server: no new choice to check
    $file = Join-Path $AppData 'server.json'
    $current = $null
    if (Test-Path $file) {
      try { $current = (Get-Content $file -Raw | ConvertFrom-Json).url } catch { $current = $null }
    }
    if ($current -ne $origin) { $origin = Probe-Server $origin }
  }

  if ($wantDryRun) {
    Say '[dry run] nothing is changed. The steps:'
    Write-Host "  download $asset, check it against SHA256SUMS"
    Write-Host "  run $asset /S (silent install into $InstallDir)"
    if ($origin) { Write-Host "  set the app's server to $origin ($AppData\server.json)" }
    return
  }

  $current = Installed-Version
  if (-not $Force -and $current -and ($current -eq $Version -or $current.StartsWith("$Version."))) {
    Say "Diazo $Version is already installed in $InstallDir (-Force reinstalls it)"
  } else {
    $work = Join-Path ([System.IO.Path]::GetTempPath()) "diazo-desktop-$([System.IO.Path]::GetRandomFileName())"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $package = Join-Path $work $asset
    Download-Checked $asset $package
    Quit-App
    Say "running the installer silently"
    # /D= sets the install folder: it must be the last switch and is never
    # quoted, so a folder with spaces still parses
    $arguments = '/S'
    if ($env:DOOP_DESKTOP_DIR) { $arguments = "/S /D=$InstallDir" }
    Start-Process -FilePath $package -ArgumentList $arguments -Wait
    Say "Diazo $Version is installed: $InstallDir"
  }
  if ($origin) { Choose-Server $origin }
} catch {
  Write-Host "diazo: error: $_" -ForegroundColor Red
} finally {
  if ($work -and (Test-Path $work)) { Remove-Item -Recurse -Force $work }
}
