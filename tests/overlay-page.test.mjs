/**
 * B1 覆盖层页面的离线契约（t57）。
 *
 * 页面是**独立浏览器窗口**（kiosk），跑在浏览器里、没有 DSH 的模块表，所以离线只能做静态契约：
 *   1. 组成与冻结接口：三个文件齐备；只用冻结的四个端点；token 从自身 URL 读；心跳 ≤1s；
 *   2. 1:1 映射与框选：位图=冻结帧、CSS=视口、比例换算写明、<8px 用 lib 的判定；
 *   3. **纯逻辑不复制**：五个 lib 模块全部从 `/api/dsh-screenshot/overlay/lib/<name>.mjs` import，
 *      页面里不得出现 lib 的实现（X-2 式的单一真相防线）；
 *   4. 交互与无障碍：六类工具 + 六色 + 三档线宽 + 撤销重做 + 三动作 + 取消、Esc/Ctrl+Z/Ctrl+Y、
 *      按钮 aria-label；
 *   5. 独立性：不引 DSH 客户端包、不用主题令牌、不引 React；导出只含选区+标注。
 * 末尾给负样本：任一形态打回原形，对应断言必须失败。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const overlayDir = new URL('../overlay/', import.meta.url);
const read = (name) => readFileSync(new URL(name, overlayDir), 'utf8');

const html = read('index.html');
const css = read('overlay.css');
const js = read('overlay.js');

const FROZEN_ENDPOINTS = [
  '/api/dsh-screenshot/overlay/frame',
  '/api/dsh-screenshot/overlay/result',
  '/api/dsh-screenshot/overlay/ping',
  '/api/dsh-screenshot/overlay/page',
];
/** 宿主的资产前缀（t56 的 OVERLAY_ASSET_PREFIX）：页面的 css/js 必须走它。 */
const ASSET_PREFIX = '/api/dsh-screenshot/overlay/asset/';
const LIB_MODULES = ['geometry.mjs', 'capture-plan.mjs', 'annotations.mjs', 'history.mjs', 'output.mjs'];
/**
 * 只可能出现在 lib 实现里的内部标识：页面出现它们就等于复制了一份逻辑。
 * 注意：这里只列**声明/内部常量**，不列调用形态（`sizeAttempts(plan, policy)` 这种调用是
 * 复用，必须允许）。
 */
const LIB_INTERNALS = [
  'BOUNDS_EPSILON',
  'CALIBRATION_TOLERANCE',
  'LOSSY_TIER_START',
  'WEBP_QUALITY_STEPS',
  'DEFAULT_HISTORY_LIMIT',
  'MIN_DEVICE_SCALE',
  'function arrowHeadSize(',
  'function roundRectPath(',
  'function closestTextSizeKey(',
  'function planRender(',
  'function drawAnnotation(',
  'function createHistory(',
  'function calibrateCapture(',
  'function mosaicCellSize(',
  'function sizeAttempts(',
  'function normalizeCapture(',
];

/**
 * 契约 1+3+5：冻结接口、lib 复用、独立性。
 * 独立性两项（DSH 包 / 主题令牌）必须在**剥注释后**的文本上判：页面注释里会写"不引用
 * @deepseek-ai/dsh-client-* 与 --dsw-alias-*"，注释提到不算依赖。
 * @param {{html: string, css: string, js: string}} files
 * @returns {{ok: boolean, reason: string}}
 */
