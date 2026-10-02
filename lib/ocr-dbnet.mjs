/**
 * DB 文本检测后处理（t77，接法 A）。
 *
 * PP-OCR 的检测网络输出一张 **文本概率图**（值域 0–1）。官方实现（PaddleOCR/RapidOCR）走的是
 * OpenCV 的 `findContours` + `minAreaRect` + `unclip`；本插件面向**屏幕截图**这种轴对齐文本，
 * 用"阈值 → 连通域 → 外接矩形 → 外扩"就能拿到同样可用的行框，且不需要引入 OpenCV（原生依赖）。
 *
 * 已知取舍：不做旋转框（截图里的文字基本水平）、不做多边形 unclip（用固定比例外扩替代）。
 * 纯逻辑：输入概率图 Float32Array，输出矩形数组，单测可以直接造图验证。
 */

/** 概率图二值化阈值（DB 的标准取值）。 */
export const DET_BINARY_THRESHOLD = 0.3;
/** 一个连通域平均概率低于此值就丢弃（RapidOCR 的 box_thresh 同量级）。 */
export const DET_BOX_THRESHOLD = 0.5;
/** 外扩比例：横向 5%、纵向 15%（补偿 DB 训练时的区域收缩）。 */
export const DET_PAD_RATIO_X = 0.05;
export const DET_PAD_RATIO_Y = 0.15;
/** 少于这么多像素的连通域视为噪声。 */
export const DET_MIN_PIXELS = 4;
/** 概率图上的最小行高（像素），滤掉单像素噪点行。 */
export const DET_MIN_MAP_HEIGHT = 3;
/** 同一行的判定：纵向中心差小于两者较高者的这个比例。 */
export const LINE_MERGE_RATIO = 0.6;

/**
 * 阈值 + 8 邻域连通域 + 外接矩形。
 * @param {Float32Array|number[]} probability - 概率图（行优先，`width * height`）。
 * @param {number} width @param {number} height
 * @param {{binaryThreshold?: number, boxThreshold?: number, minPixels?: number, minMapHeight?: number}} [options]
 * @returns {Array<{x: number, y: number, width: number, height: number, score: number}>} 概率图坐标下的框。
 */
export function boxesFromProbability(probability, width, height, options = {}) {
  const binary = options.binaryThreshold ?? DET_BINARY_THRESHOLD;
  const boxThreshold = options.boxThreshold ?? DET_BOX_THRESHOLD;
  const minPixels = options.minPixels ?? DET_MIN_PIXELS;
  const minMapHeight = options.minMapHeight ?? DET_MIN_MAP_HEIGHT;
  const seen = new Uint8Array(width * height);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] === 1 || !(probability[start] > binary)) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let count = 0;
    let scoreSum = 0;
    while (stack.length > 0) {
      const current = stack.pop();
      const x = current % width;
      const y = (current - x) / width;
      count += 1;
      scoreSum += probability[current];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (seen[next] === 1 || !(probability[next] > binary)) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    if (count < minPixels) continue;
    const score = scoreSum / count;
    if (score < boxThreshold) continue;
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (boxHeight < minMapHeight) continue;
    boxes.push({ x: minX, y: minY, width: boxWidth, height: boxHeight, score });
  }
  return boxes;
}

/**
 * 把概率图坐标的框还原到原图坐标并做外扩。
 * @param {Array<{x: number, y: number, width: number, height: number, score: number}>} boxes
 * @param {{scaleX: number, scaleY: number, imageWidth: number, imageHeight: number}} mapping
 * @returns {Array<{x: number, y: number, width: number, height: number, score: number}>} 原图坐标的框（已夹进图内）。
 */
export function mapBoxesToImage(boxes, mapping) {
  const { scaleX, scaleY, imageWidth, imageHeight } = mapping;
  return boxes.map((box) => {
    const padX = Math.max(1, box.width * DET_PAD_RATIO_X);
    const padY = Math.max(1, box.height * DET_PAD_RATIO_Y);
    const left = Math.max(0, (box.x - padX) * scaleX);
    const top = Math.max(0, (box.y - padY) * scaleY);
    const right = Math.min(imageWidth, (box.x + box.width + padX) * scaleX);
    const bottom = Math.min(imageHeight, (box.y + box.height + padY) * scaleY);
    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      score: box.score,
    };
  });
}

/**
 * 按阅读顺序排列：先按纵向重叠聚成行（从上到下），行内再从左到右。
 * @param {Array<{x: number, y: number, width: number, height: number}>} boxes
 * @returns {Array<Array<{x: number, y: number, width: number, height: number}>>} 每行的框。
 */
export function groupIntoLines(boxes) {
  const lines = [];
  for (const box of [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const center = box.y + box.height / 2;
    const line = lines.find((candidate) => Math.abs(candidate.center - center) < Math.max(candidate.height, box.height) * LINE_MERGE_RATIO);
    if (line === undefined) {
      lines.push({ center, height: box.height, items: [box] });
      continue;
    }
    line.items.push(box);
    line.height = Math.max(line.height, box.height);
    line.center = (line.center * (line.items.length - 1) + center) / line.items.length;
  }
  lines.sort((a, b) => a.center - b.center);
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines.map((line) => line.items);
}
