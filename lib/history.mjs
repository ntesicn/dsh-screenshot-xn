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
export const DEFAULT_HISTORY_LIMIT = 60;

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
export function createHistory(initial = [], limit = DEFAULT_HISTORY_LIMIT) {
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
