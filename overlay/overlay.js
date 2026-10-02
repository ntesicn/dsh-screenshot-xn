/**
 * B1 覆盖层页面（t57）——独立浏览器窗口里的全屏框选 + 六类标注 + 三动作。
 *
 * 三条设计约束（与 t57 契约逐条对应）：
 *  1. **纯逻辑只有一份**：几何/标注/历史/输出/导出计划全部 `import` 宿主 webServer 提供的
 *     `/api/dsh-screenshot/overlay/lib/<name>.mjs`（就是包里的 `lib/*.mjs`），本文件不复制任何一份
 *     —— 页面里只有"渲染 + 交互 + 与宿主的窄接口"，没有 planRender / drawAnnotation / createHistory
 *     这类实现的第二份。测试 tests/overlay-page.test.mjs 用静态断言 + 负样本守住这条。
 *  2. **1:1 屏幕坐标**：kiosk 窗口视口即屏幕。冻结帧位图是**设备像素**（3440×1440），页面视口是
 *     **CSS 像素**，两者用同一个比例换算：
 *         scaleX = frame.widthPx / innerWidth   scaleY = frame.heightPx / innerHeight
 *     在本机 100% 缩放、kiosk 满屏时 scaleX == scaleY == devicePixelRatio == 1，于是"CSS 坐标 = 屏幕
 *     坐标"；125%/150% 缩放时它们是 1.25/1.5，选区 CSS 坐标 × 该比例 = 设备坐标（`planRender` 的
 *     `displayScale` 同一套换算，导出时不再各算一份）。两个比例不一致会打一条 warn（说明窗口没铺满
 *     屏幕，映射仍是按位图对齐的，不静默取一个）。
 *  3. **动作由 DSH 侧执行**：页面只把「只含选区 + 标注」的 PNG 用 `POST /result?token=` 交回宿主，
 *     复制/另存为/插入对话由 DSH 里的客户端编排完成 —— 页面不下载文件、不写剪贴板。
 *
 * 复用既有教训：裁剪成对 save/restore（U-02）、把手用**兄弟节点**绝对坐标（避开 H-01 的子元素
 * 相对坐标二次偏移）、导出 MIME 与扩展名取自 `lib/output.mjs` 的 `formatOf`（R-01）。
 *
 * 冻结接口（宿主 t56 实现，逐字对齐）：
 *   GET  /api/dsh-screenshot/overlay/frame?token=        → 冻结帧 PNG（缓存）
 *   POST /api/dsh-screenshot/overlay/result?token=       → { action, png }
 *   GET  /api/dsh-screenshot/overlay/ping?token=         → 心跳
 *   GET  /api/dsh-screenshot/overlay/lib/<name>.mjs      → 纯逻辑模块
 */
import {
  HANDLES,
  MIN_SELECTION_EDGE,
  appendPoint,
  clampRectToFrame,
  containsPoint,
  cursorForHandle,
  handlePoint,
  hasPositiveArea,
  hitHandle,
  rectFromCorners,
  resizeRect,
} from '/api/dsh-screenshot/overlay/lib/geometry.mjs';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_EDGE,
  calibrateCapture,
  normalizeCapture,
  planRender,
  resolveSizePolicy,
  sizeAttempts,
} from '/api/dsh-screenshot/overlay/lib/capture-plan.mjs';
import {
  COLORS,
  DEFAULT_STYLE,
  HIT_TOLERANCE,
  LINE_WIDTHS,
  LINE_WIDTH_ORDER,
  MIN_ANNOTATION_EDGE,
  TEXT_SIZE_ORDER,
  TOOL_IDS,
  TOOL_MOVE,
  annotationHandles,
  annotationRect,
  createShape,
  createStroke,
  createText,
  drawAnnotation,
  findAnnotationAt,
  hitAnnotationHandle,
  measureTextAnnotation,
  mosaicCellSize,
  moveAnnotation,
  resizeAnnotationRect,
  scaleAnnotation,
  withTextMetrics,
} from '/api/dsh-screenshot/overlay/lib/annotations.mjs';
import { createHistory } from '/api/dsh-screenshot/overlay/lib/history.mjs';
import { blobToDataUrl, formatOf } from '/api/dsh-screenshot/overlay/lib/output.mjs';
import {
  MAX_OCR_REGION_EDGE,
  TRANSLATE_TARGETS,
  errorTextKey,
  isEmptyOcrText,
  normalizeTranslateTarget,
} from '/api/dsh-screenshot/overlay/lib/ocr.mjs';

// ─── 窄接口（冻结端点，逐字） ────────────────────────────────────────────────
const ENDPOINTS = Object.freeze({
  frame: '/api/dsh-screenshot/overlay/frame',
  result: '/api/dsh-screenshot/overlay/result',
  ping: '/api/dsh-screenshot/overlay/ping',
  page: '/api/dsh-screenshot/overlay/page',
  // t75：识别与翻译走同一族路由（同一个 token 门）。两者都是**旁路** ——
  // 不改变会话状态、不产出结果图，面板可以拿完文本继续标注，也可以直接关窗口。
  ocr: '/api/dsh-screenshot/overlay/ocr',
  translate: '/api/dsh-screenshot/overlay/translate',
  clipboard: '/api/dsh-screenshot/overlay/clipboard',
});

/** 心跳间隔（ms）：契约要求 ≤1s 一次，宿主据此判定页面是否还活着。 */
const HEARTBEAT_MS = 1000;
/** 编码阶段的硬上限（ms）：`toBlob` 不回调时也不许把页面吊死（t29 的教训）。 */
const ENCODE_DEADLINE_MS = 6000;
/** 马赛克粒度档（UI 三档；具体像素由 lib 的 `mosaicCellSize` 决定）。 */
const MOSAIC_STEPS_UI = Object.freeze([0, 2, 4]);
/**
 * 已放置标注的角把手命中容差（**视口 CSS 像素**的手感；命中时换算到设备空间）。
 * 与 DSH 内覆盖层同口径（client.js 的 `ANNOTATION_HANDLE_TOLERANCE`）。
 */
const ANNOTATION_HANDLE_TOLERANCE = 9;
/**
 * 会用到**线宽**的工具（t68）：矩形/椭圆/箭头/画笔。
 * 马赛克有自己的粒度、文字有自己的字号，所以那两个工具下不显示线宽档位。
 * 从 lib 的 `TOOL_IDS` 派生出这份子集（不是另抄一份清单）。
 */
const WIDTH_TOOL_IDS = Object.freeze(TOOL_IDS.filter((id) => id !== 'mosaic' && id !== 'text'));
/**
 * 会用到**颜色**的工具（t72，用户口径）：矩形/椭圆/箭头/画笔/文字 —— 也就是"会落色的"那些。
 * 移动工具不落色；马赛克的颜色在 lib 里根本不参与绘制（它只做像素化），所以两者都不显示色板。
 * 同样从 `TOOL_IDS` 派生（排除 mosaic），避免与 lib 漂移。
 */
const COLOR_TOOL_IDS = Object.freeze(TOOL_IDS.filter((id) => id !== 'mosaic'));
/**
 * 第二行的分组顺序（t72）：`[分组 id, 它前面那根竖线的 id]`。
 * 竖线的显隐由 `refreshToolbar()` 统一按"后面可见 + 前面有可见分组"推导（避免孤立竖线）。
 */
const ROW_STYLE_GROUPS = Object.freeze([
  ['group-colors', null],
  ['group-widths', 'divider-widths'],
  ['group-sizes', 'divider-sizes'],
  ['group-mosaic', 'divider-mosaic'],
]);
/** 工具栏文案（页面是独立窗口，没有 locale 服务，中英并列写死）。 */
const T = Object.freeze({
  insert: '插入对话 / Insert',
  copy: '复制 / Copy',
  save: '另存为 / Save as',
  cancel: '取消 / Cancel',
  undo: '撤销 / Undo',
  redo: '重做 / Redo',
  move: '移动 / Move',
  rect: '矩形 / Rect',
  ellipse: '椭圆 / Ellipse',
  arrow: '箭头 / Arrow',
  pen: '画笔 / Pen',
  mosaic: '马赛克 / Mosaic',
  text: '文字 / Text',
  widths: Object.freeze({ thin: '细', medium: '中', thick: '粗' }),
  sizes: Object.freeze({ small: '小', medium: '中', large: '大' }),
  tiles: Object.freeze({ 0: '细', 2: '中', 4: '粗' }),
  hint: '拖动鼠标框选，Esc 取消，右键取消',
  normalModeNotice: '普通模式：这次画面里包含 DSH 窗口（右键 DSH 里的截图图标可切回穿透）· Normal mode: this frame includes DSH',
  editorPlaceholder: '输入文字后回车',
  selectionTooSmall: '选区太小（最小 8 px），本次截图已取消',
  selectionClipped: '选区超出画面范围，本次截图已取消',
  captureFailed: '取冻结帧失败',
  encodeFailed: '导出失败',
  encodeTimeout: '导出超时，请重试',
  submitFailed: '结果回传失败',
  // ── t75：区域识别 + 翻译 ──
  ocr: '识别文字 / OCR',
  translate: '翻译 / Translate',
  recognize: '识别',
  translating: '翻译中',
  recognized: '识别文字 / Recognized',
  translation: '译文 / Translation',
  ocrEmpty: '没识别到文字 · No text found',
  ocrCopied: '已复制识别文字',
  translateCopied: '已复制译文',
  copyFailed: '复制失败，请手动选中后 Ctrl+C · Copy failed — select the text and press Ctrl+C',
  close: '关闭识别结果 / Close OCR result',
  /**
   * 宿主还没重启时的专属文案（t75）。
   *
   * 这条**不是**识别失败，而是"界面比宿主新"：面板文件是现读的、宿主模块是启动时加载的，
   * 所以改完插件不重启 DSH，就会看到两个按钮却没接口。把它说成"识别失败"会把人引到
   * 语言包/权限的错误方向上（第一版就是这样，实测踩到）。
   */
  hostStale: '宿主里还没有识别接口：本插件的界面比宿主新，重启 DSH Desktop 后生效 · host is older than this panel — restart DSH Desktop',
  unchanged: '与原文一致 · unchanged',
  truncated: '文本过长，只翻译了前面一部分 · truncated',
  ocrBusy: '识别中… · recognizing',
  translateBusy: '翻译中… · translating',
  ocrDisabled: '识别已关闭（配置 ocrEnabled: false）· OCR is off',
  ocrUnavailable: '这台机器没有可用的 OCR 语言包（设置 → 时间和语言 → 语言）· no OCR language pack',
  ocrFailed: '识别失败 · OCR failed',
  ocrTimeout: '识别超时，请缩小选区后重试 · OCR timed out',
  ocrBadBody: '选区图像无效，请重新框选 · the region image is unusable',
  translateDisabled: '翻译已关闭（配置 translateEnabled: false）· translation is off',
  translateUnavailable: '没有可用于翻译的模型（DSH 未配置默认模型）· no model available',
  translateFailed: '翻译失败 · translation failed',
  translateTimeout: '翻译超时，请重试 · translation timed out',
  translateBadBody: '没有可翻译的文字 · nothing to translate',
  translateTooLong: '文字太长，未能翻译 · text too long',
});

