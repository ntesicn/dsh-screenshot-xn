/**
 * t59：B1 客户端编排的离线契约 —— 「启动独立全屏面板 → 轮询 → 取图 → 在 DSH 内执行动作」。
 *
 * 背景：用户 2026-09-30 拍板 B1（真·微信式全屏截图面板）。宿主路由（t56）与面板页面（t57）
 * 已交付；本文件钉住 DSH 侧那一半：
 *   1. 纯判定：会话状态/动作解析的防御性、终态集合与轮询参数（可切出来真跑）；
 *   2. 轮询：四条终态都停、瞬时失败可容忍、连续失败与总时长都有上限、卸载即退（真跑，假 fetch/假时钟）；
 *   3. 入口 `startShot`：成功 → 轮询 → 取图 → **动作在 DSH 内执行**；取消/异常/失去联系/取图失败各有可见反馈；
 *      `no-browser`（或路由不存在 / start 失败）→ 可见提示 + 回退既有 DSH 内覆盖层流程；
 *   4. 源码契约：路由字面量、轮询节奏、上限常量、"面板只交回 PNG、动作永远在 DSH 里做"。
 * 末尾给负样本：把任一条打回原形，对应断言必须失败（含真实行为差异，不只是字符串）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** @param {string} text @returns {string} */
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
  let depth = 0;
  for (let index = braceAt + 2; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(at, index + 1);
    }
  }
  return null;
}

/** @param {string} text @param {string} name @returns {string|null} 单行 const 声明。 */
function constLine(text, name) {
  const at = text.indexOf(`const ${name} = `);
  if (at === -1) return null;
  const end = text.indexOf(';\n', at);
  return end === -1 ? null : text.slice(at, end + 1);
}

/** 从 client.js 切出 TEXT 字面量并求值。 @param {string} text @returns {object|null} */
function readTextTable(text) {
  const at = text.indexOf('const TEXT = Object.freeze({');
  if (at === -1) return null;
  const braceAt = text.indexOf('{', at);
  let depth = 0;
  for (let index = braceAt; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(`return ${text.slice(braceAt, index + 1)};`)();
      }
    }
  }
  return null;
}

const SLICE_CONSTS = [
  'CAPTURE_MODE_THROUGH',
  'CAPTURE_MODE_NORMAL',
  'CAPTURE_STATE_PATH',
  'OVERLAY_START_PATH',
  'OVERLAY_STATUS_PATH',
  'OVERLAY_RESULT_PNG_PATH',
  'OVERLAY_POLL_MS',
  'OVERLAY_POLL_DEADLINE_MS',
  'OVERLAY_POLL_FAILURE_LIMIT',
  'OVERLAY_TERMINAL_STATES',
  'OVERLAY_ACTIONS',
];

const SLICE_FUNCTIONS = [
  'function normalizeCaptureMode(value) {',
  'async function loadCaptureMode(runtime, fetchImpl = fetch) {',
  'function overlayStateOf(body) {',
  'function overlayActionOf(body) {',
  'function isOverlayTerminal(state) {',
  'function overlayQuery(token) {',
  'function overlayFallbackNotice(reason) {',
  'function overlayProblemNotice(state) {',
  'async function readJsonBody(response) {',
  'async function startOverlaySession(mode = CAPTURE_MODE_THROUGH, fetchImpl = fetch) {',
  'async function pollOverlaySession(token, deps) {',
  'async function fetchOverlayResult(token, fetchImpl = fetch) {',
  'async function deliverOverlayResult(action, blob, runtime, deps = {}) {',
  'async function startShot(runtime, deps = {}) {',
];

/**
 * 把 B1 编排从 client.js 切出来真实执行：外部世界（DSH 侧动作、焦点、日志、时钟）用替身，
 * 只保留被测的真实逻辑。`dshCalls` / `startCaptureCalls` 让"动作到底在哪一侧执行"可断言。
 * @param {string} text @returns {object|null}
 */
