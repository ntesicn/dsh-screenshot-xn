/**
 * 真浏览器探测（t64）：用**真实的 Edge/Chrome（headless）**去加载插件宿主提供的面板页面，
 * 验证最后一条没人验过的缝 —— 「独立浏览器进程 ↔ 宿主的 overlay 路由族」。
 *
 * 为什么需要它：t56 的三条路由与 t57 的页面是分头验过的（页面用本地静态服务，宿主用替身窗口），
 * 但**从没跑过"真浏览器加载宿主提供的页面"**。实机缺陷（kiosk 里只剩白底 + 一行提示 + 裸 input）
 * 正是从这条缝里漏出来的：页面 URL 带 token，而它的 css/js/静态 import 都不带 token。
 *
 * 两个阶段：
 *   A) `--headless=new --screenshot=<png>` 载入面板页 → 截图里必须是**冻结帧的颜色**（本脚本用
 *      8×4 的洋红 PNG 当帧）。这一条同时证明：HTML/CSS/JS/lib 模块全部加载成功、
 *      `GET /overlay/frame?token=` 取到了帧、`createImageBitmap` 解码成功、canvas 真的画了。
 *   B) 不带 `--screenshot` 的 headless 浏览器保持运行 → 8 s 后 `/overlay/status` 仍是 `running`。
 *      心跳窗口是 5 s，页面若没跑起来早该 `aborted` —— 因此这一条证明真浏览器的 JS 在持续打心跳。
 *
 * 用法：`node tests/overlay-browser-probe.mjs`（找不到浏览器时打印 SKIP 并以 0 退出）。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const POWERSHELL = 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const { apply, OVERLAY_PREFIX } = await import(pathToFileURL(join(PACKAGE, 'index.js')).href);

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (browser === undefined || !existsSync(POWERSHELL)) {
  console.log(`[SKIP] 没找到 Edge/Chrome（或 PowerShell）：${browser ?? 'no browser'}`);
  process.exit(0);
}

// ── 合成一张 8×4 的洋红 PNG 当"冻结帧" ─────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();
const crc32 = (buffer) => {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};
function pngOf(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (1 + width * 3);
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

/**
 * 800×520 的冻结帧：左上角 2×2 是四色（红/绿/蓝/白，用来验证 1:1 映射与方向），其余是洋红。
 * 尺寸接近无头窗口的视口（776×508），这样"设备像素 ≈ 视口 CSS 像素"，标注的命中/拖动
 * 才在真实比例下被测（t70：标注按设备像素存，2×2 的假帧会让标注落到屏幕外）。
 */
function pngQuadInBox(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (1 + width * 3);
    for (let column = 0; column < width; column += 1) {
      const at = offset + 1 + column * 3;
      const quad = row < 2 && column < 2;
      const rgb = quad
        ? (row === 0 ? (column === 0 ? [255, 0, 0] : [0, 255, 0]) : (column === 0 ? [0, 0, 255] : [255, 255, 255]))
        : [255, 0, 255];
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 冻结帧的像素尺寸（同时写进 stub 的 JSON 与页面断言）。 */
const FRAME_SIZE = Object.freeze({ width: 800, height: 520 });

/** 2×2 四色帧的期望画布内容（RGBA，行优先）。 */
const QUAD_PIXELS = [
  [255, 0, 0, 255], [0, 255, 0, 255],
  [0, 0, 255, 255], [255, 255, 255, 255],
];

const workspace = mkdtempSync(join(tmpdir(), 'dsh-overlay-browser-'));
const framePath = join(workspace, 'frame.png');
writeFileSync(framePath, pngQuadInBox(FRAME_SIZE.width, FRAME_SIZE.height));
const frameBytes = readFileSync(framePath).length;

const stubCapturePath = join(workspace, 'stub-capture.ps1');
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
$body = '{"ok":true,"through":"captured","through_reason":null,"restore_ok":true,"hidden_ms":10,"png_path":"' + $frame + '","bitmap_width":${FRAME_SIZE.width},"bitmap_height":${FRAME_SIZE.height},"png_bytes":${frameBytes},"elapsed_total_ms":20,"capture_bounds":{"x":0,"y":0,"width":${FRAME_SIZE.width},"height":${FRAME_SIZE.height}},"virtual_screen":{"x":0,"y":0,"width":${FRAME_SIZE.width},"height":${FRAME_SIZE.height}},"single_screen":true,"screen_count":1,"error":null}'
Write-Host '---JSON-BEGIN---'
Write-Host $body
Write-Host '---JSON-END---'
exit 0
`, 'utf8');

const samplerPath = join(workspace, 'sample.ps1');
writeFileSync(samplerPath, `param([Parameter(Mandatory=$true)][string]$Path)
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $Path).Path)
try {
  $magenta = 0
  $total = 0
  for ($row = 0; $row -lt 5; $row++) {
    for ($col = 0; $col -lt 8; $col++) {
      $x = [int](($image.Width - 1) * ($col + 0.5) / 8)
      $y = [int](($image.Height - 1) * ($row + 0.5) / 5)
      $pixel = $image.GetPixel($x, $y)
      $total++
      if ($pixel.R -eq 255 -and $pixel.G -eq 0 -and $pixel.B -eq 255) { $magenta++ }
    }
  }
  Write-Host ('SAMPLED ' + $magenta + ' ' + $total + ' ' + $image.Width + ' ' + $image.Height)
} finally { $image.Dispose() }
`, 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 找一个空闲端口（CDP 用）。 */
async function freePort() {
  const { createServer: create } = await import('node:net');
  const server = create();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * 开一个 CDP 会话（真浏览器 + 调试端口），返回 `send(method, params)` 与 `close()`。
 *
 * 为什么不用 `--screenshot` / `--dump-dom`：面板页有一个常驻心跳定时器（1 s），
 * headless 的两条一次性开关会一直等页面"静止"，最后只能靠超时被杀（实测 `--dump-dom` 直接
 * 挂到 120 s SIGTERM），截图也常在 boot 完成之前就拍下了。CDP 则是"打开 → 拿真实状态 → 关掉"。
 * @param {string} pageUrl @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{send: Function, close: Function}>}
 */
async function openCdp(pageUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
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
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
    throw new Error('DevTools 调试端口没就绪');
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  let id = 0;
  /** 发一条 CDP 命令并等它的响应。@param {string} method @param {object} [params] @returns {Promise<any>} */
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    const current = id;
    const timer = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 15_000);
    const onMessage = (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : '');
      if (message.id !== current) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (message.error !== undefined) reject(new Error(`CDP ${method} 失败: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  return {
    send,
    close: async () => {
      try {
        socket.close();
      } catch {
        /* 已经关了 */
      }
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
      await sleep(200);
    },
  };
}

