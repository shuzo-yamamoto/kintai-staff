# 画箋堂 勤怠（スタッフ用サイト）

スタッフが出勤・退勤・休憩を打刻するための Web アプリ（PWA）です。GitHub Pages で公開し、データは非公開のサーバー側（Google Apps Script）に保存します。

- 個人のスマートフォン: 従業員番号と PIN で一度ログインすると、次からはボタンを押すだけで打刻できます
- 店舗のタブレット: 名前を選び PIN を入力して打刻します
- 打刻のときだけ位置情報を一度取得し、店舗内か店舗外かの判定だけを記録します（緯度・経度は保存しません）

## このリポジトリに置かないもの

このリポジトリは公開です。次のものは絶対に置きません。

- 個人名・メールアドレス・PIN・トークン・鍵・テストデータ
- PDF・Excel・CSV などの書類

コミットの前に `.githooks/pre-commit` が自動で調べます。最初に一度だけ次を実行してください。

```
git config core.hooksPath .githooks
```

push の前には、非公開の本体リポジトリの `tools/check_public_repo.py --all` で履歴を含めて調べます。

## ファイル

| ファイル | 内容 |
|---|---|
| index.html | 画面 |
| css/style.css | 見た目 |
| js/config.js | 接続先（スタッフ用 API の URL） |
| js/api.js | API の呼び出し・端末の保存領域・位置の取得 |
| js/app.js | 画面の動き |
| sw.js | 画面の部品のキャッシュ（画面を変えたら `CACHE_VERSION` を上げる） |
| manifest.webmanifest・icons/ | ホーム画面に追加したときの名前とアイコン |

外部のライブラリ・CDN は使っていません。
