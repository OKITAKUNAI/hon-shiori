// 他のアプリから共有された文章・画像の受け取り口（Web Share Target）。
// sw.js が共有を受け取り、このアプリ専用のキャッシュ（端末内）に一時保管してから #/share/<id> を開く。
// 保管場所の名前と置き方は sw.js と同じにすること。
import { IS_BETA } from './config.js';

export const SHARE_CACHE = (IS_BETA ? 'hon-shiori-beta-' : 'hon-shiori-') + 'share';
const inboxUrl = (id, name) => new URL(`./share-inbox/${id}/${name}`, location.href).href;

export async function readShare(id) {
  const cache = await caches.open(SHARE_CACHE);
  const metaRes = await cache.match(inboxUrl(id, 'meta.json'));
  if (!metaRes) return null;
  const meta = await metaRes.json();
  const files = [];
  for (const [i, f] of (meta.files || []).entries()) {
    const res = await cache.match(inboxUrl(id, `file-${i}`));
    if (res) files.push(new File([await res.blob()], f.name || `shared-${i}.jpg`, { type: f.type || 'image/jpeg' }));
  }
  return { ...meta, files };
}

export async function deleteShare(id) {
  const cache = await caches.open(SHARE_CACHE);
  for (const req of await cache.keys()) {
    if (req.url.includes(`/share-inbox/${id}/`)) await cache.delete(req);
  }
}

// 共有された文章：本文が空ならタイトル、URL だけならそれを使う
export function sharedText(meta) {
  return [meta.text, !meta.text && meta.title, !meta.text && !meta.title && meta.url].filter(Boolean).join('\n').trim();
}