const params = new URLSearchParams(window.location.search);
/** 页面从自身 URL 的 query 里读 token（契约）。 */
const token = params.get('token') ?? '';
/**
 * 宿主把这次会话请求的抓屏模式也放在页面 URL 上（t67）：`through`（默认，画面里没有 DSH）
 * 或 `normal`（右键菜单选了"普通截图"——画面里就是有 DSH 窗口，得说出来，别让用户以为坏了）。
 */
const captureMode = params.get('mode') === 'normal' ? 'normal' : 'through';
/**
 * 默认目标语言（t75）：宿主把**配置里那一项**放在页面 URL 上，面板的下拉框以它为初值。
 * 用户在下拉框里改只影响本次会话 —— 插件配置仍是唯一的持久化入口。
 */
const defaultTranslateTarget = normalizeTranslateTarget(params.get('target'));
/**
 * 宿主里有没有识别/翻译/剪贴板这三条路由（t75）——由宿主在页面 URL 上盖的 `ocr=1` 戳决定。
 *
 * 为什么需要这个戳：**面板文件是宿主 webServer 从磁盘现读的，宿主模块却只在 DSH 启动时
 * 加载一次**。所以"新面板 + 旧宿主"是这套架构里真实存在的组合（改完插件不重启 DSH 就是
 * 这样）：按钮和卡片都在，点下去却收到一个 404。实测过这个组合 —— 当时界面只能回落到通用
 * 文案「识别失败 · OCR failed」，把"宿主没重启"说成了"识别坏了"。
 * 有戳 → 正常可用；没戳 → 两个按钮置灰并在提示行写明原因。
 */
const hostHasTextRoutes = params.get('ocr') === '1';
const withToken = (endpoint) => `${endpoint}?token=${encodeURIComponent(token)}`;
const LOAD_T0 = performance.now();

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const baseCanvas = $('base');
const inkCanvas = $('ink');
const selectionEl = $('selection');
const badgeEl = $('badge');
const toolbarEl = $('toolbar');
const sizeLabelEl = $('size-label');
const noticeEl = $('notice');
const crossXEl = $('cross-x');
const crossYEl = $('cross-y');
const editorEl = $('editor');
const annotationBoxEl = $('annotation-box');
const annotationHandleEls = {};
for (const element of document.querySelectorAll('.annot-handle')) {
  annotationHandleEls[element.dataset.corner] = element;
}
const masks = { all: $('mask-all'), top: $('mask-top'), right: $('mask-right'), bottom: $('mask-bottom'), left: $('mask-left') };
// ── 识别 / 翻译卡片（t75）──
const cardEl = $('ocr-card');
const sourceBlockEl = $('ocr-source-block');
const sourceTextEl = $('ocr-source-text');
const sourceMetaEl = $('ocr-source-meta');
const sourceTitleEl = $('ocr-source-title');
const targetBlockEl = $('ocr-target-block');
const targetTextEl = $('ocr-target-text');
const targetMetaEl = $('ocr-target-meta');
const targetSelectEl = $('ocr-target-select');
const handleEls = {};
/** t75：识别/翻译这两个按钮的引用（忙态要单独禁用它们，不动其它按钮）。 */
const textButtons = {};
for (const id of HANDLES) {
  const element = document.createElement('div');
  element.className = 'handle';
  element.dataset.handle = id;
  document.body.appendChild(element);
  handleEls[id] = element;
}

// ─── 状态 ───────────────────────────────────────────────────────────────────
const state = {
  /** 冻结帧位图（1:1 画的底图，绝不缩放绘制）。 */
  frame: null,
  capture: null,
  calibration: null,
  /** 选区（CSS 坐标 = 屏幕坐标）。 */
  selection: null,
  /**
   * 当前选中的**已放置标注**（t70，B-13 的面板版）：null = 没选中。
   * 存的是标注值本身（不可变对象），拖动/缩放时整条替换；历史里找不到它时视为已失效。
   */
  selected: null,
  tool: TOOL_MOVE,
  color: DEFAULT_STYLE.color,
  widthKey: DEFAULT_STYLE.widthKey,
  textSizeKey: 'medium',
  mosaicStep: MOSAIC_STEPS_UI[1],
  history: createHistory(),
  drag: null,
  editor: null,
  /** 输入框是在**改已有文字**（t71 双击进入）：`{index, annotation}`；null = 新建文字。 */
  editorEditing: null,
  /**
   * 识别结果（t75）：`{ key, text, meta, empty }`。
   *
   * `key` 是**产生这条结果时选区的设备矩形**（`x,y,w,h` 拼串）：选区一改，缓存立刻失效 ——
   * 否则用户缩小选区再点「翻译」，翻的会是上一块区域的字。这是这张卡片唯一的正确性约束。
   */
  text: null,
  /** 翻译结果（t75）：`{ key, text, meta }`，key 与 {@link state.text} 同源。 */
  translation: null,
  /** 目标语言（面板自己的选择，初值来自宿主配置，见 defaultTranslateTarget）。 */
  translateTarget: defaultTranslateTarget,
  /** 识别/翻译请求进行中：只禁用那两个按钮，不影响标注与输出。 */
  textBusy: false,
  busy: false,
  ready: false,
};

// ─── 小工具 ─────────────────────────────────────────────────────────────────
const scratchPool = (() => {
  const surfaces = [];
  let cursor = 0;
  return {
    reset() {
      cursor = 0;
    },
    create(width, height) {
      const index = cursor;
      cursor += 1;
      const neededWidth = Math.max(1, Math.ceil(width));
      const neededHeight = Math.max(1, Math.ceil(height));
      let surface = surfaces[index];
      if (surface === undefined) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (ctx === null) return null;
        surface = { canvas, ctx };
        surfaces[index] = surface;
      }
      if (surface.canvas.width < neededWidth) surface.canvas.width = neededWidth;
      if (surface.canvas.height < neededHeight) surface.canvas.height = neededHeight;
      return surface.ctx;
    },
  };
})();

/** @param {string} text @param {'info'|'error'} [kind] */
function notice(text, kind = 'info') {
  noticeEl.textContent = text;
  noticeEl.dataset.kind = kind;
}

/** @param {string} message @param {object} [detail] */
function log(message, detail) {
  // eslint-disable-next-line no-console
  console.info(`[overlay] ${message}`, detail ?? {});
}

/** @returns {{width: number, height: number}} 页面视口（kiosk 满屏 = 屏幕 CSS 尺寸）。 */
function viewportSize() {
  return { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) };
}

/** @returns {number} 冻结帧位图 → 视口的横向比例。 */
function scaleX() {
  return state.frame === null ? 1 : state.frame.width / viewportSize().width;
}

/** @returns {number} 冻结帧位图 → 视口的纵向比例。 */
function scaleY() {
  return state.frame === null ? 1 : state.frame.height / viewportSize().height;
}

/**
 * 视口坐标 → **设备坐标**（t70）。
 *
 * lib 的 `annotations.mjs` 明确按设备像素定义标注（`annotationRect` 的文档、`hitAnnotation`、
 * `drawAnnotation` 的 ctx 约定），DSH 内覆盖层也是这么存的。面板此前把标注存成视口坐标、
 * 绘制时才乘比例，于是"标注空间"与 lib/导出/命中判定三者的约定不一致（比例为 1 时恰好相等才没暴露）；
 * 现在统一在**入参处**转换一次，绘制与导出都用设备坐标。
 * @param {{x: number, y: number}} point
 * @returns {{x: number, y: number}}
 */
function toDevice(point) {
  return { x: point.x * scaleX(), y: point.y * scaleY() };
}

/** @returns {number} 命中容差（CSS 手感 → 设备像素）。 */
function hitToleranceDevice() {
  return HIT_TOLERANCE * Math.max(1, scaleX());
}

/** @returns {number} 标注角把手容差（CSS 手感 → 设备像素）。 */
function handleToleranceDevice() {
  return ANNOTATION_HANDLE_TOLERANCE * Math.max(1, scaleX());
}

/** @param {object} selectionCss @returns {object|null} 选区在设备空间的矩形（标注的活动范围）。 */
function selectionBoundsDevice(selectionCss) {
  const plan = planFor(selectionCss);
  if (plan !== null && plan.deviceRect !== undefined && plan.deviceRect.width > 0) return plan.deviceRect;
  return selectionCss === null ? null : toDeviceRect(selectionCss);
}

/** @param {object} rectCss @returns {object} 视口矩形 → 设备矩形。 */
function toDeviceRect(rectCss) {
  const sx = scaleX();
  const sy = scaleY();
  return { x: rectCss.x * sx, y: rectCss.y * sy, width: rectCss.width * sx, height: rectCss.height * sy };
}

/** @param {object} rectDevice @returns {object} 设备矩形 → 视口矩形（只用于画 DOM chrome）。 */
function toCssRect(rectDevice) {
  const sx = scaleX();
  const sy = scaleY();
  return { x: rectDevice.x / sx, y: rectDevice.y / sy, width: rectDevice.width / sx, height: rectDevice.height / sy };
}

/** @param {object} selectionCss @returns {object|null} 导出计划（lib/planRender）。 */
function planFor(selectionCss) {
  if (state.capture === null || selectionCss === null) return null;
  return planRender(state.capture, selectionCss, { overlay: viewportSize(), dpr: window.devicePixelRatio });
}

/** 合成一帧：先重画底图之外的所有 chrome（遮罩/选框/把手/徽标/十字线）。 */
function schedule() {
  if (rafPending) return;
  rafPending = true;
  window.requestAnimationFrame(() => {
    rafPending = false;
    try {
      paintChrome();
      paintInk();
    } catch (error) {
      log('paint failed', { error: String(error) });
    }
  });
}
let rafPending = false;

