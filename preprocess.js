// 文字認識の前処理。前処理した画像は保存せず、認識のたびにその場で作る（保存する写真はカラーのまま）。
// 画面を止めないよう、使える端末では Web Worker（OffscreenCanvas）の中で処理する。
//
// 処理の順番：
//   1. 本文の切り抜き   四隅の指定（ocrCrop）があればそれを長方形に引き伸ばす。なければ本文の範囲を自動で推定する
//                       （柱・ページ番号・ページの外を除く）
//   2. コントラスト調整 グレースケール化し、明るさの分布の両端1%を切って引き伸ばす
//   3. 傾き補正         行が垂直（横書きなら水平）になる角度を探して回転する
//   4. 二値化           大津の方法（全体で1つの閾値）か Sauvola 法（場所ごとの閾値。明るさのむらに強い）
//   5. ルビの除去       行の帯（黒画素の分布）を求め、本文の行より明らかに細い帯（ルビ・傍点）を白で塗る
//
// 画像は「幅 w・高さ h・明るさの配列（0=黒〜255=白）」の形で扱う。ink（二値）は 1=黒（文字）、0=白。

// ---------- 基本の処理 ----------

export function toGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114 + 500) / 1000;
  return g;
}

// 明るさの分布の両端それぞれ1%を切り捨て、残りを 0〜255 に引き伸ばす（その場で書き換える）
export function normalizeContrast(g, clip = 0.01) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const cut = Math.floor(g.length * clip);
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) <= cut; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) <= cut; hi--);
  if (hi <= lo) return { lo: 0, hi: 255 };
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  for (let i = 0; i < g.length; i++) g[i] = lut[g[i]];
  return { lo, hi };
}

// 互換用（RGBA をその場でグレー化・正規化する）
export function normalizeGray(data) {
  const n = data.length / 4;
  const g = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) g[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114 + 500) / 1000;
  const range = normalizeContrast(g);
  for (let i = 0, p = 0; i < n; i++, p += 4) { data[p] = data[p + 1] = data[p + 2] = g[i]; data[p + 3] = 255; }
  return range;
}

// 大津の方法：全体で1つの閾値を決める
export function otsuThreshold(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let t = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = v; }
  }
  return t;
}

export function binarizeOtsu(g) {
  const t = otsuThreshold(g);
  const ink = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) ink[i] = g[i] <= t ? 1 : 0;
  return ink;
}

// Sauvola 法：周りの平均 m と標準偏差 s から、場所ごとに閾値 T = m × (1 + k × (s / R − 1)) を決める。
// 影や照明のむらがあっても、その場所の明るさに合わせて文字を拾える
export function binarizeSauvola(g, w, h, { win = 0, k = 0.3, R = 128 } = {}) {
  const size = win || (Math.max(15, Math.round(Math.min(w, h) / 24)) | 1);
  const r = size >> 1;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      rs += v;
      rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s1 = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0];
      const s2 = sq[y1 * W + x1] - sq[y0 * W + x1] - sq[y1 * W + x0] + sq[y0 * W + x0];
      const m = s1 / n;
      const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
      ink[y * w + x] = g[y * w + x] <= m * (1 + k * (sd / R - 1)) ? 1 : 0;
    }
  }
  return ink;
}

// 縮小（平均）。解析は小さい画像で行って速くする
export function downscale(g, w, h, maxSide) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  if (s === 1) return { g, w, h, s: 1 };
  const W = Math.max(1, Math.round(w * s));
  const H = Math.max(1, Math.round(h * s));
  const out = new Uint8ClampedArray(W * H);
  for (let Y = 0; Y < H; Y++) {
    const ya = Math.floor(Y / s);
    const yb = Math.min(h, Math.max(ya + 1, Math.floor((Y + 1) / s)));
    for (let X = 0; X < W; X++) {
      const xa = Math.floor(X / s);
      const xb = Math.min(w, Math.max(xa + 1, Math.floor((X + 1) / s)));
      let acc = 0;
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) acc += g[y * w + x];
      out[Y * W + X] = acc / ((yb - ya) * (xb - xa));
    }
  }
  return { g: out, w: W, h: H, s };
}

