/**
 * t75：区域识别 / 翻译 / 剪贴板三条**路由**的契约。
 *
 * 覆盖的层次（从外到内）：
 *  1. **门禁**：token 未知一律 404、非 POST 一律 405、坏 body 一律 400 —— 这三条是这一族
 *     路由与既有 overlay 数据路由共享的口径，新功能不许开一个更松的口子；
 *  2. **真实识别**：把 `tests/fixtures/ocr-sample.png` 发过去，断言拿回来的是**真文本**
 *     （走 `lib/ocr.ps1` + Windows.Media.Ocr + PowerShell 5.1 的整条链路，不打桩）；
 *  3. **翻译**：模型用替身（不联网、不花 token），断言提示词、清洗、以及每一种失败
 *     （没有 llm 服务 / 模型报错 / 超时 / 关掉）都有**自己的错误码**；
 *  4. **剪贴板**：真的写系统剪贴板并**在另一个进程里读回来**核对 —— 这是这套机制唯一的
 *     验收方式（写进去的东西在进程退出后还在不在，只有换个进程读才知道）。
 *
 * 会话怎么来：这三条路由排在 overlay 的 token 门之后（它们动的是用户的屏幕内容），所以
 * 测试要先有一个会话。这里用宿主既有的**离线 seam**：`scriptPath` 换成 stub 抓屏脚本
 * （产出确定性的一帧）、`overlayLaunch` 换成立刻退出的进程 —— 不抓真实屏幕、不起浏览器。
 * 会话结束后 token 在 `overlayRetainMs` 内仍然有效，正是为了让这种"面板已经走了、客户端还在取"
 * 的时序有确定的答案。
 *
 * 副作用说明：剪贴板那一条**会覆盖运行者的系统剪贴板**（写的是测试文本）。这是刻意的：
 * 不碰剪贴板就只能证明"路由回了 ok"，而回 ok 正是最容易假绿的那一层。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const host = await import(`file://${join(PACKAGE, 'index.js')}`);

const {
  apply,
  OVERLAY_PREFIX,
  OVERLAY_OCR_PATH,
  OVERLAY_TRANSLATE_PATH,
  OVERLAY_CLIPBOARD_PATH,
  OCR_SCRIPT,
  CLIPBOARD_SCRIPT,
} = host;

const IS_WINDOWS = process.platform === 'win32';
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HAS_POWERSHELL = IS_WINDOWS && existsSync(POWERSHELL);
const FIXTURE = join(HERE, 'fixtures', 'ocr-sample.png');

/** 这台机器装了哪些 OCR 语言包（没装就跳过真实识别那几条，而不是让套件在别的机器上红）。 */
function installedOcrLanguages() {
  if (!HAS_POWERSHELL) return [];
  const result = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(PACKAGE, OCR_SCRIPT), '-ListLanguages'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const match = /---JSON-BEGIN---([\s\S]*?)---JSON-END---/.exec(result.stdout ?? '');
  if (match === null) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed.available) ? parsed.available : [];
  } catch {
    return [];
  }
}

const LANGUAGES = installedOcrLanguages();
const HAS_OCR_ENGINE = LANGUAGES.length > 0;

// ── 一套共用的宿主：stub 抓屏 + 立刻退出的"浏览器" ────────────────────────────
const workspace = mkdtempSync(join(tmpdir(), 'dsh-ocr-routes-'));
const outDir = join(workspace, 'out');
const stubCapturePath = join(workspace, 'stub-capture.ps1');
const framePath = join(workspace, 'frame.png');

