// ピアノロール。アレンジ画面の下に出すパネルで、選んだクリップ1つのノートを編集する。
// 操作は FL Studio に寄せている:空いているところを押すとノートを置き(そのままドラッグで動かせる)、
// ノートを掴むと移動、右端を掴むと長さを変える。右クリックで消す(押したままなぞると続けて消す)。
// ノートを置く長さは、最後に触ったノートの長さ。Ctrl+ドラッグで囲んだノートを選ぶ(Shift も押すと選択に足す)。
// タッチでは、グリッドの上の指はスクロールに使わず、すぐノートの操作にする(スクロールと取り合うと、操作の起点が長押しに頼ることになり使いにくいため)。
// 横のスクロールは下端の太いスクロールバー、縦のスクロールは鍵盤の上の指で行う。
// 2本の指のピンチは、鍵盤の上ならノートの高さ、横のスクロールバーの上なら1拍の幅を変える。
// ヘッダーの「ピンチモード」を ON にした間は、グリッドのどこでもピンチでき(指の並びの向きで縦横を決める)、1本の指でスクロールする。
// その間はノートの操作をしない(スクロールバーは画面の下端にあり、OS のジェスチャーと取り合ってピンチしにくいため)。
// ノートのドラッグは「置く・動かす」が基本で、ヘッダーの「伸縮モード」を ON にした間だけ「長さを変える」にする(端を狙わずに済むように)。
// 選んでいるノートは、右端に出す十字キー(上にオクターブの上下)でも動かせる。タッチの画面では、グリッドの右に編集のボタン(元に戻す・切り取り・コピー・貼り付け・削除など)を縦に並べる。
// 選んだノートは Ctrl+C でコピー(Ctrl+X で切り取り)し、Ctrl+V で再生を始める位置(クリップの外ならクリップの頭)に貼り付ける。
// 行の塗り分けは鍵盤の白黒ではなく、プロジェクトのスケール(キーとメジャー / マイナー)に合わせる。
// スケールはアレンジ画面の「スケール」の段で決め、クリップの途中で転調していれば、転調の位置から塗り分けを変える。
// ノートはクリップの範囲(左端〜右端)からはみ出すようには動かせない。右端の外には1小節の余白を出す(ノートは置かない。右端の近くを触りやすくするため)。
// 同じ高さ・同じ位置で始まるノートが重なっていたら赤くする(気付いて片方を消せるように)。
// オニオンスキン:ほかのトラックの、同じ時間に鳴るノートを薄く重ねて出せる(表示だけ。押せない)。
// 全体の ON / OFF と、トラックごとの ON / OFF がある。覚えておかず、閉じた状態から開くたびに「全体 OFF・各トラック ON」に戻す。
// ベロシティ:グリッドの下の段に、ノートの頭の位置で縦棒として出す(ノートの濃さにも映す)。段を押して上下になぞると、
// なぞった位置の棒をその高さのベロシティにする(FL Studio と同じ。選んでいるノートがあれば、選んでいるものだけを変える)。
// Alt を押している間は既定値(100)にし、Shift を押して始めると直線で描く。
// 新しく置くノートのベロシティは、最後に触ったノートのもの。
//
// 元に戻す / やり直す(Ctrl+Z / Ctrl+Y・Ctrl+Shift+Z。タッチではグリッドの右のボタン)は、クリップごとに、保存したノートの写しを積んで行う。
// ピアノロールの外でノートや長さが変わったとき(.mid の読み込み、クリップの伸縮、ほかの端末)、保存に失敗したとき、
// クリップを消したときは、古い写しを戻すと位置がずれたりはみ出したりするので、そのクリップの履歴を捨てる。
// 履歴は覚えておかない(アレンジ画面を離れると消える)。
//
// 編集は手元の notes に反映してから、操作の区切り(ポインタを離したとき)ごとにクリップのノートを丸ごと保存する。
// 表示の単位は px、ノートの単位は tick(midi.js)。

import * as actions from '../actions.js';
import {
   audibleNotes, BEATS_PER_BAR, clipTicks, inScale, isBlackKey, normalizeNotes, pitchName, playbackMessages, PPQ, projectScales,
   scaleLabel, scaleSpans, TICKS_PER_BAR, trackChannels,
} from '../domain/midi.js';
import { sortByOrder } from '../domain/order.js';
import { UNTITLED_CLIP } from '../domain/arrangement.js';
import { barRange } from './clipDrawer.js';
import { h, icon } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { drawMarquee, trackPointer } from './components/pointer.js';
import { reportError, showToast } from './components/toast.js';
import { clipMidi, downloadMidi } from './midiExport.js';
import { importMidiToClip } from './midiImport.js';
import { previewNote } from '../synth.js';

const EDGE = 6; // ノートの右端の、掴むと長さを変えられる幅(px)
const VEL_HEIGHT = 64; // ベロシティの段の高さ(px。CSS の --pr-vel-h に渡す)
const VEL_PAD = 6; // ベロシティの段の上の余白(127 の棒が上端に付かないように)
const VEL_HIT = 4; // ベロシティの段で、なぞった位置から棒を拾う幅(px)
const VEL_TAP_HIT = 16; // タッチのダブルタップで既定値にするとき、棒を拾う幅(px)と、1回目からずれてよい幅
const DOUBLE_TAP_MS = 350; // ダブルタップとみなす間隔
const DEFAULT_VELOCITY = 100;
const DRAG_THRESHOLD = 3;
// タッチで、空いているところをこれだけ押さえたら、囲んで選ぶ。アレンジ画面のクリップの長押しと揃える
const HOLD_MS = 350;
// タッチで、これだけ動いたらドラッグとみなす(px)。指は少し揺れるので、マウスより広くとる(タップで選ぶつもりが動かさないように)
const TOUCH_SLOP = 8;
// タッチの伸縮モードで、ノートの左右のこれだけ外側(px。同じ高さの空いているところ)を押しても、そのノートを掴む。
// 指は狙った位置からずれやすく、短いノートは指より細いので
const RESIZE_REACH = 16;
const RULER_H = 20; // ルーラーの高さ(px。CSS の --pr-ruler-h と揃える)
// クリップの右端の外に出す余白(tick)。右端の近くのノートを掴むとき、指や十字キーに隠れて窮屈にならないように。
// 余白にはノートを置かない(表示と、ドラッグの続きのためだけ)
const MARGIN = TICKS_PER_BAR;
// 十字キーを押し続けたとき、くり返し動かし始めるまでと、その間隔(ms)
const REPEAT_DELAY = 400;
const REPEAT_MS = 90;
const HISTORY_LIMIT = 100; // 元に戻せる回数(クリップごと)
const SAVE_DELAY = 1000; // 最後の編集から保存するまで(ミリ秒)
// 3連は、元の音符の 2/3 の長さ(1/8 3連 = 4分音符を3つに分けた長さ)
const SNAPS = [
   { value: String(PPQ), label: '1/4' },
   { value: String((PPQ * 2) / 3), label: '1/4 3連' },
   { value: String(PPQ / 2), label: '1/8' },
   { value: String(PPQ / 3), label: '1/8 3連' },
   { value: String(PPQ / 4), label: '1/16' },
   { value: String(PPQ / 6), label: '1/16 3連' },
   { value: String(PPQ / 8), label: '1/32' },
   { value: String(PPQ / 12), label: '1/32 3連' },
   { value: '1', label: 'なし' },
];
const SNAP_KEY = 'dtm-proj:piano-roll-snap';

// パネルの高さ(px)。上端のつまみをドラッグして変える。null なら既定(CSS)。
// 上はアレンジ画面のツールバー(再生・BPM)の下端まで。それより高い値を覚えていても、CSS の flex で縮んでツールバーは隠れない。
// gantt.js と同じく、このブラウザの localStorage に覚えておく
const HEIGHT_KEY = 'dtm-proj:piano-roll-height';
const MIN_HEIGHT = 140; // 見出し・ルーラー・数行・ベロシティの段が見える高さ
const KEY_STEP = 48; // 矢印キーで動かす量

function loadHeight() {
   try {
      const value = Number(localStorage.getItem(HEIGHT_KEY));
      return value >= MIN_HEIGHT ? value : null;
   } catch {
      return null; // localStorage を使えない環境では、その場かぎりにする
   }
}

let savedHeight = loadHeight();

// 1音の高さ(px)。タッチでは鍵盤の上の縦のピンチ、マウスでは Ctrl+Shift+ホイールで変える。
// 指で押すスマホ(pointer: coarse)は、既定を広めにする。パネルの高さと同じく、このブラウザの localStorage に覚えておく
const ROW_KEY = 'dtm-proj:piano-roll-row';
const MIN_ROW = 8;
const MAX_ROW = 32;
const WHEEL_ROW_STEP = 2; // ホイール1目盛りで変える量(px)

function loadRow() {
   try {
      const saved = Number(localStorage.getItem(ROW_KEY));
      if (Number.isInteger(saved) && saved >= MIN_ROW && saved <= MAX_ROW) return saved;
   } catch {
      // 覚えていなければ既定
   }
   return matchMedia('(pointer: coarse)').matches ? 20 : 12;
}

let row = loadRow();

// 1拍の幅(px)。タッチでは横のスクロールバーの上のピンチ、マウスでは Ctrl+ホイールで変える。ノートの高さと同じく覚えておく
const BEAT_KEY = 'dtm-proj:piano-roll-beat';
const MIN_BEAT = 16;
const MAX_BEAT = 256;
const WHEEL_BEAT_RATIO = 1.25; // ホイール1目盛りで変える倍率
const WHEEL_STEP = 50; // 1段変えるのに要るホイールの量(px。マウスの1目盛りは 100 前後)

function loadBeat() {
   try {
      const saved = Number(localStorage.getItem(BEAT_KEY));
      if (Number.isInteger(saved) && saved >= MIN_BEAT && saved <= MAX_BEAT) return saved;
   } catch {
      // 覚えていなければ既定
   }
   return 64;
}

