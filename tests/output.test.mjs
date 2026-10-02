/** Result delivery: clipboard, save-as, filenames and failure fallbacks (PRD F-20 … F-23, DoD B-8/B-9/B-12). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planRender, resolveSizePolicy, sizeAttempts } from '../lib/capture-plan.mjs';
import {
  blobToDataUrl,
  copyPngToClipboard,
  errorText,
  formatOf,
  isAbort,
  PNG_MIME,
  pngFileOf,
  savePngAs,
  WEBP_MIME,
} from '../lib/output.mjs';

/** A stand-in for the PNG blob; these helpers only pass it through. */
const blob = { tag: 'png-blob' };

test('the artifact mime type is PNG', () => {
  assert.equal(PNG_MIME, 'image/png');
});

test('the two produced formats keep their MIME, extension and label in step (R-01)', () => {
  assert.equal(WEBP_MIME, 'image/webp');
  assert.deepEqual(formatOf(PNG_MIME), { mediaType: 'image/png', extension: 'png', label: 'PNG' });
  assert.deepEqual(formatOf(WEBP_MIME), { mediaType: 'image/webp', extension: 'webp', label: 'WebP' });
  assert.deepEqual(formatOf(), { mediaType: 'image/png', extension: 'png', label: 'PNG' }, 'a missing media type keeps the lossless default');
  assert.deepEqual(formatOf('image/jpeg'), { mediaType: 'image/png', extension: 'png', label: 'PNG' }, 'only the produced formats are mapped');
});

test('the size fallback that sizeAttempts ends on is a .webp / image/webp product (R-01 with the D-8 chain)', () => {
  const capture = {
    widthPx: 3440,
    heightPx: 1440,
    url: '/api/dsh-screenshot/capture',
    scale: 1,
    bounds: { x: 0, y: 0, width: 3440, height: 1440 },
  };
  const plan = planRender(capture, { x: 0, y: 0, width: 1720, height: 720 }, { overlay: { width: 1720, height: 720 } });
  assert.equal(plan.valid, true);
  const attempts = sizeAttempts(plan, resolveSizePolicy({}));
  assert.equal(attempts[0].mediaType, 'image/png', 'the lossless attempt stays PNG');
  const last = attempts[attempts.length - 1];
  assert.equal(last.mediaType, WEBP_MIME, 'the ordered fallback ends on WebP');
  assert.deepEqual(formatOf(last.mediaType), { mediaType: 'image/webp', extension: 'webp', label: 'WebP' });
  assert.equal(pngFileOf(blob, new Date(2026, 1, 12, 14, 30, 15), last.mediaType).name, 'DSH截图_20260212_143015.webp');
});

