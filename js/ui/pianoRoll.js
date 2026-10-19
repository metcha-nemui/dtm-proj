// ピアノロール。アレンジ画面の下に出すパネルで、選んだクリップ1つのノートを編集する。
// 操作は FL Studio に寄せている:空いているところを押すとノートを置き(そのままドラッグで動かせる)、
// ノートを掴むと移動、右端を掴むと長さを変える。右クリックで消す(押したままなぞると続けて消す)。
// ノートを置く長さは、最後に触ったノートの長さ。Ctrl+ドラッグで囲んだノートを選ぶ(Shift も押すと選択に足す)。
// タッチでは、グリッドの上の指はスクロールに使わず、すぐノートの操作にする(スクロールと取り合うと、操作の起点が長押しに頼ることになり使いにくいため)。
// 横のスクロールは下端の太いスクロールバー、縦のスクロールとノートの高さ(縦のピンチ)は鍵盤の上の指で行う。
// ノートのドラッグは「置く・動かす」が基本で、ヘッダーの「伸縮モード」を ON にした間だけ「長さを変える」にする(端を狙わずに済むように)。
// 選んでいるノートは、右端に出す十字キーでも動かせる。
// 選んだノートは Ctrl+C でコピー(Ctrl+X で切り取り)し、Ctrl+V で再生を始める位置(クリップの外ならクリップの頭)に貼り付ける。
// 行の塗り分けは鍵盤の白黒ではなく、プロジェクトのスケール(キーとメジャー / マイナー)に合わせる。
// スケールはアレンジ画面の「スケール」の段で決め、クリップの途中で転調していれば、転調の位置から塗り分けを変える。
// ノートはクリップの範囲(左端〜右端)からはみ出すようには動かせない。
// 同じ高さ・同じ位置で始まるノートが重なっていたら赤くする(気付いて片方を消せるように)。
// オニオンスキン:ほかのトラックの、同じ時間に鳴るノートを薄く重ねて出せる(表示だけ。押せない)。
// 全体の ON / OFF と、トラックごとの ON / OFF がある。覚えておかず、閉じた状態から開くたびに「全体 OFF・各トラック ON」に戻す。
// ベロシティ:グリッドの下の段に、ノートの頭の位置で縦棒として出す(ノートの濃さにも映す)。段を押して上下になぞると、
// なぞった位置の棒をその高さのベロシティにする(FL Studio と同じ。選んでいるノートがあれば、選んでいるものだけを変える)。
// Alt を押している間は既定値(100)にし、Shift を押して始めると直線で描く。
// 新しく置くノートのベロシティは、最後に触ったノートのもの。
//
// 元に戻す / やり直す(Ctrl+Z / Ctrl+Y・Ctrl+Shift+Z。タッチではヘッダーのボタン)は、クリップごとに、保存したノートの写しを積んで行う。
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

const BEAT = 64; // 1拍の幅(px)
const PX = BEAT / PPQ; // 1 tick の幅(px)
const EDGE = 6; // ノートの右端の、掴むと長さを変えられる幅(px)
const VEL_HEIGHT = 64; // ベロシティの段の高さ(px。CSS の --pr-vel-h に渡す)
const VEL_PAD = 6; // ベロシティの段の上の余白(127 の棒が上端に付かないように)
const VEL_HIT = 4; // ベロシティの段で、なぞった位置から棒を拾う幅(px)
const DEFAULT_VELOCITY = 100;
const DRAG_THRESHOLD = 3;
// タッチで、空いているところをこれだけ押さえたら、囲んで選ぶ。アレンジ画面のクリップの長押しと揃える
const HOLD_MS = 350;
// タッチで、これだけ動いたらドラッグとみなす(px)。指は少し揺れるので、マウスより広くとる(タップで選ぶつもりが動かさないように)
const TOUCH_SLOP = 8;
const RULER_H = 20; // ルーラーの高さ(px。CSS の --pr-ruler-h と揃える)
// 十字キーを押し続けたとき、くり返し動かし始めるまでと、その間隔(ms)
const REPEAT_DELAY = 400;
const REPEAT_MS = 90;
const HISTORY_LIMIT = 100; // 元に戻せる回数(クリップごと)
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

