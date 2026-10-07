# dsh-screenshot-xn host capture script (Windows PowerShell 5.1 compatible).
#
# Contract (see index.js and README.md): print machine-readable JSON between the
# markers below on stdout, and exit non-zero with ok=false on failure.
#
#   ---JSON-BEGIN---
#   { ... one JSON object ... }
#   ---JSON-END---
#
# Result fields (index.js parses exactly these):
#   ok                  boolean  true only when the requested mode finished
#   mode                string   info | shot | both
#   bitmap_width/height integer  device pixels of the captured bitmap
#                                (measured from the PNG when a shot was taken,
#                                 otherwise the rectangle a DPI-aware capture of
#                                 this process would produce)
#   capture_bounds      object   { x, y, width, height } of the rectangle the
#                                bitmap covers (P0: the primary screen)
#   virtual_screen      object   { x, y, width, height } union of all monitors,
#                                diagnostics only
#   primary_only        boolean  always true in P0 (only the primary screen is captured)
#   screen_count        integer  number of attached monitors
#   single_screen       boolean  screen_count == 1 (P0 supports the primary screen only)
#   scale               number   bitmap pixels per screen pixel (null when unknown)
#   dpi_aware           boolean  whether this process asked for DPI awareness
#   dpi_awareness       string   which DPI-awareness call succeeded
#   dpi_system          integer  GetDpiForSystem() (0 when unavailable)
#   dpi_logpixelsx      integer  GetDeviceCaps(LOGPIXELSX) of the screen DC
#   png_path            string   absolute path of the PNG (null when no shot)
#   png_bytes           integer  size of that PNG in bytes (null when no shot)
#   elapsed_capture_ms  integer  CopyFromScreen duration (null when no shot)
#   elapsed_total_ms    integer  CopyFromScreen + PNG encode + verification
#   out_dir             string   directory the PNG was written to (after any fallback)
#   out_dir_requested   string   directory the caller asked for
#   out_dir_writable    boolean  whether the requested directory accepts a file (t81)
#   out_dir_reason      string   why it was rejected (null when writable)
#   out_dir_fallback    boolean  true when a fallback directory was used instead
#   tag                 string   file-name tag
#   powershell          string   reporting engine version
#   process_id          integer  this process id
#   error               string   failure text (null on success)
#
# Through capture (-Through, t44): hide the DSH window, wait, grab, restore.
#   through             string   off | pending | captured | skipped | failed
#   through_reason      string   why through was skipped/failed (null when captured)
#   hidden_ms           integer  hide -> pixel grab measured ms (0 when nothing was hidden)
#   restore_ok          boolean  whether the hidden window was confirmed visible again
#                                (true when nothing was hidden, i.e. "nothing to restore")
#   through_total_ms    integer  hide + wait + grab + restore, measured end to end
#   foreground_ok       boolean  whether the restored window also got focus back
#   hidden_hwnd/pid/title/image  the window that was hidden (diagnostics only)
#
# Safety rules of -Through, in this order:
#   1. the target window must be positively identified as DSH's own - by this
#      process's parent pid (-DshPid), by image name (-DshImage) or by a title
#      fragment (-DshTitleHint). Only a visible top-level window qualifies, and
#      this process's own windows never do.
#   2. no confirmed target -> nothing is hidden: the script reports
#      through=skipped and captures normally (the caller falls back to normal
#      mode). Hiding somebody else's window is never acceptable.
#   3. the window is restored in a finally block, so every path - capture
#      failure, exception, PNG encode failure - still restores it.
#   4. -RestoreOnly is the caller's rescue entry point: it resolves the window
#      and restores it without capturing anything.
#
# ASCII only on purpose: Windows PowerShell 5.1 mis-parses non-BOM UTF-8 files
# that contain non-ASCII comments, and this file is loaded by powershell.exe
# with -ExecutionPolicy Bypass. No third-party dependency is used: only .NET
# Framework System.Drawing / System.Windows.Forms plus user32/gdi32 P/Invoke.

