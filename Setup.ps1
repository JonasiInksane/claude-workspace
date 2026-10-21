<#
.SYNOPSIS
  Checks (and optionally sets up) what this Claude Code workspace needs on Windows.

.DESCRIPTION
  -Mode Check    (default) Reports Node.js, git, Git LFS, Git Bash, claude, your user PATH, the
                 global library in ~/.claude, and the projects in projects\repos.json with the
                 tools they need (such as Blender 5.2). Changes nothing.
  -Mode Install  Runs the same checks, clones the listed projects that are missing, installs the
                 library into ~/.claude, builds index.html, runs the workspace self-check and
                 offers to "git init" the workspace. It never installs Blender or other programs.
  -FixPath       Install mode only: appends %USERPROFILE%\.local\bin (where the native
                 installer puts claude.exe) to your USER PATH if it is missing.

  Works in Windows PowerShell 5.1. It never changes the execution policy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Mode Install -FixPath
#>
[CmdletBinding()]
param(
  [ValidateSet('Check', 'Install')][string]$Mode = 'Check',
  [switch]$FixPath
)

$Root = $PSScriptRoot
$LocalBin = Join-Path $env:USERPROFILE '.local\bin'
$SetupCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1'
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'
$script:Problems = 0
$script:Warnings = 0
$script:Next = New-Object System.Collections.ArrayList

# ------------------------------------------------------------------ output helpers

function Write-Section([string]$Title) {
  Write-Host ''
  Write-Host $Title -ForegroundColor Cyan
}
function Write-Ok([string]$Message) {
  Write-Host "  [ OK ] $Message" -ForegroundColor Green
}
function Write-Warn([string]$Message) {
  $script:Warnings++
  Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}
function Write-Fail([string]$Message) {
  $script:Problems++
  Write-Host "  [FAIL] $Message" -ForegroundColor Red
}
function Write-Info([string]$Message) {
  Write-Host "         $Message" -ForegroundColor Gray
}
function Add-NextStep([string]$Step) {
  if (-not $script:Next.Contains($Step)) { [void]$script:Next.Add($Step) }
}

# ------------------------------------------------------------------ path helpers

