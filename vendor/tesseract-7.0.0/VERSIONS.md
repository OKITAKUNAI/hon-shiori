# 同梱している Tesseract.js

npm の配布物（tarball）を取得し、npm レジストリの `dist.integrity`（sha512）と一致することを確認してから、必要なファイルだけを取り出しています。

| パッケージ | バージョン | 取り出したファイル | ライセンス |
|---|---|---|---|
| tesseract.js | 7.0.0 | `tesseract.esm.min.js`, `worker.min.js` | Apache-2.0（`LICENSE-tesseract.js.md`） |
| tesseract.js-core | 7.0.0 | `core/tesseract-core-{relaxedsimd-lstm,simd-lstm,lstm}.wasm.js` | Apache-2.0（`core/LICENSE-tesseract.js-core`） |

core は端末の対応状況（relaxed SIMD / SIMD / なし）に合わせて、どれか1つだけが読み込まれます。

言語データは `../tessdata-4.0.0_best_int/` に同梱しています（同じサイトから取得するので、外部のCDNには通信しません）。
