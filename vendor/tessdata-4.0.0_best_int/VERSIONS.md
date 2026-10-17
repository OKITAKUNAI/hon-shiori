# 同梱している言語データ（Tesseract の学習済みデータ）

npm の配布物（tarball）を取得し、npm レジストリの `dist.integrity`（sha512）と一致することを確認してから、`4.0.0_best_int` のファイルだけを取り出しています。

| ファイル | 取り出し元 | sha256 |
|---|---|---|
| `jpn_vert.traineddata.gz`（縦書き） | `@tesseract.js-data/jpn_vert@1.0.0` の `4.0.0_best_int/` | `3a4f4df8df8f50f3389fe0da10502effced38faef763d8e540142bdc9b770308` |
| `jpn.traineddata.gz`（横書き） | `@tesseract.js-data/jpn@1.0.0` の `4.0.0_best_int/` | `2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88` |

## ライセンス

- 学習済みデータの元は Tesseract OCR の「tessdata_best」（https://github.com/tesseract-ocr/tessdata_best ）を整数化したもので、Apache License 2.0 です。全文は `LICENSE-tessdata` にあります（tessdata_best リポジトリの LICENSE をそのまま収録）。
- 配布元の https://github.com/naptha/tessdata も Apache License 2.0 です。なお npm パッケージ `@tesseract.js-data/*` の package.json には `"license": "MIT"` と書かれていますが、これはパッケージとしての包み方の表記で、データ自体のライセンスは上記のとおりです。

## 取得のされ方

アプリは、使う向き（縦書き／横書き）の分だけ、初回の文字認識の前に利用者の同意を得てから、同じサイトのこのフォルダから取得します。Service Worker のインストール時にまとめて取得することはありません。
