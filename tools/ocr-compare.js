// 保存サイズ（1568 / 2400 / 3200px）・読み方（PSM 5 / 3）・前処理（なし／1〜3／1〜4）の比較ツール。
// 本の写真は private/（Git の管理外）に置く。処理はすべてブラウザの中で行い、どこにも送信しない。
import * as db from '../db.js';
import * as ocr from '../ocr.js';
import { preprocessForOcr } from '../preprocess.js';
import { resizeImage, imageSize, esc } from '../util.js';
import { drawRubyPage, RUBY_TRUTH } from './sample-page.js';

const SIZES = [1568, 2400, 3200];
const PSMS = ['5', '3'];
// 前処理の組み合わせ。「なし」はフェーズ3からある最低限の処理（グレースケール化・コントラスト調整）だけ
const VARIANTS = {
  none: { label: '前処理なし', pre: {} },
  otsu13: { label: '1〜3（二値化は大津）', pre: { crop: 'auto', deskew: true, binarize: 'otsu' } },
  sauvola13: { label: '1〜3のみ（Sauvola）', pre: { crop: 'auto', deskew: true, binarize: 'sauvola' } },
  all14: { label: '1〜4すべて（ルビ除去）', pre: { crop: 'auto', deskew: true, binarize: 'sauvola', removeRuby: true } },
};
const SMALL_PUNCT = new Set([...'っゃゅょぁぃぅぇぉッャュョァィゥェォ、。・「」']);

const $ = (s) => document.querySelector(s);
const log = (msg) => { $('#log').textContent = msg; };

let photos = []; // { name, file, truth }
let results = []; // { name, size, variant, kb, w, h, same, orig, runs: { '5': {...}, '3': {...} } }
let previews = {}; // 写真の名前 → ルビとして消した部分を赤で示した画像

// 最長共通部分列で文字を対応づけ、一致率と、小書き文字・句読点がどれだけ残ったかを数える
function compare(ocrText, truth) {
  const a = [...ocrText.replace(/\s/g, '')];
  const b = [...truth.replace(/\s/g, '')];
  if (!a.length || !b.length) return { score: 0, small: { hit: 0, total: b.filter((c) => SMALL_PUNCT.has(c)).length } };
  const n = a.length;
  const m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * (m + 1) + j] = a[i - 1] === b[j - 1]
        ? dp[(i - 1) * (m + 1) + j - 1] + 1
        : Math.max(dp[(i - 1) * (m + 1) + j], dp[i * (m + 1) + j - 1]);
    }
  }
  // たどり直して、正しい文章のどの文字が読めたかを調べる
  const matched = new Uint8Array(m);
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (a[i - 1] === b[j - 1]) { matched[j - 1] = 1; i--; j--; } else if (dp[(i - 1) * (m + 1) + j] >= dp[i * (m + 1) + j - 1]) i--; else j--;
  }
  let hit = 0;
  let total = 0;
  b.forEach((c, j) => { if (SMALL_PUNCT.has(c)) { total++; hit += matched[j]; } });
  return { score: (2 * dp[n * (m + 1) + m]) / (n + m), small: { hit, total } };
}

const baseName = (n) => n.replace(/\.[^.]+$/, '');
const isImage = (n) => /\.(jpe?g|png|webp|heic)$/i.test(n);
const checked = (name) => [...document.querySelectorAll(`[name="${name}"]:checked`)].map((el) => el.value);

function setPhotos(list) {
  photos = list;
  $('#files').textContent = photos.length
    ? `写真：${photos.length}枚（正しい文章あり ${photos.filter((p) => p.truth).length}枚）`
    : '写真：まだありません';
  $('#run').disabled = !photos.length;
}

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

