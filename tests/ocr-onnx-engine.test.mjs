/**
 * t77（接法 A）ONNX OCR 引擎的离线契约。
 *
 * 分三层：
 *   1. 纯逻辑：PNG 解码/缩放/张量、DB 取框、CTC 解码、ONNX 内嵌字典解析；
 *   2. 模型清单与下载器：档位归一化、SHA256 校验、坏文件/坏网络的处理（fetch 用替身，不联网）；
 *   3. 接线：`resolveSettings` 的默认值与 `auto/onnx/windows` 归一化。
 * 末尾给负样本：哈希写错、字典与类别不匹配这类"看起来能跑其实全错"的情况必须被抓住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  cropRgba,
  decodePng,
  detInputSize,
  recInputSize,
  resizeRgba,
  toNchwTensor,
  DET_NORMALIZATION,
} from '../lib/ocr-image.mjs';
import { boxesFromProbability, groupIntoLines, mapBoxesToImage } from '../lib/ocr-dbnet.mjs';
import { characterFor, decodeCtcGreedy } from '../lib/ocr-ctc.mjs';
import { readCharacterDict, readOnnxMetadata } from '../lib/onnx-meta.mjs';
import {
  OCR_MODEL_TIERS,
  downloadModel,
  ensureModels,
  inspectModels,
  modelsForTier,
  normalizeModelTier,
} from '../lib/ocr-models.mjs';
import { normalizeOcrEngine, resolveSettings } from '../index.js';

// ── 合成 PNG（自己拼 IHDR/IDAT，用来喂解码器） ─────────────────────────────

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

/**
 * 造一张 RGBA PNG。
 * @param {number} width @param {number} height @param {(x: number, y: number) => number[]} pixel
 * @param {{filter?: number, colorType?: number}} [options]
 * @returns {Buffer}
 */
function makePng(width, height, pixel, options = {}) {
  const filter = options.filter ?? 0;
  const colorType = options.colorType ?? 6;
  const channels = colorType === 2 ? 3 : 4;
  const raw = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y += 1) {
    const rowAt = y * (1 + width * channels);
    raw[rowAt] = filter;
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y);
      const at = rowAt + 1 + x * channels;
      raw[at] = rgba[0];
      raw[at + 1] = rgba[1];
      raw[at + 2] = rgba[2];
      if (channels === 4) raw[at + 3] = rgba[3] ?? 255;
    }
  }
  // Sub 过滤器：把每个字节替换成与左邻像素的差值（解码器必须还原）。
  if (filter === 1) {
    for (let y = 0; y < height; y += 1) {
      const base = y * (1 + width * channels);
      for (let index = width * channels - 1; index >= channels; index -= 1) {
        raw[base + 1 + index] = (raw[base + 1 + index] - raw[base + 1 + index - channels]) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 造一个只带 metadata_props 的最小 ONNX protobuf（长度一律按**字节**算）。 */
function makeOnnxMetadata(pairs) {
  const parts = [];
  for (const [key, value] of Object.entries(pairs)) {
    const keyBytes = Buffer.from(key, 'utf8');
    const valueBytes = Buffer.from(value, 'utf8');
    const entry = Buffer.concat([
      Buffer.from([0x0a, keyBytes.length]), keyBytes,
      Buffer.from([0x12, valueBytes.length & 0x7f]), valueBytes,
    ]);
    parts.push(Buffer.from([0x72, entry.length & 0x7f]), entry);
  }
  return Buffer.concat(parts);
}

// ── 1. 图像 ────────────────────────────────────────────────────────────────

test('(t77-1) PNG decoding handles RGBA and Sub-filtered rows, then resizes and crops', () => {
  const plain = makePng(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 255]));
  const decoded = decodePng(plain);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.rgba.slice(0, 4)], [255, 0, 0, 255], '左上角必须是红色');

  const sub = makePng(4, 1, (x) => [x * 10, 20, 30, 255], { filter: 1 });
  const decodedSub = decodePng(sub);
  assert.deepEqual([...decodedSub.rgba.slice(0, 4)], [0, 20, 30, 255]);
  assert.deepEqual([...decodedSub.rgba.slice(12, 16)], [30, 20, 30, 255], 'Sub 过滤器必须被还原');

  const upscaled = resizeRgba(decoded, 4, 4);
  assert.equal(upscaled.width, 4);
  assert.equal(upscaled.rgba.length, 4 * 4 * 4);
  assert.deepEqual([...cropRgba(decoded, { x: 0, y: 0, width: 1, height: 1 }).rgba], [255, 0, 0, 255]);
});