/**
 * 在真浏览器里求值一段表达式（可等到满足条件为止）。
 * @param {string} pageUrl
 * @param {string} expression
 * @param {{ timeoutMs?: number, waitFor?: (value: unknown) => boolean }} [options]
 * @returns {Promise<unknown>}
 */
async function cdpEvaluate(pageUrl, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const session = await openCdp(pageUrl, { timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let last;
  try {
    while (Date.now() < deadline) {
      const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result?.exceptionDetails !== undefined) {
        throw new Error(`页面求值抛错: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails)}`);
      }
      last = result?.result?.value;
      if (options.waitFor === undefined || options.waitFor(last) === true) return last;
      await sleep(400);
    }
    return last;
  } finally {
    await session.close();
  }
}
const hostLogs = [];

/** 启动真实宿主（抓屏换成 stub），返回 base / start / close。 */
async function bootHost(overlayLaunch) {
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
      info: (line) => hostLogs.push(`info ${line}`),
      warn: (line) => hostLogs.push(`warn ${line}`),
    },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    inject: (deps, callback) => callback(ctx, {}),
    effect: (fn) => fn(),
  };
  apply(ctx, {
    scriptPath: stubCapturePath,
    outDir: workspace,
    // 帧文件要被两个阶段各读一次，别让宿主读完就删（默认 keepTempFile: false）。
    keepTempFile: true,
    overlayLaunch,
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

const results = [];
const pass = (name, detail) => {
  results.push(true);
  console.log(`[PASS] ${name} — ${detail}`);
};
const fail = (name, detail) => {
  results.push(false);
  console.log(`[FAIL] ${name} — ${detail}`);
};

// ── 阶段 A：真浏览器里读页面状态与画布像素 ─────────────────────────────────
const CANVAS_PROBE = `(() => {
  const state = window.__overlayState ?? null;
  const canvas = document.getElementById('base');
  const ctx = canvas === null ? null : canvas.getContext('2d');
  const pixels = ctx === null ? null : Array.from(ctx.getImageData(0, 0, 2, 2).data);
  return {
    state,
    canvas: canvas === null ? null : { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width },
    pixels,
    tools: document.querySelectorAll('#group-tools button').length,
    actions: document.querySelectorAll('#group-actions button').length,
    bootBanner: document.getElementById('boot-error') !== null,
    timing: (window.__overlay ?? {}).timing ?? null,
  };
})()`;

async function phaseScreenshot() {
  const host = await bootHost([browser, '--headless=new', '--disable-gpu', '--no-first-run', '${url}']);
  try {
    const started = await fetch(new URL('/api/dsh-screenshot/overlay/start', host.base), { method: 'POST' });
    const body = await started.json();
    assert.equal(body.ok, true, `start 必须成功：${JSON.stringify(body)}`);
    const pageUrl = `${host.base}/api/dsh-screenshot/overlay/page?token=${body.token}`;
    const probe = await cdpEvaluate(pageUrl, CANVAS_PROBE, {
      waitFor: (value) => value !== null && value !== undefined && value.state === 'ready',
    });
    assert.equal(probe.state, 'ready', `页面应当 boot 完成，实际 ${JSON.stringify(probe.state)}`);
    // 1:1 映射的两端：位图尺寸 = 冻结帧尺寸（2×2），CSS 尺寸 = 视口宽度。
    assert.equal(probe.canvas?.width, FRAME_SIZE.width, `画布位图宽必须等于冻结帧宽，实际 ${JSON.stringify(probe.canvas)}`);
    assert.equal(probe.canvas?.height, FRAME_SIZE.height, `画布位图高必须等于冻结帧高，实际 ${JSON.stringify(probe.canvas)}`);
    assert.match(probe.canvas?.cssWidth ?? '', /^\d+px$/, `画布 CSS 宽应跟随视口，实际 ${probe.canvas?.cssWidth}`);
    // 四色帧逐格对上：帧画上了、方向没反、没有裁剪。
    const pixels = [];
    for (let index = 0; index < 4; index += 1) pixels.push(probe.pixels.slice(index * 4, index * 4 + 4));
    assert.deepEqual(pixels, QUAD_PIXELS, `画布 4 个像素必须是冻结帧的四色（红/绿/蓝/白），实际 ${JSON.stringify(pixels)}`);
    assert.equal(probe.tools > 0, true, '工具栏六类工具按钮必须由页面脚本建出来');
    assert.equal(probe.actions >= 6, true, '工具栏必须含 t75 的识别/翻译 + 插入/复制/另存为/取消 六个动作图标');
    assert.equal(probe.bootBanner, false, '看门狗横幅不该出现（页面正常启动）');
    pass(
      'B-1 真浏览器载入面板页',
      `__overlayState=ready，画布 ${FRAME_SIZE.width}×${FRAME_SIZE.height} 且左上角 2×2 四色帧逐格对上（红/绿/蓝/白），工具按钮 ${probe.tools} 个/动作 ${probe.actions} 个，`
      + `页面自报 readyMs=${probe.timing?.readyMs} ms（HTML/CSS/JS/lib/帧/canvas 全链路通）`,
    );
  } catch (error) {
    fail('B-1 真浏览器载入面板页', `${error.message}\n  host: ${hostLogs.slice(-6).join(' | ')}`);
  } finally {
    await host.close();
  }
}

// ── 阶段 B：真浏览器的心跳把会话保活过 5 s 心跳窗口 ─────────────────────────
async function phaseHeartbeat() {
  const profile = join(workspace, 'profile-heartbeat');
  const host = await bootHost([
    browser,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--window-size=800,600',
    '${url}',
  ]);
  let token = '';
  try {
    const started = await fetch(new URL('/api/dsh-screenshot/overlay/start', host.base), { method: 'POST' });
    const body = await started.json();
    assert.equal(body.ok, true, `start 必须成功：${JSON.stringify(body)}`);
    token = body.token;
    await sleep(8000);
    const status = await (await fetch(new URL(`/api/dsh-screenshot/overlay/status?token=${token}`, host.base))).json();
    assert.equal(status.state, 'running', `8 s 后状态应为 running（心跳在续命），实际 ${status.state}`);
    assert.equal(status.mode, 'through', '会话应当记录穿透抓屏模式');
    pass('B-2 真浏览器心跳', `8 s 后 state=running（心跳窗口 5 s：页面若没跑起来早已 aborted），mode=${status.mode}`);
  } catch (error) {
    fail('B-2 真浏览器心跳', `${error.message}\n  host: ${hostLogs.slice(-6).join(' | ')}`);
  } finally {
    if (token !== '') {
      // 收尾：显式取消，让宿主关掉 headless 浏览器并释放会话。
      await fetch(new URL(`/api/dsh-screenshot/overlay/result?token=${token}`, host.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      }).catch(() => {});
      await sleep(1500);
    }
    await host.close();
  }
}

// ── 阶段 C：真浏览器里的工具栏呈现（图标 + 条件分组 + 视觉留档） ─────────────
const TOOLBAR_PROBE = `(async () => {
  window.__overlay.state.selection = { x: 60, y: 60, width: 420, height: 300 };
  window.dispatchEvent(new Event('resize'));
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const findTool = (part) => [...document.querySelectorAll('#group-tools button')]
    .find((element) => (element.getAttribute('aria-label') ?? '').includes(part));
  const shown = (id) => {
    const element = document.getElementById(id);
    return element !== null && element.hidden !== true && element.offsetWidth > 0;
  };
  const historyButtons = [...document.querySelectorAll('#group-history button')];
  const result = {
    toolbarVisible: document.getElementById('toolbar').offsetWidth > 0,
    icons: {
      tools: document.querySelectorAll('#group-tools svg').length,
      history: document.querySelectorAll('#group-history svg').length,
      // t68：三个动作（插入 ✓ / 复制 / 另存为 ⤓）+ 取消 ✕ 都是图标；
      // t75：识别 / 翻译两个旁路入口也是图标（同样在这一行，靠一根竖线与结果动作分开）。
      actions: document.querySelectorAll('#group-actions svg').length,
      swatches: document.querySelectorAll('#group-colors button').length,
    },
    toolText: [...document.querySelectorAll('#group-tools button')].map((element) => element.textContent.trim()),
    actionText: [...document.querySelectorAll('#group-actions button')].map((element) => element.textContent.trim()),
    actionTitles: [...document.querySelectorAll('#group-actions button')].map((element) => element.title),
    // t69：✓（插入对话）必须是第一行的最后一个按钮（行尾确认键）。
    lastActionTitle: [...document.querySelectorAll('#group-actions button')].pop()?.title ?? '',
    lastActionHasCheck: [...document.querySelectorAll('#group-actions button')].pop()?.querySelector('svg path')?.getAttribute('d') === 'M3.2 8.6l3.2 3.2 6.4-7.6',
    initial: {
      colors: shown('group-colors'),
      widths: shown('group-widths'),
      dividerWidths: shown('divider-widths'),
      sizes: shown('group-sizes'),
      mosaic: shown('group-mosaic'),
      dividerSizes: shown('divider-sizes'),
    },
    undoDisabled: historyButtons[0]?.disabled === true,
    rectTitle: findTool('矩形')?.title ?? '',
    // t75：识别卡片初始是收起的，目标语言下拉框的选项由 lib/ocr.mjs 的 TRANSLATE_TARGETS 生成。
    ocr: {
      cardHidden: document.getElementById('ocr-card').hidden === true,
      targetOptions: document.querySelectorAll('#ocr-target-select option').length,
      titles: [...document.querySelectorAll('#group-actions button')]
        .map((element) => element.title)
        .filter((title) => /识别文字|翻译/.test(title)),
    },
  };
  findTool('矩形').click();
  result.rect = {
    colors: shown('group-colors'),
    widths: shown('group-widths'),
    dividerWidths: shown('divider-widths'),
    chips: document.querySelectorAll('#group-widths button').length,
  };
  findTool('马赛克').click();
  result.mosaic = {
    pressed: findTool('马赛克').getAttribute('aria-pressed'),
    colors: shown('group-colors'),
    mosaic: shown('group-mosaic'),
    dividerMosaic: shown('divider-mosaic'),
    // t72：马赛克下色板与线宽都收起 —— 粒度那根竖线必须跟着藏（否则行首一根孤线）。
    sizes: shown('group-sizes'),
    widths: shown('group-widths'),
    dividerWidths: shown('divider-widths'),
    chips: document.querySelectorAll('#group-mosaic button').length,
  };
  findTool('文字').click();
  result.text = {
    colors: shown('group-colors'),
    sizes: shown('group-sizes'),
    dividerSizes: shown('divider-sizes'),
    mosaic: shown('group-mosaic'),
    widths: shown('group-widths'),
    chips: document.querySelectorAll('#group-sizes button').length,
  };
  findTool('移动').click();
  result.backToMove = {
    colors: shown('group-colors'),
    widths: shown('group-widths'),
    dividerWidths: shown('divider-widths'),
    sizes: shown('group-sizes'),
    mosaic: shown('group-mosaic'),
  };
  // t66：两行是结构（两个 .row 叠放），不是自动折行；t68：动作与工具同在第一行。
  const rows = [...document.querySelectorAll('#toolbar .row')];
  const toolButtons = [...document.querySelectorAll('#group-tools button')];
  const actions = [...document.querySelectorAll('#group-actions button')];
  const rowTools = document.getElementById('row-tools');
  const rowStyle = document.getElementById('row-style');
  result.rows = {
    count: rows.length,
    visible: rows.filter((row) => row.offsetWidth > 0 && row.offsetHeight > 0).length,
    tops: rows.map((row) => Math.round(row.getBoundingClientRect().top)),
    widths: rows.map((row) => Math.round(row.offsetWidth)),
    toolTop: Math.round(toolButtons[0].getBoundingClientRect().top),
    actionTop: Math.round(actions[0].getBoundingClientRect().top),
    actionInToolsRow: rowTools.contains(actions[0]),
    colorsInStyleRow: rowStyle.contains(document.querySelector('#group-colors button')),
    toolbar: { width: Math.round(document.getElementById('toolbar').offsetWidth), height: Math.round(document.getElementById('toolbar').offsetHeight) },
  };
  result.sizeLabel = document.getElementById('size-label').textContent;
  result.sizeLabelInStyleRow = rowStyle.contains(document.getElementById('size-label'));
  return result;
})()`;

async function phaseToolbar() {
  const host = await bootHost([browser, '--headless=new', '--disable-gpu', '--no-first-run', '${url}']);
  const shotPath = join(workspace, 'panel.png');
  let session;
  try {
    const started = await fetch(new URL('/api/dsh-screenshot/overlay/start', host.base), { method: 'POST' });
    const body = await started.json();
    assert.equal(body.ok, true, `start 必须成功：${JSON.stringify(body)}`);
    const pageUrl = `${host.base}/api/dsh-screenshot/overlay/page?token=${body.token}`;
    session = await openCdp(pageUrl);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await session.send('Runtime.evaluate', { expression: 'window.__overlayState', returnByValue: true });
      if (ready?.result?.value === 'ready') break;
      await sleep(300);
    }
    const probe = await session.send('Runtime.evaluate', { expression: TOOLBAR_PROBE, returnByValue: true, awaitPromise: true });
    if (probe?.exceptionDetails !== undefined) {
      throw new Error(`工具栏探测抛错: ${JSON.stringify(probe.exceptionDetails.exception?.description ?? probe.exceptionDetails)}`);
    }
    const value = probe?.result?.value ?? {};
    assert.equal(value.toolbarVisible, true, '框选之后工具栏必须可见');
    // 图标：7 个工具、撤销/重做、**6 个动作**（t75 起：识别 / 翻译 + 插入 ✓ / 复制 / 另存为 ⤓ / 取消 ✕）
    // 各是 SVG；工具与动作按钮里都**没有可见文字**（不是"图标变文字"），但都保留 title 悬停提示。
    assert.equal(value.icons?.tools, 7, `工具图标应有 7 个，实际 ${value.icons?.tools}`);
    assert.equal(value.icons?.history, 2, `撤销/重做应有 2 个图标，实际 ${value.icons?.history}`);
    assert.equal(value.icons?.actions, 6, `识别/翻译 + 三个动作 + 取消都应是图标，实际 ${value.icons?.actions}`);
    assert.equal(value.icons?.swatches, 6, `色板应有 6 个，实际 ${value.icons?.swatches}`);
    assert.deepEqual((value.toolText ?? []).filter((text) => text !== ''), [], `工具按钮不该有可见文字，实际 ${JSON.stringify(value.toolText)}`);
    assert.deepEqual((value.actionText ?? []).filter((text) => text !== ''), [], `动作按钮不该有可见文字，实际 ${JSON.stringify(value.actionText)}`);
    assert.deepEqual(
      (value.actionTitles ?? []).filter((title) => typeof title !== 'string' || title === ''),
      [],
      `动作图标必须保留 title 悬停提示，实际 ${JSON.stringify(value.actionTitles)}`,
    );
    assert.equal(typeof value.rectTitle === 'string' && value.rectTitle !== '', true, '图标按钮必须保留 title 悬停提示');
    // t69：✓ 是行尾的确认键（动作顺序 复制 → 另存为 → 取消 → ✓）。
    assert.equal(value.lastActionHasCheck, true, `第一行最后一个按钮应是 ✓ 插入对话，实际 "${value.lastActionTitle}"`);
    assert.match(value.lastActionTitle ?? '', /插入对话/, `行尾按钮的 title 应是插入对话，实际 "${value.lastActionTitle}"`);
    // 初始（移动工具）：色板/线宽/字号/粒度都不显示（移动不落色也不落粗细）；没有历史时撤销禁用。
    assert.deepEqual(value.initial, { colors: false, widths: false, dividerWidths: false, sizes: false, mosaic: false, dividerSizes: false });
    assert.equal(value.undoDisabled, true, '没有历史时撤销按钮应禁用');
    // t75：识别卡片初始收起；目标语言选项由 lib/ocr.mjs 生成（这里只钉"接上了且有多个选项"，
    // 具体条数与文案由 tests/ocr.test.mjs 的闭集断言负责）。
    assert.equal(value.ocr?.cardHidden, true, '识别结果卡片初始必须是收起的');
    assert.ok(value.ocr?.targetOptions >= 4, `目标语言下拉框应有多个选项，实际 ${value.ocr?.targetOptions}`);
    assert.deepEqual(value.ocr?.titles?.length, 2, `动作区应有"识别文字"与"翻译"两个入口，实际 ${JSON.stringify(value.ocr?.titles)}`);
    // 选矩形：**色板 + 线宽**出现（含竖线），3 档 —— t68/t72 的"只有会落色/落粗细的工具才有"。
    assert.equal(value.rect?.colors, true, '选矩形后色板必须出现');
    assert.equal(value.rect?.widths, true, '选矩形后线宽分组必须出现');
    assert.equal(value.rect?.dividerWidths, true, '线宽分组出现时竖线也要出现');
    assert.equal(value.rect?.chips, 3, `线宽应有 3 档，实际 ${value.rect?.chips}`);
    // 选马赛克：粒度出现、色板 / 字号 / **线宽**都隐藏；粒度前面没有可见分组 → 它那根竖线也不显示
    //（t72 的"不留孤立竖线"：否则行首会挂一根孤零零的线）。
    assert.equal(value.mosaic?.mosaic, true, '选马赛克后粒度分组必须出现');
    assert.equal(value.mosaic?.dividerMosaic, false, '粒度是行首第一个可见分组时不该有前导竖线');
    assert.equal(value.mosaic?.colors, false, '马赛克工具下不该出现色板（t72）');
    assert.equal(value.mosaic?.sizes, false, '马赛克工具下不该出现字号');
    assert.equal(value.mosaic?.widths, false, '马赛克工具下不该出现线宽（t68）');
    assert.equal(value.mosaic?.dividerWidths, false, '线宽隐藏时它的竖线也要隐藏');
    assert.equal(value.mosaic?.pressed, 'true', '马赛克按钮应进入按压态');
    assert.equal(value.mosaic?.chips, 3, `粒度应有 3 档，实际 ${value.mosaic?.chips}`);
    // 选文字：色板 + 字号出现；粒度与线宽隐藏（文字有自己的字号）。
    assert.equal(value.text?.colors, true, '选文字后色板必须出现（要选文字颜色）');
    assert.equal(value.text?.sizes, true, '选文字后字号分组必须出现');
    assert.equal(value.text?.dividerSizes, true, '字号分组出现时竖线也要出现');
    assert.equal(value.text?.mosaic, false, '文字工具下不该出现粒度');
    assert.equal(value.text?.widths, false, '文字工具下不该出现线宽（t68）');
    assert.equal(value.text?.chips, 3, `字号应有 3 档，实际 ${value.text?.chips}`);
    // 回到移动：色板与三个档位分组都收起。
    assert.deepEqual(value.backToMove, { colors: false, widths: false, dividerWidths: false, sizes: false, mosaic: false });
    // t66/t68：恰好两行、都可见、上下错开；动作与工具**同在第一行**；色板与尺寸在第二行。
    assert.equal(value.rows?.count, 2, `工具栏应恰好两行，实际 ${value.rows?.count}`);
    assert.equal(value.rows?.visible, 2, '两行都必须可见');
    assert.ok(value.rows.tops[1] > value.rows.tops[0], `第二行应在第一行下方，实际 ${JSON.stringify(value.rows.tops)}`);
    assert.equal(value.rows?.actionInToolsRow, true, '三个动作 + 取消必须在第一行（t68）');
    assert.ok(Math.abs(value.rows.toolTop - value.rows.actionTop) <= 2, `动作应与工具同一行，实际工具 ${value.rows.toolTop} / 动作 ${value.rows.actionTop}`);
    assert.equal(value.rows?.colorsInStyleRow, true, '色板应在第二行');
    assert.equal(value.sizeLabelInStyleRow, true, '输出尺寸应移到第二行行尾');
    assert.ok(value.rows.toolbar.height > 60, `两行工具栏的高度应当不止一行，实际 ${value.rows.toolbar.height}`);
    assert.match(value.sizeLabel ?? '', /^\d+ × \d+ px$/, `第二行右侧应显示输出尺寸，实际 ${JSON.stringify(value.sizeLabel)}`);

    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    pass(
      'B-3 真浏览器工具栏',
      '工具/撤销/重做/识别/翻译/三个动作/取消全是图标（工具与动作按钮零可见文字、title 保留），'
      + '识别卡片初始收起且目标语言下拉框已接上 lib 的闭集，'
      + '矩形→色板+线宽出现、马赛克→粒度出现（无前导竖线）、文字→色板+字号出现，'
      + '移动与马赛克下都**不**显示色板，移动/马赛克/文字下都**不**显示线宽；'
      + `固定两行（${value.rows.widths.join(' / ')} px，高 ${value.rows.toolbar.height} px，第二行行尾尺寸「${value.sizeLabel}」）；`
      + `截图留档 ${shotPath}`,
    );
  } catch (error) {
    fail('B-3 真浏览器工具栏', `${error.message}\n  host: ${hostLogs.slice(-4).join(' | ')}`);
  } finally {
    if (session !== undefined) await session.close();
    await host.close();
  }
}

// ── 阶段 E：已放置标注的选中 / 拖动 / 删除（t70 修的"文字拖不动"） ────────────
const ANNOTATION_PROBE = `(async () => {
  const S = window.__overlay.state;
  const rAF = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const fire = (type, x, y) => document.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
  }));
  const inkOpaque = (x, y, w, h) => {
    const ctx = document.getElementById('ink').getContext('2d');
    const data = ctx.getImageData(x, y, w, h).data;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count += 1;
    return count;
  };
  const result = { steps: [] };

  // ① 造一个（够大的）选区，再用文字工具点一下、输入、回车提交。
  //    选区必须留出足够的拖动余量：标注被**夹在选区内**（B-13 的既定行为），
  //    选区太小时拖到边就停，位移会小于拖拽距离（这正是它该有的样子）。
  S.selection = { x: 20, y: 20, width: 700, height: 440 };
  S.tool = 'text';
  fire('pointerdown', 200, 200);
  fire('pointerup', 200, 200);
  const editor = document.getElementById('editor');
  result.editorVisible = editor.offsetWidth > 0;
  editor.value = 'DSH-TEXT';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await rAF();
  result.historyAfterText = S.history.present.length;
  const text = S.history.present[0];
  if (text === undefined) return result;
  const sx = S.frame.width / window.innerWidth;
  const sy = S.frame.height / window.innerHeight;
  result.textDevice = { x: Math.round(text.x), y: Math.round(text.y), width: Math.round(text.rect.width), height: Math.round(text.rect.height) };
  result.textCss = { x: text.x / sx, y: text.y / sy, width: text.rect.width / sx, height: text.rect.height / sy };

  // ② 移动工具：在文字上按下 → 拖动 → 松手，标注必须整体平移，且只写一条历史。
  S.tool = 'move';
  const DRAG = { x: 180, y: 100 }; // 位移够大，"旧位置"和"新位置"的采样窗互不重叠
  const start = { x: 200 + 10, y: 200 + 10 };
  const sampleBox = (offsetX, offsetY) => [
    Math.round(result.textCss.x + offsetX) - 4,
    Math.round(result.textCss.y + offsetY) - 4,
    Math.round(result.textCss.width) + 12,
    Math.round(result.textCss.height) + 12,
  ];
  const before = inkOpaque(...sampleBox(0, 0));
  fire('pointerdown', start.x, start.y);
  result.selectedOnDown = S.selected !== null;
  fire('pointermove', start.x + DRAG.x, start.y + DRAG.y);
  // 虚线框与墨迹都是 rAF 里画的：等一帧再读，否则读到的是"还没画"。
  await rAF();
  result.dashedBoxWhileDragging = document.getElementById('annotation-box').offsetWidth > 0;
  fire('pointerup', start.x + DRAG.x, start.y + DRAG.y);
  await rAF();
  const moved = S.history.present[0];
  result.historyAfterDrag = S.history.present.length;
  result.deltaDevice = { x: Math.round(moved.x - text.x), y: Math.round(moved.y - text.y) };
  result.deltaExpected = { x: Math.round(DRAG.x * sx), y: Math.round(DRAG.y * sy) };
  result.inkBefore = before;
  result.inkAfterMove = inkOpaque(...sampleBox(DRAG.x, DRAG.y));
  result.inkAtOldSpot = inkOpaque(...sampleBox(0, 0));
  result.stillSelected = S.selected === moved;
  result.dashedBoxAfterDrag = document.getElementById('annotation-box').offsetWidth > 0;

  // ③ t71：悬停即手柄（不切工具也能拖）—— 把工具停在"矩形"上，鼠标移进文字区域看光标，
  //    然后**直接**按下拖动（不再先选中、也不先切到移动工具）。
  S.tool = 'rect';
  document.dispatchEvent(new PointerEvent('pointermove', {
    clientX: start.x + DRAG.x, clientY: start.y + DRAG.y, bubbles: true,
  }));
  await rAF();
  result.hoverCursor = document.body.style.cursor;
  const beforeSecond = S.history.present[0];
  fire('pointerdown', start.x + DRAG.x + 10, start.y + DRAG.y + 10);
  result.dragWithoutToolSwitch = S.drag !== null && S.drag.mode === 'annotate-move';
  fire('pointermove', start.x + DRAG.x - 90, start.y + DRAG.y - 50);
  fire('pointerup', start.x + DRAG.x - 90, start.y + DRAG.y - 50);
  await rAF();
  const second = S.history.present[0];
  result.historyAfterSecondDrag = S.history.present.length;
  result.secondDelta = { x: Math.round(second.x - beforeSecond.x), y: Math.round(second.y - beforeSecond.y) };
  result.secondDeltaExpected = { x: Math.round(-100 * sx), y: Math.round(-60 * sy) };

  // ④ t71：双击（光标已处于手柄态）重新编辑文字 —— 输入框必须回填原文、提交后**替换**那一条。
  const box = { x: second.x / sx, y: second.y / sy, width: second.rect.width / sx, height: second.rect.height / sy };
  document.dispatchEvent(new MouseEvent('dblclick', {
    clientX: Math.round(box.x + 6), clientY: Math.round(box.y + 6), bubbles: true, cancelable: true,
  }));
  result.editorVisibleOnEdit = editor.offsetWidth > 0;
  result.editorPrefilled = editor.value;
  editor.value = 'DSH-EDITED';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await rAF();
  result.historyAfterEdit = S.history.present.length;
  result.textAfterEdit = S.history.present[0]?.text ?? null;

  // ⑤ Delete：只删这一条，且可撤销（Ctrl+Z 后回来）。留给第二次求值（中间要截图留档）。
  result.steps.push('dragged');
  return result;
})()`;

/** 第二次求值：删除 + 撤销（截图之后再做，免得留档拍不到选中框）。 */
const ANNOTATION_DELETE_PROBE = `(async () => {
  const S = window.__overlay.state;
  const rAF = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const result = {};
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await rAF();
  result.historyAfterDelete = S.history.present.length;
  result.selectedAfterDelete = S.selected;
  result.dashedBoxAfterDelete = document.getElementById('annotation-box').offsetWidth > 0;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  await rAF();
  result.historyAfterUndo = S.history.present.length;
  return result;
})()`;

async function phaseAnnotationDrag() {
  const host = await bootHost([browser, '--headless=new', '--disable-gpu', '--no-first-run', '${url}']);
  const shotPath = join(workspace, 'annotation-drag.png');
  let session;
  try {
    const started = await fetch(new URL('/api/dsh-screenshot/overlay/start', host.base), { method: 'POST' });
    const body = await started.json();
    assert.equal(body.ok, true, `start 必须成功：${JSON.stringify(body)}`);
    const pageUrl = `${host.base}/api/dsh-screenshot/overlay/page?token=${body.token}`;
    session = await openCdp(pageUrl);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await session.send('Runtime.evaluate', { expression: 'window.__overlayState', returnByValue: true });
      if (ready?.result?.value === 'ready') break;
      await sleep(300);
    }
    const probe = await session.send('Runtime.evaluate', { expression: ANNOTATION_PROBE, returnByValue: true, awaitPromise: true });
    if (probe?.exceptionDetails !== undefined) {
      throw new Error(`标注探测抛错: ${JSON.stringify(probe.exceptionDetails.exception?.description ?? probe.exceptionDetails)}`);
    }
    const value = probe?.result?.value ?? {};
    assert.equal(value.editorVisible, true, '文字工具点一下应当出现输入框');
    assert.equal(value.historyAfterText, 1, `输入框回车后应有 1 条标注，实际 ${value.historyAfterText}`);
    assert.ok(value.textDevice?.width > 0 && value.textDevice?.height > 0, `文字标注必须有量出来的矩形，实际 ${JSON.stringify(value.textDevice)}`);
    assert.equal(value.selectedOnDown, true, '在文字上按下应当选中它（此前面板根本没有选中逻辑）');
    assert.equal(value.dashedBoxWhileDragging, true, '拖动过程中必须能看到虚线选中框');
    assert.deepEqual(value.deltaDevice, value.deltaExpected, `拖动位移应按设备像素换算：实际 ${JSON.stringify(value.deltaDevice)}，期望 ${JSON.stringify(value.deltaExpected)}`);
    assert.equal(value.historyAfterDrag, 1, '一次拖拽只应写一条历史（不记录中间帧）');
    assert.ok(value.inkAfterMove > 0, '拖动后新位置必须有墨迹（真的重画了）');
    assert.equal(value.inkAtOldSpot, 0, '旧位置不该还留着墨迹');
    assert.equal(value.inkBefore > 0, true, '拖动前文字应当已经画在画布上');
    assert.equal(value.stillSelected, true, '松手后仍应保持选中（可继续拖/缩放/删除）');
    assert.equal(value.dashedBoxAfterDrag, true, '松手后虚线框仍在选中标注上');
    // t71：悬停即手柄 + 不切工具直接拖 + 双击改文字。
    assert.equal(value.hoverCursor, 'move', `鼠标进入文字区域时光标应变成拖拽手柄，实际 "${value.hoverCursor}"`);
    assert.equal(value.dragWithoutToolSwitch, true, '在"矩形"工具下悬停文字并按下，也应直接进入拖动（不该要求先切工具）');
    assert.equal(value.historyAfterSecondDrag, 1, '第二次拖动同样只写一条历史');
    assert.deepEqual(value.secondDelta, value.secondDeltaExpected, `第二次拖动位移应为设备像素：实际 ${JSON.stringify(value.secondDelta)}，期望 ${JSON.stringify(value.secondDeltaExpected)}`);
    assert.equal(value.editorVisibleOnEdit, true, '双击文字应打开输入框');
    assert.equal(value.editorPrefilled, 'DSH-TEXT', `双击进入时输入框应回填原文，实际 "${value.editorPrefilled}"`);
    assert.equal(value.historyAfterEdit, 1, '改文字应替换原条目（不是再插一条）');
    assert.equal(value.textAfterEdit, 'DSH-EDITED', `改完的文字应写回标注，实际 "${value.textAfterEdit}"`);

    // 视觉留档：此刻屏幕上应当能看到"被选中的文字 + 虚线框 + 4 个角把手"。
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

    const removed = await session.send('Runtime.evaluate', { expression: ANNOTATION_DELETE_PROBE, returnByValue: true, awaitPromise: true });
    if (removed?.exceptionDetails !== undefined) {
      throw new Error(`删除探测抛错: ${JSON.stringify(removed.exceptionDetails.exception?.description ?? removed.exceptionDetails)}`);
    }
    const after = removed?.result?.value ?? {};
    assert.equal(after.historyAfterDelete, 0, 'Delete 应当只删掉选中的那条');
    assert.equal(after.selectedAfterDelete, null, '删除后选中态应清空');
    assert.equal(after.dashedBoxAfterDelete, false, '删除后虚线框应收起');
    assert.equal(after.historyAfterUndo, 1, 'Ctrl+Z 应当把删掉的标注恢复回来');
    pass(
      'B-5 标注拖动',
      `文字标注 rect=${JSON.stringify(value.textDevice)}；拖动位移 ${JSON.stringify(value.deltaDevice)}（期望 ${JSON.stringify(value.deltaExpected)}）；`
      + `墨迹 旧位置 ${value.inkBefore}→${value.inkAtOldSpot}、新位置 ${value.inkAfterMove}；一次拖拽=一条历史；`
      + `悬停光标="${value.hoverCursor}"、矩形工具下直接拖动 ✅、双击回填"${value.editorPrefilled}"→改后"${value.textAfterEdit}"；`
      + `Delete 删除 + Ctrl+Z 恢复；截图留档 ${shotPath}`,
    );
  } catch (error) {
    fail('B-5 标注拖动', `${error.message}\n  host: ${hostLogs.slice(-4).join(' | ')}`);
  } finally {
    if (session !== undefined) await session.close();
    await host.close();
  }
}

