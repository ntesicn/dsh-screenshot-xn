/**
 * CTC 贪心解码（t77，接法 A）。
 *
 * PP-OCR 的识别网络输出 `[1, T, C]` 的逐帧类别分数。约定（与 PaddleOCR 的 `CTCLabelDecode` 一致）：
 *   - 0 号类是 **blank**；
 *   - `1 … dict.length` 依次对应字典里的字；
 *   - 最后一类（`dict.length + 1`）是 **空格**（`use_space_char`）。
 * 贪心解码：每帧取 argmax，去掉重复与 blank。本模块纯逻辑，单测可直接造分数矩阵。
 */

/** 空格类在字典之后的偏移（`dict.length + 1` 号类）。 */
export const SPACE_CLASS_OFFSET = 1;

/**
 * 解码一帧序列。
 * @param {Float32Array|number[]} logits - 行优先的 `[T, C]` 分数。
 * @param {number} steps - 时间步数 T。
 * @param {number} classes - 类别数 C。
 * @param {readonly string[]} dict - 字符字典（不含 blank、不含末尾空格类）。
 * @returns {{text: string, confidence: number}} 文本与平均置信度（取保留下来的帧的平均分）。
 */
export function decodeCtcGreedy(logits, steps, classes, dict) {
  let previous = -1;
  let text = '';
  let confidenceSum = 0;
  let kept = 0;
  for (let step = 0; step < steps; step += 1) {
    let best = 0;
    let bestValue = logits[step * classes];
    for (let cls = 1; cls < classes; cls += 1) {
      const value = logits[step * classes + cls];
      if (value > bestValue) {
        bestValue = value;
        best = cls;
      }
    }
    if (best !== 0 && best !== previous) {
      text += characterFor(best, dict);
      confidenceSum += bestValue;
      kept += 1;
    }
    previous = best;
  }
  return { text, confidence: kept === 0 ? 0 : confidenceSum / kept };
}

/**
 * 类别号 → 字符。越界（模型类别多于字典 + 空格）时回落空串而不是抛错。
 * @param {number} cls - 类别号（1 起）。
 * @param {readonly string[]} dict
 * @returns {string}
 */
export function characterFor(cls, dict) {
  if (cls <= 0) return '';
  if (cls <= dict.length) return dict[cls - 1] ?? '';
  if (cls === dict.length + SPACE_CLASS_OFFSET) return ' ';
  return '';
}