// 範囲の外は、いちばん近い端の画素で埋める（白で埋めると、境目が線として文字に見えてしまうため）
function bilinear(g, w, h, x, y) {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = g[y0 * w + x0] * (1 - fx) + g[y0 * w + x1] * fx;
  const b = g[y1 * w + x0] * (1 - fx) + g[y1 * w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

export function cropRect(g, w, h, box) {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(w, Math.ceil(box.x1));
  const y1 = Math.min(h, Math.ceil(box.y1));
  const W = Math.max(1, x1 - x0);
  const H = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) out.set(g.subarray((y + y0) * w + x0, (y + y0) * w + x0 + W), y * W);
  return { g: out, w: W, h: H };
}

// 四隅（左上・右上・右下・左下）で囲んだ範囲を長方形に引き伸ばす（射影変換）
export function warpQuad(g, w, h, quad) {
  const [tl, tr, br, bl] = quad;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const W = Math.max(8, Math.round((dist(tl, tr) + dist(bl, br)) / 2));
  const H = Math.max(8, Math.round((dist(tl, bl) + dist(tr, br)) / 2));
  const Hm = homography([[0, 0], [W, 0], [W, H], [0, H]], quad); // 出力の座標 → 元の写真の座標
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Hm[6] * x + Hm[7] * y + 1;
      out[y * W + x] = bilinear(g, w, h, (Hm[0] * x + Hm[1] * y + Hm[2]) / d, (Hm[3] * x + Hm[4] * y + Hm[5]) / d);
    }
  }
  return { g: out, w: W, h: H };
}

// 4組の対応点から射影変換の係数を求める（8元連立方程式をガウスの消去法で解く）
function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[8] / row[i]);
}

// 角度 deg だけ回転する（はみ出さないよう広げ、余白は端の画素で埋める）
export function rotateGray(g, w, h, deg) {
  if (!deg) return { g, w, h };
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const W = Math.ceil(Math.abs(w * c) + Math.abs(h * s));
  const H = Math.ceil(Math.abs(w * s) + Math.abs(h * c));
  const cx = w / 2;
  const cy = h / 2;
  const CX = W / 2;
  const CY = H / 2;
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - CX;
      const dy = y - CY;
      out[y * W + x] = bilinear(g, w, h, cx + dx * c - dy * s, cy + dx * s + dy * c);
    }
  }
  return { g: out, w: W, h: H };
}

// ---------- 解析 ----------

// 行（縦書きなら x ごと、横書きなら y ごと）の黒画素の数
export function profile(ink, w, h, alongX, box = { x0: 0, y0: 0, x1: w, y1: h }) {
  const n = alongX ? w : h;
  const p = new Float64Array(n);
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) if (ink[y * w + x]) p[alongX ? x : y]++;
  }
  return p;
}

