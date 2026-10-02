/** Undo / redo history (PRD F-17, F-19, DoD B-7). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistory, DEFAULT_HISTORY_LIMIT } from '../lib/history.mjs';

test('a fresh history can neither undo nor redo', () => {
  const history = createHistory();
  assert.deepEqual(history.present, []);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  assert.equal(history.undo(), false);
  assert.equal(history.redo(), false);
});

test('undo walks the edits backwards in order, then redo restores them (B-7)', () => {
  const history = createHistory();
  const rect = { tool: 'rect' };
  const arrow = { tool: 'arrow' };
  const text = { tool: 'text' };
  history.push([rect]);
  history.push([rect, arrow]);
  history.push([rect, arrow, text]);

  assert.deepEqual(history.present, [rect, arrow, text]);
  history.undo();
  assert.deepEqual(history.present, [rect, arrow], 'undo removes the text first');
  history.undo();
  assert.deepEqual(history.present, [rect], 'then the arrow');
  history.undo();
  assert.deepEqual(history.present, [], 'then the rectangle');
  assert.equal(history.canUndo(), false, 'the original image is not a history entry');

  assert.equal(history.redo(), true);
  assert.deepEqual(history.present, [rect], 'redo restores the rectangle first');
  assert.equal(history.redo(), true);
  assert.deepEqual(history.present, [rect, arrow], 'then the arrow');
  // DoD B-7 stops here ("再按 Ctrl+Y 两次 … 文字仍保持撤销状态"), and after two
  // redos the text is indeed still undone. Reversing the three undos takes three
  // redos, though, so the redo branch must still hold the text: a history that
  // forgot it would also fail B-7's own criterion 重做无法恢复 on the shortest
  // sequence (Ctrl+Z once, Ctrl+Y once — see the single-edit test below).
  assert.equal(history.canRedo(), true, 'the redo branch still holds the undone text');
  assert.equal(history.redo(), true);
  assert.deepEqual(history.present, [rect, arrow, text], 'the third redo reverses the last undo');
  assert.equal(history.canRedo(), false, 'and then the branch is exhausted');
});

test('the shortest sequence survives: one edit, one undo, one redo (B-7)', () => {
  const history = createHistory();
  const rect = { tool: 'rect' };
  history.push([rect]);
  assert.equal(history.undo(), true);
  assert.deepEqual(history.present, [], 'the edit is undone');
  assert.equal(history.canUndo(), false);
  assert.equal(history.redo(), true);
  assert.deepEqual(history.present, [rect], 'and redo restores it: the branch is never silently dropped');
  assert.equal(history.canRedo(), false);
});

test('a new edit discards the redo branch', () => {
  const history = createHistory();
  history.push(['a']);
  history.push(['a', 'b']);
  history.undo();
  history.push(['a', 'c']);
  assert.equal(history.canRedo(), false);
  assert.deepEqual(history.present, ['a', 'c']);
});

test('push never mutates the caller array or a previous present', () => {
  const history = createHistory();
  const first = ['a'];
  history.push(first);
  const second = ['a', 'b'];
  history.push(second);
  first.push('mutated-after-push');
  second.length = 0;
  assert.deepEqual(history.present, ['a', 'b'], 'the history owns its snapshots');
  history.undo();
  assert.deepEqual(history.present, ['a']);
});

test('the depth cap drops the oldest step, never the newest', () => {
  const history = createHistory([], 3);
  for (let index = 1; index <= 5; index += 1) history.push([index]);
  assert.deepEqual(history.depth(), { past: 3, future: 0 });
  history.undo();
  history.undo();
  history.undo();
  assert.deepEqual(history.present, [2], 'only the three newest steps are reachable');
  assert.equal(history.canUndo(), false);
});

test('reset clears both directions', () => {
  const history = createHistory();
  history.push(['a']);
  history.push(['a', 'b']);
  history.undo();
  history.reset();
  assert.deepEqual(history.present, []);
  assert.deepEqual(history.depth(), { past: 0, future: 0 });
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
});

test('reset accepts a starting list', () => {
  const history = createHistory();
  history.reset(['restored']);
  assert.deepEqual(history.present, ['restored']);
  assert.equal(history.canUndo(), false);
});

test('the default limit is a positive integer', () => {
  assert.equal(DEFAULT_HISTORY_LIMIT > 0, true);
  assert.throws(() => createHistory([], 0), RangeError);
  assert.throws(() => createHistory([], 1.5), RangeError);
});
