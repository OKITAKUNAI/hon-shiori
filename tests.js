// 自動テスト。見本の画像はすべて canvas で描く（本の写真は使わない）
import * as db from './db.js';
import { resizeImage, imageSize, esc, THUMB_W, THUMB_H, THUMB_VERSION } from './util.js';
import { makeThumb, regenerateThumbs } from './thumbs.js';
import * as ocr from './ocr.js';
import * as share from './share.js';
import { preprocessForOcr } from './preprocess.js';
import * as P from './preprocess.js';
import { drawRubyPage, RUBY_TRUTH, RUBY_STRINGS } from './tools/sample-page.js';
import { makeAnchor, reanchor, isPlaced } from './anchor.js';
import * as marksMod from './marks.js';
import { renderText } from './textview.js';
import { MON_TO_MA } from './fix-words.js';
import { exportBackup, importBackup } from './backup.js';
import { editedOf, lowConfIn, autoFixedIn, alignMap, ocrLooksBroken } from './text.js';

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

// 横書きのページを描く
function drawHorizontal(w = 1200, h = 900) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#222';
  const size = Math.round(w / 26);
  g.font = `${size}px sans-serif`;
  g.textBaseline = 'top';
  SAMPLE.forEach((line, row) => g.fillText(line, size * 1.5, size * 1.5 + row * size * 1.9));
  return c;
}


// JPEG に EXIF の向き（Orientation）を書き込む。カメラが横向きのまま保存し、向きの情報だけ付けた写真を再現する
async function withExifOrientation(jpegBlob, orientation) {
  const src = new Uint8Array(await jpegBlob.arrayBuffer());
  const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
  const len = body.length + 2;
  const app1 = [0xff, 0xe1, len >> 8, len & 0xff, ...body];
  const out = new Uint8Array(src.length + app1.length);
  out.set(src.subarray(0, 2), 0);           // SOI
  out.set(app1, 2);
  out.set(src.subarray(2), 2 + app1.length);
  return new Blob([out], { type: 'image/jpeg' });
}

// 2つの文章の一致率（最長共通部分列の長さから計算。空白と改行は無視）
function similarity(a, b) {
  a = [...a.replace(/\s/g, '')];
  b = [...b.replace(/\s/g, '')];
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}

function inspectDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => {
      const d = req.result;
      const stores = {};
      if (d.objectStoreNames.length) {
        const tx = d.transaction([...d.objectStoreNames], 'readonly');
        for (const s of d.objectStoreNames) stores[s] = [...tx.objectStore(s).indexNames];
      }
      const version = d.version;
      d.close();
      resolve({ version, stores });
    };
    req.onerror = () => reject(req.error);
  });
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
    // 閉じたばかりの接続が残っていると一時的に blocked になるので、閉じ終わって消えるまで待つ
    const t = setTimeout(() => reject(new Error(`${name} を消せません（他のタブで開いています）`)), 5000);
    req.onsuccess = () => { clearTimeout(t); resolve(); };
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

  await test(`旧版（v1）で保存したデータを、v${db.DB_VERSION} に移行してそのまま開ける`, async () => {
    const [books, pages, tags] = await Promise.all([db.getAll('books'), db.getAll('pages'), db.getAll('tags')]);
    assert(books.length === 1 && pages.length === 2 && tags.length === 1, `本${books.length} ページ${pages.length} タグ${tags.length}`);
    assert((await db.pagesOfBook('b1')).length === 2, 'bookId の索引で引けない');
    for (const p of pages) {
      const orig = fixture.pages.find((x) => x.id === p.id);
      assert((await sha256(p.image)) === imageHashes[p.id], `${p.id} の元画像が変わった`);
      assert(p.comment === orig.comment && p.bookId === orig.bookId, `${p.id} の内容が変わった`);
    }
    const info = await inspectDb(TEST_DB);
    assert(info.version === db.DB_VERSION, `版が ${info.version}`);
    for (const s of ['books', 'pages', 'tags', 'settings', 'marks']) assert(info.stores[s], `${s} がない`);
    assert(['pageId', 'bookId', 'tagIds'].every((i) => info.stores.marks.includes(i)), `marks の索引: ${info.stores.marks}`);
    await db.setSetting('test', { a: 1 });
    assert((await db.getSetting('test')).a === 1, 'settings に保存できない');
    return `ストア: ${Object.keys(info.stores).join(', ')}`;
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

  await test('新しく作るデータベースも同じ形になる（v1 を経由しない場合）', async () => {
    await db.useDatabase(TEST_DB + '-fresh');
    await db.getAll('books');
    const info = await inspectDb(TEST_DB + '-fresh');
    await db.useDatabase(TEST_DB);
    await deleteDb(TEST_DB + '-fresh');
    assert(info.version === db.DB_VERSION && ['books', 'pages', 'tags', 'settings', 'marks'].every((s) => info.stores[s]), JSON.stringify(info));
  });

  // ---- 文字認識 ----
  await test('読み取り結果の整形：文字の間の空白を取り、段落の中の改行をつなぐ', async () => {
    const got = ocr.cleanText('し お り を 挟 ん だ\nペ ー ジ に は 、\n\nそ の 日 の 気 持 ち\r\nABC def\nghi');
    const want = 'しおりを挟んだページには、\nその日の気持ちABC def ghi';
    assert(got === want, `結果: ${JSON.stringify(got)}`);
  });

  // 言語データはテストでもCDNから取得する（初回のみ。以後は端末内のキャッシュ）
  let ocrAvailable = true;
  await test('縦書き用の言語データを準備できる', async () => {
    const t0 = performance.now();
    try {
      await ocr.prepare('vertical');
    } catch (e) {
      ocrAvailable = false;
      throw e;
    }
    assert(await ocr.isReady('vertical'), '準備済みにならない');
    return `${Math.round(performance.now() - t0)}ms`;
  });

  await test('canvas に描いた縦書きの見本文を読み取れる（一致率80%以上）', async () => {
    assert(ocrAvailable, '言語データを準備できなかったので実行しない');
    const blob = await toBlob(drawPage(1200, 1600), 'image/png');
    const t0 = performance.now();
    const { text } = await ocr.recognize(blob, 'vertical', { psm: '5' });
    const want = SAMPLE.join('');
    const score = similarity(text, want);
    assert(score >= 0.8, `一致率 ${(score * 100).toFixed(0)}%：${text}`);
    return `一致率 ${(score * 100).toFixed(0)}%・${Math.round(performance.now() - t0)}ms：${text}`;
  });

  await test('canvas に描いた横書きの見本文を読み取れる（一致率80%以上）', async () => {
    await ocr.prepare('horizontal');
    const blob = await toBlob(drawHorizontal(1200, 900), 'image/png');
    const { text } = await ocr.recognize(blob, 'horizontal');
    const score = similarity(text, SAMPLE.join(''));
    assert(score >= 0.8, `一致率 ${(score * 100).toFixed(0)}%：${text}`);
    return `一致率 ${(score * 100).toFixed(0)}%：${text}`;
  });

  await test('文字認識の間も画面の処理が止まらない（最大の停止が200ms未満）', async () => {
    const blob = await toBlob(drawPage(1568, 2090), 'image/png');
    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 16);
    const t0 = performance.now();
    await ocr.recognize(blob, 'vertical');
    const ms = performance.now() - t0;
    clearInterval(timer);
    assert(maxGap < 200, `最大 ${Math.round(maxGap)}ms 止まった`);
    return `読み取り ${Math.round(ms)}ms の間に画面側の処理が ${ticks} 回動いた。最大の間隔 ${Math.round(maxGap)}ms`;
  });

  await test('保存したページを順番待ちに入れると、裏で読み取って結果を保存する', async () => {
    const image = await toBlob(drawPage(1200, 1600));
    const now = Date.now();
    await db.put('pages', { id: 'q1', bookId: 'b1', image, thumb: image, comment: '', tagIds: [], ocrStatus: 'none', ocrText: '', pasteText: '', textSource: null, writingMode: null, createdAt: now, updatedAt: now });
    const seen = [];
    const off = ocr.onOcrChange((p) => { if (p.id === 'q1') seen.push(p.ocrStatus); });
    const done = new Promise((res) => {
      const off2 = ocr.onOcrChange((p) => { if (p.id === 'q1' && (p.ocrStatus === 'done' || p.ocrStatus === 'failed')) { off2(); res(); } });
    });
    await ocr.enqueue('q1');
    await done;
    off();
    const p = await db.get('pages', 'q1');
    assert(p.ocrStatus === 'done', `状態 ${p.ocrStatus} ${p.ocrError || ''}`);
    assert(similarity(p.ocrText, SAMPLE.join('')) >= 0.8, `結果：${p.ocrText}`);
    assert(p.textSource === 'ocr' && p.ocrLang === 'jpn_vert' && p.ocrPsm === '5', `textSource=${p.textSource} ocrLang=${p.ocrLang} ocrPsm=${p.ocrPsm}`);
    assert(!editedOf(p, 'ocr') && !editedOf(p, 'paste'), '手で直した文章に書き込まれた');
    assert(seen.join(',') === 'queued,running,done', `状態の変化: ${seen.join(',')}`);
    return `状態の変化: ${seen.join(' → ')}`;
  });

  await test('途中で閉じた読み取り（実行中のまま）は、次の起動で順番待ちに戻して再開する', async () => {
    await db.update('pages', 'q1', { ocrStatus: 'running', ocrText: '' });
    const done = new Promise((res) => {
      const off = ocr.onOcrChange((p) => { if (p.id === 'q1' && p.ocrStatus === 'done') { off(); res(); } });
    });
    await ocr.resumeQueue();
    await done;
    assert((await db.get('pages', 'q1')).ocrText.length > 10, '読み取り結果がない');
  });

  await test('貼り付けた文章があれば、どちらを使うか未選択のときは貼り付けを使う', async () => {
    await db.update('pages', 'q1', { textSource: null, pasteText: 'レンズでコピーした文章', ocrStatus: 'queued' });
    const done = new Promise((res) => {
      const off = ocr.onOcrChange((p) => { if (p.id === 'q1' && p.ocrStatus === 'done') { off(); res(); } });
    });
    await ocr.enqueue('q1');
    await done;
    const p = await db.get('pages', 'q1');
    assert(p.textSource === 'paste' && ocr.adoptedText(p).text === 'レンズでコピーした文章', `textSource=${p.textSource}`);
    assert(p.ocrText.length > 10, '読み取り結果も保存されていない');
  });


  await test('縦書きの読み方 PSM 5 と PSM 3 を同じ見本で比べる', async () => {
    const blob = await toBlob(drawPage(1200, 1600), 'image/png');
    const want = SAMPLE.join('');
    const rows = [];
    for (const psm of ['5', '3']) {
      const t0 = performance.now();
      const r = await ocr.recognize(blob, 'vertical', { psm });
      rows.push({ psm, score: similarity(r.text, want), ms: Math.round(performance.now() - t0), text: r.text });
    }
    document.getElementById('psmCompare').innerHTML = rows.map((r) => `
      <tr><th>PSM ${r.psm}</th><td>${(r.score * 100).toFixed(0)}%</td><td>${r.ms}ms</td><td class="vt">${esc(r.text)}</td></tr>`).join('');
    assert(rows.every((r) => r.text.length > 0), '結果が空のものがある');
    return rows.map((r) => `PSM ${r.psm}: 一致率 ${(r.score * 100).toFixed(0)}%・${r.ms}ms`).join(' ／ ');
  });

  await test('前処理：グレースケールになり、薄い写真のコントラストが広がる', async () => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 100;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(150,140,120)'; g.fillRect(0, 0, 200, 100);   // 黄ばんだ紙
    g.fillStyle = 'rgb(105,100,95)'; g.fillRect(40, 30, 120, 40);     // 薄い文字
    const { blob, range } = await preprocessForOcr(await toBlob(c, 'image/png'));
    const bmp = await createImageBitmap(blob);
    const o = document.createElement('canvas');
    o.width = bmp.width; o.height = bmp.height;
    const og = o.getContext('2d');
    og.drawImage(bmp, 0, 0);
    const px = (x, y) => og.getImageData(x, y, 1, 1).data;
    const paper = px(5, 5);
    const ink = px(100, 50);
    assert(paper[0] === paper[1] && paper[1] === paper[2], `グレーでない: ${paper}`);
    assert(paper[0] > 240 && ink[0] < 15, `紙 ${paper[0]}・文字 ${ink[0]}（広がっていない）`);
    return `元の明るさ ${range.lo}〜${range.hi} → 紙 ${paper[0]}・文字 ${ink[0]}`;
  });

  await test('写真の向き（EXIF）が反映される：横向きに保存された縦写真が縦になる', async () => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;  // センサーの向きのまま保存された画像
    c.getContext('2d').fillRect(0, 0, 100, 300);
    const jpeg = await withExifOrientation(await toBlob(c), 6); // 6 = 時計回りに90度回して見る
    const resized = await imageSize(await resizeImage(jpeg, 1568));
    const pre = await imageSize((await preprocessForOcr(jpeg)).blob);
    assert(resized.width === 300 && resized.height === 400, `保存用 ${resized.width}×${resized.height}`);
    assert(pre.width === 300 && pre.height === 400, `認識用 ${pre.width}×${pre.height}`);
    return '保存用・認識用とも 300×400（向きを反映。補正処理は不要）';
  });

  await test('文字認識で外部のサイトに通信していない（エンジンも言語データも同じサイトから）', async () => {
    const external = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => !u.startsWith(location.origin) && !u.startsWith('blob:') && !u.startsWith('data:'));
    assert(external.length === 0, `外部への通信: ${external.join(', ')}`);
    const sw = await (await fetch('sw.js')).text();
    const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
    assert(!/traineddata|vendor/.test(shell), 'Service Worker のインストール時に言語データを取得している');
    // 言語データはワーカーの中で取得するのでこの画面の記録には出ない（サーバーの記録で確認）
    return '画面からの通信はすべて同じサイト。インストール時に言語データは取得しない';
  });

  await test('写真のないページは読み取りの順番待ちに入らない', async () => {
    const now = Date.now();
    await db.put('pages', { id: 't1', bookId: 'b1', image: null, thumb: null, comment: '', tagIds: [], ocrStatus: 'none', ocrText: '', editedText: { ocr: '', paste: '' }, pasteText: '文章だけ', textSource: 'paste', createdAt: now, updatedAt: now });
    await ocr.enqueue('t1');
    const p = await db.get('pages', 't1');
    assert(p.ocrStatus === 'none', `状態 ${p.ocrStatus}`);
    assert(ocr.adoptedText(p).text === '文章だけ', '採用中の文章が違う');
  });

  await test('読み取りの進捗率が通知され、もう一度読み取っても手で直した文章は上書きしない', async () => {
    await db.update('pages', 'q1', { editedText: { ocr: '手で直した文章', paste: '' }, ocrText: '古い原文', textSource: 'ocr' });
    const progress = [];
    const offP = ocr.onOcrProgress((pid, v) => { if (pid === 'q1') progress.push(v); });
    const done = new Promise((res) => {
      const off = ocr.onOcrChange((p) => { if (p.id === 'q1' && p.ocrStatus === 'done') { off(); res(); } });
    });
    await ocr.enqueue('q1');
    await done;
    offP();
    const p = await db.get('pages', 'q1');
    assert(editedOf(p, 'ocr') === '手で直した文章', `editedText が ${JSON.stringify(p.editedText)}`);
    assert(p.ocrText !== '古い原文' && similarity(p.ocrText, SAMPLE.join('')) >= 0.8, '原文が更新されていない');
    assert(ocr.adoptedText(p).text === '手で直した文章', '画面に出す文章が手直しになっていない');
    assert(progress.length >= 2 && Math.max(...progress) > 0.5, `進捗の通知: ${progress.length}回 最大${Math.max(0, ...progress)}`);
    return `進捗の通知 ${progress.length} 回（最大 ${Math.round(Math.max(...progress) * 100)}%）`;
  });

  await test('読み取り中にキャンセルでき、そのあともワーカーを作り直して読み取れる', async () => {
    const big = await toBlob(drawPage(1568, 2090));
    const now = Date.now();
    await db.put('pages', { id: 'c1', bookId: 'b1', image: big, thumb: big, comment: '', tagIds: [], ocrStatus: 'none', ocrText: '', editedText: { ocr: '', paste: '' }, pasteText: '', textSource: null, createdAt: now + 100, updatedAt: now });
    const running = new Promise((res) => {
      const off = ocr.onOcrProgress((pid) => { if (pid === 'c1') { off(); res(); } });
    });
    await ocr.enqueue('c1');
    await running;
    const t0 = performance.now();
    await ocr.cancel('c1');
    const cancelMs = Math.round(performance.now() - t0);
    await new Promise((r) => setTimeout(r, 300));
    let p = await db.get('pages', 'c1');
    assert(p.ocrStatus === 'none' && !p.ocrText, `キャンセル後の状態 ${p.ocrStatus}`);
    const done = new Promise((res) => {
      const off = ocr.onOcrChange((q) => { if (q.id === 'c1' && (q.ocrStatus === 'done' || q.ocrStatus === 'failed')) { off(); res(); } });
    });
    await ocr.enqueue('c1');
    await done;
    p = await db.get('pages', 'c1');
    assert(p.ocrStatus === 'done' && p.ocrText.length > 10, `再実行の状態 ${p.ocrStatus} ${p.ocrError || ''}`);
    return `キャンセルにかかった時間 ${cancelMs}ms`;
  });


  // ---- 範囲選択とマーカーの追従 ----
  const BASE = 'しおりを挟んだページには、その日の気持ちが残っている。あとで開くと、読んだときの部屋の明るさまで思い出す。';
  const QUOTE = 'その日の気持ちが残っている。';
  const at0 = BASE.indexOf(QUOTE);
  const m0 = { id: 'x', ...makeAnchor(BASE, at0, at0 + QUOTE.length) };
  const follow = (newText, mark = m0, oldText = BASE) => {
    const r = reanchor(mark, oldText, newText);
    return { ...r, ok: isPlaced(r.mark, newText) && r.mark.quote === mark.quote };
  };

  await test('マーカー追従：範囲より前に文字を追加しても、同じ一文を指す', async () => {
    const t = '【第一章】' + BASE;
    const r = follow(t);
    assert(r.ok && r.how === 'shifted' && r.mark.start === at0 + 5, JSON.stringify(r));
    return `${at0} → ${r.mark.start}（差分でずらした）`;
  });

  await test('マーカー追従：範囲より前の文字を削除しても、同じ一文を指す', async () => {
    const t = BASE.replace('しおりを挟んだ', '');
    const r = follow(t);
    assert(r.ok && r.how === 'shifted' && r.mark.start === at0 - 7, JSON.stringify(r));
  });

  await test('マーカー追従：範囲より前を長さの違う文字に置き換えても、同じ一文を指す', async () => {
    const t = BASE.replace('ページ', '頁');
    const r = follow(t);
    assert(r.ok && r.how === 'shifted' && r.mark.start === at0 - 2, JSON.stringify(r));
  });

  await test('マーカー追従：範囲より後ろを直しても、位置は変わらない', async () => {
    const t = BASE.replace('部屋の明るさ', 'へやの明るさ');
    const r = follow(t);
    assert(r.ok && r.how === 'kept' && r.mark.start === at0, JSON.stringify(r));
  });

  await test('マーカー追従：同じ一文が2回出てくるとき、印を付けたほう（2回目）を指し続ける', async () => {
    const t2 = BASE + QUOTE + 'それでも本を閉じた。';
    const second = t2.lastIndexOf(QUOTE);
    const mark = { id: 'y', ...makeAnchor(t2, second, second + QUOTE.length) };
    // 1回目より前を直す → 差分でずらす
    const a = reanchor(mark, t2, '　' + t2);
    assert(isPlaced(a.mark, '　' + t2) && a.mark.start === second + 1, `前を直したとき ${a.mark.start}`);
    // 1回目を消す → ずらした位置で一致するので2回目のまま
    const t3 = t2.replace(QUOTE, '');
    const b = reanchor(mark, t2, t3);
    assert(isPlaced(b.mark, t3) && b.mark.start === t3.lastIndexOf(QUOTE), `1回目を消したとき ${b.mark.start}`);
    // 全文を貼り直して差分が使えないとき（前と後ろの両方が変わった）→ 前後の文字で2回目を選ぶ
    const t4 = 'まえがき。' + t2 + '（了）';
    const c = reanchor(mark, t2, t4);
    assert(c.how === 'found' && c.mark.start === t4.lastIndexOf(QUOTE), `貼り直したとき ${c.how} ${c.mark.start} / 2回目 ${t4.lastIndexOf(QUOTE)}`);
    return `前を直す→${a.how}、1回目を消す→${b.how}、貼り直し→${c.how}`;
  });

  await test('マーカー追従：全文を貼り直しても（一部の文字が違っても）、同じ一文を探し直す', async () => {
    const t = 'しおりをはさんだ頁には、' + QUOTE + 'あとでひらくと、読んだ時の部屋のあかるさまで思いだす。';
    const r = follow(t);
    assert(r.ok && r.how === 'found' && r.mark.start === t.indexOf(QUOTE), JSON.stringify(r));
  });

  await test('マーカー追従：選んだ文字列が文章からなくなったら「位置不明」として残す（消さない）', async () => {
    const t = BASE.replace(QUOTE, 'その日の心が、まだここにある。');
    const r = follow(t);
    assert(r.how === 'lost' && !isPlaced(r.mark, t) && r.mark.quote === QUOTE, JSON.stringify(r));
  });

  await test('マーカー追従：範囲の中の誤字を直したときは、直した後の文字列で範囲を保つ', async () => {
    const ocrish = BASE.replace('気持ち', '気持ぢ');
    const at = ocrish.indexOf('その日');
    const mark = { id: 'z', ...makeAnchor(ocrish, at, at + QUOTE.length) };
    const r = reanchor(mark, ocrish, BASE);
    assert(r.how === 'edited' && isPlaced(r.mark, BASE) && r.mark.quote === QUOTE, JSON.stringify(r));
  });

  await test('縦書き／横書きを切り替えても、文字の位置（範囲とマーカー）は同じ', async () => {
    const t = '𠮷野家の𩸽。' + QUOTE; // UTF-16 で2単位の文字を含む
    const el = document.createElement('div');
    const mk = [{ id: 'm', start: t.indexOf(QUOTE), end: t.indexOf(QUOTE) + 4, color: '#f6a5b9' }];
    renderText(el, t, { vertical: true, marks: mk, selection: { start: 0, end: 2 } });
    const v = [...el.querySelectorAll('span[data-i]')].map((x) => `${x.dataset.i}:${x.textContent}:${x.className}`);
    renderText(el, t, { vertical: false, marks: mk, selection: { start: 0, end: 2 } });
    const h = [...el.querySelectorAll('span[data-i]')].map((x) => `${x.dataset.i}:${x.textContent}:${x.className}`);
    assert(JSON.stringify(v) === JSON.stringify(h), '縦と横で位置が違う');
    assert(v[0] === '0:𠮷:sel' && v[1].startsWith('2:野'), `先頭: ${v.slice(0, 2)}`);
    assert(el.querySelectorAll('span.mk').length === 4, 'マーカーの文字数が違う');
  });

  await test('マーカーが重なっても、それぞれの色が見える', async () => {
    const el = document.createElement('div');
    renderText(el, BASE, { vertical: true, marks: [
      { id: 'a', start: 0, end: 10, color: '#f6a5b9' },
      { id: 'b', start: 5, end: 15, color: '#a9c8f2' },
    ] });
    const both = el.querySelector('span[data-i="6"]');
    assert(both.dataset.marks === 'a b' && /linear-gradient/.test(both.getAttribute('style')), both.outerHTML);
  });

  await test('マーカーを保存し、文章を手直しすると付け直され、消した一文は位置不明になる（保存形式はフェーズ5の完成形）', async () => {
    const now = Date.now();
    await db.put('pages', { id: 'mk1', bookId: 'b1', image: null, thumb: null, comment: '', tagIds: [], ocrStatus: 'none', ocrText: '', editedText: { ocr: '', paste: '' }, pasteText: BASE, textSource: 'paste', createdAt: now, updatedAt: now });
    const page = await db.get('pages', 'mk1');
    const a = await marksMod.addMark(page, BASE, at0, at0 + QUOTE.length);
    const second = BASE.indexOf('部屋の明るさ');
    const b = await marksMod.addMark(page, BASE, second, second + 6);
    const keys = Object.keys(a).sort().join(',');
    assert(keys === 'bookId,color,comment,createdAt,end,id,pageId,prefix,quote,start,suffix,tagIds,updatedAt', keys);
    assert(a.color === marksMod.DEFAULT_COLOR && a.tagIds.length === 0 && a.comment === '', '既定値が違う');
    assert((await db.getByIndex('marks', 'pageId', 'mk1')).length === 2, 'pageId の索引で引けない');

    // 前を手直しして「部屋の明るさ」を別の言葉にする
    const edited = '【一】' + BASE.replace('部屋の明るさ', '窓の色');
    const r = await marksMod.updatePageText('mk1', { editedText: { ocr: '', paste: edited } });
    const ms = await marksMod.marksOfPage('mk1');
    const A = ms.find((m) => m.id === a.id);
    const B = ms.find((m) => m.id === b.id);
    assert(isPlaced(A, edited) && A.start === at0 + 3, `一文目 ${A.start}`);
    assert(!isPlaced(B, edited) && B.quote === '部屋の明るさ', '消した一文が位置不明になっていない');
    // 1回の保存で前と後ろの2か所を直したので、差分は両方をまたぐ。一文目は探し直しで見つかる
    assert(r.moved.shifted + r.moved.found === 1 && r.moved.lost === 1, JSON.stringify(r.moved));

    // 付け直し（色・タグ・コメントは保つ）と削除
    const at = edited.indexOf('窓の色');
    await marksMod.reattachMark(B, edited, at, at + 3);
    const B2 = await db.get('marks', b.id);
    assert(isPlaced(B2, edited) && B2.quote === '窓の色' && B2.color === b.color, '付け直せていない');
    await marksMod.deleteMark(a.id);
    assert((await marksMod.marksOfPage('mk1')).length === 1, '削除できていない');
    return `付け直しの結果: ${JSON.stringify(r.moved)}`;
  });


  // ---- 前処理（切り抜き・傾き補正・二値化・ルビの除去）。見本は canvas で描いたルビ付きの縦書きのページ ----
  const grayOf = (canvas) => P.toGray(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  const hard = drawRubyPage({ skew: 1.5, shadow: true, outside: true });
  const HW = hard.canvas.width;
  const HH = hard.canvas.height;

  await test('前処理1：本文の範囲を自動で推定し、柱・ページ番号・ページの外を外す', async () => {
    const small = P.downscale(grayOf(hard.canvas), HW, HH, 800);
    const b = P.estimateTextBox(P.binarizeSauvola(small.g, small.w, small.h), small.w, small.h, true);
    const box = { x0: b.x0 / small.s, y0: b.y0 / small.s, x1: b.x1 / small.s, y1: b.y1 / small.s };
    const tol = hard.s * 0.6; // 傾き1.5度のぶんのずれを許す
    assert(box.y0 > hard.headerBottom, `柱が入っている（上端 ${Math.round(box.y0)} / 柱の下端 ${Math.round(hard.headerBottom)}）`);
    assert(box.x0 > hard.pageLeft, `ページの外が入っている（左端 ${Math.round(box.x0)} / ページの端 ${hard.pageLeft}）`);
    assert(box.x0 <= hard.body.x0 + tol && box.x1 >= hard.body.x1 - tol && box.y0 <= hard.body.y0 + tol && box.y1 >= hard.body.y1 - tol,
      `本文が欠けている 推定 ${[box.x0, box.y0, box.x1, box.y1].map(Math.round)} / 本文 ${[hard.body.x0, hard.body.y0, hard.body.x1, hard.body.y1].map(Math.round)}`);
    return `推定 ${[box.x0, box.y0, box.x1, box.y1].map(Math.round).join(',')}・本文 ${[hard.body.x0, hard.body.y0, hard.body.x1, hard.body.y1].map(Math.round).join(',')}`;
  });

  await test('前処理2：傾き（1.5度）を推定して補正すると、行がほぼ垂直になる', async () => {
    const res = P.runPipeline(grayOf(hard.canvas), HW, HH, { crop: 'auto', deskew: true, vertical: true });
    const sm = P.downscale(res.g, res.w, res.h, 900);
    const after = P.estimateSkew(P.binarizeSauvola(sm.g, sm.w, sm.h), sm.w, sm.h, true);
    // 自動の切り抜きの段階で傾きを推定して直し（autoAngle）、残ったぶんを傾き補正の段階で直す（angle）
    const total = res.info.autoAngle + (res.info.angle || 0);
    assert(Math.abs(total) >= 1 && Math.abs(total) <= 2, `推定した角度 ${res.info.autoAngle} + ${res.info.angle}`);
    assert(Math.abs(after) <= 0.3, `補正後に残った傾き ${after}`);
    return `推定 ${res.info.autoAngle}度（切り抜きの段階）＋ ${res.info.angle}度（残り）→ 補正後に残った傾き ${after}度`;
  });

  await test('前処理2b：大きな傾き（8度）も推定して補正できる（探す範囲は±10度）', async () => {
    const big = drawRubyPage({ w: 1500, h: 2000, skew: 8, shadow: true, outside: true });
    const W = big.canvas.width;
    const H = big.canvas.height;
    const res = P.runPipeline(grayOf(big.canvas), W, H, { crop: 'auto', deskew: true, vertical: true });
    const sm = P.downscale(res.g, res.w, res.h, 900);
    const after = P.estimateSkew(P.charInk(P.binarizeSauvola(sm.g, sm.w, sm.h), sm.w, sm.h), sm.w, sm.h, true);
    // 範囲の推定の段階で8度前後と推定できること。四隅を写真の内側に収めて引き伸ばすので、残りの補正（angle）は0にならないことがある
    assert(Math.abs(Math.abs(res.info.autoAngle) - 8) <= 0.5, `推定した角度 ${res.info.autoAngle}`);
    assert(Math.abs(after) <= 0.4, `補正後に残った傾き ${after}`);
    return `推定 ${res.info.autoAngle}度 ＋ ${res.info.angle}度 → 補正後に残った傾き ${after}度`;
  });

  await test('前処理2c：ページの端の線・指のような大きな黒いかたまりがあっても、傾きは文字の列で推定する', async () => {
    const pg = drawRubyPage({ w: 1500, h: 2000, skew: 3 });
    const g2 = pg.canvas.getContext('2d');
    g2.fillStyle = '#111';
    g2.fillRect(1380, 0, 6, 2000);        // まっすぐなページの端の線
    g2.fillRect(1300, 1500, 200, 500);    // 指
    g2.fillRect(0, 1850, 1500, 150);      // ページの外の暗い部分
    const W = pg.canvas.width;
    const H = pg.canvas.height;
    const sm = P.downscale(grayOf(pg.canvas), W, H, 800);
    const ink = P.binarizeSauvola(sm.g, sm.w, sm.h);
    const plain = P.estimateSkew(ink, sm.w, sm.h, true);
    const chars = P.estimateSkew(P.charInk(ink, sm.w, sm.h), sm.w, sm.h, true);
    assert(Math.abs(Math.abs(chars) - 3) <= 0.5, `文字のかたまりだけで推定した角度 ${chars}（そのままだと ${plain}）`);
    return `文字のかたまりだけ ${chars}度 ／ そのまま ${plain}度（正しくは3度）`;
  });

  await test('範囲の自動推定：本文が見つからないときは found が false になる（写真全体を黙って使わない）', async () => {
    const c = document.createElement('canvas');
    c.width = 900; c.height = 1200;
    const g = c.getContext('2d');
    g.fillStyle = '#ece6da'; g.fillRect(0, 0, 900, 1200);
    for (let i = 0; i < 300; i++) { g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(Math.random() * 900, Math.random() * 1200, 2, 2); }
    const blank = P.autoQuad(grayOf(c), 900, 1200, true);
    const page = P.autoQuad(grayOf(hard.canvas), HW, HH, true);
    assert(blank.found === false, '文字のない紙で範囲が見つかったことになっている');
    assert(page.found === true, '本文のあるページで範囲が見つからない');
    return `文字のない紙：found ${blank.found} ／ 本文のあるページ：found ${page.found}`;
  });

  await test('手で指定した傾き：画面で右回りに回したのと同じ向きに回し、自動の傾き補正はしない', async () => {
    // 右上に黒い点のある画像を、同じ大きさのまま「右に20度」回すと、点は右下へ動く（CSS の rotate(20deg) と同じ）
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 200);
    g.fillStyle = '#000'; g.fillRect(140, 20, 20, 20);
    const r = P.runPipeline(grayOf(c), 200, 200, { rotate: 20, deskew: true, vertical: true });
    let sx = 0; let sy = 0; let n = 0;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.g[y * r.w + x] < 128) { sx += x; sy += y; n++; }
    const [cx, cy] = [sx / n, sy / n];
    // 中心からの位置 (50, -70) を右に20度回すと (70.9, -48.7)
    assert(r.w === 200 && r.h === 200, `大きさが変わった ${r.w}×${r.h}`);
    assert(Math.abs(cx - 170.9) < 3 && Math.abs(cy - 51.3) < 3, `点の位置 ${cx.toFixed(1)}, ${cy.toFixed(1)}`);
    assert(r.info.rotate === 20 && r.info.angle === undefined, JSON.stringify(r.info));
    return `点の中心 (${cx.toFixed(1)}, ${cy.toFixed(1)})（期待 170.9, 51.3）・自動の傾き補正なし`;
  });

  await test('読み取りが崩れているかもしれないとき（信頼度98未満の字が15%以上）を見分ける', async () => {
    const text = 'あ'.repeat(100);
    const lows = (n, c = 90) => Array.from({ length: n }, (_, i) => [i, c]);
    assert(!ocrLooksBroken({ ocrText: text, ocrLow: lows(9) }), '9%で崩れていると判断した');
    assert(!ocrLooksBroken({ ocrText: text, ocrLow: lows(14) }), '14%で崩れていると判断した');
    assert(ocrLooksBroken({ ocrText: text, ocrLow: lows(15) }), '15%で崩れていると判断しない');
    assert(!ocrLooksBroken({ ocrText: text, ocrLow: lows(30, 98.5) }), '信頼度98以上を数えた');
    assert(!ocrLooksBroken({ ocrText: 'あ'.repeat(30), ocrLow: lows(20) }), '短い文章で判断した');
  });

  await test('前処理3：影のある紙の部分を、Sauvola法は文字と間違えない（大津の方法と比べる）', async () => {
    const g = grayOf(hard.canvas);
    P.normalizeContrast(g);
    // 左下の影の中の、文字のない紙の部分
    const area = { x0: hard.pageLeft + 60, y0: Math.round(HH * 0.7), x1: Math.round(hard.body.x0 - 80), y1: HH - 60 };
    const ratio = (ink) => { let n = 0; let k = 0; for (let y = area.y0; y < area.y1; y++) for (let x = area.x0; x < area.x1; x++) { n++; k += ink[y * HW + x]; } return k / n; };
    const sauvola = ratio(P.binarizeSauvola(g, HW, HH));
    const otsu = ratio(P.binarizeOtsu(g));
    assert(sauvola < 0.01, `Sauvola でも ${(sauvola * 100).toFixed(1)}% が黒`);
    return `影の中の紙が黒になった割合：Sauvola ${(sauvola * 100).toFixed(2)}% ／ 大津 ${(otsu * 100).toFixed(1)}%`;
  });

  await test('前処理4：ルビの帯だけを消し、本文（小さい「っ」「ゃ」や句読点を含む）の画素は1つも消さない', async () => {
    const flat = drawRubyPage({ header: false });
    const W = flat.canvas.width;
    const H = flat.canvas.height;
    const g = grayOf(flat.canvas);
    const ink = P.binarizeSauvola(g, W, H);
    const before = ink.slice();
    const r = P.removeRuby(ink, W, H, true);
    const count = (arr, rect) => { let k = 0; for (let y = Math.max(0, Math.floor(rect.y0)); y < Math.min(H, Math.ceil(rect.y1)); y++) for (let x = Math.max(0, Math.floor(rect.x0)); x < Math.min(W, Math.ceil(rect.x1)); x++) k += arr[y * W + x]; return k; };
    let rubyBefore = 0; let rubyAfter = 0;
    for (const rr of flat.ruby) { rubyBefore += count(before, rr); rubyAfter += count(ink, rr); }
    // 本文の文字の枠（句読点は枠の右上にはみ出すので、そのぶん広げて数える）
    let bodyBefore = 0; let bodyAfter = 0; let smallBefore = 0; let smallAfter = 0;
    for (const c of flat.cells) {
      const rect = { x0: c.x0 - 2, y0: c.y0 - flat.s * 0.45, x1: c.x1 + 2, y1: c.y1 };
      const b0 = count(before, rect); const b1 = count(ink, rect);
      bodyBefore += b0; bodyAfter += b1;
      if ('っゃゅょ、。'.includes(c.ch)) { smallBefore += b0; smallAfter += b1; }
    }
    assert(r.removed.length >= flat.ruby.length / 2, `消した帯 ${r.removed.length}`);
    assert(rubyAfter / rubyBefore < 0.05, `ルビが ${Math.round((rubyAfter / rubyBefore) * 100)}% 残っている`);
    assert(bodyAfter === bodyBefore && smallAfter === smallBefore, `本文の画素が消えた（${bodyBefore} → ${bodyAfter}、小さい文字と句読点 ${smallBefore} → ${smallAfter}）`);
    return `行の幅 ${r.lineWidth}px・消した帯 ${r.removed.length}本・ルビの画素 ${rubyBefore} → ${rubyAfter}・本文の画素 ${bodyBefore} → ${bodyAfter}（小さい文字と句読点 ${smallBefore} → ${smallAfter}）`;
  });

  await test('四隅で囲んだ範囲を長方形に引き伸ばす（射影変換）', async () => {
    const W = 400; const H = 300;
    const g = new Uint8ClampedArray(W * H).fill(255);
    for (let y = 100; y < 200; y++) for (let x = 100; x < 300; x++) g[y * W + x] = 0; // 真ん中の黒い長方形
    const out = P.warpQuad(g, W, H, [[100, 100], [300, 100], [300, 200], [100, 200]]);
    let black = 0;
    for (let i = 0; i < out.g.length; i++) black += out.g[i] < 128 ? 1 : 0;
    assert(out.w === 200 && out.h === 100 && black / out.g.length > 0.95, `大きさ ${out.w}×${out.h}・黒 ${Math.round((black / out.g.length) * 100)}%`);
  });

  await test('前処理の効果：傾き・影・柱・ページの外・ルビのある見本で、前処理なしと1〜4を比べる', async () => {
    const blob = await toBlob(hard.canvas, 'image/jpeg', 0.9);
    const rows = [];
    for (const [name, pre] of [['なし', {}], ['1〜3', { crop: 'auto', deskew: true, binarize: 'sauvola' }], ['1〜4', { crop: 'auto', deskew: true, binarize: 'sauvola', removeRuby: true }]]) {
      for (const psm of ['5', '3']) {
        const r = await ocr.recognize(blob, 'vertical', { psm, pre });
        rows.push({ name, psm, score: similarity(r.text, RUBY_TRUTH), leak: RUBY_STRINGS.filter((x) => r.text.includes(x)).length });
      }
    }
    const all = rows.filter((r) => r.name === '1〜4');
    assert(all.every((r) => r.score >= 0.9 && r.leak === 0), JSON.stringify(rows));
    return rows.map((r) => `${r.name}・PSM${r.psm}：${Math.round(r.score * 100)}%（ルビの混入 ${r.leak}）`).join(' ／ ');
  });


  // ---- 読み取りの自信が低い文字の印・縦棒の置き換え・かかった時間 ----
  // 自動修正：文字の位置の情報なしで呼ぶと、縦棒はすべて短いものとして扱う
  const fixText = (s) => ocr.fixVertical(s).text;
  const checkCases = (cases) => {
    for (const [a, b] of cases) assert(fixText(a) === b, `${a} → ${fixText(a)}（期待 ${b}）`);
    return cases.map(([a, b]) => (a === b ? `${a}（そのまま）` : `${a}→${b}`)).join('　');
  };

  await test('自動修正：短い縦棒「|」は、直前がカタカナなら「ー」、それ以外は「一」にする', async () =>
    checkCases([['ス|パ|', 'スーパー'], ['第|章', '第一章'], ['|つの道', '一つの道'], ['ア||', 'アーー'], ['ｶ|ﾄﾞ', 'ｶーﾄﾞ'], ['、|投', '、一投'], ['全角｜も', '全角一も']]));

  await test('自動修正：縦棒は、字2つ分ほど（字の大きさの1.6倍以上）の長さなら「——」にし、後ろの空白を除く', async () => {
    const raw = 'あって| 考え';
    const run = (ratio) => ocr.fixVertical(raw, { barRatio: new Map([[3, ratio]]) });
    const long = run(2.05);
    assert(long.text === 'あって——考え', long.text);
    assert(run(1.59).text === 'あって一考え', run(1.59).text);
    assert(run(0.8).text === 'あって一考え', run(0.8).text);
    assert(ocr.fixVertical('コ|ヒ|', { barRatio: new Map([[1, 0.9]]) }).text === 'コーヒー', '長音');
    assert(JSON.stringify(long.fixed) === JSON.stringify([[3, '|'], [4, '|']]), JSON.stringify(long.fixed));
    assert(long.map[4] === -1 && long.map[5] === 5, `位置の対応 ${[...long.map]}`);
    return '2.05倍→「——」・1.59倍→「一」・0.8倍→「一」';
  });

  await test('自動修正：縦棒の長さを前処理した画像の上で測る（見本：ダッシュ1本と「一」）', async () => {
    // 字の大きさ40の縦書きの列を描き、長さ84の縦線（ダッシュ）と、短い縦線（長さ30）を置く
    const c = new OffscreenCanvas(200, 400);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 400);
    g.fillStyle = '#000';
    g.fillRect(98, 100, 4, 84); // ダッシュ
    g.fillRect(98, 260, 4, 30); // 短い線
    g.fillRect(80, 20, 40, 40); // 字（大きさの目安）
    const blob = await c.convertToBlob({ type: 'image/png' });
    const raw = '字|字|';
    const symbols = [
      { text: '字', wtext: '字', wbox: { x0: 80, x1: 120, y0: 20, y1: 60 } },
      { text: '|', wtext: '|', wbox: { x0: 97, x1: 103, y0: 130, y1: 150 } }, // 枠は線より短く出る（実際の Tesseract.js と同じ）
      { text: '字', wtext: '字', wbox: { x0: 80, x1: 120, y0: 200, y1: 240 } },
      { text: '|', wtext: '|', wbox: { x0: 97, x1: 103, y0: 268, y1: 282 } },
    ];
    const ratios = await ocr.measureBars(blob, raw, symbols, ocr.alignSymbols(raw, symbols));
    assert(Math.abs(ratios.get(1) - 2.1) < 0.1 && Math.abs(ratios.get(3) - 0.75) < 0.1, JSON.stringify([...ratios]));
    return `ダッシュ ${ratios.get(1)}倍・短い線 ${ratios.get(3)}倍`;
  });

  await test('自動修正：「,」は「、」、「.」は「。」にする（英数字の間・カタカナの間の「.」・「...」はそのまま）', async () =>
    checkCases([
      ['考え出された,ありうる', '考え出された、ありうる'], ['終わった.次の', '終わった。次の'], ['だろう.', 'だろう。'],
      ['1,000円', '1,000円'], ['3.14の', '3.14の'], ['J.S.バッハ', 'J.S.バッハ'], ['アダム.スミス', 'アダム.スミス'],
      ['そして...', 'そして...'], ['Hello, world', 'Hello, world'], ['、,', '、,'],
    ]));

  await test('自動修正：「"」は句点の位置のときだけ「。」にする（判断の基準）', async () =>
    checkCases([
      // 直す：前がかな・漢字で、後ろがかな・漢字・かっこ・改行・終わり
      ['ならない"できる', 'ならない。できる'],
      ['ならない" できる', 'ならない。できる'], // Tesseract が記号の後に入れた空白は飛ばして見て、除く
      ['だろう"\n作家は', 'だろう。\n作家は'],
      ['言った"」と', '言った。」と'],
      ['終わり"', '終わり。'],
      // 直さない：前が句読点・かっこ・英数字・文章の始まり
      ['"始まり', '"始まり'], ['、"か', '、"か'], ['「"あ', '「"あ'], ['ABC"です', 'ABC"です'],
      // 直さない：後ろが句読点・英数字・記号
      ['あった"、', 'あった"、'], ['あった"。', 'あった"。'], ['あった"A', 'あった"A'], ['あった" A', 'あった" A'],
      // 直さない：近く（前後30字）に別の「"」がある＝引用の印の組（〝自由〟を読み違えたもの）
      ['彼は"自由"と言った', '彼は"自由"と言った'],
    ]));

  await test('自動修正：「人問」「時問」などの一覧の組み合わせだけを「間」に戻す（「質問」「学問」などは変えない）', async () => {
    const r = checkCases([
      ['ひとりの人問の物語', 'ひとりの人間の物語'], ['長い時問が', '長い時間が'], ['空問と瞬問', '空間と瞬間'],
      ['世問・期問・中問・年問', '世間・期間・中間・年間'], ['仲問と民問の週問', '仲間と民間の週間'], ['夜問も昼問も', '夜間も昼間も'],
      // 本当にある言葉は変えない
      ['質問と学問と疑問と訪問', '質問と学問と疑問と訪問'], ['設問・難問・尋問・顧問・反問', '設問・難問・尋問・顧問・反問'],
      // 一覧の2字でも、「問」の次の字で別の言葉とわかるものは変えない
      ['昼夜問わず', '昼夜問わず'], ['2000年問題', '2000年問題'], ['当時問題になった', '当時問題になった'], ['本人問い合わせ', '本人問い合わせ'], ['毎年問われる', '毎年問われる'],
      // 普通に使う字は直さない
      ['入る・ほら・入間', '入る・ほら・入間'],
    ]);
    // 一覧に「〇問」の形でない言葉や、本当にある言葉が入っていないこと
    const real = ['質問', '学問', '疑問', '訪問', '設問', '難問', '尋問', '顧問', '反問', '弔問', '審問', '拷問', '検問', '慰問', '詰問', '諮問', '愚問', '発問', '下問', '不問', '試問', '自問', '借問', '一問', '問問'];
    assert(MON_TO_MA.every((w) => w.length === 2 && w[1] === '問' && !real.includes(w)), MON_TO_MA.join(','));
    return r;
  });

  await test('自動修正：直した字の位置を記録し、信頼度の低い字とは別に印を付ける。手直しすると消える', async () => {
    const raw = 'ひとりの人問の物語であって| 考え出された,ありうる';
    const f = ocr.fixVertical(raw);
    assert(f.text === 'ひとりの人間の物語であって一考え出された、ありうる', f.text);
    assert(JSON.stringify(f.fixed) === JSON.stringify([[5, '問'], [13, '|'], [20, ',']]), JSON.stringify(f.fixed));
    const page = { textSource: 'ocr', ocrText: f.text, ocrFixed: f.fixed, ocrLow: [[5, 60], [8, 90]], editedText: { ocr: '', paste: '' } };
    assert([...autoFixedIn(page, f.text)].join(',') === '5,13,20', '直した字の印');
    const el = document.createElement('div');
    renderText(el, f.text, { vertical: true, low: lowConfIn(page, f.text, 98), fixed: autoFixedIn(page, f.text) });
    assert(el.querySelector('span[data-i="5"]').className === 'fix' && el.querySelector('span[data-i="8"]').className === 'low', el.innerHTML.slice(0, 200));
    const edited = f.text.replace('一考', '——考'); // 「一」を手で「——」に直した
    const left = [...autoFixedIn(page, edited)];
    assert(left.join(',') === '5,21', `手直し後 ${left}`);
    assert(autoFixedIn({ ...page, textSource: 'paste', pasteText: 'x' }, 'x').size === 0, '貼り付けの文章に印が出た');
  });

  await test('Tesseract の文字ごとの信頼度を、整形した文章の位置に対応づける（空白・改行は飛ばす）', async () => {
    const text = 'しおりを\n挟んだ AB';
    const syms = [...'しおりを挟んだAB'].map((ch, i) => ({ text: ch, conf: [99, 99, 62, 99, 99, 97.3, 99, 50, 99][i] }));
    const low = ocr.lowConfidence(text, syms);
    assert(JSON.stringify(low) === JSON.stringify([[2, 62], [6, 97.3], [9, 50]]), JSON.stringify(low));
  });

  await test('手直しした文字の印は消え、ほかの文字の印は位置をずらして残る', async () => {
    const page = { textSource: 'ocr', ocrText: 'すべての入間の生活は一つの道', ocrLow: [[4, 81], [10, 97.5], [12, 99]], editedText: { ocr: '', paste: '' } };
    assert([...lowConfIn(page, page.ocrText, 98)].join(',') === '4,10', '手直し前');
    assert([...lowConfIn(page, page.ocrText, 97)].join(',') === '4', '基準97');
    const fixed = '【序】すべての人間の生活は一つの道'; // 入→人 を直し、前に3文字足した
    assert([...lowConfIn(page, fixed, 98)].join(',') === '13', `手直し後 ${[...lowConfIn(page, fixed, 98)]}`);
    assert(lowConfIn({ ...page, textSource: 'paste', pasteText: 'x' }, 'x', 98).size === 0, '貼り付けの文章に印が出た');
    const m = alignMap('abcdef', 'abXdef');
    assert(m[2] === -1 && m[3] === 3 && m[0] === 0, JSON.stringify([...m]));
  });

  await test('文章の表示で、信頼度の低い文字に印のクラスが付く', async () => {
    const el = document.createElement('div');
    renderText(el, 'すべての入間', { vertical: true, low: new Set([4]) });
    assert(el.querySelector('span[data-i="4"]').classList.contains('low') && el.querySelectorAll('span.low').length === 1, el.innerHTML);
  });

  await test('裏で読み取ったページに、信頼度の低い文字とかかった時間が保存される', async () => {
    const image = await toBlob(drawPage(1200, 1600));
    const now = Date.now();
    await db.put('pages', { id: 'cf1', bookId: 'b1', image, thumb: image, comment: '', tagIds: [], ocrStatus: 'none', ocrText: '', editedText: { ocr: '', paste: '' }, pasteText: '', textSource: null, createdAt: now + 200, updatedAt: now });
    const done = new Promise((res) => { const off = ocr.onOcrChange((p) => { if (p.id === 'cf1' && (p.ocrStatus === 'done' || p.ocrStatus === 'failed')) { off(); res(); } }); });
    await ocr.enqueue('cf1');
    await done;
    const p = await db.get('pages', 'cf1');
    assert(Array.isArray(p.ocrLow) && p.ocrLow.every(([i, c]) => Number.isInteger(i) && i < p.ocrText.length && c < 99), `ocrLow ${JSON.stringify(p.ocrLow)?.slice(0, 80)}`);
    const tm = p.ocrTime;
    assert(tm && tm.total > 0 && tm.total >= tm.pre + tm.ocr && tm.ocr > 0, `ocrTime ${JSON.stringify(tm)}`);
    assert(!/[|｜]/.test(p.ocrText), '縦棒が残っている');
    assert(Array.isArray(p.ocrFixed), 'ocrFixed がない');
    return `かかった時間 ${(tm.total / 1000).toFixed(1)}秒（準備 ${tm.load}ms・前処理 ${tm.pre}ms・認識 ${tm.ocr}ms）・信頼度の低い文字 ${p.ocrLow.length}字`;
  });

  // ---- 共有の受け取り ----
  await test('共有で受け取った文章と画像を読み出して、消せる', async () => {
    const id = 'test' + Date.now().toString(36);
    const cache = await caches.open(share.SHARE_CACHE);
    const at = (n) => new URL(`./share-inbox/${id}/${n}`, location.href).href;
    const img = await toBlob(drawPage(300, 400));
    await cache.put(at('file-0'), new Response(img, { headers: { 'content-type': 'image/jpeg' } }));
    await cache.put(at('meta.json'), new Response(JSON.stringify({ id, title: '', text: '共有された一文', url: '', files: [{ name: 'a.jpg', type: 'image/jpeg' }] })));
    const got = await share.readShare(id);
    assert(share.sharedText(got) === '共有された一文', `文章: ${share.sharedText(got)}`);
    assert(got.files.length === 1 && got.files[0].size === img.size, '画像を読み出せない');
    await share.deleteShare(id);
    assert((await share.readShare(id)) === null, '消えていない');
  });



  await test('使う文章を切り替えても手直しは消えず、元に戻すと手直しも戻る。マーカーは切り替え先で探し直す', async () => {
    const now = Date.now();
    const ocrRaw = 'しおりを挟んだぺージには、その日の気持ちが残っている。';      // 読み取りの誤り（ぺ）
    const ocrFixed = 'しおりを挟んだページには、その日の気持ちが残っている。';
    const paste = '（レンズ）しおりを挟んだページには、その日の気持ちが残っている。あとで開くと思い出す。';
    await db.put('pages', { id: 'sw1', bookId: 'b1', image: null, thumb: null, comment: '', tagIds: [], ocrStatus: 'done',
      ocrText: ocrRaw, editedText: { ocr: ocrFixed, paste: '' }, pasteText: paste, textSource: 'ocr', createdAt: now, updatedAt: now });
    let page = await db.get('pages', 'sw1');
    assert(ocr.adoptedText(page).text === ocrFixed, '読み取り結果の手直しが出ていない');
    const at = ocrFixed.indexOf(QUOTE);
    const m = await marksMod.addMark(page, ocrFixed, at, at + QUOTE.length);

    let r = await marksMod.updatePageText('sw1', { textSource: 'paste' });       // 貼り付けに切り替え
    page = await db.get('pages', 'sw1');
    assert(ocr.adoptedText(page).text === paste && editedOf(page, 'ocr') === ocrFixed, '切り替えたら手直しが消えた');
    let mk = await db.get('marks', m.id);
    assert(marksMod.isPlaced(mk, paste) && mk.start === paste.indexOf(QUOTE), `切り替え先で探し直していない ${JSON.stringify(r.moved)}`);

    // 貼り付けの側も手直しする（読み取り結果の手直しは別に残る）
    const pasteFixed = paste.replace('（レンズ）', '');
    r = await marksMod.updatePageText('sw1', (cur) => ({ editedText: { ...cur.editedText, paste: pasteFixed } }));
    page = await db.get('pages', 'sw1');
    assert(editedOf(page, 'paste') === pasteFixed && editedOf(page, 'ocr') === ocrFixed, '手直しが混ざった');

    r = await marksMod.updatePageText('sw1', { textSource: 'ocr' });             // 読み取り結果に戻す
    page = await db.get('pages', 'sw1');
    assert(ocr.adoptedText(page).text === ocrFixed, '戻したのに読み取り結果の手直しが戻らない');
    mk = await db.get('marks', m.id);
    assert(marksMod.isPlaced(mk, ocrFixed) && mk.start === at, 'マーカーが元の位置に戻らない');
    await marksMod.updatePageText('sw1', { textSource: 'paste' });
    assert(ocr.adoptedText(await db.get('pages', 'sw1')).text === pasteFixed, '貼り付けの手直しが戻らない');
    return '読み取り結果の手直し・貼り付けの手直しとも、切り替えて戻すと戻る';
  });

  await test('試作段階の形（editedText が1つの文字列）でも、使っていた側の手直しとして読める', async () => {
    const p = { textSource: 'paste', pasteText: '原文', ocrText: '読み取り', editedText: '直した文' };
    assert(ocr.adoptedText(p).text === '直した文' && editedOf(p, 'ocr') === '', JSON.stringify(ocr.adoptedText(p)));
  });

  // ---- バックアップ ----
  await test('バックアップ v2：書き出す → データを消す → 読み込むで、写真・全文・マーカー・設定が完全に戻る', async () => {
    await db.setSetting('ocrPsmVertical', '3');
    const snapshot = async () => {
      const [books, tags, pages, marks, settings] = await Promise.all(['books', 'tags', 'pages', 'marks', 'settings'].map((s) => db.getAll(s)));
      const norm = async (p) => ({ ...p, image: p.image ? await sha256(p.image) : null, thumb: p.thumb ? await sha256(p.thumb) : null });
      const byId = (a, b) => String(a.id || a.key).localeCompare(String(b.id || b.key));
      return JSON.stringify({
        books: books.sort(byId), tags: tags.sort(byId), pages: (await Promise.all(pages.map(norm))).sort(byId),
        marks: marks.sort(byId), settings: settings.filter((x) => x.key !== 'ocrReady').sort(byId),
      });
    };
    const before = await snapshot();
    const counts = JSON.parse(before);
    assert(counts.pages.some((p) => p.image) && counts.pages.some((p) => !p.image) && counts.marks.length > 0, '確かめるデータが足りない');
    const file = JSON.parse(JSON.stringify(await exportBackup())); // ファイルに書いて読み戻すのと同じ
    assert(file.version === 2 && !file.settings.some((x) => x.key === 'ocrReady'), '形式が違う');
    await db.closeDatabase();
    await deleteDb(TEST_DB);
    assert((await db.getAll('pages')).length === 0, '消えていない');
    await importBackup(file);
    const after = await snapshot();
    assert(after === before, '戻したデータが違う');
    const a = JSON.parse(after);
    return `本${a.books.length}・ページ${a.pages.length}（写真なし${a.pages.filter((p) => !p.image).length}）・タグ${a.tags.length}・マーカー${a.marks.length}・設定${a.settings.length}`;
  });

  await test('version 1 のバックアップ（旧版の書き出し）も読み込める', async () => {
    const img = await toBlob(drawPage(300, 400));
    const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(img); });
    const v1 = {
      app: 'hon-shiori', version: 1, exportedAt: Date.now(),
      books: [{ id: 'v1b', title: '旧版の本', author: '', favoritePageId: null, createdAt: 1, updatedAt: 1 }],
      tags: [{ id: 'v1t', name: '旧タグ', color: '#f6a5b9', createdAt: 1 }],
      pages: [{ id: 'v1p', bookId: 'v1b', image: dataUrl, thumb: dataUrl, comment: '旧版のメモ', tagIds: ['v1t'], createdAt: 1, updatedAt: 1 }],
    };
    const info = await importBackup(JSON.parse(JSON.stringify(v1)));
    const p = await db.get('pages', 'v1p');
    assert(info.version === 1 && p.comment === '旧版のメモ' && p.tagIds[0] === 'v1t', JSON.stringify(info));
    assert((await sha256(p.image)) === (await sha256(img)), '写真が違う');
    assert(ocr.adoptedText(p).text === '' && (await db.get('books', 'v1b')).title === '旧版の本', '本か文章が違う');
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
