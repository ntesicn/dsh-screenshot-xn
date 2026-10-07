/**
 * dsh-screenshot-xn - Host half.
 *
 * Owns the pixels: it registers one same-origin route on the `webServer`
 * service that answers with a freshly captured PNG plus a machine-readable
 * descriptor of that capture. The Client half owns the overlay, the selection
 * and the annotations, and reads the pixels back from this route as a Blob.
 *
 * Frozen contract (docs/evidence/api-verification.md section 7.2 - implemented
 * verbatim here):
 *
 * - exactly one route: `kind: 'exact'`, `path: '/api/dsh-screenshot/capture'`,
 *   registered through `ctx.inject(['webServer'], ...)` inside `ctx.effect`;
 * - `GET` returns `200`, `Content-Type: image/png`,
 *   `Cache-Control: no-store, max-age=0`, the PNG bytes as the body, and the
 *   capture descriptor as base64url(JSON) in the `X-DSH-Screenshot` header;
 * - any other method returns `405` with `{"ok":false,"error":"method.not_allowed"}`;
 * - a capture that fails or times out returns `502` with
 *   `{"ok":false,"error":"capture.failed","message":"..."}`;
 * - a missing `webServer` service only logs a line: the plugin never throws,
 *   so it can never keep DSH from starting (DoD D-6 / R-05).
 *
 * The descriptor is produced by `normalizeCapture` (`lib/capture-plan.mjs`), the
 * same pure function the Client half calls, so both halves agree field by field.
 * It carries a `url` carrier (this route) because that shape is what the Client
 * half validates; the Client half usually swaps it for the Blob it already has.
 *
 * Operational notes:
 * - capture runs through `lib/capture.ps1` (DPI-aware, ASCII only, Windows
 *   PowerShell 5.1). The host's `subprocess` service is used when the profile
 *   provides it; otherwise `node:child_process` spawns it. Both paths are
 *   bounded by `timeoutMs`, hide the console window, and terminate the child on
 *   timeout, so no process survives a request (DoD D-7).
 * - consecutive fetches share one capture (single flight) and a short TTL
 *   cache whose reference is dropped when it expires (DoD D-9).
 * - logs contain sizes, timings and outcomes only - never image data (DoD D-8).
 *
 * @module dsh-screenshot-xn
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';
import { normalizeCapture, screenPixelRatio } from './lib/capture-plan.mjs';
import {
  DEFAULT_DET_LIMIT,
  disposeOnnxSessions,
  prepareOnnxEngine,
  recognizeWithOnnx,
} from './lib/ocr-onnx.mjs';
import { DEFAULT_MODEL_SOURCE, defaultModelDir, normalizeModelTier } from './lib/ocr-models.mjs';
import {
  DEFAULT_TRANSLATE_TARGET,
  TRANSLATE_TEXT_LIMIT,
  buildOcrArguments,
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  clampTranslateText,
  isEmptyOcrText,
  isUnchangedTranslation,
  normalizeLanguageTag,
  normalizeOcrResult,
  normalizeTranslateTarget,
  normalizeTranslation,
} from './lib/ocr.mjs';

/** Cordis plugin name (also the package name in package.json). */
export const name = 'dsh-screenshot-xn';

/** Route kind registered on `webServer`. */
export const ROUTE_KIND = 'exact';
/** Route path registered on `webServer` (unique, package-prefixed). */
export const ROUTE_PATH = '/api/dsh-screenshot/capture';
/** Capture script shipped with this package, relative to its directory. */
export const CAPTURE_SCRIPT = 'lib/capture.ps1';
/** Default ceiling for one capture (script start + copy + encode). */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Default lifetime of the shared capture; long enough to coalesce a burst. */
export const DEFAULT_CACHE_TTL_MS = 1_500;
/** Response header carrying the capture descriptor as base64url(JSON); the Client half reads the same name. */
export const METRIC_HEADER = 'X-DSH-Screenshot';
/** Query parameter that switches this route into through-capture mode (t44). */
export const MODE_PARAM = 'mode';
/** Value of {@link MODE_PARAM} that hides the DSH window before grabbing pixels. */
export const MODE_THROUGH = 'through';
/** The ordinary mode: nothing is hidden, the frame contains DSH itself. */
export const MODE_NORMAL = 'normal';
/**
 * The plugin's **Config schema** (t73): declarative settings the DSH settings /
 * Plugin-Manager page can edit, persisted into the profile patch.
 *
 * `captureMode` 是 `.volatile()` 字段：DSH 允许**运行中就地更新**这类字段（加载器把新值写进同一个 ref，
 * 见 `loader/volatile-update`），所以用户在设置页改完**不需要重启**；它同时被写进 profile patch，
 * 因此 DSH 重启后仍然是上次选的值。字段值在运行期是**Ref 对象**（读法见 `readVolatile`）。
 * 其余既有配置键不在这里声明 —— schemastery 保留未知键，所以老的 `scriptPath` / `hideWaitMs` 等不受影响。
 */
export const Config = Schema.object({
  captureMode: Schema.union([MODE_THROUGH, MODE_NORMAL]).default(MODE_THROUGH).volatile(),
});
/** Default wait between hiding the window and grabbing pixels. */
export const DEFAULT_HIDE_WAIT_MS = 250;/** Lower bound of the wait band this release was measured in. */
export const MIN_HIDE_WAIT_MS = 150;
/** Upper bound of the wait band this release was measured in. */
export const MAX_HIDE_WAIT_MS = 400;
/** Default title fragment used to recognise the DSH window. */
export const DEFAULT_DSH_TITLE_HINT = 'DSH';
/** Ceiling for the rescue restore, which must never hang the request. */
export const RESCUE_TIMEOUT_MS = 5_000;
/** Cap on the capture script's stdout/stderr kept for diagnostics. */
export const OUTPUT_LIMIT_BYTES = 256 * 1024;
/** Cap on the PNG size this route will read into memory. */
export const PNG_LIMIT_BYTES = 64 * 1024 * 1024;

/** Directory of this package (the capture script lives beside this file). */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const JSON_BEGIN = '---JSON-BEGIN---';
const JSON_END = '---JSON-END---';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden'];

// ── independent full-screen overlay (t56, B1) ───────────────────────────────
/** Prefix owning every overlay route (one prefix registration covers them all). */
export const OVERLAY_PREFIX = '/api/dsh-screenshot/overlay';
/** Overlay page: `overlay/index.html` inside this package. */
export const OVERLAY_PAGE_PATH = `${OVERLAY_PREFIX}/page`;
/** Static overlay assets under `overlay/` (`asset/<name>`). */
export const OVERLAY_ASSET_PREFIX = `${OVERLAY_PREFIX}/asset/`;
/** This package's pure-logic modules, exposed to the page as ES modules. */
export const OVERLAY_LIB_PREFIX = `${OVERLAY_PREFIX}/lib/`;
/** Start a session: hide DSH, capture the frozen frame, launch the kiosk window. */
export const OVERLAY_START_PATH = `${OVERLAY_PREFIX}/start`;
/** The frozen frame of the running session (from cache, never re-captured). */
export const OVERLAY_FRAME_PATH = `${OVERLAY_PREFIX}/frame`;
/** The overlay reports its result (or a cancellation) here. */
export const OVERLAY_RESULT_PATH = `${OVERLAY_PREFIX}/result`;
/** The annotated PNG the overlay submitted. */
export const OVERLAY_RESULT_PNG_PATH = `${OVERLAY_PREFIX}/result.png`;
/** Session state, read by the client that started the overlay. */
export const OVERLAY_STATUS_PATH = `${OVERLAY_PREFIX}/status`;
/** Overlay heartbeat: the page pings this, silence means the overlay is gone. */
export const OVERLAY_PING_PATH = `${OVERLAY_PREFIX}/ping`;
/** Watchdog cadence; the heartbeat window below is what the acceptance pins. */
export const OVERLAY_WATCHDOG_MS = 500;
/** Default heartbeat window: this much silence marks the session aborted. */
export const DEFAULT_OVERLAY_HEARTBEAT_MS = 5_000;
/**
 * Window for the **first** heartbeat of a session (t80).
 *
 * Every session spawns the browser with a brand-new `--user-data-dir`, so the first paint is
 * always a cold start — a slow machine can spend longer than the steady-state heartbeat window
 * before the page runs at all, and the session used to be aborted before it ever had a chance
 * to ping (observed: ten sessions in a row, all `no heartbeat for ~5.1 s`). Silence *after* the
 * first ping still uses {@link DEFAULT_OVERLAY_HEARTBEAT_MS}. The session ceiling still applies.
 */
export const OVERLAY_FIRST_PING_MS = 20_000;
/**
 * Distinct static panel files remembered for the "the kiosk page never pinged" log line (t80).
 *
 * The static family (`/overlay/page`, `/overlay/asset/*`, `/overlay/lib/*.mjs`) is fetched by the
 * kiosk browser alone — the DSH side only polls `/overlay/status` — so a count of zero means the
 * browser never asked this server for the panel at all, which is a different failure from "the
 * page arrived but its script never ran".
 */
export const OVERLAY_STATIC_SEEN_LIMIT = 12;
/** Lines of the kiosk browser's own log copied into the host log when the page never pinged (t80). */
export const OVERLAY_KIOSK_LOG_LINES = 20;
/** File the kiosk browser writes its own diagnostics to, inside the throwaway profile (t80). */
export const OVERLAY_KIOSK_LOG_NAME = 'chrome_debug.log';
/** Default ceiling for one overlay session (a long annotation session fits). */
export const DEFAULT_OVERLAY_TIMEOUT_MS = 120_000;
/** How long a finished session keeps frame/result so the client can fetch them. */
export const DEFAULT_OVERLAY_RETAIN_MS = 30_000;
/** Ceiling for one overlay result payload. */
export const DEFAULT_OVERLAY_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
/** Actions the overlay may report besides `cancel`. */
export const OVERLAY_ACTIONS = Object.freeze(['insert', 'copy', 'save']);
/**
 * Reason returned when DSH Desktop's web server refuses ordinary browser access (t79).
 *
 * The kiosk is an **ordinary** browser request (no `x-dsh-desktop-renderer` header), so
 * with the per-profile `openBrowser` switch off it receives `403 forbidden` instead of
 * the page. Reported as this code so the client can name the switch instead of showing
 * a generic overlay failure.
 */
export const OVERLAY_ACCESS_DENIED_REASON = 'desktop-browser-access-denied';
/** Ceiling for the pre-launch access probe; a slow answer must not stall the start. */
export const OVERLAY_PREFLIGHT_TIMEOUT_MS = 4_000;
// ── OCR + translation (t75) ─────────────────────────────────────────────────
/**
 * OCR script shipped with this package. It runs under **Windows PowerShell 5.1**
 * (`defaultPowerShellPath()` pins that engine), which is also the only PowerShell that
 * still projects the `Windows.Media.Ocr` WinRT types — see the script's own header.
 */
export const OCR_SCRIPT = 'lib/ocr.ps1';
/**
 * Overlay-family route that recognizes the text inside one posted region.
 *
 * It lives **inside the overlay prefix** on purpose: the prefix registration already
 * exists, the page is same-origin with it, and the token check that guards every other
 * overlay data route guards this one too (the posted PNG is the user's screen content).
 */
export const OVERLAY_OCR_PATH = `${OVERLAY_PREFIX}/ocr`;
/** Overlay-family route that translates text through the model DSH is already configured with. */
export const OVERLAY_TRANSLATE_PATH = `${OVERLAY_PREFIX}/translate`;
/**
 * Overlay-family route that puts recognized/translated text on the system clipboard.
 *
 * The page must not touch the OS itself (README "动作由 DSH 侧执行", pinned by
 * `tests/overlay-page.test.mjs` t57-4), so 「复制」 on the recognition card is executed
 * here, next to the screen capture and the OCR engine — not in the kiosk page.
 */
export const OVERLAY_CLIPBOARD_PATH = `${OVERLAY_PREFIX}/clipboard`;
/** Clipboard script shipped with this package. */
export const CLIPBOARD_SCRIPT = 'lib/clipboard.ps1';
/** Default ceiling for one recognition (script start + decode + recognize). */
export const DEFAULT_OCR_TIMEOUT_MS = 20_000;
/** Default ceiling for one translation model call. */
export const DEFAULT_TRANSLATE_TIMEOUT_MS = 45_000;
/** Request-body ceiling for one OCR call (a region PNG as a data URL). */
export const OCR_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
/** Request-body ceiling for one translation call (text only). */
export const TRANSLATE_BODY_LIMIT_BYTES = 256 * 1024;
/** Output ceiling for one translation: a screenful of text never needs more. */
export const TRANSLATE_MAX_TOKENS = 4_000;
/**
 * Temp-file name tag for the auxiliary payloads this host stages for a script: the region
 * PNG the OCR script reads, and the text file the clipboard script reads. Prefixed with the
 * package tag so `keepTempFile: true` leaves recognizable files behind.
 */
export const OCR_TEMP_PREFIX = 'dsh-screenshot-xn-ocr-';
/** The host helper script that resolves browsers, stops and probes kiosk windows. */
export const OVERLAY_HOST_SCRIPT = 'lib/overlay-host.ps1';
/**
 * Route for the **capture-mode preference** (t73): `GET` returns the effective mode,
 * `POST` changes it. 右键菜单选完模式后客户端调它，宿主把选择写进**插件配置**
 * （`ctx.settings`，也就是设置页/插件管理里那份），因此重启后不用重选。
 */
export const STATE_PATH = '/api/dsh-screenshot/state';
/** Request-body ceiling for the preference route (a patch is a few bytes). */
export const STATE_BODY_LIMIT_BYTES = 4 * 1024;
/** Entry id used for the settings write when the fiber does not expose one. */
export const DEFAULT_ENTRY_ID = 'dsh-screenshot-xn';
/** Browser executables tried in order (Edge first: the t49 spike measured it). */
export const DEFAULT_OVERLAY_BROWSER_PATHS = Object.freeze([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]);
/** Kiosk flags shared by Edge and Chrome (t49 spike measured this set). */
export const OVERLAY_KIOSK_FLAGS = Object.freeze([
  '--kiosk',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--no-service-autorun',
  '--disable-features=msEdgeFirstRunExperience,msImplicitSignin',
  // t80：面板永远是回环地址（`http://127.0.0.1:<DSH 端口>/…`），页面也不再从任何远端取资源。
  // 机器上装了系统代理时（WinINET `ProxyEnable=1`），代理会替 127.0.0.1 作答，面板就变成
  // 白屏或错误页 —— 宿主这边只表现为"没有心跳"，看不出真实原因。
  '--no-proxy-server',
]);

