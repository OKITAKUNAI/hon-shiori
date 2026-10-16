// IndexedDB の薄いラッパー。データはすべてこの端末の中だけに保存される。
import { DB_NAME } from './config.js';

// v1: books / pages / tags
// v2: settings（設定）と marks（マーカー）を追加。既存のデータは変更しない。
//     ページの OCR 関係の項目（ocrText など）は、使うときに足していく（移行処理は不要）
export const DB_VERSION = 2;

let dbName = DB_NAME;
let dbPromise;

// テスト用：本番・試験版と別のデータベースで動かす
export async function useDatabase(name) {
  await closeDatabase();
  dbName = name;
}

export async function closeDatabase() {
  if (!dbPromise) return;
  const p = dbPromise;
  dbPromise = undefined;
  try { (await p).close(); } catch {}
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const from = e.oldVersion;
      if (from < 1) {
        db.createObjectStore('books', { keyPath: 'id' });
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('bookId', 'bookId');
        db.createObjectStore('tags', { keyPath: 'id' });
      }
      if (from < 2) {
        db.createObjectStore('settings', { keyPath: 'key' });
        const marks = db.createObjectStore('marks', { keyPath: 'id' });
        marks.createIndex('pageId', 'pageId');
        marks.createIndex('bookId', 'bookId');
        marks.createIndex('tagIds', 'tagIds', { multiEntry: true });
      }
    };
    // 古い版のアプリが別のタブで開いたままだと、更新が待たされる
    req.onblocked = () => {
      window.dispatchEvent(new CustomEvent('db-blocked'));
    };
    req.onsuccess = () => {
      const db = req.result;
      // 別のタブで新しい版が開かれたら接続を閉じて、その更新を妨げない
      db.onversionchange = () => { db.close(); dbPromise = undefined; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function getAll(name) {
  return wrap((await store(name)).getAll());
}

export async function get(name, id) {
  if (!id) return undefined;
  return wrap((await store(name)).get(id));
}

export async function put(name, obj) {
  return wrap((await store(name, 'readwrite')).put(obj));
}

// 最新のレコードを読んで、指定した項目だけを書き換える（読み書きを1つのトランザクションで行う）。
// 画面が古いレコードを丸ごと書き戻して、裏で更新した項目（サムネなど）を消してしまうのを防ぐ。
export async function update(name, id, patch) {
  const s = await store(name, 'readwrite');
  const cur = await wrap(s.get(id));
  if (!cur) return undefined;
  const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
  await wrap(s.put(next));
  return next;
}

export async function del(name, id) {
  return wrap((await store(name, 'readwrite')).delete(id));
}

export async function getSetting(key, fallback) {
  const row = await get('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return put('settings', { key, value });
}

export async function pagesOfBook(bookId) {
  const s = await store('pages');
  const pages = await wrap(s.index('bookId').getAll(bookId));
  return pages.sort((a, b) => a.createdAt - b.createdAt);
}
