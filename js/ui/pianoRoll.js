// ピアノロール。アレンジ画面の下に出すパネルで、選んだクリップ1つのノートを編集する。
// 操作は FL Studio に寄せている:空いているところを押すとノートを置き(そのままドラッグで動かせる)、
// ノートを掴むと移動、右端を掴むと長さを変える。右クリックで消す(押したままなぞると続けて消す)。
// ノートを置く長さは、最後に触ったノートの長さ。
//
// 編集は手元の notes に反映してから、操作の区切り(ポインタを離したとき)ごとにクリップのノートを丸ごと保存する。
// 表示の単位は px、ノートの単位は tick(midi.js)。

import * as actions from '../actions.js';
import {
   BEATS_PER_BAR, clipTicks, isBlackKey, normalizeNotes, pitchName, PPQ, setupMessages, TICKS_PER_BAR, trackChannels,
} from '../domain/midi.js';
import { sortByOrder } from '../domain/order.js';
import { UNTITLED_CLIP } from '../domain/arrangement.js';
import { barRange } from './clipDrawer.js';
import { h, icon } from './components/dom.js';
import { reportError } from './components/toast.js';
import { clipMidi, downloadMidi, setMidiDrag } from './midiExport.js';
import { previewNote } from './midiOut.js';

const ROW = 12; // 1音の高さ(px)
const BEAT = 64; // 1拍の幅(px)
const PX = BEAT / PPQ; // 1 tick の幅(px)
const EDGE = 6; // ノートの右端の、掴むと長さを変えられる幅(px)
const DRAG_THRESHOLD = 3;
const SNAPS = [
   { value: String(PPQ), label: '1/4' },
   { value: String(PPQ / 2), label: '1/8' },
   { value: String(PPQ / 4), label: '1/16' },
   { value: String(PPQ / 8), label: '1/32' },
   { value: String(PPQ / 3), label: '1/8 3連' },
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
const sameNotes = (a, b) => JSON.stringify(normalizeNotes(a)) === JSON.stringify(normalizeNotes(b));

/**
 * @param {object} options
 * @param {string} options.projectId
 * @param {(clipId: string|null) => void} [options.onSelectionChange] 開いているクリップが変わったとき
 * @param {(clip: object) => void} [options.onPlayClip] 「このクリップから再生」
 * @param {(clipId: string) => void} [options.onOpenDetail] クリップ詳細を開く
 */
export function createPianoRoll({ projectId, onSelectionChange, onPlayClip, onOpenDetail }) {
   let data = null; // アレンジ画面が読み込んだもの(project / tracks / clips)
   let clipId = null;
   let notes = []; // 編集中のノート(クリップの先頭からの相対)
   let selected = new Set(); // notes の要素
   let lastLength = PPQ;
   let snap = loadSnap();
   let dragging = false;
   let pending = 0; // 保存を待っている数。その間は、読み直した(古いかもしれない)ノートで上書きしない

   const title = h('span', { class: 'pr-title' });
   const range = h('span', { class: 'pr-range muted' });
   const snapSelect = h('select', {
      class: 'select pr-snap',
      'aria-label': 'グリッド',
      title: 'グリッド(ノートを置く・動かすときに合わせる細かさ。Alt を押しながらだと合わせない)',
      onchange: () => {
         snap = Number(snapSelect.value);
         try {
            localStorage.setItem(SNAP_KEY, snapSelect.value);
         } catch {
            // 覚えられなくても、この画面の間は効く
         }
      },
   }, SNAPS.map((s) => h('option', { value: s.value, selected: Number(s.value) === snap }, s.label)));
   const dragHandle = h('div', {
      class: 'pr-drag',
      draggable: 'true',
      title: 'ドラッグして FL Studio などへ落とすと、.mid として渡せます',
      ondragstart: (e) => setMidiDrag(e.dataTransfer, currentMidi()),
   }, icon('file-music', 14), 'ドラッグで .mid');
   const keys = h('div', { class: 'pr-keys' });
   const ruler = h('div', { class: 'pr-ruler' });
   const rows = h('div', { class: 'pr-rows', 'aria-hidden': 'true' });
   const layer = h('div', { class: 'pr-notes' });
   const playhead = h('div', { class: 'pr-playhead', hidden: true });
   const grid = h('div', {
      class: 'pr-grid',
      onpointerdown: (e) => onGridDown(e),
      oncontextmenu: (e) => e.preventDefault(),
   }, rows, layer, playhead);
   const inner = h('div', { class: 'pr-inner' }, h('div', { class: 'pr-corner' }), ruler, keys, grid);
   const scroller = h('div', { class: 'pr-scroll', tabIndex: -1, onkeydown: (e) => onKeydown(e) }, inner);

   const el = h('section', { class: 'pr', 'aria-label': 'ピアノロール', hidden: true },
      h('header', { class: 'pr-head' },
         icon('piano', 16),
         title,
         range,
         h('label', { class: 'pr-snap-label muted' }, 'グリッド', snapSelect),
         h('span', { class: 'pr-spacer' }),
         h('button', {
            type: 'button', class: 'btn btn-icon', title: 'このクリップの頭から再生', 'aria-label': 'このクリップの頭から再生',
            onclick: () => { const c = clip(); if (c) onPlayClip?.(c); },
         }, icon('play')),
         dragHandle,
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

   // 鍵盤とグリッドの行は、上が高い音(127)。128音ぶんを一度だけ作る
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
      rows.append(h('div', { class: `pr-row${black ? ' is-black' : ''}${isC ? ' is-c' : ''}` }));
   }

   const clip = () => data?.clips.find((c) => c.id === clipId) ?? null;
   const track = () => data?.tracks.find((t) => t.id === clip()?.trackId) ?? null;

   function currentMidi() {
      return clipMidi(data.project, track(), { ...clip(), notes });
   }

   function preview(pitch) {
      const t = track();
      if (!t) return;
      const channel = trackChannels(sortByOrder(data.tracks)).get(t.id);
      previewNote(setupMessages(t, channel), channel, pitch);
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
      ruler.replaceChildren(...Array.from({ length: c.bars * BEATS_PER_BAR }, (_, i) => h('span', {
         class: `pr-beat${i % BEATS_PER_BAR === 0 ? ' is-bar' : ''}`,
      }, i % BEATS_PER_BAR === 0 ? String(c.startBar + i / BEATS_PER_BAR) : '')));
   }

   function renderNotes() {
      const end = clipTicks(clip());
      layer.replaceChildren(...notes.map((n, i) => h('div', {
         class: `pr-note${selected.has(n) ? ' is-selected' : ''}${n.start < 0 || n.start >= end ? ' is-outside' : ''}`,
         style: {
            left: `${n.start * PX}px`,
            top: `${(127 - n.pitch) * ROW}px`,
            width: `${Math.max(3, n.length * PX)}px`,
         },
         dataset: { index: String(i) },
         title: `${pitchName(n.pitch)}`,
      })));
   }

   // ---- 編集 ----

   const snapFloor = (tick, free) => (free ? Math.round(tick) : Math.floor(tick / snap) * snap);
   const snapRound = (tick, free) => (free ? Math.round(tick) : Math.round(tick / snap) * snap);

   function pointAt(e) {
      const rect = grid.getBoundingClientRect();
      return {
         tick: (e.clientX - rect.left) / PX,
         pitch: Math.max(0, Math.min(127, 127 - Math.floor((e.clientY - rect.top) / ROW))),
         x: e.clientX - rect.left,
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
      } else {
         target = { pitch: at.pitch, start: Math.max(0, snapFloor(at.tick, down.altKey)), length: lastLength, velocity: 100 };
         notes.push(target);
         selected = new Set([target]);
         created = true;
      }
      if (!selected.has(target)) {
         // Shift で選択を外したノートは動かさない
         renderNotes();
         return;
      }
      preview(target.pitch);
      renderNotes();

      const moving = [...selected].map((n) => ({ note: n, start: n.start, pitch: n.pitch, length: n.length }));
      const origin = moving.find((m) => m.note === target);
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
            const delta = Math.max(Math.min(snap, origin.length), end - origin.start) - origin.length;
            for (const m of moving) m.note.length = Math.max(1, m.length + delta);
            lastLength = target.length;
         } else {
            const start = snapRound(origin.start + deltaTick, e.altKey);
            const lowest = Math.min(...moving.map((m) => m.pitch));
            const highest = Math.max(...moving.map((m) => m.pitch));
            const pitchDelta = Math.max(-lowest, Math.min(127 - highest, p.pitch - at.pitch));
            for (const m of moving) {
               m.note.start = m.start + (start - origin.start);
               m.note.pitch = m.pitch + pitchDelta;
            }
            if (target.pitch !== lastPitch) {
               lastPitch = target.pitch;
               preview(target.pitch);
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

   // 並びを整えて保存する。選択はノートの中身で引き継ぐ
   function commit() {
      const keys = new Set([...selected].map(noteKey));
      notes = normalizeNotes(notes);
      selected = new Set(notes.filter((n) => keys.has(noteKey(n))));
      renderNotes();
      save();
   }

   function onKeydown(e) {
      if (dragging) return;
      const list = [...selected];
      if ((e.key === 'Delete' || e.key === 'Backspace') && list.length) {
         e.preventDefault();
         notes = notes.filter((n) => !selected.has(n));
         selected = new Set();
         commit();
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
         // 上下で半音(Shift で1オクターブ)動かす
         e.preventDefault();
         const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
         if (list.some((n) => n.pitch + step < 0 || n.pitch + step > 127)) return;
         for (const n of list) n.pitch += step;
         if (list.length === 1) preview(list[0].pitch);
         commit();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && list.length) {
         // 左右でグリッド1つ分動かす
         e.preventDefault();
         const step = (e.key === 'ArrowRight' ? 1 : -1) * snap;
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
      clipId = id;
      if (opening) {
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
      /** アレンジ画面が読み直すたびに呼ぶ。 */
      update(next) {
         data = next;
         if (clipId) sync();
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
