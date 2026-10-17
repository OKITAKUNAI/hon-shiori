// 端末内の文字認識（Tesseract.js）。写真も文章も外部に送らない。
// エンジンと言語データはリポジトリに同梱し、同じサイトから取得する（外部のCDNには通信しない）。
// 言語データは使う向きの分だけ、初回の認識の前に利用者の同意を得てから取得し、
// 以後は端末内（IndexedDB と Service Worker のキャッシュ）に保存されたものを使う。
import * as db from './db.js';
import { APP_ID } from './config.js';
import { preprocessForOcr } from './preprocess.js';
import { updatePageText } from './marks.js';
export { sourceOf, sourceText, adoptedText } from './text.js';

// フォルダ名にバージョンを入れている。sw.js は vendor/ を「中身が変わらないもの」として長くキャッシュするので、
// 更新するときは新しいフォルダ名にすること
const ENGINE = new URL('./vendor/tesseract-7.0.0/', import.meta.url).href;
const LANG_PATH = new URL('./vendor/tessdata-4.0.0_best_int', import.meta.url).href;

export const ENGINE_MB = 3.8;
export const MODES = {
  vertical: { label: '縦書き', lang: 'jpn_vert', sizeMB: 1.9 },
  horizontal: { label: '横書き', lang: 'jpn', sizeMB: 1.9 },
};

// ページ分割モード（Tesseract の PSM）。縦書きは「縦書きの単一ブロック」が初期値
export const PSM_OPTIONS = {
  '5': '縦書きの1つのかたまりとして読む（PSM 5・おすすめ）',
  '3': 'レイアウトを自動で判定する（PSM 3）',
};

export const STATUS_LABEL = {
  none: '未読み取り',
  queued: '順番待ち',
  running: '読み取り中…',
  done: '読み取り済み',
  failed: '読み取れませんでした',
};

export const pageMode = (page, book) => page.writingMode || book?.writingMode || 'vertical';

export async function psmFor(mode) {
  return mode === 'vertical' ? String(await db.getSetting('ocrPsmVertical', '5')) : '3';
}

// ---------- 準備（言語データの取得） ----------

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

// ---------- エンジン（ワーカーは使い回す。キャンセルのときだけ作り直す） ----------

let tesseract;
let worker;
let workerLang;
let workerPsm;
let idleTimer;
let progressSink = () => {};

async function getWorker(mode, onProgress) {
  progressSink = onProgress || (() => {});
  clearTimeout(idleTimer);
  const lang = MODES[mode].lang;
  if (!worker || workerLang !== lang) {
    await stopWorker();
    tesseract ??= (await import(ENGINE + 'tesseract.esm.min.js')).default;
    const { createWorker, OEM } = tesseract;
    worker = await createWorker(lang, OEM.LSTM_ONLY, {
      workerPath: ENGINE + 'worker.min.js',
      corePath: ENGINE + 'core',
      langPath: LANG_PATH,
      workerBlobURL: false,
      cachePath: APP_ID + '-tessdata', // 本番と試験版で保存場所を分ける
      logger: (msg) => progressSink(msg),
    });
    workerLang = lang;
    workerPsm = undefined;
  }
  const psm = await psmFor(mode);
  if (workerPsm !== psm) {
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
    workerPsm = psm;
  }
  return worker;
}

async function stopWorker() {
  if (!worker) return;
  const w = worker;
  worker = undefined;
  workerLang = undefined;
  await w.terminate().catch(() => {});
}

// しばらく使わなければワーカーを止めてメモリを空ける
function scheduleIdleStop() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopWorker, 60_000);
}

class CancelledError extends Error {
  constructor() { super('キャンセルしました'); this.name = 'CancelledError'; }
}
let cancelCurrent = null;

// 写真を前処理してから読み取る。{ psm } を渡すとその設定で読む（test.html の比較用）
export async function recognize(blob, mode, { onProgress, psm } = {}) {
  const w = await getWorker(mode, onProgress);
  if (psm && psm !== workerPsm) {
    await w.setParameters({ tessedit_pageseg_mode: psm });
    workerPsm = psm;
  }
  try {
    const { blob: prepared } = await preprocessForOcr(blob);
    const cancelled = new Promise((_, reject) => { cancelCurrent = () => reject(new CancelledError()); });
    const job = w.recognize(prepared);
    job.catch(() => {}); // キャンセルでワーカーを止めたとき、取り残された読み取りの失敗は無視する
    const { data } = await Promise.race([job, cancelled]);
    return { text: cleanText(data.text || ''), lang: MODES[mode].lang, psm: workerPsm };
  } finally {
    cancelCurrent = null;
    scheduleIdleStop();
  }
}

