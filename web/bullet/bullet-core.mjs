// Independent, offline prototype. H uses the OpenCV 0..179 convention.
export const defaults = Object.freeze({ lowerH: 35, lowerS: 10, lowerV: 10, upperH: 90, upperS: 255, upperV: 255,
  erosion: 1, dilation: 2, minArea: 20, gaussian: 5, green: 50, red: 40, minCount: 30 });
export const fields = [
  ['lowerH', 'H 下限', 0, 179], ['upperH', 'H 上限', 0, 179],
  ['lowerS', 'S 下限', 0, 255], ['upperS', 'S 上限', 0, 255],
  ['lowerV', 'V 下限', 0, 255], ['upperV', 'V 上限', 0, 255],
  ['erosion', '腐蚀次数', 0, 5], ['dilation', '膨胀次数', 0, 5],
  ['minArea', '最小区域面积 / px', 1, 2073600], ['gaussian', '高斯核（奇数）', 1, 15],
  ['green', '合格亮度 ≥', 0, 255], ['red', '不合格亮度 <', 0, 255], ['minCount', '单帧最少目标数', 1, 10000],
];
export function validateConfig(input) {
  const result = {};
  for (const [key, label, min, max] of fields) {
    const value = input?.[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min}–${max} 的整数`);
    result[key] = value;
  }
  if (result.gaussian % 2 !== 1) throw new Error('高斯核须为奇数');
  if (result.lowerS > result.upperS || result.lowerV > result.upperV) throw new Error('S / V 下限不可超过上限');
  if (result.red > result.green) throw new Error('不合格阈值不可超过合格阈值');
  return result;
}
export function parseConfig(text) {
  if (text.trimStart().startsWith('{')) {
    const data = JSON.parse(text);
    return validateConfig(data.parameters ?? data);
  }
  const rows = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^[\d.,\s+-]+$/.test(line)).map(line => line.split(',').map(Number));
  if (rows.length !== 2 || rows[0].length !== 10 || rows[1].length !== 3) throw new Error('需要 BulletFluor config.txt 或本工具导出的 JSON');
  const keys = ['lowerH','lowerS','lowerV','upperH','upperS','upperV','erosion','dilation','minArea','gaussian','green','red','minCount'];
  return validateConfig(Object.fromEntries(keys.map((key, index) => [key, rows.flat()[index]])));
}
export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = delta === 0 ? 0 : max === r ? 60 * ((g - b) / delta) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  if (h < 0) h += 360;
  return [Math.min(179, Math.round(h / 2)), max ? Math.round(delta * 255 / max) : 0, Math.round(max)];
}
function blur(data, width, height, size) {
  if (size === 1) return data;
  const radius = size >> 1, sigma = .3 * (radius - 1) + .8;
  const kernel = Array.from({ length: size }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma ** 2)));
  const sum = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  const temp = new Float32Array(data.length), out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    for (let k = -radius; k <= radius; k++) {
      const from = (y * width + Math.max(0, Math.min(width - 1, x + k))) * 4, weight = kernel[k + radius];
      for (let c = 0; c < 3; c++) temp[at + c] += data[from + c] * weight;
    }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    const rgb = [0, 0, 0];
    for (let k = -radius; k <= radius; k++) {
      const from = (Math.max(0, Math.min(height - 1, y + k)) * width + x) * 4, weight = kernel[k + radius];
      for (let c = 0; c < 3; c++) rgb[c] += temp[from + c] * weight;
    }
    for (let c = 0; c < 3; c++) out[at + c] = rgb[c];
  }
  return out;
}
function morphology(mask, width, height, dilate) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = dilate ? 0 : 1;
    outer: for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
      if (mask[yy * width + xx] === (dilate ? 1 : 0)) { value = dilate ? 1 : 0; break outer; }
    }
    out[y * width + x] = value;
  }
  return out;
}
export function classify(count, mean, config) {
  if (count < config.minCount) return '数量不足';
  if (mean >= config.green) return '合格';
  if (mean < config.red) return '不合格';
  return '待复核';
}
export function analyzeFrame(data, width, height, input) {
  const config = validateConfig(input);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 2073600 || data.length !== width * height * 4) throw new Error('图像尺寸无效或超过 2073600 像素');
  const pixels = width * height, rgb = blur(data, width, height, config.gaussian);
  let mask = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const [h, s, v] = rgbToHsv(rgb[i * 4], rgb[i * 4 + 1], rgb[i * 4 + 2]);
    const hue = config.lowerH <= config.upperH ? h >= config.lowerH && h <= config.upperH : h >= config.lowerH || h <= config.upperH;
    mask[i] = +(data[i * 4 + 3] > 0 && hue && s >= config.lowerS && s <= config.upperS && v >= config.lowerV && v <= config.upperV);
  }
  for (let i = 0; i < config.erosion; i++) mask = morphology(mask, width, height, false);
  for (let i = 0; i < config.dilation; i++) mask = morphology(mask, width, height, true);
  const visited = new Uint8Array(pixels), queue = new Int32Array(pixels), objects = [], sums = [0, 0], counts = [0, 0];
  for (let start = 0; start < pixels; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0, tail = 1, xMin = width, yMin = height, xMax = 0, yMax = 0, light = 0, xSum = 0;
    queue[0] = start; visited[start] = 1;
    while (head < tail) {
      const pos = queue[head++], x = pos % width, y = Math.floor(pos / width), at = pos * 4;
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); xSum += x;
      light += .299 * data[at] + .587 * data[at + 1] + .114 * data[at + 2];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, next = yy * width + xx;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && mask[next] && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
      }
    }
    if (tail < config.minArea) { for (let i = 0; i < tail; i++) mask[queue[i]] = 0; continue; }
    const side = xSum / tail < width / 2 ? 0 : 1, mean = light / tail;
    sums[side] += mean; counts[side]++;
    // Keep rendering and message sizes bounded even for noisy frames.
    if (objects.length < 2000) objects.push({ x: xMin, y: yMin, width: xMax - xMin + 1, height: yMax - yMin + 1, area: tail, mean, side });
  }
  const count = counts[0] + counts[1], mean = count ? (sums[0] + sums[1]) / count : 0;
  return { width, height, mask, objects, count, mean, leftCount: counts[0], rightCount: counts[1],
    leftMean: counts[0] ? sums[0] / counts[0] : 0, rightMean: counts[1] ? sums[1] / counts[1] : 0,
    verdict: classify(count, mean, config), boxesTruncated: count > objects.length };
}
