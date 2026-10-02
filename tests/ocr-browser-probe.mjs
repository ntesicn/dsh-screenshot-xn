/**
 * t75 端到端复跑：**真浏览器**里的面板 × **真实宿主路由** × **真实 Windows OCR**。
 *
 * 与另外两个脚本的分工：
 *   - `tests/ocr-routes.test.mjs`：路由层的契约（门禁/错误码/真实识别/剪贴板），不起浏览器；
 *   - `tests/overlay-browser-probe.mjs`：面板的**既有**能力（帧/心跳/工具栏/标注拖动）；
 *   - 本脚本：把两端接起来，专门验 t75 这一条链路能走通 ——
 *     框选 → 点「识别」→ 卡片出**真文字**（走 lib/ocr.ps1 + Windows.Media.Ocr）→
 *     点「翻译」→ 译文出现（模型是替身：不联网、不花 token）→ 点「复制」→ 宿主真的写了剪贴板。
 *
 * 刻意用**真浏览器**而不是直接调页面函数：这一功能的价值全在"点一下按钮会发生什么"，
 * 而卡片的定位、`isChromeTarget` 的排除、下拉框的重译、Esc 的先后顺序都只在真实事件流里
 * 才成立。模型打桩是因为它不属于本插件的代码 —— 它与宿主之间那条缝由 `ctx.llm.stream`
 * 的调用契约钉住（见 ocr-routes.test.mjs 的 t75-19）。
 *
 * 没有 Edge/Chrome 或没有 OCR 语言包的机器会打印 `[SKIP]` 并以 0 退出。
 *
 * 用法：`node tests/ocr-browser-probe.mjs`（`DSH_KEEP=1` 保留工作目录与截图）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const { apply, OVERLAY_PREFIX, OCR_SCRIPT } = await import(pathToFileURL(join(PACKAGE, 'index.js')).href);

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (browser === undefined || process.platform !== 'win32' || !existsSync(POWERSHELL)) {
  console.log(`[SKIP] t75 端到端需要 Windows + Edge/Chrome + Windows PowerShell（browser=${browser ?? 'none'}）`);
  process.exit(0);
}

/** 这台机器装了哪些 OCR 语言包：没有就跳过（而不是让脚本在别的机器上红）。 */
function installedOcrLanguages() {
  const result = spawn(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(PACKAGE, OCR_SCRIPT), '-ListLanguages'],
    { encoding: 'buffer', windowsHide: true },
  );
  return new Promise((resolve) => {
    let out = '';
    result.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    result.on('close', () => {
      const match = /---JSON-BEGIN---([\s\S]*?)---JSON-END---/.exec(out);
      if (match === null) return resolve([]);
      try {
        const parsed = JSON.parse(match[1]);
        return resolve(Array.isArray(parsed.available) ? parsed.available : []);
      } catch {
        return resolve([]);
      }
    });
  });
}

const LANGUAGES = await installedOcrLanguages();
if (LANGUAGES.length === 0) {
  console.log('[SKIP] t75 端到端需要至少一个 Windows OCR 语言包（设置 → 时间和语言 → 语言）');
  process.exit(0);
}

// ── 工作目录与"抓屏"帧 ──────────────────────────────────────────────────────
// 冻结帧是**按视口尺寸合成**的一张图：白底 + 左上角原样贴上 OCR 样本图。
//
// 为什么必须让帧与视口一样大：面板把选区映射到冻结帧用的是**单一比例**
// `mean(帧宽/视口宽, 帧高/视口高)`（lib/capture-plan.mjs 的 effectiveScale）。帧是 720×120
// 而视口是 800×600 时这个比例被高度那一路拖到 0.55，于是视口整宽只能覆盖 440 设备像素 ——
// 连样本图那行字（720 宽）都框不全，识别结果自然被截断（实测只出 "DSH Screensh"）。
// 真机上 kiosk 满屏 + 100% 缩放时帧与视口本来就相等（比例 = 1，CSS 坐标 = 屏幕坐标），
// 所以这样合成反而**更贴近真实**，而不是绕开问题。
const VIEWPORT = { width: 800, height: 600 };
const FIXTURE = join(HERE, 'fixtures', 'ocr-sample.png');
const workspace = mkdtempSync(join(tmpdir(), 'dsh-ocr-browser-'));
const framePath = join(workspace, 'frame.png');
const frameSourcePath = join(workspace, 'frame-source.png');
const stubCapturePath = join(workspace, 'stub-capture.ps1');

