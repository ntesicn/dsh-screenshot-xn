/**
 * t73：截图模式的**持久化偏好**。
 *
 * 用户的要求：「右键选择截图模式 保留现在右键选择的情况下 能否将结果记录 不要每回重启 又得重新选」，
 * 并进一步指出「能否在 dsh 的插件管理里面进行切换来避免重启重置」。
 *
 * 因此这份契约钉住三件事：
 *  1. 插件导出 **Config schema**，其中 `captureMode` 是 `.volatile()` 字段 —— 这是 DSH 设置页 /
 *     插件管理渲染并写回 profile patch 的唯一入口（`dsh-settings` 的 `volatileForm`）；
 *  2. 宿主按 **volatile 字段的读法**（Ref 的 `get()`）解析当前值，脏值一律回落穿透；
 *  3. `GET/POST /api/dsh-screenshot/state` 读写这个偏好，且 POST 会把选择交给 `ctx.settings`
 *     （即用户说的"插件管理里那份配置"），服务不可用时降级为"仅本次会话生效"而不是报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const host = await import(`file://${join(PACKAGE, 'index.js')}`);

const {
  apply,
  Config,
  MODE_THROUGH,
  MODE_NORMAL,
  ROUTE_PATH,
  STATE_PATH,
  normalizeCaptureMode,
  readVolatile,
  resolveSettings,
  entryIdFrom,
} = host;

/** 用真实的 Config schema 造一份"加载器会交给 apply 的配置"。 */
function validatedConfig(raw) {
  const result = Config['~standard'].validate(raw);
  assert.equal(result.issues, undefined, `配置应通过校验: ${JSON.stringify(result.issues)}`);
  return result.value;
}