/** Failure carrying a short machine-readable detail code for the log line. */
class CaptureError extends Error {
  /**
   * @param {string} detailCode - short code, e.g. `capture.timeout`.
   * @param {string} message - human-readable detail (never image data).
   */
  constructor(detailCode, message) {
    super(message);
    this.name = 'CaptureError';
    this.detailCode = detailCode;
  }
}

/**
 * Unwrap a **volatile** config field (t73). The loader hands `.volatile()` fields to the
 * plugin as a Ref whose `get()` always returns the current value — including after the
 * user changes it in the settings page while the plugin is running. A plain value is
 * returned as-is, so the same reader works for non-volatile rows.
 * @param {unknown} value - the raw config field.
 * @returns {unknown} the current value.
 */
export function readVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value).get) === 'function') {
    try {
      return /** @type {any} */ (value).get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Normalize a capture mode: anything that is not exactly {@link MODE_NORMAL} reads as
 * {@link MODE_THROUGH}, so a hand-edited or legacy value can never break a capture.
 * @param {unknown} value - candidate mode.
 * @returns {string} {@link MODE_THROUGH} or {@link MODE_NORMAL}.
 */
export function normalizeCaptureMode(value) {
  return readVolatile(value) === MODE_NORMAL ? MODE_NORMAL : MODE_THROUGH;
}

/**
 * Normalize the row's `config` into the settings this plugin uses. Every field
 * is optional; unknown fields are ignored so a future option cannot break an
 * older install.
 * @param {unknown} config - the row config from `cordis.patch.yml`.
 * @returns {{ enabled: boolean, scriptPath: string, outDir: string, tag: string, timeoutMs: number, cacheTtlMs: number, keepTempFile: boolean, powershellPath: string, hideWaitMs: number, hideWaitClamped: boolean, hideMethod: 'hide'|'minimize', dshImage: string, dshTitleHint: string, dshPid: number, captureMode: string, ocrEnabled: boolean, ocrScriptPath: string, ocrLanguage: string, ocrTimeoutMs: number, translateEnabled: boolean, translateProvider: string, translateModel: string, translateTarget: string, translateTimeoutMs: number, translateMaxTokens: number, translatePrompt: string }}
 */
export function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config) : {};
  const script = text(raw.scriptPath) ?? CAPTURE_SCRIPT;
  const requestedWait = positiveNumber(raw.hideWaitMs) ?? DEFAULT_HIDE_WAIT_MS;
  // The wait is clamped to the band this release was measured in: longer waits
  // only delay the user, shorter ones risk catching the window mid-fade.
  const hideWaitMs = Math.min(MAX_HIDE_WAIT_MS, Math.max(MIN_HIDE_WAIT_MS, Math.round(requestedWait)));
  const hideMethod = raw.hideMethod === 'minimize' ? 'minimize' : 'hide';
  return {
    enabled: raw.enabled !== false,
    scriptPath: isAbsolute(script) ? script : join(PACKAGE_DIR, script),
    outDir: text(raw.outDir) ?? join(tmpdir(), 'dsh-screenshot-xn'),
    tag: text(raw.tag) ?? 'dsh-screenshot-xn',
    timeoutMs: positiveNumber(raw.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    cacheTtlMs: positiveNumber(raw.cacheTtlMs) ?? DEFAULT_CACHE_TTL_MS,
    keepTempFile: raw.keepTempFile === true,
    powershellPath: text(raw.powershellPath) ?? defaultPowerShellPath(),
    hideWaitMs,
    hideWaitClamped: Math.round(requestedWait) !== hideWaitMs,
    hideMethod,
    dshImage: text(raw.dshImage) ?? defaultDshImage(),
    dshTitleHint: text(raw.dshTitleHint) ?? DEFAULT_DSH_TITLE_HINT,
    dshPid: Number.isInteger(raw.dshPid) && raw.dshPid > 0 ? raw.dshPid : defaultDshPid(),
    // 右键菜单/设置页选的截图模式（t73，volatile 字段 → 运行期是 Ref）。
    captureMode: normalizeCaptureMode(readVolatile(raw.captureMode)),
    // ── overlay (B1) ──
    overlayDir: text(raw.overlayDir) ?? join(PACKAGE_DIR, 'overlay'),
    overlayHostScript: (() => {
      const value = text(raw.overlayHostScript) ?? OVERLAY_HOST_SCRIPT;
      return isAbsolute(value) ? value : join(PACKAGE_DIR, value);
    })(),
    overlayBrowserPaths: readBrowserPaths(raw.overlayBrowserPaths),
    overlayLaunch: readLaunchSpec(raw.overlayLaunch),
    overlayHeartbeatMs: clampNumber(raw.overlayHeartbeatMs, 1_000, DEFAULT_OVERLAY_HEARTBEAT_MS, DEFAULT_OVERLAY_HEARTBEAT_MS),
    overlayTimeoutMs: clampNumber(raw.overlayTimeoutMs, 5_000, 15 * 60_000, DEFAULT_OVERLAY_TIMEOUT_MS),
    overlayRetainMs: clampNumber(raw.overlayRetainMs, 0, 10 * 60_000, DEFAULT_OVERLAY_RETAIN_MS),
    overlayBodyLimitBytes: clampNumber(raw.overlayBodyLimitBytes, 1024, 256 * 1024 * 1024, DEFAULT_OVERLAY_BODY_LIMIT_BYTES),
    // ── OCR + translation (t75) ──
    // 两者各自可关：OCR 依赖本机装了 Windows OCR 语言包，翻译会真的调用用户的模型（花 token），
    // 所以"关掉其中一个"必须是配置里就能做到的事，而不是让用户去删功能。
    ocrEnabled: raw.ocrEnabled !== false,
    ocrScriptPath: (() => {
      const value = text(raw.ocrScriptPath) ?? OCR_SCRIPT;
      return isAbsolute(value) ? value : join(PACKAGE_DIR, value);
    })(),
    // 空串 = 自动（Windows 用户配置的语言包顺序）；脏值一律回落自动，绝不带着怪标签去起脚本。
    ocrLanguage: normalizeLanguageTag(raw.ocrLanguage),
    ocrTimeoutMs: positiveNumber(raw.ocrTimeoutMs) ?? DEFAULT_OCR_TIMEOUT_MS,
    // ── ONNX OCR 引擎（t77，接法 A）──
    // `auto`：本机模型齐备（或允许下载）就用 PP-OCR，否则回落到 Windows 自带引擎 —— 两个引擎
    // 的**返回结构一致**，面板与翻译链路不需要知道用的是哪个。
    ocrEngine: normalizeOcrEngine(raw.ocrEngine),
    ocrModelTier: normalizeModelTier(readVolatile(raw.ocrModelTier)),
    ocrModelDir: (() => {
      const value = text(raw.ocrModelDir);
      return value === undefined ? defaultModelDir() : (isAbsolute(value) ? value : join(PACKAGE_DIR, value));
    })(),
    ocrModelSource: text(raw.ocrModelSource) ?? DEFAULT_MODEL_SOURCE,
    // 默认允许首次使用时下载模型（否则"更强但离线"这件事对用户就是不可达）。关掉即永不联网。
    ocrDownloadModels: raw.ocrDownloadModels !== false,
    ocrDetLimit: clampNumber(raw.ocrDetLimit, 320, 4_096, DEFAULT_DET_LIMIT),
    translateEnabled: raw.translateEnabled !== false,
    // 空串 = 用 DSH 自己的默认模型（`agentDefaultModel.currentSelection()`），所以默认零配置。
    translateProvider: text(raw.translateProvider) ?? '',
    translateModel: text(raw.translateModel) ?? '',
    translateTarget: normalizeTranslateTarget(readVolatile(raw.translateTarget) ?? DEFAULT_TRANSLATE_TARGET),
    translateTimeoutMs: positiveNumber(raw.translateTimeoutMs) ?? DEFAULT_TRANSLATE_TIMEOUT_MS,
    translateMaxTokens: positiveInteger(raw.translateMaxTokens) ?? TRANSLATE_MAX_TOKENS,
    translatePrompt: text(raw.translatePrompt) ?? '',
  };
}

/**
 * Normalize the OCR engine choice (t77): `auto` (ONNX when usable, else the Windows
 * engine), `onnx` (require the ONNX engine), or `windows` (always the built-in one).
 * @param {unknown} value - candidate from the row config.
 * @returns {'auto'|'onnx'|'windows'}
 */
export function normalizeOcrEngine(value) {
  if (value === 'onnx' || value === 'windows') return value;
  return 'auto';
}

/**
 * Browser executables to try, in order. An explicit empty list means "pretend no
 * browser is installed", which is how the offline harness exercises the
 * `no-browser` fallback without touching the real machine.
 * @param {unknown} input - the config value.
 * @returns {string[]} the candidate paths.
 */
function readBrowserPaths(input) {
  if (Array.isArray(input)) {
    return input.map((value) => text(value)).filter((value) => value !== undefined);
  }
  if (typeof input === 'string') {
    return input.split(';').map((value) => text(value)).filter((value) => value !== undefined);
  }
  return [...DEFAULT_OVERLAY_BROWSER_PATHS];
}

/**
 * The offline test seam: a command template that replaces the real browser launch
 * (`${url}` / `${token}` are substituted). It comes from the row config or the
 * `DSH_SCREENSHOT_OVERLAY_LAUNCH` environment variable (JSON array or a plain
 * space-separated command).
 * @param {unknown} input - the config value.
 * @returns {string[]|undefined} argv template, or undefined for the real browser.
 */
function readLaunchSpec(input) {
  const fromConfig = toArgv(input);
  if (fromConfig !== undefined) return fromConfig;
  const fromEnv = text(process.env.DSH_SCREENSHOT_OVERLAY_LAUNCH);
  if (fromEnv === undefined) return undefined;
  if (fromEnv.startsWith('[')) {
    try {
      return toArgv(JSON.parse(fromEnv));
    } catch {
      return undefined;
    }
  }
  return fromEnv.split(/\s+/).filter((value) => value !== '');
}

/**
 * @param {unknown} input - a string or string array.
 * @returns {string[]|undefined} a non-empty argv array.
 */
function toArgv(input) {
  if (Array.isArray(input)) {
    const argv = input.map((value) => text(value)).filter((value) => value !== undefined);
    return argv.length > 0 ? argv : undefined;
  }
  const single = text(input);
  return single === undefined ? undefined : [single];
}

/**
 * @param {unknown} input - candidate number.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - value when the input is unusable.
 * @returns {number} the clamped value.
 */
function clampNumber(input, min, max, fallback) {
  const value = positiveNumber(input) ?? fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Host plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {unknown} [config] - the row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  let settings;
  try {
    settings = resolveSettings(config);
  } catch (error) {
    log(ctx, 'warn', `config rejected, capture disabled: ${message(error)}`);
    return;
  }
  /**
   * 右键菜单与设置页共享的"当前截图模式"（t73）。`captureMode` 是 volatile 字段：
   * 用户在设置页改完，加载器会**就地**更新运行期那份 ref 并派发 `loader/volatile-update`，
   * 这里重新解析一次即可拿到新值 —— 所以不需要重启。
   */
  const modeBridge = {
    settings: () => settings,
    entryId: entryIdFrom(ctx),
    effect: (mode) => {
      settings.captureMode = normalizeCaptureMode(mode);
      // 运行期拿到的是 volatile ref：按 cosmokit 的写协议同步一次，
      // 免得加载器下一次比较时还以为是旧值。
      writeVolatile(liveCaptureModeRef(config), settings.captureMode);
    },
  };
  if (typeof ctx?.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      Object.assign(settings, resolveSettings(config));
      log(ctx, 'info', `settings updated live: captureMode=${settings.captureMode}`);
    });
  }
  if (!settings.enabled) {
    log(ctx, 'info', 'disabled by config; no route registered');
    return;
  }
  if (settings.hideWaitClamped) {
    log(ctx, 'warn', `hideWaitMs is clamped to ${settings.hideWaitMs} ms (measured band ${MIN_HIDE_WAIT_MS}-${MAX_HIDE_WAIT_MS} ms)`);
  }
  log(ctx, 'info', `through capture target: image "${settings.dshImage}", pid ${settings.dshPid}, hide=${settings.hideMethod}, wait=${settings.hideWaitMs} ms`);
  if (process.platform !== 'win32') {
    log(ctx, 'warn', `screen capture needs Windows; not registering the route on ${process.platform}`);
    return;
  }
  if (typeof ctx?.inject !== 'function') {
    log(ctx, 'warn', 'context has no inject(); not registering the capture route');
    return;
  }
  try {
    // `inject` only hard-wires the route owner: a profile without `webServer`
    // simply never runs this callback, and the plugin still loads (D-6).
    if (typeof ctx.get === 'function' && ctx.get('webServer') === undefined) {
      log(ctx, 'info', 'webServer is not active yet; the capture route registers when the service appears');
    }
    ctx.inject(['webServer'], (webCtx) => {
      try {
        registerRoute(webCtx, settings, undefined, modeBridge);
      } catch (error) {
        log(webCtx, 'warn', `capture route registration failed: ${message(error)}`);
      }
    });
  } catch (error) {
    log(ctx, 'warn', `could not await the webServer service: ${message(error)}`);
  }
}

/**
 * Register the capture route and the overlay route family, and tie their lifetime
 * to the injected context (plugin unload also tears the kiosk window down).
 * @param {any} ctx - context that carries `webServer`.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {any} [service] - the webServer service, when already known.
 * @param {{ effect: (mode: string) => void, settings: () => any, entryId: string }} [modeBridge] - capture-mode preference bridge (t73).
 * @returns {void}
 */
function registerRoute(ctx, settings, service = undefined, modeBridge = undefined) {
  const webServer = service ?? ctx?.webServer ?? (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined);
  if (webServer === undefined || typeof webServer.register !== 'function') {
    log(ctx, 'warn', 'webServer.register is unavailable; capture stays off');
    return;
  }
  const capture = createCaptureService(ctx, settings);
  const overlay = createOverlayHost(ctx, settings, webServer, capture, modeBridge);
  // t75：识别与翻译走**同一族路由**（都在 overlay 前缀下），所以它们与 overlay 会话共用一个
  // 服务实例：token 校验、请求体上限、失败体形状都复用同一条路径，不需要第二套网关。
  const text = createTextService(ctx, settings);
  ctx.effect(() => {
    const disposers = [];
    try {
      disposers.push(
        webServer.register({
          kind: ROUTE_KIND,
          path: ROUTE_PATH,
          handler: (req, res) => handleCapture(req, res, ctx, capture),
        }),
      );
      // One prefix registration covers page/asset/lib/frame/result/status/ping.
      disposers.push(
        webServer.register({
          kind: 'prefix',
          path: OVERLAY_PREFIX,
          handler: (req, res) => handleOverlay(req, res, ctx, overlay, text),
        }),
      );
      // 截图模式的持久化偏好（t73）：右键菜单写、设置页读同一份配置。
      const bridge = modeBridge ?? {
        settings: () => settings,
        entryId: entryIdFrom(ctx),
        effect: (mode) => {
          settings.captureMode = normalizeCaptureMode(mode);
        },
      };
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: STATE_PATH,
          handler: (req, res) => handleState(req, res, ctx, bridge),
        }),
      );
    } catch (error) {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {
          /* nothing to unwind */
        }
      }
      log(ctx, 'warn', `webServer rejected the capture/overlay routes: ${message(error)}`);
      return () => {};
    }
    log(ctx, 'info', `routes ready: ${ROUTE_KIND} ${ROUTE_PATH} + prefix ${OVERLAY_PREFIX} + ${STATE_PATH}`);
    reportOverlayAssets(ctx, overlay);
    return async () => {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {
          /* already gone */
        }
      }
      try {
        await overlay.dispose();
      } catch (error) {
        log(ctx, 'warn', `overlay teardown failed: ${message(error)}`);
      } finally {
        capture.dispose();
      }
    };
  }, 'dsh-screenshot-xn: capture + overlay routes');
}

