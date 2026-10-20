<#
.SYNOPSIS
  Interactive launcher for this Claude Code workspace (Windows PowerShell 5.1).

.DESCRIPTION
  [W]     Start Claude in the workspace root (the hub).
  [1..n]  Start Claude in one of the projects in projects\.
  [C]     Continue the most recent conversation (claude -c) in a target you pick.
  [O]     Build the navigator and open index.html in your browser.
  [Q]     Quit.

  With Windows Terminal (wt.exe) Claude opens in a new tab and this menu stays open.
  Without it, Claude runs in this window; quit Claude to come back to the menu.

  Usually started by double-clicking "Start Workspace.cmd".
#>

$Root = $PSScriptRoot
$LocalBin = Join-Path $env:USERPROFILE '.local\bin'
$SetupCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1'

# ------------------------------------------------------------------ project detection (SPEC C8)

# The rules live in tools\lib\project-type.mjs (shared with the Node tools and the hook),
# so this asks Node for the label. Without Node it shows "unknown".
function Get-ProjectType([string]$Dir) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 'unknown' }
  try {
    $label = & node (Join-Path $Root 'tools\lib\project-type.mjs') $Dir 2>$null
    if ($LASTEXITCODE -eq 0 -and $label) { return ([string]$label).Trim() }
  } catch { }
  return 'unknown'
}

function Get-Projects {
  $dir = Join-Path $Root 'projects'
  if (-not (Test-Path -LiteralPath $dir)) { return @() }
  $list = @()
  foreach ($d in (Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
    if ($d.Name.StartsWith('.')) { continue }
    $hasClaudeMd = (Test-Path -LiteralPath (Join-Path $d.FullName 'CLAUDE.md')) -or
      (Test-Path -LiteralPath (Join-Path $d.FullName '.claude\CLAUDE.md'))
    $list += [pscustomobject]@{
      Name        = $d.Name
      Path        = $d.FullName
      Type        = (Get-ProjectType $d.FullName)
      HasClaudeMd = $hasClaudeMd
    }
  }
  return $list
}

# ------------------------------------------------------------------ claude

function Resolve-Claude {
  $cmd = Get-Command claude -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return [pscustomobject]@{ Path = $cmd.Source; OnPath = $true } }
  $exe = Join-Path $LocalBin 'claude.exe'
  if (Test-Path -LiteralPath $exe) { return [pscustomobject]@{ Path = $exe; OnPath = $false } }
  return $null
}

# The SessionStart hook's status block goes to Claude, not to the chat, so print it here too.
function Show-HubStatus {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }
  try {
    Write-Host ''
    & node (Join-Path $Root 'tools\hooks\session-start.mjs') | ForEach-Object { Write-Host "  $_" }
    Write-Host ''
  } catch { }
}

function Show-PathHint {
  Write-Host ''
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $want = $LocalBin.TrimEnd('\').ToLowerInvariant()
  $inUserPath = $false
  if ($userPath) {
    foreach ($part in ($userPath -split ';')) {
      $p = [Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"')).TrimEnd('\').ToLowerInvariant()
      if ($p -eq $want) { $inUserPath = $true }
    }
  }
  if ($inUserPath) {
    Write-Host 'claude is not on the PATH of this window yet.' -ForegroundColor Yellow
    Write-Host '  Your user PATH already has %USERPROFILE%\.local\bin. Open a new terminal' -ForegroundColor Yellow
    Write-Host '  (or sign out and back in) so it picks up the change.' -ForegroundColor Yellow
    Write-Host ''
    return
  }
  Write-Host 'claude is not on your PATH.' -ForegroundColor Yellow
  Write-Host '  Installed already (native installer puts it in %USERPROFILE%\.local\bin)? Run:' -ForegroundColor Yellow
  Write-Host "    $SetupCmd -Mode Install -FixPath" -ForegroundColor Yellow
  Write-Host '  then open a new terminal.' -ForegroundColor Yellow
  Write-Host '  Not installed yet? Run:  irm https://claude.ai/install.ps1 | iex' -ForegroundColor Yellow
  Write-Host ''
}

# wt.exe treats ";" as a command separator (even inside quotes), so escape it as "\;".
function Format-WtArg([string]$Text) {
  return $Text.Replace(';', '\;')
}

# A trailing backslash would escape the closing quote, so drop it (keep "C:\." for a drive root).
function Format-WtPath([string]$Dir) {
  $d = $Dir.TrimEnd('\')
  if ($d.EndsWith(':')) { $d = $d + '\.' }
  return (Format-WtArg $d)
}

function Start-ClaudeIn([string]$Dir, [string]$Title, [bool]$Continue) {
  $claude = Resolve-Claude
  if (-not $claude) {
    Write-Host 'Claude Code was not found.' -ForegroundColor Red
    Show-PathHint
    return
  }
  if (-not $claude.OnPath) {
    Write-Host "Using $($claude.Path) for now." -ForegroundColor Yellow
    Show-PathHint
  }

  $wt = Get-Command wt.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($wt) {
    if ($claude.OnPath) {
      $command = 'claude'
      if ($Continue) { $command = 'claude -c' }
      $psArgs = @('-NoExit', '-Command', $command)
    } else {
      # Full path to claude.exe; encoded so wt.exe does not re-split quotes or spaces.
      $inner = "& '" + $claude.Path.Replace("'", "''") + "'"
      if ($Continue) { $inner = $inner + ' -c' }
      $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
      $psArgs = @('-NoExit', '-EncodedCommand', $encoded)
    }
    $wtArgs = @('-w', '0', 'nt', '-d', (Format-WtPath $Dir), '--title', (Format-WtArg $Title), 'powershell') + $psArgs
    & $wt.Source @wtArgs
    if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) {
      Write-Host "Opened '$Title' in a new Windows Terminal tab." -ForegroundColor Green
      return
    }
    Write-Host "Windows Terminal did not start (exit code $LASTEXITCODE); starting here instead." -ForegroundColor Yellow
  }

  Write-Host "Starting Claude in $Dir  (quit Claude to return to this menu)" -ForegroundColor Green
  Push-Location -LiteralPath $Dir
  try {
    if ($Continue) { & $claude.Path -c } else { & $claude.Path }
  } finally {
    Pop-Location
  }
}

# ------------------------------------------------------------------ navigator

function Open-Navigator {
  $builder = Join-Path $Root 'tools\build-index.mjs'
  if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $builder)) {
    & node $builder | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Host 'build-index.mjs failed; opening the last built index.html.' -ForegroundColor Yellow }
  } else {
    Write-Host 'Node.js or tools\build-index.mjs not found; opening the last built index.html.' -ForegroundColor Yellow
  }
  $index = Join-Path $Root 'index.html'
  if (Test-Path -LiteralPath $index) {
    Start-Process -FilePath $index
  } else {
    Write-Host 'index.html does not exist yet. Install Node.js 20+ and run: node tools/build-index.mjs' -ForegroundColor Red
  }
}

