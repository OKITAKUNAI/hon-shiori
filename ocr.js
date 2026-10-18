// 端末内の文字認識（Tesseract.js）。写真も文章も外部に送らない。
// エンジンと言語データはリポジトリに同梱し、同じサイトから取得する（外部のCDNには通信しない）。
// 言語データは使う向きの分だけ、初回の認識の前に利用者の同意を得てから取得し、
// 以後は端末内（IndexedDB と Service Worker のキャッシュ）に保存されたものを使う。
import * as db from './db.js';
import { APP_ID } from './config.js';
import { preprocessForOcr } from './preprocess.js';
import { updatePageText } from './marks.js';
import { MON_TO_MA, MON_KEEP_NEXT } from './fix-words.js';
export { sourceOf, sourceText, adoptedText, editedOf } from './text.js';

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

// 前処理の設定（設定画面で変えられる）。既定はすべて使う
export const PRE_DEFAULTS = { autoCrop: true, deskew: true, binarize: 'sauvola', removeRuby: true };
export async function preSettings() {
  return { ...PRE_DEFAULTS, ...(await db.getSetting('ocrPre', {})) };
}

// ページの読み取りに使う前処理：四隅の指定（ocrCrop）があればそれ、なければ設定に応じて自動推定
export async function preFor(page) {
  const s = await preSettings();
  return { crop: page.ocrCrop || (s.autoCrop ? 'auto' : null), deskew: s.deskew, binarize: s.binarize, removeRuby: s.removeRuby };
}

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

// 写真を前処理してから読み取る。
// pre：前処理の指定（preprocess.js の options。省くとコントラスト調整だけ）。psm：ページ分割モードを指定（比較用）
// 戻り値：{ text, raw（自動修正の前の文章）, low（信頼度が99未満の文字：[text の中の位置, 信頼度]）,
//          fixed（自動で直した文字：[text の中の位置, 元の文字]）, rawMap（raw の位置 → text の位置。縦書きのときだけ）, lang, psm, pre, time（かかった時間 ms） }
export async function recognize(blob, mode, { onProgress, psm, pre = {} } = {}) {
  const t0 = performance.now();
  const w = await getWorker(mode, onProgress);
  if (psm && psm !== workerPsm) {
    await w.setParameters({ tessedit_pageseg_mode: psm });
    workerPsm = psm;
  }
  const t1 = performance.now();
  try {
    const { blob: prepared, info } = await preprocessForOcr(blob, { ...pre, vertical: mode === 'vertical' });
    const t2 = performance.now();
    const cancelled = new Promise((_, reject) => { cancelCurrent = () => reject(new CancelledError()); });
    // blocks：文字ごとの信頼度を受け取る
    const job = w.recognize(prepared, {}, { text: true, blocks: true });
    job.catch(() => {}); // キャンセルでワーカーを止めたとき、取り残された読み取りの失敗は無視する
    const { data } = await Promise.race([job, cancelled]);
    const t3 = performance.now();
    const raw = cleanText(data.text || '');
    const symbols = symbolsOf(data);
    const symAt = alignSymbols(raw, symbols);
    let text = raw;
    let low = lowConfidence(raw, symbols, symAt);
    let fixed = [];
    let rawMap = null;
    let bars = [];
    if (mode === 'vertical') {
      const f = fixVertical(raw, { symbols, symAt });
      text = f.text;
      fixed = f.fixed;
      rawMap = f.map;
      bars = f.bars;
      low = low.map(([i, c]) => [f.map[i], c]).filter(([i]) => i >= 0);
    }
    return {
      text, raw, rawMap, bars, low, fixed, lang: MODES[mode].lang, psm: workerPsm, pre: info,
      time: { total: Math.round(t3 - t0), load: Math.round(t1 - t0), pre: Math.round(t2 - t1), ocr: Math.round(t3 - t2) },
    };
  } finally {
    cancelCurrent = null;
    scheduleIdleStop();
  }
}