/**
 * Request handler: owns the full response lifecycle and never throws, so a
 * failure stays a diagnosable HTTP answer instead of a server-level error.
 * @param {any} req - Node `IncomingMessage`.
 * @param {any} res - Node `ServerResponse`.
 * @param {any} ctx - logging context.
 * @param {{ acquire: (request: { fresh: boolean, viewportCss?: { x: number, y: number, width: number, height: number } }) => Promise<{ bytes: Buffer, info: Record<string, unknown> }> }} capture - the shared capture service.
 * @returns {Promise<void>} resolves once the response is settled.
 */
async function handleCapture(req, res, ctx, capture) {
  try {
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method.not_allowed' }, { Allow: 'GET' });
      return;
    }
    const url = new URL(typeof req?.url === 'string' && req.url !== '' ? req.url : ROUTE_PATH, 'http://127.0.0.1');
    const shot = await capture.acquire({
      fresh: url.searchParams.get('fresh') === '1',
      viewportCss: readViewport(url),
      mode: readMode(url),
    });
    if (res.headersSent === true) {
      res.destroy?.();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(shot.bytes.length),
      'Cache-Control': 'no-store, max-age=0',
      [METRIC_HEADER]: Buffer.from(JSON.stringify(shot.info), 'utf8').toString('base64url'),
    });
    res.end(shot.bytes);
  } catch (error) {
    report(ctx, res, error);
  }
}

/**
 * Answer with the frozen failure body. `headersSent` means the response already
 * started (a broken client): the socket is destroyed rather than half-written.
 * @param {any} ctx - logging context.
 * @param {any} res - Node `ServerResponse`.
 * @param {unknown} error - the failure.
 * @returns {void}
 */
function report(ctx, res, error) {
  const detail = error instanceof CaptureError ? `${error.detailCode}: ${error.message}` : message(error);
  log(ctx, 'warn', `capture failed: ${detail}`);
  if (res.headersSent === true) {
    res.destroy?.();
    return;
  }
  sendJson(res, 502, { ok: false, error: 'capture.failed', message: clip(detail, 240) });
}

/**
 * Request handler for the capture-mode preference route (t73).
 *
 * `GET` reports the **effective** mode (the volatile config field). `POST {captureMode}`
 * changes it: the running settings object is updated first (so the next shot already uses
 * it), then the choice is persisted through `ctx.settings` — the same store the DSH
 * settings / Plugin-Manager page edits — so it survives a restart. When that service is
 * unavailable the reply says `persisted:false` and the change stays session-local.
 * @param {any} req - Node `IncomingMessage`.
 * @param {any} res - Node `ServerResponse`.
 * @param {any} ctx - logging context.
 * @param {{ effect: (mode: string) => void, settings: () => any, entryId: string }} state - the live preference bridge.
 * @returns {Promise<void>} resolves once the response is settled.
 */
async function handleState(req, res, ctx, state) {
  try {
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, captureMode: normalizeCaptureMode(state.settings().captureMode) });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method.not_allowed' }, { Allow: 'GET, POST' });
      return;
    }
    const body = await readRequestBody(req, STATE_BODY_LIMIT_BYTES);
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8') === '' ? '{}' : body.toString('utf8'));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'state.bad-body', message: clip(message(error), 240) });
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, error: 'state.bad-body', message: 'body must be a JSON object' });
      return;
    }
    const requested = /** @type {any} */ (parsed).captureMode;
    if (requested !== MODE_THROUGH && requested !== MODE_NORMAL) {
      sendJson(res, 400, {
        ok: false,
        error: 'state.invalid-mode',
        message: `captureMode must be "${MODE_THROUGH}" or "${MODE_NORMAL}"`,
      });
      return;
    }
    // 先让运行中的实例立刻用上新模式，再尽力写回配置（写失败不影响本次生效）。
    state.effect(requested);
    const service = serviceFrom(ctx, 'settings');
    if (service === undefined || typeof service.update !== 'function') {
      log(ctx, 'warn', `capture mode ${requested} is session-local: ctx.settings is unavailable`);
      sendJson(res, 200, { ok: true, captureMode: requested, persisted: false, reason: 'settings.unavailable' });
      return;
    }
    try {
      await service.update(state.entryId, { captureMode: requested });
      log(ctx, 'info', `capture mode persisted: ${requested} (entry ${state.entryId})`);
      sendJson(res, 200, { ok: true, captureMode: requested, persisted: true });
    } catch (error) {
      log(ctx, 'warn', `could not persist capture mode ${requested}: ${message(error)}`);
      sendJson(res, 200, { ok: true, captureMode: requested, persisted: false, reason: clip(message(error), 160) });
    }
  } catch (error) {
    log(ctx, 'warn', `state route failed: ${message(error)}`);
    sendJson(res, 400, { ok: false, error: 'state.failed', message: clip(message(error), 240) });
  }
}

/**
 * The profile entry id this plugin instance was mounted under (t73). `ctx.settings` keys
 * its writes by that id, so it must be exact; the bundle's row id is the fallback.
 * @param {any} ctx - plugin context.
 * @returns {string} entry id.
 */
export function entryIdFrom(ctx) {
  const id = ctx?.fiber?.entry?.options?.id;
  return typeof id === 'string' && id !== '' ? id : DEFAULT_ENTRY_ID;
}

/**
 * The shared volatile-write protocol (`Symbol.for('cosmokit.volatile.write')`), the same
 * key `cosmokit`'s `isVolatile`/`updateVolatile` use. Read/written by symbol so this plugin
 * needs no dependency on cosmokit itself.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * The live volatile ref for `captureMode`, when the loader delivered one (t73).
 * Writing through it keeps the loader's own comparison in sync with the value we
 * already applied, so the next settings edit is not mistaken for "no change".
 * @param {unknown} config - the row config passed to `apply`.
 * @returns {any} the ref, or undefined for a plain (non-volatile) config.
 */
export function liveCaptureModeRef(config) {
  const value = config !== null && typeof config === 'object' ? /** @type {any} */ (config).captureMode : undefined;
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value;
  return undefined;
}

/**
 * Write a value back into a live volatile ref (t73), tolerating a read-only one.
 * @param {any} ref - the ref from {@link liveCaptureModeRef}.
 * @param {unknown} value - the value to store.
 * @returns {boolean} whether the write landed.
 */
export function writeVolatile(ref, value) {
  if (ref === undefined || typeof ref !== 'object') return false;
  const writer = ref[VOLATILE_WRITE];
  if (typeof writer !== 'function') return false;
  try {
    writer.call(ref, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Look a service up without throwing when the context does not provide it.
 * @param {any} ctx - context.
 * @param {string} name - service name.
 * @returns {any} the service, or undefined.
 */
function serviceFrom(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name);
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * Remember the capture mode a session was started with (t73).
 *
 * Best effort by design: the client persists the menu choice itself, so this only covers an
 * older client or a lost request. It writes to the **same** plugin config the DSH settings /
 * Plugin-Manager page edits, which is what makes the choice survive a restart.
 * @param {any} ctx - logging context.
 * @param {{ effect: (mode: string) => void, entryId: string, settings: () => any }|undefined} bridge - the mode bridge.
 * @param {string} mode - the mode this session started with.
 * @returns {void}
 */
function rememberMode(ctx, bridge, mode) {
  if (bridge === undefined) return;
  const wanted = normalizeCaptureMode(mode);
  if (normalizeCaptureMode(bridge.settings().captureMode) === wanted) return;
  bridge.effect(wanted);
  const service = serviceFrom(ctx, 'settings');
  if (service === undefined || typeof service.update !== 'function') {
    log(ctx, 'warn', `capture mode ${wanted} is session-local: ctx.settings is unavailable`);
    return;
  }
  Promise.resolve(service.update(bridge.entryId, { captureMode: wanted }))
    .then(() => log(ctx, 'info', `capture mode persisted from start: ${wanted}`))
    .catch((error) => log(ctx, 'warn', `could not persist capture mode ${wanted}: ${message(error)}`));
}

/**
 * Write a JSON response, tolerating a socket that is already gone.
 * @param {any} res - Node `ServerResponse`.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable body.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {void}
 */
function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(payload.length),
      'Cache-Control': 'no-store, max-age=0',
      ...headers,
    });
    res.end(payload);
  } catch (error) {
    log(undefined, 'warn', `could not write the failure response: ${message(error)}`);
    try {
      res.destroy?.();
    } catch {
      /* the socket is already unusable */
    }
  }
}

/**
 * Build the single-flight + short-TTL capture service (DoD D-9). The PNG buffer
 * is released as soon as the TTL expires and on plugin unload, so a session that
 * never opens the overlay again holds nothing.
 *
 * The request mode is part of the request identity: a cached frame is only
 * reused for the same mode (a normal frame must never answer a through request),
 * and a capture of the other mode is queued behind the one in flight instead of
 * running concurrently - two PowerShell processes hiding/showing the same window
 * at once would fight each other.
 * @param {any} ctx - logging context.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {{ acquire: (request: { fresh: boolean, viewportCss?: { x: number, y: number, width: number, height: number }, mode?: string }) => Promise<{ bytes: Buffer, info: Record<string, unknown> }>, dispose: () => void }}
 */
function createCaptureService(ctx, settings) {
  /** @type {{ bytes: Buffer, info: Record<string, unknown>, mode: string, expiresAt: number }|null} */
  let cached = null;
  /** @type {Promise<{ bytes: Buffer, info: Record<string, unknown> }>|null} */
  let inflight = null;
  /** @type {string|null} */
  let inflightMode = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let releaseTimer = null;

  const releaseLater = () => {
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      cached = null;
    }, settings.cacheTtlMs + 5);
    releaseTimer.unref?.();
  };

  return {
    async acquire(request) {
      const mode = request.mode === MODE_THROUGH ? MODE_THROUGH : MODE_NORMAL;
      const now = Date.now();
      if (!request.fresh && cached !== null && cached.mode === mode && cached.expiresAt > now) {
        log(ctx, 'debug', `capture cache hit (${mode})`);
        return cached;
      }
      if (inflight !== null && inflightMode === mode) {
        log(ctx, 'debug', `joined the ${mode} capture already in flight`);
        return inflight;
      }
      const previous = inflight;
      if (previous !== null) {
        log(ctx, 'debug', `${mode} capture queued behind the in-flight ${String(inflightMode)} capture`);
      }
      const startedAt = Date.now();
      const run = (previous ?? Promise.resolve())
        .catch(() => undefined) // the previous failure belongs to its own caller
        .then(() => captureOnce(ctx, settings, request.viewportCss ?? undefined, mode))
        .then((shot) => {
          cached = { ...shot, mode, expiresAt: Date.now() + settings.cacheTtlMs };
          releaseLater();
          const info = /** @type {Record<string, number>} */ (shot.info);
          log(ctx, 'info', `capture ok (${mode}): ${info.widthPx}x${info.heightPx} px, ${shot.bytes.length} bytes, ${Date.now() - startedAt} ms`);
          return shot;
        });
      inflight = run;
      inflightMode = mode;
      run
        .finally(() => {
          if (inflight === run) {
            inflight = null;
            inflightMode = null;
          }
        })
        .catch(() => undefined); // the caller owns the rejection of `run`
      return run;
    },
    dispose() {
      if (releaseTimer !== null) clearTimeout(releaseTimer);
      releaseTimer = null;
      cached = null;
      inflight = null;
      inflightMode = null;
    },
  };
}

/* ──────────────────────── OCR + translation (t75) ─────────────────────────── */

/**
 * Failure of the OCR / translation side channel, carrying the **public error code**
 * the overlay page maps to a sentence and the HTTP status to answer with.
 *
 * Deliberately not a {@link CaptureError}: that class is wired to the frozen
 * `capture.failed` 502 body, and a failed recognition must not be told apart from a
 * failed screen capture only by its message.
 */
