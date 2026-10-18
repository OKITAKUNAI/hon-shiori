// ページの「画面に出す文章」の決め方（ocr.js と marks.js と画面から使う）
//
// 文章の項目：
//   ocrText    読み取り結果の原文（再認識で置き換わる）
//   pasteText  貼り付けた文章の原文
//   editedText 手で直した文章。元の文章ごとに別々に持つ：{ ocr: '…', paste: '…' }（直していなければ空）
//   textSource どちらの文章を使うか：'ocr' か 'paste'

// textSource は 'ocr' か 'paste'。未選択なら、貼り付けがあれば貼り付け、なければ読み取り結果
export function sourceOf(page) {
  return page.textSource || (page.pasteText?.trim() ? 'paste' : 'ocr');
}

export function sourceText(page, src = sourceOf(page)) {
  return (src === 'paste' ? page.pasteText : page.ocrText) || '';
}

// 手で直した文章（元の文章ごと）。試作段階の形（1つの文字列）が残っていても、使っていた側の手直しとして読む
export function editedMap(page) {
  const e = page.editedText;
  if (!e) return { ocr: '', paste: '' };
  if (typeof e === 'string') return { ocr: '', paste: '', [sourceOf(page)]: e };
  return { ocr: e.ocr || '', paste: e.paste || '' };
}

export const editedOf = (page, src = sourceOf(page)) => editedMap(page)[src];

// 手直しを1つの元の文章についてだけ書き換えた editedText を返す（もう一方の手直しは保つ）
export function withEdited(page, src, value) {
  return { ...editedMap(page), [src]: value };
}

// 画面に出す文章：使っている元の文章に手直しがあればそれ、なければその原文。
// マーカーの位置はこの文章に対して記録する
export function adoptedText(page) {
  const source = sourceOf(page);
  const e = editedOf(page, source);
  return { source, edited: !!e, text: e || sourceText(page, source) };
}

// ---------- 信頼度の低い文字の印 ----------

// 印を付ける基準（この値より信頼度が低い文字）。p9 の写真で、実際の誤り9か所のうち 96→6か所・97→7か所・98→8か所を拾い、
// 正しい字への印は 96→4.0%・97→5.5%・98→7.4% だった（99 にすると 37.5% に増える）
// 並びは印の少ない順（数字のキーなので、オブジェクトでも小さい順に並ぶ）。既定の98を「ふつう」と呼ぶ
export const LOW_CONF_LEVELS = { 96: '少なめ（96）', 97: 'やや少なめ（97）', 98: 'ふつう（98・既定）' };
export const LOW_CONF_DEFAULT = 98;

// 読み取りが崩れているかもしれないときの目安：信頼度98未満の字が、読み取った字（空白を除く）の15%以上。
// うまく読めた写真（一致率97〜98%：p9・p7）は 6.8〜9.5%、崩れた写真（86〜87%）は 21〜27%、それ以下は 40%以上だった。
// 印の量の設定（lowConfLevel）とは関係なく、この基準で判断する。短い文章（40字未満）では判断しない
export const BROKEN_CONF = 98;
export const BROKEN_RATIO = 0.15;
export function ocrLooksBroken(page) {
  const n = (page.ocrText || '').replace(/\s/g, '').length;
  if (n < 40 || !page.ocrLow) return false;
  return page.ocrLow.filter(([, c]) => c < BROKEN_CONF).length / n >= BROKEN_RATIO;
}

// 2つの文章の文字を対応づける（最長共通部分列）。a の各位置に対応する b の位置（なければ -1）を返す。
// 手直しはふつう一部分なので、前後の一致する部分を先に除いてから計算する
export function alignMap(a, b) {
  const map = new Int32Array(a.length).fill(-1);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) { map[p] = p; p++; }
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) { map[a.length - 1 - s] = b.length - 1 - s; s++; }
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  if (!A.length || !B.length) return map;
  if (A.length * B.length > 4e6) return map; // 長すぎるときは前後の一致だけで済ませる
  const n = A.length;
  const m = B.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = A[i] === B[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m;) {
    if (A[i] === B[j]) { map[p + i] = p + j; i++; j++; } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++; else j++;
  }
  return map;
}

// 読み取り結果（ocrText）の中の位置の一覧を、文章 text の中の位置（Set）に移す。
// ocrText から変わっていない文字だけを残すので、手直しした文字の印は消える。貼り付けの文章を使っているときは何も出さない
function keptIn(page, text, positions) {
  if (sourceOf(page) !== 'ocr' || !positions.length || !text) return new Set();
  const raw = page.ocrText || '';
  if (text === raw) return new Set(positions);
  const map = alignMap(raw, text);
  return new Set(positions.map((i) => map[i]).filter((i) => i >= 0));
}

// 信頼度の低い文字の位置
export function lowConfIn(page, text, threshold = LOW_CONF_DEFAULT) {
  return keptIn(page, text, (page.ocrLow || []).filter(([, c]) => c < threshold).map(([i]) => i));
}

// 読み取りのあとに自動で直した文字の位置（ocr.js の fixVertical）
export function autoFixedIn(page, text) {
  return keptIn(page, text, (page.ocrFixed || []).map(([i]) => i));
}
