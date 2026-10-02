/**
 * ONNX OCR 模型清单与按需下载（t77，接法 A）。
 *
 * 依据：RapidOCR 官方注册表（`rapidocr` 包内 `default_models.yaml`，v3.9.2）里的
 * **ModelScope 直链 + SHA256**。这里只固化"下载什么、校验什么"，不做任何安装动作 ——
 * 模型落到用户自己的数据目录（默认 `~/.dsh/dsh-screenshot-ocr/`），删掉即可回到 Windows 引擎。
 *
 * 为什么不用 HuggingFace 做默认源：实测本机 HF 直连超时、镜像可用；ModelScope 是官方原始来源，
 * 国内可直连，所以默认走它，另外留 `ocrModelSource` 给需要自建镜像的人。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认模型源（ModelScope 上的 RapidOCR 仓库，与官方注册表同一份文件）。 */
export const DEFAULT_MODEL_SOURCE = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2';
/** 每个档位的两个模型（检测 + 识别）。SHA256 取自官方注册表。 */
export const OCR_MODEL_TIERS = Object.freeze({
  tiny: Object.freeze({
    det: Object.freeze({
      file: 'PP-OCRv6_det_tiny.onnx',
      path: 'onnx/PP-OCRv6/det/PP-OCRv6_det_tiny.onnx',
      sha256: 'f42c0fbd294d95eac1a550e131b277dac97462c8025fa4b6c3cec1b7894bd3d5',
    }),
    rec: Object.freeze({
      file: 'PP-OCRv6_rec_tiny.onnx',
      path: 'onnx/PP-OCRv6/rec/PP-OCRv6_rec_tiny.onnx',
      sha256: 'e16e242de5937ad92609223f19bc2aff3727ee40b095f996907c24749bad251b',
    }),
  }),
  small: Object.freeze({
    det: Object.freeze({
      file: 'PP-OCRv6_det_small.onnx',
      path: 'onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx',
      sha256: '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f',
    }),
    rec: Object.freeze({
      file: 'PP-OCRv6_rec_small.onnx',
      path: 'onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx',
      sha256: '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
    }),
  }),
  medium: Object.freeze({
    det: Object.freeze({
      file: 'PP-OCRv6_det_medium.onnx',
      path: 'onnx/PP-OCRv6/det/PP-OCRv6_det_medium.onnx',
      sha256: '92078b7355007ccfffcd4c8cd441a3afd4538904d06881b29a155e1e679907c2',
    }),
    rec: Object.freeze({
      file: 'PP-OCRv6_rec_medium.onnx',
      path: 'onnx/PP-OCRv6/rec/PP-OCRv6_rec_medium.onnx',
      sha256: 'eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b',
    }),
  }),
});
/** 默认档位：识别质量与体积的折中（det 9.9MB + rec 21.2MB）。 */
export const DEFAULT_MODEL_TIER = 'small';

/**
 * 默认模型目录：**用户数据目录**（不是临时目录）—— 下载一次长期复用。
 * @returns {string}
 */
export function defaultModelDir() {
  return join(homedir(), '.dsh', 'dsh-screenshot-ocr');
}

/**
 * 规范化档位名（脏值回落默认档）。
 * @param {unknown} value @returns {'tiny'|'small'|'medium'}
 */
export function normalizeModelTier(value) {
  return typeof value === 'string' && Object.hasOwn(OCR_MODEL_TIERS, value) ? value : DEFAULT_MODEL_TIER;
}

/**
 * 该档位的两个模型定义。
 * @param {unknown} tier @returns {{det: object, rec: object}}
 */
export function modelsForTier(tier) {
  return OCR_MODEL_TIERS[normalizeModelTier(tier)];
}

/**
 * 计算一个文件的 sha256（十六进制小写）。
 * @param {string} path @returns {string}
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 看本地模型是否齐备且哈希正确。
 *
 * 只对**存在**的文件做哈希校验（缺文件直接报缺），所以"没下过"是零成本的。
 * @param {string} dir @param {unknown} tier
 * @returns {{ready: boolean, missing: string[], corrupt: string[], det: string, rec: string}}
 */
