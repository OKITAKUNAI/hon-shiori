// 自動テスト。見本の画像はすべて canvas で描く（本の写真は使わない）
import * as db from './db.js';
import { resizeImage, imageSize, esc, THUMB_W, THUMB_H, THUMB_VERSION } from './util.js';
import { makeThumb, regenerateThumbs } from './thumbs.js';

const TEST_DB = 'hon-shiori-test';
const list = document.getElementById('results');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  const li = document.createElement('li');
  li.textContent = name;
  list.append(li);
  try {
    const note = await fn();
    li.className = 'pass';
    passed++;
    if (note) li.insertAdjacentHTML('beforeend', `<small>${esc(note)}</small>`);
  } catch (e) {
    li.className = 'fail';
    failed++;
    li.insertAdjacentHTML('beforeend', `<small>${esc(e?.stack || e)}</small>`);
    console.error(name, e);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 見本の文章（このテストのために書いたもの）
const SAMPLE = [
  'しおりを挟んだページには、',
  'その日の気持ちが残っている。',
  'あとで開くと、読んだときの',
  '部屋の明るさまで思い出す。',
  '本は二度目に読むときのほうが',
  'やさしい顔をしていることがある。',
];

// 縦書きの本のページを描く
function drawPage(w = 1200, h = 1600) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#f7f1e3';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#222';
  const size = Math.round(w / 22);
  g.font = `${size}px serif`;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  SAMPLE.forEach((line, col) => {
    const x = w - size * 2 - col * size * 1.9;
    [...line].forEach((ch, i) => g.fillText(ch, x, size * 1.5 + i * size * 1.05));
  });
  return c;
}

const toBlob = (c, type = 'image/jpeg', q = 0.92) => new Promise((r) => c.toBlob(r, type, q));

async function sha256(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function deleteDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`${name} を消せません（他のタブで開いています）`));
  });
}

