/**
 * Host-side through-capture safety tests (t50, closes review finding R6-01).
 *
 * These are the t44 harnesses, moved into the repository so `node --test` guards
 * the promise "the host never leaves DSH hidden":
 *
 *   1. through capture hides the target window, grabs the frame, and restores the
 *      window in a `finally` (the normal path);
 *   2. a reported restore failure makes the host run the rescue entry point and
 *      answer the whole request with 502 - never a frame while the window might
 *      still be hidden;
 *   3. an unconfirmable target means `through=skipped`: nothing is hidden;
 *   4. a request without `mode` behaves exactly as before (`mode: normal`).
 *
 * The target window is always a **stand-in** window created by this file: the
 * real DSH window is never hidden by a test. The stand-in is a near-fullscreen
 * magenta WinForms window (topmost), so a frame containing magenta proves it was
 * visible at capture time and a frame without magenta proves it was hidden. It is
 * closed in the final hook - expect the screen to be covered for a few seconds
 * while this file runs (`node --test` is otherwise unaffected).
 *
 * Every PowerShell helper this needs is written into a temporary directory at
 * runtime, so the repository stays free of throwaway scripts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const POWERSHELL = 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const CAPTURE_SCRIPT = join(PACKAGE, 'lib', 'capture.ps1');
const PROBE_TITLE = 'DshThroughProbe';

const { apply, ROUTE_PATH, OVERLAY_PREFIX, STATE_PATH, MODE_THROUGH, MODE_NORMAL, Config, resolveSettings, entryIdFrom } = await import(`file://${join(PACKAGE, 'index.js')}`);
const { normalizeCapture } = await import(`file://${join(PACKAGE, 'lib', 'capture-plan.mjs')}`);

const workspace = mkdtempSync(join(tmpdir(), 'dsh-through-test-'));
const probeScript = join(workspace, 'probe.ps1');
const samplerScript = join(workspace, 'sample.ps1');
const stubScript = join(workspace, 'stub-capture.ps1');
const stubLog = join(workspace, 'stub-log.txt');
const stubPng = join(workspace, 'stub.png');

/** Run PowerShell and return its output. */
function powershell(args, timeoutMs = 120_000) {
  const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── PowerShell helpers (written at runtime into the temp workspace) ──────────

const PROBE_SOURCE = `# Stand-in window for the through-capture tests: near-fullscreen magenta window.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$native = @'
using System;
using System.Runtime.InteropServices;
public static class ProbeDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
try { Add-Type -TypeDefinition $native -Language CSharp | Out-Null } catch { }
[void][ProbeDpi]::SetProcessDPIAware()
$form = New-Object System.Windows.Forms.Form
$form.Text = '${PROBE_TITLE}'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$form.Bounds = New-Object System.Drawing.Rectangle(20, 20, ($bounds.Width - 60), ($bounds.Height - 60))
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)
$form.TopMost = $true
$form.Show()
[System.Windows.Forms.Application]::Run($form)
`;

const SAMPLER_SOURCE = `param([Parameter(Mandatory=$true)][string]$Path)
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $Path).Path)
try {
  $magenta = 0
  $total = 0
  for ($row = 0; $row -lt 5; $row++) {
    for ($col = 0; $col -lt 8; $col++) {
      $x = [int](($image.Width - 1) * ($col + 0.5) / 8)
      $y = [int](($image.Height - 1) * ($row + 0.5) / 5)
      $pixel = $image.GetPixel($x, $y)
      $total++
      if ($pixel.R -eq 255 -and $pixel.G -eq 0 -and $pixel.B -eq 255) { $magenta++ }
    }
  }
  Write-Host ('SAMPLED ' + $magenta + ' ' + $total)
} finally { $image.Dispose() }
`;

/** Stub capture script: reports whatever the test wants, and records its argv. */
const STUB_SOURCE = `param(
  [ValidateSet('info', 'shot', 'both')][string]$Mode = 'both',
  [switch]$DpiAware,
  [string]$OutDir = $env:TEMP,
  [string]$Tag = 'stub',
  [switch]$Through,
  [int]$HideWaitMs = 250,
  [string]$HideMethod = 'hide',
  [int]$DshPid = 0,
  [string]$DshImage = '',
  [string]$DshTitleHint = 'DSH',
  [switch]$RestoreOnly
)
$log = '${stubLog.replace(/\\/g, '\\\\')}'
$png = '${stubPng.replace(/\\/g, '\\\\')}'
if ($RestoreOnly) {
  Add-Content -LiteralPath $log -Value ('restore-only pid=' + $DshPid)
  $body = '{"ok":true,"through":"pending","restore_ok":true,"hidden_ms":0,"png_path":null,"bitmap_width":0,"bitmap_height":0,"error":null}'
  Write-Host '---JSON-BEGIN---'
  Write-Host $body
  Write-Host '---JSON-END---'
  exit 0
}
Add-Content -LiteralPath $log -Value ('capture through=' + [bool]$Through + ' pid=' + $DshPid)
[System.IO.File]::WriteAllBytes($png, [byte[]](137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82))
$body = '{"ok":true,"through":"failed","through_reason":"stub reports a failed restore","restore_ok":false,"hidden_ms":300,"png_path":"' + ($png -replace '\\\\','\\\\') + '","bitmap_width":3440,"bitmap_height":1440,"png_bytes":16,"elapsed_total_ms":500,"capture_bounds":{"x":0,"y":0,"width":3440,"height":1440},"virtual_screen":{"x":0,"y":0,"width":3440,"height":1440},"single_screen":true,"screen_count":1,"error":null}'
Write-Host '---JSON-BEGIN---'
Write-Host $body
Write-Host '---JSON-END---'
exit 0
`;

// ── helpers ─────────────────────────────────────────────────────────────────

function startProbe() {
  const start = powershell([
    '-Command',
    `Start-Process -FilePath '${POWERSHELL}' -ArgumentList '-Sta','-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${probeScript}' -PassThru | Out-Null`,
  ]);
  if (start.status !== 0) return undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const run = powershell([
      '-Command',
      `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '${PROBE_TITLE}' } | Select-Object -First 1 -ExpandProperty Id`,
    ]);
    const pid = Number(run.stdout.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
    powershell(['-Command', 'Start-Sleep -Milliseconds 250']);
  }
  return undefined;
}

function stopProbe() {
  powershell([
    '-Command',
    `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '${PROBE_TITLE}' } | Stop-Process -Force`,
  ]);
}

/** Capture the screen once through the shipped script and return its PNG path. */
function captureScreen() {
  const outDir = mkdtempSync(join(workspace, 'capture-'));
  const run = powershell(['-File', CAPTURE_SCRIPT, '-Mode', 'shot', '-DpiAware', '-OutDir', outDir, '-Tag', 'probe']);
  const begin = run.stdout.indexOf('---JSON-BEGIN---');
  const end = run.stdout.indexOf('---JSON-END---');
  if (begin === -1 || end === -1) return undefined;
  return JSON.parse(run.stdout.slice(begin + 16, end).trim()).png_path;
}

/** How many of the sampled points of a PNG are stand-in magenta. */
function magentaCount(pngPath) {
  const run = powershell(['-File', samplerScript, '-Path', pngPath]);
  const line = run.stdout.split(/\r?\n/).find((value) => value.startsWith('SAMPLED '));
  if (line === undefined) return { magenta: -1, total: -1 };
  const [, magenta, total] = line.split(' ');
  return { magenta: Number(magenta), total: Number(total) };
}

/**
 * Assert the stand-in window is on screen, retrying a couple of times: the screen
 * is a shared resource (other test files and tools run in parallel), so a single
 * miss must not flake the gate. Failures carry the sampled numbers.
 * @param {string} label - what is being asserted (goes into the failure message).
 */
async function expectStandInVisible(label) {
  let last = { magenta: -1, total: -1 };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const shot = captureScreen();
    last = shot === undefined ? { magenta: -1, total: -1 } : magentaCount(shot);
    if (last.magenta >= last.total * 0.8) {
      assert.ok(true, `${label}: stand-in visible (${last.magenta}/${last.total} sampled points)`);
      return last;
    }
    await sleep(500);
  }
  assert.fail(`${label}: the stand-in window is not visible (sampled magenta ${last.magenta}/${last.total})`);
}

