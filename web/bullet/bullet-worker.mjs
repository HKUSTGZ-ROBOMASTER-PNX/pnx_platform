import { analyzeFrame } from './bullet-core.mjs';
self.onmessage = ({ data }) => {
  const start = performance.now();
  try {
    const result = analyzeFrame(new Uint8ClampedArray(data.buffer), data.width, data.height, data.config);
    self.postMessage({ id: data.id, result, elapsed: performance.now() - start }, [result.mask.buffer]);
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