param(
  [ValidateSet('info', 'shot', 'both')][string]$Mode = 'both',
  [switch]$DpiAware,
  [string]$OutDir = $env:TEMP,
  [string]$Tag = 'dsh-screenshot-xn',
  [switch]$Through,
  [ValidateRange(0, 5000)][int]$HideWaitMs = 250,
  [ValidateSet('hide', 'minimize')][string]$HideMethod = 'hide',
  [int]$DshPid = 0,
  [string]$DshImage = '',
  [string]$DshTitleHint = 'DSH',
  [switch]$RestoreOnly
)

$ErrorActionPreference = 'Stop'

# Every field the caller may read, pre-declared so a failure still emits a
# complete object with the same shape as a success.
$script:result = [ordered]@{
  ok                 = $false
  mode               = $Mode
  bitmap_width       = 0
  bitmap_height      = 0
  virtual_screen     = @{ x = 0; y = 0; width = 0; height = 0 }
  capture_bounds     = @{ x = 0; y = 0; width = 0; height = 0 }
  screen_count       = 0
  single_screen      = $false
  primary_only       = $true
  scale              = $null
  dpi_aware          = [bool]$DpiAware
  dpi_awareness      = 'not-requested'
  dpi_system         = 0
  dpi_logpixelsx     = 0
  png_path           = $null
  png_bytes          = $null
  elapsed_capture_ms = $null
  elapsed_total_ms   = $null
  out_dir            = $null
  out_dir_requested  = $null
  out_dir_writable   = $false
  out_dir_reason     = $null
  out_dir_fallback   = $false
  tag                = $Tag
  powershell         = $PSVersionTable.PSVersion.ToString()
  process_id         = $PID
  error              = $null
  through            = 'off'
  through_reason     = $null
  hidden_ms          = 0
  restore_ok         = $true
  through_total_ms   = 0
  foreground_ok      = $true
  hidden_hwnd        = 0
  hidden_pid         = 0
  hidden_title       = $null
  hidden_image       = $null
}

# Emit the result and terminate with the given exit code. `exit` inside a
# function ends the script, which is what we want on every path.
function Write-Result {
  param([int]$Code = 0)
  $script:result['ok'] = ($Code -eq 0)
  Write-Host '---JSON-BEGIN---'
  Write-Host ($script:result | ConvertTo-Json -Depth 6 -Compress)
  Write-Host '---JSON-END---'
  exit $Code
}

function Fail {
  param([string]$Message, [int]$Code = 3)
  $script:result['error'] = $Message
  Write-Result -Code $Code
}

# ------------------------------------------------- output directory checks (t81)
# GDI+ reports only "a generic error occurred in GDI+" for a directory it cannot
# write to, which hides the real cause: a directory created while DSH ran elevated
# can belong to Administrators and carry no ACE for the current user - and that
# user often cannot even delete it. Probe before saving, and never fail a capture
# over a directory that cannot be used.
# Returns $null when the directory accepts a file, otherwise the reason it does not.
function Test-WritableDirectory {
  param([string]$Path)
  $probe = Join-Path $Path ('.dsh-write-probe-{0}.tmp' -f [guid]::NewGuid().ToString('N').Substring(0, 8))
  # The probe is the only trustworthy answer: New-Item -Force reports nothing at all
  # for a path it cannot create in Windows PowerShell 5.1 (measured), and an existing
  # directory can be listed while refusing every write. So: write, then - only if that
  # failed - create and write again.
  try {
    [System.IO.File]::WriteAllText($probe, 'dsh-screenshot-xn write probe')
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $null
  } catch {
    $first = $_.Exception.Message
  }
  try { New-Item -ItemType Directory -Force -Path $Path -ErrorAction SilentlyContinue | Out-Null } catch { }
  if (-not (Test-Path -LiteralPath $Path)) {
    return "the directory cannot be created: $first"
  }
  try {
    [System.IO.File]::WriteAllText($probe, 'dsh-screenshot-xn write probe')
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $null
  } catch {
    $owner = ''
    try { $owner = " (owner=$((Get-Acl -LiteralPath $Path).Owner))" } catch { }
    return "a probe file cannot be written there: $($_.Exception.Message)$owner"
  }
}

