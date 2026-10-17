// テスト用の「ルビ付き縦書きの本のページ」を canvas で描く（文章はこのテストのために書いたもの）。
// 実際の文庫本の写真で起きたこと（ルビ、柱とページ番号、ページの外の暗い部分、傾き、左下の影）を再現する。

export const RUBY_LINES = [
  // [本文, [[ルビを付ける文字の位置, 文字数, ルビ], …]]
  ['小さな約束をした日のことを、', [[3, 2, 'やくそく']]],
  ['わたしはいまでもよく覚えている。', [[10, 1, 'おぼ']]],
  ['窓の外では雨がやみかけていて、', [[0, 1, 'まど']]],
  ['ちょっとだけ遠回りして帰った。', [[6, 2, 'とおまわ'], [11, 1, 'かえ']]],
  ['あの頃の自分は、未来というものを', [[2, 1, 'ころ'], [8, 2, 'みらい']]],
  ['まっすぐに信じきっていたのだ。', [[5, 1, 'しん']]],
  ['しゃべらずに歩いた坂の途中で、', [[9, 1, 'さか'], [11, 2, 'とちゅう']]],
  ['ふいに鐘の音がひびいてきた。', [[3, 1, 'かね']]],
];
export const RUBY_TRUTH = RUBY_LINES.map(([t]) => t).join('');
export const RUBY_STRINGS = RUBY_LINES.flatMap(([, rs]) => rs.map((r) => r[2]));

const SMALL = new Set([...'っゃゅょぁぃぅぇぉッャュョ']);
const PUNCT = new Set([...'、。']);

// 戻り値：{ canvas, truth, body:{x0,y0,x1,y1}, headerBottom, pageLeft, ruby:[{x0,y0,x1,y1}], cells:[{x0,y0,x1,y1,ch}] }
// skew（度）・shadow・outside を付けると、そのぶん難しくなる。body / ruby / cells は傾ける前の座標
export function drawRubyPage({ w = 1500, h = 2000, skew = 0, shadow = false, outside = false, header = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const pageLeft = outside ? Math.round(w * 0.12) : 0;

  // ページの外（暗い布）
  g.fillStyle = '#4b4a48';
  g.fillRect(0, 0, w, h);
  if (outside) {
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},0.08)`;
      g.fillRect(Math.random() * pageLeft, Math.random() * h, 3, 3);
    }
  }
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate((skew * Math.PI) / 180);
  g.translate(-w / 2, -h / 2);
  g.fillStyle = '#efebe1';
  g.fillRect(pageLeft, -h * 0.05, w * 1.1, h * 1.1);

  const s = Math.round(w / 26);          // 本文の文字の大きさ
  const rs = Math.round(s * 0.46);       // ルビの文字の大きさ
  const pitch = Math.round(s * 1.85);    // 行の間隔
  const top = Math.round(h * 0.11);
  const right = w - Math.round(w * 0.1);
  g.fillStyle = '#26221e';
  g.textBaseline = 'top';
  g.textAlign = 'center';

  // 柱とページ番号
  let headerBottom = 0;
  if (header) {
    g.font = `${Math.round(s * 0.62)}px serif`;
    [...'デミアン'].forEach((ch, i) => g.fillText(ch, w * 0.55 + i * s * 1.3, h * 0.035));
    g.fillText('9', pageLeft + w * 0.06, h * 0.035);
    headerBottom = h * 0.035 + s * 0.62;
  }

  const ruby = [];
  const cells = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  RUBY_LINES.forEach(([text, rubies], col) => {
    const cx = right - col * pitch;
    [...text].forEach((ch, i) => {
      const y = top + i * s * 1.05;
      if (PUNCT.has(ch)) {
        // 縦書きの句読点は、文字の枠の右上に置かれる
        g.font = `${s}px serif`;
        g.fillText(ch, cx + s * 0.32, y - s * 0.38);
      } else if (SMALL.has(ch)) {
        // 縦書きの小さい文字は、枠の右上寄り
        g.font = `${Math.round(s * 0.78)}px serif`;
        g.fillText(ch, cx + s * 0.1, y + s * 0.02);
      } else {
        g.font = `${s}px serif`;
        g.fillText(ch, cx, y);
      }
      cells.push({ x0: cx - s / 2, y0: y, x1: cx + s / 2, y1: y + s, ch });
      maxY = Math.max(maxY, y + s);
    });
    minX = Math.min(minX, cx - s / 2);
    maxX = Math.max(maxX, cx + s / 2);
    // ルビ：本文の文字の右側に、小さい文字を縦に並べる
    g.font = `${rs}px serif`;
    for (const [at, len, r] of rubies) {
      const y0 = top + at * s * 1.05;
      const span = len * s * 1.05;
      const step = Math.min(rs * 1.02, span / r.length);
      const start = y0 + (span - step * r.length) / 2;
      const rx = cx + s / 2 + rs * 0.55;
      [...r].forEach((ch, k) => g.fillText(ch, rx, start + k * step));
      ruby.push({ x0: rx - rs / 2, y0: start, x1: rx + rs / 2, y1: start + step * r.length });
    }
  });
  g.restore();

  // 左下が暗い影
  if (shadow) {
    const grad = g.createLinearGradient(pageLeft, h, w * 0.7, h * 0.35);
    grad.addColorStop(0, 'rgba(40,30,20,0.55)');
    grad.addColorStop(1, 'rgba(40,30,20,0)');
    g.fillStyle = grad;
    g.fillRect(pageLeft, 0, w - pageLeft, h);
  }
  return { canvas: c, truth: RUBY_TRUTH, body: { x0: minX, y0: top - s * 0.4, x1: maxX + s * 0.8, y1: maxY }, headerBottom, pageLeft, ruby, cells, s };
}
