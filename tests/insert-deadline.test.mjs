/**
 * t29：输出动作的「不得永久忙态」契约（V-01 的回归防线）。
 *
 * 背景：真机上点「插入对话」后曾出现 191ms 起按钮变「处理中…」、到 5594ms 仍是忙态、
 * 覆盖层不关、**控制台零日志**。日志为零是唯一的强线索：`runOutput` 的第一个日志写在
 * 编码成功之后，而 busy 期间唯一没有上限的 await 就是 `canvas.toBlob` —— 它不回调时
 * 既不会有日志，也不会有可见降级，桥接的超时兜底（INSERT_CONFIRM_MS）永远轮不到。
 *
 * 因此这里钉三条硬契约：
 *   (1) 编码阶段必须有硬上限（`withDeadline` + `ENCODE_DEADLINE_MS`），超时后写可见提示 + warn；
 *   (2) `runOutput` 必须有 `finally` 兜底释放 `state.busy`（任何分支都不得停在忙态）；
 *   (3) 插入失败路径的确认窗口 ≤1500ms 且超时后走「复制到剪贴板 + Ctrl+V」可见降级。
 * 另加 t29 顺带修掉的绘制优先级契约：命中已放置标注的分支只在「移动」工具下生效，
 * 否则绘制工具起笔落在已有标注内会被改判成移动标注（V-04 归因的缺陷）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** @param {string} text @returns {string} 去掉注释后的源码（与 validate A-4 同一套办法）。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const code = stripComments(source);

/**
 * 取出一个函数声明的完整源码（按大括号配对）。
 * @param {string} text @param {string} signature @returns {string|null}
 */
function functionSource(text, signature) {
  const at = text.indexOf(signature);
  if (at === -1) return null;
  const braceAt = text.indexOf(') {', at);
  if (braceAt === -1) return null;
  const braceStart = braceAt + 2;
  let depth = 0;
  for (let index = braceStart; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(at, index + 1);
    }
  }
  return null;
}

const DEADLINE_SIGNATURE = 'function withDeadline(promise, timeoutMs, timers = {';
const RUN_OUTPUT_SIGNATURE = 'async function runOutput(kind) {';
const INSERT_SIGNATURE = 'async function insertIntoConversation(runtime, blob, mediaType = PNG_MIME) {';
const POINTER_DOWN_SIGNATURE = 'function onPointerDown(event) {';

/**
 * 从 client.js 里取出 `withDeadline` 并真实执行（返回函数本体，可注入假定时器）。
 * @param {string} text @returns {Function|null}
 */