function buildApi(text) {
  const consts = SLICE_CONSTS.map((name) => constLine(text, name));
  if (consts.some((line) => line === null)) return null;
  const functions = SLICE_FUNCTIONS.map((signature) => functionSource(text, signature));
  if (functions.some((fn) => fn === null)) return null;
  const textTable = readTextTable(text);
  if (textTable === null) return null;
  const body = `
    ${consts.join('\n')}
    const TEXT = ${JSON.stringify(textTable)};
    const PNG_MIME = 'image/png';
    const nowMs = () => Date.now();
    const logger = { info() {}, warn() {} };
    const errorText = (error) => (error instanceof Error ? error.message : String(error));
    const dshCalls = [];
    const startCaptureCalls = [];
    const focusCalls = [];
    const insertIntoConversation = async (runtime, blob, mediaType) => {
      dshCalls.push({ action: 'insert', size: blob.size, mediaType });
      return { ok: true, method: 'paste', kind: 'success', text: 'inserted' };
    };
    const copyPngToClipboard = async (blob, platform, mediaType) => {
      dshCalls.push({ action: 'copy', size: blob.size, mediaType });
      return { ok: true };
    };
    const savePngAs = async (blob, platform, mediaType) => {
      dshCalls.push({ action: 'save', size: blob.size, mediaType });
      return { ok: true, method: 'picker', fileName: 'DSH截图_20260101_000000.png' };
    };
    const startCapture = async (runtime, through = true) => {
      startCaptureCalls.push({ through });
    };
    const focusComposer = () => { focusCalls.push(true); };
    ${functions.join('\n')}
    return {
      startShot, pollOverlaySession, deliverOverlayResult, startOverlaySession, fetchOverlayResult,
      overlayStateOf, overlayActionOf, isOverlayTerminal, overlayQuery,
      overlayFallbackNotice, overlayProblemNotice, readJsonBody,
      OVERLAY_POLL_MS, OVERLAY_POLL_DEADLINE_MS, OVERLAY_POLL_FAILURE_LIMIT, OVERLAY_ACTIONS, OVERLAY_TERMINAL_STATES,
      dshCalls, startCaptureCalls, focusCalls,
    };
  `;
  // eslint-disable-next-line no-new-func
  return new Function('URLSearchParams', body)(URLSearchParams);
}

/** @returns {object} 一个够用的 store 替身（真实 store 的四个入口）。 */
function fakeRuntime() {
  const state = { phase: 'idle', busy: false, notice: null, attachmentCount: 3 };
  const toasts = [];
  return {
    state,
    toasts,
    notify() {},
    setToast(kind, text) {
      toasts.push({ kind, text });
    },
    async sleep() {
      return true;
    },
  };
}

/** @param {object} body @returns {object} 一个 JSON 响应替身。 */
const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/** @returns {object} 一个 PNG 响应替身。 */
const pngResponse = (size) => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new Error('not json');
  },
  blob: async () => ({ size }),
});

const failure = (status = 500) => ({
  ok: false,
  status,
  json: async () => {
    throw new Error('no body');
  },
});

// ── 1. 纯判定 ──────────────────────────────────────────────────────────────

test('(t59-1) session parsing is defensive, the terminal set is frozen and the poll cadence stays snappy', () => {
  const api = buildApi(code);
  assert.notEqual(api, null, '无法从 client.js 切出 B1 编排');

  assert.equal(api.overlayStateOf({ state: 'running' }), 'running');
  assert.equal(api.overlayStateOf({ state: '' }), 'unknown');
  assert.equal(api.overlayStateOf({ state: 42 }), 'unknown');
  assert.equal(api.overlayStateOf(null), 'unknown');
  assert.equal(api.overlayStateOf('running'), 'unknown');

  for (const state of ['ready', 'cancelled', 'aborted', 'timeout']) {
    assert.equal(api.isOverlayTerminal(state), true, `${state} 必须是终态（到了就停止轮询）`);
  }
  assert.equal(api.isOverlayTerminal('running'), false);
  assert.equal(api.isOverlayTerminal('unknown'), false);
  assert.deepEqual([...api.OVERLAY_TERMINAL_STATES], ['ready', 'cancelled', 'aborted', 'timeout']);
  assert.deepEqual([...api.OVERLAY_ACTIONS], ['insert', 'copy', 'save'], '动作集合必须与宿主逐字一致');

  assert.equal(api.overlayActionOf({ action: 'insert' }), 'insert');
  assert.equal(api.overlayActionOf({ action: 'copy' }), 'copy');
  assert.equal(api.overlayActionOf({ action: 'save' }), 'save');
  assert.equal(api.overlayActionOf({ action: 'delete' }), null, '冻结集合之外的动作一律 null');
  assert.equal(api.overlayActionOf(null), null);

  assert.equal(api.overlayQuery('a b'), '?token=a%20b');
  assert.equal(api.OVERLAY_POLL_MS <= 400, true, `轮询间隔 ${api.OVERLAY_POLL_MS} ms 太慢（状态会显得卡住）`);
  assert.equal(api.OVERLAY_POLL_DEADLINE_MS >= 120_000, true, '轮询总上限必须覆盖宿主 120 s 的会话上限');
  assert.equal(api.OVERLAY_POLL_FAILURE_LIMIT >= 2, true, '连续失败上限太小会误判瞬时抖动');
});