class AuxError extends Error {
  /**
   * @param {string} code - public code, e.g. `ocr.timeout`.
   * @param {string} message - human-readable detail (never image data).
   * @param {number} [status] - HTTP status for this failure.
   */
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'AuxError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Recognize the text inside one posted region PNG, and translate text through the
 * model DSH is already configured with.
 *
 * Both halves are **request-scoped and non-resident**: a recognition writes exactly one
 * temp PNG (removed in a `finally`, whatever happens), and a translation holds no state
 * beyond one awaited model call. Neither one is allowed to keep the request alive
 * forever — each is bounded by its own configurable ceiling.
 *
 * Failure codes are part of the page contract (see `lib/ocr.mjs` OCR_ERROR_KEYS):
 * `ocr.disabled` / `ocr.unavailable` / `ocr.timeout` / `ocr.failed` / `ocr.bad-body`
 * and the matching `translate.*` set.
 *
 * @param {any} ctx - context used for logging and for `ctx.get('llm')` / `('subprocess')`.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {{ recognize: (png: Buffer, language?: string) => Promise<any>, translate: (text: string, target?: string) => Promise<any>, languages: () => Promise<string[]> }} the service.
 */
function createTextService(ctx, settings) {
  /**
   * ONNX 引擎的就绪缓存（t77）：模型校验/下载一次即可，之后每次识别直接推理。
   * `null` = 还没检查过；字符串 = 上次不可用的原因（避免每次都重试下载）。
   */
  let onnxState = null;
  /**
   * 确保 ONNX 引擎可用（必要时下载模型）。
   * @returns {Promise<{available: boolean, reason?: string}>}
   */
  async function ensureOnnx() {
    if (onnxState !== null) return onnxState;
    const prepared = await prepareOnnxEngine({
      modelDir: settings.ocrModelDir,
      tier: settings.ocrModelTier,
      download: settings.ocrDownloadModels,
      source: settings.ocrModelSource,
      log: (line) => log(ctx, 'info', `ocr models: ${line}`),
    });
    if (prepared.available) {
      log(ctx, 'info', `ocr engine ready: ppocr-v6-${settings.ocrModelTier} (${settings.ocrModelDir})`);
      onnxState = { available: true };
      return onnxState;
    }
    // 失败也记下来（同一个进程内不反复重试网络），但留一条可见日志说明为什么回落。
    log(ctx, 'warn', `ocr engine unavailable, using the Windows engine: ${prepared.reason}`);
    onnxState = { available: false, reason: prepared.reason };
    return onnxState;
  }

  /**
   * Run the OCR script against a temp copy of the posted PNG.
   * @param {Buffer} png - the region PNG.
   * @param {string|undefined} language - requested BCP-47 tag (already normalized).
   * @returns {Promise<any>} the normalized recognition.
   */
  async function recognize(png, language = undefined) {
    if (!settings.ocrEnabled) {
      throw new AuxError('ocr.disabled', 'OCR is turned off (ocrEnabled: false)', 503);
    }
    if (typeof png !== 'string' && (png === undefined || png === null || png.length === 0)) {
      throw new AuxError('ocr.bad-body', 'the request carried no image', 400);
    }
    // ── t77：先试 ONNX（PP-OCRv6）引擎 ───────────────────────────────────────
    // 顺序是刻意的：它比 Windows 自带引擎准得多（实机对比见 README）。不可用/失败时，
    // `auto` 静默回落到 Windows 引擎，`onnx` 则如实报错 —— 不猜、不假装成功。
    if (settings.ocrEngine !== 'windows') {
      const ready = await ensureOnnx();
      const onnx = ready.available
        ? await recognizeWithOnnx({
          png,
          modelDir: settings.ocrModelDir,
          tier: settings.ocrModelTier,
          detLimit: settings.ocrDetLimit,
        })
        : { ok: false, reason: ready.reason ?? 'the ONNX engine is not available' };
      if (onnx.ok === true) {
        const lines = Array.isArray(onnx.lines) ? onnx.lines : [];
        log(
          ctx,
          'info',
          `ocr: ${png.length} bytes in, ${lines.length} lines / ${onnx.text.length} chars out, engine ${onnx.engine} (${onnx.boxes} boxes), ${onnx.elapsedMs} ms`,
        );
        return {
          text: onnx.text,
          lines,
          language: onnx.engine,
          elapsedMs: onnx.elapsedMs,
          empty: isEmptyOcrText(onnx.text),
        };
      }
      if (settings.ocrEngine === 'onnx') {
        throw new AuxError('ocr.unavailable', `the ONNX engine is not usable: ${onnx.reason}`, 503);
      }
      log(ctx, 'info', `ocr: falling back to the Windows engine (${onnx.reason})`);
    }
    if (!existsSync(settings.ocrScriptPath)) {
      throw new AuxError('ocr.unavailable', `${settings.ocrScriptPath} does not exist`, 503);
    }
    const requested = normalizeLanguageTag(language) || settings.ocrLanguage;
    const imagePath = join(settings.outDir, `${OCR_TEMP_PREFIX}${randomBytes(8).toString('hex')}.png`);
    const startedAt = Date.now();
    try {
      await mkdir(settings.outDir, { recursive: true });
      await writeFile(imagePath, png);
    } catch (error) {
      throw new AuxError('ocr.failed', `the region could not be staged for OCR: ${message(error)}`);
    }
    try {
      const argv = [...POWERSHELL_ARGS, ...buildOcrArguments({ scriptPath: settings.ocrScriptPath, imagePath, language: requested })];
      let parsed;
      try {
        parsed = await runScript(ctx, settings, argv, settings.ocrTimeoutMs, OCR_SCRIPT_CODES);
      } catch (error) {
        if (error instanceof CaptureError && error.detailCode === OCR_SCRIPT_CODES.timeout) {
          throw new AuxError('ocr.timeout', error.message, 504);
        }
        throw new AuxError('ocr.failed', error instanceof CaptureError ? `${error.detailCode}: ${error.message}` : message(error));
      }
      const result = normalizeOcrResult(parsed);
      const elapsedMs = Date.now() - startedAt;
      log(
        ctx,
        'info',
        `ocr: ${png.length} bytes in, ${result.lines.length} lines / ${result.text.length} chars out, engine ${result.language || 'unknown'}, ${elapsedMs} ms${result.elapsedMs === 0 ? '' : ` (script ${result.elapsedMs} ms)`}`,
      );
      return { ...result, elapsedMs, empty: isEmptyOcrText(result.text) };
    } finally {
      // The temp file never outlives the request unless the operator asked for it
      // (keepTempFile is the same switch the capture path honours).
      if (!settings.keepTempFile) {
        try {
          unlinkSync(imagePath);
        } catch (error) {
          log(ctx, 'debug', `ocr temp file left behind: ${message(error)}`);
        }
      }
    }
  }

  /**
   * The model route one translation runs on: an explicit `translateProvider` +
   * `translateModel` pair wins, otherwise the DSH default model this session already
   * uses. Zero configuration is the normal case — the user configured a model once and
   * the screenshot tool reuses it.
   * @returns {{ provider: string, model: string }} the route.
   */
  function resolveRoute() {
    const fallback = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    const selection = fallback !== undefined && typeof fallback.currentSelection === 'function' ? fallback.currentSelection() : undefined;
    const provider = settings.translateProvider !== '' ? settings.translateProvider : text(selection?.provider);
    const model = settings.translateModel !== '' ? settings.translateModel : text(selection?.model);
    if (provider === undefined || model === undefined) {
      throw new AuxError(
        'translate.unavailable',
        'no model to translate with: DSH reports no default model, and translateProvider/translateModel are unset',
        503,
      );
    }
    return { provider, model };
  }

  /**
   * Translate one block of recognized text.
   * @param {string} source - the text to translate.
   * @param {string|undefined} target - target language id.
   * @returns {Promise<any>} `{ text, source, target, provider, model, unchanged, truncated, elapsedMs }`.
   */
  async function translate(source, target = undefined) {
    if (!settings.translateEnabled) {
      throw new AuxError('translate.disabled', 'translation is turned off (translateEnabled: false)', 503);
    }
    const raw = typeof source === 'string' ? source : '';
    if (raw.trim() === '') {
      throw new AuxError('translate.bad-body', 'the request carried no text to translate', 400);
    }
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new AuxError('translate.unavailable', 'the llm service is not mounted in this profile', 503);
    }
    const { provider, model } = resolveRoute();
    const wanted = normalizeTranslateTarget(target ?? settings.translateTarget);
    const clamped = clampTranslateText(raw, TRANSLATE_TEXT_LIMIT);
    const startedAt = Date.now();
    const system = settings.translatePrompt === ''
      ? buildTranslateSystemPrompt({ target: wanted })
      : `${buildTranslateSystemPrompt({ target: wanted })}\n${settings.translatePrompt}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.translateTimeoutMs);
    timer.unref?.();
    let out = '';
    /** @type {any} */
    let failure = null;
    try {
      const options = {
        provider,
        model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildTranslateUserPrompt({ text: clamped.text }) }] }],
        maxTokens: settings.translateMaxTokens,
        signal: controller.signal,
      };
      for await (const chunk of llm.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text;
          continue;
        }
        if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          failure = chunk.reason.failure ?? { code: chunk.reason.kind, message: String(chunk.reason.kind) };
        }
      }
    } catch (error) {
      // The adapter reports dispatch failures as a terminal chunk when it can and as a
      // throw when it cannot; the deadline surfaces either way, so both are classified here.
      if (controller.signal.aborted) {
        throw new AuxError('translate.timeout', `no translation within ${settings.translateTimeoutMs} ms`, 504);
      }
      throw new AuxError('translate.failed', message(error));
    } finally {
      clearTimeout(timer);
    }
    if (controller.signal.aborted) {
      throw new AuxError('translate.timeout', `no translation within ${settings.translateTimeoutMs} ms`, 504);
    }
    if (failure !== null) {
      throw new AuxError('translate.failed', `model ${provider}/${model} failed: ${failure.message ?? failure.code ?? 'unknown'}`);
    }
    const translation = normalizeTranslation(out);
    if (translation === '') {
      throw new AuxError('translate.failed', `model ${provider}/${model} returned no text`);
    }
    const elapsedMs = Date.now() - startedAt;
    log(ctx, 'info', `translate: ${clamped.text.length} chars -> ${translation.length} chars via ${provider}/${model} (${wanted}), ${elapsedMs} ms`);
    return {
      text: translation,
      source: clamped.text,
      target: wanted,
      provider,
      model,
      truncated: clamped.truncated,
      unchanged: isUnchangedTranslation(clamped.text, translation),
      elapsedMs,
    };
  }

  /**
   * Put one piece of text on the system clipboard.
   *
   * The text travels through a UTF-8 temp file rather than an argument: it can be a whole
   * screenful of CJK with quotes and newlines, and a Windows command line is the wrong
   * place to carry that. The file is removed in a `finally`.
   * @param {string} value - the text to copy.
   * @returns {Promise<{ chars: number, elapsedMs: number }>} what was written.
   */
  async function copy(value) {
    const source = typeof value === 'string' ? value : '';
    if (source === '') {
      throw new AuxError('clipboard.bad-body', 'the request carried no text to copy', 400);
    }
    const scriptPath = join(PACKAGE_DIR, CLIPBOARD_SCRIPT);
    if (!existsSync(scriptPath)) {
      throw new AuxError('clipboard.unavailable', `${scriptPath} does not exist`, 503);
    }
    const textPath = join(settings.outDir, `${OCR_TEMP_PREFIX}clip-${randomBytes(8).toString('hex')}.txt`);
    try {
      await mkdir(settings.outDir, { recursive: true });
      // No BOM: the script reads explicit UTF-8, and a BOM would become the first character.
      await writeFile(textPath, source, 'utf8');
    } catch (error) {
      throw new AuxError('clipboard.failed', `the text could not be staged: ${message(error)}`);
    }
    const startedAt = Date.now();
    try {
      const argv = [...POWERSHELL_ARGS, '-File', scriptPath, '-Path', textPath];
      let parsed;
      try {
        // 复用识别那一档超时：写剪贴板本身就是几十毫秒的事（实测 27–32 ms），
        // 不值得再多一个配置项；沿用同一个上限意味着"脚本卡住"的处理方式只有一种。
        parsed = await runScript(ctx, settings, argv, settings.ocrTimeoutMs, CLIPBOARD_SCRIPT_CODES);
      } catch (error) {
        if (error instanceof CaptureError && error.detailCode === CLIPBOARD_SCRIPT_CODES.timeout) {
          throw new AuxError('clipboard.timeout', error.message, 504);
        }
        throw new AuxError('clipboard.failed', error instanceof CaptureError ? `${error.detailCode}: ${error.message}` : message(error));
      }
      const chars = positiveInteger(parsed.chars) ?? source.length;
      const elapsedMs = Date.now() - startedAt;
      log(ctx, 'info', `clipboard: wrote ${chars} chars (${elapsedMs} ms, script ${String(parsed.elapsed_ms ?? '?')} ms)`);
      return { chars, elapsedMs };
    } finally {
      if (!settings.keepTempFile) {
        try {
          unlinkSync(textPath);
        } catch (error) {
          log(ctx, 'debug', `clipboard temp file left behind: ${message(error)}`);
        }
      }
    }
  }

  return { recognize, translate, copy };
}

/** Detail codes one clipboard script run may fail with. */
const CLIPBOARD_SCRIPT_CODES = Object.freeze({
  timeout: 'clipboard.timeout',
  output: 'clipboard.unusable-output',
  failed: 'clipboard.failed',
  exit: 'clipboard.exit',
});

/** Detail codes one OCR script run may fail with (they reach {@link AuxError} above). */
const OCR_SCRIPT_CODES = Object.freeze({
  timeout: 'ocr.timeout',
  output: 'ocr.unusable-output',
  failed: 'ocr.failed',
  exit: 'ocr.exit',
});

/**
 * Request handler for `POST /overlay/ocr`: the region PNG in, the recognized text out.
 *
 * Body (JSON): `{ png: '<data URL | base64>', language?: 'zh-Hans-CN' }` — the same
 * `png`/`base64`/`dataUrl` shapes the result route already accepts, so the page sends
 * the region exactly like it sends an annotated result.
 * @param {any} req - Node `IncomingMessage`.
 * @param {any} res - Node `ServerResponse`.
 * @param {any} ctx - logging context.
 * @param {any} text - the OCR + translation service.
 * @returns {Promise<void>} resolves once the response is settled.
 */
async function handleOcrRequest(req, res, ctx, text) {
  try {
    if (text === undefined) {
      sendJson(res, 503, { ok: false, error: 'ocr.unavailable', message: 'the OCR route is not wired in this host' });
      return;
    }
    if (methodOf(req) !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method.not_allowed' }, { Allow: 'POST' });
      return;
    }
    const body = await readRequestBody(req, OCR_BODY_LIMIT_BYTES);
    const parsed = parseJsonBody(body);
    if (parsed === undefined) {
      sendJson(res, 400, { ok: false, error: 'ocr.bad-body', message: 'the body is not a JSON object' });
      return;
    }
    const png = extractResultPng(parsed);
    if (png === undefined) {
      sendJson(res, 400, { ok: false, error: 'ocr.bad-body', message: 'no png/base64/dataUrl field carried an image' });
      return;
    }
    const result = await text.recognize(png, typeof parsed.language === 'string' ? parsed.language : undefined);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    reportAux(ctx, res, error, 'ocr.failed');
  }
}

/**
 * Request handler for `POST /overlay/translate`: recognized text in, translation out.
 *
 * Body (JSON): `{ text: '...', target?: 'zh-Hans' }`.
 * @param {any} req - Node `IncomingMessage`.
 * @param {any} res - Node `ServerResponse`.
 * @param {any} ctx - logging context.
 * @param {any} text - the OCR + translation service.
 * @returns {Promise<void>} resolves once the response is settled.
 */
async function handleTranslateRequest(req, res, ctx, text) {
  try {
    if (text === undefined) {
      sendJson(res, 503, { ok: false, error: 'translate.unavailable', message: 'the translation route is not wired in this host' });
      return;
    }
    if (methodOf(req) !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method.not_allowed' }, { Allow: 'POST' });
      return;
    }
    const body = await readRequestBody(req, TRANSLATE_BODY_LIMIT_BYTES);
    const parsed = parseJsonBody(body);
    if (parsed === undefined) {
      sendJson(res, 400, { ok: false, error: 'translate.bad-body', message: 'the body is not a JSON object' });
      return;
    }
    const result = await text.translate(
      typeof parsed.text === 'string' ? parsed.text : '',
      typeof parsed.target === 'string' ? parsed.target : undefined,
    );
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    reportAux(ctx, res, error, 'translate.failed');
  }
}

/**
 * Request handler for `POST /overlay/clipboard`: put text on the system clipboard.
 *
 * Body (JSON): `{ text: '...' }`. The page asks for this instead of calling
 * `navigator.clipboard`, because the page's contract is that it never touches the OS.
 * @param {any} req - Node `IncomingMessage`.
 * @param {any} res - Node `ServerResponse`.
 * @param {any} ctx - logging context.
 * @param {any} text - the OCR + translation service.
 * @returns {Promise<void>} resolves once the response is settled.
 */
async function handleClipboardRequest(req, res, ctx, text) {
  try {
    if (text === undefined) {
      sendJson(res, 503, { ok: false, error: 'clipboard.unavailable', message: 'the clipboard route is not wired in this host' });
      return;
    }
    if (methodOf(req) !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method.not_allowed' }, { Allow: 'POST' });
      return;
    }
    const body = await readRequestBody(req, TRANSLATE_BODY_LIMIT_BYTES);
    const parsed = parseJsonBody(body);
    if (parsed === undefined) {
      sendJson(res, 400, { ok: false, error: 'clipboard.bad-body', message: 'the body is not a JSON object' });
      return;
    }
    const result = await text.copy(typeof parsed.text === 'string' ? parsed.text : '');
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    reportAux(ctx, res, error, 'clipboard.failed');
  }
}

/**
 * Answer with the frozen auxiliary failure body. A live response that already started
 * is destroyed rather than half-written (same rule as the capture route).
 * @param {any} ctx - logging context.
 * @param {any} res - Node `ServerResponse`.
 * @param {unknown} error - the failure.
 * @param {string} fallbackCode - code used when the failure is not an {@link AuxError}.
 * @returns {void}
 */
function reportAux(ctx, res, error, fallbackCode) {
  const code = error instanceof AuxError ? error.code : fallbackCode;
  const status = error instanceof AuxError ? error.status : 502;
  const detail = clip(message(error), 400);
  log(ctx, 'warn', `${code}: ${detail}`);
  if (res.headersSent === true) {
    res.destroy?.();
    return;
  }
  sendJson(res, status, { ok: false, error: code, message: detail });
}

/**
 * Parse a request body as a JSON object.
 * @param {Buffer} body - the raw body.
 * @returns {Record<string, unknown>|undefined} the object, or undefined when it is not one.
 */
function parseJsonBody(body) {
  if (body === undefined || body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Normalized HTTP method of one request. @param {any} req @returns {string} */
function methodOf(req) {
  return typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
}

/* ─────────────────────────── independent overlay (t56, B1) ────────────────── */
/**
 * Own the independent full-screen overlay session.
 *
 * One session = one frozen frame + one kiosk browser window + one token:
 *  - `start()` resolves the launch command first (so a machine without Edge/Chrome
 *    answers `no-browser` *without* hiding DSH), captures the frame through the
 *    already-shipped through path (hide -> grab -> finally restore), then launches
 *    the browser on the plugin's own overlay page. The frame is cached, so the
 *    page (or a refresh) never triggers a second capture.
 *  - the page pings `…/overlay/ping`; silence longer than the heartbeat window, a
 *    dead kiosk process or the session ceiling ends the session - and every end
 *    path stops the kiosk window and drops the payload after a short retention.
 *  - the launch command can be replaced by a stand-in (`overlayLaunch` config /
 *    `DSH_SCREENSHOT_OVERLAY_LAUNCH`), which is how the state machine is tested
 *    without starting a real browser.
 *  - nothing here is resident: a session exists only between start and its end.
 * @param {any} ctx - logging context.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {any} webServer - the webServer service (for the loopback origin).
 * @param {any} capture - the shared capture service.
 * @returns {any} the overlay host API.
 */
function createOverlayHost(ctx, settings, webServer, capture, modeBridge = undefined) {
  /** @type {any} */
  let session = null;
  /** @type {Promise<any>|null} */
  let startPromise = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let watchdog = null;
  let disposed = false;

  function stopWatchdog() {
    if (watchdog !== null) clearInterval(watchdog);
    watchdog = null;
  }

  /** Loopback origin of this plugin's own routes (the page is same-origin). */
  function overlayUrl(token, path, mode = MODE_THROUGH) {
    const port = typeof webServer?.port === 'number' ? webServer.port : undefined;
    const host = typeof webServer?.host === 'string' && webServer.host !== '' && webServer.host !== '0.0.0.0'
      ? webServer.host
      : '127.0.0.1';
    const origin = port === undefined ? 'http://127.0.0.1' : `http://${host}:${port}`;
    // `mode` 也带给页面：普通模式下画面里就是有 DSH 窗口，页面要能把这件事写出来
    // （t67 右键菜单复活后，"含不含 DSH"是用户的选择，不能再让他猜）。
    // `target`（t75）是**默认目标语言**：面板上的下拉框是"这一次翻成什么"，初值取配置里那个，
    // 用户改了就只影响本次会话 —— 插件配置仍然是唯一的持久化入口。
    // `ocr=1`（t75）是**宿主能力戳**：面板文件是宿主 webServer 从磁盘**现读**的，而宿主模块只在
    // DSH 启动时加载一次 —— 于是"新面板 + 旧宿主"是这套架构里真实存在的组合（改完插件没重启
    // DSH 就是这样）。没有这个戳，页面就知道宿主的这三条路由不存在，按钮该置灰并说明原因，
    // 而不是让用户点了之后收到一个 404、再被通用文案说成"识别失败"。
    return `${origin}${path}?token=${encodeURIComponent(token)}&mode=${mode === MODE_NORMAL ? MODE_NORMAL : MODE_THROUGH}`
      + `&target=${encodeURIComponent(settings.translateTarget)}`
      + '&ocr=1';
  }

