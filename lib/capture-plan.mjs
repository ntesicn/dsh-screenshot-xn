/**
 * Capture descriptor, coordinate calibration and export planning
 * (PRD F-10, F-23 + 队长 revision 2: 标定 / 4 MB 降级).
 *
 * The Host half owns the pixels; the Client half owns the overlay. This module
 * is the agreed seam between them and the single place where coordinate math
 * lives, so the browser bundle and `node --test` share one implementation.
 *
 * ## Coordinate calibration (队长要求 3)
 *
 * The capture bitmap is the *whole virtual screen*; the overlay only covers the
 * DSH window. Two ratios therefore exist and are deliberately kept apart:
 *
 * - `displayScale`: device pixels of the bitmap per CSS pixel of the overlay.
 *   Derived from the bitmap's own size and the measured overlay box, because the
 *   overlay is what the frame is fitted onto. `devicePixelRatio` is not trusted
 *   here.
 * - `deviceScale`: device pixels of the bitmap per *screen* pixel, derived from
 *   the host-reported virtual-screen bounds (`left/top/width/height`). Combined
 *   with the window's own screen offset, this maps an overlay selection back to
 *   the region of the screen it came from, which is what keeps the exported crop
 *   aligned at 100% / 125% / 150% / 200% and with a non-maximized window.
 *
 * The two ratios must agree within {@link CALIBRATION_TOLERANCE}; when they do
 * not, the host bounds are unusable and the plan degrades to a proportional
 * fit with `degraded: true`. A degraded plan is always better than a crop drawn
 * at the wrong offset.
 *
 * Dependency-free, DOM-free.
 */
import { clamp, isValidSelection, MAX_EXPORT_EDGE, MIN_SELECTION_EDGE, toIntegerRect } from './geometry.mjs';

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {import('./geometry.mjs').Point} Point */

/** Relative disagreement between the two calibration ratios that still counts as calibrated. */
export const CALIBRATION_TOLERANCE = 0.02;

/** Largest exported edge, in device pixels (PRD F-23). */
export const DEFAULT_MAX_EDGE = MAX_EXPORT_EDGE;

/** Default size ceiling before the lossy fallback engages (队长 D-8: 4 MB). */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** PNG encoder option that asks the browser to prefer a smaller file (browsers ignore it safely). */
export const LOSSY_TIER_START = 0.92;

/** Quality steps tried by the WebP fallback, from best to smallest. */
export const WEBP_QUALITY_STEPS = Object.freeze([0.92, 0.82, 0.7, 0.55]);

/**
 * @typedef {object} CaptureInfo
 * @property {number} widthPx - captured frame width in device (physical) pixels.
 * @property {number} heightPx - captured frame height in device pixels.
 * @property {number} [scale] - device pixels per screen pixel, as reported by the host (optional).
 * @property {{ x: number, y: number, width: number, height: number }} [viewportCss] - the CSS
 *   viewport the host captured (the overlay's box is what the frame is fitted onto).
 * @property {Rect} [bounds] - virtual-screen bounds in screen pixels, as reported by the host.
 * @property {string} [dataUrl] - the frozen frame as a data URL.
 * @property {string} [url] - the frozen frame as an HTTP(S) URL.
 * @property {string} [mediaType] - media type of the carrier, when known.
 * @property {number} [elapsedMs] - capture duration reported by the backend.
 * @property {number} [bytes] - carrier size when the backend already knows it.
 */

/**
 * @typedef {object} Calibration
 * @property {number} displayScale - bitmap device pixels per overlay CSS pixel.
 * @property {number} deviceScale - bitmap device pixels per screen pixel.
 * @property {boolean} degraded - whether the host bounds corroborated the ratios.
 * @property {string} method - `bounds+overlay`, `overlay` or `overlay+dpr`.
 * @property {{ left: number, top: number, width: number, height: number }|undefined} bounds
 * @property {{ x: number, y: number, width: number, height: number }} overlay - CSS overlay box.
 * @property {{ x: number, y: number|undefined, width: number, height: number|undefined }} screen - window screen origin, when known.
 * @property {number|undefined} dpr - observed `window.devicePixelRatio`.
 */

