/**
 * B1 端到端复跑（离线、无浏览器、无界面）：**真实宿主路由** + **真实客户端编排**。
 *
 * 它把 t56（宿主 overlay 路由族）、t57（页面协议）、t59（DSH 侧编排）接在一起跑一遍，
 * 用真实的 HTTP + 真实的进程拉起，验证「点截图 → 面板会话 → 结果 PNG → 动作在 DSH 内执行」
 * 这条链路上的每一跳，而不需要真的弹一个浏览器窗口：
 *
 *   - 抓屏脚本：换成 stub（写一张合法 PNG + 打印宿主契约里的 JSON 块 + 记下自己的 argv）——
 *     真实 `capture.ps1` 的行为由 `tests/host-through.test.mjs` 单独覆盖，这里只需要一个确定性的帧；
 *   - 覆盖层窗口：`overlayLaunch` 这个宿主既有 seam 换成 `node page-standin.mjs` ——
 *     它的行为与 `overlay/overlay.js` 对宿主的协议完全一致（取帧 → 心跳 → POST {action, png} → 退出）；
 *   - DSH 侧：client.js 的 `startShot` 真身（切出来执行），`fetch` 换成把同源相对路径解析到
 *     本次 harness 的 HTTP 端口上（浏览器里就是同源），插入动作换成一个记录字节的替身。
 *
 * 场景：① insert 全链路（字节 SHA256 一致）② cancel 无副作用 ③ 面板静态资源免 token
 * ④（t67）右键菜单选的抓屏模式真的走到宿主 ⑤ 老宿主 404 → 可见提示 + 回退。
 *
 * 用法：`node tests/overlay-e2e.mjs`（需要 Windows PowerShell：stub 抓屏脚本由宿主用 PS 拉起）。
 * 退出码 0 = 全部场景通过。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const POWERSHELL = 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const CLIENT_SOURCE = readFileSync(join(PACKAGE, 'client.js'), 'utf8');

const { apply, OVERLAY_PREFIX, STATE_PATH, MODE_THROUGH, MODE_NORMAL, Config } = await import(pathToFileURL(join(PACKAGE, 'index.js')).href);

const workspace = mkdtempSync(join(tmpdir(), 'dsh-overlay-e2e-'));

// ── 合成 PNG（无第三方依赖：签名 + IHDR + IDAT + IEND） ─────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {number} width @param {number} height @param {number[]} rgb @returns {Buffer} */
function pngOf(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (1 + width * 3);
    raw[offset] = 0; // filter: none
    for (let column = 0; column < width; column += 1) {
      raw[offset + 1 + column * 3] = rgb[0];
      raw[offset + 2 + column * 3] = rgb[1];
      raw[offset + 3 + column * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const framePng = pngOf(8, 4, [255, 0, 255]); // 「冻结帧」
const resultPng = pngOf(6, 3, [0, 128, 255]); // 「面板交回的选区 + 标注」
const framePath = join(workspace, 'frame.png');
const resultPath = join(workspace, 'result.png');
writeFileSync(framePath, framePng);
writeFileSync(resultPath, resultPng);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// ── stub 抓屏脚本（宿主用 PowerShell 拉起它） ───────────────────────────────

const stubCapturePath = join(workspace, 'stub-capture.ps1');
const stubLogPath = join(workspace, 'stub-capture.log');
writeFileSync(stubCapturePath, `param(
  [ValidateSet('info', 'shot', 'both')][string]$Mode = 'both',
  [switch]$DpiAware,
  [string]$OutDir = $env:TEMP,
  [string]$Tag = 'stub',
  [switch]$Through,
  [int]$HideWaitMs = 250,
  [string]$HideMethod = 'hide',
  [int]$DshPid = 0,
  [string]$DshImage = '',
  [string]$DshTitleHint = 'DSH',
  [switch]$RestoreOnly
)
$frame = '${framePath.replace(/\\/g, '\\\\')}'
if ($RestoreOnly) { exit 0 }
Add-Content -LiteralPath '${stubLogPath.replace(/\\/g, '\\\\')}' -Value ('capture through=' + [bool]$Through)
$body = '{"ok":true,"through":"captured","through_reason":null,"restore_ok":true,"hidden_ms":263,"png_path":"' + $frame + '","bitmap_width":8,"bitmap_height":4,"png_bytes":' + (Get-Item -LiteralPath $frame).Length + ',"elapsed_total_ms":412,"capture_bounds":{"x":0,"y":0,"width":8,"height":4},"virtual_screen":{"x":0,"y":0,"width":8,"height":4},"single_screen":true,"screen_count":1,"error":null}'
Write-Host '---JSON-BEGIN---'
Write-Host $body
Write-Host '---JSON-END---'
exit 0
`, 'utf8');

// ── 覆盖层窗口替身：与 overlay/overlay.js 对宿主的协议一致 ──────────────────

const standinPath = join(workspace, 'page-standin.mjs');
writeFileSync(standinPath, `import { appendFileSync, readFileSync } from 'node:fs';

const [pageUrl, action, resultPath, logPath] = process.argv.slice(2, 6);
const log = (line) => appendFileSync(logPath, line + '\\n', 'utf8');
const token = new URL(pageUrl).searchParams.get('token');
const origin = new URL(pageUrl).origin;
log('page ' + pageUrl.replace(/token=[^&]+/, 'token=<redacted>'));
if (!token) { log('no token'); process.exit(2); }

const ping = await fetch(origin + '/api/dsh-screenshot/overlay/ping?token=' + token);
log('ping ' + ping.status);
const frame = await fetch(origin + '/api/dsh-screenshot/overlay/frame?token=' + token);
const frameBytes = Buffer.from(await frame.arrayBuffer());
log('frame ' + frame.status + ' ' + frameBytes.length);

if (action === 'none') {
  await new Promise((resolve) => setTimeout(resolve, 400));
  log('exit-without-result');
  process.exit(0);
}

const png = readFileSync(resultPath);
const payload = action === 'cancel'
  ? { action: 'cancel' }
  : { action, png: 'data:image/png;base64,' + png.toString('base64') };
const posted = await fetch(origin + '/api/dsh-screenshot/overlay/result?token=' + token, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
log('result ' + posted.status + ' ' + JSON.stringify(await posted.json()));
process.exit(0);
`, 'utf8');

// ── 客户端编排：把 B1 那一半从 client.js 里切出来真跑 ───────────────────────

/** @param {string} text @returns {string} */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = stripComments(CLIENT_SOURCE);

/** @param {string} text @param {string} signature @returns {string|null} */
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

/** @param {string} text @param {string} name @returns {string|null} */
function constLine(text, name) {
  const at = text.indexOf(`const ${name} = `);
  if (at === -1) return null;
  const end = text.indexOf(';\n', at);
  return end === -1 ? null : text.slice(at, end + 1);
}

/** @param {string} text @returns {object|null} */
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
      if (depth === 0) return new Function(`return ${text.slice(braceAt, index + 1)};`)();
    }
  }
  return null;
}

