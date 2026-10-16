// サムネイルの生成と、古いサムネイルの作り直し
import * as db from './db.js';
import { resizeImage, THUMB_W, THUMB_H, THUMB_VERSION } from './util.js';

export const makeThumb = (blob) => resizeImage(blob, THUMB_W, THUMB_H, 0.85);

const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 200 }) : setTimeout(r, 16)));

// 保存済みの元画像（page.image）から、古い版のサムネイルを1枚ずつ作り直す。
// 元画像には触らない。途中で閉じても、済んだページには thumbVersion が付いているので続きから再開できる。
export async function regenerateThumbs(onProgress = () => {}) {
  const ids = (await db.getAll('pages'))
    .filter((p) => p.image && (p.thumbVersion || 0) < THUMB_VERSION)
    .map((p) => p.id);
  const result = { total: ids.length, done: 0, failed: 0 };
  if (!ids.length) return result;
  onProgress(0, ids.length);
  for (const id of ids) {
    try {
      const page = await db.get('pages', id);
      if (page?.image) {
        const thumb = await makeThumb(page.image);
        await db.update('pages', id, { thumb, thumbVersion: THUMB_VERSION });
      }
      result.done++;
    } catch (e) {
      console.error('サムネイルを作り直せませんでした', id, e);
      result.failed++;
    }
    onProgress(result.done + result.failed, ids.length);
    await idle(); // 画面の操作を止めないよう、1枚ごとに手を離す
  }
  return result;
}
