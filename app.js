import * as db from './db.js';
import { LS_PREFIX } from './config.js';
import {
  $, $$, esc, uid, TAG_COLORS, coverColor, resizeImage, blobToDataURL, dataURLToBlob,
  toast, debounce, THUMB_VERSION,
} from './util.js';
import { makeThumb, regenerateThumbs } from './thumbs.js';
import * as ocr from './ocr.js';
import * as share from './share.js';
import { renderText, makeZoomable } from './textview.js';

const app = $('#app');

// ---------- 小さな道具 ----------

let objectUrls = [];
function blobUrl(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
}

const pref = {
  get: (k, d) => { try { return localStorage.getItem(LS_PREFIX + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(LS_PREFIX + k, v); } catch {} },
};

const go = (hash) => { location.hash = hash; };

// 画面を離れるときに片づける処理（裏の処理の見張りなど）
let viewCleanups = [];
const onLeave = (fn) => viewCleanups.push(fn);

function tagChip(tag, on = false, extra = '') {
  return `<span class="chip ${on ? 'on' : ''}" style="--c:${tag.color}" ${extra}>${esc(tag.name)}</span>`;
}

// 入力用のダイアログ。保存なら値のオブジェクト、キャンセルなら null を返す
function formDialog({ title, fields, submit = '保存', danger }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    dlg.innerHTML = `
      <form method="dialog">
        <h3>${esc(title)}</h3>
        ${fields.map((f) => f.type === 'color' ? `
          <div class="field"><span class="label">${esc(f.label)}</span>
            <div class="swatches">${TAG_COLORS.map((c) => `
              <label class="swatch" style="--c:${c}"><input type="radio" name="${f.name}" value="${c}" ${c === f.value ? 'checked' : ''}><span></span></label>`).join('')}
            </div></div>` : f.type === 'select' ? `
          <label class="field"><span class="label">${esc(f.label)}</span>
            <select name="${f.name}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : `
          <label class="field"><span class="label">${esc(f.label)}</span>
            <input name="${f.name}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" ${f.required ? 'required' : ''} autocomplete="off"></label>`).join('')}
        <div class="row-end">
          ${danger ? `<button type="button" class="btn ghost danger" data-danger>${esc(danger)}</button><span class="grow"></span>` : ''}
          <button type="button" class="btn ghost" data-cancel>やめる</button>
          <button type="submit" class="btn primary">${esc(submit)}</button>
        </div>
      </form>`;
    document.body.append(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('[data-cancel]').onclick = () => done(null);
    dlg.querySelector('[data-danger]')?.addEventListener('click', () => done({ __danger: true }));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dlg.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      for (const k in data) if (typeof data[k] === 'string') data[k] = data[k].trim();
      done(data);
    };
    dlg.showModal();
    dlg.querySelector('input:not([type=radio])')?.focus();
  });
}

// 長い文章を入力するダイアログ。入力した文章（空なら null）を返す
function textDialog({ title, placeholder = '', value = '', submit = '保存' }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    dlg.innerHTML = `
      <h3>${esc(title)}</h3>
      <textarea rows="8" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
      <div class="row-end">
        <button type="button" class="btn ghost" data-paste>📋 貼り付け</button><span class="grow"></span>
        <button type="button" class="btn ghost" data-no>やめる</button>
        <button type="button" class="btn primary" data-yes>${esc(submit)}</button>
      </div>`;
    document.body.append(dlg);
    const ta = dlg.querySelector('textarea');
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('[data-no]').onclick = () => done(null);
    dlg.querySelector('[data-yes]').onclick = () => done(ta.value.trim() || null);
    dlg.querySelector('[data-paste]').onclick = async () => {
      try { ta.value += await navigator.clipboard.readText(); } catch { toast('欄を長押しして「貼り付け」を選んでください'); ta.focus(); }
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dlg.showModal();
    ta.focus();
  });
}

// はい／いいえを聞くダイアログ
function confirmDialog({ title, body, ok = 'OK', cancel = 'やめる' }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    dlg.innerHTML = `
      <h3>${esc(title)}</h3>
      <div class="small dlg-body">${body}</div>
      <div class="row-end">
        <button type="button" class="btn ghost" data-no>${esc(cancel)}</button>
        <button type="button" class="btn primary" data-yes>${esc(ok)}</button>
      </div>`;
    document.body.append(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('[data-no]').onclick = () => done(false);
    dlg.querySelector('[data-yes]').onclick = () => done(true);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    dlg.showModal();
  });
}

const PROGRESS_TEXT = {
  'loading tesseract core': '文字認識エンジンを読み込んでいます',
  'initializing tesseract': 'エンジンを準備しています',
  'loading language traineddata': '言語データをダウンロードしています',
  'initializing api': '仕上げています',
};

