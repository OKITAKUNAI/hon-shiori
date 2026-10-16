// IndexedDB の薄いラッパー。データはすべてこの端末の中だけに保存される。
import { DB_NAME } from './config.js';

const DB_VERSION = 1;

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
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('books', { keyPath: 'id' });
      const pages = db.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('bookId', 'bookId');
      db.createObjectStore('tags', { keyPath: 'id' });
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

export async function pagesOfBook(bookId) {
  const s = await store('pages');
  const pages = await wrap(s.index('bookId').getAll(bookId));
  return pages.sort((a, b) => a.createdAt - b.createdAt);
}
