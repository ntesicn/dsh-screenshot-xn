/**
 * 负样本构造：把「静态资源分支在 token 校验之前」这一条打回原形（t64 的实机缺陷状态），
 * 用来证明 validate.mjs X-1 的顺序门禁与 tests/overlay-e2e.mjs 的 E2E-4 真的会因为
 * 这个缺陷而失败 —— 而不是"怎么写都绿"。
 *
 * 用法：node tests/negative-asset-order.mjs
 * 退出码 0 = 两个门禁都如期失败（负样本有效）；1 = 有人假绿。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const WORKSPACE = dirname(PACKAGE);

const copy = mkdtempSync(join(tmpdir(), 'dsh-neg-asset-order-'));
const target = join(copy, 'dsh-screenshot-xn');
cpSync(PACKAGE, target, { recursive: true });

const index = join(target, 'index.js');
const source = readFileSync(index, 'utf8');
const TOKEN_CHECK = '    const session = overlay.sessionFor(token);\n' +
  '    if (session === undefined) {\n' +
  '      sendJson(res, 404, { ok: false, error: \'overlay.unknown-token\' });\n' +
  '      return;\n' +
  '    }\n';
const anchor = '    if (path === OVERLAY_PAGE_PATH) {';
if (!source.includes(TOKEN_CHECK) || !source.includes(anchor)) {
  console.error('负样本无从构造：找不到 token 校验块或页面分支锚点');
  process.exit(2);
}
const broken = source
  .replace(TOKEN_CHECK, '')
  .replace(anchor, `${TOKEN_CHECK}${anchor}`);
writeFileSync(index, broken, 'utf8');

const validate = spawnSync(process.execPath, [join(WORKSPACE, 'validate.mjs'), target], { encoding: 'utf8' });
const e2e = spawnSync(process.execPath, [join(target, 'tests', 'overlay-e2e.mjs')], { encoding: 'utf8', timeout: 180_000 });

const validateFailed = validate.status !== 0 && /静态资源分支/.test(validate.stdout ?? '');
// 静态资源场景在 e2e 里的编号会随场景增删变化（t67 起是 E2E-3），所以按**名字**认。
const staticScenarioFailed = /\[FAIL\] E2E-\d+ 面板静态资源免 token/.test(e2e.stdout ?? '');
const e2eFailed = e2e.status !== 0 && staticScenarioFailed;

console.log(`validate.mjs: exit ${validate.status}，顺序门禁命中=${/静态资源分支/.test(validate.stdout ?? '')}`);
console.log(`overlay-e2e:  exit ${e2e.status}，静态资源场景失败=${staticScenarioFailed}`);
rmSync(copy, { recursive: true, force: true });

if (validateFailed && e2eFailed) {
  console.log('负样本有效：两条门禁都能抓到这个缺陷。');
  process.exit(0);
}
console.error('负样本无效（有人假绿）：门禁没有抓到这个缺陷。');
process.exit(1);
