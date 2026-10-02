/**
 * 源码级交互契约（U-01 / R-U01）：覆盖层「面板」必须与「画面拖拽」隔离。
 *
 * 背景（用户实机报告）：点面板上的任何按钮都没反应，面板闪烁一下。
 * 根因：根部 `onPointerDown` 不区分事件来源，把工具栏按钮上的按下当成「新建选区」——
 * 拖动一起步面板就被隐藏（闪烁），`setPointerCapture` 又把指针抢到根节点，
 * 按钮的 `click` 永远发不出来。这类缺陷的共性是「交互被静默吞掉」，纯逻辑单测看不见，
 * 所以这里对 client.js 的源码结构做契约断言，并用就地变异（负样本）证明断言真的敏感。
 *
 * 断言的三条硬契约：
 *   (a) 根部 pointerdown 先做「目标命中覆盖层 UI 标记 → 直接 return」，且该判定位于
 *       拖拽起点与指针捕获之前；pointermove 同样不对面板产生画面副作用；
 *   (b) 覆盖层自身 UI 容器（工具栏、文字输入框、轻提示、提示条）共用统一 data 标记；
 *   (c) 该统一 props 同时阻止 pointerdown / mousedown 冒泡（与 TextEditor 原有做法一致）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/**
 * 去掉注释后的源码：契约断言只认代码 —— 注释里提到 `setDragging(true)` 之类不该算数
 * （与 validate.mjs 的 A-4 剥注释判定同一套办法）。
 * @param {string} text @returns {string}
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 分析用的代码文本（注释已剥离）。 */
const code = stripComments(source);

/** 交互契约里使用的标记名（面板与画面的分界）。 */
const UI_MARKER = 'data-dsh-screenshot-ui';

/** @param {string} text @param {string} needle @param {number} [size] @returns {string|null} */
function windowAfter(text, needle, size = 1600) {
  const at = text.indexOf(needle);
  return at === -1 ? null : text.slice(at, at + size);
}

/**
 * 取出两个标记之间的整段源码（用于圈定一个完整组件的范围）。
 * @param {string} text @param {string} startNeedle @param {string} endNeedle @returns {string|null}
 */
function sliceBetween(text, startNeedle, endNeedle) {
  const at = text.indexOf(startNeedle);
  if (at === -1) return null;
  const end = text.indexOf(endNeedle, at + startNeedle.length);
  return end === -1 ? text.slice(at) : text.slice(at, end);
}

/**
 * (a) 根部 pointerdown 是否先判定「目标在覆盖层 UI 内」并直接返回。
 * @param {string} text - client.js 源码（真实源码或变异样本，均已剥注释）。
 * @returns {{ ok: boolean, reason: string }}
 */
function rootPointerDownGuardsUi(text) {
  // 用完整函数体（大括号配对）：固定长度窗口会被后续新增的分支撑破而误报。
  const body = functionSource(text, 'function onPointerDown(event) {');
  if (body === null) return { ok: false, reason: '找不到 onPointerDown 处理器' };
  const guardAt = body.indexOf('isOverlayUiTarget(event.target)');
  if (guardAt === -1) return { ok: false, reason: 'pointerdown 没有覆盖层 UI 来源判定（isOverlayUiTarget）' };
  const dragAt = body.indexOf('setDragging(true)');
  const captureAt = body.indexOf('setPointerCapture');
  if (dragAt === -1 || captureAt === -1) return { ok: false, reason: '找不到拖拽起点/指针捕获语句' };
  if (guardAt > dragAt) return { ok: false, reason: '来源判定排在 setDragging(true) 之后（面板仍会闪）' };
  if (guardAt > captureAt) return { ok: false, reason: '来源判定排在 setPointerCapture 之后（按钮仍收不到 click）' };
  if (!/return/.test(body.slice(guardAt, dragAt))) return { ok: false, reason: '来源判定没有直接 return' };
  if (!text.includes('dragRef.current === null && isOverlayUiTarget(event.target)')) {
    return { ok: false, reason: 'pointermove 缺少「面板上不产生画面副作用」的保护' };
  }
  return { ok: true, reason: '' };
}

/**
 * (b) 覆盖层 UI 容器是否共用一个由 UI_MARKER_ATTR 派生的标记。
 * @param {string} text
 * @returns {{ ok: boolean, reason: string }}
 */