// 冻结帧就是那张 OCR 样本图：抓屏是 stub，识别是**真的**。
// 「每次运行都重新拷一份」不是多余的：宿主读完 `png_path` 就会把它删掉
// （`keepTempFile` 默认为 false），所以 stub 的帧文件是一次性的 —— 第二次 start 之前
// 必须重新落盘，否则会以 `capture.unreadable-png ... ENOENT` 失败。
const FIXTURE_FOR_PS = FIXTURE.replace(/\\/g, '\\\\');
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
if ($RestoreOnly) { exit 0 }
$frame = '${framePath.replace(/\\/g, '\\\\')}'
Copy-Item -LiteralPath '${FIXTURE_FOR_PS}' -Destination $frame -Force
$body = '{"ok":true,"through":"off","through_reason":null,"restore_ok":true,"hidden_ms":0,"png_path":"' + $frame + '","bitmap_width":720,"bitmap_height":120,"png_bytes":' + (Get-Item -LiteralPath $frame).Length + ',"elapsed_total_ms":9,"capture_bounds":{"x":0,"y":0,"width":720,"height":120},"virtual_screen":{"x":0,"y":0,"width":720,"height":120},"single_screen":true,"screen_count":1,"error":null}'
Write-Host '---JSON-BEGIN---'
Write-Host $body
Write-Host '---JSON-END---'
exit 0
`, 'utf8');

/** 一个"立刻就退出"的 kiosk 替身：`start` 只需要它被 spawn 出来。 */
const LAUNCH_STUB = [process.execPath, '-e', 'process.exit(0)'];

/**
 * 关掉一个测试用的 HTTP 服务。
 *
 * `closeAllConnections()` 不是可选项：`server.close()` 只停止接受新连接，**已经在池里的
 * keep-alive 连接会让它一直不回调** —— 表现为"所有用例都绿了，进程却不退出"。这是 `fetch`
 * （undici 连接池）与 node:http 的经典组合。
 * @param {import('node:http').Server} target - 要关掉的服务。
 * @returns {Promise<void>} 关完即 resolve。
 */
function stopServer(target) {
  return new Promise((resolvePromise) => {
    target.closeAllConnections?.();
    target.close(() => resolvePromise());
  });
}

let server = null;
let base = '';
let token = '';
const logs = [];

/**
 * 起一份宿主路由并开一个会话。
 * @param {object} overrides - 覆盖 resolveSettings 的配置（超时、开关）。
 * @returns {Promise<{base: string, token: string, logs: string[]}>}
 */
async function bootHost(overrides = {}) {
  const routes = [];
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
      info: (line) => logs.push(`info ${line}`),
      warn: (line) => logs.push(`warn ${line}`),
    },
    get: (name) => (name === 'webServer' ? webServer : overrides.services?.[name]),
    inject: (deps, callback) => callback(ctx, {}),
    effect: (fn) => fn(),
    on: () => () => {},
  };
  apply(ctx, {
    scriptPath: stubCapturePath,
    outDir,
    overlayLaunch: LAUNCH_STUB,
    // 会话活到测试结束：watchdog 的静默窗口上限是 5s，而保留窗口决定 token 还能用多久。
    overlayHeartbeatMs: 5_000,
    overlayRetainMs: 120_000,
    overlayTimeoutMs: 300_000,
    // 这组用例测的是 **Windows 脚本路径**（stub 脚本 + 错误码 + 超时），所以把引擎钉死在那里：
    // t77 的 `auto` 会在模型齐备时优先走 ONNX（并且会按需下载模型），那既不是本用例的被测对象，
    // 也会让单测依赖网络与 31MB 模型。ONNX 引擎自己的用例在 tests/ocr-onnx-engine.test.mjs。
    ocrEngine: 'windows',
    ...overrides.config,
  });
  const prefixRoute = routes.find((route) => route.kind === 'prefix' && route.path === OVERLAY_PREFIX);
  assert.ok(prefixRoute !== undefined, `必须注册 overlay 前缀路由（${OVERLAY_PREFIX}）`);
  const local = createServer((req, res) => prefixRoute.handler(req, res));
  await new Promise((resolvePromise) => local.listen(0, '127.0.0.1', resolvePromise));
  const origin = `http://127.0.0.1:${local.address().port}`;
  try {
    const started = await fetch(new URL('/api/dsh-screenshot/overlay/start?mode=normal', origin), { method: 'POST' });
    const startBody = await started.json();
    assert.equal(startBody.ok, true, `会话必须能起来: ${JSON.stringify(startBody)}`);
    return { base: origin, token: startBody.token, close: () => stopServer(local) };
  } catch (error) {
    // 起不来就当场把服务关掉再抛：漏一个 listening 的 server 会让整个测试进程在
    // 所有用例结束后仍然不退出（而且报错信息看起来跟挂住毫无关系）。
    await stopServer(local);
    throw error;
  }
}