// ---------- 結果の整形 ----------

// ---------- 読み取り後の自動修正（縦書きのとき） ----------
//
// 縦書きの読み取りでよく出る、日本語の文章にあるはずのない字を直す。普通に使う字（「入」「ほ」など）は直さない。
//   縦棒「|」：字2つ分ほどの長さ（字の大きさの1.6倍以上）ならダッシュ「——」。
//              短ければ、直前がカタカナなら長音「ー」、それ以外は漢数字の「一」
//   「,」→「、」、「.」→「。」：英数字の間（「1,000」「3.14」「J.S.」）と、カタカナの間の「.」（中黒「・」の読み違い）は直さない。
//              「.」が続くとき（「...」）も直さない
//   「"」→「。」：縦書きの句点（字の右上の小さな丸）が白黒にしたときに2つに割れ、「"」と読まれたもの。
//              句点の位置と言えるときだけ直す（下の isPeriodQuote）
//   「〇問」→「〇間」：fix-words.js の一覧にある、日本語にない組み合わせだけ
// 戻り値：{ text, map（元の文章の位置 → 直した文章の位置。消えた文字は -1）, fixed（[直した文章の位置, 元の文字]）,
//          bars（縦棒の長さが字の大きさの何倍だったか。確認用） }
const KANA_KANJI = /[ぁ-ゖゝゞァ-ヺー-ヾ々〆一-鿿㐀-䶿豈-﫿]/;
const KATAKANA = /[゠-ヿｦ-ﾟ]/;
const ASCII_ALNUM = /[A-Za-z0-9]/;
const BAR = /[|｜]/;
const SPACE = /[ \t　]/;
// 句点の後に来られる字：かな・漢字・閉じかっこ（「。」」）・開きかっこ（次の文）・改行・文章の終わり
const AFTER_PERIOD = /[ぁ-ゖァ-ヺー々一-鿿㐀-䶿豈-﫿」』）〕】〟「『（\n]/;
export const DASH_RATIO = 1.6;

// 「"」を句点にしてよいか。ほかの使い方（「〟」のような引用の印・同じ記号の意味の〃・英文の中）と区別する。
//   前：かなか漢字であること（文の終わり）。句読点・かっこ・英数字・文章の始まりの直後は句点にならない
//   後：かな・漢字・かっこ・改行・終わりであること（Tesseract が記号の後に入れる空白は飛ばして見る）。
//       句読点や英数字、別の記号が続くなら句点ではない
//   近く（前後30字）に別の「"」があれば、引用の印の組とみなして直さない
export function isPeriodQuote(text, i) {
  const prev = text[i - 1] || '';
  const next = nextVisible(text, i);
  if (!KANA_KANJI.test(prev)) return false;
  if (next !== undefined && !AFTER_PERIOD.test(next)) return false;
  const near = text.slice(Math.max(0, i - 30), i) + text.slice(i + 1, i + 31);
  return !near.includes('"');
}

// i より後ろで、空白（改行は含めない）でない最初の字
function nextVisible(text, i) {
  let j = i + 1;
  while (j < text.length && SPACE.test(text[j])) j++;
  return text[j];
}