// ── 阶段 D：普通模式的提示（t67 右键菜单选了"含 DSH"时，面板必须自己说出来） ──
async function phaseNormalModeNotice() {
  const host = await bootHost([browser, '--headless=new', '--disable-gpu', '--no-first-run', '${url}']);
  let session;
  try {
    const started = await fetch(new URL('/api/dsh-screenshot/overlay/start', host.base), { method: 'POST' });
    const body = await started.json();
    assert.equal(body.ok, true, `start 必须成功：${JSON.stringify(body)}`);
    const pageUrl = `${host.base}/api/dsh-screenshot/overlay/page?token=${body.token}&mode=normal`;
    session = await openCdp(pageUrl);
    const deadline = Date.now() + 30_000;
    let text = '';
    while (Date.now() < deadline) {
      const probe = await session.send('Runtime.evaluate', {
        expression: "document.getElementById('notice')?.textContent ?? ''",
        returnByValue: true,
      });
      text = probe?.result?.value ?? '';
      if (text.includes('普通模式')) break;
      await sleep(300);
    }
    assert.match(text, /普通模式/, `普通模式的页面必须在提示行写出来，实际 "${text}"`);
    assert.match(text, /DSH/, '提示要说清画面里含 DSH 窗口');
    // 同一页面对照：穿透模式不出现这句话（默认路径不该有多余噪音）。
    const through = await cdpEvaluate(
      `${host.base}/api/dsh-screenshot/overlay/page?token=${body.token}&mode=through`,
      "document.getElementById('notice')?.textContent ?? ''",
      { waitFor: (value) => typeof value === 'string' && value.includes('拖动鼠标框选') },
    );
    assert.match(through, /拖动鼠标框选/, '穿透模式的提示行应是默认的框选提示');
    assert.equal(/普通模式/.test(through), false, '穿透模式不该出现普通模式提示');
    pass('B-4 普通模式提示', `mode=normal → 「${text.trim()}」；mode=through → 默认框选提示`);
  } catch (error) {
    fail('B-4 普通模式提示', `${error.message}\n  host: ${hostLogs.slice(-4).join(' | ')}`);
  } finally {
    if (session !== undefined) await session.close();
    await host.close();
  }
}

console.log(`browser: ${browser}`);
console.log(`workspace: ${workspace}`);
try {
  await phaseScreenshot();
  await phaseHeartbeat();
  await phaseToolbar();
  await phaseAnnotationDrag();
  await phaseNormalModeNotice();
} finally {
  // DSH_KEEP=1 时保留工作目录（截图、profile），便于事后看图排查。
  if (process.env.DSH_KEEP !== '1') rmSync(workspace, { recursive: true, force: true });
  else console.log(`保留工作目录：${workspace}`);
}

const failed = results.filter((ok) => ok !== true).length;
console.log(`\n${results.length - failed}/${results.length} 阶段通过`);
console.log(`宿主日志：${hostLogs.filter((line) => line.includes('overlay')).slice(-8).join(' | ')}`);
if (failed > 0) process.exit(1);
