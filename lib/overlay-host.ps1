# dsh-screenshot-xn overlay host helper (t56): browser resolution, kiosk launch support,
# process probing and the "close the window first, kill only if needed" teardown.
#
# Contract with index.js: print one JSON object between the markers below and exit
# non-zero only for hard failures (missing arguments, unresolvable state).
#
#   ---JSON-BEGIN---
#   { ... }
#   ---JSON-END---
#
# Actions:
#   browsers  -> { ok, browsers: [{ name, path }] }        first entry wins (Edge, then Chrome)
#   launch    -> { ok, pid, executable, args, user_data_dir }  kiosk window for -Url
#   stop      -> { ok, stopped, killed, elapsed_ms, waited_ms }  CloseMainWindow, then kill
#   probe     -> { ok, alive, has_window }                 is that kiosk still there?
#
# ASCII only on purpose (Windows PowerShell 5.1 mis-parses non-BOM UTF-8 with
# non-ASCII comments). No third-party dependency: user32 P/Invoke + .NET only.

param(
  [ValidateSet('browsers', 'launch', 'stop', 'probe')][string]$Action = 'browsers',
  [string]$Url = '',
  [int]$TargetPid = 0,
  [int]$WaitMs = 1500,
  [string]$UserDataDir = ''
)

$ErrorActionPreference = 'Stop'

$script:result = [ordered]@{
  ok            = $false
  action        = $Action
  browsers      = @()
  pid           = 0
  executable    = $null
  args          = @()
  user_data_dir = $null
  alive         = $false
  has_window    = $false
  had_window    = $false
  stopped       = $false
  killed        = $false
  elapsed_ms    = 0
  waited_ms     = 0
  error         = $null
}

function Write-Result {
  param([int]$Code = 0)
  $script:result['ok'] = ($Code -eq 0)
  Write-Host '---JSON-BEGIN---'
  Write-Host ($script:result | ConvertTo-Json -Depth 5 -Compress)
  Write-Host '---JSON-END---'
  exit $Code
}

function Fail {
  param([string]$Message, [int]$Code = 3)
  $script:result['error'] = $Message
  Write-Result -Code $Code
}

# ---------------------------------------------------------------- native bits
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
public static class OverlayHostNative {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@
try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp | Out-Null
} catch {
  if ("$($_.Exception.Message)" -notmatch 'already exists') { throw }
}