/** 合成冻结帧（白底 + 样本图原样贴在左上角，字号不变，识别精度不受影响）。 */
function composeFrame() {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile('${FIXTURE.replace(/\\/g, '\\\\')}')`,
    `$bmp = New-Object System.Drawing.Bitmap(${VIEWPORT.width}, ${VIEWPORT.height})`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::White)',
    '$g.DrawImage($src, 0, 0, $src.Width, $src.Height)',
    '$g.Dispose()',
    `$bmp.Save('${frameSourcePath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()',
    '$src.Dispose()',
  ].join('\n');
  const scriptPath = join(workspace, 'compose-frame.ps1');
  writeFileSync(scriptPath, script, 'utf8');
  const done = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    done.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`合成帧失败（exit ${code}）`))));
  });
}

await composeFrame();

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
Copy-Item -LiteralPath '${frameSourcePath.replace(/\\/g, '\\\\')}' -Destination $frame -Force
$body = '{"ok":true,"through":"off","through_reason":null,"restore_ok":true,"hidden_ms":0,"png_path":"' + $frame + '","bitmap_width":${VIEWPORT.width},"bitmap_height":${VIEWPORT.height},"png_bytes":' + (Get-Item -LiteralPath $frame).Length + ',"elapsed_total_ms":9,"capture_bounds":{"x":0,"y":0,"width":${VIEWPORT.width},"height":${VIEWPORT.height}},"virtual_screen":{"x":0,"y":0,"width":${VIEWPORT.width},"height":${VIEWPORT.height}},"single_screen":true,"screen_count":1,"error":null}'
Write-Host '---JSON-BEGIN---'
Write-Host $body
Write-Host '---JSON-END---'
exit 0
`, 'utf8');

const FRAME_SIZE = VIEWPORT;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 找一个空闲端口给 CDP 用。 */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** 开一个 CDP 会话（真浏览器 + 调试端口）。与 overlay-browser-probe.mjs 同一套路。 */
async function openCdp(pageUrl, timeoutMs = 30_000) {
  const port = await freePort();
  const profile = join(workspace, `cdp-${port}`);
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--window-size=800,600',
    pageUrl,
  ], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + timeoutMs;
  let target;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((entry) => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string');
      if (target !== undefined) break;
    } catch {
      /* 调试端口还没起来 */
    }
    await sleep(300);
  }
  if (target === undefined) {
    try { child.kill(); } catch { /* 已经退出 */ }
    throw new Error('DevTools 调试端口没就绪');
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  let id = 0;
  /**
   * 页面 `console.log` 的轨迹。
   *
   * 这是本探针唯一的"飞行记录仪"：`window.__t75` 只在页面活着的时候读得到，而这一步的流程
   * 里**真有**一条会把窗口关掉的路径（卡片没开时按 Esc = 取消整次截图）。把每步进度同时
   * `console.log` 出来、由 CDP 事件通道实时收在 Node 侧，页面没了也照样能定位到卡在哪一步。
   */
  const consoleTrail = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    const current = id;
    const timer = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 20_000);
    const onMessage = (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : '');
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params?.args ?? [])
          .map((argument) => (typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value)))
          .join(' ');
        if (text.includes('[t75]')) consoleTrail.push(text);
        return;
      }
      if (message.id !== current) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (message.error !== undefined) reject(new Error(`CDP ${method} 失败: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  await send('Runtime.enable');
  return {
    send,
    consoleTrail,
    close: async () => {
      try { socket.close(); } catch { /* 已经关了 */ }
      try { child.kill(); } catch { /* 已经退出 */ }
      await sleep(200);
    },
  };
}

// ── 宿主（真实路由 + 替身模型）──────────────────────────────────────────────
const hostLogs = [];
const llmCalls = [];

/** 每次调用返回一段可辨认的"译文"，并记下参数供断言。 */
function stubLlm(options) {
  llmCalls.push(options);
  const label = /Japanese/.test(options.system) ? 'JA' : /English/.test(options.system) ? 'EN' : 'ZH';
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: `[${label}] Hello, world` };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `[${label}] Hello, world` } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