test('(t59-2) the poll stops at every terminal state, tolerates transient failures and respects its own ceilings', async () => {
  const api = buildApi(code);
  assert.notEqual(api, null, '无法从 client.js 切出 B1 编排');

  // (a) running ×2 → ready：只在非终态之间等待，且间隔就是 OVERLAY_POLL_MS。
  const statuses = ['running', 'running', 'ready'];
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    assert.match(url, /\/api\/dsh-screenshot\/overlay\/status\?token=tok/, '状态请求必须带 token');
    calls += 1;
    return jsonResponse({ ok: true, state: statuses[Math.min(calls - 1, statuses.length - 1)], action: 'copy' });
  };
  const ready = await api.pollOverlaySession('tok', {
    fetch: fetchImpl,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      return true;
    },
  });
  assert.deepEqual(ready, { state: 'ready', action: 'copy', polls: 3, elapsedMs: 0, unmounted: false });
  assert.deepEqual(sleeps, [api.OVERLAY_POLL_MS, api.OVERLAY_POLL_MS], '非终态才等待，且节奏固定');

  // (b) 取消 / 异常 / 超时三条终态都立刻停（不继续轮询）。
  for (const state of ['cancelled', 'aborted', 'timeout']) {
    let seen = 0;
    const outcome = await api.pollOverlaySession('tok', {
      fetch: async () => {
        seen += 1;
        return jsonResponse({ ok: true, state, action: null });
      },
      now: () => 0,
      sleep: async () => true,
    });
    assert.equal(outcome.state, state);
    assert.equal(seen, 1, `${state} 是终态，不该再轮询`);
    assert.equal(outcome.action, null);
  }

  // (c) 瞬时失败（HTTP 500 / 抛错）不算终态：恢复后仍能拿到 ready。
  let attempt = 0;
  const flaky = await api.pollOverlaySession('tok', {
    fetch: async () => {
      attempt += 1;
      if (attempt === 1) return failure(500);
      if (attempt === 2) throw new Error('network down');
      return jsonResponse({ ok: true, state: 'ready', action: 'insert' });
    },
    now: () => 0,
    sleep: async () => true,
  });
  assert.equal(flaky.state, 'ready', '瞬时失败被容忍');
  assert.equal(flaky.polls, 3);

  // (d) 连续失败到达上限 → unreachable（宿主没了就别再转圈）。
  let failures = 0;
  const unreachable = await api.pollOverlaySession('tok', {
    fetch: async () => {
      failures += 1;
      return failure(404);
    },
    now: () => 0,
    sleep: async () => true,
  });
  assert.equal(unreachable.state, 'unreachable');
  assert.equal(failures, api.OVERLAY_POLL_FAILURE_LIMIT, '连续失败上限必须真的生效');

  // (e) 总时长上限由本半自己收口（不依赖宿主）：时钟一直前进 + 状态永远 running。
  //     注意这条同时证明"deadline 检查是承重的"——见 (t59-6) 的负样本。
  let clock = 0;
  const timedOut = await api.pollOverlaySession('tok', {
    fetch: async () => jsonResponse({ ok: true, state: 'running', action: null }),
    now: () => {
      clock += 30_000;
      return clock;
    },
    sleep: async () => true,
  });
  assert.equal(timedOut.state, 'timeout');
  assert.equal(timedOut.unmounted, false);

  // (f) 组件卸载（sleep 返回 false）→ 立刻退出且标记 unmounted，调用方什么都不做。
  const unmounted = await api.pollOverlaySession('tok', {
    fetch: async () => jsonResponse({ ok: true, state: 'running', action: null }),
    now: () => 0,
    sleep: async () => false,
  });
  assert.equal(unmounted.state, 'unmounted');
  assert.equal(unmounted.unmounted, true);
  assert.equal(unmounted.polls, 1);
});