/** Boot the capture route with the given settings; returns the base URL and teardown. */
async function bootRoute(settings) {
  const routes = [];
  const logs = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const ctx = {
    logger: {
      debug() {},
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
    },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    inject: (deps, callback) => callback(ctx, {}),
    effect: (fn) => fn(),
  };
  apply(ctx, settings);
  // The plugin owns three registrations: the exact capture route, the overlay prefix,
  // and the exact capture-mode preference route (t73). Pick them by kind + path instead
  // of by count/position, so adding another route family never silently re-points this
  // test at the wrong handler.
  const captureRoute = routes.find((route) => route.kind === 'exact' && route.path === ROUTE_PATH);
  assert.ok(captureRoute !== undefined, `the capture route ${ROUTE_PATH} must be registered`);
  assert.ok(
    routes.some((route) => route.kind === 'exact' && route.path === STATE_PATH),
    `the capture-mode preference route ${STATE_PATH} must be registered (t73)`,
  );
  assert.deepEqual(
    routes.map((route) => `${route.kind} ${route.path}`).sort(),
    [`exact ${ROUTE_PATH}`, `exact ${STATE_PATH}`, `prefix ${OVERLAY_PREFIX}`],
    'exactly the capture route, the state route and the overlay prefix are registered',
  );
  const server = createServer((req, res) => captureRoute.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    logs,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const metricOf = (response) => JSON.parse(Buffer.from(response.headers.get('x-dsh-screenshot'), 'base64url').toString('utf8'));

// ── fixtures ────────────────────────────────────────────────────────────────

let probePid;
let outDir;

before(async () => {
  writeFileSync(probeScript, PROBE_SOURCE, 'utf8');
  writeFileSync(samplerScript, SAMPLER_SOURCE, 'utf8');
  writeFileSync(stubScript, STUB_SOURCE, 'utf8');
  stopProbe(); // clear leftovers so this run owns exactly one stand-in window
  if (!existsSync(POWERSHELL)) throw new Error(`powershell.exe not found at ${POWERSHELL}`);
  probePid = startProbe();
  if (probePid === undefined) {
    throw new Error('the stand-in window never appeared: these tests need an interactive desktop session');
  }
  outDir = mkdtempSync(join(tmpdir(), 'dsh-through-out-'));
  await sleep(900); // let the window paint and reach the foreground
});

after(() => {
  stopProbe();
  rmSync(workspace, { recursive: true, force: true });
  if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
});

// ── 4. normal mode: no `mode` parameter, behaviour unchanged -----------------

test('normal mode (no mode parameter) reports mode=normal and leaves the window alone (zero regression)', async () => {
  const route = await bootRoute({ outDir, cacheTtlMs: 100, timeoutMs: 30_000 });
  try {
    await expectStandInVisible('before the normal request');
    const response = await fetch(`${route.base}${ROUTE_PATH}?vw=1720&vh=720`, { cache: 'no-store' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const metric = metricOf(response);
    assert.equal(metric.mode, 'normal');
    assert.equal(metric.hiddenMs, 0);
    assert.equal(metric.restoreOk, true);
    // The descriptor must stay consumable by the Client half's validator.
    assert.doesNotThrow(() => normalizeCapture(metric));
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 1000, 'the frame must carry real PNG bytes');
    assert.ok(route.logs.some(([, line]) => line.includes('capture ok (normal)')), 'normal mode logs its own mode');
  } finally {
    await route.close();
  }
});

// ── 1. through mode: hide -> capture -> finally restore ----------------------

test('through mode hides the target window, grabs a frame without it, and the finally restores it', async () => {
  const route = await bootRoute({
    outDir,
    cacheTtlMs: 100,
    timeoutMs: 30_000,
    hideWaitMs: 250,
    dshPid: probePid,
    dshImage: 'powershell',
    dshTitleHint: PROBE_TITLE,
  });
  try {
    const response = await fetch(`${route.base}${ROUTE_PATH}?mode=through`, { cache: 'no-store' });
    assert.equal(response.status, 200);
    const metric = metricOf(response);
    assert.equal(metric.mode, 'through', 'the window was hidden, so the frame is a through frame');
    assert.ok(metric.hiddenMs >= 150, `hiddenMs must be measured, got ${metric.hiddenMs}`);
    assert.equal(metric.restoreOk, true);
    const bytes = Buffer.from(await response.arrayBuffer());
    const throughPng = join(workspace, 'through-frame.png');
    writeFileSync(throughPng, bytes);
    const throughSample = magentaCount(throughPng);
    assert.equal(throughSample.magenta, 0, 'the hidden window must not appear in the through frame');
    // ...and the finally must have brought it back before the response was sent.
    await expectStandInVisible('after the through request (the finally must have restored it)');
    assert.ok(route.logs.some(([, line]) => line.includes('capture ok (through)')));
  } finally {
    await route.close();
  }
});

// ── 2. restore failure: rescue + 502, never an image -------------------------

test('a reported restore failure runs the rescue restore and answers 502 without a frame', async () => {
  rmSync(stubLog, { force: true });
  const route = await bootRoute({
    outDir,
    cacheTtlMs: 100,
    timeoutMs: 30_000,
    scriptPath: stubScript, // injects the failure instead of touching the real script
    dshPid: probePid,
    dshImage: 'powershell',
    dshTitleHint: PROBE_TITLE,
  });
  try {
    const response = await fetch(`${route.base}${ROUTE_PATH}?mode=through`, { cache: 'no-store' });
    assert.equal(response.status, 502, 'a capture whose restore cannot be confirmed is a failure, not a frame');
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'capture.failed');
    assert.match(body.message, /restore/i, 'the message must say the restore could not be confirmed');
    const log = existsSync(stubLog) ? readFileSync(stubLog, 'utf8') : '';
    assert.match(log, /capture through=True/, 'the stub capture must have run');
    assert.match(log, /restore-only pid=/, 'the host must have run the rescue entry point');
    assert.ok(route.logs.some(([level, line]) => level === 'warn' && line.includes('rescue restore')), 'the rescue must be logged');
  } finally {
    await route.close();
  }
});

// ── 3. unconfirmable target: skipped, nothing hidden -------------------------

test('an unconfirmable target is skipped: 200 with mode=normal and the window untouched', async () => {
  const route = await bootRoute({
    outDir,
    cacheTtlMs: 100,
    timeoutMs: 30_000,
    dshPid: 999_999,
    dshImage: 'NoSuchApplication',
    dshTitleHint: 'ZZZ-No-Match',
  });
  try {
    const response = await fetch(`${route.base}${ROUTE_PATH}?mode=through`, { cache: 'no-store' });
    assert.equal(response.status, 200, 'not being able to confirm the target is a fallback, not an error');
    const metric = metricOf(response);
    assert.equal(metric.mode, 'normal');
    assert.equal(metric.hiddenMs, 0);
    assert.equal(metric.restoreOk, true);
    const bytes = Buffer.from(await response.arrayBuffer());
    const fallbackPng = join(workspace, 'fallback-frame.png');
    writeFileSync(fallbackPng, bytes);
    const sample = magentaCount(fallbackPng);
    assert.ok(sample.magenta >= sample.total * 0.8, `nothing may be hidden when the target cannot be confirmed (sampled magenta ${sample.magenta}/${sample.total})`);
    await expectStandInVisible('after the skipped through request (nothing may have been hidden)');
    assert.ok(route.logs.some(([level, line]) => level === 'warn' && line.includes('through capture skipped')));
  } finally {
    await route.close();
  }
});

// ── 5. the rescue entry point itself ----------------------------------------

test('the rescue entry point confirms a live window and fails loudly when nothing can be confirmed', () => {
  const ok = powershell([
    '-File',
    CAPTURE_SCRIPT,
    '-Mode',
    'info',
    '-RestoreOnly',
    '-DshPid',
    String(probePid),
    '-DshImage',
    'powershell',
    '-DshTitleHint',
    PROBE_TITLE,
  ]);
  assert.equal(ok.status, 0, 'restoring an already visible window must succeed');
  assert.match(ok.stdout, /"restore_ok":true/);
  const missing = powershell([
    '-File',
    CAPTURE_SCRIPT,
    '-Mode',
    'info',
    '-RestoreOnly',
    '-DshPid',
    '999999',
    '-DshImage',
    'NoSuchApplication',
    '-DshTitleHint',
    'ZZZ-No-Match',
  ]);
  assert.equal(missing.status, 6, 'the rescue entry point must exit non-zero when it cannot confirm a window');
  assert.match(missing.stdout, /"ok":false/);
});

// ── 6. mode is part of the cache identity -----------------------------------

test('a cached frame never crosses capture modes', async () => {
  const route = await bootRoute({
    outDir,
    cacheTtlMs: 5_000, // long enough that the second request would hit the cache if mode were ignored
    timeoutMs: 30_000,
    hideWaitMs: 150,
    dshPid: probePid,
    dshImage: 'powershell',
    dshTitleHint: PROBE_TITLE,
  });
  try {
    const normal = await fetch(`${route.base}${ROUTE_PATH}`, { cache: 'no-store' });
    assert.equal(metricOf(normal).mode, 'normal');
    const cached = await fetch(`${route.base}${ROUTE_PATH}`, { cache: 'no-store' });
    assert.equal(metricOf(cached).mode, 'normal', 'the normal frame is reused for a normal request');
    const through = await fetch(`${route.base}${ROUTE_PATH}?mode=through`, { cache: 'no-store' });
    assert.equal(metricOf(through).mode, 'through', 'a through request must not be answered from the normal cache');
  } finally {
    await route.close();
  }
});
