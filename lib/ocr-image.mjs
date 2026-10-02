/**
 * 图像前置处理（t77，接法 A）：把宿主收到的 **PNG 直接解成像素**，再缩放/归一化成 ONNX 张量。
 *
 * 为什么自己解 PNG：面板交回来的是 `canvas.toBlob('image/png')` 的字节，而 ONNX Runtime 只吃
 * 数值张量。引第三方解码器（sharp/pngjs）会给"发给别人用"的插件再加一个原生依赖或纯 JS 大包，
 * 这里只需要 Node 自带的 `zlib` —— 浏览器输出的 PNG 都是 8bit、非隔行，5 种行过滤器实现完就够。
 *
 * 本模块**纯逻辑**：不读文件、不联网、不碰 ONNX Runtime，单测可以直接喂合成 PNG。
 */

import { inflateSync } from 'node:zlib';

/** PNG 签名（\x89PNG\r\n\x1a\n）。 */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 每个像素通道数（按 PNG colorType）。 */
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

/**
 * 解码一张 8bit 非隔行 PNG。
 * @param {Buffer|Uint8Array} buffer - PNG 字节。
 * @returns {{width: number, height: number, rgba: Uint8Array}} 像素（RGBA，行优先）。
 * @throws {Error} 编码不受支持时抛出（调用方按 `ocr.failed` 上报）。
 */
export function decodePng(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataAt = offset + 8;
    if (type === 'IHDR') {
      width = readUint32(bytes, dataAt);
      height = readUint32(bytes, dataAt + 4);
      depth = bytes[dataAt + 8];
      colorType = bytes[dataAt + 9];
      interlace = bytes[dataAt + 12];
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataAt, dataAt + length);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataAt, dataAt + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataAt + length + 4;
  }
  if (width <= 0 || height <= 0) throw new Error('PNG has no IHDR');
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  unfilter(raw, pixels, width, height, channels, stride);
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (colorType === 6) {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source + 1];
      rgba[target + 2] = pixels[source + 2];
      rgba[target + 3] = pixels[source + 3];
    } else if (colorType === 2) {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source + 1];
      rgba[target + 2] = pixels[source + 2];
      rgba[target + 3] = 255;
    } else if (colorType === 0) {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source];
      rgba[target + 2] = pixels[source];
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source];
      rgba[target + 2] = pixels[source];
      rgba[target + 3] = pixels[source + 1];
    } else {
      const at = pixels[source] * 3;
      rgba[target] = palette === null ? 0 : palette[at];
      rgba[target + 1] = palette === null ? 0 : palette[at + 1];
      rgba[target + 2] = palette === null ? 0 : palette[at + 2];
      rgba[target + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/**
 * 逐行反过滤（PNG 规范 9.2 的 5 种过滤器）。
 * @param {Uint8Array} raw @param {Uint8Array} out @param {number} width @param {number} height @param {number} channels @param {number} stride
 * @returns {void}
 */
function unfilter(raw, out, width, height, channels, stride) {
  let previous = new Uint8Array(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const sourceAt = row * (stride + 1) + 1;
    const line = out.subarray(row * stride, row * stride + stride);
    line.set(raw.subarray(sourceAt, sourceAt + stride));
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      if (filter === 1) line[index] = (line[index] + left) & 0xff;
      else if (filter === 2) line[index] = (line[index] + up) & 0xff;
      else if (filter === 3) line[index] = (line[index] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) line[index] = (line[index] + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    }
    previous = line;
  }
}

/** @param {number} a @param {number} b @param {number} c @returns {number} PNG Paeth 预测值。 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** @param {Uint8Array} bytes @param {number} at @returns {number} 大端 uint32。 */
function readUint32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/**
 * 双线性缩放 RGBA。
 * @param {{width: number, height: number, rgba: Uint8Array}} image @param {number} width @param {number} height
 * @returns {{width: number, height: number, rgba: Uint8Array}}
 */
export function resizeRgba(image, width, height) {
  const target = new Uint8Array(width * height * 4);
  if (image.width === width && image.height === height) {
    target.set(image.rgba);
    return { width, height, rgba: target };
  }
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const wy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const wx = sourceX - x0;
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const p00 = image.rgba[(y0 * image.width + x0) * 4 + channel];
        const p10 = image.rgba[(y0 * image.width + x1) * 4 + channel];
        const p01 = image.rgba[(y1 * image.width + x0) * 4 + channel];
        const p11 = image.rgba[(y1 * image.width + x1) * 4 + channel];
        const top = p00 + (p10 - p00) * wx;
        const bottom = p01 + (p11 - p01) * wx;
        target[at + channel] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return { width, height, rgba: target };
}

/**
 * 抠出一块矩形（坐标是像素、会被夹进图内）。
 * @param {{width: number, height: number, rgba: Uint8Array}} image @param {{x: number, y: number, width: number, height: number}} box
 * @returns {{width: number, height: number, rgba: Uint8Array}}
 */
export function cropRgba(image, box) {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(box.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(box.y)));
  const width = Math.max(1, Math.min(image.width - x, Math.round(box.width)));
  const height = Math.max(1, Math.min(image.height - y, Math.round(box.height)));
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 4;
    rgba.set(image.rgba.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, rgba };
}

/** 检测模型用的 ImageNet 归一化（PP-OCR det 的标准口径）。 */
export const DET_NORMALIZATION = Object.freeze({
  mean: Object.freeze([0.485, 0.456, 0.406]),
  std: Object.freeze([0.229, 0.224, 0.225]),
});
/** 识别模型用的 0.5/0.5 归一化（PP-OCR rec 的标准口径）。 */
export const REC_NORMALIZATION = Object.freeze({
  mean: Object.freeze([0.5, 0.5, 0.5]),
  std: Object.freeze([0.5, 0.5, 0.5]),
});

/**
 * RGBA → NCHW float32 张量（RGB 通道，按给定均值/方差归一化）。
 * @param {{width: number, height: number, rgba: Uint8Array}} image
 * @param {{mean: readonly number[], std: readonly number[]}} normalization
 * @returns {{data: Float32Array, dims: number[]}} 张量数据与形状 `[1, 3, H, W]`。
 */
export function toNchwTensor(image, normalization) {
  const { width, height, rgba } = image;
  const data = new Float32Array(3 * width * height);
  const plane = width * height;
  for (let index = 0; index < plane; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = rgba[index * 4 + channel] / 255;
      data[channel * plane + index] = (value - normalization.mean[channel]) / normalization.std[channel];
    }
  }
  return { data, dims: [1, 3, height, width] };
}

