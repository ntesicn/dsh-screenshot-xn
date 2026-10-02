/**
 * t75：面板侧（`overlay/`）的离线契约：**区域识别 + 翻译**。
 *
 * 面板跑在独立浏览器窗口里，离线只能做静态契约 —— 与 `overlay-page.test.mjs` 同一套路，
 * 但这里是新功能的**专属防线**，逐条钉住四件容易悄悄退化的事：
 *
 *  1. **动作词表不许被撑开**：validate.mjs 的 X-1 把页面里 `submit('x')`/`postResult('x')` 的
 *     实参当成"提交给宿主的动作"，只允许 insert/copy/save/cancel。识别与翻译是**旁路**，
 *     必须走自己的请求函数 —— 一旦有人图省事写成 `submit('ocr')`，宿主与客户端两侧的解码
 *     就会漂移，而 X-1 在别处才会报错。这里就地钉住。
 *  2. **页面不许碰操作系统**：复制按钮必须经宿主（`/overlay/clipboard`），页面源码里不许出现
 *     浏览器剪贴板 API —— 这是 t57-4 的既有契约，新功能最容易破的就是它。
 *  3. **结果不许串选区**：识别/翻译的结果按"产生它时的选区"缓存，选区一改立刻失效；
 *     这是这类功能唯一会骗到用户的失效方式（把上一块区域的译文当成本次结果）。
 *  4. **目标语言只有一份定义**：下拉框的选项来自 `lib/ocr.mjs` 的 `TRANSLATE_TARGETS`
 *     （宿主的白名单与它是同一份），页面里不许另抄一张表。
 *
 * 末尾给负样本：把上面任一条打回原形，对应断言必须失败（防"怎么写都绿"）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const overlayDir = new URL('../overlay/', import.meta.url);
const read = (name) => readFileSync(new URL(name, overlayDir), 'utf8');

const html = read('index.html');
const css = read('overlay.css');
const js = read('overlay.js');

/** 冻结的动作词表（宿主 OVERLAY_ACTIONS + cancel；validate.mjs X-1 同一份）。 */
const ALLOWED_ACTIONS = new Set(['insert', 'copy', 'save', 'cancel']);
/** t75 新增的三个旁路端点。 */
const TEXT_ENDPOINTS = ['overlay/ocr', 'overlay/translate', 'overlay/clipboard'];

