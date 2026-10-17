export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// crypto.randomUUID は https でしか使えないので自前で作る
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const TAG_COLORS = ['#f6a5b9', '#f9c58d', '#f7e08a', '#b5e0a8', '#9fd8d3', '#a9c8f2', '#c7b3ee', '#d9c2a7'];

const COVER_COLORS = ['#fbd5de', '#fde3c3', '#fbf0bf', '#d6efcf', '#cdeeea', '#d5e4f8', '#e4dbf7'];
export function coverColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COVER_COLORS[h % COVER_COLORS.length];
}

// サムネの大きさ。カードの最大表示幅（240px）の2.5倍。縦長のページなら 600×800 になる
export const THUMB_W = 600;
export const THUMB_H = 800;
export const THUMB_VERSION = 2;

// 画像を読み込む。写真の向き（EXIF）は反映済みの状態で返す
async function decodeImage(src) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(src, { imageOrientation: 'from-image' });
    } catch {}
  }
  const url = URL.createObjectURL(src);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawSmooth(source, w, h) {
  const c = canvasOf(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, w, h);
  return c;
}

// 半分ずつ縮めてから最後に目的の大きさへ。一気に縮めると文字がギザギザになるため
function stepDown(source, sw, sh, w, h) {
  let cur = source;
  let cw = sw;
  let ch = sh;
  while (cw / 2 >= w && ch / 2 >= h) {
    cw = Math.round(cw / 2);
    ch = Math.round(ch / 2);
    cur = drawSmooth(cur, cw, ch);
  }
  return drawSmooth(cur, w, h);
}

// 写真を maxW×maxH に収まるよう縮小して JPEG にする（拡大はしない）
export async function resizeImage(src, maxW, maxH = maxW, quality = 0.85) {
  const img = await decodeImage(src);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const scale = Math.min(1, maxW / sw, maxH / sh);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  let out;
  if (scale < 1 && typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    try {
      // 対応ブラウザ（Chrome など）では高品質な補間で一度に縮小できる
      const resized = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      if (resized.width === w && resized.height === h) out = drawSmooth(resized, w, h);
      resized.close?.();
    } catch {}
  }
  out ??= stepDown(img, sw, sh, w, h);
  img.close?.();
  return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('画像を作れませんでした'))), 'image/jpeg', quality));
}

export async function imageSize(blob) {
  const img = await decodeImage(blob);
  const size = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
  img.close?.();
  return size;
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(dataURL) {
  return (await fetch(dataURL)).blob();
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}
