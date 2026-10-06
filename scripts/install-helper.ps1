<#
Install the Conformer's background helper on Windows as a logon Scheduled
Task, so it runs from login and the panel never needs a terminal. This is the
Windows counterpart of install-helper.sh, which uses launchd on a Mac.

The helper is what lets the panel use ffmpeg and numpy at all: UXP has no
subprocess API, so the panel writes a request into its own data folder and
the helper - an ordinary process with no such restriction - does the work and
writes the answer back.

  powershell -ExecutionPolicy Bypass -File scripts\install-helper.ps1            install and start
  powershell -ExecutionPolicy Bypass -File scripts\install-helper.ps1 uninstall  stop and remove
  powershell -ExecutionPolicy Bypass -File scripts\install-helper.ps1 status     is it running?

What carries over from the Mac installer, and why:

  KeepAlive        -> RestartCount / RestartInterval: the task is restarted if
                      the helper exits. ExecutionTimeLimit is set to zero -
                      Task Scheduler's DEFAULT is to kill any task after 72
                      hours, which would silently stop the helper on day four.
  Interactive, not -> Priority 4. Task Scheduler runs tasks at priority 7
  Background          (below normal) unless told otherwise, the same throttled
                      class launchd's "Background" puts a job in. Measured on
                      the Mac, same verify, same files: 583s throttled, 39s
                      not. An editor is waiting on this; it runs at normal.
  StandardOutPath  -> the helper's own --log flag. A Scheduled Task cannot
                      redirect output, and the helper runs under pythonw.exe
                      (no console window at logon), so it writes its own log:
                      %LOCALAPPDATA%\TheConformer\helper.log
#>
[CmdletBinding()]
param(
  [ValidateSet("install", "uninstall", "status")]
  [string]$Action = "install"
)

$ErrorActionPreference = "Stop"

$Src      = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path.TrimEnd("\")
$TaskName = "TheConformerHelper"
$LogDir   = Join-Path $env:LOCALAPPDATA "TheConformer"
$Log      = Join-Path $LogDir "helper.log"
$Helper   = Join-Path $Src "helper\conform_helper.py"

function Get-Task {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

switch ($Action) {
  "uninstall" {
    if (Get-Task) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "Removed $TaskName."
    } else {
      Write-Host "$TaskName was not installed."
    }
    return
  }
  "status" {
    $task = Get-Task
    if ($task -and $task.State -eq "Running") {
      Write-Host "Running. Log: $Log"
      if (Test-Path -LiteralPath $Log) { Get-Content -LiteralPath $Log -Tail 5 }
    } elseif ($task) {
      $info = Get-ScheduledTaskInfo -TaskName $TaskName
      Write-Host ("Installed but not running (state {0}, last result {1}). Log: {2}" -f $task.State, $info.LastTaskResult, $Log)
      Write-Host "Start it with: Start-ScheduledTask -TaskName $TaskName"
    } else {
      Write-Host "Not installed. Install with: powershell -ExecutionPolicy Bypass -File scripts\install-helper.ps1"
    }
    return
  }
}

# --- find a python with numpy ------------------------------------------------
#
# `python` on a fresh Windows is often the Store's stub that opens a shop
# window, so the py launcher is asked first. Whichever answers must have
# numpy - the frame matching is numpy, and a helper that starts and then fails
# on every verify request is worse than one that refuses to install.

$python = $null
foreach ($candidate in @(@("py", "-3"), @("python3"), @("python"))) {
  $exe = Get-Command $candidate[0] -ErrorAction SilentlyContinue
  if (-not $exe) { continue }
  # Slicing a one-element array as [1..0] walks BACKWARDS and yields a null
  # plus the command name, so the extra arguments are taken explicitly.
  $extra = @()
  if ($candidate.Length -gt 1) { $extra = $candidate[1..($candidate.Length - 1)] }
  try {
    $resolved = & $exe.Source @extra -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $resolved) { $python = ([string]$resolved).Trim(); break }
  } catch { }
}
if (-not $python) {
  throw "No python3 found. Install Python 3 from python.org (tick 'Add to PATH'), then: py -3 -m pip install --user numpy"
}
& $python -c "import numpy" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "python at $python has no numpy, which the frame matching needs:"
  Write-Host "  `"$python`" -m pip install --user numpy"
  exit 1
}

# pythonw.exe sits beside python.exe and opens no console window. Fall back
# to python.exe if an unusual install has no pythonw - a console at logon is
# ugly but works.
$pythonw = Join-Path (Split-Path -Parent $python) "pythonw.exe"
if (-not (Test-Path -LiteralPath $pythonw)) { $pythonw = $python }

# ffmpeg is GPLv3 and is not shipped with the panel. The helper looks in
# bin\ then PATH; without it the panel can only report that it is missing.
$binFfmpeg = Join-Path $Src "bin\ffmpeg.exe"
if (-not (Test-Path -LiteralPath $binFfmpeg) -and -not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "No ffmpeg found in $Src\bin or on PATH. The helper will install and run, but"
  Write-Host "cannot plan or check anything until there is one. Download a static build"
  Write-Host "(ffmpeg.exe and ffprobe.exe) from https://ffmpeg.org/download.html and put"
  Write-Host "both in $Src\bin"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# --- register the task -----------------------------------------------------------

$user = "$env:USERDOMAIN\$env:USERNAME"

# Not $action: PowerShell variable names are case-insensitive, so that would
# assign into the validated $Action parameter above and fail validation.
$taskAction = New-ScheduledTaskAction -Execute $pythonw `
  -Argument ('"{0}" --verbose --log "{1}"' -f $Helper, $Log) `
  -WorkingDirectory $Src

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -Priority 4

# Interactive logon, limited rights: the helper runs as the editor, in their
# session, with access to the same drives Premiere has.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

if (Get-Task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger `
  -Settings $settings -Principal $principal -Description "The Conformer's background helper (ffmpeg + numpy for the Premiere panel)" | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$task = Get-Task
if ($task -and $task.State -eq "Running") {
  Write-Host "Installed and running: $TaskName"
  Write-Host "Log: $Log"
} else {
  Write-Host "Installed, but it does not appear to be running. Check $Log"
  exit 1
}