/** 页面里所有 `submit('x')` / `postResult('x')` 的实参 —— 必须落在冻结集合内。 */
function pageActionVocabulary(source) {
  return [...new Set([...source.matchAll(/(?:submit|postResult)\(\s*'([a-z]+)'/g)].map((match) => match[1]))];
}

/**
 * 契约 1：旁路端点齐备，且**没有**撑开冻结的动作词表。
 * @param {string} source @param {string} markup @returns {{ok: boolean, reason: string}}
 */
function sideChannelContract(source, markup) {
  for (const endpoint of TEXT_ENDPOINTS) {
    if (!source.includes(endpoint)) return { ok: false, reason: `页面没有接上 ${endpoint}` };
  }
  const actions = pageActionVocabulary(source);
  if (actions.length === 0) return { ok: false, reason: '找不到 submit/postResult 的调用点（锚点挪了，本检查会假绿）' };
  const stray = actions.filter((action) => !ALLOWED_ACTIONS.has(action));
  if (stray.length > 0) {
    return { ok: false, reason: `识别/翻译被写成了结果动作 ${stray.join(', ')}（必须走自己的旁路请求，否则 X-1 的冻结词表被撑开）` };
  }
  if (!/async function askHost\(/.test(source)) return { ok: false, reason: '缺少旁路请求函数 askHost' };
  // 卡片本身必须在标记里（不是 JS 里拼出来的），工具栏/看门狗等静态检查才看得到它。
  for (const selector of ['id="ocr-card"', 'id="ocr-source-text"', 'id="ocr-target-text"', 'id="ocr-target-select"', 'id="ocr-copy-source"', 'id="ocr-copy-target"', 'id="ocr-close"']) {
    if (!markup.includes(selector)) return { ok: false, reason: `结果卡片缺少 ${selector}` };
  }
  return { ok: true, reason: '' };
}

/**
 * 契约 2：复制经宿主，页面不碰操作系统。
 * @param {string} source @returns {{ok: boolean, reason: string}}
 */
function clipboardViaHostContract(source) {
  if (/navigator\s*\.\s*clipboard/.test(source)) return { ok: false, reason: '页面直接用浏览器剪贴板 API（必须经宿主 /overlay/clipboard）' };
  if (/execCommand\(\s*'copy'/.test(source)) return { ok: false, reason: '页面自己调 execCommand("copy")（必须经宿主）' };
  if (/\.download\s*=/.test(source)) return { ok: false, reason: '页面自己触发下载（动作必须由 DSH 侧执行）' };
  const copier = source.slice(source.indexOf('async function copyText('), source.indexOf('async function planOrCancel('));
  if (copier === '') return { ok: false, reason: '找不到 copyText（复制路径未校验）' };
  if (!/askHost\(ENDPOINTS\.clipboard/.test(copier)) return { ok: false, reason: 'copyText 没有把文本交给宿主的剪贴板端点' };
  return { ok: true, reason: '' };
}

/**
 * 契约 3：结果按选区失效，不许串。
 * @param {string} source @returns {{ok: boolean, reason: string}}
 */
function selectionScopedResultsContract(source) {
  if (!/function selectionKey\(plan\)/.test(source)) return { ok: false, reason: '缺少 selectionKey（选区身份）' };
  if (!/state\.text !== null && state\.text\.key === key/.test(source)) {
    return { ok: false, reason: '翻译前没有核对识别结果属于当前选区（会翻上一块区域的字）' };
  }
  if (!/state\.text !== null && state\.text\.key !== keyOfPlan\(plan\)\) closeCard\(\)/.test(source)) {
    return { ok: false, reason: '选区改变后卡片没有失效（旧文字会留在屏幕上）' };
  }
  // 识别的是**冻结帧原图**：不能走 renderSelection（那会把标注也画进去，让红框/马赛克进 OCR）。
  const region = source.slice(source.indexOf('function renderRegion('), source.indexOf('async function regionDataUrl('));
  if (region === '') return { ok: false, reason: '找不到 renderRegion（裁剪区未校验）' };
  if (!/drawImage\(state\.frame, rect\.x, rect\.y/.test(region)) {
    return { ok: false, reason: '待识别区域不是从冻结帧原样裁的' };
  }
  if (/for \(const annotation of state\.history\.present\)/.test(region)) {
    return { ok: false, reason: '识别区域里画了标注（红框会被当成文字一起识别）' };
  }
  if (!/MAX_OCR_REGION_EDGE/.test(region)) return { ok: false, reason: '待识别区域没有边长上限' };
  return { ok: true, reason: '' };
}

/**
 * 契约 4：目标语言是共用的一份定义，且交互齐全。
 * @param {string} source @param {string} markup @param {string} style @returns {{ok: boolean, reason: string}}
 */
function sharedTargetsContract(source, markup, style) {
  if (!source.includes("from '/api/dsh-screenshot/overlay/lib/ocr.mjs'")) {
    return { ok: false, reason: '页面没有从宿主 import lib/ocr.mjs（逻辑必须只有一份）' };
  }
  if (!/for \(const entry of TRANSLATE_TARGETS\)/.test(source)) {
    return { ok: false, reason: '下拉框不是由 lib 的 TRANSLATE_TARGETS 生成的（可能另抄了一张表）' };
  }
  if (/zh-Hant|한국어/.test(source)) {
    return { ok: false, reason: '页面里出现了目标语言字面量（应当只来自 lib）' };
  }
  if (!/params\.get\('target'\)/.test(source)) return { ok: false, reason: '页面没有读宿主给的目标语言初值' };
  // Esc：先关卡片，再取消整次截图。
  const escape = source.slice(source.indexOf("if (event.key === 'Escape')"), source.indexOf("// t70（B-13）"));
  if (escape === '') return { ok: false, reason: '找不到 Esc 分支' };
  if (escape.indexOf('closeCard()') === -1 || escape.indexOf('cancel(') === -1) {
    return { ok: false, reason: 'Esc 没有同时处理"关卡片"与"取消截图"' };
  }
  if (escape.indexOf('closeCard()') > escape.indexOf('cancel(')) {
    return { ok: false, reason: 'Esc 先取消了整次截图（卡片开着时应当先关卡片）' };
  }
  // 卡片是 chrome：在里面划选文字不该拖出新选区。
  if (!/closest\('#toolbar, #editor, #ocr-card'\)/.test(source)) {
    return { ok: false, reason: '卡片没有被 isChromeTarget 排除（在里面划字会拖出一个新选区）' };
  }
  // 样式：卡片在工具栏之上、文本可选中（用户的第一反应是划一句话）。
  const cardRule = style.slice(style.indexOf('#ocr-card {'), style.indexOf('#ocr-card[hidden]'));
  if (cardRule === '') return { ok: false, reason: '找不到 #ocr-card 的样式规则' };
  if (!/z-index:\s*9/.test(cardRule)) return { ok: false, reason: '卡片没有压在工具栏之上' };
  const textRule = style.slice(style.indexOf('.ocr-text {'), style.indexOf('.ocr-text:empty'));
  if (!/user-select:\s*text/.test(textRule)) return { ok: false, reason: '结果文本不可选中' };
  if (!markup.includes('role="dialog"')) return { ok: false, reason: '卡片没有 dialog 语义' };
  return { ok: true, reason: '' };
}

// ── 正向断言 ───────────────────────────────────────────────────────────────

test('(t75-29) the panel reaches the three side-channel routes without widening the frozen action vocabulary', () => {
  const result = sideChannelContract(js, html);
  assert.equal(result.ok, true, result.reason);
  // 反过来确认冻结词表本身没被动过：识别与翻译不是结果动作。
  assert.deepEqual(pageActionVocabulary(js).sort(), ['cancel', 'copy', 'insert', 'save']);
});

test('(t75-30) the recognition card copies through the host and never touches the OS itself', () => {
  const result = clipboardViaHostContract(js);
  assert.equal(result.ok, true, result.reason);
});

test('(t75-31) recognition results are scoped to the selection they came from, and read the raw frame', () => {
  const result = selectionScopedResultsContract(js);
  assert.equal(result.ok, true, result.reason);
});

test('(t75-32) the target-language list, the Esc order and the card styling are all wired', () => {
  const result = sharedTargetsContract(js, html, css);
  assert.equal(result.ok, true, result.reason);
});

test('(t75-33) both new toolbar entries are icon buttons with the same aria/title contract as the rest', () => {
  const builder = js.slice(js.indexOf('const actions = $(\'group-actions\');'), js.indexOf('function buildCardControls()'));
  assert.ok(builder.includes("button(T.ocr, T.ocr,"), '识别按钮没有进动作区');
  assert.ok(builder.includes("button(T.translate, T.translate,"), '翻译按钮没有进动作区');
  assert.match(builder, /\{ icon: 'scan', iconSize: 16 \}/, '识别必须是图标按钮（与既有口径一致）');
  assert.match(builder, /\{ icon: 'globe', iconSize: 16 \}/, '翻译必须是图标按钮');
  assert.ok(/scan:\s*\[/.test(js), 'scan 图标没有形状数据');
  assert.ok(/globe:\s*\[/.test(js), 'globe 图标没有形状数据');
  // 忙态只禁用这两个按钮（放弃识别直接插入对话不该被挡住）。
  // 注意：这里的判据是"包含忙态"，不是逐字相等 —— 面板后来把"宿主没有文本路由"也并进了禁用条件
  // （`textDisabled = state.textBusy || !hostHasTextRoutes`），逐字断言会误报。
  assert.match(js, /const textDisabled = state\.textBusy[^;]*;/, '禁用判据必须包含忙态');
  assert.ok(!/insertButton\.disabled = textDisabled/.test(js), '忙态不该连带禁用「插入对话」');
  assert.match(js, /textButtons\.ocr\.disabled = textDisabled;/);
  assert.match(js, /textButtons\.translate\.disabled = textDisabled;/);
  // 文案在 T 里（页面是独立窗口，中英并列写死）。
  for (const key of ['ocr:', 'translate:', 'ocrBusy:', 'translateBusy:', 'ocrEmpty:', 'copyFailed:']) {
    assert.ok(js.includes(key), `T 里缺少文案键 ${key}`);
  }
});

// ── 负样本：把契约打回原形，断言必须失败 ────────────────────────────────────

test('(t75-34) negative samples: widening the action set, a page-side clipboard write or a stale result must fail', () => {
  // 负样本 1：把识别写成结果动作 → 冻结词表被撑开。
  const widened = js.replace("button(T.ocr, T.ocr, () => {", "button(T.ocr, T.ocr, () => { submit('ocr'); ");
  assert.notEqual(widened, js, '识别按钮的调用点不存在，负样本无从构造');
  const widenedResult = sideChannelContract(widened, html);
  assert.equal(widenedResult.ok, false, 'submit(\'ocr\') 仍通过 = 冻结动作词表防线失效');
  assert.match(widenedResult.reason, /结果动作/);

  // 负样本 2：复制改回页面自己写剪贴板。
  const localClipboard = js.replace(
    'answer = await askHost(ENDPOINTS.clipboard, { text: value });',
    'await navigator.clipboard.writeText(value); answer = { body: { ok: true } };',
  );
  assert.notEqual(localClipboard, js, '剪贴板调用点不存在，负样本无从构造');
  const clipboardResult = clipboardViaHostContract(localClipboard);
  assert.equal(clipboardResult.ok, false, '页面自己写剪贴板仍通过 = t57-4 的契约失效');
  assert.match(clipboardResult.reason, /浏览器剪贴板/);

  // 负样本 2b：execCommand 兜底路径。
  const execCommand = js.replace(
    'answer = await askHost(ENDPOINTS.clipboard, { text: value });',
    "document.execCommand('copy'); answer = { body: { ok: true } };",
  );
  assert.equal(clipboardViaHostContract(execCommand).ok, false, 'execCommand 仍通过 = 契约失效');

  // 负样本 3：译文不核对选区 → 串区域。
  const staleOk = js.replace('state.text !== null && state.text.key === key', 'state.text !== null');
  assert.notEqual(staleOk, js, '选区核对行不存在，负样本无从构造');
  assert.equal(selectionScopedResultsContract(staleOk).ok, false, '不核对选区仍通过 = 串区域防线失效');

  // 负样本 3b：把标注画进待识别区域（红框会被当成文字）。
  const annotated = js.replace(
    'ctx.drawImage(state.frame, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);',
    'ctx.drawImage(state.frame, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);\n  for (const annotation of state.history.present) { void annotation; }',
  );
  assert.notEqual(annotated, js, '裁剪行不存在，负样本无从构造');
  assert.equal(selectionScopedResultsContract(annotated).ok, false, '识别区域里画了标注仍通过 = 契约失效');

  // 负样本 4：页面自己抄一张目标语言表。
  const copiedTargets = js.replace(
    'for (const entry of TRANSLATE_TARGETS) {',
    "for (const entry of [{ id: 'zh-Hant', label: '繁體中文' }]) {",
  );
  assert.notEqual(copiedTargets, js, '目标语言循环不存在，负样本无从构造');
  assert.equal(sharedTargetsContract(copiedTargets, html, css).ok, false, '另抄一张目标语言表仍通过 = 单一真相防线失效');

  // 负样本 4b：Esc 先取消整次截图（卡片开着却被整窗关掉）。
  const escapeOrder = js.replace(
    'if (cardEl !== null && cardEl.hidden !== true) {\n      closeCard();\n      paintChrome();\n      return;\n    }\n    void cancel(\'escape\');',
    "void cancel('escape');\n    if (cardEl !== null && cardEl.hidden !== true) { closeCard(); paintChrome(); return; }",
  );
  assert.notEqual(escapeOrder, js, 'Esc 分支不存在，负样本无从构造');
  assert.equal(sharedTargetsContract(escapeOrder, html, css).ok, false, 'Esc 先取消整窗仍通过 = 交互顺序防线失效');

  // 负样本 5：卡片不排除指针事件（在结果里划字会拖出新选区）。
  const notChrome = js.replace("closest('#toolbar, #editor, #ocr-card')", "closest('#toolbar, #editor')");
  assert.notEqual(notChrome, js, 'isChromeTarget 不存在，负样本无从构造');
  assert.equal(sharedTargetsContract(notChrome, html, css).ok, false, '卡片没被排除仍通过 = 交互防线失效');
});