# ------------------------------------------------------------ browser lookup
# Edge first, then Chrome: the spike measured Edge kiosk covering the whole
# screen (incl. the taskbar) with a 435-458 ms cold start.
$candidates = @(
  @{ name = 'edge';   path = (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') },
  @{ name = 'edge';   path = (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') },
  @{ name = 'chrome'; path = (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') },
  @{ name = 'chrome'; path = (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') },
  @{ name = 'chrome'; path = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe') }
)

function Get-Browsers {
  $found = New-Object System.Collections.ArrayList
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate.path)) { continue }
    if (Test-Path -LiteralPath $candidate.path) {
      [void]$found.Add(@{ name = $candidate.name; path = (Resolve-Path -LiteralPath $candidate.path).Path })
    }
  }
  if ($found.Count -eq 0) {
    foreach ($name in @('msedge.exe', 'chrome.exe')) {
      $command = Get-Command $name -ErrorAction SilentlyContinue
      if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
        [void]$found.Add(@{ name = ($name -replace '\.exe$', ''); path = $command.Source })
      }
    }
  }
  return @($found)
}

function Get-ProcessTree {
  param([int]$RootPid)
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
  $tree = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  [void]$tree.Add($RootPid)
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    foreach ($child in $all) {
      if ($child.ParentProcessId -eq $current -and -not $tree.Contains([int]$child.ProcessId)) {
        [void]$tree.Add([int]$child.ProcessId)
        $queue.Enqueue([int]$child.ProcessId)
      }
    }
  }
  return @($tree)
}

switch ($Action) {
  'browsers' {
    try {
      $script:result['browsers'] = @(Get-Browsers)
      Write-Result -Code 0
    } catch {
      Fail "browser lookup failed: $($_.Exception.Message)" 1
    }
  }

  'launch' {
    if ([string]::IsNullOrWhiteSpace($Url)) { Fail 'launch needs -Url' 2 }
    $browsers = Get-Browsers
    if ($browsers.Count -eq 0) { $script:result['error'] = 'no-browser'; Write-Result -Code 3 }
    $browser = $browsers[0]
    $profile = $UserDataDir
    if ([string]::IsNullOrWhiteSpace($profile)) {
      $profile = Join-Path $env:TEMP ("dsh-screenshot-xn-overlay-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    }
    if (-not (Test-Path -LiteralPath $profile)) { New-Item -ItemType Directory -Force -Path $profile | Out-Null }
    $arguments = @(
      '--kiosk',
      $Url,
      "--user-data-dir=$profile",
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--no-service-autorun',
      '--disable-features=msEdgeFirstRunExperience,msImplicitSignin'
    )
    try {
      $watch = [System.Diagnostics.Stopwatch]::StartNew()
      $process = Start-Process -FilePath $browser.path -ArgumentList $arguments -PassThru
      $watch.Stop()
      $script:result['pid'] = [int]$process.Id
      $script:result['executable'] = $browser.path
      $script:result['args'] = $arguments
      $script:result['user_data_dir'] = $profile
      $script:result['elapsed_ms'] = [int]$watch.ElapsedMilliseconds
      Write-Result -Code 0
    } catch {
      Fail "launch failed: $($_.Exception.Message)" 4
    }
  }

  'stop' {
    if ($TargetPid -le 0) { Fail 'stop needs -TargetPid' 2 }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $tree = Get-ProcessTree -RootPid $TargetPid
    # 1. ask the visible windows to close (kiosk windows honour WM_CLOSE).
    $closed = $false
    $hadWindow = $false
    foreach ($processId in $tree) {
      $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($null -eq $process) { continue }
      try {
        if ($process.MainWindowHandle -ne 0) {
          $hadWindow = $true
          $closed = [bool]$process.CloseMainWindow() -or $closed
        }
      } catch { }
    }
    # The grace period only exists to let a window finish closing: with no window
    # to close there is nothing to wait for, so the kill happens immediately
    # (a headless stand-in must not make the caller wait out the whole grace).
    $waited = [System.Diagnostics.Stopwatch]::StartNew()
    if ($hadWindow) {
      while ($waited.ElapsedMilliseconds -lt $WaitMs) {
        $still = @($tree | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
        if ($still.Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
      }
    }
    $waited.Stop()
    $script:result['waited_ms'] = [int]$waited.ElapsedMilliseconds
    $script:result['had_window'] = $hadWindow
    # 2. anything still alive gets terminated (children first).
    $remaining = @($tree | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
    if ($remaining.Count -gt 0) {
      foreach ($processId in ($remaining | Sort-Object -Descending)) {
        try { Stop-Process -Id $processId -Force -ErrorAction Stop; $script:result['killed'] = $true } catch { }
      }
      Start-Sleep -Milliseconds 200
    }
    $watch.Stop()
    $script:result['elapsed_ms'] = [int]$watch.ElapsedMilliseconds
    $script:result['stopped'] = (@($tree | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) }).Count -eq 0)
    Write-Result -Code 0
  }

  'probe' {
    if ($TargetPid -le 0) { Fail 'probe needs -TargetPid' 2 }
    $process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      $script:result['alive'] = $false
      Write-Result -Code 0
    }
    $script:result['alive'] = $true
    try {
      if ($process.MainWindowHandle -ne 0) {
        $script:result['has_window'] = [bool][OverlayHostNative]::IsWindowVisible($process.MainWindowHandle)
      }
    } catch { }
    Write-Result -Code 0
  }
}