function uiSurfacesCarryMarker(text) {
  const attr = /const UI_MARKER_ATTR = '([^']+)';/.exec(text);
  if (attr === null) return { ok: false, reason: '缺少 UI_MARKER_ATTR 常量' };
  if (attr[1] !== UI_MARKER) return { ok: false, reason: `标记名是 ${attr[1]}，契约要求 ${UI_MARKER}` };
  if (!/const UI_MARKER_SELECTOR = '\[' \+ UI_MARKER_ATTR \+ '\]';/.test(text)) {
    return { ok: false, reason: 'UI_MARKER_SELECTOR 不是由属性名拼出（会与标记名漂移）' };
  }
  const helper = windowAfter(text, 'function uiSurfaceProps(', 420);
  if (helper === null) return { ok: false, reason: '缺少 uiSurfaceProps 统一 props' };
  if (!helper.includes("[UI_MARKER_ATTR]: 'true'")) return { ok: false, reason: 'uiSurfaceProps 没有设置标记（面板会失去保护）' };
  // R3-01：必须断言**可见**容器那一行 —— 只查「Toolbar 签名后 900 字符里出现 uiSurfaceProps(」会被
  // 隐藏占位分支（visible !== true 提前 return 的那一行）满足，导致可见容器换回普通 div 时假绿。
  const visibleToolbar = "return h('div', uiSurfaceProps({ ref, style: { ...TOOLBAR_STYLE, ...props.style } }),";
  if (!text.includes(visibleToolbar)) {
    return { ok: false, reason: '可见工具栏容器没有走统一 props（隐藏占位分支满足不了这条字面量断言）' };
  }
  const editor = windowAfter(text, 'function TextEditor(props) {', 900);
  if (editor === null || !editor.includes('uiSurfaceProps(')) return { ok: false, reason: '文字输入框没有带标记' };
  const toast = windowAfter(text, 'function Toast(props) {', 900);
  if (toast === null || !toast.includes('uiSurfaceProps(')) return { ok: false, reason: '轻提示没有带标记' };
  if (!text.includes("h('div', uiSurfaceProps({ style: HINT_STYLE }), TEXT.hint)")) {
    return { ok: false, reason: '覆盖层提示条没有带标记' };
  }
  return { ok: true, reason: '' };
}

/**
 * (c) 统一 props 是否对 pointerdown / mousedown 双双 stopPropagation（双保险）。
 * @param {string} text
 * @returns {{ ok: boolean, reason: string }}
 */
function uiSurfacesStopPropagation(text) {
  const helper = windowAfter(text, 'function uiSurfaceProps(', 460);
  if (helper === null) return { ok: false, reason: '缺少 uiSurfaceProps' };
  if (!/onPointerDown: \(event\) => event\.stopPropagation\(\)/.test(helper)) {
    return { ok: false, reason: 'uiSurfaceProps 没有 stopPropagation pointerdown' };
  }
  if (!/onMouseDown: \(event\) => event\.stopPropagation\(\)/.test(helper)) {
    return { ok: false, reason: 'uiSurfaceProps 没有 stopPropagation mousedown' };
  }
  const extraAt = helper.indexOf('...extra');
  const markerAt = helper.indexOf("[UI_MARKER_ATTR]: 'true'");
  if (extraAt === -1) return { ok: false, reason: 'uiSurfaceProps 不转发额外 props' };
  if (markerAt === -1 || markerAt < extraAt) {
    return { ok: false, reason: 'extra 必须在前、标记与拦截在后（否则调用方误传同名 props 就能破坏契约）' };
  }
  return { ok: true, reason: '' };
}

/**
 * 把 client.js 里「纯逻辑」的那三个声明切出来求值：client.js 是 bundle 而非模块，
 * 但这些声明只依赖 logger/errorText，可以在沙箱里真实执行（比只读源码更强）。
 * @returns {{ UI_MARKER_ATTR: string, UI_MARKER_SELECTOR: string, isOverlayUiTarget: Function, uiSurfaceProps: Function }|null}
 */
function evaluateUiGuard() {
  // 注释已被剥掉，所以这里用「下一个代码声明」当结束标记（不能拿 JSDoc 当标记）。
  const markerBlock = sliceBetween(code, 'const UI_MARKER_ATTR', 'const HANDLE_TOLERANCE');
  const guardFn = functionSource(code, 'function isOverlayUiTarget(target) {');
  const surfaceFn = functionSource(code, 'function uiSurfaceProps(extra = {}) {');
  if (markerBlock === null || guardFn === null || surfaceFn === null) return null;
  // eslint-disable-next-line no-new-func
  return new Function(
    'logger',
    'errorText',
    `${markerBlock}\n${guardFn}\n${surfaceFn}\nreturn { UI_MARKER_ATTR, UI_MARKER_SELECTOR, isOverlayUiTarget, uiSurfaceProps };`,
  )({ warn: () => {} }, (error) => String(error));
}

/**
 * 取出一个函数声明的完整源码（按大括号配对；这两个函数体内不含带大括号的字符串）。
 * @param {string} text @param {string} signature @returns {string|null}
 */