// 見本：canvas で描いたルビ付きの縦書きのページ（傾き・影・柱・ページの外つき。本の写真は使わない）
async function samplePhotos() {
  const blob = (o) => new Promise((r) => drawRubyPage(o).canvas.toBlob(r, 'image/jpeg', 0.9));
  return [
    { name: '見本1（ルビ・柱あり）', file: await blob({ w: 3000, h: 4000 }), truth: RUBY_TRUTH },
    { name: '見本2（ルビ・柱・傾き1.5度・影・ページの外）', file: await blob({ w: 3000, h: 4000, skew: 1.5, shadow: true, outside: true }), truth: RUBY_TRUTH },
  ];
}

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}秒`);
const smallPct = (s) => (s && s.total ? `${Math.round((s.hit / s.total) * 100)}%（${s.hit}/${s.total}）` : '—');

function render() {
  const sizes = [...new Set(results.map((r) => r.size))];
  const variants = Object.keys(VARIANTS).filter((v) => results.some((r) => r.variant === v));
  const psms = PSMS.filter((p) => results.some((r) => r.runs[p]));
  const hasTruth = photos.some((p) => p.truth);
  const avg = (rs, f) => { const v = rs.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const sumSmall = (rs, p) => rs.reduce((acc, r) => { const s = r.runs[p]?.small; if (s) { acc.hit += s.hit; acc.total += s.total; } return acc; }, { hit: 0, total: 0 });

  const rows = [];
  for (const v of variants) for (const size of sizes) {
    const rs = results.filter((r) => r.variant === v && r.size === size);
    if (!rs.length) continue;
    rows.push({ v, size, kb: avg(rs, (r) => r.kb), runs: Object.fromEntries(psms.map((p) => [p, { score: hasTruth ? avg(rs, (r) => r.runs[p]?.score) : null, ms: avg(rs, (r) => r.runs[p]?.ms), small: sumSmall(rs, p) }])) });
  }
  const best = hasTruth ? Math.max(...rows.flatMap((r) => psms.map((p) => r.runs[p].score ?? 0))) : null;
  $('#summary').innerHTML = rows.length ? `
    <table><thead><tr><th>前処理</th><th>保存サイズ</th><th>容量</th>${psms.map((p) => `<th>PSM ${p} 一致率</th><th>小書き・句読点</th><th>時間</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${VARIANTS[r.v].label}</td><td>${r.size}px</td><td>${Math.round(r.kb)}KB</td>${psms.map((p) => `
      <td class="${hasTruth && r.runs[p].score === best ? 'best' : ''}">${pct(r.runs[p].score)}</td><td>${hasTruth ? smallPct(r.runs[p].small) : '—'}</td><td>${sec(r.runs[p].ms)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="tiny muted">写真 ${new Set(results.map((r) => r.name)).size}枚の平均。${hasTruth ? '一致率は正しい文章（.txt）との比較。「小書き・句読点」は、正しい文章の中の っ ゃ ゅ ょ など小さい文字と 、。「」 のうち読み取れた割合（ルビの除去で消えていないかの確認用）。' : '正しい文章（.txt）がないので一致率は出していません。'}
    100枚保存したときの容量の目安：${sizes.map((s) => { const k = avg(results.filter((r) => r.size === s && r.variant === variants[0]), (r) => r.kb); return `${s}px ≈ ${k == null ? '—' : (k * 100 / 1024).toFixed(0) + 'MB'}`; }).join('、')}</p>` : '';

  $('#detail').innerHTML = [...new Set(results.map((r) => r.name))].map((name) => {
    const rs = results.filter((r) => r.name === name);
    return `
      <h3 class="small">${esc(name)}（元の写真 ${rs[0]?.orig || ''}）</h3>
      <table><thead><tr><th>前処理</th><th>保存サイズ</th><th>容量</th>${psms.map((p) => `<th>PSM ${p}</th><th>小書き・句読点</th><th>時間</th>`).join('')}</tr></thead>
      <tbody>${rs.map((r) => `<tr><td>${VARIANTS[r.variant].label}</td><td>${r.size}px${r.same ? '（縮小なし）' : ''}</td><td>${Math.round(r.kb)}KB</td>${psms.map((p) => `
        <td>${pct(r.runs[p]?.score)}</td><td>${smallPct(r.runs[p]?.small)}</td><td>${r.runs[p] ? sec(r.runs[p].ms) : '…'}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${previews[name] ? `<details><summary class="small">前処理した画像（ルビとして消した部分は赤）</summary><img class="pre-img" src="${previews[name]}" alt=""></details>` : ''}
      <details><summary class="small">読み取った文章を見比べる（この画面の中だけで表示）</summary>
        ${rs.map((r) => psms.map((p) => r.runs[p] ? `<p class="tiny"><b>${VARIANTS[r.variant].label}・${r.size}px・PSM ${p}</b></p><div class="vt">${esc(r.runs[p].text)}</div>` : '').join('')).join('')}
      </details>`;
  }).join('');
  $('#copy').disabled = !results.length;
}

async function run() {
  const mode = $('#mode').value;
  const sizes = checked('size').map(Number);
  const psms = checked('psm');
  const variants = checked('variant');
  if (!sizes.length || !psms.length || !variants.length) return log('保存サイズ・PSM・前処理を1つ以上選んでください');
  $('#run').disabled = true;
  results = [];
  previews = {};
  render();
  try {
    log('文字認識の準備をしています…');
    await ocr.prepare(mode, (m) => log(`準備中：${m.status} ${Math.round((m.progress || 0) * 100)}%`));
    const total = photos.length * sizes.length * psms.length * variants.length;
    let done = 0;
    for (const ph of photos) {
      const orig = await imageSize(ph.file);
      for (const size of sizes) {
        // アプリと同じく、長辺を size に収めて JPEG（品質0.85）で保存した画像を読み取る
        const stored = await resizeImage(ph.file, size);
        const dim = await imageSize(stored);
        if (size === sizes[0] && variants.includes('all14')) {
          const dbg = await preprocessForOcr(stored, { ...VARIANTS.all14.pre, vertical: mode === 'vertical', debug: true });
          if (dbg.debugBlob) previews[ph.name] = URL.createObjectURL(dbg.debugBlob);
        }
        for (const v of variants) {
          const r = { name: ph.name, size, variant: v, kb: stored.size / 1024, w: dim.width, h: dim.height, same: Math.max(orig.width, orig.height) <= size, orig: `${orig.width}×${orig.height}`, runs: {} };
          results.push(r);
          for (const psm of psms) {
            log(`読み取り中 ${++done} / ${total}：${ph.name}・${size}px・${VARIANTS[v].label}・PSM ${psm}`);
            const t0 = performance.now();
            const out = await ocr.recognize(stored, mode, { psm, pre: VARIANTS[v].pre });
            const c = ph.truth ? compare(out.text, ph.truth) : null;
            r.runs[psm] = { text: out.text, ms: performance.now() - t0, score: c?.score ?? null, small: c?.small ?? null, pre: out.pre };
            render();
          }
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
  const psms = PSMS.filter((p) => results.some((r) => r.runs[p]));
  const head = `| 写真 | 前処理 | 保存サイズ | 容量 | ${psms.map((p) => `PSM ${p} 一致率 | PSM ${p} 小書き・句読点 | PSM ${p} 時間`).join(' | ')} |`;
  const sep = `|${'---|'.repeat(4 + psms.length * 3)}`;
  const body = results.map((r) => `| ${r.name} | ${VARIANTS[r.variant].label} | ${r.size}px | ${Math.round(r.kb)}KB | ${psms.map((p) => `${pct(r.runs[p]?.score)} | ${smallPct(r.runs[p]?.small)} | ${r.runs[p] ? sec(r.runs[p].ms) : '—'}`).join(' | ')} |`);
  const text = [head, sep, ...body].join('\n');
  navigator.clipboard.writeText(text).then(() => log('表をコピーしました（数字だけ）'), () => log(text));
}

// 選択肢（保存サイズ・PSM・前処理）
$('#choices').innerHTML = `
  <span class="small">保存サイズ：${SIZES.map((s) => `<label class="small"><input type="checkbox" name="size" value="${s}" checked>${s}px</label>`).join(' ')}</span>
  <span class="small">PSM：${PSMS.map((p) => `<label class="small"><input type="checkbox" name="psm" value="${p}" checked>${p}</label>`).join(' ')}</span>
  <span class="small">前処理：${Object.entries(VARIANTS).map(([k, v]) => `<label class="small"><input type="checkbox" name="variant" value="${k}" checked>${v.label}</label>`).join(' ')}</span>`;

$('#pick').onchange = async (e) => setPhotos([...photos, ...(await fromFiles([...e.target.files]))]);
$('#run').onclick = run;
$('#copy').onclick = copyTable;
$('#sample').onclick = async () => { setPhotos(await samplePhotos()); run(); };

await db.useDatabase('hon-shiori-compare'); // 本番・試験版とは別のデータベース（読み取りの準備状態だけを保存）
loadPrivate();
