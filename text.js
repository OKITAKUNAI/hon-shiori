// ページの「画面に出す文章」の決め方（ocr.js と marks.js の両方から使う）

// textSource は 'ocr' か 'paste'。未選択なら、貼り付けがあれば貼り付け、なければ読み取り結果
export function sourceOf(page) {
  return page.textSource || (page.pasteText?.trim() ? 'paste' : 'ocr');
}

export function sourceText(page, src = sourceOf(page)) {
  return (src === 'paste' ? page.pasteText : page.ocrText) || '';
}

// 画面に出す文章：手で直した文章（editedText）があればそれ、なければ textSource が指す原文。
// マーカーの位置はこの文章に対して記録する
export function adoptedText(page) {
  const source = sourceOf(page);
  const edited = !!page.editedText;
  return { source, edited, text: edited ? page.editedText : sourceText(page, source) };
}
