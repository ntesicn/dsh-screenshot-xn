/**
 * Result delivery: clipboard, "save as" and filename policy (PRD F-20 … F-22).
 *
 * These helpers touch the browser platform, never the DSH runtime, so they load
 * unchanged in the overlay bundle and drive cleanly from `node --test` with a
 * stub `navigator`/`document`. All failure paths return a value instead of
 * throwing: an unavailable clipboard must degrade to a visible notice, not to a
 * broken overlay (PRD 4 可靠性 / DoD B-12).
 */
import { screenshotFileName } from './capture-plan.mjs';

/** MIME type of the lossless artifact (PRD F-23, PNG lossless). */
export const PNG_MIME = 'image/png';

/** MIME type of the lossy fallback product (队长 D-8: WebP 有损是降级链的最后一档). */
export const WEBP_MIME = 'image/webp';

/**
 * The labels that must agree for one artifact: the clipboard entry's MIME, the
 * file extension, and the save dialog's description.
 *
 * The size fallback (队长 D-8) produces WebP bytes, so announcing them as PNG
 * hands the user a `.png` file no viewer opens (DoD B-9 "格式非 PNG") and a
 * clipboard entry whose MIME contradicts its bytes (DoD B-8 "粘贴为空").
 * Callers therefore pass the media type the encoder actually produced.
 * @param {string} [mediaType] - `image/png` or `image/webp`; anything else (or a
 *   missing value) is treated as the lossless PNG default.
 * @returns {{ mediaType: string, extension: string, label: string }} the labels.
 */
export function formatOf(mediaType = PNG_MIME) {
  return mediaType === WEBP_MIME
    ? { mediaType: WEBP_MIME, extension: 'webp', label: 'WebP' }
    : { mediaType: PNG_MIME, extension: 'png', label: 'PNG' };
}

/**
 * Write the artifact to the system clipboard under its real MIME type.
 *
 * `ClipboardItem` is the only API that can put raw image bytes on the clipboard
 * in this runtime; the `ClipboardEvent`/`execCommand` fallback used by older
 * guides cannot produce an image and is intentionally not attempted.
 *
 * @param {{ navigator?: object, ClipboardItemCtor?: Function }} [platform]
 * @param {string} [mediaType] - the encoder's media type (`image/png`, or the
 *   WebP fallback `image/webp`); the entry must not claim PNG for WebP bytes.
 * @returns {Promise<{ ok: boolean, reason?: string }>} delivery outcome.
 */
export async function copyPngToClipboard(blob, platform = {}, mediaType = PNG_MIME) {
  const nav = platform.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const Item = platform.ClipboardItemCtor
    ?? (typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem);
  const format = formatOf(mediaType);
  try {
    if (nav?.clipboard?.write === undefined) return { ok: false, reason: 'clipboard.unavailable' };
    if (Item === undefined) return { ok: false, reason: 'clipboard.itemUnavailable' };
    await nav.clipboard.write([new Item({ [format.mediaType]: blob })]);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `clipboard.failed:${errorText(error)}` };
  }
}

/**
 * Save the artifact through the system save dialog, falling back to a download
 * when the platform exposes no file picker (DoD B-9, F-22).
 *
 * @param {Blob} blob
 * @param {{ showSaveFilePicker?: Function, document?: object, url?: { createObjectURL: Function, revokeObjectURL: Function }, now?: () => Date }} [platform]
 * @param {string} [mediaType] - the encoder's media type; the suggested name,
 *   its extension and the picker's accept list all follow it, so a WebP fallback
 *   product is never written as `DSH截图_….png`.
 * @returns {Promise<{ ok: boolean, method: string, fileName?: string, reason?: string }>} delivery outcome.
 */
