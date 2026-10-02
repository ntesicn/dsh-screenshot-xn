/**
 * ONNX OCR 引擎（t77，接法 A）：PP-OCRv6（检测 + 识别）跑在 `onnxruntime-node` 上。
 *
 * 为什么换引擎：Windows 自带的 `Windows.Media.Ocr` 对**小字中文截图**识别很差（实机对比里
 * "截取屏幕、框选并标注"被读成"截取驛幂梃选并标注"），而 PP-OCR 系列是为中文文档/界面训练的。
 *
 * 依赖与分发：
 *   - 运行时是 npm 包 `onnxruntime-node`（预编译，免 Python、免 GPU、免管理员）；它的 postinstall
 *     需要下载原生库，所以**在 DSH 里安装/更新本插件时要允许构建脚本**（README 有说明）。
 *   - 模型不随包分发：首次使用时按 `lib/ocr-models.mjs` 的清单下载到用户数据目录并校验 SHA256。
 *   - 任何一步不可用（依赖缺失 / 模型缺失 / 推理失败）都只是**返回不可用**，由调用方回落到
 *     Windows 引擎 —— 这个模块不抛"致命"错误、也不写别的目录。
 *
 * 本模块把纯逻辑拆到 `ocr-image.mjs`（解码/缩放/张量）、`ocr-dbnet.mjs`（取框）、
 * `ocr-ctc.mjs`（解码）、`onnx-meta.mjs`（内嵌字典），这里只负责加载模型与串流程。
 */

import { readFileSync } from 'node:fs';
import {
  cropRgba,
  decodePng,
  detInputSize,
  recInputSize,
  resizeRgba,
  toNchwTensor,
  DET_NORMALIZATION,
  REC_NORMALIZATION,
} from './ocr-image.mjs';
import { boxesFromProbability, groupIntoLines, mapBoxesToImage } from './ocr-dbnet.mjs';
import { decodeCtcGreedy } from './ocr-ctc.mjs';
import { readCharacterDict } from './onnx-meta.mjs';
import { ensureModels, inspectModels, normalizeModelTier } from './ocr-models.mjs';

/** 检测输入长边上限（越大越准、越慢；960 对截图足够）。 */
export const DEFAULT_DET_LIMIT = 960;
/** 识别输入高度（PP-OCRv5/v6 的字典与模型都按 48 训练）。 */
export const DEFAULT_REC_HEIGHT = 48;
/** 单次识别里最多处理多少个文本行（防御性上限，避免异常图把 CPU 占满）。 */
export const DEFAULT_MAX_LINES = 200;
/** 单个文本行框的最大宽度（超长行会被裁，避免张量过大）。 */
export const DEFAULT_MAX_LINE_WIDTH = 1_600;

/** 载入过的会话缓存（按模型路径），避免每次识别都重新读 30MB 模型。 */
const sessionCache = new Map();

/**
 * 动态取 ONNX Runtime；没装（或原生库缺失）时返回 undefined。
 * @returns {Promise<any>}
 */
async function loadRuntime() {
  try {
    const module = await import('onnxruntime-node');
    return module?.default ?? module;
  } catch {
    return undefined;
  }
}

/**
 * 取（或建立）一个推理会话。
 * @param {any} ort @param {string} path @returns {Promise<any>}
 */
