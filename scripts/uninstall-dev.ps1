<#
Removes both halves of the Windows dev install: the folder link and the
registry entry. Leaves every other plugin in the registry alone.

  powershell -ExecutionPolicy Bypass -File scripts\uninstall-dev.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$Src     = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path.TrimEnd("\")
$UxpRoot = Join-Path $env:APPDATA "Adobe\UXP"
$Info    = Join-Path $UxpRoot "PluginsInfo\v1\premierepro.json"

$manifest = Get-Content -LiteralPath (Join-Path $Src "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Id  = [string]$manifest.id
$Ver = [string]$manifest.version
$Dest = Join-Path $UxpRoot ("Plugins\External\{0}_{1}" -f $Id, $Ver)

if (Test-Path -LiteralPath $Dest) {
  $existing = Get-Item -LiteralPath $Dest -Force
  if ($existing.LinkType) {
    # A junction is removed as a link, never recursed into - see install-dev.ps1.
    [System.IO.Directory]::Delete($Dest)
  } else {
    Remove-Item -LiteralPath $Dest -Recurse -Force
  }
  Write-Host "Removed: $Dest"
} else {
  Write-Host "Not installed: $Dest"
}

if (Test-Path -LiteralPath $Info) {
  try {
    $data = Get-Content -LiteralPath $Info -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Registry will not parse, left untouched: $Info"
  }
  $kept = @($data.plugins | Where-Object { $_.pluginId -ne $Id })
  $data.plugins = $kept
  $json = ConvertTo-Json -InputObject $data -Depth 8
  $tmp  = "$Info.tmp"
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $Info -Force
  Write-Host ("Deregistered ({0} plugin(s) left registered)." -f $kept.Count)
}

Write-Host "Restart Premiere Pro for it to disappear from the panel list."
