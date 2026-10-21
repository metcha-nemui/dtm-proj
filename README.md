# DTM工程管理

楽曲制作(DTM)の作業を「セクションごとのタスク」として管理するローカルWebアプリ。1曲を1プロジェクトとし、複数のプロジェクトを並行して持てる。

- 構成(セクション)は自由に編集できる。歌モノ以外にも使える。
- 運用ルールに頼らず、型はツール側の構造で保つ。
- 計画変更(セクションの追加・削除・並べ替え、タスクの移動)を気軽にできる。

MVP、アレンジ(MIDI クリップとピアノロール)、Supabase への保存(擬似ログイン)は実装済み。下の「これから」にあるものは未着手。

## ドキュメント

この README は全体の地図。画面ごとの細かい仕様は `docs/` に分けてある。作業するときは、触る範囲のものだけを読み、変えたら同じコミットで直す。

| ファイル | 内容 |
|---|---|
| [docs/board.md](docs/board.md) | プロジェクト一覧、締切パネル、ボード、タスク詳細、ガントチャート、リファレンス、セクションの色、設定 |
| [docs/arrangement.md](docs/arrangement.md) | アレンジ画面(トラック、クリップ、セクションマーカー、連動タスク、スケール、再生、音源、.mid と WAV の書き出し、.mid の読み込み) |
| [docs/pianoroll.md](docs/pianoroll.md) | ピアノロール(編集、ベロシティ、オニオンスキン、ループ再生) |
| [docs/storage.md](docs/storage.md) | 保存先とログイン、通信の失敗、インポート・削除の連鎖、スキーマバージョン、PWA |

## 起動

ビルドは不要。静的サーバーで配信して開く(`file://` では ES Modules が動かない)。

```
python -m http.server 8765
```

`http://localhost:8765/` を開くとログイン画面が出る。Supabase の Project URL と公開キーを入れるか、「ログインせずに使う」を選ぶ(その場合、データはそのブラウザの IndexedDB に入る)。PWA としてインストールでき、IndexedDB ならオフラインでも使える([docs/storage.md](docs/storage.md))。

テストは `http://localhost:8765/test.html` を開くか、Node で実行する。

```
node -e "import('./test/domain.test.js').then(m => m.report()).then(ok => process.exit(ok ? 0 : 1))"
```

## 決めたこと

| 項目 | 決定 |
|---|---|
| 工程軸(作曲→編曲→ミックス…) | 持たない。マトリクス表示もしない |
| 動線(作業順) | レーン内の並び順で表現する。ドラッグで入れ替える。タスク間の依存関係は持たない |
| セクション種別 | 持たない(廃止)。「サビ」「サビ2」「サビ3」は別々のレーン。名前は重なってもよい |
| タスクの属性 | タイトル / ステータス(未着手・作業中・完了) / 開始日・終了日 / リファレンス / メモ。見積もり時間は持たない |
| タスクの開始日・終了日 | 実績(着手した日・終わった日)。ステータスを変えたときに自動で入り、タスク詳細で修正できる。予定は入れない |
| リファレンス | 参考にする楽曲の曲名を、タスクごとに自由入力で付ける(複数可)。曲名を管理する画面は作らず、同じプロジェクトの曲名を候補に出して表記揺れを防ぐだけ |
| ガントチャート | ボードの下に出す、作業の記録(予定ではない)。表示のみ。スマホ幅では出さない |
| 締切 | プロジェクトごとに任意で1つ(日付のみ) |
| 「全体」レーン | すべてのプロジェクトに必ず1本ある。名前変更・複製・削除・並べ替えはできない |
| アレンジ | プロジェクトごとの、DAW のアレンジ画面のような別ページ。クリップは MIDI のノートを持つ最低限の下書き用。再生はブラウザ内で、端末ごとに選んだ SoundFont / DLS を鳴らす |
| オーディオトラック | 1本につき音声ファイル1つ。クリップは置かず、鳴らし始める位置だけを動かせる。ファイルは端末ごとの IndexedDB に置き、Supabase には入れない(中身のない端末では印を出し、選び直してもらう)。伸び縮みはさせない(BPM とずれても割り切る)。録音はしない |
| アレンジとボード | クリップは、属するセクションのレーンに連動タスク(`clipId` を持つ Task)として出る |
| テンプレート | 持たない(廃止)。狙いが曖昧なまま保守コストが掛かるのでやめた。ボードとアレンジの仕様が固まった頃に、何のために持つかから考え直す |
| 色 | 選ばせない。セクションの並び順で固定パレット(18色)を1色ずつ割り振る。保存しない |

