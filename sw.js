// オフラインでも開けるようにアプリ本体をキャッシュする（ネット優先）
// 本番と試験版（パスに -beta）は同じオリジンにあるため、キャッシュ名を分け、
// 片づけるときも自分の名前で始まるキャッシュだけを消す。判定は config.js と同じ。
const IS_BETA =
  /-beta(\/|$)/.test(self.location.pathname) ||
  ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);
const PREFIX = IS_BETA ? 'hon-shiori-beta-' : 'hon-shiori-';
const CACHE = PREFIX + 'v3';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'config.js', 'db.js', 'util.js', 'thumbs.js',
  IS_BETA ? 'manifest-beta.json' : 'manifest.json', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// 本番の 'hon-shiori-' は試験版の 'hon-shiori-beta-' も前方一致してしまうので、本番側では除外する
const isMine = (k) => k.startsWith(PREFIX) && (IS_BETA || !k.startsWith('hon-shiori-beta-'));

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => isMine(k) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameApp = url.origin === location.origin && url.pathname.startsWith(new URL('./', self.location).pathname);
  const cacheable = sameApp || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com');
  if (!cacheable) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true, cacheName: CACHE })),
  );
});