async function bootHost() {
  const routes = [];
  const webServer = {
    port: 0,
    host: '127.0.0.1',
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const services = {
    llm: { stream: stubLlm },
    agentDefaultModel: { currentSelection: () => ({ provider: 'probe-provider', model: 'probe-model' }) },
  };
  const ctx = {
    logger: {
      debug() {},
      info: (line) => hostLogs.push(`info ${line}`),
      warn: (line) => hostLogs.push(`warn ${line}`),
    },
    get: (name) => (name === 'webServer' ? webServer : services[name]),
    inject: (deps, callback) => callback(ctx, {}),
    effect: (fn) => fn(),
  };
  apply(ctx, {
    scriptPath: stubCapturePath,
    outDir: workspace,
    keepTempFile: true,
    overlayHeartbeatMs: 5_000,
    overlayRetainMs: 120_000,
    overlayTimeoutMs: 300_000,
    // 面板的 URL 由宿主自己拼（overlayLaunch 里用 ${url} 占位）。
    overlayLaunch: [browser, '--headless=new', '--disable-gpu', '--no-first-run', '${url}'],
  });
  const route = routes.find((entry) => entry.kind === 'prefix' && entry.path === OVERLAY_PREFIX);
  assert.ok(route !== undefined, 'overlay 路由族必须注册');
  const server = createServer((req, res) => route.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  webServer.port = server.address().port;
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ── 页面里的探测脚本 ────────────────────────────────────────────────────────

/**
 * 三块**设备像素**选区。帧与视口一样大（见上面的合成说明），所以设备坐标 = CSS 坐标；
 * 探测脚本仍然用页面自报的映射反推一次（比例应当是 1，不是 1 就直接暴露出来）。
 * 样本图贴在左上角：文字占 x 26..682、y 44..79。
 */
const TEXT_REGION = { x: 8, y: 24, width: 712, height: 76 };
const SMALL_REGION = { x: 20, y: 35, width: 400, height: 60 };
/** 文字到 x=682 为止：700 往右是留白，用来验"没识别到文字"。 */
const BLANK_REGION = { x: 700, y: 4, width: 92, height: 112 };

/**
 * 框选、点识别、点翻译、点复制 —— 走真实按钮与真实事件。
 *
 * 选区的造法与 `overlay-browser-probe.mjs` 一致（直接写 `state.selection` + resize，
 * 让 `layout()/schedule()` 把它画出来）：合成 pointerdown/move/up 在 headless 里造出的
 * "框选"并不稳定，而**框选本身**已由 B-5 与既有 e2e 覆盖。真正属于 t75 的交互
 * —— 点按钮、卡片里的指针、改选区后失效、Esc 的顺序 —— 全部用真实事件触发。
 */
const FLOW_PROBE = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (id) => document.getElementById(id);
  const buttonByTitle = (pattern) => [...document.querySelectorAll('#group-actions button')]
    .find((element) => pattern.test(element.title ?? ''));
  // chrome 的重绘是 **RAF 调度**的（overlay.js 的 schedule/paintChrome）：改完状态必须让出两帧
  // 再读 DOM，否则读到的还是上一帧（第一次跑这个探针就栽在这里：选区在、工具栏还没显示）。
  const nextFrame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  /**
   * 发一个合成指针事件。
   *
   * **目标取该点最上层的真实元素**（elementFromPoint），不是 document：面板的
   * isChromeTarget(event.target) 用 closest('#toolbar, #editor, #ocr-card') 判断"按在了 chrome 上"，
   * 而 document 没有 closest —— 往 document 上发事件等于绕过了这道判断，测出来的是
   * 假象（第一次跑就因此报"在卡片里按指针改了选区"）。真实浏览器里的 target 就是那个元素。
   */
  const fire = (type, x, y) => {
    const target = document.elementFromPoint(x, y) ?? document;
    target.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      bubbles: true, cancelable: true,
    }));
  };
  const waitFor = async (predicate, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(80);
    }
    return null;
  };
  const selectRegion = async (rect) => {
    window.__overlay.state.selection = { ...rect };
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
  };
  /**
   * 按**设备像素**选一块区域：用页面自报的映射反推 CSS 坐标，再夹进视口。
   *
   * 夹进视口不是锦上添花：lib 的 planRender 对越过画面的选区判 clipped，而
   * planOrCancel() 会**取消整次截图**（既有语义）。夹过之后画出来的就是"设备上确实存在
   * 的那部分"，这也是真实用户能画出来的选区。
   */
  const selectDeviceRegion = async (device) => {
    // 用**当下**的视口与画布尺寸算比例，不用 boot 时那份快照（页面刚开始布局时的视口
    // 可能还不是最终尺寸 —— 第一次跑这个探针就是被快照里的 776×171.8 误导的）。
    const base = document.getElementById('base');
    const view = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const scale = (base.width / view.width + base.height / view.height) / 2;
    const css = {
      x: Math.max(0, device.x / scale),
      y: Math.max(0, device.y / scale),
      width: device.width / scale,
      height: device.height / scale,
    };
    css.width = Math.max(1, Math.min(css.width, view.width - css.x));
    css.height = Math.max(1, Math.min(css.height, view.height - css.y));
    await selectRegion(css);
    return { scale, view, bitmap: { width: base.width, height: base.height }, css };
  };
  /**
   * 等按钮**可用**再点。
   *
   * 识别/翻译进行中这两个按钮是 disabled（overlay.js 的 refreshToolbar），此时点它会被
   * state.textBusy 守卫直接吞掉 —— 真实用户点不到，但程序化点击会点得到。第一次跑这个
   * 探针就是在这里失去同步的：上一步的请求还没收尾就点了下一步，卡片一直没开，
   * 最后 Esc 落到"卡片没开"的分支里，把整次截图取消了。
   */
  const clickWhenReady = async (pattern) => {
    const button = await waitFor(() => {
      const found = buttonByTitle(pattern);
      return found !== undefined && found.disabled !== true ? found : null;
    });
    if (button === null) return false;
    button.click();
    return true;
  };
  const result = { steps: [] };
  // 进度挂在 window 上（同页可读）**并且**打到控制台（页面关了也留得住，见 openCdp）。
  window.__t75 = result;
  const step = (name, value) => {
    result.steps.push(name);
    result[name] = value;
    try { console.log('[t75] ' + name + ' = ' + JSON.stringify(value)); } catch { /* 忽略 */ }
    return value;
  };

  // ① 等页面就绪
  step('ready', (await waitFor(() => window.__overlayState === 'ready')) === true);
  result.ready = result.ready;
  if (!result.ready) return result;

  // ② 选区覆盖整帧（视口 800×600 ↔ 帧 720×120，页面是整屏 1:1 映射）
  step('mapping', (await selectDeviceRegion(${JSON.stringify(TEXT_REGION)})).css);
  result.selection = window.__overlay.state.selection;
  step('toolbarVisible', $('toolbar').offsetWidth > 0);
  result.ocrButtonFound = buttonByTitle(/识别文字/) !== undefined;
  result.translateButtonFound = buttonByTitle(/翻译/) !== undefined;
  if (!result.selection || !result.toolbarVisible) return result;

  // ③ 点「识别」→ 卡片出真文字
  step('clickedOcr', await clickWhenReady(/识别文字/));
  const sourceText = await waitFor(() => {
    const element = $('ocr-source-text');
    return element.textContent.trim() !== '' ? element.textContent : null;
  });
  result.cardVisible = $('ocr-card').hidden !== true && $('ocr-card').offsetWidth > 0;
  step('sourceText', sourceText);
  result.sourceMeta = $('ocr-source-meta').textContent;
  result.targetHiddenAfterOcr = $('ocr-target-block').hidden === true;
  result.cardRect = (() => {
    const box = $('ocr-card').getBoundingClientRect();
    return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
  })();
  if (sourceText === null) return result;

  // ④ 点「翻译」→ 译文出现（模型是替身）
  step('clickedTranslate', await clickWhenReady(/翻译/));
  const targetText = await waitFor(() => {
    const element = $('ocr-target-text');
    return element.textContent.trim() !== '' ? element.textContent : null;
  });
  step('translation', targetText);
  result.targetMeta = $('ocr-target-meta').textContent;
  result.targetVisible = $('ocr-target-block').hidden !== true;
  if (targetText === null) return result;

  // ⑤ 换目标语言 → 只重发翻译（不重新识别）
  const select = $('ocr-target-select');
  result.selectOptions = [...select.options].map((option) => option.value);
  select.value = 'ja';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  step('retranslated', await waitFor(() => {
    const element = $('ocr-target-text');
    return element.textContent.startsWith('[JA]') ? element.textContent : null;
  }));

  // ⑥ 点「复制」→ 宿主真的写剪贴板（页面自己绝不碰剪贴板）
  $('ocr-copy-source').click();
  step('copyNotice', await waitFor(() => {
    const text = $('notice').textContent;
    return /已复制/.test(text) ? text : null;
  }));

  // ⑦ 在卡片内部按下指针：不许拖出一个新选区（卡片是 chrome）
  const before = JSON.stringify(window.__overlay.state.selection);
  const box = $('ocr-card').getBoundingClientRect();
  fire('pointerdown', Math.round(box.left + 12), Math.round(box.top + 12));
  fire('pointermove', Math.round(box.left + 90), Math.round(box.top + 60));
  fire('pointerup', Math.round(box.left + 90), Math.round(box.top + 60));
  await nextFrame();
  step('selectionUnchangedByCard', JSON.stringify(window.__overlay.state.selection) === before);
  result.cardStillVisibleAfterCardPress = $('ocr-card').hidden !== true;

  // ⑧ 改选区 → 卡片必须失效（旧文字不许留在屏幕上）
  await selectDeviceRegion(${JSON.stringify(SMALL_REGION)});
  step('cardHiddenAfterReselect', $('ocr-card').hidden === true);

  // ⑨ 框一块没有文字的区域（样本图右侧留白）→ 如实说"没识别到文字"，不是报错
  await selectDeviceRegion(${JSON.stringify(BLANK_REGION)});
  step('clickedOcrEmpty', await clickWhenReady(/识别文字/));
  step('emptyNotice', await waitFor(() => {
    const text = $('ocr-source-meta').textContent;
    return /没识别到文字/.test(text) ? text : null;
  }));

  // ⑩ Esc：卡片开着时第一下只关卡片，不取消整次截图。
  //    这一条必须**最后**做，而且必须先确认卡片真的开着：卡片没开时 Esc 会走"取消整次截图"
  //    的分支，窗口一关，这一轮探测的结果就再也读不回来了（第一次跑这里就栽在这上面）。
  await selectDeviceRegion(${JSON.stringify(SMALL_REGION)});
  step('clickedOcrForEscape', await clickWhenReady(/识别文字/));
  const cardOpen = await waitFor(() => ($('ocr-card').hidden !== true ? true : null), 8_000);
  step('cardOpenBeforeEscape', cardOpen);
  if (cardOpen !== true) return result;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);
  result.cardHiddenAfterEscape = $('ocr-card').hidden === true;
  result.stillAliveAfterEscape = window.__overlayState === 'ready';
  return result;
})()`;

// ── 主流程 ──────────────────────────────────────────────────────────────────
/**
 * 视觉留档用的一小段探测：重选文字区域 → 识别 → 翻译 → 回报卡片是否开着、译文是否已出现。
 * 与主探测分开是刻意的 —— 主探测里有一步（Esc）会把卡片收起来，而截图要在"卡片开着"的时候拍。
 */
const EVIDENCE_PROBE = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (id) => document.getElementById(id);
  const buttonByTitle = (pattern) => [...document.querySelectorAll('#group-actions button')]
    .find((element) => pattern.test(element.title ?? ''));
  const waitFor = async (predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(80);
    }
    return null;
  };
  window.__overlay.state.selection = ${JSON.stringify({ x: 8, y: 24, width: 712, height: 76 })};
  window.dispatchEvent(new Event('resize'));
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const clickWhenReady = async (pattern) => {
    const button = await waitFor(() => {
      const found = buttonByTitle(pattern);
      return found !== undefined && found.disabled !== true ? found : null;
    });
    if (button === null) return false;
    button.click();
    return true;
  };
  if (!(await clickWhenReady(/识别文字/))) return { cardOpen: false, reason: 'ocr-button' };
  await waitFor(() => ($('ocr-source-text').textContent.trim() !== '' ? true : null));
  if (!(await clickWhenReady(/翻译/))) return { cardOpen: $('ocr-card').hidden !== true, reason: 'translate-button' };
  await waitFor(() => ($('ocr-target-text').textContent.trim() !== '' ? true : null));
  return {
    cardOpen: $('ocr-card').hidden !== true,
    hasTranslation: $('ocr-target-text').textContent.trim() !== '',
    text: $('ocr-source-text').textContent,
    translation: $('ocr-target-text').textContent,
  };
})()`;