// 字の大きさ（読み取った漢字・かなの縦横の長いほうの中央値）
function glyphSize(symbols) {
  const s = symbols.filter((x) => x.box && KANA_KANJI.test(x.text || '')).map((x) => Math.max(x.box.x1 - x.box.x0, x.box.y1 - x.box.y0)).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

function barLength(sym) {
  return sym?.box ? Math.max(sym.box.x1 - sym.box.x0, sym.box.y1 - sym.box.y0) : 0;
}

export function fixVertical(text, { symbols = [], symAt = [] } = {}) {
  const size = glyphSize(symbols);
  const map = new Int32Array(text.length).fill(-1);
  const fixed = [];
  const bars = [];
  let out = '';
  const put = (i, s, from) => {
    map[i] = out.length;
    if (from !== undefined) for (let k = 0; k < s.length; k++) fixed.push([out.length + k, from]);
    out += s;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = out.at(-1) || '';
    const next = nextVisible(text, i) || '';
    if (BAR.test(ch)) {
      const sym = symbols[symAt[i]];
      const ratio = size && sym?.box ? barLength(sym) / size : 0;
      bars.push(Math.round(ratio * 100) / 100);
      if (ratio >= DASH_RATIO) put(i, '——', ch);
      else put(i, KATAKANA.test(prev) ? 'ー' : '一', ch);
    } else if (ch === ',' && KANA_KANJI.test(prev) && !ASCII_ALNUM.test(next)) {
      put(i, '、', ch);
    } else if (ch === '.' && KANA_KANJI.test(prev) && !ASCII_ALNUM.test(next) && next !== '.' && !(KATAKANA.test(prev) && KATAKANA.test(next))) {
      put(i, '。', ch);
    } else if (ch === '"' && isPeriodQuote(text, i)) {
      put(i, '。', ch);
    } else if (ch === '問' && MON_TO_MA.includes(prev + '問') && !MON_KEEP_NEXT.includes(next || '\0')) {
      put(i, '間', ch);
    } else if (SPACE.test(ch) && fixed.length && fixed.at(-1)[0] === out.length - 1 && KANA_KANJI.test(next)) {
      // 直した字（「一」「——」など）と次の字の間に残った空白は除く（Tesseract は記号の後に空白を入れる）
    } else {
      put(i, ch);
    }
  }
  return { text: out, map, fixed, bars };
}

function symbolsOf(data) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) for (const s of w.symbols || []) out.push({ text: s.text, conf: s.confidence, box: s.bbox });
  return out;
}

// 整形した文章の各文字が、Tesseract のどの文字にあたるか（なければ -1）。
// 整形は空白と改行を取り除くだけなので、空白以外の文字は Tesseract の文字と同じ順に並ぶ（念のため数文字先まで探して合わせる）
export function alignSymbols(text, symbols) {
  const at = new Int32Array(text.length).fill(-1);
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) continue;
    for (let d = 0; d < 4 && k + d < symbols.length; d++) {
      if ((symbols[k + d].text || '').startsWith(ch)) { at[i] = k + d; k += d + 1; break; }
    }
  }
  return at;
}

// 信頼度が99未満の文字の位置 [位置, 信頼度]
export const LOW_CONF_KEEP = 99;
export function lowConfidence(text, symbols, symAt = alignSymbols(text, symbols)) {
  const low = [];
  for (let i = 0; i < text.length; i++) {
    const s = symbols[symAt[i]];
    if (s && s.conf < LOW_CONF_KEEP) low.push([i, Math.round(s.conf * 10) / 10]);
  }
  return low;
}

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
        const r = await recognize(next.image, mode, { onProgress, pre: await preFor(next) });
        // 読み取り中に取り消されていたら結果は使わない
        const now = await db.get('pages', next.id);
        if (now?.ocrStatus !== 'running') continue;
        // 画面に出す文章が変わればマーカーを付け直す（手で直した文章があれば、画面の文章は変わらない）
        emit((await updatePageText(next.id, (cur) => ({
          ocrStatus: 'done',
          ocrText: r.text,           // 認識結果の原文。手で直した文章（editedText）には触れない
          ocrLang: r.lang,
          ocrPsm: r.psm,
          ocrPre: r.pre,             // 使った前処理（切り抜き・傾きの角度・二値化・除いたルビの数）
          ocrLow: r.low,             // 信頼度の低い文字 [ocrText の中の位置, 信頼度]
          ocrFixed: r.fixed,         // 自動で直した文字 [ocrText の中の位置, 元の文字]
          ocrTime: r.time,           // かかった時間（ms）：合計・エンジンの準備・前処理・認識
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