/** 发一次 JSON 请求。 */
async function post(path, body, tokenOverride = token) {
  const url = new URL(path, base);
  if (tokenOverride !== null) url.searchParams.set('token', tokenOverride);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

/** 发一次任意方法的请求。 */
async function send(method, path, tokenOverride = token) {
  const url = new URL(path, base);
  if (tokenOverride !== null) url.searchParams.set('token', tokenOverride);
  const response = await fetch(url, { method });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

function dataUrlOfPNG() {
  return `data:image/png;base64,${readFileSync(FIXTURE).toString('base64')}`;
}

before(async () => {
  const booted = await bootHost();
  server = booted.close;
  base = booted.base;
  token = booted.token;
});

after(async () => {
  if (server !== null) await server();
  rmSync(workspace, { recursive: true, force: true });
});

// ── 1. 门禁（与既有 overlay 数据路由同一口径）────────────────────────────────

test('(t75-13) all three text routes sit behind the overlay token gate', async () => {
  for (const path of [OVERLAY_OCR_PATH, OVERLAY_TRANSLATE_PATH, OVERLAY_CLIPBOARD_PATH]) {
    const missing = await post(path, { png: dataUrlOfPNG(), text: 'hi' }, null);
    assert.equal(missing.status, 404, `${path} 不带 token 必须 404`);
    assert.equal(missing.body?.error, 'overlay.unknown-token');
    const wrong = await post(path, { png: dataUrlOfPNG(), text: 'hi' }, 'deadbeef');
    assert.equal(wrong.status, 404, `${path} 带错 token 必须 404`);
    assert.equal(wrong.body?.error, 'overlay.unknown-token');
  }
});

test('(t75-14) all three text routes accept POST only', async () => {
  for (const path of [OVERLAY_OCR_PATH, OVERLAY_TRANSLATE_PATH, OVERLAY_CLIPBOARD_PATH]) {
    const answer = await send('GET', path);
    assert.equal(answer.status, 405, `${path} 的 GET 必须 405`);
    assert.equal(answer.body?.error, 'method.not_allowed');
  }
});

test('(t75-15) a body that is not a JSON object, or carries no payload, is a readable 400', async () => {
  const notJson = await post(OVERLAY_OCR_PATH, 'not json at all');
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body?.error, 'ocr.bad-body');

  const noImage = await post(OVERLAY_OCR_PATH, { language: 'zh-Hans-CN' });
  assert.equal(noImage.status, 400, '没有图必须 400，不许拿一个空 buffer 去喂引擎');
  assert.equal(noImage.body?.error, 'ocr.bad-body');

  const noText = await post(OVERLAY_TRANSLATE_PATH, { target: 'en' });
  assert.equal(noText.status, 400);
  assert.equal(noText.body?.error, 'translate.bad-body');

  const blankText = await post(OVERLAY_TRANSLATE_PATH, { text: '   \n  ' });
  assert.equal(blankText.status, 400, '只有空白等于没有文字');

  const emptyCopy = await post(OVERLAY_CLIPBOARD_PATH, {});
  assert.equal(emptyCopy.status, 400);
  assert.equal(emptyCopy.body?.error, 'clipboard.bad-body');
});

// ── 2. 真实识别（整条链路不打桩）────────────────────────────────────────────

test('(t75-16) OCR reads the real text out of a region PNG', { skip: !HAS_OCR_ENGINE && `no OCR language pack installed (${LANGUAGES.join(', ') || 'none'})` }, async () => {
  assert.ok(existsSync(FIXTURE), `缺少测试图片 ${FIXTURE}`);
  const answer = await post(OVERLAY_OCR_PATH, { png: dataUrlOfPNG() });
  assert.equal(answer.status, 200, `识别必须成功: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.empty, false);
  assert.ok(LANGUAGES.includes(answer.body.language), `报告的语言必须是本机装了的: ${answer.body.language}`);
  // 样本图上是「你好，世界 DSH Screenshot OCR 12345」。
  assert.match(answer.body.text, /你好/, `识别结果里应有中文: ${JSON.stringify(answer.body.text)}`);
  assert.match(answer.body.text, /世界/);
  assert.match(answer.body.text, /Screenshot/);
  assert.match(answer.body.text, /12345/);
  // 中文词之间不许有引擎塞进来的空格（那份空格会被用户直接粘走）。
  assert.equal(/[\u4E00-\u9FFF]\s+[\u4E00-\u9FFF]/.test(answer.body.text), false, `中文之间不该有空格: ${JSON.stringify(answer.body.text)}`);
  assert.ok(Array.isArray(answer.body.lines) && answer.body.lines.length >= 1, '要带行结构（面板据此显示"几行"）');
  assert.ok(answer.body.lines[0].words.length >= 4, '要带词框（下游定位用）');
  assert.equal(typeof answer.body.elapsedMs, 'number');
});

test('(t75-17) the region PNG is staged in a temp file and removed again', { skip: !HAS_OCR_ENGINE && 'no OCR language pack' }, async () => {
  const answer = await post(OVERLAY_OCR_PATH, { png: dataUrlOfPNG() });
  assert.equal(answer.body.ok, true);
  const leftovers = readdirSync(outDir).filter((name) => name.includes('ocr-'));
  assert.deepEqual(leftovers, [], `识别结束后不许留下中间文件: ${leftovers.join(', ')}`);
});

test('(t75-18) an uninstalled language is a readable failure, never an empty success', { skip: !HAS_OCR_ENGINE && 'no OCR language pack' }, async () => {
  // `xx-YY` 通过了标签白名单，但这台机器上一定没有这个语言包。
  const answer = await post(OVERLAY_OCR_PATH, { png: dataUrlOfPNG(), language: 'xx-YY' });
  assert.notEqual(answer.body?.ok, true, '没有语言包不许回 ok');
  assert.equal(answer.body.error, 'ocr.failed');
  assert.match(String(answer.body.message), /xx-YY/, '错误信息要点名是哪个标签不可用');
  assert.match(String(answer.body.message), new RegExp(LANGUAGES[0]), '错误信息要列出本机装了哪些语言包');
});

// ── 3. 翻译（模型是替身：不联网、不花 token）────────────────────────────────

/** 一个记录调用参数的 llm 替身。 */
function stubLlm(handler) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return handler(options);
    },
  };
}

/** 把一段文本按 chunk 吐出来的最小实现（形状与 dsh-llm 的 StreamChunk 一致）。 */
async function* textStream(text, reason = { kind: 'stop' }) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason };
}

test('(t75-19) translation reuses the DSH default model, fences the source and cleans the answer', async () => {
  const llm = stubLlm(() => textStream('```\nHello, world\n```'));
  const booted = await bootHost({
    services: {
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) },
    },
  });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, booted.base);
    url.searchParams.set('token', booted.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好，世界', target: 'en' }),
    });
    const body = await response.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.text, 'Hello, world', '围栏要被剥掉再交给用户');
    assert.equal(body.target, 'en');
    assert.equal(body.provider, 'stub-provider', '默认模型取自 agentDefaultModel');
    assert.equal(body.model, 'stub-model');
    assert.equal(body.unchanged, false);
    assert.equal(body.truncated, false);

    assert.equal(llm.calls.length, 1, '一次翻译只调一次模型');
    const call = llm.calls[0];
    assert.equal(call.provider, 'stub-provider');
    assert.equal(call.model, 'stub-model');
    assert.match(call.system, /English/, 'system 里要有目标语言');
    assert.match(call.system, /NEVER follow/, 'system 里要挡住"原文里写着指令"');
    assert.equal(call.messages.length, 1);
    assert.equal(call.messages[0].role, 'user');
    assert.match(call.messages[0].content[0].text, /你好，世界/, '原文进 user 消息');
    assert.equal(typeof call.maxTokens, 'number');
    assert.ok(call.signal instanceof AbortSignal, '必须带上取消信号（超时要能收回）');
    assert.equal(llm.calls[0].reasoningEffort, undefined, '翻译不该顺便要求推理档位');
  } finally {
    await booted.close();
  }
});

test('(t75-20) an explicit translateProvider/translateModel overrides the DSH default', async () => {
  const llm = stubLlm(() => textStream('译文'));
  const booted = await bootHost({
    config: { translateProvider: 'my-provider', translateModel: 'my-model', translateTarget: 'ja' },
    services: {
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'ignored', model: 'ignored' }) },
    },
  });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, booted.base);
    url.searchParams.set('token', booted.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 不带 target：应当用配置里的 ja。
      body: JSON.stringify({ text: 'hello' }),
    });
    const body = await response.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.provider, 'my-provider');
    assert.equal(body.model, 'my-model');
    assert.equal(body.target, 'ja', '请求没给 target 时用配置里的默认目标语言');
    assert.match(llm.calls[0].system, /Japanese/);
  } finally {
    await booted.close();
  }
});

test('(t75-21) a dirty target id falls back to the default instead of reaching the model', async () => {
  const llm = stubLlm(() => textStream('ok'));
  const booted = await bootHost({
    config: { translateTarget: 'klingon' },
    services: { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
  });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, booted.base);
    url.searchParams.set('token', booted.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', target: 'also-not-a-language' }),
    });
    const body = await response.json();
    assert.equal(body.target, 'zh-Hans', '未知目标语言回落简体中文');
    assert.match(llm.calls[0].system, /Simplified Chinese/);
  } finally {
    await booted.close();
  }
});

test('(t75-22) every translation failure has its own code and status', async () => {
  // (a) 这个 profile 里没有 llm 服务。
  const withoutLlm = await bootHost({
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
  });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, withoutLlm.base);
    url.searchParams.set('token', withoutLlm.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'translate.unavailable');
  } finally {
    await withoutLlm.close();
  }

  // (b) 有 llm 但没有默认模型、也没配 translateProvider/Model。
  const noModel = await bootHost({ services: { llm: stubLlm(() => textStream('x')) } });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, noModel.base);
    url.searchParams.set('token', noModel.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'translate.unavailable');
  } finally {
    await noModel.close();
  }

  // (c) 模型自己报错（终态 finish chunk）。
  const failing = await bootHost({
    services: {
      llm: stubLlm(() => textStream('', { kind: 'error', failure: { message: 'upstream 500', code: 'server' } })),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, failing.base);
    url.searchParams.set('token', failing.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'translate.failed');
    assert.match(body.message, /upstream 500/, '模型的错误信息要带给用户');
  } finally {
    await failing.close();
  }

  // (d) 模型不回话 → 由自己的截止时间收回（不是永远挂着）。
  const hanging = await bootHost({
    config: { translateTimeoutMs: 300 },
    services: {
      llm: stubLlm((options) => (async function* () {
        // 永不主动产出：只有外部 abort 能结束它 —— 这就是"模型挂了"的形态。
        await new Promise((resolvePromise) => {
          options.signal.addEventListener('abort', resolvePromise, { once: true });
        });
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'aborted' } } };
      })()),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, hanging.base);
    url.searchParams.set('token', hanging.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 504, '超时必须是自己的错误码');
    assert.equal((await response.json()).error, 'translate.timeout');
  } finally {
    await hanging.close();
  }
});

test('(t75-23) an empty model answer is a failure, not an empty translation', async () => {
  const booted = await bootHost({
    services: {
      llm: stubLlm(() => textStream('   \n  ')),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, booted.base);
    url.searchParams.set('token', booted.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'translate.failed');
    assert.match(body.message, /returned no text/);
  } finally {
    await booted.close();
  }
});

test('(t75-24) "the model echoed the source" is reported, not hidden', async () => {
  const booted = await bootHost({
    services: {
      llm: stubLlm(() => textStream('你好，世界')),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  });
  try {
    const url = new URL(OVERLAY_TRANSLATE_PATH, booted.base);
    url.searchParams.set('token', booted.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好，世界' }),
    });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.unchanged, true, '原文与译文相同时要如实上报（界面显示"与原文一致"）');
  } finally {
    await booted.close();
  }
});

// ── 4. 开关、超时与"没有脚本"────────────────────────────────────────────────

test('(t75-25) both features can be switched off in config, with their own codes', { skip: !HAS_OCR_ENGINE && 'no OCR language pack' }, async () => {
  const booted = await bootHost({ config: { ocrEnabled: false, translateEnabled: false } });
  try {
    const ocrUrl = new URL(OVERLAY_OCR_PATH, booted.base);
    ocrUrl.searchParams.set('token', booted.token);
    const ocrResponse = await fetch(ocrUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ png: dataUrlOfPNG() }),
    });
    assert.equal(ocrResponse.status, 503);
    assert.equal((await ocrResponse.json()).error, 'ocr.disabled');

    const translateUrl = new URL(OVERLAY_TRANSLATE_PATH, booted.base);
    translateUrl.searchParams.set('token', booted.token);
    const translateResponse = await fetch(translateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(translateResponse.status, 503);
    assert.equal((await translateResponse.json()).error, 'translate.disabled');
  } finally {
    await booted.close();
  }
});

test('(t75-26) a recognition that never returns is cut off by its own deadline', { skip: !HAS_OCR_ENGINE && 'no OCR language pack' }, async () => {
  const booted = await bootHost({ config: { ocrTimeoutMs: 1 } });
  try {
    const url = new URL(OVERLAY_OCR_PATH, booted.base);
    url.searchParams.set('token', booted.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ png: dataUrlOfPNG() }),
    });
    assert.equal(response.status, 504, '超时要与"识别失败"分开报');
    assert.equal((await response.json()).error, 'ocr.timeout');
    // 超时同样不许留下中间文件。
    const leftovers = readdirSync(outDir).filter((name) => name.includes('ocr-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await booted.close();
  }
});

test('(t75-27) a missing OCR script is reported as unavailable, not as a crash', async () => {
  const booted = await bootHost({ config: { ocrScriptPath: join(workspace, 'does-not-exist.ps1') } });
  try {
    const url = new URL(OVERLAY_OCR_PATH, booted.base);
    url.searchParams.set('token', booted.token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ png: dataUrlOfPNG() }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'ocr.unavailable');
  } finally {
    await booted.close();
  }
});

// ── 5. 剪贴板：真的写、并且**换个进程**读回来核对 ─────────────────────────────

test('(t75-28) the clipboard route really owns the system clipboard after it returns', { skip: !HAS_POWERSHELL && 'Windows PowerShell 5.1 is required' }, async () => {
  assert.ok(existsSync(join(PACKAGE, CLIPBOARD_SCRIPT)), `缺少 ${CLIPBOARD_SCRIPT}`);
  const sample = 'DSH 截图识别 t75 · clipboard "quoted" & <tags>\nsecond line';
  const answer = await post(OVERLAY_CLIPBOARD_PATH, { text: sample });
  assert.equal(answer.status, 200, `写剪贴板必须成功: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.chars, sample.length);

  // 换一个进程读：本进程里读只能证明变量还在，证明不了进程退出后剪贴板还是我们的。
  const read = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const back = (read.stdout ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  assert.equal(back, sample, '剪贴板内容必须与提交的文本逐字一致（含 CJK、引号、换行）');

  const leftovers = readdirSync(outDir).filter((name) => name.includes('clip-'));
  assert.deepEqual(leftovers, [], '写完之后不许留下中间文本文件');
});
