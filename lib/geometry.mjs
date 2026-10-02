/**
 * Pure geometry for the screenshot overlay: rectangle algebra, hit testing,
 * arrow-head corners, polyline decimation and selection clamping.
 *
 * Zero dependencies, no DOM, no DSH runtime. Every function is pure so the
 * module runs both inside the browser bundle and offline under `node --test`.
 *
 * Coordinate spaces used across the plugin:
 * - "CSS space": the coordinate system of `getBoundingClientRect()` and of
 *   pointer events inside the overlay. Its extent is the app viewport.
 * - "device space": the physical pixels of the captured frame, i.e. the pixels
 *   of the PNG produced by the capture backend. `scale` converts CSS → device
 *   (`device = css * scale`), and DSH's capture reports it as physical/CSS.
 */

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** Smallest accepted selection edge, in device pixels (PRD F-09). */
export const MIN_SELECTION_EDGE = 8;

/** A rectangle with no extent, used as the "no selection yet" value. */
export const EMPTY_RECT = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

/** Longest exported edge, in device pixels (PRD F-23). */
export const MAX_EXPORT_EDGE = 4096;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number} `value` clamped into `[min, max]`; `min` wins if max < min.
 */
export function clamp(value, min, max) {
  if (min > max) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * @param {number} value
 * @returns {boolean} whether `value` is a usable finite number.
 */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Build a rectangle from two opposite corners in any order.
 *
 * A drag that never moved carries no selection of its own, so it canonicalizes
 * to {@link EMPTY_RECT} — the module's "nothing selected yet" value, which is
 * what callers compare against (same convention as `boundsOfPoints([])` in the
 * annotation layer). A drag with extent on one axis only keeps its position.
 * @param {Point} a
 * @param {Point} b
 * @returns {Rect} normalized (non-negative width/height) rectangle.
 */
export function rectFromCorners(a, b) {
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width === 0 && height === 0) return { ...EMPTY_RECT };
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height };
}

/**
 * @param {Rect} rect
 * @returns {Rect} the same rectangle with non-negative width/height.
 */