## 技術方針

- 素の HTML / CSS / JavaScript(ES Modules)。ビルドステップなし。そのまま GitHub Pages に置ける。
- 外部依存は CDN から読むものだけ。**SortableJS**(ドラッグ&ドロップ)、**Lucide**(アイコン)、**spessasynth_lib**(SoundFont / DLS の再生)と、その中身の **spessasynth_core**(WAV の書き出し。Worker の中で直接使う)。spessasynth は版を固定し、使うときに動的に読む。
- 保存先は Supabase か IndexedDB。repository 層で抽象化してあり、UIとドメインロジックはどちらに保存しているかを知らない([docs/storage.md](docs/storage.md))。
- ルーティングはハッシュ方式。IDは `crypto.randomUUID()`。
- 並び順は小数の `order`(fractional indexing)。間に入れるときは前後の中間値を使い、他の行を書き換えない。精度が尽きたときだけ全体を振り直す。

### データの流れ

1. 画面が `actions.js` の操作を呼ぶ。
2. 操作は repository から読み、`domain/` の関数で保存すべきレコードを計算し、保存して `notify()` する。
3. 各画面は `subscribe()` で通知を受け、repository から読み直して全体を再描画する。フォーカスと入力中の値は `data-focus-key` を目印に引き継ぐ(`keepFocus`)。

指で操作する画面(`pointer: coarse`)では、ダイアログやパネルを開いたときに文字の入力欄へ自動でフォーカスを当てない(キーボードが開いて、横持ちでは画面を占領するため)。入力欄に当てるときは `autoFocus`、`<dialog>` が自分で当てた分は `dropAutoFocus` で外す(`js/ui/components/dom.js`)。

操作は1つずつ順番に実行される(`serial`)。並行して走ると、後から保存した方が先の変更を消してしまうため。

### データモデル

```js
Project  { id, title, memo, dueDate, bpm, scales }   // dueDate は 'YYYY-MM-DD' または null。scales は [{ bar, root: 0〜11, mode: 'major' | 'minor' }](小節の順で、1小節目は必ずある)
Lane     { id, projectId, type: 'section' | 'global', name, order, collapsed }
Task     { id, projectId, laneId, title, memo, status: 'todo' | 'doing' | 'done', order, doneAt,
           startDate, endDate,                       // 実績。どちらも 'YYYY-MM-DD' または null
           references,                               // リファレンスの曲名(string[])
           clipId }                                  // 連動タスクなら元のクリップの id。ふつうは null。無所属の間は laneId が null
Track    { id, projectId, name, order,
           program, volume, pan, drum,               // GM の音色(0〜127)、音量・パン(0〜127。パンは64が中央)、ドラムか
           kit,                                      // ドラムキット(10ch のプログラム番号。GS の並び)。ドラムでなければ使わない
           mute, solo, reverb,                       // 再生だけに効く。reverb は項目がなければ true
           kind, audio }                             // kind はオーディオトラックなら 'audio'(項目がなければ MIDI)。
                                                     // audio は { fileId, name, size, duration(秒), startTick }。中身は端末ごとの IndexedDB
Clip     { id, projectId, trackId, name, memo, startBar, bars,   // 小節は1始まりの整数。bars は1以上
           notes: [{ pitch, start, length, velocity }] }        // 位置はクリップの先頭からの相対で、単位は tick(4分音符 = 480)
Marker   { id, projectId, laneId, bar }              // セクションマーカー。名前と色は指しているレーンのもの
```

すべてに `createdAt` と `updatedAt` が付く。詳しい型は `js/store/repository.js` にある。

## 構成

