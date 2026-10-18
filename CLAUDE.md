# CLAUDE.md

楽曲制作(DTM)の作業を「セクションごとのタスク」として管理するローカルWebアプリ。
全体の地図(決めたこと・構成・データモデル・未着手の項目)は [README.md](README.md)、画面ごとの細かい仕様は `docs/` にある。README は最初に読む。`docs/` は触る範囲のファイルだけを読む(全部は読まない)。

## 作業の進め方

- **変更は現在のブランチに自動でコミットする。** 確認は取らない。動く状態になった区切りごとに、日本語のメッセージでコミットする。push は頼まれたときだけ。
- 仕様を変えたら同じコミットで該当する `docs/*.md` を、決めたこと・構成・データモデルを変えたら README.md を直す。これらが「いまの状態」を表す唯一の資料になるようにする(計画書や作業ログは別に作らない)。
- ドキュメントには「いまどう動くか」だけを書く。経緯(以前は〜だった)は書かない(git の履歴にある)。データの変換の経緯は `js/store/repository.js` の `SCHEMA_VERSION` の上のコメントに書く。同じことを2か所に書かない。
- ユーザーとのやり取り、UIの文言、コードコメント、コミットメッセージは日本語。

## 確認のしかた

- ドメインロジックと保存まわりのテスト(ブラウザなら `test.html` を開く):

  ```
  node -e "import('./test/domain.test.js').then(m => m.report()).then(ok => process.exit(ok ? 0 : 1))"
  ```

- `js/domain/` を変えたら、`test/` のそのモジュールのファイル(`midi.test.js` など。共通の部品とテスト用のデータは `helpers.js`)にテストを足す。新しいファイルを作ったら `test/domain.test.js` で読み込む。画面の変更は、実際にブラウザで操作して確かめる。
- ブラウザでの確認は `tools/browser.mjs` を使う(確認用の CDP スクリプトを毎回書かない。足りない操作があればこのスクリプトに足す)。詳しい使い方は先頭のコメントにある:

  ```
  node tools/browser.mjs start                   # サーバー(8766)とヘッドレス Chrome を起動。ログインせずに使う状態で開く
  node tools/browser.mjs eval "(await import('/js/actions.js')).createProject({ title: 'テスト' })"
  node tools/browser.mjs open p/<id>/arrange     # 「#/」は省く。読み込み中の例外を出す
  node tools/browser.mjs click .clip             # ほかに drag x1 y1 x2 y2 [Ctrl]、key Delete
  node tools/browser.mjs shot <scratchpad>/a.png .arr-tracks
  node tools/browser.mjs stop                    # 起動したプロセスだけを終了する
  ```

- 確かめるときは、まず eval で DOM の状態(クラス、件数、値)を取って比べる。スクリーンショットは見た目を確かめたいときだけにし、セレクタで要素だけを撮る(画面全体は撮らない)。
- プロセスを自分で起動したときも、終了は起動したものだけにする。`taskkill /IM chrome.exe` のようにプロセス名でまとめて終了すると、ユーザーが普段使っているブラウザまで閉じてしまう。ヘッドレス Chrome の `--user-data-dir` は短いパス(`%TEMP%\dtmcs` など)にする(深いと Cache Storage のパスが 260 文字を超え、Service Worker が本来と違う動きになる)。

## コーディング規約

- 改行は CRLF、インデントはスペース3つ(`.editorconfig` と `.gitattributes` に設定済み)。JS・CSS・HTML すべて同じ。
- HTML の先頭は `<!DOCTYPE html>`(大文字)。個人用なので、HTML には検索エンジン避けの `<meta name="robots" content="noindex, nofollow, noarchive">` を入れる。
- ツールで書いたファイルは改行が LF になりやすいが、Write / Edit のあとに hook(`.claude/settings.json` → `tools/crlf.mjs`)が CRLF に揃えるので、手で確かめなくてよい(シェルで書いたファイルには効かない)。
- 周りのコードに合わせる(コメントの量、命名、書き方)。コメントは日本語で、「なぜそうしているか」を書く。

## 守ること

- ビルドステップなしの素の HTML / CSS / JavaScript(ES Modules)。npm の依存は足さない。外部ライブラリは CDN から読む SortableJS、Lucide、spessasynth_lib(SoundFont / DLS の再生)だけ。版は固定する。
- SoundFont / DLS のファイルはリポジトリに入れない(端末ごとに設定画面で選び、ブラウザの IndexedDB に置く)。
- `js/domain/` は DOM にも repository にも依存しない。受け取ったレコードは変更せず、保存すべき新しいレコードを返す。
- UI は repository を直接書き換えない。書き込みは `js/actions.js` の操作を通す(読む→計算→保存→通知を直列に実行している)。
- repository の実装は2つある(IndexedDB と Supabase)。メソッドを足す・変えるときは `js/store/repository.js` の定義と両方の実装を揃える。テーブルの列を変えたら `supabase/schema.sql` も直す。
- Supabase の Project URL と公開キーは、リポジトリに入れない(コード、テスト、ドキュメント、コミットメッセージのどこにも書かない)。公開キーを知っていれば全データを読み書きできる設計なので、秘密として扱う。
- ユーザー入力は `h()` でテキストノードとして入れる。`innerHTML` は使わない。
- フォントは `"Noto Sans JP"` を最優先(インストール済みのものを使う。Webフォントは読み込まない)。
- アイコンは Lucide(`icon('名前')`)。メニューを開くボタンは縦3点の `ellipsis-vertical`。
- セクションの色は選ばせない。固定パレット(`SECTION_COLORS`。系統の違う9色と、その明るい9色)を、プロジェクト内の並び順で1本ずつ自動的に割り振る(名前は見ない。同じ名前の系統でも別の色)。色は保存しない。似た色を増やさない。
- タスクに「定番 / 固有」の出自は持たせない(削除済み)。
- テンプレート機能は廃止した(セクション種別・定番タスクも削除済み)。ボードとアレンジの仕様が固まるまで、作り直さない。
- アイコンに使える記号は Lucide に寄せる(完了のチェックマークも Lucide)。
- 見積もり時間の概念は持たない(削除済み)。
- タスクの開始日・終了日は実績(着手した日・終わった日)。ステータスの変更で自動的に入れ、手では修正だけを受け付ける。予定の日付は持たせない。
- 「全体」レーンは全プロジェクトに必ず1本あり、名前変更・複製・削除・並べ替えはできない。