const results = [];
const pass = (name, detail) => { results.push(true); console.log(`[PASS] ${name} — ${detail}`); };
const fail = (name, detail) => { results.push(false); console.log(`[FAIL] ${name} — ${detail}`); };

/**
 * 按**宿主的方式**拼面板 URL。
 *
 * 与 `index.js` 的 `overlayUrl()` 逐字对应（token / mode / target / **ocr=1 能力戳**）：
 * `ocr=1` 不能省 —— 它是"新面板 + 旧宿主"那一课的直接产物，省掉它探针就会跑到
 * "宿主没重启"的分支上（按钮置灰），而不是真的测这条链路。
 * 两侧字面量的一致性由 `tests/ocr-panel.test.mjs` 的 t75-35 钉住。
 * @param {string} origin @param {string} token @returns {string}
 */
function panelUrl(origin, token, { stamp = true } = {}) {
  const url = new URL('/api/dsh-screenshot/overlay/page', origin);
  url.searchParams.set('token', token);
  url.searchParams.set('mode', 'normal');
  url.searchParams.set('target', 'zh-Hans');
  if (stamp) url.searchParams.set('ocr', '1');
  return url.href;
}

/** 等页面就绪（看门狗 4 s 会自己报错，给足时间）。 @param {any} session @returns {Promise<boolean>} */
async function waitReady(session) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const state = await session.send('Runtime.evaluate', { expression: 'window.__overlayState', returnByValue: true });
    if (state?.result?.value === 'ready') return true;
    await sleep(300);
  }
  return false;
}