function frozenSeamAndReuse(files) {
  const strip = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const bare = { html: strip(files.html), css: strip(files.css), js: strip(files.js) };
  for (const endpoint of FROZEN_ENDPOINTS) {
    if (!files.js.includes(endpoint)) return { ok: false, reason: `缺少冻结端点 ${endpoint}` };
  }
  for (const name of LIB_MODULES) {
    if (!files.js.includes(`'/api/dsh-screenshot/overlay/lib/${name}'`)) {
      return { ok: false, reason: `没有从冻结端点 import lib/${name}（纯逻辑必须只有一份）` };
    }
  }
  for (const marker of LIB_INTERNALS) {
    if (files.js.includes(marker)) return { ok: false, reason: `页面里出现了 lib 实现痕迹: ${marker}（复制了一份逻辑）` };
  }
  if (!/new URLSearchParams\(window\.location\.search\)/.test(files.js) || !/params\.get\('token'\)/.test(files.js)) {
    return { ok: false, reason: '没有从自身 URL 的 query 里读 token' };
  }
  // t67：宿主把这次会话请求的抓屏模式也放在页面 URL 上（`&mode=through|normal`）。
  // 普通模式下画面里就是有 DSH 窗口，页面必须把它写出来 —— 否则用户以为插件坏了。
  if (!/params\.get\('mode'\) === 'normal' \? 'normal' : 'through'/.test(files.js)) {
    return { ok: false, reason: '没有从自身 URL 里读抓屏模式（普通模式无法给出提示）' };
  }
  if (!/notice\(captureMode === 'normal' \? T\.normalModeNotice : T\.hint\)/.test(files.js)) {
    return { ok: false, reason: '普通模式下没有把“画面含 DSH”写进提示行' };
  }
  if (!/normalModeNotice:/.test(files.js)) return { ok: false, reason: '页面缺少普通模式文案' };
  if (!/\/api\/dsh-screenshot\/overlay\/frame\?token=/.test(files.js) && !/\$\{ENDPOINTS\.frame\}\?token=/.test(files.js)) {
    return { ok: false, reason: 'frame 请求没有带 token' };
  }
  if (!/withToken\(ENDPOINTS\.(frame|result|ping)\)/.test(files.js)) {
    return { ok: false, reason: '端点不是通过统一的 withToken 拼 token' };
  }
  if (/from\s+['"]@deepseek-ai\/dsh-client-|require\(\s*['"]@deepseek-ai\/dsh-client-/.test(bare.js + bare.html)) {
    return { ok: false, reason: '页面引用了 DSH 客户端包' };
  }
  if (/var\(\s*--dsw-alias-/.test(bare.js + bare.html + bare.css) || /--dsw-alias-[a-z0-9-]+/.test(bare.css)) {
    return { ok: false, reason: '页面依赖了 DSH 主题令牌（独立窗口要自绘）' };
  }
  if (/\bfrom\s+['"]react['"]/.test(bare.js) || /React\.createElement|ReactDOM/.test(bare.js)) {
    return { ok: false, reason: '页面引用了 React（独立窗口没有 DSH 模块表）' };
  }
  if (!/<script type="module" src="\/api\/dsh-screenshot\/overlay\/asset\/overlay\.js">/.test(files.html)) {
    return { ok: false, reason: 'index.html 没有以 ES module 方式从宿主资产前缀加载 overlay.js（import 会失败）' };
  }
  if (!files.html.includes('/api/dsh-screenshot/overlay/asset/overlay.css')) {
    return { ok: false, reason: 'overlay.css 没有走宿主资产前缀（相对 ./ 会被解析成 …/overlay/overlay.css，与宿主 404 不一致）' };
  }
  return { ok: true, reason: '' };
}

/**
 * 契约 2：1:1 映射 + 框选交互（含 <8px 无效、8 把手、遮罩、徽标、十字线、计时证据）。
 * @param {string} text
 * @returns {{ok: boolean, reason: string}}
 */
function oneToOneSelection(text) {
  if (!/canvas\.width = state\.frame\.width/.test(text) || !/canvas\.height = state\.frame\.height/.test(text)) {
    return { ok: false, reason: '画布位图尺寸没有取冻结帧尺寸（1:1 的位图端）' };
  }
  if (!/canvas\.style\.width = `\$\{view\.width\}px`/.test(text) || !/canvas\.style\.height = `\$\{view\.height\}px`/.test(text)) {
    return { ok: false, reason: '画布 CSS 尺寸没有取视口尺寸（1:1 的 CSS 端）' };
  }
  if (!/state\.frame\.width \/ viewportSize\(\)\.width/.test(text)) return { ok: false, reason: '缺少位图→视口的换算（scaleX）' };
  if (!/state\.frame\.height \/ viewportSize\(\)\.height/.test(text)) return { ok: false, reason: '缺少位图→视口的换算（scaleY）' };
  if (!/devicePixelRatio/.test(text)) return { ok: false, reason: '没有把 devicePixelRatio 纳入标定' };
  if (!/readyMs/.test(text) || !/frameMs/.test(text)) return { ok: false, reason: '没有页面内计时证据（readyMs / frameMs）' };
  if (!/window\.__overlay = \{/.test(text) || !/timing:/.test(text)) return { ok: false, reason: '没有把计时暴露成可读的页面内证据' };

  for (const helper of ['rectFromCorners', 'clampRectToFrame', 'resizeRect', 'hitHandle', 'containsPoint', 'handlePoint', 'HANDLES']) {
    if (!text.includes(helper)) return { ok: false, reason: `框选没有复用 lib 的 ${helper}` };
  }
  if (!/planFor\(/.test(text) || !/planRender\(/.test(text)) return { ok: false, reason: '没有用 lib 的 planRender 判定选区有效性' };
  if (!/MIN_SELECTION_EDGE/.test(text)) return { ok: false, reason: '没有引用 lib 的最小边长常量（<8px 判定）' };
  if (!/if \(plan === null \|\| !plan\.valid\)/.test(text)) return { ok: false, reason: '选区无效时没有取消本次（<8px / 越界）' };
  if (!/selection\.tooSmall/.test(text) || !/selection\.clipped/.test(text)) return { ok: false, reason: '没有区分 tooSmall / clipped 两种取消原因' };
  // 冻结帧层必须用**恒等变换**：画布位图尺寸就是冻结帧像素，再由 CSS 尺寸铺到视口。
  // 若把 ink 层那套 CSS→设备比例也套到帧上，视口与帧不等宽时整屏会被裁成左上角放大图
  // （t64 真浏览器探测抓到的 latent 耦合：只画一次、在满屏 100% 缩放下恰好等于 1 才没暴露）。
  for (const signature of ['async function boot() {', 'function layout() {']) {
    const body = sliceFunction(text, signature);
    if (body === null) return { ok: false, reason: `找不到 ${signature}` };
    if (!/setTransform\(1, 0, 0, 1, 0, 0\);[\s\S]{0,200}?ctx\.drawImage\(state\.frame, 0, 0\);/.test(body)) {
      return { ok: false, reason: `${signature} 里冻结帧层不是恒等变换（会跟着视口缩放整屏）` };
    }
    if (/setTransform\(sx, 0, 0, sy, 0, 0\);[\s\S]{0,200}?ctx\.drawImage\(state\.frame/.test(body)) {
      return { ok: false, reason: `${signature} 里冻结帧层套用了 ink 层的 CSS→设备变换` };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * 契约 6（t65）：工具栏的**呈现**与 DSH 内覆盖层一致 ——
 * 工具 / 撤销 / 重做 / 取消是**图标按钮**（名字走 title 悬停提示），不是"图标变文字"；
 * **字号只在文字工具下出现、马赛克粒度只在马赛克工具下出现**（各自的竖线一起显隐）。
 * @param {{html: string, css: string, js: string}} files
 * @returns {{ok: boolean, reason: string}}
 */
function toolbarPresentation(files) {
  const markup = files.html;
  const css = files.css;
  const text = files.js;
  // 图标：同一套 path 数据 + SVG 命名空间（与 client.js 的 toolIcon/undoIcon/redoIcon/closeIcon 同源）。
  for (const marker of [
    "createElementNS('http://www.w3.org/2000/svg'",
    'M8 2.5v11M2.5 8h11',
    'M3 12.5 12 3.5',
    'M6 4.5 3 7.5l3 3',
    'M10 4.5l3 3-3 3',
    'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6',
  ]) {
    if (!text.includes(marker)) return { ok: false, reason: `图标实现缺失: ${marker}` };
  }
  if (!/options\.icon !== undefined/.test(text)) return { ok: false, reason: 'button() 没有图标分支（图标按钮建不出来）' };
  for (const call of [
    '{ pressed: state.tool === id, icon: id }',
    "{ icon: 'undo' }",
    "{ icon: 'redo' }",
    "{ icon: 'close', iconSize: 14 }",
  ]) {
    if (!text.includes(call)) return { ok: false, reason: `没有用图标渲染: ${call}` };
  }
  // 条件分组：判据必须是"当前工具"，且按钮与竖线一起显隐。
  if (!/const showSizes = state\.tool === 'text';/.test(text)) return { ok: false, reason: '字号分组的判据不是文字工具' };
  if (!/const showMosaic = state\.tool === 'mosaic';/.test(text)) return { ok: false, reason: '粒度分组的判据不是马赛克工具' };
  for (const line of [
    "$('group-sizes').hidden = !showSizes;",
    "$('group-mosaic').hidden = !showMosaic;",
  ]) {
    if (!text.includes(line)) return { ok: false, reason: `分组显隐缺失: ${line}` };
  }
  // 竖线的显隐改由 ROW_STYLE_GROUPS 的循环统一推导（见下面的 t72 断言），这里只要求分组本身在位。
  if (!/const showSizes = state\.tool === 'text';/.test(text) || !/const showMosaic = state\.tool === 'mosaic';/.test(text)) {
    return { ok: false, reason: '字号/粒度分组的判据不是当前工具' };
  }
  // 字号 chip 必须真的写进 state（页面此前只有 state.textSizeKey，没有任何入口）。
  if (!/state\.textSizeKey = key;/.test(text)) return { ok: false, reason: '字号 chip 没有写入 state.textSizeKey（是个摆设）' };
  // 图标按钮也要有"不可用"的可见状态。
  if (!/historyButtons\[0\]\.disabled = !state\.history\.canUndo\(\)/.test(text)) {
    return { ok: false, reason: '撤销按钮没有按 canUndo() 禁用' };
  }
  if (!/historyButtons\[1\]\.disabled = !state\.history\.canRedo\(\)/.test(text)) {
    return { ok: false, reason: '重做按钮没有按 canRedo() 禁用' };
  }
  for (const id of ['group-sizes', 'divider-sizes', 'group-mosaic', 'divider-mosaic']) {
    if (!markup.includes(`id="${id}"`)) return { ok: false, reason: `index.html 缺少 ${id}` };
  }
  if (!markup.includes('id="group-sizes" hidden') || !markup.includes('id="group-mosaic" hidden')) {
    return { ok: false, reason: '两个条件分组必须默认隐藏（否则首帧会闪一下）' };
  }
  if (!/#toolbar \[hidden\] \{\s*display: none !important;/.test(css)) {
    return { ok: false, reason: 'CSS 没有让 [hidden] 压过 .group 的 inline-flex（分组藏不掉）' };
  }
  if (!/\.btn\.icon \{/.test(css)) return { ok: false, reason: 'CSS 没有图标按钮样式' };
  // t68：三个动作也是图标（插入 ✓ / 复制 / 另存为 ⤓），并与 ✕ 一起在第一行。
  for (const marker of ["d: 'M3.2 8.6l3.2 3.2 6.4-7.6'", "d: 'M8 2.6v7.2'", "d: 'M3 12.6h10'"]) {
    if (!text.includes(marker)) return { ok: false, reason: `动作图标缺失: ${marker}` };
  }
  for (const call of [
    "{ className: 'btn primary', icon: 'check', iconSize: 16 }",
    "{ icon: 'copy', iconSize: 16 }",
    "{ icon: 'download', iconSize: 16 }",
  ]) {
    if (!text.includes(call)) return { ok: false, reason: `动作没有用图标渲染: ${call}` };
  }
  if (!/\.btn\.primary\.icon \{\s*padding: 0;/.test(css)) {
    return { ok: false, reason: '主按钮的图标版没有去掉 padding（会被撑成椭圆）' };
  }
  // t69：✓（插入对话）必须是第一行的**最后一个**按钮 —— 顺序 复制 → 另存为 → 取消 → ✓。
  const actionAppends = [...text.matchAll(/actions\.appendChild\(button\(T\.(\w+)/g)].map((match) => match[1]);
  if (actionAppends.join(',') !== 'copy,save,cancel,insert') {
    return { ok: false, reason: `动作顺序应为 copy,save,cancel,insert（✓ 在最后），实际 [${actionAppends.join(', ')}]` };
  }
  // t68：线宽只在绘图工具下出现（马赛克有粒度、文字有字号），竖线一起显隐。
  if (!/const showWidths = WIDTH_TOOL_IDS\.includes\(state\.tool\);/.test(text)) {
    return { ok: false, reason: '线宽分组没有按当前工具显隐' };
  }
  if (!/\$\('group-widths'\)\.hidden = !showWidths;/.test(text)) {
    return { ok: false, reason: '线宽分组没有跟着显隐' };
  }
  if (!/const WIDTH_TOOL_IDS = Object\.freeze\(TOOL_IDS\.filter\(\(id\) => id !== 'mosaic' && id !== 'text'\)\);/.test(text)) {
    return { ok: false, reason: 'WIDTH_TOOL_IDS 不是从 lib 的 TOOL_IDS 派生的（会与 lib 漂移）' };
  }
  // t72（用户口径）：颜色只在"会落色"的工具下出现（矩形/椭圆/箭头/画笔/文字；移动与马赛克都不显示）。
  if (!/const showColors = COLOR_TOOL_IDS\.includes\(state\.tool\);/.test(text)) {
    return { ok: false, reason: '色板没有按当前工具显隐（移动工具下不该有颜色）' };
  }
  if (!/\$\('group-colors'\)\.hidden = !showColors;/.test(text)) {
    return { ok: false, reason: '色板分组没有跟着显隐' };
  }
  if (!/const COLOR_TOOL_IDS = Object\.freeze\(TOOL_IDS\.filter\(\(id\) => id !== 'mosaic'\)\);/.test(text)) {
    return { ok: false, reason: 'COLOR_TOOL_IDS 不是从 lib 的 TOOL_IDS 派生的（会与 lib 漂移）' };
  }
  // 竖线统一按"后面可见 + 前面已有可见分组"推导，否则马赛克工具下会在行首留一根孤线。
  if (!/const ROW_STYLE_GROUPS = Object\.freeze\(\[/.test(text)) {
    return { ok: false, reason: '没有第二行的分组顺序表（竖线推导无从谈起）' };
  }
  if (!/divider\.hidden = !\(visible && seenGroup\);/.test(text)) {
    return { ok: false, reason: '竖线不是按"后面可见 + 前面有可见分组"推导的（会留孤立竖线）' };
  }
  // t66：两行是**结构**（两个 .row），不靠自动折行 —— 折点随机、长短不齐很难看。
  for (const id of ['row-tools', 'row-style']) {
    if (!markup.includes(`class="row" id="${id}"`)) return { ok: false, reason: `index.html 缺少行容器 ${id}` };
  }
  if ((markup.match(/class="row"/g) ?? []).length !== 2) return { ok: false, reason: '工具栏必须恰好两行按钮' };
  if (!/flex-direction: column;/.test(css)) return { ok: false, reason: 'CSS 没把工具栏做成纵向两行' };
  if (!/\.row \{\s*display: flex;/.test(css)) return { ok: false, reason: 'CSS 没有 .row 的行内布局' };
  if (!/\.grow \{\s*flex: 1 1 auto;/.test(css)) return { ok: false, reason: 'CSS 没有行尾撑开的 .grow（右侧尺寸/动作贴不到行尾）' };
  if (!markup.includes('id="size-label"')) return { ok: false, reason: 'index.html 缺少输出尺寸标签' };
  if (!/sizeLabelEl\.textContent = `\$\{deviceWidth\} × \$\{deviceHeight\} px`/.test(text)) {
    return { ok: false, reason: '尺寸标签没有被填充（形同虚设）' };
  }
  // t68：第一行 = 工具 + 撤销/重做 + 四个动作图标；第二行 = 色板 + 档位 + 右侧尺寸。
  const rowTools = markup.slice(markup.indexOf('id="row-tools"'), markup.indexOf('id="row-style"'));
  for (const id of ['group-tools', 'group-history', 'group-actions']) {
    if (!rowTools.includes(`id="${id}"`)) return { ok: false, reason: `第一行缺少 ${id}` };
  }
  if (rowTools.includes('group-colors') || rowTools.includes('group-widths')) {
    return { ok: false, reason: '色板/线宽还留在第一行（应归第二行）' };
  }
  const rowStyle = markup.slice(markup.indexOf('id="row-style"'));
  for (const id of ['group-colors', 'group-widths', 'group-sizes', 'group-mosaic', 'size-label']) {
    if (!rowStyle.includes(`id="${id}"`)) return { ok: false, reason: `第二行缺少 ${id}` };
  }
  if (rowStyle.includes('group-actions')) return { ok: false, reason: '动作还留在第二行（t68 要求搬到第一行）' };
  return { ok: true, reason: '' };
}

/**
 * 契约 7（t70）：已放置标注的**选中 / 拖动 / 缩放 / 删除**，以及"标注 = 设备像素"这条 lib 约定。
 *
 * 背景：面板此前把标注存成视口坐标、绘制时才乘比例（与 lib 的 `annotationRect`/`hitAnnotation`/
 * `drawAnnotation` 文档约定相反，比例为 1 时才恰好相等），并且**完全没有**标注选中/拖动逻辑 ——
 * 用户实测"绘制的文字无法拖拽移动"。这里把"统一按设备像素 + 复用 lib 的命中/位移/缩放"钉死。
 * @param {{html: string, css: string, js: string}} files
 * @returns {{ok: boolean, reason: string}}
 */
function annotationEditingContract(files) {
  const markup = files.html;
  const css = files.css;
  const text = files.js;
  // 1) 纯逻辑一律复用 lib（不复制命中/位移/缩放实现）。
  for (const helper of ['annotationRect', 'findAnnotationAt', 'hitAnnotationHandle', 'moveAnnotation', 'resizeAnnotationRect', 'scaleAnnotation']) {
    if (!text.includes(helper)) return { ok: false, reason: `标注编辑没有复用 lib 的 ${helper}` };
  }
  // 2) 入口把视口坐标换算成设备坐标；绘制按设备坐标（恒等变换）。
  if (!/function toDevice\(point\) \{/.test(text)) return { ok: false, reason: '没有 toDevice（视口坐标 → 设备坐标）换算' };
  const ink = sliceFunction(text, 'function paintInk() {');
  if (ink === null) return { ok: false, reason: '找不到 paintInk' };
  if (/setTransform\(sx, 0, 0, sy, 0, 0\)/.test(ink)) {
    return { ok: false, reason: '标注仍然在绘制时才乘视口比例（应统一存设备像素）' };
  }
  if (!/ctx\.setTransform\(1, 0, 0, 1, 0, 0\);/.test(ink)) {
    return { ok: false, reason: '标注层没有（在绘制前）明确回到设备坐标的恒等变换' };
  }
  if (!/drawAnnotation\(ctx, preview === null \? present\[index\] : preview, environment\)/.test(ink)) {
    return { ok: false, reason: '标注层没有画已放置标注（或没带拖动预览值）' };
  }
  if (!/selectionBoundsDevice\(selection\)/.test(ink)) return { ok: false, reason: '标注层的裁剪没走设备空间的选区' };
  const editor = sliceFunction(text, 'function commitEditor() {');
  if (editor === null) return { ok: false, reason: '找不到 commitEditor' };
  if (!/const device = toDevice\(point\);/.test(editor)) return { ok: false, reason: '文字标注没有换算到设备坐标' };
  // 3) 指针：移动工具下先看角把手、再看命中、都没中才拖选区。
  const down = sliceFunction(text, 'function onPointerDown(event) {');
  if (down === null) return { ok: false, reason: '找不到 onPointerDown' };
  for (const marker of ['annotate-resize', 'annotate-move', 'hitAnnotationHandle(', 'findAnnotationAt(']) {
    if (!down.includes(marker)) return { ok: false, reason: `指针按下没有处理 ${marker}` };
  }
  if (!/findAnnotationAt\(state\.history\.present, device,/.test(down)) {
    return { ok: false, reason: '命中判定没有用设备坐标（会重演"拖不动"）' };
  }
  const move = sliceFunction(text, 'function onPointerMove(event) {');
  if (move === null) return { ok: false, reason: '找不到 onPointerMove' };
  if (!/moveAnnotation\(drag\.annotationOriginal, dx, dy, bounds/.test(move)) return { ok: false, reason: '拖动没有走 lib 的 moveAnnotation（不会被夹在选区内）' };
  if (!/resizeAnnotationRect\([\s\S]{0,200}?MIN_ANNOTATION_EDGE/.test(move)) return { ok: false, reason: '角把手缩放没有走 lib 的 resizeAnnotationRect' };
  if (!/scaleAnnotation\(drag\.annotationOriginal, nextRect\)/.test(move)) return { ok: false, reason: '缩放没有走 lib 的 scaleAnnotation' };
  // 4) 收尾：一次拖拽 = 一条历史（替换而不是追加）。
  if (!/function commitAnnotationReplacement\(index, annotation\) \{/.test(text)) return { ok: false, reason: '没有"替换某条标注"的提交路径' };
  const up = sliceFunction(text, 'function onPointerUp(event) {');
  if (up === null) return { ok: false, reason: '找不到 onPointerUp' };
  if (!/commitAnnotationReplacement\(drag\.annotationIndex, drag\.annotation\)/.test(up)) {
    return { ok: false, reason: '拖动收尾没有写回历史（松手就丢了）' };
  }
  // 5) Delete / Backspace 删除选中标注。
  if (!/function deleteSelectedAnnotation\(\) \{/.test(text)) return { ok: false, reason: '没有删除选中标注的实现' };
  if (!/event\.key === 'Delete' \|\| event\.key === 'Backspace'/.test(text)) return { ok: false, reason: '没有 Delete/Backspace 处理' };
  // 6) 选中框与 4 个角把手：DOM + 样式 + 每帧摆放。
  if (!markup.includes('id="annotation-box"')) return { ok: false, reason: 'index.html 缺少选中框 #annotation-box' };
  if ((markup.match(/class="annot-handle"/g) ?? []).length !== 4) return { ok: false, reason: 'index.html 必须有 4 个标注角把手' };
  if (!/#annotation-box \{[\s\S]{0,120}?border: 1px dashed/.test(css)) return { ok: false, reason: '选中框不是虚线（与选区实线框区分不开）' };
  if (!/\.annot-handle \{/.test(css)) return { ok: false, reason: 'CSS 没有角把手样式' };
  const chrome = sliceFunction(text, 'function paintChrome() {');
  if (chrome === null) return { ok: false, reason: '找不到 paintChrome' };
  if (!/place\(annotationBoxEl,/.test(chrome) || !/annotationHandles\(box\)/.test(chrome)) {
    return { ok: false, reason: '选中框/角把手没有每帧摆放（用户看不到选中态）' };
  }
  if (!/previewingSelection/.test(chrome)) return { ok: false, reason: '拖动中的预览值会被当成失效选中而被清掉' };
  // 7) t71（用户口径）：**悬停即手柄**（不要求先切工具/先单击），且手柄状态下双击可改文字。
  if (!/function hoverCursor\(target\) \{/.test(text)) return { ok: false, reason: '没有悬停光标判定（鼠标进标注范围不会变手柄）' };
  const hover = sliceFunction(text, 'function hoverCursor(target) {');
  if (hover === null) return { ok: false, reason: '找不到 hoverCursor' };
  if (!/findAnnotationAt\(state\.history\.present, device, hitToleranceDevice\(\)\) !== -1\) return 'move'/.test(hover)) {
    return { ok: false, reason: '悬停到已放置标注时没有给出拖拽手柄光标' };
  }
  if (!/hitAnnotationHandle\(annotationRect\(selected\), device, handleToleranceDevice\(\)\)/.test(hover)) {
    return { ok: false, reason: '悬停在角把手上没有给出缩放光标' };
  }
  if (!/state\.tool === TOOL_MOVE\) return 'move'/.test(hover)) return { ok: false, reason: '悬停在选区内部时丢掉了移动光标' };
  if (!/document\.addEventListener\('pointermove'/.test(text) || !/hoverCursor\(event\.target\)/.test(text)) {
    return { ok: false, reason: '指针移动时没有更新悬停光标' };
  }
  if (!/function onDoubleClick\(event\) \{/.test(text)) return { ok: false, reason: '没有双击处理' };
  if (!/document\.addEventListener\('dblclick', onDoubleClick, true\)/.test(text)) return { ok: false, reason: '双击监听没有注册' };
  const dbl = sliceFunction(text, 'function onDoubleClick(event) {');
  if (dbl === null) return { ok: false, reason: '找不到 onDoubleClick' };
  if (!/annotation\.tool !== 'text'/.test(dbl)) return { ok: false, reason: '双击没有限定"只对文字标注"生效' };
  if (!/openEditor\(toCssRect\(annotationRect\(annotation\)\), \{ index, annotation \}\)/.test(dbl)) {
    return { ok: false, reason: '双击没有进入"改文字"模式（只带点不带原值）' };
  }
  if (!/function openEditor\(point, editing = null\) \{/.test(text)) return { ok: false, reason: 'openEditor 没有编辑态参数' };
  const commit = sliceFunction(text, 'function commitEditor() {');
  if (commit === null) return { ok: false, reason: '找不到 commitEditor' };
  if (!/commitAnnotationReplacement\(editing\.index, next\)/.test(commit)) {
    return { ok: false, reason: '改文字没有替换原条目（会变成再插一条）' };
  }
  if (!/editorEl\.value = editing === null \? '' : String\(editing\.annotation\.text \?\? ''\)/.test(text)) {
    return { ok: false, reason: '双击进入时输入框没有回填原文字' };
  }
  // 拖动已放置标注不再被"当前工具"挡住（t71：悬停即手柄、按下即拖）。
  const downFn = sliceFunction(text, 'function onPointerDown(event) {');
  const annotationBranch = downFn === null ? '' : downFn.slice(downFn.indexOf('const hitIndex = findAnnotationAt('), downFn.indexOf("} else if (state.tool === 'text')"));
  if (annotationBranch.includes("state.tool === TOOL_MOVE")) {
    return { ok: false, reason: '拖动标注仍然被"必须先在移动工具下"挡住' };
  }
  return { ok: true, reason: '' };
}

/**
 * 取出一个函数声明的完整源码（按大括号配对）。
 * @param {string} text @param {string} signature @returns {string|null}
 */
function sliceFunction(text, signature) {
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

/**
 * 契约 4：六类工具 / 六色 / 三档线宽 / 撤销重做 / 三动作 + 取消 / Esc + Ctrl+Z/Ctrl+Y /
 * 拖动实时可见（裁剪成对 save/restore）。
 * @param {string} text
 * @returns {{ok: boolean, reason: string}}
 */
function interactionContract(text) {
  if (!/TOOL_IDS/.test(text) || !/TOOL_MOVE/.test(text)) return { ok: false, reason: '没有用 lib 的工具集合（含移动）' };
  for (const helper of ['createShape', 'createStroke', 'createText', 'drawAnnotation']) {
    if (!text.includes(helper)) return { ok: false, reason: `没有复用 lib 的 ${helper}` };
  }
  if (!/COLORS/.test(text) || !/LINE_WIDTH_ORDER/.test(text)) return { ok: false, reason: '颜色/线宽没有走 lib 的调色板与档位' };
  if (!/createHistory\(\)/.test(text) || !/history\.undo\(\)/.test(text) || !/history\.redo\(\)/.test(text)) {
    return { ok: false, reason: '撤销重做没有走 lib 的 createHistory' };
  }
  if (!/key !== 'z'/.test(text) || !/key !== 'y'/.test(text)) return { ok: false, reason: '没有 Ctrl+Z / Ctrl+Y 快捷键' };
  if (!/event\.key === 'Escape'/.test(text)) return { ok: false, reason: '没有 Esc 取消' };
  if (!/contextmenu/.test(text)) return { ok: false, reason: '没有右键取消' };
  for (const action of ["'insert'", "'copy'", "'save'", "'cancel'"]) {
    if (!text.includes(action)) return { ok: false, reason: `缺少动作 ${action}` };
  }
  if (!/void submit\('insert'\)/.test(text)) return { ok: false, reason: '插入对话不是默认动作' };
  // 拖动实时可见：草稿必须被画出来，且裁剪成对（U-02 的教训）。
  if (!/drag\.draft !== null/.test(text) || !/drawAnnotation\(ctx, drag\.draft/.test(text)) {
    return { ok: false, reason: '拖动中的草稿没有被绘制（会重演 U-02）' };
  }
  const ink = text.slice(text.indexOf('function paintInk()'), text.indexOf('// ─── 标注提交'));
  const saveAt = ink.indexOf('ctx.save()');
  const clipAt = ink.indexOf('ctx.clip()');
  const restoreAt = ink.indexOf('ctx.restore()');
  const clearAt = ink.indexOf('ctx.clearRect(');
  if (saveAt === -1 || clipAt === -1 || restoreAt === -1) {
    return { ok: false, reason: '标注层裁剪没有成对 save/clip/restore（会重演 U-02）' };
  }
  if (!(saveAt < clipAt && clipAt < restoreAt)) return { ok: false, reason: 'save → clip → restore 顺序不对' };
  if (clearAt === -1 || clearAt > clipAt) return { ok: false, reason: 'clearRect 必须在裁剪之前（否则清屏被裁、选区外留残影）' };
  if (!/if \(clipped\) ctx\.restore\(\)/.test(ink)) return { ok: false, reason: 'restore 没有和 clipped 开关配对' };
  return { ok: true, reason: '' };
}

/**
 * 契约：输出与提交（只含选区+标注、只发 {action, png}、MIME 走 formatOf、降级走 sizeAttempts）。
 * @param {string} text @returns {{ok: boolean, reason: string}}
 */
function outputContract(text) {
  const render = text.slice(text.indexOf('function renderSelection('), text.indexOf('/** @param {HTMLCanvasElement} canvas'));
  if (render === '') return { ok: false, reason: '找不到 renderSelection（导出合成）' };
  if (!/plan\.deviceRect/.test(render)) return { ok: false, reason: '导出没有按 plan.deviceRect 裁剪选区' };
  if (!/drawImage\(state\.frame, 0, 0\)/.test(render)) return { ok: false, reason: '导出没有把冻结帧画进新画布' };
  if (!/for \(const annotation of state\.history\.present\)/.test(render)) return { ok: false, reason: '导出没有把已放置标注画进去' };
  if (/mask|toolbar|badge|selectionEl|crossXEl/.test(render)) {
    return { ok: false, reason: '导出画布上出现了遮罩/工具栏等 chrome（产物必须只含选区+标注）' };
  }
  if (!/sizeAttempts\(plan, policy\)/.test(text)) return { ok: false, reason: '没有走 lib 的 sizeAttempts 降级链' };
  if (!/resolveSizePolicy\(/.test(text) || !/DEFAULT_MAX_BYTES/.test(text) || !/DEFAULT_MAX_EDGE/.test(text)) {
    return { ok: false, reason: '没有用 lib 的体积/边长策略（R-01/D-8 的既有降级）' };
  }
  if (!/formatOf\(encoded\.mediaType\)/.test(text)) return { ok: false, reason: 'MIME/扩展名没有取自 lib 的 formatOf（可能重演 R-01）' };
  if (!/blobToDataUrl\(encoded\.blob\)/.test(text)) return { ok: false, reason: '提交的数据不是由 lib 的 blobToDataUrl 产出' };
  if (!/const body = dataUrl === null \? \{ action \} : \{ action, png: dataUrl \};/.test(text)) {
    return { ok: false, reason: '提交体不是冻结契约的 {action, png}（多字段/少字段都会漂移）' };
  }
  if (!/method: 'POST'/.test(text)) return { ok: false, reason: '结果没有用 POST 提交' };
  if (/navigator\.clipboard|createObjectURL\(.*download|\.download =/.test(text)) {
    return { ok: false, reason: '页面自己写剪贴板/下载文件（动作必须由 DSH 侧执行）' };
  }
  return { ok: true, reason: '' };
}

/**
 * 契约：心跳（≤1s）与关窗。
 * @param {string} text @returns {{ok: boolean, reason: string}}
 */
function heartbeatContract(text) {
  const interval = /const HEARTBEAT_MS = (\d+);/.exec(text);
  if (interval === null) return { ok: false, reason: '找不到心跳间隔常量' };
  if (Number(interval[1]) > 1000) return { ok: false, reason: `心跳间隔 ${interval[1]}ms 超过 1s` };
  if (!/window\.setInterval\(\(\) => \{[\s\S]*?withToken\(ENDPOINTS\.ping\)/.test(text)) {
    return { ok: false, reason: '心跳没有定时打 ping 端点' };
  }
  if (!/window\.close\(\)/.test(text)) return { ok: false, reason: '提交/取消后没有关窗' };
  return { ok: true, reason: '' };
}

/**
 * 契约：无障碍（按钮 aria-label、可 Tab、工具栏 role）。
 * @param {string} text @param {string} markup @returns {{ok: boolean, reason: string}}
 */
function accessibilityContract(text, markup) {
  if (!/role="toolbar"/.test(markup)) return { ok: false, reason: '工具栏没有 role="toolbar"' };
  if (!/role="status"/.test(markup)) return { ok: false, reason: '提示条没有 role="status"（读屏拿不到反馈）' };
  if (!/element\.type = 'button'/.test(text)) return { ok: false, reason: '按钮不是 <button type="button">（Tab 不可达/可误提交）' };
  if (!/setAttribute\('aria-label'/.test(text)) return { ok: false, reason: '按钮没有 aria-label' };
  if (!/setAttribute\('aria-pressed'/.test(text)) return { ok: false, reason: '工具/颜色没有 aria-pressed 选中态' };
  if (!/aria-label="标注文字/.test(markup)) return { ok: false, reason: '文字输入框没有 aria-label' };
  return { ok: true, reason: '' };
}

// ── 正向断言 ───────────────────────────────────────────────────────────────

test('(t57-1) the page uses only the frozen overlay endpoints, reads its own token and reuses lib from the host', () => {
  const result = frozenSeamAndReuse({ html, css, js });
  assert.equal(result.ok, true, result.reason);
});

test('(t57-2) the frozen frame is drawn 1:1 and selection reuses the lib geometry/validity rules', () => {
  const result = oneToOneSelection(js);
  assert.equal(result.ok, true, result.reason);
});

test('(t57-3) six tools + palette + widths + undo/redo + live draft with paired clipping', () => {
  const result = interactionContract(js);
  assert.equal(result.ok, true, result.reason);
});

test('(t57-4) the submitted PNG is selection+annotations only, with the frozen {action, png} body and lib-driven downgrade', () => {
  const result = outputContract(js);
  assert.equal(result.ok, true, result.reason);
});

test('(t57-5) heartbeat is <= 1s, cancel closes the window, and the UI stays accessible', () => {
  assert.equal(heartbeatContract(js).ok, true, heartbeatContract(js).reason);
  assert.equal(accessibilityContract(js, html).ok, true, accessibilityContract(js, html).reason);
});

test('(t65-1) the toolbar is icon-driven, and the size/granularity groups follow the current tool', () => {
  const result = toolbarPresentation({ html, css, js });
  assert.equal(result.ok, true, result.reason);
});

test('(t70-1) placed annotations are selectable/draggable/scalable/deletable, all in device pixels via lib', () => {
  const result = annotationEditingContract({ html, css, js });
  assert.equal(result.ok, true, result.reason);
});

// ── 负样本 ─────────────────────────────────────────────────────────────────

test('(t57-6) negative samples: copying lib, drifting the body, slowing the heartbeat or dropping the token fails', () => {
  // 负样本 1：把 lib 的实现抄一份进页面（含内部标识）→ no-copy 断言必须失败。
  const copied = `${js}\nconst BOUNDS_EPSILON = 0.5;\nfunction planRender(capture, selectionCss) { return {}; }\n`;
  const copiedResult = frozenSeamAndReuse({ html, css, js: copied });
  assert.equal(copiedResult.ok, false, '抄了一份 planRender/BOUNDS_EPSILON 仍通过 = 单一真相防线失效');
  assert.match(copiedResult.reason, /lib 实现痕迹/);

  // 负样本 2：提交体多一个字段 → 冻结契约断言必须失败。
  const drifted = js.replace(
    'const body = dataUrl === null ? { action } : { action, png: dataUrl };',
    'const body = dataUrl === null ? { action } : { action, png: dataUrl, mediaType: formatOf("image/png").mediaType };',
  );
  assert.notEqual(drifted, js, '提交体字面量不存在，负样本无从构造');
  assert.equal(outputContract(drifted).ok, false, '提交体漂移后仍通过 = 冻结接口防线失效');

  // 负样本 3：心跳放到 5s → 心跳契约必须失败。
  const slowPing = js.replace('const HEARTBEAT_MS = 1000;', 'const HEARTBEAT_MS = 5000;');
  assert.notEqual(slowPing, js, '心跳常量不存在，负样本无从构造');
  assert.equal(heartbeatContract(slowPing).ok, false, '心跳 5s 仍通过 = seam 防线失效');

  // 负样本 4：不读 token（写死空串）→ 冻结接口断言必须失败。
  const noToken = js.replace("const token = params.get('token') ?? '';", "const token = '';");
  assert.notEqual(noToken, js, 'token 读取不存在，负样本无从构造');
  assert.equal(frozenSeamAndReuse({ html, css, js: noToken }).ok, false, '不读 token 仍通过 = 冻结接口防线失效');

  // 负样本 5：去掉裁剪的 restore（重演 U-02）→ 交互契约必须失败。
  const unbalanced = js.replace('if (clipped) ctx.restore();', '');
  assert.notEqual(unbalanced, js, 'restore 行不存在，负样本无从构造');
  assert.equal(interactionContract(unbalanced).ok, false, '裁剪不成对仍通过 = U-02 防线失效');

  // 负样本 6：把遮罩画进导出画布 → 产物纯净断言必须失败。
  const polluted = js.replace(
    'ctx.drawImage(state.frame, 0, 0);',
    'ctx.drawImage(state.frame, 0, 0);\n  ctx.fillStyle = masks.all.style.background;',
  );
  assert.notEqual(polluted, js, '导出合成行不存在，负样本无从构造');
  assert.equal(outputContract(polluted).ok, false, '导出画布上画了 chrome 仍通过 = 产物纯净防线失效');

  // 负样本 7：页面资源退回相对路径（与宿主资产前缀不一致，实机 404）→ 组成断言必须失败。
  const relativeAssets = html
    .replace(`${ASSET_PREFIX}overlay.js`, './overlay.js')
    .replace(`${ASSET_PREFIX}overlay.css`, './overlay.css');
  assert.notEqual(relativeAssets, html, '资产前缀不存在，负样本无从构造');
  assert.equal(frozenSeamAndReuse({ html: relativeAssets, css, js }).ok, false, '退回相对路径仍通过 = 资产前缀防线失效');

  // 负样本 7b（t67）：把模式读死成 through（普通模式下画面含 DSH 却不提示）→ 组成断言必须失败。
  const modeIgnored = js.replace("params.get('mode') === 'normal' ? 'normal' : 'through'", "'through'");
  assert.notEqual(modeIgnored, js, '模式读取不存在，负样本无从构造');
  assert.equal(frozenSeamAndReuse({ html, css, js: modeIgnored }).ok, false, '忽略 mode 仍通过 = 普通模式提示防线失效');

  // 负样本 8：把冻结帧层改回"跟 ink 一样乘 CSS→设备比例"（t64 的 latent 耦合）→ 1:1 断言必须失败。
  const coupled = js.replace(
    /setTransform\(1, 0, 0, 1, 0, 0\);\n(\s*)ctx\.clearRect\(0, 0, baseCanvas\.width, baseCanvas\.height\);\n\s*ctx\.drawImage\(state\.frame, 0, 0\);/,
    (match, indent) => match.replace(`setTransform(1, 0, 0, 1, 0, 0);`, 'setTransform(sx, 0, 0, sy, 0, 0);'),
  );
  assert.notEqual(coupled, js, '冻结帧恒等变换不存在，负样本无从构造');
  assert.equal(oneToOneSelection(coupled).ok, false, '帧层套用 CSS→设备比例仍通过 = 1:1 防线失效');

  // 负样本 9：粒度分组变回"常显"（t65 之前的样子）→ 呈现契约必须失败。
  const alwaysMosaic = js.replace("$('group-mosaic').hidden = !showMosaic;", "$('group-mosaic').hidden = false;");
  assert.notEqual(alwaysMosaic, js, '粒度分组显隐行不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html, css, js: alwaysMosaic }).ok, false, '粒度常显仍通过 = 条件分组防线失效');

  // 负样本 10：工具按钮退回文字（去掉 icon）→ 呈现契约必须失败。
  const textTools = js.replace('{ pressed: state.tool === id, icon: id }', '{ pressed: state.tool === id }');
  assert.notEqual(textTools, js, '工具按钮的 icon 选项不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html, css, js: textTools }).ok, false, '工具退回文字仍通过 = 图标防线失效');

  // 负样本 11：CSS 去掉 [hidden] 覆盖（.group 的 inline-flex 会盖掉 hidden）→ 呈现契约必须失败。
  const noHiddenRule = css.replace('#toolbar [hidden] {\n  display: none !important;\n}\n\n', '');
  assert.notEqual(noHiddenRule, css, '[hidden] 规则不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html, css: noHiddenRule, js }).ok, false, '去掉 [hidden] 覆盖仍通过 = 显隐防线失效');

  // 负样本 12：把两行压回一行（去掉行容器）→ 两行契约必须失败。
  const oneRow = html.replace('<div class="row" id="row-tools">', '<div id="row-tools">').replace('<div class="row" id="row-style">', '<div id="row-style">');
  assert.notEqual(oneRow, html, '行容器不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html: oneRow, css, js }).ok, false, '退回一行仍通过 = 两行防线失效');

  // 负样本 13：把色板塞回第一行 → 行归属契约必须失败。
  const wrongRow = html.replace('<div class="row" id="row-style">', '<div class="group" id="group-colors"></div><div class="row" id="row-style">');
  assert.notEqual(wrongRow, html, '第二行容器不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html: wrongRow, css, js }).ok, false, '色板跑到第一行仍通过 = 行归属防线失效');

  // 负样本 14（t68）：线宽变回常显（马赛克/文字下也显示粗细）→ 呈现契约必须失败。
  const alwaysWidths = js.replace("$('group-widths').hidden = !showWidths;", "$('group-widths').hidden = false;");
  assert.notEqual(alwaysWidths, js, '线宽显隐行不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html, css, js: alwaysWidths }).ok, false, '线宽常显仍通过 = 档位按工具显隐的防线失效');

  // 负样本 14b（t72）：色板变回常显（移动/马赛克下也显示颜色）→ 呈现契约必须失败。
  const alwaysColors = js.replace("$('group-colors').hidden = !showColors;", "$('group-colors').hidden = false;");
  assert.notEqual(alwaysColors, js, '色板显隐行不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html, css, js: alwaysColors }).ok, false, '色板常显仍通过 = 颜色按工具显隐的防线失效');

  // 负样本 14c（t72）：色板把马赛克也算进去（马赛克下显示颜色）→ 呈现契约必须失败。
  const mosaicColors = js.replace(
    "const COLOR_TOOL_IDS = Object.freeze(TOOL_IDS.filter((id) => id !== 'mosaic'));",
    'const COLOR_TOOL_IDS = Object.freeze([...TOOL_IDS]);',
  );
  assert.notEqual(mosaicColors, js, 'COLOR_TOOL_IDS 派生行不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html, css, js: mosaicColors }).ok, false, '马赛克也显示颜色仍通过 = 派生清单防线失效');

  // 负样本 15（t68）：动作退回文字按钮 → 呈现契约必须失败。
  const textActions = js.replace("{ className: 'btn primary', icon: 'check', iconSize: 16 }", "{ className: 'btn primary' }");
  assert.notEqual(textActions, js, '插入动作的 icon 选项不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html, css, js: textActions }).ok, false, '动作退回文字仍通过 = 动作图标防线失效');

  // 负样本 16（t68）：把动作搬回第二行 → 行归属契约必须失败。
  const actionsBack = html
    .replace('      <span class="grow" aria-hidden="true"></span>\n      <div class="group" id="group-actions"></div>\n', '')
    .replace('      <span class="label" id="size-label" aria-live="off"></span>', '      <span class="label" id="size-label" aria-live="off"></span>\n      <div class="group" id="group-actions"></div>');
  assert.notEqual(actionsBack, html, '动作容器不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html: actionsBack, css, js }).ok, false, '动作搬回第二行仍通过 = 行归属防线失效');

  // 负样本 17（t69）：把 ✓ 挪回最前（顺序变回 insert,copy,save,cancel）→ 顺序契约必须失败。
  const checkFirst = js.replace(
    "  actions.appendChild(button(T.copy, T.copy, () => void submit('copy'), { icon: 'copy', iconSize: 16 }));\n  actions.appendChild(button(T.save, T.save, () => void submit('save'), { icon: 'download', iconSize: 16 }));\n  actions.appendChild(button(T.cancel, T.cancel, () => void cancel('toolbar'), { icon: 'close', iconSize: 14 }));\n  actions.appendChild(button(T.insert, `${T.insert}（默认动作）`, () => void submit('insert'), { className: 'btn primary', icon: 'check', iconSize: 16 }));",
    "  actions.appendChild(button(T.insert, `${T.insert}（默认动作）`, () => void submit('insert'), { className: 'btn primary', icon: 'check', iconSize: 16 }));\n  actions.appendChild(button(T.copy, T.copy, () => void submit('copy'), { icon: 'copy', iconSize: 16 }));\n  actions.appendChild(button(T.save, T.save, () => void submit('save'), { icon: 'download', iconSize: 16 }));\n  actions.appendChild(button(T.cancel, T.cancel, () => void cancel('toolbar'), { icon: 'close', iconSize: 14 }));",
  );
  assert.notEqual(checkFirst, js, '动作追加块不存在，负样本无从构造');
  assert.equal(toolbarPresentation({ html, css, js: checkFirst }).ok, false, '✓ 回到最前仍通过 = 顺序防线失效');

  // 负样本 18（t70）：命中判定退回视口坐标（"拖不动文字"的原样）→ 编辑契约必须失败。
  // 注意要把**所有**命中调用点一起换掉（按下、悬停光标、双击各有一处）。
  const cssHit = js
    .split('findAnnotationAt(state.history.present, device, hitToleranceDevice())')
    .join('findAnnotationAt(state.history.present, point, hitToleranceDevice())');
  assert.notEqual(cssHit, js, '命中判定行不存在，负样本无从构造');
  assert.equal(annotationEditingContract({ html, css, js: cssHit }).ok, false, '命中用视口坐标仍通过 = 设备空间防线失效');

  // 负样本 19（t70）：标注层退回"绘制时乘视口比例"→ 编辑契约必须失败。
  const inkScaled = js.replace(
    '  // t70：标注就是**设备像素**（lib 的约定）—— 画的时候不再乘视口比例；被拖动中的那一条用预览值。\n  ctx.setTransform(1, 0, 0, 1, 0, 0);',
    '  ctx.setTransform(sx, 0, 0, sy, 0, 0);',
  );
  assert.notEqual(inkScaled, js, '标注层的恒等变换不存在，负样本无从构造');
  assert.equal(annotationEditingContract({ html, css, js: inkScaled }).ok, false, '标注层乘比例仍通过 = 设备空间防线失效');

  // 负样本 20（t70）：删掉拖动收尾的写回 → 编辑契约必须失败（松手即丢）。
  const noCommit = js.replace('commitAnnotationReplacement(drag.annotationIndex, drag.annotation)', 'schedule()');
  assert.notEqual(noCommit, js, '拖动收尾调用不存在，负样本无从构造');
  assert.equal(annotationEditingContract({ html, css, js: noCommit }).ok, false, '不写回历史仍通过 = 拖动提交防线失效');

  // 负样本 21（t70）：删掉 Delete 分支 → 编辑契约必须失败。
  const noDelete = js.replace("if (event.key === 'Delete' || event.key === 'Backspace') {", "if (event.key === 'F9') {");
  assert.notEqual(noDelete, js, 'Delete 分支不存在，负样本无从构造');
  assert.equal(annotationEditingContract({ html, css, js: noDelete }).ok, false, '没有删除快捷键仍通过 = 删除防线失效');

  // 负样本 22（t71）：悬停不再给拖拽手柄（鼠标进入标注范围没有光标反馈）→ 编辑契约必须失败。
  const noHoverHandle = js.replace("if (findAnnotationAt(state.history.present, device, hitToleranceDevice()) !== -1) return 'move';", '');
  assert.notEqual(noHoverHandle, js, '悬停手柄分支不存在，负样本无从构造');
  assert.equal(annotationEditingContract({ html, css, js: noHoverHandle }).ok, false, '悬停不变手柄仍通过 = 悬停反馈防线失效');

  // 负样本 23（t71）：删掉双击监听 → 编辑契约必须失败（文字改不了）。
  const noDbl = js.replace("document.addEventListener('dblclick', onDoubleClick, true);", '');
  assert.notEqual(noDbl, js, '双击监听不存在，负样本无从构造');
  assert.equal(annotationEditingContract({ html, css, js: noDbl }).ok, false, '没有双击编辑仍通过 = 编辑防线失效');

  // 负样本 24（t71）：把"改文字"退回"再插一条"→ 编辑契约必须失败。
  const appendOnEdit = js.replace('commitAnnotationReplacement(editing.index, next)', 'commitAnnotation(next)');
  assert.notEqual(appendOnEdit, js, '编辑提交行不存在，负样本无从构造');
  assert.equal(annotationEditingContract({ html, css, js: appendOnEdit }).ok, false, '编辑变成新增仍通过 = 替换防线失效');

  // 负样本 25（t71）：把拖动标注重新绑回"移动工具"→ 编辑契约必须失败（又要手动切工具）。
  const toolGated = js.replace(
    '      } else if (hitIndex !== -1) {',
    "      } else if (hitIndex !== -1 && state.tool === TOOL_MOVE) {",
  );
  assert.notEqual(toolGated, js, '命中分支不存在，负样本无从构造');
  assert.equal(annotationEditingContract({ html, css, js: toolGated }).ok, false, '拖动被工具挡住仍通过 = 悬停即拖防线失效');
});
