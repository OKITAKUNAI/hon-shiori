import * as db from './db.js';
import {
  $, $$, esc, uid, TAG_COLORS, coverColor, resizeImage, blobToDataURL, dataURLToBlob,
  toast, debounce,
} from './util.js';

const app = $('#app');

// ---------- 小さな道具 ----------

let objectUrls = [];
function blobUrl(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
}

const pref = {
  get: (k, d) => { try { return localStorage.getItem('hon-shiori:' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('hon-shiori:' + k, v); } catch {} },
};

const go = (hash) => { location.hash = hash; };

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
            </div></div>` : `
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

function showImage(blob) {
  const dlg = document.createElement('dialog');
  dlg.className = 'viewer';
  dlg.innerHTML = `<img src="${blobUrl(blob)}" alt="ページの写真"><p class="hint">タップで閉じる</p>`;
  document.body.append(dlg);
  dlg.onclick = () => { dlg.close(); dlg.remove(); };
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
  const book = await db.get('books', bookId);
  if (book) await db.put('books', { ...book, updatedAt: Date.now() });
}

function pageCard(p, { book, tagsById, isFav } = {}) {
  const tags = (p.tagIds || []).map((id) => tagsById?.[id]).filter(Boolean);
  return `
    <a class="page-card" href="#/page/${p.id}">
      <div class="thumb"><img src="${blobUrl(p.thumb)}" alt="" loading="lazy">${isFav ? '<span class="fav">★</span>' : ''}</div>
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
    const p = ps.find((x) => x.id === b.favoritePageId) || ps[0];
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
      fields: [
        { name: 'title', label: 'タイトル', required: true, placeholder: '例：星の王子さま' },
        { name: 'author', label: '著者（なくてもOK）', placeholder: '例：サン＝テグジュペリ' },
      ],
    });
    if (!v?.title) return;
    const now = Date.now();
    const book = { id: uid(), title: v.title, author: v.author || '', favoritePageId: null, createdAt: now, updatedAt: now };
    await db.put('books', book);
    go('#/book/' + book.id);
  };
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

    <label class="add-photos">
      <input type="file" accept="image/*" multiple id="photoInput" hidden>
      <span class="ap-icon">📷</span>
      <span><b>ページを追加</b><br><small>撮影 または 写真を選ぶ（何枚でも）</small></span>
    </label>

    ${pages.length ? `
      <p class="muted small hint-line">★がついたページが本棚の表紙になります</p>
      <div class="pages">
        ${pages.map((p) => pageCard(p, { tagsById, isFav: p.id === book.favoritePageId })).join('')}
      </div>` : `
      <div class="empty small-empty"><p>好きなページを撮って、ここに集めましょう</p></div>`}`;

  $('#photoInput').onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    toast(`${files.length}枚を保存しています…`);
    const base = Date.now();
    let firstId;
    for (const [i, file] of files.entries()) {
      try {
        const [image, thumb] = await Promise.all([resizeImage(file, 1568), resizeImage(file, 480, 0.8)]);
        const page = {
          id: uid(), bookId: id, image, thumb, comment: '', tagIds: [],
          createdAt: base + i, updatedAt: base + i,
        };
        firstId ??= page.id;
        await db.put('pages', page);
      } catch (err) {
        console.error(err);
        toast('読み込めない画像がありました');
      }
    }
    await touchBook(id);
    if (files.length === 1 && firstId) go('#/page/' + firstId);
    else { toast(`${files.length}枚追加しました`); render(true); }
  };

  $('#editBook').onclick = async () => {
    const v = await formDialog({
      title: '本の情報',
      danger: 'この本を削除',
      fields: [
        { name: 'title', label: 'タイトル', value: book.title, required: true },
        { name: 'author', label: '著者', value: book.author },
      ],
    });
    if (!v) return;
    if (v.__danger) {
      if (!confirm(`『${book.title}』と、保存した${pages.length}ページをすべて削除します。よろしいですか？`)) return;
      for (const p of pages) await db.del('pages', p.id);
      await db.del('books', id);
      toast('削除しました');
      return go('#/');
    }
    await db.put('books', { ...book, title: v.title || book.title, author: v.author, updatedAt: Date.now() });
    render(true);
  };
}