// ── 2. 入口编排 ────────────────────────────────────────────────────────────

test('(t59-3) startShot: the happy path polls, fetches the overlay PNG and runs the action in DSH', async () => {
  const api = buildApi(code);
  assert.notEqual(api, null, '无法从 client.js 切出 B1 编排');
  const runtime = fakeRuntime();
  const order = [];
  await api.startShot(runtime, {
    startSession: async () => {
      order.push('start');
      return { ok: true, token: 'tok' };
    },
    poll: async (token) => {
      order.push(`poll:${token}`);
      return { state: 'ready', action: 'insert', polls: 4, elapsedMs: 900, unmounted: false };
    },
    fetchResult: async (token) => {
      order.push(`result:${token}`);
      return { size: 4096 };
    },
  });

  assert.deepEqual(order, ['start', 'poll:tok', 'result:tok'], '顺序必须是 启动 → 轮询 → 取图');
  // 动作在 DSH 侧执行（真实实现 = paste 桥接），媒体类型是 image/png（面板交回的就是 PNG）。
  assert.deepEqual(api.dshCalls, [{ action: 'insert', size: 4096, mediaType: 'image/png' }]);
  assert.deepEqual(api.startCaptureCalls, [], '面板可用时不该再进 DSH 内覆盖层流程');
  assert.deepEqual(api.focusCalls, [true], '收尾焦点回输入框');
  assert.equal(runtime.state.phase, 'idle', '忙态必须收口');
  assert.deepEqual(runtime.toasts.map((toast) => toast.kind), ['info', 'success'], '打开提示 + 成功提示');
  assert.match(runtime.toasts[0].text, /正在打开截图面板/, '开始阶段就应有可见状态（不是静默等待）');
});

