/** The six annotation tools, their styling and their canvas output (PRD F-11 … F-18). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundsOfPoints,
  COLORS,
  colorValueOf,
  createShape,
  createStroke,
  createText,
  DEFAULT_STYLE,
  drawAnnotation,
  LINE_WIDTHS,
  LINE_WIDTH_ORDER,
  lineWidthOf,
  measureTextAnnotation,
  mosaicCellSize,
  MOSAIC_STEPS,
  TEXT_SIZE_ORDER,
  TEXT_SIZES,
  textSizeOf,
  TOOL_IDS,
  translateAnnotation,
  withTextMetrics,
} from '../lib/annotations.mjs';
import { createRecordingContext, createScratchFactory } from './helpers/recording-context.mjs';

test('the toolbar exposes exactly the six required tools', () => {
  assert.deepEqual([...TOOL_IDS], ['rect', 'ellipse', 'arrow', 'pen', 'mosaic', 'text']);
});

test('the palette carries the six required colours and defaults to red', () => {
  assert.deepEqual(COLORS.map((entry) => entry.id), ['red', 'yellow', 'green', 'blue', 'black', 'white']);
  assert.equal(DEFAULT_STYLE.color, colorValueOf('red'));
  assert.equal(colorValueOf('white'), '#ffffff');
  assert.equal(colorValueOf('nonsense'), DEFAULT_STYLE.color, 'an unknown id falls back to red');
});

test('line widths follow 细 / 中 / 粗 and grow monotonically', () => {
  assert.deepEqual([...LINE_WIDTH_ORDER], ['thin', 'medium', 'thick']);
  assert.equal(lineWidthOf('thin'), LINE_WIDTHS.thin);
  assert.equal(lineWidthOf('thick'), LINE_WIDTHS.thick);
  assert.equal(LINE_WIDTHS.thin < LINE_WIDTHS.medium && LINE_WIDTHS.medium < LINE_WIDTHS.thick, true);
  assert.equal(lineWidthOf('unknown'), LINE_WIDTHS.medium);
});

test('text sizes follow 小 / 中 / 大', () => {
  assert.deepEqual([...TEXT_SIZE_ORDER], ['small', 'medium', 'large']);
  assert.equal(TEXT_SIZES.small < TEXT_SIZES.medium && TEXT_SIZES.medium < TEXT_SIZES.large, true);
  assert.equal(textSizeOf('nope'), TEXT_SIZES.medium);
});

test('mosaic cell size grows with the intensity step and saturates', () => {
  const sizes = MOSAIC_STEPS.map(mosaicCellSize);
  for (let index = 1; index < sizes.length; index += 1) assert.equal(sizes[index] > sizes[index - 1], true);
  assert.equal(mosaicCellSize(0), 6);
  assert.equal(mosaicCellSize(99), mosaicCellSize(4), 'an out-of-range step clamps');
  assert.equal(mosaicCellSize(-5), mosaicCellSize(0));
});

test('createShape derives the rectangle from either corners or an explicit rect', () => {
  const fromCorners = createShape({ tool: 'rect', color: '#e5484d', from: { x: 40, y: 40 }, to: { x: 10, y: 90 } });
  assert.deepEqual(fromCorners.rect, { x: 10, y: 40, width: 30, height: 50 });
  const explicit = createShape({ tool: 'ellipse', color: '#000', rect: { x: 1, y: 2, width: 3, height: 4 }, widthKey: 'thick' });
  assert.deepEqual(explicit.rect, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(explicit.widthKey, 'thick');
});

test('a rectangle draws one inset stroke with the selected colour and width', () => {
  const recorder = createRecordingContext();
  const annotation = createShape({ tool: 'rect', color: '#3b82f6', widthKey: 'thick', rect: { x: 10, y: 20, width: 100, height: 60 } });
  assert.equal(drawAnnotation(recorder.ctx, annotation), true);
  assert.deepEqual(recorder.firstOf('rect'), [15, 25, 90, 50], 'the stroke is inset by half the line width');
  assert.equal(recorder.countOf('stroke'), 1);
  assert.equal(recorder.ctx.strokeStyle, '#3b82f6');
  assert.equal(recorder.ctx.lineWidth, LINE_WIDTHS.thick);
});

test('a degenerate rectangle draws nothing', () => {
  const recorder = createRecordingContext();
  assert.equal(drawAnnotation(recorder.ctx, createShape({ tool: 'rect', color: '#000', rect: { x: 5, y: 5, width: 0, height: 40 } })), false);
  assert.equal(recorder.calls.length, 0);
});

test('an ellipse strokes a centred ellipse inset by half the line width', () => {
  const recorder = createRecordingContext();
  const annotation = createShape({ tool: 'ellipse', color: '#30a46c', widthKey: 'thin', rect: { x: 0, y: 0, width: 200, height: 100 } });
  assert.equal(drawAnnotation(recorder.ctx, annotation), true);
  const args = recorder.firstOf('ellipse');
  assert.deepEqual(args.slice(0, 5), [100, 50, 98.5, 48.5, 0]);
  assert.equal(args[5], 0);
  assert.equal(Number(args[6].toFixed(4)), Number((Math.PI * 2).toFixed(4)));
  assert.equal(recorder.countOf('stroke'), 1);
});

test('an arrow strokes a shaft and fills a head pointing the way the user dragged', () => {
  const recorder = createRecordingContext();
  const annotation = createShape({
    tool: 'arrow',
    color: '#e5484d',
    widthKey: 'thin',
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
  });
  assert.equal(drawAnnotation(recorder.ctx, annotation), true);
  assert.equal(recorder.countOf('stroke'), 1, 'the shaft is stroked once');
  assert.equal(recorder.countOf('fill'), 1, 'the head is filled once');
  assert.equal(recorder.countOf('moveTo'), 2);
  const headTip = recorder.calls.filter((call) => call.name === 'lineTo')[1];
  assert.deepEqual(headTip.args, [100, 0], 'the head tip lands on the drag end');
});

test('an arrow that did not move draws nothing', () => {
  const recorder = createRecordingContext();
  const annotation = createShape({ tool: 'arrow', color: '#000', from: { x: 10, y: 10 }, to: { x: 10, y: 10 } });
  assert.equal(drawAnnotation(recorder.ctx, annotation), false);
});

test('a pen stroke follows a smoothed path and keeps round caps', () => {
  const recorder = createRecordingContext();
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 5 },
    { x: 20, y: 12 },
    { x: 30, y: 12 },
  ];
  const annotation = createStroke({ tool: 'pen', color: '#111111', widthKey: 'medium', points });
  assert.equal(drawAnnotation(recorder.ctx, annotation), true);
  assert.equal(recorder.countOf('quadraticCurveTo'), points.length - 1);
  assert.equal(recorder.countOf('lineTo'), 1, 'the path closes on the last sample');
  assert.equal(recorder.countOf('stroke'), 1);
  assert.equal(recorder.ctx.lineCap, 'round');
  assert.equal(recorder.ctx.lineJoin, 'round');
  assert.deepEqual(annotation.rect, { x: 0, y: 0, width: 30, height: 12 });
});

test('a single-tap pen stroke still leaves a dot', () => {
  const recorder = createRecordingContext();
  assert.equal(drawAnnotation(recorder.ctx, createStroke({ tool: 'pen', color: '#000', points: [{ x: 5, y: 5 }] })), true);
  assert.equal(recorder.countOf('stroke'), 1);
});

test('an empty pen stroke draws nothing', () => {
  const recorder = createRecordingContext();
  assert.equal(drawAnnotation(recorder.ctx, createStroke({ tool: 'pen', color: '#000', points: [] })), false);
});

test('boundsOfPoints returns an empty rectangle for no points', () => {
  assert.deepEqual(boundsOfPoints([]), { x: 0, y: 0, width: 0, height: 0 });
});

test('mosaic redacts through a downscale and a nearest-neighbour upscale (F-15)', () => {
  const recorder = createRecordingContext();
  const scratch = createScratchFactory();
  const annotation = createShape({ tool: 'mosaic', color: '#000', rect: { x: 20, y: 30, width: 200, height: 100 } });
  const drew = drawAnnotation(recorder.ctx, annotation, {
    mosaicSource: { tag: 'frame' },
    mosaicSourceRect: { x: 100, y: 100, width: 800, height: 600 },
    createScratch: scratch.create,
    mosaicStep: 0,
  });
  assert.equal(drew, true);
  assert.equal(scratch.surfaces.length, 2, 'two scratch surfaces: one to shrink, one to hold it');
  const cell = mosaicCellSize(0);
  const downscaled = scratch.surfaces[0].firstOf('drawImage');
  assert.deepEqual(downscaled.slice(1), [120, 130, 200, 100, 0, 0, Math.round(200 / cell), Math.round(100 / cell)]);
  const upscaled = scratch.surfaces[1].firstOf('drawImage');
  assert.deepEqual(upscaled.slice(1), [0, 0, Math.round(200 / cell), Math.round(100 / cell), 20, 30, 200, 100]);
  assert.equal(scratch.surfaces[0].ctx.imageSmoothingEnabled, true, 'the shrink averages source pixels');
  assert.equal(scratch.surfaces[1].ctx.imageSmoothingEnabled, false, 'the enlargement samples nearest-neighbour, not smoothly');
  assert.deepEqual(
    [scratch.surfaces[1].ctx.canvas.width, scratch.surfaces[1].ctx.canvas.height],
    [220, 130],
    'the staging surface shares the target coordinate system',
  );
  const composited = recorder.firstOf('drawImage');
  assert.deepEqual(
    composited.slice(1),
    [20, 30, 200, 100, 20, 30, 200, 100],
    'the pixelated grid is painted 1:1 onto the annotation box',
  );
  assert.equal(recorder.ctx.imageSmoothingEnabled, true, 'the context is restored after the nearest-neighbour pass');
});

test('mosaic honours the intensity step: a coarser step uses bigger cells', () => {
  const fine = createRecordingContext();
  const coarse = createRecordingContext();
  const base = {
    mosaicSource: { tag: 'frame' },
    mosaicSourceRect: { x: 0, y: 0, width: 800, height: 600 },
  };
  const annotation = createShape({ tool: 'mosaic', color: '#000', rect: { x: 0, y: 0, width: 200, height: 100 } });
  const fineScratch = createScratchFactory();
  const coarseScratch = createScratchFactory();
  drawAnnotation(fine.ctx, annotation, { ...base, createScratch: fineScratch.create, mosaicStep: 0 });
  drawAnnotation(coarse.ctx, annotation, { ...base, createScratch: coarseScratch.create, mosaicStep: 4 });
  // `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`: the last two arguments
  // are the cell grid, and a coarser step must pack the box into fewer cells.
  const fineCells = fineScratch.surfaces[0].firstOf('drawImage');
  const coarseCells = coarseScratch.surfaces[0].firstOf('drawImage');
  assert.equal(coarseCells[7] < fineCells[7], true);
  assert.equal(coarseCells[8] < fineCells[8], true);
});

test('mosaic without the frozen frame available draws nothing', () => {
  const recorder = createRecordingContext();
  const annotation = createShape({ tool: 'mosaic', color: '#000', rect: { x: 0, y: 0, width: 40, height: 40 } });
  assert.equal(drawAnnotation(recorder.ctx, annotation), false);
  assert.equal(recorder.calls.length, 0);
});

test('text draws a padded background box and the coloured glyphs (F-16)', () => {
  const recorder = createRecordingContext({ textWidths: { DSH12345: 70 } });
  const annotation = createText({ text: 'DSH12345', color: '#e5484d', x: 50, y: 60, sizeKey: 'medium' });
  assert.equal(drawAnnotation(recorder.ctx, annotation), true);
  const size = TEXT_SIZES.medium;
  const padding = Math.round(size * 0.25);
  assert.equal(recorder.countOf('fill'), 1, 'the background plate is filled');
  assert.deepEqual(recorder.firstOf('fillText'), ['DSH12345', 50 + padding, 60 + padding + size * 0.08]);
  assert.equal(recorder.ctx.font.includes(`${size}px`), true);
  assert.equal(recorder.ctx.textBaseline, 'top');
});

test('an empty text annotation draws nothing', () => {
  const recorder = createRecordingContext();
  assert.equal(drawAnnotation(recorder.ctx, createText({ text: '', color: '#000', x: 0, y: 0 })), false);
});

test('measureTextAnnotation reports the plate the export will draw', () => {
  const recorder = createRecordingContext({ textWidths: { hi: 20 } });
  const annotation = createText({ text: 'hi', color: '#000', x: 0, y: 0, sizeKey: 'large' });
  const size = measureTextAnnotation(recorder.ctx, annotation);
  const padding = Math.round(TEXT_SIZES.large * 0.25);
  assert.deepEqual(size, { width: 20 + padding * 2, height: TEXT_SIZES.large * 1.25 + padding * 2 });
});

test('withTextMetrics stores the measured box at the click point', () => {
  const annotation = createText({ text: 'abc', color: '#000', x: 12, y: 34 });
  const updated = withTextMetrics(annotation, { width: 90, height: 40 });
  assert.deepEqual(updated.rect, { x: 12, y: 34, width: 90, height: 40 });
  assert.equal(updated.text, 'abc');
});

test('translateAnnotation moves shapes, strokes and text alike', () => {
  const rect = translateAnnotation(createShape({ tool: 'rect', color: '#000', rect: { x: 10, y: 10, width: 50, height: 50 } }), 5, -5);
  assert.deepEqual(rect.rect, { x: 15, y: 5, width: 50, height: 50 });
  const arrow = createShape({ tool: 'arrow', color: '#000', from: { x: 0, y: 0 }, to: { x: 10, y: 0 } });
  const movedArrow = translateAnnotation(arrow, 3, 4);
  assert.deepEqual(movedArrow.from, { x: 3, y: 4 });
  assert.deepEqual(movedArrow.to, { x: 13, y: 4 });
  const pen = createStroke({ tool: 'pen', color: '#000', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
  const movedPen = translateAnnotation(pen, 1, 2);
  assert.deepEqual(movedPen.points, [{ x: 1, y: 2 }, { x: 11, y: 12 }]);
  assert.deepEqual(movedPen.rect, { x: 1, y: 2, width: 10, height: 10 });
  const text = translateAnnotation(createText({ text: 'x', color: '#000', x: 5, y: 5 }), -2, -2);
  assert.deepEqual(text, { ...text, x: 3, y: 3, rect: { x: 3, y: 3, width: 0, height: 0 } });
});

test('translateAnnotation with no delta returns the same value', () => {
  const annotation = createShape({ tool: 'rect', color: '#000', rect: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(translateAnnotation(annotation, 0, 0), annotation);
});

test('an unknown tool draws nothing instead of throwing', () => {
  const recorder = createRecordingContext();
  assert.equal(drawAnnotation(recorder.ctx, { tool: 'sparkles', color: '#000' }), false);
});
