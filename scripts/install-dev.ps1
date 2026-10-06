<#
Dev install on Windows: link this working copy into the per-user UXP plugins
folder AND register it in Premiere's plugin registry. No admin, no packaging,
no build step - edits to the panel's HTML/CSS/JS are picked up when Premiere
is restarted.

The registry step is the one that is easy to miss. Premiere does NOT scan
...\UXP\Plugins\External for plugins to load, despite that being where they
live. It reads a manifest of its own:

  %APPDATA%\Adobe\UXP\PluginsInfo\v1\premierepro.json

A plugin dropped in the folder but absent from that file is silently ignored
- no error in the panel list, nothing in the UXP log except its absence. That
was verified on the Mac (Premiere 26.3.2); the Windows location is the one
Premiere's own log names when it loads plugins, and this script mirrors the
Mac installer's registry entry field for field.

Run from a PowerShell prompt:

  powershell -ExecutionPolicy Bypass -File scripts\install-dev.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-dev.ps1 copy

The default makes a directory JUNCTION, which needs no admin rights and no
Developer Mode (a true symlink needs one or the other). "copy" does a real
copy instead, for if the UXP loader refuses to follow the junction - re-run it
after every edit.
#>
[CmdletBinding()]
param(
  [ValidateSet("junction", "copy")]
  [string]$Mode = "junction"
)

$ErrorActionPreference = "Stop"

$Src     = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path.TrimEnd("\")
$UxpRoot = Join-Path $env:APPDATA "Adobe\UXP"
$DestDir = Join-Path $UxpRoot "Plugins\External"
$Info    = Join-Path $UxpRoot "PluginsInfo\v1\premierepro.json"

$manifest = Get-Content -LiteralPath (Join-Path $Src "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Id     = [string]$manifest.id
$Ver    = [string]$manifest.version
$Name   = [string]$manifest.name
$MinVer = [string]$manifest.host.minVersion
if (-not $Id -or -not $Ver) { throw "manifest.json has no id/version" }

$Dest = Join-Path $DestDir ("{0}_{1}" -f $Id, $Ver)

# --- 1. put the plugin where the registry will point ------------------------

New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

if (Test-Path -LiteralPath $Dest) {
  $existing = Get-Item -LiteralPath $Dest -Force
  if ($existing.LinkType) {
    # A junction is removed as a link. Never Remove-Item -Recurse a junction:
    # older PowerShell follows it and empties the TARGET - this working copy.
    [System.IO.Directory]::Delete($Dest)
  } else {
    Remove-Item -LiteralPath $Dest -Recurse -Force
  }
}

if ($Mode -eq "copy") {
  # robocopy: exit codes below 8 are success (0 = nothing to do, 1 = copied).
  & robocopy $Src $Dest /MIR /NFL /NDL /NJH /NJS /XD .git scripts tests docs dev | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
  Write-Host "Copied:   $Dest"
} else {
  New-Item -ItemType Junction -Path $Dest -Value $Src | Out-Null
  Write-Host "Linked:   $Dest -> $Src"
}

# --- 2. register it, without disturbing the plugins already listed ----------

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Info) | Out-Null

$data = $null
if (Test-Path -LiteralPath $Info) {
  try {
    $data = Get-Content -LiteralPath $Info -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    # A corrupt registry would take every other UXP panel down with it, so
    # refuse rather than overwrite it with a file containing only us.
    throw "Registry exists but will not parse: $Info"
  }
}
if ($null -eq $data) { $data = [pscustomobject]@{ plugins = @() } }
if ($null -eq $data.PSObject.Properties["plugins"]) {
  $data | Add-Member -NotePropertyName plugins -NotePropertyValue @()
}

$others = @($data.plugins | Where-Object { $_.pluginId -ne $Id })

# Same fields, same order, same `$localPlugins` token as the Mac registry -
# but with BACKSLASHES after the token. Measured on Premiere 26.5.2: the
# Mac spelling `$localPlugins/External/<id>` is accepted by the loader, logged
# as "added ... with status as enabled", and then fails to initialise at an
# empty path, silently, with the panel absent. `$localPlugins\External\<id>`
# initialises. Single quotes: `$localPlugins` is Premiere's placeholder, not a
# PowerShell variable.
$entry = [ordered]@{
  hostMinVersion = $MinVer
  name           = $Name
  path           = '$localPlugins\External\' + ("{0}_{1}" -f $Id, $Ver)
  pluginId       = $Id
  status         = "enabled"
  type           = "uxp"
  versionString  = $Ver
}
$data.plugins = @($others + [pscustomobject]$entry)

# -InputObject, not a pipe: piping a one-element array unwraps it to a bare
# object. UTF-8 without a BOM: a BOM is not JSON and the loader may reject it.
$json = ConvertTo-Json -InputObject $data -Depth 8
$tmp  = "$Info.tmp"
[System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
Move-Item -LiteralPath $tmp -Destination $Info -Force

Write-Host ("Registered: {0} ({1}) alongside {2} other plugin(s)." -f $Name, $Id, $others.Count)
Write-Host ""
Write-Host "Restart Premiere Pro, then: Window > Extensions > $Name"
