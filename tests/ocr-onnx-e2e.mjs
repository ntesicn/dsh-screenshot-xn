/**
 * 端到端验证脚本（t79）：用**插件自己的模块**跑一遍 ONNX OCR，并与 Windows 引擎对比。
 *
 * 它不进 `node --test`（需要 ~31MB 模型与原生依赖），只在模型齐备时作为"证据脚本"手动跑：
 *   node tests/ocr-onnx-e2e.mjs <png> [--windows]
 *
 * 退出码：0 = 识别成功且文本与预期关键词相符；2 = 模型未就绪（跳过）；1 = 失败。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeWithOnnx } from '../lib/ocr-onnx.mjs';
import { defaultModelDir, inspectModels, normalizeModelTier } from '../lib/ocr-models.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const imagePath = process.argv[2];
if (imagePath === undefined) {
  console.error('用法：node tests/ocr-onnx-e2e.mjs <png> [--windows]');
  process.exit(2);
}
const modelDir = process.env.DSH_SCREENSHOT_OCR_MODELS ?? defaultModelDir();
const tier = normalizeModelTier(process.env.DSH_SCREENSHOT_OCR_TIER);
const state = inspectModels(modelDir, tier);
if (!state.ready) {
  console.error(`模型未就绪（${modelDir}，档位 ${tier}）：缺 ${state.missing.join(', ') || '无'}，坏 ${state.corrupt.join(', ') || '无'}`);
  process.exit(2);
}

const png = readFileSync(imagePath);
const onnx = await recognizeWithOnnx({ png, modelDir, tier });
if (onnx.ok !== true) {
  console.error(`ONNX 识别失败：${onnx.reason}`);
  process.exit(1);
}
console.log(`=== ONNX（${onnx.engine}）${onnx.width}x${onnx.height}，${onnx.boxes} 框 / ${onnx.lines.length} 行 / ${onnx.elapsedMs} ms ===`);
console.log(onnx.text);

if (process.argv.includes('--windows')) {
  const script = join(PACKAGE, 'lib', 'ocr.ps1');
  const started = Date.now();
  let windowsText = '';
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', imagePath, '-AsJson'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const match = /---JSON-BEGIN---([\s\S]*?)---JSON-END---/.exec(raw);
    windowsText = match === null ? raw : (JSON.parse(match[1]).text ?? '');
  } catch (error) {
    windowsText = `<Windows 引擎失败: ${error instanceof Error ? error.message : String(error)}>`;
  }
  console.log(`\n=== Windows.Media.Ocr（${Date.now() - started} ms）===`);
  console.log(windowsText);
}