test('copyPngToClipboard writes one PNG clipboard item', async () => {
  const written = [];
  const result = await copyPngToClipboard(blob, {
    navigator: { clipboard: { write: async (items) => written.push(items) } },
    ClipboardItemCtor: class {
      constructor(map) {
        this.map = map;
      }
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(written.length, 1);
  assert.equal(written[0].length, 1);
  assert.equal(written[0][0].map[PNG_MIME], blob);
});

test('copyPngToClipboard labels a WebP fallback product as image/webp (R-01)', async () => {
  const written = [];
  const result = await copyPngToClipboard(
    blob,
    {
      navigator: { clipboard: { write: async (items) => written.push(items) } },
      ClipboardItemCtor: class {
        constructor(map) {
          this.map = map;
        }
      },
    },
    WEBP_MIME,
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(written[0][0].map[WEBP_MIME], blob);
  assert.equal(written[0][0].map[PNG_MIME], undefined, 'WebP bytes are never announced as PNG');
});

test('copyPngToClipboard reports a missing clipboard instead of throwing (DoD B-12)', async () => {
  assert.deepEqual(await copyPngToClipboard(blob, { navigator: {}, ClipboardItemCtor: class {} }), {
    ok: false,
    reason: 'clipboard.unavailable',
  });
  assert.deepEqual(await copyPngToClipboard(blob, { navigator: { clipboard: { write: async () => {} } } }), {
    ok: false,
    reason: 'clipboard.itemUnavailable',
  });
});

test('copyPngToClipboard reports a denied clipboard write', async () => {
  const result = await copyPngToClipboard(blob, {
    navigator: { clipboard: { write: async () => { throw new Error('denied'); } } },
    ClipboardItemCtor: class {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'clipboard.failed:denied', 'the reason is log-safe and carries no image data');
});

test('savePngAs prefers the system save dialog with the DSH filename (DoD B-9)', async () => {
  const writes = [];
  const result = await savePngAs(blob, {
    now: () => new Date(2026, 1, 12, 14, 30, 15),
    showSaveFilePicker: async (options) => {
      assert.equal(options.suggestedName, 'DSH截图_20260212_143015.png');
      assert.deepEqual(options.types[0].accept, { 'image/png': ['.png'] });
      return {
        name: options.suggestedName,
        createWritable: async () => ({
          write: async (value) => writes.push(value),
          close: async () => writes.push('closed'),
        }),
      };
    },
  });
  assert.deepEqual(result, { ok: true, method: 'picker', fileName: 'DSH截图_20260212_143015.png' });
  assert.deepEqual(writes, [blob, 'closed']);
});

test('savePngAs names and accepts a WebP fallback product as .webp / image/webp (R-01)', async () => {
  const writes = [];
  const result = await savePngAs(
    blob,
    {
      now: () => new Date(2026, 1, 12, 14, 30, 15),
      showSaveFilePicker: async (options) => {
        assert.equal(options.suggestedName, 'DSH截图_20260212_143015.webp');
        assert.equal(options.types[0].description, 'WebP');
        assert.deepEqual(options.types[0].accept, { 'image/webp': ['.webp'] });
        return {
          name: options.suggestedName,
          createWritable: async () => ({
            write: async (value) => writes.push(value),
            close: async () => writes.push('closed'),
          }),
        };
      },
    },
    WEBP_MIME,
  );
  assert.deepEqual(result, { ok: true, method: 'picker', fileName: 'DSH截图_20260212_143015.webp' });
  assert.deepEqual(writes, [blob, 'closed']);
});

test('savePngAs downloads a WebP fallback product under the .webp name (R-01)', async () => {
  const platform = stubDocument();
  const result = await savePngAs(
    blob,
    { ...platform, showSaveFilePicker: undefined, now: () => new Date(2026, 1, 12, 14, 30, 15) },
    WEBP_MIME,
  );
  assert.deepEqual(result, { ok: true, method: 'download', fileName: 'DSH截图_20260212_143015.webp' });
  assert.equal(platform.anchors[0].download, 'DSH截图_20260212_143015.webp');
});

test('pngFileOf hands the conversation a File whose name and MIME match the bytes (R-01)', () => {
  const lossless = pngFileOf(blob, new Date(2026, 1, 12, 14, 30, 15));
  assert.equal(lossless.name, 'DSH截图_20260212_143015.png');
  assert.equal(lossless.type, PNG_MIME);
  const lossy = pngFileOf(blob, new Date(2026, 1, 12, 14, 30, 15), WEBP_MIME);
  assert.equal(lossy.name, 'DSH截图_20260212_143015.webp');
  assert.equal(lossy.type, WEBP_MIME);
});

test('savePngAs treats a cancelled dialog as a non-error', async () => {
  const abort = Object.assign(new Error('user cancelled'), { name: 'AbortError' });
  const result = await savePngAs(blob, { showSaveFilePicker: async () => { throw abort; } });
  assert.deepEqual(result, { ok: false, method: 'picker', reason: 'save.cancelled' });
});

test('savePngAs falls back to a download when the picker fails for another reason', async () => {
  const platform = stubDocument();
  const result = await savePngAs(blob, {
    ...platform,
    // The suggested name is a policy input: freeze the clock so the assertion
    // checks the fallback path instead of the real date.
    now: () => new Date(2026, 1, 12, 14, 30, 15),
    showSaveFilePicker: async () => { throw new Error('policy denied'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'download');
  assert.equal(result.fileName, 'DSH截图_20260212_143015.png');
  assert.equal(platform.created.length, 1);
});

test('savePngAs downloads when the platform exposes no picker', async () => {
  const platform = stubDocument();
  // An explicit `showSaveFilePicker: undefined` suppresses global lookup.
  const result = await savePngAs(blob, { ...platform, showSaveFilePicker: undefined, now: () => new Date(2026, 1, 12, 14, 30, 15) });
  assert.deepEqual(result, { ok: true, method: 'download', fileName: 'DSH截图_20260212_143015.png' });
  assert.equal(platform.anchors[0].download, 'DSH截图_20260212_143015.png');
  assert.equal(platform.anchors[0].rel, 'noopener');
});

test('savePngAs fails visibly when no delivery path exists', async () => {
  const result = await savePngAs(blob, { showSaveFilePicker: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'save.unavailable');
});

test('savePngAs never throws when the object URL cannot be created', async () => {
  const platform = stubDocument();
  platform.url.createObjectURL = () => { throw new Error('no blob support'); };
  const result = await savePngAs(blob, { ...platform, showSaveFilePicker: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'save.failed:no blob support');
});

test('isAbort recognizes only AbortError', () => {
  assert.equal(isAbort(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbort(new Error('x')), false);
  assert.equal(isAbort(null), false);
  assert.equal(isAbort('AbortError'), false);
});

test('errorText never returns an object dump', () => {
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText('boom'), 'boom');
  assert.equal(errorText(42), '42');
});

test('blobToDataUrl resolves through the injected reader', async () => {
  const readAsDataUrl = function read(blobValue) {
    assert.equal(blobValue, blob);
    this.result = 'data:image/png;base64,AAAA';
    this.onload();
  };
  assert.equal(await blobToDataUrl(blob, readAsDataUrl), 'data:image/png;base64,AAAA');
});

test('blobToDataUrl rejects when the read fails', async () => {
  const readAsDataUrl = function read() {
    this.error = new Error('decode failed');
    this.onerror();
  };
  await assert.rejects(() => blobToDataUrl(blob, readAsDataUrl), /decode failed/);
});

/**
 * @returns {{
 *   document: object,
 *   url: { createObjectURL: Function, revokeObjectURL: Function },
 *   anchors: object[],
 *   created: string[],
 * }}
 */
function stubDocument() {
  const anchors = [];
  const created = [];
  return {
    anchors,
    created,
    url: {
      createObjectURL: (value) => {
        created.push(value);
        return `blob:test/${created.length}`;
      },
      revokeObjectURL: () => {},
    },
    document: {
      createElement: () => ({
        href: '',
        download: '',
        rel: '',
        click() {},
        remove() {},
      }),
      body: {
        append: (anchor) => anchors.push(anchor),
      },
    },
  };
}