# --------------------------------------------------------------- window helpers
# Read the owning process, image name, title and state of one window handle.
function Get-WindowInfo {
  param([IntPtr]$Handle)
  if ($Handle -eq [IntPtr]::Zero) { return $null }
  $ownerPid = 0
  [void][DshScreenshotNative]::GetWindowThreadProcessId($Handle, [ref]$ownerPid)
  if ($ownerPid -le 0) { return $null }
  $image = ''
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($null -ne $proc) { $image = $proc.ProcessName }
  $buffer = New-Object System.Text.StringBuilder 512
  [void][DshScreenshotNative]::GetWindowTextW($Handle, $buffer, 512)
  return @{
    hwnd    = $Handle
    pid     = [int]$ownerPid
    image   = $image
    title   = $buffer.ToString()
    visible = [bool][DshScreenshotNative]::IsWindowVisible($Handle)
    iconic  = [bool][DshScreenshotNative]::IsIconic($Handle)
  }
}

# A window is DSH's own when it matches the caller-supplied pid, image name or
# title fragment. Anything else is off limits.
function Test-IsDshWindow {
  param($Window, [int]$OwnerPid, [string]$Image, [string]$TitleHint)
  if ($null -eq $Window) { return $false }
  if ($Window.pid -eq $PID) { return $false }
  if ($OwnerPid -gt 0 -and $Window.pid -eq $OwnerPid) { return $true }
  if (-not [string]::IsNullOrWhiteSpace($Image)) {
    $expected = $Image -replace '\.exe$', ''
    if ($Window.image -ieq $expected) { return $true }
  }
  if (-not [string]::IsNullOrWhiteSpace($TitleHint) -and $Window.title -like "*$TitleHint*") { return $true }
  return $false
}

# Resolve the DSH window: foreground window first, then the known process's main
# window, then any visible top-level window of the expected image. $null means
# "could not confirm" and the caller then never hides anything.
function Resolve-DshWindow {
  param([int]$OwnerPid, [string]$Image, [string]$TitleHint)
  $foreground = Get-WindowInfo -Handle ([DshScreenshotNative]::GetForegroundWindow())
  if ((Test-IsDshWindow -Window $foreground -OwnerPid $OwnerPid -Image $Image -TitleHint $TitleHint) -and $foreground.visible) {
    return $foreground
  }
  if ($OwnerPid -gt 0 -and $OwnerPid -ne $PID) {
    $proc = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
    if ($null -ne $proc -and [int64]$proc.MainWindowHandle -ne 0) {
      $candidate = Get-WindowInfo -Handle ([IntPtr]$proc.MainWindowHandle)
      if ((Test-IsDshWindow -Window $candidate -OwnerPid $OwnerPid -Image $Image -TitleHint $TitleHint) -and $candidate.visible) {
        return $candidate
      }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($Image)) {
    $expected = $Image -replace '\.exe$', ''
    $matches = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessName -ieq $expected -and $_.Id -ne $PID -and [int64]$_.MainWindowHandle -ne 0
    })
    if ($matches.Count -gt 0) {
      $chosen = $matches | Where-Object { -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } | Select-Object -First 1
      if ($null -eq $chosen) { $chosen = $matches[0] }
      $candidate = Get-WindowInfo -Handle ([IntPtr]$chosen.MainWindowHandle)
      if ($null -ne $candidate) { return $candidate }
    }
  }
  return $null
}