// ---------- 結果の整形 ----------

const CJK = '\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff01-\\uff60';
const isCJK = (ch) => new RegExp(`[${CJK}]`).test(ch);

// Tesseract は日本語の文字の間に空白を入れ、1行（縦書きなら1列）ごとに改行するので、
// 文字の間の空白を取り、段落の中の改行をつなぐ。段落の区切り（空行）は改行1つにする。
// 柱・ノンブル・ルビの混入は自動では取り除かない（範囲選択と手動修正で対処する）
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

// ---------- 順番待ちの列（裏で1枚ずつ処理。状態はデータベースに残す） ----------

const listeners = new Set();
export function onOcrChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (page) => { if (page) listeners.forEach((fn) => { try { fn(page); } catch (e) { console.error(e); } }); };

// 認識中の進捗率（0〜1）。保存はしない
const progressListeners = new Set();
export function onOcrProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}
let runningPageId = null;
export const currentProgress = { pageId: null, value: 0 };

export async function enqueue(pageId) {
  const page = await db.get('pages', pageId);
  if (!page?.image) return; // 写真のないページは読み取らない
  emit(await db.update('pages', pageId, { ocrStatus: 'queued', ocrError: '' }));
  processQueue();
}

// 順番待ち・読み取り中のものを取り消す。読み取り中ならワーカーを止めて作り直す
export async function cancel(pageId) {
  const page = await db.get('pages', pageId);
  if (!page) return;
  if (runningPageId === pageId && cancelCurrent) {
    cancelCurrent();
    await stopWorker();
  }
  if (page.ocrStatus === 'queued' || page.ocrStatus === 'running') {
    emit(await db.update('pages', pageId, { ocrStatus: 'none' }));
  }
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
      if (!next.image) { emit(await db.update('pages', next.id, { ocrStatus: 'none' })); continue; }
      const book = await db.get('books', next.bookId);
      const mode = pageMode(next, book);
      if (!(await isReady(mode))) {
        // 言語データにまだ同意をもらっていない
        emit(await db.update('pages', next.id, { ocrStatus: 'none' }));
        continue;
      }
      emit(await db.update('pages', next.id, { ocrStatus: 'running' }));
      runningPageId = next.id;
      Object.assign(currentProgress, { pageId: next.id, value: 0 });
      const onProgress = (msg) => {
        if (msg.status !== 'recognizing text') return;
        currentProgress.value = msg.progress || 0;
        progressListeners.forEach((fn) => fn(next.id, currentProgress.value));
      };
      try {
        const r = await recognize(next.image, mode, { onProgress });
        // 読み取り中に取り消されていたら結果は使わない
        const now = await db.get('pages', next.id);
        if (now?.ocrStatus !== 'running') continue;
        // 画面に出す文章が変わればマーカーを付け直す（手で直した文章があれば、画面の文章は変わらない）
        emit((await updatePageText(next.id, (cur) => ({
          ocrStatus: 'done',
          ocrText: r.text,           // 認識結果の原文。手で直した文章（editedText）には触れない
          ocrLang: r.lang,
          ocrPsm: r.psm,
          ocrAt: Date.now(),
          ocrError: '',
          // どちらを使うか未選択なら、貼り付けた文章があればそちら、なければ読み取り結果
          textSource: cur.textSource || (cur.pasteText?.trim() ? 'paste' : 'ocr'),
        }))).page);
      } catch (e) {
        if (e?.name === 'CancelledError') continue;
        console.error('OCR に失敗しました', e);
        emit(await db.update('pages', next.id, { ocrStatus: 'failed', ocrError: String(e?.message || e) }));
      } finally {
        runningPageId = null;
        currentProgress.pageId = null;
      }
    }
  } finally {
    processing = false;
  }
}