// 分布から「黒画素のある連続した区間（帯）」を取り出す。間が maxGap 以下の帯はつなげる
export function findBands(p, minInk = 1, maxGap = 0) {
  const bands = [];
  let cur = null;
  for (let i = 0; i < p.length; i++) {
    if (p[i] >= minInk) {
      if (cur && i - cur.b - 1 <= maxGap) { cur.b = i; cur.ink += p[i]; } else { cur = { a: i, b: i, ink: p[i] }; bands.push(cur); }
    }
  }
  return bands.map((x) => ({ ...x, width: x.b - x.a + 1 }));
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// 間が maxGap 以下の帯をつなげたかたまりのうち、黒画素が最も多いものを返す
function largestCluster(p, minInk, maxGap) {
  return findBands(p, minInk, maxGap).sort((a, b) => b.ink - a.ink)[0] || null;
}

// 行の幅（縦書きなら1行の横幅。≒文字の大きさ）を見積もる
export function estimateLineWidth(ink, w, h, vertical = true, box = { x0: 0, y0: 0, x1: w, y1: h }) {
  const bands = findBands(profile(ink, w, h, vertical, box), 2, 0);
  if (!bands.length) return 0;
  const inkMed = median(bands.map((b) => b.ink));
  return median(bands.filter((b) => b.ink >= inkMed * 0.5).map((b) => b.width));
}

// 本文の範囲を推定する（柱・ページ番号・ページの外を除く）。縮小した二値画像で調べる。
// 行の幅を物差しにして、行の方向に大きく空いたところ（柱との間）と、行の並ぶ方向に大きく空いたところ
// （ページの余白・ページの外）で区切り、黒画素が最も多いかたまりを本文とする
export function estimateTextBox(ink, w, h, vertical = true) {
  let box = { x0: 0, y0: 0, x1: w, y1: h };
  const lw = Math.max(4, estimateLineWidth(ink, w, h, vertical));
  for (let round = 0; round < 2; round++) {
    // 行の方向（縦書きなら上下）：文字の大きさの半分より大きいすき間で切る（柱・ページ番号を外す）
    const along = largestCluster(profile(ink, w, h, !vertical, box), 2, Math.round(lw * 0.5));
    if (along) box = vertical ? { ...box, y0: along.a, y1: along.b + 1 } : { ...box, x0: along.a, x1: along.b + 1 };
    // 行の並ぶ方向（縦書きなら左右）：行の幅の1.2倍より大きいすき間で切る（ページの外・影を外す）
    const across = largestCluster(profile(ink, w, h, vertical, box), 2, Math.round(lw * 1.2));
    if (across) box = vertical ? { ...box, x0: across.a, x1: across.b + 1 } : { ...box, y0: across.a, y1: across.b + 1 };
  }
  // 少し余白を付ける
  // 句読点は文字の枠の外へ少しはみ出すので、余白は文字の大きさの半分ほど付ける
  const padX = Math.round(lw * 0.5) + 2;
  const padY = Math.round(lw * 0.6) + 2;
  return { x0: Math.max(0, box.x0 - padX), y0: Math.max(0, box.y0 - padY), x1: Math.min(w, box.x1 + padX), y1: Math.min(h, box.y1 + padY) };
}

// 行の傾きを推定する。黒画素を少しずつ斜めにずらして、行の分布が最もくっきりする角度を探す
// 戻り値は「この角度だけ回転すれば行がまっすぐになる」角度（rotateGray にそのまま渡せる）
export function estimateSkew(ink, w, h, vertical = true, { range = 6, maxPoints = 60000 } = {}) {
  const pts = [];
  let count = 0;
  for (let i = 0; i < ink.length; i++) if (ink[i]) count++;
  const step = Math.max(1, Math.floor(count / maxPoints));
  let k = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink[y * w + x] && k++ % step === 0) pts.push(x, y);
  if (pts.length < 200) return 0;
  const cx = w / 2;
  const cy = h / 2;
  const n = vertical ? w : h;
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const hist = new Float64Array(n + 2 * Math.ceil(Math.abs(t) * Math.max(w, h)) + 2);
    const off = (hist.length - n) / 2;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] - cx;
      const y = pts[i + 1] - cy;
      const v = vertical ? x - y * t : y + x * t;
      hist[Math.round(v + n / 2 + off)]++;
    }
    let s = 0;
    for (let i = 0; i < hist.length; i++) s += hist[i] * hist[i];
    return s;
  };
  let best = 0;
  let bestScore = -1;
  for (let d = -range; d <= range + 1e-9; d += 0.5) { const s = score(d); if (s > bestScore) { bestScore = s; best = d; } }
  const coarse = best;
  for (let d = coarse - 0.5; d <= coarse + 0.5 + 1e-9; d += 0.05) { const s = score(d); if (s > bestScore) { bestScore = s; best = d; } }
  // 斜めにずらす向きと回転の向きは逆なので、符号を反転して返す
  return -Math.round(best * 100) / 100 || 0;
}

// ルビ・傍点の除去：行の帯を求め、本文の行の幅より明らかに細く、本文の行に隣り合う帯を白で塗る。
// 縦書きのルビは本文の行の右、横書きは上にある。本文の行の中の小さい文字や句読点は本文の帯の中にあるので消えない
export function removeRuby(ink, w, h, vertical = true, { ratio = 0.6 } = {}) {
  const p = profile(ink, w, h, vertical);
  const span = vertical ? h : w;
  const raw = findBands(p, Math.max(1, Math.round(span * 0.003)), 0);
  if (raw.length < 2) return { lineWidth: 0, removed: [] };
  // 本文の行：黒画素が多い帯の幅の中央値を行の幅とする
  const inkMed = median(raw.map((b) => b.ink));
  const lineWidth = median(raw.filter((b) => b.ink >= inkMed * 0.5).map((b) => b.width));

  // ルビが本文に接していたり、とじ目の近くで行の間が詰まっていたりして、いくつかの行（とルビ）が1つの帯になっているときは、
  // 「左右の山のうち低いほうの半分以下まで下がる谷」のうち、いちばん深いところで分けることを繰り返す
  const peakOf = (a, b) => { let m = 0; for (let i = a; i <= b; i++) m = Math.max(m, p[i]); return m; };
  const pieces = [];
  const splitBand = (a, b) => {
    if (b - a + 1 > lineWidth * 1.3) {
      let cut = -1;
      let best = 1;
      for (let i = a + 3; i <= b - 3; i++) {
        if (!(p[i] <= p[i - 1] && p[i] <= p[i + 1])) continue;
        const depth = p[i] / Math.max(1, Math.min(peakOf(a, i), peakOf(i, b)));
        if (depth <= 0.5 && depth < best) { best = depth; cut = i; }
      }
      if (cut > 0) { splitBand(a, cut - 1); splitBand(cut + 1, b); return; }
    }
    pieces.push({ a, b });
  };
  for (const r of raw) splitBand(r.a, r.b);

  // 分けた部分ごとに、山の高さの半分以上ある幅（芯の幅）と山の高さを求める
  for (const x of pieces) {
    x.peak = peakOf(x.a, x.b);
    let lo = x.b;
    let hi = x.a;
    for (let i = x.a; i <= x.b; i++) if (p[i] >= x.peak / 2) { lo = Math.min(lo, i); hi = Math.max(hi, i); }
    x.core = hi - lo + 1;
  }
  // 本文の行：芯の幅が行の幅の6割以上、または山が本文の行の山の6割以上（ルビの列は文字がまばらで山が低い）
  const bodyPeak = median(pieces.filter((x) => x.core >= lineWidth * ratio).map((x) => x.peak)) || 1;
  const isBody = (x) => x.core >= lineWidth * ratio || x.peak >= bodyPeak * 0.6;
  const removed = [];
  pieces.forEach((x, i) => {
    if (isBody(x)) return;
    // 隣（すき間が行の幅の8割以内）に本文の行があるものだけをルビとみなす
    const near = pieces.some((o, j) => j !== i && isBody(o) && Math.min(Math.abs(o.a - x.b), Math.abs(x.a - o.b)) <= lineWidth * 0.8);
    if (!near) return;
    removed.push({ a: x.a, b: x.b });
    if (vertical) { for (let y = 0; y < h; y++) for (let xx = x.a; xx <= x.b; xx++) ink[y * w + xx] = 0; } else { for (let y = x.a; y <= x.b; y++) ink.fill(0, y * w, y * w + w); }
  });
  return { lineWidth, removed };
}

