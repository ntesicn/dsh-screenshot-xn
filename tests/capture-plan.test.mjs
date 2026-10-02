/** Capture descriptor, coordinate mapping and export sizing (PRD F-10, F-23, D-3). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipSelectionToOverlay,
  effectiveScale,
  formatScaleLabel,
  normalizeCapture,
  planRender,
  screenshotFileName,
  timestampText,
} from '../lib/capture-plan.mjs';
import { MAX_EXPORT_EDGE } from '../lib/geometry.mjs';

/** A 2x display: 1280 CSS px viewport, 2560 device px frame. */
const capture2x = {
  widthPx: 2560,
  heightPx: 1440,
  scale: 2,
  viewportCss: { width: 1280, height: 720 },
  bounds: { x: 0, y: 0 },
  dataUrl: 'data:image/png;base64,AAAA',
};

test('normalizeCapture validates every field', () => {
  const capture = normalizeCapture(capture2x);
  assert.equal(capture.widthPx, 2560);
  assert.equal(capture.scale, 2);
  assert.equal(capture.dataUrl, 'data:image/png;base64,AAAA');
  assert.throws(() => normalizeCapture(null), TypeError);
  assert.throws(() => normalizeCapture({ ...capture2x, widthPx: 0 }), TypeError);
  assert.throws(() => normalizeCapture({ ...capture2x, widthPx: 10.5 }), TypeError);
  assert.throws(() => normalizeCapture({ ...capture2x, heightPx: -1 }), TypeError);
  assert.throws(() => normalizeCapture({ ...capture2x, scale: 0 }), TypeError);
});

test('normalizeCapture requires a usable image carrier', () => {
  const { dataUrl, ...withoutCarrier } = capture2x;
  assert.equal(dataUrl.startsWith('data:'), true);
  assert.throws(() => normalizeCapture(withoutCarrier), TypeError);
  assert.throws(() => normalizeCapture({ ...capture2x, dataUrl: '' }), TypeError);
  assert.equal(normalizeCapture({ ...withoutCarrier, url: '/dsh-screenshot/frame.png' }).url, '/dsh-screenshot/frame.png');
});

test('effectiveScale follows the captured frame, not devicePixelRatio', () => {
  assert.equal(effectiveScale(capture2x, { width: 1280, height: 720 }), 2);
  assert.equal(formatScaleLabel(effectiveScale(capture2x, { width: 1280, height: 720 })), '200%');
  // A frame that does not match the overlay wins: the overlay draws the frame.
  assert.equal(effectiveScale(capture2x, { width: 1024, height: 576 }), 2.5);
  // Without a usable overlay size the declared scale is the fallback.
  assert.equal(effectiveScale(capture2x, { width: 0, height: 0 }), 2);
  assert.equal(formatScaleLabel(1.25), '125%');
});

test('planRender maps a CSS selection into device pixels (D-3)', () => {
  const plan = planRender(capture2x, { x: 100, y: 50, width: 400, height: 300 });
  assert.deepEqual(plan.deviceRect, { x: 200, y: 100, width: 800, height: 600 });
  assert.equal(plan.outputWidth, 800);
  assert.equal(plan.outputHeight, 600);
  assert.equal(plan.downscaled, false);
  assert.equal(plan.valid, true);
});

test('planRender clips a selection that leaves the frame', () => {
  const plan = planRender(capture2x, { x: 1200, y: 700, width: 200, height: 200 });
  assert.deepEqual(plan.deviceRect, { x: 2400, y: 1400, width: 160, height: 40 });
  assert.equal(plan.valid, false, 'clipped to a 40px edge, the selection is no longer usable');
});

test('planRender flags an invalid selection without clamping the user away (F-09)', () => {
  const plan = planRender(capture2x, { x: 10, y: 10, width: 3, height: 3 });
  assert.equal(plan.valid, false);
  assert.equal(plan.deviceRect.width, 6);
  assert.equal(plan.deviceRect.height, 6);
});

test('planRender caps the longest edge at 4096 and keeps the aspect ratio (F-23)', () => {
  // An 8K frame at 100% zoom: selecting all of it is over the cap, so the export
  // is scaled down to 4096 x 3072 (the same 4:3 aspect ratio).
  const tall = { widthPx: 8000, heightPx: 6000, scale: 1, viewportCss: { width: 8000, height: 6000 } };
  const plan = planRender(tall, { x: 0, y: 0, width: 8000, height: 6000 });
  assert.equal(plan.outputWidth, MAX_EXPORT_EDGE);
  assert.equal(plan.outputHeight, 3072);
  assert.equal(plan.downscaled, true);
  assert.equal(plan.sourceScale, MAX_EXPORT_EDGE / 8000);
});

test('planRender leaves a selection exactly at the cap untouched', () => {
  const frame = { widthPx: 4096, heightPx: 4096, scale: 1, viewportCss: { width: 4096, height: 4096 } };
  const plan = planRender(frame, { x: 0, y: 0, width: 4096, height: 100 });
  assert.equal(plan.outputWidth, 4096);
  assert.equal(plan.downscaled, false);
  assert.equal(plan.sourceScale, 1);
});

test('planRender accepts an explicit smaller cap for settings', () => {
  // A 500 CSS px square is 1000 device px on this 2x display: inside the frame,
  // over the configured 500 px cap.
  const plan = planRender(capture2x, { x: 0, y: 0, width: 500, height: 500 }, { maxEdge: 500 });
  assert.equal(plan.outputWidth, 500);
  assert.equal(plan.outputHeight, 500);
});

test('clipSelectionToOverlay keeps a selection inside the app viewport (F-10)', () => {
  assert.deepEqual(clipSelectionToOverlay({ x: -20, y: -10, width: 100, height: 100 }, { width: 800, height: 600 }), {
    x: 0,
    y: 0,
    width: 80,
    height: 90,
  });
  assert.deepEqual(clipSelectionToOverlay({ x: 700, y: 500, width: 400, height: 400 }, { width: 800, height: 600 }), {
    x: 700,
    y: 500,
    width: 100,
    height: 100,
  });
});

test('screenshotFileName matches DSH截图_yyyyMMdd_HHmmss.png (F-22, DoD B-9)', () => {
  const date = new Date(2026, 1, 12, 14, 30, 15);
  assert.equal(screenshotFileName(date), 'DSH截图_20260212_143015.png');
  assert.equal(timestampText(new Date(2026, 0, 3, 4, 5, 6)), '20260103_040506');
  assert.equal(screenshotFileName(date, 'Shot').startsWith('Shot_'), true);
});

test('screenshotFileName accepts the project name prefix', () => {
  const date = new Date(2026, 11, 31, 23, 59, 59);
  assert.equal(screenshotFileName(date, 'dsh-screenshot'), 'dsh-screenshot_20261231_235959.png');
});
