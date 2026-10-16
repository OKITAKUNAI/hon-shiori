# 同梱している Tesseract.js

npm の配布物（tarball）を取得し、npm レジストリの `dist.integrity`（sha512）と一致することを確認してから、必要なファイルだけを取り出しています。

| パッケージ | バージョン | 取り出したファイル | ライセンス |
|---|---|---|---|
| tesseract.js | 7.0.0 | `tesseract.esm.min.js`, `worker.min.js` | Apache-2.0（`LICENSE-tesseract.js.md`） |
| tesseract.js-core | 7.0.0 | `core/tesseract-core-{relaxedsimd-lstm,simd-lstm,lstm}.wasm.js` | Apache-2.0（`core/LICENSE-tesseract.js-core`） |

core は端末の対応状況（relaxed SIMD / SIMD / なし）に合わせて、どれか1つだけが読み込まれます。

言語データは同梱せず、初回の利用時に同意を得てから、次の固定バージョンの URL から取得します（ocr.js）。

- 縦書き：`https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn_vert@1.0.0/4.0.0_best_int/jpn_vert.traineddata.gz`
- 横書き：`https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int/jpn.traineddata.gz`

言語データ（tessdata）のライセンスも Apache-2.0 です。
