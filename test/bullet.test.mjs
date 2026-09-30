import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig, parseConfig, rgbToHsv, analyzeFrame, classify } from '../web/bullet/bullet-core.mjs';

const simple = { ...defaults, gaussian: 1, erosion: 0, dilation: 0, minArea: 2, minCount: 1 };
function fixture(width = 20, height = 10) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height, rect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set([...color, 255], (yy * width + xx) * 4);
  }, analyze(config = simple) { return analyzeFrame(data, width, height, config); } };
}
test('original text configuration and JSON round trip; malformed values rejected', () => {
  assert.deepEqual(parseConfig('分析参数: ...\n35,10,10,90,255,255,1,2,20,5\n亮度阈值: ...\n50,40,30\n'), defaults);
  assert.deepEqual(parseConfig(JSON.stringify({ parameters: defaults })), defaults);
  for (const change of [{ gaussian: 2 }, { erosion: -1 }, { minArea: NaN }, { lowerS: 256 }, { lowerV: 90, upperV: 30 }, { red: 60, green: 40 }, { minCount: '' }]) assert.throws(() => validateConfig({ ...defaults, ...change }));
  assert.throws(() => parseConfig('35,10,10\n50,40,30'));
});
test('OpenCV hue scale and wrapped hue interval', () => {
  assert.deepEqual(rgbToHsv(0, 255, 0), [60, 255, 255]);
  const frame = fixture(); frame.rect(2, 2, 2, 2, [255, 0, 0]);
  assert.equal(frame.analyze().count, 0);
  assert.equal(frame.analyze({ ...simple, lowerH: 170, upperH: 10 }).count, 1);
});
test('separated objects, exact grayscale means, side assignment and noise rejection', () => {
  const frame = fixture(); frame.rect(2, 2, 3, 3, [0, 200, 0]); frame.rect(14, 2, 3, 3, [0, 40, 0]); frame.rect(0, 0, 1, 1, [0, 255, 0]);
  const result = frame.analyze();
  assert.equal(result.count, 2); assert.equal(result.leftCount, 1); assert.equal(result.rightCount, 1);
  assert.ok(Math.abs(result.leftMean - 117.4) < 1e-8); assert.ok(Math.abs(result.rightMean - 23.48) < 1e-8);
  assert.equal(result.mask[0], 0); assert.equal(result.objects[0].area, 9);
});
test('morphology removes isolated pixels and expands a target; gaussian preserves uniform region', () => {
  const frame = fixture(); frame.rect(2, 2, 1, 1, [0, 200, 0]);
  assert.equal(frame.analyze({ ...simple, erosion: 1 }).count, 0);
  assert.equal(frame.analyze({ ...simple, dilation: 1 }).objects[0].area, 9);
  const solid = fixture(12, 12); solid.rect(0, 0, 12, 12, [0, 200, 0]);
  assert.equal(solid.analyze({ ...simple, gaussian: 5 }).objects[0].area, 144);
});
test('diagonal connectivity, image edges, empty frame and input limits', () => {
  const frame = fixture(); frame.rect(0, 0, 1, 1, [0, 100, 0]); frame.rect(1, 1, 1, 1, [0, 100, 0]);
  assert.equal(frame.analyze().count, 1);
  assert.equal(fixture().analyze().verdict, '数量不足');
  assert.throws(() => analyzeFrame(new Uint8Array(4), 1921, 1080, simple));
});
test('minimum frame count takes precedence; threshold boundary and review band', () => {
  assert.equal(classify(29, 200, defaults), '数量不足');
  assert.equal(classify(30, 50, defaults), '合格');
  assert.equal(classify(30, 40, defaults), '待复核');
  assert.equal(classify(30, 39.99, defaults), '不合格');
});