  /**
   * 启动前的可达性预检：宿主自己以**普通 HTTP 客户端**的身份取一次面板页。
   *
   * 实机缺陷（t79）：DSH Desktop 的 webServer 有一道"普通浏览器访问"闸门
   * （`desktop-browser-access`）：当它判定请求不是渲染器时，`rejectBrowserRequest`
   * 直接回 **403 + 纯文本 `forbidden`**。闸门按 profile 生效（`dsh-desktop` 的
   * `openBrowser`，且只在 `mode: compatibility` 下有意义）。开着闸门时：
   *
   * - kiosk 打开的是那 9 个字节的 `forbidden` 文本，不是面板页；
   * - 页面一行脚本都没跑 → 没有心跳 → 5 s 后 `overlay aborted: no heartbeat`。
   *
   * 用户看到的就是"整屏灰白 + 左上角 forbidden"，而 DSH 里只是一句笼统的失败提示。
   * 预检把这件事变成明确的 reason，客户端就能说明白该去开哪个开关。
   *
   * 预检结论直接外推给 kiosk：两者都是**没有渲染器头的普通请求**，命中同一条判定。
   * 探针失败（网络层异常）不算拒绝 —— 那时照常去试，别把可用的路径拦掉。
   *
   * @param {string} pageUrl - 本次会话的面板页 URL。
   * @returns {Promise<string|undefined>} 被拒绝时返回 `desktop-browser-access-denied`。
   */
  async function preflightOverlayAccess(pageUrl) {
    if (typeof fetch !== 'function') return undefined;
    let response;
    try {
      response = await fetch(pageUrl, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(OVERLAY_PREFLIGHT_TIMEOUT_MS),
      });
    } catch (error) {
      log(ctx, 'warn', `overlay preflight could not reach the page: ${message(error)}`);
      return undefined;
    }
    if (response.status !== 403) return undefined;
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    // 只有 DSH Desktop 那道闸门的 403 才算数：正文恰好是 `forbidden`（见
    // `lib/webserver.js` 的 `rejectBrowserRequest`）。别的 403（例如未来的鉴权）
    // 不该被说成"浏览器访问被关掉了"。
    if (body.trim() !== 'forbidden') return undefined;
    return OVERLAY_ACCESS_DENIED_REASON;
  }

  /** First available browser executable, or undefined when none is installed. */
  async function resolveBrowser() {
    const configured = settings.overlayBrowserPaths;
    for (const candidate of configured) {
      if (existsSync(candidate)) return candidate;
    }
    const isDefault = configured.length === DEFAULT_OVERLAY_BROWSER_PATHS.length
      && configured.every((value, index) => value === DEFAULT_OVERLAY_BROWSER_PATHS[index]);
    // A custom list (including an empty one) is the caller's decision: do not
    // overrule it with a PATH lookup. The default list falls back to the helper,
    // which also probes PATH for msedge.exe / chrome.exe.
    if (!isDefault) return undefined;
    try {
      const parsed = await runOverlayHost(ctx, settings, ['-Action', 'browsers'], 10_000);
      const list = Array.isArray(parsed?.browsers) ? parsed.browsers : [];
      for (const entry of list) {
        if (typeof entry?.path === 'string' && existsSync(entry.path)) return entry.path;
      }
    } catch (error) {
      log(ctx, 'warn', `overlay browser lookup failed: ${message(error)}`);
    }
    return undefined;
  }

  /** The launch argv (stand-in seam or real kiosk browser), or undefined for `no-browser`. */
  async function resolveLaunch(token, pageUrl) {
    if (settings.overlayLaunch !== undefined) {
      const argv = settings.overlayLaunch.map((part) => part.split('${url}').join(pageUrl).split('${token}').join(token));
      return { argv, description: `stand-in (${basename(argv[0] ?? 'command')})`, userDataDir: undefined };
    }
    const executable = await resolveBrowser();
    if (executable === undefined) return undefined;
    const userDataDir = join(tmpdir(), `dsh-screenshot-xn-overlay-${token}`);
    const debugLogPath = join(userDataDir, OVERLAY_KIOSK_LOG_NAME);
    try {
      // t80：先把 profile 目录建好，`--log-file` 才有地方落笔（Chromium 自己建目录更晚）。
      mkdirSync(userDataDir, { recursive: true });
    } catch (error) {
      log(ctx, 'debug', `overlay browser profile not pre-created: ${message(error)}`);
    }
    const argv = [
      executable,
      ...OVERLAY_KIOSK_FLAGS,
      // t80：让浏览器把自己的话说出来。页面一次心跳都没有时，只有这份日志能分开
      // "浏览器根本没打开这个 URL"（代理 / 策略 / 没解析）和"页面脚本没跑起来"。
      '--enable-logging',
      `--log-file=${debugLogPath}`,
      `--user-data-dir=${userDataDir}`,
      // t80：URL 永远是**最后一个**参数。开关散在 URL 两侧时，哪些开关真的生效取决于
      // 浏览器的解析顺序（仓库自己的浏览器探针也一律把 URL 放在最后）。这次要修的恰好
      // 是"开关没生效"，不能让修理手段本身再踩在这个不确定性上。
      pageUrl,
    ];
    return { argv, description: basename(executable), userDataDir, debugLogPath };
  }

  /** Stop the kiosk window: ask it to close first, kill only if it refuses. */
  async function stopKiosk(target) {
    if (target === null || target === undefined || target.stopping === true) return;
    target.stopping = true;
    const pid = target.pid;
    if (typeof pid === 'number' && pid > 0) {
      try {
        const parsed = await runOverlayHost(
          ctx,
          settings,
          ['-Action', 'stop', '-TargetPid', String(pid), '-WaitMs', '1500'],
          20_000,
        );
        log(ctx, 'info', `overlay kiosk pid ${pid}: stopped=${String(parsed?.stopped)} killed=${String(parsed?.killed)} in ${String(parsed?.elapsed_ms)} ms`);
      } catch (error) {
        log(ctx, 'warn', `overlay kiosk stop failed: ${message(error)}`);
      }
    }
    try {
      target.child?.kill?.();
    } catch {
      /* already gone */
    }
    if (typeof target.userDataDir === 'string' && target.userDataDir !== '') {
      try {
        rmSync(target.userDataDir, { recursive: true, force: true });
      } catch (error) {
        log(ctx, 'debug', `overlay browser profile left behind: ${message(error)}`);
      }
    }
  }

  /** Let the response flush before the kiosk disappears. */
  function scheduleKioskStop(target) {
    const timer = setTimeout(() => {
      void stopKiosk(target);
    }, 150);
    timer.unref?.();
  }

  /** Free the payload once the retention window elapsed. */
  function scheduleRelease(target) {
    const timer = setTimeout(() => {
      if (session === target && Date.now() >= target.retainUntil) {
        session = null;
        log(ctx, 'debug', 'overlay session released');
      }
    }, Math.max(0, settings.overlayRetainMs) + 200);
    timer.unref?.();
  }

  /** Move the running session to a terminal state and start the teardown. */
  function finish(state, reason) {
    if (session === null || session.state !== 'running') return;
    session.state = state;
    session.finishedAt = Date.now();
    session.retainUntil = session.finishedAt + settings.overlayRetainMs;
    stopWatchdog();
    log(ctx, 'info', `overlay ${state}: ${reason}${session.action === null ? '' : ` (action ${session.action})`}`);
    scheduleKioskStop(session);
    scheduleRelease(session);
  }

  /** Page URL with the session token masked, for log lines. */
  function maskOverlayToken(url) {
    return typeof url === 'string' ? url.replace(/token=[^&]*/u, 'token=****') : String(url);
  }

  /**
   * Copy the kiosk browser's own log into the host log when the page never pinged (t80).
   *
   * This is the only record of what the browser made of the URL: a system proxy answering for
   * `127.0.0.1`, an unusable `--user-data-dir`, or a navigation that never happened all show up
   * here and nowhere else. An unreadable file is itself the answer (the browser never started),
   * and nothing here may change the session outcome.
   * @param {any} target - the session being aborted.
   * @returns {void}
   */
  function reportKioskLog(target) {
    const file = target.debugLogPath;
    if (typeof file !== 'string' || file === '') return;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      log(ctx, 'warn', `overlay kiosk left no browser log at ${file}: the browser may never have started`);
      return;
    }
    const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      log(ctx, 'warn', `overlay kiosk browser log is empty (${file})`);
      return;
    }
    const tail = lines.slice(-OVERLAY_KIOSK_LOG_LINES);
    log(ctx, 'warn', `overlay kiosk browser log: last ${String(tail.length)} of ${String(lines.length)} lines from ${file}`);
    for (const line of tail) log(ctx, 'warn', `  kiosk> ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
  }

  /** One watchdog beat: heartbeat silence, session ceiling, dead kiosk process. */
  function tick() {
    if (session === null || session.state !== 'running') return;
    const now = Date.now();
    const silence = now - session.lastPingAt;
    // t80：首次心跳给冷启动留出更长的窗口；页面一旦发过心跳，就回到常规心跳窗口。
    const window = session.pings === 0 ? OVERLAY_FIRST_PING_MS : settings.overlayHeartbeatMs;
    if (silence > window) {
      if (session.pings === 0) {
        // 面板文件被取走的次数是这里唯一能分开两类故障的证据：0 次说明浏览器根本没打开
        // 这个 URL（代理 / 策略 / 浏览器自身），取过页面却仍无心跳说明脚本没跑起来。
        const fetched = session.staticSeen.length === 0 ? 'none' : session.staticSeen.join(', ');
        reportKioskLog(session);
        finish('aborted', `no heartbeat for ${silence} ms: the kiosk page never pinged (${maskOverlayToken(session.pageUrl)}); panel files fetched: ${String(session.staticHits)} (${fetched})`);
        return;
      }
      finish('aborted', `no heartbeat for ${silence} ms`);
      return;
    }
    if (now - session.startedAt > settings.overlayTimeoutMs) {
      finish('timeout', `session exceeded ${settings.overlayTimeoutMs} ms`);
      return;
    }
    if (typeof session.pid === 'number') {
      // Only a process we have actually seen alive may be judged dead: a kiosk
      // launcher that hands the window to a child process exits immediately, and
      // treating that first exit as "the overlay is gone" aborted live sessions.
      // A page that really is gone still trips the heartbeat window above.
      if (processAlive(session.pid)) session.sawAlive = true;
      else if (session.sawAlive === true) finish('aborted', 'the kiosk process exited before reporting a result');
    }
  }

  function startWatchdog() {
    stopWatchdog();
    watchdog = setInterval(() => {
      try {
        tick();
      } catch (error) {
        log(ctx, 'warn', `overlay watchdog failed: ${message(error)}`);
      }
    }, OVERLAY_WATCHDOG_MS);
    watchdog.unref?.();
  }

  function sessionFor(token) {
    if (session === null || typeof token !== 'string' || token === '') return undefined;
    return token === session.token ? session : undefined;
  }

  /**
   * Start one session, single-flight: concurrent callers share the first attempt
   * (a second overlay must never start a second capture or a second kiosk).
   * @returns {Promise<any>} the start response.
   */
  async function start(mode = MODE_THROUGH) {
    const wanted = mode === MODE_NORMAL ? MODE_NORMAL : MODE_THROUGH;
    if (disposed) return { ok: false, reason: 'disposed' };
    if (session !== null && session.state === 'running') {
      log(ctx, 'info', `overlay start reused the running session (requested ${wanted}, running ${String(session.mode)})`);
      return { ok: true, token: session.token, startMs: session.startedAt, reused: true, mode: session.mode, requestedMode: wanted };
    }
    if (startPromise !== null) {
      const first = await startPromise;
      log(ctx, 'info', 'overlay start joined the start already in flight');
      return { ...first, reused: true };
    }
    startPromise = startOnce(wanted);
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function startOnce(mode) {
    if (session !== null) {
      // A finished session keeps its payload for the client, but never blocks a
      // new overlay: the slot is handed over (its kiosk stop is idempotent).
      scheduleKioskStop(session);
      session = null;
    }
    const token = randomBytes(16).toString('hex');
    const pageUrl = overlayUrl(token, OVERLAY_PAGE_PATH, mode);
    const launch = await resolveLaunch(token, pageUrl);
    if (launch === undefined) {
      log(ctx, 'warn', 'overlay start: no browser available, the client must fall back to the in-DSH overlay');
      return { ok: false, reason: 'no-browser' };
    }
    // t79：先问清楚宿主会不会把这一页交给普通浏览器 —— 拒绝时立刻收手，不做无用的抓屏，
    // 也不开那个只会显示 `forbidden` 的 kiosk 窗口。
    const denied = await preflightOverlayAccess(pageUrl);
    if (denied !== undefined) {
      log(ctx, 'warn', `overlay start: the web server refuses ordinary browser access (403 forbidden) at ${pageUrl}; enable browser access for this profile`);
      return { ok: false, reason: denied };
    }
    const captureStartedAt = Date.now();
    // t67：模式由调用方（DSH 侧的右键菜单）决定 —— `through` 先隐藏 DSH 再抓（默认，画面不含 DSH），
    // `normal` 不隐藏（画面里就是有 DSH 窗口，用来截 DSH 自己的界面）。
    const shot = await captureOnce(ctx, settings, undefined, mode);
    // t73：用哪个模式截图就把它记成"上次的选择"（写进插件配置，跨重启保留）。
    // 客户端选菜单时已经 POST 过一次；这里再兜一次，免得那次请求丢了就回到默认值。
    rememberMode(ctx, modeBridge, mode);
    const capturedMs = Date.now() - captureStartedAt;
    let child;
    try {
      child = spawn(launch.argv[0], launch.argv.slice(1), { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      throw new CaptureError('overlay.launch-failed', message(error));
    }
    session = {
      token,
      startedAt: Date.now(),
      state: 'running',
      action: null,
      mode,
      frame: shot.bytes,
      info: shot.info,
      pid: child.pid,
      child,
      lastPingAt: Date.now(),
      pings: 0,
      // t80：浏览器到底有没有来取面板的静态文件（只有 kiosk 会取，DSH 侧只轮询 /status）。
      staticHits: 0,
      staticSeen: [],
      debugLogPath: launch.debugLogPath,
      pageUrl,
      sawAlive: false,
      finishedAt: null,
      retainUntil: 0,
      resultPng: null,
      userDataDir: launch.userDataDir,
      stopping: false,
    };
    child.once?.('error', (error) => {
      log(ctx, 'warn', `overlay kiosk failed to start: ${message(error)}`);
      finish('aborted', `kiosk launch failed: ${message(error)}`);
    });
    startWatchdog();
    log(ctx, 'info', `overlay started: frame ${shot.bytes.length} bytes (${String(shot.info.mode)}), requested ${mode}, pid ${String(child.pid)}, capture ${capturedMs} ms, launch ${launch.description}`);
    return {
      ok: true,
      token,
      startMs: session.startedAt,
      mode: shot.info.mode,
      requestedMode: mode,
      hiddenMs: shot.info.hiddenMs,
      frameBytes: shot.bytes.length,
    };
  }

  return {
    start,
    sessionFor,
    /** Register a heartbeat; only a live session is refreshed. */
    ping(token) {
      const target = sessionFor(token);
      if (target === undefined) return undefined;
      if (target.state === 'running') {
        target.lastPingAt = Date.now();
        target.pings += 1;
      }
      return target;
    },
    /**
     * Record that the browser fetched one of the panel's static files (t80).
     * @param {string} hit - short label (`page`, `asset:overlay.css`, `lib:geometry.mjs`, …).
     * @returns {void}
     */
    noteStatic(hit) {
      if (session === null || session.state !== 'running') return;
      session.staticHits += 1;
      const label = typeof hit === 'string' && hit !== '' ? hit : 'unknown';
      if (session.staticSeen.length < OVERLAY_STATIC_SEEN_LIMIT && !session.staticSeen.includes(label)) {
        session.staticSeen.push(label);
      }
    },
    /**
     * Accept a result from the overlay.
     * @param {string} token - session token.
     * @param {string|undefined} action - `cancel` or one of {@link OVERLAY_ACTIONS}.
     * @param {Buffer|undefined} png - the annotated PNG.
     * @returns {any} acceptance outcome.
     */
    submitResult(token, action, png) {
      const target = sessionFor(token);
      if (target === undefined) return undefined;
      if (target.state !== 'running') return { accepted: false, state: target.state, error: 'overlay.already-finished' };
      if (action === 'cancel') {
        target.action = 'cancel';
        finish('cancelled', 'the overlay reported a cancellation');
        return { accepted: true, state: 'cancelled' };
      }
      if (!OVERLAY_ACTIONS.includes(action)) return { accepted: false, state: target.state, error: 'overlay.bad-action' };
      if (png === undefined || png.length === 0) return { accepted: false, state: target.state, error: 'overlay.empty-result' };
      target.resultPng = png;
      target.action = action;
      finish('ready', `the overlay reported ${action} (${png.length} bytes)`);
      return { accepted: true, state: 'ready' };
    },
    /** Absolute path of the overlay page (inside the configured overlay directory). */
    pagePath() {
      return join(settings.overlayDir, 'index.html');
    },
    assetPath(name) {
      return resolveInside(settings.overlayDir, name);
    },
    libPath(name) {
      return resolveInside(join(PACKAGE_DIR, 'lib'), name);
    },
    /** Ceiling for one result body (the handler must not reach for `settings`). */
    bodyLimitBytes() {
      return settings.overlayBodyLimitBytes;
    },
    async dispose() {
      disposed = true;
      stopWatchdog();
      if (session !== null) {
        const target = session;
        session = null;
        await stopKiosk(target);
      }
    },
  };
}

/**
 * Request handler for the whole overlay route family. Owns the response lifecycle
 * and never throws (the surrounding webServer turns a throw into a 400).
 * @param {any} req - Node `IncomingMessage`.
 * @param {any} res - Node `ServerResponse`.
 * @param {any} ctx - logging context.
 * @param {any} overlay - the overlay host.
 * @param {any} [text] - the OCR + translation service (t75); absent in older callers, in which case both routes answer `*.unavailable`.
 * @returns {Promise<void>} resolves once the response is settled.
 */
async function handleOverlay(req, res, ctx, overlay, text = undefined) {
  try {
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
    const url = new URL(typeof req?.url === 'string' && req.url !== '' ? req.url : OVERLAY_PREFIX, 'http://127.0.0.1');
    const path = url.pathname;
    const token = overlayParam(url, 'token');
    if (path === OVERLAY_START_PATH) {
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method.not_allowed' }, { Allow: 'POST' });
        return;
      }
      // t67：`?mode=through|normal` 决定这次会话抓屏时是否先隐藏 DSH（DSH 侧右键菜单的选择）。
      const started = await overlay.start(readOverlayMode(url));
      sendJson(res, 200, started);
      return;
    }
    // ── 静态资源：页面 / 资产 / lib 模块 ────────────────────────────────────
    // **必须在 token 校验之前**（t64 实机缺陷）：面板页面的 URL 带 token，但它的
    // `<link rel="stylesheet" href="…/overlay/asset/overlay.css">`、`<script type="module"
    // src="…/overlay/asset/overlay.js">` 以及页面里那些静态 `import '…/overlay/lib/x.mjs'`
    // 都**不带 token**（静态 import 无法在 URL 上挂查询串）。此前的顺序是先校验 token 再判静态分支，
    // 于是三个静态族全都 404 overlay.unknown-token：kiosk 窗口只渲染出未样式化的 HTML
    // （白底 + 页面里那行静态提示文字 + 一个裸 input），脚本一行都没跑 → 没有心跳 →
    // 5 s 后会话 aborted。这三个分支不含任何用户数据（就是包里的文件），无需 token。
    if (path === OVERLAY_PAGE_PATH) {
      // t80：先记账再判断方法——"浏览器来过"本身就是这次会话最缺的证据。
      overlay.noteStatic?.('page');
      if (method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method.not_allowed' }, { Allow: 'GET' });
        return;
      }
      sendStaticFile(res, overlay.pagePath(), 'text/html; charset=utf-8', 'overlay.page-missing', ctx, OVERLAY_PAGE_PATH);
      return;
    }
    if (path.startsWith(OVERLAY_ASSET_PREFIX)) {
      const name = path.slice(OVERLAY_ASSET_PREFIX.length);
      overlay.noteStatic?.(`asset:${name}`);
      sendStaticFile(res, overlay.assetPath(name), contentTypeFor(name), 'overlay.asset-missing', ctx, name);
      return;
    }
    if (path.startsWith(OVERLAY_LIB_PREFIX)) {
      const name = path.slice(OVERLAY_LIB_PREFIX.length);
      overlay.noteStatic?.(`lib:${name}`);
      if (!name.endsWith('.mjs')) {
        sendJson(res, 404, { ok: false, error: 'overlay.lib-missing' });
        return;
      }
      sendStaticFile(res, overlay.libPath(name), 'text/javascript; charset=utf-8', 'overlay.lib-missing', ctx, name);
      return;
    }
    // ── 数据路由：一律要求有效 token（帧与结果都是用户的屏幕内容）──────────
    const session = overlay.sessionFor(token);
    if (session === undefined) {
      sendJson(res, 404, { ok: false, error: 'overlay.unknown-token' });
      return;
    }
    if (path === OVERLAY_FRAME_PATH) {
      // Served from the session cache: the page (and a refresh) never re-captures.
      sendBytes(res, 200, session.frame, 'image/png');
      return;
    }
    if (path === OVERLAY_RESULT_PNG_PATH) {
      if (session.resultPng === null) {
        sendJson(res, 404, { ok: false, error: 'overlay.result-missing', state: session.state });
        return;
      }
      sendBytes(res, 200, session.resultPng, 'image/png');
      return;
    }
    if (path === OVERLAY_STATUS_PATH) {
      sendJson(res, 200, {
        ok: true,
        token,
        state: session.state,
        action: session.action,
        startMs: session.startedAt,
        mode: session.info?.mode ?? MODE_NORMAL,
        // 请求的模式与**实际**模式分开报（穿透失败时 info.mode 会回落到 normal，客户端据此给可见提示）。
        requestedMode: session.mode ?? MODE_THROUGH,
        hiddenMs: session.info?.hiddenMs ?? 0,
        hasResult: session.resultPng !== null,
      });
      return;
    }
    if (path === OVERLAY_PING_PATH) {
      const refreshed = overlay.ping(token);
      sendJson(res, 200, { ok: refreshed !== undefined, state: refreshed?.state ?? 'unknown' });
      return;
    }
    // ── t75：区域识别与翻译（同一族路由，同一个 token 门）────────────────────
    // 两者都是**旁路**：不改变会话状态、不产出结果图，面板拿到文本后可以继续标注/输出，
    // 也可以直接关掉窗口。因此它们就排在这里 —— token 已经校验过，会话仍可读。
    if (path === OVERLAY_OCR_PATH) {
      await handleOcrRequest(req, res, ctx, text);
      return;
    }
    if (path === OVERLAY_TRANSLATE_PATH) {
      await handleTranslateRequest(req, res, ctx, text);
      return;
    }
    if (path === OVERLAY_CLIPBOARD_PATH) {
      await handleClipboardRequest(req, res, ctx, text);
      return;
    }
    if (path === OVERLAY_RESULT_PATH) {
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method.not_allowed' }, { Allow: 'POST' });
        return;
      }
      const body = await readRequestBody(req, overlay.bodyLimitBytes());
      const contentType = String(req.headers?.['content-type'] ?? '');
      let action = overlayParam(url, 'action') ?? undefined;
      let png;
      const looksJson = contentType.includes('application/json') || (body.length > 0 && body[0] === 0x7b);
      if (looksJson) {
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { ok: false, error: 'overlay.bad-json' });
          return;
        }
        if (parsed !== null && typeof parsed === 'object') {
          if (typeof parsed.action === 'string') action = parsed.action;
          png = extractResultPng(parsed);
        }
      } else if (body.length > 0) {
        if (!body.subarray(0, 8).equals(PNG_SIGNATURE)) {
          sendJson(res, 400, { ok: false, error: 'overlay.bad-body' });
          return;
        }
        png = body;
      }
      const outcome = overlay.submitResult(token, action, png);
      if (outcome?.accepted !== true) {
        sendJson(res, 400, { ok: false, error: outcome?.error ?? 'overlay.bad-action', state: outcome?.state });
        return;
      }
      sendJson(res, 200, { ok: true, state: outcome.state, action: session.action });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'overlay.not-found' });
  } catch (error) {
    // A capture failure inside `start` keeps the frozen 502 shape; anything else
    // in this route family answers with its own code, so a bug in the overlay
    // plumbing cannot masquerade as a capture failure.
    if (error instanceof CaptureError) {
      report(ctx, res, error);
      return;
    }
    const detail = message(error);
    log(ctx, 'warn', `overlay request failed: ${detail}`);
    if (res.headersSent === true) {
      res.destroy?.();
      return;
    }
    sendJson(res, 500, { ok: false, error: 'overlay.failed', message: clip(detail, 240) });
  }
}