async function sessionFor(ort, path) {
  const cached = sessionCache.get(path);
  if (cached !== undefined) return cached;
  const session = await ort.InferenceSession.create(path, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
  sessionCache.set(path, session);
  return session;
}

/**
 * 这个引擎当前能不能用（不下载、不推理，只做本地检查）。
 * @param {{modelDir: string, tier: unknown, download?: boolean, source?: string, fetchImpl?: Function, log?: Function}} input
 * @returns {Promise<{available: boolean, reason?: string, paths?: {det: string, rec: string}, downloaded?: string[]}>}
 */
export async function prepareOnnxEngine(input) {
  const ort = await loadRuntime();
  if (ort === undefined) return { available: false, reason: 'onnxruntime-node is not installed' };
  const tier = normalizeModelTier(input.tier);
  let state = inspectModels(input.modelDir, tier);
  const downloaded = [];
  if (!state.ready && input.download === true) {
    const outcome = await ensureModels({
      dir: input.modelDir,
      tier,
      source: input.source,
      fetchImpl: input.fetchImpl,
      log: input.log,
    });
    downloaded.push(...outcome.downloaded);
    if (!outcome.ready) {
      const reason = outcome.failed.length > 0
        ? `model download failed: ${outcome.failed.map((entry) => `${entry.file} (${entry.error})`).join('; ')}`
        : `models missing: ${state.missing.concat(state.corrupt).join(', ')}`;
      return { available: false, reason, downloaded };
    }
    state = inspectModels(input.modelDir, tier);
  }
  if (!state.ready) {
    const parts = [];
    if (state.missing.length > 0) parts.push(`missing ${state.missing.join(', ')}`);
    if (state.corrupt.length > 0) parts.push(`corrupt ${state.corrupt.join(', ')}`);
    return { available: false, reason: `models are not ready: ${parts.join('; ')}`, downloaded };
  }
  return { available: true, paths: { det: state.det, rec: state.rec }, downloaded };
}

/**
 * 识别一张 PNG 里的文字。
 * @param {{png: Buffer, modelDir: string, tier?: unknown, detLimit?: number, recHeight?: number, maxLines?: number}} input
 * @returns {Promise<{ok: boolean, reason?: string, text?: string, lines?: string[], boxes?: number, width?: number, height?: number, elapsedMs?: number, engine?: string}>}
 */
export async function recognizeWithOnnx(input) {
  const startedAt = Date.now();
  const ort = await loadRuntime();
  if (ort === undefined) return { ok: false, reason: 'onnxruntime-node is not installed' };
  const tier = normalizeModelTier(input.tier);
  const state = inspectModels(input.modelDir, tier);
  if (!state.ready) {
    return { ok: false, reason: `models are not ready: ${state.missing.concat(state.corrupt).join(', ') || 'unknown'}` };
  }
  let image;
  try {
    image = decodePng(input.png);
  } catch (error) {
    return { ok: false, reason: `could not decode the region PNG: ${error instanceof Error ? error.message : String(error)}` };
  }
  // 字典内嵌在识别模型里：读一次即可，同时用它校验类别数（不匹配说明模型被换过）。
  const dict = readCharacterDict(readFileSync(state.rec));
  if (dict.length === 0) return { ok: false, reason: 'the recognition model carries no embedded character dictionary' };

  const det = await sessionFor(ort, state.det);
  const rec = await sessionFor(ort, state.rec);
  const detSize = detInputSize(image.width, image.height, input.detLimit ?? DEFAULT_DET_LIMIT);
  const detImage = resizeRgba(image, detSize.width, detSize.height);
  const detTensor = new ort.Tensor('float32', toNchwTensor(detImage, DET_NORMALIZATION).data, [1, 3, detSize.height, detSize.width]);
  const detOut = await det.run({ x: detTensor });
  const probability = Object.values(detOut)[0];
  const [, , mapHeight, mapWidth] = probability.dims;
  const boxes = mapBoxesToImage(
    boxesFromProbability(probability.data, mapWidth, mapHeight),
    {
      scaleX: image.width / mapWidth,
      scaleY: image.height / mapHeight,
      imageWidth: image.width,
      imageHeight: image.height,
    },
  );
  const lines = groupIntoLines(boxes).slice(0, input.maxLines ?? DEFAULT_MAX_LINES);
  const recHeight = input.recHeight ?? DEFAULT_REC_HEIGHT;
  const texts = [];
  for (const line of lines) {
    const parts = [];
    for (const box of line) {
      const crop = cropRgba(image, { ...box, width: Math.min(box.width, DEFAULT_MAX_LINE_WIDTH) });
      const size = recInputSize(crop.width, crop.height, recHeight);
      const resized = resizeRgba(crop, size.width, size.height);
      const tensor = new ort.Tensor('float32', toNchwTensor(resized, REC_NORMALIZATION).data, [1, 3, size.height, size.width]);
      const out = await rec.run({ x: tensor });
      const target = Object.values(out)[0];
      const [, steps, classes] = target.dims;
      if (classes !== dict.length + 2) {
        return { ok: false, reason: `model/dictionary mismatch: ${classes} classes vs ${dict.length} entries` };
      }
      parts.push(decodeCtcGreedy(target.data, steps, classes, dict).text);
    }
    const text = parts.join('');
    if (text.trim() !== '') texts.push(text);
  }
  return {
    ok: true,
    engine: `ppocr-v6-${tier}`,
    text: texts.join('\n'),
    lines: texts,
    boxes: boxes.length,
    width: image.width,
    height: image.height,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 释放会话缓存（插件卸载时调用；不释放也不会泄漏到别的进程）。
 * @returns {void}
 */
export function disposeOnnxSessions() {
  sessionCache.clear();
}
