// 端末内の文字認識（Tesseract.js）。写真は外部に送らない。
// エンジンはリポジトリに同梱（vendor/tesseract）、言語データは初回だけ固定バージョンのCDNから取得し、
// 以後は端末内（IndexedDB と Service Worker のキャッシュ）に保存されたものを使う。
import * as db from './db.js';
import { APP_ID } from './config.js';

// フォルダ名にバージョンを入れている。sw.js はここを「中身が変わらないもの」として長くキャッシュするので、
// 更新するときは新しいフォルダ名にすること
const VENDOR = new URL('./vendor/tesseract-7.0.0/', import.meta.url).href;

export const ENGINE_MB = 3.8;
export const MODES = {
  vertical: {
    label: '縦書き',
    lang: 'jpn_vert',
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn_vert@1.0.0/4.0.0_best_int',
    sizeMB: 1.9,
  },
  horizontal: {
    label: '横書き',
    lang: 'jpn',
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int',
    sizeMB: 1.9,
  },
};

export const STATUS_LABEL = {
  none: '未読み取り',
  queued: '順番待ち',
  running: '読み取り中…',
  done: '読み取り済み',
  failed: '読み取れませんでした',
};

export const pageMode = (page, book) => page.writingMode || book?.writingMode || 'vertical';

// ---------- 準備（言語データのダウンロード） ----------

export async function readiness() {
  return db.getSetting('ocrReady', { engine: false, vertical: false, horizontal: false });
}

export async function isReady(mode) {
  return !!(await readiness())[mode];
}

// 利用者が同意したあとに呼ぶ。エンジンと言語データを読み込み、進み具合を onProgress に知らせる
export async function prepare(mode, onProgress = () => {}) {
  await getWorker(mode, onProgress);
  const r = await readiness();
  await db.setSetting('ocrReady', { ...r, engine: true, [mode]: true });
}

// ---------- エンジン ----------

let tesseract;
let worker;
let workerMode;
let idleTimer;
let progressSink = () => {};

async function getWorker(mode, onProgress) {
  progressSink = onProgress || (() => {});
  clearTimeout(idleTimer);
  if (worker && workerMode === mode) return worker;
  if (worker) await worker.terminate().catch(() => {});
  worker = undefined;
  tesseract ??= (await import(VENDOR + 'tesseract.esm.min.js')).default;
  const { createWorker, OEM, PSM } = tesseract;
  const m = MODES[mode];
  const w = await createWorker(m.lang, OEM.LSTM_ONLY, {
    workerPath: VENDOR + 'worker.min.js',
    corePath: VENDOR + 'core',
    langPath: m.langPath,
    workerBlobURL: false,
    cachePath: APP_ID + '-tessdata', // 本番と試験版で保存場所を分ける
    logger: (msg) => progressSink(msg),
  });
  await w.setParameters({
    // 縦書きは「縦書きの文章のかたまり」として読む。横書きは自動でレイアウトを判定
    tessedit_pageseg_mode: mode === 'vertical' ? PSM.SINGLE_BLOCK_VERT_TEXT : PSM.AUTO,
    preserve_interword_spaces: '1',
  });
  worker = w;
  workerMode = mode;
  return w;
}

// しばらく使わなければワーカーを止めてメモリを空ける
function scheduleIdleStop() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (!worker) return;
    const w = worker;
    worker = undefined;
    await w.terminate().catch(() => {});
  }, 60_000);
}

// フェーズ2でOCR用の前処理（グレースケール化・コントラスト正規化・二値化）をここに入れる
async function prepareImage(blob) {
  return blob;
}

export async function recognize(blob, mode, onProgress) {
  const w = await getWorker(mode, onProgress);
  try {
    const { data } = await w.recognize(await prepareImage(blob));
    return cleanText(data.text || '');
  } finally {
    scheduleIdleStop();
  }
}

// ---------- 結果の整形 ----------

const CJK = '\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff01-\\uff60';
const isCJK = (ch) => new RegExp(`[${CJK}]`).test(ch);

// Tesseract は日本語の文字の間に空白を入れ、1行（縦書きなら1列）ごとに改行するので、
// 文字の間の空白を取り、段落の中の改行をつなぐ。段落の区切り（空行）は改行1つにする。
export function cleanText(raw) {
  const text = raw.replace(/\r/g, '').replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1');
  return text
    .split(/\n\s*\n/)
    .map((para) => para.split('\n').map((s) => s.trim()).filter(Boolean)
      .reduce((acc, line) => {
        if (!acc) return line;
        const joinWithSpace = !isCJK(acc.at(-1)) && !isCJK(line[0]);
        return acc + (joinWithSpace ? ' ' : '') + line;
      }, ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

// ---------- 順番待ちの列（裏で1枚ずつ処理） ----------

const listeners = new Set();
export function onOcrChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (page) => listeners.forEach((fn) => { try { fn(page); } catch (e) { console.error(e); } });

export async function enqueue(pageId) {
  const page = await db.update('pages', pageId, { ocrStatus: 'queued', ocrError: '' });
  if (page) emit(page);
  processQueue();
}

// 起動時：前回の途中で止まったもの（実行中のまま）を順番待ちに戻して再開する
export async function resumeQueue() {
  for (const p of await db.getAll('pages')) {
    if (p.ocrStatus === 'running') await db.update('pages', p.id, { ocrStatus: 'queued' });
  }
  processQueue();
}

let processing = false;
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      const next = (await db.getAll('pages'))
        .filter((p) => p.ocrStatus === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      const book = await db.get('books', next.bookId);
      const mode = pageMode(next, book);
      if (!(await isReady(mode))) {
        // 言語データにまだ同意をもらっていない
        emit(await db.update('pages', next.id, { ocrStatus: 'none' }));
        continue;
      }
      emit(await db.update('pages', next.id, { ocrStatus: 'running' }));
      try {
        const text = await recognize(next.image, mode);
        emit(await db.update('pages', next.id, (cur) => ({
          ocrStatus: 'done',
          ocrText: text,
          ocrMode: mode,
          ocrAt: Date.now(),
          ocrError: '',
          // どちらを使うか未選択なら、貼り付けた文章があればそちら、なければ読み取り結果
          textSource: cur.textSource || (cur.pasteText?.trim() ? 'paste' : 'ocr'),
        })));
      } catch (e) {
        console.error('OCR に失敗しました', e);
        emit(await db.update('pages', next.id, { ocrStatus: 'failed', ocrError: String(e?.message || e) }));
      }
    }
  } finally {
    processing = false;
  }
}

// 採用中の文章
export function adoptedText(page) {
  const src = page.textSource || (page.pasteText?.trim() ? 'paste' : 'ocr');
  return { source: src, text: (src === 'paste' ? page.pasteText : page.ocrText) || '' };
}