```
index.html
manifest.webmanifest      PWA のマニフェスト
sw.js                     Service Worker(オフラインでの起動のためのキャッシュ)
icons/                    アプリのアイコン。icon.svg と icon-maskable.svg が元で、PNG はヘッドレス Chrome で書き出した
test.html                 テストをブラウザで実行
test/                     テスト(Nodeでも動く)。domain.test.js が入口で、モジュールごとの *.test.js を読む。共通の部品は helpers.js。
                          Supabase 実装は、APIのふりをする fetch で確かめている
supabase/                 schema.sql(テーブル定義。SQL Editor で実行)、drop.sql(すべて消す)
docs/                     画面ごとの仕様
tools/                    開発用(依存なし)。browser.mjs は画面の動作確認に使うヘッドレス Chrome の操作、
                          crlf.mjs は Claude Code の hook(.claude/settings.json)から呼ぶ改行の統一
css/
  tokens.css              色・余白などのCSS変数(ダークモード対応)
  base.css                共通部品(ボタン、入力、ダイアログ、メニュー、トースト)
  projectList.css         プロジェクト一覧、締切パネル
  board.css               ボード(レーン、タスク、計画変更、セクション一覧)とスマホのレイアウト
  drawer.css              タスク詳細・クリップ詳細のドロワー、リファレンスの欄と一覧
  gantt.css               ガントチャート
  arrangement.css         アレンジ画面、ボード/アレンジの切り替えタブ
  pianoroll.css           ピアノロール
  settings.css            設定
js/
  main.js                 起動(ログイン状態を見て保存先を決める)、ルーター
  pwa.js / session.js / theme.js   Service Worker の登録 / 擬似ログインの状態 / UIテーマ
  state.js                repository の参照と、変更通知(subscribe / notify)
  synth.js                ブラウザ内の音源(spessasynth_lib)と再生(オーディオトラックの音声も)。何を鳴らすかは domain/midi.js・audio.js で組み立てる
  audioExport.js          WAV の書き出し。音を作るのは audioExportWorker.js(Worker の中で spessasynth_core を動かす)
  actions.js              画面から呼ぶ操作。読む→domainで計算→保存→notify
  domain/                 DOMにもrepositoryにも依存しない純粋なロジック
                          (record, order, date, project, task, stats, deadline, gantt, reference, arrangement, midi, audio, work)
  store/
    repository.js         インターフェース定義(JSDoc)、createRepository、migrate、upgradeStorage / checkSchema
    indexeddb.js          文書ストアの IndexedDB 実装
    supabase.js           文書ストアの Supabase 実装
    soundFontStore.js     音源ファイルの保存(このブラウザの IndexedDB。repository とは別)
    audioFileStore.js     オーディオトラックの音声ファイルの保存(同上)
  ui/                     画面。各ファイルの先頭のコメントに役割がある
    components/           dom(h, icon, keepFocus)、dialog、menu、toast、sortable、knob、pointer(ドラッグの共通部分)、slowNotice、autoGrow
```

## これから(未着手)

- **「次やる」ビュー**:各レーンの未完了タスクの先頭と作業中のタスクを横断して一覧にする。使ってみて欲しくなったら追加する。
- **GitHub Pages でのホスト**:GitHub にリポジトリを作って push し、Settings → Pages で `main` ブランチのルートを公開する。ビルドは不要。
- **速度と通信の改善**:Supabase では1操作あたりの通信回数が多い。読み直しを減らす(手元の状態を先に更新する)、オフライン時に書き込みをキューに貯めて再送する、など。
- **本物の認証**:複数人で使う、または公開キーを秘密にしたくない場合は、Supabase Auth と user_id 単位の RLS に切り替える。
- **工程タグ**:必要になったら、タスクに任意のタグを付けてフィルタできるようにする。

## まだ確かめていないこと

- タッチ操作の実機確認(長押しでのドラッグ、ボトムシート、アレンジのクリップとマーカーのドラッグ、ピアノロール)
- 実際に耳で聞いての再生(タイミング、音色、パン)。ヘッドレス Chrome(音は消して)では、gm.dls と GeneralUser GS を読み込み、再生中に発音数が増え、停止で 0 に戻ることまでを確かめた
- Chrome 以外のブラウザ
- スマホ(Android / iOS)の実機でのインストールと、ホーム画面のアイコンの見た目
- ダークモードの見た目