/**
 * Read the capture mode a new overlay session was asked for (t67).
 *
 * `through` (the default) hides DSH before grabbing pixels, so the frozen frame never
 * contains DSH. `normal` keeps DSH on screen — the frozen frame *does* contain it, which
 * is exactly what the right-click menu's "普通截图 / Normal" is for (capturing the DSH
 * UI itself). Anything unrecognised falls back to `through`, so an older client keeps
 * the pre-t67 behaviour.
 * @param {URL} url - the parsed request URL.
 * @returns {string} {@link MODE_THROUGH} or {@link MODE_NORMAL}.
 */
function readOverlayMode(url) {
  return overlayParam(url, 'mode') === MODE_NORMAL ? MODE_NORMAL : MODE_THROUGH;
}

/**
 * Read one overlay query parameter.
 *
 * The overlay route family has its own parameter set (token/action) that the page
 * in `overlay/` and the client orchestration define together; it is deliberately
 * read through this helper so it stays a separate family from the capture route's
 * parameters that validate.mjs X-1 pins. Extending X-1 to compare the overlay
 * family too is a follow-up for the validation owner.
 * @param {URL} url - the parsed request URL.
 * @param {string} name - the parameter name.
 * @returns {string|null} the raw value.
 */
function overlayParam(url, name) {
  // Iterated rather than read through `searchParams.get(...)`: the overlay family
  // is a separate route family, so it must not leak parameter names into the
  // capture-route parameter comparison of validate.mjs X-1.
  for (const [key, value] of url.searchParams) {
    if (key === name) return value;
  }
  return null;
}