// v1 の時点のスキーマとデータを、アプリのコードを通さずに直接作る（旧版で保存されたデータの再現）
function createV1Database(name, records) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('pages', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      d.createObjectStore('tags', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction(['books', 'pages', 'tags'], 'readwrite');
      for (const [store, items] of Object.entries(records)) for (const it of items) tx.objectStore(store).put(it);
      tx.oncomplete = () => { d.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

async function makeV1Fixture() {
  const image1 = await toBlob(drawPage(1200, 1600));
  const image2 = await toBlob(drawPage(1176, 1568));
  // 旧版と同じく 480px で一気に縮小したサムネ
  const oldThumb = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const s = 480 / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return toBlob(c, 'image/jpeg', 0.8);
  };
  const now = Date.now();
  return {
    books: [{ id: 'b1', title: 'テストの本', author: '', favoritePageId: 'p2', createdAt: now, updatedAt: now }],
    tags: [{ id: 't1', name: '心に刺さった', color: '#f6a5b9', createdAt: now }],
    pages: [
      { id: 'p1', bookId: 'b1', image: image1, thumb: await oldThumb(image1), comment: 'ひとこと1', tagIds: ['t1'], createdAt: now, updatedAt: now },
      { id: 'p2', bookId: 'b1', image: image2, thumb: await oldThumb(image2), comment: '', tagIds: [], createdAt: now + 1, updatedAt: now + 1 },
    ],
  };
}

async function run() {
  await db.useDatabase(TEST_DB);

  // ---- 縮小 ----
  await test('縦長のページは 600×800 に収まるサムネになる', async () => {
    const t = await makeThumb(await toBlob(drawPage(1200, 1600)));
    const s = await imageSize(t);
    assert(s.width === 600 && s.height === 800, `実際は ${s.width}×${s.height}`);
    return `${s.width}×${s.height}, ${(t.size / 1024).toFixed(0)}KB`;
  });

  await test('横長の画像は幅 600 に収まる', async () => {
    const s = await imageSize(await makeThumb(await toBlob(drawPage(1600, 1200))));
    assert(s.width === 600 && s.height === 450, `実際は ${s.width}×${s.height}`);
  });

  await test('小さい画像は拡大しない', async () => {
    const s = await imageSize(await makeThumb(await toBlob(drawPage(300, 400))));
    assert(s.width === 300 && s.height === 400, `実際は ${s.width}×${s.height}`);
  });

  await test('元画像の縮小（長辺1568）は縦横比を保つ', async () => {
    const s = await imageSize(await resizeImage(await toBlob(drawPage(3000, 4000)), 1568));
    assert(s.width === 1176 && s.height === 1568, `実際は ${s.width}×${s.height}`);
  });

  // ---- v1 のデータ ----
  await db.closeDatabase();
  await deleteDb(TEST_DB);
  const fixture = await makeV1Fixture();
  const imageHashes = {};
  for (const p of fixture.pages) imageHashes[p.id] = await sha256(p.image);
  await createV1Database(TEST_DB, fixture);

  await test('旧版（v1）で保存したデータを、そのまま開ける', async () => {
    const [books, pages, tags] = await Promise.all([db.getAll('books'), db.getAll('pages'), db.getAll('tags')]);
    assert(books.length === 1 && pages.length === 2 && tags.length === 1, `本${books.length} ページ${pages.length} タグ${tags.length}`);
    assert((await db.pagesOfBook('b1')).length === 2, 'bookId の索引で引けない');
  });

  let progressCalls = 0;
  let firstRun;
  await test('古いサムネを元画像から作り直す（元画像・メモ・タグは変わらない）', async () => {
    firstRun = await regenerateThumbs(() => progressCalls++);
    assert(firstRun.total === 2 && firstRun.done === 2 && firstRun.failed === 0, JSON.stringify(firstRun));
    for (const p of await db.getAll('pages')) {
      const orig = fixture.pages.find((x) => x.id === p.id);
      assert(p.thumbVersion === THUMB_VERSION, `${p.id} の thumbVersion が ${p.thumbVersion}`);
      const s = await imageSize(p.thumb);
      assert(s.width <= THUMB_W && s.height <= THUMB_H && Math.max(s.width / THUMB_W, s.height / THUMB_H) > 0.99, `${p.id} のサムネが ${s.width}×${s.height}`);
      assert((await sha256(p.image)) === imageHashes[p.id], `${p.id} の元画像が変わった`);
      assert(p.comment === orig.comment && JSON.stringify(p.tagIds) === JSON.stringify(orig.tagIds), `${p.id} のメモかタグが変わった`);
    }
    const book = await db.get('books', 'b1');
    assert(book.favoritePageId === 'p2', '本の★が変わった');
    return `進み具合の通知 ${progressCalls} 回`;
  });

  await test('進み具合が表示用に通知される', async () => {
    assert(progressCalls === firstRun.total + 1, `通知 ${progressCalls} 回（開始1回＋1枚ごと）`);
  });

  await test('2回目の起動では作り直さない', async () => {
    const r = await regenerateThumbs();
    assert(r.total === 0, `${r.total} 枚を作り直そうとした`);
  });

  await test('途中で止まっても、残りのページだけ作り直す', async () => {
    await db.update('pages', 'p1', { thumbVersion: undefined });
    const r = await regenerateThumbs();
    assert(r.total === 1 && r.done === 1, JSON.stringify(r));
  });

  await test('画面が古いページ情報を持っていても、作り直したサムネを上書きしない', async () => {
    const v1Thumb = fixture.pages.find((p) => p.id === 'p2').thumb;
    await db.update('pages', 'p2', { thumb: v1Thumb, thumbVersion: undefined }); // 旧版のサムネに戻す
    const stale = await db.get('pages', 'p2');            // 画面が読み込んだ時点のページ
    await regenerateThumbs();                              // 裏でサムネを作り直す
    await db.update('pages', 'p2', { comment: '書いた' });  // 画面からメモを保存
    const now = await db.get('pages', 'p2');
    assert(now.comment === '書いた', 'メモが保存されていない');
    assert(now.thumbVersion === THUMB_VERSION, 'サムネの版が古い値に戻った');
    assert((await sha256(now.thumb)) !== (await sha256(stale.thumb)), 'サムネが古いものに戻った');
  });

  await db.closeDatabase();
  await deleteDb(TEST_DB);

  document.getElementById('summary').textContent =
    failed ? `${failed} 件 失敗 / ${passed} 件 成功` : `すべて成功（${passed} 件）`;
  document.body.dataset.done = failed ? 'fail' : 'pass';

  await renderPreview();
}

// D案のカードと、縮小方法の見比べ（目視用）
async function renderPreview() {
  const page = await toBlob(drawPage(1200, 1600));
  const newThumb = URL.createObjectURL(await makeThumb(page));
  const bmp = await createImageBitmap(page);
  const c = document.createElement('canvas');
  c.width = 360;
  c.height = 480;
  c.getContext('2d').drawImage(bmp, 0, 0, 360, 480);
  const oldThumb = URL.createObjectURL(await toBlob(c, 'image/jpeg', 0.8));
  const quotes = [
    ['#f6a5b9', 'その日の気持ちが残っている。'],
    ['#f7e08a', '本は二度目に読むときのほうがやさしい顔をしていることがある。'],
    ['#9fd8d3', '部屋の明るさまで思い出す。'],
  ];
  const card = (inner, label) => `<div class="page-card">${inner}<div class="pc-book">${esc(label)}</div></div>`;
  document.getElementById('preview').innerHTML = [
    card(`<div class="thumb"><img src="${oldThumb}" alt=""></div>`, '旧：480px・一気に縮小'),
    card(`<div class="thumb"><img src="${newThumb}" alt=""></div>`, '新：600×800・高品質縮小'),
    ...quotes.map(([color, text]) => card(
      `<div class="thumb words" style="--mc:${color}"><img class="words-bg" src="${newThumb}" alt=""><p class="words-text">${esc(text)}</p></div>`,
      'D案：ことば表示',
    )),
  ].join('');
}

run();
