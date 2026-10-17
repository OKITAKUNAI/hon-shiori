// 文章の表示（縦書き／横書き）と、写真の拡大表示。
// 文章は1文字ずつ <span data-i="位置"> に分けて表示する。位置（文字オフセット）は縦書きでも横書きでも同じなので、
// 表示を切り替えても選択範囲とマーカーはそのまま保てる。
import { esc } from './util.js';

// マーカーの色を、重なっても見分けられるよう帯に分けて塗る（縦書きは横方向、横書きは縦方向に分ける）
function paint(colors, vertical) {
  if (!colors.length) return '';
  if (colors.length === 1) return `background:${alpha(colors[0])}`;
  const step = 100 / colors.length;
  const stops = colors.map((c, k) => `${alpha(c)} ${(k * step).toFixed(1)}% ${((k + 1) * step).toFixed(1)}%`).join(',');
  return `background:linear-gradient(${vertical ? 'to left' : 'to bottom'},${stops})`;
}
const alpha = (c) => `color-mix(in srgb, ${c} 55%, transparent)`;

// marks: [{ id, start, end, color }]（位置不明のものは渡さない）
// selection: { start, end } 確定前の選択範囲 / anchor: 最初にタップした文字の位置
// low: 信頼度の低い文字の位置（Set）。薄い印を付ける
export function renderText(el, text, { vertical = true, marks = [], selection = null, anchor = null, low = null } = {}) {
  el.classList.toggle('vertical', vertical);
  el.classList.toggle('horizontal', !vertical);
  if (!text) {
    el.innerHTML = '<p class="text-empty">まだ文章がありません</p>';
    return;
  }
  // 文字ごとに、かかっているマーカーを求める（境目だけ調べるので重なりが多くても速い）
  const chars = [...text];
  const cover = Array.from({ length: chars.length }, () => []);
  // 位置は UTF-16 の単位（JS の文字列の添字）で記録するので、表示用の文字の位置と対応づける
  const unitToChar = [];
  let u = 0;
  chars.forEach((ch, i) => { for (let k = 0; k < ch.length; k++) unitToChar[u++] = i; });
  unitToChar[u] = chars.length;
  for (const m of marks) {
    const a = unitToChar[m.start];
    const b = unitToChar[m.end];
    for (let i = a; i < b; i++) cover[i].push(m);
  }
  const selA = selection ? unitToChar[selection.start] : -1;
  const selB = selection ? unitToChar[selection.end] : -1;
  const anchorChar = anchor == null ? -1 : unitToChar[anchor];

  let html = '';
  let unit = 0;
  chars.forEach((ch, i) => {
    const at = unit;
    unit += ch.length;
    if (ch === '\n') { html += `<br data-i="${at}">`; return; }
    const ms = cover[i];
    const cls = [];
    if (ms.length) cls.push('mk');
    if (i >= selA && i < selB) cls.push('sel');
    if (i === anchorChar) cls.push('anchor');
    if (low?.has(at)) cls.push('low');
    const style = paint(ms.map((m) => m.color), vertical);
    html += `<span data-i="${at}"${ms.length ? ` data-marks="${ms.map((m) => m.id).join(' ')}"` : ''}${cls.length ? ` class="${cls.join(' ')}"` : ''}${style ? ` style="${style}"` : ''}>${esc(ch)}</span>`;
  });
  el.innerHTML = html;
}

// 指で広げて拡大・ドラッグで移動・ダブルタップで拡大／元に戻す
export function makeZoomable(frame, img) {
  let scale = 1;
  let x = 0;
  let y = 0;
  const pts = new Map();
  let start = null;
  let lastTap = 0;
  const apply = () => {
    const maxX = (frame.clientWidth * (scale - 1)) / 2;
    const maxY = (frame.clientHeight * (scale - 1)) / 2;
    x = Math.max(-maxX, Math.min(maxX, x));
    y = Math.max(-maxY, Math.min(maxY, y));
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  frame.style.touchAction = 'none';
  frame.addEventListener('pointerdown', (e) => {
    frame.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()];
    start = { scale, x, y, p: p.map((q) => ({ ...q })), dist: p.length === 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0 };
    if (pts.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { scale = scale > 1 ? 1 : 2.5; x = 0; y = 0; apply(); }
      lastTap = now;
    }
  });
  frame.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()];
    if (p.length === 2 && start.dist) {
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      scale = Math.max(1, Math.min(6, (start.scale * d) / start.dist));
    } else if (p.length === 1 && start.p.length === 1) {
      x = start.x + (p[0].x - start.p[0].x);
      y = start.y + (p[0].y - start.p[0].y);
    }
    apply();
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    const p = [...pts.values()];
    start = { scale, x, y, p: p.map((q) => ({ ...q })), dist: 0 };
  };
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);
  frame.addEventListener('wheel', (e) => { e.preventDefault(); scale = Math.max(1, Math.min(6, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); apply(); }, { passive: false });
  return { reset: () => { scale = 1; x = 0; y = 0; apply(); } };
}