const host = await bootHost();
const shotPath = join(workspace, 'ocr-card.png');
let session = null;
/** 探测结果在断言失败时要能打出来：没有它，一次失败就得重跑一轮才知道卡在哪一步。 */
let probed = null;
try {
  const started = await fetch(new URL('/api/dsh-screenshot/overlay/start?mode=normal', host.base), { method: 'POST' });
  const startBody = await started.json();
  assert.equal(startBody.ok, true, `会话必须能起来: ${JSON.stringify(startBody)}`);

  // ⓪ "新面板 + 旧宿主"（改完插件没重启 DSH）——**实测踩到过的组合**，所以单独钉一条：
  //    没有能力戳时两个按钮必须置灰、提示行必须说清是"重启 DSH Desktop"，而不是让用户
  //    点下去收到 404、再被通用文案说成"识别失败"。
  const staleSession = await openCdp(panelUrl(host.base, startBody.token, { stamp: false }));
  try {
    assert.equal(await waitReady(staleSession), true, '没有能力戳时页面仍应正常就绪');
    const stale = await staleSession.send('Runtime.evaluate', {
      expression: `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const $ = (id) => document.getElementById(id);
        const buttonByTitle = (pattern) => [...document.querySelectorAll('#group-actions button')]
          .find((element) => pattern.test(element.title ?? ''));
        window.__overlay.state.selection = { x: 8, y: 24, width: 712, height: 76 };
        window.dispatchEvent(new Event('resize'));
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        await sleep(200);
        const ocr = buttonByTitle(/识别文字/);
        const translate = buttonByTitle(/翻译/);
        return {
          toolbarVisible: $('toolbar').offsetWidth > 0,
          ocrDisabled: ocr?.disabled === true,
          translateDisabled: translate?.disabled === true,
          notice: $('notice').textContent,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const staleValue = stale?.result?.value ?? {};
    assert.equal(staleValue.toolbarVisible, true, '工具栏应当照常出现（其余功能不受影响）');
    assert.equal(staleValue.ocrDisabled, true, `主人没重启时「识别文字」必须置灰，实际 ${JSON.stringify(staleValue)}`);
    assert.equal(staleValue.translateDisabled, true, '宿主没重启时「翻译」必须置灰');
    assert.match(String(staleValue.notice ?? ''), /重启 DSH Desktop/, `提示行必须说清原因与动作，实际 ${JSON.stringify(staleValue.notice)}`);
    pass('T75-STALE 新面板 + 旧宿主', `没有能力戳 → 两个入口置灰，提示行：「${staleValue.notice}」`);
  } finally {
    await staleSession.close();
  }

  session = await openCdp(panelUrl(host.base, startBody.token));
  assert.equal(await waitReady(session), true, '面板页必须就绪');

  const probe = await session.send('Runtime.evaluate', { expression: FLOW_PROBE, returnByValue: true, awaitPromise: true });
  if (probe?.exceptionDetails !== undefined) {
    throw new Error(`流程探测抛错: ${JSON.stringify(probe.exceptionDetails.exception?.description ?? probe.exceptionDetails)}`);
  }
  const value = probe?.result?.value ?? {};
  probed = value;

  // ① 框选与两个新入口
  assert.equal(value.ready, true, '面板必须就绪');
  assert.equal(value.toolbarVisible, true, '框选后工具栏必须出现');
  assert.equal(value.ocrButtonFound, true, '动作区必须有「识别文字」图标按钮');
  assert.equal(value.translateButtonFound, true, '动作区必须有「翻译」图标按钮');

  // ② 识别：真文字，且中文之间没有引擎塞的空格
  assert.equal(typeof value.sourceText === 'string' && value.sourceText !== '', true, `识别必须出文字，实际 ${JSON.stringify(value.sourceText)}`);
  assert.match(value.sourceText, /你好/, `识别结果里应有中文: ${JSON.stringify(value.sourceText)}`);
  assert.match(value.sourceText, /12345/, `识别结果里应有英文数字: ${JSON.stringify(value.sourceText)}`);
  assert.equal(/[\u4E00-\u9FFF]\s+[\u4E00-\u9FFF]/.test(value.sourceText), false, `中文之间不该有空格: ${JSON.stringify(value.sourceText)}`);
  assert.equal(value.cardVisible, true, '识别后卡片必须可见');
  assert.match(value.sourceMeta ?? '', /zh-Hans-CN/, `卡片上要写明识别用的语言: ${JSON.stringify(value.sourceMeta)}`);
  assert.match(value.sourceMeta ?? '', /ms/, '卡片上要写明耗时');
  assert.equal(value.targetHiddenAfterOcr, true, '只点识别时不该出现译文块');

  // ③ 卡片位置：在视口内（不许被推出屏幕）
  assert.ok(value.cardRect.width > 200 && value.cardRect.height > 40, `卡片应有可读尺寸，实际 ${JSON.stringify(value.cardRect)}`);
  assert.ok(value.cardRect.left >= 0 && value.cardRect.top >= 0, `卡片不许跑到视口外，实际 ${JSON.stringify(value.cardRect)}`);

  // ④ 翻译：替身模型的输出 + 宿主报的 provider/model
  assert.equal(typeof value.translation === 'string' && value.translation !== '', true, `翻译必须出结果，实际 ${JSON.stringify(value.translation)}`);
  assert.match(value.translation, /Hello, world/, '译文来自（替身）模型');
  assert.equal(value.targetVisible, true, '翻译后译文块必须可见');
  assert.match(value.targetMeta ?? '', /probe-provider\/probe-model/, `卡片上要写明用的模型: ${JSON.stringify(value.targetMeta)}`);
  assert.match(value.sourceMeta ?? '', /ms/, '卡片上要写明耗时');

  // ⑤ 换目标语言：只重发翻译，不重新识别。
  //    模型调用总数是这一步**唯一**能钉死的量：整轮里"识别一次 + 翻译一次 + 换语言一次"
  //    只该产生 2 次模型调用（换语言只重译）。识别次数由宿主日志单独核（见下）。
  assert.deepEqual(value.selectOptions, ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'], '下拉框选项必须来自 lib 的闭集');
  assert.equal(value.retranslated, '[JA] Hello, world', `换目标语言后应重译，实际 ${JSON.stringify(value.retranslated)}`);
  assert.equal(llmCalls.length, 2, `整轮只该有 2 次模型调用（翻译 + 换语言重译），实际 ${llmCalls.length}`);
  assert.match(llmCalls[0].system, /Simplified Chinese/, '第一次翻译的目标语言是简体中文（默认）');
  assert.match(llmCalls[0].messages[0].content[0].text, /你好/, '原文进了提示词');
  assert.match(llmCalls[1].system, /Japanese/, '换语言后 system 里的目标语言要跟着换');
  const textRecognitions = hostLogs.filter((line) => /ocr: \d+ bytes in, [1-9]\d* lines/.test(line));
  assert.equal(textRecognitions.length, 1, `整轮只该识别一次有文字的区域（换语言不许重识别），实际 ${textRecognitions.length}: ${JSON.stringify(textRecognitions)}`);

  // ⑥ 复制：经宿主写剪贴板（页面自己碰不到）。读回来时**把输出编码钉成 UTF-8** ——
  //    重定向的 stdout 默认走 OEM 代码页，中文会以乱码回来（lib/ocr.ps1 顶上那段注释同一个坑）。
  assert.equal(typeof value.copyNotice === 'string', true, `复制后要有可见反馈，实际 ${JSON.stringify(value.copyNotice)}`);
  assert.equal(hostLogs.some((line) => /clipboard: wrote \d+ chars/.test(line)), true, `宿主必须真的写了剪贴板，日志: ${JSON.stringify(hostLogs.filter((line) => line.includes('clipboard')))}`);
  const clipboardRead = spawn(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; Get-Clipboard -Raw'],
    { encoding: 'buffer', windowsHide: true },
  );
  const clipboardText = await new Promise((resolve) => {
    let out = '';
    clipboardRead.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    clipboardRead.on('close', () => resolve(out.replace(/\r\n/g, '\n').replace(/\s+$/, '')));
  });
  assert.equal(
    clipboardText,
    String(value.sourceText ?? '').replace(/\s+$/, ''),
    `系统剪贴板里必须是这张卡片上的识别文字（读到 ${JSON.stringify(clipboardText)}）`,
  );

  // ⑦ 卡片是 chrome：在里面按指针不许拖出新选区
  assert.equal(value.selectionUnchangedByCard, true, '在卡片里按下指针不该改动选区');

  // ⑧ 改选区 → 卡片失效
  assert.equal(value.cardHiddenAfterReselect, true, '重新框选后旧结果必须收起（否则会把上一块区域的文字当成这次的）');

  // ⑨ 空白区域：如实说"没识别到文字"
  assert.match(value.emptyNotice ?? '', /没识别到文字/, `空白区域应显示"没识别到文字"，实际 ${JSON.stringify(value.emptyNotice)}`);

  // ⑩ Esc：先关卡片
  assert.equal(value.cardHiddenAfterEscape, true, 'Esc 第一下应当关掉卡片');
  assert.equal(value.stillAliveAfterEscape, true, 'Esc 关卡片时不许顺手取消整次截图');

  // 视觉留档：主探测结束时卡片已被 Esc 收起，所以这里**再走一遍**识别 + 翻译，
  // 把"卡片上同时有原文和译文"的样子拍下来。这一步会再花一次模型调用，所以它排在
  // 上面那条"整轮只调 2 次模型"的断言之后。
  const evidence = await session.send('Runtime.evaluate', { expression: EVIDENCE_PROBE, returnByValue: true, awaitPromise: true });
  const shotState = evidence?.result?.value ?? {};
  assert.equal(shotState.cardOpen, true, `留档时卡片应当是打开的，实际 ${JSON.stringify(shotState)}`);
  assert.equal(shotState.hasTranslation, true, `留档时译文应当已出现，实际 ${JSON.stringify(shotState)}`);
  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  pass(
    'T75-E2E 识别 → 翻译 → 复制（真浏览器 + 真实 OCR）',
    `框选 ${FRAME_SIZE.width}×${FRAME_SIZE.height} → 识别出 ${JSON.stringify(value.sourceText)}（${value.sourceMeta}）`
    + ` → 译文 ${JSON.stringify(value.translation)}（${value.targetMeta}）`
    + ` → 换目标语言重译 ${JSON.stringify(value.retranslated)}`
    + ` → 复制后系统剪贴板逐字一致`
    + `；卡片在视口内 ${JSON.stringify(value.cardRect)}，卡片内按指针不动选区，改选区后卡片自动收起，`
    + `空白区域报「没识别到文字」，Esc 先关卡片；截图留档 ${shotPath}`,
  );
} catch (error) {
  // 主探测可能超时，也可能把页面弄没了：`window.__t75` 只在页面活着时读得到，而
  // `consoleTrail` 是 CDP 事件通道实时收下来的 —— 页面已经关掉时，后者是唯一的证据。
  let partial = null;
  if (session !== null) {
    try {
      const recovered = await Promise.race([
        session.send('Runtime.evaluate', { expression: 'window.__t75 ?? null', returnByValue: true }),
        sleep(3_000).then(() => null),
      ]);
      partial = recovered?.result?.value ?? null;
    } catch {
      partial = null;
    }
  }
  fail(
    'T75-E2E 识别 → 翻译 → 复制（真浏览器 + 真实 OCR）',
    `${error.message}\n  页面进度（控制台轨迹）: ${JSON.stringify(session?.consoleTrail ?? [])}`
    + `\n  已走完的步骤: ${JSON.stringify(partial?.steps ?? null)}`
    + `\n  部分结果: ${JSON.stringify(partial)}`
    + `\n  探测结果: ${JSON.stringify(probed)}`
    + `\n  宿主日志: ${hostLogs.slice(-6).join(' | ')}`,
  );
} finally {
  if (session !== null) await session.close();
  await host.close();
  if (process.env.DSH_KEEP !== '1') rmSync(workspace, { recursive: true, force: true });
  else console.log(`工作目录保留: ${workspace}`);
}

const failed = results.filter((ok) => ok !== true).length;
console.log(`\n${results.length - failed}/${results.length} 场景通过`);
process.exit(failed === 0 ? 0 : 1);