function ConvertTo-PathKey([string]$Entry) {
  if ([string]::IsNullOrWhiteSpace($Entry)) { return '' }
  $e = [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"'))
  return $e.TrimEnd('\').ToLowerInvariant()
}

function Test-PathListContains([string]$List, [string]$Dir) {
  if ([string]::IsNullOrEmpty($List)) { return $false }
  $want = ConvertTo-PathKey $Dir
  foreach ($part in ($List -split ';')) {
    if ((ConvertTo-PathKey $part) -eq $want) { return $true }
  }
  return $false
}

function Find-GitBash {
  $candidates = New-Object System.Collections.ArrayList
  if ($env:CLAUDE_CODE_GIT_BASH_PATH) { [void]$candidates.Add($env:CLAUDE_CODE_GIT_BASH_PATH) }
  $gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($gitCmd -and $gitCmd.Source) {
    # ...\Git\cmd\git.exe or ...\Git\mingw64\bin\git.exe -> ...\Git\bin\bash.exe
    $gitDir = Split-Path -Parent $gitCmd.Source
    [void]$candidates.Add((Join-Path (Split-Path -Parent $gitDir) 'bin\bash.exe'))
    [void]$candidates.Add((Join-Path (Split-Path -Parent (Split-Path -Parent $gitDir)) 'bin\bash.exe'))
  }
  if ($env:ProgramFiles) { [void]$candidates.Add((Join-Path $env:ProgramFiles 'Git\bin\bash.exe')) }
  if (${env:ProgramFiles(x86)}) { [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe')) }
  if ($env:LOCALAPPDATA) { [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')) }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

# Compares library/<kind> with ~/.claude/<kind>. Returns hashtable name -> 'current'|'outdated'|'missing'.
function Get-LibraryState([string]$Kind) {
  $result = [ordered]@{}
  $src = Join-Path $Root "library\$Kind"
  $dst = Join-Path $ClaudeHome $Kind
  if (-not (Test-Path -LiteralPath $src)) { return $result }
  if ($Kind -eq 'skills') {
    $items = Get-ChildItem -LiteralPath $src -Directory -ErrorAction SilentlyContinue
  } else {
    $items = Get-ChildItem -LiteralPath $src -File -Filter '*.md' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne 'README.md' }
  }
  foreach ($item in $items) {
    $target = Join-Path $dst $item.Name
    if (-not (Test-Path -LiteralPath $target)) { $result[$item.Name] = 'missing'; continue }
    if ($Kind -eq 'skills') { $files = Get-ChildItem -LiteralPath $item.FullName -File -Recurse } else { $files = @($item) }
    $state = 'current'
    foreach ($f in $files) {
      if ($Kind -eq 'skills') {
        $relPath = $f.FullName.Substring($item.FullName.Length).TrimStart('\')
        $other = Join-Path $target $relPath
      } else {
        $other = $target
      }
      if (-not (Test-Path -LiteralPath $other -PathType Leaf)) { $state = 'outdated'; break }
      $a = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
      $b = (Get-FileHash -LiteralPath $other -Algorithm SHA256).Hash
      if ($a -ne $b) { $state = 'outdated'; break }
    }
    $result[$item.Name] = $state
  }
  return $result
}

function Invoke-NodeTool([string]$Title, [string]$Script) {
  $path = Join-Path $Root $Script
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Warn "$Title skipped: $Script not found"
    return $null
  }
  Write-Host ''
  Write-Host "> node $Script" -ForegroundColor DarkGray
  $prevEncoding = $null
  try {
    $prevEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  } catch { $prevEncoding = $null }
  $code = 1
  try {
    # Out-Host keeps the tool's output on screen instead of in this function's return value.
    & node $path | Out-Host
    $code = $LASTEXITCODE
  } finally {
    if ($prevEncoding) { try { [Console]::OutputEncoding = $prevEncoding } catch { } }
  }
  return $code
}

# ------------------------------------------------------------------ start

Write-Host ''
Write-Host "Claude workspace setup  (mode: $Mode)" -ForegroundColor Cyan
Write-Host "Workspace: $Root" -ForegroundColor DarkGray

if (-not (Test-Path -LiteralPath (Join-Path $Root 'tools\install-library.mjs'))) {
  Write-Fail 'This does not look like the workspace root (tools\install-library.mjs is missing).'
  Write-Info 'Run Setup.ps1 from the folder that contains CLAUDE.md and tools\.'
  exit 1
}
if ($FixPath -and $Mode -ne 'Install') {
  Write-Warn '-FixPath only works with -Mode Install. Check mode changes nothing.'
}

# ------------------------------------------------------------------ checks

Write-Section 'Prerequisites'

# Node.js >= 20
$nodeOk = $false
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeVersion = (& node --version | Select-Object -First 1)
  $major = 0
  if ("$nodeVersion" -match '^v(\d+)\.') { $major = [int]$Matches[1] }
  if ($major -ge 20) {
    $nodeOk = $true
    Write-Ok "Node.js $nodeVersion"
  } else {
    Write-Fail "Node.js $nodeVersion is too old; the workspace tools need Node 20 or newer."
    Add-NextStep 'Install Node.js 20 or newer (https://nodejs.org), then run Setup again.'
  }
} else {
  Write-Fail 'Node.js not found. The workspace tools (tools\*.mjs) and hooks need Node 20 or newer.'
  Add-NextStep 'Install Node.js 20 or newer (https://nodejs.org), then run Setup again.'
}

# git
$gitOk = $false
if (Get-Command git -ErrorAction SilentlyContinue) {
  $gitOk = $true
  Write-Ok ((& git --version | Select-Object -First 1))
} else {
  Write-Warn 'git not found. Install Git for Windows (https://git-scm.com) for version control and Git Bash.'
}

# Git LFS (projects with binary assets, such as game-dev, store images and models with it)
$lfsOk = $false
if ($gitOk) {
  # Collect the output first: "| Select-Object -First 1" would stop git early and spoil its exit code.
  $lfsOut = @(& git lfs version 2>$null)
  $lfsCode = $LASTEXITCODE
  $lfsVersion = $lfsOut | Select-Object -First 1
  if ($lfsCode -eq 0 -and $lfsVersion) {
    $lfsOk = $true
    Write-Ok $lfsVersion
  } else {
    Write-Warn 'Git LFS not found. Git for Windows includes it; reinstall Git with the LFS option, or see https://git-lfs.com'
  }
}

# Git Bash (not WSL's bash.exe in System32)
$gitBash = Find-GitBash
if ($gitBash) {
  Write-Ok "Git Bash: $gitBash"
} else {
  Write-Warn 'Git Bash not found. Claude Code then runs shell commands through its PowerShell tool.'
  Write-Info 'The Bash tool needs Git for Windows. If Git is installed in an unusual place, set'
  Write-Info 'CLAUDE_CODE_GIT_BASH_PATH to its bin\bash.exe in the "env" block of ~/.claude/settings.json.'
}

# claude
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$userPathHasBin = Test-PathListContains $userPath $LocalBin
$claudeExe = Join-Path $LocalBin 'claude.exe'
$claudeCmd = Get-Command claude -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
if ($claudeCmd) {
  $claudeVersion = (& $claudeCmd.Source --version | Select-Object -First 1)
  Write-Ok "claude $claudeVersion  ($($claudeCmd.Source))"
} elseif (Test-Path -LiteralPath $claudeExe) {
  $claudeVersion = (& $claudeExe --version | Select-Object -First 1)
  Write-Warn "claude $claudeVersion is installed at $claudeExe but is not on PATH in this terminal."
  # When the user PATH lacks .local\bin, the PATH check below adds the -FixPath step.
  if ($userPathHasBin) {
    Add-NextStep 'Open a new terminal: your user PATH already has .local\bin, this window just started earlier.'
  }
} else {
  Write-Fail 'claude (Claude Code) not found.'
  Write-Info 'Install it with:  irm https://claude.ai/install.ps1 | iex'
  Write-Info 'or:               winget install Anthropic.ClaudeCode   (no auto-update)'
  Add-NextStep 'Install Claude Code (irm https://claude.ai/install.ps1 | iex), then open a new terminal.'
}

# %USERPROFILE%\.local\bin in the USER PATH
$claudeElsewhere = $false
if ($claudeCmd -and $claudeCmd.Source) {
  $claudeElsewhere = -not $claudeCmd.Source.StartsWith($LocalBin, [StringComparison]::OrdinalIgnoreCase)
}
if ($userPathHasBin) {
  Write-Ok '%USERPROFILE%\.local\bin is in your user PATH'
  if (-not (Test-PathListContains $env:Path $LocalBin)) {
    Write-Info 'This terminal started before it was added; open a new terminal to pick it up.'
  }
} elseif ($claudeElsewhere) {
  Write-Info '%USERPROFILE%\.local\bin is not in your user PATH; not needed, claude runs from the path above.'
} elseif ($Mode -eq 'Install' -and $FixPath) {
  Write-Info '%USERPROFILE%\.local\bin is not in your user PATH yet; -FixPath adds it below.'
} else {
  Write-Warn '%USERPROFILE%\.local\bin is not in your user PATH (the native installer puts claude.exe there).'
  Add-NextStep "Add .local\bin to your user PATH: $SetupCmd -Mode Install -FixPath, then open a new terminal."
}

Write-Section 'Global library (~/.claude)'
foreach ($kind in @('skills', 'agents')) {
  $state = Get-LibraryState $kind
  if ($state.Count -eq 0) { Write-Info "library\$kind is empty"; continue }
  # Agent files are shown without ".md".
  $missing = @($state.Keys | Where-Object { $state[$_] -eq 'missing' } | ForEach-Object { $_ -replace '\.md$', '' })
  $outdated = @($state.Keys | Where-Object { $state[$_] -eq 'outdated' } | ForEach-Object { $_ -replace '\.md$', '' })
  $current = @($state.Keys | Where-Object { $state[$_] -eq 'current' } | ForEach-Object { $_ -replace '\.md$', '' })
  if ($missing.Count -eq 0 -and $outdated.Count -eq 0) {
    Write-Ok ("${kind}: all $($current.Count) installed and up to date (" + ($current -join ', ') + ')')
  } elseif ($Mode -eq 'Install') {
    # Install mode copies them in a moment, so this is not a warning yet.
    if ($missing.Count -gt 0) { Write-Info ("${kind} not installed yet (installed below): " + ($missing -join ', ')) }
    if ($outdated.Count -gt 0) { Write-Info ("${kind} differ from library/ (replaced below, old version backed up): " + ($outdated -join ', ')) }
  } else {
    if ($missing.Count -gt 0) { Write-Warn ("${kind} not installed: " + ($missing -join ', ')) }
    if ($outdated.Count -gt 0) { Write-Warn ("${kind} differ from library/ (Install replaces them and keeps a backup): " + ($outdated -join ', ')) }
    Add-NextStep "Set up (installs the library, builds the navigator): $SetupCmd -Mode Install"
  }
}

Write-Section 'Workspace'
$isRepo = Test-Path -LiteralPath (Join-Path $Root '.git')
if ($isRepo) { Write-Ok 'The workspace is a git repository' } else { Write-Info 'Not a git repository yet (Install mode offers "git init").' }
if (Test-Path -LiteralPath (Join-Path $Root 'index.html')) { Write-Ok 'index.html (navigator) exists' } else { Write-Info 'index.html not built yet (Install mode builds it).' }

# Projects: projects\repos.json says which repo belongs in which folder (projects\README.md).
Write-Section 'Projects (projects\repos.json)'
$reposFile = Join-Path $Root 'projects\repos.json'
$repos = @()
if (Test-Path -LiteralPath $reposFile) {
  try { $repos = @((Get-Content -LiteralPath $reposFile -Raw | ConvertFrom-Json).repos) } catch { Write-Fail "projects\repos.json is not valid JSON: $($_.Exception.Message)" }
} else {
  Write-Info 'No projects\repos.json: nothing to clone.'
}
$requires = @{}
foreach ($repo in $repos) {
  if (-not $repo.name -or -not $repo.url -or $repo.name -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$') {
    Write-Warn "projects\repos.json: skipped an entry without a kebab-case name and a url"
    continue
  }
  foreach ($need in @($repo.requires)) { if ($need) { $requires[$need] = $true } }
  $dir = Join-Path $Root "projects\$($repo.name)"
  if (Test-Path -LiteralPath $dir) {
    $origin = ''
    if ($gitOk) { $origin = (& git -C $dir remote get-url origin 2>$null | Select-Object -First 1) }
    if ($origin -and $origin -ne $repo.url) {
      Write-Warn "$($repo.name): present, but its origin is $origin (repos.json says $($repo.url))"
    } else {
      Write-Ok "$($repo.name): present"
    }
  } elseif ($Mode -eq 'Install' -and $gitOk) {
    Write-Info "$($repo.name): cloning $($repo.url) ..."
    & git clone $repo.url $dir
    if ($LASTEXITCODE -eq 0) { Write-Ok "$($repo.name): cloned" } else {
      Write-Fail "$($repo.name): git clone failed (exit code $LASTEXITCODE)"
      Add-NextStep "Clone it yourself once you have access: git clone $($repo.url) projects\$($repo.name)"
    }
  } else {
    Write-Warn "$($repo.name): not cloned yet"
    Write-Info "git clone $($repo.url) projects\$($repo.name)"
    Add-NextStep "Clone the missing projects (listed above): $SetupCmd -Mode Install"
  }
}
# Project folders nobody listed would not reach another PC.
$listed = @($repos | ForEach-Object { $_.name })
Get-ChildItem -LiteralPath (Join-Path $Root 'projects') -Directory -ErrorAction SilentlyContinue |
  Where-Object { $listed -notcontains $_.Name -and -not $_.Name.StartsWith('.') -and -not $_.Name.StartsWith('_') } |
  ForEach-Object { Write-Info "$($_.Name): not in projects\repos.json, so another PC won't get it (add it once it has a GitHub remote)." }

# Tools the listed projects need.
if ($requires['git-lfs'] -and -not $lfsOk) {
  Write-Warn 'A project needs Git LFS (see Prerequisites above); without it its images and models are only pointer files.'
}
if ($requires['blender-5.2']) {
  $blender = $env:BLENDER_EXE
  if (-not $blender) { $blender = Join-Path $env:ProgramFiles 'Blender Foundation\Blender 5.2\blender.exe' }
  if (Test-Path -LiteralPath $blender) {
    $blenderVersion = (& $blender --version 2>$null | Select-Object -First 1)
    if ($blenderVersion -match '^Blender 5\.2\.') { Write-Ok "$blenderVersion  ($blender)" } else {
      Write-Warn "Blender at $blender is '$blenderVersion'; the game-dev asset scripts need 5.2.x."
      Add-NextStep 'Install Blender 5.2: winget install --id BlenderFoundation.Blender --version 5.2.2 --exact; then: winget pin add --id BlenderFoundation.Blender --exact'
    }
  } else {
    Write-Warn 'Blender 5.2 not found (needed by the game-dev asset pipeline).'
    Add-NextStep 'Install Blender 5.2: winget install --id BlenderFoundation.Blender --version 5.2.2 --exact; then: winget pin add --id BlenderFoundation.Blender --exact'
  }
}

# ------------------------------------------------------------------ install

if ($Mode -eq 'Install') {
  Write-Section 'Install'

  if ($FixPath) {
    # Read the raw registry value so %VAR% entries stay unexpanded, and write it back with the same kind.
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (Test-PathListContains $userPath $LocalBin) {
      Write-Ok '%USERPROFILE%\.local\bin is already in your user PATH; nothing to change.'
    } else {
      if ([string]::IsNullOrEmpty($userPath)) { $newPath = $LocalBin } else { $newPath = $userPath.TrimEnd(';') + ';' + $LocalBin }
      $pathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      if ($envKey.GetValueNames() -contains 'Path') { $pathKind = $envKey.GetValueKind('Path') }
      $envKey.SetValue('Path', $newPath, $pathKind)
      # Writing the registry directly doesn't notify Windows; setting and clearing a temporary
      # variable through .NET broadcasts the change so newly opened terminals see the new PATH.
      [Environment]::SetEnvironmentVariable('CLAUDE_WS_PATH_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('CLAUDE_WS_PATH_REFRESH', $null, 'User')
      $env:Path = $env:Path.TrimEnd(';') + ';' + $LocalBin
      Write-Ok "Added $LocalBin to your user PATH. Open a new terminal to use it."
      if (-not (Test-Path -LiteralPath $claudeExe)) { Write-Info 'Note: claude.exe is not in that folder yet.' }
      # The "-FixPath" advice from the checks above is done now.
      foreach ($s in @($script:Next | Where-Object { $_ -like '*-FixPath*' })) { $script:Next.Remove($s) }
      Add-NextStep 'Open a new terminal so the PATH change applies.'
    }
  }

  if (-not $nodeOk) {
    Write-Fail 'Skipping the workspace tools because Node.js 20+ is missing.'
  } else {
    $code = Invoke-NodeTool 'Install library' 'tools\install-library.mjs'
    if ($code -eq 0) { Write-Ok 'Library installed into ~/.claude' } elseif ($null -ne $code) {
      Write-Fail "install-library.mjs failed (exit code $code)"
      Add-NextStep 'Fix the error above, then run: node tools/install-library.mjs'
    }

    $code = Invoke-NodeTool 'Build navigator' 'tools\build-index.mjs'
    if ($code -eq 0) { Write-Ok 'Navigator built: index.html' } elseif ($null -ne $code) { Write-Fail "build-index.mjs failed (exit code $code)" }

    $code = Invoke-NodeTool 'Self-check' 'tools\check-workspace.mjs'
    if ($code -eq 0) { Write-Ok 'Workspace self-check passed' } elseif ($null -ne $code) {
      Write-Warn 'The workspace self-check reported errors (listed above).'
      Add-NextStep 'Fix the errors from: node tools/check-workspace.mjs'
    }
  }

  if (-not $isRepo) {
    if (-not $gitOk) {
      Write-Info 'git is not installed, so "git init" was skipped.'
    } else {
      $answer = ''
      try { $answer = Read-Host 'The workspace is not a git repository. Run "git init" here? (y/N)' } catch { $answer = '' }
      if ("$answer".Trim() -match '^(y|yes)$') {
        # core.longpaths avoids "Filename too long" errors in deep folders on Windows (this repo only).
        & git -c core.longpaths=true init $Root
        if ($LASTEXITCODE -eq 0) {
          & git -C $Root config core.longpaths true
          Write-Ok 'Initialized a git repository in the workspace.'
          Add-NextStep 'Make a first commit: git add -A; git commit -m "Workspace setup"  (check .gitignore first)'
        } else {
          Write-Fail 'git init failed.'
        }
      } else {
        Write-Info 'Skipped git init.'
      }
    }
  }
}

# ------------------------------------------------------------------ summary

Write-Section 'Summary'
if ($script:Problems -eq 0 -and $script:Warnings -eq 0) {
  Write-Host '  Everything looks good.' -ForegroundColor Green
} elseif ($script:Problems -eq 0) {
  Write-Host "  $($script:Warnings) warning(s), no problems." -ForegroundColor Yellow
} else {
  Write-Host "  $($script:Problems) problem(s), $($script:Warnings) warning(s)." -ForegroundColor Red
}

if ($Mode -eq 'Check') {
  Add-NextStep "Set up (installs the library, builds the navigator): $SetupCmd -Mode Install"
}
Add-NextStep 'Start: double-click "Start Workspace.cmd" and pick [W] for the hub.'
Add-NextStep 'Workspace app (projects, agents, images): double-click "Workspace App.cmd". Desktop shortcut: node tools/workspace-app/make-shortcut.mjs'
Add-NextStep 'First start in a folder: accept the trust dialog so the project settings (permissions) apply.'
Add-NextStep 'Fill in context\identity.md, preferences.md, goals.md and stack.md.'

Write-Section 'Next steps'
$i = 1
foreach ($step in $script:Next) {
  Write-Host "  $i. $step"
  $i++
}
Write-Host ''

if ($script:Problems -gt 0) { exit 1 }
exit 0
