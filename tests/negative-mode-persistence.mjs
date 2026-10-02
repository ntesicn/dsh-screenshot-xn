/**
 * 负样本构造（t73）：把「截图模式持久化」打回原形，证明 validate.mjs 的 X-1 偏好门禁与
 * tests/overlay-e2e.mjs 的 E2E-6 真的会因为这个缺陷而失败 —— 而不是"怎么写都绿"。
 *
 * 两个负样本：
 *  A. 客户端**启动时不读回**偏好（`void loadCaptureMode(store);` 删掉）→ X-1 必须失败；
 *  B. 服务端把偏好路由**退回内存**（`ctx.settings.update` 那一步不写配置）→ E2E-6 必须失败
 *     （重启后读回来的还是默认值）。
 *
 * 用法：node tests/negative-mode-persistence.mjs
 * 退出码 0 = 两条门禁都如期失败（负样本有效）；1 = 有人假绿。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const WORKSPACE = dirname(PACKAGE);

/** 复制一份插件，按 `mutate` 改写后跑门禁。 */
function staged(mutate) {
  const copy = mkdtempSync(join(tmpdir(), 'dsh-neg-mode-pref-'));
  const target = join(copy, 'dsh-screenshot-xn');
  cpSync(PACKAGE, target, { recursive: true });
  const outcome = mutate(target);
  if (outcome.ok !== true) {
    rmSync(copy, { recursive: true, force: true });
    console.error(`负样本无从构造：${outcome.reason}`);
    process.exit(2);
  }
  return { copy, target };
}

// ── 负样本 A：客户端启动不读回偏好 ──────────────────────────────────────────
const a = staged((target) => {
  const file = join(target, 'client.js');
  const source = readFileSync(file, 'utf8');
  const anchor = 'void loadCaptureMode(store);';
  if (!source.includes(anchor)) return { ok: false, reason: 'client.js 里找不到启动读回偏好那一行' };
  writeFileSync(file, source.replace(anchor, ''), 'utf8');
  return { ok: true };
});
const validateA = spawnSync(process.execPath, [join(WORKSPACE, 'validate.mjs'), a.target], { encoding: 'utf8' });
const aCaught = validateA.status !== 0 && /偏好|loadCaptureMode/.test(validateA.stdout ?? '');
console.log(`负样本 A（启动不读回）: validate exit ${validateA.status}，门禁命中=${aCaught}`);
rmSync(a.copy, { recursive: true, force: true });

// ── 负样本 B：偏好路由不再写进插件配置（只改内存） ──────────────────────────
const b = staged((target) => {
  const file = join(target, 'index.js');
  const source = readFileSync(file, 'utf8');
  const anchor = 'await service.update(state.entryId, { captureMode: requested });';
  if (!source.includes(anchor)) return { ok: false, reason: 'index.js 里找不到写配置那一行' };
  // 假装写成功，其实没写 —— 正是"重启后又得重选"的病根。
  writeFileSync(file, source.replace(anchor, 'void state.entryId;'), 'utf8');
  return { ok: true };
});
const e2eB = spawnSync(process.execPath, [join(b.target, 'tests', 'overlay-e2e.mjs')], { encoding: 'utf8', timeout: 180_000 });
const bCaught = e2eB.status !== 0 && /\[FAIL\] E2E-6 模式持久化/.test(e2eB.stdout ?? '');
console.log(`负样本 B（不写配置）: overlay-e2e exit ${e2eB.status}，持久化场景失败=${bCaught}`);
rmSync(b.copy, { recursive: true, force: true });

if (aCaught && bCaught) {
  console.log('负样本有效：X-1 与 E2E-6 都能抓到"重启即丢"的缺陷。');
  process.exit(0);
}
console.error('负样本无效（有人假绿）：门禁没有抓到"重启即丢"的缺陷。');
process.exit(1);
