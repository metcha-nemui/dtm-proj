// ピアノロール。アレンジ画面の下に出すパネルで、選んだクリップ1つのノートを編集する。
// 操作は FL Studio に寄せている:空いているところを押すとノートを置き(そのままドラッグで動かせる)、
// ノートを掴むと移動、右端を掴むと長さを変える。右クリックで消す(押したままなぞると続けて消す)。
// ノートを置く長さは、最後に触ったノートの長さ。Ctrl+ドラッグで囲んだノートを選ぶ(Shift も押すと選択に足す)。
// 選んだノートは Ctrl+C でコピーし、Ctrl+V で再生を始める位置(クリップの外ならクリップの頭)に貼り付ける。
// 行の塗り分けは鍵盤の白黒ではなく、プロジェクトのスケール(キーとメジャー / マイナー)に合わせる。
// スケールはアレンジ画面の「スケール」の段で決め、クリップの途中で転調していれば、転調の位置から塗り分けを変える。
// ノートはクリップの範囲(左端〜右端)からはみ出すようには動かせない。
// 同じ高さ・同じ位置で始まるノートが重なっていたら赤くする(気付いて片方を消せるように)。
// オニオンスキン:ほかのトラックの、同じ時間に鳴るノートを薄く重ねて出せる(表示だけ。押せない)。
// 全体の ON / OFF と、トラックごとの ON / OFF がある。覚えておかず、閉じた状態から開くたびに「全体 OFF・各トラック ON」に戻す。
// ベロシティ:グリッドの下の段に、ノートの頭の位置で縦棒として出す(ノートの濃さにも映す)。段を押して上下になぞると、
// なぞった位置の棒をその高さのベロシティにする(FL Studio と同じ。選んでいるノートがあれば、選んでいるものだけを変える)。
// 新しく置くノートのベロシティは、最後に触ったノートのもの。
//
// 編集は手元の notes に反映してから、操作の区切り(ポインタを離したとき)ごとにクリップのノートを丸ごと保存する。
// 表示の単位は px、ノートの単位は tick(midi.js)。

import * as actions from '../actions.js';
import {
   audibleNotes, BEATS_PER_BAR, clipTicks, inScale, isBlackKey, normalizeNotes, pitchName, PPQ, projectScales, scaleLabel, scaleSpans,
   setupMessages, TICKS_PER_BAR, trackChannels,
} from '../domain/midi.js';
import { sortByOrder } from '../domain/order.js';
import { UNTITLED_CLIP } from '../domain/arrangement.js';
import { barRange } from './clipDrawer.js';
import { h, icon } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { reportError, showToast } from './components/toast.js';
import { clipMidi, downloadMidi } from './midiExport.js';
import { previewNote } from './synth.js';

const ROW = 12; // 1音の高さ(px)
const BEAT = 64; // 1拍の幅(px)
const PX = BEAT / PPQ; // 1 tick の幅(px)
const EDGE = 6; // ノートの右端の、掴むと長さを変えられる幅(px)
const VEL_HEIGHT = 64; // ベロシティの段の高さ(px。CSS の --pr-vel-h に渡す)
const VEL_PAD = 6; // ベロシティの段の上の余白(127 の棒が上端に付かないように)
const VEL_HIT = 4; // ベロシティの段で、なぞった位置から棒を拾う幅(px)
const DEFAULT_VELOCITY = 100;
const DRAG_THRESHOLD = 3;
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
 */
