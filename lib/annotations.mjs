/**
 * The six annotation tools and their canvas rendering (PRD F-11 … F-18).
 *
 * Every annotation is a plain JSON value in *device* pixel space — the space of
 * the exported PNG — so drawing is deterministic and independent of the display
 * scale, and the exported image is pixel-exact instead of a re-render of a
 * screen-space approximation.
 *
 * Rendering is expressed as canvas calls against the caller's context. That is
 * what makes the module testable offline: `node --test` drives a recording stub
 * context and asserts the calls, with no canvas implementation required.
 *
 * Only the annotation's own artwork carries literal colours (PRD 6.3 / official
 * `practices.md` rule 34): a red rectangle must stay red in both themes. Every
 * control surface around it uses `--dsw-alias-*` tokens.
 */
import { arrowHead, arrowHeadSize, clamp, EMPTY_RECT, handlePoint, normalizeRect, roundRectPath } from './geometry.mjs';

/** The six tools, in toolbar order. `rect` is the default (PRD F-18). */
export const TOOL_IDS = Object.freeze(['rect', 'ellipse', 'arrow', 'pen', 'mosaic', 'text']);

/** Tool kinds, including the internal `move` mode used for drag-to-relocate. */
export const TOOL_MOVE = 'move';

/** Fixed stroke widths, in device pixels (PRD F-18 细/中/粗). */
export const LINE_WIDTHS = Object.freeze({ thin: 3, medium: 6, thick: 10 });

/** `LINE_WIDTHS` keys in toolbar order. */
export const LINE_WIDTH_ORDER = Object.freeze(['thin', 'medium', 'thick']);

/** Text sizes, in device pixels (PRD F-16 支持字号). */
export const TEXT_SIZES = Object.freeze({ small: 22, medium: 32, large: 46 });

/** `TEXT_SIZES` keys in toolbar order. */
export const TEXT_SIZE_ORDER = Object.freeze(['small', 'medium', 'large']);

/**
 * Annotation palette (PRD F-18 红/黄/绿/蓝/黑/白). `labelKey` resolves through
 * the Client locale service, so the swatch tooltips follow DSH's language.
 */
export const COLORS = Object.freeze([
  Object.freeze({ id: 'red', value: '#e5484d', labelKey: 'color.red' }),
  Object.freeze({ id: 'yellow', value: '#f5a524', labelKey: 'color.yellow' }),
  Object.freeze({ id: 'green', value: '#30a46c', labelKey: 'color.green' }),
  Object.freeze({ id: 'blue', value: '#3b82f6', labelKey: 'color.blue' }),
  Object.freeze({ id: 'black', value: '#111111', labelKey: 'color.black' }),
  Object.freeze({ id: 'white', value: '#ffffff', labelKey: 'color.white' }),
]);

/** Default style: red thin line (PRD F-18). */
export const DEFAULT_STYLE = Object.freeze({ color: '#e5484d', widthKey: 'thin' });

/**
 * Mosaic cell size, in device pixels, for one intensity step.
 * @param {number} step - 0-based intensity from 0 (finest) to 4 (coarsest).
 * @returns {number} cell size in device pixels.
 */
export function mosaicCellSize(step) {
  const clamped = clamp(Math.round(step), 0, 4);
  return 6 + clamped * 10;
}

/** Mosaic intensity labels for the settings hint (PRD F-05 马赛克强度). */
export const MOSAIC_STEPS = Object.freeze([0, 1, 2, 3, 4]);

/**
 * @param {string} widthKey
 * @returns {number} line width in device pixels.
 */
export function lineWidthOf(widthKey) {
  return LINE_WIDTHS[widthKey] ?? LINE_WIDTHS.medium;
}

/**
 * @param {string} sizeKey
 * @returns {number} text size in device pixels.
 */
export function textSizeOf(sizeKey) {
  return TEXT_SIZES[sizeKey] ?? TEXT_SIZES.medium;
}

/**
 * @param {string} colorId
 * @returns {string} the hex colour for a palette id, or the default red.
 */
export function colorValueOf(colorId) {
  return COLORS.find((entry) => entry.id === colorId)?.value ?? DEFAULT_STYLE.color;
}

