// 範囲（マーカー）の記録と、文章を直したときの位置の付け直し。画面には関わらない計算だけを置く。
// 位置は JavaScript の文字列の添字（UTF-16 の単位）で記録する。

export const CONTEXT = 30; // 前後に記録する文字数

// 範囲を記録する：開始・終了の位置、選んだ文字列そのもの、前後の文字
export function makeAnchor(text, start, end) {
  return {
    start,
    end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

// 範囲が今の文章の正しい場所を指しているか（指していなければ「位置不明」）
export const isPlaced = (mark, text) =>
  mark.end > mark.start && mark.end <= text.length && text.slice(mark.start, mark.end) === mark.quote;

// 2つの文章の、変わった部分を1か所の範囲として求める（前と後ろの一致する部分を除いた残り）
export function diffRegion(oldText, newText) {
  const min = Math.min(oldText.length, newText.length);
  let at = 0;
  while (at < min && oldText[at] === newText[at]) at++;
  let tail = 0;
  while (tail < min - at && oldText[oldText.length - 1 - tail] === newText[newText.length - 1 - tail]) tail++;
  return { at, oldEnd: oldText.length - tail, newEnd: newText.length - tail };
}

// 文字列の末尾どうし／先頭どうしが何文字一致するか
function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// 選んだ文字列が文章の中に何か所かあれば、前後の文字がよく一致するものを選ぶ。同じくらいなら元の位置に近いもの
export function findQuote(text, mark, near) {
  if (!mark.quote) return null;
  let best = null;
  for (let i = text.indexOf(mark.quote); i !== -1; i = text.indexOf(mark.quote, i + 1)) {
    const end = i + mark.quote.length;
    const context =
      commonSuffix(text.slice(Math.max(0, i - CONTEXT), i), mark.prefix || '') +
      commonPrefix(text.slice(end, end + CONTEXT), mark.suffix || '');
    const distance = Math.abs(i - near);
    const score = context - distance / (text.length + 1); // 前後の一致を優先し、距離は同点のときの決め手
    if (!best || score > best.score) best = { start: i, end, score };
  }
  return best && { start: best.start, end: best.end };
}

// 文章が oldText から newText に変わったときに、範囲を付け直す。次の順で試す：
//  ① 変わった部分（差分）から位置をずらす。ずらした位置の文字列が選んだ文字列と一致すればそれでよい
//     ・範囲の中の小さな修正（誤字直しなど。変えた文字数が範囲の3割以下、短い範囲では2文字まで）なら、
//       直した後の文字列で範囲を保つ。大きく書き換えたときは②へ
//  ② 一致しなければ、選んだ文字列と前後の文字で文章の中を探し直す（元の位置に近い一致を優先）
//  ③ 見つからなければ「位置不明」として、元の記録のまま残す（黙って消さない）
// 戻り値：{ mark: 新しい記録, how: 'kept' | 'shifted' | 'edited' | 'found' | 'lost' }
export function reanchor(mark, oldText, newText) {
  if (oldText === newText) return { mark, how: 'kept' };
  const d = diffRegion(oldText, newText);
  const delta = d.newEnd - d.oldEnd;
  let cand = null;
  let inside = false;
  if (mark.end <= d.at) {
    cand = [mark.start, mark.end];                         // 変わった部分より前
  } else if (mark.start >= d.oldEnd) {
    cand = [mark.start + delta, mark.end + delta];         // 変わった部分より後ろ
  } else if (mark.start <= d.at && mark.end >= d.oldEnd && mark.end + delta > mark.start) {
    cand = [mark.start, mark.end + delta];                 // 範囲の中だけが変わった
    const changed = Math.max(d.oldEnd - d.at, d.newEnd - d.at);
    inside = changed <= Math.max(2, Math.floor((mark.end - mark.start) * 0.3));
  }
  if (cand) {
    const s = newText.slice(cand[0], cand[1]);
    if (s === mark.quote) {
      const how = cand[0] === mark.start ? 'kept' : 'shifted';
      return { mark: { ...mark, ...makeAnchor(newText, cand[0], cand[1]) }, how };
    }
    if (inside) return { mark: { ...mark, ...makeAnchor(newText, cand[0], cand[1]) }, how: 'edited' };
  }
  const found = findQuote(newText, mark, cand ? cand[0] : mark.start);
  if (found) return { mark: { ...mark, ...makeAnchor(newText, found.start, found.end) }, how: 'found' };
  return { mark, how: 'lost' };
}