export function createPianoRoll({
   projectId, onSelectionChange, onPlayClip, isLooping = () => false, onOpenDetail, onSeek, isPlaying = () => false,
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
      title: '上下になぞって、ノートのベロシティを変える(選んでいるノートがあれば、それだけ)',
      onpointerdown: (e) => onVelDown(e),
      oncontextmenu: (e) => e.preventDefault(),
   }, velBars);
   const inner = h('div', { class: 'pr-inner', style: { '--pr-vel-h': `${VEL_HEIGHT}px` } },
      h('div', { class: 'pr-corner' }), ruler, keys, grid, h('div', { class: 'pr-vel-corner' }, velLabel), vel);
   const scroller = h('div', { class: 'pr-scroll', tabIndex: -1, onkeydown: (e) => onKeydown(e) }, inner);

   const el = h('section', { class: 'pr', 'aria-label': 'ピアノロール', hidden: true },
      h('header', { class: 'pr-head' },
         icon('piano', 16),
         title,
         range,
         h('label', { class: 'pr-snap-label muted' }, 'グリッド', snapSelect),
         scaleText,
         h('span', { class: 'pr-onion-tools' }, onionToggle, onionTracks),
         h('span', { class: 'pr-spacer' }),
         playButton,
         h('button', {
            type: 'button', class: 'btn btn-icon', title: '.mid を書き出す', 'aria-label': '.mid を書き出す',
            onclick: () => downloadMidi(currentMidi()),
         }, icon('download')),
         h('button', {
            type: 'button', class: 'btn btn-icon', title: 'クリップ詳細', 'aria-label': 'クリップ詳細',
            onclick: () => { if (clipId) onOpenDetail?.(clipId); },
         }, icon('notebook-text')),
         h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'ピアノロールを閉じる', onclick: () => close() }, icon('x'))),
      scroller);

   // 鍵盤は、上が高い音(127)。128音ぶんを一度だけ作る。グリッドの行は、転調の区間ごとに renderScale で作る
   for (let pitch = 127; pitch >= 0; pitch--) {
      const black = isBlackKey(pitch);
      const isC = pitch % 12 === 0;
      keys.append(h('div', {
         class: `pr-key${black ? ' is-black' : ''}${isC ? ' is-c' : ''}`,
         title: pitchName(pitch),
         onpointerdown: (e) => {
            e.preventDefault();
            preview(pitch);
         },
      }, isC ? pitchName(pitch) : ''));
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
      previewNote(setupMessages(t, channel), channel, pitch, velocity);
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
      inner.style.setProperty('--pr-row', `${ROW}px`);
      renderScale();
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
            top: `${(127 - n.pitch) * ROW}px`,
            width: `${Math.max(3, n.length * PX)}px`,
            '--vel': String(velocityOf(n) / 127),
         },
         dataset: { index: String(i) },
         title: `${pitchName(n.pitch)} ベロシティ ${velocityOf(n)}${dup(n) ? '(同じ位置に重なっているノートがあります)' : ''}`,
      })));
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
            top: `${(127 - n.pitch) * ROW}px`,
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
         pitch: Math.max(0, Math.min(127, 127 - Math.floor((e.clientY - rect.top) / ROW))),
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
            pending = 0;
            sync({ force: true }); // 保存できなかったので、保存済みのノートに戻す
         })
         .finally(() => {
            pending = Math.max(0, pending - 1);
         });
   }

   function onGridDown(down) {
      if (!clipId) return;
      scroller.focus({ preventScroll: true });
      if (down.button === 2) {
         erase(down);
         return;
      }
      if (down.button !== 0) return;
      if (down.ctrlKey || down.metaKey) {
         marquee(down);
         return;
      }
      down.preventDefault();
      const at = pointAt(down);
      let target = noteAtTarget(down.target);
      let mode = 'move';
      let created = false;
      if (target) {
         const right = (target.start + target.length) * PX;
         if (right - at.x <= EDGE) mode = 'resize';
         if (down.shiftKey) {
            if (selected.has(target)) selected.delete(target);
            else selected.add(target);
         } else if (!selected.has(target)) {
            selected = new Set([target]);
         }
         lastLength = target.length;
         lastVelocity = velocityOf(target);
      } else {
         // 置くノートも、クリップの右端からはみ出さない長さにする
         const end = clipTicks(clip());
         const start = Math.max(0, Math.min(end - 1, snapFloor(at.tick, down.altKey)));
         target = { pitch: at.pitch, start, length: Math.max(1, Math.min(lastLength, end - start)), velocity: lastVelocity };
         notes.push(target);
         selected = new Set([target]);
         created = true;
      }
      if (!selected.has(target)) {
         // Shift で選択を外したノートは動かさない
         renderNotes();
         return;
      }
      preview(target.pitch, velocityOf(target));
      renderNotes();

      const moving = [...selected].map((n) => ({ note: n, start: n.start, pitch: n.pitch, length: n.length }));
      const origin = moving.find((m) => m.note === target);
      const range = shiftRange(moving);
      // 長さを変えるときも、右端がクリップの右端を越えないようにする(もともと越えているノートがあれば伸ばさない)
      const maxGrow = Math.max(0, Math.min(...moving.map((m) => clipTicks(clip()) - m.start - m.length)));
      let moved = false;
      let lastPitch = target.pitch;
      dragging = true;
      grid.setPointerCapture(down.pointerId);

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
      const end = () => {
         grid.removeEventListener('pointermove', move);
         grid.removeEventListener('pointerup', end);
         grid.removeEventListener('pointercancel', end);
         dragging = false;
         const changed = created || moving.some((m) => m.note.start !== m.start || m.note.pitch !== m.pitch || m.note.length !== m.length);
         if (changed) commit();
      };
      grid.addEventListener('pointermove', move);
      grid.addEventListener('pointerup', end);
      grid.addEventListener('pointercancel', end);
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
      grid.setPointerCapture(down.pointerId);
      const move = (e) => hit(document.elementFromPoint(e.clientX, e.clientY));
      const end = () => {
         grid.removeEventListener('pointermove', move);
         grid.removeEventListener('pointerup', end);
         grid.removeEventListener('pointercancel', end);
         dragging = false;
         if (changed) commit();
      };
      grid.addEventListener('pointermove', move);
      grid.addEventListener('pointerup', end);
      grid.addEventListener('pointercancel', end);
   }

   // ベロシティの段を押して、なぞる。前の位置から今の位置までの間にある棒を、今の高さのベロシティにする
   // (速くなぞっても飛ばさない)。選んでいるノートがあれば、選んでいるものだけを変える
   function onVelDown(down) {
      if (!clipId || down.button !== 0) return;
      down.preventDefault();
      scroller.focus({ preventScroll: true });
      const targets = selected.size ? [...selected] : notes;
      const before = new Map(targets.map((n) => [n, velocityOf(n)]));
      let lastX = null;
      const paint = (e) => {
         const rect = velBars.getBoundingClientRect();
         const x = e.clientX - rect.left;
         const value = Math.max(1, Math.min(127, Math.round(((rect.bottom - e.clientY) / (VEL_HEIGHT - VEL_PAD)) * 127)));
         const from = Math.min(lastX ?? x, x) - VEL_HIT;
         const to = Math.max(lastX ?? x, x) + VEL_HIT;
         lastX = x;
         let hit = false;
         for (const n of targets) {
            const at = n.start * PX;
            if (at < from || at > to) continue;
            n.velocity = value;
            hit = true;
         }
         if (!hit) return;
         lastVelocity = value;
         velLabel.textContent = String(value);
         renderNotes();
      };
      paint(down);
      dragging = true;
      vel.setPointerCapture(down.pointerId);
      const end = () => {
         vel.removeEventListener('pointermove', paint);
         vel.removeEventListener('pointerup', end);
         vel.removeEventListener('pointercancel', end);
         dragging = false;
         velLabel.textContent = 'ベロシティ';
         if (targets.some((n) => velocityOf(n) !== before.get(n))) commit();
      };
      vel.addEventListener('pointermove', paint);
      vel.addEventListener('pointerup', end);
      vel.addEventListener('pointercancel', end);
   }

   // ---- コピー・貼り付け ----

   function copy() {
      const list = [...selected];
      if (!list.length) return;
      const from = Math.min(...list.map((n) => n.start));
      clipboard = normalizeNotes(list).map((n) => ({ ...n, start: n.start - from }));
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

   // Ctrl+ドラッグで、囲んだ範囲に掛かるノートを選ぶ。Shift も押していれば、いまの選択に足す。
   // 囲んでいる間にホイールでスクロールしても、範囲はグリッドの上の位置で追う
   function marquee(down) {
      down.preventDefault();
      const base = down.shiftKey ? new Set(selected) : new Set();
      const from = pointAt(down);
      const box = h('div', { class: 'pr-marquee' });
      grid.append(box);
      let last = down;
      const update = () => {
         const to = pointAt(last);
         const left = Math.min(from.x, to.x);
         const right = Math.max(from.x, to.x);
         const top = Math.min(from.y, to.y);
         const bottom = Math.max(from.y, to.y);
         Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
         // 行の上端・下端の位置で比べる(描いているノートの見た目の範囲と揃える)
         const hit = (n) => {
            const x = n.start * PX;
            const y = (127 - n.pitch) * ROW;
            return x < right && x + Math.max(3, n.length * PX) > left && y < bottom && y + ROW > top;
         };
         selected = new Set([...base, ...notes.filter(hit)]);
         renderNotes();
      };
      update();
      dragging = true;
      grid.setPointerCapture(down.pointerId);
      const move = (e) => {
         last = e;
         update();
      };
      const end = () => {
         grid.removeEventListener('pointermove', move);
         grid.removeEventListener('pointerup', end);
         grid.removeEventListener('pointercancel', end);
         scroller.removeEventListener('scroll', update);
         box.remove();
         dragging = false;
      };
      grid.addEventListener('pointermove', move);
      grid.addEventListener('pointerup', end);
      grid.addEventListener('pointercancel', end);
      scroller.addEventListener('scroll', update);
   }

   // 並びを整えて保存する。選択はノートごとに引き継ぐ(中身で引き継ぐと、まったく同じ場所に重なったノートまで選ばれる)
   function commit() {
      // normalizeNotes と同じ並べ方(sort は安定なので、同じ位置のノートの順も変わらない)
      const pairs = notes
         .map((n) => ({ note: normalizeNotes([n])[0], isSelected: selected.has(n) }))
         .sort((a, b) => a.note.start - b.note.start || a.note.pitch - b.note.pitch);
      notes = pairs.map((p) => p.note);
      selected = new Set(pairs.filter((p) => p.isSelected).map((p) => p.note));
      renderNotes();
      save();
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
      } else if (e.key.toLowerCase() === 'v' && (e.ctrlKey || e.metaKey) && clipboard.length) {
         e.preventDefault();
         paste();
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
         const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey || e.ctrlKey || e.metaKey ? 12 : 1);
         if (list.some((n) => n.pitch + step < 0 || n.pitch + step > 127)) return;
         for (const n of list) n.pitch += step;
         if (list.length === 1) preview(list[0].pitch, velocityOf(list[0]));
         commit();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && list.length) {
         // 左右でグリッド1つ分(Shift か Ctrl で1小節)動かす
         e.preventDefault();
         const step = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey || e.ctrlKey || e.metaKey ? TICKS_PER_BAR : snap);
         const range = shiftRange(list);
         if (step < range.min || step > range.max) return;
         for (const n of list) n.start += step;
         commit();
      }
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
      if (!clipId) {
         onion = false;
         onionOff = new Set();
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
         scroller.scrollTop = (127 - center) * ROW - scroller.clientHeight / 2;
         scroller.scrollLeft = 0;
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
