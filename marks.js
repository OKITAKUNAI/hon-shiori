// マーカーの保存・削除・付け直し。
// 保存形式はフェーズ5の完成形：id, pageId, bookId, start, end, quote, prefix, suffix, color, tagIds, comment, createdAt, updatedAt
// （このフェーズでは color は既定の1色、tagIds と comment は空）
import * as db from './db.js';
import { uid } from './util.js';
import { makeAnchor, reanchor, isPlaced, findQuote } from './anchor.js';
import { adoptedText } from './text.js';

// 色は名前付きのキーで記録する（フェーズ5で、設定画面から名前と色を変えられるようにするため）
export const MARK_COLORS = {
  m1: { name: '感動', hex: '#f6a5b9' },
  m2: { name: '疑問', hex: '#a9c8f2' },
  m3: { name: '引用したい', hex: '#f7d76b' },
  m4: { name: '調べたい', hex: '#9fd8a8' },
};
export const DEFAULT_COLOR = 'm1';
export const colorHex = (key) => (MARK_COLORS[key] || MARK_COLORS[DEFAULT_COLOR]).hex;

export { isPlaced };

export async function marksOfPage(pageId) {
  const ms = await db.getByIndex('marks', 'pageId', pageId);
  return ms.sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
}

export async function addMark(page, text, start, end, color = DEFAULT_COLOR) {
  const now = Date.now();
  const mark = {
    id: uid(), pageId: page.id, bookId: page.bookId,
    ...makeAnchor(text, start, end),
    color, tagIds: [], comment: '', createdAt: now, updatedAt: now,
  };
  await db.put('marks', mark);
  return mark;
}

// 位置不明になったマーカーを、選び直した範囲に付け直す（色・タグ・コメントは保つ）
export async function reattachMark(mark, text, start, end) {
  return db.update('marks', mark.id, { ...makeAnchor(text, start, end), updatedAt: Date.now() });
}

export async function deleteMark(id) {
  return db.del('marks', id);
}

export async function deleteMarksOfPage(pageId) {
  for (const m of await marksOfPage(pageId)) await db.del('marks', m.id);
}

// ページの「画面に出す文章」が oldText から newText に変わったとき、そのページのマーカーを付け直す。
// 付け直せなかったもの（位置不明）は元の記録のまま残す
export async function reanchorPage(pageId, oldText, newText) {
  const result = { kept: 0, shifted: 0, edited: 0, found: 0, lost: 0 };
  if (oldText === newText) return result;
  for (const m of await marksOfPage(pageId)) {
    // すでに位置不明のものは、新しい文章の中を探し直すだけ（見つかれば戻る）
    let r;
    if (isPlaced(m, oldText)) r = reanchor(m, oldText, newText);
    else {
      const f = findQuote(newText, m, m.start);
      r = f ? { mark: { ...m, ...makeAnchor(newText, f.start, f.end) }, how: 'found' } : { mark: m, how: 'lost' };
    }
    result[r.how]++;
    if (r.how !== 'kept' && r.how !== 'lost') await db.put('marks', { ...r.mark, updatedAt: Date.now() });
  }
  return result;
}

// ページの文章に関わる項目を書き換え、画面に出す文章が変わればマーカーを付け直す。
// patch は項目のオブジェクト、または今のページを受け取って項目を返す関数
export async function updatePageText(pageId, patch) {
  const before = await db.get('pages', pageId);
  if (!before) return { page: undefined, moved: null };
  const page = await db.update('pages', pageId, patch);
  const moved = await reanchorPage(pageId, adoptedText(before).text, adoptedText(page).text);
  return { page, moved };
}
