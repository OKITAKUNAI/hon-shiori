// バックアップの書き出しと読み込み。
// version 2：本・ページ（写真と全文：ocrText / editedText / pasteText など）・タグ・マーカー・設定
// version 1：本・ページ・タグ（旧版の書き出し）。どちらも読み込める
import * as db from './db.js';
import { blobToDataURL, dataURLToBlob } from './util.js';

export const BACKUP_VERSION = 2;

// 端末ごとの状態は書き出さない（言語データのダウンロード済みの印など。別の端末では取り直しが必要なため）
const DEVICE_ONLY_SETTINGS = new Set(['ocrReady']);

export async function exportBackup() {
  const [books, tags, pages, marks, settings] = await Promise.all([
    db.getAll('books'), db.getAll('tags'), db.getAll('pages'), db.getAll('marks'), db.getAll('settings'),
  ]);
  return {
    app: 'hon-shiori',
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    books,
    tags,
    pages: await Promise.all(pages.map(async (p) => ({
      ...p,
      image: p.image ? await blobToDataURL(p.image) : null,
      thumb: p.thumb ? await blobToDataURL(p.thumb) : null,
    }))),
    marks,
    settings: settings.filter((s) => !DEVICE_ONLY_SETTINGS.has(s.key)),
  };
}

// 読み込む前の確認用に、中身の件数を数える（形がおかしければ例外）
export function summarize(data) {
  if (!data || data.app !== 'hon-shiori') throw new Error('ほんのしおりのバックアップではありません');
  const v = Number(data.version || 1);
  if (v > BACKUP_VERSION) throw new Error('新しい版のアプリで書き出したバックアップです。アプリを更新してから読み込んでください');
  if (!Array.isArray(data.books) || !Array.isArray(data.pages)) throw new Error('バックアップの中身が足りません');
  return { version: v, books: data.books.length, pages: data.pages.length, tags: (data.tags || []).length, marks: (data.marks || []).length };
}

// 読み込む。同じ id のデータは上書きする
export async function importBackup(data) {
  const info = summarize(data);
  for (const b of data.books) await db.put('books', b);
  for (const t of data.tags || []) await db.put('tags', t);
  for (const p of data.pages) {
    await db.put('pages', {
      ...p,
      image: p.image ? await dataURLToBlob(p.image) : null,
      thumb: p.thumb ? await dataURLToBlob(p.thumb) : null,
    });
  }
  for (const m of data.marks || []) await db.put('marks', m);
  for (const s of data.settings || []) if (!DEVICE_ONLY_SETTINGS.has(s.key)) await db.put('settings', s);
  return info;
}