export function normalizeRect(rect) {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/**
 * @param {Rect} rect
 * @returns {boolean} whether the rectangle has a strictly positive area.
 */
export function hasPositiveArea(rect) {
  return rect.width > 0 && rect.height > 0;
}

/**
 * Whether a rectangle encloses at least one point.
 * @param {Rect} rect
 * @returns {boolean} whether the rectangle contains its top-left point.
 */
export function containsPoint(rect, point) {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

/**
 * Map a rectangle between CSS space and device space.
 * @param {Rect} rect - rectangle in the source space.
 * @param {number} scale - device pixels per CSS pixel (must be positive).
 * @returns {Rect} the rectangle in the destination space.
 */
export function scaleRect(rect, scale) {
  if (!isFiniteNumber(scale) || scale <= 0) throw new RangeError('scaleRect: scale must be a positive finite number');
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * Whether a selection is large enough to be worth exporting.
 * The threshold is applied in device pixels, so a selection that is 8 CSS
 * pixels wide on a 100% display is valid while the same selection on a 50%
 * display is not: the exported image is what matters, not the on-screen box.
 * @param {Rect} rect - selection in device space.
 * @param {number} [minEdge] - smallest allowed width and height, in device pixels.
 * @returns {boolean} whether both edges reach the threshold.
 */
export function isValidSelection(rect, minEdge = MIN_SELECTION_EDGE) {
  return rect.width >= minEdge && rect.height >= minEdge;
}

/**
 * Round outward to whole device pixels so a fractional scale never crops or
 * pads the exported frame, then clip to the frame.
 * @param {Rect} rect - selection in device space.
 * @param {number} frameWidth - device width of the captured frame.
 * @param {number} frameHeight - device height of the captured frame.
 * @returns {Rect} integral rectangle fully inside the frame.
 */
export function toIntegerRect(rect, frameWidth, frameHeight) {
  const x0 = clamp(Math.floor(rect.x), 0, frameWidth);
  const y0 = clamp(Math.floor(rect.y), 0, frameHeight);
  const x1 = clamp(Math.ceil(rect.x + rect.width), 0, frameWidth);
  const y1 = clamp(Math.ceil(rect.y + rect.height), 0, frameHeight);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * Keep a rectangle inside a frame without changing its size.
 * @param {Rect} rect
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @returns {Rect} translated rectangle; the size is preserved unless it exceeds the frame.
 */
export function clampRectToFrame(rect, frameWidth, frameHeight) {
  const width = Math.min(rect.width, frameWidth);
  const height = Math.min(rect.height, frameHeight);
  return {
    x: clamp(rect.x, 0, frameWidth - width),
    y: clamp(rect.y, 0, frameHeight - height),
    width,
    height,
  };
}

/**
 * Resize a rectangle by dragging one handle, keeping the opposite edge fixed,
 * then clip the result to the frame. Handles are named by the edges they move.
 *
 * The dragged edge lands on the pointer; dragging it past the opposite edge
 * mirrors the rectangle instead of collapsing it, so the opposite edge keeps
 * its position and the pointer stays on the side the user dragged towards.
 * @param {Rect} rect - starting rectangle (CSS or device space, consistently).
 * @param {string} handle - one of `n`, `s`, `w`, `e`, `nw`, `ne`, `sw`, `se`.
 * @param {Point} point - current pointer position in the same space.
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @returns {Rect} resized, clipped rectangle.
 */
export function resizeRect(rect, handle, point, frameWidth, frameHeight) {
  const north = handle.includes('n');
  const south = handle.includes('s');
  const west = handle.includes('w');
  const east = handle.includes('e');
  if (!north && !south && !west && !east) return clampRectToFrame(rect, frameWidth, frameHeight);

  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  const nextLeft = west ? clamp(point.x, 0, frameWidth) : left;
  const nextRight = east ? clamp(point.x, 0, frameWidth) : right;
  const nextTop = north ? clamp(point.y, 0, frameHeight) : top;
  const nextBottom = south ? clamp(point.y, 0, frameHeight) : bottom;

  return {
    x: Math.min(nextLeft, nextRight),
    y: Math.min(nextTop, nextBottom),
    width: Math.abs(nextRight - nextLeft),
    height: Math.abs(nextBottom - nextTop),
  };
}

/**
 * Which resize handle a point grabs, if any. Corners win over edges so a
 * corner grab still resizes both axes near the intersection.
 * @param {Rect} rect
 * @param {Point} point
 * @param {number} tolerance - grab distance in the rectangle's own space.
 * @returns {string|null} the handle name, or null when the point grabs nothing.
 */
export function hitHandle(rect, point, tolerance) {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const nearLeft = Math.abs(point.x - left) <= tolerance;
  const nearRight = Math.abs(point.x - right) <= tolerance;
  const nearTop = Math.abs(point.y - top) <= tolerance;
  const nearBottom = Math.abs(point.y - bottom) <= tolerance;
  const withinX = point.x >= left - tolerance && point.x <= right + tolerance;
  const withinY = point.y >= top - tolerance && point.y <= bottom + tolerance;
  if (!withinX || !withinY) return null;

  const vertical = nearTop ? 'n' : nearBottom ? 's' : '';
  const horizontal = nearLeft ? 'w' : nearRight ? 'e' : '';
  if (vertical !== '' && horizontal !== '') return `${vertical}${horizontal}`;
  if (vertical !== '') return withinX ? vertical : null;
  if (horizontal !== '') return withinY ? horizontal : null;
  return null;
}

/** Every resize handle of a rectangle, for rendering the eight grab dots. */
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * @param {Rect} rect
 * @returns {Point} the centre of a handle, keyed by {@link HANDLES} names.
 */
export function handlePoint(rect, handle) {
  const x = handle.includes('w')
    ? rect.x
    : handle.includes('e')
      ? rect.x + rect.width
      : rect.x + rect.width / 2;
  const y = handle.includes('n')
    ? rect.y
    : handle.includes('s')
      ? rect.y + rect.height
      : rect.y + rect.height / 2;
  return { x, y };
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {string} the CSS cursor for a handle.
 */
export function cursorForHandle(x) {
  switch (x) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    default:
      return 'default';
  }
}

/**
 * Distance from a point to a line segment.
 * @param {Point} point
 * @param {Point} a
 * @param {Point} b
 * @returns {number} the perpendicular distance.
 */
export function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Append a pointer sample to a polyline, dropping samples closer than
 * `minDistance` to the previous one. Keeps long strokes cheap without visible
 * stair-stepping.
 * @param {readonly Point[]} points - existing polyline.
 * @param {Point} point - new sample.
 * @param {number} [minDistance] - minimum spacing, in the polyline's space.
 * @returns {readonly Point[]} the original array, or a new one when the sample was kept.
 */
export function appendPoint(points, point, minDistance = 1.5) {
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return points;
  const last = points[points.length - 1];
  if (last !== undefined && Math.hypot(point.x - last.x, point.y - last.y) < minDistance) return points;
  return [...points, { x: point.x, y: point.y }];
}

/**
 * The four corners of an arrow head at `to`, pointing away from `from`.
 * @param {Point} from
 * @param {Point} to
 * @param {number} length - head length along the shaft.
 * @param {number} width - full width of the head at its base.
 * @returns {Point[]} `[left, tip, right]` in path order.
 */
export function arrowHead(from, to, length, width) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return [to, to, to];
  const ux = dx / distance;
  const uy = dy / distance;
  const baseX = to.x - ux * length;
  const baseY = to.y - uy * length;
  const half = width / 2;
  return [
    { x: baseX - uy * half, y: baseY + ux * half },
    { x: to.x, y: to.y },
    { x: baseX + uy * half, y: baseY - ux * half },
  ];
}

/**
 * Stroke-width-aware head size: short arrows keep a proportional head instead
 * of degenerating into a triangle.
 * @param {Point} from
 * @param {Point} to
 * @param {number} lineWidth
 * @returns {{ length: number, width: number }} head dimensions.
 */
export function arrowHeadSize(from, to, lineWidth) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const wanted = Math.max(10, lineWidth * 4.5);
  const length = Math.min(wanted, Math.max(4, distance * 0.6));
  return { length, width: length * 0.78 };
}

/**
 * Round rectangle used as a canvas path (not a fill/stroke call), so callers
 * can pair it with their own style.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} rect
 * @param {number} radius
 * @returns {void}
 */
export function roundRectPath(ctx, rect, radius) {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  const { x, y, width, height } = rect;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