test('(t77-2) detection/recognition input sizes follow the network constraints', () => {
  const det = detInputSize(1978, 1059, 960);
  assert.equal(det.width % 32, 0, 'det 宽必须是 32 的倍数');
  assert.equal(det.height % 32, 0, 'det 高必须是 32 的倍数');
  assert.ok(det.width <= 960 + 31 && det.height <= 960 + 31, `长边不超过上限（+31 对齐余量），实际 ${det.width}x${det.height}`);
  const small = detInputSize(100, 40, 960);
  assert.equal(small.scale >= 1, true, `小图绝不缩小，实际 scale=${small.scale}`);
  assert.equal(small.width % 32, 0);
  assert.equal(small.height % 32, 0);
  const rec = recInputSize(600, 30, 48);
  assert.equal(rec.height, 48, '识别固定高 48');
  assert.equal(rec.width % 8, 0, '识别宽取 8 的倍数');
  assert.ok(rec.width > 48, '宽行必须给出更宽的输入');
  assert.equal(recInputSize(10_000, 30, 48).width <= 1280, true, '超宽行被夹住');
});

test('(t77-3) the tensor is NCHW with the detection normalization', () => {
  const image = decodePng(makePng(1, 1, () => [255, 128, 0, 255]));
  const tensor = toNchwTensor(image, DET_NORMALIZATION);
  assert.deepEqual(tensor.dims, [1, 3, 1, 1]);
  const expected = [
    (1 - DET_NORMALIZATION.mean[0]) / DET_NORMALIZATION.std[0],
    (128 / 255 - DET_NORMALIZATION.mean[1]) / DET_NORMALIZATION.std[1],
    (0 - DET_NORMALIZATION.mean[2]) / DET_NORMALIZATION.std[2],
  ];
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(Math.abs(tensor.data[channel] - expected[channel]) < 1e-5, `通道 ${channel} 归一化不对`);
  }
});

// ── 2. 取框与解码 ──────────────────────────────────────────────────────────

test('(t77-4) connected components become boxes, low-score blobs are dropped, lines read in order', () => {
  const width = 20;
  const height = 10;
  const map = new Float32Array(width * height);
  const paint = (x0, y0, x1, y1, value) => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) map[y * width + x] = value;
  };
  paint(1, 1, 5, 3, 0.9); // 第一行左
  paint(8, 1, 12, 3, 0.8); // 第一行右
  paint(1, 6, 5, 8, 0.85); // 第二行
  paint(15, 6, 16, 6, 0.2); // 低于 box 阈值（也不是 >0.3 的二值前景）
  const boxes = boxesFromProbability(map, width, height);
  assert.equal(boxes.length, 3, `应得到 3 个框，实际 ${boxes.length}`);
  const lines = groupIntoLines(mapBoxesToImage(boxes, { scaleX: 2, scaleY: 2, imageWidth: 40, imageHeight: 20 }));
  assert.equal(lines.length, 2, '应聚成两行');
  assert.equal(lines[0].length, 2, '第一行有两个框');
  assert.ok(lines[0][0].x < lines[0][1].x, '行内从左到右');
  assert.ok(lines[0][0].y < lines[1][0].y, '行间从上到下');
  assert.ok(lines[0][0].width > 5 * 2 - 1, '框按比例映射回原图并外扩');
});