// 文字認識の言語データが端末にあるか確かめ、なければ容量を伝えて同意をもらってからダウンロードする
async function ensureOcrReady(mode) {
  if (await ocr.isReady(mode)) return true;
  const r = await ocr.readiness();
  const m = ocr.MODES[mode];
  const total = (r.engine ? 0 : ocr.ENGINE_MB) + m.sizeMB;
  const ok = await confirmDialog({
    title: `${m.label}の文字認識を使う準備`,
    ok: 'ダウンロードする',
    body: `
      <p>写真の文章をこのスマホの中で読み取るために、データをダウンロードします。</p>
      <ul class="dl-sizes">
        ${r.engine ? '' : `<li>文字認識エンジン（初回だけ）<b>約${ocr.ENGINE_MB}MB</b></li>`}
        <li>${m.label}用の言語データ <b>約${m.sizeMB}MB</b></li>
      </ul>
      <p>合計 <b>約${total.toFixed(1)}MB</b>。Wi-Fi でのダウンロードがおすすめです。<br>
      一度ダウンロードすれば、以後はオフラインでも使えます。写真や文章が外部に送られることはありません。</p>`,
  });
  if (!ok) return false;

  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<h3>ダウンロード中…</h3><p class="small" id="dlStatus">準備しています</p><div class="meter"><i id="dlBar"></i></div>`;
  document.body.append(dlg);
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.showModal();
  try {
    await ocr.prepare(mode, (msg) => {
      const label = PROGRESS_TEXT[msg.status];
      if (!label) return;
      const pct = Math.round((msg.progress || 0) * 100);
      dlg.querySelector('#dlStatus').textContent = `${label}… ${pct}%`;
      dlg.querySelector('#dlBar').style.width = pct + '%';
    });
    toast(`${m.label}の文字認識を使えるようになりました`);
    return true;
  } catch (e) {
    console.error(e);
    toast('ダウンロードできませんでした。通信状態を確かめて、もう一度試してください');
    return false;
  } finally {
    dlg.close();
    dlg.remove();
  }
}

const WRITING_MODE_OPTIONS = [['vertical', '縦書き（ふつうの小説など）'], ['horizontal', '横書き']];

// 写真の拡大表示。指で広げて拡大、ドラッグで移動、ダブルタップで拡大／元に戻す
function showImage(blob) {
  const dlg = document.createElement('dialog');
  dlg.className = 'viewer';
  dlg.innerHTML = `
    <div class="zoom-frame"><img src="${blobUrl(blob)}" alt="ページの写真"></div>
    <button type="button" class="viewer-close" aria-label="閉じる">✕</button>
    <p class="hint">指で広げて拡大・ダブルタップで拡大／元に戻す</p>`;
  document.body.append(dlg);
  makeZoomable(dlg.querySelector('.zoom-frame'), dlg.querySelector('img'));
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('.viewer-close').onclick = close;
  dlg.addEventListener('cancel', close);
  dlg.showModal();
}

async function newTag(name) {
  const tags = await db.getAll('tags');
  const exists = tags.find((t) => t.name === name);
  if (exists) return exists;
  const tag = { id: uid(), name, color: TAG_COLORS[tags.length % TAG_COLORS.length], createdAt: Date.now() };
  await db.put('tags', tag);
  return tag;
}

async function touchBook(bookId) {
  await db.update('books', bookId, { updatedAt: Date.now() });
}

// 写真をページとして保存する。保存が済んだら利用者はすぐ次へ進め、文字認識は裏で順番に行う
async function addPagesFromFiles(bookId, files, { pasteText = '' } = {}) {
  const book = await db.get('books', bookId);
  const auto = await db.getSetting('ocrAuto', true);
  const base = Date.now();
  const ids = [];
  for (const [i, file] of files.entries()) {
    try {
      const [image, thumb] = await Promise.all([resizeImage(file, 1568), makeThumb(file)]);
      const page = newPage(bookId, { image, thumb, thumbVersion: THUMB_VERSION, pasteText: i === 0 ? pasteText : '', createdAt: base + i });
      await db.put('pages', page);
      ids.push(page.id);
    } catch (err) {
      console.error(err);
      toast('読み込めない画像がありました');
    }
  }
  await touchBook(bookId);
  if (auto && ids.length) startAutoOcr(ids, ocr.pageMode({}, book)); // 待たずに戻る
  return ids;
}

// ページの項目（写真のないページは image / thumb が null）
function newPage(bookId, fields = {}) {
  const now = fields.createdAt || Date.now();
  return {
    id: uid(), bookId, image: null, thumb: null, thumbVersion: THUMB_VERSION, comment: '', tagIds: [],
    ocrStatus: 'none', ocrText: '', editedText: '', pasteText: '', textSource: null,
    writingMode: null, ocrLang: null, ocrPsm: null,
    createdAt: now, updatedAt: now,
    ...fields,
  };
}

// 写真のない、貼り付けた文章だけのページを作る
async function addTextPage(bookId, text) {
  const page = newPage(bookId, { pasteText: text, textSource: 'paste' });
  await db.put('pages', page);
  await touchBook(bookId);
  return page.id;
}

// 撮影・選択のあと自動で読み取る。初回だけは容量を伝えて同意をもらう（断られたら、この起動中は聞かない）
let ocrDeclinedThisSession = false;
async function startAutoOcr(ids, mode) {
  if (!(await ocr.isReady(mode))) {
    if (ocrDeclinedThisSession) return;
    if (!(await ensureOcrReady(mode))) { ocrDeclinedThisSession = true; return; }
  }
  for (const id of ids) await ocr.enqueue(id);
}

const OCR_BADGE = { queued: '⏳', running: '🔍', failed: '⚠️' };

// ページのカード。quote（マーカーした一文）を渡すと「ことば」表示（D案）になる：
// 一文を縦書きで大きく出し、マーカー色をアクセントに、写真は背景に薄く敷く
// 写真のないページは、マーカーがあれば代表の一文、なければ採用中の文章の冒頭を縦書きで出す（背景は紙の色）
function pageCard(p, { book, tagsById, isFav, quote } = {}) {
  const tags = (p.tagIds || []).map((id) => tagsById?.[id]).filter(Boolean);
  if (!p.thumb && !quote) quote = { text: ocr.adoptedText(p).text.slice(0, 80) || '（文章なし）', color: 'transparent' };
  const visual = quote
    ? `<div class="thumb words ${p.thumb ? '' : 'paper'}" style="--mc:${quote.color}">
        ${p.thumb ? `<img class="words-bg" src="${blobUrl(p.thumb)}" alt="" loading="lazy">` : ''}
        <p class="words-text">${esc(quote.text)}</p>`
    : `<div class="thumb"><img src="${blobUrl(p.thumb)}" alt="" loading="lazy">`;
  const badge = OCR_BADGE[p.ocrStatus];
  return `
    <a class="page-card" href="#/page/${p.id}" data-page="${p.id}">
      ${visual}${isFav ? '<span class="fav">★</span>' : ''}${badge ? `<span class="ocr-badge" title="${esc(ocr.STATUS_LABEL[p.ocrStatus])}">${badge}</span>` : ''}</div>
      ${book ? `<div class="pc-book">${esc(book.title)}</div>` : ''}
      ${p.comment ? `<div class="pc-comment">${esc(p.comment)}</div>` : ''}
      ${tags.length ? `<div class="dots">${tags.map((t) => `<i style="background:${t.color}" title="${esc(t.name)}"></i>`).join('')}</div>` : ''}
    </a>`;
}

// ---------- 本棚 ----------

async function viewShelf() {
  const [books, pages] = await Promise.all([db.getAll('books'), db.getAll('pages')]);
  const byBook = {};
  for (const p of pages) (byBook[p.bookId] ??= []).push(p);
  for (const k in byBook) byBook[k].sort((a, b) => a.createdAt - b.createdAt);

  const sort = pref.get('shelfSort', 'recent');
  books.sort(sort === 'title'
    ? (a, b) => a.title.localeCompare(b.title, 'ja')
    : (a, b) => b.updatedAt - a.updatedAt);

  const cover = (b) => {
    const ps = byBook[b.id] || [];
    // ★のページが写真のないページなら色付きの表紙。★がなければ、写真のある最初のページ
    const fav = ps.find((x) => x.id === b.favoritePageId);
    const p = fav ? (fav.thumb ? fav : null) : ps.find((x) => x.thumb);
    return p
      ? `<img src="${blobUrl(p.thumb)}" alt="">`
      : `<div class="placeholder" style="background:${coverColor(b.id)}"><span>📖</span><b>${esc(b.title)}</b></div>`;
  };

  app.innerHTML = `
    <header class="hero">
      <h1>ほんのしおり</h1>
      <p>好きなページを、そっとしまっておく場所</p>
    </header>
    ${books.length ? `
      <div class="toolbar">
        <span class="muted">${books.length}冊</span>
        <select id="sort" aria-label="並べ替え">
          <option value="recent" ${sort === 'recent' ? 'selected' : ''}>さいきん更新した順</option>
          <option value="title" ${sort === 'title' ? 'selected' : ''}>タイトル順</option>
        </select>
      </div>
      <div class="shelf">
        ${books.map((b) => `
          <a class="book-card" href="#/book/${b.id}">
            <div class="cover">${cover(b)}</div>
            <div class="b-title">${esc(b.title)}</div>
            <div class="b-meta">${b.author ? esc(b.author) + '・' : ''}${(byBook[b.id] || []).length}ページ</div>
          </a>`).join('')}
      </div>` : `
      <div class="empty">
        <div class="big">📚</div>
        <p>まだ本がありません。<br>右下の ＋ から、読んでいる本を追加しましょう。</p>
      </div>`}
    <button class="fab" id="addBook" aria-label="本を追加">＋</button>`;

  $('#sort')?.addEventListener('change', (e) => { pref.set('shelfSort', e.target.value); render(true); });
  $('#addBook').onclick = async () => {
    const v = await formDialog({
      title: '本を追加',
      submit: '追加',
      fields: BOOK_FIELDS(),
    });
    if (!v?.title) return;
    const book = await createBook(v);
    go('#/book/' + book.id);
  };
}

const BOOK_FIELDS = (book = {}) => [
  { name: 'title', label: 'タイトル', required: true, placeholder: '例：星の王子さま', value: book.title },
  { name: 'author', label: '著者（なくてもOK）', placeholder: '例：サン＝テグジュペリ', value: book.author },
  { name: 'writingMode', label: '文字の向き（文字認識に使います）', type: 'select', options: WRITING_MODE_OPTIONS, value: book.writingMode || 'vertical' },
];

async function createBook(v) {
  const now = Date.now();
  const book = {
    id: uid(), title: v.title, author: v.author || '', writingMode: v.writingMode || 'vertical',
    favoritePageId: null, createdAt: now, updatedAt: now,
  };
  await db.put('books', book);
  return book;
}

// ---------- 本のページ一覧 ----------

async function viewBook(id) {
  const book = await db.get('books', id);
  if (!book) return go('#/');
  const [pages, tags] = await Promise.all([db.pagesOfBook(id), db.getAll('tags')]);
  const tagsById = Object.fromEntries(tags.map((t) => [t.id, t]));

  app.innerHTML = `
    <div class="topbar"><a href="#/" class="back">‹ 本棚</a></div>
    <header class="book-head">
      <h2>${esc(book.title)}</h2>
      ${book.author ? `<p class="muted">${esc(book.author)}</p>` : ''}
      <div class="row">
        <button class="btn ghost small" id="editBook">✏️ 編集</button>
        <span class="muted small">${pages.length}ページ</span>
      </div>
    </header>

    <div class="add-row">
      <!-- Android では capture 付きの入力からギャラリーを選べないので、撮影と選択を分ける -->
      <label class="add-btn primary-add">
        <input type="file" accept="image/*" capture="environment" id="cameraInput" hidden>
        <span class="ap-icon">📷</span><b>撮る</b>
      </label>
      <label class="add-btn">
        <input type="file" accept="image/*" multiple id="photoInput" hidden>
        <span class="ap-icon">🖼️</span><b>写真から選ぶ</b>
      </label>
      <button type="button" class="add-btn" id="addText">
        <span class="ap-icon">📝</span><b>文章だけ</b>
      </button>
    </div>

    ${pages.length ? `
      <p class="muted small hint-line">★がついたページが本棚の表紙になります</p>
      <div class="pages">
        ${pages.map((p) => pageCard(p, { tagsById, isFav: p.id === book.favoritePageId })).join('')}
      </div>` : `
      <div class="empty small-empty"><p>好きなページを撮って、ここに集めましょう</p></div>`}`;

  const onFiles = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    toast(`${files.length}枚を保存しています…`);
    const ids = await addPagesFromFiles(id, files);
    if (files.length === 1 && ids[0]) go('#/page/' + ids[0]);
    else { toast(`${ids.length}枚追加しました`); render(true); }
  };
  $('#cameraInput').onchange = onFiles;
  $('#photoInput').onchange = onFiles;

  $('#addText').onclick = async () => {
    const text = await textDialog({ title: '文章だけのページを追加', placeholder: 'Googleレンズなどでコピーした文章を貼り付けます', submit: '追加' });
    if (!text) return;
    go('#/page/' + (await addTextPage(id, text)));
  };

  // 裏の文字認識の進み具合をカードの印に反映する
  onLeave(ocr.onOcrChange((p) => {
    if (p.bookId !== id) return;
    const card = document.querySelector(`[data-page="${p.id}"] .thumb`);
    if (!card) return;
    card.querySelector('.ocr-badge')?.remove();
    const badge = OCR_BADGE[p.ocrStatus];
    if (badge) card.insertAdjacentHTML('beforeend', `<span class="ocr-badge" title="${esc(ocr.STATUS_LABEL[p.ocrStatus])}">${badge}</span>`);
  }));

  $('#editBook').onclick = async () => {
    const v = await formDialog({
      title: '本の情報',
      danger: 'この本を削除',
      fields: BOOK_FIELDS(book),
    });
    if (!v) return;
    if (v.__danger) {
      if (!confirm(`『${book.title}』と、保存した${pages.length}ページをすべて削除します。よろしいですか？`)) return;
      for (const p of pages) await db.del('pages', p.id);
      await db.del('books', id);
      toast('削除しました');
      return go('#/');
    }
    await db.update('books', id, { title: v.title || book.title, author: v.author, writingMode: v.writingMode || 'vertical', updatedAt: Date.now() });
    render(true);
  };
}

// ---------- 1ページの詳細 ----------

const pageTextTab = new Map(); // ページごとに、最後に開いていた「読み取り結果／貼り付け」のタブ
const pageTextDir = new Map(); // ページごとの表示の向き（縦書き／横書き）。初期値はページの文字の向き
const SOURCE_LABEL = { ocr: '読み取り結果', paste: '貼り付け' };

function statusLabel(p) {
  if (p.ocrStatus === 'running' && ocr.currentProgress.pageId === p.id) return `読み取り中… ${Math.round(ocr.currentProgress.value * 100)}%`;
  return ocr.STATUS_LABEL[p.ocrStatus || 'none'];
}

function useButton(src, adopted) {
  return adopted === src
    ? '<span class="using">✓ この文章を使っています</span>'
    : `<button type="button" class="btn ghost small" data-use="${src}">この文章を使う</button>`;
}

async function viewPage(id) {
  const page = await db.get('pages', id);
  if (!page) return go('#/');
  const [book, siblings, tags] = await Promise.all([
    db.get('books', page.bookId), db.pagesOfBook(page.bookId), db.getAll('tags'),
  ]);
  tags.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const idx = siblings.findIndex((p) => p.id === id);
  const prev = siblings[idx - 1];
  const next = siblings[idx + 1];
  const isFav = book.favoritePageId === id;
  const status = page.ocrStatus || 'none';
  const hasOcr = !!page.ocrText?.trim();
  const hasPaste = !!page.pasteText?.trim();
  // 文章がまだ何もなければ「使用中」は出さない
  const adopted = hasOcr || hasPaste ? ocr.adoptedText(page).source : null;
  const bookMode = book.writingMode || 'vertical';
  const textTab = pageTextTab.get(id) || adopted || 'ocr';
  const shown = ocr.adoptedText(page);
  const vertical = (pageTextDir.get(id) || ocr.pageMode(page, book)) === 'vertical';

  // 変えた項目だけを書き込む（裏で作り直したサムネなどを古い値で上書きしないため）
  const save = async (patch) => {
    Object.assign(page, patch, { updatedAt: Date.now() });
    await db.update('pages', id, { ...patch, updatedAt: page.updatedAt });
  };

  app.innerHTML = `
    <div class="topbar">
      <a href="#/book/${book.id}" class="back">‹ ${esc(book.title)}</a>
      <span class="muted small">${idx + 1} / ${siblings.length}</span>
    </div>

    ${page.image ? `<figure class="photo" id="photo"><img src="${blobUrl(page.image)}" alt="ページの写真"></figure>` : ''}

    <div class="nav-row">
      ${prev ? `<a class="btn ghost small" href="#/page/${prev.id}">‹ 前</a>` : '<span class="btn ghost small disabled">‹ 前</span>'}
      <button class="btn fav-btn ${isFav ? 'on' : ''}" id="favBtn">${isFav ? '★ いちばん好きなページ' : '☆ いちばん好きにする'}</button>
      ${next ? `<a class="btn ghost small" href="#/page/${next.id}">次 ›</a>` : '<span class="btn ghost small disabled">次 ›</span>'}
    </div>

    <section class="card" id="textCard">
      <h3 class="sec">文章 ${page.image ? `<span class="ocr-chip st-${status}" id="ocrStatus">${esc(statusLabel(page))}</span>` : '<span class="ocr-chip">写真なし</span>'}</h3>
      <div class="text-bar">
        <div class="seg mini" role="group" aria-label="表示の向き">
          <button type="button" data-dir="vertical" class="${vertical ? 'on' : ''}">縦書き</button>
          <button type="button" data-dir="horizontal" class="${vertical ? '' : 'on'}">横書き</button>
        </div>
        <span class="grow"></span>
        ${page.image ? '<button type="button" class="btn ghost small" id="zoomPhoto">📷 写真</button>' : ''}
        <a class="btn soft small ${shown.text ? '' : 'disabled'}" href="#/page/${id}/edit">✏️ 直す</a>
      </div>
      <div class="textview" id="textView"></div>
      ${shown.text ? `<p class="tiny muted text-meta">元の文章：${SOURCE_LABEL[shown.source]}${shown.edited ? '（手直しあり）' : ''}</p>` : ''}
      <details class="sources" ${pageTextTab.has(id) ? 'open' : ''}>
        <summary>読み取り結果と貼り付け（原文）</summary>
      ${page.image ? `<div class="row text-tools">
        <label class="inline small">向き
          <select id="pageMode" aria-label="文字の向き">
            <option value="" ${page.writingMode ? '' : 'selected'}>本の設定（${ocr.MODES[bookMode].label}）</option>
            <option value="vertical" ${page.writingMode === 'vertical' ? 'selected' : ''}>縦書き</option>
            <option value="horizontal" ${page.writingMode === 'horizontal' ? 'selected' : ''}>横書き</option>
          </select>
        </label>
        ${status === 'queued' || status === 'running'
          ? '<button class="btn ghost small" id="ocrCancel">読み取りをやめる</button>'
          : `<button class="btn soft small" id="ocrRun">🔍 ${page.ocrText ? 'もう一度読み取る' : '文字を読み取る'}</button>`}
      </div>` : ''}
      <div class="seg" role="tablist">
        <button type="button" role="tab" data-tab="ocr" class="${textTab === 'ocr' ? 'on' : ''}">読み取り結果${adopted === 'ocr' ? '<i>使用中</i>' : ''}</button>
        <button type="button" role="tab" data-tab="paste" class="${textTab === 'paste' ? 'on' : ''}">貼り付け${adopted === 'paste' ? '<i>使用中</i>' : ''}</button>
      </div>
      <div data-pane="ocr" ${textTab === 'ocr' ? '' : 'hidden'}>
        <textarea id="ocrText" rows="6" readonly placeholder="${page.image ? '「文字を読み取る」を押すと、写真の文章をここに書き出します' : '写真のないページです'}">${esc(page.ocrText || '')}</textarea>
        ${status === 'failed' ? `<p class="tiny err">読み取れませんでした（${esc(page.ocrError || '原因不明')}）。もう一度試すか、貼り付けを使ってください。</p>` : ''}
        <div class="row">${hasOcr ? useButton('ocr', adopted) : ''}</div>
      </div>
      <div data-pane="paste" ${textTab === 'paste' ? '' : 'hidden'}>
        <textarea id="pasteText" rows="6" placeholder="Googleレンズなどでコピーした文章を、ここに貼り付けます">${esc(page.pasteText || '')}</textarea>
        <div class="row">
          <button type="button" class="btn ghost small" id="pasteBtn">📋 クリップボードから貼り付け</button>
          ${hasPaste ? useButton('paste', adopted) : ''}
        </div>
      </div>
      <span class="saved" id="textSaved"></span>
      </details>
    </section>

    <section class="card">
      <h3 class="sec">ひとことメモ <span class="saved" id="saved"></span></h3>
      <textarea id="comment" rows="3" placeholder="このページのどこが好き？">${esc(page.comment)}</textarea>
    </section>

    <section class="card">
      <h3 class="sec">タグ <a href="#/tags" class="small link">編集</a></h3>
      <div class="chips" id="tagChips">
        ${tags.map((t) => tagChip(t, page.tagIds.includes(t.id), `data-tag="${t.id}" role="button" tabindex="0"`)).join('')}
        <span class="chip add" id="addTag" role="button" tabindex="0">＋ 新しいタグ</span>
      </div>
    </section>

    <div class="row center"><button class="btn ghost danger small" id="delPage">このページを削除</button></div>`;

  $('#photo')?.addEventListener('click', () => showImage(page.image));
  $('#zoomPhoto')?.addEventListener('click', () => showImage(page.image));

  // --- 文章の表示（縦書き／横書き） ---
  const drawText = () => renderText($('#textView'), ocr.adoptedText(page).text, { vertical: pageTextDir.get(id) ? pageTextDir.get(id) === 'vertical' : vertical });
  drawText();
  for (const b of $$('[data-dir]')) {
    b.onclick = () => {
      pageTextDir.set(id, b.dataset.dir);
      for (const x of $$('[data-dir]')) x.classList.toggle('on', x === b);
      drawText();
    };
  }

  // --- 文章（読み取り結果・貼り付け） ---
  const textSavedMark = () => {
    const s = $('#textSaved');
    if (!s) return;
    s.textContent = '保存しました ✓';
    setTimeout(() => { if (s.isConnected) s.textContent = ''; }, 1500);
  };
  const savePasteText = debounce(async (v) => {
    // 貼り付けた文章があり、まだどちらも選んでいなければ貼り付けを使う
    await save({ pasteText: v, ...(page.textSource ? {} : { textSource: v.trim() ? 'paste' : null }) });
    textSavedMark();
  }, 600);
  $('#pasteText').oninput = (e) => savePasteText(e.target.value);

  for (const b of $$('[data-tab]', $('#textCard'))) {
    b.onclick = () => {
      pageTextTab.set(id, b.dataset.tab); // 原文の欄を開いたままにする
      for (const x of $$('[data-tab]', $('#textCard'))) x.classList.toggle('on', x === b);
      for (const p of $$('[data-pane]', $('#textCard'))) p.hidden = p.dataset.pane !== b.dataset.tab;
    };
  }
  for (const b of $$('[data-use]')) {
    b.onclick = async () => {
      // 手で直した文章があると、切り替えても画面の文章は変わらないので、手直しを外してよいか確かめる
      if (page.editedText && !(await confirmDialog({
        title: '使う文章を切り替えますか？',
        ok: '切り替える',
        body: '<p>このページには手で直した文章があります。切り替えると<b>手で直した文章は使われなくなり（消えます）</b>、切り替え先の原文を表示します。</p><p>マーカーは切り替え先の文章の中で位置を探し直します。見つからないものは「位置不明」になります。</p>',
      }))) return;
      await save({ textSource: b.dataset.use, editedText: '' });
      toast(b.dataset.use === 'ocr' ? '読み取り結果を使います' : '貼り付けた文章を使います');
      render(true);
    };
  }
  $('#pasteBtn').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) return toast('クリップボードが空です');
      const ta = $('#pasteText');
      ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, '\n') + t : t;
      savePasteText(ta.value);
    } catch {
      toast('欄を長押しして「貼り付け」を選んでください');
      $('#pasteText').focus();
    }
  };

  $('#ocrCancel')?.addEventListener('click', async () => {
    await ocr.cancel(id);
    toast('読み取りをやめました');
  });

  // 読み取り中の進捗率
  onLeave(ocr.onOcrProgress((pid, v) => {
    const chip = $('#ocrStatus');
    if (pid === id && chip) chip.textContent = `読み取り中… ${Math.round(v * 100)}%`;
  }));

  $('#pageMode')?.addEventListener('change', async (e) => {
    await save({ writingMode: e.target.value || null });
    toast('向きを変えました。「もう一度読み取る」で読み直せます');
  });

  $('#ocrRun')?.addEventListener('click', async () => {
    const mode = ocr.pageMode(page, book);
    if (page.ocrText?.trim() && !(await confirmDialog({
      title: 'もう一度読み取りますか？',
      body: '<p>読み取り結果（原文）が新しい結果に置き換わります。手で直した文章と貼り付けた文章はそのままです。</p>',
      ok: '読み取る',
    }))) return;
    if (!(await ensureOcrReady(mode))) return;
    await ocr.enqueue(id);
    toast('読み取りを始めました。ほかの操作をしていて大丈夫です');
  });

  // 裏の文字認識の進み具合を反映。入力中なら書きかけを壊さないよう、状態の表示と空欄だけ更新する
  onLeave(ocr.onOcrChange((p) => {
    if (p.id !== id) return;
    Object.assign(page, { ocrStatus: p.ocrStatus, ocrText: p.ocrText, ocrError: p.ocrError, textSource: p.textSource, editedText: p.editedText });
    const typing = document.activeElement?.matches?.('#textCard textarea, #comment');
    if (!typing) return render(true);
    const chip = $('#ocrStatus');
    if (chip) { chip.className = `ocr-chip st-${p.ocrStatus}`; chip.textContent = statusLabel(p); }
    const ta = $('#ocrText');
    if (p.ocrStatus === 'done' && ta && document.activeElement !== ta) ta.value = p.ocrText || '';
  }));

  $('#favBtn').onclick = async () => {
    await db.update('books', book.id, { favoritePageId: isFav ? null : id, updatedAt: Date.now() });
    toast(isFav ? '表紙をもとに戻しました' : '本棚の表紙にしました ★');
    render(true);
  };

  const savedMark = () => {
    $('#saved').textContent = '保存しました ✓';
    setTimeout(() => { const s = $('#saved'); if (s) s.textContent = ''; }, 1500);
  };
  const saveComment = debounce(async (v) => { await save({ comment: v }); await touchBook(book.id); savedMark(); }, 600);
  $('#comment').oninput = (e) => saveComment(e.target.value);

  const toggleTag = async (tagId, el) => {
    const on = page.tagIds.includes(tagId);
    await save({ tagIds: on ? page.tagIds.filter((t) => t !== tagId) : [...page.tagIds, tagId] });
    el.classList.toggle('on', !on);
  };
  for (const el of $$('[data-tag]')) {
    el.onclick = () => toggleTag(el.dataset.tag, el);
    el.onkeydown = (e) => { if (e.key === 'Enter') toggleTag(el.dataset.tag, el); };
  }
  $('#addTag').onclick = async () => {
    const v = await formDialog({
      title: '新しいタグ', submit: '作ってつける',
      fields: [{ name: 'name', label: 'タグの名前', required: true, placeholder: '例：心に刺さった' }],
    });
    if (!v?.name) return;
    const tag = await newTag(v.name);
    if (!page.tagIds.includes(tag.id)) await save({ tagIds: [...page.tagIds, tag.id] });
    render(true);
  };

  $('#delPage').onclick = async () => {
    if (!confirm('このページを削除しますか？（写真とメモも消えます）')) return;
    await db.del('pages', id);
    if (isFav) await db.update('books', book.id, { favoritePageId: null, updatedAt: Date.now() });
    toast('削除しました');
    go('#/book/' + book.id);
  };
}

// ---------- 文章の手直し ----------
// 上半分に元の写真（指で拡大）、下半分に横書きの入力欄。入力が止まって600ミリ秒後に自動で保存する。
// 手直しは editedText に保存し、原文（ocrText / pasteText）には触れない。原文と同じに戻したら editedText は空にする

async function viewEdit(id) {
  const page = await db.get('pages', id);
  if (!page) return go('#/');
  const shown = ocr.adoptedText(page);
  const original = ocr.sourceText(page, shown.source);

  app.innerHTML = `
    <div class="topbar">
      <a href="#/page/${id}" class="back">‹ ページに戻る</a>
      <span class="saved" id="editSaved"></span>
    </div>
    <div class="edit-screen ${page.image ? '' : 'no-photo'}">
      ${page.image ? `<div class="zoom-frame edit-photo" id="editPhoto"><img src="${blobUrl(page.image)}" alt="ページの写真"></div>
      <p class="tiny muted center">写真は指で広げて拡大・ダブルタップで拡大／元に戻す</p>` : ''}
      <div class="row edit-meta">
        <span class="small muted grow">元の文章：${SOURCE_LABEL[shown.source]} <span id="editState">${shown.edited ? '（手直しあり）' : ''}</span></span>
        <button type="button" class="btn ghost small" id="resetEdit" ${shown.edited ? '' : 'hidden'}>手直しを取り消す</button>
      </div>
      <textarea id="editText" spellcheck="false">${esc(shown.text)}</textarea>
    </div>`;

  if (page.image) makeZoomable($('#editPhoto'), $('#editPhoto img'));

  const ta = $('#editText');
  const mark = (msg) => {
    const el = $('#editSaved');
    if (!el) return;
    el.textContent = msg;
  };
  const write = async (value) => {
    const editedText = value === original ? '' : value;
    await db.update('pages', id, { editedText, updatedAt: Date.now() });
    await touchBook(page.bookId);
    mark('保存しました ✓');
    const state = $('#editState');
    if (state) state.textContent = editedText ? '（手直しあり）' : '';
    $('#resetEdit')?.toggleAttribute('hidden', !editedText);
  };
  const saveLater = debounce(write, 600);
  let dirty = false;
  ta.oninput = () => { dirty = true; mark('…'); saveLater(ta.value); };
  // 画面を離れるときに、まだ保存していない入力を書き込む
  onLeave(() => { if (dirty) { saveLater.cancel?.(); write(ta.value); } });

  $('#resetEdit').onclick = async () => {
    if (!(await confirmDialog({
      title: '手直しを取り消しますか？',
      ok: '取り消す',
      body: `<p>手で直した文章を消して、元の文章（${SOURCE_LABEL[shown.source]}）に戻します。</p>`,
    }))) return;
    ta.value = original;
    dirty = false;
    await write(original);
  };
}

// ---------- タグ一覧 ----------

async function viewTags() {
  const [tags, pages] = await Promise.all([db.getAll('tags'), db.getAll('pages')]);
  const count = {};
  for (const p of pages) for (const t of p.tagIds || []) count[t] = (count[t] || 0) + 1;
  const sort = pref.get('tagSort', 'name');
  tags.sort(sort === 'count'
    ? (a, b) => (count[b.id] || 0) - (count[a.id] || 0) || a.name.localeCompare(b.name, 'ja')
    : (a, b) => a.name.localeCompare(b.name, 'ja'));

  app.innerHTML = `
    <header class="hero small-hero"><h1>タグ</h1><p>テーマごとに、好きなページを見返す</p></header>
    <div class="toolbar">
      <button class="btn soft small" id="addTag">＋ 新しいタグ</button>
      ${tags.length ? `
        <select id="sort" aria-label="並べ替え">
          <option value="name" ${sort === 'name' ? 'selected' : ''}>名前順</option>
          <option value="count" ${sort === 'count' ? 'selected' : ''}>ページが多い順</option>
        </select>` : ''}
    </div>
    ${tags.length ? `
      <ul class="tag-list">
        ${tags.map((t) => `
          <li>
            <a href="#/tag/${t.id}" class="tag-row">
              <span class="dot" style="background:${t.color}"></span>
              <span class="grow">${esc(t.name)}</span>
              <span class="count">${count[t.id] || 0}</span>
            </a>
            <button class="icon-btn" data-edit="${t.id}" aria-label="${esc(t.name)}を編集">✏️</button>
          </li>`).join('')}
      </ul>` : `
      <div class="empty"><div class="big">🏷️</div><p>タグはまだありません。<br>「心に刺さった」「名言」「あとで読み返す」など、自由に作れます。</p></div>`}`;

  $('#sort')?.addEventListener('change', (e) => { pref.set('tagSort', e.target.value); render(true); });
  $('#addTag').onclick = async () => {
    const v = await formDialog({
      title: '新しいタグ', submit: '作る',
      fields: [{ name: 'name', label: 'タグの名前', required: true }],
    });
    if (v?.name) { await newTag(v.name); render(true); }
  };
  for (const btn of $$('[data-edit]')) {
    btn.onclick = () => editTag(tags.find((t) => t.id === btn.dataset.edit), count[btn.dataset.edit] || 0);
  }
}

async function editTag(tag, n) {
  const v = await formDialog({
    title: 'タグを編集',
    danger: '削除',
    fields: [
      { name: 'name', label: '名前', value: tag.name, required: true },
      { name: 'color', label: '色', type: 'color', value: tag.color },
    ],
  });
  if (!v) return;
  if (v.__danger) {
    if (!confirm(`タグ「${tag.name}」を削除しますか？${n ? `（${n}ページからはずれます。ページ自体は消えません）` : ''}`)) return;
    for (const p of await db.getAll('pages')) {
      if (p.tagIds?.includes(tag.id)) await db.update('pages', p.id, (cur) => ({ tagIds: cur.tagIds.filter((t) => t !== tag.id) }));
    }
    await db.del('tags', tag.id);
    toast('削除しました');
    return location.hash === '#/tags' ? render(true) : go('#/tags');
  }
  await db.update('tags', tag.id, { name: v.name || tag.name, color: v.color || tag.color });
  render(true);
}

// ---------- タグごとのページ ----------

async function viewTag(id) {
  const tag = await db.get('tags', id);
  if (!tag) return go('#/tags');
  const [pages, books, tags] = await Promise.all([db.getAll('pages'), db.getAll('books'), db.getAll('tags')]);
  const booksById = Object.fromEntries(books.map((b) => [b.id, b]));
  const tagsById = Object.fromEntries(tags.map((t) => [t.id, t]));
  const list = pages.filter((p) => p.tagIds?.includes(id));

  const sort = pref.get('tagPageSort', 'new');
  const sorters = {
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
    book: (a, b) => (booksById[a.bookId]?.title || '').localeCompare(booksById[b.bookId]?.title || '', 'ja') || a.createdAt - b.createdAt,
  };
  list.sort(sorters[sort] || sorters.new);

  app.innerHTML = `
    <div class="topbar"><a href="#/tags" class="back">‹ タグ</a></div>
    <header class="tag-head" style="--c:${tag.color}">
      <h2><span class="dot" style="background:${tag.color}"></span>${esc(tag.name)}</h2>
      <button class="btn ghost small" id="editTag">✏️ 編集</button>
    </header>
    <div class="toolbar">
      <span class="muted">${list.length}ページ</span>
      <select id="sort" aria-label="並べ替え">
        <option value="new" ${sort === 'new' ? 'selected' : ''}>新しい順</option>
        <option value="old" ${sort === 'old' ? 'selected' : ''}>古い順</option>
        <option value="book" ${sort === 'book' ? 'selected' : ''}>本ごと</option>
      </select>
    </div>
    ${list.length
      ? `<div class="pages">${list.map((p) => pageCard(p, { book: booksById[p.bookId], tagsById, isFav: booksById[p.bookId]?.favoritePageId === p.id })).join('')}</div>`
      : '<div class="empty small-empty"><p>このタグのついたページはまだありません</p></div>'}`;

  $('#sort').onchange = (e) => { pref.set('tagPageSort', e.target.value); render(true); };
  $('#editTag').onclick = () => editTag(tag, list.length);
}

// ---------- 設定 ----------

async function viewSettings() {
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) usage = `${(est.usage / 1024 / 1024).toFixed(1)} MB 使用中`;
  } catch {}

  const ready = await ocr.readiness();
  const ocrAuto = await db.getSetting('ocrAuto', true);
  const psmVertical = String(await db.getSetting('ocrPsmVertical', '5'));

  app.innerHTML = `
    <header class="hero small-hero"><h1>設定</h1></header>

    <section class="card">
      <h3 class="sec">文字認識（端末内）</h3>
      <p class="small">写真の文章を、このスマホの中で読み取ります。写真や文章が外部に送られることはありません。</p>
      <ul class="dl-list">
        ${Object.entries(ocr.MODES).map(([mode, m]) => `
          <li><span class="grow">${m.label}用のデータ（約${m.sizeMB}MB）</span>
            ${ready[mode] ? '<span class="using">✓ ダウンロード済み</span>' : `<button class="btn soft small" data-dl="${mode}">ダウンロード</button>`}</li>`).join('')}
      </ul>
      ${ready.engine ? '' : `<p class="muted tiny">初回は文字認識エンジン（約${ocr.ENGINE_MB}MB）も一緒にダウンロードします。</p>`}
      <label class="toggle"><input type="checkbox" id="ocrAuto" ${ocrAuto ? 'checked' : ''}> 写真を追加したら、自動で読み取る</label>
      <label class="field"><span class="label">縦書きのページの読み方</span>
        <select id="ocrPsm">${Object.entries(ocr.PSM_OPTIONS).map(([v, l]) => `<option value="${v}" ${v === psmVertical ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    </section>

    <section class="card">
      <h3 class="sec">バックアップ</h3>
      <p class="small">データはこのスマホのブラウザの中にあります。機種変更の前や、ときどき書き出しておくと安心です。</p>
      <div class="row">
        <button class="btn soft" id="exportBtn">⬇️ 書き出す</button>
        <label class="btn soft">⬆️ 読み込む<input type="file" accept="application/json,.json" id="importInput" hidden></label>
      </div>
      ${usage ? `<p class="muted tiny">${usage}</p>` : ''}
    </section>

    <p class="muted tiny center">ほんのしおり v1</p>`;

  for (const b of $$('[data-dl]')) b.onclick = async () => { if (await ensureOcrReady(b.dataset.dl)) render(true); };
  $('#ocrAuto').onchange = (e) => db.setSetting('ocrAuto', e.target.checked);
  $('#ocrPsm').onchange = async (e) => { await db.setSetting('ocrPsmVertical', e.target.value); toast('次の読み取りから使います'); };

  $('#exportBtn').onclick = async () => {
    toast('書き出しています…');
    const [books, tags, pages] = await Promise.all([db.getAll('books'), db.getAll('tags'), db.getAll('pages')]);
    const data = {
      app: 'hon-shiori', version: 1, exportedAt: Date.now(), books, tags,
      pages: await Promise.all(pages.map(async (p) => ({ ...p, image: p.image ? await blobToDataURL(p.image) : null, thumb: p.thumb ? await blobToDataURL(p.thumb) : null }))),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    a.download = `hon-shiori-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  $('#importInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'hon-shiori') throw new Error('ほんのしおりのバックアップではありません');
      if (!confirm(`本${data.books.length}冊・ページ${data.pages.length}枚を読み込みます。同じデータは上書きされます。よろしいですか？`)) return;
      for (const b of data.books) await db.put('books', b);
      for (const t of data.tags) await db.put('tags', t);
      for (const p of data.pages) {
        await db.put('pages', { ...p, image: p.image ? await dataURLToBlob(p.image) : null, thumb: p.thumb ? await dataURLToBlob(p.thumb) : null });
      }
      toast('読み込みました');
      go('#/');
      startThumbRegen();
    } catch (err) {
      toast('読み込めませんでした：' + err.message);
    }
  };
}

// ---------- 共有の受け取り ----------

async function viewShare(shareId) {
  const data = await share.readShare(shareId);
  if (!data) {
    app.innerHTML = `<div class="empty"><div class="big">📭</div><p>共有された内容が見つかりませんでした（保存済みか、取り消されています）。</p><a class="btn soft" href="#/">本棚へ</a></div>`;
    return;
  }
  const text = share.sharedText(data);
  const images = data.files.filter((f) => f.type.startsWith('image/'));
  const books = (await db.getAll('books')).sort((a, b) => b.updatedAt - a.updatedAt);
  const lastBook = pref.get('shareBook', '');
  const selBook = books.find((b) => b.id === lastBook)?.id || books[0]?.id || '';

  app.innerHTML = `
    <header class="hero small-hero"><h1>共有された内容</h1><p>どの本に保存するか選んでください</p></header>
    <section class="card">
      <label class="field"><span class="label">本</span>
        <select id="shareBook">
          ${books.map((b) => `<option value="${b.id}" ${b.id === selBook ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}
          <option value="__new">＋ 新しい本を作る</option>
        </select></label>
    </section>
    ${images.length ? `
      <section class="card">
        <h3 class="sec">画像 ${images.length}枚 → 新しいページとして保存</h3>
        <div class="share-thumbs">${images.map((f) => `<img src="${blobUrl(f)}" alt="">`).join('')}</div>
        ${text ? '<label class="toggle"><input type="checkbox" id="textToFirst" checked> 文章も1枚目のページに貼り付ける</label>' : ''}
      </section>` : ''}
    ${text ? `
      <section class="card" id="shareTextCard">
        <h3 class="sec">文章</h3>
        <textarea id="shareText" rows="6">${esc(text)}</textarea>
        <div id="pagePick" ${images.length ? 'hidden' : ''}>
          <p class="small">貼り付けるページを選んでください</p>
          <div class="pages pick" id="pickGrid"></div>
        </div>
      </section>` : ''}
    <div class="row-end">
      <button class="btn ghost" id="shareDiscard">保存しない</button>
      <button class="btn primary" id="shareSave">保存する</button>
    </div>`;

  let pickedPage = '';
  const fillPages = async (bookId) => {
    const grid = $('#pickGrid');
    if (!grid) return;
    const pages = bookId && bookId !== '__new' ? await db.pagesOfBook(bookId) : [];
    pickedPage = '';
    grid.innerHTML = `<button type="button" class="pick-card new-page" data-pick="__new"><span>＋<br>新しいページ<br><small>（写真なし）</small></span></button>`
      + pages.map((p) => `<button type="button" class="pick-card" data-pick="${p.id}">${p.thumb ? `<img src="${blobUrl(p.thumb)}" alt="">` : `<span class="pick-text">${esc(ocr.adoptedText(p).text.slice(0, 30))}</span>`}${p.pasteText?.trim() ? '<span class="tiny">貼り付け済み</span>' : ''}</button>`).join('');
    for (const b of $$('[data-pick]', grid)) {
      b.onclick = () => {
        pickedPage = b.dataset.pick;
        for (const x of $$('[data-pick]', grid)) x.classList.toggle('on', x === b);
      };
    }
  };
  fillPages(selBook);
  $('#textToFirst')?.addEventListener('change', (e) => { $('#pagePick').hidden = e.target.checked; });

  $('#shareBook').onchange = async (e) => {
    if (e.target.value !== '__new') return fillPages(e.target.value);
    const v = await formDialog({ title: '本を追加', submit: '追加', fields: BOOK_FIELDS() });
    if (!v?.title) { e.target.value = selBook; return; }
    const b = await createBook(v);
    e.target.insertAdjacentHTML('afterbegin', `<option value="${b.id}">${esc(b.title)}</option>`);
    e.target.value = b.id;
    fillPages(b.id);
  };

  $('#shareDiscard').onclick = async () => {
    await share.deleteShare(shareId);
    go('#/');
  };

  $('#shareSave').onclick = async () => {
    const bookId = $('#shareBook').value;
    if (!bookId || bookId === '__new') return toast('本を選んでください');
    pref.set('shareBook', bookId);
    const t = $('#shareText')?.value.trim() || '';
    const toFirst = images.length && t && $('#textToFirst')?.checked;
    if (t && !toFirst && !pickedPage) return toast('文章を貼り付けるページを選んでください');
    $('#shareSave').disabled = true;
    let target = '#/book/' + bookId;
    if (images.length) {
      const ids = await addPagesFromFiles(bookId, images, { pasteText: toFirst ? t : '' });
      if (toFirst && ids[0]) await db.update('pages', ids[0], { textSource: 'paste' });
      if (ids.length === 1) target = '#/page/' + ids[0];
    }
    if (t && !toFirst && pickedPage === '__new') {
      target = '#/page/' + (await addTextPage(bookId, t));
    } else if (t && !toFirst) {
      await db.update('pages', pickedPage, (cur) => ({
        pasteText: cur.pasteText?.trim() ? cur.pasteText.replace(/\s*$/, '\n') + t : t,
        textSource: cur.textSource || 'paste',
        updatedAt: Date.now(),
      }));
      await touchBook(bookId);
      target = '#/page/' + pickedPage;
    }
    await share.deleteShare(shareId);
    toast('保存しました');
    go(target);
  };
}

// ---------- ルーティング ----------

const routes = [
  [/^#\/book\/(\w+)$/, viewBook, 'shelf'],
  [/^#\/page\/(\w+)$/, viewPage, 'shelf'],
  [/^#\/page\/(\w+)\/edit$/, viewEdit, 'shelf'],
  [/^#\/tags$/, viewTags, 'tags'],
  [/^#\/tag\/(\w+)$/, viewTag, 'tags'],
  [/^#\/settings$/, viewSettings, 'settings'],
  [/^#\/share\/(\w+)$/, viewShare, 'shelf'],
  [/^(#\/?)?$/, viewShelf, 'shelf'],
];

let renderSeq = 0;
async function render(keepScroll = false) {
  const seq = ++renderSeq;
  const hash = location.hash;
  const route = routes.find(([re]) => re.test(hash));
  if (!route) return go('#/');
  const [re, view, tab] = route;
  const y = window.scrollY;
  viewCleanups.forEach((fn) => { try { fn(); } catch {} });
  viewCleanups = [];
  const oldUrls = objectUrls;
  objectUrls = [];
  await view(...hash.match(re).slice(1));
  if (seq !== renderSeq) return;
  oldUrls.forEach((u) => URL.revokeObjectURL(u));
  for (const a of $$('#tabbar a')) a.classList.toggle('active', a.dataset.tab === tab);
  window.scrollTo(0, keepScroll ? y : 0);
}

window.addEventListener('hashchange', () => render(false));

// 古いサムネイルを裏で作り直し、画面上部に進み具合を出す
let regenRunning = false;
async function startThumbRegen() {
  if (regenRunning) return;
  regenRunning = true;
  const bar = $('#progressBar');
  try {
    const r = await regenerateThumbs((done, total) => {
      bar.hidden = false;
      bar.innerHTML = `<span>サムネイルをきれいにしています… ${done} / ${total}</span><i style="width:${Math.round((done / total) * 100)}%"></i>`;
    });
    if (r.total) {
      toast(r.failed ? `サムネイルを更新しました（${r.failed}枚は次回やり直します）` : 'サムネイルをきれいにしました');
      // 入力中の画面（ページ詳細など）は描き直さない
      if (/^(#\/?|#\/book\/\w+|#\/tag\/\w+)?$/.test(location.hash)) render(true);
    }
  } catch (e) {
    console.error(e);
  } finally {
    bar.hidden = true;
    regenRunning = false;
  }
}

window.addEventListener('db-blocked', () => {
  toast('古い版のアプリが別のタブで開いています。そのタブを閉じると続きます');
});

render().then(() => {
  startThumbRegen();
  ocr.resumeQueue().catch((e) => console.error(e));
});

// ブラウザにデータを消されにくくする＆ホーム画面アプリ用
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