// ---------- 1ページの詳細 ----------

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

  const save = async (patch) => {
    Object.assign(page, patch, { updatedAt: Date.now() });
    await db.put('pages', page);
  };

  app.innerHTML = `
    <div class="topbar">
      <a href="#/book/${book.id}" class="back">‹ ${esc(book.title)}</a>
      <span class="muted small">${idx + 1} / ${siblings.length}</span>
    </div>

    <figure class="photo" id="photo"><img src="${blobUrl(page.image)}" alt="ページの写真"></figure>

    <div class="nav-row">
      ${prev ? `<a class="btn ghost small" href="#/page/${prev.id}">‹ 前</a>` : '<span class="btn ghost small disabled">‹ 前</span>'}
      <button class="btn fav-btn ${isFav ? 'on' : ''}" id="favBtn">${isFav ? '★ いちばん好きなページ' : '☆ いちばん好きにする'}</button>
      ${next ? `<a class="btn ghost small" href="#/page/${next.id}">次 ›</a>` : '<span class="btn ghost small disabled">次 ›</span>'}
    </div>

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

  $('#photo').onclick = () => showImage(page.image);

  $('#favBtn').onclick = async () => {
    await db.put('books', { ...book, favoritePageId: isFav ? null : id, updatedAt: Date.now() });
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
    if (isFav) await db.put('books', { ...book, favoritePageId: null, updatedAt: Date.now() });
    toast('削除しました');
    go('#/book/' + book.id);
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
      if (p.tagIds?.includes(tag.id)) await db.put('pages', { ...p, tagIds: p.tagIds.filter((t) => t !== tag.id) });
    }
    await db.del('tags', tag.id);
    toast('削除しました');
    return location.hash === '#/tags' ? render(true) : go('#/tags');
  }
  await db.put('tags', { ...tag, name: v.name || tag.name, color: v.color || tag.color });
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

  app.innerHTML = `
    <header class="hero small-hero"><h1>設定</h1></header>

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

  $('#exportBtn').onclick = async () => {
    toast('書き出しています…');
    const [books, tags, pages] = await Promise.all([db.getAll('books'), db.getAll('tags'), db.getAll('pages')]);
    const data = {
      app: 'hon-shiori', version: 1, exportedAt: Date.now(), books, tags,
      pages: await Promise.all(pages.map(async (p) => ({ ...p, image: await blobToDataURL(p.image), thumb: await blobToDataURL(p.thumb) }))),
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
        await db.put('pages', { ...p, image: await dataURLToBlob(p.image), thumb: await dataURLToBlob(p.thumb) });
      }
      toast('読み込みました');
      go('#/');
    } catch (err) {
      toast('読み込めませんでした：' + err.message);
    }
  };
}

// ---------- ルーティング ----------

const routes = [
  [/^#\/book\/(\w+)$/, viewBook, 'shelf'],
  [/^#\/page\/(\w+)$/, viewPage, 'shelf'],
  [/^#\/tags$/, viewTags, 'tags'],
  [/^#\/tag\/(\w+)$/, viewTag, 'tags'],
  [/^#\/settings$/, viewSettings, 'settings'],
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
  const oldUrls = objectUrls;
  objectUrls = [];
  await view(...hash.match(re).slice(1));
  if (seq !== renderSeq) return;
  oldUrls.forEach((u) => URL.revokeObjectURL(u));
  for (const a of $$('#tabbar a')) a.classList.toggle('active', a.dataset.tab === tab);
  window.scrollTo(0, keepScroll ? y : 0);
}

window.addEventListener('hashchange', () => render(false));
render();

// ブラウザにデータを消されにくくする＆ホーム画面アプリ用
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