/**
 * Create a rectangle/ellipse/arrow annotation in device space.
 * Exactly one of `to` and `rect` is required; `rect` carries finalized shapes.
 * @param {{ tool: string, color: string, widthKey?: string, from?: {x:number,y:number}, to?: {x:number,y:number}, rect?: {x:number,y:number,width:number,height:number} }} input
 * @returns {object} the annotation value.
 */
export function createShape(input) {
  const widthKey = input.widthKey ?? DEFAULT_STYLE.widthKey;
  const rect = input.rect ?? rectOf(input.from, input.to);
  return {
    tool: input.tool,
    color: input.color,
    widthKey,
    rect,
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
  };
}

/**
 * @param {{x:number,y:number}} [from]
 * @param {{x:number,y:number}} [to]
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function rectOf(from, to) {
  const a = from ?? { x: 0, y: 0 };
  const b = to ?? a;
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * Create a freehand stroke annotation. The caller owns `points`; it is stored
 * as given so an in-progress stroke can be replaced wholesale on each sample.
 * @param {{ tool: string, color: string, widthKey?: string, points: readonly {x:number,y:number}[] }} input
 * @returns {object} the annotation value.
 */
export function createStroke(input) {
  return {
    tool: input.tool,
    color: input.color,
    widthKey: input.widthKey ?? DEFAULT_STYLE.widthKey,
    points: input.points,
    rect: boundsOfPoints(input.points),
  };
}

/**
 * @param {readonly {x:number,y:number}[]} points
 * @returns {{x:number,y:number,width:number,height:number}} the bounding rectangle.
 */
