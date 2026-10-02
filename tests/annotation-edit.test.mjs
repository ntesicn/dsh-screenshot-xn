/**
 * Editing an already-placed annotation (t22): hit testing, corner scaling,
 * clamped moves and proportional rescaling — all pure value algebra, so it runs
 * offline. The last test re-imports deliberately mutated copies of the module to
 * prove these assertions actually depend on the behaviour they claim to pin.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  annotationHandles,
  annotationRect,
  clampAnnotationRect,
  closestTextSizeKey,
  createShape,
  createStroke,
  createText,
  findAnnotationAt,
  HIT_TOLERANCE,
  hitAnnotation,
  hitAnnotationHandle,
  MIN_ANNOTATION_EDGE,
  MIN_TEXT_PX,
  moveAnnotation,
  resizeAnnotationRect,
  scaleAnnotation,
  textSizeOfAnnotation,
  withTextMetrics,
} from '../lib/annotations.mjs';

const LIB_DIR = new URL('../lib/', import.meta.url);
const COLOR = '#e5484d';

/** One placed annotation of each of the six tools, all inside 0..400 × 0..300. */
function sampleAnnotations() {
  return [
    createShape({ tool: 'rect', color: COLOR, widthKey: 'thin', from: { x: 10, y: 10 }, to: { x: 90, y: 70 } }),
    createShape({ tool: 'ellipse', color: COLOR, widthKey: 'thin', from: { x: 110, y: 10 }, to: { x: 190, y: 70 } }),
    createShape({ tool: 'arrow', color: COLOR, widthKey: 'thin', from: { x: 210, y: 10 }, to: { x: 290, y: 70 } }),
    createStroke({ tool: 'pen', color: COLOR, widthKey: 'thin', points: [{ x: 20, y: 120 }, { x: 60, y: 140 }, { x: 80, y: 180 }] }),
    createShape({ tool: 'mosaic', color: COLOR, widthKey: 'thin', from: { x: 120, y: 120 }, to: { x: 200, y: 180 } }),
    withTextMetrics(createText({ text: 'hi', color: COLOR, x: 240, y: 120, sizeKey: 'medium' }), { width: 80, height: 30 }),
  ];
}

const centerOf = (annotation) => {
  const rect = annotationRect(annotation);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
};

test('every one of the six placed annotation kinds can be hit, and empty space is not', () => {
  const annotations = sampleAnnotations();
  assert.equal(annotations.length, 6);
  annotations.forEach((annotation, index) => {
    assert.equal(findAnnotationAt(annotations, centerOf(annotation)), index, `第 ${index} 类标注应命中`);
  });
  assert.equal(findAnnotationAt(annotations, { x: 600, y: 600 }), -1, '空白处不命中');
});

test('the hit area tolerates at least 4 device pixels outside the bounds', () => {
  const annotation = createShape({ tool: 'mosaic', color: COLOR, widthKey: 'thin', from: { x: 100, y: 100 }, to: { x: 200, y: 160 } });
  const rect = annotationRect(annotation);
  assert.equal(HIT_TOLERANCE >= 4, true, '容忍度常量不得小于 4 px');
  assert.equal(hitAnnotation(annotation, { x: rect.x + rect.width + 3, y: rect.y + 10 }), true, '边界外 3px 仍应命中（画笔/马赛克同理）');
  assert.equal(hitAnnotation(annotation, { x: rect.x + rect.width + 5, y: rect.y + 10 }), false, '边界外 5px 不命中');
  const pen = createStroke({ tool: 'pen', color: COLOR, widthKey: 'thin', points: [{ x: 300, y: 200 }, { x: 360, y: 240 }] });
  const penRect = annotationRect(pen);
  assert.equal(hitAnnotation(pen, { x: penRect.x + penRect.width + 3, y: penRect.y + 5 }), true, '画笔按边界 + 容忍度命中');
});

test('overlapping annotations select the topmost (last drawn) one', () => {
  const bottom = createShape({ tool: 'rect', color: COLOR, widthKey: 'thin', from: { x: 0, y: 0 }, to: { x: 200, y: 200 } });
  const middle = createShape({ tool: 'ellipse', color: COLOR, widthKey: 'thin', from: { x: 20, y: 20 }, to: { x: 180, y: 180 } });
  const top = createShape({ tool: 'arrow', color: COLOR, widthKey: 'thin', from: { x: 40, y: 40 }, to: { x: 160, y: 160 } });
  const list = [bottom, middle, top];
  assert.equal(findAnnotationAt(list, { x: 100, y: 100 }), 2, '重叠处选最上层');
  assert.equal(findAnnotationAt(list, { x: 10, y: 190 }), 0, '只有底层覆盖到的地方选底层');
});