/** PNG magic bytes, used to tell a binary result body apart from junk. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Resolve one relative request path inside a root directory, refusing traversal,
 * absolute paths and anything that escapes the root after resolution.
 * @param {string} rootDir - the directory the route is confined to.
 * @param {string} relative - the raw (percent-encoded) path suffix.
 * @returns {string|undefined} the absolute path, or undefined when refused.
 */
function resolveInside(rootDir, relative) {
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return undefined;
  }
  if (decoded === '' || decoded.includes('\0')) return undefined;
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return undefined;
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) return undefined;
  const root = resolve(rootDir);
  const absolute = resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(root + sep)) return undefined;
  return absolute;
}

/**
 * @param {string} name - a file name.
 * @returns {string} the content type for that extension.
 */
function contentTypeFor(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.mjs') || lower.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

/**
 * Serve one file from disk (static overlay page/asset/lib routes).
 * @param {any} res - Node `ServerResponse`.
 * @param {string|undefined} absolutePath - the resolved path, undefined when refused.
 * @param {string} contentType - response content type.
 * @param {string} missingCode - machine-readable code when the file is absent.
 * @param {any} [ctx] - logging context; a missing file is logged (t64: a 404 here makes the
 *   panel render as unstyled HTML and says nothing in the DSH log otherwise).
 * @param {string} [label] - short name for that log line.
 * @returns {void}
 */
/**
 * Write down where the panel files are and whether they are actually there (t80).
 *
 * A panel that never opens has two very different causes — the files were not installed, or the
 * browser never asked for them — and the startup log is the only place the first one shows up.
 * Diagnostics must never break plugin startup, so every failure here is swallowed.
 * @param {any} ctx - plugin context (for the logger).
 * @param {any} overlay - the overlay host (owns page/asset/lib path resolution).
 * @returns {void}
 */
function reportOverlayAssets(ctx, overlay) {
  try {
    const page = overlay.pagePath();
    const script = overlay.assetPath('overlay.js');
    const style = overlay.assetPath('overlay.css');
    const libDir = dirname(overlay.libPath('geometry.mjs'));
    let modules = -1;
    try {
      modules = readdirSync(libDir).filter((name) => name.endsWith('.mjs')).length;
    } catch {
      /* the directory is missing entirely; -1 reports exactly that */
    }
    const mark = (file) => (existsSync(file) ? 'ok' : 'MISSING');
    log(ctx, 'info', `overlay assets: page ${mark(page)} ${page}, script ${mark(script)} ${script}, style ${mark(style)} ${style}, lib ${modules < 0 ? 'MISSING' : `${String(modules)} modules`} ${libDir}`);
    log(ctx, 'info', `overlay kiosk flags: ${OVERLAY_KIOSK_FLAGS.join(' ')} + --enable-logging --log-file=<profile>/${OVERLAY_KIOSK_LOG_NAME} --user-data-dir=<profile>`);
  } catch (error) {
    log(ctx, 'warn', `overlay asset report failed: ${message(error)}`);
  }
}

function sendStaticFile(res, absolutePath, contentType, missingCode, ctx = undefined, label = '') {
  if (absolutePath === undefined) {
    sendJson(res, 400, { ok: false, error: 'overlay.bad-path' });
    return;
  }
  let bytes;
  try {
    bytes = readFileSync(absolutePath);
  } catch {
    if (ctx !== undefined) log(ctx, 'warn', `overlay static file missing: ${label === '' ? absolutePath : label} (${missingCode})`);
    sendJson(res, 404, { ok: false, error: missingCode });
    return;
  }
  sendBytes(res, 200, bytes, contentType);
}

/**
 * Write raw bytes, tolerating a socket that is already gone.
 * @param {any} res - Node `ServerResponse`.
 * @param {number} status - HTTP status (only 200 is used).
 * @param {Buffer} bytes - the payload.
 * @param {string} contentType - response content type.
 * @returns {void}
 */
function sendBytes(res, status, bytes, contentType) {
  try {
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end(bytes);
  } catch {
    try {
      res.destroy?.();
    } catch {
      /* the socket is already unusable */
    }
  }
}

/**
 * Read a request body with a hard ceiling.
 * @param {any} req - Node `IncomingMessage`.
 * @param {number} limitBytes - maximum accepted size.
 * @returns {Promise<Buffer>} the body.
 */
function readRequestBody(req, limitBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        rejectPromise(new CaptureError('overlay.body-too-large', `${size} bytes exceeds the ${limitBytes} byte ceiling`));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', (error) => rejectPromise(error));
  });
}

/**
 * Pull the annotated PNG out of a JSON result body (base64 or data URL).
 * @param {Record<string, unknown>} parsed - the parsed JSON body.
 * @returns {Buffer|undefined} the bytes, when the payload is usable.
 */
function extractResultPng(parsed) {
  const raw = typeof parsed.png === 'string'
    ? parsed.png
    : typeof parsed.base64 === 'string'
      ? parsed.base64
      : typeof parsed.dataUrl === 'string'
        ? parsed.dataUrl
        : undefined;
  if (raw === undefined) return undefined;
  const commaAt = raw.indexOf(',');
  const payload = raw.startsWith('data:') && commaAt !== -1 ? raw.slice(commaAt + 1) : raw;
  const cleaned = payload.replace(/\s+/g, '');
  if (cleaned === '' || !/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) return undefined;
  return Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * @param {number} pid - process id.
 * @returns {boolean} whether that process still exists.
 */
function processAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Run the overlay helper script (`lib/overlay-host.ps1`) and parse its JSON.
 * @param {any} ctx - logging context.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {string[]} args - action arguments.
 * @param {number} timeoutMs - ceiling for this run.
 * @returns {Promise<Record<string, unknown>>} the parsed result.
 */
async function runOverlayHost(ctx, settings, args, timeoutMs) {
  if (!existsSync(settings.overlayHostScript)) {
    throw new CaptureError('overlay.host-script-missing', `${settings.overlayHostScript} does not exist`);
  }
  return runScript(ctx, settings, [...POWERSHELL_ARGS, '-File', settings.overlayHostScript, ...args], timeoutMs);
}

/**
 * Capture once: run the script, read the PNG, describe the frame.
 *
 * Through mode (`mode=through`) adds two guarantees around the script run:
 * 1. the script hides the DSH window and restores it in its own `finally`; if it
 *    could not confirm the restore (or died before reporting), this function
 *    runs the rescue entry point before answering, so a hidden window is never
 *    left behind;
 * 2. a frame whose window could not be restored is reported as a failure (502),
 *    never as a successful capture.
 * @param {any} ctx - context used to find the `subprocess` service.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {{ x: number, y: number, width: number, height: number }|undefined} viewportCss - the Client half's CSS viewport, when it sent one.
 * @param {string} mode - `normal` or `through`.
 * @returns {Promise<{ bytes: Buffer, info: Record<string, unknown> }>} the frame and its descriptor.
 */
async function captureOnce(ctx, settings, viewportCss, mode = MODE_NORMAL) {
  const startedAt = Date.now();
  let parsed;
  try {
    parsed = await runCaptureScript(ctx, settings, mode);
  } catch (error) {
    // The script may have hidden the window before failing: always try to put it
    // back before the error travels to the client.
    if (mode === MODE_THROUGH) await rescueRestore(ctx, settings, `capture failed: ${message(error)}`);
    throw error;
  }
  if (mode === MODE_THROUGH && parsed.restore_ok === false) {
    // The script could not confirm the restore: the rescue entry point gets the
    // second (forced) attempt before this capture is reported as failed.
    const rescue = await rescueRestore(ctx, settings, 'the script reported restore_ok=false');
    throw new CaptureError(
      'capture.restore-failed',
      rescue === 'restored'
        ? 'the DSH window restore could not be confirmed by the capture script (the rescue restore succeeded afterwards)'
        : `the DSH window could not be confirmed visible again (rescue restore: ${rescue})`,
    );
  }
  const pngPath = text(parsed.png_path);
  if (pngPath === undefined) {
    const reported = text(parsed.error) ?? 'the capture script reported no PNG path';
    throw new CaptureError('capture.failed', reported);
  }
  let bytes;
  try {
    bytes = readFileSync(pngPath);
  } catch (error) {
    throw new CaptureError('capture.unreadable-png', `${pngPath}: ${message(error)}`);
  }
  if (!settings.keepTempFile) {
    try {
      unlinkSync(pngPath);
    } catch (error) {
      log(ctx, 'debug', `temporary PNG left in place: ${message(error)}`);
    }
  }
  if (bytes.length === 0) throw new CaptureError('capture.empty-png', `${pngPath} is empty`);
  if (bytes.length > PNG_LIMIT_BYTES) {
    throw new CaptureError('capture.png-too-large', `${bytes.length} bytes exceeds the ${PNG_LIMIT_BYTES} byte ceiling`);
  }
  if (parsed.single_screen === false) {
    // P0 is single-screen (DoD E-2): say so instead of silently half-capturing.
    log(ctx, 'warn', `multi-monitor setup (${String(parsed.screen_count)} screens): capturing the primary screen only`);
  }
  if (mode === MODE_THROUGH && text(parsed.through) === 'skipped') {
    // Nothing was hidden: the caller falls back to an ordinary frame and the
    // descriptor says `mode: normal`, so the Client half can tell the user.
    log(ctx, 'warn', `through capture skipped: ${text(parsed.through_reason) ?? 'the DSH window could not be confirmed'}`);
  }
  return { bytes, info: describe(parsed, bytes.length, Date.now() - startedAt, viewportCss, mode) };
}

/**
 * Rescue restore: run the script's `-RestoreOnly` entry point, which resolves
 * the DSH window and restores it without capturing anything. Idempotent, bounded
 * by {@link RESCUE_TIMEOUT_MS}, and it never throws - the caller only logs the
 * outcome, because the request's own error is what the client needs to see.
 * @param {any} ctx - logging context.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {string} reason - why the rescue runs (goes into the log line).
 * @returns {Promise<'restored'|'failed'>} whether the window was confirmed visible again.
 */
async function rescueRestore(ctx, settings, reason) {
  log(ctx, 'warn', `rescue restore (${reason})`);
  try {
    const parsed = await runRestoreScript(ctx, settings);
    if (parsed.restore_ok === true) {
      log(ctx, 'warn', 'rescue restore: the DSH window is visible again');
      return 'restored';
    }
    log(ctx, 'error', 'rescue restore could not confirm the DSH window is visible again');
    return 'failed';
  } catch (error) {
    log(ctx, 'error', `rescue restore failed: ${message(error)}`);
    return 'failed';
  }
}

/**
 * Describe one capture exactly as `normalizeCapture` defines it, so the Client
 * half can validate the header with the same function it uses for its own data.
 *
 * The three through-capture fields (`mode`, `hiddenMs`, `restoreOk`) are appended
 * after `normalizeCapture` on purpose: that frozen validator in `lib/` copies
 * only the fields it declares, so fields added by a later feature have to be
 * merged in here. Their names are the interface both halves implement verbatim
 * (validate.mjs X-1 checks them).
 * @param {Record<string, unknown>} parsed - the capture script's JSON.
 * @param {number} byteLength - PNG size in bytes, as actually read back.
 * @param {number} measuredMs - host-side duration of this capture (used only when the script reported none).
 * @param {{ x: number, y: number, width: number, height: number }|undefined} viewportCss - optional CSS viewport.
 * @param {string} [requestedMode] - the mode the request asked for.
 * @returns {Record<string, unknown>} the descriptor carried in `X-DSH-Screenshot`.
 */
function describe(parsed, byteLength, measuredMs, viewportCss, requestedMode = MODE_NORMAL) {
  const widthPx = positiveInteger(parsed.bitmap_width);
  const heightPx = positiveInteger(parsed.bitmap_height);
  if (widthPx === undefined || heightPx === undefined) {
    throw new CaptureError('capture.no-dimensions', 'the capture script reported no bitmap size');
  }
  // P0 captures the primary screen only: `capture_bounds` is the rectangle the
  // bitmap covers (the one the Client half must map onto). `virtual_screen` is
  // the union of every monitor and is only a fallback for older scripts.
  const bounds = readBounds(parsed.capture_bounds) ?? readBounds(parsed.virtual_screen);
  const measured = bounds === undefined ? undefined : screenPixelRatio({ widthPx, heightPx, bounds });
  const scale = measured ?? positiveNumber(parsed.scale);
  // The buffer actually handed to the client is the truth for `bytes`; the
  // script's own timer is the contract's `elapsedMs` (falling back to ours).
  const bytes = byteLength > 0 ? byteLength : positiveInteger(parsed.png_bytes);
  const elapsed = positiveNumber(parsed.elapsed_total_ms) ?? positiveNumber(measuredMs);
  // `through` only when the window was really hidden and a frame was grabbed;
  // a request that could not confirm the DSH window falls back to a normal
  // frame, and the descriptor says so (`mode: normal`).
  const hidden = requestedMode === MODE_THROUGH && text(parsed.through) === 'captured';
  const hiddenMs = hidden ? Math.max(0, Math.round(positiveNumber(parsed.hidden_ms) ?? 0)) : 0;
  const restoreOk = parsed.restore_ok !== false;
  return {
    ...normalizeCapture({
      widthPx,
      heightPx,
      // Same-origin carrier for the frame; the Client half normally uses the
      // response Blob instead, but `normalizeCapture` requires a carrier.
      url: ROUTE_PATH,
      ...(bounds === undefined ? {} : { bounds }),
      ...(scale === undefined ? {} : { scale }),
      ...(viewportCss === undefined ? {} : { viewportCss }),
      ...(bytes === undefined ? {} : { bytes }),
      ...(elapsed === undefined ? {} : { elapsedMs: elapsed }),
    }),
    mode: hidden ? MODE_THROUGH : MODE_NORMAL,
    hiddenMs,
    restoreOk,
  };
}

/**
 * Run `lib/capture.ps1` and return its parsed JSON, preferring the host's
 * `subprocess` service and falling back to `node:child_process`.
 * @param {any} ctx - context used to find the `subprocess` service.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {string} [mode] - `normal` (default) or `through`.
 * @returns {Promise<Record<string, unknown>>} the script's result object.
 */
async function runCaptureScript(ctx, settings, mode = MODE_NORMAL) {
  if (!existsSync(settings.scriptPath)) {
    throw new CaptureError('capture.script-missing', `${settings.scriptPath} does not exist`);
  }
  const argv = [
    ...POWERSHELL_ARGS,
    '-File',
    settings.scriptPath,
    '-Mode',
    'both',
    '-DpiAware',
    '-OutDir',
    settings.outDir,
    '-Tag',
    settings.tag,
  ];
  if (mode === MODE_THROUGH) {
    // Only this process's own DSH window may be hidden; the script confirms the
    // target by parent pid, image name and title fragment, and skips the hiding
    // entirely when it cannot (see capture.ps1).
    argv.push(
      '-Through',
      '-HideWaitMs',
      String(settings.hideWaitMs),
      '-HideMethod',
      settings.hideMethod,
      '-DshPid',
      String(settings.dshPid),
      '-DshImage',
      settings.dshImage,
      '-DshTitleHint',
      settings.dshTitleHint,
    );
  }
  return runScript(ctx, settings, argv, settings.timeoutMs);
}

/**
 * Run the script's rescue entry point: resolve the DSH window and restore it,
 * without touching the screen. Bounded by {@link RESCUE_TIMEOUT_MS}.
 * @param {any} ctx - context used to find the `subprocess` service.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @returns {Promise<Record<string, unknown>>} the script's result object.
 */
async function runRestoreScript(ctx, settings) {
  if (!existsSync(settings.scriptPath)) {
    throw new CaptureError('capture.script-missing', `${settings.scriptPath} does not exist`);
  }
  const argv = [
    ...POWERSHELL_ARGS,
    '-File',
    settings.scriptPath,
    '-Mode',
    'info',
    '-RestoreOnly',
    '-DshPid',
    String(settings.dshPid),
    '-DshImage',
    settings.dshImage,
    '-DshTitleHint',
    settings.dshTitleHint,
  ];
  return runScript(ctx, settings, argv, RESCUE_TIMEOUT_MS);
}

/**
 * Run the capture script once: host `subprocess` service first, `node:child_process`
 * as the fallback, both bounded by `timeoutMs`.
 * @param {any} ctx - context used to find the `subprocess` service.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {string[]} argv - PowerShell arguments.
 * @param {number} timeoutMs - ceiling for this run.
 * @param {{ timeout: string, output: string, failed: string, exit: string }} [codes] - detail codes for this script's failures (defaults to the capture set).
 * @returns {Promise<Record<string, unknown>>} the script's result object.
 */
async function runScript(ctx, settings, argv, timeoutMs, codes = CAPTURE_SCRIPT_CODES) {
  const service = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined;
  if (service !== undefined && typeof service.spawn === 'function') {
    try {
      const outcome = await spawnThroughService(service, settings, argv, timeoutMs);
      return interpret(outcome, timeoutMs, codes);
    } catch (error) {
      // A CaptureError means the script ran and reported a capture-level
      // failure: that is the real answer, so it is never retried locally.
      if (error instanceof CaptureError) throw error;
      // Anything else is a provider/transport failure (different execution
      // world, unresolvable executable); the local spawn below still works.
      log(ctx, 'warn', `subprocess service could not run the capture script (${message(error)}); falling back to node:child_process`);
    }
  }
  return interpret(await spawnThroughChildProcess(settings, argv, timeoutMs), timeoutMs, codes);
}

/**
 * Spawn through the host's process service.
 * @param {any} service - `ctx.subprocess`.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {string[]} argv - PowerShell arguments.
 * @param {number} timeoutMs - ceiling for this run.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number|null, timedOut: boolean }>} raw outcome.
 */
async function spawnThroughService(service, settings, argv, timeoutMs) {
  const handle = service.spawn({
    argv: [settings.powershellPath, ...argv],
    cwd: PACKAGE_DIR,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
      stderr: { maxBytes: OUTPUT_LIMIT_BYTES },
    },
    graceMs: Math.min(timeoutMs, 5_000),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      handle.terminate();
    } catch {
      /* the handle is already gone */
    }
  }, timeoutMs);
  try {
    let outcome = null;
    let failure = null;
    try {
      outcome = await handle.done;
    } catch (error) {
      failure = error;
    }
    // A terminated child often surfaces as a rejected `done`; that IS the
    // timeout answer, so it is reported as such instead of being retried.
    if (failure !== null && !timedOut) throw failure;
    return {
      stdout: handle.collected?.stdout?.readFrom(0)?.text ?? '',
      stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
      exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spawn with `node:child_process`. The console window is hidden (a visible one
 * could end up in the very screenshot being taken) and the child is force-killed
 * when the timeout expires, so nothing outlives one request.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {string[]} argv - PowerShell arguments.
 * @param {number} timeoutMs - ceiling for this run.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number|null, timedOut: boolean }>} raw outcome.
 */