export function boundsOfPoints(points) {
  if (points.length === 0) return { ...EMPTY_RECT };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Create a text annotation.
 * @param {{ text: string, color: string, x: number, y: number, sizeKey?: string }} input
 * @returns {object} the annotation value.
 */
export function createText(input) {
  return {
    tool: 'text',
    text: input.text,
    color: input.color,
    sizeKey: input.sizeKey ?? 'medium',
    x: input.x,
    y: input.y,
    rect: { x: input.x, y: input.y, width: 0, height: 0 },
  };
}

/**
 * Translate an annotation by a delta, returning a new value.
 * @param {object} annotation
 * @param {number} dx
 * @param {number} dy
 * @returns {object} the moved annotation.
 */
export function translateAnnotation(annotation, dx, dy) {
  if (dx === 0 && dy === 0) return annotation;
  if (annotation.tool === 'pen') {
    const points = annotation.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
    return { ...annotation, points, rect: boundsOfPoints(points) };
  }
  if (annotation.tool === 'text') {
    return {
      ...annotation,
      x: annotation.x + dx,
      y: annotation.y + dy,
      rect: { ...annotation.rect, x: annotation.rect.x + dx, y: annotation.rect.y + dy },
    };
  }
  return {
    ...annotation,
    rect: { ...annotation.rect, x: annotation.rect.x + dx, y: annotation.rect.y + dy },
    ...(annotation.from === undefined ? {} : { from: { x: annotation.from.x + dx, y: annotation.from.y + dy } }),
    ...(annotation.to === undefined ? {} : { to: { x: annotation.to.x + dx, y: annotation.to.y + dy } }),
  };
}

/**
 * Reset a text annotation's edit-time geometry after its content changed.
 * @param {object} annotation
 * @param {{ width: number, height: number }} size - measured text box in device pixels.
 * @returns {object} the annotation with an up-to-date rectangle.
 */
export function withTextMetrics(annotation, size) {
  return {
    ...annotation,
    rect: { x: annotation.x, y: annotation.y, width: size.width, height: size.height },
  };
}

/**
 * Draw one annotation onto a canvas context.
 *
 * @param {CanvasRenderingContext2D} ctx - target context, already translated so
 *   that device coordinates land on the right pixels.
 * @param {object} annotation - annotation value from {@link createShape} and friends.
 * @param {{ mosaicSource?: CanvasImageSource, mosaicSourceRect?: {x:number,y:number,width:number,height:number}, createScratch?: (width:number, height:number) => (CanvasRenderingContext2D|null), mosaicStep?: number }} [environment]
 *   backend services the draw needs: the frozen frame for mosaic sampling, and a
 *   scratch-surface factory for the mosaic passes. The factory owns allocation
 *   and may hand back a reused surface — the mosaic holds it only for the
 *   duration of the call, and asks for two surfaces per draw (the second one
 *   annotation-sized).
 * @returns {boolean} whether the annotation drew anything.
 */
export function drawAnnotation(ctx, annotation, environment = {}) {
  switch (annotation.tool) {
    case 'rect':
      return drawRect(ctx, annotation);
    case 'ellipse':
      return drawEllipse(ctx, annotation);
    case 'arrow':
      return drawArrow(ctx, annotation);
    case 'pen':
      return drawPen(ctx, annotation);
    case 'mosaic':
      return drawMosaic(ctx, annotation, environment);
    case 'text':
      return drawText(ctx, annotation);
    default:
      return false;
  }
}

/**
 * The annotation's stroke path, shared by the live preview and the export.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} annotation
 * @returns {void}
 */
function strokeStyle(ctx, annotation) {
  ctx.lineWidth = lineWidthOf(annotation.widthKey);
  ctx.strokeStyle = annotation.color;
}

/** @param {CanvasRenderingContext2D} ctx @param {object} annotation @returns {boolean} */
function drawRect(ctx, annotation) {
  const { rect } = annotation;
  if (rect.width <= 0 || rect.height <= 0) return false;
  strokeStyle(ctx, annotation);
  const inset = ctx.lineWidth / 2;
  ctx.beginPath();
  ctx.rect(rect.x + inset, rect.y + inset, Math.max(0, rect.width - ctx.lineWidth), Math.max(0, rect.height - ctx.lineWidth));
  ctx.stroke();
  return true;
}

/** @param {CanvasRenderingContext2D} ctx @param {object} annotation @returns {boolean} */
function drawEllipse(ctx, annotation) {
  const { rect } = annotation;
  if (rect.width <= 0 || rect.height <= 0) return false;
  strokeStyle(ctx, annotation);
  const inset = ctx.lineWidth / 2;
  ctx.beginPath();
  ctx.ellipse(
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    Math.max(0, rect.width / 2 - inset),
    Math.max(0, rect.height / 2 - inset),
    0,
    0,
    Math.PI * 2,
  );
  ctx.stroke();
  return true;
}

/** @param {CanvasRenderingContext2D} ctx @param {object} annotation @returns {boolean} */
function drawArrow(ctx, annotation) {
  const from = annotation.from ?? { x: annotation.rect.x, y: annotation.rect.y };
  const to = annotation.to ?? { x: annotation.rect.x + annotation.rect.width, y: annotation.rect.y + annotation.rect.height };
  if (from.x === to.x && from.y === to.y) return false;
  const width = lineWidthOf(annotation.widthKey);
  const head = arrowHeadSize(from, to, width);
  const corners = arrowHead(from, to, head.length, head.width);
  ctx.lineWidth = width;
  ctx.strokeStyle = annotation.color;
  ctx.fillStyle = annotation.color;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  // Stop the shaft at the head's base so the joint stays clean at every width.
  const base = corners[0];
  const base2 = corners[2];
  ctx.lineTo((base.x + base2.x) / 2, (base.y + base2.y) / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.closePath();
  ctx.fill();
  ctx.lineCap = 'round';
  return true;
}

/** @param {CanvasRenderingContext2D} ctx @param {object} annotation @returns {boolean} */
function drawPen(ctx, annotation) {
  const points = annotation.points;
  if (points.length === 0) return false;
  ctx.lineWidth = lineWidthOf(annotation.widthKey);
  ctx.strokeStyle = annotation.color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (points.length === 1) {
    // A single tap still leaves a visible dot.
    const dot = points[0];
    ctx.moveTo(dot.x, dot.y);
    ctx.lineTo(dot.x + 0.01, dot.y);
  } else {
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const midX = (previous.x + current.x) / 2;
      const midY = (previous.y + current.y) / 2;
      ctx.quadraticCurveTo(previous.x, previous.y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
  return true;
}

/**
 * Mosaic / blur redaction (PRD F-15).
 *
 * Two passes make the redaction hold up under the acceptance test "the original
 * content is no longer readable" (DoD B-6):
 *
 * 1. a box-downscale onto the cell grid with smoothing **on**, so every cell
 *    holds the average of the source pixels it covers — no source pixel is
 *    carried over verbatim;
 * 2. an enlargement of that grid back to the annotation box with smoothing
 *    **off**, so the result is a hard-edged mosaic instead of a blur that could
 *    still leak the original shapes.
 *
 * The second pass runs on a scratch surface that shares the target's coordinate
 * system (the annotation is painted at its real position and then copied 1:1),
 * which keeps the pixelated fill inside the annotation box.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} annotation
 * @param {{ mosaicSource?: CanvasImageSource, mosaicSourceRect?: {x:number,y:number,width:number,height:number}, createScratch?: (width:number, height:number) => (CanvasRenderingContext2D|null), mosaicStep?: number }} environment
 * @returns {boolean}
 */
function drawMosaic(ctx, annotation, environment) {
  const { rect } = annotation;
  if (rect.width <= 0 || rect.height <= 0) return false;
  const source = environment.mosaicSource;
  const sourceRect = environment.mosaicSourceRect;
  const createScratch = environment.createScratch;
  if (source === undefined || sourceRect === undefined || createScratch === undefined) return false;

  const cell = mosaicCellSize(environment.mosaicStep ?? 2);
  const cellsX = Math.max(1, Math.round(rect.width / cell));
  const cellsY = Math.max(1, Math.round(rect.height / cell));

  // Pass 1 — average the source pixels down onto the cell grid.
  const down = createScratch(cellsX, cellsY);
  if (down === null) return false;
  down.imageSmoothingEnabled = true;
  down.clearRect(0, 0, cellsX, cellsY);
  down.drawImage(
    source,
    sourceRect.x + rect.x,
    sourceRect.y + rect.y,
    rect.width,
    rect.height,
    0,
    0,
    cellsX,
    cellsY,
  );

  // Pass 2 — blow the cell grid back up with nearest-neighbour sampling, in the
  // target's own coordinates so the result lands exactly on the annotation box.
  const stagingWidth = Math.max(1, Math.ceil(rect.x + rect.width));
  const stagingHeight = Math.max(1, Math.ceil(rect.y + rect.height));
  const staging = createScratch(stagingWidth, stagingHeight);
  if (staging === null) return false;
  staging.imageSmoothingEnabled = false;
  staging.clearRect(0, 0, stagingWidth, stagingHeight);
  staging.drawImage(down.canvas, 0, 0, cellsX, cellsY, rect.x, rect.y, rect.width, rect.height);

  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(staging.canvas, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
  ctx.imageSmoothingEnabled = smoothing === undefined ? true : smoothing;
  return true;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} annotation
 * @returns {boolean}
 */
/**
 * Effective text size of an annotation, in device pixels.
 *
 * A freshly created text follows its `sizeKey` tier; once the user scales a placed
 * annotation it carries a continuous `sizePx` (t22), which then wins.
 * @param {object} annotation
 * @returns {number} font size in device pixels.
 */
export function textSizeOfAnnotation(annotation) {
  const size = annotation.sizePx;
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) return size;
  return textSizeOf(annotation.sizeKey);
}

function drawText(ctx, annotation) {
  const text = annotation.text;
  if (typeof text !== 'string' || text === '') return false;
  const size = textSizeOfAnnotation(annotation);
  ctx.font = `${size}px "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const metrics = ctx.measureText(text);
  const padding = Math.round(size * 0.25);
  const box = {
    x: annotation.x,
    y: annotation.y,
    width: metrics.width + padding * 2,
    height: size * 1.25 + padding * 2,
  };
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  roundRectPath(ctx, box, Math.round(size * 0.28));
  ctx.fill();
  ctx.fillStyle = annotation.color;
  ctx.fillText(text, box.x + padding, box.y + padding + size * 0.08);
  return true;
}

/**
 * Measure the text box a {@link createText} annotation will occupy, so the
 * stored rectangle matches what the export draws.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} annotation
 * @returns {{ width: number, height: number }} box size in device pixels.
 */
export function measureTextAnnotation(ctx, annotation) {
  const size = textSizeOfAnnotation(annotation);
  ctx.font = `${size}px "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const metrics = ctx.measureText(annotation.text ?? '');
  const padding = Math.round(size * 0.25);
  return { width: metrics.width + padding * 2, height: size * 1.25 + padding * 2 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing an already-placed annotation (t22): hit testing, corner scaling,
// translated-with-clamping moves. Still pure value algebra: the client owns the
// pointer, the history and the canvas.
// ─────────────────────────────────────────────────────────────────────────────

/** Smallest edge a placed annotation may be scaled down to, in device pixels. */
export const MIN_ANNOTATION_EDGE = 8;

/** Hit tolerance around an annotation's bounds, in device pixels (细笔画也点得中). */
export const HIT_TOLERANCE = 4;

/** Corner handles only: an annotation scales from a corner, the opposite one stays. */
export const CORNER_HANDLES = Object.freeze(['nw', 'ne', 'se', 'sw']);

/** Smallest font size a scaled text may shrink to, in device pixels. */
export const MIN_TEXT_PX = 10;

/**
 * @param {string} handle
 * @returns {string} the corner diagonally opposite to `handle`.
 */
function oppositeCorner(handle) {
  if (handle === 'nw') return 'se';
  if (handle === 'ne') return 'sw';
  if (handle === 'se') return 'nw';
  return 'ne';
}

/**
 * The axis-aligned rectangle a placed annotation occupies, in device pixels.
 * Shapes/text/mosaic carry `rect`; a stroke's rectangle is its point bounds.
 * @param {object} annotation
 * @returns {Rect} normalized rectangle (never negative width/height).
 */
export function annotationRect(annotation) {
  if (annotation === null || annotation === undefined) return { ...EMPTY_RECT };
  const rect = normalizeRect(annotation.rect ?? EMPTY_RECT);
  if (rect.width > 0 || rect.height > 0) return rect;
  if (Array.isArray(annotation.points) && annotation.points.length > 0) return boundsOfPoints(annotation.points);
  return rect;
}

/**
 * Whether a device-space point selects the annotation.
 * @param {object} annotation
 * @param {Point} point
 * @param {number} [tolerance] - outward padding in device pixels.
 * @returns {boolean}
 */
export function hitAnnotation(annotation, point, tolerance = HIT_TOLERANCE) {
  const rect = annotationRect(annotation);
  const pad = typeof tolerance === 'number' && tolerance >= 0 ? tolerance : 0;
  return point.x >= rect.x - pad
    && point.x <= rect.x + rect.width + pad
    && point.y >= rect.y - pad
    && point.y <= rect.y + rect.height + pad;
}

/**
 * Index of the topmost annotation under a point (the last one drawn wins).
 * @param {readonly object[]} annotations
 * @param {Point} point
 * @param {number} [tolerance]
 * @returns {number} index, or -1 when nothing is hit.
 */
export function findAnnotationAt(annotations, point, tolerance = HIT_TOLERANCE) {
  if (!Array.isArray(annotations)) return -1;
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    if (hitAnnotation(annotations[index], point, tolerance)) return index;
  }
  return -1;
}

/**
 * The four corner handles of a selection box.
 * @param {Rect} rect
 * @returns {Array<{ id: string, x: number, y: number }>} handles in `CORNER_HANDLES` order.
 */
export function annotationHandles(rect) {
  const box = normalizeRect(rect);
  return CORNER_HANDLES.map((id) => {
    const point = handlePoint(box, id);
    return { id, x: point.x, y: point.y };
  });
}

/**
 * Which corner handle a point grabs.
 * @param {Rect} rect
 * @param {Point} point
 * @param {number} [tolerance]
 * @returns {string|null} handle id or null.
 */
export function hitAnnotationHandle(rect, point, tolerance = HIT_TOLERANCE * 2) {
  const box = normalizeRect(rect);
  for (const id of CORNER_HANDLES) {
    const corner = handlePoint(box, id);
    if (Math.abs(point.x - corner.x) <= tolerance && Math.abs(point.y - corner.y) <= tolerance) return id;
  }
  return null;
}

/**
 * Scale a rectangle by dragging a corner: the opposite corner stays put, the
 * pointer drives a uniform ratio, and the result never shrinks below
 * {@link MIN_ANNOTATION_EDGE} on either edge (so a scaled-down annotation stays
 * visible and selectable instead of collapsing to zero).
 * @param {Rect} rect
 * @param {string} handle - one of {@link CORNER_HANDLES}.
 * @param {Point} point - pointer position in device pixels.
 * @param {number} [minEdge]
 * @returns {Rect} the scaled rectangle.
 */
export function resizeAnnotationRect(rect, handle, point, minEdge = MIN_ANNOTATION_EDGE) {
  const box = normalizeRect(rect);
  if (!CORNER_HANDLES.includes(handle)) return box;
  const edge = typeof minEdge === 'number' && minEdge > 0 ? minEdge : MIN_ANNOTATION_EDGE;
  const anchor = handlePoint(box, oppositeCorner(handle));
  const baseWidth = Math.max(box.width, edge);
  const baseHeight = Math.max(box.height, edge);
  const wanted = Math.max(
    Math.abs(point.x - anchor.x) / baseWidth,
    Math.abs(point.y - anchor.y) / baseHeight,
  );
  const floor = Math.max(edge / baseWidth, edge / baseHeight);
  const scale = Math.max(wanted, floor);
  const width = baseWidth * scale;
  const height = baseHeight * scale;
  return {
    x: handle.includes('w') ? anchor.x - width : anchor.x,
    y: handle.includes('n') ? anchor.y - height : anchor.y,
    width,
    height,
  };
}

/**
 * Translate-only clamp: keep the rectangle's size and push it inside `bounds`
 * (it only shrinks when it is larger than the bounds themselves).
 * @param {Rect} rect
 * @param {Rect} bounds
 * @returns {Rect} the clamped rectangle.
 */
export function clampAnnotationRect(rect, bounds) {
  const box = normalizeRect(rect);
  const area = normalizeRect(bounds);
  const width = Math.min(box.width, area.width);
  const height = Math.min(box.height, area.height);
  return {
    x: clamp(box.x, area.x, area.x + Math.max(0, area.width - width)),
    y: clamp(box.y, area.y, area.y + Math.max(0, area.height - height)),
    width,
    height,
  };
}

/**
 * Move a placed annotation by a delta, clamped so it stays inside `bounds`
 * (a moved annotation must not leave the screenshot area, or the export loses it).
 * @param {object} annotation
 * @param {number} dx
 * @param {number} dy
 * @param {Rect} bounds - the screenshot selection in device pixels.
 * @returns {object} the moved annotation.
 */
export function moveAnnotation(annotation, dx, dy, bounds) {
  const from = annotationRect(annotation);
  const target = clampAnnotationRect({ ...from, x: from.x + dx, y: from.y + dy }, bounds);
  return translateAnnotation(annotation, target.x - from.x, target.y - from.y);
}

/**
 * Re-fit a placed annotation into `nextRect`: shapes remap `rect`/`from`/`to`,
 * strokes remap every point (and recompute their bounds), mosaic remaps its
 * rectangle, and text follows continuously through `sizePx` (floored at
 * {@link MIN_TEXT_PX}) while its anchor moves with the box.
 * @param {object} annotation
 * @param {Rect} nextRect
 * @returns {object} the scaled annotation.
 */
export function scaleAnnotation(annotation, nextRect) {
  const from = annotationRect(annotation);
  const to = normalizeRect(nextRect);
  const scaleX = from.width > 0 ? to.width / from.width : 1;
  const scaleY = from.height > 0 ? to.height / from.height : 1;
  const map = (point) => ({ x: to.x + (point.x - from.x) * scaleX, y: to.y + (point.y - from.y) * scaleY });
  if (annotation.tool === 'pen') {
    const points = (annotation.points ?? []).map(map);
    return { ...annotation, points, rect: boundsOfPoints(points) };
  }
  if (annotation.tool === 'text') {
    const shrink = Math.min(scaleX, scaleY);
    const size = Math.max(MIN_TEXT_PX, textSizeOfAnnotation(annotation) * shrink);
    const origin = map({ x: annotation.x ?? from.x, y: annotation.y ?? from.y });
    return {
      ...annotation,
      sizePx: size,
      sizeKey: closestTextSizeKey(size),
      x: origin.x,
      y: origin.y,
      rect: to,
    };
  }
  return {
    ...annotation,
    rect: to,
    ...(annotation.from === undefined ? {} : { from: map(annotation.from) }),
    ...(annotation.to === undefined ? {} : { to: map(annotation.to) }),
  };
}

/**
 * @param {number} size - target font size in device pixels.
 * @returns {string} the closest tier key of {@link TEXT_SIZES}.
 */
export function closestTextSizeKey(size) {
  let best = TEXT_SIZE_ORDER[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of TEXT_SIZE_ORDER) {
    const distance = Math.abs(TEXT_SIZES[key] - size);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return best;
}