export function inspectModels(dir, tier) {
  const models = modelsForTier(tier);
  const missing = [];
  const corrupt = [];
  for (const kind of ['det', 'rec']) {
    const path = join(dir, models[kind].file);
    if (!existsSync(path)) {
      missing.push(models[kind].file);
      continue;
    }
    try {
      if (statSync(path).size === 0) corrupt.push(models[kind].file);
      else if (sha256File(path).toLowerCase() !== models[kind].sha256) corrupt.push(models[kind].file);
    } catch {
      corrupt.push(models[kind].file);
    }
  }
  return {
    ready: missing.length === 0 && corrupt.length === 0,
    missing,
    corrupt,
    det: join(dir, models.det.file),
    rec: join(dir, models.rec.file),
  };
}

/**
 * 下载并校验一个模型文件（先写 `.part` 再原子改名，校验失败即删除）。
 * @param {{dir: string, kind: 'det'|'rec', tier: unknown, source?: string, fetchImpl?: Function, log?: Function}} input
 * @returns {Promise<{ok: boolean, file: string, path: string, bytes: number, error?: string}>}
 */
export async function downloadModel(input) {
  const { dir, kind } = input;
  const models = modelsForTier(input.tier);
  const model = models[kind];
  const source = (input.source ?? DEFAULT_MODEL_SOURCE).replace(/\/+$/, '');
  const url = `${source}/${model.path}`;
  const target = join(dir, model.file);
  const temporary = `${target}.part`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const log = input.log ?? (() => {});
  if (typeof fetchImpl !== 'function') return { ok: false, file: model.file, path: target, bytes: 0, error: 'fetch is unavailable' };
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, file: model.file, path: target, bytes: 0, error: `model dir is not writable: ${String(error)}` };
  }
  try {
    log(`downloading ${model.file} from ${url}`);
    const response = await fetchImpl(url);
    if (response === null || response === undefined || response.ok !== true) {
      return { ok: false, file: model.file, path: target, bytes: 0, error: `HTTP ${response?.status ?? 'error'}` };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(temporary, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== model.sha256) {
      rmSync(temporary, { force: true });
      return { ok: false, file: model.file, path: target, bytes: bytes.length, error: `sha256 mismatch: got ${digest.slice(0, 16)}…, want ${model.sha256.slice(0, 16)}…` };
    }
    renameSync(temporary, target);
    return { ok: true, file: model.file, path: target, bytes: bytes.length };
  } catch (error) {
    rmSync(temporary, { force: true });
    return { ok: false, file: model.file, path: target, bytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 确保该档位的模型齐备：缺哪个下哪个，坏的重下。
 * @param {{dir: string, tier: unknown, source?: string, fetchImpl?: Function, log?: Function}} input
 * @returns {Promise<{ready: boolean, downloaded: string[], failed: Array<{file: string, error: string}>, paths: {det: string, rec: string}}>}
 */
export async function ensureModels(input) {
  const dir = input.dir ?? defaultModelDir();
  const state = inspectModels(dir, input.tier);
  const downloaded = [];
  const failed = [];
  if (state.missing.length === 0 && state.corrupt.length === 0) {
    return { ready: true, downloaded, failed, paths: { det: state.det, rec: state.rec } };
  }
  for (const kind of ['det', 'rec']) {
    const model = modelsForTier(input.tier)[kind];
    if (!state.missing.includes(model.file) && !state.corrupt.includes(model.file)) continue;
    const result = await downloadModel({ ...input, dir, kind });
    if (result.ok) downloaded.push(model.file);
    else failed.push({ file: model.file, error: result.error ?? 'unknown' });
  }
  const after = inspectModels(dir, input.tier);
  return { ready: after.ready, downloaded, failed, paths: { det: after.det, rec: after.rec } };
}
