// 文字認識の前処理：グレースケール化とコントラストの正規化。
// 前処理した画像は保存せず、認識のたびにその場で作る（保存する写真はカラーのまま）。
// 画面を止めないよう、使える端末では Web Worker（OffscreenCanvas）の中で処理する。
// （二値化と前後の見比べはフェーズ2で足す）

// 明るさの分布の両端それぞれ1%を切り捨て、残りを 0〜255 に引き伸ばす
const CLIP = 0.01;

// RGBA の画素をグレースケール化してコントラストを正規化する（その場で書き換える）
export function normalizeGray(data) {
  const n = data.length / 4;
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114 + 500) / 1000 | 0;
    data[p] = y;
    hist[y]++;
  }
  const cut = Math.floor(n * CLIP);
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) <= cut; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) <= cut; hi--);
  if (hi <= lo) { lo = 0; hi = 255; }
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = lut[data[p]];
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  return { lo, hi };
}

// ---- Web Worker として動かすとき ----
const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (isWorker) {
  self.onmessage = async (e) => {
    const { id, blob } = e.data;
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      bmp.close();
      const img = g.getImageData(0, 0, canvas.width, canvas.height);
      const range = normalizeGray(img.data);
      g.putImageData(img, 0, 0);
      const out = await canvas.convertToBlob({ type: 'image/png' });
      self.postMessage({ id, blob: out, range });
    } catch (err) {
      self.postMessage({ id, error: String(err?.message || err) });
    }
  };
}

// ---- 画面側から呼ぶ ----
let worker;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (worker !== undefined) return worker;
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('no OffscreenCanvas');
    worker = new Worker(new URL('./preprocess.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data);
    };
    worker.onerror = () => { worker = null; };
  } catch {
    worker = null;
  }
  return worker;
}

// Worker が使えない端末では、画面側で同じ処理をする
async function onMainThread(blob) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const range = normalizeGray(img.data);
  g.putImageData(img, 0, 0);
  return { blob: await new Promise((r) => canvas.toBlob(r, 'image/png')), range };
}

export async function preprocessForOcr(blob) {
  const w = getWorker();
  if (!w) return onMainThread(blob);
  const id = ++seq;
  try {
    return await new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, blob });
    });
  } catch {
    return onMainThread(blob);
  }
}
