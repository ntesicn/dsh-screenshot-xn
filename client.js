/**
 * dsh-screenshot-xn —— DSH 截图插件客户端半（Client half）
 * ============================================================================
 * 形式（DoD A-4 / t1 §5 冻结）：本文件首条有效语句是 window.__ModuleLoader__.load({...})，
 * id 等于包名 dsh-screenshot-xn；React 从浏览器模块表 require('react') 取得，不安装第二份 React。
 *
 * 纯逻辑单一真相（t1 §5 DECISIONS 冻结：运行时动态 import 同源 ESM 无证据 → 单文件 + 构建期内联）
 * ----------------------------------------------------------------------------
 * 本文件中间的「INLINE LIB」段由构建期从 lib/*.mjs 生成，规则只有两条：
 *   1. 删除 `import ... from './x.mjs';` 行（依赖已在同一段内定义，顺序见下）；
 *   2. 去掉顶层 `export ` 关键字（`export function` → `function`，`export const` → `const`）。
 * 其余字符（函数体、JSDoc、空行）与 lib 源文件逐字一致 —— client.js 里不存在第二份手抄实现。
 * 源文件与拼接顺序：lib/geometry.mjs → lib/capture-plan.mjs → lib/annotations.mjs
 *                  → lib/history.mjs → lib/output.mjs
 * 复核方式（verifier 抽查用）：按下面每段的 BEGIN/END 标记切出该段，对 lib 源文件做上述两条
 * 替换后逐字比对；段内函数体、参数、常量值都必须与 lib 完全一致。
 *
 * 官方 UI 约束（practices.md 34-36 / DoD D-11）
 * ----------------------------------------------------------------------------
 * - 只 require 官方模块表里的 specifier（本文件只有 'react'）；不 require 任何
 *   @deepseek-ai/dsh-client-* 包。
 * - 不向 document.body 追加节点、不替换 app root：全部节点都渲染在宿主槽位条目内部。
 * - 样式只用 --dsw-alias-* 主题令牌（t1 §3 清单）。全文件仅有的颜色字面量在 INLINE 段的
 *   标注图形里（COLORS 调色板、drawText 的文字底板，t1 §3 明确允许「标注图形本身」硬编码色）。
 * - 可见文案直接用中英双语字符串（本轮不依赖未核实的 locale 服务）。
 *
 * 扩展点（t1 §7.4 冻结，逐字）
 * ----------------------------------------------------------------------------
 * - 按钮：conversation.input.right（list），{ name, id: 'dsh-screenshot.button', order: 50 }
 * - 覆盖层：shell.overlay（list / scope=root），{ name, id: 'dsh-screenshot.overlay', order: 100 }
 *   覆盖层根元素自设 pointer-events:auto（该层默认 click-through，条目必须自己 opt-in）。
 * - 抓屏：同源 fetch '/api/dsh-screenshot/capture'（宿主 webServer 注册，t1 §7.2），
 *   度量取自响应头 X-DSH-Screenshot（base64url JSON）。
 * - 插入对话（默认动作）：**经官方 paste intake 桥接** —— 构造 ClipboardEvent('paste')
 *   （DataTransfer 里放一张 PNG File）派发到输入框的 contenteditable，复用与「用户自己 Ctrl+V
 *   粘贴图片」完全相同的代码路径（conversation 的 paste 命令 → intakeFiles → createDrafts →
 *   输入框上方出现附件缩略图）。成功判据是硬的：useInput(s => s.attachmentIds) 的长度在 1.5s
 *   确认窗口内增加；无增量或拿不到该信号则退回「复制到剪贴板 + 可见提示 Ctrl+V」（B-12，绝不静默失败）。
 *
 * 性能与资源（PRD §4 / DoD D-2 / D-7 / D-9）
 * ----------------------------------------------------------------------------
 * - 冻结帧只画一次（覆盖层打开时画进 canvas），之后移动鼠标不再重绘底图 → B-2「冻结画面」。
 * - 标注层用 requestAnimationFrame 节流；马赛克临时画布由池复用（不每次分配 4K 画布），
 *   卸载时释放；选区装饰走 DOM 直接定位，避免逐帧 React 重渲染。
 * - 无轮询、无常驻定时器；全局监听只在截图模式存活期间挂载，退出即摘除。
 * - 每次进入截图模式打一条时间戳日志（D-1 需要「点击→覆盖层可交互」）：
 *      [dsh-screenshot] overlay ready {elapsedMs, widthPx, heightPx, scale, method, ...}
 *   日志只含尺寸/耗时/标定与结果，不含任何图片数据（D-8）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot-xn',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ── INLINE BEGIN lib/geometry.mjs ──（构建期生成：删 import 行、去顶层 export；其余逐字一致）
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
const MIN_SELECTION_EDGE = 8;

/** A rectangle with no extent, used as the "no selection yet" value. */
const EMPTY_RECT = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

/** Longest exported edge, in device pixels (PRD F-23). */
const MAX_EXPORT_EDGE = 4096;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number} `value` clamped into `[min, max]`; `min` wins if max < min.
 */
function clamp(value, min, max) {
  if (min > max) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * @param {number} value
 * @returns {boolean} whether `value` is a usable finite number.
 */
function isFiniteNumber(value) {
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
function rectFromCorners(a, b) {
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width === 0 && height === 0) return { ...EMPTY_RECT };
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height };
}

/**
 * @param {Rect} rect
 * @returns {Rect} the same rectangle with non-negative width/height.
 */
