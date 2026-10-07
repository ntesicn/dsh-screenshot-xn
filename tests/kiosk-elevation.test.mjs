/**
 * t81: two machine-level faults reported from a second DSH machine, pinned here.
 *
 * Problem 1 - DSH itself running elevated (an AppCompatFlags `~ RUNASADMIN` layer
 * on dsh.exe, or a launch from an elevated shell) makes Chromium's AutoDeElevate
 * exit and let the shell relaunch it unelevated; with a long command line that
 * relay loses the arguments, so the kiosk window never navigates at all. The host
 * then only sees "no heartbeat" and the browser log holds a single line:
 * `Edge is running elevated: 1`. The fix is the upstream workaround flag
 * (chromium issue 436869753), plus diagnostics that name the cause.
 *
 * Problem 2 - GDI+ answers "a generic error occurred in GDI+" for an output
 * directory the current user cannot write to: typically `%TEMP%\dsh-screenshot-xn`
 * left behind by an earlier elevated run, which that user cannot even delete.
 * `capture.ps1` now probes for writability before saving, falls back to a per-user
 * directory, and reports which directory it used.
 *
 * The capture cases run the real script: a directory that cannot be created (its
 * parent is a file) and a path that exists but is a file are both unusable under
 * every privilege level, so these assertions never depend on how the test runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const POWERSHELL = 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const CAPTURE_SCRIPT = join(PACKAGE, 'lib', 'capture.ps1');
const INDEX_SOURCE = readFileSync(join(PACKAGE, 'index.js'), 'utf8');
const CAPTURE_SOURCE = readFileSync(CAPTURE_SCRIPT, 'utf8');
const CAPTURE_BYTES = readFileSync(CAPTURE_SCRIPT);

const { OVERLAY_KIOSK_FLAGS } = await import(`file://${join(PACKAGE, 'index.js')}`);

/** The workaround flag, and the only thing that separates a working kiosk from a silent one. */
const hasDeElevateWorkaround = (flags) => flags.includes('--do-not-de-elevate');

/** The body of `resolveLaunch`: the only place the real kiosk argv is built. */
function kioskLaunchSource(source) {
  const start = source.indexOf('async function resolveLaunch');
  const end = source.indexOf('/** Stop the kiosk window', start);
  if (start === -1 || end === -1) return '';
  return source.slice(start, end);
}

/**
 * Every switch precedes the URL, the URL is last, and no switch is split around it.
 * @param {string} source - index.js text (mutated in the negative sample).
 * @returns {boolean} whether the launch path satisfies the contract.
 */
function argvIsUrlLast(source) {
  const launch = kioskLaunchSource(source);
  if (launch === '') return false;
  if (!/const argv = \[[\s\S]*pageUrl,\s*\n\s*\];/u.test(launch)) return false;
  return !/OVERLAY_KIOSK_FLAGS\.slice\(/u.test(launch);
}

/** The elevation marker pattern, extracted from the source that has to apply it. */
function elevationMarker(source) {
  return source.match(/\/(running elevated:\\s\*1)\/u/u)?.[1];
}

/** The RUNASADMIN compatibility-layer pattern, extracted the same way. */
function compatLayerMarker(source) {
  return source.match(/\/(runasadmin)\/iu/u)?.[1];
}

/** Run the real capture script and return its parsed JSON result. */
function runCapture(outDir) {
  const run = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_SCRIPT, '-Mode', 'shot', '-DpiAware', '-OutDir', outDir, '-Tag', 't81'],
    { encoding: 'utf8', timeout: 120_000, windowsHide: true },
  );
  const begin = run.stdout.indexOf('---JSON-BEGIN---');
  const end = run.stdout.indexOf('---JSON-END---');
  assert.ok(begin !== -1 && end !== -1, `capture.ps1 must emit its JSON block (stdout: ${run.stdout} stderr: ${run.stderr})`);
  return JSON.parse(run.stdout.slice(begin + 16, end).trim());
}

test('(t81-1) the kiosk flags carry the AutoDeElevate workaround', () => {
  assert.equal(
    hasDeElevateWorkaround(OVERLAY_KIOSK_FLAGS.join(' ')),
    true,
    'a kiosk browser started by an elevated DSH exits through AutoDeElevate and can lose its arguments without --do-not-de-elevate',
  );
  // The knowledge is the durable part: the flag must carry its reason next to it.
  assert.match(INDEX_SOURCE, /AutoDeElevate/u, 'the flag is documented as the AutoDeElevate workaround');
  assert.match(INDEX_SOURCE, /436869753/u, 'the upstream chromium issue is named, so the flag can be re-checked later');
  assert.ok(OVERLAY_KIOSK_FLAGS.includes('--no-proxy-server'), 'the t80 proxy bypass stays in place');
});

test('(t81-2) every switch precedes the URL in the real kiosk argv', () => {
  assert.equal(argvIsUrlLast(INDEX_SOURCE), true, `the kiosk argv must keep the URL last: ${kioskLaunchSource(INDEX_SOURCE)}`);
  const launch = kioskLaunchSource(INDEX_SOURCE);
  assert.match(launch, /\.\.\.OVERLAY_KIOSK_FLAGS/u, 'the shared kiosk flags stay in the argv');
  assert.match(launch, /--enable-logging/u, 'the browser log stays enabled: it is what names this class of failure');
  assert.match(launch, /--user-data-dir=\$\{userDataDir\}/u, 'the throwaway profile stays in place');
});

