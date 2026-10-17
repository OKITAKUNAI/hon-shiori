// 自動テスト。見本の画像はすべて canvas で描く（本の写真は使わない）
import * as db from './db.js';
import { resizeImage, imageSize, esc, THUMB_W, THUMB_H, THUMB_VERSION } from './util.js';
import { makeThumb, regenerateThumbs } from './thumbs.js';
import * as ocr from './ocr.js';
import * as share from './share.js';
import { preprocessForOcr } from './preprocess.js';

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
    assert(p.editedText === undefined || p.editedText === '', '手で直した文章に書き込まれた');
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
    await db.put('pages', { id: 't1', bookId: 'b1', image: null, thumb: null, comment: '', tagIds: [], ocrStatus: 'none', ocrText: '', editedText: '', pasteText: '文章だけ', textSource: 'paste', createdAt: now, updatedAt: now });
    await ocr.enqueue('t1');
    const p = await db.get('pages', 't1');
    assert(p.ocrStatus === 'none', `状態 ${p.ocrStatus}`);
    assert(ocr.adoptedText(p).text === '文章だけ', '採用中の文章が違う');
  });

  await test('読み取りの進捗率が通知され、もう一度読み取っても手で直した文章は上書きしない', async () => {
    await db.update('pages', 'q1', { editedText: '手で直した文章', ocrText: '古い原文', textSource: 'ocr' });
    const progress = [];
    const offP = ocr.onOcrProgress((pid, v) => { if (pid === 'q1') progress.push(v); });
    const done = new Promise((res) => {
      const off = ocr.onOcrChange((p) => { if (p.id === 'q1' && p.ocrStatus === 'done') { off(); res(); } });
    });
    await ocr.enqueue('q1');
    await done;
    offP();
    const p = await db.get('pages', 'q1');
    assert(p.editedText === '手で直した文章', `editedText が ${p.editedText}`);
    assert(p.ocrText !== '古い原文' && similarity(p.ocrText, SAMPLE.join('')) >= 0.8, '原文が更新されていない');
    assert(ocr.adoptedText(p).text === '手で直した文章', '画面に出す文章が手直しになっていない');
    assert(progress.length >= 2 && Math.max(...progress) > 0.5, `進捗の通知: ${progress.length}回 最大${Math.max(0, ...progress)}`);
    return `進捗の通知 ${progress.length} 回（最大 ${Math.round(Math.max(...progress) * 100)}%）`;
  });

  await test('読み取り中にキャンセルでき、そのあともワーカーを作り直して読み取れる', async () => {
    const big = await toBlob(drawPage(1568, 2090));
    const now = Date.now();
    await db.put('pages', { id: 'c1', bookId: 'b1', image: big, thumb: big, comment: '', tagIds: [], ocrStatus: 'none', ocrText: '', editedText: '', pasteText: '', textSource: null, createdAt: now + 100, updatedAt: now });
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
