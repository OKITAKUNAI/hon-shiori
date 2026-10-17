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
