// 保存サイズ（1568 / 2400 / 3200px）と読み方（PSM 5 / 3）の比較ツール。
// 本の写真は private/（Git の管理外）に置く。処理はすべてブラウザの中で行い、どこにも送信しない。
import * as db from '../db.js';
import * as ocr from '../ocr.js';
import { resizeImage, imageSize, esc } from '../util.js';

const SIZES = [1568, 2400, 3200];
const PSMS = ['5', '3'];
const $ = (s) => document.querySelector(s);
const log = (msg) => { $('#log').textContent = msg; };

let photos = []; // { name, file, truth }
let results = []; // { name, size, kb, w, h, same, runs: { '5': { text, ms, score }, '3': … } }

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

const baseName = (n) => n.replace(/\.[^.]+$/, '');
const isImage = (n) => /\.(jpe?g|png|webp|heic)$/i.test(n);

function setPhotos(list) {
  photos = list;
  $('#files').textContent = photos.length
    ? `写真：${photos.length}枚（正しい文章あり ${photos.filter((p) => p.truth).length}枚）`
    : '写真：まだありません';
  $('#run').disabled = !photos.length;
}

// 選んだファイル（画像と .txt）を組み合わせる
async function fromFiles(files) {
  const texts = {};
  for (const f of files) if (/\.txt$/i.test(f.name)) texts[baseName(f.name)] = await f.text();
  return files.filter((f) => isImage(f.name)).map((f) => ({ name: f.name, file: f, truth: texts[baseName(f.name)] || '' }));
}