/** 遮罩 / 选框 / 把手 / 徽标 / 十字线（全部用视口绝对坐标）。 */
function paintChrome() {
  const view = viewportSize();
  const drag = state.drag;
  const selection = drag !== null && drag.preview !== null ? drag.preview : state.selection;
  const valid = selection !== null && hasPositiveArea(selection);

  place(masks.all, { x: 0, y: 0, width: view.width, height: view.height }, !valid);
  if (valid) {
    place(masks.top, { x: 0, y: 0, width: view.width, height: selection.y }, true);
    place(masks.bottom, { x: 0, y: selection.y + selection.height, width: view.width, height: view.height - (selection.y + selection.height) }, true);
    place(masks.left, { x: 0, y: selection.y, width: selection.x, height: selection.height }, true);
    place(masks.right, { x: selection.x + selection.width, y: selection.y, width: view.width - (selection.x + selection.width), height: selection.height }, true);
  } else {
    for (const key of ['top', 'right', 'bottom', 'left']) place(masks[key], { x: 0, y: 0, width: 0, height: 0 }, false);
  }
  place(selectionEl, selection ?? { x: 0, y: 0, width: 0, height: 0 }, valid);

  // 已放置标注的选中框（t70）：标注存的是设备坐标，DOM chrome 用视口坐标 → 除一次比例。
  // 注意：拖动中的预览值**还没进历史**，不能只按"在不在历史里"判断有效性，否则一拖就自我清空。
  const selected = state.selected;
  const previewingSelection = drag !== null && drag.annotationIndex >= 0 && drag.annotation !== null && drag.annotation === selected;
  const inHistory = selected !== null && (state.history.present.includes(selected) || previewingSelection);
  if (selected !== null && !inHistory) state.selected = null;
  const showAnnotationBox = selected !== null && inHistory && valid;
  if (showAnnotationBox) {
    const box = toCssRect(annotationRect(selected));
    place(annotationBoxEl, {
      x: box.x - 2,
      y: box.y - 2,
      width: box.width + 4,
      height: box.height + 4,
    }, true);
    for (const entry of annotationHandles(box)) {
      const element = annotationHandleEls[entry.id];
      if (element === undefined) continue;
      element.style.display = 'block';
      element.style.left = `${entry.x - 4}px`;
      element.style.top = `${entry.y - 4}px`;
    }
  } else {
    place(annotationBoxEl, { x: 0, y: 0, width: 0, height: 0 }, false);
    for (const element of Object.values(annotationHandleEls)) element.style.display = 'none';
  }

  for (const id of HANDLES) {
    const element = handleEls[id];
    if (!valid) {
      element.style.display = 'none';
      continue;
    }
    const corner = handlePoint(selection, id);
    // 把手是选框的兄弟节点 → 直接用视口坐标（H-01 的坑：子节点会被父原点二次偏移）。
    element.style.display = 'block';
    element.style.left = `${corner.x - 4}px`;
    element.style.top = `${corner.y - 4}px`;
  }

  const pointer = state.pointer ?? { x: 0, y: 0 };
  const showCross = drag !== null && drag.mode === 'create';
  place(crossXEl, { x: 0, y: pointer.y, width: view.width, height: 1 }, showCross);
  place(crossYEl, { x: pointer.x, y: 0, width: 1, height: view.height }, showCross);

  if (!valid) {
    badgeEl.style.display = 'none';
    toolbarEl.style.display = 'none';
    // 选区没了，卡片也就没有主语了（它的内容永远属于某一块选区）。
    hideCard();
    if (sizeLabelEl !== null) sizeLabelEl.textContent = '';
    return;
  }
  const plan = planFor(selection);
  const deviceWidth = plan === null ? Math.round(selection.width) : plan.deviceRect.width;
  const deviceHeight = plan === null ? Math.round(selection.height) : plan.deviceRect.height;
  const ok = plan !== null && plan.valid;
  badgeEl.style.display = 'block';
  badgeEl.textContent = ok ? `${deviceWidth} × ${deviceHeight}` : `${deviceWidth} × ${deviceHeight} · < 8 px`;
  badgeEl.style.color = ok ? '#dbe4ff' : '#ff8f8f';
  badgeEl.style.left = `${Math.max(0, Math.min(selection.x, view.width - 110))}px`;
  badgeEl.style.top = `${selection.y > 30 ? selection.y - 26 : Math.min(view.height - 24, selection.y + selection.height + 6)}px`;
  // 第一行右侧的输出尺寸：与选区徽标同源（同一个 plan），只是给了个不挡画面的落脚点。
  if (sizeLabelEl !== null) {
    sizeLabelEl.textContent = `${deviceWidth} × ${deviceHeight} px`;
    sizeLabelEl.style.color = ok ? '#93a4c4' : '#ff8f8f';
  }

  // 工具栏贴选区（放不下就落到选区下方/上方，保证可点）。
  toolbarEl.style.display = 'flex';
  const toolbarWidth = toolbarEl.offsetWidth || 720;
  const toolbarHeight = toolbarEl.offsetHeight || 84;
  const left = Math.max(8, Math.min(selection.x, view.width - toolbarWidth - 8));
  const below = selection.y + selection.height + 10;
  const top = below + toolbarHeight <= view.height - 8 ? below : Math.max(8, selection.y - toolbarHeight - 10);
  toolbarEl.style.left = `${left}px`;
  toolbarEl.style.top = `${top}px`;

  // 识别卡片（t75）：先试着贴在工具栏下面（它读起来是工具栏的"展开部分"），
  // 放不下再退到选区上方，最后才夹回视口内 —— 任何一步都不许把它推出屏幕。
  if (cardEl !== null && cardEl.hidden !== true) {
    // 选区一变，卡片里的文字就不再属于当前选区：直接关掉，不给"看错文字"的机会。
    if (state.text !== null && state.text.key !== keyOfPlan(plan)) closeCard();
    if (cardEl.hidden !== true) {
      const cardWidth = cardEl.offsetWidth || 560;
      const cardHeight = cardEl.offsetHeight || 200;
      const cardLeft = Math.max(8, Math.min(selection.x, view.width - cardWidth - 8));
      const underToolbar = top + toolbarHeight + 8;
      let cardTop;
      if (underToolbar + cardHeight <= view.height - 8) cardTop = underToolbar;
      else if (selection.y - cardHeight - 8 >= 8) cardTop = selection.y - cardHeight - 8;
      else cardTop = Math.max(8, Math.min(view.height - cardHeight - 8, underToolbar));
      cardEl.style.left = `${cardLeft}px`;
      cardEl.style.top = `${cardTop}px`;
    }
  }
}

/** 当前有效选区对应的 {@link selectionKey}（卡片失效判定用）。 @param {object|null} plan @returns {string} */
function keyOfPlan(plan) {
  return plan === null ? '' : selectionKey(plan);
}

