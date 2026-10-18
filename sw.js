// オフラインでも開けるようにアプリ本体をキャッシュする（ネット優先）
// 本番と試験版（パスに -beta）は同じオリジンにあるため、キャッシュ名を分け、
// 片づけるときも自分の名前で始まるキャッシュだけを消す。判定は config.js と同じ。
const IS_BETA =
  /-beta(\/|$)/.test(self.location.pathname) ||
  ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);
const PREFIX = IS_BETA ? 'hon-shiori-beta-' : 'hon-shiori-';
const CACHE = PREFIX + 'v15';
// 文字認識のエンジンと言語データ（どちらも vendor/ に同梱）。フォルダ名にバージョンが入っていて中身が変わらないので、
// アプリ本体を更新しても消さずに使い続ける（数MBあるため、毎回取り直さない）。
// インストール時にまとめて取得はせず、使う向きの分だけ初回の認識の前に取得したものを保存する
const LANG_CACHE = PREFIX + 'ocr-data';
const SHARE_CACHE = PREFIX + 'share';     // 共有で受け取った内容の一時保管（share.js と同じ名前）
const KEEP = [CACHE, LANG_CACHE, SHARE_CACHE];
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'config.js', 'db.js', 'util.js', 'thumbs.js', 'ocr.js', 'preprocess.js', 'share.js',
  'textview.js', 'text.js', 'fix-words.js', 'anchor.js', 'marks.js', 'backup.js',
  IS_BETA ? 'manifest-beta.json' : 'manifest.json', 'icon-192.png', 'icon-512.png',
];
const APP_ROOT = new URL('./', self.location).pathname;
const SHARE_PATH = new URL('./share-target', self.location).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// 本番の 'hon-shiori-' は試験版の 'hon-shiori-beta-' も前方一致してしまうので、本番側では除外する
const isMine = (k) => k.startsWith(PREFIX) && (IS_BETA || !k.startsWith('hon-shiori-beta-'));

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => isMine(k) && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 他のアプリからの共有（manifest の share_target）。端末内のキャッシュに保管して、保存画面を開く
async function receiveShare(request) {
  const form = await request.formData();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const at = (name) => new URL(`./share-inbox/${id}/${name}`, self.location).href;
  const files = form.getAll('images').filter((f) => f && typeof f === 'object' && f.size > 0);
  const cache = await caches.open(SHARE_CACHE);
  await Promise.all(files.map((f, i) => cache.put(at(`file-${i}`), new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }))));
  const meta = {
    id,
    title: String(form.get('title') || ''),
    text: String(form.get('text') || ''),
    url: String(form.get('url') || ''),
    files: files.map((f) => ({ name: f.name, type: f.type })),
    receivedAt: Date.now(),
  };
  await cache.put(at('meta.json'), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  return Response.redirect(new URL(`./#/share/${id}`, self.location).href, 303);
}

const isLangData = (url) => url.origin === location.origin && url.pathname.startsWith(APP_ROOT + 'vendor/');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === SHARE_PATH) {
    e.respondWith(receiveShare(req).catch(() => Response.redirect(new URL('./', self.location).href, 303)));
    return;
  }
  if (req.method !== 'GET') return;

  // エンジンと言語データはバージョン固定で中身が変わらないので、キャッシュにあればそれを使う
  if (isLangData(url)) {
    e.respondWith(
      caches.open(LANG_CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  const sameApp = url.origin === location.origin && url.pathname.startsWith(APP_ROOT);
  const cacheable = sameApp || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com');
  if (!cacheable) return;
  // ブラウザのHTTPキャッシュ（GitHub Pages は10分）に古い版が残っていても、毎回サーバーに更新を確かめる
  const fresh = req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' });
  e.respondWith(
    fresh
      .then((res) => {
        // Google Fonts の CSS は中身の見えない応答（opaque）で返るが、電波がないときの見た目のために保存する
        if (res.ok || (res.type === 'opaque' && url.hostname.endsWith('fonts.googleapis.com'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true, cacheName: CACHE })),
  );
});