// 本文の範囲を、元の写真の上の四隅（左上・右上・右下・左下。画素の座標）として推定する。
// 写真が傾いていると、柱と本文の間のすき間が分布に現れないので、先に傾きを直した画像で範囲を探し、
// 見つけた長方形の四隅を元の写真の座標に戻す（ページの傾きに沿った四角形になる）
export function autoQuad(g, w, h, vertical = true) {
  const small = downscale(g, w, h, 800);
  const angle = estimateSkew(binarizeSauvola(small.g, small.w, small.h), small.w, small.h, vertical);
  const rot = rotateGray(small.g, small.w, small.h, angle);
  const b = estimateTextBox(binarizeSauvola(rot.g, rot.w, rot.h), rot.w, rot.h, vertical);
  const t = (angle * Math.PI) / 180;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  // rotateGray と同じ対応：回転後の (x, y) → 回転前の座標
  const back = (x, y) => {
    const dx = x - rot.w / 2;
    const dy = y - rot.h / 2;
    return [(small.w / 2 + dx * c - dy * sn) / small.s, (small.h / 2 + dx * sn + dy * c) / small.s];
  };
  const clamp = ([x, y]) => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))];
  return { angle, quad: [back(b.x0, b.y0), back(b.x1, b.y0), back(b.x1, b.y1), back(b.x0, b.y1)].map(clamp) };
}

// ---------- まとめて実行 ----------