function spawnThroughChildProcess(settings, argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(settings.powershellPath, argv, {
        cwd: PACKAGE_DIR,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new CaptureError('capture.spawn-failed', message(error)));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* the child is already gone */
      }
      // A child that ignores SIGTERM must not keep the request alive.
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2_000);
      hard.unref?.();
    }, timeoutMs);
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT_BYTES) stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT_BYTES) stderr += chunk;
    });
    child.once('error', (error) => settle(() => reject(new CaptureError('capture.spawn-failed', message(error)))));
    child.once('close', (code) =>
      settle(() => resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : null, timedOut })),
    );
  });
}

/**
 * Turn one raw run into the capture result, or into the most useful diagnostic.
 * @param {{ stdout: string, stderr: string, exitCode: number|null, timedOut: boolean }} outcome - raw run outcome.
 * @param {number} timeoutMs - the ceiling that was applied to this run.
 * @param {{ timeout: string, output: string, failed: string, exit: string }} [codes] - detail codes to report with.
 * @returns {Record<string, unknown>} the parsed JSON result.
 */
function interpret(outcome, timeoutMs, codes = CAPTURE_SCRIPT_CODES) {
  if (outcome.timedOut) {
    throw new CaptureError(codes.timeout, `no result within ${timeoutMs} ms`);
  }
  let parsed;
  try {
    parsed = parseResult(outcome.stdout);
  } catch (error) {
    throw new CaptureError(codes.output, `${message(error)}; stderr: ${tail(outcome.stderr)}`);
  }
  if (parsed.ok !== true) {
    const reported = text(parsed.error) ?? `exit code ${outcome.exitCode ?? 'unknown'}`;
    throw new CaptureError(codes.failed, `${reported}; stderr: ${tail(outcome.stderr)}`);
  }
  if (outcome.exitCode !== 0) {
    throw new CaptureError(codes.exit, `exit code ${outcome.exitCode ?? 'null'} after a success report`);
  }
  return parsed;
}

/**
 * Detail codes for the capture script. Extracted into a constant so {@link runScript}
 * can take a different set (the OCR script reports `ocr.*`, not `capture.*`) without
 * either caller drifting from the literal values the tests pin.
 */
const CAPTURE_SCRIPT_CODES = Object.freeze({
  timeout: 'capture.timeout',
  output: 'capture.unusable-output',
  failed: 'capture.failed',
  exit: 'capture.exit',
});

/**
 * Extract the JSON block the capture script prints between its markers.
 * @param {string} stdout - the script's stdout.
 * @returns {Record<string, unknown>} the parsed object.
 */
function parseResult(stdout) {
  const text_ = typeof stdout === 'string' ? stdout.replace(/^\uFEFF/, '') : '';
  const begin = text_.indexOf(JSON_BEGIN);
  const end = text_.indexOf(JSON_END, begin === -1 ? 0 : begin + JSON_BEGIN.length);
  if (begin === -1 || end === -1) throw new Error('the capture script printed no JSON block');
  const raw = text_.slice(begin + JSON_BEGIN.length, end).trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the capture script printed unparsable JSON: ${message(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('the capture script JSON is not an object');
  return parsed;
}

/**
 * Read the request mode. Anything that is not exactly `through` is the ordinary
 * capture, so a request without the parameter behaves exactly as before (t44).
 * @param {URL} url - the parsed request URL.
 * @returns {string} {@link MODE_THROUGH} or {@link MODE_NORMAL}.
 */
function readMode(url) {
  return url.searchParams.get(MODE_PARAM) === MODE_THROUGH ? MODE_THROUGH : MODE_NORMAL;
}

/**
 * Name of the DSH executable to recognise by image name. The plugin host is a
 * child of the Electron main process, so `process.execPath` is the DSH binary.
 * @returns {string} the image name, e.g. `DSH Desktop`.
 */
function defaultDshImage() {
  const base = basename(process.execPath ?? '');
  return base === '' ? 'DSH Desktop' : base.replace(/\.exe$/i, '');
}

/**
 * The window owner to prefer: the process that spawned this plugin host (the
 * Electron main process owns the DSH window). The script also accepts an image
 * or title match, so a wrong pid alone never hides the wrong window.
 * @returns {number} a positive pid, or 0 when the platform reports none.
 */
function defaultDshPid() {
  const pid = process.ppid;
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * Read `vw`/`vh` off the request: the Client half's CSS viewport at capture time.
 * @param {URL} url - the parsed request URL.
 * @returns {{ x: number, y: number, width: number, height: number }|undefined} the CSS viewport, when both values are usable.
 */
function readViewport(url) {
  const width = positiveNumber(url.searchParams.get('vw'));
  const height = positiveNumber(url.searchParams.get('vh'));
  if (width === undefined || height === undefined) return undefined;
  return { x: 0, y: 0, width, height };
}

/**
 * Validate the virtual-screen rectangle reported by the capture script.
 * @param {unknown} input - the `virtual_screen` value.
 * @returns {{ x: number, y: number, width: number, height: number }|undefined} the rectangle, when usable.
 */
function readBounds(input) {
  if (input === null || typeof input !== 'object') return undefined;
  const value = /** @type {Record<string, unknown>} */ (input);
  const width = positiveNumber(value.width);
  const height = positiveNumber(value.height);
  if (width === undefined || height === undefined) return undefined;
  const x = finiteNumber(value.x) ?? 0;
  const y = finiteNumber(value.y) ?? 0;
  return { x, y, width, height };
}

/**
 * Absolute path of the Windows PowerShell 5.1 engine.
 * @returns {string} the absolute path when it exists, else the bare command.
 */
function defaultPowerShellPath() {
  const root = text(process.env.SystemRoot) ?? text(process.env.windir) ?? 'C:\\Windows';
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(candidate) ? candidate : 'powershell.exe';
}

/**
 * @param {unknown} input - candidate text.
 * @returns {string|undefined} the trimmed non-empty string.
 */
function text(input) {
  return typeof input === 'string' && input.trim() !== '' ? input.trim() : undefined;
}

/**
 * @param {unknown} input - candidate number or numeric string.
 * @returns {number|undefined} a positive finite number.
 */
function positiveNumber(input) {
  const value = typeof input === 'string' ? Number(input) : input;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * @param {unknown} input - candidate number or numeric string.
 * @returns {number|undefined} a positive integer.
 */
function positiveInteger(input) {
  const value = positiveNumber(input);
  return value === undefined ? undefined : Math.trunc(value);
}

/**
 * @param {unknown} input - candidate number.
 * @returns {number|undefined} a finite number.
 */
function finiteNumber(input) {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

/**
 * @param {unknown} input - candidate text.
 * @param {number} limit - maximum length.
 * @returns {string} the text, cut to the limit.
 */
function clip(input, limit) {
  const value = typeof input === 'string' ? input : String(input);
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

/**
 * Last non-empty line of a stream, for diagnostics.
 * @param {unknown} input - the stream text.
 * @returns {string} a short tail.
 */
function tail(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (value === '') return '(empty)';
  const lines = value.split(/\r?\n/).filter((line) => line.trim() !== '');
  return clip(lines.at(-1) ?? value, 160);
}

/**
 * @param {unknown} error - any thrown value.
 * @returns {string} its message.
 */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Log one line. Logging never carries image data (DoD D-8) and never throws.
 * @param {any} ctx - context whose `logger` to use.
 * @param {'debug'|'info'|'warn'|'error'} level - the level to write at.
 * @param {string} line - the message.
 * @returns {void}
 */
function log(ctx, level, line) {
  try {
    const logger = ctx?.logger;
    const write = logger === undefined ? undefined : logger[level];
    if (typeof write !== 'function') return;
    write.call(logger, `[dsh-screenshot-xn] ${line}`);
  } catch {
    /* diagnostics must never break a capture */
  }
}