let beat = loadBeat();
let px = beat / PPQ; // 1 tick の幅(px)

function loadSnap() {
   try {
      const saved = localStorage.getItem(SNAP_KEY);
      if (SNAPS.some((s) => s.value === saved)) return Number(saved);
   } catch {
      // 覚えていなければ既定(1/16)
   }
   return PPQ / 4;
}

const noteKey = (n) => `${n.pitch}:${n.start}:${n.length}`;
// 重なりの判定に使う(長さは見ない。同じ高さ・同じ位置で始まるなら、長さが違っても重なっている)
const onsetKey = (n) => `${n.pitch}:${n.start}`;
const sameNotes = (a, b) => JSON.stringify(normalizeNotes(a)) === JSON.stringify(normalizeNotes(b));

// コピーしたノート(いちばん早いノートの頭からの相対)。クリップを切り替えても残し、別のクリップにも貼り付けられるようにする
let clipboard = [];

/**
 * @param {object} options
 * @param {string} options.projectId
 * @param {(clipId: string|null) => void} [options.onSelectionChange] 開いているクリップが変わったとき
 * @param {(clip: object) => void} [options.onPlayClip] 「このクリップだけをループ再生」(ループ中なら止める)
 * @param {(clipId: string) => boolean} [options.isLooping] そのクリップをループで鳴らしているか(再生ボタンを停止の形にする)
 * @param {() => void} [options.onPlayAll] 「全体を再生」(全体を再生中なら止める)
 * @param {() => boolean} [options.isPlayingAll] 全体を再生しているか
 * @param {(clipId: string) => void} [options.onOpenDetail] クリップ詳細を開く
 * @param {(tick: number) => void} [options.onSeek] ルーラーを押して、再生を始める位置(曲の頭からの tick)を変えたとき
 * @param {() => boolean} [options.isPlaying] 再生中か(再生中は貼り付けさせない)
 * @param {() => void} [options.onNotesChange] ノートを変えたとき(保存を待たずに、クリップの表示と再生に効かせる。中身は editing で取る)
 * @param {() => number} [options.topLimit] パネルの上端をここ(画面上の y 座標)より上へは広げない
 */