// 1音の高さ(px)。タッチでは鍵盤の上の縦のピンチ、マウスではホイールを押しながら回して変える。
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
 * @param {(clipId: string) => void} [options.onOpenDetail] クリップ詳細を開く
 * @param {(tick: number) => void} [options.onSeek] ルーラーを押して、再生を始める位置(曲の頭からの tick)を変えたとき
 * @param {() => boolean} [options.isPlaying] 再生中か(再生中は貼り付けさせない)
 * @param {() => number} [options.topLimit] パネルの上端をここ(画面上の y 座標)より上へは広げない
 */
export function createPianoRoll({
   projectId, onSelectionChange, onPlayClip, isLooping = () => false, onOpenDetail, onSeek, isPlaying = () => false,
   topLimit = () => 0,
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
   let onion = false; // オニオンスキンを出すか
   let onionOff = new Set(); // オニオンスキンに出さないトラックの id
   let resizeMode = false; // タッチで、ノートのドラッグを「長さを変える」にする(置く・動かすはしない)
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
         if (!c) return;
         const unit = snap > 1 ? snap : PPQ / 4;
         const last = Math.floor((clipTicks(c) - 1) / unit) * unit;
         const at = Math.floor((e.clientX - ruler.getBoundingClientRect().left) / PX / unit) * unit;
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
   // 選んでいるノートを消す(Delete キーと同じ。キーのないタッチの画面のため。選んでいるときだけ出す)
   const deleteButton = h('button', {
      type: 'button', class: 'btn btn-icon', title: '選んだノートを消す', 'aria-label': '選んだノートを消す', hidden: true,
      onclick: () => deleteSelected(),
   }, icon('trash-2'));
   // 元に戻す / やり直す(Ctrl+Z / Ctrl+Y と同じ。キーのないタッチの画面のため)
   const undoButton = h('button', {
      type: 'button', class: 'btn btn-icon pr-touch-only', title: '元に戻す', 'aria-label': '元に戻す', disabled: true,
      onclick: () => undo(),
   }, icon('undo-2'));
   const redoButton = h('button', {
      type: 'button', class: 'btn btn-icon pr-touch-only', title: 'やり直す', 'aria-label': 'やり直す', disabled: true,
      onclick: () => redo(),
   }, icon('redo-2'));
   // タッチの伸縮モード。ON の間は、ノートをドラッグすると(どこを掴んでも)長さが変わる。置く・動かすはしない
   const resizeToggle = h('button', {
      type: 'button',
      class: 'btn btn-icon pr-mode-toggle pr-touch-only',
      title: '伸縮モード(ON の間は、ノートをドラッグして長さを変える。置く・動かすはできない)',
      'aria-label': '伸縮モード',
      'aria-pressed': 'false',
      onclick: () => {
         resizeMode = !resizeMode;
         resizeToggle.setAttribute('aria-pressed', String(resizeMode));
      },
   }, icon('unfold-horizontal'));
   // 十字キー(矢印キーと同じ。←→ でグリッド1つ分、↓↑ で半音)。タッチの画面で、ノートを選んでいる間だけ右端に出す。
   // 押し続けるとくり返し動かし、離したときにまとめて保存する
   const padButton = (name, label, area, step) => {
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
         class: 'btn btn-icon pr-dpad-button',
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
      }, icon(name));
   };
   const dpad = h('div', { class: 'pr-dpad pr-touch-only', hidden: true },
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
   // このクリップだけを頭からループで鳴らす。ループ中は停止のボタンになる(updatePlayState で切り替える)
   const playButton = h('button', {
      type: 'button',
      class: 'btn btn-icon',
      onclick: () => { const c = clip(); if (c) onPlayClip?.(c); },
   });
   function updatePlayState() {
      const looping = Boolean(clipId && isLooping(clipId));
      const label = looping ? 'ループ再生を止める' : 'このクリップだけをループ再生(ミュート・ソロに関わらず、このトラックだけを鳴らす)';
      playButton.title = label;
      playButton.setAttribute('aria-label', looping ? 'ループ再生を止める' : 'このクリップだけをループ再生');
      playButton.classList.toggle('is-playing', looping);
      playButton.replaceChildren(icon(looping ? 'square' : 'play'));
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

   // ベロシティの段の高さは、十字キーの位置にも使う
   const el = h('section', { class: 'pr', 'aria-label': 'ピアノロール', hidden: true, style: { '--pr-vel-h': `${VEL_HEIGHT}px` } },
      resizeHandle(),
      h('header', { class: 'pr-head' },
         icon('piano', 16),
         title,
         range,
         h('label', { class: 'pr-snap-label muted' }, 'グリッド', snapSelect),
         scaleText,
         resizeToggle,
         h('span', { class: 'pr-onion-tools' }, onionToggle, onionTracks),
         h('span', { class: 'pr-spacer' }),
         undoButton,
         redoButton,
         deleteButton,
         playButton,
         h('button', {
            type: 'button', class: 'btn btn-icon', title: '.mid を読み込む(ノートを置き換える)', 'aria-label': '.mid を読み込む',
            onclick: () => { if (clipId) importMidiToClip(projectId, clipId); },
         }, icon('upload')),
         h('button', {
            type: 'button', class: 'btn btn-icon', title: '.mid を書き出す', 'aria-label': '.mid を書き出す',
            onclick: () => downloadMidi(currentMidi()),
         }, icon('download')),
         h('button', {
            type: 'button', class: 'btn btn-icon', title: 'クリップ詳細', 'aria-label': 'クリップ詳細',
            onclick: () => { if (clipId) onOpenDetail?.(clipId); },
         }, icon('notebook-text')),
         h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'ピアノロールを閉じる', onclick: () => close() }, icon('x'))),
      scroller,
      hbar,
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
      inner.style.setProperty('--pr-width', `${clipTicks(c) * PX}px`);
      inner.style.setProperty('--pr-bar', `${TICKS_PER_BAR * PX}px`);
      inner.style.setProperty('--pr-beat', `${BEAT}px`);
      inner.style.setProperty('--pr-row', `${row}px`);
      renderScale();
      updateHbar();
      ruler.replaceChildren(...Array.from({ length: c.bars * BEATS_PER_BAR }, (_, i) => h('span', {
         class: `pr-beat${i % BEATS_PER_BAR === 0 ? ' is-bar' : ''}`,
      }, i % BEATS_PER_BAR === 0 ? String(c.startBar + i / BEATS_PER_BAR) : '')), cursor);
      renderCursor();
   }

   // 再生を始める位置の印。クリップの範囲(頭〜終わり)にあるときだけ出す
   function renderCursor() {
      const c = clip();
      const rel = c ? startTick - (c.startBar - 1) * TICKS_PER_BAR : -1;
      cursor.hidden = !c || rel < 0 || rel > clipTicks(c);
      if (!cursor.hidden) cursor.style.left = `${rel * PX}px`;
   }

   // スケールの外の音の行を暗く、主音の行を少し色付きにする(鍵盤は実際の白黒のまま)。
   // 転調があれば、区間ごとに128行の列を作って横に並べる。変わらなければ作り直さない
   let scaleSignature = '';
   function renderScale() {
      const c = clip();
      const spans = scaleSpans(projectScales(data.project), c.startBar, c.bars);
      scaleText.textContent = spans.map((span) => scaleLabel(span.scale)).join(' → ');
      const signature = JSON.stringify(spans);
      if (signature === scaleSignature) return;
      scaleSignature = signature;
      rows.replaceChildren(...spans.map(({ from, to, scale }) => {
         const column = h('div', {
            class: `pr-scale${from > 0 ? ' is-change' : ''}`,
            style: { width: `${(to - from) * TICKS_PER_BAR * PX}px` },
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

   // マウスでは、ホイールを押しながら回すとノートの高さを変える(押すだけで始まる自動スクロールは止める)
   scroller.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
   });
   scroller.addEventListener('wheel', (e) => {
      if (!(e.buttons & 4) || !e.deltaY) return;
      e.preventDefault();
      setRow(row + (e.deltaY < 0 ? WHEEL_ROW_STEP : -WHEEL_ROW_STEP), e.clientY);
   }, { passive: false });

   // ---- タッチのスクロール ----

   // 鍵盤の上の指。1本なら縦にスクロール(離したあとも少し滑らせる)、2本なら縦のピンチでノートの高さを変える。
   // 動かさずに離したら、その鍵盤を鳴らす。鍵盤は touch-action: none なので、ブラウザのスクロールとは取り合わない
   const keyTouches = new Map(); // pointerId → 今の y 座標
   let keyGesture = null;
   let glide = 0; // 慣性で滑らせている requestAnimationFrame の id

   function stopGlide() {
      cancelAnimationFrame(glide);
      glide = 0;
   }

   // 1本指のスクロールを、今の指の位置から始め直す(ピンチから1本に戻ったときも)。tap は、離したら鳴らす音(動かしたら null)
   function startKeyScroll(y, tap) {
      keyGesture = { kind: 'scroll', y, top: scroller.scrollTop, tap, samples: [{ y, t: performance.now() }] };
   }

   keys.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      stopGlide();
      keys.setPointerCapture(e.pointerId);
      keyTouches.set(e.pointerId, e.clientY);
      if (keyTouches.size === 1) {
         const pitch = e.target.closest?.('.pr-key')?.dataset.pitch;
         startKeyScroll(e.clientY, pitch == null ? null : Number(pitch));
      } else if (keyTouches.size === 2) {
         const [a, b] = [...keyTouches.values()];
         keyGesture = { kind: 'pinch', distance: Math.max(20, Math.abs(a - b)), row };
      }
   });
   keys.addEventListener('pointermove', (e) => {
      if (!keyTouches.has(e.pointerId) || !keyGesture) return;
      keyTouches.set(e.pointerId, e.clientY);
      if (keyGesture.kind === 'pinch') {
         const [a, b] = [...keyTouches.values()];
         setRow(keyGesture.row * (Math.max(20, Math.abs(a - b)) / keyGesture.distance), (a + b) / 2);
         return;
      }
      if (keyGesture.tap != null && Math.abs(e.clientY - keyGesture.y) < TOUCH_SLOP) return;
      keyGesture.tap = null;
      scroller.scrollTop = keyGesture.top - (e.clientY - keyGesture.y);
      const now = performance.now();
      keyGesture.samples = [...keyGesture.samples.filter((s) => now - s.t < 100), { y: e.clientY, t: now }];
   });
   const endKeyTouch = (e) => {
      if (!keyTouches.has(e.pointerId)) return;
      keyTouches.delete(e.pointerId);
      if (keyTouches.size === 1) {
         // ピンチの指が1本離れたら、残った指でスクロールを続ける
         startKeyScroll([...keyTouches.values()][0], null);
         return;
      }
      if (keyTouches.size) return;
      const gesture = keyGesture;
      keyGesture = null;
      if (gesture?.kind !== 'scroll') return;
      if (gesture.tap != null) {
         if (e.type === 'pointerup') preview(gesture.tap);
         return;
      }
      // 最後の 100ms の動きの速さで滑らせ、だんだん止める
      const first = gesture.samples[0];
      const last = gesture.samples[gesture.samples.length - 1];
      let speed = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0; // px/ms
      let time = performance.now();
      const step = (now) => {
         const dt = Math.max(0, now - time);
         time = now;
         scroller.scrollTop -= speed * dt;
         speed *= 0.95 ** (dt / 16);
         glide = Math.abs(speed) > 0.02 ? requestAnimationFrame(step) : 0;
      };
      if (Math.abs(speed) > 0.1) glide = requestAnimationFrame(step);
   };
   keys.addEventListener('pointerup', endKeyTouch);
   keys.addEventListener('pointercancel', endKeyTouch);

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
   function onHbarDown(down) {
      if (down.button !== 0) return;
      down.preventDefault();
      const rect = hbar.getBoundingClientRect();
      const thumb = hbarThumb.getBoundingClientRect();
      const range = rect.width - thumb.width; // つまみが動ける幅
      const max = scroller.scrollWidth - scroller.clientWidth;
      if (range <= 0 || max <= 0) return;
      if (down.clientX < thumb.left || down.clientX > thumb.right) {
         scroller.scrollLeft = ((down.clientX - rect.left - thumb.width / 2) / range) * max;
      }
      const from = scroller.scrollLeft;
      hbar.classList.add('is-dragging');
      trackPointer(hbar, down, {
         onMove: (e) => {
            scroller.scrollLeft = from + ((e.clientX - down.clientX) / range) * max;
         },
         onEnd: () => hbar.classList.remove('is-dragging'),
      });
   }

   // いちばん細い縦線は、グリッドの細かさに合わせる(「なし」なら 1/16)
   function renderGridLines() {
      inner.style.setProperty('--pr-snap', `${(snap > 1 ? snap : PPQ / 4) * PX}px`);
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
            left: `${n.start * PX}px`,
            top: `${(127 - n.pitch) * row}px`,
            width: `${Math.max(3, n.length * PX)}px`,
            '--vel': String(velocityOf(n) / 127),
         },
         dataset: { index: String(i) },
         title: `${pitchName(n.pitch)} ベロシティ ${velocityOf(n)}${dup(n) ? '(同じ位置に重なっているノートがあります)' : ''}`,
      })));
      deleteButton.hidden = !selected.size;
      dpad.hidden = !selected.size;
      // 選んでいるノートの棒は、ほかの棒に隠れないよう後ろ(上)に描く
      const order = [...notes.filter((n) => !selected.has(n)), ...notes.filter((n) => selected.has(n))];
      velBars.replaceChildren(...order.map((n) => h('div', {
         class: `pr-vel-bar${selected.has(n) ? ' is-selected' : ''}${outside(n) ? ' is-outside' : ''}`,
         style: { left: `${n.start * PX}px`, height: `${(velocityOf(n) / 127) * (VEL_HEIGHT - VEL_PAD)}px` },
      })));
   }

   // ---- オニオンスキン ----

   // 編集中のトラック以外のトラック(並び順)
   const otherTracks = () => sortByOrder(data?.tracks ?? []).filter((t) => t.id !== clip()?.trackId);

   function openOnionMenu() {
      const tracks = otherTracks();
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
         : [{ label: 'ほかのトラックがありません', onSelect: () => {} }]);
   }

   // ほかのトラックのクリップのうち、編集中のクリップと時間が重なる部分の、鳴るノートを出す。
   // 位置は編集中のクリップの先頭からの相対に直す
   function renderOnion() {
      onionToggle.setAttribute('aria-pressed', String(onion));
      const c = clip();
      if (!onion || !c) {
         onionLayer.replaceChildren();
         return;
      }
      const end = clipTicks(c);
      const shown = new Set(otherTracks().filter((t) => !onionOff.has(t.id)).map((t) => t.id));
      const ghosts = data.clips.filter((other) => shown.has(other.trackId)).flatMap((other) => {
         const offset = (other.startBar - c.startBar) * TICKS_PER_BAR;
         return audibleNotes(other)
            .map((n) => ({ ...n, start: n.start + offset }))
            .filter((n) => n.start < end && n.start + n.length > 0);
      });
      onionLayer.replaceChildren(...ghosts.map((n) => h('div', {
         class: 'pr-onion-note',
         style: {
            left: `${Math.max(0, n.start) * PX}px`,
            top: `${(127 - n.pitch) * row}px`,
            width: `${Math.max(3, (Math.min(end, n.start + n.length) - Math.max(0, n.start)) * PX)}px`,
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
         tick: (e.clientX - rect.left) / PX,
         pitch: Math.max(0, Math.min(127, 127 - Math.floor((e.clientY - rect.top) / row))),
         x: e.clientX - rect.left,
         y: e.clientY - rect.top,
      };
   }

   const noteAtTarget = (target) => {
      const noteEl = target?.closest?.('.pr-note');
      return noteEl ? notes[Number(noteEl.dataset.index)] : null;
   };

   function save() {
      if (!clipId) return;
      pending++;
      actions.setClipNotes(projectId, clipId, notes.map((n) => ({ ...n })))
         .catch((error) => {
            reportError(error);
            history.delete(clipId); // 保存できなかった内容の写しが積まれているので捨てる
            renderHistory();
            pending = 0;
            sync({ force: true }); // 保存できなかったので、保存済みのノートに戻す
         })
         .finally(() => {
            pending = Math.max(0, pending - 1);
         });
   }

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
         stopGlide();
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
      const mode = given ?? (!created && (target.start + target.length) * PX - at.x <= EDGE ? 'resize' : 'move');
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
   // 動かしたらドラッグ(startTouchDrag)、空いているところの長押しは囲んで選ぶ、動かさずに離したらタップ(tap)
   function onTouchDown(down) {
      const target = noteAtTarget(down.target);
      let handlers = null; // 何をするかが決まってからの動き
      let timer = null;
      const begin = (make) => {
         clearTimeout(timer);
         handlers = make();
      };
      if (!target) timer = setTimeout(() => begin(() => marquee(down, { add: true })), HOLD_MS);
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
   // 空いているところなら、ノートを置いて動かす(伸縮モードでは置かず、囲んで選ぶ)
   function startTouchDrag(down, target) {
      if (target) {
         if (!selected.has(target)) selected = new Set([target]);
         lastLength = target.length;
         lastVelocity = velocityOf(target);
         return dragNotes(down, target, { mode: resizeMode ? 'resize' : 'move' });
      }
      if (resizeMode) return marquee(down, { add: true });
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

   // タッチのタップ。ノートなら選択に足す / 外す(Shift+クリックと同じ)。空いているところなら、
   // 選んでいるノートがあれば選択を外し、なければノートを置く(続けて置けるよう、置いたノートは選ばない。伸縮モードでは置かない)
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
      } else if (!resizeMode) {
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
   function onVelDown(down) {
      if (!clipId || down.button !== 0) return;
      down.preventDefault();
      scroller.focus({ preventScroll: true });
      const targets = selected.size ? [...selected] : notes;
      const before = new Map(targets.map((n) => [n, velocityOf(n)]));
      const raw = new Map(targets.map((n) => [n, n.velocity]));
      const pointAt = (e) => {
         const rect = velBars.getBoundingClientRect();
         const value = e.altKey ? DEFAULT_VELOCITY
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
               const at = n.start * PX;
               if (at < from || at > to) {
                  n.velocity = raw.get(n);
                  continue;
               }
               const t = x === line.x ? 1 : Math.max(0, Math.min(1, (at - line.x) / (x - line.x)));
               n.velocity = Math.round(line.value + (value - line.value) * t);
               hit = true;
            }
         } else {
            const from = Math.min(lastX ?? x, x) - VEL_HIT;
            const to = Math.max(lastX ?? x, x) + VEL_HIT;
            lastX = x;
            for (const n of targets) {
               const at = n.start * PX;
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

   // ---- コピー・切り取り・貼り付け ----

   function copy() {
      const list = [...selected];
      if (!list.length) return;
      const from = Math.min(...list.map((n) => n.start));
      clipboard = normalizeNotes(list).map((n) => ({ ...n, start: n.start - from }));
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
            const x = n.start * PX;
            const y = (127 - n.pitch) * row;
            return x < right && x + Math.max(3, n.length * PX) > left && y < bottom && y + row > top;
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
      if (!dragging && pending === 0) checkHistory(c);
      renderHistory();
      if (!force && (dragging || pending > 0 || sameNotes(c.notes, notes))) {
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
      }
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
         if (visible) playhead.style.left = `${rel * PX}px`;
      },
   };
}
