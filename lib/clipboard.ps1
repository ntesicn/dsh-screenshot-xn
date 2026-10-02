# dsh-screenshot-xn clipboard script.
#
# Puts one piece of text on the Windows clipboard, on behalf of the overlay page.
#
# Why a script instead of letting the page call navigator.clipboard:
#   the overlay page's contract (README "the page never touches the OS", pinned by
#   tests/overlay-page.test.mjs t57-4) is that the page never touches the OS - it only
#   hands data to this host. The clipboard is OS state, so it lives here, next to the
#   screen capture and the OCR engine. It also means the copy works even when the kiosk
#   window has lost focus or the browser refuses a clipboard write without a gesture.
#
# The text arrives as a **file path**, never as an argument: the text can be a whole
# screenful of CJK with quotes and newlines, and round-tripping that through a Windows
# command line is exactly the kind of encoding bug that only shows up in the field.
#
# Contract (see index.js): print machine-readable JSON between the markers on stdout and
# exit non-zero with ok=false on failure.
#
#   ---JSON-BEGIN---
#   { ... one JSON object ... }
#   ---JSON-END---
#
# Result fields:
#   ok         boolean  true only when the clipboard was written
#   chars      integer  characters written
#   bytes      integer  UTF-8 bytes of the source file
#   apartment  string   STA | MTA | Unknown (Set-Clipboard needs STA; reported for diagnosis)
#   verified   boolean  whether reading the clipboard back returned the same text
#   elapsed_ms integer  read + write + verify
#   powershell string   reporting engine version
#   process_id integer  this process id
#   error      string   failure text (null on success)
#
# ASCII only on purpose (Windows PowerShell 5.1 mis-parses non-BOM UTF-8 files with
# non-ASCII comments). No third-party dependency: .NET Framework only.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'

# Same reason as lib/ocr.ps1: a redirected stdout pipe is written in the OEM code page
# unless it is pinned, and this JSON can carry CJK text from a failure message.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
  # No console to reconfigure: the JSON keys/values that matter here are ASCII.
}

$script:result = [ordered]@{
  ok         = $false
  chars      = 0
  bytes      = 0
  apartment  = [string][System.Threading.Thread]::CurrentThread.GetApartmentState()
  verified   = $false
  elapsed_ms = 0
  powershell = $PSVersionTable.PSVersion.ToString()
  process_id = $PID
  error      = $null
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

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "text file not found: $Path" }

$startedAt = Get-Date
$text = ''
try {
  $info = Get-Item -LiteralPath $Path
  $script:result['bytes'] = [int]$info.Length
  # Explicit UTF-8 regardless of BOM: the host writes UTF-8 without a BOM, and this
  # script must not fall back to the ANSI code page (that is what turns CJK into '?').
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
} catch {
  Fail "the text file could not be read ($($_.Exception.Message))"
}

$script:result['chars'] = $text.Length
if ($text.Length -eq 0) { Fail 'refusing to overwrite the clipboard with an empty text' }

# Set-Clipboard (Microsoft.PowerShell.Management) needs a single-threaded apartment; it
# keeps the data on the clipboard after this process exits, which is the whole point.
try {
  Set-Clipboard -Value $text
} catch {
  Fail "Set-Clipboard failed ($($_.Exception.Message)); apartment=$($script:result['apartment'])"
}

if ($Verify) {
  # Read back through a *separate* process: reading it back inside this one would only
  # prove that the local variable survived, not that the clipboard was actually owned
  # after we exit (a real failure mode of clipboard writes).
  try {
    $script:result['verified'] = $false
    $check = & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command 'Get-Clipboard -Raw'
    if ($null -ne $check) {
      $back = ($check -join "`n").TrimEnd("`r", "`n")
      $script:result['verified'] = ($back -ceq $text.TrimEnd("`r", "`n"))
    }
  } catch {
    $script:result['verified'] = $false
  }
} else {
  $script:result['verified'] = $true
}

$script:result['elapsed_ms'] = [int]((Get-Date) - $startedAt).TotalMilliseconds
Write-Result -Code 0