/**
 * Normalize a raw capture result into a {@link CaptureInfo}.
 * The frame must carry a usable carrier (data URL or HTTP URL) so a later draw
 * cannot silently fail.
 * @param {unknown} raw - the backend result.
 * @returns {CaptureInfo} a validated descriptor.
 */
export function normalizeCapture(raw) {
  if (raw === null || typeof raw !== 'object') throw new TypeError('capture: result must be an object');
  const value = /** @type {Record<string, unknown>} */ (raw);
  const widthPx = positiveInteger(value.widthPx, 'widthPx');
  const heightPx = positiveInteger(value.heightPx, 'heightPx');
  const carrier = typeof value.dataUrl === 'string' && value.dataUrl !== ''
    ? { dataUrl: value.dataUrl }
    : typeof value.url === 'string' && value.url !== ''
      ? { url: value.url }
      : undefined;
  if (carrier === undefined) throw new TypeError('capture: result carries neither dataUrl nor url');

  const scale = readScale(value.scale);
  const bounds = readRect(value.bounds);
  const viewportCss = readRect(value.viewportCss);
  const mediaType = typeof value.mediaType === 'string' && value.mediaType !== '' ? value.mediaType : undefined;

  return {
    widthPx,
    heightPx,
    ...carrier,
    ...(scale === undefined ? {} : { scale }),
    ...(viewportCss === undefined ? {} : { viewportCss }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(finitePositive(value.elapsedMs) === undefined ? {} : { elapsedMs: finitePositive(value.elapsedMs) }),
    ...(finitePositive(value.bytes) === undefined ? {} : { bytes: finitePositive(value.bytes) }),
  };
}

/**
 * @param {unknown} input
 * @param {string} field
 * @returns {number} the validated positive integer.
 */
function positiveInteger(input, field) {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1) {
    throw new TypeError(`capture: ${field} must be a positive integer`);
  }
  return input;
}

/**
 * @param {unknown} input
 * @returns {number|undefined} the value when it is a positive finite number.
 */
function finitePositive(input) {
  return typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : undefined;
}

/**
 * @param {unknown} input
 * @returns {Rect|undefined} the validated rectangle.
 */
function readRect(input) {
  if (input === null || typeof input !== 'object') return undefined;
  const value = /** @type {Record<string, unknown>} */ (input);
  const width = finitePositive(value.width);
  const height = finitePositive(value.height);
  if (width === undefined || height === undefined) return undefined;
  const x = typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : 0;
  const y = typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : 0;
  return { x, y, width, height };
}

/**
 * @param {unknown} input
 * @returns {number|undefined} the declared scale, or undefined when the host did
 *   not declare one (absent and null mean "not declared").
 * @throws {TypeError} when the field is present but unusable, so a wrong scale
 *   is reported at the edge instead of silently mis-mapping every selection.
 */
function readScale(input) {
  if (input === undefined || input === null) return undefined;
  const scale = finitePositive(input);
  if (scale === undefined) throw new TypeError('capture: scale must be a positive finite number');
  return scale;
}

/**
 * @param {unknown} input
 * @returns {number|undefined} the value when it is a finite number (including 0 and negatives).
 */
