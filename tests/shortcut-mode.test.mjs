/**
 * t52：ALT+A 应用内快捷键 + 「抓屏始终先隐藏 DSH」（宿主 mode=through）的离线契约。
 *
 * t45 的「普通 / 穿透」右键菜单已被用户定案删除（C-6 作废）：不再有模式选择、不再有会话内记忆，
 * 抓屏请求**始终**带 `mode=through`，只有降级重试才用 `mode=normal`（不隐藏，图里会包含 DSH）。
 * 本文件分三层：
 *   1. 纯判定：`isCaptureShortcut` / `isEditableTarget` / `shouldStartCapture` / `captureQueryFor` /
 *      `captureModeMetrics` 切出来真跑（不依赖 DOM）；
 *   2. 接线：无菜单残留、左键与 ALT+A 同一条路径、降级回退分支与可见文案；
 *   3. locale 镜像：以 client.js 的 TEXT 为唯一真相比对 locale/{zh,en}.json。
 * 末尾给负样本：任一条打回原形，对应断言必须失败。
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

const LOGIC_SIGNATURES = [
  'function isCaptureShortcut(event) {',
  'function isEditableTarget(target) {',
  'function shouldStartCapture(event, doc, target) {',
  'function captureQueryFor(through, viewport) {',
  'function captureModeMetrics(header) {',
];

/**
 * 把 t52 依赖的纯逻辑切出来并真实执行。
 * @param {string} text @returns {object|null}
 */
function evaluateClientLogic(text) {
  const consts = ['CAPTURE_MODE_THROUGH', 'CAPTURE_MODE_NORMAL'].map((name) => constLine(text, name));
  if (consts.some((declaration) => declaration === null)) return null;
  const functions = LOGIC_SIGNATURES.map((signature) => functionSource(text, signature));
  if (functions.some((declaration) => declaration === null)) return null;
  const names = ['isCaptureShortcut', 'isEditableTarget', 'shouldStartCapture', 'captureQueryFor', 'captureModeMetrics', 'CAPTURE_MODE_THROUGH', 'CAPTURE_MODE_NORMAL'];
  // eslint-disable-next-line no-new-func
  return new Function('URLSearchParams', `${consts.join('\n')}\n${functions.join('\n')}\nreturn { ${names.join(', ')} };`)(URLSearchParams);
}

/** @param {object} extra @returns {object} 一个带 Alt 的 A 键事件。 */
const altA = (extra = {}) => ({ key: 'a', altKey: true, ctrlKey: false, metaKey: false, ...extra });

/** @param {boolean} focused @returns {object} */
const docWithFocus = (focused) => ({ hasFocus: () => focused });

// ── 1. 纯判定 ──────────────────────────────────────────────────────────────