test('a selection box exposes four corner handles and each corner can be grabbed', () => {
  const rect = { x: 100, y: 100, width: 200, height: 120 };
  const handles = annotationHandles(rect);
  assert.deepEqual(handles.map((handle) => handle.id), ['nw', 'ne', 'se', 'sw']);
  assert.deepEqual(handles[0], { id: 'nw', x: 100, y: 100 });
  assert.deepEqual(handles[2], { id: 'se', x: 300, y: 220 });
  for (const handle of handles) {
    assert.equal(hitAnnotationHandle(rect, { x: handle.x, y: handle.y }, 8), handle.id, `${handle.id} 应可抓起`);
  }
  assert.equal(hitAnnotationHandle(rect, { x: 200, y: 100 }, 8), null, '边中点不是角把手');
});

test('dragging a corner scales proportionally and keeps the opposite corner fixed', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  // 拖 se：锚点 nw 不动，比例由指针到锚点的较大相对位移决定（200×100 的框 → 2× 时 400×200）
  const growSe = resizeAnnotationRect(rect, 'se', { x: 500, y: 300 });
  assert.deepEqual(growSe, { x: 100, y: 100, width: 400, height: 200 });
  // 拖 nw：锚点 se 不动
  const growNw = resizeAnnotationRect(rect, 'nw', { x: 0, y: 50 });
  assert.equal(growNw.x + growNw.width, 300, 'se 角保持不动');
  assert.equal(growNw.y + growNw.height, 200, 'se 角保持不动（y）');
  assert.equal(growNw.width / growNw.height, rect.width / rect.height, '等比缩放');
  // 拖 ne / sw 同样等比
  const growNe = resizeAnnotationRect(rect, 'ne', { x: 500, y: 0 });
  assert.equal(growNe.x, 100, 'nw 锚点的 x 不动');
  assert.equal(growNe.y + growNe.height, 200, 'sw 角不动');
  assert.equal(Math.abs(growNe.width / growNe.height - 2), 0, '等比');
  const growSw = resizeAnnotationRect(rect, 'sw', { x: 0, y: 400 });
  assert.equal(growSw.x + growSw.width, 300, 'ne 角不动');
  assert.equal(growSw.y, 100, 'ne 角不动（y）');
});

test('scaling never collapses an annotation below the minimum edge', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  const tiny = resizeAnnotationRect(rect, 'se', { x: 100.5, y: 100.5 });
  assert.equal(tiny.width >= MIN_ANNOTATION_EDGE, true, '宽不得小于最小边长');
  assert.equal(tiny.height >= MIN_ANNOTATION_EDGE, true, '高不得小于最小边长');
  const collapsed = resizeAnnotationRect(rect, 'se', { x: 100, y: 100 });
  assert.equal(collapsed.width >= MIN_ANNOTATION_EDGE, true, '拖到锚点也不能缩成 0');
  assert.equal(collapsed.height >= MIN_ANNOTATION_EDGE, true, '拖到锚点也不能缩成 0');
  // 已经比最小边长还小的框：缩放后仍不小于下限（保住"还能再点中"）
  const small = resizeAnnotationRect({ x: 0, y: 0, width: 4, height: 3 }, 'se', { x: 0.2, y: 0.2 });
  assert.equal(small.width >= MIN_ANNOTATION_EDGE, true);
  assert.equal(small.height >= MIN_ANNOTATION_EDGE, true);
});

test('a moved annotation keeps its size and stays inside the selection bounds', () => {
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  for (const annotation of sampleAnnotations()) {
    const before = annotationRect(annotation);
    const moved = moveAnnotation(annotation, 15, -10, bounds);
    const after = annotationRect(moved);
    assert.equal(Math.round(after.x - before.x), 15, `${annotation.tool} 应整体平移 x`);
    assert.equal(Math.round(after.y - before.y), -10, `${annotation.tool} 应整体平移 y`);
    assert.equal(Math.round(after.width), Math.round(before.width), `${annotation.tool} 尺寸不变`);
    assert.equal(Math.round(after.height), Math.round(before.height), `${annotation.tool} 尺寸不变`);
  }
  const rect = createShape({ tool: 'rect', color: COLOR, widthKey: 'thin', from: { x: 300, y: 220 }, to: { x: 380, y: 280 } });
  const pushed = annotationRect(moveAnnotation(rect, 500, 500, bounds));
  assert.equal(pushed.x + pushed.width <= bounds.width, true, '右边界被夹住');
  assert.equal(pushed.y + pushed.height <= bounds.height, true, '下边界被夹住');
  const pulled = annotationRect(moveAnnotation(rect, -500, -500, bounds));
  assert.equal(pulled.x >= bounds.x, true, '左边界被夹住');
  assert.equal(pulled.y >= bounds.y, true, '上边界被夹住');
  const clamped = clampAnnotationRect({ x: -50, y: -50, width: 100, height: 60 }, bounds);
  assert.deepEqual(clamped, { x: 0, y: 0, width: 100, height: 60 }, '夹取只平移不改尺寸');
});

