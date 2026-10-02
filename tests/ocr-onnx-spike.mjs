/**
 * 一次性验证脚本（不属于插件）：用 PP-OCRv6 的 ONNX 模型跑通 det → 取框 → rec → 文本。
 * 目的是确认归一化/尺寸口径正确，并把识别结果与 Windows 引擎对比。
 *
 * 用法：node tests/ocr-onnx-spike.mjs <png> [modelDir]
 */
import { readFileSync } from 'node:fs';
import ort from 'onnxruntime-node';
import {
  decodePng,
  resizeRgba,
  cropRgba,
  toNchwTensor,
  detInputSize,
  recInputSize,
  DET_NORMALIZATION,
  REC_NORMALIZATION,
} from '../lib/ocr-image.mjs';
import { readCharacterDict } from '../lib/onnx-meta.mjs';

const imagePath = process.argv[2];
const modelDir = process.argv[3] ?? `${process.env.TEMP}\\ocr-models-v6`;
const DET_LIMIT = 960;
const REC_HEIGHT = 48;
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;

const started = Date.now();
const png = readFileSync(imagePath);
const image = decodePng(png);
console.log(`image ${image.width}x${image.height}, ${png.length} bytes`);

const det = await ort.InferenceSession.create(`${modelDir}\\det_small.onnx`, { executionProviders: ['cpu'] });
const rec = await ort.InferenceSession.create(`${modelDir}\\rec_small.onnx`, { executionProviders: ['cpu'] });

// ── det ────────────────────────────────────────────────────────────────────
const detSize = detInputSize(image.width, image.height, DET_LIMIT);
const detImage = resizeRgba(image, detSize.width, detSize.height);
const detTensor = new ort.Tensor('float32', toNchwTensor(detImage, DET_NORMALIZATION).data, [1, 3, detSize.height, detSize.width]);
const detOut = await det.run({ x: detTensor });
const map = detOut[detOut.outputNames?.[0] ?? 'fetch_name_0'] ?? Object.values(detOut)[0];
const [, , mapH, mapW] = map.dims;
const prob = map.data;
let above = 0;
let max = 0;
let sum = 0;
for (let index = 0; index < prob.length; index += 1) {
  if (prob[index] > DET_THRESH) above += 1;
  if (prob[index] > max) max = prob[index];
  sum += prob[index];
}
console.log(`det out ${mapW}x${mapH}, max=${max.toFixed(3)} mean=${(sum / prob.length).toFixed(4)} above(${DET_THRESH})=${above}`);

// ── 取框：阈值 + 连通域 + 外接矩形（轴对齐，够用；不做旋转框） ──────────────
const scaleX = image.width / mapW;
const scaleY = image.height / mapH;
const seen = new Uint8Array(mapW * mapH);
const boxes = [];
for (let y = 0; y < mapH; y += 1) {
  for (let x = 0; x < mapW; x += 1) {
    const start = y * mapW + x;
    if (seen[start] === 1 || prob[start] <= DET_THRESH) continue;
    let minX = x; let maxX = x; let minY = y; let maxY = y; let count = 0; let scoreSum = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const current = stack.pop();
      const cx = current % mapW;
      const cy = (current - cx) / mapW;
      count += 1;
      scoreSum += prob[current];
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= mapW || ny >= mapH) continue;
          const next = ny * mapW + nx;
          if (seen[next] === 1 || prob[next] <= DET_THRESH) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    const score = scoreSum / count;
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    if (count < 4 || score < BOX_THRESH) continue;
    if (boxH < 3) continue;
    // 还原到原图坐标并做一点外扩（DB 训练时区域被收缩过）
    const padX = Math.max(1, boxW * 0.05);
    const padY = Math.max(1, boxH * 0.15);
    boxes.push({
      x: Math.max(0, (minX - padX) * scaleX),
      y: Math.max(0, (minY - padY) * scaleY),
      width: Math.min(image.width, (boxW + padX * 2) * scaleX),
      height: Math.min(image.height, (boxH + padY * 2) * scaleY),
      score,
    });
  }
}
// 阅读顺序：先按行聚类（纵向重叠视为同一行），行内再从左到右
boxes.sort((a, b) => a.y - b.y || a.x - b.x);
const lines = [];
for (const box of boxes) {
  const line = lines.find((candidate) => Math.abs(candidate.y - box.y) < Math.max(candidate.height, box.height) * 0.6);
  if (line === undefined) lines.push({ y: box.y, height: box.height, items: [box] });
  else {
    line.items.push(box);
    line.height = Math.max(line.height, box.height);
    line.y = Math.min(line.y, box.y);
  }
}
lines.sort((a, b) => a.y - b.y);
for (const line of lines) line.items.sort((a, b) => a.x - b.x);
console.log(`boxes=${boxes.length} lines=${lines.length}`);

// ── rec + CTC ──────────────────────────────────────────────────────────────
// 字典内嵌在模型里；类别 = blank(0) + 字典 + 空格类（PP-OCR 的 use_space_char 约定）。
const dict = readCharacterDict(readFileSync(`${modelDir}\\rec_small.onnx`));
const decoded = [];
for (const line of lines) {
  const parts = [];
  for (const box of line.items) {
    const crop = cropRgba(image, box);
    const size = recInputSize(crop.width, crop.height, REC_HEIGHT);
    const resized = resizeRgba(crop, size.width, size.height);
    const tensor = new ort.Tensor('float32', toNchwTensor(resized, REC_NORMALIZATION).data, [1, 3, size.height, size.width]);
    const out = await rec.run({ x: tensor });
    const target = out[out.outputNames?.[0] ?? 'fetch_name_0'] ?? Object.values(out)[0];
    const [, steps, classes] = target.dims;
    const data = target.data;
    let text = '';
    let previous = -1;
    let confidence = 0;
    let kept = 0;
    for (let step = 0; step < steps; step += 1) {
      let best = 0;
      let bestValue = data[step * classes];
      for (let cls = 1; cls < classes; cls += 1) {
        const value = data[step * classes + cls];
        if (value > bestValue) { bestValue = value; best = cls; }
      }
      if (best !== 0 && best !== previous) {
        text += best <= dict.length ? (dict[best - 1] ?? '') : ' ';
        confidence += bestValue;
        kept += 1;
      }
      previous = best;
    }
    parts.push({ text, confidence: kept === 0 ? 0 : confidence / kept });
  }
  const text = parts.map((part) => part.text).join('');
  const confidence = parts.length === 0 ? 0 : parts.reduce((total, part) => total + part.confidence, 0) / parts.length;
  if (text.trim() !== '') decoded.push({ text, confidence, boxes: line.items.length });
}

console.log(`\n=== 识别结果（${decoded.length} 行，${Date.now() - started} ms） ===`);
for (const line of decoded) console.log(`[${line.confidence.toFixed(2)}] ${line.text}`);
console.log('\n全文：\n' + decoded.map((line) => line.text).join('\n'));