function evaluateWithDeadline(text) {
  const body = functionSource(text, DEADLINE_SIGNATURE);
  if (body === null) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn withDeadline;`)();
}

/** 假定时器：只记录，不真的等待。 @returns {object} */
function fakeTimers() {
  const schedule = {
    entries: [],
    set(callback, ms) {
      const entry = { callback, ms, cleared: false };
      schedule.entries.push(entry);
      return entry;
    },
    clear(entry) {
      if (entry !== null && entry !== undefined) entry.cleared = true;
    },
    /** 触发第一个未被取消的定时器。 @returns {boolean} 是否真的触发了。 */
    fireFirst() {
      const entry = schedule.entries.find((item) => item.cleared !== true);
      if (entry === undefined) return false;
      entry.cleared = true;
      entry.callback();
      return true;
    },
  };
  return schedule;
}

/**
 * (1) 编码阶段必须有硬上限，超时后可见降级 + 日志，且任何分支都释放 busy。
 * @param {string} text @returns {{ok: boolean, reason: string}}
 */
function outputCannotStayBusy(text) {
  const body = functionSource(text, RUN_OUTPUT_SIGNATURE);
  if (body === null) return { ok: false, reason: '找不到 runOutput' };
  const startLogAt = body.indexOf("logger.info('output start'");
  if (startLogAt === -1) {
    return { ok: false, reason: '编码前没有起始日志：卡住时与"什么都没发生"同形（V-01 现场零日志）' };
  }
  const deadlineAt = body.indexOf('await withDeadline(');
  if (deadlineAt === -1) {
    return { ok: false, reason: '编码阶段没有硬上限：toBlob 不回调就是永久忙态' };
  }
  if (startLogAt > deadlineAt) return { ok: false, reason: '起始日志必须写在编码 await 之前' };
  if (!body.includes('encodeSelection(frame, selection, cal, state.history.present, state.mosaicStep),')) {
    return { ok: false, reason: 'withDeadline 没有包住 encodeSelection' };
  }
  if (!body.includes('ENCODE_DEADLINE_MS,')) return { ok: false, reason: '没有把编码上限传给 withDeadline' };
  if (!body.includes('if (encodedOutcome.timedOut) {')) return { ok: false, reason: '没有超时分支（超时后没有可见降级）' };
  if (!body.includes('TEXT.encodeTimeout')) return { ok: false, reason: '超时后没有面向用户的提示' };
  if (!/logger\.warn\('encode deadline exceeded'/.test(body)) {
    return { ok: false, reason: '超时后没有 warn 日志（下次现场仍然零信息）' };
  }
  if (!body.includes('} finally {')) return { ok: false, reason: '没有 finally 兜底' };
  if (!/clearTimeout\(slowTimer\);/.test(body)) return { ok: false, reason: 'finally 没有清掉慢编码提示定时器' };
  if (!/if \(state\.busy\) \{\s*state\.busy = false;/.test(body)) {
    return { ok: false, reason: 'finally 没有兜底释放 state.busy（漏一条分支就永久忙态）' };
  }
  return { ok: true, reason: '' };
}

/**
 * (3) 插入失败路径：确认窗口 ≤1500ms，超时后可见降级（复制 + Ctrl+V），且不再有空转。
 * @param {string} text @returns {{ok: boolean, reason: string}}
 */
function insertFailureDegradesVisibly(text) {
  const constant = /const INSERT_CONFIRM_MS = (\d+);/.exec(text);
  if (constant === null) return { ok: false, reason: '找不到 INSERT_CONFIRM_MS' };
  const confirmMs = Number(constant[1]);
  if (!(confirmMs <= 1500)) return { ok: false, reason: `插入确认窗口 ${confirmMs}ms 超过 1500ms 上限` };
  const body = functionSource(text, INSERT_SIGNATURE);
  if (body === null) return { ok: false, reason: '找不到 insertIntoConversation' };
  if (!body.includes('await runtime.waitForAttachmentIncrease(before, INSERT_CONFIRM_MS)')) {
    return { ok: false, reason: '桥接等待没有超时兜底（唯一的等待必须是带窗口的事件驱动等待）' };
  }
  if (/while \(/.test(body)) return { ok: false, reason: '插入流程仍有空转循环' };
  if (!body.includes('copyPngToClipboard(blob')) return { ok: false, reason: '超时后没有"复制到剪贴板"降级' };
  if (!/TEXT\.toastCopiedPaste/.test(body)) return { ok: false, reason: '超时后没有「按 Ctrl+V 粘贴」可见提示' };
  return { ok: true, reason: '' };
}

/**
 * (4) t29 顺带修掉的绘制优先级缺陷：命中已放置标注的分支只在「移动」工具下生效。
 * @param {string} text @returns {{ok: boolean, reason: string}}
 */
function drawingIsNotHijackedByAnnotations(text) {
  const body = functionSource(text, POINTER_DOWN_SIGNATURE);
  if (body === null) return { ok: false, reason: '找不到 onPointerDown' };
  if (/if \(mode === 'create'\) \{\s*const hitIndex = findAnnotationAt\(/.test(body)) {
    return { ok: false, reason: '命中已放置标注的分支无条件生效：绘制工具起笔落在已有标注内会被改判成移动标注' };
  }
  if (!body.includes("if (mode === 'create' && state.tool === TOOL_MOVE) {")) {
    return { ok: false, reason: '命中已放置标注的分支没有以「移动」工具为门槛' };
  }
  if (!body.includes('mode = \'annotate-move\';')) return { ok: false, reason: '命中分支没有移动语义（B-13 移动能力被削）' };
  return { ok: true, reason: '' };
}

// ── 契约断言 ───────────────────────────────────────────────────────────────

test('(t29-1) the encode phase is wrapped in a hard deadline and the idempotent guard releases busy', () => {
  const result = outputCannotStayBusy(code);
  assert.equal(result.ok, true, result.reason);
});

test('(t29-2) the insert confirmation window is bounded and its failure path degrades visibly', () => {
  const result = insertFailureDegradesVisibly(code);
  assert.equal(result.ok, true, result.reason);
});

test('(t29-3) hit-testing a placed annotation only hijacks the gesture under the move tool', () => {
  const result = drawingIsNotHijackedByAnnotations(code);
  assert.equal(result.ok, true, result.reason);
});

test('(t29-4) withDeadline always settles once, with the deadline winning over a never-settling promise', async () => {
  const withDeadline = evaluateWithDeadline(code);
  assert.notEqual(withDeadline, null, '无法从 client.js 切出 withDeadline');

  // 快路径：原 promise 先完成 → 原值透传，且定时器被清掉（不留常驻定时器，D-7）
  const fastTimers = fakeTimers();
  const fast = await withDeadline(Promise.resolve('encoded'), 6000, fastTimers);
  assert.deepEqual(fast, { ok: true, timedOut: false, value: 'encoded' });
  assert.equal(fastTimers.entries.length, 1, '必须为上限挂一个定时器');
  assert.equal(fastTimers.entries[0].cleared, true, '原 promise 完成后必须清掉定时器');

  // 卡死路径：永远 pending 的 promise + 上限到点 → 必须 settle 成 timedOut（而不是永远挂着）
  const stuckTimers = fakeTimers();
  let settled = null;
  const pending = withDeadline(new Promise(() => {}), 6000, stuckTimers).then((outcome) => {
    settled = outcome;
    return outcome;
  });
  await Promise.resolve();
  assert.equal(settled, null, '上限未到之前不得 settle');
  assert.equal(stuckTimers.entries[0].ms, 6000, '上限必须是传入的毫秒数');
  assert.equal(stuckTimers.fireFirst(), true, '必须真的挂了定时器');
  assert.deepEqual(await pending, { ok: false, timedOut: true });

  // 抛错路径：错误被包进 outcome（调用方决定可见提示），不产生未处理拒绝
  const errorTimers = fakeTimers();
  const failed = await withDeadline(Promise.reject(new Error('boom')), 6000, errorTimers);
  assert.equal(failed.ok, false);
  assert.equal(failed.timedOut, false);
  assert.equal(String(failed.error.message), 'boom');
  assert.equal(errorTimers.entries[0].cleared, true, '抛错后也必须清掉定时器');

  // 晚到的结果被丢弃：只 settle 一次（toBlob 无法取消，晚到的回调不得再改状态）
  const lateTimers = fakeTimers();
  let releaseLate = null;
  const latePromise = new Promise((resolve) => {
    releaseLate = resolve;
  });
  const raced = withDeadline(latePromise, 6000, lateTimers);
  lateTimers.fireFirst();
  assert.deepEqual(await raced, { ok: false, timedOut: true });
  releaseLate('too-late');
  assert.deepEqual(await raced, { ok: false, timedOut: true }, '超时后原 promise 的结果必须被丢弃');
});

test('(t29-6) the default timers survive being detached from the host object (browser Illegal invocation)', async () => {
  const body = functionSource(code, DEADLINE_SIGNATURE);
  assert.notEqual(body, null, '无法从 client.js 切出 withDeadline');
  // 真机复现过：`{ set: setTimeout, clear: clearTimeout }` 把宿主函数摘下来当方法调用，
  // 浏览器按 this=timers 调 window.setTimeout → 抛 `Illegal invocation`，整条插入路径被
  // catch 成「输出失败」（Node 不复现，所以这里用一个"this 不对就抛"的宿主模拟同一约束）。
  const host = {
    setTimeout(callback, ms) {
      if (this !== host) throw new TypeError('Illegal invocation');
      return globalThis.setTimeout(callback, ms);
    },
    clearTimeout(handle) {
      if (this !== host) throw new TypeError('Illegal invocation');
      return globalThis.clearTimeout(handle);
    },
  };
  const globalSetTimeout = function (callback, ms) {
    // 浏览器里 setTimeout 以「裸函数」形式调用（this=undefined，非严格模式回落到 window）是对的，
    // 被挂到别的对象上再当方法调用（this=那个对象）才是 Illegal invocation。
    if (this !== undefined) throw new TypeError('Illegal invocation');
    return host.setTimeout.call(host, callback, ms);
  };
  const globalClearTimeout = function (handle) {
    if (this !== undefined) throw new TypeError('Illegal invocation');
    return host.clearTimeout.call(host, handle);
  };
  const evaluate = (text) => new Function('setTimeout', 'clearTimeout', `${text}\nreturn withDeadline;`)(globalSetTimeout, globalClearTimeout);

  const withDeadline = evaluate(body);
  assert.deepEqual(await withDeadline(Promise.resolve('ok'), 1000), { ok: true, timedOut: false, value: 'ok' });

  // 负样本：把默认定时器改回"摘下来的宿主函数" → 必须像真机那样炸（这条负样本就是那次真机缺陷）
  const detached = body
    .replace(`timers = {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle),
    }`, 'timers = { set: setTimeout, clear: clearTimeout }');
  assert.notEqual(detached, body, '默认定时器的箭头包装不存在，负样本无从构造');
  await assert.rejects(evaluate(detached)(Promise.resolve('ok'), 1000), /Illegal invocation/);
});

// ── 负样本：把上面的断言逐一打破，证明它们真的敏感 ──────────────────────────
test('(t29-5) negative samples: dropping the deadline / finally / window bound fails (t29-1..3)', () => {
  // 负样本 1：把编码的硬上限还原成裸 await → (t29-1) 必须失败
  const plainAwait = code.replace(
    `const encodedOutcome = await withDeadline(
            encodeSelection(frame, selection, cal, state.history.present, state.mosaicStep),
            ENCODE_DEADLINE_MS,
          );`,
    'const encoded = await encodeSelection(frame, selection, cal, state.history.present, state.mosaicStep);',
  );
  assert.notEqual(plainAwait, code, '编码硬上限的字面量签名不存在，负样本无从构造');
  assert.equal(outputCannotStayBusy(plainAwait).ok, false, '去掉编码上限后仍通过 = 这条契约是假绿');

  // 负样本 2：删掉 finally 里的 busy 兜底释放 → (t29-1) 必须失败
  const noFinally = code.replace(
    /} finally \{\s*clearTimeout\(slowTimer\);[\s\S]*?\n        \}\n/,
    '}\n',
  );
  assert.notEqual(noFinally, code, 'finally 兜底不存在，负样本无从构造');
  assert.equal(outputCannotStayBusy(noFinally).ok, false, '去掉 finally 兜底后仍通过 = 这条契约是假绿');

  // 负样本 3：把插入确认窗口放大到 5s（旧实现的量级）→ (t29-2) 必须失败
  const slowWindow = code.replace('const INSERT_CONFIRM_MS = 1200;', 'const INSERT_CONFIRM_MS = 5000;');
  assert.notEqual(slowWindow, code, 'INSERT_CONFIRM_MS 字面量不存在，负样本无从构造');
  assert.equal(insertFailureDegradesVisibly(slowWindow).ok, false, '窗口放大到 5s 后仍通过 = 1500ms 契约无效');

  // 负样本 4：桥接等待退回空转 → (t29-2) 必须失败
  const spin = code.replace(
    'await runtime.waitForAttachmentIncrease(before, INSERT_CONFIRM_MS)',
    'while (nowMs() < nowMs() + INSERT_CONFIRM_MS) { await delay(120); }',
  );
  assert.notEqual(spin, code, '桥接等待字面量不存在，负样本无从构造');
  assert.equal(insertFailureDegradesVisibly(spin).ok, false, '退回空转后仍通过 = 这条契约是假绿');

  // 负样本 5：取掉「移动工具」门槛 → (t29-3) 必须失败（V-04 的缺陷形态）
  const hijack = code.replace(
    "if (mode === 'create' && state.tool === TOOL_MOVE) {",
    "if (mode === 'create') {",
  );
  assert.notEqual(hijack, code, '「移动工具」门槛不存在，负样本无从构造');
  assert.equal(drawingIsNotHijackedByAnnotations(hijack).ok, false, '取掉门槛后仍通过 = 绘制拦截缺陷会复发');
});
