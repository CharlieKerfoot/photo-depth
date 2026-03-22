import * as ort from 'onnxruntime-web';

const MODEL_URL = '/model/depth_anything_v2_large_q4f16.onnx';
const MODEL_FALLBACK_URL = '/model/depth_anything_v2_base_q4.onnx';
const MODEL_SIZE = 518;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let session: ort.InferenceSession | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;

type ProgressCallback = (loaded: number, total: number) => void;

async function fetchModelWithProgress(
  url: string,
  onProgress?: ProgressCallback,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch model: ${response.status}`);

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  if (!response.body || !total) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

export async function initSession(
  onProgress?: ProgressCallback,
): Promise<void> {
  if (session) return;
  if (sessionPromise) {
    await sessionPromise;
    return;
  }

  sessionPromise = (async () => {
    let modelBuffer: ArrayBuffer;
    try {
      modelBuffer = await fetchModelWithProgress(MODEL_URL, onProgress);
    } catch {
      modelBuffer = await fetchModelWithProgress(MODEL_FALLBACK_URL, onProgress);
    }

    try {
      return await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['webgpu', 'wasm'],
      });
    } catch {
      return await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
      });
    }
  })();

  session = await sessionPromise;
}

export function preprocessImage(
  img: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): Float32Array {
  const canvas = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const imageData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
  const pixels = imageData.data;

  const chw = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  const pixelCount = MODEL_SIZE * MODEL_SIZE;

  for (let i = 0; i < pixelCount; i++) {
    const r = pixels[i * 4] / 255;
    const g = pixels[i * 4 + 1] / 255;
    const b = pixels[i * 4 + 2] / 255;
    chw[i] = (r - MEAN[0]) / STD[0];
    chw[pixelCount + i] = (g - MEAN[1]) / STD[1];
    chw[2 * pixelCount + i] = (b - MEAN[2]) / STD[2];
  }

  return chw;
}

export function bilinearResize(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const dst = new Float32Array(dstW * dstH);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const srcY = y * yRatio;
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const fy = srcY - y0;

    for (let x = 0; x < dstW; x++) {
      const srcX = x * xRatio;
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const fx = srcX - x0;

      const v00 = src[y0 * srcW + x0];
      const v10 = src[y0 * srcW + x1];
      const v01 = src[y1 * srcW + x0];
      const v11 = src[y1 * srcW + x1];

      dst[y * dstW + x] =
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy;
    }
  }

  return dst;
}

export async function estimateDepth(
  img: HTMLImageElement,
  width: number,
  height: number,
): Promise<{ depthMap: Float32Array; inferenceMs: number }> {
  if (!session) throw new Error('Session not initialized');

  const chw = preprocessImage(img, width, height);
  const tensor = new ort.Tensor('float32', chw, [1, 3, MODEL_SIZE, MODEL_SIZE]);

  const t0 = performance.now();
  const results = await session.run({ pixel_values: tensor });
  const inferenceMs = performance.now() - t0;

  const outputKey = Object.keys(results)[0];
  const outputData = results[outputKey].data as Float32Array;

  // Min-max normalize to [0, 1]
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < outputData.length; i++) {
    if (outputData[i] < min) min = outputData[i];
    if (outputData[i] > max) max = outputData[i];
  }
  const range = max - min || 1;
  const normalized = new Float32Array(outputData.length);
  for (let i = 0; i < outputData.length; i++) {
    normalized[i] = (outputData[i] - min) / range;
  }

  // Bilinear resize from MODEL_SIZE x MODEL_SIZE to original dimensions
  const depthMap = bilinearResize(normalized, MODEL_SIZE, MODEL_SIZE, width, height);

  return { depthMap, inferenceMs };
}