function finiteNumber(input) {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

/**
 * Bitmap device pixels per overlay CSS pixel: the factor that maps a selection
 * drawn on the overlay onto the frozen frame.
 *
 * The measured overlay box is the ground truth (PRD 6.3-4: the frame's real
 * pixel size and the overlay's `getBoundingClientRect()` cross-check each other;
 * `devicePixelRatio` is never trusted here), because the overlay is what the
 * frame is fitted onto. The fallbacks answer the same question when the overlay
 * cannot be measured:
 *
 * 1. the measured overlay box;
 * 2. the host-declared `scale`;
 * 3. the host-reported CSS viewport at capture time (`viewportCss`);
 * 4. `1`, so a plan can always be built.
 *
 * @param {CaptureInfo} capture
 * @param {{ width: number, height: number }|undefined} [overlay] - the overlay's CSS box.
 * @returns {number} device pixels per CSS pixel.
 */
export function effectiveScale(capture, overlay) {
  const box = readRect(overlay);
  if (box !== undefined) {
    const fromOverlay = mean(capture.widthPx / box.width, capture.heightPx / box.height);
    if (Number.isFinite(fromOverlay) && fromOverlay > 0) return fromOverlay;
  }
  const declared = finitePositive(capture.scale);
  if (declared !== undefined) return declared;
  const viewport = readRect(capture.viewportCss);
  if (viewport !== undefined) {
    const fromViewport = mean(capture.widthPx / viewport.width, capture.heightPx / viewport.height);
    if (Number.isFinite(fromViewport) && fromViewport > 0) return fromViewport;
  }
  return 1;
}

/**
 * Calibrate the capture against the overlay and the host-reported virtual screen.
 *
 * The host gives the virtual screen's pixel bounds. Two ratios follow, and they
 * answer different questions:
 *
 * - `displayScale` = bitmap pixels per overlay CSS pixel. Always derivable, and
 *   the one that maps an overlay selection onto the bitmap.
 * - `deviceScale` = bitmap pixels per OS screen pixel. Host-sourced; it is the
 *   window's offset that would need it (`window.screenX` is in screen pixels).
 * - `screenScale` = OS screen pixels per CSS pixel, i.e. `displayScale /
 *   deviceScale`. Its expected value is exactly 1 unless the page is zoomed,
 *   which is what makes it a usable cross-check: a value far from 1 means the
 *   bounds describe a different surface than the overlay, and the plan must
 *   degrade instead of drawing at a wrong offset.
 *
 * @param {CaptureInfo} capture
 * @param {{ overlay?: { width: number, height: number }, screen?: { x?: number, y?: number }, dpr?: number }} [surface]
 *   the overlay's CSS box (when it could be measured), the window's screen
 *   offset, and the observed `window.devicePixelRatio`.
 * @returns {Calibration} the calibration; `degraded` is true when a fallback was needed.
 */
export function calibrateCapture(capture, surface = {}) {
  const box = readRect(surface.overlay);
  const overlay = box ?? { x: 0, y: 0, width: capture.widthPx, height: capture.heightPx };
  const displayScale = effectiveScale(capture, box);
  const dpr = finitePositive(surface.dpr);
  const bounds = capture.bounds;
  const screen = { x: finiteNumber(surface.screen?.x), y: finiteNumber(surface.screen?.y) };
  const hostRatio = screenPixelRatio(capture);

  const unattributable = hostRatio === undefined
    ? 'no-bounds'
    : !(hostRatio >= MIN_DEVICE_SCALE && hostRatio <= MAX_DEVICE_SCALE)
      ? 'implausible-bounds'
      : checkScreenScale(displayScale / hostRatio) === false
        ? 'screen-scale'
        : undefined;

  const deviceScale = hostRatio === undefined ? displayScale : hostRatio;
  const screenScale = displayScale / deviceScale;
  return {
    displayScale,
    deviceScale,
    screenScale,
    degraded: unattributable !== undefined,
    method: unattributable === undefined ? 'bounds+overlay' : 'overlay',
    reason: unattributable !== undefined ? unattributable : 'calibrated',
    bounds,
    overlay,
    screen,
    dpr,
  };
}

/** Lowest plausible bitmap-pixels-per-screen-pixel ratio. */
export const MIN_DEVICE_SCALE = 0.5;
/** Highest plausible bitmap-pixels-per-screen-pixel ratio. */
export const MAX_DEVICE_SCALE = 4;

/**
 * @param {number} ratio
 * @returns {boolean|undefined} whether the derived screen scale is credible;
 *   undefined when it is not a finite number at all.
 */
function checkScreenScale(ratio) {
  if (!Number.isFinite(ratio)) return undefined;
  return ratio >= 1 - CALIBRATION_TOLERANCE * 4 && ratio <= 1 + CALIBRATION_TOLERANCE * 4;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number} the arithmetic mean.
 */
function mean(a, b) {
  return (a + b) / 2;
}

/**
 * Fit the frozen frame onto the overlay without distortion, letterboxing when
 * the aspect ratios differ. A degraded capture is fitted proportionally rather
 * than cropped, so the user never sees a misaligned frame (队长要求 3).
 * @param {CaptureInfo} capture
 * @param {{ width: number, height: number }} overlay
 * @returns {{ x: number, y: number, width: number, height: number }} the frame's CSS box.
 */
export function fitCaptureToOverlay(capture, overlay) {
  const scale = calibrateCapture(capture, { overlay }).displayScale;
  return { x: 0, y: 0, width: capture.widthPx / scale, height: capture.heightPx / scale };
}

/**
 * Device pixels per OS screen pixel, preferring the bitmap/bounds ratio over
 * the host's declared `scale`.
 * @param {CaptureInfo} capture
 * @returns {number|undefined} the ratio, or undefined when the bounds are absent
 *   or unusable (a bounds object without a positive width and height).
 */
export function screenPixelRatio(capture) {
  const bounds = readRect(capture.bounds);
  if (bounds === undefined) return undefined;
  return mean(capture.widthPx / bounds.width, capture.heightPx / bounds.height);
}

/**
 * @param {number} scale
 * @returns {string} the scale as a percentage label, e.g. `125%`.
 */
export function formatScaleLabel(scale) {
  return `${Math.round(scale * 100)}%`;
}

/**
 * @param {number|undefined} bytes
 * @returns {string} a human-readable size, e.g. `2.7 MB`.
 */
export function formatBytes(bytes) {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @typedef {object} RenderPlan
 * @property {Rect} deviceRect - selection mapped to integral device pixels, clipped to the frame.
 * @property {number} scale - bitmap device pixels per overlay CSS pixel.
 * @property {number} sourceScale - extra factor applied to satisfy the edge cap.
 * @property {number} outputWidth - exported width before any size-cap fallback.
 * @property {number} outputHeight - exported height before any size-cap fallback.
 * @property {boolean} downscaled - whether the edge cap forced a reduction.
 * @property {number} logicalWidth - width at the display's logical resolution (1 device px per screen px).
 * @property {number} logicalHeight - height at the display's logical resolution.
 * @property {boolean} clipped - whether the selection reached past the frozen frame.
 * @property {boolean} valid - whether the selection is exactly what the user drew and big enough to export.
 * @property {Calibration} calibration
 */

/** Tolerance, in device pixels, for deciding that a selection reached past the frame. */
const BOUNDS_EPSILON = 1e-6;

/**
 * Plan one export: map the overlay selection into the captured frame, clip it,
 * apply the minimum-edge rule and the maximum-edge cap.
 *
 * The mapping has two terms, and both are needed for a non-maximized window
 * (DoD D-3/D-4, PRD 6.3-10): the window's own screen offset (`options.screen`,
 * which is in screen pixels, converted with `deviceScale`) plus the selection
 * scaled by `displayScale`. Passing `screen` therefore asserts that the bitmap
 * covers the virtual screen — a host that crops the bitmap to the window must
 * leave it out, exactly as a caller that fits the whole frame onto the overlay
 * (the degraded fallback) passes the fitted box as `overlay` instead.
 *
 * A selection that reaches past the frozen frame is flagged `clipped` and is
 * *not* valid even when the remaining part is big enough: what would be exported
 * is no longer what the user drew, so the overlay cancels instead of exporting a
 * silently truncated image (PRD F-09, DoD B-5).
 * @param {CaptureInfo} capture
 * @param {Rect} selectionCss - selection in overlay CSS coordinates.
 * @param {{ maxEdge?: number, minEdge?: number, overlay?: { width: number, height: number }, screen?: { x?: number, y?: number }, dpr?: number }} [options]
 *   `overlay` defaults to the host-reported CSS viewport, and any unusable
 *   overlay size falls back through {@link effectiveScale}.
 * @returns {RenderPlan} the plan; `valid` is false when the selection is unusable.
 */
export function planRender(capture, selectionCss, options = {}) {
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const minEdge = options.minEdge ?? MIN_SELECTION_EDGE;
  const overlayCss = options.overlay ?? capture.viewportCss;
  const calibration = calibrateCapture(capture, {
    ...(overlayCss === undefined ? {} : { overlay: overlayCss }),
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    ...(options.dpr === undefined ? {} : { dpr: options.dpr }),
  });
  const scale = Math.max(calibration.displayScale, Number.EPSILON);
  const offsetX = (calibration.screen.x ?? 0) * calibration.deviceScale;
  const offsetY = (calibration.screen.y ?? 0) * calibration.deviceScale;
  const requested = {
    x: selectionCss.x * scale + offsetX,
    y: selectionCss.y * scale + offsetY,
    width: selectionCss.width * scale,
    height: selectionCss.height * scale,
  };
  const deviceRect = toIntegerRect(requested, capture.widthPx, capture.heightPx);
  const clipped =
    requested.x < -BOUNDS_EPSILON ||
    requested.y < -BOUNDS_EPSILON ||
    requested.x + requested.width > capture.widthPx + BOUNDS_EPSILON ||
    requested.y + requested.height > capture.heightPx + BOUNDS_EPSILON;
  const longest = Math.max(deviceRect.width, deviceRect.height);
  const sourceScale = longest > maxEdge ? maxEdge / longest : 1;
  // The display's logical resolution: one device pixel per screen pixel, i.e.
  // the frame scaled back by `deviceScale` (队长 D-8's first downgrade step).
  const logicalScale = 1 / Math.max(calibration.deviceScale, Number.EPSILON);

  return {
    deviceRect,
    scale,
    sourceScale,
    outputWidth: Math.max(1, Math.round(deviceRect.width * sourceScale)),
    outputHeight: Math.max(1, Math.round(deviceRect.height * sourceScale)),
    downscaled: sourceScale < 1,
    logicalWidth: Math.max(1, Math.round(deviceRect.width * logicalScale)),
    logicalHeight: Math.max(1, Math.round(deviceRect.height * logicalScale)),
    clipped,
    valid: !clipped && isValidSelection(deviceRect, minEdge),
    calibration,
  };
}

/**
 * @typedef {object} SizePolicy
 * @property {number} maxEdge - largest exported edge (PRD F-23).
 * @property {number} maxBytes - size ceiling before the lossy fallback (队长 D-8).
 * @property {boolean} allowLossy - whether the WebP fallback may be used.
 * @property {boolean} allowLogicalDownscale - whether a logical-resolution pass may be used.
 */

/** Default size policy: lossless PNG under 4096 px and under 4 MB. */
export const DEFAULT_SIZE_POLICY = Object.freeze({
  maxEdge: DEFAULT_MAX_EDGE,
  maxBytes: DEFAULT_MAX_BYTES,
  allowLossy: true,
  allowLogicalDownscale: true,
});

/**
 * @param {Partial<SizePolicy>} [overrides]
 * @returns {SizePolicy} the merged policy.
 */
export function resolveSizePolicy(overrides = {}) {
  return {
    maxEdge: positive(overrides.maxEdge, DEFAULT_SIZE_POLICY.maxEdge),
    maxBytes: positive(overrides.maxBytes, DEFAULT_SIZE_POLICY.maxBytes),
    allowLossy: overrides.allowLossy ?? DEFAULT_SIZE_POLICY.allowLossy,
    allowLogicalDownscale: overrides.allowLogicalDownscale ?? DEFAULT_SIZE_POLICY.allowLogicalDownscale,
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number} the value when it is a positive finite number.
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Largest edge allowed by the size policy for a selection of this aspect ratio.
 * @param {number} width
 * @param {number} height
 * @param {number} maxEdge
 * @returns {{ width: number, height: number }} edge-capped dimensions.
 */
export function capEdges(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const factor = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}

/**
 * Build the ordered list of encode attempts for one selection.
 *
 * Tier order (队长 D-8): the lossless PNG at full resolution first; when it
 * exceeds the ceiling, the *logical* resolution pass (1 bitmap pixel per screen
 * pixel) before any lossy encode, because resolution is what actually shrinks a
 * screenshot; then WebP with decreasing quality.
 *
 * @param {RenderPlan} plan
 * @param {SizePolicy} policy
 * @returns {Array<{ id: string, labelKey: string, width: number, height: number, mediaType: string, quality?: number, sizeCapped?: boolean }>}
 *   attempts in order; the last one is the final fallback.
 */
export function sizeAttempts(plan, policy) {
  const capped = capEdges(plan.outputWidth, plan.outputHeight, policy.maxEdge);
  const attempts = [
    {
      id: 'png-full',
      labelKey: 'size.pngFull',
      width: capped.width,
      height: capped.height,
      mediaType: 'image/png',
    },
  ];
  const logical = capEdges(
    Math.min(capped.width, plan.logicalWidth),
    Math.min(capped.height, plan.logicalHeight),
    policy.maxEdge,
  );
  if (policy.allowLogicalDownscale && (logical.width < capped.width || logical.height < capped.height)) {
    attempts.push({
      id: 'png-logical',
      labelKey: 'size.pngLogical',
      width: logical.width,
      height: logical.height,
      mediaType: 'image/png',
      sizeCapped: true,
    });
  }
  if (policy.allowLossy) {
    const base = logical.width < capped.width || logical.height < capped.height ? logical : capped;
    if (base.width < capped.width || base.height < capped.height || policy.allowLossy) {
      attempts.push({
        id: 'webp-logical',
        labelKey: 'size.webpLogical',
        width: base.width,
        height: base.height,
        mediaType: 'image/webp',
        quality: WEBP_QUALITY_STEPS[0],
        sizeCapped: true,
      });
    }
    for (const quality of WEBP_QUALITY_STEPS.slice(1)) {
      attempts.push({
        id: `webp-${Math.round(quality * 100)}`,
        labelKey: 'size.webpQuality',
        width: base.width,
        height: base.height,
        mediaType: 'image/webp',
        quality,
        sizeCapped: true,
      });
    }
  }
  return attempts;
}

/**
 * Keep an overlay-space selection inside the overlay, preserving what the user
 * actually selected: a box that extends past an edge keeps the part that is on
 * screen instead of collapsing to the viewport size.
 * @param {Rect} selection
 * @param {{ width: number, height: number }} overlaySize
 * @returns {Rect} the clipped selection.
 */
export function clipSelectionToOverlay(selection, overlaySize) {
  const left = clamp(Math.min(selection.x, selection.x + selection.width), 0, overlaySize.width);
  const right = clamp(Math.max(selection.x, selection.x + selection.width), 0, overlaySize.width);
  const top = clamp(Math.min(selection.y, selection.y + selection.height), 0, overlaySize.height);
  const bottom = clamp(Math.max(selection.y, selection.y + selection.height), 0, overlaySize.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * `DSH截图_yyyyMMdd_HHmmss.png` (PRD F-22). Local time, zero-padded.
 * The second argument is either a project-name prefix or an options object, so
 * both `screenshotFileName(date, 'dsh-screenshot')` and
 * `screenshotFileName(date, { extension: 'webp' })` work.
 * @param {Date} [date] - timestamp to format.
 * @param {string|{ prefix?: string, extension?: string }} [prefixOrOptions]
 * @returns {string} the suggested file name.
 */
export function screenshotFileName(date = new Date(), prefixOrOptions = {}) {
  const options = typeof prefixOrOptions === 'string' ? { prefix: prefixOrOptions } : prefixOrOptions ?? {};
  const prefix = options.prefix ?? 'DSH截图';
  const extension = options.extension ?? 'png';
  return `${prefix}_${timestampText(date)}.${extension}`;
}

/**
 * @param {Date} date
 * @returns {string} `yyyyMMdd_HHmmss` in local time.
 */
export function timestampText(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('_');
}
