// 自動修正（縦書き）の効果を、private/ の写真と正しい文章（.txt）で確かめる開発用の道具。
// 修正の前と後の一致率・誤りの数と、正しかった字を間違った字に変えてしまった件数を数える。
// 本の文章は画面とこの関数の戻り値にだけ出し、どこにも送らない。
import * as ocr from '../ocr.js';
import { resizeImage } from '../util.js';

// 最長共通部分列で対応づけ、a の各位置が b の字と一致したか（matched）と、誤りの箇所（連続した食い違いを1か所）を返す
export function diff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  }
  const matched = new Uint8Array(n);
  const places = [];
  let cur = null;
  const flush = () => { if (cur) { places.push(cur); cur = null; } };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { matched[i] = 1; flush(); i++; j++; continue; }
    cur ||= { got: '', want: '', at: i };
    if (j >= m || (i < n && dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1])) cur.got += a[i++];
    else cur.want += b[j++];
  }
  flush();
  return { lcs: dp[0], matched, places, score: (2 * dp[0]) / (n + m) };
}

const strip = (s) => s.replace(/\s/g, '');
const SMALL_PUNCT = new Set([...'っゃゅょぁぃぅぇぉッャュョァィゥェォ、。・「」']);
// 正しい文章の中の小書き文字・句読点のうち、読み取れたものの数（ルビの除去で消えていないかの確認用）
function smallKept(got, truth) {
  const d = diff(truth, got);
  let hit = 0;
  let total = 0;
  [...truth].forEach((c, j) => { if (SMALL_PUNCT.has(c)) { total++; hit += d.matched[j]; } });
  return `${hit}/${total}`;
}

// image：写真のファイル名（省くと name + '.jpg'）。clip：写真の一部だけを使うとき [x, y, 幅, 高さ]（画面の撮影から本の部分を切り出す用）
async function clipImage(blob, [x, y, w, h]) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

export async function check(name, { image = `${name}.jpg`, clip = null, size = 1568, pre = { crop: 'auto', deskew: true, binarize: 'sauvola', removeRuby: true } } = {}) {
  let img = await (await fetch(`../private/${image}`, { cache: 'no-store' })).blob();
  if (clip) img = await clipImage(img, clip);
  const truth = strip(await (await fetch(`../private/${name}.txt`, { cache: 'no-store' })).text());
  const stored = await resizeImage(img, size);
  const r = await ocr.recognize(stored, 'vertical', { pre });
  // 空白を除いた文章どうしで比べる。直した字の位置も空白を除いた位置に移す
  const pos = (s) => { const p = []; let k = 0; for (let i = 0; i < s.length; i++) p.push(/\s/.test(s[i]) ? -1 : k++); return p; };
  const before = strip(r.raw);
  const after = strip(r.text);
  const dB = diff(before, truth);
  const dA = diff(after, truth);
  // 直した字ごとに、元の字が正しかったか・直した字が正しいか
  const inv = new Map();
  r.rawMap.forEach((to, from) => { if (to >= 0) inv.set(to, from); });
  const pRaw = pos(r.raw);
  const pText = pos(r.text);
  const fixes = r.fixed.map(([at, from]) => {
    const rawAt = inv.get(at) ?? inv.get(at - 1); // 「——」の2字目は元の縦棒と同じ位置
    const b = pRaw[rawAt];
    const a = pText[at];
    return { from, to: r.text[at], wasRight: b >= 0 && !!dB.matched[b], nowRight: a >= 0 && !!dA.matched[a], context: r.text.slice(Math.max(0, at - 4), at + 4) };
  });
  return {
    name,
    before: { score: dB.score, errors: dB.places.length, places: dB.places, small: smallKept(before, truth) },
    after: { score: dA.score, errors: dA.places.length, places: dA.places, small: smallKept(after, truth) },
    fixes,
    harmed: fixes.filter((x) => x.wasRight && !x.nowRight),
    helped: fixes.filter((x) => !x.wasRight && x.nowRight),
    bars: r.bars, // 縦棒の長さ（字の大きさの何倍か）
    time: r.time,
    pre: r.pre,
  };
}