test('rescaling maps geometry of all six kinds and scales text continuously', () => {
  const [rect, , arrow, pen, mosaic, text] = sampleAnnotations();
  const target = { x: 0, y: 0, width: 160, height: 120 };
  const scaledRect = scaleAnnotation(rect, target);
  assert.deepEqual(annotationRect(scaledRect), target);
  assert.equal(scaledRect.from.x, 0, 'from 跟着缩放');
  const scaledArrow = scaleAnnotation(arrow, target);
  assert.ok(scaledArrow.to.x > scaledArrow.from.x, '箭头方向保持');
  const scaledPen = scaleAnnotation(pen, target);
  assert.equal(scaledPen.points.length, pen.points.length, '画笔点数不变');
  assert.deepEqual(annotationRect(scaledPen), target, '画笔 bounds 跟到新矩形附近');
  const scaledMosaic = scaleAnnotation(mosaic, target);
  assert.deepEqual(annotationRect(scaledMosaic), target, '马赛克 rect 跟着缩放');
  const scaledText = scaleAnnotation(text, { x: 40, y: 50, width: 160, height: 60 });
  assert.equal(scaledText.x, 40);
  assert.equal(scaledText.y, 50);
  assert.equal(textSizeOfAnnotation(scaledText), 64, '两倍框 → 两倍字号');
  assert.equal(scaledText.sizeKey, 'large', '档位同步为最接近的一档');
  const floorText = scaleAnnotation(text, { x: 0, y: 0, width: 8, height: 3 });
  assert.equal(textSizeOfAnnotation(floorText) >= MIN_TEXT_PX, true, '字号不得小于下限');
  assert.equal(closestTextSizeKey(0), 'small');
  assert.equal(closestTextSizeKey(9999), 'large');
});

/** 把 lib/{annotations,geometry}.mjs 复制到临时目录、注入变异后 import（真实执行变异代码）。 */
async function importMutated(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-annot-edit-'));
  const source = readFileSync(new URL('annotations.mjs', LIB_DIR), 'utf8');
  const mutated = mutate(source);
  if (mutated === source) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('mutation did not change the source');
  }
  writeFileSync(join(dir, 'annotations.mjs'), mutated, 'utf8');
  copyFileSync(new URL('geometry.mjs', LIB_DIR), join(dir, 'geometry.mjs'));
  const module = await import(pathToFileURL(join(dir, 'annotations.mjs')).href);
  return { module, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('negative samples: behaviour mutations make the corresponding cases fail', async () => {
  const bottom = createShape({ tool: 'rect', color: COLOR, widthKey: 'thin', from: { x: 0, y: 0 }, to: { x: 200, y: 200 } });
  const top = createShape({ tool: 'rect', color: COLOR, widthKey: 'thin', from: { x: 20, y: 20 }, to: { x: 180, y: 180 } });
  const insideBoth = { x: 100, y: 100 };
  const probe = { x: 100, y: 100, width: 200, height: 100 };

  // 变异 1：命中改为从下往上扫 → "重叠取最上层" 必须失败
  await (async () => {
    const { module, cleanup } = await importMutated((source) => source
      .split('for (let index = annotations.length - 1; index >= 0; index -= 1) {')
      .join('for (let index = 0; index < annotations.length; index += 1) {'));
    try {
      assert.notEqual(module.findAnnotationAt([bottom, top], insideBoth), 1, '变异后不应再返回最上层');
      assert.equal(findAnnotationAt([bottom, top], insideBoth), 1);
    } finally {
      cleanup();
    }
  })();

  // 变异 2：去掉最小边长下限 → "缩不到 0" 必须失败
  await (async () => {
    const { module, cleanup } = await importMutated((source) => source
      .split('const scale = Math.max(wanted, floor);')
      .join('const scale = wanted;'));
    try {
      const collapsed = module.resizeAnnotationRect(probe, 'se', { x: probe.x, y: probe.y });
      assert.equal(collapsed.width < MIN_ANNOTATION_EDGE, true, '变异后应退化到最小边长以下');
      assert.equal(resizeAnnotationRect(probe, 'se', { x: probe.x, y: probe.y }).width >= MIN_ANNOTATION_EDGE, true);
    } finally {
      cleanup();
    }
  })();

  // 变异 3：命中忽略容忍度 → "边界外 4px 内仍命中" 必须失败
  await (async () => {
    const { module, cleanup } = await importMutated((source) => source
      .split('const pad = typeof tolerance === \'number\' && tolerance >= 0 ? tolerance : 0;')
      .join('const pad = 0;'));
    try {
      const rect = module.annotationRect(bottom);
      assert.equal(module.hitAnnotation(bottom, { x: rect.x + rect.width + 3, y: rect.y + 10 }, HIT_TOLERANCE), false, '变异后容忍度失效');
      assert.equal(hitAnnotation(bottom, { x: rect.x + rect.width + 3, y: rect.y + 10 }, HIT_TOLERANCE), true);
    } finally {
      cleanup();
    }
  })();
});