function normalizeRect(rect) {
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
function hasPositiveArea(rect) {
  return rect.width > 0 && rect.height > 0;
}

/**
 * Whether a rectangle encloses at least one point.
 * @param {Rect} rect
 * @returns {boolean} whether the rectangle contains its top-left point.
 */
function containsPoint(rect, point) {
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
function scaleRect(rect, scale) {
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
function isValidSelection(rect, minEdge = MIN_SELECTION_EDGE) {
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
function toIntegerRect(rect, frameWidth, frameHeight) {
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
function clampRectToFrame(rect, frameWidth, frameHeight) {
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
function resizeRect(rect, handle, point, frameWidth, frameHeight) {
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
function hitHandle(rect, point, tolerance) {
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
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * @param {Rect} rect
 * @returns {Point} the centre of a handle, keyed by {@link HANDLES} names.
 */
function handlePoint(rect, handle) {
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
function cursorForHandle(x) {
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
function distanceToSegment(point, a, b) {
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
function appendPoint(points, point, minDistance = 1.5) {
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
function arrowHead(from, to, length, width) {
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
function arrowHeadSize(from, to, lineWidth) {
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
function roundRectPath(ctx, rect, radius) {
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
    // ── INLINE END lib/geometry.mjs ──

    // ── INLINE BEGIN lib/capture-plan.mjs ──（构建期生成：删 import 行、去顶层 export；其余逐字一致）
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

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {import('./geometry.mjs').Point} Point */

/** Relative disagreement between the two calibration ratios that still counts as calibrated. */
const CALIBRATION_TOLERANCE = 0.02;

/** Largest exported edge, in device pixels (PRD F-23). */
const DEFAULT_MAX_EDGE = MAX_EXPORT_EDGE;

/** Default size ceiling before the lossy fallback engages (队长 D-8: 4 MB). */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** PNG encoder option that asks the browser to prefer a smaller file (browsers ignore it safely). */
const LOSSY_TIER_START = 0.92;

/** Quality steps tried by the WebP fallback, from best to smallest. */
const WEBP_QUALITY_STEPS = Object.freeze([0.92, 0.82, 0.7, 0.55]);

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
function normalizeCapture(raw) {
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
function effectiveScale(capture, overlay) {
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
function calibrateCapture(capture, surface = {}) {
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
const MIN_DEVICE_SCALE = 0.5;
/** Highest plausible bitmap-pixels-per-screen-pixel ratio. */
const MAX_DEVICE_SCALE = 4;

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
function fitCaptureToOverlay(capture, overlay) {
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
function screenPixelRatio(capture) {
  const bounds = readRect(capture.bounds);
  if (bounds === undefined) return undefined;
  return mean(capture.widthPx / bounds.width, capture.heightPx / bounds.height);
}

/**
 * @param {number} scale
 * @returns {string} the scale as a percentage label, e.g. `125%`.
 */
function formatScaleLabel(scale) {
  return `${Math.round(scale * 100)}%`;
}

/**
 * @param {number|undefined} bytes
 * @returns {string} a human-readable size, e.g. `2.7 MB`.
 */
function formatBytes(bytes) {
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
function planRender(capture, selectionCss, options = {}) {
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
const DEFAULT_SIZE_POLICY = Object.freeze({
  maxEdge: DEFAULT_MAX_EDGE,
  maxBytes: DEFAULT_MAX_BYTES,
  allowLossy: true,
  allowLogicalDownscale: true,
});

/**
 * @param {Partial<SizePolicy>} [overrides]
 * @returns {SizePolicy} the merged policy.
 */
function resolveSizePolicy(overrides = {}) {
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
function capEdges(width, height, maxEdge) {
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
function sizeAttempts(plan, policy) {
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
function clipSelectionToOverlay(selection, overlaySize) {
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
function screenshotFileName(date = new Date(), prefixOrOptions = {}) {
  const options = typeof prefixOrOptions === 'string' ? { prefix: prefixOrOptions } : prefixOrOptions ?? {};
  const prefix = options.prefix ?? 'DSH截图';
  const extension = options.extension ?? 'png';
  return `${prefix}_${timestampText(date)}.${extension}`;
}

/**
 * @param {Date} date
 * @returns {string} `yyyyMMdd_HHmmss` in local time.
 */
function timestampText(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('_');
}
    // ── INLINE END lib/capture-plan.mjs ──

    // ── INLINE BEGIN lib/annotations.mjs ──（构建期生成：删 import 行、去顶层 export；其余逐字一致）
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

/** The six tools, in toolbar order. `rect` is the default (PRD F-18). */
const TOOL_IDS = Object.freeze(['rect', 'ellipse', 'arrow', 'pen', 'mosaic', 'text']);

/** Tool kinds, including the internal `move` mode used for drag-to-relocate. */
const TOOL_MOVE = 'move';

/** Fixed stroke widths, in device pixels (PRD F-18 细/中/粗). */
const LINE_WIDTHS = Object.freeze({ thin: 3, medium: 6, thick: 10 });

/** `LINE_WIDTHS` keys in toolbar order. */
const LINE_WIDTH_ORDER = Object.freeze(['thin', 'medium', 'thick']);

/** Text sizes, in device pixels (PRD F-16 支持字号). */
const TEXT_SIZES = Object.freeze({ small: 22, medium: 32, large: 46 });

/** `TEXT_SIZES` keys in toolbar order. */
const TEXT_SIZE_ORDER = Object.freeze(['small', 'medium', 'large']);

/**
 * Annotation palette (PRD F-18 红/黄/绿/蓝/黑/白). `labelKey` resolves through
 * the Client locale service, so the swatch tooltips follow DSH's language.
 */
const COLORS = Object.freeze([
  Object.freeze({ id: 'red', value: '#e5484d', labelKey: 'color.red' }),
  Object.freeze({ id: 'yellow', value: '#f5a524', labelKey: 'color.yellow' }),
  Object.freeze({ id: 'green', value: '#30a46c', labelKey: 'color.green' }),
  Object.freeze({ id: 'blue', value: '#3b82f6', labelKey: 'color.blue' }),
  Object.freeze({ id: 'black', value: '#111111', labelKey: 'color.black' }),
  Object.freeze({ id: 'white', value: '#ffffff', labelKey: 'color.white' }),
]);

/** Default style: red thin line (PRD F-18). */
const DEFAULT_STYLE = Object.freeze({ color: '#e5484d', widthKey: 'thin' });

/**
 * Mosaic cell size, in device pixels, for one intensity step.
 * @param {number} step - 0-based intensity from 0 (finest) to 4 (coarsest).
 * @returns {number} cell size in device pixels.
 */
function mosaicCellSize(step) {
  const clamped = clamp(Math.round(step), 0, 4);
  return 6 + clamped * 10;
}

/** Mosaic intensity labels for the settings hint (PRD F-05 马赛克强度). */
const MOSAIC_STEPS = Object.freeze([0, 1, 2, 3, 4]);

/**
 * @param {string} widthKey
 * @returns {number} line width in device pixels.
 */
function lineWidthOf(widthKey) {
  return LINE_WIDTHS[widthKey] ?? LINE_WIDTHS.medium;
}

/**
 * @param {string} sizeKey
 * @returns {number} text size in device pixels.
 */
function textSizeOf(sizeKey) {
  return TEXT_SIZES[sizeKey] ?? TEXT_SIZES.medium;
}

/**
 * @param {string} colorId
 * @returns {string} the hex colour for a palette id, or the default red.
 */
function colorValueOf(colorId) {
  return COLORS.find((entry) => entry.id === colorId)?.value ?? DEFAULT_STYLE.color;
}

/**
 * Create a rectangle/ellipse/arrow annotation in device space.
 * Exactly one of `to` and `rect` is required; `rect` carries finalized shapes.
 * @param {{ tool: string, color: string, widthKey?: string, from?: {x:number,y:number}, to?: {x:number,y:number}, rect?: {x:number,y:number,width:number,height:number} }} input
 * @returns {object} the annotation value.
 */
function createShape(input) {
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
function createStroke(input) {
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
function boundsOfPoints(points) {
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
function createText(input) {
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
function translateAnnotation(annotation, dx, dy) {
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
function withTextMetrics(annotation, size) {
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
function drawAnnotation(ctx, annotation, environment = {}) {
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
function textSizeOfAnnotation(annotation) {
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
function measureTextAnnotation(ctx, annotation) {
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
const MIN_ANNOTATION_EDGE = 8;

/** Hit tolerance around an annotation's bounds, in device pixels (细笔画也点得中). */
const HIT_TOLERANCE = 4;

/** Corner handles only: an annotation scales from a corner, the opposite one stays. */
const CORNER_HANDLES = Object.freeze(['nw', 'ne', 'se', 'sw']);

/** Smallest font size a scaled text may shrink to, in device pixels. */
const MIN_TEXT_PX = 10;

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
function annotationRect(annotation) {
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
function hitAnnotation(annotation, point, tolerance = HIT_TOLERANCE) {
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
function findAnnotationAt(annotations, point, tolerance = HIT_TOLERANCE) {
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
function annotationHandles(rect) {
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
function hitAnnotationHandle(rect, point, tolerance = HIT_TOLERANCE * 2) {
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
function resizeAnnotationRect(rect, handle, point, minEdge = MIN_ANNOTATION_EDGE) {
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
function clampAnnotationRect(rect, bounds) {
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
function moveAnnotation(annotation, dx, dy, bounds) {
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
function scaleAnnotation(annotation, nextRect) {
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
function closestTextSizeKey(size) {
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
    // ── INLINE END lib/annotations.mjs ──

    // ── INLINE BEGIN lib/history.mjs ──（构建期生成：删 import 行、去顶层 export；其余逐字一致）
/**
 * Undo / redo history for the annotation layer (PRD F-17).
 *
 * The history owns *only* the annotation list. The frozen screenshot is never
 * a history entry, which is what makes "undo must not disturb the original
 * image" (DoD B-7) true by construction.
 *
 * The module is dependency-free and DOM-free: it is a plain value object, so
 * the browser bundle and `node --test` share exactly one implementation.
 */

/** Depth cap: past this many steps the oldest entry is dropped. */
const DEFAULT_HISTORY_LIMIT = 60;

/**
 * Create an annotation history.
 * @param {readonly unknown[]} [initial] - starting annotation list (usually empty).
 * @param {number} [limit] - maximum number of undoable steps.
 * @returns {{
 *   present: readonly unknown[],
 *   canUndo: () => boolean,
 *   canRedo: () => boolean,
 *   push: (next: readonly unknown[]) => boolean,
 *   undo: () => boolean,
 *   redo: () => boolean,
 *   reset: (next?: readonly unknown[]) => void,
 *   depth: () => { past: number, future: number },
 * }} a closed-over history value object.
 */
function createHistory(initial = [], limit = DEFAULT_HISTORY_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('createHistory: limit must be a positive integer');

  let present = [...initial];
  let past = [];
  let future = [];

  /**
   * @param {readonly unknown[]} next
   * @returns {boolean} whether a step was recorded.
   */
  function push(next) {
    past.push(present);
    if (past.length > limit) past.shift();
    present = [...next];
    // A new edit discards the redo branch.
    future = [];
    return true;
  }

  /** @returns {boolean} whether anything was undone. */
  function undo() {
    if (past.length === 0) return false;
    future.push(present);
    present = past.pop();
    return true;
  }

  /** @returns {boolean} whether anything was redone. */
  function redo() {
    if (future.length === 0) return false;
    past.push(present);
    present = future.pop();
    return true;
  }

  /**
   * @param {readonly unknown[]} [next] - replacement present; defaults to empty.
   * @returns {void}
   */
  function reset(next = []) {
    present = [...next];
    past = [];
    future = [];
  }

  return {
    get present() {
      return present;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    push,
    undo,
    redo,
    reset,
    depth: () => ({ past: past.length, future: future.length }),
  };
}
    // ── INLINE END lib/history.mjs ──

    // ── INLINE BEGIN lib/output.mjs ──（构建期生成：删 import 行、去顶层 export；其余逐字一致）
/**
 * Result delivery: clipboard, "save as" and filename policy (PRD F-20 … F-22).
 *
 * These helpers touch the browser platform, never the DSH runtime, so they load
 * unchanged in the overlay bundle and drive cleanly from `node --test` with a
 * stub `navigator`/`document`. All failure paths return a value instead of
 * throwing: an unavailable clipboard must degrade to a visible notice, not to a
 * broken overlay (PRD 4 可靠性 / DoD B-12).
 */

/** MIME type of the lossless artifact (PRD F-23, PNG lossless). */
const PNG_MIME = 'image/png';

/** MIME type of the lossy fallback product (队长 D-8: WebP 有损是降级链的最后一档). */
const WEBP_MIME = 'image/webp';

/**
 * The labels that must agree for one artifact: the clipboard entry's MIME, the
 * file extension, and the save dialog's description.
 *
 * The size fallback (队长 D-8) produces WebP bytes, so announcing them as PNG
 * hands the user a `.png` file no viewer opens (DoD B-9 "格式非 PNG") and a
 * clipboard entry whose MIME contradicts its bytes (DoD B-8 "粘贴为空").
 * Callers therefore pass the media type the encoder actually produced.
 * @param {string} [mediaType] - `image/png` or `image/webp`; anything else (or a
 *   missing value) is treated as the lossless PNG default.
 * @returns {{ mediaType: string, extension: string, label: string }} the labels.
 */
function formatOf(mediaType = PNG_MIME) {
  return mediaType === WEBP_MIME
    ? { mediaType: WEBP_MIME, extension: 'webp', label: 'WebP' }
    : { mediaType: PNG_MIME, extension: 'png', label: 'PNG' };
}

/**
 * Write the artifact to the system clipboard under its real MIME type.
 *
 * `ClipboardItem` is the only API that can put raw image bytes on the clipboard
 * in this runtime; the `ClipboardEvent`/`execCommand` fallback used by older
 * guides cannot produce an image and is intentionally not attempted.
 *
 * @param {{ navigator?: object, ClipboardItemCtor?: Function }} [platform]
 * @param {string} [mediaType] - the encoder's media type (`image/png`, or the
 *   WebP fallback `image/webp`); the entry must not claim PNG for WebP bytes.
 * @returns {Promise<{ ok: boolean, reason?: string }>} delivery outcome.
 */
async function copyPngToClipboard(blob, platform = {}, mediaType = PNG_MIME) {
  const nav = platform.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const Item = platform.ClipboardItemCtor
    ?? (typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem);
  const format = formatOf(mediaType);
  try {
    if (nav?.clipboard?.write === undefined) return { ok: false, reason: 'clipboard.unavailable' };
    if (Item === undefined) return { ok: false, reason: 'clipboard.itemUnavailable' };
    await nav.clipboard.write([new Item({ [format.mediaType]: blob })]);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `clipboard.failed:${errorText(error)}` };
  }
}

/**
 * Save the artifact through the system save dialog, falling back to a download
 * when the platform exposes no file picker (DoD B-9, F-22).
 *
 * @param {Blob} blob
 * @param {{ showSaveFilePicker?: Function, document?: object, url?: { createObjectURL: Function, revokeObjectURL: Function }, now?: () => Date }} [platform]
 * @param {string} [mediaType] - the encoder's media type; the suggested name,
 *   its extension and the picker's accept list all follow it, so a WebP fallback
 *   product is never written as `DSH截图_….png`.
 * @returns {Promise<{ ok: boolean, method: string, fileName?: string, reason?: string }>} delivery outcome.
 */
async function savePngAs(blob, platform = {}, mediaType = PNG_MIME) {
  const format = formatOf(mediaType);
  const fileName = screenshotFileName(platform.now?.() ?? new Date(), { extension: format.extension });
  const picker = platform.showSaveFilePicker
    ?? (typeof showSaveFilePicker === 'function' ? showSaveFilePicker : undefined);
  if (picker !== undefined) {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: format.label, accept: { [format.mediaType]: [`.${format.extension}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, method: 'picker', fileName: handle.name ?? fileName };
    } catch (error) {
      if (isAbort(error)) return { ok: false, method: 'picker', reason: 'save.cancelled' };
      // A denied picker (permission policy) still deserves the download path.
      const fallback = downloadBlob(blob, fileName, platform);
      return fallback.ok
        ? { ...fallback, method: 'download' }
        : { ok: false, method: 'picker', reason: `save.failed:${errorText(error)}` };
    }
  }
  return downloadBlob(blob, fileName, platform);
}

/**
 * @param {Blob} blob
 * @param {string} fileName
 * @param {{ document?: object, url?: { createObjectURL: Function, revokeObjectURL: Function } }} platform
 * @returns {{ ok: boolean, method: string, fileName?: string, reason?: string }}
 */
function downloadBlob(blob, fileName, platform) {
  const doc = platform.document ?? (typeof document === 'undefined' ? undefined : document);
  const urlApi = platform.url ?? (typeof URL === 'undefined' ? undefined : URL);
  if (doc === undefined || urlApi === undefined) return { ok: false, method: 'download', reason: 'save.unavailable' };
  let href;
  try {
    href = urlApi.createObjectURL(blob);
  } catch (error) {
    return { ok: false, method: 'download', reason: `save.failed:${errorText(error)}` };
  }
  const anchor = doc.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a later task so the browser has started reading the blob. Where
  // the host returns a timer object (node) it is unref'd, so an offline run does
  // not linger for ten seconds after the last assertion.
  const timer = setTimeout(() => urlApi.revokeObjectURL(href), 10_000);
  if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return { ok: true, method: 'download', fileName };
}

/**
 * @param {unknown} error
 * @returns {boolean} whether the failure is the user cancelling a dialog.
 */
function isAbort(error) {
  if (error === null || typeof error !== 'object') return false;
  const name = /** @type {{ name?: unknown }} */ (error).name;
  return name === 'AbortError';
}

/**
 * @param {unknown} error
 * @returns {string} a short, log-safe description; never contains image data.
 */
function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Convert a PNG blob to a data URL.
 * Image attachments travel inline with the prompt, so this is the form the
 * insert path hands over.
 *
 * The reader is injectable: when `readAsDataUrl` is given it is called with the
 * reader as `this` (`{ result, error, onload, onerror }` are wired up here) and
 * no global `FileReader` is touched — that is what lets the offline tests and
 * any non-browser host drive the conversion without a DOM.
 * @param {Blob} blob
 * @param {Function} [readAsDataUrl] - `FileReader.prototype.readAsDataURL`, injectable for tests.
 * @returns {Promise<string>} the data URL.
 */
function blobToDataUrl(blob, readAsDataUrl) {
  const reader = readAsDataUrl === undefined ? new FileReader() : {};
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    if (readAsDataUrl === undefined) reader.readAsDataURL(blob);
    else readAsDataUrl.call(reader, blob);
  });
}

/**
 * Build the `File` handed to the conversation as an image draft.
 *
 * The name, its extension and `File.type` all follow the encoder's media type:
 * attachment intake validates the declared MIME against the bytes, so a WebP
 * fallback product must travel as `image/webp`. The function name is kept for
 * API stability even though the product is not always PNG.
 * @param {Blob} blob
 * @param {Date} [now]
 * @param {string} [mediaType] - the encoder's media type.
 * @returns {File} an image file with the user-facing name.
 */
function pngFileOf(blob, now = new Date(), mediaType = PNG_MIME) {
  const format = formatOf(mediaType);
  return new File([blob], screenshotFileName(now, { extension: format.extension }), {
    type: format.mediaType,
    lastModified: now.getTime(),
  });
}
    // ── INLINE END lib/output.mjs ──

    // ══════════════════════════════════════════════════════════════════════════
    // 客户端半（手写）：输入框按钮 → 抓屏 → 冻结覆盖层 → 框选/微调 → 标注 → 输出
    // ══════════════════════════════════════════════════════════════════════════

    /** 已放置标注的角把手边长（CSS px）：样式、渲染偏移、命中容差共用同一个数。 */
    const ANNOTATION_HANDLE_SIZE = 8;

    /**
     * 标注角把手**在其父元素（标注虚线框）内部**的 left/top（H-01）。
     *
     * 把手是标注框的子节点，`place()` 写的 `left/top` 是相对父元素（offsetParent 就是框本身）的，
     * 而 `handlePoint()`（内联 lib/geometry.mjs）给的是**视口坐标** —— 直接写进去会被框原点二次偏移：
     * 实测框 `{x:500,y:350,w:200,h:130}` 的 nw 把手被画到 `(997,697)`（= 500+500−4 / 350+350−4），
     * 落在选区之外，用户看不到把手、以为不能缩放（t36 的 H-01）。
     * 所以这里统一减去框原点再减半个把手（让把手中心对准角点）。
     * @param {{x: number, y: number, width: number, height: number}} box - 标注框（视口坐标）。
     * @param {{x: number, y: number}} corner - 角点（视口坐标，来自 handlePoint）。
     * @param {number} [size]
     * @returns {{x: number, y: number}} 相对标注框的 left/top。
     */
    function annotationHandleOffset(box, corner, size = ANNOTATION_HANDLE_SIZE) {
      const radius = size / 2;
      return { x: corner.x - box.x - radius, y: corner.y - box.y - radius };
    }

    /** 宿主同源抓屏路由（t1 §7.2 冻结，逐字）。 */
    const CAPTURE_PATH = '/api/dsh-screenshot/capture';
    /** 抓屏响应携带度量 JSON 的响应头名（t1 §7.2 冻结，逐字）。 */
    const CAPTURE_HEADER = 'X-DSH-Screenshot';
    /** 输入框动作区槽位（t1 §1.4 / §7.4 冻结，逐字：list，模型选择器之前的动作行）。 */
    const BUTTON_SLOT = 'conversation.input.right';
    /** 全应用级覆盖层槽位（t1 §2 / §7.4 冻结，逐字：list / scope=root，条目须自设 pointer-events）。 */
    const OVERLAY_SLOT = 'shell.overlay';
    /** 条目 id 与排序（t1 §7.4 冻结，逐字：新 id 加在既有条目旁边，不覆盖任何人）。 */
    const BUTTON_ID = 'dsh-screenshot.button';
    const OVERLAY_ID = 'dsh-screenshot.overlay';
    const BUTTON_ORDER = 50;
    const OVERLAY_ORDER = 100;
    /**
     * 插件页里"本插件自己的配置区"槽位（t74）。逐字取自 DSH 的 `dsh-client-ui-plugin-manager`：
     * `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` ——
     * `key` 必须是**包名**；没有贡献时那一页连配置 section 都不渲染（语音输入插件同款做法）。
     */
    const PLUGIN_CONFIG_SLOT = 'plugins.bundle.config';
    /** 本插件的包名（= bundle 名 = 行 id）。 */
    const PLUGIN_PACKAGE = 'dsh-screenshot-xn';
    /** 配置区的顺序（只有一个贡献，取值与语音插件同量级即可）。 */
    const PLUGIN_CONFIG_ORDER = 50;

    /** 日志前缀：D-1 的「点击→覆盖层可交互」时间戳与失败原因都走它，只记尺寸/耗时/结果（D-8）。 */
    const LOG_PREFIX = '[dsh-screenshot-xn]';

    /**
     * 体积阈值与降级方式（PRD F-23 / 队长 D-8）—— 单一真相是内联的 lib：
     * `DEFAULT_MAX_BYTES`（4 MB）与 `DEFAULT_MAX_EDGE`（= geometry 的 `MAX_EXPORT_EDGE`，
     * 4096，PRD A-04）。这里只做别名，调参改 lib 一处即可，避免两侧漂移。
     * 降级顺序同样由 lib/capture-plan.mjs 的 `sizeAttempts` 冻结：
     *   png-full（原始分辨率 PNG）→ png-logical（按逻辑分辨率下采样，仅当逻辑尺寸更小）
     *   → webp-logical 与逐档 WebP 有损（WEBP_QUALITY_STEPS）。
     */
    const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
    const MAX_OUTPUT_EDGE = DEFAULT_MAX_EDGE;

    // ─────────────────────────────────────────────────────────────────────────
    // 抓屏方式（t52 化简）：**始终**先临时隐藏 DSH、抓完恢复（宿主 `mode=through`）。
    // 不再给用户选择权 —— C-6 的「普通截图 / 穿透截图」右键菜单与会话内记忆已作废，
    // 只保留降级：宿主未加载新代码 / 隐藏失败 / 恢复未确认 / 502 → 可见提示 + 回退为「不隐藏」抓屏。
    // 契约字面（与宿主逐字对齐，见 validate 的 X-1）：
    //   请求：`mode=through`（降级重试用 `mode=normal`，宿主按「非 through 即普通」解析）；
    //   度量：`mode`（'normal'|'through'）、`hiddenMs`、`restoreOk`（boolean）。
    // ─────────────────────────────────────────────────────────────────────────
    /** 隐藏 DSH 再抓屏的取值（X-1 逐字比对；参数名写在发送处，便于门禁按字面抓取）。 */
    const CAPTURE_MODE_THROUGH = 'through';
    /** 降级重试的取值：不隐藏，直接抓（图里会包含 DSH 窗口）。 */
    const CAPTURE_MODE_NORMAL = 'normal';
    /**
     * 截图模式的持久化偏好（t73）：宿主把 `POST` 的选择写进**插件配置**
     * （`Config.captureMode`，也就是设置页 / 插件管理里那一项），`GET` 读回当前生效值。
     */
    const CAPTURE_STATE_PATH = '/api/dsh-screenshot/state';

    /**
     * 右键菜单的两个模式条目（C-6 复活，t67）：顺序即键盘上下移动的顺序。
     * `hintKey` 指向 TEXT 里的说明，`labelKey` 指向条目文案。
     */
    const CAPTURE_MODE_ITEMS = Object.freeze([
      { id: CAPTURE_MODE_THROUGH, labelKey: 'modeThrough', hintKey: 'modeHintThrough' },
      { id: CAPTURE_MODE_NORMAL, labelKey: 'modeNormal', hintKey: 'modeHintNormal' },
    ]);

    /**
     * 归一化一个模式取值（纯逻辑）：只认 `normal`，其余（含 undefined / 脏值）一律 `through`。
     * 默认必须是穿透 —— 让"图里有没有 DSH"这件事保持老行为，除非用户明确选了普通。
     * @param {unknown} value
     * @returns {string}
     */
    function normalizeCaptureMode(value) {
      return value === CAPTURE_MODE_NORMAL ? CAPTURE_MODE_NORMAL : CAPTURE_MODE_THROUGH;
    }

    /**
     * ALT+A 判定（t45）：Alt 按下 + 键名/物理键是 A，且不带 Ctrl/Meta（避免抢系统/宿主快捷键）。
     * @param {object} event
     * @returns {boolean}
     */
    function isCaptureShortcut(event) {
      if (event === null || event === undefined) return false;
      if (event.altKey !== true) return false;
      if (event.ctrlKey === true || event.metaKey === true) return false;
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
      if (key === 'a') return true;
      // 非拉丁键盘布局下 key 可能不是 'a'，用物理键兜底。
      return event.code === 'KeyA';
    }

    /**
     * 目标是否是可编辑元素（输入框/文本域/下拉/富文本）：快捷键与菜单在这些地方**不吞键**。
     * @param {unknown} target
     * @returns {boolean}
     */
    function isEditableTarget(target) {
      if (target === null || target === undefined || typeof target !== 'object') return false;
      if (target.isContentEditable === true) return true;
      const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
      return tag === 'input' || tag === 'textarea' || tag === 'select';
    }

    /**
     * ALT+A 是否应当真的发起一次截图（纯判定，便于离线用例）：
     * - 必须是 ALT+A；
     * - 焦点在输入框/可编辑元素上 → 不触发、也不 preventDefault（不产生字符、不干扰输入）；
     * - 页面未聚焦（`document.hasFocus() === false`）→ 不触发：这是「应用内快捷键」的既定降级
     *   （不做全局热键、不引常驻进程）。
     * @param {object} event
     * @param {{hasFocus?: Function}|null} [doc]
     * @param {unknown} [target]
     * @returns {boolean}
     */
    function shouldStartCapture(event, doc, target) {
      if (!isCaptureShortcut(event)) return false;
      if (isEditableTarget(target)) return false;
      if (doc !== null && doc !== undefined && typeof doc.hasFocus === 'function' && doc.hasFocus() === false) return false;
      return true;
    }

    /**
     * 抓屏请求的查询串（t52）：`fresh=1` 与视口始终带；`mode` 也**始终**带 ——
     * 默认 `through`（隐藏 DSH 再抓），只有降级重试时才用 `normal`（不隐藏）。
     * @param {boolean} through
     * @param {{width: number, height: number}} viewport
     * @returns {URLSearchParams}
     */
    function captureQueryFor(through, viewport) {
      const query = new URLSearchParams();
      query.set('fresh', '1');
      if (viewport.width > 0 && viewport.height > 0) {
        query.set('vw', String(Math.round(viewport.width)));
        query.set('vh', String(Math.round(viewport.height)));
      }
      // X-1 的跨半比对按字面抓这行（`query.set('mode', …)`），所以参数名必须写成字面量，
      // 不能藏在常量里 —— 否则宿主加了 `searchParams.get('mode')` 之后两侧集合会不一致。
      query.set('mode', through === false ? CAPTURE_MODE_NORMAL : CAPTURE_MODE_THROUGH);
      return query;
    }

    /**
     * 宿主返回的抓屏方式度量（t45 起、t52 后仍消费）：`normalizeCapture` 是内联 lib
     * （X-2 冻结、不认识的字段会丢），所以这三个字段在客户端侧单独挂到归一化结果上，
     * 用于日志与「这次到底有没有隐藏成功 / 是否含 DSH 窗口」的可见提示判定。
     * @param {object|null} header
     * @returns {{mode: string, hiddenMs: number|null, restoreOk: boolean|null}}
     */
    function captureModeMetrics(header) {
      const hidden = header?.hiddenMs;
      const restore = header?.restoreOk;
      return {
        mode: header?.mode === CAPTURE_MODE_THROUGH ? CAPTURE_MODE_THROUGH : CAPTURE_MODE_NORMAL,
        hiddenMs: typeof hidden === 'number' && Number.isFinite(hidden) && hidden >= 0 ? hidden : null,
        restoreOk: restore === true ? true : restore === false ? false : null,
      };
    }

    /**
     * 覆盖层自身 UI 的统一标记（R-U01）：根部的指针处理靠它区分「点画面」与「点面板」。
     * 与 onKeyDown 判断文本输入框同源 —— 都用 `closest()` 命中标记后直接 return。
     */
    const UI_MARKER_ATTR = 'data-dsh-screenshot-ui';
    /** 上面标记对应的选择器（由属性名拼出，避免两处各写一份字面量）。 */
    const UI_MARKER_SELECTOR = '[' + UI_MARKER_ATTR + ']';

    /** 选区把手命中容差（CSS px）。 */
    const HANDLE_TOLERANCE = 7;
    /** 已放置标注的角把手命中容差（CSS px，命中时换算到 device 空间）。 */
    const ANNOTATION_HANDLE_TOLERANCE = 9;
    /** 工具栏避让屏幕边缘的留白（CSS px，PRD F-08）。 */
    const EDGE_MARGIN = 10;
    /** 把手方块边长（CSS px）。 */
    const HANDLE_SIZE = 8;
    /** 轻提示时长（ms）：成功短、失败长（B-12 要求可见）。 */
    const TOAST_MS = 2600;
    const TOAST_ERROR_MS = 5200;
    /**
     * 插入对话的确认窗口：粘贴桥接后等输入框附件数量增加（ms）。
     * t29：窗口从 1500 收到 1200 —— 失败路径要求「点击 → 可见降级」≤1500ms，
     * 而窗口到期后还要写系统剪贴板（实测 20~40ms），留出余量后总计 ≈1.3s。
     * 宿主 paste intake 的实测延迟是 17~18ms（真机）／150ms（harness），1200ms 有充足余量。
     */
    const INSERT_CONFIRM_MS = 1200;
    /**
     * 编码阶段的硬上限（ms，t29）：`canvas.toBlob` 只保证「最终会回调」在正常路径上成立，
     * 一旦它不回调（大画布 + 负载 / 渲染进程异常），没有上限的 await 会让「正在生成图片…」
     * 变成永久忙态，而且**一行日志都不会有**（第一个日志在编码成功之后）。
     * 超过这个上限就放弃等待，走可见降级（提示改用复制/重试），busy 一律释放。
     */
    const ENCODE_DEADLINE_MS = 6000;
    /** 编码偏慢的可见升级提示门槛（ms）：让「慢」和「卡死」在界面上可区分。 */
    const ENCODE_SLOW_NOTICE_MS = 2500;
    /** 马赛克默认强度档（中档）：与下面的档位表共用同一真相，默认值不再单独写死。 */
    const MOSAIC_DEFAULT_STEP = 2;
    /** 马赛克强度档（映射到 lib 的 0..4 步，见 `mosaicCellSize`）。 */
    const MOSAIC_STEPS_UI = Object.freeze([0, MOSAIC_DEFAULT_STEP, 4]);
    /** 马赛克粒度文案。 */
    const MOSAIC_STEP_LABELS = Object.freeze({ 0: '细', 2: '中', 4: '粗' });

    /**
     * 文案。与 locale/*.json 的 `ui` 段同一份措辞（客户端本轮不依赖未核实的 locale 服务，
     * 因此把双语串直接写在代码里；按钮/动作/提示的中英并列满足 PRD D-1）。
     */
    const TEXT = Object.freeze({
      modeSetting: '截图模式 / Capture mode',
      modeThrough: '穿透截图（隐藏 DSH）/ Through (hide DSH)',
      modeNormal: '普通截图（含 DSH 窗口）/ Normal (include DSH)',
      modeSaving: '保存中… / Saving…',
      modeSaved: '已保存，重启后仍然生效 / Saved; kept after restart',
      modeSessionOnly: '本次会话生效（宿主未提供设置服务）/ Session only',
      button: '截图 / Screenshot',
      hint: '拖动鼠标框选，Esc 取消，右键取消',
      insert: '插入对话 / Insert',
      copy: '复制 / Copy',
      save: '另存为 / Save as',
      cancel: '取消 / Cancel',
      undo: '撤销 / Undo',
      redo: '重做 / Redo',
      working: '处理中…',
      selectedHint: '拖动移动 · 角把手缩放 · Delete 删除',
      busyEncode: '正在生成图片（含标注）…',
      busySlow: '图片较大，仍在生成…（可直接取消，或用「复制」）',
      busyInsert: '正在插入对话…',
      tools: Object.freeze({
        move: '移动 / Move',
        rect: '矩形 / Rect',
        ellipse: '椭圆 / Ellipse',
        arrow: '箭头 / Arrow',
        pen: '画笔 / Pen',
        mosaic: '马赛克 / Mosaic',
        text: '文字 / Text',
      }),
      colors: Object.freeze({
        red: '红 / Red',
        yellow: '黄 / Yellow',
        green: '绿 / Green',
        blue: '蓝 / Blue',
        black: '黑 / Black',
        white: '白 / White',
      }),
      widths: Object.freeze({ thin: '细', medium: '中', thick: '粗' }),
      textSizes: Object.freeze({ small: '小', medium: '中', large: '大' }),
      mosaicLabel: '粒度',
      shortcut: 'Alt+A',
      throughUnavailable: '未能隐藏 DSH 窗口，本次截图会包含 DSH 窗口',
      throughFailed: '隐藏 DSH 窗口失败，已改为直接抓屏（本次截图会包含 DSH 窗口）',
      throughRestoreFailed: '窗口恢复未确认，已改为直接抓屏（本次截图会包含 DSH 窗口）',
      // 右键菜单（C-6 复活，t67）：模式由用户选，界面必须把"这张图里有没有 DSH"说清楚。
      modeMenuLabel: '截图模式 / Capture mode',
      modeThrough: '穿透截图（隐藏 DSH）/ Through (hide DSH)',
      modeNormal: '普通截图（含 DSH 窗口）/ Normal (includes DSH)',
      modeHintThrough: '先隐藏 DSH 再抓屏，画面里没有 DSH / Hides DSH before the grab',
      modeHintNormal: '不隐藏 DSH，可截到 DSH 自己的界面 / Keeps DSH in the frame',
      modeMenuHint: '左键 / Alt+A 使用选中的模式，选择会被记住 / Left click and Alt+A use the selected mode; the choice is remembered',
      modeSetting: '截图模式 / Capture mode',
      modeSaving: '保存中… / Saving…',
      modeSaved: '已保存，重启后仍然生效 / Saved; kept after a restart',
      modeSessionOnly: '本次会话生效（宿主未提供设置服务）/ Applies to this session only',
      toastNormalMode: '普通模式：本次画面会包含 DSH 窗口 / Normal mode: the frame includes the DSH window',
      // B1 独立全屏覆盖层（默认路径，t59）：面板在自己的窗口里，措辞不能再说"覆盖层"。
      overlayOpened: '正在打开截图面板，请在屏幕上框选 / Opening the screenshot overlay, select on screen',
      overlayFallback: '独立截图面板不可用，已改用 DSH 内截图 / Overlay unavailable, using the in-DSH capture',
      overlayNoBrowser: '未找到可用的浏览器（Edge / Chrome），已改用 DSH 内截图 / No browser found (Edge / Chrome), using the in-DSH capture',
      overlayAborted: '截图面板未返回结果就结束了，请重试 / The overlay ended without a result, please retry',
      overlayTimeout: '截图面板超时没有返回结果，请重试 / The overlay timed out, please retry',
      overlayUnreachable: '与截图面板失去联系（宿主未响应），请重试 / Lost contact with the overlay host, please retry',
      overlayResultFailed: '取回截图结果失败，请重试 / Failed to fetch the overlay result, please retry',
      toastOverlayCancelled: '已取消截图 / Screenshot cancelled',
      toastCopied: '已复制截图，可在输入框 Ctrl+V 粘贴',
      toastCopiedPaste: '已复制到剪贴板，请按 Ctrl+V 粘贴',
      toastInserted: '已插入对话',
      toastSaved: '已保存截图',
      toastSavedDownload: '已保存截图（下载）',
      toastCanceled: '选区太小（最小 8 px），本次截图已取消',
      toastClipped: '选区超出画面范围，本次截图已取消',
      degradedCalibration: '坐标标定已降级为整屏适配，请核对选区',
      captureFailed: '抓屏失败，请重试；如持续失败请检查抓屏脚本与权限',
      captureUnsupported: '当前环境不支持原生抓屏（需要 DSH Desktop / Windows）',
      copyFailed: '复制失败',
      saveFailed: '另存为失败',
      insertFailed: '插入对话失败，可改用「复制」后手动粘贴',
      encodeFailed: '导出失败',
      encodeTimeout: '图片生成超时，请重试或改选更小区域',
      outputFailed: '输出失败',
      editorPlaceholder: '输入文字后回车',
    });

    /**
     * 主题令牌（t1 §3 清单内的 --dsw-alias-*；UI 外框只用令牌，DoD D-10 / D-11）。
     * 工具栏/提示用 toast 一族（两种主题下都是深底浅字）；
     * 激活态按钮用 button-info 一族（深色主题下自动变浅蓝，配 label-primary-foreground 仍可读）。
     */
    const TOKEN = Object.freeze({
      panel: 'var(--dsw-alias-toast-bg)',
      panelLabel: 'var(--dsw-alias-toast-label)',
      toolFill: 'var(--dsw-alias-button-tool-bar-fill)',
      toolHover: 'var(--dsw-alias-button-tool-bar-hover)',
      toolFillInvisible: 'var(--dsw-alias-button-tool-bar-fill-invisible)',
      accent: 'var(--dsw-alias-button-info-fill)',
      onAccent: 'var(--dsw-alias-label-primary-foreground)',
      mask: 'var(--dsw-alias-bg-mask-3)',
      border: 'var(--dsw-alias-border-l3)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelCaption: 'var(--dsw-alias-label-caption)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    });

    /** 日志器：只输出尺寸/耗时/原因，绝不输出图片数据（D-8）。 */
    const logger = {
      info: (message, detail) => console.info(`${LOG_PREFIX} ${message}`, detail),
      warn: (message, detail) => console.warn(`${LOG_PREFIX} ${message}`, detail),
    };

    /** @returns {number} 单调时钟毫秒（D-1 计时用）。 */
    function nowMs() {
      return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    }

    /** @returns {number} 当前窗口的设备像素比（只用于画布分辨率，不参与坐标标定）。 */
    function currentDpr() {
      const value = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
      return Number.isFinite(value) && value > 0 ? value : 1;
    }

    /** @returns {{width: number, height: number}} CSS 视口（抓屏请求的 vw/vh 与交叉校验用）。 */
    function viewportSize() {
      const root = typeof document === 'undefined' ? undefined : document.documentElement;
      const width = root === undefined ? 0 : root.clientWidth;
      const height = root === undefined ? 0 : root.clientHeight;
      if (width > 0 && height > 0) return { width, height };
      return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
    }

    /** @param {unknown} value @returns {boolean} */
    function isRectLike(value) {
      return value !== null && typeof value === 'object'
        && isFiniteNumber(value.width) && value.width > 0
        && isFiniteNumber(value.height) && value.height > 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 运行时状态（两个槽位条目共享一份真相；退出/卸载时释放资源）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @returns {object} 截图运行时：状态 + 订阅 + 资源释放。
     */
    function createShotStore() {
      /** @type {Set<Function>} */
      const listeners = new Set();
      /** @type {Set<number>} */
      const timers = new Set();
      /** @type {Set<{ resolve: Function, timer: number }>} 可取消等待（B1 轮询）的等待者。 */
      const sleepers = new Set();
      /** @type {Set<{ baseline: number, resolve: Function, timer: number }>} 附件数等待者（U-03） */
      const attachmentWaiters = new Set();
      let toastTimer = null;

      const state = {
        /** `idle` | `capturing` | `active` */
        phase: 'idle',
        /** 输出动作进行中（禁用工具栏按钮，避免重复提交）。 */
        busy: false,
        /** 冻结帧：`{capture, blob, image, width, height, release, startedAt, header}`。 */
        frame: null,
        /** 覆盖层 CSS 空间的选区。 */
        selection: null,
        /** 标定结果：`{scale, surface, screen, dpr, method, degraded, viewportMatch}`。 */
        calibration: null,
        /** 标注撤销栈（内联的 lib/history.mjs；标注列表的唯一真相）。 */
        history: createHistory(),
        tool: TOOL_MOVE,
        color: DEFAULT_STYLE.color,
        widthKey: DEFAULT_STYLE.widthKey,
        textSizeKey: 'medium',
        mosaicStep: MOSAIC_DEFAULT_STEP,
        /** 当前选中的已放置标注下标（t22）；null = 没有选中。 */
        selectedAnnotationIndex: null,
        /** 文字标注输入框：`{cssX, cssY, deviceX, deviceY}`。 */
        editor: null,
        /** 工具栏内的可见提示（失败留在这里，允许重试，B-12）。 */
        notice: null,
        /** 轻提示：`{kind, text}`。 */
        toast: null,
        /**
         * 当前输入框草稿里的附件数量（由按钮条目通过标准 prop `useInput` 镜像过来）。
         * 这是「插入对话是否真的插入成功」的唯一硬判据：插入前后数量必须增加。
         * `null` 表示拿不到该信号（此时不做不可验证的插入，直接走复制降级）。
         */
        attachmentCount: null,
        /** 输入框按钮 DOM（成功后焦点回收用）。 */
        buttonEl: null,
        /**
         * 当前抓屏模式（t67 右键菜单 / t73 设置页）：`through`（默认，抓屏前隐藏 DSH）
         * 或 `normal`（不隐藏，画面里含 DSH 窗口）。它由**插件配置**决定：
         * 启动时从宿主读回上次的选择，菜单里改一次就写回配置，所以重启后不用重选。
         */
        captureMode: CAPTURE_MODE_THROUGH,
        /** 右键模式菜单的开合状态：null = 关闭，`{openedAt}` = 打开。 */
        modeMenu: null,
        /** 卸载标记：B1 轮询里的可取消等待靠它立刻收口，不留悬空定时器（D-7）。 */
        disposed: false,
      };

      /** @param {Function} listener @returns {Function} 退订函数。 */
      function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }

      /** 通知订阅者（单个监听器抛错不影响其它监听器与截图流程）。 */
      function notify() {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            logger.warn('store listener failed', errorText(error));
          }
        }
      }

      /**
       * @param {'success'|'error'|'warn'|'info'} kind
       * @param {string} text
       */
      function setToast(kind, text) {
        if (toastTimer !== null) {
          clearTimeout(toastTimer);
          timers.delete(toastTimer);
        }
        state.toast = { kind, text };
        const ttl = kind === 'error' || kind === 'warn' ? TOAST_ERROR_MS : TOAST_MS;
        toastTimer = setTimeout(() => {
          timers.delete(toastTimer);
          toastTimer = null;
          state.toast = null;
          notify();
        }, ttl);
        timers.add(toastTimer);
        notify();
      }

      /**
       * 记录镜像过来的输入框附件数量，并唤醒等待者（U-03：事件驱动，不做无谓空转）。
       * 成功判据仍然是「数量严格增加」—— 只有 `next > baseline` 才可能 resolve(true)。
       * @param {number|null} next
       */
      function setAttachmentCount(next) {
        state.attachmentCount = next;
        if (typeof next !== 'number') return;
        for (const waiter of [...attachmentWaiters]) {
          if (next > waiter.baseline) {
            attachmentWaiters.delete(waiter);
            clearTimeout(waiter.timer);
            timers.delete(waiter.timer);
            waiter.resolve(true);
          }
        }
      }

      /**
       * 等输入框附件数量**严格增加**；窗口到期返回 false（与旧实现同一个判据与上限）。
       * @param {number} baseline
       * @param {number} timeoutMs
       * @returns {Promise<boolean>}
       */
      function waitForAttachmentIncrease(baseline, timeoutMs) {
        if (typeof state.attachmentCount === 'number' && state.attachmentCount > baseline) {
          return Promise.resolve(true);
        }
        return new Promise((resolve) => {
          const waiter = { baseline, resolve, timer: null };
          waiter.timer = setTimeout(() => {
            attachmentWaiters.delete(waiter);
            timers.delete(waiter.timer);
            resolve(false);
          }, timeoutMs);
          timers.add(waiter.timer);
          attachmentWaiters.add(waiter);
        });
      }

      /**
       * 可取消的等待（B1 轮询的节奏由它给）：等待者登记在 `sleepers` 里，
       * `dispose()` 时被唤醒并返回 false —— 于是轮询循环立刻收口，不会留下悬空定时器（D-7）。
       * @param {number} ms
       * @returns {Promise<boolean>} false = 组件已卸载（调用方必须停止后续工作）。
       */
      function sleep(ms) {
        if (state.disposed === true) return Promise.resolve(false);
        return new Promise((resolve) => {
          const entry = { resolve: null, timer: null };
          entry.timer = setTimeout(() => {
            timers.delete(entry.timer);
            sleepers.delete(entry);
            resolve(state.disposed !== true);
          }, ms);
          entry.resolve = (alive) => resolve(alive);
          timers.add(entry.timer);
          sleepers.add(entry);
        });
      }

      /** 释放冻结帧（关闭位图 + 撤销对象 URL，D-9）。 */
      function releaseFrame() {
        const frame = state.frame;
        state.frame = null;
        if (frame === null) return;
        try {
          if (typeof frame.release === 'function') frame.release();
        } catch (error) {
          logger.warn('frame release failed', errorText(error));
        }
      }

      /** 退出截图模式并清理与本次截图相关的状态（F-25）。 */
      function leaveMode() {
        state.phase = 'idle';
        state.busy = false;
        state.selection = null;
        state.selectedAnnotationIndex = null;
        state.editor = null;
        state.notice = null;
        state.calibration = null;
        releaseFrame();
        notify();
      }

      /** 收尾：不留常驻定时器（D-7）；B1 轮询里的可取消等待在这里被唤醒并停止。 */
      function dispose() {
        state.disposed = true;
        for (const timer of [...timers]) clearTimeout(timer);
        timers.clear();
        for (const entry of [...sleepers]) {
          sleepers.delete(entry);
          entry.resolve(false);
        }
        toastTimer = null;
        for (const waiter of [...attachmentWaiters]) {
          clearTimeout(waiter.timer);
          waiter.resolve(false);
        }
        attachmentWaiters.clear();
        releaseFrame();
        listeners.clear();
      }

      return {
        state,
        subscribe,
        notify,
        setToast,
        setAttachmentCount,
        waitForAttachmentIncrease,
        sleep,
        releaseFrame,
        leaveMode,
        dispose,
      };
    }

    /** 单例：按钮条目与覆盖层条目共享同一个运行时。 */
    const store = createShotStore();

    /** React 侧订阅运行时（低频状态变化才触发重渲染；高频几何走命令式更新）。 */
    function useShotStore() {
      const [, force] = React.useState(0);
      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), []);
      return store;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 抓屏：同源 fetch → Blob → 位图（一次性冻结帧，B-2）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * base64url → 文本（度量头用 base64url 字母表 `-` `_`，无 `=` 填充）。
     * @param {string} value
     * @returns {string}
     */
    function decodeBase64Url(value) {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    }

    /**
     * 读度量头（缺失/损坏时返回 null，抓屏本身不受影响）。
     * @param {string|null} raw
     * @returns {object|null}
     */
    function readCaptureHeader(raw) {
      if (typeof raw !== 'string' || raw === '') return null;
      try {
        const parsed = JSON.parse(decodeBase64Url(raw));
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
      } catch (error) {
        logger.warn('capture header unreadable', errorText(error));
        return null;
      }
    }

    /**
     * @param {unknown} value
     * @param {number} fallback
     * @returns {number} 正整数，否则回退。
     */
    function positiveIntOr(value, fallback) {
      return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
    }

    /** @param {string} url */
    function revokeObjectUrl(url) {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        logger.warn('revokeObjectURL failed', errorText(error));
      }
    }

    /**
     * 把 PNG Blob 解码成可绘制的位图；返回释放函数（关闭位图 + 撤销 URL，D-9）。
     * @param {Blob} blob
     * @returns {Promise<{image: any, width: number, height: number, release: Function}>}
     */
    async function decodeFrozenFrame(blob) {
      const url = URL.createObjectURL(blob);
      if (typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(blob);
          return {
            image: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            release: () => {
              try {
                if (typeof bitmap.close === 'function') bitmap.close();
              } catch (error) {
                logger.warn('bitmap close failed', errorText(error));
              }
              revokeObjectUrl(url);
            },
          };
        } catch (error) {
          logger.warn('createImageBitmap failed, falling back to Image', errorText(error));
        }
      }
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('image.decode.failed'));
        image.src = url;
      });
      if (typeof image.decode === 'function') {
        try {
          await image.decode();
        } catch (error) {
          logger.warn('image.decode rejected', errorText(error));
        }
      }
      return {
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release: () => revokeObjectUrl(url),
      };
    }

    /**
     * 读失败响应里的短提示（宿主失败体：`{"ok":false,"error":"...","message":"..."}`）。
     * @param {Response} response
     * @returns {Promise<string>}
     */
    async function readFailureMessage(response) {
      try {
        const body = await response.json();
        if (body !== null && typeof body === 'object') {
          const message = typeof body.message === 'string' ? body.message : '';
          const code = typeof body.error === 'string' ? body.error : '';
          return [code, message].filter((part) => part !== '').join(': ');
        }
      } catch (error) {
        return '';
      }
      return '';
    }

    /**
     * 用内联的 `normalizeCapture` 校验度量（t1 §7.3 要求）；损坏的度量不该毁掉整次截图，
     * 所以先把字段收敛到“肯定合法”的形状再交给纯逻辑模块 —— 判定规则本身仍只有 lib 那一份。
     * @param {object|null} header
     * @param {number} widthPx
     * @param {number} heightPx
     * @returns {object}
     */
    function normalizeCaptureSafely(header, widthPx, heightPx) {
      const base = {
        widthPx,
        heightPx,
        url: typeof header?.url === 'string' && header.url !== '' ? header.url : CAPTURE_PATH,
        mediaType: 'image/png',
      };
      const extra = {};
      if (isFiniteNumber(header?.scale) && header.scale > 0) extra.scale = header.scale;
      if (isRectLike(header?.bounds)) {
        extra.bounds = { x: header.bounds.x, y: header.bounds.y, width: header.bounds.width, height: header.bounds.height };
      }
      if (isRectLike(header?.viewportCss)) {
        extra.viewportCss = {
          x: header.viewportCss.x,
          y: header.viewportCss.y,
          width: header.viewportCss.width,
          height: header.viewportCss.height,
        };
      }
      if (isFiniteNumber(header?.elapsedMs) && header.elapsedMs > 0) extra.elapsedMs = header.elapsedMs;
      if (isFiniteNumber(header?.bytes) && header.bytes > 0) extra.bytes = header.bytes;
      const metrics = captureModeMetrics(header);
      try {
        return { ...normalizeCapture({ ...base, ...extra }), ...metrics };
      } catch (error) {
        logger.warn('capture descriptor rejected, falling back to bitmap size', errorText(error));
        return { ...normalizeCapture(base), ...metrics };
      }
    }

    /**
     * 抓一帧冻结画面。
     * 契约（t1 §7.3 + 宿主实现）：`GET /api/dsh-screenshot/capture`，成功体是 PNG 字节；
     * 度量在 `X-DSH-Screenshot`（base64url JSON，形状等于 `normalizeCapture` 的输出，自带 `url` 载体）。
     * `vw`/`vh` 让宿主把抓屏时的 CSS 视口写进度量，供覆盖层交叉校验；`fresh=1` 强制重抓，
     * 保证画面就是「点击瞬间」那一帧（B-2）。
     * t52：默认 `mode=through` —— 让宿主先临时隐藏 DSH 再抓屏；只有降级重试才传 `through=false`。
     * @param {number} startedAt - 点击时刻（D-1 计时起点）。
     * @param {boolean} [through] - false = 不隐藏直接抓（降级重试用）。
     * @returns {Promise<object>} 冻结帧描述。
     */
    async function fetchFrozenFrame(startedAt, through) {
      const query = captureQueryFor(through, viewportSize());
      const response = await fetch(`${CAPTURE_PATH}?${query.toString()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const detail = await readFailureMessage(response);
        throw new Error(`HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`);
      }
      const header = readCaptureHeader(response.headers.get(CAPTURE_HEADER));
      const blob = await response.blob();
      if (blob === undefined || blob.size === 0) throw new Error('capture.empty');
      const decoded = await decodeFrozenFrame(blob);
      const widthPx = positiveIntOr(header === null ? undefined : header.widthPx, decoded.width);
      const heightPx = positiveIntOr(header === null ? undefined : header.heightPx, decoded.height);
      return {
        capture: normalizeCaptureSafely(header, widthPx, heightPx),
        blob,
        image: decoded.image,
        width: widthPx,
        height: heightPx,
        release: decoded.release,
        startedAt,
        header,
      };
    }

    /**
     * 点击按钮 / 按 ALT+A → 抓屏 → 进入截图模式（t52：两个入口完全同一条路径）。
     * 抓屏**始终**先临时隐藏 DSH（`mode=through`），抓完由宿主恢复；失败一律可见提示且不进入模式
     * （D-6 / B-12），插件本体与 DSH 其余功能不受影响。
     * 降级（保留）：宿主未加载新代码 / 隐藏失败 / 502 / 恢复未确认 → 可见说明 + 自动改为「不隐藏」抓屏。
     * @param {object} runtime
     * @param {boolean} [through] - false = 不隐藏直接抓（仅降级重试使用，用户没有这个选择权）。
     */
    async function startCapture(runtime, through = true) {
      const state = runtime.state;
      if (state.phase !== 'idle' || state.busy) return;
      const startedAt = nowMs();
      state.phase = 'capturing';
      state.notice = null;
      runtime.notify();
      try {
        const frame = await fetchFrozenFrame(startedAt, through);
        // 宿主口径（t44）：请求了隐藏但无法确认隐藏成功时会**自己回退为不隐藏抓屏**并返回
        // 200 + mode='normal'（图里含 DSH，典型原因：宿主还没加载新代码）。不是失败，
        // 但必须明说这次图里有 DSH 窗口。
        if (through && frame.capture.mode !== CAPTURE_MODE_THROUGH) {
          runtime.setToast('warn', TEXT.throughUnavailable);
          logger.warn('through unavailable, capture includes the DSH window', { actual: frame.capture.mode, hiddenMs: frame.capture.hiddenMs });
        }
        // 恢复未确认（宿主契约里这种情况是 502；这里是防御性判定）：不静默，改为不隐藏抓屏。
        if (through && frame.capture.restoreOk === false) {
          frame.release();
          state.phase = 'idle';
          runtime.notify();
          logger.warn('through capture restore not confirmed, retrying without hiding', { hiddenMs: frame.capture.hiddenMs });
          runtime.setToast('warn', TEXT.throughRestoreFailed);
          await startCapture(runtime, false);
          return;
        }
        runtime.releaseFrame();
        state.frame = frame;
        state.selection = null;
        state.editor = null;
        state.notice = null;
        state.calibration = null;
        state.history.reset([]);
        state.tool = TOOL_MOVE;
        state.phase = 'active';
        runtime.notify();
        logger.info('capture ready', {
          widthPx: frame.capture.widthPx,
          heightPx: frame.capture.heightPx,
          scale: frame.capture.scale,
          bounds: frame.capture.bounds,
          viewportCss: frame.capture.viewportCss,
          bytes: frame.capture.bytes,
          hostElapsedMs: frame.capture.elapsedMs,
          // t45/t52：抓屏方式度量（字段名与宿主 describe() 逐字一致，validate X-1 覆盖）
          mode: frame.capture.mode,
          hiddenMs: frame.capture.hiddenMs,
          restoreOk: frame.capture.restoreOk,
          requestedHide: through,
        });
      } catch (error) {
        const detail = errorText(error);
        state.phase = 'idle';
        runtime.notify();
        logger.warn('capture failed', detail);
        if (through) {
          // 隐藏/抓屏/超时/恢复失败/502 → 可见提示 + 自动改为「不隐藏」抓屏（绝不静默）。
          runtime.setToast('warn', `${TEXT.throughFailed}（${detail}）`);
          await startCapture(runtime, false);
          return;
        }
        const unsupported = /HTTP 404/.test(detail);
        runtime.setToast('error', `${unsupported ? TEXT.captureUnsupported : TEXT.captureFailed}（${detail}）`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // B1：独立全屏截图面板（默认路径，t59）
    //
    // 用户 2026-09-30 拍板的架构：截图**不在 DSH 窗口里**做，而是在真实屏幕上做 ——
    //   ① `POST /overlay/start`：宿主先临时隐藏 DSH → 抓一帧 → 恢复 DSH → 拉起系统浏览器
    //      kiosk 全屏窗口（覆盖整屏含任务栏），打开宿主自己提供的覆盖层页面；
    //   ② 用户在那个窗口里按真实屏幕坐标 1:1 框选并标注；
    //   ③ 页面只把「动作名 + 只含选区与标注的 PNG」交回宿主；本半轮询状态并在 **DSH 内**
    //      执行动作（插入对话走已验证的 paste 桥接 / 复制写系统剪贴板 / 另存为弹系统对话框）。
    //
    // 不可用时（无浏览器 / 宿主未加载该路由 / start 失败）**不静默**：可见提示 + 回退到下面
    // 那条既有的「DSH 内覆盖层」流程（`startCapture`，完整保留，功能不缺失）。
    //
    // 轮询纪律（D-7）：终态即停；总时长有上限；连续失败有上限；组件卸载时 `store.sleep()`
    // 被唤醒返回 false，循环立刻退出 —— 任何路径都不留常驻定时器。
    // ─────────────────────────────────────────────────────────────────────────
    /** 开始一次覆盖层会话（宿主隐藏 DSH → 抓屏 → 恢复 → 拉起 kiosk 窗口）。 */
    const OVERLAY_START_PATH = '/api/dsh-screenshot/overlay/start';
    /** 会话状态（本半轮询它直到终态）。 */
    const OVERLAY_STATUS_PATH = '/api/dsh-screenshot/overlay/status';
    /** 标注后的结果 PNG（只含选区 + 标注；`ready` 时取）。 */
    const OVERLAY_RESULT_PNG_PATH = '/api/dsh-screenshot/overlay/result.png';
    /** 轮询间隔（ms）：既让状态及时可见，也不给宿主制造压力。 */
    const OVERLAY_POLL_MS = 250;
    /** 轮询总上限（ms）：宿主会话上限 120 s，这里留余量后自己收口（到点即停，不永久忙态）。 */
    const OVERLAY_POLL_DEADLINE_MS = 150_000;
    /** 连续失败上限（≈8 × 250 ms）：宿主重启/路由消失时不要一直转圈。 */
    const OVERLAY_POLL_FAILURE_LIMIT = 8;
    /** 会话终态（与宿主 `session.state` 逐字一致）。 */
    const OVERLAY_TERMINAL_STATES = Object.freeze(['ready', 'cancelled', 'aborted', 'timeout']);
    /** 页面可提交的动作（与宿主 `OVERLAY_ACTIONS` 逐字一致，validate X-1 两侧比对）。 */
    const OVERLAY_ACTIONS = Object.freeze(['insert', 'copy', 'save']);

    /**
     * 会话状态（纯逻辑）：形状不对一律 `'unknown'`，绝不把脏数据当终态。
     * @param {unknown} body
     * @returns {string}
     */
    function overlayStateOf(body) {
      const value = body !== null && typeof body === 'object' ? /** @type {{ state?: unknown }} */ (body).state : undefined;
      return typeof value === 'string' && value !== '' ? value : 'unknown';
    }

    /**
     * 页面提交的动作（纯逻辑）：冻结集合之外一律 null（宿主也会 400 拒掉）。
     * @param {unknown} body
     * @returns {'insert'|'copy'|'save'|null}
     */
    function overlayActionOf(body) {
      const value = body !== null && typeof body === 'object' ? /** @type {{ action?: unknown }} */ (body).action : undefined;
      return OVERLAY_ACTIONS.includes(value) ? value : null;
    }

    /** @param {string} state @returns {boolean} 是否已是终态（到了就停止轮询）。 */
    function isOverlayTerminal(state) {
      return OVERLAY_TERMINAL_STATES.includes(state);
    }

    /**
     * 覆盖层路由的查询串：token 必需（与宿主 `overlayParam(url, 'token')` 两侧一致）。
     * @param {string} token
     * @returns {string}
     */
    function overlayQuery(token) {
      return `?token=${encodeURIComponent(token)}`;
    }

    /**
     * 面板不可用时的可见提示（纯判定）：
     * 无浏览器与"路由不存在/启动失败"给不同措辞，但都会回退 DSH 内流程。
     * @param {unknown} reason
     * @returns {string}
     */
    function overlayFallbackNotice(reason) {
      const detail = typeof reason === 'string' ? reason : '';
      if (detail.includes('no-browser')) return TEXT.overlayNoBrowser;
      return detail === '' ? TEXT.overlayFallback : `${TEXT.overlayFallback}（${detail}）`;
    }

    /**
     * 非成功终态的可见提示（纯判定）。
     * @param {string} state
     * @returns {{kind: string, text: string}|null} null = 这条终态不需要这种提示（成功/取消各自处理）。
     */
    function overlayProblemNotice(state) {
      if (state === 'aborted') return { kind: 'error', text: TEXT.overlayAborted };
      if (state === 'timeout') return { kind: 'error', text: TEXT.overlayTimeout };
      if (state === 'unreachable') return { kind: 'error', text: TEXT.overlayUnreachable };
      return null;
    }

    /**
     * 读取 JSON 响应体：解析失败给 null，由调用方按"形状不对"处理（不抛、不静默当成成功）。
     * @param {any} response
     * @returns {Promise<any>}
     */
    async function readJsonBody(response) {
      try {
        return await response.json();
      } catch (error) {
        return null;
      }
    }

    /**
     * 发起一次独立覆盖层会话（宿主 t56 的 `POST /overlay/start`）。
     * 成功时宿主已经完成「（按模式）隐藏 DSH → 抓帧 → 恢复」，kiosk 窗口正在拉起；本半只拿 token。
     * @param {string} [mode] - `through`（默认，先隐藏 DSH）或 `normal`（不隐藏，画面含 DSH）。
     * @param {Function} [fetchImpl] - 注入点（离线用例用假 fetch 真实驱动）。
     * @returns {Promise<{ok: boolean, token?: string, reused?: boolean, mode?: string, reason?: string}>}
     */
    async function startOverlaySession(mode = CAPTURE_MODE_THROUGH, fetchImpl = fetch) {
      try {
        // 模式写在查询串上（与宿主 `overlayParam(url, 'mode')` 两侧一致）。
        const query = new URLSearchParams();
        query.set('mode', normalizeCaptureMode(mode));
        const response = await fetchImpl(`${OVERLAY_START_PATH}?${query.toString()}`, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (response === undefined || response === null || response.ok !== true) {
          const status = response !== undefined && response !== null ? response.status : 'unknown';
          return { ok: false, reason: `overlay.start http ${status}` };
        }
        const body = await readJsonBody(response);
        if (body === null || typeof body !== 'object' || body.ok !== true || typeof body.token !== 'string' || body.token === '') {
          const reason = body !== null && typeof body === 'object' && typeof body.reason === 'string' ? body.reason : 'overlay.start-failed';
          return { ok: false, reason };
        }
        return { ok: true, token: body.token, reused: body.reused === true, mode: typeof body.mode === 'string' ? body.mode : undefined };
      } catch (error) {
        return { ok: false, reason: `overlay.start ${errorText(error)}` };
      }
    }

    /**
     * 轮询一次会话直到终态。**依赖全部注入**（fetch / now / sleep），所以离线用例可以把四条
     * 路径真实跑一遍，不需要浏览器、也不需要宿主。
     *
     * 收口规则（"轮询在终态停止、不留常驻定时器"）：
     * - 终态（`ready` / `cancelled` / `aborted` / `timeout`）→ 立刻返回；
     * - 连续失败达到 {@link OVERLAY_POLL_FAILURE_LIMIT} → `unreachable`（宿主没了就别再转圈）；
     * - 总时长达到 {@link OVERLAY_POLL_DEADLINE_MS} → `timeout`（自己收口，不依赖宿主）；
     * - `sleep` 返回 false（组件已卸载）→ `unmounted`（调用方什么都不做）。
     * @param {string} token
     * @param {{fetch: Function, now: Function, sleep: (ms: number) => Promise<boolean>}} deps
     * @returns {Promise<{state: string, action: 'insert'|'copy'|'save'|null, polls: number, elapsedMs: number, unmounted: boolean}>}
     */
    async function pollOverlaySession(token, deps) {
      const fetchImpl = deps.fetch;
      const now = deps.now;
      const startedAt = now();
      let polls = 0;
      let failures = 0;
      for (;;) {
        polls += 1;
        let state = 'unknown';
        let action = null;
        try {
          const response = await fetchImpl(`${OVERLAY_STATUS_PATH}${overlayQuery(token)}`, {
            cache: 'no-store',
            credentials: 'same-origin',
          });
          if (response !== undefined && response !== null && response.ok === true) {
            const body = await readJsonBody(response);
            state = overlayStateOf(body);
            action = overlayActionOf(body);
          }
        } catch (error) {
          state = 'unknown';
        }
        failures = state === 'unknown' ? failures + 1 : 0;
        const elapsedMs = Math.round(now() - startedAt);
        if (isOverlayTerminal(state)) return { state, action, polls, elapsedMs, unmounted: false };
        if (failures >= OVERLAY_POLL_FAILURE_LIMIT) return { state: 'unreachable', action: null, polls, elapsedMs, unmounted: false };
        if (elapsedMs >= OVERLAY_POLL_DEADLINE_MS) return { state: 'timeout', action: null, polls, elapsedMs, unmounted: false };
        const alive = await deps.sleep(OVERLAY_POLL_MS);
        if (alive === false) return { state: 'unmounted', action: null, polls, elapsedMs: Math.round(now() - startedAt), unmounted: true };
      }
    }

    /**
     * 取回覆盖层提交的结果 PNG（只含选区 + 标注；宿主只在 `ready` 后提供）。
     * @param {string} token
     * @param {Function} [fetchImpl]
     * @returns {Promise<Blob|null>} null = 拿不到（调用方给可见提示，不静默）
     */
    async function fetchOverlayResult(token, fetchImpl = fetch) {
      try {
        const response = await fetchImpl(`${OVERLAY_RESULT_PNG_PATH}${overlayQuery(token)}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (response === undefined || response === null || response.ok !== true) return null;
        const blob = await response.blob();
        return blob !== undefined && blob !== null && typeof blob.size === 'number' && blob.size > 0 ? blob : null;
      } catch (error) {
        logger.warn('overlay result fetch failed', errorText(error));
        return null;
      }
    }

    /**
     * 在 DSH 侧执行面板选定的动作 —— **动作永远在 DSH 里做**（这是刻意的分工）：
     * 插入对话必须走已验证的 paste 桥接、复制写系统剪贴板、另存为弹系统对话框；
     * 面板只交回 `{ action, png }`，自己不碰剪贴板、不写文件。
     * 依赖注入便于离线用例真实驱动三条动作。
     * @param {'insert'|'copy'|'save'} action
     * @param {Blob} blob - 面板交回的 PNG 字节。
     * @param {object} runtime
     * @param {{insert?: Function, copy?: Function, save?: Function}} [deps]
     * @returns {Promise<{ok: boolean, method: string, kind: string, text: string}>} 结果直接喂给 `setToast`。
     */
    async function deliverOverlayResult(action, blob, runtime, deps = {}) {
      const insert = deps.insert ?? ((value) => insertIntoConversation(runtime, value, PNG_MIME));
      const copy = deps.copy ?? ((value) => copyPngToClipboard(value, {}, PNG_MIME));
      const save = deps.save ?? ((value) => savePngAs(value, {}, PNG_MIME));
      if (action === 'copy') {
        const copied = await copy(blob);
        return copied.ok
          ? { ok: true, method: 'clipboard', kind: 'success', text: TEXT.toastCopied }
          : { ok: false, method: 'clipboard', kind: 'error', text: `${TEXT.copyFailed}（${copied.reason}）` };
      }
      if (action === 'save') {
        const saved = await save(blob);
        if (saved.ok) {
          return {
            ok: true,
            method: saved.method ?? 'download',
            kind: 'success',
            text: saved.method === 'picker' ? TEXT.toastSaved : TEXT.toastSavedDownload,
          };
        }
        // 用户在系统对话框里点了取消：不是失败，也不该报错（与 DSH 内流程同一条口径）。
        if (saved.reason === 'save.cancelled') return { ok: false, method: 'picker', kind: 'info', text: '' };
        return { ok: false, method: saved.method ?? 'picker', kind: 'error', text: `${TEXT.saveFailed}（${saved.reason}）` };
      }
      const inserted = await insert(blob);
      return { ok: inserted.ok === true, method: inserted.method, kind: inserted.kind, text: inserted.text };
    }

    /**
     * 截图入口（图标左键与 ALT+A **共用这一条**）：先走 B1 独立全屏面板，
     * 不可用则可见提示 + 回退 DSH 内覆盖层流程（`startCapture`）。
     *
     * 全程有忙态（`phase = 'capturing'` → 按钮禁用 + `aria-busy` + 进度光标），任何路径都会
     * 把 phase 放回 `idle`：不存在"永久转圈"。
     * @param {object} runtime
     * @param {{startSession?: Function, poll?: Function, fetchResult?: Function, deliver?: Function, capture?: Function}} [deps]
     *   - 注入点：离线用例用假实现真实驱动四条路径（start 成功 / no-browser 回退 / 异常终态 / 取消）。
     * @returns {Promise<void>}
     */
    async function startShot(runtime, deps = {}) {
      const state = runtime.state;
      if (state.phase !== 'idle' || state.busy) return;
      const startedAt = nowMs();
      state.phase = 'capturing';
      state.notice = null;
      runtime.notify();
      // t74c：抓屏前先跟宿主对一次模式。插件配置页是**另一棵 React 树**，它改完只写了宿主配置，
      // 本进程内存里那份不会自己变 —— 用户实测"配置页能切，但截图仍按右键菜单的旧选择来"。
      // 一次本机 GET 很便宜，换来"无论从哪里改的，下一次截图都用最新值"。
      await loadCaptureMode(runtime, deps.fetch ?? (typeof fetch === 'function' ? fetch : undefined));
      const startSession = deps.startSession ?? startOverlaySession;
      const poll = deps.poll ?? ((token) => pollOverlaySession(token, {
        fetch: typeof fetch === 'function' ? fetch : undefined,
        now: nowMs,
        sleep: (ms) => runtime.sleep(ms),
      }));
      const fetchResult = deps.fetchResult ?? fetchOverlayResult;
      const deliver = deps.deliver ?? ((action, blob) => deliverOverlayResult(action, blob, runtime));
      const capture = deps.capture ?? startCapture;
      // t67：右键菜单选的模式决定"抓屏前要不要隐藏 DSH"，两条路径都得带上它 ——
      // 面板路径交给宿主（`?mode=`），回退路径交给 `startCapture(runtime, through)`。
      const mode = normalizeCaptureMode(state.captureMode);
      const through = mode !== CAPTURE_MODE_NORMAL;

      const started = await startSession(mode);
      if (started === null || started === undefined || started.ok !== true) {
        const reason = started !== null && started !== undefined && typeof started.reason === 'string' ? started.reason : '';
        state.phase = 'idle';
        runtime.notify();
        runtime.setToast('warn', overlayFallbackNotice(reason));
        logger.warn('screenshot overlay unavailable, falling back to the in-DSH overlay', {
          reason: reason === '' ? 'unknown' : reason,
          mode,
          elapsedMs: Math.round(nowMs() - startedAt),
        });
        await capture(runtime, through);
        return;
      }

      try {
        runtime.setToast('info', mode === CAPTURE_MODE_NORMAL ? TEXT.toastNormalMode : TEXT.overlayOpened);
        const outcome = await poll(started.token);
        state.phase = 'idle';
        runtime.notify();
        if (outcome.state === 'unmounted') return;
        // 面板窗口此刻正在关闭（或已关闭）：先把焦点抢回输入框 —— 后面无论走插入（合成 paste
        // 事件派发到编辑器）还是复制（`navigator.clipboard.write` 要求文档处于聚焦状态），
        // 都在"DSH 已聚焦"的前提下进行。
        focusComposer(runtime);
        if (outcome.state === 'cancelled') {
          // 取消 = 无副作用退出：不产图、不写剪贴板、不动草稿（B-4）。
          logger.info('screenshot overlay cancelled', { polls: outcome.polls, elapsedMs: outcome.elapsedMs });
          runtime.setToast('info', TEXT.toastOverlayCancelled);
          return;
        }
        if (outcome.state !== 'ready') {
          const problem = overlayProblemNotice(outcome.state);
          logger.warn('screenshot overlay ended without a result', {
            state: outcome.state,
            polls: outcome.polls,
            elapsedMs: outcome.elapsedMs,
          });
          runtime.setToast(problem === null ? 'error' : problem.kind, problem === null ? TEXT.overlayAborted : problem.text);
          return;
        }

        const action = outcome.action ?? 'insert';
        const blob = await fetchResult(started.token);
        if (blob === null) {
          logger.warn('screenshot overlay result missing', { action, polls: outcome.polls });
          runtime.setToast('error', TEXT.overlayResultFailed);
          return;
        }
        const result = await deliver(action, blob);
        logger.info('screenshot overlay result applied', {
          action,
          ok: result.ok === true,
          method: result.method,
          bytes: blob.size,
          polls: outcome.polls,
          waitMs: outcome.elapsedMs,
          totalMs: Math.round(nowMs() - startedAt),
        });
        if (typeof result.text === 'string' && result.text !== '') runtime.setToast(result.kind, result.text);
      } catch (error) {
        // 未预料的异常也要有可见反馈（B-12：绝不静默失败）。
        logger.warn('screenshot overlay flow failed', errorText(error));
        runtime.setToast('error', `${TEXT.outputFailed}：${errorText(error)}`);
      } finally {
        // 兜底：任何路径（含上面那条 catch，或 `poll`/`deliver` 自己的异常）都不许把界面留在忙态。
        if (state.phase !== 'idle') {
          state.phase = 'idle';
          runtime.notify();
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 标定：覆盖层 CSS 空间 ↔ 冻结帧位图空间（PRD 6.3-9/10，t1 §7.3）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 计算一次标定。冻结帧（整块主屏）**整体等比贴合到覆盖层盒**，
     * 于是「覆盖层上看到的」与「导出的」用同一个比例：
     *
     * - `scale` = 内联 `calibrateCapture` 的 `displayScale` = `effectiveScale(capture, box)`
     *   = 「位图像素 / 覆盖层 CSS 像素」（两轴比值均值）。绘制变换、`planRender` 的映射、
     *   导出裁剪三处都用这一个数，不存在各算各的。
     * - **不传 `window.screenX/screenY`**：宿主位图已是整块主屏，再叠加窗口屏幕偏移会二次
     *   计入（`planRender` 注释里警告的那种情况），裁出来的图会整体错位。窗口非最大化时
     *   `calibrateCapture` 会给出 `degraded: true` / `reason: 'screen-scale'` —— 这是**信息性**
     *   标记（位图/屏幕比 ≠ 位图/覆盖层盒比），不影响映射，只用于日志与一句提示。
     * - `screen` 恒为 `(0,0)`，因此 `device = css * scale`（无偏移项）。
     * - `viewportMatch`：宿主抓屏时上报的 CSS 视口与实测覆盖层盒是否一致（PRD 6.3-4 的交叉校验）。
     * @param {object} capture
     * @param {{width: number, height: number}} box - 覆盖层 CSS 盒。
     * @param {number} dpr
     * @returns {object}
     */
    function calibrateFrame(capture, box, dpr) {
      const measured = box.width > 0 && box.height > 0 ? box : { width: capture.widthPx, height: capture.heightPx };
      const calibration = calibrateCapture(capture, { overlay: measured, dpr });
      const scale = isFiniteNumber(calibration.displayScale) && calibration.displayScale > 0
        ? calibration.displayScale
        : 1;
      const viewportMatch = isRectLike(capture.viewportCss)
        ? Math.abs(capture.viewportCss.width - measured.width) <= 2
          && Math.abs(capture.viewportCss.height - measured.height) <= 2
        : null;
      return {
        scale,
        surface: measured,
        screen: { x: 0, y: 0 },
        dpr,
        degraded: calibration.degraded === true,
        method: calibration.method,
        reason: calibration.reason,
        deviceScale: calibration.deviceScale,
        screenScale: calibration.screenScale,
        viewportMatch,
        frameBox: { width: capture.widthPx / scale, height: capture.heightPx / scale },
      };
    }

    /**
     * 交给 `planRender` 的选项：`overlay` 就是覆盖层盒（displayScale === cal.scale），不带 screen。
     * @param {object} calibration
     * @returns {object}
     */
    function planOptionsFor(calibration) {
      return {
        maxEdge: MAX_OUTPUT_EDGE,
        overlay: calibration.surface,
        dpr: calibration.dpr,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 画布与临时画布池
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 马赛克要的临时画布池（内联 `drawMosaic` 每次绘制请求两块面）：
     * 复用而不是每帧分配 4K 画布，退出时释放（D-2 / D-9）。
     * @returns {{reset: Function, create: Function, release: Function}}
     */
    function createScratchPool() {
      /** @type {Array<{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}>} */
      const surfaces = [];
      let cursor = 0;
      return {
        reset() {
          cursor = 0;
        },
        /**
         * @param {number} width
         * @param {number} height
         * @returns {CanvasRenderingContext2D|null}
         */
        create(width, height) {
          const index = cursor;
          cursor += 1;
          const neededWidth = Math.max(1, Math.ceil(width));
          const neededHeight = Math.max(1, Math.ceil(height));
          let surface = surfaces[index];
          if (surface === undefined) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (ctx === null) return null;
            surface = { canvas, ctx };
            surfaces[index] = surface;
          }
          // 只增不减：画布变大由浏览器重新分配并清空，正好是马赛克需要的干净面。
          if (surface.canvas.width < neededWidth) surface.canvas.width = neededWidth;
          if (surface.canvas.height < neededHeight) surface.canvas.height = neededHeight;
          return surface.ctx;
        },
        release() {
          for (const surface of surfaces) {
            surface.canvas.width = 0;
            surface.canvas.height = 0;
          }
          surfaces.length = 0;
          cursor = 0;
        },
      };
    }

    /**
     * @param {HTMLCanvasElement|null} canvas
     * @param {number} cssWidth
     * @param {number} cssHeight
     * @param {number} dpr
     */
    function sizeCanvas(canvas, cssWidth, cssHeight, dpr) {
      if (canvas === null || canvas === undefined) return;
      const width = Math.max(1, Math.round(cssWidth * dpr));
      const height = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 导出：选区 + 标注 → PNG（>4 MB 按 D-8 降级）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {string} mediaType
     * @param {number|undefined} quality
     * @returns {Promise<Blob|null>}
     */
    function encodeCanvas(canvas, mediaType, quality) {
      return new Promise((resolve) => {
        try {
          canvas.toBlob((blob) => resolve(blob), mediaType, quality);
        } catch (error) {
          logger.warn('toBlob threw', errorText(error));
          resolve(null);
        }
      });
    }

    /**
     * 给一个 promise 加硬上限（t29）——「任何路径都不得永久忙态」的纯逻辑底座。
     *
     * 语义：始终 settle，且**只 settle 一次**。
     * - 原 promise 先完成 → `{ok: true, timedOut: false, value}`；
     * - 原 promise 先抛错 → `{ok: false, timedOut: false, error}`（调用方决定可见提示）；
     * - 上限先到 → `{ok: false, timedOut: true}`，此后原 promise 的结果被丢弃
     *   （`canvas.toBlob` 无法取消，晚到的回调不会二次改变界面状态）。
     *
     * `timers` 可注入（测试用假定时器驱动，不依赖真实等待）。默认实现必须**箭头函数包一层**：
     * 直接把 `setTimeout` 取出来放进对象再 `timers.set(...)` 调用，浏览器会按 `this=timers`
     * 调用宿主函数并抛 `Illegal invocation`（Node 不复现 —— t29 真机验证时实测到，已改）。
     * @param {Promise<unknown>} promise
     * @param {number} timeoutMs
     * @param {{set: Function, clear: Function}} [timers]
     * @returns {Promise<{ok: boolean, timedOut: boolean, value?: unknown, error?: unknown}>}
     */
    function withDeadline(promise, timeoutMs, timers = {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle),
    }) {
      return new Promise((resolve) => {
        let settled = false;
        /** @param {{ok: boolean, timedOut: boolean, value?: unknown, error?: unknown}} outcome */
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          timers.clear(timer);
          resolve(outcome);
        };
        const timer = timers.set(() => finish({ ok: false, timedOut: true }), timeoutMs);
        Promise.resolve(promise).then(
          (value) => finish({ ok: true, timedOut: false, value }),
          (error) => finish({ ok: false, timedOut: false, error }),
        );
      });
    }

    /**
     * 把冻结帧的选区块 + 标注画到一张新画布。
     * 标注与冻结帧共用 device 像素坐标系，这里只做一次「裁剪 + 缩放」变换，
     * 内联的 `drawAnnotation` 不需要知道裁剪存在。
     * @param {object} frame
     * @param {object} plan
     * @param {{width: number, height: number}} attempt
     * @param {Array<object>} annotations
     * @param {number} mosaicStep
     * @param {{reset: Function, create: Function, release: Function}} pool - 马赛克临时画布池（由调用方持有并释放）
     * @returns {HTMLCanvasElement|null}
     */
    function renderSelection(frame, plan, attempt, annotations, mosaicStep, pool) {
      const width = Math.max(1, Math.round(attempt.width));
      const height = Math.max(1, Math.round(attempt.height));
      if (plan.deviceRect.width <= 0 || plan.deviceRect.height <= 0) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return null;
      const scaleX = width / plan.deviceRect.width;
      const scaleY = height / plan.deviceRect.height;
      ctx.setTransform(scaleX, 0, 0, scaleY, -plan.deviceRect.x * scaleX, -plan.deviceRect.y * scaleY);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(frame.image, 0, 0);
      const environment = {
        mosaicSource: frame.image,
        mosaicSourceRect: { x: 0, y: 0, width: frame.width, height: frame.height },
        createScratch: (scratchWidth, scratchHeight) => pool.create(scratchWidth, scratchHeight),
        mosaicStep,
      };
      for (const annotation of annotations) {
        pool.reset();
        drawAnnotation(ctx, annotation, environment);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
    }

    /**
     * 编码选区输出：按内联 `sizeAttempts` 的顺序尝试，第一个不超过阈值的产物胜出；
     * 全部超限时用最后一个（WebP 最低质量）兜底 —— 绝不因为体积拒绝输出。
     * @param {object} frame
     * @param {object} selectionCss
     * @param {object} calibration
     * @param {Array<object>} annotations
     * @param {number} mosaicStep
     * @returns {Promise<object>}
     */
    async function encodeSelection(frame, selectionCss, calibration, annotations, mosaicStep) {
      const plan = planRender(frame.capture, selectionCss, planOptionsFor(calibration));
      if (!plan.valid) {
        return { ok: false, reason: plan.clipped ? 'selection.clipped' : 'selection.tooSmall', plan };
      }
      const policy = resolveSizePolicy({
        maxEdge: MAX_OUTPUT_EDGE,
        maxBytes: MAX_OUTPUT_BYTES,
        allowLossy: true,
        allowLogicalDownscale: true,
      });
      const attempts = sizeAttempts(plan, policy);
      const pool = createScratchPool();
      // U-03：降级链里多数尝试的**像素尺寸完全相同**（本机 100% 缩放下 png-full 与各档 WebP 同尺寸），
      // 逐次重绘整张选区是纯浪费（全屏选区一次就是 3440×1440）。这里按尺寸缓存渲染结果，
      // 同一尺寸只画一次、多次编码复用；像素结果与逐次重绘逐字一致。
      let rendered = { key: null, canvas: null };
      let encodes = 0;
      let renderedPixels = 0;
      let lastReason = 'encode.failed';
      const releaseRendered = () => {
        if (rendered.canvas !== null) {
          rendered.canvas.width = 0;
          rendered.canvas.height = 0;
        }
        rendered = { key: null, canvas: null };
      };
      try {
        for (const attempt of attempts) {
          const key = `${Math.round(attempt.width)}x${Math.round(attempt.height)}`;
          if (rendered.key !== key) {
            releaseRendered();
            rendered = {
              key,
              canvas: renderSelection(frame, plan, attempt, annotations, mosaicStep, pool),
            };
            renderedPixels += Math.max(1, Math.round(attempt.width)) * Math.max(1, Math.round(attempt.height));
          }
          const canvas = rendered.canvas;
          if (canvas === null) {
            lastReason = 'canvas.unavailable';
            continue;
          }
          const width = canvas.width;
          const height = canvas.height;
          const encodeAt = nowMs();
          const blob = await encodeCanvas(canvas, attempt.mediaType, attempt.quality);
          encodes += 1;
          const encodeMs = Math.round(nowMs() - encodeAt);
          if (blob === null || blob.size === 0) {
            lastReason = 'encode.null';
            continue;
          }
          const fits = blob.size <= policy.maxBytes;
          const isLast = attempt === attempts[attempts.length - 1];
          if (fits || isLast) {
            logger.info('encoded selection', {
              attempt: attempt.id,
              mediaType: attempt.mediaType,
              width,
              height,
              bytes: blob.size,
              maxBytes: policy.maxBytes,
              downgraded: attempt.id !== 'png-full',
              deviceRect: plan.deviceRect,
              scale: plan.scale,
              encodeMs,
              attempts: attempts.length,
              encodes,
              renderedPixels,
            });
            return {
              ok: true,
              blob,
              plan,
              attempt,
              // 产物标签的唯一来源：真正用过的编码 MIME（R-01）。降级到 WebP 后，
              // 剪贴板类型 / 文件扩展名 / 另存为默认名 / File.type 都跟着它走。
              mediaType: attempt.mediaType,
              width,
              height,
              downgraded: attempt.id !== 'png-full',
              // U-03 的耗时构成：计划尝试数、真正编码次数、重绘像素总量（渲染复用前 = 每次尝试都算一遍）。
              attempts: attempts.length,
              encodes,
              renderedPixels,
            };
          }
          lastReason = `over-budget:${attempt.id}`;
        }
        return { ok: false, reason: lastReason, plan };
      } finally {
        releaseRendered();
        pool.release();
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 输出三动作：插入对话（默认）/ 复制 / 另存为（t1 §4.2 冻结）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 把焦点还回输入框（B-10「插入后焦点回输入框」）。
     * 有宿主动作就用动作；否则从按钮自身祖先里找输入控件（只读 DOM、不改 DOM，找不到就退回按钮）。
     * @param {object} runtime
     */
    function focusComposer(runtime) {
      try {
        const state = runtime.state;
        const button = state.buttonEl;
        let root = button === null || button === undefined ? null : button.parentElement;
        for (let depth = 0; depth < 8 && root !== null; depth += 1) {
          const input = root.querySelector('textarea, [contenteditable="true"]');
          if (input !== null && typeof input.focus === 'function') {
            input.focus();
            return;
          }
          root = root.parentElement;
        }
        if (button !== null && button !== undefined && typeof button.focus === 'function') button.focus();
      } catch (error) {
        logger.warn('focus restore failed', errorText(error));
      }
    }

    /**
     * `useInput` 的选择器：取当前草稿附件列表（`attachmentIds` 优先，`attachments` 兜底）。
     * 选择器必须返回**稳定引用**（这里直接返回输入状态里的数组），否则会让订阅它的组件反复重渲染。
     * @param {unknown} inputState
     * @returns {readonly unknown[]|undefined}
     */
    function selectAttachmentIds(inputState) {
      if (inputState === null || inputState === undefined || typeof inputState !== 'object') return undefined;
      if (Array.isArray(inputState.attachmentIds)) return inputState.attachmentIds;
      if (Array.isArray(inputState.attachments)) return inputState.attachments;
      return undefined;
    }

    /** @param {unknown} element @returns {boolean} 元素是否真的可见（有布局盒）。 */
    function isVisibleElement(element) {
      if (element === null || element === undefined) return false;
      const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
      return rect !== null && rect !== undefined && rect.width > 0 && rect.height > 0;
    }

    /**
     * 找输入框的可编辑元素（官方 paste 命令就注册在它上面）。
     * 优先从截图按钮自身的祖先链里找（避开设置面板之类的其它可编辑区），再退到全文档第一个可见项。
     * @param {object} runtime
     * @returns {Element|null}
     */
    function findComposerEditor(runtime) {
      if (typeof document === 'undefined') return null;
      const button = runtime.state.buttonEl;
      let scope = button === null || button === undefined ? null : button.parentElement;
      for (let depth = 0; depth < 8 && scope !== null; depth += 1) {
        const found = typeof scope.querySelector === 'function' ? scope.querySelector('[contenteditable="true"], textarea') : null;
        if (isVisibleElement(found)) return found;
        scope = scope.parentElement;
      }
      try {
        const fallback = document.querySelector('[contenteditable="true"], textarea');
        return isVisibleElement(fallback) ? fallback : null;
      } catch (error) {
        logger.warn('editor lookup failed', errorText(error));
        return null;
      }
    }

    /**
     * 插入对话（默认动作，PRD F-20 / DoD B-10）——**经官方 paste intake 桥接**：
     *
     * `dsh-client-ui-conversation/lib/client.js:16642-16664` 里编辑器注册的 paste 命令会遍历
     * `event.clipboardData.items`，把 `kind === "file"` 的项交给 `handlers.intakeFiles(files, directories)`，
     * 也就是 composer.bar 的 addFiles → createDrafts → 输入框上方出现附件缩略图（图片附件不走后台上传）。
     * 这里构造同一个 `ClipboardEvent('paste')`（DataTransfer 里放一张 File，声明的是实际编码格式 ——
     * R-01：降级产物是 WebP 时就是 `image/webp`/`.webp`）派发到可编辑元素上，
     * 复用与「用户自己 Ctrl+V 粘贴图片」完全相同的代码路径 —— 不伪造附件 id、不猜内部字段。
     *
     * 成功判据是硬的：`useInput(s => s.attachmentIds)` 的长度在确认窗口内增加
     * （`useInput` 是 `conversation.input.right` 的标准 prop，runner 3312）。
     * U-03：等待改为**事件驱动** —— 数量一变化就立刻结束，不再按固定间隔空转；
     * 窗口上限 `INSERT_CONFIRM_MS` 仍然保留（拿不到信号就按失败走降级）。
     * 拿不到该信号、或数量没有增加 → 一律退回「复制到剪贴板 + 可见提示」，绝不静默失败（B-12）。
     * @param {object} runtime
     * @param {Blob} blob
     * @param {string} [mediaType] - 实际编码格式（`image/png` / `image/webp`），
     *   决定 File 的 MIME 与扩展名（R-01）。
     * @returns {Promise<{ok: boolean, method: string, kind: string, text: string}>}
     */
    async function insertIntoConversation(runtime, blob, mediaType = PNG_MIME) {
      const before = runtime.state.attachmentCount;
      if (typeof before === 'number') {
        const editor = findComposerEditor(runtime);
        const canBridge = editor !== null
          && typeof DataTransfer === 'function'
          && typeof ClipboardEvent === 'function';
        if (canBridge) {
          try {
            const file = pngFileOf(blob, new Date(), mediaType);
            const transfer = new DataTransfer();
            transfer.items.add(file);
            if (typeof editor.focus === 'function') editor.focus();
            editor.dispatchEvent(new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            }));
            const dispatchAt = nowMs();
            const grew = await runtime.waitForAttachmentIncrease(before, INSERT_CONFIRM_MS);
            if (grew) {
              logger.info('paste bridge accepted', { baseline: before, waitMs: Math.round(nowMs() - dispatchAt) });
              return { ok: true, method: 'paste', kind: 'success', text: TEXT.toastInserted };
            }
            logger.warn('paste bridge: attachment count did not grow', {
              baseline: before,
              waitMs: Math.round(nowMs() - dispatchAt),
            });
          } catch (error) {
            logger.warn('paste bridge failed', errorText(error));
          }
        } else {
          logger.warn('paste bridge unavailable', {
            editor: editor !== null,
            transfer: typeof DataTransfer,
            event: typeof ClipboardEvent,
          });
        }
      }
      // 降级（B-12 的可见回退）：写系统剪贴板并明确提示手动粘贴。
      const copied = await copyPngToClipboard(blob, {}, mediaType);
      if (copied.ok) return { ok: true, method: 'clipboard', kind: 'warn', text: TEXT.toastCopiedPaste };
      return { ok: false, method: 'clipboard', kind: 'error', text: `${TEXT.insertFailed}（${copied.reason}）` };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 图标（内联 SVG，颜色一律 currentColor 跟随主题令牌）
    // ─────────────────────────────────────────────────────────────────────────

    /** @param {{size?: number, busy?: boolean}} props */
    function CameraIcon(props) {
      const size = props.size ?? 16;
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', {
          d: 'M2.4 4.6h2.2l.9-1.5h3l.9 1.5h2.2c.55 0 1 .45 1 1v5.3c0 .55-.45 1-1 1H2.4c-.55 0-1-.45-1-1V5.6c0-.55.45-1 1-1Z',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
        }),
        props.busy === true
          ? h('path', { d: 'M4.6 8h6.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' })
          : h('circle', { cx: 8, cy: 8.1, r: 2.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }));
    }

    /**
     * 工具图标：只画轮廓，颜色继承文字色。
     * @param {string} id
     * @param {number} size
     * @returns {object}
     */
    function toolIcon(id, size) {
      const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' };
      const paths = {
        move: [
          h('path', { key: 'a', d: 'M8 2.5v11M2.5 8h11', ...common }),
          h('path', { key: 'b', d: 'M8 2.5 6.2 4.6M8 2.5l1.8 2.1M8 13.5l-1.8-2.1M8 13.5l1.8-2.1M2.5 8l2.1-1.8M2.5 8l2.1 1.8M13.5 8l-2.1-1.8M13.5 8l-2.1 1.8', ...common, strokeWidth: 1.1 }),
        ],
        rect: [h('rect', { key: 'a', x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.4, ...common })],
        ellipse: [h('ellipse', { key: 'a', cx: 8, cy: 8, rx: 5.5, ry: 4.5, ...common })],
        arrow: [
          h('path', { key: 'a', d: 'M3 12.5 12 3.5', ...common }),
          h('path', { key: 'b', d: 'M7.6 3.5H12v4.4', ...common }),
        ],
        pen: [h('path', { key: 'a', d: 'M3 12.4c1.8-.6 2.2-5.4 4.4-5.4 2.2 0 1.4 4.2 3.2 4.2 1 0 1.6-.9 1.9-1.6', ...common })],
        mosaic: [
          h('rect', { key: 'a', x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.4, ...common }),
          h('path', { key: 'b', d: 'M6.2 3.5v9M9.8 3.5v9M2.5 6.5h11M2.5 9.5h11', ...common, strokeWidth: 0.9 }),
        ],
        text: [
          h('path', { key: 'a', d: 'M3.5 4h9M8 4v8.5', ...common }),
          h('path', { key: 'b', d: 'M6 12.5h4', ...common }),
        ],
      };
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        paths[id] ?? paths.rect);
    }

    /** @param {number} size */
    function undoIcon(size) {
      const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' };
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M6 4.5 3 7.5l3 3', ...common }),
        h('path', { d: 'M3 7.5h6.2c2.1 0 3.8 1.5 3.8 3.4', ...common }));
    }

    /** @param {number} size */
    function redoIcon(size) {
      const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' };
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M10 4.5l3 3-3 3', ...common }),
        h('path', { d: 'M13 7.5H6.8C4.7 7.5 3 9 3 10.9', ...common }));
    }

    /** @param {number} size */
    function closeIcon(size) {
      const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' };
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6', ...common }));
    }

    /**
     * 阻止按钮按下时把焦点从编辑框/覆盖层抢走。
     * @param {Event} event
     */
    function preventFocusLoss(event) {
      try {
        event.preventDefault();
      } catch (error) {
        logger.warn('preventDefault failed', errorText(error));
      }
    }

    /**
     * 事件目标是否位于覆盖层自身 UI 内（工具栏容器、文字输入框、轻提示……）。
     * 判定与 onKeyDown 的 `closest('[data-dsh-screenshot-editor]')` 同一套办法：命中统一标记即 true。
     * @param {unknown} target
     * @returns {boolean}
     */
    function isOverlayUiTarget(target) {
      if (target === null || target === undefined) return false;
      if (typeof target.closest !== 'function') return false;
      try {
        return target.closest(UI_MARKER_SELECTOR) !== null;
      } catch (error) {
        logger.warn('ui target test failed', errorText(error));
        return false;
      }
    }

    /**
     * 覆盖层自身 UI 容器的公共 props：统一 data 标记 + 阻止指针/鼠标事件冒泡到根部。
     *
     * 双保险（R-U01）：根部把「非 UI 的 pointerdown」当作拖拽起点，只要有一层没隔离，
     * 按钮的 click 就会被 setPointerCapture 吞掉。这里同时给标记与 stopPropagation。
     * @param {object} [extra] - 追加/覆盖的 props（ref / style / aria-* 等）。
     * @returns {object}
     */
    function uiSurfaceProps(extra = {}) {
      return {
        ...extra,
        // 标记与两个拦截放在 extra 之后：调用方即使误传同名 props，也破坏不了这条契约（R-U01）。
        [UI_MARKER_ATTR]: 'true',
        onPointerDown: (event) => event.stopPropagation(),
        onMouseDown: (event) => event.stopPropagation(),
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 右键模式菜单（C-6 复活，t67）
    //
    // 用户 2026-09-30 曾把「普通 / 穿透」的选择取消（C-6 作废，穿透变成默认且唯一）；
    // 2026-09-30 晚用户要求**把右键菜单加回来**：右键截图图标 → 选「穿透（隐藏 DSH）」
    // 或「普通（含 DSH 窗口）」→ 选择在**本次会话内记住**，左键与 ALT+A 都用记住的模式。
    // 两条抓屏路径都吃这个模式：面板路径 `POST /overlay/start?mode=`，回退路径 `startCapture(runtime, through)`。
    // ─────────────────────────────────────────────────────────────────────────

    /** @param {object} runtime @returns {string} 当前会话记住的模式（脏值一律当穿透）。 */
    function captureModeOf(runtime) {
      return normalizeCaptureMode(runtime.state.captureMode);
    }

    /** @param {object} runtime 打开菜单（忙态下不开）。 */
    function openCaptureMenu(runtime) {
      if (runtime.state.phase !== 'idle' || runtime.state.busy) return;
      runtime.state.modeMenu = { openedAt: nowMs() };
      runtime.notify();
    }

    /** @param {object} runtime 关闭菜单（没开就什么都不做）。 */
    function closeCaptureMenu(runtime) {
      if (runtime.state.modeMenu === null) return;
      runtime.state.modeMenu = null;
      runtime.notify();
    }

    /**
     * 选定模式：写进会话状态、关菜单、记一条日志。**不**顺手截图 —— 右键是"选模式"，
     * 截图永远由左键 / ALT+A 显式触发。
     * @param {object} runtime @param {string} mode
     */
    function chooseCaptureMode(runtime, mode) {
      const next = normalizeCaptureMode(mode);
      runtime.state.captureMode = next;
      runtime.state.modeMenu = null;
      runtime.notify();
      logger.info('capture mode selected', { mode: next });
      // t73：选择要**记住** —— 写进插件配置（设置页/插件管理里那份），DSH 重启后不用重选。
      void saveCaptureMode(runtime, next);
    }

    /**
     * 插件页里的「截图模式」配置区（t74）。
     *
     * 插件页的配置区是**插件自己贡献**的（和语音输入插件一样贡献到 `plugins.bundle.config`，
     * `key` 用包名）：没有贡献时页面连 `<section data-plugin-config>` 都不渲染。
     * 控件读写的就是宿主那条偏好路由 —— 与右键菜单同一份配置（`Config.captureMode`），
     * 因此这里改完立即生效、且与菜单里的勾选始终一致。
     */
    function CaptureModeSetting() {
      // 形态照抄 DSH 自己的语音输入插件（`识别服务 / 识别语言`）：**原生 `<select>` 包在 `<label>` 里**。
      // 两个必须遵守的点（t74b/t74c 实机教训）：
      //   ① 绝不能挂 `onMouseDown`（preventDefault 会把 mousedown 吃掉，原生下拉就弹不开）；
      //   ② 读取完成前**不要 disabled**（读失败会变成永久点不动的控件）。
      // 文案用页面级令牌（`label-primary` 等）—— 之前用 toast 令牌，在浅色页面上等于隐形。
      const runtime = useShotStore();
      const [mode, setMode] = React.useState(normalizeCaptureMode(runtime.state.captureMode));
      const [note, setNote] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        void (async () => {
          const current = await readCaptureMode();
          if (!alive) return;
          setMode(current);
          // 顺手把共享状态对齐：本组件与截图流程读的是同一份 state。
          runtime.state.captureMode = current;
          runtime.notify();
        })();
        return () => {
          alive = false;
        };
      }, [runtime]);
      const choose = (next) => {
        const wanted = normalizeCaptureMode(next);
        // t74c：立刻写进**共享会话状态** —— 否则插件页改了、下一次截图却还用旧值
        // （用户实测：「配置页面可以切 但实际截图的时候是按照右键选择来的」）。
        runtime.state.captureMode = wanted;
        runtime.notify();
        setMode(wanted);
        setNote(TEXT.modeSaving);
        void (async () => {
          const persisted = await saveCaptureMode(null, wanted);
          setNote(persisted ? TEXT.modeSaved : TEXT.modeSessionOnly);
        })();
      };
      return h('div', { style: SETTING_ROW_STYLE },
        h('label', { style: SETTING_LABEL_STYLE, htmlFor: SETTING_SELECT_ID },
          h('span', { style: SETTING_LABEL_TEXT_STYLE }, TEXT.modeSetting),
          h('select', {
            id: SETTING_SELECT_ID,
            value: mode,
            onChange: (event) => choose(event.target.value),
            style: SETTING_SELECT_STYLE,
          },
            h('option', { value: CAPTURE_MODE_THROUGH }, TEXT.modeThrough),
            h('option', { value: CAPTURE_MODE_NORMAL }, TEXT.modeNormal),
          ),
        ),
        note === '' ? null : h('span', { style: SETTING_NOTE_STYLE }, note),
      );
    }

    /**
     * 读回当前模式（插件页控件用）。拿不到就显示默认的穿透 —— 控件本身不该因此报错。
     * @returns {Promise<string>}
     */
    async function readCaptureMode(fetchImpl = fetch) {
      if (typeof fetchImpl !== 'function') return CAPTURE_MODE_THROUGH;
      try {
        const response = await fetchImpl(CAPTURE_STATE_PATH);
        if (response === null || response === undefined || response.ok !== true) return CAPTURE_MODE_THROUGH;
        const body = await response.json();
        return normalizeCaptureMode(body?.captureMode);
      } catch (error) {
        logger.warn('could not read the capture mode for the settings page', { error: errorText(error) });
        return CAPTURE_MODE_THROUGH;
      }
    }

    /**
     * 把当前模式写回宿主（它再写进插件配置）。失败只记日志：菜单本身已经生效，
     * 下次启动最多回到默认的穿透，不该因此打扰用户。
     * @param {object|null} runtime @param {string} mode
     * @returns {Promise<boolean>} 是否已持久化。
     */
    async function saveCaptureMode(runtime, mode, fetchImpl = fetch) {
      if (typeof fetchImpl !== 'function') return false;
      try {
        const response = await fetchImpl(CAPTURE_STATE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ captureMode: normalizeCaptureMode(mode) }),
        });
        if (response === null || response === undefined || response.ok !== true) {
          logger.warn('capture mode was not persisted', { status: response?.status });
          return false;
        }
        const body = await response.json().catch(() => null);
        const persisted = body?.persisted === true;
        logger.info('capture mode persisted', { mode, persisted });
        return persisted;
      } catch (error) {
        logger.warn('capture mode persistence failed', { error: String(error) });
        return false;
      }
    }

    /**
     * 启动时读回上次选定的模式（t73）：设置页改过、或上次右键选过，都在这里生效。
     * 失败保持默认（穿透）。
     * @param {object} runtime @param {Function} [fetchImpl]
     * @returns {Promise<string>} 生效后的模式。
     */
    async function loadCaptureMode(runtime, fetchImpl = fetch) {
      if (typeof fetchImpl !== 'function') return runtime.state.captureMode;
      try {
        const response = await fetchImpl(CAPTURE_STATE_PATH);
        if (response === null || response === undefined || response.ok !== true) return runtime.state.captureMode;
        const body = await response.json();
        const next = normalizeCaptureMode(body?.captureMode);
        if (next !== runtime.state.captureMode) {
          runtime.state.captureMode = next;
          runtime.notify();
        }
        logger.info('capture mode restored', { mode: next });
        return next;
      } catch (error) {
        logger.warn('could not read the saved capture mode', { error: String(error) });
        return runtime.state.captureMode;
      }
    }

    /**
     * 菜单落点：贴按钮**上方**、右对齐，并夹在视口内（按钮在输入框动作区，下方空间不够）。
     * @param {Element|null} button
     * @returns {{left: number, bottom: number}}
     */
    function captureMenuAnchor(button) {
      const width = typeof window === 'undefined' ? 0 : window.innerWidth;
      const height = typeof window === 'undefined' ? 0 : window.innerHeight;
      const rect = button !== null && button !== undefined && typeof button.getBoundingClientRect === 'function'
        ? button.getBoundingClientRect()
        : null;
      if (rect === null || rect.width === 0) return { left: 16, bottom: 96 };
      return {
        left: Math.max(8, Math.min(rect.left, Math.max(8, width - MODE_MENU_WIDTH - 8))),
        bottom: Math.max(8, height - rect.top + 8),
      };
    }

    /**
     * 模式菜单：`role=menu` + 两个 `menuitemradio`（当前模式带圆点），
     * 上下键移动、Enter/Space 选定、Esc 关闭、点外面关闭。焦点留在输入框（不抢焦点、不关草稿）。
     * @param {{runtime: object}} props
     */
    function CaptureModeMenu(props) {
      const runtime = props.runtime;
      const state = runtime.state;
      const [index, setIndex] = React.useState(() => {
        const found = CAPTURE_MODE_ITEMS.findIndex((item) => item.id === captureModeOf(runtime));
        return found === -1 ? 0 : found;
      });
      const menuRef = React.useRef(null);

      React.useEffect(() => {
        const onKeyDown = (event) => {
          const key = typeof event.key === 'string' ? event.key : '';
          if (key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeCaptureMenu(runtime);
            return;
          }
          if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            const step = key === 'ArrowDown' ? 1 : -1;
            setIndex((current) => (current + step + CAPTURE_MODE_ITEMS.length) % CAPTURE_MODE_ITEMS.length);
            return;
          }
          if (key === 'Home' || key === 'End') {
            event.preventDefault();
            setIndex(key === 'Home' ? 0 : CAPTURE_MODE_ITEMS.length - 1);
            return;
          }
          if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            event.preventDefault();
            event.stopPropagation();
            const item = CAPTURE_MODE_ITEMS[index];
            if (item !== undefined) chooseCaptureMode(runtime, item.id);
          }
        };
        const onPointerDown = (event) => {
          const menu = menuRef.current;
          if (menu === null) return;
          if (event.target === menu || (typeof menu.contains === 'function' && menu.contains(event.target))) return;
          closeCaptureMenu(runtime);
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [runtime, index]);

      const anchor = captureMenuAnchor(state.buttonEl);
      return h('div', {
        ref: menuRef,
        role: 'menu',
        'aria-label': TEXT.modeMenuLabel,
        tabIndex: -1,
        'data-dsh-screenshot-ui': 'true',
        style: { ...MODE_MENU_STYLE, left: anchor.left, bottom: anchor.bottom },
      },
      h('div', { style: MODE_MENU_TITLE_STYLE }, TEXT.modeMenuLabel),
      CAPTURE_MODE_ITEMS.map((item, itemIndex) => h('div', {
        key: item.id,
        role: 'menuitemradio',
        'aria-checked': captureModeOf(runtime) === item.id ? 'true' : 'false',
        tabIndex: -1,
        onMouseEnter: () => setIndex(itemIndex),
        onClick: () => chooseCaptureMode(runtime, item.id),
        style: { ...MODE_ITEM_STYLE, ...(itemIndex === index ? MODE_ITEM_ACTIVE_STYLE : null) },
      },
      h('span', { style: MODE_CHECK_STYLE }, captureModeOf(runtime) === item.id ? '●' : ''),
      h('span', { style: MODE_ITEM_TEXT_STYLE },
        h('span', { style: MODE_ITEM_LABEL_STYLE }, TEXT[item.labelKey]),
        h('span', { style: MODE_ITEM_HINT_STYLE }, TEXT[item.hintKey])))),
      h('div', { style: MODE_MENU_HINT_STYLE }, TEXT.modeMenuHint));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 入口按钮（conversation.input.right）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 输入框动作区里的截图按钮。
     *
     * 渲染条件说明：该槽位条目只在 composer 存活时被渲染 ——
     * `dsh-client-ui-conversation/lib/client.js:17457` 是
     * `input === void 0 || sessionId === void 0 ? null : renderSlot("conversation.input.right", {})`，
     * 因此「条目被渲染」本身就等价于「当前有会话 + 输入框」。这里不再用 sessionId 二次判定，
     * 避免因为 props 形状变化把按钮藏掉（DoD B-1 的验收点就是按钮存在）。
     * @param {object} props
     */
    function ScreenshotButton(props) {
      const runtime = useShotStore();
      const state = runtime.state;
      const [hovered, setHovered] = React.useState(false);
      const busy = state.phase !== 'idle';
      // `useInput` 是 conversation.input.right 的标准 prop（runner 3312）：用它镜像输入框当前的
      // 附件数量，作为「插入对话是否真的插入成功」的硬判据。拿不到就保持 null —— 插入动作会跳过
      // 不可验证的粘贴桥接，直接走「复制 + 可见提示」的降级路径。
      const useInput = props === null || props === undefined ? undefined : props.useInput;
      const attachmentIds = typeof useInput === 'function' ? useInput(selectAttachmentIds) : undefined;
      const attachmentCount = Array.isArray(attachmentIds) ? attachmentIds.length : null;

      React.useEffect(() => {
        // 走 setter：数量一变化就唤醒插入流程的等待者（U-03 事件驱动）。
        runtime.setAttachmentCount(attachmentCount);
      }, [attachmentCount, runtime]);

      // ALT+A（t45）：应用内快捷键 —— 只有页面聚焦时 keydown 才到得了这里，因此天然只作用于
      // 「DSH 聚焦」；不注册任何全局热键、不引常驻进程。输入框内不吞键（shouldStartCapture 判定）。
      // t52/t59：与左键**完全同一条路径**（先拉独立全屏面板，不可用才回退 DSH 内覆盖层）。
      React.useEffect(() => {
        const onKeyDown = (event) => {
          try {
            if (!shouldStartCapture(event, document, event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            void startShot(runtime);
          } catch (error) {
            logger.warn('capture shortcut failed', errorText(error));
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [runtime]);

      const button = h('button', {
        type: 'button',
        'aria-label': TEXT.button,
        'aria-busy': busy ? 'true' : undefined,
        'aria-keyshortcuts': TEXT.shortcut,
        // t67：右键菜单回来了 —— `aria-haspopup` / `aria-expanded` 让无障碍层也知道它的存在。
        'aria-haspopup': 'menu',
        'aria-expanded': state.modeMenu === null ? 'false' : 'true',
        title: TEXT.button,
        disabled: busy,
        ref: (element) => {
          state.buttonEl = element;
        },
        onMouseDown: preventFocusLoss,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onContextMenu: (event) => {
          // 右键 = 选模式（普通 / 穿透），不触发截图；阻止 DSH 自己的右键菜单。
          event.preventDefault();
          event.stopPropagation();
          openCaptureMenu(runtime);
        },
        onClick: () => {
          // 菜单开着时，左键先收菜单（避免"点一下又开一次截图"）。
          if (state.modeMenu !== null) {
            closeCaptureMenu(runtime);
            return;
          }
          void startShot(runtime);
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          padding: 0,
          border: 'none',
          borderRadius: 8,
          background: hovered && !busy ? TOKEN.hover : 'transparent',
          color: busy ? TOKEN.labelCaption : TOKEN.labelSecondary,
          cursor: busy ? 'progress' : 'pointer',
          opacity: busy ? 0.75 : 1,
          flex: '0 0 auto',
        },
      }, h(CameraIcon, { size: 16, busy }));

      // Fragment 包裹：DOM 里仍然只有这一个按钮（菜单只在打开时挂一个 fixed 浮层）。
      return h(React.Fragment, null,
        button,
        state.modeMenu === null || busy ? null : h(CaptureModeMenu, { runtime }));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 覆盖层（shell.overlay）：冻结帧 + 遮罩 + 框选微调 + 标注 + 工具栏
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 覆盖层条目：截图模式的全屏表面。
     *
     * 结构（全部是宿主槽位内的节点，不触碰 app root）：
     * - base canvas：冻结帧，只在进入模式/窗口尺寸变化时画一次（B-2 的「非实时画面」）。
     * - ann canvas：标注层，requestAnimationFrame 节流重绘，只重绘标注、不重绘底图（D-2）。
     * - 遮罩 4 块 + 选区框 + 8 个把手 + 十字线 + 尺寸徽标：直接写 style 定位（逐帧不进 React）。
     * - 工具栏 / 文字输入框 / 轻提示：React 渲染（低频）。
     */
    function OverlayLayer() {
      const runtime = useShotStore();
      const state = runtime.state;
      const active = state.phase === 'active' && state.frame !== null;

      const rootRef = React.useRef(null);
      const baseRef = React.useRef(null);
      const annRef = React.useRef(null);
      const maskAllRef = React.useRef(null);
      const maskTopRef = React.useRef(null);
      const maskRightRef = React.useRef(null);
      const maskBottomRef = React.useRef(null);
      const maskLeftRef = React.useRef(null);
      const selectionRef = React.useRef(null);
      const annotationBoxRef = React.useRef(null);
      const annotationHandleEls = React.useRef({});
      const badgeRef = React.useRef(null);
      const crossXRef = React.useRef(null);
      const crossYRef = React.useRef(null);
      const toolbarRef = React.useRef(null);
      const handleEls = React.useRef({});
      const boxRef = React.useRef(null);
      const viewRef = React.useRef(null);
      const poolRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const pointerRef = React.useRef({ x: 0, y: 0 });
      const rafRef = React.useRef(null);
      const latestRef = React.useRef({});
      const [dragging, setDragging] = React.useState(false);
      const [toolbarSize, setToolbarSize] = React.useState({ width: 0, height: 0 });

      // ── 基础几何 ──────────────────────────────────────────────────────────
      /** @returns {{width: number, height: number}|null} 覆盖层 CSS 盒。 */
      function overlayBox() {
        const root = rootRef.current;
        if (root === null) return null;
        const rect = root.getBoundingClientRect();
        const width = rect.width || root.clientWidth;
        const height = rect.height || root.clientHeight;
        if (!(width > 0) || !(height > 0)) return null;
        return { width, height };
      }

      /** @returns {object|null} 当前标定（进入模式时算一次，窗口变化时重算）。 */
      function calibration() {
        const frame = state.frame;
        const box = boxRef.current;
        if (frame === null || box === null) return null;
        if (state.calibration !== null) return state.calibration;
        const computed = calibrateFrame(frame.capture, box, currentDpr());
        state.calibration = computed;
        return computed;
      }

      /** @param {object} selectionCss @returns {object|null} */
      function planFor(selectionCss) {
        const frame = state.frame;
        const cal = calibration();
        if (frame === null || cal === null || selectionCss === null) return null;
        try {
          return planRender(frame.capture, selectionCss, planOptionsFor(cal));
        } catch (error) {
          logger.warn('plan failed', errorText(error));
          return null;
        }
      }

      /**
       * 可框选区域 = 覆盖层盒 ∩ 冻结帧在盒内实际占到的范围。
       * 贴合可能让帧在某一轴上越过盒（被裁掉）或在另一轴留边，把选区夹在这个交集中，
       * 选区就永远落在帧内：`planRender` 不会判定 `clipped`，B-5 的 <8 px 规则成为唯一的取消路径。
       * @returns {{width: number, height: number}|null}
       */
      function selectableBox() {
        const box = boxRef.current;
        const cal = calibration();
        if (box === null) return null;
        if (cal === null) return box;
        return {
          width: Math.min(box.width, cal.frameBox.width),
          height: Math.min(box.height, cal.frameBox.height),
        };
      }

      /** @param {object} selection @returns {boolean} 选区是否够大且没越出冻结帧（B-5）。 */
      function selectionValid(selection) {
        const plan = planFor(selection);
        return plan !== null && plan.valid;
      }

      /** @param {PointerEvent} event @returns {{x: number, y: number}} 覆盖层 CSS 坐标。 */
      function cssPoint(event) {
        const root = rootRef.current;
        if (root === null) return { x: 0, y: 0 };
        const rect = root.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      }

      /** @param {{x: number, y: number}} point @returns {{x: number, y: number}} device 坐标。 */
      function toDevice(point) {
        const cal = calibration();
        if (cal === null) return { x: point.x, y: point.y };
        return { x: (point.x + cal.screen.x) * cal.scale, y: (point.y + cal.screen.y) * cal.scale };
      }

      // ── 绘制 ─────────────────────────────────────────────────────────────
      /**
       * 把冻结帧一次性画进底图 canvas（B-2：之后不再刷新）。
       * 变换与标注层、`planRender` 的映射同源：`canvasX = ((device / scale) - screen.x) * dpr`。
       * @param {object} frame
       * @param {object} cal
       */
      function paintFrozenFrame(frame, cal) {
        const canvas = baseRef.current;
        if (canvas === null) return;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return;
        const dpr = cal.dpr;
        const a = dpr / cal.scale;
        const e = -cal.screen.x * dpr;
        const f = -cal.screen.y * dpr;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.setTransform(a, 0, 0, a, e, f);
        try {
          ctx.drawImage(frame.image, 0, 0);
        } catch (error) {
          logger.warn('drawImage failed', errorText(error));
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        viewRef.current = { a, dpr, e, f };
      }

      /** 重绘标注层（含拖动中的草稿）；底图不动（D-2）。 */
      function paintAnnotations() {
        const canvas = annRef.current;
        const frame = state.frame;
        const view = viewRef.current;
        if (canvas === null || frame === null || view === null) return;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return;
        const drag = dragRef.current;
        const selection = drag !== null && drag.preview !== null ? drag.preview : state.selection;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // 先整块清空：此刻不能带任何裁剪区，否则选区外的旧墨迹清不掉（会留下残影）。
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const clipped = selection !== null && hasPositiveArea(selection);
        if (clipped) {
          // 标注层裁到选区：导出的就是这一块，所见即所得。
          // 必须成对 save/restore（U-02）：裁剪区是画布状态的一部分，会跨帧累加 ——
          // 框选过程中每帧都在换裁剪矩形，交集会退化成最初那个小预览矩形，
          // 之后连"拖动中的草稿"都会被裁掉，屏幕上永远看不到正在画的东西。
          ctx.save();
          ctx.beginPath();
          ctx.rect(selection.x * view.dpr, selection.y * view.dpr, selection.width * view.dpr, selection.height * view.dpr);
          ctx.clip();
        }
        ctx.setTransform(view.a, 0, 0, view.a, view.e, view.f);
        const pool = poolRef.current;
        const environment = {
          mosaicSource: frame.image,
          mosaicSourceRect: { x: 0, y: 0, width: frame.width, height: frame.height },
          createScratch: (width, height) => (pool === null ? null : pool.create(width, height)),
          mosaicStep: state.mosaicStep,
        };
        const liveIndex = drag !== null && typeof drag.annotationIndex === 'number' ? drag.annotationIndex : -1;
        const liveAnnotation = drag !== null && drag.annotation !== null && drag.annotation !== undefined ? drag.annotation : null;
        const annotations = state.history.present;
        for (let index = 0; index < annotations.length; index += 1) {
          // t22：移动/缩放拖拽中，用实时值替换历史里的那一份（不写历史 → 一次拖拽一条）
          const annotation = index === liveIndex && liveAnnotation !== null ? liveAnnotation : annotations[index];
          try {
            if (pool !== null) pool.reset();
            drawAnnotation(ctx, annotation, environment);
          } catch (error) {
            logger.warn('annotation draw failed', errorText(error));
          }
        }
        if (drag !== null && drag.draft !== null) {
          try {
            if (pool !== null) pool.reset();
            drawAnnotation(ctx, drag.draft, environment);
          } catch (error) {
            logger.warn('draft draw failed', errorText(error));
          }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (clipped) ctx.restore();
      }

      /**
       * @param {HTMLElement|null} element
       * @param {{x: number, y: number, width: number, height: number}} rect
       * @param {boolean} visible
       */
      function place(element, rect, visible) {
        if (element === null || element === undefined) return;
        if (!visible) {
          element.style.display = 'none';
          return;
        }
        element.style.display = 'block';
        element.style.left = `${rect.x}px`;
        element.style.top = `${rect.y}px`;
        element.style.width = `${Math.max(0, rect.width)}px`;
        element.style.height = `${Math.max(0, rect.height)}px`;
      }

      /** 命令式刷新选区装饰（遮罩/框/把手/十字线/尺寸徽标）。 */
      function layoutChrome() {
        const box = boxRef.current;
        if (box === null) return;
        const drag = dragRef.current;
        const selection = drag !== null && drag.preview !== null ? drag.preview : state.selection;
        const valid = selection !== null && hasPositiveArea(selection);

        place(maskAllRef.current, { x: 0, y: 0, width: box.width, height: box.height }, !valid);
        place(maskTopRef.current, { x: 0, y: 0, width: box.width, height: valid ? selection.y : 0 }, valid);
        place(maskBottomRef.current, {
          x: 0,
          y: valid ? selection.y + selection.height : 0,
          width: box.width,
          height: valid ? box.height - (selection.y + selection.height) : 0,
        }, valid);
        place(maskLeftRef.current, {
          x: 0,
          y: valid ? selection.y : 0,
          width: valid ? selection.x : 0,
          height: valid ? selection.height : 0,
        }, valid);
        place(maskRightRef.current, {
          x: valid ? selection.x + selection.width : 0,
          y: valid ? selection.y : 0,
          width: valid ? box.width - (selection.x + selection.width) : 0,
          height: valid ? selection.height : 0,
        }, valid);
        place(selectionRef.current, valid ? selection : { x: 0, y: 0, width: 0, height: 0 }, valid);

        for (const handle of HANDLES) {
          const element = handleEls.current[handle];
          if (element === undefined || element === null) continue;
          if (!valid) {
            element.style.display = 'none';
            continue;
          }
          const point = handlePoint(selection, handle);
          element.style.display = 'block';
          element.style.left = `${point.x - HANDLE_SIZE / 2}px`;
          element.style.top = `${point.y - HANDLE_SIZE / 2}px`;
        }

        const pointer = pointerRef.current;
        const showCross = valid ? drag !== null && drag.mode === 'create' : true;
        place(crossXRef.current, { x: 0, y: pointer.y, width: box.width, height: 1 }, showCross);
        place(crossYRef.current, { x: pointer.x, y: 0, width: 1, height: box.height }, showCross);

        const badge = badgeRef.current;
        if (badge === null) return;
        if (!valid) {
          badge.style.display = 'none';
          return;
        }
        const plan = planFor(selection);
        const deviceWidth = plan === null ? Math.round(selection.width) : plan.deviceRect.width;
        const deviceHeight = plan === null ? Math.round(selection.height) : plan.deviceRect.height;
        const ok = plan !== null && plan.valid;
        badge.style.display = 'block';
        badge.textContent = ok ? `${deviceWidth} × ${deviceHeight}` : `${deviceWidth} × ${deviceHeight} · < 8 px`;
        badge.style.color = ok ? TOKEN.panelLabel : TOKEN.error;
        const badgeWidth = badge.offsetWidth || 96;
        badge.style.left = `${clamp(selection.x, 0, Math.max(0, box.width - badgeWidth))}px`;
        badge.style.top = `${selection.y > 30 ? selection.y - 26 : Math.min(box.height - 24, selection.y + selection.height + 6)}px`;

        // t22：已放置标注的选中框（虚线）+ 4 个角把手；device 矩形换算回 CSS 后再定位。
        // H-01：把手的 left/top 相对**标注框**（它是框的子节点），视口坐标要减去框原点，
        // 否则把手会被框原点二次偏移、画到框外（见 annotationHandleOffset 注释）。
        const selected = selectedAnnotationValue();
        const selectedBox = selected === null ? null : deviceRectToCss(annotationRect(selected));
        place(annotationBoxRef.current, selectedBox ?? { x: 0, y: 0, width: 0, height: 0 }, selectedBox !== null);
        for (const id of CORNER_HANDLES) {
          const element = annotationHandleEls.current[id];
          if (element === undefined || element === null) continue;
          if (selectedBox === null) {
            element.style.display = 'none';
            continue;
          }
          const corner = handlePoint(selectedBox, id);
          const offset = annotationHandleOffset(selectedBox, corner);
          place(element, {
            x: offset.x,
            y: offset.y,
            width: ANNOTATION_HANDLE_SIZE,
            height: ANNOTATION_HANDLE_SIZE,
          }, true);
        }
      }

      /** 合并到一帧里刷新（rAF 节流，D-2）。 */
      function schedule() {
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          try {
            layoutChrome();
            paintAnnotations();
          } catch (error) {
            logger.warn('frame paint failed', errorText(error));
          }
        });
      }

      // ── 标注与撤销 ────────────────────────────────────────────────────────
      /**
       * 用「替换整份标注列表」的语义提交一次编辑（t22）：新增/移动/缩放/删除都走它。
       * 拖拽过程中只更新 drag.annotation，松手才调用 —— 所以一次拖拽只产生一条历史记录。
       * @param {readonly object[]} next
       */
      function commitAnnotations(next) {
        state.history.push(next);
        state.notice = null;
        store.notify();
        schedule();
      }

      /** @param {object} annotation 追加一条标注（历史栈是标注列表的唯一真相）。 */
      function commitAnnotation(annotation) {
        commitAnnotations([...state.history.present, annotation]);
      }

      /**
       * 当前选中的已放置标注：拖拽中的实时值优先，这样预览与松手结果一致。
       * @returns {object|null}
       */
      function selectedAnnotationValue() {
        const index = state.selectedAnnotationIndex;
        if (index === null) return null;
        const drag = dragRef.current;
        if (drag !== null && drag.annotationIndex === index && drag.annotation !== null && drag.annotation !== undefined) {
          return drag.annotation;
        }
        return state.history.present[index] ?? null;
      }

      /** 取消标注选中态。 @returns {boolean} 是否真的清掉了。 */
      function clearAnnotationSelection() {
        if (state.selectedAnnotationIndex === null) return false;
        state.selectedAnnotationIndex = null;
        return true;
      }

      /** @returns {{x:number,y:number,width:number,height:number}|null} 选区在 device 空间的矩形（移动/缩放的夹取边界）。 */
      function annotationBounds() {
        const plan = planFor(state.selection);
        return plan === null || plan.valid !== true ? null : plan.deviceRect;
      }

      /**
       * @param {{x:number,y:number,width:number,height:number}} rect
       * @returns {{x:number,y:number,width:number,height:number}} device → 覆盖层 CSS 坐标。
       */
      function deviceRectToCss(rect) {
        const cal = calibration();
        const scale = cal === null || !(cal.scale > 0) ? 1 : cal.scale;
        return { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale };
      }

      /** 删除当前选中的标注（一条历史记录；其它标注不受影响）。 */
      function deleteSelectedAnnotation() {
        const index = state.selectedAnnotationIndex;
        const present = state.history.present;
        if (index === null || index < 0 || index >= present.length) {
          clearAnnotationSelection();
          store.notify();
          return;
        }
        clearAnnotationSelection();
        commitAnnotations(present.filter((item, position) => position !== index));
        logger.info('annotation deleted', { index, remaining: present.length - 1 });
      }

      /** @param {{x: number, y: number}} devicePoint @returns {object|null} 新草稿。 */
      function beginDraft(devicePoint) {
        const tool = state.tool;
        if (tool === 'pen') {
          return createStroke({ tool: 'pen', color: state.color, widthKey: state.widthKey, points: [devicePoint] });
        }
        if (TOOL_IDS.includes(tool)) {
          return createShape({ tool, color: state.color, widthKey: state.widthKey, from: devicePoint, to: devicePoint });
        }
        return null;
      }

      /**
       * @param {object} drag
       * @param {{x: number, y: number}} devicePoint
       */
      function updateDraft(drag, devicePoint) {
        const tool = state.tool;
        if (drag.draft === null) return;
        if (tool === 'pen') {
          const points = appendPoint(drag.draft.points, devicePoint, 1.5);
          if (points !== drag.draft.points) {
            drag.draft = createStroke({ tool: 'pen', color: state.color, widthKey: state.widthKey, points });
          }
          return;
        }
        drag.draft = createShape({
          tool,
          color: state.color,
          widthKey: state.widthKey,
          from: drag.draft.from ?? devicePoint,
          to: devicePoint,
        });
      }

      /** @param {object} annotation @returns {{width: number, height: number}} */
      function measureText(annotation) {
        const canvas = annRef.current;
        const ctx = canvas === null ? null : canvas.getContext('2d');
        if (ctx === null) return { width: 0, height: 0 };
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const size = measureTextAnnotation(ctx, annotation);
        ctx.restore();
        return size;
      }

      /** @param {string} value */
      function commitEditor(value) {
        const editor = state.editor;
        if (editor === null) return;
        state.editor = null;
        const text = typeof value === 'string' ? value : '';
        if (text.trim() !== '') {
          const annotation = createText({
            text,
            color: state.color,
            x: editor.deviceX,
            y: editor.deviceY,
            sizeKey: state.textSizeKey,
          });
          commitAnnotation(withTextMetrics(annotation, measureText(annotation)));
          return;
        }
        store.notify();
        schedule();
      }

      // ── 模式进出 ──────────────────────────────────────────────────────────
      /** @param {string} reason 取消本次截图：关覆盖层、不产图、不写剪贴板、不动草稿（B-4/B-5）。 */
      function cancelShot(reason) {
        dragRef.current = null;
        setDragging(false);
        store.leaveMode();
        logger.info('cancelled', { reason });
        if (reason === 'selection.tooSmall') store.setToast('warn', TEXT.toastCanceled);
        else if (reason === 'selection.clipped') store.setToast('warn', TEXT.toastClipped);
        focusComposer(runtime);
      }

      /** 成功收尾：退出截图模式 + 轻提示 + 焦点回输入框（F-25 / D-3 / B-10）。 */
      function finishShot(kind, text) {
        dragRef.current = null;
        setDragging(false);
        store.leaveMode();
        store.setToast(kind, text);
        focusComposer(runtime);
      }

      // ── 输出 ─────────────────────────────────────────────────────────────
      /** @param {'insert'|'copy'|'save'} kind */
      async function runOutput(kind) {
        const frame = state.frame;
        const selection = state.selection;
        const cal = calibration();
        if (frame === null || selection === null || cal === null || state.busy) return;
        if (!selectionValid(selection)) {
          const probe = planFor(selection);
          cancelShot(probe !== null && probe.clipped ? 'selection.clipped' : 'selection.tooSmall');
          return;
        }
        state.busy = true;
        // U-03：忙态反馈必须**同步**可见 —— 先于任何 await 就把提示写进 notice 并 notify，
        // 这样用户在点击后的第一帧就能看到「正在生成图片（含标注）…」，而不是几秒的静止面板。
        // 此前这里把 notice 清成 null（旧代码 state.notice = null），忙时唯一的变化只是插入按钮
        // 的文字换成「处理中…」（下方 Toolbar 的 disabled ? TEXT.working : TEXT.insert），
        // 而整块面板同时被 disable 变灰 —— 数秒等待里用户读到的就是"没反应"。
        state.notice = { kind: 'info', text: TEXT.busyEncode };
        store.notify();
        const insertStartedAt = nowMs();
        let encodeMs = 0;
        let bridgeMs = 0;
        // t29：「慢」与「卡死」必须在界面上可区分 —— 编码到点还没回来就把提示升级一次。
        const slowTimer = setTimeout(() => {
          if (!state.busy) return;
          state.notice = { kind: 'info', text: TEXT.busySlow };
          store.notify();
          logger.info('encode slow', { elapsedMs: Math.round(nowMs() - insertStartedAt), deadlineMs: ENCODE_DEADLINE_MS });
        }, ENCODE_SLOW_NOTICE_MS);
        try {
          // t29：第一个日志必须在 await 之前 —— 否则「编码卡住」在控制台上与「什么都没发生」同形
          // （t19 的现场正是如此：零日志 + 永久忙态，无法判断卡在哪一步）。
          logger.info('output start', {
            kind,
            selectionCss: { width: Math.round(selection.width), height: Math.round(selection.height) },
            annotations: state.history.present.length,
            encodeDeadlineMs: ENCODE_DEADLINE_MS,
          });
          // t29 根因修复：编码阶段必须有硬上限。`encodeCanvas` 的 `canvas.toBlob` 回调在异常路径上
          // 可能永远不来（大画布 + 高负载 / 渲染进程异常），而这里是 busy 期间唯一没有兜底的 await：
          // 没有上限时 busy 永不释放、桥接兜底（INSERT_CONFIRM_MS）也永远轮不到，界面就是永久「处理中…」。
          const encodedOutcome = await withDeadline(
            encodeSelection(frame, selection, cal, state.history.present, state.mosaicStep),
            ENCODE_DEADLINE_MS,
          );
          encodeMs = Math.round(nowMs() - insertStartedAt);
          if (encodedOutcome.timedOut) {
            state.busy = false;
            state.notice = { kind: 'error', text: `${TEXT.encodeTimeout}（>${ENCODE_DEADLINE_MS} ms）` };
            store.notify();
            logger.warn('encode deadline exceeded', {
              deadlineMs: ENCODE_DEADLINE_MS,
              elapsedMs: encodeMs,
              selectionCss: { width: Math.round(selection.width), height: Math.round(selection.height) },
            });
            return;
          }
          if (!encodedOutcome.ok) throw encodedOutcome.error;
          const encoded = encodedOutcome.value;
          if (!encoded.ok) {
            state.busy = false;
            state.notice = { kind: 'error', text: `${TEXT.encodeFailed}（${encoded.reason}）` };
            store.notify();
            return;
          }
          // R-01：标签跟随实际字节（>4 MB 降级后的产物是 WebP），不再一律当 PNG。
          const format = formatOf(encoded.mediaType);
          if (kind === 'copy') {
            const copied = await copyPngToClipboard(encoded.blob, {}, format.mediaType);
            if (copied.ok) {
              finishShot('success', TEXT.toastCopied);
              return;
            }
            state.busy = false;
            state.notice = { kind: 'error', text: `${TEXT.copyFailed}（${copied.reason}）—— ${TEXT.toastCopied}` };
            store.notify();
            return;
          }
          if (kind === 'save') {
            const saved = await savePngAs(encoded.blob, {}, format.mediaType);
            if (saved.ok) {
              finishShot('success', saved.method === 'picker' ? TEXT.toastSaved : TEXT.toastSavedDownload);
              return;
            }
            state.busy = false;
            if (saved.reason === 'save.cancelled') {
              store.notify();
              return;
            }
            state.notice = { kind: 'error', text: `${TEXT.saveFailed}（${saved.reason}）` };
            store.notify();
            return;
          }
          // 阶段切换：编码完成后换成「正在插入对话…」，让等待中的用户知道进展。
          state.notice = { kind: 'info', text: TEXT.busyInsert };
          store.notify();
          const bridgeStartedAt = nowMs();
          const inserted = await insertIntoConversation(runtime, encoded.blob, format.mediaType);
          bridgeMs = Math.round(nowMs() - bridgeStartedAt);
          logger.info('insert timings', {
            encodeMs,
            bridgeMs,
            totalMs: Math.round(nowMs() - insertStartedAt),
            attempts: encoded.attempts,
            encodes: encoded.encodes,
            renderedPixels: encoded.renderedPixels,
            mediaType: format.mediaType,
            method: inserted.method,
            ok: inserted.ok,
          });
          if (inserted.ok) {
            finishShot(inserted.kind, inserted.text);
            return;
          }
          // 失败保留截图模式：提示可重试或改用复制（B-12）。
          state.busy = false;
          state.notice = { kind: 'error', text: inserted.text };
          store.notify();
        } catch (error) {
          state.busy = false;
          state.notice = { kind: 'error', text: `${TEXT.outputFailed}：${errorText(error)}` };
          store.notify();
          logger.warn('output failed', errorText(error));
        } finally {
          clearTimeout(slowTimer);
          // t29：任何路径都不得永久忙态。成功路径已由 finishShot → leaveMode 收尾（busy=false），
          // 这里只兜底「上面某条分支漏了释放」的情况（含未预料的抛错）。
          if (state.busy) {
            state.busy = false;
            store.notify();
          }
        }
      }

      // ── 指针交互 ─────────────────────────────────────────────────────────
      /** @param {{x: number, y: number}} point */
      function updateCursor(point) {
        const root = rootRef.current;
        if (root === null) return;
        const selection = state.selection;
        let cursor = 'crosshair';
        if (selection !== null && hasPositiveArea(selection)) {
          const handle = hitHandle(selection, point, HANDLE_TOLERANCE);
          if (handle !== null) cursor = cursorForHandle(handle);
          else if (containsPoint(selection, point)) cursor = state.tool === TOOL_MOVE ? 'move' : 'crosshair';
          // t22：已选中标注的角把手 / 命中任意已放置标注 → 缩放 / 移动光标
          const cal = calibration();
          const devicePoint = toDevice(point);
          const scale = cal === null || !(cal.scale > 0) ? 1 : cal.scale;
          const selected = selectedAnnotationValue();
          if (selected !== null) {
            const grabbed = hitAnnotationHandle(annotationRect(selected), devicePoint, ANNOTATION_HANDLE_TOLERANCE * scale);
            if (grabbed !== null) cursor = cursorForHandle(grabbed);
          }
          if (cursor === 'crosshair' && state.tool === TOOL_MOVE
            && findAnnotationAt(state.history.present, devicePoint, HIT_TOLERANCE * Math.max(1, scale)) !== -1) {
            // t29：与 ③ 同一个门槛 —— 绘制工具下悬停不谎报「可拖动」，那一笔是画新标注。
            cursor = 'move';
          }
        }
        root.style.cursor = cursor;
      }

      /** @param {{x: number, y: number}} point */
      function openEditor(point) {
        const device = toDevice(point);
        state.editor = { cssX: point.x, cssY: point.y, deviceX: device.x, deviceY: device.y };
        store.notify();
      }

      /** @param {PointerEvent} event */
      function onPointerDown(event) {
        if (!active || state.busy) return;
        // R-U01（用户实机缺陷）：事件落在覆盖层自身 UI 上时直接返回，绝不进入拖拽分支 ——
        // 否则 setDragging(true) 会立刻隐藏工具栏（用户看到的「面板闪烁一下」），
        // 紧接着 setPointerCapture 把指针抢到根节点，按钮的 click 永远发不出来（「点了没反应」）。
        if (isOverlayUiTarget(event.target)) return;
        if (event.button === 2) {
          cancelShot('contextmenu');
          return;
        }
        if (event.button !== 0) return;
        const point = cssPoint(event);
        pointerRef.current = point;
        const devicePoint = toDevice(point);
        const cal = calibration();
        const scale = cal === null || !(cal.scale > 0) ? 1 : cal.scale;
        const selection = state.selection;
        let mode = 'create';
        let handle = null;
        let annotationIndex = null;
        let annotation = null;
        let annotationHandle = null;
        if (selection !== null && hasPositiveArea(selection)) {
          handle = hitHandle(selection, point, HANDLE_TOLERANCE);
          if (handle !== null) {
            // ① 选区把手优先：微调选区（原行为不变），并取消标注选中
            mode = 'resize';
            clearAnnotationSelection();
          } else {
            const selected = selectedAnnotationValue();
            // ② 已选中标注的角把手 → 缩放该标注
            if (selected !== null) {
              const grabbed = hitAnnotationHandle(annotationRect(selected), devicePoint, ANNOTATION_HANDLE_TOLERANCE * scale);
              if (grabbed !== null) {
                mode = 'annotate-scale';
                annotationHandle = grabbed;
                annotationIndex = state.selectedAnnotationIndex;
                annotation = selected;
              }
            }
            // ③ 命中已放置标注 → 选中并整体移动（重叠时取最上层）。
            //    t29（V-04 归因）：这条只在「移动 / Move」工具下生效。t22 的旧顺序无条件生效，
            //    于是**起笔点落在已有标注内**的任何一次绘制都会被改判成「移动那条标注」——
            //    t18 harness 实测：四个工具的最后两笔被吃掉（马赛克一次都没画出来、
            //    历史里也没有它），与 t22 契约「不得让画新标注变得难以触发」直接冲突。
            //    现在：绘制工具下一律画新标注；要选中/移动已放置标注先切回「移动」工具
            //    （进入截图模式时默认就是它），或直接拖已选中标注的角把手。
            if (mode === 'create' && state.tool === TOOL_MOVE) {
              const hitIndex = findAnnotationAt(state.history.present, devicePoint, HIT_TOLERANCE * Math.max(1, scale));
              if (hitIndex !== -1) {
                mode = 'annotate-move';
                annotationIndex = hitIndex;
                annotation = state.history.present[hitIndex];
                state.selectedAnnotationIndex = hitIndex;
                store.notify();
              }
            }
            // ④ 选区内部空白 → 画新标注（绘制工具）/ 平移选区（移动工具）；⑤ 选区外 → 重新框选
            if (mode === 'create') {
              if (clearAnnotationSelection()) store.notify();
              if (containsPoint(selection, point)) {
                if (state.tool === 'text') {
                  openEditor(point);
                  event.preventDefault();
                  return;
                }
                mode = state.tool === TOOL_MOVE ? 'move' : 'draw';
              }
            }
          }
        }
        const drag = {
          mode,
          handle,
          pointerId: event.pointerId,
          start: point,
          startSelection: selection === null ? null : { ...selection },
          preview: mode === 'create' ? null : (selection === null ? null : { ...selection }),
          draft: mode === 'draw' ? beginDraft(toDevice(point)) : null,
          // t22：已放置标注的移动/缩放 —— 拖拽期间只更新 annotation，松手才写一条历史
          annotationIndex,
          annotation,
          annotationHandle,
          original: annotation,
          changed: false,
          moved: false,
        };
        dragRef.current = drag;
        setDragging(true);
        const root = rootRef.current;
        if (root !== null && typeof root.setPointerCapture === 'function') {
          try {
            root.setPointerCapture(event.pointerId);
          } catch (error) {
            logger.warn('setPointerCapture failed', errorText(error));
          }
        }
        event.preventDefault();
        schedule();
      }

      /** @param {PointerEvent} event */
      function onPointerMove(event) {
        if (!active) return;
        // R-U01 的回归保护：手上没有拖拽且指针在面板上时，不更新十字线、不重绘（面板不参与画面交互）。
        if (dragRef.current === null && isOverlayUiTarget(event.target)) return;
        const point = cssPoint(event);
        pointerRef.current = point;
        const drag = dragRef.current;
        const bounds = selectableBox();
        if (drag === null || bounds === null) {
          updateCursor(point);
          if (state.selection === null) schedule();
          return;
        }
        drag.moved = drag.moved
          || Math.abs(point.x - drag.start.x) > 0.5
          || Math.abs(point.y - drag.start.y) > 0.5;
        if (drag.mode === 'create') {
          drag.preview = drag.moved ? clipSelectionToOverlay(rectFromCorners(drag.start, point), bounds) : null;
        } else if (drag.mode === 'resize' && drag.startSelection !== null) {
          drag.preview = resizeRect(drag.startSelection, drag.handle, point, bounds.width, bounds.height);
        } else if (drag.mode === 'move' && drag.startSelection !== null) {
          drag.preview = clampRectToFrame({
            x: drag.startSelection.x + (point.x - drag.start.x),
            y: drag.startSelection.y + (point.y - drag.start.y),
            width: drag.startSelection.width,
            height: drag.startSelection.height,
          }, bounds.width, bounds.height);
        } else if (drag.mode === 'draw') {
          updateDraft(drag, toDevice(point));
        } else if (drag.mode === 'annotate-move') {
          const cal = calibration();
          const bounds = annotationBounds();
          if (cal !== null && bounds !== null && drag.original !== null && drag.original !== undefined) {
            const dx = (point.x - drag.start.x) * cal.scale;
            const dy = (point.y - drag.start.y) * cal.scale;
            drag.annotation = moveAnnotation(drag.original, dx, dy, bounds);
            drag.changed = true;
          }
        } else if (drag.mode === 'annotate-scale') {
          const cal = calibration();
          const bounds = annotationBounds();
          if (cal !== null && bounds !== null && drag.original !== null && drag.original !== undefined && drag.annotationHandle !== null) {
            const raw = resizeAnnotationRect(annotationRect(drag.original), drag.annotationHandle, toDevice(point), MIN_ANNOTATION_EDGE);
            let next = scaleAnnotation(drag.original, clampAnnotationRect(raw, bounds));
            if (next.tool === 'text') next = withTextMetrics(next, measureText(next));
            drag.annotation = next;
            drag.changed = true;
          }
        }
        schedule();
      }

      /** @param {PointerEvent} event */
      function onPointerUp(event) {
        const drag = dragRef.current;
        // 面板上的 pointerup 到不了拖拽收尾逻辑：要么本来就没开拖拽（dragRef 为 null，直接返回），
        // 要么 pointerdown 已在根部被 UI 判定拦下，所以面板上的抬起不会产生选区/标注副作用（R-U01）。
        if (drag === null) return;
        dragRef.current = null;
        setDragging(false);
        const root = rootRef.current;
        if (root !== null && typeof root.releasePointerCapture === 'function') {
          try {
            root.releasePointerCapture(event.pointerId);
          } catch (error) {
            logger.warn('releasePointerCapture failed', errorText(error));
          }
        }
        if (drag.mode === 'annotate-move' || drag.mode === 'annotate-scale') {
          const index = drag.annotationIndex;
          if (drag.changed && drag.moved && index !== null && drag.annotation !== null
            && index < state.history.present.length) {
            // t22：拖拽中不写历史，这里一次性提交「替换整份列表」⇒ 一次拖拽 = 一条历史
            commitAnnotations(state.history.present.map((item, position) => (position === index ? drag.annotation : item)));
          } else {
            store.notify();
            schedule();
          }
          return;
        }
        if (drag.mode === 'draw') {
          if (drag.draft !== null && drag.moved) commitAnnotation(drag.draft);
          else schedule();
          return;
        }
        if (drag.preview === null) {
          schedule();
          return;
        }
        // B-5：宽或高小于 8 device 像素（由 planRender 判定）时取消本次截图。
        if (!selectionValid(drag.preview)) {
          const probe = planFor(drag.preview);
          cancelShot(probe !== null && probe.clipped ? 'selection.clipped' : 'selection.tooSmall');
          return;
        }
        state.selection = drag.preview;
        store.notify();
        schedule();
      }

      /** @param {PointerEvent} event */
      function onPointerCancel(event) {
        const drag = dragRef.current;
        if (drag === null) return;
        dragRef.current = null;
        setDragging(false);
        if (drag.mode !== 'draw' && drag.startSelection !== null) state.selection = drag.startSelection;
        store.notify();
        schedule();
      }

      /** @param {KeyboardEvent} event */
      function onKeyDown(event) {
        if (!active) return;
        const target = event.target;
        if (state.editor !== null && target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('[data-dsh-screenshot-editor]') !== null) {
          return; // 输入框自己处理 Enter / Esc
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelShot('escape');
          return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          // t22：选中已放置标注时删除它（一条历史记录，可 Ctrl+Z 撤销）
          if (state.selectedAnnotationIndex === null) return;
          event.preventDefault();
          event.stopPropagation();
          deleteSelectedAnnotation();
          return;
        }
        const accel = event.ctrlKey === true || event.metaKey === true;
        if (!accel) return;
        const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault();
        event.stopPropagation();
        clearAnnotationSelection();
        const changed = key === 'y' || event.shiftKey === true ? state.history.redo() : state.history.undo();
        if (changed) {
          store.notify();
          schedule();
        }
      }

      /** 窗口尺寸变化：重算标定、重画底图、夹住选区。 */
      function onWindowResize() {
        if (!active) return;
        const box = overlayBox();
        const frame = state.frame;
        if (box === null || frame === null) return;
        boxRef.current = box;
        state.calibration = calibrateFrame(frame.capture, box, currentDpr());
        sizeCanvas(baseRef.current, box.width, box.height, state.calibration.dpr);
        sizeCanvas(annRef.current, box.width, box.height, state.calibration.dpr);
        paintFrozenFrame(frame, state.calibration);
        if (state.selection !== null && state.calibration !== null) {
          const box = selectableBox();
          if (box !== null) state.selection = clampRectToFrame(state.selection, box.width, box.height);
        }
        store.notify();
        schedule();
      }

      /** 卸载/退出截图模式时摘监听、释放画布与池（D-7 / D-9）。 */
      function teardown() {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const pool = poolRef.current;
        if (pool !== null) {
          pool.release();
          poolRef.current = null;
        }
        sizeCanvas(baseRef.current, 1, 1, 1);
        sizeCanvas(annRef.current, 1, 1, 1);
        viewRef.current = null;
        boxRef.current = null;
        dragRef.current = null;
      }

      // ── 进入截图模式：测量 + 画冻结帧 + 挂监听（D-1 计时在这里收口）──────
      React.useLayoutEffect(() => {
        if (!active) return undefined;
        const frame = state.frame;
        const root = rootRef.current;
        if (frame === null || root === null) return undefined;
        const box = overlayBox();
        if (box === null) return undefined;
        boxRef.current = box;
        const cal = calibrateFrame(frame.capture, box, currentDpr());
        state.calibration = cal;
        if (poolRef.current === null) poolRef.current = createScratchPool();
        sizeCanvas(baseRef.current, box.width, box.height, cal.dpr);
        sizeCanvas(annRef.current, box.width, box.height, cal.dpr);
        paintFrozenFrame(frame, cal);
        layoutChrome();
        paintAnnotations();
        try {
          root.focus({ preventScroll: true });
        } catch (error) {
          logger.warn('overlay focus failed', errorText(error));
        }
        const onKey = (event) => {
          try {
            latestRef.current.onKeyDown(event);
          } catch (error) {
            logger.warn('keydown handler failed', errorText(error));
          }
        };
        const onResize = () => {
          try {
            latestRef.current.onWindowResize();
          } catch (error) {
            logger.warn('resize handler failed', errorText(error));
          }
        };
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onResize);
        logger.info('overlay ready', {
          elapsedMs: Math.round(nowMs() - frame.startedAt),
          widthPx: frame.capture.widthPx,
          heightPx: frame.capture.heightPx,
          scale: cal.scale,
          method: cal.method,
          reason: cal.reason,
          degraded: cal.degraded,
          screenScale: cal.screenScale,
          frameBox: cal.frameBox,
          overlayCss: box,
          hostViewportCss: frame.capture.viewportCss,
          viewportMatchesOverlay: cal.viewportMatch,
          dpr: cal.dpr,
        });
        if (cal.viewportMatch === false) {
          // 交叉校验失败只记一条诊断（PRD 6.3-4：两个来源互相校验，不静默取其一）。
          logger.warn('host viewport differs from the measured overlay box', {
            hostViewportCss: frame.capture.viewportCss,
            overlayCss: box,
          });
        }
        if (cal.degraded) {
          state.notice = { kind: 'warn', text: TEXT.degradedCalibration };
          store.notify();
        }
        return () => {
          document.removeEventListener('keydown', onKey, true);
          window.removeEventListener('resize', onResize);
          teardown();
        };
      }, [active, state.frame]);

      // 让 effect 里注册的监听器始终调用最新一版处理函数。
      latestRef.current = { onKeyDown, onWindowResize };

      // 工具栏尺寸测量（渲染后、绘制前）：只用于边缘避让。
      React.useLayoutEffect(() => {
        const element = toolbarRef.current;
        if (element === null) return;
        const rect = element.getBoundingClientRect();
        if (Math.abs(rect.width - toolbarSize.width) > 0.5 || Math.abs(rect.height - toolbarSize.height) > 0.5) {
          setToolbarSize({ width: rect.width, height: rect.height });
        }
      });

      const actions = {
        insert: () => {
          void runOutput('insert');
        },
        copy: () => {
          void runOutput('copy');
        },
        save: () => {
          void runOutput('save');
        },
        cancel: () => cancelShot('toolbar'),
        undo: () => {
          clearAnnotationSelection();
          if (state.history.undo()) {
            store.notify();
            schedule();
          }
        },
        redo: () => {
          clearAnnotationSelection();
          if (state.history.redo()) {
            store.notify();
            schedule();
          }
        },
      };

      const selection = state.selection;
      const plan = active && selection !== null ? planFor(selection) : null;
      const toolbarVisible = active && selection !== null && !dragging;
      const toolbarStyle = toolbarVisible ? toolbarPosition(selection, boxRef.current, toolbarSize) : { display: 'none' };
      const dispatch = (handler) => (event) => {
        try {
          handler(event);
        } catch (error) {
          logger.warn('pointer handler failed', errorText(error));
        }
      };

      return h(React.Fragment, null,
        h('div', {
          ref: rootRef,
          role: 'dialog',
          'aria-label': TEXT.button,
          'aria-hidden': active ? undefined : 'true',
          tabIndex: -1,
          onPointerDown: dispatch(onPointerDown),
          onPointerMove: dispatch(onPointerMove),
          onPointerUp: dispatch(onPointerUp),
          onPointerCancel: dispatch(onPointerCancel),
          onContextMenu: (event) => {
            try {
              event.preventDefault();
              cancelShot('contextmenu');
            } catch (error) {
              logger.warn('contextmenu handler failed', errorText(error));
            }
          },
          style: {
            position: 'fixed',
            inset: 0,
            display: active ? 'block' : 'none',
            // shell.overlay 层本身 click-through，条目必须自己 opt-in 指针事件（t1 §2）。
            pointerEvents: 'auto',
            touchAction: 'none',
            userSelect: 'none',
            cursor: 'crosshair',
            overflow: 'hidden',
            background: TOKEN.mask,
          },
        },
          h('canvas', { ref: baseRef, style: CANVAS_STYLE }),
          h('div', { ref: maskAllRef, style: MASK_STYLE }),
          h('div', { ref: maskTopRef, style: MASK_STYLE }),
          h('div', { ref: maskRightRef, style: MASK_STYLE }),
          h('div', { ref: maskBottomRef, style: MASK_STYLE }),
          h('div', { ref: maskLeftRef, style: MASK_STYLE }),
          h('canvas', { ref: annRef, style: CANVAS_STYLE }),
          h('div', { ref: selectionRef, style: SELECTION_STYLE },
            HANDLES.map((handle) => h('div', {
              key: handle,
              ref: (element) => {
                handleEls.current[handle] = element;
              },
              style: HANDLE_STYLE,
            }))),
          h('div', { ref: annotationBoxRef, style: ANNOTATION_BOX_STYLE },
            CORNER_HANDLES.map((id) => h('div', {
              key: id,
              ref: (element) => {
                annotationHandleEls.current[id] = element;
              },
              style: ANNOTATION_HANDLE_STYLE,
            }))),
          h('div', { ref: crossXRef, style: CROSS_STYLE }),
          h('div', { ref: crossYRef, style: CROSS_STYLE }),
          h('div', { ref: badgeRef, style: BADGE_STYLE }, ''),
          active && selection === null ? h('div', uiSurfaceProps({ style: HINT_STYLE }), TEXT.hint) : null,
          state.editor !== null ? h(TextEditor, {
            key: `${state.editor.cssX}:${state.editor.cssY}`,
            editor: state.editor,
            onCommit: commitEditor,
            onCancel: () => {
              state.editor = null;
              store.notify();
              schedule();
            },
          }) : null,
          h(Toolbar, {
            ref: toolbarRef,
            visible: toolbarVisible,
            style: toolbarStyle,
            plan,
            busy: state.busy,
            notice: state.notice,
            actions,
          })),
        state.toast !== null ? h(Toast, { toast: state.toast }) : null);
    }

    /**
     * 工具栏位置：跟随选区并避让屏幕边缘（PRD F-08）。
     * @param {object} selection
     * @param {{width: number, height: number}|null} box
     * @param {{width: number, height: number}} size
     * @returns {object}
     */
    function toolbarPosition(selection, box, size) {
      if (box === null) return { display: 'none' };
      const width = size.width > 0 ? size.width : 420;
      const height = size.height > 0 ? size.height : 96;
      const maxX = Math.max(EDGE_MARGIN, box.width - width - EDGE_MARGIN);
      const x = clamp(selection.x + selection.width - width, EDGE_MARGIN, maxX);
      let y = selection.y + selection.height + 8;
      if (y + height + EDGE_MARGIN > box.height) y = selection.y - height - 8;
      const maxY = Math.max(EDGE_MARGIN, box.height - height - EDGE_MARGIN);
      return {
        left: `${x}px`,
        top: `${clamp(y, EDGE_MARGIN, maxY)}px`,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 工具栏 / 文字输入框 / 轻提示
    // ─────────────────────────────────────────────────────────────────────────

    /** 工具栏里的工具顺序：移动在最前（进入截图模式的默认工具，F-08 拖动内部平移）。 */
    const TOOL_BUTTONS = Object.freeze([TOOL_MOVE, ...TOOL_IDS]);
    /**
     * 会用**线宽**的工具（t68）：矩形/椭圆/箭头/画笔。马赛克有粒度、文字有字号，
     * 那两个工具下不显示线宽档位（面板侧同一规则，见 `overlay/overlay.js` 的 `WIDTH_TOOL_IDS`）。
     */
    const WIDTH_TOOL_IDS = Object.freeze(TOOL_IDS.filter((id) => id !== 'mosaic' && id !== 'text'));
    /**
     * 会用到**颜色**的工具（t72，用户口径）：矩形/椭圆/箭头/画笔/文字 —— 移动不落色、
     * 马赛克的颜色不参与绘制，两者都不显示色板。面板侧同一规则（`COLOR_TOOL_IDS`）。
     */
    const COLOR_TOOL_IDS = Object.freeze(TOOL_IDS.filter((id) => id !== 'mosaic'));
    /**
     * 工具栏：工具 → 风格 → 输出三动作（「插入对话」为默认高亮动作，PRD D-2）。
     * 动作经由 `props.actions` 注入，逻辑只有覆盖层那一份。
     * @param {object} props
     */
    const Toolbar = React.forwardRef(function Toolbar(props, ref) {
      const runtime = useShotStore();
      const state = runtime.state;
      if (props.visible !== true) return h('div', uiSurfaceProps({ ref, style: { display: 'none' } }));
      const actions = props.actions;
      const disabled = props.busy === true;
      const plan = props.plan;
      return h('div', uiSurfaceProps({ ref, style: { ...TOOLBAR_STYLE, ...props.style } }),
        h('div', { style: ROW_STYLE },
          TOOL_BUTTONS.map((id) => h(ToolButton, {
            key: id,
            icon: id,
            label: id === TOOL_MOVE ? TEXT.tools.move : TEXT.tools[id],
            active: state.tool === id,
            disabled,
            onClick: () => {
              state.tool = id;
              store.notify();
            },
          })),
          h('span', { style: DIVIDER_STYLE }),
          h(ToolButton, {
            icon: 'undo',
            label: TEXT.undo,
            active: false,
            disabled: disabled || !state.history.canUndo(),
            onClick: actions.undo,
          }),
          h(ToolButton, {
            icon: 'redo',
            label: TEXT.redo,
            active: false,
            disabled: disabled || !state.history.canRedo(),
            onClick: actions.redo,
          }),
          h('span', { style: GROW_STYLE }),
          plan === null ? null : h('span', { style: SIZE_LABEL_STYLE },
            `${plan.outputWidth} × ${plan.outputHeight} px${plan.sourceScale < 1 ? ' ↓' : ''}`)),
        h('div', { style: ROW_STYLE },
          // t72：颜色只在"会落色"的工具下出现（矩形/椭圆/箭头/画笔/文字）—— 移动不落色、
          // 马赛克的颜色不参与绘制；与面板侧同一规则（`overlay/overlay.js` 的 `COLOR_TOOL_IDS`）。
          COLOR_TOOL_IDS.includes(state.tool)
            ? COLORS.map((color) => h('button', {
              key: color.id,
              type: 'button',
              'aria-label': TEXT.colors[color.id] ?? color.id,
              title: TEXT.colors[color.id] ?? color.id,
              'aria-pressed': state.color === color.value ? 'true' : 'false',
              disabled,
              onMouseDown: preventFocusLoss,
              onClick: () => {
                state.color = color.value;
                store.notify();
              },
              style: {
                width: 20,
                height: 20,
                padding: 0,
                borderRadius: 10,
                // 调色板色是「标注图形本身的颜色」，t1 §3 允许硬编码（来源见 INLINE 段的 COLORS）。
                background: color.value,
                border: state.color === color.value ? `2px solid ${TOKEN.panelLabel}` : `1px solid ${TOKEN.toolFill}`,
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.6 : 1,
              },
            }))
            : null,
          COLOR_TOOL_IDS.includes(state.tool) || WIDTH_TOOL_IDS.includes(state.tool)
            ? h('span', { style: DIVIDER_STYLE })
            : null,
          // t68：线宽只在矩形/椭圆/箭头/画笔下出现（马赛克有粒度、文字有字号，各自管各自的档位）。
          WIDTH_TOOL_IDS.includes(state.tool)
            ? LINE_WIDTH_ORDER.map((key) => h(TextChip, {
              key,
              label: TEXT.widths[key] ?? key,
              active: state.widthKey === key,
              disabled,
              onClick: () => {
                state.widthKey = key;
                store.notify();
              },
            }))
            : null,
          state.tool === 'text'
            ? h(React.Fragment, null,
              h('span', { style: DIVIDER_STYLE }),
              TEXT_SIZE_ORDER.map((key) => h(TextChip, {
                key,
                label: TEXT.textSizes[key] ?? key,
                active: state.textSizeKey === key,
                disabled,
                onClick: () => {
                  state.textSizeKey = key;
                  store.notify();
                },
              })))
            : null,
          state.tool === 'mosaic'
            ? h(React.Fragment, null,
              h('span', { style: DIVIDER_STYLE }),
              h('span', { style: SIZE_LABEL_STYLE }, TEXT.mosaicLabel),
              MOSAIC_STEPS_UI.map((step) => h(TextChip, {
                key: step,
                label: MOSAIC_STEP_LABELS[step] ?? String(step),
                active: state.mosaicStep === step,
                disabled,
                onClick: () => {
                  state.mosaicStep = step;
                  store.notify();
                },
              })))
            : null),
        state.selectedAnnotationIndex === null
          ? null
          : h('div', { style: SIZE_LABEL_STYLE }, TEXT.selectedHint),
        props.notice === null || props.notice === undefined
          ? null
          : h('div', { style: props.notice.kind === 'error' ? NOTICE_STYLE : NOTICE_INFO_STYLE }, props.notice.text),
        h('div', { style: ROW_STYLE },
          h('button', {
            type: 'button',
            'aria-label': TEXT.insert,
            title: TEXT.insert,
            disabled,
            onMouseDown: preventFocusLoss,
            onClick: actions.insert,
            style: { ...PRIMARY_ACTION_STYLE, opacity: disabled ? 0.6 : 1 },
          }, disabled ? TEXT.working : TEXT.insert),
          h('button', {
            type: 'button',
            'aria-label': TEXT.copy,
            title: TEXT.copy,
            disabled,
            onMouseDown: preventFocusLoss,
            onClick: actions.copy,
            style: { ...ACTION_STYLE, opacity: disabled ? 0.6 : 1 },
          }, TEXT.copy),
          h('button', {
            type: 'button',
            'aria-label': TEXT.save,
            title: TEXT.save,
            disabled,
            onMouseDown: preventFocusLoss,
            onClick: actions.save,
            style: { ...ACTION_STYLE, opacity: disabled ? 0.6 : 1 },
          }, TEXT.save),
          h('button', {
            type: 'button',
            'aria-label': TEXT.cancel,
            title: TEXT.cancel,
            disabled,
            onMouseDown: preventFocusLoss,
            onClick: actions.cancel,
            style: { ...ACTION_STYLE, opacity: disabled ? 0.6 : 1 },
          }, closeIcon(14))));
    });

    /** @param {object} props */
    function ToolButton(props) {
      const [hovered, setHovered] = React.useState(false);
      const disabled = props.disabled === true;
      const icon = props.icon === 'undo' ? undoIcon(15) : props.icon === 'redo' ? redoIcon(15) : toolIcon(props.icon, 15);
      return h('button', {
        type: 'button',
        'aria-label': props.label,
        title: props.label,
        'aria-pressed': props.active === true ? 'true' : 'false',
        disabled,
        onMouseDown: preventFocusLoss,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onClick: () => props.onClick(),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          padding: 0,
          border: 'none',
          borderRadius: 8,
          background: props.active === true ? TOKEN.accent : hovered && !disabled ? TOKEN.toolHover : 'transparent',
          color: props.active === true ? TOKEN.onAccent : TOKEN.panelLabel,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
        },
      }, icon);
    }

    /** @param {object} props */
    function TextChip(props) {
      const disabled = props.disabled === true;
      return h('button', {
        type: 'button',
        'aria-label': props.label,
        title: props.label,
        'aria-pressed': props.active === true ? 'true' : 'false',
        disabled,
        onMouseDown: preventFocusLoss,
        onClick: () => props.onClick(),
        style: {
          minWidth: 22,
          height: 22,
          padding: '0 6px',
          border: 'none',
          borderRadius: 6,
          background: props.active === true ? TOKEN.accent : TOKEN.toolFillInvisible,
          color: props.active === true ? TOKEN.onAccent : TOKEN.panelLabel,
          fontSize: 12,
          lineHeight: '22px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
        },
      }, props.label);
    }

    /**
     * 文字标注输入框：落在点击位置，回车提交、Esc 取消（B-6 文字工具）。
     * @param {object} props
     */
    function TextEditor(props) {
      const [value, setValue] = React.useState('');
      const inputRef = React.useRef(null);
      React.useEffect(() => {
        const input = inputRef.current;
        if (input !== null) input.focus();
      }, []);
      return h('input', uiSurfaceProps({
        ref: inputRef,
        'data-dsh-screenshot-editor': 'true',
        'aria-label': TEXT.editorPlaceholder,
        placeholder: TEXT.editorPlaceholder,
        value,
        onChange: (event) => setValue(event.target.value),
        onKeyDown: (event) => {
          try {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              props.onCommit(value);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              props.onCancel();
            }
          } catch (error) {
            logger.warn('editor keydown failed', errorText(error));
          }
        },
        onBlur: () => props.onCommit(value),
        style: {
          position: 'absolute',
          left: `${props.editor.cssX}px`,
          top: `${props.editor.cssY}px`,
          minWidth: 168,
          padding: '4px 8px',
          border: `1px solid ${TOKEN.accent}`,
          borderRadius: 6,
          background: TOKEN.panel,
          color: TOKEN.panelLabel,
          fontSize: 13,
          outline: 'none',
        },
      }));
    }

    /**
     * 轻提示（D-3：成功后要有反馈）。
     * @param {object} props
     */
    function Toast(props) {
      const color = props.toast.kind === 'error'
        ? TOKEN.error
        : props.toast.kind === 'success'
          ? TOKEN.success
          : TOKEN.warn;
      return h('div', uiSurfaceProps({ role: 'status', style: TOAST_STYLE }),
        h('span', {
          style: {
            width: 6,
            height: 6,
            borderRadius: 3,
            background: color,
            display: 'inline-block',
            marginRight: 8,
            flex: '0 0 auto',
          },
        }),
        h('span', null, props.toast.text));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 静态样式（只用 --dsw-alias-* 令牌；布局值用数字）
    // ─────────────────────────────────────────────────────────────────────────

    const CANVAS_STYLE = Object.freeze({
      position: 'absolute',
      left: 0,
      top: 0,
      display: 'block',
      pointerEvents: 'none',
    });

    const MASK_STYLE = Object.freeze({
      position: 'absolute',
      background: TOKEN.mask,
      display: 'none',
      pointerEvents: 'none',
    });

    const SELECTION_STYLE = Object.freeze({
      position: 'absolute',
      display: 'none',
      pointerEvents: 'none',
      boxShadow: `0 0 0 1px ${TOKEN.accent}`,
    });

    const HANDLE_STYLE = Object.freeze({
      position: 'absolute',
      width: HANDLE_SIZE,
      height: HANDLE_SIZE,
      borderRadius: 2,
      background: TOKEN.accent,
      border: `1px solid ${TOKEN.panelLabel}`,
      boxSizing: 'border-box',
      display: 'none',
    });

    /** 已放置标注的选中框：虚线（与选区的实线框区分）。 */
    const ANNOTATION_BOX_STYLE = Object.freeze({
      position: 'absolute',
      display: 'none',
      pointerEvents: 'none',
      border: `1px dashed ${TOKEN.accent}`,
      boxSizing: 'border-box',
    });

    /** 标注角把手方块（命中由根部按坐标判定，元素本身不吃指针）。 */
    const ANNOTATION_HANDLE_STYLE = Object.freeze({
      position: 'absolute',
      width: ANNOTATION_HANDLE_SIZE,
      height: ANNOTATION_HANDLE_SIZE,
      borderRadius: 2,
      background: TOKEN.accent,
      border: `1px solid ${TOKEN.panelLabel}`,
      boxSizing: 'border-box',
      display: 'none',
      pointerEvents: 'none',
    });

    const CROSS_STYLE = Object.freeze({
      position: 'absolute',
      display: 'none',
      background: TOKEN.accent,
      opacity: 0.9,
      pointerEvents: 'none',
    });

    const BADGE_STYLE = Object.freeze({
      position: 'absolute',
      display: 'none',
      padding: '3px 8px',
      borderRadius: 6,
      background: TOKEN.panel,
      color: TOKEN.panelLabel,
      fontSize: 12,
      lineHeight: '16px',
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
    });

    const HINT_STYLE = Object.freeze({
      position: 'absolute',
      left: '50%',
      bottom: 32,
      transform: 'translateX(-50%)',
      padding: '6px 14px',
      borderRadius: 8,
      background: TOKEN.panel,
      color: TOKEN.panelLabel,
      fontSize: 13,
      lineHeight: '18px',
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
    });

    const TOOLBAR_STYLE = Object.freeze({
      position: 'absolute',
      display: 'inline-flex',
      flexDirection: 'column',
      gap: 6,
      padding: 8,
      borderRadius: 12,
      background: TOKEN.panel,
      color: TOKEN.panelLabel,
      border: `1px solid ${TOKEN.border}`,
      maxWidth: 'calc(100vw - 24px)',
    });

    const ROW_STYLE = Object.freeze({
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'nowrap',
    });

    const GROW_STYLE = Object.freeze({ flex: '1 1 auto' });

    // ── 插件页「截图模式」那一行（t74）：只用主题令牌，不写死颜色（D-11） ──
    /** 下拉框 id：`<label htmlFor>` 指向它（无障碍；DSH 自己的设置页也是这么做的）。 */
    const SETTING_SELECT_ID = 'dsh-screenshot-capture-mode';
    /** 页面级令牌（t74c）：toast 系令牌在浅色插件页上等于隐形，标签必须用页面文字色。 */
    const PAGE_TOKEN = Object.freeze({
      label: 'var(--dsw-alias-label-primary)',
      caption: 'var(--dsw-alias-label-tertiary)',
      field: 'var(--dsw-alias-bg-module-platform)',
      fieldBorder: 'var(--dsw-alias-border-l2)',
    });
    const SETTING_ROW_STYLE = Object.freeze({
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
      padding: '6px 0',
    });
    const SETTING_LABEL_STYLE = Object.freeze({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 14,
      lineHeight: '22px',
      color: PAGE_TOKEN.label,
    });
    const SETTING_LABEL_TEXT_STYLE = Object.freeze({ whiteSpace: 'nowrap' });
    const SETTING_SELECT_STYLE = Object.freeze({
      height: 32,
      minWidth: 260,
      padding: '0 8px',
      borderRadius: 6,
      fontSize: 14,
      lineHeight: '20px',
      color: PAGE_TOKEN.label,
      background: PAGE_TOKEN.field,
      border: `1px solid ${PAGE_TOKEN.fieldBorder}`,
      cursor: 'pointer',
    });
    const SETTING_NOTE_STYLE = Object.freeze({
      fontSize: 12,
      lineHeight: '18px',
      color: PAGE_TOKEN.caption,
    });

    const DIVIDER_STYLE = Object.freeze({
      width: 1,
      height: 18,
      background: TOKEN.border,
      display: 'inline-block',
      margin: '0 2px',
      flex: '0 0 auto',
    });

    const SIZE_LABEL_STYLE = Object.freeze({
      fontSize: 12,
      lineHeight: '18px',
      color: TOKEN.panelLabel,
      opacity: 0.85,
      whiteSpace: 'nowrap',
    });

    const NOTICE_STYLE = Object.freeze({
      fontSize: 12,
      lineHeight: '18px',
      color: TOKEN.error,
      maxWidth: 420,
      whiteSpace: 'normal',
    });

    /** 忙时/信息类提示：用面板文字色（错误提示才用红色）。 */
    const NOTICE_INFO_STYLE = Object.freeze({ ...NOTICE_STYLE, color: TOKEN.panelLabel });

    const ACTION_STYLE = Object.freeze({
      minWidth: 72,
      height: 28,
      padding: '0 10px',
      border: 'none',
      borderRadius: 8,
      background: TOKEN.toolFill,
      color: TOKEN.panelLabel,
      fontSize: 13,
      lineHeight: '28px',
      cursor: 'pointer',
    });

    const PRIMARY_ACTION_STYLE = Object.freeze({
      minWidth: 104,
      height: 28,
      padding: '0 12px',
      border: 'none',
      borderRadius: 8,
      background: TOKEN.accent,
      color: TOKEN.onAccent,
      fontSize: 13,
      lineHeight: '28px',
      fontWeight: 500,
      cursor: 'pointer',
    });

    const TOAST_STYLE = Object.freeze({
      position: 'fixed',
      left: '50%',
      bottom: 96,
      transform: 'translateX(-50%)',
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: '70vw',
      padding: '8px 14px',
      borderRadius: 10,
      background: TOKEN.panel,
      color: TOKEN.panelLabel,
      fontSize: 13,
      lineHeight: '18px',
      pointerEvents: 'none',
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 右键模式菜单的样式（只用 --dsw-alias-* 令牌，D-10/D-11）
    // ─────────────────────────────────────────────────────────────────────────

    /** 菜单宽度（定位时用它夹在视口内）。 */
    const MODE_MENU_WIDTH = 300;

    const MODE_MENU_STYLE = Object.freeze({
      position: 'fixed',
      zIndex: 2147483000,
      width: MODE_MENU_WIDTH,
      padding: 6,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: 10,
      background: TOKEN.panel,
      color: TOKEN.panelLabel,
      font: 'inherit',
    });

    const MODE_MENU_TITLE_STYLE = Object.freeze({
      padding: '4px 8px 6px',
      color: TOKEN.labelCaption,
      fontSize: 12,
      lineHeight: '16px',
    });

    const MODE_ITEM_STYLE = Object.freeze({
      display: 'grid',
      gridTemplateColumns: '14px 1fr',
      gap: 6,
      alignItems: 'start',
      padding: '6px 8px',
      borderRadius: 8,
      cursor: 'pointer',
    });

    const MODE_ITEM_ACTIVE_STYLE = Object.freeze({ background: TOKEN.hover });

    const MODE_CHECK_STYLE = Object.freeze({
      color: TOKEN.accent,
      fontSize: 10,
      lineHeight: '18px',
      textAlign: 'center',
    });

    const MODE_ITEM_TEXT_STYLE = Object.freeze({ display: 'grid', gap: 2 });

    const MODE_ITEM_LABEL_STYLE = Object.freeze({ fontSize: 13, lineHeight: '18px' });

    const MODE_ITEM_HINT_STYLE = Object.freeze({ color: TOKEN.labelCaption, fontSize: 11, lineHeight: '15px' });

    const MODE_MENU_HINT_STYLE = Object.freeze({
      padding: '6px 8px 2px',
      marginTop: 4,
      borderTop: `1px solid ${TOKEN.border}`,
      color: TOKEN.labelCaption,
      fontSize: 11,
      lineHeight: '15px',
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 槽位注册
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 给槽位条目加一层错误边界：单个组件抛错只让该条目渲染为空，
     * 不会冒泡成宿主槽位条目崩溃（D-12）。
     * @param {Function} Component
     * @returns {Function}
     */
    function withBoundary(Component) {
      class SlotBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { failed: false };
        }

        static getDerivedStateFromError() {
          return { failed: true };
        }

        componentDidCatch(error) {
          logger.warn('slot component error contained', errorText(error));
        }

        render() {
          if (this.state.failed === true) return null;
          return h(Component, this.props);
        }
      }
      return SlotBoundary;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // t73：先把上次选定的抓屏模式读回来（设置页改过、或上次右键选过都在这里生效），
        // 失败就保持默认的穿透 —— 这是纯偏好，不该挡住按钮与覆盖层的注册。
        void loadCaptureMode(store);
        try {
          // 按钮：conversation.input.right（list）—— 与既有条目并排，不遮蔽任何人。
          ctx.slots.inject(BUTTON_SLOT, () => ctx.slots.register({
            name: BUTTON_SLOT,
            id: BUTTON_ID,
            order: BUTTON_ORDER,
          }, withBoundary(ScreenshotButton)));
        } catch (error) {
          logger.warn('button slot registration failed', errorText(error));
        }
        try {
          // 覆盖层：shell.overlay（list / scope=root）—— 框架级浮层，条目自己 opt-in 指针事件。
          ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
            name: OVERLAY_SLOT,
            id: OVERLAY_ID,
            order: OVERLAY_ORDER,
          }, withBoundary(OverlayLayer)));
        } catch (error) {
          logger.warn('overlay slot registration failed', errorText(error));
        }
        try {
          // t74：插件页的配置区（`plugins.bundle.config`，key = 包名）—— 和语音输入插件同一套做法。
          // 没有这条贡献时，插件页连配置 section 都不渲染，用户就只能在右键菜单里切模式。
          ctx.slots.inject(PLUGIN_CONFIG_SLOT, () => ctx.slots.register({
            name: PLUGIN_CONFIG_SLOT,
            key: PLUGIN_PACKAGE,
            order: PLUGIN_CONFIG_ORDER,
          }, withBoundary(CaptureModeSetting)));
        } catch (error) {
          logger.warn('plugin page config registration failed', errorText(error));
        }
      },
    };
  },
});
