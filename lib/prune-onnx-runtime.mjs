/**
 * 裁剪 `onnxruntime-node` 里**别的平台**的原生库（t77）。
 *
 * 背景：`onnxruntime-node` 的 npm 包把各平台二进制都打进了 tarball（实测 darwin 85MB + linux 68MB +
 * win32 133MB = 287MB），但运行时只会用当前平台那一个目录。删掉其余目录能省 ~150MB，
 * 且完全可逆 —— 重装依赖即可恢复（`npm install onnxruntime-node`）。
 *
 * 用法：
 *   node lib/prune-onnx-runtime.mjs            # 只报告，不删
 *   node lib/prune-onnx-runtime.mjs --apply    # 真删
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const BIN_ROOT = join(PACKAGE, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
const apply = process.argv.includes('--apply');
const platform = process.platform; // 'win32' | 'darwin' | 'linux'
const arch = process.arch; // 'x64' | 'arm64' | ...

function directorySize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

if (!existsSync(BIN_ROOT)) {
  console.log(`没有可裁剪的目录（${BIN_ROOT} 不存在）—— 说明依赖还没装，或版本变了。`);
  process.exit(0);
}

let freed = 0;
for (const platformDir of readdirSync(BIN_ROOT, { withFileTypes: true })) {
  if (!platformDir.isDirectory()) continue;
  const platformPath = join(BIN_ROOT, platformDir.name);
  for (const archDir of readdirSync(platformPath, { withFileTypes: true })) {
    if (!archDir.isDirectory()) continue;
    const keep = platformDir.name === platform && archDir.name === arch;
    const target = join(platformPath, archDir.name);
    const size = directorySize(target);
    if (keep) {
      console.log(`keep   ${platformDir.name}/${archDir.name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
      continue;
    }
    freed += size;
    console.log(`${apply ? 'remove' : 'would remove'} ${platformDir.name}/${archDir.name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
    if (apply) rmSync(target, { recursive: true, force: true });
  }
}
console.log(`\n${apply ? '已释放' : '可释放'}约 ${(freed / 1024 / 1024).toFixed(1)} MB（当前平台 ${platform}/${arch}）`);
if (!apply) console.log('加 --apply 才会真的删除；删掉的东西重装依赖即可恢复。');