# ------------------------------------------------------------------ menu

function Show-Menu($Projects) {
  Write-Host ''
  Write-Host '  Claude Workspace' -ForegroundColor Cyan
  Write-Host '  ----------------' -ForegroundColor Cyan
  Write-Host ('  {0,-4} {1,-24} {2}' -f '[W]', 'Workspace hub', $Root)
  if ($Projects.Count -eq 0) {
    Write-Host '       (no projects yet; in the hub run /new-project <name> nextjs|game)' -ForegroundColor DarkGray
  }
  for ($i = 0; $i -lt $Projects.Count; $i++) {
    $p = $Projects[$i]
    $md = 'CLAUDE.md'
    if (-not $p.HasClaudeMd) { $md = 'no CLAUDE.md (run /onboard-project)' }
    Write-Host ('  {0,-4} {1,-24} {2,-26} {3}' -f "[$($i + 1)]", $p.Name, $p.Type, $md)
  }
  Write-Host '  [C]  Continue the last conversation (claude -c) in a target'
  Write-Host '  [O]  Open the navigator (index.html)'
  Write-Host '  [Q]  Quit'
  Write-Host ''
}

function Read-Choice([string]$Prompt) {
  try { return ("" + (Read-Host $Prompt)).Trim() } catch { return 'q' }
}

function Select-Target($Projects) {
  $answer = Read-Choice 'Continue in which target? [W] or a project number (Enter = cancel)'
  if ($answer -match '^[Ww]$') { return [pscustomobject]@{ Name = 'Workspace hub'; Path = $Root } }
  if ($answer -match '^\d+$') {
    $n = [int]$answer
    if ($n -ge 1 -and $n -le $Projects.Count) { return $Projects[$n - 1] }
  }
  if ($answer) { Write-Host "Unknown choice: $answer" -ForegroundColor Yellow }
  return $null
}

# ------------------------------------------------------------------ main

if ([Console]::IsInputRedirected) {
  Write-Host 'start.ps1 is interactive. Run it in a terminal or double-click "Start Workspace.cmd".'
  exit 1
}
try { $Host.UI.RawUI.WindowTitle = 'Claude Workspace' } catch { }

$running = $true
while ($running) {
  $projects = @(Get-Projects)
  Show-Menu $projects
  $choice = Read-Choice 'Choose'
  if ($choice -match '^[Ww]$') {
    Show-HubStatus
    Start-ClaudeIn $Root 'Workspace hub' $false
  } elseif ($choice -match '^\d+$') {
    $n = [int]$choice
    if ($n -ge 1 -and $n -le $projects.Count) {
      $p = $projects[$n - 1]
      Start-ClaudeIn $p.Path $p.Name $false
    } else {
      Write-Host "There is no project $n." -ForegroundColor Yellow
    }
  } elseif ($choice -match '^[Cc]$') {
    $target = Select-Target $projects
    if ($target) { Start-ClaudeIn $target.Path $target.Name $true }
  } elseif ($choice -match '^[Oo]$') {
    Open-Navigator
  } elseif ($choice -match '^[Qq]$') {
    $running = $false
  } elseif ($choice) {
    Write-Host "Unknown choice: $choice" -ForegroundColor Yellow
  }
}