test('(t81-3) an elevated browser is recognized in the kiosk log', () => {
  const pattern = elevationMarker(INDEX_SOURCE);
  assert.ok(pattern !== undefined, 'reportKioskLog must still look for the Chromium elevation marker');
  const marker = new RegExp(pattern, 'u');
  // The exact line the second machine's browser wrote (report, 2026-10-08 02:17).
  const reported = '[14056:29952:1008/021717.472:WARNING:chrome\\browser\\chrome_browser_main_win.cc:1670] Edge is running elevated: 1';
  assert.equal(marker.test(reported), true, 'the reported elevation line must be recognized');
  assert.equal(marker.test(reported.replace('elevated: 1', 'elevated: 0')), false, 'an unelevated browser must not be flagged');

  const layer = compatLayerMarker(INDEX_SOURCE);
  assert.ok(layer !== undefined, 'the startup line must read the RUNASADMIN compatibility layer');
  const layerMarker = new RegExp(layer, 'iu');
  for (const value of ['RUNASADMIN', 'RunAsAdmin']) {
    assert.equal(layerMarker.test(value), true, `${value} is the layer this warning exists for`);
  }
  assert.equal(layerMarker.test('DisableUserCallbackException'), false, 'an unrelated compatibility layer must not trigger the warning');
});

test('(t81-4) an unusable output directory never fails a capture', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-t81-'));
  try {
    // The happy path still reports itself as writable and writes where it says.
    const plain = join(workspace, 'plain');
    const ok = runCapture(plain);
    assert.equal(ok.ok, true, `a writable directory must capture: ${ok.error}`);
    assert.equal(ok.out_dir_writable, true);
    assert.equal(ok.out_dir_fallback, false);
    assert.equal(ok.out_dir.toLowerCase(), plain.toLowerCase());
    assert.equal(statSync(ok.png_path).size, ok.png_bytes, 'the reported PNG is the file on disk');
    rmSync(ok.png_path, { force: true });

    // 1) the requested directory cannot be created, because its parent is a file.
    const blocker = join(workspace, 'blocker.txt');
    writeFileSync(blocker, 'not a directory');
    const requested = join(blocker, 'out');
    const blocked = runCapture(requested);
    assert.equal(blocked.ok, true, `a capture must survive an unusable directory: ${blocked.error}`);
    assert.equal(blocked.out_dir_writable, false);
    assert.equal(blocked.out_dir_fallback, true);
    assert.equal(blocked.out_dir_requested, requested);
    assert.match(blocked.out_dir_reason, /cannot be created/u);
    assert.notEqual(blocked.out_dir.toLowerCase(), requested.toLowerCase());
    assert.ok(blocked.png_bytes > 0, 'the frame is still written, just somewhere else');
    assert.equal(statSync(blocked.png_path).size, blocked.png_bytes);
    rmSync(blocked.png_path, { force: true });

    // 2) the requested path exists but is a file: the write probe itself is the failure.
    const asFile = runCapture(blocker);
    assert.equal(asFile.ok, true, `a capture must survive a path that is not a directory: ${asFile.error}`);
    assert.equal(asFile.out_dir_fallback, true);
    assert.match(asFile.out_dir_reason, /probe file cannot be written/u, 'the reason names the probe, not GDI+');
    assert.ok(asFile.png_bytes > 0);
    rmSync(asFile.png_path, { force: true });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('(t81-5) capture.ps1 documents the directory fields and stays ASCII-only', () => {
  assert.match(CAPTURE_SOURCE, /^#\s+out_dir_requested\s+string/mu);
  assert.match(CAPTURE_SOURCE, /^#\s+out_dir_writable\s+boolean/mu);
  assert.match(CAPTURE_SOURCE, /^#\s+out_dir_reason\s+string/mu);
  assert.match(CAPTURE_SOURCE, /^#\s+out_dir_fallback\s+boolean/mu);
  assert.match(CAPTURE_SOURCE, /function Test-WritableDirectory/u);
  assert.match(CAPTURE_SOURCE, /Get-Acl/u, 'the diagnostic names the owner that made the directory unusable');

  // Windows PowerShell 5.1 mis-parses non-BOM UTF-8 files that carry non-ASCII text,
  // and this file is loaded through -File. A BOM is allowed, other bytes are not.
  const body = CAPTURE_BYTES.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? CAPTURE_BYTES.subarray(3) : CAPTURE_BYTES;
  let offenders = 0;
  for (const byte of body) if (byte > 0x7f) offenders += 1;
  assert.equal(offenders, 0, 'capture.ps1 must stay ASCII-only');
});

test('(t81-6) negative samples: the pinned assertions are load-bearing', () => {
  const withoutFlag = OVERLAY_KIOSK_FLAGS.filter((flag) => flag !== '--do-not-de-elevate').join(' ');
  assert.equal(hasDeElevateWorkaround(withoutFlag), false, 'dropping the flag must break t81-1');

  const switchAfterUrl = INDEX_SOURCE.replace(/pageUrl,\n {4}\];/u, "pageUrl, '--no-proxy-server',\n    ];");
  assert.notEqual(switchAfterUrl, INDEX_SOURCE, 'the negative sample must really change the argv');
  assert.equal(argvIsUrlLast(switchAfterUrl), false, 'a switch after the URL must break t81-2');

  const splitAroundUrl = INDEX_SOURCE.replace('...OVERLAY_KIOSK_FLAGS,', '...OVERLAY_KIOSK_FLAGS.slice(0, 1), pageUrl, ...OVERLAY_KIOSK_FLAGS.slice(1),');
  assert.equal(argvIsUrlLast(splitAroundUrl), false, 'the pre-t80 split argv must break t81-2');

  assert.equal(elevationMarker(INDEX_SOURCE.replace(/running elevated/gu, 'nothing to see here')), undefined, 'losing the marker must break t81-3');
});