# Give the focus back. The first SetForegroundWindow can be refused by the
# foreground lock; tapping ALT releases it, which is the documented trick.
function Set-DshForeground {
  param([IntPtr]$Handle)
  try {
    if ([DshScreenshotNative]::GetForegroundWindow() -eq $Handle) { return $true }
    [void][DshScreenshotNative]::SetForegroundWindow($Handle)
    if ([DshScreenshotNative]::GetForegroundWindow() -eq $Handle) { return $true }
    [DshScreenshotNative]::keybd_event([byte]0x12, [byte]0, [uint32]0, [IntPtr]::Zero)
    [DshScreenshotNative]::keybd_event([byte]0x12, [byte]0, [uint32]2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 30
    [void][DshScreenshotNative]::SetForegroundWindow($Handle)
    return ([DshScreenshotNative]::GetForegroundWindow() -eq $Handle)
  } catch {
    return $false
  }
}

# Restore the window and confirm it is visible and not minimized again. The
# confirmation is the return value; SW_RESTORE is tried twice, then SW_SHOW /
# SW_SHOWNORMAL as forced fallbacks, so a single refusal cannot leave the window
# hidden.
function Restore-DshWindow {
  param($Window)
  if ($null -eq $Window) { return $true }
  $handle = $Window.hwnd
  $restored = $false
  $attempts = @(9, 9, 5, 1)   # SW_RESTORE, SW_RESTORE, SW_SHOW, SW_SHOWNORMAL
  foreach ($command in $attempts) {
    try {
      [void][DshScreenshotNative]::ShowWindow($handle, $command)
      Start-Sleep -Milliseconds 80
      $visible = [bool][DshScreenshotNative]::IsWindowVisible($handle)
      $iconic = [bool][DshScreenshotNative]::IsIconic($handle)
      if ($visible -and -not $iconic) { $restored = $true; break }
    } catch {
      $restored = $false
    }
  }
  $script:result['foreground_ok'] = [bool](Set-DshForeground -Handle $handle)
  return [bool]$restored
}

try {
  # ---------------------------------------------------------------- native API
  $nativeSource = @'
using System;
using System.Runtime.InteropServices;
public static class DshScreenshotNative {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr hWnd, IntPtr rect, IntPtr region, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
}
'@
  try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp | Out-Null
  } catch {
    # Re-using the type inside one session (dot-sourcing) is not an error.
    if ("$($_.Exception.Message)" -notmatch 'already exists') { throw }
  }
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms

  # --------------------------------------------------------- DPI awareness
  # Must be the first thing that touches a display, otherwise the bitmap comes
  # back at the virtualized (logical) size and every selection maps wrong.
  if ($DpiAware) {
    $perMonitor = $false
    try { $perMonitor = [DshScreenshotNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $perMonitor = $false }
    $systemAware = [DshScreenshotNative]::SetProcessDPIAware()
    $script:result['dpi_awareness'] = "SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2=-4)=$perMonitor; SetProcessDPIAware()=$systemAware"
  }

  # --------------------------------------------------- restore-only (rescue)
  # The caller's second chance: if a through capture could not confirm the
  # restore (or died mid-flight), it runs this entry point, which resolves the
  # DSH window and restores it without touching the screen. Idempotent: running
  # it on an already visible window is a no-op that still reports success.
  if ($RestoreOnly) {
    $rescue = Resolve-DshWindow -OwnerPid $DshPid -Image $DshImage -TitleHint $DshTitleHint
    if ($null -eq $rescue) {
      $script:result['through'] = 'pending'
      $script:result['restore_ok'] = $false
      Fail 'restore-only: no DSH window could be confirmed' 6
    }
    $script:result['hidden_hwnd'] = [int64]$rescue.hwnd
    $script:result['hidden_pid'] = $rescue.pid
    $script:result['hidden_title'] = $rescue.title
    $script:result['hidden_image'] = $rescue.image
    $restored = Restore-DshWindow -Window $rescue
    $script:result['restore_ok'] = [bool]$restored
    $script:result['through'] = 'pending'
    if (-not $restored) {
      Fail 'restore-only: the DSH window could not be confirmed visible again' 7
    }
    Write-Result -Code 0
  }

  # ------------------------------------------------------------ screen facts
  # P0 scope: the primary screen only (PRD A-03 / DoD E-2). `capture_bounds` is
  # the rectangle the bitmap covers; `virtual_screen` is the union of every
  # attached monitor, reported for diagnostics so a multi-monitor setup is
  # visible in the result instead of being silently half-captured.
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
  $bounds = $screen.Bounds
  $all = [System.Windows.Forms.Screen]::AllScreens
  $script:result['capture_bounds'] = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
  $left = ($all | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum
  $top = ($all | ForEach-Object { $_.Bounds.Y } | Measure-Object -Minimum).Minimum
  $right = ($all | ForEach-Object { $_.Bounds.X + $_.Bounds.Width } | Measure-Object -Maximum).Maximum
  $bottom = ($all | ForEach-Object { $_.Bounds.Y + $_.Bounds.Height } | Measure-Object -Maximum).Maximum
  $script:result['virtual_screen'] = @{ x = [int]$left; y = [int]$top; width = [int]($right - $left); height = [int]($bottom - $top) }
  $script:result['screen_count'] = $all.Count
  $script:result['single_screen'] = ($all.Count -eq 1)
  $script:result['primary_only'] = $true
  $script:result['bitmap_width'] = $bounds.Width
  $script:result['bitmap_height'] = $bounds.Height

  try { $script:result['dpi_system'] = [int][DshScreenshotNative]::GetDpiForSystem() } catch { $script:result['dpi_system'] = 0 }
  $screenDc = [DshScreenshotNative]::GetDC([IntPtr]::Zero)
  try {
    $script:result['dpi_logpixelsx'] = [int][DshScreenshotNative]::GetDeviceCaps($screenDc, 88)  # LOGPIXELSX
  } finally {
    [void][DshScreenshotNative]::ReleaseDC([IntPtr]::Zero, $screenDc)
  }
  if ($bounds.Width -lt 1 -or $bounds.Height -lt 1) { Fail 'primary screen reports an empty bounds rectangle' 4 }

  # ---------------------------------------------------------------- capture
  if ($Mode -eq 'info') {
    $script:result['scale'] = 1.0
    Write-Result -Code 0
  }

  # t81: the caller's directory wins, but only if it really accepts a file. A
  # leftover directory from an elevated run is the usual trap, so fall back to a
  # per-user directory (then to a fresh one) instead of letting GDI+ fail later.
  $requested = $OutDir
  if ([string]::IsNullOrWhiteSpace($requested)) { $requested = $env:TEMP }
  $script:result['out_dir_requested'] = $requested
  $reason = Test-WritableDirectory -Path $requested
  $target = $null
  if ($null -eq $reason) {
    $target = $requested
    $script:result['out_dir_writable'] = $true
  } else {
    $script:result['out_dir_reason'] = $reason
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      $candidates += (Join-Path $env:LOCALAPPDATA 'dsh-screenshot-xn')
    }
    $candidates += (Join-Path $env:TEMP ('dsh-screenshot-xn-' + [guid]::NewGuid().ToString('N').Substring(0, 8)))
    foreach ($candidate in $candidates) {
      $candidateReason = Test-WritableDirectory -Path $candidate
      if ($null -eq $candidateReason) {
        $target = $candidate
        $script:result['out_dir_fallback'] = $true
        break
      }
      $script:result['out_dir_reason'] = "$reason; $candidate also failed: $candidateReason"
    }
    if ($null -eq $target) { Fail "no writable output directory: $($script:result['out_dir_reason'])" 6 }
  }
  $script:result['out_dir'] = (Resolve-Path -LiteralPath $target).Path
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
  $file = Join-Path $target ("{0}_{1}.png" -f $Tag, $stamp)

  # ------------------------------------------- through capture: resolve target
  # Decide *before* touching anything: no confirmed DSH window means no hiding,
  # and the caller falls back to the ordinary capture.
  $window = $null
  if ($Through) {
    $script:result['through'] = 'pending'
    try {
      $window = Resolve-DshWindow -OwnerPid $DshPid -Image $DshImage -TitleHint $DshTitleHint
    } catch {
      $window = $null
      $script:result['through_reason'] = "window resolution failed: $($_.Exception.Message)"
    }
    if ($null -eq $window) {
      $script:result['through'] = 'skipped'
      if ([string]::IsNullOrWhiteSpace([string]$script:result['through_reason'])) {
        $script:result['through_reason'] = 'no DSH window could be confirmed by pid/image/title; captured normally'
      }
    }
  }

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $hidden = $false
  $hideWatch = $null
  try {
    if ($null -ne $window) {
      # SW_HIDE (0) or SW_MINIMIZE (6); the wait lets the compositor settle.
      $showCommand = 0
      if ($HideMethod -eq 'minimize') { $showCommand = 6 }
      [void][DshScreenshotNative]::ShowWindow($window.hwnd, $showCommand)
      $hidden = $true
      $hideWatch = [System.Diagnostics.Stopwatch]::StartNew()
      $script:result['hidden_hwnd'] = [int64]$window.hwnd
      $script:result['hidden_pid'] = $window.pid
      $script:result['hidden_title'] = $window.title
      $script:result['hidden_image'] = $window.image
      if ($HideWaitMs -gt 0) { Start-Sleep -Milliseconds $HideWaitMs }
      # Confirm the window really left the screen before grabbing pixels: a silent
      # refusal (elevated/blocked window) must not be reported as a through
      # capture whose frame still contains DSH.
      $gone = $false
      try {
        if ($HideMethod -eq 'minimize') { $gone = [bool][DshScreenshotNative]::IsIconic($window.hwnd) }
        else { $gone = -not [bool][DshScreenshotNative]::IsWindowVisible($window.hwnd) }
      } catch { $gone = $false }
      if (-not $gone) {
        $script:result['through'] = 'hide-failed'
        $script:result['through_reason'] = 'the DSH window is still visible after ShowWindow'
        throw 'through: the DSH window could not be hidden'
      }
      # Force the exposed area to repaint, otherwise the compositor can still
      # hand back the last composed frame of the hidden window.
      try { [void][DshScreenshotNative]::RedrawWindow([IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 0x0185) } catch { }
      try { [void][DshScreenshotNative]::DwmFlush() } catch { }
    }

    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        # `elapsed_capture_ms` stays the pure copy duration: the hide/wait part of
        # a through capture is reported separately as `hidden_ms`.
        $copyWatch = [System.Diagnostics.Stopwatch]::StartNew()
        $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
        $copyWatch.Stop()
      } finally {
        $graphics.Dispose()
      }
      $script:result['elapsed_capture_ms'] = [int]$copyWatch.ElapsedMilliseconds
      if ($hidden) { $script:result['hidden_ms'] = [int]$hideWatch.ElapsedMilliseconds }
      try {
        $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
      } catch {
        # The probe above normally prevents this; if the directory turned
        # unwritable in between, name the cause instead of GDI+'s generic error.
        $why = Test-WritableDirectory -Path $target
        if ($null -ne $why) { throw "cannot write the PNG into $target - $why" }
        throw
      }
    } finally {
      $bitmap.Dispose()
    }
  } finally {
    # The restore lives here on purpose: capture failure, GDI+ failure, PNG
    # encode failure and exceptions all reach it, so the window never stays
    # hidden. It runs before the PNG is verified so the file check cannot skip it.
    if ($hidden) {
      $restored = Restore-DshWindow -Window $window
      $script:result['restore_ok'] = [bool]$restored
      if (-not $restored) {
        $script:result['through'] = 'failed'
        $script:result['through_reason'] = 'the DSH window could not be confirmed visible again'
      } elseif ([string]$script:result['through'] -eq 'pending') {
        $script:result['through'] = 'captured'
      }
      $script:result['through_total_ms'] = [int]$watch.ElapsedMilliseconds
    }
  }
  $watch.Stop()
  $script:result['elapsed_total_ms'] = [int]$watch.ElapsedMilliseconds

  $item = Get-Item -LiteralPath $file
  $image = [System.Drawing.Image]::FromFile($file)
  try {
    $script:result['bitmap_width'] = [int]$image.Width
    $script:result['bitmap_height'] = [int]$image.Height
  } finally {
    $image.Dispose()
  }
  $script:result['png_path'] = $item.FullName
  $script:result['png_bytes'] = [int64]$item.Length
  $script:result['scale'] = [math]::Round($script:result['bitmap_width'] / [double]$bounds.Width, 4)

  if ($script:result['png_bytes'] -le 0) { Fail 'capture produced an empty PNG' 5 }
  Write-Result -Code 0
} catch {
  $where = ''
  if ($null -ne $_.InvocationInfo -and $null -ne $_.InvocationInfo.ScriptLineNumber) {
    $where = " @ line $($_.InvocationInfo.ScriptLineNumber)"
  }
  $script:result['error'] = "$($_.Exception.Message)$where"
  Write-Result -Code 1
}