test('(t59-4) startShot: cancel, abnormal endings, an unreachable host and a missing result are all visible', async () => {
  const api = buildApi(code);
  assert.notEqual(api, null, '无法从 client.js 切出 B1 编排');
  const run = async (outcome, extra = {}) => {
    const runtime = fakeRuntime();
    await api.startShot(runtime, {
      startSession: async () => ({ ok: true, token: 'tok' }),
      poll: async () => outcome,
      fetchResult: async () => ({ size: 2048 }),
      ...extra,
    });
    return runtime;
  };

  // (a) 取消：无副作用（不动剪贴板、不产图、不插入），只给一条中性提示。
  const cancelled = await run({ state: 'cancelled', action: null, polls: 2, elapsedMs: 300, unmounted: false });
  assert.deepEqual(api.dshCalls, [], '取消不该执行任何动作');
  assert.equal(cancelled.state.phase, 'idle');
  assert.deepEqual(cancelled.toasts.map((toast) => toast.kind), ['info', 'info']);
  assert.match(cancelled.toasts[1].text, /已取消截图/);

  // (b) 异常终态：可见报错，绝不静默。
  for (const [state, pattern] of [['aborted', /未返回结果/], ['timeout', /超时/], ['unreachable', /失去联系/]]) {
    const runtime = await run({ state, action: null, polls: 3, elapsedMs: 800, unmounted: false });
    const last = runtime.toasts[runtime.toasts.length - 1];
    assert.equal(last.kind, 'error', `${state} 必须是可见错误提示`);
    assert.match(last.text, pattern);
    assert.equal(runtime.state.phase, 'idle');
  }
  assert.deepEqual(api.dshCalls, [], '异常终态不该执行动作');

  // (c) ready 但取图失败：可见报错。
  const missing = await run(
    { state: 'ready', action: 'copy', polls: 2, elapsedMs: 200, unmounted: false },
    { fetchResult: async () => null },
  );
  assert.match(missing.toasts[missing.toasts.length - 1].text, /取回截图结果失败/);
  assert.deepEqual(api.dshCalls, [], '拿不到字节就不能执行动作');

  // (d) 组件已卸载：什么都不做（连提示都不该有 —— 页面已经不在了）。
  const gone = await run({ state: 'unmounted', action: null, polls: 1, elapsedMs: 100, unmounted: true });
  assert.deepEqual(gone.toasts.map((toast) => toast.kind), ['info']);
  assert.equal(gone.state.phase, 'idle');

  // (e) 未预料的异常：可见反馈 + 忙态必须释放（否则就是"永久转圈"）。
  const broken = fakeRuntime();
  await api.startShot(broken, {
    startSession: async () => ({ ok: true, token: 'tok' }),
    poll: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(broken.state.phase, 'idle', '异常路径也必须释放忙态');
  assert.equal(broken.toasts[broken.toasts.length - 1].kind, 'error');
  assert.match(broken.toasts[broken.toasts.length - 1].text, /boom/);
});

test('(t59-5) startShot: an unavailable panel is visible and falls back to the in-DSH flow', async () => {
  const api = buildApi(code);
  assert.notEqual(api, null, '无法从 client.js 切出 B1 编排');

  // (a) 没有可用浏览器：专用措辞 + 回退（功能不缺失）。
  const noBrowser = fakeRuntime();
  await api.startShot(noBrowser, {
    startSession: async () => ({ ok: false, reason: 'no-browser' }),
    poll: async () => {
      throw new Error('不该轮询');
    },
  });
  assert.deepEqual(api.startCaptureCalls, [{ through: true }], '必须回退到 DSH 内覆盖层流程');
  assert.equal(noBrowser.state.phase, 'idle', '回退前必须先放开忙态（否则 startCapture 会被自己挡掉）');
  assert.equal(noBrowser.toasts[0].kind, 'warn');
  assert.match(noBrowser.toasts[0].text, /未找到可用的浏览器/);

  // (b) 宿主未加载该路由 / start 失败：通用措辞 + 原因 + 同样回退。
  api.startCaptureCalls.length = 0;
  const failed = fakeRuntime();
  await api.startShot(failed, {
    startSession: async () => ({ ok: false, reason: 'overlay.start http 404' }),
    poll: async () => {
      throw new Error('不该轮询');
    },
  });
  assert.deepEqual(api.startCaptureCalls, [{ through: true }]);
  assert.match(failed.toasts[0].text, /独立截图面板不可用/);
  assert.match(failed.toasts[0].text, /404/, '把原因带上，用户/日志才知道为什么回退');

  // (c) 备用浏览器路由存在但 start 抛错（网络层）：同样回退而不是卡住。
  api.startCaptureCalls.length = 0;
  const thrown = fakeRuntime();
  await api.startShot(thrown, {
    startSession: async () => ({ ok: false, reason: 'overlay.start TypeError: fetch failed' }),
    poll: async () => {
      throw new Error('不该轮询');
    },
  });
  assert.deepEqual(api.startCaptureCalls, [{ through: true }]);
  assert.equal(thrown.state.phase, 'idle');
});

test('(t59-6) deliverOverlayResult: the three actions run in DSH with the PNG media type, and cancel is not an error', async () => {
  const api = buildApi(code);
  assert.notEqual(api, null, '无法从 client.js 切出 B1 编排');
  const blob = { size: 8192 };

  const inserted = await api.deliverOverlayResult('insert', blob, fakeRuntime());
  assert.equal(inserted.ok, true);
  assert.equal(inserted.kind, 'success');
  const copied = await api.deliverOverlayResult('copy', blob, fakeRuntime());
  assert.equal(copied.ok, true);
  assert.equal(copied.method, 'clipboard');
  const saved = await api.deliverOverlayResult('save', blob, fakeRuntime());
  assert.equal(saved.ok, true);
  assert.equal(saved.method, 'picker');
  assert.deepEqual(api.dshCalls, [
    { action: 'insert', size: 8192, mediaType: 'image/png' },
    { action: 'copy', size: 8192, mediaType: 'image/png' },
    { action: 'save', size: 8192, mediaType: 'image/png' },
  ], '三条动作都必须交给 DSH 侧实现（面板自己不碰剪贴板、不写文件）');

  // 失败与"用户取消系统对话框"的区分：后者不报错。
  const copyFailed = await api.deliverOverlayResult('copy', blob, fakeRuntime(), {
    copy: async () => ({ ok: false, reason: 'clipboard.unavailable' }),
  });
  assert.equal(copyFailed.kind, 'error');
  assert.match(copyFailed.text, /复制失败/);
  const saveCancel = await api.deliverOverlayResult('save', blob, fakeRuntime(), {
    save: async () => ({ ok: false, method: 'picker', reason: 'save.cancelled' }),
  });
  assert.equal(saveCancel.text, '', '用户取消保存不是错误，不弹错误提示');
  const insertFailed = await api.deliverOverlayResult('insert', blob, fakeRuntime(), {
    insert: async () => ({ ok: false, method: 'clipboard', kind: 'warn', text: 'fallback' }),
  });
  assert.equal(insertFailed.ok, false);
  assert.equal(insertFailed.text, 'fallback', '插入的降级文案由 DSH 侧决定，原样透传');
});

// ── 3. 源码契约 ────────────────────────────────────────────────────────────

test('(t59-7) source contract: frozen route literals, single entry, and the actions stay on the DSH side', () => {
  for (const literal of [
    "const OVERLAY_START_PATH = '/api/dsh-screenshot/overlay/start';",
    "const OVERLAY_STATUS_PATH = '/api/dsh-screenshot/overlay/status';",
    "const OVERLAY_RESULT_PNG_PATH = '/api/dsh-screenshot/overlay/result.png';",
    "const OVERLAY_ACTIONS = Object.freeze(['insert', 'copy', 'save']);",
  ]) {
    assert.equal(code.includes(literal), true, `宿主的冻结字面量缺失: ${literal}`);
  }
  assert.match(code, /fetchImpl\(`\$\{OVERLAY_START_PATH\}\?\$\{query\.toString\(\)\}`, \{\s*\n\s*method: 'POST'/, '会话必须用 POST 启动');
  // t67：模式写在查询串上（宿主 `overlayParam(url, 'mode')`），默认穿透。
  assert.match(code, /query\.set\('mode', normalizeCaptureMode\(mode\)\)/, '启动请求必须带上抓屏模式');
  assert.match(code, /credentials: 'same-origin'/, '同源请求要带凭证（宿主路由在 DSH 自己的 webServer 上）');

  // 忙态：进入即置 'capturing'，四条出口都放回 'idle'（不存在永久转圈）。
  const shot = functionSource(code, 'async function startShot(runtime, deps = {}) {');
  assert.notEqual(shot, null, '找不到 startShot');
  assert.match(shot, /state\.phase = 'capturing';/);
  // 进入时置忙；三处释放：回退出口、轮询之后的出口（取消/异常/成功共用）、finally 兜底。
  assert.equal(shot.split("state.phase = 'idle';").length - 1, 3, '回退出口、轮询出口与兜底都必须释放忙态');
  assert.match(shot, /\} finally \{/, '缺少 finally 兜底（未预料的异常会把界面留在忙态）');
  assert.match(shot, /await capture\(runtime, through\);/, '面板不可用必须回退 DSH 内流程（并把模式一起带上）');
  assert.match(shot, /overlayFallbackNotice\(reason\)/, '回退必须有可见提示');

  // 动作永远在 DSH 里做：面板只交回 PNG，本半再驱动既有三条输出路径。
  const deliver = functionSource(code, 'async function deliverOverlayResult(action, blob, runtime, deps = {}) {');
  assert.notEqual(deliver, null, '找不到 deliverOverlayResult');
  for (const call of ['insertIntoConversation(runtime, value, PNG_MIME)', 'copyPngToClipboard(value, {}, PNG_MIME)', 'savePngAs(value, {}, PNG_MIME)']) {
    assert.equal(deliver.includes(call), true, `DSH 侧动作缺失: ${call}`);
  }

  // 面板页面不得被 DSH 侧取代：轮询只读状态，绝不在 DSH 内重新抓屏。
  const poll = functionSource(code, 'async function pollOverlaySession(token, deps) {');
  assert.notEqual(poll, null, '找不到 pollOverlaySession');
  assert.equal(poll.includes('CAPTURE_PATH'), false, '轮询不得顺手抓屏（抓屏只由宿主在 start 时做一次）');
  assert.match(poll, /isOverlayTerminal\(state\)\) return/, '终态必须立刻返回');
  assert.match(poll, /deps\.sleep\(OVERLAY_POLL_MS\)/, '等待必须走可取消的注入 sleep（卸载即退）');
});

// ── 4. 负样本 ──────────────────────────────────────────────────────────────

test('(t59-8) negative samples: dropping the deadline / the fallback / the terminal stop must break behaviour', async () => {
  const api = buildApi(code);
  assert.notEqual(api, null, '无法从 client.js 切出 B1 编排');

  // 负样本 1：去掉总时长上限 → 自己收口失效（只能等宿主或卸载），状态从 timeout 变成 unmounted。
  const noDeadline = code.replace(
    '        if (elapsedMs >= OVERLAY_POLL_DEADLINE_MS) return { state: \'timeout\', action: null, polls, elapsedMs, unmounted: false };',
    '',
  );
  assert.notEqual(noDeadline, code, 'deadline 分支不存在，负样本无从构造');
  const apiNoDeadline = buildApi(noDeadline);
  assert.notEqual(apiNoDeadline, null);
  let clock = 0;
  let sleeps = 0;
  const outcome = await apiNoDeadline.pollOverlaySession('tok', {
    fetch: async () => jsonResponse({ ok: true, state: 'running', action: null }),
    now: () => {
      clock += 30_000;
      return clock;
    },
    sleep: async () => {
      sleeps += 1;
      return sleeps < 3;
    },
  });
  assert.equal(outcome.state, 'unmounted', '没有 deadline 时无法自己收口 = 这条门禁有效');

  // 负样本 2：去掉终态即停 → ready 之后还会继续轮询。
  const noStop = code.replace(
    '        if (isOverlayTerminal(state)) return { state, action, polls, elapsedMs, unmounted: false };',
    '',
  );
  assert.notEqual(noStop, code, '终态返回不存在，负样本无从构造');
  const apiNoStop = buildApi(noStop);
  assert.notEqual(apiNoStop, null);
  let polls = 0;
  let alive = 0;
  const kept = await apiNoStop.pollOverlaySession('tok', {
    fetch: async () => {
      polls += 1;
      return jsonResponse({ ok: true, state: 'ready', action: 'insert' });
    },
    now: () => 0,
    sleep: async () => {
      alive += 1;
      return alive < 3;
    },
  });
  assert.equal(kept.state, 'unmounted', '终态不停 = 会一直轮询（门禁有效）');
  assert.equal(polls, 3, '去掉终态返回后确实多轮询了（三次而不是一次）');

  // 负样本 3：拿掉回退 → no-browser 时不再进 DSH 内流程（用户会以为"截图坏了"）。
  const noFallback = code.replace('        await capture(runtime, through);', '        return;');
  assert.notEqual(noFallback, code, 'B1 回退调用不存在，负样本无从构造');
  const apiNoFallback = buildApi(noFallback);
  assert.notEqual(apiNoFallback, null);
  await apiNoFallback.startShot(fakeRuntime(), {
    startSession: async () => ({ ok: false, reason: 'no-browser' }),
    poll: async () => {
      throw new Error('不该轮询');
    },
  });
  assert.deepEqual(apiNoFallback.startCaptureCalls, [], '去掉回退后仍然回退了 = 负样本没造对');

  // 正样本对照：真实源码在同样输入下必须回退。
  api.startCaptureCalls.length = 0;
  await api.startShot(fakeRuntime(), {
    startSession: async () => ({ ok: false, reason: 'no-browser' }),
    poll: async () => {
      throw new Error('不该轮询');
    },
  });
  assert.deepEqual(api.startCaptureCalls, [{ through: true }], '真实源码必须回退');

  // 负样本 4：轮询间隔拉到 1 s（体感卡顿）→ 节奏门禁必须失败。
  const slow = code.replace('const OVERLAY_POLL_MS = 250;', 'const OVERLAY_POLL_MS = 1000;');
  assert.notEqual(slow, code, '轮询间隔常量不存在，负样本无从构造');
  const apiSlow = buildApi(slow);
  assert.notEqual(apiSlow, null);
  assert.equal(apiSlow.OVERLAY_POLL_MS <= 400, false, '1 s 轮询仍通过节奏门禁 = 假绿');
});
