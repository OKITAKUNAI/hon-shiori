// IndexedDB の薄いラッパー。データはすべてこの端末の中だけに保存される。
const DB_NAME = 'hon-shiori';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // 戻し用：版を指定せずに開く。新しい版（v2 以降）のデータベースもそのまま開け、
    // 旧版が使う books / pages / tags だけを読み書きする（新しい版で増えた項目やストアは残す）
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains('books')) return;
      db.createObjectStore('books', { keyPath: 'id' });
      const pages = db.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('bookId', 'bookId');
      db.createObjectStore('tags', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
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

export async function del(name, id) {
  return wrap((await store(name, 'readwrite')).delete(id));
}

export async function pagesOfBook(bookId) {
  const s = await store('pages');
  const pages = await wrap(s.index('bookId').getAll(bookId));
  return pages.sort((a, b) => a.createdAt - b.createdAt);
}
