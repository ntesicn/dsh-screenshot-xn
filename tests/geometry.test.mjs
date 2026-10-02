/** Geometry, selection rules and handle hit-testing (PRD F-06 … F-09, F-23). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendPoint,
  arrowHead,
  arrowHeadSize,
  clamp,
  clampRectToFrame,
  cursorForHandle,
  EMPTY_RECT,
  HANDLES,
  handlePoint,
  hitHandle,
  isValidSelection,
  MIN_SELECTION_EDGE,
  normalizeRect,
  rectFromCorners,
  resizeRect,
  roundRectPath,
  scaleRect,
  toIntegerRect,
} from '../lib/geometry.mjs';
import { createRecordingContext } from './helpers/recording-context.mjs';

test('clamp keeps values inside an inclusive range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp(5, 10, 0), 10, 'an inverted range yields min, never NaN');
});

test('rectFromCorners normalizes a backwards drag', () => {
  assert.deepEqual(rectFromCorners({ x: 100, y: 80 }, { x: 40, y: 20 }), { x: 40, y: 20, width: 60, height: 60 });
  assert.deepEqual(rectFromCorners({ x: 10, y: 10 }, { x: 10, y: 10 }), EMPTY_RECT);
});

test('normalizeRect handles negative extents', () => {
  assert.deepEqual(normalizeRect({ x: 50, y: 50, width: -20, height: -30 }), { x: 30, y: 20, width: 20, height: 30 });
});

test('isValidSelection enforces the 8px minimum on both edges (F-09)', () => {
  assert.equal(isValidSelection({ x: 0, y: 0, width: 8, height: 8 }), true);
  assert.equal(isValidSelection({ x: 0, y: 0, width: 7.9, height: 400 }), false);
  assert.equal(isValidSelection({ x: 0, y: 0, width: 400, height: 7.9 }), false);
  assert.equal(isValidSelection({ x: 0, y: 0, width: 1, height: 1 }), false);
  assert.equal(MIN_SELECTION_EDGE, 8);
});

test('isValidSelection measures device pixels, not CSS pixels', () => {
  const css = { x: 0, y: 0, width: 5, height: 5 };
  assert.equal(isValidSelection(css), false, '5 CSS px at 100% is below the threshold');
  const at100 = scaleRect(css, 1);
  const at200 = scaleRect(css, 2);
  assert.equal(isValidSelection(at100), false);
  assert.equal(isValidSelection(at200), true, '5 CSS px at 200% is 10 device px');
});

test('scaleRect converts CSS to device space and rejects a zero scale', () => {
  assert.deepEqual(scaleRect({ x: 2, y: 3, width: 10, height: 20 }, 1.5), { x: 3, y: 4.5, width: 15, height: 30 });
  assert.throws(() => scaleRect({ x: 0, y: 0, width: 1, height: 1 }, 0), RangeError);
});

test('toIntegerRect rounds outward and clips to the frame', () => {
  assert.deepEqual(toIntegerRect({ x: 10.2, y: 10.8, width: 100.5, height: 50.5 }, 2000, 2000), {
    x: 10,
    y: 10,
    width: 101,
    height: 52,
  });
  assert.deepEqual(toIntegerRect({ x: -20, y: -20, width: 30, height: 30 }, 2000, 2000), {
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  });
  assert.deepEqual(toIntegerRect({ x: 1995, y: 1995, width: 100, height: 100 }, 2000, 2000), {
    x: 1995,
    y: 1995,
    width: 5,
    height: 5,
  });
});

test('clampRectToFrame translates without resizing', () => {
  assert.deepEqual(clampRectToFrame({ x: -50, y: 30, width: 100, height: 100 }, 800, 600), {
    x: 0,
    y: 30,
    width: 100,
    height: 100,
  });
  assert.deepEqual(clampRectToFrame({ x: 0, y: 0, width: 900, height: 700 }, 800, 600), {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });
});

test('resizeRect keeps the opposite edge fixed for every handle', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  assert.deepEqual(resizeRect(rect, 'se', { x: 400, y: 300 }, 2000, 2000), { x: 100, y: 100, width: 300, height: 200 });
  assert.deepEqual(resizeRect(rect, 'nw', { x: 50, y: 60 }, 2000, 2000), { x: 50, y: 60, width: 250, height: 140 });
  assert.deepEqual(resizeRect(rect, 'e', { x: 500, y: 999 }, 2000, 2000), { x: 100, y: 100, width: 400, height: 100 });
  assert.deepEqual(resizeRect(rect, 'n', { x: 999, y: 40 }, 2000, 2000), { x: 100, y: 40, width: 200, height: 160 });
  // Dragging the west handle past the east edge mirrors the rectangle: the east
  // edge stays at x = 300 (the fixed edge never moves), so the box flips to the
  // pointer's side and its width is |900 - 300| = 600.
  assert.deepEqual(resizeRect(rect, 'w', { x: 900, y: 100 }, 2000, 2000), { x: 300, y: 100, width: 600, height: 100 });
});

test('resizeRect clips the moving corner to the frame', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  assert.deepEqual(resizeRect(rect, 'se', { x: 9999, y: 9999 }, 800, 600), { x: 100, y: 100, width: 700, height: 500 });
  assert.deepEqual(resizeRect(rect, 'nw', { x: -500, y: -500 }, 800, 600), { x: 0, y: 0, width: 300, height: 200 });
});

test('hitHandle grabs corners before edges and misses far points', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  // (302, 102) is 2px inside the right edge and 2px below the top edge: the
  // top-right corner, and corners win over either edge on their own.
  assert.equal(hitHandle(rect, { x: 302, y: 102 }, 6), 'ne');
  assert.equal(hitHandle(rect, { x: 98, y: 100 }, 6), 'nw');
  assert.equal(hitHandle(rect, { x: 200, y: 198 }, 6), 's', '2px above the bottom edge, away from both sides');
  assert.equal(hitHandle(rect, { x: 0, y: 0 }, 6), null);
  assert.equal(hitHandle(rect, { x: 200, y: 298 }, 6), null, '98px past the bottom edge is outside the 6px tolerance');
  assert.equal(hitHandle(rect, { x: 200, y: 150 }, 6), null, 'the interior is a move, not a resize');
});

test('handlePoint and cursorForHandle cover all eight handles', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };
  assert.equal(HANDLES.length, 8);
  assert.deepEqual(handlePoint(rect, 'nw'), { x: 10, y: 20 });
  assert.deepEqual(handlePoint(rect, 'se'), { x: 110, y: 70 });
  assert.deepEqual(handlePoint(rect, 'n'), { x: 60, y: 20 });
  assert.equal(cursorForHandle('nw'), 'nwse-resize');
  assert.equal(cursorForHandle('ne'), 'nesw-resize');
  assert.equal(cursorForHandle('n'), 'ns-resize');
  assert.equal(cursorForHandle('e'), 'ew-resize');
  assert.equal(cursorForHandle('none'), 'default');
});

test('arrowHeadSize keeps the head proportional on short arrows', () => {
  const long = arrowHeadSize({ x: 0, y: 0 }, { x: 300, y: 0 }, 10);
  assert.equal(long.length, 45);
  const short = arrowHeadSize({ x: 0, y: 0 }, { x: 20, y: 0 }, 10);
  assert.equal(short.length, 12);
  assert.equal(Number(short.width.toFixed(2)), Number((12 * 0.78).toFixed(2)));
});

test('arrowHead returns tip-last-safe corners pointing along the shaft', () => {
  const [left, tip, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, 10);
  assert.deepEqual(tip, { x: 100, y: 0 });
  assert.equal(left.x, 80);
  assert.equal(right.x, 80);
  assert.equal(left.y, 5);
  assert.equal(right.y, -5);
});

test('appendPoint decimates samples closer than the threshold', () => {
  let points = [];
  points = appendPoint(points, { x: 0, y: 0 });
  points = appendPoint(points, { x: 0.5, y: 0 });
  assert.equal(points.length, 1, 'a sub-threshold sample is dropped');
  points = appendPoint(points, { x: 5, y: 0 });
  assert.equal(points.length, 2);
  const kept = appendPoint(points, { x: Number.NaN, y: 0 });
  assert.equal(kept, points, 'a non-finite sample returns the same array');
});

test('roundRectPath falls back to arcTo on a context without roundRect', () => {
  const recorder = createRecordingContext();
  roundRectPath(recorder.ctx, { x: 0, y: 0, width: 100, height: 50 }, 8);
  assert.equal(recorder.countOf('arcTo'), 4);
  assert.equal(recorder.countOf('beginPath'), 1);
  assert.equal(recorder.countOf('closePath'), 1);
});

test('roundRectPath uses the native roundRect when the context has one', () => {
  const recorder = createRecordingContext({ roundRect: true });
  roundRectPath(recorder.ctx, { x: 0, y: 0, width: 100, height: 50 }, 8);
  assert.deepEqual(recorder.firstOf('roundRect'), [0, 0, 100, 50, 8]);
  assert.equal(recorder.countOf('arcTo'), 0);
});

test('roundRectPath clamps a radius larger than the rectangle', () => {
  const recorder = createRecordingContext({ roundRect: true });
  roundRectPath(recorder.ctx, { x: 0, y: 0, width: 20, height: 10 }, 50);
  assert.deepEqual(recorder.firstOf('roundRect'), [0, 0, 20, 10, 5]);
});
