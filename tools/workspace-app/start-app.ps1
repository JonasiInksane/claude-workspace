<#
.SYNOPSIS
  Starts the workspace app (tools\workspace-app\server.mjs) without a console window.

.DESCRIPTION
  Runs Node hidden. The app opens its own Edge window and stops by itself a few minutes after
  the last window closes. Its messages go to %TEMP%\claude-workspace\app.log.
  Used by "Workspace App.cmd", the desktop shortcut (make-shortcut.mjs) and start.ps1 [A].

  -NoOpen  Start the server without opening a window (for checks).
#>
param([switch]$NoOpen)

$server = Join-Path $PSScriptRoot 'server.mjs'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

function Show-Problem([string]$Message) {
  # Usually started without a console, so show a dialog instead of console text.
  try {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($Message, 'Claude Workspace')
  } catch {
    Write-Host $Message
  }
}

if (-not $node) {
  Show-Problem 'Node.js was not found on PATH. Install it from https://nodejs.org (or run Setup.ps1), then try again.'
  exit 1
}
if (-not (Test-Path -LiteralPath $server)) {
  Show-Problem "The app was not found: $server"
  exit 1
}

$log = Join-Path ([IO.Path]::GetTempPath()) 'claude-workspace\app.log'
# Windows paths can't contain double quotes, so quoting them like this is safe.
$nodeArgs = @("`"$server`"", '--log', "`"$log`"")
if ($NoOpen) { $nodeArgs += '--no-open' }

try {
  $proc = Start-Process -FilePath $node.Source -ArgumentList $nodeArgs -WindowStyle Hidden -PassThru -ErrorAction Stop
} catch {
  Show-Problem "The app could not start: $($_.Exception.Message)"
  exit 1
}

# A broken start ends within moments; a running app (or a second start that hands over to the
# running one and exits 0) is fine. Show the end of the log when it failed.
Start-Sleep -Milliseconds 1500
if ($proc.HasExited -and $proc.ExitCode -ne 0) {
  $tail = ''
  if (Test-Path -LiteralPath $log) { $tail = (Get-Content -LiteralPath $log -Tail 8) -join "`n" }
  Show-Problem "The app stopped right after starting (exit code $($proc.ExitCode)).`n`n$tail`n`nLog: $log"
  exit 1
}