const SLICE_CONSTS = [
  'CAPTURE_MODE_THROUGH', 'CAPTURE_MODE_NORMAL', 'CAPTURE_STATE_PATH',
  'OVERLAY_START_PATH', 'OVERLAY_STATUS_PATH', 'OVERLAY_RESULT_PNG_PATH',
  'OVERLAY_POLL_MS', 'OVERLAY_POLL_DEADLINE_MS', 'OVERLAY_POLL_FAILURE_LIMIT',
  'OVERLAY_TERMINAL_STATES', 'OVERLAY_ACTIONS',
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

const clientCalls = { inserted: [], copied: [], saved: [], captures: [], focuses: [] };

function buildClient() {
  const consts = SLICE_CONSTS.map((name) => constLine(code, name));
  const functions = SLICE_FUNCTIONS.map((signature) => functionSource(code, signature));
  if (consts.some((line) => line === null) || functions.some((fn) => fn === null)) return null;
  const body = `
    ${consts.join('\n')}
    const TEXT = ${JSON.stringify(readTextTable(code))};
    const PNG_MIME = 'image/png';
    const nowMs = () => Date.now();
    const logger = { info: (m, d) => log('client.info ' + m + ' ' + JSON.stringify(d ?? null)), warn: (m, d) => log('client.warn ' + m + ' ' + JSON.stringify(d ?? null)) };
    const errorText = (error) => (error instanceof Error ? error.message : String(error));
    const insertIntoConversation = async (runtime, blob, mediaType) => {
      const bytes = Buffer.from(await blob.arrayBuffer());
      record('inserted', { bytes: bytes.length, sha256: sha256(bytes), mediaType });
      return { ok: true, method: 'paste', kind: 'success', text: TEXT.toastInserted };
    };
    const copyPngToClipboard = async (blob, platform, mediaType) => {
      record('copied', { bytes: blob.size, mediaType });
      return { ok: true };
    };
    const savePngAs = async (blob, platform, mediaType) => {
      record('saved', { bytes: blob.size, mediaType });
      return { ok: true, method: 'picker' };
    };
    const startCapture = async (runtime, through = true) => { record('captures', { through }); };
    const focusComposer = () => { record('focuses', {}); };
    ${functions.join('\n')}
    return { startShot, startOverlaySession, pollOverlaySession, fetchOverlayResult, deliverOverlayResult };
  `;
  return new Function('URLSearchParams', 'Buffer', 'sha256', 'log', 'record', body)(URLSearchParams, Buffer, sha256, log, record);
}

// ── harness 基础设施 ───────────────────────────────────────────────────────

function log() {
  /* 客户端日志：harness 只关心断言。 */
}
function record(bucket, value) {
  clientCalls[bucket].push(value);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 启动真实宿主路由；返回 base / logs / close。 */
async function bootHost(settings) {
  const routes = [];
  const hostLogs = [];
  const webServer = {
    port: 0,
    host: '127.0.0.1',
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const ctx = {
    logger: {
      debug() {},
      info: (line) => hostLogs.push(`info ${line}`),
      warn: (line) => hostLogs.push(`warn ${line}`),
    },
    get: (name) => {
      if (name === 'webServer') return webServer;
      if (name === 'settings') return settings?.settings;
      return undefined;
    },
    inject: (deps, callback) => callback(ctx, {}),
    effect: (fn) => fn(),
    on: () => () => {},
  };
  // 帧文件会被多个场景各读一次：别让宿主读完就删（harness 的 workspace 本身就是临时的）。
  apply(ctx, { keepTempFile: true, ...(settings?.config ?? settings) });
  const overlayRoute = routes.find((route) => route.kind === 'prefix' && route.path === OVERLAY_PREFIX);
  assert.ok(overlayRoute !== undefined, 'overlay 路由族必须注册');
  // 把所有已注册的路由按"精确 / 前缀"挂到一台测试服务器上（t73 起还有 mode 偏好路由）。
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const exact = routes.find((route) => route.kind === 'exact' && route.path === path);
    if (exact !== undefined) {
      void exact.handler(req, res);
      return;
    }
    if (path.startsWith(OVERLAY_PREFIX)) {
      void overlayRoute.handler(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"route.not-found"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  webServer.port = server.address().port;
  return {
    base: `http://127.0.0.1:${webServer.port}`,
    logs: hostLogs,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 浏览器里的 `fetch('/relative')` 在 harness 里的等价物：解析到本次端口。 */
const originFetch = (base) => (url, init) => fetch(new URL(url, base), init);

function fakeRuntime() {
  const state = { phase: 'idle', busy: false, notice: null, attachmentCount: 2, captureMode: 'through' };
  const toasts = [];
  return {
    state,
    toasts,
    notify() {},
    setToast(kind, text) {
      toasts.push({ kind, text });
    },
  };
}

/** 等一个文件出现且非空（替身进程写日志用）。 */
async function waitForFile(path, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim() !== '') return readFileSync(path, 'utf8');
    await sleep(100);
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const results = [];
function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`[PASS] ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`[FAIL] ${name} — ${detail}`);
}

/** 跑一轮完整的 startShot（客户端编排真身 + 真实宿主）。 */
async function runShot(host, captureMode, extra = {}) {
  const client = buildClient();
  assert.ok(client !== null, '无法切出客户端编排');
  const runtime = fakeRuntime();
  runtime.state.captureMode = captureMode;
  await client.startShot(runtime, {
    startSession: (mode) => client.startOverlaySession(mode, originFetch(host.base)),
    poll: (token) => client.pollOverlaySession(token, {
      fetch: originFetch(host.base),
      now: () => Date.now(),
      sleep: (ms) => sleep(ms).then(() => true),
    }),
    fetchResult: (token) => client.fetchOverlayResult(token, originFetch(host.base)),
    ...extra,
  });
  return runtime;
}

// ── 场景 ───────────────────────────────────────────────────────────────────

/** 场景 1：面板提交 insert → 客户端轮询 → 取回 PNG → 在 DSH 内“插入”。 */
async function scenarioInsert() {
  const pageLog = join(workspace, 'page-insert.log');
  const host = await bootHost({
    scriptPath: stubCapturePath,
    outDir: workspace,
    keepTempFile: true,
    overlayLaunch: [process.execPath, standinPath, '${url}', 'insert', resultPath, pageLog],
  });
  const started = Date.now();
  const runtime = await runShot(host, 'through', {
    capture: async () => {
      throw new Error('面板可用时不该回退 DSH 内流程');
    },
  });
  const elapsedMs = Date.now() - started;
  const bridgeLog = await waitForFile(pageLog);

  try {
    assert.match(bridgeLog, /^ping 200$/m, '面板心跳必须被宿主接受');
    assert.match(bridgeLog, new RegExp(`^frame 200 ${framePng.length}$`, 'm'), '面板必须从宿主取到冻结帧字节');
    assert.match(bridgeLog, /^result 200 \{"ok":true,"state":"ready"/m, '面板提交结果必须被宿主接受');
    assert.equal(clientCalls.inserted.length, 1, '客户端必须执行一次插入动作');
    assert.equal(clientCalls.inserted[0].sha256, sha256(resultPng), '插入的字节必须与面板提交的 PNG 完全一致');
    assert.equal(clientCalls.inserted[0].mediaType, 'image/png');
    assert.equal(clientCalls.captures.length, 0, '不能回退到 DSH 内覆盖层流程');
    assert.equal(runtime.state.phase, 'idle', '忙态必须收口');
    assert.deepEqual(runtime.toasts.map((toast) => toast.kind), ['info', 'success']);
    assert.ok(host.logs.some((line) => line.includes('overlay started')), '宿主日志要有会话启动记录');
    assert.ok(host.logs.some((line) => line.includes('overlay ready')), '宿主日志要有 ready 记录');
    pass('E2E-1 insert 全链路', `帧 ${framePng.length} B → 结果 ${resultPng.length} B，PNG SHA256 一致，端到端 ${elapsedMs} ms`);
  } catch (error) {
    fail('E2E-1 insert 全链路', error.message + `\n  page: ${bridgeLog.trim().split('\n').join(' | ')}\n  host: ${host.logs.join(' | ')}`);
  } finally {
    rmSync(pageLog, { force: true });
    await host.close();
  }
}

/** 场景 2：面板提交 cancel → 客户端无副作用退出。 */
async function scenarioCancel() {
  const pageLog = join(workspace, 'page-cancel.log');
  const host = await bootHost({
    scriptPath: stubCapturePath,
    outDir: workspace,
    overlayLaunch: [process.execPath, standinPath, '${url}', 'cancel', resultPath, pageLog],
  });
  const before = { inserted: clientCalls.inserted.length, copied: clientCalls.copied.length, saved: clientCalls.saved.length };
  const runtime = await runShot(host, 'through');
  const bridgeLog = await waitForFile(pageLog);
  try {
    assert.match(bridgeLog, /^result 200 .*"state":"cancelled"/m, '取消必须被宿主接受');
    assert.equal(clientCalls.inserted.length, before.inserted, '取消不得插入');
    assert.equal(clientCalls.copied.length, before.copied, '取消不得写剪贴板');
    assert.equal(clientCalls.saved.length, before.saved, '取消不得保存文件');
    assert.equal(runtime.state.phase, 'idle');
    assert.equal(runtime.toasts[runtime.toasts.length - 1].kind, 'info');
    pass('E2E-2 cancel 无副作用', `宿主 state=cancelled，客户端零动作，提示「${runtime.toasts[runtime.toasts.length - 1].text}」`);
  } catch (error) {
    fail('E2E-2 cancel 无副作用', error.message + `\n  page: ${bridgeLog.trim().split('\n').join(' | ')}`);
  } finally {
    rmSync(pageLog, { force: true });
    await host.close();
  }
}

/**
 * 场景 3：面板静态资源必须**不需要 token**就能取到（t64 实机缺陷的回归门禁）。
 *
 * 实机现象：面板窗口只渲染出未样式化的 HTML —— 白底 + 页面里那行静态提示 + 一个裸 `<input>`，
 * 脚本一行都没跑（没有心跳 → 5 s 后会话 aborted）。原因：宿主把 token 校验放在了静态分支之前，
 * 而页面的 `<link href>`、`<script src>` 与静态 `import '/…/overlay/lib/x.mjs'` 都不带 token。
 */
async function scenarioStaticAssets() {
  const host = await bootHost({ scriptPath: stubCapturePath, outDir: workspace });
  const get = (path, init) => fetch(new URL(path, host.base), init);
  try {
    const page = await get('/api/dsh-screenshot/overlay/page');
    const pageHtml = await page.text();
    assert.equal(page.status, 200, '页面 HTML 必须能在不带 token 时取到');
    assert.match(pageHtml, /拖动鼠标框选/, '页面 HTML 应该是覆盖层页面本体');

    // 页面引用的资产 + overlay.js 静态 import 的 lib 模块：全部按字面逐个取一次。
    // 只取 URL 允许的字符集（注释里也提到过这两条前缀，不能把注释里的散文当 URL）。
    const assetUrls = [...new Set([...pageHtml.matchAll(/\/api\/dsh-screenshot\/overlay\/asset\/[A-Za-z0-9._-]+/g)].map((match) => match[0]))];
    assert.ok(assetUrls.length >= 2, `页面应当引用 css 与 js 资产，实际 ${assetUrls.length} 个`);
    const jsUrl = assetUrls.find((url) => url.endsWith('.js'));
    assert.ok(jsUrl !== undefined, '页面应当引用 overlay.js');
    const jsSource = await (await get(jsUrl)).text();
    const libUrls = [...new Set([...jsSource.matchAll(/\/api\/dsh-screenshot\/overlay\/lib\/[A-Za-z0-9._-]+/g)].map((match) => match[0]))];
    assert.ok(libUrls.length >= 5, `overlay.js 应当 import 至少 5 个 lib 模块，实际 ${libUrls.length} 个`);

    const checked = [];
    for (const url of [...assetUrls, ...libUrls]) {
      const response = await get(url);
      const body = await response.arrayBuffer();
      assert.equal(response.status, 200, `${url} 必须 200（静态资源不带 token）`);
      assert.ok(body.byteLength > 0, `${url} 不能是空响应`);
      const type = response.headers.get('content-type') ?? '';
      assert.match(type, url.endsWith('.css') ? /text\/css/ : /javascript/, `${url} 的 content-type 不对: ${type}`);
      checked.push(`${url.split('/').pop()}(${body.byteLength}B)`);
    }

    // 数据路由继续被 token 保护（帧与结果都是用户的屏幕内容）。
    for (const path of ['/api/dsh-screenshot/overlay/frame', '/api/dsh-screenshot/overlay/result.png', '/api/dsh-screenshot/overlay/status', '/api/dsh-screenshot/overlay/ping']) {
      const response = await get(path);
      const body = await response.json().catch(() => ({}));
      assert.equal(response.status, 404, `${path} 不带 token 必须 404`);
      assert.equal(body.error, 'overlay.unknown-token', `${path} 的 404 原因应为 overlay.unknown-token`);
    }
    pass('E2E-3 面板静态资源免 token', `${checked.length} 个资源全部 200（${checked.join(' ')}），4 条数据路由仍 404`);
  } catch (error) {
    fail('E2E-3 面板静态资源免 token', error.message);
  } finally {
    await host.close();
  }
}

/**
 * 场景 4（t67）：右键菜单选的模式必须真的走到宿主 ——
 * 穿透（默认）时抓屏脚本带 `-Through`（隐藏 DSH），普通时不带（画面里保留 DSH 窗口）。
 */
async function scenarioCaptureMode() {
  const pageLog = join(workspace, 'page-mode.log');
  const host = await bootHost({
    scriptPath: stubCapturePath,
    outDir: workspace,
    keepTempFile: true,
    overlayLaunch: [process.execPath, standinPath, '${url}', 'cancel', resultPath, pageLog],
  });
  const observed = [];
  const stubLines = () => (existsSync(stubLogPath)
    ? readFileSync(stubLogPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('capture through='))
    : []);
  try {
    await runShot(host, 'through');
    observed.push(stubLines()[stubLines().length - 1]);
    await runShot(host, 'normal');
    observed.push(stubLines()[stubLines().length - 1]);
    assert.deepEqual(
      observed,
      ['capture through=True', 'capture through=False'],
      `抓屏模式没有跟着会话状态走：${JSON.stringify(observed)}`,
    );
    const pageLogText = await waitForFile(pageLog);
    assert.match(pageLogText, /mode=through/, '穿透会话的页面 URL 必须带 mode=through');
    assert.match(pageLogText, /mode=normal/, '普通会话的页面 URL 必须带 mode=normal');
    assert.ok(host.logs.some((line) => line.includes('requested normal')), '宿主日志要记下这次请求的是普通模式');
    pass('E2E-4 模式透传', '穿透 → 脚本带 -Through；普通 → 不带（两次都真实经过宿主与抓屏脚本），页面 URL 同步带 mode');
  } catch (error) {
    fail('E2E-4 模式透传', `${error.message}\n  stub: ${JSON.stringify(observed)}\n  host: ${host.logs.slice(-6).join(' | ')}`);
  } finally {
    rmSync(pageLog, { force: true });
    await host.close();
  }
}

/** 场景 5：老宿主（没有 overlay 路由）→ 真实 404 → 可见提示 + 回退 DSH 内流程。 */
async function scenarioLegacyHost() {
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = { base: `http://127.0.0.1:${server.address().port}`, logs: [] };
  const capturesBefore = clientCalls.captures.length;
  const runtime = await runShot(host, 'through', {
    poll: async () => {
      throw new Error('404 之后不该轮询');
    },
  });
  try {
    assert.equal(clientCalls.captures.length, capturesBefore + 1, '老宿主必须回退到 DSH 内覆盖层流程');
    assert.equal(clientCalls.captures[clientCalls.captures.length - 1].through, true, '回退后的抓屏仍走 mode=through');
    assert.equal(runtime.toasts[0].kind, 'warn');
    assert.match(runtime.toasts[0].text, /独立截图面板不可用/);
    assert.match(runtime.toasts[0].text, /404/, '提示要带原因，便于排查宿主没重启');
    pass('E2E-5 老宿主回退', `真实 HTTP 404 → 可见提示「${runtime.toasts[0].text}」→ 回退 DSH 内流程（through=true）`);
  } catch (error) {
    fail('E2E-5 老宿主回退', error.message);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * 场景 6（t73）：右键菜单选的模式必须**记住**，DSH 重启后不用重选。
 *
 * 用同一份"插件配置"启动两次宿主（第二次就是重启后的样子）：
 *  1. 第一次启动：读到的模式 = 配置里的默认值；
 *  2. 客户端 POST 新选择 → 宿主把它交给 `ctx.settings.update`（设置页/插件管理写的是同一份配置）；
 *  3. 用**更新后的配置**再启动一次宿主 → 读回来仍是新选择。
 */
async function scenarioModePersistence() {
  const config = Config['~standard'].validate({ captureMode: MODE_THROUGH }).value;
  const writes = [];
  // 模拟 DSH 的 `ctx.settings`：写进配置对象（真机上它会落进 profile patch）。
  const settingsService = {
    update: async (ns, patch) => {
      writes.push({ ns, patch });
      if (patch.captureMode !== undefined) config.captureMode[Symbol.for('cosmokit.volatile.write')](patch.captureMode);
    },
  };
  const stateUrl = (base) => new URL(STATE_PATH, base);
  let first;
  let second;
  try {
    first = await bootHost({ keepTempFile: true, settings: settingsService, config });
    const before = await (await fetch(stateUrl(first.base))).json();
    assert.equal(before.captureMode, MODE_THROUGH, `初始模式应来自配置，实际 ${JSON.stringify(before)}`);

    const written = await (await fetch(stateUrl(first.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ captureMode: MODE_NORMAL }),
    })).json();
    assert.equal(written.persisted, true, `有设置服务时必须报告已持久化，实际 ${JSON.stringify(written)}`);
    assert.deepEqual(writes, [{ ns: 'dsh-screenshot-xn', patch: { captureMode: MODE_NORMAL } }], '必须写进行 id 对应的配置');
    assert.equal(config.captureMode.get(), MODE_NORMAL, '运行期的 volatile 值必须同步');

    // "重启"：同一份配置再起一次宿主，客户端启动时读回的就是上次的选择。
    second = await bootHost({ keepTempFile: true, settings: settingsService, config });
    const after = await (await fetch(stateUrl(second.base))).json();
    assert.equal(after.captureMode, MODE_NORMAL, `重启后必须仍是上次选的普通模式，实际 ${JSON.stringify(after)}`);
    pass('E2E-6 模式持久化', 'POST normal → 写进 ctx.settings(entry dsh-screenshot-xn) → 重新启动宿主后 GET 仍是 normal（=重启后不用重选）');
  } catch (error) {
    fail('E2E-6 模式持久化', `${error.message}\n  writes: ${JSON.stringify(writes)}\n  host: ${(second ?? first)?.logs.slice(-4).join(' | ') ?? ''}`);
  } finally {
    if (second !== undefined) await second.close();
    if (first !== undefined) await first.close();
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

if (!existsSync(POWERSHELL)) {
  console.error(`stub 抓屏脚本需要 PowerShell：${POWERSHELL} 不存在`);
  process.exit(2);
}

console.log(`workspace: ${workspace}`);
console.log(`frame PNG ${framePng.length} B, result PNG ${resultPng.length} B`);

try {
  await scenarioInsert();
  await scenarioCancel();
  await scenarioStaticAssets();
  await scenarioCaptureMode();
  await scenarioLegacyHost();
  await scenarioModePersistence();
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((result) => result.ok !== true);
console.log(`\n${results.length - failed.length}/${results.length} 场景通过`);
if (failed.length > 0) process.exit(1);