/** 启动一份宿主路由（三个注册：capture / overlay 前缀 / state）。 */
async function bootHost(settings, context) {
  const routes = [];
  const logs = [];
  const webServer = {
    port: 0,
    host: '127.0.0.1',
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const ctx = {
    logger: {
      debug() {},
      info: (line) => logs.push(`info ${line}`),
      warn: (line) => logs.push(`warn ${line}`),
    },
    get: (name) => {
      if (name === 'webServer') return webServer;
      return context?.services?.[name];
    },
    inject: (deps, callback) => callback(ctx, {}),
    effect: (fn) => fn(),
    on: () => () => {},
    ...(context?.fiber === undefined ? {} : { fiber: { entry: { options: { id: context.fiber } } } }),
  };
  apply(ctx, settings);
  const stateRoute = routes.find((route) => route.kind === 'exact' && route.path === STATE_PATH);
  assert.ok(stateRoute !== undefined, `必须注册 ${STATE_PATH}`);
  const server = createServer((req, res) => stateRoute.handler(req, res));
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    logs,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

const readMode = async (base) => {
  const response = await fetch(new URL(STATE_PATH, base));
  return { status: response.status, body: await response.json() };
};
const writeMode = async (base, payload) => {
  const response = await fetch(new URL(STATE_PATH, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
};

test('(t73-1) the plugin declares a Config schema whose captureMode is a volatile choice', () => {
  const json = JSON.stringify(Config.toJSON());
  assert.match(json, /"volatile":true/, 'Config 里必须有 volatile 字段（设置页只渲染这类字段）');
  const field = Config.dict.captureMode;
  assert.ok(field !== undefined, 'Config 必须声明 captureMode');
  assert.equal(field.meta?.volatile, true, 'captureMode 必须是 volatile 字段，否则改动要重启才生效');
  assert.deepEqual(field.meta?.default, MODE_THROUGH, '默认必须是穿透');
  // 枚举：脏值要被 schema 拒绝（这样设置页只会写出两个合法值之一）。
  const bad = Config['~standard'].validate({ captureMode: 'bogus' });
  assert.ok(bad.issues !== undefined && bad.issues.length > 0, 'captureMode 必须是闭集，脏值应被拒绝');
  assert.match(String(bad.issues[0].message), /through.*normal/, '报错信息应列出两个合法取值');
  // 既有配置键不受影响：schemastery 保留未知键（否则老行的 scriptPath 等会静默丢失）。
  const kept = validatedConfig({ captureMode: MODE_NORMAL, hideWaitMs: 1234, tag: 'x' });
  assert.equal(kept.hideWaitMs, 1234, '未声明的既有配置键必须原样保留');
  assert.equal(kept.tag, 'x', '未声明的既有配置键必须原样保留');
});

test('(t73-2) a volatile field is read through its ref, and settings normalize to through/normal', () => {
  const value = validatedConfig({ captureMode: MODE_NORMAL }).captureMode;
  // 加载器把 volatile 字段交给插件的是一个 Ref：插件必须用 get() 读（否则拿到的是对象）。
  assert.equal(typeof value, 'object', 'volatile 字段在运行期是 Ref 对象');
  assert.equal(typeof value.get, 'function', 'volatile Ref 必须提供 get()');
  assert.equal(readVolatile(value), MODE_NORMAL, 'readVolatile 必须解开 Ref');
  assert.equal(readVolatile('normal'), MODE_NORMAL, '普通值也要原样通过（非 volatile 行）');
  assert.equal(normalizeCaptureMode('bogus'), MODE_THROUGH, '脏值必须回落穿透');
  assert.equal(resolveSettings({ captureMode: value }).captureMode, MODE_NORMAL, '解析后的设置应带上模式');
  assert.equal(resolveSettings({}).captureMode, MODE_THROUGH, '没配就是穿透');
  assert.equal(entryIdFrom({}), 'dsh-screenshot-xn', '没有 fiber 时用行 id 兜底');
  assert.equal(
    entryIdFrom({ fiber: { entry: { options: { id: 'custom-row' } } } }),
    'custom-row',
    '有 fiber 时必须用真实行 id（ctx.settings 按它索引）',
  );
});

test('(t73-3) GET/POST state reads and persists the mode through ctx.settings', async () => {
  const updates = [];
  const settingsService = {
    update: async (ns, patch) => {
      updates.push({ ns, patch });
    },
  };
  const runtime = await bootHost(validatedConfig({ captureMode: MODE_THROUGH }), {
    services: { settings: settingsService },
    fiber: 'custom-row',
  });
  try {
    const initial = await readMode(runtime.base);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { ok: true, captureMode: MODE_THROUGH }, '初始应报告配置里的穿透');

    const written = await writeMode(runtime.base, { captureMode: MODE_NORMAL });
    assert.equal(written.status, 200);
    assert.equal(written.body.ok, true);
    assert.equal(written.body.persisted, true, '有 ctx.settings 时必须报告已持久化');
    assert.deepEqual(updates, [{ ns: 'custom-row', patch: { captureMode: MODE_NORMAL } }], '必须写进行 id 对应的配置');

    const after = await readMode(runtime.base);
    assert.equal(after.body.captureMode, MODE_NORMAL, 'POST 之后立刻生效（不用重启）');

    // 脏值/坏体必须被拒，且不产生任何写入。
    const badMode = await writeMode(runtime.base, { captureMode: 'sideways' });
    assert.equal(badMode.status, 400);
    assert.equal(badMode.body.error, 'state.invalid-mode');
    const badBody = await writeMode(runtime.base, '{not json');
    assert.equal(badBody.status, 400);
    assert.equal(badBody.body.error, 'state.bad-body');
    assert.equal((await writeMode(runtime.base, {})).status, 400, '缺少 captureMode 应被拒');
    assert.equal(updates.length, 1, '非法请求不得触发写入');

    // 方法契约。
    const put = await fetch(new URL(STATE_PATH, runtime.base), { method: 'PUT' });
    assert.equal(put.status, 405, '只接受 GET/POST');
    assert.equal(put.headers.get('allow'), 'GET, POST');
  } finally {
    await runtime.close();
  }
});

test('(t73-4) without ctx.settings the choice still applies now, and the reply says it is session-local', async () => {
  const runtime = await bootHost(validatedConfig({ captureMode: MODE_THROUGH }), {});
  try {
    const written = await writeMode(runtime.base, { captureMode: MODE_NORMAL });
    assert.equal(written.status, 200, '没有设置服务也不该报错');
    assert.equal(written.body.persisted, false, '必须如实说明没有持久化');
    assert.equal(written.body.reason, 'settings.unavailable');
    assert.equal((await readMode(runtime.base)).body.captureMode, MODE_NORMAL, '本次会话仍然立刻生效');
    assert.ok(
      runtime.logs.some((line) => line.includes('session-local')),
      `日志里要说清"仅本次会话": ${JSON.stringify(runtime.logs)}`,
    );

    // 真配置对象里的 volatile ref 也要被就地更新 —— 否则下一次 volatile 比较会把它当"没变"。
    const live = validatedConfig({ captureMode: MODE_THROUGH });
    const liveRuntime = await bootHost(live, {});
    try {
      await writeMode(liveRuntime.base, { captureMode: MODE_NORMAL });
      assert.equal(readVolatile(live.captureMode), MODE_NORMAL, '运行期的 volatile ref 必须同步更新');
    } finally {
      await liveRuntime.close();
    }
  } finally {
    await runtime.close();
  }
});