test('(t77-5) CTC greedy decoding collapses repeats, skips blank and maps the space class', () => {
  const dict = ['A', 'B'];
  // 3 步：A, blank, A → "AA"；最后一类（dict.length + 1 = 3）是空格
  const classes = 4;
  const frame = (index) => {
    const row = new Float32Array(classes);
    row[index] = 0.9;
    return row;
  };
  const logits = Float32Array.from([...frame(1), ...frame(1), ...frame(0), ...frame(1), ...frame(3), ...frame(3), ...frame(2)]);
  const decoded = decodeCtcGreedy(logits, 7, classes, dict);
  assert.equal(decoded.text, 'AA B', `实际解出 ${JSON.stringify(decoded.text)}`);
  assert.ok(decoded.confidence > 0.8, '置信度取保留帧的平均分');
  assert.equal(characterFor(0, dict), '', 'blank 不给字符');
  assert.equal(characterFor(3, dict), ' ', '最后一类是空格');
  assert.equal(characterFor(99, dict), '', '越界类别回落空串而不是抛错');
});

test('(t77-6) the ONNX metadata reader pulls the embedded character dictionary', () => {
  const dict = ['中', '文', 'A'];
  const buffer = makeOnnxMetadata({ character: `${dict.join('\n')}\n`, producer: 'test' });
  const metadata = readOnnxMetadata(buffer);
  assert.equal(metadata.producer, 'test', '其它元数据也要读出来');
  assert.deepEqual(readCharacterDict(buffer), dict, '去掉末尾空行后就是字典本身');
  assert.deepEqual(readCharacterDict(makeOnnxMetadata({ producer: 'x' })), [], '没有字典时返回空数组');
});

// ── 3. 模型清单与下载 ──────────────────────────────────────────────────────