/**
 * 检测输入尺寸：长边不超过 `limit`，两边都取 32 的倍数（DB 网络的下采样要求），
 * 并保证不小于 32。
 * @param {number} width @param {number} height @param {number} limit
 * @returns {{width: number, height: number, scale: number}} 送入网络的尺寸与缩放比。
 */
export function detInputSize(width, height, limit) {
  const longest = Math.max(width, height);
  const scale = longest > limit ? limit / longest : 1;
  // **向上**取到 32 的倍数：小图绝不被缩小（缩小会直接损失小字），大图最多比上限多 31px。
  const round32 = (value) => Math.max(32, Math.ceil(value / 32) * 32);
  const targetWidth = round32(width * scale);
  const targetHeight = round32(height * scale);
  return { width: targetWidth, height: targetHeight, scale: Math.max(targetWidth / width, targetHeight / height) };
}

/**
 * 识别输入尺寸：固定高 `height`，宽按长宽比换算并夹在 `[minWidth, maxWidth]`，取 8 的倍数。
 * @param {number} width @param {number} height @param {number} targetHeight @param {number} [maxWidth]
 * @returns {{width: number, height: number}}
 */
export function recInputSize(width, height, targetHeight, maxWidth = 1280) {
  const ratio = width / Math.max(1, height);
  const raw = Math.ceil(targetHeight * ratio) + 2;
  const clamped = Math.max(targetHeight, Math.min(maxWidth, raw));
  const rounded = Math.max(8, Math.round(clamped / 8) * 8);
  return { width: rounded, height: targetHeight };
}