test('(t52-1) ALT+A is recognized only as Alt+A, and never fires in an input or an unfocused page', () => {
  const api = evaluateClientLogic(code);
  assert.notEqual(api, null, '无法从 client.js 切出 t52 的纯逻辑');

  assert.equal(api.isCaptureShortcut(altA()), true);
  assert.equal(api.isCaptureShortcut(altA({ key: 'A' })), true, '大小写不敏感');
  assert.equal(api.isCaptureShortcut(altA({ key: 'ф', code: 'KeyA' })), true, '非拉丁布局用物理键兜底');
  assert.equal(api.isCaptureShortcut({ key: 'a', altKey: false }), false);
  assert.equal(api.isCaptureShortcut(altA({ ctrlKey: true })), false, 'Ctrl+Alt+A 不抢');
  assert.equal(api.isCaptureShortcut(altA({ metaKey: true })), false);
  assert.equal(api.isCaptureShortcut(null), false);

  assert.equal(api.isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(api.isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(api.isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true, '富文本里的子节点也算可编辑');
  assert.equal(api.isEditableTarget({ tagName: 'DIV' }), false);
  assert.equal(api.isEditableTarget(null), false);

  const canvas = { tagName: 'DIV' };
  assert.equal(api.shouldStartCapture(altA(), docWithFocus(true), canvas), true, '聚焦 + 非输入框 → 触发');
  assert.equal(api.shouldStartCapture(altA(), docWithFocus(true), { tagName: 'INPUT' }), false, '输入框内不吞键、不触发');
  assert.equal(api.shouldStartCapture(altA(), docWithFocus(false), canvas), false, '页面未聚焦不触发（应用内快捷键的降级）');
  assert.equal(api.shouldStartCapture(altA(), {}, canvas), true, '拿不到 hasFocus 时按触发处理（不因探针缺失失能）');
});

test('(t52-2) the capture request ALWAYS carries mode=through; only the fallback retry uses mode=normal', () => {
  const api = evaluateClientLogic(code);
  assert.notEqual(api, null, '无法从 client.js 切出 t52 的纯逻辑');
  const viewport = { width: 1720, height: 720 };

  const initial = api.captureQueryFor(undefined, viewport);
  assert.equal(initial.get('mode'), 'through', '默认（左键 / ALT+A）必须带 mode=through');
  assert.equal(api.captureQueryFor(true, viewport).get('mode'), 'through');
  assert.equal(initial.get('fresh'), '1');
  assert.equal(initial.get('vw'), '1720');
  assert.equal(initial.get('vh'), '720');

  const fallback = api.captureQueryFor(false, viewport);
  assert.equal(fallback.get('mode'), 'normal', '降级重试才不隐藏（mode=normal）');
  assert.equal(fallback.get('fresh'), '1');

  const noViewport = api.captureQueryFor(true, { width: 0, height: 0 });
  assert.equal(noViewport.get('vw'), null, '拿不到视口就不带 vw/vh');
  assert.equal(noViewport.get('mode'), 'through');

  // X-1 的跨半比对按字面抓参数名：这行必须保持 `query.set('mode', …)`。
  assert.match(code, /query\.set\('mode', /, "请求里没有字面量 query.set('mode', …)（X-1 抓不到参数名）");
});

test('(t52-3) the host\'s mode/hiddenMs/restoreOk metrics are consumed defensively', () => {
  const api = evaluateClientLogic(code);
  assert.notEqual(api, null, '无法从 client.js 切出 t52 的纯逻辑');
  assert.deepEqual(api.captureModeMetrics({ mode: 'through', hiddenMs: 231, restoreOk: true }), { mode: 'through', hiddenMs: 231, restoreOk: true });
  assert.deepEqual(api.captureModeMetrics({ mode: 'normal', hiddenMs: 0, restoreOk: true }), { mode: 'normal', hiddenMs: 0, restoreOk: true });
  assert.deepEqual(api.captureModeMetrics({}), { mode: 'normal', hiddenMs: null, restoreOk: null }, '缺字段时给安全缺省');
  assert.deepEqual(api.captureModeMetrics(null), { mode: 'normal', hiddenMs: null, restoreOk: null });
  assert.equal(api.captureModeMetrics({ hiddenMs: -5 }).hiddenMs, null, '负毫秒不接受');
  assert.equal(api.captureModeMetrics({ hiddenMs: '231' }).hiddenMs, null, '字符串不接受');
  assert.equal(api.captureModeMetrics({ restoreOk: false }).restoreOk, false, 'restoreOk=false 必须原样保留（失败判定要用）');
  assert.equal(api.captureModeMetrics({ mode: 'weird' }).mode, 'normal');
});

// ── 2. 接线 ────────────────────────────────────────────────────────────────

/**
 * 接线契约：两个入口同一条路径（B1 面板优先 + DSH 内回退）、降级回退可见且自动、
 * **右键模式菜单存在且模式真的透传到两条路径**（t67：C-6 复活）。
 * @param {string} text @returns {{ok: boolean, reason: string}}
 */
function simplifiedCaptureWiring(text) {
  // (a) 两个入口走同一路径：都是 startShot(runtime)（t59：先拉 B1 独立全屏面板）。
  const button = functionSource(text, 'function ScreenshotButton(props) {');
  if (button === null) return { ok: false, reason: '找不到 ScreenshotButton' };
  if (!/onClick: \(\) => \{\s*void startShot\(runtime\);|if \(state\.modeMenu !== null\) \{/.test(button)) {
    return { ok: false, reason: '左键没有走 startShot(runtime)（B1 入口）' };
  }
  if (!/void startShot\(runtime\);/.test(button)) return { ok: false, reason: 'ALT+A 与左键不是同一条路径' };
  if (button.includes('void startCapture(runtime);')) return { ok: false, reason: '按钮绕过了 startShot，直接进 DSH 内覆盖层' };
  if (!/shouldStartCapture\(event, document, event\.target\)/.test(button)) return { ok: false, reason: '快捷键没走 shouldStartCapture（聚焦/输入框判定会被绕过）' };
  if (!button.includes("document.addEventListener('keydown', onKeyDown, true)")) return { ok: false, reason: 'ALT+A 没有 document keydown 监听' };
  if (!button.includes("return () => document.removeEventListener('keydown', onKeyDown, true)")) return { ok: false, reason: 'ALT+A 监听没有清理' };
  if (/globalShortcut|registerHotkey|registerAccelerator|globalHotkey/.test(text)) {
    return { ok: false, reason: '出现了全局热键 API（本轮口径是应用内快捷键）' };
  }
  // (a2) t67：右键菜单必须在位（C-6 复活）—— 按钮开菜单、菜单可选、模式写进会话状态。
  if (!button.includes('onContextMenu')) return { ok: false, reason: '按钮没有右键菜单入口（t67 要求右键选模式）' };
  if (!button.includes("'aria-haspopup': 'menu'")) return { ok: false, reason: '按钮没有 aria-haspopup=menu（无障碍拿不到菜单）' };
  if (!button.includes('openCaptureMenu(runtime)')) return { ok: false, reason: '右键没有真的打开菜单' };
  const menu = functionSource(text, 'function CaptureModeMenu(props) {');
  if (menu === null) return { ok: false, reason: '找不到 CaptureModeMenu（右键菜单没实现）' };
  for (const marker of ["role: 'menu'", "role: 'menuitemradio'", "'aria-checked'", 'CAPTURE_MODE_ITEMS', 'chooseCaptureMode(runtime', 'closeCaptureMenu(runtime)']) {
    if (!menu.includes(marker)) return { ok: false, reason: `菜单缺少 ${marker}` };
  }
  for (const key of ['ArrowDown', 'ArrowUp', 'Escape', 'Enter']) {
    if (!menu.includes(`'${key}'`)) return { ok: false, reason: `菜单键盘操作缺少 ${key}` };
  }
  const choose = functionSource(text, 'function chooseCaptureMode(runtime, mode) {');
  if (choose === null) return { ok: false, reason: '找不到 chooseCaptureMode' };
  if (!choose.includes('state.captureMode = next')) return { ok: false, reason: '选择模式没有写进会话状态（等于没记住）' };
  if (!choose.includes('state.modeMenu = null')) return { ok: false, reason: '选完模式没有关菜单' };
  // (a3) t73：选择要**持久化** —— 写回宿主（宿主再写进插件配置），并在启动时读回上次的选择。
  if (!/const CAPTURE_STATE_PATH = '\/api\/dsh-screenshot\/state';/.test(text)) {
    return { ok: false, reason: '没有截图模式偏好路由常量（t73 的持久化通道缺失）' };
  }
  if (!/void saveCaptureMode\(runtime, next\);/.test(choose)) {
    return { ok: false, reason: '选完模式没有写回宿主（重启后又会回到默认，用户要求正是记住它）' };
  }
  const save = functionSource(text, 'async function saveCaptureMode(runtime, mode, fetchImpl = fetch) {');
  if (save === null) return { ok: false, reason: '找不到 saveCaptureMode' };
  if (!/method: 'POST'/.test(save) || !/captureMode: normalizeCaptureMode\(mode\)/.test(save)) {
    return { ok: false, reason: 'saveCaptureMode 没有把归一化后的模式 POST 给宿主' };
  }
  const load = functionSource(text, 'async function loadCaptureMode(runtime, fetchImpl = fetch) {');
  if (load === null) return { ok: false, reason: '找不到 loadCaptureMode' };
  if (!/normalizeCaptureMode\(body\?\.captureMode\)/.test(load) || !/runtime\.state\.captureMode = next/.test(load)) {
    return { ok: false, reason: 'loadCaptureMode 没有把宿主读回的模式写进会话状态' };
  }
  if (!/void loadCaptureMode\(store\);/.test(text)) {
    return { ok: false, reason: '启动时没有读回上次选定的模式（设置页/上次的选择不会生效）' };
  }
  // (a4) t74：插件页的配置区必须由**本插件自己贡献** —— DSH 的插件页只在
  //      `plugins.bundle.config` 有贡献时才渲染 `<section data-plugin-config>`，
  //      不贡献的话用户只能在右键菜单里切（这正是"插件管理里切换"的落点）。
  if (!/const PLUGIN_CONFIG_SLOT = 'plugins\.bundle\.config';/.test(text)) {
    return { ok: false, reason: '没有插件页配置槽位常量（t74 的"插件管理里切换"无从谈起）' };
  }
  if (!/const PLUGIN_PACKAGE = 'dsh-screenshot-xn';/.test(text)) {
    return { ok: false, reason: '配置区的 key 必须是包名（DSH 按 entryKey=pkg.name 过滤）' };
  }
  if (!/ctx\.slots\.inject\(PLUGIN_CONFIG_SLOT, \(\) => ctx\.slots\.register\(\{/.test(text) || !/key: PLUGIN_PACKAGE/.test(text)) {
    return { ok: false, reason: '没有把配置区注册进 plugins.bundle.config（插件页会连配置 section 都没有）' };
  }
  const setting = functionSource(text, 'function CaptureModeSetting() {');
  if (setting === null) return { ok: false, reason: '找不到 CaptureModeSetting 组件' };
  // 形态照抄 DSH 自己的语音输入插件：**原生 select 包在 label 里**（用户明确要"前面加文字 截图模式"）。
  // 两条实机教训必须同时守住：不得挂 onMouseDown（preventDefault 会让下拉弹不开）、不得 disabled。
  for (const marker of [
    "h('select'",
    "h('label'",
    'htmlFor: SETTING_SELECT_ID',
    "h('option'",
    'readCaptureMode()',
    'saveCaptureMode(null, wanted)',
  ]) {
    if (!setting.includes(marker)) return { ok: false, reason: `配置控件缺少 ${marker}` };
  }
  if (/onMouseDown/.test(setting)) return { ok: false, reason: '配置控件挂了 onMouseDown（preventDefault 会让下拉弹不开）' };
  if (/disabled/.test(setting)) return { ok: false, reason: '配置控件会在加载前 disabled（读失败后永久点不动）' };
  if (!/TEXT\.modeSetting/.test(setting)) return { ok: false, reason: '控件前面没有「截图模式」文字标签' };
  // t74c：控件必须把选择写进**共享会话状态** —— 否则插件页改了，下一次截图仍用旧值
  //（用户实测：「配置页面可以切 但实际截图的时候是按照右键选择来的」）。
  if (!/runtime\.state\.captureMode = wanted;/.test(setting) || !/runtime\.notify\(\)/.test(setting)) {
    return { ok: false, reason: '控件没有把选择同步到共享会话状态（插件页改了但截图仍用旧值）' };
  }
  if (!/useShotStore\(\)/.test(setting)) return { ok: false, reason: '控件没有订阅共享会话状态' };
  // t74c：抓屏前必须跟宿主对一次模式（另一棵 React 树改的也要生效）。
  const beforeShot = functionSource(text, 'async function startShot(runtime, deps = {}) {');
  if (beforeShot === null) return { ok: false, reason: '找不到 startShot' };
  if (!/await loadCaptureMode\(runtime,/.test(beforeShot)) {
    return { ok: false, reason: 'startShot 没有在抓屏前刷新模式（从插件页改的不会生效）' };
  }
  if (!/modeSaved/.test(setting) && !/modeSaved/.test(text)) return { ok: false, reason: '保存后没有反馈文案' };
  const normalize = functionSource(text, 'function normalizeCaptureMode(value) {');
  if (normalize === null) return { ok: false, reason: '找不到 normalizeCaptureMode（模式取值没有归一化）' };
  if (!normalize.includes('CAPTURE_MODE_NORMAL ? CAPTURE_MODE_NORMAL : CAPTURE_MODE_THROUGH')) {
    return { ok: false, reason: '模式归一化没有把脏值/缺省落到穿透（默认必须不含 DSH）' };
  }
  if (!/captureMode: CAPTURE_MODE_THROUGH/.test(text)) return { ok: false, reason: '会话默认模式不是穿透' };
  // (b) startShot：先 POST /overlay/start（带上模式）；不可用 → 可见提示 + 回退既有 DSH 内覆盖层流程。
  const shot = functionSource(text, 'async function startShot(runtime, deps = {}) {');
  if (shot === null) return { ok: false, reason: '找不到 startShot（B1 入口）' };
  if (!shot.includes('startOverlaySession')) return { ok: false, reason: 'startShot 没有先拉起独立全屏面板' };
  if (!shot.includes('normalizeCaptureMode(state.captureMode)')) return { ok: false, reason: 'startShot 没有读会话里的模式' };
  if (!shot.includes('await startSession(mode)')) return { ok: false, reason: '模式没有传给面板会话（面板路径选不动模式）' };
  if (!shot.includes('overlayFallbackNotice')) return { ok: false, reason: '面板不可用时没有可见提示' };
  if (!shot.includes('await capture(runtime, through)')) return { ok: false, reason: '面板不可用时没有带着模式回退 DSH 内流程' };
  if (!/state\.phase = 'idle';/.test(shot)) return { ok: false, reason: '忙态没有收口（可能永久转圈）' };
  // (b2) 面板会话把模式写在查询串上（宿主 `overlayParam(url, 'mode')` 两侧一致）。
  const session = functionSource(text, 'async function startOverlaySession(mode = CAPTURE_MODE_THROUGH, fetchImpl = fetch) {');
  if (session === null) return { ok: false, reason: '找不到 startOverlaySession（或它的签名变了）' };
  if (!session.includes("query.set('mode', normalizeCaptureMode(mode))")) {
    return { ok: false, reason: '面板会话没有把模式写进查询串' };
  }
  // (c) 抓屏默认隐藏 DSH；降级回退保留且可见。
  const start = functionSource(text, 'async function startCapture(runtime, through = true) {');
  if (start === null) return { ok: false, reason: 'startCapture 没有 through=true 默认值（默认必须隐藏 DSH）' };
  if (!start.includes('fetchFrozenFrame(startedAt, through)')) return { ok: false, reason: '隐藏开关没有透传给抓屏请求' };
  if (!start.includes('TEXT.throughUnavailable')) return { ok: false, reason: '宿主没能隐藏时没有可见说明（图里含 DSH）' };
  if (!start.includes('frame.capture.restoreOk === false')) return { ok: false, reason: '没有消费 restoreOk 做失败判定' };
  if (!start.includes('TEXT.throughRestoreFailed')) return { ok: false, reason: '恢复未确认时没有可见说明' };
  if (!start.includes('TEXT.throughFailed')) return { ok: false, reason: '隐藏/抓屏失败时没有可见说明' };
  const retries = start.split('await startCapture(runtime, false);').length - 1;
  if (retries < 2) return { ok: false, reason: '回退（不隐藏抓屏）分支不全：失败与恢复未确认都必须重试' };
  if (!/mode: frame\.capture\.mode/.test(start) || !/hiddenMs: frame\.capture\.hiddenMs/.test(start)) {
    return { ok: false, reason: 'capture ready 日志没有带上 mode/hiddenMs' };
  }
  return { ok: true, reason: '' };
}

test('(t52-4) both entries share the B1 entry, the visible in-DSH fallback stays, and the right-click mode menu is back', () => {
  const result = simplifiedCaptureWiring(code);
  assert.equal(result.ok, true, result.reason);
});

// ── 3. locale 镜像 ─────────────────────────────────────────────────────────

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

/** @param {object} object @param {string} [prefix] @returns {Map<string, unknown>} */
function flatten(object, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(object)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object') {
      for (const [childKey, childValue] of flatten(value, path)) out.set(childKey, childValue);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/**
 * locale 镜像审计：TEXT 为唯一真相。
 * @param {string} text @param {object} localeJson @returns {{ok: boolean, reason: string, counts: object}}
 */
function auditLocaleMirror(text, localeJson) {
  const table = readTextTable(text);
  if (table === null) return { ok: false, reason: '找不到 TEXT 表', counts: {} };
  const expected = flatten(table);
  const actual = flatten(localeJson.ui ?? {});
  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const orphan = [...actual.keys()].filter((key) => !expected.has(key));
  const empty = [...expected.keys()].filter((key) => typeof actual.get(key) !== 'string' || actual.get(key).trim() === '');
  const counts = { text: expected.size, locale: actual.size, missing: missing.length, orphan: orphan.length, empty: empty.length };
  if (missing.length > 0) return { ok: false, reason: `locale 缺键: ${missing.slice(0, 6).join(', ')}`, counts };
  if (orphan.length > 0) return { ok: false, reason: `locale 孤儿键: ${orphan.slice(0, 6).join(', ')}`, counts };
  if (empty.length > 0) return { ok: false, reason: `locale 空值: ${empty.slice(0, 6).join(', ')}`, counts };
  return { ok: true, reason: '', counts };
}

const readLocale = (lang) => JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'));

test('(t52-5) locale mirrors TEXT exactly, with the menu keys gone and the fallback wording kept', () => {
  const zh = auditLocaleMirror(code, readLocale('zh'));
  const en = auditLocaleMirror(code, readLocale('en'));
  assert.equal(zh.ok, true, `zh: ${zh.reason}`);
  assert.equal(en.ok, true, `en: ${en.reason}`);
  assert.equal(zh.counts.locale, zh.counts.text, 'zh 键数应与 TEXT 一致');
  assert.equal(en.counts.locale, en.counts.text, 'en 键数应与 TEXT 一致');
  assert.equal(zh.counts.missing + zh.counts.orphan + en.counts.missing + en.counts.orphan, 0);
  const zhTable = flatten(readLocale('zh').ui);
  for (const key of ['shortcut', 'throughUnavailable', 'throughFailed', 'throughRestoreFailed']) {
    assert.equal(typeof zhTable.get(key), 'string', `zh 应保留 ${key}`);
  }
  // t67：右键菜单复活 → 菜单文案必须在（且与 TEXT 逐字一致，下面的漂移断言会兜住）。
  for (const key of ['modeMenuLabel', 'modeNormal', 'modeThrough', 'modeHintNormal', 'modeHintThrough', 'modeMenuHint', 'toastNormalMode']) {
    assert.equal(typeof zhTable.get(key), 'string', `zh 应有菜单文案 ${key}`);
  }
  assert.equal(zhTable.has('throughFellBack'), false, 'zh 不应再有更早期作废的 throughFellBack');
  // 中文镜像必须逐字出现在 TEXT 的双语串里（TEXT = 「中文 / English」的唯一真相）。
  const table = flatten(readTextTable(code));
  const drifted = [...table.keys()].filter((key) => !String(table.get(key)).includes(String(zhTable.get(key))));
  assert.deepEqual(drifted, [], `zh 文案与 TEXT 漂移: ${drifted.slice(0, 5).join(', ')}`);
});

test('(t52-6) negative samples: dropping "always through" / the fallbacks / the mode plumbing fails t52-2/4', () => {
  // 负样本 1：降级重试不带 mode（回到 t45 的"普通模式不带参数"）→ "始终带 mode" 必须失败。
  const missingMode = code.replace(
    "query.set('mode', through === false ? CAPTURE_MODE_NORMAL : CAPTURE_MODE_THROUGH);",
    "if (through !== false) query.set('mode', CAPTURE_MODE_THROUGH);",
  );
  assert.notEqual(missingMode, code, '始终带 mode 的那行不存在，负样本无从构造');
  const loose = evaluateClientLogic(missingMode);
  assert.equal(loose.captureQueryFor(false, { width: 100, height: 100 }).get('mode'), null, '降级重试不带 mode = 这条门禁有效');

  // 负样本 2：去掉回退（失败后不再改为不隐藏抓屏）→ 接线契约必须失败。
  const noFallback = code.replace('await startCapture(runtime, false);', 'return;');
  assert.notEqual(noFallback, code, '回退调用不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(noFallback).ok, false, '去掉回退后接线契约仍通过 = 假绿');

  // 负样本 3：把右键菜单拆掉（按钮不再开菜单）→ 接线契约必须失败（t67 之后菜单是要求，不是残留）。
  const menuGone = code.replace('openCaptureMenu(runtime);', 'void startShot(runtime);');
  assert.notEqual(menuGone, code, '右键开菜单的调用不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(menuGone).ok, false, '拆掉菜单后接线契约仍通过 = 假绿');

  // 负样本 4：locale 缺一个键 / 多一个孤儿键 → 镜像审计必须失败。
  const zh = readLocale('zh');
  const dropped = { ui: { ...zh.ui } };
  delete dropped.ui.throughUnavailable;
  const droppedAudit = auditLocaleMirror(code, dropped);
  assert.equal(droppedAudit.ok, false, '丢掉 throughUnavailable 后 locale 审计仍通过 = 假绿');
  assert.equal(droppedAudit.counts.missing, 1);
  const orphaned = { ui: { ...zh.ui, notInText: '孤儿' } };
  const orphanAudit = auditLocaleMirror(code, orphaned);
  assert.equal(orphanAudit.ok, false, '多出孤儿键后 locale 审计仍通过 = 假绿');
  assert.equal(orphanAudit.counts.orphan, 1);

  // 负样本 5：拿掉 B1 面板不可用时的回退 → 接线契约必须失败
  // （否则"没装浏览器就不能截图"，回退形同虚设）。
  const noOverlayFallback = code.replace('        await capture(runtime, through);', '        return;');
  assert.notEqual(noOverlayFallback, code, 'B1 回退调用不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(noOverlayFallback).ok, false, '去掉 B1 回退后接线契约仍通过 = 假绿');

  // 负样本 5b：模式不再透传给面板会话（选普通也还是穿透）→ 接线契约必须失败。
  const modeDropped = code.replace('await startSession(mode)', 'await startSession()');
  assert.notEqual(modeDropped, code, '会话调用不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(modeDropped).ok, false, '模式不透传仍通过 = 假绿');

  // 负样本 5c：模式归一化把缺省当普通（默认图里就有 DSH）→ 接线契约必须失败。
  const wrongDefault = code.replace(
    'return value === CAPTURE_MODE_NORMAL ? CAPTURE_MODE_NORMAL : CAPTURE_MODE_THROUGH;',
    'return value === CAPTURE_MODE_THROUGH ? CAPTURE_MODE_THROUGH : CAPTURE_MODE_NORMAL;',
  );
  assert.notEqual(wrongDefault, code, '归一化实现不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(wrongDefault).ok, false, '默认变成普通仍通过 = 假绿');

  // 负样本 5d（t73）：选完模式不写回宿主（重启即丢）→ 接线契约必须失败。
  const modeNotSaved = code.replace('void saveCaptureMode(runtime, next);', '');
  assert.notEqual(modeNotSaved, code, '写回宿主的那行不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(modeNotSaved).ok, false, '不持久化仍通过 = t73 的持久化防线失效');

  // 负样本 5e（t73）：启动时不读回上次的模式（设置页改了也不生效）→ 接线契约必须失败。
  const modeNotLoaded = code.replace('void loadCaptureMode(store);', '');
  assert.notEqual(modeNotLoaded, code, '启动读回的那行不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(modeNotLoaded).ok, false, '启动不读回仍通过 = t73 的持久化防线失效');

  // 负样本 5f（t74）：不贡献插件页配置区（用户没法在插件管理里切换）→ 接线契约必须失败。
  const noSettingPage = code.replace("ctx.slots.inject(PLUGIN_CONFIG_SLOT, () => ctx.slots.register({", "ctx.slots.inject('unused.slot', () => ctx.slots.register({");
  assert.notEqual(noSettingPage, code, '配置区注册不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(noSettingPage).ok, false, '没有插件页配置区仍通过 = t74 的防线失效');

  // 负样本 5g（t74b）：控件挂回 onMouseDown（原生下拉会被 preventDefault 吃掉）→ 契约必须失败。
  const nativeSelect = code.replace(
    "            onChange: (event) => choose(event.target.value),",
    "            onChange: (event) => choose(event.target.value),\n            onMouseDown: preventFocusLoss,",
  );
  assert.notEqual(nativeSelect, code, '原生 select 不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(nativeSelect).ok, false, '控件挂回 onMouseDown 仍通过 = t74b 的防线失效');

  // 负样本 5h（t74c）：控件不再同步共享状态（插件页改了、截图仍用旧值）→ 契约必须失败。
  const noSync = code.replace('runtime.state.captureMode = wanted;', '');
  assert.notEqual(noSync, code, '同步共享状态那行不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(noSync).ok, false, '插件页改了不同步仍通过 = t74c 的防线失效');

  // 负样本 5i（t74c）：抓屏前不再刷新模式（外部改的永远不生效）→ 契约必须失败。
  const noRefresh = code.replace('await loadCaptureMode(runtime, deps.fetch ?? (typeof fetch === \'function\' ? fetch : undefined));', '');
  assert.notEqual(noRefresh, code, '抓屏前刷新那行不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(noRefresh).ok, false, '抓屏前不刷新仍通过 = t74c 的防线失效');

  // 负样本 6：按钮绕过 startShot 直接进 DSH 内覆盖层 → 接线契约必须失败（B1 会被悄悄绕过）。
  const bypassed = code.split('void startShot(runtime);').join('void startCapture(runtime);');
  assert.notEqual(bypassed, code, '按钮左键入口不存在，负样本无从构造');
  assert.equal(simplifiedCaptureWiring(bypassed).ok, false, '绕过 startShot 后接线契约仍通过 = 假绿');
});