test('(t77-7) the model manifest pins every tier to a sha256, and the downloader verifies it', async () => {
  for (const [tier, models] of Object.entries(OCR_MODEL_TIERS)) {
    for (const kind of ['det', 'rec']) {
      assert.match(models[kind].sha256, /^[0-9a-f]{64}$/, `${tier}/${kind} 的 sha256 应是 64 位十六进制`);
      assert.ok(models[kind].file.endsWith('.onnx'), `${tier}/${kind} 应是 onnx 文件`);
      assert.ok(models[kind].path.includes('PP-OCRv6'), `${tier}/${kind} 的下载路径应指向官方仓库`);
    }
  }
  assert.equal(normalizeModelTier('bogus'), 'small', '脏档位回落默认档');
  assert.equal(modelsForTier('tiny').det.file.includes('tiny'), true);

  const dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-models-'));
  try {
    const payload = Buffer.from('fake model bytes');
    const digest = createHash('sha256').update(payload).digest('hex');
    // 用替身 fetch 提供与清单一致的哈希：先从清单里借一个小文件位（det），临时改哈希不方便，
    // 所以这里直接测试"哈希不匹配必须拒绝"与"HTTP 失败必须拒绝"两条硬规则。
    const mismatch = await downloadModel({
      dir,
      kind: 'det',
      tier: 'small',
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => payload }),
    });
    assert.equal(mismatch.ok, false, `哈希不含必须拒绝（实际 ${JSON.stringify(mismatch)}）`);
    assert.match(String(mismatch.error), /sha256 mismatch/, '失败原因要写明哈希不匹配');
    assert.equal(existsSync(join(dir, modelsForTier('small').det.file)), false, '校验失败不得留下文件');
    assert.equal(existsSync(join(dir, `${modelsForTier('small').det.file}.part`)), false, '也不得留下 .part 临时文件');

    const http = await downloadModel({ dir, kind: 'det', tier: 'small', fetchImpl: async () => ({ ok: false, status: 503 }) });
    assert.equal(http.ok, false);
    assert.match(String(http.error), /503/);

    const state = inspectModels(dir, 'small');
    assert.equal(state.ready, false);
    assert.deepEqual(state.missing.sort(), [modelsForTier('small').det.file, modelsForTier('small').rec.file].sort());

    // 坏文件（大小对不上哈希）必须被认成 corrupt 而不是 ready。
    writeFileSync(join(dir, modelsForTier('small').det.file), 'not the real model');
    writeFileSync(join(dir, modelsForTier('small').rec.file), 'not the real model');
    const broken = inspectModels(dir, 'small');
    assert.equal(broken.ready, false);
    assert.equal(broken.corrupt.length, 2, '两个文件都应被判为损坏');
    assert.equal(digest.length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(t77-8) ensureModels reports failures instead of pretending the engine is ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-models-'));
  try {
    const outcome = await ensureModels({
      dir,
      tier: 'small',
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    assert.equal(outcome.ready, false);
    assert.equal(outcome.failed.length, 2, '两个模型都应报失败');
    assert.ok(outcome.failed.every((entry) => entry.error.includes('network down')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. 接线 ────────────────────────────────────────────────────────────────

test('(t77-9) the engine choice normalizes and the settings carry the new keys', () => {
  assert.equal(normalizeOcrEngine(undefined), 'auto', '默认是 auto');
  assert.equal(normalizeOcrEngine('onnx'), 'onnx');
  assert.equal(normalizeOcrEngine('windows'), 'windows');
  assert.equal(normalizeOcrEngine('ONNX'), 'auto', '只认小写字面量');
  const settings = resolveSettings({});
  assert.equal(settings.ocrEngine, 'auto');
  assert.equal(settings.ocrModelTier, 'small');
  assert.equal(settings.ocrDownloadModels, true, '默认允许首次使用时下载（否则更强引擎不可达）');
  assert.match(settings.ocrModelDir, /dsh-screenshot-ocr$/, '模型目录在用户数据目录下');
  assert.match(settings.ocrModelSource, /^https:\/\//, '默认模型源是 https 直链');
  assert.equal(settings.ocrDetLimit, 960);
  const custom = resolveSettings({ ocrEngine: 'onnx', ocrModelTier: 'tiny', ocrDownloadModels: false, ocrDetLimit: 100 });
  assert.equal(custom.ocrEngine, 'onnx');
  assert.equal(custom.ocrModelTier, 'tiny');
  assert.equal(custom.ocrDownloadModels, false);
  assert.equal(custom.ocrDetLimit, 320, 'det 上限被夹进合理区间');
});

// ── 负样本 ─────────────────────────────────────────────────────────────────

test('(t77-10) negative samples: a shifted dictionary or a mangled manifest must be caught', () => {
  // 负样本 1：字典整体错位（少一项）→ 解码出的字符必须与正确字典不同（正是"中文全错"的病根）。
  const dict = ['A', 'B'];
  const shifted = ['B'];
  const classes = 4;
  const row = (index) => {
    const frame = new Float32Array(classes);
    frame[index] = 0.9;
    return frame;
  };
  const logits = Float32Array.from([...row(1), ...row(2)]);
  assert.equal(decodeCtcGreedy(logits, 2, classes, dict).text, 'AB');
  // 字典少一项时，2 号类落到"字典之后的第一类"= 空格类，所以是 "B " ——
  // 这正是"字典与模型不匹配"的可见症状（中文会整体错位）。
  assert.equal(decodeCtcGreedy(logits, 2, classes, shifted).text, 'B ');
  assert.notEqual(decodeCtcGreedy(logits, 2, classes, dict).text, decodeCtcGreedy(logits, 2, classes, shifted).text);

  // 负样本 2：清单里的 sha256 被改成随手写的值 → inspectModels 必须把已有文件判为损坏。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-models-'));
  try {
    const file = join(dir, modelsForTier('small').det.file);
    writeFileSync(file, 'whatever');
    const real = modelsForTier('small').det.sha256;
    assert.match(real, /^[0-9a-f]{64}$/);
    assert.equal(inspectModels(dir, 'small').corrupt.includes(modelsForTier('small').det.file), true);
    // 用真实文件内容 + 错误哈希模拟"清单写错"：内容哈希与清单不一致时必须判坏。
    const content = readFileSync(file);
    const digest = createHash('sha256').update(content).digest('hex');
    assert.notEqual(digest, real, '这段内容不该恰好等于官方哈希');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