export function createPianoRoll({
   projectId, onSelectionChange, onPlayClip, isLooping = () => false, onPlayAll, isPlayingAll = () => false, onOpenDetail, onSeek,
   isPlaying = () => false, topLimit = () => 0, onNotesChange,
}) {
   let data = null; // アレンジ画面が読み込んだもの(project / tracks / clips)
   let clipId = null;
   let notes = []; // 編集中のノート(クリップの先頭からの相対)
   let selected = new Set(); // notes の要素
   let lastLength = PPQ;
   let lastVelocity = DEFAULT_VELOCITY;
   let snap = loadSnap();
   let dragging = false;
   let pending = 0; // 保存を待っている数。その間は、読み直した(古いかもしれない)ノートで上書きしない
   let saveTimer = null; // まとめて保存するまでの待ち。動いている間は、まだ保存していない変更がある
   const unsaved = () => saveTimer != null || pending > 0;
   let onion = false; // オニオンスキンを出すか
   let onionOff = new Set(); // オニオンスキンに出さないトラックの id
   // 元に戻す履歴。clipId → { saved: 保存したノート, bars: そのときの長さ, undo: [ノート…], redo: [ノート…] }
   const history = new Map();

   const title = h('span', { class: 'pr-title' });
   const range = h('span', { class: 'pr-range muted' });
   const scaleText = h('span', { class: 'pr-range muted', title: 'スケール(アレンジ画面の「スケール」の段で変える)' });
   const snapSelect = h('select', {
      class: 'select pr-snap',
      'aria-label': 'グリッド',
      title: 'グリッド(ノートを置く・動かすときに合わせる細かさ。Alt を押しながらだと合わせない)',
      onchange: () => {
         snap = Number(snapSelect.value);
         renderGridLines();
         try {
            localStorage.setItem(SNAP_KEY, snapSelect.value);
         } catch {
            // 覚えられなくても、この画面の間は効く
         }
      },
   }, SNAPS.map((s) => h('option', { value: s.value, selected: Number(s.value) === snap }, s.label)));
   const keys = h('div', { class: 'pr-keys' });
   // ルーラーを押すと、押した位置(いまのグリッドの単位に切り捨て)が再生を始める位置になる
   // (アレンジ画面のルーラーの赤い印と同じもの)。グリッドが「なし」なら 1/16 単位
   let startTick = 0; // 曲の頭からの tick
   const cursor = h('span', { class: 'pr-cursor', hidden: true, 'aria-hidden': 'true' });
   const ruler = h('div', {
      class: 'pr-ruler',
      title: '押した位置(グリッドの単位)から再生します',
      onclick: (e) => {
         const c = clip();
         if (!c || (pinchMode && e.pointerType === 'touch')) return; // ピンチモードの指では動かさない
         const unit = snap > 1 ? snap : PPQ / 4;
         const last = Math.floor((clipTicks(c) - 1) / unit) * unit;
         const at = Math.floor((e.clientX - ruler.getBoundingClientRect().left) / px / unit) * unit;
         onSeek?.((c.startBar - 1) * TICKS_PER_BAR + Math.max(0, Math.min(last, at)));
      },
   });
   const rows = h('div', { class: 'pr-rows', 'aria-hidden': 'true' });
   const layer = h('div', { class: 'pr-notes' });
   // オニオンスキンは編集するノートの下に敷く(押せない)
   const onionLayer = h('div', { class: 'pr-onion', 'aria-hidden': 'true' });
   const playhead = h('div', { class: 'pr-playhead', hidden: true });
   const grid = h('div', {
      class: 'pr-grid',
      onpointerdown: (e) => onGridDown(e),
      oncontextmenu: (e) => e.preventDefault(),
   }, rows, onionLayer, layer, playhead);
   // 編集のボタン(キーのないタッチの画面のため。キー操作と同じ)。グリッドの右に縦に並べる。
   // ヘッダーに置くと、ボタンの数で折り返したり、選んだときだけ出るボタンで段がずれたりするため
   const sideButton = (name, label, title, onclick) => h('button', {
      type: 'button', class: 'pr-side-button', title, 'aria-label': title, disabled: true, onclick,
   }, icon(name, 20), h('span', {}, label));
   const undoButton = sideButton('undo-2', '戻す', '元に戻す', () => undo());
   const redoButton = sideButton('redo-2', 'やり直す', 'やり直す', () => redo());
   const cutButton = sideButton('scissors', '切り取り', '選んだノートを切り取る', () => cut());
   const copyButton = sideButton('copy', 'コピー', '選んだノートをコピー', () => copy());
   const pasteButton = sideButton('clipboard-paste', '貼り付け', '赤い印の位置(クリップの外ならクリップの頭)に貼り付ける', () => paste());
   const deleteButton = sideButton('trash-2', '削除', '選んだノートを消す', () => deleteSelected());
   deleteButton.classList.add('is-danger');
   // 選んだノートのベロシティを既定値にする(PC の Alt を押しながらなぞるのと同じ。タッチには Alt がないため)
   const velResetButton = sideButton('chart-no-axes-column', 'ベロ 100', `選んだノートのベロシティを ${DEFAULT_VELOCITY} にする`,
      () => resetVelocity());
   const side = h('div', { class: 'pr-side pr-touch-only' },
      undoButton, redoButton, cutButton, copyButton, pasteButton, velResetButton, deleteButton);

   // 選んでいるノートとコピーしたノートがあるかで、編集のボタンを押せるようにする
   function renderEditButtons() {
      cutButton.disabled = !selected.size;
      copyButton.disabled = !selected.size;
      deleteButton.disabled = !selected.size;
      velResetButton.disabled = !selected.size;
      pasteButton.disabled = !clipboard.length;
   }
   // タッチのモード(伸縮・ピンチ・ベロシティ)の切り替えボタン。どれか1つだけが ON になる(ラジオボタンのように。
   // ON のボタンをもう一度押すと OFF)。PC では出さない
   const modeToggle = (name, iconName, label, title) => h('button', {
      type: 'button',
      class: 'btn btn-icon pr-mode-toggle pr-touch-only',
      title,
      'aria-label': label,
      'aria-pressed': 'false',
      dataset: { mode: name },
      onclick: () => setMode(mode === name ? null : name),
   }, icon(iconName));
   // 伸縮モード:ノートをドラッグすると(どこを掴んでも)長さが変わる。置く・動かすはしない
   const resizeToggle = modeToggle('resize', 'unfold-horizontal', '伸縮モード',
      '伸縮モード(ON の間は、ノートをドラッグして長さを変える。置く・動かすはできない)');
   // ピンチモード:グリッドのどこでも2本の指でピンチし、1本の指でスクロールする。ノートの操作はしない
   const pinchToggle = modeToggle('pinch', 'zoom-in', 'ピンチモード',
      'ピンチモード(ON の間は、どこでも2本の指で拡大・縮小し、1本の指でスクロールする。ノートは操作できない)');
   // ベロシティモード:この間だけベロシティの段を出す(OFF の間は出さない)。
   // 段は指が触れた瞬間に塗るので、スクロールやほかの操作のつもりで触れて変えてしまわないように。PC ではいつも出す
   const velToggle = modeToggle('velocity', 'chart-no-axes-column', 'ベロシティ',
      'ベロシティ(ON の間だけ、グリッドの下にベロシティの段を出して編集できる)');
   let mode = null; // 'resize' | 'pinch' | 'velocity' | null
   let resizeMode = false;
   let pinchMode = false;
   const coarse = matchMedia('(pointer: coarse)');
   function setMode(next) {
      mode = next;
      resizeMode = mode === 'resize';
      pinchMode = mode === 'pinch';
      for (const button of [resizeToggle, pinchToggle, velToggle]) {
         button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
      }
      el.classList.toggle('is-pinch-mode', pinchMode);
      applyVelMode();
      if (clipId) renderNotes(); // 十字キーを出し入れする
   }
   // ベロシティの段を出さない間は、段の高さを 0 にする(グリッドの行の高さと、十字キーの位置に使う)
   function applyVelMode() {
      const hidden = coarse.matches && mode !== 'velocity';
      el.classList.toggle('is-vel-hidden', hidden);
      el.style.setProperty('--pr-vel-h', `${hidden ? 0 : VEL_HEIGHT}px`);
   }
   coarse.addEventListener('change', () => applyVelMode());
   // 十字キー(矢印キーと同じ。←→ でグリッド1つ分、↓↑ で半音)。タッチの画面で、ノートを選んでいる間だけ右端に出す。
   // 押し続けるとくり返し動かし、離したときにまとめて保存する
   // content はアイコンの名前か、ボタンに出す文字(オクターブのボタン)
   const padButton = (content, label, area, step, { text = false } = {}) => {
      let timer = null;
      let moved = false;
      const stop = () => {
         if (timer === null) return;
         clearTimeout(timer);
         timer = null;
         dragging = false;
         if (moved) commit();
         moved = false;
      };
      const once = () => {
         if (shift(...step())) moved = true;
      };
      return h('button', {
         type: 'button',
         class: `btn btn-icon pr-dpad-button${text ? ' is-text' : ''}`,
         style: { 'grid-area': area },
         title: label,
         'aria-label': label,
         onpointerdown: (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); // フォーカスを移さない(グリッドのキー操作を続けられるように)
            e.currentTarget.setPointerCapture(e.pointerId);
            dragging = true; // 動かしている間は、読み直したノートで上書きしない
            once();
            const repeat = () => {
               once();
               timer = setTimeout(repeat, REPEAT_MS);
            };
            timer = setTimeout(repeat, REPEAT_DELAY);
         },
         onpointerup: stop,
         onpointercancel: stop,
         // キーボード(Enter / スペース)で押したとき
         onclick: (e) => {
            if (e.detail === 0) nudge(...step());
         },
      }, text ? content : icon(content));
   };
   // 上の段はオクターブ(±12。キーの Shift+↑↓ と同じ)
   const dpad = h('div', { class: 'pr-dpad pr-touch-only', hidden: true },
      padButton('オク上', '選んだノートを1オクターブ上げる', 'octup', () => [0, 12], { text: true }),
      padButton('オク下', '選んだノートを1オクターブ下げる', 'octdown', () => [0, -12], { text: true }),
      padButton('arrow-up', '選んだノートを半音上げる', 'up', () => [0, 1]),
      padButton('arrow-left', '選んだノートをグリッド1つ分左へ', 'left', () => [-snap, 0]),
      padButton('arrow-right', '選んだノートをグリッド1つ分右へ', 'right', () => [snap, 0]),
      padButton('arrow-down', '選んだノートを半音下げる', 'down', () => [0, -1]));
   const onionToggle = h('button', {
      type: 'button',
      class: 'btn btn-icon pr-onion-toggle',
      title: 'オニオンスキン(ほかのトラックのノートを薄く出す)',
      'aria-label': 'オニオンスキン',
      'aria-pressed': 'false',
      onclick: () => {
         onion = !onion;
         renderOnion();
      },
   }, icon('layers'));
   const onionTracks = h('button', {
      type: 'button',
      class: 'btn btn-icon',
      title: 'オニオンスキンに出すトラック',
      'aria-label': 'オニオンスキンに出すトラック',
      onclick: () => openOnionMenu(),
   }, icon('list-checks'));
   // このクリップだけをループで鳴らす(再生を始める位置の印がクリップの中ならそこから、外なら頭から。ループは頭に戻る)。
   // ループ中は停止のボタンになる(updatePlayState で切り替える)
   const playButton = h('button', {
      type: 'button',
      class: 'btn btn-icon',
      onclick: () => { const c = clip(); if (c) onPlayClip?.(c); },
   });
   // 全体を再生する(アレンジのツールバーの再生ボタンと同じ。スマホの横持ちでは、ツールバーが隠れるため)
   const playAllButton = h('button', {
      type: 'button',
      class: 'btn btn-icon',
      onclick: () => onPlayAll?.(),
   });
   function updatePlayState() {
      const looping = Boolean(clipId && isLooping(clipId));
      playButton.title = looping ? 'ループ再生を止める'
         : 'このクリップだけをループ再生(赤い印がクリップの中ならそこから。ミュート・ソロに関わらず、このトラックだけを鳴らす)';
      playButton.setAttribute('aria-label', looping ? 'ループ再生を止める' : 'このクリップだけをループ再生');
      playButton.classList.toggle('is-playing', looping);
      playButton.replaceChildren(icon(looping ? 'square' : 'repeat'));
      const all = isPlayingAll();
      playAllButton.title = all ? '停止' : '全体を再生(赤い印から)';
      playAllButton.setAttribute('aria-label', all ? '停止' : '全体を再生');
      playAllButton.classList.toggle('is-playing', all);
      playAllButton.replaceChildren(icon(all ? 'square' : 'play'));
   }
   updatePlayState();
   // ベロシティの段。横はグリッドと一緒にスクロールし、縦は下端に貼り付ける(CSS の sticky)
   const velLabel = h('span', { class: 'pr-vel-label' }, 'ベロシティ');
   const velBars = h('div', { class: 'pr-vel-bars' });
   const vel = h('div', {
      class: 'pr-vel',
      title: '上下になぞって、ノートのベロシティを変える(選んでいるノートがあれば、それだけ)。Alt を押しながらで 100 に戻し、Shift を押して始めると直線で描く',
      onpointerdown: (e) => onVelDown(e),
      oncontextmenu: (e) => e.preventDefault(),
   }, velBars);
   const inner = h('div', { class: 'pr-inner' },
      h('div', { class: 'pr-corner' }), ruler, keys, grid, h('div', { class: 'pr-vel-corner' }, velLabel), vel);
   const scroller = h('div', { class: 'pr-scroll', tabIndex: -1, onkeydown: (e) => onKeydown(e) }, inner);
   // 横のスクロールバー(タッチの画面だけ)。グリッドの上の指ではスクロールしないので、指で掴める太さで出す
   const hbarThumb = h('div', { class: 'pr-hbar-thumb' });
   const hbar = h('div', {
      class: 'pr-hbar pr-touch-only',
      'aria-hidden': 'true',
      onpointerdown: (e) => onHbarDown(e),
   }, hbarThumb);

   // ベロシティの段の高さ(--pr-vel-h)は、十字キーの位置にも使う。applyVelMode で決める
   const el = h('section', { class: 'pr', 'aria-label': 'ピアノロール', hidden: true },
      resizeHandle(),
      h('header', { class: 'pr-head' },
         icon('piano', 16),
         title,
         range,
         h('label', { class: 'pr-snap-label muted' }, 'グリッド', snapSelect),
         scaleText,
         // 働きの近いボタンは、ボタングループにまとめる
         h('span', { class: 'btn-group', role: 'group', 'aria-label': 'オニオンスキンの操作' }, onionToggle, onionTracks),
         h('span', { class: 'btn-group pr-touch-only', role: 'group', 'aria-label': 'タッチのモード' },
            resizeToggle, pinchToggle, velToggle),
         h('span', { class: 'pr-spacer' }),
         h('span', { class: 'btn-group', role: 'group', 'aria-label': '再生' }, playAllButton, playButton),
         h('button', {
            type: 'button', class: 'btn btn-icon', title: '.mid の読み込み・書き出し', 'aria-label': '.mid の読み込み・書き出し',
            onclick: (e) => openMenu(e.currentTarget, [
               { label: '.mid を読み込む', onSelect: () => { if (clipId) importMidiToClip(projectId, clipId); } },
               { label: '.mid を書き出す', onSelect: () => downloadMidi(currentMidi()) },
            ]),
         }, icon('ellipsis-vertical')),
         h('button', {
            type: 'button', class: 'btn btn-icon', title: 'クリップ詳細', 'aria-label': 'クリップ詳細',
            onclick: () => { if (clipId) onOpenDetail?.(clipId); },
         }, icon('notebook-text')),
         h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'ピアノロールを閉じる', onclick: () => close() }, icon('x'))),
      // グリッド(とその下のスクロールバー)の右に、編集のボタンの列を置く
      h('div', { class: 'pr-body' }, h('div', { class: 'pr-main' }, scroller, hbar), side),
      dpad);

   // 鍵盤は、上が高い音(127)。128音ぶんを一度だけ作る。グリッドの行は、転調の区間ごとに renderScale で作る。
   // マウスは押したときに鳴らす。タッチは鍵盤の上でスクロールとピンチもするので、動かさずに離したときに鳴らす(鍵盤の指)
   for (let pitch = 127; pitch >= 0; pitch--) {
      const black = isBlackKey(pitch);
      const isC = pitch % 12 === 0;
      keys.append(h('div', {
         class: `pr-key${black ? ' is-black' : ''}${isC ? ' is-c' : ''}`,
         title: pitchName(pitch),
         dataset: { pitch: String(pitch) },
         onpointerdown: (e) => {
            if (e.pointerType === 'touch') return;
            e.preventDefault();
            preview(pitch);
         },
      }, isC ? pitchName(pitch) : ''));
   }

   // ---- 高さ ----

   function setHeight(value) {
      if (value) el.style.setProperty('--pr-h', `${value}px`);
      else el.style.removeProperty('--pr-h');
   }

   // 覚えた高さにする(スマホの横持ちでは、CSS で画面全体に出すので効かない)
   function applyHeight() {
      setHeight(savedHeight);
   }
   applyHeight();
   applyVelMode();

   function saveHeight(value) {
      savedHeight = value;
      try {
         if (value) localStorage.setItem(HEIGHT_KEY, String(value));
         else localStorage.removeItem(HEIGHT_KEY);
      } catch {
         // 保存できなくても、開いている間は効く
      }
   }

   // 上端のつまみ。ドラッグ(または上下の矢印キー)で高さを変え、ダブルクリックで既定に戻す(gantt.js のつまみと同じ操作)
   function resizeHandle() {
      const clamp = (height) => {
         const max = el.getBoundingClientRect().bottom - topLimit();
         return Math.round(Math.max(MIN_HEIGHT, Math.min(height, max)));
      };
      const handle = h('div', {
         class: 'pr-resize',
         role: 'separator',
         'aria-orientation': 'horizontal',
         'aria-label': 'ピアノロールの高さ',
         title: 'ドラッグで高さを変える(ダブルクリックで元に戻す)',
         tabIndex: 0,
         onpointerdown: (down) => {
            if (down.button !== 0) return;
            down.preventDefault(); // ドラッグ中に文字が選択されないようにする
            const startHeight = el.offsetHeight;
            let height = startHeight;
            trackPointer(handle, down, {
               onMove: (e) => {
                  height = clamp(startHeight + down.clientY - e.clientY);
                  setHeight(height);
               },
               onEnd: () => {
                  if (height !== startHeight) saveHeight(height);
               },
            });
         },
         ondblclick: () => {
            saveHeight(null);
            applyHeight();
         },
         onkeydown: (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const height = clamp(el.offsetHeight + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP));
            setHeight(height);
            saveHeight(height);
         },
      });
      return handle;
   }

   const clip = () => data?.clips.find((c) => c.id === clipId) ?? null;
   const track = () => data?.tracks.find((t) => t.id === clip()?.trackId) ?? null;

   function currentMidi() {
      return clipMidi(data.project, track(), { ...clip(), notes });
   }

   function preview(pitch, velocity = DEFAULT_VELOCITY) {
      const t = track();
      if (!t) return;
      const channel = trackChannels(sortByOrder(data.tracks)).get(t.id);
      previewNote(playbackMessages(t, channel), channel, pitch, velocity);
   }

   // ---- 描画 ----

   function renderHead() {
      const c = clip();
      const t = track();
      title.textContent = `${t?.name ?? ''}: ${c.name || UNTITLED_CLIP}`;
      range.textContent = barRange(c);
      inner.style.setProperty('--pr-width', `${(clipTicks(c) + MARGIN) * px}px`);
      inner.style.setProperty('--pr-bar', `${TICKS_PER_BAR * px}px`);
      inner.style.setProperty('--pr-beat', `${beat}px`);
      inner.style.setProperty('--pr-row', `${row}px`);
      renderScale();
      updateHbar();
      // 余白の小節も目盛りを出す(クリップの外なので薄く)
      ruler.replaceChildren(...Array.from({ length: (c.bars + MARGIN / TICKS_PER_BAR) * BEATS_PER_BAR }, (_, i) => h('span', {
         class: `pr-beat${i % BEATS_PER_BAR === 0 ? ' is-bar' : ''}${i >= c.bars * BEATS_PER_BAR ? ' is-margin' : ''}`,
      }, i % BEATS_PER_BAR === 0 ? String(c.startBar + i / BEATS_PER_BAR) : '')), cursor);
      renderCursor();
   }

   // 再生を始める位置の印。クリップの範囲(頭〜終わり)にあるときだけ出す
   function renderCursor() {
      const c = clip();
      const rel = c ? startTick - (c.startBar - 1) * TICKS_PER_BAR : -1;
      cursor.hidden = !c || rel < 0 || rel > clipTicks(c);
      if (!cursor.hidden) cursor.style.left = `${rel * px}px`;
   }

   // スケールの外の音の行を暗く、主音の行を少し色付きにする(鍵盤は実際の白黒のまま)。
   // 転調があれば、区間ごとに128行の列を作って横に並べる。右端の外の余白にも、最後の区間の列を足す(クリップの外として灰色で出す)。
   // 変わらなければ作り直さない
   let scaleSignature = '';
   function renderScale() {
      const c = clip();
      const spans = scaleSpans(projectScales(data.project), c.startBar, c.bars);
      scaleText.textContent = spans.map((span) => scaleLabel(span.scale)).join(' → ');
      const signature = JSON.stringify(spans);
      if (signature === scaleSignature) return;
      scaleSignature = signature;
      const margin = { from: c.bars, to: c.bars + MARGIN / TICKS_PER_BAR, scale: spans.at(-1).scale, isMargin: true };
      rows.replaceChildren(...[...spans, margin].map(({ from, to, scale, isMargin }) => {
         const column = h('div', {
            class: `pr-scale${isMargin ? ' is-margin' : from > 0 ? ' is-change' : ''}`,
            style: { width: `${(to - from) * TICKS_PER_BAR * px}px` },
         });
         for (let pitch = 127; pitch >= 0; pitch--) {
            const out = !inScale(pitch, scale);
            const isRoot = pitch % 12 === scale.root;
            column.append(h('div', { class: `pr-row${out ? ' is-out' : ''}${isRoot ? ' is-root' : ''}${pitch % 12 === 0 ? ' is-c' : ''}` }));
         }
         return column;
      }));
   }

   // ノートの高さを変える。anchorY(画面上の y 座標。指の間やポインタの位置)にある音は、同じ位置に残す
   function setRow(value, anchorY) {
      const next = Math.max(MIN_ROW, Math.min(MAX_ROW, Math.round(value)));
      if (next === row) return;
      const offset = anchorY - scroller.getBoundingClientRect().top;
      const at = (scroller.scrollTop + offset - RULER_H) / row; // anchorY にある行(小数)
      row = next;
      try {
         localStorage.setItem(ROW_KEY, String(row));
      } catch {
         // 覚えられなくても、この画面の間は効く
      }
      inner.style.setProperty('--pr-row', `${row}px`);
      renderNotes();
      renderOnion();
      scroller.scrollTop = at * row + RULER_H - offset;
   }

   // 1拍の幅を変える。anchorX(画面上の x 座標。指の間やポインタの位置)にある時間は、同じ位置に残す
   function setBeat(value, anchorX) {
      const next = Math.max(MIN_BEAT, Math.min(MAX_BEAT, Math.round(value)));
      if (next === beat || !clipId) return;
      const offset = anchorX - grid.getBoundingClientRect().left;
      const at = offset / px; // anchorX にある tick
      beat = next;
      px = beat / PPQ;
      try {
         localStorage.setItem(BEAT_KEY, String(beat));
      } catch {
         // 覚えられなくても、この画面の間は効く
      }
      scaleSignature = ''; // 転調の区間の幅も変わるので作り直す
      renderHead();
      renderGridLines();
      renderNotes();
      renderOnion();
      scroller.scrollLeft += at * px - offset;
      updateHbar();
   }

   // マウスでは、Ctrl を押しながらホイールを回すと1拍の幅を、Ctrl+Shift だとノートの高さを変える。
   // ピアノロールの上では、ブラウザのページの拡大(Ctrl+ホイール)を止めて使う(タッチパッドのピンチも Ctrl+ホイールとして届く)。
   // Shift を押すと横の回転になるブラウザもあるので deltaX も見る。
   // タッチパッドのピンチは小さい量が続けて届くので、WHEEL_STEP までためてから1段ずつ変える(マウスは1目盛りで1段)
   let wheelSum = 0;
   scroller.addEventListener('wheel', (e) => {
      const delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : 1); // 行単位(Firefox)なら px に直す
      if (!(e.ctrlKey || e.metaKey) || !delta) return;
      e.preventDefault();
      wheelSum += delta;
      if (Math.abs(wheelSum) < WHEEL_STEP) return;
      const zoomIn = wheelSum < 0;
      wheelSum = 0;
      if (e.shiftKey) setRow(row + (zoomIn ? WHEEL_ROW_STEP : -WHEEL_ROW_STEP), e.clientY);
      else setBeat(zoomIn ? beat * WHEEL_BEAT_RATIO : beat / WHEEL_BEAT_RATIO, e.clientX);
   }, { passive: false });

   // ---- タッチのスクロールとピンチ ----

   // タッチで、鍵盤か横のスクロールバーの上の1本の指でしている操作(スクロール)。指での操作は1本ずつにする。
   // cancel は、同じところに2本目の指を置いてピンチに切り替えるときに、その操作を取り消す関数
   let touchOp = null;

   function beginTouch(cancel) {
      touchOp = { cancel };
      return touchOp;
   }

   function endTouch(op) {
      if (op && touchOp === op) touchOp = null;
   }

   // 鍵盤の上の指で、縦にスクロールする。離したらその場で止める(慣性で滑らせると、狙った音の位置で止めにくいため)。
   // 動かさずに離したら、その鍵盤を鳴らす。鍵盤は touch-action: none なので、ブラウザのスクロールとは取り合わない
   let keyGesture = null; // { id, y, top, tap: 離したら鳴らす音(動かしたら null), op }

   keys.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || touchOp) return;
      keys.setPointerCapture(e.pointerId);
      const pitch = e.target.closest?.('.pr-key')?.dataset.pitch;
      keyGesture = {
         id: e.pointerId,
         y: e.clientY,
         top: scroller.scrollTop,
         tap: pitch == null ? null : Number(pitch),
         op: beginTouch(() => { keyGesture = null; }),
      };
   });
   keys.addEventListener('pointermove', (e) => {
      if (keyGesture?.id !== e.pointerId) return;
      if (keyGesture.tap != null && Math.abs(e.clientY - keyGesture.y) < TOUCH_SLOP) return;
      keyGesture.tap = null;
      scroller.scrollTop = keyGesture.top - (e.clientY - keyGesture.y);
   });
   const endKeyTouch = (e) => {
      if (keyGesture?.id !== e.pointerId) return;
      const gesture = keyGesture;
      keyGesture = null;
      endTouch(gesture.op);
      if (gesture.tap != null && e.type === 'pointerup') preview(gesture.tap);
   };
   keys.addEventListener('pointerup', endKeyTouch);
   keys.addEventListener('pointercancel', endKeyTouch);

   // ピンチ。鍵盤の上ならノートの高さ、横のスクロールバーの上なら1拍の幅を変える(2本とも同じところに置いたときだけ)。
   // グリッドなどでは、指はノートの操作に使うので、ピンチにはしない(始めかけた操作を取り消すのが難しいため)。
   // 指の動きは el で先に受け取り(キャプチャ)、下の要素には渡さない。1本離したら、残った指は離すまで何もしない
   const touches = new Map(); // pointerId → { x, y, axis }。鍵盤('y')かスクロールバー('x')に置いている指
   let pinch = null; // { ids, axis: 'x' | 'y', distance, value, done }
   const pinchAxis = (target) => (keys.contains(target) ? 'y' : hbar.contains(target) ? 'x' : null);
   const spread = (a, b, axis) => Math.max(20, Math.abs(axis === 'x' ? a.x - b.x : a.y - b.y));

   // ピンチモード。鍵盤・グリッド・ルーラー・ベロシティの段・スクロールバーのどこでも、2本の指でピンチし、1本の指でスクロールする。
   // ピンチの向きは、2本目を置いたときの指の並び(横に離れていれば1拍の幅、縦ならノートの高さ)で決める。
   // ここで先に受け取り、下の要素(ノートの操作や、鍵盤・スクロールバーのピンチ)には渡さない。
   // 1本離したら、残った指は離すまで何もしない(ふつうのピンチと同じ)
   const zoomTouches = new Map(); // pointerId → { x, y }
   let zoomPan = null; // 1本の指のスクロール { id, x, y, left, top }
   let zoomPinch = null; // { ids, axis, distance, value, done }

   el.addEventListener('pointerdown', (e) => {
      if (!pinchMode || e.pointerType !== 'touch' || !(scroller.contains(e.target) || hbar.contains(e.target))) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      zoomTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      if (zoomPinch) return;
      if (zoomTouches.size === 1) {
         zoomPan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
         return;
      }
      if (zoomTouches.size !== 2 || !clipId) return;
      zoomPan = null;
      const ids = [...zoomTouches.keys()];
      const [a, b] = ids.map((id) => zoomTouches.get(id));
      const axis = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? 'x' : 'y';
      zoomPinch = { ids, axis, distance: spread(a, b, axis), value: axis === 'x' ? beat : row, done: false };
   }, true);
   el.addEventListener('pointermove', (e) => {
      if (!zoomTouches.has(e.pointerId)) return;
      e.stopImmediatePropagation();
      zoomTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (zoomPinch) {
         if (zoomPinch.done || !zoomPinch.ids.includes(e.pointerId)) return;
         const [a, b] = zoomPinch.ids.map((id) => zoomTouches.get(id));
         const scale = spread(a, b, zoomPinch.axis) / zoomPinch.distance;
         if (zoomPinch.axis === 'x') setBeat(zoomPinch.value * scale, (a.x + b.x) / 2);
         else setRow(zoomPinch.value * scale, (a.y + b.y) / 2);
      } else if (zoomPan?.id === e.pointerId) {
         scroller.scrollLeft = zoomPan.left - (e.clientX - zoomPan.x);
         scroller.scrollTop = zoomPan.top - (e.clientY - zoomPan.y);
      }
   }, true);
   const endZoomTouch = (e) => {
      if (!zoomTouches.delete(e.pointerId)) return;
      e.stopImmediatePropagation();
      if (zoomPan?.id === e.pointerId) zoomPan = null;
      if (zoomPinch?.ids.includes(e.pointerId)) zoomPinch.done = true;
      if (!zoomTouches.size) zoomPinch = null;
   };
   el.addEventListener('pointerup', endZoomTouch, true);
   el.addEventListener('pointercancel', endZoomTouch, true);

   el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      if (pinch) {
         e.stopPropagation(); // ピンチの間(と、その指が残っている間)に置いた指は使わない
         return;
      }
      const axis = pinchAxis(e.target);
      if (!axis) return;
      const others = [...touches].filter(([, t]) => t.axis === axis).map(([id]) => id);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, axis });
      if (others.length !== 1 || !clipId) return;
      touchOp?.cancel();
      touchOp = null;
      e.stopPropagation();
      const ids = [others[0], e.pointerId];
      const [a, b] = ids.map((id) => touches.get(id));
      pinch = { ids, axis, distance: spread(a, b, axis), value: axis === 'x' ? beat : row, done: false };
      for (const id of ids) el.setPointerCapture(id);
   }, true);
   el.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { ...touches.get(e.pointerId), x: e.clientX, y: e.clientY });
      if (!pinch?.ids.includes(e.pointerId)) return;
      e.stopPropagation();
      if (pinch.done) return;
      const [a, b] = pinch.ids.map((id) => touches.get(id));
      const scale = spread(a, b, pinch.axis) / pinch.distance;
      if (pinch.axis === 'x') setBeat(pinch.value * scale, (a.x + b.x) / 2);
      else setRow(pinch.value * scale, (a.y + b.y) / 2);
   }, true);
   const endPinchTouch = (e) => {
      if (!touches.delete(e.pointerId) || !pinch?.ids.includes(e.pointerId)) return;
      e.stopPropagation();
      pinch.done = true;
      if (!pinch.ids.some((id) => touches.has(id))) pinch = null;
   };
   el.addEventListener('pointerup', endPinchTouch, true);
   el.addEventListener('pointercancel', endPinchTouch, true);

   // 横のスクロールバーのつまみの大きさと位置を、スクロールの位置に合わせる
   function updateHbar() {
      const track = hbar.clientWidth;
      if (!track) return; // 出していない(PC)か、閉じている
      const view = scroller.clientWidth;
      const content = scroller.scrollWidth;
      const max = content - view;
      const width = max > 0 ? Math.max(48, (track * view) / content) : track;
      hbarThumb.style.width = `${width}px`;
      hbarThumb.style.transform = `translateX(${max > 0 ? ((track - width) * scroller.scrollLeft) / max : 0}px)`;
   }
   scroller.addEventListener('scroll', updateHbar, { passive: true });
   new ResizeObserver(updateHbar).observe(scroller);

   // スクロールバーを押す。つまみの外なら、押した位置につまみの真ん中を持ってくる。そのままなぞって動かす
   // 2本目の指を置いたら、飛ぶ前の位置に戻してピンチにする
   function onHbarDown(down) {
      if (down.button !== 0 || touchOp) return;
      down.preventDefault();
      const rect = hbar.getBoundingClientRect();
      const thumb = hbarThumb.getBoundingClientRect();
      const range = rect.width - thumb.width; // つまみが動ける幅
      const max = scroller.scrollWidth - scroller.clientWidth;
      if (range <= 0 || max <= 0) return;
      const before = scroller.scrollLeft;
      if (down.clientX < thumb.left || down.clientX > thumb.right) {
         scroller.scrollLeft = ((down.clientX - rect.left - thumb.width / 2) / range) * max;
      }
      const from = scroller.scrollLeft;
      hbar.classList.add('is-dragging');
      const op = beginTouch(() => {
         stop();
         hbar.classList.remove('is-dragging');
         scroller.scrollLeft = before;
      });
      const stop = trackPointer(hbar, down, {
         onMove: (e) => {
            scroller.scrollLeft = from + ((e.clientX - down.clientX) / range) * max;
         },
         onEnd: () => {
            endTouch(op);
            hbar.classList.remove('is-dragging');
         },
      });
   }

   // いちばん細い縦線は、グリッドの細かさに合わせる(「なし」なら 1/16)
   function renderGridLines() {
      inner.style.setProperty('--pr-snap', `${(snap > 1 ? snap : PPQ / 4) * px}px`);
   }
   renderGridLines();

   const velocityOf = (n) => n.velocity ?? DEFAULT_VELOCITY;

   function renderNotes() {
      const end = clipTicks(clip());
      const onsets = new Map();
      for (const n of notes) onsets.set(onsetKey(n), (onsets.get(onsetKey(n)) ?? 0) + 1);
      const dup = (n) => onsets.get(onsetKey(n)) > 1;
      const outside = (n) => n.start < 0 || n.start >= end;
      layer.replaceChildren(...notes.map((n, i) => h('div', {
         class: `pr-note${selected.has(n) ? ' is-selected' : ''}${outside(n) ? ' is-outside' : ''}${dup(n) ? ' is-dup' : ''}`,
         style: {
            left: `${n.start * px}px`,
            top: `${(127 - n.pitch) * row}px`,
            width: `${Math.max(3, n.length * px)}px`,
            '--vel': String(velocityOf(n) / 127),
         },
         dataset: { index: String(i) },
         title: `${pitchName(n.pitch)} ベロシティ ${velocityOf(n)}${dup(n) ? '(同じ位置に重なっているノートがあります)' : ''}`,
      })));
      renderEditButtons();
      dpad.hidden = !selected.size || pinchMode;
      // 選んでいるノートの棒は、ほかの棒に隠れないよう後ろ(上)に描く
      const order = [...notes.filter((n) => !selected.has(n)), ...notes.filter((n) => selected.has(n))];
      velBars.replaceChildren(...order.map((n) => h('div', {
         class: `pr-vel-bar${selected.has(n) ? ' is-selected' : ''}${outside(n) ? ' is-outside' : ''}`,
         style: { left: `${n.start * px}px`, height: `${(velocityOf(n) / 127) * (VEL_HEIGHT - VEL_PAD)}px` },
      })));
   }

   // ---- オニオンスキン ----

   // 編集中のトラック以外のトラック(並び順)
   const otherTracks = () => sortByOrder(data?.tracks ?? []).filter((t) => t.id !== clip()?.trackId);

   // 表示している範囲(クリップの範囲)にノートのあるトラックだけを候補に出す
   function openOnionMenu() {
      const c = clip();
      const tracks = c ? otherTracks().filter((t) => onionNotes(c, new Set([t.id])).length) : [];
      openMenu(onionTracks, tracks.length
         ? tracks.map((t) => ({
            label: t.name,
            checked: !onionOff.has(t.id),
            onSelect: () => {
               if (onionOff.has(t.id)) onionOff.delete(t.id);
               else onionOff.add(t.id);
               renderOnion();
               return !onionOff.has(t.id);
            },
         }))
         : [{ label: 'この範囲にノートのあるトラックがありません', onSelect: () => {} }]);
   }

   // trackIds のトラックのクリップのうち、編集中のクリップ c と時間が重なる部分の、鳴るノート。
   // 位置は編集中のクリップの先頭からの相対に直す
   function onionNotes(c, trackIds) {
      const end = clipTicks(c);
      return data.clips.filter((other) => trackIds.has(other.trackId)).flatMap((other) => {
         const offset = (other.startBar - c.startBar) * TICKS_PER_BAR;
         return audibleNotes(other)
            .map((n) => ({ ...n, start: n.start + offset }))
            .filter((n) => n.start < end && n.start + n.length > 0);
      });
   }

   // オニオンスキンを出す
   function renderOnion() {
      onionToggle.setAttribute('aria-pressed', String(onion));
      const c = clip();
      if (!onion || !c) {
         onionLayer.replaceChildren();
         return;
      }
      const end = clipTicks(c);
      const ghosts = onionNotes(c, new Set(otherTracks().filter((t) => !onionOff.has(t.id)).map((t) => t.id)));
      onionLayer.replaceChildren(...ghosts.map((n) => h('div', {
         class: 'pr-onion-note',
         style: {
            left: `${Math.max(0, n.start) * px}px`,
            top: `${(127 - n.pitch) * row}px`,
            width: `${Math.max(3, (Math.min(end, n.start + n.length) - Math.max(0, n.start)) * px)}px`,
         },
      })));
   }

   // ---- 編集 ----

   const snapFloor = (tick, free) => (free ? Math.round(tick) : Math.floor(tick / snap) * snap);
   const snapRound = (tick, free) => (free ? Math.round(tick) : Math.round(tick / snap) * snap);

   // まとめて横に動かせる幅(tick)。どのノートもクリップの範囲(0〜クリップの長さ)からはみ出さないようにする。
   // もともとはみ出しているノート(クリップを縮めたときのもの)があれば、それ以上外へは動かさない
   function shiftRange(list) {
      const end = clipTicks(clip());
      return {
         min: Math.min(0, -Math.min(...list.map((n) => n.start))),
         max: Math.max(0, end - Math.max(...list.map((n) => n.start + n.length))),
      };
   }

   function pointAt(e) {
      const rect = grid.getBoundingClientRect();
      return {
         tick: (e.clientX - rect.left) / px,
         pitch: Math.max(0, Math.min(127, 127 - Math.floor((e.clientY - rect.top) / row))),
         x: e.clientX - rect.left,
         y: e.clientY - rect.top,
      };
   }

   // 右端の外の余白(ノートを置かない)を押したか
   const inMargin = (e) => pointAt(e).tick >= clipTicks(clip());

   const noteAtTarget = (target) => {
      const noteEl = target?.closest?.('.pr-note');
      return noteEl ? notes[Number(noteEl.dataset.index)] : null;
   };

   // 1音ずつ動かすたびに保存すると通信が多すぎるので、手を止めて SAVE_DELAY ミリ秒たってからまとめて保存する。
   // 待っている間も、クリップの表示と再生には onNotesChange ですぐ効かせる
   function save() {
      if (!clipId) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DELAY);
      onNotesChange?.();
   }

   // 待っている保存をすぐ行う。クリップを切り替える・閉じる・ピアノロールの外を触る・画面が隠れるときに呼ぶ
   // (ほかの操作が保存済みのノートを読む前に揃えるため。clipId と notes は、まだ保存するクリップのもの)
   function flush() {
      if (saveTimer == null) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      const id = clipId;
      pending++;
      actions.setClipNotes(projectId, id, notes.map((n) => ({ ...n })))
         .catch((error) => {
            reportError(error);
            history.delete(id); // 保存できなかった内容の写しが積まれているので捨てる
            pending = 0;
            if (id !== clipId) return;
            renderHistory();
            sync({ force: true }); // 保存できなかったので、保存済みのノートに戻す
         })
         .finally(() => {
            pending = Math.max(0, pending - 1);
         });
   }

   const flushOutside = (e) => {
      if (!el.contains(e.target)) flush();
   };
   const flushHidden = () => {
      if (document.visibilityState === 'hidden') flush();
   };

   // 押した位置に置くノート(長さとベロシティは、最後に触ったノートのもの)。
   // クリップの右端からはみ出さない長さにする。free ならグリッドに合わせない
   function newNoteAt(at, free) {
      const end = clipTicks(clip());
      const start = Math.max(0, Math.min(end - 1, snapFloor(at.tick, free)));
      return { pitch: at.pitch, start, length: Math.max(1, Math.min(lastLength, end - start)), velocity: lastVelocity };
   }

   // ドラッグの間だけ dragging を立てて、ポインタを追う
   function follow(down, { onMove, onEnd }) {
      dragging = true;
      trackPointer(grid, down, {
         onMove,
         onEnd: (e) => {
            dragging = false;
            onEnd(e);
         },
      });
   }

   function onGridDown(down) {
      if (!clipId) return;
      scroller.focus({ preventScroll: true });
      if (down.pointerType === 'touch') {
         // 指でのドラッグは1本ずつ(2本目の指は無視する)
         if (!dragging) onTouchDown(down);
         return;
      }
      if (down.button === 2) {
         erase(down);
         return;
      }
      if (down.button !== 0) return;
      down.preventDefault();
      if (down.ctrlKey || down.metaKey) {
         follow(down, marquee(down, { add: down.shiftKey }));
         return;
      }
      const at = pointAt(down);
      let target = noteAtTarget(down.target);
      let created = false;
      if (target) {
         if (down.shiftKey) {
            if (selected.has(target)) selected.delete(target);
            else selected.add(target);
         } else if (!selected.has(target)) {
            selected = new Set([target]);
         }
         lastLength = target.length;
         lastVelocity = velocityOf(target);
      } else if (inMargin(down)) {
         // 余白にはノートを置かない。空いているところと同じく、選択だけ外す
         selected = new Set();
         renderNotes();
         return;
      } else {
         target = newNoteAt(at, down.altKey);
         notes.push(target);
         selected = new Set([target]);
         created = true;
      }
      if (!selected.has(target)) {
         // Shift で選択を外したノートは動かさない
         renderNotes();
         return;
      }
      follow(down, dragNotes(down, target, { created }));
   }

   // 選んでいるノートを、target を掴んだものとしてまとめて動かす。mode('move' / 'resize')を渡さなければ、
   // 右端(EDGE)を掴んでいれば長さを変える(タッチでは伸縮モードかどうかで決めて渡す)。
   // created は、押したときに置いたノート(動かさなくても保存する)
   function dragNotes(down, target, { created = false, mode: given } = {}) {
      const at = pointAt(down);
      const mode = given ?? (!created && (target.start + target.length) * px - at.x <= EDGE ? 'resize' : 'move');
      preview(target.pitch, velocityOf(target));
      renderNotes();

      const moving = [...selected].map((n) => ({ note: n, start: n.start, pitch: n.pitch, length: n.length }));
      const origin = moving.find((m) => m.note === target);
      const range = shiftRange(moving);
      // 長さを変えるときも、右端がクリップの右端を越えないようにする(もともと越えているノートがあれば伸ばさない)
      const maxGrow = Math.max(0, Math.min(...moving.map((m) => clipTicks(clip()) - m.start - m.length)));
      let moved = false;
      let lastPitch = target.pitch;

      const move = (e) => {
         if (!moved && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
         moved = true;
         const p = pointAt(e);
         const deltaTick = p.tick - at.tick;
         if (mode === 'resize') {
            const end = snapRound(origin.start + origin.length + deltaTick, e.altKey);
            const delta = Math.min(maxGrow, Math.max(Math.min(snap, origin.length), end - origin.start) - origin.length);
            for (const m of moving) m.note.length = Math.max(1, m.length + delta);
            lastLength = target.length;
         } else {
            const shift = Math.max(range.min, Math.min(range.max, snapRound(origin.start + deltaTick, e.altKey) - origin.start));
            const lowest = Math.min(...moving.map((m) => m.pitch));
            const highest = Math.max(...moving.map((m) => m.pitch));
            const pitchDelta = Math.max(-lowest, Math.min(127 - highest, p.pitch - at.pitch));
            for (const m of moving) {
               m.note.start = m.start + shift;
               m.note.pitch = m.pitch + pitchDelta;
            }
            if (target.pitch !== lastPitch) {
               lastPitch = target.pitch;
               preview(target.pitch, velocityOf(target));
            }
         }
         renderNotes();
      };
      return {
         onMove: move,
         onEnd: () => {
            const changed = created || moving.some((m) => m.note.start !== m.start || m.note.pitch !== m.pitch || m.note.length !== m.length);
            if (changed) commit();
         },
      };
   }

   // タッチ。グリッドは touch-action: none なので、指の動きはスクロールにならず、すべてノートの操作になる。
   // 指が TOUCH_SLOP 動くか、離すか、空いているところを HOLD_MS 押さえるまで待ってから、何をするかを決める:
   // 動かしたらドラッグ(startTouchDrag)、空いているところの長押しは囲んで選ぶ、動かさずに離したらタップ(tap)。
   // 伸縮モードでは囲んで選ばない(長さを変えるつもりで少し外したときに、選択だけが変わらないように)。
   // 代わりに、ノートの少し外側を押しても、そのノートを掴む(noteNear)
   function onTouchDown(down) {
      const target = noteAtTarget(down.target) ?? (resizeMode ? noteNear(down) : null);
      let handlers = null; // 何をするかが決まってからの動き
      let timer = null;
      const begin = (make) => {
         clearTimeout(timer);
         handlers = make();
      };
      if (!target && !resizeMode) timer = setTimeout(() => begin(() => marquee(down, { add: true })), HOLD_MS);
      follow(down, {
         onMove: (e) => {
            if (!handlers) {
               if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < TOUCH_SLOP) return;
               begin(() => startTouchDrag(down, target));
            }
            handlers.onMove(e);
         },
         onEnd: (e) => {
            clearTimeout(timer);
            if (handlers) handlers.onEnd(e);
            else if (e.type === 'pointerup') tap(down, target);
         },
      });
   }

   // タッチのドラッグを始める。ノートなら掴んで(選んでいなければ、それだけを選んで)動かし、伸縮モードなら長さを変える。
   // 空いているところなら、ノートを置いて動かす(伸縮モードと、右端の外の余白では何もしない)
   function startTouchDrag(down, target) {
      if (target) {
         if (!selected.has(target)) selected = new Set([target]);
         lastLength = target.length;
         lastVelocity = velocityOf(target);
         return dragNotes(down, target, { mode: resizeMode ? 'resize' : 'move' });
      }
      if (resizeMode || inMargin(down)) return { onMove() {}, onEnd() {} };
      const note = newNoteAt(pointAt(down), false);
      notes.push(note);
      selected = new Set([note]);
      const handlers = dragNotes(down, note, { created: true, mode: 'move' });
      return {
         onMove: handlers.onMove,
         onEnd: (e) => {
            handlers.onEnd(e);
            // 続けて置けるよう、置いたノートは選ばない(タップで置いたときと同じ)
            selected = new Set();
            renderNotes();
         },
      };
   }

   // 押した位置と同じ高さで、左右 RESIZE_REACH 以内にあるノートのうち、いちばん近いもの。
   // 押した位置は空いているところなので、隣のノートとの間が狭ければ、近いほうを掴む
   function noteNear(down) {
      const at = pointAt(down);
      let best = null;
      let bestDistance = RESIZE_REACH;
      for (const n of notes) {
         if (n.pitch !== at.pitch) continue;
         const left = n.start * px;
         const right = left + Math.max(3, n.length * px);
         const distance = Math.max(left - at.x, at.x - right, 0);
         if (distance <= bestDistance) {
            best = n;
            bestDistance = distance;
         }
      }
      return best;
   }

   // タッチのタップ。ノートなら選択に足す / 外す(Shift+クリックと同じ)。空いているところなら、
   // 選んでいるノートがあれば選択を外し、なければノートを置く(続けて置けるよう、置いたノートは選ばない。伸縮モードと余白では置かない)
   function tap(down, target) {
      if (target) {
         if (selected.has(target)) {
            selected.delete(target);
         } else {
            selected.add(target);
            lastLength = target.length;
            lastVelocity = velocityOf(target);
            preview(target.pitch, velocityOf(target));
         }
         renderNotes();
      } else if (selected.size) {
         selected = new Set();
         renderNotes();
      } else if (!resizeMode && !inMargin(down)) {
         const note = newNoteAt(pointAt(down), false);
         notes.push(note);
         preview(note.pitch, velocityOf(note));
         commit();
      }
   }

   // 右クリックで消す。押したままなぞると、触れたノートを続けて消す
   function erase(down) {
      down.preventDefault();
      let changed = false;
      const hit = (target) => {
         const n = noteAtTarget(target);
         if (!n) return;
         notes = notes.filter((x) => x !== n);
         selected.delete(n);
         changed = true;
         renderNotes();
      };
      hit(down.target);
      dragging = true;
      trackPointer(grid, down, {
         onMove: (e) => hit(document.elementFromPoint(e.clientX, e.clientY)),
         onEnd: () => {
            dragging = false;
            if (changed) commit();
         },
      });
   }

   // ベロシティの段を押して、なぞる。前の位置から今の位置までの間にある棒を、今の高さのベロシティにする
   // (速くなぞっても飛ばさない)。選んでいるノートがあれば、選んでいるものだけを変える。
   // FL Studio と同じく、Alt を押している間は既定値(100)にし、Shift を押して始めると、押した位置から今の位置まで直線で描く
   // タッチでは Alt の代わりに、ダブルタップ(2回目の指)で既定値にする。2回目の指のまま、なぞった棒も既定値にする
   let lastVelTap = null; // 前に段に触れた指 { time, x }
   function onVelDown(down) {
      if (!clipId || down.button !== 0) return;
      down.preventDefault();
      scroller.focus({ preventScroll: true });
      const reset = down.pointerType === 'touch' && lastVelTap !== null
         && down.timeStamp - lastVelTap.time < DOUBLE_TAP_MS && Math.abs(down.clientX - lastVelTap.x) < VEL_TAP_HIT;
      lastVelTap = down.pointerType === 'touch' && !reset ? { time: down.timeStamp, x: down.clientX } : null;
      // 指は細かく狙えないので、ダブルタップは広めに拾う
      const hitWidth = reset ? VEL_TAP_HIT : VEL_HIT;
      const targets = selected.size ? [...selected] : notes;
      const before = new Map(targets.map((n) => [n, velocityOf(n)]));
      const raw = new Map(targets.map((n) => [n, n.velocity]));
      const pointAt = (e) => {
         const rect = velBars.getBoundingClientRect();
         const value = e.altKey || reset ? DEFAULT_VELOCITY
            : Math.max(1, Math.min(127, Math.round(((rect.bottom - e.clientY) / (VEL_HEIGHT - VEL_PAD)) * 127)));
         return { x: e.clientX - rect.left, value };
      };
      // 直線は、押した位置を始点に固定して、動かすたびに引き直す(線の外に出た棒は元の値に戻す)
      const line = down.shiftKey ? pointAt(down) : null;
      let lastX = null;
      const paint = (e) => {
         const { x, value } = pointAt(e);
         let hit = false;
         if (line) {
            const from = Math.min(line.x, x) - VEL_HIT;
            const to = Math.max(line.x, x) + VEL_HIT;
            for (const n of targets) {
               const at = n.start * px;
               if (at < from || at > to) {
                  n.velocity = raw.get(n);
                  continue;
               }
               const t = x === line.x ? 1 : Math.max(0, Math.min(1, (at - line.x) / (x - line.x)));
               n.velocity = Math.round(line.value + (value - line.value) * t);
               hit = true;
            }
         } else {
            const from = Math.min(lastX ?? x, x) - hitWidth;
            const to = Math.max(lastX ?? x, x) + hitWidth;
            lastX = x;
            for (const n of targets) {
               const at = n.start * px;
               if (at < from || at > to) continue;
               n.velocity = value;
               hit = true;
            }
         }
         if (!hit && !line) return;
         if (hit) lastVelocity = value;
         velLabel.textContent = String(value);
         renderNotes();
      };
      paint(down);
      dragging = true;
      trackPointer(vel, down, {
         onMove: paint,
         onEnd: () => {
            dragging = false;
            velLabel.textContent = 'ベロシティ';
            if (targets.some((n) => velocityOf(n) !== before.get(n))) commit();
         },
      });
   }

   // 選んでいるノートのベロシティを既定値にする(右の列のボタン)
   function resetVelocity() {
      const list = [...selected];
      if (!list.some((n) => velocityOf(n) !== DEFAULT_VELOCITY)) return;
      for (const n of list) n.velocity = DEFAULT_VELOCITY;
      lastVelocity = DEFAULT_VELOCITY;
      commit();
   }

   // ---- コピー・切り取り・貼り付け ----

   function copy() {
      const list = [...selected];
      if (!list.length) return;
      const from = Math.min(...list.map((n) => n.start));
      clipboard = normalizeNotes(list).map((n) => ({ ...n, start: n.start - from }));
      renderEditButtons();
   }

   // コピーしてから消す。消すのは1回の保存なので、元に戻すも1回で戻る
   function cut() {
      if (!selected.size) return;
      copy();
      deleteSelected();
   }

   // 再生を始める位置(赤い印)に貼り付ける。印がクリップの外なら、クリップの頭に貼り付ける。
   // 置くノートと同じく、クリップの右端からははみ出させない(右端より後ろで始まるものは貼らず、またぐものは右端で切る)。
   // 再生中は、鳴らし直しと編集が絡んで分かりにくいので貼り付けさせない
   function paste() {
      const c = clip();
      if (!c || !clipboard.length) return;
      if (isPlaying()) {
         showToast('再生中は貼り付けできません。止めてから貼り付けてください');
         return;
      }
      const end = clipTicks(c);
      const rel = startTick - (c.startBar - 1) * TICKS_PER_BAR;
      const origin = rel >= 0 && rel < end ? rel : 0;
      const pasted = clipboard
         .map((n) => ({ ...n, start: origin + n.start }))
         .filter((n) => n.start < end)
         .map((n) => ({ ...n, length: Math.min(n.length, end - n.start) }));
      notes.push(...pasted);
      selected = new Set(pasted);
      commit();
      const dropped = clipboard.length - pasted.length;
      if (dropped) showToast(`クリップの右端より後ろになる${dropped}個のノートは貼り付けませんでした`);
   }

   function deleteSelected() {
      notes = notes.filter((n) => !selected.has(n));
      selected = new Set();
      commit();
   }

   // Ctrl+ドラッグ(タッチでは長押ししてから)で、囲んだ範囲に掛かるノートを選ぶ。add なら、いまの選択に足す。
   // 囲んでいる間にホイールでスクロールしても、範囲はグリッドの上の位置で追う
   function marquee(down, { add }) {
      const base = add ? new Set(selected) : new Set();
      const from = pointAt(down);
      const box = h('div', { class: 'pr-marquee' });
      grid.append(box);
      let last = down;
      const update = () => {
         const { left, right, top, bottom } = drawMarquee(box, from, pointAt(last));
         // 行の上端・下端の位置で比べる(描いているノートの見た目の範囲と揃える)
         const hit = (n) => {
            const x = n.start * px;
            const y = (127 - n.pitch) * row;
            return x < right && x + Math.max(3, n.length * px) > left && y < bottom && y + row > top;
         };
         selected = new Set([...base, ...notes.filter(hit)]);
         renderNotes();
      };
      update();
      scroller.addEventListener('scroll', update);
      return {
         onMove: (e) => {
            last = e;
            update();
         },
         onEnd: () => {
            scroller.removeEventListener('scroll', update);
            box.remove();
         },
      };
   }

   // 並びを整えて保存する。選択はノートごとに引き継ぐ(中身で引き継ぐと、まったく同じ場所に重なったノートまで選ばれる)
   function commit() {
      // normalizeNotes と同じ並べ方(sort は安定なので、同じ位置のノートの順も変わらない)
      const pairs = notes
         .map((n) => ({ note: normalizeNotes([n])[0], isSelected: selected.has(n) }))
         .sort((a, b) => a.note.start - b.note.start || a.note.pitch - b.note.pitch);
      notes = pairs.map((p) => p.note);
      selected = new Set(pairs.filter((p) => p.isSelected).map((p) => p.note));
      record();
      renderNotes();
      save();
   }

   // ---- 元に戻す / やり直す ----

   const copyNotes = (list) => list.map((n) => ({ ...n }));

   // commit の直前の状態(最後に保存したノート)を積む。やり直しの履歴は捨てる
   function record() {
      const entry = history.get(clipId);
      if (!entry) {
         history.set(clipId, { saved: copyNotes(notes), bars: clip()?.bars, undo: [], redo: [] });
      } else {
         entry.undo.push(entry.saved);
         if (entry.undo.length > HISTORY_LIMIT) entry.undo.shift();
         entry.redo = [];
         entry.saved = copyNotes(notes);
      }
      renderHistory();
   }

   function undo() {
      step('undo', 'redo');
   }

   function redo() {
      step('redo', 'undo');
   }

   // from の最後の写しに戻して保存する。いまの状態は to に積む。選択は外す(戻したノートとの対応が分からないため)
   function step(from, to) {
      const entry = history.get(clipId);
      if (dragging || !entry?.[from].length) return;
      entry[to].push(entry.saved);
      entry.saved = entry[from].pop();
      notes = copyNotes(entry.saved);
      selected = new Set();
      renderNotes();
      renderHistory();
      save();
   }

   function renderHistory() {
      const entry = clipId ? history.get(clipId) : null;
      undoButton.disabled = !entry?.undo.length;
      redoButton.disabled = !entry?.redo.length;
   }

   // 保存済みのクリップが、履歴の前提(最後に保存したノートと長さ)と違っていれば、ピアノロールの外で変わったので履歴を捨てる。
   // 履歴がなければ、いまの状態を起点にする
   function checkHistory(c) {
      const entry = history.get(c.id);
      if (entry && (entry.bars !== c.bars || !sameNotes(entry.saved, c.notes))) history.delete(c.id);
      if (!history.has(c.id)) history.set(c.id, { saved: normalizeNotes(c.notes), bars: c.bars, undo: [], redo: [] });
   }

   function onKeydown(e) {
      if (dragging) return;
      const list = [...selected];
      if ((e.key === 'Delete' || e.key === 'Backspace') && list.length) {
         e.preventDefault();
         deleteSelected();
      } else if (e.key.toLowerCase() === 'c' && (e.ctrlKey || e.metaKey) && list.length) {
         e.preventDefault();
         copy();
      } else if (e.key.toLowerCase() === 'x' && (e.ctrlKey || e.metaKey) && list.length) {
         e.preventDefault();
         cut();
      } else if (e.key.toLowerCase() === 'v' && (e.ctrlKey || e.metaKey) && clipboard.length) {
         e.preventDefault();
         paste();
      } else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
         e.preventDefault();
         undo();
      } else if ((e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) && (e.ctrlKey || e.metaKey)) {
         e.preventDefault();
         redo();
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
         e.preventDefault();
         selected = new Set(notes);
         renderNotes();
      } else if (e.key === 'Escape') {
         e.preventDefault();
         if (selected.size) {
            selected = new Set();
            renderNotes();
         } else {
            close();
         }
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && list.length) {
         // 上下で半音(Shift か Ctrl で1オクターブ)動かす
         e.preventDefault();
         nudge(0, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey || e.ctrlKey || e.metaKey ? 12 : 1));
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && list.length) {
         // 左右でグリッド1つ分(Shift か Ctrl で1小節)動かす
         e.preventDefault();
         nudge((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey || e.ctrlKey || e.metaKey ? TICKS_PER_BAR : snap), 0);
      }
   }

   // 選んでいるノートをまとめて tick 分右へ、pitch 分上へ動かして保存する
   function nudge(tick, pitch) {
      if (shift(tick, pitch)) commit();
   }

   // 選んでいるノートをまとめて動かす(保存はしない)。1つでも鍵盤やクリップの範囲を出るなら動かさない。動かしたかを返す
   function shift(tick, pitch) {
      const list = [...selected];
      if (!list.length) return false;
      if (list.some((n) => n.pitch + pitch < 0 || n.pitch + pitch > 127)) return false;
      const range = shiftRange(list);
      if (tick < range.min || tick > range.max) return false;
      for (const n of list) {
         n.start += tick;
         n.pitch += pitch;
      }
      if (pitch && list.length === 1) preview(list[0].pitch, velocityOf(list[0]));
      renderNotes();
      return true;
   }

   // ---- 読み込み ----

   // 保存済みのノートを手元に写す。編集中・保存待ちの間は上書きしない(自分の保存より古い内容のことがある)
   function sync({ force = false } = {}) {
      const c = clip();
      if (!c) {
         close();
         return;
      }
      renderHead();
      renderOnion();
      // 保存待ち・編集中は、読み直したノートが自分の保存より古いことがあるので比べない
      if (!dragging && !unsaved()) checkHistory(c);
      renderHistory();
      if (!force && (dragging || unsaved() || sameNotes(c.notes, notes))) {
         renderNotes();
         return;
      }
      const keys = new Set([...selected].map(noteKey));
      notes = normalizeNotes(c.notes);
      selected = new Set(notes.filter((n) => keys.has(noteKey(n))));
      renderNotes();
   }

   function open(id) {
      const opening = id !== clipId;
      // 閉じた状態から開くときは、オニオンスキンを初めの状態(全体 OFF・各トラック ON)に戻す
      // 高さも覚えた高さに戻す
      if (!clipId) {
         onion = false;
         onionOff = new Set();
         applyHeight();
         // ピアノロールの外のボタン(書き出し・複製など)や、ほかのアプリへの切り替えの前に、待っている保存を済ませる
         document.addEventListener('pointerdown', flushOutside, true);
         document.addEventListener('focusin', flushOutside, true);
         document.addEventListener('visibilitychange', flushHidden);
         window.addEventListener('pagehide', flush);
      }
      if (opening) flush();
      clipId = id;
      if (opening) {
         scaleSignature = '';
         notes = [];
         selected = new Set();
      }
      el.hidden = false;
      sync({ force: opening });
      if (opening) {
         // ノートがあればその高さ、なければ C4 のあたりを真ん中に出す
         const pitches = notes.map((n) => n.pitch);
         const center = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
         scroller.scrollTop = (127 - center) * row - scroller.clientHeight / 2;
         scroller.scrollLeft = 0;
         updateHbar();
      }
      scroller.focus({ preventScroll: true });
      updatePlayState();
      onSelectionChange?.(clipId);
   }

   function close() {
      if (!clipId) return;
      flush();
      document.removeEventListener('pointerdown', flushOutside, true);
      document.removeEventListener('focusin', flushOutside, true);
      document.removeEventListener('visibilitychange', flushHidden);
      window.removeEventListener('pagehide', flush);
      clipId = null;
      notes = [];
      selected = new Set();
      el.hidden = true;
      onSelectionChange?.(null);
   }

   return {
      el,
      open,
      close,
      get clipId() {
         return clipId;
      },
      /** まだ保存し終えていない編集中のノート({ clipId, notes })。なければ null。 */
      get editing() {
         return clipId && unsaved() ? { clipId, notes: normalizeNotes(notes) } : null;
      },
      /** 再生の開始・停止のたびに呼ぶ(再生ボタンの形を変える)。 */
      updatePlayState,
      /** アレンジ画面が読み直すたびに呼ぶ。 */
      update(next) {
         data = next;
         // 消したクリップの履歴は捨てる(「元に戻す」で戻ったクリップは、戻った状態を起点にする)
         for (const id of history.keys()) {
            if (!data.clips.some((c) => c.id === id)) history.delete(id);
         }
         if (clipId) sync();
      },
      /** 再生を始める位置(曲の頭からの tick)。 */
      setStart(tick) {
         startTick = tick;
         renderCursor();
      },
      /** 再生位置(曲の頭からの tick)。止まっていれば null。 */
      setPlayhead(tick) {
         const c = clip();
         const rel = c && tick != null ? tick - (c.startBar - 1) * TICKS_PER_BAR : -1;
         const visible = c && rel >= 0 && rel <= clipTicks(c);
         playhead.hidden = !visible;
         // 毎フレーム呼ばれるので、left ではなく transform で動かす(レイアウトをやり直させない)
         if (visible) playhead.style.transform = `translateX(${rel * px}px)`;
      },
   };
}