/** @param {HTMLElement} element @param {{x: number, y: number, width: number, height: number}} rect @param {boolean} visible */
function place(element, rect, visible) {
  if (element === null || element === undefined) return;
  if (!visible) {
    element.style.display = 'none';
    return;
  }
  element.style.display = 'block';
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${Math.max(0, rect.width)}px`;
  element.style.height = `${Math.max(0, rect.height)}px`;
}

/**
 * 标注层：只画选区内的标注（所见即所得），裁剪**成对** save/restore（U-02 的教训：
 * 裁剪区是画布状态的一部分，不成对就会跨帧累加、把草稿裁没）。
 */
function paintInk() {
  const ctx = inkCanvas.getContext('2d');
  if (ctx === null) return;
  const drag = state.drag;
  const selection = drag !== null && drag.preview !== null ? drag.preview : state.selection;
  const sx = scaleX();
  const sy = scaleY();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
  const clipped = selection !== null && hasPositiveArea(selection);
  if (clipped) {
    // 裁剪区也按设备坐标算（标注存的就是设备像素）。
    const bounds = selectionBoundsDevice(selection);
    ctx.save();
    ctx.beginPath();
    ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
    ctx.clip();
  }
  // t70：标注就是**设备像素**（lib 的约定）—— 画的时候不再乘视口比例；被拖动中的那一条用预览值。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const environment = {
    mosaicSource: state.frame,
    mosaicSourceRect: { x: 0, y: 0, width: state.frame.width, height: state.frame.height },
    createScratch: (width, height) => scratchPool.create(width, height),
    mosaicStep: state.mosaicStep,
  };
  const present = state.history.present;
  for (let index = 0; index < present.length; index += 1) {
    scratchPool.reset();
    const preview = drag !== null && drag.annotationIndex === index ? drag.annotation : null;
    drawAnnotation(ctx, preview === null ? present[index] : preview, environment);
  }
  if (drag !== null && drag.draft !== null) {
    scratchPool.reset();
    drawAnnotation(ctx, drag.draft, environment);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (clipped) ctx.restore();
}

// ─── 标注提交（一次拖拽 = 一条历史） ────────────────────────────────────────
/** @param {object} annotation */
function commitAnnotation(annotation) {
  state.history.push([...state.history.present, annotation]);
  schedule();
  // 历史变了 → 撤销/重做的可用态跟着变（disabled 是可见状态，不能等到下次点工具才更新）。
  refreshToolbar();
}

/**
 * 用新值替换历史里的某一条（拖动/缩放已放置标注的收尾，t70）。
 * 一次拖拽只写一条历史 —— 中间的每一帧只走 `state.drag.annotation` 预览。
 * @param {number} index @param {object} annotation
 */
function commitAnnotationReplacement(index, annotation) {
  const present = state.history.present;
  if (index < 0 || index >= present.length) return;
  const next = [...present];
  next[index] = annotation;
  state.history.push(next);
  state.selected = annotation;
  schedule();
  refreshToolbar();
}

/** 删除当前选中的标注（Delete / Backspace，t70）：同样算一条历史，可 Ctrl+Z 撤销。 */
function deleteSelectedAnnotation() {
  const selected = state.selected;
  if (selected === null) return false;
  const index = state.history.present.indexOf(selected);
  if (index === -1) return false;
  const next = state.history.present.filter((_, current) => current !== index);
  state.history.push(next);
  state.selected = null;
  schedule();
  refreshToolbar();
  log('annotation deleted', { index, remaining: next.length });
  return true;
}

/** @param {object} point */
function beginDraft(point) {
  const tool = state.tool;
  if (tool === 'pen') return createStroke({ tool: 'pen', color: state.color, widthKey: state.widthKey, points: [point] });
  if (TOOL_IDS.includes(tool)) return createShape({ tool, color: state.color, widthKey: state.widthKey, from: point, to: point });
  return null;
}

/** @param {object} drag @param {object} point */
function updateDraft(drag, point) {
  if (drag.draft === null) return;
  if (state.tool === 'pen') {
    const points = appendPoint(drag.draft.points, point, 1.5);
    if (points !== drag.draft.points) {
      drag.draft = createStroke({ tool: 'pen', color: state.color, widthKey: state.widthKey, points });
    }
    return;
  }
  drag.draft = createShape({ tool: state.tool, color: state.color, widthKey: state.widthKey, from: drag.draft.from, to: point });
}

// ─── 指针交互 ───────────────────────────────────────────────────────────────
/** @param {PointerEvent} event @returns {{x: number, y: number}} */
function pointerPoint(event) {
  return { x: event.clientX, y: event.clientY };
}

/** @param {EventTarget|null} target @returns {boolean} */
function isChromeTarget(target) {
  if (target === null || target === undefined || typeof target.closest !== 'function') return false;
  // #ocr-card 也算 chrome（t75）：在识别结果里划选文字是**读**，不是拖出一个新选区。
  return target.closest('#toolbar, #editor, #ocr-card') !== null;
}

/**
 * 悬停光标（t71，用户口径）：**鼠标进入已绘制标注的范围就变成拖拽手柄**，不要求先切工具或先单击。
 *
 * 优先级：已选标注的角把手（缩放光标）→ 任意已放置标注（`move` 手柄）→ 选区把手（lib 的
 * `cursorForHandle`）→ 选区内部（移动工具下 `move`）→ 其它 `crosshair`。
 * @param {EventTarget|null} target
 * @returns {string}
 */
function hoverCursor(target) {
  if (isChromeTarget(target)) return 'default';
  const point = state.pointer ?? { x: 0, y: 0 };
  const device = toDevice(point);
  const selection = state.selection;
  if (selection === null || !hasPositiveArea(selection)) return 'crosshair';

  const selected = state.selected;
  const grabbed = selected === null ? null : hitAnnotationHandle(annotationRect(selected), device, handleToleranceDevice());
  if (grabbed !== null) return cursorForHandle(grabbed);
  if (findAnnotationAt(state.history.present, device, hitToleranceDevice()) !== -1) return 'move';

  const handle = hitHandle(selection, point, 7);
  if (handle !== null) return cursorForHandle(handle);
  if (containsPoint(selection, point) && state.tool === TOOL_MOVE) return 'move';
  return 'crosshair';
}

/**
 * 双击（t71）：光标处于"拖拽手柄"状态（即点在已放置的**文字**标注上）时，重新编辑它的文字。
 * 提交时用新值**替换**那一条（一次编辑 = 一条历史），不改位置。
 * @param {MouseEvent} event
 */
function onDoubleClick(event) {
  if (state.busy || !state.ready) return;
  if (isChromeTarget(event.target)) return;
  const point = pointerPoint(event);
  const device = toDevice(point);
  const index = findAnnotationAt(state.history.present, device, hitToleranceDevice());
  if (index === -1) return;
  const annotation = state.history.present[index];
  if (annotation.tool !== 'text') return;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  state.selected = annotation;
  openEditor(toCssRect(annotationRect(annotation)), { index, annotation });
  log('annotation edit started', { index });
}

/** @param {PointerEvent} event */
function onPointerDown(event) {
  if (event.button === 2) {
    void cancel('contextmenu');
    return;
  }
  if (event.button !== 0 || !state.ready || state.busy) return;
  if (isChromeTarget(event.target)) return;
  const point = pointerPoint(event);
  const device = toDevice(point);
  state.pointer = point;
  const selection = state.selection;
  let mode = 'create';
  let handle = null;
  let original = null;
  let originalIndex = -1;
  if (selection !== null && hasPositiveArea(selection)) {
    handle = hitHandle(selection, point, 7);
    if (handle !== null) {
      mode = 'resize';
    } else if (containsPoint(selection, point)) {
      // t71（用户口径）：**悬停即手柄、按下即拖** —— 不再要求先切到"移动"工具、
      // 也不要求先单击选中。命中优先级：已选标注的角把手 → 已放置标注 → （文字工具）新建文字
      // → （移动工具）拖整个选区 → 否则画新标注。
      const selected = state.selected;
      const grabbed = selected === null
        ? null
        : hitAnnotationHandle(annotationRect(selected), device, handleToleranceDevice());
      const hitIndex = findAnnotationAt(state.history.present, device, hitToleranceDevice());
      if (grabbed !== null && selected !== null) {
        mode = 'annotate-resize';
        handle = grabbed;
        original = selected;
        originalIndex = state.history.present.indexOf(selected);
      } else if (hitIndex !== -1) {
        mode = 'annotate-move';
        original = state.history.present[hitIndex];
        originalIndex = hitIndex;
        state.selected = original;
      } else if (state.tool === 'text') {
        openEditor(point, null);
        return;
      } else if (state.tool === TOOL_MOVE) {
        state.selected = null;
        mode = 'move';
      } else {
        mode = 'draw';
      }
    }
  }
  const drag = {
    mode,
    handle,
    start: point,
    startDevice: device,
    startSelection: selection === null ? null : { ...selection },
    preview: mode === 'create' || mode === 'annotate-move' || mode === 'annotate-resize'
      ? null
      : (selection === null ? null : { ...selection }),
    // 绘制草稿用**设备坐标**（与已放置标注同一空间）。
    draft: mode === 'draw' ? beginDraft(device) : null,
    annotation: null,
    annotationIndex: originalIndex,
    annotationOriginal: original,
    moved: false,
  };
  state.drag = drag;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  schedule();
}

/** @param {PointerEvent} event */
function onPointerMove(event) {
  if (state.drag === null) {
    state.pointer = pointerPoint(event);
    document.body.style.cursor = hoverCursor(event.target);
    return;
  }
  const drag = state.drag;
  const point = pointerPoint(event);
  const device = toDevice(point);
  state.pointer = point;
  const view = viewportSize();
  drag.moved = drag.moved || Math.abs(point.x - drag.start.x) > 0.5 || Math.abs(point.y - drag.start.y) > 0.5;
  if (drag.mode === 'create') {
    const box = rectFromCorners(drag.start, point);
    drag.preview = clampRectToFrame(box, view.width, view.height);
  } else if (drag.mode === 'resize' && drag.startSelection !== null) {
    drag.preview = resizeRect(drag.startSelection, drag.handle, point, view.width, view.height);
  } else if (drag.mode === 'move' && drag.startSelection !== null) {
    drag.preview = clampRectToFrame({
      x: drag.startSelection.x + (point.x - drag.start.x),
      y: drag.startSelection.y + (point.y - drag.start.y),
      width: drag.startSelection.width,
      height: drag.startSelection.height,
    }, view.width, view.height);
  } else if (drag.mode === 'draw') {
    updateDraft(drag, device);
  } else if (drag.mode === 'annotate-move' && drag.annotationOriginal !== null) {
    // 位移量按设备像素算，并被**夹在选区内**（lib 的 moveAnnotation 负责夹取）。
    const bounds = selectionBoundsDevice(drag.preview === null ? state.selection : drag.preview);
    const dx = (point.x - drag.start.x) * scaleX();
    const dy = (point.y - drag.start.y) * scaleY();
    drag.annotation = moveAnnotation(drag.annotationOriginal, dx, dy, bounds ?? undefined);
    state.selected = drag.annotation;
  } else if (drag.mode === 'annotate-resize' && drag.annotationOriginal !== null) {
    // 角把手缩放：先把矩形调到新尺寸，再由 lib 把它映射回该标注自身的数据形状。
    const nextRect = resizeAnnotationRect(
      annotationRect(drag.annotationOriginal),
      drag.handle,
      device,
      MIN_ANNOTATION_EDGE,
    );
    drag.annotation = scaleAnnotation(drag.annotationOriginal, nextRect);
    state.selected = drag.annotation;
  }
  schedule();
}

/** @param {PointerEvent} event */
function onPointerUp(event) {
  const drag = state.drag;
  if (drag === null) return;
  state.drag = null;
  if (drag.mode === 'draw') {
    if (drag.draft !== null && drag.moved) commitAnnotation(drag.draft);
    else schedule();
    return;
  }
  if (drag.mode === 'annotate-move' || drag.mode === 'annotate-resize') {
    // 一次拖拽 = 一条历史（与 B-13 同一口径：只把最终值写进历史，不记录中间帧）。
    if (drag.annotation !== null && drag.moved) commitAnnotationReplacement(drag.annotationIndex, drag.annotation);
    else schedule();
    return;
  }
  if (drag.preview === null) {
    schedule();
    return;
  }
  // B-5：宽或高 < 8 device px（或越出冻结帧）视为无效 → 取消本次（复用 lib 的判定）。
  const plan = planFor(drag.preview);
  if (plan === null || !plan.valid) {
    void cancel(plan !== null && plan.clipped ? 'selection.clipped' : 'selection.tooSmall');
    return;
  }
  state.selection = drag.preview;
  schedule();
}

// ─── 文字输入 ───────────────────────────────────────────────────────────────
/**
 * 打开文字输入框。
 * @param {{x: number, y: number}} point - 输入框落点（视口坐标）。
 * @param {{index: number, annotation: object}|null} [editing] - 非空表示**改已有的文字**
 *   （t71 双击进入），提交时替换那一条而不是新增。
 */
function openEditor(point, editing = null) {
  state.editor = point;
  state.editorEditing = editing;
  editorEl.style.display = 'block';
  editorEl.style.left = `${point.x}px`;
  editorEl.style.top = `${point.y}px`;
  editorEl.value = editing === null ? '' : String(editing.annotation.text ?? '');
  editorEl.focus();
  if (editing !== null && typeof editorEl.select === 'function') editorEl.select();
}

function closeEditor() {
  state.editor = null;
  state.editorEditing = null;
  editorEl.style.display = 'none';
  editorEl.value = '';
}

function commitEditor() {
  const point = state.editor;
  const editing = state.editorEditing;
  const text = String(editorEl.value ?? '').trim();
  closeEditor();
  if (point === null) return;
  // 清空文字 = 取消本次编辑（不静默删掉标注）。
  if (text === '') return;
  if (editing !== null) {
    // t71：改文字 —— 位置不变，只换内容，并把量出来的新矩形一起写回（一次编辑 = 一条历史）。
    const edited = { ...editing.annotation, text };
    const size = measureTextAnnotation(inkCanvas.getContext('2d'), edited);
    const next = withTextMetrics(edited, size);
    commitAnnotationReplacement(editing.index, next);
    state.selected = next;
    log('annotation edited', { index: editing.index, textLength: text.length });
    return;
  }
  // t70：标注统一存**设备坐标** —— 这里乘一次 1:1 映射比例，绘制/命中/导出都不再换算。
  const device = toDevice(point);
  const annotation = createText({ text, color: state.color, x: device.x, y: device.y, sizeKey: state.textSizeKey });
  const size = measureTextAnnotation(inkCanvas.getContext('2d'), annotation);
  const committed = withTextMetrics(annotation, size);
  commitAnnotation(committed);
  state.selected = committed;
}

// ─── 工具栏 ─────────────────────────────────────────────────────────────────
/**
 * 图标轮廓（16×16 视图框，只描边、颜色继承 currentColor）。
 * 与 DSH 内覆盖层（`client.js` 的 `toolIcon` / `undoIcon` / `redoIcon` / `closeIcon`）
 * 用同一套 path 数据：两个入口看起来必须是同一个工具栏，而不是"一个图标版、一个文字版"。
 */
const ICON_STROKE = Object.freeze({ fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' });
const ICON_SHAPES = Object.freeze({
  move: [
    ['path', { d: 'M8 2.5v11M2.5 8h11' }],
    ['path', { d: 'M8 2.5 6.2 4.6M8 2.5l1.8 2.1M8 13.5l-1.8-2.1M8 13.5l1.8-2.1M2.5 8l2.1-1.8M2.5 8l2.1 1.8M13.5 8l-2.1-1.8M13.5 8l-2.1 1.8', strokeWidth: 1.1 }],
  ],
  rect: [['rect', { x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.4 }]],
  ellipse: [['ellipse', { cx: 8, cy: 8, rx: 5.5, ry: 4.5 }]],
  arrow: [['path', { d: 'M3 12.5 12 3.5' }], ['path', { d: 'M7.6 3.5H12v4.4' }]],
  pen: [['path', { d: 'M3 12.4c1.8-.6 2.2-5.4 4.4-5.4 2.2 0 1.4 4.2 3.2 4.2 1 0 1.6-.9 1.9-1.6' }]],
  mosaic: [
    ['rect', { x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.4 }],
    ['path', { d: 'M6.2 3.5v9M9.8 3.5v9M2.5 6.5h11M2.5 9.5h11', strokeWidth: 0.9 }],
  ],
  text: [['path', { d: 'M3.5 4h9M8 4v8.5' }], ['path', { d: 'M6 12.5h4' }]],
  undo: [['path', { d: 'M6 4.5 3 7.5l3 3' }], ['path', { d: 'M3 7.5h6.2c2.1 0 3.8 1.5 3.8 3.4' }]],
  redo: [['path', { d: 'M10 4.5l3 3-3 3' }], ['path', { d: 'M13 7.5H6.8C4.7 7.5 3 9 3 10.9' }]],
  close: [['path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6', strokeWidth: 1.4, strokeLinecap: 'round' }]],
  // 三个动作（t68）：插入 = 对勾、复制 = 两张叠纸、另存为 = 下载（箭头入托盘）。
  check: [['path', { d: 'M3.2 8.6l3.2 3.2 6.4-7.6', strokeWidth: 1.6 }]],
  copy: [
    ['rect', { x: 5.6, y: 5.6, width: 7.9, height: 7.9, rx: 1.6 }],
    ['path', { d: 'M10.4 5.6V4.2A1.7 1.7 0 0 0 8.7 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2v4.5a1.7 1.7 0 0 0 1.7 1.7h1.4' }],
  ],
  download: [
    ['path', { d: 'M8 2.6v7.2' }],
    ['path', { d: 'M4.9 6.9 8 10l3.1-3.1' }],
    ['path', { d: 'M3 12.6h10' }],
  ],
  // t75：识别 = 取景框里的三条文本行；翻译 = 地球（经纬线 + 赤道）。
  scan: [
    ['path', { d: 'M2.5 5.2V4a1.5 1.5 0 0 1 1.5-1.5h1.4M13.5 5.2V4A1.5 1.5 0 0 0 12 2.5h-1.4M2.5 10.8V12A1.5 1.5 0 0 0 4 13.5h1.4M13.5 10.8V12a1.5 1.5 0 0 1-1.5 1.5h-1.4' }],
    ['path', { d: 'M4.6 6.3h6.8M4.6 8.2h4.6', strokeWidth: 1.1 }],
  ],
  globe: [
    ['circle', { cx: 8, cy: 8, r: 5.6 }],
    ['path', { d: 'M2.6 8h10.8' }],
    ['path', { d: 'M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6S9.6 12 8 13.6C6.4 12 5.6 10.1 5.6 8s.8-4 2.4-5.6z', strokeWidth: 1.1 }],
  ],
});

/** 建一个图标节点。@param {string} name @param {number} [size] @returns {SVGElement} */
function icon(name, size = 15) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attributes] of ICON_SHAPES[name] ?? ICON_SHAPES.rect) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries({ ...ICON_STROKE, ...attributes })) node.setAttribute(key, String(value));
    svg.appendChild(node);
  }
  return svg;
}

/**
 * 建一个按钮。给了 `icon` 就是**图标按钮**（可见内容只有图标，名字走 `title` 悬停提示 +
 * `aria-label`，与 DSH 内覆盖层同一口径）；否则是文字按钮（三个动作、线宽/字号/粒度 chip）。
 * @param {string} label @param {string} aria @param {Function} onClick
 * @param {{pressed?: boolean, className?: string, icon?: string, iconSize?: number}} [options]
 */
function button(label, aria, onClick, options = {}) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = options.className ?? 'btn';
  if (options.icon !== undefined) {
    element.appendChild(icon(options.icon, options.iconSize ?? 17));
    element.classList.add('icon');
  } else {
    element.textContent = label;
  }
  element.setAttribute('aria-label', aria);
  if (label !== '') element.title = label;
  if (options.pressed !== undefined) element.setAttribute('aria-pressed', options.pressed ? 'true' : 'false');
  element.addEventListener('click', () => {
    try {
      onClick();
    } catch (error) {
      notice(String(error), 'error');
    }
  });
  return element;
}

/** 一个分组里的按钮（跳过分组里的文字标签 span）。@param {string} id @returns {HTMLButtonElement[]} */
function groupButtons(id) {
  return [...$(id).querySelectorAll('button')];
}

function buildToolbar() {
  const tools = $('group-tools');
  const entries = [[TOOL_MOVE, T.move], ...TOOL_IDS.map((id) => [id, T[id]])];
  for (const [id, label] of entries) {
    tools.appendChild(button(label, `工具：${label}`, () => {
      state.tool = id;
      // 换工具就清掉标注选中态：拖动已放置标注与当前工具无关（t71），但选中框只服务于"正在编辑"。
      state.selected = null;
      refreshToolbar();
      // 分组显隐会改变工具栏宽度：立刻按新尺寸重新贴选区，别等下一次指针移动。
      paintChrome();
      notice('');
    }, { pressed: state.tool === id, icon: id }));
  }
  const colors = $('group-colors');
  for (const color of COLORS) {
    colors.appendChild(button('', `颜色：${color.id}`, () => {
      state.color = color.value;
      refreshToolbar();
    }, { pressed: state.color === color.value, className: 'btn swatch' }));
    const element = colors.lastElementChild;
    element.style.background = color.value;
  }
  const widths = $('group-widths');
  for (const key of LINE_WIDTH_ORDER) {
    widths.appendChild(button(T.widths[key], `线宽：${T.widths[key]}（${LINE_WIDTHS[key]} px）`, () => {
      state.widthKey = key;
      refreshToolbar();
    }, { pressed: state.widthKey === key, className: 'btn chip' }));
  }
  const sizes = $('group-sizes');
  sizes.appendChild(Object.assign(document.createElement('span'), { className: 'label', textContent: '字号' }));
  for (const key of TEXT_SIZE_ORDER) {
    sizes.appendChild(button(T.sizes[key], `字号：${T.sizes[key]}`, () => {
      state.textSizeKey = key;
      refreshToolbar();
    }, { pressed: state.textSizeKey === key, className: 'btn chip' }));
  }
  const mosaic = $('group-mosaic');
  mosaic.appendChild(Object.assign(document.createElement('span'), { className: 'label', textContent: '粒度' }));
  for (const step of MOSAIC_STEPS_UI) {
    mosaic.appendChild(button(T.tiles[step], `马赛克粒度：${T.tiles[step]}（${mosaicCellSize(step)} px）`, () => {
      state.mosaicStep = step;
      refreshToolbar();
    }, { pressed: state.mosaicStep === step, className: 'btn chip' }));
  }
  const historyGroup = $('group-history');
  historyGroup.appendChild(button(T.undo, T.undo, () => {
    if (state.history.undo()) schedule();
    refreshToolbar();
  }, { icon: 'undo' }));
  historyGroup.appendChild(button(T.redo, T.redo, () => {
    if (state.history.redo()) schedule();
    refreshToolbar();
  }, { icon: 'redo' }));
  const actions = $('group-actions');
  // t75：识别与翻译在最左边（它们是"读这块区域"，与右边那四个"对图片做什么"是两回事），
  // 与三个结果动作之间隔一根竖线。都是图标按钮：悬停出名字（title）、无障碍走 aria-label。
  textButtons.ocr = button(T.ocr, T.ocr, () => {
    if (state.textBusy) return;
    void (async () => {
      const plan = await planOrCancel();
      if (plan === null) return;
      state.textBusy = true;
      refreshToolbar();
      showCard();
      setMeta(sourceMetaEl, T.ocrBusy, 'info');
      try {
        await runOcr(plan, false);
      } finally {
        state.textBusy = false;
        refreshToolbar();
        paintChrome();
      }
    })();
  }, { icon: 'scan', iconSize: 16 });
  actions.appendChild(textButtons.ocr);
  textButtons.translate = button(T.translate, T.translate, () => void runTranslate(), { icon: 'globe', iconSize: 16 });
  actions.appendChild(textButtons.translate);
  actions.appendChild(Object.assign(document.createElement('span'), { className: 'divider' }));
  // 三个动作 + 取消都是**图标按钮**（t68）：悬停出名字（title）、无障碍走 aria-label。
  // 顺序（t69 按用户要求）：复制 → 另存为 → 取消 → **✓ 插入对话放最后**（行尾的确认键，
  // 与"取消在左、确认在右"的直觉一致；它仍是默认高亮动作）。
  actions.appendChild(button(T.copy, T.copy, () => void submit('copy'), { icon: 'copy', iconSize: 16 }));
  actions.appendChild(button(T.save, T.save, () => void submit('save'), { icon: 'download', iconSize: 16 }));
  actions.appendChild(button(T.cancel, T.cancel, () => void cancel('toolbar'), { icon: 'close', iconSize: 14 }));
  actions.appendChild(button(T.insert, `${T.insert}（默认动作）`, () => void submit('insert'), { className: 'btn primary', icon: 'check', iconSize: 16 }));
  buildCardControls();
}

/**
 * 结果卡片自己的控件（t75）：关闭、两个复制、目标语言下拉框。
 *
 * 下拉框的 `<option>` 取自 `lib/ocr.mjs` 的 `TRANSLATE_TARGETS` —— 与宿主校验目标语言用的是
 * **同一份闭集**，面板不可能发出宿主不认的 id。
 */
function buildCardControls() {
  buildTargetOptions();
  const closeButton = $('ocr-close');
  if (closeButton !== null) {
    closeButton.title = T.close;
    closeButton.addEventListener('click', () => {
      closeCard();
      paintChrome();
    });
  }
  const copySource = $('ocr-copy-source');
  if (copySource !== null) {
    copySource.title = T.copy;
    copySource.addEventListener('click', () => {
      const value = state.text?.text ?? '';
      if (value === '') return;
      void copyText(value, T.ocrCopied);
    });
  }
  const copyTarget = $('ocr-copy-target');
  if (copyTarget !== null) {
    copyTarget.title = T.copy;
    copyTarget.addEventListener('click', () => {
      const value = state.translation?.text ?? '';
      if (value === '') return;
      void copyText(value, T.translateCopied);
    });
  }
  if (targetSelectEl !== null) {
    targetSelectEl.value = state.translateTarget;
    // 换目标语言 = 换一种译文：已经识别过的文字不重新识别，只重发翻译。
    targetSelectEl.addEventListener('change', () => {
      state.translateTarget = normalizeTranslateTarget(targetSelectEl.value);
      state.translation = null;
      void runTranslate();
    });
  }
  // 宿主没有这三条路由时（见 hostHasTextRoutes）把两个入口**明确置灰**：能点却必然失败，
  // 比看得出来用不了更糟。原因写在 title 与提示行上，用户一眼知道该做什么。
  if (!hostHasTextRoutes) {
    for (const element of [textButtons.ocr, textButtons.translate]) {
      if (element === undefined) continue;
      element.disabled = true;
      element.title = T.hostStale;
    }
    notice(T.hostStale, 'error');
  }
}

/**
 * 刷新工具栏：按压态 + **按当前工具显隐分组** + 撤销/重做的可用态。
 *
 * 口径与 DSH 内覆盖层一致：线宽常显（矩形/椭圆/箭头/画笔都用得上），**字号只在文字工具下出现、
 * 马赛克粒度只在马赛克工具下出现** —— 移动/框选时不该看到一堆用不上的档位。
 */
function refreshToolbar() {
  const tools = groupButtons('group-tools');
  const entries = [TOOL_MOVE, ...TOOL_IDS];
  for (let index = 0; index < tools.length; index += 1) {
    tools[index].setAttribute('aria-pressed', state.tool === entries[index] ? 'true' : 'false');
  }
  const colors = groupButtons('group-colors');
  for (let index = 0; index < colors.length; index += 1) {
    colors[index].setAttribute('aria-pressed', state.color === COLORS[index].value ? 'true' : 'false');
  }
  const widths = groupButtons('group-widths');
  for (let index = 0; index < widths.length; index += 1) {
    widths[index].setAttribute('aria-pressed', state.widthKey === LINE_WIDTH_ORDER[index] ? 'true' : 'false');
  }
  const sizes = groupButtons('group-sizes');
  for (let index = 0; index < sizes.length; index += 1) {
    sizes[index].setAttribute('aria-pressed', state.textSizeKey === TEXT_SIZE_ORDER[index] ? 'true' : 'false');
  }
  const mosaic = groupButtons('group-mosaic');
  for (let index = 0; index < mosaic.length; index += 1) {
    mosaic[index].setAttribute('aria-pressed', state.mosaicStep === MOSAIC_STEPS_UI[index] ? 'true' : 'false');
  }
  const showSizes = state.tool === 'text';
  const showMosaic = state.tool === 'mosaic';
  // t68：线宽只在"真的会用线宽"的绘图工具下出现（矩形/椭圆/箭头/画笔）。
  const showWidths = WIDTH_TOOL_IDS.includes(state.tool);
  // t72（用户口径）：颜色只在"会落色"的工具下出现（矩形/椭圆/箭头/画笔/文字；移动与马赛克都不显示）。
  const showColors = COLOR_TOOL_IDS.includes(state.tool);
  $('group-colors').hidden = !showColors;
  $('group-widths').hidden = !showWidths;
  $('group-sizes').hidden = !showSizes;
  $('group-mosaic').hidden = !showMosaic;
  // 竖线只在"它后面那个分组可见、且前面已经出现过可见分组"时显示 —— 否则行首/行尾会留一根孤线
  // （例如马赛克工具下色板与线宽都收起，粒度前面那根线就会孤零零挂在行首）。
  let seenGroup = false;
  for (const [groupId, dividerId] of ROW_STYLE_GROUPS) {
    const group = $(groupId);
    if (group === null) continue;
    const visible = group.hidden !== true;
    if (dividerId !== null) {
      const divider = $(dividerId);
      if (divider !== null) divider.hidden = !(visible && seenGroup);
    }
    if (visible) seenGroup = true;
  }
  const historyButtons = groupButtons('group-history');
  if (historyButtons[0] !== undefined) historyButtons[0].disabled = !state.history.canUndo();
  if (historyButtons[1] !== undefined) historyButtons[1].disabled = !state.history.canRedo();
  // t75：识别/翻译进行中只禁用这两个按钮 —— 标注与三个结果动作**不受影响**，
  // 用户想放弃识别直接插入对话，不该被一个网络请求挡住。
  // `hostHasTextRoutes` 也要算进来，否则这一行会在"宿主没重启"时把置灰又抹掉。
  const textDisabled = state.textBusy || !hostHasTextRoutes;
  if (textButtons.ocr !== undefined) textButtons.ocr.disabled = textDisabled;
  if (textButtons.translate !== undefined) textButtons.translate.disabled = textDisabled;
}

// ─── 键盘 / 右键 ────────────────────────────────────────────────────────────
/** @param {KeyboardEvent} event */
function onKeyDown(event) {
  if (state.editor !== null && event.target === editorEl) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEditor();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeEditor();
    }
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    // t75：识别结果开着时，Esc 先关卡片 —— 与"Esc 取消整次截图"并存不会让人误触：
    // 卡片是最后出现的东西，第一下 Esc 收回它，第二下才取消。
    if (cardEl !== null && cardEl.hidden !== true) {
      closeCard();
      paintChrome();
      return;
    }
    void cancel('escape');
    return;
  }
  // t70（B-13）：选中标注后按 Delete / Backspace 只删它，选中态随之清除（可 Ctrl+Z 撤销恢复）。
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (deleteSelectedAnnotation()) {
      event.preventDefault();
      return;
    }
  }
  const accel = event.ctrlKey === true || event.metaKey === true;
  if (!accel) return;
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  if (key !== 'z' && key !== 'y') return;
  event.preventDefault();
  const changed = key === 'y' || event.shiftKey === true ? state.history.redo() : state.history.undo();
  if (changed) schedule();
  refreshToolbar();
}

// ─── 导出（lib 的 sizeAttempts 降级链 + formatOf 的 MIME/扩展名） ───────────
/**
 * 把「选区 + 标注」画到一张新画布（不含遮罩/工具栏 —— 它们只存在于页面 chrome 里）。
 * @param {object} plan @param {{width: number, height: number}} attempt @returns {HTMLCanvasElement|null}
 */
function renderSelection(plan, attempt) {
  const width = Math.max(1, Math.round(attempt.width));
  const height = Math.max(1, Math.round(attempt.height));
  if (plan.deviceRect.width <= 0 || plan.deviceRect.height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const sx = width / plan.deviceRect.width;
  const sy = height / plan.deviceRect.height;
  ctx.setTransform(sx, 0, 0, sy, -plan.deviceRect.x * sx, -plan.deviceRect.y * sy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.frame, 0, 0);
  const environment = {
    mosaicSource: state.frame,
    mosaicSourceRect: { x: 0, y: 0, width: state.frame.width, height: state.frame.height },
    createScratch: (width2, height2) => scratchPool.create(width2, height2),
    mosaicStep: state.mosaicStep,
  };
  for (const annotation of state.history.present) {
    scratchPool.reset();
    drawAnnotation(ctx, annotation, environment);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

/** @param {HTMLCanvasElement} canvas @param {string} mediaType @param {number|undefined} quality @returns {Promise<Blob|null>} */
function encodeCanvas(canvas, mediaType, quality) {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ENCODE_DEADLINE_MS);
    try {
      canvas.toBlob((blob) => {
        window.clearTimeout(timer);
        resolve(blob);
      }, mediaType, quality);
    } catch (error) {
      window.clearTimeout(timer);
      log('toBlob threw', { error: String(error) });
      resolve(null);
    }
  });
}

/**
 * 按 `lib/capture-plan.mjs` 的降级链编码：第一个不超阈值的产物胜出，全超限就用最后一个
 * （MIME 与扩展名都取自实际编码格式 —— R-01 的教训）。
 * @param {object} plan @returns {Promise<{blob: Blob, mediaType: string, attempt: object}|null>}
 */
async function encodeSelection(plan) {
  const policy = resolveSizePolicy({ maxEdge: DEFAULT_MAX_EDGE, maxBytes: DEFAULT_MAX_BYTES, allowLossy: true, allowLogicalDownscale: true });
  const attempts = sizeAttempts(plan, policy);
  let rendered = { key: null, canvas: null };
  let last = null;
  for (const attempt of attempts) {
    const key = `${Math.round(attempt.width)}x${Math.round(attempt.height)}`;
    if (rendered.key !== key) {
      if (rendered.canvas !== null) {
        rendered.canvas.width = 0;
        rendered.canvas.height = 0;
      }
      rendered = { key, canvas: renderSelection(plan, attempt) };
    }
    if (rendered.canvas === null) continue;
    const blob = await encodeCanvas(rendered.canvas, attempt.mediaType, attempt.quality);
    if (blob === null || blob.size === 0) continue;
    last = { blob, mediaType: attempt.mediaType, attempt };
    if (blob.size <= policy.maxBytes) break;
  }
  if (rendered.canvas !== null) {
    rendered.canvas.width = 0;
    rendered.canvas.height = 0;
  }
  return last;
}

// ─── 区域识别 + 翻译（t75） ─────────────────────────────────────────────────
/**
 * 一次识别/翻译的**身份**：产生它时选区的设备矩形。
 *
 * 这是整张卡片唯一的正确性约束。用户改了选区却看到上一次的文字（或更糟：翻译了上一块区域），
 * 是这种功能最容易出的错，而且看起来像"翻译不准"。所有缓存命中判断都走这个 key。
 * @param {object} plan @returns {string}
 */
function selectionKey(plan) {
  const rect = plan?.deviceRect;
  if (rect === undefined) return '';
  return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(':');
}

/**
 * 把选区**从冻结帧原样裁下来**（不带标注）。
 *
 * 刻意不用 `renderSelection(plan, attempt)`：那个函数会把标注也画上去，而识别要读的是
 * **屏幕上的字**。用户在文字上画了个红框再点识别，红框不该变成识别结果的一部分
 * （马赛克同理 —— 想遮住的东西不该被识别出来）。
 *
 * 缩放只在超过 {@link MAX_OCR_REGION_EDGE} 时发生（正常屏幕上永远是原生分辨率，
 * 识别精度因此不打折）。
 * @param {object} plan @returns {HTMLCanvasElement|null}
 */
function renderRegion(plan) {
  const rect = plan?.deviceRect;
  if (rect === undefined || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(1, MAX_OCR_REGION_EDGE / rect.width, MAX_OCR_REGION_EDGE / rect.height);
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.frame, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  return canvas;
}

/**
 * 选区 → PNG data URL（识别请求的载荷）。
 * @param {object} plan @returns {Promise<string|null>}
 */
async function regionDataUrl(plan) {
  const canvas = renderRegion(plan);
  if (canvas === null) return null;
  const blob = await encodeCanvas(canvas, 'image/png', undefined);
  canvas.width = 0;
  canvas.height = 0;
  if (blob === null || blob.size === 0) return null;
  return blobToDataUrl(blob);
}

/**
 * 给宿主发一次 JSON 请求并读回 JSON。
 *
 * **故意不叫 `submit` / `postResult`**（那两个函数是"提交结果图"的）：validate.mjs 的 X-1
 * 会把这两个函数的**字符串实参**当成"页面提交的动作词表"，只允许 insert/copy/save/cancel。
 * 识别与翻译是**旁路**，不是结果动作，所以走这个自己的函数 —— 用那两个名字就等于把冻结
 * 词表撑开，而报错会出现在离这里很远的地方。
 * @param {string} endpoint @param {object} payload
 * @returns {Promise<{status: number, body: object|null}>}
 */
async function askHost(endpoint, payload) {
  const response = await fetch(withToken(endpoint), {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** @param {HTMLElement|null} element @param {string} text @param {'info'|'error'|'ok'} [kind] */
function setMeta(element, text, kind = 'info') {
  if (element === null) return;
  element.textContent = text;
  element.dataset.kind = kind;
}

/** 卡片显隐。`paintChrome()` 负责摆位置（与工具栏同一套"贴选区"逻辑）。 */
function showCard() {
  if (cardEl === null) return;
  cardEl.hidden = false;
  paintChrome();
}

function hideCard() {
  if (cardEl !== null) cardEl.hidden = true;
}

/** 关掉卡片并清掉两条结果（选区没变也强制重来）。 */
function closeCard() {
  hideCard();
  state.text = null;
  state.translation = null;
  if (sourceTextEl !== null) sourceTextEl.textContent = '';
  if (targetTextEl !== null) targetTextEl.textContent = '';
  setMeta(sourceMetaEl, '');
  setMeta(targetMetaEl, '');
  if (targetBlockEl !== null) targetBlockEl.hidden = true;
}

/** 把面板的目标语言同步到下拉框（初值取自 URL/默认，之后由用户改）。 */
function buildTargetOptions() {
  if (targetSelectEl === null) return;
  const wanted = normalizeTranslateTarget(state.translateTarget);
  state.translateTarget = wanted;
  targetSelectEl.textContent = '';
  for (const entry of TRANSLATE_TARGETS) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    if (entry.id === wanted) option.selected = true;
    targetSelectEl.appendChild(option);
  }
}

/**
 * 复制一段文本到系统剪贴板 —— **通过宿主**，页面自己绝不碰操作系统。
 *
 * 这是页面既有的硬契约（README「动作由 DSH 侧执行」，`tests/overlay-page.test.mjs` 的 t57-4
 * 逐条钉着：页面源码里不许出现浏览器剪贴板 API）。所以复制和抓屏、识别一样，都由宿主的
 * PowerShell 落地；顺带还解决了两件事：kiosk 窗口失焦时浏览器会拒绝写剪贴板、
 * 以及"写没写进去"只能靠猜 —— 现在两边都有明确的成功/失败回报。
 * @param {string} value @param {string} okMessage @returns {Promise<boolean>}
 */
async function copyText(value, okMessage) {
  if (value === '') return false;
  let answer;
  try {
    answer = await askHost(ENDPOINTS.clipboard, { text: value });
  } catch (error) {
    notice(`${T.copyFailed}（${String(error)}）`, 'error');
    return false;
  }
  const body = answer.body;
  if (body === null || body.ok !== true) {
    const label = body === null ? T.copyFailed : T[errorTextKey(body.error)] ?? T.copyFailed;
    notice(`${label}${body?.message === undefined ? '' : `（${body.message}）`}`, 'error');
    return false;
  }
  notice(okMessage, 'info');
  return true;
}

/** 选区的 `planFor`，无效时按原有语义取消本次截图（与 submit 同一条口径）。 */
async function planOrCancel() {
  const plan = planFor(state.selection);
  if (plan === null || !plan.valid) {
    await cancel(plan !== null && plan.clipped ? 'selection.clipped' : 'selection.tooSmall');
    return null;
  }
  return plan;
}

/** 一行诊断信息：行数、字号、语言、耗时。 */
function ocrMetaOf(result) {
  const parts = [];
  if (result.lines.length > 0) parts.push(`${result.lines.length} 行`);
  if (result.language !== '') parts.push(result.language);
  parts.push(`${result.elapsedMs} ms`);
  return parts.join(' · ');
}

/**
 * 把一次旁路请求的失败体翻成给用户看的那句话。
 *
 * 三种情况要分开，因为**用户的下一步动作完全不同**：
 *  1. 宿主答了但没带错误码（或干脆是空的 404）→ 界面比宿主新，重启 DSH Desktop（`hostStale`）；
 *  2. 宿主答了明确的错误码 → 按码取文案（没装语言包、超时、模型不可用…）；
 *  3. 码不认识 → 该族的通用文案（识别失败 / 翻译失败）。
 *
 * 第一种是第一版漏掉的：那时所有"没有码"的失败都落到通用文案上，于是**没重启 DSH**
 * 被显示成「识别失败 · OCR failed」，把人引到语言包/权限的方向去查（实测踩到）。
 * @param {{status: number, body: object|null}} answer - {@link askHost} 的结果。
 * @param {string} fallback - 该族的通用文案。
 * @returns {string} 要显示在卡片标题行右侧的那句话。
 */
function describeAuxFailure(answer, fallback) {
  const body = answer?.body;
  const code = typeof body?.error === 'string' ? body.error : '';
  // 空 body 的 404：DSH 会把前缀路由处理器的 404 换成它自己的空答案（实测），
  // 所以"没有码 + 客户端错误状态"就是"这条路由根本不存在"。
  const routeMissing = code === ''
    || code === 'overlay.not-found'
    || (answer?.status === 404 && code !== 'overlay.unknown-token');
  const label = routeMissing ? T.hostStale : (T[errorTextKey(code)] ?? fallback);
  const detail = typeof body?.message === 'string' && body.message !== '' ? `（${body.message}）` : '';
  return `${label}${detail}`;
}

/**
 * 识别选区文字。
 * @param {object} plan @param {boolean} [silent] - 供 {@link runTranslate} 复用时不重复写"识别中"。
 * @returns {Promise<boolean>} 是否拿到了可用的识别结果。
 */
async function runOcr(plan, silent = false) {
  const key = selectionKey(plan);
  const dataUrl = await regionDataUrl(plan);
  if (dataUrl === null) {
    showCard();
    setMeta(sourceMetaEl, T.ocrFailed, 'error');
    return false;
  }
  if (!silent) setMeta(sourceMetaEl, T.ocrBusy, 'info');
  let answer;
  try {
    answer = await askHost(ENDPOINTS.ocr, { png: dataUrl });
  } catch (error) {
    setMeta(sourceMetaEl, `${T.ocrFailed}（${String(error)}）`, 'error');
    return false;
  }
  const body = answer.body;
  if (body === null || body.ok !== true) {
    setMeta(sourceMetaEl, describeAuxFailure(answer, T.ocrFailed), 'error');
    return false;
  }
  state.text = { key, text: typeof body.text === 'string' ? body.text : '', empty: body.empty === true };
  state.translation = null;
  if (targetBlockEl !== null) targetBlockEl.hidden = true;
  if (sourceTextEl !== null) sourceTextEl.textContent = state.text.text;
  if (isEmptyOcrText(state.text.text)) {
    setMeta(sourceMetaEl, T.ocrEmpty, 'error');
    log('ocr: no text in the region', { key, lines: body.lines?.length ?? 0 });
    return false;
  }
  setMeta(sourceMetaEl, ocrMetaOf({ lines: body.lines ?? [], language: body.language ?? '', elapsedMs: body.elapsedMs ?? 0 }), 'ok');
  log('ocr: recognized', { key, chars: state.text.text.length, lines: body.lines?.length ?? 0 });
  return true;
}

/**
 * 翻译选区文字：先保证有识别结果（缓存命中就不重复识别），再调模型。
 *
 * 「识别 → 翻译」两步对用户是一次点击：他选中一段外文点翻译，不该先点识别再点翻译。
 * 但**已经识别过**的选区不会再识别第二遍（缓存按选区 key 命中），所以连点两次翻译
 * 只花一次 OCR 的钱。
 * @returns {Promise<void>}
 */
async function runTranslate() {
  if (state.textBusy) return;
  const plan = await planOrCancel();
  if (plan === null) return;
  const key = selectionKey(plan);
  state.textBusy = true;
  refreshToolbar();
  showCard();
  try {
    const cached = state.text !== null && state.text.key === key && !isEmptyOcrText(state.text.text);
    if (!cached) {
      setMeta(targetMetaEl, T.ocrBusy, 'info');
      const recognized = await runOcr(plan, false);
      if (!recognized) {
        setMeta(targetMetaEl, '', 'info');
        return;
      }
    } else {
      if (sourceTextEl !== null) sourceTextEl.textContent = state.text.text;
    }
    if (targetBlockEl !== null) targetBlockEl.hidden = false;
    const target = normalizeTranslateTarget(state.translateTarget);
    if (state.translation !== null && state.translation.key === key && state.translation.target === target) {
      if (targetTextEl !== null) targetTextEl.textContent = state.translation.text;
      setMeta(targetMetaEl, state.translation.meta, 'ok');
      return;
    }
    if (targetTextEl !== null) targetTextEl.textContent = '';
    setMeta(targetMetaEl, T.translateBusy, 'info');
    if (targetBlockEl !== null) targetBlockEl.dataset.busy = 'true';
    let answer;
    try {
      answer = await askHost(ENDPOINTS.translate, { text: state.text.text, target });
    } catch (error) {
      setMeta(targetMetaEl, `${T.translateFailed}（${String(error)}）`, 'error');
      return;
    }
    const body = answer.body;
    if (body === null || body.ok !== true) {
      setMeta(targetMetaEl, describeAuxFailure(answer, T.translateFailed), 'error');
      return;
    }
    const notes = [`${body.provider}/${body.model}`, `${body.elapsedMs} ms`];
    if (body.unchanged === true) notes.push(T.unchanged);
    if (body.truncated === true) notes.push(T.truncated);
    const meta = notes.join(' · ');
    state.translation = { key, target, text: body.text, meta };
    if (targetTextEl !== null) targetTextEl.textContent = body.text;
    setMeta(targetMetaEl, meta, 'ok');
    log('translate: done', { key, target, chars: body.text.length, ms: body.elapsedMs });
  } finally {
    if (targetBlockEl !== null) targetBlockEl.dataset.busy = 'false';
    state.textBusy = false;
    refreshToolbar();
    paintChrome();
  }
}

// ─── 回传 / 心跳 / 收尾 ─────────────────────────────────────────────────────
let heartbeatTimer = null;

function startHeartbeat() {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = window.setInterval(() => {
    void fetch(withToken(ENDPOINTS.ping), { cache: 'no-store', credentials: 'same-origin' }).catch(() => {});
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer === null) return;
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * 把结果交回宿主：**只**有 `{action, png}` 两个字段（冻结契约）。
 * `png` 是 data URL，MIME 取自实际编码格式（WebP 降级时就是 `data:image/webp;…`），
 * 宿主按它决定扩展名 —— 页面不自己下载文件、不写剪贴板。
 * @param {'insert'|'copy'|'save'|'cancel'} action @param {string|null} dataUrl
 * @returns {Promise<boolean>}
 */
async function postResult(action, dataUrl) {
  const body = dataUrl === null ? { action } : { action, png: dataUrl };
  try {
    const response = await fetch(withToken(ENDPOINTS.result), {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      notice(`${T.submitFailed}（HTTP ${response.status}）`, 'error');
      return false;
    }
    return true;
  } catch (error) {
    notice(`${T.submitFailed}（${String(error)}）`, 'error');
    return false;
  }
}

/** 关闭窗口（宿主也会在收到结果/心跳超时后收尾；两边的收尾互不依赖）。 */
function closeWindow() {
  stopHeartbeat();
  log('closing', { at: Math.round(performance.now() - LOAD_T0) });
  window.setTimeout(() => {
    try {
      window.close();
    } catch (error) {
      log('window.close failed', { error: String(error) });
    }
  }, 60);
}

/** @param {'escape'|'contextmenu'|'toolbar'|'selection.tooSmall'|'selection.clipped'} reason */
async function cancel(reason) {
  if (state.busy) return;
  state.busy = true;
  await postResult('cancel', null);
  log('cancelled', { reason });
  closeWindow();
}

/** @param {'insert'|'copy'|'save'} action */
async function submit(action) {
  if (state.busy) return;
  const plan = planFor(state.selection);
  if (plan === null || !plan.valid) {
    await cancel(plan !== null && plan.clipped ? 'selection.clipped' : 'selection.tooSmall');
    return;
  }
  state.busy = true;
  toolbarEl.style.display = 'none';
  notice('正在生成图片（含标注）…');
  window.setTimeout(() => {
    if (state.busy) notice('图片较大，仍在生成…');
  }, 2500);
  try {
    const encoded = await encodeSelection(plan);
    if (encoded === null) {
      state.busy = false;
      notice(T.encodeFailed, 'error');
      schedule();
      return;
    }
    const format = formatOf(encoded.mediaType);
    const dataUrl = await blobToDataUrl(encoded.blob);
    log('encoded', {
      action,
      attempt: encoded.attempt.id,
      mediaType: format.mediaType,
      extension: format.extension,
      bytes: encoded.blob.size,
      width: encoded.attempt.width,
      height: encoded.attempt.height,
      deviceRect: plan.deviceRect,
      totalMs: Math.round(performance.now() - LOAD_T0),
    });
    const posted = await postResult(action, dataUrl);
    if (!posted) {
      state.busy = false;
      schedule();
      return;
    }
    log('submitted', { action, mode: format.mediaType, bytes: encoded.blob.size });
    closeWindow();
  } catch (error) {
    state.busy = false;
    notice(`${T.encodeFailed}（${String(error)}）`, 'error');
    schedule();
  }
}

// ─── 启动 ───────────────────────────────────────────────────────────────────
/**
 * 取冻结帧并 1:1 画上去。
 * 计时（页面内证据）：`frameMs` = fetch+解码完成；`readyMs` = 底图已画、可开始框选。
 */
async function boot() {
  try {
    const response = await fetch(withToken(ENDPOINTS.frame), { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob === undefined || blob.size === 0) throw new Error('frame.empty');
    const frameMs = performance.now() - LOAD_T0;
    if (typeof createImageBitmap === 'function') {
      state.frame = await createImageBitmap(blob);
    } else {
      state.frame = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('frame.decode.failed'));
        image.src = URL.createObjectURL(blob);
      });
    }
    const view = viewportSize();
    const decodeMs = performance.now() - LOAD_T0;
    // 位图尺寸 = 冻结帧像素；CSS 尺寸 = 视口 —— 1:1 映射的两端。
    for (const canvas of [baseCanvas, inkCanvas]) {
      canvas.width = state.frame.width;
      canvas.height = state.frame.height;
      canvas.style.width = `${view.width}px`;
      canvas.style.height = `${view.height}px`;
    }
    const ctx = baseCanvas.getContext('2d');
    const sx = state.frame.width / view.width;
    const sy = state.frame.height / view.height;
    // 冻结帧层用**恒等变换**：画布位图尺寸就等于冻结帧像素，位图与画布是同一个空间，
    // 再由 CSS 尺寸把它铺到视口上（kiosk 满屏 + 100% 缩放时视口 CSS 宽 = 帧像素宽，
    // 于是"屏幕像素 : 画布像素 : 帧像素"三者 1:1）。
    // 注意：这里**不能**套用 ink 层的 CSS→设备变换（sx/sy）—— 那会把帧再缩放一次，
    // 视口与帧不等宽时就会裁成左上角放大图（t64 真浏览器探测抓到的 latent 耦合）。
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    ctx.drawImage(state.frame, 0, 0);

    state.capture = normalizeCapture({
      widthPx: state.frame.width,
      heightPx: state.frame.height,
      url: withToken(ENDPOINTS.frame),
      mediaType: 'image/png',
      bounds: { x: 0, y: 0, width: state.frame.width, height: state.frame.height },
      viewportCss: { x: 0, y: 0, width: view.width, height: view.height },
      scale: sx,
    });
    state.calibration = calibrateCapture(state.capture, { overlay: view, dpr: window.devicePixelRatio });
    state.ready = true;
    buildToolbar();
    refreshToolbar();
    startHeartbeat();
    paintChrome();
    paintInk();
    const readyMs = performance.now() - LOAD_T0;
    if (Math.abs(sx - sy) > 0.001) {
      log('viewport is not the full screen; mapping follows the bitmap', { scaleX: sx, scaleY: sy, view });
    }
    log('ready', {
      readyMs: Math.round(readyMs),
      frameMs: Math.round(frameMs),
      decodeMs: Math.round(decodeMs),
      bitmap: { width: state.frame.width, height: state.frame.height },
      viewport: view,
      devicePixelRatio: window.devicePixelRatio,
      scaleX: sx,
      scaleY: sy,
      oneToOne: Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001,
      minSelectionEdge: MIN_SELECTION_EDGE,
    });
    // 页面内证据（供宿主/验收读取；不影响交互）。
    window.__overlay = {
      ready: true,
      timing: { loadMs: Math.round(LOAD_T0), frameMs: Math.round(frameMs), decodeMs: Math.round(decodeMs), readyMs: Math.round(readyMs) },
      mapping: { bitmap: { width: state.frame.width, height: state.frame.height }, viewport: view, dpr: window.devicePixelRatio, scaleX: sx, scaleY: sy },
      state,
      endpoints: ENDPOINTS,
    };
    // 启动看门狗（index.html 里的内联脚本）据此判断：只有这里写了 'ready' 才不报警。
    window.__overlayState = 'ready';
  } catch (error) {
    notice(`${T.captureFailed}（${String(error)}）`, 'error');
    log('boot failed', { error: String(error) });
    window.__overlayState = 'failed: ' + String(error);
  }
}

/**
 * 视口尺寸变化（kiosk 一般不会）：按新的视口重铺两块画布的 CSS 尺寸并重画底图，
 * 位图尺寸与冻结帧保持一致（1:1 映射的两端都不缩放冻结帧本身）。
 */
function layout() {
  if (state.frame === null) return;
  const view = viewportSize();
  for (const canvas of [baseCanvas, inkCanvas]) {
    canvas.style.width = `${view.width}px`;
    canvas.style.height = `${view.height}px`;
  }
  const ctx = baseCanvas.getContext('2d');
  const sx = state.frame.width / view.width;
  const sy = state.frame.height / view.height;
  // 与 boot() 同一条规则：冻结帧层恒等变换（理由见 boot 的注释）。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
  ctx.drawImage(state.frame, 0, 0);
  if (state.selection !== null) state.selection = clampRectToFrame(state.selection, view.width, view.height);
  schedule();
}

document.addEventListener('keydown', onKeyDown, true);
document.addEventListener('pointerdown', onPointerDown, true);
document.addEventListener('dblclick', onDoubleClick, true);
document.addEventListener('pointermove', onPointerMove, true);
document.addEventListener('pointerup', onPointerUp, true);
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  void cancel('contextmenu');
});
window.addEventListener('resize', layout);

// 提示行：默认是「拖动鼠标框选…」；普通模式下先说清"这张图里有 DSH"，再给框选提示
// （t67 右键菜单选了普通模式 —— 用户必须一眼知道画面为什么带着 DSH 窗口）。
notice(captureMode === 'normal' ? T.normalModeNotice : T.hint);
void boot();