// options:
//   crop      null（切り抜かない）／'auto'（自動推定）／[[x,y]×4]（四隅。0〜1 の割合）
//   deskew    true で傾き補正
//   binarize  'none' | 'otsu' | 'sauvola'
//   removeRuby true でルビ・傍点を除去
//   vertical  true で縦書き
//   debug     true で、ルビとして消した部分を赤で示した確認用の画像も返す
// 戻り値：{ g, w, h, ink（二値化したとき）, info }
export function runPipeline(g, w, h, options = {}) {
  const o = { crop: null, deskew: false, binarize: 'none', removeRuby: false, vertical: true, ...options };
  const info = { size: [w, h] };

  // 1. 切り抜き
  if (Array.isArray(o.crop)) {
    const quad = o.crop.map(([x, y]) => [x * w, y * h]);
    ({ g, w, h } = warpQuad(g, w, h, quad));
    info.crop = 'manual';
  } else if (o.crop === 'auto') {
    // 傾きを直した向きで本文の範囲を探し、その四角形を長方形に引き伸ばす（傾きもここで直る）
    const a = autoQuad(g, w, h, o.vertical);
    info.crop = 'auto';
    info.quad = a.quad.map(([x, y]) => [+(x / w).toFixed(4), +(y / h).toFixed(4)]);
    info.autoAngle = a.angle;
    ({ g, w, h } = warpQuad(g, w, h, a.quad));
  }

  // 2. コントラスト調整
  info.range = normalizeContrast(g);

  // 3. 傾き補正（自動の切り抜きで直したあとに残ったぶんも、ここで直す）
  if (o.deskew) {
    const small = downscale(g, w, h, 900);
    const angle = estimateSkew(binarizeSauvola(small.g, small.w, small.h), small.w, small.h, o.vertical);
    info.angle = angle;
    if (Math.abs(angle) >= 0.1) ({ g, w, h } = rotateGray(g, w, h, angle));
  }

  // 4. 二値化（ルビの除去にも二値画像を使う）
  let ink = null;
  if (o.binarize === 'otsu') ink = binarizeOtsu(g);
  else if (o.binarize === 'sauvola' || o.removeRuby) ink = binarizeSauvola(g, w, h);
  info.binarize = o.binarize;

  // 5. ルビの除去
  let before = null;
  if (o.removeRuby && ink) {
    if (o.debug) before = ink.slice();
    const r = removeRuby(ink, w, h, o.vertical);
    info.lineWidth = r.lineWidth;
    info.rubyBands = r.removed.length;
    if (o.binarize === 'none') {
      // 二値化しない設定のときは、ルビの部分だけ明るさの画像で白くする
      for (const b of r.removed) {
        if (o.vertical) { for (let y = 0; y < h; y++) for (let x = b.a; x <= b.b; x++) g[y * w + x] = 255; } else { for (let y = b.a; y <= b.b; y++) g.fill(255, y * w, y * w + w); }
      }
    }
  }
  return { g, w, h, ink: o.binarize === 'none' ? null : ink, before, info };
}

// 結果を RGBA の画素にする（二値化したときは白黒。debug のときはルビとして消した部分を赤で示す）
export function toRGBA({ g, w, h, ink, before }) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    let v = ink ? (ink[i] ? 0 : 255) : g[i];
    out[p] = out[p + 1] = out[p + 2] = v;
    out[p + 3] = 255;
    if (before && before[i] && !ink?.[i]) { out[p] = 230; out[p + 1] = 40; out[p + 2] = 40; }
  }
  return out;
}

// ---------- 写真（Blob）から実行 ----------

async function run(blob, options, makeCanvas, encode) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const c = makeCanvas(bmp.width, bmp.height);
  const cg = c.getContext('2d', { willReadFrequently: true });
  cg.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = cg.getImageData(0, 0, c.width, c.height);
  const res = runPipeline(toGray(img.data, c.width, c.height), c.width, c.height, options);
  const outCanvas = makeCanvas(res.w, res.h);
  const og = outCanvas.getContext('2d');
  og.putImageData(new ImageData(toRGBA({ ...res, before: null }), res.w, res.h), 0, 0);
  const out = { blob: await encode(outCanvas), range: res.info.range, info: res.info };
  if (options?.debug && res.before) {
    const dc = makeCanvas(res.w, res.h);
    dc.getContext('2d').putImageData(new ImageData(toRGBA(res), res.w, res.h), 0, 0);
    out.debugBlob = await encode(dc);
  }
  return out;
}

const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (isWorker) {
  self.onmessage = async (e) => {
    const { id, blob, options } = e.data;
    try {
      const out = await run(blob, options, (w, h) => new OffscreenCanvas(w, h), (c) => c.convertToBlob({ type: 'image/png' }));
      self.postMessage({ id, ...out });
    } catch (err) {
      self.postMessage({ id, error: String(err?.message || err) });
    }
  };
}

// ---------- 画面側から呼ぶ ----------
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

const onMainThread = (blob, options) => run(
  blob, options,
  (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
  (c) => new Promise((r) => c.toBlob(r, 'image/png')),
);

// options を省くと、コントラスト調整だけを行う（以前と同じ）
export async function preprocessForOcr(blob, options = {}) {
  const w = getWorker();
  if (!w) return onMainThread(blob, options);
  const id = ++seq;
  try {
    return await new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, blob, options });
    });
  } catch {
    return onMainThread(blob, options);
  }
}

// 写真から本文の範囲（四隅。0〜1 の割合）を自動で推定する。読み取り範囲の画面の初期値に使う
export async function suggestCrop(blob, vertical = true) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * scale);
  const H = Math.round(bmp.height * scale);
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const cg = c.getContext('2d', { willReadFrequently: true });
  cg.drawImage(bmp, 0, 0, W, H);
  bmp.close?.();
  const { quad } = autoQuad(toGray(cg.getImageData(0, 0, W, H).data, W, H), W, H, vertical);
  return quad.map(([x, y]) => [+(x / W).toFixed(4), +(y / H).toFixed(4)]);
}