export async function savePngAs(blob, platform = {}, mediaType = PNG_MIME) {
  const format = formatOf(mediaType);
  const fileName = screenshotFileName(platform.now?.() ?? new Date(), { extension: format.extension });
  const picker = platform.showSaveFilePicker
    ?? (typeof showSaveFilePicker === 'function' ? showSaveFilePicker : undefined);
  if (picker !== undefined) {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: format.label, accept: { [format.mediaType]: [`.${format.extension}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, method: 'picker', fileName: handle.name ?? fileName };
    } catch (error) {
      if (isAbort(error)) return { ok: false, method: 'picker', reason: 'save.cancelled' };
      // A denied picker (permission policy) still deserves the download path.
      const fallback = downloadBlob(blob, fileName, platform);
      return fallback.ok
        ? { ...fallback, method: 'download' }
        : { ok: false, method: 'picker', reason: `save.failed:${errorText(error)}` };
    }
  }
  return downloadBlob(blob, fileName, platform);
}

/**
 * @param {Blob} blob
 * @param {string} fileName
 * @param {{ document?: object, url?: { createObjectURL: Function, revokeObjectURL: Function } }} platform
 * @returns {{ ok: boolean, method: string, fileName?: string, reason?: string }}
 */
function downloadBlob(blob, fileName, platform) {
  const doc = platform.document ?? (typeof document === 'undefined' ? undefined : document);
  const urlApi = platform.url ?? (typeof URL === 'undefined' ? undefined : URL);
  if (doc === undefined || urlApi === undefined) return { ok: false, method: 'download', reason: 'save.unavailable' };
  let href;
  try {
    href = urlApi.createObjectURL(blob);
  } catch (error) {
    return { ok: false, method: 'download', reason: `save.failed:${errorText(error)}` };
  }
  const anchor = doc.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a later task so the browser has started reading the blob. Where
  // the host returns a timer object (node) it is unref'd, so an offline run does
  // not linger for ten seconds after the last assertion.
  const timer = setTimeout(() => urlApi.revokeObjectURL(href), 10_000);
  if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return { ok: true, method: 'download', fileName };
}

/**
 * @param {unknown} error
 * @returns {boolean} whether the failure is the user cancelling a dialog.
 */
export function isAbort(error) {
  if (error === null || typeof error !== 'object') return false;
  const name = /** @type {{ name?: unknown }} */ (error).name;
  return name === 'AbortError';
}

/**
 * @param {unknown} error
 * @returns {string} a short, log-safe description; never contains image data.
 */
export function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Convert a PNG blob to a data URL.
 * Image attachments travel inline with the prompt, so this is the form the
 * insert path hands over.
 *
 * The reader is injectable: when `readAsDataUrl` is given it is called with the
 * reader as `this` (`{ result, error, onload, onerror }` are wired up here) and
 * no global `FileReader` is touched — that is what lets the offline tests and
 * any non-browser host drive the conversion without a DOM.
 * @param {Blob} blob
 * @param {Function} [readAsDataUrl] - `FileReader.prototype.readAsDataURL`, injectable for tests.
 * @returns {Promise<string>} the data URL.
 */
export function blobToDataUrl(blob, readAsDataUrl) {
  const reader = readAsDataUrl === undefined ? new FileReader() : {};
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    if (readAsDataUrl === undefined) reader.readAsDataURL(blob);
    else readAsDataUrl.call(reader, blob);
  });
}

/**
 * Build the `File` handed to the conversation as an image draft.
 *
 * The name, its extension and `File.type` all follow the encoder's media type:
 * attachment intake validates the declared MIME against the bytes, so a WebP
 * fallback product must travel as `image/webp`. The function name is kept for
 * API stability even though the product is not always PNG.
 * @param {Blob} blob
 * @param {Date} [now]
 * @param {string} [mediaType] - the encoder's media type.
 * @returns {File} an image file with the user-facing name.
 */
export function pngFileOf(blob, now = new Date(), mediaType = PNG_MIME) {
  const format = formatOf(mediaType);
  return new File([blob], screenshotFileName(now, { extension: format.extension }), {
    type: format.mediaType,
    lastModified: now.getTime(),
  });
}