// 開発用のサーバー（python -m http.server）で private/ の一覧が見えるときは、自動で読み込む
async function loadPrivate() {
  try {
    const res = await fetch('../private/', { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const names = [...html.matchAll(/href="([^"?#]+)"/g)].map((m) => decodeURIComponent(m[1])).filter((n) => !n.includes('/'));
    const files = [];
    for (const n of names.filter((x) => isImage(x) || /\.txt$/i.test(x))) {
      const blob = await (await fetch('../private/' + encodeURIComponent(n))).blob();
      files.push(new File([blob], n, { type: blob.type }));
    }
    if (files.length) setPhotos(await fromFiles(files));
  } catch {}
}

// 見本：canvas で描いた縦書きのページ（ツールの動作確認用。本の写真は使わない）
async function samplePhotos() {
  const lines = ['しおりを挟んだページには、', 'その日の気持ちが残っている。', 'あとで開くと、読んだときの', '部屋の明るさまで思い出す。', '本は二度目に読むときのほうが', 'やさしい顔をしていることがある。'];
  const make = async (w, h, tint) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = tint; g.fillRect(0, 0, w, h);
    g.fillStyle = '#2a2420';
    const s = Math.round(w / 26);
    g.font = `${s}px serif`; g.textAlign = 'center'; g.textBaseline = 'top';
    lines.forEach((l, col) => [...l].forEach((ch, i) => g.fillText(ch, w - s * 3 - col * s * 1.9, s * 2 + i * s * 1.05)));
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  };
  return [
    { name: '見本1（3000×4000・白い紙）', file: await make(3000, 4000, '#fbf8f1'), truth: lines.join('') },
    { name: '見本2（3000×4000・黄ばんだ紙）', file: await make(3000, 4000, '#d9cdb2'), truth: lines.join('') },
  ];
}

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function render() {
  const mode = $('#mode').value;
  const hasTruth = results.some((r) => r.runs['5']?.score != null);
  // まとめ：保存サイズごとの平均容量と、PSM ごとの平均一致率・時間
  const rows = SIZES.map((size) => {
    const rs = results.filter((r) => r.size === size);
    const avg = (f) => (rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : null);
    return {
      size,
      kb: avg((r) => r.kb),
      ...Object.fromEntries(PSMS.map((p) => [p, {
        score: hasTruth ? avg((r) => r.runs[p]?.score ?? 0) : null,
        ms: avg((r) => r.runs[p]?.ms ?? 0),
      }])),
    };
  });
  const bestScore = hasTruth ? Math.max(...rows.flatMap((r) => PSMS.map((p) => r[p].score ?? 0))) : null;
  $('#summary').innerHTML = results.length ? `
    <table><thead><tr><th>保存サイズ</th><th>1枚の容量</th>${PSMS.map((p) => `<th>PSM ${p} 一致率</th><th>PSM ${p} 時間</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${r.size}px</td><td>${r.kb == null ? '—' : Math.round(r.kb) + 'KB'}</td>${PSMS.map((p) => `
      <td class="${hasTruth && r[p].score === bestScore ? 'best' : ''}">${pct(r[p].score)}</td><td>${r[p].ms == null ? '—' : (r[p].ms / 1000).toFixed(1) + '秒'}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="tiny muted">文字の向き：${mode === 'vertical' ? '縦書き（jpn_vert）' : '横書き（jpn）'}・写真 ${new Set(results.map((r) => r.name)).size}枚の平均。${hasTruth ? '一致率は正しい文章（.txt）との比較。' : '正しい文章（.txt）がないので一致率は出していません。下の読み取り結果を見比べてください。'}100枚保存したときの容量の目安：${rows.map((r) => `${r.size}px ≈ ${r.kb == null ? '—' : (r.kb * 100 / 1024).toFixed(0) + 'MB'}`).join('、')}</p>` : '';

  $('#detail').innerHTML = [...new Set(results.map((r) => r.name))].map((name) => {
    const rs = results.filter((r) => r.name === name);
    return `
      <h3 class="small">${esc(name)}（元の写真 ${rs[0]?.orig || ''}）</h3>
      <table><thead><tr><th>保存サイズ</th><th>実際の大きさ</th><th>容量</th>${PSMS.map((p) => `<th>PSM ${p} 一致率</th><th>時間</th>`).join('')}</tr></thead>
      <tbody>${rs.map((r) => `<tr><td>${r.size}px${r.same ? '（元の写真より大きいので縮小なし）' : ''}</td><td>${r.w}×${r.h}</td><td>${Math.round(r.kb)}KB</td>${PSMS.map((p) => `
        <td>${pct(r.runs[p]?.score)}</td><td>${r.runs[p] ? (r.runs[p].ms / 1000).toFixed(1) + '秒' : '…'}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <details><summary class="small">読み取った文章を見比べる（この画面の中だけで表示）</summary>
        ${rs.map((r) => PSMS.map((p) => r.runs[p] ? `<p class="tiny"><b>${r.size}px・PSM ${p}</b></p><div class="vt">${esc(r.runs[p].text)}</div>` : '').join('')).join('')}
      </details>`;
  }).join('');
  $('#copy').disabled = !results.length;
}

async function run() {
  const mode = $('#mode').value;
  $('#run').disabled = true;
  results = [];
  render();
  try {
    log('文字認識の準備をしています…');
    await ocr.prepare(mode, (m) => log(`準備中：${m.status} ${Math.round((m.progress || 0) * 100)}%`));
    const total = photos.length * SIZES.length * PSMS.length;
    let done = 0;
    for (const ph of photos) {
      const orig = await imageSize(ph.file);
      for (const size of SIZES) {
        // アプリと同じく、長辺を size に収めて JPEG（品質0.85）で保存した画像を読み取る
        const stored = await resizeImage(ph.file, size);
        const dim = await imageSize(stored);
        const r = { name: ph.name, size, kb: stored.size / 1024, w: dim.width, h: dim.height, same: Math.max(orig.width, orig.height) <= size, orig: `${orig.width}×${orig.height}`, runs: {} };
        results.push(r);
        for (const psm of PSMS) {
          log(`読み取り中 ${++done} / ${total}：${ph.name}・${size}px・PSM ${psm}`);
          const t0 = performance.now();
          const out = await ocr.recognize(stored, mode, { psm });
          r.runs[psm] = { text: out.text, ms: performance.now() - t0, score: ph.truth ? similarity(out.text, ph.truth) : null };
          render();
        }
      }
    }
    log(`終わりました（${total}回の読み取り）`);
  } catch (e) {
    console.error(e);
    log('エラー：' + (e?.message || e));
  } finally {
    $('#run').disabled = !photos.length;
  }
}

// 表を Markdown にしてコピー（数字だけ。本の文章は含めない）
function copyTable() {
  const head = `| 写真 | 保存サイズ | 容量 | ${PSMS.map((p) => `PSM ${p} 一致率 | PSM ${p} 時間`).join(' | ')} |`;
  const sep = `|${'---|'.repeat(3 + PSMS.length * 2)}`;
  const body = results.map((r) => `| ${r.name} | ${r.size}px | ${Math.round(r.kb)}KB | ${PSMS.map((p) => `${pct(r.runs[p]?.score)} | ${r.runs[p] ? (r.runs[p].ms / 1000).toFixed(1) + '秒' : '—'}`).join(' | ')} |`);
  const text = [head, sep, ...body].join('\n');
  navigator.clipboard.writeText(text).then(() => log('表をコピーしました（数字だけ）'), () => log(text));
}

$('#pick').onchange = async (e) => setPhotos([...photos, ...(await fromFiles([...e.target.files]))]);
$('#run').onclick = run;
$('#copy').onclick = copyTable;
$('#sample').onclick = async () => { setPhotos(await samplePhotos()); run(); };

await db.useDatabase('hon-shiori-compare'); // 本番・試験版とは別のデータベース（読み取りの準備状態だけを保存）
loadPrivate();