function functionSource(text, signature) {
  const at = text.indexOf(signature);
  if (at === -1) return null;
  // 函数体的左括号取「参数表结束后的 `) {`」，避免把默认值 `= {}` 里的括号当函数体。
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

/**
 * 假 DOM 元素链：只实现 closest()，用来真实驱动 isOverlayUiTarget。
 * @param {string} tag @param {{ marker?: boolean, parent?: object|null }} [options]
 * @returns {object}
 */
function fakeElement(tag, options = {}) {
  const node = {
    tag,
    parentElement: options.parent ?? null,
    hasMarker: options.marker === true,
    closest(selector) {
      if (selector !== `[${UI_MARKER}]`) return null;
      let current = node;
      while (current !== null) {
        if (current.hasMarker === true) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  return node;
}

/**
 * @param {string} text
 * @returns {boolean} 来源判定是否用 `closest(UI_MARKER_SELECTOR)`（与 onKeyDown 同源）。
 */
function isOverlayUiTargetUsesClosest(text) {
  const helper = windowAfter(text, 'function isOverlayUiTarget(target) {', 420);
  return helper !== null && helper.includes('target.closest(UI_MARKER_SELECTOR)');
}

/**
 * (U-02) 标注层的渲染契约：
 *   1. 拖动中的草稿必须被画出来（`drawAnnotation(ctx, drag.draft, …)`，且有判空）；
 *   2. 仍然裁到当前选区（所见即所得），但裁剪必须成对 `save()/restore()` ——
 *      裁剪区是画布状态的一部分、会跨帧累加：框选过程中每帧都在换裁剪矩形，
 *      交集会退化成最初那个小预览矩形，之后连草稿都会被裁掉（用户实机 U-02）；
 *   3. 整块 `clearRect` 必须发生在裁剪之前，否则清屏也被裁掉、选区外留下残影。
 * @param {string} text - client.js 源码（真实源码或变异样本，均已剥注释）。
 * @returns {{ ok: boolean, reason: string }}
 */
function annotationLayerRendersDraft(text) {
  const body = functionSource(text, 'function paintAnnotations() {');
  if (body === null) return { ok: false, reason: '找不到 paintAnnotations' };
  const draftAt = body.indexOf('drawAnnotation(ctx, drag.draft');
  if (draftAt === -1) return { ok: false, reason: '拖动中的草稿没有被绘制（拖拽时看不到预览）' };
  if (body.lastIndexOf('drag.draft !== null', draftAt) === -1) {
    return { ok: false, reason: '草稿绘制缺少 drag.draft 判空' };
  }
  const clearAt = body.indexOf('ctx.clearRect(');
  const saveAt = body.indexOf('ctx.save()');
  const clipAt = body.indexOf('ctx.clip()');
  const restoreAt = body.indexOf('ctx.restore()');
  if (clipAt === -1) return { ok: false, reason: '标注层没有裁到选区（与导出的所见即所得脱节）' };
  if (saveAt === -1) return { ok: false, reason: 'ctx.clip() 前没有 ctx.save()：裁剪区会跨帧累加（U-02）' };
  if (restoreAt === -1) return { ok: false, reason: 'ctx.clip() 后没有 ctx.restore()：裁剪区会跨帧累加（U-02）' };
  if (clearAt === -1 || clearAt > clipAt) {
    return { ok: false, reason: 'clearRect 必须在裁剪之前（否则清屏被裁掉，选区外留残影）' };
  }
  if (!(saveAt < clipAt && clipAt < restoreAt)) return { ok: false, reason: 'save → clip → restore 顺序不对' };
  if (!(draftAt > clipAt && draftAt < restoreAt)) return { ok: false, reason: '草稿必须在裁剪区内绘制、且在 restore 之前' };
  if (!/rect\(selection\.x \* view\.dpr/.test(body)) return { ok: false, reason: '裁剪矩形不是由当前选区推导' };
  return { ok: true, reason: '' };
}

test('(a) the overlay root pointerdown returns for targets inside the overlay UI (U-01)', () => {
  const result = rootPointerDownGuardsUi(code);
  assert.equal(result.ok, true, result.reason);
  assert.equal(isOverlayUiTargetUsesClosest(code), true, '来源判定必须用 closest（与 onKeyDown 同一套办法）');
});

test('(b) the overlay UI surfaces carry one shared data marker (U-01)', () => {
  const result = uiSurfacesCarryMarker(code);
  assert.equal(result.ok, true, result.reason);
  // R3-01：把"到底有几处 UI 容器"钉死（隐藏占位 + 可见容器 + 编辑器 + 轻提示 + 提示条 + helper 定义 = 6）。
  assert.equal((code.match(/uiSurfaceProps\(/g) ?? []).length, 6, 'uiSurfaceProps( 的引用次数变了：容器增减都要显式确认');
});

test('(c) the overlay UI surfaces stop pointerdown and mousedown propagation (U-01)', () => {
  const result = uiSurfacesStopPropagation(code);
  assert.equal(result.ok, true, result.reason);
});

test('(d) every toolbar action is wired to onClick inside the marked container (U-01)', () => {
  const toolbar = sliceBetween(
    code,
    'const Toolbar = React.forwardRef(function Toolbar(props, ref) {',
    '\n    function ToolButton(props) {',
  );
  assert.notEqual(toolbar, null, '找不到 Toolbar 组件');
  // 三个输出动作 + 取消 + 撤销/重做：逐个给出可复核的代码位置。
  const actions = ['actions.insert', 'actions.copy', 'actions.save', 'actions.cancel', 'actions.undo', 'actions.redo'];
  for (const action of actions) {
    assert.match(toolbar, new RegExp(`onClick: ${action.replace('.', '\\.')},`), `工具栏缺少 onClick: ${action}`);
  }
  // 六类工具 / 颜色 / 线宽 / 马赛克强度：各自的映射都在同一个容器里。
  for (const group of ['TOOL_BUTTONS.map', 'COLORS.map', 'LINE_WIDTH_ORDER.map', 'MOSAIC_STEPS_UI.map']) {
    assert.ok(toolbar.includes(group), `工具栏缺少 ${group}`);
  }
  assert.ok(toolbar.includes('uiSurfaceProps('), '工具栏容器必须带统一标记（否则点击会被根部吞掉）');
  assert.ok((toolbar.match(/onClick:/g) ?? []).length >= 8, '工具栏的可点元素都应有 onClick');
  // ToolButton / TextChip 两个子组件把 onClick 透传下去（工具、线宽、字号、马赛克粒度都走它）。
  assert.equal((code.match(/onClick: \(\) => props\.onClick\(\)/g) ?? []).length, 2);
});

test('(e) negative samples: removing either half of the contract fails these assertions (U-01)', () => {
  // 负样本 1：删掉根部的来源判定 → (a) 必须失败。
  const guardLine = /^[ \t]*if \(isOverlayUiTarget\(event\.target\)\) return;[ \t]*$/m;
  assert.match(code, guardLine, '根部判定分支不存在，负样本无从构造');
  const withoutGuard = code.replace(guardLine, '');
  assert.notEqual(withoutGuard, code);
  assert.equal(rootPointerDownGuardsUi(withoutGuard).ok, false, '删掉根部判定后契约 (a) 仍通过 = 这条用例是假绿');
  // 负样本 2：删掉统一标记 → (b) 必须失败。
  const markerLine = /^[ \t]*\[UI_MARKER_ATTR\]: 'true',[ \t]*$/m;
  assert.match(code, markerLine, '统一标记不存在，负样本无从构造');
  const withoutMarker = code.replace(markerLine, '');
  assert.notEqual(withoutMarker, code);
  assert.equal(uiSurfacesCarryMarker(withoutMarker).ok, false, '删掉 UI 标记后契约 (b) 仍通过 = 这条用例是假绿');
  // 负样本 3：删掉 stopPropagation 双保险 → (c) 必须失败。
  const withoutStops = code.replace(/onPointerDown: \(event\) => event\.stopPropagation\(\),/g, '');
  assert.notEqual(withoutStops, code);
  assert.equal(uiSurfacesStopPropagation(withoutStops).ok, false, '删掉 stopPropagation 后契约 (c) 仍通过 = 这条用例是假绿');
  // 负样本 4：把来源判定挪到指针捕获之后（等价于「先抢指针再判来源」）→ (a) 必须失败。
  const movedGuard = code
    .replace(guardLine, '')
    .replace('root.setPointerCapture(event.pointerId);', 'if (isOverlayUiTarget(event.target)) return;\n            root.setPointerCapture(event.pointerId);');
  assert.notEqual(movedGuard, code);
  assert.equal(rootPointerDownGuardsUi(movedGuard).ok, false, '来源判定挪到 setPointerCapture 之后仍通过 = 顺序契约无效');
  // 负样本 5（R3-01 复发形态）：把**可见**工具栏容器换回普通 div —— 隔离就只剩隐藏占位分支上的标记，
  // 真实面板会重新被根部吞掉 click。弱断言（只看"Toolbar 签名后 900 字符里有没有 uiSurfaceProps("）会假绿，这里必须失败。
  const visibleToolbar = "return h('div', uiSurfaceProps({ ref, style: { ...TOOLBAR_STYLE, ...props.style } }),";
  const plainToolbar = code.replace(
    visibleToolbar,
    "return h('div', { ref, style: { ...TOOLBAR_STYLE, ...props.style } },",
  );
  assert.notEqual(plainToolbar, code, '可见工具栏容器的字面量签名不存在，负样本无从构造');
  assert.equal(uiSurfacesCarryMarker(plainToolbar).ok, false, '可见容器换回普通 div 后契约 (b) 仍通过 = U-01 复发形态漏检');
  assert.equal((plainToolbar.match(/uiSurfaceProps\(/g) ?? []).length, 5, '计数断言也必须随之掉到 5');
});

test('(f) the extracted UI guard really classifies panel vs canvas targets (U-01)', () => {
  const guard = evaluateUiGuard();
  assert.notEqual(guard, null, '无法从 client.js 切出 UI 判定声明');
  assert.equal(guard.UI_MARKER_SELECTOR, `[${UI_MARKER}]`, '选择器必须由标记名拼出');
  const toolbar = fakeElement('div', { marker: true });
  const toolButton = fakeElement('button', { parent: toolbar });
  const svg = fakeElement('svg', { parent: toolButton });
  const path = fakeElement('path', { parent: svg });
  assert.equal(guard.isOverlayUiTarget(path), true, '按钮里 SVG 图标上的按下也是面板点击');
  assert.equal(guard.isOverlayUiTarget(toolButton), true, '工具栏按钮上的按下是面板点击');
  assert.equal(guard.isOverlayUiTarget(toolbar), true, '工具栏空白处也是面板');
  const canvasLike = fakeElement('div', { parent: fakeElement('div', {}) });
  assert.equal(guard.isOverlayUiTarget(canvasLike), false, '画面上的按下仍然开始框选');
  assert.equal(guard.isOverlayUiTarget(null), false);
  assert.equal(guard.isOverlayUiTarget({}), false, '没有 closest 的目标不该抛错');
});

test('(g) the extracted shared props mark the surface and always stop both events (U-01)', () => {
  const guard = evaluateUiGuard();
  assert.notEqual(guard, null, '无法从 client.js 切出 UI 判定声明');
  const props = guard.uiSurfaceProps({ ref: 'ref-token', style: { display: 'block' }, role: 'status' });
  assert.equal(props[UI_MARKER], 'true', '容器必须带统一标记');
  assert.equal(props.ref, 'ref-token', '额外 props 必须被转发');
  assert.deepEqual(props.style, { display: 'block' });
  assert.equal(props.role, 'status');
  const stopped = [];
  props.onPointerDown({ stopPropagation: () => stopped.push('pointerdown') });
  props.onMouseDown({ stopPropagation: () => stopped.push('mousedown') });
  assert.deepEqual(stopped, ['pointerdown', 'mousedown'], '两个事件都必须被拦下（双保险）');
  // 调用方误传同名 props 也不能破坏契约（extra 在前、守护键在后）。
  const overridden = guard.uiSurfaceProps({ [UI_MARKER]: 'false', onPointerDown: () => {} });
  assert.equal(overridden[UI_MARKER], 'true');
  const second = [];
  overridden.onPointerDown({ stopPropagation: () => second.push('pointerdown') });
  assert.deepEqual(second, ['pointerdown']);
});

test('(h) the annotation layer renders the live draft inside a save/restore-balanced selection clip (U-02)', () => {
  const result = annotationLayerRendersDraft(code);
  assert.equal(result.ok, true, result.reason);
  // 修复点必须真的在源码里：save 紧挨着 clip、restore 在函数收尾。
  const body = functionSource(code, 'function paintAnnotations() {');
  assert.match(body, /ctx\.save\(\);\n\s*ctx\.beginPath\(\);\n\s*ctx\.rect\(selection\.x \* view\.dpr/, 'save 必须紧跟裁剪矩形');
  assert.match(body, /if \(clipped\) ctx\.restore\(\);/, '函数收尾必须有配对的 restore');
  assert.match(code, /const clipped = selection !== null && hasPositiveArea\(selection\);/, '裁剪开关必须是显式变量');
});

test('(i) negative samples: removing the draft draw or unbalancing the clip fails (h) (U-02)', () => {
  const draftLine = /^[ \t]*drawAnnotation\(ctx, drag\.draft, environment\);[ \t]*$/m;
  assert.match(code, draftLine, '草稿绘制行不存在，负样本无从构造');
  // 负样本 1：删掉草稿绘制 → (h) 必须失败（这正是用户看到的「拖动中没有预览」）。
  const withoutDraft = code.replace(draftLine, '');
  assert.notEqual(withoutDraft, code);
  assert.equal(annotationLayerRendersDraft(withoutDraft).ok, false, '删掉草稿绘制后契约 (h) 仍通过 = 假绿');
  // 负样本 2：删掉 ctx.save() → 裁剪区跨帧累加（本次 U-02 的真实缺陷形态）→ (h) 必须失败。
  const saveLine = /^[ \t]*ctx\.save\(\);[ \t]*$/m;
  assert.match(code, saveLine, 'ctx.save() 不存在，负样本无从构造');
  const withoutSave = code.replace(saveLine, '');
  assert.notEqual(withoutSave, code);
  assert.equal(annotationLayerRendersDraft(withoutSave).ok, false, '删掉 save() 后契约 (h) 仍通过 = 假绿');
  // 负样本 3：删掉配对的 restore → (h) 必须失败。
  const restoreLine = /^[ \t]*if \(clipped\) ctx\.restore\(\);[ \t]*$/m;
  assert.match(code, restoreLine, 'ctx.restore() 不存在，负样本无从构造');
  const withoutRestore = code.replace(restoreLine, '');
  assert.notEqual(withoutRestore, code);
  assert.equal(annotationLayerRendersDraft(withoutRestore).ok, false, '删掉 restore() 后契约 (h) 仍通过 = 假绿');
  // 负样本 4：把 clearRect 挪到 clip 之后（清屏也被裁掉，选区外留残影）→ (h) 必须失败。
  // 变异必须限定在 paintAnnotations 体内：paintFrozenFrame 里也有 clearRect/clip 类似调用。
  const layerBody = functionSource(code, 'function paintAnnotations() {');
  const clearLine = /^[ \t]*ctx\.clearRect\(0, 0, canvas\.width, canvas\.height\);[ \t]*$/m;
  const clipLine = /^([ \t]*)ctx\.clip\(\);[ \t]*$/m;
  assert.match(layerBody, clearLine, 'paintAnnotations 里没有 clearRect，负样本无从构造');
  const mutatedBody = layerBody
    .replace(clearLine, '')
    .replace(clipLine, (match) => `${match}\n        ctx.clearRect(0, 0, canvas.width, canvas.height);`);
  assert.notEqual(mutatedBody, layerBody);
  const movedClear = code.replace(layerBody, mutatedBody);
  assert.notEqual(movedClear, code);
  assert.equal(annotationLayerRendersDraft(movedClear).ok, false, 'clearRect 挪到 clip 之后仍通过 = 顺序契约无效');
});

/**
 * (U-03) 忙时反馈契约：`runOutput` 一进忙态就必须**同步**写下一条 info 级提示
 * （先于任何 await），并且提示真的被 Toolbar 渲染出来。
 * 背景：用户实机报告点「插入对话」后数秒内覆盖层静止、无任何反馈；此前 `runOutput`
 * 把 notice 清成 null，忙时唯一的变化只是插入按钮文字换成「处理中…」。
 * @param {string} text - client.js 源码（真实源码或变异样本，均已剥注释）。
 * @returns {{ ok: boolean, reason: string }}
 */
function busyFeedbackIsImmediate(text) {
  const body = functionSource(text, 'async function runOutput(kind) {');
  if (body === null) return { ok: false, reason: '找不到 runOutput' };
  const busyAt = body.indexOf('state.busy = true;');
  if (busyAt === -1) return { ok: false, reason: 'runOutput 没有进入忙态' };
  const noticeAt = body.indexOf('state.notice = {', busyAt);
  if (noticeAt === -1) return { ok: false, reason: '忙态下没有写 notice（用户看不到任何反馈）' };
  const firstAwaitAt = body.indexOf('await ');
  if (firstAwaitAt !== -1 && noticeAt > firstAwaitAt) {
    return { ok: false, reason: '忙态提示写在第一个 await 之后（编码期间仍然没有任何反馈）' };
  }
  const noticeSlice = body.slice(noticeAt, noticeAt + 140);
  if (!/kind: 'info'/.test(noticeSlice) || !/TEXT\.busy/.test(noticeSlice)) {
    return { ok: false, reason: '忙态提示不是 info 级 + 专用文案' };
  }
  // t29：忙态提示必须逐字是「正在生成图片（含标注）…」那一条 —— 只看「busy 之后 140 字符内出现
  // kind: 'info' + TEXT.busy*」会被编码偏慢时的升级提示（TEXT.busySlow）满足，于是「删掉忙态提示」
  // 这个负样本会假绿（本次修 t29 时实测到）。
  if (!body.includes("state.notice = { kind: 'info', text: TEXT.busyEncode };")) {
    return { ok: false, reason: '忙态没有同步写 busyEncode 提示（其它提示不能替代）' };
  }
  if (!body.includes("state.notice = { kind: 'info', text: TEXT.busyInsert };")) {
    return { ok: false, reason: '缺少「正在插入对话…」的阶段提示' };
  }
  if (!/busyEncode: '/.test(text) || !/busyInsert: '/.test(text)) {
    return { ok: false, reason: '缺少 busyEncode / busyInsert 文案' };
  }
  if (!/props\.notice\.kind === 'error' \? NOTICE_STYLE : NOTICE_INFO_STYLE/.test(text)) {
    return { ok: false, reason: 'Toolbar 没有渲染 notice（或没有 info 样式），提示再写也不可见' };
  }
  return { ok: true, reason: '' };
}

/**
 * (U-03) 成功判定的等待必须事件驱动：不许固定间隔空转；判据仍是「附件数严格增加」。
 * @param {string} text
 * @returns {{ ok: boolean, reason: string }}
 */
function successWaitIsEventDriven(text) {
  const body = functionSource(text, 'async function insertIntoConversation(runtime, blob, mediaType = PNG_MIME) {');
  if (body === null) return { ok: false, reason: '找不到 insertIntoConversation' };
  if (/while \(/.test(body)) return { ok: false, reason: '插入流程仍有 while 空转循环' };
  if (body.includes('INSERT_POLL_MS')) return { ok: false, reason: '插入流程仍按固定间隔轮询' };
  if (!body.includes('runtime.waitForAttachmentIncrease(before, INSERT_CONFIRM_MS)')) {
    return { ok: false, reason: '插入流程没有用事件驱动的等待原语' };
  }
  if (!/function waitForAttachmentIncrease\(baseline, timeoutMs\)/.test(text)) {
    return { ok: false, reason: 'store 缺少 waitForAttachmentIncrease' };
  }
  if (!/next > waiter\.baseline/.test(text)) {
    return { ok: false, reason: '等待者不是按「数量严格增加」唤醒（成功判据被削弱）' };
  }
  if (!/function setAttachmentCount\(next\)/.test(text) || !/runtime\.setAttachmentCount\(/.test(text)) {
    return { ok: false, reason: '没有走 setAttachmentCount 唤醒路径（等待者永远不会被唤醒）' };
  }
  if (!/resolve\(false\)/.test(text)) return { ok: false, reason: '缺少窗口到期返回 false（失败路径不再降级）' };
  return { ok: true, reason: '' };
}

test('(j) the insert flow shows a processing notice synchronously (U-03)', () => {
  const result = busyFeedbackIsImmediate(code);
  assert.equal(result.ok, true, result.reason);
});

test('(k) the insert success wait is event-driven, not a fixed-interval spin (U-03)', () => {
  const result = successWaitIsEventDriven(code);
  assert.equal(result.ok, true, result.reason);
});

test('(l) negative samples: dropping the busy notice or restoring the spin fails (j)/(k) (U-03)', () => {
  // 负样本 1：删掉忙态提示 → (j) 必须失败（正是用户报告的"无任何反馈"）。
  const busyNoticeLine = /^[ \t]*state\.notice = \{ kind: 'info', text: TEXT\.busyEncode \};[ \t]*$/m;
  assert.match(code, busyNoticeLine, '忙态提示行不存在，负样本无从构造');
  const withoutNotice = code.replace(busyNoticeLine, '');
  assert.notEqual(withoutNotice, code);
  assert.equal(busyFeedbackIsImmediate(withoutNotice).ok, false, '删掉忙态提示后契约 (j) 仍通过 = 假绿');
  // 负样本 2：把忙态提示换成 null（修复前的形态）→ (j) 必须失败。
  const nullNotice = code.replace(
    busyNoticeLine,
    "        state.notice = null;",
  );
  assert.notEqual(nullNotice, code);
  assert.equal(busyFeedbackIsImmediate(nullNotice).ok, false, '把 notice 置回 null 后契约 (j) 仍通过 = 假绿');
  // 负样本 3：把事件驱动改回无条件空转 → (k) 必须失败。
  const spinWait = code.replace(
    'await runtime.waitForAttachmentIncrease(before, INSERT_CONFIRM_MS);',
    'while (nowMs() < nowMs() + INSERT_CONFIRM_MS) { await delay(INSERT_POLL_MS); }',
  );
  assert.notEqual(spinWait, code);
  assert.equal(successWaitIsEventDriven(spinWait).ok, false, '改回空转后契约 (k) 仍通过 = 假绿');
  // 负样本 4：把"严格增加"放宽成">="→ 成功判据被削弱 → (k) 必须失败。
  const weakened = code.replace('next > waiter.baseline', 'next >= waiter.baseline');
  assert.notEqual(weakened, code);
  assert.equal(successWaitIsEventDriven(weakened).ok, false, '判据放宽后契约 (k) 仍通过 = 假绿');
});

/**
 * (H-01) 已放置标注的 4 个角把手必须画在**标注框的四角**。
 *
 * 背景（t36 实机补测）：把手元素是标注虚线框的子节点，`place()` 写的 `left/top` 是相对父元素的，
 * 而 `handlePoint()` 给的是视口坐标 —— 直接把 `corner.x - 4` 写进去会被框原点二次偏移：
 * 实测框 `{500,350,200,130}` 的 nw 把手落在 `(997,697)`（= 500 + 500 − 4），跑到选区外，
 * 用户看不到把手、以为不能缩放。所以断言两件事：
 *   1. 源码：把手定位走 `annotationHandleOffset(selectedBox, corner)`（相对框），不再直接写视口坐标；
 *   2. 行为：切出 `handlePoint` + `annotationHandleOffset` 真跑一遍，视口坐标 = 框原点 + 相对坐标 + 半径
 *      必须回到角点（含最小尺寸下限的极小框）。
 * @param {string} text - client.js 源码（真实源码或变异样本，均已剥注释）。
 * @returns {{ok: boolean, reason: string}}
 */
function annotationHandlesSitOnBoxCorners(text) {
  const layout = functionSource(text, 'function layoutChrome() {');
  if (layout === null) return { ok: false, reason: '找不到 layoutChrome' };
  if (!layout.includes('annotationHandleOffset(selectedBox, corner)')) {
    return { ok: false, reason: '把手定位没有走「相对标注框」的偏移（视口坐标会被框原点二次偏移）' };
  }
  if (/place\(element, \{\s*x: corner\.x/.test(layout)) {
    return { ok: false, reason: '把手仍把视口坐标直接写成 left/top（H-01 复发形态）' };
  }
  const pointFn = functionSource(text, 'function handlePoint(rect, handle) {');
  const offsetFn = functionSource(text, 'function annotationHandleOffset(box, corner, size = ANNOTATION_HANDLE_SIZE) {');
  if (pointFn === null || offsetFn === null) return { ok: false, reason: '无法切出 handlePoint / annotationHandleOffset' };
  // eslint-disable-next-line no-new-func
  const api = new Function(`${pointFn}\n${offsetFn}\nreturn { handlePoint, annotationHandleOffset };`)();
  const size = 8;
  const radius = size / 2;
  const boxes = [
    { label: '实测框', box: { x: 500, y: 350, width: 200, height: 130 } },
    { label: '最小框', box: { x: 10, y: 20, width: 8, height: 8 } },
  ];
  for (const { label, box } of boxes) {
    for (const id of ['nw', 'ne', 'se', 'sw']) {
      const corner = api.handlePoint(box, id);
      const offset = api.annotationHandleOffset(box, corner, size);
      if (box.x + offset.x + radius !== corner.x || box.y + offset.y + radius !== corner.y) {
        return { ok: false, reason: `${label} 的 ${id} 把手视口坐标不等于角点（被框原点二次偏移）` };
      }
      // 把手**中心**（左侧偏移 + 半径）必须正好落在标注框的边上（四角之一），不得飘到框外。
      const centreX = offset.x + radius;
      const centreY = offset.y + radius;
      if (centreX < 0 || centreX > box.width || centreY < 0 || centreY > box.height) {
        return { ok: false, reason: `${label} 的 ${id} 把手中心不在标注框边上（把手会与标注框分离）` };
      }
    }
  }
  return { ok: true, reason: '' };
}

test('(m) the four annotation handles render on the annotation box corners (H-01)', () => {
  const result = annotationHandlesSitOnBoxCorners(code);
  assert.equal(result.ok, true, result.reason);
});

test('(n) negative samples: writing viewport coordinates into the handle offsets fails (m) (H-01)', () => {
  // 负样本 1：把手定位退回修复前的「视口坐标直接当 left/top」→ (m) 必须失败。
  const absoluteCall = code.replace(
    'const offset = annotationHandleOffset(selectedBox, corner);',
    'const offset = { x: corner.x - 4, y: corner.y - 4 };',
  );
  assert.notEqual(absoluteCall, code, '相对偏移调用不存在，负样本无从构造');
  assert.equal(annotationHandlesSitOnBoxCorners(absoluteCall).ok, false, '退回视口坐标后契约 (m) 仍通过 = 假绿');
  // 负样本 2：偏移函数本身改回绝对值（不减框原点）→ (m) 的数值断言必须失败。
  const absoluteHelper = code.replace(
    'return { x: corner.x - box.x - radius, y: corner.y - box.y - radius };',
    'return { x: corner.x - radius, y: corner.y - radius };',
  );
  assert.notEqual(absoluteHelper, code, '相对偏移的算术不存在，负样本无从构造');
  assert.equal(annotationHandlesSitOnBoxCorners(absoluteHelper).ok, false, '偏移函数写回绝对值后契约 (m) 仍通过 = 假绿');
});
