/**
 * ONNX 模型元数据读取（t77，接法 A）。
 *
 * PP-OCR 的 **ONNX 识别模型把字符字典内嵌在模型里**（`ModelProto.metadata_props` 里那个
 * `character` 键），所以随插件分发时**不需要单独的 dict 文件**，也就不会出现"字典与模型不匹配"
 * 的经典事故（类别数对不上时中文会被整体映射错）。
 *
 * `onnxruntime-node` 这版没有暴露模型元数据（既没有 `modelMetadata` 也没有 `getModelMetadata()`），
 * 所以这里自己走一遍 protobuf 的顶层字段：只关心 14 号字段（metadata_props），其余字段按长度跳过
 * —— 顶层只有十几个字段、大图字段是一次跳过的，代价很小。
 *
 * 本模块**纯逻辑**：喂字节进、给字符串出，单测可以造小 protobuf 验证。
 */

/** ONNX `ModelProto.metadata_props` 的字段号。 */
export const METADATA_PROPS_FIELD = 14;
/** PP-OCR 识别模型里存字典的元数据键。 */
export const CHARACTER_KEY = 'character';

/**
 * 读一个 varint。
 * @param {Uint8Array} bytes @param {number} at @returns {{value: number, next: number}}
 */
function readVarint(bytes, at) {
  let value = 0;
  let shift = 0;
  let cursor = at;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    value += (byte & 0x7f) * 2 ** shift;
    cursor += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error('varint is too long');
  }
  return { value, next: cursor };
}

/**
 * 把一段字节按 `StringStringEntryProto` 解析成键值对（只认 1 号键、2 号值）。
 * @param {Uint8Array} bytes @returns {Record<string, string>}
 */
function readStringPairs(bytes) {
  const out = {};
  let cursor = 0;
  let key = null;
  while (cursor < bytes.length) {
    const tag = readVarint(bytes, cursor);
    cursor = tag.next;
    const field = tag.value >> 3;
    const wire = tag.value & 0x7;
    if (wire === 2) {
      const length = readVarint(bytes, cursor);
      cursor = length.next;
      const slice = bytes.subarray(cursor, cursor + length.value);
      cursor += length.value;
      if (field === 1) key = Buffer.from(slice).toString('utf8');
      else if (field === 2 && key !== null) out[key] = Buffer.from(slice).toString('utf8');
      continue;
    }
    if (wire === 0) {
      cursor = readVarint(bytes, cursor).next;
      continue;
    }
    if (wire === 5) {
      cursor += 4;
      continue;
    }
    if (wire === 1) {
      cursor += 8;
      continue;
    }
    throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/**
 * 读出 ONNX 模型的顶层元数据键值对。
 * @param {Buffer|Uint8Array} buffer - .onnx 字节。
 * @param {number} [field] - metadata_props 的字段号（默认 14）。
 * @returns {Record<string, string>} 元数据；没有时为空对象。
 */
export function readOnnxMetadata(buffer, field = METADATA_PROPS_FIELD) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const out = {};
  let cursor = 0;
  while (cursor < bytes.length) {
    const tag = readVarint(bytes, cursor);
    cursor = tag.next;
    const number = tag.value >> 3;
    const wire = tag.value & 0x7;
    if (wire === 2) {
      const length = readVarint(bytes, cursor);
      cursor = length.next;
      const end = cursor + length.value;
      if (end > bytes.length) throw new Error('truncated ONNX field');
      if (number === field) Object.assign(out, readStringPairs(bytes.subarray(cursor, end)));
      cursor = end;
      continue;
    }
    if (wire === 0) {
      cursor = readVarint(bytes, cursor).next;
      continue;
    }
    if (wire === 5) {
      cursor += 4;
      continue;
    }
    if (wire === 1) {
      cursor += 8;
      continue;
    }
    throw new Error(`unsupported wire type ${wire} at field ${number}`);
  }
  return out;
}

/**
 * 从识别模型里取出字符字典（`character` 元数据，一行一个字）。
 *
 * 约定与 PP-OCR 一致：CTC 的 0 号类是 blank，字典的第 `index` 项对应类别 `index + 1`。
 * @param {Buffer|Uint8Array} buffer - 识别模型的 .onnx 字节。
 * @returns {string[]} 字典；模型没内嵌字典时返回空数组（调用方据此拒绝该模型）。
 */
export function readCharacterDict(buffer) {
  const metadata = readOnnxMetadata(buffer);
  const raw = metadata[CHARACTER_KEY];
  if (typeof raw !== 'string' || raw === '') return [];
  const lines = raw.split(/\r?\n/);
  // 末尾通常会多一个换行符；空串也可能是字典里的一个"空格类"，所以只丢最后一个空行。
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
